import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../dist/config.js";
import type { DatabaseClient } from "../../dist/database/database-client.js";
import { DatabaseRequestError } from "../../dist/database/errors.js";
import { registerWorkerRoutes } from "../../dist/routes/workers.js";

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
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
  allowInsecureWorkerAuth: true,
  tls: undefined,
  workerCertificateBindings: {},
  github: undefined,
  operatorAuth: undefined,
  dashboardDirectory: undefined,
};

const leaseIdentity = {
  jobId: "job-id",
  runAttemptId: "run-attempt-id",
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  leaseToken: "x".repeat(32),
  leaseGeneration: 1,
};

const createApp = (): {
  readonly app: FastifyInstance;
  readonly request: ReturnType<typeof vi.fn>;
} => {
  const request = vi.fn(async (operation: string) => {
    if (operation === "completeLease" || operation === "failLease") {
      throw new DatabaseRequestError(
        "The run attempt already has a different terminal submission.",
        "TERMINAL_SUBMISSION_CONFLICT",
      );
    }
    throw new Error(`Unexpected database operation: ${operation}`);
  });
  const app = Fastify({ logger: false });
  registerWorkerRoutes(app, {
    config,
    database: { request } as unknown as DatabaseClient,
    shutdownSignal: new AbortController().signal,
  });
  return { app, request };
};

describe("Worker terminal routes", () => {
  it.each([
    {
      path: "/api/v1/worker/runs/run-attempt-id/complete",
      body: {
        ...leaseIdentity,
        resultDigest: "0".repeat(64),
        result: { summary: "conflicting result" },
      },
      operation: "completeLease",
    },
    {
      path: "/api/v1/worker/runs/run-attempt-id/fail",
      body: {
        ...leaseIdentity,
        code: "conflicting_failure",
        message: "This failure conflicts with the committed terminal submission.",
        retryable: false,
      },
      operation: "failLease",
    },
  ])(
    "returns an explicit 409 for a conflicting $operation request",
    async ({ path, body, operation }) => {
      const { app, request } = createApp();
      try {
        const response = await app.inject({ method: "POST", url: path, payload: body });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          code: "terminal_submission_conflict",
          message: "The run attempt already has a different terminal submission.",
          retryable: false,
        });
        expect(request).toHaveBeenCalledWith(operation, expect.any(Object));
      } finally {
        await app.close();
      }
    },
  );
});
