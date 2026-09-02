import { setTimeout as delay } from "node:timers/promises";
import {
  type ActiveLeaseHeartbeat,
  type ArtifactRunCompletionSubmission,
  type ClaimLeaseRequest,
  ClaimLeaseRequestSchema,
  ExecutionPhaseSchema,
  maximumRunCompletionRequestBytes,
  maximumRunCompletionResultUtf8Bytes,
  type RunCompletionSubmission,
  RunCompletionSubmissionSchema,
  type RunFailureSubmission,
  RunFailureSubmissionSchema,
  RunTerminalResponseSchema,
  type WorkerHeartbeatRequest,
  WorkerHeartbeatRequestSchema,
  type WorkerHeartbeatResponse,
  type WorkerRegistrationRequest,
  WorkerRegistrationRequestSchema,
  type WorkerRegistrationResponse,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type ArtifactCompletionPort, ArtifactServiceError } from "../artifacts/index.js";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import {
  createWorkerAuthenticationHooks,
  createWorkerAuthenticationPreHandler,
  getAuthenticatedWorkerIdentity,
} from "../security/worker-identity.js";

interface RouteDependencies {
  readonly config: ServerConfig;
  readonly database: DatabaseClient;
  readonly artifactCompletion: ArtifactCompletionPort;
  readonly shutdownSignal: AbortSignal;
}

interface RunRouteParameters {
  readonly runAttemptId: string;
}

interface LeaseHeartbeatBody {
  readonly jobId: string;
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  readonly phase: ActiveLeaseHeartbeat["phase"];
  readonly progressSequence: number;
  readonly progress: unknown;
}

const entityIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;

const leaseFenceProperties = {
  jobId: entityIdSchema,
  workerNodeId: entityIdSchema,
  workerInstanceId: entityIdSchema,
  leaseToken: { type: "string", minLength: 32, maxLength: 1_024 },
  leaseGeneration: { type: "integer", minimum: 1 },
} as const;

const parametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runAttemptId"],
  properties: { runAttemptId: entityIdSchema },
} as const;

const inlineSchema = (schema: unknown): Record<string, unknown> => {
  const serialized = JSON.stringify(schema, (key, value: unknown) =>
    key === "$id" ? undefined : value,
  );
  if (serialized === undefined) {
    throw new Error("The route schema could not be serialized.");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
};

const registrationRequestSchema = inlineSchema(WorkerRegistrationRequestSchema);
const claimRequestSchema = inlineSchema(ClaimLeaseRequestSchema);
const workerHeartbeatSchema = inlineSchema(WorkerHeartbeatRequestSchema);
const executionPhaseSchema = inlineSchema(ExecutionPhaseSchema);
const runFailureSubmissionSchema = inlineSchema(RunFailureSubmissionSchema);
const runTerminalResponseSchema = inlineSchema(RunTerminalResponseSchema);

const validateRunCompletionRequest = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  let valid = false;
  try {
    valid = Value.Check(RunCompletionSubmissionSchema, request.body);
  } catch {
    valid = false;
  }
  if (!valid) {
    void reply.code(400).send({
      code: "request_validation_failed",
      message: "The request does not match the strict completion contract.",
      retryable: false,
    });
  }
};

const validateRunFailureRequest = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  let valid = false;
  try {
    valid = Value.Check(RunFailureSubmissionSchema, request.body);
  } catch {
    valid = false;
  }
  if (!valid) {
    void reply.code(400).send({
      code: "request_validation_failed",
      message: "The request does not match the strict failure contract.",
      retryable: false,
    });
  }
};

const handleTerminalDatabaseError = (error: unknown, reply: FastifyReply): FastifyReply => {
  if (error instanceof DatabaseRequestError && error.code === "TERMINAL_SUBMISSION_CONFLICT") {
    return reply.code(409).send({
      code: "terminal_submission_conflict",
      message: error.message,
      retryable: false,
    });
  }
  if (
    error instanceof DatabaseRequestError &&
    (error.code === "REVIEW_RESULT_INVALID" || error.code === "STORED_EXECUTION_TEMPLATE_INVALID")
  ) {
    return reply.code(422).send({
      code: error.code.toLowerCase(),
      message: error.message,
      retryable: false,
    });
  }
  throw error;
};

const handleArtifactCompletionError = (error: unknown, reply: FastifyReply): FastifyReply => {
  if (!(error instanceof ArtifactServiceError)) {
    throw error;
  }
  switch (error.code) {
    case "ARTIFACT_COMPLETION_TERMINAL_CONFLICT":
      return reply.code(409).send({
        code: "terminal_submission_conflict",
        message: error.message,
        retryable: false,
      });
    case "ARTIFACT_TRANSACTION_COMPLETION_MODE_MISMATCH":
      return reply.code(409).send({
        code: "artifact_completion_mode_mismatch",
        message: error.message,
        retryable: false,
      });
    case "ARTIFACT_TRANSACTION_LEASE_LOST":
      return reply.code(409).send({
        code: "lease_lost",
        message: error.message,
        retryable: false,
      });
    case "ARTIFACT_COMPLETION_RESULT_DIGEST_MISMATCH":
      return reply.code(400).send({
        code: "result_digest_mismatch",
        message: error.message,
        retryable: false,
      });
    case "ARTIFACT_COMPLETION_RESULT_ENCODING_INVALID":
      return reply.code(422).send({
        code: "artifact_result_encoding_invalid",
        message: error.message,
        retryable: false,
      });
    case "ARTIFACT_COMPLETION_RESULT_JSON_INVALID":
      return reply.code(422).send({
        code: "artifact_result_json_invalid",
        message: error.message,
        retryable: false,
      });
    case "ARTIFACT_COMPLETION_RESULT_INVALID":
      return reply.code(422).send({
        code: "review_result_invalid",
        message: error.message,
        retryable: false,
      });
    case "ARTIFACT_COMPLETION_STORED_TEMPLATE_INVALID":
      return reply.code(422).send({
        code: "stored_execution_template_invalid",
        message: error.message,
        retryable: false,
      });
    case "ARTIFACT_TRANSACTION_BUSY":
      return reply.code(429).send({
        code: "artifact_transaction_busy",
        message: error.message,
        retryable: true,
      });
    case "ARTIFACT_TRANSACTION_CANCELLED":
    case "ARTIFACT_TRANSACTION_NOT_READY":
    case "ARTIFACT_TRANSACTION_TIMEOUT":
      return reply.code(503).send({
        code: error.code.toLowerCase(),
        message: error.message,
        retryable: true,
      });
    case "ARTIFACT_TRANSACTION_STORAGE_INTEGRITY":
      return reply.code(503).send({
        code: "artifact_storage_integrity",
        message: error.message,
        retryable: false,
      });
    default:
      return reply.code(503).send({
        code: "artifact_service_unavailable",
        message: "Artifact completion is unavailable.",
        retryable: false,
      });
  }
};

const exceedsReviewResultLimit = (result: unknown): boolean => {
  try {
    const serialized = JSON.stringify(result);
    return (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > maximumRunCompletionResultUtf8Bytes
    );
  } catch {
    return true;
  }
};

const sendLeaseLost = (runAttemptId: string) => ({
  runAttemptId,
  leaseGeneration: 1,
  action: "stale" as const,
  leaseExpiresAt: null,
  reasonCode: "lease_lost",
});

const heartbeatOneLease = async (
  database: DatabaseClient,
  config: ServerConfig,
  heartbeat: ActiveLeaseHeartbeat,
) => {
  try {
    const result = await database.request("heartbeatLease", {
      jobId: heartbeat.jobId,
      runAttemptId: heartbeat.runAttemptId,
      workerNodeId: heartbeat.workerNodeId,
      workerInstanceId: heartbeat.workerInstanceId,
      leaseToken: heartbeat.leaseToken,
      leaseGeneration: heartbeat.leaseGeneration,
      phase: heartbeat.phase,
      progressSequence: heartbeat.progressSequence,
      progress: {
        lastProgressAt: heartbeat.lastProgressAt,
        elapsedMs: heartbeat.elapsedMs,
        processCount: heartbeat.processCount,
      },
      leaseTtlSeconds: config.leaseTtlSeconds,
    });
    return {
      runAttemptId: heartbeat.runAttemptId,
      leaseGeneration: heartbeat.leaseGeneration,
      action: result.command,
      leaseExpiresAt: result.leaseExpiresAt,
    };
  } catch (error) {
    if (error instanceof DatabaseRequestError && error.code === "LEASE_LOST") {
      return {
        ...sendLeaseLost(heartbeat.runAttemptId),
        leaseGeneration: heartbeat.leaseGeneration,
      };
    }
    throw error;
  }
};

export const registerWorkerRoutes = (
  app: FastifyInstance,
  dependencies: RouteDependencies,
): void => {
  const { config, database, artifactCompletion, shutdownSignal } = dependencies;
  const authenticateWorker = createWorkerAuthenticationPreHandler(config);
  const authenticateTerminalWorker = createWorkerAuthenticationHooks(config);

  const registerWorker = async (
    request: FastifyRequest<{ Body: WorkerRegistrationRequest }>,
    reply: FastifyReply,
  ) => {
    if (request.body.protocolVersion !== config.protocolVersion) {
      return reply.code(409).send({
        code: "protocol_version_unsupported",
        message: `Server protocol version is ${config.protocolVersion}.`,
        retryable: false,
      });
    }

    const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
    const worker = await database.request("registerWorker", {
      ...request.body,
      workerNodeId,
    });
    const response: WorkerRegistrationResponse = {
      protocolVersion: "1.0",
      workerId: worker.workerId,
      state: worker.status,
      heartbeatIntervalMs: config.heartbeatIntervalSeconds * 1_000,
      leaseTtlMs: config.leaseTtlSeconds * 1_000,
      serverTime: new Date().toISOString(),
    };
    return reply.code(200).send(response);
  };
  app.post<{ Body: WorkerRegistrationRequest }>(
    "/api/v1/worker/instances",
    {
      schema: { body: registrationRequestSchema },
      preHandler: authenticateWorker,
    },
    registerWorker,
  );

  app.post<{ Body: ClaimLeaseRequest }>(
    "/api/v1/worker/leases/claim",
    {
      schema: { body: claimRequestSchema },
      preHandler: authenticateWorker,
    },
    async (request) => {
      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      const waitSeconds = Math.min(request.body.waitSeconds ?? 0, config.maxLongPollSeconds);
      const deadline = Date.now() + waitSeconds * 1_000;

      while (!shutdownSignal.aborted) {
        const result = await database.request("claimLease", {
          ...request.body,
          workerNodeId,
          protocolVersion: request.body.protocolVersion,
          leaseTtlSeconds: config.leaseTtlSeconds,
        });
        if (result.outcome !== "no_work" || Date.now() >= deadline) {
          return { ...result, serverTime: new Date().toISOString() };
        }

        const remaining = deadline - Date.now();
        try {
          await delay(Math.min(1_000, remaining), undefined, {
            signal: shutdownSignal,
          });
        } catch {
          break;
        }
      }

      return {
        outcome: "no_work" as const,
        retryAfterMs: 1_000,
        serverTime: new Date().toISOString(),
      };
    },
  );

  app.put<{
    Params: { readonly workerInstanceId: string };
    Body: WorkerHeartbeatRequest;
  }>(
    "/api/v1/worker/instances/:workerInstanceId/heartbeat",
    {
      schema: { body: workerHeartbeatSchema },
      preHandler: authenticateWorker,
    },
    async (request, reply) => {
      if (request.params.workerInstanceId !== request.body.workerInstanceId) {
        return reply.code(400).send({
          code: "worker_instance_mismatch",
          message: "Route and body worker instance identifiers must match.",
          retryable: false,
        });
      }
      if (request.body.protocolVersion !== config.protocolVersion) {
        return reply.code(409).send({
          code: "protocol_version_unsupported",
          message: `Server protocol version is ${config.protocolVersion}.`,
          retryable: false,
        });
      }

      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      const worker = await database.request("heartbeatWorker", {
        workerNodeId,
        workerInstanceId: request.body.workerInstanceId,
        heartbeatSequence: request.body.heartbeatSequence,
        availableSlots: request.body.availableSlots,
        health: request.body.health,
      });
      const commands = await Promise.all(
        request.body.activeLeases.map((heartbeat) =>
          heartbeatOneLease(database, config, {
            ...heartbeat,
            workerNodeId,
          }),
        ),
      );
      const response: WorkerHeartbeatResponse = {
        serverTime: new Date().toISOString(),
        nextHeartbeatInMs: config.heartbeatIntervalSeconds * 1_000,
        workerState: worker.state,
        commands,
      };
      return response;
    },
  );

  app.put<{ Params: RunRouteParameters; Body: LeaseHeartbeatBody }>(
    "/api/v1/worker/leases/:runAttemptId/heartbeat",
    {
      schema: {
        params: parametersSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: [...Object.keys(leaseFenceProperties), "phase", "progressSequence", "progress"],
          properties: {
            ...leaseFenceProperties,
            phase: executionPhaseSchema,
            progressSequence: { type: "integer", minimum: 0 },
            progress: {},
          },
        },
      },
      preHandler: authenticateWorker,
    },
    async (request) => {
      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      const result = await database.request("heartbeatLease", {
        ...request.body,
        runAttemptId: request.params.runAttemptId,
        workerNodeId,
        leaseTtlSeconds: config.leaseTtlSeconds,
      });
      return { ...result, serverTime: new Date().toISOString() };
    },
  );

  app.post<{ Params: RunRouteParameters; Body: RunCompletionSubmission }>(
    "/api/v1/worker/runs/:runAttemptId/complete",
    {
      bodyLimit: maximumRunCompletionRequestBytes,
      schema: {
        params: parametersSchema,
        response: { 200: runTerminalResponseSchema },
      },
      onRequest: authenticateTerminalWorker.onRequest,
      preValidation: [authenticateTerminalWorker.preValidation, validateRunCompletionRequest],
    },
    async (request, reply) => {
      if (request.params.runAttemptId !== request.body.runAttemptId) {
        return reply.code(400).send({
          code: "run_attempt_mismatch",
          message: "Route and body run attempt identifiers must match.",
          retryable: false,
        });
      }
      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      if ("result" in request.body) {
        if (exceedsReviewResultLimit(request.body.result)) {
          return reply.code(413).send({
            code: "review_result_too_large",
            message: "The review result exceeds the permitted UTF-8 byte size.",
            retryable: false,
          });
        }
        try {
          return await database.request("completeLease", {
            ...request.body,
            runAttemptId: request.params.runAttemptId,
            workerNodeId,
          });
        } catch (error) {
          return handleTerminalDatabaseError(error, reply);
        }
      }
      const body = request.body as ArtifactRunCompletionSubmission;
      try {
        return await artifactCompletion.completeArtifactRun(
          {
            jobId: body.jobId,
            runAttemptId: request.params.runAttemptId,
            workerNodeId,
            workerInstanceId: body.workerInstanceId,
            leaseToken: body.leaseToken,
            leaseGeneration: body.leaseGeneration,
            artifactId: body.artifactId,
            resultDigest: body.resultDigest,
          },
          shutdownSignal,
        );
      } catch (error) {
        return handleArtifactCompletionError(error, reply);
      }
    },
  );

  app.post<{ Params: RunRouteParameters; Body: RunFailureSubmission }>(
    "/api/v1/worker/runs/:runAttemptId/fail",
    {
      schema: {
        params: parametersSchema,
        body: runFailureSubmissionSchema,
        response: { 200: runTerminalResponseSchema },
      },
      onRequest: authenticateTerminalWorker.onRequest,
      preValidation: [authenticateTerminalWorker.preValidation, validateRunFailureRequest],
    },
    async (request, reply) => {
      if (request.params.runAttemptId !== request.body.runAttemptId) {
        return reply.code(400).send({
          code: "run_attempt_mismatch",
          message: "Route and body run attempt identifiers must match.",
          retryable: false,
        });
      }
      const { workerNodeId } = getAuthenticatedWorkerIdentity(request);
      try {
        return await database.request("failLease", {
          runAttemptId: request.params.runAttemptId,
          jobId: request.body.jobId,
          workerNodeId,
          workerInstanceId: request.body.workerInstanceId,
          leaseToken: request.body.leaseToken,
          leaseGeneration: request.body.leaseGeneration,
          failureCode: request.body.code,
          failureMessage: request.body.message,
          retryable: request.body.retryable,
          retryDelaySeconds: config.retryDelaySeconds,
        });
      } catch (error) {
        return handleTerminalDatabaseError(error, reply);
      }
    },
  );
};
