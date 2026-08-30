import { type Static, Type } from "@sinclair/typebox";

import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import {
  GitHubActorSchema,
  GitHubWorkItemKindSchema,
  GitHubWorkItemRevisionSchema,
} from "./github.js";
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
    workerNodeId: NullableEntityIdSchema,
    attentionReason: NullableStringSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type DashboardWorkItemListItem = Static<typeof DashboardWorkItemListItemSchema>;

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
    workItemId: EntityIdSchema,
    workItemRef: Type.String({ minLength: 1, maxLength: 256 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    generation: PositiveIntegerSchema,
    status: JobStateSchema,
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
    resultDigest: Type.Union([Sha256Schema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardJobRead = Static<typeof DashboardJobReadSchema>;

export const DashboardJobListQuerySchema = Type.Object(
  {
    ...DashboardListQueryProperties,
    status: Type.Optional(
      Type.Union([JobStateSchema, Type.Array(JobStateSchema, { maxItems: 32, uniqueItems: true })]),
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
    artifactSizeBytes: NonNegativeIntegerSchema,
    oldestQueuedAt: NullableDateTimeSchema,
    activeWorkers: NonNegativeIntegerSchema,
    activeLeases: NonNegativeIntegerSchema,
    pendingApprovals: NonNegativeIntegerSchema,
    health: Type.Array(DashboardHealthComponentSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);
export type DashboardSystemRead = Static<typeof DashboardSystemReadSchema>;
