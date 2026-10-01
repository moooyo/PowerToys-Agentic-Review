import { type Static, Type } from "@sinclair/typebox";
import { EntityIdSchema, Sha256Schema } from "./common.js";
import { InvestigationCommentPublicationSummarySchema } from "./investigation-comments.js";

export const InvestigationPublicationRecoveryBlockerSchema = Type.Union([
  Type.Literal("unsupported_task"),
  Type.Literal("report_unavailable"),
  Type.Literal("newer_task"),
  Type.Literal("newer_publication"),
  Type.Literal("legacy_publication"),
  Type.Literal("publication_conflict"),
  Type.Literal("reconcile_required"),
  Type.Literal("publication_busy"),
  Type.Literal("automatic_replies_disabled"),
  Type.Literal("external_writes_disabled"),
  Type.Literal("publisher_unavailable"),
  Type.Literal("permission_denied"),
  Type.Literal("authorization_unavailable"),
  Type.Literal("repository_identity_changed"),
  Type.Literal("work_item_identity_changed"),
]);
export type InvestigationPublicationRecoveryBlocker = Static<
  typeof InvestigationPublicationRecoveryBlockerSchema
>;

export const InvestigationPublicationRecoveryStatusSchema = Type.Object(
  {
    taskId: EntityIdSchema,
    reportId: Type.Union([EntityIdSchema, Type.Null()]),
    version: Sha256Schema,
    state: Type.Union([Type.Literal("missing"), Type.Literal("existing"), Type.Literal("blocked")]),
    blocker: Type.Union([InvestigationPublicationRecoveryBlockerSchema, Type.Null()]),
    publication: Type.Union([InvestigationCommentPublicationSummarySchema, Type.Null()]),
    availableActions: Type.Array(Type.Literal("enqueue"), { uniqueItems: true, maxItems: 1 }),
  },
  { additionalProperties: false },
);
export type InvestigationPublicationRecoveryStatus = Static<
  typeof InvestigationPublicationRecoveryStatusSchema
>;

export const InvestigationPublicationRecoveryRequestSchema = Type.Object(
  {
    version: Sha256Schema,
    reportId: EntityIdSchema,
    idempotencyKey: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
  },
  { additionalProperties: false },
);
export type InvestigationPublicationRecoveryRequest = Static<
  typeof InvestigationPublicationRecoveryRequestSchema
>;
