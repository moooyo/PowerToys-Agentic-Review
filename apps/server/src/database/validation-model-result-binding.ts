import type { DatabaseSync } from "node:sqlite";
import {
  composeSummaryPrompt,
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
  readonly execution: C.CliModelExecutionV1;
}
export class ValidationModelResultBindingError extends Error {
  readonly code = "VALIDATION_MODEL_RESULT_BINDING_INVALID";
  constructor() {
    super("The raw validation model result does not match its task and CLI execution metadata.");
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
      cell.id AS cell_id, cell.evaluation_id, attempt.worker_node_id, attempt.worker_instance_id, attempt.lease_generation, attempt.started_at
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
          started_at: string;
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
    const execution = result.modelReview.execution;
    if (
      execution.jobId !== scope.jobId ||
      execution.runAttemptId !== scope.runAttemptId ||
      execution.outputSchemaSha256 !== cell.prompt.outputSchemaSha256 ||
      execution.outputSha256 !== sha256(canonicalJson(raw))
    )
      reject();
    if (cell.request.workflowKind === "pr_ui" || cell.request.workflowKind === "issue_validation") {
      const reference = execution.summaryInputRef;
      if (!reference) reject();
      const saved = readFrozenValidationSummaryInputInTransaction(database, reference.inputId);
      if (!saved) reject();
      const frozen = saved.document,
        context = frozen.context;
      const expectedPromptSha256 = sha256(
        composeSummaryPrompt(cell.prompt.renderedPrompt, canonicalJson(context)),
      );
      if (
        saved.inputSha256 !== reference.inputSha256 ||
        frozen.repositoryId !== scope.repositoryId ||
        frozen.evaluationId !== cell.evaluationId ||
        frozen.cellId !== cell.cellId ||
        frozen.authorizationId !== cell.plan.authorization.id ||
        frozen.executionManifestSha256 !== cell.plan.purpose.executionManifestSha256 ||
        frozen.workerNodeId !== row.worker_node_id ||
        frozen.workerInstanceId !== row.worker_instance_id ||
        frozen.leaseGeneration !== row.lease_generation ||
        frozen.sourcePromptSha256 !== cell.prompt.promptSha256 ||
        frozen.outputSchemaSha256 !== cell.prompt.outputSchemaSha256 ||
        frozen.actualPromptSha256 !== expectedPromptSha256 ||
        execution.promptSha256 !== expectedPromptSha256 ||
        context.jobId !== scope.jobId ||
        context.runAttemptId !== scope.runAttemptId ||
        context.runId !== scope.runId ||
        context.requestId !== scope.requestId ||
        context.githubRepositoryId !== parsed.repository.githubRepositoryId ||
        context.profileVersionId !== cell.request.profileVersion.id ||
        context.planDigest !== cell.planDigest ||
        context.revisionKey !== parsed.validation.revisionKey ||
        canonicalJson(context.testedSourceRevision) !==
          canonicalJson(parsed.validation.testedSourceRevision) ||
        canonicalJson(context.reproduction ?? null) !==
          canonicalJson(parsed.validation.reproduction ?? null) ||
        frozen.frozenAt < row.started_at ||
        (now !== undefined && frozen.frozenAt > now) ||
        canonicalJson(reference) !==
          canonicalJson({
            schemaVersion: "ValidationSummaryInputReferenceV1",
            inputId: frozen.inputId,
            inputSha256: saved.inputSha256,
            sourcePromptSha256: frozen.sourcePromptSha256,
            outputSchemaSha256: frozen.outputSchemaSha256,
            contextSha256: frozen.contextSha256,
            actualPromptSha256: frozen.actualPromptSha256,
          })
      )
        reject();
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
    } else if (
      execution.summaryInputRef !== undefined ||
      execution.promptSha256 !== cell.prompt.promptSha256
    ) {
      reject();
    }
    return Object.freeze({ execution: Object.freeze(structuredClone(execution)) });
  } catch {
    return reject();
  }
}

/** V2 callers bind the stored body to its task and prompt; creation time bounds frozen inputs. */
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
