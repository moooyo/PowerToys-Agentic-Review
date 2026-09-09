import type { DatabaseSync } from "node:sqlite";
import type { ValidationJobResult } from "@agentic-review/codex";
import {
  type DashboardReviewRunDetail,
  DashboardReviewRunDetailSchema,
  type DashboardReviewRunJob,
  type DashboardReviewRunJobListQuery,
  DashboardReviewRunJobListQuerySchema,
  type DashboardReviewRunJobListResponse,
  DashboardReviewRunJobListResponseSchema,
  DashboardReviewRunJobSchema,
  type DashboardReviewRunListQuery,
  DashboardReviewRunListQuerySchema,
  type DashboardReviewRunListResponse,
  DashboardReviewRunListResponseSchema,
  type DashboardReviewRunReadQuery,
  DashboardReviewRunReadQuerySchema,
  type DashboardReviewRunReproductionCaseQuery,
  DashboardReviewRunReproductionCaseQuerySchema,
  type DashboardReviewRunReproductionCaseResponse,
  type DashboardReviewRunRequest,
  DashboardReviewRunRequestSchema,
  type DashboardReviewRunResult,
  type DashboardReviewRunResultQuery,
  DashboardReviewRunResultQuerySchema,
  DashboardReviewRunResultSchema,
  type DashboardReviewRunSummary,
  DashboardReviewRunSummarySchema,
  type DashboardValidationOutcomeCounts,
  type DashboardValidationPolicy,
  type DashboardValidationResultSummary,
  getJobAdmissionIssues,
  maximumDashboardReviewRunFindingPreviewCount,
  maximumDashboardReviewRunPolicyReasonCount,
  maximumDashboardReviewRunResponseUtf8Bytes,
  QualifiedValidationCheckIdSchema,
  ReviewRunBlockedReasonSchema,
  type ReviewRunTestedSourceRevision,
  ReviewRunTestedSourceRevisionSchema,
} from "@agentic-review/contracts";
import { evaluateValidationApproval, type ValidationApprovalReport } from "@agentic-review/domain";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sha256 } from "../scheduling/canonical-json.js";
import type { EvidenceStorageOptions } from "./evidence-assets.js";
import {
  currentRunFindingDispositionDigest,
  findingOccurrenceKey,
  readFindingDispositionProjection,
} from "./finding-disposition-projection.js";
import {
  type ReproductionReadEvidence,
  readIssueReproductionCaseInTransaction,
  readIssueReproductionResult,
  readIssueReproductionRunSummary,
} from "./issue-reproduction-queries.js";
import { readJobAdmission } from "./job-admission.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import { readValidationModelResultBindingInTransaction } from "./validation-model-result-binding.js";
import {
  currentValidationEvidence,
  normalizedValidationModel,
  normalizedValidationReport,
  type ValidationEvidenceProjectionContext,
  type VerifiedValidationEvidenceFacts,
  verificationKey,
  verificationStatuses,
} from "./validation-result-projection.js";
import type { ValidationEvidenceReferenceScope } from "./validation-results.js";

export type VerifiedReviewRunEvidenceFacts = VerifiedValidationEvidenceFacts;

function preparedAdmission(
  callback: ((scope: ValidationEvidenceReferenceScope) => boolean) | undefined,
  scope: ValidationEvidenceReferenceScope,
): boolean {
  try {
    return callback?.(scope) === true;
  } catch {
    return false;
  }
}

function reproductionEvidence(
  context: ValidationEvidenceProjectionContext,
): ReproductionReadEvidence {
  const facts = context.kind === "prepared" ? context.facts : undefined;
  if (facts === undefined) return {};
  return {
    assertCurrent: facts.assertCurrent,
    validateEvidenceReferences: (scope) =>
      preparedAdmission(facts.admittedEvidenceReferences, scope),
    validateScenarioEvidence: (scope) => preparedAdmission(facts.admittedScenarioEvidence, scope),
    verificationStatus: (requestId, jobId) =>
      context.kind === "prepared"
        ? context.statuses.get(verificationKey(requestId, jobId))
        : undefined,
    ...(facts.admittedScenarioObservations === undefined
      ? {}
      : { readScenarioObservations: facts.admittedScenarioObservations }),
  };
}

export interface ReviewRunQueryOperationMap {
  readonly getDashboardReviewRunReproductionCase: {
    readonly input: DashboardReviewRunReproductionCaseQuery;
    readonly output: DashboardReviewRunReproductionCaseResponse | null;
  };
  readonly listDashboardReviewRuns: {
    readonly input: DashboardReviewRunListQuery;
    readonly output: DashboardReviewRunListResponse;
  };
  readonly getDashboardReviewRun: {
    readonly input: DashboardReviewRunReadQuery;
    readonly output: DashboardReviewRunDetail | null;
  };
  readonly listDashboardReviewRunJobs: {
    readonly input: DashboardReviewRunJobListQuery;
    readonly output: DashboardReviewRunJobListResponse | null;
  };
  readonly getDashboardReviewRunJobResult: {
    readonly input: DashboardReviewRunResultQuery;
    readonly output: DashboardReviewRunResult | null;
  };
}
export type ReviewRunQueryOperation = keyof ReviewRunQueryOperationMap;
export type ReviewRunQuery = {
  [K in ReviewRunQueryOperation]: {
    readonly operation: K;
    readonly input: ReviewRunQueryOperationMap[K]["input"];
  };
}[ReviewRunQueryOperation];

export function isReviewRunQueryOperation(operation: string): operation is ReviewRunQueryOperation {
  return [
    "listDashboardReviewRuns",
    "getDashboardReviewRun",
    "listDashboardReviewRunJobs",
    "getDashboardReviewRunJobResult",
    "getDashboardReviewRunReproductionCase",
  ].includes(operation);
}

class ReviewRunQueryError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "ReviewRunQueryError";
  }
}
function corrupt(): never {
  throw new ReviewRunQueryError("PLATFORM_CORRUPT", "The stored review run projection is invalid.");
}
function truncateUtf16(value: string, maximumLength: number): string {
  const truncated = value.slice(0, maximumLength);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

function jobProjection(
  database: DatabaseSync,
  row: Record<string, unknown>,
): DashboardReviewRunJob {
  if (row.failureMessage !== null && typeof row.failureMessage !== "string") corrupt();
  const job = checked(DashboardReviewRunJobSchema, {
    ...row,
    admission: null,
    failureMessage: row.failureMessage === null ? null : truncateUtf16(row.failureMessage, 2_048),
  });
  const projection = { ...job, admission: readJobAdmission(database, job) };
  if (getJobAdmissionIssues(projection).length > 0) corrupt();
  return projection;
}
function checked<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) corrupt();
  return value;
}
function bounded<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const result = checked(schema, value);
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") > maximumDashboardReviewRunResponseUtf8Bytes
  )
    corrupt();
  return result;
}
function parsed<T extends TSchema>(schema: T, value: string | null): Static<T> {
  if (value === null) corrupt();
  try {
    return checked(schema, JSON.parse(value));
  } catch {
    return corrupt();
  }
}
function validateInput<T extends TSchema>(schema: T, value: unknown): void {
  if (!Value.Check(schema, value))
    throw new ReviewRunQueryError("PLATFORM_INVALID", "The review run query is invalid.");
}
function pagination(input: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset))
    throw new ReviewRunQueryError(
      "PLATFORM_INVALID",
      "The review run page exceeds the supported range.",
    );
  return { page, pageSize, offset };
}

interface RunSummaryRow {
  id: string;
  repositoryId: string;
  repository: string;
  workItemId: string;
  workItemKind: "pull_request" | "issue";
  number: number;
  title: string;
  revisionKey: string;
  currentRevisionKey: string;
  planDigest: string;
  activationId: string;
  createdAt: string;
  requestCount: number;
  sourceActivationCurrent: number;
}
interface RunRow extends RunSummaryRow {
  requestEpochId: string;
  testedSourceJson: string | null;
  requiredChecksJson: string;
  blockersJson: string;
  itemState: string;
  epochState: string;
  repositoryEnabled: number;
  policyCurrent: number;
}

// SQLite extracts only bounded display fields. Prompt text, commands and the full plan stay private.
const runSummaryColumns = `run.id, run.repository_id AS repositoryId, repository.full_name AS repository,
  run.work_item_id AS workItemId, item.resource_kind AS workItemKind,
  json_extract(run.plan_json, '$.workItem.number') AS number,
  json_extract(run.plan_json, '$.workItem.title') AS title,
  run.revision_key AS revisionKey, item.current_revision_key AS currentRevisionKey,
  run.plan_digest AS planDigest, run.activation_id AS activationId,
  run.created_at AS createdAt, run.request_count AS requestCount,
  NOT EXISTS (
    SELECT 1 FROM github_review_run_activations AS activation
    LEFT JOIN github_review_run_sources AS source ON source.work_item_id = activation.work_item_id
    WHERE activation.mode = 'review_run' AND activation.review_run_id = run.id
      AND (activation.work_item_id IS NOT run.work_item_id
        OR activation.request_epoch_id IS NOT run.request_epoch_id
        OR activation.revision_key IS NOT run.revision_key
        OR source.sequence IS NOT activation.source_sequence
        OR source.current_revision_key IS NOT activation.revision_key)
  ) AS sourceActivationCurrent`;
const runColumns = `${runSummaryColumns}, run.request_epoch_id AS requestEpochId,
  json_extract(run.plan_json, '$.testedSourceRevision') AS testedSourceJson,
  json_extract(run.plan_json, '$.requiredCheckIds') AS requiredChecksJson,
  run.required_request_blockers_json AS blockersJson, item.state AS itemState,
  epoch.status AS epochState, repository.enabled AS repositoryEnabled,
  (repository.reviewer_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
    AND repository.authorization_policy_json IS NOT NULL
    AND NOT EXISTS (SELECT key, value, type FROM json_each(repository.authorization_policy_json)
      EXCEPT SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy'))
    AND NOT EXISTS (SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy')
      EXCEPT SELECT key, value, type FROM json_each(repository.authorization_policy_json))) AS policyCurrent`;
const runJoins = `FROM review_runs AS run
  JOIN managed_repositories AS repository ON repository.id = run.repository_id AND run.purpose = 'review'
  JOIN work_items AS item ON item.id = run.work_item_id AND item.repository_id = run.repository_id
  JOIN request_epochs AS epoch ON epoch.id = run.request_epoch_id AND epoch.work_item_id = run.work_item_id`;

const jobColumns = `job.id AS jobId, link.activation_number AS activationNumber,
  job.status, attempt.phase, job.attempt_count AS attemptCount,
  COALESCE(result.run_attempt_id, job.current_run_attempt_id) AS runAttemptId,
  job.created_at AS createdAt, job.started_at AS startedAt, job.completed_at AS completedAt,
  job.failure_code AS failureCode, substr(job.failure_message, 1, 2048) AS failureMessage,
  result.id AS resultId, result.result_digest AS resultDigest`;
const jobJoins = `FROM review_run_job_links AS link
  JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'review'
  JOIN jobs AS job ON job.id = link.job_id AND job.work_item_id = run.work_item_id
    AND job.resource_revision = run.revision_key AND job.request_epoch_id = run.request_epoch_id
  LEFT JOIN validation_job_results AS result ON result.job_id = job.id AND result.review_run_id = run.id
    AND result.request_id = link.request_id AND result.job_activation = link.activation_number
    AND result.repository_id = run.repository_id AND result.work_item_id = run.work_item_id
    AND result.resource_revision = run.revision_key AND result.plan_digest = run.plan_digest
    AND job.status = 'succeeded'
  LEFT JOIN run_attempts AS attempt ON attempt.id = COALESCE(result.run_attempt_id, job.current_run_attempt_id)
    AND attempt.job_id = job.id`;

function readRun(database: DatabaseSync, input: DashboardReviewRunReadQuery): RunRow | undefined {
  return database
    .prepare(`SELECT ${runColumns} ${runJoins}
    WHERE run.repository_id = ? AND run.id = ? AND (? IS NULL OR run.work_item_id = ?)`)
    .get(
      input.repositoryId,
      input.reviewRunId,
      input.workItemId ?? null,
      input.workItemId ?? null,
    ) as unknown as RunRow | undefined;
}

function summary(database: DatabaseSync, row: RunSummaryRow): DashboardReviewRunSummary {
  const requests = database
    .prepare(`SELECT request.required, job.id AS jobId, job.status, job.attempt_count AS attemptCount
    FROM review_run_requests AS request
    LEFT JOIN review_run_job_links AS link ON link.review_run_id = request.review_run_id AND link.request_id = request.request_id
      AND link.activation_number = (SELECT MAX(latest.activation_number) FROM review_run_job_links AS latest
        WHERE latest.review_run_id = request.review_run_id AND latest.request_id = request.request_id)
    LEFT JOIN jobs AS job ON job.id = link.job_id
    WHERE request.review_run_id = ? LIMIT 33`)
    .all(row.id) as unknown as {
    required: number;
    jobId: string | null;
    status: DashboardReviewRunJob["status"] | null;
    attemptCount: number | null;
  }[];
  if (requests.length !== row.requestCount || requests.length > 32) corrupt();
  const execution = {
    missing: 0,
    awaitingAdmission: 0,
    queued: 0,
    active: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const request of requests) {
    if (request.jobId === null) {
      if (request.status !== null || request.attemptCount !== null) corrupt();
      execution.missing++;
      continue;
    }
    if (request.status === null || request.attemptCount === null) corrupt();
    const admission = readJobAdmission(database, {
      jobId: request.jobId,
      status: request.status,
      attemptCount: request.attemptCount,
    });
    if (["queued", "retry_waiting"].includes(request.status)) {
      if (admission?.state === "pending") execution.awaitingAdmission++;
      else if (admission?.state === "admitted") execution.queued++;
      else corrupt();
    } else if (["leased", "running", "cancel_requested"].includes(request.status))
      execution.active++;
    else if (request.status === "succeeded") execution.succeeded++;
    else if (["failed", "dead_letter"].includes(request.status)) execution.failed++;
    else if (["stale", "cancelled"].includes(request.status)) execution.cancelled++;
    else corrupt();
  }
  return checked(DashboardReviewRunSummarySchema, {
    id: row.id,
    repositoryId: row.repositoryId,
    repository: row.repository,
    workItemId: row.workItemId,
    workItemKind: row.workItemKind,
    number: row.number,
    title: row.title,
    revisionKey: row.revisionKey,
    currentRevisionKey: row.currentRevisionKey,
    freshness:
      row.revisionKey === row.currentRevisionKey && row.sourceActivationCurrent === 1
        ? "current"
        : "superseded",
    planDigest: row.planDigest,
    activationId: row.activationId,
    createdAt: row.createdAt,
    requestCount: row.requestCount,
    requiredRequestCount: requests.filter((request) => request.required === 1).length,
    execution,
  });
}

function listRuns(
  database: DatabaseSync,
  input: DashboardReviewRunListQuery,
): DashboardReviewRunListResponse {
  const { page, pageSize, offset } = pagination(input);
  const where = "WHERE run.repository_id = ? AND (? IS NULL OR run.work_item_id = ?)";
  const params = [input.repositoryId, input.workItemId ?? null, input.workItemId ?? null];
  const count = database
    .prepare(`SELECT COUNT(*) AS total ${runJoins} ${where}`)
    .get(...params) as { total: number };
  const rows = database
    .prepare(
      `SELECT ${runSummaryColumns} ${runJoins} ${where} ORDER BY run.created_at DESC, run.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as unknown as RunSummaryRow[];
  return bounded(DashboardReviewRunListResponseSchema, {
    items: rows.map((row) => summary(database, row)),
    total: count.total,
    page,
    pageSize,
  });
}

function readJob(
  database: DatabaseSync,
  run: RunRow,
  requestId: string,
  jobId?: string,
): DashboardReviewRunJob | null {
  const row = database
    .prepare(`SELECT ${jobColumns} ${jobJoins}
    WHERE run.id = ? AND run.repository_id = ? AND link.request_id = ? AND (? IS NULL OR job.id = ?)
    ORDER BY link.activation_number DESC LIMIT 1`)
    .get(run.id, run.repositoryId, requestId, jobId ?? null, jobId ?? null);
  return row === undefined ? null : jobProjection(database, row);
}

interface ResultRow {
  id: string;
  runAttemptId: string;
  profileVersionId: string;
  promptVersionId: string;
  resultDigest: string;
  resultJson: string;
  schemaId: string;
  executionDigest: string;
  evidenceComplete: number;
  createdAt: string;
  workflowKind: DashboardReviewRunRequest["workflowKind"];
}

function readResult(
  database: DatabaseSync,
  run: RunRow,
  requestId: string,
  job: DashboardReviewRunJob,
  evidenceContext: ValidationEvidenceProjectionContext,
): DashboardReviewRunResult | null {
  if (job.status !== "succeeded") return null;
  const row = database
    .prepare(`SELECT result.id, result.run_attempt_id AS runAttemptId,
    result.profile_version_id AS profileVersionId, result.prompt_version_id AS promptVersionId,
    result.result_digest AS resultDigest, result.result_json AS resultJson, result.schema_id AS schemaId,
    result.execution_template_sha256 AS executionDigest,
    result.evidence_complete AS evidenceComplete, result.created_at AS createdAt, result.workflow_kind AS workflowKind
    FROM validation_job_results AS result
    JOIN review_runs AS result_run ON result_run.id = result.review_run_id AND result_run.purpose = 'review'
    JOIN review_run_requests AS request ON request.review_run_id = result.review_run_id AND request.request_id = result.request_id
      AND request.profile_version_id = result.profile_version_id AND request.prompt_version_id = result.prompt_version_id
      AND request.workflow_kind = result.workflow_kind AND request.target = result.target
    JOIN jobs AS job ON job.id = result.job_id AND job.status = 'succeeded'
      AND job.work_item_id = result.work_item_id AND job.resource_revision = result.resource_revision
      AND job.execution_digest = result.execution_template_sha256
    JOIN run_attempts AS attempt ON attempt.id = result.run_attempt_id AND attempt.job_id = job.id
      AND attempt.status = 'succeeded' AND attempt.attempt_number = job.attempt_count
      AND attempt.result_digest = result.result_digest
    WHERE result.repository_id = ? AND result.review_run_id = ? AND result.request_id = ? AND result.job_id = ?
      AND result.work_item_id = ? AND result.resource_revision = ? AND result.plan_digest = ?
      AND result.activation_id = ? AND result.job_activation = ? AND result.schema_id IN ('ValidationJobResultV1', 'ValidationJobResultV2')`)
    .get(
      run.repositoryId,
      run.id,
      requestId,
      job.jobId,
      run.workItemId,
      run.revisionKey,
      run.planDigest,
      run.activationId,
      job.activationNumber,
    ) as unknown as ResultRow | undefined;
  if (row === undefined) return null;
  if (
    Buffer.byteLength(row.resultJson, "utf8") > maximumDashboardReviewRunResponseUtf8Bytes ||
    sha256(row.resultJson) !== row.resultDigest
  )
    corrupt();
  let result: ValidationJobResult;
  try {
    result = decodeStoredValidationResult(row.schemaId, row.resultJson, row.resultDigest);
    readValidationModelResultBindingInTransaction(
      database,
      {
        repositoryId: run.repositoryId,
        runId: run.id,
        requestId,
        jobId: job.jobId,
        runAttemptId: row.runAttemptId,
        resultDigest: row.resultDigest,
        executionDigest: row.executionDigest,
      },
      result,
    );
  } catch {
    corrupt();
  }
  if (result.report.workItemKind !== run.workItemKind) corrupt();
  const latest = database
    .prepare(
      `SELECT MAX(activation_number) AS activation FROM review_run_job_links WHERE review_run_id = ? AND request_id = ?`,
    )
    .get(run.id, requestId) as { activation: number };
  const report = normalizedValidationReport(result);
  const reproduction = readIssueReproductionResult(
    database,
    {
      repositoryId: run.repositoryId,
      reviewRunId: run.id,
      requestId,
      jobId: job.jobId,
    },
    reproductionEvidence(evidenceContext),
  );
  return bounded(DashboardReviewRunResultSchema, {
    id: row.id,
    repositoryId: run.repositoryId,
    reviewRunId: run.id,
    workItemId: run.workItemId,
    requestId,
    jobId: job.jobId,
    runAttemptId: row.runAttemptId,
    activationNumber: job.activationNumber,
    authoritative: latest.activation === job.activationNumber,
    revisionKey: run.revisionKey,
    planDigest: run.planDigest,
    profileVersionId: row.profileVersionId,
    promptVersionId: row.promptVersionId,
    resultDigest: row.resultDigest,
    createdAt: row.createdAt,
    evidenceComplete: currentValidationEvidence(
      database,
      run,
      requestId,
      job,
      row,
      result,
      evidenceContext,
    ),
    ...(evidenceContext.kind === "prepared" &&
    evidenceContext.statuses.get(verificationKey(requestId, job.jobId)) === "pending"
      ? { evidenceVerificationPending: true }
      : {}),
    report,
    execution: result.execution,
    modelReview: normalizedValidationModel(result, row.workflowKind),
    ...(reproduction === undefined ? {} : { reproduction }),
  });
}

function preview(result: DashboardReviewRunResult): DashboardValidationResultSummary {
  const checks: DashboardValidationOutcomeCounts = {
    passed: 0,
    failed: 0,
    blocked: 0,
    not_run: 0,
    skipped: 0,
    inconclusive: 0,
  };
  for (const check of result.report.checks) checks[check.outcome]++;
  const findings = [
    ...result.modelReview.findings.map((finding) => ({
      id: finding.findingId,
      priority: finding.priority,
      title: finding.title,
      body: finding.body,
      path: finding.path,
      line: finding.line,
    })),
    ...result.modelReview.observations,
  ].sort((first, second) => first.priority - second.priority);
  const ids = [...new Set(result.report.checks.flatMap((check) => check.evidenceIds))];
  return {
    id: result.id,
    resultDigest: result.resultDigest,
    createdAt: result.createdAt,
    summary: truncateUtf16(result.report.summary, 1_024),
    summaryTruncated: result.report.summary.length > 1_024,
    sourceState: result.report.sourceState,
    checks,
    modelReviewState: result.modelReview.state,
    recommendation: result.modelReview.recommendation,
    reproductionConclusion:
      result.report.workItemKind === "issue" ? result.report.reproductionConclusion : null,
    findings: findings
      .slice(0, maximumDashboardReviewRunFindingPreviewCount)
      .map((finding) => ({ ...finding, body: truncateUtf16(finding.body, 512) })),
    findingCount: findings.length,
    findingsTruncated:
      findings.length > maximumDashboardReviewRunFindingPreviewCount ||
      findings.some((finding) => finding.body.length > 512),
    evidenceIds: ids.slice(0, 32),
    evidenceCount: ids.length,
    evidenceTruncated: ids.length > 32,
    evidenceComplete: result.evidenceComplete,
    ...(result.evidenceVerificationPending === true
      ? { evidenceVerificationPending: true as const }
      : {}),
    lifecycleBlockerCount: result.execution.blockers.length,
  };
}

const RequiredChecksSchema = Type.Array(QualifiedValidationCheckIdSchema, {
  maxItems: 3_072,
  uniqueItems: true,
});
const BlockersSchema = Type.Array(
  Type.Object(
    {
      requestId: DashboardReviewRunRequestSchema.properties.requestId,
      reason: Type.String({ minLength: 1, maxLength: 2_048 }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 4_480 },
);
const DispatchBlockersSchema = Type.Array(
  Type.Union([
    ReviewRunBlockedReasonSchema,
    Type.Object({ code: Type.Literal("authorization_changed") }, { additionalProperties: false }),
    Type.Object({ code: Type.Literal("job_association_limit") }, { additionalProperties: false }),
  ]),
  { maxItems: 140 },
);
const publicDispatchMessages = {
  authorization_changed: "The current authorization no longer permits execution.",
  job_association_limit: "The run has reached its maximum number of job activations.",
} as const;

function dispatchReasons(value: string): string[] {
  if (Buffer.byteLength(value, "utf8") > 65_536) corrupt();
  return parsed(DispatchBlockersSchema, value).map((reason) => {
    // Scheduler-only stop codes become public explanations, not undocumented API enums.
    if (reason.code === "authorization_changed" || reason.code === "job_association_limit")
      return publicDispatchMessages[reason.code];
    return reason.capability === undefined ? reason.code : `${reason.code}: ${reason.capability}`;
  });
}
interface RequestRow {
  requestId: string;
  workflowKind: DashboardReviewRunRequest["workflowKind"];
  target: DashboardReviewRunRequest["target"];
  required: number;
  profileJson: string | null;
  promptJson: string | null;
  requiredChecksJson: string;
  readiness: "ready" | "blocked";
  reasonsJson: string;
  lifecycleJson: string;
  dispatchCheckedAt: string | null;
  dispatchReasonsJson: string | null;
}
const StepSchema = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 128 }), required: Type.Boolean() },
  { additionalProperties: false },
);
const LifecycleSchema = Type.Object(
  {
    setup: Type.Array(StepSchema, { maxItems: 32 }),
    launch: Type.Array(StepSchema, { maxItems: 32 }),
    cleanup: Type.Array(StepSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
);

function requestRows(database: DatabaseSync, run: RunRow): RequestRow[] {
  return database
    .prepare(`SELECT request.request_id AS requestId, request.workflow_kind AS workflowKind,
    request.target, request.required,
    CASE WHEN request.profile_version_id IS NULL THEN NULL ELSE json_object(
      'id', request.profile_version_id, 'profileId', json_extract(request.request_json, '$.profileVersion.profileId'),
      'name', json_extract(request.request_json, '$.profileVersion.name'), 'version', json_extract(request.request_json, '$.profileVersion.version'),
      'configSha256', json_extract(request.request_json, '$.profileVersion.configSha256')) END AS profileJson,
    CASE WHEN request.prompt_version_id IS NULL THEN NULL ELSE json_object(
      'id', request.prompt_version_id, 'templateId', json_extract(request.request_json, '$.prompt.version.templateId'),
      'version', json_extract(request.request_json, '$.prompt.version.version'), 'contentSha256', json_extract(request.request_json, '$.prompt.version.contentSha256')) END AS promptJson,
    json_extract(request.request_json, '$.requiredCheckIds') AS requiredChecksJson,
    json_extract(readiness.value, '$.state') AS readiness,
    json_extract(readiness.value, '$.reasons') AS reasonsJson,
    dispatched.checked_at AS dispatchCheckedAt, dispatched.blockers_json AS dispatchReasonsJson,
    json_object('setup', json((SELECT json_group_array(json_object('id', json_extract(value, '$.id'), 'required', json(CASE json_extract(value, '$.required') WHEN 1 THEN 'true' ELSE 'false' END))) FROM json_each(request.request_json, '$.profileVersion.config.setup'))),
      'launch', json((SELECT json_group_array(json_object('id', json_extract(value, '$.id'), 'required', json(CASE json_extract(value, '$.required') WHEN 1 THEN 'true' ELSE 'false' END))) FROM json_each(request.request_json, '$.profileVersion.config.launch'))),
      'cleanup', json((SELECT json_group_array(json_object('id', json_extract(value, '$.id'), 'required', json(CASE json_extract(value, '$.required') WHEN 1 THEN 'true' ELSE 'false' END))) FROM json_each(request.request_json, '$.profileVersion.config.cleanup')))) AS lifecycleJson
    FROM review_run_requests AS request JOIN review_runs AS run ON run.id = request.review_run_id AND run.purpose = 'review'
    LEFT JOIN validation_dispatch_checks AS dispatched ON dispatched.review_run_id = run.id
      AND dispatched.request_id = request.request_id AND dispatched.repository_id = run.repository_id,
      json_each(run.readiness_json) AS readiness
    WHERE run.id = ? AND json_extract(readiness.value, '$.requestId') = request.request_id
    ORDER BY request.request_id LIMIT 33`)
    .all(run.id) as unknown as RequestRow[];
}

function detail(
  database: DatabaseSync,
  run: RunRow,
  evidenceContext: ValidationEvidenceProjectionContext,
  capturePolicy?: (policy: DashboardValidationPolicy) => void,
): DashboardReviewRunDetail {
  const base = summary(database, run);
  const requiredCheckIds = parsed(RequiredChecksSchema, run.requiredChecksJson);
  const initialBlockers = parsed(BlockersSchema, run.blockersJson);
  const blockers: { requestId: string; reason: string }[] = [];
  const reports: ValidationApprovalReport[] = [];
  const blockingFindingIds: string[] = [];
  let blockingFindingCount = 0;
  const rows = requestRows(database, run);
  if (rows.length !== run.requestCount) corrupt();
  if (
    initialBlockers.some(
      (blocker) => !rows.some((row) => row.requestId === blocker.requestId && row.required === 1),
    )
  )
    corrupt();
  const requests = rows.map((row): DashboardReviewRunRequest => {
    const initialReasons = parsed(
      Type.Array(
        Type.Object(
          {
            code: Type.String({ minLength: 1, maxLength: 128 }),
            capability: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          },
          { additionalProperties: false },
        ),
        { maxItems: 140 },
      ),
      row.reasonsJson,
    ).map((reason) =>
      reason.capability === undefined ? reason.code : `${reason.code}: ${reason.capability}`,
    );
    const latestJob = readJob(database, run, row.requestId);
    const hasCurrentDispatchCheck = row.dispatchCheckedAt !== null;
    if (
      row.dispatchCheckedAt !== null &&
      (row.dispatchReasonsJson === null || !Number.isFinite(Date.parse(row.dispatchCheckedAt)))
    )
      corrupt();
    const reasons =
      latestJob !== null
        ? []
        : hasCurrentDispatchCheck
          ? dispatchReasons(row.dispatchReasonsJson ?? "[]")
          : [
              ...new Set([
                ...initialReasons,
                ...initialBlockers
                  .filter((blocker) => blocker.requestId === row.requestId)
                  .map((blocker) => blocker.reason),
              ]),
            ];
    const readiness =
      latestJob !== null
        ? "ready"
        : hasCurrentDispatchCheck
          ? reasons.length === 0
            ? "ready"
            : "blocked"
          : row.readiness;
    const request: DashboardReviewRunRequest = checked(DashboardReviewRunRequestSchema, {
      requestId: row.requestId,
      workflowKind: row.workflowKind,
      target: row.target,
      required: row.required === 1,
      profile:
        row.profileJson === null
          ? null
          : parsed(DashboardReviewRunRequestSchema.properties.profile, row.profileJson),
      prompt:
        row.promptJson === null
          ? null
          : parsed(DashboardReviewRunRequestSchema.properties.prompt, row.promptJson),
      requiredCheckIds: parsed(
        DashboardReviewRunRequestSchema.properties.requiredCheckIds,
        row.requiredChecksJson,
      ),
      readiness,
      blockers: reasons,
      blockersTruncated: false,
      latestJob,
      latestResult: null,
    });
    const result =
      request.latestJob === null
        ? null
        : readResult(database, run, row.requestId, request.latestJob, evidenceContext);
    const actualBlockers: string[] = [];
    if (request.latestJob === null) actualBlockers.push("missing_job");
    else if (request.latestJob.status !== "succeeded")
      actualBlockers.push(
        request.latestJob.admission?.state === "pending"
          ? "execution_awaiting_admission"
          : `execution_${request.latestJob.status}`,
      );
    else if (result === null) actualBlockers.push("missing_authoritative_result");
    if (result !== null) {
      if (result.evidenceVerificationPending === true)
        actualBlockers.push("evidence_verification_pending");
      if (
        (request.workflowKind === "pr_static_build" || request.workflowKind === "issue_triage") &&
        result.modelReview.state !== "completed"
      )
        actualBlockers.push("missing_model_review");
      // UI and reproduction advice is optional. Its failed state remains visible independently;
      // explicit lifecycle blockers and blocking findings still prevent approval eligibility.
      actualBlockers.push(
        ...result.execution.blockers.map((blocker) => `${blocker.phase}: ${blocker.code}`),
      );
      const lifecycle = parsed(LifecycleSchema, row.lifecycleJson);
      if (
        result.execution.cleanupState !==
        (lifecycle.cleanup.length === 0 ? "not_needed" : "completed")
      )
        actualBlockers.push("cleanup_incomplete");
      for (const step of [
        ...lifecycle.setup.filter((step) => step.required),
        ...lifecycle.cleanup,
      ]) {
        const check = result.report.checks.find(
          (candidate) => candidate.id === `${result.profileVersionId}:${step.id}`,
        );
        if (check?.source !== "runner" || check.outcome !== "passed")
          actualBlockers.push(`lifecycle_not_passed: ${step.id}`);
      }
      // Persistent application startup is lifecycle diagnostics, never a validation check.
      // Its eventual termination may have a nonzero exit code after successful readiness.
      for (const step of lifecycle.launch.filter((step) => step.required)) {
        const diagnostics = result.execution.diagnostics.filter(
          (candidate) => candidate.stepId === `${result.profileVersionId}:${step.id}`,
        );
        if (
          diagnostics.length !== 1 ||
          diagnostics[0]?.phase !== "launch" ||
          diagnostics[0].outcome !== "passed"
        )
          actualBlockers.push(`lifecycle_not_passed: ${step.id}`);
      }
      if (request.required)
        reports.push({
          revisionKey: result.revisionKey,
          planDigest: result.planDigest,
          evidenceComplete: result.evidenceComplete,
          report: result.report,
        });
      // Preserve raw counts, but only unresolved P0/P1 occurrences block approval. Read every
      // original occurrence, including optional lanes and findings beyond the display preview.
      const projection = readFindingDispositionProjection(database, {
        resultId: result.id,
        resultDigest: result.resultDigest,
      });
      const occurrences = [
        ...result.modelReview.findings.map((finding) => ({
          kind: "pr_finding" as const,
          ordinal: finding.ordinal,
          priority: finding.priority,
        })),
        ...result.modelReview.observations.map((observation, ordinal) => ({
          kind: "validation_observation" as const,
          ordinal,
          priority: observation.priority,
        })),
      ];
      const validKeys = new Set<string>();
      for (const occurrence of occurrences) {
        const key = findingOccurrenceKey({
          resultId: result.id,
          resultDigest: result.resultDigest,
          kind: occurrence.kind,
          ordinal: occurrence.ordinal,
        });
        if (validKeys.has(key)) corrupt();
        validKeys.add(key);
        if (occurrence.priority > 1) continue;
        blockingFindingCount++;
        const state = projection.get(key)?.disposition.state ?? "open";
        if (state === "open" || state === "accepted") blockingFindingIds.push(key);
      }
      if ([...projection.keys()].some((key) => !validKeys.has(key))) corrupt();
    }
    if (request.required) {
      if (request.profile === null) actualBlockers.push("missing_profile");
      if (request.prompt === null) actualBlockers.push("missing_prompt");
      if (run.itemState !== "open") actualBlockers.push("work_item_closed");
      if (run.epochState !== "active") actualBlockers.push("authorization_closed");
      if (run.repositoryEnabled !== 1) actualBlockers.push("repository_paused");
      if (run.policyCurrent !== 1) actualBlockers.push("authorization_policy_changed");
      if (run.sourceActivationCurrent !== 1) actualBlockers.push("source_activation_superseded");
      for (const reason of new Set([...reasons, ...actualBlockers]))
        blockers.push({ requestId: request.requestId, reason });
    }
    const all = [...new Set([...reasons, ...actualBlockers])];
    return {
      ...request,
      blockers: all.slice(0, 160),
      blockersTruncated: all.length > 160,
      latestResult: result === null ? null : preview(result),
    };
  });
  // The plan and each request must describe the same complete set of required checks.
  const fromRequests = requests
    .filter((request) => request.required)
    .flatMap((request) => request.requiredCheckIds);
  if (
    fromRequests.length !== requiredCheckIds.length ||
    new Set(fromRequests).size !== fromRequests.length ||
    fromRequests.some((id) => !requiredCheckIds.includes(id))
  )
    corrupt();
  const decision =
    run.workItemKind === "pull_request"
      ? evaluateValidationApproval({
          currentRevisionKey: run.currentRevisionKey,
          expectedExecutionPlanDigest: run.planDigest,
          requiredCheckIds,
          reports,
          blockingFindingIds,
          requiredRequestBlockers: blockers,
        })
      : null;
  // Even an empty/missing result set must not hide that this plan belongs to an older revision.
  const reasons = decision === null ? [] : [...decision.reasons];
  if (
    decision !== null &&
    (run.revisionKey !== run.currentRevisionKey || run.sourceActivationCurrent !== 1) &&
    !reasons.some((reason) => reason.code === "stale_revision")
  )
    reasons.push({ code: "stale_revision" });
  const fullPolicy: DashboardValidationPolicy = {
    ...(decision === null
      ? { applicable: false as const, eligible: null }
      : { applicable: true as const, eligible: reasons.length === 0 }),
    policyVersion: "required-checks-and-unresolved-p0-p1-v2",
    reasons,
    reasonCount: reasons.length,
    reasonsTruncated: false,
    blockingFindingCount,
    unresolvedBlockingFindingCount: blockingFindingIds.length,
    findingDispositionDigest: currentRunFindingDispositionDigest(database, {
      repositoryId: run.repositoryId,
      reviewRunId: run.id,
    }),
  };
  const reproduction = readIssueReproductionRunSummary(
    database,
    {
      repositoryId: run.repositoryId,
      reviewRunId: run.id,
    },
    reproductionEvidence(evidenceContext),
  );
  const output = bounded(DashboardReviewRunDetailSchema, {
    ...base,
    requestEpochId: run.requestEpochId,
    testedSourceRevision:
      run.testedSourceJson === null
        ? null
        : (parsed(
            ReviewRunTestedSourceRevisionSchema,
            run.testedSourceJson,
          ) as ReviewRunTestedSourceRevision),
    requiredCheckIds,
    requests,
    ...(reproduction === undefined ? {} : { reproduction }),
    policy: {
      ...fullPolicy,
      reasons: reasons.slice(0, maximumDashboardReviewRunPolicyReasonCount),
      reasonsTruncated: reasons.length > maximumDashboardReviewRunPolicyReasonCount,
    },
  });
  // The internal audit callback gets every reason. It cannot mutate the bounded display result.
  capturePolicy?.(structuredClone(fullPolicy));
  return output;
}

function projectReviewRunQuery(
  database: DatabaseSync,
  request: ReviewRunQuery,
  evidenceContext: ValidationEvidenceProjectionContext,
): ReviewRunQueryOperationMap[ReviewRunQueryOperation]["output"] {
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
  database.exec("BEGIN");
  try {
    if (evidenceContext.kind === "prepared") {
      // Stale opaque proofs must escape before callback failures become incomplete evidence.
      evidenceContext.facts?.assertCurrent();
      evidenceContext = {
        ...evidenceContext,
        statuses: verificationStatuses(evidenceContext.facts),
      };
    }
    let output: ReviewRunQueryOperationMap[ReviewRunQueryOperation]["output"];
    switch (request.operation) {
      case "getDashboardReviewRunReproductionCase":
        validateInput(DashboardReviewRunReproductionCaseQuerySchema, request.input);
        output = readIssueReproductionCaseInTransaction(
          database,
          request.input,
          reproductionEvidence(evidenceContext),
        );
        break;
      case "listDashboardReviewRuns":
        validateInput(DashboardReviewRunListQuerySchema, request.input);
        output = listRuns(database, request.input);
        break;
      case "getDashboardReviewRun": {
        validateInput(DashboardReviewRunReadQuerySchema, request.input);
        const run = readRun(database, request.input);
        output = run === undefined ? null : detail(database, run, evidenceContext);
        break;
      }
      case "listDashboardReviewRunJobs": {
        validateInput(DashboardReviewRunJobListQuerySchema, request.input);
        const run = readRun(database, request.input);
        const resolvedRequest =
          run === undefined
            ? undefined
            : (database
                .prepare(
                  "SELECT request_id AS requestId FROM review_run_requests WHERE review_run_id = ? AND request_id = ?",
                )
                .get(run.id, request.input.requestId) as { requestId: string } | undefined);
        if (resolvedRequest === undefined || run === undefined) {
          output = null;
          break;
        }
        const { page, pageSize, offset } = pagination(request.input);
        const jobFilter = request.input.jobId === undefined ? "" : " AND link.job_id = ?";
        const jobParameters = request.input.jobId === undefined ? [] : [request.input.jobId];
        const total = (
          database
            .prepare(
              `SELECT COUNT(*) AS total FROM review_run_job_links AS link WHERE link.review_run_id = ? AND link.request_id = ?${jobFilter}`,
            )
            .get(run.id, resolvedRequest.requestId, ...jobParameters) as { total: number }
        ).total;
        const items = database
          .prepare(`SELECT ${jobColumns} ${jobJoins}
          WHERE run.id = ? AND run.repository_id = ? AND link.request_id = ?${jobFilter} ORDER BY link.activation_number DESC LIMIT ? OFFSET ?`)
          .all(
            run.id,
            run.repositoryId,
            resolvedRequest.requestId,
            ...jobParameters,
            pageSize,
            offset,
          )
          .map((row) => jobProjection(database, row));
        output = bounded(DashboardReviewRunJobListResponseSchema, {
          repositoryId: run.repositoryId,
          reviewRunId: run.id,
          requestId: resolvedRequest.requestId,
          items,
          total,
          page,
          pageSize,
        });
        break;
      }
      case "getDashboardReviewRunJobResult": {
        validateInput(DashboardReviewRunResultQuerySchema, request.input);
        const run = readRun(database, request.input);
        const job =
          run === undefined
            ? null
            : readJob(database, run, request.input.requestId, request.input.jobId);
        output =
          run === undefined || job === null
            ? null
            : readResult(database, run, request.input.requestId, job, evidenceContext);
        break;
      }
    }
    database.exec("COMMIT");
    return output;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Compatibility projection for direct storage tests. Production evidence-aware reads use the
 * prepared variant so the SQLite owner never hashes or parses evidence files synchronously. */
export function handleReviewRunQuery(
  database: DatabaseSync,
  request: ReviewRunQuery,
  evidenceStorage?: EvidenceStorageOptions,
): ReviewRunQueryOperationMap[ReviewRunQueryOperation]["output"] {
  return projectReviewRunQuery(database, request, {
    kind: "direct",
    ...(evidenceStorage === undefined ? {} : { storage: evidenceStorage }),
  });
}

/** Consumes only prepared authority and current SQLite metadata. Missing facts fail closed;
 * pending or negative proofs never fall back to synchronous verification or file reads. */
export function handleVerifiedReviewRunQuery(
  database: DatabaseSync,
  request: ReviewRunQuery,
  facts?: VerifiedReviewRunEvidenceFacts,
): ReviewRunQueryOperationMap[ReviewRunQueryOperation]["output"] {
  return projectReviewRunQuery(database, request, {
    kind: "prepared",
    ...(facts === undefined ? {} : { facts }),
    statuses: verificationStatuses(undefined),
  });
}

/** Projects a verified detail inside the caller's final transaction without opening, committing,
 * or rolling it back. The caller must consume prepared facts immediately after their async read. */
export function readVerifiedReviewRunDetailInTransaction(
  database: DatabaseSync,
  input: DashboardReviewRunReadQuery,
  facts?: VerifiedReviewRunEvidenceFacts,
  capturePolicy?: (policy: DashboardValidationPolicy) => void,
): DashboardReviewRunDetail | null {
  if (!database.isTransaction)
    throw new ReviewRunQueryError(
      "PLATFORM_INVALID",
      "A verified review run detail requires an existing database transaction.",
    );
  facts?.assertCurrent();
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
  validateInput(DashboardReviewRunReadQuerySchema, input);
  const run = readRun(database, input);
  return run === undefined
    ? null
    : detail(
        database,
        run,
        {
          kind: "prepared",
          ...(facts === undefined ? {} : { facts }),
          statuses: verificationStatuses(facts),
        },
        capturePolicy,
      );
}

/** Reads the complete immutable result under the same prepared-evidence transaction as a
 * publication preview. This must never substitute the bounded Dashboard finding preview. */
export function readVerifiedReviewRunResultInTransaction(
  database: DatabaseSync,
  input: DashboardReviewRunResultQuery,
  facts?: VerifiedReviewRunEvidenceFacts,
): DashboardReviewRunResult | null {
  if (!database.isTransaction)
    throw new ReviewRunQueryError(
      "PLATFORM_INVALID",
      "A verified result requires an existing transaction.",
    );
  facts?.assertCurrent();
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
  validateInput(DashboardReviewRunResultQuerySchema, input);
  const run = readRun(database, input);
  const job = run === undefined ? null : readJob(database, run, input.requestId, input.jobId);
  return run === undefined || job === null
    ? null
    : readResult(database, run, input.requestId, job, {
        kind: "prepared",
        ...(facts === undefined ? {} : { facts }),
        statuses: verificationStatuses(facts),
      });
}
