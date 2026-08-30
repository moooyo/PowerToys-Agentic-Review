import type { JobState, RunAttemptState } from "@agentic-review/contracts";

export type LeaseLossReason =
  | "lease_not_found"
  | "job_mismatch"
  | "run_attempt_mismatch"
  | "worker_node_mismatch"
  | "worker_instance_mismatch"
  | "lease_generation_mismatch"
  | "lease_token_mismatch"
  | "run_not_active"
  | "job_does_not_hold_lease"
  | "lease_expired";

export interface ExpectedLeaseFence {
  jobId: string;
  runAttemptId: string;
  workerNodeId: string;
  workerInstanceId: string;
  leaseGeneration: number;
  leaseExpiresAtEpochMs: number;
  runState: RunAttemptState;
  jobState: JobState;
}

export interface PresentedLeaseFence {
  jobId: string;
  runAttemptId: string;
  workerNodeId: string;
  workerInstanceId: string;
  leaseGeneration: number;
  tokenMatches: boolean;
}

export type LeaseValidationResult = { valid: true } | { valid: false; reason: LeaseLossReason };

const activeRunStates = new Set<RunAttemptState>(["leased", "running"]);

const leaseHoldingJobStates = new Set<JobState>(["leased", "running", "cancel_requested"]);

export function validateLeaseFence(
  expected: ExpectedLeaseFence | undefined,
  presented: PresentedLeaseFence,
  nowEpochMs: number,
): LeaseValidationResult {
  if (expected === undefined) {
    return { valid: false, reason: "lease_not_found" };
  }
  if (presented.jobId !== expected.jobId) {
    return { valid: false, reason: "job_mismatch" };
  }
  if (presented.runAttemptId !== expected.runAttemptId) {
    return { valid: false, reason: "run_attempt_mismatch" };
  }
  if (presented.workerNodeId !== expected.workerNodeId) {
    return { valid: false, reason: "worker_node_mismatch" };
  }
  if (presented.workerInstanceId !== expected.workerInstanceId) {
    return { valid: false, reason: "worker_instance_mismatch" };
  }
  if (presented.leaseGeneration !== expected.leaseGeneration) {
    return { valid: false, reason: "lease_generation_mismatch" };
  }
  if (!presented.tokenMatches) {
    return { valid: false, reason: "lease_token_mismatch" };
  }
  if (!activeRunStates.has(expected.runState)) {
    return { valid: false, reason: "run_not_active" };
  }
  if (!leaseHoldingJobStates.has(expected.jobState)) {
    return { valid: false, reason: "job_does_not_hold_lease" };
  }
  if (nowEpochMs >= expected.leaseExpiresAtEpochMs) {
    return { valid: false, reason: "lease_expired" };
  }
  return { valid: true };
}

export function calculateLeaseExpiry(serverNowEpochMs: number, leaseTtlMs: number): number {
  if (!Number.isSafeInteger(serverNowEpochMs) || serverNowEpochMs < 0) {
    throw new RangeError("serverNowEpochMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new RangeError("leaseTtlMs must be a positive safe integer");
  }

  const expiresAt = serverNowEpochMs + leaseTtlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError("lease expiry exceeds the safe integer range");
  }
  return expiresAt;
}

export function shouldRenewLease(
  serverNowEpochMs: number,
  leaseExpiresAtEpochMs: number,
  renewalLeadTimeMs: number,
): boolean {
  if (!Number.isSafeInteger(renewalLeadTimeMs) || renewalLeadTimeMs < 0) {
    throw new RangeError("renewalLeadTimeMs must be a non-negative safe integer");
  }
  return serverNowEpochMs >= leaseExpiresAtEpochMs - renewalLeadTimeMs;
}

export interface ExpiredAttemptResolutionInput {
  attemptCount: number;
  maxAttempts: number;
  cancellationRequested: boolean;
  superseded: boolean;
}

export interface ExpiredAttemptResolution {
  runState: "expired";
  jobState: "retry_waiting" | "cancelled" | "stale" | "dead_letter";
  failureCode: "worker_heartbeat_timeout";
}

export function resolveExpiredAttempt(
  input: ExpiredAttemptResolutionInput,
): ExpiredAttemptResolution {
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) {
    throw new RangeError("attemptCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }

  if (input.superseded) {
    return expiredResolution("stale");
  }
  if (input.cancellationRequested) {
    return expiredResolution("cancelled");
  }
  if (input.attemptCount >= input.maxAttempts) {
    return expiredResolution("dead_letter");
  }
  return expiredResolution("retry_waiting");
}

function expiredResolution(
  jobState: ExpiredAttemptResolution["jobState"],
): ExpiredAttemptResolution {
  return {
    runState: "expired",
    jobState,
    failureCode: "worker_heartbeat_timeout",
  };
}
