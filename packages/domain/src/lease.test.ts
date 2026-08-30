import { describe, expect, it } from "vitest";

import {
  calculateLeaseExpiry,
  type ExpectedLeaseFence,
  type PresentedLeaseFence,
  resolveExpiredAttempt,
  validateLeaseFence,
} from "./lease.js";

const expected: ExpectedLeaseFence = {
  jobId: "job-1",
  runAttemptId: "run-1",
  workerNodeId: "worker-1",
  workerInstanceId: "instance-1",
  leaseGeneration: 4,
  leaseExpiresAtEpochMs: 10_000,
  runState: "running",
  jobState: "running",
};

const presented: PresentedLeaseFence = {
  jobId: "job-1",
  runAttemptId: "run-1",
  workerNodeId: "worker-1",
  workerInstanceId: "instance-1",
  leaseGeneration: 4,
  tokenMatches: true,
};

describe("lease fencing", () => {
  it("accepts the current unexpired generation", () => {
    expect(validateLeaseFence(expected, presented, 9_999)).toEqual({
      valid: true,
    });
  });

  it("rejects a previous generation", () => {
    expect(validateLeaseFence(expected, { ...presented, leaseGeneration: 3 }, 9_000)).toEqual({
      valid: false,
      reason: "lease_generation_mismatch",
    });
  });

  it("rejects an instance from before a worker restart", () => {
    expect(
      validateLeaseFence(expected, { ...presented, workerInstanceId: "instance-old" }, 9_000),
    ).toEqual({ valid: false, reason: "worker_instance_mismatch" });
  });

  it("treats the expiry instant as expired", () => {
    expect(validateLeaseFence(expected, presented, 10_000)).toEqual({
      valid: false,
      reason: "lease_expired",
    });
  });
});

describe("lease lifecycle", () => {
  it("calculates expiry from server time", () => {
    expect(calculateLeaseExpiry(1_000, 90_000)).toBe(91_000);
  });

  it("retries a timed-out attempt when attempts remain", () => {
    expect(
      resolveExpiredAttempt({
        attemptCount: 1,
        maxAttempts: 3,
        cancellationRequested: false,
        superseded: false,
      }).jobState,
    ).toBe("retry_waiting");
  });

  it("dead-letters a timed-out attempt after retries are exhausted", () => {
    expect(
      resolveExpiredAttempt({
        attemptCount: 3,
        maxAttempts: 3,
        cancellationRequested: false,
        superseded: false,
      }).jobState,
    ).toBe("dead_letter");
  });

  it("rejects invalid retry limits", () => {
    expect(() =>
      resolveExpiredAttempt({
        attemptCount: 0,
        maxAttempts: 0,
        cancellationRequested: false,
        superseded: false,
      }),
    ).toThrow(RangeError);
  });
});
