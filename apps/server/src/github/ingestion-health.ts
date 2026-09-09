import type { DashboardHealthComponent } from "@agentic-review/contracts";
import type { GitHubRepositoryTargetConfig, ServerConfig } from "../config.js";

export interface GitHubIngestionHealthSource {
  getHealth(): DashboardHealthComponent;
}

export interface GitHubIngestionHealthTracker extends GitHubIngestionHealthSource {
  updatePollingTargets(targets: readonly GitHubIngestionPollingTarget[]): void;
  recordReconciliationSuccess(
    repository: GitHubRepositoryTargetConfig,
    reviewerGithubUserId?: number,
  ): void;
  recordReconciliationFailure(
    repository: GitHubRepositoryTargetConfig,
    reviewerGithubUserId?: number,
  ): void;
  /** Record only authenticated deliveries for repositories accepted by the ingestion service. */
  recordWebhookSuccess(repository: GitHubRepositoryTargetConfig): void;
  recordWebhookFailure(repository: GitHubRepositoryTargetConfig): void;
}

export interface GitHubIngestionPollingTarget {
  readonly repository: GitHubRepositoryTargetConfig;
  readonly reviewer: { readonly githubUserId: number };
}

interface RepositoryObservationHealth {
  fullName: string;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  latestOutcome: "success" | "failure" | null;
}

interface RepositoryReconciliationHealth extends RepositoryObservationHealth {
  readonly githubRepositoryId: number;
  watchingSince: number;
}

const toleratedPollingIntervals = 3;
const targetKey = (repositoryId: number, reviewerId: number): string =>
  `${repositoryId}:${reviewerId}`;

function recordObservation(
  state: RepositoryObservationHealth,
  outcome: "success" | "failure",
  observedAt: number,
): void {
  state.latestOutcome = outcome;
  if (outcome === "success") {
    state.lastSuccessAt = observedAt;
  } else {
    state.lastFailureAt = observedAt;
  }
}

export const createGitHubIngestionHealthTracker = (
  config: Pick<ServerConfig, "github" | "recoveryMaintenance">,
  now: () => Date = () => new Date(),
): GitHubIngestionHealthTracker => {
  const startedAt = now().getTime();
  const maintenance = config.recoveryMaintenance;
  const github = config.github;
  const legacyBootstrap = github?.legacyBootstrap;
  const pollingIntervalSeconds = github?.polling?.intervalSeconds;
  const webhookConfigured = github?.webhook !== undefined;
  const defaultReviewerId = legacyBootstrap?.reviewer.githubUserId;
  const repositories = new Map<string, RepositoryReconciliationHealth>();
  const webhookRepositories = new Map<number, RepositoryObservationHealth>();
  let activeTargets = new Set<string>();

  const updateTargets = (
    targets: readonly GitHubIngestionPollingTarget[],
    observedAt: number,
  ): void => {
    const snapshot = new Map<
      string,
      { readonly githubRepositoryId: number; readonly fullName: string }
    >();
    const namesById = new Map<number, string>();
    const idsByName = new Map<string, number>();
    for (const { repository, reviewer } of targets) {
      if (
        !Number.isSafeInteger(repository.githubRepositoryId) ||
        repository.githubRepositoryId <= 0 ||
        !Number.isSafeInteger(reviewer.githubUserId) ||
        reviewer.githubUserId <= 0 ||
        typeof repository.fullName !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.fullName)
      ) {
        throw new TypeError(
          "Polling health targets require valid repository and reviewer identities.",
        );
      }
      const fullName = repository.fullName.toLowerCase();
      const existingName = namesById.get(repository.githubRepositoryId);
      const existingId = idsByName.get(fullName);
      if (
        (existingName !== undefined && existingName !== fullName) ||
        (existingId !== undefined && existingId !== repository.githubRepositoryId)
      ) {
        throw new TypeError("Polling health targets contain conflicting repository identities.");
      }
      namesById.set(repository.githubRepositoryId, fullName);
      idsByName.set(fullName, repository.githubRepositoryId);
      snapshot.set(targetKey(repository.githubRepositoryId, reviewer.githubUserId), {
        githubRepositoryId: repository.githubRepositoryId,
        fullName,
      });
    }
    for (const [key, repository] of snapshot) {
      const existing = repositories.get(key);
      if (existing === undefined) {
        repositories.set(key, {
          ...repository,
          watchingSince: observedAt,
          lastSuccessAt: null,
          lastFailureAt: null,
          latestOutcome: null,
        });
      } else {
        existing.fullName = repository.fullName;
        if (!activeTargets.has(key)) existing.watchingSince = observedAt;
      }
    }
    // Retain retired targets' observations without counting them as current polling obligations.
    activeTargets = new Set(snapshot.keys());
  };

  updateTargets(
    defaultReviewerId === undefined
      ? []
      : (legacyBootstrap?.repositories ?? []).map((repository) => ({
          repository,
          reviewer: { githubUserId: defaultReviewerId },
        })),
    startedAt,
  );

  const recordOutcome = (
    repository: GitHubRepositoryTargetConfig,
    outcome: "success" | "failure",
    reviewerGithubUserId = defaultReviewerId,
  ): void => {
    if (maintenance || pollingIntervalSeconds === undefined || reviewerGithubUserId === undefined) {
      return;
    }
    const state = repositories.get(targetKey(repository.githubRepositoryId, reviewerGithubUserId));
    if (state === undefined || state.fullName !== repository.fullName.toLowerCase()) {
      return;
    }
    recordObservation(state, outcome, now().getTime());
  };

  const recordWebhookOutcome = (
    repository: GitHubRepositoryTargetConfig,
    outcome: "success" | "failure",
  ): void => {
    if (maintenance || !webhookConfigured) return;
    let state = webhookRepositories.get(repository.githubRepositoryId);
    if (state === undefined) {
      state = {
        fullName: repository.fullName.toLowerCase(),
        lastSuccessAt: null,
        lastFailureAt: null,
        latestOutcome: null,
      };
      webhookRepositories.set(repository.githubRepositoryId, state);
    }
    state.fullName = repository.fullName.toLowerCase();
    recordObservation(state, outcome, now().getTime());
  };

  return {
    updatePollingTargets: (targets) => updateTargets(targets, now().getTime()),
    recordReconciliationSuccess: (repository, reviewerId) =>
      recordOutcome(repository, "success", reviewerId),
    recordReconciliationFailure: (repository, reviewerId) =>
      recordOutcome(repository, "failure", reviewerId),
    recordWebhookSuccess: (repository) => recordWebhookOutcome(repository, "success"),
    recordWebhookFailure: (repository) => recordWebhookOutcome(repository, "failure"),
    getHealth: () => {
      const checkedAt = now();
      let webhookFailures = 0;
      let lastWebhookFailure: number | null = null;
      let lastWebhookSuccess: number | null = null;
      for (const state of webhookRepositories.values()) {
        if (state.latestOutcome === "failure") {
          webhookFailures += 1;
          if (state.lastFailureAt !== null) {
            lastWebhookFailure = Math.max(
              lastWebhookFailure ?? state.lastFailureAt,
              state.lastFailureAt,
            );
          }
        }
        if (state.lastSuccessAt !== null) {
          lastWebhookSuccess = Math.max(
            lastWebhookSuccess ?? state.lastSuccessAt,
            state.lastSuccessAt,
          );
        }
      }
      const webhookFailureTime =
        lastWebhookFailure === null
          ? ""
          : ` Latest processing failure: ${new Date(lastWebhookFailure).toISOString()}.`;
      const webhookSummary =
        webhookFailures > 0
          ? ` Webhook processing failed for ${webhookFailures} of ${webhookRepositories.size} observed repositories.${webhookFailureTime}`
          : lastWebhookSuccess === null
            ? ""
            : ` Successfully processed webhooks for ${webhookRepositories.size} observed repositories. Latest processing success: ${new Date(lastWebhookSuccess).toISOString()}.`;
      const health = (
        status: DashboardHealthComponent["status"],
        summary: string,
      ): DashboardHealthComponent => ({
        id: "github",
        name: "GitHub ingestion",
        status: webhookFailures > 0 ? "degraded" : status,
        summary: `${summary}${webhookSummary}`,
        checkedAt: checkedAt.toISOString(),
      });

      if (maintenance) {
        return health("healthy", "GitHub ingestion is paused during recovery maintenance.");
      }
      if (pollingIntervalSeconds === undefined) {
        return webhookConfigured
          ? health(
              "healthy",
              "GitHub webhook ingestion is configured. Idle delivery periods are expected; remote webhook delivery is not verified by this status.",
            )
          : health("healthy", "GitHub ingestion is disabled by configuration.");
      }

      // Allow missed cycles without imposing a fixed event-activity deadline.
      const freshnessSeconds = pollingIntervalSeconds * toleratedPollingIntervals;
      const freshnessMilliseconds = freshnessSeconds * 1_000;
      let failed = 0;
      let stale = 0;
      let pending = 0;
      let overdueInitial = 0;
      let latestFailureAt: number | null = null;
      const currentRepositories = new Set<number>();
      const affectedRepositories = new Set<number>();
      for (const key of activeTargets) {
        const state = repositories.get(key);
        if (state === undefined) continue;
        currentRepositories.add(state.githubRepositoryId);
        if (state.latestOutcome === "failure") {
          failed += 1;
          affectedRepositories.add(state.githubRepositoryId);
          if (state.lastFailureAt !== null) {
            latestFailureAt = Math.max(latestFailureAt ?? state.lastFailureAt, state.lastFailureAt);
          }
        } else if (state.lastSuccessAt === null) {
          pending += 1;
          if (checkedAt.getTime() - state.watchingSince > freshnessMilliseconds) {
            overdueInitial += 1;
            affectedRepositories.add(state.githubRepositoryId);
          }
        } else if (checkedAt.getTime() - state.lastSuccessAt > freshnessMilliseconds) {
          stale += 1;
          affectedRepositories.add(state.githubRepositoryId);
        }
      }

      const affected = affectedRepositories.size;
      const repositoryCount = currentRepositories.size;
      const reviewerSummary =
        activeTargets.size === repositoryCount
          ? ""
          : ` Tracking ${activeTargets.size} repository/reviewer targets.`;
      if (activeTargets.size === 0) {
        return health("healthy", "Polling has no active repository targets.");
      }
      if (affected > 0) {
        const reasons: string[] = [];
        if (failed > 0) {
          reasons.push(`${failed} latest reconciliations failed`);
        }
        if (stale > 0) {
          reasons.push(`${stale} successful reconciliations are overdue`);
        }
        if (overdueInitial > 0) {
          reasons.push(`${overdueInitial} initial reconciliations are overdue`);
        }
        const lastFailure =
          latestFailureAt === null
            ? ""
            : ` Latest failure: ${new Date(latestFailureAt).toISOString()}.`;
        return health(
          "degraded",
          `Polling needs attention for ${affected} of ${repositoryCount} configured repositories: ${reasons.join("; ")}. The freshness window is ${freshnessSeconds} seconds (${toleratedPollingIntervals} polling intervals).${lastFailure}${reviewerSummary}`,
        );
      }
      if (pending > 0) {
        return health(
          "healthy",
          `Polling is configured for ${repositoryCount} repositories; ${pending} await their first reconciliation within the ${freshnessSeconds}-second startup grace period.${reviewerSummary}`,
        );
      }
      return health(
        "healthy",
        `Polling successfully reconciled all ${repositoryCount} configured repositories within the ${freshnessSeconds}-second freshness window (${pollingIntervalSeconds}-second polling interval).${reviewerSummary}`,
      );
    },
  };
};
