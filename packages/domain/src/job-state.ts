import type { JobState, WorkerState, WorkItemState } from "@agentic-review/contracts";

const terminalJobStates = new Set<JobState>([
  "succeeded",
  "cancelled",
  "stale",
  "failed",
  "dead_letter",
]);

const leaseHoldingJobStates = new Set<JobState>(["leased", "running", "cancel_requested"]);

const jobTransitions = {
  queued: ["leased", "cancelled", "stale"],
  retry_waiting: ["leased", "cancelled", "stale", "dead_letter"],
  leased: ["running", "cancel_requested", "retry_waiting", "cancelled", "stale", "failed"],
  running: ["cancel_requested", "succeeded", "retry_waiting", "cancelled", "stale", "failed"],
  cancel_requested: ["cancelled", "retry_waiting", "stale", "failed"],
  cancelled: [],
  stale: [],
  succeeded: [],
  failed: [],
  dead_letter: [],
} as const satisfies Record<JobState, readonly JobState[]>;

const workItemTransitions = {
  open: ["assigned", "closed"],
  assigned: ["active", "unassigned", "closed"],
  active: ["assigned", "unassigned", "closed"],
  unassigned: ["assigned", "closed"],
  closed: [],
} as const satisfies Record<WorkItemState, readonly WorkItemState[]>;

export function isTerminalJobState(state: JobState): boolean {
  return terminalJobStates.has(state);
}

export function jobStateHoldsLease(state: JobState): boolean {
  return leaseHoldingJobStates.has(state);
}

export function canTransitionJobState(from: JobState, to: JobState): boolean {
  return (jobTransitions[from] as readonly JobState[]).includes(to);
}

export function assertJobStateTransition(from: JobState, to: JobState): void {
  if (!canTransitionJobState(from, to)) {
    throw new Error(`Invalid job state transition: ${from} -> ${to}`);
  }
}

export function canTransitionWorkItemState(from: WorkItemState, to: WorkItemState): boolean {
  return (workItemTransitions[from] as readonly WorkItemState[]).includes(to);
}

export function workerCanClaimJobs(state: WorkerState): boolean {
  return state === "online";
}
