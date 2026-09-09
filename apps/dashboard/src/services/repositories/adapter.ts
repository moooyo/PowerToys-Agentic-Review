import type {
  GitHubRepository,
  ManagedRepository,
  ManagedRepositorySummary,
  RepositoryCreateRequest,
  RepositoryUpdateRequest,
} from "@agentic-review/contracts";

export interface RepositoryListQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
}

export interface RepositoryListResult {
  readonly items: ManagedRepositorySummary[];
  readonly total: number;
}

export interface RepositoryAdapter {
  list(query?: RepositoryListQuery): Promise<RepositoryListResult>;
  get(id: string, signal?: AbortSignal): Promise<ManagedRepository>;
  resolve(fullName: string): Promise<GitHubRepository>;
  create(input: RepositoryCreateRequest): Promise<ManagedRepository>;
  update(id: string, input: RepositoryUpdateRequest): Promise<ManagedRepository>;
  checkConnection(id: string): Promise<ManagedRepository>;
}
