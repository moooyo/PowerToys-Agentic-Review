import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  GitHubNumericIdSchema,
  GitObjectIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import { OperatorPrincipalSchema } from "./operator-access.js";
import { ManagedRepositoryNameSchema } from "./platform-configuration.js";
import { ReviewRunDecisionEventSchema } from "./review-run-decisions.js";

export const defaultPublicationPageSize = 20;
export const maximumPublicationPageSize = 50;
export const maximumPublicationBodyUtf8Bytes = 60_000;
export const maximumPublicationResponseUtf8Bytes = 1024 * 1024;
export const maximumPublicationRequestUtf8Bytes = 16 * 1024;
export const maximumPublicationBlockerCount = 32;
export const maximumPublicationFailureMessageLength = 2_048;

const strict = { additionalProperties: false } as const;
// New publication identities use an exact end anchor without changing historical common schemas.
const EntityIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
});
const nullableDigest = Type.Union([Sha256Schema, Type.Null()]);
const nullablePublisher = Type.Union([GitHubNumericIdSchema, Type.Null()]);
const pageSchema = Type.Integer({ minimum: 1, maximum: 10_000_000 });
const pageSizeSchema = Type.Integer({ minimum: 1, maximum: maximumPublicationPageSize });
const pagination = { page: Type.Optional(pageSchema), pageSize: Type.Optional(pageSizeSchema) };
const pageProperties = {
  total: NonNegativeIntegerSchema,
  page: pageSchema,
  pageSize: pageSizeSchema,
};

export const PublicationRendererVersionSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
});
export type PublicationRendererVersion = Static<typeof PublicationRendererVersionSchema>;
export const PublicationIdSchema = EntityIdSchema;

// This configuration is independent of ManagedRepository and every historical repository snapshot.
export const RepositoryPublicationPolicyV1Schema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal("RepositoryPublicationPolicyV1"),
      repositoryId: EntityIdSchema,
      version: Type.Literal(0),
      enabled: Type.Literal(false),
      updatedAt: Type.Null(),
      updatedBy: Type.Null(),
    },
    strict,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal("RepositoryPublicationPolicyV1"),
      repositoryId: EntityIdSchema,
      version: PositiveIntegerSchema,
      enabled: Type.Boolean(),
      updatedAt: DateTimeSchema,
      updatedBy: OperatorPrincipalSchema,
    },
    strict,
  ),
]);
export type RepositoryPublicationPolicyV1 = Static<typeof RepositoryPublicationPolicyV1Schema>;
export const RepositoryPublicationPolicySchema = RepositoryPublicationPolicyV1Schema;
export type RepositoryPublicationPolicy = RepositoryPublicationPolicyV1;

export const RepositoryPublicationPolicyUpdateRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    expectedVersion: NonNegativeIntegerSchema,
    enabled: Type.Boolean(),
  },
  strict,
);
export type RepositoryPublicationPolicyUpdateRequest = Static<
  typeof RepositoryPublicationPolicyUpdateRequestSchema
>;

export const RepositoryPublicationPolicyAuditEventV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("RepositoryPublicationPolicyAuditEventV1"),
    id: EntityIdSchema,
    repositoryId: EntityIdSchema,
    changeId: EntityIdSchema,
    actor: OperatorPrincipalSchema,
    previousVersion: NonNegativeIntegerSchema,
    version: PositiveIntegerSchema,
    previousSnapshot: RepositoryPublicationPolicyV1Schema,
    snapshot: RepositoryPublicationPolicyV1Schema,
    createdAt: DateTimeSchema,
  },
  strict,
);
export type RepositoryPublicationPolicyAuditEventV1 = Static<
  typeof RepositoryPublicationPolicyAuditEventV1Schema
>;
export const RepositoryPublicationPolicyAuditEventSchema =
  RepositoryPublicationPolicyAuditEventV1Schema;
export type RepositoryPublicationPolicyAuditEvent = RepositoryPublicationPolicyAuditEventV1;
export const RepositoryPublicationPolicyUpdateResponseSchema = Type.Object(
  {
    change: RepositoryPublicationPolicyAuditEventV1Schema,
    replayed: Type.Boolean(),
  },
  strict,
);
export type RepositoryPublicationPolicyUpdateResponse = Static<
  typeof RepositoryPublicationPolicyUpdateResponseSchema
>;

export const PublicationTargetV1Schema = Type.Object(
  {
    githubRepositoryId: GitHubNumericIdSchema,
    githubWorkItemId: GitHubNumericIdSchema,
    fullName: ManagedRepositoryNameSchema,
    number: PositiveIntegerSchema,
    kind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
  },
  strict,
);
export type PublicationTargetV1 = Static<typeof PublicationTargetV1Schema>;
export const PublicationTargetSchema = PublicationTargetV1Schema;
export type PublicationTarget = PublicationTargetV1;

export const PublicationBodySchema = Type.String({
  minLength: 1,
  maxLength: maximumPublicationBodyUtf8Bytes,
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]*$",
});
export const PublicationReviewEventSchema = Type.Union([
  Type.Literal("APPROVE"),
  Type.Literal("REQUEST_CHANGES"),
  Type.Literal("COMMENT"),
]);
export type PublicationReviewEvent = Static<typeof PublicationReviewEventSchema>;
export const PublicationPayloadV1Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("pull_request_review"),
      commitId: GitObjectIdSchema,
      event: PublicationReviewEventSchema,
      body: PublicationBodySchema,
    },
    strict,
  ),
  Type.Object({ kind: Type.Literal("issue_comment"), body: PublicationBodySchema }, strict),
]);
export type PublicationPayloadV1 = Static<typeof PublicationPayloadV1Schema>;
export const PublicationPayloadSchema = PublicationPayloadV1Schema;
export type PublicationPayload = PublicationPayloadV1;

export const PublicationBindingV1Schema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    reviewRunId: EntityIdSchema,
    workItemId: EntityIdSchema,
    selectedDecisionId: EntityIdSchema,
    // The immutable selected event can be a comment older than the latest context revision.
    selectedDecisionVersion: PositiveIntegerSchema,
    decisionContextVersion: PositiveIntegerSchema,
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    resultSetDigest: Sha256Schema,
  },
  strict,
);
export type PublicationBindingV1 = Static<typeof PublicationBindingV1Schema>;
export const PublicationBindingSchema = PublicationBindingV1Schema;
export type PublicationBinding = PublicationBindingV1;

export const PublicationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("delivering"),
  Type.Literal("published"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("unknown"),
  Type.Literal("cancelled"),
]);
export type PublicationStatus = Static<typeof PublicationStatusSchema>;

export const PublicationBlockerValues = [
  "publication_disabled",
  "publisher_unavailable",
  "confirmation_not_permitted",
  "decision_not_publishable",
  "decision_withdrawn",
  "decision_superseded",
  "decision_stale",
  "source_not_current",
  "result_set_changed",
  "evidence_unavailable",
  "evidence_verification_failed",
  "unsupported_target",
  "payload_oversized",
  "rendering_failed",
  "existing_publication",
] as const;
export const PublicationBlockerSchema = Type.Union(
  PublicationBlockerValues.map((value) => Type.Literal(value)),
);
export type PublicationBlocker = Static<typeof PublicationBlockerSchema>;
export const PublicationExistingIntentV1Schema = Type.Object(
  {
    publicationId: PublicationIdSchema,
    deliveryVersion: PositiveIntegerSchema,
    status: PublicationStatusSchema,
    payloadSha256: Sha256Schema,
  },
  strict,
);
export type PublicationExistingIntentV1 = Static<typeof PublicationExistingIntentV1Schema>;

export const PublicationPreviewV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("PublicationPreviewV1"),
    publicationId: PublicationIdSchema,
    rendererVersion: PublicationRendererVersionSchema,
    binding: PublicationBindingV1Schema,
    target: PublicationTargetV1Schema,
    payload: Type.Union([PublicationPayloadV1Schema, Type.Null()]),
    payloadSha256: nullableDigest,
    // This digest excludes the renderer's stable marker; payloadSha256 covers the exact payload.
    semanticSha256: nullableDigest,
    observedAt: DateTimeSchema,
    policyVersion: NonNegativeIntegerSchema,
    publisherAvailability: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
    publisherGitHubUserId: nullablePublisher,
    blockers: Type.Array(PublicationBlockerSchema, {
      maxItems: maximumPublicationBlockerCount,
      uniqueItems: true,
    }),
    canConfirm: Type.Boolean(),
    existingIntent: Type.Union([PublicationExistingIntentV1Schema, Type.Null()]),
  },
  strict,
);
export type PublicationPreviewV1 = Static<typeof PublicationPreviewV1Schema>;
export const PublicationPreviewSchema = PublicationPreviewV1Schema;
export type PublicationPreview = PublicationPreviewV1;

export const PublicationConfirmRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    publicationId: PublicationIdSchema,
    rendererVersion: PublicationRendererVersionSchema,
    expectedSelectedDecisionId: EntityIdSchema,
    expectedSelectedDecisionVersion: PositiveIntegerSchema,
    expectedDecisionContextVersion: PositiveIntegerSchema,
    expectedPolicyVersion: PositiveIntegerSchema,
    expectedPublisherGitHubUserId: GitHubNumericIdSchema,
    expectedRevisionKey: Sha256Schema,
    expectedPlanDigest: Sha256Schema,
    expectedResultSetDigest: Sha256Schema,
    expectedPayloadSha256: Sha256Schema,
  },
  strict,
);
export type PublicationConfirmRequest = Static<typeof PublicationConfirmRequestSchema>;

export const PublicationIntentV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("PublicationIntentV1"),
    publicationId: PublicationIdSchema,
    rendererVersion: PublicationRendererVersionSchema,
    binding: PublicationBindingV1Schema,
    decision: ReviewRunDecisionEventSchema,
    target: PublicationTargetV1Schema,
    payload: PublicationPayloadV1Schema,
    payloadSha256: Sha256Schema,
    semanticSha256: Sha256Schema,
    publisherGitHubUserId: GitHubNumericIdSchema,
    // Recorded confirmation CAS, not a requirement that future policy versions stay identical.
    policyVersion: PositiveIntegerSchema,
    actor: OperatorPrincipalSchema,
    createdAt: DateTimeSchema,
    confirmationChangeId: EntityIdSchema,
  },
  strict,
);
export type PublicationIntentV1 = Static<typeof PublicationIntentV1Schema>;
export const PublicationIntentSchema = PublicationIntentV1Schema;
export type PublicationIntent = PublicationIntentV1;
export const PublicationConfirmResponseSchema = Type.Object(
  { intent: PublicationIntentV1Schema, replayed: Type.Boolean() },
  strict,
);
export type PublicationConfirmResponse = Static<typeof PublicationConfirmResponseSchema>;

export const PublicationFailureCodeValues = [
  "publisher_unavailable",
  "publisher_identity_mismatch",
  "publication_disabled",
  "authorization_changed",
  "source_changed",
  "decision_changed",
  "result_set_changed",
  "evidence_unavailable",
  "evidence_verification_failed",
  "preflight_failed",
  "target_identity_mismatch",
  "github_rejected",
  "rate_limited",
  "ambiguous_delivery",
  "delivery_interrupted",
  "reconciliation_incomplete",
  "reconciliation_no_match",
  "reconciliation_multiple_matches",
  "reconciliation_mismatch",
  "internal_error",
] as const;
export const PublicationFailureCodeSchema = Type.Union(
  PublicationFailureCodeValues.map((value) => Type.Literal(value)),
);
export type PublicationFailureCode = Static<typeof PublicationFailureCodeSchema>;
export const PublicationFailureSchema = Type.Object(
  {
    code: PublicationFailureCodeSchema,
    message: Type.String({ minLength: 1, maxLength: maximumPublicationFailureMessageLength }),
  },
  strict,
);
export type PublicationFailure = Static<typeof PublicationFailureSchema>;
const nullableFailure = Type.Union([PublicationFailureSchema, Type.Null()]);

const receiptProperties = {
  githubId: GitHubNumericIdSchema,
  htmlUrl: Type.String({
    minLength: 1,
    maxLength: 2_048,
    pattern: "^https://github\\.com/[^\\s?#]+#[A-Za-z0-9-]+$",
  }),
  createdAt: DateTimeSchema,
  publisherGitHubUserId: GitHubNumericIdSchema,
};
export const PublicationRemoteReceiptV1Schema = Type.Union([
  Type.Object(
    {
      ...receiptProperties,
      kind: Type.Literal("pull_request_review"),
      commitId: GitObjectIdSchema,
      event: PublicationReviewEventSchema,
    },
    strict,
  ),
  Type.Object({ ...receiptProperties, kind: Type.Literal("issue_comment") }, strict),
]);
export type PublicationRemoteReceiptV1 = Static<typeof PublicationRemoteReceiptV1Schema>;
export const PublicationRemoteReceiptSchema = PublicationRemoteReceiptV1Schema;
export type PublicationRemoteReceipt = PublicationRemoteReceiptV1;
const nullableReceipt = Type.Union([PublicationRemoteReceiptV1Schema, Type.Null()]);

export const PublicationDeliveryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("PublicationDeliveryV1"),
    publicationId: PublicationIdSchema,
    version: PositiveIntegerSchema,
    status: PublicationStatusSchema,
    attemptCount: NonNegativeIntegerSchema,
    failure: nullableFailure,
    remoteReceipt: nullableReceipt,
    updatedAt: DateTimeSchema,
  },
  strict,
);
export type PublicationDeliveryV1 = Static<typeof PublicationDeliveryV1Schema>;
export const PublicationDeliverySchema = PublicationDeliveryV1Schema;
export type PublicationDelivery = PublicationDeliveryV1;

const attemptProperties = {
  schemaVersion: Type.Literal("PublicationAttemptV1"),
  id: EntityIdSchema,
  publicationId: PublicationIdSchema,
  attemptNumber: PositiveIntegerSchema,
  publisherGitHubUserId: GitHubNumericIdSchema,
  createdAt: DateTimeSchema,
};
export const PublicationAttemptV1Schema = Type.Union([
  Type.Object(
    {
      ...attemptProperties,
      kind: Type.Literal("delivery"),
      phase: Type.Union([Type.Literal("preflight"), Type.Literal("sending")]),
      outcome: Type.Null(),
      failure: Type.Null(),
      remoteReceipt: Type.Null(),
    },
    strict,
  ),
  Type.Object(
    {
      ...attemptProperties,
      kind: Type.Literal("reconciliation"),
      phase: Type.Literal("preflight"),
      outcome: Type.Null(),
      failure: Type.Null(),
      remoteReceipt: Type.Null(),
    },
    strict,
  ),
  Type.Object(
    {
      ...attemptProperties,
      kind: Type.Union([Type.Literal("delivery"), Type.Literal("reconciliation")]),
      phase: Type.Literal("outcome"),
      outcome: Type.Union([
        Type.Literal("published"),
        Type.Literal("failed"),
        Type.Literal("blocked"),
        Type.Literal("unknown"),
      ]),
      failure: nullableFailure,
      remoteReceipt: nullableReceipt,
    },
    strict,
  ),
]);
export type PublicationAttemptV1 = Static<typeof PublicationAttemptV1Schema>;
export const PublicationAttemptSchema = PublicationAttemptV1Schema;
export type PublicationAttempt = PublicationAttemptV1;

export const PublicationDetailV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("PublicationDetailV1"),
    intent: PublicationIntentV1Schema,
    delivery: PublicationDeliveryV1Schema,
  },
  strict,
);
export type PublicationDetailV1 = Static<typeof PublicationDetailV1Schema>;
export const PublicationDetailSchema = PublicationDetailV1Schema;
export type PublicationDetail = PublicationDetailV1;
export const PublicationSummaryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("PublicationSummaryV1"),
    publicationId: PublicationIdSchema,
    repositoryId: EntityIdSchema,
    reviewRunId: EntityIdSchema,
    workItemId: EntityIdSchema,
    selectedDecisionId: EntityIdSchema,
    selectedDecisionVersion: PositiveIntegerSchema,
    rendererVersion: PublicationRendererVersionSchema,
    target: PublicationTargetV1Schema,
    payloadSha256: Sha256Schema,
    publisherGitHubUserId: GitHubNumericIdSchema,
    actor: OperatorPrincipalSchema,
    createdAt: DateTimeSchema,
    delivery: PublicationDeliveryV1Schema,
  },
  strict,
);
export type PublicationSummaryV1 = Static<typeof PublicationSummaryV1Schema>;
export const PublicationSummarySchema = PublicationSummaryV1Schema;
export type PublicationSummary = PublicationSummaryV1;

// Reconciliation is a read-only upstream operation. It never grants permission to resend unknown work.
export const PublicationControlRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    expectedVersion: PositiveIntegerSchema,
    expectedPayloadSha256: Sha256Schema,
  },
  strict,
);
export type PublicationControlRequest = Static<typeof PublicationControlRequestSchema>;
export const PublicationCancelRequestSchema = PublicationControlRequestSchema;
export const PublicationRetryRequestSchema = PublicationControlRequestSchema;
export const PublicationReconcileRequestSchema = PublicationControlRequestSchema;
export type PublicationCancelRequest = PublicationControlRequest;
export type PublicationRetryRequest = PublicationControlRequest;
export type PublicationReconcileRequest = PublicationControlRequest;
export const PublicationControlActionSchema = Type.Union([
  Type.Literal("cancel"),
  Type.Literal("retry"),
  Type.Literal("reconcile"),
]);
export type PublicationControlAction = Static<typeof PublicationControlActionSchema>;
export const PublicationControlReceiptV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("PublicationControlReceiptV1"),
    id: EntityIdSchema,
    changeId: EntityIdSchema,
    publicationId: PublicationIdSchema,
    repositoryId: EntityIdSchema,
    action: PublicationControlActionSchema,
    actor: OperatorPrincipalSchema,
    previousVersion: PositiveIntegerSchema,
    version: PositiveIntegerSchema,
    payloadSha256: Sha256Schema,
    createdAt: DateTimeSchema,
    delivery: PublicationDeliveryV1Schema,
  },
  strict,
);
export type PublicationControlReceiptV1 = Static<typeof PublicationControlReceiptV1Schema>;
export const PublicationControlReceiptSchema = PublicationControlReceiptV1Schema;
export type PublicationControlReceipt = PublicationControlReceiptV1;
export const PublicationControlResponseSchema = Type.Object(
  { change: PublicationControlReceiptV1Schema, replayed: Type.Boolean() },
  strict,
);
export type PublicationControlResponse = Static<typeof PublicationControlResponseSchema>;

export const PublicationPreviewQuerySchema = Type.Object(
  { repositoryId: EntityIdSchema, reviewRunId: EntityIdSchema, decisionId: EntityIdSchema },
  strict,
);
export type PublicationPreviewQuery = Static<typeof PublicationPreviewQuerySchema>;
export const PublicationReadQuerySchema = Type.Object(
  { repositoryId: EntityIdSchema, publicationId: PublicationIdSchema },
  strict,
);
export type PublicationReadQuery = Static<typeof PublicationReadQuerySchema>;
export const PublicationListQuerySchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    reviewRunId: Type.Optional(EntityIdSchema),
    status: Type.Optional(PublicationStatusSchema),
    ...pagination,
  },
  strict,
);
export type PublicationListQuery = Static<typeof PublicationListQuerySchema>;
export const PublicationListResponseSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    items: Type.Array(PublicationSummaryV1Schema, { maxItems: maximumPublicationPageSize }),
    ...pageProperties,
  },
  strict,
);
export type PublicationListResponse = Static<typeof PublicationListResponseSchema>;
export const PublicationAttemptListQuerySchema = Type.Object(
  { repositoryId: EntityIdSchema, publicationId: PublicationIdSchema, ...pagination },
  strict,
);
export type PublicationAttemptListQuery = Static<typeof PublicationAttemptListQuerySchema>;
export const PublicationAttemptListResponseSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    publicationId: PublicationIdSchema,
    items: Type.Array(PublicationAttemptV1Schema, { maxItems: maximumPublicationPageSize }),
    ...pageProperties,
  },
  strict,
);
export type PublicationAttemptListResponse = Static<typeof PublicationAttemptListResponseSchema>;
export const RepositoryPublicationPolicyAuditListQuerySchema = Type.Object(
  { repositoryId: EntityIdSchema, ...pagination },
  strict,
);
export type RepositoryPublicationPolicyAuditListQuery = Static<
  typeof RepositoryPublicationPolicyAuditListQuerySchema
>;
export const RepositoryPublicationPolicyAuditReadQuerySchema = Type.Object(
  { repositoryId: EntityIdSchema, eventId: EntityIdSchema },
  strict,
);
export type RepositoryPublicationPolicyAuditReadQuery = Static<
  typeof RepositoryPublicationPolicyAuditReadQuerySchema
>;
export const RepositoryPublicationPolicyAuditListResponseSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    items: Type.Array(RepositoryPublicationPolicyAuditEventV1Schema, {
      maxItems: maximumPublicationPageSize,
    }),
    ...pageProperties,
  },
  strict,
);
export type RepositoryPublicationPolicyAuditListResponse = Static<
  typeof RepositoryPublicationPolicyAuditListResponseSchema
>;

function canonicalTime(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}
function utf8Length(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))
    .byteLength;
}
function unsafeText(value: string, multiline = false): boolean {
  return (
    !value.isWellFormed() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 0x20 && (!multiline || ![9, 10, 13].includes(code))) ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  );
}
function actorIssues(actor: { issuer: string; subject: string }): string[] {
  return [actor.issuer, actor.subject].some((part) => unsafeText(part) || part.trim() !== part)
    ? ["invalid_actor"]
    : [];
}
function responseIssues(value: unknown): string[] {
  return utf8Length(value) > maximumPublicationResponseUtf8Bytes ? ["response_too_large"] : [];
}
function sameActor(
  left: { issuer: string; subject: string },
  right: { issuer: string; subject: string },
): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}
function unique(issues: string[]): string[] {
  return [...new Set(issues)];
}

export function getRepositoryPublicationPolicyIssues(value: RepositoryPublicationPolicy): string[] {
  if (value.version === 0)
    return value.enabled || value.updatedAt !== null || value.updatedBy !== null
      ? ["invalid_absent_policy"]
      : [];
  return unique([
    ...(value.updatedAt === null || !canonicalTime(value.updatedAt) ? ["invalid_policy_time"] : []),
    ...(value.updatedBy === null ? ["missing_policy_actor"] : actorIssues(value.updatedBy)),
  ]);
}
export function getRepositoryPublicationPolicyAuditEventIssues(
  value: RepositoryPublicationPolicyAuditEvent,
): string[] {
  const issues = [
    ...getRepositoryPublicationPolicyIssues(value.previousSnapshot),
    ...getRepositoryPublicationPolicyIssues(value.snapshot),
    ...actorIssues(value.actor),
    ...responseIssues(value),
  ];
  if (!canonicalTime(value.createdAt)) issues.push("invalid_audit_time");
  if (
    value.repositoryId !== value.previousSnapshot.repositoryId ||
    value.repositoryId !== value.snapshot.repositoryId
  )
    issues.push("policy_scope_mismatch");
  if (
    value.version - value.previousVersion !== 1 ||
    value.previousSnapshot.version !== value.previousVersion ||
    value.snapshot.version !== value.version
  )
    issues.push("policy_version_mismatch");
  if (
    value.snapshot.updatedAt !== value.createdAt ||
    value.snapshot.updatedBy === null ||
    !sameActor(value.actor, value.snapshot.updatedBy)
  )
    issues.push("policy_attribution_mismatch");
  return unique(issues);
}
export function getPublicationBindingIssues(value: PublicationBinding): string[] {
  return value.selectedDecisionVersion > value.decisionContextVersion
    ? ["decision_version_mismatch"]
    : [];
}
export function getPublicationPayloadIssues(
  value: PublicationPayload,
  target?: PublicationTarget,
): string[] {
  const issues: string[] = [];
  if (unsafeText(value.body, true) || value.body.trim().length === 0)
    issues.push("invalid_publication_body");
  if (utf8Length(value.body) > maximumPublicationBodyUtf8Bytes)
    issues.push("publication_body_too_large");
  if (
    target !== undefined &&
    (target.kind === "pull_request") !== (value.kind === "pull_request_review")
  )
    issues.push("payload_target_mismatch");
  return issues;
}
export function getPublicationPreviewIssues(
  value: PublicationPreview,
  scope?: PublicationPreviewQuery,
): string[] {
  const issues = [...getPublicationBindingIssues(value.binding), ...responseIssues(value)];
  if (!canonicalTime(value.observedAt)) issues.push("invalid_observation_time");
  if (
    scope &&
    (scope.repositoryId !== value.binding.repositoryId ||
      scope.reviewRunId !== value.binding.reviewRunId ||
      scope.decisionId !== value.binding.selectedDecisionId)
  )
    issues.push("preview_scope_mismatch");
  if (
    (value.payload === null) !== (value.payloadSha256 === null) ||
    (value.payload === null) !== (value.semanticSha256 === null)
  )
    issues.push("preview_payload_nullability_mismatch");
  if (value.payload !== null)
    issues.push(...getPublicationPayloadIssues(value.payload, value.target));
  if (
    value.payload === null &&
    !value.blockers.some((code) =>
      [
        "decision_not_publishable",
        "unsupported_target",
        "payload_oversized",
        "rendering_failed",
        "evidence_unavailable",
        "evidence_verification_failed",
      ].includes(code),
    )
  )
    issues.push("missing_payload_blocker");
  if (value.publisherAvailability === "available" && value.publisherGitHubUserId === null)
    issues.push("missing_publisher_identity");
  if (
    (value.publisherAvailability === "unavailable") !==
    value.blockers.includes("publisher_unavailable")
  )
    issues.push("publisher_availability_mismatch");
  if (value.policyVersion === 0 && !value.blockers.includes("publication_disabled"))
    issues.push("absent_policy_enabled");
  if ((value.existingIntent !== null) !== value.blockers.includes("existing_publication"))
    issues.push("existing_publication_mismatch");
  if (
    value.existingIntent !== null &&
    (value.existingIntent.publicationId !== value.publicationId ||
      (value.payloadSha256 !== null && value.existingIntent.payloadSha256 !== value.payloadSha256))
  )
    issues.push("existing_publication_identity_mismatch");
  if (
    value.canConfirm !==
    (value.blockers.length === 0 &&
      value.payload !== null &&
      value.publisherAvailability === "available" &&
      value.publisherGitHubUserId !== null &&
      value.policyVersion > 0 &&
      value.existingIntent === null)
  )
    issues.push("preview_confirmation_mismatch");
  return unique(issues);
}

// A caller must independently recompute deterministic identity and exact payload digests from
// the complete verified evidence. These structural helpers do not claim cryptographic validation.
export function getPublicationIntentIssues(
  value: PublicationIntent,
  scope?: PublicationReadQuery,
): string[] {
  const issues = [
    ...getPublicationBindingIssues(value.binding),
    ...getPublicationPayloadIssues(value.payload, value.target),
    ...actorIssues(value.actor),
    ...actorIssues(value.decision.actor),
    ...responseIssues(value),
  ];
  if (
    scope &&
    (scope.repositoryId !== value.binding.repositoryId ||
      scope.publicationId !== value.publicationId)
  )
    issues.push("intent_scope_mismatch");
  if (!canonicalTime(value.createdAt) || !canonicalTime(value.decision.createdAt))
    issues.push("invalid_intent_time");
  const binding = value.binding;
  const decision = value.decision;
  if (
    decision.id !== binding.selectedDecisionId ||
    decision.version !== binding.selectedDecisionVersion ||
    decision.repositoryId !== binding.repositoryId ||
    decision.reviewRunId !== binding.reviewRunId ||
    decision.workItemId !== binding.workItemId ||
    decision.revisionKey !== binding.revisionKey ||
    decision.planDigest !== binding.planDigest ||
    decision.resultSetDigest !== binding.resultSetDigest ||
    decision.workItemKind !== value.target.kind
  )
    issues.push("decision_binding_mismatch");
  if (decision.version - decision.previousVersion !== 1)
    issues.push("decision_event_version_mismatch");
  if (
    unsafeText(decision.reason, true) ||
    decision.policyAtDecision.reasonCodes.some((code) => unsafeText(code))
  )
    issues.push("invalid_decision_text");
  if (decision.action === "withdraw") issues.push("withdrawal_not_publishable");
  if (
    decision.action === "approve" &&
    (!decision.policyAtDecision.applicable || !decision.policyAtDecision.eligible)
  )
    issues.push("approval_policy_not_satisfied");
  if (value.payload.kind === "pull_request_review") {
    const expected =
      decision.action === "approve"
        ? "APPROVE"
        : decision.action === "request_changes"
          ? "REQUEST_CHANGES"
          : "COMMENT";
    if (value.payload.event !== expected) issues.push("decision_review_event_mismatch");
    if (
      decision.action === "override_approve" &&
      !/\bqualified (?:approval )?exception\b/iu.test(value.payload.body)
    )
      issues.push("missing_qualified_approval_notice");
  } else if (decision.action === "approve" || decision.action === "override_approve")
    issues.push("issue_approval_not_supported");
  return unique(issues);
}

const unknownFailureCodes = new Set<PublicationFailureCode>([
  "ambiguous_delivery",
  "delivery_interrupted",
  "reconciliation_incomplete",
  "reconciliation_no_match",
  "reconciliation_multiple_matches",
  "reconciliation_mismatch",
]);
function outcomeIssues(
  status: PublicationStatus,
  failure: PublicationFailure | null,
  receipt: PublicationRemoteReceipt | null,
): string[] {
  const issues: string[] = [];
  if ((status === "published") !== (receipt !== null)) issues.push("receipt_status_mismatch");
  if (["failed", "blocked", "unknown"].includes(status) !== (failure !== null))
    issues.push("failure_status_mismatch");
  if (failure !== null) {
    if (unsafeText(failure.message, true) || failure.message.trim().length === 0)
      issues.push("invalid_failure_message");
    if ((status === "unknown") !== unknownFailureCodes.has(failure.code))
      issues.push("failure_certainty_mismatch");
  }
  if (receipt !== null && !canonicalTime(receipt.createdAt))
    issues.push("invalid_remote_receipt_time");
  return issues;
}
export function getPublicationRemoteReceiptIssues(
  value: PublicationRemoteReceipt,
  target: PublicationTarget,
  publisherGitHubUserId: number,
  payload?: PublicationPayload,
): string[] {
  const issues: string[] = [];
  if (!canonicalTime(value.createdAt)) issues.push("invalid_remote_receipt_time");
  if (value.publisherGitHubUserId !== publisherGitHubUserId)
    issues.push("remote_publisher_mismatch");
  if ((target.kind === "pull_request") !== (value.kind === "pull_request_review"))
    issues.push("remote_target_kind_mismatch");
  const expected =
    value.kind === "pull_request_review"
      ? `https://github.com/${target.fullName}/pull/${target.number}#pullrequestreview-${value.githubId}`
      : `https://github.com/${target.fullName}/issues/${target.number}#issuecomment-${value.githubId}`;
  if (value.htmlUrl !== expected) issues.push("remote_target_url_mismatch");
  if (
    payload !== undefined &&
    (payload.kind !== value.kind ||
      (payload.kind === "pull_request_review" &&
        value.kind === "pull_request_review" &&
        (payload.commitId !== value.commitId || payload.event !== value.event)))
  )
    issues.push("remote_payload_mismatch");
  return issues;
}
export function getPublicationDeliveryIssues(value: PublicationDelivery): string[] {
  const issues = [
    ...outcomeIssues(value.status, value.failure, value.remoteReceipt),
    ...responseIssues(value),
  ];
  if (!canonicalTime(value.updatedAt)) issues.push("invalid_delivery_time");
  if (
    ["delivering", "published", "failed", "unknown"].includes(value.status) &&
    value.attemptCount === 0
  )
    issues.push("missing_delivery_attempt");
  return unique(issues);
}
export function getPublicationAttemptIssues(
  value: PublicationAttempt,
  publicationId?: string,
  publisherGitHubUserId?: number,
): string[] {
  const issues = responseIssues(value);
  if (!canonicalTime(value.createdAt)) issues.push("invalid_attempt_time");
  if (publicationId !== undefined && value.publicationId !== publicationId)
    issues.push("attempt_scope_mismatch");
  if (publisherGitHubUserId !== undefined && value.publisherGitHubUserId !== publisherGitHubUserId)
    issues.push("attempt_publisher_mismatch");
  if (value.phase === "outcome")
    issues.push(...outcomeIssues(value.outcome, value.failure, value.remoteReceipt));
  if (
    value.kind === "reconciliation" &&
    value.phase === "outcome" &&
    !["published", "unknown"].includes(value.outcome)
  )
    issues.push("reconciliation_outcome_mismatch");
  return unique(issues);
}
export function getPublicationDetailIssues(
  value: PublicationDetail,
  scope?: PublicationReadQuery,
): string[] {
  const issues = [
    ...getPublicationIntentIssues(value.intent, scope),
    ...getPublicationDeliveryIssues(value.delivery),
    ...responseIssues(value),
  ];
  if (value.intent.publicationId !== value.delivery.publicationId)
    issues.push("delivery_scope_mismatch");
  if (value.delivery.remoteReceipt !== null)
    issues.push(
      ...getPublicationRemoteReceiptIssues(
        value.delivery.remoteReceipt,
        value.intent.target,
        value.intent.publisherGitHubUserId,
        value.intent.payload,
      ),
    );
  return unique(issues);
}
export function getPublicationSummaryIssues(
  value: PublicationSummary,
  repositoryId?: string,
): string[] {
  const issues = [
    ...getPublicationDeliveryIssues(value.delivery),
    ...actorIssues(value.actor),
    ...responseIssues(value),
  ];
  if (!canonicalTime(value.createdAt)) issues.push("invalid_publication_time");
  if (
    value.publicationId !== value.delivery.publicationId ||
    (repositoryId !== undefined && value.repositoryId !== repositoryId)
  )
    issues.push("summary_scope_mismatch");
  if (value.delivery.remoteReceipt !== null)
    issues.push(
      ...getPublicationRemoteReceiptIssues(
        value.delivery.remoteReceipt,
        value.target,
        value.publisherGitHubUserId,
      ),
    );
  return unique(issues);
}
export function getPublicationConfirmRequestIssues(
  value: PublicationConfirmRequest,
  preview?: PublicationPreview,
): string[] {
  const issues: string[] = [];
  if (utf8Length(value) > maximumPublicationRequestUtf8Bytes) issues.push("request_too_large");
  if (value.expectedSelectedDecisionVersion > value.expectedDecisionContextVersion)
    issues.push("decision_version_mismatch");
  if (preview !== undefined) {
    if (!preview.canConfirm) issues.push("preview_not_confirmable");
    const binding = preview.binding;
    if (
      value.publicationId !== preview.publicationId ||
      value.rendererVersion !== preview.rendererVersion ||
      value.expectedSelectedDecisionId !== binding.selectedDecisionId ||
      value.expectedSelectedDecisionVersion !== binding.selectedDecisionVersion ||
      value.expectedDecisionContextVersion !== binding.decisionContextVersion ||
      value.expectedPolicyVersion !== preview.policyVersion ||
      value.expectedPublisherGitHubUserId !== preview.publisherGitHubUserId ||
      value.expectedRevisionKey !== binding.revisionKey ||
      value.expectedPlanDigest !== binding.planDigest ||
      value.expectedResultSetDigest !== binding.resultSetDigest ||
      value.expectedPayloadSha256 !== preview.payloadSha256
    )
      issues.push("confirmation_binding_mismatch");
  }
  return unique(issues);
}
export function getPublicationConfirmResponseIssues(
  value: PublicationConfirmResponse,
  request?: PublicationConfirmRequest,
  scope?: PublicationReadQuery,
): string[] {
  const intent = value.intent;
  const issues = [...getPublicationIntentIssues(intent, scope), ...responseIssues(value)];
  if (request !== undefined) {
    const binding = intent.binding;
    if (
      intent.confirmationChangeId !== request.changeId ||
      intent.publicationId !== request.publicationId ||
      intent.rendererVersion !== request.rendererVersion ||
      intent.policyVersion !== request.expectedPolicyVersion ||
      intent.publisherGitHubUserId !== request.expectedPublisherGitHubUserId ||
      intent.payloadSha256 !== request.expectedPayloadSha256 ||
      binding.selectedDecisionId !== request.expectedSelectedDecisionId ||
      binding.selectedDecisionVersion !== request.expectedSelectedDecisionVersion ||
      binding.decisionContextVersion !== request.expectedDecisionContextVersion ||
      binding.revisionKey !== request.expectedRevisionKey ||
      binding.planDigest !== request.expectedPlanDigest ||
      binding.resultSetDigest !== request.expectedResultSetDigest
    )
      issues.push("confirmation_receipt_mismatch");
  }
  return unique(issues);
}
export function getPublicationControlRequestIssues(
  value: PublicationControlRequest,
  detail?: PublicationDetail,
  action?: PublicationControlAction,
): string[] {
  const issues: string[] = [];
  if (utf8Length(value) > maximumPublicationRequestUtf8Bytes) issues.push("request_too_large");
  if (detail !== undefined) {
    if (
      value.expectedVersion !== detail.delivery.version ||
      value.expectedPayloadSha256 !== detail.intent.payloadSha256
    )
      issues.push("control_binding_mismatch");
    const allowed =
      action === "cancel"
        ? ["pending", "failed", "blocked"]
        : action === "retry"
          ? ["failed", "blocked"]
          : action === "reconcile"
            ? ["unknown"]
            : null;
    if (allowed !== null && !allowed.includes(detail.delivery.status))
      issues.push("control_state_not_allowed");
  }
  return issues;
}
export function getPublicationControlReceiptIssues(
  value: PublicationControlReceipt,
  scope?: PublicationReadQuery,
): string[] {
  const issues = [
    ...getPublicationDeliveryIssues(value.delivery),
    ...actorIssues(value.actor),
    ...responseIssues(value),
  ];
  if (!canonicalTime(value.createdAt)) issues.push("invalid_control_time");
  if (
    value.version - value.previousVersion !== 1 ||
    value.delivery.version !== value.version ||
    value.delivery.updatedAt !== value.createdAt
  )
    issues.push("control_version_mismatch");
  if (
    value.publicationId !== value.delivery.publicationId ||
    (scope !== undefined &&
      (scope.publicationId !== value.publicationId || scope.repositoryId !== value.repositoryId))
  )
    issues.push("control_scope_mismatch");
  if (
    (value.action === "cancel" && value.delivery.status !== "cancelled") ||
    (value.action === "retry" && value.delivery.status !== "pending") ||
    (value.action === "reconcile" && !["unknown", "published"].includes(value.delivery.status))
  )
    issues.push("control_outcome_mismatch");
  return unique(issues);
}
export function getPublicationControlResponseIssues(
  value: PublicationControlResponse,
  scope?: PublicationReadQuery,
  request?: PublicationControlRequest,
  action?: PublicationControlAction,
): string[] {
  const change = value.change;
  const issues = [...getPublicationControlReceiptIssues(change, scope), ...responseIssues(value)];
  if (
    request !== undefined &&
    (change.changeId !== request.changeId ||
      change.previousVersion !== request.expectedVersion ||
      change.payloadSha256 !== request.expectedPayloadSha256)
  )
    issues.push("control_receipt_mismatch");
  if (action !== undefined && change.action !== action) issues.push("control_action_mismatch");
  return unique(issues);
}

function pageIssues(
  value: {
    items: readonly { id?: string; publicationId?: string }[];
    total: number;
    page: number;
    pageSize: number;
  },
  identity: (item: { id?: string; publicationId?: string }) => string | undefined,
): string[] {
  const issues = responseIssues(value);
  const expectedCount = Math.min(
    value.pageSize,
    Math.max(0, value.total - (value.page - 1) * value.pageSize),
  );
  if (value.items.length !== expectedCount) issues.push("invalid_page_count");
  if (new Set(value.items.map(identity)).size !== value.items.length)
    issues.push("duplicate_page_entry");
  return issues;
}
export function getPublicationListIssues(
  value: PublicationListResponse,
  query?: PublicationListQuery,
): string[] {
  const issues = pageIssues(value, (item) => item.publicationId);
  for (const item of value.items) {
    issues.push(...getPublicationSummaryIssues(item, value.repositoryId));
    if (query?.reviewRunId !== undefined && item.reviewRunId !== query.reviewRunId)
      issues.push("list_run_mismatch");
    if (query?.status !== undefined && item.delivery.status !== query.status)
      issues.push("list_status_mismatch");
  }
  if (
    query &&
    (query.repositoryId !== value.repositoryId ||
      (query.page ?? 1) !== value.page ||
      (query.pageSize ?? defaultPublicationPageSize) !== value.pageSize)
  )
    issues.push("list_query_mismatch");
  return unique(issues);
}
export function getPublicationAttemptListIssues(
  value: PublicationAttemptListResponse,
  query?: PublicationAttemptListQuery,
  publisherGitHubUserId?: number,
): string[] {
  const issues = pageIssues(value, (item) => item.id);
  for (const item of value.items)
    issues.push(...getPublicationAttemptIssues(item, value.publicationId, publisherGitHubUserId));
  if (
    query &&
    (query.repositoryId !== value.repositoryId ||
      query.publicationId !== value.publicationId ||
      (query.page ?? 1) !== value.page ||
      (query.pageSize ?? defaultPublicationPageSize) !== value.pageSize)
  )
    issues.push("attempt_list_query_mismatch");
  return unique(issues);
}
export function getRepositoryPublicationPolicyAuditListIssues(
  value: RepositoryPublicationPolicyAuditListResponse,
  query?: RepositoryPublicationPolicyAuditListQuery,
): string[] {
  const issues = pageIssues(value, (item) => item.id);
  for (const item of value.items) {
    issues.push(...getRepositoryPublicationPolicyAuditEventIssues(item));
    if (item.repositoryId !== value.repositoryId) issues.push("policy_audit_scope_mismatch");
  }
  if (
    query &&
    (query.repositoryId !== value.repositoryId ||
      (query.page ?? 1) !== value.page ||
      (query.pageSize ?? defaultPublicationPageSize) !== value.pageSize)
  )
    issues.push("policy_audit_query_mismatch");
  return unique(issues);
}
