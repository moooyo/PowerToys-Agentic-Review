import { type Static, Type } from "@sinclair/typebox";

export const WorkItemStateValues = ["open", "assigned", "active", "unassigned", "closed"] as const;
export const WorkItemStateSchema = Type.Union(
  WorkItemStateValues.map((value) => Type.Literal(value)),
);
export type WorkItemState = Static<typeof WorkItemStateSchema>;

export const JobStateValues = [
  "queued",
  "retry_waiting",
  "leased",
  "running",
  "cancel_requested",
  "stale",
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
] as const;
export const JobStateSchema = Type.Union(JobStateValues.map((value) => Type.Literal(value)));
export type JobState = Static<typeof JobStateSchema>;

export const WorkerStateValues = ["online", "draining", "offline", "disabled"] as const;
export const WorkerStateSchema = Type.Union(WorkerStateValues.map((value) => Type.Literal(value)));
export type WorkerState = Static<typeof WorkerStateSchema>;

export const RunAttemptStateValues = [
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
export const RunAttemptStateSchema = Type.Union(
  RunAttemptStateValues.map((value) => Type.Literal(value)),
);
export type RunAttemptState = Static<typeof RunAttemptStateSchema>;

export const ExecutionPhaseValues = [
  "leased",
  "preparing",
  "cli_review",
  "validation",
  "cli_revision",
  "uploading",
  "completing",
  "cancelling",
] as const;
export const ExecutionPhaseSchema = Type.Union(
  ExecutionPhaseValues.map((value) => Type.Literal(value)),
);
export type ExecutionPhase = Static<typeof ExecutionPhaseSchema>;

export const JobKindValues = ["issue_triage", "pull_request_review"] as const;
export const JobKindSchema = Type.Union(JobKindValues.map((value) => Type.Literal(value)));
export type JobKind = Static<typeof JobKindSchema>;
