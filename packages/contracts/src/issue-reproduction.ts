import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { DateTimeSchema, EntityIdSchema, GitHubNumericIdSchema, Sha256Schema } from "./common.js";

// This module is a leaf so configuration, plans, evidence, and results can share these shapes.
export const maximumIssueReproductionCaseCount = 32;
export const maximumReproductionPredicateCount = 16;
export const maximumReproductionPreconditionCount = 16;
export const maximumObservationStringLength = 2_048;
export const maximumTestProbeFieldCount = 32;
export const maximumTestProbeOutputUtf8Bytes = 128 * 1024;
export const maximumIssueReproductionRequestUtf8Bytes = 2 * 1024 * 1024;

const ReproductionTextSchema = Type.String({
  minLength: 1,
  maxLength: 2_048,
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]+$",
});
const ExactCommitSchema = Type.String({
  minLength: 40,
  maxLength: 64,
  pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
});
// Keep this identical to QualifiedValidationCheckIdSchema without importing the report graph.
const QualifiedCheckIdSchema = Type.String({
  minLength: 3,
  maxLength: 257,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const ReproductionTargetSchema = Type.Union([
  Type.Literal("headless"),
  Type.Literal("web"),
  Type.Literal("windows_desktop"),
]);

export const ObservationValueSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("boolean"), value: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("string"),
      value: Type.String({ maxLength: maximumObservationStringLength, pattern: "^[^\\u0000]*$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("number"),
      value: Type.Number({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
    },
    { additionalProperties: false },
  ),
]);
export type ObservationValue = Static<typeof ObservationValueSchema>;

export const ReproductionObservationRefSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("ui_assertion"), scenarioId: EntityIdSchema, stepId: EntityIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("probe_value"),
      testStepId: EntityIdSchema,
      observationId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
]);
export type ReproductionObservationRef = Static<typeof ReproductionObservationRefSchema>;

export const ObservationEqualsSchema = Type.Object(
  { observation: ReproductionObservationRefSchema, equals: ObservationValueSchema },
  { additionalProperties: false },
);
export type ObservationEquals = Static<typeof ObservationEqualsSchema>;

export const ObservationSignatureSchema = Type.Object(
  {
    allOf: Type.Array(ObservationEqualsSchema, {
      minItems: 1,
      maxItems: maximumReproductionPredicateCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type ObservationSignature = Static<typeof ObservationSignatureSchema>;

export const ReproductionPreconditionSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("check_passed"), checkId: QualifiedCheckIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("observation_equals"), predicate: ObservationEqualsSchema },
    { additionalProperties: false },
  ),
]);
export type ReproductionPrecondition = Static<typeof ReproductionPreconditionSchema>;

const ReproductionCaseProperties = {
  id: EntityIdSchema,
  context: ReproductionTextSchema,
  preconditions: Type.Array(ReproductionPreconditionSchema, {
    maxItems: maximumReproductionPreconditionCount,
    uniqueItems: true,
  }),
  presentWhen: ObservationSignatureSchema,
  absentWhen: Type.Union([ObservationSignatureSchema, Type.Null()]),
};

export const IssueReproductionCaseRequestSchema = Type.Object(
  {
    ...ReproductionCaseProperties,
    profileId: EntityIdSchema,
    expectedProfileVersionId: EntityIdSchema,
  },
  { additionalProperties: false },
);
export type IssueReproductionCaseRequest = Static<typeof IssueReproductionCaseRequestSchema>;

export const IssueReproductionRequestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("IssueReproductionRequestV1"),
    claim: ReproductionTextSchema,
    cases: Type.Array(IssueReproductionCaseRequestSchema, {
      minItems: 1,
      maxItems: maximumIssueReproductionCaseCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type IssueReproductionRequestV1 = Static<typeof IssueReproductionRequestV1Schema>;

export const FrozenIssueReproductionCaseSchema = Type.Object(
  {
    ...ReproductionCaseProperties,
    requestId: EntityIdSchema,
    profileVersionId: EntityIdSchema,
    profileConfigSha256: Sha256Schema,
    target: ReproductionTargetSchema,
  },
  { additionalProperties: false },
);
export type FrozenIssueReproductionCase = Static<typeof FrozenIssueReproductionCaseSchema>;

export const IssueReproductionBindingHeaderSchema = Type.Object(
  {
    schemaVersion: Type.Literal("IssueReproductionBindingV1"),
    activationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    githubRepositoryId: GitHubNumericIdSchema,
    workItemId: EntityIdSchema,
    githubWorkItemId: GitHubNumericIdSchema,
    issueRevisionKey: Sha256Schema,
    testedSourceCommit: ExactCommitSchema,
    authorizedBy: Type.Object(
      {
        issuer: Type.String({ minLength: 1, maxLength: 2_048 }),
        subject: Type.String({ minLength: 1, maxLength: 512 }),
        authorizedAt: DateTimeSchema,
      },
      { additionalProperties: false },
    ),
    claim: ReproductionTextSchema,
  },
  { additionalProperties: false },
);
export type IssueReproductionBindingHeader = Static<typeof IssueReproductionBindingHeaderSchema>;

export const IssueReproductionBindingV1Schema = Type.Object(
  {
    ...IssueReproductionBindingHeaderSchema.properties,
    cases: Type.Array(FrozenIssueReproductionCaseSchema, {
      minItems: 1,
      maxItems: maximumIssueReproductionCaseCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type IssueReproductionBindingV1 = Static<typeof IssueReproductionBindingV1Schema>;

export const FrozenIssueReproductionBindingSchema = Type.Object(
  { binding: IssueReproductionBindingV1Schema, bindingDigest: Sha256Schema },
  { additionalProperties: false },
);
export type FrozenIssueReproductionBinding = Static<typeof FrozenIssueReproductionBindingSchema>;

export const TestProbeOutputDeclarationV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("TestProbeOutputDeclarationV1"),
    fields: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          description: ReproductionTextSchema,
          type: Type.Union([
            Type.Literal("boolean"),
            Type.Literal("string"),
            Type.Literal("number"),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: maximumTestProbeFieldCount, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);
export type TestProbeOutputDeclarationV1 = Static<typeof TestProbeOutputDeclarationV1Schema>;

export const ProbeObservationSchema = Type.Union([
  Type.Object(
    { id: EntityIdSchema, state: Type.Literal("observed"), value: ObservationValueSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { id: EntityIdSchema, state: Type.Literal("unavailable") },
    { additionalProperties: false },
  ),
]);
export type ProbeObservation = Static<typeof ProbeObservationSchema>;

export const ProbeObservationsV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ProbeObservationsV1"),
    observations: Type.Array(ProbeObservationSchema, {
      minItems: 1,
      maxItems: maximumTestProbeFieldCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type ProbeObservationsV1 = Static<typeof ProbeObservationsV1Schema>;

export const TestProbeReceiptV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("TestProbeReceiptV1"),
    requestId: EntityIdSchema,
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    planDigest: Sha256Schema,
    profileVersionId: EntityIdSchema,
    checkId: QualifiedCheckIdSchema,
    capture: Type.Literal("complete"),
    output: ProbeObservationsV1Schema,
    outputSha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type TestProbeReceiptV1 = Static<typeof TestProbeReceiptV1Schema>;

export const UiAssertionCaptureUnavailableReasonValues = [
  "not_run",
  "missing_element",
  "ambiguous_element",
  "provider_error",
  "timeout",
  "unsafe_value",
  "oversized_value",
  "unsupported_control",
  "cancelled",
  "capture_failed",
] as const;
export const UiAssertionCaptureUnavailableReasonSchema = Type.Union(
  UiAssertionCaptureUnavailableReasonValues.map((reason) => Type.Literal(reason)),
);
export type UiAssertionCaptureUnavailableReason = Static<
  typeof UiAssertionCaptureUnavailableReasonSchema
>;
export const UiAssertionCaptureV1Schema = Type.Union([
  Type.Object(
    { schemaVersion: Type.Literal("UiAssertionCaptureV1"), state: Type.Literal("complete") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal("UiAssertionCaptureV1"),
      state: Type.Literal("unavailable"),
      reason: UiAssertionCaptureUnavailableReasonSchema,
    },
    { additionalProperties: false },
  ),
]);
export type UiAssertionCaptureV1 = Static<typeof UiAssertionCaptureV1Schema>;

export const IssueReproductionCaseReasonValues = [
  "execution_pending",
  "execution_blocked",
  "precondition_failed",
  "precondition_unavailable",
  "observation_unavailable",
  "signature_not_matched",
  "positive_only",
  "conflicting_signatures",
  "source_unverified",
  "capture_unavailable",
  "evidence_unavailable",
  "lifecycle_blocked",
  "invalid_scope",
] as const;
export const IssueReproductionCaseReasonSchema = Type.Union(
  IssueReproductionCaseReasonValues.map((reason) => Type.Literal(reason)),
);
export type IssueReproductionCaseReason = Static<typeof IssueReproductionCaseReasonSchema>;

export const IssueReproductionCaseAssessmentSchema = Type.Object(
  {
    caseId: EntityIdSchema,
    requestId: EntityIdSchema,
    profileVersionId: EntityIdSchema,
    target: ReproductionTargetSchema,
    state: Type.Union([
      Type.Literal("present"),
      Type.Literal("absent"),
      Type.Literal("blocked"),
      Type.Literal("inconclusive"),
    ]),
    matchedObservationRefs: Type.Array(ReproductionObservationRefSchema, {
      maxItems: maximumReproductionPredicateCount,
      uniqueItems: true,
    }),
    evidenceIds: Type.Array(EntityIdSchema, { maxItems: 128, uniqueItems: true }),
    reasons: Type.Array(IssueReproductionCaseReasonSchema, { maxItems: 32, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export type IssueReproductionCaseAssessment = Static<typeof IssueReproductionCaseAssessmentSchema>;

const AssessmentProperties = {
  rulesVersion: Type.Literal(1),
  bindingDigest: Sha256Schema,
  planDigest: Sha256Schema,
  issueRevisionKey: Sha256Schema,
  testedSourceCommit: ExactCommitSchema,
  conclusion: Type.Union([
    Type.Literal("confirmed"),
    Type.Literal("not_reproduced"),
    Type.Literal("blocked"),
    Type.Literal("inconclusive"),
  ]),
  coverage: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
  cases: Type.Array(IssueReproductionCaseAssessmentSchema, {
    minItems: 1,
    maxItems: maximumIssueReproductionCaseCount,
    uniqueItems: true,
  }),
};
export const IssueReproductionAssessmentV1Schema = Type.Object(
  { schemaVersion: Type.Literal("IssueReproductionAssessmentV1"), ...AssessmentProperties },
  { additionalProperties: false },
);
export type IssueReproductionAssessmentV1 = Static<typeof IssueReproductionAssessmentV1Schema>;

export const IssueReproductionRequestAssessmentV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("IssueReproductionRequestAssessmentV1"),
    requestId: EntityIdSchema,
    ...AssessmentProperties,
  },
  { additionalProperties: false },
);
export type IssueReproductionRequestAssessmentV1 = Static<
  typeof IssueReproductionRequestAssessmentV1Schema
>;

const ObservationFactProperties = {
  observation: ReproductionObservationRefSchema,
  checkId: QualifiedCheckIdSchema,
  evidenceIds: Type.Array(EntityIdSchema, { maxItems: 128, uniqueItems: true }),
};
// Facts are produced only by verified capture boundaries; they are never accepted as run intent.
export const ReproductionObservationFactSchema = Type.Union([
  Type.Object(
    {
      ...ObservationFactProperties,
      state: Type.Literal("observed"),
      value: ObservationValueSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ObservationFactProperties,
      state: Type.Literal("unavailable"),
      reason: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
    },
    { additionalProperties: false },
  ),
]);
export type ReproductionObservationFact = Static<typeof ReproductionObservationFactSchema>;

function assertContract(schema: TSchema, value: unknown, description: string): void {
  if (!FormatRegistry.Has("date-time")) {
    FormatRegistry.Set(
      "date-time",
      (text) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text) &&
        Number.isFinite(Date.parse(text)),
    );
  }
  if (!Value.Check(schema, value)) {
    const error = Value.Errors(schema, value).First();
    throw new TypeError(`${description} is invalid at ${error?.path || "/"}.`);
  }
}

export function assertIssueReproductionRequest(
  value: unknown,
): asserts value is IssueReproductionRequestV1 {
  assertContract(IssueReproductionRequestV1Schema, value, "Issue reproduction request");
}

export function assertFrozenIssueReproductionBinding(
  value: unknown,
): asserts value is FrozenIssueReproductionBinding {
  assertContract(FrozenIssueReproductionBindingSchema, value, "Frozen Issue reproduction binding");
}

export function assertIssueReproductionCaseAssessment(
  value: unknown,
): asserts value is IssueReproductionCaseAssessment {
  assertContract(
    IssueReproductionCaseAssessmentSchema,
    value,
    "Issue reproduction case assessment",
  );
}

export function assertReproductionObservationFact(
  value: unknown,
): asserts value is ReproductionObservationFact {
  assertContract(ReproductionObservationFactSchema, value, "Reproduction observation fact");
}
