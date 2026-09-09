import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../dist/app.js";
import type { ServerConfig } from "../../dist/config.js";
import type { DatabaseClient } from "../../dist/database/database-client.js";
import { registerHealthRoutes } from "../../dist/routes/health.js";
import { createSchedulingTestDatabase } from "../background/scheduling-pump.testing.js";

const createHealthApp = (
  request: ReturnType<typeof vi.fn>,
  serverAdmission: { read(): boolean },
  recoveryMaintenance = false,
): FastifyInstance => {
  const app = Fastify({ logger: false });
  registerHealthRoutes(
    app,
    { request } as unknown as DatabaseClient,
    serverAdmission,
    recoveryMaintenance,
  );
  return app;
};

describe("health routes", () => {
  it("keeps liveness independent from database and admission", async () => {
    const request = vi.fn(async () => {
      throw new Error("Liveness must not touch the database.");
    });
    const read = vi.fn(() => false);
    const app = createHealthApp(request, { read });

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

  it("reports ready only when admission is open and ping succeeds", async () => {
    const request = vi.fn(async () => ({ sqliteVersion: "3.50.4", schemaVersion: 8 }));
    const read = vi.fn(() => true);
    const app = createHealthApp(request, { read });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready", serverTime: expect.any(String) });
      expect(request).toHaveBeenCalledWith("ping", {});
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("returns not_ready during recovery maintenance", async () => {
    const request = vi.fn(async () => ({ sqliteVersion: "3.50.4", schemaVersion: 8 }));
    const read = vi.fn(() => true);
    const app = createHealthApp(request, { read }, true);

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: "not_ready" });
      expect(request).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: "returns false", read: () => false },
    {
      name: "throws",
      read: () => {
        throw new Error("Admission check failed.");
      },
    },
  ])("returns not_ready when admission $name", async ({ read }) => {
    const request = vi.fn(async () => ({ sqliteVersion: "3.50.4", schemaVersion: 8 }));
    const app = createHealthApp(request, { read });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: "not_ready" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns not_ready when ping fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("Database unavailable.");
    });
    const app = createHealthApp(request, { read: () => true });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: "not_ready" });
      expect(request).toHaveBeenCalledWith("ping", {});
    } finally {
      await app.close();
    }
  });
});

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  recoveryMaintenance: false,
  databasePath: "unused.sqlite",
  migrationsDirectory: "unused",
  protocolVersion: "1.0",
  heartbeatIntervalSeconds: 20,
  leaseTtlSeconds: 120,
  leaseReaperIntervalSeconds: 15,
  operatorAuthCleanupIntervalSeconds: 300,
  operatorAuthCleanupBatchSize: 100,
  retryDelaySeconds: 1,
  workerOfflineAfterSeconds: 90,
  maxLongPollSeconds: 30,
  allowInsecureHttp: true,
  tls: undefined,
  github: undefined,
  operatorAuth: undefined,
  dashboardDirectory: undefined,
};

describe("buildApp readiness gating", () => {
  it("keeps health and worker APIs closed when admission is closed", async () => {
    const databaseRequest = vi.fn(async (_operation: string) => ({ sqliteVersion: "3.50.4" }));
    const app = buildApp({
      config,
      database: createSchedulingTestDatabase(databaseRequest),
      shutdownSignal: new AbortController().signal,
      serverAdmission: { read: () => false },
    });

    try {
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      const worker = await app.inject({
        method: "POST",
        url: "/api/v1/worker/instances",
        payload: {},
      });

      expect(ready.statusCode).toBe(503);
      expect(worker.statusCode).toBe(503);
      expect(
        databaseRequest.mock.calls.every(
          ([operation]) =>
            operation === "cleanupExpiredOperatorAuth" || operation === "maintainNotifications",
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
