import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { TextDecoder } from "node:util";
import { assertWindowsLocalAbsolutePath } from "./process-host-protocol.js";

const maximumRegistryEntries = 128;
const maximumRegistryBytes = 64 * 1_024;
const maximumBinaryBytes = 1_024 ** 3;
const maximumSecretBytes = 64 * 1_024;
const maximumSecretCharacters = 32_767;
const readChunkBytes = 64 * 1_024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const aliasPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const secretReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const validationSettings = new Set([
  "WORKER_VALIDATION_HEADLESS_ENABLED",
  "WORKER_VALIDATION_WEB_ENABLED",
  "WORKER_VALIDATION_WEB_BROWSER_EXECUTABLE_PATH",
  "WORKER_VALIDATION_WINDOWS_ENABLED",
  "WORKER_VALIDATION_DESKTOP_LOCK_DIRECTORY",
  "WORKER_VALIDATION_CLEANUP_TIMEOUT_MS",
  "WORKER_VALIDATION_SUMMARY_ENABLED",
  "WORKER_VALIDATION_SUMMARY_TIMEOUT_MS",
  "WORKER_VALIDATION_COMMANDS_JSON",
  "WORKER_VALIDATION_SECRET_FILES_JSON",
]);

export interface ValidationExecutableRegistration {
  readonly name: string;
  readonly path: string;
  readonly sha256?: string;
}

export interface ValidationRuntimeTrustedDefaults {
  readonly executionEnabled: boolean;
  readonly maxSlots: number;
  readonly bundleDirectory: string;
  /** Explicitly supplied by Worker startup; never discovered through a task's PATH. */
  readonly executables: readonly ValidationExecutableRegistration[];
  readonly untrustedDirectories?: readonly string[];
}

export interface ValidationRuntimeConfig {
  readonly headlessEnabled: boolean;
  readonly cleanupTimeoutMs: number;
  readonly summary?: { readonly maximumTimeoutMs: number };
  readonly bundleDirectory: string;
  readonly untrustedDirectories: readonly string[];
  readonly executables: readonly (ValidationExecutableRegistration & {
    readonly allowHardLinks: boolean;
  })[];
  /** Deployment must protect these files with Windows ACLs; values never enter configuration. */
  readonly secretFiles: Readonly<Record<string, string>>;
  readonly web?: {
    readonly browserExecutablePath: string;
    readonly nodeExecutablePath: string;
    readonly driverEntryPath: string;
    readonly powerShellExecutablePath: string;
    readonly windowsProbeEntryPath: string;
  };
  readonly windows?: {
    readonly powerShellExecutablePath: string;
    readonly driverEntryPath: string;
    readonly desktopLockDirectory: string;
  };
}

export type ValidationRuntimeErrorCode =
  | "CONFIG_INVALID"
  | "RUNTIME_UNAVAILABLE"
  | "EXECUTABLE_UNAVAILABLE"
  | "SECRET_UNAVAILABLE"
  | "CANCELLED";

export class ValidationRuntimeConfigurationError extends Error {
  public constructor(
    public readonly code: ValidationRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ValidationRuntimeConfigurationError";
  }
}

function invalid(message: string): never {
  throw new ValidationRuntimeConfigurationError("CONFIG_INVALID", message);
}

function safePath(value: unknown, executable: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    invalid("Validation paths must be exact local absolute Windows paths.");
  }
  try {
    assertWindowsLocalAbsolutePath(value, "Validation path", executable);
  } catch {
    invalid("Validation paths must be safe local absolute Windows paths.");
  }
  if (
    value
      .slice(3)
      .split(/[\\/]/u)
      .some((component) => /^(?:COM|LPT)[\u00b9\u00b2\u00b3](?:\.|$)/iu.test(component))
  ) {
    invalid("Validation paths must not contain reserved Windows device names.");
  }
  const normalized = win32.normalize(value).replace(/\\$/u, "");
  if (/^[A-Za-z]:$/u.test(normalized)) invalid("Validation paths must not be filesystem roots.");
  return normalized;
}

function samePath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function contained(root: string, candidate: string): boolean {
  const relative = win32.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative))
  );
}

function outsideUntrusted(path: string, directories: readonly string[]): void {
  if (directories.some((directory) => contained(directory, path))) {
    invalid("Validation trusted paths must be outside mutable execution directories.");
  }
}

function booleanSetting(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  invalid(`${name} must be true, false, 1, or 0.`);
}

function jsonSetting(environment: NodeJS.ProcessEnv, name: string, fallback: unknown): unknown {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (Buffer.byteLength(value, "utf8") > maximumRegistryBytes) {
    invalid(`${name} exceeds the configuration size limit.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    invalid(`${name} must contain valid JSON.`);
  }
}

function readRegistrations(value: unknown): ValidationExecutableRegistration[] {
  if (!Array.isArray(value) || value.length > maximumRegistryEntries) {
    invalid("Validation command registrations must be a bounded array.");
  }
  return value.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !["name", "path", "sha256"].includes(key))
    ) {
      invalid("Validation command registration fields are invalid.");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !aliasPattern.test(record.name)) {
      invalid("Validation command aliases must contain 1 through 64 safe characters.");
    }
    if (
      record.sha256 !== undefined &&
      (typeof record.sha256 !== "string" || !sha256Pattern.test(record.sha256))
    ) {
      invalid("Validation command SHA-256 pins must use 64 lowercase hexadecimal characters.");
    }
    return {
      name: record.name.toLowerCase(),
      path: safePath(record.path, true),
      ...(record.sha256 === undefined ? {} : { sha256: record.sha256 as string }),
    };
  });
}

/** Parses deployment configuration without opening files or probing application readiness. */
export function loadValidationRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  trustedDefaults: ValidationRuntimeTrustedDefaults,
): ValidationRuntimeConfig {
  if (
    typeof trustedDefaults.executionEnabled !== "boolean" ||
    !Number.isSafeInteger(trustedDefaults.maxSlots) ||
    trustedDefaults.maxSlots < 1 ||
    trustedDefaults.maxSlots > 64
  ) {
    invalid("Validation runtime requires valid execution and slot settings.");
  }
  if (
    Object.keys(environment).some(
      (name) => name.startsWith("WORKER_VALIDATION_") && !validationSettings.has(name),
    )
  ) {
    invalid("Validation runtime configuration contains an unsupported setting.");
  }
  const headlessEnabled = booleanSetting(
    environment,
    "WORKER_VALIDATION_HEADLESS_ENABLED",
    trustedDefaults.executionEnabled,
  );
  const webEnabled = booleanSetting(environment, "WORKER_VALIDATION_WEB_ENABLED", false);
  const windowsEnabled = booleanSetting(environment, "WORKER_VALIDATION_WINDOWS_ENABLED", false);
  const summaryEnabled = booleanSetting(environment, "WORKER_VALIDATION_SUMMARY_ENABLED", false);
  if (
    !trustedDefaults.executionEnabled &&
    (headlessEnabled || webEnabled || windowsEnabled || summaryEnabled)
  ) {
    invalid("Validation runners require WORKER_EXECUTION_ENABLED=true.");
  }
  if (summaryEnabled && !headlessEnabled && !webEnabled && !windowsEnabled)
    invalid("Validation summaries require at least one enabled validation runner.");
  if (windowsEnabled && trustedDefaults.maxSlots !== 1) {
    invalid("Windows validation requires WORKER_MAX_SLOTS=1.");
  }
  const cleanupText = environment.WORKER_VALIDATION_CLEANUP_TIMEOUT_MS ?? "30000";
  const cleanupTimeoutMs = Number(cleanupText);
  if (
    !/^[1-9][0-9]*$/u.test(cleanupText) ||
    !Number.isSafeInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs < 1_000 ||
    cleanupTimeoutMs > 300_000
  ) {
    invalid("WORKER_VALIDATION_CLEANUP_TIMEOUT_MS must be an integer from 1000 through 300000.");
  }
  const summaryTimeoutText = environment.WORKER_VALIDATION_SUMMARY_TIMEOUT_MS ?? "150000";
  const summaryTimeoutMs = Number(summaryTimeoutText);
  if (
    !/^[1-9][0-9]*$/u.test(summaryTimeoutText) ||
    !Number.isSafeInteger(summaryTimeoutMs) ||
    summaryTimeoutMs < 10_000 ||
    summaryTimeoutMs > 300_000
  ) {
    invalid("WORKER_VALIDATION_SUMMARY_TIMEOUT_MS must be an integer from 10000 through 300000.");
  }
  const bundleDirectory = safePath(trustedDefaults.bundleDirectory, false);
  const untrustedDirectories = Object.freeze(
    (trustedDefaults.untrustedDirectories ?? []).map((directory) => safePath(directory, false)),
  );
  outsideUntrusted(bundleDirectory, untrustedDirectories);
  const customRegistrations = readRegistrations(
    jsonSetting(environment, "WORKER_VALIDATION_COMMANDS_JSON", []),
  );
  if (
    customRegistrations.some((entry) => /^(?:git|node|powershell|cmd)(?:\.exe)?$/u.test(entry.name))
  ) {
    invalid("Validation command configuration must not replace system aliases.");
  }
  const registrations = [
    ...readRegistrations(trustedDefaults.executables).map((entry) => ({
      ...entry,
      allowHardLinks: true,
    })),
    ...customRegistrations.map((entry) => ({ ...entry, allowHardLinks: false })),
  ];
  if (registrations.length > maximumRegistryEntries)
    invalid("Validation command registry is too large.");
  const names = new Set<string>();
  for (const registration of registrations) {
    if (names.has(registration.name))
      invalid("Validation aliases must be unique and must not replace trusted defaults.");
    names.add(registration.name);
    outsideUntrusted(registration.path, untrustedDirectories);
  }
  const executables = Object.freeze(
    registrations.map((registration) => Object.freeze(registration)),
  );
  const secretValue = jsonSetting(environment, "WORKER_VALIDATION_SECRET_FILES_JSON", {});
  if (
    typeof secretValue !== "object" ||
    secretValue === null ||
    Array.isArray(secretValue) ||
    Object.keys(secretValue).length > maximumRegistryEntries
  ) {
    invalid("Validation secret files must be a bounded reference-to-path object.");
  }
  const secretFiles: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [reference, path] of Object.entries(secretValue)) {
    if (
      !secretReferencePattern.test(reference) ||
      ["__proto__", "prototype", "constructor"].includes(reference)
    ) {
      invalid("Validation secret references are invalid.");
    }
    secretFiles[reference] = safePath(path, false);
    outsideUntrusted(secretFiles[reference], untrustedDirectories);
  }
  const browserPath = environment.WORKER_VALIDATION_WEB_BROWSER_EXECUTABLE_PATH;
  const desktopPath = environment.WORKER_VALIDATION_DESKTOP_LOCK_DIRECTORY;
  if (!webEnabled && browserPath !== undefined)
    invalid("A validation browser path requires WORKER_VALIDATION_WEB_ENABLED=true.");
  if (!windowsEnabled && desktopPath !== undefined)
    invalid("A desktop lock directory requires WORKER_VALIDATION_WINDOWS_ENABLED=true.");
  const requiredExecutable = (name: string): string => {
    const entry = executables.find((registration) => registration.name === name);
    if (entry === undefined) invalid(`Validation runtime requires the trusted ${name} alias.`);
    return entry.path;
  };
  const web = webEnabled
    ? {
        browserExecutablePath: safePath(browserPath, true),
        nodeExecutablePath: requiredExecutable("node"),
        driverEntryPath: win32.join(bundleDirectory, "web-driver.mjs"),
        powerShellExecutablePath: requiredExecutable("powershell"),
        windowsProbeEntryPath: win32.join(bundleDirectory, "windows-driver-entry.ps1"),
      }
    : undefined;
  const windows = windowsEnabled
    ? {
        powerShellExecutablePath: requiredExecutable("powershell"),
        driverEntryPath: win32.join(bundleDirectory, "windows-driver-entry.ps1"),
        desktopLockDirectory: safePath(desktopPath, false),
      }
    : undefined;
  if (web !== undefined) outsideUntrusted(web.browserExecutablePath, untrustedDirectories);
  if (windows !== undefined) outsideUntrusted(windows.desktopLockDirectory, untrustedDirectories);
  return Object.freeze({
    headlessEnabled,
    cleanupTimeoutMs,
    ...(summaryEnabled ? { summary: Object.freeze({ maximumTimeoutMs: summaryTimeoutMs }) } : {}),
    bundleDirectory,
    untrustedDirectories,
    executables,
    secretFiles: Object.freeze(secretFiles),
    ...(web === undefined ? {} : { web: Object.freeze(web) }),
    ...(windows === undefined ? {} : { windows: Object.freeze(windows) }),
  });
}

export interface ValidationRuntimeFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface ValidationRuntimeFileHandle {
  stat(): Promise<ValidationRuntimeFileStat>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface ValidationRuntimeFileSystem {
  lstat(path: string): Promise<ValidationRuntimeFileStat>;
  realpath(path: string): Promise<string>;
  open(path: string): Promise<ValidationRuntimeFileHandle>;
}

export interface ValidationRuntimeDependencies {
  readonly fileSystem?: ValidationRuntimeFileSystem;
}

const systemFileSystem: ValidationRuntimeFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
  open: async (path) => {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    return {
      stat: () => handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) => {
        const result = await handle.read(buffer, offset, length, position);
        return { bytesRead: result.bytesRead };
      },
      close: () => handle.close(),
    };
  },
};

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ValidationRuntimeConfigurationError(
      "CANCELLED",
      "Validation runtime preparation was cancelled.",
    );
}

function linked(state: ValidationRuntimeFileStat): boolean {
  return state.isSymbolicLink() || state.isReparsePoint?.() === true;
}

function stable(left: ValidationRuntimeFileStat, right: ValidationRuntimeFileStat): boolean {
  return ["dev", "ino", "size", "mode", "nlink", "mtimeNs", "ctimeNs"].every(
    (name) =>
      left[name as keyof ValidationRuntimeFileStat] ===
      right[name as keyof ValidationRuntimeFileStat],
  );
}

function sameIdentity(left: ValidationRuntimeFileStat, right: ValidationRuntimeFileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function directoryChain(
  fileSystem: ValidationRuntimeFileSystem,
  directory: string,
  signal?: AbortSignal,
): Promise<readonly { readonly path: string; readonly state: ValidationRuntimeFileStat }[]> {
  const chain: { path: string; state: ValidationRuntimeFileStat }[] = [];
  let current = directory;
  for (;;) {
    checkSignal(signal);
    const state = await fileSystem.lstat(current);
    if (
      !state.isDirectory() ||
      linked(state) ||
      state.dev < 0n ||
      state.ino <= 0n ||
      !samePath(await fileSystem.realpath(current), current)
    )
      throw new Error("Unsafe validation directory.");
    chain.push({ path: current, state });
    const parent = win32.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

async function recheckDirectories(
  fileSystem: ValidationRuntimeFileSystem,
  chain: readonly { readonly path: string; readonly state: ValidationRuntimeFileStat }[],
  signal?: AbortSignal,
): Promise<void> {
  for (const entry of chain) {
    checkSignal(signal);
    const state = await fileSystem.lstat(entry.path);
    if (
      !state.isDirectory() ||
      linked(state) ||
      !sameIdentity(state, entry.state) ||
      !samePath(await fileSystem.realpath(entry.path), entry.path)
    )
      throw new Error("Validation directory changed.");
  }
}

function regular(
  state: ValidationRuntimeFileStat,
  maximumBytes: number,
  singleLink: boolean,
): void {
  if (
    !state.isFile() ||
    linked(state) ||
    state.dev < 0n ||
    state.ino <= 0n ||
    state.size <= 0n ||
    state.size > BigInt(maximumBytes) ||
    state.nlink < 1n ||
    (singleLink && state.nlink !== 1n) ||
    (state.mode & 0o170000n) !== 0o100000n ||
    state.mtimeNs < 0n ||
    state.ctimeNs < 0n
  )
    throw new Error("Unsafe validation file.");
}

async function checkedFile(
  fileSystem: ValidationRuntimeFileSystem,
  path: string,
  options: { readonly singleLink: boolean; readonly secret?: boolean; readonly sha256?: string },
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  checkSignal(signal);
  const chain = await directoryChain(fileSystem, win32.dirname(path), signal);
  const initial = await fileSystem.lstat(path);
  const maximumBytes = options.secret ? maximumSecretBytes : maximumBinaryBytes;
  regular(initial, maximumBytes, options.singleLink);
  if (!samePath(await fileSystem.realpath(path), path))
    throw new Error("Redirected validation file.");
  let handle: ValidationRuntimeFileHandle | undefined;
  let secret: Buffer | undefined;
  try {
    checkSignal(signal);
    handle = await fileSystem.open(path);
    const opened = await handle.stat();
    regular(opened, maximumBytes, options.singleLink);
    if (!stable(initial, opened)) throw new Error("Validation file changed before opening.");
    const hash = options.sha256 === undefined ? undefined : createHash("sha256");
    if (options.secret || hash !== undefined) {
      const size = Number(opened.size);
      secret = options.secret ? Buffer.alloc(size) : undefined;
      const chunk = Buffer.alloc(Math.min(readChunkBytes, size));
      let position = 0;
      try {
        while (position < size) {
          checkSignal(signal);
          const requested = Math.min(chunk.length, size - position);
          const { bytesRead } = await handle.read(chunk, 0, requested, position);
          if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > requested)
            throw new Error("Validation file read was incomplete.");
          hash?.update(chunk.subarray(0, bytesRead));
          secret?.set(chunk.subarray(0, bytesRead), position);
          position += bytesRead;
        }
        const extra = Buffer.alloc(1);
        try {
          if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0)
            throw new Error("Validation file grew during reading.");
        } finally {
          extra.fill(0);
        }
      } finally {
        chunk.fill(0);
      }
    }
    checkSignal(signal);
    const finalOpened = await handle.stat();
    const finalNamed = await fileSystem.lstat(path);
    regular(finalOpened, maximumBytes, options.singleLink);
    regular(finalNamed, maximumBytes, options.singleLink);
    if (
      !stable(opened, finalOpened) ||
      !stable(opened, finalNamed) ||
      !samePath(await fileSystem.realpath(path), path)
    )
      throw new Error("Validation file identity changed.");
    await recheckDirectories(fileSystem, chain, signal);
    if (hash !== undefined && hash.digest("hex") !== options.sha256)
      throw new Error("Validation executable digest changed.");
    checkSignal(signal);
    await handle.close();
    handle = undefined;
    checkSignal(signal);
    return secret;
  } catch (error) {
    secret?.fill(0);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function safely<T>(
  code: Exclude<ValidationRuntimeErrorCode, "CONFIG_INVALID" | "CANCELLED">,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ValidationRuntimeConfigurationError && error.code === "CANCELLED")
      throw error;
    const message =
      code === "SECRET_UNAVAILABLE"
        ? "The validation secret could not be read securely."
        : code === "EXECUTABLE_UNAVAILABLE"
          ? "The validation executable could not be resolved securely."
          : "The configured validation runtime is unavailable or unsafe.";
    throw new ValidationRuntimeConfigurationError(code, message);
  }
}

/** Files must be installed with deployment ACLs; this check does not infer Windows ACLs from mode. */
export async function prepareValidationRuntime(
  config: ValidationRuntimeConfig,
  dependencies: ValidationRuntimeDependencies = {},
  signal?: AbortSignal,
): Promise<ValidationRuntimeConfig> {
  return safely("RUNTIME_UNAVAILABLE", async () => {
    checkSignal(signal);
    if (!config.headlessEnabled && config.web === undefined && config.windows === undefined)
      return config;
    const fileSystem = dependencies.fileSystem ?? systemFileSystem;
    for (const registration of config.executables) {
      await checkedFile(
        fileSystem,
        registration.path,
        {
          singleLink: !registration.allowHardLinks,
          ...(registration.sha256 === undefined ? {} : { sha256: registration.sha256 }),
        },
        signal,
      );
    }
    if (config.web !== undefined) {
      await checkedFile(fileSystem, config.web.browserExecutablePath, { singleLink: true }, signal);
      await checkedFile(fileSystem, config.web.driverEntryPath, { singleLink: true }, signal);
      await checkedFile(fileSystem, config.web.windowsProbeEntryPath, { singleLink: true }, signal);
      for (const name of [
        "package.json",
        "index.mjs",
        "index.js",
        "lib/bootstrap.js",
        "lib/coreBundle.js",
        "browsers.json",
      ]) {
        await checkedFile(
          fileSystem,
          win32.join(config.bundleDirectory, "node_modules", "playwright-core", name),
          { singleLink: true },
          signal,
        );
      }
    }
    if (config.windows !== undefined) {
      await checkedFile(fileSystem, config.windows.driverEntryPath, { singleLink: true }, signal);
      const chain = await directoryChain(fileSystem, config.windows.desktopLockDirectory, signal);
      await recheckDirectories(fileSystem, chain, signal);
    }
    checkSignal(signal);
    return config;
  });
}

export interface ValidationWorkspaceResolvers {
  resolveExecutable(name: string, signal: AbortSignal): Promise<string>;
  resolveSecret(reference: string, signal: AbortSignal): Promise<string>;
}

export function createValidationWorkspaceResolvers(
  config: ValidationRuntimeConfig,
  checkoutDirectory: string,
  dependencies: ValidationRuntimeDependencies = {},
): ValidationWorkspaceResolvers {
  const checkout = safePath(checkoutDirectory, false);
  const fileSystem = dependencies.fileSystem ?? systemFileSystem;
  const registrations = new Map(
    config.executables.map((registration) => [registration.name, registration]),
  );
  return Object.freeze({
    resolveExecutable: (name: string, signal: AbortSignal) =>
      safely("EXECUTABLE_UNAVAILABLE", async () => {
        checkSignal(signal);
        if (typeof name !== "string") throw new Error("Invalid executable.");
        if (name.startsWith("./")) {
          const relative = name.slice(2);
          if (
            relative.length === 0 ||
            relative.includes("\\") ||
            relative
              .split("/")
              .some((segment) => segment === "" || segment === "." || segment === "..")
          )
            throw new Error("Invalid generated executable.");
          const path = safePath(win32.join(checkout, relative), true);
          if (!contained(checkout, path) || samePath(checkout, path))
            throw new Error("Generated executable escaped its checkout.");
          await checkedFile(fileSystem, path, { singleLink: true }, signal);
          return path;
        }
        if (!aliasPattern.test(name)) throw new Error("Executable aliases are required.");
        const registration = registrations.get(name.toLowerCase());
        if (registration === undefined || contained(checkout, registration.path))
          throw new Error("Unregistered executable.");
        await checkedFile(
          fileSystem,
          registration.path,
          {
            singleLink: !registration.allowHardLinks,
            ...(registration.sha256 === undefined ? {} : { sha256: registration.sha256 }),
          },
          signal,
        );
        return registration.path;
      }),
    resolveSecret: (reference: string, signal: AbortSignal) =>
      safely("SECRET_UNAVAILABLE", async () => {
        checkSignal(signal);
        const path = Object.hasOwn(config.secretFiles, reference)
          ? config.secretFiles[reference]
          : undefined;
        if (path === undefined || contained(checkout, path))
          throw new Error("Unknown secret reference.");
        const bytes = await checkedFile(
          fileSystem,
          path,
          { singleLink: true, secret: true },
          signal,
        );
        try {
          if (bytes === undefined) throw new Error("Secret bytes were not read.");
          const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          if (
            value.length === 0 ||
            value.length > maximumSecretCharacters ||
            value.includes("\u0000") ||
            value.startsWith("\ufeff")
          )
            throw new Error("Secret text is invalid.");
          return value;
        } finally {
          bytes?.fill(0);
        }
      }),
  });
}
