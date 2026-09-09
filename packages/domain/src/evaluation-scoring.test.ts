import { describe, expect, it } from "vitest";

import type { CliModelConfiguration } from "../../contracts/src/cli-model-execution.js";
import {
  assertEvaluationScoringReport,
  type EvaluationArm,
  type EvaluationFindingAdjudication,
  type EvaluationOwnerObservation,
  type EvaluationScoringPlanV1,
} from "../../contracts/src/evaluation-scoring.js";
import {
  captureEvaluationObservations,
  freezeEvaluationScoringPlan,
  scoreEvaluation,
} from "./evaluation-scoring.js";

const sourceDigest = "a".repeat(64);
const otherDigest = "c".repeat(64);
const key = (value: number) => value.toString(16).padStart(64, "0");

function cliConfiguration(overrides: Partial<CliModelConfiguration> = {}): CliModelConfiguration {
  return { kind: "codex", version: "1.0.0", requestedModel: "model-a", ...overrides };
}

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("The fixture or report value is missing.");
  }
  return value;
}

function firstCase<T>(input: { cases: readonly T[] }): T {
  return requireValue(input.cases[0]);
}

function plan(): EvaluationScoringPlanV1 {
  return {
    schemaVersion: "EvaluationScoringPlanV1",
    evaluationId: "evaluation-1",
    repositoryId: "repository-1",
    sampleSetVersionId: "samples-v1",
    expectationVersionId: "expectations-v1",
    baseline: {
      profileVersionId: "profile-v1",
      promptVersionId: "prompt-v1",
    },
    candidate: {
      profileVersionId: "profile-v2",
      promptVersionId: "prompt-v2",
    },
    cases: [
      {
        caseId: "case-1",
        sourceDigest,
        baselineBinding: {
          cellId: "cell-baseline-1",
          runId: "run-baseline-1",
          requestId: "request-1",
        },
        candidateBinding: {
          cellId: "cell-candidate-1",
          runId: "run-candidate-1",
          requestId: "request-1",
        },
        applicability: { state: "applicable" },
        criteria: [
          {
            criterionId: "compiles",
            description: "The submitted source compiles.",
            applicability: { state: "applicable" },
            expectedOutcome: "passed",
            baselineCheckId: "profile-v1:build",
            candidateCheckId: "profile-v2:build",
          },
        ],
        findings: { annotation: "complete", expected: [] },
      },
    ],
  };
}

function observed(
  input: EvaluationScoringPlanV1,
  arm: EvaluationArm = "baseline",
  index = 0,
): EvaluationOwnerObservation {
  const item = input.cases[index];
  if (item === undefined) throw new Error("The fixture case is missing.");
  const binding = item[`${arm}Binding`];
  return {
    evaluationId: input.evaluationId,
    repositoryId: input.repositoryId,
    caseId: item.caseId,
    arm,
    ...binding,
    executionState: "completed",
    reason: null,
    result: {
      resultId: `result-${item.caseId}-${arm}`,
      resultDigest: sourceDigest,
      jobId: `job-${item.caseId}-${arm}`,
      runAttemptId: `attempt-${item.caseId}-${arm}`,
      profileVersionId: input[arm].profileVersionId,
      promptVersionId: input[arm].promptVersionId,
      executionDigest: otherDigest,
      sourceDigest: item.sourceDigest,
    },
    sourceState: "original",
    checks: item.criteria.flatMap((criterion) => {
      const checkId = criterion[`${arm}CheckId`];
      return checkId === null
        ? []
        : [{ checkId, outcome: "passed" as const, evidenceAvailable: true }];
    }),
    model: {
      state: "complete",
      evidenceAvailable: true,
      cli: cliConfiguration(),
      occurrenceKeys: [],
    },
  };
}

function gold(input: EvaluationScoringPlanV1, count = 1): void {
  firstCase(input).findings.expected = Array.from({ length: count }, (_, index) => ({
    expectedFindingId: `bug-${index + 1}`,
    description: `Known defect ${index + 1}.`,
  }));
}

function findings(observation: EvaluationOwnerObservation, keys: string[]): void {
  observation.model = {
    state: "complete",
    evidenceAvailable: true,
    cli: cliConfiguration(),
    occurrenceKeys: keys,
  };
}

function noModel(observation: EvaluationOwnerObservation): EvaluationOwnerObservation {
  observation.model = {
    state: "not_applicable",
    reason: "The frozen configuration does not request a model.",
  };
  return observation;
}

function judgment(
  observation: EvaluationOwnerObservation,
  occurrenceKey: string,
  assignment: object,
): EvaluationFindingAdjudication {
  if (observation.result === null) throw new Error("The fixture result is missing.");
  return {
    adjudicationId: `judgment-${observation.caseId}-${observation.arm}-${occurrenceKey.slice(-4)}`,
    caseId: observation.caseId,
    arm: observation.arm,
    resultId: observation.result.resultId,
    resultDigest: observation.result.resultDigest,
    occurrenceKey,
    reason: "The operator inspected the immutable finding and frozen expectation.",
    actor: { issuer: "https://identity.example.com", subject: "reviewer" },
    createdAt: "2026-09-08T00:00:00.000Z",
    ...assignment,
  } as EvaluationFindingAdjudication;
}

function score(
  input: EvaluationScoringPlanV1,
  observations: EvaluationOwnerObservation[],
  judgments: unknown = [],
) {
  const frozen = freezeEvaluationScoringPlan(input);
  return scoreEvaluation(frozen, captureEvaluationObservations(frozen, observations), judgments);
}

describe("frozen evaluation scoring boundaries", () => {
  it("emits v2 rules without changing plan digests or rewriting readable v1 reports", () => {
    const input = plan();
    const frozen = freezeEvaluationScoringPlan(input);
    const planBytes = JSON.stringify(frozen.plan);
    const planDigest = frozen.digest;
    const report = scoreEvaluation(
      frozen,
      captureEvaluationObservations(frozen, [observed(input), observed(input, "candidate")]),
    );
    expect(report.rulesVersion).toBe("explicit-matching-v2");
    expect(report.planDigest).toBe(planDigest);
    expect(JSON.stringify(frozen.plan)).toBe(planBytes);
    expect(frozen.digest).toBe(planDigest);
    // Fully requested, available models retain the same v1-compatible measurements.
    const legacy = { ...structuredClone(report), rulesVersion: "explicit-matching-v1" };
    const legacyBytes = JSON.stringify(legacy);
    expect(() => assertEvaluationScoringReport(legacy)).not.toThrow();
    expect(JSON.stringify(legacy)).toBe(legacyBytes);
    expect(legacy.planDigest).toBe(planDigest);
    expect(() => assertEvaluationScoringReport(report)).not.toThrow();
  });

  it("copies and deeply freezes expectations with a canonical content digest", () => {
    const input = plan();
    const frozen = freezeEvaluationScoringPlan(input);
    requireValue(firstCase(input).criteria[0]).candidateCheckId = null;
    expect(requireValue(firstCase(frozen.plan).criteria[0]).candidateCheckId).toBe(
      "profile-v2:build",
    );
    expect(Object.isFrozen(firstCase(frozen.plan).criteria)).toBe(true);
    const reordered = Object.fromEntries(Object.entries(plan()).reverse());
    expect(freezeEvaluationScoringPlan(reordered).digest).toBe(frozen.digest);
    expect(freezeEvaluationScoringPlan(input).digest).not.toBe(frozen.digest);
  });

  it("rejects ambiguous expectation identities, reused cells, and foreign qualified mappings", () => {
    const foreign = plan();
    requireValue(firstCase(foreign).criteria[0]).candidateCheckId = "profile-v1:build";
    expect(() => freezeEvaluationScoringPlan(foreign)).toThrow(/frozen profile/);
    const duplicate = plan();
    firstCase(duplicate).criteria.push({
      ...requireValue(firstCase(duplicate).criteria[0]),
      criterionId: "renamed",
    });
    expect(() => freezeEvaluationScoringPlan(duplicate)).toThrow(/Mapped check IDs/);
    const duplicateGold = plan();
    gold(duplicateGold);
    firstCase(duplicateGold).findings.expected.push({
      ...requireValue(firstCase(duplicateGold).findings.expected[0]),
    });
    expect(() => freezeEvaluationScoringPlan(duplicateGold)).toThrow(/Expected finding IDs/);
    const sameCell = plan();
    firstCase(sameCell).candidateBinding.cellId = firstCase(sameCell).baselineBinding.cellId;
    expect(() => freezeEvaluationScoringPlan(sameCell)).toThrow(/cell IDs/);
  });

  it("does not accept raw objects in place of owner-captured observations", () => {
    const input = plan();
    const frozen = freezeEvaluationScoringPlan(input);
    const captured = captureEvaluationObservations(frozen, [observed(input)]);
    expect(() => scoreEvaluation(frozen, { ...captured })).toThrow(/Owner-captured/);
    expect(() => captureEvaluationObservations({ ...frozen }, [])).toThrow(
      /freezeEvaluationScoringPlan/,
    );
    const changed = plan();
    changed.expectationVersionId = "expectations-v2";
    expect(() => scoreEvaluation(freezeEvaluationScoringPlan(changed), captured)).toThrow(
      /exact scoring plan/,
    );
  });

  it.each(["evaluationId", "repositoryId", "cellId", "runId", "requestId"] as const)(
    "rejects a mismatched frozen %s",
    (field) => {
      const input = plan();
      const observation = observed(input);
      observation[field] = "another-identity";
      expect(() =>
        captureEvaluationObservations(freezeEvaluationScoringPlan(input), [observation]),
      ).toThrow(/frozen evaluation cell/);
    },
  );

  it.each(["sourceDigest", "profileVersionId", "promptVersionId"] as const)(
    "rejects a result with mismatched %s",
    (field) => {
      const input = plan();
      const observation = observed(input);
      requireValue(observation.result)[field] =
        field === "sourceDigest" ? otherDigest : "another-version";
      expect(() =>
        captureEvaluationObservations(freezeEvaluationScoringPlan(input), [observation]),
      ).toThrow(/source and configuration provenance/);
    },
  );

  it("rejects duplicate trial cells, reused result identities, and foreign observed check IDs", () => {
    const input = plan();
    const first = observed(input);
    const second = observed(input, "candidate");
    const frozen = freezeEvaluationScoringPlan(input);
    expect(() => captureEvaluationObservations(frozen, [first, first])).toThrow(/case\/arm cells/);
    requireValue(second.result).resultId = requireValue(first.result).resultId;
    expect(() => captureEvaluationObservations(frozen, [first, second])).toThrow(
      /resultId identities/,
    );
    const foreign = observed(input, "candidate");
    requireValue(foreign.checks[0]).checkId = "profile-v1:build";
    expect(() => captureEvaluationObservations(frozen, [foreign])).toThrow(
      /another profile version/,
    );
  });
});

describe("criterion coverage and paired changes", () => {
  it("uses explicit cross-version IDs and keeps a failed observation separate from expected correctness", () => {
    const input = plan();
    const baseline = observed(input);
    const candidate = observed(input, "candidate");
    requireValue(candidate.checks[0]).outcome = "failed";
    const report = score(input, [baseline, candidate]);
    expect(report.paired.criteria.regressed).toBe(1);
    expect(report.candidate.quality.checkAgreement).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    requireValue(firstCase(input).criteria[0]).expectedOutcome = "failed";
    const expectedFailure = score(input, [baseline, candidate]);
    expect(expectedFailure.candidate.quality.correctChecks).toBe(1);
    expect(expectedFailure.paired.criteria.improved).toBe(1);
  });

  it("retains a removed candidate check in coverage denominators", () => {
    const input = plan();
    requireValue(firstCase(input).criteria[0]).candidateCheckId = null;
    const report = score(input, [observed(input), observed(input, "candidate")]);
    expect(report.candidate.coverage.checks).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(report.candidate.coverage.unmappedCriteria).toBe(1);
    expect(report.candidate.quality.checkAgreement.value).toBeNull();
    expect(report.paired.criteria.coverageRegressed).toBe(1);
    expect(report.paired.criteria.regressed).toBe(0);
  });

  it("scores every frozen case even when no execution observations were supplied", () => {
    const input = plan();
    gold(input);
    const report = score(input, []);
    expect(report.cases).toHaveLength(1);
    expect(report.baseline.coverage.execution).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(report.candidate.coverage.notRunCases).toBe(1);
    expect(report.baseline.quality.falseNegatives).toBe(0);
    expect(report.baseline.quality.unresolvedExpected).toBe(1);
    expect(report.baseline.quality.recall.value).toBeNull();
  });

  it("only excludes applicability frozen before results and uses null for empty denominators", () => {
    const input = plan();
    gold(input);
    firstCase(input).applicability = {
      state: "not_applicable",
      reason: "This source fixture does not target this platform.",
    };
    const report = score(input, []);
    expect(report.baseline.coverage.applicableCases).toBe(0);
    expect(report.baseline.coverage.notApplicableCases).toBe(1);
    expect(report.baseline.coverage.notApplicableCriteria).toBe(1);
    expect(report.baseline.coverage.execution.value).toBeNull();
    expect(report.baseline.quality.recall.value).toBeNull();
    expect(report.paired.criteria.notApplicable).toBe(1);
    expect(report.paired.criteria.coverage.value).toBeNull();
  });

  it("does not let model failure erase an independently verified check", () => {
    const input = plan();
    gold(input);
    const observation = observed(input);
    observation.model = { state: "failed", reason: "The CLI execution failed." };
    const report = score(input, [observation]);
    expect(report.baseline.quality.correctChecks).toBe(1);
    expect(report.baseline.quality.falseNegatives).toBe(0);
    expect(report.baseline.coverage.models.value).toBe(0);
  });

  it.each(["blocked", "inconclusive", "not_run", "skipped"] as const)(
    "does not score %s as a failed correctness assertion",
    (outcome) => {
      const input = plan();
      const observation = observed(input);
      requireValue(observation.checks[0]).outcome = outcome;
      const report = score(input, [observation]);
      expect(report.baseline.quality.incorrectChecks).toBe(0);
      expect(report.baseline.coverage.scoredCriteria).toBe(0);
      expect(report.baseline.coverage.applicableCriteria).toBe(1);
    },
  );

  it("reports paired coverage only for the shared measured subset", () => {
    const input = plan();
    const original = firstCase(input);
    input.cases = [1, 2, 3].map((number) => ({
      ...structuredClone(original),
      caseId: `case-${number}`,
      baselineBinding: {
        cellId: `cell-baseline-${number}`,
        runId: `run-baseline-${number}`,
        requestId: "request-1",
      },
      candidateBinding: {
        cellId: `cell-candidate-${number}`,
        runId: `run-candidate-${number}`,
        requestId: "request-1",
      },
    }));
    const baselineB = observed(input, "baseline", 1);
    requireValue(baselineB.checks[0]).outcome = "failed";
    const report = score(input, [
      observed(input),
      baselineB,
      observed(input, "candidate", 1),
      observed(input, "candidate", 2),
    ]);
    expect(report.baseline.coverage.checks).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(report.candidate.coverage.checks).toEqual({
      numerator: 2,
      denominator: 3,
      value: 2 / 3,
    });
    expect(report.paired.criteria.coverage).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(report.paired.criteria.improved).toBe(1);
    expect(report.paired.criteria.coverageImproved).toBe(1);
    expect(report.paired.criteria.coverageRegressed).toBe(1);
  });
});

describe("explicit finding judgments and incomplete truth", () => {
  it("distinguishes complete empty truth from both true positives and a confirmed false positive", () => {
    const input = plan();
    const observation = observed(input);
    const empty = score(input, [observation]);
    expect(firstCase(empty).baseline.findings.state).toBe("scored");
    expect(empty.baseline.quality.truePositives).toBe(0);
    expect(empty.baseline.quality.precision.value).toBeNull();
    expect(empty.baseline.quality.recall.value).toBeNull();
    findings(observation, [key(1)]);
    const falsePositive = score(
      input,
      [observation],
      [judgment(observation, key(1), { kind: "false_positive" })],
    );
    expect(falsePositive.baseline.quality.falsePositives).toBe(1);
    expect(falsePositive.baseline.quality.precision).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    expect(falsePositive.baseline.quality.recall.value).toBeNull();
  });

  it("records known misses only after a valid complete model output and completed adjudication", () => {
    const input = plan();
    gold(input, 2);
    const report = score(input, [observed(input)]);
    expect(report.baseline.quality.falseNegatives).toBe(2);
    expect(report.baseline.quality.recall).toEqual({ numerator: 0, denominator: 2, value: 0 });
    expect(report.baseline.quality.precision.value).toBeNull();
  });

  it("reports only known-positive recall for partial annotation", () => {
    const input = plan();
    gold(input);
    firstCase(input).findings.annotation = "partial";
    const observation = observed(input);
    findings(observation, [key(1), key(2)]);
    const report = score(
      input,
      [observation],
      [
        judgment(observation, key(1), { kind: "match", expectedFindingId: "bug-1" }),
        judgment(observation, key(2), { kind: "false_positive" }),
      ],
    );
    expect(report.baseline.quality.knownPositiveRecall).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(report.baseline.quality.precision.value).toBeNull();
    expect(report.baseline.quality.recall.value).toBeNull();
    expect(report.baseline.quality.provisional).toBe(true);
    expect(report.baseline.coverage.partialAnnotationCases).toBe(1);
  });

  it.each(["partial", "unlabeled"] as const)(
    "does not turn %s empty truth into a clean-case success",
    (annotation) => {
      const input = plan();
      firstCase(input).findings = { annotation, expected: [] };
      const report = score(input, [observed(input)]);
      expect(firstCase(report).baseline.findings.annotation).toBe(annotation);
      expect(report.baseline.quality.precision.value).toBeNull();
      expect(report.baseline.quality.recall.value).toBeNull();
      expect(report.baseline.quality.provisional).toBe(true);
    },
  );

  it("counts a many-to-one duplicate without granting another true positive", () => {
    const input = plan();
    gold(input);
    const observation = observed(input);
    findings(observation, [key(1), key(2)]);
    const matches = [
      judgment(observation, key(1), { kind: "match", expectedFindingId: "bug-1" }),
      judgment(observation, key(2), { kind: "duplicate", primaryOccurrenceKey: key(1) }),
    ];
    const report = score(input, [observation], matches);
    expect(report.baseline.quality.truePositives).toBe(1);
    expect(report.baseline.quality.duplicates).toBe(1);
    expect(report.baseline.quality.falseNegatives).toBe(0);
    expect(report.baseline.quality.precision).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(report.baseline.quality.recall.value).toBe(1);
    expect(requireValue(firstCase(report).baseline.findings.expected[0]).adjudicationId).toBe(
      requireValue(matches[0]).adjudicationId,
    );
    expect(() =>
      score(
        input,
        [observation],
        [matches[0], judgment(observation, key(2), { kind: "match", expectedFindingId: "bug-1" })],
      ),
    ).toThrow(/Matched expected finding IDs/);
  });

  it("preserves ambiguous and unjudged findings without guessing false positives or misses", () => {
    const input = plan();
    gold(input, 2);
    const observation = observed(input);
    findings(observation, [key(1)]);
    for (const adjudications of [[], [judgment(observation, key(1), { kind: "unjudged" })]]) {
      const report = score(input, [observation], adjudications);
      expect(firstCase(report).baseline.findings.state).toBe("provisional");
      expect(report.baseline.quality.unjudged).toBe(1);
      expect(report.baseline.quality.unresolvedExpected).toBe(2);
      expect(report.baseline.quality.falseNegatives).toBe(0);
      expect(report.baseline.quality.falsePositives).toBe(0);
      expect(report.baseline.quality.knownPositiveRecall.value).toBeNull();
    }
  });

  it("does not advertise perfect recall while remaining known expectations are unresolved", () => {
    const input = plan();
    gold(input, 2);
    const observation = observed(input);
    findings(observation, [key(1), key(2)]);
    const report = score(
      input,
      [observation],
      [judgment(observation, key(1), { kind: "match", expectedFindingId: "bug-1" })],
    );
    expect(report.baseline.quality.truePositives).toBe(1);
    expect(report.baseline.quality.unresolvedExpected).toBe(1);
    expect(report.baseline.quality.falseNegatives).toBe(0);
    expect(report.baseline.quality.knownPositiveRecall).toEqual({
      numerator: 1,
      denominator: 2,
      value: null,
    });
  });

  it("retains settled known-positive recall while unrelated findings remain unjudged", () => {
    const input = plan();
    gold(input);
    firstCase(input).findings.annotation = "partial";
    const observation = observed(input);
    findings(observation, [key(1), key(2)]);
    const report = score(
      input,
      [observation],
      [judgment(observation, key(1), { kind: "match", expectedFindingId: "bug-1" })],
    );
    expect(report.baseline.quality.knownPositiveRecall).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(firstCase(report).baseline.findings.knownPositiveRecall.value).toBe(1);
    expect(report.baseline.quality.unjudged).toBe(1);
    expect(report.baseline.quality.provisional).toBe(true);
    expect(report.baseline.quality.precision.value).toBeNull();
    expect(report.baseline.quality.recall.value).toBeNull();
  });

  it("rejects stale, missing, repeated, and cyclic human associations", () => {
    const input = plan();
    gold(input);
    const observation = observed(input);
    findings(observation, [key(1), key(2)]);
    const primary = judgment(observation, key(1), { kind: "match", expectedFindingId: "bug-1" });
    const invalidSets = [
      [{ ...primary, resultDigest: otherDigest }],
      [{ ...primary, occurrenceKey: key(3) }],
      [{ ...primary, expectedFindingId: "unknown" }],
      [
        primary,
        {
          ...primary,
          adjudicationId: "another-judgment",
          kind: "false_positive",
          expectedFindingId: undefined,
        },
      ],
      [judgment(observation, key(1), { kind: "duplicate", primaryOccurrenceKey: key(1) })],
      [
        judgment(observation, key(1), { kind: "duplicate", primaryOccurrenceKey: key(2) }),
        judgment(observation, key(2), { kind: "duplicate", primaryOccurrenceKey: key(1) }),
      ],
    ];
    for (const invalid of invalidSets)
      expect(() => score(input, [observation], invalid)).toThrow(TypeError);
  });
});

describe("profile-only model applicability", () => {
  it("excludes both unrequested model dimensions without changing the frozen plan or check scope", () => {
    const input = plan();
    gold(input, 2);
    firstCase(input).findings.annotation = "partial";
    const frozen = freezeEvaluationScoringPlan(input);
    const originalBytes = JSON.stringify(frozen.plan);
    const originalDigest = frozen.digest;
    const report = scoreEvaluation(
      frozen,
      captureEvaluationObservations(frozen, [
        noModel(observed(input)),
        noModel(observed(input, "candidate")),
      ]),
    );
    expect(report.planDigest).toBe(originalDigest);
    expect(frozen.digest).toBe(originalDigest);
    expect(JSON.stringify(frozen.plan)).toBe(originalBytes);
    expect(JSON.stringify(input)).toBe(originalBytes);
    for (const arm of ["baseline", "candidate"] as const) {
      expect(firstCase(report)[arm].findings).toMatchObject({
        state: "not_applicable",
        modelAvailable: false,
        occurrences: [],
        expected: [
          { expectedFindingId: "bug-1", state: "not_applicable" },
          { expectedFindingId: "bug-2", state: "not_applicable" },
        ],
      });
      expect(report[arm].coverage).toMatchObject({
        applicableCases: 1,
        completedCases: 1,
        execution: { numerator: 1, denominator: 1, value: 1 },
        applicableCriteria: 1,
        scoredCriteria: 1,
        availableModels: 0,
        models: { numerator: 0, denominator: 0, value: null },
        completeAnnotationCases: 0,
        partialAnnotationCases: 0,
        unlabeledCases: 0,
        provisionalFindingCases: 0,
      });
      expect(report[arm].quality).toMatchObject({
        correctChecks: 1,
        falseNegatives: 0,
        unresolvedExpected: 0,
        provisional: false,
      });
      for (const metric of ["precision", "recall", "knownPositiveRecall"] as const)
        expect(report[arm].quality[metric]).toEqual({ numerator: 0, denominator: 0, value: null });
    }
    expect(firstCase(report).paired.modelCoverage).toBe("not_applicable");
    expect(report.paired.findings).toMatchObject({
      compared: 0,
      notApplicable: 2,
      unavailable: 0,
      coverage: { numerator: 0, denominator: 0, value: null },
    });
    expect(report.paired.criteria).toMatchObject({ compared: 1, unchanged: 1 });
  });

  it.each(["baseline", "candidate"] as const)(
    "keeps the required arm independent when only %s is N/A",
    (notApplicableArm) => {
      const input = plan();
      gold(input);
      const requiredArm = notApplicableArm === "baseline" ? "candidate" : "baseline";
      const unrequested = noModel(observed(input, notApplicableArm));
      const required = observed(input, requiredArm);
      findings(required, [key(1)]);
      const report = score(
        input,
        [unrequested, required],
        [judgment(required, key(1), { kind: "match", expectedFindingId: "bug-1" })],
      );
      expect(report[notApplicableArm].coverage.models).toEqual({
        numerator: 0,
        denominator: 0,
        value: null,
      });
      expect(report[notApplicableArm].quality.provisional).toBe(false);
      expect(report[requiredArm].coverage.models).toEqual({
        numerator: 1,
        denominator: 1,
        value: 1,
      });
      expect(report[requiredArm].quality).toMatchObject({
        truePositives: 1,
        falseNegatives: 0,
        provisional: false,
        precision: { numerator: 1, denominator: 1, value: 1 },
      });
      expect(firstCase(report).paired).toMatchObject({
        modelCoverage: "not_applicable",
        falsePositiveDelta: null,
        duplicateDelta: null,
      });
      expect(report.paired.findings).toMatchObject({
        notApplicable: 1,
        coverageImproved: 0,
        coverageRegressed: 0,
        compared: 0,
      });
      expect(report.paired.criteria.compared).toBe(1);
    },
  );

  it("keeps only requested models and findings in mixed-case denominators", () => {
    const input = plan();
    gold(input);
    const second = structuredClone(firstCase(input));
    second.caseId = "case-2";
    second.baselineBinding = {
      ...second.baselineBinding,
      cellId: "cell-baseline-2",
      runId: "run-baseline-2",
    };
    second.candidateBinding = {
      ...second.candidateBinding,
      cellId: "cell-candidate-2",
      runId: "run-candidate-2",
    };
    input.cases.push(second);
    const baseline = observed(input, "baseline", 1),
      candidate = observed(input, "candidate", 1);
    findings(baseline, [key(1)]);
    findings(candidate, [key(2)]);
    const report = score(
      input,
      [noModel(observed(input)), noModel(observed(input, "candidate")), baseline, candidate],
      [
        judgment(baseline, key(1), { kind: "match", expectedFindingId: "bug-1" }),
        judgment(candidate, key(2), { kind: "match", expectedFindingId: "bug-1" }),
      ],
    );
    for (const arm of ["baseline", "candidate"] as const) {
      expect(report[arm].coverage).toMatchObject({
        applicableCases: 2,
        applicableCriteria: 2,
        scoredCriteria: 2,
        models: { numerator: 1, denominator: 1, value: 1 },
        completeAnnotationCases: 1,
        provisionalFindingCases: 0,
      });
      expect(report[arm].quality).toMatchObject({
        truePositives: 1,
        falseNegatives: 0,
        unresolvedExpected: 0,
        recall: { numerator: 1, denominator: 1, value: 1 },
        provisional: false,
      });
    }
    expect(report.paired.findings).toMatchObject({
      compared: 1,
      notApplicable: 1,
      coverage: { numerator: 1, denominator: 1, value: 1 },
    });
  });

  it.each(["failed", "not_run", "invalid", "blocked"] as const)(
    "does not treat the other arm's %s required model as N/A",
    (state) => {
      const input = plan();
      gold(input);
      const candidate = observed(input, "candidate");
      candidate.model = { state, reason: "The requested model is unavailable." };
      const report = score(input, [noModel(observed(input)), candidate]);
      expect(report.baseline.coverage.models).toEqual({
        numerator: 0,
        denominator: 0,
        value: null,
      });
      expect(report.candidate.coverage.models).toEqual({ numerator: 0, denominator: 1, value: 0 });
      expect(firstCase(report).candidate.findings.state).toBe("unavailable");
      expect(report.candidate.quality).toMatchObject({
        correctChecks: 1,
        falseNegatives: 0,
        unresolvedExpected: 1,
        provisional: true,
      });
      expect(firstCase(report).paired.modelCoverage).toBe("not_applicable");
    },
  );

  it("keeps a missing required observation in the model and execution denominators", () => {
    const input = plan();
    gold(input);
    const report = score(input, [noModel(observed(input))]);
    expect(report.candidate.coverage).toMatchObject({
      models: { numerator: 0, denominator: 1, value: 0 },
      execution: { numerator: 0, denominator: 1, value: 0 },
      notRunCases: 1,
    });
    expect(report.candidate.quality).toMatchObject({ provisional: true, unresolvedExpected: 1 });
    expect(report.baseline.quality.provisional).toBe(false);
  });

  it.each([true, false])(
    "retains failed execution when model is N/A and declared checks are %s",
    (hasCriteria) => {
      const input = plan();
      if (!hasCriteria) firstCase(input).criteria = [];
      const baseline = noModel(observed(input));
      baseline.executionState = "failed";
      baseline.reason = "Workspace preparation failed.";
      baseline.result = null;
      baseline.checks = [];
      const report = score(input, [baseline, noModel(observed(input, "candidate"))]);
      expect(firstCase(report).baseline).toMatchObject({
        executionState: "failed",
        result: null,
        findings: { state: "not_applicable" },
      });
      expect(report.baseline.coverage).toMatchObject({
        failedCases: 1,
        execution: { numerator: 0, denominator: 1, value: 0 },
        models: { numerator: 0, denominator: 0, value: null },
      });
      expect(report.baseline.quality.provisional).toBe(true);
      if (hasCriteria)
        expect(requireValue(firstCase(report).baseline.criteria[0]).state).toBe("unavailable");
    },
  );

  it("retains conclusive failed checks without attributing failure to an unrequested model", () => {
    const input = plan();
    const candidate = noModel(observed(input, "candidate"));
    requireValue(candidate.checks[0]).outcome = "failed";
    const report = score(input, [noModel(observed(input)), candidate]);
    expect(report.candidate.quality).toMatchObject({
      incorrectChecks: 1,
      correctChecks: 0,
      checkAgreement: { numerator: 0, denominator: 1, value: 0 },
      provisional: false,
    });
    expect(report.paired.criteria.regressed).toBe(1);
    expect(report.candidate.coverage.models).toEqual({ numerator: 0, denominator: 0, value: null });
  });

  it("retains missing check evidence and its recorded outcome when models are N/A", () => {
    const input = plan();
    const candidate = noModel(observed(input, "candidate"));
    requireValue(candidate.checks[0]).evidenceAvailable = false;
    const report = score(input, [noModel(observed(input)), candidate]);
    expect(requireValue(firstCase(report).candidate.criteria[0])).toMatchObject({
      state: "unavailable",
      actualOutcome: "passed",
    });
    expect(report.candidate.coverage).toMatchObject({
      scoredCriteria: 0,
      applicableCriteria: 1,
      models: { numerator: 0, denominator: 0, value: null },
    });
    expect(report.candidate.quality).toMatchObject({
      checkAgreement: { numerator: 0, denominator: 0, value: null },
      provisional: true,
    });
    expect(report.paired.criteria.coverageRegressed).toBe(1);
  });
});

describe("model availability, source evidence, and CLI metadata", () => {
  it.each(["failed", "not_run", "invalid", "blocked"] as const)(
    "does not turn a %s model into an empty valid output",
    (state) => {
      const input = plan();
      gold(input);
      const observation = observed(input);
      observation.model = { state, reason: "A complete model observation is unavailable." };
      const report = score(input, [observation]);
      expect(firstCase(report).baseline.findings.state).toBe("unavailable");
      expect(report.baseline.quality.falseNegatives).toBe(0);
      expect(report.baseline.quality.unresolvedExpected).toBe(1);
      expect(report.baseline.quality.recall.value).toBeNull();
    },
  );

  it.each(["failed", "blocked", "invalid", "cancelled"] as const)(
    "retains an execution marked %s without fabricated result facts",
    (executionState) => {
      const input = plan();
      gold(input);
      const observation = observed(input);
      observation.executionState = executionState;
      observation.reason = "No authoritative completion is available.";
      expect(() => score(input, [observation])).toThrow(/cannot supply completed result facts/);
      observation.result = null;
      observation.checks = [];
      observation.model = { state: "not_run", reason: "The model did not run." };
      const report = score(input, [observation]);
      expect(firstCase(report).baseline.executionState).toBe(executionState);
      expect(report.baseline.quality.falseNegatives).toBe(0);
      expect(report.baseline.coverage.execution.value).toBe(0);
    },
  );

  it("keeps missing model evidence and missing check evidence independent", () => {
    const input = plan();
    gold(input);
    const observation = observed(input);
    findings(observation, [key(1)]);
    if (observation.model.state !== "complete") throw new Error("The fixture model is incomplete.");
    observation.model.evidenceAvailable = false;
    const report = score(
      input,
      [observation],
      [judgment(observation, key(1), { kind: "match", expectedFindingId: "bug-1" })],
    );
    expect(report.baseline.quality.correctChecks).toBe(1);
    expect(report.baseline.quality.truePositives).toBe(0);
    expect(report.baseline.quality.falseNegatives).toBe(0);
    expect(firstCase(report).baseline.findings.occurrences).toHaveLength(1);
    expect(firstCase(report).baseline.findings.occurrences[0]).toEqual({
      occurrenceKey: key(1),
      kind: "match",
      adjudicationId: judgment(observation, key(1), { kind: "match", expectedFindingId: "bug-1" })
        .adjudicationId,
    });
    expect(requireValue(firstCase(report).baseline.findings.expected[0]).state).toBe("unresolved");
    expect(requireValue(firstCase(report).baseline.findings.expected[0]).occurrenceKey).toBe(
      key(1),
    );
    expect(report.baseline.quality.unjudged).toBe(0);
    expect(report.baseline.quality.knownPositiveRecall.value).toBeNull();
    observation.model.evidenceAvailable = true;
    requireValue(observation.checks[0]).evidenceAvailable = false;
    const checkBlocked = score(
      input,
      [observation],
      [judgment(observation, key(1), { kind: "match", expectedFindingId: "bug-1" })],
    );
    expect(checkBlocked.baseline.quality.correctChecks).toBe(0);
    expect(checkBlocked.baseline.quality.truePositives).toBe(1);
  });

  it.each(["modified", "unknown"] as const)("does not certify %s source", (sourceState) => {
    const input = plan();
    gold(input);
    const observation = observed(input);
    observation.sourceState = sourceState;
    const report = score(input, [observation]);
    expect(report.baseline.coverage.scoredCriteria).toBe(0);
    expect(report.baseline.quality.falseNegatives).toBe(0);
    expect(report.baseline.coverage.availableModels).toBe(0);
  });

  it.each([
    { change: "CLI kind", cli: cliConfiguration({ kind: "copilot" }) },
    { change: "CLI version", cli: cliConfiguration({ version: "2.0.0" }) },
    { change: "requested model", cli: cliConfiguration({ requestedModel: "model-b" }) },
    { change: "unspecified requested model", cli: cliConfiguration({ requestedModel: null }) },
    { change: "identical CLI metadata", cli: cliConfiguration() },
  ])("scores each arm independently with $change", ({ cli }) => {
    const input = plan();
    gold(input);
    const baseline = observed(input);
    const candidate = observed(input, "candidate");
    findings(baseline, [key(1)]);
    if (candidate.model.state !== "complete") throw new Error("The fixture model is incomplete.");
    candidate.model.cli = cli;
    const frozen = freezeEvaluationScoringPlan(input);
    const captured = captureEvaluationObservations(frozen, [baseline, candidate]);
    const capturedCandidate = requireValue(
      captured.observations.find((observation) => observation.arm === "candidate"),
    );
    expect(capturedCandidate.model).toMatchObject({ state: "complete", cli });
    expect(Object.isFrozen(capturedCandidate.model)).toBe(true);
    if (capturedCandidate.model.state !== "complete")
      throw new Error("The captured fixture model is incomplete.");
    expect(Object.isFrozen(capturedCandidate.model.cli)).toBe(true);
    const report = scoreEvaluation(frozen, captured, [
      judgment(baseline, key(1), { kind: "match", expectedFindingId: "bug-1" }),
    ]);
    expect(report.baseline.quality).toMatchObject({
      truePositives: 1,
      falseNegatives: 0,
      unresolvedExpected: 0,
      recall: { numerator: 1, denominator: 1, value: 1 },
      provisional: false,
    });
    expect(report.candidate.quality).toMatchObject({
      truePositives: 0,
      falseNegatives: 1,
      unresolvedExpected: 0,
      recall: { numerator: 0, denominator: 1, value: 0 },
      provisional: false,
    });
    for (const arm of ["baseline", "candidate"] as const) {
      expect(report[arm].coverage).toMatchObject({
        availableModels: 1,
        models: { numerator: 1, denominator: 1, value: 1 },
        execution: { numerator: 1, denominator: 1, value: 1 },
      });
      expect(report[arm].quality.correctChecks).toBe(1);
      expect(firstCase(report)[arm].findings.state).toBe("scored");
    }
    expect(report.paired.findings).toMatchObject({
      compared: 1,
      unavailable: 0,
      coverage: { numerator: 1, denominator: 1, value: 1 },
    });
    expect(report.paired.criteria.compared).toBe(1);
  });

  it.each(["baseline", "candidate"] as const)(
    "keeps the other arm scored when %s model evidence is missing",
    (unavailableArm) => {
      const input = plan();
      gold(input);
      const unavailable = observed(input, unavailableArm);
      const availableArm = unavailableArm === "baseline" ? "candidate" : "baseline";
      const available = observed(input, availableArm);
      if (unavailable.model.state !== "complete")
        throw new Error("The fixture model is incomplete.");
      unavailable.model.cli = cliConfiguration({ kind: "copilot", requestedModel: null });
      unavailable.model.evidenceAvailable = false;
      const report = score(input, [unavailable, available]);
      expect(report[unavailableArm].coverage.availableModels).toBe(0);
      expect(report[unavailableArm].quality).toMatchObject({
        falseNegatives: 0,
        unresolvedExpected: 1,
        recall: { value: null },
      });
      expect(report[availableArm].coverage.availableModels).toBe(1);
      expect(report[availableArm].quality).toMatchObject({
        falseNegatives: 1,
        unresolvedExpected: 0,
        recall: { numerator: 0, denominator: 1, value: 0 },
      });
      expect(report.paired.findings.compared).toBe(0);
      expect(report.paired.criteria.compared).toBe(1);
    },
  );

  it("scores both complete outputs when neither CLI requested a specific model", () => {
    const input = plan();
    gold(input);
    const baseline = observed(input);
    const candidate = observed(input, "candidate");
    for (const observation of [baseline, candidate]) {
      if (observation.model.state !== "complete")
        throw new Error("The fixture model is incomplete.");
      observation.model.cli = cliConfiguration({ requestedModel: null });
    }
    const report = score(input, [baseline, candidate]);
    for (const arm of ["baseline", "candidate"] as const) {
      expect(report[arm].coverage.execution.value).toBe(1);
      expect(report[arm].coverage.availableModels).toBe(1);
      expect(report[arm].quality).toMatchObject({
        correctChecks: 1,
        falseNegatives: 1,
        knownPositiveRecall: { numerator: 0, denominator: 1, value: 0 },
        provisional: false,
      });
    }
    expect(report.paired.findings).toMatchObject({ compared: 1, unavailable: 0 });
  });

  it("is deterministic across owner and adjudication ordering and returns a frozen valid report", () => {
    const input = plan();
    gold(input);
    const baseline = observed(input);
    const candidate = observed(input, "candidate");
    findings(baseline, [key(2), key(1)]);
    findings(candidate, [key(3)]);
    const adjudications = [
      judgment(baseline, key(1), { kind: "match", expectedFindingId: "bug-1" }),
      judgment(baseline, key(2), { kind: "duplicate", primaryOccurrenceKey: key(1) }),
      judgment(candidate, key(3), { kind: "match", expectedFindingId: "bug-1" }),
    ];
    const first = score(input, [baseline, candidate], adjudications);
    const second = score(input, [candidate, baseline], [...adjudications].reverse());
    expect(first).toEqual(second);
    expect(() => assertEvaluationScoringReport(first)).not.toThrow();
    expect(Object.isFrozen(firstCase(first).baseline.findings)).toBe(true);
    expect(firstCase(first).paired.duplicateDelta).toBe(-1);
  });
});
