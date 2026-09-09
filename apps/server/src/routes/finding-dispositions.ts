import {
  type FindingComparisonResponse,
  FindingComparisonResponseSchema,
  type FindingDisposition,
  type FindingDispositionChangeRequest,
  FindingDispositionChangeRequestSchema,
  FindingDispositionChangeResponseSchema,
  type FindingDispositionEvent,
  FindingDispositionHistoryResponseSchema,
  type FindingListResponse,
  FindingListResponseSchema,
  type FindingOccurrence,
  type FindingOccurrenceRef,
  type FindingResultContext,
  maximumFindingDispositionPageSize,
  maximumFindingDispositionRequestUtf8Bytes,
  maximumFindingDispositionResponseUtf8Bytes,
  Sha256Schema,
} from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
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

const findingPath =
  "/api/v1/operator/repositories/:repositoryId/review-runs/:reviewRunId/requests/:requestId/jobs/:jobId/findings";
export const FINDING_DISPOSITION_PATHS = {
  list: findingPath,
  comparison: `${findingPath}/comparison`,
  history: `${findingPath}/:occurrenceKey/history`,
  change: `${findingPath}/:occurrenceKey/disposition`,
} as const;

export interface FindingDispositionRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}

interface FindingScope {
  readonly repositoryId: string;
  readonly reviewRunId: string;
  readonly requestId: string;
  readonly jobId: string;
}
interface Pagination {
  readonly page: number;
  readonly pageSize: number;
}
const states: Record<FindingDispositionChangeRequest["action"], FindingDisposition["state"]> = {
  accept: "accepted",
  dismiss: "dismissed",
  resolve: "resolved",
  reopen: "open",
};

function scopeFor(request: FastifyRequest): FindingScope {
  const parameters = request.params as Record<string, unknown>;
  return {
    repositoryId: configurationEntityId(parameters.repositoryId),
    reviewRunId: configurationEntityId(parameters.reviewRunId),
    requestId: configurationEntityId(parameters.requestId),
    jobId: configurationEntityId(parameters.jobId),
  };
}
function occurrenceKeyFor(request: FastifyRequest): string {
  return parseConfigurationBody(
    Sha256Schema,
    (request.params as Record<string, unknown>).occurrenceKey,
  );
}
function paginationFor(query: Record<string, string>): Pagination {
  const pagination = configurationPagination(query);
  if (pagination.pageSize > maximumFindingDispositionPageSize)
    throw new ConfigurationHttpError(
      400,
      "configuration_query_invalid",
      "The finding page size is outside the supported bounds.",
    );
  return pagination;
}
function invalidResponse(): never {
  throw new ConfigurationHttpError(
    502,
    "finding_disposition_response_invalid",
    "The finding disposition response could not be validated.",
  );
}
function validateResponse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const result = validateConfigurationResponse(schema, value);
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") > maximumFindingDispositionResponseUtf8Bytes
  )
    invalidResponse();
  return result;
}
function validateScope(value: FindingScope, scope: FindingScope): void {
  if (
    value.repositoryId !== scope.repositoryId ||
    value.reviewRunId !== scope.reviewRunId ||
    value.requestId !== scope.requestId ||
    value.jobId !== scope.jobId
  )
    invalidResponse();
}
function validatePage(
  value: Pagination & { readonly total: number; readonly items: unknown[] },
  pagination: Pagination,
): void {
  const offset = (pagination.page - 1) * pagination.pageSize;
  if (
    value.page !== pagination.page ||
    value.pageSize !== pagination.pageSize ||
    value.items.length !== Math.min(pagination.pageSize, Math.max(0, value.total - offset))
  )
    invalidResponse();
}
function validateRef(
  ref: FindingOccurrenceRef,
  context?: Pick<FindingResultContext, "resultId" | "resultDigest" | "findingCount">,
): void {
  const expected = sha256(
    canonicalJson({
      schemaVersion: "FindingOccurrenceV1",
      resultId: ref.resultId,
      resultDigest: ref.resultDigest,
      kind: ref.kind,
      ordinal: ref.ordinal,
    }),
  );
  if (
    ref.key !== expected ||
    (context !== undefined &&
      (ref.resultId !== context.resultId ||
        ref.resultDigest !== context.resultDigest ||
        ref.ordinal >= context.findingCount))
  )
    invalidResponse();
}
function validateContext(value: FindingResultContext, scope: FindingScope): void {
  validateScope(value, scope);
  if (
    value.historical !== (!value.sourceCurrent || !value.latestForRequest) ||
    (value.modelAvailability !== "complete" && value.findingCount !== 0) ||
    (value.workItemKind === "pull_request") !== value.workflowKind.startsWith("pr_") ||
    (value.workflowKind === "issue_triage" && value.modelAvailability !== "not_applicable") ||
    ((value.workflowKind === "pr_static_build" || value.workflowKind === "issue_triage") &&
      value.target !== "headless") ||
    (value.workflowKind === "pr_ui" && value.target === "headless")
  )
    invalidResponse();
}
function reasonIsValid(reason: string): boolean {
  return (
    reason.isWellFormed() &&
    reason.trim().length > 0 &&
    ![...reason].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)
      );
    })
  );
}
function validateDisposition(value: FindingDisposition): void {
  const empty = value.version === 0;
  if (
    (empty && value.state !== "open") ||
    (value.lastEventId === null) !== empty ||
    (value.updatedAt === null) !== empty ||
    (value.updatedBy === null) !== empty
  )
    invalidResponse();
}
function validateOccurrence(value: FindingOccurrence, context: FindingResultContext): void {
  validateRef(value, context);
  validateDisposition(value.disposition);
  if (
    (value.path === null && (value.line !== null || value.endLine !== null)) ||
    (value.endLine !== null && (value.line === null || value.endLine < value.line)) ||
    (value.kind === "pr_finding" &&
      (context.workflowKind !== "pr_static_build" ||
        value.path === null ||
        value.line === null ||
        value.confidence === null)) ||
    (value.kind === "validation_observation" &&
      (!["pr_ui", "issue_validation"].includes(context.workflowKind) ||
        value.endLine !== null ||
        value.confidence !== null))
  )
    invalidResponse();
}
function validateList(
  value: FindingListResponse,
  scope: FindingScope,
  pagination: Pagination,
): void {
  validateContext(value.context, scope);
  validatePage(value, pagination);
  const summary = value.summary;
  if (
    value.total !== value.context.findingCount ||
    summary.open + summary.accepted + summary.dismissed + summary.resolved !== value.total ||
    summary.rawBlocking > value.total ||
    summary.unresolvedBlocking > summary.rawBlocking ||
    summary.unresolvedBlocking > summary.open + summary.accepted ||
    summary.rawBlocking - summary.unresolvedBlocking > summary.dismissed + summary.resolved ||
    new Set(value.items.map((item) => item.key)).size !== value.items.length
  )
    invalidResponse();
  const counts = {
    open: 0,
    accepted: 0,
    dismissed: 0,
    resolved: 0,
    rawBlocking: 0,
    unresolvedBlocking: 0,
  };
  for (const item of value.items) {
    validateOccurrence(item, value.context);
    counts[item.disposition.state] += 1;
    if (item.priority <= 1) {
      counts.rawBlocking += 1;
      if (item.disposition.state === "open" || item.disposition.state === "accepted")
        counts.unresolvedBlocking += 1;
    }
  }
  const remaining = value.total - value.items.length;
  for (const key of Object.keys(counts) as (keyof typeof counts)[])
    if (summary[key] < counts[key] || summary[key] > counts[key] + remaining) invalidResponse();
}
function validateEvent(event: FindingDispositionEvent, scope: FindingScope, key: string): void {
  validateScope(event, scope);
  validateRef(event.occurrence);
  if (
    event.occurrence.key !== key ||
    (event.occurrence.kind === "pr_finding" && event.workItemKind !== "pull_request") ||
    event.version !== event.previousVersion + 1 ||
    event.state !== states[event.action] ||
    event.state === event.previousState ||
    (event.previousVersion === 0 && event.previousState !== "open") ||
    event.reason !== event.reason.trim() ||
    !reasonIsValid(event.reason)
  )
    invalidResponse();
}
function validateComparison(
  value: FindingComparisonResponse,
  scope: FindingScope,
  before: FindingScope,
  pagination: Pagination,
): void {
  validateContext(value.before, before);
  validateContext(value.after, scope);
  validatePage(value, pagination);
  if (
    value.before.workItemId !== value.after.workItemId ||
    value.before.workItemKind !== value.after.workItemKind
  )
    invalidResponse();
  if (
    (value.before.resultId === value.after.resultId || value.before.jobId === value.after.jobId) &&
    canonicalJson(value.before) !== canonicalJson(value.after)
  )
    invalidResponse();
  const reasons: FindingComparisonResponse["reasons"] = [];
  if (
    (["workflowKind", "target", "profileVersionId", "promptVersionId"] as const).some(
      (key) => value.before[key] !== value.after[key],
    )
  )
    reasons.push("configuration_changed");
  if (value.before.modelAvailability !== "complete" || value.after.modelAvailability !== "complete")
    reasons.push("model_unavailable");
  if (value.before.resultId === value.after.resultId) reasons.push("same_result");
  if (Date.parse(value.before.createdAt) >= Date.parse(value.after.createdAt))
    reasons.push("baseline_not_earlier");
  if (
    value.compatible !== (reasons.length === 0) ||
    value.reasons.length !== reasons.length ||
    reasons.some((reason) => !value.reasons.includes(reason)) ||
    (value.compatible
      ? value.total < Math.max(value.before.findingCount, value.after.findingCount) ||
        value.total > value.before.findingCount + value.after.findingCount
      : value.total !== value.before.findingCount + value.after.findingCount)
  )
    invalidResponse();
  const beforeKeys = new Set<string>();
  const afterKeys = new Set<string>();
  for (const row of value.items) {
    for (const [side, context, keys] of [
      [row.before, value.before, beforeKeys],
      [row.after, value.after, afterKeys],
    ] as const) {
      if (side === null) continue;
      validateRef(side, context);
      if (keys.has(side.key) || (side.path === null && side.line !== null)) invalidResponse();
      keys.add(side.key);
    }
    const beforeOnly = row.before !== null && row.after === null;
    const afterOnly = row.before === null && row.after !== null;
    if (value.compatible) {
      if (
        (row.status === "persistent" &&
          (row.before === null ||
            row.after === null ||
            row.reason !== null ||
            row.before.kind !== row.after.kind ||
            row.before.path !== row.after.path ||
            row.before.title.replace(/\r\n?/g, "\n") !==
              row.after.title.replace(/\r\n?/g, "\n"))) ||
        (row.status === "new" && (!afterOnly || row.reason !== null)) ||
        (row.status === "not_observed_again" && (!beforeOnly || row.reason !== null)) ||
        (row.status === "incomparable" &&
          ((!beforeOnly && !afterOnly) || row.reason !== "ambiguous_match"))
      )
        invalidResponse();
    } else {
      const reason = reasons.includes("configuration_changed")
        ? "configuration_changed"
        : reasons.includes("model_unavailable")
          ? "model_unavailable"
          : null;
      if (row.status !== "incomparable" || (!beforeOnly && !afterOnly) || row.reason !== reason)
        invalidResponse();
    }
  }
  if (
    beforeKeys.size > value.before.findingCount ||
    afterKeys.size > value.after.findingCount ||
    value.before.findingCount - beforeKeys.size > value.total - value.items.length ||
    value.after.findingCount - afterKeys.size > value.total - value.items.length
  )
    invalidResponse();
}

export function registerFindingDispositionRoutes(
  app: FastifyInstance,
  dependencies: FindingDispositionRouteDependencies,
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
    FINDING_DISPOSITION_PATHS.list,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        const query = configurationQuery(request.query, ["page", "pageSize"]);
        const pagination = paginationFor(query);
        const scope = scopeFor(request);
        const value = validateResponse(
          FindingListResponseSchema,
          await databaseFor(request).request("listFindingOccurrences", {
            ...scope,
            ...pagination,
            actor: authorization.actor(request),
          }),
        );
        validateList(value, scope, pagination);
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  app.get(
    FINDING_DISPOSITION_PATHS.comparison,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        const query = configurationQuery(request.query, [
          "page",
          "pageSize",
          "beforeReviewRunId",
          "beforeRequestId",
          "beforeJobId",
        ]);
        const pagination = paginationFor(query);
        const scope = scopeFor(request);
        const baseline = {
          beforeReviewRunId: configurationEntityId(query.beforeReviewRunId),
          beforeRequestId: configurationEntityId(query.beforeRequestId),
          beforeJobId: configurationEntityId(query.beforeJobId),
        };
        const value = validateResponse(
          FindingComparisonResponseSchema,
          await databaseFor(request).request("compareFindingResults", {
            ...scope,
            ...baseline,
            ...pagination,
            actor: authorization.actor(request),
          }),
        );
        validateComparison(
          value,
          scope,
          {
            repositoryId: scope.repositoryId,
            reviewRunId: baseline.beforeReviewRunId,
            requestId: baseline.beforeRequestId,
            jobId: baseline.beforeJobId,
          },
          pagination,
        );
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  app.get(
    FINDING_DISPOSITION_PATHS.history,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        const query = configurationQuery(request.query, ["page", "pageSize"]);
        const pagination = paginationFor(query);
        const scope = scopeFor(request);
        const occurrenceKey = occurrenceKeyFor(request);
        const value = validateResponse(
          FindingDispositionHistoryResponseSchema,
          await databaseFor(request).request("getFindingDispositionHistory", {
            ...scope,
            ...pagination,
            occurrenceKey,
            actor: authorization.actor(request),
          }),
        );
        validateScope(value, scope);
        validatePage(value, pagination);
        validateRef(value.occurrence);
        if (value.occurrence.key !== occurrenceKey) invalidResponse();
        const offset = (pagination.page - 1) * pagination.pageSize;
        for (const [index, event] of value.items.entries()) {
          validateEvent(event, scope, occurrenceKey);
          const first = value.items[0];
          const next = value.items[index + 1];
          if (
            canonicalJson(event.occurrence) !== canonicalJson(value.occurrence) ||
            event.version !== value.total - offset - index ||
            (first !== undefined &&
              (event.workItemId !== first.workItemId ||
                event.workItemKind !== first.workItemKind ||
                event.revisionKey !== first.revisionKey ||
                event.planDigest !== first.planDigest)) ||
            (next !== undefined &&
              (event.previousState !== next.state ||
                Date.parse(event.createdAt) < Date.parse(next.createdAt)))
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
    FINDING_DISPOSITION_PATHS.change,
    { bodyLimit: maximumFindingDispositionRequestUtf8Bytes, onRequest: authorize(true) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const scope = scopeFor(request);
        const occurrenceKey = occurrenceKeyFor(request);
        const input = parseConfigurationBody(FindingDispositionChangeRequestSchema, request.body);
        if (input.expectedVersion === Number.MAX_SAFE_INTEGER || !reasonIsValid(input.reason))
          throw new ConfigurationHttpError(
            400,
            "configuration_request_invalid",
            "The finding disposition request is invalid.",
          );
        const actor = authorization.actor(request);
        const value = validateResponse(
          FindingDispositionChangeResponseSchema,
          await databaseFor(request).request("changeFindingDisposition", {
            ...scope,
            occurrenceKey,
            ...input,
            actor,
          }),
        );
        const event = value.change;
        validateEvent(event, scope, occurrenceKey);
        if (
          event.changeId !== input.changeId ||
          event.actor.issuer !== actor.issuer ||
          event.actor.subject !== actor.subject ||
          event.action !== input.action ||
          event.reason !== input.reason.trim() ||
          event.occurrence.resultDigest !== input.expectedResultDigest ||
          event.contextDigestAtChange !== input.expectedContextDigest ||
          event.occurrence.kind !== input.kind ||
          event.occurrence.ordinal !== input.ordinal ||
          event.previousVersion !== input.expectedVersion ||
          event.version !== input.expectedVersion + 1
        )
          invalidResponse();
        return reply.code(value.replayed ? 200 : 201).send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
}
