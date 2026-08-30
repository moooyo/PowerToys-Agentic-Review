import {
  maximumRunCompletionRequestBytes,
  maximumRunCompletionResultUtf8Bytes,
} from "@agentic-review/contracts";
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

const createApp = (
  terminalError = new DatabaseRequestError(
    "The run attempt already has a different terminal submission.",
    "TERMINAL_SUBMISSION_CONFLICT",
  ),
): {
  readonly app: FastifyInstance;
  readonly request: ReturnType<typeof vi.fn>;
} => {
  const request = vi.fn(async (operation: string) => {
    if (operation === "completeLease" || operation === "failLease") {
      throw terminalError;
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

  it("returns 422 when authoritative review-result validation fails", async () => {
    const { app, request } = createApp(
      new DatabaseRequestError(
        "The review result does not match PrReviewPlanV1Schema.",
        "REVIEW_RESULT_INVALID",
      ),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        payload: {
          ...leaseIdentity,
          resultDigest: "0".repeat(64),
          result: { schemaVersion: "IssueTriageV1" },
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        code: "review_result_invalid",
        message: "The review result does not match PrReviewPlanV1Schema.",
        retryable: false,
      });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized result within the bounded completion request", async () => {
    const { app, request } = createApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        payload: {
          ...leaseIdentity,
          resultDigest: "0".repeat(64),
          result: { value: "x".repeat(maximumRunCompletionResultUtf8Bytes) },
        },
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({
        code: "review_result_too_large",
        message: "The review result exceeds the permitted UTF-8 byte size.",
        retryable: false,
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized completion request before calling the database", async () => {
    const { app, request } = createApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        payload: {
          ...leaseIdentity,
          resultDigest: "0".repeat(64),
          result: { summary: "x".repeat(maximumRunCompletionRequestBytes) },
        },
      });

      expect(response.statusCode).toBe(413);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects deeply nested JSON when result-size serialization cannot complete", async () => {
    const { app, request } = createApp();
    const depth = 20_000;
    const nestedResult = `${"[".repeat(depth)}null${"]".repeat(depth)}`;
    const payload = `{
      "jobId":"${leaseIdentity.jobId}",
      "runAttemptId":"${leaseIdentity.runAttemptId}",
      "workerNodeId":"${leaseIdentity.workerNodeId}",
      "workerInstanceId":"${leaseIdentity.workerInstanceId}",
      "leaseToken":"${leaseIdentity.leaseToken}",
      "leaseGeneration":${leaseIdentity.leaseGeneration},
      "resultDigest":"${"0".repeat(64)}",
      "result":${nestedResult}
    }`;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode).toBe(413);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
