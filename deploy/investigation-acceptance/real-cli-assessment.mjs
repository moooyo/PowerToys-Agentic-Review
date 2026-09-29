import assert from "node:assert/strict";

/** Validate requested coverage before the harness starts any process or model. */
export function parseRoundPolicy({ maxRounds, minAcceptedRounds } = {}) {
  const maximum = maxRounds === undefined ? 16 : Number(maxRounds);
  const minimum = minAcceptedRounds === undefined ? 1 : Number(minAcceptedRounds);
  assert(
    Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 64,
    "--max-rounds must be from 1 through 64.",
  );
  assert(
    Number.isSafeInteger(minimum) && minimum >= 1 && minimum <= 64,
    "--min-accepted-rounds must be from 1 through 64.",
  );
  assert(minimum <= maximum, "--min-accepted-rounds must not exceed --max-rounds.");
  return { maxRounds: maximum, minAcceptedRounds: minimum };
}

/** Call after the existing Report contract, export, and pagination checks. */
export function assessRealCliResult({ taskState, reportCompleteness, acceptedRounds }, policy) {
  assert(
    Number.isSafeInteger(acceptedRounds) && acceptedRounds >= 0,
    "Accepted rounds must be a nonnegative safe integer.",
  );
  const productResult = {
    status: taskState === "completed" && reportCompleteness === "complete" ? "passed" : "failed",
    taskState,
    reportCompleteness,
  };
  const roundCoverage = {
    status: acceptedRounds >= policy.minAcceptedRounds ? "satisfied" : "not_observed",
    requiredMinimum: policy.minAcceptedRounds,
    acceptedRounds,
    multiRoundObserved: acceptedRounds >= 2,
  };
  const failure =
    productResult.status !== "passed"
      ? {
          code: "PRODUCT_RESULT_INCOMPLETE",
          message:
            "A partial or failed actual-model outcome remains failed acceptance with its original evidence.",
        }
      : roundCoverage.status !== "satisfied"
        ? {
            code: "ROUND_COVERAGE_NOT_OBSERVED",
            message: `The product completed with ${acceptedRounds} accepted analysis round(s), but this run required at least ${policy.minAcceptedRounds}. The requested round coverage was not observed.`,
          }
        : null;
  return { productResult, roundCoverage, failure };
}
