import { describe, expect, it } from "vitest";

import {
  type BuildCliLaunchSpecOptions,
  buildCliLaunchSpec,
  type CliProcessResourceLimits,
  cliProcessResourceLimitBounds,
} from "./launch-spec.js";

const validEnvironment = (): Record<string, string> => ({
  APPDATA: "C:\\Service\\Profile\\AppData\\Roaming",
  CODEX_HOME: "C:\\Service\\Codex",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  LOCALAPPDATA: "C:\\Service\\Profile\\AppData\\Local",
  PATH: "C:\\Windows\\System32;C:\\Tools",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  SYSTEMROOT: "C:\\Windows",
  TEMP: "C:\\Service\\Temp",
  USERPROFILE: "C:\\Service\\Profile",
});

const validLimits = (): CliProcessResourceLimits => ({
  hardTimeoutMs: 900_000,
  maximumProcessCount: 64,
  maximumMemoryBytes: 8_589_934_592,
  maximumOutputBytes: 67_108_864,
});

const validOptions = (): BuildCliLaunchSpecOptions => ({
  engine: "codex",
  executable: "C:\\Tools\\Codex\\codex.exe",
  workingDirectory: "C:\\Work\\Checkout",
  controlRootDirectory: "C:\\Service\\Runs\\attempt-1\\control",
  prompt: "Review this revision; & echo must remain ordinary prompt text.",
  outputSchemaPath: "C:\\Service\\Runs\\attempt-1\\control\\schema.json",
  outputSchemaJson: '{"type":"object","properties":{"summary":{"type":"string"}}}',
  outputLastMessagePath: "C:\\Service\\Runs\\attempt-1\\control\\output\\result.json",
  environment: validEnvironment(),
  limits: validLimits(),
});

describe("buildCliLaunchSpec", () => {
  it("runs Codex exec through stdin and retains its configured profile", () => {
    const options = validOptions();
    const spec = buildCliLaunchSpec(options);

    expect(spec).toEqual({
      executable: options.executable,
      arguments: [
        "exec",
        "--cd",
        options.workingDirectory,
        "--json",
        "--color",
        "never",
        "--dangerously-bypass-approvals-and-sandbox",
        "--ephemeral",
        "--output-schema",
        options.outputSchemaPath,
        "--output-last-message",
        options.outputLastMessagePath,
        "-",
      ],
      workingDirectory: options.controlRootDirectory,
      environmentMode: "replace",
      environment: options.environment,
      standardInput: options.prompt,
      limits: options.limits,
    });
    expect(spec.arguments).not.toContain(options.prompt);
    expect(spec.arguments).not.toContain("--ignore-user-config");
    expect(spec.arguments).not.toContain("--config");
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.arguments)).toBe(true);
    expect(Object.isFrozen(spec.environment)).toBe(true);
    expect(Object.isFrozen(spec.limits)).toBe(true);
  });

  it("runs Copilot from stdin without asking the CLI to write a result file", () => {
    const options = {
      ...validOptions(),
      engine: "copilot" as const,
      executable: "C:\\Tools\\Copilot\\copilot.exe",
    };
    const spec = buildCliLaunchSpec(options);

    expect(spec.arguments).toEqual([
      "-C",
      options.workingDirectory,
      "--allow-all",
      "--no-ask-user",
      "--no-auto-update",
      "--silent",
      "--stream",
      "on",
      "--output-format",
      "json",
      "--no-color",
    ]);
    expect(spec.arguments).not.toContain("-p");
    expect(spec.arguments).not.toContain("--prompt");
    expect(spec.standardInput).toBe(
      [
        options.prompt,
        "",
        "Return only one JSON object as your final response, without Markdown fences or other text.",
        "The final response must conform to this JSON Schema:",
        options.outputSchemaJson,
      ].join("\n"),
    );
    expect(spec.standardInput).not.toContain(options.outputLastMessagePath);
    expect(spec.standardInput).not.toContain(options.outputSchemaPath);
    expect(spec.workingDirectory).toBe(options.controlRootDirectory);
    expect(spec.environment).toEqual(options.environment);
  });

  it.each(["codex", "copilot"] as const)(
    "allows %s to select its configured model when no override is supplied",
    (engine) => {
      const spec = buildCliLaunchSpec({ ...validOptions(), engine });
      expect(spec.arguments).not.toContain("--model");
    },
  );

  it.each(["codex", "copilot"] as const)(
    "passes an explicit %s model as a single argument",
    (engine) => {
      const model = "configured-model";
      const spec = buildCliLaunchSpec({ ...validOptions(), engine, model });
      const index = spec.arguments.indexOf("--model");
      expect(index).toBeGreaterThan(-1);
      expect(spec.arguments[index + 1]).toBe(model);
    },
  );

  it.each(["", " ", "model\nother", "model\rrestart", "model\0secret", "x".repeat(257)])(
    "rejects invalid model %j",
    (model) => {
      expect(() => buildCliLaunchSpec({ ...validOptions(), model })).toThrow(TypeError);
    },
  );

  it.each(["", "invalid", "null", "[]", '"text"', "1"])(
    "rejects invalid schema JSON %j",
    (outputSchemaJson) => {
      expect(() => buildCliLaunchSpec({ ...validOptions(), outputSchemaJson })).toThrow(TypeError);
    },
  );

  it("rejects unknown engines instead of selecting a fallback", () => {
    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        engine: "unknown",
      } as unknown as BuildCliLaunchSpecOptions),
    ).toThrow(/engine/u);
  });

  it("preserves configured homes without requiring a custom CLI home", () => {
    const environment = validEnvironment();
    delete environment.CODEX_HOME;
    const spec = buildCliLaunchSpec({ ...validOptions(), environment });
    expect(spec.environment.CODEX_HOME).toBeUndefined();
    expect(spec.environment.USERPROFILE).toBe(environment.USERPROFILE);
    expect(spec.environment.APPDATA).toBe(environment.APPDATA);
    expect(spec.environment.LOCALAPPDATA).toBe(environment.LOCALAPPDATA);

    const copilotHome = "C:\\Service\\Copilot";
    const copilot = buildCliLaunchSpec({
      ...validOptions(),
      engine: "copilot",
      environment: { ...environment, COPILOT_HOME: copilotHome },
    });
    expect(copilot.environment.COPILOT_HOME).toBe(copilotHome);
  });

  it.each([
    "C:\\Windows\\System32;C:\\Tools;",
    ";C:\\Windows\\System32;C:\\Tools",
    ";;C:\\Windows\\System32;;;C:\\Tools;;",
  ])("retains usable inherited PATH entries from %s", (path) => {
    const environment = { ...validEnvironment(), PATH: path };
    const spec = buildCliLaunchSpec({ ...validOptions(), environment });
    expect(spec.environment.PATH).toBe("C:\\Windows\\System32;C:\\Tools");
    expect(environment.PATH).toBe(path);
  });

  it.each(["", ";", ";;;"])("rejects inherited PATH without executable directories: %j", (path) => {
    expect(() =>
      buildCliLaunchSpec({ ...validOptions(), environment: { ...validEnvironment(), PATH: path } }),
    ).toThrow(/at least one absolute path entry/u);
  });

  it.each([";relative;;C:\\Tools;", ";C:\\Work\\Checkout\\bin;;C:\\Tools;"])(
    "keeps rejecting relative or task-owned PATH entries after empty entries: %s",
    (path) => {
      expect(() =>
        buildCliLaunchSpec({
          ...validOptions(),
          environment: { ...validEnvironment(), PATH: path },
        }),
      ).toThrow(TypeError);
    },
  );

  it("includes the Copilot schema instructions in the actual stdin limit", () => {
    const options = { ...validOptions(), prompt: "x".repeat(512 * 1024) };
    expect(() => buildCliLaunchSpec(options)).not.toThrow();
    expect(() => buildCliLaunchSpec({ ...options, engine: "copilot" })).toThrow(
      /524288 UTF-8 bytes/u,
    );
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
    const spec = buildCliLaunchSpec(options);

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
    expect(() => buildCliLaunchSpec({ ...validOptions(), executable })).toThrow(TypeError);
  });

  it.each([
    { field: "workingDirectory", value: "relative\\checkout" },
    { field: "workingDirectory", value: "C:\\Work\0outside" },
    { field: "controlRootDirectory", value: "\\\\server\\share\\control" },
    { field: "outputSchemaPath", value: "C:\\Service\\Runs\\escape\\schema.json" },
    { field: "outputSchemaPath", value: "C:\\Service\\Runs\\attempt-1\\control\\..\\schema.json" },
    { field: "outputLastMessagePath", value: "C:\\Other\\result.json" },
    { field: "outputLastMessagePath", value: "C:\\Service\\Runs\\attempt-1\\control\\result.txt" },
  ] as const)("rejects unsafe or out-of-bound $field", ({ field, value }) => {
    expect(() => buildCliLaunchSpec({ ...validOptions(), [field]: value })).toThrow();
  });

  it("rejects overlapping control and checkout roots or aliased result files", () => {
    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        controlRootDirectory: "C:\\Work",
        outputSchemaPath: "C:\\Work\\schema.json",
        outputLastMessagePath: "C:\\Work\\result.json",
      }),
    ).toThrow(TypeError);

    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        outputLastMessagePath: "c:\\service\\runs\\attempt-1\\control\\SCHEMA.json",
      }),
    ).toThrow(TypeError);
  });

  it.each(["COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "USERPROFILE"])(
    "requires %s in the replacement environment",
    (missingName) => {
      const environment = validEnvironment();
      delete environment[missingName];
      expect(() => buildCliLaunchSpec({ ...validOptions(), environment })).toThrow(
        new TypeError(`environment must define ${missingName} for replace mode`),
      );
    },
  );

  it.each(["codex", "copilot"] as const)(
    "preserves supplied CLI credentials and connection settings for %s",
    (engine) => {
      const environment = {
        ...validEnvironment(),
        CLI_TOKEN: "synthetic-cli-token",
        GITHUB_TOKEN: "synthetic-github-token",
        OPENAI_API_KEY: "synthetic-api-key",
        CLIENT_SECRET: "synthetic-client-secret",
        CustomEndpoint: "https://configured-cli.invalid/api",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
        CI: "true",
        NO_COLOR: "",
      };
      const spec = buildCliLaunchSpec({ ...validOptions(), engine, environment });
      expect(spec.environment).toEqual(environment);
      expect(spec.environmentMode).toBe("replace");
      expect(JSON.stringify(spec.arguments)).not.toContain(environment.CLI_TOKEN);
      expect(spec.standardInput).not.toContain(environment.CLI_TOKEN);
    },
  );

  it.each([
    "WORKER_BEARER_TOKEN",
    "WORKER_TLS_KEY_PATH",
    "WORKER_TLS_CERT_PATH",
    "SERVER_TOKEN",
    "SERVER_URL",
    "worker_token",
    "Server_Admin_Token",
    "AGENTIC_REVIEW_CREDENTIAL",
    "agentic_review_server",
  ])("rejects project control environment name %s", (name) => {
    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), [name]: "sensitive" },
      }),
    ).toThrow(/project control variables/u);
  });

  it.each([
    "env-with-dash",
    "env.with.dot",
    "\u914d\u7f6e",
    "X".repeat(128),
    "\u{1f680}".repeat(64),
  ])("preserves a valid Windows environment name %s", (name) => {
    const environment = { ...validEnvironment(), [name]: "synthetic-value" };
    expect(buildCliLaunchSpec({ ...validOptions(), environment }).environment[name]).toBe(
      "synthetic-value",
    );
  });

  it.each([
    "",
    "BAD=NAME",
    "BAD\0NAME",
    "BAD\nNAME",
    "BAD\u007fNAME",
    "BAD\u0085NAME",
    "BAD\uD800NAME",
    "x".repeat(129),
    "\u{1f680}".repeat(65),
  ])("rejects an invalid Windows environment name %j", (name) => {
    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), [name]: "synthetic-value" },
      }),
    ).toThrow();
  });

  it("allows 512 host environment entries and rejects an additional entry", () => {
    const environment = validEnvironment();
    const addedCount = 512 - Object.keys(environment).length;
    for (let index = 0; index < addedCount; index++) environment[`ENV_${index}`] = "value";
    expect(
      Object.keys(buildCliLaunchSpec({ ...validOptions(), environment }).environment),
    ).toHaveLength(512);
    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        environment: { ...environment, EXTRA_ENV: "value" },
      }),
    ).toThrow(/512 properties/u);
  });

  it("rejects duplicate, malformed, and checkout-relative environment entries", () => {
    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), Path: "C:\\Other" },
      }),
    ).toThrow(/duplicate case-insensitive/u);

    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), PATH: "relative;C:\\Tools" },
      }),
    ).toThrow(/absolute local Windows drive path/u);

    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), TEMP: "C:\\Work\\Checkout\\temp" },
      }),
    ).toThrow(/must not reference workingDirectory/u);

    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), PATHEXT: ".EXE;.exe" },
      }),
    ).toThrow(/unique file extensions/u);
  });

  it.each([
    { name: "NUL", value: "private-fixture\0" },
    { name: "malformed Unicode", value: "private-fixture\uD800" },
    { name: "oversized", value: "private-fixture".repeat(3_000) },
    { name: "non-string", value: 123 },
  ])("rejects $name CLI environment values without exposing them", ({ value }) => {
    let failure: unknown;
    try {
      buildCliLaunchSpec({
        ...validOptions(),
        environment: { ...validEnvironment(), CLI_TOKEN: value } as Record<string, string>,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("private-fixture");
  });

  it("preserves a CLI environment value at the Windows length boundary", () => {
    const environment = { ...validEnvironment(), CLI_TOKEN: "x".repeat(32_767) };
    expect(buildCliLaunchSpec({ ...validOptions(), environment }).environment.CLI_TOKEN).toBe(
      environment.CLI_TOKEN,
    );
  });

  it.each([
    ["hardTimeoutMs", cliProcessResourceLimitBounds.hardTimeoutMs.minimum - 1],
    ["hardTimeoutMs", cliProcessResourceLimitBounds.hardTimeoutMs.maximum + 1],
    ["maximumProcessCount", 0],
    ["maximumProcessCount", cliProcessResourceLimitBounds.maximumProcessCount.maximum + 1],
    ["maximumMemoryBytes", cliProcessResourceLimitBounds.maximumMemoryBytes.minimum - 1],
    ["maximumMemoryBytes", cliProcessResourceLimitBounds.maximumMemoryBytes.maximum + 1],
    ["maximumOutputBytes", cliProcessResourceLimitBounds.maximumOutputBytes.minimum - 1],
    ["maximumOutputBytes", cliProcessResourceLimitBounds.maximumOutputBytes.maximum + 1],
    ["maximumOutputBytes", 4_096.5],
  ] as const)("rejects out-of-range limit %s=%s", (name, value) => {
    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        limits: { ...validLimits(), [name]: value },
      }),
    ).toThrow(RangeError);
  });

  it("accepts every exact resource-limit boundary", () => {
    for (const edge of ["minimum", "maximum"] as const) {
      expect(() =>
        buildCliLaunchSpec({
          ...validOptions(),
          limits: {
            hardTimeoutMs: cliProcessResourceLimitBounds.hardTimeoutMs[edge],
            maximumProcessCount: cliProcessResourceLimitBounds.maximumProcessCount[edge],
            maximumMemoryBytes: cliProcessResourceLimitBounds.maximumMemoryBytes[edge],
            maximumOutputBytes: cliProcessResourceLimitBounds.maximumOutputBytes[edge],
          },
        }),
      ).not.toThrow();
    }
  });

  it("rejects a missing mandatory limit at runtime", () => {
    const limits = validLimits() as Partial<CliProcessResourceLimits>;
    Reflect.deleteProperty(limits, "maximumOutputBytes");
    expect(() =>
      buildCliLaunchSpec({
        ...validOptions(),
        limits: limits as CliProcessResourceLimits,
      }),
    ).toThrow(RangeError);
  });

  it.each(["", "   ", "review\0outside"])("rejects invalid prompt %j", (prompt) => {
    expect(() => buildCliLaunchSpec({ ...validOptions(), prompt })).toThrow(TypeError);
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
    expect(() => buildCliLaunchSpec(options())).toThrow(/well-formed Unicode/u);
  });

  it("accepts an ASCII prompt at the exact raw limit when the complete start frame fits", () => {
    const spec = buildCliLaunchSpec({
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
      buildCliLaunchSpec({
        ...validOptions(),
        prompt: "x".repeat(512 * 1024 + 1),
      }),
    ).toThrow(/524288 UTF-8 bytes/u);
  });

  it("rejects a multibyte Unicode prompt whose UTF-8 encoding exceeds 512 KiB", () => {
    const prompt = "\u754c".repeat(Math.floor((512 * 1024) / 3) + 1);
    expect(prompt.length).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(512 * 1024);

    expect(() => buildCliLaunchSpec({ ...validOptions(), prompt })).toThrow(RangeError);
  });

  it("rejects a highly escaped prompt when the complete start frame exceeds 1 MiB", () => {
    const prompt = "\\".repeat(512 * 1024);
    expect(Buffer.byteLength(prompt, "utf8")).toBe(512 * 1024);

    expect(() => buildCliLaunchSpec({ ...validOptions(), prompt })).toThrow(
      /ProcessHost start request must not exceed 1048576 UTF-8 bytes/u,
    );
  });
});
