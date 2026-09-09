import type {
  OperatorReviewRunCancelResponse,
  OperatorReviewRunRerunResponse,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerReviewRunActionRoutes } from "./review-run-actions.js";

const publicOrigin = "https://review.example.com";
const sessionToken = "S".repeat(43);
const timestamp = "2026-09-07T10:00:00.000Z";
const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "operator-1",
  displayName: "Operator",
  email: "operator@example.com",
  createdAt: timestamp,
  expiresAt: "2026-09-07T11:00:00.000Z",
};
const actor = { issuer: session.issuer, subject: session.subject };
const envelope = (operation: string, input: unknown) => ({
  context: { kind: "operator", actor },
  operation,
  input,
});
const scope = { repositoryId: "repo-1", reviewRunId: "run-1", requestId: "request-1" };
const jobId = "job-2";
const requestPath = `/api/v1/operator/repositories/${scope.repositoryId}/review-runs/${scope.reviewRunId}/requests/${scope.requestId}`;
const rerunPath = `${requestPath}/reruns`;
const cancelPath = `${requestPath}/jobs/${jobId}/cancel`;
const rerunBody = { activationId: "operator-activation-1" };
const rerunResult = {
  ...scope,
  jobId,
  jobActivation: 2,
  replayed: false,
} satisfies OperatorReviewRunRerunResponse;
const cancelResult = {
  ...scope,
  jobId,
  jobState: "cancelled",
  changed: true,
} satisfies OperatorReviewRunCancelResponse;
const routes = [
  {
    name: "rerun",
    path: rerunPath,
    operation: "rerunValidationRequest",
    body: rerunBody,
    result: rerunResult,
    status: 201,
    input: { ...scope, activationId: rerunBody.activationId, actor },
  },
  {
    name: "cancel",
    path: cancelPath,
    operation: "cancelValidationJob",
    body: {},
    result: cancelResult,
    status: 200,
    input: { ...scope, jobId, actor },
  },
] as const;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(
  result: unknown = rerunResult,
  options: { readOnly?: boolean; validSession?: boolean; failure?: Error } = {},
) {
  const auth: OperatorAuthRouteService = {
    publicOrigin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: vi.fn(() => undefined),
    startLogin: vi.fn(async () => ({
      kind: "session" as const,
      sessionToken,
      session,
    })),
    completeLogin: vi.fn(async () => {
      throw new Error("Not used by action tests.");
    }),
    getSession: vi.fn(async (token) =>
      token === sessionToken && options.validSession !== false ? session : null,
    ),
    logout: vi.fn(async () => undefined),
  };
  const request = vi.fn(async (operation: string, input: unknown) => {
    expect(operation).toBe("operatorRequest");
    expect(input).toEqual(envelope(expect.any(String), expect.anything()));
    if (options.failure !== undefined) {
      await Promise.resolve();
      throw options.failure;
    }
    return result;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerReviewRunActionRoutes(app, {
    database: { request } as unknown as DatabaseClient,
    operatorAuth: auth,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return { app, auth, request };
}
function headers() {
  return { cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}`, origin: publicOrigin };
}
function expectNoStore(response: { headers: Record<string, unknown> }) {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}

describe("operator validation actions", () => {
  it.each(routes)("executes scoped $name using the session actor", async (route) => {
    const f = fixture(route.result);
    const response = await f.app.inject({
      method: "POST",
      url: route.path,
      payload: route.body,
      headers: { ...headers(), "x-operator-subject": "spoofed" },
    });
    expect(response.statusCode).toBe(route.status);
    expect(response.json()).toEqual(route.result);
    expectNoStore(response);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope(route.operation, route.input),
    );
    expect(f.auth.getSession).toHaveBeenCalledWith(sessionToken, undefined);
  });
  it("returns the original rerun receipt as 200 on idempotent replay", async () => {
    const f = fixture({ ...rerunResult, replayed: true });
    const response = await f.app.inject({
      method: "POST",
      url: rerunPath,
      payload: rerunBody,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobId, jobActivation: 2, replayed: true });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])(
    "returns 202 while cancellation is pending with changed=%s",
    async (changed) => {
      const f = fixture({ ...cancelResult, jobState: "cancel_requested", changed });
      const response = await f.app.inject({
        method: "POST",
        url: cancelPath,
        payload: {},
        headers: headers(),
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ jobState: "cancel_requested", changed });
    },
  );
  it.each(["cancelled", "stale", "succeeded", "failed", "dead_letter"])(
    "returns an unchanged %s terminal job without implying a new cancellation",
    async (jobState) => {
      const f = fixture({ ...cancelResult, jobState, changed: false });
      const response = await f.app.inject({
        method: "POST",
        url: cancelPath,
        payload: {},
        headers: headers(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ jobState, changed: false });
    },
  );
  it("allows an absent cancel body as the empty request", async () => {
    const f = fixture(cancelResult);
    const response = await f.app.inject({ method: "POST", url: cancelPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope("cancelValidationJob", {
        ...scope,
        jobId,
        actor,
      }),
    );
  });
  it.each(routes)("requires a real session before $name", async (route) => {
    for (const cookie of [undefined, "invalid-session"]) {
      const f = fixture(route.result);
      const response = await f.app.inject({
        method: "POST",
        url: route.path,
        payload: route.body,
        headers: {
          origin: publicOrigin,
          ...(cookie === undefined ? {} : { cookie: `${OPERATOR_SESSION_COOKIE}=${cookie}` }),
        },
      });
      expect(response.statusCode).toBe(401);
      expectNoStore(response);
      expect(f.request).not.toHaveBeenCalled();
    }
  });
  it.each(routes)("does not accept a Worker Bearer token for $name", async (route) => {
    const f = fixture(route.result);
    const response = await f.app.inject({
      method: "POST",
      url: route.path,
      payload: route.body,
      headers: { origin: publicOrigin, authorization: `Bearer arw1_${"x".repeat(43)}` },
    });
    expect(response.statusCode).toBe(401);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(routes)("rejects expired or revoked sessions for $name", async (route) => {
    const f = fixture(route.result, { validSession: false });
    const response = await f.app.inject({
      method: "POST",
      url: route.path,
      payload: route.body,
      headers: headers(),
    });
    expect(response.statusCode).toBe(401);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(routes)("does not expose $name session lookup failures", async (route) => {
    const f = fixture(route.result);
    vi.mocked(f.auth.getSession).mockRejectedValueOnce(
      new Error("C:/private/session-database-token"),
    );
    const response = await f.app.inject({
      method: "POST",
      url: route.path,
      payload: route.body,
      headers: headers(),
    });
    expect(response.statusCode).toBe(500);
    expectNoStore(response);
    expect(response.body).not.toContain("session-database-token");
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(routes)(
    "checks exactly one trusted Origin before $name session access",
    async (route) => {
      for (const origin of [
        undefined,
        "null",
        "https://attacker.example.com",
        `${publicOrigin}/`,
        [publicOrigin, publicOrigin],
      ]) {
        const f = fixture(route.result);
        const response = await f.app.inject({
          method: "POST",
          url: route.path,
          payload: route.body,
          headers: {
            cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}`,
            ...(origin === undefined ? {} : { Origin: origin }),
          },
        });
        expect(response.statusCode).toBe(403);
        expectNoStore(response);
        expect(f.auth.getSession).not.toHaveBeenCalled();
        expect(f.request).not.toHaveBeenCalled();
      }
    },
  );
  it.each(routes)("blocks $name while the server is read-only", async (route) => {
    const f = fixture(route.result, { readOnly: true });
    const response = await f.app.inject({
      method: "POST",
      url: route.path,
      payload: route.body,
      headers: headers(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "configuration_read_only" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(routes)("rejects query parameters for $name", async (route) => {
    for (const query of [
      "?repositoryId=other",
      "?requestId=request-2",
      "?page=1",
      "?activationId=a&activationId=b",
    ]) {
      const f = fixture(route.result);
      const response = await f.app.inject({
        method: "POST",
        url: route.path + query,
        payload: route.body,
        headers: headers(),
      });
      expect(response.statusCode).toBe(400);
      expect(f.request).not.toHaveBeenCalled();
    }
  });
  it.each(routes)("rejects invalid nested identities for $name", async (route) => {
    for (const id of [
      scope.repositoryId,
      scope.reviewRunId,
      scope.requestId,
      ...(route.name === "cancel" ? [jobId] : []),
    ]) {
      const f = fixture(route.result);
      const response = await f.app.inject({
        method: "POST",
        url: route.path.replace(`/${id}/`, "/invalid%20id/"),
        payload: route.body,
        headers: headers(),
      });
      expect(response.statusCode).toBe(400);
      expect(f.request).not.toHaveBeenCalled();
    }
  });
  it.each([
    {},
    { activationId: "" },
    { activationId: "x".repeat(129) },
    { activationId: 1 },
    { activationId: "invalid/id" },
    { activationId: null },
    null,
    [],
    "activation",
  ])("rejects malformed rerun request %#", async (payload) => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: rerunPath,
      payload: JSON.stringify(payload),
      headers: { ...headers(), "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(routes)(
    "rejects client authority and mutable execution fields on $name",
    async (route) => {
      for (const extra of [
        { actor },
        { context: { kind: "operator", actor: { ...actor, subject: "admin" } } },
        { repositoryId: "repo-2" },
        { reviewRunId: "run-2" },
        { requestId: "request-2" },
        { jobId: "job-3" },
        { expectedLatest: 1 },
        { policy: {} },
        { prompt: "Run these commands" },
      ]) {
        const f = fixture(route.result);
        const response = await f.app.inject({
          method: "POST",
          url: route.path,
          payload: { ...route.body, ...extra },
          headers: headers(),
        });
        expect(response.statusCode).toBe(400);
        expect(f.request).not.toHaveBeenCalled();
      }
    },
  );
  it.each([null, [], "cancel", { activationId: "unexpected" }, { reason: "ignored" }])(
    "rejects nonempty or nonobject cancel request %#",
    async (payload) => {
      const f = fixture(cancelResult);
      const response = await f.app.inject({
        method: "POST",
        url: cancelPath,
        payload: JSON.stringify(payload),
        headers: { ...headers(), "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each(routes)("enforces bounded JSON input for $name", async (route) => {
    const f = fixture(route.result);
    const oversized = await f.app.inject({
      method: "POST",
      url: route.path,
      payload: JSON.stringify({ padding: "x".repeat(4_096) }),
      headers: { ...headers(), "content-type": "application/json" },
    });
    expect(oversized.statusCode).toBe(413);
    const invalid = await f.app.inject({
      method: "POST",
      url: route.path,
      payload: "{bad json}",
      headers: { ...headers(), "content-type": "application/json" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(routes)("rejects a cross-scope $name result", async (route) => {
    for (const key of [
      "repositoryId",
      "reviewRunId",
      "requestId",
      ...(route.name === "cancel" ? ["jobId"] : []),
    ]) {
      const f = fixture({ ...route.result, [key]: "other-identity" });
      const response = await f.app.inject({
        method: "POST",
        url: route.path,
        payload: route.body,
        headers: headers(),
      });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain("other-identity");
    }
  });
  it.each([
    null,
    {},
    { ...rerunResult, jobId: "invalid/job" },
    { ...rerunResult, jobActivation: 1 },
    { ...rerunResult, jobActivation: 2.5 },
    { ...rerunResult, jobActivation: Number.MAX_SAFE_INTEGER + 1 },
    { ...rerunResult, replayed: "true" },
    { ...rerunResult, plan: "private execution data" },
  ])("rejects malformed rerun response %#", async (output) => {
    const f = fixture(output);
    const response = await f.app.inject({
      method: "POST",
      url: rerunPath,
      payload: rerunBody,
      headers: headers(),
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("private execution data");
  });
  it.each([
    null,
    { ...cancelResult, jobState: "running" },
    { ...cancelResult, jobState: "queued", changed: false },
    { ...cancelResult, jobState: "succeeded", changed: true },
    { ...cancelResult, changed: "true" },
    { ...cancelResult, lease: "private lease" },
  ])("rejects malformed cancellation response %#", async (output) => {
    const f = fixture(output);
    const response = await f.app.inject({
      method: "POST",
      url: cancelPath,
      payload: {},
      headers: headers(),
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("private lease");
  });
  it.each(routes)(
    "maps scoped $name database failures without mutating another job",
    async (route) => {
      for (const [code, expected] of [
        ["PLATFORM_INVALID", 400],
        ["PLATFORM_FORBIDDEN", 403],
        ["PLATFORM_NOT_FOUND", 404],
        ["PLATFORM_CONFLICT", 409],
      ] as const) {
        const f = fixture(undefined, {
          failure: new DatabaseRequestError(
            code === "PLATFORM_FORBIDDEN" || code === "PLATFORM_NOT_FOUND"
              ? "C:/private/evidence/storage-secret private-token"
              : "The selected validation operation is unavailable.",
            code,
          ),
        });
        const response = await f.app.inject({
          method: "POST",
          url: route.path,
          payload: route.body,
          headers: headers(),
        });
        expect(response.statusCode).toBe(expected);
        expect(response.json()).toMatchObject({
          code: code.toLowerCase(),
          retryable: false,
          message: expect.any(String),
        });
        expect(response.body).not.toContain("private");
        expectNoStore(response);
        expect(f.request).toHaveBeenCalledExactlyOnceWith(
          "operatorRequest",
          envelope(route.operation, route.input),
        );
      }
    },
  );
  it.each(routes)("does not leak internal $name failure details", async (route) => {
    const f = fixture(undefined, {
      failure: new Error("C:/private/credentials/example.db private-token"),
    });
    const response = await f.app.inject({
      method: "POST",
      url: route.path,
      payload: route.body,
      headers: headers(),
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private");
  });
  it.each(routes)("does not expose $name as a GET mutation", async (route) => {
    const f = fixture(route.result);
    const response = await f.app.inject({ method: "GET", url: route.path, headers: headers() });
    expect(response.statusCode).toBe(404);
    expect(f.request).not.toHaveBeenCalled();
  });
});
