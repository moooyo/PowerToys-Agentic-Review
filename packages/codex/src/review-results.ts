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

const ModelResultIdentifierSchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const ModelRequestedRecipeIdSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9._-]*$",
});
const ModelRepositoryRelativePathSchema = Type.String({
  description:
    "Repository-relative path using '/' separators. Do not use an absolute path, drive prefix, or '..' path segment.",
  pattern: "^[^/\\\\\\u0000-\\u001F][^\\\\\\u0000-\\u001F]*$",
});
const createModelSourceLineSchema = () => Type.Integer({ minimum: 1, maximum: 10_000_000 });
const ModelConfidenceSchema = Type.Number({ minimum: 0, maximum: 1 });
const ModelPrioritySchema = Type.Integer({ minimum: 0, maximum: 3 });

export const PrReviewFindingV1Schema = Type.Object(
  {
    findingId: ResultIdentifierSchema,
    priority: PrioritySchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ minLength: 1, maxLength: 8_192 }),
    path: RepositoryRelativePathSchema,
    line: SourceLineSchema,
    endLine: Type.Union([SourceLineSchema, Type.Null()]),
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

const PrReviewFindingV1ModelOutputSchema = Type.Object(
  {
    findingId: ModelResultIdentifierSchema,
    priority: ModelPrioritySchema,
    title: Type.String(),
    body: Type.String(),
    path: ModelRepositoryRelativePathSchema,
    line: createModelSourceLineSchema(),
    endLine: Type.Union([createModelSourceLineSchema(), Type.Null()]),
    confidence: ModelConfidenceSchema,
  },
  { additionalProperties: false },
);

export const PrReviewPlanV1ModelOutputSchema = Type.Object(
  {
    schemaVersion: Type.Literal("PrReviewPlanV1"),
    summary: Type.String(),
    assessment: Type.Union([
      Type.Literal("approve"),
      Type.Literal("comment"),
      Type.Literal("request_changes"),
    ]),
    findings: Type.Array(PrReviewFindingV1ModelOutputSchema, { maxItems: 100 }),
    requestedRecipeIds: Type.Array(ModelRequestedRecipeIdSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
);

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

const IssueDuplicateCandidateV1ModelOutputSchema = Type.Object(
  {
    number: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

export const IssueTriageV1ModelOutputSchema = Type.Object(
  {
    schemaVersion: Type.Literal("IssueTriageV1"),
    summary: Type.String(),
    category: Type.Union([
      Type.Literal("bug"),
      Type.Literal("feature_request"),
      Type.Literal("documentation"),
      Type.Literal("question"),
      Type.Literal("support"),
      Type.Literal("other"),
    ]),
    priority: ModelPrioritySchema,
    confidence: ModelConfidenceSchema,
    suggestedLabels: Type.Array(Type.String(), { maxItems: 32 }),
    missingInformation: Type.Array(Type.String(), { maxItems: 32 }),
    duplicateCandidates: Type.Array(IssueDuplicateCandidateV1ModelOutputSchema, {
      maxItems: 20,
    }),
    requestedRecipeIds: Type.Array(ModelRequestedRecipeIdSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
);

export const ReviewResultV1Schema = Type.Union([PrReviewPlanV1Schema, IssueTriageV1Schema]);
export type ReviewResultV1 = Static<typeof ReviewResultV1Schema>;
