import {
  type ManagedRepository,
  type NormalizedSchedulingEvent,
  type SelfOrAllowlistPolicy,
  SelfOrAllowlistPolicySchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { DatabaseClient } from "../database/database-client.js";
import type { GitHubPollingReconciliationEventInput } from "../database/github-polling-state.js";
import type { GitHubEventRuntimeConfiguration } from "../github/ingestion-service.js";
import type { GitHubPollingProjectionKey, GitHubPollingReviewerTarget } from "../github/poller.js";
import type { GitHubPollingRuntimeTarget } from "../github/polling-coordinator.js";
import { createScheduleJobInput } from "../scheduling/job-factory.js";
import {
  isLoadedTrustedSchedulingConfig,
  type TrustedSchedulingConfig,
  withPublishedWorkflowPrompt,
} from "../scheduling/trusted-config.js";

export class ManagedGitHubConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ManagedGitHubConfigurationError";
  }
}

export interface ManagedGitHubRuntimeConfigurationOptions {
  readonly database: Pick<DatabaseClient, "request">;
  readonly legacySchedulingConfig: TrustedSchedulingConfig;
}

export class ManagedGitHubRuntimeConfiguration {
  readonly #database: Pick<DatabaseClient, "request">;
  readonly #legacySchedulingConfig: TrustedSchedulingConfig;

  public constructor(options: ManagedGitHubRuntimeConfigurationOptions) {
    if (!isLoadedTrustedSchedulingConfig(options.legacySchedulingConfig)) {
      throw new ManagedGitHubConfigurationError(
        "Legacy defaults must be loaded trusted configuration.",
      );
    }
    this.#database = options.database;
    this.#legacySchedulingConfig = options.legacySchedulingConfig;
  }

  public async resolveEvent(
    event: NormalizedSchedulingEvent,
  ): Promise<GitHubEventRuntimeConfiguration | null> {
    const repository = await this.#readRepository(
      event.repository.githubRepositoryId,
      event.repository.fullName,
    );
    return repository === null ? null : this.#resolveForRepository(repository, event);
  }

  public async prepareReconciliation(
    key: GitHubPollingProjectionKey,
    events: readonly NormalizedSchedulingEvent[],
  ): Promise<readonly GitHubPollingReconciliationEventInput[]> {
    const repository = await this.#readRepository(key.githubRepositoryId, key.repositoryFullName);
    if (repository === null) {
      throw new ManagedGitHubConfigurationError("The polling repository is no longer configured.");
    }
    const entries: GitHubPollingReconciliationEventInput[] = [];
    for (const event of events) {
      if (
        event.repository.githubRepositoryId !== key.githubRepositoryId ||
        event.repository.fullName.toLowerCase() !== key.repositoryFullName.toLowerCase()
      ) {
        throw new ManagedGitHubConfigurationError("A polling event belongs to another repository.");
      }
      const configuration = await this.#resolveForRepository(
        repository,
        event,
        key.reviewerGithubUserId,
      );
      entries.push({
        event,
        policy: configuration.policy,
        allowScheduling: configuration.allowScheduling,
        schedule: configuration.schedule,
      });
    }
    return freeze(entries);
  }

  public async listPollingTargets(): Promise<readonly GitHubPollingRuntimeTarget[]> {
    const targets: GitHubPollingRuntimeTarget[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page += 1) {
      const listed = await this.#database.request("listManagedRepositories", {
        page,
        pageSize: 50,
      });
      for (const summary of listed.items) {
        const repository = await this.#database.request("getManagedRepository", {
          repositoryId: summary.id,
        });
        if (repository === null) continue;
        const current = configuredReviewer(repository);
        const historical = await this.#database.request("listManagedRepositoryPollingReviewers", {
          repositoryId: repository.id,
        });
        // Paused repositories and former reviewers still reconcile closure and withdrawal.
        // The event resolver independently prevents these observations from authorizing jobs.
        for (const reviewer of [...(current === null ? [] : [current]), ...historical]) {
          const key = `${repository.githubRepositoryId}:${reviewer.githubUserId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push({
            repository: {
              githubRepositoryId: repository.githubRepositoryId,
              fullName: repository.fullName,
            },
            reviewer: { ...reviewer },
          });
        }
      }
      if (page * 50 >= listed.total || listed.items.length === 0) break;
    }
    return freeze(targets);
  }

  async #readRepository(
    githubRepositoryId: number,
    fullName: string,
  ): Promise<ManagedRepository | null> {
    const repository = await this.#database.request("getManagedRepositoryByGitHubId", {
      githubRepositoryId,
    });
    if (repository === null || repository.fullName.toLowerCase() !== fullName.toLowerCase())
      return null;
    return freeze(JSON.parse(JSON.stringify(repository)) as ManagedRepository);
  }

  async #resolveForRepository(
    repository: ManagedRepository,
    event: NormalizedSchedulingEvent,
    pollingReviewerId?: number,
  ): Promise<GitHubEventRuntimeConfiguration> {
    const reviewer = configuredReviewer(repository);
    const configuredPolicy = repository.authorizationPolicy;
    if (
      configuredPolicy !== null &&
      (!Value.Check(SelfOrAllowlistPolicySchema, configuredPolicy) ||
        reviewer === null ||
        configuredPolicy.schedulingTargetGithubUserId !== reviewer.githubUserId)
    ) {
      throw new ManagedGitHubConfigurationError(
        "The repository authorization policy is inconsistent.",
      );
    }
    const isCurrentReviewer =
      pollingReviewerId === undefined || pollingReviewerId === reviewer?.githubUserId;
    const allowScheduling = repository.enabled && configuredPolicy !== null && isCurrentReviewer;
    const observationReviewerId =
      pollingReviewerId ??
      reviewer?.githubUserId ??
      event.target?.githubUserId ??
      event.author.githubUserId;
    const policy: SelfOrAllowlistPolicy =
      configuredPolicy !== null && isCurrentReviewer
        ? {
            ...configuredPolicy,
            allowlistedActorGithubUserIds: [...configuredPolicy.allowlistedActorGithubUserIds],
          }
        : {
            kind: "self_or_allowlist",
            policyVersion: repository.version,
            schedulingTargetGithubUserId: observationReviewerId,
            allowlistedActorGithubUserIds: [],
            unknownActorPolicy: "deny",
            newRevisionPolicy: "require_new_authorization",
          };
    let schedule = null;
    if (
      allowScheduling &&
      (event.action === "request_opened" || event.action === "revision_observed")
    ) {
      const workflowKind = event.workItem.kind === "issue" ? "issue_triage" : "pr_static_build";
      const published = await this.#database.request("resolveWorkflowPrompt", {
        repositoryId: repository.id,
        workflowKind,
      });
      const config =
        published === null
          ? this.#legacySchedulingConfig
          : withPublishedWorkflowPrompt(this.#legacySchedulingConfig, {
              workflowKind,
              templateName: published.templateName,
              version: published.version,
            });
      schedule = createScheduleJobInput(event, config);
    }
    return freeze({
      repository: {
        githubRepositoryId: repository.githubRepositoryId,
        fullName: repository.fullName,
      },
      policy,
      allowScheduling,
      schedule,
    });
  }
}

function configuredReviewer(repository: ManagedRepository): GitHubPollingReviewerTarget | null {
  const githubUserId = repository.reviewerGithubUserId;
  const login = repository.reviewerGithubLogin;
  if (githubUserId === null && login === null) return null;
  if (
    githubUserId === null ||
    !Number.isSafeInteger(githubUserId) ||
    githubUserId <= 0 ||
    login === null ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(login) ||
    login.trim() !== login
  ) {
    throw new ManagedGitHubConfigurationError("The repository reviewer is invalid.");
  }
  return { githubUserId, login };
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
