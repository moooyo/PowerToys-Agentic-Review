import type { BigIntStats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

export interface CodexProviderProfile {
  readonly configurationOverrides: readonly string[];
  readonly providerEnvironment: Readonly<Record<string, string>>;
}

type ConfigurationValue =
  | string
  | number
  | boolean
  | readonly ConfigurationValue[]
  | { readonly [key: string]: ConfigurationValue };

const maximumConfigBytes = 64 * 1024;
const maximumHeaderCount = 64;
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

/** Reads only provider settings; execution policy always comes from trusted CLI overrides. */
export async function loadCodexProviderProfile(
  profileDirectory: string,
): Promise<CodexProviderProfile> {
  const content = await readBoundedConfiguration(join(profileDirectory, "config.toml"));
  if (content === null) return emptyProfile();
  let configuration: Record<string, unknown>;
  try {
    configuration = parse(content, { maxDepth: 32 }) as Record<string, unknown>;
  } catch {
    throw new Error("Codex provider config.toml is not valid TOML.");
  }

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
        );
        overrides.push(`model_providers=${serialize({ [name]: provider })}`);
      }
    }
  }
  return Object.freeze({
    configurationOverrides: Object.freeze(overrides),
    providerEnvironment: Object.freeze(providerEnvironment),
  });
}

function copyProvider(
  source: Record<string, unknown>,
  environment: Record<string, string>,
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
    const headers = tableValue(source.http_headers, "model_providers.selected.http_headers");
    const entries = Object.entries(headers);
    if (entries.length > maximumHeaderCount)
      throw invalidField("model_providers.selected.http_headers");
    const seen = new Set<string>();
    const mappedHeaders: Record<string, string> = Object.create(null);
    for (const [header, rawValue] of entries) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header) || seen.has(header.toLowerCase())) {
        throw invalidField("model_providers.selected.http_headers");
      }
      seen.add(header.toLowerCase());
      const value = stringValue(rawValue, "model_providers.selected.http_headers", true);
      const environmentName = `CODEX_PROVIDER_HEADER_${Object.keys(environment).length}`;
      mappedHeaders[header] = environmentName;
      environment[environmentName] = value;
    }
    destination.env_http_headers = mappedHeaders;
  }
  return destination;
}

async function readBoundedConfiguration(configPath: string): Promise<string | null> {
  let initial: BigIntStats;
  try {
    initial = await lstat(configPath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw new Error("Codex provider config.toml could not be inspected.");
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > BigInt(maximumConfigBytes)) {
    throw new Error("Codex provider config.toml must be a regular file of at most 65536 bytes.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(configPath, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino) {
      throw new Error();
    }
    const buffer = Buffer.alloc(maximumConfigBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset > maximumConfigBytes ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(offset) !== after.size
    ) {
      throw new Error();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    throw new Error("Codex provider config.toml could not be read safely.");
  } finally {
    await handle?.close();
  }
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
  });
}
