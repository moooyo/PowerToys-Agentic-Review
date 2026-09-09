import {
  type ValidationJobResultV2,
  type ValidationJobResultV2ModelResult,
  ValidationJobResultV2Schema,
} from "@agentic-review/codex";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createModelCliFixture, modelCliFixtureTime as time } from "./model-cli.testing.js";
import type { ReviewCompletionJobContext } from "./review-results.js";
import type { ValidationModelResultScope } from "./validation-model-result-binding.js";
import {
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";
import { freezeValidationSummaryInput } from "./validation-summary-inputs.js";
import { validationSummaryInputRequest } from "./validation-summary-inputs.testing.js";

/** Synthetic CLI observations only. No production claim, compiler or model process runs. */
export function createValidationModelResultBindingFixture(
  options: {
    readonly kind?: "issue" | "pull_request";
    readonly raw?: ValidationJobResultV2ModelResult;
  } = {},
) {
  const f = createModelCliFixture({ kind: options.kind ?? "issue" });
  try {
    const cell = f.cells.find((entry) => entry.arm === "baseline");
    if (!cell) throw new Error("The synthetic baseline cell is missing.");
    const request = options.kind === "pull_request" ? null : validationSummaryInputRequest(f);
    const receipt =
      request === null
        ? null
        : freezeValidationSummaryInput(
            f.database,
            { workerTokenSha256: f.workerTokenSha256, request },
            time.opened,
          );
    const raw: ValidationJobResultV2ModelResult =
      options.raw ??
      (options.kind === "pull_request"
        ? {
            schemaVersion: "PrReviewPlanV2",
            summary: "Synthetic raw CLI review.",
            assessment: "approve",
            findings: [],
            requestedRecipeIds: [],
            verification: {
              status: "not_run",
              summary: "The runner owns build checks.",
              commands: [],
            },
          }
        : {
            schemaVersion: "ValidationSummaryV1",
            workItemKind: "issue",
            summary: "Synthetic raw model summary.",
            observations: [],
            reproductionConclusion: "inconclusive",
          });
    const report: ValidationJobResultV2["report"] = request?.context.report ?? {
      schemaVersion: "ValidationReportV1",
      workItemKind: "pull_request",
      source: "worker",
      sourceState: "original",
      summary: "Synthetic runner observations before CLI review.",
      checks: [],
    };
    const lease = f.lease();
    const result: unknown = {
      schemaVersion: "ValidationJobResultV2",
      report,
      execution: request?.context.execution ?? {
        blockers: [],
        diagnostics: [],
        cleanupState: "not_needed",
      },
      modelReview: {
        state: "completed",
        result: raw,
        execution: {
          schemaVersion: "CliModelExecutionV1",
          jobId: lease.jobId,
          runAttemptId: lease.runAttemptId,
          cli: f.cli,
          promptSha256: receipt?.reference.actualPromptSha256 ?? cell.prompt.promptSha256,
          outputSchemaSha256: cell.prompt.outputSchemaSha256,
          outputSha256: sha256(canonicalJson(raw)),
          exitCode: 0,
          ...(receipt === null ? {} : { summaryInputRef: receipt.reference }),
        },
        executionEvidence: {
          schemaVersion: "ReviewExecutionEvidenceV1",
          source: "worker",
          commands: [],
          commandCapture: "complete",
          worktree: { status: "unknown", source: "not_observed" },
        },
      },
    };
    if (!Value.Check(ValidationJobResultV2Schema, result))
      throw new Error("The synthetic CLI result must match its current output contract.");
    const execution = f.database
      .prepare("SELECT execution_digest FROM jobs WHERE id = ?")
      .get(cell.jobId) as { execution_digest: string };
    const scope: ValidationModelResultScope = {
      repositoryId: f.repositoryId,
      runId: cell.run_id,
      requestId: cell.request_id,
      jobId: cell.jobId,
      runAttemptId: lease.runAttemptId,
      resultDigest: sha256(canonicalJson(result)),
      executionDigest: execution.execution_digest,
    };
    return { ...f, result, scope, cell, summaryInput: receipt?.reference ?? null };
  } catch (error) {
    f.close();
    throw error;
  }
}
export type ValidationModelResultBindingFixture = ReturnType<
  typeof createValidationModelResultBindingFixture
>;

export function validationModelCompletionContext(
  f: ValidationModelResultBindingFixture,
): ReviewCompletionJobContext {
  return f.database
    .prepare(`SELECT job.id AS jobId, attempt.id AS runAttemptId, job.job_kind AS jobKind,
    job.work_item_id AS workItemId, item.resource_kind AS workItemResourceKind, job.resource_revision AS resourceRevision,
    revision.id AS revisionId, revision.resource_kind AS revisionResourceKind, revision.base_sha AS revisionBaseSha,
    revision.head_sha AS revisionHeadSha, job.execution_json AS executionJson, job.execution_digest AS executionDigest
    FROM jobs AS job JOIN run_attempts AS attempt ON attempt.id = job.current_run_attempt_id
    JOIN work_items AS item ON item.id = job.work_item_id JOIN review_run_job_links AS link ON link.job_id = job.id
    JOIN review_runs AS run ON run.id = link.review_run_id JOIN work_item_revisions AS revision ON revision.id = run.revision_id
    WHERE job.id = ?`)
    .get(f.scope.jobId) as unknown as ReviewCompletionJobContext;
}

/** Completes synthetic observations through the production result validator and persistence API. */
export function completeValidationModelResultFixture(f: ValidationModelResultBindingFixture) {
  const context = validationModelCompletionContext(f),
    now = "2026-09-08T04:02:00.000Z";
  f.database.exec("BEGIN IMMEDIATE");
  try {
    const validated = validateValidationCompletion(
      f.database,
      context,
      f.scope.resultDigest,
      f.result,
    );
    f.database
      .prepare(
        "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(validated.resultDigest, validated.canonicalResultJson, now, context.runAttemptId);
    const resultId = persistValidatedValidationResult(f.database, context, validated, now);
    f.database
      .prepare(
        "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
      )
      .run(now, context.jobId);
    f.database.exec("COMMIT");
    return { ...f.scope, resultId, schemaId: "ValidationJobResultV2" as const };
  } catch (error) {
    if (f.database.isTransaction) f.database.exec("ROLLBACK");
    throw error;
  }
}

/** Writes a clearly synthetic archived V2 result under all production SQL guards.
 * Completion tests use the normal validator and persistence API instead. */
export function insertSyntheticStoredValidationModelResult(
  f: ValidationModelResultBindingFixture,
  resultId = "synthetic-bound-v2-result",
) {
  const { database, scope, cell } = f,
    json = canonicalJson(f.result),
    now = "2026-09-08T04:02:00.000Z";
  const request = cell.plan.jobs[0];
  if (!request) throw new Error("The synthetic request is missing.");
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(scope.resultDigest, json, now, scope.runAttemptId);
    database
      .prepare(`INSERT INTO validation_job_results
      (id, run_attempt_id, job_id, repository_id, work_item_id, revision_id, job_kind, resource_revision,
      review_run_id, request_id, activation_id, job_activation, workflow_kind, target, plan_digest,
      prompt_version_id, profile_version_id, schema_id, result_digest, result_json, execution_template_sha256, evidence_complete, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'issue_triage', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'ValidationJobResultV2', ?, ?, ?, 0, ?)`)
      .run(
        resultId,
        scope.runAttemptId,
        scope.jobId,
        scope.repositoryId,
        cell.plan.workItemId,
        cell.plan.source.revisionId,
        cell.plan.revision.revisionKey,
        scope.runId,
        scope.requestId,
        cell.plan.activationId,
        request.workflowKind,
        request.target,
        cell.plan_digest,
        request.prompt.version.id,
        request.profileVersion.id,
        scope.resultDigest,
        json,
        scope.executionDigest,
        now,
      );
    database
      .prepare(
        "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
      )
      .run(now, scope.jobId);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
  return { ...scope, resultId, schemaId: "ValidationJobResultV2" as const };
}
