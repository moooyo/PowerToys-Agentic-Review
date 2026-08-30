export interface CodexProcessResourceLimits {
  readonly hardTimeoutMs: number;
  readonly maximumProcessCount?: number;
  readonly maximumMemoryBytes?: number;
  readonly maximumOutputBytes?: number;
}

/**
 * Pure data compatible with the worker ProcessLaunchSpec contract.
 * The package deliberately does not import worker implementation types.
 */
export interface CodexProcessLaunchSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly standardInput?: string;
  readonly limits: CodexProcessResourceLimits;
}

export interface BuildReadOnlyCodexExecLaunchSpecOptions {
  readonly executable?: string;
  readonly workingDirectory: string;
  readonly prompt: string;
  readonly outputSchemaPath: string;
  readonly outputLastMessagePath: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly limits: CodexProcessResourceLimits;
}

const maximumPromptLength = 1_048_576;

export function buildReadOnlyCodexExecLaunchSpec(
  options: BuildReadOnlyCodexExecLaunchSpecOptions,
): CodexProcessLaunchSpec {
  const executable = options.executable ?? "codex";

  assertNonEmptyText(executable, "executable");
  assertPath(options.workingDirectory, "workingDirectory");
  assertPath(options.outputSchemaPath, "outputSchemaPath");
  assertPath(options.outputLastMessagePath, "outputLastMessagePath");
  assertPrompt(options.prompt);
  assertLimits(options.limits);

  const environment = copyEnvironment(options.environment ?? {});
  const argumentsList = [
    "exec",
    "-",
    "--json",
    "--color",
    "never",
    "--output-schema",
    options.outputSchemaPath,
    "--output-last-message",
    options.outputLastMessagePath,
    "--sandbox",
    "read-only",
  ] as const;

  return {
    executable,
    arguments: argumentsList,
    workingDirectory: options.workingDirectory,
    environment,
    standardInput: options.prompt,
    limits: copyLimits(options.limits),
  };
}

function assertPrompt(prompt: string): void {
  assertNonEmptyText(prompt, "prompt");
  if (prompt.length > maximumPromptLength) {
    throw new RangeError(`prompt must not exceed ${maximumPromptLength} characters`);
  }
}

function assertPath(value: string, name: string): void {
  assertNonEmptyText(value, name);
}

function assertNonEmptyText(value: string, name: string): void {
  if (value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${name} must not contain a NUL character`);
  }
}

function assertLimits(limits: CodexProcessResourceLimits): void {
  assertPositiveSafeInteger(limits.hardTimeoutMs, "limits.hardTimeoutMs");

  if (limits.maximumProcessCount !== undefined) {
    assertPositiveSafeInteger(limits.maximumProcessCount, "limits.maximumProcessCount");
  }
  if (limits.maximumMemoryBytes !== undefined) {
    assertPositiveSafeInteger(limits.maximumMemoryBytes, "limits.maximumMemoryBytes");
  }
  if (limits.maximumOutputBytes !== undefined) {
    assertPositiveSafeInteger(limits.maximumOutputBytes, "limits.maximumOutputBytes");
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function copyEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(environment)) {
    if (name.length === 0 || name.includes("=") || name.includes("\0")) {
      throw new TypeError(
        "environment variable names must be non-empty and contain neither '=' nor NUL",
      );
    }
    if (value.includes("\0")) {
      throw new TypeError(`environment variable ${name} must not contain a NUL character`);
    }
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function copyLimits(limits: CodexProcessResourceLimits): CodexProcessResourceLimits {
  return {
    hardTimeoutMs: limits.hardTimeoutMs,
    ...(limits.maximumProcessCount === undefined
      ? {}
      : { maximumProcessCount: limits.maximumProcessCount }),
    ...(limits.maximumMemoryBytes === undefined
      ? {}
      : { maximumMemoryBytes: limits.maximumMemoryBytes }),
    ...(limits.maximumOutputBytes === undefined
      ? {}
      : { maximumOutputBytes: limits.maximumOutputBytes }),
  };
}
