import { type Static, Type } from "@sinclair/typebox";
import { DateTimeSchema, EntityIdSchema, PositiveIntegerSchema } from "./common.js";

/** Source metadata only; resolving a profile does not verify a publisher account. */
export const InvestigationGitHubUserSchema = Type.Object(
  {
    githubUserId: PositiveIntegerSchema,
    login: Type.String({ minLength: 1, maxLength: 100 }),
    avatarUrl: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
    htmlUrl: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type InvestigationGitHubUser = Static<typeof InvestigationGitHubUserSchema>;

/** Live GitHub metadata is distinct from metadata saved during a previous source import. */
export const InvestigationWorkItemAuthorSchema = Type.Object(
  {
    workItemId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    author: Type.Union([InvestigationGitHubUserSchema, Type.Null()]),
    source: Type.Union([
      Type.Literal("stored"),
      Type.Literal("github"),
      Type.Literal("unavailable"),
    ]),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type InvestigationWorkItemAuthor = Static<typeof InvestigationWorkItemAuthorSchema>;

export const InvestigationIntakeTriggerKindSchema = Type.Union([
  Type.Literal("assignment"),
  Type.Literal("review_request"),
  Type.Literal("review_rerequest"),
  Type.Literal("e2e_command"),
  Type.Literal("e2e_revision"),
]);
export type InvestigationIntakeTriggerKind = Static<typeof InvestigationIntakeTriggerKindSchema>;

/** A signed delivery is an observation at a point in time, not a connectivity guarantee. */
export const InvestigationIntakeDetailsSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    canonicalWebhookUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
    webhookUrlSource: Type.Union([Type.Literal("explicit"), Type.Literal("public_origin")]),
    receiverConfigured: Type.Boolean(),
    lastDelivery: Type.Union([
      Type.Object(
        {
          deliveryId: Type.String({ minLength: 1, maxLength: 256 }),
          receivedAt: DateTimeSchema,
          eventName: Type.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    observedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type InvestigationIntakeDetails = Static<typeof InvestigationIntakeDetailsSchema>;
