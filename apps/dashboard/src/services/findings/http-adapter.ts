import type {
  FindingDispositionChangeRequest,
  FindingOccurrenceRef,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
  OPERATOR_REPOSITORIES_PATH,
} from "../review-control/http-client";
import type { FindingPageQuery, FindingScope, FindingsAdapter } from "./adapter";
import {
  normalizeFindingPage,
  readFindingChange,
  readFindingComparison,
  readFindingHistory,
  readFindingList,
  validateFindingActor,
  validateFindingChange,
  validateFindingComparisonScope,
  validateFindingKey,
  validateFindingRef,
  validateFindingScope,
} from "./validation";

function path(scope: FindingScope): string {
  return `${OPERATOR_REPOSITORIES_PATH}/${scope.repositoryId}/review-runs/${scope.reviewRunId}/requests/${scope.requestId}/jobs/${scope.jobId}/findings`;
}

function parameters(query: Required<FindingPageQuery>) {
  return new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
}

export class HttpFindingsAdapter implements FindingsAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async list(scope: FindingScope, query?: FindingPageQuery) {
    const operation = "list finding occurrences";
    const selected = structuredClone(validateFindingScope(scope, operation));
    const page = normalizeFindingPage(query, operation);
    const value = await this.client.get(`${path(selected)}?${parameters(page)}`, operation);
    return readFindingList(value, selected, page, operation);
  }

  async compare(scope: FindingScope, beforeScope: FindingScope, query?: FindingPageQuery) {
    const operation = "compare finding results";
    const selected = structuredClone(validateFindingScope(scope, operation));
    const before = structuredClone(validateFindingScope(beforeScope, operation));
    validateFindingComparisonScope(selected, before, operation);
    const page = normalizeFindingPage(query, operation);
    const search = new URLSearchParams({
      beforeReviewRunId: before.reviewRunId,
      beforeRequestId: before.requestId,
      beforeJobId: before.jobId,
      page: String(page.page),
      pageSize: String(page.pageSize),
    });
    const value = await this.client.get(`${path(selected)}/comparison?${search}`, operation);
    return readFindingComparison(value, selected, before, page, operation);
  }

  async change(
    scope: FindingScope,
    occurrenceKey: string,
    input: FindingDispositionChangeRequest,
    actor: OperatorPrincipal,
  ) {
    const operation = "change finding disposition";
    const selected = structuredClone(validateFindingScope(scope, operation));
    validateFindingKey(occurrenceKey, operation);
    const snapshot = structuredClone(validateFindingChange(input, operation));
    const principal = structuredClone(validateFindingActor(actor, operation));
    // Authentication supplies the actor to the server; the caller is used only to bind the receipt.
    const value = await this.client.post(
      `${path(selected)}/${occurrenceKey}/disposition`,
      operation,
      snapshot,
    );
    return readFindingChange(value, selected, occurrenceKey, snapshot, principal, operation);
  }

  async history(scope: FindingScope, occurrence: FindingOccurrenceRef, query?: FindingPageQuery) {
    const operation = "list finding disposition history";
    const selected = structuredClone(validateFindingScope(scope, operation));
    const ref = structuredClone(validateFindingRef(occurrence, operation));
    const page = normalizeFindingPage(query, operation);
    const value = await this.client.get(
      `${path(selected)}/${ref.key}/history?${parameters(page)}`,
      operation,
    );
    return readFindingHistory(value, selected, ref, page, operation);
  }
}
