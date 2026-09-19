import type {
  InvestigationWebhookDelivery,
  InvestigationWebhookDeliveryList,
  InvestigationWebhookRetryRequest,
} from "@agentic-review/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import {
  InvestigationE2eIntake,
  type InvestigationE2eReceipt,
} from "../../dist/investigation/e2e-intake.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";
import type { InvestigationWebhookBinding } from "../../dist/investigation/webhook-config.js";
import {
  beginWebhookAttempt,
  finishWebhookAttempt,
  InvestigationWebhookDeliveryControls,
  phaseWebhookAttempt,
  webhookDeliveryVersion,
} from "../../dist/investigation/webhook-delivery-controls.js";
import { registerInvestigationWebhookDeliveryRoutes } from "../../dist/investigation/webhook-delivery-http.js";
import {
  InvestigationWebhookIntake,
  type InvestigationWebhookReceipt,
} from "../../dist/investigation/webhook-intake.js";

type Receipt = InvestigationWebhookReceipt | InvestigationE2eReceipt;
const url = "/api/github/webhook-deliveries";
const repository = { id: "http-repository", fullName: "fixture/http", githubRepositoryId: 101 };
const hiddenRepository = {
  id: "hidden-repository",
  fullName: "fixture/hidden",
  githubRepositoryId: 102,
};
const at = "2026-09-19T08:00:00.000Z";
const now = Date.parse("2026-09-19T08:01:00.000Z");
const operator: InvestigationOperatorPrincipal = {
  id: "http-operator",
  displayName: "Synthetic HTTP operator",
  repositoryIds: [repository.id],
  permissions: ["repository:manage", "task:create"],
  actionCapabilities: [],
  allowRepositoryExecution: true,
};
const resources: {
  app: FastifyInstance;
  store: InvestigationStore;
  intakes: (InvestigationWebhookIntake | InvestigationE2eIntake)[];
}[] = [];

afterEach(async () => {
  for (const { app, store, intakes } of resources.splice(0)) {
    for (const intake of intakes) await intake.stop();
    await app.close();
    store.close();
  }
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
    receivedAt: at,
    pendingId: `webhook:pending:${deliveryId}`,
    assignment: {
      repository,
      kind: "issue",
      number: 7,
      githubWorkItemId: 201,
      actorUserId: 301,
      assigneeUserId: 401,
      updatedAt: at,
    },
    policyDigest: "b".repeat(64),
    state: "failed",
    attempts: 3,
    nextAttemptAt: now,
    source: null,
    taskRequest: null,
    taskId: null,
    reason: "synthetic_intake_failure",
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
    receivedAt: at,
    actorUserId: 301,
    reviewerUserId: 401,
    command: {
      commentId: 501,
      githubIssueId: 202,
      mentionLogin: "fixture-reviewer",
      bodySha256: "d".repeat(64),
    },
    state: "failed",
    reason: "synthetic_intake_failure",
    taskId: null,
    revision: null,
    source: null,
    taskRequest: null,
    admission: null,
    attempts: 3,
    nextAttemptAt: now,
    ...overrides,
  };
}

/** Real intakes remain stopped; every potential upstream operation is a failing synthetic stub. */
function harness(receipts: readonly Receipt[], options: { disabled?: boolean } = {}) {
  const store = new InvestigationStore();
  store.insert("repositories", repository.id, repository);
  store.insert("repositories", hiddenRepository.id, hiddenRepository);
  for (const receipt of receipts) store.insert("idempotency", receipt.id, receipt);
  let bindings: readonly InvestigationWebhookBinding[] = [
    {
      repositoryId: repository.id,
      reviewerUserId: 401,
      allowedActorUserIds: [301],
      assignmentsEnabled: true,
      e2eEnabled: true,
    },
  ];
  const principals = new Map<string, InvestigationOperatorPrincipal>([
    ["operator", operator],
    ["reader", { ...operator, permissions: [] }],
    ["manager", { ...operator, permissions: ["repository:manage"] }],
    ["creator", { ...operator, permissions: ["task:create"] }],
    ["static-operator", { ...operator, allowRepositoryExecution: false }],
    ["foreign-operator", { ...operator, repositoryIds: [hiddenRepository.id] }],
    ["all-repositories", { ...operator, repositoryIds: [repository.id, hiddenRepository.id] }],
  ]);
  const authenticateOperator = (request: FastifyRequest) =>
    principals.get(String(request.headers.authorization ?? "")) ?? null;
  const upstreamOperation = vi.fn(() => {
    throw new Error("Synthetic HTTP intake tests must not contact upstream or execute tasks.");
  });
  const intakes: (InvestigationWebhookIntake | InvestigationE2eIntake)[] = [];
  let controls!: InvestigationWebhookDeliveryControls;
  const app = buildInvestigationApp({
    store,
    authenticateOperator,
    now: () => new Date(now),
    registerIngressRoutes(ingressApp, service) {
      if (options.disabled === true) {
        controls = new InvestigationWebhookDeliveryControls({ store });
      } else {
        const settings = { bindings: () => bindings };
        const intake = new InvestigationWebhookIntake({
          store,
          service,
          config: {
            secret: "synthetic-http-webhook-secret-with-no-live-use",
            maximumPayloadBytes: 1_024 * 1_024,
            bindings,
          },
          settings,
          importer: { importWorkItem: upstreamOperation, verifyAssignment: upstreamOperation },
          now: () => now,
        });
        const e2eIntake = new InvestigationE2eIntake({
          store,
          service,
          settings,
          importer: {
            importWorkItem: upstreamOperation,
            verifyE2eCommand: upstreamOperation,
            readPullRequestRevision: upstreamOperation,
          },
          now: () => now,
        });
        intakes.push(intake, e2eIntake);
        controls = new InvestigationWebhookDeliveryControls({ store, intake, e2eIntake });
      }
      registerInvestigationWebhookDeliveryRoutes(ingressApp, { controls, authenticateOperator });
    },
  });
  resources.push({ app, store, intakes });
  return {
    app,
    store,
    controls,
    upstreamOperation,
    revokeBindings: () => {
      bindings = [];
    },
  };
}

function get(app: FastifyInstance, path = url, principal = "operator") {
  return app.inject({ method: "GET", url: path, headers: { authorization: principal } });
}

function retry(app: FastifyInstance, deliveryId: string, body: unknown, principal = "operator") {
  return app.inject({
    method: "POST",
    url: `${url}/${deliveryId}/retry`,
    payload: JSON.stringify(body),
    headers: { authorization: principal, "content-type": "application/json" },
  });
}

function queryPath(query: Record<string, string>): string {
  return `${url}?${new URLSearchParams(query)}`;
}

describe("webhook delivery HTTP inspection", () => {
  it("applies filters and paginates only inside the authenticated repository and query scope", async () => {
    const issue = staticReceipt("issue");
    const { app, upstreamOperation } = harness([
      issue,
      staticReceipt("static-pr", {
        eventName: "pull_request",
        assignment: { ...issue.assignment, kind: "pull_request", number: 9 },
      }),
      e2eReceipt("newest", { receivedAt: "2026-09-19T08:03:00.000Z" }),
      e2eReceipt("older", { receivedAt: "2026-09-19T08:02:00.000Z" }),
      e2eReceipt("other-number", { number: 10 }),
      e2eReceipt("completed", { state: "completed", taskId: "task-completed", reason: null }),
      e2eReceipt("hidden", {
        repository: hiddenRepository,
        receivedAt: "2026-09-19T08:04:00.000Z",
      }),
    ]);
    const filters = {
      repositoryId: repository.id,
      kind: "pull_request",
      number: "9",
      state: "failed",
      mode: "e2e",
      limit: "1",
    };
    const first = await get(app, queryPath(filters));
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    const firstPage = first.json<InvestigationWebhookDeliveryList>();
    expect(firstPage.items.map((item) => item.deliveryId)).toEqual(["newest"]);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = firstPage.nextCursor!;
    const last = await get(app, queryPath({ ...filters, limit: "2", cursor }));
    expect(last.statusCode).toBe(200);
    expect(last.json()).toMatchObject({ items: [{ deliveryId: "older" }], nextCursor: null });

    const changedFilter = await get(app, queryPath({ ...filters, number: "10", cursor }));
    expect(changedFilter.statusCode).toBe(400);
    expect(changedFilter.json()).toMatchObject({ code: "invalid_webhook_cursor" });
    const changedScope = await get(app, queryPath({ ...filters, cursor }), "all-repositories");
    expect(changedScope.statusCode).toBe(400);
    expect(changedScope.json()).toMatchObject({ code: "invalid_webhook_cursor" });
    const forbidden = await get(app, queryPath({ repositoryId: hiddenRepository.id }));
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "repository_access_denied" });
    const malformed = await get(app, queryPath({ cursor: "not-a-cursor" }));
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "invalid_webhook_cursor" });
    expect(upstreamOperation).not.toHaveBeenCalled();
  });

  it("serializes canonical links and attempt details without exposing raw receipt internals", async () => {
    const canonical = e2eReceipt("canonical", {
      state: "completed",
      taskId: "canonical-task",
      reason: null,
    });
    const alias = e2eReceipt("alias", {
      canonicalReceiptId: canonical.id,
      state: "ignored",
      reason: "already_admitted",
      attempts: 0,
    });
    const { app, store } = harness([canonical, alias]);
    beginWebhookAttempt(store, canonical.id, 1, Date.parse(at));
    phaseWebhookAttempt(store, canonical.id, "task");
    finishWebhookAttempt(store, canonical, "completed", now);

    const response = await get(app, `${url}/canonical`, "reader");
    expect(response.statusCode).toBe(200);
    const detail = response.json<InvestigationWebhookDelivery>();
    expect(detail).toMatchObject({
      deliveryId: "canonical",
      state: "completed",
      taskId: "canonical-task",
      availableActions: [],
      attemptHistory: [{ state: "completed", phase: "task", taskId: "canonical-task" }],
    });
    expect(detail.attemptHistory[0]!.id.length).toBeLessThanOrEqual(128);
    for (const key of ["payloadSha256", "command", "claim", "taskRequest", "source", "repository"])
      expect(detail).not.toHaveProperty(key);
    const aliasResponse = await get(app, `${url}/alias`, "reader");
    expect(aliasResponse.statusCode).toBe(200);
    expect(aliasResponse.json()).toMatchObject({
      deliveryId: "alias",
      canonicalDeliveryId: "canonical",
      state: "ignored",
      taskId: "canonical-task",
      availableActions: [],
    });
    const missing = await get(app, `${url}/missing`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "webhook_delivery_not_found" });
  });

  it("accepts canonical decimal limits and numbers up to the safe-integer boundary", async () => {
    const large = e2eReceipt("large-number", { number: Number.MAX_SAFE_INTEGER });
    const { app, controls } = harness([large, e2eReceipt("ordinary-number")]);
    const list = vi.spyOn(controls, "list");
    const response = await get(
      app,
      queryPath({ number: String(Number.MAX_SAFE_INTEGER), limit: "50" }),
    );
    expect(response.statusCode).toBe(200);
    expect(
      response.json().items.map((item: InvestigationWebhookDelivery) => item.deliveryId),
    ).toEqual(["large-number"]);
    expect(list).toHaveBeenLastCalledWith(operator, { number: Number.MAX_SAFE_INTEGER, limit: 50 });
    const ordinary = await get(app, queryPath({ number: "9", limit: "1" }));
    expect(ordinary.statusCode).toBe(200);
    expect(
      ordinary.json().items.map((item: InvestigationWebhookDelivery) => item.deliveryId),
    ).toEqual(["ordinary-number"]);
    expect(list).toHaveBeenLastCalledWith(operator, { number: 9, limit: 1 });
  });

  it.each(["number", "limit"] as const)(
    "rejects noncanonical or out-of-range %s before invoking controls",
    async (field) => {
      const { app, controls, store } = harness([staticReceipt("numeric")]);
      const list = vi.spyOn(controls, "list");
      const original = store.list("idempotency");
      const values = [
        "",
        "0",
        "-1",
        "+1",
        "01",
        "1.0",
        "1e0",
        "1e2",
        "0x10",
        " 1",
        "1 ",
        "1\n",
        "NaN",
        "Infinity",
        "9007199254740992",
        "99999999999999999",
        ...(field === "limit" ? ["51", "100"] : []),
      ];
      for (const value of values) {
        const response = await get(app, queryPath({ [field]: value }));
        expect(response.statusCode, `${field}=${JSON.stringify(value)}`).toBe(400);
        expect(["invalid_request", "webhook_delivery_query_invalid"]).toContain(
          response.json().code,
        );
      }
      expect(list).not.toHaveBeenCalled();
      expect(store.list("idempotency")).toEqual(original);
    },
  );

  it("rejects duplicate numeric parameters, unsupported filters, and unexpected properties", async () => {
    const { app, controls } = harness([staticReceipt("duplicate-query")]);
    const list = vi.spyOn(controls, "list");
    for (const query of [
      "number=7&number=7",
      "number=7&number=8",
      "limit=1&limit=1",
      "limit=1&limit=2",
      "number=7&limit=1&number=7",
      "state=running",
      "mode=desktop",
      "kind=pr",
      "limit=1&unexpected=true",
    ]) {
      const response = await get(app, `${url}?${query}`);
      expect(response.statusCode, query).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request", retryable: false });
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("requires authentication on list, detail, and retry and enforces repository scope on detail", async () => {
    const receipt = staticReceipt("authentication");
    const { app, store } = harness([receipt]);
    const original = store.list("idempotency");
    const responses = [
      await get(app, url, "anonymous"),
      await get(app, `${url}/${receipt.deliveryId}`, "anonymous"),
      await retry(
        app,
        receipt.deliveryId,
        { version: webhookDeliveryVersion(receipt), idempotencyKey: "auth" },
        "anonymous",
      ),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "operator_authentication_required" });
    }
    const forbidden = await get(app, `${url}/${receipt.deliveryId}`, "foreign-operator");
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "repository_access_denied" });
    expect(store.list("idempotency")).toEqual(original);
  });
});

describe("webhook delivery HTTP retry", () => {
  it.each(["static", "e2e"] as const)(
    "requeues a failed %s intake once and makes command replay read-only",
    async (mode) => {
      const create = mode === "static" ? staticReceipt : e2eReceipt;
      const receipt = create("retry-target");
      const other = create("other-target");
      const { app, store, upstreamOperation } = harness([receipt, other]);
      const before = await get(app, `${url}/${receipt.deliveryId}`);
      expect(before.statusCode).toBe(200);
      const command: InvestigationWebhookRetryRequest = {
        version: before.json<InvestigationWebhookDelivery>().version,
        idempotencyKey: "one-retry-command",
      };
      const response = await retry(app, receipt.deliveryId, command);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const current = response.json<InvestigationWebhookDelivery>();
      expect(current).toMatchObject({
        mode,
        state: "accepted",
        attempts: 0,
        totalAttempts: 3,
        reason: null,
        taskId: null,
        availableActions: [],
        nextAttemptAt: new Date(now).toISOString(),
      });
      expect(current.version).not.toBe(command.version);
      expect(store.get<Receipt>("idempotency", receipt.id)).toMatchObject({
        retryGeneration: 1,
        totalAttempts: 3,
      });
      const pendingPrefix = mode === "static" ? "webhook:pending:" : "e2e:pending:";
      expect(store.countPrefix("idempotency", pendingPrefix)).toBe(1);
      expect(store.countPrefix("idempotency", "webhook:retry:")).toBe(1);
      const persistedAfterRetry = store.list("idempotency");

      const replay = await retry(app, receipt.deliveryId, command);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(current);
      expect(store.list("idempotency")).toEqual(persistedAfterRetry);
      const stale = await retry(app, receipt.deliveryId, {
        ...command,
        idempotencyKey: "another-key",
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "webhook_delivery_stale" });
      const changedCommand = await retry(app, receipt.deliveryId, {
        ...command,
        version: current.version,
      });
      expect(changedCommand.statusCode).toBe(409);
      expect(changedCommand.json()).toMatchObject({ code: "webhook_retry_conflict" });
      const wrongTarget = await retry(app, other.deliveryId, {
        version: webhookDeliveryVersion(other),
        idempotencyKey: command.idempotencyKey,
      });
      expect(wrongTarget.statusCode).toBe(409);
      expect(wrongTarget.json()).toMatchObject({ code: "webhook_retry_conflict" });
      const notFailed = await retry(app, receipt.deliveryId, {
        version: current.version,
        idempotencyKey: "new-command-for-active-intake",
      });
      expect(notFailed.statusCode).toBe(409);
      expect(notFailed.json()).toMatchObject({ code: "webhook_retry_unavailable" });
      expect(store.list("idempotency")).toEqual(persistedAfterRetry);
      expect(store.list("tasks")).toEqual([]);
      expect(upstreamOperation).not.toHaveBeenCalled();
    },
  );

  it.each(["static", "e2e"] as const)(
    "enforces the %s retry permissions before any mutation",
    async (mode) => {
      const receipt = mode === "static" ? staticReceipt("permissions") : e2eReceipt("permissions");
      const { app, store } = harness([receipt]);
      const original = store.list("idempotency");
      for (const principal of [
        "reader",
        "manager",
        "creator",
        "foreign-operator",
        ...(mode === "e2e" ? ["static-operator"] : []),
      ]) {
        const response = await retry(
          app,
          receipt.deliveryId,
          {
            version: webhookDeliveryVersion(receipt),
            idempotencyKey: `denied-${principal}`,
          },
          principal,
        );
        expect(response.statusCode, principal).toBe(403);
        expect(response.json()).toMatchObject({ code: "webhook_retry_forbidden" });
      }
      const readOnly = await get(app, `${url}/${receipt.deliveryId}`, "reader");
      expect(readOnly.statusCode).toBe(200);
      expect(readOnly.json().availableActions).toEqual([]);
      expect(store.list("idempotency")).toEqual(original);
    },
  );

  it("lets an operator without execution permission retry a static intake", async () => {
    const receipt = staticReceipt("static-permission");
    const { app, store } = harness([receipt]);
    const response = await retry(
      app,
      receipt.deliveryId,
      {
        version: webhookDeliveryVersion(receipt),
        idempotencyKey: "static-only-command",
      },
      "static-operator",
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "static", state: "accepted" });
    expect(store.countPrefix("idempotency", "webhook:pending:")).toBe(1);
    expect(store.countPrefix("idempotency", "e2e:pending:")).toBe(0);
  });

  it.each(["static", "e2e"] as const)(
    "rechecks the current repository grant for %s retries",
    async (mode) => {
      const receipt = mode === "static" ? staticReceipt("revoked") : e2eReceipt("revoked");
      const { app, store, revokeBindings } = harness([receipt]);
      const original = store.list("idempotency");
      revokeBindings();
      const response = await retry(app, receipt.deliveryId, {
        version: webhookDeliveryVersion(receipt),
        idempotencyKey: "revoked-command",
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: mode === "static" ? "webhook_authorization_revoked" : "e2e_authorization_revoked",
      });
      expect(store.list("idempotency")).toEqual(original);
    },
  );

  it("rejects malformed command bodies without coercion or intake changes", async () => {
    const receipt = e2eReceipt("invalid-body");
    const { app, store } = harness([receipt]);
    const original = store.list("idempotency");
    const command = { version: webhookDeliveryVersion(receipt), idempotencyKey: "valid-key" };
    for (const body of [
      {},
      { version: command.version },
      { ...command, version: "" },
      { ...command, version: 123 },
      { ...command, version: "a".repeat(129) },
      { ...command, idempotencyKey: 123 },
      { ...command, idempotencyKey: " \t\n" },
      { ...command, idempotencyKey: "a".repeat(129) },
      { ...command, unexpected: true },
    ]) {
      const response = await retry(app, receipt.deliveryId, body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request", retryable: false });
    }
    expect(store.list("idempotency")).toEqual(original);
  });

  it("allows inspection while intake is disabled but rejects retries without mutation", async () => {
    const receipts = [staticReceipt("disabled-static"), e2eReceipt("disabled-e2e")];
    const { app, store, upstreamOperation } = harness(receipts, { disabled: true });
    const original = store.list("idempotency");
    const listing = await get(app);
    expect(listing.statusCode).toBe(200);
    expect(listing.json().items).toHaveLength(2);
    expect(listing.headers["cache-control"]).toBe("no-store");
    for (const receipt of receipts) {
      const detail = await get(app, `${url}/${receipt.deliveryId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ deliveryId: receipt.deliveryId, state: "failed" });
      const forbidden = await retry(
        app,
        receipt.deliveryId,
        {
          version: detail.json<InvestigationWebhookDelivery>().version,
          idempotencyKey: `denied-disabled-${receipt.deliveryId}`,
        },
        "reader",
      );
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ code: "webhook_retry_forbidden", retryable: false });
      const response = await retry(app, receipt.deliveryId, {
        version: detail.json<InvestigationWebhookDelivery>().version,
        idempotencyKey: `disabled-${receipt.deliveryId}`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "webhook_intake_unavailable",
        retryable: true,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(store.list("idempotency")).toEqual(original);
    expect(store.list("tasks")).toEqual([]);
    expect(upstreamOperation).not.toHaveBeenCalled();
  });
});
