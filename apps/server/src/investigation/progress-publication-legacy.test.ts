import type { InvestigationReportRef } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import type { PublicationClaim } from "./progress-publication.js";
import { migrateLegacyProgressReply } from "./progress-publication-legacy.js";
import {
  defaultProgressReplyTemplates,
  type ProgressReplyStage,
} from "./progress-reply-template.js";
import { InvestigationStore } from "./store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationProgressCommentRequest,
} from "./types.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

const actor: InvestigationOperatorPrincipal = {
  id: "operator-one",
  displayName: "Synthetic operator",
  repositoryIds: ["repository-one"],
  permissions: [],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};

function transition(sequence = 0, stage: ProgressReplyStage = "received") {
  return {
    sequence,
    stage,
    updatedAt: new Date(Date.parse("2026-09-18T12:00:00.000Z") + sequence * 60_000).toISOString(),
    failure: null as string | null,
    reportRef: null as InvestigationReportRef | null,
    reportDigest: null as string | null,
  };
}

function legacyRecord() {
  return {
    id: "progress-reply:task:task-one",
    taskId: "task-one",
    taskKind: "pr-review" as const,
    taskCreatedAt: "2026-09-18T12:00:00.000Z",
    repository: { id: "repository-one", fullName: "example/one", githubRepositoryId: 101 },
    workItem: {
      id: "work-item-one",
      repositoryId: "repository-one",
      kind: "pull_request" as const,
      number: 7,
      githubWorkItemId: 202 as number | undefined,
      title: "Synthetic pull request",
      body: "Retained private source content.",
      state: "open",
      subject: { kind: "original_pr", headSha: "a".repeat(40) },
      updatedAt: "2026-09-18T11:00:00.000Z",
    },
    trigger: {
      eventName: "pull_request" as const,
      actorUserId: 11,
      actorLogin: "synthetic-assigner",
      assigneeUserId: 22,
      assigneeLogin: "synthetic-worker",
    },
    settingsVersion: 4,
    templateVersion: 1,
    authorizedById: "legacy-authorizer",
    templates: defaultProgressReplyTemplates,
    resultTemplate: "Retained result template.",
    received: transition(),
    desired: transition(),
    published: null as {
      transition: ReturnType<typeof transition>;
      body: string;
      externalId: string;
    } | null,
    operation: null as {
      transition: ReturnType<typeof transition>;
      request: InvestigationProgressCommentRequest;
      dispatched: boolean;
    } | null,
    githubIdentity: { githubUserId: 33, githubLogin: "synthetic-publisher" },
    state: "pending" as "pending" | "sending" | "sent" | "blocked" | "failed" | "unknown",
    reason: null as string | null,
    pendingId: "progress-reply:pending:retained-key",
    attempts: 17,
    nextAttemptAt: Date.parse("2026-09-19T00:01:00.000Z"),
    claim: null as PublicationClaim | null,
    createdAt: "2026-09-18T12:00:00.000Z",
    updatedAt: "2026-09-18T12:04:00.000Z",
  };
}

function harness() {
  const store = new InvestigationStore();
  stores.push(store);
  const clock = { time: Date.parse("2026-09-19T00:00:00.000Z") };
  const now = () => new Date(clock.time);
  const deliveries = new InvestigationCommentDeliveries({ store, now });
  return { store, deliveries, now, clock, input: legacyRecord() };
}

function request(
  body = "Exact retained body.",
  externalId: string | null = null,
): InvestigationProgressCommentRequest {
  return {
    marker: "<!-- agentic-review-progress:task-one -->",
    body,
    externalId,
    previousBody: externalId === null ? null : "Exact earlier body.",
  };
}

describe("legacy progress publication migration", () => {
  it("retains bindings and the old authorization epoch without manufacturing history", () => {
    const h = harness();
    h.input.desired = transition(3, "completed");
    h.input.desired.reportRef = { id: "report-one", version: 1, digest: "a".repeat(64) };
    h.input.desired.reportDigest = "b".repeat(64);
    h.input.claim = {
      ownerId: "legacy-owner",
      token: "legacy-claim",
      expiresAt: h.clock.time + 30_000,
    };
    const original = structuredClone(h.input);
    const migrated = migrateLegacyProgressReply(h.input, h);
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      id: h.input.id,
      receiptId: null,
      taskId: h.input.taskId,
      taskKind: h.input.taskKind,
      taskCreatedAt: h.input.taskCreatedAt,
      workItemId: h.input.workItem.id,
      repository: h.input.repository,
      trigger: h.input.trigger,
      githubIdentity: h.input.githubIdentity,
      marker: request().marker,
      receivedAt: h.input.received.updatedAt,
      firstStartedAt: null,
      desired: {
        ...h.input.desired,
        legacy: true,
        policy: {
          settingsVersion: 4,
          templateVersion: 1,
          templates: h.input.templates,
          resultTemplate: h.input.resultTemplate,
        },
      },
      grant: { authorizationEpoch: 4, authorizedById: "legacy-authorizer" },
      grantHistory: [
        {
          authorizationEpoch: 4,
          authorizedById: "legacy-authorizer",
          actorId: "legacy-authorizer",
          source: "legacy",
          at: h.now().toISOString(),
        },
      ],
      historyAvailableSince: h.now().toISOString(),
      state: "pending",
      writeAttempts: 0,
      readAttempts: 0,
      lastAttemptId: null,
      lastAttemptAt: null,
      pendingId: h.input.pendingId,
      nextAttemptAt: h.input.nextAttemptAt,
      claim: h.input.claim,
      createdAt: h.input.createdAt,
      updatedAt: h.input.updatedAt,
    });
    expect(migrated.target).toEqual({
      id: "work-item-one",
      repositoryId: "repository-one",
      kind: "pull_request",
      number: 7,
      githubWorkItemId: 202,
    });
    expect(h.deliveries.list(actor).items).toEqual([]);
    expect(h.store.has("idempotency", h.input.id)).toBe(false);
    expect(h.input).toEqual(original);
  });

  it("does not infer an unavailable upstream work item identity", () => {
    const h = harness();
    h.input.workItem.githubWorkItemId = undefined;
    expect(migrateLegacyProgressReply(h.input, h).target).not.toHaveProperty("githubWorkItemId");
  });

  it("preserves prepared content without presenting preparation as a delivery attempt", () => {
    const h = harness();
    h.input.operation = {
      transition: h.input.received,
      request: request("Retained prepared body."),
      dispatched: false,
    };
    h.input.desired = transition(1, "started");
    const migrated = migrateLegacyProgressReply(h.input, h);
    expect(migrated.operation).toMatchObject({
      request: h.input.operation.request,
      dispatched: false,
      finished: false,
      attemptId: null,
    });
    expect(migrated.desired).toMatchObject({
      sequence: 1,
      stage: "started",
      context: { status: "running" },
    });
    expect(migrated.firstStartedAt).toBe(h.input.desired.updatedAt);
    expect(migrated.state).toBe("pending");
    expect(h.deliveries.list(actor).items).toEqual([]);
  });

  it("imports only the retained published snapshot with a stable identity and unknown confirmation time", () => {
    const h = harness();
    h.input.desired = transition(3, "completed");
    h.input.published = {
      transition: h.input.desired,
      body: "Exact final body.\r\n\r\n<!-- agentic-review-progress:task-one -->",
      externalId: "501",
    };
    h.input.state = "sent";
    const migrated = h.store.transaction(() => migrateLegacyProgressReply(h.input, h));
    const first = h.deliveries.list(actor).items;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      commentId: h.input.id,
      taskId: h.input.taskId,
      workItemId: h.input.workItem.id,
      operation: "update",
      body: h.input.published.body,
      externalId: "501",
      state: "succeeded",
      effect: "applied",
      legacy: true,
      attemptNumber: 0,
      startedAt: h.input.desired.updatedAt,
      finishedAt: null,
      observations: [],
    });
    expect(migrated.confirmed).toMatchObject({
      body: h.input.published.body,
      externalId: "501",
      attemptId: first[0]!.id,
      confirmedAt: null,
    });
    expect(migrated.state).toBe("synced");
    expect(migrated.nextAttemptAt).toBeNull();
    expect(migrated.firstStartedAt).toBeNull();
    h.clock.time += 60_000;
    const repeated = migrateLegacyProgressReply(h.input, h);
    expect(repeated.confirmed?.attemptId).toBe(migrated.confirmed?.attemptId);
    expect(repeated.desired.id).toBe(migrated.desired.id);
    expect(h.deliveries.list(actor).items).toEqual(first);
  });

  it.each(["pending", "sending", "unknown", "blocked", "failed"] as const)(
    "preserves a dispatched operation as read-only unconfirmed work from %s",
    (state) => {
      const h = harness();
      h.input.state = state;
      h.input.published = {
        transition: h.input.received,
        body: "Exact earlier body.",
        externalId: "501",
      };
      h.input.operation = {
        transition: transition(1, "started"),
        request: request("Exact attempted update.", "501"),
        dispatched: true,
      };
      h.input.desired = transition(2, "completed");
      const migrated = migrateLegacyProgressReply(h.input, h);
      const rows = h.deliveries.list(actor).items;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        state: "unknown",
        effect: "unknown",
        operation: "update",
        body: h.input.operation.request.body,
        externalId: "501",
        attemptNumber: 0,
        legacy: true,
        finishedAt: null,
      });
      expect(rows[1]).toMatchObject({
        state: "succeeded",
        operation: "create",
        body: h.input.published.body,
        externalId: "501",
        attemptNumber: 0,
        legacy: true,
        finishedAt: null,
      });
      expect(migrated).toMatchObject({
        state: "unconfirmed",
        reasonCode: "dispatched_without_receipt",
        requiresAttention: true,
        reconcileRequested: false,
      });
      expect(migrated.operation).toMatchObject({
        revision: { sequence: 1 },
        request: h.input.operation.request,
        attemptId: rows[0]!.id,
        dispatched: true,
        finished: true,
      });
      expect(migrated.desired.sequence).toBe(2);
      expect(migrated.lastAttemptId).toBe(rows[0]!.id);
      h.deliveries.observe(rows[0]!.id, { state: "succeeded", externalId: "501" });
      expect(h.deliveries.list(actor).items).toHaveLength(2);
      expect(h.deliveries.read(actor, rows[0]!.id).observations).toHaveLength(1);
      expect(migrateLegacyProgressReply(h.input, h).operation?.attemptId).toBe(rows[0]!.id);
      expect(h.deliveries.read(actor, rows[0]!.id).state).toBe("succeeded");
    },
  );

  it.each(["sending", "unknown"] as const)(
    "does not trust a missing dispatch flag in legacy %s state",
    (state) => {
      const h = harness();
      h.input.state = state;
      h.input.operation = { transition: h.input.received, request: request(), dispatched: false };
      const migrated = migrateLegacyProgressReply(h.input, h);
      expect(migrated).toMatchObject({
        state: "unconfirmed",
        operation: { dispatched: true, finished: true },
      });
      expect(h.deliveries.list(actor).items).toMatchObject([
        { state: "unknown", effect: "unknown", body: request().body },
      ]);
    },
  );

  it("keeps an ambiguous record with missing request evidence unscheduled", () => {
    const h = harness();
    h.input.state = "unknown";
    const migrated = migrateLegacyProgressReply(h.input, h);
    expect(migrated).toMatchObject({
      state: "unconfirmed",
      requiresAttention: true,
      operation: null,
      nextAttemptAt: null,
      reconcileRequested: false,
    });
    expect(h.deliveries.list(actor).items).toEqual([]);
  });

  it.each([
    ["blocked", "paused"],
    ["failed", "needs_attention"],
  ] as const)(
    "keeps legacy %s publication stopped without recording nonexistent attempts",
    (legacyState, state) => {
      const h = harness();
      h.input.state = legacyState;
      h.input.reason = "Raw retained diagnostic with token=private.";
      const migrated = migrateLegacyProgressReply(h.input, h);
      expect(migrated).toMatchObject({
        state,
        requiresAttention: true,
        nextAttemptAt: null,
        lastAttemptId: null,
      });
      expect(migrated.reasonCode).toBe(`legacy_${legacyState}`);
      expect(JSON.stringify(migrated)).not.toContain("token=private");
      expect(h.deliveries.list(actor).items).toEqual([]);
    },
  );

  it("retains cancelled outcome wording and does not call a later running transition the first start", () => {
    const h = harness();
    h.input.desired = {
      ...transition(4, "failed"),
      failure: "The task was cancelled before completion.",
    };
    h.input.published = {
      transition: transition(3, "started"),
      body: "Retained resumed body.",
      externalId: "501",
    };
    const migrated = migrateLegacyProgressReply(h.input, h);
    expect(migrated.desired.context.status).toBe("cancelled");
    expect(migrated.firstStartedAt).toBeNull();
    expect(migrated.confirmed?.revision.context.startedAt).toBe(
      h.input.published.transition.updatedAt,
    );
  });

  it("rolls back imported evidence together with its parent transaction", () => {
    const h = harness();
    h.input.published = { transition: h.input.received, body: "Retained body.", externalId: "501" };
    expect(() =>
      h.store.transaction(() => {
        const migrated = migrateLegacyProgressReply(h.input, h);
        h.store.put("idempotency", migrated.id, migrated);
        throw new Error("Synthetic parent rollback.");
      }),
    ).toThrow("Synthetic parent rollback.");
    expect(h.deliveries.list(actor).items).toEqual([]);
    expect(h.store.has("idempotency", h.input.id)).toBe(false);
  });

  it("rolls back standalone migration if importing a later retained snapshot fails", () => {
    const h = harness();
    h.input.published = { transition: h.input.received, body: "Retained body.", externalId: "501" };
    h.input.operation = {
      transition: transition(1, "started"),
      request: request("Retained update.", "501"),
      dispatched: true,
    };
    const importLegacy = h.deliveries.importLegacy.bind(h.deliveries);
    vi.spyOn(h.deliveries, "importLegacy")
      .mockImplementationOnce(importLegacy)
      .mockImplementationOnce(() => {
        throw new Error("Synthetic import failure.");
      });
    expect(() => migrateLegacyProgressReply(h.input, h)).toThrow("Synthetic import failure.");
    expect(h.deliveries.list(actor).items).toEqual([]);
  });

  it("rejects malformed retained input before writing delivery evidence", () => {
    const h = harness();
    for (const input of [
      null,
      {},
      { ...h.input, received: null },
      { ...h.input, schemaVersion: 2 },
    ])
      expect(() => migrateLegacyProgressReply(input, h)).toThrow(
        expect.objectContaining({ code: "progress_reply_legacy_invalid" }),
      );
    expect(h.deliveries.list(actor).items).toEqual([]);
  });
});
