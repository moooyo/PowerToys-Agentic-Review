import type { DatabaseSync } from "node:sqlite";
import {
  getValidationModelSummary,
  getValidationReviewModel,
  type ValidationJobResult,
} from "@agentic-review/codex";
import {
  EntityIdSchema,
  type FindingComparisonResponse,
  type FindingComparisonRow,
  type FindingComparisonSide,
  type FindingModelAvailability,
  type FindingOccurrence,
  FindingOccurrenceSchema,
  type FindingResultContext,
  FindingResultContextSchema,
  JobStateSchema,
  maximumFindingComparisonRowCount,
  maximumFindingResultOccurrenceCount,
  maximumReviewRunRequestCount,
  maximumRunCompletionResultUtf8Bytes,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  RunAttemptStateSchema,
  Sha256Schema,
  WorkItemStateSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { findingOccurrenceKey } from "./finding-disposition-projection.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import { readValidationModelResultBindingInTransaction } from "./validation-model-result-binding.js";

export { findingOccurrenceKey } from "./finding-disposition-projection.js";

const scopeSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    reviewRunId: EntityIdSchema,
    requestId: EntityIdSchema,
    jobId: EntityIdSchema,
  },
  { additionalProperties: false },
);
export type FindingResultScope = Static<typeof scopeSchema>;
export type FindingOccurrenceContent = Omit<FindingOccurrence, "disposition">;
export interface FindingResultRead {
  readonly context: Omit<FindingResultContext, "dispositionDigest">;
  readonly occurrences: FindingOccurrenceContent[];
}
export interface FindingResultComparison {
  readonly algorithmVersion: "exact-content-v1";
  readonly compatible: boolean;
  readonly reasons: FindingComparisonResponse["reasons"];
  readonly items: FindingComparisonRow[];
}

const contextSchema = Type.Omit(FindingResultContextSchema, ["dispositionDigest"]);
const occurrenceSchema = Type.Omit(FindingOccurrenceSchema, ["disposition"]);
const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const nullablePositive = Type.Union([PositiveIntegerSchema, Type.Null()]);
const nullableDigest = Type.Union([Sha256Schema, Type.Null()]);
const authoritySchema = Type.Object(
  {
    activationId: EntityIdSchema,
    requestEpochId: EntityIdSchema,
    currentRevisionKey: Sha256Schema,
    currentSourceSequence: nullablePositive,
    currentSourceRevisionKey: nullableDigest,
    automaticSourceSequence: nullablePositive,
    itemState: WorkItemStateSchema,
    epochStatus: Type.Union([Type.Literal("active"), Type.Literal("closed")]),
    repositoryEnabled: Type.Boolean(),
    repositoryVersion: PositiveIntegerSchema,
    githubRepositoryId: PositiveIntegerSchema,
    reviewerGithubUserId: nullablePositive,
    epochTargetGithubUserId: PositiveIntegerSchema,
    epochOrdinal: PositiveIntegerSchema,
    authorizationPolicyCurrent: Type.Boolean(),
    latestJobId: EntityIdSchema,
    latestActivationNumber: PositiveIntegerSchema,
    latestJobStatus: JobStateSchema,
    latestJobAttemptCount: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);

class FindingOccurrenceError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "FindingOccurrenceError";
  }
}
function corrupt(): never {
  throw new FindingOccurrenceError("PLATFORM_CORRUPT", "The stored finding result is invalid.");
}
function invalid(message: string): never {
  throw new FindingOccurrenceError("PLATFORM_INVALID", message);
}
function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1) corrupt();
  return value === 1;
}
type Row = Record<string, unknown>;

// Select one explicit job. No historical-success fallback, full-plan transfer, evidence I/O, or
// other request's result parsing belongs in this read. The CASE also avoids transferring an
// oversized corrupt result from SQLite before the JavaScript byte-length check can reject it.
function selectedResult(database: DatabaseSync, input: FindingResultScope): Row | null {
  const rows = database
    .prepare(`SELECT run.repository_id AS repositoryId, run.id AS reviewRunId,
    run.work_item_id AS workItemId, item.resource_kind AS workItemKind,
    run.revision_key AS revisionKey, run.plan_digest AS planDigest, run.activation_id AS activationId,
    run.request_epoch_id AS requestEpochId, run.request_count AS requestCount,
    item.current_revision_key AS currentRevisionKey, item.state AS itemState,
    epoch.status AS epochStatus, epoch.target_github_user_id AS epochTargetGithubUserId,
    epoch.ordinal AS epochOrdinal, repository.enabled AS repositoryEnabled,
    repository.version AS repositoryVersion, repository.github_repository_id AS githubRepositoryId,
    repository.reviewer_github_user_id AS reviewerGithubUserId,
    source.work_item_id AS sourceWorkItemId, source.sequence AS currentSourceSequence,
    source.current_revision_key AS currentSourceRevisionKey,
    automatic.review_run_id AS automaticRunId, automatic.source_sequence AS automaticSourceSequence,
    (automatic.mode IS 'review_run' AND automatic.work_item_id IS run.work_item_id
      AND automatic.request_epoch_id IS run.request_epoch_id
      AND automatic.revision_key IS run.revision_key) AS automaticIdentityValid,
    (repository.id IS NOT NULL AND item.id IS NOT NULL AND epoch.id IS NOT NULL
      AND revision.id IS NOT NULL AND epoch_revision.id IS NOT NULL
      AND json_extract(run.plan_json, '$.schemaVersion') IS 'ReviewRunExecutionPlanV1'
      AND json_extract(run.plan_json, '$.repository.id') IS run.repository_id
      AND json_extract(run.plan_json, '$.workItemId') IS run.work_item_id
      AND json_extract(run.plan_json, '$.workItem.kind') IS item.resource_kind
      AND json_extract(run.plan_json, '$.revision.revisionKey') IS run.revision_key
      AND json_extract(run.plan_json, '$.activationId') IS run.activation_id
      AND json_extract(run.plan_json, '$.authorization.requestEpochId') IS run.request_epoch_id
      AND json_type(run.plan_json, '$.jobs') IS 'array'
      AND json_array_length(run.plan_json, '$.jobs') IS run.request_count) AS identityValid,
    (repository.github_repository_id IS json_extract(run.plan_json, '$.repository.githubRepositoryId')
      AND repository.reviewer_github_user_id IS NOT NULL
      AND repository.reviewer_github_user_id IS json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND epoch.target_github_user_id IS json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND epoch.ordinal IS json_extract(run.plan_json, '$.authorization.sequence')
      AND repository.authorization_policy_json IS NOT NULL
      AND json_type(run.plan_json, '$.authorization.policy') IS 'object'
      AND NOT EXISTS (SELECT key, value, type FROM json_each(repository.authorization_policy_json)
        EXCEPT SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy'))
      AND NOT EXISTS (SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy')
        EXCEPT SELECT key, value, type FROM json_each(repository.authorization_policy_json))) AS authorizationPolicyCurrent,
    (source.sequence IS NOT NULL AND source.current_revision_key IS item.current_revision_key
      AND item.current_revision_key IS run.revision_key AND epoch_revision.revision_key IS run.revision_key
      AND (automatic.review_run_id IS NULL OR (automatic.mode IS 'review_run'
        AND automatic.work_item_id IS run.work_item_id AND automatic.request_epoch_id IS run.request_epoch_id
        AND automatic.revision_key IS run.revision_key
        AND automatic.source_sequence IS source.sequence))) AS sourceMatches,
    request.request_id AS requestId, request.workflow_kind AS workflowKind, request.target,
    request.profile_version_id AS profileVersionId, request.prompt_version_id AS promptVersionId,
    request.required,
    (SELECT COUNT(*) FROM json_each(run.plan_json, '$.jobs') AS planned
      WHERE json_extract(planned.value, '$.requestId') IS request.request_id
        AND json_extract(planned.value, '$.workflowKind') IS request.workflow_kind
        AND json_extract(planned.value, '$.target') IS request.target
        AND json_extract(planned.value, '$.required') IS request.required
        AND json_extract(planned.value, '$.profileVersion.id') IS request.profile_version_id
        AND json_extract(planned.value, '$.prompt.version.id') IS request.prompt_version_id
        AND json(planned.value) IS json(request.request_json)) AS planMatches,
    link.activation_number AS activationNumber, link.job_id AS jobId,
    job.id AS selectedJobId, job.status AS jobStatus, job.attempt_count AS attemptCount,
    job.current_run_attempt_id AS currentAttemptId, job.execution_digest AS executionDigest,
    (job.work_item_id IS run.work_item_id AND job.request_epoch_id IS run.request_epoch_id
      AND job.resource_revision IS run.revision_key
      AND job.job_kind IS CASE WHEN request.workflow_kind IN ('pr_static_build', 'pr_ui')
        THEN 'pull_request_review' ELSE 'issue_triage' END) AS jobMatches,
    attempt.id AS runAttemptId, attempt.status AS attemptStatus,
    (SELECT COUNT(*) FROM run_attempts AS later WHERE later.job_id = job.id
      AND later.attempt_number > job.attempt_count) AS laterAttempts,
    result.id AS resultId, result.schema_id AS schemaId,
    result.result_digest AS resultDigest, result.created_at AS createdAt,
    length(CAST(result.result_json AS BLOB)) AS resultBytes,
    CASE WHEN length(CAST(result.result_json AS BLOB)) <= ${maximumRunCompletionResultUtf8Bytes}
      THEN result.result_json ELSE NULL END AS resultJson,
    (job.status IS 'succeeded' AND attempt.status IS 'succeeded'
      AND result.run_attempt_id IS attempt.id AND result.result_digest IS attempt.result_digest
      AND result.repository_id IS run.repository_id AND result.work_item_id IS run.work_item_id
      AND result.resource_revision IS run.revision_key AND result.revision_id IS run.revision_id
      AND result.review_run_id IS run.id AND result.request_id IS request.request_id
      AND result.activation_id IS run.activation_id AND result.job_activation IS link.activation_number
      AND result.plan_digest IS run.plan_digest
      AND result.schema_id IN ('ValidationJobResultV1', 'ValidationJobResultV2')
      AND result.job_kind IS job.job_kind AND result.workflow_kind IS request.workflow_kind
      AND result.target IS request.target AND result.profile_version_id IS request.profile_version_id
      AND result.prompt_version_id IS request.prompt_version_id
      AND result.execution_template_sha256 IS job.execution_digest) AS resultMatches,
    latest.job_id AS latestJobId, latest.activation_number AS latestActivationNumber,
    latest_job.status AS latestJobStatus, latest_job.attempt_count AS latestJobAttemptCount,
    (latest_job.id IS latest.job_id AND latest_job.work_item_id IS run.work_item_id
      AND latest_job.request_epoch_id IS run.request_epoch_id
      AND latest_job.resource_revision IS run.revision_key
      AND latest_job.job_kind IS job.job_kind) AS latestJobMatches
    FROM review_runs AS run
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = ?
    JOIN review_run_job_links AS link ON link.review_run_id = run.id
      AND link.request_id = request.request_id AND link.job_id = ?
    LEFT JOIN managed_repositories AS repository ON repository.id = run.repository_id
    LEFT JOIN work_items AS item ON item.id = run.work_item_id AND item.repository_id = run.repository_id
    LEFT JOIN request_epochs AS epoch ON epoch.id = run.request_epoch_id AND epoch.work_item_id = run.work_item_id
    LEFT JOIN work_item_revisions AS revision ON revision.id = run.revision_id
      AND revision.work_item_id = run.work_item_id AND revision.revision_key = run.revision_key
    LEFT JOIN work_item_revisions AS epoch_revision ON epoch_revision.id = epoch.current_revision_id
      AND epoch_revision.work_item_id = run.work_item_id
    LEFT JOIN github_review_run_sources AS source ON source.work_item_id = run.work_item_id
    LEFT JOIN github_review_run_activations AS automatic ON automatic.review_run_id = run.id
    LEFT JOIN jobs AS job ON job.id = link.job_id
    LEFT JOIN run_attempts AS attempt ON attempt.job_id = job.id AND attempt.attempt_number = job.attempt_count
    LEFT JOIN validation_job_results AS result ON result.job_id = job.id
    LEFT JOIN review_run_job_links AS latest ON latest.review_run_id = run.id
      AND latest.request_id = request.request_id AND latest.activation_number = (
        SELECT MAX(candidate.activation_number) FROM review_run_job_links AS candidate
        WHERE candidate.review_run_id = run.id AND candidate.request_id = request.request_id)
    LEFT JOIN jobs AS latest_job ON latest_job.id = latest.job_id
    WHERE run.repository_id = ? AND run.id = ? AND run.purpose = 'review' LIMIT 2`)
    .all(input.requestId, input.jobId, input.repositoryId, input.reviewRunId);
  if (rows.length > 1) corrupt();
  return rows[0] ?? null;
}

function extractOccurrences(
  result: ValidationJobResult,
  row: Row,
): { availability: FindingModelAvailability; occurrences: FindingOccurrenceContent[] } {
  if (result.report.workItemKind !== row.workItemKind) corrupt();
  const review = result.modelReview;
  const summary = getValidationModelSummary(result);
  const identity = { resultId: String(row.resultId), resultDigest: String(row.resultDigest) };
  if (summary !== null) {
    if (
      (result.schemaVersion === "ValidationJobResultV1" && review.state !== "not_requested") ||
      !["pr_ui", "issue_validation"].includes(String(row.workflowKind)) ||
      summary.workItemKind !== row.workItemKind
    )
      corrupt();
    return {
      availability: "complete",
      occurrences: summary.observations.map((observation, ordinal) => {
        if (observation.path === null && observation.line !== null) corrupt();
        const ref = { ...identity, kind: "validation_observation" as const, ordinal };
        return {
          ...ref,
          key: findingOccurrenceKey(ref),
          modelId: observation.id,
          title: observation.title,
          body: observation.body,
          priority: observation.priority,
          path: observation.path,
          line: observation.line,
          endLine: null,
          confidence: null,
        };
      }),
    };
  }
  if (
    review.state === "completed" &&
    (row.workflowKind === "pr_ui" || row.workflowKind === "issue_validation")
  )
    corrupt();
  if (row.workflowKind === "issue_triage")
    return { availability: "not_applicable", occurrences: [] };
  if (review.state !== "completed") return { availability: review.state, occurrences: [] };
  const model = getValidationReviewModel(result);
  if (model?.schemaVersion !== "PrReviewPlanV2") {
    return { availability: "not_applicable", occurrences: [] };
  }
  return {
    availability: "complete",
    occurrences: model.findings.map((finding, ordinal) => {
      if (finding.endLine !== null && finding.endLine < finding.line) corrupt();
      const ref = { ...identity, kind: "pr_finding" as const, ordinal };
      return {
        ...ref,
        key: findingOccurrenceKey(ref),
        modelId: finding.findingId,
        title: finding.title,
        body: finding.body,
        priority: finding.priority,
        path: finding.path,
        line: finding.line,
        endLine: finding.endLine,
        confidence: finding.confidence,
      };
    }),
  };
}

/** Requires the caller's transaction and authorization. It never begins or ends a transaction. */
export function readFindingResult(
  database: DatabaseSync,
  input: FindingResultScope,
): FindingResultRead | null {
  if (!database.isTransaction)
    invalid("A finding result read requires an existing database transaction.");
  if (!Value.Check(scopeSchema, input)) invalid("The finding result scope is invalid.");
  let row: Row | null;
  try {
    row = selectedResult(database, input);
  } catch {
    return corrupt();
  }
  if (row === null) return null;
  if (
    row.identityValid !== 1 ||
    row.planMatches !== 1 ||
    row.jobMatches !== 1 ||
    row.latestJobMatches !== 1 ||
    row.selectedJobId !== row.jobId ||
    !Value.Check(PositiveIntegerSchema, row.requestCount) ||
    row.requestCount > maximumReviewRunRequestCount ||
    !Value.Check(PositiveIntegerSchema, row.activationNumber) ||
    !Value.Check(JobStateSchema, row.jobStatus) ||
    !Value.Check(NonNegativeIntegerSchema, row.attemptCount) ||
    !Value.Check(Sha256Schema, row.executionDigest) ||
    !Value.Check(nullableId, row.runAttemptId) ||
    !Value.Check(nullableId, row.currentAttemptId) ||
    (row.runAttemptId !== null && !Value.Check(RunAttemptStateSchema, row.attemptStatus)) ||
    row.laterAttempts !== 0 ||
    (row.attemptCount === 0) !== (row.runAttemptId === null) ||
    (row.currentAttemptId !== null && row.currentAttemptId !== row.runAttemptId) ||
    (row.currentSourceSequence === null) !== (row.currentSourceRevisionKey === null) ||
    (row.sourceWorkItemId !== null && row.currentSourceSequence === null) ||
    (row.automaticRunId !== null &&
      (row.automaticIdentityValid !== 1 || row.automaticSourceSequence === null))
  )
    corrupt();
  flag(row.required);
  const authority = {
    activationId: row.activationId,
    requestEpochId: row.requestEpochId,
    currentRevisionKey: row.currentRevisionKey,
    currentSourceSequence: row.currentSourceSequence,
    currentSourceRevisionKey: row.currentSourceRevisionKey,
    automaticSourceSequence: row.automaticSourceSequence,
    itemState: row.itemState,
    epochStatus: row.epochStatus,
    repositoryEnabled: flag(row.repositoryEnabled),
    repositoryVersion: row.repositoryVersion,
    githubRepositoryId: row.githubRepositoryId,
    reviewerGithubUserId: row.reviewerGithubUserId,
    epochTargetGithubUserId: row.epochTargetGithubUserId,
    epochOrdinal: row.epochOrdinal,
    authorizationPolicyCurrent: flag(row.authorizationPolicyCurrent),
    latestJobId: row.latestJobId,
    latestActivationNumber: row.latestActivationNumber,
    latestJobStatus: row.latestJobStatus,
    latestJobAttemptCount: row.latestJobAttemptCount,
  };
  if (!Value.Check(authoritySchema, authority)) corrupt();
  if (row.resultId === null) {
    if (row.jobStatus === "succeeded") corrupt();
    return null;
  }
  if (
    row.resultMatches !== 1 ||
    typeof row.schemaId !== "string" ||
    typeof row.resultDigest !== "string" ||
    typeof row.resultJson !== "string" ||
    !Value.Check(PositiveIntegerSchema, row.resultBytes) ||
    row.resultBytes > maximumRunCompletionResultUtf8Bytes ||
    Buffer.byteLength(row.resultJson, "utf8") !== row.resultBytes ||
    sha256(row.resultJson) !== row.resultDigest
  )
    corrupt();
  let result: ValidationJobResult;
  try {
    result = decodeStoredValidationResult(row.schemaId, row.resultJson, row.resultDigest);
    readValidationModelResultBindingInTransaction(
      database,
      {
        repositoryId: input.repositoryId,
        runId: input.reviewRunId,
        requestId: input.requestId,
        jobId: input.jobId,
        runAttemptId: String(row.runAttemptId),
        resultDigest: String(row.resultDigest),
        executionDigest: String(row.executionDigest),
      },
      result,
    );
  } catch {
    return corrupt();
  }
  const { availability, occurrences } = extractOccurrences(result, row);
  if (
    occurrences.length > maximumFindingResultOccurrenceCount ||
    occurrences.some(
      (occurrence) =>
        !Value.Check(occurrenceSchema, occurrence) ||
        (occurrence.path !== null &&
          (!occurrence.path.isWellFormed() ||
            occurrence.path.includes(":") ||
            occurrence.path
              .split("/")
              .some((segment) => segment === "" || segment === "." || segment === ".."))),
    )
  )
    corrupt();
  const sourceCurrent =
    flag(row.sourceMatches) &&
    authority.itemState === "open" &&
    authority.epochStatus === "active" &&
    authority.repositoryEnabled &&
    authority.authorizationPolicyCurrent;
  const latestForRequest =
    row.latestJobId === row.jobId && row.latestActivationNumber === row.activationNumber;
  const content = {
    ...input,
    workItemId: row.workItemId,
    workItemKind: row.workItemKind,
    resultId: row.resultId,
    resultDigest: row.resultDigest,
    revisionKey: row.revisionKey,
    planDigest: row.planDigest,
    profileVersionId: row.profileVersionId,
    promptVersionId: row.promptVersionId,
    workflowKind: row.workflowKind,
    target: row.target,
    activationNumber: row.activationNumber,
    createdAt: row.createdAt,
    sourceCurrent,
    latestForRequest,
    historical: !sourceCurrent || !latestForRequest,
    modelAvailability: availability,
    findingCount: occurrences.length,
  };
  const context = {
    ...content,
    contextDigest: sha256(
      canonicalJson({
        schemaVersion: "FindingResultContextV1",
        ...content,
        runAttemptId: row.runAttemptId,
        executionDigest: row.executionDigest,
        authority,
      }),
    ),
  };
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  if (
    !Value.Check(contextSchema, context) ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt))
  )
    corrupt();
  return { context, occurrences };
}

function side(value: FindingOccurrenceContent | undefined): FindingComparisonSide {
  if (value === undefined) corrupt();
  return {
    key: value.key,
    resultId: value.resultId,
    resultDigest: value.resultDigest,
    kind: value.kind,
    ordinal: value.ordinal,
    title: value.title,
    priority: value.priority,
    path: value.path,
    line: value.line,
  };
}
function comparisonKey(value: FindingOccurrenceContent): string {
  const lineEndings = (text: string) => text.replace(/\r\n?/g, "\n");
  return canonicalJson({
    kind: value.kind,
    path: value.path,
    title: lineEndings(value.title),
    body: lineEndings(value.body),
  });
}
function groups(values: FindingOccurrenceContent[]) {
  const output = new Map<string, FindingOccurrenceContent[]>();
  for (const value of values) {
    const key = comparisonKey(value);
    const group = output.get(key) ?? [];
    group.push(value);
    output.set(key, group);
  }
  return output;
}

/** Compares complete immutable model arrays, never previews or mutable disposition projections. */
export function compareFindingResultSets(
  before: FindingResultRead,
  after: FindingResultRead,
): FindingResultComparison {
  if (
    before.context.repositoryId !== after.context.repositoryId ||
    before.context.workItemId !== after.context.workItemId
  )
    invalid("Finding comparison results must belong to the same repository and work item.");
  const reasons: FindingComparisonResponse["reasons"] = [];
  if (
    ["workflowKind", "target", "profileVersionId", "promptVersionId", "workItemKind"].some(
      (key) =>
        before.context[key as keyof FindingResultRead["context"]] !==
        after.context[key as keyof FindingResultRead["context"]],
    )
  )
    reasons.push("configuration_changed");
  if (
    before.context.modelAvailability !== "complete" ||
    after.context.modelAvailability !== "complete"
  )
    reasons.push("model_unavailable");
  if (before.context.resultId === after.context.resultId) reasons.push("same_result");
  if (Date.parse(before.context.createdAt) >= Date.parse(after.context.createdAt))
    reasons.push("baseline_not_earlier");
  const items: FindingComparisonRow[] = [];
  if (reasons.length > 0) {
    const reason = reasons.includes("configuration_changed")
      ? "configuration_changed"
      : reasons.includes("model_unavailable")
        ? "model_unavailable"
        : null;
    items.push(
      ...before.occurrences.map(
        (value): FindingComparisonRow => ({
          status: "incomparable",
          before: side(value),
          after: null,
          reason,
        }),
      ),
      ...after.occurrences.map(
        (value): FindingComparisonRow => ({
          status: "incomparable",
          before: null,
          after: side(value),
          reason,
        }),
      ),
    );
  } else {
    const beforeGroups = groups(before.occurrences);
    const afterGroups = groups(after.occurrences);
    for (const [key, first] of beforeGroups) {
      const second = afterGroups.get(key) ?? [];
      if (first.length === 1 && second.length === 1) {
        items.push({
          status: "persistent",
          before: side(first[0]),
          after: side(second[0]),
          reason: null,
        });
      } else if (first.length > 1 || second.length > 1) {
        items.push(
          ...first.map(
            (value): FindingComparisonRow => ({
              status: "incomparable",
              before: side(value),
              after: null,
              reason: "ambiguous_match",
            }),
          ),
          ...second.map(
            (value): FindingComparisonRow => ({
              status: "incomparable",
              before: null,
              after: side(value),
              reason: "ambiguous_match",
            }),
          ),
        );
      } else {
        items.push({
          status: "not_observed_again",
          before: side(first[0]),
          after: null,
          reason: null,
        });
      }
    }
    for (const [key, group] of afterGroups) {
      if (beforeGroups.has(key)) continue;
      items.push(
        ...group.map(
          (value): FindingComparisonRow => ({
            status: group.length === 1 ? "new" : "incomparable",
            before: null,
            after: side(value),
            reason: group.length === 1 ? null : "ambiguous_match",
          }),
        ),
      );
    }
  }
  if (items.length > maximumFindingComparisonRowCount) corrupt();
  return { algorithmVersion: "exact-content-v1", compatible: reasons.length === 0, reasons, items };
}
