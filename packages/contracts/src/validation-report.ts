import { type Static, Type } from "@sinclair/typebox";

import { EntityIdSchema } from "./common.js";

export const ValidationOutcomeSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("not_run"),
  Type.Literal("skipped"),
  Type.Literal("inconclusive"),
]);
export type ValidationOutcome = Static<typeof ValidationOutcomeSchema>;

export const ValidationRecommendationSchema = Type.Union([
  Type.Literal("approve"),
  Type.Literal("comment"),
  Type.Literal("request_changes"),
  Type.Literal("needs_human_review"),
]);
export type ValidationRecommendation = Static<typeof ValidationRecommendationSchema>;

export const IssueReproductionConclusionSchema = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("not_reproduced"),
  Type.Literal("needs_information"),
  Type.Literal("blocked"),
  Type.Literal("inconclusive"),
]);
export type IssueReproductionConclusion = Static<typeof IssueReproductionConclusionSchema>;

const NullableEvidenceTextSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 2_048 }),
  Type.Null(),
]);

export const QualifiedValidationCheckIdSchema = Type.String({
  minLength: 3,
  maxLength: 257,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

// One screenshot per scenario step, the typed steps document, and an optional browser trace.
export const maximumValidationCheckEvidenceReferences = 34;

export const ValidationCheckResultSchema = Type.Object(
  {
    // The frozen execution plan qualifies IDs across profiles, not only within one profile.
    id: QualifiedValidationCheckIdSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    kind: Type.Union([
      Type.Literal("static"),
      Type.Literal("build"),
      Type.Literal("test"),
      Type.Literal("ui"),
    ]),
    required: Type.Boolean(),
    outcome: ValidationOutcomeSchema,
    summary: Type.String({ minLength: 1, maxLength: 2_048 }),
    expected: NullableEvidenceTextSchema,
    actual: NullableEvidenceTextSchema,
    evidenceIds: Type.Array(EntityIdSchema, {
      maxItems: maximumValidationCheckEvidenceReferences,
      uniqueItems: true,
    }),
    source: Type.Union([Type.Literal("runner"), Type.Literal("model")]),
  },
  { additionalProperties: false },
);
export type ValidationCheckResult = Static<typeof ValidationCheckResultSchema>;

const observationPathCharacter = "[^/\\\\:\\u0000-\\u001F\\u007F]";
const observationPathNonDotCharacter = "[^./\\\\:\\u0000-\\u001F\\u007F]";
const observationPathSegment = `(?:${observationPathNonDotCharacter}|\\.${observationPathNonDotCharacter}|\\.\\.${observationPathCharacter})${observationPathCharacter}*`;

export const ValidationObservationSchema = Type.Object(
  {
    id: EntityIdSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ minLength: 1, maxLength: 4_096 }),
    priority: Type.Integer({ minimum: 0, maximum: 3 }),
    path: Type.Union([
      Type.String({
        minLength: 1,
        maxLength: 1_024,
        // Portable model-output shape; Worker validation also checks the complete string and Unicode.
        pattern: `^${observationPathSegment}(?:/${observationPathSegment})*$`,
      }),
      Type.Null(),
    ]),
    line: Type.Union([Type.Integer({ minimum: 1, maximum: 10_000_000 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type ValidationObservation = Static<typeof ValidationObservationSchema>;

const ModelSummaryProperties = {
  schemaVersion: Type.Literal("ValidationSummaryV1"),
  summary: Type.String({ minLength: 1, maxLength: 8_192 }),
  observations: Type.Array(ValidationObservationSchema, { maxItems: 100 }),
};

// Model output has no checks, source state, or evidence-completeness fields. The Worker must
// validate against this schema before attaching the summary to its independently observed report.
export const PullRequestValidationSummaryV1Schema = Type.Object(
  {
    ...ModelSummaryProperties,
    workItemKind: Type.Literal("pull_request"),
    recommendation: ValidationRecommendationSchema,
  },
  { additionalProperties: false },
);
export const IssueValidationSummaryV1Schema = Type.Object(
  {
    ...ModelSummaryProperties,
    workItemKind: Type.Literal("issue"),
    reproductionConclusion: IssueReproductionConclusionSchema,
  },
  { additionalProperties: false },
);
export const ValidationSummaryV1Schema = Type.Union([
  PullRequestValidationSummaryV1Schema,
  IssueValidationSummaryV1Schema,
]);
export type ValidationSummaryV1 = Static<typeof ValidationSummaryV1Schema>;

const WorkerReportProperties = {
  schemaVersion: Type.Literal("ValidationReportV1"),
  source: Type.Literal("worker"),
  summary: Type.String({ minLength: 1, maxLength: 8_192 }),
  sourceState: Type.Union([
    Type.Literal("original"),
    Type.Literal("modified"),
    Type.Literal("unknown"),
  ]),
  // Four command phases of up to 32 steps plus up to 32 UI scenarios.
  checks: Type.Array(ValidationCheckResultSchema, { maxItems: 160 }),
};

export const PullRequestValidationReportV1Schema = Type.Object(
  {
    ...WorkerReportProperties,
    workItemKind: Type.Literal("pull_request"),
    modelSummary: Type.Optional(PullRequestValidationSummaryV1Schema),
  },
  { additionalProperties: false },
);
export const IssueValidationReportV1Schema = Type.Object(
  {
    ...WorkerReportProperties,
    workItemKind: Type.Literal("issue"),
    reproductionConclusion: IssueReproductionConclusionSchema,
    modelSummary: Type.Optional(IssueValidationSummaryV1Schema),
  },
  { additionalProperties: false },
);
export const ValidationReportV1Schema = Type.Union([
  PullRequestValidationReportV1Schema,
  IssueValidationReportV1Schema,
]);
export type ValidationReportV1 = Static<typeof ValidationReportV1Schema>;

export const ValidationLifecyclePhaseSchema = Type.Union([
  Type.Literal("setup"),
  Type.Literal("build"),
  Type.Literal("test"),
  Type.Literal("cleanup"),
  Type.Literal("profile"),
  Type.Literal("source"),
  Type.Literal("launch"),
  Type.Literal("ui"),
  Type.Literal("model_review"),
  Type.Literal("evidence"),
]);
export type ValidationLifecyclePhase = Static<typeof ValidationLifecyclePhaseSchema>;

export const ValidationLifecycleBlockerSchema = Type.Object(
  {
    phase: ValidationLifecyclePhaseSchema,
    stepId: Type.Union([QualifiedValidationCheckIdSchema, Type.Null()]),
    code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Z][A-Z0-9_]*$" }),
    message: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);
export type ValidationLifecycleBlocker = Static<typeof ValidationLifecycleBlockerSchema>;

export const ValidationStepDiagnosticSchema = Type.Object(
  {
    stepId: QualifiedValidationCheckIdSchema,
    phase: ValidationLifecyclePhaseSchema,
    outcome: ValidationOutcomeSchema,
    exitCode: Type.Union([
      Type.Integer({ minimum: -2_147_483_648, maximum: 4_294_967_295 }),
      Type.Null(),
    ]),
    summary: Type.String({ minLength: 1, maxLength: 2_048 }),
    stdout: Type.Optional(Type.String({ maxLength: 4_096 })),
    stderr: Type.Optional(Type.String({ maxLength: 4_096 })),
  },
  { additionalProperties: false },
);
export type ValidationStepDiagnostic = Static<typeof ValidationStepDiagnosticSchema>;

export const ValidationCleanupStateSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("not_needed"),
]);
export type ValidationCleanupState = Static<typeof ValidationCleanupStateSchema>;

export const ValidationExecutionDetailsSchema = Type.Object(
  {
    blockers: Type.Array(ValidationLifecycleBlockerSchema, { maxItems: 160 }),
    diagnostics: Type.Array(ValidationStepDiagnosticSchema, { maxItems: 192 }),
    cleanupState: ValidationCleanupStateSchema,
  },
  { additionalProperties: false },
);
export type ValidationExecutionDetails = Static<typeof ValidationExecutionDetailsSchema>;
