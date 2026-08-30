import { describe, expect, it } from "vitest";

import {
  type BuildReadOnlyCodexExecLaunchSpecOptions,
  buildReadOnlyCodexExecLaunchSpec,
  type CodexProcessResourceLimits,
  codexProcessResourceLimitBounds,
} from "./launch-spec.js";

const validEnvironment = (): Record<string, string> => ({
  CODEX_HOME: "C:\\Service\\Codex",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  PATH: "C:\\Windows\\System32;C:\\Tools",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  SYSTEMROOT: "C:\\Windows",
  TEMP: "C:\\Service\\Temp",
  USERPROFILE: "C:\\Service\\Profile",
});

const validLimits = (): CodexProcessResourceLimits => ({
  hardTimeoutMs: 900_000,
  maximumProcessCount: 64,
  maximumMemoryBytes: 8_589_934_592,
  maximumOutputBytes: 67_108_864,
});

const validOptions = (): BuildReadOnlyCodexExecLaunchSpecOptions => ({
  executable: "C:\\Tools\\Codex\\codex.exe",
  workingDirectory: "C:\\Work\\Checkout",
  processWorkingDirectory: "C:\\Service\\Runs\\attempt-1\\control",
  controlRootDirectory: "C:\\Service\\Runs\\attempt-1\\control",
  prompt: "Review this revision; & echo must remain ordinary prompt text.",
  outputSchemaPath: "C:\\Service\\Runs\\attempt-1\\control\\schema.json",
  outputLastMessagePath: "C:\\Service\\Runs\\attempt-1\\control\\output\\result.json",
  environment: validEnvironment(),
  limits: validLimits(),
});

describe("buildReadOnlyCodexExecLaunchSpec", () => {
  it("builds an ephemeral, non-interactive, read-only invocation with a replacement environment", () => {
    const options = {
      ...validOptions(),
      environment: {
        codex_home: "C:\\Service\\Codex",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        Path: "C:\\Windows\\System32;C:\\Tools",
        PathExt: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
        temp: "C:\\Service\\Temp",
        userprofile: "C:\\Service\\Profile",
      },
    };
    const spec = buildReadOnlyCodexExecLaunchSpec(options);

    expect(spec).toEqual({
      executable: "C:\\Tools\\Codex\\codex.exe",
      arguments: [
        "exec",
        "--cd",
        "C:\\Work\\Checkout",
        "--json",
        "--color",
        "never",
        "--ask-for-approval",
        "never",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--output-schema",
        "C:\\Service\\Runs\\attempt-1\\control\\schema.json",
        "--output-last-message",
        "C:\\Service\\Runs\\attempt-1\\control\\output\\result.json",
        "-",
      ],
      workingDirectory: "C:\\Service\\Runs\\attempt-1\\control",
      environmentMode: "replace",
      environment: {
        CODEX_HOME: "C:\\Service\\Codex",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32;C:\\Tools",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SYSTEMROOT: "C:\\Windows",
        TEMP: "C:\\Service\\Temp",
        USERPROFILE: "C:\\Service\\Profile",
      },
      standardInput: options.prompt,
      limits: validLimits(),
    });
    expect(spec.arguments).not.toContain(options.prompt);
  });

  it("does not retain mutable environment or limits objects", () => {
    const options = validOptions();
    const environment = options.environment as Record<string, string>;
    const limits = options.limits as {
      hardTimeoutMs: number;
      maximumProcessCount: number;
      maximumMemoryBytes: number;
      maximumOutputBytes: number;
    };
    const spec = buildReadOnlyCodexExecLaunchSpec(options);

    environment.CODEX_HOME = "C:\\Changed";
    limits.hardTimeoutMs = 10_000;

    expect(spec.environment.CODEX_HOME).toBe("C:\\Service\\Codex");
    expect(spec.limits.hardTimeoutMs).toBe(900_000);
  });

  it.each([
    "codex.exe",
    ".\\codex.exe",
    "C:codex.exe",
    "\\\\server\\share\\codex.exe",
    "\\\\?\\C:\\Tools\\codex.exe",
    "\\\\.\\C:\\Tools\\codex.exe",
    "C:\\Tools\\codex.exe:payload",
    "C:\\Tools\\codex.cmd",
    "C:\\Tools\\CON.exe",
    "C:\\Tools\\CONIN$\\codex.exe",
    "C:\\Tools\\CONOUT$\\codex.exe",
    "C:\\Tools\\CLOCK$\\codex.exe",
    "C:\\Work\\Checkout\\codex.exe",
  ])("rejects unsafe executable path %s", (executable) => {
    expect(() => buildReadOnlyCodexExecLaunchSpec({ ...validOptions(), executable })).toThrow(
      TypeError,
    );
  });

  it.each([
    { field: "workingDirectory", value: "relative\\checkout" },
    { field: "processWorkingDirectory", value: "C:\\Other\\process" },
    { field: "processWorkingDirectory", value: "C:\\Work\\Checkout\\process" },
    { field: "workingDirectory", value: "C:\\Work\0outside" },
    { field: "controlRootDirectory", value: "\\\\server\\share\\control" },
    { field: "outputSchemaPath", value: "C:\\Service\\Runs\\escape\\schema.json" },
    { field: "outputSchemaPath", value: "C:\\Service\\Runs\\attempt-1\\control\\..\\schema.json" },
    { field: "outputLastMessagePath", value: "C:\\Other\\result.json" },
    { field: "outputLastMessagePath", value: "C:\\Service\\Runs\\attempt-1\\control\\result.txt" },
  ] as const)("rejects unsafe or out-of-bound $field", ({ field, value }) => {
    expect(() => buildReadOnlyCodexExecLaunchSpec({ ...validOptions(), [field]: value })).toThrow();
  });

  it("rejects overlapping control and checkout roots or aliased result files", () => {
    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        controlRootDirectory: "C:\\Work",
        outputSchemaPath: "C:\\Work\\schema.json",
        outputLastMessagePath: "C:\\Work\\result.json",
      }),
    ).toThrow(TypeError);

    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        outputLastMessagePath: "c:\\service\\runs\\attempt-1\\control\\SCHEMA.json",
      }),
    ).toThrow(TypeError);
  });

  it.each(["CODEX_HOME", "COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "USERPROFILE"])(
    "requires %s in the replacement environment",
    (missingName) => {
      const environment = validEnvironment();
      delete environment[missingName];
      expect(() => buildReadOnlyCodexExecLaunchSpec({ ...validOptions(), environment })).toThrow(
        new TypeError(`environment must define ${missingName} for replace mode`),
      );
    },
  );

  it.each([
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "CLIENT_SECRET",
    "WORKER_TLS_KEY_PATH",
    "WORKER_TLS_CERT_PATH",
  ])("rejects secret-bearing environment name %s", (name) => {
    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), [name]: "sensitive" },
      }),
    ).toThrow(/secret-bearing name/u);
  });

  it("rejects unknown, duplicate, malformed, and checkout-relative environment entries", () => {
    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), CI: "true" },
      }),
    ).toThrow(/allowlist/u);

    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), Path: "C:\\Other" },
      }),
    ).toThrow(/duplicate case-insensitive/u);

    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), PATH: "relative;C:\\Tools" },
      }),
    ).toThrow(/absolute local Windows drive path/u);

    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), TEMP: "C:\\Work\\Checkout\\temp" },
      }),
    ).toThrow(/must not reference workingDirectory/u);

    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), PATHEXT: ".EXE;.exe" },
      }),
    ).toThrow(/unique file extensions/u);
  });

  it.each([
    ["hardTimeoutMs", codexProcessResourceLimitBounds.hardTimeoutMs.minimum - 1],
    ["hardTimeoutMs", codexProcessResourceLimitBounds.hardTimeoutMs.maximum + 1],
    ["maximumProcessCount", 0],
    ["maximumProcessCount", codexProcessResourceLimitBounds.maximumProcessCount.maximum + 1],
    ["maximumMemoryBytes", codexProcessResourceLimitBounds.maximumMemoryBytes.minimum - 1],
    ["maximumMemoryBytes", codexProcessResourceLimitBounds.maximumMemoryBytes.maximum + 1],
    ["maximumOutputBytes", codexProcessResourceLimitBounds.maximumOutputBytes.minimum - 1],
    ["maximumOutputBytes", codexProcessResourceLimitBounds.maximumOutputBytes.maximum + 1],
    ["maximumOutputBytes", 4_096.5],
  ] as const)("rejects out-of-range limit %s=%s", (name, value) => {
    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        limits: { ...validLimits(), [name]: value },
      }),
    ).toThrow(RangeError);
  });

  it("accepts every exact resource-limit boundary", () => {
    for (const edge of ["minimum", "maximum"] as const) {
      expect(() =>
        buildReadOnlyCodexExecLaunchSpec({
          ...validOptions(),
          limits: {
            hardTimeoutMs: codexProcessResourceLimitBounds.hardTimeoutMs[edge],
            maximumProcessCount: codexProcessResourceLimitBounds.maximumProcessCount[edge],
            maximumMemoryBytes: codexProcessResourceLimitBounds.maximumMemoryBytes[edge],
            maximumOutputBytes: codexProcessResourceLimitBounds.maximumOutputBytes[edge],
          },
        }),
      ).not.toThrow();
    }
  });

  it("rejects a missing mandatory limit at runtime", () => {
    const limits = validLimits() as Partial<CodexProcessResourceLimits>;
    delete limits.maximumOutputBytes;
    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        limits: limits as CodexProcessResourceLimits,
      }),
    ).toThrow(RangeError);
  });

  it.each(["", "   ", "review\0outside"])("rejects invalid prompt %j", (prompt) => {
    expect(() => buildReadOnlyCodexExecLaunchSpec({ ...validOptions(), prompt })).toThrow(
      TypeError,
    );
  });

  it.each([
    {
      name: "prompt",
      options: () => ({ ...validOptions(), prompt: "review\uD800" }),
    },
    {
      name: "path",
      options: () => ({ ...validOptions(), workingDirectory: "C:\\Work\\\uDFFF" }),
    },
    {
      name: "environment value",
      options: () => ({
        ...validOptions(),
        environment: { ...validEnvironment(), PATHEXT: "\uD800" },
      }),
    },
  ])("rejects malformed surrogate input in $name", ({ options }) => {
    expect(() => buildReadOnlyCodexExecLaunchSpec(options())).toThrow(/well-formed Unicode/u);
  });

  it("accepts an ASCII prompt at the exact raw limit when the complete start frame fits", () => {
    const spec = buildReadOnlyCodexExecLaunchSpec({
      ...validOptions(),
      prompt: "x".repeat(512 * 1024),
    });
    const startRequest = {
      protocolVersion: "1.0",
      type: "start",
      requestId: "R".repeat(128),
      spec,
    };

    expect(Buffer.byteLength(JSON.stringify(startRequest), "utf8")).toBeLessThanOrEqual(1_048_576);
  });

  it("rejects an ASCII prompt one byte beyond the 512 KiB UTF-8 boundary", () => {
    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        ...validOptions(),
        prompt: "x".repeat(512 * 1024 + 1),
      }),
    ).toThrow(/524288 UTF-8 bytes/u);
  });

  it("rejects a multibyte Unicode prompt whose UTF-8 encoding exceeds 512 KiB", () => {
    const prompt = "\u754c".repeat(Math.floor((512 * 1024) / 3) + 1);
    expect(prompt.length).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(512 * 1024);

    expect(() => buildReadOnlyCodexExecLaunchSpec({ ...validOptions(), prompt })).toThrow(
      RangeError,
    );
  });

  it("rejects a highly escaped prompt when the complete start frame exceeds 1 MiB", () => {
    const prompt = "\\".repeat(512 * 1024);
    expect(Buffer.byteLength(prompt, "utf8")).toBe(512 * 1024);

    expect(() => buildReadOnlyCodexExecLaunchSpec({ ...validOptions(), prompt })).toThrow(
      /ProcessHost start request must not exceed 1048576 UTF-8 bytes/u,
    );
  });
});
