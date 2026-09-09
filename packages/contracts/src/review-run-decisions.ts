import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import { DashboardValidationPolicySchema } from "./dashboard-runs.js";
import { OperatorPrincipalSchema } from "./operator-access.js";

export const maximumReviewRunDecisionPageSize = 20;
export const maximumReviewRunDecisionRequestUtf8Bytes = 16 * 1024;
export const maximumReviewRunDecisionResponseUtf8Bytes = 1024 * 1024;
export const maximumReviewRunDecisionReasonLength = 2_048;

const reasonSchema = Type.String({
  minLength: 1,
  maxLength: maximumReviewRunDecisionReasonLength,
  pattern: "\\S",
});
const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const scopeProperties = { repositoryId: EntityIdSchema, reviewRunId: EntityIdSchema };
const bindingProperties = {
  revisionKey: Sha256Schema,
  planDigest: Sha256Schema,
  resultSetDigest: Sha256Schema,
};
const nonWithdrawalActionSchema = Type.Union([
  Type.Literal("approve"),
  Type.Literal("request_changes"),
  Type.Literal("comment"),
  Type.Literal("override_approve"),
]);
const issueNonWithdrawalActionSchema = Type.Union([
  Type.Literal("request_changes"),
  Type.Literal("comment"),
]);

const changeProperties = {
  changeId: EntityIdSchema,
  expectedVersion: NonNegativeIntegerSchema,
  expectedRevisionKey: Sha256Schema,
  expectedPlanDigest: Sha256Schema,
  expectedResultSetDigest: Sha256Schema,
  reason: reasonSchema,
};

// A retry reuses the complete original intent. Only withdrawal identifies a prior event.
export const ReviewRunDecisionChangeRequestSchema = Type.Union([
  Type.Object(
    { ...changeProperties, action: nonWithdrawalActionSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...changeProperties,
      action: Type.Literal("withdraw"),
      targetDecisionId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
]);
export type ReviewRunDecisionChangeRequest = Static<typeof ReviewRunDecisionChangeRequestSchema>;

const pullRequestPolicySchema = Type.Extract(
  DashboardValidationPolicySchema,
  Type.Object({ applicable: Type.Literal(true) }),
);
const issuePolicySchema = Type.Extract(
  DashboardValidationPolicySchema,
  Type.Object({ applicable: Type.Literal(false) }),
);
const policySnapshotProperties = {
  policyVersion: Type.Literal("required-checks-and-p0-p1-v1"),
  blockingFindingCount: NonNegativeIntegerSchema,
  reasonCount: NonNegativeIntegerSchema,
  reasonCodes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    maxItems: 128,
    uniqueItems: true,
  }),
  reasonCodesTruncated: Type.Boolean(),
};
const pullRequestPolicySnapshotV1Schema = Type.Object(
  { ...policySnapshotProperties, applicable: Type.Literal(true), eligible: Type.Boolean() },
  { additionalProperties: false },
);
const issuePolicySnapshotV1Schema = Type.Object(
  { ...policySnapshotProperties, applicable: Type.Literal(false), eligible: Type.Null() },
  { additionalProperties: false },
);

const policySnapshotV2Properties = {
  ...policySnapshotProperties,
  policyVersion: Type.Literal("required-checks-and-unresolved-p0-p1-v2"),
  unresolvedBlockingFindingCount: NonNegativeIntegerSchema,
  findingDispositionDigest: Sha256Schema,
};
const pullRequestPolicySnapshotV2Schema = Type.Object(
  { ...policySnapshotV2Properties, applicable: Type.Literal(true), eligible: Type.Boolean() },
  { additionalProperties: false },
);
const issuePolicySnapshotV2Schema = Type.Object(
  { ...policySnapshotV2Properties, applicable: Type.Literal(false), eligible: Type.Null() },
  { additionalProperties: false },
);
const pullRequestPolicySnapshotSchema = Type.Union([
  pullRequestPolicySnapshotV1Schema,
  pullRequestPolicySnapshotV2Schema,
]);
const issuePolicySnapshotSchema = Type.Union([
  issuePolicySnapshotV1Schema,
  issuePolicySnapshotV2Schema,
]);

// Full contemporaneous policy details stay in the private audit record, not each history row.
export const ReviewRunDecisionPolicySnapshotSchema = Type.Union([
  pullRequestPolicySnapshotV1Schema,
  issuePolicySnapshotV1Schema,
  pullRequestPolicySnapshotV2Schema,
  issuePolicySnapshotV2Schema,
]);
export type ReviewRunDecisionPolicySnapshot = Static<typeof ReviewRunDecisionPolicySnapshotSchema>;

const eventProperties = {
  ...scopeProperties,
  ...bindingProperties,
  workItemId: EntityIdSchema,
  id: EntityIdSchema,
  changeId: EntityIdSchema,
  actor: OperatorPrincipalSchema,
  previousVersion: NonNegativeIntegerSchema,
  version: PositiveIntegerSchema,
  createdAt: DateTimeSchema,
  reason: reasonSchema,
  supersedesDecisionId: nullableId,
};
const pullRequestEventProperties = {
  ...eventProperties,
  workItemKind: Type.Literal("pull_request"),
  policyAtDecision: pullRequestPolicySnapshotSchema,
};
const issueEventProperties = {
  ...eventProperties,
  workItemKind: Type.Literal("issue"),
  policyAtDecision: issuePolicySnapshotSchema,
};
const pullRequestEventSchema = Type.Union([
  Type.Object(
    {
      ...pullRequestEventProperties,
      action: nonWithdrawalActionSchema,
      targetDecisionId: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...pullRequestEventProperties,
      action: Type.Literal("withdraw"),
      targetDecisionId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
]);
const issueEventSchema = Type.Union([
  Type.Object(
    {
      ...issueEventProperties,
      action: issueNonWithdrawalActionSchema,
      targetDecisionId: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...issueEventProperties,
      action: Type.Literal("withdraw"),
      targetDecisionId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
]);

// Human events preserve their original policy snapshot and never change runner reports.
export const ReviewRunDecisionEventSchema = Type.Union([pullRequestEventSchema, issueEventSchema]);
export type ReviewRunDecisionEvent = Static<typeof ReviewRunDecisionEventSchema>;

export const ReviewRunDecisionChangeResponseSchema = Type.Object(
  {
    // This immutable accepted receipt does not describe the current decision state.
    change: ReviewRunDecisionEventSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ReviewRunDecisionChangeResponse = Static<typeof ReviewRunDecisionChangeResponseSchema>;

const contextProperties = {
  ...scopeProperties,
  ...bindingProperties,
  workItemId: EntityIdSchema,
  currentRevisionKey: Sha256Schema,
  version: NonNegativeIntegerSchema,
  sourceCurrent: Type.Boolean(),
  recordedDecisionState: Type.Union([
    Type.Literal("none"),
    Type.Literal("current"),
    Type.Literal("stale"),
    Type.Literal("withdrawn"),
    Type.Literal("ineligible"),
  ]),
  stateReasons: Type.Array(
    Type.Union([
      Type.Literal("result_set_changed"),
      Type.Literal("source_not_current"),
      Type.Literal("approval_policy_not_satisfied"),
    ]),
    { maxItems: 3, uniqueItems: true },
  ),
};

// recordedDecision is the latest non-comment event, including a withdrawal tombstone.
// Relational checks (scope, versions, state and binding equality) remain read-boundary checks.
export const ReviewRunDecisionContextSchema = Type.Union([
  Type.Object(
    {
      ...contextProperties,
      workItemKind: Type.Literal("pull_request"),
      policy: pullRequestPolicySchema,
      recordedDecision: Type.Union([pullRequestEventSchema, Type.Null()]),
      canApprove: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...contextProperties,
      workItemKind: Type.Literal("issue"),
      policy: issuePolicySchema,
      recordedDecision: Type.Union([issueEventSchema, Type.Null()]),
      canApprove: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
]);
export type ReviewRunDecisionContext = Static<typeof ReviewRunDecisionContextSchema>;

export const ReviewRunDecisionHistoryResponseSchema = Type.Object(
  {
    ...scopeProperties,
    page: PositiveIntegerSchema,
    pageSize: Type.Integer({ minimum: 1, maximum: maximumReviewRunDecisionPageSize }),
    total: NonNegativeIntegerSchema,
    items: Type.Array(ReviewRunDecisionEventSchema, {
      maxItems: maximumReviewRunDecisionPageSize,
    }),
  },
  { additionalProperties: false },
);
export type ReviewRunDecisionHistoryResponse = Static<
  typeof ReviewRunDecisionHistoryResponseSchema
>;
