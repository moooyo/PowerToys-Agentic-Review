import * as C from "@agentic-review/contracts";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  configurationEntityId,
  configurationQuery,
  createConfigurationAuthorization,
  validateConfigurationResponse,
} from "./configuration-support.js";
import {
  EvidenceHttpError,
  sendEvidenceContent,
  sendEvidenceError,
  unavailableDuringShutdown,
  validateEvidenceDownloadChunk,
} from "./evidence-stream.js";

const evidence =
  "/api/v1/operator/repositories/:repositoryId/evaluations/:evaluationId/cells/:cellId/results/:resultId/evidence";
export const EVALUATION_EVIDENCE_PATHS = Object.freeze({
  list: evidence,
  manifest: `${evidence}/:assetId`,
  content: `${evidence}/:assetId/content`,
});

export interface EvaluationEvidenceRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly shutdownSignal: AbortSignal;
}

function invalidResponse(): never {
  throw new EvidenceHttpError(
    502,
    "evidence_response_invalid",
    "The evaluation evidence response could not be validated.",
  );
}
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof Error && "code" in error) {
    if (error.code === "PLATFORM_CORRUPT")
      return sendEvidenceError(
        reply,
        new EvidenceHttpError(
          502,
          "evidence_response_invalid",
          "The evaluation evidence response could not be validated.",
        ),
      );
    if (error.code === "PLATFORM_INVALID")
      return sendEvidenceError(
        reply,
        new EvidenceHttpError(
          400,
          "evidence_invalid",
          "The evaluation evidence request is invalid.",
        ),
      );
  }
  return sendEvidenceError(reply, error);
}
function response<T extends TSchema>(
  schema: T,
  value: unknown,
  issues: (value: unknown) => readonly string[],
): Static<T> {
  if (issues(value).length > 0) invalidResponse();
  return validateConfigurationResponse(schema, value);
}
function readScope(request: FastifyRequest): C.EvaluationCellResultReadQuery {
  configurationQuery(request.query, []);
  const params = request.params as Record<string, unknown>;
  const value = {
    repositoryId: configurationEntityId(params.repositoryId),
    evaluationId: configurationEntityId(params.evaluationId),
    cellId: configurationEntityId(params.cellId),
    resultId: configurationEntityId(params.resultId),
  };
  if (C.getEvaluationCellResultReadQueryIssues(value).length > 0)
    throw new EvidenceHttpError(
      400,
      "evidence_invalid",
      "The evaluation evidence scope is invalid.",
    );
  return value;
}
function assetScope(request: FastifyRequest): C.EvaluationResultEvidenceAssetQuery {
  const value = {
    ...readScope(request),
    assetId: configurationEntityId((request.params as Record<string, unknown>).assetId),
  };
  if (C.getEvaluationResultEvidenceAssetQueryIssues(value).length > 0)
    throw new EvidenceHttpError(
      400,
      "evidence_invalid",
      "The evaluation evidence asset scope is invalid.",
    );
  return value;
}
function matchesScope(
  binding: C.EvaluationEvidenceBinding,
  query: C.EvaluationCellResultReadQuery,
): boolean {
  return (
    binding.repositoryId === query.repositoryId &&
    binding.evaluationId === query.evaluationId &&
    binding.cellId === query.cellId &&
    binding.resultId === query.resultId
  );
}

export function registerEvaluationEvidenceRoutes(
  app: FastifyInstance,
  dependencies: EvaluationEvidenceRouteDependencies,
): void {
  app.register(async (scope) => {
    const authorization = createConfigurationAuthorization(dependencies.operatorAuth);
    scope.setErrorHandler((error, _request, reply) => sendError(reply, error));
    scope.addHook("onRequest", async (_request, reply) => {
      reply
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff");
    });
    scope.addHook("onRequest", authorization.read);
    scope.get(EVALUATION_EVIDENCE_PATHS.list, async (request, reply) => {
      unavailableDuringShutdown(dependencies.shutdownSignal);
      const query = readScope(request),
        actor = authorization.actor(request);
      const database = bindOperatorDatabase(dependencies.database, actor);
      const value = await database.request("listEvaluationResultEvidence", { ...query, actor });
      unavailableDuringShutdown(dependencies.shutdownSignal);
      const result = response(
        C.EvaluationResultEvidenceListV1Schema,
        value,
        C.getEvaluationResultEvidenceListIssues,
      );
      if (!matchesScope(result.binding, query)) invalidResponse();
      return reply.send(result);
    });
    scope.get(EVALUATION_EVIDENCE_PATHS.manifest, async (request, reply) => {
      unavailableDuringShutdown(dependencies.shutdownSignal);
      const query = assetScope(request),
        actor = authorization.actor(request);
      const database = bindOperatorDatabase(dependencies.database, actor);
      const value = await database.request("getEvaluationResultEvidenceAsset", { ...query, actor });
      unavailableDuringShutdown(dependencies.shutdownSignal);
      const result = response(
        C.EvaluationResultEvidenceAssetV1Schema,
        value,
        C.getEvaluationResultEvidenceAssetIssues,
      );
      if (!matchesScope(result.binding, query) || result.assetId !== query.assetId)
        invalidResponse();
      return reply.send(result);
    });
    scope.get(EVALUATION_EVIDENCE_PATHS.content, async (request, reply) => {
      const query = assetScope(request),
        actor = authorization.actor(request);
      if (request.headers.range !== undefined || request.headers["if-range"] !== undefined)
        throw new EvidenceHttpError(
          416,
          "evidence_range_not_supported",
          "Evaluation evidence does not support range requests.",
        );
      const database = bindOperatorDatabase(dependencies.database, actor);
      let selected: C.EvaluationResultEvidenceAssetV1 | undefined;
      return sendEvidenceContent(
        request,
        reply,
        dependencies.shutdownSignal,
        query.assetId,
        async (offset, signal, expectedManifest) => {
          unavailableDuringShutdown(signal);
          if (selected === undefined) {
            const value = await database.request("getEvaluationResultEvidenceAsset", {
              ...query,
              actor,
            });
            unavailableDuringShutdown(signal);
            const asset = response(
              C.EvaluationResultEvidenceAssetV1Schema,
              value,
              C.getEvaluationResultEvidenceAssetIssues,
            );
            if (!matchesScope(asset.binding, query) || asset.assetId !== query.assetId)
              invalidResponse();
            if (asset.manifest.state !== "finalized" || asset.manifest.retiredAt !== null)
              throw new EvidenceHttpError(
                410,
                "evidence_retired",
                "The evaluation evidence asset is no longer available.",
              );
            selected = structuredClone(asset);
          }
          const output = await database.request("readEvaluationResultEvidenceChunk", {
            ...query,
            actor,
            offset,
            maximumBytes: C.maximumEvidenceChunkBytes,
          });
          unavailableDuringShutdown(signal);
          return validateEvidenceDownloadChunk(
            output,
            offset,
            Type.Const(expectedManifest ?? selected.manifest),
            { binding: Type.Const(selected.binding) },
          );
        },
      );
    });
  });
}
