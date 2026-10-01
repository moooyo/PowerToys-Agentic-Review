import {
  createInvestigationPreview,
  type InvestigationPublicationRecoveryRequest,
  InvestigationPublicationRecoveryStatusSchema,
  type InvestigationResultV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationAutomaticReplySettings } from "./auto-reply-settings.js";
import { defaultAutomaticReplyTemplates } from "./auto-reply-template.js";
import type { CommentPublication } from "./progress-publication.js";
import { InvestigationProgressReplies } from "./progress-reply.js";
import { InvestigationPublicationRecovery } from "./publication-recovery.js";
import { InvestigationStore } from "./store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
  InvestigationWorkItemRecord,
} from "./types.js";

const stores: InvestigationStore[] = [];
const publishers: InvestigationProgressReplies[] = [];
afterEach(async () => {
  for (const publisher of publishers.splice(0)) await publisher.stop();
  for (const store of stores.splice(0)) store.close();
});

function seal(report: InvestigationResultV1): void {
  const { logicalContentDigest: _digest, ...content } = report.report;
  report.report.logicalContentDigest = investigationContentDigest({ ...report, report: content });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(
  options: {
    kind?: "pr" | "bug";
    enabled?: boolean;
    externalWrites?: boolean;
    publisherConfigured?: boolean;
    authorizerAvailable?: boolean;
  } = {},
) {
  const fixture = createInvestigationPreview(options.kind ?? "pr", { findingCount: 0 });
  seal(fixture.result);
  const now = () => new Date("2026-09-18T14:00:00.000Z");
  const task: InvestigationTaskV1 = {
    ...fixture.task,
    createdAt: "2026-09-18T14:00:01.000Z",
    updatedAt: "2026-09-18T14:00:02.000Z",
    latestReportRef: {
      id: fixture.result.report.id,
      version: fixture.result.report.version,
      digest: fixture.result.report.logicalContentDigest,
    },
  };
  const actor: InvestigationOperatorPrincipal = {
    id: "recovery-operator",
    displayName: "Synthetic recovery operator",
    repositoryIds: [task.repository.id],
    permissions: ["repository:manage", "action:prepare", "action:execute"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
  };
  const store = new InvestigationStore();
  stores.push(store);
  store.insert("repositories", task.repository.id, task.repository);
  const item: InvestigationWorkItemRecord = {
    ...task.workItem,
    repositoryId: task.repository.id,
    githubWorkItemId: 700,
    body: "Synthetic conversation.",
    state: "open",
    subject: task.subjects[0]!,
    updatedAt: task.updatedAt,
  };
  store.insert("workItems", item.id, item);
  store.insert("tasks", task.id, task);
  store.insert("reports", fixture.result.report.id, fixture.result);
  const settings = new InvestigationAutomaticReplySettings(store, true, now);
  settings.update(actor, task.repository.id, {
    version: 0,
    enabled: options.enabled ?? true,
    progressEnabled: false,
    pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
    issueTemplate: defaultAutomaticReplyTemplates.issue,
  });
  const control: { beforeDispatch?: () => Promise<void> } = {};
  const mutations = vi.fn();
  const publishProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["publishProgressComment"]>
  >(async (_request, _repository, _target, _actor, beforeDispatch) => {
    await control.beforeDispatch?.();
    beforeDispatch?.();
    mutations(_request);
    return {
      state: "succeeded",
      effect: "applied",
      externalId: "9001",
      message: "Synthetic receipt.",
    };
  });
  const reconcileProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["reconcileProgressComment"]>
  >(async () => ({
    state: "succeeded",
    effect: "applied",
    externalId: "9001",
    message: "Synthetic readback.",
  }));
  const readPublisherIdentity = vi.fn(async () => ({
    githubUserId: 33,
    githubLogin: "fixture-publisher",
  }));
  const transport: InvestigationActionTransport = {
    supportedActions: ["comment"],
    publishProgressComment,
    reconcileProgressComment,
    readPublisherIdentity,
    readTarget: async () => ({
      kind: item.kind,
      state: "open",
      revisionKey: item.subject.revisionKey,
      headSha: null,
    }),
    execute: async () => {
      throw new Error("Recovery must not execute a separate ActionIntent.");
    },
    reconcile: async () => {
      throw new Error("Recovery must use the native shared publisher.");
    },
  };
  const progress = new InvestigationProgressReplies({
    store,
    settings,
    transport: options.publisherConfigured === false ? undefined : transport,
    resolveOperator: () => (options.authorizerAvailable === false ? null : actor),
    enableExternalWrites: options.externalWrites ?? true,
    now,
  });
  publishers.push(progress);
  const recovery = new InvestigationPublicationRecovery({ store, progress });
  const request = (): InvestigationPublicationRecoveryRequest => {
    const status = recovery.read(actor, task.id);
    return {
      version: status.version,
      reportId: status.reportId!,
      idempotencyKey: "synthetic-enqueue",
    };
  };
  async function run() {
    progress.start();
    await progress.drain();
  }
  function olderPublication() {
    const oldTask: InvestigationTaskV1 = {
      ...task,
      id: "old-native-task",
      state: "queued",
      latestReportRef: null,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    };
    store.insert("tasks", oldTask.id, oldTask);
    // Result-only settings are intentional; the prior shared publisher is retained natively.
    const saved = settings.read(actor, task.repository.id);
    settings.update(actor, task.repository.id, {
      version: saved.version,
      enabled: true,
      progressEnabled: true,
      pullRequestTemplate: saved.pullRequestTemplate,
      issueTemplate: saved.issueTemplate,
      progressTemplates: saved.progressTemplates,
    });
    progress.enqueue(oldTask, {
      eventName: task.workItem.kind === "pull_request" ? "pull_request" : "issues",
      actorUserId: 11,
      assigneeUserId: 22,
      actorLogin: "fixture-requester",
      assigneeLogin: "fixture-assignee",
    });
    return progress.taskSummary(actor, oldTask.id)!;
  }
  return {
    store,
    task,
    report: fixture.result,
    item,
    actor,
    settings,
    progress,
    recovery,
    request,
    run,
    olderPublication,
    control,
    mutations,
    publishProgressComment,
    reconcileProgressComment,
    readPublisherIdentity,
  };
}

describe("native saved report publication recovery", () => {
  it.each(["pr", "bug"] as const)(
    "reads a missing %s publication without mutations or upstream calls",
    (kind) => {
      const h = harness({ kind });
      const before = h.store.list("idempotency");
      const status = h.recovery.read(h.actor, h.task.id);
      expect(status).toMatchObject({
        state: "missing",
        reportId: h.report.id,
        blocker: null,
        publication: null,
        availableActions: ["enqueue"],
      });
      expect(Value.Check(InvestigationPublicationRecoveryStatusSchema, status)).toBe(true);
      expect(h.store.list("idempotency")).toEqual(before);
      expect(h.publishProgressComment).not.toHaveBeenCalled();
      expect(h.reconcileProgressComment).not.toHaveBeenCalled();
      expect(h.readPublisherIdentity).not.toHaveBeenCalled();
    },
  );

  it("queues the exact report once, preserving Task state, budget, and execution history", async () => {
    const h = harness();
    const request = h.request();
    const original = h.store.get("tasks", h.task.id);
    const result = h.recovery.enqueue(h.actor, h.task.id, request);
    expect(result).toMatchObject({
      state: "existing",
      publication: { taskId: h.task.id, reportId: h.report.id, state: "pending" },
      availableActions: [],
    });
    expect(h.store.get("tasks", h.task.id)).toEqual(original);
    expect(h.store.list("attempts")).toEqual([]);
    expect(h.store.get("reports", h.report.id)).toEqual(h.report);
    expect(h.publishProgressComment).not.toHaveBeenCalled();
    await h.run();
    expect(h.publishProgressComment).toHaveBeenCalledTimes(1);
    expect(h.publishProgressComment.mock.calls[0]![0]).toMatchObject({ externalId: null });
    expect(h.recovery.enqueue(h.actor, h.task.id, request)).toEqual(result);
    expect(h.publishProgressComment).toHaveBeenCalledTimes(1);
    expect(() =>
      h.recovery.enqueue(h.actor, h.task.id, { ...request, reportId: "another-report" }),
    ).toThrow(/idempotency key/iu);
  });

  it("updates the retained shared comment and preserves prior revisions", async () => {
    const h = harness();
    const older = h.olderPublication();
    await h.run();
    const before = h.progress.revisions(h.actor, older.id).items;
    expect(h.recovery.read(h.actor, h.task.id)).toMatchObject({
      state: "missing",
      publication: { id: older.id, taskId: "old-native-task" },
    });
    const result = h.recovery.enqueue(h.actor, h.task.id, h.request());
    expect(result.publication?.id).toBe(older.id);
    expect(h.progress.revisions(h.actor, older.id).items).toEqual(expect.arrayContaining(before));
    await h.progress.drain();
    expect(h.publishProgressComment).toHaveBeenCalledTimes(2);
    expect(h.publishProgressComment.mock.calls[1]![0]).toMatchObject({
      externalId: "9001",
      previousBody: expect.any(String),
    });
    expect(h.store.list("attempts")).toEqual([]);
  });

  it("keeps an existing failed native publication on its sync and reconcile workflow", () => {
    const h = harness();
    const initial = h.recovery.enqueue(h.actor, h.task.id, h.request());
    const record = h.store.get<CommentPublication>("idempotency", initial.publication!.id)!;
    h.store.put("idempotency", record.id, {
      ...record,
      state: "needs_attention",
      reasonCode: "retry_exhausted",
      nextAttemptAt: null,
    });
    const status = h.recovery.read(h.actor, h.task.id);
    expect(status).toMatchObject({
      state: "existing",
      availableActions: [],
      publication: { availableActions: ["sync"] },
    });
    expect(() =>
      h.recovery.enqueue(h.actor, h.task.id, {
        version: status.version,
        reportId: h.report.id,
        idempotencyKey: "another-command",
      }),
    ).toThrow(/unavailable/iu);
    const synced = h.progress.sync(h.actor, record.id, {
      version: status.publication!.version,
      idempotencyKey: "sync-existing",
    });
    expect(synced.state).toBe("pending");
    expect(h.store.list("attempts")).toEqual([]);
  });

  it("requires readback of an older uncertain write before advancing the producer", async () => {
    const h = harness();
    const older = h.olderPublication();
    const record = h.store.get<CommentPublication>("idempotency", older.id)!;
    const body = `Synthetic uncertain body.\n\n${record.marker}`;
    h.store.put("idempotency", record.id, {
      ...record,
      state: "unconfirmed",
      nextAttemptAt: null,
      githubIdentity: { githubUserId: 33, githubLogin: "fixture-publisher" },
      operation: {
        revision: record.desired,
        request: { body, marker: record.marker, externalId: null, previousBody: null },
        dispatched: true,
        finished: true,
        attemptId: null,
      },
    });
    const status = h.recovery.read(h.actor, h.task.id);
    expect(status).toMatchObject({
      state: "blocked",
      blocker: "reconcile_required",
      publication: { availableActions: ["reconcile"] },
    });
    expect(() => h.recovery.enqueue(h.actor, h.task.id, h.request())).toThrow(/unavailable/iu);
    expect(h.store.get<CommentPublication>("idempotency", record.id)?.taskId).toBe(
      "old-native-task",
    );
    h.progress.reconcile(h.actor, record.id, {
      version: status.publication!.version,
      idempotencyKey: "readback-first",
    });
    await h.run();
    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(1);
    expect(h.reconcileProgressComment.mock.calls[0]![0].body).toBe(body);
    expect(h.publishProgressComment).not.toHaveBeenCalled();
    expect(h.recovery.read(h.actor, h.task.id).state).toBe("missing");
  });

  it.each([
    [{ enabled: false }, "automatic_replies_disabled"],
    [{ externalWrites: false }, "external_writes_disabled"],
    [{ publisherConfigured: false }, "publisher_unavailable"],
    [{ authorizerAvailable: false }, "authorization_unavailable"],
  ] as const)("keeps unavailable settings blocked: %s", (options, blocker) => {
    const h = harness(options);
    const before = h.settings.read(h.actor, h.task.repository.id);
    expect(h.recovery.read(h.actor, h.task.id)).toMatchObject({
      state: "blocked",
      blocker,
      availableActions: [],
    });
    expect(() => h.recovery.enqueue(h.actor, h.task.id, h.request())).toThrow(/unavailable/iu);
    expect(h.settings.read(h.actor, h.task.repository.id)).toEqual(before);
    expect(h.progress.hasTask(h.task.id)).toBe(false);
    expect(h.publishProgressComment).not.toHaveBeenCalled();
  });

  it("rejects stale versions and report IDs without creating a publication", () => {
    const h = harness();
    const request = h.request();
    h.store.put("tasks", h.task.id, { ...h.task, updatedAt: "2026-09-18T14:00:03.000Z" });
    expect(() => h.recovery.enqueue(h.actor, h.task.id, request)).toThrow(/changed/iu);
    expect(() =>
      h.recovery.enqueue(h.actor, h.task.id, { ...h.request(), reportId: "foreign-report" }),
    ).toThrow(/changed/iu);
    expect(h.progress.hasTask(h.task.id)).toBe(false);
  });

  it("rechecks the standing grant before dispatch after a report has been queued", async () => {
    const h = harness();
    h.recovery.enqueue(h.actor, h.task.id, h.request());
    const saved = h.settings.read(h.actor, h.task.repository.id);
    h.settings.update(h.actor, h.task.repository.id, {
      version: saved.version,
      enabled: false,
      progressEnabled: false,
      pullRequestTemplate: saved.pullRequestTemplate,
      issueTemplate: saved.issueTemplate,
      progressTemplates: saved.progressTemplates,
    });
    await h.run();
    expect(h.publishProgressComment).not.toHaveBeenCalled();
    expect(h.progress.taskSummary(h.actor, h.task.id)).toMatchObject({
      state: "paused",
      availableActions: [],
    });
    expect(h.store.get<InvestigationTaskV1>("tasks", h.task.id)?.state).toBe("completed");
    expect(h.store.list("attempts")).toEqual([]);
  });

  it("stops a manual recovery when a newer result-only root appears during identity read", async () => {
    const h = harness();
    const queued = h.recovery.enqueue(h.actor, h.task.id, h.request());
    const entered = deferred();
    const release = deferred();
    h.readPublisherIdentity.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { githubUserId: 33, githubLogin: "fixture-publisher" };
    });
    const publishing = h.run();
    await entered.promise;
    const newer: InvestigationTaskV1 = {
      ...h.task,
      id: "newer-result-only-root",
      state: "queued",
      latestReportRef: null,
      createdAt: "2026-09-18T14:00:03.000Z",
      updatedAt: "2026-09-18T14:00:03.000Z",
    };
    h.store.insert("tasks", newer.id, newer);
    release.resolve();
    await publishing;
    expect(h.settings.read(h.actor, h.task.repository.id).progressEnabled).toBe(false);
    expect(h.publishProgressComment).not.toHaveBeenCalled();
    expect(h.mutations).not.toHaveBeenCalled();
    expect(h.progress.getComment(h.actor, queued.publication!.id)).toMatchObject({
      taskId: h.task.id,
      reportId: h.report.id,
      state: "needs_attention",
      reasonCode: "saved_report_recovery_obsolete",
      lastConfirmedAt: null,
      nextAttemptAt: null,
    });
    expect(h.recovery.read(h.actor, h.task.id)).toMatchObject({
      state: "blocked",
      blocker: "newer_task",
    });
    expect(h.store.get("tasks", newer.id)).toEqual(newer);
    expect(h.store.get("tasks", h.task.id)).toEqual(h.task);
    expect(h.store.get("reports", h.report.id)).toEqual(h.report);
    expect(h.store.list("attempts")).toEqual([]);
    expect(h.store.list("commentDeliveries")).toEqual([
      expect.objectContaining({
        taskId: h.task.id,
        reportId: h.report.id,
        effect: "not_sent",
        state: "failed",
      }),
    ]);
  });

  it("blocks a newer root created during transport preflight before any comment mutation", async () => {
    const h = harness();
    h.recovery.enqueue(h.actor, h.task.id, h.request());
    const entered = deferred();
    const release = deferred();
    h.control.beforeDispatch = async () => {
      entered.resolve();
      await release.promise;
    };
    const publishing = h.run();
    await entered.promise;
    h.store.insert("tasks", "newer-preflight-root", {
      ...h.task,
      id: "newer-preflight-root",
      state: "running",
      latestReportRef: null,
      createdAt: "2026-09-18T14:00:03.000Z",
      updatedAt: "2026-09-18T14:00:03.000Z",
    });
    release.resolve();
    await publishing;
    expect(h.publishProgressComment).toHaveBeenCalledTimes(1);
    expect(h.mutations).not.toHaveBeenCalled();
    expect(h.progress.taskSummary(h.actor, h.task.id)).toMatchObject({
      state: "needs_attention",
      reasonCode: "saved_report_recovery_obsolete",
      externalId: null,
      nextAttemptAt: null,
    });
    expect(h.store.list("attempts")).toEqual([]);
    expect(h.store.list("commentDeliveries")).toEqual([
      expect.objectContaining({ reportId: h.report.id, effect: "not_sent", state: "failed" }),
    ]);
  });

  it("preserves normal result-only publication timing without a manual recovery fence", async () => {
    const h = harness();
    h.progress.enqueueResult(h.report, h.task);
    const entered = deferred();
    const release = deferred();
    h.readPublisherIdentity.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { githubUserId: 33, githubLogin: "fixture-publisher" };
    });
    const publishing = h.run();
    await entered.promise;
    h.store.insert("tasks", "newer-automatic-root", {
      ...h.task,
      id: "newer-automatic-root",
      state: "queued",
      latestReportRef: null,
      createdAt: "2026-09-18T14:00:03.000Z",
      updatedAt: "2026-09-18T14:00:03.000Z",
    });
    release.resolve();
    await publishing;
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.progress.taskSummary(h.actor, h.task.id)?.state).toBe("synced");
  });

  it.each(["queued", "running", "completed"] as const)(
    "blocks an older report when a newer root is %s",
    (state) => {
      const h = harness();
      const request = h.request();
      h.store.insert("tasks", "newer-root", {
        ...h.task,
        id: "newer-root",
        state,
        createdAt: "2026-09-18T14:00:03.000Z",
      });
      expect(h.recovery.read(h.actor, h.task.id)).toMatchObject({
        state: "blocked",
        blocker: "newer_task",
      });
      expect(() => h.recovery.enqueue(h.actor, h.task.id, request)).toThrow(/changed/iu);
      expect(h.progress.hasTask(h.task.id)).toBe(false);
    },
  );

  it("blocks a newer accepted assignment even before it has a Task", () => {
    const h = harness();
    const older = h.olderPublication();
    const record = h.store.get<CommentPublication>("idempotency", older.id)!;
    h.store.put("idempotency", record.id, {
      ...record,
      taskId: null,
      taskCreatedAt: null,
      receivedAt: "2026-09-18T14:00:03.000Z",
    });
    expect(h.recovery.read(h.actor, h.task.id)).toMatchObject({
      state: "blocked",
      blocker: "newer_publication",
      publication: { id: older.id },
    });
  });

  it("does not recover legacy conclusion-only records", () => {
    const h = harness();
    h.store.insert("idempotency", `auto-reply:report:${h.report.id}`, {
      id: `auto-reply:report:${h.report.id}`,
      taskId: h.task.id,
      reportId: h.report.id,
    });
    expect(h.recovery.read(h.actor, h.task.id)).toMatchObject({
      state: "blocked",
      blocker: "legacy_publication",
      publication: null,
    });
    expect(() => h.recovery.enqueue(h.actor, h.task.id, h.request())).toThrow(/unavailable/iu);
    expect(h.progress.hasTask(h.task.id)).toBe(false);
  });

  it("rejects child execution Tasks and root Tasks with ambiguous creation times", () => {
    const h = harness();
    h.store.put("tasks", h.task.id, { ...h.task, parentTaskId: "parent-task" });
    expect(h.recovery.read(h.actor, h.task.id).blocker).toBe("unsupported_task");
    h.store.put("tasks", h.task.id, h.task);
    h.store.insert("tasks", "simultaneous-root", { ...h.task, id: "simultaneous-root" });
    expect(h.recovery.read(h.actor, h.task.id).blocker).toBe("newer_task");
    expect(h.progress.hasTask(h.task.id)).toBe(false);
  });

  it.each(["digest", "task", "partial"] as const)(
    "rejects a saved report with a changed %s binding",
    (kind) => {
      const h = harness();
      const report = structuredClone(h.report);
      if (kind === "digest") report.report.summary = "Changed sealed content.";
      if (kind === "task") {
        report.context.task.id = "foreign-task";
        seal(report);
      }
      if (kind === "partial") {
        report.report.completeness = "partial";
        seal(report);
      }
      h.store.put("reports", report.id, report);
      if (kind !== "digest")
        h.store.put("tasks", h.task.id, {
          ...h.task,
          latestReportRef: {
            ...h.task.latestReportRef!,
            digest: report.report.logicalContentDigest,
          },
        });
      expect(h.recovery.read(h.actor, h.task.id)).toMatchObject({
        state: "blocked",
        blocker: "report_unavailable",
      });
    },
  );

  it("enforces repository access and comment execution permissions", () => {
    const h = harness();
    expect(() => h.recovery.read({ ...h.actor, repositoryIds: [] }, h.task.id)).toThrow(
      /cannot read/iu,
    );
    const reader = { ...h.actor, permissions: [] };
    expect(h.recovery.read(reader, h.task.id).blocker).toBe("permission_denied");
    expect(() => h.recovery.enqueue(reader, h.task.id, h.request())).toThrow(/cannot request/iu);
    expect(h.progress.hasTask(h.task.id)).toBe(false);
  });
});
