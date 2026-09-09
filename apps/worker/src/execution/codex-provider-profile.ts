import type { BigIntStats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { redactExecutionText } from "@agentic-review/codex";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse } from "smol-toml";
import type { ModelRelayAuthorization } from "./model-response-relay.js";

export interface CodexProviderProfile {
  readonly configurationOverrides: readonly string[];
  readonly providerEnvironment: Readonly<Record<string, string>>;
  readonly protectedValues: readonly string[];
}

export type CodexRelayProviderUnsupportedReason =
  | "PROFILE_MISSING"
  | "PROVIDER_NOT_SELECTED"
  | "PROVIDER_NOT_CONFIGURED"
  | "AUTHENTICATION_UNSUPPORTED"
  | "DYNAMIC_HEADERS_UNSUPPORTED"
  | "ENDPOINT_UNSUPPORTED"
  | "PROTOCOL_UNSUPPORTED"
  | "PROVIDER_OPTION_UNSUPPORTED"
  | "PROTECTED_DECLARATION";

export interface CodexRelayProviderDeclaration {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly model: string | null;
  readonly modelReasoningEffort: string | null;
  readonly modelContextWindow: number | null;
  readonly modelAutoCompactTokenLimit: number | null;
  readonly provider: {
    readonly name: string | null;
    readonly wireApi: "responses" | null;
    readonly supportsWebsockets: boolean | null;
    readonly requiresOpenaiAuth: false | null;
    readonly requestMaxRetries: number | null;
    readonly streamMaxRetries: number | null;
    readonly streamIdleTimeoutMs: number | null;
  };
}

export type CodexRelayProviderProfile =
  | {
      readonly state: "unsupported";
      readonly reason: CodexRelayProviderUnsupportedReason;
      readonly effectivePolicy: "unverified";
    }
  | {
      readonly state: "supported";
      /** Requested configuration only; this is not a measured effective CLI launch policy. */
      readonly declared: CodexRelayProviderDeclaration;
      readonly effectivePolicy: "unverified";
      /** Parent-process use only. No upstream header values are included in public profile data. */
      readonly authorize: (signal: AbortSignal) => Promise<ModelRelayAuthorization>;
      /** Parent-process output protection only; returns the same frozen authorization snapshot. */
      readonly getProtectedValues: () => readonly string[];
    };

type ConfigurationValue =
  | string
  | number
  | boolean
  | readonly ConfigurationValue[]
  | { readonly [key: string]: ConfigurationValue };

const maximumConfigBytes = 64 * 1024;
const maximumHeaderCount = 64;
const metadataPolicyFile = "provider-metadata-policy.json";
const maximumMetadataPolicyBytes = 64 * 1024;
const headerPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const metadataPolicySchema = Type.Object(
  {
    schemaVersion: Type.Literal("CodexProviderMetadataPolicyV1"),
    publicHeaders: Type.Array(
      Type.Object(
        {
          providerId: Type.String({ minLength: 1, maxLength: 128 }),
          endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
          header: Type.String({ minLength: 1, maxLength: 128 }),
          value: Type.String({ minLength: 1, maxLength: 1024 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: maximumHeaderCount },
    ),
  },
  { additionalProperties: false },
);
interface PublicProviderHeader {
  readonly providerId: string;
  readonly endpoint: string;
  readonly header: string;
  readonly value: string;
}
const authenticationHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "authentication-info",
  "proxy-authentication-info",
  "www-authenticate",
  "proxy-authenticate",
  "api-key",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
]);
const rootStringKeys = [
  "model",
  "model_provider",
  "model_reasoning_effort",
  "cli_auth_credentials_store",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
] as const;
const rootIntegerKeys = ["model_context_window", "model_auto_compact_token_limit"] as const;
const providerStringKeys = ["name", "base_url", "wire_api"] as const;
const providerBooleanKeys = ["supports_websockets", "requires_openai_auth"] as const;
const providerIntegerKeys = [
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
] as const;
const inlineCredentialKey = /(?:api[_-]?key|token|bearer|password|secret|cookie|authorization)/iu;
const inlineCredentialArgument =
  /(?:^|\s)(?:--?)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|authorization)(?:\s|=|:|$)|\bBearer\s+|\bsk-[A-Za-z0-9_-]{16,}/iu;
// Relay authorization always protects these headers, including names outside the legacy policy.
const relayAuthenticationHeader =
  /(?:authorization|authentication|api[_-]?key|token|bearer|password|secret|cookie|credential)/iu;

/** Reads only provider settings; execution policy always comes from trusted CLI overrides. */
export async function loadCodexProviderProfile(
  profileDirectory: string,
): Promise<CodexProviderProfile> {
  const content = await readBoundedConfiguration(join(profileDirectory, "config.toml"));
  if (content === null) return emptyProfile();
  const publicHeaders = await readMetadataPolicy(profileDirectory);
  const configuration = parseProviderConfiguration(content);

  const overrides: string[] = [];
  for (const key of rootStringKeys) {
    if (configuration[key] === undefined) continue;
    overrides.push(`${key}=${serialize(stringValue(configuration[key], key))}`);
  }
  for (const key of rootIntegerKeys) {
    if (configuration[key] === undefined) continue;
    overrides.push(`${key}=${integerValue(configuration[key], key, 1)}`);
  }
  const providerEnvironment: Record<string, string> = {};
  const protectedValues = new Set<string>();
  const selectedProvider = configuration.model_provider;
  if (selectedProvider !== undefined) {
    const name = stringValue(selectedProvider, "model_provider");
    const providers = configuration.model_providers;
    if (providers !== undefined) {
      const providerMap = tableValue(providers, "model_providers");
      const selected = Object.hasOwn(providerMap, name) ? providerMap[name] : undefined;
      if (selected !== undefined) {
        const provider = copyProvider(
          tableValue(selected, "model_providers.selected"),
          providerEnvironment,
          protectedValues,
          publicHeaders,
          name,
        );
        overrides.push(`model_providers=${serialize({ [name]: provider })}`);
      }
    }
  }
  return Object.freeze({
    configurationOverrides: Object.freeze(overrides),
    providerEnvironment: Object.freeze(providerEnvironment),
    protectedValues: Object.freeze([...protectedValues]),
  });
}

function parseProviderConfiguration(content: string): Record<string, unknown> {
  try {
    return parse(content, { maxDepth: 32 }) as Record<string, unknown>;
  } catch {
    throw new Error("Codex provider config.toml is not valid TOML.");
  }
}

function unsupportedRelayProvider(
  reason: CodexRelayProviderUnsupportedReason,
): CodexRelayProviderProfile {
  return Object.freeze({ state: "unsupported", reason, effectivePolicy: "unverified" });
}

/** Resolves static upstream authorization without exposing credentials to a CLI environment. */
export async function loadCodexRelayProviderProfile(
  profileDirectory: string,
): Promise<CodexRelayProviderProfile> {
  const content = await readBoundedConfiguration(join(profileDirectory, "config.toml"));
  if (content === null) return unsupportedRelayProvider("PROFILE_MISSING");
  const configuration = parseProviderConfiguration(content);
  if (configuration.model_provider === undefined)
    return unsupportedRelayProvider("PROVIDER_NOT_SELECTED");
  const providerId = stringValue(configuration.model_provider, "model_provider");
  if (configuration.model_providers === undefined)
    return unsupportedRelayProvider("PROVIDER_NOT_CONFIGURED");
  const providers = tableValue(configuration.model_providers, "model_providers");
  if (!Object.hasOwn(providers, providerId))
    return unsupportedRelayProvider("PROVIDER_NOT_CONFIGURED");
  const source = tableValue(providers[providerId], "model_providers.selected");
  if (
    configuration.forced_login_method !== undefined ||
    configuration.forced_chatgpt_workspace_id !== undefined ||
    source.auth !== undefined ||
    source.requires_openai_auth === true ||
    source.aws !== undefined ||
    source.env_key !== undefined ||
    Object.keys(source).some(
      (key) =>
        key !== "http_headers" && key !== "env_http_headers" && inlineCredentialKey.test(key),
    )
  )
    return unsupportedRelayProvider("AUTHENTICATION_UNSUPPORTED");
  if (source.env_http_headers !== undefined)
    return unsupportedRelayProvider("DYNAMIC_HEADERS_UNSUPPORTED");
  const knownFields = new Set<string>([
    ...providerStringKeys,
    ...providerBooleanKeys,
    ...providerIntegerKeys,
    "http_headers",
  ]);
  if (Object.keys(source).some((key) => !knownFields.has(key)))
    return unsupportedRelayProvider("PROVIDER_OPTION_UNSUPPORTED");
  if (
    source.wire_api !== undefined &&
    stringValue(source.wire_api, "model_providers.selected.wire_api") !== "responses"
  )
    return unsupportedRelayProvider("PROTOCOL_UNSUPPORTED");
  if (source.base_url === undefined) return unsupportedRelayProvider("ENDPOINT_UNSUPPORTED");
  const baseUrl = stringValue(source.base_url, "model_providers.selected.base_url");
  let endpoint: string;
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" ||
      url.href !== baseUrl ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return unsupportedRelayProvider("ENDPOINT_UNSUPPORTED");
    // Codex treats base_url as a provider base; retain its complete path when appending Responses.
    endpoint = `${baseUrl.replace(/\/$/u, "")}/responses`;
  } catch {
    return unsupportedRelayProvider("ENDPOINT_UNSUPPORTED");
  }
  for (const key of providerBooleanKeys)
    if (source[key] !== undefined && typeof source[key] !== "boolean")
      throw invalidField(`model_providers.selected.${key}`);
  const readString = (key: string) =>
    configuration[key] === undefined ? null : stringValue(configuration[key], key);
  const readInteger = (key: string) =>
    configuration[key] === undefined ? null : integerValue(configuration[key], key, 1);
  const providerInteger = (key: string) =>
    source[key] === undefined
      ? null
      : integerValue(source[key], `model_providers.selected.${key}`, 0);
  const declared: CodexRelayProviderDeclaration = Object.freeze({
    providerId,
    baseUrl,
    endpoint,
    model: readString("model"),
    modelReasoningEffort: readString("model_reasoning_effort"),
    modelContextWindow: readInteger("model_context_window"),
    modelAutoCompactTokenLimit: readInteger("model_auto_compact_token_limit"),
    provider: Object.freeze({
      name:
        source.name === undefined
          ? null
          : stringValue(source.name, "model_providers.selected.name"),
      wireApi: source.wire_api === undefined ? null : "responses",
      supportsWebsockets:
        source.supports_websockets === undefined ? null : (source.supports_websockets as boolean),
      requiresOpenaiAuth: source.requires_openai_auth === undefined ? null : false,
      requestMaxRetries: providerInteger("request_max_retries"),
      streamMaxRetries: providerInteger("stream_max_retries"),
      streamIdleTimeoutMs: providerInteger("stream_idle_timeout_ms"),
    }),
  });
  const publicHeaders = await readMetadataPolicy(profileDirectory);
  const copied = readStaticProviderHeaders(source.http_headers, publicHeaders, providerId, baseUrl);
  const privateHeaders = Object.freeze({ ...copied.headers });
  const protectedValues = new Set(copied.protectedValues);
  for (const [header, value] of Object.entries(privateHeaders)) {
    if (
      authenticationHeaders.has(header.toLowerCase()) ||
      relayAuthenticationHeader.test(header) ||
      redactExecutionText(value) !== value
    ) {
      if (value.length > 0) protectedValues.add(value);
      const trimmed = value.trim();
      if (trimmed.length > 0) protectedValues.add(trimmed);
      const credential = /^(?:Bearer|Basic)[ \t]+([^ \t]+)$/iu.exec(trimmed)?.[1];
      if (credential) protectedValues.add(credential);
    }
  }
  const protectedSnapshot = Object.freeze([...protectedValues].filter((value) => value.length > 0));
  const publicStrings = [
    providerId,
    baseUrl,
    endpoint,
    declared.model,
    declared.modelReasoningEffort,
    declared.provider.name,
  ];
  if (
    publicStrings.some(
      (value) =>
        value !== null &&
        (redactExecutionText(value) !== value ||
          protectedSnapshot.some((secret) => value.includes(secret))),
    )
  )
    return unsupportedRelayProvider("PROTECTED_DECLARATION");
  return Object.freeze({
    state: "supported",
    declared,
    effectivePolicy: "unverified",
    getProtectedValues: () => protectedSnapshot,
    authorize: async (signal: AbortSignal): Promise<ModelRelayAuthorization> => {
      if (signal.aborted) throw new Error("Codex relay provider authorization was cancelled.");
      return Object.freeze({
        headers: Object.freeze({ ...privateHeaders }),
        protectedValues: protectedSnapshot,
      });
    },
  });
}

function readStaticProviderHeaders(
  value: unknown,
  publicHeaders: readonly PublicProviderHeader[],
  providerId: string,
  endpoint: unknown,
): {
  headers: Readonly<Record<string, string>>;
  protectedValues: readonly string[];
} {
  if (value === undefined) return { headers: {}, protectedValues: [] };
  const entries = Object.entries(tableValue(value, "model_providers.selected.http_headers"));
  if (entries.length > maximumHeaderCount)
    throw invalidField("model_providers.selected.http_headers");
  const seen = new Set<string>();
  const headers: Record<string, string> = Object.create(null);
  const protectedValues = new Set<string>();
  for (const [header, rawValue] of entries) {
    if (!headerPattern.test(header) || seen.has(header.toLowerCase()))
      throw invalidField("model_providers.selected.http_headers");
    seen.add(header.toLowerCase());
    const text = stringValue(rawValue, "model_providers.selected.http_headers", true);
    headers[header] = text;
    const declaredPublic =
      typeof endpoint === "string" &&
      publicHeaders.some(
        (entry) =>
          entry.providerId === providerId &&
          entry.endpoint === endpoint &&
          entry.header === header.toLowerCase() &&
          entry.value === text,
      );
    if (!declaredPublic || redactExecutionText(text) !== text) protectedValues.add(text);
  }
  return { headers, protectedValues: [...protectedValues] };
}

function copyProvider(
  source: Record<string, unknown>,
  environment: Record<string, string>,
  protectedValues: Set<string>,
  publicHeaders: readonly PublicProviderHeader[],
  providerId: string,
): Record<string, ConfigurationValue> {
  const destination: Record<string, ConfigurationValue> = Object.create(null);
  for (const key of Object.keys(source)) {
    if (key === "env_key" || key === "env_http_headers" || inlineCredentialKey.test(key)) {
      throw invalidField(`model_providers.selected.${safeFieldName(key)}`);
    }
    if (key !== "http_headers")
      rejectNestedCredentials(source[key], `model_providers.selected.${safeFieldName(key)}`);
  }
  for (const key of providerStringKeys) {
    if (source[key] === undefined) continue;
    const value = stringValue(source[key], `model_providers.selected.${key}`);
    if (key === "base_url") assertProviderUrl(value);
    destination[key] = value;
  }
  for (const key of providerBooleanKeys) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "boolean") throw invalidField(`model_providers.selected.${key}`);
    destination[key] = source[key];
  }
  for (const key of providerIntegerKeys) {
    if (source[key] === undefined) continue;
    destination[key] = integerValue(source[key], `model_providers.selected.${key}`, 0);
  }
  if (source.auth !== undefined) {
    const auth = tableValue(source.auth, "model_providers.selected.auth");
    for (const key of Object.keys(auth)) {
      if (key !== "command" && key !== "args") {
        throw invalidField(`model_providers.selected.auth.${safeFieldName(key)}`);
      }
    }
    const command = stringValue(auth.command, "model_providers.selected.auth.command");
    if (inlineCredentialArgument.test(command)) {
      throw invalidField("model_providers.selected.auth.command");
    }
    const copiedAuth: Record<string, ConfigurationValue> = { command };
    if (auth.args !== undefined) {
      if (!Array.isArray(auth.args) || auth.args.length > 64) {
        throw invalidField("model_providers.selected.auth.args");
      }
      const args = auth.args.map((value: unknown) =>
        stringValue(value, "model_providers.selected.auth.args", true),
      );
      if (args.some((argument) => inlineCredentialArgument.test(argument))) {
        throw invalidField("model_providers.selected.auth.args");
      }
      copiedAuth.args = args;
    }
    destination.auth = copiedAuth;
  }
  if (source.http_headers !== undefined) {
    const copied = readStaticProviderHeaders(
      source.http_headers,
      publicHeaders,
      providerId,
      source.base_url,
    );
    const mappedHeaders: Record<string, string> = Object.create(null);
    for (const [header, value] of Object.entries(copied.headers)) {
      const environmentName = `CODEX_PROVIDER_HEADER_${Object.keys(environment).length}`;
      mappedHeaders[header] = environmentName;
      environment[environmentName] = value;
    }
    for (const value of copied.protectedValues) protectedValues.add(value);
    destination.env_http_headers = mappedHeaders;
  }
  return destination;
}

async function readMetadataPolicy(
  profileDirectory: string,
): Promise<readonly PublicProviderHeader[]> {
  const content = await readBoundedConfiguration(
    join(profileDirectory, metadataPolicyFile),
    metadataPolicyFile,
    maximumMetadataPolicyBytes,
  );
  if (content === null) return [];
  try {
    const policy: unknown = new MetadataPolicyJsonParser(content).parse();
    if (!Value.Check(metadataPolicySchema, policy)) throw new Error();
    const scopes = new Set<string>();
    return Object.freeze(
      policy.publicHeaders.map((entry) => {
        if (
          Object.values(entry).some(
            (value) => !value.isWellFormed() || value.trim() !== value || /[\r\n\0]/u.test(value),
          ) ||
          Buffer.byteLength(entry.providerId, "utf8") > 512 ||
          Buffer.byteLength(entry.endpoint, "utf8") > 8192 ||
          Buffer.byteLength(entry.header, "utf8") > 128 ||
          entry.value.length > 1024 ||
          Buffer.byteLength(entry.value, "utf8") > 4096 ||
          !headerPattern.test(entry.header) ||
          authenticationHeaders.has(entry.header.toLowerCase()) ||
          inlineCredentialKey.test(entry.header)
        )
          throw new Error();
        assertProviderUrl(entry.endpoint);
        const header = entry.header.toLowerCase();
        const scope = JSON.stringify([entry.providerId, entry.endpoint, header]);
        if (scopes.has(scope)) throw new Error();
        scopes.add(scope);
        return Object.freeze({ ...entry, header });
      }),
    );
  } catch {
    throw new Error("Codex provider provider-metadata-policy.json is unsupported or invalid.");
  }
}

/** The policy grammar needs only strings, arrays and objects; duplicate decoded keys are invalid. */
class MetadataPolicyJsonParser {
  #position = 0;
  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#position !== this.text.length) throw new Error();
    return value;
  }

  #value(depth: number): unknown {
    if (depth > 4) throw new Error();
    this.#whitespace();
    if (this.text[this.#position] === '"') return this.#string();
    if (this.#take("{")) {
      const object: Record<string, unknown> = Object.create(null);
      this.#whitespace();
      if (this.#take("}")) return object;
      for (;;) {
        this.#whitespace();
        const key = this.#string();
        if (Object.hasOwn(object, key)) throw new Error();
        this.#whitespace();
        if (!this.#take(":")) throw new Error();
        object[key] = this.#value(depth + 1);
        this.#whitespace();
        if (this.#take("}")) return object;
        if (!this.#take(",")) throw new Error();
      }
    }
    if (this.#take("[")) {
      const array: unknown[] = [];
      this.#whitespace();
      if (this.#take("]")) return array;
      for (;;) {
        if (array.length >= maximumHeaderCount) throw new Error();
        array.push(this.#value(depth + 1));
        this.#whitespace();
        if (this.#take("]")) return array;
        if (!this.#take(",")) throw new Error();
      }
    }
    throw new Error();
  }

  #string(): string {
    const start = this.#position;
    if (!this.#take('"')) throw new Error();
    while (this.#position < this.text.length) {
      const character = this.text[this.#position++];
      if (character === "\\") this.#position += 1;
      else if (character === '"') {
        const value = JSON.parse(this.text.slice(start, this.#position)) as string;
        if (!value.isWellFormed()) throw new Error();
        return value;
      }
    }
    throw new Error();
  }

  #whitespace(): void {
    while (/[ \t\r\n]/u.test(this.text[this.#position] ?? "!")) this.#position += 1;
  }

  #take(character: string): boolean {
    if (this.text[this.#position] !== character) return false;
    this.#position += 1;
    return true;
  }
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedConfiguration(
  configPath: string,
  label: "config.toml" | "provider-metadata-policy.json" = "config.toml",
  maximumBytes = maximumConfigBytes,
): Promise<string | null> {
  let initial: BigIntStats;
  try {
    initial = await lstat(configPath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw new Error(`Codex provider ${label} could not be inspected.`);
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > BigInt(maximumBytes)) {
    throw new Error(
      `Codex provider ${label} must be a regular file of at most ${maximumBytes} bytes.`,
    );
  }
  let handle: FileHandle | undefined;
  let content: string | undefined;
  let failed = false;
  try {
    handle = await open(configPath, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileState(before, initial)) {
      throw new Error();
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(configPath, { bigint: true });
    if (
      offset > maximumBytes ||
      !sameFileState(before, after) ||
      !sameFileState(after, current) ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      BigInt(offset) !== after.size
    ) {
      throw new Error();
    }
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    failed = true;
  } finally {
    try {
      await handle?.close();
    } catch {
      failed = true;
    }
  }
  if (failed || content === undefined)
    throw new Error(`Codex provider ${label} could not be read safely.`);
  return content;
}

function tableValue(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    throw invalidField(field);
  }
  return value as Record<string, unknown>;
}

function rejectNestedCredentials(value: unknown, field: string): void {
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (inlineCredentialKey.test(key) || key === "env_key" || key === "env_http_headers") {
      throw invalidField(`${field}.${safeFieldName(key)}`);
    }
    rejectNestedCredentials(child, `${field}.${safeFieldName(key)}`);
  }
}

function stringValue(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > 16_384 ||
    !value.isWellFormed() ||
    /[\r\n\0]/u.test(value)
  ) {
    throw invalidField(field);
  }
  return value;
}

function integerValue(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw invalidField(field);
  }
  return value;
}

function assertProviderUrl(value: string): void {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      [...url.searchParams.keys()].some((key) => inlineCredentialKey.test(key))
    ) {
      throw new Error();
    }
  } catch {
    throw invalidField("model_providers.selected.base_url");
  }
}

function serialize(value: ConfigurationValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => `${JSON.stringify(key)}=${serialize(item)}`)
    .join(",")}}`;
}

function safeFieldName(value: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : "unsupported";
}

function invalidField(field: string): Error {
  return new Error(`Codex provider configuration field ${field} is unsupported or invalid.`);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function emptyProfile(): CodexProviderProfile {
  return Object.freeze({
    configurationOverrides: Object.freeze([]),
    providerEnvironment: Object.freeze({}),
    protectedValues: Object.freeze([]),
  });
}
