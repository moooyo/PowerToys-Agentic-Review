import { describe, expect, it } from "vitest";
import { sampleReviewRuns } from "./fixtures";
import { validateRunDetail } from "./validation";

function mixedRun(state: "pending" | "admitted") {
  const original = sampleReviewRuns[0];
  if (!original) throw new Error("A sample run is required.");
  const run = structuredClone(original);
  const request = run.requests.find(
    (item) =>
      item.latestJob?.status === "succeeded" &&
      item.readiness === "ready" &&
      item.profile !== null &&
      item.prompt !== null,
  );
  if (!request) throw new Error("A ready request with frozen profile and prompt is required.");
  request.latestJob = {
    jobId: "new-waiting-job",
    activationNumber: 1,
    status: "queued",
    phase: null,
    attemptCount: 0,
    admission:
      state === "pending"
        ? {
            state,
            attemptBase: 0,
            requestedAt: run.createdAt,
            admittedAt: null,
            timestampBasis: "recorded",
          }
        : {
            state,
            attemptBase: 0,
            requestedAt: run.createdAt,
            admittedAt: run.createdAt,
            timestampBasis: "recorded",
          },
    runAttemptId: null,
    createdAt: run.createdAt,
    startedAt: null,
    completedAt: null,
    failureCode: null,
    failureMessage: null,
    resultId: null,
    resultDigest: null,
  };
  request.blockers = [state === "pending" ? "execution_awaiting_admission" : "execution_queued"];
  request.latestResult = null;
  run.execution.succeeded--;
  if (state === "pending") run.execution.awaitingAdmission++;
  else run.execution.queued++;
  run.policy.reasons = [
    ...run.requiredCheckIds.map((checkId) => ({ code: "missing_required_check", checkId })),
    ...run.requests.flatMap((item) =>
      item.blockers.map((reason) => ({
        code: "required_request_blocked",
        requestId: item.requestId,
        reason,
      })),
    ),
  ];
  run.policy.reasonCount = run.policy.reasons.length;
  run.policy.blockingFindingCount = 0;
  return run;
}
describe("admission-aware Run projections", () => {
  it.each(["pending", "admitted"] as const)(
    "counts a real %s job separately from a missing execution",
    (state) => {
      const run = mixedRun(state);
      expect(validateRunDetail(run, "read mixed run")).toEqual(run);
      expect(Object.values(run.execution).reduce((total, count) => total + count, 0)).toBe(
        run.requestCount,
      );
      expect(run.execution.missing).toBe(1);
      expect(run.execution.awaitingAdmission).toBe(state === "pending" ? 1 : 0);
      expect(run.execution.queued).toBe(state === "admitted" ? 1 : 0);
    },
  );
  it("rejects a pending job counted as admitted or missing", () => {
    const run = mixedRun("pending");
    expect(() =>
      validateRunDetail(
        { ...run, execution: { ...run.execution, awaitingAdmission: 0, queued: 1 } },
        "read run",
      ),
    ).toThrow();
    expect(() =>
      validateRunDetail(
        {
          ...run,
          execution: { ...run.execution, awaitingAdmission: 0, missing: run.execution.missing + 1 },
        },
        "read run",
      ),
    ).toThrow();
  });
  it.each(["pending", "admitted"] as const)(
    "cannot infer approval eligibility from a %s required job",
    (state) => {
      const run = mixedRun(state);
      if (!run.policy.applicable) throw new Error("A PR policy is required.");
      expect(() =>
        validateRunDetail({ ...run, policy: { ...run.policy, eligible: true } }, "read run"),
      ).toThrow();
    },
  );
});
