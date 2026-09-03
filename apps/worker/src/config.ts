import {
  type BigIntStats,
  closeSync,
  constants as fileSystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { hostname } from "node:os";
import { win32 } from "node:path";
import { TextDecoder } from "node:util";
import type {
  ProtocolVersion,
  WorkerArchitecture,
  WorkerCapabilities,
} from "@agentic-review/contracts";
import { processHostResourceBounds } from "./execution/process-host-protocol.js";

const kibibyte = 1024;
const mebibyte = 1024 * kibibyte;
const gibibyte = 1024 * mebibyte;
const tebibyte = 1024 * gibibyte;
const maximumWindowsPathLength = 32_767;
const maximumTotalProcessCount = 64 * processHostResourceBounds.maximumProcessCount.maximum;
const maximumTotalMemoryBytes = 64 * processHostResourceBounds.maximumMemoryBytes.maximum;
const maximumTotalOutputBytes = 64 * processHostResourceBounds.maximumOutputBytes.maximum;
const maximumPerAttemptDiskBytes = tebibyte;
const maximumTotalWorkspaceDiskBytes = 64 * maximumPerAttemptDiskBytes;
const maximumTlsCaBytes = mebibyte;
const maximumWorkerAuthProfileBytes = 4 * kibibyte;
const workerAuthProfileId = "agentic-review-worker-auth-v1";
const workerAuthProfilePath = "C:\\ProgramData\\AgenticReview\\Control\\worker-auth-v1.json";
const workerTokenPattern = /^arw1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const fileTypeModeMask = 0o170000n;
const regularFileMode = 0o100000n;

export interface StableSecretFileMetadata {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly linkCount: bigint;
  readonly modifiedTimeNanoseconds: bigint;
  readonly changedTimeNanoseconds: bigint;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface SecretFileSystem {
  readonly lstat: (path: string) => StableSecretFileMetadata;
  readonly realpath: (path: string) => string;
  readonly open: (path: string) => number;
  readonly fstat: (descriptor: number) => StableSecretFileMetadata;
  readonly read: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly close: (descriptor: number) => void;
}

export interface WorkerConfigDependencies {
  readonly secretFileSystem?: SecretFileSystem;
  readonly workerAuthFileReader?: (path: string) => Buffer;
}

export interface TlsClientConfig {
  readonly ca?: Buffer;
  readonly serverName?: string;
  readonly rejectUnauthorized: true;
}

export interface WorkerExecutionResourceLimits {
  readonly maximumProcessCount: number;
  readonly maximumMemoryBytes: number;
  readonly maximumOutputBytes: number;
}

export interface WorkerExecutionConfig {
  readonly trustedExecutableRoot: string;
  readonly processHostPath: string;
  readonly processHostSha256: string;
  readonly codexExecutablePath: string;
  readonly codexSha256: string;
  readonly codexVersion: string;
  readonly gitExecutablePath: string;
  readonly gitSha256: string;
  readonly workspaceRootDirectory: string;
  readonly tempDirectory: string;
  readonly profileDirectory: string;
  readonly processHostRequestTimeoutMs: number;
  readonly processHostStartTimeoutMs: number;
  readonly processHostShutdownTimeoutMs: number;
  readonly codexMaximumHardTimeoutMs: number;
  readonly gitHardTimeoutMs: number;
  readonly codexResourceLimits: WorkerExecutionResourceLimits;
  readonly gitResourceLimits: WorkerExecutionResourceLimits;
  readonly totalResourceBudget: WorkerExecutionResourceLimits;
  readonly perAttemptDiskBytes: number;
  readonly totalWorkspaceDiskBytes: number;
  readonly minimumFreeDiskBytes: number;
  readonly orphanRetentionHours: number;
  readonly orphanScanLimit: number;
}

export interface WorkerConfig {
  readonly serverUrl: URL;
  readonly protocolVersion: ProtocolVersion;
  readonly workerNodeId: string;
  readonly workerToken: string;
  readonly displayName: string;
  readonly workerVersion: string;
  readonly maxSlots: number;
  readonly dataDirectory: string;
  readonly executionEnabled: boolean;
  readonly execution?: WorkerExecutionConfig;
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

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: WorkerConfigDependencies = {},
): WorkerConfig {
  const authentication = loadWorkerAuthentication(
    dependencies.workerAuthFileReader ?? systemWorkerAuthFileReader,
  );
  const allowInsecureHttp = readBoolean(environment, "WORKER_ALLOW_INSECURE_HTTP", false);
  const serverUrlText = readRequired(environment, "WORKER_SERVER_URL");
  const serverUrl = new URL(serverUrlText);
  if (allowInsecureHttp && environment.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new Error("WORKER_ALLOW_INSECURE_HTTP must not be enabled in production.");
  }
  if (allowInsecureHttp && !isExplicitLoopbackOrigin(serverUrlText)) {
    throw new Error(
      "WORKER_ALLOW_INSECURE_HTTP requires WORKER_SERVER_URL to use 127.0.0.1, [::1], or localhost.",
    );
  }
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

  const dataDirectory = readWindowsPath(
    environment.WORKER_DATA_DIR ?? "C:\\ProgramData\\AgenticReview\\Worker",
    "WORKER_DATA_DIR",
    "directory",
  );
  assertNotFileSystemRoot(dataDirectory, "WORKER_DATA_DIR");
  const maxSlots = readInteger(environment, "WORKER_MAX_SLOTS", 1, 1, 64);
  const shutdownGraceSeconds = readInteger(
    environment,
    "WORKER_SHUTDOWN_GRACE_SECONDS",
    90,
    10,
    3_600,
  );
  const executionEnabled = readBoolean(environment, "WORKER_EXECUTION_ENABLED", false);
  const recipeIds = readStringArray(environment.WORKER_RECIPE_IDS);
  if (recipeIds.length !== 0) {
    throw new Error("WORKER_RECIPE_IDS must remain empty until dynamic validation is implemented.");
  }

  // These checks are lexical only. Before registration, the startup verifier must resolve the
  // real paths, reject reparse points, confirm file identity, and compare binary digests. The
  // executor must also pass its runtime isolation gate before any untrusted job can start.
  const execution = executionEnabled
    ? loadExecutionConfig(environment, dataDirectory, maxSlots)
    : undefined;

  const logLevel = environment.WORKER_LOG_LEVEL ?? "info";
  if (!isLogLevel(logLevel)) {
    throw new Error("WORKER_LOG_LEVEL must be debug, info, warn, or error.");
  }
  const displayName = readDisplayName(environment.WORKER_DISPLAY_NAME ?? hostname());
  const workerVersion = readWorkerVersion(environment.WORKER_VERSION ?? "0.1.0");
  const labels = {
    ...readStringRecord(environment.WORKER_LABELS_JSON, "WORKER_LABELS_JSON"),
    execution: executionEnabled ? "enabled" : "disabled",
    processHost: execution === undefined ? "unavailable" : "available",
  };
  assertStringRecordBounds(labels, "Worker capability labels");

  return {
    serverUrl,
    protocolVersion: readProtocolVersion(environment.WORKER_PROTOCOL_VERSION),
    workerNodeId: authentication.workerNodeId,
    workerToken: authentication.token,
    displayName,
    workerVersion,
    maxSlots,
    dataDirectory,
    executionEnabled,
    ...(execution === undefined ? {} : { execution }),
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
    shutdownGraceSeconds,
    requestTimeoutSeconds: readInteger(environment, "WORKER_REQUEST_TIMEOUT_SECONDS", 30, 5, 300),
    logLevel,
    capabilities: {
      operatingSystem: "windows",
      architecture: readArchitecture(process.arch),
      headless: true,
      interactiveDesktop: false,
      codexVersion: execution?.codexVersion ?? "not-configured",
      recipeIds: [],
      labels,
    },
    allowInsecureHttp,
    ...(serverUrl.protocol === "https:"
      ? { tls: loadTlsConfig(environment, dependencies.secretFileSystem ?? systemSecretFileSystem) }
      : {}),
  };
}

function loadExecutionConfig(
  environment: NodeJS.ProcessEnv,
  dataDirectory: string,
  maxSlots: number,
): WorkerExecutionConfig {
  const trustedExecutableRoot = readRequiredWindowsPath(
    environment,
    "WORKER_TRUSTED_EXECUTABLE_ROOT",
    "directory",
  );
  assertNotFileSystemRoot(trustedExecutableRoot, "WORKER_TRUSTED_EXECUTABLE_ROOT");
  const processHostPath = readRequiredWindowsPath(
    environment,
    "WORKER_PROCESS_HOST_PATH",
    "executable",
  );
  const codexExecutablePath = readRequiredWindowsPath(
    environment,
    "WORKER_CODEX_EXECUTABLE_PATH",
    "executable",
  );
  const gitExecutablePath = readRequiredWindowsPath(
    environment,
    "WORKER_GIT_EXECUTABLE_PATH",
    "executable",
  );
  assertStrictDescendant(trustedExecutableRoot, processHostPath, "WORKER_PROCESS_HOST_PATH");
  assertStrictDescendant(
    trustedExecutableRoot,
    codexExecutablePath,
    "WORKER_CODEX_EXECUTABLE_PATH",
  );
  assertStrictDescendant(trustedExecutableRoot, gitExecutablePath, "WORKER_GIT_EXECUTABLE_PATH");
  assertPairwiseDisjoint(
    [processHostPath, "WORKER_PROCESS_HOST_PATH"],
    [codexExecutablePath, "WORKER_CODEX_EXECUTABLE_PATH"],
    [gitExecutablePath, "WORKER_GIT_EXECUTABLE_PATH"],
  );

  const workspaceRootDirectory = readRequiredWindowsPath(
    environment,
    "WORKER_WORKSPACE_ROOT_DIRECTORY",
    "directory",
  );
  assertNotFileSystemRoot(workspaceRootDirectory, "WORKER_WORKSPACE_ROOT_DIRECTORY");
  const tempDirectory = readRequiredWindowsPath(
    environment,
    "WORKER_EXECUTION_TEMP_DIRECTORY",
    "directory",
  );
  assertNotFileSystemRoot(tempDirectory, "WORKER_EXECUTION_TEMP_DIRECTORY");
  const profileDirectory = readRequiredWindowsPath(
    environment,
    "WORKER_EXECUTION_PROFILE_DIRECTORY",
    "directory",
  );
  assertNotFileSystemRoot(profileDirectory, "WORKER_EXECUTION_PROFILE_DIRECTORY");
  assertDisjoint(trustedExecutableRoot, dataDirectory, "trusted executable root", "data root");
  assertStrictDescendant(dataDirectory, workspaceRootDirectory, "WORKER_WORKSPACE_ROOT_DIRECTORY");
  assertStrictDescendant(dataDirectory, tempDirectory, "WORKER_EXECUTION_TEMP_DIRECTORY");
  assertStrictDescendant(dataDirectory, profileDirectory, "WORKER_EXECUTION_PROFILE_DIRECTORY");
  assertPairwiseDisjoint(
    [workspaceRootDirectory, "WORKER_WORKSPACE_ROOT_DIRECTORY"],
    [tempDirectory, "WORKER_EXECUTION_TEMP_DIRECTORY"],
    [profileDirectory, "WORKER_EXECUTION_PROFILE_DIRECTORY"],
  );

  const codexVersion = readRequiredExact(environment, "WORKER_CODEX_VERSION");
  assertWellFormedUnicode(codexVersion, "WORKER_CODEX_VERSION");
  if (codexVersion.length > 128 || codexVersion.toLowerCase() === "not-configured") {
    throw new Error("WORKER_CODEX_VERSION must identify the installed pinned Codex version.");
  }

  const codexResourceLimits = readResourceLimits(environment, "WORKER_CODEX", {
    maximumProcessCount: 32,
    maximumMemoryBytes: 8 * gibibyte,
    maximumOutputBytes: 8 * mebibyte,
  });
  const gitResourceLimits = readResourceLimits(environment, "WORKER_GIT", {
    maximumProcessCount: 8,
    maximumMemoryBytes: 2 * gibibyte,
    maximumOutputBytes: 4 * mebibyte,
  });
  const totalResourceBudget = readTotalResourceBudget(environment);
  assertAggregateResourceBudget(maxSlots, codexResourceLimits, totalResourceBudget, "Codex");
  assertAggregateResourceBudget(maxSlots, gitResourceLimits, totalResourceBudget, "Git");
  const processHostRequestTimeoutMs = readInteger(
    environment,
    "WORKER_PROCESS_HOST_REQUEST_TIMEOUT_MS",
    15_000,
    1_000,
    300_000,
  );
  const processHostStartTimeoutMs = readInteger(
    environment,
    "WORKER_PROCESS_HOST_START_TIMEOUT_MS",
    30_000,
    1_000,
    300_000,
  );
  const processHostShutdownTimeoutMs = readInteger(
    environment,
    "WORKER_PROCESS_HOST_SHUTDOWN_TIMEOUT_MS",
    15_000,
    1_000,
    300_000,
  );
  const perAttemptDiskBytes = readInteger(
    environment,
    "WORKER_EXECUTION_PER_ATTEMPT_DISK_BYTES",
    16 * gibibyte,
    512 * mebibyte,
    maximumPerAttemptDiskBytes,
  );
  const totalWorkspaceDiskBytes = readInteger(
    environment,
    "WORKER_EXECUTION_TOTAL_WORKSPACE_DISK_BYTES",
    32 * gibibyte,
    512 * mebibyte,
    maximumTotalWorkspaceDiskBytes,
  );
  assertProductWithinBudget(
    maxSlots,
    perAttemptDiskBytes,
    totalWorkspaceDiskBytes,
    "Per-attempt disk",
  );
  const minimumFreeDiskBytes = readInteger(
    environment,
    "WORKER_EXECUTION_MINIMUM_FREE_DISK_BYTES",
    10 * gibibyte,
    gibibyte,
    maximumPerAttemptDiskBytes,
  );
  const orphanRetentionHours = readInteger(
    environment,
    "WORKER_EXECUTION_ORPHAN_RETENTION_HOURS",
    24,
    1,
    24 * 30,
  );
  const orphanScanLimit = readInteger(
    environment,
    "WORKER_EXECUTION_ORPHAN_SCAN_LIMIT",
    100,
    1,
    10_000,
  );

  return {
    trustedExecutableRoot,
    processHostPath,
    processHostSha256: readSha256(environment, "WORKER_PROCESS_HOST_SHA256"),
    codexExecutablePath,
    codexSha256: readSha256(environment, "WORKER_CODEX_SHA256"),
    codexVersion,
    gitExecutablePath,
    gitSha256: readSha256(environment, "WORKER_GIT_SHA256"),
    workspaceRootDirectory,
    tempDirectory,
    profileDirectory,
    processHostRequestTimeoutMs,
    processHostStartTimeoutMs,
    processHostShutdownTimeoutMs,
    codexMaximumHardTimeoutMs: readInteger(
      environment,
      "WORKER_CODEX_MAXIMUM_HARD_TIMEOUT_MS",
      60 * 60 * 1_000,
      processHostResourceBounds.hardTimeoutMs.minimum,
      processHostResourceBounds.hardTimeoutMs.maximum,
    ),
    gitHardTimeoutMs: readInteger(
      environment,
      "WORKER_GIT_HARD_TIMEOUT_MS",
      10 * 60 * 1_000,
      processHostResourceBounds.hardTimeoutMs.minimum,
      processHostResourceBounds.hardTimeoutMs.maximum,
    ),
    codexResourceLimits,
    gitResourceLimits,
    totalResourceBudget,
    perAttemptDiskBytes,
    totalWorkspaceDiskBytes,
    minimumFreeDiskBytes,
    orphanRetentionHours,
    orphanScanLimit,
  };
}

function readResourceLimits(
  environment: NodeJS.ProcessEnv,
  prefix: "WORKER_CODEX" | "WORKER_GIT",
  defaults: WorkerExecutionResourceLimits,
): WorkerExecutionResourceLimits {
  return {
    maximumProcessCount: readInteger(
      environment,
      `${prefix}_MAX_PROCESSES`,
      defaults.maximumProcessCount,
      processHostResourceBounds.maximumProcessCount.minimum,
      processHostResourceBounds.maximumProcessCount.maximum,
    ),
    maximumMemoryBytes: readInteger(
      environment,
      `${prefix}_MAX_MEMORY_BYTES`,
      defaults.maximumMemoryBytes,
      processHostResourceBounds.maximumMemoryBytes.minimum,
      processHostResourceBounds.maximumMemoryBytes.maximum,
    ),
    maximumOutputBytes: readInteger(
      environment,
      `${prefix}_MAX_OUTPUT_BYTES`,
      defaults.maximumOutputBytes,
      processHostResourceBounds.maximumOutputBytes.minimum,
      processHostResourceBounds.maximumOutputBytes.maximum,
    ),
  };
}

function readTotalResourceBudget(environment: NodeJS.ProcessEnv): WorkerExecutionResourceLimits {
  return {
    maximumProcessCount: readInteger(
      environment,
      "WORKER_EXECUTION_TOTAL_MAX_PROCESSES",
      64,
      1,
      maximumTotalProcessCount,
    ),
    maximumMemoryBytes: readInteger(
      environment,
      "WORKER_EXECUTION_TOTAL_MAX_MEMORY_BYTES",
      16 * gibibyte,
      1,
      maximumTotalMemoryBytes,
    ),
    maximumOutputBytes: readInteger(
      environment,
      "WORKER_EXECUTION_TOTAL_MAX_OUTPUT_BYTES",
      64 * mebibyte,
      1,
      maximumTotalOutputBytes,
    ),
  };
}

function assertAggregateResourceBudget(
  maxSlots: number,
  perTask: WorkerExecutionResourceLimits,
  total: WorkerExecutionResourceLimits,
  workload: string,
): void {
  assertProductWithinBudget(
    maxSlots,
    perTask.maximumProcessCount,
    total.maximumProcessCount,
    `${workload} process count`,
  );
  assertProductWithinBudget(
    maxSlots,
    perTask.maximumMemoryBytes,
    total.maximumMemoryBytes,
    `${workload} memory`,
  );
  assertProductWithinBudget(
    maxSlots,
    perTask.maximumOutputBytes,
    total.maximumOutputBytes,
    `${workload} output`,
  );
}

function assertProductWithinBudget(
  maxSlots: number,
  perTaskValue: number,
  totalValue: number,
  resource: string,
): void {
  if (perTaskValue > Math.floor(totalValue / maxSlots)) {
    throw new Error(
      `${resource} multiplied by WORKER_MAX_SLOTS exceeds its Worker execution total budget.`,
    );
  }
}

function loadTlsConfig(
  environment: NodeJS.ProcessEnv,
  secretFileSystem: SecretFileSystem,
): TlsClientConfig {
  const caPath = readOptionalWindowsPath(environment, "WORKER_TLS_CA_PATH");

  return {
    ...(caPath === undefined
      ? {}
      : {
          ca: readSecretFile(caPath, "WORKER_TLS_CA_PATH", maximumTlsCaBytes, secretFileSystem),
        }),
    ...(environment.WORKER_TLS_SERVER_NAME === undefined
      ? {}
      : { serverName: environment.WORKER_TLS_SERVER_NAME }),
    rejectUnauthorized: true,
  };
}

function loadWorkerAuthentication(
  readFile: (path: string) => Buffer,
): Readonly<{ token: string; workerNodeId: string }> {
  try {
    const bytes = readFile(workerAuthProfilePath);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumWorkerAuthProfileBytes
    ) {
      throw new Error("Worker authentication profile size is invalid.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Worker authentication profile must be an object.");
    }

    const profile = value as Record<string, unknown>;
    const keys = Object.keys(profile).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "profileId" ||
      keys[1] !== "token" ||
      keys[2] !== "workerNodeId" ||
      profile.profileId !== workerAuthProfileId ||
      typeof profile.token !== "string" ||
      !workerTokenPattern.test(profile.token) ||
      typeof profile.workerNodeId !== "string"
    ) {
      throw new Error("Worker authentication profile is invalid.");
    }

    const workerNodeId = validateIdentifier(profile.workerNodeId, "workerNodeId");
    const canonicalText = JSON.stringify({
      profileId: workerAuthProfileId,
      token: profile.token,
      workerNodeId,
    });
    if (text !== canonicalText) {
      throw new Error("Worker authentication profile is not canonical.");
    }

    return {
      token: profile.token,
      workerNodeId,
    };
  } catch {
    throw new Error("Unable to load Worker authentication profile.");
  }
}

function readSecretFile(
  path: string,
  name: string,
  maximumBytes: number,
  fileSystem: SecretFileSystem,
): Buffer {
  let descriptor: number | undefined;
  let secret: Buffer | undefined;
  let failed = false;

  try {
    const pathMetadata = fileSystem.lstat(path);
    assertSecretFileMetadata(pathMetadata, maximumBytes);
    assertSecretRealPath(path, fileSystem.realpath(path), name);

    descriptor = fileSystem.open(path);
    const openedMetadata = fileSystem.fstat(descriptor);
    assertSecretFileMetadata(openedMetadata, maximumBytes);
    assertSameSecretFile(pathMetadata, openedMetadata);

    const size = Number(openedMetadata.size);
    secret = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = fileSystem.read(descriptor, secret, offset, size - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > size - offset) {
        throw new Error("Secret file returned an invalid or short read.");
      }
      offset += bytesRead;
    }

    const finalOpenedMetadata = fileSystem.fstat(descriptor);
    const finalPathMetadata = fileSystem.lstat(path);
    assertSameSecretFile(openedMetadata, finalOpenedMetadata);
    assertSameSecretFile(openedMetadata, finalPathMetadata);
    assertSecretRealPath(path, fileSystem.realpath(path), name);
  } catch {
    failed = true;
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.close(descriptor);
      } catch {
        failed = true;
      }
    }
  }

  if (failed || secret === undefined) {
    secret?.fill(0);
    throw new Error(`Unable to securely read ${name}.`);
  }
  return secret;
}

function assertSecretFileMetadata(metadata: StableSecretFileMetadata, maximumBytes: number): void {
  if (
    !metadata.isFile ||
    metadata.isSymbolicLink ||
    metadata.device < 0n ||
    metadata.inode <= 0n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes) ||
    metadata.mode <= 0n ||
    (metadata.mode & fileTypeModeMask) !== regularFileMode ||
    metadata.linkCount !== 1n ||
    metadata.modifiedTimeNanoseconds < 0n ||
    metadata.changedTimeNanoseconds < 0n
  ) {
    throw new Error("TLS material must be a bounded regular file.");
  }
}

function assertSameSecretFile(
  expected: StableSecretFileMetadata,
  actual: StableSecretFileMetadata,
): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.size !== actual.size ||
    expected.mode !== actual.mode ||
    expected.linkCount !== actual.linkCount ||
    expected.modifiedTimeNanoseconds !== actual.modifiedTimeNanoseconds ||
    expected.changedTimeNanoseconds !== actual.changedTimeNanoseconds ||
    expected.isFile !== actual.isFile ||
    expected.isSymbolicLink !== actual.isSymbolicLink
  ) {
    throw new Error("TLS material changed while it was being read.");
  }
}

function assertSecretRealPath(configuredPath: string, realPath: string, name: string): void {
  const normalizedRealPath = readWindowsPath(realPath, name, "file");
  if (!windowsPathsEqual(configuredPath, normalizedRealPath)) {
    throw new Error("TLS material must be configured using its canonical path.");
  }
}

function toStableSecretFileMetadata(metadata: BigIntStats): StableSecretFileMetadata {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    mode: metadata.mode,
    linkCount: metadata.nlink,
    modifiedTimeNanoseconds: metadata.mtimeNs,
    changedTimeNanoseconds: metadata.ctimeNs,
    isFile: metadata.isFile(),
    isSymbolicLink: metadata.isSymbolicLink(),
  };
}

const systemSecretFileSystem: SecretFileSystem = {
  lstat: (path) => toStableSecretFileMetadata(lstatSync(path, { bigint: true })),
  realpath: (path) => realpathSync.native(path),
  open: (path) => openSync(path, fileSystemConstants.O_RDONLY),
  fstat: (descriptor) => toStableSecretFileMetadata(fstatSync(descriptor, { bigint: true })),
  read: (descriptor, buffer, offset, length, position) =>
    readSync(descriptor, buffer, offset, length, position),
  close: (descriptor) => closeSync(descriptor),
};

const systemWorkerAuthFileReader = (path: string): Buffer => readFileSync(path);

function readRequired(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function isExplicitLoopbackOrigin(value: string): boolean {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/iu.test(value);
}

function readDisplayName(value: string): string {
  assertWellFormedUnicode(value, "WORKER_DISPLAY_NAME");
  if (
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    hasHttpControlCharacter(value)
  ) {
    throw new Error(
      "WORKER_DISPLAY_NAME must contain 1 through 128 characters without surrounding whitespace or control characters.",
    );
  }
  return value;
}

function readWorkerVersion(value: string): string {
  assertWellFormedUnicode(value, "WORKER_VERSION");
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(value)) {
    throw new Error(
      "WORKER_VERSION must contain 1 through 128 HTTP token characters for the User-Agent header.",
    );
  }
  return value;
}

function readRequiredExact(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  if (value !== value.trim() || value.includes("\0")) {
    throw new Error(`${name} must not contain surrounding whitespace or NUL characters.`);
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

  const entries = Object.entries(parsed);
  if (entries.length > 64) {
    throw new Error(`${name} must contain at most 64 entries.`);
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of entries) {
    if (typeof entry !== "string" || key.trim() === "" || entry.trim() === "") {
      throw new Error(`${name} keys and values must be non-empty strings.`);
    }
    result[key] = entry;
  }
  assertStringRecordBounds(result, name);
  return result;
}

function assertStringRecordBounds(value: Readonly<Record<string, string>>, name: string): void {
  const entries = Object.entries(value);
  if (entries.length > 64) {
    throw new Error(`${name} must contain at most 64 entries.`);
  }
  for (const [key, entry] of entries) {
    assertWellFormedUnicode(key, `${name} key`);
    assertWellFormedUnicode(entry, `${name}.${key}`);
    if (
      key.length === 0 ||
      key.length > 64 ||
      entry.length > 256 ||
      hasHttpControlCharacter(key) ||
      hasHttpControlCharacter(entry)
    ) {
      throw new Error(
        `${name} keys must contain 1 through 64 characters and values must not exceed 256 characters or contain control characters.`,
      );
    }
  }
}

function hasHttpControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function readSha256(environment: NodeJS.ProcessEnv, name: string): string {
  const value = readRequiredExact(environment, name);
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be exactly 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function readRequiredWindowsPath(
  environment: NodeJS.ProcessEnv,
  name: string,
  kind: "directory" | "executable",
): string {
  return readWindowsPath(readRequiredExact(environment, name), name, kind);
}

function readOptionalWindowsPath(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  return readWindowsPath(readRequiredExact(environment, name), name, "file");
}

function readWindowsPath(
  value: string,
  name: string,
  kind: "directory" | "executable" | "file",
): string {
  assertWellFormedUnicode(value, name);
  if (value.length > maximumWindowsPathLength) {
    throw new Error(`${name} exceeds the Windows extended path limit.`);
  }
  if (
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    value.startsWith("\\??\\") ||
    !/^[A-Za-z]:[\\/]/u.test(value) ||
    !win32.isAbsolute(value)
  ) {
    throw new Error(`${name} must be an absolute local Windows drive path.`);
  }
  if (value.slice(2).includes(":")) {
    throw new Error(`${name} must not contain an alternate data stream.`);
  }

  for (const component of value.slice(3).split(/[\\/]/u)) {
    if (component.length === 0) {
      continue;
    }
    assertSafeWindowsPathComponent(component, name);
  }

  let normalized = win32.normalize(value.replaceAll("/", "\\"));
  normalized = `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
  if (normalized.length > 3 && normalized.endsWith("\\")) {
    normalized = normalized.slice(0, -1);
  }
  if (kind === "executable" && win32.extname(normalized).toLowerCase() !== ".exe") {
    throw new Error(`${name} must identify a Windows .exe file.`);
  }
  return normalized;
}

function assertSafeWindowsPathComponent(component: string, name: string): void {
  if (
    component === "." ||
    component === ".." ||
    component.endsWith(".") ||
    component.endsWith(" ") ||
    /[<>:"|?*]/u.test(component) ||
    [...component].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) {
    throw new Error(`${name} contains an unsafe Windows path component.`);
  }

  const baseName = component.split(".", 1)[0]?.toUpperCase() ?? "";
  if (
    baseName === "CON" ||
    baseName === "PRN" ||
    baseName === "AUX" ||
    baseName === "NUL" ||
    baseName === "CONIN$" ||
    baseName === "CONOUT$" ||
    baseName === "CLOCK$" ||
    /^COM[1-9]$/u.test(baseName) ||
    /^LPT[1-9]$/u.test(baseName) ||
    /^(?:COM|LPT)[\u00b9\u00b2\u00b3]$/u.test(baseName)
  ) {
    throw new Error(`${name} contains a reserved Windows device name.`);
  }
}

function assertNotFileSystemRoot(path: string, name: string): void {
  if (path.length === 3 && /^[A-Z]:\\$/u.test(path)) {
    throw new Error(`${name} must not be a filesystem root.`);
  }
}

function assertStrictDescendant(root: string, candidate: string, candidateName: string): void {
  if (windowsPathsEqual(root, candidate) || !isSameOrDescendant(root, candidate)) {
    throw new Error(`${candidateName} must be contained beneath ${root}.`);
  }
}

function assertDisjoint(
  first: string,
  second: string,
  firstName: string,
  secondName: string,
): void {
  if (isSameOrDescendant(first, second) || isSameOrDescendant(second, first)) {
    throw new Error(`${firstName} and ${secondName} must not overlap.`);
  }
}

function assertPairwiseDisjoint(
  ...entries: ReadonlyArray<readonly [path: string, name: string]>
): void {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const right = entries[rightIndex];
      if (right !== undefined) {
        assertDisjoint(left[0], right[0], left[1], right[1]);
      }
    }
  }
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const foldedRoot = root.toLowerCase();
  const foldedCandidate = candidate.toLowerCase();
  const prefix = foldedRoot.endsWith("\\") ? foldedRoot : `${foldedRoot}\\`;
  return foldedCandidate === foldedRoot || foldedCandidate.startsWith(prefix);
}

function windowsPathsEqual(first: string, second: string): boolean {
  return first.toLowerCase() === second.toLowerCase();
}

function assertWellFormedUnicode(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${name} must contain well-formed Unicode.`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${name} must contain well-formed Unicode.`);
    }
  }
}

function validateIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
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
