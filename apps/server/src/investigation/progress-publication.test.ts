import {
  createInvestigationPreview,
  type InvestigationAttemptV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationResultV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint, investigationContentDigest } from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AutomaticReplySettingsUpdate,
  InvestigationAutomaticReplySettings,
} from "./auto-reply-settings.js";
import { defaultAutomaticReplyTemplates } from "./auto-reply-template.js";
import { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import type { CommentPublication } from "./progress-publication.js";
import { InvestigationProgressReplies } from "./progress-reply.js";
import {
  defaultProgressReplyTemplates,
  type InvestigationProgressTrigger,
} from "./progress-reply-template.js";
import { InvestigationStore } from "./store.js";
import type {
  InvestigationActionTransport,
  InvestigationGitHubIdentity,
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

function harness(options: { kind?: "pr" | "bug"; preTask?: boolean; e2e?: boolean } = {}) {
  const fixture = createInvestigationPreview(options.kind ?? "pr", { findingCount: 0 });
  if (options.e2e) {
    fixture.task.kind = "pr-e2e";
    fixture.result.context.task.kind = "pr-e2e";
  }
  const store = new InvestigationStore();
  stores.push(store);
  const clock = { value: Date.parse("2026-09-19T01:00:00.000Z") };
  const now = () => new Date(clock.value);
  const task: InvestigationTaskV1 = {
    ...fixture.task,
    state: "queued",
    latestReportRef: null,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  };
  const workItem: InvestigationWorkItemRecord = {
    ...task.workItem,
    repositoryId: task.repository.id,
    body: "Synthetic frozen source.",
    state: "open",
    subject: task.subjects[0]!,
    updatedAt: task.updatedAt,
  };
  store.insert("repositories", task.repository.id, task.repository);
  function saveTask() {
    store.put("workItems", workItem.id, workItem);
    store.put("tasks", task.id, task);
  }
  if (!options.preTask) saveTask();
  const actor: InvestigationOperatorPrincipal = {
    id: "synthetic-publication-operator",
    displayName: "Synthetic publication operator",
    repositoryIds: [task.repository.id],
    permissions: ["repository:manage", "action:prepare", "action:execute"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
  };
  const trigger: InvestigationProgressTrigger = {
    eventName: options.e2e
      ? "issue_comment"
      : task.workItem.kind === "pull_request"
        ? "pull_request"
        : "issues",
    ...(options.e2e ? { commandCommentId: 901 } : {}),
    actorUserId: 11,
    assigneeUserId: 22,
    actorLogin: "synthetic-assigner",
    assigneeLogin: "synthetic-worker",
  };
  const original = task.subjects.find((subject) => subject.id === task.subjectRef);
  const admission: TrustedAssignmentAdmission = {
    ...(options.e2e ? { mode: "e2e" as const } : {}),
    id: "synthetic-assignment-receipt",
    repository: task.repository,
    target: {
      id: "synthetic-admission-target",
      repositoryId: task.repository.id,
      kind: task.workItem.kind,
      number: task.workItem.number,
      githubWorkItemId: 12345,
    },
    trigger,
    receivedAt: now().toISOString(),
    expectedAssigneeUserId: trigger.assigneeUserId,
    ...(original?.kind === "original_pr" ? { headSha: original.headSha } : {}),
  };
  const settings = new InvestigationAutomaticReplySettings(store, true, now);
  settings.update(actor, task.repository.id, {
    version: 0,
    enabled: true,
    progressEnabled: true,
    pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
    issueTemplate: defaultAutomaticReplyTemplates.issue,
    progressTemplates: defaultProgressReplyTemplates,
  });
  const control: {
    assignmentAuthorized: boolean;
    identity: InvestigationGitHubIdentity;
    beforeDispatch?: () => void;
    delivery: InvestigationProgressCommentDelivery;
    readback: InvestigationProgressCommentDelivery;
  } = {
    assignmentAuthorized: true,
    identity: { githubUserId: 33, githubLogin: "synthetic-publisher" },
    delivery: {
      state: "succeeded",
      effect: "applied",
      message: "Synthetic comment accepted.",
      externalId: "9001",
    },
    readback: {
      state: "unknown",
      effect: "unknown",
      message: "Synthetic readback unavailable.",
      externalId: null,
    },
  };
  const dispatches = vi.fn<(request: InvestigationProgressCommentRequest) => void>();
  const publishProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["publishProgressComment"]>
  >(async (request, _repository, _target, _actor, beforeDispatch) => {
    control.beforeDispatch?.();
    try {
      beforeDispatch?.();
    } catch {
      return {
        state: "failed",
        effect: "not_sent",
        message: "Synthetic preflight rejected.",
        externalId: null,
      };
    }
    dispatches(structuredClone(request));
    return structuredClone(control.delivery);
  });
  const reconcileProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["reconcileProgressComment"]>
  >(async () => structuredClone(control.readback));
  const transport: InvestigationActionTransport = {
    supportedActions: ["comment"],
    readPublisherIdentity: async () => structuredClone(control.identity),
    publishProgressComment,
    reconcileProgressComment,
    readTarget: async () => ({
      kind: workItem.kind,
      state: "open",
      revisionKey: workItem.subject.revisionKey,
      headSha: workItem.subject.kind === "original_pr" ? workItem.subject.headSha : null,
    }),
    execute: async () => {
      throw new Error("Publication tests must use the mocked progress transport.");
    },
    reconcile: async () => {
      throw new Error("Publication tests must use the mocked progress readback.");
    },
  };
  const deliveries = new InvestigationCommentDeliveries({ store, now });
  function createPublisher(readbackAvailable = true) {
    const { reconcileProgressComment: _readback, ...withoutReadback } = transport;
    const publisher = new InvestigationProgressReplies({
      store,
      settings,
      transport: readbackAvailable ? transport : withoutReadback,
      deliveries,
      isAssignmentAuthorized: () => control.assignmentAuthorized,
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
  function enqueue() {
    store.transaction(() => publisher.enqueue(task, trigger));
  }
  function enqueueAssignment() {
    store.transaction(() => publisher.enqueueAssignment(admission));
  }
  function attachTask() {
    clock.value += 1;
    store.transaction(() => {
      saveTask();
      publisher.attachTask(admission.id, task);
    });
  }
  function transition(state: InvestigationTaskV1["state"], report?: InvestigationResultV1) {
    clock.value += 1;
    const result = report ?? (state === "completed" ? fixture.result : undefined);
    const current = store.get<InvestigationTaskV1>("tasks", task.id)!;
    const updated: InvestigationTaskV1 = {
      ...current,
      state,
      updatedAt: now().toISOString(),
      ...(result === undefined
        ? {}
        : {
            latestReportRef: {
              id: result.report.id,
              version: result.report.version,
              digest: result.report.logicalContentDigest,
            },
          }),
    };
    store.transaction(() => {
      if (result !== undefined) store.put("reports", result.report.id, result);
      store.put("tasks", task.id, updated);
      publisher.update(updated, result);
    });
    return updated;
  }
  async function run(destination = publisher) {
    destination.start();
    await destination.drain();
  }
  function summary(principal = actor) {
    const id = publisher.list(actor, task.repository.id).items[0]!.id;
    return publisher.getComment(principal, id);
  }
  function history() {
    return deliveries.list(actor, { commentId: summary().id, limit: 50 }).items;
  }
  function updateSettings(changes: Partial<Omit<AutomaticReplySettingsUpdate, "version">>) {
    const previous = settings.read(actor, task.repository.id);
    return settings.update(actor, task.repository.id, {
      version: previous.version,
      enabled: previous.enabled,
      progressEnabled: previous.progressEnabled,
      pullRequestTemplate: previous.pullRequestTemplate,
      issueTemplate: previous.issueTemplate,
      progressTemplates: previous.progressTemplates,
      ...changes,
    });
  }
  return {
    actor,
    admission,
    task,
    store,
    clock,
    now,
    settings,
    publisher,
    createPublisher,
    deliveries,
    control,
    dispatches,
    publishProgressComment,
    reconcileProgressComment,
    enqueue,
    enqueueAssignment,
    attachTask,
    transition,
    run,
    summary,
    history,
    updateSettings,
  };
}

describe("durable assignment comment publication", () => {
  it("keeps the accepted E2E command comment through preparation and task attachment", async () => {
    const h = harness({ preTask: true, e2e: true });
    h.enqueueAssignment();
    const accepted = h.summary();
    await h.run();
    const received = h.dispatches.mock.calls[0]![0];
    expect(received.expectedAssigneeUserId).toBeUndefined();
    expect(received.body).toContain("E2E verification received — preparing");
    expect(received.body).toContain("pull request comment 901");
    expect(received.body).not.toContain("assigned the pull request");
    h.attachTask();
    await h.run();
    const attached = h.dispatches.mock.calls.at(-1)![0];
    expect(h.summary()).toMatchObject({ id: accepted.id, taskId: h.task.id, externalId: "9001" });
    expect(attached).toMatchObject({
      marker: received.marker,
      externalId: "9001",
      previousBody: received.body,
    });
    expect(attached.body).toContain("E2E verification queued");
    expect(() =>
      h.publisher.enqueueAssignment({
        ...h.admission,
        trigger: { ...h.trigger, commandCommentId: 902 },
      }),
    ).toThrow("another comment scope");
  });

  it.each(["pr", "bug"] as const)(
    "publishes an accepted %s assignment before Task creation and attaches the same comment",
    async (kind) => {
      const h = harness({ kind, preTask: true });
      h.enqueueAssignment();
      h.enqueueAssignment();
      const accepted = h.summary();
      expect(accepted).toMatchObject({ taskId: null, workItemId: null, state: "pending" });
      expect(h.store.list("tasks")).toEqual([]);
      expect(h.store.list("workItems")).toEqual([]);

      await h.run();
      const first = h.history()[0]!;
      const earlyRequest = h.dispatches.mock.calls[0]![0];
      expect(h.dispatches).toHaveBeenCalledTimes(1);
      expect(earlyRequest).toMatchObject({ externalId: null, expectedAssigneeUserId: 22 });
      expect(earlyRequest.body).toContain("synthetic-assigner");
      expect(earlyRequest.body).toContain("synthetic-worker");
      if (kind === "bug") {
        expect(earlyRequest.body).toContain("the investigation snapshot has not been captured yet");
        expect(earlyRequest.body).not.toContain("snapshot captured at");
      }
      expect(first).toMatchObject({ taskId: null, workItemId: null, operation: "create" });

      h.attachTask();
      h.enqueueAssignment();
      await h.run();
      expect(h.summary()).toMatchObject({
        id: accepted.id,
        taskId: h.task.id,
        workItemId: h.task.workItem.id,
        state: "synced",
        externalId: "9001",
      });
      expect(h.deliveries.read(h.actor, first.id)).toEqual({
        ...first,
        taskId: h.task.id,
        workItemId: h.task.workItem.id,
      });
      expect(h.publisher.taskSummary(h.actor, h.task.id)?.id).toBe(accepted.id);

      h.transition("running");
      await h.run();
      h.transition("completed");
      await h.run();
      const requests = h.dispatches.mock.calls.map(([request]) => request);
      expect(requests).toHaveLength(4);
      expect(requests.filter((request) => request.externalId === null)).toHaveLength(1);
      expect(requests.slice(1).every((request) => request.externalId === "9001")).toBe(true);
      expect(new Set(requests.map((request) => request.marker))).toEqual(
        new Set([earlyRequest.marker]),
      );
      expect(requests[1]!.previousBody).toBe(earlyRequest.body);
      expect(h.history().every((attempt) => attempt.commentId === accepted.id)).toBe(true);
      expect(h.summary()).toMatchObject({ state: "synced", reportId: expect.any(String) });
      expect(h.store.list("actionIntents")).toEqual([]);
    },
  );

  it("denies the first dispatch when the accepted local assignment grant is revoked", async () => {
    const h = harness({ preTask: true });
    h.enqueueAssignment();
    h.control.beforeDispatch = () => {
      h.control.assignmentAuthorized = false;
    };
    await h.run();

    expect(h.publishProgressComment).toHaveBeenCalledTimes(1);
    expect(h.dispatches).not.toHaveBeenCalled();
    expect(h.summary()).toMatchObject({
      state: "paused",
      reasonCode: "assignment_not_current",
      nextAttemptAt: null,
      requiresAttention: true,
    });
    expect(h.history()).toHaveLength(1);
    expect(h.history()[0]).toMatchObject({ state: "failed", effect: "not_sent", externalId: null });
    expect(h.reconcileProgressComment).not.toHaveBeenCalled();
  });

  it("retries a definitive rejection with the same frozen body and a new immutable attempt", async () => {
    const h = harness();
    h.enqueue();
    h.control.delivery = {
      state: "failed",
      effect: "rejected",
      retryable: true,
      retryAfterMs: 120_000,
      reasonCode: "github_rate_limited",
      message: "Sensitive upstream diagnostics must not become public history.",
      externalId: null,
    };
    await h.run();
    const first = h.history()[0]!;
    const request = h.dispatches.mock.calls[0]![0];
    expect(h.summary()).toMatchObject({ state: "retrying", reasonCode: "github_rate_limited" });
    expect(first).toMatchObject({ state: "failed", effect: "rejected", attemptNumber: 1 });
    expect(first.reason).not.toContain("Sensitive upstream");

    h.updateSettings({
      progressTemplates: {
        ...defaultProgressReplyTemplates,
        received: `${defaultProgressReplyTemplates.received}\nNew received template.\n`,
      },
    });
    h.clock.value += 60_000;
    await h.run();
    expect(h.dispatches).toHaveBeenCalledTimes(1);
    h.clock.value += 60_000;
    h.control.delivery = {
      state: "succeeded",
      effect: "applied",
      message: "Synthetic retry accepted.",
      externalId: "9001",
    };
    await h.run();

    expect(h.dispatches.mock.calls[1]![0]).toEqual(request);
    const attempts = h.history();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      state: "succeeded",
      effect: "applied",
      attemptNumber: 2,
      body: first.body,
      settingsVersion: first.settingsVersion,
    });
    expect(attempts[0]!.id).not.toBe(first.id);
    expect(h.deliveries.read(h.actor, first.id)).toEqual(first);
    expect(() =>
      h.deliveries.finish(first.id, { state: "succeeded", effect: "applied", externalId: "9001" }),
    ).toThrow(expect.objectContaining({ code: "comment_delivery_immutable" }));
  });

  it("applies edited templates only to a new logical Task update", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    const before = h.summary();
    const history = h.history();
    const revisions = h.publisher.revisions(h.actor, before.id);
    const settings = h.settings.read(h.actor, h.task.repository.id);
    const updated = h.updateSettings({
      progressTemplates: {
        ...defaultProgressReplyTemplates,
        started: `${defaultProgressReplyTemplates.started}\nNew running template.\n`,
      },
    });
    await h.run();

    expect(updated.authorizationEpoch).toBe(settings.authorizationEpoch);
    expect(h.summary()).toEqual(before);
    expect(h.publisher.revisions(h.actor, before.id)).toEqual(revisions);
    expect(h.history()).toEqual(history);
    expect(h.dispatches).toHaveBeenCalledTimes(1);

    h.transition("running");
    await h.run();
    expect(h.dispatches.mock.calls[1]![0].body).toContain("New running template.");
    expect(h.history()[0]!.settingsVersion).toBe(updated.version);
    expect(h.deliveries.read(h.actor, history[0]!.id)).toEqual(history[0]);
  });

  it("requires explicit synchronization after authorization changes and guards command replay", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    const before = h.summary();
    const originalEpoch = h.settings.read(h.actor, h.task.repository.id).authorizationEpoch;
    h.updateSettings({ enabled: false, progressEnabled: false });
    h.transition("running");
    expect(h.summary()).toMatchObject({ state: "paused", reasonCode: "authorization_changed" });
    const renewed = h.updateSettings({ enabled: true, progressEnabled: true, reauthorize: true });
    expect(renewed.authorizationEpoch).toBeGreaterThan(originalEpoch);
    await h.run();
    expect(h.dispatches).toHaveBeenCalledTimes(1);
    const paused = h.summary();
    expect(paused.availableActions).toContain("sync");
    expect(() =>
      h.publisher.sync(h.actor, paused.id, {
        version: before.version,
        idempotencyKey: "stale-sync-command",
      }),
    ).toThrow(expect.objectContaining({ code: "comment_version_conflict" }));

    const command = { version: paused.version, idempotencyKey: "resume-publication" };
    const requested = h.publisher.sync(h.actor, paused.id, command);
    expect(requested.state).toBe("pending");
    expect(h.publisher.sync(h.actor, paused.id, command)).toEqual(requested);
    expect(() =>
      h.publisher.sync(h.actor, paused.id, { ...command, version: requested.version }),
    ).toThrow(expect.objectContaining({ code: "comment_command_conflict" }));
    await h.run();

    expect(h.dispatches).toHaveBeenCalledTimes(2);
    expect(h.dispatches.mock.calls[1]![0].externalId).toBe("9001");
    expect(h.summary().state).toBe("synced");
    expect(h.publisher.sync(h.actor, paused.id, command)).toEqual(requested);
    await h.run();
    expect(h.dispatches).toHaveBeenCalledTimes(2);
    const saved = h.store.get<CommentPublication>("idempotency", paused.id)!;
    expect(saved.grantHistory.map((grant) => grant.source)).toEqual(["enrollment", "sync"]);
    expect(saved.grant.authorizationEpoch).toBe(renewed.authorizationEpoch);
  });

  it("explicitly reconciles an unknown write without publishing a newer outcome or adding an attempt", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    const first = h.history()[0]!;
    h.control.delivery = {
      state: "unknown",
      effect: "unknown",
      reasonCode: "mutation_response_unknown",
      message: "Synthetic response was lost.",
      externalId: "9001",
    };
    h.transition("running");
    await h.run();
    const uncertain = h.history()[0]!;
    const originalReceipt = h.store.get<{ originalReceipt: unknown }>(
      "commentDeliveries",
      uncertain.id,
    )!.originalReceipt;
    h.transition("completed");
    const unresolved = h.summary();
    expect(unresolved).toMatchObject({ state: "unconfirmed", availableActions: ["reconcile"] });
    h.control.readback = {
      state: "succeeded",
      effect: "applied",
      message: "Synthetic exact readback matched.",
      externalId: "9001",
    };
    const command = { version: unresolved.version, idempotencyKey: "readback-only" };
    const requested = h.publisher.reconcile(h.actor, unresolved.id, command);
    await h.run();

    expect(h.publishProgressComment).toHaveBeenCalledTimes(2);
    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(1);
    expect(h.reconcileProgressComment.mock.calls[0]![0].body).toBe(uncertain.body);
    expect(h.summary()).toMatchObject({
      state: "needs_attention",
      reasonCode: "synchronization_required",
      requiresAttention: true,
      nextAttemptAt: null,
      externalId: "9001",
    });
    expect(h.summary().availableActions).toContain("sync");
    expect(h.history()).toHaveLength(2);
    expect(h.deliveries.read(h.actor, first.id)).toEqual(first);
    expect(h.deliveries.read(h.actor, uncertain.id)).toMatchObject({
      id: uncertain.id,
      state: "succeeded",
      effect: "applied",
      body: uncertain.body,
      startedAt: uncertain.startedAt,
      finishedAt: uncertain.finishedAt,
      observations: [{ state: "succeeded" }],
    });
    expect(
      h.store.get<{ originalReceipt: unknown }>("commentDeliveries", uncertain.id)!.originalReceipt,
    ).toEqual(originalReceipt);
    expect(h.publisher.reconcile(h.actor, unresolved.id, command)).toEqual(requested);
    await h.run();
    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(1);
    expect(h.publishProgressComment).toHaveBeenCalledTimes(2);
  });

  it.each(["target", "transport"] as const)(
    "exhausts readback after repeated %s preflight failures without another write attempt",
    async (failure) => {
      const h = harness();
      h.enqueue();
      h.control.delivery = {
        state: "unknown",
        effect: "unknown",
        reasonCode: "mutation_response_unknown",
        message: "Synthetic response was lost.",
        externalId: null,
      };
      await h.run();
      await h.publisher.stop();
      const attempt = h.history()[0]!;
      const originalReceipt = h.store.get<{ originalReceipt: unknown }>(
        "commentDeliveries",
        attempt.id,
      )!.originalReceipt;
      if (failure === "target") {
        h.store.put("repositories", h.task.repository.id, {
          ...h.task.repository,
          githubRepositoryId: h.task.repository.githubRepositoryId + 1,
        });
      }
      const recovering = h.createPublisher(failure !== "transport");
      for (let index = 0; index < 3; index += 1) {
        h.clock.value += 120_000;
        await h.run(recovering);
      }
      expect(h.summary()).toMatchObject({
        state: "unconfirmed",
        reasonCode: "reconciliation_exhausted",
        requiresAttention: true,
        nextAttemptAt: null,
      });
      expect(h.publishProgressComment).toHaveBeenCalledTimes(1);
      expect(h.dispatches).toHaveBeenCalledTimes(1);
      expect(h.reconcileProgressComment).not.toHaveBeenCalled();
      expect(h.history()).toHaveLength(1);
      expect(h.history()[0]).toMatchObject({
        id: attempt.id,
        state: "unknown",
        effect: "unknown",
        body: attempt.body,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        attemptNumber: attempt.attemptNumber,
      });
      expect(h.history()[0]!.observations).toHaveLength(3);
      expect(
        h.store.get<{ originalReceipt: unknown }>("commentDeliveries", attempt.id)!.originalReceipt,
      ).toEqual(originalReceipt);
      h.clock.value += 1_000_000;
      await h.run(recovering);
      expect(h.history()).toHaveLength(1);
      expect(h.publishProgressComment).toHaveBeenCalledTimes(1);
    },
  );

  it("records only an observation when explicit reconciliation fails before reading a confirmed comment", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    const confirmed = h.summary();
    const attempt = h.history()[0]!;
    const originalReceipt = h.store.get<{ originalReceipt: unknown }>(
      "commentDeliveries",
      attempt.id,
    )!.originalReceipt;
    expect(h.store.get<CommentPublication>("idempotency", confirmed.id)!.operation).toBeNull();
    h.publisher.reconcile(h.actor, confirmed.id, {
      version: confirmed.version,
      idempotencyKey: "confirmed-readback-preflight-failed",
    });
    h.store.put("repositories", h.task.repository.id, {
      ...h.task.repository,
      githubRepositoryId: h.task.repository.githubRepositoryId + 1,
    });
    await h.run();

    expect(h.publishProgressComment).toHaveBeenCalledTimes(1);
    expect(h.reconcileProgressComment).not.toHaveBeenCalled();
    expect(h.history()).toHaveLength(1);
    expect(h.history()[0]).toEqual({
      ...attempt,
      observations: [expect.objectContaining({ state: "unknown" })],
    });
    expect(
      h.store.get<{ originalReceipt: unknown }>("commentDeliveries", attempt.id)!.originalReceipt,
    ).toEqual(originalReceipt);
    expect(h.summary()).toMatchObject({
      state: "unconfirmed",
      requiresAttention: true,
      nextAttemptAt: null,
    });
  });

  it("closes a superseded attempt left by a crash before dispatch", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    await h.publisher.stop();
    h.transition("running");
    const record = h.store.get<CommentPublication>("idempotency", h.summary().id)!;
    const body = `Synthetic prepared running update.\n\n${record.marker}`;
    const abandoned = h.deliveries.begin({
      commentId: record.id,
      mode: "progress",
      repositoryId: record.repository.id,
      repositoryFullName: record.repository.fullName,
      workItemId: record.workItemId,
      workItemKind: record.target.kind,
      workItemNumber: record.target.number,
      taskId: record.taskId,
      reportId: null,
      operation: "update",
      body,
      externalId: "9001",
      settingsVersion: record.desired.policy.settingsVersion,
      templateVersion: record.desired.policy.templateVersion,
    });
    const crashed: CommentPublication = {
      ...record,
      operation: {
        revision: record.desired,
        request: {
          marker: record.marker,
          body,
          externalId: "9001",
          previousBody: record.confirmed!.body,
        },
        attemptId: abandoned.id,
        dispatched: false,
        finished: false,
      },
      state: "sending",
      writeAttempts: 1,
      lastAttemptId: abandoned.id,
      lastAttemptAt: abandoned.startedAt,
      claim: { ownerId: "stopped-process", token: "expired-claim", expiresAt: h.clock.value - 1 },
    };
    h.store.put("idempotency", record.id, crashed);
    h.transition("failed");
    await h.run(h.createPublisher());

    expect(h.publishProgressComment).toHaveBeenCalledTimes(2);
    expect(h.dispatches.mock.calls.map(([request]) => request.body)).not.toContain(body);
    expect(h.deliveries.read(h.actor, abandoned.id)).toMatchObject({
      state: "cancelled",
      effect: "not_sent",
      body,
      attemptNumber: 2,
      finishedAt: h.now().toISOString(),
      observations: [],
    });
    expect(h.store.get("commentDeliveries", abandoned.id)).toMatchObject({
      state: "cancelled",
      originalReceipt: { state: "cancelled", effect: "not_sent" },
    });
    expect(h.history()).toHaveLength(3);
    expect(h.history().every((attempt) => attempt.state !== "sending")).toBe(true);
    expect(h.summary().state).toBe("synced");
  });

  it("exposes scoped summaries and only the recovery actions available to each actor", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    const reader: InvestigationOperatorPrincipal = {
      ...h.actor,
      id: "synthetic-reader",
      permissions: [],
      actionCapabilities: [],
    };
    const reconciler: InvestigationOperatorPrincipal = {
      ...reader,
      permissions: ["action:prepare"],
      actionCapabilities: ["comment"],
    };
    expect(h.summary(reader).availableActions).toEqual([]);
    expect(h.summary(reconciler).availableActions).toEqual(["reconcile"]);
    expect(h.summary()).toMatchObject({
      repositoryId: h.task.repository.id,
      workItemId: h.task.workItem.id,
      taskId: h.task.id,
      commentUrl: `https://github.com/${h.task.repository.fullName}/pull/${h.task.workItem.number}#issuecomment-9001`,
    });
    expect(h.publisher.taskSummaries(reader, [h.task.id, h.task.id]).items).toHaveLength(1);
    expect(() => h.summary({ ...reader, repositoryIds: [] })).toThrow(
      expect.objectContaining({ code: "repository_forbidden" }),
    );
    expect(() =>
      h.publisher.sync(reconciler, h.summary().id, {
        version: h.summary().version,
        idempotencyKey: "reader-cannot-write",
      }),
    ).toThrow(expect.objectContaining({ code: "comment_action_forbidden" }));
  });

  it("classifies only the exact confirmed comment on its accepted conversation", async () => {
    const h = harness({ preTask: true });
    h.enqueueAssignment();
    await h.run();
    const comment = {
      externalId: "9001",
      authorUserId: h.control.identity.githubUserId,
      body: h.dispatches.mock.calls[0]![0].body,
      issueUrl: `https://api.github.com/repos/${h.task.repository.fullName}/issues/${h.task.workItem.number}`,
    };
    const classify = (change: Partial<typeof comment>) =>
      h.publisher.classifyProgressComment(h.task.repository, h.admission.target, {
        ...comment,
        ...change,
      });
    expect(classify({})).toEqual({
      kind: "agentic_review_progress",
      publicationId: h.summary().id,
    });
    for (const change of [
      { authorUserId: 44 },
      { externalId: "9002" },
      { body: `${comment.body}\nAn untrusted edit.` },
      { body: h.dispatches.mock.calls[0]![0].marker },
      { issueUrl: `${comment.issueUrl}0` },
    ]) {
      expect(classify(change)).toBeUndefined();
    }
    expect(
      h.publisher.classifyProgressComment(
        h.task.repository,
        { ...h.admission.target, githubWorkItemId: h.admission.target.githubWorkItemId + 1 },
        comment,
      ),
    ).toBeUndefined();
    expect(
      h.publisher.classifyProgressComment(
        { ...h.task.repository, githubRepositoryId: h.task.repository.githubRepositoryId + 1 },
        h.admission.target,
        comment,
      ),
    ).toBeUndefined();
  });

  it("coalesces accepted phase updates while a terminal outcome bypasses the phase interval", async () => {
    const h = harness({ preTask: true });
    h.enqueueAssignment();
    await h.run();
    h.attachTask();
    await h.run();
    const attempt: InvestigationAttemptV1 = {
      schemaVersion: "InvestigationAttemptV1",
      id: "synthetic-running-attempt",
      taskId: h.task.id,
      number: 1,
      workerId: "synthetic-worker",
      leaseVersion: 1,
      state: "running",
      startedAt: h.now().toISOString(),
      finishedAt: null,
      terminationReason: null,
    };
    h.store.put("attempts", attempt.id, { attempt });
    const running = h.transition("running");
    await h.run();
    const checkpoint = createInvestigationCheckpoint({
      task: running,
      attemptId: attempt.id,
      checkpointId: "synthetic-phase-checkpoint",
      leaseVersion: attempt.leaseVersion,
      recordedAt: h.now().toISOString(),
    });
    function acceptPhase(phase: NonNullable<InvestigationLoopCheckpointV1["lastPhase"]>) {
      h.clock.value += 1;
      checkpoint.version += 1;
      checkpoint.lastPhase = phase;
      checkpoint.recordedAt = h.now().toISOString();
      const { digest: _digest, ...content } = checkpoint;
      checkpoint.digest = investigationContentDigest(content);
      h.store.transaction(() => {
        h.store.put("checkpoints", running.id, checkpoint);
        h.publisher.updateProgress(running, checkpoint, attempt);
      });
    }
    acceptPhase("discovery");
    const beforeReattach = h.summary();
    const revisionsBeforeReattach = h.publisher.revisions(h.actor, beforeReattach.id);
    const deliveriesBeforeReattach = h.history();
    h.clock.value += 1;
    h.store.transaction(() => h.publisher.attachTask(h.admission.id, running));
    expect(h.summary()).toEqual(beforeReattach);
    expect(h.publisher.revisions(h.actor, beforeReattach.id)).toEqual(revisionsBeforeReattach);
    expect(h.history()).toEqual(deliveriesBeforeReattach);
    const afterDiscovery = h.publisher.revisions(h.actor, h.summary().id).items.length;
    acceptPhase("discovery");
    expect(h.publisher.revisions(h.actor, h.summary().id).items).toHaveLength(afterDiscovery);
    acceptPhase("finalize");
    await h.run();
    expect(h.dispatches).toHaveBeenCalledTimes(3);
    h.clock.value += 120_000;
    await h.run();
    expect(h.dispatches).toHaveBeenCalledTimes(4);
    expect(h.dispatches.mock.calls[3]![0].body).toContain("**Recorded phase:** finalize");
    expect(h.dispatches.mock.calls[3]![0].body).not.toContain("**Recorded phase:** discovery");

    acceptPhase("discovery");
    h.transition("completed");
    await h.run();
    expect(h.dispatches).toHaveBeenCalledTimes(5);
    expect(h.summary()).toMatchObject({ state: "synced", nextAttemptAt: null });
    expect(h.publisher.revisions(h.actor, h.summary().id).items[0]!.stage).toBe("completed");
  });
});
