import type {
  PublicationControlAction,
  PublicationDelivery,
  PublicationPreview,
  RepositoryPublicationPolicy,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import {
  publicationTestActor as actor,
  createPublicationTestDelivery,
  createPublicationTestIntent,
  publicationTestTime as time,
} from "../database/publication-fixture.testing.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import { registerPublicationRoutes } from "./publications.js";

const origin = "https://review.example.test",
  token = "S".repeat(43);
const intent = createPublicationTestIntent(),
  delivery = createPublicationTestDelivery(intent),
  detail = { schemaVersion: "PublicationDetailV1", intent, delivery };
const repositoryPath = `/api/v1/operator/repositories/${intent.binding.repositoryId}`;
const listPath = `${repositoryPath}/publications`,
  itemPath = `${listPath}/${intent.publicationId}`;
const runPath = `${repositoryPath}/review-runs/${intent.binding.reviewRunId}/publications`;
const policy: RepositoryPublicationPolicy = {
  schemaVersion: "RepositoryPublicationPolicyV1",
  repositoryId: intent.binding.repositoryId,
  version: 1,
  enabled: true,
  updatedAt: time,
  updatedBy: actor,
};
const policyRequest = { changeId: "policy-change", expectedVersion: 0, enabled: true };
const policyEvent = {
  schemaVersion: "RepositoryPublicationPolicyAuditEventV1",
  id: "policy-event",
  repositoryId: intent.binding.repositoryId,
  changeId: policyRequest.changeId,
  actor,
  previousVersion: 0,
  version: 1,
  previousSnapshot: {
    schemaVersion: "RepositoryPublicationPolicyV1",
    repositoryId: intent.binding.repositoryId,
    version: 0,
    enabled: false,
    updatedAt: null,
    updatedBy: null,
  },
  snapshot: policy,
  createdAt: time,
};
const preview: PublicationPreview = {
  schemaVersion: "PublicationPreviewV1",
  publicationId: intent.publicationId,
  rendererVersion: intent.rendererVersion,
  binding: intent.binding,
  target: intent.target,
  payload: intent.payload,
  payloadSha256: intent.payloadSha256,
  semanticSha256: intent.semanticSha256,
  observedAt: time,
  policyVersion: 1,
  publisherAvailability: "available",
  publisherGitHubUserId: intent.publisherGitHubUserId,
  blockers: [],
  canConfirm: true,
  existingIntent: null,
};
const confirm = {
  changeId: intent.confirmationChangeId,
  publicationId: intent.publicationId,
  rendererVersion: intent.rendererVersion,
  expectedSelectedDecisionId: intent.binding.selectedDecisionId,
  expectedSelectedDecisionVersion: 1,
  expectedDecisionContextVersion: 1,
  expectedPolicyVersion: 1,
  expectedPublisherGitHubUserId: intent.publisherGitHubUserId,
  expectedRevisionKey: intent.binding.revisionKey,
  expectedPlanDigest: intent.binding.planDigest,
  expectedResultSetDigest: intent.binding.resultSetDigest,
  expectedPayloadSha256: intent.payloadSha256,
};
const control = {
  changeId: "control-change",
  expectedVersion: 1,
  expectedPayloadSha256: intent.payloadSha256,
};
const page = {
  repositoryId: intent.binding.repositoryId,
  total: 0,
  page: 1,
  pageSize: 20,
  items: [],
};
function controlResponse(action: PublicationControlAction) {
  const next: PublicationDelivery = {
    ...delivery,
    version: 2,
    status: action === "cancel" ? "cancelled" : action === "retry" ? "pending" : "unknown",
    ...(action === "reconcile"
      ? {
          attemptCount: 1,
          failure: { code: "ambiguous_delivery", message: "A prior send has an unknown outcome." },
        }
      : {}),
  };
  return {
    replayed: false,
    change: {
      schemaVersion: "PublicationControlReceiptV1",
      id: "control-event",
      changeId: control.changeId,
      publicationId: intent.publicationId,
      repositoryId: intent.binding.repositoryId,
      action,
      actor,
      previousVersion: 1,
      version: 2,
      payloadSha256: intent.payloadSha256,
      createdAt: time,
      delivery: next,
    },
  };
}
const routes = [
  {
    name: "policy",
    method: "GET",
    url: `${repositoryPath}/publication-policy`,
    operation: "getRepositoryPublicationPolicy",
    output: policy,
    body: undefined,
  },
  {
    name: "policy change",
    method: "PATCH",
    url: `${repositoryPath}/publication-policy`,
    operation: "updateRepositoryPublicationPolicy",
    output: { change: policyEvent, replayed: false },
    body: policyRequest,
  },
  {
    name: "policy history",
    method: "GET",
    url: `${repositoryPath}/publication-policy/activity?page=1&pageSize=20`,
    operation: "listRepositoryPublicationPolicyAudit",
    output: { ...page, total: 1, items: [policyEvent] },
    body: undefined,
  },
  {
    name: "policy event",
    method: "GET",
    url: `${repositoryPath}/publication-policy/activity/policy-event`,
    operation: "getRepositoryPublicationPolicyAudit",
    output: policyEvent,
    body: undefined,
  },
  {
    name: "preview",
    method: "GET",
    url: `${runPath}/preview?decisionId=${intent.binding.selectedDecisionId}`,
    operation: "getPublicationPreview",
    output: preview,
    body: undefined,
  },
  {
    name: "confirm",
    method: "POST",
    url: runPath,
    operation: "confirmPublication",
    output: { intent, replayed: false },
    body: confirm,
  },
  {
    name: "list",
    method: "GET",
    url: `${listPath}?page=1&pageSize=20`,
    operation: "listPublications",
    output: page,
    body: undefined,
  },
  {
    name: "detail",
    method: "GET",
    url: itemPath,
    operation: "getPublication",
    output: detail,
    body: undefined,
  },
  {
    name: "attempts",
    method: "GET",
    url: `${itemPath}/attempts?page=1&pageSize=20`,
    operation: "listPublicationAttempts",
    output: { ...page, publicationId: intent.publicationId },
    body: undefined,
  },
  ...(["cancel", "retry", "reconcile"] as const).map((action) => ({
    name: action,
    method: "POST" as const,
    url: `${itemPath}/${action}`,
    operation: action === "reconcile" ? "requestPublicationReconciliation" : `${action}Publication`,
    output: controlResponse(action),
    body: control,
  })),
] as const;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(
  output: unknown,
  options: { readOnly?: boolean; authenticated?: boolean; failure?: Error } = {},
) {
  const session = {
    ...actor,
    displayName: "Publication operator",
    email: null,
    createdAt: time,
    expiresAt: "2026-09-08T00:00:00.000Z",
  };
  const auth: OperatorAuthRouteService = {
    publicOrigin: origin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: vi.fn(() => undefined),
    startLogin: vi.fn(async () => ({ kind: "session", sessionToken: token, session })),
    completeLogin: vi.fn(async () => {
      throw new Error("No external identity provider is used in route tests.");
    }),
    getSession: vi.fn(async (value) =>
      value === token && options.authenticated !== false ? session : null,
    ),
    logout: vi.fn(async () => undefined),
  };
  const database = createOperatorRouteTestDatabase(actor, async () => {
    if (options.failure) throw options.failure;
    return output;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerPublicationRoutes(app, {
    database: database.database,
    operatorAuth: auth,
    readOnly: options.readOnly,
  });
  return { app, ...database };
}
const headers = () => ({
  host: "review.example.test",
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  origin,
});

describe("publication HTTP boundary", () => {
  it.each(routes)(
    "binds $name to the authenticated operator and exact repository",
    async (route) => {
      const f = fixture(route.output),
        result = await f.app.inject({
          method: route.method,
          url: route.url,
          headers: headers(),
          payload: route.body,
        });
      expect(result.statusCode).toBe(route.operation === "confirmPublication" ? 201 : 200);
      expect(result.json()).toEqual(route.output);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        route.operation,
        expect.objectContaining({ repositoryId: intent.binding.repositoryId, actor }),
      );
      expect(f.transport.mock.calls[0]?.[0]).toBe("operatorRequest");
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.headers.vary).toBe("Cookie");
    },
  );
  it.each(routes)("rejects unauthenticated $name without database work", async (route) => {
    const f = fixture(route.output, { authenticated: false }),
      result = await f.app.inject({
        method: route.method,
        url: route.url,
        headers: headers(),
        payload: route.body,
      });
    expect(result.statusCode).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes.filter((route) => route.method !== "GET"))(
    "blocks cross-origin $name",
    async (route) => {
      const f = fixture(route.output),
        result = await f.app.inject({
          method: route.method,
          url: route.url,
          headers: { ...headers(), origin: "https://unrelated.example.test" },
          payload: route.body,
        });
      expect(result.statusCode).toBe(403);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each(routes.filter((route) => route.method !== "GET"))(
    "blocks $name in recovery read-only mode",
    async (route) => {
      const f = fixture(route.output, { readOnly: true }),
        result = await f.app.inject({
          method: route.method,
          url: route.url,
          headers: headers(),
          payload: route.body,
        });
      expect(result.statusCode).toBe(503);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each(["actor", "body", "event", "target", "token"])(
    "rejects confirmation-supplied %s",
    async (key) => {
      const f = fixture({ intent, replayed: false }),
        result = await f.app.inject({
          method: "POST",
          url: runPath,
          headers: headers(),
          payload: { ...confirm, [key]: "untrusted" },
        });
      expect(result.statusCode).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each([
    "?page=0",
    "?page=10000001",
    "?pageSize=51",
    "?status=ready",
    "?status=pending&status=failed",
    "?actor=untrusted",
  ])("rejects unsupported list query %s", async (query) => {
    const f = fixture(page),
      result = await f.app.inject({ method: "GET", url: listPath + query, headers: headers() });
    expect(result.statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("requires an explicit selected decision for a preview", async () => {
    const f = fixture(preview),
      result = await f.app.inject({ method: "GET", url: `${runPath}/preview`, headers: headers() });
    expect(result.statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("rejects a substituted repository returned by the owner", async () => {
    const f = fixture({ ...policy, repositoryId: "foreign-repository" });
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `${repositoryPath}/publication-policy`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(502);
  });
  it("rejects a corrupted preview payload even when its schema is valid", async () => {
    const f = fixture({
      ...preview,
      payload: { ...preview.payload, body: "A different unapproved body." },
    });
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `${runPath}/preview?decisionId=decision-1`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(502);
  });
  it.each(["actor", "policyVersion", "publisherGitHubUserId", "confirmationChangeId"])(
    "rejects a substituted confirmation receipt %s",
    async (key) => {
      const value =
        key === "actor"
          ? { ...actor, subject: "another-operator" }
          : key.endsWith("Id")
            ? "another-id"
            : 2;
      const f = fixture({ intent: { ...intent, [key]: value }, replayed: false });
      expect(
        (await f.app.inject({ method: "POST", url: runPath, headers: headers(), payload: confirm }))
          .statusCode,
      ).toBe(502);
    },
  );
  it("returns historical exact confirmation replay as 200", async () => {
    const f = fixture({ intent, replayed: true });
    expect(
      (await f.app.inject({ method: "POST", url: runPath, headers: headers(), payload: confirm }))
        .statusCode,
    ).toBe(200);
  });
  it.each([
    ["PLATFORM_FORBIDDEN", 403],
    ["PLATFORM_NOT_FOUND", 404],
    ["PLATFORM_CONFLICT", 409],
  ] as const)("preserves owner authority/error %s", async (code, status) => {
    const f = fixture(detail, {
      failure: new DatabaseRequestError("Scoped operation rejected.", code),
    });
    expect(
      (await f.app.inject({ method: "GET", url: itemPath, headers: headers() })).statusCode,
    ).toBe(status);
  });
  it("does not expose a generic action or a write-capable internal endpoint", async () => {
    const f = fixture({});
    for (const suffix of ["actions", "begin-send", "claim", "complete", "renew"])
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `${itemPath}/${suffix}`,
            headers: headers(),
            payload: control,
          })
        ).statusCode,
      ).toBe(404);
    expect(f.transport).not.toHaveBeenCalled();
  });
});
