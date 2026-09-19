import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  InvestigationModelInvocationReceiptSchema,
  InvestigationTokenUsageSchema,
  unavailableInvestigationTokenUsage,
  validateInvestigationTokenUsage,
} from "./investigation-usage.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

describe("model invocation usage contracts", () => {
  it("keeps unreported fields unknown and permits a provider total without a breakdown", () => {
    const usage = unavailableInvestigationTokenUsage();
    expect(usage.inputTokens).toBeNull();
    expect(Value.Check(InvestigationTokenUsageSchema, usage)).toBe(true);
    usage.totalTokens = 91;
    expect(validateInvestigationTokenUsage(usage)).toBe(true);
  });

  it("counts input and output once while checking cache and reasoning subdivisions", () => {
    const usage = {
      ...unavailableInvestigationTokenUsage(),
      inputTokens: 100,
      cachedReadTokens: 80,
      outputTokens: 40,
      reasoningTokens: 20,
      totalTokens: 140,
    };
    expect(validateInvestigationTokenUsage(usage)).toBe(true);
    expect(validateInvestigationTokenUsage({ ...usage, totalTokens: 240 })).toBe(false);
    expect(validateInvestigationTokenUsage({ ...usage, cachedReadTokens: 101 })).toBe(false);
    expect(validateInvestigationTokenUsage({ ...usage, reasoningTokens: 41 })).toBe(false);
  });

  it("rejects unsafe and fabricated token counts", () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "unknown"]) {
      expect(
        Value.Check(InvestigationTokenUsageSchema, {
          ...unavailableInvestigationTokenUsage(),
          totalTokens: value,
        }),
      ).toBe(false);
    }
    expect(
      validateInvestigationTokenUsage({
        ...unavailableInvestigationTokenUsage(),
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
      }),
    ).toBe(false);
  });

  it("binds the receipt to a single task, attempt, engine, purpose and model", () => {
    const receipt = {
      invocationId: "invocation-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      purpose: "analysis",
      engine: "codex",
      model: null,
      startedAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
      revision: 1,
      state: "registered",
      disposition: "pending",
      completeness: "unavailable",
      usage: unavailableInvestigationTokenUsage(),
    };
    expect(Value.Check(InvestigationModelInvocationReceiptSchema, receipt)).toBe(true);
    expect(
      Value.Check(InvestigationModelInvocationReceiptSchema, { ...receipt, revision: 0 }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationModelInvocationReceiptSchema, { ...receipt, apiKey: "secret" }),
    ).toBe(false);
  });
});
