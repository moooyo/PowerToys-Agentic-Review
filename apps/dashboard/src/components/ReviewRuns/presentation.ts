import type {
  DashboardReviewRunSummary,
  DashboardValidationOutcomeCounts,
  DashboardValidationPolicy,
  JobAdmission,
  JobState,
  ReviewRunDecisionPolicySnapshot,
  ValidationOutcome,
  ValidationRecommendation,
  ValidationTarget,
  WorkflowKind,
} from "@agentic-review/contracts";
import { jobDisplayStatus } from "@/services/review-control/admission";

type PresentationTone = "success" | "warning" | "error" | "default";

const executionLabels: Record<JobState, string> = {
  queued: "Queued",
  retry_waiting: "Waiting to retry",
  leased: "Assigned to worker",
  running: "Running",
  cancel_requested: "Cancellation requested",
  stale: "Stale execution",
  succeeded: "Execution complete",
  failed: "Execution failed",
  dead_letter: "Execution exhausted retries",
  cancelled: "Cancelled",
};

export function executionLabel(
  status: JobState | null | undefined,
  admission: JobAdmission | null = null,
): string {
  if (status == null) return "Not scheduled";
  const display = jobDisplayStatus(status, admission);
  return display === "awaiting_admission"
    ? "Awaiting admission"
    : display === "unknown"
      ? "Unknown queue state"
      : executionLabels[display as JobState];
}

const targetLabels: Record<ValidationTarget, string> = {
  headless: "Headless",
  windows_desktop: "Windows UI",
  web: "Web UI",
};

export function requestTargetLabel(workflowKind: WorkflowKind, target: ValidationTarget): string {
  switch (workflowKind) {
    case "pr_static_build":
      return "PR static / build";
    case "issue_triage":
      return "Issue triage";
    case "pr_ui":
      return `PR UI · ${targetLabels[target]}`;
    case "issue_validation":
      return `Issue validation · ${targetLabels[target]}`;
  }
}

export function policyPresentation(policy: DashboardValidationPolicy | null | undefined): {
  label: string;
  tone: PresentationTone;
  description: string;
} {
  if (policy == null) {
    return {
      label: "Not evaluated",
      tone: "default",
      description: "No automated policy evaluation is available.",
    };
  }
  if (!policy.applicable) {
    return {
      label: "Not applicable",
      tone: "default",
      description: "Pull request approval policy does not apply to this issue.",
    };
  }
  if (policy.eligible) {
    return {
      label: "Eligible",
      tone: "success",
      description:
        policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
          ? "All current policy requirements are satisfied, including recorded finding dispositions. Human approval and publication are separate actions."
          : "All automated policy requirements are satisfied. Human review and publication are separate actions.",
    };
  }
  return {
    label: "Not eligible",
    tone: "warning",
    description:
      policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
        ? "Current policy requirements are not satisfied. Review the policy reasons and unresolved findings."
        : "Automated policy requirements are not satisfied. Review the policy reasons.",
  };
}

export function policyFindingPresentation(
  policy: DashboardValidationPolicy | ReviewRunDecisionPolicySnapshot,
): {
  counts: Array<{ label: string; value: number }>;
  dispositionDigest: string | null;
  description: string;
} {
  if (policy.policyVersion === "required-checks-and-p0-p1-v1") {
    return {
      counts: [{ label: "Blocking P0 / P1 findings", value: policy.blockingFindingCount }],
      dispositionDigest: null,
      description:
        "This policy version uses the original reported P0 / P1 count and does not apply manual finding dispositions.",
    };
  }
  return {
    counts: [
      { label: "Reported P0 / P1 findings", value: policy.blockingFindingCount },
      { label: "Unresolved P0 / P1 findings", value: policy.unresolvedBlockingFindingCount },
    ],
    dispositionDigest: policy.findingDispositionDigest,
    description:
      "Manual finding dispositions affect the unresolved count: open and accepted findings remain unresolved; dismissed and resolved findings are excluded. Original findings and check outcomes are unchanged. " +
      (policy.applicable
        ? "Required checks, evidence, and source requirements still apply to PR approval."
        : "These dispositions do not establish an Issue reproduction conclusion."),
  };
}

const recommendationLabels: Record<ValidationRecommendation, string> = {
  approve: "Model suggests approval",
  comment: "Model suggests a comment",
  request_changes: "Model suggests changes",
  needs_human_review: "Model requests human review",
};

export function recommendationLabel(
  recommendation: ValidationRecommendation | null | undefined,
): string {
  return recommendation == null ? "Not available" : recommendationLabels[recommendation];
}

const outcomePresentations: Record<ValidationOutcome, { label: string; tone: PresentationTone }> = {
  passed: { label: "Passed", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  blocked: { label: "Blocked", tone: "warning" },
  not_run: { label: "Not run", tone: "default" },
  skipped: { label: "Skipped", tone: "default" },
  inconclusive: { label: "Inconclusive", tone: "warning" },
};

export function outcomePresentation(outcome: ValidationOutcome): {
  label: string;
  tone: PresentationTone;
} {
  return { ...outcomePresentations[outcome] };
}

export function summarizeCheckOutcomes(
  counts: DashboardValidationOutcomeCounts | null | undefined,
): string {
  if (counts == null) return "Checks not available";
  return [
    `${counts.passed} passed`,
    `${counts.failed} failed`,
    `${counts.blocked} blocked`,
    `${counts.not_run} not run`,
    `${counts.skipped} skipped`,
    `${counts.inconclusive} inconclusive`,
  ].join(" · ");
}

export function runBelongsToWorkItem(
  run: Pick<DashboardReviewRunSummary, "repositoryId" | "workItemId">,
  scope: { repositoryId: string; id: string },
): boolean {
  return run.repositoryId === scope.repositoryId && run.workItemId === scope.id;
}
