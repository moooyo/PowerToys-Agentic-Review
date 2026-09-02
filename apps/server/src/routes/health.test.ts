import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { type AppDependencies, buildApp } from "../../dist/app.js";
import type { ServerConfig } from "../../dist/config.js";
import type { DatabaseClient } from "../../dist/database/database-client.js";
import { type ArtifactReadinessProbe, registerHealthRoutes } from "../../dist/routes/health.js";

const databaseHealth = {
  sqliteVersion: "3.50.4",
  schemaVersion: 11,
};

const createHealthApp = (
  request: ReturnType<typeof vi.fn>,
  artifactReadiness: ArtifactReadinessProbe,
  shutdownSignal: AbortSignal = new AbortController().signal,
): FastifyInstance => {
  const app = Fastify({ logger: false });
  registerHealthRoutes(
    app,
    { request } as unknown as DatabaseClient,
    artifactReadiness,
    shutdownSignal,
  );
  return app;
};

describe("health routes", () => {
  it("keeps liveness independent from database and artifact readiness", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Shutdown should not disable liveness."));
    const request = vi.fn(async () => {
      throw new Error("Database should not be read by liveness.");
    });
    const read = vi.fn(() => {
      throw new Error("Artifact readiness should not be read by liveness.");
    });
    const app = createHealthApp(request, { read }, controller.signal);

    try {
      const response = await app.inject({ method: "GET", url: "/health/live" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ok", serverTime: expect.any(String) });
      expect(request).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reports readiness when both database and artifact storage are ready", async () => {
    const request = vi.fn(async () => databaseHealth);
    const app = createHealthApp(request, { read: () => ({ ready: true }) });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ready",
        serverTime: expect.any(String),
      });
      expect(response.body).not.toContain("sqliteVersion");
      expect(response.body).not.toContain("schemaVersion");
      expect(request).toHaveBeenCalledWith("ping", {});
    } finally {
      await app.close();
    }
  });

  it("checks live artifact readiness before and after a successful database ping", async () => {
    const events: string[] = [];
    const request = vi.fn(async () => {
      events.push("database-ping");
      return databaseHealth;
    });
    const read = vi.fn(() => {
      events.push("artifact-readiness");
      return {
        ready: true,
        health: { rootPath: "/private/artifact-root", capacityBytes: 1n },
      } as unknown as Readonly<{ readonly ready: boolean }>;
    });
    const app = createHealthApp(request, { read });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(200);
      expect(events).toEqual(["artifact-readiness", "database-ping", "artifact-readiness"]);
      expect(response.json()).toEqual({
        status: "ready",
        serverTime: expect.any(String),
      });
      expect(response.body).not.toContain("artifact-root");
      expect(response.body).not.toContain("capacityBytes");
    } finally {
      await app.close();
    }
  });

  it("returns not ready when shutdown begins during the database ping", async () => {
    const controller = new AbortController();
    const pingStarted = Promise.withResolvers<void>();
    const pingResult = Promise.withResolvers<typeof databaseHealth>();
    const request = vi.fn(() => {
      pingStarted.resolve();
      return pingResult.promise;
    });
    const read = vi.fn(() => ({ ready: true }));
    const app = createHealthApp(request, { read }, controller.signal);

    try {
      const responsePromise = app.inject({ method: "GET", url: "/health/ready" });
      await pingStarted.promise;
      controller.abort(new Error("Server shutdown started at /private/runtime-state."));
      pingResult.resolve(databaseHealth);
      const response = await responsePromise;

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: "not_ready",
        serverTime: expect.any(String),
      });
      expect(response.body).not.toContain("private/runtime-state");
      expect(request).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("returns not ready when artifact readiness closes during the database ping", async () => {
    const request = vi.fn(async () => databaseHealth);
    let readCount = 0;
    const read = vi.fn(() => ({ ready: readCount++ === 0 }));
    const app = createHealthApp(request, { read });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(503);
      expect(request).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("does not cache artifact readiness between requests", async () => {
    const request = vi.fn(async () => databaseHealth);
    let ready = true;
    const read = vi.fn(() => ({ ready }));
    const app = createHealthApp(request, { read });

    try {
      const first = await app.inject({ method: "GET", url: "/health/ready" });
      ready = false;
      const second = await app.inject({ method: "GET", url: "/health/ready" });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(503);
      expect(request).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: "reports not ready",
      read: () => ({ ready: false }),
    },
    {
      name: "throws with private details",
      read: () => {
        throw new Error("Artifact failure at /private/artifact-root.");
      },
    },
  ])("returns a detail-free 503 when artifact readiness $name", async ({ read }) => {
    const request = vi.fn(async () => databaseHealth);
    const app = createHealthApp(request, { read });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "not_ready",
        serverTime: expect.any(String),
      });
      expect(response.body).not.toContain("artifact-root");
      expect(response.body).not.toContain("health");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not expose database failure details after the readiness precheck", async () => {
    const request = vi.fn(async () => {
      throw new Error("Database path /private/database is unavailable.");
    });
    const read = vi.fn(() => ({ ready: true }));
    const app = createHealthApp(request, { read });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("private/database");
      expect(read).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  databasePath: "unused.sqlite",
  migrationsDirectory: "unused",
  artifactStorage: {
    rootPath: "/unused/artifacts",
    capacity: {
      hardBytes: 10n * 1_024n * 1_024n,
      hardEntries: 1_000,
      emergencyReserveBytes: 1_024n * 1_024n,
      perUploadMetadataHeadroomBytes: 64n * 1_024n,
      cleanupBacklogHighWaterEntries: 100,
    },
  },
  protocolVersion: "1.0",
  heartbeatIntervalSeconds: 20,
  leaseTtlSeconds: 120,
  leaseReaperIntervalSeconds: 15,
  operatorAuthCleanupIntervalSeconds: 300,
  operatorAuthCleanupBatchSize: 100,
  retryDelaySeconds: 1,
  workerOfflineAfterSeconds: 90,
  maxLongPollSeconds: 30,
  allowInsecureWorkerAuth: true,
  tls: undefined,
  workerCertificateBindings: {},
  github: undefined,
  operatorAuth: undefined,
  dashboardDirectory: undefined,
};

const content = Buffer.from("{}", "utf8");
const contentSha256 = createHash("sha256").update(content).digest("hex");
const uploadId = "10000000-0000-4000-8000-000000000001";
const clientArtifactId = "20000000-0000-4000-8000-000000000002";
const leaseIdentity = {
  jobId: "job-id",
  runAttemptId: "run-attempt-id",
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  leaseToken: "x".repeat(32),
  leaseGeneration: 1,
} as const;

const workerRegistrationPayload = {
  protocolVersion: "1.0",
  workerNodeId: leaseIdentity.workerNodeId,
  workerInstanceId: leaseIdentity.workerInstanceId,
  displayName: "Development Worker",
  workerVersion: "0.1.0-test",
  maxSlots: 1,
  capabilities: {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    codexVersion: "0.1.0-test",
    recipeIds: [],
    labels: {},
  },
} as const;

const createBuildAppDatabaseRequest = (): ReturnType<typeof vi.fn> =>
  vi.fn(async (operation: string) => {
    switch (operation) {
      case "cleanupExpiredOperatorAuth":
        return {
          deletedBrowserFlows: 0,
          deletedLoginTransactions: 0,
          deletedSessions: 0,
          hasMore: false,
        };
      case "registerWorker":
        return {
          workerId: "worker-id",
          status: "online",
          capabilitiesDigest: "0".repeat(64),
        };
      case "ping":
        return databaseHealth;
      default:
        throw new Error(`Unexpected database operation: ${operation}`);
    }
  });

const createBuildAppDependencies = (
  artifactReadiness: ArtifactReadinessProbe = { read: () => ({ ready: true }) },
  serverAdmission: AppDependencies["serverAdmission"] = { read: () => true },
  request: ReturnType<typeof vi.fn> = createBuildAppDatabaseRequest(),
): AppDependencies => {
  return {
    config,
    database: { request } as unknown as DatabaseClient,
    shutdownSignal: new AbortController().signal,
    artifactReadiness,
    serverAdmission,
  };
};

describe("buildApp artifact readiness", () => {
  it("passes the narrow artifact probe through buildApp readiness", async () => {
    const app = buildApp(createBuildAppDependencies({ read: () => ({ ready: false }) }));

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: "not_ready" });
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: "returns false", read: () => false },
    {
      name: "throws with private details",
      read: () => {
        throw new Error("Admission failed at /private/runtime-state.");
      },
    },
  ])("blocks readiness and Worker registration when admission $name", async ({ read }) => {
    const databaseRequest = createBuildAppDatabaseRequest();
    const artifactRead = vi.fn(() => ({ ready: true }));
    const admissionRead = vi.fn(read);
    const app = buildApp(
      createBuildAppDependencies({ read: artifactRead }, { read: admissionRead }, databaseRequest),
    );

    try {
      await app.ready();
      await Promise.resolve();
      databaseRequest.mockClear();

      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      const registration = await app.inject({
        method: "POST",
        url: "/api/v1/worker/instances",
        payload: workerRegistrationPayload,
      });

      for (const response of [ready, registration]) {
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          status: "not_ready",
          serverTime: expect.any(String),
        });
        expect(response.body).not.toContain("private/runtime-state");
      }
      expect(databaseRequest).not.toHaveBeenCalled();
      expect(artifactRead).not.toHaveBeenCalled();
      expect(admissionRead).toHaveBeenCalledTimes(2);

      const live = await app.inject({ method: "GET", url: "/health/live" });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toMatchObject({ status: "ok" });
      expect(databaseRequest).not.toHaveBeenCalled();
      expect(artifactRead).not.toHaveBeenCalled();
      expect(admissionRead).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe("production route inventory", () => {
  it("keeps every artifact route absent with valid development Worker authentication", async () => {
    const app = buildApp(createBuildAppDependencies());
    const routeDefinitions = [
      {
        method: "POST",
        pattern: "/api/v1/worker/runs/:runAttemptId/artifacts",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        payload: {
          ...leaseIdentity,
          clientArtifactId,
          purpose: "result",
          name: "result.json",
          mediaType: "application/json",
          totalBytes: content.byteLength,
          sha256: contentSha256,
        },
      },
      {
        method: "PUT",
        pattern: "/api/v1/worker/artifact-uploads/:uploadId/chunks/:chunkIndex",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        payload: {
          ...leaseIdentity,
          chunkIndex: 0,
          offsetBytes: 0,
          chunkBytes: content.byteLength,
          chunkSha256: contentSha256,
          data: content.toString("base64url"),
        },
      },
      {
        method: "POST",
        pattern: "/api/v1/worker/artifact-uploads/:uploadId/complete",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/complete`,
        payload: {
          ...leaseIdentity,
          chunkCount: 1,
          totalBytes: content.byteLength,
          sha256: contentSha256,
        },
      },
      {
        method: "POST",
        pattern: "/api/v1/worker/artifact-uploads/:uploadId/terminate",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/terminate`,
        payload: {
          ...leaseIdentity,
          state: "abandoned",
          reason: "client_abandoned",
        },
      },
    ] as const;

    try {
      await app.ready();
      const registration = await app.inject({
        method: "POST",
        url: "/api/v1/worker/instances",
        payload: workerRegistrationPayload,
      });
      expect(registration.statusCode).toBe(200);

      const inventory = app.printRoutes();
      expect(inventory).not.toContain("artifact-uploads");
      for (const route of routeDefinitions) {
        expect(app.hasRoute({ method: route.method, url: route.pattern })).toBe(false);
        const response = await app.inject({
          method: route.method,
          url: route.url,
          payload: route.payload,
        });
        expect(response.statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});
