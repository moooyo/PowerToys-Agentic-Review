import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ActiveAuthorizedRequestEpoch,
  type AuthorizationDecision,
  AuthorizedRequestEpochSchema,
  JobExecutionTemplateSchema,
  type NormalizedSchedulingEvent,
  NormalizedSchedulingEventSchema,
  type SelfOrAllowlistPolicy,
  SelfOrAllowlistPolicySchema,
} from "@agentic-review/contracts";
import {
  advanceAuthorizedRequestEpochRevision,
  closeAuthorizedRequestEpoch,
  evaluateRevisionInheritance,
  evaluateSchedulingAuthorization,
  openAuthorizedRequestEpoch,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import {
  GitHubIngestionInvariantError,
  NormalizedEventConflictError,
  WebhookDeliveryConflictError,
} from "./errors.js";
import {
  createGitHubReviewRunInTransaction,
  observeGitHubReviewRunSourceInTransaction,
  pinGitHubLegacyJobInTransaction,
} from "./github-review-runs.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import type {
  IngestSchedulingEventInput,
  IngestSchedulingEventResult,
  ScheduleJobInput,
} from "./protocol.js";
import { ordinaryReviewJobSql } from "./review-purpose.js";

interface RepositoryRow {
  readonly id: string;
  readonly github_repository_id: number;
  readonly github_node_id: string;
  readonly full_name: string;
}

interface WorkItemRow {
  readonly id: string;
  readonly repository_id: string;
  readonly resource_kind: "issue" | "pull_request";
  readonly github_work_item_id: number;
  readonly github_node_id: string;
  readonly github_number: number;
  readonly state: "open" | "closed";
  readonly current_revision_key: string;
  readonly source_updated_at: string;
  readonly projection_source: "webhook" | "poll" | "reconciliation";
}

interface RevisionRow {
  readonly id: string;
  readonly revision_key: string;
  readonly resource_kind: "issue" | "pull_request";
  readonly base_sha: string | null;
  readonly head_sha: string | null;
  readonly content_digest: string | null;
  readonly revision_json: string;
}

interface EventRow {
  readonly id: string;
  readonly normalized_sha256: string;
  readonly normalized_json: string;
  readonly result_json: string | null;
}

interface DeliveryRow {
  readonly event_name: string;
  readonly payload_sha256: string;
  readonly result_json: string | null;
}

interface EpochRow {
  readonly id: string;
  readonly ordinal: number;
  readonly epoch_json: string;
  readonly policy_json: string;
  readonly policy_sha256: string;
  readonly opening_source: NormalizedSchedulingEvent["source"];
  readonly opening_source_event_id: string;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
    .join(",")}}`;
};

const normalizeDateTime = (value: string, field: string): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new GitHubIngestionInvariantError(`${field} must be a valid date-time value.`);
  }
  return new Date(timestamp).toISOString();
};

const validateInput = (input: IngestSchedulingEventInput): void => {
  if (!Value.Check(NormalizedSchedulingEventSchema, input.event)) {
    throw new GitHubIngestionInvariantError(
      "event does not match NormalizedSchedulingEventSchema.",
    );
  }
  if (!Value.Check(SelfOrAllowlistPolicySchema, input.policy)) {
    throw new GitHubIngestionInvariantError("policy does not match SelfOrAllowlistPolicySchema.");
  }
  const { event, delivery } = input;
  if (
    event.repository.githubRepositoryId !== event.workItem.githubRepositoryId ||
    event.repository.githubRepositoryId !== event.revision.githubRepositoryId ||
    event.workItem.githubWorkItemId !== event.revision.githubWorkItemId ||
    event.workItem.kind !== event.revision.kind ||
    event.author.githubUserId !== event.workItem.author.githubUserId
  ) {
    throw new GitHubIngestionInvariantError(
      "The normalized event contains inconsistent repository, work item, revision, or author identities.",
    );
  }
  if (event.action === "work_item_closed" && event.workItem.state !== "closed") {
    throw new GitHubIngestionInvariantError("A work_item_closed event must project closed state.");
  }
  if (event.action === "work_item_reopened" && event.workItem.state !== "open") {
    throw new GitHubIngestionInvariantError("A work_item_reopened event must project open state.");
  }
  if (event.source === "webhook") {
    if (delivery === null || delivery.deliveryId !== event.sourceEventId) {
      throw new GitHubIngestionInvariantError(
        "A webhook event requires delivery metadata matching sourceEventId.",
      );
    }
    if (!sha256Pattern.test(delivery.payloadSha256)) {
      throw new GitHubIngestionInvariantError(
        "delivery.payloadSha256 must be a lowercase SHA-256 digest.",
      );
    }
    if (delivery.eventName.trim().length === 0 || delivery.deliveryId.trim().length === 0) {
      throw new GitHubIngestionInvariantError("Webhook delivery identifiers must not be empty.");
    }
    normalizeDateTime(delivery.receivedAt, "delivery.receivedAt");
  } else if (delivery !== null) {
    throw new GitHubIngestionInvariantError(
      "Polling and reconciliation events cannot carry webhook delivery metadata.",
    );
  }
  normalizeDateTime(event.occurredAt, "event.occurredAt");
  normalizeDateTime(event.observedAt, "event.observedAt");
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

const parseStoredResult = (value: string | null): IngestSchedulingEventResult => {
  if (value === null) {
    throw new GitHubIngestionInvariantError(
      "A committed scheduling event is missing its operation result.",
    );
  }
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GitHubIngestionInvariantError("A stored scheduling result is not a JSON object.");
  }
  return parsed as IngestSchedulingEventResult;
};

const sourceEventIdentity = (event: NormalizedSchedulingEvent): unknown => {
  if (
    (event.source === "poll" && event.action === "request_opened") ||
    (event.source === "reconciliation" &&
      (event.action === "request_closed" || event.action === "work_item_closed"))
  ) {
    // A timeline event identifies the request, not the snapshot fetched while observing it.
    // Snapshots are projected independently through revision_observed events.
    return {
      contractVersion: event.contractVersion,
      eventId: event.eventId,
      source: event.source,
      sourceEventId: event.sourceEventId,
      action: event.action,
      requestKind: event.requestKind,
      occurredAt: event.action === "request_closed" ? null : event.occurredAt,
      closeReason: event.action === "request_opened" ? null : event.closeReason,
      revision:
        event.action === "work_item_closed"
          ? { revisionKey: event.revision.revisionKey, identity: immutableRevisionIdentity(event) }
          : null,
      repositoryId: event.repository.githubRepositoryId,
      repositoryNodeId: event.repository.githubNodeId,
      workItemId: event.workItem.githubWorkItemId,
      workItemNodeId: event.workItem.githubNodeId,
      workItemNumber: event.workItem.number,
      workItemKind: event.workItem.kind,
      authorId: event.author.githubUserId,
      actorId: event.actor?.githubUserId ?? null,
      targetId: event.target?.githubUserId ?? null,
    };
  }
  return {
    ...event,
    observedAt: null,
    revision: { ...event.revision, observedAt: null },
  };
};

const matchesStoredSourceEvent = (
  stored: EventRow,
  event: NormalizedSchedulingEvent,
  normalizedSha256: string,
): boolean => {
  if (stored.normalized_sha256 === normalizedSha256) {
    return true;
  }
  const original = JSON.parse(stored.normalized_json) as unknown;
  if (
    hash(stored.normalized_json) !== stored.normalized_sha256 ||
    !Value.Check(NormalizedSchedulingEventSchema, original)
  ) {
    throw new GitHubIngestionInvariantError("The persisted source event is inconsistent.");
  }
  if (
    original.revision.revisionKey === event.revision.revisionKey &&
    canonicalJson(immutableRevisionIdentity(original)) !==
      canonicalJson(immutableRevisionIdentity(event))
  ) {
    return false;
  }
  return canonicalJson(sourceEventIdentity(original)) === canonicalJson(sourceEventIdentity(event));
};

const immutableRevisionIdentity = (event: NormalizedSchedulingEvent): unknown =>
  event.revision.kind === "pull_request"
    ? {
        kind: event.revision.kind,
        baseSha: event.revision.baseSha,
        headSha: event.revision.headSha,
      }
    : { kind: event.revision.kind, contentDigest: event.revision.contentDigest };

const readDuplicate = (
  database: DatabaseSync,
  input: IngestSchedulingEventInput,
  normalizedSha256: string,
): IngestSchedulingEventResult | null => {
  if (input.delivery !== null) {
    const delivery = database
      .prepare(`
        SELECT event_name, payload_sha256, result_json
        FROM webhook_deliveries
        WHERE delivery_id = ?
      `)
      .get(input.delivery.deliveryId) as unknown as DeliveryRow | undefined;
    if (delivery !== undefined) {
      if (
        delivery.event_name !== input.delivery.eventName ||
        delivery.payload_sha256 !== input.delivery.payloadSha256
      ) {
        throw new WebhookDeliveryConflictError();
      }
      const event = database
        .prepare(`
          SELECT id, normalized_sha256, normalized_json, result_json
          FROM github_events
          WHERE webhook_delivery_id = ?
        `)
        .get(input.delivery.deliveryId) as unknown as EventRow | undefined;
      if (event === undefined || !matchesStoredSourceEvent(event, input.event, normalizedSha256)) {
        throw new NormalizedEventConflictError();
      }
      return {
        ...parseStoredResult(event.result_json ?? delivery.result_json),
        outcome: "duplicate",
      };
    }
  }

  const events = database
    .prepare(`
      SELECT id, normalized_sha256, normalized_json, result_json
      FROM github_events
      WHERE event_key = ? OR (source = ? AND source_event_id = ?)
    `)
    .all(
      input.event.eventId,
      input.event.source,
      input.event.sourceEventId,
    ) as unknown as EventRow[];
  if (events.length > 1) {
    throw new NormalizedEventConflictError();
  }
  const event = events[0];
  if (event === undefined) {
    return null;
  }
  if (!matchesStoredSourceEvent(event, input.event, normalizedSha256)) {
    throw new NormalizedEventConflictError();
  }
  return { ...parseStoredResult(event.result_json), outcome: "duplicate" };
};

const projectRepository = (
  database: DatabaseSync,
  input: IngestSchedulingEventInput,
  now: string,
): RepositoryRow => {
  const repository = input.event.repository;
  const candidates = database
    .prepare(`
      SELECT id, github_repository_id, github_node_id, full_name
      FROM repositories
      WHERE github_repository_id = ?
        OR github_node_id = ?
        OR full_name = ? COLLATE NOCASE
    `)
    .all(
      repository.githubRepositoryId,
      repository.githubNodeId,
      repository.fullName,
    ) as unknown as RepositoryRow[];
  if (
    candidates.length > 1 ||
    candidates.some(
      (candidate) =>
        candidate.github_repository_id !== repository.githubRepositoryId ||
        candidate.github_node_id !== repository.githubNodeId,
    )
  ) {
    throw new GitHubIngestionInvariantError(
      "The repository identifiers conflict with an existing repository projection.",
    );
  }

  const snapshotJson = canonicalJson(repository);
  const observedAt = normalizeDateTime(input.event.observedAt, "event.observedAt");
  const existing = candidates[0];
  const managed = database
    .prepare("SELECT id FROM managed_repositories WHERE github_repository_id = ?")
    .get(repository.githubRepositoryId) as { id: string } | undefined;
  const repositoryId = existing?.id ?? managed?.id ?? randomUUID();
  if (managed && managed.id !== repositoryId) {
    throw new GitHubIngestionInvariantError(
      "The managed repository and projection identities disagree.",
    );
  }
  database
    .prepare(`INSERT INTO managed_repositories
    (id, github_repository_id, full_name, enabled, version, connection_status, metadata_json, configuration_source, created_at, updated_at)
    VALUES (?, ?, ?, 0, 1, 'unknown', ?, 'discovered', ?, ?)
    ON CONFLICT(github_repository_id) DO UPDATE SET full_name = excluded.full_name,
      metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
    .run(repositoryId, repository.githubRepositoryId, repository.fullName, snapshotJson, now, now);
  if (existing === undefined) {
    const id = repositoryId;
    database
      .prepare(`
        INSERT INTO repositories (
          id,
          github_repository_id,
          github_node_id,
          owner_login,
          name,
          full_name,
          html_url,
          default_branch,
          is_private,
          snapshot_json,
          observed_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        repository.githubRepositoryId,
        repository.githubNodeId,
        repository.ownerLogin,
        repository.name,
        repository.fullName,
        repository.htmlUrl,
        repository.defaultBranch,
        repository.isPrivate ? 1 : 0,
        snapshotJson,
        observedAt,
        now,
        now,
      );
    return {
      id,
      github_repository_id: repository.githubRepositoryId,
      github_node_id: repository.githubNodeId,
      full_name: repository.fullName,
    };
  }

  const update = database
    .prepare(`
      UPDATE repositories
      SET
        owner_login = ?,
        name = ?,
        full_name = ?,
        html_url = ?,
        default_branch = ?,
        is_private = ?,
        snapshot_json = ?,
        observed_at = ?,
        updated_at = ?
      WHERE id = ? AND observed_at <= ?
    `)
    .run(
      repository.ownerLogin,
      repository.name,
      repository.fullName,
      repository.htmlUrl,
      repository.defaultBranch,
      repository.isPrivate ? 1 : 0,
      snapshotJson,
      observedAt,
      now,
      existing.id,
      observedAt,
    );
  return Number(update.changes) === 1 ? { ...existing, full_name: repository.fullName } : existing;
};

const readWorkItem = (database: DatabaseSync, id: string): WorkItemRow => {
  const row = database
    .prepare(`
      SELECT
        id,
        repository_id,
        resource_kind,
        github_work_item_id,
        github_node_id,
        github_number,
        state,
        current_revision_key,
        source_updated_at,
        projection_source
      FROM work_items
      WHERE id = ?
    `)
    .get(id) as unknown as WorkItemRow | undefined;
  if (row === undefined) {
    throw new GitHubIngestionInvariantError("The projected work item could not be read back.");
  }
  return row;
};

const projectWorkItem = (
  database: DatabaseSync,
  repository: RepositoryRow,
  input: IngestSchedulingEventInput,
  now: string,
): {
  readonly row: WorkItemRow;
  readonly projected: boolean;
  readonly revisionChanged: boolean;
} => {
  const item = input.event.workItem;
  const revision = input.event.revision;
  const candidates = database
    .prepare(`
      SELECT
        id,
        repository_id,
        resource_kind,
        github_work_item_id,
        github_node_id,
        github_number,
        state,
        current_revision_key,
        source_updated_at,
        projection_source
      FROM work_items
      WHERE github_work_item_id = ?
        OR github_node_id = ?
        OR (repository_id = ? AND github_number = ?)
    `)
    .all(
      item.githubWorkItemId,
      item.githubNodeId,
      repository.id,
      item.number,
    ) as unknown as WorkItemRow[];
  if (
    candidates.length > 1 ||
    candidates.some(
      (candidate) =>
        candidate.repository_id !== repository.id ||
        candidate.github_work_item_id !== item.githubWorkItemId ||
        candidate.github_node_id !== item.githubNodeId ||
        candidate.github_number !== item.number ||
        candidate.resource_kind !== item.kind,
    )
  ) {
    throw new GitHubIngestionInvariantError(
      "The work item identifiers conflict with an existing work item projection.",
    );
  }

  const sourceCreatedAt = normalizeDateTime(item.createdAt, "event.workItem.createdAt");
  const sourceUpdatedAt = normalizeDateTime(item.updatedAt, "event.workItem.updatedAt");
  const sourceClosedAt =
    item.closedAt === null ? null : normalizeDateTime(item.closedAt, "event.workItem.closedAt");
  const observedAt = normalizeDateTime(input.event.observedAt, "event.observedAt");
  const authorAccountType = item.author.accountType ?? "user";
  const itemJson = canonicalJson(item);
  const isDraft = item.kind === "pull_request" ? (item.isDraft ? 1 : 0) : null;
  const existing = candidates[0];
  if (existing === undefined) {
    const id = randomUUID();
    database
      .prepare(`
        INSERT INTO work_items (
          id,
          repository_id,
          resource_kind,
          github_work_item_id,
          github_node_id,
          github_number,
          state,
          title,
          body,
          html_url,
          author_github_user_id,
          author_login,
          author_account_type,
          current_revision_key,
          is_draft,
          source_created_at,
          source_updated_at,
          source_closed_at,
          snapshot_json,
          projection_source,
          observed_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        repository.id,
        item.kind,
        item.githubWorkItemId,
        item.githubNodeId,
        item.number,
        item.state,
        item.title,
        item.body,
        item.htmlUrl,
        item.author.githubUserId,
        item.author.login,
        authorAccountType,
        revision.revisionKey,
        isDraft,
        sourceCreatedAt,
        sourceUpdatedAt,
        sourceClosedAt,
        itemJson,
        input.event.source,
        observedAt,
        now,
        now,
      );
    return { row: readWorkItem(database, id), projected: true, revisionChanged: false };
  }

  const shouldProject =
    existing.source_updated_at < sourceUpdatedAt ||
    (existing.source_updated_at === sourceUpdatedAt &&
      (input.event.source !== "webhook" || existing.projection_source === "webhook"));
  if (!shouldProject) {
    return { row: existing, projected: false, revisionChanged: false };
  }

  const revisionChanged = existing.current_revision_key !== revision.revisionKey;
  const update = database
    .prepare(`
      UPDATE work_items
      SET
        state = ?,
        title = ?,
        body = ?,
        html_url = ?,
        author_github_user_id = ?,
        author_login = ?,
        author_account_type = ?,
        current_revision_key = ?,
        is_draft = ?,
        source_created_at = ?,
        source_updated_at = ?,
        source_closed_at = ?,
        snapshot_json = ?,
        projection_source = ?,
        observed_at = ?,
        updated_at = ?
      WHERE id = ?
    `)
    .run(
      item.state,
      item.title,
      item.body,
      item.htmlUrl,
      item.author.githubUserId,
      item.author.login,
      authorAccountType,
      revision.revisionKey,
      isDraft,
      sourceCreatedAt,
      sourceUpdatedAt,
      sourceClosedAt,
      itemJson,
      input.event.source,
      observedAt,
      now,
      existing.id,
    );
  const projected = Number(update.changes) === 1;
  return {
    row: readWorkItem(database, existing.id),
    projected,
    revisionChanged: projected && revisionChanged,
  };
};

const projectRevision = (
  database: DatabaseSync,
  workItem: WorkItemRow,
  input: IngestSchedulingEventInput,
  now: string,
): RevisionRow => {
  const revision = input.event.revision;
  const revisionJson = canonicalJson(revision);
  const existing = database
    .prepare(`
      SELECT
        id,
        revision_key,
        resource_kind,
        base_sha,
        head_sha,
        content_digest,
        revision_json
      FROM work_item_revisions
      WHERE work_item_id = ? AND revision_key = ?
    `)
    .get(workItem.id, revision.revisionKey) as unknown as RevisionRow | undefined;
  if (existing !== undefined) {
    const immutableFieldsMatch =
      existing.resource_kind === revision.kind &&
      (revision.kind === "pull_request"
        ? existing.base_sha === revision.baseSha && existing.head_sha === revision.headSha
        : existing.content_digest === revision.contentDigest);
    if (!immutableFieldsMatch) {
      throw new NormalizedEventConflictError();
    }
    database
      .prepare(`
        UPDATE work_item_revisions
        SET observed_at = MAX(observed_at, ?)
        WHERE id = ?
      `)
      .run(normalizeDateTime(revision.observedAt, "event.revision.observedAt"), existing.id);
    return existing;
  }

  const id = randomUUID();
  database
    .prepare(`
      INSERT INTO work_item_revisions (
        id,
        work_item_id,
        revision_key,
        resource_kind,
        base_sha,
        head_sha,
        content_digest,
        source_updated_at,
        observed_at,
        revision_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      workItem.id,
      revision.revisionKey,
      revision.kind,
      revision.kind === "pull_request" ? revision.baseSha : null,
      revision.kind === "pull_request" ? revision.headSha : null,
      revision.kind === "issue" ? revision.contentDigest : null,
      normalizeDateTime(revision.sourceUpdatedAt, "event.revision.sourceUpdatedAt"),
      normalizeDateTime(revision.observedAt, "event.revision.observedAt"),
      revisionJson,
      now,
    );
  return {
    id,
    revision_key: revision.revisionKey,
    resource_kind: revision.kind,
    base_sha: revision.kind === "pull_request" ? revision.baseSha : null,
    head_sha: revision.kind === "pull_request" ? revision.headSha : null,
    content_digest: revision.kind === "issue" ? revision.contentDigest : null,
    revision_json: revisionJson,
  };
};

const insertEvent = (
  database: DatabaseSync,
  input: IngestSchedulingEventInput,
  repositoryId: string,
  workItemId: string,
  revisionId: string,
  normalizedJson: string,
  normalizedSha256: string,
  now: string,
): string => {
  const event = input.event;
  const id = randomUUID();
  const closeReason = "closeReason" in event ? event.closeReason : null;
  database
    .prepare(`
      INSERT INTO github_events (
        id,
        event_key,
        source,
        source_event_id,
        webhook_delivery_id,
        repository_id,
        work_item_id,
        revision_id,
        action,
        request_kind,
        close_reason,
        actor_github_user_id,
        actor_login,
        target_github_user_id,
        target_login,
        occurred_at,
        observed_at,
        normalized_sha256,
        normalized_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      event.eventId,
      event.source,
      event.sourceEventId,
      input.delivery?.deliveryId ?? null,
      repositoryId,
      workItemId,
      revisionId,
      event.action,
      event.requestKind,
      closeReason,
      event.actor?.githubUserId ?? null,
      event.actor?.login ?? null,
      event.target?.githubUserId ?? null,
      event.target?.login ?? null,
      normalizeDateTime(event.occurredAt, "event.occurredAt"),
      normalizeDateTime(event.observedAt, "event.observedAt"),
      normalizedSha256,
      normalizedJson,
      now,
    );
  return id;
};

const parseEpoch = (serialized: string): ActiveAuthorizedRequestEpoch => {
  const epoch = JSON.parse(serialized) as unknown;
  if (!Value.Check(AuthorizedRequestEpochSchema, epoch) || epoch.status !== "active") {
    throw new GitHubIngestionInvariantError(
      "A persisted active request epoch does not match AuthorizedRequestEpochSchema.",
    );
  }
  return epoch;
};

const parseEpochPolicy = (
  row: EpochRow,
  epoch: ActiveAuthorizedRequestEpoch,
): SelfOrAllowlistPolicy => {
  if (hash(row.policy_json) !== row.policy_sha256) {
    throw new GitHubIngestionInvariantError(
      "The persisted request epoch policy digest does not match its snapshot.",
    );
  }
  const policy = JSON.parse(row.policy_json) as unknown;
  if (
    !Value.Check(SelfOrAllowlistPolicySchema, policy) ||
    policy.policyVersion !== epoch.authorizationPolicyVersion
  ) {
    throw new GitHubIngestionInvariantError(
      "The persisted request epoch policy does not match its opening authorization.",
    );
  }
  return policy;
};

const readActiveEpochs = (database: DatabaseSync, workItemId: string): readonly EpochRow[] =>
  database
    .prepare(`
      SELECT
        epoch.id,
        epoch.ordinal,
        epoch.epoch_json,
        decision.policy_json,
        decision.policy_sha256,
        opening.source AS opening_source,
        opening.source_event_id AS opening_source_event_id
      FROM request_epochs AS epoch
      JOIN authorization_decisions AS decision
        ON decision.id = epoch.authorization_decision_id
      JOIN github_events AS opening ON opening.id = epoch.opening_event_id
      WHERE epoch.work_item_id = ? AND epoch.status = 'active'
      ORDER BY epoch.ordinal DESC, epoch.id DESC
    `)
    .all(workItemId) as unknown as EpochRow[];

const insertDecision = (
  database: DatabaseSync,
  workItemId: string,
  githubEventId: string,
  eventKey: string,
  policy: SelfOrAllowlistPolicy,
  decision: AuthorizationDecision,
  scopeEpochId: string | null,
  now: string,
): string => {
  const id = randomUUID();
  const policyJson = canonicalJson(policy);
  database
    .prepare(`
      INSERT INTO authorization_decisions (
        id,
        decision_key,
        github_event_id,
        work_item_id,
        outcome,
        basis,
        reason,
        policy_kind,
        policy_version,
        actor_github_user_id,
        target_github_user_id,
        inherited_from_epoch_id,
        evaluated_at,
        policy_json,
        policy_sha256,
        decision_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      `${eventKey}:${scopeEpochId ?? "event"}`,
      githubEventId,
      workItemId,
      decision.outcome,
      decision.basis,
      decision.reason,
      decision.policyKind,
      decision.policyVersion,
      decision.actorGithubUserId,
      decision.targetGithubUserId,
      decision.inheritedFromEpochId,
      normalizeDateTime(decision.evaluatedAt, "decision.evaluatedAt"),
      policyJson,
      hash(policyJson),
      canonicalJson(decision),
      now,
    );
  return id;
};

const requestTransitionIsCurrent = (
  database: DatabaseSync,
  workItemId: string,
  input: IngestSchedulingEventInput,
): boolean => {
  const event = input.event;
  if (
    (event.action !== "request_opened" && event.action !== "request_closed") ||
    event.target === null
  ) {
    return true;
  }
  const prior = database
    .prepare(`
      SELECT occurred_at, action
      FROM github_events
      WHERE work_item_id = ?
        AND (
          (request_kind = ? AND target_github_user_id = ?)
          OR action = 'work_item_closed'
        )
      ORDER BY occurred_at DESC,
        CASE WHEN action IN ('request_closed', 'work_item_closed') THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
    `)
    .get(workItemId, event.requestKind, event.target.githubUserId) as unknown as
    | { readonly occurred_at: string; readonly action: NormalizedSchedulingEvent["action"] }
    | undefined;
  if (prior === undefined) return true;
  const occurredAt = normalizeDateTime(event.occurredAt, "event.occurredAt");
  if (
    event.action === "request_opened" &&
    (prior.action === "request_closed" || prior.action === "work_item_closed")
  ) {
    // A previous request cannot restore an authorization closed at the same timestamp.
    return prior.occurred_at < occurredAt;
  }
  return prior.occurred_at <= occurredAt;
};

const requestOriginWasSuppressed = (
  database: DatabaseSync,
  workItemId: string,
  event: NormalizedSchedulingEvent,
): boolean => {
  if (event.action !== "request_opened") return false;
  return (
    database
      .prepare(`
    SELECT id FROM github_events
    WHERE work_item_id = ? AND action = 'request_opened'
      AND request_kind = ? AND target_github_user_id IS ?
      AND (actor_github_user_id IS ? OR actor_github_user_id IS NULL)
      AND occurred_at = ? AND json_extract(result_json, '$.schedulingSuppressed') = 1
    LIMIT 1
  `)
      .get(
        workItemId,
        event.requestKind,
        event.target?.githubUserId ?? null,
        event.actor?.githubUserId ?? null,
        normalizeDateTime(event.occurredAt, "event.occurredAt"),
      ) !== undefined
  );
};

const insertEpoch = (
  database: DatabaseSync,
  workItemId: string,
  revisionId: string,
  githubEventId: string,
  authorizationDecisionId: string,
  epoch: ActiveAuthorizedRequestEpoch,
  now: string,
): void => {
  database
    .prepare(`
      INSERT INTO request_epochs (
        id,
        work_item_id,
        ordinal,
        request_kind,
        target_github_user_id,
        opening_event_id,
        authorization_decision_id,
        current_revision_id,
        status,
        opened_at,
        epoch_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `)
    .run(
      epoch.requestEpochId,
      workItemId,
      epoch.sequence,
      epoch.requestKind,
      epoch.target.githubUserId,
      githubEventId,
      authorizationDecisionId,
      revisionId,
      normalizeDateTime(epoch.openedAt, "epoch.openedAt"),
      canonicalJson(epoch),
      now,
      now,
    );
};

const updateEpochRevision = (
  database: DatabaseSync,
  epoch: ActiveAuthorizedRequestEpoch,
  revisionId: string,
  now: string,
): void => {
  const update = database
    .prepare(`
      UPDATE request_epochs
      SET current_revision_id = ?, epoch_json = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `)
    .run(revisionId, canonicalJson(epoch), now, epoch.requestEpochId);
  if (Number(update.changes) !== 1) {
    throw new GitHubIngestionInvariantError("An active request epoch changed during projection.");
  }
};

const closeEpoch = (
  database: DatabaseSync,
  epochRow: EpochRow,
  input: IngestSchedulingEventInput,
  githubEventId: string,
  now: string,
): boolean => {
  const event = input.event;
  if (event.action !== "request_closed" && event.action !== "work_item_closed") {
    return false;
  }
  const closed = closeAuthorizedRequestEpoch(parseEpoch(epochRow.epoch_json), event);
  if (!closed.changed) {
    return false;
  }
  const update = database
    .prepare(`
      UPDATE request_epochs
      SET
        status = 'closed',
        closing_event_id = ?,
        close_reason = ?,
        closed_at = ?,
        epoch_json = ?,
        updated_at = ?
      WHERE id = ? AND status = 'active' AND opened_at <= ?
    `)
    .run(
      githubEventId,
      closed.epoch.closeReason,
      closed.epoch.closedAt,
      canonicalJson(closed.epoch),
      now,
      epochRow.id,
      normalizeDateTime(event.occurredAt, "event.occurredAt"),
    );
  return Number(update.changes) === 1;
};

const validateSchedule = (schedule: ScheduleJobInput, input: IngestSchedulingEventInput): void => {
  if (
    !Number.isSafeInteger(schedule.priority) ||
    !Number.isSafeInteger(schedule.intentVersion) ||
    schedule.intentVersion <= 0 ||
    !Number.isSafeInteger(schedule.maxAttempts) ||
    schedule.maxAttempts <= 0
  ) {
    throw new GitHubIngestionInvariantError("The job schedule contains invalid numeric policy.");
  }
  if (!Value.Check(JobExecutionTemplateSchema, schedule.executionTemplate)) {
    throw new GitHubIngestionInvariantError(
      "schedule.executionTemplate does not match JobExecutionTemplateSchema.",
    );
  }

  const { event } = input;
  const template = schedule.executionTemplate;
  if (
    template.repository.githubRepositoryId !== event.repository.githubRepositoryId ||
    template.repository.fullName.toLowerCase() !== event.repository.fullName.toLowerCase() ||
    template.resource.kind !== event.workItem.kind ||
    template.resource.githubNodeId !== event.workItem.githubNodeId ||
    template.resource.number !== event.workItem.number ||
    template.resource.author.githubUserId !== event.workItem.author.githubUserId
  ) {
    throw new GitHubIngestionInvariantError(
      "The execution template does not identify the normalized scheduling event.",
    );
  }
  if (
    (event.revision.kind === "pull_request" &&
      (schedule.jobKind !== "pull_request_review" ||
        template.resource.kind !== "pull_request" ||
        template.resource.baseSha !== event.revision.baseSha ||
        template.resource.headSha !== event.revision.headSha)) ||
    (event.revision.kind === "issue" &&
      (schedule.jobKind !== "issue_triage" ||
        template.resource.kind !== "issue" ||
        template.resource.revisionDigest !== event.revision.revisionKey))
  ) {
    throw new GitHubIngestionInvariantError(
      "The execution template revision or job kind does not match the normalized event.",
    );
  }
  if (hash(template.prompt.renderedPrompt) !== template.prompt.promptSha256) {
    throw new GitHubIngestionInvariantError("The rendered prompt digest is inconsistent.");
  }
  if (hash(canonicalJson(template.prompt.outputSchema)) !== template.prompt.outputSchemaSha256) {
    throw new GitHubIngestionInvariantError("The output schema digest is inconsistent.");
  }
};

const linkJobToActiveEpochs = (
  database: DatabaseSync,
  jobId: string,
  workItemId: string,
  now: string,
): void => {
  database
    .prepare(`
      INSERT OR IGNORE INTO job_request_epochs (job_id, request_epoch_id, linked_at)
      SELECT ?, epoch.id, ?
      FROM request_epochs AS epoch
      JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
      JOIN jobs AS job ON job.id = ? AND job.resource_revision = revision.revision_key
      WHERE epoch.work_item_id = ? AND epoch.status = 'active'
        AND ${ordinaryReviewJobSql("job")}
    `)
    .run(jobId, now, jobId, workItemId);
};

const scheduleJob = (
  database: DatabaseSync,
  input: IngestSchedulingEventInput,
  schedule: ScheduleJobInput,
  workItem: WorkItemRow,
  primaryEpoch: ActiveAuthorizedRequestEpoch,
  githubEventId: string,
  now: string,
): { readonly id: string; readonly created: boolean } => {
  const revisionKey = input.event.revision.revisionKey;
  // Configuration changes apply to a later authorized activation, not to another observation
  // of the same active request and revision. Preserve its first usable immutable job snapshot.
  const pinned = database
    .prepare(`
      SELECT job.id
      FROM jobs AS job
      JOIN job_request_epochs AS link ON link.job_id = job.id
      WHERE job.work_item_id = ?
        AND job.job_kind = ?
        AND job.resource_revision = ?
        AND link.request_epoch_id = ?
        AND ${ordinaryReviewJobSql("job")}
        AND job.status NOT IN ('stale', 'cancelled', 'cancel_requested')
      ORDER BY job.created_at, job.rowid
      LIMIT 1
    `)
    .get(workItem.id, schedule.jobKind, revisionKey, primaryEpoch.requestEpochId) as
    | { readonly id: string }
    | undefined;
  if (pinned !== undefined) {
    linkJobToActiveEpochs(database, pinned.id, workItem.id, now);
    return { id: pinned.id, created: false };
  }
  const executionJson = canonicalJson(schedule.executionTemplate);
  const executionDigest = hash(executionJson);
  const requiredCapabilitiesJson = canonicalJson(schedule.requiredCapabilities);
  const requiredCapabilitiesDigest = hash(requiredCapabilitiesJson);
  const existing = database
    .prepare(`
      SELECT DISTINCT job.id
      FROM jobs AS job
      JOIN job_request_epochs AS link ON link.job_id = job.id
      JOIN request_epochs AS epoch ON epoch.id = link.request_epoch_id
      WHERE job.work_item_id = ?
        AND job.job_kind = ?
        AND job.resource_revision = ?
        AND job.intent_version = ?
        AND job.execution_digest = ?
        AND job.execution_json = ?
        AND job.required_capabilities_digest = ?
        AND job.required_capabilities_json = ?
        AND job.max_attempts = ?
        AND job.priority = ?
        AND ${ordinaryReviewJobSql("job")}
        AND job.status NOT IN ('stale', 'cancelled', 'cancel_requested')
        AND epoch.status = 'active'
        AND EXISTS (
          SELECT 1 FROM work_item_revisions AS revision
          WHERE revision.id = epoch.current_revision_id
            AND revision.revision_key = job.resource_revision
        )
      ORDER BY job.created_at DESC, job.id DESC
      LIMIT 1
    `)
    .get(
      workItem.id,
      schedule.jobKind,
      revisionKey,
      schedule.intentVersion,
      executionDigest,
      executionJson,
      requiredCapabilitiesDigest,
      requiredCapabilitiesJson,
      schedule.maxAttempts,
      schedule.priority,
    ) as unknown as { readonly id: string } | undefined;
  if (existing !== undefined) {
    linkJobToActiveEpochs(database, existing.id, workItem.id, now);
    return { id: existing.id, created: false };
  }

  const id = randomUUID();
  const activationRow = database
    .prepare(`
      SELECT COALESCE(MAX(activation), 0) + 1 AS activation
      FROM jobs
      WHERE request_epoch_id = ?
        AND ${ordinaryReviewJobSql("jobs")}
        AND job_kind = ?
        AND resource_revision = ?
        AND intent_version = ?
        AND execution_digest = ?
        AND required_capabilities_digest = ?
        AND max_attempts = ?
        AND priority = ?
    `)
    .get(
      primaryEpoch.requestEpochId,
      schedule.jobKind,
      revisionKey,
      schedule.intentVersion,
      executionDigest,
      requiredCapabilitiesDigest,
      schedule.maxAttempts,
      schedule.priority,
    ) as unknown as { readonly activation: number };
  const semanticKey = [
    "github",
    input.event.repository.githubRepositoryId,
    input.event.workItem.githubWorkItemId,
    schedule.jobKind,
    primaryEpoch.requestEpochId,
    revisionKey,
    schedule.intentVersion,
    executionDigest,
    requiredCapabilitiesDigest,
    schedule.maxAttempts,
    schedule.priority,
    "activation",
    activationRow.activation,
  ].join(":");
  const concurrencyKey = [
    "github",
    input.event.repository.githubRepositoryId,
    input.event.workItem.githubWorkItemId,
  ].join(":");
  database
    .prepare(`
      INSERT INTO jobs (
        id,
        work_item_id,
        job_kind,
        generation,
        intent_version,
        semantic_key,
        concurrency_key,
        status,
        priority,
        execution_json,
        execution_digest,
        required_capabilities_json,
        required_capabilities_digest,
        resource_revision,
        max_attempts,
        next_attempt_at,
        created_at,
        updated_at,
        request_epoch_id,
        source_event_id,
        activation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      workItem.id,
      schedule.jobKind,
      primaryEpoch.sequence,
      schedule.intentVersion,
      semanticKey,
      concurrencyKey,
      schedule.priority,
      executionJson,
      executionDigest,
      requiredCapabilitiesJson,
      requiredCapabilitiesDigest,
      revisionKey,
      schedule.maxAttempts,
      now,
      now,
      now,
      primaryEpoch.requestEpochId,
      githubEventId,
      activationRow.activation,
    );
  createJobAdmissionInTransaction(database, id, now);
  linkJobToActiveEpochs(database, id, workItem.id, now);
  return { id, created: true };
};

const supersedeJobs = (
  database: DatabaseSync,
  workItemId: string,
  currentRevision: string | null,
  reason: "superseded_revision" | "request_withdrawn",
  now: string,
): { readonly stale: number; readonly cancelRequested: number } => {
  const revisionFilter = currentRevision === null ? "" : "AND resource_revision <> ?";
  const authorizationFilter =
    reason === "request_withdrawn"
      ? `AND NOT EXISTS (
          SELECT 1
          FROM job_request_epochs AS link
          JOIN request_epochs AS epoch ON epoch.id = link.request_epoch_id
          JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
          WHERE link.job_id = jobs.id
            AND epoch.status = 'active'
            AND revision.revision_key = jobs.resource_revision
        )`
      : "";
  const message =
    reason === "superseded_revision"
      ? "A newer immutable resource revision superseded this job."
      : "No active request epoch authorizes this job revision.";
  const staleStatement = database.prepare(`
    UPDATE jobs
    SET
      status = 'stale',
      current_step = NULL,
      completed_at = ?,
      failure_code = ?,
      failure_message = ?,
      updated_at = ?
    WHERE work_item_id = ?
      AND ${ordinaryReviewJobSql("jobs")}
      ${revisionFilter}
      ${authorizationFilter}
      AND status IN ('queued', 'retry_waiting')
      AND current_run_attempt_id IS NULL
  `);
  const cancelStatement = database.prepare(`
    UPDATE jobs
    SET
      status = 'cancel_requested',
      cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
      failure_code = ?,
      failure_message = ?,
      updated_at = ?
    WHERE work_item_id = ?
      AND ${ordinaryReviewJobSql("jobs")}
      ${revisionFilter}
      ${authorizationFilter}
      AND status IN ('leased', 'running')
      AND current_run_attempt_id IS NOT NULL
  `);
  const stale =
    currentRevision === null
      ? staleStatement.run(now, reason, message, now, workItemId)
      : staleStatement.run(now, reason, message, now, workItemId, currentRevision);
  const cancelled =
    currentRevision === null
      ? cancelStatement.run(now, reason, message, now, workItemId)
      : cancelStatement.run(now, reason, message, now, workItemId, currentRevision);
  return { stale: Number(stale.changes), cancelRequested: Number(cancelled.changes) };
};

export const ingestSchedulingEventInTransaction = (
  database: DatabaseSync,
  input: IngestSchedulingEventInput,
): IngestSchedulingEventResult => {
  validateInput(input);
  if (input.allowScheduling !== undefined && typeof input.allowScheduling !== "boolean") {
    throw new GitHubIngestionInvariantError("allowScheduling must be a boolean when supplied.");
  }
  const allowScheduling = input.allowScheduling !== false;
  if (!allowScheduling && input.schedule !== null) {
    throw new GitHubIngestionInvariantError(
      "Observation-only ingestion cannot supply a job schedule.",
    );
  }
  if (
    input.allowScheduling === true &&
    (input.event.action === "request_opened" || input.event.action === "revision_observed")
  ) {
    const current = database
      .prepare(`
      SELECT full_name, enabled, authorization_policy_json
      FROM managed_repositories WHERE github_repository_id = ?
    `)
      .get(input.event.repository.githubRepositoryId) as
      | {
          readonly full_name: string;
          readonly enabled: number;
          readonly authorization_policy_json: string | null;
        }
      | undefined;
    if (
      current === undefined ||
      current.enabled !== 1 ||
      current.full_name.toLowerCase() !== input.event.repository.fullName.toLowerCase() ||
      current.authorization_policy_json === null ||
      canonicalJson(JSON.parse(current.authorization_policy_json)) !== canonicalJson(input.policy)
    ) {
      throw new GitHubIngestionInvariantError(
        "Repository scheduling settings changed. Resolve current configuration before retrying.",
      );
    }
  }
  if (input.schedule !== null) {
    if (input.event.action !== "request_opened" && input.event.action !== "revision_observed") {
      throw new GitHubIngestionInvariantError(
        "Only request_opened and revision_observed events may carry a candidate schedule.",
      );
    }
  }
  const normalizedJson = canonicalJson(input.event);
  const normalizedSha256 = hash(normalizedJson);

  const duplicate = readDuplicate(database, input, normalizedSha256);
  if (duplicate !== null) {
    return duplicate;
  }

  const now = new Date().toISOString();
  if (input.delivery !== null) {
    database
      .prepare(`
          INSERT INTO webhook_deliveries (
            delivery_id,
            event_name,
            payload_sha256,
            received_at,
            status
          ) VALUES (?, ?, ?, ?, 'received')
        `)
      .run(
        input.delivery.deliveryId,
        input.delivery.eventName,
        input.delivery.payloadSha256,
        normalizeDateTime(input.delivery.receivedAt, "delivery.receivedAt"),
      );
  }

  const repository = projectRepository(database, input, now);
  const projectedWorkItem = projectWorkItem(database, repository, input, now);
  const workItem = projectedWorkItem.row;
  const revision = projectRevision(database, workItem, input, now);
  observeGitHubReviewRunSourceInTransaction(
    database,
    {
      workItemId: workItem.id,
      currentRevisionKey: workItem.current_revision_key,
      revisionChanged: projectedWorkItem.revisionChanged,
    },
    now,
  );
  const requestIsCurrent = requestTransitionIsCurrent(database, workItem.id, input);
  // A later transport cannot turn a request observed while paused into a new authorization.
  // Ordinary denials remain distinct so a strict-SHA polling observation may still be followed
  // by an authoritative webhook carrying the exact authorized revision.
  const schedulingSuppressed =
    !allowScheduling || requestOriginWasSuppressed(database, workItem.id, input.event);
  const eventId = insertEvent(
    database,
    input,
    repository.id,
    workItem.id,
    revision.id,
    normalizedJson,
    normalizedSha256,
    now,
  );

  const authorizationDecisionIds: string[] = [];
  const closedRequestEpochIds: string[] = [];
  let openedRequestEpochId: string | null = null;
  let schedulingEpoch: ActiveAuthorizedRequestEpoch | null = null;
  const schedulingEpochs: ActiveAuthorizedRequestEpoch[] = [];
  let authorized = false;
  let replacedStaleJobCount = 0;
  let replacedCancelRequestedJobCount = 0;
  // Snapshot precedence must not discard a request that names the exact current
  // immutable revision. Request withdrawal is fenced independently by source time.
  const eventRevisionIsCurrent =
    workItem.current_revision_key === input.event.revision.revisionKey &&
    workItem.state === input.event.workItem.state;

  if (input.event.action === "request_opened") {
    const decision = evaluateSchedulingAuthorization({
      event: input.event,
      policy: input.policy,
      evaluatedAt: now,
    });
    const decisionId = insertDecision(
      database,
      workItem.id,
      eventId,
      input.event.eventId,
      input.policy,
      decision,
      null,
      now,
    );
    authorizationDecisionIds.push(decisionId);

    if (requestIsCurrent) {
      const activeRows = readActiveEpochs(database, workItem.id);
      const matching = activeRows.find((row) => {
        const epoch = parseEpoch(row.epoch_json);
        return (
          epoch.requestKind === input.event.requestKind &&
          input.event.target !== null &&
          epoch.target.githubUserId === input.event.target.githubUserId
        );
      });
      const matchingEpoch = matching === undefined ? undefined : parseEpoch(matching.epoch_json);
      const sameRequestOrigin =
        matching !== undefined &&
        matchingEpoch !== undefined &&
        (matching.opening_source === input.event.source
          ? matching.opening_source_event_id === input.event.sourceEventId
          : Date.parse(matchingEpoch.openedAt) === Date.parse(input.event.occurredAt) &&
            matchingEpoch.openedByActor.githubUserId === input.event.actor?.githubUserId);
      if (matchingEpoch !== undefined && sameRequestOrigin) {
        if (
          !schedulingSuppressed &&
          decision.outcome === "authorized" &&
          eventRevisionIsCurrent &&
          matchingEpoch.currentRevision.revisionKey === input.event.revision.revisionKey
        ) {
          schedulingEpoch = matchingEpoch;
        }
        // A second transport observation cannot expand the original request's revision.
        // The separate revision event evaluates its recorded and current policy scopes.
      } else {
        if (
          matching !== undefined &&
          (input.event.source === "webhook" || input.event.actor !== null)
        ) {
          // A new explicit request replaces the previous request even when its removal
          // delivery was missed, regardless of whether its new actor is authorized.
          // An actor-less search observation does not prove a replacement occurred.
          const replacementId = `github-request-replaced:v1:${hash(
            canonicalJson([matching.id, input.event.eventId]),
          )}`;
          const closed = ingestSchedulingEventInTransaction(database, {
            ...input,
            delivery: null,
            schedule: null,
            event: {
              ...input.event,
              eventId: replacementId,
              source: "reconciliation",
              sourceEventId: replacementId,
              action: "request_closed",
              closeReason:
                input.event.requestKind === "assignment"
                  ? "assignment_removed"
                  : "review_request_removed",
            },
          });
          if (!closed.closedRequestEpochIds.includes(matching.id)) {
            throw new GitHubIngestionInvariantError("The replaced request epoch was not closed.");
          }
          closedRequestEpochIds.push(...closed.closedRequestEpochIds);
          replacedStaleJobCount += closed.staleJobCount;
          replacedCancelRequestedJobCount += closed.cancelRequestedJobCount;
        }
        if (!schedulingSuppressed && decision.outcome === "authorized" && eventRevisionIsCurrent) {
          const ordinalRow = database
            .prepare(`
              SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
              FROM request_epochs
              WHERE work_item_id = ?
            `)
            .get(workItem.id) as unknown as { readonly ordinal: number };
          schedulingEpoch = openAuthorizedRequestEpoch({
            event: input.event,
            decision,
            requestEpochId: randomUUID(),
            sequence: ordinalRow.ordinal,
          });
          insertEpoch(
            database,
            workItem.id,
            revision.id,
            eventId,
            decisionId,
            schedulingEpoch,
            now,
          );
          openedRequestEpochId = schedulingEpoch.requestEpochId;
        }
      }
      authorized = schedulingEpoch !== null;
      if (schedulingEpoch !== null) schedulingEpochs.push(schedulingEpoch);
    }
  } else if (input.event.action === "revision_observed") {
    const activeRows = readActiveEpochs(database, workItem.id);
    if (activeRows.length === 0) {
      const decision = evaluateRevisionInheritance({
        epoch: null,
        event: input.event,
        evaluatedAt: now,
        policy: input.policy,
        epochPolicy: null,
      });
      authorizationDecisionIds.push(
        insertDecision(
          database,
          workItem.id,
          eventId,
          input.event.eventId,
          input.policy,
          decision,
          null,
          now,
        ),
      );
    } else {
      for (const row of activeRows) {
        const epoch = parseEpoch(row.epoch_json);
        const epochPolicy = parseEpochPolicy(row, epoch);
        const effectiveEvent = eventRevisionIsCurrent
          ? input.event
          : { ...input.event, revision: epoch.currentRevision };
        const decision = evaluateRevisionInheritance({
          epoch,
          event: effectiveEvent,
          evaluatedAt: now,
          policy: input.policy,
          epochPolicy,
        });
        authorizationDecisionIds.push(
          insertDecision(
            database,
            workItem.id,
            eventId,
            input.event.eventId,
            input.policy,
            decision,
            epoch.requestEpochId,
            now,
          ),
        );
        if (!schedulingSuppressed && eventRevisionIsCurrent && decision.outcome === "authorized") {
          const advanced = advanceAuthorizedRequestEpochRevision(epoch, input.event, decision);
          updateEpochRevision(database, advanced, revision.id, now);
          schedulingEpoch ??= advanced;
          schedulingEpochs.push(advanced);
          authorized = true;
        }
      }
    }
  } else {
    const decision = evaluateSchedulingAuthorization({
      event: input.event,
      policy: input.policy,
      evaluatedAt: now,
    });
    authorizationDecisionIds.push(
      insertDecision(
        database,
        workItem.id,
        eventId,
        input.event.eventId,
        input.policy,
        decision,
        null,
        now,
      ),
    );

    if (
      (input.event.action === "request_closed" && requestIsCurrent) ||
      (input.event.action === "work_item_closed" && eventRevisionIsCurrent)
    ) {
      for (const row of readActiveEpochs(database, workItem.id)) {
        if (closeEpoch(database, row, input, eventId, now)) {
          closedRequestEpochIds.push(row.id);
        }
      }
    }
    // A reopened item only updates its projection. It never reactivates a closed authorization.
  }

  let staleJobCount = replacedStaleJobCount;
  let cancelRequestedJobCount = replacedCancelRequestedJobCount;
  if (projectedWorkItem.revisionChanged) {
    const superseded = supersedeJobs(
      database,
      workItem.id,
      workItem.current_revision_key,
      "superseded_revision",
      now,
    );
    staleJobCount += superseded.stale;
    cancelRequestedJobCount += superseded.cancelRequested;
  }

  const activeRows = readActiveEpochs(database, workItem.id);
  const activeRequestEpochIds = activeRows.map((row) => row.id);
  if (input.event.action === "request_closed" || input.event.action === "work_item_closed") {
    const withdrawn = supersedeJobs(database, workItem.id, null, "request_withdrawn", now);
    staleJobCount += withdrawn.stale;
    cancelRequestedJobCount += withdrawn.cancelRequested;
  }

  let jobId: string | null = null;
  let jobCreated = false;
  if (authorized && schedulingEpoch !== null) {
    for (const epoch of schedulingEpochs) {
      const automatic = createGitHubReviewRunInTransaction(
        database,
        {
          repositoryId: repository.id,
          workItemId: workItem.id,
          requestEpochId: epoch.requestEpochId,
        },
        now,
      );
      if (automatic?.kind === "legacy") {
        jobId ??= automatic.jobId;
      } else if (automatic?.kind === "review_run") {
        jobId ??=
          automatic.dispatch?.createdJobs[0]?.jobId ??
          automatic.run.requests.flatMap((request) => request.jobs)[0]?.jobId ??
          null;
        jobCreated ||= (automatic.dispatch?.createdJobs.length ?? 0) > 0;
      } else {
        if (input.schedule === null) {
          throw new GitHubIngestionInvariantError(
            "An authorized scheduling decision requires an atomic job schedule.",
          );
        }
        validateSchedule(input.schedule, input);
        const scheduled = scheduleJob(
          database,
          input,
          input.schedule,
          workItem,
          epoch,
          eventId,
          now,
        );
        pinGitHubLegacyJobInTransaction(
          database,
          { workItemId: workItem.id, jobId: scheduled.id },
          now,
        );
        jobId ??= scheduled.id;
        jobCreated ||= scheduled.created;
      }
    }
  }

  const result: IngestSchedulingEventResult = {
    outcome: "processed",
    eventId,
    repositoryId: repository.id,
    workItemId: workItem.id,
    workItemProjected: projectedWorkItem.projected,
    authorizationDecisionIds,
    authorized,
    activeRequestEpochIds,
    openedRequestEpochId,
    closedRequestEpochIds,
    jobId,
    jobCreated,
    staleJobCount,
    cancelRequestedJobCount,
    ...(schedulingSuppressed ? { schedulingSuppressed: true } : {}),
  };
  const resultJson = canonicalJson(result);
  database
    .prepare("UPDATE github_events SET result_json = ? WHERE id = ?")
    .run(resultJson, eventId);
  if (input.delivery !== null) {
    database
      .prepare(`
          UPDATE webhook_deliveries
          SET status = 'processed', processed_at = ?, result_json = ?
          WHERE delivery_id = ? AND status = 'received'
        `)
      .run(now, resultJson, input.delivery.deliveryId);
  }
  return result;
};

export const ingestSchedulingEvent = (
  database: DatabaseSync,
  input: IngestSchedulingEventInput,
): IngestSchedulingEventResult =>
  withImmediateTransaction(database, () => ingestSchedulingEventInTransaction(database, input));
