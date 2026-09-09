import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  getValidationJobResultIssues,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
  type ValidationJobResult,
  type ValidationJobResultV1,
} from "@agentic-review/codex";
import {
  assertReviewRunExecutionPlan,
  type EvaluationExecutionTemplate,
  getValidationProfileConfigIssues,
  IssueValidationSummaryV1Schema,
  type JobExecutionTemplateV2,
  JobExecutionTemplateV2Schema,
  type PromptEnvelope,
  type PromptVersion,
  PullRequestValidationSummaryV1Schema,
  type ReproductionObservationFact,
  type ReviewRunExecutionPlanV1,
  type ReviewRunPlannedJob,
  type ValidationCheckResult,
  type ValidationLifecyclePhase,
  type ValidationProfileVersion,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";
import { validateFrozenIssueReproductionBinding } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  createEvaluationExecutionTemplate,
  createValidationExecutionTemplate,
} from "../scheduling/validation-job-factory.js";
import {
  ResultDigestMismatchError,
  ReviewResultInvalidError,
  StoredExecutionTemplateInvalidError,
} from "./errors.js";
import { readEvaluationExecutionCellInTransaction } from "./evaluation-execution.js";
import {
  type ReproductionResultScope,
  validateIssueReproductionResult,
  validateProbeReceiptObservations,
} from "./issue-reproduction.js";
import { handlePromptConfigurationRequest } from "./prompt-configuration.js";
import {
  type CanonicalReviewResultSubmission,
  canonicalizeReviewResultSubmission,
  type ReviewCompletionJobContext,
  validateReviewCompletion,
  validateValidationModelSummaryBusinessRules,
} from "./review-results.js";
import { readValidationModelResultBindingInTransaction } from "./validation-model-result-binding.js";

export interface ValidatedValidationResult extends CanonicalReviewResultSubmission {
  readonly schemaId: ValidationJobResult["schemaVersion"];
  readonly result: ValidationJobResult;
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly repositoryId: string;
  readonly workItemId: string;
  readonly revisionId: string;
  readonly jobKind: ReviewCompletionJobContext["jobKind"];
  readonly resourceRevision: string;
  readonly reviewRunId: string;
  readonly requestId: string;
  readonly activationId: string;
  readonly jobActivation: number;
  readonly workflowKind: JobExecutionTemplateV2["validation"]["workflowKind"];
  readonly target: JobExecutionTemplateV2["validation"]["target"];
  readonly planDigest: string;
  readonly promptVersionId: string;
  readonly profileVersionId: string;
  readonly executionTemplateSha256: string;
  /** Diagnostic completeness is independent of pass/fail, source changes, and approval. */
  readonly evidenceComplete: boolean;
}

export interface ValidationEvidenceReferenceScope {
  readonly repositoryId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly profileVersionId: string;
  readonly checkId: string;
  readonly evidenceIds: readonly string[];
}

export interface ValidationCompletionOptions {
  /** Check finalized immutable manifests in the caller's current completion transaction. */
  readonly validateEvidenceReferences?: (scope: ValidationEvidenceReferenceScope) => boolean;
  /** A negative scenario proof preserves the report while preventing complete UI evidence. */
  readonly validateScenarioEvidence?: (scope: ValidationEvidenceReferenceScope) => boolean;
  /** Only the coordinator's current admitted captures may supply measured assertion values. */
  readonly readScenarioObservations?: (
    scope: ValidationEvidenceReferenceScope,
  ) => readonly ReproductionObservationFact[] | null;
}
export interface ValidationRunnerEvidenceInput {
  readonly template: JobExecutionTemplateV2;
  readonly request: ReviewRunPlannedJob;
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly result: ReproductionResultScope["result"];
}
/** Validates an interim runner snapshot without constructing or authorizing a terminal result. */
export function collectValidationRunnerEvidence(
  input: ValidationRunnerEvidenceInput,
): readonly ValidationEvidenceReferenceScope[] {
  const scopes: ValidationEvidenceReferenceScope[] = [];
  validateProbeReceiptObservations({ validation: input.template.validation, ...input });
  validateReportEvidence(
    input.result,
    expectedChecks(input.request),
    input.template,
    input,
    {},
    scopes,
  );
  return Object.freeze(scopes);
}
export function validateValidationRunnerEvidence(
  input: ValidationRunnerEvidenceInput,
  options: ValidationCompletionOptions,
): boolean {
  validateProbeReceiptObservations({ validation: input.template.validation, ...input });
  const complete = validateReportEvidence(
    input.result,
    expectedChecks(input.request),
    input.template,
    input,
    options,
  );
  validateIssueReproductionResult({ validation: input.template.validation, ...input }, options);
  return complete;
}

interface CompletionIdentityRow {
  readonly job_kind: ReviewCompletionJobContext["jobKind"];
  readonly job_status: string;
  readonly attempt_status: string;
  readonly work_item_id: string;
  readonly item_kind: "issue" | "pull_request";
  readonly resource_revision: string;
  readonly request_epoch_id: string | null;
  readonly execution_json: string;
  readonly execution_digest: string;
  readonly review_run_id: string;
  readonly request_id: string;
  readonly activation_number: number;
  readonly repository_id: string;
  readonly revision_id: string;
  readonly revision_kind: "issue" | "pull_request";
  readonly base_sha: string | null;
  readonly head_sha: string | null;
  readonly activation_id: string;
  readonly plan_digest: string;
  readonly plan_json: string;
  readonly request_json: string;
  readonly prompt_envelope_json: string;
  readonly profile_version_id: string;
  readonly prompt_version_id: string;
}

interface ExpectedCheck {
  readonly kind: ValidationCheckResult["kind"];
  readonly phase: ValidationLifecyclePhase;
  readonly required: boolean;
}

const validatedResults = new WeakSet<object>();
const validatedEvaluationResults = new WeakSet<object>();
const outputSchemas = {
  pr_static_build: PrReviewPlanV2ModelOutputSchema,
  issue_triage: IssueTriageV2ModelOutputSchema,
  pr_ui: PullRequestValidationSummaryV1Schema,
  issue_validation: IssueValidationSummaryV1Schema,
} as const;

function readValidationSubmission(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
  submittedDigest: string,
  result: unknown,
  canonicalResult?: CanonicalReviewResultSubmission,
) {
  const canonical = canonicalizeReviewResultSubmission(result);
  if (!matchesDigest(submittedDigest, canonical.resultDigest))
    throw new ResultDigestMismatchError();
  if (
    canonicalResult !== undefined &&
    (canonicalResult.canonicalResultJson !== canonical.canonicalResultJson ||
      canonicalResult.resultDigest !== canonical.resultDigest)
  )
    invalidResult("The supplied canonical validation result does not match the result payload.");
  if (getValidationJobResultIssues(result).length)
    invalidResult("The validation result does not match its supported validation schema.");
  const checkedResult = result as ValidationJobResult;
  const { template, row, request } = readCompletionIdentity(database, context);
  const validation = template.validation;
  if (checkedResult.report.workItemKind !== template.resource.kind) {
    invalidResult("The validation report belongs to another work item kind.");
  }
  if (
    validation.schemaVersion === "ValidationJobContextV2" &&
    !validation.modelRequirements.required &&
    (checkedResult.modelReview.state === "completed" ||
      (checkedResult.schemaVersion === "ValidationJobResultV1" &&
        checkedResult.report.modelSummary !== undefined))
  ) {
    invalidResult("Profile-only evaluations cannot submit model content.");
  }
  if (
    validation.schemaVersion === "ValidationJobContextV2" &&
    validation.modelRequirements.required &&
    checkedResult.schemaVersion === "ValidationJobResultV1" &&
    (checkedResult.modelReview.state === "completed" ||
      checkedResult.report.modelSummary !== undefined)
  ) {
    invalidResult("Model-backed evaluations require a V2 result bound to its CLI execution.");
  }
  if (checkedResult.schemaVersion === "ValidationJobResultV1")
    validateModelSummary(checkedResult, template);
  validateProbeReceiptObservations({
    validation,
    jobId: context.jobId,
    runAttemptId: context.runAttemptId,
    result: checkedResult,
  });
  if (
    checkedResult.schemaVersion === "ValidationJobResultV2" &&
    checkedResult.modelReview.state === "completed"
  ) {
    const verifyContent = () =>
      readValidationModelResultBindingInTransaction(
        database,
        {
          repositoryId: validation.repositoryId,
          runId: validation.runId,
          requestId: validation.requestId,
          jobId: context.jobId,
          runAttemptId: context.runAttemptId,
          resultDigest: canonical.resultDigest,
          executionDigest: row.execution_digest,
        },
        checkedResult,
      );
    try {
      if (database.isTransaction) verifyContent();
      else {
        database.exec("BEGIN");
        try {
          verifyContent();
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      }
    } catch {
      invalidResult(
        "The raw validation model result does not match its task and CLI execution metadata.",
      );
    }
  }
  if (
    checkedResult.schemaVersion === "ValidationJobResultV1" &&
    checkedResult.modelReview.state === "completed"
  ) {
    if (validation.workflowKind === "pr_ui" || validation.workflowKind === "issue_validation") {
      invalidResult("A validation summary workflow cannot submit a legacy model review result.");
    }
    const { validation: _validation, ...legacyTemplate } = template;
    const legacyJson = canonicalJson(legacyTemplate);
    const nested = canonicalizeReviewResultSubmission(checkedResult.modelReview.result);
    validateReviewCompletion(
      {
        ...context,
        executionJson: legacyJson,
        executionDigest: sha256(legacyJson),
      },
      nested.resultDigest,
      checkedResult.modelReview.result,
      nested,
    );
  }
  return { canonical, template, row, request, result: checkedResult };
}

export interface ValidationCompletionEvidenceCollection {
  readonly canonical: CanonicalReviewResultSubmission;
  readonly template: JobExecutionTemplateV2;
  readonly request: ReviewRunPlannedJob;
  readonly result: ValidationJobResult;
  readonly scopes: readonly ValidationEvidenceReferenceScope[];
}

/** Collect immutable dependencies without claiming verified bytes or granting persistence authority. */
export function collectValidationCompletionEvidence(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
  submittedDigest: string,
  result: unknown,
): ValidationCompletionEvidenceCollection {
  const parsed = readValidationSubmission(database, context, submittedDigest, result);
  const scopes: ValidationEvidenceReferenceScope[] = [];
  validateReportEvidence(
    parsed.result,
    expectedChecks(parsed.request),
    parsed.template,
    context,
    {},
    scopes,
  );
  return freeze({
    canonical: parsed.canonical,
    template: parsed.template,
    request: parsed.request,
    result: JSON.parse(parsed.canonical.canonicalResultJson) as ValidationJobResult,
    scopes,
  });
}

export function validateValidationCompletion(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
  submittedDigest: string,
  result: unknown,
  canonicalResult?: CanonicalReviewResultSubmission,
  options: ValidationCompletionOptions = {},
): ValidatedValidationResult {
  const {
    canonical,
    template,
    row,
    request,
    result: checkedResult,
  } = readValidationSubmission(database, context, submittedDigest, result, canonicalResult);
  const validation = template.validation;
  const expected = expectedChecks(request);
  const evidenceComplete = validateReportEvidence(
    checkedResult,
    expected,
    template,
    context,
    options,
  );
  validateIssueReproductionResult(
    { validation, jobId: context.jobId, runAttemptId: context.runAttemptId, result: checkedResult },
    options,
  );
  const validated: ValidatedValidationResult = freeze({
    ...canonical,
    schemaId: checkedResult.schemaVersion,
    result: JSON.parse(canonical.canonicalResultJson) as ValidationJobResult,
    jobId: context.jobId,
    runAttemptId: context.runAttemptId,
    repositoryId: validation.repositoryId,
    workItemId: row.work_item_id,
    revisionId: row.revision_id,
    jobKind: context.jobKind,
    resourceRevision: context.resourceRevision,
    reviewRunId: validation.runId,
    requestId: validation.requestId,
    activationId: validation.activationId,
    jobActivation: validation.jobActivation,
    workflowKind: validation.workflowKind,
    target: validation.target,
    planDigest: validation.planDigest,
    promptVersionId: validation.promptVersion.id,
    profileVersionId: validation.profileVersion.id,
    executionTemplateSha256: row.execution_digest,
    evidenceComplete,
  });
  validatedResults.add(validated);
  if (validation.schemaVersion === "ValidationJobContextV2") {
    validatedEvaluationResults.add(validated);
  }
  return validated;
}

function validateModelSummary(
  result: ValidationJobResultV1,
  template: JobExecutionTemplateV2,
): void {
  const summary = result.report.modelSummary;
  if (summary === undefined) return;
  const workflowKind = template.validation.workflowKind;
  if (workflowKind !== "pr_ui" && workflowKind !== "issue_validation") {
    invalidResult("Only a UI or issue validation workflow can submit a model summary.");
  }
  if (
    summary.workItemKind !== template.resource.kind ||
    !Value.Check(outputSchemas[workflowKind], summary)
  ) {
    invalidResult("The model summary does not match the frozen validation workflow.");
  }
  // The completed modelReview branch contains a legacy review, not a validation summary.
  if (result.modelReview.state !== "not_requested") {
    invalidResult("A model summary cannot coexist with a failed or legacy model review result.");
  }
  validateValidationModelSummaryBusinessRules(summary);
}

export function persistValidatedValidationResult(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
  validated: ValidatedValidationResult,
  createdAt: string,
): string {
  if (
    !validatedResults.has(validated) ||
    context.jobId !== validated.jobId ||
    context.runAttemptId !== validated.runAttemptId ||
    context.workItemId !== validated.workItemId ||
    context.revisionId !== validated.revisionId ||
    context.jobKind !== validated.jobKind ||
    context.resourceRevision !== validated.resourceRevision ||
    context.executionDigest !== validated.executionTemplateSha256 ||
    sha256(context.executionJson) !== validated.executionTemplateSha256 ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    invalidTemplate("The validated result does not belong to this completion context.");
  }
  if (validatedEvaluationResults.has(validated)) {
    if (!database.isTransaction) {
      invalidTemplate("Evaluation result persistence requires the final completion transaction.");
    }
    // Async evidence collection is not authority to publish after cancellation or lease loss.
    readEvaluationCompletionIdentity(database, context, "settled", createdAt);
  }
  const resultId = randomUUID();
  database
    .prepare(`INSERT INTO validation_job_results (
    id, run_attempt_id, job_id, repository_id, work_item_id, revision_id,
    job_kind, resource_revision, review_run_id, request_id, activation_id,
    job_activation, workflow_kind, target, plan_digest, prompt_version_id,
    profile_version_id, schema_id, result_digest, result_json,
    execution_template_sha256, evidence_complete, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      resultId,
      validated.runAttemptId,
      validated.jobId,
      validated.repositoryId,
      validated.workItemId,
      validated.revisionId,
      validated.jobKind,
      validated.resourceRevision,
      validated.reviewRunId,
      validated.requestId,
      validated.activationId,
      validated.jobActivation,
      validated.workflowKind,
      validated.target,
      validated.planDigest,
      validated.promptVersionId,
      validated.profileVersionId,
      validated.schemaId,
      validated.resultDigest,
      validated.canonicalResultJson,
      validated.executionTemplateSha256,
      Number(validated.evidenceComplete),
      createdAt,
    );
  return resultId;
}

function readCompletionIdentity(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
): {
  readonly template: JobExecutionTemplateV2;
  readonly row: CompletionIdentityRow;
  readonly request: ReviewRunPlannedJob;
} {
  let schemaVersion: unknown;
  try {
    const raw: unknown = JSON.parse(context.executionJson);
    if (raw !== null && typeof raw === "object" && "validation" in raw) {
      const validation = raw.validation;
      if (validation !== null && typeof validation === "object" && "schemaVersion" in validation) {
        schemaVersion = validation.schemaVersion;
      }
    }
  } catch {
    invalidTemplate("The stored validation envelope is invalid.");
  }
  if (schemaVersion !== "ValidationJobContextV2") {
    return readOrdinaryCompletionIdentity(database, context);
  }
  if (database.isTransaction) return readEvaluationCompletionIdentity(database, context);
  database.exec("BEGIN");
  try {
    const identity = readEvaluationCompletionIdentity(database, context);
    database.exec("COMMIT");
    return identity;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function readEvaluationCompletionIdentity(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
  phase: "executing" | "settled" = "executing",
  now?: string,
): {
  readonly template: EvaluationExecutionTemplate;
  readonly row: CompletionIdentityRow;
  readonly request: ReviewRunPlannedJob;
} {
  if (
    !database.isTransaction ||
    context.workItemId === null ||
    context.revisionId === null ||
    context.executionDigest === null
  ) {
    invalidTemplate(
      "Evaluation completion requires its transaction and immutable execution identity.",
    );
  }
  try {
    const row = database
      .prepare(`SELECT
    job.job_kind, job.status AS job_status, attempt.status AS attempt_status,
    job.work_item_id, item.resource_kind AS item_kind, job.resource_revision,
    job.request_epoch_id, job.execution_json, job.execution_digest,
    link.review_run_id, link.request_id, link.activation_number,
    run.repository_id, run.revision_id, revision.resource_kind AS revision_kind,
    revision.base_sha, revision.head_sha, run.activation_id, run.plan_digest,
    run.plan_json, request.request_json, request.prompt_envelope_json,
    request.profile_version_id, request.prompt_version_id
    FROM jobs AS job
    JOIN run_attempts AS attempt ON attempt.id = ? AND attempt.job_id = job.id
      AND job.current_run_attempt_id = attempt.id AND job.lease_generation = attempt.lease_generation
    JOIN workers AS worker ON worker.id = attempt.worker_id
      AND worker.node_id = attempt.worker_node_id AND worker.instance_id = attempt.worker_instance_id
      AND worker.superseded_at IS NULL
    JOIN review_run_job_links AS link ON link.job_id = job.id AND link.activation_number = 1
    JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'evaluation'
      AND run.work_item_id = job.work_item_id AND run.revision_key = job.resource_revision
      AND run.request_epoch_id IS NULL AND job.request_epoch_id IS NULL
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    JOIN work_items AS item ON item.id = job.work_item_id AND item.repository_id = run.repository_id
    JOIN work_item_revisions AS revision ON revision.id = run.revision_id
      AND revision.work_item_id = item.id AND revision.revision_key = job.resource_revision
    WHERE job.id = ? AND job.source_event_id IS NULL AND job.cancellation_requested_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM job_request_epochs WHERE job_id = job.id)`)
      .get(context.runAttemptId, context.jobId) as CompletionIdentityRow | undefined;
    if (
      row === undefined ||
      !["leased", "running"].includes(row.job_status) ||
      !(phase === "executing" ? ["leased", "running"] : ["succeeded"]).includes(
        row.attempt_status,
      ) ||
      row.job_kind !== context.jobKind ||
      row.work_item_id !== context.workItemId ||
      row.item_kind !== context.workItemResourceKind ||
      row.revision_id !== context.revisionId ||
      row.revision_kind !== context.revisionResourceKind ||
      row.resource_revision !== context.resourceRevision ||
      row.base_sha !== context.revisionBaseSha ||
      row.head_sha !== context.revisionHeadSha ||
      row.execution_json !== context.executionJson ||
      row.execution_digest !== context.executionDigest
    ) {
      invalidTemplate(
        "The evaluation completion is not linked to its current fenced Job and attempt.",
      );
    }
    const raw: unknown = JSON.parse(row.execution_json);
    if (
      !Value.Check(JobExecutionTemplateV2Schema, raw) ||
      raw.validation.schemaVersion !== "ValidationJobContextV2"
    ) {
      invalidTemplate("The stored evaluation validation envelope is invalid.");
    }
    const template: EvaluationExecutionTemplate = { ...raw, validation: raw.validation };
    const binding = readEvaluationExecutionCellInTransaction(
      database,
      {
        repositoryId: row.repository_id,
        runId: row.review_run_id,
      },
      now,
    );
    if (
      binding === null ||
      !binding.applicable ||
      !binding.repositoryEnabled ||
      binding.controlStatus !== "active" ||
      binding.reproductionReadiness.state === "blocked" ||
      binding.runId !== row.review_run_id ||
      binding.repositoryId !== row.repository_id ||
      binding.requestId !== row.request_id ||
      binding.planDigest !== row.plan_digest ||
      binding.plan.source.revisionId !== row.revision_id ||
      binding.plan.workItemId !== row.work_item_id ||
      binding.plan.revision.revisionKey !== row.resource_revision ||
      binding.plan.activationId !== row.activation_id ||
      row.activation_number !== 1 ||
      row.request_epoch_id !== null ||
      binding.jobs.length !== 1 ||
      binding.jobs[0]?.jobId !== context.jobId ||
      binding.jobs[0]?.activationNumber !== 1 ||
      canonicalJson(binding.plan) !== row.plan_json ||
      canonicalJson(binding.request) !== row.request_json ||
      canonicalJson(binding.prompt) !== row.prompt_envelope_json ||
      binding.request.profileVersion.id !== row.profile_version_id ||
      binding.request.prompt.version.id !== row.prompt_version_id ||
      template.validation.purpose.cellId !== binding.cellId ||
      template.validation.purpose.evaluationId !== binding.evaluationId
    ) {
      invalidTemplate(
        "The evaluation completion does not match its active sealed cell and frozen request.",
      );
    }
    const request = binding.request;
    validatePublishedSnapshots(database, request);
    const outputSchema = canonicalJson(outputSchemas[request.workflowKind]);
    if (
      canonicalJson(binding.prompt.outputSchema) !== outputSchema ||
      binding.prompt.outputSchemaSha256 !== sha256(outputSchema)
    ) {
      invalidTemplate(
        "The frozen evaluation prompt does not use the authoritative workflow output schema.",
      );
    }
    const expected = createEvaluationExecutionTemplate({
      runId: binding.runId,
      plan: binding.plan,
      planDigest: binding.planDigest,
      frozenPrompt: binding.prompt,
    });
    if (
      canonicalJson(expected) !== row.execution_json ||
      sha256(row.execution_json) !== row.execution_digest
    ) {
      invalidTemplate(
        "The evaluation template differs from its immutable source, authority, and cell configuration.",
      );
    }
    return { template, row, request };
  } catch (error) {
    if (error instanceof StoredExecutionTemplateInvalidError) throw error;
    invalidTemplate(
      "The stored evaluation source, authority, configuration, or execution binding is invalid.",
    );
  }
}

function readOrdinaryCompletionIdentity(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
): {
  readonly template: JobExecutionTemplateV2;
  readonly row: CompletionIdentityRow;
  readonly request: ReviewRunPlannedJob;
} {
  if (
    context.workItemId === null ||
    context.revisionId === null ||
    context.executionDigest === null
  ) {
    invalidTemplate("The validation job is missing its immutable revision or execution identity.");
  }
  const row = database
    .prepare(`SELECT
    job.job_kind, job.status AS job_status, attempt.status AS attempt_status,
    job.work_item_id, item.resource_kind AS item_kind, job.resource_revision,
    job.request_epoch_id, job.execution_json, job.execution_digest,
    link.review_run_id, link.request_id, link.activation_number,
    run.repository_id, run.revision_id, revision.resource_kind AS revision_kind,
    revision.base_sha, revision.head_sha, run.activation_id, run.plan_digest,
    run.plan_json, request.request_json, request.prompt_envelope_json,
    request.profile_version_id, request.prompt_version_id
    FROM jobs AS job
    JOIN run_attempts AS attempt ON attempt.id = ? AND attempt.job_id = job.id
      AND job.current_run_attempt_id = attempt.id
    JOIN review_run_job_links AS link ON link.job_id = job.id
    JOIN review_runs AS run ON run.id = link.review_run_id
      AND run.work_item_id = job.work_item_id AND run.revision_key = job.resource_revision
      AND run.request_epoch_id = job.request_epoch_id
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    JOIN work_items AS item ON item.id = job.work_item_id AND item.repository_id = run.repository_id
    JOIN work_item_revisions AS revision ON revision.id = run.revision_id
      AND revision.work_item_id = item.id AND revision.revision_key = job.resource_revision
    WHERE job.id = ?`)
    .get(context.runAttemptId, context.jobId) as CompletionIdentityRow | undefined;
  if (
    row === undefined ||
    !["leased", "running"].includes(row.job_status) ||
    !["leased", "running"].includes(row.attempt_status) ||
    row.job_kind !== context.jobKind ||
    row.work_item_id !== context.workItemId ||
    row.item_kind !== context.workItemResourceKind ||
    row.revision_id !== context.revisionId ||
    row.revision_kind !== context.revisionResourceKind ||
    row.resource_revision !== context.resourceRevision ||
    row.base_sha !== context.revisionBaseSha ||
    row.head_sha !== context.revisionHeadSha ||
    row.execution_json !== context.executionJson ||
    row.execution_digest !== context.executionDigest
  ) {
    invalidTemplate(
      "The validation completion is not linked to its active attempt and frozen review run.",
    );
  }
  try {
    const template: unknown = JSON.parse(row.execution_json);
    const plan: unknown = JSON.parse(row.plan_json);
    if (
      !Value.Check(JobExecutionTemplateV2Schema, template) ||
      template.validation.schemaVersion !== "ValidationJobContextV1"
    )
      invalidTemplate("The stored validation envelope is invalid.");
    assertReviewRunExecutionPlan(plan);
    if (
      canonicalJson(template) !== row.execution_json ||
      sha256(row.execution_json) !== row.execution_digest ||
      canonicalJson(plan) !== row.plan_json ||
      sha256(row.plan_json) !== row.plan_digest
    ) {
      invalidTemplate(
        "The frozen validation template or plan digest does not match its canonical bytes.",
      );
    }
    const requests = plan.jobs.filter((entry) => entry.requestId === row.request_id);
    const request = requests[0];
    if (
      requests.length !== 1 ||
      request === undefined ||
      request.profileVersion === null ||
      request.prompt === null ||
      canonicalJson(request) !== row.request_json ||
      request.profileVersion.id !== row.profile_version_id ||
      request.prompt.version.id !== row.prompt_version_id ||
      request.profileVersion.repositoryId !== plan.repository.id ||
      request.profileVersion.workflowKind !== request.workflowKind ||
      request.profileVersion.target !== request.target ||
      request.prompt.workflowKind !== request.workflowKind ||
      request.prompt.version.outputSchemaVersion !==
        WorkflowOutputSchemaVersions[request.workflowKind] ||
      plan.workItemId !== row.work_item_id ||
      plan.repository.id !== row.repository_id ||
      plan.revision.revisionKey !== row.resource_revision ||
      plan.authorization.requestEpochId !== row.request_epoch_id ||
      plan.activationId !== row.activation_id ||
      (request.profileVersion.required && !request.required)
    ) {
      invalidTemplate("The validation request does not match its frozen plan and profile.");
    }
    validatePublishedSnapshots(database, request);
    validateTestedSource(plan, request);
    if (plan.reproduction !== undefined) {
      validateFrozenIssueReproductionBinding(plan.reproduction, plan.jobs, {
        activationId: plan.activationId,
        repositoryId: plan.repository.id,
        githubRepositoryId: plan.repository.githubRepositoryId,
        workItemId: plan.workItemId,
        githubWorkItemId: plan.workItem.githubWorkItemId,
        workItemKind: plan.workItem.kind,
        issueRevisionKey: plan.revision.revisionKey,
        testedSourceRevision: plan.testedSourceRevision,
        testedSourceAuthorization: plan.testedSourceAuthorization,
      });
    }
    const frozenPrompt = JSON.parse(row.prompt_envelope_json) as PromptEnvelope;
    const outputSchema = canonicalJson(outputSchemas[request.workflowKind]);
    if (
      frozenPrompt.name !== request.prompt.version.templateId ||
      frozenPrompt.version !== String(request.prompt.version.version) ||
      canonicalJson(frozenPrompt.outputSchema) !== outputSchema ||
      frozenPrompt.outputSchemaSha256 !== sha256(outputSchema)
    ) {
      invalidTemplate("The frozen prompt does not use the authoritative workflow output schema.");
    }
    const expectedTemplate = createValidationExecutionTemplate({
      runId: row.review_run_id,
      plan,
      planDigest: row.plan_digest,
      requestId: row.request_id,
      jobActivation: row.activation_number,
      frozenPrompt,
    });
    if (canonicalJson(expectedTemplate) !== row.execution_json) {
      invalidTemplate("The execution template differs from its frozen review run request.");
    }
    const expectedRequiredIds = request.required
      ? [
          ...request.profileVersion.config.build,
          ...request.profileVersion.config.test,
          ...(request.profileVersion.config.ui?.scenarios ?? []),
        ]
          .filter((step) => step.required)
          .map((step) => `${request.profileVersion?.id}:${step.id}`)
          .sort()
      : [];
    if (
      canonicalJson([...request.requiredCheckIds].sort()) !== canonicalJson(expectedRequiredIds)
    ) {
      invalidTemplate("The frozen validation request has inconsistent required check identities.");
    }
    return { template, row, request };
  } catch (error) {
    if (error instanceof StoredExecutionTemplateInvalidError) throw error;
    invalidTemplate(
      "The stored validation plan, published configuration, or execution template is invalid.",
    );
  }
}

function validatePublishedSnapshots(database: DatabaseSync, request: ReviewRunPlannedJob): void {
  const profile = request.profileVersion;
  const prompt = request.prompt?.version;
  if (profile === null || prompt === undefined)
    invalidTemplate("The validation request is not configured.");
  const publishedProfile = handlePromptConfigurationRequest(
    database,
    {
      operation: "getValidationProfileVersion",
      input: {
        repositoryId: profile.repositoryId,
        profileId: profile.profileId,
        versionId: profile.id,
      },
    },
    profile.publishedAt,
  ) as ValidationProfileVersion;
  const publishedPrompt = handlePromptConfigurationRequest(
    database,
    {
      operation: "getPromptVersion",
      input: { templateId: prompt.templateId, versionId: prompt.id },
    },
    prompt.publishedAt,
  ) as PromptVersion;
  if (
    canonicalJson(publishedProfile) !== canonicalJson(profile) ||
    canonicalJson(publishedPrompt) !== canonicalJson(prompt) ||
    sha256(canonicalJson(profile.config)) !== profile.configSha256 ||
    sha256(prompt.content) !== prompt.contentSha256 ||
    getValidationProfileConfigIssues(profile.config, request.workflowKind, request.target).length >
      0
  ) {
    invalidTemplate("The frozen profile or prompt differs from its published immutable version.");
  }
}

function validateTestedSource(plan: ReviewRunExecutionPlanV1, request: ReviewRunPlannedJob): void {
  const source = plan.testedSourceRevision;
  if (plan.workItem.kind === "pull_request") {
    if (
      plan.revision.kind !== "pull_request" ||
      source?.kind !== "pull_request" ||
      source.baseSha !== plan.revision.baseSha ||
      source.headSha !== plan.revision.headSha ||
      plan.revision.revisionKey !== sha256(`${plan.revision.baseSha}\0${plan.revision.headSha}`)
    ) {
      invalidTemplate("PR validation must use the exact frozen base and head revision.");
    }
  } else if (request.workflowKind === "issue_validation") {
    const authorization = plan.testedSourceAuthorization;
    if (
      source?.kind !== "commit" ||
      authorization === null ||
      authorization.headSha !== source.headSha ||
      authorization.activationId !== plan.activationId ||
      authorization.githubRepositoryId !== plan.repository.githubRepositoryId ||
      authorization.githubWorkItemId !== plan.workItem.githubWorkItemId ||
      authorization.issueRevisionKey !== plan.revision.revisionKey
    ) {
      invalidTemplate(
        "Issue validation requires explicit authorization for its exact tested source commit.",
      );
    }
  }
}

function expectedChecks(request: ReviewRunPlannedJob): ReadonlyMap<string, ExpectedCheck> {
  const profile = request.profileVersion;
  if (profile === null) invalidTemplate("The validation profile is missing.");
  const expected = new Map<string, ExpectedCheck>();
  const add = (id: string, check: ExpectedCheck): void => {
    const qualified = `${profile.id}:${id}`;
    if (expected.has(qualified))
      invalidTemplate("The validation profile repeats a check identity.");
    expected.set(qualified, check);
  };
  for (const phase of ["setup", "build", "test", "cleanup"] as const) {
    for (const step of profile.config[phase]) {
      add(step.id, {
        phase,
        kind: phase === "build" || phase === "test" ? phase : "static",
        required: step.required,
      });
    }
  }
  for (const scenario of profile.config.ui?.scenarios ?? []) {
    add(scenario.id, { phase: "ui", kind: "ui", required: scenario.required });
  }
  return expected;
}

function validateReportEvidence(
  result: Pick<ValidationJobResult, "report" | "execution">,
  expected: ReadonlyMap<string, ExpectedCheck>,
  template: JobExecutionTemplateV2,
  context: Pick<ReviewCompletionJobContext, "jobId" | "runAttemptId">,
  options: ValidationCompletionOptions,
  collectScopes?: ValidationEvidenceReferenceScope[],
): boolean {
  const checks = new Map<string, ValidationCheckResult>();
  const diagnosticSteps = new Map(expected);
  for (const step of template.validation.profileVersion.config.launch) {
    diagnosticSteps.set(`${template.validation.profileVersion.id}:${step.id}`, {
      phase: "launch",
      kind: "static",
      required: step.required,
    });
  }
  const finalizedChecks = new Set<string>();
  const verifiedScenarios = new Set<string>();
  for (const check of result.report.checks) {
    const planned = expected.get(check.id);
    if (
      checks.has(check.id) ||
      planned === undefined ||
      check.kind !== planned.kind ||
      check.required !== planned.required
    ) {
      invalidResult("The validation report repeats, invents, or changes a frozen profile check.");
    }
    if (check.evidenceIds.length > 0) {
      const scope = freeze({
        repositoryId: template.validation.repositoryId,
        runId: template.validation.runId,
        requestId: template.validation.requestId,
        jobId: context.jobId,
        runAttemptId: context.runAttemptId,
        profileVersionId: template.validation.profileVersion.id,
        checkId: check.id,
        evidenceIds: [...check.evidenceIds],
      });
      if (collectScopes !== undefined) {
        collectScopes.push(scope);
      } else {
        let referencesAreFinalized = false;
        try {
          referencesAreFinalized = options.validateEvidenceReferences?.(scope) === true;
        } catch {
          invalidResult("The validation report references unavailable evidence assets.");
        }
        if (!referencesAreFinalized)
          invalidResult("The validation report references unknown evidence assets.");
        finalizedChecks.add(check.id);
        if (check.kind === "ui" && options.validateScenarioEvidence?.(scope) === true)
          verifiedScenarios.add(check.id);
      }
    }
    checks.set(check.id, check);
  }
  const diagnostics = new Map<string, ValidationJobResult["execution"]["diagnostics"][number]>();
  for (const diagnostic of result.execution.diagnostics) {
    const planned = diagnosticSteps.get(diagnostic.stepId);
    const check = checks.get(diagnostic.stepId);
    if (
      diagnostics.has(diagnostic.stepId) ||
      planned === undefined ||
      diagnostic.phase !== planned.phase ||
      (check !== undefined && diagnostic.outcome !== check.outcome) ||
      (diagnostic.outcome === "passed" &&
        planned.phase !== "ui" &&
        planned.phase !== "launch" &&
        diagnostic.exitCode !== 0) ||
      (["not_run", "skipped"].includes(diagnostic.outcome) && diagnostic.exitCode !== null)
    ) {
      invalidResult("A validation diagnostic does not match its frozen step or reported outcome.");
    }
    diagnostics.set(diagnostic.stepId, diagnostic);
  }
  for (const blocker of result.execution.blockers) {
    if (blocker.stepId !== null) {
      const planned = diagnosticSteps.get(blocker.stepId);
      if (
        planned === undefined ||
        (planned.phase !== blocker.phase &&
          !(
            planned.phase === "ui" &&
            blocker.phase === "evidence" &&
            blocker.code === "UI_EVIDENCE_INCOMPLETE"
          ))
      ) {
        invalidResult("A validation lifecycle blocker does not match its frozen step.");
      }
    }
  }
  if (result.execution.blockers.length > 0) return false;
  if (
    template.validation.target !== "headless" &&
    (options.validateEvidenceReferences === undefined ||
      ![...expected].some(([, planned]) => planned.kind === "ui") ||
      [...expected].some(
        ([id, planned]) =>
          planned.kind === "ui" && (!finalizedChecks.has(id) || !verifiedScenarios.has(id)),
      ))
  )
    return false;
  const cleanup = template.validation.profileVersion.config.cleanup;
  if (result.execution.cleanupState !== (cleanup.length === 0 ? "not_needed" : "completed"))
    return false;
  if (
    [...diagnostics.values()].some(
      (diagnostic) => diagnostic.phase === "launch" && diagnostic.outcome !== "passed",
    )
  )
    return false;
  for (const [id, planned] of expected) {
    if (
      (planned.phase === "cleanup" || (planned.required && planned.phase === "setup")) &&
      checks.get(id)?.outcome !== "passed"
    )
      return false;
  }
  return [...expected.keys()].every((id) => {
    const check = checks.get(id);
    return check !== undefined && check.source === "runner" && diagnostics.has(id);
  });
}

function matchesDigest(first: string, second: string): boolean {
  return (
    typeof first === "string" &&
    first.length === 64 &&
    /^[a-f0-9]{64}$/u.test(first) &&
    timingSafeEqual(Buffer.from(first, "hex"), Buffer.from(second, "hex"))
  );
}

function invalidTemplate(message: string): never {
  throw new StoredExecutionTemplateInvalidError(message);
}
function invalidResult(message: string): never {
  throw new ReviewResultInvalidError(message);
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
