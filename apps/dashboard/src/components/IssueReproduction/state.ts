import type {
  DashboardReviewRunReproductionCaseQuery,
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunResult,
  IssueReproductionAssessmentV1,
  IssueReproductionCaseAssessment,
  IssueReproductionCaseReason,
  ObservationValue,
  OperatorPrincipal,
  ReproductionObservationFact,
  ReproductionObservationRef,
  ValidationTarget,
} from "@agentic-review/contracts";
import type { EvidenceScope } from "../../services/evidence";

export interface ReproductionCaseSelection extends DashboardReviewRunReproductionCaseQuery {
  readonly workItemId: string;
  readonly bindingDigest: string;
  readonly planDigest: string;
  readonly issueRevisionKey: string;
  readonly testedSourceCommit: string;
  readonly profileVersionId: string;
  readonly target: ValidationTarget;
  readonly resultId?: string;
  readonly executionKey?: string;
}

export const reproductionTargetLabel: Record<ValidationTarget, string> = {
  headless: "Headless",
  web: "Web UI",
  windows_desktop: "Windows UI",
};

export const reproductionReasonLabel: Record<IssueReproductionCaseReason, string> = {
  execution_pending: "Execution or evidence verification is pending",
  execution_blocked: "Execution is blocked",
  precondition_failed: "A required precondition failed",
  precondition_unavailable: "A required precondition is unavailable",
  observation_unavailable: "A selected observation is unavailable",
  signature_not_matched: "Neither configured signature matched",
  positive_only: "No absent signature was configured",
  conflicting_signatures: "Present and absent signatures conflict",
  source_unverified: "The tested source could not be verified",
  capture_unavailable: "The required capture is unavailable",
  evidence_unavailable: "Required evidence is unavailable",
  lifecycle_blocked: "Execution lifecycle requirements are blocked",
  invalid_scope: "This execution is historical or its run is no longer current",
};

type Presentation = { label: string; tone: "warning" | "success" | "default" | "processing" };

export function reproductionCasePresentation(
  assessment: IssueReproductionCaseAssessment | null | undefined,
  current = true,
): Presentation {
  if (!assessment) return { label: "Not recorded", tone: "default" };
  if (current && assessment.reasons.includes("invalid_scope"))
    return { label: "Historical · not current", tone: "default" };
  if (current && assessment.reasons.includes("execution_pending"))
    return { label: "Pending", tone: "processing" };
  return {
    present: { label: "Present", tone: "warning" },
    absent: { label: "Absent", tone: "success" },
    blocked: { label: "Blocked", tone: "warning" },
    inconclusive: { label: "Inconclusive", tone: "default" },
  }[assessment.state] as Presentation;
}

export function reproductionConclusionPresentation(
  assessment: Pick<IssueReproductionAssessmentV1, "conclusion" | "cases">,
  current = true,
): Presentation {
  if (current && assessment.cases.every((entry) => entry.reasons.includes("invalid_scope")))
    return { label: "Historical · not current", tone: "default" };
  if (current && assessment.cases.every((entry) => entry.reasons.includes("execution_pending")))
    return { label: "Pending", tone: "processing" };
  return {
    confirmed: { label: "Confirmed", tone: "warning" },
    not_reproduced: { label: "Not reproduced", tone: "success" },
    blocked: { label: "Blocked", tone: "warning" },
    inconclusive: { label: "Inconclusive", tone: "default" },
  }[assessment.conclusion] as Presentation;
}

export function observationRefKey(ref: ReproductionObservationRef): string {
  return ref.kind === "ui_assertion"
    ? JSON.stringify([ref.kind, ref.scenarioId, ref.stepId])
    : JSON.stringify([ref.kind, ref.testStepId, ref.observationId]);
}

export function observationRefLabel(ref: ReproductionObservationRef): string {
  return ref.kind === "ui_assertion"
    ? `UI assertion · ${ref.scenarioId} / ${ref.stepId}`
    : `Probe value · ${ref.testStepId} / ${ref.observationId}`;
}

export function observationValueLabel(value: ObservationValue): string {
  return `${value.type} · ${JSON.stringify(value.value)}`;
}

export function observationFactLabel(fact: ReproductionObservationFact | undefined): string {
  if (!fact) return "Not observed";
  return fact.state === "observed"
    ? observationValueLabel(fact.value)
    : `Unavailable · ${fact.reason.replaceAll("_", " ")}`;
}

export function reproductionQueryKey(
  mode: "sample" | "connected",
  selection: ReproductionCaseSelection,
  principal: OperatorPrincipal,
  session: string,
) {
  return [
    "issue-reproduction",
    mode,
    selection.repositoryId,
    selection.workItemId,
    selection.reviewRunId,
    selection.bindingDigest,
    selection.planDigest,
    selection.issueRevisionKey,
    selection.testedSourceCommit,
    selection.requestId,
    selection.caseId,
    selection.profileVersionId,
    selection.target,
    selection.jobId ?? "latest",
    selection.resultId ?? null,
    selection.executionKey ?? null,
    principal.issuer,
    principal.subject,
    session,
  ] as const;
}

export function reproductionCaseMatches(
  response: DashboardReviewRunReproductionCaseResponse,
  selection: ReproductionCaseSelection,
): boolean {
  const assessments = [response.current, ...(response.recorded ? [response.recorded] : [])];
  return (
    response.repositoryId === selection.repositoryId &&
    response.reviewRunId === selection.reviewRunId &&
    response.requestId === selection.requestId &&
    response.caseId === selection.caseId &&
    (selection.jobId === undefined || response.jobId === selection.jobId) &&
    (selection.resultId === undefined || response.resultId === selection.resultId) &&
    response.binding.repositoryId === selection.repositoryId &&
    response.binding.workItemId === selection.workItemId &&
    response.binding.issueRevisionKey === selection.issueRevisionKey &&
    response.binding.testedSourceCommit === selection.testedSourceCommit &&
    response.bindingDigest === selection.bindingDigest &&
    response.planDigest === selection.planDigest &&
    response.case.id === selection.caseId &&
    response.case.requestId === selection.requestId &&
    response.case.profileVersionId === selection.profileVersionId &&
    response.case.target === selection.target &&
    assessments.every(
      (assessment) =>
        assessment.caseId === selection.caseId &&
        assessment.requestId === selection.requestId &&
        assessment.profileVersionId === selection.profileVersionId &&
        assessment.target === selection.target,
    )
  );
}

export function reproductionEvidenceScope(
  detail: DashboardReviewRunReproductionCaseResponse,
  result: DashboardReviewRunResult | null | undefined,
): EvidenceScope | null {
  if (
    !result ||
    result.report.workItemKind !== "issue" ||
    result.repositoryId !== detail.repositoryId ||
    result.workItemId !== detail.binding.workItemId ||
    result.reviewRunId !== detail.reviewRunId ||
    result.requestId !== detail.requestId ||
    result.jobId !== detail.jobId ||
    result.id !== detail.resultId ||
    result.profileVersionId !== detail.case.profileVersionId ||
    result.revisionKey !== detail.binding.issueRevisionKey ||
    result.planDigest !== detail.planDigest
  )
    return null;
  return {
    repositoryId: result.repositoryId,
    runId: result.reviewRunId,
    jobId: result.jobId,
    runAttemptId: result.runAttemptId,
    requestId: result.requestId,
    profileVersionId: result.profileVersionId,
    revisionKey: result.revisionKey,
    planDigest: result.planDigest,
  };
}

export function reproductionPollingInterval(input: {
  mode: "connected" | "sample";
  visible: boolean;
  canRead: boolean;
  hasError: boolean;
}) {
  return input.mode === "connected" && input.visible && input.canRead && !input.hasError
    ? 30_000
    : false;
}
