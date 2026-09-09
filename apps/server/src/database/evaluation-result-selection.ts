import type { DatabaseSync } from "node:sqlite";
import type { ValidationJobResult } from "@agentic-review/codex";
import * as C from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  type EvaluationExecutionCell,
  readEvaluationJobBindingInTransaction,
} from "./evaluation-execution.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import { readValidationModelResultBindingInTransaction } from "./validation-model-result-binding.js";
import type { ValidationEvidenceReferenceScope } from "./validation-results.js";

export interface EvaluationResultRow {
  readonly id: string;
  readonly repositoryId: string;
  readonly evaluationId: string;
  readonly cellId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly workItemId: string;
  readonly revisionId: string;
  readonly revisionKey: string;
  readonly activationId: string;
  readonly planDigest: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly profileVersionId: string;
  readonly promptVersionId: string;
  readonly workflowKind: C.WorkflowKind;
  readonly target: C.ValidationTarget;
  readonly executionDigest: string;
  readonly resultDigest: string;
  readonly evidenceComplete: number;
  readonly schemaId: string;
  readonly createdAt: string;
  readonly configurationDigest: string;
  readonly cellManifestDigest: string;
  readonly executionManifestDigest: string;
}

export interface EvaluationResultSelection {
  readonly identityDigest: string;
  readonly row: EvaluationResultRow;
  readonly cell: EvaluationExecutionCell;
  readonly template: C.JobExecutionTemplateV2;
  readonly result: ValidationJobResult;
  readonly scopes: readonly ValidationEvidenceReferenceScope[];
}

function corrupt(): never {
  throw new EvaluationManagementError(
    "PLATFORM_CORRUPT",
    "The stored evaluation result binding is inconsistent.",
  );
}

function readRow(
  database: DatabaseSync,
  query: C.EvaluationCellResultReadQuery,
): EvaluationResultRow | null {
  if (!database.isTransaction || C.getEvaluationCellResultReadQueryIssues(query).length) corrupt();
  // A historical result remains readable after cancellation or repository disablement. Its
  // purpose, complete immutable scope, successful attempt and selected Job must still agree.
  const row = database
    .prepare(`SELECT result.id, result.repository_id AS repositoryId,
    cell.evaluation_id AS evaluationId, cell.id AS cellId, run.id AS runId,
    result.request_id AS requestId, result.job_id AS jobId, result.run_attempt_id AS runAttemptId,
    result.work_item_id AS workItemId, result.revision_id AS revisionId,
    result.resource_revision AS revisionKey, result.activation_id AS activationId,
    result.plan_digest AS planDigest, cell.source_id AS sourceId, cell.source_digest AS sourceDigest,
    result.profile_version_id AS profileVersionId, result.prompt_version_id AS promptVersionId,
    result.workflow_kind AS workflowKind, result.target, result.execution_template_sha256 AS executionDigest,
    result.result_digest AS resultDigest, result.evidence_complete AS evidenceComplete,
    result.schema_id AS schemaId,
    result.created_at AS createdAt, evaluation.configuration_manifest_sha256 AS configurationDigest,
    evaluation.cell_manifest_sha256 AS cellManifestDigest,
    evaluation.execution_manifest_sha256 AS executionManifestDigest
    FROM evaluation_cells AS cell
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id
      AND evaluation.repository_id = cell.repository_id
    JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    JOIN review_runs AS run ON run.id = cell.run_id AND run.evaluation_cell_id = cell.id
      AND run.repository_id = cell.repository_id AND run.purpose = 'evaluation'
      AND run.request_epoch_id IS NULL
    JOIN review_run_requests AS request ON request.review_run_id = run.id
      AND request.request_id = cell.request_id AND request.profile_version_id = cell.profile_version_id
      AND request.prompt_version_id = cell.prompt_version_id
    JOIN review_run_job_links AS link ON link.review_run_id = run.id
      AND link.request_id = request.request_id AND link.activation_number = 1
    JOIN jobs AS job ON job.id = link.job_id AND job.status = 'succeeded'
      AND job.work_item_id = run.work_item_id AND job.resource_revision = run.revision_key
      AND job.request_epoch_id IS NULL
    JOIN validation_job_results AS result ON result.job_id = job.id
      AND result.repository_id = run.repository_id AND result.review_run_id = run.id
      AND result.request_id = request.request_id AND result.work_item_id = run.work_item_id
      AND result.revision_id = run.revision_id AND result.resource_revision = run.revision_key
      AND result.activation_id = run.activation_id AND result.activation_id = cell.activation_id
      AND result.job_activation = 1 AND result.plan_digest = run.plan_digest
      AND result.profile_version_id = request.profile_version_id
      AND result.prompt_version_id = request.prompt_version_id
      AND result.workflow_kind = request.workflow_kind AND result.target = request.target
      AND result.execution_template_sha256 = job.execution_digest AND result.job_kind = job.job_kind
      AND result.schema_id IN ('ValidationJobResultV1', 'ValidationJobResultV2')
    JOIN run_attempts AS attempt ON attempt.id = result.run_attempt_id AND attempt.job_id = job.id
      AND attempt.status = 'succeeded' AND attempt.attempt_number = job.attempt_count
      AND attempt.result_digest = result.result_digest
    WHERE cell.repository_id = ? AND cell.evaluation_id = ? AND cell.id = ? AND result.id = ?
      AND cell.applicable = 1`)
    .get(query.repositoryId, query.evaluationId, query.cellId, query.resultId) as unknown as
    | EvaluationResultRow
    | undefined;
  return row ?? null;
}

/** Cheap identity probe for the coordinator's operation-scoped proof; no result bodies are read. */
export function readEvaluationResultIdentityInTransaction(
  database: DatabaseSync,
  query: C.EvaluationCellResultReadQuery,
): { identityDigest: string; requestId: string; jobId: string } | null {
  const row = readRow(database, query);
  return row === null
    ? null
    : {
        identityDigest: sha256(canonicalJson(row)),
        requestId: row.requestId,
        jobId: row.jobId,
      };
}

function parseBounded<T>(
  serialized: string | null,
  digest: string,
  schema: Parameters<typeof Value.Check>[0],
): T {
  if (serialized === null || sha256(serialized) !== digest) corrupt();
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Value.Check(schema, value) || canonicalJson(value) !== serialized) corrupt();
    return value as T;
  } catch {
    corrupt();
  }
}

/** The caller establishes current read permission before using this internal owner selection. */
export function readEvaluationResultSelectionInTransaction(
  database: DatabaseSync,
  query: C.EvaluationCellResultReadQuery,
): EvaluationResultSelection | null {
  const row = readRow(database, query);
  if (row === null) return null;
  const serialized = database
    .prepare(`SELECT
    CASE WHEN length(CAST(result.result_json AS BLOB)) <= ${C.maximumEvaluationReadUtf8Bytes}
      THEN result.result_json END AS resultJson,
    CASE WHEN length(CAST(job.execution_json AS BLOB)) <= ${C.maximumReviewRunPlanUtf8Bytes}
      THEN job.execution_json END AS executionJson
    FROM validation_job_results AS result JOIN jobs AS job ON job.id = result.job_id
    WHERE result.id = ? AND job.id = ?`)
    .get(row.id, row.jobId) as
    | { resultJson: string | null; executionJson: string | null }
    | undefined;
  if (!serialized) corrupt();
  let result: ValidationJobResult;
  try {
    result = decodeStoredValidationResult(row.schemaId, serialized.resultJson, row.resultDigest);
    readValidationModelResultBindingInTransaction(
      database,
      {
        repositoryId: row.repositoryId,
        runId: row.runId,
        requestId: row.requestId,
        jobId: row.jobId,
        runAttemptId: row.runAttemptId,
        resultDigest: row.resultDigest,
        executionDigest: row.executionDigest,
      },
      result,
    );
  } catch {
    corrupt();
  }
  const template = parseBounded<C.JobExecutionTemplateV2>(
    serialized.executionJson,
    row.executionDigest,
    C.JobExecutionTemplateV2Schema,
  );
  const cell = readEvaluationJobBindingInTransaction(database, row.jobId, template);
  if (
    cell.evaluationId !== query.evaluationId ||
    cell.cellId !== query.cellId ||
    cell.requestId !== row.requestId ||
    cell.runId !== row.runId ||
    !cell.applicable ||
    cell.reproductionReadiness.state === "blocked" ||
    cell.plan.source.sourceDigest !== row.sourceDigest ||
    cell.planDigest !== row.planDigest ||
    result.report.workItemKind !== cell.plan.workItem.kind ||
    ![0, 1].includes(row.evidenceComplete)
  )
    corrupt();
  return {
    row,
    cell,
    template,
    result,
    identityDigest: sha256(canonicalJson(row)),
    scopes: result.report.checks
      .filter((check) => check.evidenceIds.length > 0)
      .map((check) => ({
        repositoryId: row.repositoryId,
        runId: row.runId,
        requestId: row.requestId,
        jobId: row.jobId,
        runAttemptId: row.runAttemptId,
        profileVersionId: row.profileVersionId,
        checkId: check.id,
        evidenceIds: check.evidenceIds,
      })),
  };
}
