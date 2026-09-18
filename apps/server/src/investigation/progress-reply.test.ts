import {
  createInvestigationPreview,
  type InvestigationResultV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
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
    expect(h.mutations.mock.calls[0]![0].body).toContain("Investigation completed");
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
      if (request.body.includes("Investigation running")) h.transition("completed");
    };
    await h.run();
    expect(h.publishProgressComment).toHaveBeenCalledTimes(3);
    expect(h.mutations).toHaveBeenCalledTimes(2);
    expect(h.mutations.mock.calls[1]![0].body).toContain("Investigation completed");
    expect(h.receipt()).toMatchObject({ stage: "completed", state: "sent" });
  });

  it("does not overwrite a completion committed during a slow running PATCH", async () => {
    const h = harness();
    h.enqueue();
    await h.run();
    h.transition("running");
    h.control.afterDispatch = (request) => {
      if (request.body.includes("Investigation running")) h.transition("completed");
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
