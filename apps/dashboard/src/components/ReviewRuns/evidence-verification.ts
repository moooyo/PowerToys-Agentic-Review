import type {
  DashboardReviewRunDetail,
  DashboardReviewRunRequest,
} from "@agentic-review/contracts";

interface EvidenceVerificationState {
  readonly evidenceComplete: boolean;
  readonly evidenceVerificationPending?: true;
}

export const evidenceVerificationPendingLabel = "Evidence verification pending";

export function evidenceVerificationLabel(
  state: EvidenceVerificationState,
  sample = false,
): string {
  if (sample) return "Sample references only";
  if (state.evidenceVerificationPending === true) return evidenceVerificationPendingLabel;
  return state.evidenceComplete ? "Verified available" : "Not fully available";
}

export function requestEvidencePending(request: DashboardReviewRunRequest): boolean {
  return (
    request.latestResult?.evidenceVerificationPending === true ||
    request.blockers.includes("evidence_verification_pending")
  );
}

export function pendingEvidenceRequests(run: DashboardReviewRunDetail) {
  const pending = run.requests.filter(requestEvidencePending);
  return {
    required: pending.filter((request) => request.required).length,
    optional: pending.filter((request) => !request.required).length,
  };
}

export function evidencePollingViewVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

/** Keep settled reproduction projections current without extending the bounded proof retry window. */
export function reproductionRefreshInterval(input: {
  readonly verificationInterval: number | false;
  readonly mapped: boolean;
  readonly pending: boolean;
  readonly visible: boolean;
  readonly hasError: boolean;
}): number | false {
  if (!input.visible || input.hasError) return false;
  if (input.verificationInterval !== false) return input.verificationInterval;
  return input.mapped && !input.pending ? 30_000 : false;
}

const pollingDelays = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000] as const;

// Count completed reads, not callback invocations: query observers may recalculate intervals
// several times during one fetch. Manual refresh starts a new bounded verification window.
export function createEvidencePollingController() {
  let scope: string | undefined;
  let firstRead: number | undefined;
  return {
    reset() {
      scope = undefined;
      firstRead = undefined;
    },
    next(input: {
      scope: string;
      pending: boolean;
      completedReads: number;
      visible: boolean;
      hasError: boolean;
    }): number | false {
      if (scope !== input.scope || !input.pending) {
        scope = input.scope;
        firstRead = undefined;
      }
      if (!input.pending || !input.visible || input.hasError) return false;
      firstRead ??= input.completedReads;
      const index = Math.max(0, input.completedReads - firstRead);
      return pollingDelays[index] ?? false;
    },
  };
}
