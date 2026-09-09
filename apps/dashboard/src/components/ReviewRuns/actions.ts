import type {
  DashboardReviewRunDetail,
  DashboardReviewRunRequest,
} from "@agentic-review/contracts";

const terminalStates = new Set(["succeeded", "failed", "cancelled", "stale", "dead_letter"]);
const cancellableStates = new Set(["queued", "leased", "running", "retry_waiting"]);

export const reviewReadOnlyMessage =
  "Read-only access. The reviewer role or higher is required to create, rerun, or cancel review runs.";

export function reviewPermissionUnavailableReason(access: {
  ready: boolean;
  checking: boolean;
  can: (permission: "review") => boolean;
}): string | null {
  if (access.checking) return "Checking review permissions…";
  if (!access.ready)
    return "Review permissions are unavailable. Refresh access before creating or changing a run.";
  return access.can("review") ? null : reviewReadOnlyMessage;
}

export function rerunUnavailableReason(
  run: DashboardReviewRunDetail,
  request: DashboardReviewRunRequest,
): string | null {
  if (run.freshness !== "current")
    return "Create a new run for the current revision and authorization.";
  if (request.readiness !== "ready" || !request.profile || !request.prompt)
    return "Resolve the request blockers and create a new run.";
  if (!request.latestJob) return "This request has no prior job to rerun.";
  if (!terminalStates.has(request.latestJob.status))
    return "Wait for the current execution to finish before rerunning.";
  return null;
}

export function cancelUnavailableReason(request: DashboardReviewRunRequest): string | null {
  if (!request.latestJob) return "No job has been scheduled.";
  if (request.latestJob.status === "cancel_requested")
    return "Cancellation has already been requested.";
  return cancellableStates.has(request.latestJob.status)
    ? null
    : "This execution has already finished.";
}
