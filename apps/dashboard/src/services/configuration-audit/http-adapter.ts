import type {
  ConfigurationAuditSource,
  ConfigurationAuditSummary,
} from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
  OPERATOR_REPOSITORIES_PATH,
} from "../review-control/http-client";
import type {
  ConfigurationAuditAdapter,
  ConfigurationAuditPageQuery,
  GlobalConfigurationAuditQuery,
} from "./adapter";
import {
  configurationAuditQueryString,
  normalizeConfigurationAuditPage,
  normalizeGlobalConfigurationAuditQuery,
  readConfigurationAuditEvent,
  readGlobalConfigurationAuditList,
  readRepositoryConfigurationAuditList,
  validateGlobalConfigurationAuditRead,
  validateRepositoryConfigurationAuditList,
  validateRepositoryConfigurationAuditRead,
} from "./validation";

const globalPath = "/api/v1/operator/configuration-audit";

export class HttpConfigurationAuditAdapter implements ConfigurationAuditAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async listRepositoryConfigurationAudit(
    repositoryId: string,
    query?: ConfigurationAuditPageQuery,
  ) {
    const operation = "list repository configuration audit";
    const normalized = normalizeConfigurationAuditPage(query, operation);
    validateRepositoryConfigurationAuditList(repositoryId, normalized, operation);
    const value = await this.client.get(
      `${OPERATOR_REPOSITORIES_PATH}/${repositoryId}/configuration-audit?${configurationAuditQueryString(normalized)}`,
      operation,
    );
    return readRepositoryConfigurationAuditList(value, repositoryId, normalized, operation);
  }

  async getRepositoryConfigurationAudit(
    repositoryId: string,
    source: ConfigurationAuditSource,
    eventId: string,
    expectedSummary?: ConfigurationAuditSummary,
  ) {
    const operation = "get repository configuration audit";
    const expected = validateRepositoryConfigurationAuditRead(
      repositoryId,
      source,
      eventId,
      expectedSummary,
      operation,
    );
    const value = await this.client.get(
      `${OPERATOR_REPOSITORIES_PATH}/${repositoryId}/configuration-audit/${source}/${eventId}`,
      operation,
    );
    return readConfigurationAuditEvent(value, repositoryId, source, eventId, expected, operation);
  }

  async listGlobalConfigurationAudit(query?: GlobalConfigurationAuditQuery) {
    const operation = "list global configuration audit";
    const normalized = normalizeGlobalConfigurationAuditQuery(query, operation);
    const value = await this.client.get(
      `${globalPath}?${configurationAuditQueryString(normalized)}`,
      operation,
    );
    return readGlobalConfigurationAuditList(value, normalized, operation);
  }

  async getGlobalConfigurationAudit(eventId: string, expectedSummary?: ConfigurationAuditSummary) {
    const operation = "get global configuration audit";
    const expected = validateGlobalConfigurationAuditRead(eventId, expectedSummary, operation);
    const value = await this.client.get(`${globalPath}/${eventId}`, operation);
    return readConfigurationAuditEvent(value, null, "prompt", eventId, expected, operation);
  }
}
