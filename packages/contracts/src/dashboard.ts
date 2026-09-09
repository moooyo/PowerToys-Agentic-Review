import { type Static, Type } from "@sinclair/typebox";

import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import {
  ReviewExecutionEvidenceSchema,
  RunFailureDiagnosticsSchema,
  VerificationReportSchema,
} from "./execution-evidence.js";
import {
  GitHubActorSchema,
  GitHubWorkItemKindSchema,
  GitHubWorkItemRevisionSchema,
} from "./github.js";
import {
  getJobAdmissionIssues,
  JobAdmissionStateSchema,
  NullableJobAdmissionSchema,
} from "./job-admission.js";
import {
  AuthorizationDecisionReasonSchema,
  AuthorizationDecisionSchema,
  AuthorizedRequestEpochSchema,
  SchedulingRequestKindSchema,
} from "./scheduling.js";
import {
  ExecutionPhaseSchema,
  JobStateSchema,
  WorkerStateSchema,
  WorkItemStateSchema,
} from "./states.js";

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const NullableDateTimeSchema = Type.Union([DateTimeSchema, Type.Null()]);
const NullableEntityIdSchema = Type.Union([EntityIdSchema, Type.Null()]);
const NullableActorSchema = Type.Union([GitHubActorSchema, Type.Null()]);

const DashboardSourceLineSchema = Type.Integer({ minimum: 1, maximum: 10_000_000 });
const DashboardRequestedRecipeIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9][a-z0-9._-]*$",
});
const DashboardIssueLabelSchema = Type.String({ minLength: 1, maxLength: 100 });
const DashboardMissingInformationSchema = Type.String({ minLength: 1, maxLength: 2_048 });

export const DashboardAuthorizationValues = ["self", "allowlisted", "denied"] as const;
export const DashboardAuthorizationSchema = Type.Union(
  DashboardAuthorizationValues.map((value) => Type.Literal(value)),
);
export type DashboardAuthorization = Static<typeof DashboardAuthorizationSchema>;

export const DashboardWorkItemPriorityValues = ["urgent", "high", "normal", "low"] as const;
export const DashboardWorkItemPrioritySchema = Type.Union(
  DashboardWorkItemPriorityValues.map((value) => Type.Literal(value)),
);
export type DashboardWorkItemPriority = Static<typeof DashboardWorkItemPrioritySchema>;

export const DashboardWorkItemStageValues = [
  "not_scheduled",
  "awaiting_admission",
  "queued",
  "preparing",
  "reviewing",
  "validating",
  "waiting_approval",
  "publishing",
  "done",
] as const;
export const DashboardWorkItemStageSchema = Type.Union(
  DashboardWorkItemStageValues.map((value) => Type.Literal(value)),
);
export type DashboardWorkItemStage = Static<typeof DashboardWorkItemStageSchema>;

export const DashboardJobStageSchema = Type.Union([
  Type.Literal("awaiting_admission"),
  Type.Literal("queued"),
  ExecutionPhaseSchema,
  Type.Literal("done"),
]);
export type DashboardJobStage = Static<typeof DashboardJobStageSchema>;

export const DashboardWorkItemFreshnessSchema = Type.Union([
  Type.Literal("current"),
  Type.Literal("superseded"),
]);
export type DashboardWorkItemFreshness = Static<typeof DashboardWorkItemFreshnessSchema>;

export const DashboardRequestEpochSummarySchema = Type.Object(
  {
    requestEpochId: EntityIdSchema,
    requestKind: SchedulingRequestKindSchema,
    sequence: PositiveIntegerSchema,
    status: Type.Union([Type.Literal("active"), Type.Literal("closed")]),
    authorization: Type.Union([Type.Literal("self"), Type.Literal("allowlisted")]),
    openedAt: DateTimeSchema,
    closedAt: NullableDateTimeSchema,
  },
  { additionalProperties: false },
);
export type DashboardRequestEpochSummary = Static<typeof DashboardRequestEpochSummarySchema>;

export const DashboardWorkItemListItemSchema = Type.Object(
  {
    id: EntityIdSchema,
    kind: GitHubWorkItemKindSchema,
    repositoryId: EntityIdSchema,
    repository: Type.String({ minLength: 3, maxLength: 201 }),
    number: PositiveIntegerSchema,
    title: Type.String({ minLength: 1, maxLength: 1_024 }),
    author: GitHubActorSchema,
    githubUrl: Type.String({ format: "uri", maxLength: 2_048 }),
    trigger: Type.Union([SchedulingRequestKindSchema, Type.Null()]),
    schedulingActor: NullableActorSchema,
    schedulingTarget: NullableActorSchema,
    authorization: Type.Union([DashboardAuthorizationSchema, Type.Null()]),
    authorizationReason: Type.Union([AuthorizationDecisionReasonSchema, Type.Null()]),
    priority: DashboardWorkItemPrioritySchema,
    state: WorkItemStateSchema,
    stage: DashboardWorkItemStageSchema,
    freshness: DashboardWorkItemFreshnessSchema,
    currentRevision: GitHubWorkItemRevisionSchema,
    reviewedRevisionKey: NullableStringSchema,
    activeRequestEpoch: Type.Union([DashboardRequestEpochSummarySchema, Type.Null()]),
    latestJobId: NullableEntityIdSchema,
    latestJobStatus: Type.Union([JobStateSchema, Type.Null()]),
    latestJobAttemptCount: Type.Union([NonNegativeIntegerSchema, Type.Null()]),
    latestJobAdmission: NullableJobAdmissionSchema,
    workerNodeId: NullableEntityIdSchema,
    attentionReason: NullableStringSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type DashboardWorkItemListItem = Static<typeof DashboardWorkItemListItemSchema>;

// Call after schema validation. These fields describe the latest real Job; they do not
// manufacture an execution for an unmaterialized validation request or an unscheduled item.
export function getDashboardWorkItemAdmissionIssues(
  value: Pick<
    DashboardWorkItemListItem,
    "latestJobId" | "latestJobStatus" | "latestJobAttemptCount" | "latestJobAdmission" | "stage"
  >,
): string[] {
  const issues: string[] = [];
  if (value.latestJobId === null) {
    if (
      value.latestJobStatus !== null ||
      value.latestJobAttemptCount !== null ||
      value.latestJobAdmission !== null
    )
      issues.push("admission_without_job_identity");
    if (value.stage !== "not_scheduled") issues.push("unscheduled_stage_mismatch");
    return issues;
  }
  if (value.latestJobStatus === null || value.latestJobAttemptCount === null) {
    issues.push("incomplete_latest_job_identity");
    return issues;
  }
  issues.push(
    ...getJobAdmissionIssues({
      status: value.latestJobStatus,
      attemptCount: value.latestJobAttemptCount,
      admission: value.latestJobAdmission,
    }),
  );
  const waiting = value.latestJobStatus === "queued" || value.latestJobStatus === "retry_waiting";
  if (waiting) {
    const stage = value.latestJobAdmission?.state === "pending" ? "awaiting_admission" : "queued";
    if (value.stage !== stage) issues.push("admission_stage_mismatch");
  } else if (["not_scheduled", "awaiting_admission", "queued"].includes(value.stage)) {
    issues.push("queue_stage_outside_waiting");
  }
  return issues;
}

export const DashboardWorkItemReadSchema = Type.Object(
  {
    ...DashboardWorkItemListItemSchema.properties,
    body: Type.Union([Type.String({ maxLength: 1_048_576 }), Type.Null()]),
    revisions: Type.Array(GitHubWorkItemRevisionSchema, { maxItems: 500 }),
    requestEpochs: Type.Array(AuthorizedRequestEpochSchema, { maxItems: 500 }),
    authorizationDecisions: Type.Array(AuthorizationDecisionSchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);
export type DashboardWorkItemRead = Static<typeof DashboardWorkItemReadSchema>;

const DashboardListQueryProperties = {
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  search: Type.Optional(Type.String({ maxLength: 512 })),
};

export const DashboardWorkItemListQuerySchema = Type.Object(
  {
    ...DashboardListQueryProperties,
    repositoryId: Type.Optional(EntityIdSchema),
    kind: Type.Optional(
      Type.Union([
        GitHubWorkItemKindSchema,
        Type.Array(GitHubWorkItemKindSchema, { maxItems: 16, uniqueItems: true }),
      ]),
    ),
    state: Type.Optional(
      Type.Union([
        WorkItemStateSchema,
        Type.Array(WorkItemStateSchema, { maxItems: 16, uniqueItems: true }),
      ]),
    ),
    stage: Type.Optional(
      Type.Union([
        DashboardWorkItemStageSchema,
        Type.Array(DashboardWorkItemStageSchema, { maxItems: 16, uniqueItems: true }),
      ]),
    ),
    authorization: Type.Optional(
      Type.Union([
        DashboardAuthorizationSchema,
        Type.Array(DashboardAuthorizationSchema, { maxItems: 16, uniqueItems: true }),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type DashboardWorkItemListQuery = Static<typeof DashboardWorkItemListQuerySchema>;

export const DashboardWorkItemListResponseSchema = Type.Object(
  {
    items: Type.Array(DashboardWorkItemListItemSchema),
    total: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DashboardWorkItemListResponse = Static<typeof DashboardWorkItemListResponseSchema>;

export const DashboardJobOutcomeSchema = Type.Union([
  Type.Literal("success"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
]);
export type DashboardJobOutcome = Static<typeof DashboardJobOutcomeSchema>;

export const DashboardJobListItemSchema = Type.Object(
  {
    id: EntityIdSchema,
    repositoryId: EntityIdSchema,
    workItemId: EntityIdSchema,
    workItemRef: Type.String({ minLength: 1, maxLength: 256 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    generation: PositiveIntegerSchema,
    status: JobStateSchema,
    admission: NullableJobAdmissionSchema,
    phase: Type.Union([ExecutionPhaseSchema, Type.Null()]),
    attempt: NonNegativeIntegerSchema,
    maxAttempts: PositiveIntegerSchema,
    workerNodeId: NullableEntityIdSchema,
    leaseGeneration: Type.Union([PositiveIntegerSchema, Type.Null()]),
    leaseExpiresAt: NullableDateTimeSchema,
    progressUpdatedAt: NullableDateTimeSchema,
    elapsedSeconds: NonNegativeIntegerSchema,
    targetRevisionKey: Type.String({ minLength: 1, maxLength: 128 }),
    outcome: Type.Union([DashboardJobOutcomeSchema, Type.Null()]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type DashboardJobListItem = Static<typeof DashboardJobListItemSchema>;

export const DashboardJobReadSchema = Type.Object(
  {
    ...DashboardJobListItemSchema.properties,
    failureCode: NullableStringSchema,
    failureMessage: NullableStringSchema,
    failureDiagnostics: Type.Optional(Type.Union([RunFailureDiagnosticsSchema, Type.Null()])),
    resultDigest: Type.Union([Sha256Schema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardJobRead = Static<typeof DashboardJobReadSchema>;

export const DashboardJobReadQuerySchema = Type.Object(
  {
    jobId: EntityIdSchema,
  },
  { additionalProperties: false },
);
export type DashboardJobReadQuery = Static<typeof DashboardJobReadQuerySchema>;

export const DashboardPrReviewFindingSchema = Type.Object(
  {
    findingId: Type.String({ minLength: 1, maxLength: 128 }),
    ordinal: NonNegativeIntegerSchema,
    priority: Type.Integer({ minimum: 0, maximum: 3 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ minLength: 1, maxLength: 8_192 }),
    path: Type.String({ minLength: 1, maxLength: 1_024 }),
    line: DashboardSourceLineSchema,
    endLine: Type.Union([DashboardSourceLineSchema, Type.Null()]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export type DashboardPrReviewFinding = Static<typeof DashboardPrReviewFindingSchema>;

export const DashboardIssueTriageProjectionSchema = Type.Object(
  {
    category: Type.Union([
      Type.Literal("bug"),
      Type.Literal("feature_request"),
      Type.Literal("documentation"),
      Type.Literal("question"),
      Type.Literal("support"),
      Type.Literal("other"),
    ]),
    priority: Type.Integer({ minimum: 0, maximum: 3 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    suggestedLabels: Type.Array(DashboardIssueLabelSchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
    missingInformation: Type.Array(DashboardMissingInformationSchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
    duplicateCandidates: Type.Array(
      Type.Object(
        {
          number: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
          reason: Type.String({ minLength: 1, maxLength: 2_048 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);
export type DashboardIssueTriageProjection = Static<typeof DashboardIssueTriageProjectionSchema>;

export const DashboardReviewResultReadSchema = Type.Object(
  {
    reviewResultId: EntityIdSchema,
    schemaId: Type.Union([
      Type.Literal("IssueTriageV1"),
      Type.Literal("PrReviewPlanV1"),
      Type.Literal("IssueTriageV2"),
      Type.Literal("PrReviewPlanV2"),
    ]),
    resultDigest: Sha256Schema,
    summary: Type.String({ minLength: 1, maxLength: 8_192 }),
    requestedRecipeIds: Type.Array(DashboardRequestedRecipeIdSchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
    createdAt: DateTimeSchema,
    prReview: Type.Union([
      Type.Object(
        {
          assessment: Type.Union([
            Type.Literal("approve"),
            Type.Literal("comment"),
            Type.Literal("request_changes"),
          ]),
          findings: Type.Array(DashboardPrReviewFindingSchema, { maxItems: 100 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    issueTriage: Type.Union([DashboardIssueTriageProjectionSchema, Type.Null()]),
    verification: Type.Optional(VerificationReportSchema),
    executionEvidence: Type.Optional(ReviewExecutionEvidenceSchema),
  },
  { additionalProperties: false },
);
export type DashboardReviewResultRead = Static<typeof DashboardReviewResultReadSchema>;

export const DashboardJobDetailReadSchema = Type.Object(
  {
    ...DashboardJobReadSchema.properties,
    reviewResult: Type.Union([DashboardReviewResultReadSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardJobDetailRead = Static<typeof DashboardJobDetailReadSchema>;

export const DashboardJobListQuerySchema = Type.Object(
  {
    ...DashboardListQueryProperties,
    repositoryId: Type.Optional(EntityIdSchema),
    status: Type.Optional(
      Type.Union([JobStateSchema, Type.Array(JobStateSchema, { maxItems: 32, uniqueItems: true })]),
    ),
    // Admission filters select only queued/retry_waiting Jobs, never their historical episodes.
    admission: Type.Optional(
      Type.Union([
        JobAdmissionStateSchema,
        Type.Array(JobAdmissionStateSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
      ]),
    ),
    phase: Type.Optional(
      Type.Union([
        ExecutionPhaseSchema,
        Type.Array(ExecutionPhaseSchema, { maxItems: 32, uniqueItems: true }),
      ]),
    ),
    stage: Type.Optional(
      Type.Union([
        DashboardJobStageSchema,
        Type.Array(DashboardJobStageSchema, { maxItems: 32, uniqueItems: true }),
      ]),
    ),
    workItemId: Type.Optional(EntityIdSchema),
  },
  { additionalProperties: false },
);
export type DashboardJobListQuery = Static<typeof DashboardJobListQuerySchema>;

export const DashboardJobListResponseSchema = Type.Object(
  {
    items: Type.Array(DashboardJobListItemSchema),
    total: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DashboardJobListResponse = Static<typeof DashboardJobListResponseSchema>;

export const DashboardWorkerListItemSchema = Type.Object(
  {
    id: EntityIdSchema,
    workerNodeId: EntityIdSchema,
    instanceId: EntityIdSchema,
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    status: WorkerStateSchema,
    version: Type.String({ minLength: 1, maxLength: 128 }),
    location: NullableStringSchema,
    activeSlots: NonNegativeIntegerSchema,
    maxSlots: PositiveIntegerSchema,
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 512,
      uniqueItems: true,
    }),
    currentJobIds: Type.Array(EntityIdSchema, { maxItems: 64, uniqueItems: true }),
    lastHeartbeatAt: DateTimeSchema,
    diskFreeBytes: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DashboardWorkerListItem = Static<typeof DashboardWorkerListItemSchema>;

export const DashboardWorkerReadSchema = Type.Object(
  {
    ...DashboardWorkerListItemSchema.properties,
    registeredAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type DashboardWorkerRead = Static<typeof DashboardWorkerReadSchema>;

export const DashboardWorkerListQuerySchema = Type.Object(
  {
    ...DashboardListQueryProperties,
    sort: Type.Optional(Type.Literal("identity")),
    status: Type.Optional(
      Type.Union([
        WorkerStateSchema,
        Type.Array(WorkerStateSchema, { maxItems: 16, uniqueItems: true }),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type DashboardWorkerListQuery = Static<typeof DashboardWorkerListQuerySchema>;

export const DashboardWorkerListResponseSchema = Type.Object(
  {
    items: Type.Array(DashboardWorkerListItemSchema),
    total: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DashboardWorkerListResponse = Static<typeof DashboardWorkerListResponseSchema>;

export const DashboardHealthComponentSchema = Type.Object(
  {
    id: EntityIdSchema,
    name: Type.String({ minLength: 1, maxLength: 128 }),
    status: Type.Union([
      Type.Literal("healthy"),
      Type.Literal("degraded"),
      Type.Literal("unavailable"),
    ]),
    summary: Type.String({ minLength: 1, maxLength: 2_048 }),
    checkedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type DashboardHealthComponent = Static<typeof DashboardHealthComponentSchema>;

export const DashboardSystemReadSchema = Type.Object(
  {
    serverVersion: Type.String({ minLength: 1, maxLength: 128 }),
    protocolVersion: Type.String({ minLength: 1, maxLength: 128 }),
    nodeVersion: Type.String({ minLength: 1, maxLength: 128 }),
    sqliteVersion: Type.String({ minLength: 1, maxLength: 128 }),
    databaseSizeBytes: NonNegativeIntegerSchema,
    oldestQueuedAt: NullableDateTimeSchema,
    queuedJobs: NonNegativeIntegerSchema,
    awaitingAdmissionJobs: NonNegativeIntegerSchema,
    pendingValidationRequests: NonNegativeIntegerSchema,
    oldestAwaitingAdmissionAt: NullableDateTimeSchema,
    activeWorkers: NonNegativeIntegerSchema,
    activeLeases: NonNegativeIntegerSchema,
    pendingApprovals: NonNegativeIntegerSchema,
    health: Type.Array(DashboardHealthComponentSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);
export type DashboardSystemRead = Static<typeof DashboardSystemReadSchema>;
