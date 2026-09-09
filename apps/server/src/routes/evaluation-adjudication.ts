import * as C from "@agentic-review/contracts";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  ConfigurationHttpError,
  configurationPagination,
  configurationQuery,
  createConfigurationAuthorization,
  sendConfigurationError,
} from "./configuration-support.js";

const result =
  "/api/v1/operator/repositories/:repositoryId/evaluations/:evaluationId/cells/:cellId/results/:resultId";
export const EVALUATION_ADJUDICATION_PATHS = Object.freeze({
  context: `${result}/adjudications`,
  change: `${result}/adjudications/:occurrenceKey`,
  history: `${result}/adjudications/:occurrenceKey/history`,
});

export interface EvaluationAdjudicationRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  /** Restricts mutations to existing exact receipts, independently of owner recovery mode. */
  readonly readOnly?: boolean;
}

function invalid(): never {
  throw new ConfigurationHttpError(
    400,
    "evaluation_request_invalid",
    "The evaluation judgment request is invalid.",
  );
}

function check(condition: boolean): asserts condition {
  if (!condition)
    throw new ConfigurationHttpError(
      502,
      "evaluation_response_invalid",
      "The evaluation judgment response could not be validated.",
    );
}

function resultScope(request: FastifyRequest): C.EvaluationCellResultReadQuery {
  const params = request.params as Record<string, unknown>;
  const scope = {
    repositoryId: params.repositoryId,
    evaluationId: params.evaluationId,
    cellId: params.cellId,
    resultId: params.resultId,
  };
  if (C.getEvaluationCellResultReadQueryIssues(scope).length) invalid();
  return scope as C.EvaluationCellResultReadQuery;
}

function occurrenceScope(request: FastifyRequest): C.EvaluationAdjudicationScope {
  const scope = {
    ...resultScope(request),
    occurrenceKey: (request.params as Record<string, unknown>).occurrenceKey,
  };
  if (C.getEvaluationAdjudicationScopeIssues(scope).length) invalid();
  return scope as C.EvaluationAdjudicationScope;
}

function sameScope(
  actual: C.EvaluationCellResultReadQuery,
  expected: C.EvaluationCellResultReadQuery,
): boolean {
  return (
    actual.repositoryId === expected.repositoryId &&
    actual.evaluationId === expected.evaluationId &&
    actual.cellId === expected.cellId &&
    actual.resultId === expected.resultId
  );
}

function historyQuery(request: FastifyRequest): C.EvaluationAdjudicationHistoryQuery {
  const raw = configurationQuery(request.query, ["page", "pageSize"]);
  for (const entry of Object.values(raw)) if (!/^[1-9][0-9]*(?![\s\S])/u.test(entry)) invalid();
  const query = configurationPagination(raw);
  if (C.getEvaluationAdjudicationHistoryQueryIssues(query).length) invalid();
  return query;
}

function sameJudgment(
  actual: C.EvaluationFindingAdjudication,
  expected: C.EvaluationAdjudicationChangeRequest["judgment"],
): boolean {
  if (actual.kind !== expected.kind || actual.reason !== expected.reason) return false;
  if (actual.kind === "match" && expected.kind === "match")
    return actual.expectedFindingId === expected.expectedFindingId;
  if (actual.kind === "duplicate" && expected.kind === "duplicate")
    return actual.primaryOccurrenceKey === expected.primaryOccurrenceKey;
  return true;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DatabaseRequestError) {
    const failures: Record<string, [number, string]> = {
      DATABASE_READ_ONLY: [
        503,
        "New evaluation judgments are unavailable during recovery maintenance.",
      ],
      PLATFORM_INVALID: [400, "The evaluation judgment request is invalid."],
      PLATFORM_NOT_FOUND: [404, "The evaluation judgment was not found."],
      PLATFORM_FORBIDDEN: [403, "The operator does not have permission for this action."],
      PLATFORM_CONFLICT: [
        409,
        "The judgment changed or conflicts with the current finding matches.",
      ],
    };
    const failure = error.code === undefined ? undefined : failures[error.code];
    if (failure)
      return sendConfigurationError(
        reply,
        new ConfigurationHttpError(
          failure[0],
          error.code === "DATABASE_READ_ONLY"
            ? "configuration_read_only"
            : (error.code ?? "configuration_operation_failed").toLowerCase(),
          failure[1],
        ),
      );
  }
  return sendConfigurationError(reply, error);
}

function routeError(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const status =
    error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
      ? 413
      : error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
        ? 415
        : error.statusCode === 400
          ? 400
          : null;
  if (status !== null)
    return sendConfigurationError(
      reply,
      new ConfigurationHttpError(
        status,
        "evaluation_request_invalid",
        "The evaluation judgment request body is invalid or outside its supported limits.",
      ),
    );
  return sendError(reply, error);
}

export function registerEvaluationAdjudicationRoutes(
  app: FastifyInstance,
  dependencies: EvaluationAdjudicationRouteDependencies,
): void {
  // Authentication remains available in recovery so the owner can return authorized receipts.
  const authorization = createConfigurationAuthorization(dependencies.operatorAuth);
  const bound = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));
  const readOptions = { onRequest: authorization.read, errorHandler: routeError };

  app.get(EVALUATION_ADJUDICATION_PATHS.context, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const scope = resultScope(request);
      const value = await bound(request).request("getEvaluationAdjudicationContext", {
        ...scope,
        actor: authorization.actor(request),
      });
      check(C.getEvaluationAdjudicationContextIssues(value).length === 0);
      check(sameScope(value.scope, scope));
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put(
    EVALUATION_ADJUDICATION_PATHS.change,
    {
      onRequest: authorization.mutate,
      bodyLimit: C.maximumEvaluationAdjudicationChangeUtf8Bytes,
      errorHandler: routeError,
    },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const scope = occurrenceScope(request);
        if (C.getEvaluationAdjudicationChangeRequestIssues(request.body).length) invalid();
        const body = request.body as C.EvaluationAdjudicationChangeRequest;
        const actor = authorization.actor(request);
        const value = await bound(request).request("changeEvaluationAdjudication", {
          ...scope,
          actor,
          request: body,
          ...(dependencies.readOnly === true ? { replayOnly: true as const } : {}),
        });
        check(C.getEvaluationAdjudicationChangeIssues(value).length === 0);
        check(
          sameScope(value.scope, scope) &&
            value.scope.occurrenceKey === scope.occurrenceKey &&
            value.previousVersion === body.expectedVersion &&
            value.version === body.expectedVersion + 1 &&
            value.adjudication.resultDigest === body.resultDigest &&
            value.adjudication.actor.issuer === actor.issuer &&
            value.adjudication.actor.subject === actor.subject &&
            sameJudgment(value.adjudication, body.judgment),
        );
        return reply.send(value);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(EVALUATION_ADJUDICATION_PATHS.history, readOptions, async (request, reply) => {
    try {
      const scope = occurrenceScope(request);
      const query = historyQuery(request);
      const value = await bound(request).request("listEvaluationAdjudicationHistory", {
        ...scope,
        query,
        actor: authorization.actor(request),
      });
      check(C.getEvaluationAdjudicationHistoryIssues(value).length === 0);
      check(
        sameScope(value.scope, scope) &&
          value.scope.occurrenceKey === scope.occurrenceKey &&
          value.page === query.page &&
          value.pageSize === query.pageSize,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
