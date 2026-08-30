import { type Static, Type } from "@sinclair/typebox";

import {
  DateTimeSchema,
  EntityIdSchema,
  GitHubNumericIdSchema,
  PositiveIntegerSchema,
} from "./common.js";
import {
  GitHubActorSchema,
  GitHubRepositorySchema,
  GitHubWorkItemRevisionSchema,
  GitHubWorkItemSchema,
} from "./github.js";

export const SchedulingRequestKindValues = ["assignment", "review_request"] as const;
export const SchedulingRequestKindSchema = Type.Union(
  SchedulingRequestKindValues.map((value) => Type.Literal(value)),
);
export type SchedulingRequestKind = Static<typeof SchedulingRequestKindSchema>;

export const SchedulingEventSourceValues = ["webhook", "poll", "reconciliation"] as const;
export const SchedulingEventSourceSchema = Type.Union(
  SchedulingEventSourceValues.map((value) => Type.Literal(value)),
);
export type SchedulingEventSource = Static<typeof SchedulingEventSourceSchema>;

const NullableActorSchema = Type.Union([GitHubActorSchema, Type.Null()]);

const NormalizedEventBaseProperties = {
  contractVersion: Type.Literal(1),
  eventId: Type.String({ minLength: 1, maxLength: 512 }),
  source: SchedulingEventSourceSchema,
  sourceEventId: Type.String({ minLength: 1, maxLength: 512 }),
  occurredAt: DateTimeSchema,
  observedAt: DateTimeSchema,
  repository: GitHubRepositorySchema,
  workItem: GitHubWorkItemSchema,
  revision: GitHubWorkItemRevisionSchema,
  author: GitHubActorSchema,
};

export const SchedulingRequestOpenedEventSchema = Type.Object(
  {
    ...NormalizedEventBaseProperties,
    action: Type.Literal("request_opened"),
    requestKind: SchedulingRequestKindSchema,
    actor: NullableActorSchema,
    target: NullableActorSchema,
  },
  { additionalProperties: false },
);
export type SchedulingRequestOpenedEvent = Static<typeof SchedulingRequestOpenedEventSchema>;

export const SchedulingRequestCloseReasonValues = [
  "assignment_removed",
  "review_request_removed",
] as const;
export const SchedulingRequestCloseReasonSchema = Type.Union(
  SchedulingRequestCloseReasonValues.map((value) => Type.Literal(value)),
);
export type SchedulingRequestCloseReason = Static<typeof SchedulingRequestCloseReasonSchema>;

export const SchedulingRequestClosedEventSchema = Type.Object(
  {
    ...NormalizedEventBaseProperties,
    action: Type.Literal("request_closed"),
    requestKind: SchedulingRequestKindSchema,
    actor: NullableActorSchema,
    target: NullableActorSchema,
    closeReason: SchedulingRequestCloseReasonSchema,
  },
  { additionalProperties: false },
);
export type SchedulingRequestClosedEvent = Static<typeof SchedulingRequestClosedEventSchema>;

export const SchedulingRevisionObservedEventSchema = Type.Object(
  {
    ...NormalizedEventBaseProperties,
    action: Type.Literal("revision_observed"),
    requestKind: Type.Null(),
    actor: NullableActorSchema,
    target: Type.Null(),
  },
  { additionalProperties: false },
);
export type SchedulingRevisionObservedEvent = Static<typeof SchedulingRevisionObservedEventSchema>;

export const SchedulingWorkItemClosedEventSchema = Type.Object(
  {
    ...NormalizedEventBaseProperties,
    action: Type.Literal("work_item_closed"),
    requestKind: Type.Null(),
    actor: NullableActorSchema,
    target: Type.Null(),
    closeReason: Type.Literal("work_item_closed"),
  },
  { additionalProperties: false },
);
export type SchedulingWorkItemClosedEvent = Static<typeof SchedulingWorkItemClosedEventSchema>;

export const SchedulingWorkItemReopenedEventSchema = Type.Object(
  {
    ...NormalizedEventBaseProperties,
    action: Type.Literal("work_item_reopened"),
    requestKind: Type.Null(),
    actor: NullableActorSchema,
    target: Type.Null(),
  },
  { additionalProperties: false },
);
export type SchedulingWorkItemReopenedEvent = Static<typeof SchedulingWorkItemReopenedEventSchema>;

export const NormalizedSchedulingEventSchema = Type.Union([
  SchedulingRequestOpenedEventSchema,
  SchedulingRequestClosedEventSchema,
  SchedulingRevisionObservedEventSchema,
  SchedulingWorkItemClosedEventSchema,
  SchedulingWorkItemReopenedEventSchema,
]);
export type NormalizedSchedulingEvent = Static<typeof NormalizedSchedulingEventSchema>;

export const SelfOrAllowlistPolicySchema = Type.Object(
  {
    kind: Type.Literal("self_or_allowlist"),
    policyVersion: PositiveIntegerSchema,
    schedulingTargetGithubUserId: GitHubNumericIdSchema,
    allowlistedActorGithubUserIds: Type.Array(GitHubNumericIdSchema, {
      maxItems: 1_024,
      uniqueItems: true,
    }),
    unknownActorPolicy: Type.Literal("deny"),
    newRevisionPolicy: Type.Literal("inherit_authorized_epoch"),
  },
  { additionalProperties: false },
);
export type SelfOrAllowlistPolicy = Static<typeof SelfOrAllowlistPolicySchema>;

export const AuthorizationBasisValues = ["self", "allowlist", "active_epoch"] as const;
export const AuthorizationBasisSchema = Type.Union(
  AuthorizationBasisValues.map((value) => Type.Literal(value)),
);
export type AuthorizationBasis = Static<typeof AuthorizationBasisSchema>;

export const AuthorizationDecisionReasonValues = [
  "authorized_self",
  "authorized_allowlisted",
  "inherited_active_epoch",
  "denied_event_not_request_open",
  "denied_work_item_closed",
  "denied_identity_mismatch",
  "denied_target_unknown",
  "denied_wrong_target",
  "denied_actor_unknown",
  "denied_actor_not_allowed",
  "denied_no_active_epoch",
  "denied_epoch_work_item_mismatch",
  "denied_revision_not_inheritable",
  "denied_revision_unchanged",
] as const;
export const AuthorizationDecisionReasonSchema = Type.Union(
  AuthorizationDecisionReasonValues.map((value) => Type.Literal(value)),
);
export type AuthorizationDecisionReason = Static<typeof AuthorizationDecisionReasonSchema>;

export const AuthorizationDecisionSchema = Type.Object(
  {
    eventId: Type.String({ minLength: 1, maxLength: 512 }),
    outcome: Type.Union([Type.Literal("authorized"), Type.Literal("denied")]),
    basis: Type.Union([AuthorizationBasisSchema, Type.Null()]),
    reason: AuthorizationDecisionReasonSchema,
    policyKind: Type.Literal("self_or_allowlist"),
    policyVersion: PositiveIntegerSchema,
    actorGithubUserId: Type.Union([GitHubNumericIdSchema, Type.Null()]),
    targetGithubUserId: Type.Union([GitHubNumericIdSchema, Type.Null()]),
    inheritedFromEpochId: Type.Union([EntityIdSchema, Type.Null()]),
    evaluatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type AuthorizationDecision = Static<typeof AuthorizationDecisionSchema>;

const AuthorizedRequestEpochBaseProperties = {
  requestEpochId: EntityIdSchema,
  githubRepositoryId: GitHubNumericIdSchema,
  githubWorkItemId: GitHubNumericIdSchema,
  requestKind: SchedulingRequestKindSchema,
  sequence: PositiveIntegerSchema,
  target: GitHubActorSchema,
  openedByActor: GitHubActorSchema,
  authorizationBasis: Type.Union([Type.Literal("self"), Type.Literal("allowlist")]),
  authorizationPolicyVersion: PositiveIntegerSchema,
  openedByEventId: Type.String({ minLength: 1, maxLength: 512 }),
  openedAt: DateTimeSchema,
  currentRevision: GitHubWorkItemRevisionSchema,
};

export const ActiveAuthorizedRequestEpochSchema = Type.Object(
  {
    ...AuthorizedRequestEpochBaseProperties,
    status: Type.Literal("active"),
    closedByEventId: Type.Null(),
    closedAt: Type.Null(),
    closeReason: Type.Null(),
  },
  { additionalProperties: false },
);
export type ActiveAuthorizedRequestEpoch = Static<typeof ActiveAuthorizedRequestEpochSchema>;

export const ClosedAuthorizedRequestEpochSchema = Type.Object(
  {
    ...AuthorizedRequestEpochBaseProperties,
    status: Type.Literal("closed"),
    closedByEventId: Type.String({ minLength: 1, maxLength: 512 }),
    closedAt: DateTimeSchema,
    closeReason: Type.Union([SchedulingRequestCloseReasonSchema, Type.Literal("work_item_closed")]),
  },
  { additionalProperties: false },
);
export type ClosedAuthorizedRequestEpoch = Static<typeof ClosedAuthorizedRequestEpochSchema>;

export const AuthorizedRequestEpochSchema = Type.Union([
  ActiveAuthorizedRequestEpochSchema,
  ClosedAuthorizedRequestEpochSchema,
]);
export type AuthorizedRequestEpoch = Static<typeof AuthorizedRequestEpochSchema>;
