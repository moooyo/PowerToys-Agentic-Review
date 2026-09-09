import type {
  FindingComparisonResponse,
  FindingDispositionChangeRequest,
  FindingDispositionChangeResponse,
  FindingDispositionHistoryResponse,
  FindingListResponse,
  FindingOccurrenceRef,
  OperatorPrincipal,
} from "@agentic-review/contracts";

export interface FindingScope {
  readonly repositoryId: string;
  readonly reviewRunId: string;
  readonly requestId: string;
  readonly jobId: string;
}

export interface FindingPageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface FindingsAdapter {
  readonly mode: "connected" | "sample";
  list(scope: FindingScope, query?: FindingPageQuery): Promise<FindingListResponse>;
  compare(
    scope: FindingScope,
    beforeScope: FindingScope,
    query?: FindingPageQuery,
  ): Promise<FindingComparisonResponse>;
  change(
    scope: FindingScope,
    occurrenceKey: string,
    input: FindingDispositionChangeRequest,
    actor: OperatorPrincipal,
  ): Promise<FindingDispositionChangeResponse>;
  history(
    scope: FindingScope,
    occurrence: FindingOccurrenceRef,
    query?: FindingPageQuery,
  ): Promise<FindingDispositionHistoryResponse>;
}
