import {
  type GitHubRepository,
  GitHubRepositorySchema,
  type ManagedRepository,
  ManagedRepositoryNameSchema,
  ManagedRepositorySchema,
  type RepositoryCreateRequest,
  RepositoryCreateRequestSchema,
  type RepositoryUpdateRequest,
  RepositoryUpdateRequestSchema,
} from "@agentic-review/contracts";
import { ReviewControlProtocolError } from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
  OPERATOR_REPOSITORIES_PATH,
} from "../review-control/http-client";
import type { RepositoryAdapter, RepositoryListQuery, RepositoryListResult } from "./adapter";
import {
  ensureRepositoryResponseIdentity,
  normalizeListQuery,
  RepositoryListResultSchema,
  repositorySettingsAreConsistent,
  validateRepositoryId,
  validateRequest,
  validateResponse,
} from "./validation";

export class HttpRepositoryAdapter implements RepositoryAdapter {
  private readonly client: DashboardHttpClient;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async list(query?: RepositoryListQuery): Promise<RepositoryListResult> {
    const operation = "list repositories";
    const normalized = normalizeListQuery(query);
    const parameters = new URLSearchParams({
      page: String(normalized.page),
      pageSize: String(normalized.pageSize),
      search: normalized.search,
    });
    const result = validateResponse(
      RepositoryListResultSchema,
      await this.client.get(`${OPERATOR_REPOSITORIES_PATH}?${parameters.toString()}`, operation),
      operation,
    );
    if (
      result.items.length > normalized.pageSize ||
      result.items.length > result.total ||
      (result.items.length > 0 &&
        (normalized.page - 1) * normalized.pageSize + result.items.length > result.total) ||
      new Set(result.items.map((item) => item.id)).size !== result.items.length ||
      new Set(result.items.map((item) => item.githubRepositoryId)).size !== result.items.length ||
      new Set(result.items.map((item) => item.fullName.toLowerCase())).size !==
        result.items.length ||
      !result.items.every(repositorySettingsAreConsistent)
    ) {
      throw new ReviewControlProtocolError(
        operation,
        "The repository list response is inconsistent.",
      );
    }
    return result;
  }

  async get(id: string, signal?: AbortSignal): Promise<ManagedRepository> {
    const operation = "get repository";
    validateRepositoryId(id, operation);
    return ensureRepositoryResponseIdentity(
      validateResponse(
        ManagedRepositorySchema,
        await this.client.get(`${OPERATOR_REPOSITORIES_PATH}/${id}`, operation, { signal }),
        operation,
      ),
      operation,
      id,
    );
  }

  async resolve(fullName: string): Promise<GitHubRepository> {
    const operation = "resolve repository";
    validateRequest(ManagedRepositoryNameSchema, fullName, operation, "fullName");
    const repository = validateResponse(
      GitHubRepositorySchema,
      await this.client.post(`${OPERATOR_REPOSITORIES_PATH}/resolve`, operation, { fullName }),
      operation,
    );
    if (
      repository.fullName.toLowerCase() !== fullName.toLowerCase() ||
      `${repository.ownerLogin}/${repository.name}` !== repository.fullName
    ) {
      throw new ReviewControlProtocolError(
        operation,
        "The resolved repository does not match the requested identity.",
      );
    }
    return repository;
  }

  async create(input: RepositoryCreateRequest): Promise<ManagedRepository> {
    const operation = "create repository";
    validateRequest(RepositoryCreateRequestSchema, input, operation);
    const repository = ensureRepositoryResponseIdentity(
      validateResponse(
        ManagedRepositorySchema,
        await this.client.post(OPERATOR_REPOSITORIES_PATH, operation, input),
        operation,
      ),
      operation,
    );
    if (
      repository.githubRepositoryId !== input.githubRepositoryId ||
      repository.fullName.toLowerCase() !== input.fullName.toLowerCase()
    ) {
      throw new ReviewControlProtocolError(
        operation,
        "The created repository does not match the requested identity.",
      );
    }
    return repository;
  }

  async update(id: string, input: RepositoryUpdateRequest): Promise<ManagedRepository> {
    const operation = "update repository";
    validateRepositoryId(id, operation);
    validateRequest(RepositoryUpdateRequestSchema, input, operation);
    return ensureRepositoryResponseIdentity(
      validateResponse(
        ManagedRepositorySchema,
        await this.client.patch(`${OPERATOR_REPOSITORIES_PATH}/${id}`, operation, input),
        operation,
      ),
      operation,
      id,
    );
  }

  async checkConnection(id: string): Promise<ManagedRepository> {
    const operation = "check repository connection";
    validateRepositoryId(id, operation);
    return ensureRepositoryResponseIdentity(
      validateResponse(
        ManagedRepositorySchema,
        await this.client.post(
          `${OPERATOR_REPOSITORIES_PATH}/${id}/check-connection`,
          operation,
          {},
        ),
        operation,
      ),
      operation,
      id,
    );
  }
}
