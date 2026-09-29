import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRealCliResult, parseRoundPolicy } from "./real-cli-assessment.mjs";

const completed = { taskState: "completed", reportCompleteness: "complete", acceptedRounds: 1 };

test("a valid one-round completion satisfies the default scope without claiming multiple rounds", () => {
  const observed = assessRealCliResult(completed, parseRoundPolicy());
  assert.equal(observed.productResult.status, "passed");
  assert.deepEqual(observed.roundCoverage, {
    status: "satisfied",
    requiredMinimum: 1,
    acceptedRounds: 1,
    multiRoundObserved: false,
  });
  assert.equal(observed.failure, null);
});

test("an explicit two-round requirement fails coverage without changing the completed product result", () => {
  const observed = assessRealCliResult(completed, parseRoundPolicy({ minAcceptedRounds: "2" }));
  assert.equal(observed.productResult.status, "passed");
  assert.equal(observed.roundCoverage.status, "not_observed");
  assert.equal(observed.roundCoverage.multiRoundObserved, false);
  assert.equal(observed.failure.code, "ROUND_COVERAGE_NOT_OBSERVED");
});

test("two accepted rounds satisfy an explicit two-round requirement", () => {
  const observed = assessRealCliResult(
    { ...completed, acceptedRounds: 2 },
    parseRoundPolicy({ maxRounds: "2", minAcceptedRounds: "2" }),
  );
  assert.equal(observed.roundCoverage.status, "satisfied");
  assert.equal(observed.roundCoverage.multiRoundObserved, true);
  assert.equal(observed.failure, null);
});

test("blocked, failed, interrupted, or incomplete results cannot pass through round coverage", () => {
  for (const input of [
    { ...completed, taskState: "blocked" },
    { ...completed, taskState: "failed" },
    { ...completed, taskState: "interrupted" },
    { ...completed, reportCompleteness: "partial" },
    { ...completed, reportCompleteness: null },
  ]) {
    const observed = assessRealCliResult(input, parseRoundPolicy());
    assert.equal(observed.productResult.status, "failed");
    assert.equal(observed.failure.code, "PRODUCT_RESULT_INCOMPLETE");
  }
});

test("a single-round budget is supported and impossible coverage is rejected before launch", () => {
  assert.deepEqual(parseRoundPolicy({ maxRounds: "1" }), { maxRounds: 1, minAcceptedRounds: 1 });
  assert.throws(
    () => parseRoundPolicy({ maxRounds: "1", minAcceptedRounds: "2" }),
    /must not exceed/,
  );
  for (const invalid of ["0", "65", "1.5", "not-a-number"]) {
    assert.throws(() => parseRoundPolicy({ maxRounds: invalid }), /--max-rounds/);
    assert.throws(() => parseRoundPolicy({ minAcceptedRounds: invalid }), /--min-accepted-rounds/);
  }
});

test("no accepted model round does not satisfy the default real-model coverage", () => {
  const observed = assessRealCliResult({ ...completed, acceptedRounds: 0 }, parseRoundPolicy());
  assert.equal(observed.roundCoverage.status, "not_observed");
  assert.equal(observed.failure.code, "ROUND_COVERAGE_NOT_OBSERVED");
});
