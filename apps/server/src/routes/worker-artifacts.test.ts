import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TLSSocket } from "node:tls";
import {
  type CreateResultArtifactUploadResponse,
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunkRequestBytes,
  maximumResultArtifactChunks,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactChunkTransportValidationError,
  ArtifactTransactionCoordinatorError,
} from "../../dist/artifacts/index.js";
import type { ServerConfig } from "../../dist/config.js";
import {
  registerWorkerArtifactRoutes,
  type WorkerArtifactTransactions,
} from "../../dist/routes/worker-artifacts.js";
import {
  createWorkerAuthenticationHooks,
  createWorkerAuthenticationPreHandler,
  getAuthenticatedWorkerIdentity,
} from "../../dist/security/worker-identity.js";

const uploadId = "10000000-0000-4000-8000-000000000001";
const clientArtifactId = "20000000-0000-4000-8000-000000000002";
const artifactId = "30000000-0000-4000-8000-000000000003";
const content = Buffer.from("artifact chunk", "utf8");
const sha256 = createHash("sha256").update(content).digest("hex");
const chunkData = content.toString("base64url");
const shutdownController = new AbortController();

const insecureConfig: ServerConfig = {
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
} as const;

const createRequest = () => ({
  ...leaseIdentity,
  clientArtifactId,
  purpose: "result" as const,
  name: "result.json",
  mediaType: "application/json" as const,
  totalBytes: content.byteLength,
  sha256,
});

const chunkRequest = () => ({
  ...leaseIdentity,
  chunkIndex: 0,
  offsetBytes: 0,
  chunkBytes: content.byteLength,
  chunkSha256: sha256,
  data: chunkData,
});

const finalizeRequest = () => ({
  ...leaseIdentity,
  chunkCount: 1,
  totalBytes: content.byteLength,
  sha256,
});

const terminateRequest = () => ({
  ...leaseIdentity,
  state: "abandoned" as const,
  reason: "client_abandoned" as const,
});

const createdResponse = (replayed = false): CreateResultArtifactUploadResponse =>
  replayed
    ? {
        uploadId,
        maximumChunkBytes: maximumResultArtifactChunkBytes,
        maximumChunkCount: maximumResultArtifactChunks,
        state: "receiving",
        replayed: true,
        nextChunkIndex: 0,
        nextOffsetBytes: 0,
      }
    : {
        uploadId,
        maximumChunkBytes: maximumResultArtifactChunkBytes,
        maximumChunkCount: maximumResultArtifactChunks,
        state: "receiving",
        replayed: false,
        nextChunkIndex: 0,
        nextOffsetBytes: 0,
      };

const chunkResponse = {
  uploadId,
  chunkIndex: 0,
  nextChunkIndex: 1,
  nextOffsetBytes: content.byteLength,
  state: "receiving" as const,
  outcome: "accepted" as const,
};

const finalizeResponse = {
  state: "committed" as const,
  replayed: false,
  artifact: {
    artifactId,
    uploadId,
    clientArtifactId,
    jobId: leaseIdentity.jobId,
    runAttemptId: leaseIdentity.runAttemptId,
    purpose: "result" as const,
    name: "result.json",
    mediaType: "application/json" as const,
    totalBytes: content.byteLength,
    sha256,
  },
};

const terminateResponse = {
  uploadId,
  state: "abandoned" as const,
  reason: "client_abandoned" as const,
  terminatedAt: "2026-09-02T00:00:00.000Z",
  replayed: false,
};

const createTransactions = (): WorkerArtifactTransactions => ({
  createArtifactUpload: vi.fn(async () => createdResponse()),
  putArtifactChunk: vi.fn(async () => chunkResponse),
  finalizeArtifactUpload: vi.fn(async () => finalizeResponse),
  terminateArtifactUpload: vi.fn(async () => terminateResponse),
});

const installProductionBodyLimitHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({
        code: "request_body_too_large",
        message: "The request body exceeds the configured limit.",
        retryable: false,
      });
    }
    return reply.send(error);
  });
};

const createApp = (
  transactions: WorkerArtifactTransactions = createTransactions(),
  config: ServerConfig = insecureConfig,
): FastifyInstance => {
  const app = Fastify({ logger: false });
  installProductionBodyLimitHandler(app);
  registerWorkerArtifactRoutes(app, {
    config,
    transactions,
    shutdownSignal: shutdownController.signal,
  });
  return app;
};

const noCalls = (transactions: WorkerArtifactTransactions): void => {
  expect(transactions.createArtifactUpload).not.toHaveBeenCalled();
  expect(transactions.putArtifactChunk).not.toHaveBeenCalled();
  expect(transactions.finalizeArtifactUpload).not.toHaveBeenCalled();
  expect(transactions.terminateArtifactUpload).not.toHaveBeenCalled();
};

const createHookRequest = (body: unknown, socket: object): FastifyRequest =>
  ({ body, raw: { socket } }) as unknown as FastifyRequest;

const createHookReply = (): {
  readonly reply: FastifyReply;
  readonly status: () => number | undefined;
  readonly body: () => unknown;
} => {
  let status: number | undefined;
  let body: unknown;
  const candidate = {
    sent: false,
    code: vi.fn((value: number) => {
      status = value;
      return candidate;
    }),
    send: vi.fn((value: unknown) => {
      body = value;
      candidate.sent = true;
      return candidate;
    }),
  };
  return {
    reply: candidate as unknown as FastifyReply,
    status: () => status,
    body: () => body,
  };
};

const createTlsSocket = (certificateRaw: Buffer, authorized = true): TLSSocket => {
  const socket = Object.create(TLSSocket.prototype) as TLSSocket;
  Object.defineProperties(socket, {
    encrypted: { value: true },
    authorized: { value: authorized },
    remoteAddress: { value: "192.0.2.10" },
    getPeerCertificate: { value: () => ({ raw: certificateRaw }) },
  });
  return socket;
};

describe("Worker result artifact routes", () => {
  it("creates an upload with route and authenticated identities and returns 201", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        payload: createRequest(),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(createdResponse());
      expect(transactions.createArtifactUpload).toHaveBeenCalledWith(
        {
          jobId: leaseIdentity.jobId,
          runAttemptId: leaseIdentity.runAttemptId,
          workerNodeId: leaseIdentity.workerNodeId,
          workerInstanceId: leaseIdentity.workerInstanceId,
          leaseToken: leaseIdentity.leaseToken,
          leaseGeneration: leaseIdentity.leaseGeneration,
          clientArtifactId,
          purpose: "result",
          name: "result.json",
          mediaType: "application/json",
          totalBytes: content.byteLength,
          sha256,
        },
        shutdownController.signal,
      );
    } finally {
      await app.close();
    }
  });

  it("returns 200 for an exact create replay", async () => {
    const transactions = createTransactions();
    vi.mocked(transactions.createArtifactUpload).mockResolvedValue(createdResponse(true));
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        payload: createRequest(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(createdResponse(true));
    } finally {
      await app.close();
    }
  });

  it("puts one chunk with path-authoritative identifiers", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        payload: chunkRequest(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(chunkResponse);
      expect(transactions.putArtifactChunk).toHaveBeenCalledWith(
        uploadId,
        {
          jobId: leaseIdentity.jobId,
          runAttemptId: leaseIdentity.runAttemptId,
          workerNodeId: leaseIdentity.workerNodeId,
          workerInstanceId: leaseIdentity.workerInstanceId,
          leaseToken: leaseIdentity.leaseToken,
          leaseGeneration: leaseIdentity.leaseGeneration,
          chunkIndex: 0,
          offsetBytes: 0,
          chunkBytes: content.byteLength,
          chunkSha256: sha256,
          data: chunkData,
        },
        shutdownController.signal,
      );
    } finally {
      await app.close();
    }
  });

  it("finalizes an upload and allowlists the public artifact response", async () => {
    const transactions = createTransactions();
    vi.mocked(transactions.finalizeArtifactUpload).mockResolvedValue({
      ...finalizeResponse,
      internal: "do-not-serialize",
      artifact: {
        ...finalizeResponse.artifact,
        storageObjectKey: `sha256/${sha256.slice(0, 2)}/${sha256}`,
        serverPath: "/private/artifacts/object",
      },
    } as unknown as typeof finalizeResponse);
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/complete`,
        payload: finalizeRequest(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(finalizeResponse);
      expect(response.body).not.toContain("storageObjectKey");
      expect(response.body).not.toContain("serverPath");
      expect(transactions.finalizeArtifactUpload).toHaveBeenCalledWith(
        uploadId,
        finalizeRequest(),
        shutdownController.signal,
      );
    } finally {
      await app.close();
    }
  });

  it("terminates an upload with a stable tombstone response", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/terminate`,
        payload: terminateRequest(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(terminateResponse);
      expect(transactions.terminateArtifactUpload).toHaveBeenCalledWith(
        uploadId,
        terminateRequest(),
        shutdownController.signal,
      );
    } finally {
      await app.close();
    }
  });

  it("returns stable 200 responses for chunk, finalize, and termination replays", async () => {
    const transactions = createTransactions();
    vi.mocked(transactions.putArtifactChunk).mockResolvedValue({
      ...chunkResponse,
      state: "committed",
      outcome: "replayed",
    });
    vi.mocked(transactions.finalizeArtifactUpload).mockResolvedValue({
      ...finalizeResponse,
      replayed: true,
    });
    vi.mocked(transactions.terminateArtifactUpload).mockResolvedValue({
      ...terminateResponse,
      replayed: true,
    });
    const app = createApp(transactions);
    try {
      const chunk = await app.inject({
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        payload: chunkRequest(),
      });
      const finalized = await app.inject({
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/complete`,
        payload: finalizeRequest(),
      });
      const terminated = await app.inject({
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/terminate`,
        payload: terminateRequest(),
      });

      expect(chunk.statusCode).toBe(200);
      expect(chunk.json()).toMatchObject({ outcome: "replayed", state: "committed" });
      expect(finalized.statusCode).toBe(200);
      expect(finalized.json()).toMatchObject({ replayed: true });
      expect(terminated.statusCode).toBe(200);
      expect(terminated.json()).toMatchObject({ replayed: true });
    } finally {
      await app.close();
    }
  });

  it("uses the authenticated worker identity in all four transaction DTOs", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      await app.inject({
        method: "POST",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        payload: createRequest(),
      });
      await app.inject({
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        payload: chunkRequest(),
      });
      await app.inject({
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/complete`,
        payload: finalizeRequest(),
      });
      await app.inject({
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/terminate`,
        payload: terminateRequest(),
      });

      expect(vi.mocked(transactions.createArtifactUpload).mock.calls[0]?.[0].workerNodeId).toBe(
        leaseIdentity.workerNodeId,
      );
      expect(vi.mocked(transactions.putArtifactChunk).mock.calls[0]?.[1].workerNodeId).toBe(
        leaseIdentity.workerNodeId,
      );
      expect(vi.mocked(transactions.finalizeArtifactUpload).mock.calls[0]?.[1].workerNodeId).toBe(
        leaseIdentity.workerNodeId,
      );
      expect(vi.mocked(transactions.terminateArtifactUpload).mock.calls[0]?.[1].workerNodeId).toBe(
        leaseIdentity.workerNodeId,
      );
    } finally {
      await app.close();
    }
  });
});

describe("Worker result artifact route boundaries", () => {
  it("rejects a create route/body attempt mismatch before transaction admission", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker/runs/another-attempt/artifacts",
        payload: createRequest(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "run_attempt_mismatch",
        message: "Route and body run attempt identifiers must match.",
        retryable: false,
      });
      noCalls(transactions);
    } finally {
      await app.close();
    }
  });

  it("rejects a chunk route/body index mismatch before transaction admission", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/1`,
        payload: chunkRequest(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "artifact_chunk_index_mismatch",
        message: "Route and body artifact chunk indexes must match.",
        retryable: false,
      });
      noCalls(transactions);
    } finally {
      await app.close();
    }
  });

  it.each([
    "/api/v1/worker/artifact-uploads/ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF/chunks/0",
    `/api/v1/worker/artifact-uploads/${uploadId}/chunks/8`,
    `/api/v1/worker/artifact-uploads/${uploadId}/chunks/01`,
  ])("rejects a noncanonical artifact route parameter %s", async (url) => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      const response = await app.inject({ method: "PUT", url, payload: chunkRequest() });

      expect(response.statusCode).toBe(400);
      noCalls(transactions);
    } finally {
      await app.close();
    }
  });

  it("rejects unknown request fields before transaction admission", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        payload: { ...createRequest(), storageObjectKey: "attacker-controlled" },
      });

      expect(response.statusCode).toBe(400);
      noCalls(transactions);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: "create unknown field",
      method: "POST",
      url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
      payload: { ...createRequest(), unknown: true },
    },
    {
      name: "create integer coercion",
      method: "POST",
      url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
      payload: { ...createRequest(), totalBytes: String(content.byteLength) },
    },
    {
      name: "chunk unknown field",
      method: "PUT",
      url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
      payload: { ...chunkRequest(), unknown: true },
    },
    {
      name: "chunk integer coercion",
      method: "PUT",
      url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
      payload: { ...chunkRequest(), chunkIndex: "0" },
    },
    {
      name: "finalize unknown field",
      method: "POST",
      url: `/api/v1/worker/artifact-uploads/${uploadId}/complete`,
      payload: { ...finalizeRequest(), unknown: true },
    },
    {
      name: "finalize integer coercion",
      method: "POST",
      url: `/api/v1/worker/artifact-uploads/${uploadId}/complete`,
      payload: { ...finalizeRequest(), chunkCount: "1" },
    },
    {
      name: "terminate unknown field",
      method: "POST",
      url: `/api/v1/worker/artifact-uploads/${uploadId}/terminate`,
      payload: { ...terminateRequest(), unknown: true },
    },
    {
      name: "terminate integer coercion",
      method: "POST",
      url: `/api/v1/worker/artifact-uploads/${uploadId}/terminate`,
      payload: { ...terminateRequest(), leaseGeneration: "1" },
    },
  ] as const)(
    "rejects $name before default AJV can mutate it",
    async ({ method, url, payload }) => {
      const transactions = createTransactions();
      const app = createApp(transactions);
      try {
        const response = await app.inject({ method, url, payload });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          code: "request_validation_failed",
          message: "The request does not match the strict route contract.",
          retryable: false,
        });
        noCalls(transactions);
      } finally {
        await app.close();
      }
    },
  );

  it("enforces the chunk-specific encoded body limit", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    const payload = JSON.stringify({
      ...chunkRequest(),
      data: "A".repeat(maximumResultArtifactChunkRequestBytes),
    });
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({
        code: "request_body_too_large",
        message: "The request body exceeds the configured limit.",
        retryable: false,
      });
      noCalls(transactions);
    } finally {
      await app.close();
    }
  });

  it("enforces the metadata-only control body limit", async () => {
    const transactions = createTransactions();
    const app = createApp(transactions);
    const payload = JSON.stringify({
      ...createRequest(),
      leaseToken: "x".repeat(20_000),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({
        code: "request_body_too_large",
        message: "The request body exceeds the configured limit.",
        retryable: false,
      });
      noCalls(transactions);
    } finally {
      await app.close();
    }
  });

  it("passes only the shared shutdown signal and does not inspect socket cancellation", async () => {
    const source = await readFile(
      new URL("../routes/worker-artifacts.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("shutdownSignal");
    expect(source).not.toContain("request.raw");
    expect(source).not.toContain('request.on("close"');
    expect(source).not.toContain('request.on("aborted"');
  });

  it("keeps the declared body-limit response aligned with the production error handler", async () => {
    const routeSource = await readFile(
      new URL("../routes/worker-artifacts.ts", import.meta.url),
      "utf8",
    );
    const appSource = await readFile(new URL("../app.ts", import.meta.url), "utf8");

    expect(routeSource).toContain("413: publicErrorSchema");
    expect(routeSource).toContain("401: publicErrorSchema");
    expect(routeSource).toContain("403: publicErrorSchema");
    expect(appSource).toContain('error.code === "FST_ERR_CTP_BODY_TOO_LARGE"');
    expect(appSource).toContain('code: "request_body_too_large"');
    expect(appSource).toContain("retryable: false");
  });
});

describe("Worker result artifact public errors", () => {
  it.each([
    ["ARTIFACT_TRANSACTION_BUSY", 429, "artifact_transaction_busy", true],
    ["ARTIFACT_TRANSACTION_CANCELLED", 503, "artifact_transaction_cancelled", true],
    ["ARTIFACT_TRANSACTION_CAPACITY", 507, "artifact_storage_capacity", true],
    ["ARTIFACT_TRANSACTION_CLOSED", 503, "artifact_transaction_closed", false],
    [
      "ARTIFACT_TRANSACTION_COMPLETION_MODE_MISMATCH",
      409,
      "artifact_completion_mode_mismatch",
      false,
    ],
    ["ARTIFACT_TRANSACTION_CONFLICT", 409, "artifact_upload_conflict", false],
    ["ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN", 503, "artifact_service_unavailable", false],
    ["ARTIFACT_TRANSACTION_INVALID_REQUEST", 400, "artifact_request_invalid", false],
    ["ARTIFACT_TRANSACTION_LEASE_LOST", 409, "lease_lost", false],
    ["ARTIFACT_TRANSACTION_NOT_READY", 503, "artifact_transaction_not_ready", true],
    ["ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE", 503, "artifact_service_unavailable", false],
    ["ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", 503, "artifact_service_unavailable", false],
    ["ARTIFACT_TRANSACTION_QUOTA_EXCEEDED", 409, "artifact_upload_quota_exceeded", false],
    ["ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE", 503, "artifact_service_unavailable", false],
    ["ARTIFACT_TRANSACTION_STORAGE_INTEGRITY", 503, "artifact_storage_integrity", false],
    ["ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN", 503, "artifact_service_unavailable", false],
    ["ARTIFACT_TRANSACTION_TIMEOUT", 503, "artifact_transaction_timeout", true],
  ] as const)("maps %s without exposing its cause", async (code, status, publicCode, retryable) => {
    const transactions = createTransactions();
    vi.mocked(transactions.createArtifactUpload).mockRejectedValue(
      new ArtifactTransactionCoordinatorError(code, {
        cause: new Error("private owner failure details"),
      }),
    );
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        payload: createRequest(),
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code: publicCode, retryable });
      expect(response.body).not.toContain("private owner failure details");
    } finally {
      await app.close();
    }
  });

  it.each([
    ["ARTIFACT_CHUNK_DIGEST_MISMATCH", "artifact_chunk_digest_mismatch"],
    ["ARTIFACT_CHUNK_ENCODING_INVALID", "artifact_chunk_encoding_invalid"],
    ["ARTIFACT_CHUNK_LENGTH_MISMATCH", "artifact_chunk_length_mismatch"],
    ["ARTIFACT_CHUNK_RANGE_INVALID", "artifact_chunk_range_invalid"],
    ["ARTIFACT_CHUNK_REQUEST_INVALID", "artifact_chunk_request_invalid"],
  ] as const)("maps trusted chunk validation cause %s", async (code, publicCode) => {
    const transactions = createTransactions();
    vi.mocked(transactions.putArtifactChunk).mockRejectedValue(
      new ArtifactTransactionCoordinatorError("ARTIFACT_TRANSACTION_INVALID_REQUEST", {
        cause: new ArtifactChunkTransportValidationError(code),
      }),
    );
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        payload: chunkRequest(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: publicCode, retryable: false });
    } finally {
      await app.close();
    }
  });

  it("does not infer storage integrity from a nested cause", async () => {
    const transactions = createTransactions();
    vi.mocked(transactions.putArtifactChunk).mockRejectedValue(
      new ArtifactTransactionCoordinatorError("ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN", {
        cause: Object.assign(new Error("private inode and path details"), {
          code: "ARTIFACT_STORAGE_INTEGRITY",
        }),
      }),
    );
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        payload: chunkRequest(),
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "artifact_service_unavailable",
        message: "Artifact transaction service is unavailable.",
        retryable: false,
      });
      expect(response.body).not.toContain("inode");
      expect(response.body).not.toContain("path");
    } finally {
      await app.close();
    }
  });
});

describe("Worker result artifact timestamp responses", () => {
  it("returns a terminal create replay without requiring the TypeBox format registry", async () => {
    const formats = [...FormatRegistry.Entries()];
    FormatRegistry.Clear();
    const terminal: CreateResultArtifactUploadResponse = {
      uploadId,
      maximumChunkBytes: maximumResultArtifactChunkBytes,
      maximumChunkCount: maximumResultArtifactChunks,
      nextChunkIndex: 0,
      nextOffsetBytes: 0,
      state: "abandoned",
      replayed: true,
      reason: "client_abandoned",
      terminatedAt: terminateResponse.terminatedAt,
    };
    const transactions = createTransactions();
    vi.mocked(transactions.createArtifactUpload).mockResolvedValue(terminal);
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        payload: createRequest(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(terminal);
    } finally {
      await app.close();
      for (const [name, format] of formats) FormatRegistry.Set(name, format);
    }
  });

  it("returns a termination response without requiring the TypeBox format registry", async () => {
    const formats = [...FormatRegistry.Entries()];
    FormatRegistry.Clear();
    const transactions = createTransactions();
    const app = createApp(transactions);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/terminate`,
        payload: terminateRequest(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(terminateResponse);
    } finally {
      await app.close();
      for (const [name, format] of formats) FormatRegistry.Set(name, format);
    }
  });
});

describe("Worker result artifact authentication hooks", () => {
  it("returns one frozen pair of route hooks", () => {
    const hooks = createWorkerAuthenticationHooks(insecureConfig);

    expect(Object.isFrozen(hooks)).toBe(true);
    expect(typeof hooks.onRequest).toBe("function");
    expect(typeof hooks.preValidation).toBe("function");
  });

  it("rejects an unauthenticated large body before its content parser runs", async () => {
    const transactions = createTransactions();
    const secureConfig: ServerConfig = {
      ...insecureConfig,
      allowInsecureWorkerAuth: false,
      tls: {},
      workerCertificateBindings: { ["A".repeat(64)]: leaseIdentity.workerNodeId },
    };
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
    registerWorkerArtifactRoutes(app, {
      config: secureConfig,
      transactions,
      shutdownSignal: shutdownController.signal,
    });
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ ...chunkRequest(), data: "A".repeat(400_000) }),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        code: "worker_mtls_required",
        message: "A mutually authenticated TLS connection is required.",
        retryable: false,
      });
      expect(parser).not.toHaveBeenCalled();
      noCalls(transactions);
    } finally {
      await app.close();
    }
  });

  it("allows an authenticated transport to reach parsing before schema validation", async () => {
    const transactions = createTransactions();
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
    registerWorkerArtifactRoutes(app, {
      config: insecureConfig,
      transactions,
      shutdownSignal: shutdownController.signal,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/worker/runs/${leaseIdentity.runAttemptId}/artifacts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ workerNodeId: leaseIdentity.workerNodeId }),
      });

      expect(response.statusCode).toBe(400);
      expect(parser).toHaveBeenCalledOnce();
      noCalls(transactions);
    } finally {
      await app.close();
    }
  });

  it("does not publish final identity until preValidation consumes the transport", async () => {
    const hooks = createWorkerAuthenticationHooks(insecureConfig);
    const request = createHookRequest(createRequest(), { remoteAddress: "127.0.0.1" });
    const reply = createHookReply();

    await hooks.onRequest(request, reply.reply);
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
    await hooks.preValidation(request, reply.reply);

    expect(getAuthenticatedWorkerIdentity(request)).toEqual({
      workerNodeId: leaseIdentity.workerNodeId,
      certificateFingerprint: undefined,
      authenticationMethod: "insecure-loopback",
    });
  });

  it("keeps interleaved transport authentication state keyed to each request", async () => {
    const certificateA = Buffer.from("interleaved worker certificate A", "utf8");
    const certificateB = Buffer.from("interleaved worker certificate B", "utf8");
    const fingerprintA = createHash("sha256").update(certificateA).digest("hex").toUpperCase();
    const fingerprintB = createHash("sha256").update(certificateB).digest("hex").toUpperCase();
    const workerA = "interleaved-worker-a";
    const workerB = "interleaved-worker-b";
    const hooks = createWorkerAuthenticationHooks({
      ...insecureConfig,
      allowInsecureWorkerAuth: false,
      tls: {},
      workerCertificateBindings: {
        [fingerprintA]: workerA,
        [fingerprintB]: workerB,
      },
    });
    const requestA = createHookRequest({ workerNodeId: workerA }, createTlsSocket(certificateA));
    const requestB = createHookRequest({ workerNodeId: workerB }, createTlsSocket(certificateB));
    const replyA = createHookReply();
    const replyB = createHookReply();

    await hooks.onRequest(requestA, replyA.reply);
    await hooks.onRequest(requestB, replyB.reply);
    await hooks.preValidation(requestB, replyB.reply);
    await hooks.preValidation(requestA, replyA.reply);

    expect(replyA.status()).toBeUndefined();
    expect(replyB.status()).toBeUndefined();
    expect(getAuthenticatedWorkerIdentity(requestA)).toEqual({
      workerNodeId: workerA,
      certificateFingerprint: fingerprintA,
      authenticationMethod: "mtls",
    });
    expect(getAuthenticatedWorkerIdentity(requestB)).toEqual({
      workerNodeId: workerB,
      certificateFingerprint: fingerprintB,
      authenticationMethod: "mtls",
    });
  });

  it("consumes a pending transport exactly once and fails closed on reuse", async () => {
    const hooks = createWorkerAuthenticationHooks(insecureConfig);
    const request = createHookRequest(createRequest(), { remoteAddress: "127.0.0.1" });
    const firstReply = createHookReply();
    await hooks.onRequest(request, firstReply.reply);
    await hooks.preValidation(request, firstReply.reply);

    const secondReply = createHookReply();
    await hooks.preValidation(request, secondReply.reply);

    expect(secondReply.status()).toBe(401);
    expect(secondReply.body()).toEqual({
      code: "worker_authentication_state_missing",
      message: "Worker transport authentication state is missing.",
      retryable: false,
    });
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
  });

  it("does not allow one hook factory to consume another factory's transport", async () => {
    const first = createWorkerAuthenticationHooks(insecureConfig);
    const second = createWorkerAuthenticationHooks(insecureConfig);
    const request = createHookRequest(createRequest(), { remoteAddress: "127.0.0.1" });
    await first.onRequest(request, createHookReply().reply);
    const reply = createHookReply();

    await second.preValidation(request, reply.reply);

    expect(reply.status()).toBe(401);
    expect(reply.body()).toMatchObject({ code: "worker_authentication_state_missing" });
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
  });

  it("invalidates the pending transport when onRequest is invoked twice", async () => {
    const hooks = createWorkerAuthenticationHooks(insecureConfig);
    const request = createHookRequest(createRequest(), { remoteAddress: "127.0.0.1" });
    await hooks.onRequest(request, createHookReply().reply);
    const duplicateReply = createHookReply();

    await hooks.onRequest(request, duplicateReply.reply);
    const consumeReply = createHookReply();
    await hooks.preValidation(request, consumeReply.reply);

    expect(duplicateReply.status()).toBe(401);
    expect(duplicateReply.body()).toMatchObject({ code: "worker_authentication_state_invalid" });
    expect(consumeReply.status()).toBe(401);
    expect(consumeReply.body()).toMatchObject({ code: "worker_authentication_state_missing" });
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
  });

  it("rejects insecure authentication from a non-loopback transport", async () => {
    const hooks = createWorkerAuthenticationHooks(insecureConfig);
    const request = createHookRequest(createRequest(), { remoteAddress: "192.0.2.10" });
    const reply = createHookReply();

    await hooks.onRequest(request, reply.reply);

    expect(reply.status()).toBe(403);
    expect(reply.body()).toMatchObject({ code: "insecure_worker_auth_loopback_only" });
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
  });

  it.each([
    [false, Buffer.from("unauthorized leaf", "utf8"), "worker_certificate_unauthorized"],
    [true, Buffer.alloc(0), "worker_certificate_missing"],
    [true, Buffer.from("unmapped leaf", "utf8"), "worker_certificate_unmapped"],
  ] as const)(
    "rejects TLS authorization boundary %s/%s with %s",
    async (authorized, certificateRaw, expectedCode) => {
      const secureConfig: ServerConfig = {
        ...insecureConfig,
        allowInsecureWorkerAuth: false,
        tls: {},
        workerCertificateBindings: {},
      };
      const hooks = createWorkerAuthenticationHooks(secureConfig);
      const request = createHookRequest(
        createRequest(),
        createTlsSocket(Buffer.from(certificateRaw), authorized),
      );
      const reply = createHookReply();

      await hooks.onRequest(request, reply.reply);

      expect(reply.status()).toBe(authorized ? (certificateRaw.length === 0 ? 401 : 403) : 401);
      expect(reply.body()).toMatchObject({ code: expectedCode, retryable: false });
      expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
    },
  );

  it("rejects a mismatched active lease worker claim", async () => {
    const hooks = createWorkerAuthenticationHooks(insecureConfig);
    const request = createHookRequest(
      {
        workerNodeId: leaseIdentity.workerNodeId,
        activeLeases: [{ workerNodeId: "another-worker" }],
      },
      { remoteAddress: "127.0.0.1" },
    );
    const reply = createHookReply();

    await hooks.onRequest(request, reply.reply);
    await hooks.preValidation(request, reply.reply);

    expect(reply.status()).toBe(403);
    expect(reply.body()).toMatchObject({ code: "worker_identity_mismatch" });
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
  });

  it("does not invoke body accessors while binding identity", async () => {
    const hooks = createWorkerAuthenticationHooks(insecureConfig);
    const getter = vi.fn(() => leaseIdentity.workerNodeId);
    const body = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(body, "workerNodeId", { enumerable: true, get: getter });
    const request = createHookRequest(body, { remoteAddress: "127.0.0.1" });
    const reply = createHookReply();

    await hooks.onRequest(request, reply.reply);
    await hooks.preValidation(request, reply.reply);

    expect(getter).not.toHaveBeenCalled();
    expect(reply.status()).toBe(400);
    expect(reply.body()).toMatchObject({ code: "worker_identity_missing" });
  });

  it("binds an authorized TLS leaf fingerprint to its configured worker node", async () => {
    const certificateRaw = Buffer.from("test worker leaf certificate", "utf8");
    const fingerprint = createHash("sha256").update(certificateRaw).digest("hex").toUpperCase();
    const secureConfig: ServerConfig = {
      ...insecureConfig,
      allowInsecureWorkerAuth: false,
      tls: {},
      workerCertificateBindings: { [fingerprint]: leaseIdentity.workerNodeId },
    };
    const hooks = createWorkerAuthenticationHooks(secureConfig);
    const request = createHookRequest(createRequest(), createTlsSocket(certificateRaw));
    const reply = createHookReply();

    await hooks.onRequest(request, reply.reply);
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
    await hooks.preValidation(request, reply.reply);

    expect(getAuthenticatedWorkerIdentity(request)).toEqual({
      workerNodeId: leaseIdentity.workerNodeId,
      certificateFingerprint: fingerprint,
      authenticationMethod: "mtls",
    });
  });

  it("rejects a body identity that differs from the TLS certificate binding", async () => {
    const certificateRaw = Buffer.from("second test worker leaf certificate", "utf8");
    const fingerprint = createHash("sha256").update(certificateRaw).digest("hex").toUpperCase();
    const secureConfig: ServerConfig = {
      ...insecureConfig,
      allowInsecureWorkerAuth: false,
      tls: {},
      workerCertificateBindings: { [fingerprint]: "certificate-worker" },
    };
    const hooks = createWorkerAuthenticationHooks(secureConfig);
    const request = createHookRequest(createRequest(), createTlsSocket(certificateRaw));
    const reply = createHookReply();

    await hooks.onRequest(request, reply.reply);
    await hooks.preValidation(request, reply.reply);

    expect(reply.status()).toBe(403);
    expect(reply.body()).toEqual({
      code: "worker_identity_mismatch",
      message: "The claimed workerNodeId does not match the authenticated Worker identity.",
      retryable: false,
    });
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
  });

  it("fails closed when transport properties cannot be read", async () => {
    const socket = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(socket, "remoteAddress", {
      get: () => {
        throw new Error("hostile socket getter");
      },
    });
    const hooks = createWorkerAuthenticationHooks(insecureConfig);
    const request = createHookRequest(createRequest(), socket);
    const reply = createHookReply();

    await hooks.onRequest(request, reply.reply);

    expect(reply.status()).toBe(401);
    expect(reply.body()).toEqual({
      code: "worker_transport_authentication_failed",
      message: "Worker transport authentication could not be completed.",
      retryable: false,
    });
    expect(() => getAuthenticatedWorkerIdentity(request)).toThrow(/not authenticated/u);
  });

  it("preserves the legacy preHandler missing-body error priority", async () => {
    const secureConfig: ServerConfig = {
      ...insecureConfig,
      allowInsecureWorkerAuth: false,
      tls: {},
      workerCertificateBindings: {},
    };
    const request = createHookRequest({}, { remoteAddress: "192.0.2.10" });
    const reply = createHookReply();

    await createWorkerAuthenticationPreHandler(secureConfig)(request, reply.reply);

    expect(reply.status()).toBe(400);
    expect(reply.body()).toEqual({
      code: "worker_identity_missing",
      message: "The request must claim a workerNodeId.",
      retryable: false,
    });
  });
});
