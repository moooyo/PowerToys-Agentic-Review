import type { DatabaseSync } from "node:sqlite";
import {
  EntityIdSchema,
  JobStateSchema,
  maximumReviewRunRequestCount,
  RunAttemptStateSchema,
  Sha256Schema,
  ValidationTargetSchema,
  WorkflowKindSchema,
  WorkItemStateSchema,
} from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { currentRunFindingDispositionDigest } from "./finding-disposition-projection.js";
import { validateStoredValidationModelResultBindingInTransaction } from "./validation-model-result-binding.js";

const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const nonnegative = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const nullableDigest = Type.Union([Sha256Schema, Type.Null()]);
const nullableSequence = Type.Union([positive, Type.Null()]);
const scopeSchema = Type.Object(
  { repositoryId: EntityIdSchema, reviewRunId: EntityIdSchema },
  { additionalProperties: false },
);
export const ReviewRunDecisionSnapshotV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ReviewRunDecisionSnapshotV1"),
    repositoryId: EntityIdSchema,
    reviewRunId: EntityIdSchema,
    workItemId: EntityIdSchema,
    workItemKind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    activationId: EntityIdSchema,
    requestEpochId: EntityIdSchema,
    currentRevisionKey: Sha256Schema,
    currentSourceSequence: nullableSequence,
    currentSourceRevisionKey: nullableDigest,
    automaticSourceSequence: nullableSequence,
    itemState: WorkItemStateSchema,
    epochStatus: Type.Union([Type.Literal("active"), Type.Literal("closed")]),
    repositoryEnabled: Type.Boolean(),
    repositoryVersion: positive,
    authorizationPolicyCurrent: Type.Boolean(),
    requests: Type.Array(
      Type.Object(
        {
          requestId: EntityIdSchema,
          workflowKind: WorkflowKindSchema,
          target: ValidationTargetSchema,
          required: Type.Boolean(),
          profileVersionId: nullableId,
          promptVersionId: nullableId,
          latestJob: Type.Union([
            Type.Null(),
            Type.Object(
              {
                jobId: EntityIdSchema,
                activationNumber: positive,
                status: JobStateSchema,
                attemptCount: nonnegative,
                executionDigest: Sha256Schema,
                latestAttempt: Type.Union([
                  Type.Null(),
                  Type.Object(
                    { id: EntityIdSchema, number: positive, status: RunAttemptStateSchema },
                    { additionalProperties: false },
                  ),
                ]),
                result: Type.Union([
                  Type.Null(),
                  Type.Object(
                    { id: EntityIdSchema, digest: Sha256Schema, runAttemptId: EntityIdSchema },
                    { additionalProperties: false },
                  ),
                ]),
              },
              { additionalProperties: false },
            ),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: maximumReviewRunRequestCount },
    ),
  },
  { additionalProperties: false },
);

/** Durable identity only: evidence availability and current policy eligibility are evaluated afresh. */
export type ReviewRunDecisionSnapshotV1 = Static<typeof ReviewRunDecisionSnapshotV1Schema>;
// V1 remains an immutable historical format. Reading the current V2 basis deliberately makes
// every pre-disposition approval stale once, without rewriting its receipt or source identity.
export const ReviewRunDecisionSnapshotV2Schema = Type.Object(
  {
    ...ReviewRunDecisionSnapshotV1Schema.properties,
    schemaVersion: Type.Literal("ReviewRunDecisionSnapshotV2"),
    findingDispositionDigest: Sha256Schema,
  },
  { additionalProperties: false },
);
export type ReviewRunDecisionSnapshotV2 = Static<typeof ReviewRunDecisionSnapshotV2Schema>;
export const ReviewRunDecisionSnapshotSchema = Type.Union([
  ReviewRunDecisionSnapshotV1Schema,
  ReviewRunDecisionSnapshotV2Schema,
]);
export type ReviewRunDecisionStoredSnapshot = Static<typeof ReviewRunDecisionSnapshotSchema>;
export interface ReviewRunDecisionSnapshot {
  readonly snapshot: ReviewRunDecisionSnapshotV2;
  readonly resultSetDigest: string;
  readonly sourceCurrent: boolean;
}

class ReviewRunDecisionSnapshotError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "ReviewRunDecisionSnapshotError";
  }
}
function corrupt(): never {
  throw new ReviewRunDecisionSnapshotError(
    "PLATFORM_CORRUPT",
    "The stored review run decision snapshot is invalid.",
  );
}
function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1) corrupt();
  return value === 1;
}

type Row = Record<string, unknown>;

function readRun(database: DatabaseSync, repositoryId: string, reviewRunId: string): Row | null {
  const row = database
    .prepare(`SELECT run.repository_id AS repositoryId, run.id AS reviewRunId,
      run.work_item_id AS workItemId, run.revision_key AS revisionKey,
      run.plan_digest AS planDigest, run.activation_id AS activationId,
      run.request_epoch_id AS requestEpochId, run.request_count AS requestCount,
      item.current_revision_key AS currentRevisionKey, item.resource_kind AS workItemKind, item.state AS itemState,
      epoch.status AS epochStatus, repository.enabled AS repositoryEnabled,
      repository.version AS repositoryVersion,
      source.work_item_id AS sourceWorkItemId,
      source.sequence AS currentSourceSequence, source.current_revision_key AS currentSourceRevisionKey,
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
        AND item.current_revision_key IS run.revision_key
        AND epoch_revision.revision_key IS run.revision_key
        AND (automatic.review_run_id IS NULL OR (
          automatic.mode IS 'review_run' AND automatic.work_item_id IS run.work_item_id
          AND automatic.request_epoch_id IS run.request_epoch_id
          AND automatic.revision_key IS run.revision_key
          AND automatic.source_sequence IS source.sequence))) AS sourceCurrent
      FROM review_runs AS run
      LEFT JOIN managed_repositories AS repository ON repository.id = run.repository_id
      LEFT JOIN work_items AS item ON item.id = run.work_item_id AND item.repository_id = run.repository_id
      LEFT JOIN request_epochs AS epoch ON epoch.id = run.request_epoch_id AND epoch.work_item_id = run.work_item_id
      LEFT JOIN work_item_revisions AS revision ON revision.id = run.revision_id
        AND revision.work_item_id = run.work_item_id AND revision.revision_key = run.revision_key
      LEFT JOIN work_item_revisions AS epoch_revision ON epoch_revision.id = epoch.current_revision_id
        AND epoch_revision.work_item_id = run.work_item_id
      LEFT JOIN github_review_run_sources AS source ON source.work_item_id = run.work_item_id
      LEFT JOIN github_review_run_activations AS automatic ON automatic.review_run_id = run.id
      WHERE run.repository_id = ? AND run.id = ? AND run.purpose = 'review' LIMIT 2`)
    .all(repositoryId, reviewRunId);
  if (row.length > 1) corrupt();
  return row[0] ?? null;
}

function readRequests(database: DatabaseSync, reviewRunId: string): Row[] {
  return database
    .prepare(`SELECT request.request_id AS requestId, request.workflow_kind AS workflowKind,
      request.target, request.required, request.profile_version_id AS profileVersionId,
      request.prompt_version_id AS promptVersionId,
      (SELECT COUNT(*) FROM json_each(run.plan_json, '$.jobs') AS planned
        WHERE json_extract(planned.value, '$.requestId') IS request.request_id
          AND json_extract(planned.value, '$.workflowKind') IS request.workflow_kind
          AND json_extract(planned.value, '$.target') IS request.target
          AND json_extract(planned.value, '$.required') IS request.required
          AND json_extract(planned.value, '$.profileVersion.id') IS request.profile_version_id
          AND json_extract(planned.value, '$.prompt.version.id') IS request.prompt_version_id
          AND json(planned.value) IS json(request.request_json)) AS planMatches,
      link.activation_number AS activationNumber, link.job_id AS linkedJobId,
      job.id AS jobId, job.status, job.attempt_count AS attemptCount,
      job.execution_digest AS executionDigest, job.current_run_attempt_id AS currentAttemptId,
      (job.work_item_id IS run.work_item_id AND job.request_epoch_id IS run.request_epoch_id
        AND job.resource_revision IS run.revision_key
        AND job.job_kind IS CASE WHEN request.workflow_kind IN ('pr_static_build', 'pr_ui')
          THEN 'pull_request_review' ELSE 'issue_triage' END) AS jobMatches,
      attempt.id AS attemptId, attempt.attempt_number AS attemptNumber, attempt.status AS attemptStatus,
      (SELECT COUNT(*) FROM run_attempts AS later WHERE later.job_id = job.id
        AND later.attempt_number > job.attempt_count) AS laterAttempts,
      result.id AS resultId, result.schema_id AS schemaId, result.result_digest AS resultDigest,
      result.run_attempt_id AS resultAttemptId,
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
        AND result.execution_template_sha256 IS job.execution_digest) AS resultMatches
      FROM review_run_requests AS request JOIN review_runs AS run ON run.id = request.review_run_id
      LEFT JOIN review_run_job_links AS link ON link.review_run_id = request.review_run_id
        AND link.request_id = request.request_id AND link.activation_number = (
          SELECT MAX(latest.activation_number) FROM review_run_job_links AS latest
          WHERE latest.review_run_id = request.review_run_id AND latest.request_id = request.request_id)
      LEFT JOIN jobs AS job ON job.id = link.job_id
      LEFT JOIN run_attempts AS attempt ON attempt.job_id = job.id AND attempt.attempt_number = job.attempt_count
      LEFT JOIN validation_job_results AS result ON result.job_id = job.id
      WHERE request.review_run_id = ? AND run.purpose = 'review' ORDER BY request.request_id LIMIT 33`)
    .all(reviewRunId);
}

/** Reads relational facts and independently admits V2 model bindings in the caller's transaction.
 * Historical V1 result bodies remain unread.
 * Source transitions and new activations invalidate decisions immediately. Heartbeats, elapsed
 * time, presentation fields, and evidence-cache state never participate in this digest. */
export function readReviewRunDecisionSnapshotInTransaction(
  database: DatabaseSync,
  input: { readonly repositoryId: string; readonly reviewRunId: string },
): ReviewRunDecisionSnapshot | null {
  if (!database.isTransaction)
    throw new ReviewRunDecisionSnapshotError(
      "PLATFORM_INVALID",
      "A review run decision snapshot requires an existing database transaction.",
    );
  if (!Value.Check(scopeSchema, input))
    throw new ReviewRunDecisionSnapshotError(
      "PLATFORM_INVALID",
      "The review run scope is invalid.",
    );
  let run: Row | null;
  let rows: Row[];
  try {
    run = readRun(database, input.repositoryId, input.reviewRunId);
    if (run === null) return null;
    rows = readRequests(database, input.reviewRunId);
  } catch {
    return corrupt();
  }
  if (
    run.identityValid !== 1 ||
    rows.length !== run.requestCount ||
    new Set(rows.map((row) => row.requestId)).size !== rows.length ||
    (run.currentSourceSequence === null) !== (run.currentSourceRevisionKey === null) ||
    (run.sourceWorkItemId !== null && run.currentSourceSequence === null) ||
    (run.automaticRunId !== null &&
      (run.automaticIdentityValid !== 1 || run.automaticSourceSequence === null))
  )
    corrupt();
  const requests = rows.map((row) => {
    if (row.planMatches !== 1) corrupt();
    if (row.jobId === null && (row.linkedJobId !== null || row.activationNumber !== null))
      corrupt();
    if (row.jobId !== null) {
      if (
        row.jobMatches !== 1 ||
        row.laterAttempts !== 0 ||
        (row.attemptCount === 0) !== (row.attemptId === null) ||
        (row.currentAttemptId !== null && row.currentAttemptId !== row.attemptId) ||
        (row.status === "succeeded" && row.resultId === null) ||
        (row.resultId !== null && row.resultMatches !== 1)
      )
        corrupt();
    }
    if (row.resultId !== null) {
      try {
        validateStoredValidationModelResultBindingInTransaction(database, {
          resultId: String(row.resultId),
          schemaId: String(row.schemaId),
          repositoryId: input.repositoryId,
          runId: input.reviewRunId,
          requestId: String(row.requestId),
          jobId: String(row.jobId),
          runAttemptId: String(row.resultAttemptId),
          resultDigest: String(row.resultDigest),
          executionDigest: String(row.executionDigest),
        });
      } catch {
        corrupt();
      }
    }
    return {
      requestId: row.requestId,
      workflowKind: row.workflowKind,
      target: row.target,
      required: flag(row.required),
      profileVersionId: row.profileVersionId,
      promptVersionId: row.promptVersionId,
      latestJob:
        row.jobId === null
          ? null
          : {
              jobId: row.jobId,
              activationNumber: row.activationNumber,
              status: row.status,
              attemptCount: row.attemptCount,
              executionDigest: row.executionDigest,
              latestAttempt:
                row.attemptId === null
                  ? null
                  : { id: row.attemptId, number: row.attemptNumber, status: row.attemptStatus },
              result:
                row.resultId === null
                  ? null
                  : {
                      id: row.resultId,
                      digest: row.resultDigest,
                      runAttemptId: row.resultAttemptId,
                    },
            },
    };
  });
  const snapshot = {
    schemaVersion: "ReviewRunDecisionSnapshotV2",
    findingDispositionDigest: currentRunFindingDispositionDigest(database, input),
    repositoryId: run.repositoryId,
    reviewRunId: run.reviewRunId,
    workItemId: run.workItemId,
    workItemKind: run.workItemKind,
    revisionKey: run.revisionKey,
    planDigest: run.planDigest,
    activationId: run.activationId,
    requestEpochId: run.requestEpochId,
    currentRevisionKey: run.currentRevisionKey,
    currentSourceSequence: run.currentSourceSequence,
    currentSourceRevisionKey: run.currentSourceRevisionKey,
    automaticSourceSequence: run.automaticSourceSequence,
    itemState: run.itemState,
    epochStatus: run.epochStatus,
    repositoryEnabled: flag(run.repositoryEnabled),
    repositoryVersion: run.repositoryVersion,
    authorizationPolicyCurrent: flag(run.authorizationPolicyCurrent),
    requests,
  };
  if (!Value.Check(ReviewRunDecisionSnapshotV2Schema, snapshot)) corrupt();
  const serialized = canonicalJson(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > 131_072) corrupt();
  return {
    snapshot,
    resultSetDigest: sha256(serialized),
    sourceCurrent: flag(run.sourceCurrent),
  };
}
