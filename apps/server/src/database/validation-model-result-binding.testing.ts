import type {
  ValidationJobResultV2,
  ValidationJobResultV2ModelResult,
} from "@agentic-review/codex";
import type * as C from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { handleModelInvocationRequest } from "./model-invocations.js";
import {
  createModelInvocationFixture,
  modelInvocationBeginRequest,
  modelInvocationReceiptSet,
  modelInvocationSealRequest,
  modelInvocationFixtureTime as time,
} from "./model-invocations.testing.js";
import type { ReviewCompletionJobContext } from "./review-results.js";
import type { ValidationModelResultScope } from "./validation-model-result-binding.js";
import { validationSummaryInputRequest } from "./validation-summary-inputs.testing.js";

type IssueModelOutput =
  | Extract<ValidationJobResultV2ModelResult, { schemaVersion: "IssueTriageV2" }>
  | Extract<ValidationJobResultV2ModelResult, { workItemKind: "issue" }>;

/** Synthetic protocol records only. No production claim, compiler, model or accepted completion. */
export function createValidationModelResultBindingFixture(
  options: {
    readonly raw?: IssueModelOutput;
    readonly alterLedger?: (set: C.ModelInvocationReceiptSet) => void;
    readonly openingOnly?: boolean;
    readonly sealOnly?: boolean;
  } = {},
) {
  const f = createModelInvocationFixture();
  try {
    const request = modelInvocationBeginRequest(f);
    const cell = f.cells.find((entry) => entry.arm === "baseline");
    if (!cell) throw new Error("The synthetic baseline cell is missing.");
    const raw: IssueModelOutput = options.raw ?? {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "issue",
      summary: "Synthetic raw model summary.",
      observations: [],
      reproductionConclusion: "inconclusive",
    };
    const opening = handleModelInvocationRequest(
      f.database,
      {
        operation: "beginModelInvocation",
        input: { workerTokenSha256: f.workerTokenSha256, request },
      },
      time.opened,
    ) as C.ModelInvocationOpening;
    const ledger = modelInvocationReceiptSet(opening, f.identity.modelId);
    const modelOutputSha256 = sha256(canonicalJson(raw));
    const last = ledger.calls.at(-1);
    if (!last?.receipt.response) throw new Error("The synthetic ledger must include one response.");
    ledger.modelOutputSha256 = modelOutputSha256;
    last.receipt.response.outputJsonSha256 = modelOutputSha256;
    last.sha256 = sha256(canonicalJson(last.receipt));
    options.alterLedger?.(ledger);
    let seal: C.ModelInvocationSealV1 | null = null,
      submission: C.ModelInvocationSubmissionV1 | null = null;
    if (!options.openingOnly) {
      seal = handleModelInvocationRequest(
        f.database,
        {
          operation: "sealModelInvocation",
          input: {
            workerTokenSha256: f.workerTokenSha256,
            request: modelInvocationSealRequest(request.lease, ledger),
          },
        },
        time.sealed,
      ) as C.ModelInvocationSealV1;
      if (!options.sealOnly)
        submission = handleModelInvocationRequest(
          f.database,
          {
            operation: "submitModelInvocationReceipts",
            input: {
              workerTokenSha256: f.workerTokenSha256,
              request: {
                lease: request.lease,
                invocationId: request.invocationId,
                receiptSet: ledger,
              },
            },
          },
          time.submitted,
        ) as C.ModelInvocationSubmissionV1;
    }
    const frozenContext = validationSummaryInputRequest(f).context;
    if (frozenContext.report.workItemKind !== "issue")
      throw new Error("The synthetic summary fixture must retain its frozen Issue report.");
    const result: ValidationJobResultV2 = {
      schemaVersion: "ValidationJobResultV2",
      report: frozenContext.report,
      execution: frozenContext.execution,
      modelReview: {
        state: "completed",
        result: raw,
        invocation: {
          invocationId: request.invocationId,
          scopeSha256: opening.scopeSha256,
          receiptSetSha256: sha256(canonicalJson(ledger)),
          modelOutputSha256,
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
    const execution = f.database
      .prepare("SELECT execution_digest FROM jobs WHERE id = ?")
      .get(cell.jobId) as { execution_digest: string };
    const scope: ValidationModelResultScope = {
      repositoryId: f.repositoryId,
      runId: cell.run_id,
      requestId: cell.request_id,
      jobId: cell.jobId,
      runAttemptId: request.lease.runAttemptId,
      resultDigest: sha256(canonicalJson(result)),
      executionDigest: execution.execution_digest,
    };
    return { ...f, result, scope, opening, ledger, seal, submission, cell };
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

/** Writes a clearly synthetic archived V2 result under all production SQL guards. This is
 * not the completion API and cannot establish that the required model gate has been accepted. */
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
