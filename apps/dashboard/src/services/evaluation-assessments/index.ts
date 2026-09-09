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

export interface EvaluationAssessmentAdapter {
  readonly mode: "connected";
  preview(
    scope: C.EvaluationAssessmentScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationScorePreviewV1>;
  save(
    scope: C.EvaluationAssessmentScope,
    request: C.EvaluationAssessmentPublishRequest,
    actor: C.OperatorPrincipal,
  ): Promise<C.EvaluationAssessmentSummaryV1>;
  list(
    scope: C.EvaluationAssessmentScope,
    query?: C.EvaluationAssessmentListQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationAssessmentListV1>;
  get(
    scope: C.EvaluationAssessmentReadQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationAssessmentSummaryV1>;
  getCase(
    scope: C.EvaluationAssessmentCaseReadQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationAssessmentCaseV1>;
}
const path = (scope: C.EvaluationAssessmentScope) =>
  `/api/v1/operator/repositories/${scope.repositoryId}/evaluations/${scope.evaluationId}`;
const scopeMatches = (value: C.EvaluationAssessmentScope, expected: C.EvaluationAssessmentScope) =>
  value.repositoryId === expected.repositoryId && value.evaluationId === expected.evaluationId;
export class HttpEvaluationAssessmentAdapter implements EvaluationAssessmentAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }
  private read(path: string, operation: string, signal?: AbortSignal) {
    return this.client.get(path, operation, {
      ...(signal ? { signal } : {}),
      maxResponseBytes: C.maximumEvaluationAssessmentReadUtf8Bytes,
    });
  }
  async preview(input: C.EvaluationAssessmentScope, signal?: AbortSignal) {
    const operation = "calculate evaluation score preview";
    const scope = evaluationBatchRequest(
      C.EvaluationAssessmentScopeSchema,
      input,
      operation,
      C.getEvaluationAssessmentScopeIssues,
    );
    const value = evaluationBatchResponse(
      C.EvaluationScorePreviewV1Schema,
      await this.read(`${path(scope)}/score-preview`, operation, signal),
      operation,
      C.getEvaluationScorePreviewIssues,
      C.maximumEvaluationAssessmentReadUtf8Bytes,
    );
    evaluationBatchMatch(scopeMatches(value, scope), operation);
    return value;
  }
  async save(
    input: C.EvaluationAssessmentScope,
    inputRequest: C.EvaluationAssessmentPublishRequest,
    principal: C.OperatorPrincipal,
  ) {
    const operation = "save evaluation report";
    const scope = evaluationBatchRequest(
      C.EvaluationAssessmentScopeSchema,
      input,
      operation,
      C.getEvaluationAssessmentScopeIssues,
    );
    const request = evaluationBatchRequest(
      C.EvaluationAssessmentPublishRequestSchema,
      inputRequest,
      operation,
      C.getEvaluationAssessmentPublishRequestIssues,
      C.maximumEvaluationAssessmentReceiptUtf8Bytes,
    );
    const actor = evaluationBatchActor(principal, operation);
    if (!actor)
      throw new ReviewControlRequestError(
        operation,
        "actor",
        "A signed-in reviewer identity is required to save a report.",
      );
    const value = evaluationBatchResponse(
      C.EvaluationAssessmentSummaryV1Schema,
      await this.client.post(`${path(scope)}/assessments`, operation, request),
      operation,
      C.getEvaluationAssessmentPublishResponseIssues,
      C.maximumEvaluationAssessmentReceiptUtf8Bytes,
    );
    evaluationBatchMatch(
      scopeMatches(value, scope) &&
        value.version === request.expectedVersion + 1 &&
        evaluationBatchActorMatches(value.createdBy, actor),
      operation,
    );
    return value;
  }
  async list(
    input: C.EvaluationAssessmentScope,
    inputQuery: C.EvaluationAssessmentListQuery = {},
    signal?: AbortSignal,
  ) {
    const operation = "list evaluation reports";
    const scope = evaluationBatchRequest(
      C.EvaluationAssessmentScopeSchema,
      input,
      operation,
      C.getEvaluationAssessmentScopeIssues,
    );
    const query = evaluationBatchPageQuery(
      evaluationBatchRequest(
        C.EvaluationAssessmentListQuerySchema,
        inputQuery,
        operation,
        C.getEvaluationAssessmentListQueryIssues,
      ),
    );
    const parameters = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    const value = evaluationBatchResponse(
      C.EvaluationAssessmentListV1Schema,
      await this.read(`${path(scope)}/assessments?${parameters}`, operation, signal),
      operation,
      C.getEvaluationAssessmentListIssues,
      C.maximumEvaluationAssessmentReadUtf8Bytes,
    );
    evaluationBatchMatch(
      scopeMatches(value, scope) && value.page === query.page && value.pageSize === query.pageSize,
      operation,
    );
    return value;
  }
  async get(input: C.EvaluationAssessmentReadQuery, signal?: AbortSignal) {
    const operation = "read evaluation report";
    const scope = evaluationBatchRequest(
      C.EvaluationAssessmentReadQuerySchema,
      input,
      operation,
      C.getEvaluationAssessmentReadQueryIssues,
    );
    const value = evaluationBatchResponse(
      C.EvaluationAssessmentSummaryV1Schema,
      await this.read(`${path(scope)}/assessments/${scope.assessmentId}`, operation, signal),
      operation,
      C.getEvaluationAssessmentSummaryIssues,
      C.maximumEvaluationAssessmentReadUtf8Bytes,
    );
    evaluationBatchMatch(
      scopeMatches(value, scope) && value.assessmentId === scope.assessmentId,
      operation,
    );
    return value;
  }
  async getCase(input: C.EvaluationAssessmentCaseReadQuery, signal?: AbortSignal) {
    const operation = "read evaluation report case";
    const scope = evaluationBatchRequest(
      C.EvaluationAssessmentCaseReadQuerySchema,
      input,
      operation,
      C.getEvaluationAssessmentCaseReadQueryIssues,
    );
    const value = evaluationBatchResponse(
      C.EvaluationAssessmentCaseV1Schema,
      await this.read(
        `${path(scope)}/assessments/${scope.assessmentId}/cases/${scope.caseId}`,
        operation,
        signal,
      ),
      operation,
      C.getEvaluationAssessmentCaseIssues,
      C.maximumEvaluationAssessmentReadUtf8Bytes,
    );
    evaluationBatchMatch(
      scopeMatches(value.scope, scope) &&
        value.scope.assessmentId === scope.assessmentId &&
        value.scope.caseId === scope.caseId,
      operation,
    );
    return value;
  }
}
export const createHttpEvaluationAssessmentAdapter = (
  options: DashboardHttpClientOptions = {},
): EvaluationAssessmentAdapter => new HttpEvaluationAssessmentAdapter(options);
