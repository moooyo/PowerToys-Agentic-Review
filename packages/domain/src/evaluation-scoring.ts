import { createHash } from "node:crypto";

import {
  assertEvaluationFindingAdjudications,
  assertEvaluationOwnerObservations,
  assertEvaluationScoringPlan,
  assertEvaluationScoringReport,
  type EvaluationArm,
  type EvaluationArmAggregate,
  type EvaluationArmCaseAssessment,
  type EvaluationCaseExpectation,
  type EvaluationCaseScore,
  type EvaluationCriterion,
  type EvaluationCriterionAssessment,
  type EvaluationFindingAdjudication,
  type EvaluationFindingAssessment,
  type EvaluationOwnerObservation,
  type EvaluationPairedChange,
  type EvaluationRatio,
  type EvaluationScoringPlanV1,
  type EvaluationScoringReportV1,
} from "@agentic-review/contracts";

export interface FrozenEvaluationScoringPlan {
  readonly plan: EvaluationScoringPlanV1;
  readonly digest: string;
}

export interface CapturedEvaluationObservations {
  readonly planDigest: string;
  readonly observations: readonly EvaluationOwnerObservation[];
}

const frozenPlans = new WeakSet<FrozenEvaluationScoringPlan>();
const capturedObservations = new WeakSet<CapturedEvaluationObservations>();
const arms = ["baseline", "candidate"] as const;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function parsed<T>(validate: (input: unknown) => void, input: unknown): T {
  validate(input);
  return JSON.parse(JSON.stringify(input)) as T;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique.`);
}

function cellKey(caseId: string, arm: EvaluationArm): string {
  return `${caseId}\0${arm}`;
}

/** Freezes scoring expectations only; this operation cannot authorize or dispatch execution. */
export function freezeEvaluationScoringPlan(input: unknown): FrozenEvaluationScoringPlan {
  const plan = parsed<EvaluationScoringPlanV1>(assertEvaluationScoringPlan, input);
  unique(
    plan.cases.map((item) => item.caseId),
    "Evaluation case IDs",
  );
  unique(
    plan.cases.flatMap((item) => arms.map((arm) => item[`${arm}Binding`].cellId)),
    "Evaluation cell IDs",
  );
  unique(
    plan.cases.flatMap((item) =>
      arms.map((arm) => {
        const binding = item[`${arm}Binding`];
        return `${binding.runId}\0${binding.requestId}`;
      }),
    ),
    "Evaluation run/request bindings",
  );
  for (const item of plan.cases) {
    unique(
      item.criteria.map((criterion) => criterion.criterionId),
      "Criterion IDs within a case",
    );
    unique(
      item.findings.expected.map((finding) => finding.expectedFindingId),
      "Expected finding IDs within a case",
    );
    for (const arm of arms) {
      const mapped = item.criteria
        .map((criterion) => criterion[`${arm}CheckId`])
        .filter((id): id is string => id !== null);
      unique(mapped, "Mapped check IDs within an arm");
      if (mapped.some((id) => !id.startsWith(`${plan[arm].profileVersionId}:`))) {
        throw new TypeError("A mapped check must belong to its arm's frozen profile version.");
      }
    }
  }
  const frozen = freeze({
    plan,
    digest: createHash("sha256").update(canonical(plan)).digest("hex"),
  });
  frozenPlans.add(frozen);
  return frozen;
}

function assertFrozen(plan: FrozenEvaluationScoringPlan): void {
  if (!frozenPlans.has(plan))
    throw new TypeError("A plan created by freezeEvaluationScoringPlan is required.");
}

/**
 * Called only by the persistence owner after checking actual evaluation-cell lineage and selected
 * attempts, canonical results, source, model identity, and required evidence. This validates the
 * projection's shape and frozen scope, not execution authority or historical-result authenticity.
 * The WeakSet marker prevents accidental plain-object use; it is not a security capability.
 * Never expose this input as an HTTP result-attachment API.
 */
export function captureEvaluationObservations(
  frozen: FrozenEvaluationScoringPlan,
  input: unknown,
): CapturedEvaluationObservations {
  assertFrozen(frozen);
  const observations = parsed<EvaluationOwnerObservation[]>(
    assertEvaluationOwnerObservations,
    input,
  );
  const cases = new Map(frozen.plan.cases.map((item) => [item.caseId, item]));
  unique(
    observations.map((item) => cellKey(item.caseId, item.arm)),
    "Observed case/arm cells",
  );
  for (const field of ["resultId", "jobId", "runAttemptId"] as const) {
    unique(
      observations.flatMap((item) => (item.result === null ? [] : [item.result[field]])),
      `Observed ${field} identities`,
    );
  }
  for (const observed of observations) {
    const expected = cases.get(observed.caseId);
    if (expected === undefined)
      throw new TypeError("An observation refers to an unknown evaluation case.");
    const binding = expected[`${observed.arm}Binding`];
    if (
      observed.evaluationId !== frozen.plan.evaluationId ||
      observed.repositoryId !== frozen.plan.repositoryId ||
      observed.cellId !== binding.cellId ||
      observed.runId !== binding.runId ||
      observed.requestId !== binding.requestId
    ) {
      throw new TypeError("An observation does not belong to its frozen evaluation cell.");
    }
    if (observed.executionState === "completed") {
      if (
        observed.result === null ||
        observed.result.sourceDigest !== expected.sourceDigest ||
        observed.result.profileVersionId !== frozen.plan[observed.arm].profileVersionId ||
        observed.result.promptVersionId !== frozen.plan[observed.arm].promptVersionId
      ) {
        throw new TypeError(
          "A completed observation requires matching source and configuration provenance.",
        );
      }
    } else if (
      observed.result !== null ||
      observed.checks.length !== 0 ||
      observed.model.state === "complete" ||
      observed.reason === null
    ) {
      throw new TypeError(
        "An unfinished or failed execution cannot supply completed result facts.",
      );
    }
    unique(
      observed.checks.map((check) => check.checkId),
      "Observed check IDs",
    );
    if (
      observed.checks.some(
        (check) => !check.checkId.startsWith(`${frozen.plan[observed.arm].profileVersionId}:`),
      )
    ) {
      throw new TypeError("An observed check belongs to another profile version.");
    }
  }
  const captured = freeze({ planDigest: frozen.digest, observations });
  capturedObservations.add(captured);
  return captured;
}

function adjudicationMap(
  plan: EvaluationScoringPlanV1,
  observations: readonly EvaluationOwnerObservation[],
  input: unknown,
): Map<string, Map<string, EvaluationFindingAdjudication>> {
  const adjudications = parsed<EvaluationFindingAdjudication[]>(
    assertEvaluationFindingAdjudications,
    input,
  );
  const cases = new Map(plan.cases.map((item) => [item.caseId, item]));
  const observed = new Map(observations.map((item) => [cellKey(item.caseId, item.arm), item]));
  unique(
    adjudications.map((item) => item.adjudicationId),
    "Adjudication IDs",
  );
  const output = new Map<string, Map<string, EvaluationFindingAdjudication>>();
  for (const adjudication of adjudications) {
    const key = cellKey(adjudication.caseId, adjudication.arm);
    const observation = observed.get(key);
    const expected = cases.get(adjudication.caseId);
    if (
      expected === undefined ||
      expected.applicability.state !== "applicable" ||
      observation?.result === null ||
      observation?.model.state !== "complete" ||
      observation.result.resultId !== adjudication.resultId ||
      observation.result.resultDigest !== adjudication.resultDigest ||
      !observation.model.occurrenceKeys.includes(adjudication.occurrenceKey)
    ) {
      throw new TypeError(
        "A finding adjudication does not match its observed result and occurrence.",
      );
    }
    if (
      adjudication.kind === "match" &&
      !expected.findings.expected.some(
        (finding) => finding.expectedFindingId === adjudication.expectedFindingId,
      )
    ) {
      throw new TypeError("A finding match refers to an unknown frozen expectation.");
    }
    const entries = output.get(key) ?? new Map<string, EvaluationFindingAdjudication>();
    if (entries.has(adjudication.occurrenceKey))
      throw new TypeError("An occurrence may have only one selected adjudication.");
    entries.set(adjudication.occurrenceKey, adjudication);
    output.set(key, entries);
  }
  for (const entries of output.values()) {
    unique(
      [...entries.values()].flatMap((item) =>
        item.kind === "match" ? [item.expectedFindingId] : [],
      ),
      "Matched expected finding IDs",
    );
    for (const entry of entries.values()) {
      if (
        entry.kind === "duplicate" &&
        (entry.primaryOccurrenceKey === entry.occurrenceKey ||
          entries.get(entry.primaryOccurrenceKey)?.kind !== "match")
      ) {
        throw new TypeError(
          "A duplicate must refer directly to a matched primary occurrence in the same result.",
        );
      }
    }
  }
  return output;
}

function ratio(numerator: number, denominator: number, ready = true): EvaluationRatio {
  if (numerator > denominator || numerator < 0 || denominator < 0)
    throw new TypeError("An evaluation ratio has invalid counts.");
  return {
    numerator,
    denominator,
    value: ready && denominator > 0 ? numerator / denominator : null,
  };
}

function criterionAssessment(
  item: EvaluationCaseExpectation,
  criterion: EvaluationCriterion,
  arm: EvaluationArm,
  observation: EvaluationOwnerObservation | undefined,
): EvaluationCriterionAssessment {
  const checkId = criterion[`${arm}CheckId`];
  const base = { criterionId: criterion.criterionId, checkId, actualOutcome: null };
  if (
    item.applicability.state === "not_applicable" ||
    criterion.applicability.state === "not_applicable"
  ) {
    return {
      ...base,
      state: "not_applicable",
      reason:
        item.applicability.state === "not_applicable"
          ? item.applicability.reason
          : criterion.applicability.state === "not_applicable"
            ? criterion.applicability.reason
            : null,
    };
  }
  if (checkId === null)
    return {
      ...base,
      state: "unmapped",
      reason: "The frozen criterion has no check mapping for this arm.",
    };
  if (
    observation === undefined ||
    ["not_run", "queued", "running", "cancelled"].includes(observation.executionState)
  ) {
    return {
      ...base,
      state: "not_run",
      reason: observation?.reason ?? "The planned cell has not produced a completed execution.",
    };
  }
  if (observation.executionState !== "completed")
    return {
      ...base,
      state: "unavailable",
      reason: observation.reason ?? "Execution is unavailable.",
    };
  if (observation.sourceState !== "original")
    return { ...base, state: "unavailable", reason: "Original source was not verified." };
  const check = observation.checks.find((value) => value.checkId === checkId);
  if (check === undefined)
    return {
      ...base,
      state: "unavailable",
      reason: "The completed result does not contain the mapped check.",
    };
  if (!check.evidenceAvailable)
    return {
      ...base,
      actualOutcome: check.outcome,
      state: "unavailable",
      reason: "Required check evidence is unavailable.",
    };
  if (["not_run", "skipped"].includes(check.outcome))
    return {
      ...base,
      actualOutcome: check.outcome,
      state: "not_run",
      reason: "The mapped check did not run.",
    };
  if (check.outcome !== "passed" && check.outcome !== "failed")
    return {
      ...base,
      actualOutcome: check.outcome,
      state: "unavailable",
      reason: "The mapped check has no conclusive observation.",
    };
  return {
    ...base,
    actualOutcome: check.outcome,
    state: check.outcome === criterion.expectedOutcome ? "correct" : "incorrect",
    reason: null,
  };
}

function modelUnavailableReason(
  plan: EvaluationScoringPlanV1,
  arm: EvaluationArm,
  observation: EvaluationOwnerObservation | undefined,
  otherObservation: EvaluationOwnerObservation | undefined,
): string | null {
  if (observation?.executionState !== "completed")
    return observation?.reason ?? "The planned model execution has not completed.";
  if (observation.sourceState !== "original") return "Original source was not verified.";
  if (observation.model.state !== "complete") return observation.model.reason;
  if (!observation.model.evidenceAvailable) return "Required model evidence is unavailable.";
  const compareModels = otherObservation?.model.state !== "not_applicable";
  const otherArm = arm === "baseline" ? "candidate" : "baseline";
  if (
    plan[arm].modelIdentityDigest === null ||
    (compareModels && plan[otherArm].modelIdentityDigest === null)
  )
    return "A frozen verified model identity is unavailable.";
  if (compareModels && plan.baseline.modelIdentityDigest !== plan.candidate.modelIdentityDigest)
    return "The two configurations do not freeze the same verified model identity.";
  if (
    observation.model.modelIdentityDigest === null ||
    observation.model.modelIdentityDigest !== plan[arm].modelIdentityDigest
  )
    return "The observed model identity is unavailable or does not match the frozen identity.";
  return null;
}

function findingAssessment(
  plan: EvaluationScoringPlanV1,
  item: EvaluationCaseExpectation,
  arm: EvaluationArm,
  observation: EvaluationOwnerObservation | undefined,
  otherObservation: EvaluationOwnerObservation | undefined,
  adjudications: ReadonlyMap<string, EvaluationFindingAdjudication>,
): EvaluationFindingAssessment {
  // Only the owner's explicit frozen-configuration projection can exclude the model dimension.
  // A missing observation, failed model or unknown identity remains applicable and unavailable.
  const applicable =
    item.applicability.state === "applicable" && observation?.model.state !== "not_applicable";
  const reason =
    item.applicability.state === "not_applicable"
      ? item.applicability.reason
      : observation?.model.state === "not_applicable"
        ? observation.model.reason
        : modelUnavailableReason(plan, arm, observation, otherObservation);
  const available = applicable && reason === null;
  const keys =
    observation?.model.state === "complete" ? [...observation.model.occurrenceKeys].sort() : [];
  const occurrences: EvaluationFindingAssessment["occurrences"] = applicable
    ? keys.map((occurrenceKey) => {
        const adjudication = adjudications.get(occurrenceKey);
        return {
          occurrenceKey,
          kind: adjudication?.kind ?? "unjudged",
          adjudicationId: adjudication?.adjudicationId ?? null,
        };
      })
    : [];
  const unjudged = occurrences.filter((entry) => entry.kind === "unjudged").length;
  const matches = new Map<string, EvaluationFindingAdjudication>();
  for (const entry of adjudications.values())
    if (entry.kind === "match") matches.set(entry.expectedFindingId, entry);
  const expected: EvaluationFindingAssessment["expected"] = item.findings.expected.map(
    (finding) => {
      const match = matches.get(finding.expectedFindingId);
      return {
        expectedFindingId: finding.expectedFindingId,
        state: !applicable
          ? "not_applicable"
          : !available
            ? "unresolved"
            : match !== undefined
              ? "matched"
              : unjudged > 0
                ? "unresolved"
                : "missed",
        occurrenceKey: match?.occurrenceKey ?? null,
        adjudicationId: match?.adjudicationId ?? null,
      };
    },
  );
  const truePositives = expected.filter((entry) => entry.state === "matched").length;
  // Misses are always restricted to the frozen known positives, even for partial annotation.
  const falseNegatives = expected.filter((entry) => entry.state === "missed").length;
  const unresolvedExpected = expected.filter((entry) => entry.state === "unresolved").length;
  const falsePositives = available
    ? occurrences.filter((entry) => entry.kind === "false_positive").length
    : 0;
  const duplicates = available
    ? occurrences.filter((entry) => entry.kind === "duplicate").length
    : 0;
  const judged = available && unjudged === 0 && item.findings.annotation !== "unlabeled";
  const complete = judged && item.findings.annotation === "complete";
  const expectedCount = applicable ? expected.length : 0;
  return {
    annotation: item.findings.annotation,
    state: !applicable
      ? "not_applicable"
      : !available
        ? "unavailable"
        : item.findings.annotation === "unlabeled"
          ? "unlabeled"
          : unjudged > 0
            ? "provisional"
            : "scored",
    reason,
    modelAvailable: available,
    expected,
    occurrences,
    truePositives,
    falsePositives,
    duplicates,
    unjudged,
    falseNegatives,
    unresolvedExpected,
    knownPositiveRecall: ratio(
      truePositives,
      expectedCount,
      available && item.findings.annotation !== "unlabeled" && unresolvedExpected === 0,
    ),
    precision: ratio(truePositives, truePositives + falsePositives + duplicates, complete),
    recall: ratio(truePositives, expectedCount, complete),
  };
}

function armAssessment(
  plan: EvaluationScoringPlanV1,
  item: EvaluationCaseExpectation,
  arm: EvaluationArm,
  observation: EvaluationOwnerObservation | undefined,
  otherObservation: EvaluationOwnerObservation | undefined,
  adjudications: ReadonlyMap<string, EvaluationFindingAdjudication>,
): EvaluationArmCaseAssessment {
  return {
    ...item[`${arm}Binding`],
    executionState: observation?.executionState ?? "not_run",
    executionReason:
      observation?.reason ?? (observation === undefined ? "The planned cell has not run." : null),
    result: observation?.result ?? null,
    criteria: item.criteria.map((criterion) =>
      criterionAssessment(item, criterion, arm, observation),
    ),
    findings: findingAssessment(plan, item, arm, observation, otherObservation, adjudications),
  };
}

function pairedChange(
  before: boolean | null,
  after: boolean | null,
  applicable: boolean,
): EvaluationPairedChange {
  if (!applicable) return "not_applicable";
  if (before === null && after === null) return "unavailable";
  if (before === null) return "coverage_improved";
  if (after === null) return "coverage_regressed";
  if (before === after) return "unchanged";
  return after ? "improved" : "regressed";
}

function checkValue(check: EvaluationCriterionAssessment | undefined): boolean | null {
  return check?.state === "correct" ? true : check?.state === "incorrect" ? false : null;
}

function pairCase(
  item: EvaluationCaseExpectation,
  baseline: EvaluationArmCaseAssessment,
  candidate: EvaluationArmCaseAssessment,
): EvaluationCaseScore["paired"] {
  const applicable = item.applicability.state === "applicable";
  const modelsApplicable =
    applicable &&
    baseline.findings.state !== "not_applicable" &&
    candidate.findings.state !== "not_applicable";
  const allFindingsComparable =
    baseline.findings.state === "scored" &&
    candidate.findings.state === "scored" &&
    item.findings.annotation === "complete";
  return {
    criteria: item.criteria.map((criterion, index) => ({
      criterionId: criterion.criterionId,
      change: pairedChange(
        checkValue(baseline.criteria[index]),
        checkValue(candidate.criteria[index]),
        applicable && criterion.applicability.state === "applicable",
      ),
    })),
    findings: item.findings.expected.map((finding, index) => {
      const before = baseline.findings.expected[index]?.state;
      const after = candidate.findings.expected[index]?.state;
      return {
        expectedFindingId: finding.expectedFindingId,
        change: pairedChange(
          before === "matched" ? true : before === "missed" ? false : null,
          after === "matched" ? true : after === "missed" ? false : null,
          modelsApplicable,
        ),
      };
    }),
    modelCoverage: pairedChange(
      baseline.findings.modelAvailable ? true : null,
      candidate.findings.modelAvailable ? true : null,
      modelsApplicable,
    ),
    falsePositiveDelta: allFindingsComparable
      ? candidate.findings.falsePositives - baseline.findings.falsePositives
      : null,
    duplicateDelta: allFindingsComparable
      ? candidate.findings.duplicates - baseline.findings.duplicates
      : null,
  };
}

function aggregate(cases: EvaluationCaseScore[], arm: EvaluationArm): EvaluationArmAggregate {
  const applicable = cases.filter((item) => item.applicable).map((item) => item[arm]);
  const checks = cases.flatMap((item) => item[arm].criteria);
  const findings = applicable
    .map((item) => item.findings)
    .filter((item) => item.state !== "not_applicable");
  const sum = (
    field:
      | "truePositives"
      | "falsePositives"
      | "duplicates"
      | "unjudged"
      | "falseNegatives"
      | "unresolvedExpected",
  ) => findings.reduce((total, item) => total + item[field], 0);
  const checkCount = (state: EvaluationCriterionAssessment["state"]) =>
    checks.filter((item) => item.state === state).length;
  const executionCount = (state: EvaluationOwnerObservation["executionState"]) =>
    applicable.filter((item) => item.executionState === state).length;
  const correctChecks = checkCount("correct");
  const incorrectChecks = checkCount("incorrect");
  const scoredCriteria = correctChecks + incorrectChecks;
  const applicableCriteria = checks.length - checkCount("not_applicable");
  const availableModels = findings.filter((item) => item.modelAvailable).length;
  const truePositives = sum("truePositives");
  const falsePositives = sum("falsePositives");
  const duplicates = sum("duplicates");
  const knownExpected = findings.reduce((total, item) => total + item.expected.length, 0);
  const knownReady = findings.every((item) =>
    item.annotation === "unlabeled"
      ? item.expected.length === 0
      : item.modelAvailable && item.unresolvedExpected === 0,
  );
  const complete = findings.every(
    (item) => item.annotation === "complete" && item.state === "scored",
  );
  return {
    coverage: {
      applicableCases: applicable.length,
      notApplicableCases: cases.length - applicable.length,
      completedCases: executionCount("completed"),
      pendingCases: executionCount("queued") + executionCount("running"),
      notRunCases: executionCount("not_run"),
      failedCases: executionCount("failed"),
      blockedCases: executionCount("blocked"),
      cancelledCases: executionCount("cancelled"),
      invalidCases: executionCount("invalid"),
      execution: ratio(executionCount("completed"), applicable.length),
      applicableCriteria,
      scoredCriteria,
      unmappedCriteria: checkCount("unmapped"),
      unavailableCriteria: checkCount("unavailable"),
      notRunCriteria: checkCount("not_run"),
      notApplicableCriteria: checkCount("not_applicable"),
      checks: ratio(scoredCriteria, applicableCriteria),
      availableModels,
      models: ratio(availableModels, findings.length),
      completeAnnotationCases: findings.filter((item) => item.annotation === "complete").length,
      partialAnnotationCases: findings.filter((item) => item.annotation === "partial").length,
      unlabeledCases: findings.filter((item) => item.annotation === "unlabeled").length,
      provisionalFindingCases: findings.filter((item) => item.state !== "scored").length,
    },
    quality: {
      correctChecks,
      incorrectChecks,
      checkAgreement: ratio(correctChecks, scoredCriteria),
      truePositives,
      falsePositives,
      duplicates,
      unjudged: sum("unjudged"),
      falseNegatives: sum("falseNegatives"),
      unresolvedExpected: sum("unresolvedExpected"),
      knownPositiveRecall: ratio(truePositives, knownExpected, knownReady),
      precision: ratio(truePositives, truePositives + falsePositives + duplicates, complete),
      recall: ratio(truePositives, knownExpected, complete),
      provisional:
        !complete ||
        scoredCriteria !== applicableCriteria ||
        executionCount("completed") !== applicable.length,
    },
  };
}

function pairedAggregate(
  changes: EvaluationPairedChange[],
): EvaluationScoringReportV1["paired"]["criteria"] {
  const count = (change: EvaluationPairedChange) =>
    changes.filter((item) => item === change).length;
  const compared = count("improved") + count("regressed") + count("unchanged");
  return {
    compared,
    improved: count("improved"),
    regressed: count("regressed"),
    unchanged: count("unchanged"),
    coverageImproved: count("coverage_improved"),
    coverageRegressed: count("coverage_regressed"),
    unavailable: count("unavailable"),
    notApplicable: count("not_applicable"),
    coverage: ratio(compared, changes.length - count("not_applicable")),
  };
}

export const EVALUATION_SCORING_RULES_VERSION = "explicit-matching-v2" as const;

/** Scores all frozen cases, including missing cells. No I/O, dispatch, result selection, or writes. */
export function scoreEvaluation(
  frozen: FrozenEvaluationScoringPlan,
  captured: CapturedEvaluationObservations,
  adjudications: unknown = [],
): EvaluationScoringReportV1 {
  assertFrozen(frozen);
  if (!capturedObservations.has(captured) || captured.planDigest !== frozen.digest) {
    throw new TypeError("Owner-captured observations for this exact scoring plan are required.");
  }
  const observed = new Map(
    captured.observations.map((item) => [cellKey(item.caseId, item.arm), item]),
  );
  const judgments = adjudicationMap(frozen.plan, captured.observations, adjudications);
  const cases: EvaluationCaseScore[] = frozen.plan.cases.map((item) => {
    const baselineKey = cellKey(item.caseId, "baseline");
    const candidateKey = cellKey(item.caseId, "candidate");
    const baseline = armAssessment(
      frozen.plan,
      item,
      "baseline",
      observed.get(baselineKey),
      observed.get(candidateKey),
      judgments.get(baselineKey) ?? new Map(),
    );
    const candidate = armAssessment(
      frozen.plan,
      item,
      "candidate",
      observed.get(candidateKey),
      observed.get(baselineKey),
      judgments.get(candidateKey) ?? new Map(),
    );
    return {
      caseId: item.caseId,
      applicable: item.applicability.state === "applicable",
      baseline,
      candidate,
      paired: pairCase(item, baseline, candidate),
    };
  });
  const report: EvaluationScoringReportV1 = {
    schemaVersion: "EvaluationScoringReportV1",
    rulesVersion: EVALUATION_SCORING_RULES_VERSION,
    planDigest: frozen.digest,
    cases,
    baseline: aggregate(cases, "baseline"),
    candidate: aggregate(cases, "candidate"),
    paired: {
      criteria: pairedAggregate(
        cases.flatMap((item) => item.paired.criteria.map((criterion) => criterion.change)),
      ),
      findings: pairedAggregate(
        cases.flatMap((item) => item.paired.findings.map((finding) => finding.change)),
      ),
    },
  };
  assertEvaluationScoringReport(report);
  return freeze(report);
}
