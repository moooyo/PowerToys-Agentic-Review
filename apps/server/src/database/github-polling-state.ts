import type { DatabaseSync } from "node:sqlite";
import {
  ActiveAuthorizedRequestEpochSchema,
  type NormalizedSchedulingEvent,
  NormalizedSchedulingEventSchema,
  type SchedulingRequestKind,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type {
  GitHubPollingActiveProjection,
  GitHubPollingProjectionKey,
  GitHubPollingStateSink,
  GitHubPollingStateSource,
  GitHubPollingWorkItemProjection,
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

interface ActiveEpochPollingSeedRow {
  readonly epoch_id: string;
  readonly epoch_json: string;
  readonly request_kind: SchedulingRequestKind;
  readonly target_github_user_id: number;
  readonly work_item_id: string;
  readonly github_work_item_id: number;
  readonly github_node_id: string;
  readonly github_number: number;
  readonly resource_kind: "issue" | "pull_request";
  readonly current_revision_key: string;
  readonly opening_event_key: string;
  readonly opening_source: NormalizedSchedulingEvent["source"];
  readonly opening_source_event_id: string;
  readonly opening_occurred_at: string;
  readonly opening_actor_github_user_id: number;
  readonly opening_normalized_json: string;
}

const readActiveEpochPollingSeeds = (
  database: DatabaseSync,
  key: GitHubPollingProjectionKey,
): readonly ActiveEpochPollingSeedRow[] =>
  database
    .prepare(`
      SELECT
        epoch.id AS epoch_id,
        epoch.epoch_json,
        epoch.request_kind,
        epoch.target_github_user_id,
        item.id AS work_item_id,
        item.github_work_item_id,
        item.github_node_id,
        item.github_number,
        item.resource_kind,
        revision.revision_key AS current_revision_key,
        opening.event_key AS opening_event_key,
        opening.source AS opening_source,
        opening.source_event_id AS opening_source_event_id,
        opening.occurred_at AS opening_occurred_at,
        opening.actor_github_user_id AS opening_actor_github_user_id,
        opening.normalized_json AS opening_normalized_json
      FROM request_epochs AS epoch
      JOIN work_items AS item ON item.id = epoch.work_item_id
      JOIN repositories AS repository ON repository.id = item.repository_id
      JOIN github_events AS opening
        ON opening.id = epoch.opening_event_id
        AND opening.work_item_id = item.id
        AND opening.repository_id = item.repository_id
      JOIN work_item_revisions AS revision
        ON revision.id = epoch.current_revision_id AND revision.work_item_id = item.id
      WHERE repository.github_repository_id = ?
        AND epoch.target_github_user_id = ?
        AND epoch.status = 'active'
      ORDER BY epoch.updated_at DESC, epoch.ordinal DESC, epoch.id DESC
    `)
    .all(
      key.githubRepositoryId,
      key.reviewerGithubUserId,
    ) as unknown as ActiveEpochPollingSeedRow[];

const parseActiveEpochPollingSeed = (
  row: ActiveEpochPollingSeedRow,
  key: GitHubPollingProjectionKey,
): { readonly reviewerLogin: string; readonly projection: GitHubPollingWorkItemProjection } => {
  const epoch = JSON.parse(row.epoch_json) as unknown;
  const opening = JSON.parse(row.opening_normalized_json) as unknown;
  if (
    !Value.Check(ActiveAuthorizedRequestEpochSchema, epoch) ||
    !Value.Check(NormalizedSchedulingEventSchema, opening) ||
    opening.action !== "request_opened" ||
    opening.actor === null ||
    opening.target === null ||
    opening.workItem.state !== "open" ||
    epoch.requestEpochId !== row.epoch_id ||
    epoch.githubRepositoryId !== key.githubRepositoryId ||
    epoch.githubWorkItemId !== row.github_work_item_id ||
    epoch.target.githubUserId !== key.reviewerGithubUserId ||
    epoch.target.githubUserId !== row.target_github_user_id ||
    epoch.requestKind !== row.request_kind ||
    epoch.openedByEventId !== row.opening_event_key ||
    epoch.openedByEventId !== opening.eventId ||
    epoch.openedByActor.githubUserId !== opening.actor.githubUserId ||
    opening.actor.githubUserId !== row.opening_actor_github_user_id ||
    Date.parse(epoch.openedAt) !== Date.parse(row.opening_occurred_at) ||
    Date.parse(opening.occurredAt) !== Date.parse(row.opening_occurred_at) ||
    opening.sourceEventId !== row.opening_source_event_id ||
    opening.source !== row.opening_source ||
    opening.requestKind !== epoch.requestKind ||
    opening.target.githubUserId !== epoch.target.githubUserId ||
    opening.repository.githubRepositoryId !== key.githubRepositoryId ||
    opening.workItem.githubRepositoryId !== key.githubRepositoryId ||
    opening.workItem.githubWorkItemId !== row.github_work_item_id ||
    opening.workItem.githubNodeId !== row.github_node_id ||
    opening.workItem.number !== row.github_number ||
    opening.workItem.kind !== row.resource_kind ||
    opening.revision.githubRepositoryId !== key.githubRepositoryId ||
    opening.revision.githubWorkItemId !== row.github_work_item_id ||
    opening.revision.kind !== row.resource_kind ||
    epoch.currentRevision.githubRepositoryId !== key.githubRepositoryId ||
    epoch.currentRevision.githubWorkItemId !== row.github_work_item_id ||
    epoch.currentRevision.kind !== row.resource_kind ||
    epoch.currentRevision.revisionKey !== row.current_revision_key ||
    (epoch.requestKind === "review_request" && row.resource_kind !== "pull_request")
  ) {
    throw new TypeError("A persisted active request cannot seed its GitHub polling projection.");
  }
  return {
    reviewerLogin: epoch.target.login,
    projection: {
      workItem: opening.workItem,
      revision: epoch.currentRevision,
      needsRevisionObservation: true,
      activeRequests: [
        {
          requestKind: epoch.requestKind,
          openedSourceEventId: opening.sourceEventId,
          openedAt: epoch.openedAt,
        },
      ],
    },
  };
};

const hasSamePollingRequestOrigin = (
  database: DatabaseSync,
  seed: ActiveEpochPollingSeedRow,
  sourceEventId: string,
): boolean =>
  sourceEventId === seed.opening_source_event_id ||
  database
    .prepare(`
      SELECT 1
      FROM github_events
      WHERE work_item_id = ? AND source_event_id = ? AND action = 'request_opened'
        AND request_kind = ? AND target_github_user_id = ?
        AND actor_github_user_id = ? AND occurred_at = ? AND source <> ?
      LIMIT 1
    `)
    .get(
      seed.work_item_id,
      sourceEventId,
      seed.request_kind,
      seed.target_github_user_id,
      seed.opening_actor_github_user_id,
      seed.opening_occurred_at,
      seed.opening_source,
    ) !== undefined;

const mergeActiveEpochPollingSeeds = (
  database: DatabaseSync,
  key: GitHubPollingProjectionKey,
  checkpoint: GitHubPollingActiveProjection | null,
): GitHubPollingActiveProjection | null => {
  const workItems = new Map<number, GitHubPollingWorkItemProjection>(
    checkpoint?.workItems.map((item) => [item.workItem.githubWorkItemId, item]),
  );
  let reviewerLogin = checkpoint?.reviewerLogin;
  for (const row of readActiveEpochPollingSeeds(database, key)) {
    const seed = parseActiveEpochPollingSeed(row, key);
    reviewerLogin ??= seed.reviewerLogin;
    const previous = workItems.get(row.github_work_item_id);
    if (previous === undefined) {
      workItems.set(row.github_work_item_id, seed.projection);
      continue;
    }
    const requests = new Map(
      previous.activeRequests.map((request) => [request.requestKind, request]),
    );
    const previousRequest = requests.get(row.request_kind);
    // A completed checkpoint may be ahead of an epoch whose policy forbids revision inheritance.
    // Only a missing or replaced request origin requires another forced observation.
    const needsRevisionObservation =
      previousRequest === undefined ||
      !hasSamePollingRequestOrigin(database, row, previousRequest.openedSourceEventId);
    if (needsRevisionObservation) {
      requests.set(row.request_kind, {
        requestKind: row.request_kind,
        openedSourceEventId: row.opening_source_event_id,
        openedAt: row.opening_occurred_at,
      });
      workItems.set(row.github_work_item_id, {
        ...previous,
        needsRevisionObservation: true,
        activeRequests: [...requests.values()],
      });
    } else if (previousRequest.openedAt !== row.opening_occurred_at) {
      requests.set(row.request_kind, { ...previousRequest, openedAt: row.opening_occurred_at });
      workItems.set(row.github_work_item_id, {
        ...previous,
        activeRequests: [...requests.values()],
      });
    }
  }
  if (reviewerLogin === undefined) return null;
  return {
    version: 1,
    githubRepositoryId: key.githubRepositoryId,
    repositoryFullName: key.repositoryFullName,
    reviewerGithubUserId: key.reviewerGithubUserId,
    reviewerLogin,
    workItems: [...workItems.values()],
  };
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
  const checkpoint =
    row === undefined ? null : (JSON.parse(row.projection_json) as GitHubPollingActiveProjection);
  return { projection: mergeActiveEpochPollingSeeds(database, key, checkpoint) };
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
