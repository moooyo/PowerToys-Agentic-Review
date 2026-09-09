import type { DatabaseSync } from "node:sqlite";
import {
  assertReproductionObservationFact,
  type IssueReproductionRequestAssessmentV1,
  isSafeUiObservationText,
  type JobExecutionTemplateV2,
  maximumRunCompletionResultUtf8Bytes,
  maximumTestProbeOutputUtf8Bytes,
  type ReproductionObservationFact,
  type ReproductionObservationRef,
  type TestProbeReceiptV1,
  TestProbeReceiptV1Schema,
  type ValidationExecutionDetails,
  type ValidationJobContext,
  type ValidationJobContextV2,
  type ValidationReportV1,
} from "@agentic-review/contracts";
import {
  aggregateIssueReproductionRequest,
  deriveIssueReproductionCaseExecutions,
  evaluateIssueReproductionCases,
  validateEvaluationIssueReproductionBinding,
  validateFrozenIssueReproductionBinding,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { ReviewResultInvalidError, StoredExecutionTemplateInvalidError } from "./errors.js";
import { readEvaluationJobBindingInTransaction } from "./evaluation-execution.js";
import type { ValidationEvidenceReferenceScope } from "./validation-results.js";

export interface ReproductionResultScope {
  readonly validation: ValidationJobContext | ValidationJobContextV2;
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly result: {
    readonly report: ValidationReportV1;
    readonly execution: ValidationExecutionDetails;
    readonly probeReceipts?: TestProbeReceiptV1[];
    readonly reproductionAssessment?: IssueReproductionRequestAssessmentV1;
  };
}

export interface ReproductionResultEvidence {
  readonly readScenarioObservations?: (
    scope: ValidationEvidenceReferenceScope,
  ) => readonly ReproductionObservationFact[] | null;
  readonly validateEvidenceReferences?: (scope: ValidationEvidenceReferenceScope) => boolean;
  readonly validateScenarioEvidence?: (scope: ValidationEvidenceReferenceScope) => boolean;
}

/** Independently verifies stored complete probe documents. Diagnostic previews are never parsed. */
export function validateProbeReceiptObservations(
  input: ReproductionResultScope,
): ReproductionObservationFact[] {
  const { validation, result } = input;
  const profile = validation.profileVersion;
  const declarations = new Map(
    profile.config.test
      .filter((step) => step.probeOutput !== undefined)
      .map((step) => [`${profile.id}:${step.id}`, step]),
  );
  const checks = new Map(result.report.checks.map((check) => [check.id, check]));
  const diagnostics = new Map(
    result.execution.diagnostics.map((diagnostic) => [diagnostic.stepId, diagnostic]),
  );
  if (
    checks.size !== result.report.checks.length ||
    diagnostics.size !== result.execution.diagnostics.length
  )
    invalid("Probe execution identities must be unique.");
  const receipts = result.probeReceipts ?? [];
  if (Buffer.byteLength(canonicalJson(receipts), "utf8") > maximumRunCompletionResultUtf8Bytes)
    invalid("Probe receipts exceed the result byte limit.");
  const seen = new Set<string>();
  const facts: ReproductionObservationFact[] = [];
  for (const receipt of receipts) {
    if (!Value.Check(TestProbeReceiptV1Schema, receipt))
      invalid("The probe receipt shape is invalid.");
    const step = declarations.get(receipt.checkId);
    const declaration = step?.probeOutput;
    const check = checks.get(receipt.checkId);
    const diagnostic = diagnostics.get(receipt.checkId);
    if (
      seen.has(receipt.checkId) ||
      step === undefined ||
      declaration === undefined ||
      receipt.requestId !== validation.requestId ||
      receipt.jobId !== input.jobId ||
      receipt.runAttemptId !== input.runAttemptId ||
      receipt.planDigest !== validation.planDigest ||
      receipt.profileVersionId !== profile.id ||
      receipt.capture !== "complete" ||
      result.report.source !== "worker" ||
      check?.source !== "runner" ||
      check.kind !== "test" ||
      check.outcome !== "passed" ||
      diagnostic?.phase !== "test" ||
      diagnostic.outcome !== "passed" ||
      diagnostic.exitCode !== 0
    )
      invalid("The probe receipt is not bound to a successfully settled frozen test command.");
    const json = canonicalJson(receipt.output);
    if (
      Buffer.byteLength(json, "utf8") > maximumTestProbeOutputUtf8Bytes ||
      sha256(json) !== receipt.outputSha256
    )
      invalid("The complete probe document does not match its bounded canonical digest.");
    const fields = new Map(declaration.fields.map((field) => [field.id, field.type]));
    const observedIds = new Set<string>();
    if (fields.size !== declaration.fields.length)
      invalid("The frozen probe declares duplicate fields.");
    for (const observation of receipt.output.observations) {
      const expectedType = fields.get(observation.id);
      if (
        observedIds.has(observation.id) ||
        expectedType === undefined ||
        (observation.state === "observed" &&
          (observation.value.type !== expectedType ||
            (observation.value.type === "string" &&
              !isSafeUiObservationText(observation.value.value)) ||
            (observation.value.type === "number" && !Number.isFinite(observation.value.value))))
      )
        invalid(
          "The probe document contains an undeclared, duplicate, unsafe, or incorrectly typed field.",
        );
      observedIds.add(observation.id);
      const ref: ReproductionObservationRef = {
        kind: "probe_value",
        testStepId: step.id,
        observationId: observation.id,
      };
      facts.push(
        observation.state === "observed"
          ? {
              observation: ref,
              checkId: receipt.checkId,
              evidenceIds: [],
              state: "observed",
              value: observation.value,
            }
          : {
              observation: ref,
              checkId: receipt.checkId,
              evidenceIds: [],
              state: "unavailable",
              reason: "unsafe_value",
            },
      );
    }
    if (observedIds.size !== fields.size) invalid("The probe document omits declared fields.");
    seen.add(receipt.checkId);
  }
  for (const checkId of declarations.keys()) {
    const check = checks.get(checkId);
    const diagnostic = diagnostics.get(checkId);
    const successful =
      check?.source === "runner" &&
      check.kind === "test" &&
      check.outcome === "passed" &&
      diagnostic?.phase === "test" &&
      diagnostic.outcome === "passed" &&
      diagnostic.exitCode === 0;
    if ((check?.outcome === "passed" && !successful) || (successful && !seen.has(checkId)))
      invalid("Every successful declared probe requires exactly one complete receipt.");
  }
  return facts;
}

/** Recomputes only this request from current admitted evidence; model conclusions are ignored. */
export function recomputeIssueReproductionRequestAssessment(
  input: ReproductionResultScope,
  evidence: ReproductionResultEvidence = {},
):
  | {
      readonly assessment: IssueReproductionRequestAssessmentV1;
      readonly observations: readonly ReproductionObservationFact[];
    }
  | undefined {
  const probeFacts = validateProbeReceiptObservations(input);
  const { validation, result } = input;
  const frozen = validation.reproduction;
  if (frozen === undefined) return undefined;
  const profile = validation.profileVersion;
  const authorization = validation.testedSourceAuthorization;
  if (
    (validation.schemaVersion === "ValidationJobContextV1" && authorization === null) ||
    validation.testedSourceRevision?.kind !== "commit" ||
    result.report.workItemKind !== "issue"
  )
    invalid("Mapped reproduction requires an Issue and its exact source authorization.");
  if (validation.schemaVersion === "ValidationJobContextV2") {
    validateEvaluationIssueReproductionBinding(validation);
  } else {
    if (authorization === null)
      invalid("The ordinary reproduction source authorization is missing.");
    validateFrozenIssueReproductionBinding(
      frozen,
      [validation],
      {
        activationId: validation.activationId,
        repositoryId: validation.repositoryId,
        githubRepositoryId: authorization.githubRepositoryId,
        workItemId: validation.workItemId,
        githubWorkItemId: authorization.githubWorkItemId,
        workItemKind: "issue",
        issueRevisionKey: validation.revisionKey,
        testedSourceRevision: validation.testedSourceRevision,
        testedSourceAuthorization: authorization,
      },
      validation.requestId,
    );
  }
  const selected = frozen.binding.cases.filter((entry) => entry.requestId === validation.requestId);
  const refs = new Map<string, ReproductionObservationRef>();
  for (const entry of selected) {
    for (const predicate of [
      ...entry.presentWhen.allOf,
      ...(entry.absentWhen?.allOf ?? []),
      ...entry.preconditions.flatMap((control) =>
        control.kind === "observation_equals" ? [control.predicate] : [],
      ),
    ])
      refs.set(refKey(predicate.observation), predicate.observation);
  }
  const scenarioIds = new Set(
    [...refs.values()].flatMap((ref) => (ref.kind === "ui_assertion" ? [ref.scenarioId] : [])),
  );
  for (const entry of selected) {
    for (const control of entry.preconditions) {
      if (control.kind === "check_passed") {
        const scenario = profile.config.ui?.scenarios.find(
          (candidate) => `${profile.id}:${candidate.id}` === control.checkId,
        );
        if (scenario !== undefined) scenarioIds.add(scenario.id);
      }
    }
  }
  const facts = [...probeFacts];
  const unavailable: string[] = [];
  for (const scenarioId of scenarioIds) {
    const checkId = `${profile.id}:${scenarioId}`;
    const check = result.report.checks.find((entry) => entry.id === checkId);
    const scope: ValidationEvidenceReferenceScope = {
      repositoryId: validation.repositoryId,
      runId: validation.runId,
      requestId: validation.requestId,
      jobId: input.jobId,
      runAttemptId: input.runAttemptId,
      profileVersionId: profile.id,
      checkId,
      evidenceIds: check?.evidenceIds ?? [],
    };
    let observations: readonly ReproductionObservationFact[] | null = null;
    try {
      if (scope.evidenceIds.length > 0 && evidence.validateEvidenceReferences?.(scope) === true) {
        const selectedObservations = [...refs.values()].some(
          (ref) => ref.kind === "ui_assertion" && ref.scenarioId === scenarioId,
        );
        observations = selectedObservations
          ? (evidence.readScenarioObservations?.(scope) ?? null)
          : evidence.validateScenarioEvidence?.(scope) === true
            ? []
            : null;
      }
    } catch {
      observations = null;
    }
    if (observations === null) {
      unavailable.push(checkId);
      continue;
    }
    const seen = new Set<string>();
    for (const fact of observations) {
      assertReproductionObservationFact(fact);
      const key = refKey(fact.observation);
      if (
        fact.checkId !== checkId ||
        fact.observation.kind !== "ui_assertion" ||
        fact.observation.scenarioId !== scenarioId ||
        !refs.has(key) ||
        seen.has(key)
      )
        invalid("Verified UI observations do not match the selected frozen scenario references.");
      if (
        fact.state === "observed" &&
        fact.value.type === "string" &&
        !isSafeUiObservationText(fact.value.value)
      )
        invalid("Verified UI observations must retain complete safe values.");
      seen.add(key);
      facts.push(fact);
    }
    for (const ref of refs.values()) {
      if (ref.kind === "ui_assertion" && ref.scenarioId === scenarioId && !seen.has(refKey(ref)))
        unavailable.push(checkId);
    }
  }
  const executions = deriveIssueReproductionCaseExecutions({
    frozen,
    planDigest: validation.planDigest,
    request: validation,
    issueRevisionKey: validation.revisionKey,
    testedSourceCommit: validation.testedSourceRevision.headSha,
    report: result.report,
    execution: result.execution,
    observations: facts,
    evidenceComplete: true,
    evidenceUnavailableCheckIds: [...new Set(unavailable)],
  });
  const cases = evaluateIssueReproductionCases(frozen.binding, executions).filter(
    (entry) => entry.requestId === validation.requestId,
  );
  return {
    assessment: aggregateIssueReproductionRequest(
      frozen,
      validation.planDigest,
      validation.requestId,
      cases,
    ),
    observations: facts.filter((fact) => refs.has(refKey(fact.observation))),
  };
}

export function validateIssueReproductionResult(
  input: ReproductionResultScope,
  evidence: ReproductionResultEvidence = {},
): void {
  const recomputed = recomputeIssueReproductionRequestAssessment(input, evidence);
  const recorded =
    "reproductionAssessment" in input.result ? input.result.reproductionAssessment : undefined;
  if (recomputed === undefined) {
    if (recorded !== undefined)
      invalid("An unmapped request cannot submit a reproduction assessment.");
    return;
  }
  if (
    recorded === undefined ||
    input.result.report.workItemKind !== "issue" ||
    canonicalJson(recorded) !== canonicalJson(recomputed.assessment) ||
    input.result.report.reproductionConclusion !== recomputed.assessment.conclusion
  )
    invalid("The reproduction assessment differs from independently verified runner observations.");
}

/** Call in the final completion transaction, after all asynchronous evidence work has finished. */
export function assertCurrentIssueReproductionAuthorization(
  database: DatabaseSync,
  template: JobExecutionTemplateV2,
  scope: { readonly jobId: string; readonly runAttemptId: string },
): void {
  const validation = template.validation;
  if (validation.reproduction === undefined) return;
  if (!database.isTransaction)
    throw new StoredExecutionTemplateInvalidError(
      "Mapped completion requires a final authorization transaction.",
    );
  if (validation.schemaVersion === "ValidationJobContextV2") {
    try {
      validateEvaluationIssueReproductionBinding(validation);
      const cell = readEvaluationJobBindingInTransaction(database, scope.jobId, template);
      const current = database
        .prepare(`SELECT 1 FROM jobs AS job JOIN run_attempts AS attempt ON attempt.id = job.current_run_attempt_id
        AND attempt.job_id = job.id AND attempt.lease_generation = job.lease_generation
        JOIN workers AS worker ON worker.id = attempt.worker_id AND worker.node_id = attempt.worker_node_id
          AND worker.instance_id = attempt.worker_instance_id
        WHERE job.id = ? AND attempt.id = ? AND job.status IN ('leased','running')
        AND worker.superseded_at IS NULL AND job.cancellation_requested_at IS NULL`)
        .get(scope.jobId, scope.runAttemptId);
      if (
        !current ||
        !cell.applicable ||
        !cell.repositoryEnabled ||
        cell.controlStatus !== "active" ||
        cell.reproductionReadiness.state !== "ready"
      )
        throw new Error("The evaluation reproduction authority is not current.");
      return;
    } catch {
      throw new StoredExecutionTemplateInvalidError(
        "The current sealed evaluation reproduction authority is invalid.",
      );
    }
  }
  const current = database
    .prepare(`SELECT 1 AS current
    FROM review_runs AS run
    JOIN managed_repositories AS repository ON repository.id = run.repository_id
    JOIN work_items AS item ON item.id = run.work_item_id AND item.repository_id = run.repository_id
    JOIN request_epochs AS epoch ON epoch.id = run.request_epoch_id AND epoch.work_item_id = item.id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id AND revision.work_item_id = item.id
    JOIN review_run_job_links AS link ON link.review_run_id = run.id AND link.request_id = ? AND link.job_id = ?
    JOIN jobs AS job ON job.id = link.job_id AND job.current_run_attempt_id = ?
    WHERE run.id = ? AND run.repository_id = ? AND run.work_item_id = ? AND run.plan_digest = ?
      AND run.activation_id = ? AND run.revision_key = ? AND run.request_epoch_id = ?
      AND item.resource_kind = 'issue' AND item.state = 'open' AND item.current_revision_key = run.revision_key
      AND repository.enabled = 1 AND epoch.status = 'active' AND revision.revision_key = run.revision_key
      AND epoch.ordinal = json_extract(run.plan_json, '$.authorization.sequence')
      AND epoch.target_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND repository.reviewer_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND repository.authorization_policy_json IS NOT NULL
      AND NOT EXISTS (SELECT key, value, type FROM json_each(repository.authorization_policy_json)
        EXCEPT SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy'))
      AND NOT EXISTS (SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy')
        EXCEPT SELECT key, value, type FROM json_each(repository.authorization_policy_json))
      AND link.activation_number = (SELECT MAX(latest.activation_number) FROM review_run_job_links AS latest
        WHERE latest.review_run_id = run.id AND latest.request_id = link.request_id)
      AND NOT EXISTS (SELECT 1 FROM github_review_run_activations AS activation
        LEFT JOIN github_review_run_sources AS source ON source.work_item_id = activation.work_item_id
        WHERE activation.mode = 'review_run' AND activation.review_run_id = run.id
          AND (activation.request_epoch_id IS NOT run.request_epoch_id OR activation.revision_key IS NOT run.revision_key
            OR source.sequence IS NOT activation.source_sequence OR source.current_revision_key IS NOT activation.revision_key))`)
    .get(
      validation.requestId,
      scope.jobId,
      scope.runAttemptId,
      validation.runId,
      validation.repositoryId,
      validation.workItemId,
      validation.planDigest,
      validation.activationId,
      validation.revisionKey,
      validation.requestEpochId,
    );
  if (current === undefined)
    throw new StoredExecutionTemplateInvalidError(
      "The Issue, current request, or repository authorization changed before mapped completion.",
    );
}

function refKey(ref: ReproductionObservationRef): string {
  return ref.kind === "ui_assertion"
    ? JSON.stringify([ref.kind, ref.scenarioId, ref.stepId])
    : JSON.stringify([ref.kind, ref.testStepId, ref.observationId]);
}
function invalid(message: string): never {
  throw new ReviewResultInvalidError(message);
}
