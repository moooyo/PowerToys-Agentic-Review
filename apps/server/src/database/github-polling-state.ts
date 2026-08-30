import type { DatabaseSync } from "node:sqlite";
import type {
  GitHubPollingActiveProjection,
  GitHubPollingProjectionKey,
  GitHubPollingStateSink,
  GitHubPollingStateSource,
} from "../github/poller.js";
import type { DatabaseClient } from "./database-client.js";
import { ingestSchedulingEventInTransaction } from "./github-ingestion.js";
import type { IngestSchedulingEventInput, IngestSchedulingEventResult } from "./protocol.js";

export interface WriteGitHubPollingProjectionInput {
  readonly key: GitHubPollingProjectionKey;
  readonly projection: GitHubPollingActiveProjection;
  readonly updatedAt: string;
}

export interface ReadGitHubPollingProjectionResult {
  readonly projection: GitHubPollingActiveProjection | null;
}

export type GitHubPollingReconciliationEventInput = Omit<IngestSchedulingEventInput, "delivery">;

export interface CommitGitHubPollingReconciliationInput {
  readonly key: GitHubPollingProjectionKey;
  readonly projection: GitHubPollingActiveProjection;
  readonly events: readonly GitHubPollingReconciliationEventInput[];
  readonly updatedAt: string;
}

export interface CommitGitHubPollingReconciliationResult {
  readonly written: true;
  readonly eventResults: readonly IngestSchedulingEventResult[];
}

const projectionKeyText = (key: GitHubPollingProjectionKey): string =>
  `${key.githubRepositoryId}:${key.reviewerGithubUserId}`;

const assertKeyMatchesProjection = (
  key: GitHubPollingProjectionKey,
  projection: GitHubPollingActiveProjection,
): void => {
  if (
    projection.githubRepositoryId !== key.githubRepositoryId ||
    projection.repositoryFullName.toLowerCase() !== key.repositoryFullName.toLowerCase() ||
    projection.reviewerGithubUserId !== key.reviewerGithubUserId
  ) {
    throw new TypeError("The GitHub polling projection does not match its persistence key.");
  }
};

const assertReconciliationInput = (input: CommitGitHubPollingReconciliationInput): void => {
  assertKeyMatchesProjection(input.key, input.projection);
  if (!Number.isFinite(Date.parse(input.updatedAt))) {
    throw new TypeError("GitHub polling reconciliation updatedAt must be a valid date-time value.");
  }
  for (const entry of input.events) {
    if (entry.event.source !== "poll" && entry.event.source !== "reconciliation") {
      throw new TypeError("GitHub polling reconciliation cannot commit webhook events.");
    }
    if (
      entry.event.repository.githubRepositoryId !== input.key.githubRepositoryId ||
      entry.event.repository.fullName.toLowerCase() !==
        input.key.repositoryFullName.toLowerCase() ||
      entry.policy.schedulingTargetGithubUserId !== input.key.reviewerGithubUserId
    ) {
      throw new TypeError(
        "A GitHub polling reconciliation event does not match its projection key.",
      );
    }
  }
};

const withImmediateTransaction = <T>(database: DatabaseSync, action: () => T): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const readGitHubPollingProjection = (
  database: DatabaseSync,
  key: GitHubPollingProjectionKey,
): ReadGitHubPollingProjectionResult => {
  const row = database
    .prepare(`
      SELECT projection_json
      FROM github_polling_projections
      WHERE projection_key = ?
        AND github_repository_id = ?
        AND repository_full_name = ? COLLATE NOCASE
        AND reviewer_github_user_id = ?
    `)
    .get(
      projectionKeyText(key),
      key.githubRepositoryId,
      key.repositoryFullName,
      key.reviewerGithubUserId,
    ) as unknown as { readonly projection_json: string } | undefined;
  return {
    projection:
      row === undefined ? null : (JSON.parse(row.projection_json) as GitHubPollingActiveProjection),
  };
};

export const writeGitHubPollingProjection = (
  database: DatabaseSync,
  input: WriteGitHubPollingProjectionInput,
): { readonly written: true } => {
  assertKeyMatchesProjection(input.key, input.projection);
  if (!Number.isFinite(Date.parse(input.updatedAt))) {
    throw new TypeError("GitHub polling projection updatedAt must be a valid date-time value.");
  }
  database
    .prepare(`
      INSERT INTO github_polling_projections (
        projection_key,
        github_repository_id,
        repository_full_name,
        reviewer_github_user_id,
        projection_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (projection_key) DO UPDATE SET
        github_repository_id = excluded.github_repository_id,
        repository_full_name = excluded.repository_full_name,
        reviewer_github_user_id = excluded.reviewer_github_user_id,
        projection_json = excluded.projection_json,
        updated_at = excluded.updated_at
    `)
    .run(
      projectionKeyText(input.key),
      input.key.githubRepositoryId,
      input.key.repositoryFullName,
      input.key.reviewerGithubUserId,
      JSON.stringify(input.projection),
      input.updatedAt,
    );
  return { written: true };
};

export const commitGitHubPollingReconciliation = (
  database: DatabaseSync,
  input: CommitGitHubPollingReconciliationInput,
): CommitGitHubPollingReconciliationResult => {
  assertReconciliationInput(input);
  return withImmediateTransaction(database, () => {
    const eventResults = input.events.map((entry) =>
      ingestSchedulingEventInTransaction(database, { ...entry, delivery: null }),
    );
    writeGitHubPollingProjection(database, {
      key: input.key,
      projection: input.projection,
      updatedAt: input.updatedAt,
    });
    return { written: true, eventResults };
  });
};

export class DatabaseGitHubPollingState
  implements GitHubPollingStateSource, GitHubPollingStateSink
{
  readonly #database: Pick<DatabaseClient, "request">;

  public constructor(database: Pick<DatabaseClient, "request">) {
    this.#database = database;
  }

  public async readActiveProjection(
    key: GitHubPollingProjectionKey,
    signal: AbortSignal | undefined,
  ): Promise<GitHubPollingActiveProjection | null> {
    signal?.throwIfAborted();
    const result = await this.#database.request("readGitHubPollingProjection", key);
    signal?.throwIfAborted();
    return result.projection;
  }

  public async writeActiveProjection(
    key: GitHubPollingProjectionKey,
    projection: GitHubPollingActiveProjection,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.#database.request("writeGitHubPollingProjection", {
      key,
      projection,
      updatedAt: new Date().toISOString(),
    });
    signal?.throwIfAborted();
  }

  public async commitReconciliation(
    key: GitHubPollingProjectionKey,
    projection: GitHubPollingActiveProjection,
    events: readonly GitHubPollingReconciliationEventInput[],
    signal: AbortSignal | undefined,
  ): Promise<readonly IngestSchedulingEventResult[]> {
    signal?.throwIfAborted();
    const result = await this.#database.request("commitGitHubPollingReconciliation", {
      key,
      projection,
      events,
      updatedAt: new Date().toISOString(),
    });
    signal?.throwIfAborted();
    return result.eventResults;
  }
}
