import type { InvestigationSchedulerStatus } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { elapsedTime, TaskProgressPanel, taskQueueReason } from "./task-progress";

const scheduler: InvestigationSchedulerStatus = {
  staticConcurrency: 2,
  e2eConcurrency: 1,
  occupiedStatic: 2,
  occupiedE2e: 1,
  leases: [],
};

describe("task progress and resource waiting", () => {
  it("keeps the progress summary compact without promoting a heartbeat to model activity", () => {
    const html = renderToStaticMarkup(
      <TaskProgressPanel
        compact
        task={{ kind: "pr-review", state: "running", updatedAt: "2026-09-19T01:02:00Z" }}
        invocations={[]}
        progress={{
          stage: "prepare_source",
          stageStartedAt: null,
          lastActivityAt: null,
          lastMeaningfulProgressAt: null,
          lastHeartbeatAt: "2026-09-19T01:02:00Z",
        }}
      />,
    );
    expect(html).toContain("Preparing source");
    expect(html).not.toContain("Worker heartbeat");
    expect(html).not.toContain("Recorded stage totals");
    expect(html).not.toContain("Model call running");
  });

  it.each([
    ["completed", "model", "Execution finished"],
    ["completed", "cleanup", "Execution finished"],
    ["cancelled", "model", "Execution stopped"],
    ["failed", "model", "Execution stopped"],
    ["blocked", "prepare_source", "Execution stopped"],
    ["interrupted", "model", "Execution stopped"],
  ] as const)(
    "shows the %s execution outcome instead of the retained %s stage after resource release",
    (state, stage, outcome) => {
      const html = renderToStaticMarkup(
        <TaskProgressPanel
          compact
          task={{ id: "task", kind: "pr-e2e", state, updatedAt: "2026-09-19T01:02:00Z" }}
          progress={{
            stage,
            stageStartedAt: "2026-09-19T01:00:00Z",
            lastActivityAt: "2026-09-19T01:01:00Z",
            lastMeaningfulProgressAt: null,
            lastHeartbeatAt: null,
          }}
          resourceLeases={[
            {
              attemptId: "attempt",
              taskId: "task",
              workerId: "desktop",
              fence: 1,
              pool: "e2e",
              state: "released",
              acquiredAt: "2026-09-19T00:59:00Z",
              updatedAt: "2026-09-19T01:02:00Z",
              releasedAt: "2026-09-19T01:02:00Z",
              reason: state,
            },
          ]}
          now={Date.parse("2026-09-19T02:00:00Z")}
        />,
      );
      expect(html).toContain(outcome);
      expect(html).toContain("At stop: 2m 0s");
      expect(html).not.toContain("Preparing source");
      expect(html).not.toContain("Model analysis");
      expect(html).not.toContain("Cleaning up");
      expect(html).not.toContain("Awaiting worker cleanup");
      expect(html).not.toContain("Elapsed");
      expect(html).not.toContain("1h");
    },
  );

  it("distinguishes static capacity from the exclusive desktop", () => {
    expect(taskQueueReason({ kind: "pr-review", state: "queued" }, scheduler)).toContain(
      "Waiting for static task capacity",
    );
    expect(taskQueueReason({ kind: "pr-e2e", state: "queued" }, scheduler)).toContain(
      "exclusive E2E desktop",
    );
    expect(
      taskQueueReason({ kind: "pr-e2e", state: "queued" }, { ...scheduler, occupiedE2e: 0 }),
    ).toContain("worker that allows E2E");
    expect(taskQueueReason({ kind: "pr-e2e", state: "running" }, scheduler)).toBeNull();
    expect(
      taskQueueReason(
        {
          kind: "pr-review",
          state: "queued",
          executionPolicy: {
            mode: "execute",
            allowedSubjectRefs: [],
            allowRepositoryExecution: true,
            authorizationRef: "legacy-authorization",
          },
        },
        { ...scheduler, occupiedE2e: 0 },
      ),
    ).toContain("worker that allows E2E");
  });

  it("keeps a pending desktop cleanup visible even after cancellation", () => {
    const reason = taskQueueReason(
      { kind: "pr-e2e", state: "queued" },
      {
        ...scheduler,
        leases: [
          {
            attemptId: "old-attempt",
            taskId: "cancelled-task",
            workerId: "desktop",
            fence: 1,
            pool: "e2e",
            state: "needs_cleanup",
            acquiredAt: "2026-09-19T01:00:00Z",
            updatedAt: "2026-09-19T01:01:00Z",
            releasedAt: null,
            reason: "cancelled",
          },
        ],
      },
    );
    expect(reason).toContain("cleanup confirmation");
  });

  it("does not infer model progress from a fresh worker heartbeat", () => {
    const html = renderToStaticMarkup(
      <TaskProgressPanel
        task={{ kind: "pr-review", state: "running", updatedAt: "2026-09-19T01:02:00Z" }}
        progress={{
          stage: "model",
          stageStartedAt: "2026-09-19T01:00:00Z",
          lastActivityAt: null,
          lastMeaningfulProgressAt: null,
          lastHeartbeatAt: "2026-09-19T01:02:00Z",
        }}
        now={Date.parse("2026-09-19T01:02:05Z")}
      />,
    );
    expect(html).toContain("Model analysis");
    expect(html).toContain("2m 5s");
    expect(html).toContain("Not reported");
    expect(html).toContain("Recorded stage timings are unavailable");
  });

  it("shows only recorded phase totals without filling unknown phases with zero", () => {
    const html = renderToStaticMarkup(
      <TaskProgressPanel
        task={{ kind: "pr-review", state: "completed", updatedAt: "2026-09-19T01:20:00Z" }}
        progress={{
          stage: "cleanup",
          stageStartedAt: null,
          lastActivityAt: null,
          lastMeaningfulProgressAt: null,
          lastHeartbeatAt: null,
          stageDurationsMs: { prepare_source: 17 * 60_000, model: 9 * 60_000, cleanup: 450 },
        }}
      />,
    );
    expect(html).toContain("Recorded stage totals");
    expect(html).toContain("Preparing source: 17m 0s");
    expect(html).toContain("Model analysis: 9m 0s");
    expect(html).toContain("Cleaning up: 450ms");
    expect(html).not.toContain("Saving analysis: 0");
    expect(html).toContain("Activity timing unavailable");
  });

  it("stops elapsed counters when the task is terminal and retains unknown timestamps", () => {
    expect(elapsedTime(null, Date.now())).toBe("Unknown");
    const html = renderToStaticMarkup(
      <TaskProgressPanel
        task={{ kind: "pr-review", state: "cancelled", updatedAt: "2026-09-19T01:02:00Z" }}
        progress={{
          stage: "model",
          stageStartedAt: "2026-09-19T01:00:00Z",
          lastActivityAt: null,
          lastMeaningfulProgressAt: null,
          lastHeartbeatAt: null,
        }}
        now={Date.parse("2026-09-19T02:00:00Z")}
      />,
    );
    expect(html).toContain("2m 0s");
    expect(html).not.toContain("1h");
  });

  it("keeps cleanup time live until the terminal task releases its desktop", () => {
    const task = {
      id: "task",
      kind: "pr-e2e" as const,
      state: "completed" as const,
      updatedAt: "2026-09-19T01:00:00Z",
    };
    const progress = {
      stage: "cleanup" as const,
      stageStartedAt: "2026-09-19T01:00:01Z",
      lastActivityAt: "2026-09-19T01:00:01Z",
      lastMeaningfulProgressAt: null,
      lastHeartbeatAt: null,
    };
    const html = renderToStaticMarkup(
      <TaskProgressPanel
        task={task}
        progress={progress}
        resourceLeases={[
          {
            attemptId: "attempt",
            taskId: "task",
            workerId: "desktop",
            fence: 1,
            pool: "e2e",
            state: "needs_cleanup",
            acquiredAt: "2026-09-19T00:59:00Z",
            updatedAt: task.updatedAt,
            releasedAt: null,
            reason: "completed",
          },
        ]}
        now={Date.parse("2026-09-19T01:00:11Z")}
      />,
    );
    expect(html).toContain("Current stage elapsed");
    expect(html).toContain("10s");
    const compact = renderToStaticMarkup(
      <TaskProgressPanel
        task={task}
        progress={progress}
        compact
        now={Date.parse("2026-09-19T01:00:11Z")}
        resourceLeases={[
          {
            attemptId: "attempt",
            taskId: "task",
            workerId: "desktop",
            fence: 1,
            pool: "e2e",
            state: "needs_cleanup",
            acquiredAt: "2026-09-19T00:59:00Z",
            updatedAt: task.updatedAt,
            releasedAt: null,
            reason: "completed",
          },
        ]}
      />,
    );
    expect(compact).toContain("Awaiting worker cleanup");
    expect(compact).toContain("Elapsed");
    expect(compact).not.toContain("Execution finished");
    expect(compact).not.toContain("Execution stopped");
    expect(compact).not.toContain("Task complete");
  });
});
