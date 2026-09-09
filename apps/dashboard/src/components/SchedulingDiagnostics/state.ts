import type { SchedulingDiagnosticReason, SchedulingDiagnostics } from "@agentic-review/contracts";
import { ReviewControlHttpError } from "@/services/review-control/errors";

export const schedulingReasonLabels: Record<SchedulingDiagnosticReason["code"], string> = {
  awaiting_admission: "This job is recorded and is waiting to enter the execution queue.",
  repository_queue_limit: "The repository's admitted queue has reached its configured limit.",
  platform_queue_limit: "The platform's admitted queue has reached its configured limit.",
  repository_active_limit: "The repository has reached its active execution limit.",
  platform_active_limit: "The platform has reached its active execution limit.",
  repository_paused: "This repository is paused.",
  no_registered_worker: "No registered worker was found by the complete inspection.",
  no_compatible_worker: "No compatible worker was found by the complete inspection.",
  compatible_worker_unavailable: "Compatible workers are currently unavailable.",
  worker_slots_occupied: "Matching workers have reached their concurrent execution limit.",
  retry_backoff: "The recorded retry backoff has not elapsed.",
  concurrency_busy: "Another execution is using a required shared resource.",
  affinity_worker_unavailable: "The worker required by this job is unavailable.",
  attempt_limit_reached: "No further attempts are permitted for this job.",
  current_attempt_attached: "An attempt is still attached to this job.",
  invalid_job_configuration: "The saved job configuration cannot be executed.",
  plan_prerequisite_missing: "A required plan prerequisite is unavailable.",
  authorization_changed: "The current authorization no longer matches this request.",
  source_obsolete: "The source revision or request has changed.",
  worker_capacity_unavailable:
    "The latest reported local capacity is unavailable. Its reporting time is unknown; the worker reports fresh capacity when requesting work.",
  inspection_incomplete:
    "Scheduling inspection is incomplete. Some configuration or worker information was not checked; worker availability has not been ruled out.",
};
export const schedulingEffectLabels: Record<SchedulingDiagnosticReason["effect"], string> = {
  admission_gate: "Queue admission rule",
  claim_gate: "Start rule",
  current_prerequisite: "Current request requirement",
  observation: "Observation",
};
export function schedulingStageLabel(value: SchedulingDiagnostics): string {
  if (value.stage === "terminal") return "Execution has finished";
  if (value.stage === "executing")
    return value.job?.status === "cancel_requested"
      ? "Cancellation is in progress"
      : "Execution is active";
  return value.job === null
    ? "Waiting for an execution to be created"
    : value.job.admission?.state === "pending"
      ? "Awaiting admission"
      : "Queued";
}
export function schedulingPollingInterval({
  visible,
  connected,
  error,
  stage,
}: {
  visible: boolean;
  connected: boolean;
  error: boolean;
  stage?: SchedulingDiagnostics["stage"];
}): 5000 | false {
  return visible && connected && !error && stage !== "terminal" ? 5000 : false;
}
export function schedulingAccessDenied(error: unknown): boolean {
  return error instanceof ReviewControlHttpError && [401, 403, 404].includes(error.status);
}
export function schedulingDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}
