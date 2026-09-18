import {
  type ActionContextV1,
  createInvestigationPreview,
  type InvestigationActionIntentV1,
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
  function createPublisher(): InvestigationAutomaticReplies {
    const publisher = new InvestigationAutomaticReplies({
      store,
      settings,
      actions,
      resolveOperator: (id) => (control.operator?.id === id ? control.operator : null),
      ...(options.publisherIdentity === false
        ? {}
        : { resolvePublisherIdentity: readPublisherIdentity }),
      enableExternalWrites: options.externalWrites ?? true,
      now,
      retryDelayMs: 60_000,
      maximumAttempts: options.maximumAttempts ?? 3,
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
      state: "blocked",
      body: frozen.body,
      settingsVersion: frozen.settingsVersion,
    });
    expect(h.saved().request).toEqual(frozen.request);
    expect(h.posts).not.toHaveBeenCalled();
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
  "settings-version",
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
        if (revocation === "settings-version") h.updateSettings(true);
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
