import type { DatabaseSync } from "node:sqlite";
import type { ValidationJobResult } from "@agentic-review/codex";
import {
  assertReviewRunExecutionPlan,
  type DashboardReviewRunReproductionCaseQuery,
  DashboardReviewRunReproductionCaseQuerySchema,
  type DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunReproductionCaseResponseSchema,
  type DashboardReviewRunReproductionSummary,
  type DashboardReviewRunResultReproduction,
  type IssueReproductionRequestAssessmentV1,
  JobExecutionTemplateV2Schema,
  maximumDashboardReproductionCaseResponseUtf8Bytes,
  maximumReviewRunPlanUtf8Bytes,
  maximumRunCompletionResultUtf8Bytes,
  type ReproductionObservationFact,
  type ReproductionObservationRef,
  type ReviewRunExecutionPlanV1,
} from "@agentic-review/contracts";
import {
  aggregateIssueReproduction,
  aggregateIssueReproductionRequest,
  deriveIssueReproductionCaseExecutions,
  evaluateIssueReproductionCases,
  validateFrozenIssueReproductionBinding,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  type ReproductionResultEvidence,
  recomputeIssueReproductionRequestAssessment,
} from "./issue-reproduction.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import { readValidationModelResultBindingInTransaction } from "./validation-model-result-binding.js";

export interface ReproductionReadScope {
  readonly repositoryId: string;
  readonly reviewRunId: string;
}
export interface ReproductionReadEvidence extends ReproductionResultEvidence {
  readonly assertCurrent?: () => void;
  readonly verificationStatus?: (
    requestId: string,
    jobId: string,
  ) => "verified" | "pending" | "unavailable" | undefined;
}
interface PlanRow {
  readonly plan_json: string;
  readonly plan_digest: string;
  readonly current: number;
}
interface LoadedPlan {
  readonly plan: ReviewRunExecutionPlanV1;
  readonly digest: string;
  readonly current: boolean;
}
interface RequestProjection {
  readonly jobId: string | null;
  readonly resultId: string | null;
  readonly recorded: IssueReproductionRequestAssessmentV1 | null;
  readonly current: IssueReproductionRequestAssessmentV1;
  readonly observations: readonly ReproductionObservationFact[];
}
interface ResultRow {
  readonly job_id: string;
  readonly activation_number: number;
  readonly latest_activation: number;
  readonly status: string;
  readonly execution_json: string;
  readonly execution_digest: string;
  readonly result_id: string | null;
  readonly run_attempt_id: string | null;
  readonly result_json: string | null;
  readonly result_digest: string | null;
  readonly schema_id: string | null;
}

/** Bounded metadata and inline receipts only; this module never reads or reparses evidence files. */
export function readIssueReproductionRunSummary(
  database: DatabaseSync,
  scope: ReproductionReadScope,
  evidence: ReproductionReadEvidence = {},
): DashboardReviewRunReproductionSummary | undefined {
  const loaded = loadPlan(database, scope, evidence);
  const frozen = loaded?.plan.reproduction;
  if (loaded === undefined || frozen === undefined) return undefined;
  const requestIds = [...new Set(frozen.binding.cases.map((entry) => entry.requestId))];
  const cases = requestIds.flatMap(
    (requestId) => projectRequest(database, scope, loaded, requestId, evidence).current.cases,
  );
  return {
    bindingDigest: frozen.bindingDigest,
    claim: frozen.binding.claim,
    caseCount: frozen.binding.cases.length,
    cases: frozen.binding.cases.map((entry) => ({
      caseId: entry.id,
      requestId: entry.requestId,
      profileVersionId: entry.profileVersionId,
      target: entry.target,
      context: entry.context,
    })),
    assessment: aggregateIssueReproduction(frozen, loaded.digest, cases),
  };
}

export function readIssueReproductionResult(
  database: DatabaseSync,
  scope: ReproductionReadScope & { readonly requestId: string; readonly jobId: string },
  evidence: ReproductionReadEvidence = {},
): DashboardReviewRunResultReproduction | undefined {
  const loaded = loadPlan(database, scope, evidence);
  if (
    loaded?.plan.reproduction === undefined ||
    !loaded.plan.reproduction.binding.cases.some((entry) => entry.requestId === scope.requestId)
  )
    return undefined;
  const projection = projectRequest(
    database,
    scope,
    loaded,
    scope.requestId,
    evidence,
    scope.jobId,
  );
  return projection.recorded === null
    ? undefined
    : { recordedAssessment: projection.recorded, currentAssessment: projection.current };
}

/** The caller must prepare selected current evidence asynchronously before entering this transaction. */
export function readIssueReproductionCaseInTransaction(
  database: DatabaseSync,
  query: DashboardReviewRunReproductionCaseQuery,
  evidence: ReproductionReadEvidence = {},
): DashboardReviewRunReproductionCaseResponse | null {
  if (!database.isTransaction || !Value.Check(DashboardReviewRunReproductionCaseQuerySchema, query))
    throw new ReproductionProjectionError(
      "PLATFORM_INVALID",
      "The reproduction case query requires a valid scope and an active transaction.",
    );
  const loaded = loadPlan(database, query, evidence);
  const frozen = loaded?.plan.reproduction;
  if (loaded === undefined || frozen === undefined) return null;
  const selected = frozen.binding.cases.find(
    (entry) => entry.id === query.caseId && entry.requestId === query.requestId,
  );
  if (selected === undefined) return null;
  const projection = projectRequest(
    database,
    query,
    loaded,
    query.requestId,
    evidence,
    query.jobId,
  );
  if (query.jobId !== undefined && projection.jobId !== query.jobId) return null;
  const current = projection.current.cases.find((entry) => entry.caseId === query.caseId);
  if (current === undefined) corrupt();
  const refs = new Set(
    [
      ...selected.presentWhen.allOf,
      ...(selected.absentWhen?.allOf ?? []),
      ...selected.preconditions.flatMap((control) =>
        control.kind === "observation_equals" ? [control.predicate] : [],
      ),
    ].map((predicate) => refKey(predicate.observation)),
  );
  const { cases: _cases, ...binding } = frozen.binding;
  const response: DashboardReviewRunReproductionCaseResponse = {
    repositoryId: query.repositoryId,
    reviewRunId: query.reviewRunId,
    requestId: query.requestId,
    caseId: query.caseId,
    jobId: projection.jobId,
    resultId: projection.resultId,
    binding,
    case: selected,
    bindingDigest: frozen.bindingDigest,
    planDigest: loaded.digest,
    recorded: projection.recorded?.cases.find((entry) => entry.caseId === query.caseId) ?? null,
    current,
    observations: projection.observations.filter((fact) => refs.has(refKey(fact.observation))),
  };
  if (
    !Value.Check(DashboardReviewRunReproductionCaseResponseSchema, response) ||
    Buffer.byteLength(canonicalJson(response), "utf8") >
      maximumDashboardReproductionCaseResponseUtf8Bytes
  )
    corrupt();
  evidence.assertCurrent?.();
  return response;
}

function loadPlan(
  database: DatabaseSync,
  scope: ReproductionReadScope,
  evidence: ReproductionReadEvidence,
): LoadedPlan | undefined {
  if (!database.isTransaction) corrupt();
  // Preserve the legacy read path and its prepared-token behavior when no binding was frozen.
  if (
    database
      .prepare(
        "SELECT 1 FROM review_runs WHERE purpose = 'review' AND repository_id = ? AND id = ? AND json_type(plan_json, '$.reproduction') = 'object'",
      )
      .get(scope.repositoryId, scope.reviewRunId) === undefined
  )
    return undefined;
  evidence.assertCurrent?.();
  const row = database
    .prepare(`SELECT run.plan_json, run.plan_digest,
    (item.state = 'open' AND item.current_revision_key = run.revision_key AND epoch.status = 'active'
      AND revision.revision_key = run.revision_key AND repository.enabled = 1
      AND epoch.ordinal = json_extract(run.plan_json, '$.authorization.sequence')
      AND epoch.target_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND repository.reviewer_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND repository.authorization_policy_json IS NOT NULL
      AND NOT EXISTS (SELECT key, value, type FROM json_each(repository.authorization_policy_json)
        EXCEPT SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy'))
      AND NOT EXISTS (SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy')
        EXCEPT SELECT key, value, type FROM json_each(repository.authorization_policy_json))
      AND NOT EXISTS (SELECT 1 FROM github_review_run_activations AS activation
        LEFT JOIN github_review_run_sources AS source ON source.work_item_id = activation.work_item_id
        WHERE activation.mode = 'review_run' AND activation.review_run_id = run.id
          AND (activation.request_epoch_id IS NOT run.request_epoch_id OR activation.revision_key IS NOT run.revision_key
            OR source.sequence IS NOT activation.source_sequence OR source.current_revision_key IS NOT activation.revision_key))) AS current
    FROM review_runs AS run
    JOIN managed_repositories AS repository ON repository.id = run.repository_id
    JOIN work_items AS item ON item.id = run.work_item_id AND item.repository_id = repository.id
    JOIN request_epochs AS epoch ON epoch.id = run.request_epoch_id AND epoch.work_item_id = item.id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id AND revision.work_item_id = item.id
    WHERE run.purpose = 'review' AND run.repository_id = ? AND run.id = ? AND json_type(run.plan_json, '$.reproduction') = 'object'`)
    .get(scope.repositoryId, scope.reviewRunId) as PlanRow | undefined;
  if (row === undefined) return undefined;
  if (
    Buffer.byteLength(row.plan_json, "utf8") > maximumReviewRunPlanUtf8Bytes ||
    sha256(row.plan_json) !== row.plan_digest
  )
    corrupt();
  const plan: unknown = JSON.parse(row.plan_json);
  assertReviewRunExecutionPlan(plan);
  if (
    plan.reproduction === undefined ||
    canonicalJson(plan) !== row.plan_json ||
    plan.repository.id !== scope.repositoryId ||
    plan.workItem.kind !== "issue"
  )
    corrupt();
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
  return { plan, digest: row.plan_digest, current: row.current === 1 };
}

function projectRequest(
  database: DatabaseSync,
  scope: ReproductionReadScope,
  loaded: LoadedPlan,
  requestId: string,
  evidence: ReproductionReadEvidence,
  jobId?: string,
): RequestProjection {
  const { plan } = loaded;
  const frozen = plan.reproduction;
  const request = plan.jobs.find((entry) => entry.requestId === requestId);
  if (
    frozen === undefined ||
    request?.profileVersion === null ||
    request === undefined ||
    plan.testedSourceRevision?.kind !== "commit"
  )
    corrupt();
  // Terminal completion clears the active lease pointer. The accepted result instead binds to
  // the final succeeded attempt below, including its attempt number and immutable result digest.
  const row = database
    .prepare(`SELECT job.id AS job_id, link.activation_number, job.status, job.execution_json, job.execution_digest,
      (SELECT MAX(latest.activation_number) FROM review_run_job_links AS latest WHERE latest.review_run_id = link.review_run_id AND latest.request_id = link.request_id) AS latest_activation,
      result.id AS result_id, result.run_attempt_id, result.result_json, result.result_digest, result.schema_id
    FROM review_run_job_links AS link JOIN jobs AS job ON job.id = link.job_id
    JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'review'
    LEFT JOIN validation_job_results AS result ON result.job_id = job.id AND job.status = 'succeeded'
      AND result.review_run_id = run.id
      AND result.request_id = link.request_id AND result.job_activation = link.activation_number
      AND result.repository_id = run.repository_id AND result.work_item_id = run.work_item_id
      AND result.resource_revision = run.revision_key AND result.activation_id = run.activation_id
      AND result.plan_digest = run.plan_digest AND result.execution_template_sha256 = job.execution_digest
      AND EXISTS (SELECT 1 FROM run_attempts AS attempt WHERE attempt.id = result.run_attempt_id AND attempt.job_id = job.id
        AND attempt.status = 'succeeded' AND attempt.attempt_number = job.attempt_count AND attempt.result_digest = result.result_digest)
    WHERE run.repository_id = ? AND run.id = ? AND link.request_id = ?
      AND job.work_item_id = run.work_item_id AND job.resource_revision = run.revision_key AND job.request_epoch_id = run.request_epoch_id
      AND (? IS NULL OR job.id = ?) ORDER BY link.activation_number DESC LIMIT 1`)
    .get(scope.repositoryId, scope.reviewRunId, requestId, jobId ?? null, jobId ?? null) as
    | ResultRow
    | undefined;
  const fallback = (
    reason: "execution_pending" | "execution_blocked" | "invalid_scope" | "evidence_unavailable",
    recorded: IssueReproductionRequestAssessmentV1 | null = null,
  ): RequestProjection => {
    const executions = deriveIssueReproductionCaseExecutions({
      frozen,
      planDigest: loaded.digest,
      request,
      issueRevisionKey: plan.revision.revisionKey,
      testedSourceCommit: plan.testedSourceRevision?.headSha ?? "",
      report: null,
      execution: null,
      observations: [],
      evidenceComplete: true,
      state: reason === "execution_pending" ? "pending" : "blocked",
    });
    const assessments = evaluateIssueReproductionCases(
      frozen.binding,
      executions.map((execution) => ({
        ...execution,
        reasons: reason === "execution_pending" ? [] : [reason],
      })),
    ).filter((entry) => entry.requestId === requestId);
    return {
      jobId: row?.job_id ?? null,
      resultId: row?.result_id ?? null,
      recorded,
      current: aggregateIssueReproductionRequest(frozen, loaded.digest, requestId, assessments),
      observations: [],
    };
  };
  if (
    row?.result_json === null ||
    row === undefined ||
    row.run_attempt_id === null ||
    row.result_digest === null
  ) {
    const readiness =
      row === undefined
        ? (database
            .prepare(`SELECT
      CASE WHEN dispatched.checked_at IS NOT NULL THEN json_array_length(dispatched.blockers_json) > 0
        ELSE json_extract(readiness.value, '$.state') IS 'blocked' END AS blocked
      FROM review_runs AS run
      LEFT JOIN validation_dispatch_checks AS dispatched ON dispatched.review_run_id = run.id
        AND dispatched.repository_id = run.repository_id AND dispatched.request_id = ?,
      json_each(run.readiness_json) AS readiness
      WHERE run.purpose = 'review' AND run.id = ? AND run.repository_id = ? AND json_extract(readiness.value, '$.requestId') IS ?`)
            .get(requestId, scope.reviewRunId, scope.repositoryId, requestId) as
            | { blocked: number }
            | undefined)
        : undefined;
    return fallback(
      !loaded.current
        ? "invalid_scope"
        : readiness?.blocked === 1 ||
            (row !== undefined &&
              !["queued", "leased", "running", "retry_waiting"].includes(row.status))
          ? "execution_blocked"
          : "execution_pending",
    );
  }
  if (
    Buffer.byteLength(row.result_json, "utf8") > maximumRunCompletionResultUtf8Bytes ||
    sha256(row.result_json) !== row.result_digest ||
    Buffer.byteLength(row.execution_json, "utf8") > maximumReviewRunPlanUtf8Bytes ||
    sha256(row.execution_json) !== row.execution_digest
  )
    corrupt();
  let result: ValidationJobResult;
  try {
    if (row.schema_id === null) corrupt();
    result = decodeStoredValidationResult(row.schema_id, row.result_json, row.result_digest);
    readValidationModelResultBindingInTransaction(
      database,
      {
        repositoryId: scope.repositoryId,
        runId: scope.reviewRunId,
        requestId,
        jobId: row.job_id,
        runAttemptId: row.run_attempt_id,
        resultDigest: row.result_digest,
        executionDigest: row.execution_digest,
      },
      result,
    );
  } catch {
    corrupt();
  }
  const template: unknown = JSON.parse(row.execution_json);
  if (
    !Value.Check(JobExecutionTemplateV2Schema, template) ||
    result.report.workItemKind !== "issue" ||
    !("reproductionAssessment" in result) ||
    result.reproductionAssessment === undefined
  )
    corrupt();
  const validation = template.validation;
  if (
    validation.runId !== scope.reviewRunId ||
    template.resource.kind !== "issue" ||
    template.resource.revisionDigest !== plan.revision.revisionKey ||
    template.repository.githubRepositoryId !== plan.repository.githubRepositoryId ||
    template.resource.githubNodeId !== plan.workItem.githubNodeId ||
    validation.repositoryId !== scope.repositoryId ||
    validation.requestId !== requestId ||
    validation.jobActivation !== row.activation_number ||
    validation.planDigest !== loaded.digest ||
    validation.workItemId !== plan.workItemId ||
    validation.revisionKey !== plan.revision.revisionKey ||
    validation.activationId !== plan.activationId ||
    validation.requestEpochId !== plan.authorization.requestEpochId ||
    canonicalJson(validation.profileVersion) !== canonicalJson(request.profileVersion) ||
    canonicalJson(validation.reproduction) !== canonicalJson(frozen)
  )
    corrupt();
  const recorded = result.reproductionAssessment;
  if (result.report.reproductionConclusion !== recorded.conclusion) corrupt();
  // Schema validation alone cannot establish that a persisted assessment has the expected cases.
  if (
    canonicalJson(
      aggregateIssueReproductionRequest(frozen, loaded.digest, requestId, recorded.cases),
    ) !== canonicalJson(recorded)
  )
    corrupt();
  if (!loaded.current || row.activation_number !== row.latest_activation)
    return fallback("invalid_scope", recorded);
  let current: ReturnType<typeof recomputeIssueReproductionRequestAssessment>;
  try {
    current = recomputeIssueReproductionRequestAssessment(
      {
        validation,
        jobId: row.job_id,
        runAttemptId: row.run_attempt_id,
        result,
      },
      evidence,
    );
  } catch {
    evidence.assertCurrent?.();
    return fallback("evidence_unavailable", recorded);
  }
  if (current === undefined) corrupt();
  if (evidence.verificationStatus?.(requestId, row.job_id) === "pending") {
    const currentObservations = current.observations;
    const cases = current.assessment.cases.map((assessment) => {
      const selected = frozen.binding.cases.find((entry) => entry.id === assessment.caseId);
      if (selected === undefined) corrupt();
      const predicates = [
        ...selected.presentWhen.allOf,
        ...(selected.absentWhen?.allOf ?? []),
        ...selected.preconditions.flatMap((control) =>
          control.kind === "observation_equals" ? [control.predicate] : [],
        ),
      ];
      const dependsOnUi =
        predicates.some((predicate) => predicate.observation.kind === "ui_assertion") ||
        selected.preconditions.some(
          (control) =>
            control.kind === "check_passed" &&
            request.profileVersion?.config.ui?.scenarios.some(
              (scenario) => `${request.profileVersion?.id}:${scenario.id}` === control.checkId,
            ),
        );
      const refs = new Set(predicates.map((predicate) => refKey(predicate.observation)));
      const knownUnavailable = currentObservations.some(
        (fact) =>
          refs.has(refKey(fact.observation)) &&
          fact.state === "unavailable" &&
          fact.reason !== "not_run",
      );
      return dependsOnUi &&
        !knownUnavailable &&
        assessment.state === "blocked" &&
        assessment.reasons.length > 0 &&
        assessment.reasons.every(
          (reason) =>
            reason === "observation_unavailable" ||
            reason === "precondition_unavailable" ||
            reason === "evidence_unavailable",
        )
        ? { ...assessment, state: "inconclusive" as const, reasons: ["execution_pending" as const] }
        : assessment;
    });
    current = {
      ...current,
      assessment: aggregateIssueReproductionRequest(frozen, loaded.digest, requestId, cases),
    };
  }
  evidence.assertCurrent?.();
  return {
    jobId: row.job_id,
    resultId: row.result_id,
    recorded,
    current: current.assessment,
    observations: current.observations,
  };
}

function refKey(ref: ReproductionObservationRef): string {
  return ref.kind === "ui_assertion"
    ? JSON.stringify([ref.kind, ref.scenarioId, ref.stepId])
    : JSON.stringify([ref.kind, ref.testStepId, ref.observationId]);
}
function corrupt(): never {
  throw new ReproductionProjectionError(
    "PLATFORM_CORRUPT",
    "The stored reproduction projection does not match its frozen scope.",
  );
}

class ReproductionProjectionError extends Error {
  public constructor(
    public readonly code: "PLATFORM_INVALID" | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "ReproductionProjectionError";
  }
}
