import {
  type InvestigationModelInvocationReceipt,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { InvestigationStore } from "../../dist/investigation/store.js";
import {
  investigationUsageInvocations,
  investigationUsageSummary,
  recordInvestigationUsage,
} from "../../dist/investigation/usage-ledger.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function store(): InvestigationStore {
  const result = new InvestigationStore();
  stores.push(result);
  return result;
}
function registration(
  invocationId = "call-1",
  attemptId = "attempt-1",
): InvestigationModelInvocationReceipt {
  return {
    invocationId,
    taskId: "task-1",
    attemptId,
    purpose: "analysis",
    engine: "codex",
    model: "configured-model",
    startedAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    revision: 1,
    state: "registered",
    disposition: "pending",
    completeness: "unavailable",
    usage: unavailableInvestigationTokenUsage(),
  };
}
function completion(
  receipt: InvestigationModelInvocationReceipt,
  tokens = 50,
): InvestigationModelInvocationReceipt {
  return {
    ...receipt,
    revision: 2,
    state: "completed",
    disposition: "accepted",
    completeness: "complete",
    usage: {
      ...unavailableInvestigationTokenUsage(),
      inputTokens: tokens - 10,
      cachedReadTokens: 7,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: tokens,
    },
  };
}

describe("durable investigation usage ledger", () => {
  it("projects a proven empty historical baseline without rewriting its original uncertainty", () => {
    const s = store();
    const first = registration();
    recordInvestigationUsage(s, first, 0, true);
    recordInvestigationUsage(s, completion(first), 0, true);
    expect(investigationUsageSummary(s, first.taskId).completeness).toBe("partial");
    expect(investigationUsageSummary(s, first.taskId, 0, false, true)).toMatchObject({
      completeness: "complete",
      reportedTokens: 50,
      usage: { inputTokens: 40, cachedReadTokens: 7, outputTokens: 10, totalTokens: 50 },
    });
    expect(investigationUsageSummary(s, first.taskId).completeness).toBe("partial");
  });

  it("does not use a no-dispatch proof to reconstruct a nonzero legacy token breakdown", () => {
    const s = store();
    const first = registration();
    recordInvestigationUsage(s, first, 100, true);
    recordInvestigationUsage(s, completion(first), 100, true);
    expect(investigationUsageSummary(s, first.taskId, 0, false, true)).toMatchObject({
      completeness: "partial",
      reportedTokens: 150,
      legacyTokens: 100,
      usage: { inputTokens: null, cachedReadTokens: null, totalTokens: null },
    });
  });
  it("registers its date-time validator independently of report or import initialization", () => {
    FormatRegistry.Delete("date-time");
    const s = store();
    expect(recordInvestigationUsage(s, registration(), 0).receipt.revision).toBe(1);
    expect(() =>
      recordInvestigationUsage(s, { ...registration("invalid-date"), startedAt: "not-a-date" }, 0),
    ).toThrow(/invalid/u);
  });
  it("registers before execution and preserves partial unknown usage", () => {
    const s = store();
    const first = registration();
    expect(() => recordInvestigationUsage(s, completion(first), 0)).toThrow(/registered/u);
    const registered = recordInvestigationUsage(s, first, 0);
    expect(registered.summary).toMatchObject({
      reportedTokens: 0,
      completeness: "unavailable",
      activeInvocationCount: 1,
    });
    expect(registered.summary.usage.totalTokens).toBeNull();
    recordInvestigationUsage(
      s,
      {
        ...completion(first),
        state: "cancelled",
        disposition: "rejected",
        completeness: "partial",
      },
      0,
    );
    expect(investigationUsageSummary(s, first.taskId)).toMatchObject({
      reportedTokens: 50,
      completeness: "partial",
      unknownInvocationCount: 1,
      activeInvocationCount: 0,
      usage: { totalTokens: null, cachedReadTokens: 7 },
    });
  });

  it("deduplicates every revision including an old retry after finalization", () => {
    const s = store();
    const first = registration();
    const final = completion(first);
    recordInvestigationUsage(s, first, 0);
    recordInvestigationUsage(s, final, 0);
    expect(recordInvestigationUsage(s, first, 500).duplicate).toBe(true);
    expect(recordInvestigationUsage(s, final, 500).duplicate).toBe(true);
    expect(investigationUsageSummary(s, first.taskId, 500)).toMatchObject({
      reportedTokens: 50,
      legacyTokens: 0,
      invocationCount: 1,
    });
    expect(() =>
      recordInvestigationUsage(
        s,
        { ...final, usage: { ...final.usage, totalTokens: 60, inputTokens: 50 } },
        0,
      ),
    ).toThrow(/different content/u);
  });

  it("freezes the historical checkpoint once and includes rejected calls across attempts", () => {
    const s = store();
    const first = registration();
    const second = registration("call-2", "attempt-2");
    recordInvestigationUsage(s, first, 100);
    recordInvestigationUsage(s, completion(first), 150);
    recordInvestigationUsage(s, second, 150);
    recordInvestigationUsage(
      s,
      { ...completion(second, 70), state: "failed", disposition: "rejected" },
      220,
    );
    expect(investigationUsageSummary(s, "task-1", 220)).toMatchObject({
      reportedTokens: 220,
      legacyTokens: 100,
      invocationCount: 2,
      usage: { totalTokens: 220, inputTokens: null },
    });
    expect(investigationUsageInvocations(s, "task-1").map((entry) => entry.attemptId)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
  });

  it("accepts monotonic cumulative observations without adding each snapshot", () => {
    const s = store();
    const first = registration();
    recordInvestigationUsage(s, first, 0);
    const partial = {
      ...completion(first),
      state: "running" as const,
      disposition: "pending" as const,
      completeness: "partial" as const,
    };
    recordInvestigationUsage(s, partial, 0);
    const final = { ...completion(first, 90), revision: 3 };
    expect(recordInvestigationUsage(s, final, 0).summary).toMatchObject({
      reportedTokens: 90,
      usage: { totalTokens: 90, inputTokens: 80, cachedReadTokens: 7 },
    });
  });

  it("rejects identity changes, gaps, regressions, and mutation of completed counters", () => {
    const s = store();
    const first = registration();
    recordInvestigationUsage(s, first, 0);
    expect(() =>
      recordInvestigationUsage(s, { ...completion(first), attemptId: "other" }, 0),
    ).toThrow(/identity/u);
    expect(() => recordInvestigationUsage(s, { ...completion(first), revision: 3 }, 0)).toThrow(
      /order/u,
    );
    const final = completion(first);
    recordInvestigationUsage(s, final, 0);
    expect(() => recordInvestigationUsage(s, { ...completion(first, 70), revision: 3 }, 0)).toThrow(
      /consumption/u,
    );
    expect(() =>
      recordInvestigationUsage(s, { ...final, revision: 3, state: "running" }, 0),
    ).toThrow(/terminal/u);
    expect(() =>
      recordInvestigationUsage(s, { ...final, revision: 3, disposition: "rejected" }, 0),
    ).toThrow(/disposition/u);
  });

  it("works inside the caller transaction and rolls back receipts and baselines together", () => {
    const s = store();
    const first = registration();
    expect(() =>
      s.transaction(() => {
        recordInvestigationUsage(s, first, 100);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(investigationUsageInvocations(s, first.taskId)).toEqual([]);
    expect(recordInvestigationUsage(s, first, 0).summary.legacyTokens).toBe(0);
  });
});
