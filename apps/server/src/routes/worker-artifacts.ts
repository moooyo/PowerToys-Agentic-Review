import {
  type CreateResultArtifactUploadRequest,
  CreateResultArtifactUploadRequestSchema,
  type CreateResultArtifactUploadResponse,
  CreateResultArtifactUploadResponseSchema,
  ErrorDetailsSchema,
  type FinalizeResultArtifactUploadRequest,
  FinalizeResultArtifactUploadRequestSchema,
  type FinalizeResultArtifactUploadResponse,
  FinalizeResultArtifactUploadResponseSchema,
  maximumResultArtifactChunkRequestBytes,
  maximumResultArtifactControlRequestBytes,
  type ResultArtifactChunkRequest,
  ResultArtifactChunkRequestSchema,
  type ResultArtifactChunkResponse,
  ResultArtifactChunkResponseSchema,
  type TerminateResultArtifactUploadRequest,
  TerminateResultArtifactUploadRequestSchema,
  type TerminateResultArtifactUploadResponse,
  TerminateResultArtifactUploadResponseSchema,
} from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ArtifactChunkTransportValidationError,
  ArtifactTransactionCoordinatorError,
  type ArtifactTransactionPort,
} from "../artifacts/index.js";
import type { ServerConfig } from "../config.js";
import {
  createWorkerAuthenticationHooks,
  getAuthenticatedWorkerIdentity,
} from "../security/worker-identity.js";

export type WorkerArtifactTransactions = ArtifactTransactionPort;

export interface WorkerArtifactRouteDependencies {
  readonly config: ServerConfig;
  readonly transactions: WorkerArtifactTransactions;
  readonly shutdownSignal: AbortSignal;
}

interface RunArtifactParameters {
  readonly runAttemptId: string;
}

interface ArtifactUploadParameters {
  readonly uploadId: string;
}

interface ArtifactChunkParameters extends ArtifactUploadParameters {
  readonly chunkIndex: string;
}

type PublicErrorStatus = 400 | 409 | 429 | 503 | 507;

interface PublicErrorDefinition {
  readonly status: PublicErrorStatus;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

const lowerUuidV4Pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const inlineSchema = (schema: unknown): Record<string, unknown> => {
  const serialized = JSON.stringify(schema, (key, value: unknown) =>
    key === "$id" ? undefined : value,
  );
  if (serialized === undefined) {
    throw new Error("The route schema could not be serialized.");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
};

const createRequestSchema = inlineSchema(CreateResultArtifactUploadRequestSchema);
const createResponseSchema = inlineSchema(CreateResultArtifactUploadResponseSchema);
const chunkRequestSchema = inlineSchema(ResultArtifactChunkRequestSchema);
const chunkResponseSchema = inlineSchema(ResultArtifactChunkResponseSchema);
const finalizeRequestSchema = inlineSchema(FinalizeResultArtifactUploadRequestSchema);
const finalizeResponseSchema = inlineSchema(FinalizeResultArtifactUploadResponseSchema);
const terminateRequestSchema = inlineSchema(TerminateResultArtifactUploadRequestSchema);
const terminateResponseSchema = inlineSchema(TerminateResultArtifactUploadResponseSchema);
const publicErrorSchema = inlineSchema(ErrorDetailsSchema);
const serviceUnavailableResponseSchema = inlineSchema(
  Type.Union([
    ErrorDetailsSchema,
    Type.Object(
      {
        status: Type.Literal("not_ready"),
        serverTime: Type.String({ format: "date-time" }),
      },
      { additionalProperties: false },
    ),
  ]),
);

const routeEntityIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const routeUploadIdSchema = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: lowerUuidV4Pattern,
});
const runArtifactParametersSchema = Type.Object(
  { runAttemptId: routeEntityIdSchema },
  { additionalProperties: false },
);
const artifactUploadParametersSchema = Type.Object(
  { uploadId: routeUploadIdSchema },
  { additionalProperties: false },
);
const artifactChunkParametersSchema = Type.Object(
  {
    uploadId: routeUploadIdSchema,
    chunkIndex: Type.String({ minLength: 1, maxLength: 1, pattern: "^[0-7]$" }),
  },
  { additionalProperties: false },
);
const runArtifactParametersRouteSchema = inlineSchema(runArtifactParametersSchema);
const artifactUploadParametersRouteSchema = inlineSchema(artifactUploadParametersSchema);
const artifactChunkParametersRouteSchema = inlineSchema(artifactChunkParametersSchema);

const errorResponses = {
  400: publicErrorSchema,
  401: publicErrorSchema,
  403: publicErrorSchema,
  409: publicErrorSchema,
  413: publicErrorSchema,
  429: publicErrorSchema,
  503: serviceUnavailableResponseSchema,
  507: publicErrorSchema,
} as const;

const createStrictRequestValidation =
  (
    paramsSchema: TSchema,
    bodySchema: TSchema,
  ): ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) =>
  async (request, reply) => {
    let valid = false;
    try {
      valid = Value.Check(paramsSchema, request.params) && Value.Check(bodySchema, request.body);
    } catch {
      valid = false;
    }
    if (!valid) {
      void reply.code(400).send({
        code: "request_validation_failed",
        message: "The request does not match the strict route contract.",
        retryable: false,
      });
    }
  };

const validateCreateRequest = createStrictRequestValidation(
  runArtifactParametersSchema,
  CreateResultArtifactUploadRequestSchema,
);
const validateChunkRequest = createStrictRequestValidation(
  artifactChunkParametersSchema,
  ResultArtifactChunkRequestSchema,
);
const validateFinalizeRequest = createStrictRequestValidation(
  artifactUploadParametersSchema,
  FinalizeResultArtifactUploadRequestSchema,
);
const validateTerminateRequest = createStrictRequestValidation(
  artifactUploadParametersSchema,
  TerminateResultArtifactUploadRequestSchema,
);

const routeIdentityMismatch = (
  reply: FastifyReply,
  code: "artifact_chunk_index_mismatch" | "run_attempt_mismatch",
  message: string,
): FastifyReply => reply.code(400).send({ code, message, retryable: false });

const chunkValidationErrors: Readonly<
  Record<ArtifactChunkTransportValidationError["code"], PublicErrorDefinition>
> = Object.freeze({
  ARTIFACT_CHUNK_DIGEST_MISMATCH: {
    status: 400,
    code: "artifact_chunk_digest_mismatch",
    message: "The artifact chunk bytes do not match the declared SHA-256 digest.",
    retryable: false,
  },
  ARTIFACT_CHUNK_ENCODING_INVALID: {
    status: 400,
    code: "artifact_chunk_encoding_invalid",
    message: "The artifact chunk data is not canonical unpadded base64url.",
    retryable: false,
  },
  ARTIFACT_CHUNK_LENGTH_MISMATCH: {
    status: 400,
    code: "artifact_chunk_length_mismatch",
    message: "The artifact chunk bytes do not match the declared byte length.",
    retryable: false,
  },
  ARTIFACT_CHUNK_RANGE_INVALID: {
    status: 400,
    code: "artifact_chunk_range_invalid",
    message: "The artifact chunk range exceeds the result artifact byte limit.",
    retryable: false,
  },
  ARTIFACT_CHUNK_REQUEST_INVALID: {
    status: 400,
    code: "artifact_chunk_request_invalid",
    message: "The artifact chunk request is invalid.",
    retryable: false,
  },
});

const coordinatorErrors: Readonly<
  Record<ArtifactTransactionCoordinatorError["code"], PublicErrorDefinition>
> = Object.freeze({
  ARTIFACT_TRANSACTION_BUSY: {
    status: 429,
    code: "artifact_transaction_busy",
    message: "Artifact transaction admission is busy.",
    retryable: true,
  },
  ARTIFACT_TRANSACTION_CANCELLED: {
    status: 503,
    code: "artifact_transaction_cancelled",
    message: "Artifact transaction admission was cancelled during shutdown.",
    retryable: true,
  },
  ARTIFACT_TRANSACTION_CAPACITY: {
    status: 507,
    code: "artifact_storage_capacity",
    message: "Artifact storage capacity is unavailable.",
    retryable: true,
  },
  ARTIFACT_TRANSACTION_CLOSED: {
    status: 503,
    code: "artifact_transaction_closed",
    message: "Artifact transaction service is closed.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_COMPLETION_MODE_MISMATCH: {
    status: 409,
    code: "artifact_completion_mode_mismatch",
    message: "The run attempt does not permit result artifact operations.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_CONFLICT: {
    status: 409,
    code: "artifact_upload_conflict",
    message: "The artifact upload conflicts with durable state.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN: {
    status: 503,
    code: "artifact_service_unavailable",
    message: "Artifact transaction service is unavailable.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_INVALID_REQUEST: {
    status: 400,
    code: "artifact_request_invalid",
    message: "The artifact transaction request is invalid.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_LEASE_LOST: {
    status: 409,
    code: "lease_lost",
    message: "The lease is expired, superseded, or owned by another worker.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_NOT_READY: {
    status: 503,
    code: "artifact_transaction_not_ready",
    message: "Artifact transaction startup reconciliation is not complete.",
    retryable: true,
  },
  ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE: {
    status: 503,
    code: "artifact_service_unavailable",
    message: "Artifact transaction service is unavailable.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_PROTOCOL_FAILURE: {
    status: 503,
    code: "artifact_service_unavailable",
    message: "Artifact transaction service is unavailable.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_QUOTA_EXCEEDED: {
    status: 409,
    code: "artifact_upload_quota_exceeded",
    message: "The run attempt artifact upload quota is exhausted.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE: {
    status: 503,
    code: "artifact_service_unavailable",
    message: "Artifact transaction service is unavailable.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_STORAGE_INTEGRITY: {
    status: 503,
    code: "artifact_storage_integrity",
    message: "Artifact storage integrity validation failed.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN: {
    status: 503,
    code: "artifact_service_unavailable",
    message: "Artifact transaction service is unavailable.",
    retryable: false,
  },
  ARTIFACT_TRANSACTION_TIMEOUT: {
    status: 503,
    code: "artifact_transaction_timeout",
    message: "Artifact transaction admission timed out before execution.",
    retryable: true,
  },
});

const sendPublicError = (reply: FastifyReply, definition: PublicErrorDefinition): FastifyReply =>
  reply.code(definition.status).send({
    code: definition.code,
    message: definition.message,
    retryable: definition.retryable,
  });

const handleArtifactError = (error: unknown, reply: FastifyReply): FastifyReply => {
  if (!(error instanceof ArtifactTransactionCoordinatorError)) {
    throw error;
  }
  if (
    error.code === "ARTIFACT_TRANSACTION_INVALID_REQUEST" &&
    error.cause instanceof ArtifactChunkTransportValidationError
  ) {
    return sendPublicError(reply, chunkValidationErrors[error.cause.code]);
  }
  return sendPublicError(reply, coordinatorErrors[error.code]);
};

const requireCanonicalTimestamp = (value: string, description: string): void => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`Artifact transaction service returned an invalid ${description}.`);
  }
};

const mapCreateResponse = (
  value: CreateResultArtifactUploadResponse,
): CreateResultArtifactUploadResponse => {
  let response: CreateResultArtifactUploadResponse;
  if (value.state === "abandoned" || value.state === "corrupt") {
    requireCanonicalTimestamp(value.terminatedAt, "create response timestamp");
    response = {
      uploadId: value.uploadId,
      maximumChunkBytes: value.maximumChunkBytes,
      maximumChunkCount: value.maximumChunkCount,
      nextChunkIndex: value.nextChunkIndex,
      nextOffsetBytes: value.nextOffsetBytes,
      state: value.state,
      replayed: value.replayed,
      reason: value.reason,
      terminatedAt: value.terminatedAt,
    };
  } else if (!value.replayed) {
    response = {
      uploadId: value.uploadId,
      maximumChunkBytes: value.maximumChunkBytes,
      maximumChunkCount: value.maximumChunkCount,
      nextChunkIndex: value.nextChunkIndex,
      nextOffsetBytes: value.nextOffsetBytes,
      state: value.state,
      replayed: value.replayed,
    };
  } else {
    response = {
      uploadId: value.uploadId,
      maximumChunkBytes: value.maximumChunkBytes,
      maximumChunkCount: value.maximumChunkCount,
      nextChunkIndex: value.nextChunkIndex,
      nextOffsetBytes: value.nextOffsetBytes,
      state: value.state,
      replayed: value.replayed,
    };
  }
  return response;
};

const mapChunkResponse = (value: ResultArtifactChunkResponse): ResultArtifactChunkResponse => {
  const response: ResultArtifactChunkResponse =
    value.outcome === "accepted"
      ? {
          uploadId: value.uploadId,
          chunkIndex: value.chunkIndex,
          nextChunkIndex: value.nextChunkIndex,
          nextOffsetBytes: value.nextOffsetBytes,
          state: value.state,
          outcome: value.outcome,
        }
      : {
          uploadId: value.uploadId,
          chunkIndex: value.chunkIndex,
          nextChunkIndex: value.nextChunkIndex,
          nextOffsetBytes: value.nextOffsetBytes,
          state: value.state,
          outcome: value.outcome,
        };
  if (!Value.Check(ResultArtifactChunkResponseSchema, response)) {
    throw new Error("Artifact transaction service returned an invalid chunk response.");
  }
  return response;
};

const mapFinalizeResponse = (
  value: FinalizeResultArtifactUploadResponse,
): FinalizeResultArtifactUploadResponse => {
  const response: FinalizeResultArtifactUploadResponse = {
    state: value.state,
    replayed: value.replayed,
    artifact: {
      artifactId: value.artifact.artifactId,
      uploadId: value.artifact.uploadId,
      clientArtifactId: value.artifact.clientArtifactId,
      jobId: value.artifact.jobId,
      runAttemptId: value.artifact.runAttemptId,
      purpose: value.artifact.purpose,
      name: value.artifact.name,
      mediaType: value.artifact.mediaType,
      totalBytes: value.artifact.totalBytes,
      sha256: value.artifact.sha256,
    },
  };
  if (!Value.Check(FinalizeResultArtifactUploadResponseSchema, response)) {
    throw new Error("Artifact transaction service returned an invalid finalize response.");
  }
  return response;
};

const mapTerminateResponse = (
  value: TerminateResultArtifactUploadResponse,
): TerminateResultArtifactUploadResponse => {
  requireCanonicalTimestamp(value.terminatedAt, "termination response timestamp");
  const response: TerminateResultArtifactUploadResponse = {
    uploadId: value.uploadId,
    state: value.state,
    reason: value.reason,
    terminatedAt: value.terminatedAt,
    replayed: value.replayed,
  };
  return response;
};

export const registerWorkerArtifactRoutes = (
  app: FastifyInstance,
  dependencies: WorkerArtifactRouteDependencies,
): void => {
  const { config, transactions, shutdownSignal } = dependencies;
  const authenticateWorker = createWorkerAuthenticationHooks(config);

  app.post<{ Params: RunArtifactParameters; Body: CreateResultArtifactUploadRequest }>(
    "/api/v1/worker/runs/:runAttemptId/artifacts",
    {
      bodyLimit: maximumResultArtifactControlRequestBytes,
      schema: {
        params: runArtifactParametersRouteSchema,
        body: createRequestSchema,
        response: { 200: createResponseSchema, 201: createResponseSchema, ...errorResponses },
      },
      onRequest: authenticateWorker.onRequest,
      preValidation: [authenticateWorker.preValidation, validateCreateRequest],
    },
    async (request, reply) => {
      if (request.params.runAttemptId !== request.body.runAttemptId) {
        return routeIdentityMismatch(
          reply,
          "run_attempt_mismatch",
          "Route and body run attempt identifiers must match.",
        );
      }
      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      const body = request.body;
      const input: CreateResultArtifactUploadRequest = {
        jobId: body.jobId,
        runAttemptId: request.params.runAttemptId,
        workerNodeId,
        workerInstanceId: body.workerInstanceId,
        leaseToken: body.leaseToken,
        leaseGeneration: body.leaseGeneration,
        clientArtifactId: body.clientArtifactId,
        purpose: body.purpose,
        name: body.name,
        mediaType: body.mediaType,
        totalBytes: body.totalBytes,
        sha256: body.sha256,
      };
      try {
        const response = mapCreateResponse(
          await transactions.createArtifactUpload(input, shutdownSignal),
        );
        return reply.code(response.replayed ? 200 : 201).send(response);
      } catch (error) {
        return handleArtifactError(error, reply);
      }
    },
  );

  app.put<{ Params: ArtifactChunkParameters; Body: ResultArtifactChunkRequest }>(
    "/api/v1/worker/artifact-uploads/:uploadId/chunks/:chunkIndex",
    {
      bodyLimit: maximumResultArtifactChunkRequestBytes,
      schema: {
        params: artifactChunkParametersRouteSchema,
        body: chunkRequestSchema,
        response: { 200: chunkResponseSchema, ...errorResponses },
      },
      onRequest: authenticateWorker.onRequest,
      preValidation: [authenticateWorker.preValidation, validateChunkRequest],
    },
    async (request, reply) => {
      const pathChunkIndex = Number(request.params.chunkIndex);
      if (pathChunkIndex !== request.body.chunkIndex) {
        return routeIdentityMismatch(
          reply,
          "artifact_chunk_index_mismatch",
          "Route and body artifact chunk indexes must match.",
        );
      }
      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      const body = request.body;
      const input: ResultArtifactChunkRequest = {
        jobId: body.jobId,
        runAttemptId: body.runAttemptId,
        workerNodeId,
        workerInstanceId: body.workerInstanceId,
        leaseToken: body.leaseToken,
        leaseGeneration: body.leaseGeneration,
        chunkIndex: pathChunkIndex,
        offsetBytes: body.offsetBytes,
        chunkBytes: body.chunkBytes,
        chunkSha256: body.chunkSha256,
        data: body.data,
      };
      try {
        const response = mapChunkResponse(
          await transactions.putArtifactChunk(request.params.uploadId, input, shutdownSignal),
        );
        return reply.code(200).send(response);
      } catch (error) {
        return handleArtifactError(error, reply);
      }
    },
  );

  app.post<{ Params: ArtifactUploadParameters; Body: FinalizeResultArtifactUploadRequest }>(
    "/api/v1/worker/artifact-uploads/:uploadId/complete",
    {
      bodyLimit: maximumResultArtifactControlRequestBytes,
      schema: {
        params: artifactUploadParametersRouteSchema,
        body: finalizeRequestSchema,
        response: { 200: finalizeResponseSchema, ...errorResponses },
      },
      onRequest: authenticateWorker.onRequest,
      preValidation: [authenticateWorker.preValidation, validateFinalizeRequest],
    },
    async (request, reply) => {
      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      const body = request.body;
      const input: FinalizeResultArtifactUploadRequest = {
        jobId: body.jobId,
        runAttemptId: body.runAttemptId,
        workerNodeId,
        workerInstanceId: body.workerInstanceId,
        leaseToken: body.leaseToken,
        leaseGeneration: body.leaseGeneration,
        chunkCount: body.chunkCount,
        totalBytes: body.totalBytes,
        sha256: body.sha256,
      };
      try {
        const response = mapFinalizeResponse(
          await transactions.finalizeArtifactUpload(request.params.uploadId, input, shutdownSignal),
        );
        return reply.code(200).send(response);
      } catch (error) {
        return handleArtifactError(error, reply);
      }
    },
  );

  app.post<{ Params: ArtifactUploadParameters; Body: TerminateResultArtifactUploadRequest }>(
    "/api/v1/worker/artifact-uploads/:uploadId/terminate",
    {
      bodyLimit: maximumResultArtifactControlRequestBytes,
      schema: {
        params: artifactUploadParametersRouteSchema,
        body: terminateRequestSchema,
        response: { 200: terminateResponseSchema, ...errorResponses },
      },
      onRequest: authenticateWorker.onRequest,
      preValidation: [authenticateWorker.preValidation, validateTerminateRequest],
    },
    async (request, reply) => {
      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      const body = request.body;
      const input: TerminateResultArtifactUploadRequest = {
        jobId: body.jobId,
        runAttemptId: body.runAttemptId,
        workerNodeId,
        workerInstanceId: body.workerInstanceId,
        leaseToken: body.leaseToken,
        leaseGeneration: body.leaseGeneration,
        state: body.state,
        reason: body.reason,
      };
      try {
        const response = mapTerminateResponse(
          await transactions.terminateArtifactUpload(
            request.params.uploadId,
            input,
            shutdownSignal,
          ),
        );
        return reply.code(200).send(response);
      } catch (error) {
        return handleArtifactError(error, reply);
      }
    },
  );
};
