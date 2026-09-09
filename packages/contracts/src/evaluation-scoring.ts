import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { CliModelConfigurationSchema } from "./cli-model-execution.js";
import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
import { QualifiedValidationCheckIdSchema, ValidationOutcomeSchema } from "./validation-report.js";

export const maximumEvaluationCaseCount = 32;
export const maximumEvaluationCriterionCount = 96;
export const maximumEvaluationExpectedFindingCount = 64;
export const maximumEvaluationObservedFindingCount = 160;
export const maximumEvaluationObservationCount = maximumEvaluationCaseCount * 2;
export const maximumEvaluationAdjudicationCount =
  maximumEvaluationObservationCount * maximumEvaluationObservedFindingCount;
export const maximumEvaluationScoringInputUtf8Bytes = 16 * 1024 * 1024;

const boundedText = Type.String({
  minLength: 1,
  maxLength: 2_048,
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]+$",
});
const nullableText = Type.Union([boundedText, Type.Null()]);
const nullableCheckId = Type.Union([QualifiedValidationCheckIdSchema, Type.Null()]);
const count = Type.Integer({ minimum: 0, maximum: maximumEvaluationAdjudicationCount });

export const EvaluationArmSchema = Type.Union([
  Type.Literal("baseline"),
  Type.Literal("candidate"),
]);
export type EvaluationArm = Static<typeof EvaluationArmSchema>;

export const EvaluationApplicabilitySchema = Type.Union([
  Type.Object({ state: Type.Literal("applicable") }, { additionalProperties: false }),
  Type.Object(
    { state: Type.Literal("not_applicable"), reason: boundedText },
    { additionalProperties: false },
  ),
]);

export const EvaluationCriterionSchema = Type.Object(
  {
    criterionId: EntityIdSchema,
    description: boundedText,
    applicability: EvaluationApplicabilitySchema,
    expectedOutcome: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    baselineCheckId: nullableCheckId,
    candidateCheckId: nullableCheckId,
  },
  { additionalProperties: false },
);
export type EvaluationCriterion = Static<typeof EvaluationCriterionSchema>;

const expectedFinding = Type.Object(
  { expectedFindingId: EntityIdSchema, description: boundedText },
  { additionalProperties: false },
);
export const EvaluationFindingExpectationsSchema = Type.Union([
  ...(["complete", "partial"] as const).map((annotation) =>
    Type.Object(
      {
        annotation: Type.Literal(annotation),
        expected: Type.Array(expectedFinding, { maxItems: maximumEvaluationExpectedFindingCount }),
      },
      { additionalProperties: false },
    ),
  ),
  Type.Object(
    {
      annotation: Type.Literal("unlabeled"),
      expected: Type.Array(expectedFinding, { maxItems: 0 }),
    },
    { additionalProperties: false },
  ),
]);

export const EvaluationCellBindingSchema = Type.Object(
  { cellId: EntityIdSchema, runId: EntityIdSchema, requestId: EntityIdSchema },
  { additionalProperties: false },
);

export const EvaluationScoringConfigurationSchema = Type.Object(
  {
    profileVersionId: EntityIdSchema,
    promptVersionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const EvaluationCaseExpectationSchema = Type.Object(
  {
    caseId: EntityIdSchema,
    sourceDigest: Sha256Schema,
    baselineBinding: EvaluationCellBindingSchema,
    candidateBinding: EvaluationCellBindingSchema,
    applicability: EvaluationApplicabilitySchema,
    criteria: Type.Array(EvaluationCriterionSchema, { maxItems: maximumEvaluationCriterionCount }),
    findings: EvaluationFindingExpectationsSchema,
  },
  { additionalProperties: false },
);
export type EvaluationCaseExpectation = Static<typeof EvaluationCaseExpectationSchema>;

// This is the scoring slice of a frozen evaluation plan, not an execution authorization.
export const EvaluationScoringPlanV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationScoringPlanV1"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    sampleSetVersionId: EntityIdSchema,
    expectationVersionId: EntityIdSchema,
    baseline: EvaluationScoringConfigurationSchema,
    candidate: EvaluationScoringConfigurationSchema,
    cases: Type.Array(EvaluationCaseExpectationSchema, {
      minItems: 1,
      maxItems: maximumEvaluationCaseCount,
    }),
  },
  { additionalProperties: false },
);
export type EvaluationScoringPlanV1 = Static<typeof EvaluationScoringPlanV1Schema>;

export const EvaluationExecutionStateSchema = Type.Union([
  Type.Literal("not_run"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("cancelled"),
  Type.Literal("invalid"),
]);
export type EvaluationExecutionState = Static<typeof EvaluationExecutionStateSchema>;

export const EvaluationResultProvenanceSchema = Type.Object(
  {
    resultId: EntityIdSchema,
    resultDigest: Sha256Schema,
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    profileVersionId: EntityIdSchema,
    promptVersionId: EntityIdSchema,
    executionDigest: Sha256Schema,
    sourceDigest: Sha256Schema,
  },
  { additionalProperties: false },
);

export const EvaluationCheckObservationSchema = Type.Object(
  {
    checkId: QualifiedValidationCheckIdSchema,
    outcome: ValidationOutcomeSchema,
    evidenceAvailable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const EvaluationModelObservationSchema = Type.Union([
  Type.Object(
    {
      state: Type.Literal("complete"),
      evidenceAvailable: Type.Boolean(),
      cli: CliModelConfigurationSchema,
      occurrenceKeys: Type.Array(Sha256Schema, {
        maxItems: maximumEvaluationObservedFindingCount,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  ...(["failed", "not_run", "invalid", "blocked", "not_applicable"] as const).map((state) =>
    Type.Object(
      { state: Type.Literal(state), reason: boundedText },
      { additionalProperties: false },
    ),
  ),
]);

// Internal owner projection only. Never compose this schema into an HTTP request schema.
// The persistence owner must verify selected job/attempt/result, source, and evidence before
// supplying these facts. Schema validation alone does not establish that provenance.
export const EvaluationOwnerObservationSchema = Type.Object(
  {
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    caseId: EntityIdSchema,
    arm: EvaluationArmSchema,
    cellId: EntityIdSchema,
    runId: EntityIdSchema,
    requestId: EntityIdSchema,
    executionState: EvaluationExecutionStateSchema,
    reason: nullableText,
    result: Type.Union([EvaluationResultProvenanceSchema, Type.Null()]),
    sourceState: Type.Union([
      Type.Literal("original"),
      Type.Literal("modified"),
      Type.Literal("unknown"),
    ]),
    checks: Type.Array(EvaluationCheckObservationSchema, { maxItems: 160 }),
    model: EvaluationModelObservationSchema,
  },
  { additionalProperties: false },
);
export type EvaluationOwnerObservation = Static<typeof EvaluationOwnerObservationSchema>;
export const EvaluationOwnerObservationsSchema = Type.Array(EvaluationOwnerObservationSchema, {
  maxItems: maximumEvaluationObservationCount,
});

const adjudicationProperties = {
  adjudicationId: EntityIdSchema,
  caseId: EntityIdSchema,
  arm: EvaluationArmSchema,
  resultId: EntityIdSchema,
  resultDigest: Sha256Schema,
  occurrenceKey: Sha256Schema,
  reason: boundedText,
  actor: Type.Object(
    {
      issuer: Type.String({ minLength: 1, maxLength: 2_048 }),
      subject: Type.String({ minLength: 1, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
  createdAt: DateTimeSchema,
};
export const EvaluationFindingAdjudicationSchema = Type.Union([
  Type.Object(
    { ...adjudicationProperties, kind: Type.Literal("match"), expectedFindingId: EntityIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...adjudicationProperties,
      kind: Type.Literal("duplicate"),
      primaryOccurrenceKey: Sha256Schema,
    },
    { additionalProperties: false },
  ),
  ...(["false_positive", "unjudged"] as const).map((kind) =>
    Type.Object(
      { ...adjudicationProperties, kind: Type.Literal(kind) },
      { additionalProperties: false },
    ),
  ),
]);
export type EvaluationFindingAdjudication = Static<typeof EvaluationFindingAdjudicationSchema>;
export const EvaluationFindingAdjudicationsSchema = Type.Array(
  EvaluationFindingAdjudicationSchema,
  {
    maxItems: maximumEvaluationAdjudicationCount,
  },
);

// Null also means that incomplete observations or judgments prevent a final ratio.
export const EvaluationRatioSchema = Type.Object(
  {
    numerator: count,
    denominator: count,
    value: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type EvaluationRatio = Static<typeof EvaluationRatioSchema>;

export const EvaluationCriterionAssessmentSchema = Type.Object(
  {
    criterionId: EntityIdSchema,
    checkId: nullableCheckId,
    state: Type.Union([
      Type.Literal("correct"),
      Type.Literal("incorrect"),
      Type.Literal("unmapped"),
      Type.Literal("not_applicable"),
      Type.Literal("not_run"),
      Type.Literal("unavailable"),
    ]),
    actualOutcome: Type.Union([ValidationOutcomeSchema, Type.Null()]),
    reason: nullableText,
  },
  { additionalProperties: false },
);
export type EvaluationCriterionAssessment = Static<typeof EvaluationCriterionAssessmentSchema>;

const expectedFindingAssessment = Type.Object(
  {
    expectedFindingId: EntityIdSchema,
    state: Type.Union([
      Type.Literal("matched"),
      Type.Literal("missed"),
      Type.Literal("unresolved"),
      Type.Literal("not_applicable"),
    ]),
    occurrenceKey: Type.Union([Sha256Schema, Type.Null()]),
    adjudicationId: Type.Union([EntityIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
const occurrenceAssessment = Type.Object(
  {
    occurrenceKey: Sha256Schema,
    kind: Type.Union([
      Type.Literal("match"),
      Type.Literal("duplicate"),
      Type.Literal("false_positive"),
      Type.Literal("unjudged"),
    ]),
    adjudicationId: Type.Union([EntityIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export const EvaluationFindingAssessmentSchema = Type.Object(
  {
    annotation: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("unlabeled"),
    ]),
    state: Type.Union([
      Type.Literal("scored"),
      Type.Literal("provisional"),
      Type.Literal("unlabeled"),
      Type.Literal("unavailable"),
      Type.Literal("not_applicable"),
    ]),
    reason: nullableText,
    modelAvailable: Type.Boolean(),
    expected: Type.Array(expectedFindingAssessment, {
      maxItems: maximumEvaluationExpectedFindingCount,
    }),
    occurrences: Type.Array(occurrenceAssessment, {
      maxItems: maximumEvaluationObservedFindingCount,
    }),
    truePositives: count,
    falsePositives: count,
    duplicates: count,
    unjudged: count,
    falseNegatives: count,
    unresolvedExpected: count,
    knownPositiveRecall: EvaluationRatioSchema,
    precision: EvaluationRatioSchema,
    recall: EvaluationRatioSchema,
  },
  { additionalProperties: false },
);
export type EvaluationFindingAssessment = Static<typeof EvaluationFindingAssessmentSchema>;

export const EvaluationArmCaseAssessmentSchema = Type.Object(
  {
    cellId: EntityIdSchema,
    runId: EntityIdSchema,
    requestId: EntityIdSchema,
    executionState: EvaluationExecutionStateSchema,
    executionReason: nullableText,
    result: Type.Union([EvaluationResultProvenanceSchema, Type.Null()]),
    criteria: Type.Array(EvaluationCriterionAssessmentSchema, {
      maxItems: maximumEvaluationCriterionCount,
    }),
    findings: EvaluationFindingAssessmentSchema,
  },
  { additionalProperties: false },
);
export type EvaluationArmCaseAssessment = Static<typeof EvaluationArmCaseAssessmentSchema>;

export const EvaluationPairedChangeSchema = Type.Union([
  Type.Literal("improved"),
  Type.Literal("regressed"),
  Type.Literal("unchanged"),
  Type.Literal("coverage_improved"),
  Type.Literal("coverage_regressed"),
  Type.Literal("unavailable"),
  Type.Literal("not_applicable"),
]);
export type EvaluationPairedChange = Static<typeof EvaluationPairedChangeSchema>;
const nullableDelta = Type.Union([
  Type.Integer({
    minimum: -maximumEvaluationAdjudicationCount,
    maximum: maximumEvaluationAdjudicationCount,
  }),
  Type.Null(),
]);

export const EvaluationCaseScoreSchema = Type.Object(
  {
    caseId: EntityIdSchema,
    applicable: Type.Boolean(),
    baseline: EvaluationArmCaseAssessmentSchema,
    candidate: EvaluationArmCaseAssessmentSchema,
    paired: Type.Object(
      {
        criteria: Type.Array(
          Type.Object(
            { criterionId: EntityIdSchema, change: EvaluationPairedChangeSchema },
            { additionalProperties: false },
          ),
          { maxItems: maximumEvaluationCriterionCount },
        ),
        findings: Type.Array(
          Type.Object(
            { expectedFindingId: EntityIdSchema, change: EvaluationPairedChangeSchema },
            { additionalProperties: false },
          ),
          { maxItems: maximumEvaluationExpectedFindingCount },
        ),
        modelCoverage: EvaluationPairedChangeSchema,
        falsePositiveDelta: nullableDelta,
        duplicateDelta: nullableDelta,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type EvaluationCaseScore = Static<typeof EvaluationCaseScoreSchema>;

export const EvaluationArmAggregateSchema = Type.Object(
  {
    coverage: Type.Object(
      {
        applicableCases: count,
        notApplicableCases: count,
        completedCases: count,
        pendingCases: count,
        notRunCases: count,
        failedCases: count,
        blockedCases: count,
        cancelledCases: count,
        invalidCases: count,
        execution: EvaluationRatioSchema,
        applicableCriteria: count,
        scoredCriteria: count,
        unmappedCriteria: count,
        unavailableCriteria: count,
        notRunCriteria: count,
        notApplicableCriteria: count,
        checks: EvaluationRatioSchema,
        availableModels: count,
        models: EvaluationRatioSchema,
        completeAnnotationCases: count,
        partialAnnotationCases: count,
        unlabeledCases: count,
        provisionalFindingCases: count,
      },
      { additionalProperties: false },
    ),
    quality: Type.Object(
      {
        correctChecks: count,
        incorrectChecks: count,
        checkAgreement: EvaluationRatioSchema,
        truePositives: count,
        falsePositives: count,
        duplicates: count,
        unjudged: count,
        falseNegatives: count,
        unresolvedExpected: count,
        knownPositiveRecall: EvaluationRatioSchema,
        precision: EvaluationRatioSchema,
        recall: EvaluationRatioSchema,
        provisional: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type EvaluationArmAggregate = Static<typeof EvaluationArmAggregateSchema>;

const pairedCounts = Type.Object(
  {
    compared: count,
    improved: count,
    regressed: count,
    unchanged: count,
    coverageImproved: count,
    coverageRegressed: count,
    unavailable: count,
    notApplicable: count,
    coverage: EvaluationRatioSchema,
  },
  { additionalProperties: false },
);
export const EvaluationScoringReportV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationScoringReportV1"),
    rulesVersion: Type.Union([
      Type.Literal("explicit-matching-v1"),
      Type.Literal("explicit-matching-v2"),
    ]),
    planDigest: Sha256Schema,
    cases: Type.Array(EvaluationCaseScoreSchema, {
      minItems: 1,
      maxItems: maximumEvaluationCaseCount,
    }),
    baseline: EvaluationArmAggregateSchema,
    candidate: EvaluationArmAggregateSchema,
    paired: Type.Object(
      { criteria: pairedCounts, findings: pairedCounts },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type EvaluationScoringReportV1 = Static<typeof EvaluationScoringReportV1Schema>;

function assertScoringContract(schema: TSchema, input: unknown, label: string): void {
  if (!FormatRegistry.Has("date-time")) {
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  }
  const json = JSON.stringify(input);
  if (
    json === undefined ||
    new TextEncoder().encode(json).byteLength > maximumEvaluationScoringInputUtf8Bytes ||
    !Value.Check(schema, input)
  ) {
    throw new TypeError(`${label} is invalid or exceeds the supported size.`);
  }
}

export function assertEvaluationScoringPlan(
  input: unknown,
): asserts input is EvaluationScoringPlanV1 {
  assertScoringContract(EvaluationScoringPlanV1Schema, input, "Evaluation scoring plan");
}

export function assertEvaluationOwnerObservations(
  input: unknown,
): asserts input is EvaluationOwnerObservation[] {
  assertScoringContract(EvaluationOwnerObservationsSchema, input, "Owner evaluation observations");
}

export function assertEvaluationFindingAdjudications(
  input: unknown,
): asserts input is EvaluationFindingAdjudication[] {
  assertScoringContract(EvaluationFindingAdjudicationsSchema, input, "Finding adjudications");
}

export function assertEvaluationScoringReport(
  input: unknown,
): asserts input is EvaluationScoringReportV1 {
  assertScoringContract(EvaluationScoringReportV1Schema, input, "Evaluation scoring report");
}
