import type {
  InvestigationCommentPublicationSummary,
  InvestigationPublicationRecoveryRequest,
  InvestigationPublicationRecoveryStatus,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationRequestError } from "../../dist/investigation/errors.js";
import type { InvestigationPublicationRecovery } from "../../dist/investigation/publication-recovery.js";
import { registerInvestigationPublicationRecoveryRoutes } from "../../dist/investigation/publication-recovery-http.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";

const taskId = "synthetic-http-recovery-task";
const reportId = "synthetic-http-recovery-report";
const url = `/api/tasks/${taskId}/publication-recovery`;
const at = "2026-10-01T08:00:00.000Z";
const operator: InvestigationOperatorPrincipal = {
  id: "synthetic-http-recovery-operator",
  displayName: "Synthetic recovery operator",
  repositoryIds: ["synthetic-http-recovery-repository"],
  permissions: ["action:prepare", "action:execute"],
  actionCapabilities: ["comment"],
  allowRepositoryExecution: false,
};
const reader: InvestigationOperatorPrincipal = {
  ...operator,
  id: "synthetic-http-recovery-reader",
  permissions: [],
  actionCapabilities: [],
};
const missing: InvestigationPublicationRecoveryStatus = {
  taskId,
  reportId,
  version: "a".repeat(64),
  state: "missing",
  blocker: null,
  publication: null,
  availableActions: ["enqueue"],
};
const publication: InvestigationCommentPublicationSummary = {
  id: `progress-reply:task:${taskId}`,
  version: "b".repeat(64),
  mode: "progress",
  repositoryId: operator.repositoryIds[0]!,
  repositoryFullName: "fixture/recovery-http",
  workItemId: "synthetic-http-recovery-item",
  workItemKind: "pull_request",
  workItemNumber: 7,
  taskId,
  producerTaskKind: "pr-review",
  reportId,
  state: "pending",
  reasonCode: null,
  reason: null,
  requiresAttention: false,
  nextAttemptAt: at,
  lastAttemptAt: null,
  lastConfirmedAt: null,
  externalId: null,
  commentUrl: null,
  availableActions: [],
  createdAt: at,
  updatedAt: at,
};
const existing: InvestigationPublicationRecoveryStatus = {
  ...missing,
  version: "c".repeat(64),
  state: "existing",
  publication,
  availableActions: [],
};
const request: InvestigationPublicationRecoveryRequest = {
  version: missing.version,
  reportId,
  idempotencyKey: "synthetic-http-recovery-command",
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** Route tests use only synthetic service methods and never start a publisher or Worker. */
function harness(readStatus = missing) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof InvestigationRequestError)
      return reply.code(error.statusCode).send({ code: error.code });
    if (error.validation !== undefined) return reply.code(400).send({ code: "invalid_request" });
    return reply.code(500).send({ code: "unexpected_error" });
  });
  const recovery: Pick<InvestigationPublicationRecovery, "read" | "enqueue"> = {
    read: vi.fn<InvestigationPublicationRecovery["read"]>(() => readStatus),
    enqueue: vi.fn<InvestigationPublicationRecovery["enqueue"]>(() => existing),
  };
  const principals = new Map([
    ["operator", operator],
    ["reader", reader],
  ]);
  const authenticateOperator = vi.fn(
    (incoming: FastifyRequest) => principals.get(incoming.headers.authorization ?? "") ?? null,
  );
  registerInvestigationPublicationRecoveryRoutes(app, {
    recovery: recovery as InvestigationPublicationRecovery,
    authenticateOperator,
  });
  const get = (identity?: string) =>
    app.inject({
      method: "GET",
      url,
      ...(identity === undefined ? {} : { headers: { authorization: identity } }),
    });
  const post = (payload: unknown, identity?: string) =>
    app.inject({
      method: "POST",
      url,
      payload: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        ...(identity === undefined ? {} : { authorization: identity }),
      },
    });
  return { app, recovery, authenticateOperator, get, post };
}

describe("saved report publication recovery HTTP routes", () => {
  it("reads status for an authenticated reader without enqueueing publication", async () => {
    const status: InvestigationPublicationRecoveryStatus = {
      ...missing,
      state: "blocked",
      blocker: "permission_denied",
      availableActions: [],
    };
    const h = harness(status);
    const response = await h.get("reader");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(status);
    expect(h.recovery.read).toHaveBeenCalledExactlyOnceWith(reader, taskId);
    expect(h.recovery.enqueue).not.toHaveBeenCalled();
    expect(h.authenticateOperator).toHaveBeenCalledTimes(1);
  });

  it("forwards the exact version, report ID, and idempotency key and responds with 202", async () => {
    const h = harness();
    const response = await h.post(request, "operator");
    expect(response.statusCode, response.body).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(existing);
    expect(h.recovery.enqueue).toHaveBeenCalledExactlyOnceWith(operator, taskId, request);
    expect(h.recovery.read).not.toHaveBeenCalled();
  });

  it.each([undefined, "unknown", "worker"])(
    "rejects unauthenticated GET and POST requests for identity %s",
    async (identity) => {
      const h = harness();
      for (const response of [await h.get(identity), await h.post(request, identity)]) {
        expect(response.statusCode, response.body).toBe(401);
        expect(response.json()).toMatchObject({ code: "operator_authentication_required" });
      }
      expect(h.recovery.read).not.toHaveBeenCalled();
      expect(h.recovery.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "unknown property", payload: { ...request, unexpected: true } },
    { name: "foreign action control", payload: { ...request, action: "sync" } },
    { name: "missing version", payload: { reportId, idempotencyKey: request.idempotencyKey } },
    {
      name: "missing report ID",
      payload: { version: request.version, idempotencyKey: request.idempotencyKey },
    },
    { name: "missing idempotency key", payload: { version: request.version, reportId } },
    { name: "invalid version", payload: { ...request, version: "invalid" } },
    { name: "non-hex version", payload: { ...request, version: "g".repeat(64) } },
    { name: "numeric version", payload: { ...request, version: 1 } },
    { name: "empty report ID", payload: { ...request, reportId: "" } },
    { name: "empty idempotency key", payload: { ...request, idempotencyKey: "" } },
    { name: "whitespace idempotency key", payload: { ...request, idempotencyKey: " \t " } },
    { name: "oversized idempotency key", payload: { ...request, idempotencyKey: "x".repeat(129) } },
  ])("rejects a $name before invoking the recovery service", async ({ payload }) => {
    const h = harness();
    const response = await h.post(payload, "operator");
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect(h.recovery.read).not.toHaveBeenCalled();
    expect(h.recovery.enqueue).not.toHaveBeenCalled();
  });
});
