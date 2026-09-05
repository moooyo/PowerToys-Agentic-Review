import { describe, expect, it } from "vitest";

import {
  type BuildCodexExecLaunchSpecOptions,
  buildCodexExecLaunchSpec,
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

const validOptions = (): BuildCodexExecLaunchSpecOptions => ({
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

describe("buildCodexExecLaunchSpec", () => {
  it("builds an ephemeral, non-interactive workspace execution with a replacement environment", () => {
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
    const spec = buildCodexExecLaunchSpec(options);

    expect(spec).toEqual({
      executable: "C:\\Tools\\Codex\\codex.exe",
      arguments: [
        "exec",
        "--cd",
        "C:\\Work\\Checkout",
        "--json",
        "--color",
        "never",
        "--config",
        'approval_policy="never"',
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        "workspace-write",
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

  it("preserves default arguments when configuration overrides are empty", () => {
    expect(
      buildCodexExecLaunchSpec({ ...validOptions(), configurationOverrides: [] }).arguments,
    ).toEqual(buildCodexExecLaunchSpec(validOptions()).arguments);
  });

  it("keeps configuration values intact and applies mandatory safety arguments afterward", () => {
    const configurationOverrides = [
      'approval_policy="on-request"',
      'sandbox_mode="danger-full-access"',
      'developer_instructions="Keep --cd C:/Other; & echo ordinary text"',
    ];
    const defaultSpec = buildCodexExecLaunchSpec(validOptions());
    const spec = buildCodexExecLaunchSpec({ ...validOptions(), configurationOverrides });

    expect(spec.arguments).toEqual([
      "exec",
      "--config",
      configurationOverrides[0],
      "--config",
      configurationOverrides[1],
      "--config",
      configurationOverrides[2],
      ...defaultSpec.arguments.slice(1),
    ]);
    const finalConfigIndex = spec.arguments.lastIndexOf("--config");
    expect(spec.arguments[finalConfigIndex + 1]).toBe('approval_policy="never"');
    const sandboxIndex = spec.arguments.indexOf("--sandbox");
    expect(sandboxIndex).toBeGreaterThan(finalConfigIndex);
    expect(spec.arguments[sandboxIndex + 1]).toBe("workspace-write");
    expect(spec.arguments.filter((argument) => argument === "--cd")).toHaveLength(1);
    expect(spec.arguments.filter((argument) => argument === "--output-schema")).toHaveLength(1);
    expect(spec.arguments.filter((argument) => argument === "--output-last-message")).toHaveLength(
      1,
    );

    configurationOverrides[0] = 'approval_policy="untrusted"';
    expect(spec.arguments[2]).toBe('approval_policy="on-request"');
  });

  it("accepts forty independent configuration overrides", () => {
    const configurationOverrides = Array.from(
      { length: 40 },
      (_, index) => `features.feature_${index}=false`,
    );
    const spec = buildCodexExecLaunchSpec({ ...validOptions(), configurationOverrides });

    expect(spec.arguments.filter((argument) => argument === "--config")).toHaveLength(41);
  });

  it.each([
    { name: "non-array", value: "model=example" },
    { name: "null", value: null },
    { name: "non-string entry", value: [false] },
    { name: "empty entry", value: [""] },
    { name: "blank entry", value: ["   "] },
    { name: "missing assignment", value: ["--cd C:/Other"] },
    { name: "missing key", value: [" =false"] },
    { name: "missing value", value: ["features.hooks= "] },
    { name: "NUL", value: ["features.hooks=false\0"] },
    { name: "line feed", value: ["features.hooks=false\nmodel=other"] },
    { name: "carriage return", value: ["features.hooks=false\rmodel=other"] },
    { name: "Unicode newline", value: ["features.hooks=false\u2028model=other"] },
    { name: "malformed Unicode", value: ["model=\uD800"] },
  ])("rejects $name configuration overrides", ({ value }) => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        configurationOverrides: value as unknown as readonly string[],
      }),
    ).toThrow(TypeError);
  });

  it("rejects too many configuration overrides", () => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        configurationOverrides: Array.from({ length: 129 }, () => "features.hooks=false"),
      }),
    ).toThrow(/must not exceed 128 entries/u);
  });

  it("bounds each configuration override by UTF-8 bytes", () => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        configurationOverrides: [`model=${"\u754c".repeat(11_000)}`],
      }),
    ).toThrow(/must not exceed 32768 UTF-8 bytes/u);
  });

  it("accepts the total configuration byte boundary and rejects larger inputs", () => {
    const override = `model=${"x".repeat(32 * 1024 - "model=".length)}`;
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        configurationOverrides: Array.from({ length: 4 }, () => override),
      }),
    ).not.toThrow();
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        configurationOverrides: Array.from({ length: 5 }, () => override),
      }),
    ).toThrow(/must not exceed 131072 total UTF-8 bytes/u);
  });

  it("includes configuration arguments in the complete ProcessHost frame limit", () => {
    const options = { ...validOptions(), prompt: "\\".repeat(500_000) };
    expect(() => buildCodexExecLaunchSpec(options)).not.toThrow();
    expect(() =>
      buildCodexExecLaunchSpec({
        ...options,
        configurationOverrides: Array.from({ length: 3 }, () => `model=${"x".repeat(30_000)}`),
      }),
    ).toThrow(/ProcessHost start request must not exceed 1048576 UTF-8 bytes/u);
  });

  it("keeps provider credentials only in the dedicated process environment", () => {
    const providerCredential = "fixture-only-provider-credential";
    const providerEnvironment = { CODEX_PROVIDER_HEADER_0: providerCredential };
    const options = {
      ...validOptions(),
      configurationOverrides: [
        'model_providers.selected.env_http_headers={Authorization="CODEX_PROVIDER_HEADER_0"}',
      ],
      providerEnvironment,
    };
    const spec = buildCodexExecLaunchSpec(options);

    expect(spec.environment).toEqual({ ...validEnvironment(), ...providerEnvironment });
    expect(Object.isFrozen(spec.environment)).toBe(true);
    expect(JSON.stringify(spec.arguments)).not.toContain(providerCredential);
    expect(spec.standardInput).not.toContain(providerCredential);
    expect(options.environment).not.toHaveProperty("CODEX_PROVIDER_HEADER_0");
    providerEnvironment.CODEX_PROVIDER_HEADER_0 = "changed-provider-credential";
    expect(spec.environment.CODEX_PROVIDER_HEADER_0).toBe(providerCredential);
  });

  it("accepts a null-prototype provider environment with own data properties", () => {
    const providerEnvironment: Record<string, string> = Object.create(null);
    providerEnvironment.CODEX_PROVIDER_HEADER_0 = "fixture-provider-value";
    const spec = buildCodexExecLaunchSpec({ ...validOptions(), providerEnvironment });

    expect(spec.environment.CODEX_PROVIDER_HEADER_0).toBe("fixture-provider-value");
  });

  it("accepts exactly sixty-four provider entries and rejects additional entries", () => {
    const providerEnvironment = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`CODEX_PROVIDER_HEADER_${index}`, "value"]),
    );
    expect(() =>
      buildCodexExecLaunchSpec({ ...validOptions(), providerEnvironment }),
    ).not.toThrow();
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        providerEnvironment: { ...providerEnvironment, CODEX_PROVIDER_HEADER_64: "value" },
      }),
    ).toThrow(/providerEnvironment must not exceed 64 entries/u);
  });

  it.each([
    "CODEX_PROVIDER_HEADER_",
    "CODEX_PROVIDER_HEADER_01",
    "CODEX_PROVIDER_HEADER_-1",
    "CODEX_PROVIDER_HEADER_1.0",
    "codex_provider_header_0",
    "CODEX_PROVIDER_HEADER_0_SUFFIX",
    "GITHUB_TOKEN",
    "WORKER_BEARER_TOKEN",
    "PATH",
  ])("rejects unsupported dedicated provider variable %s", (name) => {
    expect(() =>
      buildCodexExecLaunchSpec({ ...validOptions(), providerEnvironment: { [name]: "value" } }),
    ).toThrow(/providerEnvironment contains an unsupported variable name/u);
  });

  it("does not admit provider variable names through the ordinary environment", () => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), CODEX_PROVIDER_HEADER_0: "value" },
      }),
    ).toThrow(/not in the Codex allowlist/u);
  });

  it.each([
    { name: "null", value: null },
    { name: "string", value: "provider-environment" },
    { name: "array", value: [] },
    { name: "inherited properties", value: Object.create({ CODEX_PROVIDER_HEADER_0: "value" }) },
    { name: "symbol property", value: { [Symbol("provider")]: "value" } },
    {
      name: "non-enumerable property",
      value: Object.defineProperty({}, "CODEX_PROVIDER_HEADER_0", { value: "value" }),
    },
  ])("rejects $name provider environments", ({ value }) => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        providerEnvironment: value as unknown as Readonly<Record<string, string>>,
      }),
    ).toThrow(TypeError);
  });

  it("rejects provider accessors without evaluating them", () => {
    let getterCalled = false;
    const providerEnvironment = Object.defineProperty({}, "CODEX_PROVIDER_HEADER_0", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return "fixture-provider-value";
      },
    });
    expect(() => buildCodexExecLaunchSpec({ ...validOptions(), providerEnvironment })).toThrow(
      /own enumerable data properties/u,
    );
    expect(getterCalled).toBe(false);
  });

  it.each([
    { name: "non-string", value: 123 },
    { name: "empty", value: "" },
    { name: "blank", value: "   " },
    { name: "NUL", value: "provider\0value" },
    { name: "CR", value: "provider\rvalue" },
    { name: "LF", value: "provider\nvalue" },
    { name: "malformed Unicode", value: "provider\uD800" },
  ])("rejects $name provider values", ({ value }) => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        providerEnvironment: { CODEX_PROVIDER_HEADER_0: value } as Readonly<Record<string, string>>,
      }),
    ).toThrow(TypeError);
  });

  it("enforces the Windows environment value length for provider credentials", () => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        providerEnvironment: { CODEX_PROVIDER_HEADER_0: "x".repeat(32_767) },
      }),
    ).not.toThrow();
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        providerEnvironment: { CODEX_PROVIDER_HEADER_0: "x".repeat(32_768) },
      }),
    ).toThrow(/providerEnvironment value exceeds the Windows value limit/u);
  });

  it("includes provider credentials in the complete ProcessHost frame limit", () => {
    const options = { ...validOptions(), prompt: "\\".repeat(500_000) };
    expect(() => buildCodexExecLaunchSpec(options)).not.toThrow();
    expect(() =>
      buildCodexExecLaunchSpec({
        ...options,
        providerEnvironment: {
          CODEX_PROVIDER_HEADER_0: "x".repeat(30_000),
          CODEX_PROVIDER_HEADER_1: "y".repeat(30_000),
        },
      }),
    ).toThrow(/ProcessHost start request must not exceed 1048576 UTF-8 bytes/u);
  });

  it("does not disclose provider or configuration values in validation errors", () => {
    const marker = "private-fixture-marker";
    for (const overrides of [
      { providerEnvironment: { CODEX_PROVIDER_HEADER_0: `${marker}\0` } },
      { providerEnvironment: { [marker]: "value" } },
      { configurationOverrides: [`model="${marker}"\n`] },
    ]) {
      let error: unknown;
      try {
        buildCodexExecLaunchSpec({ ...validOptions(), ...overrides });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain(marker);
    }
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
    const spec = buildCodexExecLaunchSpec(options);

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
    expect(() => buildCodexExecLaunchSpec({ ...validOptions(), executable })).toThrow(TypeError);
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
    expect(() => buildCodexExecLaunchSpec({ ...validOptions(), [field]: value })).toThrow();
  });

  it("rejects overlapping control and checkout roots or aliased result files", () => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        controlRootDirectory: "C:\\Work",
        outputSchemaPath: "C:\\Work\\schema.json",
        outputLastMessagePath: "C:\\Work\\result.json",
      }),
    ).toThrow(TypeError);

    expect(() =>
      buildCodexExecLaunchSpec({
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
      expect(() => buildCodexExecLaunchSpec({ ...validOptions(), environment })).toThrow(
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
      buildCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), [name]: "sensitive" },
      }),
    ).toThrow(/secret-bearing name/u);
  });

  it("rejects unknown, duplicate, malformed, and checkout-relative environment entries", () => {
    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), CI: "true" },
      }),
    ).toThrow(/allowlist/u);

    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), Path: "C:\\Other" },
      }),
    ).toThrow(/duplicate case-insensitive/u);

    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), PATH: "relative;C:\\Tools" },
      }),
    ).toThrow(/absolute local Windows drive path/u);

    expect(() =>
      buildCodexExecLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), TEMP: "C:\\Work\\Checkout\\temp" },
      }),
    ).toThrow(/must not reference workingDirectory/u);

    expect(() =>
      buildCodexExecLaunchSpec({
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
      buildCodexExecLaunchSpec({
        ...validOptions(),
        limits: { ...validLimits(), [name]: value },
      }),
    ).toThrow(RangeError);
  });

  it("accepts every exact resource-limit boundary", () => {
    for (const edge of ["minimum", "maximum"] as const) {
      expect(() =>
        buildCodexExecLaunchSpec({
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
      buildCodexExecLaunchSpec({
        ...validOptions(),
        limits: limits as CodexProcessResourceLimits,
      }),
    ).toThrow(RangeError);
  });

  it.each(["", "   ", "review\0outside"])("rejects invalid prompt %j", (prompt) => {
    expect(() => buildCodexExecLaunchSpec({ ...validOptions(), prompt })).toThrow(TypeError);
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
    expect(() => buildCodexExecLaunchSpec(options())).toThrow(/well-formed Unicode/u);
  });

  it("accepts an ASCII prompt at the exact raw limit when the complete start frame fits", () => {
    const spec = buildCodexExecLaunchSpec({
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
      buildCodexExecLaunchSpec({
        ...validOptions(),
        prompt: "x".repeat(512 * 1024 + 1),
      }),
    ).toThrow(/524288 UTF-8 bytes/u);
  });

  it("rejects a multibyte Unicode prompt whose UTF-8 encoding exceeds 512 KiB", () => {
    const prompt = "\u754c".repeat(Math.floor((512 * 1024) / 3) + 1);
    expect(prompt.length).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(512 * 1024);

    expect(() => buildCodexExecLaunchSpec({ ...validOptions(), prompt })).toThrow(RangeError);
  });

  it("rejects a highly escaped prompt when the complete start frame exceeds 1 MiB", () => {
    const prompt = "\\".repeat(512 * 1024);
    expect(Buffer.byteLength(prompt, "utf8")).toBe(512 * 1024);

    expect(() => buildCodexExecLaunchSpec({ ...validOptions(), prompt })).toThrow(
      /ProcessHost start request must not exceed 1048576 UTF-8 bytes/u,
    );
  });
});
