import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  CliModelConfigurationSchema,
  type CliModelExecutionV1,
  CliModelExecutionV1Schema,
  getCliModelExecutionIssues,
} from "./cli-model-execution.js";

function execution(): CliModelExecutionV1 {
  return {
    schemaVersion: "CliModelExecutionV1",
    jobId: "job-1",
    runAttemptId: "attempt-1",
    cli: { kind: "codex", version: "1.0.0", requestedModel: null },
    promptSha256: "a".repeat(64),
    outputSchemaSha256: "b".repeat(64),
    outputSha256: "c".repeat(64),
    exitCode: 0,
  };
}

function summaryExecution(): CliModelExecutionV1 {
  const value = execution();
  value.summaryInputRef = {
    schemaVersion: "ValidationSummaryInputReferenceV1",
    inputId: "summary-input-1",
    inputSha256: "d".repeat(64),
    sourcePromptSha256: "e".repeat(64),
    outputSchemaSha256: value.outputSchemaSha256,
    contextSha256: "f".repeat(64),
    actualPromptSha256: value.promptSha256,
  };
  return value;
}

describe("CLI model configuration", () => {
  it.each(["codex", "copilot"] as const)(
    "records %s with an explicit requested model or the CLI default",
    (kind) => {
      for (const requestedModel of [null, "configured-model"]) {
        const cli = { kind, version: "1.0.0", requestedModel };
        expect(Value.Check(CliModelConfigurationSchema, cli)).toBe(true);
        expect(getCliModelExecutionIssues({ ...execution(), cli })).toEqual([]);
      }
    },
  );

  it.each(["kind", "version", "requestedModel"])("requires CLI field %s", (field) => {
    const cli: Record<string, unknown> = { ...execution().cli };
    delete cli[field];
    expect(Value.Check(CliModelConfigurationSchema, cli)).toBe(false);
  });

  it.each([
    { kind: "other" },
    { version: "" },
    { version: " 1.0.0" },
    { version: "1.0.0\n" },
    { version: "x".repeat(129) },
    { requestedModel: "" },
    { requestedModel: "model " },
    { requestedModel: "model\u0000name" },
    { requestedModel: "x".repeat(129) },
    { hidden: true },
  ])("rejects malformed CLI configuration %j", (changes) => {
    const cli = { ...execution().cli, ...changes };
    expect(Value.Check(CliModelConfigurationSchema, cli)).toBe(false);
    expect(getCliModelExecutionIssues({ ...execution(), cli }).length).toBeGreaterThan(0);
  });
});

describe("CLI model execution metadata", () => {
  it("retains the job attempt and exact input and output digests without mutation", () => {
    const value = execution();
    const original = structuredClone(value);
    expect(Value.Check(CliModelExecutionV1Schema, value)).toBe(true);
    expect(getCliModelExecutionIssues(value)).toEqual([]);
    expect(value).toEqual(original);
  });

  it.each([
    "schemaVersion",
    "jobId",
    "runAttemptId",
    "cli",
    "promptSha256",
    "outputSchemaSha256",
    "outputSha256",
    "exitCode",
  ])("requires execution field %s", (field) => {
    const missing: Record<string, unknown> = { ...execution() };
    delete missing[field];
    expect(Value.Check(CliModelExecutionV1Schema, missing)).toBe(false);
    expect(getCliModelExecutionIssues(missing).length).toBeGreaterThan(0);
  });

  it.each([
    { schemaVersion: "CliModelExecutionV2" },
    { jobId: "" },
    { runAttemptId: "attempt/1" },
    { promptSha256: "A".repeat(64) },
    { outputSchemaSha256: "a".repeat(63) },
    { outputSha256: "g".repeat(64) },
    { exitCode: 1 },
    { exitCode: null },
    { hidden: true },
  ])("rejects malformed execution metadata %j", (changes) => {
    const value = { ...execution(), ...changes };
    expect(Value.Check(CliModelExecutionV1Schema, value)).toBe(false);
    expect(getCliModelExecutionIssues(value).length).toBeGreaterThan(0);
  });

  it.each(["version", "requestedModel"] as const)(
    "rejects malformed Unicode in CLI %s",
    (field) => {
      const value = execution();
      value.cli[field] = "invalid\ud800";
      expect(getCliModelExecutionIssues(value).length).toBeGreaterThan(0);
    },
  );

  it("binds a summary to its actual prompt and output schema while retaining the source prompt", () => {
    const value = summaryExecution();
    const original = structuredClone(value);
    expect(Value.Check(CliModelExecutionV1Schema, value)).toBe(true);
    expect(getCliModelExecutionIssues(value)).toEqual([]);
    expect(value.summaryInputRef?.sourcePromptSha256).not.toBe(value.promptSha256);
    expect(value).toEqual(original);
  });

  it.each(["promptSha256", "outputSchemaSha256"] as const)(
    "rejects a summary whose %s differs from its frozen input",
    (field) => {
      const value = summaryExecution();
      value[field] = "9".repeat(64);
      expect(Value.Check(CliModelExecutionV1Schema, value)).toBe(true);
      expect(getCliModelExecutionIssues(value)).toEqual([
        "Summary execution must retain its frozen actual prompt and output schema.",
      ]);
    },
  );

  it.each([null, undefined, [], "execution"])("rejects non-record metadata %j", (value) => {
    expect(getCliModelExecutionIssues(value).length).toBeGreaterThan(0);
  });
});
