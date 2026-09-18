import { type Static, type TProperties, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  GitHubRepositoryNameSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const reason = Type.Union([Type.String({ maxLength: 2_048 }), Type.Null()]);

export const InvestigationCommentDeliveryStateSchema = Type.Union([
  Type.Literal("sending"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);
export type InvestigationCommentDeliveryState = Static<
  typeof InvestigationCommentDeliveryStateSchema
>;
export const InvestigationCommentDeliveryModeSchema = Type.Union([
  Type.Literal("progress"),
  Type.Literal("result"),
]);
export const InvestigationCommentDeliveryEffectSchema = Type.Union([
  Type.Literal("not_sent"),
  Type.Literal("rejected"),
  Type.Literal("applied"),
  Type.Literal("unknown"),
]);
export const InvestigationCommentDeliveryObservationSchema = object({
  at: DateTimeSchema,
  state: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("unknown")]),
  reason,
});
export type InvestigationCommentDeliveryObservation = Static<
  typeof InvestigationCommentDeliveryObservationSchema
>;

export const InvestigationCommentDeliverySchema = object({
  id: EntityIdSchema,
  commentId: EntityIdSchema,
  mode: InvestigationCommentDeliveryModeSchema,
  repositoryId: EntityIdSchema,
  repositoryFullName: GitHubRepositoryNameSchema,
  workItemId: nullableId,
  workItemKind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
  workItemNumber: PositiveIntegerSchema,
  taskId: nullableId,
  reportId: nullableId,
  operation: Type.Union([Type.Literal("create"), Type.Literal("update")]),
  state: InvestigationCommentDeliveryStateSchema,
  body: Type.Union([Type.String({ maxLength: 120_000 }), Type.Null()]),
  externalId: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  startedAt: DateTimeSchema,
  finishedAt: Type.Union([DateTimeSchema, Type.Null()]),
  reason,
  effect: Type.Union([InvestigationCommentDeliveryEffectSchema, Type.Null()]),
  attemptNumber: NonNegativeIntegerSchema,
  settingsVersion: NonNegativeIntegerSchema,
  templateVersion: NonNegativeIntegerSchema,
  legacy: Type.Boolean(),
  observations: Type.Array(InvestigationCommentDeliveryObservationSchema),
});
export type InvestigationCommentDelivery = Static<typeof InvestigationCommentDeliverySchema>;

export const InvestigationCommentDeliveryQuerySchema = object({
  repositoryId: Type.Optional(EntityIdSchema),
  taskId: Type.Optional(EntityIdSchema),
  commentId: Type.Optional(EntityIdSchema),
  workItemNumber: Type.Optional(PositiveIntegerSchema),
  state: Type.Optional(InvestigationCommentDeliveryStateSchema),
  mode: Type.Optional(InvestigationCommentDeliveryModeSchema),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
export type InvestigationCommentDeliveryQuery = Static<
  typeof InvestigationCommentDeliveryQuerySchema
>;
export const InvestigationCommentDeliveryListSchema = object({
  items: Type.Array(InvestigationCommentDeliverySchema, { maxItems: 50 }),
  nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
});
export type InvestigationCommentDeliveryList = Static<
  typeof InvestigationCommentDeliveryListSchema
>;

export const InvestigationCommentPublicationStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("sending"),
  Type.Literal("synced"),
  Type.Literal("retrying"),
  Type.Literal("unconfirmed"),
  Type.Literal("paused"),
  Type.Literal("needs_attention"),
  Type.Literal("conflict"),
]);
export const InvestigationCommentPublicationSummarySchema = object({
  id: EntityIdSchema,
  version: Type.String({ minLength: 1, maxLength: 128 }),
  mode: InvestigationCommentDeliveryModeSchema,
  repositoryId: EntityIdSchema,
  repositoryFullName: GitHubRepositoryNameSchema,
  workItemId: nullableId,
  workItemKind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
  workItemNumber: PositiveIntegerSchema,
  taskId: nullableId,
  reportId: nullableId,
  state: InvestigationCommentPublicationStateSchema,
  reasonCode: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  reason,
  requiresAttention: Type.Boolean(),
  nextAttemptAt: Type.Union([DateTimeSchema, Type.Null()]),
  lastAttemptAt: Type.Union([DateTimeSchema, Type.Null()]),
  lastConfirmedAt: Type.Union([DateTimeSchema, Type.Null()]),
  externalId: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  commentUrl: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
  availableActions: Type.Array(Type.Union([Type.Literal("sync"), Type.Literal("reconcile")]), {
    uniqueItems: true,
    maxItems: 2,
  }),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type InvestigationCommentPublicationSummary = Static<
  typeof InvestigationCommentPublicationSummarySchema
>;
export type CommentPublicationSummary = InvestigationCommentPublicationSummary;
export const InvestigationCommentPublicationListSchema = object({
  items: Type.Array(InvestigationCommentPublicationSummarySchema, { maxItems: 100 }),
});
export type InvestigationCommentPublicationList = Static<
  typeof InvestigationCommentPublicationListSchema
>;
export const InvestigationCommentCommandSchema = object({
  version: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
});
export type InvestigationCommentCommand = Static<typeof InvestigationCommentCommandSchema>;
export type CommentPublicationCommand = InvestigationCommentCommand;
