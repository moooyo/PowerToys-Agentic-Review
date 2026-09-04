import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../dist/app.js";
import type { ServerConfig } from "../dist/config.js";
import type { DatabaseClient } from "../dist/database/database-client.js";
import type { OperatorAuthRouteService } from "../dist/routes/auth.js";
import type { OperatorSession } from "../dist/security/operator-auth.js";

const operatorSession: OperatorSession = {
  issuer: "urn:agentic-review:development",
  subject: "recovery-operator",
  displayName: "Recovery Operator",
  email: null,
  createdAt: "2026-09-04T00:00:00.000Z",
  expiresAt: "2099-09-04T00:00:00.000Z",
};

const operatorService: OperatorAuthRouteService = {
  publicOrigin: "http://127.0.0.1:8080",
  postLoginRedirectPath: "/work-items",
  requiresLoopbackRequest: true,
  secureCookies: false,
  usesBrowserBinding: false,
  ensureBrowserBinding: () => undefined,
  startLogin: async () => ({
    kind: "session",
    sessionToken: Buffer.alloc(32, 7).toString("base64url"),
    session: operatorSession,
  }),
  completeLogin: async () => {
    throw new Error("Unexpected operator login completion.");
  },
  getSession: async () => operatorSession,
  logout: async () => undefined,
};

const baseConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  recoveryMaintenance: true,
  databasePath: "unused.sqlite",
  migrationsDirectory: "unused",
  protocolVersion: "1.0",
  heartbeatIntervalSeconds: 20,
  leaseTtlSeconds: 120,
  leaseReaperIntervalSeconds: 1,
  operatorAuthCleanupIntervalSeconds: 300,
  operatorAuthCleanupBatchSize: 100,
  retryDelaySeconds: 1,
  workerOfflineAfterSeconds: 90,
  maxLongPollSeconds: 30,
  allowInsecureHttp: true,
  tls: undefined,
  github: {
    repositories: [{ githubRepositoryId: 1, fullName: "example/repository" }],
    reviewer: { githubUserId: 1, login: "reviewer" },
    authorizationPolicy: {
      kind: "self_or_allowlist",
      policyVersion: 1,
      schedulingTargetGithubUserId: 1,
      allowlistedActorGithubUserIds: [],
      unknownActorPolicy: "deny",
      newRevisionPolicy: "inherit_authorized_epoch",
    },
    promptDirectory: "/unused/prompts",
    webhook: {
      path: "/api/v1/github/webhook",
      secret: Buffer.from("unused"),
      maxPayloadBytes: 1_024,
    },
    polling: { token: "unused", intervalSeconds: 60 },
  },
  operatorAuth: {
    service: {
      environment: "development",
      publicOrigin: "http://127.0.0.1:8080",
      loginTransactionTtlSeconds: 600,
      sessionTtlSeconds: 28_800,
      postLoginRedirectPath: "/work-items",
      mode: "loopback",
      developmentIdentity: {
        issuer: operatorSession.issuer,
        subject: operatorSession.subject,
        displayName: operatorSession.displayName,
        email: operatorSession.email,
      },
    },
    oidc: undefined,
  },
  dashboardDirectory: undefined,
};

const systemSnapshot = {
  serverVersion: "0.1.0-test",
  protocolVersion: "1.0",
  nodeVersion: "24.20.0",
  sqliteVersion: "3.50.4",
  databaseSizeBytes: 1_024,
  oldestQueuedAt: null,
  activeWorkers: 0,
  activeLeases: 0,
  pendingApprovals: 0,
  health: [],
};

const createDatabaseRequest = () =>
  vi.fn(async (operation: string, input?: Record<string, unknown>) => {
    switch (operation) {
      case "cleanupExpiredOperatorAuth":
        return {
          deletedBrowserFlows: 0,
          deletedLoginTransactions: 0,
          deletedSessions: 0,
          hasMore: false,
        };
      case "reapExpiredLeases":
        return { expiredCount: 0 };
      case "listWorkerNodeCredentials":
        return { items: [], total: 0 };
      case "createWorkerNodeCredential":
        return { workerNodeId: input?.workerNodeId, authState: "pending" };
      case "rotateWorkerToken":
        return { workerNodeId: input?.workerNodeId, authState: "active" };
      case "revokeWorkerToken":
        return { workerNodeId: input?.workerNodeId, authState: "revoked" };
      case "getSystemSnapshot":
        return systemSnapshot;
      default:
        throw new Error(`Unexpected database operation: ${operation}`);
    }
  });

const createDependencies = (
  config: ServerConfig,
  request = createDatabaseRequest(),
  operatorAuth?: OperatorAuthRouteService,
) => ({
  config,
  database: { request } as unknown as DatabaseClient,
  shutdownSignal: new AbortController().signal,
  serverAdmission: { read: () => true },
  ...(operatorAuth === undefined ? {} : { operatorAuth }),
});

const workerRoutes = [
  { method: "POST", url: "/api/v1/worker/instances" },
  { method: "POST", url: "/api/v1/worker/leases/claim" },
  { method: "PUT", url: "/api/v1/worker/instances/instance/heartbeat" },
  { method: "PUT", url: "/api/v1/worker/leases/run/heartbeat" },
  { method: "POST", url: "/api/v1/worker/runs/run/complete" },
  { method: "POST", url: "/api/v1/worker/runs/run/fail" },
] as const;

const settleStartupCleanup = async (request: ReturnType<typeof createDatabaseRequest>) => {
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith("cleanupExpiredOperatorAuth", { batchSize: 100 });
  });
  request.mockClear();
};

describe("recovery maintenance application boundary", () => {
  it("rejects every Worker route before authentication or database work", async () => {
    const request = createDatabaseRequest();
    const futureWorkerHandler = vi.fn(async () => ({ reached: true }));
    const app = buildApp(createDependencies(baseConfig, request));
    app.get("/api/v1/worker/future-route", futureWorkerHandler);

    try {
      await app.ready();
      await settleStartupCleanup(request);

      for (const route of [
        ...workerRoutes,
        { method: "GET", url: "/api/v1/worker/future-route" },
      ]) {
        const response = await app.inject({
          method: route.method,
          url: route.url,
          payload: route.method === "GET" ? undefined : {},
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          code: "worker_api_maintenance",
          message: "Worker API access is disabled during recovery maintenance.",
          retryable: true,
        });
      }

      expect(request).not.toHaveBeenCalled();
      expect(futureWorkerHandler).not.toHaveBeenCalled();

      const webhook = await app.inject({
        method: "POST",
        url: "/api/v1/github/webhook",
        payload: {},
      });
      expect(webhook.statusCode).toBe(404);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps health liveness, operator credentials, and Dashboard reads available locally", async () => {
    const request = createDatabaseRequest();
    const app = buildApp(createDependencies(baseConfig, request, operatorService));

    try {
      await app.ready();
      await settleStartupCleanup(request);
      const headers = { host: "127.0.0.1:8080" };
      const live = await app.inject({ method: "GET", url: "/health/live", headers });
      const ready = await app.inject({ method: "GET", url: "/health/ready", headers });
      const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { ...headers, origin: operatorService.publicOrigin },
      });
      const credentials = await app.inject({
        method: "GET",
        url: "/api/v1/operator/worker-nodes",
        headers,
      });
      const createCredential = await app.inject({
        method: "POST",
        url: "/api/v1/operator/worker-nodes",
        headers: { ...headers, origin: operatorService.publicOrigin },
        payload: { displayName: "Recovered Worker" },
      });
      const workerNodeId = "worker:11111111-1111-4111-8111-111111111111";
      const rotateCredential = await app.inject({
        method: "POST",
        url: `/api/v1/operator/worker-nodes/${workerNodeId}/token/rotate`,
        headers: { ...headers, origin: operatorService.publicOrigin },
        payload: { expectedUpdatedAt: "2026-09-04T00:00:00.000Z" },
      });
      const revokeCredential = await app.inject({
        method: "POST",
        url: `/api/v1/operator/worker-nodes/${workerNodeId}/revoke`,
        headers: { ...headers, origin: operatorService.publicOrigin },
        payload: {},
      });
      const dashboard = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/system",
        headers,
      });

      expect(live.statusCode).toBe(200);
      expect(ready.statusCode).toBe(503);
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ authenticated: true });
      expect(login.statusCode).toBe(303);
      expect(credentials.statusCode).toBe(200);
      expect(credentials.json()).toEqual({ items: [], total: 0 });
      expect(createCredential.statusCode).toBe(201);
      expect(createCredential.json()).toMatchObject({ authState: "pending" });
      expect(rotateCredential.statusCode).toBe(200);
      expect(rotateCredential.json()).toMatchObject({ workerNodeId, authState: "active" });
      expect(revokeCredential.statusCode).toBe(200);
      expect(revokeCredential.json()).toEqual({ workerNodeId, authState: "revoked" });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json()).toEqual(systemSnapshot);
      expect(request).toHaveBeenCalledWith("listWorkerNodeCredentials", {
        offset: 0,
        limit: 200,
      });
      expect(request).toHaveBeenCalledWith("getSystemSnapshot", {});
      expect(request).not.toHaveBeenCalledWith("ping", {});
    } finally {
      await app.close();
    }
  });

  it("suppresses only the lease reaper while maintenance is enabled", async () => {
    vi.useFakeTimers();
    const maintenanceRequest = createDatabaseRequest();
    const normalRequest = createDatabaseRequest();
    const maintenanceApp = buildApp(createDependencies(baseConfig, maintenanceRequest));
    const normalApp = buildApp(
      createDependencies(
        {
          ...baseConfig,
          recoveryMaintenance: false,
          github: undefined,
          operatorAuth: undefined,
        },
        normalRequest,
      ),
    );

    try {
      await Promise.all([maintenanceApp.ready(), normalApp.ready()]);
      maintenanceRequest.mockClear();
      normalRequest.mockClear();
      await vi.advanceTimersByTimeAsync(1_100);

      expect(maintenanceRequest).not.toHaveBeenCalledWith("reapExpiredLeases", expect.anything());
      expect(normalRequest).toHaveBeenCalledWith("reapExpiredLeases", {
        retryDelaySeconds: 1,
        workerOfflineAfterSeconds: 90,
      });
    } finally {
      await Promise.all([maintenanceApp.close(), normalApp.close()]);
      vi.useRealTimers();
    }
  });
});
