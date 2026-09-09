import * as C from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import type { EvaluationBatchAdapter, EvaluationBatchScope } from "./types";
import {
  EvaluationBatchRepositoryScopeSchema,
  EvaluationBatchScopeSchema,
  evaluationBatchActor,
  evaluationBatchActorMatches,
  evaluationBatchMatch,
  evaluationBatchPageMatches,
  evaluationBatchPageQuery,
  evaluationBatchRequest,
  evaluationBatchResponse,
} from "./validation";

const repositoryPath = (repositoryId: string) => `/api/v1/operator/repositories/${repositoryId}`;
const batchPath = (scope: EvaluationBatchScope) =>
  `${repositoryPath(scope.repositoryId)}/evaluations/${scope.evaluationId}`;
const pageParameters = (query: { page: number; pageSize: number }) =>
  new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });

export class HttpEvaluationBatchAdapter implements EvaluationBatchAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  private read(path: string, operation: string, signal?: AbortSignal) {
    return this.client.get(path, operation, {
      ...(signal === undefined ? {} : { signal }),
      maxResponseBytes: C.maximumEvaluationReadUtf8Bytes,
    });
  }

  async createBatch(
    repositoryId: string,
    input: C.EvaluationBatchCreateRequest,
    principal?: C.OperatorPrincipal,
  ) {
    const operation = "create evaluation batch";
    const scope = evaluationBatchRequest(
      EvaluationBatchRepositoryScopeSchema,
      { repositoryId },
      operation,
    );
    const request = evaluationBatchRequest(
      C.EvaluationBatchCreateRequestSchema,
      input,
      operation,
      C.getEvaluationBatchCreateRequestIssues,
      C.maximumEvaluationBatchRequestUtf8Bytes,
    );
    const actor = evaluationBatchActor(principal, operation);
    const value = evaluationBatchResponse(
      C.EvaluationBatchSummaryV1Schema,
      await this.client.post(
        `${repositoryPath(scope.repositoryId)}/evaluations`,
        operation,
        request,
      ),
      operation,
      C.getEvaluationBatchSummaryIssues,
      C.maximumEvaluationReadUtf8Bytes,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId &&
        value.suiteId === request.suiteId &&
        value.suiteVersionId === request.suiteVersionId &&
        value.mode === request.mode &&
        value.baseline.profileVersionId === request.baseline.profileVersionId &&
        value.baseline.promptVersionId === request.baseline.promptVersionId &&
        value.baseline.modelRuntimeRegistrationId === request.baseline.modelRuntimeRegistrationId &&
        value.candidate.profileVersionId === request.candidate.profileVersionId &&
        value.candidate.promptVersionId === request.candidate.promptVersionId &&
        value.candidate.modelRuntimeRegistrationId ===
          request.candidate.modelRuntimeRegistrationId &&
        evaluationBatchActorMatches(value.createdBy, actor),
      operation,
    );
    return value;
  }

  async cancelBatch(
    input: EvaluationBatchScope,
    change: C.EvaluationBatchCancelRequest,
    principal?: C.OperatorPrincipal,
  ) {
    const operation = "cancel evaluation batch";
    const scope = evaluationBatchRequest(EvaluationBatchScopeSchema, input, operation);
    const request = evaluationBatchRequest(
      C.EvaluationBatchCancelRequestSchema,
      change,
      operation,
      C.getEvaluationBatchCancelRequestIssues,
      16 * 1024,
    );
    const actor = evaluationBatchActor(principal, operation);
    const value = evaluationBatchResponse(
      C.EvaluationBatchCancellationV1Schema,
      await this.client.post(`${batchPath(scope)}/cancel`, operation, request),
      operation,
      C.getEvaluationBatchCancellationIssues,
      C.maximumEvaluationReadUtf8Bytes,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId &&
        value.evaluationId === scope.evaluationId &&
        value.version === request.expectedVersion + 1 &&
        value.reason === request.reason &&
        evaluationBatchActorMatches(value.cancelledBy, actor),
      operation,
    );
    return value;
  }

  async listBatches(
    repositoryId: string,
    input: C.EvaluationBatchListQuery = {},
    signal?: AbortSignal,
  ) {
    const operation = "list evaluation batches";
    const scope = evaluationBatchRequest(
      EvaluationBatchRepositoryScopeSchema,
      { repositoryId },
      operation,
    );
    const filters = evaluationBatchRequest(
      C.EvaluationBatchListQuerySchema,
      input,
      operation,
      C.getEvaluationBatchListQueryIssues,
    );
    const query = evaluationBatchPageQuery(filters);
    const parameters = pageParameters(query);
    if (filters.suiteId !== undefined) parameters.set("suiteId", filters.suiteId);
    if (filters.workflowKind !== undefined) parameters.set("workflowKind", filters.workflowKind);
    const value = evaluationBatchResponse(
      C.EvaluationBatchListV1Schema,
      await this.read(
        `${repositoryPath(scope.repositoryId)}/evaluations?${parameters}`,
        operation,
        signal,
      ),
      operation,
      C.getEvaluationBatchListIssues,
      C.maximumEvaluationReadUtf8Bytes,
    );
    evaluationBatchMatch(
      evaluationBatchPageMatches(value, scope.repositoryId, query) &&
        value.items.every(
          (item) =>
            (filters.suiteId === undefined || item.summary.suiteId === filters.suiteId) &&
            (filters.workflowKind === undefined ||
              item.summary.workflowKind === filters.workflowKind),
        ),
      operation,
    );
    return value;
  }

  async getBatch(input: EvaluationBatchScope, signal?: AbortSignal) {
    const operation = "read evaluation batch";
    const scope = evaluationBatchRequest(EvaluationBatchScopeSchema, input, operation);
    const value = evaluationBatchResponse(
      C.EvaluationBatchDetailV1Schema,
      await this.read(batchPath(scope), operation, signal),
      operation,
      C.getEvaluationBatchDetailIssues,
      C.maximumEvaluationReadUtf8Bytes,
    );
    evaluationBatchMatch(
      value.summary.repositoryId === scope.repositoryId && value.summary.id === scope.evaluationId,
      operation,
    );
    return value;
  }

  async getBatchMatrix(input: EvaluationBatchScope, signal?: AbortSignal) {
    const operation = "read evaluation batch matrix";
    const scope = evaluationBatchRequest(EvaluationBatchScopeSchema, input, operation);
    const value = evaluationBatchResponse(
      C.EvaluationBatchMatrixV1Schema,
      await this.read(`${batchPath(scope)}/matrix`, operation, signal),
      operation,
      C.getEvaluationBatchMatrixIssues,
      C.maximumEvaluationReadUtf8Bytes,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId && value.evaluationId === scope.evaluationId,
      operation,
    );
    return value;
  }

  async getCellResult(input: C.EvaluationCellResultReadQuery, signal?: AbortSignal) {
    const operation = "read evaluation cell result";
    const scope = evaluationBatchRequest(
      C.EvaluationCellResultReadQuerySchema,
      input,
      operation,
      C.getEvaluationCellResultReadQueryIssues,
    );
    const value = evaluationBatchResponse(
      C.EvaluationCellResultV1Schema,
      await this.client.get(
        `${batchPath(scope)}/cells/${scope.cellId}/results/${scope.resultId}`,
        operation,
        {
          ...(signal === undefined ? {} : { signal }),
          maxResponseBytes: C.maximumEvaluationCellResultUtf8Bytes,
        },
      ),
      operation,
      C.getEvaluationCellResultIssues,
      C.maximumEvaluationCellResultUtf8Bytes,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId &&
        value.evaluationId === scope.evaluationId &&
        value.cellId === scope.cellId &&
        value.resultId === scope.resultId,
      operation,
    );
    return value;
  }

  async listPromptOptions(
    repositoryId: string,
    input: C.EvaluationPromptOptionsQuery,
    signal?: AbortSignal,
  ) {
    const operation = "list evaluation prompt options";
    const scope = evaluationBatchRequest(
      EvaluationBatchRepositoryScopeSchema,
      { repositoryId },
      operation,
    );
    const filters = evaluationBatchRequest(
      C.EvaluationPromptOptionsQuerySchema,
      input,
      operation,
      C.getEvaluationPromptOptionsQueryIssues,
    );
    const query = evaluationBatchPageQuery(filters);
    const parameters = pageParameters(query);
    parameters.set("workflowKind", filters.workflowKind);
    const value = evaluationBatchResponse(
      C.EvaluationPromptOptionsV1Schema,
      await this.read(
        `${repositoryPath(scope.repositoryId)}/evaluation-prompt-options?${parameters}`,
        operation,
        signal,
      ),
      operation,
      C.getEvaluationPromptOptionsIssues,
      C.maximumEvaluationReadUtf8Bytes,
    );
    evaluationBatchMatch(
      evaluationBatchPageMatches(value, scope.repositoryId, query) &&
        value.workflowKind === filters.workflowKind &&
        value.items.every(
          (item) =>
            item.outputSchemaVersion === C.WorkflowOutputSchemaVersions[filters.workflowKind],
        ),
      operation,
    );
    return value;
  }
}

export function createHttpEvaluationBatchAdapter(
  options: DashboardHttpClientOptions = {},
): EvaluationBatchAdapter {
  return new HttpEvaluationBatchAdapter(options);
}
