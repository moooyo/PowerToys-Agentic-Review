import type {
  ConfigurationAuditEvent,
  ConfigurationAuditSource,
  ConfigurationAuditSummary,
  GlobalConfigurationAuditListQuery,
  GlobalConfigurationAuditListResponse,
  RepositoryConfigurationAuditListResponse,
} from "@agentic-review/contracts";

export interface ConfigurationAuditPageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export type GlobalConfigurationAuditQuery = GlobalConfigurationAuditListQuery;

export interface ConfigurationAuditAdapter {
  readonly mode: "connected" | "sample";
  listRepositoryConfigurationAudit(
    repositoryId: string,
    query?: ConfigurationAuditPageQuery,
  ): Promise<RepositoryConfigurationAuditListResponse>;
  getRepositoryConfigurationAudit(
    repositoryId: string,
    source: ConfigurationAuditSource,
    eventId: string,
    expectedSummary?: ConfigurationAuditSummary,
  ): Promise<ConfigurationAuditEvent>;
  listGlobalConfigurationAudit(
    query?: GlobalConfigurationAuditQuery,
  ): Promise<GlobalConfigurationAuditListResponse>;
  getGlobalConfigurationAudit(
    eventId: string,
    expectedSummary?: ConfigurationAuditSummary,
  ): Promise<ConfigurationAuditEvent>;
}
