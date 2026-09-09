import * as C from "@agentic-review/contracts";
import {
  evaluationBatchActor,
  evaluationBatchActorMatches,
  evaluationBatchMatch,
  evaluationBatchPageQuery,
  evaluationBatchRequest,
  evaluationBatchResponse,
} from "../evaluation-batches/validation";
import { ReviewControlRequestError } from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";

export interface EvaluationAdjudicationAdapter {
  readonly mode: "connected";
  getContext(
    scope: C.EvaluationCellResultReadQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationAdjudicationContextV1>;
  change(
    scope: C.EvaluationAdjudicationScope,
    request: C.EvaluationAdjudicationChangeRequest,
    actor: C.OperatorPrincipal,
  ): Promise<C.EvaluationAdjudicationChangeV1>;
  history(
    scope: C.EvaluationAdjudicationScope,
    query?: C.EvaluationAdjudicationHistoryQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationAdjudicationHistoryV1>;
}
const scopeKeys = ["repositoryId", "evaluationId", "cellId", "resultId"] as const;
const scopeMatches = (a: C.EvaluationCellResultReadQuery, b: C.EvaluationCellResultReadQuery) =>
  scopeKeys.every((key) => a[key] === b[key]);
const path = (scope: C.EvaluationCellResultReadQuery) =>
  `/api/v1/operator/repositories/${scope.repositoryId}/evaluations/${scope.evaluationId}/cells/${scope.cellId}/results/${scope.resultId}/adjudications`;
export function adjudicationJudgmentMatches(
  actual: C.EvaluationFindingAdjudication,
  expected: C.EvaluationAdjudicationChangeRequest["judgment"],
): boolean {
  return (
    actual.kind === expected.kind &&
    actual.reason === expected.reason &&
    (expected.kind !== "match" ||
      (actual.kind === "match" && actual.expectedFindingId === expected.expectedFindingId)) &&
    (expected.kind !== "duplicate" ||
      (actual.kind === "duplicate" &&
        actual.primaryOccurrenceKey === expected.primaryOccurrenceKey))
  );
}

export class HttpEvaluationAdjudicationAdapter implements EvaluationAdjudicationAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }
  async getContext(input: C.EvaluationCellResultReadQuery, signal?: AbortSignal) {
    const operation = "read evaluation adjudication context";
    const scope = evaluationBatchRequest(
      C.EvaluationCellResultReadQuerySchema,
      input,
      operation,
      C.getEvaluationCellResultReadQueryIssues,
    );
    const value = evaluationBatchResponse(
      C.EvaluationAdjudicationContextV1Schema,
      await this.client.get(path(scope), operation, {
        ...(signal ? { signal } : {}),
        maxResponseBytes: C.maximumEvaluationAdjudicationReadUtf8Bytes,
      }),
      operation,
      C.getEvaluationAdjudicationContextIssues,
      C.maximumEvaluationAdjudicationReadUtf8Bytes,
    );
    evaluationBatchMatch(scopeMatches(value.scope, scope), operation);
    return value;
  }
  async change(
    input: C.EvaluationAdjudicationScope,
    change: C.EvaluationAdjudicationChangeRequest,
    principal: C.OperatorPrincipal,
  ) {
    const operation = "change evaluation adjudication";
    const scope = evaluationBatchRequest(
      C.EvaluationAdjudicationScopeSchema,
      input,
      operation,
      C.getEvaluationAdjudicationScopeIssues,
    );
    const request = evaluationBatchRequest(
      C.EvaluationAdjudicationChangeRequestSchema,
      change,
      operation,
      C.getEvaluationAdjudicationChangeRequestIssues,
      C.maximumEvaluationAdjudicationChangeUtf8Bytes,
    );
    const actor = evaluationBatchActor(principal, operation);
    if (!actor)
      throw new ReviewControlRequestError(
        operation,
        "actor",
        "The signed-in reviewer identity is required.",
      );
    const value = evaluationBatchResponse(
      C.EvaluationAdjudicationChangeV1Schema,
      await this.client.put(`${path(scope)}/${scope.occurrenceKey}`, operation, request),
      operation,
      C.getEvaluationAdjudicationChangeIssues,
      C.maximumEvaluationAdjudicationChangeUtf8Bytes,
    );
    evaluationBatchMatch(
      scopeMatches(value.scope, scope) &&
        value.scope.occurrenceKey === scope.occurrenceKey &&
        value.previousVersion === request.expectedVersion &&
        value.version === request.expectedVersion + 1 &&
        value.adjudication.resultDigest === request.resultDigest &&
        adjudicationJudgmentMatches(value.adjudication, request.judgment) &&
        evaluationBatchActorMatches(value.adjudication.actor, actor),
      operation,
    );
    return value;
  }
  async history(
    input: C.EvaluationAdjudicationScope,
    inputQuery: C.EvaluationAdjudicationHistoryQuery = {},
    signal?: AbortSignal,
  ) {
    const operation = "read evaluation adjudication history";
    const scope = evaluationBatchRequest(
      C.EvaluationAdjudicationScopeSchema,
      input,
      operation,
      C.getEvaluationAdjudicationScopeIssues,
    );
    const query = evaluationBatchPageQuery(
      evaluationBatchRequest(
        C.EvaluationAdjudicationHistoryQuerySchema,
        inputQuery,
        operation,
        C.getEvaluationAdjudicationHistoryQueryIssues,
      ),
    );
    const parameters = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    const value = evaluationBatchResponse(
      C.EvaluationAdjudicationHistoryV1Schema,
      await this.client.get(
        `${path(scope)}/${scope.occurrenceKey}/history?${parameters}`,
        operation,
        {
          ...(signal ? { signal } : {}),
          maxResponseBytes: C.maximumEvaluationAdjudicationReadUtf8Bytes,
        },
      ),
      operation,
      C.getEvaluationAdjudicationHistoryIssues,
      C.maximumEvaluationAdjudicationReadUtf8Bytes,
    );
    evaluationBatchMatch(
      scopeMatches(value.scope, scope) &&
        value.scope.occurrenceKey === scope.occurrenceKey &&
        value.page === query.page &&
        value.pageSize === query.pageSize,
      operation,
    );
    return value;
  }
}
export const createHttpEvaluationAdjudicationAdapter = (
  options: DashboardHttpClientOptions = {},
): EvaluationAdjudicationAdapter => new HttpEvaluationAdjudicationAdapter(options);
