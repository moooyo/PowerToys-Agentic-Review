import { type Static, Type } from "@sinclair/typebox";

const ResultIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

const RequestedRecipeIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9][a-z0-9._-]*$",
});

const RepositoryRelativePathSchema = Type.String({
  minLength: 1,
  maxLength: 1_024,
  pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\u0000-\\u001F]+$",
});

const SourceLineSchema = Type.Integer({ minimum: 1, maximum: 10_000_000 });
const ConfidenceSchema = Type.Number({ minimum: 0, maximum: 1 });
const PrioritySchema = Type.Integer({ minimum: 0, maximum: 3 });

export const PrReviewFindingV1Schema = Type.Object(
  {
    findingId: ResultIdentifierSchema,
    priority: PrioritySchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ minLength: 1, maxLength: 8_192 }),
    path: RepositoryRelativePathSchema,
    line: SourceLineSchema,
    endLine: Type.Optional(SourceLineSchema),
    confidence: ConfidenceSchema,
  },
  { additionalProperties: false },
);
export type PrReviewFindingV1 = Static<typeof PrReviewFindingV1Schema>;

export const PrReviewPlanV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("PrReviewPlanV1"),
    summary: Type.String({ minLength: 1, maxLength: 8_192 }),
    assessment: Type.Union([
      Type.Literal("approve"),
      Type.Literal("comment"),
      Type.Literal("request_changes"),
    ]),
    findings: Type.Array(PrReviewFindingV1Schema, { maxItems: 100 }),
    requestedRecipeIds: Type.Array(RequestedRecipeIdSchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  {
    $id: "PrReviewPlanV1",
    additionalProperties: false,
  },
);
export type PrReviewPlanV1 = Static<typeof PrReviewPlanV1Schema>;

export const IssueDuplicateCandidateV1Schema = Type.Object(
  {
    number: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    reason: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);
export type IssueDuplicateCandidateV1 = Static<typeof IssueDuplicateCandidateV1Schema>;

export const IssueTriageV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("IssueTriageV1"),
    summary: Type.String({ minLength: 1, maxLength: 8_192 }),
    category: Type.Union([
      Type.Literal("bug"),
      Type.Literal("feature_request"),
      Type.Literal("documentation"),
      Type.Literal("question"),
      Type.Literal("support"),
      Type.Literal("other"),
    ]),
    priority: PrioritySchema,
    confidence: ConfidenceSchema,
    suggestedLabels: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    missingInformation: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    duplicateCandidates: Type.Array(IssueDuplicateCandidateV1Schema, { maxItems: 20 }),
    requestedRecipeIds: Type.Array(RequestedRecipeIdSchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  {
    $id: "IssueTriageV1",
    additionalProperties: false,
  },
);
export type IssueTriageV1 = Static<typeof IssueTriageV1Schema>;

export const StaticReviewResultV1Schema = Type.Union([PrReviewPlanV1Schema, IssueTriageV1Schema]);
export type StaticReviewResultV1 = Static<typeof StaticReviewResultV1Schema>;
