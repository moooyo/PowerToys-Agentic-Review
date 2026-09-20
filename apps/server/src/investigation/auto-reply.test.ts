import {
  type ActionContextV1,
  createInvestigationPreview,
  type InvestigationActionIntentV1,
  type InvestigationCommentDelivery,
  type InvestigationCreateActionIntentRequest,
  type InvestigationReportRef,
  type InvestigationResultV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationActions } from "./actions.js";
import { type AutomaticReplyReceipt, InvestigationAutomaticReplies } from "./auto-reply.js";
import { InvestigationAutomaticReplySettings } from "./auto-reply-settings.js";
import { defaultAutomaticReplyTemplates, renderAutomaticReply } from "./auto-reply-template.js";
import { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import { inspectLegacyConversationReplies } from "./legacy-conversation-replies.js";
import { InvestigationStore } from "./store.js";
import type {
  InvestigationActionTransport,
  InvestigationGitHubIdentity,
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

type Fixture = ReturnType<typeof createInvestigationPreview>;
type Delivery = Awaited<ReturnType<InvestigationActionTransport["execute"]>>;
interface SavedReply extends AutomaticReplyReceipt {
  repository: InvestigationRepositoryRecord;
  reportRef: InvestigationReportRef;
  template?: string;
  githubIdentity?: InvestigationGitHubIdentity;
  authorizationEpoch?: number;
  request: InvestigationCreateActionIntentRequest | null;
  pendingId: string;
  attempts: number;
  nextAttemptAt: number;
  claim?: { ownerId: string; expiresAt: number };
}

const stores: InvestigationStore[] = [];
const publishers: InvestigationAutomaticReplies[] = [];
afterEach(async () => {
  await Promise.all(publishers.splice(0).map((publisher) => publisher.stop()));
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function harness(
  options: {
    kind?: "pr" | "bug" | "feature";
    enabled?: boolean;
    externalWrites?: boolean;
    persistReport?: boolean;
    maximumAttempts?: number;
    publisherIdentity?: boolean;
    history?: boolean;
  } = {},
) {
  const fixture = createInvestigationPreview(options.kind ?? "pr", { findingCount: 0 });
  const store = new InvestigationStore();
  stores.push(store);
  const clock = { value: Date.parse("2026-09-16T10:00:00.000Z") };
  const now = () => new Date(clock.value);
  const targets = new Map<string, ActionContextV1["target"]>();

  function persist(source: Fixture, includeReport = true): void {
    const { task, result } = source;
    const subject = task.subjects[0]!;
    const workItem: InvestigationWorkItemRecord = {
      ...task.workItem,
      repositoryId: task.repository.id,
      body: "Synthetic source snapshot",
      state: "open",
      subject,
      updatedAt: task.updatedAt,
    };
    if (!store.has("repositories", task.repository.id))
      store.insert("repositories", task.repository.id, task.repository);
    store.insert("workItems", workItem.id, workItem);
    store.insert("tasks", task.id, task);
    if (includeReport) store.insert("reports", result.report.id, result);
    for (const plan of result.plans) store.insert("plans", `${result.report.id}:${plan.id}`, plan);
    targets.set(workItem.id, {
      kind: workItem.kind,
      state: "open",
      revisionKey: subject.revisionKey,
      headSha: subject.kind === "original_pr" ? subject.headSha : null,
    });
  }
  persist(fixture, options.persistReport ?? true);

  const actor: InvestigationOperatorPrincipal = {
    id: "synthetic-automatic-reply-authorizer",
    displayName: "Synthetic automatic reply authorizer",
    repositoryIds: [fixture.task.repository.id],
    permissions: ["repository:manage", "action:prepare", "action:execute"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
  };
  const control: {
    operator: InvestigationOperatorPrincipal | null;
    boundary?: (name: string) => void | Promise<void>;
    delivery: Delivery;
    reconciliation: Delivery;
    publisherIdentity: InvestigationGitHubIdentity;
  } = {
    operator: actor,
    publisherIdentity: { githubUserId: 42, githubLogin: "synthetic-publisher" },
    delivery: {
      state: "succeeded",
      message: "Synthetic comment accepted.",
      externalId: "synthetic-comment",
    },
    reconciliation: {
      state: "unknown",
      message: "No synthetic receipt was found.",
      externalId: null,
    },
  };
  const settings = new InvestigationAutomaticReplySettings(store, true, now);
  const deliveries = new InvestigationCommentDeliveries({ store, now });
  if (options.enabled ?? true) {
    settings.update(actor, fixture.task.repository.id, {
      version: 0,
      enabled: true,
      pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
      issueTemplate: defaultAutomaticReplyTemplates.issue,
    });
  }
  let targetReads = 0;
  let capabilityReads = 0;
  const posts = vi.fn<(intent: InvestigationActionIntentV1) => void>();
  const readPublisherIdentity = vi.fn(async () => {
    await control.boundary?.("publisher-identity");
    return structuredClone(control.publisherIdentity);
  });
  const readTarget = vi.fn<InvestigationActionTransport["readTarget"]>(
    async (_repository, item) => {
      await control.boundary?.(`read-target:${++targetReads}`);
      return structuredClone(targets.get(item.id)!);
    },
  );
  const readCapabilities = vi.fn<NonNullable<InvestigationActionTransport["readCapabilities"]>>(
    async () => {
      await control.boundary?.(`read-capabilities:${++capabilityReads}`);
      return ["comment"];
    },
  );
  const execute = vi.fn<InvestigationActionTransport["execute"]>(
    async (intent, _repository, item, _principal, beforeDispatch) => {
      await control.boundary?.("dispatch");
      const target = targets.get(item.id)!;
      if (
        target.state !== "open" ||
        target.revisionKey !== intent.expectedRevisionKey ||
        target.headSha !== intent.expectedHeadSha
      )
        return {
          state: "failed",
          message: "The synthetic target changed before dispatch.",
          externalId: null,
        };
      beforeDispatch?.();
      posts(structuredClone(intent));
      return structuredClone(control.delivery);
    },
  );
  const reconcile = vi.fn<InvestigationActionTransport["reconcile"]>(async () => {
    await control.boundary?.("reconcile");
    return structuredClone(control.reconciliation);
  });
  const transport: InvestigationActionTransport = {
    supportedActions: ["comment"],
    readPublisherIdentity,
    readTarget,
    readCapabilities,
    execute,
    reconcile,
  };
  let nextIntent = 0;
  const actions = new InvestigationActions({
    store,
    now,
    idFactory: () => `synthetic-auto-comment-${++nextIntent}`,
    transport,
    enableExternalWrites: options.externalWrites ?? true,
    createTask: () => {
      throw new Error("An automatic reply must never create another Task.");
    },
  });
  function createPublisher(
    history = options.history !== false,
    recoveryOnly = false,
  ): InvestigationAutomaticReplies {
    const publisher = new InvestigationAutomaticReplies({
      store,
      settings,
      actions,
      resolveOperator: (id) => (control.operator?.id === id ? control.operator : null),
      ...(options.publisherIdentity === false
        ? {}
        : { resolvePublisherIdentity: readPublisherIdentity }),
      enableExternalWrites: options.externalWrites ?? true,
      recoveryOnly,
      now,
      retryDelayMs: 60_000,
      maximumAttempts: options.maximumAttempts ?? 3,
      ...(history ? { deliveries } : {}),
    });
    publishers.push(publisher);
    return publisher;
  }
  const publisher = createPublisher();
  function enqueue(source = fixture, destination = publisher): void {
    store.transaction(() => destination.enqueue(source.result, source.task));
  }
  async function run(destination = publisher): Promise<void> {
    destination.start();
    await destination.drain();
  }
  function saved(reportId = fixture.result.report.id): SavedReply {
    return store.get<SavedReply>("idempotency", `auto-reply:report:${reportId}`)!;
  }
  async function freeze(): Promise<SavedReply> {
    const preparation = vi
      .spyOn(actions, "createIntent")
      .mockRejectedValueOnce(new Error("Synthetic interruption after the payload was frozen."));
    try {
      await run();
    } finally {
      preparation.mockRestore();
      await publisher.stop();
    }
    const frozen = saved();
    expect(frozen.body).not.toBeNull();
    expect(frozen.request).not.toBeNull();
    expect(frozen.githubIdentity).toEqual(control.publisherIdentity);
    expect(store.list("actionIntents")).toEqual([]);
    store.put("idempotency", frozen.id, {
      ...frozen,
      attempts: 0,
      nextAttemptAt: now().valueOf(),
      reason: null,
    });
    return saved();
  }
  function automaticActor(): InvestigationOperatorPrincipal {
    return {
      id: `automatic-reply:${investigationContentDigest(fixture.task.repository.id).slice(0, 32)}`,
      displayName: "Automatic investigation reply",
      repositoryIds: [fixture.task.repository.id],
      permissions: ["action:prepare", "action:execute"],
      actionCapabilities: ["comment"],
      allowRepositoryExecution: false,
    };
  }
  function updateSettings(enabled: boolean): void {
    const previous = settings.read(actor, fixture.task.repository.id);
    settings.update(actor, fixture.task.repository.id, {
      version: previous.version,
      enabled,
      pullRequestTemplate: previous.pullRequestTemplate,
      issueTemplate: previous.issueTemplate,
    });
  }
  return {
    ...fixture,
    fixture,
    store,
    clock,
    now,
    targets,
    actor,
    control,
    settings,
    deliveries,
    actions,
    transport,
    readTarget,
    readCapabilities,
    readPublisherIdentity,
    execute,
    reconcile,
    posts,
    publisher,
    persist,
    createPublisher,
    enqueue,
    run,
    saved,
    freeze,
    automaticActor,
    updateSettings,
  };
}

describe("automatic investigation reply publication", () => {
  it.each(["pr", "bug", "feature"] as const)(
    "publishes a completed %s report as one native comment without an operator confirmation",
    async (kind) => {
      const h = harness({ kind });
      const prepare = vi.spyOn(h.actions, "createIntent");
      const confirm = vi.spyOn(h.actions, "confirmIntent");
      h.enqueue();
      await h.run();

      expect(h.posts).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0]![0].githubIdentity).toEqual(h.control.publisherIdentity);
      expect(confirm.mock.calls[0]![0].githubIdentity).toEqual(h.control.publisherIdentity);
      const intent = h.store.list<InvestigationActionIntentV1>("actionIntents")[0]!;
      expect(intent).toMatchObject({
        action: "comment",
        state: "succeeded",
        repositoryId: h.task.repository.id,
        workItemId: h.task.workItem.id,
        actorId: h.automaticActor().id,
        reportRef: {
          id: h.result.report.id,
          version: 1,
          digest: h.result.report.logicalContentDigest,
        },
        payload: { kind: "feedback", findingIds: [], drafts: [] },
      });
      expect(intent.payload).toEqual(h.saved().request!.payload);
      expect(h.saved()).toMatchObject({
        state: "sent",
        intentId: intent.id,
        externalId: "synthetic-comment",
        reason: null,
      });
      expect(h.publisher.list(h.actor, h.task.repository.id).items).toHaveLength(1);
      expect(h.store.countPrefix("idempotency", "auto-reply:pending:")).toBe(0);
      expect(h.reconcile).not.toHaveBeenCalled();
    },
  );

  it("deduplicates repeated sealing and repeated dispatch of the same report", async () => {
    const h = harness();
    h.enqueue();
    h.enqueue();
    await h.run();
    h.enqueue();
    await h.publisher.drain();
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.store.list("actionIntents")).toHaveLength(1);
    expect(h.publisher.list(h.actor, h.task.repository.id).items).toHaveLength(1);
  });

  it("preserves a wake requested between an empty drain and its promise finalizer", async () => {
    const h = harness();
    const drain = vi.spyOn(h.publisher, "drain");
    h.publisher.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drain).toHaveBeenCalledTimes(1);

    // The empty drain has returned internally, but its finally callback is still queued.
    const emptyDrain = h.publisher.drain();
    h.enqueue();
    expect(h.saved().state).toBe("pending");
    await emptyDrain;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.saved().state).toBe("sent");
    expect(drain).toHaveBeenCalledTimes(3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it("rejects a conflicting report digest under the same report identity", () => {
    const h = harness();
    h.enqueue();
    const conflicting = structuredClone(h.fixture);
    conflicting.result.report.logicalContentDigest = "7".repeat(64);
    expect(() => h.enqueue(conflicting)).toThrow("already belongs to another automatic reply");
    expect(h.saved().reportRef.digest).toBe(h.result.report.logicalContentDigest);
    expect(h.saved().request).toBeNull();
  });

  it("allows only one of two concurrent dispatchers to send", async () => {
    const h = harness();
    const other = h.createPublisher();
    h.enqueue();
    h.publisher.start();
    other.start();
    await Promise.all([h.publisher.drain(), other.drain()]);
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.store.list("actionIntents")).toHaveLength(1);
    expect(h.saved().state).toBe("sent");
  });

  it("fences an expired lease owner after another dispatcher has completed the comment", async () => {
    const h = harness();
    const replacement = h.createPublisher();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.control.boundary = async (name) => {
      if (name === "read-target:1") {
        entered();
        await gate;
      }
    };
    h.enqueue();
    h.publisher.start();
    const firstDrain = h.publisher.drain();
    await waiting;
    h.clock.value += 60_001;
    try {
      await h.run(replacement);
    } finally {
      release();
    }
    await firstDrain;
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.store.list("actionIntents")).toHaveLength(1);
    expect(h.saved().state).toBe("sent");
  });

  it.each(["publisher-identity", "read-target:1", "dispatch"])(
    "finishes the active comment during graceful stop at %s and leaves the next report queued",
    async (boundary) => {
      const h = harness();
      const issue = createInvestigationPreview("bug", { findingCount: 0 });
      h.persist(issue);
      h.enqueue();
      h.clock.value += 1;
      h.enqueue(issue);

      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      h.control.boundary = async (name) => {
        if (name === boundary) {
          entered();
          await gate;
        }
      };
      const active = h.run();
      await waiting;
      let stopped = false;
      const stopping = h.publisher.stop().then(() => {
        stopped = true;
      });
      try {
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(h.posts).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await Promise.all([active, stopping]);

      expect(stopped).toBe(true);
      expect(h.posts).toHaveBeenCalledTimes(1);
      expect(h.saved().state).toBe("sent");
      expect(h.saved(issue.result.report.id)).toMatchObject({
        state: "pending",
        attempts: 0,
        intentId: null,
      });
      expect(h.store.list("actionIntents")).toHaveLength(1);

      delete h.control.boundary;
      await h.run(h.createPublisher());
      expect(h.posts).toHaveBeenCalledTimes(2);
      expect(h.saved().state).toBe("sent");
      expect(h.saved(issue.result.report.id).state).toBe("sent");
      expect(h.posts.mock.calls.map(([intent]) => intent.reportRef?.id)).toEqual([
        h.result.report.id,
        issue.result.report.id,
      ]);
    },
  );

  it("keeps separate report payloads and targets independent", async () => {
    const h = harness();
    const issue = createInvestigationPreview("bug", { findingCount: 0 });
    issue.result.report.summary = "A distinct synthetic issue investigation summary.";
    h.persist(issue);
    h.enqueue();
    h.enqueue(issue);
    await h.run();
    expect(h.posts).toHaveBeenCalledTimes(2);
    const intents = h.store.list<InvestigationActionIntentV1>("actionIntents");
    for (const source of [h.fixture, issue]) {
      const intent = intents.find((entry) => entry.reportRef?.id === source.result.report.id)!;
      expect(intent.workItemId).toBe(source.task.workItem.id);
      expect(intent.payload).toEqual(h.saved(source.result.report.id).request!.payload);
    }
    expect(intents[0]!.payload).not.toEqual(intents[1]!.payload);
  });

  it("defers identity lookup and body rendering until after the report transaction commits", async () => {
    const h = harness();
    h.enqueue();
    expect(h.saved()).toMatchObject({
      state: "pending",
      body: null,
      request: null,
      template: defaultAutomaticReplyTemplates.pullRequest,
    });
    expect(h.saved()).not.toHaveProperty("githubIdentity");
    expect(h.readPublisherIdentity).not.toHaveBeenCalled();
    expect(h.store.list("actionIntents")).toEqual([]);
    await h.run();
    expect(h.readPublisherIdentity).toHaveBeenCalledTimes(1);
    expect(h.saved().body).toBe(
      renderAutomaticReply(
        h.result,
        defaultAutomaticReplyTemplates.pullRequest,
        h.control.publisherIdentity,
      ),
    );
    expect(h.saved().githubIdentity).toEqual(h.control.publisherIdentity);
  });

  it("freezes the complete rendered body before dispatch and retains it when a template is changed", async () => {
    const h = harness();
    h.enqueue();
    const frozen = await h.freeze();
    expect(frozen.body).toBe(
      renderAutomaticReply(
        h.result,
        defaultAutomaticReplyTemplates.pullRequest,
        h.control.publisherIdentity,
      ),
    );
    const settings = h.settings.read(h.actor, h.task.repository.id);
    h.settings.update(h.actor, h.task.repository.id, {
      version: settings.version,
      enabled: true,
      pullRequestTemplate: settings.pullRequestTemplate.replace("## Summary", "## Custom summary"),
      issueTemplate: settings.issueTemplate,
    });
    await h.run();
    expect(h.saved()).toMatchObject({
      state: "sent",
      body: frozen.body,
      settingsVersion: frozen.settingsVersion,
    });
    expect(h.saved().request).toEqual(frozen.request);
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it("uses the frozen stored body and verified identity after a dispatcher restart", async () => {
    const h = harness();
    h.enqueue();
    const frozen = await h.freeze();
    h.result.report.summary =
      "An unrelated in-memory change must not regenerate the queued comment.";
    h.control.publisherIdentity = { githubUserId: 42, githubLogin: "renamed-publisher" };
    h.readPublisherIdentity.mockRejectedValue(
      new Error("Frozen identity must not be resolved again."),
    );
    await h.publisher.stop();
    const restarted = h.createPublisher();
    await h.run(restarted);
    expect(h.posts.mock.calls[0]![0].payload).toMatchObject({ body: frozen.body });
    expect(h.execute.mock.calls[0]![3].githubIdentity).toEqual(frozen.githubIdentity);
    expect(h.saved().body).toBe(frozen.body);
    expect(h.saved().githubIdentity).toEqual(frozen.githubIdentity);
    expect(h.readPublisherIdentity).toHaveBeenCalledTimes(1);
  });

  it("retains the captured publication grant across an ordinary settings save", async () => {
    const h = harness();
    h.enqueue();
    const epoch = h.saved().authorizationEpoch;
    h.updateSettings(true);
    await h.run();
    expect(h.saved()).toMatchObject({ state: "sent", authorizationEpoch: epoch });
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps a legacy record without an epoch conservative after settings changed=%s",
    async (changed) => {
      const h = harness();
      h.enqueue();
      const { authorizationEpoch: _epoch, ...legacy } = h.saved();
      h.store.put("idempotency", legacy.id, legacy);
      if (changed) h.updateSettings(true);
      await h.run();
      expect(h.saved().state).toBe(changed ? "blocked" : "sent");
      expect(h.saved()).not.toHaveProperty("authorizationEpoch");
      expect(h.posts).toHaveBeenCalledTimes(changed ? 0 : 1);
    },
  );
});

describe("retained automatic replies after conversation publication is enabled", () => {
  it("does not enroll reports or dispatch a retained pending reply in recovery-only mode", async () => {
    const h = harness();
    const recovery = h.createPublisher(true, true);
    h.enqueue(h.fixture, recovery);
    expect(h.store.countPrefix("idempotency", "auto-reply:report:")).toBe(0);
    h.enqueue();
    await h.run(recovery);
    expect(h.saved()).toMatchObject({ state: "blocked" });
    expect(h.posts).not.toHaveBeenCalled();
    expect(h.store.list("actionIntents")).toEqual([]);
  });

  it("reconciles a retained unknown native write without a second dispatch", async () => {
    const h = harness();
    h.control.delivery = { state: "unknown", externalId: null, message: "Receipt lost." };
    h.enqueue();
    await h.run();
    await h.publisher.stop();
    h.clock.value += 60_000;
    h.control.reconciliation = {
      state: "succeeded",
      externalId: "810",
      message: "The original receipt was found.",
    };
    await h.run(h.createPublisher(true, true));
    expect(h.saved()).toMatchObject({ state: "sent", externalId: "810" });
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it("exposes the exact confirmed owned comment for adoption without modifying its history", async () => {
    const h = harness();
    h.control.delivery = { state: "succeeded", externalId: "810", message: "Receipt saved." };
    h.enqueue();
    await h.run();
    const before = h.saved();
    const result = inspectLegacyConversationReplies({
      store: h.store,
      repository: h.task.repository,
      target: h.task.workItem,
      channel: "static",
    });
    const intent = h.store.list<InvestigationActionIntentV1>("actionIntents")[0]!;
    expect(result).toMatchObject({
      blocked: false,
      confirmed: {
        recordId: before.id,
        taskId: h.task.id,
        reportId: h.result.report.id,
        marker: `<!-- agentic-review-action:${intent.id}:${intent.payloadDigest} -->`,
        externalId: "810",
        githubIdentity: h.control.publisherIdentity,
      },
    });
    expect(result.confirmed?.body).toBe(
      h.deliveries.list(h.actor, { commentId: before.id }).items[0]!.body,
    );
    expect(h.saved()).toEqual(before);
    expect(
      inspectLegacyConversationReplies({
        store: h.store,
        repository: h.task.repository,
        target: h.task.workItem,
        channel: "e2e",
      }),
    ).toEqual({ confirmed: null, blocked: false });
  });

  it("blocks a new conversation create until every uncertain legacy write is resolved", async () => {
    const h = harness();
    h.control.delivery = { state: "unknown", externalId: null, message: "Receipt lost." };
    h.enqueue();
    await h.run();
    expect(
      inspectLegacyConversationReplies({
        store: h.store,
        repository: h.task.repository,
        target: h.task.workItem,
        channel: "static",
      }),
    ).toEqual({ confirmed: null, blocked: true });
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it("blocks adoption when a succeeded native receipt does not match its retained payload", async () => {
    const h = harness();
    h.control.delivery = { state: "succeeded", externalId: "810", message: "Receipt saved." };
    h.enqueue();
    await h.run();
    const saved = h.saved();
    h.store.put("idempotency", saved.id, {
      ...saved,
      request: { ...saved.request!, expectedRevisionKey: "f".repeat(64) },
    });
    expect(
      inspectLegacyConversationReplies({
        store: h.store,
        repository: h.task.repository,
        target: h.task.workItem,
        channel: "static",
      }),
    ).toEqual({ confirmed: null, blocked: true });
  });
});

describe("automatic reply durable recovery", () => {
  it("recovers a prepared native intent that was not yet recorded in the outbox", async () => {
    const h = harness();
    h.enqueue();
    await h.freeze();
    const intent = await h.actions.createIntent(h.automaticActor(), h.saved().request!);
    expect(h.saved().intentId).toBeNull();
    await h.publisher.stop();
    await h.run(h.createPublisher());
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.saved()).toMatchObject({ state: "sent", intentId: intent.id });
    expect(h.store.list("actionIntents")).toHaveLength(1);
  });

  it("recovers a succeeded native intent without sending again after an outbox update was lost", async () => {
    const h = harness();
    h.enqueue();
    await h.freeze();
    const actor = h.automaticActor();
    const intent = await h.actions.createIntent(actor, h.saved().request!);
    await h.actions.confirmIntent(actor, intent.id, {
      version: intent.version,
      payloadDigest: intent.payloadDigest,
    });
    expect(h.saved()).toMatchObject({ state: "pending", intentId: null });
    h.updateSettings(false);
    h.control.operator = null;
    await h.run(h.createPublisher());
    expect(h.saved()).toMatchObject({
      state: "sent",
      intentId: intent.id,
      externalId: "synthetic-comment",
    });
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it.each(["executing", "unknown"] as const)(
    "recovers a %s native intent only through receipt reconciliation, even after publication is revoked",
    async (state) => {
      const h = harness();
      h.enqueue();
      await h.freeze();
      const intent = await h.actions.createIntent(h.automaticActor(), h.saved().request!);
      h.store.put("actionIntents", intent.id, {
        ...intent,
        version: intent.version + 1,
        state,
        confirmedAt: h.now().toISOString(),
      });
      h.updateSettings(false);
      h.control.operator = null;
      h.readPublisherIdentity.mockRejectedValue(
        new Error("Receipt recovery must not resolve a new identity."),
      );
      h.control.reconciliation = {
        state: "succeeded",
        message: "The synthetic receipt matches.",
        externalId: "reconciled-comment",
      };
      await h.run(h.createPublisher());
      expect(h.reconcile).toHaveBeenCalledTimes(1);
      expect(h.reconcile.mock.calls[0]![3]).not.toHaveProperty("githubIdentity");
      expect(h.readPublisherIdentity).toHaveBeenCalledTimes(1);
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.posts).not.toHaveBeenCalled();
      expect(h.saved()).toMatchObject({
        state: "sent",
        intentId: intent.id,
        externalId: "reconciled-comment",
      });
    },
  );

  it("never resends an uncertain comment when repeated read-only reconciliation finds no receipt", async () => {
    const h = harness({ maximumAttempts: 3 });
    h.control.delivery = {
      state: "unknown",
      message: "The synthetic response was lost.",
      externalId: null,
    };
    h.enqueue();
    await h.run();
    expect(h.saved().state).toBe("unknown");
    await h.publisher.stop();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      h.clock.value += 600_000;
      const restarted = h.createPublisher();
      await h.run(restarted);
      await restarted.stop();
    }
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    expect(h.saved()).toMatchObject({ state: "unknown", attempts: 3 });
    expect(h.store.countPrefix("idempotency", "auto-reply:pending:")).toBe(0);
    h.clock.value += 600_000;
    await h.run(h.createPublisher());
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("recovers a final failed native receipt without retrying its publication", async () => {
    const h = harness();
    h.enqueue();
    await h.freeze();
    const actor = h.automaticActor();
    const intent = await h.actions.createIntent(actor, h.saved().request!);
    h.control.delivery = {
      state: "failed",
      message: "The synthetic request was rejected.",
      externalId: null,
    };
    await h.actions.confirmIntent(actor, intent.id, {
      version: intent.version,
      payloadDigest: intent.payloadDigest,
    });
    await h.run(h.createPublisher());
    expect(h.saved()).toMatchObject({ state: "failed", intentId: intent.id });
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("blocks a persisted intent whose payload no longer matches the report outbox", async () => {
    const h = harness();
    h.enqueue();
    await h.freeze();
    const intent = await h.actions.createIntent(h.automaticActor(), h.saved().request!);
    h.store.put("actionIntents", intent.id, {
      ...intent,
      payload: {
        kind: "feedback",
        body: "Unrelated replacement content",
        findingIds: [],
        drafts: [],
      },
    });
    await h.run();
    expect(h.saved().state).toBe("blocked");
    expect(h.posts).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});

describe("automatic reply unified comment history", () => {
  it("records one actual native submission with its complete action-marked body", async () => {
    const h = harness();
    const markDispatched = vi.spyOn(h.deliveries, "markDispatched");
    h.enqueue();
    expect(h.store.list("commentDeliveries")).toEqual([]);
    await h.run();
    const intent = h.store.list<InvestigationActionIntentV1>("actionIntents")[0]!;
    const rows = h.deliveries.list(h.actor, { commentId: h.saved().id }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `auto-reply-delivery:${intent.id}`,
      commentId: h.saved().id,
      mode: "result",
      operation: "create",
      state: "succeeded",
      effect: "applied",
      body: `${h.saved().body}\n\n<!-- agentic-review-action:${intent.id}:${intent.payloadDigest} -->`,
      attemptNumber: 1,
      legacy: false,
      externalId: "synthetic-comment",
    });
    expect(markDispatched).toHaveBeenCalledTimes(1);
    await h.publisher.stop();
    await h.run(h.createPublisher());
    expect(h.store.list("commentDeliveries")).toHaveLength(1);
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it("does not mark dispatch until the final transport boundary", async () => {
    const h = harness();
    const markDispatched = vi.spyOn(h.deliveries, "markDispatched");
    h.control.boundary = (name) => {
      if (name !== "dispatch") return;
      expect(markDispatched).not.toHaveBeenCalled();
      h.updateSettings(false);
    };
    h.enqueue();
    await h.run();
    expect(markDispatched).not.toHaveBeenCalled();
    expect(h.posts).not.toHaveBeenCalled();
    expect(h.deliveries.list(h.actor).items).toMatchObject([
      { state: "failed", effect: "not_sent", operation: "create" },
    ]);
  });

  it("marks one dispatch even if a transport repeats its final synchronous callback", async () => {
    const h = harness();
    const markDispatched = vi.spyOn(h.deliveries, "markDispatched");
    h.execute.mockImplementationOnce(
      async (intent, _repository, _workItem, _actor, beforeDispatch) => {
        beforeDispatch?.();
        beforeDispatch?.();
        h.posts(intent);
        return h.control.delivery;
      },
    );
    h.enqueue();
    await h.run();
    expect(markDispatched).toHaveBeenCalledTimes(1);
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.deliveries.list(h.actor).items[0]).toMatchObject({
      state: "succeeded",
      effect: "applied",
    });
  });

  it("records a native rejection without changing the existing native receipt", async () => {
    const h = harness();
    h.control.delivery = {
      state: "failed",
      message: "Synthetic explicit rejection",
      externalId: null,
    };
    h.enqueue();
    await h.run();
    expect(h.deliveries.list(h.actor).items[0]).toMatchObject({
      state: "failed",
      effect: "rejected",
    });
    expect(h.store.list<InvestigationActionIntentV1>("actionIntents")[0]!.result?.message).toBe(
      "Synthetic explicit rejection",
    );
  });

  it("adds receipt observations to the same uncertain attempt without replacing its original receipt", async () => {
    const h = harness();
    h.control.delivery = { state: "unknown", message: "Synthetic lost response", externalId: null };
    h.enqueue();
    await h.run();
    await h.publisher.stop();
    const before = h.store.list<InvestigationCommentDelivery & { originalReceipt: unknown }>(
      "commentDeliveries",
    )[0]!;
    expect(before).toMatchObject({ state: "unknown", effect: "unknown", observations: [] });
    h.control.reconciliation = {
      state: "succeeded",
      message: "Exact synthetic receipt",
      externalId: "synthetic-comment",
    };
    h.clock.value += 600_000;
    await h.run(h.createPublisher());
    const after = h.store.list<InvestigationCommentDelivery & { originalReceipt: unknown }>(
      "commentDeliveries",
    );
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before.id,
      state: "succeeded",
      effect: "applied",
      externalId: "synthetic-comment",
    });
    expect(after[0]!.originalReceipt).toEqual(before.originalReceipt);
    expect(after[0]!.observations).toHaveLength(1);
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it("records a real preparation failure without inventing a published body or a native intent", async () => {
    const h = harness({ maximumAttempts: 1 });
    h.readPublisherIdentity.mockRejectedValue(new Error("Synthetic unavailable identity service"));
    h.enqueue();
    expect(h.store.list("commentDeliveries")).toHaveLength(0);
    await h.run();
    expect(h.deliveries.list(h.actor).items).toMatchObject([
      { operation: "create", state: "failed", effect: "not_sent", body: null, legacy: false },
    ]);
    expect(h.store.list("actionIntents")).toHaveLength(0);
    expect(h.posts).not.toHaveBeenCalled();
  });

  it("imports a retained legacy success once without inventing its completion time", async () => {
    const h = harness({ history: false });
    h.enqueue();
    await h.run();
    await h.publisher.stop();
    expect(h.store.list("commentDeliveries")).toHaveLength(0);
    const original = h.saved();
    const restarted = h.createPublisher(true);
    await h.run(restarted);
    await restarted.stop();
    await h.run(h.createPublisher(true));
    expect(h.saved()).toEqual(original);
    expect(h.deliveries.list(h.actor).items).toMatchObject([
      {
        state: "succeeded",
        effect: "applied",
        legacy: true,
        attemptNumber: 0,
        startedAt: original.updatedAt,
        finishedAt: null,
      },
    ]);
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it("imports an executing legacy snapshot and reconciles its original row without a fake retry", async () => {
    const h = harness({ history: false });
    h.control.delivery = { state: "unknown", message: "Synthetic lost response", externalId: null };
    h.enqueue();
    await h.run();
    await h.publisher.stop();
    h.store.put("idempotency", h.saved().id, { ...h.saved(), state: "sending" });
    h.clock.value += 600_000;
    h.control.reconciliation = {
      state: "succeeded",
      message: "Exact synthetic receipt",
      externalId: "synthetic-comment",
    };
    await h.run(h.createPublisher(true));
    const rows = h.store.list<
      InvestigationCommentDelivery & { originalReceipt: { state: string; at: string | null } }
    >("commentDeliveries");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      legacy: true,
      attemptNumber: 0,
      state: "succeeded",
      finishedAt: null,
      originalReceipt: { state: "unknown", at: null },
    });
    expect(rows[0]!.observations).toHaveLength(1);
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it("does not import a fake uncertain write for a legacy sending record whose intent is still prepared", async () => {
    const h = harness({ history: false });
    h.enqueue();
    await h.freeze();
    const intent = await h.actions.createIntent(h.automaticActor(), h.saved().request!);
    h.store.put("idempotency", h.saved().id, {
      ...h.saved(),
      state: "sending",
      intentId: intent.id,
    });
    await h.run(h.createPublisher(true));
    expect(h.saved()).toMatchObject({ state: "sent", intentId: intent.id });
    expect(h.deliveries.list(h.actor).items).toMatchObject([
      {
        id: `auto-reply-delivery:${intent.id}`,
        legacy: false,
        state: "succeeded",
        effect: "applied",
        attemptNumber: 1,
      },
    ]);
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it("never marks an already dispatched attempt as not sent after confirmation bookkeeping fails", async () => {
    const h = harness({ maximumAttempts: 1 });
    const confirm = h.actions.confirmIntent.bind(h.actions);
    vi.spyOn(h.actions, "confirmIntent").mockImplementationOnce(async (...args) => {
      await confirm(...args);
      throw new Error("Synthetic interruption after native confirmation completed");
    });
    h.enqueue();
    await h.run();
    const row = h.store.list<InvestigationCommentDelivery & { dispatchedAt: string | null }>(
      "commentDeliveries",
    )[0]!;
    expect(row.dispatchedAt).not.toBeNull();
    expect(row).toMatchObject({ state: "succeeded", effect: "applied" });
    expect(h.saved().state).toBe("sent");
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.store.list<InvestigationActionIntentV1>("actionIntents")[0]!.state).toBe("succeeded");
  });

  it("imports all retained snapshots through bounded pages", async () => {
    const h = harness({ history: false });
    h.enqueue();
    await h.run();
    await h.publisher.stop();
    const source = h.saved();
    for (let index = 0; index < 101; index += 1) {
      const reportId = `legacy-report-${index}`;
      h.store.insert("idempotency", `auto-reply:report:${reportId}`, {
        ...source,
        id: `auto-reply:report:${reportId}`,
        reportId,
        intentId: null,
      });
    }
    await h.run(h.createPublisher(true));
    expect(h.store.list("commentDeliveries")).toHaveLength(102);
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it("returns scoped public summaries with stable versions and no implicit native retry action", async () => {
    const h = harness();
    h.enqueue();
    const before = h.publisher.getComment(h.actor, h.saved().id);
    expect(before).toMatchObject({
      mode: "result",
      state: "pending",
      taskId: h.task.id,
      lastAttemptAt: null,
      availableActions: [],
    });
    expect(h.publisher.getComment(h.actor, h.saved().id).version).toBe(before.version);
    expect(h.publisher.taskSummaries(h.actor, [h.task.id]).items).toEqual([before]);
    await h.run();
    const after = h.publisher.getComment(h.actor, h.saved().id);
    expect(after).toMatchObject({
      state: "synced",
      requiresAttention: false,
      externalId: "synthetic-comment",
      availableActions: [],
    });
    expect(after.version).not.toBe(before.version);
    expect(after.lastConfirmedAt).not.toBeNull();
    expect(after.commentUrl).toContain("#issuecomment-synthetic-comment");
    expect(() => h.publisher.getComment({ ...h.actor, repositoryIds: [] }, h.saved().id)).toThrow(
      "cannot read",
    );
    expect(() => h.publisher.taskSummaries({ ...h.actor, repositoryIds: [] }, [h.task.id])).toThrow(
      "cannot read",
    );
    expect(after).not.toHaveProperty("authorizationEpoch");
    expect(after).not.toHaveProperty("githubIdentity");
    expect(after).not.toHaveProperty("request");
  });

  it("does not expose internal failure messages through the public summary", async () => {
    const h = harness({ maximumAttempts: 1 });
    h.enqueue();
    h.store.put("idempotency", h.saved().id, {
      ...h.saved(),
      state: "blocked",
      reason: "Sensitive synthetic diagnostic",
    });
    h.store.delete("idempotency", h.saved().pendingId);
    const summary = h.publisher.getComment(h.actor, h.saved().id);
    expect(summary).toMatchObject({
      state: "needs_attention",
      requiresAttention: true,
      availableActions: [],
    });
    expect(JSON.stringify(summary)).not.toContain("Sensitive synthetic diagnostic");
  });
});

const awaitedBoundaries = [
  "publisher-identity",
  "read-target:1",
  "read-capabilities:1",
  "read-target:2",
  "read-capabilities:2",
  "dispatch",
] as const;
const revocations = [
  "disabled",
  "reauthorized",
  "account-permission",
  "repository-binding",
] as const;
describe("automatic reply authorization at awaited boundaries", () => {
  it.each(
    revocations.flatMap((revocation) =>
      awaitedBoundaries.map((boundary) => ({ revocation, boundary })),
    ),
  )(
    "rejects $revocation after $boundary without a publication request",
    async ({ revocation, boundary }) => {
      const h = harness();
      h.enqueue();
      let revoked = false;
      h.control.boundary = (name) => {
        if (name !== boundary) return;
        revoked = true;
        if (revocation === "disabled") h.updateSettings(false);
        if (revocation === "reauthorized") {
          const settings = h.settings.read(h.actor, h.task.repository.id);
          h.settings.update(h.actor, h.task.repository.id, {
            version: settings.version,
            enabled: true,
            pullRequestTemplate: settings.pullRequestTemplate,
            issueTemplate: settings.issueTemplate,
            reauthorize: true,
          });
        }
        if (revocation === "account-permission")
          h.control.operator = { ...h.actor, permissions: ["repository:manage", "action:prepare"] };
        if (revocation === "repository-binding")
          h.store.put("repositories", h.task.repository.id, {
            ...h.task.repository,
            fullName: "synthetic-owner/changed-repository",
          });
      };
      await h.run();
      expect(revoked).toBe(true);
      expect(h.posts).not.toHaveBeenCalled();
      expect(["blocked", "failed"]).toContain(h.saved().state);
      expect(h.store.countPrefix("idempotency", "auto-reply:pending:")).toBe(0);
    },
  );

  it.each(["account-deleted", "repository-scope", "comment-capability"] as const)(
    "rejects a revoked %s before preparing a native intent",
    async (revocation) => {
      const h = harness();
      h.enqueue();
      if (revocation === "account-deleted") h.control.operator = null;
      if (revocation === "repository-scope")
        h.control.operator = { ...h.actor, repositoryIds: ["*"] };
      if (revocation === "comment-capability")
        h.control.operator = { ...h.actor, actionCapabilities: [] };
      await h.run();
      expect(h.posts).not.toHaveBeenCalled();
      expect(h.store.list("actionIntents")).toHaveLength(0);
      expect(h.saved().state).toBe("blocked");
    },
  );

  it.each(["pr", "bug"] as const)(
    "blocks a %s report when its current target revision is stale",
    async (kind) => {
      const h = harness({ kind });
      h.enqueue();
      const target = h.targets.get(h.task.workItem.id)!;
      h.targets.set(h.task.workItem.id, { ...target, revisionKey: "9".repeat(64) });
      await h.run();
      expect(h.saved().state).toBe("blocked");
      expect(h.posts).not.toHaveBeenCalled();
    },
  );

  it("blocks a PR whose head changes during the final transport preflight", async () => {
    const h = harness();
    h.enqueue();
    h.control.boundary = (name) => {
      if (name === "dispatch") {
        const target = h.targets.get(h.task.workItem.id)!;
        h.targets.set(h.task.workItem.id, { ...target, headSha: "4".repeat(40) });
      }
    };
    await h.run();
    expect(h.saved().state).toBe("failed");
    expect(h.posts).not.toHaveBeenCalled();
  });

  it("blocks publication if the immutable report reference is missing or changed", async () => {
    const h = harness();
    h.enqueue();
    h.store.delete("reports", h.result.report.id);
    await h.run();
    expect(h.saved().state).toBe("blocked");
    expect(h.posts).not.toHaveBeenCalled();
  });
});

describe("automatic reply eligibility and visibility", () => {
  it.each(["partial", "failed", "follow-up", "disabled"] as const)(
    "does not queue an ineligible %s report",
    async (condition) => {
      const h = harness({ enabled: condition !== "disabled" });
      if (condition === "partial") h.result.report.completeness = "partial";
      if (condition === "failed") h.result.outcome = "failed";
      if (condition === "follow-up") h.task.kind = "pr-verify";
      h.enqueue();
      await h.run();
      expect(h.publisher.list(h.actor, h.task.repository.id).items).toHaveLength(0);
      expect(h.store.countPrefix("idempotency", "auto-reply:pending:")).toBe(0);
      expect(h.posts).not.toHaveBeenCalled();
    },
  );

  it("does not backfill historical sealed reports on start or when authorization is enabled", async () => {
    const h = harness({ enabled: false });
    await h.run();
    h.updateSettings(true);
    await h.publisher.drain();
    await h.publisher.stop();
    await h.run(h.createPublisher());
    expect(h.store.list("reports")).toHaveLength(1);
    expect(h.publisher.list(h.actor, h.task.repository.id).items).toHaveLength(0);
    expect(h.posts).not.toHaveBeenCalled();
  });

  it("records an oversized body as blocked without truncating the report or sending a comment", async () => {
    const h = harness();
    h.result.report.summary = "Oversized synthetic investigation summary. ".repeat(3_000);
    h.store.put("reports", h.result.report.id, h.result);
    h.enqueue();
    await h.run();
    expect(h.saved()).toMatchObject({
      state: "blocked",
      body: null,
      request: null,
      intentId: null,
    });
    expect(h.saved().reason).toContain("without truncating findings");
    expect(h.store.get<InvestigationResultV1>("reports", h.result.report.id)?.report.summary).toBe(
      h.result.report.summary,
    );
    expect(h.posts).not.toHaveBeenCalled();
    expect(h.store.list("actionIntents")).toHaveLength(0);
  });

  it("blocks a queued reply while global external writes are disabled", async () => {
    const h = harness({ externalWrites: false });
    h.enqueue();
    await h.run();
    expect(h.saved()).toMatchObject({ state: "blocked", intentId: null });
    expect(h.saved().reason).toContain("External comment publication is disabled");
    expect(h.posts).not.toHaveBeenCalled();
  });

  it("fails closed when a publisher cannot resolve a verified GitHub identity", async () => {
    const h = harness({ publisherIdentity: false });
    h.enqueue();
    await h.run();
    expect(h.saved()).toMatchObject({
      state: "blocked",
      body: null,
      request: null,
      intentId: null,
    });
    expect(h.store.list("actionIntents")).toEqual([]);
    expect(h.readPublisherIdentity).not.toHaveBeenCalled();
    expect(h.posts).not.toHaveBeenCalled();
  });

  it("retries a failed identity lookup without preparing or posting a native comment", async () => {
    const h = harness();
    h.readPublisherIdentity.mockRejectedValueOnce(new Error("Synthetic identity service outage."));
    h.enqueue();
    await h.run();
    expect(h.saved()).toMatchObject({
      state: "pending",
      body: null,
      request: null,
      intentId: null,
      attempts: 1,
    });
    expect(h.saved()).not.toHaveProperty("githubIdentity");
    expect(h.readTarget).not.toHaveBeenCalled();
    expect(h.readCapabilities).not.toHaveBeenCalled();
    expect(h.store.list("actionIntents")).toEqual([]);
    expect(h.posts).not.toHaveBeenCalled();
    await h.publisher.stop();
    h.clock.value += 60_001;
    await h.run(h.createPublisher());
    expect(h.readPublisherIdentity).toHaveBeenCalledTimes(2);
    expect(h.posts).toHaveBeenCalledTimes(1);
    expect(h.saved()).toMatchObject({ state: "sent", attempts: 2 });
  });

  it("rolls back the outbox with a failed report-sealing transaction", async () => {
    const h = harness({ persistReport: false });
    expect(() =>
      h.store.transaction(() => {
        h.store.insert("reports", h.result.report.id, h.result);
        h.publisher.enqueue(h.result, h.task);
        throw new Error("Synthetic report transaction failure");
      }),
    ).toThrow("Synthetic report transaction failure");
    expect(h.store.has("reports", h.result.report.id)).toBe(false);
    expect(h.publisher.list(h.actor, h.task.repository.id).items).toHaveLength(0);
    expect(h.store.countPrefix("idempotency", "auto-reply:pending:")).toBe(0);
    await h.run();
    expect(h.posts).not.toHaveBeenCalled();
  });

  it("commits the report and its outbox together before dispatch", async () => {
    const h = harness({ persistReport: false });
    h.store.transaction(() => {
      h.store.insert("reports", h.result.report.id, h.result);
      h.publisher.enqueue(h.result, h.task);
    });
    expect(h.store.has("reports", h.result.report.id)).toBe(true);
    expect(h.saved().state).toBe("pending");
    expect(h.posts).not.toHaveBeenCalled();
    await h.run();
    expect(h.posts).toHaveBeenCalledTimes(1);
  });

  it("limits status visibility to an exact registered repository scope and excludes authorization internals", () => {
    const h = harness();
    h.enqueue();
    expect(() =>
      h.publisher.list({ ...h.actor, repositoryIds: ["*"] }, h.task.repository.id),
    ).toThrow("cannot read this repository");
    expect(() =>
      h.publisher.list({ ...h.actor, repositoryIds: ["unregistered"] }, "unregistered"),
    ).toThrow("not registered");
    const visible = h.publisher.list(h.actor, h.task.repository.id).items[0]!;
    expect(visible).toMatchObject({
      reportId: h.result.report.id,
      taskId: h.task.id,
      workItemId: h.task.workItem.id,
    });
    for (const privateField of [
      "request",
      "repository",
      "authorizedById",
      "claim",
      "pendingId",
      "template",
      "githubIdentity",
    ])
      expect(visible).not.toHaveProperty(privateField);
  });
});
