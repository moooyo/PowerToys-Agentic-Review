import type { DatabaseSync } from "node:sqlite";
import {
  type ActiveAuthorizedRequestEpoch,
  type AuthorizationDecision,
  type DashboardJobListQuery,
  type DashboardJobListResponse,
  DashboardJobListResponseSchema,
  type DashboardJobStage,
  type DashboardSystemRead,
  DashboardSystemReadSchema,
  type DashboardWorkerListQuery,
  type DashboardWorkerListResponse,
  DashboardWorkerListResponseSchema,
  type DashboardWorkItemListItem,
  type DashboardWorkItemListQuery,
  type DashboardWorkItemListResponse,
  DashboardWorkItemListResponseSchema,
  type ExecutionPhase,
  type GitHubActor,
  type GitHubWorkItemRevision,
  type JobState,
  type NormalizedSchedulingEvent,
  type WorkerCapabilities,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { GitHubIngestionInvariantError } from "./errors.js";

interface WorkItemRow {
  readonly id: string;
  readonly kind: DashboardWorkItemListItem["kind"];
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly authorGithubUserId: number;
  readonly authorLogin: string;
  readonly authorAccountType: "user" | "bot" | "app";
  readonly githubUrl: string;
  readonly state: "open" | "closed";
  readonly currentRevisionJson: string;
  readonly activeEpochJson: string | null;
  readonly latestDecisionJson: string | null;
  readonly latestEventJson: string | null;
  readonly latestJobId: string | null;
  readonly latestJobStatus: JobState | null;
  readonly latestJobPhase: ExecutionPhase | null;
  readonly latestJobPriority: number | null;
  readonly latestJobRevision: string | null;
  readonly latestJobFailure: string | null;
  readonly workerNodeId: string | null;
  readonly reviewedRevisionKey: string | null;
  readonly updatedAt: string;
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const withReadTransaction = <T>(database: DatabaseSync, action: () => T): T => {
  database.exec("BEGIN");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const pageNumber = (value: number | undefined): number => value ?? 1;
const pageSize = (value: number | undefined): number => value ?? 20;

const assertPagination = (page: number, size: number): void => {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new GitHubIngestionInvariantError("Dashboard page must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > 200) {
    throw new GitHubIngestionInvariantError(
      "Dashboard pageSize must be a safe integer between 1 and 200.",
    );
  }
};

const searchPattern = (search: string | undefined): string | null => {
  const value = search?.trim().toLowerCase();
  if (value === undefined || value.length === 0) {
    return null;
  }
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
};

const values = <T>(value: T | T[] | undefined): readonly T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const paginate = <T>(items: readonly T[], page: number, size: number): readonly T[] => {
  const offset = (page - 1) * size;
  return items.slice(offset, offset + size);
};

const jobStage = (status: JobState | null, phase: ExecutionPhase | null): DashboardJobStage => {
  if (status === null || status === "queued" || status === "retry_waiting") {
    return "queued";
  }
  if (
    status === "stale" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "dead_letter" ||
    status === "cancelled"
  ) {
    return "done";
  }
  return phase ?? "leased";
};

const workItemStage = (
  status: JobState | null,
  phase: ExecutionPhase | null,
): DashboardWorkItemListItem["stage"] => {
  const stage = jobStage(status, phase);
  if (stage === "done") {
    return "done";
  }
  if (stage === "queued" || stage === "leased" || stage === "preparing") {
    return stage === "queued" ? "queued" : "preparing";
  }
  if (stage === "validation") {
    return "validating";
  }
  if (stage === "uploading" || stage === "completing") {
    return "waiting_approval";
  }
  return "reviewing";
};

const priority = (value: number | null): DashboardWorkItemListItem["priority"] => {
  if (value !== null && value >= 100) return "urgent";
  if (value !== null && value >= 50) return "high";
  if (value !== null && value < 0) return "low";
  return "normal";
};

const mapWorkItem = (row: WorkItemRow): DashboardWorkItemListItem => {
  const author: GitHubActor = {
    githubUserId: row.authorGithubUserId,
    login: row.authorLogin,
    accountType: row.authorAccountType,
  };
  const activeEpoch =
    row.activeEpochJson === null
      ? null
      : parseJson<ActiveAuthorizedRequestEpoch>(row.activeEpochJson);
  const latestDecision =
    row.latestDecisionJson === null
      ? null
      : parseJson<AuthorizationDecision>(row.latestDecisionJson);
  const latestEvent =
    row.latestEventJson === null ? null : parseJson<NormalizedSchedulingEvent>(row.latestEventJson);
  const authorization =
    activeEpoch?.authorizationBasis === "self"
      ? "self"
      : activeEpoch?.authorizationBasis === "allowlist"
        ? "allowlisted"
        : latestDecision?.outcome === "denied"
          ? "denied"
          : null;
  const stage = workItemStage(row.latestJobStatus, row.latestJobPhase);
  const currentRevision = parseJson<GitHubWorkItemRevision>(row.currentRevisionJson);
  const comparedRevision = row.latestJobRevision ?? row.reviewedRevisionKey;
  const freshness =
    comparedRevision !== null && comparedRevision !== currentRevision.revisionKey
      ? "superseded"
      : "current";
  const state: DashboardWorkItemListItem["state"] =
    row.state === "closed"
      ? "closed"
      : row.latestJobStatus === "leased" ||
          row.latestJobStatus === "running" ||
          row.latestJobStatus === "cancel_requested"
        ? "active"
        : activeEpoch !== null
          ? "assigned"
          : latestEvent?.action === "request_closed"
            ? "unassigned"
            : "open";

  return {
    id: row.id,
    kind: row.kind,
    repository: row.repository,
    number: row.number,
    title: row.title,
    author,
    githubUrl: row.githubUrl,
    trigger: activeEpoch?.requestKind ?? null,
    schedulingActor: activeEpoch?.openedByActor ?? latestEvent?.actor ?? null,
    schedulingTarget: activeEpoch?.target ?? latestEvent?.target ?? null,
    authorization,
    authorizationReason:
      activeEpoch?.authorizationBasis === "self"
        ? "authorized_self"
        : activeEpoch?.authorizationBasis === "allowlist"
          ? "authorized_allowlisted"
          : (latestDecision?.reason ?? null),
    priority: priority(row.latestJobPriority),
    state,
    stage,
    freshness,
    currentRevision,
    reviewedRevisionKey: row.reviewedRevisionKey,
    activeRequestEpoch:
      activeEpoch === null
        ? null
        : {
            requestEpochId: activeEpoch.requestEpochId,
            requestKind: activeEpoch.requestKind,
            sequence: activeEpoch.sequence,
            status: activeEpoch.status,
            authorization: activeEpoch.authorizationBasis === "allowlist" ? "allowlisted" : "self",
            openedAt: activeEpoch.openedAt,
            closedAt: activeEpoch.closedAt,
          },
    latestJobId: row.latestJobId,
    latestJobStatus: row.latestJobStatus,
    workerNodeId: row.workerNodeId,
    attentionReason:
      row.latestJobFailure ??
      (freshness === "superseded" ? "A newer revision is available." : null),
    updatedAt: row.updatedAt,
  };
};

const workItemSql = `
  SELECT
    item.id,
    item.resource_kind AS kind,
    repository.full_name AS repository,
    item.github_number AS number,
    item.title,
    item.author_github_user_id AS "authorGithubUserId",
    item.author_login AS "authorLogin",
    item.author_account_type AS "authorAccountType",
    item.html_url AS "githubUrl",
    item.state,
    current_revision.revision_json AS "currentRevisionJson",
    (
      SELECT epoch.epoch_json FROM request_epochs AS epoch
      WHERE epoch.work_item_id = item.id AND epoch.status = 'active'
      ORDER BY epoch.ordinal DESC, epoch.id DESC LIMIT 1
    ) AS "activeEpochJson",
    (
      SELECT decision.decision_json FROM authorization_decisions AS decision
      WHERE decision.work_item_id = item.id
      ORDER BY decision.evaluated_at DESC, decision.created_at DESC, decision.id DESC LIMIT 1
    ) AS "latestDecisionJson",
    (
      SELECT event.normalized_json FROM github_events AS event
      WHERE event.work_item_id = item.id
      ORDER BY event.occurred_at DESC, event.created_at DESC, event.id DESC LIMIT 1
    ) AS "latestEventJson",
    latest_job.id AS "latestJobId",
    latest_job.status AS "latestJobStatus",
    latest_job.current_step AS "latestJobPhase",
    latest_job.priority AS "latestJobPriority",
    latest_job.resource_revision AS "latestJobRevision",
    latest_job.failure_message AS "latestJobFailure",
    latest_attempt.worker_node_id AS "workerNodeId",
    (
      SELECT job.resource_revision FROM jobs AS job
      WHERE job.work_item_id = item.id AND job.status = 'succeeded'
      ORDER BY job.completed_at DESC, job.id DESC LIMIT 1
    ) AS "reviewedRevisionKey",
    item.updated_at AS "updatedAt"
  FROM work_items AS item
  JOIN repositories AS repository ON repository.id = item.repository_id
  JOIN work_item_revisions AS current_revision
    ON current_revision.work_item_id = item.id
    AND current_revision.revision_key = item.current_revision_key
  LEFT JOIN jobs AS latest_job
    ON latest_job.id = (
      SELECT candidate.id
      FROM jobs AS candidate
      WHERE candidate.work_item_id = item.id
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    )
  LEFT JOIN run_attempts AS latest_attempt
    ON latest_attempt.id = latest_job.current_run_attempt_id
  WHERE (
    ? IS NULL OR lower(
      repository.full_name || ' ' || item.github_number || ' ' || item.title || ' ' ||
      item.author_login
    ) LIKE ? ESCAPE '\\'
  )
  ORDER BY item.updated_at DESC, item.id
`;

export const listWorkItems = (
  database: DatabaseSync,
  input: DashboardWorkItemListQuery,
): DashboardWorkItemListResponse => {
  const page = pageNumber(input.page);
  const size = pageSize(input.pageSize);
  assertPagination(page, size);
  const kinds = values(input.kind);
  const states = values(input.state);
  const stages = values(input.stage);
  const authorizations = values(input.authorization);

  return withReadTransaction(database, () => {
    const search = searchPattern(input.search);
    const rows = database.prepare(workItemSql).all(search, search) as unknown as WorkItemRow[];
    const filtered = rows
      .map(mapWorkItem)
      .filter(
        (item) =>
          (kinds.length === 0 || kinds.includes(item.kind)) &&
          (states.length === 0 || states.includes(item.state)) &&
          (stages.length === 0 || stages.includes(item.stage)) &&
          (authorizations.length === 0 ||
            (item.authorization !== null && authorizations.includes(item.authorization))),
      );
    const result = { items: [...paginate(filtered, page, size)], total: filtered.length };
    if (!Value.Check(DashboardWorkItemListResponseSchema, result)) {
      throw new GitHubIngestionInvariantError(
        "The database work item projection does not match DashboardWorkItemListResponseSchema.",
      );
    }
    return result;
  });
};

interface JobRow {
  readonly id: string;
  readonly workItemId: string;
  readonly workItemRef: string;
  readonly title: string;
  readonly generation: number;
  readonly status: JobState;
  readonly phase: ExecutionPhase | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly workerNodeId: string | null;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: string | null;
  readonly progressUpdatedAt: string | null;
  readonly targetRevisionKey: string;
  readonly failureCode: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const jobSql = `
  SELECT
    job.id,
    job.work_item_id AS "workItemId",
    repository.full_name || '#' || item.github_number AS "workItemRef",
    CASE job.job_kind
      WHEN 'issue_triage' THEN 'Issue triage'
      WHEN 'pull_request_review' THEN 'PR review'
    END AS title,
    job.generation,
    job.status,
    job.current_step AS phase,
    job.attempt_count AS attempt,
    job.max_attempts AS "maxAttempts",
    attempt.worker_node_id AS "workerNodeId",
    job.lease_generation AS "leaseGeneration",
    attempt.lease_expires_at AS "leaseExpiresAt",
    attempt.last_heartbeat_at AS "progressUpdatedAt",
    job.resource_revision AS "targetRevisionKey",
    job.failure_code AS "failureCode",
    job.started_at AS "startedAt",
    job.completed_at AS "completedAt",
    job.created_at AS "createdAt",
    job.updated_at AS "updatedAt"
  FROM jobs AS job
  JOIN work_items AS item ON item.id = job.work_item_id
  JOIN repositories AS repository ON repository.id = item.repository_id
  LEFT JOIN run_attempts AS attempt ON attempt.id = job.current_run_attempt_id
  WHERE (? IS NULL OR job.work_item_id = ?)
    AND (
      ? IS NULL OR lower(
        job.id || ' ' || repository.full_name || ' ' || item.github_number || ' ' ||
        item.title || ' ' || COALESCE(attempt.worker_node_id, '')
      ) LIKE ? ESCAPE '\\'
    )
  ORDER BY job.created_at DESC, job.id
`;

const elapsedSeconds = (row: JobRow, now: number): number => {
  const start = Date.parse(row.startedAt ?? row.createdAt);
  const end = row.completedAt === null ? now : Date.parse(row.completedAt);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / 1_000))
    : 0;
};

const jobOutcome = (row: JobRow): DashboardJobListResponse["items"][number]["outcome"] => {
  if (row.status === "succeeded") return "success";
  if (row.status === "cancelled" || row.status === "stale") return "cancelled";
  if (row.status === "failed" || row.status === "dead_letter") {
    return row.failureCode?.includes("timeout") === true ||
      row.failureCode === "execution_deadline_exceeded"
      ? "timed_out"
      : "failed";
  }
  return null;
};

export const listJobs = (
  database: DatabaseSync,
  input: DashboardJobListQuery,
): DashboardJobListResponse => {
  const page = pageNumber(input.page);
  const size = pageSize(input.pageSize);
  assertPagination(page, size);
  const statuses = values(input.status);
  const phases = values(input.phase);
  const stages = values(input.stage);

  return withReadTransaction(database, () => {
    const search = searchPattern(input.search);
    const rows = database
      .prepare(jobSql)
      .all(
        input.workItemId ?? null,
        input.workItemId ?? null,
        search,
        search,
      ) as unknown as JobRow[];
    const now = Date.now();
    const projected = rows
      .filter((row) => {
        const stage = jobStage(row.status, row.phase);
        return (
          (statuses.length === 0 || statuses.includes(row.status)) &&
          (phases.length === 0 || (row.phase !== null && phases.includes(row.phase))) &&
          (stages.length === 0 || stages.includes(stage))
        );
      })
      .map((row) => ({
        id: row.id,
        workItemId: row.workItemId,
        workItemRef: row.workItemRef,
        title: row.title,
        generation: row.generation,
        status: row.status,
        phase: row.phase,
        attempt: row.attempt,
        maxAttempts: row.maxAttempts,
        workerNodeId: row.workerNodeId,
        leaseGeneration: row.leaseGeneration > 0 ? row.leaseGeneration : null,
        leaseExpiresAt: row.leaseExpiresAt,
        progressUpdatedAt: row.progressUpdatedAt,
        elapsedSeconds: elapsedSeconds(row, now),
        targetRevisionKey: row.targetRevisionKey,
        outcome: jobOutcome(row),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    const result = { items: [...paginate(projected, page, size)], total: projected.length };
    if (!Value.Check(DashboardJobListResponseSchema, result)) {
      throw new GitHubIngestionInvariantError(
        "The database job projection does not match DashboardJobListResponseSchema.",
      );
    }
    return result;
  });
};

interface WorkerRow {
  readonly id: string;
  readonly workerNodeId: string;
  readonly instanceId: string;
  readonly displayName: string;
  readonly status: DashboardWorkerListResponse["items"][number]["status"];
  readonly version: string;
  readonly maxSlots: number;
  readonly capabilitiesJson: string;
  readonly healthJson: string | null;
  readonly currentJobIdsJson: string;
  readonly lastHeartbeatAt: string;
}

const workerSql = `
  SELECT
    worker.id,
    worker.node_id AS "workerNodeId",
    worker.instance_id AS "instanceId",
    worker.display_name AS "displayName",
    worker.status,
    worker.version,
    worker.max_slots AS "maxSlots",
    worker.capabilities_json AS "capabilitiesJson",
    worker.health_json AS "healthJson",
    COALESCE((
      SELECT json_group_array(attempt.job_id)
      FROM run_attempts AS attempt
      WHERE attempt.worker_id = worker.id
        AND attempt.worker_instance_id = worker.instance_id
        AND attempt.status IN ('leased', 'running')
    ), '[]') AS "currentJobIdsJson",
    worker.last_seen_at AS "lastHeartbeatAt"
  FROM workers AS worker
  WHERE worker.superseded_at IS NULL
    AND (
    ? IS NULL OR lower(
      worker.node_id || ' ' || worker.instance_id || ' ' || worker.display_name || ' ' ||
      worker.version
    ) LIKE ? ESCAPE '\\'
  )
  ORDER BY worker.last_seen_at DESC, worker.id
`;

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const nonNegativeInteger = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export const listWorkers = (
  database: DatabaseSync,
  input: DashboardWorkerListQuery,
): DashboardWorkerListResponse => {
  const page = pageNumber(input.page);
  const size = pageSize(input.pageSize);
  assertPagination(page, size);
  const statuses = values(input.status);

  return withReadTransaction(database, () => {
    const search = searchPattern(input.search);
    const rows = database.prepare(workerSql).all(search, search) as unknown as WorkerRow[];
    const projected = rows
      .filter((row) => statuses.length === 0 || statuses.includes(row.status))
      .map((row) => {
        const capabilities = parseJson<WorkerCapabilities>(row.capabilitiesJson);
        const health =
          row.healthJson === null ? null : parseJson<Record<string, unknown>>(row.healthJson);
        const currentJobIds = parseJson<string[]>(row.currentJobIdsJson);
        const labels = capabilities.labels ?? {};
        const location = stringValue(labels.location) ?? stringValue(health?.location);
        const capabilityNames = [...new Set(capabilities.recipeIds)].sort();
        return {
          id: row.id,
          workerNodeId: row.workerNodeId,
          instanceId: row.instanceId,
          displayName: row.displayName,
          status: row.status,
          version: row.version,
          location,
          activeSlots: currentJobIds.length,
          maxSlots: row.maxSlots,
          capabilities: capabilityNames,
          currentJobIds,
          lastHeartbeatAt: row.lastHeartbeatAt,
          diskFreeBytes: nonNegativeInteger(health?.freeDiskBytes),
        };
      });
    const result = { items: [...paginate(projected, page, size)], total: projected.length };
    if (!Value.Check(DashboardWorkerListResponseSchema, result)) {
      throw new GitHubIngestionInvariantError(
        "The database worker projection does not match DashboardWorkerListResponseSchema.",
      );
    }
    return result;
  });
};

interface SystemRow {
  readonly sqliteVersion: string;
  readonly databaseSizeBytes: number;
  readonly oldestQueuedAt: string | null;
  readonly activeWorkers: number;
  readonly activeLeases: number;
  readonly lastGitHubIngestionAt: string | null;
  readonly stalePollingProjectionCount: number;
}

export const getSystemSnapshot = (
  database: DatabaseSync,
  _schemaVersion: number,
): DashboardSystemRead =>
  withReadTransaction(database, () => {
    const row = database
      .prepare(`
        SELECT
          sqlite_version() AS "sqliteVersion",
          (
            SELECT page_count * page_size
            FROM pragma_page_count(), pragma_page_size()
          ) AS "databaseSizeBytes",
          (
            SELECT MIN(created_at) FROM jobs
            WHERE status IN ('queued', 'retry_waiting')
          ) AS "oldestQueuedAt",
          (
            SELECT COUNT(*) FROM workers
            WHERE status IN ('online', 'draining') AND superseded_at IS NULL
          ) AS "activeWorkers",
          (
            SELECT COUNT(*) FROM run_attempts
            WHERE status IN ('leased', 'running')
          ) AS "activeLeases",
          (
            SELECT MAX(observed_at)
            FROM (
              SELECT observed_at FROM github_events
              UNION ALL
              SELECT updated_at AS observed_at FROM github_polling_projections
            )
          ) AS "lastGitHubIngestionAt",
          (
            SELECT COUNT(*)
            FROM github_polling_projections
            WHERE updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')
          ) AS "stalePollingProjectionCount"
      `)
      .get() as unknown as SystemRow;
    const checkedAt = new Date().toISOString();
    const lastGitHubIngestionAgeMs =
      row.lastGitHubIngestionAt === null
        ? Number.POSITIVE_INFINITY
        : Date.now() - Date.parse(row.lastGitHubIngestionAt);
    const githubHealthy =
      lastGitHubIngestionAgeMs <= 10 * 60 * 1_000 && row.stalePollingProjectionCount === 0;
    const workerPoolHealthy = row.activeWorkers > 0;
    const result: DashboardSystemRead = {
      serverVersion: "0.1.0",
      protocolVersion: "1.0",
      nodeVersion: process.versions.node,
      sqliteVersion: row.sqliteVersion,
      databaseSizeBytes: row.databaseSizeBytes,
      artifactSizeBytes: 0,
      oldestQueuedAt: row.oldestQueuedAt,
      activeWorkers: row.activeWorkers,
      activeLeases: row.activeLeases,
      pendingApprovals: 0,
      health: [
        {
          id: "database",
          name: "SQLite state store",
          status: "healthy",
          summary: "The database worker is responding and the current snapshot is consistent.",
          checkedAt,
        },
        {
          id: "github",
          name: "GitHub ingestion",
          status: githubHealthy ? "healthy" : "degraded",
          summary: githubHealthy
            ? "GitHub ingestion completed within the last ten minutes."
            : row.lastGitHubIngestionAt === null
              ? "No GitHub scheduling event or polling checkpoint has been processed yet."
              : "One or more GitHub ingestion checkpoints are stale.",
          checkedAt,
        },
        {
          id: "worker-pool",
          name: "Windows worker pool",
          status: workerPoolHealthy ? "healthy" : "degraded",
          summary: workerPoolHealthy
            ? `${row.activeWorkers} worker instance(s) are active.`
            : "No worker instance is currently active.",
          checkedAt,
        },
      ],
    };
    if (!Value.Check(DashboardSystemReadSchema, result)) {
      throw new GitHubIngestionInvariantError(
        "The database system projection does not match DashboardSystemReadSchema.",
      );
    }
    return result;
  });
