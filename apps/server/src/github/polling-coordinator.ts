import { setTimeout as delay } from "node:timers/promises";

import type { NormalizedSchedulingEvent } from "@agentic-review/contracts";

import {
  type GitHubPollingActiveProjection,
  type GitHubPollingProjectionKey,
  type GitHubPollingReconciliationResult,
  type GitHubPollingRepositoryTarget,
  type GitHubPollingReviewerTarget,
  type GitHubPollingStateSink,
  type GitHubPollingStateSource,
  type GitHubReadClient,
  type ObserveGitHubRateLimit,
  reconcileGitHubPolling,
} from "./poller.js";

export interface GitHubPollingCoordinatorErrorContext {
  readonly repository: GitHubPollingRepositoryTarget;
  readonly reviewer: GitHubPollingReviewerTarget;
}

export type ObserveGitHubPollingError = (
  error: unknown,
  context: GitHubPollingCoordinatorErrorContext,
) => void | Promise<void>;

export type ObserveUnavailableGitHubWorkItems = (
  workItemNumbers: readonly number[],
  context: GitHubPollingCoordinatorErrorContext,
) => void | Promise<void>;

export type EmitNormalizedSchedulingEvent = (
  event: NormalizedSchedulingEvent,
) => void | Promise<void>;

export type CommitGitHubPollingReconciliation = (
  key: GitHubPollingProjectionKey,
  events: readonly NormalizedSchedulingEvent[],
  projection: GitHubPollingActiveProjection,
  signal: AbortSignal,
) => void | Promise<void>;

export interface GitHubPollingCoordinatorOptions {
  readonly client: GitHubReadClient;
  readonly repositories: readonly GitHubPollingRepositoryTarget[];
  readonly reviewer: GitHubPollingReviewerTarget;
  readonly intervalMs: number;
  readonly stateSource: GitHubPollingStateSource;
  readonly commitReconciliation?: CommitGitHubPollingReconciliation;
  /** @deprecated Use commitReconciliation for atomic event and projection persistence. */
  readonly stateSink?: GitHubPollingStateSink;
  /** @deprecated Use commitReconciliation for atomic event and projection persistence. */
  readonly emit?: EmitNormalizedSchedulingEvent;
  readonly signal: AbortSignal;
  readonly pageSize?: number;
  readonly maxSearchPages?: number;
  readonly maxTimelinePages?: number;
  readonly now?: () => Date;
  readonly observeRateLimit?: ObserveGitHubRateLimit;
  readonly observeError?: ObserveGitHubPollingError;
  readonly observeUnavailableWorkItems?: ObserveUnavailableGitHubWorkItems;
  readonly isPermanentlyUnavailableWorkItem?: (error: unknown) => boolean;
  readonly clock?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface GitHubPollingRepositorySuccess {
  readonly status: "fulfilled";
  readonly repository: GitHubPollingRepositoryTarget;
  readonly result: GitHubPollingReconciliationResult;
}

export interface GitHubPollingRepositoryFailure {
  readonly status: "rejected";
  readonly repository: GitHubPollingRepositoryTarget;
  readonly error: unknown;
}

export type GitHubPollingRepositoryOutcome =
  | GitHubPollingRepositorySuccess
  | GitHubPollingRepositoryFailure;

/**
 * Runs repository reconciliation serially. Concurrent pollOnce calls share the same in-flight
 * cycle, and the interval is measured from the start of one cycle to the start of the next.
 */
export class GitHubPollingCoordinator {
  readonly #options: GitHubPollingCoordinatorOptions;
  readonly #clock: () => number;
  readonly #sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  #activeCycle: Promise<readonly GitHubPollingRepositoryOutcome[]> | null = null;
  #runPromise: Promise<void> | null = null;

  public constructor(options: GitHubPollingCoordinatorOptions) {
    validateOptions(options);
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? sleepWithSignal;
  }

  public pollOnce(): Promise<readonly GitHubPollingRepositoryOutcome[]> {
    if (this.#activeCycle !== null) {
      return this.#activeCycle;
    }
    const cycle = this.#pollRepositories().finally(() => {
      if (this.#activeCycle === cycle) {
        this.#activeCycle = null;
      }
    });
    this.#activeCycle = cycle;
    return cycle;
  }

  public run(): Promise<void> {
    if (this.#runPromise !== null) {
      return this.#runPromise;
    }
    const running = this.#runLoop().finally(() => {
      if (this.#runPromise === running) {
        this.#runPromise = null;
      }
    });
    this.#runPromise = running;
    return running;
  }

  async #runLoop(): Promise<void> {
    const { signal } = this.#options;
    while (!signal.aborted) {
      const startedAt = this.#clock();
      try {
        await this.pollOnce();
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        throw error;
      }
      if (signal.aborted) {
        return;
      }
      const elapsed = Math.max(0, this.#clock() - startedAt);
      const waitMs = Math.max(0, this.#options.intervalMs - elapsed);
      try {
        await this.#sleep(waitMs, signal);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        throw error;
      }
    }
  }

  async #pollRepositories(): Promise<readonly GitHubPollingRepositoryOutcome[]> {
    const outcomes: GitHubPollingRepositoryOutcome[] = [];
    for (const repository of this.#options.repositories) {
      this.#options.signal.throwIfAborted();
      try {
        const result = await this.#pollRepository(repository);
        outcomes.push({ status: "fulfilled", repository, result });
      } catch (error) {
        this.#options.signal.throwIfAborted();
        outcomes.push({ status: "rejected", repository, error });
        if (this.#options.observeError !== undefined) {
          await this.#options.observeError(error, { repository, reviewer: this.#options.reviewer });
          this.#options.signal.throwIfAborted();
        }
      }
    }
    return outcomes;
  }

  async #pollRepository(
    repository: GitHubPollingRepositoryTarget,
  ): Promise<GitHubPollingReconciliationResult> {
    const key = projectionKey(repository, this.#options.reviewer);
    const previousActiveProjection = await this.#options.stateSource.readActiveProjection(
      key,
      this.#options.signal,
    );
    this.#options.signal.throwIfAborted();
    const events: NormalizedSchedulingEvent[] = [];
    const result = await reconcileGitHubPolling({
      client: this.#options.client,
      repository,
      reviewer: this.#options.reviewer,
      ingest: (event) => {
        events.push(event);
      },
      signal: this.#options.signal,
      ...(this.#options.pageSize === undefined ? {} : { pageSize: this.#options.pageSize }),
      ...(this.#options.maxSearchPages === undefined
        ? {}
        : { maxSearchPages: this.#options.maxSearchPages }),
      ...(this.#options.maxTimelinePages === undefined
        ? {}
        : { maxTimelinePages: this.#options.maxTimelinePages }),
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      ...(this.#options.observeRateLimit === undefined
        ? {}
        : { observeRateLimit: this.#options.observeRateLimit }),
      ...(this.#options.isPermanentlyUnavailableWorkItem === undefined
        ? {}
        : {
            isPermanentlyUnavailableWorkItem: this.#options.isPermanentlyUnavailableWorkItem,
          }),
      previousActiveProjection,
    });
    this.#options.signal.throwIfAborted();
    if (this.#options.commitReconciliation !== undefined) {
      await this.#options.commitReconciliation(
        key,
        Object.freeze([...events]),
        result.nextActiveProjection,
        this.#options.signal,
      );
    } else {
      const emit = this.#options.emit;
      const stateSink = this.#options.stateSink;
      if (emit === undefined || stateSink === undefined) {
        throw new Error("GitHub polling persistence was not configured.");
      }
      for (const event of events) {
        this.#options.signal.throwIfAborted();
        await emit(event);
      }
      this.#options.signal.throwIfAborted();
      await stateSink.writeActiveProjection(key, result.nextActiveProjection, this.#options.signal);
    }
    if (
      result.unavailableWorkItemNumbers.length > 0 &&
      this.#options.observeUnavailableWorkItems !== undefined
    ) {
      await this.#options.observeUnavailableWorkItems(result.unavailableWorkItemNumbers, {
        repository,
        reviewer: this.#options.reviewer,
      });
    }
    return result;
  }
}

export function runGitHubPollingCoordinator(
  options: GitHubPollingCoordinatorOptions,
): Promise<void> {
  return new GitHubPollingCoordinator(options).run();
}

function projectionKey(
  repository: GitHubPollingRepositoryTarget,
  reviewer: GitHubPollingReviewerTarget,
): GitHubPollingProjectionKey {
  return {
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
    reviewerGithubUserId: reviewer.githubUserId,
  };
}

function validateOptions(options: GitHubPollingCoordinatorOptions): void {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive safe integer.");
  }
  if (
    options.commitReconciliation === undefined &&
    (options.emit === undefined || options.stateSink === undefined)
  ) {
    throw new TypeError(
      "Configure commitReconciliation, or both emit and stateSink for legacy persistence.",
    );
  }
  if (options.repositories.length === 0) {
    throw new TypeError("At least one GitHub polling repository must be configured.");
  }
  const repositoryIds = new Set<number>();
  const repositoryNames = new Set<string>();
  for (const repository of options.repositories) {
    if (
      !Number.isSafeInteger(repository.githubRepositoryId) ||
      repository.githubRepositoryId <= 0
    ) {
      throw new TypeError("Each GitHub polling repository must have a positive numeric ID.");
    }
    const name = repository.fullName.toLowerCase();
    if (repositoryIds.has(repository.githubRepositoryId) || repositoryNames.has(name)) {
      throw new TypeError("GitHub polling repositories must be unique by ID and full name.");
    }
    repositoryIds.add(repository.githubRepositoryId);
    repositoryNames.add(name);
  }
  if (!Number.isSafeInteger(options.reviewer.githubUserId) || options.reviewer.githubUserId <= 0) {
    throw new TypeError("The GitHub polling reviewer must have a positive numeric ID.");
  }
}

async function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  await delay(delayMs, undefined, { signal });
}
