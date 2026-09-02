import {
  maximumRunCompletionRequestBytes,
  maximumRunCompletionResultUtf8Bytes,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactCompletionPort,
  ArtifactTransactionCoordinatorError,
} from "../../dist/artifacts/index.js";
import type { ServerConfig } from "../../dist/config.js";
import type { DatabaseClient } from "../../dist/database/database-client.js";
import { DatabaseRequestError } from "../../dist/database/errors.js";
import { registerWorkerRoutes } from "../../dist/routes/workers.js";

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
  readonly completeArtifactRun: ReturnType<typeof vi.fn>;
} => {
  const request = vi.fn(async (operation: string) => {
    if (operation === "completeLease" || operation === "failLease") {
      throw terminalError;
    }
    throw new Error(`Unexpected database operation: ${operation}`);
  });
  const completeArtifactRun = vi.fn(async () => {
    throw new Error("Unexpected artifact-backed completion.");
  });
  const app = Fastify({ logger: false });
  registerWorkerRoutes(app, {
    config,
    database: { request } as unknown as DatabaseClient,
    artifactCompletion: {
      completeArtifactRun,
    } satisfies ArtifactCompletionPort,
    shutdownSignal: new AbortController().signal,
  });
  return { app, request, completeArtifactRun };
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

  it.each([{ mode: "result_artifact_v1" }, { artifactId: "artifact-id" }])(
    "rejects the unknown failure field $mode$artifactId before database dispatch",
    async (extra) => {
      const { app, request, completeArtifactRun } = createApp();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/worker/runs/run-attempt-id/fail",
          payload: {
            ...leaseIdentity,
            code: "execution_failed",
            message: "The execution failed.",
            retryable: false,
            ...extra,
          },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          code: "request_validation_failed",
          retryable: false,
        });
        expect(request).not.toHaveBeenCalled();
        expect(completeArtifactRun).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

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

  it("routes the strict artifact completion form through the narrow completion port", async () => {
    const { app, request, completeArtifactRun } = createApp();
    completeArtifactRun.mockResolvedValue({
      jobId: leaseIdentity.jobId,
      runAttemptId: leaseIdentity.runAttemptId,
      jobState: "succeeded",
      runState: "succeeded",
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        payload: {
          ...leaseIdentity,
          artifactId: "artifact-id",
          resultDigest: "a".repeat(64),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        jobId: leaseIdentity.jobId,
        runAttemptId: leaseIdentity.runAttemptId,
        jobState: "succeeded",
        runState: "succeeded",
      });
      expect(request).not.toHaveBeenCalled();
      expect(completeArtifactRun).toHaveBeenCalledWith(
        {
          ...leaseIdentity,
          artifactId: "artifact-id",
          resultDigest: "a".repeat(64),
        },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it.each([
    { extra: { result: {} }, description: "both inline and artifact payloads" },
    { extra: { mode: "result_artifact_v1" }, description: "a caller-selected mode" },
    { extra: { artifactId: undefined }, description: "neither completion form" },
  ])("rejects $description as an invalid completion union", async ({ extra }) => {
    const { app, request, completeArtifactRun } = createApp();
    const payload = {
      ...leaseIdentity,
      artifactId: "artifact-id",
      resultDigest: "a".repeat(64),
      ...extra,
    };
    if ("artifactId" in extra && extra.artifactId === undefined) {
      delete (payload as { artifactId?: unknown }).artifactId;
    }
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
      expect(completeArtifactRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["/api/v1/worker/runs/another-attempt/complete", { resultDigest: "a".repeat(64), result: {} }],
    [
      "/api/v1/worker/runs/another-attempt/fail",
      { code: "failed", message: "The run failed.", retryable: false },
    ],
  ] as const)("rejects a path/body run attempt mismatch for %s", async (path, terminal) => {
    const { app, request, completeArtifactRun } = createApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: path,
        payload: { ...leaseIdentity, ...terminal },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "run_attempt_mismatch", retryable: false });
      expect(request).not.toHaveBeenCalled();
      expect(completeArtifactRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["ARTIFACT_COMPLETION_TERMINAL_CONFLICT", 409, "terminal_submission_conflict"],
    ["ARTIFACT_TRANSACTION_COMPLETION_MODE_MISMATCH", 409, "artifact_completion_mode_mismatch"],
    ["ARTIFACT_TRANSACTION_LEASE_LOST", 409, "lease_lost"],
    ["ARTIFACT_COMPLETION_RESULT_DIGEST_MISMATCH", 400, "result_digest_mismatch"],
    ["ARTIFACT_COMPLETION_RESULT_ENCODING_INVALID", 422, "artifact_result_encoding_invalid"],
    ["ARTIFACT_COMPLETION_RESULT_JSON_INVALID", 422, "artifact_result_json_invalid"],
    ["ARTIFACT_COMPLETION_RESULT_INVALID", 422, "review_result_invalid"],
    ["ARTIFACT_TRANSACTION_STORAGE_INTEGRITY", 503, "artifact_storage_integrity"],
  ] as const)("maps %s to its stable public error", async (code, status, publicCode) => {
    const { app, request, completeArtifactRun } = createApp();
    completeArtifactRun.mockRejectedValue(new ArtifactTransactionCoordinatorError(code));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        payload: {
          ...leaseIdentity,
          artifactId: "artifact-id",
          resultDigest: "a".repeat(64),
        },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code: publicCode, retryable: false });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated terminal body before its content parser runs", async () => {
    const secureConfig: ServerConfig = {
      ...config,
      allowInsecureWorkerAuth: false,
      tls: {},
      workerCertificateBindings: { ["A".repeat(64)]: leaseIdentity.workerNodeId },
    };
    const request = vi.fn(async () => {
      throw new Error("Unexpected database request.");
    });
    const completeArtifactRun = vi.fn(async () => {
      throw new Error("Unexpected artifact completion.");
    });
    const app = Fastify({ logger: false });
    app.removeContentTypeParser("application/json");
    const parser = vi.fn(
      (
        _request: FastifyRequest,
        body: string,
        done: (error: Error | null, value?: unknown) => void,
      ) => done(null, JSON.parse(body)),
    );
    app.addContentTypeParser("application/json", { parseAs: "string" }, parser);
    registerWorkerRoutes(app, {
      config: secureConfig,
      database: { request } as unknown as DatabaseClient,
      artifactCompletion: { completeArtifactRun },
      shutdownSignal: new AbortController().signal,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          ...leaseIdentity,
          resultDigest: "a".repeat(64),
          result: { value: "x".repeat(400_000) },
        }),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "worker_mtls_required", retryable: false });
      expect(parser).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(completeArtifactRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects unauthenticated malformed terminal JSON before parsing", async () => {
    const secureConfig: ServerConfig = {
      ...config,
      allowInsecureWorkerAuth: false,
      tls: {},
      workerCertificateBindings: { ["A".repeat(64)]: leaseIdentity.workerNodeId },
    };
    const request = vi.fn(async () => {
      throw new Error("Unexpected database request.");
    });
    const completeArtifactRun = vi.fn(async () => {
      throw new Error("Unexpected artifact completion.");
    });
    const app = Fastify({ logger: false });
    app.removeContentTypeParser("application/json");
    const parser = vi.fn(
      (
        _request: FastifyRequest,
        body: string,
        done: (error: Error | null, value?: unknown) => void,
      ) => done(null, JSON.parse(body)),
    );
    app.addContentTypeParser("application/json", { parseAs: "string" }, parser);
    registerWorkerRoutes(app, {
      config: secureConfig,
      database: { request } as unknown as DatabaseClient,
      artifactCompletion: { completeArtifactRun },
      shutdownSignal: new AbortController().signal,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/run-attempt-id/complete",
        headers: { "content-type": "application/json" },
        payload: "{",
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "worker_mtls_required", retryable: false });
      expect(parser).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(completeArtifactRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
