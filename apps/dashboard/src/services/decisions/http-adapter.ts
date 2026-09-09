import type { OperatorPrincipal, ReviewRunDecisionChangeRequest } from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
  OPERATOR_REPOSITORIES_PATH,
} from "../review-control/http-client";
import type { DecisionAdapter, DecisionPageQuery } from "./adapter";
import {
  normalizeDecisionPage,
  readDecisionChange,
  readDecisionContext,
  readDecisionHistory,
  validateDecisionActor,
  validateDecisionChange,
  validateDecisionScope,
} from "./validation";

function path(repositoryId: string, reviewRunId: string): string {
  return `${OPERATOR_REPOSITORIES_PATH}/${repositoryId}/review-runs/${reviewRunId}/decisions`;
}

export class HttpDecisionAdapter implements DecisionAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async getContext(repositoryId: string, reviewRunId: string) {
    const operation = "get review run decision context";
    validateDecisionScope(repositoryId, reviewRunId, operation);
    return readDecisionContext(
      await this.client.get(path(repositoryId, reviewRunId), operation),
      repositoryId,
      reviewRunId,
      operation,
    );
  }

  async listHistory(repositoryId: string, reviewRunId: string, query?: DecisionPageQuery) {
    const operation = "list review run decision history";
    validateDecisionScope(repositoryId, reviewRunId, operation);
    const normalized = normalizeDecisionPage(query, operation);
    const parameters = new URLSearchParams({
      page: String(normalized.page),
      pageSize: String(normalized.pageSize),
    });
    return readDecisionHistory(
      await this.client.get(`${path(repositoryId, reviewRunId)}/history?${parameters}`, operation),
      repositoryId,
      reviewRunId,
      normalized,
      operation,
    );
  }

  async change(
    repositoryId: string,
    reviewRunId: string,
    input: ReviewRunDecisionChangeRequest,
    actor: OperatorPrincipal,
  ) {
    const operation = "change review run decision";
    validateDecisionScope(repositoryId, reviewRunId, operation);
    const snapshot = structuredClone(validateDecisionChange(input, operation));
    const principal = structuredClone(validateDecisionActor(actor, operation));
    // The actor is checked against the receipt; authentication alone supplies it to the server.
    const value = await this.client.post(path(repositoryId, reviewRunId), operation, snapshot);
    return readDecisionChange(value, repositoryId, reviewRunId, snapshot, principal, operation);
  }
}
