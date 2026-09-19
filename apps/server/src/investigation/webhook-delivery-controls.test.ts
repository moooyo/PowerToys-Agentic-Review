import {
  InvestigationWebhookAttemptSchema,
  InvestigationWebhookDeliveryListSchema,
  type InvestigationWebhookDeliveryQuery,
  InvestigationWebhookDeliveryQuerySchema,
  InvestigationWebhookDeliverySchema,
  type InvestigationWebhookRetryRequest,
  InvestigationWebhookRetryRequestSchema,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  InvestigationE2eIntake,
  InvestigationE2eReceipt,
} from "../../dist/investigation/e2e-intake.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";
import {
  authorizeWebhookRetry,
  beginWebhookAttempt,
  finishWebhookAttempt,
  InvestigationWebhookDeliveryControls,
  phaseWebhookAttempt,
  projectWebhookDelivery,
  webhookDeliveryVersion,
} from "../../dist/investigation/webhook-delivery-controls.js";
import type {
  InvestigationWebhookIntake,
  InvestigationWebhookReceipt,
} from "../../dist/investigation/webhook-intake.js";

type Receipt = InvestigationWebhookReceipt | InvestigationE2eReceipt;
const repository = { id: "repository-a", fullName: "fixture/project-a", githubRepositoryId: 101 };
const otherRepository = {
  id: "repository-b",
  fullName: "fixture/project-b",
  githubRepositoryId: 102,
};
const hiddenRepository = {
  id: "repository-hidden",
  fullName: "fixture/hidden",
  githubRepositoryId: 103,
};
const receivedAt = "2026-09-19T08:00:00.000Z";
const startedAt = Date.parse(receivedAt);
const actor: InvestigationOperatorPrincipal = {
  id: "fixture-operator",
  displayName: "Fixture operator",
  repositoryIds: [repository.id, otherRepository.id],
  permissions: ["repository:manage", "task:create"],
  actionCapabilities: [],
  allowRepositoryExecution: true,
};
const stores: InvestigationStore[] = [];
const originalDateTimeFormat = FormatRegistry.Get("date-time");

beforeAll(() => {
  if (originalDateTimeFormat === undefined)
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
});

afterAll(() => {
  if (originalDateTimeFormat === undefined) FormatRegistry.Delete("date-time");
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function staticReceipt(
  deliveryId: string,
  overrides: Partial<InvestigationWebhookReceipt> = {},
): InvestigationWebhookReceipt {
  return {
    id: `webhook:delivery:${deliveryId}`,
    deliveryId,
    eventName: "issues",
    payloadSha256: "a".repeat(64),
    receivedAt,
    pendingId: `webhook:pending:${deliveryId}`,
    assignment: {
      repository,
      kind: "issue",
      number: 7,
      githubWorkItemId: 201,
      actorUserId: 301,
      assigneeUserId: 401,
      updatedAt: receivedAt,
    },
    policyDigest: "b".repeat(64),
    state: "failed",
    attempts: 3,
    nextAttemptAt: startedAt,
    source: null,
    taskRequest: null,
    taskId: null,
    reason: "synthetic_task_creation_failure",
    ...overrides,
  };
}

function e2eReceipt(
  deliveryId: string,
  overrides: Partial<InvestigationE2eReceipt> = {},
): InvestigationE2eReceipt {
  return {
    id: `e2e:webhook:${deliveryId}`,
    deliveryId,
    eventName: "issue_comment",
    payloadSha256: "c".repeat(64),
    repository,
    number: 9,
    receivedAt,
    actorUserId: 301,
    reviewerUserId: 401,
    command: {
      commentId: 501,
      githubIssueId: 202,
      mentionLogin: "fixture-reviewer",
      bodySha256: "d".repeat(64),
    },
    state: "failed",
    reason: "synthetic_task_creation_failure",
    taskId: null,
    revision: null,
    source: null,
    taskRequest: null,
    admission: null,
    attempts: 3,
    nextAttemptAt: startedAt,
    ...overrides,
  };
}

function harness(receipts: readonly Receipt[] = []) {
  const store = new InvestigationStore();
  stores.push(store);
  for (const receipt of receipts) store.insert("idempotency", receipt.id, receipt);
  return { store, controls: new InvestigationWebhookDeliveryControls({ store }) };
}

function expectError(operation: () => unknown, statusCode: number, code: string): void {
  expect(operation).toThrow(expect.objectContaining({ statusCode, code }));
}

function retryRequest(
  receipt: Receipt,
  idempotencyKey = "fixture-retry",
): InvestigationWebhookRetryRequest {
  return { version: webhookDeliveryVersion(receipt), idempotencyKey };
}

describe("webhook delivery listing", () => {
  it("pages interleaved static and E2E receipts without exposing other namespaces or repositories", () => {
    const receipts = [
      staticReceipt("static-new", { receivedAt: "2026-09-19T08:04:00.000Z" }),
      e2eReceipt("e2e-new", { receivedAt: "2026-09-19T08:03:00.000Z" }),
      staticReceipt("static-tie", { receivedAt: "2026-09-19T08:02:00.000Z" }),
      e2eReceipt("e2e-tie", { receivedAt: "2026-09-19T08:02:00.000Z" }),
      staticReceipt("static-old", { receivedAt: "2026-09-19T08:01:00.000Z" }),
      e2eReceipt("hidden-newest", {
        repository: hiddenRepository,
        receivedAt: "2026-09-19T08:05:00.000Z",
      }),
    ];
    const { store, controls } = harness(receipts);
    store.insert("idempotency", "comment:delivery:unrelated", { privateComment: "not an intake" });
    store.insert("idempotency", "webhook:retry:unrelated", { digest: "not a delivery" });

    const first = controls.list(actor, { limit: 2 });
    expect(Value.Check(InvestigationWebhookDeliveryListSchema, first)).toBe(true);
    expect(first.items.map((item) => item.deliveryId)).toEqual(["static-new", "e2e-new"]);
    expect(first.items.map((item) => item.mode)).toEqual(["static", "e2e"]);
    expect(first.nextCursor).not.toBeNull();
    const second = controls.list(actor, { limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.deliveryId)).toEqual(["static-tie"]);
    expect(second.nextCursor).not.toBeNull();
    const last = controls.list(actor, { limit: 3, cursor: second.nextCursor! });
    expect(last.items.map((item) => item.deliveryId)).toEqual(["e2e-tie", "static-old"]);
    expect(last.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items, ...last.items].map((item) => item.deliveryId)).size,
    ).toBe(5);
  });

  it("finds newest matching deliveries beyond a store page boundary", () => {
    const { store, controls } = harness();
    store.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        const receipt = staticReceipt(`static-${String(index).padStart(4, "0")}`, {
          receivedAt: new Date(startedAt + index * 1_000).toISOString(),
        });
        store.insert("idempotency", receipt.id, receipt);
      }
      const latest = e2eReceipt("latest", {
        receivedAt: new Date(startedAt + 502_000).toISOString(),
      });
      store.insert("idempotency", latest.id, latest);
    });

    const first = controls.list(actor, { limit: 2, state: "failed" });
    expect(first.items.map((item) => item.deliveryId)).toEqual(["latest", "static-0500"]);
    const next = controls.list(actor, { limit: 2, state: "failed", cursor: first.nextCursor! });
    expect(next.items.map((item) => item.deliveryId)).toEqual(["static-0499", "static-0498"]);
  });

  it("applies repository, target, state, and mode filters together", () => {
    const issue = staticReceipt("issue-a");
    const pullRequest = staticReceipt("pr-a", {
      eventName: "pull_request",
      assignment: {
        ...issue.assignment,
        kind: "pull_request",
        number: 9,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      state: "completed",
    });
    const { controls } = harness([
      issue,
      pullRequest,
      e2eReceipt("e2e-a"),
      staticReceipt("issue-b", {
        assignment: { ...issue.assignment, repository: otherRepository },
      }),
      e2eReceipt("e2e-b", { repository: otherRepository }),
    ]);
    const cases: { query: InvestigationWebhookDeliveryQuery; ids: string[] }[] = [
      { query: { repositoryId: repository.id }, ids: ["pr-a", "issue-a", "e2e-a"] },
      { query: { kind: "issue" }, ids: ["issue-b", "issue-a"] },
      { query: { number: 9 }, ids: ["pr-a", "e2e-b", "e2e-a"] },
      { query: { state: "completed" }, ids: ["pr-a"] },
      { query: { mode: "e2e" }, ids: ["e2e-b", "e2e-a"] },
      {
        query: {
          repositoryId: repository.id,
          kind: "pull_request",
          number: 9,
          state: "failed",
          mode: "e2e",
        },
        ids: ["e2e-a"],
      },
      { query: { kind: "issue", mode: "e2e" }, ids: [] },
    ];
    for (const { query, ids } of cases) {
      expect(Value.Check(InvestigationWebhookDeliveryQuerySchema, query)).toBe(true);
      expect(controls.list(actor, query).items.map((item) => item.deliveryId)).toEqual(ids);
    }
    expect(controls.list({ ...actor, repositoryIds: [] })).toEqual({ items: [], nextCursor: null });
    expectError(
      () => controls.list(actor, { repositoryId: hiddenRepository.id }),
      403,
      "repository_access_denied",
    );
  });

  it("binds cursors to filters and repository scope while allowing page-size and scope-order changes", () => {
    const { controls } = harness([staticReceipt("a"), staticReceipt("b"), e2eReceipt("c")]);
    const first = controls.list(actor, { state: "failed", limit: 1 });
    const cursor = first.nextCursor!;
    expect(
      controls
        .list(
          { ...actor, repositoryIds: [...actor.repositoryIds].reverse() },
          { state: "failed", limit: 2, cursor },
        )
        .items.map((item) => item.deliveryId),
    ).toEqual(["a", "c"]);

    expectError(
      () =>
        controls.list({ ...actor, repositoryIds: [repository.id] }, { state: "failed", cursor }),
      400,
      "invalid_webhook_cursor",
    );
    for (const query of [{ state: "completed" }, { state: "failed", mode: "static" }, {}] as const)
      expectError(() => controls.list(actor, { ...query, cursor }), 400, "invalid_webhook_cursor");

    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    for (const invalid of [
      "not-a-cursor",
      Buffer.from("null").toString("base64url"),
      Buffer.from(JSON.stringify({ ...parsed, receivedAt: "not-a-date" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...parsed, id: "comment:delivery:unrelated" })).toString(
        "base64url",
      ),
    ])
      expectError(
        () => controls.list(actor, { state: "failed", cursor: invalid }),
        400,
        "invalid_webhook_cursor",
      );
  });

  it.each([0, -1, 51, 1.5, Number.NaN])("rejects invalid page size %s", (limit) => {
    const { controls } = harness();
    expectError(() => controls.list(actor, { limit }), 400, "invalid_webhook_query");
  });
});

describe("webhook delivery detail", () => {
  it.each(["static", "e2e"] as const)(
    "links a %s alias to its canonical Task and snapshot",
    (mode) => {
      const create = mode === "static" ? staticReceipt : e2eReceipt;
      const canonical = create("canonical", {
        state: "completed",
        taskId: "task-canonical",
        reason: null,
      });
      const snapshotRef = { id: "snapshot-canonical", digest: "e".repeat(64) };
      const withSource = {
        ...canonical,
        source: {
          workItem: {
            id: "work-item-canonical",
            repositoryId: repository.id,
            kind: mode === "static" ? "issue" : "pull_request",
            number: mode === "static" ? 7 : 9,
            githubWorkItemId: mode === "static" ? 201 : 202,
            title: "Synthetic canonical target",
            body: "Synthetic canonical target body.",
            state: "open",
            updatedAt: receivedAt,
            subject: {
              id: "subject-canonical",
              repositoryId: repository.id,
              workItemId: "work-item-canonical",
              revisionKey: "f".repeat(64),
              ...(mode === "static"
                ? { kind: "issue_snapshot", snapshotDigest: snapshotRef.digest }
                : { kind: "original_pr", baseSha: "a".repeat(40), headSha: "b".repeat(40) }),
            },
          },
          snapshotRef,
        },
      } as Receipt;
      const alias = create("alias", {
        canonicalReceiptId: canonical.id,
        state: "ignored",
        reason: "already_admitted",
        attempts: 0,
        taskId: null,
      });
      const { controls } = harness([withSource, alias]);

      const detail = controls.read(actor, alias.deliveryId);
      expect(Value.Check(InvestigationWebhookDeliverySchema, detail)).toBe(true);
      expect(detail).toMatchObject({
        deliveryId: "alias",
        canonicalDeliveryId: "canonical",
        mode,
        state: "ignored",
        reason: "already_admitted",
        taskId: "task-canonical",
        snapshotRef,
        attempts: 0,
        totalAttempts: 0,
        availableActions: [],
        nextAttemptAt: null,
      });
    },
  );

  it("denies out-of-scope details and identifies missing, ambiguous, or orphaned receipts", () => {
    const inaccessible = e2eReceipt("hidden", { repository: hiddenRepository });
    const orphan = e2eReceipt("orphan", { canonicalReceiptId: "e2e:webhook:missing" });
    const { controls } = harness([
      inaccessible,
      orphan,
      staticReceipt("collision"),
      e2eReceipt("collision"),
    ]);
    expectError(() => controls.read(actor, "hidden"), 403, "repository_access_denied");
    expectError(() => controls.read(actor, "missing"), 404, "webhook_delivery_not_found");
    expectError(() => controls.read(actor, "collision"), 409, "webhook_delivery_ambiguous");
    expectError(() => controls.read(actor, "orphan"), 409, "webhook_canonical_missing");
  });

  it("does not expose a canonical Task from a different repository or intake mode", () => {
    const foreign = e2eReceipt("foreign", {
      repository: hiddenRepository,
      taskId: "private-task",
    });
    const staticCanonical = staticReceipt("static-canonical", { taskId: "static-task" });
    const { controls } = harness([
      foreign,
      staticCanonical,
      e2eReceipt("cross-repository", { canonicalReceiptId: foreign.id }),
      e2eReceipt("cross-mode", { canonicalReceiptId: staticCanonical.id }),
    ]);
    expectError(() => controls.read(actor, "cross-repository"), 409, "webhook_canonical_conflict");
    expectError(() => controls.read(actor, "cross-mode"), 409, "webhook_canonical_conflict");
  });

  it("offers retry only for a failed canonical receipt and the required operator permissions", () => {
    const failedStatic = staticReceipt("static-failed");
    const failedE2e = e2eReceipt("e2e-failed");
    const { store } = harness([failedStatic, failedE2e]);
    const cases: {
      principal: InvestigationOperatorPrincipal;
      staticActions: string[];
      e2eActions: string[];
    }[] = [
      { principal: actor, staticActions: ["retry"], e2eActions: ["retry"] },
      { principal: { ...actor, permissions: [] }, staticActions: [], e2eActions: [] },
      { principal: { ...actor, permissions: ["task:create"] }, staticActions: [], e2eActions: [] },
      {
        principal: { ...actor, permissions: ["repository:manage"] },
        staticActions: [],
        e2eActions: [],
      },
      {
        principal: { ...actor, allowRepositoryExecution: false },
        staticActions: ["retry"],
        e2eActions: [],
      },
    ];
    for (const { principal, staticActions, e2eActions } of cases) {
      expect(projectWebhookDelivery(store, principal, failedStatic).availableActions).toEqual(
        staticActions,
      );
      expect(projectWebhookDelivery(store, principal, failedE2e).availableActions).toEqual(
        e2eActions,
      );
    }
    for (const state of ["accepted", "source_ready", "completed", "ignored"] as const)
      expect(
        projectWebhookDelivery(store, actor, { ...failedE2e, state }).availableActions,
      ).toEqual([]);
    expect(
      projectWebhookDelivery(store, actor, {
        ...e2eReceipt("failed-alias"),
        canonicalReceiptId: failedE2e.id,
      }).availableActions,
    ).toEqual([]);
    expect(
      projectWebhookDelivery(store, actor, {
        ...failedE2e,
        canonicalReceiptId: failedE2e.id,
      }).availableActions,
    ).toEqual(["retry"]);
  });

  it("reports a retry schedule only for pending intake states", () => {
    const { store } = harness();
    const receipt = staticReceipt("schedule", { nextAttemptAt: startedAt + 60_000 });
    for (const state of ["accepted", "source_ready"] as const)
      expect(projectWebhookDelivery(store, actor, { ...receipt, state }).nextAttemptAt).toBe(
        "2026-09-19T08:01:00.000Z",
      );
    for (const state of ["completed", "ignored", "failed"] as const)
      expect(projectWebhookDelivery(store, actor, { ...receipt, state }).nextAttemptAt).toBeNull();
  });
});

describe("durable webhook attempt history", () => {
  it("retains earlier failures when an operator retry resets the current cycle", () => {
    const receipt = staticReceipt("history");
    const { store } = harness([receipt]);
    beginWebhookAttempt(store, receipt.id, 1, startedAt);
    phaseWebhookAttempt(store, receipt.id, "source");
    finishWebhookAttempt(
      store,
      { ...receipt, reason: "upstream_503" },
      "retrying",
      startedAt + 1_000,
    );
    beginWebhookAttempt(store, receipt.id, 2, startedAt + 60_000);
    phaseWebhookAttempt(store, receipt.id, "task");
    finishWebhookAttempt(store, receipt, "failed", startedAt + 61_000);
    const previousHistory = projectWebhookDelivery(store, actor, receipt).attemptHistory;

    const retried = { ...receipt, state: "accepted", reason: null, attempts: 0 } as const;
    store.put("idempotency", retried.id, retried);
    beginWebhookAttempt(store, receipt.id, 1, startedAt + 120_000);
    phaseWebhookAttempt(store, receipt.id, "recovery");
    const completed = {
      ...retried,
      state: "completed",
      attempts: 1,
      taskId: "recovered-task",
    } as const;
    finishWebhookAttempt(store, completed, "completed", startedAt + 121_000);
    store.put("idempotency", completed.id, completed);

    const detail = projectWebhookDelivery(store, actor, completed);
    expect(Value.Check(InvestigationWebhookDeliverySchema, detail)).toBe(true);
    for (const attempt of detail.attemptHistory) {
      expect(attempt.id.length).toBeLessThanOrEqual(128);
      expect(Value.Check(InvestigationWebhookAttemptSchema, attempt)).toBe(true);
    }
    expect(detail).toMatchObject({ attempts: 1, totalAttempts: 3, taskId: "recovered-task" });
    expect(detail.attemptHistory.slice(0, 2)).toEqual(previousHistory);
    expect(detail.attemptHistory).toMatchObject([
      {
        number: 1,
        cycleAttempt: 1,
        phase: "source",
        state: "retrying",
        reason: "upstream_503",
        taskId: null,
      },
      {
        number: 2,
        cycleAttempt: 2,
        phase: "task",
        state: "failed",
        reason: receipt.reason,
        taskId: null,
      },
      {
        number: 3,
        cycleAttempt: 1,
        phase: "recovery",
        state: "completed",
        reason: null,
        taskId: "recovered-task",
      },
    ]);
    expect(detail.attemptHistory.map((attempt) => attempt.finishedAt)).toEqual([
      "2026-09-19T08:00:01.000Z",
      "2026-09-19T08:01:01.000Z",
      "2026-09-19T08:02:01.000Z",
    ]);
    phaseWebhookAttempt(store, receipt.id, "authorization");
    finishWebhookAttempt(store, receipt, "failed", startedAt + 122_000);
    expect(projectWebhookDelivery(store, actor, completed).attemptHistory).toEqual(
      detail.attemptHistory,
    );
  });

  it("records an abandoned processing lease as interrupted before the replacement attempt", () => {
    const receipt = e2eReceipt("interrupted", { attempts: 2 });
    const unrelated = staticReceipt("unrelated", { attempts: 1 });
    const { store } = harness([receipt, unrelated]);
    beginWebhookAttempt(store, receipt.id, 1, startedAt);
    phaseWebhookAttempt(store, receipt.id, "task");
    beginWebhookAttempt(store, unrelated.id, 1, startedAt + 1_000);
    beginWebhookAttempt(store, receipt.id, 2, startedAt + 60_000);
    finishWebhookAttempt(
      store,
      { ...receipt, reason: "authorization_revoked" },
      "ignored",
      startedAt + 61_000,
    );

    const detail = projectWebhookDelivery(store, actor, receipt);
    expect(detail.totalAttempts).toBe(2);
    expect(detail.attemptHistory).toMatchObject([
      {
        number: 1,
        cycleAttempt: 1,
        phase: "task",
        state: "interrupted",
        reason: "intake_processing_interrupted",
        finishedAt: "2026-09-19T08:01:00.000Z",
      },
      {
        number: 2,
        cycleAttempt: 2,
        phase: "authorization",
        state: "ignored",
        reason: "authorization_revoked",
        startedAt: "2026-09-19T08:01:00.000Z",
      },
    ]);
    expect(projectWebhookDelivery(store, actor, unrelated).attemptHistory).toMatchObject([
      { number: 1, state: "processing", finishedAt: null },
    ]);
  });

  it("retains a legacy receipt's attempt count when no historical entries were stored", () => {
    const receipt = staticReceipt("legacy", { attempts: 3 });
    const { store } = harness([receipt]);
    expect(projectWebhookDelivery(store, actor, receipt)).toMatchObject({
      attempts: 3,
      totalAttempts: 3,
      attemptHistory: [],
    });
  });

  it("preserves a legacy attempt total across retry without inventing missing historical details", () => {
    const legacy = staticReceipt("legacy-retried", { attempts: 3 });
    const { store } = harness([legacy]);
    const retried = {
      ...legacy,
      state: "accepted",
      attempts: 0,
      totalAttempts: 3,
      retryGeneration: 1,
      reason: null,
    } as const;
    store.put("idempotency", retried.id, retried);
    expect(projectWebhookDelivery(store, actor, retried)).toMatchObject({
      attempts: 0,
      totalAttempts: 3,
      attemptHistory: [],
    });

    beginWebhookAttempt(store, retried.id, 1, startedAt + 60_000, 4);
    const completed = {
      ...retried,
      state: "completed",
      attempts: 1,
      totalAttempts: 4,
      taskId: "legacy-recovery-task",
    } as const;
    finishWebhookAttempt(store, completed, "completed", startedAt + 61_000);
    store.put("idempotency", completed.id, completed);
    const detail = projectWebhookDelivery(store, actor, completed);
    expect(detail).toMatchObject({ attempts: 1, totalAttempts: 4 });
    expect(detail.attemptHistory).toHaveLength(1);
    expect(detail.attemptHistory[0]).toMatchObject({
      number: 4,
      cycleAttempt: 1,
      state: "completed",
    });
    expect(Value.Check(InvestigationWebhookDeliverySchema, detail)).toBe(true);
  });
});

describe("webhook retry authorization", () => {
  it("ignores lease renewal for versioning but rejects a durable state change", () => {
    const receipt = e2eReceipt("versioned");
    const { store } = harness([receipt]);
    const request = retryRequest(receipt);
    expect(Value.Check(InvestigationWebhookRetryRequestSchema, request)).toBe(true);
    const renewed = {
      ...receipt,
      claim: { ownerId: "replacement-owner", expiresAt: startedAt + 60_000 },
    };
    expect(webhookDeliveryVersion(renewed)).toBe(request.version);
    expect(authorizeWebhookRetry(store, actor, renewed, request).replay).toBe(false);
    for (const changed of [
      { ...receipt, reason: "a_new_failure" },
      { ...receipt, taskId: "committed-task" },
      { ...receipt, state: "completed" as const },
      { ...receipt, retryGeneration: 1 },
    ])
      expectError(
        () => authorizeWebhookRetry(store, actor, changed, request),
        409,
        "webhook_delivery_stale",
      );
  });

  it("does not reuse an old failure version after a retry returns to identical failure fields", () => {
    const original = e2eReceipt("repeated-failure", { retryGeneration: 0 });
    const { store } = harness([original]);
    const oldRequest = retryRequest(original, "first-retry");
    authorizeWebhookRetry(store, actor, original, oldRequest).remember();
    const failedAgain = { ...original, retryGeneration: 1 };
    expect(webhookDeliveryVersion(failedAgain)).not.toBe(oldRequest.version);
    expectError(
      () =>
        authorizeWebhookRetry(store, actor, failedAgain, {
          ...oldRequest,
          idempotencyKey: "new-key",
        }),
      409,
      "webhook_delivery_stale",
    );
    expect(authorizeWebhookRetry(store, actor, failedAgain, oldRequest).replay).toBe(true);
    expect(
      authorizeWebhookRetry(store, actor, failedAgain, retryRequest(failedAgain, "new-key")).replay,
    ).toBe(false);
  });

  it("replays a committed command without requiring the now-obsolete failed state or version", () => {
    const receipt = staticReceipt("replay");
    const { store } = harness([receipt]);
    const request = retryRequest(receipt);
    store.transaction(() => {
      const command = authorizeWebhookRetry(store, actor, receipt, request);
      expect(command.replay).toBe(false);
      command.remember();
      store.put("idempotency", receipt.id, {
        ...receipt,
        state: "accepted",
        attempts: 0,
        reason: null,
      });
    });
    const current = store.get<InvestigationWebhookReceipt>("idempotency", receipt.id)!;
    const replay = authorizeWebhookRetry(store, actor, current, request);
    expect(replay.replay).toBe(true);
    replay.remember();
    expect(store.get("idempotency", receipt.id)).toEqual(current);
    expect(store.countPrefix("idempotency", "webhook:retry:")).toBe(1);
  });

  it("rejects reuse of a retry key for another delivery or version and scopes keys to the operator", () => {
    const receipt = staticReceipt("original");
    const other = staticReceipt("other");
    const { store } = harness([receipt, other]);
    const request = retryRequest(receipt);
    authorizeWebhookRetry(store, actor, receipt, request).remember();
    expectError(
      () => authorizeWebhookRetry(store, actor, other, retryRequest(other)),
      409,
      "webhook_retry_conflict",
    );
    const changed = { ...receipt, reason: "later_failure" };
    expectError(
      () => authorizeWebhookRetry(store, actor, changed, retryRequest(changed)),
      409,
      "webhook_retry_conflict",
    );
    expect(
      authorizeWebhookRetry(store, { ...actor, id: "another-operator" }, other, retryRequest(other))
        .replay,
    ).toBe(false);
  });

  it("rolls back a retry command with its failed requeue transaction", () => {
    const receipt = e2eReceipt("rollback");
    const { store } = harness([receipt]);
    const request = retryRequest(receipt);
    expect(() =>
      store.transaction(() => {
        authorizeWebhookRetry(store, actor, receipt, request).remember();
        store.put("idempotency", receipt.id, { ...receipt, state: "accepted" });
        throw new Error("Synthetic requeue transaction failure");
      }),
    ).toThrow("Synthetic requeue transaction failure");
    expect(store.get("idempotency", receipt.id)).toEqual(receipt);
    expect(authorizeWebhookRetry(store, actor, receipt, request).replay).toBe(false);
  });

  it("requires repository access, management, creation, and E2E execution permission on replay too", () => {
    const receipt = e2eReceipt("permissions");
    const { store } = harness([receipt]);
    const request = retryRequest(receipt);
    authorizeWebhookRetry(store, actor, receipt, request).remember();
    const principals: InvestigationOperatorPrincipal[] = [
      { ...actor, repositoryIds: [otherRepository.id] },
      { ...actor, permissions: [] },
      { ...actor, permissions: ["task:create"] },
      { ...actor, permissions: ["repository:manage"] },
      { ...actor, allowRepositoryExecution: false },
    ];
    for (const principal of principals)
      expectError(
        () => authorizeWebhookRetry(store, principal, receipt, request),
        403,
        "webhook_retry_forbidden",
      );
    const staticFailed = staticReceipt("static-permissions");
    expect(
      authorizeWebhookRetry(
        store,
        { ...actor, allowRepositoryExecution: false },
        staticFailed,
        retryRequest(staticFailed, "static-key"),
      ).replay,
    ).toBe(false);
  });

  it("accepts only failed canonical intakes rather than retrying completed Task results", () => {
    const receipt = e2eReceipt("canonical");
    const { store } = harness([receipt]);
    for (const state of ["accepted", "source_ready", "completed", "ignored"] as const) {
      const unavailable = { ...receipt, state };
      expectError(
        () => authorizeWebhookRetry(store, actor, unavailable, retryRequest(unavailable)),
        409,
        "webhook_retry_unavailable",
      );
    }
    const alias = e2eReceipt("failed-alias", { canonicalReceiptId: receipt.id });
    expectError(
      () => authorizeWebhookRetry(store, actor, alias, retryRequest(alias)),
      409,
      "webhook_retry_unavailable",
    );
    const self = { ...receipt, canonicalReceiptId: receipt.id };
    expect(authorizeWebhookRetry(store, actor, self, retryRequest(self)).replay).toBe(false);
  });

  it("rejects malformed retry commands before reserving their keys", () => {
    const receipt = staticReceipt("invalid-command");
    const { store } = harness([receipt]);
    const valid = retryRequest(receipt);
    for (const request of [
      { ...valid, version: "" },
      { ...valid, version: "a".repeat(129) },
      { ...valid, version: 123 },
      { ...valid, idempotencyKey: " \t\n" },
      { ...valid, idempotencyKey: "a".repeat(129) },
      { ...valid, idempotencyKey: null },
    ]) {
      expect(Value.Check(InvestigationWebhookRetryRequestSchema, request)).toBe(false);
      expectError(
        () =>
          authorizeWebhookRetry(store, actor, receipt, request as InvestigationWebhookRetryRequest),
        400,
        "invalid_webhook_retry",
      );
    }
    expect(store.countPrefix("idempotency", "webhook:retry:")).toBe(0);
  });
});

describe("webhook retry dispatch", () => {
  it("routes each receipt to its own intake with the original principal and command", () => {
    const staticFailed = staticReceipt("static");
    const e2eFailed = e2eReceipt("e2e");
    const { store } = harness([staticFailed, e2eFailed]);
    const staticResult = projectWebhookDelivery(store, actor, {
      ...staticFailed,
      state: "accepted",
    });
    const e2eResult = projectWebhookDelivery(store, actor, { ...e2eFailed, state: "accepted" });
    const retryStatic = vi.fn(() => staticResult);
    const retryE2e = vi.fn(() => e2eResult);
    const controls = new InvestigationWebhookDeliveryControls({
      store,
      intake: { retryReceipt: retryStatic } as unknown as InvestigationWebhookIntake,
      e2eIntake: { retryReceipt: retryE2e } as unknown as InvestigationE2eIntake,
    });
    const staticRequest = retryRequest(staticFailed);
    const e2eRequest = retryRequest(e2eFailed);

    expect(controls.retry(actor, staticFailed.deliveryId, staticRequest)).toBe(staticResult);
    expect(retryStatic).toHaveBeenCalledExactlyOnceWith(
      actor,
      staticFailed.deliveryId,
      staticRequest,
    );
    expect(retryE2e).not.toHaveBeenCalled();
    expect(controls.retry(actor, e2eFailed.deliveryId, e2eRequest)).toBe(e2eResult);
    expect(retryE2e).toHaveBeenCalledExactlyOnceWith(actor, e2eFailed.deliveryId, e2eRequest);
    expect(retryStatic).toHaveBeenCalledTimes(1);
  });

  it.each(["static", "e2e"] as const)(
    "returns 503 for an unavailable %s intake without changing the receipt",
    (mode) => {
      const receipt = mode === "static" ? staticReceipt("unavailable") : e2eReceipt("unavailable");
      const { store, controls } = harness([receipt]);
      expectError(
        () => controls.retry(actor, receipt.deliveryId, retryRequest(receipt)),
        503,
        "webhook_intake_unavailable",
      );
      expect(store.get("idempotency", receipt.id)).toEqual(receipt);
      expect(store.countPrefix("idempotency", "webhook:retry:")).toBe(0);
    },
  );
});
