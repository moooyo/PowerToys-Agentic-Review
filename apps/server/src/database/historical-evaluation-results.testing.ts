import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getValidationJobResultIssues, type ValidationJobResultV1 } from "@agentic-review/codex";
import type { EvaluationCellResultReadQuery } from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { completedAt, type EvaluationCompletionFixture } from "./evaluation-completion.testing.js";
import type { ReviewCompletionJobContext } from "./review-results.js";

/** Seeds only a synthetic legacy V1 archive for historical readers. It never invokes current
 * completion, creates a validated-result brand, disables a SQL guard, or runs a model/command.
 * These no-file headless compiler archives retain their historical diagnostic-completeness flag;
 * read-time evidence authority still comes from the real verification coordinator. */
export function insertHistoricalEvaluationResult(
  database: DatabaseSync,
  cell: EvaluationCompletionFixture["cells"][number],
  completion: ReviewCompletionJobContext,
  result: ValidationJobResultV1,
): {
  readonly query: EvaluationCellResultReadQuery;
  readonly resultId: string;
  readonly resultDigest: string;
} {
  const validation = cell.template.validation;
  if (
    database.isTransaction ||
    validation.schemaVersion !== "ValidationJobContextV2" ||
    cell.plan.modelRequirements.required ||
    validation.target !== "headless" ||
    result.schemaVersion !== "ValidationJobResultV1" ||
    getValidationJobResultIssues(result).length ||
    result.modelReview.state !== "not_requested" ||
    result.report.modelSummary === undefined ||
    result.report.checks.some((check) => check.evidenceIds.length !== 0) ||
    completion.jobId !== cell.jobId ||
    completion.workItemId === null ||
    completion.revisionId === null ||
    completion.executionDigest === null ||
    completion.executionJson !== canonicalJson(cell.template) ||
    completion.executionDigest !== sha256(canonicalJson(cell.template))
  )
    throw new Error("The synthetic legacy evaluation archive fixture is inconsistent.");
  const json = canonicalJson(result),
    resultDigest = sha256(json),
    resultId = `historical-${randomUUID()}`;
  database.exec("BEGIN IMMEDIATE");
  try {
    const settled = database
      .prepare(`UPDATE run_attempts SET status='succeeded', result_digest=?, result_json=?, ended_at=?
      WHERE id=? AND job_id=? AND status IN ('leased','running')`)
      .run(resultDigest, json, completedAt, completion.runAttemptId, completion.jobId);
    if (Number(settled.changes) !== 1)
      throw new Error("The synthetic historical attempt is missing.");
    database
      .prepare(`INSERT INTO validation_job_results
      (id,run_attempt_id,job_id,repository_id,work_item_id,revision_id,job_kind,resource_revision,
       review_run_id,request_id,activation_id,job_activation,workflow_kind,target,plan_digest,prompt_version_id,
       profile_version_id,schema_id,result_digest,result_json,execution_template_sha256,evidence_complete,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ValidationJobResultV1',?,?,?,1,?)`)
      .run(
        resultId,
        completion.runAttemptId,
        completion.jobId,
        validation.repositoryId,
        completion.workItemId,
        completion.revisionId,
        completion.jobKind,
        completion.resourceRevision,
        validation.runId,
        validation.requestId,
        validation.activationId,
        validation.jobActivation,
        validation.workflowKind,
        validation.target,
        validation.planDigest,
        validation.promptVersion.id,
        validation.profileVersion.id,
        resultDigest,
        json,
        completion.executionDigest,
        completedAt,
      );
    const closed = database
      .prepare(`UPDATE jobs SET status='succeeded',current_run_attempt_id=NULL,completed_at=?
      WHERE id=? AND current_run_attempt_id=? AND status IN ('leased','running')`)
      .run(completedAt, completion.jobId, completion.runAttemptId);
    if (Number(closed.changes) !== 1) throw new Error("The synthetic historical Job is missing.");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    resultId,
    resultDigest,
    query: {
      repositoryId: validation.repositoryId,
      evaluationId: validation.purpose.evaluationId,
      cellId: validation.purpose.cellId,
      resultId,
    },
  };
}
