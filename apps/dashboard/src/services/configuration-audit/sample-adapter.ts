import type {
  ConfigurationAuditEvent,
  ConfigurationAuditSource,
  ConfigurationAuditSummary,
} from "@agentic-review/contracts";
import { sampleOperatorPrincipal } from "../access/mock-adapter";
import { ReviewControlError, ReviewControlHttpError } from "../review-control/errors";
import type {
  ConfigurationAuditAdapter,
  ConfigurationAuditPageQuery,
  GlobalConfigurationAuditQuery,
} from "./adapter";
import {
  normalizeConfigurationAuditPage,
  readConfigurationAuditEvent,
  readRepositoryConfigurationAuditList,
  validateRepositoryConfigurationAuditList,
  validateRepositoryConfigurationAuditRead,
} from "./validation";

export class ConfigurationAuditUnavailableError extends ReviewControlError {
  constructor(operation: string) {
    super(
      "unsupported_operation",
      "Global prompt configuration history is unavailable in sample mode. Connect to the control plane to read recorded events.",
      { operation, retryable: false },
    );
    this.name = "ConfigurationAuditUnavailableError";
  }
}

export class SampleConfigurationAuditAdapter implements ConfigurationAuditAdapter {
  readonly mode = "sample" as const;

  async listRepositoryConfigurationAudit(
    repositoryId: string,
    query?: ConfigurationAuditPageQuery,
  ) {
    const operation = "list repository configuration audit";
    const normalized = normalizeConfigurationAuditPage(query, operation);
    validateRepositoryConfigurationAuditList(repositoryId, normalized, operation);
    const events = sampleRepositoryEvents.filter((event) => event.repositoryId === repositoryId);
    const offset = (normalized.page - 1) * normalized.pageSize;
    const items = events
      .slice(offset, offset + normalized.pageSize)
      .map(({ snapshot: _snapshot, ...summary }) => structuredClone(summary));
    return readRepositoryConfigurationAuditList(
      { repositoryId, ...normalized, total: events.length, items },
      repositoryId,
      normalized,
      operation,
    );
  }

  async getRepositoryConfigurationAudit(
    repositoryId: string,
    source: ConfigurationAuditSource,
    eventId: string,
    expectedSummary?: ConfigurationAuditSummary,
  ) {
    const operation = "get repository configuration audit";
    const summary = validateRepositoryConfigurationAuditRead(
      repositoryId,
      source,
      eventId,
      expectedSummary,
      operation,
    );
    const event = sampleRepositoryEvents.find(
      (item) => item.repositoryId === repositoryId && item.source === source && item.id === eventId,
    );
    if (!event)
      throw new ReviewControlHttpError("The sample configuration event does not exist.", {
        operation,
        status: 404,
        retryable: false,
      });
    return readConfigurationAuditEvent(
      structuredClone(event),
      repositoryId,
      source,
      eventId,
      summary,
      operation,
    );
  }

  async listGlobalConfigurationAudit(_query?: GlobalConfigurationAuditQuery): Promise<never> {
    throw new ConfigurationAuditUnavailableError("list global configuration audit");
  }

  async getGlobalConfigurationAudit(
    _eventId: string,
    _expectedSummary?: ConfigurationAuditSummary,
  ): Promise<never> {
    throw new ConfigurationAuditUnavailableError("get global configuration audit");
  }
}

// Fixed illustrative receipts are independent of current mutable sample settings.
const sampleRepositoryEvents: readonly ConfigurationAuditEvent[] = [
  {
    id: "sample-repository-history-v1",
    source: "repository",
    action: "created",
    entityId: "repo-powertoys",
    repositoryId: "repo-powertoys",
    version: 1,
    actor: { ...sampleOperatorPrincipal },
    createdAt: "2026-09-06T08:00:00.000Z",
    snapshot: {
      id: "repo-powertoys",
      githubRepositoryId: 184456251,
      fullName: "microsoft/PowerToys",
      enabled: true,
      version: 1,
      reviewerGithubUserId: null,
      reviewerGithubLogin: null,
      authorizationPolicy: null,
      connectionStatus: "unknown",
      connectionMessage: null,
      createdAt: "2026-09-06T08:00:00.000Z",
      updatedAt: "2026-09-06T08:00:00.000Z",
    },
  },
  {
    id: "sample-repository-history-v2",
    source: "repository",
    action: "created",
    entityId: "repo-terminal",
    repositoryId: "repo-terminal",
    version: 1,
    actor: { ...sampleOperatorPrincipal },
    createdAt: "2026-09-06T08:00:00.000Z",
    snapshot: {
      id: "repo-terminal",
      githubRepositoryId: 100060912,
      fullName: "microsoft/terminal",
      enabled: false,
      version: 1,
      reviewerGithubUserId: null,
      reviewerGithubLogin: null,
      authorizationPolicy: null,
      schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: null },
      connectionStatus: "unknown",
      connectionMessage: null,
      createdAt: "2026-09-06T08:00:00.000Z",
      updatedAt: "2026-09-06T08:00:00.000Z",
    },
  },
];
