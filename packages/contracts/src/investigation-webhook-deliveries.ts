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
const nullableText = Type.Union([Type.String({ maxLength: 2_048 }), Type.Null()]);
const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const kind = Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]);
const mode = Type.Union([Type.Literal("static"), Type.Literal("e2e")]);

export const InvestigationWebhookDeliveryStateSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("source_ready"),
  Type.Literal("completed"),
  Type.Literal("ignored"),
  Type.Literal("failed"),
]);
export const InvestigationWebhookAttemptSchema = object({
  id: EntityIdSchema,
  number: PositiveIntegerSchema,
  cycleAttempt: PositiveIntegerSchema,
  startedAt: DateTimeSchema,
  finishedAt: Type.Union([DateTimeSchema, Type.Null()]),
  state: Type.Union([
    Type.Literal("processing"),
    Type.Literal("retrying"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("ignored"),
    Type.Literal("interrupted"),
  ]),
  phase: Type.Union([
    Type.Literal("authorization"),
    Type.Literal("source"),
    Type.Literal("task"),
    Type.Literal("recovery"),
  ]),
  reason: nullableText,
  taskId: nullableId,
});
export type InvestigationWebhookAttempt = Static<typeof InvestigationWebhookAttemptSchema>;

export const InvestigationWebhookDeliverySchema = object({
  deliveryId: Type.String({ minLength: 1, maxLength: 256 }),
  version: Type.String({ minLength: 1, maxLength: 128 }),
  mode,
  eventName: Type.String({ minLength: 1, maxLength: 128 }),
  repositoryId: EntityIdSchema,
  repositoryFullName: GitHubRepositoryNameSchema,
  kind,
  number: PositiveIntegerSchema,
  actorUserId: PositiveIntegerSchema,
  assigneeUserId: PositiveIntegerSchema,
  receivedAt: DateTimeSchema,
  state: InvestigationWebhookDeliveryStateSchema,
  attempts: NonNegativeIntegerSchema,
  totalAttempts: NonNegativeIntegerSchema,
  reason: nullableText,
  taskId: nullableId,
  canonicalDeliveryId: Type.String({ minLength: 1, maxLength: 256 }),
  snapshotRef: Type.Union([
    object({ id: EntityIdSchema, digest: Type.String({ minLength: 1, maxLength: 128 }) }),
    Type.Null(),
  ]),
  nextAttemptAt: Type.Union([DateTimeSchema, Type.Null()]),
  availableActions: Type.Array(Type.Literal("retry"), { maxItems: 1, uniqueItems: true }),
  attemptHistory: Type.Array(InvestigationWebhookAttemptSchema),
});
export type InvestigationWebhookDelivery = Static<typeof InvestigationWebhookDeliverySchema>;

export const InvestigationWebhookDeliveryQuerySchema = object({
  repositoryId: Type.Optional(EntityIdSchema),
  kind: Type.Optional(kind),
  number: Type.Optional(PositiveIntegerSchema),
  state: Type.Optional(InvestigationWebhookDeliveryStateSchema),
  mode: Type.Optional(mode),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
export type InvestigationWebhookDeliveryQuery = Static<
  typeof InvestigationWebhookDeliveryQuerySchema
>;
export const InvestigationWebhookDeliveryListSchema = object({
  items: Type.Array(InvestigationWebhookDeliverySchema, { maxItems: 50 }),
  nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
});
export type InvestigationWebhookDeliveryList = Static<
  typeof InvestigationWebhookDeliveryListSchema
>;

export const InvestigationWebhookRetryRequestSchema = object({
  version: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
});
export type InvestigationWebhookRetryRequest = Static<
  typeof InvestigationWebhookRetryRequestSchema
>;
