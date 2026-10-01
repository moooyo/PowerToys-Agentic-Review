import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  investigationExecutionDurationExhausted,
  ResumeTaskButton,
  resumeBudget,
  resumeBudgetErrors,
  resumeBudgetRevision,
} from "./resume-task";
import { createSampleInvestigationApi } from "./sample-adapter";

const previous = {
  maxRounds: 1,
  maxDurationMs: 300_000,
  maxTokens: 20_000,
  maxReportBytes: 8 * 1024 * 1024,
};
const inputs = { maxReportBytes: "8" };

describe("resume budget preparation", () => {
  it("omits an unchanged report capacity during legacy completed delivery recovery", () => {
    const legacy = { ...previous, maxDurationMs: 4 * 60 * 60 * 1000 };
    const consumed = {
      rounds: 1,
      durationMs: 3 * 60 * 60 * 1000,
      tokens: 50_000,
      reportBytes: 1,
    };
    const original = structuredClone({ budget: legacy, consumed });
    expect(resumeBudgetRevision(inputs, legacy, consumed, true)).toBeUndefined();
    expect({ budget: legacy, consumed }).toEqual(original);
  });

  it("sends a normalized budget revision only when report capacity increases", () => {
    const legacy = { ...previous, maxDurationMs: 4 * 60 * 60 * 1000 };
    const consumed = { rounds: 1, durationMs: 900_000, tokens: 50_000, reportBytes: 1 };
    expect(resumeBudgetRevision({ maxReportBytes: "16" }, legacy, consumed)).toEqual({
      maxDurationMs: 7_200_000,
      maxReportBytes: 16 * 1024 * 1024,
    });
  });

  it("checks exhausted execution before omitting an unchanged report capacity", () => {
    const consumed = { rounds: 1, durationMs: 7_200_000, tokens: 50_000, reportBytes: 1 };
    expect(() => resumeBudgetRevision(inputs, previous, consumed)).toThrow("2-hour");
  });

  it("keeps report capacity and replaces legacy limits with the fixed duration", () => {
    expect(resumeBudget(inputs, previous)).toEqual({
      maxDurationMs: 7_200_000,
      maxReportBytes: previous.maxReportBytes,
    });
    expect(() => resumeBudget({ maxReportBytes: "7" }, previous)).toThrow("saved limit");
    expect(() => resumeBudget({ maxReportBytes: "Infinity" }, previous)).toThrow();
    expect(() => resumeBudget({ maxReportBytes: "0.0000001" }, previous)).toThrow();
    expect(resumeBudgetErrors({ maxReportBytes: "" }, previous).maxReportBytes).toBeDefined();
  });

  it("increases report capacity while preserving the frozen source and consumed checkpoint", async () => {
    const api = createSampleInvestigationApi();
    const original = await api.task("sample-pr-partial-task");
    const budget = resumeBudget(
      { maxReportBytes: String((original.task.budget.maxReportBytes * 2) / (1024 * 1024)) },
      original.task.budget,
      original.checkpoint?.consumed,
    );
    const resumed = await api.resumeTask(original.task.id, "increase-budget", budget);
    expect(resumed.budget).toEqual(budget);
    expect(resumed.subjects).toEqual(original.task.subjects);
    expect(resumed.scope).toEqual(original.task.scope);
    expect(resumed.profileRef).toEqual(original.task.profileRef);
    expect(resumed.promptRef).toEqual(original.task.promptRef);
    expect((await api.task(original.task.id)).checkpoint).toEqual(original.checkpoint);
    await expect(
      api.resumeTask(original.task.id, "increase-budget", {
        ...budget,
        maxReportBytes: budget.maxReportBytes + 1,
      }),
    ).rejects.toThrow("different budget");
  });

  it("ignores legacy token, round, and duration limits but requires enough report capacity", () => {
    const consumed = {
      rounds: 50,
      durationMs: 900_000,
      tokens: 5_000_000,
      reportBytes: previous.maxReportBytes,
    };
    expect(resumeBudgetErrors(inputs, previous, consumed)).toEqual({});
    expect(resumeBudget(inputs, previous, consumed).maxDurationMs).toBe(7_200_000);
    const exceeded = { ...consumed, reportBytes: previous.maxReportBytes + 1 };
    expect(resumeBudgetErrors(inputs, previous, exceeded)).toEqual({
      maxReportBytes: expect.stringContaining("recorded usage"),
    });
    expect(() => resumeBudget(inputs, previous, exceeded)).toThrow("report size limit");
    expect(resumeBudget({ maxReportBytes: "9" }, previous, exceeded).maxReportBytes).toBe(
      9 * 1024 * 1024,
    );
  });

  it.each([7_200_000, 7_200_001])(
    "never adds execution time after %s ms is consumed",
    (durationMs) => {
      const consumed = { rounds: 0, durationMs, tokens: 0, reportBytes: 0 };
      const increased = { maxReportBytes: "16" };
      expect(resumeBudgetErrors(increased, previous, consumed).execution).toContain(
        "cannot be reset",
      );
      expect(() => resumeBudget(increased, previous, consumed)).toThrow("2-hour");
      expect(
        investigationExecutionDurationExhausted({ consumed, stopReason: "budget_exhausted" }),
      ).toBe(true);
    },
  );

  it("keeps completed report delivery available at the execution limit", () => {
    const consumed = { rounds: 1, durationMs: 7_200_000, tokens: 50_000, reportBytes: 1 };
    expect(investigationExecutionDurationExhausted({ consumed, stopReason: "complete" })).toBe(
      false,
    );
    expect(resumeBudgetErrors(inputs, previous, consumed, true)).toEqual({});
    expect(resumeBudget(inputs, previous, consumed, true).maxDurationMs).toBe(7_200_000);
    expect(investigationExecutionDurationExhausted(null)).toBe(false);
  });

  it("disables execution recovery directly in the control even when permissions allow it", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-partial-task");
    if (!detail.checkpoint) throw new Error("A checkpoint fixture is required.");
    const html = renderToStaticMarkup(
      createElement(ResumeTaskButton, {
        task: detail.task,
        checkpoint: {
          ...detail.checkpoint,
          stopReason: "budget_exhausted",
          consumed: { ...detail.checkpoint.consumed, durationMs: 7_200_000 },
        },
        disabled: false,
        onResumed: vi.fn(),
      }),
    );
    expect(html).toContain("disabled");
    expect(html).toContain("The 2-hour total execution limit is exhausted");
  });
});
