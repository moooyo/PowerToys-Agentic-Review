import { type Static, Type } from "@sinclair/typebox";
import { EntityIdSchema } from "./common.js";

const scopeProperties = {
  repositoryId: EntityIdSchema,
  reviewRunId: EntityIdSchema,
  requestId: EntityIdSchema,
  jobId: EntityIdSchema,
};

// Reuse an activation ID only to retry the same operator's request after a lost response.
export const OperatorReviewRunRerunRequestSchema = Type.Object(
  { activationId: EntityIdSchema },
  { additionalProperties: false },
);
export type OperatorReviewRunRerunRequest = Static<typeof OperatorReviewRunRerunRequestSchema>;

export const OperatorReviewRunRerunResponseSchema = Type.Object(
  {
    ...scopeProperties,
    jobActivation: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type OperatorReviewRunRerunResponse = Static<typeof OperatorReviewRunRerunResponseSchema>;

export const OperatorReviewRunCancelRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);
export type OperatorReviewRunCancelRequest = Static<typeof OperatorReviewRunCancelRequestSchema>;

const cancellationState = Type.Union([Type.Literal("cancelled"), Type.Literal("cancel_requested")]);
export const OperatorReviewRunCancelResponseSchema = Type.Union([
  Type.Object(
    { ...scopeProperties, jobState: cancellationState, changed: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...scopeProperties,
      jobState: Type.Union([
        cancellationState,
        Type.Literal("stale"),
        Type.Literal("succeeded"),
        Type.Literal("failed"),
        Type.Literal("dead_letter"),
      ]),
      changed: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
]);
export type OperatorReviewRunCancelResponse = Static<typeof OperatorReviewRunCancelResponseSchema>;
