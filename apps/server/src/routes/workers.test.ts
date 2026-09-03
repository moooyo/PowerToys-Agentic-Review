import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  allowInsecureHttp: true,
  tls: undefined,
  github: undefined,
  operatorAuth: undefined,
  dashboardDirectory: undefined,
};

const workerToken = `arw1_${Buffer.alloc(32, 9).toString("base64url")}`;

const leaseIdentity = {
  jobId: "job-id",
  runAttemptId: "run-attempt-id",
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  leaseToken: "x".repeat(32),
  leaseGeneration: 1,
};

const workerRegistrationPayload = {
  protocolVersion: "1.0",
  workerNodeId: leaseIdentity.workerNodeId,
  workerInstanceId: leaseIdentity.workerInstanceId,
  displayName: "Worker node",
  workerVersion: "1.0.0",
  maxSlots: 1,
  capabilities: {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    codexVersion: "1.0.0",
    recipeIds: [],
    labels: {},
  },
} as const;

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
  app.addHook("onRequest", async (incomingRequest) => {
    incomingRequest.headers.authorization ??= `Bearer ${workerToken}`;
  });
  registerWorkerRoutes(app, {
    config,
    database: {
      request: vi.fn(async (operation: string, input: unknown) =>
        operation === "authenticateWorkerToken"
          ? {
              outcome: "authenticated",
              workerNodeId: leaseIdentity.workerNodeId,
              authState: "active",
            }
          : request(operation, input),
      ),
    } as unknown as DatabaseClient,
    artifactCompletion: {
      completeArtifactRun,
    } satisfies ArtifactCompletionPort,
    shutdownSignal: new AbortController().signal,
  });
  return { app, request, completeArtifactRun };
};

describe("Worker terminal routes", () => {
  it("uses a pending token to atomically register its database-mapped Worker node", async () => {
    const request = vi.fn(async (operation: string, _input: unknown) => {
      if (operation === "authenticateWorkerToken") {
        return {
          outcome: "authenticated" as const,
          workerNodeId: leaseIdentity.workerNodeId,
          authState: "pending" as const,
        };
      }
      if (operation === "registerWorker") {
        return {
          workerId: "worker-id",
          status: "online" as const,
          capabilitiesDigest: "a".repeat(64),
        };
      }
      throw new Error(`Unexpected database operation: ${operation}`);
    });
    const app = Fastify({ logger: false });
    registerWorkerRoutes(app, {
      config,
      database: { request } as unknown as DatabaseClient,
      artifactCompletion: {
        completeArtifactRun: vi.fn(async () => {
          throw new Error("Unexpected artifact completion.");
        }),
      },
      shutdownSignal: new AbortController().signal,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/instances",
        headers: { authorization: `Bearer ${workerToken}` },
        payload: workerRegistrationPayload,
      });

      expect(response.statusCode).toBe(200);
      expect(request).toHaveBeenNthCalledWith(1, "authenticateWorkerToken", {
        workerTokenSha256: createHash("sha256").update(workerToken, "ascii").digest("hex"),
      });
      expect(request).toHaveBeenNthCalledWith(
        2,
        "registerWorker",
        expect.objectContaining({
          workerNodeId: leaseIdentity.workerNodeId,
          workerTokenSha256: createHash("sha256").update(workerToken, "ascii").digest("hex"),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("maps an unavailable atomic registration recheck to the authentication 503", async () => {
    const request = vi.fn(async (operation: string) => {
      if (operation === "authenticateWorkerToken") {
        return {
          outcome: "authenticated" as const,
          workerNodeId: leaseIdentity.workerNodeId,
          authState: "pending" as const,
        };
      }
      throw new Error("private database failure");
    });
    const app = Fastify({ logger: false });
    registerWorkerRoutes(app, {
      config,
      database: { request } as unknown as DatabaseClient,
      artifactCompletion: {
        completeArtifactRun: vi.fn(async () => {
          throw new Error("Unexpected artifact completion.");
        }),
      },
      shutdownSignal: new AbortController().signal,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/instances",
        headers: { authorization: `Bearer ${workerToken}` },
        payload: workerRegistrationPayload,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "worker_authentication_unavailable",
        message: "Worker authentication is temporarily unavailable.",
        retryable: true,
      });
      expect(response.body).not.toContain("private database failure");
    } finally {
      await app.close();
    }
  });

  it("pins authentication hooks on every Worker and artifact route", async () => {
    const workerSource = await readFile(new URL("./workers.ts", import.meta.url), "utf8");
    const artifactSource = await readFile(
      new URL("./worker-artifacts.ts", import.meta.url),
      "utf8",
    );

    expect(workerSource.match(/\bonRequest:/gu)).toHaveLength(6);
    expect(workerSource.match(/\bpreValidation:/gu)).toHaveLength(6);
    expect(artifactSource.match(/\bonRequest:/gu)).toHaveLength(4);
    expect(artifactSource.match(/\bpreValidation:/gu)).toHaveLength(4);
    expect(workerSource).not.toContain("createWorkerAuthenticationPreHandler");
  });

  it.each([
    ["POST", "/api/v1/worker/instances"],
    ["POST", "/api/v1/worker/leases/claim"],
    ["PUT", "/api/v1/worker/instances/worker-instance/heartbeat"],
    ["PUT", "/api/v1/worker/leases/run-attempt-id/heartbeat"],
    ["POST", "/api/v1/worker/runs/run-attempt-id/complete"],
    ["POST", "/api/v1/worker/runs/run-attempt-id/fail"],
  ] as const)("authenticates %s %s before body validation", async (method, url) => {
    const request = vi.fn(async () => {
      throw new Error("Unexpected database request.");
    });
    const completeArtifactRun = vi.fn(async () => {
      throw new Error("Unexpected artifact completion.");
    });
    const app = Fastify({ logger: false });
    registerWorkerRoutes(app, {
      config,
      database: { request } as unknown as DatabaseClient,
      artifactCompletion: { completeArtifactRun },
      shutdownSignal: new AbortController().signal,
    });
    try {
      const response = await app.inject({ method, url });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json()).toMatchObject({ code: "worker_authentication_failed" });
      expect(request).not.toHaveBeenCalled();
      expect(completeArtifactRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

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

  it("rejects deeply nested JSON when its serialized result exceeds the limit", async () => {
    const { app, request } = createApp();
    const depth = Math.floor(maximumRunCompletionResultUtf8Bytes / 2) + 1;
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
      tls: {},
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
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json()).toMatchObject({
        code: "worker_authentication_failed",
        retryable: false,
      });
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
      tls: {},
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
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json()).toMatchObject({
        code: "worker_authentication_failed",
        retryable: false,
      });
      expect(parser).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(completeArtifactRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
