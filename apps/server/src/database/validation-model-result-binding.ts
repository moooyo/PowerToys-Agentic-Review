import type { DatabaseSync } from "node:sqlite";
import {
  getValidationJobResultV2Issues,
  IssueTriageV2ModelOutputSchema,
  IssueTriageV2ModelResultSchema,
  PrReviewPlanV2ModelOutputSchema,
  PrReviewPlanV2ModelResultSchema,
  type ValidationJobResult,
} from "@agentic-review/codex";
import * as C from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { readEvaluationJobBindingInTransaction } from "./evaluation-execution.js";
import { readModelInvocationHistoryInTransaction } from "./model-invocations.js";
import {
  validateReviewModelBusinessRules,
  validateValidationModelSummaryBusinessRules,
} from "./review-results.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import { readFrozenValidationSummaryInputInTransaction } from "./validation-summary-inputs.js";

export interface ValidationModelResultScope {
  readonly repositoryId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly resultDigest: string;
  readonly executionDigest: string;
}
export interface StoredValidationModelResultScope extends ValidationModelResultScope {
  readonly resultId: string;
  readonly schemaId: string;
}
export interface ValidationModelResultBinding {
  readonly invocationId: string;
  readonly scopeSha256: string;
  readonly receiptSetSha256: string;
  readonly modelOutputSha256: string;
  readonly collectionConsistency: C.ModelInvocationConsistency;
  /** Content consistency does not authenticate the collector or authorize execution. */
  readonly executionAccepted: false;
}
export class ValidationModelResultBindingError extends Error {
  readonly code = "VALIDATION_MODEL_RESULT_BINDING_INVALID";
  constructor() {
    super("The raw validation model result does not match its immutable invocation binding.");
    this.name = "ValidationModelResultBindingError";
  }
}
function reject(): never {
  throw new ValidationModelResultBindingError();
}
const hashPattern = /^[a-f0-9]{64}(?![\s\S])/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
function scopeIsValid(scope: ValidationModelResultScope): boolean {
  return (
    [scope.repositoryId, scope.runId, scope.requestId, scope.jobId, scope.runAttemptId].every(
      (id) => idPattern.test(id),
    ) &&
    hashPattern.test(scope.resultDigest) &&
    hashPattern.test(scope.executionDigest)
  );
}
const outputSchemas = {
  pr_static_build: PrReviewPlanV2ModelOutputSchema,
  issue_triage: IssueTriageV2ModelOutputSchema,
  pr_ui: C.PullRequestValidationSummaryV1Schema,
  issue_validation: C.IssueValidationSummaryV1Schema,
} as const;

/** The caller supplies a decoded result and its actual owner row or fenced completion scope.
 * This helper is synchronous and grants neither lease nor persistence authority. */
export function readValidationModelResultBindingInTransaction(
  database: DatabaseSync,
  scope: ValidationModelResultScope,
  result: ValidationJobResult,
  now?: string,
): ValidationModelResultBinding | null {
  if (result.schemaVersion === "ValidationJobResultV1") return null;
  if (
    !database.isTransaction ||
    !scopeIsValid(scope) ||
    getValidationJobResultV2Issues(result).length ||
    sha256(canonicalJson(result)) !== scope.resultDigest
  )
    reject();
  if (result.modelReview.state !== "completed") return null;
  try {
    const row = database
      .prepare(`SELECT job.execution_digest, CASE WHEN length(CAST(job.execution_json AS BLOB)) <= ${C.maximumReviewRunPlanUtf8Bytes} THEN job.execution_json END AS execution_json,
      cell.id AS cell_id, cell.evaluation_id, attempt.worker_node_id, attempt.worker_instance_id, attempt.lease_generation
      FROM jobs AS job JOIN run_attempts AS attempt ON attempt.job_id = job.id AND attempt.id = ?
      JOIN review_run_job_links AS link ON link.job_id = job.id AND link.activation_number = 1
      JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'evaluation'
      JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
      JOIN evaluation_cells AS cell ON cell.run_id = run.id AND cell.id = run.evaluation_cell_id
        AND cell.request_id = request.request_id AND cell.repository_id = run.repository_id
      WHERE job.id = ? AND run.repository_id = ? AND run.id = ? AND request.request_id = ?
        AND job.request_epoch_id IS NULL AND run.request_epoch_id IS NULL AND job.source_event_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM job_request_epochs WHERE job_id = job.id)`)
      .get(scope.runAttemptId, scope.jobId, scope.repositoryId, scope.runId, scope.requestId) as
      | {
          execution_json: string | null;
          execution_digest: string;
          cell_id: string;
          evaluation_id: string;
          worker_node_id: string;
          worker_instance_id: string;
          lease_generation: number;
        }
      | undefined;
    if (
      !row ||
      row.execution_json === null ||
      row.execution_digest !== scope.executionDigest ||
      sha256(row.execution_json) !== scope.executionDigest
    )
      reject();
    const parsed: unknown = JSON.parse(row.execution_json);
    if (
      !Value.Check(C.JobExecutionTemplateV2Schema, parsed) ||
      parsed.validation.schemaVersion !== "ValidationJobContextV2" ||
      canonicalJson(parsed) !== row.execution_json
    )
      reject();
    const cell = readEvaluationJobBindingInTransaction(database, scope.jobId, parsed, now);
    if (
      cell.cellId !== row.cell_id ||
      cell.evaluationId !== row.evaluation_id ||
      cell.repositoryId !== scope.repositoryId ||
      cell.runId !== scope.runId ||
      cell.requestId !== scope.requestId ||
      cell.reproductionReadiness.state === "blocked"
    )
      reject();
    const schema = outputSchemas[cell.request.workflowKind];
    if (
      canonicalJson(cell.prompt.outputSchema) !== canonicalJson(schema) ||
      sha256(canonicalJson(schema)) !== cell.prompt.outputSchemaSha256
    )
      reject();
    const raw = result.modelReview.result;
    switch (cell.request.workflowKind) {
      case "pr_static_build":
        if (!Value.Check(PrReviewPlanV2ModelResultSchema, raw)) reject();
        validateReviewModelBusinessRules(raw, parsed.executionPolicy.allowedRecipeIds);
        break;
      case "issue_triage":
        if (!Value.Check(IssueTriageV2ModelResultSchema, raw)) reject();
        validateReviewModelBusinessRules(raw, parsed.executionPolicy.allowedRecipeIds);
        break;
      case "pr_ui":
        if (!Value.Check(C.PullRequestValidationSummaryV1Schema, raw)) reject();
        validateValidationModelSummaryBusinessRules(raw);
        break;
      case "issue_validation":
        if (!Value.Check(C.IssueValidationSummaryV1Schema, raw)) reject();
        validateValidationModelSummaryBusinessRules(raw);
        break;
    }
    const reference = result.modelReview.invocation;
    const recorded = readModelInvocationHistoryInTransaction(
      database,
      {
        repositoryId: scope.repositoryId,
        evaluationId: cell.evaluationId,
        cellId: cell.cellId,
        invocationId: reference.invocationId,
      },
      now,
    );
    const opened = recorded.opening,
      seal = recorded.seal,
      submission = recorded.submission;
    if (opened.scope.schemaVersion === "ModelInvocationScopeV2") {
      const saved = readFrozenValidationSummaryInputInTransaction(
        database,
        opened.scope.inputRef.inputId,
      );
      if (!saved || saved.inputSha256 !== opened.scope.inputRef.inputSha256) reject();
      const context = saved.document.context;
      if (
        canonicalJson(result.report) !== canonicalJson(context.report) ||
        result.execution.cleanupState !== context.execution.cleanupState ||
        canonicalJson(result.execution.blockers.filter((item) => item.phase !== "model_review")) !==
          canonicalJson(context.execution.blockers) ||
        canonicalJson(
          result.execution.diagnostics.filter((item) => item.phase !== "model_review"),
        ) !== canonicalJson(context.execution.diagnostics) ||
        canonicalJson(result.probeReceipts ?? null) !==
          canonicalJson(context.observationResults?.probeReceipts ?? null) ||
        canonicalJson(
          "reproductionAssessment" in result ? (result.reproductionAssessment ?? null) : null,
        ) !== canonicalJson(context.observationResults?.reproductionAssessment ?? null)
      )
        reject();
    }
    const modelOutputSha256 = sha256(canonicalJson(raw));
    if (
      !seal ||
      !submission ||
      submission.consistency.state !== "matched" ||
      submission.executionAccepted !== false ||
      opened.scope.jobId !== scope.jobId ||
      opened.scope.attemptId !== scope.runAttemptId ||
      opened.scope.runId !== scope.runId ||
      opened.scope.requestId !== scope.requestId ||
      opened.scope.workerNodeId !== row.worker_node_id ||
      opened.scope.workerInstanceId !== row.worker_instance_id ||
      opened.scope.leaseGeneration !== row.lease_generation ||
      opened.scope.promptSha256 !== cell.prompt.promptSha256 ||
      opened.scope.outputSchemaSha256 !== cell.prompt.outputSchemaSha256 ||
      reference.scopeSha256 !== opened.scopeSha256 ||
      reference.receiptSetSha256 !== seal.receiptSetSha256 ||
      reference.receiptSetSha256 !== submission.receiptSetSha256 ||
      reference.modelOutputSha256 !== modelOutputSha256 ||
      seal.modelOutputSha256 !== modelOutputSha256 ||
      seal.state !== "closed" ||
      !seal.processClosed ||
      !seal.relayClosed ||
      seal.callCount === 0
    )
      reject();
    return Object.freeze({
      invocationId: reference.invocationId,
      scopeSha256: reference.scopeSha256,
      receiptSetSha256: reference.receiptSetSha256,
      modelOutputSha256,
      collectionConsistency: Object.freeze(submission.consistency),
      executionAccepted: false as const,
    });
  } catch {
    return reject();
  }
}

/** Relation-only V1 callers retain their historical behavior and do not read a body or invocation
 * table. V2 callers must bind the actual stored body; stored creation time supplies its upper bound. */
export function validateStoredValidationModelResultBindingInTransaction(
  database: DatabaseSync,
  scope: StoredValidationModelResultScope,
): ValidationModelResultBinding | null {
  if (scope.schemaId === "ValidationJobResultV1") return null;
  if (
    !database.isTransaction ||
    scope.schemaId !== "ValidationJobResultV2" ||
    !scopeIsValid(scope) ||
    !idPattern.test(scope.resultId)
  )
    reject();
  const row = database
    .prepare(`SELECT result.schema_id, result.created_at,
    CASE WHEN length(CAST(result.result_json AS BLOB)) <= ${C.maximumRunCompletionResultUtf8Bytes} THEN result.result_json END AS result_json
    FROM validation_job_results AS result JOIN jobs AS job ON job.id = result.job_id AND job.execution_digest = result.execution_template_sha256
    JOIN run_attempts AS attempt ON attempt.id = result.run_attempt_id AND attempt.job_id = job.id AND attempt.status = 'succeeded'
      AND attempt.result_digest = result.result_digest AND CAST(attempt.result_json AS BLOB) = CAST(result.result_json AS BLOB)
    WHERE result.id = ? AND result.schema_id = ? AND result.repository_id = ? AND result.review_run_id = ? AND result.request_id = ?
      AND result.job_id = ? AND result.run_attempt_id = ? AND result.result_digest = ? AND result.execution_template_sha256 = ?`)
    .get(
      scope.resultId,
      scope.schemaId,
      scope.repositoryId,
      scope.runId,
      scope.requestId,
      scope.jobId,
      scope.runAttemptId,
      scope.resultDigest,
      scope.executionDigest,
    ) as { schema_id: string; created_at: string; result_json: string | null } | undefined;
  if (!row) reject();
  const result = decodeStoredValidationResult(row.schema_id, row.result_json, scope.resultDigest);
  return readValidationModelResultBindingInTransaction(database, scope, result, row.created_at);
}
