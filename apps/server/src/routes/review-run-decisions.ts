import {
  maximumReviewRunDecisionPageSize,
  maximumReviewRunDecisionRequestUtf8Bytes,
  maximumReviewRunDecisionResponseUtf8Bytes,
  ReviewRunDecisionChangeRequestSchema,
  ReviewRunDecisionChangeResponseSchema,
  type ReviewRunDecisionContext,
  ReviewRunDecisionContextSchema,
  type ReviewRunDecisionEvent,
  ReviewRunDecisionHistoryResponseSchema,
  type ReviewRunDecisionPolicySnapshot,
} from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  ConfigurationHttpError,
  configurationEntityId,
  configurationPagination,
  configurationQuery,
  createConfigurationAuthorization,
  parseConfigurationBody,
  sendConfigurationError,
  validateConfigurationResponse,
} from "./configuration-support.js";

const decisionPath =
  "/api/v1/operator/repositories/:repositoryId/review-runs/:reviewRunId/decisions";
export const REVIEW_RUN_DECISION_PATHS = {
  context: decisionPath,
  change: decisionPath,
  history: `${decisionPath}/history`,
} as const;

export interface ReviewRunDecisionRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}

interface DecisionScope {
  readonly repositoryId: string;
  readonly reviewRunId: string;
}

function scopeFor(request: FastifyRequest): DecisionScope {
  const parameters = request.params as Record<string, unknown>;
  return {
    repositoryId: configurationEntityId(parameters.repositoryId),
    reviewRunId: configurationEntityId(parameters.reviewRunId),
  };
}

function invalidResponse(): never {
  throw new ConfigurationHttpError(
    502,
    "review_run_decision_response_invalid",
    "The review run decision response could not be validated.",
  );
}

function validateResponse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const result = validateConfigurationResponse(schema, value);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumReviewRunDecisionResponseUtf8Bytes)
    invalidResponse();
  return result;
}

function validateScope(value: DecisionScope, scope: DecisionScope): void {
  if (value.repositoryId !== scope.repositoryId || value.reviewRunId !== scope.reviewRunId)
    invalidResponse();
}

function effectiveBlockingFindingCount(
  policy: ReviewRunDecisionContext["policy"] | ReviewRunDecisionPolicySnapshot,
): number {
  if (policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2") {
    if (policy.unresolvedBlockingFindingCount > policy.blockingFindingCount) invalidResponse();
    return policy.unresolvedBlockingFindingCount;
  }
  return policy.blockingFindingCount;
}

function validateEvent(event: ReviewRunDecisionEvent, scope: DecisionScope): void {
  validateScope(event, scope);
  if (
    event.version !== event.previousVersion + 1 ||
    event.id === event.supersedesDecisionId ||
    event.id === event.targetDecisionId ||
    (event.previousVersion === 0 && event.supersedesDecisionId !== null) ||
    (event.action === "comment" && event.supersedesDecisionId !== null) ||
    (event.action === "withdraw" && event.targetDecisionId !== event.supersedesDecisionId)
  )
    invalidResponse();
  const policy = event.policyAtDecision;
  const blockingFindingCount = effectiveBlockingFindingCount(policy);
  if (
    policy.reasonCount < policy.reasonCodes.length ||
    (policy.reasonCount > 0 && policy.reasonCodes.length === 0) ||
    (policy.reasonCodesTruncated &&
      (policy.reasonCount <= policy.reasonCodes.length || policy.reasonCodes.length !== 128)) ||
    (policy.applicable && policy.eligible !== (policy.reasonCount === 0)) ||
    (policy.applicable &&
      policy.eligible &&
      (blockingFindingCount !== 0 || policy.reasonCount !== 0)) ||
    (event.action === "approve" && !policy.eligible)
  )
    invalidResponse();
}

function validateContext(value: ReviewRunDecisionContext, scope: DecisionScope): void {
  validateScope(value, scope);
  const policy = value.policy;
  const blockingFindingCount = effectiveBlockingFindingCount(policy);
  if (
    (value.sourceCurrent && value.revisionKey !== value.currentRevisionKey) ||
    value.canApprove !==
      (value.workItemKind === "pull_request" && value.sourceCurrent && policy.eligible === true) ||
    policy.reasonCount < policy.reasons.length ||
    policy.reasonsTruncated !== policy.reasonCount > policy.reasons.length ||
    (policy.reasonsTruncated && policy.reasons.length !== 128) ||
    (policy.applicable && policy.eligible !== (policy.reasonCount === 0)) ||
    (policy.applicable &&
      policy.eligible &&
      (blockingFindingCount !== 0 || policy.reasonCount !== 0))
  )
    invalidResponse();
  const event = value.recordedDecision;
  if (event === null) {
    if (value.recordedDecisionState !== "none" || value.stateReasons.length !== 0)
      invalidResponse();
    return;
  }
  validateEvent(event, scope);
  if (
    event.workItemId !== value.workItemId ||
    event.workItemKind !== value.workItemKind ||
    event.revisionKey !== value.revisionKey ||
    event.planDigest !== value.planDigest ||
    event.version > value.version ||
    event.action === "comment"
  )
    invalidResponse();
  if (
    event.resultSetDigest === value.resultSetDigest &&
    (event.policyAtDecision.policyVersion !== policy.policyVersion ||
      (policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2" &&
        event.policyAtDecision.policyVersion === "required-checks-and-unresolved-p0-p1-v2" &&
        event.policyAtDecision.findingDispositionDigest !== policy.findingDispositionDigest))
  )
    invalidResponse();
  const reasons: ReviewRunDecisionContext["stateReasons"] = [];
  let state: ReviewRunDecisionContext["recordedDecisionState"];
  if (event.action === "withdraw") {
    state = "withdrawn";
  } else {
    if (event.resultSetDigest !== value.resultSetDigest) reasons.push("result_set_changed");
    if (!value.sourceCurrent) reasons.push("source_not_current");
    if (event.action === "approve" && policy.eligible !== true)
      reasons.push("approval_policy_not_satisfied");
    state =
      event.resultSetDigest !== value.resultSetDigest || !value.sourceCurrent
        ? "stale"
        : event.action === "approve" && policy.eligible !== true
          ? "ineligible"
          : "current";
  }
  if (
    value.recordedDecisionState !== state ||
    value.stateReasons.length !== reasons.length ||
    reasons.some((reason) => !value.stateReasons.includes(reason))
  )
    invalidResponse();
}

export function registerReviewRunDecisionRoutes(
  app: FastifyInstance,
  dependencies: ReviewRunDecisionRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(
    dependencies.operatorAuth,
    dependencies.readOnly,
  );
  const authorize =
    (mutation: boolean): onRequestAsyncHookHandler =>
    async (request, reply) => {
      try {
        return await (mutation ? authorization.mutate : authorization.read).call(
          app,
          request,
          reply,
        );
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    };
  const databaseFor = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));

  app.get(
    REVIEW_RUN_DECISION_PATHS.context,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const scope = scopeFor(request);
        const value = validateResponse(
          ReviewRunDecisionContextSchema,
          await databaseFor(request).request("getReviewRunDecisionContext", {
            ...scope,
            actor: authorization.actor(request),
          }),
        );
        validateContext(value, scope);
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  app.get(
    REVIEW_RUN_DECISION_PATHS.history,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        const query = configurationQuery(request.query, ["page", "pageSize"]);
        const pagination = configurationPagination(query);
        if (pagination.pageSize > maximumReviewRunDecisionPageSize)
          throw new ConfigurationHttpError(
            400,
            "configuration_query_invalid",
            "The decision history page size is outside the supported bounds.",
          );
        const scope = scopeFor(request);
        const value = validateResponse(
          ReviewRunDecisionHistoryResponseSchema,
          await databaseFor(request).request("listReviewRunDecisionHistory", {
            ...scope,
            ...pagination,
            actor: authorization.actor(request),
          }),
        );
        validateScope(value, scope);
        const offset = (pagination.page - 1) * pagination.pageSize;
        if (
          value.page !== pagination.page ||
          value.pageSize !== pagination.pageSize ||
          value.items.length !== Math.min(pagination.pageSize, Math.max(0, value.total - offset))
        )
          invalidResponse();
        for (const [index, event] of value.items.entries()) {
          validateEvent(event, scope);
          const first = value.items[0];
          if (
            event.version !== value.total - offset - index ||
            (first !== undefined &&
              (event.workItemId !== first.workItemId ||
                event.workItemKind !== first.workItemKind ||
                event.revisionKey !== first.revisionKey ||
                event.planDigest !== first.planDigest))
          )
            invalidResponse();
        }
        if (
          new Set(value.items.map((event) => event.id)).size !== value.items.length ||
          new Set(value.items.map((event) => event.changeId)).size !== value.items.length
        )
          invalidResponse();
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  app.post(
    REVIEW_RUN_DECISION_PATHS.change,
    { bodyLimit: maximumReviewRunDecisionRequestUtf8Bytes, onRequest: authorize(true) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const scope = scopeFor(request);
        const input = parseConfigurationBody(ReviewRunDecisionChangeRequestSchema, request.body);
        if (input.expectedVersion === Number.MAX_SAFE_INTEGER)
          throw new ConfigurationHttpError(
            400,
            "configuration_request_invalid",
            "The decision version cannot be incremented safely.",
          );
        const actor = authorization.actor(request);
        const value = validateResponse(
          ReviewRunDecisionChangeResponseSchema,
          await databaseFor(request).request("changeReviewRunDecision", {
            ...scope,
            actor,
            ...input,
          }),
        );
        const event = value.change;
        validateEvent(event, scope);
        if (
          event.changeId !== input.changeId ||
          event.actor.issuer !== actor.issuer ||
          event.actor.subject !== actor.subject ||
          event.action !== input.action ||
          event.reason !== input.reason.trim() ||
          event.revisionKey !== input.expectedRevisionKey ||
          event.planDigest !== input.expectedPlanDigest ||
          event.resultSetDigest !== input.expectedResultSetDigest ||
          event.previousVersion !== input.expectedVersion ||
          event.version !== input.expectedVersion + 1 ||
          event.targetDecisionId !== (input.action === "withdraw" ? input.targetDecisionId : null)
        )
          invalidResponse();
        return reply.code(value.replayed ? 200 : 201).send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
}
