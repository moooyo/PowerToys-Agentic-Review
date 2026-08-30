import { win32 } from "node:path";

export interface CodexProcessResourceLimits {
  readonly hardTimeoutMs: number;
  readonly maximumProcessCount: number;
  readonly maximumMemoryBytes: number;
  readonly maximumOutputBytes: number;
}

export const codexProcessResourceLimitBounds = Object.freeze({
  hardTimeoutMs: Object.freeze({ minimum: 10_000, maximum: 2 * 60 * 60 * 1_000 }),
  maximumProcessCount: Object.freeze({ minimum: 1, maximum: 256 }),
  maximumMemoryBytes: Object.freeze({
    minimum: 128 * 1024 * 1024,
    maximum: 64 * 1024 * 1024 * 1024,
  }),
  maximumOutputBytes: Object.freeze({ minimum: 4 * 1024, maximum: 128 * 1024 * 1024 }),
});

/**
 * Pure data compatible with the worker ProcessLaunchSpec contract.
 * `environmentMode` requires ProcessHost to replace, rather than inherit or merge,
 * the parent process environment.
 */
export interface CodexProcessLaunchSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environmentMode: "replace";
  readonly environment: Readonly<Record<string, string>>;
  readonly standardInput: string;
  readonly limits: CodexProcessResourceLimits;
}

export interface BuildReadOnlyCodexExecLaunchSpecOptions {
  readonly executable: string;
  readonly workingDirectory: string;
  readonly controlRootDirectory: string;
  readonly prompt: string;
  readonly outputSchemaPath: string;
  readonly outputLastMessagePath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly limits: CodexProcessResourceLimits;
}

const maximumPromptUtf8Bytes = 512 * 1024;
const maximumProcessHostFrameBytes = 1_048_576;
const maximumProcessHostRequestId = "R".repeat(128);
const maximumEnvironmentValueLength = 32_767;

const allowedEnvironmentNames = new Set([
  "APPDATA",
  "CODEX_HOME",
  "COMSPEC",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

const requiredEnvironmentNames = [
  "CODEX_HOME",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "USERPROFILE",
] as const;

const pathEnvironmentNames = new Set([
  "APPDATA",
  "CODEX_HOME",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

const sensitiveEnvironmentNameFragments = [
  "AUTHORIZATION",
  "CERT",
  "COOKIE",
  "CREDENTIAL",
  "KEY",
  "PASSWORD",
  "PFX",
  "SECRET",
  "TOKEN",
  "WORKER_TLS",
] as const;

export function buildReadOnlyCodexExecLaunchSpec(
  options: BuildReadOnlyCodexExecLaunchSpecOptions,
): CodexProcessLaunchSpec {
  const executable = normalizeLocalWindowsExecutable(options.executable, "executable");
  const workingDirectory = normalizeLocalWindowsDirectory(
    options.workingDirectory,
    "workingDirectory",
  );
  const controlRootDirectory = normalizeLocalWindowsDirectory(
    options.controlRootDirectory,
    "controlRootDirectory",
  );
  const outputSchemaPath = normalizeLocalWindowsJsonFile(
    options.outputSchemaPath,
    "outputSchemaPath",
  );
  const outputLastMessagePath = normalizeLocalWindowsJsonFile(
    options.outputLastMessagePath,
    "outputLastMessagePath",
  );

  assertDisjointDirectories(workingDirectory, controlRootDirectory);
  assertDescendantPath(controlRootDirectory, outputSchemaPath, "outputSchemaPath");
  assertDescendantPath(controlRootDirectory, outputLastMessagePath, "outputLastMessagePath");
  if (windowsPathsEqual(outputSchemaPath, outputLastMessagePath)) {
    throw new TypeError("outputSchemaPath and outputLastMessagePath must be different files");
  }
  if (isSameOrDescendant(workingDirectory, executable)) {
    throw new TypeError("executable must not be inside the untrusted workingDirectory");
  }

  assertPrompt(options.prompt);
  assertLimits(options.limits);
  const environment = copyMinimalEnvironment(options.environment, workingDirectory);
  const argumentsList = Object.freeze([
    "exec",
    "--json",
    "--color",
    "never",
    "--ask-for-approval",
    "never",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--output-schema",
    outputSchemaPath,
    "--output-last-message",
    outputLastMessagePath,
    "-",
  ]);

  const spec: CodexProcessLaunchSpec = Object.freeze({
    executable,
    arguments: argumentsList,
    workingDirectory,
    environmentMode: "replace",
    environment,
    standardInput: options.prompt,
    limits: Object.freeze({ ...options.limits }),
  });
  assertEncodableProcessHostStartFrame(spec);
  return spec;
}

function assertPrompt(prompt: string): void {
  assertNonEmptyText(prompt, "prompt");
  const utf8Bytes = Buffer.byteLength(prompt, "utf8");
  if (utf8Bytes > maximumPromptUtf8Bytes) {
    throw new RangeError(`prompt must not exceed ${maximumPromptUtf8Bytes} UTF-8 bytes`);
  }
}

function normalizeLocalWindowsExecutable(value: string, name: string): string {
  const path = normalizeLocalAbsoluteWindowsPath(value, name);
  if (win32.extname(path).toLowerCase() !== ".exe") {
    throw new TypeError(`${name} must identify a Windows .exe file`);
  }
  return path;
}

function normalizeLocalWindowsJsonFile(value: string, name: string): string {
  const path = normalizeLocalAbsoluteWindowsPath(value, name);
  if (win32.extname(path).toLowerCase() !== ".json") {
    throw new TypeError(`${name} must identify a .json file`);
  }
  return path;
}

function normalizeLocalWindowsDirectory(value: string, name: string): string {
  const path = normalizeLocalAbsoluteWindowsPath(value, name);
  if (path.length === 3) {
    return path;
  }
  return path.endsWith("\\") ? path.slice(0, -1) : path;
}

function normalizeLocalAbsoluteWindowsPath(value: string, name: string): string {
  assertNonEmptyText(value, name);
  if (value.length > maximumEnvironmentValueLength) {
    throw new RangeError(`${name} exceeds the Windows extended path limit`);
  }
  if (
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    value.startsWith("\\??\\") ||
    !/^[A-Za-z]:[\\/]/u.test(value)
  ) {
    throw new TypeError(`${name} must be an absolute local Windows drive path`);
  }
  if (value.slice(2).includes(":")) {
    throw new TypeError(`${name} must not contain an alternate data stream`);
  }

  const originalSegments = value.slice(3).split(/[\\/]/u);
  for (const segment of originalSegments) {
    if (segment.length === 0) {
      continue;
    }
    assertSafeWindowsPathSegment(segment, name);
  }

  const normalized = win32.normalize(value.replaceAll("/", "\\"));
  return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
}

function assertSafeWindowsPathSegment(segment: string, name: string): void {
  if (
    segment === "." ||
    segment === ".." ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    /[<>:"|?*]/u.test(segment) ||
    [...segment].some((character) => character.charCodeAt(0) <= 0x1f)
  ) {
    throw new TypeError(`${name} contains an unsafe Windows path segment`);
  }

  const baseName = segment.split(".", 1)[0]?.toUpperCase();
  if (
    baseName === "CON" ||
    baseName === "PRN" ||
    baseName === "AUX" ||
    baseName === "NUL" ||
    baseName === "CONIN$" ||
    baseName === "CONOUT$" ||
    baseName === "CLOCK$" ||
    /^COM[1-9]$/u.test(baseName ?? "") ||
    /^LPT[1-9]$/u.test(baseName ?? "")
  ) {
    throw new TypeError(`${name} contains a reserved Windows device name`);
  }
}

function assertDescendantPath(root: string, candidate: string, name: string): void {
  if (windowsPathsEqual(root, candidate) || !isSameOrDescendant(root, candidate)) {
    throw new TypeError(`${name} must be contained by controlRootDirectory`);
  }
}

function assertDisjointDirectories(first: string, second: string): void {
  if (isSameOrDescendant(first, second) || isSameOrDescendant(second, first)) {
    throw new TypeError("workingDirectory and controlRootDirectory must not overlap");
  }
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const relative = win32.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative))
  );
}

function windowsPathsEqual(first: string, second: string): boolean {
  return first.toLowerCase() === second.toLowerCase();
}

function assertLimits(limits: CodexProcessResourceLimits): void {
  assertBoundedInteger(
    limits.hardTimeoutMs,
    "limits.hardTimeoutMs",
    codexProcessResourceLimitBounds.hardTimeoutMs,
  );
  assertBoundedInteger(
    limits.maximumProcessCount,
    "limits.maximumProcessCount",
    codexProcessResourceLimitBounds.maximumProcessCount,
  );
  assertBoundedInteger(
    limits.maximumMemoryBytes,
    "limits.maximumMemoryBytes",
    codexProcessResourceLimitBounds.maximumMemoryBytes,
  );
  assertBoundedInteger(
    limits.maximumOutputBytes,
    "limits.maximumOutputBytes",
    codexProcessResourceLimitBounds.maximumOutputBytes,
  );
}

function assertBoundedInteger(
  value: number,
  name: string,
  bounds: { readonly minimum: number; readonly maximum: number },
): void {
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new RangeError(
      `${name} must be an integer from ${bounds.minimum} through ${bounds.maximum}`,
    );
  }
}

function copyMinimalEnvironment(
  environment: Readonly<Record<string, string>>,
  workingDirectory: string,
): Readonly<Record<string, string>> {
  const entries: Array<readonly [string, string]> = [];
  const observedNames = new Set<string>();
  for (const [inputName, inputValue] of Object.entries(environment)) {
    const name = inputName.toUpperCase();
    assertEnvironmentName(name);
    if (observedNames.has(name)) {
      throw new TypeError(`environment contains duplicate case-insensitive name ${name}`);
    }
    observedNames.add(name);
    entries.push([name, normalizeEnvironmentValue(name, inputValue, workingDirectory)]);
  }

  for (const name of requiredEnvironmentNames) {
    if (!observedNames.has(name)) {
      throw new TypeError(`environment must define ${name} for replace mode`);
    }
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))),
  );
}

function assertEnvironmentName(name: string): void {
  if (name.length === 0 || name.includes("=") || name.includes("\0")) {
    throw new TypeError(
      "environment variable names must be non-empty and contain neither '=' nor NUL",
    );
  }
  if (sensitiveEnvironmentNameFragments.some((fragment) => name.includes(fragment))) {
    throw new TypeError(`environment variable ${name} has a secret-bearing name`);
  }
  if (!allowedEnvironmentNames.has(name)) {
    throw new TypeError(`environment variable ${name} is not in the Codex allowlist`);
  }
}

function normalizeEnvironmentValue(name: string, value: string, workingDirectory: string): string {
  assertWellFormedUnicode(value, `environment variable ${name}`);
  if (value.length === 0 || value.includes("\0")) {
    throw new TypeError(`environment variable ${name} must be non-empty and contain no NUL`);
  }
  if (value.length > maximumEnvironmentValueLength) {
    throw new RangeError(`environment variable ${name} exceeds the Windows value limit`);
  }

  if (pathEnvironmentNames.has(name)) {
    const path = normalizeLocalWindowsDirectory(value, `environment.${name}`);
    assertEnvironmentPathOutsideWorkingDirectory(path, workingDirectory, name);
    return path;
  }
  if (name === "COMSPEC") {
    const path = normalizeLocalWindowsExecutable(value, `environment.${name}`);
    assertEnvironmentPathOutsideWorkingDirectory(path, workingDirectory, name);
    return path;
  }
  if (name === "PATH") {
    const paths = value.split(";");
    if (paths.length === 0 || paths.some((path) => path.length === 0)) {
      throw new TypeError("environment.PATH must contain non-empty absolute path entries");
    }
    return paths
      .map((path, index) => {
        const normalized = normalizeLocalWindowsDirectory(path, `environment.PATH[${index}]`);
        assertEnvironmentPathOutsideWorkingDirectory(normalized, workingDirectory, name);
        return normalized;
      })
      .join(";");
  }
  if (name === "PATHEXT") {
    const extensions = value.split(";");
    if (
      extensions.length === 0 ||
      extensions.some((extension) => !/^\.[A-Za-z0-9]+$/u.test(extension)) ||
      new Set(extensions.map((extension) => extension.toUpperCase())).size !== extensions.length
    ) {
      throw new TypeError("environment.PATHEXT must contain unique file extensions");
    }
    return extensions.map((extension) => extension.toUpperCase()).join(";");
  }
  return value;
}

function assertEncodableProcessHostStartFrame(spec: CodexProcessLaunchSpec): void {
  const request = {
    protocolVersion: "1.0",
    type: "start",
    requestId: maximumProcessHostRequestId,
    spec,
  } as const;
  const serialized = JSON.stringify(request);
  const frameBytes = Buffer.byteLength(serialized, "utf8");
  if (frameBytes > maximumProcessHostFrameBytes) {
    throw new RangeError(
      `ProcessHost start request must not exceed ${maximumProcessHostFrameBytes} UTF-8 bytes`,
    );
  }
}

function assertEnvironmentPathOutsideWorkingDirectory(
  path: string,
  workingDirectory: string,
  name: string,
): void {
  if (isSameOrDescendant(workingDirectory, path)) {
    throw new TypeError(`environment variable ${name} must not reference workingDirectory`);
  }
}

function assertNonEmptyText(value: string, name: string): void {
  assertWellFormedUnicode(value, name);
  if (value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${name} must not contain a NUL character`);
  }
}

function assertWellFormedUnicode(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${name} must contain well-formed Unicode`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${name} must contain well-formed Unicode`);
    }
  }
}
