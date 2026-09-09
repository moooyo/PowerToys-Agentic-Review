import type {
  ValidationCheckResult,
  ValidationOutcome,
  ValidationReportV1,
} from "@agentic-review/contracts";

export interface ValidationApprovalReport {
  /** The full immutable revision key, including the base revision when applicable. */
  readonly revisionKey: string;
  readonly planDigest: string;
  /** Supplied by evidence finalization, never copied from the model summary. */
  readonly evidenceComplete: boolean;
  readonly report: ValidationReportV1;
}

export interface ValidationApprovalInput {
  readonly currentRevisionKey: string;
  readonly expectedExecutionPlanDigest: string;
  /** IDs must be qualified across profiles, for example "profile-version:step-id". */
  readonly requiredCheckIds: readonly string[];
  /** Select one authoritative terminal attempt per planned job; do not include retry history. */
  readonly reports: readonly ValidationApprovalReport[];
  /** Resolve these against the current revision and frozen finding policy before aggregation. */
  readonly blockingFindingIds: readonly string[];
  /** Includes missing profiles, unavailable scenarios, and required lifecycle/terminal failures. */
  readonly requiredRequestBlockers: readonly {
    readonly requestId: string;
    readonly reason: string;
  }[];
}

export type ValidationApprovalReasonCode =
  | "invalid_revision"
  | "invalid_plan_digest"
  | "no_required_checks"
  | "invalid_required_check_id"
  | "duplicate_required_check_id"
  | "stale_revision"
  | "execution_plan_mismatch"
  | "not_worker_report"
  | "not_pull_request"
  | "source_modified"
  | "source_unknown"
  | "incomplete_evidence"
  | "duplicate_check_id"
  | "missing_required_check"
  | "required_check_not_runner"
  | "required_check_not_passed"
  | "required_request_blocked"
  | "blocking_findings";

export interface ValidationApprovalReason {
  readonly code: ValidationApprovalReasonCode;
  readonly checkId?: string;
  readonly reportIndex?: number;
  readonly outcome?: ValidationOutcome;
  readonly requestId?: string;
  readonly reason?: string;
}

export interface ValidationApprovalDecision {
  readonly eligible: boolean;
  readonly reasons: readonly ValidationApprovalReason[];
}

const qualifiedCheckIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

/**
 * Computes unqualified PR approval eligibility from validated, persisted execution records.
 * Caller authentication, repository ownership, and result/lease validation remain write-boundary
 * responsibilities. Model recommendations and human overrides cannot alter this decision.
 */
export function evaluateValidationApproval(
  input: ValidationApprovalInput,
): ValidationApprovalDecision {
  const reasons: ValidationApprovalReason[] = [];
  if (input.currentRevisionKey.trim().length === 0) reasons.push({ code: "invalid_revision" });
  if (!sha256Pattern.test(input.expectedExecutionPlanDigest)) {
    reasons.push({ code: "invalid_plan_digest" });
  }

  const required = new Set<string>();
  if (input.requiredCheckIds.length === 0) reasons.push({ code: "no_required_checks" });
  for (const checkId of input.requiredCheckIds) {
    if (checkId.length > 257 || !qualifiedCheckIdPattern.test(checkId)) {
      reasons.push({ code: "invalid_required_check_id", checkId });
    }
    if (required.has(checkId)) reasons.push({ code: "duplicate_required_check_id", checkId });
    required.add(checkId);
  }

  const checks = new Map<
    string,
    { readonly check: ValidationCheckResult; readonly reportIndex: number }
  >();
  input.reports.forEach((record, reportIndex) => {
    const { report } = record;
    if (record.revisionKey !== input.currentRevisionKey) {
      reasons.push({ code: "stale_revision", reportIndex });
    }
    if (record.planDigest !== input.expectedExecutionPlanDigest) {
      reasons.push({ code: "execution_plan_mismatch", reportIndex });
    }
    if (report.source !== "worker") reasons.push({ code: "not_worker_report", reportIndex });
    if (report.workItemKind !== "pull_request")
      reasons.push({ code: "not_pull_request", reportIndex });
    if (report.sourceState !== "original") {
      reasons.push({
        code: report.sourceState === "modified" ? "source_modified" : "source_unknown",
        reportIndex,
      });
    }
    if (record.evidenceComplete !== true)
      reasons.push({ code: "incomplete_evidence", reportIndex });

    for (const check of report.checks) {
      if (checks.has(check.id)) {
        reasons.push({ code: "duplicate_check_id", checkId: check.id, reportIndex });
      } else {
        checks.set(check.id, { check, reportIndex });
      }
    }
  });

  for (const checkId of required) {
    const entry = checks.get(checkId);
    if (entry === undefined) {
      reasons.push({ code: "missing_required_check", checkId });
      continue;
    }
    const { check, reportIndex } = entry;
    if (check.source !== "runner") {
      reasons.push({ code: "required_check_not_runner", checkId, reportIndex });
    }
    if (check.outcome !== "passed") {
      reasons.push({
        code: "required_check_not_passed",
        checkId,
        reportIndex,
        outcome: check.outcome,
      });
    }
  }
  if (input.blockingFindingIds.length > 0) reasons.push({ code: "blocking_findings" });
  for (const blocker of input.requiredRequestBlockers) {
    reasons.push({
      code: "required_request_blocked",
      requestId: blocker.requestId,
      reason: blocker.reason,
    });
  }

  return { eligible: reasons.length === 0, reasons };
}
