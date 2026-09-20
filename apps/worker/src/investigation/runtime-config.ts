import { win32 } from "node:path";
import type { CliEngine } from "@agentic-review/codex";
import type { InvestigationTaskKind } from "@agentic-review/contracts";
import {
  assertWindowsLocalAbsolutePath,
  type ProcessResourceLimits,
} from "../execution/process-host-protocol.js";
import { type E2eMsbuildToolchain, parseE2eMsbuildToolchain } from "./e2e-build.js";
import { assertCanonicalRepository } from "./git-source.js";
import { type InvestigationWorkerRole, investigationTaskPool } from "./task-service.js";
import {
  type InvestigationUiPlanAdapterConfiguration,
  parseInvestigationUiPlanAdapterConfiguration,
} from "./ui-plan-adapter.js";

export interface InvestigationExecutableConfiguration {
  readonly path: string;
  readonly sha256: string;
}

export interface InvestigationWorkerRuntimeConfig {
  readonly serverUrl: string;
  readonly workerToken: string;
  readonly allowInsecureHttp: boolean;
  readonly dataDirectory: string;
  readonly workspaceRootDirectory: string;
  /** Shared across every Worker role and data directory on this Windows machine. */
  readonly desktopLockDirectory?: string;
  readonly trustedExecutableRoot: string;
  readonly processHost: InvestigationExecutableConfiguration;
  readonly git: InvestigationExecutableConfiguration;
  readonly cli: InvestigationExecutableConfiguration & {
    readonly engine: CliEngine;
    readonly model?: string;
  };
  readonly allowedRepositories: readonly string[];
  readonly supportedKinds: readonly InvestigationTaskKind[];
  /** Legacy alias for the static pool capacity. */
  readonly maximumConcurrentTasks: number;
  readonly maximumConcurrentStaticTasks?: number;
  readonly role?: InvestigationWorkerRole;
  readonly claimPollMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly operatingSystemEnvironment: Readonly<Record<string, string>>;
  readonly modelEnvironment: Readonly<Record<string, string>>;
  readonly planEnvironment: Readonly<Record<string, string>>;
  readonly executables: Readonly<Record<string, InvestigationExecutableConfiguration>>;
  /** Optional deployment-owned compiler selection for controlled MSBuild operations. */
  readonly msbuildToolchain?: E2eMsbuildToolchain;
  readonly uiAdapters: Readonly<Record<string, InvestigationUiPlanAdapterConfiguration>>;
  readonly modelStaticConfiguration: {
    readonly verified: boolean;
    readonly disabledMcpServers: readonly string[];
  };
  readonly processLimits: ProcessResourceLimits;
  readonly gitLimits: ProcessResourceLimits;
}

const kinds: readonly InvestigationTaskKind[] = [
  "pr-review",
  "issue-investigate",
  "pr-e2e",
  "pr-verify",
  "issue-verify",
  "reproduction-setup",
  "issue-fix",
  "feature-implement",
];
const modelEnvironmentNames = new Set([
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "COPILOT_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
]);
const pinnedMsbuildEnvironmentConflicts = new Set([
  "VCTOOLSVERSION",
  "PLATFORMTOOLSET",
  "VCTOOLSINSTALLDIR",
  "VCTARGETSPATH",
  "CLTOOLPATH",
  "CLTOOLEXE",
  "VCINSTALLDIR",
  "CL",
  "_CL_",
]);

/** Loads only the native investigation configuration; no legacy Worker settings are accepted. */
export function loadInvestigationWorkerRuntimeConfig(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): InvestigationWorkerRuntimeConfig {
  const value = (name: string): string | undefined => environment[`INVESTIGATION_WORKER_${name}`];
  const required = (name: string): string => text(value(name), `INVESTIGATION_WORKER_${name}`);
  const workerToken = required("TOKEN");
  // This matches the Server's INVESTIGATION_WORKERS_JSON credential policy.
  if (!/^[A-Za-z0-9_-]{43,256}$/u.test(workerToken))
    throw invalid("TOKEN", "must contain 43 to 256 base64url characters");
  const serverUrl = required("SERVER_URL");
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw invalid("SERVER_URL", "must be an absolute HTTP(S) origin");
  }
  const allowInsecureHttp = boolean(value("ALLOW_INSECURE_HTTP"), false, "ALLOW_INSECURE_HTTP");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw invalid(
      "SERVER_URL",
      "must be an HTTP(S) origin without credentials, a path, query, or fragment",
    );
  if (url.protocol === "http:" && !allowInsecureHttp)
    throw invalid("ALLOW_INSECURE_HTTP", "must explicitly permit an HTTP deployment");
  const dataDirectory = directory(required("DATA_DIRECTORY"), "DATA_DIRECTORY");
  const trustedExecutableRoot = directory(
    required("TRUSTED_EXECUTABLE_ROOT"),
    "TRUSTED_EXECUTABLE_ROOT",
  );
  requireDisjoint(dataDirectory, trustedExecutableRoot);
  const binary = (prefix: string): InvestigationExecutableConfiguration => ({
    path: executable(required(`${prefix}_PATH`), `${prefix}_PATH`, dataDirectory),
    sha256: digest(required(`${prefix}_SHA256`), `${prefix}_SHA256`),
  });
  const processHost = binary("PROCESS_HOST");
  const git = binary("GIT");
  const cliBinary = binary("CLI");
  for (const entry of [processHost, git]) {
    if (!descendant(trustedExecutableRoot, entry.path))
      throw invalid("TRUSTED_EXECUTABLE_ROOT", "must contain the ProcessHost and Git binaries");
  }
  const engine = value("CLI_ENGINE") ?? "codex";
  if (engine !== "codex" && engine !== "copilot")
    throw invalid("CLI_ENGINE", "must be codex or copilot");
  const model = value("CLI_MODEL");
  if (model !== undefined && (text(model, "CLI_MODEL").length > 256 || model.includes(workerToken)))
    throw invalid("CLI_MODEL", "must be a bounded non-secret model identifier");
  const osRoot = text(environment.SYSTEMROOT ?? environment.SystemRoot, "SYSTEMROOT");
  assertWindowsLocalAbsolutePath(osRoot, "Windows system root", false);
  const desktopLockDirectory = directory(
    value("DESKTOP_LOCK_DIRECTORY") ?? defaultInvestigationDesktopLockDirectory(environment),
    "DESKTOP_LOCK_DIRECTORY",
  );
  requireDisjoint(dataDirectory, desktopLockDirectory);
  requireDisjoint(trustedExecutableRoot, desktopLockDirectory);
  const path =
    value("PATH") ??
    [
      win32.dirname(git.path),
      win32.dirname(cliBinary.path),
      win32.join(osRoot, "System32"),
      osRoot,
    ].join(";");
  for (const entry of path.split(";")) {
    directory(text(entry, "PATH entry"), "PATH entry");
    requireDisjoint(dataDirectory, entry);
  }
  const operatingSystemEnvironment = {
    SYSTEMROOT: osRoot,
    WINDIR: osRoot,
    COMSPEC: win32.join(osRoot, "System32", "cmd.exe"),
    PATH: path,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const modelEnvironment = environmentObject(
    value("MODEL_ENVIRONMENT_JSON"),
    "MODEL_ENVIRONMENT_JSON",
    workerToken,
  );
  for (const [name, entry] of Object.entries(modelEnvironment)) {
    if (!modelEnvironmentNames.has(name))
      throw invalid("MODEL_ENVIRONMENT_JSON", "contains an unsupported variable");
    if (!["LANG", "LC_ALL", "TERM"].includes(name)) {
      directory(entry, "MODEL_ENVIRONMENT_JSON path");
      requireDisjoint(dataDirectory, entry);
    }
  }
  const cliHome = engine === "codex" ? "CODEX_HOME" : "COPILOT_HOME";
  if (!modelEnvironment[cliHome] || !modelEnvironment.USERPROFILE)
    throw invalid(
      "MODEL_ENVIRONMENT_JSON",
      `must explicitly identify ${cliHome} and USERPROFILE for the deployment-owned CLI account`,
    );
  const planEnvironment = environmentObject(
    value("PLAN_ENVIRONMENT_JSON"),
    "PLAN_ENVIRONMENT_JSON",
    workerToken,
  );
  if (
    Object.keys(planEnvironment).some((name) =>
      /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL)/u.test(name),
    )
  )
    throw invalid("PLAN_ENVIRONMENT_JSON", "cannot contain credential variables");
  for (const values of [operatingSystemEnvironment, modelEnvironment, planEnvironment]) {
    if (Object.values(values).some((entry) => entry.includes(workerToken)))
      throw invalid("environment", "cannot disclose the Worker credential to a child process");
  }
  const allowedRepositories = stringList(
    value("ALLOWED_REPOSITORIES_JSON"),
    "ALLOWED_REPOSITORIES_JSON",
    [],
  );
  allowedRepositories.forEach(assertCanonicalRepository);
  if (
    new Set(allowedRepositories.map((entry) => entry.toLowerCase())).size !==
    allowedRepositories.length
  )
    throw invalid("ALLOWED_REPOSITORIES_JSON", "cannot contain duplicate canonical names");
  const supportedKinds = stringList(value("SUPPORTED_KINDS_JSON"), "SUPPORTED_KINDS_JSON", kinds);
  if (
    supportedKinds.length === 0 ||
    supportedKinds.some((kind) => !kinds.includes(kind as InvestigationTaskKind))
  )
    throw invalid("SUPPORTED_KINDS_JSON", "must contain supported native investigation task kinds");
  const role = value("ROLE") ?? "all";
  if (role !== "all" && role !== "static" && role !== "e2e")
    throw invalid("ROLE", "must be static, e2e, or all");
  const roleKinds = supportedKinds.filter(
    (kind) => role === "all" || investigationTaskPool(kind as InvestigationTaskKind) === role,
  );
  if (roleKinds.length === 0)
    throw invalid("SUPPORTED_KINDS_JSON", "must include a task kind matching the Worker role");
  const executables: Record<string, InvestigationExecutableConfiguration> = {};
  const configuredExecutables = jsonObject(value("EXECUTABLES_JSON"), "EXECUTABLES_JSON");
  for (const [id, entry] of Object.entries(configuredExecutables)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) ||
      !isObject(entry) ||
      Object.keys(entry).sort().join(",") !== "path,sha256"
    )
      throw invalid("EXECUTABLES_JSON", "must map executable IDs to path and sha256 records");
    executables[id] = {
      path: executable(text(entry.path, "executable path"), "EXECUTABLES_JSON path", dataDirectory),
      sha256: digest(text(entry.sha256, "executable sha256"), "EXECUTABLES_JSON sha256"),
    };
  }
  const vcToolsVersion = value("MSBUILD_VC_TOOLS_VERSION");
  const platformToolset = value("MSBUILD_PLATFORM_TOOLSET");
  let msbuildToolchain: E2eMsbuildToolchain | undefined;
  if (vcToolsVersion !== undefined || platformToolset !== undefined) {
    if (vcToolsVersion === undefined || platformToolset === undefined)
      throw invalid(
        "MSBUILD_VC_TOOLS_VERSION",
        "and INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET must be configured together",
      );
    if (!Object.hasOwn(executables, "msbuild"))
      throw invalid(
        "EXECUTABLES_JSON",
        "must provide the deployment-owned msbuild executable when an MSBuild toolchain is pinned",
      );
    try {
      msbuildToolchain = parseE2eMsbuildToolchain({ vcToolsVersion, platformToolset });
    } catch {
      throw invalid(
        "MSBUILD_VC_TOOLS_VERSION",
        "and INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET must identify a supported, compatible compiler version and toolset",
      );
    }
    const conflicts = Object.keys(planEnvironment).filter((name) =>
      pinnedMsbuildEnvironmentConflicts.has(name),
    );
    if (conflicts.length > 0)
      throw invalid(
        "PLAN_ENVIRONMENT_JSON",
        `conflicts with the pinned MSBuild toolchain through ${conflicts.join(", ")}`,
      );
  }
  const uiAdapters: Record<string, InvestigationUiPlanAdapterConfiguration> = {};
  for (const [id, entry] of Object.entries(
    jsonObject(value("UI_ADAPTERS_JSON"), "UI_ADAPTERS_JSON"),
  )) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
      throw invalid("UI_ADAPTERS_JSON", "contains an invalid adapter identifier");
    const configuration = parseInvestigationUiPlanAdapterConfiguration(entry);
    const pins = [
      configuration.windowsDriver.executable,
      configuration.windowsDriver.entry,
      ...(configuration.webDriver === undefined
        ? []
        : [
            configuration.webDriver.executable,
            configuration.webDriver.entry,
            configuration.webDriver.browser,
          ]),
    ];
    if (pins.some((pin) => descendant(dataDirectory, pin.path)))
      throw invalid(
        "UI_ADAPTERS_JSON",
        "cannot load trusted drivers or browsers from mutable Worker data",
      );
    if (configuration.desktopLockDirectory !== undefined) {
      directory(configuration.desktopLockDirectory, "UI_ADAPTERS_JSON desktopLockDirectory");
      requireDisjoint(trustedExecutableRoot, configuration.desktopLockDirectory);
    }
    uiAdapters[id] = configuration;
  }
  const staticCapacitySetting =
    value("MAX_CONCURRENT_STATIC_TASKS") === undefined
      ? "MAX_CONCURRENT_TASKS"
      : "MAX_CONCURRENT_STATIC_TASKS";
  const maximumConcurrentStaticTasks = integer(
    value(staticCapacitySetting),
    1,
    1,
    16,
    staticCapacitySetting,
  );
  const processLimits: ProcessResourceLimits = {
    hardTimeoutMs: integer(
      value("PROCESS_TIMEOUT_MS"),
      600_000,
      10_000,
      7_200_000,
      "PROCESS_TIMEOUT_MS",
    ),
    maximumProcessCount: integer(value("MAX_PROCESS_COUNT"), 32, 1, 256, "MAX_PROCESS_COUNT"),
    maximumMemoryBytes: integer(
      value("MAX_MEMORY_BYTES"),
      4 * 1024 * 1024 * 1024,
      128 * 1024 * 1024,
      64 * 1024 * 1024 * 1024,
      "MAX_MEMORY_BYTES",
    ),
    maximumOutputBytes: integer(
      value("MAX_OUTPUT_BYTES"),
      64 * 1024 * 1024,
      4096,
      128 * 1024 * 1024,
      "MAX_OUTPUT_BYTES",
    ),
  };
  const logLevel = value("LOG_LEVEL") ?? "info";
  if (logLevel !== "debug" && logLevel !== "info" && logLevel !== "warn" && logLevel !== "error")
    throw invalid("LOG_LEVEL", "must be debug, info, warn, or error");
  return {
    serverUrl: url.origin,
    workerToken,
    allowInsecureHttp,
    dataDirectory,
    workspaceRootDirectory: win32.join(dataDirectory, "attempts"),
    desktopLockDirectory,
    trustedExecutableRoot,
    processHost,
    git,
    cli: { ...cliBinary, engine, ...(model === undefined ? {} : { model }) },
    allowedRepositories,
    supportedKinds: roleKinds as InvestigationTaskKind[],
    maximumConcurrentTasks: maximumConcurrentStaticTasks,
    maximumConcurrentStaticTasks,
    role,
    claimPollMs: integer(value("CLAIM_POLL_MS"), 2_000, 100, 60_000, "CLAIM_POLL_MS"),
    requestTimeoutMs: integer(
      value("REQUEST_TIMEOUT_MS"),
      30_000,
      1_000,
      120_000,
      "REQUEST_TIMEOUT_MS",
    ),
    shutdownTimeoutMs: integer(
      value("SHUTDOWN_TIMEOUT_MS"),
      60_000,
      5_000,
      300_000,
      "SHUTDOWN_TIMEOUT_MS",
    ),
    logLevel,
    operatingSystemEnvironment,
    modelEnvironment,
    planEnvironment,
    executables,
    ...(msbuildToolchain === undefined ? {} : { msbuildToolchain }),
    uiAdapters,
    modelStaticConfiguration: {
      verified: boolean(value("STATIC_CONFIG_VERIFIED"), false, "STATIC_CONFIG_VERIFIED"),
      disabledMcpServers: stringList(
        value("DISABLED_MCP_SERVERS_JSON"),
        "DISABLED_MCP_SERVERS_JSON",
        [],
      ),
    },
    processLimits,
    gitLimits: {
      ...processLimits,
      hardTimeoutMs: integer(value("GIT_TIMEOUT_MS"), 600_000, 10_000, 7_200_000, "GIT_TIMEOUT_MS"),
    },
  };
}

/** ProgramData is machine-wide; never derive the execution lock from a Worker data root. */
export function defaultInvestigationDesktopLockDirectory(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const osRoot = environment.SYSTEMROOT ?? environment.SystemRoot ?? "C:\\Windows";
  const programData =
    environment.ProgramData ??
    environment.PROGRAMDATA ??
    win32.join(win32.parse(osRoot).root, "ProgramData");
  return directory(
    win32.join(programData, "PowerToysAgenticReview", "desktop-locks"),
    "DESKTOP_LOCK_DIRECTORY",
  );
}

function directory(value: string, name: string): string {
  assertWindowsLocalAbsolutePath(value, name, false);
  if (win32.normalize(value).toLowerCase() === win32.parse(value).root.toLowerCase())
    throw invalid(name, "cannot be a drive root");
  return win32.normalize(value);
}
function executable(value: string, name: string, data: string): string {
  assertWindowsLocalAbsolutePath(value, name, true);
  if (descendant(data, value)) throw invalid(name, "cannot be inside the Worker data directory");
  return win32.normalize(value);
}
function requireDisjoint(first: string, second: string): void {
  if (key(first) === key(second) || descendant(first, second) || descendant(second, first))
    throw invalid(
      "paths",
      "must keep mutable Worker data separate from trusted binaries and CLI configuration",
    );
}
function descendant(root: string, child: string): boolean {
  return key(child).startsWith(`${key(root)}\\`);
}
function key(value: string): string {
  return win32
    .normalize(value)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}
function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  )
    throw invalid(name, "must be non-empty single-line text without surrounding whitespace");
  return value;
}
function digest(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw invalid(name, "must be a lowercase SHA-256 digest");
  return value;
}
function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/u.test(value)) throw invalid(name, "must be an integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw invalid(name, `must be between ${minimum} and ${maximum}`);
  return number;
}
function boolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false") throw invalid(name, "must be true or false");
  return value === "true";
}
function parseJson(value: string | undefined, name: string, fallback: unknown): unknown {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw invalid(name, "must be valid JSON");
  }
}
function jsonObject(value: string | undefined, name: string): Record<string, unknown> {
  const object = parseJson(value, name, {});
  if (!isObject(object)) throw invalid(name, "must be a JSON object");
  return object;
}
function stringList(
  value: string | undefined,
  name: string,
  fallback: readonly string[],
): string[] {
  const list = parseJson(value, name, fallback);
  if (
    !Array.isArray(list) ||
    list.some((entry) => typeof entry !== "string" || !entry || /[\0\r\n]/u.test(entry)) ||
    new Set(list).size !== list.length
  )
    throw invalid(name, "must contain distinct non-empty strings");
  return [...list] as string[];
}
function environmentObject(
  value: string | undefined,
  name: string,
  token: string,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(jsonObject(value, name))) {
    const key = rawName.toUpperCase();
    const standardWindowsName = key === "PROGRAMFILES(X86)" || key === "COMMONPROGRAMFILES(X86)";
    if (
      (!/^[A-Z_][A-Z0-9_]*$/u.test(key) && !standardWindowsName) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Explicitly reject control bytes in environment variable names, including terminal newlines.
      /[\u0000-\u001f\u007f-\u009f]/u.test(key) ||
      key.startsWith("INVESTIGATION_") ||
      key in entries
    )
      throw invalid(name, "contains an invalid or reserved environment variable");
    const entry = text(rawValue, name);
    if (entry.includes(token)) throw invalid(name, "cannot disclose the Worker credential");
    entries[key] = entry;
  }
  return entries;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(name: string, detail: string): Error {
  return new Error(`INVESTIGATION_WORKER_${name} ${detail}.`);
}
