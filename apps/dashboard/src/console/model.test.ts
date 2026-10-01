import type {
  InvestigationCommentDelivery,
  InvestigationCommentPublicationSummary,
  InvestigationTaskV1,
  InvestigationWebhookDelivery,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSampleInvestigationApi } from "../investigation/sample-adapter";
import {
  aggregateRelatedWork,
  applyHistoricalPublication,
  assertReviewDetailBinding,
  formatDuration,
  mapIntakeFailure,
  mapReviewTask,
  readIgnoredRecordIds,
  relativeTime,
  setReviewRecordIgnored,
} from "./model";

async function fixture() {
  const api = createSampleInvestigationApi();
  const detail = await api.task("sample-pr-p1-task");
  return { task: detail.task, detail };
}

function publication(
  task: InvestigationTaskV1,
  state: InvestigationCommentPublicationSummary["state"],
): InvestigationCommentPublicationSummary {
  return {
    id: "console-result",
    version: "v1",
    mode: "result",
    repositoryId: task.repository.id,
    repositoryFullName: task.repository.fullName,
    workItemId: task.workItem.id,
    workItemKind: task.workItem.kind,
    workItemNumber: task.workItem.number,
    taskId: task.id,
    reportId: task.latestReportRef?.id ?? null,
    state,
    reasonCode: state === "needs_attention" ? "permission_denied" : null,
    reason: state === "needs_attention" ? "HTTP 403" : null,
    requiresAttention: state === "needs_attention",
    nextAttemptAt: null,
    lastAttemptAt: task.updatedAt,
    lastConfirmedAt: state === "synced" ? task.updatedAt : null,
    externalId: state === "synced" ? "1" : null,
    commentUrl:
      state === "synced" ? "https://github.com/microsoft/PowerToys/pull/1#issuecomment-1" : null,
    availableActions: [],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

describe("review console source truth", () => {
  it("does not label a completed analysis as posted without a confirmed result comment", async () => {
    const { task, detail } = await fixture();
    const record = mapReviewTask({ ...task, state: "completed" }, detail);
    expect(record.status).toBe("attention");
    expect(record.problem).toBeUndefined();
    expect(record.completedWithoutPublication).toBe(true);
    expect(record.area).toBe("");
  });

  it("uses publication confirmation rather than analysis completion to mark posted", async () => {
    const { task, detail } = await fixture();
    const completed = { ...task, state: "completed" as const };
    expect(mapReviewTask(completed, detail, [publication(task, "synced")]).status).toBe("posted");
    expect(
      mapReviewTask(completed, detail, [{ ...publication(task, "synced"), lastConfirmedAt: null }])
        .status,
    ).toBe("attention");
  });

  it("accepts a native final progress comment only when it carries the current saved report", async () => {
    const { task, detail } = await fixture();
    const completed = { ...task, state: "completed" as const };
    expect(
      mapReviewTask(completed, detail, [{ ...publication(task, "synced"), mode: "progress" }])
        .status,
    ).toBe("posted");
    expect(
      mapReviewTask(completed, detail, [
        { ...publication(task, "synced"), mode: "progress", reportId: null },
      ]).completedWithoutPublication,
    ).toBe(true);
  });

  it("does not accept an initial progress comment, old report, or matching number from another source", async () => {
    const { task, detail } = await fixture();
    const completed = { ...task, state: "completed" as const };
    const synced = publication(task, "synced");
    for (const wrong of [
      { ...synced, mode: "progress" as const, reportId: null },
      { ...synced, reportId: "previous-report" },
      { ...synced, workItemId: "another-source" },
      { ...synced, repositoryId: "another-repository" },
    ])
      expect(mapReviewTask(completed, detail, [wrong]).status).toBe("attention");
  });

  it("shows in-flight result publication without inventing progress percentages", async () => {
    const { task, detail } = await fixture();
    for (const state of ["pending", "sending", "retrying"] as const) {
      expect(
        mapReviewTask({ ...task, state: "completed" }, detail, [publication(task, state)]).status,
      ).toBe("publishing");
    }
  });

  it("keeps a live review visible even when an older result comment is confirmed", async () => {
    const { task, detail } = await fixture();
    expect(
      mapReviewTask({ ...task, state: "running" }, detail, [publication(task, "synced")]).status,
    ).toBe("running");
  });

  it("distinguishes manual cancellation from a disconnected worker", async () => {
    const { task, detail } = await fixture();
    const attempt = detail.attempts[0];
    if (!attempt) throw new Error("The fixture requires a saved execution.");
    const disconnected = {
      ...detail,
      attempts: [{ ...attempt, terminationReason: "worker heartbeat timeout" }],
    };
    expect(mapReviewTask({ ...task, state: "interrupted" }, disconnected).problem?.type).toBe(
      "worker",
    );
    expect(mapReviewTask({ ...task, state: "cancelled" }, disconnected).problem?.type).toBe(
      "stopped",
    );
  });

  it("rejects stale or foreign saved report bindings", async () => {
    const { task, detail } = await fixture();
    expect(() => mapReviewTask(task, { ...detail, task: { ...task, id: "foreign-task" } })).toThrow(
      "another review record",
    );
    const header = detail.latestReport;
    if (!header) throw new Error("The fixture requires a saved report.");
    expect(() =>
      mapReviewTask(task, { ...detail, latestReport: { ...header, version: header.version + 1 } }),
    ).toThrow("current saved report");
  });

  it("reports capacity only when scheduler occupancy proves it", async () => {
    const { task } = await fixture();
    const queued = { ...task, state: "queued" as const };
    expect(mapReviewTask(queued).queueReason).toBe("unknown");
    expect(
      mapReviewTask(queued, undefined, [], {
        staticConcurrency: 1,
        e2eConcurrency: 1,
        occupiedStatic: 1,
        occupiedE2e: 0,
        leases: [],
      }).queueReason,
    ).toBe("capacity");
  });

  it("retains an older report's posted state only from its exact successful receipt", async () => {
    const { task, detail } = await fixture();
    const newer = {
      ...publication(task, "synced"),
      taskId: "new-review",
      associatedTaskIds: [task.id, "new-review"],
      reportId: "new-report",
      mode: "progress" as const,
    };
    const old = mapReviewTask({ ...task, state: "completed" }, detail, [newer]);
    const receipt: InvestigationCommentDelivery = {
      id: "old-success",
      commentId: newer.id,
      mode: "progress",
      repositoryId: task.repository.id,
      repositoryFullName: task.repository.fullName,
      workItemId: task.workItem.id,
      workItemKind: task.workItem.kind,
      workItemNumber: task.workItem.number,
      taskId: task.id,
      reportId: task.latestReportRef?.id ?? null,
      operation: "update",
      state: "succeeded",
      body: "Old report",
      externalId: "1",
      startedAt: task.updatedAt,
      finishedAt: task.updatedAt,
      reason: null,
      effect: "applied",
      attemptNumber: 1,
      settingsVersion: 1,
      templateVersion: 1,
      legacy: false,
      observations: [],
    };
    expect(applyHistoricalPublication(old, [receipt]).status).toBe("posted");
    for (const wrong of [
      { ...receipt, reportId: "new-report" },
      { ...receipt, taskId: "new-review" },
      { ...receipt, effect: "unknown" as const },
    ])
      expect(applyHistoricalPublication(old, [wrong]).completedWithoutPublication).toBe(true);
  });

  it("aggregates active related work into one record while retaining exact child bindings", async () => {
    const { task, detail } = await fixture();
    const root = mapReviewTask({ ...task, state: "completed" }, detail, [
      publication(task, "synced"),
    ]);
    const child = mapReviewTask({
      ...task,
      id: "child",
      parentTaskId: task.id,
      kind: "pr-e2e",
      state: "running",
      latestReportRef: null,
    });
    const record = aggregateRelatedWork(root, [child]);
    expect(record.id).toBe(task.id);
    expect(record.taskId).toBe("child");
    expect(record.status).toBe("running");
    expect(record.relatedWork?.map((entry) => entry.taskId)).toEqual([task.id, "child"]);
  });

  it("does not hide current work behind a superseded failed verification", async () => {
    const { task, detail } = await fixture();
    const root = mapReviewTask({ ...task, state: "completed" }, detail, [
      publication(task, "synced"),
    ]);
    const failed = mapReviewTask({
      ...task,
      id: "old-child",
      parentTaskId: task.id,
      kind: "pr-verify",
      state: "failed",
      createdAt: "2026-09-01T00:00:00Z",
      latestReportRef: null,
    });
    const completed = mapReviewTask({
      ...task,
      id: "new-child",
      parentTaskId: task.id,
      kind: "pr-verify",
      state: "completed",
      createdAt: "2026-09-02T00:00:00Z",
      latestReportRef: null,
    });
    expect(aggregateRelatedWork(root, [failed, completed]).status).toBe("posted");
  });

  it("rejects a well-formed response for a different requested source", async () => {
    const { task, detail } = await fixture();
    expect(() =>
      assertReviewDetailBinding(task, {
        ...detail,
        task: { ...task, workItem: { ...task.workItem, id: "another-source" } },
      }),
    ).toThrow("another review record");
  });

  it("does not claim saved progress exists after a cancellation before the first save", async () => {
    const { task, detail } = await fixture();
    const record = mapReviewTask({ ...task, state: "cancelled" }, { ...detail, checkpoint: null });
    expect(record.problem?.message).toContain("before progress was saved");
  });

  it("preserves failed intake identity without fabricating an imported work item", () => {
    const delivery: InvestigationWebhookDelivery = {
      deliveryId: "delivery-1",
      version: "v1",
      mode: "static",
      eventName: "issues",
      repositoryId: "repo",
      repositoryFullName: "microsoft/PowerToys",
      kind: "issue",
      number: 42,
      actorUserId: 1,
      assigneeUserId: 2,
      receivedAt: "2026-10-01T08:00:00Z",
      state: "failed",
      attempts: 1,
      totalAttempts: 1,
      reason: "HTTP 429",
      taskId: null,
      canonicalDeliveryId: "delivery-1",
      snapshotRef: null,
      nextAttemptAt: null,
      availableActions: ["retry"],
      attemptHistory: [],
    };
    const record = mapIntakeFailure(delivery);
    expect(record.id).toBe("intake:delivery-1");
    expect(record.workItemId).toBe("");
    expect(record.taskId).toBeUndefined();
    expect(record.problem?.type).toBe("intake");
  });
});

describe("browser-scoped ignore state and elapsed time", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("isolates ignored review records by account identity and supports undo", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    });
    setReviewRecordIgnored("account-a", "record-1", true);
    expect(readIgnoredRecordIds("account-a").has("record-1")).toBe(true);
    expect(readIgnoredRecordIds("account-b").has("record-1")).toBe(false);
    setReviewRecordIgnored("account-a", "record-1", false);
    expect(readIgnoredRecordIds("account-a").size).toBe(0);
  });

  it("formats observed durations across an hour and clamps clock skew", () => {
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(3_661_000)).toBe("1:01:01");
    expect(formatDuration(-1_000)).toBe("0:00");
    expect(
      relativeTime("2026-10-01T08:01:00Z", (_zh, en) => en, Date.parse("2026-10-01T08:00:00Z")),
    ).toBe("0s ago");
  });
});
