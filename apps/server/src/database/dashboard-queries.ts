import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type ActiveAuthorizedRequestEpoch,
  type AuthorizationDecision,
  type DashboardHealthComponent,
  type DashboardJobDetailRead,
  DashboardJobDetailReadSchema,
  type DashboardJobListQuery,
  type DashboardJobListResponse,
  DashboardJobListResponseSchema,
  type DashboardJobReadQuery,
  DashboardJobReadQuerySchema,
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
  getDashboardWorkItemAdmissionIssues,
  getJobAdmissionIssues,
  type JobState,
  type NormalizedSchedulingEvent,
  ReviewExecutionEvidenceSchema,
  RunFailureDiagnosticsSchema,
  VerificationReportSchema,
  type WorkerCapabilities,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { GitHubIngestionInvariantError } from "./errors.js";
import { assertWaitingAdmissionIntegrity, readJobAdmission } from "./job-admission.js";
import { type OperatorReadContext, repositoryReadSql } from "./operator-access.js";
import { ordinaryReviewJobSql } from "./review-purpose.js";

const workerTokenShapePattern = /arw1_[A-Za-z0-9_-]{43}/u;
const redactedWorkerDisplayName = "Redacted worker";

interface WorkItemRow {
  readonly id: string;
  readonly kind: DashboardWorkItemListItem["kind"];
  readonly repositoryId: string;
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
  readonly latestJobAttemptCount: number | null;
  readonly latestJobAdmissionState: string | null;
  readonly latestJobPhase: ExecutionPhase | null;
  readonly latestJobPriority: number | null;
  readonly latestJobRevision: string | null;
  readonly latestJobFailure: string | null;
  readonly workerNodeId: string | null;
  readonly reviewedRevisionKey: string | null;
  readonly updatedAt: string;
  readonly dashboardAuthorization: DashboardWorkItemListItem["authorization"];
  readonly dashboardState: DashboardWorkItemListItem["state"];
  readonly dashboardStage: DashboardWorkItemListItem["stage"];
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

interface SqlFilters {
  readonly clauses: string[];
  readonly parameters: SQLInputValue[];
}

const addEnumFilter = (filters: SqlFilters, column: string, selected: readonly string[]): void => {
  if (selected.length === 0) return;
  filters.clauses.push(`${column} IN (${selected.map(() => "?").join(", ")})`);
  filters.parameters.push(...selected);
};

const whereSql = (filters: SqlFilters): string =>
  filters.clauses.length === 0 ? "" : `WHERE ${filters.clauses.join(" AND ")}`;

// These expressions are shared by filtering and projection so terminal and queued
// states take precedence over any phase left on the last attempt.
const jobStageSql = (status: string, phase: string, admission: string): string => `CASE
  WHEN ${status} IS NULL THEN 'not_scheduled'
  WHEN ${status} IN ('queued', 'retry_waiting') AND ${admission} = 'pending' THEN 'awaiting_admission'
  WHEN ${status} IN ('queued', 'retry_waiting') AND ${admission} = 'admitted' THEN 'queued'
  WHEN ${status} IN ('stale', 'succeeded', 'failed', 'dead_letter', 'cancelled') THEN 'done'
  ELSE COALESCE(${phase}, 'leased')
END`;

const workItemStageSql = `CASE ${jobStageSql('"latestJobStatus"', '"latestJobPhase"', '"latestJobAdmissionState"')}
  WHEN 'not_scheduled' THEN 'not_scheduled'
  WHEN 'awaiting_admission' THEN 'awaiting_admission'
  WHEN 'done' THEN 'done'
  WHEN 'queued' THEN 'queued'
  WHEN 'leased' THEN 'preparing'
  WHEN 'preparing' THEN 'preparing'
  WHEN 'validation' THEN 'validating'
  WHEN 'uploading' THEN 'waiting_approval'
  WHEN 'completing' THEN 'waiting_approval'
  ELSE 'reviewing'
END`;

const priority = (value: number | null): DashboardWorkItemListItem["priority"] => {
  if (value !== null && value >= 100) return "urgent";
  if (value !== null && value >= 50) return "high";
  if (value !== null && value < 0) return "low";
  return "normal";
};

const mapWorkItem = (database: DatabaseSync, row: WorkItemRow): DashboardWorkItemListItem => {
  const latestJobAdmission = (() => {
    if (row.latestJobId === null) return null;
    if (row.latestJobStatus === null || row.latestJobAttemptCount === null)
      throw new GitHubIngestionInvariantError("The latest work item Job identity is incomplete.");
    return readJobAdmission(database, {
      jobId: row.latestJobId,
      status: row.latestJobStatus,
      attemptCount: row.latestJobAttemptCount,
    });
  })();
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
  const currentRevision = parseJson<GitHubWorkItemRevision>(row.currentRevisionJson);
  const comparedRevision = row.latestJobRevision ?? row.reviewedRevisionKey;
  const freshness =
    comparedRevision !== null && comparedRevision !== currentRevision.revisionKey
      ? "superseded"
      : "current";
  return {
    id: row.id,
    kind: row.kind,
    repositoryId: row.repositoryId,
    repository: row.repository,
    number: row.number,
    title: row.title,
    author,
    githubUrl: row.githubUrl,
    trigger: activeEpoch?.requestKind ?? null,
    schedulingActor: activeEpoch?.openedByActor ?? latestEvent?.actor ?? null,
    schedulingTarget: activeEpoch?.target ?? latestEvent?.target ?? null,
    authorization: row.dashboardAuthorization,
    authorizationReason:
      activeEpoch?.authorizationBasis === "self"
        ? "authorized_self"
        : activeEpoch?.authorizationBasis === "allowlist"
          ? "authorized_allowlisted"
          : (latestDecision?.reason ?? null),
    priority: priority(row.latestJobPriority),
    state: row.dashboardState,
    stage: row.dashboardStage,
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
    latestJobAttemptCount: row.latestJobAttemptCount,
    latestJobAdmission,
    workerNodeId: row.workerNodeId,
    attentionReason:
      row.latestJobFailure ??
      (freshness === "superseded" ? "A newer revision is available." : null),
    updatedAt: row.updatedAt,
  };
};

const workItemContextSql = `
  SELECT
    item.id,
    item.resource_kind AS kind,
    repository.id AS "repositoryId",
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
    latest_job.attempt_count AS "latestJobAttemptCount",
    latest_admission.state AS "latestJobAdmissionState",
    latest_job.current_step AS "latestJobPhase",
    latest_job.priority AS "latestJobPriority",
    latest_job.resource_revision AS "latestJobRevision",
    latest_job.failure_message AS "latestJobFailure",
    latest_attempt.worker_node_id AS "workerNodeId",
    (
      SELECT job.resource_revision FROM jobs AS job
      WHERE job.work_item_id = item.id AND job.status = 'succeeded'
        AND ${ordinaryReviewJobSql("job")}
        AND NOT EXISTS (
          SELECT 1 FROM review_run_job_links AS link
          JOIN review_runs AS run ON run.id = link.review_run_id
          WHERE link.job_id = job.id AND run.purpose = 'evaluation'
        )
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
        AND ${ordinaryReviewJobSql("candidate")}
        AND NOT EXISTS (
          SELECT 1 FROM review_run_job_links AS link
          JOIN review_runs AS run ON run.id = link.review_run_id
          WHERE link.job_id = candidate.id AND run.purpose = 'evaluation'
        )
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    )
  LEFT JOIN run_attempts AS latest_attempt
    ON latest_attempt.id = latest_job.current_run_attempt_id
  LEFT JOIN job_admission AS latest_admission ON latest_admission.job_id = latest_job.id
`;

const workItemProjectionSql = `
  WITH work_item_context AS (${workItemContextSql}),
  work_item_projection AS (
    SELECT *,
      CASE
        WHEN json_extract("activeEpochJson", '$.authorizationBasis') = 'self' THEN 'self'
        WHEN json_extract("activeEpochJson", '$.authorizationBasis') = 'allowlist' THEN 'allowlisted'
        WHEN json_extract("latestDecisionJson", '$.outcome') = 'denied' THEN 'denied'
        ELSE NULL
      END AS "dashboardAuthorization",
      CASE
        WHEN state = 'closed' THEN 'closed'
        WHEN "latestJobStatus" IN ('leased', 'running', 'cancel_requested') THEN 'active'
        WHEN "activeEpochJson" IS NOT NULL THEN 'assigned'
        WHEN json_extract("latestEventJson", '$.action') = 'request_closed' THEN 'unassigned'
        ELSE 'open'
      END AS "dashboardState",
      ${workItemStageSql} AS "dashboardStage"
    FROM work_item_context
  )
`;

export const listWorkItems = (
  database: DatabaseSync,
  input: DashboardWorkItemListQuery,
  context?: OperatorReadContext,
): DashboardWorkItemListResponse => {
  const page = pageNumber(input.page);
  const size = pageSize(input.pageSize);
  assertPagination(page, size);
  const filters: SqlFilters = { clauses: [], parameters: [] };
  if (context !== undefined) {
    const visibility = repositoryReadSql(
      "work_item_projection.repositoryId",
      context.actor,
      context.administrators,
    );
    filters.clauses.push(`(${visibility.sql})`);
    filters.parameters.push(...visibility.parameters);
  }
  if (input.repositoryId !== undefined) {
    filters.clauses.push('"repositoryId" = ?');
    filters.parameters.push(input.repositoryId);
  }
  addEnumFilter(filters, "kind", values(input.kind));
  addEnumFilter(filters, '"dashboardState"', values(input.state));
  addEnumFilter(filters, '"dashboardStage"', values(input.stage));
  addEnumFilter(filters, '"dashboardAuthorization"', values(input.authorization));
  const search = searchPattern(input.search);
  if (search !== null) {
    filters.clauses.push(`lower(
      repository || ' ' || number || ' ' || title || ' ' || "authorLogin"
    ) LIKE ? ESCAPE '\\'`);
    filters.parameters.push(search);
  }
  const filteredSql = `FROM work_item_projection ${whereSql(filters)}`;

  return withReadTransaction(database, () => {
    // Check the authorized scope before stage filters can hide missing waiting episodes.
    assertWaitingAdmissionIntegrity(database, {
      ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
      ...(context === undefined ? {} : { context }),
    });
    const count = database
      .prepare(`${workItemProjectionSql} SELECT COUNT(*) AS total ${filteredSql}`)
      .get(...filters.parameters) as { readonly total: number };
    const rows =
      page > Math.ceil(count.total / size)
        ? []
        : (database
            .prepare(`${workItemProjectionSql}
              SELECT * ${filteredSql}
              ORDER BY "updatedAt" DESC, id LIMIT ? OFFSET ?
            `)
            .all(...filters.parameters, size, (page - 1) * size) as unknown as WorkItemRow[]);
    const result = { items: rows.map((row) => mapWorkItem(database, row)), total: count.total };
    if (
      !Value.Check(DashboardWorkItemListResponseSchema, result) ||
      result.items.some((item) => getDashboardWorkItemAdmissionIssues(item).length > 0)
    ) {
      throw new GitHubIngestionInvariantError(
        "The database work item projection does not match DashboardWorkItemListResponseSchema.",
      );
    }
    return result;
  });
};

interface JobRow {
  readonly id: string;
  readonly repositoryId: string;
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

interface JobDetailsRow extends JobRow {
  readonly resultDigest: string | null;
  readonly failureMessage: string | null;
  readonly failureDiagnosticsJson: string | null;
  readonly reviewResultId: string | null;
  readonly reviewResultSchemaId:
    | "IssueTriageV1"
    | "PrReviewPlanV1"
    | "IssueTriageV2"
    | "PrReviewPlanV2"
    | null;
  readonly reviewResultDigest: string | null;
  readonly reviewResultSummary: string | null;
  readonly reviewRequestedRecipeIdsJson: string | null;
  readonly reviewResultCreatedAt: string | null;
  readonly reviewVerificationJson: string | null;
  readonly reviewExecutionEvidenceJson: string | null;
  readonly prReviewAssessment: "approve" | "comment" | "request_changes" | null;
  readonly issueCategory:
    | "bug"
    | "feature_request"
    | "documentation"
    | "question"
    | "support"
    | "other"
    | null;
  readonly issuePriority: number | null;
  readonly issueConfidence: number | null;
  readonly issueSuggestedLabelsJson: string | null;
  readonly issueMissingInformationJson: string | null;
  readonly issueDuplicateCandidatesJson: string | null;
}

interface ReviewFindingRow {
  readonly findingId: string;
  readonly ordinal: number;
  readonly priority: number;
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly line: number;
  readonly endLine: number | null;
  readonly confidence: number;
}

const jobSelectSql = `
  SELECT
    job.id,
    repository.id AS "repositoryId",
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
`;

const jobFromSql = `
  FROM jobs AS job
  JOIN work_items AS item ON item.id = job.work_item_id
  JOIN repositories AS repository ON repository.id = item.repository_id
  LEFT JOIN run_attempts AS attempt ON attempt.id = job.current_run_attempt_id
  LEFT JOIN job_admission AS admission ON admission.job_id = job.id
`;

const jobByIdSql = `
  SELECT
    job.id,
    repository.id AS "repositoryId",
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
    review_result.result_digest AS "resultDigest",
    job.failure_message AS "failureMessage",
    latest_attempt.failure_diagnostics_json AS "failureDiagnosticsJson",
    review_result.id AS "reviewResultId",
    review_result.schema_id AS "reviewResultSchemaId",
    review_result.result_digest AS "reviewResultDigest",
    review_result.summary AS "reviewResultSummary",
    review_result.requested_recipe_ids_json AS "reviewRequestedRecipeIdsJson",
    review_result.created_at AS "reviewResultCreatedAt",
    CASE WHEN review_result.schema_id IN ('IssueTriageV2', 'PrReviewPlanV2')
      THEN json_extract(review_result.result_json, '$.verification')
      ELSE NULL
    END AS "reviewVerificationJson",
    CASE WHEN review_result.schema_id IN ('IssueTriageV2', 'PrReviewPlanV2')
      THEN json_extract(review_result.result_json, '$.executionEvidence')
      ELSE NULL
    END AS "reviewExecutionEvidenceJson",
    pr_review.assessment AS "prReviewAssessment",
    issue_triage.category AS "issueCategory",
    issue_triage.priority AS "issuePriority",
    issue_triage.confidence AS "issueConfidence",
    issue_triage.suggested_labels_json AS "issueSuggestedLabelsJson",
    issue_triage.missing_information_json AS "issueMissingInformationJson",
    issue_triage.duplicate_candidates_json AS "issueDuplicateCandidatesJson",
    job.started_at AS "startedAt",
    job.completed_at AS "completedAt",
    job.created_at AS "createdAt",
    job.updated_at AS "updatedAt"
  FROM jobs AS job
  JOIN work_items AS item ON item.id = job.work_item_id
  JOIN repositories AS repository ON repository.id = item.repository_id
  LEFT JOIN run_attempts AS attempt ON attempt.id = job.current_run_attempt_id
  LEFT JOIN run_attempts AS latest_attempt ON latest_attempt.id = (
    SELECT candidate.id FROM run_attempts AS candidate
    WHERE candidate.job_id = job.id
    ORDER BY candidate.attempt_number DESC LIMIT 1
  )
  LEFT JOIN review_results AS review_result ON review_result.job_id = job.id
  LEFT JOIN pr_review_results AS pr_review ON pr_review.review_result_id = review_result.id
  LEFT JOIN issue_triage_results AS issue_triage ON issue_triage.review_result_id = review_result.id
  WHERE job.id = ?
  LIMIT 1
`;

const reviewFindingsSql = `
  SELECT
    finding.finding_id AS "findingId",
    finding.ordinal,
    finding.priority,
    finding.title,
    finding.body,
    finding.path,
    finding.line,
    finding.end_line AS "endLine",
    finding.confidence
  FROM pr_review_findings AS finding
  WHERE finding.review_result_id = ?
  ORDER BY finding.ordinal ASC
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
  context?: OperatorReadContext,
): DashboardJobListResponse => {
  const page = pageNumber(input.page);
  const size = pageSize(input.pageSize);
  assertPagination(page, size);
  const filters: SqlFilters = { clauses: [], parameters: [] };
  if (context !== undefined) {
    const visibility = repositoryReadSql(
      "item.repository_id",
      context.actor,
      context.administrators,
    );
    filters.clauses.push(`(${visibility.sql})`);
    filters.parameters.push(...visibility.parameters);
  }
  if (input.repositoryId !== undefined) {
    filters.clauses.push("item.repository_id = ?");
    filters.parameters.push(input.repositoryId);
  }
  addEnumFilter(filters, "job.status", values(input.status));
  addEnumFilter(filters, "job.current_step", values(input.phase));
  addEnumFilter(
    filters,
    `(${jobStageSql("job.status", "job.current_step", "admission.state")})`,
    values(input.stage),
  );
  const admission = values(input.admission);
  if (admission.length > 0) {
    filters.clauses.push("job.status IN ('queued', 'retry_waiting')");
    addEnumFilter(filters, "admission.state", admission);
  }
  if (input.workItemId !== undefined) {
    filters.clauses.push("job.work_item_id = ?");
    filters.parameters.push(input.workItemId);
  }
  const search = searchPattern(input.search);
  if (search !== null) {
    filters.clauses.push(`lower(
      job.id || ' ' || repository.full_name || ' ' || item.github_number || ' ' ||
      item.title || ' ' || COALESCE(attempt.worker_node_id, '')
    ) LIKE ? ESCAPE '\\'`);
    filters.parameters.push(search);
  }
  const filteredSql = `${jobFromSql} ${whereSql(filters)}`;

  return withReadTransaction(database, () => {
    // An admission filter must never silently drop a corrupt waiting Job from the count.
    assertWaitingAdmissionIntegrity(database, {
      ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
      ...(context === undefined ? {} : { context }),
    });
    const count = database
      .prepare(`SELECT COUNT(*) AS total ${filteredSql}`)
      .get(...filters.parameters) as { readonly total: number };
    const rows =
      page > Math.ceil(count.total / size)
        ? []
        : (database
            .prepare(`${jobSelectSql} ${filteredSql}
              ORDER BY job.created_at DESC, job.id LIMIT ? OFFSET ?
            `)
            .all(...filters.parameters, size, (page - 1) * size) as unknown as JobRow[]);
    const now = Date.now();
    const projected = rows.map((row) => ({
      id: row.id,
      repositoryId: row.repositoryId,
      workItemId: row.workItemId,
      workItemRef: row.workItemRef,
      title: row.title,
      generation: row.generation,
      status: row.status,
      phase: row.phase,
      attempt: row.attempt,
      admission: readJobAdmission(database, {
        jobId: row.id,
        status: row.status,
        attemptCount: row.attempt,
      }),
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
    const result = { items: projected, total: count.total };
    if (
      !Value.Check(DashboardJobListResponseSchema, result) ||
      result.items.some(
        (job) => getJobAdmissionIssues({ ...job, attemptCount: job.attempt }).length > 0,
      )
    ) {
      throw new GitHubIngestionInvariantError(
        "The database job projection does not match DashboardJobListResponseSchema.",
      );
    }
    return result;
  });
};

const parseStringArray = (value: string): string[] => {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new GitHubIngestionInvariantError(
      "The persisted JSON value must be an array of strings.",
    );
  }
  return [...parsed];
};

const requirePersistedValue = <T>(value: T | null, message: string): T => {
  if (value === null) {
    throw new GitHubIngestionInvariantError(message);
  }
  return value;
};

const parseIssueDuplicateCandidates = (
  value: string,
): Array<{ readonly number: number; readonly reason: string }> => {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed)) {
    throw new GitHubIngestionInvariantError(
      "The persisted duplicate-candidates projection must be an array.",
    );
  }
  return parsed.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new GitHubIngestionInvariantError(
        "The persisted duplicate-candidates projection contains an invalid item.",
      );
    }
    const candidate = item as Record<string, unknown>;
    const number = candidate.number;
    const reason = candidate.reason;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > 2_147_483_647 ||
      typeof reason !== "string" ||
      reason.length < 1 ||
      reason.length > 2_048
    ) {
      throw new GitHubIngestionInvariantError(
        "The persisted duplicate-candidates projection contains an invalid item.",
      );
    }
    return {
      number,
      reason,
    };
  });
};

const mapReviewFinding = (finding: ReviewFindingRow) => {
  if (finding.endLine !== null && finding.endLine < finding.line) {
    throw new GitHubIngestionInvariantError(
      "The persisted review finding end line must be greater than or equal to line.",
    );
  }
  return {
    findingId: finding.findingId,
    ordinal: finding.ordinal,
    priority: finding.priority,
    title: finding.title,
    body: finding.body,
    path: finding.path,
    line: finding.line,
    endLine: finding.endLine,
    confidence: finding.confidence,
  };
};

const readReviewEvidence = (row: JobDetailsRow) => {
  if (
    row.reviewResultSchemaId !== "IssueTriageV2" &&
    row.reviewResultSchemaId !== "PrReviewPlanV2"
  ) {
    return {};
  }
  const verification = parseJson<unknown>(
    requirePersistedValue(
      row.reviewVerificationJson,
      "The persisted version-two review is missing its verification report.",
    ),
  );
  const executionEvidence = parseJson<unknown>(
    requirePersistedValue(
      row.reviewExecutionEvidenceJson,
      "The persisted version-two review is missing its execution evidence.",
    ),
  );
  if (
    !Value.Check(VerificationReportSchema, verification) ||
    !Value.Check(ReviewExecutionEvidenceSchema, executionEvidence)
  ) {
    throw new GitHubIngestionInvariantError(
      "The persisted version-two review evidence does not match its authoritative schema.",
    );
  }
  return { verification, executionEvidence };
};

const readFailureDiagnostics = (json: string | null) => {
  if (json === null) return null;
  const diagnostics = parseJson<unknown>(json);
  if (!Value.Check(RunFailureDiagnosticsSchema, diagnostics)) {
    throw new GitHubIngestionInvariantError(
      "The persisted run failure diagnostics do not match their authoritative schema.",
    );
  }
  return diagnostics;
};

export const getJob = (
  database: DatabaseSync,
  input: DashboardJobReadQuery,
  context?: OperatorReadContext,
): DashboardJobDetailRead | null =>
  withReadTransaction(database, () => {
    if (!Value.Check(DashboardJobReadQuerySchema, input)) {
      throw new GitHubIngestionInvariantError(
        "The dashboard job lookup input does not match DashboardJobReadQuerySchema.",
      );
    }
    if (context !== undefined) {
      const visibility = repositoryReadSql(
        "item.repository_id",
        context.actor,
        context.administrators,
      );
      // Resolve ownership from the stored work item. A platform administrator alone can pass
      // this gate for jobs without a work item; their legacy projection may still be absent.
      const visible = database
        .prepare(`SELECT 1 FROM jobs AS job
        LEFT JOIN work_items AS item ON item.id = job.work_item_id
        WHERE job.id = ? AND (${visibility.sql}) LIMIT 1`)
        .get(input.jobId, ...visibility.parameters);
      if (visible === undefined) return null;
    }
    const row = database.prepare(jobByIdSql).get(input.jobId) as unknown as
      | JobDetailsRow
      | undefined;
    if (row === undefined) {
      return null;
    }
    const prReviewFindings: ReviewFindingRow[] =
      row.reviewResultId !== null && row.prReviewAssessment !== null
        ? (database
            .prepare(reviewFindingsSql)
            .all(row.reviewResultId) as unknown as ReviewFindingRow[])
        : [];

    if (
      row.reviewResultId !== null &&
      (row.reviewResultSchemaId === null ||
        row.reviewResultDigest === null ||
        row.reviewResultSummary === null ||
        row.reviewRequestedRecipeIdsJson === null ||
        row.reviewResultCreatedAt === null)
    ) {
      throw new GitHubIngestionInvariantError("The persisted review result row is incomplete.");
    }

    const isPrReview =
      row.reviewResultSchemaId === "PrReviewPlanV1" ||
      row.reviewResultSchemaId === "PrReviewPlanV2";
    const isIssueTriage =
      row.reviewResultSchemaId === "IssueTriageV1" || row.reviewResultSchemaId === "IssueTriageV2";
    if (isPrReview && row.prReviewAssessment === null) {
      throw new GitHubIngestionInvariantError(
        "The persisted PR review result is missing its projection assessment.",
      );
    }

    if (
      isIssueTriage &&
      (row.issueCategory === null ||
        row.issuePriority === null ||
        row.issueConfidence === null ||
        row.issueSuggestedLabelsJson === null ||
        row.issueMissingInformationJson === null ||
        row.issueDuplicateCandidatesJson === null)
    ) {
      throw new GitHubIngestionInvariantError(
        "The persisted issue triage result is missing its projection payload.",
      );
    }

    const issueTriage = !isIssueTriage
      ? null
      : {
          category: requirePersistedValue(
            row.issueCategory,
            "The persisted issue triage result is missing its category.",
          ),
          priority: requirePersistedValue(
            row.issuePriority,
            "The persisted issue triage result is missing its priority.",
          ),
          confidence: requirePersistedValue(
            row.issueConfidence,
            "The persisted issue triage result is missing its confidence.",
          ),
          suggestedLabels: parseStringArray(
            requirePersistedValue(
              row.issueSuggestedLabelsJson,
              "The persisted issue triage result is missing suggested labels.",
            ),
          ),
          missingInformation: parseStringArray(
            requirePersistedValue(
              row.issueMissingInformationJson,
              "The persisted issue triage result is missing information requirements.",
            ),
          ),
          duplicateCandidates: parseIssueDuplicateCandidates(
            requirePersistedValue(
              row.issueDuplicateCandidatesJson,
              "The persisted issue triage result is missing duplicate candidates.",
            ),
          ),
        };

    const reviewResult =
      row.reviewResultId === null
        ? null
        : {
            reviewResultId: row.reviewResultId,
            schemaId: requirePersistedValue(
              row.reviewResultSchemaId,
              "The persisted review result is missing its schema identifier.",
            ),
            resultDigest: requirePersistedValue(
              row.reviewResultDigest,
              "The persisted review result is missing its digest.",
            ),
            summary: requirePersistedValue(
              row.reviewResultSummary,
              "The persisted review result is missing its summary.",
            ),
            requestedRecipeIds: parseStringArray(
              requirePersistedValue(
                row.reviewRequestedRecipeIdsJson,
                "The persisted review result is missing requested recipes.",
              ),
            ),
            createdAt: requirePersistedValue(
              row.reviewResultCreatedAt,
              "The persisted review result is missing its creation timestamp.",
            ),
            prReview: !isPrReview
              ? null
              : {
                  assessment: requirePersistedValue(
                    row.prReviewAssessment,
                    "The persisted PR review result is missing its assessment.",
                  ),
                  findings: prReviewFindings.map(mapReviewFinding),
                },
            issueTriage,
            ...readReviewEvidence(row),
          };

    const result: DashboardJobDetailRead = {
      id: row.id,
      repositoryId: row.repositoryId,
      workItemId: row.workItemId,
      workItemRef: row.workItemRef,
      title: row.title,
      generation: row.generation,
      status: row.status,
      phase: row.phase,
      attempt: row.attempt,
      admission: readJobAdmission(database, {
        jobId: row.id,
        status: row.status,
        attemptCount: row.attempt,
      }),
      maxAttempts: row.maxAttempts,
      workerNodeId: row.workerNodeId,
      leaseGeneration: row.leaseGeneration > 0 ? row.leaseGeneration : null,
      leaseExpiresAt: row.leaseExpiresAt,
      progressUpdatedAt: row.progressUpdatedAt,
      elapsedSeconds: elapsedSeconds(row, Date.now()),
      targetRevisionKey: row.targetRevisionKey,
      outcome: jobOutcome(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      failureDiagnostics: readFailureDiagnostics(row.failureDiagnosticsJson),
      resultDigest: row.resultDigest,
      reviewResult,
    };
    if (
      !Value.Check(DashboardJobDetailReadSchema, result) ||
      getJobAdmissionIssues({ ...result, attemptCount: result.attempt }).length > 0
    ) {
      throw new GitHubIngestionInvariantError(
        "The database job projection does not match DashboardJobDetailReadSchema.",
      );
    }
    return result;
  });

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

const workerSelectSql = `
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
`;

const workerWhereSql = (statusCount: number): string => `
  WHERE worker.superseded_at IS NULL
    AND (
    ? IS NULL OR lower(
      worker.node_id || ' ' || worker.instance_id || ' ' || worker.display_name || ' ' ||
      worker.version
    ) LIKE ? ESCAPE '\\'
  )
  ${statusCount === 0 ? "" : `AND worker.status IN (${Array.from({ length: statusCount }, () => "?").join(", ")})`}
`;

const workerOrderSql = (sort: DashboardWorkerListQuery["sort"]): string =>
  sort === "identity"
    ? "ORDER BY worker.node_id, worker.instance_id, worker.id"
    : "ORDER BY worker.last_seen_at DESC, worker.id";

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const safeWorkerDisplayName = (value: string): string =>
  workerTokenShapePattern.test(value) ? redactedWorkerDisplayName : value;

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
    const whereSql = workerWhereSql(statuses.length);
    const queryParameters = [search, search, ...statuses];
    const count = database
      .prepare(`SELECT COUNT(*) AS total FROM workers AS worker ${whereSql}`)
      .get(...queryParameters) as unknown as { readonly total: number };
    if (!Number.isSafeInteger(count.total) || count.total < 0) {
      throw new GitHubIngestionInvariantError("The database worker count is invalid.");
    }
    const pageCount = Math.ceil(count.total / size);
    const rows =
      count.total === 0 || page > pageCount
        ? []
        : (database
            .prepare(
              `${workerSelectSql} ${whereSql} ${workerOrderSql(input.sort)} LIMIT ? OFFSET ?`,
            )
            .all(...queryParameters, size, (page - 1) * size) as unknown as WorkerRow[]);
    const projected = rows.map((row) => {
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
        displayName: safeWorkerDisplayName(row.displayName),
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
    const result = { items: projected, total: count.total };
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
  readonly queuedJobs: number;
  readonly awaitingAdmissionJobs: number;
  readonly pendingValidationRequests: number;
  readonly oldestAwaitingAdmissionAt: string | null;
  readonly activeWorkers: number;
  readonly activeLeases: number;
}

export const getSystemSnapshot = (
  database: DatabaseSync,
  _schemaVersion: number,
  input: { readonly githubHealth?: DashboardHealthComponent } = {},
): DashboardSystemRead =>
  withReadTransaction(database, () => {
    assertWaitingAdmissionIntegrity(database);
    const row = database
      .prepare(`
        SELECT
          sqlite_version() AS "sqliteVersion",
          (
            SELECT page_count * page_size
            FROM pragma_page_count(), pragma_page_size()
          ) AS "databaseSizeBytes",
          queue."oldestQueuedAt",
          queue."queuedJobs",
          queue."awaitingAdmissionJobs",
          queue."oldestAwaitingAdmissionAt",
          (
            SELECT COUNT(*) FROM validation_dispatch_checks AS pending
            WHERE pending.pending = 1 AND NOT EXISTS (
              SELECT 1 FROM review_run_job_links AS link
              WHERE link.review_run_id = pending.review_run_id AND link.request_id = pending.request_id
            )
          ) AS "pendingValidationRequests",
          (
            SELECT COUNT(*) FROM workers
            WHERE status IN ('online', 'draining') AND superseded_at IS NULL
          ) AS "activeWorkers",
          (
            SELECT COUNT(*) FROM run_attempts
            WHERE status IN ('leased', 'running')
          ) AS "activeLeases"
        FROM (
          SELECT
            MIN(CASE WHEN admission.state = 'admitted' THEN job.created_at END) AS "oldestQueuedAt",
            COUNT(CASE WHEN admission.state = 'admitted' THEN 1 END) AS "queuedJobs",
            COUNT(CASE WHEN admission.state = 'pending' THEN 1 END) AS "awaitingAdmissionJobs",
            MIN(CASE WHEN admission.state = 'pending' THEN job.created_at END) AS "oldestAwaitingAdmissionAt"
          FROM jobs AS job JOIN job_admission AS admission ON admission.job_id = job.id
          WHERE job.status IN ('queued', 'retry_waiting')
        ) AS queue
      `)
      .get() as unknown as SystemRow;
    const checkedAt = new Date().toISOString();
    const workerPoolHealthy = row.activeWorkers > 0;
    const result: DashboardSystemRead = {
      serverVersion: "0.1.0",
      protocolVersion: "1.0",
      nodeVersion: process.versions.node,
      sqliteVersion: row.sqliteVersion,
      databaseSizeBytes: row.databaseSizeBytes,
      // These ages identify the oldest Job, not an inferred historical admission event.
      oldestQueuedAt: row.oldestQueuedAt,
      queuedJobs: row.queuedJobs,
      awaitingAdmissionJobs: row.awaitingAdmissionJobs,
      pendingValidationRequests: row.pendingValidationRequests,
      oldestAwaitingAdmissionAt: row.oldestAwaitingAdmissionAt,
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
        input.githubHealth ?? {
          id: "github",
          name: "GitHub ingestion",
          status: "unavailable",
          summary: "GitHub runtime health was not supplied for this database snapshot.",
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
