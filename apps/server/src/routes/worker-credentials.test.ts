import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../dist/database/database-client.js";
import { DatabaseRequestError } from "../../dist/database/errors.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "../../dist/routes/auth.js";
import {
  registerWorkerCredentialRoutes,
  WORKER_CREDENTIAL_PATHS,
} from "../../dist/routes/worker-credentials.js";
import type { OperatorSession } from "../../dist/security/operator-auth.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn(actual.randomBytes),
    randomUUID: vi.fn(actual.randomUUID),
  };
});

const publicOrigin = "https://review.example.com";
const sessionToken = "S".repeat(43);
const fixedUuid = "123e4567-e89b-42d3-a456-426614174000";
const fixedWorkerNodeId = `worker:${fixedUuid}`;
const fixedToken = `arw1_${"A".repeat(43)}`;
const fixedTokenSha256 = createHash("sha256").update(fixedToken, "ascii").digest("hex");

const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "ordinary-user-123",
  displayName: "Ordinary User",
  email: "user@example.com",
  createdAt: "2026-09-03T00:00:00.000Z",
  expiresAt: "2026-09-03T01:00:00.000Z",
};

const createAuth = (authenticated = true): OperatorAuthRouteService => ({
  publicOrigin,
  postLoginRedirectPath: "/",
  requiresLoopbackRequest: false,
  secureCookies: true,
  usesBrowserBinding: false,
  ensureBrowserBinding: vi.fn(() => undefined),
  startLogin: vi.fn(async () => ({
    kind: "development_session" as const,
    sessionToken,
    session,
  })),
  completeLogin: vi.fn(async () => {
    throw new Error("Not used by worker credential route tests.");
  }),
  getSession: vi.fn(async (token) => (authenticated && token === sessionToken ? session : null)),
  logout: vi.fn(async () => undefined),
});

const createDatabase = (
  implementation?: (operation: string, input: unknown) => Promise<unknown>,
): { readonly database: DatabaseClient; readonly request: ReturnType<typeof vi.fn> } => {
  const request = vi.fn(
    implementation ??
      (async (operation: string, input: unknown) => {
        const workerNodeId = (input as { readonly workerNodeId: string }).workerNodeId;
        if (operation === "createWorkerNodeCredential") {
          return { workerNodeId, authState: "pending" };
        }
        if (operation === "rotateWorkerToken") {
          return { workerNodeId, authState: "active" };
        }
        if (operation === "revokeWorkerToken") {
          return { workerNodeId, authState: "revoked" };
        }
        throw new Error(`Unexpected operation: ${operation}`);
      }),
  );
  return { database: { request } as unknown as DatabaseClient, request };
};

const createApp = (
  options: { readonly auth?: OperatorAuthRouteService; readonly database?: DatabaseClient } = {},
): {
  readonly app: FastifyInstance;
  readonly auth: OperatorAuthRouteService;
  readonly database: DatabaseClient;
} => {
  const auth = options.auth ?? createAuth();
  const database = options.database ?? createDatabase().database;
  const app = Fastify({ logger: false });
  registerOperatorAuthRoutes(app, auth);
  registerWorkerCredentialRoutes(app, { database, operatorAuth: auth });
  return { app, auth, database };
};

const authenticatedHeaders = (origin = publicOrigin): Record<string, string> => ({
  cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}`,
  origin,
});

const expectNoStore = (response: { readonly headers: Record<string, unknown> }): void => {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.pragma).toBe("no-cache");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
};

const resetCredentialGeneratorCalls = async (app: FastifyInstance): Promise<void> => {
  await app.ready();
  vi.mocked(randomBytes).mockClear();
  vi.mocked(randomUUID).mockClear();
};

beforeEach(() => {
  vi.mocked(randomBytes).mockClear().mockReturnValue(Buffer.alloc(32));
  vi.mocked(randomUUID)
    .mockClear()
    .mockReturnValue(fixedUuid as ReturnType<typeof randomUUID>);
});

describe("operator worker credential routes", () => {
  it("creates one pending worker credential and returns the plaintext token only in the response", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });

    try {
      await resetCredentialGeneratorCalls(app);
      const response = await app.inject({
        method: "POST",
        url: WORKER_CREDENTIAL_PATHS.create,
        headers: authenticatedHeaders(),
        payload: { displayName: "Review Worker 1" },
      });

      expect(response.statusCode).toBe(201);
      expectNoStore(response);
      expect(response.json()).toEqual({
        workerNodeId: fixedWorkerNodeId,
        authState: "pending",
        token: fixedToken,
      });
      expect(response.json().workerNodeId).toMatch(
        /^worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(response.json().token).toMatch(/^arw1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
      expect(randomBytes).toHaveBeenCalledWith(32);
      expect(randomBytes).toHaveBeenCalledTimes(1);
      expect(randomUUID).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("createWorkerNodeCredential", {
        workerNodeId: fixedWorkerNodeId,
        displayName: "Review Worker 1",
        workerTokenSha256: fixedTokenSha256,
        createdByIssuer: session.issuer,
        createdBySubject: session.subject,
      });
      expect(JSON.stringify(request.mock.calls)).not.toContain(fixedToken);
    } finally {
      await app.close();
    }
  });

  it.each(["pending", "active"] as const)(
    "rotates a %s credential without changing its state",
    async (authState) => {
      const { database, request } = createDatabase(async (operation, input) => {
        expect(operation).toBe("rotateWorkerToken");
        return {
          workerNodeId: (input as { readonly workerNodeId: string }).workerNodeId,
          authState,
        };
      });
      const { app } = createApp({ database });

      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
          headers: authenticatedHeaders(),
        });

        expect(response.statusCode).toBe(200);
        expectNoStore(response);
        expect(response.json()).toEqual({
          workerNodeId: fixedWorkerNodeId,
          authState,
          token: fixedToken,
        });
        expect(request).toHaveBeenCalledWith("rotateWorkerToken", {
          workerNodeId: fixedWorkerNodeId,
          workerTokenSha256: fixedTokenSha256,
          rotatedByIssuer: session.issuer,
          rotatedBySubject: session.subject,
        });
        expect(JSON.stringify(request.mock.calls)).not.toContain(fixedToken);
      } finally {
        await app.close();
      }
    },
  );

  it("idempotently revokes a credential without returning a token", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/revoke`,
          headers: authenticatedHeaders(),
        });
        expect(response.statusCode).toBe(200);
        expectNoStore(response);
        expect(response.json()).toEqual({ workerNodeId: fixedWorkerNodeId, authState: "revoked" });
        expect(response.body).not.toContain("token");
      }
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith("revokeWorkerToken", {
        workerNodeId: fixedWorkerNodeId,
        revokedByIssuer: session.issuer,
        revokedBySubject: session.subject,
      });
    } finally {
      await app.close();
    }
  });

  it("accepts any authenticated operator identity without a second role check", async () => {
    const auth = createAuth();
    const { database, request } = createDatabase();
    const { app } = createApp({ auth, database });

    try {
      const response = await app.inject({
        method: "POST",
        url: WORKER_CREDENTIAL_PATHS.create,
        headers: authenticatedHeaders(),
        payload: { displayName: "Ordinary User Worker" },
      });

      expect(response.statusCode).toBe(201);
      expect(request).toHaveBeenCalledWith(
        "createWorkerNodeCredential",
        expect.objectContaining({
          createdByIssuer: "https://identity.example.com",
          createdBySubject: "ordinary-user-123",
        }),
      );
    } finally {
      await app.close();
    }
  });

  it.each([
    ["missing", undefined],
    ["different", "https://attacker.example.com"],
    ["non-canonical", `${publicOrigin}/`],
    ["case changed", "https://REVIEW.example.com"],
  ])("rejects a %s Origin before session or database access", async (_name, origin) => {
    const auth = createAuth();
    const { database, request } = createDatabase();
    const { app } = createApp({ auth, database });
    const headers: Record<string, string> = {
      cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}`,
    };
    if (origin !== undefined) headers.origin = origin;

    try {
      const response = await app.inject({
        method: "POST",
        url: WORKER_CREDENTIAL_PATHS.create,
        headers,
        payload: { displayName: "Rejected Worker" },
      });

      expect(response.statusCode).toBe(403);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "invalid_operator_auth_origin" });
      expect(auth.getSession).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects repeated Origin headers even when both values are otherwise valid", async () => {
    const auth = createAuth();
    const { database, request } = createDatabase();
    const { app } = createApp({ auth, database });

    try {
      const response = await app.inject({
        method: "POST",
        url: WORKER_CREDENTIAL_PATHS.create,
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}`,
          origin: [publicOrigin, publicOrigin],
        },
        payload: { displayName: "Rejected Worker" },
      });

      expect(response.statusCode).toBe(403);
      expectNoStore(response);
      expect(auth.getSession).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires an existing operator session before generating credentials", async () => {
    const auth = createAuth(false);
    const { database, request } = createDatabase();
    const { app } = createApp({ auth, database });

    try {
      await resetCredentialGeneratorCalls(app);
      const response = await app.inject({
        method: "POST",
        url: WORKER_CREDENTIAL_PATHS.create,
        headers: authenticatedHeaders(),
        payload: { displayName: "Rejected Worker" },
      });

      expect(response.statusCode).toBe(401);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "operator_authentication_required" });
      expect(randomBytes).not.toHaveBeenCalled();
      expect(randomUUID).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["empty display name", { displayName: "" }],
    ["NUL display name", { displayName: "invalid\0name" }],
    ["oversized display name", { displayName: "x".repeat(513) }],
    ["unknown create field", { displayName: "Worker", token: fixedToken }],
    ["non-object body", ["Worker"]],
  ])("rejects %s without generating or storing a token", async (_name, payload) => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });

    try {
      await resetCredentialGeneratorCalls(app);
      const response = await app.inject({
        method: "POST",
        url: WORKER_CREDENTIAL_PATHS.create,
        headers: authenticatedHeaders(),
        payload,
      });

      expect(response.statusCode).toBe(400);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "request_validation_failed" });
      expect(response.body).not.toContain(fixedToken);
      expect(randomBytes).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects malformed JSON with no-store after authenticating the operator", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });

    try {
      const response = await app.inject({
        method: "POST",
        url: WORKER_CREDENTIAL_PATHS.create,
        headers: { ...authenticatedHeaders(), "content-type": "application/json" },
        payload: "{",
      });

      expect(response.statusCode).toBe(400);
      expectNoStore(response);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["rotate invalid node", "/api/v1/operator/worker-nodes/not-a-worker/token/rotate", undefined],
    [
      "rotate unexpected body",
      `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
      { token: fixedToken },
    ],
    ["revoke invalid node", "/api/v1/operator/worker-nodes/worker:123/revoke", undefined],
    [
      "revoke unexpected body",
      `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/revoke`,
      { reason: "unused" },
    ],
  ])("rejects %s before database access", async (_name, url, payload) => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });

    try {
      await resetCredentialGeneratorCalls(app);
      const response = await app.inject({
        method: "POST",
        url,
        headers: authenticatedHeaders(),
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode).toBe(400);
      expectNoStore(response);
      expect(response.body).not.toContain(fixedToken);
      expect(randomBytes).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    [
      "create conflict",
      WORKER_CREDENTIAL_PATHS.create,
      { displayName: "Conflict Worker" },
      "WORKER_NODE_CREDENTIAL_CONFLICT",
      409,
    ],
    [
      "revoked rotation",
      `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
      undefined,
      "WORKER_NODE_CREDENTIAL_REVOKED",
      409,
    ],
    [
      "missing revocation target",
      `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/revoke`,
      undefined,
      "WORKER_NODE_CREDENTIAL_NOT_FOUND",
      404,
    ],
    [
      "unknown database failure",
      `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
      undefined,
      undefined,
      503,
    ],
  ])(
    "sanitizes %s without exposing generated credentials",
    async (_name, url, payload, code, status) => {
      const request = vi.fn(async () => {
        throw code === undefined
          ? new Error(`Database failed while handling ${fixedToken} and ${fixedTokenSha256}.`)
          : new DatabaseRequestError(
              `Database rejected ${fixedToken} with digest ${fixedTokenSha256}.`,
              code,
            );
      });
      const database = { request } as unknown as DatabaseClient;
      const { app } = createApp({ database });

      try {
        const response = await app.inject({
          method: "POST",
          url,
          headers: authenticatedHeaders(),
          ...(payload === undefined ? {} : { payload }),
        });

        expect(response.statusCode).toBe(status);
        expectNoStore(response);
        expect(response.body).not.toContain(fixedToken);
        expect(response.body).not.toContain(fixedTokenSha256);
      } finally {
        await app.close();
      }
    },
  );

  it("withholds a rotated token unless storage confirms a pending or active state", async () => {
    const request = vi.fn(async () => ({
      workerNodeId: fixedWorkerNodeId,
      authState: "revoked",
    }));
    const database = { request } as unknown as DatabaseClient;
    const { app } = createApp({ database });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
        headers: authenticatedHeaders(),
      });

      expect(response.statusCode).toBe(503);
      expectNoStore(response);
      expect(response.body).not.toContain(fixedToken);
      expect(response.body).not.toContain(fixedTokenSha256);
    } finally {
      await app.close();
    }
  });
});
