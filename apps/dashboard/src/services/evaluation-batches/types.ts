import type * as C from "@agentic-review/contracts";

export interface EvaluationBatchScope {
  readonly repositoryId: string;
  readonly evaluationId: string;
}

export interface EvaluationBatchAdapter {
  readonly mode: "connected";
  createBatch(
    repositoryId: string,
    request: C.EvaluationBatchCreateRequest,
    actor?: C.OperatorPrincipal,
  ): Promise<C.EvaluationBatchSummaryV1>;
  cancelBatch(
    scope: EvaluationBatchScope,
    request: C.EvaluationBatchCancelRequest,
    actor?: C.OperatorPrincipal,
  ): Promise<C.EvaluationBatchCancellationV1>;
  listBatches(
    repositoryId: string,
    query?: C.EvaluationBatchListQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationBatchListV1>;
  getBatch(scope: EvaluationBatchScope, signal?: AbortSignal): Promise<C.EvaluationBatchDetailV1>;
  getCellResult(
    scope: C.EvaluationCellResultReadQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationCellResultV1>;
  getBatchMatrix(
    scope: EvaluationBatchScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationBatchMatrixV1>;
  listPromptOptions(
    repositoryId: string,
    query: C.EvaluationPromptOptionsQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationPromptOptionsV1>;
}
