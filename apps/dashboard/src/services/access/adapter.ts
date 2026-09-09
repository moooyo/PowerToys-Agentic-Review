import type {
  OperatorAccessContext,
  RepositoryAccessAuditListResponse,
  RepositoryAccessChangeRequest,
  RepositoryAccessChangeResponse,
  RepositoryAccessListResponse,
} from "@agentic-review/contracts";

export interface AccessPageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface AccessAdapter {
  readonly mode: "connected" | "sample";
  context(repositoryId?: string): Promise<OperatorAccessContext>;
  list(repositoryId: string, query?: AccessPageQuery): Promise<RepositoryAccessListResponse>;
  history(
    repositoryId: string,
    query?: AccessPageQuery,
  ): Promise<RepositoryAccessAuditListResponse>;
  change(
    repositoryId: string,
    input: RepositoryAccessChangeRequest,
  ): Promise<RepositoryAccessChangeResponse>;
}
