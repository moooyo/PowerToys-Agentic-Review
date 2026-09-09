import type {
  OperatorPrincipal,
  ReviewRunDecisionChangeRequest,
  ReviewRunDecisionChangeResponse,
  ReviewRunDecisionContext,
  ReviewRunDecisionHistoryResponse,
} from "@agentic-review/contracts";

export interface DecisionPageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface DecisionAdapter {
  readonly mode: "connected" | "sample";
  getContext(repositoryId: string, reviewRunId: string): Promise<ReviewRunDecisionContext>;
  listHistory(
    repositoryId: string,
    reviewRunId: string,
    query?: DecisionPageQuery,
  ): Promise<ReviewRunDecisionHistoryResponse>;
  change(
    repositoryId: string,
    reviewRunId: string,
    input: ReviewRunDecisionChangeRequest,
    actor: OperatorPrincipal,
  ): Promise<ReviewRunDecisionChangeResponse>;
}
