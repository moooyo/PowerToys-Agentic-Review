import {
  AppendEvidenceChunkRequestSchema,
  BeginEvidenceUploadRequestSchema,
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  EvidenceUploadResponseSchema,
  FinalizeEvidenceUploadRequestSchema,
  getEvidenceChunkDecodedBytes,
  type LeaseIdentity,
  maximumAttemptEvidenceAssets,
  maximumEvidenceChunkBytes,
} from "@agentic-review/contracts";
import rateLimit from "@fastify/rate-limit";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../database/database-client.js";
import type { EvidenceAssetScope } from "../database/evidence-assets.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import {
  createWorkerAuthenticationHooks,
  getAuthenticatedWorkerIdentity,
} from "../security/worker-identity.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  configurationEntityId,
  configurationQuery,
  createConfigurationAuthorization,
  parseConfigurationBody,
  validateConfigurationResponse,
} from "./configuration-support.js";
import {
  type EvidenceDownloadChunk,
  EvidenceHttpError,
  sendEvidenceContent,
  sendEvidenceError,
  unavailableDuringShutdown,
  validateEvidenceDownloadChunk,
} from "./evidence-stream.js";

const evidencePath =
  "/api/v1/operator/repositories/:repositoryId/review-runs/:runId/jobs/:jobId/attempts/:runAttemptId/evidence";
export const EVIDENCE_ASSET_PATHS = {
  begin: "/api/v1/worker/evidence/uploads",
  append: "/api/v1/worker/evidence/:assetId/chunks",
  finalize: "/api/v1/worker/evidence/:assetId/finalize",
  list: evidencePath,
  manifest: `${evidencePath}/:assetId`,
  content: `${evidencePath}/:assetId/content`,
} as const;

// One full attempt can contain 256 large chunks plus begin/finalize requests for 256 assets.
export const WORKER_EVIDENCE_REQUESTS_PER_MINUTE = 1_200;
const maximumEvidenceRequestBytes = 1_024 * 1_024;

export interface WorkerEvidenceRouteDependencies {
  readonly database: DatabaseClient;
  readonly config: Pick<ServerConfig, "recoveryMaintenance">;
  readonly shutdownSignal: AbortSignal;
}

export interface OperatorEvidenceRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly shutdownSignal: AbortSignal;
}

function parameter(request: FastifyRequest, name: string): string {
  return configurationEntityId((request.params as Record<string, unknown>)[name]);
}

function readScope(request: FastifyRequest): EvidenceAssetScope {
  configurationQuery(request.query, []);
  return {
    repositoryId: parameter(request, "repositoryId"),
    runId: parameter(request, "runId"),
    jobId: parameter(request, "jobId"),
    runAttemptId: parameter(request, "runAttemptId"),
  };
}

function scopedManifest(
  scope: Partial<EvidenceAssetScope> & { readonly id?: string },
  finalized = false,
): TSchema {
  return Type.Intersect([
    EvidenceAssetManifestSchema,
    Type.Object({
      ...Object.fromEntries(
        Object.entries(scope).map(([key, value]) => [key, Type.Literal(value)]),
      ),
      ...(finalized ? { state: Type.Literal("finalized"), retiredAt: Type.Null() } : {}),
    }),
  ]);
}

function validateResponse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  return validateConfigurationResponse(schema, value);
}

function requireAssetId(request: FastifyRequest, bodyAssetId: string): string {
  const assetId = parameter(request, "assetId");
  if (assetId !== bodyAssetId) {
    throw new EvidenceHttpError(
      400,
      "evidence_invalid",
      "The evidence asset does not match the upload path.",
    );
  }
  return assetId;
}

function requireLeaseOwner(request: FastifyRequest, lease: LeaseIdentity): void {
  if (lease.workerNodeId !== getAuthenticatedWorkerIdentity(request).workerNodeId) {
    throw new EvidenceHttpError(
      403,
      "worker_identity_mismatch",
      "The evidence lease does not belong to the authenticated Worker.",
    );
  }
}

export function registerWorkerEvidenceRoutes(
  app: FastifyInstance,
  dependencies: WorkerEvidenceRouteDependencies,
): void {
  app.register(async (scope) => {
    const authenticate = createWorkerAuthenticationHooks(dependencies.database);
    scope.setErrorHandler((error, _request, reply) => sendEvidenceError(reply, error));
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (dependencies.config.recoveryMaintenance) {
        return reply.code(503).send({
          code: "worker_api_maintenance",
          message: "Worker API access is disabled during recovery maintenance.",
          retryable: true,
        });
      }
      unavailableDuringShutdown(dependencies.shutdownSignal);
      await authenticate.onRequest(request, reply);
    });
    scope.addHook("preValidation", authenticate.preValidation);
    await scope.register(rateLimit, { global: false });
    const limit = scope.createRateLimit({
      max: WORKER_EVIDENCE_REQUESTS_PER_MINUTE,
      timeWindow: "1 minute",
      keyGenerator: (request) => `evidence:${getAuthenticatedWorkerIdentity(request).workerNodeId}`,
    });
    scope.addHook("preHandler", async (request, reply) => {
      const result = await limit(request);
      if (!result.isAllowed && result.isExceeded) {
        reply.header("retry-after", Math.max(1, result.ttlInSeconds));
        return reply.code(429).send({
          code: "evidence_rate_limited",
          message:
            "The Worker evidence upload rate limit was reached. Retry after the indicated delay.",
          retryable: true,
        });
      }
    });

    scope.post(
      EVIDENCE_ASSET_PATHS.begin,
      { bodyLimit: maximumEvidenceRequestBytes },
      async (request, reply) => {
        configurationQuery(request.query, []);
        const input = parseConfigurationBody(BeginEvidenceUploadRequestSchema, request.body);
        requireLeaseOwner(request, input.lease);
        const result = validateResponse(
          EvidenceUploadResponseSchema,
          await dependencies.database.request("beginEvidenceUpload", input),
        );
        if (
          result.offset > input.metadata.sizeBytes ||
          (result.state === "finalized" && result.offset !== input.metadata.sizeBytes)
        ) {
          throw new EvidenceHttpError(
            502,
            "evidence_response_invalid",
            "The evidence upload offset is invalid.",
          );
        }
        return reply.send(result);
      },
    );

    scope.post(
      EVIDENCE_ASSET_PATHS.append,
      { bodyLimit: maximumEvidenceRequestBytes },
      async (request, reply) => {
        configurationQuery(request.query, []);
        const input = parseConfigurationBody(AppendEvidenceChunkRequestSchema, request.body);
        requireLeaseOwner(request, input.lease);
        const assetId = requireAssetId(request, input.assetId);
        const decodedBytes = getEvidenceChunkDecodedBytes(input.base64);
        if (decodedBytes === null) {
          throw new EvidenceHttpError(
            400,
            "evidence_invalid",
            "The evidence chunk exceeds the supported decoded size.",
          );
        }
        const result = validateResponse(
          Type.Intersect([
            EvidenceUploadResponseSchema,
            Type.Object({ assetId: Type.Literal(assetId) }),
          ]),
          await dependencies.database.request("appendEvidenceChunk", input),
        );
        if (result.offset < input.offset + decodedBytes) {
          throw new EvidenceHttpError(
            502,
            "evidence_response_invalid",
            "The evidence upload did not commit the submitted chunk.",
          );
        }
        return reply.send(result);
      },
    );

    scope.post(
      EVIDENCE_ASSET_PATHS.finalize,
      { bodyLimit: maximumEvidenceRequestBytes },
      async (request, reply) => {
        configurationQuery(request.query, []);
        const input = parseConfigurationBody(FinalizeEvidenceUploadRequestSchema, request.body);
        requireLeaseOwner(request, input.lease);
        const assetId = requireAssetId(request, input.assetId);
        const result = validateResponse(
          scopedManifest(
            { id: assetId, jobId: input.lease.jobId, runAttemptId: input.lease.runAttemptId },
            true,
          ),
          await dependencies.database.request("finalizeEvidenceUpload", input),
        );
        return reply.send(result);
      },
    );
  });
}

async function readChunk(
  database: Pick<DatabaseClient, "request">,
  scope: EvidenceAssetScope,
  assetId: string,
  offset: number,
  signal: AbortSignal,
  expectedManifest?: EvidenceAssetManifest,
): Promise<EvidenceDownloadChunk> {
  unavailableDuringShutdown(signal);
  const output = await database.request("readEvidenceAssetChunk", {
    ...scope,
    assetId,
    offset,
    maximumBytes: maximumEvidenceChunkBytes,
  });
  unavailableDuringShutdown(signal);
  return validateEvidenceDownloadChunk(
    output,
    offset,
    expectedManifest === undefined
      ? scopedManifest({ ...scope, id: assetId }, true)
      : Type.Const(expectedManifest),
  );
}
export function registerOperatorEvidenceRoutes(
  app: FastifyInstance,
  dependencies: OperatorEvidenceRouteDependencies,
): void {
  app.register(async (scope) => {
    const authorization = createConfigurationAuthorization(dependencies.operatorAuth);
    scope.setErrorHandler((error, _request, reply) => sendEvidenceError(reply, error));
    scope.addHook("onRequest", authorization.read);
    scope.get(EVIDENCE_ASSET_PATHS.list, async (request, reply) => {
      unavailableDuringShutdown(dependencies.shutdownSignal);
      const database = bindOperatorDatabase(dependencies.database, authorization.actor(request));
      const ownership = readScope(request);
      const schema = Type.Object(
        {
          items: Type.Array(scopedManifest(ownership), { maxItems: maximumAttemptEvidenceAssets }),
        },
        { additionalProperties: false },
      );
      return reply.send(
        validateResponse(schema, await database.request("listEvidenceAssets", ownership)),
      );
    });
    scope.get(EVIDENCE_ASSET_PATHS.manifest, async (request, reply) => {
      unavailableDuringShutdown(dependencies.shutdownSignal);
      const database = bindOperatorDatabase(dependencies.database, authorization.actor(request));
      const ownership = readScope(request);
      const assetId = parameter(request, "assetId");
      const result = await database.request("getEvidenceAsset", {
        ...ownership,
        assetId,
      });
      if (result === null)
        throw new EvidenceHttpError(
          404,
          "evidence_not_found",
          "The evidence asset was not found in this attempt.",
        );
      return reply.send(validateResponse(scopedManifest({ ...ownership, id: assetId }), result));
    });
    scope.get(EVIDENCE_ASSET_PATHS.content, async (request, reply) => {
      const database = bindOperatorDatabase(dependencies.database, authorization.actor(request));
      const ownership = readScope(request);
      const assetId = parameter(request, "assetId");
      return sendEvidenceContent(
        request,
        reply,
        dependencies.shutdownSignal,
        assetId,
        (offset, signal, expectedManifest) =>
          readChunk(database, ownership, assetId, offset, signal, expectedManifest),
      );
    });
  });
}
