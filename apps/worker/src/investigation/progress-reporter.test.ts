import { emptyInvestigationTaskProgress } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { InvestigationWorkerClient } from "./http-client.js";
import { createInvestigationProgressReporter } from "./progress-reporter.js";

describe("bounded task progress reporting", () => {
  it("serializes stage changes and throttles observed tool activity without inventing progress", async () => {
    let now = 0;
    const progress = vi.fn<NonNullable<InvestigationWorkerClient["progress"]>>(async () => ({
      progress: emptyInvestigationTaskProgress(),
    }));
    const lease = { attemptId: "attempt", fence: 1, leaseToken: "private" };
    const reporter = createInvestigationProgressReporter({
      client: { progress },
      taskId: "task",
      lease,
      now: () => now,
    });
    await reporter.reportProgress("prepare_source");
    await reporter.reportProgress("model");
    reporter.onActivity({ kind: "model", event: "model.dispatched" });
    reporter.onActivity({ kind: "tool", event: "item.started:command_execution" });
    await reporter.flush();
    now = 500;
    reporter.onActivity({ kind: "tool", event: "item.completed:command_execution" });
    await reporter.flush();
    expect(progress).toHaveBeenCalledTimes(3);
    now = 1_000;
    reporter.onActivity({ kind: "tool", event: "item.started:command_execution" });
    await reporter.reportProgress("validate_result");
    await reporter.flush();
    expect(progress.mock.calls.map((call) => call[1])).toEqual([
      { lease, sequence: 1, kind: "stage", stage: "prepare_source" },
      { lease, sequence: 2, kind: "stage", stage: "model" },
      { lease, sequence: 3, kind: "activity", stage: "model" },
      { lease, sequence: 4, kind: "activity", stage: "model" },
      { lease, sequence: 5, kind: "stage", stage: "validate_result" },
    ]);
  });

  it("does not let unavailable telemetry or an observer exception fail the task", async () => {
    const progress = vi.fn<NonNullable<InvestigationWorkerClient["progress"]>>(async () => {
      throw new Error("Offline");
    });
    const reporter = createInvestigationProgressReporter({
      client: { progress },
      taskId: "task",
      lease: { attemptId: "attempt", fence: 1, leaseToken: "private" },
      onFailure: () => {
        throw new Error("Observer failure");
      },
    });
    await expect(reporter.reportProgress("model")).resolves.toBeUndefined();
    reporter.onActivity({ kind: "model", event: "model.dispatched" });
    await expect(reporter.flush()).resolves.toBeUndefined();
    const legacy = createInvestigationProgressReporter({
      client: {},
      taskId: "task",
      lease: { attemptId: "attempt", fence: 1, leaseToken: "private" },
    });
    await expect(legacy.reportProgress("model")).resolves.toBeUndefined();
  });
});
