import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type {
  ProtocolVersion,
  WorkerArchitecture,
  WorkerCapabilities,
} from "@agentic-review/contracts";

export interface TlsClientConfig {
  readonly ca?: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
  readonly pfx?: Buffer;
  readonly passphrase?: string;
  readonly serverName?: string;
  readonly rejectUnauthorized: true;
}

export interface WorkerConfig {
  readonly serverUrl: URL;
  readonly protocolVersion: ProtocolVersion;
  readonly workerNodeId: string;
  readonly displayName: string;
  readonly workerVersion: string;
  readonly maxSlots: number;
  readonly dataDirectory: string;
  readonly executionEnabled: boolean;
  readonly processHostPath?: string;
  readonly claimWaitSeconds: number;
  readonly registrationRetrySeconds: number;
  readonly idleDelayMilliseconds: number;
  readonly heartbeatIntervalSeconds: number;
  readonly heartbeatSafetyMarginSeconds: number;
  readonly shutdownGraceSeconds: number;
  readonly requestTimeoutSeconds: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly capabilities: WorkerCapabilities;
  readonly allowInsecureHttp: boolean;
  readonly tls?: TlsClientConfig;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const allowInsecureHttp = readBoolean(environment, "WORKER_ALLOW_INSECURE_HTTP", false);
  const serverUrl = new URL(readRequired(environment, "WORKER_SERVER_URL"));
  if (serverUrl.protocol !== "https:" && !(allowInsecureHttp && serverUrl.protocol === "http:")) {
    throw new Error(
      "WORKER_SERVER_URL must use HTTPS unless WORKER_ALLOW_INSECURE_HTTP is explicitly enabled.",
    );
  }
  if (
    serverUrl.username !== "" ||
    serverUrl.password !== "" ||
    serverUrl.pathname !== "/" ||
    serverUrl.search !== "" ||
    serverUrl.hash !== ""
  ) {
    throw new Error(
      "WORKER_SERVER_URL must be an origin without credentials, a path, a query, or a fragment.",
    );
  }

  const dataDirectory = resolveAbsolutePath(
    environment.WORKER_DATA_DIR ?? "C:\\ProgramData\\AgenticReview\\Worker",
    "WORKER_DATA_DIR",
  );
  const executionEnabled = readBoolean(environment, "WORKER_EXECUTION_ENABLED", false);
  if (executionEnabled) {
    throw new Error(
      "WORKER_EXECUTION_ENABLED cannot be enabled until the Codex executor and ProcessHost client are installed.",
    );
  }
  const processHostPath = readOptionalAbsolutePath(environment, "WORKER_PROCESS_HOST_PATH");
  if (executionEnabled && processHostPath === undefined) {
    throw new Error("WORKER_PROCESS_HOST_PATH is required when WORKER_EXECUTION_ENABLED is true.");
  }
  if (processHostPath !== undefined && !existsSync(processHostPath)) {
    throw new Error(`WORKER_PROCESS_HOST_PATH does not exist: ${processHostPath}`);
  }

  const logLevel = environment.WORKER_LOG_LEVEL ?? "info";
  if (!isLogLevel(logLevel)) {
    throw new Error("WORKER_LOG_LEVEL must be debug, info, warn, or error.");
  }

  return {
    serverUrl,
    protocolVersion: readProtocolVersion(environment.WORKER_PROTOCOL_VERSION),
    workerNodeId: validateIdentifier(readRequired(environment, "WORKER_NODE_ID"), "WORKER_NODE_ID"),
    displayName: environment.WORKER_DISPLAY_NAME ?? hostname(),
    workerVersion: environment.WORKER_VERSION ?? "0.1.0",
    maxSlots: readInteger(environment, "WORKER_MAX_SLOTS", 1, 1, 64),
    dataDirectory,
    executionEnabled,
    ...(processHostPath === undefined ? {} : { processHostPath }),
    claimWaitSeconds: readInteger(environment, "WORKER_CLAIM_WAIT_SECONDS", 30, 1, 60),
    registrationRetrySeconds: readInteger(
      environment,
      "WORKER_REGISTRATION_RETRY_SECONDS",
      10,
      1,
      300,
    ),
    idleDelayMilliseconds: readInteger(
      environment,
      "WORKER_IDLE_DELAY_MILLISECONDS",
      1_000,
      100,
      60_000,
    ),
    heartbeatIntervalSeconds: readInteger(environment, "WORKER_HEARTBEAT_SECONDS", 20, 5, 60),
    heartbeatSafetyMarginSeconds: readInteger(
      environment,
      "WORKER_HEARTBEAT_SAFETY_MARGIN_SECONDS",
      20,
      5,
      120,
    ),
    shutdownGraceSeconds: readInteger(environment, "WORKER_SHUTDOWN_GRACE_SECONDS", 120, 10, 3_600),
    requestTimeoutSeconds: readInteger(environment, "WORKER_REQUEST_TIMEOUT_SECONDS", 30, 5, 300),
    logLevel,
    capabilities: {
      operatingSystem: "windows",
      architecture: readArchitecture(process.arch),
      headless: true,
      interactiveDesktop: false,
      codexVersion: environment.WORKER_CODEX_VERSION ?? "not-configured",
      recipeIds: readStringArray(environment.WORKER_RECIPE_IDS),
      labels: {
        ...readStringRecord(environment.WORKER_LABELS_JSON, "WORKER_LABELS_JSON"),
        execution: executionEnabled ? "enabled" : "disabled",
        processHost: processHostPath === undefined ? "unavailable" : "available",
      },
    },
    allowInsecureHttp,
    ...(serverUrl.protocol === "https:" ? { tls: loadTlsConfig(environment) } : {}),
  };
}

function loadTlsConfig(environment: NodeJS.ProcessEnv): TlsClientConfig {
  const caPath = readOptionalAbsolutePath(environment, "WORKER_TLS_CA_PATH");
  const certPath = readOptionalAbsolutePath(environment, "WORKER_TLS_CERT_PATH");
  const keyPath = readOptionalAbsolutePath(environment, "WORKER_TLS_KEY_PATH");
  const pfxPath = readOptionalAbsolutePath(environment, "WORKER_TLS_PFX_PATH");
  const usesPemPair = certPath !== undefined || keyPath !== undefined;

  if (usesPemPair && (certPath === undefined || keyPath === undefined)) {
    throw new Error("WORKER_TLS_CERT_PATH and WORKER_TLS_KEY_PATH must be configured together.");
  }
  if (usesPemPair && pfxPath !== undefined) {
    throw new Error("Configure either PEM certificate/key files or a PFX file, not both.");
  }
  if (!usesPemPair && pfxPath === undefined) {
    throw new Error(
      "HTTPS Worker API access requires a client certificate/key pair or a PFX file.",
    );
  }

  return {
    ...(caPath === undefined ? {} : { ca: readSecretFile(caPath, "WORKER_TLS_CA_PATH") }),
    ...(certPath === undefined ? {} : { cert: readSecretFile(certPath, "WORKER_TLS_CERT_PATH") }),
    ...(keyPath === undefined ? {} : { key: readSecretFile(keyPath, "WORKER_TLS_KEY_PATH") }),
    ...(pfxPath === undefined ? {} : { pfx: readSecretFile(pfxPath, "WORKER_TLS_PFX_PATH") }),
    ...(environment.WORKER_TLS_PFX_PASSPHRASE === undefined
      ? {}
      : { passphrase: environment.WORKER_TLS_PFX_PASSPHRASE }),
    ...(environment.WORKER_TLS_SERVER_NAME === undefined
      ? {}
      : { serverName: environment.WORKER_TLS_SERVER_NAME }),
    rejectUnauthorized: true,
  };
}

function readSecretFile(path: string, name: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`Unable to read ${name} from ${path}.`, { cause: error });
  }
}

function readRequired(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readBoolean(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = environment[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return fallback;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`${name} must be true, false, 1, or 0.`);
}

function readInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const text = environment[name];
  if (text === undefined || text.trim() === "") {
    return fallback;
  }
  const value = Number.parseInt(text, 10);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum ||
    String(value) !== text.trim()
  ) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function readStringArray(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function readStringRecord(
  value: string | undefined,
  name: string,
): Readonly<Record<string, string>> {
  if (value === undefined || value.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON.`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object.`);
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string" || key.trim() === "" || entry.trim() === "") {
      throw new Error(`${name} keys and values must be non-empty strings.`);
    }
    result[key] = entry;
  }
  return result;
}

function readOptionalAbsolutePath(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value ? resolveAbsolutePath(value, name) : undefined;
}

function resolveAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return resolve(value);
}

function validateIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${name} contains unsupported characters or exceeds 128 characters.`);
  }
  return value;
}

function isLogLevel(value: string): value is WorkerConfig["logLevel"] {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function readProtocolVersion(value: string | undefined): ProtocolVersion {
  if (value === undefined || value === "1.0") {
    return "1.0";
  }
  throw new Error("WORKER_PROTOCOL_VERSION must be 1.0.");
}

function readArchitecture(value: string): WorkerArchitecture {
  if (value === "x64" || value === "arm64") {
    return value;
  }
  throw new Error(`Unsupported Windows worker architecture: ${value}`);
}
