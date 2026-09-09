import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CliModelConfiguration, CliModelConfigurationSchema } from "./cli-model-execution.js";
import {
  type EvaluationCaseExpectation,
  EvaluationCaseExpectationSchema,
  EvaluationCellBindingSchema,
  EvaluationCheckObservationSchema,
  type EvaluationCriterion,
  EvaluationCriterionSchema,
  EvaluationFindingAdjudicationSchema,
  EvaluationFindingAdjudicationsSchema,
  EvaluationFindingExpectationsSchema,
  EvaluationModelObservationSchema,
  type EvaluationOwnerObservation,
  EvaluationOwnerObservationSchema,
  EvaluationOwnerObservationsSchema,
  EvaluationRatioSchema,
  EvaluationResultProvenanceSchema,
  EvaluationScoringConfigurationSchema,
  type EvaluationScoringPlanV1,
  EvaluationScoringPlanV1Schema,
  EvaluationScoringReportV1Schema,
  maximumEvaluationAdjudicationCount,
  maximumEvaluationCaseCount,
  maximumEvaluationCriterionCount,
  maximumEvaluationExpectedFindingCount,
  maximumEvaluationObservationCount,
  maximumEvaluationObservedFindingCount,
} from "./evaluation-scoring.js";

const existingDateTimeFormat = FormatRegistry.Get("date-time");
beforeAll(() => {
  if (existingDateTimeFormat === undefined) {
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  }
});
afterAll(() => {
  if (existingDateTimeFormat === undefined) FormatRegistry.Delete("date-time");
});

const digest = "a".repeat(64);
const timestamp = "2026-09-08T10:00:00.000Z";

function cliConfiguration(): CliModelConfiguration {
  return { kind: "codex", version: "1.0.0", requestedModel: "model-a" };
}

function occurrenceKey(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function criterion(index = 0): EvaluationCriterion {
  return {
    criterionId: `criterion-${index}`,
    description: "The configured check detects the expected behavior.",
    applicability: { state: "applicable" },
    expectedOutcome: "passed",
    baselineCheckId: `profile-baseline-v1:check-${index}`,
    candidateCheckId: `profile-candidate-v2:check-${index}`,
  };
}

function caseExpectation(index = 0): EvaluationCaseExpectation {
  return {
    caseId: `case-${index}`,
    sourceDigest: digest,
    baselineBinding: {
      cellId: `cell-baseline-${index}`,
      runId: `run-baseline-${index}`,
      requestId: `request-baseline-${index}`,
    },
    candidateBinding: {
      cellId: `cell-candidate-${index}`,
      runId: `run-candidate-${index}`,
      requestId: `request-candidate-${index}`,
    },
    applicability: { state: "applicable" },
    criteria: [criterion()],
    findings: { annotation: "complete", expected: [] },
  };
}

function plan(): EvaluationScoringPlanV1 {
  return {
    schemaVersion: "EvaluationScoringPlanV1",
    evaluationId: "evaluation-1",
    repositoryId: "repository-1",
    sampleSetVersionId: "sample-set-v1",
    expectationVersionId: "expectations-v1",
    baseline: {
      profileVersionId: "profile-baseline-v1",
      promptVersionId: "prompt-v1",
    },
    candidate: {
      profileVersionId: "profile-candidate-v2",
      promptVersionId: "prompt-v2",
    },
    cases: [caseExpectation()],
  };
}

function resultProvenance() {
  return {
    resultId: "result-1",
    resultDigest: digest,
    jobId: "job-1",
    runAttemptId: "attempt-1",
    profileVersionId: "profile-baseline-v1",
    promptVersionId: "prompt-v1",
    executionDigest: digest,
    sourceDigest: digest,
  };
}

// These are internal persistence-owner projections, not HTTP request fixtures.
// Accepting their shape does not authorize execution or establish their provenance.
function ownerObservation(): EvaluationOwnerObservation {
  return {
    evaluationId: "evaluation-1",
    repositoryId: "repository-1",
    caseId: "case-0",
    arm: "baseline",
    cellId: "cell-baseline-0",
    runId: "run-baseline-0",
    requestId: "request-baseline-0",
    executionState: "completed",
    reason: null,
    result: resultProvenance(),
    sourceState: "original",
    checks: [
      {
        checkId: "profile-baseline-v1:check-0",
        outcome: "passed",
        evidenceAvailable: true,
      },
    ],
    model: {
      state: "complete",
      evidenceAvailable: true,
      cli: cliConfiguration(),
      occurrenceKeys: [],
    },
  };
}

function adjudicationAudit() {
  return {
    adjudicationId: "adjudication-1",
    caseId: "case-0",
    arm: "baseline" as const,
    resultId: "result-1",
    resultDigest: digest,
    occurrenceKey: occurrenceKey(0),
    reason: "The reviewer compared the occurrence with the frozen expectation.",
    actor: { issuer: "https://identity.example.test", subject: "reviewer-1" },
    createdAt: timestamp,
  };
}

function matchAdjudication() {
  return { ...adjudicationAudit(), kind: "match", expectedFindingId: "expected-1" };
}

function without(value: object, property: string): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  delete result[property];
  return result;
}

describe("frozen evaluation scoring plan contracts", () => {
  it.each(["explicit-matching-v1", "explicit-matching-v2"])(
    "retains the persisted report rules version %s",
    (rulesVersion) => {
      expect(
        Value.Check(EvaluationScoringReportV1Schema.properties.rulesVersion, rulesVersion),
      ).toBe(true);
    },
  );

  it("rejects an unsupported report rules version", () => {
    expect(
      Value.Check(EvaluationScoringReportV1Schema.properties.rulesVersion, "explicit-matching-v3"),
    ).toBe(false);
  });

  it("pins evaluation, repository, configuration, and cell identities", () => {
    expect(Value.Check(EvaluationScoringPlanV1Schema, plan())).toBe(true);
  });

  it("keeps observed CLI metadata outside the frozen configuration", () => {
    for (const configuration of [plan().baseline, plan().candidate]) {
      expect(Value.Check(EvaluationScoringConfigurationSchema, configuration)).toBe(true);
      expect(
        Value.Check(EvaluationScoringConfigurationSchema, {
          ...configuration,
          cli: cliConfiguration(),
        }),
      ).toBe(false);
    }
  });

  it.each([
    "evaluationId",
    "repositoryId",
    "sampleSetVersionId",
    "expectationVersionId",
    "baseline",
    "candidate",
  ])("requires the frozen plan field %s", (field) => {
    expect(Value.Check(EvaluationScoringPlanV1Schema, without(plan(), field))).toBe(false);
  });

  it.each(["profileVersionId", "promptVersionId"])(
    "requires the frozen configuration field %s",
    (field) => {
      expect(
        Value.Check(EvaluationScoringConfigurationSchema, without(plan().baseline, field)),
      ).toBe(false);
    },
  );

  it.each(["cellId", "runId", "requestId"])("requires cell binding field %s", (field) => {
    expect(
      Value.Check(EvaluationCellBindingSchema, without(caseExpectation().baselineBinding, field)),
    ).toBe(false);
  });

  it("requires both cell bindings and rejects legacy profile-only plan identities", () => {
    for (const field of ["baselineBinding", "candidateBinding"]) {
      expect(Value.Check(EvaluationCaseExpectationSchema, without(caseExpectation(), field))).toBe(
        false,
      );
    }
    const legacy = without(without(plan(), "baseline"), "candidate");
    expect(
      Value.Check(EvaluationScoringPlanV1Schema, {
        ...legacy,
        baselineProfileVersionId: "profile-baseline-v1",
        candidateProfileVersionId: "profile-candidate-v2",
      }),
    ).toBe(false);
  });

  it("preserves qualified mappings across versions and explicit unmapped sides", () => {
    expect(Value.Check(EvaluationCriterionSchema, criterion())).toBe(true);
    for (const field of ["baselineCheckId", "candidateCheckId"]) {
      expect(Value.Check(EvaluationCriterionSchema, { ...criterion(), [field]: null })).toBe(true);
      expect(Value.Check(EvaluationCriterionSchema, without(criterion(), field))).toBe(false);
    }
    expect(
      Value.Check(EvaluationCriterionSchema, {
        ...criterion(),
        baselineCheckId: null,
        candidateCheckId: null,
      }),
    ).toBe(true);
  });

  it.each(["check-0", ":check-0", "profile-v1:", "profile v1:check-0", "../v1:check-0"])(
    "rejects an unqualified or malformed check ID: %s",
    (checkId) => {
      for (const field of ["baselineCheckId", "candidateCheckId"]) {
        expect(Value.Check(EvaluationCriterionSchema, { ...criterion(), [field]: checkId })).toBe(
          false,
        );
      }
      expect(
        Value.Check(EvaluationCheckObservationSchema, {
          checkId,
          outcome: "passed",
          evidenceAvailable: true,
        }),
      ).toBe(false);
    },
  );

  it("accepts two full-length qualified ID parts and rejects an overlong mapping", () => {
    const checkId = `${"a".repeat(128)}:${"b".repeat(128)}`;
    expect(
      Value.Check(EvaluationCriterionSchema, {
        ...criterion(),
        baselineCheckId: checkId,
        candidateCheckId: checkId,
      }),
    ).toBe(true);
    expect(
      Value.Check(EvaluationCriterionSchema, { ...criterion(), candidateCheckId: `${checkId}b` }),
    ).toBe(false);
  });

  it.each(["passed", "failed"])("accepts %s as the expected outcome", (expectedOutcome) => {
    expect(Value.Check(EvaluationCriterionSchema, { ...criterion(), expectedOutcome })).toBe(true);
  });

  it.each(["blocked", "not_run", "skipped", "inconclusive", "approve"])(
    "rejects %s as an expected truth outcome",
    (expectedOutcome) => {
      expect(Value.Check(EvaluationCriterionSchema, { ...criterion(), expectedOutcome })).toBe(
        false,
      );
    },
  );

  it.each(["complete", "partial", "unlabeled"])(
    "preserves %s annotation with empty expected truth",
    (annotation) => {
      expect(Value.Check(EvaluationFindingExpectationsSchema, { annotation, expected: [] })).toBe(
        true,
      );
    },
  );

  it("allows known positives for complete or partial truth but not unlabeled truth", () => {
    const expected = [
      { expectedFindingId: "expected-1", description: "The saved mutation repeats." },
    ];
    for (const annotation of ["complete", "partial"]) {
      expect(Value.Check(EvaluationFindingExpectationsSchema, { annotation, expected })).toBe(true);
    }
    expect(
      Value.Check(EvaluationFindingExpectationsSchema, { annotation: "unlabeled", expected }),
    ).toBe(false);
    expect(Value.Check(EvaluationFindingExpectationsSchema, { expected: [] })).toBe(false);
    expect(Value.Check(EvaluationFindingExpectationsSchema, { annotation: "complete" })).toBe(
      false,
    );
  });
});

describe("evaluation scoring collection bounds", () => {
  it("accepts 32 cases and rejects empty plans or a 33rd case", () => {
    expect(maximumEvaluationCaseCount).toBe(32);
    const cases = Array.from({ length: 32 }, (_, index) => caseExpectation(index));
    expect(Value.Check(EvaluationScoringPlanV1Schema, { ...plan(), cases })).toBe(true);
    expect(Value.Check(EvaluationScoringPlanV1Schema, { ...plan(), cases: [] })).toBe(false);
    expect(
      Value.Check(EvaluationScoringPlanV1Schema, {
        ...plan(),
        cases: [...cases, caseExpectation(32)],
      }),
    ).toBe(false);
  });

  it("accepts 96 criteria and rejects a 97th criterion", () => {
    expect(maximumEvaluationCriterionCount).toBe(96);
    const criteria = Array.from({ length: 96 }, (_, index) => criterion(index));
    expect(Value.Check(EvaluationCaseExpectationSchema, { ...caseExpectation(), criteria })).toBe(
      true,
    );
    expect(
      Value.Check(EvaluationCaseExpectationSchema, {
        ...caseExpectation(),
        criteria: [...criteria, criterion(96)],
      }),
    ).toBe(false);
  });

  it.each(["complete", "partial"])(
    "accepts 64 expected findings and rejects a 65th under %s annotation",
    (annotation) => {
      expect(maximumEvaluationExpectedFindingCount).toBe(64);
      const expected = Array.from({ length: 64 }, (_, index) => ({
        expectedFindingId: `expected-${index}`,
        description: `Expected finding ${index}.`,
      }));
      expect(Value.Check(EvaluationFindingExpectationsSchema, { annotation, expected })).toBe(true);
      expect(
        Value.Check(EvaluationFindingExpectationsSchema, {
          annotation,
          expected: [
            ...expected,
            { expectedFindingId: "expected-64", description: "One too many." },
          ],
        }),
      ).toBe(false);
    },
  );

  it("accepts 160 distinct occurrences and rejects a 161st or a repeated key", () => {
    expect(maximumEvaluationObservedFindingCount).toBe(160);
    const occurrenceKeys = Array.from({ length: 160 }, (_, index) => occurrenceKey(index));
    const model = { ...ownerObservation().model, occurrenceKeys };
    expect(Value.Check(EvaluationModelObservationSchema, model)).toBe(true);
    expect(
      Value.Check(EvaluationModelObservationSchema, {
        ...model,
        occurrenceKeys: [...occurrenceKeys, occurrenceKey(160)],
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationModelObservationSchema, {
        ...model,
        occurrenceKeys: [occurrenceKey(0), occurrenceKey(0)],
      }),
    ).toBe(false);
  });

  it("bounds owner checks at 160 and owner observations at 64", () => {
    const checks = Array.from({ length: 160 }, (_, index) => ({
      checkId: `profile-baseline-v1:check-${index}`,
      outcome: "passed",
      evidenceAvailable: true,
    }));
    expect(Value.Check(EvaluationOwnerObservationSchema, { ...ownerObservation(), checks })).toBe(
      true,
    );
    expect(
      Value.Check(EvaluationOwnerObservationSchema, {
        ...ownerObservation(),
        checks: [
          ...checks,
          { checkId: "profile-baseline-v1:check-160", outcome: "passed", evidenceAvailable: true },
        ],
      }),
    ).toBe(false);
    expect(maximumEvaluationObservationCount).toBe(64);
    const observations = Array.from({ length: 64 }, (_, index) => {
      const arm = index % 2 === 0 ? "baseline" : "candidate";
      const caseIndex = Math.floor(index / 2);
      return {
        ...ownerObservation(),
        caseId: `case-${caseIndex}`,
        arm,
        cellId: `cell-${arm}-${caseIndex}`,
        runId: `run-${arm}-${caseIndex}`,
        requestId: `request-${arm}-${caseIndex}`,
      };
    });
    expect(Value.Check(EvaluationOwnerObservationsSchema, observations)).toBe(true);
    expect(
      Value.Check(EvaluationOwnerObservationsSchema, [...observations, ownerObservation()]),
    ).toBe(false);
  });

  it("bounds explicit adjudications by both arms of all cases and their occurrence budgets", () => {
    expect(maximumEvaluationAdjudicationCount).toBe(32 * 2 * 160);
    const adjudications = Array.from({ length: maximumEvaluationAdjudicationCount }, (_, index) => {
      const cellIndex = Math.floor(index / 160);
      return {
        ...adjudicationAudit(),
        adjudicationId: `adjudication-${index}`,
        caseId: `case-${Math.floor(cellIndex / 2)}`,
        arm: cellIndex % 2 === 0 ? "baseline" : "candidate",
        resultId: `result-${cellIndex}`,
        occurrenceKey: occurrenceKey(index % 160),
        kind: "unjudged",
      };
    });
    expect(Value.Check(EvaluationFindingAdjudicationsSchema, adjudications)).toBe(true);
    expect(
      Value.Check(EvaluationFindingAdjudicationsSchema, [...adjudications, matchAdjudication()]),
    ).toBe(false);
  });
});

describe("internal evaluation owner observation contracts", () => {
  it.each(["codex", "copilot"] as const)(
    "records complete owner facts with %s CLI metadata",
    (kind) => {
      expect(Value.Check(EvaluationOwnerObservationSchema, ownerObservation())).toBe(true);
      for (const requestedModel of ["model-a", null]) {
        const cli = { ...cliConfiguration(), kind, requestedModel };
        expect(Value.Check(CliModelConfigurationSchema, cli)).toBe(true);
        expect(
          Value.Check(EvaluationOwnerObservationSchema, {
            ...ownerObservation(),
            model: { ...ownerObservation().model, cli, evidenceAvailable: false },
          }),
        ).toBe(true);
      }
    },
  );

  it("requires CLI metadata for a complete model observation", () => {
    expect(
      Value.Check(EvaluationModelObservationSchema, without(ownerObservation().model, "cli")),
    ).toBe(false);
    expect(
      Value.Check(EvaluationModelObservationSchema, { ...ownerObservation().model, cli: null }),
    ).toBe(false);
  });

  it.each(["kind", "version", "requestedModel"])("requires recorded CLI field %s", (field) => {
    const cli = without(cliConfiguration(), field);
    expect(Value.Check(CliModelConfigurationSchema, cli)).toBe(false);
    expect(
      Value.Check(EvaluationModelObservationSchema, { ...ownerObservation().model, cli }),
    ).toBe(false);
  });

  it.each([{ kind: "unsupported" }, { version: 1 }, { requestedModel: 1 }])(
    "rejects malformed CLI metadata: %j",
    (invalid) => {
      const cli = { ...cliConfiguration(), ...invalid };
      expect(Value.Check(CliModelConfigurationSchema, cli)).toBe(false);
      expect(
        Value.Check(EvaluationModelObservationSchema, { ...ownerObservation().model, cli }),
      ).toBe(false);
    },
  );

  it.each(["evaluationId", "repositoryId", "caseId", "arm", "cellId", "runId", "requestId"])(
    "requires owner scope field %s",
    (field) => {
      expect(
        Value.Check(EvaluationOwnerObservationSchema, without(ownerObservation(), field)),
      ).toBe(false);
    },
  );

  it.each([
    "resultId",
    "resultDigest",
    "jobId",
    "runAttemptId",
    "profileVersionId",
    "promptVersionId",
    "executionDigest",
    "sourceDigest",
  ])("requires result provenance field %s", (field) => {
    expect(Value.Check(EvaluationResultProvenanceSchema, without(resultProvenance(), field))).toBe(
      false,
    );
  });

  it.each(["failed", "not_run", "invalid", "blocked", "not_applicable"])(
    "records an unavailable model with explicit %s state and reason",
    (state) => {
      const model = { state, reason: "The owner could not supply a complete model output." };
      expect(Value.Check(EvaluationModelObservationSchema, model)).toBe(true);
      expect(Value.Check(EvaluationModelObservationSchema, { state })).toBe(false);
      expect(Value.Check(EvaluationModelObservationSchema, { state, reason: "  " })).toBe(false);
      expect(Value.Check(EvaluationModelObservationSchema, { ...model, occurrenceKeys: [] })).toBe(
        false,
      );
    },
  );

  it("preserves blocked execution without inventing a saved result", () => {
    expect(
      Value.Check(EvaluationOwnerObservationSchema, {
        ...ownerObservation(),
        executionState: "blocked",
        reason: "The required worker is unavailable.",
        result: null,
        sourceState: "unknown",
        checks: [],
        model: { state: "blocked", reason: "No model was run." },
      }),
    ).toBe(true);
  });

  it.each(["", "A".repeat(64), "a".repeat(63), "g".repeat(64)])(
    "rejects malformed immutable digests: %s",
    (invalidDigest) => {
      for (const field of ["resultDigest", "executionDigest", "sourceDigest"]) {
        expect(
          Value.Check(EvaluationResultProvenanceSchema, {
            ...resultProvenance(),
            [field]: invalidDigest,
          }),
        ).toBe(false);
      }
    },
  );
});

describe("explicit finding adjudication contracts", () => {
  it.each([
    { kind: "match", expectedFindingId: "expected-1" },
    { kind: "duplicate", primaryOccurrenceKey: occurrenceKey(1) },
    { kind: "false_positive" },
    { kind: "unjudged" },
  ])("accepts an audited $kind judgment", (judgment) => {
    expect(
      Value.Check(EvaluationFindingAdjudicationSchema, { ...adjudicationAudit(), ...judgment }),
    ).toBe(true);
  });

  it.each([
    { kind: "match" },
    { kind: "duplicate" },
    { kind: "match", expectedFindingId: "expected-1", primaryOccurrenceKey: occurrenceKey(1) },
    { kind: "duplicate", primaryOccurrenceKey: occurrenceKey(1), expectedFindingId: "expected-1" },
    { kind: "false_positive", expectedFindingId: "expected-1" },
    { kind: "unjudged", primaryOccurrenceKey: occurrenceKey(1) },
    { kind: "ambiguous" },
    { kind: "auto_match", expectedFindingId: "expected-1" },
  ])("rejects missing, mixed, or inferred judgment fields: %j", (judgment) => {
    expect(
      Value.Check(EvaluationFindingAdjudicationSchema, { ...adjudicationAudit(), ...judgment }),
    ).toBe(false);
  });

  it.each([
    "adjudicationId",
    "caseId",
    "arm",
    "resultId",
    "resultDigest",
    "occurrenceKey",
    "reason",
    "actor",
    "createdAt",
  ])("requires result identity and audit field %s", (field) => {
    expect(
      Value.Check(EvaluationFindingAdjudicationSchema, without(matchAdjudication(), field)),
    ).toBe(false);
  });

  it("requires both actor identifiers, a meaningful reason, and a timestamp", () => {
    for (const field of ["issuer", "subject"]) {
      expect(
        Value.Check(EvaluationFindingAdjudicationSchema, {
          ...matchAdjudication(),
          actor: without(adjudicationAudit().actor, field),
        }),
      ).toBe(false);
    }
    for (const invalid of [{ reason: " " }, { reason: "a\u0000b" }, { createdAt: "not-a-date" }]) {
      expect(
        Value.Check(EvaluationFindingAdjudicationSchema, { ...matchAdjudication(), ...invalid }),
      ).toBe(false);
    }
  });
});

describe("closed evaluation scoring shapes", () => {
  const closedShapes: Array<[string, TSchema, object]> = [
    ["plan", EvaluationScoringPlanV1Schema, plan()],
    ["configuration", EvaluationScoringConfigurationSchema, plan().baseline],
    ["cell binding", EvaluationCellBindingSchema, caseExpectation().baselineBinding],
    ["case", EvaluationCaseExpectationSchema, caseExpectation()],
    ["criterion", EvaluationCriterionSchema, criterion()],
    [
      "expected findings",
      EvaluationFindingExpectationsSchema,
      { annotation: "complete", expected: [] },
    ],
    ["owner projection", EvaluationOwnerObservationSchema, ownerObservation()],
    ["result provenance", EvaluationResultProvenanceSchema, resultProvenance()],
    ["complete model", EvaluationModelObservationSchema, ownerObservation().model],
    ["CLI metadata", CliModelConfigurationSchema, cliConfiguration()],
    [
      "unavailable model",
      EvaluationModelObservationSchema,
      { state: "blocked", reason: "Unavailable." },
    ],
    ["adjudication", EvaluationFindingAdjudicationSchema, matchAdjudication()],
    ["ratio", EvaluationRatioSchema, { numerator: 0, denominator: 0, value: null }],
  ];

  it.each(closedShapes)("rejects extra authority fields on %s", (_name, schema, value) => {
    expect(Value.Check(schema, { ...value, provenanceVerified: true })).toBe(false);
  });

  it("rejects extra fields inside applicability, expected truth, owner facts, and audit actors", () => {
    expect(
      Value.Check(EvaluationCriterionSchema, {
        ...criterion(),
        applicability: { state: "applicable", inferred: true },
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationFindingExpectationsSchema, {
        annotation: "complete",
        expected: [
          { expectedFindingId: "expected-1", description: "Expected failure.", inferred: true },
        ],
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationCheckObservationSchema, {
        checkId: "profile-v1:check-1",
        outcome: "passed",
        evidenceAvailable: true,
        trusted: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationModelObservationSchema, {
        ...ownerObservation().model,
        cli: { ...cliConfiguration(), inferred: true },
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationFindingAdjudicationSchema, {
        ...matchAdjudication(),
        actor: { ...adjudicationAudit().actor, administrator: true },
      }),
    ).toBe(false);
  });
});

describe("evaluation ratio representation", () => {
  it("uses explicit null for zero-denominator or incomplete ratios", () => {
    expect(Value.Check(EvaluationRatioSchema, { numerator: 0, denominator: 0, value: null })).toBe(
      true,
    );
    expect(Value.Check(EvaluationRatioSchema, { numerator: 1, denominator: 2, value: null })).toBe(
      true,
    );
    expect(Value.Check(EvaluationRatioSchema, { numerator: 0, denominator: 0 })).toBe(false);
  });

  it.each([
    { numerator: 0, denominator: 1, value: 0 },
    { numerator: 1, denominator: 2, value: 0.5 },
    { numerator: 1, denominator: 1, value: 1 },
  ])("accepts a bounded numeric ratio: %j", (ratio) => {
    expect(Value.Check(EvaluationRatioSchema, ratio)).toBe(true);
  });

  it.each([
    { numerator: -1, denominator: 1, value: null },
    { numerator: 0.5, denominator: 1, value: 0.5 },
    { numerator: 0, denominator: -1, value: null },
    { numerator: 0, denominator: 0.5, value: null },
    { numerator: 0, denominator: 1, value: -0.01 },
    { numerator: 1, denominator: 1, value: 1.01 },
    { numerator: 0, denominator: 0, value: "N/A" },
  ])("rejects invalid count or ratio shapes: %j", (ratio) => {
    expect(Value.Check(EvaluationRatioSchema, ratio)).toBe(false);
  });
});
