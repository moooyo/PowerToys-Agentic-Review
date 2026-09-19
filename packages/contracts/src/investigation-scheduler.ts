import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { DateTimeSchema, EntityIdSchema, NonNegativeIntegerSchema } from "./common.js";
import { InvestigationWorkerLeaseSchema } from "./investigation.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const InvestigationSchedulerSettingsRequestSchema = object({
  staticConcurrency: Type.Integer({ minimum: 1, maximum: 16 }),
});
export type InvestigationSchedulerSettingsRequest = Static<
  typeof InvestigationSchedulerSettingsRequestSchema
>;

export const InvestigationResourceLeaseSchema = object({
  attemptId: EntityIdSchema,
  taskId: EntityIdSchema,
  workerId: EntityIdSchema,
  fence: NonNegativeIntegerSchema,
  pool: Type.Union([Type.Literal("static"), Type.Literal("e2e")]),
  state: Type.Union([
    Type.Literal("held"),
    Type.Literal("needs_cleanup"),
    Type.Literal("released"),
  ]),
  acquiredAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
  releasedAt: Type.Union([DateTimeSchema, Type.Null()]),
  reason: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
});
export type InvestigationResourceLease = Static<typeof InvestigationResourceLeaseSchema>;

export const InvestigationSchedulerStatusSchema = object({
  staticConcurrency: Type.Integer({ minimum: 1, maximum: 16 }),
  e2eConcurrency: Type.Literal(1),
  occupiedStatic: NonNegativeIntegerSchema,
  occupiedE2e: NonNegativeIntegerSchema,
  leases: Type.Array(InvestigationResourceLeaseSchema),
});
export type InvestigationSchedulerStatus = Static<typeof InvestigationSchedulerStatusSchema>;

export const InvestigationCleanupRequestSchema = object({
  lease: InvestigationWorkerLeaseSchema,
  ownedProcessesStopped: Type.Literal(true),
  desktopRestored: Type.Literal(true),
});
export type InvestigationCleanupRequest = Static<typeof InvestigationCleanupRequestSchema>;

export const InvestigationCleanupResponseSchema = object({
  released: Type.Literal(true),
  attemptId: EntityIdSchema,
});
export type InvestigationCleanupResponse = Static<typeof InvestigationCleanupResponseSchema>;
