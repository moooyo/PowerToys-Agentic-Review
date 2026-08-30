import { describe, expect, it } from "vitest";

import {
  canTransitionJobState,
  isTerminalJobState,
  jobStateHoldsLease,
  workerCanClaimJobs,
} from "./job-state.js";

describe("job state helpers", () => {
  it("accepts the normal start of a review", () => {
    expect(canTransitionJobState("queued", "leased")).toBe(true);
    expect(canTransitionJobState("leased", "running")).toBe(true);
    expect(canTransitionJobState("running", "succeeded")).toBe(true);
  });

  it("rejects transitions out of terminal states", () => {
    expect(isTerminalJobState("succeeded")).toBe(true);
    expect(canTransitionJobState("succeeded", "queued")).toBe(false);
  });

  it("does not retain a lease after a terminal outcome", () => {
    expect(jobStateHoldsLease("running")).toBe(true);
    expect(jobStateHoldsLease("succeeded")).toBe(false);
  });

  it("does not schedule draining workers", () => {
    expect(workerCanClaimJobs("online")).toBe(true);
    expect(workerCanClaimJobs("draining")).toBe(false);
  });
});
