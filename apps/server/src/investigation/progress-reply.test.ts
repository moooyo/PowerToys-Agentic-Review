import {
  createInvestigationPreview,
  type InvestigationCommentDelivery,
  type InvestigationResultV1,
  type InvestigationTaskV1,
  type InvestigationUsageSummary,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint } from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationAutomaticReplySettings } from "./auto-reply-settings.js";
import {
  defaultAutomaticReplyTemplates,
  renderAutomaticReply,
  renderAutomaticReplyParts,
} from "./auto-reply-template.js";
import { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import type { CommentPublication } from "./progress-publication.js";
import { InvestigationProgressReplies, type ProgressReplyReceipt } from "./progress-reply.js";
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
import { investigationUsagePublicationPendingKey } from "./usage-ledger.js";

const stores: InvestigationStore[] = [];
const publishers: InvestigationProgressReplies[] = [];

afterEach(async () => {
  await Promise.all(publishers.splice(0).map((publisher) => publisher.stop()));
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

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
    progressEnabled?: boolean;
    legacySettings?: boolean;
    externalWrites?: boolean;
    maximumAttempts?: number;
    usage?: InvestigationUsageSummary;
    prepareReportMedia?: (
      report: InvestigationResultV1,
      task: InvestigationTaskV1,
    ) => Promise<string>;
  } = {},
) {
  const kind = options.kind ?? "pr";
  const fixture = createInvestigationPreview(kind, { findingCount: 0 });
  const store = new InvestigationStore();
  stores.push(store);
  const clock = { value: Date.parse("2026-09-18T14:00:00.000Z") };
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
    body: "Synthetic source snapshot.",
    state: "open",
    subject: task.subjects[0]!,
    updatedAt: task.updatedAt,
  };
  store.insert("repositories", task.repository.id, task.repository);
  store.insert("workItems", workItem.id, workItem);
  store.insert("tasks", task.id, task);
  const actor: InvestigationOperatorPrincipal = {
    id: "synthetic-progress-authorizer",
    displayName: "Synthetic progress authorizer",
    repositoryIds: [task.repository.id],
    permissions: ["repository:manage", "action:prepare", "action:execute"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
  };
  const trigger: InvestigationProgressTrigger = {
    eventName: kind === "pr" ? "pull_request" : "issues",
    actorUserId: 11,
    assigneeUserId: 22,
    actorLogin: "synthetic-assigner",
    assigneeLogin: "synthetic-worker",
  };
  const settings = new InvestigationAutomaticReplySettings(store, true, now);
  settings.update(actor, task.repository.id, {
    version: 0,
    enabled: true,
    pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
    issueTemplate: defaultAutomaticReplyTemplates.issue,
    ...(options.legacySettings
      ? {}
      : {
          progressEnabled: options.progressEnabled ?? true,
          progressTemplates: defaultProgressReplyTemplates,
        }),
  });
  const control: {
    operator: InvestigationOperatorPrincipal | null;
    identity: InvestigationGitHubIdentity;
    beforeIdentity?: () => void | Promise<void>;
    beforeDispatch?: (request: InvestigationProgressCommentRequest) => void | Promise<void>;
    afterDispatch?: (request: InvestigationProgressCommentRequest) => void | Promise<void>;
    reconcile: InvestigationProgressCommentDelivery;
  } = {
    operator: actor,
    identity: { githubUserId: 33, githubLogin: "synthetic-publisher" },
    reconcile: { state: "unknown", message: "Synthetic receipt unavailable.", externalId: null },
  };
  const mutations = vi.fn<(request: InvestigationProgressCommentRequest) => void>();
  const publishProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["publishProgressComment"]>
  >(async (request, _repository, _workItem, _actor, beforeDispatch) => {
    await control.beforeDispatch?.(request);
    // Match the real transport, which converts rejected preflight into a failed receipt.
    try {
      beforeDispatch?.();
    } catch {
      return { state: "failed", message: "Synthetic preflight rejected.", externalId: null };
    }
    mutations(structuredClone(request));
    await control.afterDispatch?.(request);
    return { state: "succeeded", message: "Synthetic comment accepted.", externalId: "9001" };
  });
  const reconcileProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["reconcileProgressComment"]>
  >(async () => structuredClone(control.reconcile));
  const readPublisherIdentity = vi.fn(async () => {
    await control.beforeIdentity?.();
    return structuredClone(control.identity);
  });
  const transport: InvestigationActionTransport = {
    supportedActions: ["comment"],
    readPublisherIdentity,
    publishProgressComment,
    reconcileProgressComment,
    readTarget: async () => ({
      kind: workItem.kind,
      state: "open",
      revisionKey: workItem.subject.revisionKey,
      headSha: workItem.subject.kind === "original_pr" ? workItem.subject.headSha : null,
    }),
    execute: async () => {
      throw new Error("Progress comments must not create a separate report comment.");
    },
    reconcile: async () => {
      throw new Error("Progress comments use their own frozen operation.");
    },
  };
  const onError = vi.fn<(code: string) => void>();
  function createPublisher() {
    const publisher = new InvestigationProgressReplies({
      store,
      settings,
      transport,
      resolveOperator: (id) => (control.operator?.id === id ? control.operator : null),
      enableExternalWrites: options.externalWrites ?? true,
      now,
      retryDelayMs: 60_000,
      leaseDurationMs: 60_000,
      maximumAttempts: options.maximumAttempts ?? 3,
      onError,
      ...(options.usage === undefined ? {} : { usageSummary: () => options.usage! }),
      ...(options.prepareReportMedia === undefined
        ? {}
        : { prepareReportMedia: options.prepareReportMedia }),
    });
    publishers.push(publisher);
    return publisher;
  }
  const publisher = createPublisher();
  function enqueue(source = task, event = trigger, destination = publisher) {
    store.transaction(() => destination.enqueue(source, event));
  }
  function transition(state: InvestigationTaskV1["state"], report?: InvestigationResultV1) {
    clock.value += 1;
    const source = report ?? (state === "completed" ? fixture.result : undefined);
    const current = store.get<InvestigationTaskV1>("tasks", task.id)!;
    const updated: InvestigationTaskV1 = {
      ...current,
      state,
      updatedAt: now().toISOString(),
      ...(source === undefined
        ? {}
        : {
            latestReportRef: {
              id: source.report.id,
              version: source.report.version,
              digest: source.report.logicalContentDigest,
            },
          }),
    };
    store.transaction(() => {
      if (source !== undefined) store.put("reports", source.report.id, source);
      store.put("tasks", updated.id, updated);
      publisher.update(updated, source);
    });
    return updated;
  }
  async function run(destination = publisher) {
    destination.start();
    await destination.drain();
  }
  function receipt(destination = publisher): ProgressReplyReceipt {
    return destination.list(actor, task.repository.id).items[0]!;
  }
  function updateSettings(enabled: boolean, progressEnabled = true) {
    const previous = settings.read(actor, task.repository.id);
    settings.update(actor, task.repository.id, {
      version: previous.version,
      enabled,
      pullRequestTemplate: previous.pullRequestTemplate,
      issueTemplate: previous.issueTemplate,
      progressEnabled: enabled && progressEnabled,
      progressTemplates: previous.progressTemplates,
    });
  }
  return {
    actor,
    task,
    fixture,
    store,
    clock,
    now,
    settings,
    publisher,
    trigger,
    control,
    transport,
    mutations,
    publishProgressComment,
    reconcileProgressComment,
    readPublisherIdentity,
    createPublisher,
    enqueue,
    transition,
    run,
    receipt,
    updateSettings,
    onError,
  };
}

describe("assignment progress comment outbox", () => {
  // Diagnostic identifiers are displayed literally after Markdown underscore escaping.
  const diagnosticText = (body: string | null) => body?.replaceAll("\\_", "_") ?? "";
  const sourceBlockers = [
    [
      "SOURCE_TREE_UNSUPPORTED",
      "repository entry the worker cannot safely prepare",
      "supports the repository's source layout",
    ],
    [
      "SOURCE_SUBMODULE_UNAVAILABLE",
      "pinned submodule commit could not be obtained",
      "availability of the recorded commit",
    ],
    [
      "SOURCE_SUBMODULE_UNSUPPORTED",
      "submodule configuration the worker cannot safely prepare",
      "supports this submodule configuration",
    ],
    [
      "SOURCE_SUBMODULE_LIMIT_EXCEEDED",
      "exceeded the worker's configured source limits",
      "submodule source limits and repository size",
    ],
    [
      "SOURCE_SUBMODULE_BINDING_MISMATCH",
      "did not match the commit recorded by its parent repository",
      "prepare the exact pinned commits",
    ],
  ] as const;

  it.each(sourceBlockers)(
    "publishes controlled source blocker %s without private details",
    async (code, reason, action) => {
      const h = harness();
      h.enqueue();
      await h.run();
      const blocked = createInvestigationPreview("pr", {
        outcome: "blocked",
        findingCount: 0,
      }).result;
      blocked.diagnostics = [
        {
          id: "source-blocker",
          code,
          category: "blocker",
          retryable: true,
          message:
            "Private diagnostic C:\\private\\submodule https://private.example/repo.git?token=private-source-token",
          evidenceRefs: [],
          prerequisiteRefs: [],
        },
      ];
      h.store.put("attempts", blocked.context.attempt.id, {
        attempt: {
          ...h.fixture.attempt,
          id: blocked.context.attempt.id,
          number: blocked.context.attempt.number,
          taskId: h.task.id,
          state: "blocked",
        },
      });
      const task = h.transition("blocked", blocked);
      await h.run();
      expect(h.receipt()).toMatchObject({ stage: "failed", state: "sent", externalId: "9001" });
      expect(diagnosticText(h.receipt().body)).toContain(code);
      expect(h.receipt().body).toContain(reason);
      expect(h.receipt().body).toContain(action);
      expect(h.receipt().body).not.toMatch(
        /private-source-token|private\.example|C:\\private|Private diagnostic/u,
      );
      h.publisher.update(task);
      await h.run();
      expect(diagnosticText(h.receipt().body)).toContain(code);
      expect(
        h.mutations.mock.calls.filter(([request]) => request.externalId === null),
      ).toHaveLength(1);
    },
  );

  it("uses only the latest terminal diagnostic and falls back for an unknown blocker", async () => {
    const h = harness();
    h.enqueue();
    const blocked = createInvestigationPreview("pr", {
      outcome: "blocked",
      findingCount: 0,
    }).result;
    const diagnostic = {
      id: "old-blocker",
      code: "SOURCE_SUBMODULE_UNAVAILABLE",
      category: "blocker" as const,
      retryable: true,
      message: "Private earlier source failure.",
      evidenceRefs: [],
      prerequisiteRefs: [],
    };
    blocked.diagnostics = [
      diagnostic,
      {
        ...diagnostic,
        id: "current-blocker",
        code: "PRIVATE_UNKNOWN_BLOCKER",
        message: "private-unknown-reason",
      },
    ];
    h.store.put("attempts", blocked.context.attempt.id, {
      attempt: { ...h.fixture.attempt, state: "blocked" },
    });
    h.transition("blocked", blocked);
    await h.run();
    expect(h.receipt().body).toContain("waiting for required information");
    expect(diagnosticText(h.receipt().body)).not.toContain("SOURCE_SUBMODULE_UNAVAILABLE");
    expect(diagnosticText(h.receipt().body)).not.toContain("PRIVATE_UNKNOWN_BLOCKER");
    expect(h.receipt().body).not.toContain("private-unknown-reason");
  });

  it.each(["current", "previous"] as const)(
    "uses source blocker checkpoints only from the %s attempt",
    async (which) => {
      const h = harness();
      h.enqueue();
      const latest = {
        ...h.fixture.attempt,
        id: "latest-source-attempt",
        number: 2,
        state: "blocked" as const,
      };
      h.store.put("attempts", latest.id, { attempt: latest });
      const checkpoint = createInvestigationCheckpoint({
        task: h.task,
        attemptId: which === "current" ? latest.id : h.fixture.attempt.id,
        checkpointId: "source-blocker-checkpoint",
        leaseVersion: latest.leaseVersion,
        recordedAt: h.now().toISOString(),
      });
      checkpoint.stopReason = "blocked";
      checkpoint.analysis.diagnostics = [
        {
          id: "source-blocker",
          code: "SOURCE_SUBMODULE_UNAVAILABLE",
          category: "blocker",
          retryable: true,
          message: "private-checkpoint-reason",
          evidenceRefs: [],
          prerequisiteRefs: [],
        },
      ];
      h.store.put("checkpoints", h.task.id, checkpoint);
      h.transition("blocked");
      await h.run();
      if (which === "current")
        expect(diagnosticText(h.receipt().body)).toContain("SOURCE_SUBMODULE_UNAVAILABLE");
      else {
        expect(h.receipt().body).toContain("waiting for required information");
        expect(diagnosticText(h.receipt().body)).not.toContain("SOURCE_SUBMODULE_UNAVAILABLE");
      }
      expect(h.receipt().body).not.toContain("private-checkpoint-reason");
    },
  );

  it("does not reuse a blocked report reason from a previous attempt or Task", async () => {
    const h = harness();
    h.enqueue();
    const blocked = createInvestigationPreview("pr", {
      outcome: "blocked",
      findingCount: 0,
    }).result;
    blocked.diagnostics = [
      {
        id: "source-blocker",
        code: "SOURCE_SUBMODULE_UNAVAILABLE",
        category: "blocker",
        retryable: true,
        message: "private-old-report-reason",
        evidenceRefs: [],
        prerequisiteRefs: [],
      },
    ];
    h.store.put("attempts", "new-attempt", {
      attempt: { ...h.fixture.attempt, id: "new-attempt", number: 2, state: "blocked" },
    });
    const previous = h.transition("blocked", blocked);
    await h.run();
    expect(h.receipt().body).toContain("waiting for required information");
    expect(diagnosticText(h.receipt().body)).not.toContain("SOURCE_SUBMODULE_UNAVAILABLE");
    h.clock.value += 1;
    const nextTask: InvestigationTaskV1 = {
      ...h.task,
      id: "new-conversation-task",
      state: "queued",
      createdAt: h.now().toISOString(),
      updatedAt: h.now().toISOString(),
    };
    h.store.put("tasks", nextTask.id, nextTask);
    h.enqueue(nextTask);
    await h.run();
    const before = h.receipt();
    h.publisher.update(previous, blocked);
    await h.run();
    expect(h.receipt()).toEqual(before);
    expect(diagnosticText(h.receipt().body)).not.toContain("SOURCE_SUBMODULE_UNAVAILABLE");
    expect(h.mutations.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      1,
    );
  });

  it("coalesces same-phase usage without checkpoints and merges completion immediately", async () => {
    const usage: InvestigationUsageSummary = {
      usage: unavailableInvestigationTokenUsage(),
      reportedTokens: 0,
      completeness: "unavailable",
      invocationCount: 0,
      activeInvocationCount: 0,
      unknownInvocationCount: 0,
      legacyTokens: 0,
    };
    const h = harness({ usage });
    h.enqueue();
    const running = h.transition("running");
    await h.run();
    const first = h.mutations.mock.calls[0]![0];
    const firstPublishedAt = h.clock.value;
    usage.invocationCount = 1;
    usage.activeInvocationCount = 1;
    usage.unknownInvocationCount = 1;
    h.clock.value += 1;
    h.publisher.updateUsage(running);
    await h.run();
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.publisher.taskSummary(h.actor, running.id)?.nextAttemptAt).toBe(
      new Date(firstPublishedAt + 30_000).toISOString(),
    );
    h.clock.value += 20_000;
    usage.reportedTokens = 100;
    usage.usage.totalTokens = 100;
    usage.completeness = "partial";
    h.publisher.updateUsage(running);
    await h.run();
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.publisher.taskSummary(h.actor, running.id)?.nextAttemptAt).toBe(
      new Date(firstPublishedAt + 30_000).toISOString(),
    );
    expect(h.store.get("checkpoints", running.id)).toBeUndefined();
    await h.publisher.stop();
    const recovered = h.createPublisher();
    await h.run(recovered);
    expect(h.mutations).toHaveBeenCalledTimes(1);
    h.clock.value = firstPublishedAt + 30_000;
    await h.run(recovered);
    expect(h.mutations).toHaveBeenCalledTimes(2);
    const partial = h.mutations.mock.calls.at(-1)![0];
    expect(partial).toMatchObject({
      marker: first.marker,
      externalId: "9001",
      previousBody: first.body,
    });
    expect(partial.body).toContain("100 tokens (partial usage)");
    expect(partial.body).toContain("1 model call(s) are still running");
    h.clock.value += 1;
    usage.reportedTokens = 150;
    usage.usage.totalTokens = 150;
    usage.activeInvocationCount = 0;
    usage.unknownInvocationCount = 0;
    usage.completeness = "complete";
    recovered.updateUsage(running);
    const completed = h.transition("completed");
    const sealedBytes = JSON.stringify(h.store.get("reports", h.fixture.result.report.id));
    await h.run(recovered);
    expect(h.mutations).toHaveBeenCalledTimes(3);
    const final = h.mutations.mock.calls.at(-1)![0];
    expect(final.body).toContain("Static review completed");
    expect(final.body).toContain("150 tokens.");
    expect(final.body).not.toContain("model call(s) are still running");
    // A late callback cannot restore the earlier task state or attempt attribution.
    usage.reportedTokens = 175;
    usage.usage.totalTokens = 175;
    recovered.updateUsage(running);
    expect(recovered.taskSummary(h.actor, running.id)?.state).toBe("synced");
    recovered.updateUsage(completed);
    h.clock.value += 30_000;
    await h.run(recovered);
    const late = h.mutations.mock.calls.at(-1)![0];
    expect(late).toMatchObject({
      marker: first.marker,
      externalId: "9001",
      previousBody: final.body,
    });
    expect(late.body).toContain("Static review completed");
    expect(late.body).toContain("175 tokens.");
    expect(JSON.stringify(h.store.get("reports", h.fixture.result.report.id))).toBe(sealedBytes);
  });

  it("recovers a committed usage notification after a missed callback", async () => {
    const usage: InvestigationUsageSummary = {
      usage: unavailableInvestigationTokenUsage(),
      reportedTokens: 0,
      completeness: "unavailable",
      invocationCount: 0,
      activeInvocationCount: 0,
      unknownInvocationCount: 0,
      legacyTokens: 0,
    };
    const h = harness({ usage });
    h.enqueue();
    const running = h.transition("running");
    await h.run();
    await h.publisher.stop();
    usage.invocationCount = 1;
    usage.activeInvocationCount = 1;
    usage.unknownInvocationCount = 1;
    const id = investigationUsagePublicationPendingKey(running.id);
    h.store.put("idempotency", id, { id, taskId: running.id });
    h.clock.value += 30_000;
    const recovered = h.createPublisher();
    await h.run(recovered);
    expect(h.store.has("idempotency", id)).toBe(false);
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.mutations.mock.calls.at(-1)![0].body).toContain("1 model call(s) are still running");
    await h.run(recovered);
    expect(h.mutations).toHaveBeenCalledTimes(2);
  });

  it("uses the usage interval when a newer receipt arrives during comment dispatch", async () => {
    const usage: InvestigationUsageSummary = {
      usage: unavailableInvestigationTokenUsage(),
      reportedTokens: 0,
      completeness: "unavailable",
      invocationCount: 0,
      activeInvocationCount: 0,
      unknownInvocationCount: 0,
      legacyTokens: 0,
    };
    const h = harness({ usage });
    const dispatch = deferred();
    const release = deferred();
    h.control.afterDispatch = async () => {
      dispatch.resolve();
      await release.promise;
    };
    h.enqueue();
    const running = h.transition("running");
    const sending = h.run();
    await dispatch.promise;
    usage.invocationCount = 1;
    usage.activeInvocationCount = 1;
    usage.unknownInvocationCount = 1;
    h.publisher.updateUsage(running);
    release.resolve();
    await sending;
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.publisher.taskSummary(h.actor, running.id)?.nextAttemptAt).toBe(
      new Date(h.clock.value + 30_000).toISOString(),
    );
    h.clock.value += 30_000;
    await h.run();
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.mutations.mock.calls.at(-1)![0].body).toContain("1 model call(s) are still running");
  });

  it("owns distinct static and E2E comments on the same PR and publishes media only to E2E", async () => {
    const media = "## E2E evidence\n\nhttps://github.com/user-attachments/assets/synthetic-video";
    const prepareReportMedia = vi.fn(async () => media);
    const h = harness({ prepareReportMedia });
    const ids = new Map<string, string>();
    h.publishProgressComment.mockImplementation(
      async (request, _repository, _item, _actor, beforeDispatch) => {
        beforeDispatch?.();
        h.mutations(structuredClone(request));
        const externalId = ids.get(request.marker) ?? String(9001 + ids.size);
        ids.set(request.marker, externalId);
        return { state: "succeeded", message: "Synthetic comment accepted.", externalId };
      },
    );
    h.enqueue();
    const e2e: InvestigationTaskV1 = {
      ...structuredClone(h.task),
      id: `${h.task.id}-e2e`,
      kind: "pr-e2e",
    };
    const command: InvestigationProgressTrigger = {
      ...h.trigger,
      eventName: "issue_comment",
      commandCommentId: 77,
    };
    h.store.insert("tasks", e2e.id, e2e);
    h.enqueue(e2e, command);
    await h.run();
    const initial = h.mutations.mock.calls.map(([request]) => request);
    expect(initial).toHaveLength(2);
    const staticComment = initial.find((request) => request.marker.includes(`${h.task.id} -->`))!;
    const e2eComment = initial.find((request) => request.marker.includes(`${e2e.id} -->`))!;
    expect(e2eComment.body).toContain("E2E verification queued");
    expect(e2eComment.body).toContain("pull request comment 77");
    expect(e2eComment.expectedAssigneeUserId).toBeUndefined();
    expect(staticComment.expectedAssigneeUserId).toBe(h.trigger.assigneeUserId);
    expect(h.publisher.isOwnComment(h.task.repository.id, 9001)).toBe(true);
    expect(h.publisher.isOwnComment(h.task.repository.id, 9002)).toBe(true);
    expect(h.publisher.isOwnComment("another-repository", 9001)).toBe(false);
    expect(h.publisher.isOwnComment(h.task.repository.id, 77)).toBe(false);
    const report = structuredClone(h.fixture.result);
    report.context.task.id = e2e.id;
    report.context.task.kind = "pr-e2e";
    const completed: InvestigationTaskV1 = {
      ...e2e,
      state: "completed",
      updatedAt: new Date(h.clock.value + 1).toISOString(),
      latestReportRef: {
        id: report.report.id,
        version: report.report.version,
        digest: report.report.logicalContentDigest,
      },
    };
    h.store.put("tasks", e2e.id, completed);
    h.store.put("reports", report.report.id, report);
    h.publisher.update(completed, report);
    await h.run();
    const final = h.mutations.mock.calls.at(-1)![0];
    expect(prepareReportMedia).toHaveBeenCalledExactlyOnceWith(report, completed);
    expect(final).toMatchObject({
      marker: e2eComment.marker,
      externalId: ids.get(e2eComment.marker),
      previousBody: e2eComment.body,
    });
    expect(final.body).toContain(media);
    expect(final.body).toContain("## E2E result");
    expect(
      h.mutations.mock.calls.filter(([request]) => request.marker === staticComment.marker),
    ).toHaveLength(1);
    const summary = h.publisher.taskSummary(h.actor, e2e.id)!;
    expect(summary.availableActions).toContain("sync");
    h.publisher.sync(h.actor, summary.id, {
      version: summary.version,
      idempotencyKey: "retry-e2e-media",
    });
    await h.run();
    expect(prepareReportMedia).toHaveBeenCalledTimes(2);
    expect(h.mutations.mock.calls.at(-1)![0]).toMatchObject({
      externalId: final.externalId,
      previousBody: final.body,
    });
    expect(h.store.get<InvestigationTaskV1>("tasks", e2e.id)?.state).toBe("completed");
  });

  it.each(["interrupted", "cancelled", "failed", "blocked"] as const)(
    "publishes recorded E2E results through the real %s progress path",
    async (state) => {
      const media = "## E2E evidence\n\nhttps://github.com/user-attachments/assets/synthetic-video";
      const prepareReportMedia = vi.fn(async () => media);
      const h = harness({ prepareReportMedia });
      h.task.kind = "pr-e2e";
      h.store.put("tasks", h.task.id, h.task);
      h.enqueue(h.task, { ...h.trigger, eventName: "issue_comment", commandCommentId: 77 });
      await h.run();
      const queued = h.mutations.mock.calls[0]![0];
      const report = createInvestigationPreview("pr", { findingCount: 0, outcome: state }).result;
      report.context.task.kind = "pr-e2e";
      report.report.loop.completedRounds = state === "blocked" ? 1 : 0;
      report.report.loop.stopReason =
        state === "interrupted" ? "budget_exhausted" : state === "failed" ? "error" : state;
      report.report.summary = "Investigation has not started.";
      report.diagnostics[0]!.message = "secret=private-diagnostic C:\\private\\worker.log";
      report.verificationEvidence = [
        {
          id: "e2e-observation",
          subjectRef: h.task.subjectRef,
          authority: "worker",
          source: "executor_observation",
          summary: "The owned application window opened.",
          evidenceRefs: [],
          artifactRefs: [],
          provenance: {
            taskId: h.task.id,
            attemptId: report.context.attempt.id,
            producer: "e2e-tool-server",
            recordedAt: h.now().toISOString(),
          },
        },
      ];
      report.artifacts = [];
      if (state !== "cancelled") {
        report.context.e2e = {
          headSha: "b".repeat(40),
          buildIdentity: "Synthetic pinned build",
          cleanup: {
            confirmed: true,
            recordedAt: h.now().toISOString(),
            summary: "Owned processes exited.",
          },
          features: [
            {
              id: "preview-feature",
              title: "Preview lifecycle",
              paths: ["src/Preview.cs"],
              scenario: "Open and close the preview.",
              userVisible: true,
              outcome: "failed",
              artifactRefs: [],
              limitations: ["Cleanup timing was not verified."],
              assertions: (
                ["passed", "passed", "failed", "failed", "failed", "failed", "blocked"] as const
              ).map((outcome, index) => ({
                id: `preview-assertion-${index}`,
                expected: "The expected preview state.",
                observed: "The recorded preview state.",
                outcome,
                evidenceRefs: ["e2e-observation"],
              })),
            },
          ],
        };
      }
      const before = structuredClone(report);
      const stopped = h.transition(state, report);
      await h.run();
      const publication = h.mutations.mock.calls.at(-1)![0];
      expect(h.receipt()).toMatchObject({
        stage: "failed",
        state: "sent",
        reportId: report.id,
        externalId: "9001",
      });
      expect(publication).toMatchObject({
        marker: queued.marker,
        previousBody: queued.body,
        externalId: "9001",
      });
      expect(publication.body).toContain(`Task ${state}; partial E2E report`);
      expect(publication.body).toContain(media);
      expect(prepareReportMedia).toHaveBeenCalledExactlyOnceWith(report, stopped);
      if (state === "cancelled") {
        expect(publication.body).toContain("Recorded 1 Worker observations and 0 artifacts");
        expect(publication.body).toContain("Final E2E feature results are unavailable");
      } else {
        expect(publication.body).toContain(
          "Recorded features: 0 passed, 1 failed, 0 blocked, 0 not run",
        );
        expect(publication.body).toContain("Preview lifecycle");
        expect(publication.body).toContain("Assertions: 2 passed, 4 failed, 1 blocked, 0 not run");
        expect(publication.body).toContain("Cleanup timing was not verified");
      }
      if (state === "blocked")
        expect(publication.body).not.toContain("Final analysis was not adopted");
      else expect(publication.body).toContain("Final analysis was not adopted");
      if (state === "interrupted") expect(publication.body).toContain("exhausted its budget");
      expect(publication.body).not.toContain("Investigation has not started");
      expect(publication.body).not.toContain("E2E runtime verification: Passed");
      expect(publication.body).not.toContain("private-diagnostic");
      expect(publication.body).not.toContain("worker.log");
      expect(h.mutations).toHaveBeenCalledTimes(2);
      expect(report).toEqual(before);
    },
  );

  it("keeps reported usage on cancelled task comments without inventing provider counts", async () => {
    const h = harness({
      usage: {
        usage: {
          inputTokens: null,
          cachedReadTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
          providerCounters: {},
        },
        reportedTokens: 321,
        completeness: "partial",
        invocationCount: 1,
        activeInvocationCount: 0,
        unknownInvocationCount: 1,
        legacyTokens: 321,
      },
    });
    h.enqueue();
    h.transition("cancelled");
    await h.run();
    const body = h.mutations.mock.calls.at(-1)![0].body;
    expect(body).toContain("Static review cancelled");
    expect(body).toContain("321 tokens (partial usage)");
    expect(body).toContain("Cached read: Unavailable");
    expect(body).not.toContain("Cached read: 0");
  });

  it.each(["pr", "bug"] as const)(
    "creates one %s comment and updates it with the complete report",
    async (kind) => {
      const h = harness({ kind });
      h.enqueue();
      await h.run();
      expect(h.receipt()).toMatchObject({
        stage: "received",
        state: "sent",
        reportId: null,
        externalId: "9001",
      });
      expect(h.mutations.mock.calls[0]![0].body).toContain("synthetic-assigner");
      expect(h.mutations.mock.calls[0]![0].body).toContain("synthetic-worker");
      h.transition("running");
      await h.run();
      expect(h.receipt()).toMatchObject({ stage: "started", state: "sent", externalId: "9001" });
      h.transition("completed");
      await h.run();
      const requests = h.mutations.mock.calls.map(([request]) => request);
      expect(requests).toHaveLength(3);
      expect(requests.filter((request) => request.externalId === null)).toHaveLength(1);
      expect(requests[1]).toMatchObject({ externalId: "9001", previousBody: requests[0]!.body });
      expect(requests[2]).toMatchObject({ externalId: "9001", previousBody: requests[1]!.body });
      const template =
        kind === "pr"
          ? defaultAutomaticReplyTemplates.pullRequest
          : defaultAutomaticReplyTemplates.issue;
      expect(requests[2]!.body).toContain(
        renderAutomaticReplyParts(h.fixture.result, template, h.control.identity).content,
      );
      expect(h.receipt()).toMatchObject({
        stage: "completed",
        state: "sent",
        reportId: h.fixture.result.report.id,
      });
      for (const request of requests) {
        expect(request.body.startsWith("I'm ")).toBe(true);
        expect(request.body.split("on behalf of GitHub user")).toHaveLength(2);
        expect(request.marker).toBe(`<!-- agentic-review-progress:${h.task.id} -->`);
        expect(request.body.split(request.marker)).toHaveLength(2);
      }
      expect(h.store.list("actionIntents")).toEqual([]);
    },
  );

  it("creates the latest true status when the first delivery is delayed until completion", async () => {
    const h = harness();
    h.enqueue();
    h.transition("running");
    h.transition("completed");
    await h.run();
    expect(h.mutations.mock.calls.map(([request]) => request.externalId)).toEqual([null]);
    expect(h.mutations.mock.calls[0]![0].body).toContain("Static review completed");
    expect(h.mutations.mock.calls[0]![0].body).toContain(h.task.createdAt);
    expect(h.receipt()).toMatchObject({ stage: "completed", state: "sent" });
  });

  it("merges a completion committed while the initial comment is in flight", async () => {
    const h = harness();
    h.enqueue();
    h.control.afterDispatch = async (request) => {
      if (request.externalId === null) {
        h.transition("running");
        h.transition("completed");
      }
    };
    await h.run();
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.receipt()).toMatchObject({ stage: "completed", state: "sent" });
  });

  it("discards a superseded unsent PATCH even when the transport swallows the guard exception", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    h.transition("running");
    h.control.beforeDispatch = (request) => {
      if (request.body.includes("Static review running")) h.transition("completed");
    };
    await h.run();
    expect(h.publishProgressComment).toHaveBeenCalledTimes(3);
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.mutations.mock.calls[1]![0].body).toContain("Static review completed");
    expect(h.receipt()).toMatchObject({ stage: "completed", state: "sent" });
    const cancelled = h.store
      .list<InvestigationCommentDelivery>("commentDeliveries")
      .filter((attempt) => attempt.state === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ operation: "update", effect: "not_sent" });
    expect(cancelled[0]!.body).toContain("Static review running");
  });

  it("does not overwrite a completion committed during a slow running PATCH", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    h.transition("running");
    h.control.afterDispatch = (request) => {
      if (request.body.includes("Static review running")) h.transition("completed");
    };
    await h.run();
    expect(h.mutations).toHaveBeenCalledTimes(3);
    expect(h.receipt()).toMatchObject({ stage: "completed", state: "sent" });
    expect(h.mutations.mock.calls[2]![0].previousBody).toBe(h.mutations.mock.calls[1]![0].body);
  });

  it.each([
    ["blocked", "waiting for required information"],
    ["failed", "failed before a complete conclusion"],
    ["interrupted", "interrupted before completion"],
    ["cancelled", "cancelled before completion"],
  ] as const)("publishes a safe %s outcome and resumes the same comment", async (state, text) => {
    const h = harness();
    h.enqueue();
    await h.run();
    h.transition("running");
    await h.run();
    h.transition(state);
    await h.run();
    expect(h.receipt()).toMatchObject({ stage: "failed", state: "sent", externalId: "9001" });
    expect(h.receipt().body).toContain(text);
    h.transition("queued");
    await h.run();
    expect(h.receipt()).toMatchObject({ stage: "received", state: "sent", externalId: "9001" });
    h.transition("running");
    await h.run();
    expect(h.receipt()).toMatchObject({ stage: "started", state: "sent" });
    expect(h.mutations.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      1,
    );
  });

  it("binds a failed report without copying diagnostics or private failure output", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    const failure = createInvestigationPreview("pr", { outcome: "failed", findingCount: 0 }).result;
    failure.diagnostics[0]!.message =
      "Synthetic private diagnostic: secret=do-not-publish C:\\private\\worker.log";
    h.transition("failed", failure);
    await h.run();
    expect(h.receipt()).toMatchObject({
      stage: "failed",
      reportId: failure.report.id,
      state: "sent",
    });
    expect(h.receipt().body).not.toContain("do-not-publish");
    expect(h.receipt().body).not.toContain("worker.log");
  });

  it("reconciles an ambiguous initial POST after restart without creating a second comment", async () => {
    const h = harness();
    h.enqueue();
    h.control.afterDispatch = () => {
      throw new Error("Synthetic private transport failure.");
    };
    await h.run();
    expect(h.receipt()).toMatchObject({ stage: "received", state: "unknown" });
    const frozen = h.mutations.mock.calls[0]![0];
    await h.publisher.stop();
    delete h.control.afterDispatch;
    h.control.reconcile = {
      state: "succeeded",
      message: "Synthetic exact readback.",
      externalId: "9001",
    };
    h.transition("running");
    h.clock.value += 60_000;
    const restarted = h.createPublisher();
    await h.run(restarted);
    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(1);
    expect(h.reconcileProgressComment.mock.calls[0]![0]).toEqual(frozen);
    expect(h.mutations.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      1,
    );
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.receipt(restarted)).toMatchObject({
      stage: "started",
      state: "sent",
      externalId: "9001",
    });
  });

  it("never retries an ambiguous PATCH or lets a queued conclusion overtake it", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    h.transition("running");
    h.control.afterDispatch = () => {
      throw new Error("Synthetic response lost.");
    };
    await h.run();
    h.transition("completed");
    await h.publisher.stop();
    delete h.control.afterDispatch;
    const frozen = h.mutations.mock.calls[1]![0];
    const restarted = h.createPublisher();
    h.clock.value += 60_000;
    await h.run(restarted);
    h.clock.value += 120_000;
    await h.run(restarted);
    h.clock.value += 240_000;
    await h.run(restarted);
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(3);
    for (const [request] of h.reconcileProgressComment.mock.calls) expect(request).toEqual(frozen);
    expect(h.receipt(restarted)).toMatchObject({ stage: "started", state: "unknown" });
  });

  it("allows read-only recovery after authorization is revoked and blocks the next PATCH", async () => {
    const h = harness();
    h.enqueue();
    h.control.afterDispatch = () => {
      throw new Error("Synthetic response lost.");
    };
    await h.run();
    await h.publisher.stop();
    h.transition("completed");
    h.updateSettings(false);
    h.control.reconcile = {
      state: "succeeded",
      message: "Synthetic exact readback.",
      externalId: "9001",
    };
    const restarted = h.createPublisher();
    h.clock.value += 60_000;
    await h.run(restarted);
    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(1);
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.receipt(restarted)).toMatchObject({ state: "blocked", externalId: "9001" });
  });

  it("fences an expired publisher while another instance safely claims the pending POST", async () => {
    const h = harness();
    h.enqueue();
    const entered = deferred();
    const release = deferred();
    h.control.beforeIdentity = async () => {
      delete h.control.beforeIdentity;
      entered.resolve();
      await release.promise;
    };
    const first = h.run();
    await entered.promise;
    h.clock.value += 60_001;
    const successor = h.createPublisher();
    await h.run(successor);
    release.resolve();
    await first;
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.receipt(successor)).toMatchObject({ stage: "received", state: "sent" });
  });

  it("does not let an expired in-flight writer overwrite a newer owner's completed state", async () => {
    const h = harness();
    h.enqueue();
    const entered = deferred();
    const release = deferred();
    h.control.afterDispatch = async () => {
      delete h.control.afterDispatch;
      entered.resolve();
      await release.promise;
    };
    const first = h.run();
    await entered.promise;
    h.transition("completed");
    h.clock.value += 60_001;
    h.control.reconcile = {
      state: "succeeded",
      message: "Synthetic exact readback.",
      externalId: "9001",
    };
    const successor = h.createPublisher();
    await h.run(successor);
    release.resolve();
    await first;
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.reconcileProgressComment).toHaveBeenCalledTimes(1);
    expect(h.receipt(successor)).toMatchObject({ stage: "completed", state: "sent" });
  });

  it.each(["policy", "operator", "repository", "work-item"] as const)(
    "rechecks %s immediately before mutation",
    async (revocation) => {
      const h = harness();
      h.enqueue();
      h.control.beforeDispatch = () => {
        if (revocation === "policy") h.updateSettings(false);
        if (revocation === "operator") h.control.operator = { ...h.actor, actionCapabilities: [] };
        if (revocation === "repository")
          h.store.put("repositories", h.task.repository.id, {
            ...h.task.repository,
            fullName: "other/repository",
          });
        if (revocation === "work-item") {
          const item = h.store.get<InvestigationWorkItemRecord>("workItems", h.task.workItem.id)!;
          h.store.put("workItems", item.id, { ...item, number: item.number + 1 });
        }
      };
      await h.run();
      expect(h.mutations).not.toHaveBeenCalled();
      expect(h.receipt()).toMatchObject({ state: "blocked" });
    },
  );

  it("retains the original publisher identity and blocks an identity change before updating", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    h.transition("running");
    h.control.identity = { githubUserId: 34, githubLogin: "other-publisher" };
    await h.run();
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.receipt()).toMatchObject({ state: "blocked" });
  });

  it("requires the external-write gate", async () => {
    const h = harness({ externalWrites: false });
    h.enqueue();
    await h.run();
    expect(h.mutations).not.toHaveBeenCalled();
    expect(h.readPublisherIdentity).not.toHaveBeenCalled();
    expect(h.receipt()).toMatchObject({ state: "blocked" });
  });

  it.each([{ progressEnabled: false }, { legacySettings: true }])(
    "does not enroll tasks when progress is not enabled: %j",
    async (options) => {
      const h = harness(options);
      h.enqueue();
      h.transition("completed");
      await h.run();
      expect(h.publisher.hasTask(h.task.id)).toBe(false);
      expect(h.publisher.list(h.actor, h.task.repository.id).items).toEqual([]);
      expect(h.mutations).not.toHaveBeenCalled();
    },
  );

  it("does not backfill committed tasks when progress is enabled later", async () => {
    const h = harness({ progressEnabled: false });
    h.enqueue();
    h.clock.value += 1;
    h.updateSettings(true, true);
    h.enqueue();
    h.transition("completed");
    await h.run();
    expect(h.publisher.hasTask(h.task.id)).toBe(false);
    expect(h.mutations).not.toHaveBeenCalled();
  });

  it("makes repeated enqueue idempotent across renamed GitHub logins", async () => {
    const h = harness();
    h.enqueue();
    h.enqueue(h.task, {
      ...h.trigger,
      actorLogin: "renamed-assigner",
      assigneeLogin: "renamed-worker",
    });
    await h.run();
    const completed = h.transition("completed");
    h.enqueue(completed);
    await h.run();
    expect(h.publisher.list(h.actor, h.task.repository.id).items).toHaveLength(1);
    expect(h.mutations.mock.calls.filter(([request]) => request.externalId === null)).toHaveLength(
      1,
    );
    expect(h.mutations.mock.calls[0]![0].body).toContain("synthetic-assigner");
    expect(h.mutations.mock.calls[0]![0].body).not.toContain("renamed-assigner");
  });

  it("ignores stale running callbacks after completion", async () => {
    const h = harness();
    h.enqueue();
    const running = h.transition("running");
    h.transition("completed");
    h.store.transaction(() => h.publisher.update(running));
    await h.run();
    expect(h.receipt()).toMatchObject({ stage: "completed", state: "sent" });
  });

  it("rejects a mismatched sealed report without posting it", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    const report = structuredClone(h.fixture.result);
    report.context.workItem.number += 1;
    h.transition("completed", report);
    await h.run();
    expect(h.receipt()).toMatchObject({ state: "failed" });
    expect(h.mutations).toHaveBeenCalledTimes(1);
  });

  it("blocks a modified source report during preflight without truncating the published result", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    h.transition("completed");
    h.control.beforeDispatch = () => {
      const report = structuredClone(h.fixture.result);
      report.context.workItem.title = "Synthetic changed report";
      h.store.put("reports", report.report.id, report);
    };
    await h.run();
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.receipt()).toMatchObject({ state: "failed" });
  });

  it("preserves transaction rollback and never publishes a rolled-back enrollment", async () => {
    const h = harness();
    expect(() =>
      h.store.transaction(() => {
        h.publisher.enqueue(h.task, h.trigger);
        throw new Error("Synthetic Task transaction rollback.");
      }),
    ).toThrow("rollback");
    await h.run();
    expect(h.publisher.hasTask(h.task.id)).toBe(false);
    expect(h.mutations).not.toHaveBeenCalled();
  });

  it("stops before dispatch and resumes the same frozen operation after shutdown", async () => {
    const h = harness();
    h.enqueue();
    let stopped: Promise<void> | undefined;
    h.control.beforeDispatch = () => {
      stopped = h.publisher.stop();
    };
    await h.run();
    await stopped;
    expect(h.mutations).not.toHaveBeenCalled();
    expect(h.receipt()).toMatchObject({ state: "pending" });
    const frozen = h.publishProgressComment.mock.calls[0]![0];
    delete h.control.beforeDispatch;
    const restarted = h.createPublisher();
    await h.run(restarted);
    expect(h.mutations).toHaveBeenCalledTimes(1);
    expect(h.mutations.mock.calls[0]![0]).toEqual(frozen);
    expect(h.receipt(restarted)).toMatchObject({ stage: "received", state: "sent" });
  });

  it("publishes an explicit safe summary when the complete comment exceeds 60000 bytes", async () => {
    const h = harness();
    const previous = h.settings.read(h.actor, h.task.repository.id);
    h.settings.update(h.actor, h.task.repository.id, {
      version: previous.version,
      enabled: true,
      pullRequestTemplate: previous.pullRequestTemplate,
      issueTemplate: previous.issueTemplate,
      progressEnabled: true,
      progressTemplates: {
        ...previous.progressTemplates,
        completed: `${"x".repeat(11_000)}\n${previous.progressTemplates.completed}`,
      },
    });
    h.enqueue();
    await h.run();
    const report = structuredClone(h.fixture.result);
    report.report.summary = "x";
    const base = renderAutomaticReply(
      report,
      defaultAutomaticReplyTemplates.pullRequest,
      h.control.identity,
    );
    report.report.summary = "x".repeat(51_000 - Buffer.byteLength(base, "utf8"));
    const fullReport = renderAutomaticReply(
      report,
      defaultAutomaticReplyTemplates.pullRequest,
      h.control.identity,
    );
    expect(Buffer.byteLength(fullReport, "utf8")).toBeGreaterThan(50_000);
    expect(Buffer.byteLength(fullReport, "utf8")).toBeLessThan(59_000);
    h.transition("completed", report);
    await h.run();
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.receipt()).toMatchObject({ stage: "completed", state: "sent" });
    expect(h.receipt().reason).toContain("full report remains in the Dashboard");
    expect(Buffer.byteLength(h.receipt().body!, "utf8")).toBeLessThanOrEqual(60_000);
    expect(h.receipt().body).toContain("not embedded");
    expect(h.store.get<InvestigationResultV1>("reports", report.report.id)?.report.summary).toBe(
      report.report.summary,
    );
  });

  it("exposes only public receipt fields within the actor's repository scope", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    expect(Object.keys(h.receipt()).sort()).toEqual(
      [
        "body",
        "createdAt",
        "externalId",
        "id",
        "reason",
        "reportId",
        "settingsVersion",
        "stage",
        "state",
        "taskId",
        "templateVersion",
        "updatedAt",
        "workItemId",
        "workItemKind",
        "workItemNumber",
      ].sort(),
    );
    expect(() => h.publisher.list({ ...h.actor, repositoryIds: [] }, h.task.repository.id)).toThrow(
      "cannot read",
    );
  });

  it("rejects a foreign legacy comment before migration can change any record or delivery history", () => {
    const h = harness();
    h.enqueue();
    const id = `progress-reply:task:${h.task.id}`;
    const current = h.store.get<CommentPublication>("idempotency", id)!;
    const transition = {
      sequence: 0,
      stage: "received",
      updatedAt: h.task.createdAt,
      failure: null,
      reportRef: null,
      reportDigest: null,
    };
    const legacy = {
      id,
      taskId: h.task.id,
      taskKind: h.task.kind,
      taskCreatedAt: h.task.createdAt,
      repository: h.task.repository,
      workItem: h.store.get("workItems", h.task.workItem.id),
      trigger: h.trigger,
      settingsVersion: current.desired.policy.settingsVersion,
      templateVersion: current.desired.policy.templateVersion,
      authorizedById: h.actor.id,
      templates: current.desired.policy.templates,
      resultTemplate: current.desired.policy.resultTemplate,
      received: transition,
      desired: transition,
      published: { transition, body: "Retained legacy comment.", externalId: "9001" },
      operation: null,
      githubIdentity: h.control.identity,
      state: "sent",
      reason: null,
      pendingId: current.pendingId,
      attempts: 1,
      nextAttemptAt: h.clock.value,
      claim: null,
      createdAt: h.task.createdAt,
      updatedAt: h.task.updatedAt,
    };
    h.store.put("idempotency", id, legacy);
    const before = structuredClone(h.store.list("idempotency"));
    const foreign = { ...h.actor, repositoryIds: [] };
    expect(() => h.publisher.getComment(foreign, id)).toThrow("cannot read");
    expect(() => h.publisher.revisions(foreign, id)).toThrow("cannot read");
    expect(() =>
      h.publisher.sync(foreign, id, { version: "a".repeat(64), idempotencyKey: "foreign-sync" }),
    ).toThrow("cannot read");
    expect(h.store.list("idempotency")).toEqual(before);
    expect(h.store.list("commentDeliveries")).toEqual([]);
  });

  it("imports a sent legacy snapshot into shared history at startup without publishing again", async () => {
    const h = harness();
    h.enqueue();
    const id = `progress-reply:task:${h.task.id}`;
    const current = h.store.get<CommentPublication>("idempotency", id)!;
    const transition = {
      sequence: 0,
      stage: "received",
      updatedAt: h.task.createdAt,
      failure: null,
      reportRef: null,
      reportDigest: null,
    };
    const body = `Exact retained legacy body.\n\n<!-- agentic-review-progress:${h.task.id} -->`;
    h.store.put("idempotency", id, {
      id,
      taskId: h.task.id,
      taskKind: h.task.kind,
      taskCreatedAt: h.task.createdAt,
      repository: h.task.repository,
      workItem: h.store.get("workItems", h.task.workItem.id),
      trigger: h.trigger,
      settingsVersion: current.desired.policy.settingsVersion,
      templateVersion: current.desired.policy.templateVersion,
      authorizedById: h.actor.id,
      templates: current.desired.policy.templates,
      resultTemplate: current.desired.policy.resultTemplate,
      received: transition,
      desired: transition,
      published: { transition, body, externalId: "9001" },
      operation: null,
      githubIdentity: h.control.identity,
      state: "sent",
      reason: null,
      pendingId: current.pendingId,
      attempts: 1,
      nextAttemptAt: h.clock.value,
      claim: null,
      createdAt: h.task.createdAt,
      updatedAt: h.task.updatedAt,
    });
    h.store.delete("idempotency", current.pendingId);
    const deliveries = new InvestigationCommentDeliveries({ store: h.store, now: h.now });
    expect(deliveries.list(h.actor).items).toEqual([]);
    h.publisher.start();
    const history = deliveries.list(h.actor).items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      commentId: id,
      body,
      externalId: "9001",
      legacy: true,
      attemptNumber: 0,
      state: "succeeded",
      finishedAt: null,
    });
    h.publisher.start();
    await h.publisher.drain();
    expect(deliveries.list(h.actor).items).toEqual(history);
    expect(h.publishProgressComment).not.toHaveBeenCalled();
    expect(h.reconcileProgressComment).not.toHaveBeenCalled();
    expect(h.store.has("idempotency", current.pendingId)).toBe(false);
  });
});
