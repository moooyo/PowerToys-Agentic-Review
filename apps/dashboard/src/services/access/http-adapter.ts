import type { RepositoryAccessChangeRequest } from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
  OPERATOR_REPOSITORIES_PATH,
} from "../review-control/http-client";
import type { AccessAdapter, AccessPageQuery } from "./adapter";
import {
  accessPageQuery,
  normalizeAccessPage,
  readAccessChange,
  readAccessContext,
  readAccessHistory,
  readAccessList,
  validateAccessChange,
  validateAccessId,
} from "./validation";

export class HttpAccessAdapter implements AccessAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async context(repositoryId?: string) {
    const operation = "get operator access";
    if (repositoryId !== undefined) validateAccessId(repositoryId, operation);
    const path = "/api/v1/operator/access";
    const query =
      repositoryId === undefined ? "" : `?${new URLSearchParams({ repositoryId }).toString()}`;
    return readAccessContext(
      await this.client.get(`${path}${query}`, operation),
      operation,
      repositoryId,
    );
  }

  async list(repositoryId: string, query?: AccessPageQuery) {
    const operation = "list repository access";
    validateAccessId(repositoryId, operation);
    const normalized = normalizeAccessPage(query, operation);
    const value = await this.client.get(
      `${OPERATOR_REPOSITORIES_PATH}/${repositoryId}/access?${accessPageQuery(normalized)}`,
      operation,
    );
    return readAccessList(value, repositoryId, normalized, operation);
  }

  async history(repositoryId: string, query?: AccessPageQuery) {
    const operation = "list repository access history";
    validateAccessId(repositoryId, operation);
    const normalized = normalizeAccessPage(query, operation);
    const value = await this.client.get(
      `${OPERATOR_REPOSITORIES_PATH}/${repositoryId}/access/history?${accessPageQuery(normalized)}`,
      operation,
    );
    return readAccessHistory(value, repositoryId, normalized, operation);
  }

  async change(repositoryId: string, input: RepositoryAccessChangeRequest) {
    const operation = "change repository access";
    validateAccessId(repositoryId, operation);
    const snapshot = structuredClone(validateAccessChange(input, operation));
    // Preserve the request and its idempotency key across retries. The receipt is not a live grant.
    const value = await this.client.post(
      `${OPERATOR_REPOSITORIES_PATH}/${repositoryId}/access`,
      operation,
      snapshot,
    );
    return readAccessChange(value, repositoryId, snapshot, operation);
  }
}
