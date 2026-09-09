import { isIP } from "node:net";
import { win32 } from "node:path";
import { types } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import type { CodexAppServerTransport } from "./codex-app-server-transport.js";

type JsonObject = Record<string, unknown>;
export type CodexAppServerSessionPurpose = "review" | "summary_read_only";
export interface CodexAppServerModelParameters {
  readonly modelReasoningEffort?: string | null;
  readonly modelContextWindow?: number | null;
  readonly modelAutoCompactTokenLimit?: number | null;
}
export interface CodexAppServerSessionConfigurationInput extends CodexAppServerModelParameters {
  readonly purpose: CodexAppServerSessionPurpose;
  readonly requestedModel: string;
  readonly relayUrl: string;
  readonly codexHomeDirectory: string;
  readonly checkoutDirectory: string;
  readonly controlDirectory: string;
  readonly tempDirectory: string;
  readonly userProfileDirectory: string;
  readonly shellEnvironment: Readonly<Record<string, string>>;
  readonly commandNetworkDomains?: readonly string[];
}
export interface CodexAppServerSessionExpected extends CodexAppServerSessionConfigurationInput {
  readonly cliVersion: "0.145.0";
  readonly providerId: "agentic_review_parent_relay";
  readonly permissionProfile: "agentic_review_review" | "agentic_review_summary_read_only";
  readonly commandNetworkDomains: readonly string[];
  readonly modelReasoningEffort: string | null;
  readonly modelContextWindow: number | null;
  readonly modelAutoCompactTokenLimit: number | null;
}
export interface CodexAppServerSessionObservation {
  readonly schemaVersion: "CodexAppServerSessionObservationV1";
  readonly measurementKind: "app_server_configuration_projection_v1";
  readonly cliVersion: string;
  readonly threadId: string;
  readonly readiness: "ready" | "notConfigured" | "updateRequired";
  readonly launchPolicySha256: string;
  readonly rawObservationSha256: string;
  readonly projection: Readonly<JsonObject>;
  readonly executionAccepted: false;
}
export interface CodexAppServerSession {
  readonly threadId: string;
  readonly launchPolicySha256: string;
  readonly observation: CodexAppServerSessionObservation;
}
export type CodexAppServerSessionPolicyErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_OBSERVATION"
  | "POLICY_MISMATCH"
  | "SANDBOX_NOT_READY"
  | "TRANSPORT_FAILED";
export class CodexAppServerSessionPolicyError extends Error {
  constructor(
    readonly code: CodexAppServerSessionPolicyErrorCode,
    readonly observation?: CodexAppServerSessionObservation,
  ) {
    super("The Codex app-server session policy could not be verified.");
    this.name = "CodexAppServerSessionPolicyError";
  }
}

const providerId = "agentic_review_parent_relay";
const cliVersion = "0.145.0";
const clientName = "agentic_review_worker";
const maximumObservationBytes = 4 * 1024 * 1024;
const knownExpected = new WeakSet<object>();
const openedTransports = new WeakSet<object>();
const shellNames = ["COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"];
const disabledFeatures = [
  "shell_snapshot",
  "apps",
  "hooks",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "enable_mcp_apps",
  "image_generation",
  "skill_search",
  "workspace_dependencies",
  "code_mode_host",
  "enable_request_compression",
  "remote_compaction_v2",
  "tool_suggest",
  "plugin_sharing",
  "tool_call_mcp_elicitation",
  "auth_elicitation",
  "goals",
  "remote_control",
] as const;

function fail(code: CodexAppServerSessionPolicyErrorCode): never {
  throw new CodexAppServerSessionPolicyError(code);
}
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_OBSERVATION");
  return value as JsonObject;
}
function same(actual: unknown, expected: unknown): void {
  try {
    if (createCanonicalResult(actual).json !== createCanonicalResult(expected).json)
      fail("POLICY_MISMATCH");
  } catch {
    fail("POLICY_MISMATCH");
  }
}
/** Copies only bounded JSON data, without invoking getters or retaining mutable RPC objects. */
function snapshot(value: unknown, errorCode: CodexAppServerSessionPolicyErrorCode): unknown {
  let nodes = 0;
  let stringBytes = 0;
  const active = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 48) fail(errorCode);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string" && item.isWellFormed()) {
      stringBytes += Buffer.byteLength(item);
      if (stringBytes > maximumObservationBytes) fail(errorCode);
      return item;
    }
    if (item === null || typeof item !== "object" || types.isProxy(item) || active.has(item))
      fail(errorCode);
    const array = Array.isArray(item);
    if (
      array
        ? Object.getPrototypeOf(item) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      fail(errorCode);
    const keys = Reflect.ownKeys(item).filter((key) => !array || key !== "length");
    if (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index))))
      fail(errorCode);
    active.add(item);
    const result: JsonObject | unknown[] = array ? [] : Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        typeof key !== "string" ||
        !key.isWellFormed() ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      )
        fail(errorCode);
      stringBytes += Buffer.byteLength(key);
      if (stringBytes > maximumObservationBytes) fail(errorCode);
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    active.delete(item);
    return Object.freeze(result);
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(createCanonicalResult(result).json) > maximumObservationBytes)
    fail(errorCode);
  return result;
}
function text(value: unknown, maximum = 4096): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    !value ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    Buffer.byteLength(value) > maximum
  )
    fail("INVALID_CONFIGURATION");
  return value;
}
function directory(value: unknown): string {
  const path = text(value);
  if (!/^[A-Za-z]:[\\/]/u.test(path) || /[<>"|?*]/u.test(path) || path.slice(2).includes(":"))
    fail("INVALID_CONFIGURATION");
  const normalized = win32.normalize(path).replace(/[\\/]$/u, "");
  if (normalized.length <= 3 || normalized.split("\\").some((part) => /[. ]$/u.test(part)))
    fail("INVALID_CONFIGURATION");
  return normalized;
}
function contains(parent: string, child: string): boolean {
  const relative = win32.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..\\") && relative !== ".." && !win32.isAbsolute(relative))
  );
}
function inlineToml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(",")}]`;
  return `{${Object.entries(object(value))
    .map(([key, item]) => `${JSON.stringify(key)}=${inlineToml(item)}`)
    .join(",")}}`;
}

/** Preserves supported provider declarations; null leaves the CLI's model default unspecified. */
export function snapshotCodexAppServerModelParameters(
  input: CodexAppServerModelParameters,
): Required<CodexAppServerModelParameters> {
  const value = object(snapshot(input, "INVALID_CONFIGURATION"));
  if (
    Object.keys(value).some(
      (key) =>
        !["modelReasoningEffort", "modelContextWindow", "modelAutoCompactTokenLimit"].includes(key),
    )
  )
    fail("INVALID_CONFIGURATION");
  const effort = value.modelReasoningEffort ?? null;
  // Match the existing provider loader instead of inventing an effort enum or normalizing it.
  if (
    effort !== null &&
    (typeof effort !== "string" ||
      !effort.trim() ||
      effort.length > 16384 ||
      !effort.isWellFormed() ||
      effort.includes("\r") ||
      effort.includes("\n") ||
      effort.includes("\0"))
  )
    fail("INVALID_CONFIGURATION");
  const integer = (key: "modelContextWindow" | "modelAutoCompactTokenLimit"): number | null => {
    const selected = value[key] ?? null;
    if (
      selected !== null &&
      (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < 1)
    )
      fail("INVALID_CONFIGURATION");
    return selected as number | null;
  };
  return Object.freeze({
    modelReasoningEffort: effort as string | null,
    modelContextWindow: integer("modelContextWindow"),
    modelAutoCompactTokenLimit: integer("modelAutoCompactTokenLimit"),
  });
}

function policyConfiguration(expected: CodexAppServerSessionExpected): JsonObject {
  const review = expected.purpose === "review";
  const features = Object.fromEntries(disabledFeatures.map((name) => [name, false]));
  return {
    model: expected.requestedModel,
    ...(expected.modelReasoningEffort === null
      ? {}
      : { model_reasoning_effort: expected.modelReasoningEffort }),
    ...(expected.modelContextWindow === null
      ? {}
      : { model_context_window: expected.modelContextWindow }),
    ...(expected.modelAutoCompactTokenLimit === null
      ? {}
      : { model_auto_compact_token_limit: expected.modelAutoCompactTokenLimit }),
    model_provider: providerId,
    approval_policy: "never",
    default_permissions: expected.permissionProfile,
    web_search: "disabled",
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    allow_login_shell: false,
    check_for_update_on_startup: false,
    notify: [],
    history: { persistence: "none" },
    analytics: { enabled: false },
    mcp_servers: {},
    plugins: {},
    profiles: {},
    features: { ...features, network_proxy: true, shell_tool: true },
    windows: { sandbox: "elevated" },
    shell_environment_policy: {
      inherit: "none",
      ignore_default_excludes: false,
      set: expected.shellEnvironment,
      include_only: [],
      exclude: [],
      experimental_use_profile: false,
    },
    model_providers: {
      [providerId]: {
        name: "Agentic Review parent relay",
        base_url: expected.relayUrl,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: false,
        env_http_headers: { Authorization: "CODEX_PROVIDER_HEADER_0" },
        request_max_retries: 0,
        stream_max_retries: 0,
        stream_idle_timeout_ms: 300_000,
      },
    },
    permissions: {
      [expected.permissionProfile]: {
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": { ".": review ? "write" : "read" },
          [expected.tempDirectory]: review ? "write" : "read",
        },
        network: {
          enabled: true,
          proxy_url: "http://127.0.0.1:0",
          enable_socks5: false,
          enable_socks5_udp: false,
          allow_upstream_proxy: false,
          allow_local_binding: false,
          domains: Object.fromEntries(
            expected.commandNetworkDomains.map((name) => [name, "allow"]),
          ),
        },
      },
    },
  };
}

/** Requested settings only. The runner owns filesystem freshness, binary measurement, and gates. */
export function buildCodexAppServerSessionConfiguration(
  input: CodexAppServerSessionConfigurationInput,
): {
  readonly permissionProfile: CodexAppServerSessionExpected["permissionProfile"];
  readonly overrides: readonly string[];
  readonly expected: CodexAppServerSessionExpected;
} {
  try {
    const value = object(snapshot(input, "INVALID_CONFIGURATION"));
    const allowed = [
      "purpose",
      "requestedModel",
      "relayUrl",
      "codexHomeDirectory",
      "checkoutDirectory",
      "controlDirectory",
      "tempDirectory",
      "userProfileDirectory",
      "shellEnvironment",
      "commandNetworkDomains",
      "modelReasoningEffort",
      "modelContextWindow",
      "modelAutoCompactTokenLimit",
    ];
    if (
      Object.keys(value).some((key) => !allowed.includes(key)) ||
      (value.purpose !== "review" && value.purpose !== "summary_read_only")
    )
      fail("INVALID_CONFIGURATION");
    const requestedModel = text(value.requestedModel, 4096);
    const modelParameters = snapshotCodexAppServerModelParameters({
      modelReasoningEffort: (value.modelReasoningEffort as string | null) ?? null,
      modelContextWindow: (value.modelContextWindow as number | null) ?? null,
      modelAutoCompactTokenLimit: (value.modelAutoCompactTokenLimit as number | null) ?? null,
    });
    if (requestedModel.length > 1024) fail("INVALID_CONFIGURATION");
    const relayUrl = text(value.relayUrl);
    const parsed = new URL(relayUrl);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      !parsed.port ||
      parsed.port === "0" ||
      parsed.pathname !== "/v1" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password ||
      parsed.href !== relayUrl
    )
      fail("INVALID_CONFIGURATION");
    const paths = Object.fromEntries(
      [
        "codexHomeDirectory",
        "checkoutDirectory",
        "controlDirectory",
        "tempDirectory",
        "userProfileDirectory",
      ].map((key) => [key, directory(value[key])]),
    ) as Record<
      | "codexHomeDirectory"
      | "checkoutDirectory"
      | "controlDirectory"
      | "tempDirectory"
      | "userProfileDirectory",
      string
    >;
    if (new Set(Object.values(paths).map((path) => path.toLowerCase())).size !== 5)
      fail("INVALID_CONFIGURATION");
    for (const key of ["codexHomeDirectory", "controlDirectory", "tempDirectory"] as const) {
      if (
        contains(paths.checkoutDirectory, paths[key]) ||
        contains(paths[key], paths.checkoutDirectory)
      )
        fail("INVALID_CONFIGURATION");
    }
    // Role placeholders must never hide a writable root that encloses private launch state.
    for (const key of ["codexHomeDirectory", "controlDirectory"] as const) {
      if (contains(paths.tempDirectory, paths[key]) || contains(paths[key], paths.tempDirectory))
        fail("INVALID_CONFIGURATION");
    }
    if (
      contains(paths.tempDirectory, paths.userProfileDirectory) ||
      contains(paths.checkoutDirectory, paths.userProfileDirectory) ||
      contains(paths.codexHomeDirectory, paths.controlDirectory) ||
      contains(paths.controlDirectory, paths.codexHomeDirectory)
    )
      fail("INVALID_CONFIGURATION");
    const environment = object(value.shellEnvironment);
    same(Object.keys(environment).sort(), [...shellNames].sort());
    for (const name of shellNames) text(environment[name], 32768);
    same(directory(environment.TEMP), paths.tempDirectory);
    same(directory(environment.TMP), paths.tempDirectory);
    same(directory(environment.USERPROFILE), paths.userProfileDirectory);
    if (value.commandNetworkDomains !== undefined && !Array.isArray(value.commandNetworkDomains))
      fail("INVALID_CONFIGURATION");
    const domains = ((value.commandNetworkDomains ?? []) as unknown[])
      .map((item) => {
        const name = text(item, 253).toLowerCase();
        if (
          isIP(name) ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
            name,
          ) ||
          /(?:^|\.)(?:localhost|local)$/u.test(name)
        )
          fail("INVALID_CONFIGURATION");
        return name;
      })
      .sort();
    if (
      domains.length > 32 ||
      new Set(domains).size !== domains.length ||
      (value.purpose === "summary_read_only" && domains.length)
    )
      fail("INVALID_CONFIGURATION");
    const expected = snapshot(
      {
        purpose: value.purpose,
        requestedModel,
        ...modelParameters,
        relayUrl,
        ...paths,
        shellEnvironment: environment,
        commandNetworkDomains: domains,
        cliVersion,
        providerId,
        permissionProfile:
          value.purpose === "review" ? "agentic_review_review" : "agentic_review_summary_read_only",
      },
      "INVALID_CONFIGURATION",
    ) as unknown as CodexAppServerSessionExpected;
    knownExpected.add(expected);
    const overrides = Object.entries(policyConfiguration(expected)).map(
      ([key, item]) => `${key}=${inlineToml(item)}`,
    );
    return Object.freeze({
      permissionProfile: expected.permissionProfile,
      overrides: Object.freeze(overrides),
      expected,
    });
  } catch {
    fail("INVALID_CONFIGURATION");
  }
}

function requiredFields(actual: JsonObject, required: JsonObject): void {
  for (const [key, value] of Object.entries(required)) {
    if (!Object.hasOwn(actual, key)) fail("POLICY_MISMATCH");
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      requiredFields(object(actual[key]), object(value));
    else same(actual[key], value);
  }
}
function onlyNullExtras(actual: JsonObject, allowed: readonly string[]): void {
  for (const [key, value] of Object.entries(actual)) {
    if (!allowed.includes(key) && value !== null) fail("POLICY_MISMATCH");
  }
}
function verifyConfig(config: JsonObject, expected: CodexAppServerSessionExpected): void {
  const required = policyConfiguration(expected);
  requiredFields(config, required);
  for (const key of [
    "sandbox_mode",
    "sandbox_workspace_write",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
    "instructions",
    "developer_instructions",
    "model_instructions_file",
    "experimental_compact_prompt_file",
    "profile",
    "projects",
    "skills",
    "hooks",
    "agents",
  ])
    if (config[key] !== null) fail("POLICY_MISMATCH");
  for (const key of ["mcp_servers", "plugins", "profiles"]) same(config[key], {});
  same(Object.keys(object(config.model_providers)), [providerId]);
  const provider = object(object(config.model_providers)[providerId]);
  onlyNullExtras(provider, Object.keys(object(object(required.model_providers)[providerId])));
  same(provider.env_http_headers, { Authorization: "CODEX_PROVIDER_HEADER_0" });
  same(Object.keys(object(config.permissions)), [expected.permissionProfile]);
  const permission = object(object(config.permissions)[expected.permissionProfile]);
  onlyNullExtras(permission, ["filesystem", "network"]);
  const fs = object(permission.filesystem),
    requiredFs = object(
      object(object(required.permissions)[expected.permissionProfile]).filesystem,
    );
  onlyNullExtras(fs, Object.keys(requiredFs));
  same(fs[":workspace_roots"], requiredFs[":workspace_roots"]);
  const network = object(permission.network),
    requiredNetwork = object(
      object(object(required.permissions)[expected.permissionProfile]).network,
    );
  onlyNullExtras(network, Object.keys(requiredNetwork));
  same(network.domains, requiredNetwork.domains);
  same(object(config.shell_environment_policy).set, expected.shellEnvironment);
}
function list(value: unknown, name: "id" | "name"): JsonObject[] {
  const response = object(value);
  if (response.nextCursor !== null || !Array.isArray(response.data) || response.data.length > 256)
    fail("INVALID_OBSERVATION");
  const items = response.data.map(object);
  const names = items.map((item) => item[name]);
  if (names.some((item) => typeof item !== "string") || new Set(names).size !== names.length)
    fail("INVALID_OBSERVATION");
  return items;
}
function normalize(value: unknown, expected: CodexAppServerSessionExpected): unknown {
  const projection = object(value);
  const modelConfig = object(object(projection.configRead).config);
  const modelThread = object(projection.thread);
  const replacements = new Map<string, string>([
    [expected.relayUrl, "$PARENT_RELAY_URL"],
    [expected.codexHomeDirectory, "$CODEX_HOME"],
    [expected.checkoutDirectory, "$CHECKOUT"],
    [expected.controlDirectory, "$CONTROL"],
    [expected.tempDirectory, "$TEMP"],
    [expected.userProfileDirectory, "$USERPROFILE"],
  ]);
  if (new Set(replacements.values()).size !== replacements.size) fail("INVALID_CONFIGURATION");
  const symbols = new Set(replacements.values());
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (symbols.has(item)) fail("INVALID_OBSERVATION");
      return replacements.get(item) ?? item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === "object") {
      const result: JsonObject = Object.create(null);
      for (const [key, child] of Object.entries(item)) {
        if (symbols.has(key)) fail("INVALID_OBSERVATION");
        const normalizedKey = replacements.get(key) ?? key;
        if (Object.hasOwn(result, normalizedKey)) fail("INVALID_OBSERVATION");
        // These are model parameter values, even when a valid effort resembles a path or role.
        // Restrict the exception to the two observed fields; other collision checks stay intact.
        const reasoningValue =
          typeof child === "string" &&
          ((item === modelConfig && key === "model_reasoning_effort") ||
            (item === modelThread && key === "reasoningEffort"));
        result[normalizedKey] = reasoningValue ? child : visit(child);
      }
      return result;
    }
    return item;
  };
  return visit(value);
}
const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Observes one existing transport. It never starts a turn, installs a sandbox, or accepts execution. */
export async function openCodexAppServerSession(options: {
  readonly transport: CodexAppServerTransport;
  readonly expected: CodexAppServerSessionExpected;
}): Promise<CodexAppServerSession> {
  if (
    options === null ||
    typeof options !== "object" ||
    types.isProxy(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    fail("INVALID_CONFIGURATION");
  const descriptor = Object.getOwnPropertyDescriptors(options);
  if (
    Reflect.ownKeys(options).length !== 2 ||
    !descriptor.transport?.value ||
    !descriptor.expected?.value ||
    !knownExpected.has(descriptor.expected.value)
  )
    fail("INVALID_CONFIGURATION");
  const transport = descriptor.transport.value as CodexAppServerTransport;
  const expected = descriptor.expected.value as CodexAppServerSessionExpected;
  if (transport === null || typeof transport !== "object" || types.isProxy(transport))
    fail("INVALID_CONFIGURATION");
  const method = (key: "request" | "notifyInitialized") => {
    let source: object | null = transport;
    for (
      let depth = 0;
      source !== null && depth < 4;
      depth++, source = Object.getPrototypeOf(source)
    ) {
      if (types.isProxy(source)) fail("INVALID_CONFIGURATION");
      const item = Object.getOwnPropertyDescriptor(source, key);
      if (item) {
        if (!("value" in item) || typeof item.value !== "function") fail("INVALID_CONFIGURATION");
        return item.value.bind(transport);
      }
    }
    return fail("INVALID_CONFIGURATION");
  };
  const send = method("request") as CodexAppServerTransport["request"];
  const initializedNotification = method(
    "notifyInitialized",
  ) as CodexAppServerTransport["notifyInitialized"];
  if (openedTransports.has(transport)) fail("INVALID_CONFIGURATION");
  openedTransports.add(transport);
  const raw: JsonObject = Object.create(null);
  const request = async (
    method: Parameters<CodexAppServerTransport["request"]>[0],
    params?: unknown,
  ) => {
    let response: unknown;
    try {
      response = await send(method, params);
    } catch {
      fail("TRANSPORT_FAILED");
    }
    raw[method] = snapshot(response, "INVALID_OBSERVATION");
    if (Buffer.byteLength(createCanonicalResult(raw).json) > maximumObservationBytes)
      fail("INVALID_OBSERVATION");
    return object(raw[method]);
  };
  const initialized = await request("initialize", {
    clientInfo: { name: clientName, version: "1" },
    capabilities: { experimentalApi: true },
  });
  same(initialized.codexHome, expected.codexHomeDirectory);
  same(initialized.platformFamily, "windows");
  same(initialized.platformOs, "windows");
  if (
    typeof initialized.userAgent !== "string" ||
    !initialized.userAgent.startsWith(`${clientName}/${cliVersion} `)
  )
    fail("POLICY_MISMATCH");
  try {
    await initializedNotification();
  } catch {
    fail("TRANSPORT_FAILED");
  }
  const configRead = await request("config/read", {
    cwd: expected.checkoutDirectory,
    includeLayers: true,
  });
  const config = object(configRead.config);
  verifyConfig(config, expected);
  const requirements = await request("configRequirements/read");
  if (!Object.hasOwn(requirements, "requirements")) fail("INVALID_OBSERVATION");
  if (requirements.requirements !== null) object(requirements.requirements);
  const profiles = await request("permissionProfile/list", { cwd: expected.checkoutDirectory });
  const profile = list(profiles, "id").find((item) => item.id === expected.permissionProfile);
  if (profile?.allowed !== true) fail("POLICY_MISMATCH");
  const readiness = await request("windowsSandbox/readiness");
  if (
    typeof readiness.status !== "string" ||
    !["ready", "notConfigured", "updateRequired"].includes(readiness.status)
  )
    fail("INVALID_OBSERVATION");
  const thread = await request("thread/start", {
    cwd: expected.checkoutDirectory,
    ephemeral: true,
    experimentalRawEvents: true,
    dynamicTools: [],
    selectedCapabilityRoots: [],
    allowProviderModelFallback: false,
  });
  const inner = object(thread.thread);
  const threadId = inner.id;
  if (typeof threadId !== "string" || !threadId || threadId.length > 128)
    fail("INVALID_OBSERVATION");
  for (const item of [thread.cwd, inner.cwd]) same(item, expected.checkoutDirectory);
  same(inner.cliVersion, cliVersion);
  same(inner.ephemeral, true);
  same(inner.modelProvider, providerId);
  same(thread.model, expected.requestedModel);
  if (expected.modelReasoningEffort !== null)
    same(thread.reasoningEffort, expected.modelReasoningEffort);
  same(thread.modelProvider, providerId);
  same(thread.runtimeWorkspaceRoots, [expected.checkoutDirectory]);
  same(thread.instructionSources, []);
  same(thread.approvalPolicy, "never");
  same(thread.approvalsReviewer, "user");
  same(thread.activePermissionProfile, { id: expected.permissionProfile, extends: null });
  const sandbox = object(thread.sandbox);
  same(sandbox.type, expected.purpose === "review" ? "workspaceWrite" : "readOnly");
  same(sandbox.networkAccess, true);
  if (expected.purpose === "review") {
    if (
      !Array.isArray(sandbox.writableRoots) ||
      sandbox.writableRoots.some(
        (path) => path !== expected.checkoutDirectory && path !== expected.tempDirectory,
      )
    )
      fail("POLICY_MISMATCH");
  }
  const features = await request("experimentalFeature/list", { threadId, limit: 100 });
  const featureItems = list(features, "name");
  if (
    featureItems.some(
      (item) =>
        typeof item.enabled !== "boolean" ||
        typeof item.defaultEnabled !== "boolean" ||
        typeof item.stage !== "string",
    )
  )
    fail("INVALID_OBSERVATION");
  for (const [name, enabled] of Object.entries(object(policyConfiguration(expected).features))) {
    if (featureItems.find((item) => item.name === name)?.enabled !== enabled)
      fail("POLICY_MISMATCH");
  }
  // These explicitly identified provenance/lifecycle fields are not the stable policy projection.
  // Raw origins/layers, including dynamic source-version hashes, remain bound by rawObservationSha256.
  const { origins: _origins, layers: _layers, ...configPolicy } = configRead;
  const { userAgent: _agent, ...initializePolicy } = initialized;
  const {
    id: _id,
    sessionId: _session,
    createdAt: _created,
    updatedAt: _updated,
    recencyAt: _recency,
    preview: _preview,
    status: _status,
    turns: _turns,
    ...threadFields
  } = inner;
  const projection = snapshot(
    normalize(
      {
        schemaVersion: "CodexAppServerConfigurationProjectionV1",
        initialization: initializePolicy,
        configRead: configPolicy,
        requirements,
        permissionProfiles: {
          ...profiles,
          data: [...list(profiles, "id")].sort((a, b) =>
            compareCodeUnits(String(a.id), String(b.id)),
          ),
        },
        readiness,
        thread: { ...thread, thread: threadFields },
        features: {
          ...features,
          data: [...featureItems].sort((a, b) => compareCodeUnits(String(a.name), String(b.name))),
        },
      },
      expected,
    ),
    "INVALID_OBSERVATION",
  ) as JsonObject;
  const observation: CodexAppServerSessionObservation = Object.freeze({
    schemaVersion: "CodexAppServerSessionObservationV1",
    measurementKind: "app_server_configuration_projection_v1",
    cliVersion: inner.cliVersion as string,
    threadId,
    readiness: readiness.status as CodexAppServerSessionObservation["readiness"],
    launchPolicySha256: createCanonicalResult(projection).sha256,
    rawObservationSha256: createCanonicalResult(raw).sha256,
    projection,
    executionAccepted: false,
  });
  if (readiness.status !== "ready")
    throw new CodexAppServerSessionPolicyError("SANDBOX_NOT_READY", observation);
  return Object.freeze({
    threadId,
    launchPolicySha256: observation.launchPolicySha256,
    observation,
  });
}
