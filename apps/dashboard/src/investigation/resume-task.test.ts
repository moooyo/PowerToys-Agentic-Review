import { describe, expect, it } from "vitest";
import { resumeBudget } from "./resume-task";
import { createSampleInvestigationApi } from "./sample-adapter";

describe("resume budget preparation", () => {
  it("rejects decreases, invalid numbers, and fractional tokens", () => {
    const previous = {
      maxRounds: 8,
      maxDurationMs: 300_000,
      maxTokens: 20_000,
      maxReportBytes: 8 * 1024 * 1024,
    };
    const inputs = {
      maxRounds: "8",
      maxDurationMs: "300",
      maxTokens: "20000",
      maxReportBytes: "8",
    };
    expect(resumeBudget(inputs, previous)).toEqual(previous);
    expect(() => resumeBudget({ ...inputs, maxRounds: "7" }, previous)).toThrow();
    expect(() => resumeBudget({ ...inputs, maxTokens: "20000.5" }, previous)).toThrow();
    expect(() => resumeBudget({ ...inputs, maxDurationMs: "Infinity" }, previous)).toThrow();
  });

  it("increases only the budget while preserving the frozen source, plan, and checkpoint", async () => {
    const api = createSampleInvestigationApi();
    const original = await api.task("sample-pr-partial-task");
    const budget = { ...original.task.budget, maxRounds: original.task.budget.maxRounds * 2 };
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
        maxRounds: budget.maxRounds + 1,
      }),
    ).rejects.toThrow("different budget");
  });
});
