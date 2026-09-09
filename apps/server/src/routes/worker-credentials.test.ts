import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../dist/database/database-client.js";
import { DatabaseRequestError } from "../../dist/database/errors.js";
import type { OperatorRequestInput } from "../../dist/database/operator-request.js";
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
const revokedWorkerNodeId = "worker:123e4567-e89b-42d3-a456-426614174001";
const fixedToken = `arw1_${"A".repeat(43)}`;
const fixedTokenSha256 = createHash("sha256").update(fixedToken, "ascii").digest("hex");
const credentialUpdatedAt = "2026-09-03T02:00:00.000Z";
const rotationBody = { expectedUpdatedAt: credentialUpdatedAt } as const;

const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "ordinary-user-123",
  displayName: "Ordinary User",
  email: "user@example.com",
  createdAt: "2026-09-03T00:00:00.000Z",
  expiresAt: "2026-09-03T01:00:00.000Z",
};
const sessionActor = { issuer: session.issuer, subject: session.subject };
const operatorCall = (operation: string, input: unknown) =>
  [
    "operatorRequest",
    { context: { kind: "operator", actor: sessionActor }, operation, input },
  ] as const;

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
  permissionFailure?: Error,
): { readonly database: DatabaseClient; readonly request: ReturnType<typeof vi.fn> } => {
  const execute =
    implementation ??
    (async (operation: string, input: unknown) => {
      const workerNodeId = (input as { readonly workerNodeId: string }).workerNodeId;
      if (operation === "createWorkerNodeCredential") {
        return { workerNodeId, authState: "pending" };
      }
      if (operation === "listWorkerNodeCredentials") {
        return { items: [], total: 0 };
      }
      if (operation === "rotateWorkerToken") {
        return { workerNodeId, authState: "active" };
      }
      if (operation === "revokeWorkerToken") {
        return { workerNodeId, authState: "revoked" };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
  const request = vi.fn(async (operation: string, input: OperatorRequestInput) => {
    expect(operation).toBe("operatorRequest");
    expect(input.context).toEqual({ kind: "operator", actor: sessionActor });
    if (input.operation === "operatorCheckPermission") {
      expect(input.input).toEqual({});
      if (permissionFailure !== undefined) throw permissionFailure;
      return { authorized: true };
    }
    return execute(input.operation, input.input);
  });
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
  it("lists pending and revoked credentials without requiring an Origin header", async () => {
    const items = [
      {
        workerNodeId: fixedWorkerNodeId,
        displayName: "Pending Worker",
        authState: "pending",
        createdAt: "2026-09-03T00:00:00.000Z",
        activatedAt: null,
        rotatedAt: null,
        revokedAt: null,
        updatedAt: credentialUpdatedAt,
      },
      {
        workerNodeId: revokedWorkerNodeId,
        displayName: "Revoked Worker",
        authState: "revoked",
        createdAt: "2026-09-03T00:00:00.000Z",
        activatedAt: "2026-09-03T00:30:00.000Z",
        rotatedAt: "2026-09-03T01:00:00.000Z",
        revokedAt: "2026-09-03T01:30:00.000Z",
        updatedAt: "2026-09-03T01:30:00.000Z",
      },
    ] as const;
    const { database, request } = createDatabase(async (operation, input) => {
      expect(operation).toBe("listWorkerNodeCredentials");
      expect(input).toEqual({ offset: 0, limit: 200 });
      return { items, total: items.length };
    });
    const { app } = createApp({ database });

    try {
      const response = await app.inject({
        method: "GET",
        url: WORKER_CREDENTIAL_PATHS.list,
        headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` },
      });

      expect(response.statusCode).toBe(200);
      expectNoStore(response);
      expect(response.json()).toEqual({ items, total: 2 });
      expect(response.body).not.toContain(fixedToken);
      expect(response.body).not.toContain(fixedTokenSha256);
      expect(response.body).not.toContain("tokenSha256");
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, ...operatorCall("operatorCheckPermission", {}));
      expect(request).toHaveBeenNthCalledWith(
        2,
        ...operatorCall("listWorkerNodeCredentials", {
          offset: 0,
          limit: 200,
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("passes strict page and pageSize values to the database", async () => {
    const { database, request } = createDatabase(async (operation, input) => {
      expect(operation).toBe("listWorkerNodeCredentials");
      expect(input).toEqual({ offset: 6, limit: 3, sort: "identity" });
      return { items: [], total: 12 };
    });
    const { app } = createApp({ database });

    try {
      const response = await app.inject({
        method: "GET",
        url: `${WORKER_CREDENTIAL_PATHS.list}?page=3&pageSize=3&sort=identity`,
        headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` },
      });

      expect(response.statusCode).toBe(200);
      expectNoStore(response);
      expect(response.json()).toEqual({ items: [], total: 12 });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["unknown parameter", "?unknown=1"],
    ["repeated page", "?page=1&page=1"],
    ["repeated pageSize", "?pageSize=200&pageSize=200"],
    ["unknown sort", "?sort=updated"],
    ["repeated sort", "?sort=identity&sort=identity"],
    ["encoded sort name", "?%73ort=identity"],
    ["encoded sort value", "?sort=%69dentity"],
    ["empty page", "?page="],
    ["zero page", "?page=0"],
    ["leading-zero page", "?page=01"],
    ["fractional page", "?page=1.0"],
    ["signed page", "?page=%2B1"],
    ["encoded page name", "?%70age=1"],
    ["encoded page value", "?page=%31"],
    ["empty trailing field", "?page=1&"],
    ["oversized pageSize", "?pageSize=201"],
    ["unsafe page", "?page=9007199254740992"],
    ["overflowing offset", "?page=9007199254740991&pageSize=200"],
  ])("rejects a %s list query before database access", async (_name, query) => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });

    try {
      const response = await app.inject({
        method: "GET",
        url: `${WORKER_CREDENTIAL_PATHS.list}${query}`,
        headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` },
      });

      expect(response.statusCode).toBe(400);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "request_validation_failed" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires an authenticated operator session to list credentials", async () => {
    const auth = createAuth(false);
    const { database, request } = createDatabase();
    const { app } = createApp({ auth, database });

    try {
      const response = await app.inject({
        method: "GET",
        url: WORKER_CREDENTIAL_PATHS.list,
      });

      expect(response.statusCode).toBe(401);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "operator_authentication_required" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects unexpected database list fields without exposing them", async () => {
    const { database } = createDatabase(async () => ({
      items: [
        {
          workerNodeId: fixedWorkerNodeId,
          displayName: "Unsafe Worker",
          authState: "pending",
          createdAt: "2026-09-03T00:00:00.000Z",
          activatedAt: null,
          rotatedAt: null,
          revokedAt: null,
          updatedAt: "2026-09-03T00:00:00.000Z",
          token: fixedToken,
          tokenSha256: fixedTokenSha256,
        },
      ],
      total: 1,
    }));
    const { app } = createApp({ database });

    try {
      const response = await app.inject({
        method: "GET",
        url: WORKER_CREDENTIAL_PATHS.list,
        headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` },
      });

      expect(response.statusCode).toBe(503);
      expectNoStore(response);
      expect(response.body).not.toContain(fixedToken);
      expect(response.body).not.toContain(fixedTokenSha256);
    } finally {
      await app.close();
    }
  });

  it("rejects a stored token-shaped display name without reflecting it", async () => {
    const { database } = createDatabase(async () => ({
      items: [
        {
          workerNodeId: fixedWorkerNodeId,
          displayName: `Historic ${fixedToken} Worker`,
          authState: "pending",
          createdAt: "2026-09-03T00:00:00.000Z",
          activatedAt: null,
          rotatedAt: null,
          revokedAt: null,
          updatedAt: "2026-09-03T00:00:00.000Z",
        },
      ],
      total: 1,
    }));
    const { app } = createApp({ database });

    try {
      const response = await app.inject({
        method: "GET",
        url: WORKER_CREDENTIAL_PATHS.list,
        headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` },
      });

      expect(response.statusCode).toBe(503);
      expectNoStore(response);
      expect(response.body).not.toContain(fixedToken);
    } finally {
      await app.close();
    }
  });

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
      expect(request).toHaveBeenNthCalledWith(1, ...operatorCall("operatorCheckPermission", {}));
      expect(request).toHaveBeenNthCalledWith(
        2,
        ...operatorCall("createWorkerNodeCredential", {
          workerNodeId: fixedWorkerNodeId,
          displayName: "Review Worker 1",
          workerTokenSha256: fixedTokenSha256,
          createdByIssuer: session.issuer,
          createdBySubject: session.subject,
        }),
      );
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
          payload: rotationBody,
        });

        expect(response.statusCode).toBe(200);
        expectNoStore(response);
        expect(response.json()).toEqual({
          workerNodeId: fixedWorkerNodeId,
          authState,
          token: fixedToken,
        });
        expect(request).toHaveBeenNthCalledWith(1, ...operatorCall("operatorCheckPermission", {}));
        expect(request).toHaveBeenNthCalledWith(
          2,
          ...operatorCall("rotateWorkerToken", {
            workerNodeId: fixedWorkerNodeId,
            workerTokenSha256: fixedTokenSha256,
            expectedUpdatedAt: credentialUpdatedAt,
            rotatedByIssuer: session.issuer,
            rotatedBySubject: session.subject,
          }),
        );
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
      expect(request).toHaveBeenCalledTimes(4);
      expect(request).toHaveBeenLastCalledWith(
        ...operatorCall("revokeWorkerToken", {
          workerNodeId: fixedWorkerNodeId,
          revokedByIssuer: session.issuer,
          revokedBySubject: session.subject,
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("binds the exact authenticated principal to both the permission check and credential mutation", async () => {
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
      expect(auth.getSession).toHaveBeenCalledExactlyOnceWith(sessionToken, undefined);
      expect(request).toHaveBeenNthCalledWith(1, ...operatorCall("operatorCheckPermission", {}));
      expect(request).toHaveBeenNthCalledWith(
        2,
        ...operatorCall(
          "createWorkerNodeCredential",
          expect.objectContaining({
            createdByIssuer: "https://identity.example.com",
            createdBySubject: "ordinary-user-123",
          }),
        ),
      );
    } finally {
      await app.close();
    }
  });

  it.each([
    { action: "list", method: "GET" as const, url: WORKER_CREDENTIAL_PATHS.list },
    {
      action: "create",
      method: "POST" as const,
      url: WORKER_CREDENTIAL_PATHS.create,
      payload: { displayName: "Denied Worker" },
    },
    {
      action: "rotate",
      method: "POST" as const,
      url: `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
      payload: rotationBody,
    },
    {
      action: "revoke",
      method: "POST" as const,
      url: `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/revoke`,
    },
  ])(
    "rejects non-administrator $action before generating credentials or accessing global inventory",
    async ({ method, url, payload }) => {
      const execute = vi.fn(async () => {
        throw new Error("A denied request must not execute.");
      });
      const { database, request } = createDatabase(
        execute,
        new DatabaseRequestError(
          `Denied ordinary operator for private worker ${fixedWorkerNodeId} with ${fixedToken}.`,
          "PLATFORM_FORBIDDEN",
        ),
      );
      const { app, auth } = createApp({ database });
      try {
        await resetCredentialGeneratorCalls(app);
        const response = await app.inject({
          method,
          url,
          headers: { ...authenticatedHeaders(), "x-operator-subject": "platform-admin" },
          ...(payload === undefined ? {} : { payload }),
        });
        expect(response.statusCode).toBe(403);
        expectNoStore(response);
        expect(response.json()).toMatchObject({ code: "platform_forbidden", retryable: false });
        expect(response.body).not.toContain(fixedToken);
        expect(response.body).not.toContain(fixedWorkerNodeId);
        expect(auth.getSession).toHaveBeenCalledExactlyOnceWith(sessionToken, undefined);
        expect(request).toHaveBeenCalledExactlyOnceWith(
          ...operatorCall("operatorCheckPermission", {}),
        );
        expect(execute).not.toHaveBeenCalled();
        expect(randomBytes).not.toHaveBeenCalled();
        expect(randomUUID).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    ["actor", { displayName: "Worker", actor: { issuer: session.issuer, subject: "admin" } }],
    [
      "audit fields",
      { displayName: "Worker", createdByIssuer: session.issuer, createdBySubject: "admin" },
    ],
  ])(
    "rejects forged %s in credential creation before permission or token generation",
    async (_name, payload) => {
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
        expect(request).not.toHaveBeenCalled();
        expect(randomBytes).not.toHaveBeenCalled();
        expect(randomUUID).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    ["PLATFORM_FORBIDDEN", 403],
    ["PLATFORM_NOT_FOUND", 404],
  ])("withholds a generated token after an opaque %s mutation rejection", async (code, status) => {
    const { database, request } = createDatabase(async () => {
      throw new DatabaseRequestError(
        `Private worker ${fixedWorkerNodeId}: ${fixedToken}`,
        code as string,
      );
    });
    const { app } = createApp({ database });
    try {
      await resetCredentialGeneratorCalls(app);
      const response = await app.inject({
        method: "POST",
        url: WORKER_CREDENTIAL_PATHS.create,
        headers: authenticatedHeaders(),
        payload: { displayName: "Revoked Access Worker" },
      });
      expect(response.statusCode).toBe(status);
      expectNoStore(response);
      expect(response.body).not.toContain(fixedToken);
      expect(response.body).not.toContain(fixedWorkerNodeId);
      expect(request).toHaveBeenCalledTimes(2);
      expect(randomBytes).toHaveBeenCalledTimes(1);
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
    ["token-shaped display name", { displayName: `Worker ${fixedToken} copy` }],
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
    [
      "rotate invalid node",
      "/api/v1/operator/worker-nodes/not-a-worker/token/rotate",
      rotationBody,
    ],
    [
      "rotate missing body",
      `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
      undefined,
    ],
    [
      "rotate unexpected body",
      `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
      { token: fixedToken },
    ],
    [
      "rotate non-canonical timestamp",
      `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
      { expectedUpdatedAt: "2026-09-03T02:00:00Z" },
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
      rotationBody,
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
      rotationBody,
      undefined,
      503,
    ],
  ])(
    "sanitizes %s without exposing generated credentials",
    async (_name, url, payload, code, status) => {
      const { database } = createDatabase(async () => {
        throw code === undefined
          ? new Error(`Database failed while handling ${fixedToken} and ${fixedTokenSha256}.`)
          : new DatabaseRequestError(
              `Database rejected ${fixedToken} with digest ${fixedTokenSha256}.`,
              code,
            );
      });
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
    const { database } = createDatabase(async () => ({
      workerNodeId: fixedWorkerNodeId,
      authState: "revoked",
    }));
    const { app } = createApp({ database });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/operator/worker-nodes/${fixedWorkerNodeId}/token/rotate`,
        headers: authenticatedHeaders(),
        payload: rotationBody,
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
