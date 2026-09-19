import {
  createInvestigationPreview,
  emptyInvestigationTaskProgress,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import {
  beginInvestigationProgress,
  investigationTaskProgress,
  recordInvestigationActivity,
  recordInvestigationCleanup,
  recordInvestigationHeartbeat,
  recordMeaningfulInvestigationProgress,
} from "../../dist/investigation/task-progress.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const time = (seconds: number) => new Date(Date.UTC(2026, 8, 19, 0, 0, seconds)).toISOString();

describe("persisted task activity", () => {
  it("separates heartbeat, stage duration, tool activity, and accepted semantic progress", () => {
    const store = new InvestigationStore();
    stores.push(store);
    expect(investigationTaskProgress(store, "task")).toEqual(emptyInvestigationTaskProgress());
    beginInvestigationProgress(store, "task", "attempt");
    const lease = { attemptId: "attempt", fence: 1, leaseToken: "private" };
    recordInvestigationActivity(
      store,
      "task",
      { lease, sequence: 1, kind: "stage", stage: "model" },
      time(1),
    );
    recordInvestigationHeartbeat(store, "task", "attempt", time(2));
    expect(investigationTaskProgress(store, "task")).toEqual({
      stage: "model",
      stageStartedAt: time(1),
      lastActivityAt: time(1),
      lastMeaningfulProgressAt: null,
      lastHeartbeatAt: time(2),
    });
    recordInvestigationActivity(
      store,
      "task",
      { lease, sequence: 2, kind: "activity", stage: "model" },
      time(3),
    );
    recordMeaningfulInvestigationProgress(store, "task", "attempt", time(4));
    const retained = investigationTaskProgress(store, "task");
    expect(retained).toMatchObject({
      stageStartedAt: time(1),
      lastActivityAt: time(3),
      lastMeaningfulProgressAt: time(4),
    });
    recordInvestigationActivity(
      store,
      "task",
      { lease, sequence: 1, kind: "stage", stage: "prepare_source" },
      time(5),
    );
    expect(investigationTaskProgress(store, "task")).toEqual(retained);
    recordInvestigationActivity(
      store,
      "task",
      { lease, sequence: 3, kind: "stage", stage: "validate_result" },
      time(6),
    );
    expect(investigationTaskProgress(store, "task")).toMatchObject({
      stageStartedAt: time(6),
      lastActivityAt: time(6),
      lastHeartbeatAt: time(2),
      stageDurationsMs: { model: 5_000 },
    });
    expect(JSON.stringify(store.get("idempotency", "task-progress:task"))).not.toContain("private");
  });

  it("accumulates repeated stages once, closes cleanup, and retains completed totals across attempts", () => {
    const store = new InvestigationStore();
    stores.push(store);
    beginInvestigationProgress(store, "task", "first");
    const lease = { attemptId: "first", fence: 1, leaseToken: "private" };
    const stage = (
      sequence: number,
      name: "prepare_source" | "model" | "cleanup",
      seconds: number,
    ) =>
      recordInvestigationActivity(
        store,
        "task",
        { lease, sequence, kind: "stage", stage: name },
        time(seconds),
      );
    stage(1, "prepare_source", 0);
    stage(2, "model", 3);
    stage(2, "model", 9);
    expect(investigationTaskProgress(store, "task").stageDurationsMs).toEqual({
      prepare_source: 3_000,
    });
    stage(3, "prepare_source", 10);
    stage(4, "model", 12);
    stage(5, "cleanup", 20);
    recordInvestigationCleanup(store, "task", "first", time(22));
    const completed = investigationTaskProgress(store, "task");
    expect(completed.stageDurationsMs).toEqual({
      prepare_source: 5_000,
      model: 15_000,
      cleanup: 2_000,
    });
    recordInvestigationCleanup(store, "task", "first", time(30));
    stage(6, "cleanup", 31);
    expect(investigationTaskProgress(store, "task")).toEqual(completed);
    beginInvestigationProgress(store, "task", "second");
    expect(investigationTaskProgress(store, "task").stageDurationsMs).toEqual(
      completed.stageDurationsMs,
    );
    const secondLease = { ...lease, attemptId: "second", fence: 2 };
    recordInvestigationActivity(
      store,
      "task",
      { lease: secondLease, sequence: 1, kind: "stage", stage: "model" },
      time(32),
    );
    beginInvestigationProgress(store, "task", "third");
    expect(investigationTaskProgress(store, "task").stageDurationsMs).toEqual(
      completed.stageDurationsMs,
    );
  });

  it("does not invent missing historical timings or an unknown interval start", () => {
    const store = new InvestigationStore();
    stores.push(store);
    store.put("idempotency", "task-progress:task", {
      attemptId: "attempt",
      sequence: 1,
      progress: { ...emptyInvestigationTaskProgress(), stage: "model" },
    });
    const lease = { attemptId: "attempt", fence: 1, leaseToken: "private" };
    recordInvestigationActivity(
      store,
      "task",
      { lease, sequence: 2, kind: "stage", stage: "cleanup" },
      time(5),
    );
    expect(investigationTaskProgress(store, "task").stageDurationsMs).toBeUndefined();
    recordInvestigationCleanup(store, "task", "attempt", time(8));
    expect(investigationTaskProgress(store, "task").stageDurationsMs).toEqual({ cleanup: 3_000 });
  });

  it("closes a static cleanup at the actual acknowledgement after its terminal resource release", () => {
    const store = new InvestigationStore();
    stores.push(store);
    const original = createInvestigationPreview("pr", { findingCount: 0 }).task;
    const task = { ...original, state: "queued" as const, latestReportRef: null };
    const base = Date.parse(time(0));
    let now = base;
    let id = 0;
    const service = new InvestigationService({
      store,
      now: () => new Date(now),
      leaseDurationMs: 1_000,
      idFactory: () => `progress-${++id}`,
    });
    store.insert("tasks", task.id, task);
    store.insert("idempotency", `input:${task.id}`, {
      inputSnapshot: {
        schemaVersion: "InvestigationInputSnapshotV1",
        repositoryId: task.repository.id,
        workItemId: task.workItem.id,
        subjectRef: task.subjectRef,
        subjectRevisionKey: task.subjects[0]!.revisionKey,
        title: task.workItem.title,
        body: "Synthetic phase timing test.",
        comments: [],
        source: null,
      },
      plan: null,
      execution: null,
    });
    const worker = { id: "worker", repositoryIds: [task.repository.id] };
    const claim = service.workerClaim(worker, { supportedKinds: ["pr-review"] }).claim!;
    service.workerProgress(worker, task.id, {
      lease: claim.lease,
      sequence: 1,
      kind: "stage",
      stage: "model",
    });
    now = base + 2_000;
    service.reapExpiredLeases();
    expect(store.get<{ state: string }>("resourceLeases", claim.attempt.id)?.state).toBe(
      "released",
    );
    now = base + 3_000;
    service.workerProgress(worker, task.id, {
      lease: claim.lease,
      sequence: 2,
      kind: "stage",
      stage: "cleanup",
    });
    now = base + 6_000;
    const request = {
      lease: claim.lease,
      ownedProcessesStopped: true as const,
      desktopRestored: true as const,
    };
    service.workerCleanup(worker, task.id, request);
    const completed = investigationTaskProgress(store, task.id);
    expect(completed.stageDurationsMs).toEqual({ model: 3_000, cleanup: 3_000 });
    expect(completed.lastActivityAt).toBe(time(6));
    now = base + 9_000;
    service.workerCleanup(worker, task.id, request);
    expect(investigationTaskProgress(store, task.id)).toEqual(completed);
  });

  it("resets attempt activity on resume while preserving the last actual task progress", () => {
    const store = new InvestigationStore();
    stores.push(store);
    beginInvestigationProgress(store, "task", "first");
    recordInvestigationHeartbeat(store, "task", "first", time(1));
    recordMeaningfulInvestigationProgress(store, "task", "first", time(2));
    beginInvestigationProgress(store, "task", "second");
    recordInvestigationCleanup(store, "task", "first", time(3));
    expect(investigationTaskProgress(store, "task")).toEqual({
      ...emptyInvestigationTaskProgress(),
      lastMeaningfulProgressAt: time(2),
    });
  });
});
