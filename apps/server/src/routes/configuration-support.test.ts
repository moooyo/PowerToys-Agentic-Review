import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import {
  createConfigurationAuthorization,
  sendConfigurationError,
} from "./configuration-support.js";

const origin = "https://review.example.test";
const sessionToken = "S".repeat(43);
const privateMessage = "/private/evidence/storage-secret: verifier-token-secret";
const apps: FastifyInstance[] = [];

function createApp(error?: Error, readOnly = false) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const session = {
    issuer: "https://identity.example.test",
    subject: "operator-1",
    displayName: "Operator",
    email: "operator@example.test",
    createdAt: "2026-09-07T00:00:00.000Z",
    expiresAt: "2026-09-07T01:00:00.000Z",
  };
  const auth: OperatorAuthRouteService = {
    publicOrigin: origin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: vi.fn(() => undefined),
    startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken, session })),
    completeLogin: vi.fn(async () => {
      throw new Error("The fixture does not complete logins.");
    }),
    getSession: vi.fn(async (token) => (token === sessionToken ? session : null)),
    logout: vi.fn(async () => undefined),
  };
  registerOperatorAuthRoutes(app, auth);
  const authorization = createConfigurationAuthorization(auth, readOnly);
  const request = vi.fn(async () => {
    await Promise.resolve();
    if (error !== undefined) throw error;
    return { available: true };
  });
  app.get(
    "/operator/configuration-read",
    { onRequest: authorization.read },
    async (_request, reply) => {
      try {
        return reply.send(await request());
      } catch (failure) {
        return sendConfigurationError(reply, failure);
      }
    },
  );
  app.post("/operator/configuration-write", { onRequest: authorization.mutate }, async () =>
    request(),
  );
  return { app, request };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const headers = { cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` };

describe("operator configuration error responses", () => {
  it.each([
    "EVIDENCE_VERIFIER_BUSY",
    "EVIDENCE_VERIFIER_TIMEOUT",
    "EVIDENCE_VERIFIER_CANCELLED",
    "EVIDENCE_VERIFIER_UNAVAILABLE",
    "EVIDENCE_VERIFIER_SHUTDOWN",
    "DATABASE_WORKER_SHUTTING_DOWN",
  ])("keeps %s retryable on authenticated reads during recovery maintenance", async (code) => {
    const error = Object.assign(new DatabaseRequestError(privateMessage, code), {
      cause: new Error(privateMessage),
    });
    const { app, request } = createApp(error, true);
    const response = await app.inject({
      method: "GET",
      url: "/operator/configuration-read",
      headers,
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Cookie");
    expect(response.json()).toEqual({
      code: code.toLowerCase(),
      message:
        code === "DATABASE_WORKER_SHUTTING_DOWN"
          ? "The service is shutting down. Retry after the indicated delay."
          : "Evidence verification is temporarily unavailable. Retry after the indicated delay.",
      retryable: true,
    });
    expect(response.body).not.toContain("private/evidence");
    expect(response.body).not.toContain("storage-secret");
    expect(response.body).not.toContain("verifier-token-secret");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["EVIDENCE_INVALID_SNAPSHOT", 400],
    ["EVIDENCE_FILE_UNAVAILABLE", 404],
    ["EVIDENCE_FILE_CHANGED", 409],
    ["EVIDENCE_INTEGRITY_FAILED", 409],
    ["EVIDENCE_SCENARIO_MISMATCH", 409],
    ["EVIDENCE_VERIFIER_PROTOCOL", 503],
    ["EVIDENCE_INVALID", 400],
    ["EVIDENCE_NOT_FOUND", 404],
    ["EVIDENCE_CONFLICT", 409],
    ["EVIDENCE_LEASE_REJECTED", 409],
    ["EVIDENCE_UNAVAILABLE", 503],
  ] as const)(
    "preserves permanent evidence errors on configuration reads: %s",
    async (code, statusCode) => {
      const { app } = createApp(new DatabaseRequestError(privateMessage, code));
      const response = await app.inject({
        method: "GET",
        url: "/operator/configuration-read",
        headers,
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.headers["retry-after"]).toBeUndefined();
      expect(response.json()).toMatchObject({ code: code.toLowerCase(), retryable: false });
      expect(response.body).not.toContain("private/evidence");
      expect(response.body).not.toContain("storage-secret");
    },
  );

  it("does not trust the verifier class retryable flag for an unavailable asset", async () => {
    const failure = Object.assign(
      new DatabaseRequestError(privateMessage, "EVIDENCE_FILE_UNAVAILABLE"),
      {
        retryable: true,
      },
    );
    const { app } = createApp(failure);
    const response = await app.inject({
      method: "GET",
      url: "/operator/configuration-read",
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "evidence_file_unavailable", retryable: false });
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("keeps configuration reads available and rejects recovery mutations before database access", async () => {
    const { app, request } = createApp(undefined, true);
    const read = await app.inject({ method: "GET", url: "/operator/configuration-read", headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ available: true });
    expect(request).toHaveBeenCalledOnce();
    const mutation = await app.inject({
      method: "POST",
      url: "/operator/configuration-write",
      headers: { ...headers, origin },
    });
    expect(mutation.statusCode).toBe(503);
    expect(mutation.json()).toMatchObject({ code: "configuration_read_only", retryable: false });
    expect(mutation.headers["retry-after"]).toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it("authenticates reads before exposing verification availability", async () => {
    const { app, request } = createApp(
      new DatabaseRequestError(privateMessage, "EVIDENCE_VERIFIER_BUSY"),
    );
    const response = await app.inject({ method: "GET", url: "/operator/configuration-read" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "operator_authentication_required",
      retryable: false,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
