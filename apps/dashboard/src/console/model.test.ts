import {
  createInvestigationPreview,
  type InvestigationCommentDelivery,
  type InvestigationCommentPublicationSummary,
  type InvestigationTaskV1,
  type InvestigationWebhookDelivery,
  validateInvestigationTask,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { investigationApi } from "../investigation/api";
import { createSampleInvestigationApi } from "../investigation/sample-adapter";
import {
  aggregateRelatedWork,
  applyHistoricalPublication,
  assertReviewDetailBinding,
  formatDuration,
  loadReviewRecords,
  mapIntakeFailure,
  mapReviewTask,
  relativeTime,
} from "./model";

afterEach(() => vi.restoreAllMocks());
let syntheticLoadNumber = 0;

function activityTask(
  source: "pr" | "bug",
  id: string,
  createdAt: string,
  patch: Partial<InvestigationTaskV1> = {},
): InvestigationTaskV1 {
  return {
    ...createInvestigationPreview(source, { findingCount: 0 }).task,
    id,
    createdAt,
    updatedAt: createdAt,
    latestReportRef: null,
    ...patch,
  };
}

function followUpTask(
  parent: InvestigationTaskV1,
  id: string,
  kind: "pr-verify" | "reproduction-setup" | "issue-fix" | "issue-verify",
  createdAt: string,
  state: InvestigationTaskV1["state"],
): InvestigationTaskV1 {
  const task = structuredClone(parent);
  task.id = id;
  task.kind = kind;
  task.state = state;
  task.createdAt = createdAt;
  task.updatedAt = createdAt;
  task.latestReportRef = null;
  task.parentTaskId = parent.id;
  task.parentReportRef = { id: `${parent.id}-report`, version: 1, digest: "a".repeat(64) };
  task.planRef = { id: `${id}-plan`, version: 1, digest: "b".repeat(64) };
  if (task.workItem.kind === "issue") {
    const source = {
      id: `${id}-source`,
      kind: "source_commit" as const,
      repositoryId: task.repository.id,
      workItemId: task.workItem.id,
      revisionKey: "c".repeat(64),
      commitSha: "d".repeat(40),
    };
    task.subjects.push(source);
    task.subjectRef = source.id;
  }
  task.executionPolicy = {
    mode: "execute",
    allowedSubjectRefs: task.subjects.map((subject) => subject.id),
    allowRepositoryExecution: true,
    authorizationRef: "synthetic-execution-authorization",
  };
  return task;
}

async function loadSyntheticTasks(tasks: InvestigationTaskV1[]) {
  vi.spyOn(investigationApi, "tasks").mockResolvedValue({ items: tasks });
  vi.spyOn(investigationApi, "workItems").mockResolvedValue({ items: [] });
  vi.spyOn(investigationApi, "publicationDirectory").mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  vi.spyOn(investigationApi, "scheduler").mockRejectedValue(
    new Error("Synthetic scheduler unavailable."),
  );
  vi.spyOn(investigationApi, "webhookDeliveries").mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  vi.spyOn(investigationApi, "task").mockImplementation(async (id) => {
    const task = tasks.find((entry) => entry.id === id);
    if (!task) throw new Error("A synthetic task was not found.");
    return { task, attempts: [], checkpoint: null, latestReport: null, children: [] };
  });
  return loadReviewRecords(undefined, undefined, `synthetic:${++syntheticLoadNumber}`);
}

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
  it("reads the current shared comment without presenting a newer round as this saved report's publication", async () => {
    const { task, detail } = await fixture();
    const current = {
      ...publication(task, "synced"),
      mode: "progress" as const,
      taskId: "newer-review",
      reportId: "newer-report",
      producerTaskKind: task.kind,
    };
    const record = mapReviewTask({ ...task, state: "completed" }, detail, [current]);
    expect(record.publication).toBeUndefined();
    expect(record.completedWithoutPublication).toBe(true);
    expect(record.currentPublication?.id).toBe(current.id);
    expect(
      mapReviewTask(task, detail, [{ ...current, workItemId: "another-source" }])
        .currentPublication,
    ).toBeUndefined();
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

  it("loads independent PR reviews, standalone E2E and verification into one source record", async () => {
    const review = activityTask("pr", "original-review", "2026-10-01T00:00:00Z");
    const rereview = activityTask("pr", "rereview", "2026-10-01T03:00:00Z");
    const e2e = activityTask("pr", "standalone-e2e", "2026-10-01T01:00:00Z", {
      kind: "pr-e2e",
      state: "failed",
      executionPolicy: {
        mode: "execute",
        allowedSubjectRefs: [review.subjectRef],
        allowRepositoryExecution: true,
        authorizationRef: "synthetic-e2e-authorization",
      },
    });
    const verify = followUpTask(review, "verify", "pr-verify", "2026-10-01T02:00:00Z", "running");
    const tasks = [rereview, verify, e2e, review];
    for (const task of tasks)
      expect(validateInvestigationTask(task)).toEqual({ valid: true, errors: [] });
    const records = await loadSyntheticTasks(tasks);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: review.id, taskId: e2e.id, currentWorkId: e2e.id });
    expect(new Set(records[0]!.relatedWork?.map((work) => work.taskId))).toEqual(
      new Set(tasks.map((task) => task.id)),
    );
    expect(
      records[0]!.relatedWork?.find((work) => work.taskId === e2e.id)?.task?.parentTaskId,
    ).toBeNull();
  });

  it("loads Issue reproduction, fixes, verification and later reviews without inventing PR activities", async () => {
    const review = activityTask("bug", "issue-review", "2026-10-01T00:00:00Z");
    const reproduction = followUpTask(
      review,
      "reproduction",
      "reproduction-setup",
      "2026-10-01T01:00:00Z",
      "completed",
    );
    const fix = followUpTask(review, "fix", "issue-fix", "2026-10-01T02:00:00Z", "completed");
    const verification = followUpTask(
      fix,
      "issue-verification",
      "issue-verify",
      "2026-10-01T03:00:00Z",
      "running",
    );
    const rereview = activityTask("bug", "issue-rereview", "2026-10-01T04:00:00Z");
    const tasks = [verification, rereview, fix, reproduction, review];
    for (const task of tasks)
      expect(validateInvestigationTask(task)).toEqual({ valid: true, errors: [] });
    const records = await loadSyntheticTasks(tasks);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: review.id,
      kind: "issue",
      taskId: verification.id,
      currentWorkId: verification.id,
    });
    expect(records[0]!.relatedWork).toHaveLength(5);
    expect(records[0]!.relatedWork?.every((work) => work.task?.kind !== "pr-e2e")).toBe(true);
  });

  it("uses the latest same-kind root without dropping the earlier failed review", async () => {
    const failed = activityTask("pr", "failed-review", "2026-10-01T00:00:00Z", {
      state: "failed",
    });
    const completed = activityTask("pr", "completed-review", "2026-10-01T01:00:00Z");
    const records = await loadSyntheticTasks([completed, failed]);
    expect(records[0]).toMatchObject({
      id: failed.id,
      taskId: completed.id,
      currentWorkId: completed.id,
      completedWithoutPublication: true,
    });
    expect(records[0]!.relatedWork?.find((work) => work.taskId === failed.id)?.problem?.type).toBe(
      "review",
    );
  });

  it("keeps old-revision failures visible while selecting work for the latest root revision", async () => {
    const oldReview = activityTask("pr", "old-revision-review", "2026-10-01T00:00:00Z", {
      state: "failed",
    });
    const currentReview = activityTask("pr", "current-revision-review", "2026-10-01T01:00:00Z");
    currentReview.subjects = currentReview.subjects.map((subject) => ({
      ...subject,
      revisionKey: "9".repeat(64),
      ...(subject.kind === "original_pr" ? { headSha: "9".repeat(40) } : {}),
    }));
    const lateOldVerification = followUpTask(
      oldReview,
      "late-old-verification",
      "pr-verify",
      "2026-10-01T02:00:00Z",
      "failed",
    );
    const records = await loadSyntheticTasks([lateOldVerification, currentReview, oldReview]);
    expect(records[0]).toMatchObject({
      id: oldReview.id,
      taskId: currentReview.id,
      currentWorkId: currentReview.id,
    });
    expect(records[0]!.relatedWork).toHaveLength(3);
    expect(records[0]!.relatedWork?.filter((work) => work.problem?.type === "review")).toHaveLength(
      2,
    );
  });

  it("inherits the Issue snapshot revision through executable source subjects and parent tasks", async () => {
    const oldReview = activityTask("bug", "old-issue-review", "2026-10-01T00:00:00Z");
    const currentReview = activityTask("bug", "current-issue-review", "2026-10-01T01:00:00Z");
    currentReview.subjects = currentReview.subjects.map((subject) => ({
      ...subject,
      revisionKey: "8".repeat(64),
    }));
    const oldFix = followUpTask(
      oldReview,
      "old-issue-fix",
      "issue-fix",
      "2026-10-01T03:00:00Z",
      "failed",
    );
    const currentFix = followUpTask(
      currentReview,
      "current-issue-fix",
      "issue-fix",
      "2026-10-01T02:00:00Z",
      "running",
    );
    currentFix.subjects = currentFix.subjects.filter(
      (subject) => subject.kind !== "issue_snapshot",
    );
    currentFix.executionPolicy.allowedSubjectRefs = [currentFix.subjectRef];
    currentFix.scope.includedUnits = [
      {
        id: "current-fix-source",
        subjectRef: currentFix.subjectRef,
        kind: "source_file",
        paths: ["src/main.ts"],
        requiredWork: "Inspect the executable source selected for this fix.",
        status: "pending",
        evidenceRefs: [],
      },
    ];
    currentFix.scope.completedUnitRefs = [];
    currentFix.scope.unresolvedUnitRefs = ["current-fix-source"];
    expect(validateInvestigationTask(currentFix)).toEqual({ valid: true, errors: [] });
    const records = await loadSyntheticTasks([oldFix, currentFix, currentReview, oldReview]);
    expect(records[0]).toMatchObject({ taskId: currentFix.id, currentWorkId: currentFix.id });
    expect(records[0]!.relatedWork).toHaveLength(4);
  });

  it("isolates repository, work item, kind and number identities when grouping source history", async () => {
    const original = activityTask("pr", "source-one", "2026-10-01T00:00:00Z");
    const anotherRepository = activityTask("pr", "other-repository", "2026-10-01T01:00:00Z");
    anotherRepository.repository = {
      ...anotherRepository.repository,
      id: "other-repository",
      fullName: "example/other",
    };
    anotherRepository.subjects = anotherRepository.subjects.map((subject) => ({
      ...subject,
      repositoryId: anotherRepository.repository.id,
    }));
    const anotherSource = activityTask("pr", "other-source", "2026-10-01T02:00:00Z");
    anotherSource.workItem = { ...anotherSource.workItem, id: "other-source" };
    anotherSource.subjects = anotherSource.subjects.map((subject) => ({
      ...subject,
      workItemId: anotherSource.workItem.id,
    }));
    const anotherNumber = activityTask("pr", "other-number", "2026-10-01T03:00:00Z");
    anotherNumber.workItem = { ...anotherNumber.workItem, number: original.workItem.number + 1 };
    const issue = activityTask("bug", "issue-source", "2026-10-01T04:00:00Z");
    issue.workItem = {
      ...issue.workItem,
      id: original.workItem.id,
      number: original.workItem.number,
    };
    issue.subjects = issue.subjects.map((subject) => ({
      ...subject,
      workItemId: issue.workItem.id,
    }));
    const records = await loadSyntheticTasks([
      issue,
      anotherNumber,
      anotherSource,
      anotherRepository,
      original,
    ]);
    expect(records).toHaveLength(5);
    expect(new Set(records.map((record) => record.id))).toEqual(
      new Set([issue.id, anotherNumber.id, anotherSource.id, anotherRepository.id, original.id]),
    );
  });

  it("chooses a stable container and same-kind winner for equal creation times in either response order", async () => {
    const first = activityTask("pr", "review-a", "2026-10-01T00:00:00Z", { state: "failed" });
    const second = activityTask("pr", "review-b", "2026-10-01T00:00:00Z");
    for (const tasks of [
      [first, second],
      [second, first],
    ]) {
      const records = await loadSyntheticTasks(tasks);
      expect(records[0]).toMatchObject({
        id: first.id,
        taskId: second.id,
        currentWorkId: second.id,
      });
      expect(records[0]!.relatedWork).toHaveLength(2);
    }
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

describe("observed elapsed time", () => {
  it("formats observed durations across an hour and clamps clock skew", () => {
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(3_661_000)).toBe("1:01:01");
    expect(formatDuration(-1_000)).toBe("0:00");
    expect(
      relativeTime("2026-10-01T08:01:00Z", (_zh, en) => en, Date.parse("2026-10-01T08:00:00Z")),
    ).toBe("0s ago");
  });
});
