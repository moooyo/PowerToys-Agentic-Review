import { type Static, Type } from "@sinclair/typebox";
import { DateTimeSchema, EntityIdSchema, NonNegativeIntegerSchema } from "./common.js";
import { InvestigationWorkerLeaseSchema } from "./investigation.js";

export const maximumInvestigationOutputBatchBytes = 262_144;
export const maximumInvestigationOutputBatchEvents = 64;
const sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const cursor = Type.String({ minLength: 1, maxLength: 2_048 });

/** Only normalized visible output belongs here. Provider envelopes and private reasoning do not. */
export const InvestigationOutputEventInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal("InvestigationOutputEventV1"),
    attemptId: EntityIdSchema,
    invocationId: Type.Union([EntityIdSchema, Type.Null()]),
    producerSequence: sequence,
    itemId: EntityIdSchema,
    kind: Type.Union([
      Type.Literal("assistant"),
      Type.Literal("tool"),
      Type.Literal("system"),
      Type.Literal("gap"),
    ]),
    operation: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
    text: Type.String({ maxLength: 16_384 }),
    observedAt: DateTimeSchema,
    command: Type.Optional(Type.String({ maxLength: 4_096 })),
    result: Type.Optional(Type.String({ maxLength: 16_384 })),
    status: Type.Optional(
      Type.Union([
        Type.Literal("started"),
        Type.Literal("completed"),
        Type.Literal("failed"),
        Type.Literal("cancelled"),
        Type.Literal("info"),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type InvestigationOutputEventInput = Static<typeof InvestigationOutputEventInputSchema>;
export const InvestigationOutputEventSchema = Type.Object(
  {
    ...InvestigationOutputEventInputSchema.properties,
    taskId: EntityIdSchema,
    receivedAt: DateTimeSchema,
    cursor,
  },
  { additionalProperties: false },
);
export type InvestigationOutputEvent = Static<typeof InvestigationOutputEventSchema>;
export const InvestigationOutputBatchRequestSchema = Type.Object(
  {
    lease: InvestigationWorkerLeaseSchema,
    batchId: EntityIdSchema,
    events: Type.Array(InvestigationOutputEventInputSchema, {
      minItems: 1,
      maxItems: maximumInvestigationOutputBatchEvents,
    }),
  },
  { additionalProperties: false },
);
export type InvestigationOutputBatchRequest = Static<typeof InvestigationOutputBatchRequestSchema>;
export const InvestigationOutputBatchResponseSchema = Type.Object(
  {
    taskId: EntityIdSchema,
    attemptId: EntityIdSchema,
    batchId: EntityIdSchema,
    lastAcceptedProducerSequence: sequence,
    cursor,
    duplicate: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type InvestigationOutputBatchResponse = Static<
  typeof InvestigationOutputBatchResponseSchema
>;
export const InvestigationOutputQuerySchema = Type.Object(
  {
    attemptId: EntityIdSchema,
    after: Type.Optional(cursor),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);
export type InvestigationOutputQuery = Static<typeof InvestigationOutputQuerySchema>;
export const InvestigationOutputPageSchema = Type.Object(
  {
    taskId: EntityIdSchema,
    attemptId: EntityIdSchema,
    items: Type.Array(InvestigationOutputEventSchema, { maxItems: 200 }),
    nextCursor: Type.Union([cursor, Type.Null()]),
    highWaterCursor: Type.Union([cursor, Type.Null()]),
    earliestAvailableCursor: Type.Union([cursor, Type.Null()]),
    lastAcceptedProducerSequence: NonNegativeIntegerSchema,
    retainedEventCount: NonNegativeIntegerSchema,
    truncated: Type.Boolean(),
    cursorExpired: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type InvestigationOutputPage = Static<typeof InvestigationOutputPageSchema>;
