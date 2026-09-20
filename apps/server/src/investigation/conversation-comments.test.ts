import {
  createInvestigationPreview,
  type InvestigationActionIntentV1,
  type InvestigationCreateActionIntentRequest,
  type InvestigationResultV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationAutomaticReplySettings } from "./auto-reply-settings.js";
import { defaultAutomaticReplyTemplates } from "./auto-reply-template.js";
import { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import type { CommentPublication, PublicationRevision } from "./progress-publication.js";
import { InvestigationProgressReplies } from "./progress-reply.js";
import {
  defaultProgressReplyTemplates,
  type InvestigationProgressTrigger,
} from "./progress-reply-template.js";
import { InvestigationStore } from "./store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
  InvestigationProgressCommentDelivery,
  InvestigationProgressCommentRequest,
  InvestigationWorkItemRecord,
} from "./types.js";
import type { TrustedAssignmentAdmission } from "./webhook-intake.js";

const stores: InvestigationStore[] = [];
const publishers: InvestigationProgressReplies[] = [];

afterEach(async () => {
  await Promise.all(publishers.splice(0).map((publisher) => publisher.stop()));
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

type Channel = "static" | "e2e";

function harness(options: { kind?: "pr" | "bug"; progressEnabled?: boolean } = {}) {
  const fixture = createInvestigationPreview(options.kind ?? "pr", { findingCount: 0 });
  const repository = fixture.task.repository;
  const store = new InvestigationStore();
  stores.push(store);
  const clock = { value: Date.parse("2026-09-20T01:00:00.000Z") };
  const now = () => new Date(clock.value);
  const tick = () => {
    clock.value += 1;
    return now().toISOString();
  };
  const workItem: InvestigationWorkItemRecord = {
    ...fixture.task.workItem,
    repositoryId: repository.id,
    body: "Synthetic frozen conversation source.",
    state: "open",
    subject: fixture.task.subjects[0]!,
    updatedAt: now().toISOString(),
  };
  store.insert("repositories", repository.id, repository);
  store.insert("workItems", workItem.id, workItem);
  const actor: InvestigationOperatorPrincipal = {
    id: "synthetic-conversation-comment-operator",
    displayName: "Synthetic conversation comment operator",
    repositoryIds: [repository.id],
    permissions: ["repository:manage", "action:prepare", "action:execute"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
  };
  const settings = new InvestigationAutomaticReplySettings(store, true, now);
  settings.update(actor, repository.id, {
    version: 0,
    enabled: true,
    progressEnabled: options.progressEnabled ?? true,
    pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
    issueTemplate: defaultAutomaticReplyTemplates.issue,
    progressTemplates: defaultProgressReplyTemplates,
  });
  const control: {
    delivery?: InvestigationProgressCommentDelivery;
    beforeDispatch?: () => Promise<void>;
    afterDispatch?: (request: InvestigationProgressCommentRequest) => Promise<void>;
    readback: InvestigationProgressCommentDelivery;
  } = {
    readback: {
      state: "unknown",
      effect: "unknown",
      message: "Synthetic readback is unavailable.",
      externalId: null,
    },
  };
  const externalIds = new Map<string, string>();
  const dispatches = vi.fn<(request: InvestigationProgressCommentRequest) => void>();
  const publishProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["publishProgressComment"]>
  >(async (request, _repository, _target, _actor, beforeDispatch) => {
    await control.beforeDispatch?.();
    beforeDispatch?.();
    dispatches(structuredClone(request));
    const externalId = request.externalId ?? String(9001 + externalIds.size);
    externalIds.set(request.marker, externalId);
    const delivery = structuredClone(
      control.delivery ?? {
        state: "succeeded" as const,
        effect: "applied" as const,
        message: "Synthetic comment accepted.",
        externalId,
      },
    );
    await control.afterDispatch?.(request);
    return delivery;
  });
  const reconcileProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["reconcileProgressComment"]>
  >(async () => structuredClone(control.readback));
  const transport: InvestigationActionTransport = {
    supportedActions: ["comment"],
    readPublisherIdentity: async () => ({
      githubUserId: 33,
      githubLogin: "synthetic-publisher",
    }),
    publishProgressComment,
    reconcileProgressComment,
    readTarget: async () => ({
      kind: workItem.kind,
      state: "open",
      revisionKey: workItem.subject.revisionKey,
      headSha: workItem.subject.kind === "original_pr" ? workItem.subject.headSha : null,
    }),
    execute: async () => {
      throw new Error("Conversation publication tests must use the mocked progress transport.");
    },
    reconcile: async () => {
      throw new Error("Conversation publication tests must use the mocked progress readback.");
    },
  };
  const deliveries = new InvestigationCommentDeliveries({ store, now });
  function createPublisher() {
    const publisher = new InvestigationProgressReplies({
      store,
      settings,
      transport,
      deliveries,
      isAssignmentAuthorized: () => true,
      resolveOperator: (id) => (id === actor.id ? actor : null),
      enableExternalWrites: true,
      now,
      retryDelayMs: 60_000,
      phaseIntervalMs: 120_000,
    });
    publishers.push(publisher);
    return publisher;
  }
  const publisher = createPublisher();
  function makeTask(label: string, channel: Channel = "static") {
    const createdAt = tick();
    const task: InvestigationTaskV1 = {
      ...structuredClone(fixture.task),
      id: `synthetic-conversation-task-${label}`,
      kind: channel === "e2e" ? "pr-e2e" : fixture.task.kind,
      state: "queued",
      latestReportRef: null,
      createdAt,
      updatedAt: createdAt,
    };
    store.put("tasks", task.id, task);
    return task;
  }
  function trigger(
    channel: Channel = "static",
    commandCommentId = 901,
  ): InvestigationProgressTrigger {
    return {
      eventName:
        channel === "e2e"
          ? "issue_comment"
          : workItem.kind === "pull_request"
            ? "pull_request"
            : "issues",
      ...(channel === "e2e" ? { commandCommentId } : {}),
      actorUserId: 11,
      assigneeUserId: 22,
      actorLogin: "synthetic-assigner",
      assigneeLogin: "synthetic-worker",
    };
  }
  function admission(label: string, channel: Channel = "static"): TrustedAssignmentAdmission {
    return {
      id: `synthetic-conversation-admission-${label}`,
      ...(channel === "e2e" ? { mode: "e2e" as const } : {}),
      repository,
      target: {
        id: "synthetic-admission-target",
        repositoryId: repository.id,
        kind: workItem.kind,
        number: workItem.number,
        githubWorkItemId: 12345,
      },
      trigger: trigger(channel, 901 + (clock.value % 100)),
      receivedAt: tick(),
      expectedAssigneeUserId: 22,
      ...(workItem.subject.kind === "original_pr" ? { headSha: workItem.subject.headSha } : {}),
    };
  }
  function enqueue(task: InvestigationTaskV1, destination = publisher) {
    store.transaction(() =>
      destination.enqueue(task, trigger(task.kind === "pr-e2e" ? "e2e" : "static")),
    );
  }
  function complete(task: InvestigationTaskV1, notify = true, destination = publisher) {
    const report = JSON.parse(
      JSON.stringify(fixture.result)
        .replaceAll(fixture.task.id, task.id)
        .replaceAll(fixture.result.report.id, `synthetic-report-${task.id}`),
    ) as InvestigationResultV1;
    report.context.task.kind = task.kind;
    const updated: InvestigationTaskV1 = {
      ...task,
      state: "completed",
      updatedAt: tick(),
      latestReportRef: {
        id: report.report.id,
        version: report.report.version,
        digest: report.report.logicalContentDigest,
      },
    };
    store.transaction(() => {
      store.put("reports", report.report.id, report);
      store.put("tasks", task.id, updated);
      if (notify) destination.update(updated, report);
    });
    return { task: updated, report };
  }
  function transition(task: InvestigationTaskV1, state: InvestigationTaskV1["state"]) {
    const updated = { ...task, state, updatedAt: tick() };
    store.transaction(() => {
      store.put("tasks", task.id, updated);
      publisher.update(updated);
    });
    return updated;
  }
  async function run(destination = publisher) {
    destination.start();
    await destination.drain();
  }
  function summary(task: InvestigationTaskV1, destination = publisher) {
    const result = destination.taskSummary(actor, task.id);
    expect(result).not.toBeNull();
    const { associatedTaskIds, ...publication } = result!;
    expect(associatedTaskIds).toEqual([task.id]);
    return publication;
  }
  function history(commentId: string) {
    return deliveries.list(actor, { commentId, limit: 50 }).items;
  }
  return {
    actor,
    repository,
    settings,
    store,
    clock,
    publisher,
    createPublisher,
    deliveries,
    control,
    dispatches,
    publishProgressComment,
    reconcileProgressComment,
    makeTask,
    admission,
    enqueue,
    complete,
    transition,
    run,
    summary,
    history,
  };
}

function seedRetainedPublication(
  destination: ReturnType<typeof harness>,
  source: ReturnType<typeof harness>,
  task: InvestigationTaskV1,
) {
  const sourceRecord = source.store.get<CommentPublication>(
    "idempotency",
    source.summary(task).id,
  )!;
  function retainedRevision(revision: PublicationRevision): PublicationRevision {
    const {
      taskId: _taskId,
      workItemId: _workItemId,
      receiptId: _receiptId,
      ...retained
    } = revision;
    return retained;
  }
  const record: CommentPublication = {
    ...structuredClone(sourceRecord),
    desired: retainedRevision(sourceRecord.desired),
    confirmed:
      sourceRecord.confirmed === null
        ? null
        : {
            ...sourceRecord.confirmed,
            revision: retainedRevision(sourceRecord.confirmed.revision),
          },
    operation:
      sourceRecord.operation === null
        ? null
        : {
            ...sourceRecord.operation,
            revision: retainedRevision(sourceRecord.operation.revision),
          },
  };
  destination.store.put("tasks", task.id, source.store.get("tasks", task.id)!);
  destination.store.put("idempotency", record.id, record);
  destination.store.put("idempotency", record.desired.id, record.desired);
  destination.store.put("idempotency", `progress-reply:task-index:${task.id}`, {
    recordId: record.id,
  });
  destination.store.put(
    "idempotency",
    `progress-reply:repository:${investigationContentDigest(record.repository.id)}:${record.createdAt}:${investigationContentDigest(record.id)}`,
    { recordId: record.id },
  );
  if (record.nextAttemptAt !== null)
    destination.store.put("idempotency", record.pendingId, { recordId: record.id });
  destination.store.delete(
    "idempotency",
    `progress-reply:conversation:${investigationContentDigest([
      record.repository.id,
      record.target.kind,
      record.target.number,
      record.desired.context.mode === "e2e" ? "e2e" : "static",
    ])}`,
  );
  return record;
}

describe("conversation comments across investigation tasks", () => {
  it("keeps one static comment and one E2E comment through repeated PR tasks", async () => {
    const h = harness();
    const staticFirst = h.makeTask("static-first");
    const e2eFirst = h.makeTask("e2e-first", "e2e");
    h.enqueue(staticFirst);
    h.enqueue(e2eFirst);
    await h.run();
    const staticAccepted = h.summary(staticFirst);
    const e2eAccepted = h.summary(e2eFirst);
    const firstRequests = h.dispatches.mock.calls.map(([request]) => request);
    expect(staticAccepted.id).not.toBe(e2eAccepted.id);
    expect(staticAccepted.externalId).not.toBe(e2eAccepted.externalId);
    expect(staticAccepted.id).toBe(`progress-reply:task:${staticFirst.id}`);
    expect(e2eAccepted.id).toBe(`progress-reply:task:${e2eFirst.id}`);

    h.complete(staticFirst);
    h.complete(e2eFirst);
    await h.run();
    const staticHistory = h.history(staticAccepted.id);
    const e2eHistory = h.history(e2eAccepted.id);
    const staticSecond = h.makeTask("static-second");
    const e2eSecond = h.makeTask("e2e-second", "e2e");
    h.enqueue(staticSecond);
    h.enqueue(e2eSecond);
    await h.run();
    h.complete(staticSecond);
    h.complete(e2eSecond);
    await h.run();

    expect(h.publisher.list(h.actor, h.repository.id).items).toHaveLength(2);
    for (const [previous, current, accepted, previousHistory] of [
      [staticFirst, staticSecond, staticAccepted, staticHistory],
      [e2eFirst, e2eSecond, e2eAccepted, e2eHistory],
    ] as const) {
      expect(h.summary(current)).toMatchObject({
        id: accepted.id,
        externalId: accepted.externalId,
        taskId: current.id,
        state: "synced",
      });
      expect(h.summary(previous)).toEqual(h.summary(current));
      const createdBody = previousHistory.find((attempt) => attempt.operation === "create")!.body;
      const originalRequest = firstRequests.find((request) => request.body === createdBody)!;
      const requests = h.dispatches.mock.calls
        .map(([request]) => request)
        .filter((request) => request.marker === originalRequest.marker);
      expect(requests).toHaveLength(4);
      expect(requests.filter((request) => request.externalId === null)).toHaveLength(1);
      expect(requests.slice(1).every((request) => request.externalId === accepted.externalId)).toBe(
        true,
      );
      for (const attempt of previousHistory)
        expect(h.deliveries.read(h.actor, attempt.id)).toEqual(attempt);
      expect(
        h.history(accepted.id).filter((attempt) => attempt.taskId === current.id),
      ).toHaveLength(2);
    }
    expect(h.dispatches.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      2,
    );
    expect(h.store.list("actionIntents")).toEqual([]);
  });

  it("reuses an issue's static comment and ignores the superseded task's late events", async () => {
    const h = harness({ kind: "bug" });
    const first = h.makeTask("issue-first");
    h.enqueue(first);
    await h.run();
    const accepted = h.summary(first);
    const second = h.makeTask("issue-second");
    h.enqueue(second);
    await h.run();
    const current = h.summary(second);
    const revisions = h.publisher.revisions(h.actor, accepted.id);
    const dispatchCount = h.dispatches.mock.calls.length;

    h.transition(first, "running");
    h.complete(first);
    h.enqueue(first);
    await h.run();

    expect(h.summary(second)).toEqual(current);
    expect(h.summary(first)).toEqual(current);
    expect(h.publisher.revisions(h.actor, accepted.id)).toEqual(revisions);
    expect(h.dispatches).toHaveBeenCalledTimes(dispatchCount);
    expect(h.publisher.list(h.actor, h.repository.id).items).toHaveLength(1);
    expect(h.dispatches.mock.calls[1]![0]).toMatchObject({
      marker: h.dispatches.mock.calls[0]![0].marker,
      externalId: accepted.externalId,
      previousBody: h.dispatches.mock.calls[0]![0].body,
    });
  });

  it("supersedes a prepared create when a newer task arrives during preflight", async () => {
    const h = harness();
    const first = h.makeTask("preflight-first");
    let release!: () => void;
    let prepared!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    h.control.beforeDispatch = async () => {
      delete h.control.beforeDispatch;
      prepared();
      await held;
    };
    h.enqueue(first);
    h.publisher.start();
    const draining = h.publisher.drain();
    await started;
    const second = h.makeTask("preflight-second");
    try {
      h.enqueue(second);
    } finally {
      release();
      await draining;
    }
    await h.run();
    expect(h.dispatches).toHaveBeenCalledTimes(1);
    expect(h.summary(second)).toMatchObject({ state: "synced", taskId: second.id });
    const attempts = h.history(h.summary(second).id);
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: first.id, state: "cancelled", effect: "not_sent" }),
        expect.objectContaining({ taskId: second.id, state: "succeeded", operation: "create" }),
      ]),
    );
  });

  it("finishes an in-flight create before updating the same comment for a newer task", async () => {
    const h = harness();
    const first = h.makeTask("in-flight-first");
    let release!: () => void;
    let dispatched!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    h.control.afterDispatch = async () => {
      delete h.control.afterDispatch;
      dispatched();
      await held;
    };
    h.enqueue(first);
    h.publisher.start();
    const draining = h.publisher.drain();
    await started;
    const original = h.summary(first);
    const second = h.makeTask("in-flight-second");
    try {
      h.enqueue(second);
    } finally {
      release();
      await draining;
    }
    await h.run();

    expect(h.dispatches).toHaveBeenCalledTimes(2);
    expect(h.dispatches.mock.calls[0]![0].externalId).toBeNull();
    expect(h.dispatches.mock.calls[1]![0]).toMatchObject({
      marker: h.dispatches.mock.calls[0]![0].marker,
      externalId: "9001",
      previousBody: h.dispatches.mock.calls[0]![0].body,
    });
    expect(h.summary(second)).toMatchObject({
      id: original.id,
      taskId: second.id,
      externalId: "9001",
      state: "synced",
    });
    expect(h.history(original.id).map((attempt) => attempt.taskId)).toEqual([second.id, first.id]);
  });

  it("reconciles an unknown create after handover and restart without a second create", async () => {
    const h = harness();
    const first = h.makeTask("unknown-first");
    h.control.delivery = {
      state: "unknown",
      effect: "unknown",
      reasonCode: "mutation_response_unknown",
      message: "Synthetic create response was lost.",
      externalId: null,
    };
    h.enqueue(first);
    await h.run();
    const original = h.summary(first);
    const firstAttempt = h.history(original.id)[0]!;
    const originalReceipt = h.store.get<{ originalReceipt: unknown }>(
      "commentDeliveries",
      firstAttempt.id,
    )!.originalReceipt;
    const second = h.makeTask("unknown-second");
    h.enqueue(second);
    await h.publisher.stop();
    delete h.control.delivery;
    h.control.readback = {
      state: "succeeded",
      effect: "applied",
      message: "Synthetic original create found by exact marker and body.",
      externalId: "9001",
    };
    h.clock.value += 60_000;
    const restarted = h.createPublisher();
    await h.run(restarted);

    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(1);
    expect(h.reconcileProgressComment.mock.calls[0]![0]).toMatchObject({
      marker: h.dispatches.mock.calls[0]![0].marker,
      body: firstAttempt.body,
      externalId: null,
    });
    expect(h.dispatches).toHaveBeenCalledTimes(2);
    expect(h.dispatches.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      1,
    );
    expect(h.dispatches.mock.calls[1]![0]).toMatchObject({
      marker: h.dispatches.mock.calls[0]![0].marker,
      externalId: "9001",
      previousBody: firstAttempt.body,
    });
    expect(h.summary(second, restarted)).toMatchObject({
      id: original.id,
      state: "synced",
      taskId: second.id,
      externalId: "9001",
    });
    expect(h.deliveries.read(h.actor, firstAttempt.id)).toMatchObject({
      taskId: first.id,
      state: "succeeded",
      observations: [{ state: "succeeded" }],
    });
    expect(
      h.store.get<{ originalReceipt: unknown }>("commentDeliveries", firstAttempt.id)!
        .originalReceipt,
    ).toEqual(originalReceipt);
  });

  it.each(["static", "e2e"] as const)(
    "hands a %s assignment comment to a newer intake cycle without rewriting earlier delivery ownership",
    async (channel) => {
      const h = harness();
      const firstAdmission = h.admission("first", channel);
      h.store.transaction(() => h.publisher.enqueueAssignment(firstAdmission));
      await h.run();
      const publicationId = h.publisher.list(h.actor, h.repository.id).items[0]!.id;
      const first = h.makeTask("assignment-first", channel);
      h.store.transaction(() => h.publisher.attachTask(firstAdmission.id, first));
      await h.run();
      const firstHistory = h.history(publicationId);
      expect(firstHistory.every((attempt) => attempt.taskId === first.id)).toBe(true);

      const secondAdmission = h.admission("second", channel);
      h.store.transaction(() => h.publisher.enqueueAssignment(secondAdmission));
      await h.run();
      const preparingAttempt = h.history(publicationId)[0]!;
      expect(preparingAttempt.taskId).toBeNull();
      const second = h.makeTask("assignment-second", channel);
      h.store.transaction(() => h.publisher.attachTask(secondAdmission.id, second));
      await h.run();
      const attached = h.summary(second);
      h.store.transaction(() => {
        h.publisher.enqueueAssignment(firstAdmission);
        h.publisher.updateAssignment(firstAdmission.id, "failed", "source_preparation_failed");
        h.publisher.attachTask(firstAdmission.id, first);
      });
      h.complete(first);
      await h.run();

      expect(h.summary(second)).toEqual(attached);
      expect(h.summary(first)).toEqual(attached);
      expect(attached).toMatchObject({ id: publicationId, taskId: second.id, externalId: "9001" });
      for (const attempt of firstHistory)
        expect(h.deliveries.read(h.actor, attempt.id)).toEqual(attempt);
      expect(h.deliveries.read(h.actor, preparingAttempt.id)).toMatchObject({ taskId: second.id });
      expect(h.publisher.list(h.actor, h.repository.id).items).toHaveLength(1);
      expect(
        h.dispatches.mock.calls.filter(([request]) => request.externalId === null),
      ).toHaveLength(1);
    },
  );

  it("ignores delayed attachment from a superseded preparation and preserves its own receipt attribution", async () => {
    const h = harness();
    const firstAdmission = h.admission("delayed-first");
    h.store.transaction(() => h.publisher.enqueueAssignment(firstAdmission));
    await h.run();
    const publicationId = h.publisher.list(h.actor, h.repository.id).items[0]!.id;
    const firstAttempt = h.history(publicationId)[0]!;
    const secondAdmission = h.admission("delayed-second");
    h.store.transaction(() => h.publisher.enqueueAssignment(secondAdmission));
    await h.run();
    const secondAttempt = h.history(publicationId)[0]!;
    const second = h.makeTask("delayed-second");
    h.store.transaction(() => h.publisher.attachTask(secondAdmission.id, second));
    await h.run();
    const current = h.summary(second);
    const first = h.makeTask("delayed-first");
    h.store.transaction(() => {
      h.publisher.attachTask(firstAdmission.id, first);
      h.publisher.updateAssignment(firstAdmission.id, "cancelled");
    });
    h.transition(first, "running");
    await h.run();

    expect(h.summary(second)).toEqual(current);
    expect(h.summary(first)).toEqual(current);
    expect(h.deliveries.read(h.actor, firstAttempt.id)).toMatchObject({ taskId: first.id });
    expect(h.deliveries.read(h.actor, secondAttempt.id)).toMatchObject({ taskId: second.id });
    expect(h.dispatches).toHaveBeenCalledTimes(3);
    expect(h.dispatches.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      1,
    );
  });

  it.each(["static", "e2e"] as const)(
    "reuses the %s result comment when progress comments are disabled",
    async (channel) => {
      const h = harness({ progressEnabled: false });
      const first = h.makeTask(`result-${channel}-first`, channel);
      h.enqueue(first);
      expect(h.publisher.taskSummary(h.actor, first.id)).toBeNull();
      const firstResult = h.complete(first, false);
      // The native report-sealing callback supplies the original, pre-finalization snapshot.
      h.store.transaction(() => h.publisher.enqueueResult(firstResult.report, first));
      await h.run();
      const accepted = h.summary(first);
      const firstAttempt = h.history(accepted.id)[0]!;
      const second = h.makeTask(`result-${channel}-second`, channel);
      const secondResult = h.complete(second, false);
      h.store.transaction(() => h.publisher.enqueueResult(secondResult.report, second));
      await h.run();
      const current = h.summary(second);
      h.store.transaction(() => {
        h.publisher.enqueueResult(firstResult.report, firstResult.task);
        h.publisher.enqueueResult(secondResult.report, secondResult.task);
      });
      await h.run();

      expect(h.dispatches).toHaveBeenCalledTimes(2);
      expect(h.dispatches.mock.calls[0]![0].externalId).toBeNull();
      expect(h.dispatches.mock.calls[1]![0]).toMatchObject({
        marker: h.dispatches.mock.calls[0]![0].marker,
        externalId: accepted.externalId,
        previousBody: firstAttempt.body,
      });
      expect(current).toMatchObject({
        id: accepted.id,
        state: "synced",
        taskId: second.id,
        reportId: secondResult.report.report.id,
        externalId: accepted.externalId,
      });
      expect(h.summary(first)).toEqual(current);
      expect(h.summary(second)).toEqual(current);
      expect(h.deliveries.read(h.actor, firstAttempt.id)).toEqual(firstAttempt);
      expect(h.publisher.list(h.actor, h.repository.id).items).toHaveLength(1);
      expect(h.store.list("actionIntents")).toEqual([]);
    },
  );
});

describe("retained conversation comment migration", () => {
  it.each([
    { recovery: "sync", confirmed: false },
    { recovery: "enrollment", confirmed: false },
    { recovery: "sync", confirmed: true },
  ] as const)(
    "adopts a recovered legacy comment through $recovery with prior confirmation $confirmed",
    async ({ recovery, confirmed }) => {
      const h = harness();
      const legacyTask = h.makeTask(`legacy-automatic-${recovery}`);
      const { task, report } = h.complete(legacyTask, false);
      const subject = task.subjects[0]!;
      const request: InvestigationCreateActionIntentRequest = {
        idempotencyKey: `auto-reply:${report.report.id}`,
        workItemId: task.workItem.id,
        action: "comment",
        subjectRef: task.subjectRef,
        expectedRevisionKey: subject.revisionKey,
        expectedHeadSha: subject.kind === "original_pr" ? subject.headSha : null,
        reportRef: task.latestReportRef,
        payload: {
          kind: "feedback",
          body: "Synthetic retained automatic result.",
          findingIds: [],
          drafts: [],
        },
      };
      const intent: InvestigationActionIntentV1 = {
        schemaVersion: "InvestigationActionIntentV1",
        id: `synthetic-legacy-automatic-intent-${recovery}`,
        version: 1,
        idempotencyKey: request.idempotencyKey,
        action: "comment",
        repositoryId: h.repository.id,
        workItemId: task.workItem.id,
        actorId: `automatic-reply:${investigationContentDigest(h.repository.id).slice(0, 32)}`,
        subjectRef: request.subjectRef,
        expectedRevisionKey: request.expectedRevisionKey,
        expectedHeadSha: request.expectedHeadSha,
        reportRef: request.reportRef,
        payload: request.payload,
        payloadDigest: investigationContentDigest(request.payload),
        state: "unknown",
        guards: [],
        createdAt: task.updatedAt,
        confirmedAt: task.updatedAt,
        result: { message: "Synthetic legacy receipt was lost.", externalId: null, taskId: null },
      };
      const receipt = {
        id: `auto-reply:report:${report.report.id}`,
        reportId: report.report.id,
        taskId: task.id,
        workItemId: task.workItem.id,
        workItemKind: task.workItem.kind,
        workItemNumber: task.workItem.number,
        repository: h.repository,
        reportRef: task.latestReportRef,
        state: "unknown",
        body: "Synthetic retained automatic result.",
        intentId: intent.id,
        externalId: null,
        reason: "Synthetic response was lost.",
        settingsVersion: 1,
        templateVersion: 1,
        githubIdentity: { githubUserId: 33, githubLogin: "synthetic-publisher" },
        request,
        createdAt: task.updatedAt,
        updatedAt: task.updatedAt,
      };
      h.store.put("actionIntents", intent.id, intent);
      h.store.put("idempotency", receipt.id, receipt);
      let expectedMarker = `<!-- agentic-review-action:${intent.id}:${intent.payloadDigest} -->`;
      let expectedBody = receipt.body;
      let expectedExternalId = "810";
      if (confirmed) {
        const confirmedReportId = `earlier-${report.report.id}`;
        const confirmedReport: InvestigationResultV1 = {
          ...report,
          id: confirmedReportId,
          report: { ...report.report, id: confirmedReportId },
        };
        const reportRef = { ...task.latestReportRef!, id: confirmedReportId };
        const payload = {
          ...request.payload,
          body: "Synthetic earlier confirmed automatic result.",
        };
        const confirmedRequest: InvestigationCreateActionIntentRequest = {
          ...request,
          idempotencyKey: `auto-reply:${confirmedReportId}`,
          reportRef,
          payload,
        };
        const confirmedIntent: InvestigationActionIntentV1 = {
          ...intent,
          id: "synthetic-earlier-confirmed-intent",
          idempotencyKey: confirmedRequest.idempotencyKey,
          reportRef,
          payload,
          payloadDigest: investigationContentDigest(payload),
          state: "succeeded",
          result: {
            message: "Synthetic earlier receipt is known.",
            externalId: "809",
            taskId: null,
          },
        };
        h.store.put("reports", confirmedReportId, confirmedReport);
        h.store.put("actionIntents", confirmedIntent.id, confirmedIntent);
        h.store.put("idempotency", `auto-reply:report:${confirmedReportId}`, {
          ...receipt,
          id: `auto-reply:report:${confirmedReportId}`,
          reportId: confirmedReportId,
          reportRef,
          state: "sent",
          body: payload.body,
          intentId: confirmedIntent.id,
          externalId: "809",
          reason: null,
          request: confirmedRequest,
          updatedAt: task.createdAt,
        });
        expectedMarker = `<!-- agentic-review-action:${confirmedIntent.id}:${confirmedIntent.payloadDigest} -->`;
        expectedBody = payload.body;
        expectedExternalId = "809";
      }
      const first = h.makeTask(`blocked-by-legacy-${recovery}`);
      h.enqueue(first);
      await h.run();
      const blocked = h.summary(first);
      expect(blocked.state).toBe("conflict");
      expect(blocked.externalId).toBe(confirmed ? "809" : null);
      expect(h.dispatches).not.toHaveBeenCalled();

      // Existing recovery tests verify read-only reconciliation; model its durable result here.
      const recoveredIntent: InvestigationActionIntentV1 = {
        ...intent,
        state: "succeeded",
        result: { message: "Synthetic exact readback matched.", externalId: "810", taskId: null },
      };
      const recoveredReceipt = { ...receipt, state: "sent", externalId: "810", reason: null };
      h.store.put("actionIntents", intent.id, recoveredIntent);
      h.store.put("idempotency", receipt.id, recoveredReceipt);
      let current = first;
      if (recovery === "sync") {
        const available = h.summary(first);
        expect(available.availableActions).toContain("sync");
        h.publisher.sync(h.actor, available.id, {
          version: available.version,
          idempotencyKey: "adopt-recovered-legacy-comment",
        });
      } else {
        current = h.makeTask("after-legacy-recovery");
        h.enqueue(current);
      }
      await h.run();

      expect(h.dispatches).toHaveBeenCalledTimes(1);
      expect(h.dispatches.mock.calls[0]![0]).toMatchObject({
        externalId: expectedExternalId,
        marker: expectedMarker,
        previousBody: `${expectedBody}\n\n${expectedMarker}`,
      });
      expect(h.summary(current)).toMatchObject({
        id: blocked.id,
        state: "synced",
        taskId: current.id,
        externalId: expectedExternalId,
      });
      expect(h.store.get("actionIntents", intent.id)).toEqual(recoveredIntent);
      expect(h.store.get("idempotency", receipt.id)).toEqual(recoveredReceipt);
    },
  );

  it("keeps a sent comment's identity while adopting the newest retained task at startup", async () => {
    const h = harness();
    const first = h.makeTask("retained-sent");
    h.enqueue(first);
    await h.run();
    await h.publisher.stop();
    const original = h.summary(first);
    const firstAttempt = h.history(original.id)[0]!;
    seedRetainedPublication(h, h, first);

    const pendingSource = harness();
    pendingSource.clock.value = h.clock.value + 1_000;
    const latest = pendingSource.makeTask("retained-newest");
    pendingSource.enqueue(latest);
    const retiredRecord = seedRetainedPublication(h, pendingSource, latest);
    h.clock.value = pendingSource.clock.value;
    const restarted = h.createPublisher();
    await h.run(restarted);

    const migrated = h.summary(latest, restarted);
    expect(migrated).toMatchObject({
      id: original.id,
      taskId: latest.id,
      externalId: original.externalId,
    });
    expect(migrated.availableActions).toContain("sync");
    expect(h.dispatches).toHaveBeenCalledTimes(1);
    restarted.sync(h.actor, migrated.id, {
      version: migrated.version,
      idempotencyKey: "synchronize-newest-retained-task",
    });
    await h.run(restarted);

    expect(h.summary(first, restarted)).toEqual(h.summary(latest, restarted));
    expect(h.summary(latest, restarted)).toMatchObject({
      id: original.id,
      taskId: latest.id,
      externalId: original.externalId,
      state: "synced",
    });
    expect(h.dispatches).toHaveBeenCalledTimes(2);
    expect(h.dispatches.mock.calls[1]![0]).toMatchObject({
      marker: h.dispatches.mock.calls[0]![0].marker,
      externalId: original.externalId,
      previousBody: firstAttempt.body,
    });
    expect(h.deliveries.read(h.actor, firstAttempt.id)).toEqual(firstAttempt);
    expect(h.store.get<CommentPublication>("idempotency", retiredRecord.id)?.retiredTo).toBe(
      original.id,
    );
    const retired = restarted.getComment(h.actor, retiredRecord.id);
    expect(retired.availableActions).not.toContain("sync");
    expect(() =>
      restarted.sync(h.actor, retired.id, {
        version: retired.version,
        idempotencyKey: "cannot-revive-retired-comment",
      }),
    ).toThrow();
    await h.run(restarted);
    expect(h.dispatches).toHaveBeenCalledTimes(2);
    expect(h.dispatches.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      1,
    );
  });

  it("resolves a retained unknown create before publishing the latest retained task", async () => {
    const h = harness();
    const first = h.makeTask("retained-unknown");
    h.control.delivery = {
      state: "unknown",
      effect: "unknown",
      reasonCode: "mutation_response_unknown",
      message: "Synthetic historical create response was lost.",
      externalId: null,
    };
    h.enqueue(first);
    await h.run();
    await h.publisher.stop();
    const original = h.summary(first);
    const unknownAttempt = h.history(original.id)[0]!;
    seedRetainedPublication(h, h, first);

    const pendingSource = harness();
    pendingSource.clock.value = h.clock.value + 1_000;
    const latest = pendingSource.makeTask("retained-after-unknown");
    pendingSource.enqueue(latest);
    seedRetainedPublication(h, pendingSource, latest);
    h.clock.value = pendingSource.clock.value + 60_000;
    delete h.control.delivery;
    h.control.readback = {
      state: "succeeded",
      effect: "applied",
      message: "Synthetic historical create was found by exact readback.",
      externalId: "9001",
    };
    const restarted = h.createPublisher();
    await h.run(restarted);

    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(1);
    expect(h.reconcileProgressComment.mock.calls[0]![0]).toMatchObject({
      body: unknownAttempt.body,
      marker: h.dispatches.mock.calls[0]![0].marker,
      externalId: null,
    });
    expect(h.dispatches).toHaveBeenCalledTimes(2);
    expect(h.dispatches.mock.calls[1]![0]).toMatchObject({
      externalId: "9001",
      previousBody: unknownAttempt.body,
      marker: h.dispatches.mock.calls[0]![0].marker,
    });
    expect(h.summary(latest, restarted)).toMatchObject({
      id: original.id,
      taskId: latest.id,
      externalId: "9001",
      state: "synced",
    });
    expect(h.deliveries.read(h.actor, unknownAttempt.id)).toMatchObject({
      taskId: first.id,
      state: "succeeded",
      observations: [{ state: "succeeded" }],
    });
    expect(h.dispatches.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      1,
    );
  });

  it("starts safely when retained comments contain a historical repository identity", async () => {
    const h = harness();
    const first = h.makeTask("retained-old-repository");
    h.enqueue(first);
    await h.run();
    await h.publisher.stop();
    const original = seedRetainedPublication(h, h, first);
    const historicalRepository = {
      ...original.repository,
      githubRepositoryId: original.repository.githubRepositoryId - 1,
      fullName: "synthetic/ArchivedPowerToys",
    };
    h.store.put("idempotency", original.id, {
      ...original,
      repository: historicalRepository,
    });
    h.store.put("tasks", first.id, { ...first, repository: historicalRepository });

    const pendingSource = harness();
    pendingSource.clock.value = h.clock.value + 1_000;
    const latest = pendingSource.makeTask("retained-current-repository");
    pendingSource.enqueue(latest);
    seedRetainedPublication(h, pendingSource, latest);
    h.clock.value = pendingSource.clock.value;
    const restarted = h.createPublisher();
    expect(() => restarted.start()).not.toThrow();
    await restarted.drain();

    expect(h.dispatches).toHaveBeenCalledTimes(2);
    expect(h.publishProgressComment.mock.calls[1]![1]).toEqual(h.repository);
    expect(h.summary(latest, restarted)).toMatchObject({
      taskId: latest.id,
      state: "synced",
    });
    expect(h.reconcileProgressComment).not.toHaveBeenCalled();
    expect(h.store.get<CommentPublication>("idempotency", original.id)).toEqual({
      ...original,
      repository: historicalRepository,
    });
  });

  it("authorizes a new admission after reauthorization while retaining the conversation comment", async () => {
    const h = harness();
    const firstAdmission = h.admission("before-reauthorization");
    h.store.transaction(() => h.publisher.enqueueAssignment(firstAdmission));
    await h.run();
    const originalId = h.publisher.list(h.actor, h.repository.id).items[0]!.id;
    const original = h.publisher.getComment(h.actor, originalId);
    const originalRecord = h.store.get<CommentPublication>("idempotency", originalId)!;
    const previous = h.settings.read(h.actor, h.repository.id);
    const disabled = h.settings.update(h.actor, h.repository.id, {
      version: previous.version,
      enabled: false,
      progressEnabled: false,
      pullRequestTemplate: previous.pullRequestTemplate,
      issueTemplate: previous.issueTemplate,
      progressTemplates: previous.progressTemplates,
    });
    const renewed = h.settings.update(h.actor, h.repository.id, {
      version: disabled.version,
      enabled: true,
      progressEnabled: true,
      reauthorize: true,
      pullRequestTemplate: disabled.pullRequestTemplate,
      issueTemplate: disabled.issueTemplate,
      progressTemplates: disabled.progressTemplates,
    });
    const nextAdmission = h.admission("after-reauthorization");
    h.store.transaction(() => h.publisher.enqueueAssignment(nextAdmission));
    await h.run();

    expect(renewed.authorizationEpoch).toBeGreaterThan(originalRecord.grant.authorizationEpoch);
    expect(h.publisher.getComment(h.actor, originalId)).toMatchObject({
      id: originalId,
      state: "synced",
      externalId: original.externalId,
    });
    const current = h.store.get<CommentPublication>("idempotency", originalId)!;
    expect(current.grant.authorizationEpoch).toBe(renewed.authorizationEpoch);
    expect(current.grantHistory).toContainEqual(originalRecord.grantHistory[0]);
    expect(h.dispatches).toHaveBeenCalledTimes(2);
    expect(h.dispatches.mock.calls[1]![0]).toMatchObject({
      externalId: original.externalId,
      marker: h.dispatches.mock.calls[0]![0].marker,
      previousBody: h.dispatches.mock.calls[0]![0].body,
    });
    expect(h.publisher.list(h.actor, h.repository.id).items).toHaveLength(1);
  });
});
