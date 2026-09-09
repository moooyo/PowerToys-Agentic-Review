import * as C from "@agentic-review/contracts";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import { EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE } from "../database/evaluation-assessments.js";
import { evaluationScoreInputDigest } from "../database/evaluation-observations.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  ConfigurationHttpError,
  configurationPagination,
  configurationQuery,
  createConfigurationAuthorization,
  sendConfigurationError,
} from "./configuration-support.js";

const evaluation = "/api/v1/operator/repositories/:repositoryId/evaluations/:evaluationId";
export const EVALUATION_ASSESSMENT_PATHS = Object.freeze({
  preview: `${evaluation}/score-preview`,
  assessments: `${evaluation}/assessments`,
  assessment: `${evaluation}/assessments/:assessmentId`,
  case: `${evaluation}/assessments/:assessmentId/cases/:caseId`,
});
export interface EvaluationAssessmentRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}
function invalid(): never {
  throw new ConfigurationHttpError(
    400,
    "evaluation_request_invalid",
    "The evaluation report request is invalid.",
  );
}
function check(condition: boolean): asserts condition {
  if (!condition)
    throw new ConfigurationHttpError(
      502,
      "evaluation_response_invalid",
      "The evaluation report response could not be validated.",
    );
}
function scope(request: FastifyRequest): C.EvaluationAssessmentScope {
  const params = request.params as Record<string, unknown>;
  const value = { repositoryId: params.repositoryId, evaluationId: params.evaluationId };
  if (C.getEvaluationAssessmentScopeIssues(value).length) invalid();
  return value as C.EvaluationAssessmentScope;
}
function readScope(request: FastifyRequest): C.EvaluationAssessmentReadQuery {
  const value = {
    ...scope(request),
    assessmentId: (request.params as Record<string, unknown>).assessmentId,
  };
  if (C.getEvaluationAssessmentReadQueryIssues(value).length) invalid();
  return value as C.EvaluationAssessmentReadQuery;
}
function sameScope(
  actual: C.EvaluationAssessmentScope,
  expected: C.EvaluationAssessmentScope,
): boolean {
  return (
    actual.repositoryId === expected.repositoryId && actual.evaluationId === expected.evaluationId
  );
}
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof DatabaseRequestError &&
    error.code === "PLATFORM_INVALID" &&
    error.message === EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE
  )
    return sendConfigurationError(
      reply,
      new ConfigurationHttpError(
        400,
        "evaluation_report_page_too_large",
        "Choose a smaller page size to load these reports.",
      ),
    );
  if (error instanceof DatabaseRequestError && error.code === "DATABASE_READ_ONLY")
    return sendConfigurationError(
      reply,
      new ConfigurationHttpError(
        503,
        "configuration_read_only",
        "New evaluation reports are unavailable during recovery maintenance.",
      ),
    );
  if (
    error instanceof DatabaseRequestError &&
    ["PLATFORM_INVALID", "PLATFORM_CONFLICT"].includes(error.code ?? "")
  )
    return sendConfigurationError(
      reply,
      new ConfigurationHttpError(
        error.code === "PLATFORM_INVALID" ? 400 : 409,
        (error.code ?? "PLATFORM_INVALID").toLowerCase(),
        error.code === "PLATFORM_INVALID"
          ? "The evaluation report request is invalid."
          : "The evaluation inputs or report version changed. Refresh the preview before saving.",
      ),
    );
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
  return status === null
    ? sendError(reply, error)
    : sendConfigurationError(
        reply,
        new ConfigurationHttpError(
          status,
          "evaluation_request_invalid",
          "The evaluation report request body is invalid or outside its supported limits.",
        ),
      );
}

export function registerEvaluationAssessmentRoutes(
  app: FastifyInstance,
  dependencies: EvaluationAssessmentRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(dependencies.operatorAuth);
  const bound = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));
  const readOptions = { onRequest: authorization.read, errorHandler: routeError };
  app.get(EVALUATION_ASSESSMENT_PATHS.preview, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const selected = scope(request);
      const value = await bound(request).request("getEvaluationScorePreview", {
        ...selected,
        actor: authorization.actor(request),
      });
      check(C.getEvaluationScorePreviewIssues(value).length === 0);
      check(
        sameScope(value, selected) &&
          value.inputDigest ===
            evaluationScoreInputDigest({
              ...selected,
              scorerVersion: value.summary.rulesVersion,
              scoringPlanDigest: value.scoringPlanDigest,
              observationDigest: value.observationDigest,
              adjudicationDigest: value.adjudicationDigest,
            }),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post(
    EVALUATION_ASSESSMENT_PATHS.assessments,
    {
      onRequest: authorization.mutate,
      errorHandler: routeError,
      bodyLimit: C.maximumEvaluationAssessmentReceiptUtf8Bytes,
    },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const selected = scope(request);
        if (C.getEvaluationAssessmentPublishRequestIssues(request.body).length) invalid();
        const body = request.body as C.EvaluationAssessmentPublishRequest;
        const actor = authorization.actor(request);
        const value = await bound(request).request("publishEvaluationAssessment", {
          ...selected,
          actor,
          request: body,
          ...(dependencies.readOnly === true ? { replayOnly: true as const } : {}),
        });
        check(C.getEvaluationAssessmentPublishResponseIssues(value).length === 0);
        check(
          sameScope(value, selected) &&
            value.version === body.expectedVersion + 1 &&
            value.createdBy.issuer === actor.issuer &&
            value.createdBy.subject === actor.subject &&
            body.expectedInputDigest ===
              evaluationScoreInputDigest({
                ...selected,
                scorerVersion: value.scorerVersion,
                scoringPlanDigest: value.scoringPlanDigest,
                observationDigest: value.observationDigest,
                adjudicationDigest: value.adjudicationDigest,
              }),
        );
        return reply.send(value);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get(EVALUATION_ASSESSMENT_PATHS.assessments, readOptions, async (request, reply) => {
    try {
      const raw = configurationQuery(request.query, ["page", "pageSize"]);
      for (const entry of Object.values(raw)) if (!/^[1-9][0-9]*(?![\s\S])/u.test(entry)) invalid();
      const query = configurationPagination(raw);
      if (C.getEvaluationAssessmentListQueryIssues(query).length) invalid();
      const selected = scope(request);
      const value = await bound(request).request("listEvaluationAssessments", {
        ...selected,
        query,
        actor: authorization.actor(request),
      });
      check(C.getEvaluationAssessmentListIssues(value).length === 0);
      check(
        sameScope(value, selected) &&
          value.page === query.page &&
          value.pageSize === query.pageSize,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get(EVALUATION_ASSESSMENT_PATHS.assessment, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const selected = readScope(request);
      const value = await bound(request).request("getEvaluationAssessment", {
        ...selected,
        actor: authorization.actor(request),
      });
      check(C.getEvaluationAssessmentSummaryIssues(value).length === 0);
      check(sameScope(value, selected) && value.assessmentId === selected.assessmentId);
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get(EVALUATION_ASSESSMENT_PATHS.case, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const raw = {
        ...readScope(request),
        caseId: (request.params as Record<string, unknown>).caseId,
      };
      if (C.getEvaluationAssessmentCaseReadQueryIssues(raw).length) invalid();
      const selected = raw as C.EvaluationAssessmentCaseReadQuery;
      const value = await bound(request).request("getEvaluationAssessmentCase", {
        ...selected,
        actor: authorization.actor(request),
      });
      check(C.getEvaluationAssessmentCaseIssues(value).length === 0);
      check(
        sameScope(value.scope, selected) &&
          value.scope.assessmentId === selected.assessmentId &&
          value.scope.caseId === selected.caseId,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
