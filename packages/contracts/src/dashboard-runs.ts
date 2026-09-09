import { type Static, Type } from "@sinclair/typebox";

import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import {
  DashboardIssueTriageProjectionSchema,
  DashboardPrReviewFindingSchema,
} from "./dashboard.js";
import {
  DashboardReviewRunReproductionSummarySchema,
  DashboardReviewRunResultReproductionSchema,
} from "./dashboard-reproduction.js";
import { GitHubWorkItemKindSchema } from "./github.js";
import {
  IssueReproductionRequestV1Schema,
  TestProbeReceiptV1Schema,
} from "./issue-reproduction.js";
import { NullableJobAdmissionSchema } from "./job-admission.js";
import {
  ManagedRepositoryNameSchema,
  ValidationTargetSchema,
  WorkflowKindSchema,
} from "./platform-configuration.js";
import { ReviewRunTestedSourceRevisionSchema } from "./review-run.js";
import { ExecutionPhaseSchema, JobStateSchema } from "./states.js";
import {
  IssueReproductionConclusionSchema,
  QualifiedValidationCheckIdSchema,
  ValidationExecutionDetailsSchema,
  ValidationObservationSchema,
  ValidationOutcomeSchema,
  ValidationRecommendationSchema,
  ValidationReportV1Schema,
} from "./validation-report.js";

export const maximumDashboardReviewRunPageSize = 50;
export const maximumDashboardReviewRunResponseUtf8Bytes = 2 * 1024 * 1024;
export const maximumDashboardReviewRunFindingPreviewCount = 8;
export const maximumDashboardReviewRunPolicyReasonCount = 128;
export const maximumOperatorReviewRunCreateRequestUtf8Bytes = 2 * 1024 * 1024;

const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const nullableTime = Type.Union([DateTimeSchema, Type.Null()]);
const boundedText = Type.String({ minLength: 1, maxLength: 2_048 });
const pageProperties = {
  page: Type.Optional(PositiveIntegerSchema),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: maximumDashboardReviewRunPageSize })),
};
const pageResponseProperties = {
  total: NonNegativeIntegerSchema,
  page: PositiveIntegerSchema,
  pageSize: Type.Integer({ minimum: 1, maximum: maximumDashboardReviewRunPageSize }),
};
const scopeProperties = { repositoryId: EntityIdSchema, reviewRunId: EntityIdSchema };

export const DashboardReviewRunListQuerySchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    workItemId: Type.Optional(EntityIdSchema),
    ...pageProperties,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunListQuery = Static<typeof DashboardReviewRunListQuerySchema>;

export const DashboardReviewRunReadQuerySchema = Type.Object(
  {
    ...scopeProperties,
    workItemId: Type.Optional(EntityIdSchema),
  },
  { additionalProperties: false },
);
export type DashboardReviewRunReadQuery = Static<typeof DashboardReviewRunReadQuerySchema>;

export const DashboardReviewRunJobListQuerySchema = Type.Object(
  {
    ...scopeProperties,
    requestId: EntityIdSchema,
    jobId: Type.Optional(EntityIdSchema),
    ...pageProperties,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunJobListQuery = Static<typeof DashboardReviewRunJobListQuerySchema>;

export const DashboardReviewRunResultQuerySchema = Type.Object(
  {
    ...scopeProperties,
    requestId: EntityIdSchema,
    jobId: EntityIdSchema,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunResultQuery = Static<typeof DashboardReviewRunResultQuerySchema>;

export const OperatorReviewRunCreateRequestSchema = Type.Object(
  {
    activationId: EntityIdSchema,
    reproduction: Type.Optional(IssueReproductionRequestV1Schema),
    expectedRevisionKey: Sha256Schema,
    profileIds: Type.Optional(
      Type.Array(EntityIdSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    ),
    testedSourceCommit: Type.Optional(
      Type.String({ minLength: 40, maxLength: 64, pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
    ),
  },
  { additionalProperties: false },
);
export type OperatorReviewRunCreateRequest = Static<typeof OperatorReviewRunCreateRequestSchema>;

export const DashboardValidationOutcomeCountsSchema = Type.Object(
  {
    passed: NonNegativeIntegerSchema,
    failed: NonNegativeIntegerSchema,
    blocked: NonNegativeIntegerSchema,
    not_run: NonNegativeIntegerSchema,
    skipped: NonNegativeIntegerSchema,
    inconclusive: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DashboardValidationOutcomeCounts = Static<
  typeof DashboardValidationOutcomeCountsSchema
>;

// These counts describe execution only. A succeeded execution may report failed validation.
export const DashboardReviewRunExecutionCountsSchema = Type.Object(
  {
    // Missing requests have no Job; awaiting admission always identifies a real waiting Job.
    missing: NonNegativeIntegerSchema,
    awaitingAdmission: NonNegativeIntegerSchema,
    // Only admitted queued/retry_waiting Jobs count toward this queue.
    queued: NonNegativeIntegerSchema,
    active: NonNegativeIntegerSchema,
    succeeded: NonNegativeIntegerSchema,
    failed: NonNegativeIntegerSchema,
    cancelled: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunExecutionCounts = Static<
  typeof DashboardReviewRunExecutionCountsSchema
>;

export const DashboardReviewRunSummarySchema = Type.Object(
  {
    id: EntityIdSchema,
    repositoryId: EntityIdSchema,
    repository: ManagedRepositoryNameSchema,
    workItemId: EntityIdSchema,
    workItemKind: GitHubWorkItemKindSchema,
    number: PositiveIntegerSchema,
    title: Type.String({ minLength: 1, maxLength: 1_024 }),
    revisionKey: Sha256Schema,
    currentRevisionKey: Sha256Schema,
    freshness: Type.Union([Type.Literal("current"), Type.Literal("superseded")]),
    planDigest: Sha256Schema,
    activationId: EntityIdSchema,
    createdAt: DateTimeSchema,
    requestCount: Type.Integer({ minimum: 1, maximum: 32 }),
    requiredRequestCount: Type.Integer({ minimum: 0, maximum: 32 }),
    execution: DashboardReviewRunExecutionCountsSchema,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunSummary = Static<typeof DashboardReviewRunSummarySchema>;
export const DashboardReviewRunListResponseSchema = Type.Object(
  {
    items: Type.Array(DashboardReviewRunSummarySchema, {
      maxItems: maximumDashboardReviewRunPageSize,
    }),
    ...pageResponseProperties,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunListResponse = Static<typeof DashboardReviewRunListResponseSchema>;

export const DashboardReviewRunJobSchema = Type.Object(
  {
    jobId: EntityIdSchema,
    activationNumber: PositiveIntegerSchema,
    status: JobStateSchema,
    admission: NullableJobAdmissionSchema,
    phase: Type.Union([ExecutionPhaseSchema, Type.Null()]),
    attemptCount: NonNegativeIntegerSchema,
    runAttemptId: nullableId,
    createdAt: DateTimeSchema,
    startedAt: nullableTime,
    completedAt: nullableTime,
    failureCode: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    failureMessage: Type.Union([boundedText, Type.Null()]),
    resultId: nullableId,
    resultDigest: Type.Union([Sha256Schema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardReviewRunJob = Static<typeof DashboardReviewRunJobSchema>;
export const DashboardReviewRunJobListResponseSchema = Type.Object(
  {
    ...scopeProperties,
    requestId: EntityIdSchema,
    items: Type.Array(DashboardReviewRunJobSchema, { maxItems: maximumDashboardReviewRunPageSize }),
    ...pageResponseProperties,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunJobListResponse = Static<
  typeof DashboardReviewRunJobListResponseSchema
>;

export const DashboardValidationModelReviewSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("not_requested"),
    ]),
    summary: Type.Union([Type.String({ minLength: 1, maxLength: 8_192 }), Type.Null()]),
    recommendation: Type.Union([ValidationRecommendationSchema, Type.Null()]),
    findings: Type.Array(DashboardPrReviewFindingSchema, { maxItems: 100 }),
    observations: Type.Array(ValidationObservationSchema, { maxItems: 100 }),
    issueTriage: Type.Union([DashboardIssueTriageProjectionSchema, Type.Null()]),
    reproductionConclusion: Type.Union([IssueReproductionConclusionSchema, Type.Null()]),
    error: Type.Union([
      Type.Object(
        { code: Type.String({ minLength: 1, maxLength: 128 }), message: boundedText },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type DashboardValidationModelReview = Static<typeof DashboardValidationModelReviewSchema>;

export const DashboardValidationFindingPreviewSchema = Type.Object(
  {
    id: EntityIdSchema,
    priority: Type.Integer({ minimum: 0, maximum: 3 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ minLength: 1, maxLength: 512 }),
    path: Type.Union([Type.String({ minLength: 1, maxLength: 1_024 }), Type.Null()]),
    line: Type.Union([PositiveIntegerSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const DashboardValidationResultSummarySchema = Type.Object(
  {
    id: EntityIdSchema,
    resultDigest: Sha256Schema,
    createdAt: DateTimeSchema,
    summary: Type.String({ minLength: 1, maxLength: 1_024 }),
    summaryTruncated: Type.Boolean(),
    sourceState: Type.Union([
      Type.Literal("original"),
      Type.Literal("modified"),
      Type.Literal("unknown"),
    ]),
    checks: DashboardValidationOutcomeCountsSchema,
    modelReviewState: DashboardValidationModelReviewSchema.properties.state,
    recommendation: DashboardValidationModelReviewSchema.properties.recommendation,
    reproductionConclusion: DashboardValidationModelReviewSchema.properties.reproductionConclusion,
    findings: Type.Array(DashboardValidationFindingPreviewSchema, {
      maxItems: maximumDashboardReviewRunFindingPreviewCount,
    }),
    findingCount: NonNegativeIntegerSchema,
    findingsTruncated: Type.Boolean(),
    evidenceIds: Type.Array(EntityIdSchema, { maxItems: 32, uniqueItems: true }),
    evidenceCount: NonNegativeIntegerSchema,
    evidenceTruncated: Type.Boolean(),
    evidenceComplete: Type.Boolean(),
    evidenceVerificationPending: Type.Optional(Type.Literal(true)),
    lifecycleBlockerCount: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DashboardValidationResultSummary = Static<
  typeof DashboardValidationResultSummarySchema
>;

export const DashboardReviewRunRequestSchema = Type.Object(
  {
    requestId: EntityIdSchema,
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
    required: Type.Boolean(),
    profile: Type.Union([
      Type.Object(
        {
          id: EntityIdSchema,
          profileId: EntityIdSchema,
          name: Type.String({ minLength: 1, maxLength: 128 }),
          version: PositiveIntegerSchema,
          configSha256: Sha256Schema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    prompt: Type.Union([
      Type.Object(
        {
          id: EntityIdSchema,
          templateId: EntityIdSchema,
          version: PositiveIntegerSchema,
          contentSha256: Sha256Schema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    requiredCheckIds: Type.Array(QualifiedValidationCheckIdSchema, {
      maxItems: 96,
      uniqueItems: true,
    }),
    readiness: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
    blockers: Type.Array(boundedText, { maxItems: 160 }),
    blockersTruncated: Type.Boolean(),
    latestJob: Type.Union([DashboardReviewRunJobSchema, Type.Null()]),
    latestResult: Type.Union([DashboardValidationResultSummarySchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardReviewRunRequest = Static<typeof DashboardReviewRunRequestSchema>;

export const DashboardValidationPolicyReasonSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    checkId: Type.Optional(QualifiedValidationCheckIdSchema),
    requestId: Type.Optional(EntityIdSchema),
    reportIndex: Type.Optional(NonNegativeIntegerSchema),
    outcome: Type.Optional(ValidationOutcomeSchema),
    reason: Type.Optional(boundedText),
  },
  { additionalProperties: false },
);
const policyProperties = {
  policyVersion: Type.Literal("required-checks-and-p0-p1-v1"),
  reasons: Type.Array(DashboardValidationPolicyReasonSchema, {
    maxItems: maximumDashboardReviewRunPolicyReasonCount,
  }),
  reasonCount: NonNegativeIntegerSchema,
  reasonsTruncated: Type.Boolean(),
  blockingFindingCount: NonNegativeIntegerSchema,
};
const PullRequestPolicyV1Schema = Type.Object(
  { ...policyProperties, applicable: Type.Literal(true), eligible: Type.Boolean() },
  { additionalProperties: false },
);
const IssuePolicyV1Schema = Type.Object(
  { ...policyProperties, applicable: Type.Literal(false), eligible: Type.Null() },
  { additionalProperties: false },
);
const policyV2Properties = {
  ...policyProperties,
  policyVersion: Type.Literal("required-checks-and-unresolved-p0-p1-v2"),
  // The original model count remains visible even after human disposition.
  unresolvedBlockingFindingCount: NonNegativeIntegerSchema,
  findingDispositionDigest: Sha256Schema,
};
const PullRequestPolicyV2Schema = Type.Object(
  { ...policyV2Properties, applicable: Type.Literal(true), eligible: Type.Boolean() },
  { additionalProperties: false },
);
const IssuePolicyV2Schema = Type.Object(
  { ...policyV2Properties, applicable: Type.Literal(false), eligible: Type.Null() },
  { additionalProperties: false },
);
const PullRequestPolicySchema = Type.Union([PullRequestPolicyV1Schema, PullRequestPolicyV2Schema]);
const IssuePolicySchema = Type.Union([IssuePolicyV1Schema, IssuePolicyV2Schema]);
// Keep the legacy branches exact so historical policies cannot acquire V2 semantics.
export const DashboardValidationPolicySchema = Type.Union([
  PullRequestPolicyV1Schema,
  IssuePolicyV1Schema,
  PullRequestPolicyV2Schema,
  IssuePolicyV2Schema,
]);
export type DashboardValidationPolicy = Static<typeof DashboardValidationPolicySchema>;

const detailProperties = {
  ...DashboardReviewRunSummarySchema.properties,
  requestEpochId: EntityIdSchema,
  testedSourceRevision: Type.Union([ReviewRunTestedSourceRevisionSchema, Type.Null()]),
  requiredCheckIds: Type.Array(QualifiedValidationCheckIdSchema, {
    maxItems: 3_072,
    uniqueItems: true,
  }),
  requests: Type.Array(DashboardReviewRunRequestSchema, { minItems: 1, maxItems: 32 }),
  reproduction: Type.Optional(DashboardReviewRunReproductionSummarySchema),
};
export const DashboardReviewRunDetailSchema = Type.Union([
  Type.Object(
    {
      ...detailProperties,
      workItemKind: Type.Literal("pull_request"),
      policy: PullRequestPolicySchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...detailProperties, workItemKind: Type.Literal("issue"), policy: IssuePolicySchema },
    { additionalProperties: false },
  ),
]);
export type DashboardReviewRunDetail = Static<typeof DashboardReviewRunDetailSchema>;

export const DashboardReviewRunResultSchema = Type.Object(
  {
    id: EntityIdSchema,
    ...scopeProperties,
    workItemId: EntityIdSchema,
    requestId: EntityIdSchema,
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    activationNumber: PositiveIntegerSchema,
    authoritative: Type.Boolean(),
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    profileVersionId: EntityIdSchema,
    promptVersionId: EntityIdSchema,
    // This identifies the original immutable Worker envelope, not this display projection.
    resultDigest: Sha256Schema,
    createdAt: DateTimeSchema,
    evidenceComplete: Type.Boolean(),
    evidenceVerificationPending: Type.Optional(Type.Literal(true)),
    report: ValidationReportV1Schema,
    execution: ValidationExecutionDetailsSchema,
    modelReview: DashboardValidationModelReviewSchema,
    reproduction: Type.Optional(DashboardReviewRunResultReproductionSchema),
    probeReceipts: Type.Optional(Type.Array(TestProbeReceiptV1Schema, { maxItems: 32 })),
  },
  { additionalProperties: false },
);
export type DashboardReviewRunResult = Static<typeof DashboardReviewRunResultSchema>;
