import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import { GitHubWorkItemKindSchema } from "./github.js";
import { OperatorPrincipalSchema } from "./operator-access.js";
import { ValidationTargetSchema, WorkflowKindSchema } from "./platform-configuration.js";

export const maximumFindingDispositionPageSize = 20;
export const maximumFindingDispositionRequestUtf8Bytes = 16 * 1024;
export const maximumFindingDispositionResponseUtf8Bytes = 2 * 1024 * 1024;
export const maximumFindingDispositionReasonLength = 2_048;
export const maximumFindingResultOccurrenceCount = 200;
export const maximumFindingComparisonRowCount = 400;

const scopeProperties = {
  repositoryId: EntityIdSchema,
  reviewRunId: EntityIdSchema,
  requestId: EntityIdSchema,
  jobId: EntityIdSchema,
};
const pageProperties = {
  page: PositiveIntegerSchema,
  pageSize: Type.Integer({ minimum: 1, maximum: maximumFindingDispositionPageSize }),
};
const findingCountSchema = Type.Integer({
  minimum: 0,
  maximum: maximumFindingResultOccurrenceCount,
});
const ordinalSchema = Type.Integer({ minimum: 0, maximum: 99 });
const prioritySchema = Type.Integer({ minimum: 0, maximum: 3 });
const titleSchema = Type.String({ minLength: 1, maxLength: 256 });
const pathSchema = Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]);
const lineSchema = Type.Union([PositiveIntegerSchema, Type.Null()]);
const reasonSchema = Type.String({
  minLength: 1,
  maxLength: maximumFindingDispositionReasonLength,
  // Preserve explanatory paragraphs while excluding unsupported control characters.
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$",
});

export const FindingOccurrenceKindSchema = Type.Union([
  Type.Literal("pr_finding"),
  Type.Literal("validation_observation"),
]);
export type FindingOccurrenceKind = Static<typeof FindingOccurrenceKindSchema>;

export const FindingOccurrenceRefSchema = Type.Object(
  {
    key: Sha256Schema,
    resultId: EntityIdSchema,
    resultDigest: Sha256Schema,
    kind: FindingOccurrenceKindSchema,
    // This is the index in the original immutable model array, never a display position.
    ordinal: ordinalSchema,
  },
  { additionalProperties: false },
);
export type FindingOccurrenceRef = Static<typeof FindingOccurrenceRefSchema>;

export const FindingDispositionStateSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("accepted"),
  Type.Literal("dismissed"),
  Type.Literal("resolved"),
]);
export type FindingDispositionState = Static<typeof FindingDispositionStateSchema>;

export const FindingDispositionActionSchema = Type.Union([
  Type.Literal("accept"),
  Type.Literal("dismiss"),
  Type.Literal("resolve"),
  Type.Literal("reopen"),
]);
export type FindingDispositionAction = Static<typeof FindingDispositionActionSchema>;

export const FindingDispositionSchema = Type.Object(
  {
    state: FindingDispositionStateSchema,
    version: NonNegativeIntegerSchema,
    lastEventId: Type.Union([EntityIdSchema, Type.Null()]),
    updatedAt: Type.Union([DateTimeSchema, Type.Null()]),
    updatedBy: Type.Union([OperatorPrincipalSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type FindingDisposition = Static<typeof FindingDispositionSchema>;

export const FindingOccurrenceSchema = Type.Object(
  {
    ...FindingOccurrenceRefSchema.properties,
    modelId: Type.String({ minLength: 1, maxLength: 128 }),
    title: titleSchema,
    body: Type.String({ minLength: 1, maxLength: 8_192 }),
    priority: prioritySchema,
    path: pathSchema,
    line: lineSchema,
    endLine: lineSchema,
    confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    disposition: FindingDispositionSchema,
  },
  { additionalProperties: false },
);
export type FindingOccurrence = Static<typeof FindingOccurrenceSchema>;

export const FindingModelAvailabilitySchema = Type.Union([
  Type.Literal("complete"),
  Type.Literal("failed"),
  Type.Literal("not_requested"),
  Type.Literal("not_applicable"),
]);
export type FindingModelAvailability = Static<typeof FindingModelAvailabilitySchema>;

export const FindingResultContextSchema = Type.Object(
  {
    ...scopeProperties,
    workItemId: EntityIdSchema,
    workItemKind: GitHubWorkItemKindSchema,
    resultId: EntityIdSchema,
    resultDigest: Sha256Schema,
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    profileVersionId: EntityIdSchema,
    promptVersionId: EntityIdSchema,
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
    activationNumber: PositiveIntegerSchema,
    createdAt: DateTimeSchema,
    contextDigest: Sha256Schema,
    sourceCurrent: Type.Boolean(),
    latestForRequest: Type.Boolean(),
    historical: Type.Boolean(),
    modelAvailability: FindingModelAvailabilitySchema,
    findingCount: findingCountSchema,
    dispositionDigest: Sha256Schema,
  },
  { additionalProperties: false },
);
export type FindingResultContext = Static<typeof FindingResultContextSchema>;

export const FindingListSummarySchema = Type.Object(
  {
    open: findingCountSchema,
    accepted: findingCountSchema,
    dismissed: findingCountSchema,
    resolved: findingCountSchema,
    rawBlocking: findingCountSchema,
    unresolvedBlocking: findingCountSchema,
  },
  { additionalProperties: false },
);
export type FindingListSummary = Static<typeof FindingListSummarySchema>;

export const FindingListResponseSchema = Type.Object(
  {
    context: FindingResultContextSchema,
    items: Type.Array(FindingOccurrenceSchema, { maxItems: maximumFindingDispositionPageSize }),
    total: findingCountSchema,
    ...pageProperties,
    summary: FindingListSummarySchema,
  },
  { additionalProperties: false },
);
export type FindingListResponse = Static<typeof FindingListResponseSchema>;

export const FindingDispositionChangeRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    expectedVersion: NonNegativeIntegerSchema,
    expectedResultDigest: Sha256Schema,
    expectedContextDigest: Sha256Schema,
    kind: FindingOccurrenceKindSchema,
    ordinal: ordinalSchema,
    action: FindingDispositionActionSchema,
    reason: reasonSchema,
  },
  { additionalProperties: false },
);
export type FindingDispositionChangeRequest = Static<typeof FindingDispositionChangeRequestSchema>;

export const FindingDispositionEventSchema = Type.Object(
  {
    id: EntityIdSchema,
    changeId: EntityIdSchema,
    ...scopeProperties,
    workItemId: EntityIdSchema,
    workItemKind: GitHubWorkItemKindSchema,
    occurrence: FindingOccurrenceRefSchema,
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    resultSetDigestAtChange: Sha256Schema,
    contextDigestAtChange: Sha256Schema,
    sourceCurrentAtChange: Type.Boolean(),
    latestForRequestAtChange: Type.Boolean(),
    previousState: FindingDispositionStateSchema,
    state: FindingDispositionStateSchema,
    previousVersion: NonNegativeIntegerSchema,
    version: PositiveIntegerSchema,
    action: FindingDispositionActionSchema,
    reason: reasonSchema,
    actor: OperatorPrincipalSchema,
    createdAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type FindingDispositionEvent = Static<typeof FindingDispositionEventSchema>;

export const FindingDispositionChangeResponseSchema = Type.Object(
  {
    // The receipt describes the accepted event, not the current disposition.
    change: FindingDispositionEventSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type FindingDispositionChangeResponse = Static<
  typeof FindingDispositionChangeResponseSchema
>;

export const FindingDispositionHistoryResponseSchema = Type.Object(
  {
    ...scopeProperties,
    occurrence: FindingOccurrenceRefSchema,
    ...pageProperties,
    total: NonNegativeIntegerSchema,
    items: Type.Array(FindingDispositionEventSchema, {
      maxItems: maximumFindingDispositionPageSize,
    }),
  },
  { additionalProperties: false },
);
export type FindingDispositionHistoryResponse = Static<
  typeof FindingDispositionHistoryResponseSchema
>;

export const FindingComparisonSideSchema = Type.Object(
  {
    ...FindingOccurrenceRefSchema.properties,
    title: titleSchema,
    priority: prioritySchema,
    path: pathSchema,
    line: lineSchema,
  },
  { additionalProperties: false },
);
export type FindingComparisonSide = Static<typeof FindingComparisonSideSchema>;

export const FindingComparisonRowSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("persistent"),
      Type.Literal("new"),
      Type.Literal("not_observed_again"),
      Type.Literal("incomparable"),
    ]),
    before: Type.Union([FindingComparisonSideSchema, Type.Null()]),
    after: Type.Union([FindingComparisonSideSchema, Type.Null()]),
    reason: Type.Union([
      Type.Literal("ambiguous_match"),
      Type.Literal("configuration_changed"),
      Type.Literal("model_unavailable"),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type FindingComparisonRow = Static<typeof FindingComparisonRowSchema>;

export const FindingComparisonResponseSchema = Type.Object(
  {
    algorithmVersion: Type.Literal("exact-content-v1"),
    before: FindingResultContextSchema,
    after: FindingResultContextSchema,
    compatible: Type.Boolean(),
    reasons: Type.Array(
      Type.Union([
        Type.Literal("configuration_changed"),
        Type.Literal("model_unavailable"),
        Type.Literal("same_result"),
        Type.Literal("baseline_not_earlier"),
      ]),
      { maxItems: 4, uniqueItems: true },
    ),
    items: Type.Array(FindingComparisonRowSchema, { maxItems: maximumFindingDispositionPageSize }),
    total: Type.Integer({ minimum: 0, maximum: maximumFindingComparisonRowCount }),
    ...pageProperties,
  },
  { additionalProperties: false },
);
export type FindingComparisonResponse = Static<typeof FindingComparisonResponseSchema>;
