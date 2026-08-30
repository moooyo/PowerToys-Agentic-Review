import { describe, expect, it } from "vitest";

import { buildReadOnlyCodexExecLaunchSpec } from "./launch-spec.js";

describe("buildReadOnlyCodexExecLaunchSpec", () => {
  it("builds a shell-free, read-only invocation with the prompt on stdin", () => {
    const prompt = "Review this revision; & echo must remain ordinary prompt text.";
    const spec = buildReadOnlyCodexExecLaunchSpec({
      executable: "C:\\Tools\\codex.exe",
      workingDirectory: "C:\\work\\checkout",
      prompt,
      outputSchemaPath: "C:\\work\\control\\schema.json",
      outputLastMessagePath: "C:\\work\\control\\result.json",
      environment: { CODEX_HOME: "C:\\service\\codex" },
      limits: {
        hardTimeoutMs: 900_000,
        maximumProcessCount: 64,
        maximumMemoryBytes: 8_589_934_592,
        maximumOutputBytes: 67_108_864,
      },
    });

    expect(spec).toEqual({
      executable: "C:\\Tools\\codex.exe",
      arguments: [
        "exec",
        "-",
        "--json",
        "--color",
        "never",
        "--output-schema",
        "C:\\work\\control\\schema.json",
        "--output-last-message",
        "C:\\work\\control\\result.json",
        "--sandbox",
        "read-only",
      ],
      workingDirectory: "C:\\work\\checkout",
      environment: { CODEX_HOME: "C:\\service\\codex" },
      standardInput: prompt,
      limits: {
        hardTimeoutMs: 900_000,
        maximumProcessCount: 64,
        maximumMemoryBytes: 8_589_934_592,
        maximumOutputBytes: 67_108_864,
      },
    });
    expect(spec.arguments).not.toContain(prompt);
  });

  it("does not retain mutable environment or limits objects", () => {
    const environment: Record<string, string> = { CODEX_HOME: "first" };
    const limits = { hardTimeoutMs: 1_000 };
    const spec = buildReadOnlyCodexExecLaunchSpec({
      workingDirectory: "C:\\work",
      prompt: "Review the checkout.",
      outputSchemaPath: "C:\\schema.json",
      outputLastMessagePath: "C:\\result.json",
      environment,
      limits,
    });

    environment.CODEX_HOME = "second";
    limits.hardTimeoutMs = 2_000;

    expect(spec.environment.CODEX_HOME).toBe("first");
    expect(spec.limits.hardTimeoutMs).toBe(1_000);
  });

  it("rejects invalid limits and NUL-containing paths", () => {
    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        workingDirectory: "C:\\work\0outside",
        prompt: "Review the checkout.",
        outputSchemaPath: "C:\\schema.json",
        outputLastMessagePath: "C:\\result.json",
        limits: { hardTimeoutMs: 1_000 },
      }),
    ).toThrow(TypeError);

    expect(() =>
      buildReadOnlyCodexExecLaunchSpec({
        workingDirectory: "C:\\work",
        prompt: "Review the checkout.",
        outputSchemaPath: "C:\\schema.json",
        outputLastMessagePath: "C:\\result.json",
        limits: { hardTimeoutMs: 0 },
      }),
    ).toThrow(RangeError);
  });
});
