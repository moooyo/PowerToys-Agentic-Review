import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import { type OperatorPrincipal, OperatorPrincipalSchema } from "./operator-access.js";
import {
  ManagedRepositoryNameSchema,
  ValidationTargetSchema,
  WorkflowKindSchema,
} from "./platform-configuration.js";
import { PublicationFailureCodeSchema } from "./publication.js";

export const defaultNotificationPageSize = 20;
export const maximumNotificationPageSize = 50;
export const maximumNotificationCandidates = 256;
export const maximumNotificationStateChanges = 50;
export const maximumNotificationRequestUtf8Bytes = 16 * 1024;
export const maximumNotificationResponseUtf8Bytes = 1024 * 1024;
export const maximumNotificationUnreadCount = 99;

const strict = { additionalProperties: false } as const;
const EntityIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
});
const checkCountSchema = Type.Integer({ minimum: 0, maximum: 160 });
const pageSchema = Type.Integer({ minimum: 1, maximum: 10_000_000 });
const pageSizeSchema = Type.Integer({ minimum: 1, maximum: maximumNotificationPageSize });
const incrementableVersionSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER - 1,
});

export const NotificationIdSchema = EntityIdSchema;
export const NotificationCursorSchema = Type.String({
  minLength: 1,
  maxLength: 16,
  pattern: "^[1-9][0-9]*(?![\\s\\S])",
});
export type NotificationCursor = Static<typeof NotificationCursorSchema>;
export const NotificationStateSchema = Type.Union([
  Type.Literal("unread"),
  Type.Literal("read"),
  Type.Literal("archived"),
]);
export type NotificationState = Static<typeof NotificationStateSchema>;
export const NotificationWorkItemKindSchema = Type.Union([
  Type.Literal("pull_request"),
  Type.Literal("issue"),
]);
export type NotificationWorkItemKind = Static<typeof NotificationWorkItemKindSchema>;
export const NotificationStateFilterSchema = Type.Union([
  Type.Literal("all"),
  NotificationStateSchema,
]);
export const NotificationWorkItemKindFilterSchema = Type.Union([
  Type.Literal("all"),
  NotificationWorkItemKindSchema,
]);

export const NotificationReadStateV1Schema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal("NotificationReadStateV1"),
      notificationId: EntityIdSchema,
      version: Type.Literal(0),
      state: Type.Literal("unread"),
      updatedAt: Type.Null(),
    },
    strict,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal("NotificationReadStateV1"),
      notificationId: EntityIdSchema,
      version: PositiveIntegerSchema,
      state: NotificationStateSchema,
      updatedAt: DateTimeSchema,
    },
    strict,
  ),
]);
export type NotificationReadStateV1 = Static<typeof NotificationReadStateV1Schema>;
export const NotificationReadStateSchema = NotificationReadStateV1Schema;
export type NotificationReadState = NotificationReadStateV1;

// These are immutable recorded outcomes. They never describe current approval eligibility.
export const NotificationValidationResultSchema = Type.Object(
  {
    resultId: EntityIdSchema,
    checks: Type.Object(
      {
        total: checkCountSchema,
        passed: checkCountSchema,
        failed: checkCountSchema,
        blocked: checkCountSchema,
        not_run: checkCountSchema,
        skipped: checkCountSchema,
        inconclusive: checkCountSchema,
      },
      strict,
    ),
    requiredNonPassed: checkCountSchema,
    lifecycleBlockers: checkCountSchema,
    evidenceComplete: Type.Boolean(),
    sourceState: Type.Union([
      Type.Literal("original"),
      Type.Literal("modified"),
      Type.Literal("unknown"),
    ]),
    cleanupState: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("not_needed"),
    ]),
  },
  strict,
);
export type NotificationValidationResult = Static<typeof NotificationValidationResultSchema>;
const eventProperties = {
  schemaVersion: Type.Literal("NotificationEventV1"),
  id: EntityIdSchema,
  repositoryId: EntityIdSchema,
  workItemId: EntityIdSchema,
  workItemKind: NotificationWorkItemKindSchema,
  number: PositiveIntegerSchema,
  reviewRunId: EntityIdSchema,
  revisionKey: Sha256Schema,
  sourceId: EntityIdSchema,
  occurredAt: DateTimeSchema,
  recordedAt: DateTimeSchema,
};
const validationProperties = {
  ...eventProperties,
  kind: Type.Literal("validation"),
  jobId: EntityIdSchema,
  requestId: EntityIdSchema,
  jobActivation: PositiveIntegerSchema,
  workflowKind: WorkflowKindSchema,
  target: ValidationTargetSchema,
};
const publicationProperties = {
  ...eventProperties,
  kind: Type.Literal("publication"),
  publicationId: EntityIdSchema,
  attemptKind: Type.Union([Type.Literal("delivery"), Type.Literal("reconciliation")]),
  attemptNumber: PositiveIntegerSchema,
};
export const NotificationEventV1Schema = Type.Union([
  Type.Object(
    {
      ...validationProperties,
      jobStatus: Type.Literal("succeeded"),
      runAttemptId: EntityIdSchema,
      result: NotificationValidationResultSchema,
    },
    strict,
  ),
  Type.Object(
    {
      ...validationProperties,
      jobStatus: Type.Union([
        Type.Literal("failed"),
        Type.Literal("dead_letter"),
        Type.Literal("cancelled"),
        Type.Literal("stale"),
      ]),
      runAttemptId: Type.Union([EntityIdSchema, Type.Null()]),
      result: Type.Null(),
    },
    strict,
  ),
  Type.Object(
    {
      ...publicationProperties,
      outcome: Type.Literal("published"),
      failureCode: Type.Null(),
    },
    strict,
  ),
  Type.Object(
    {
      ...publicationProperties,
      outcome: Type.Union([
        Type.Literal("failed"),
        Type.Literal("blocked"),
        Type.Literal("unknown"),
      ]),
      failureCode: PublicationFailureCodeSchema,
    },
    strict,
  ),
]);
export type NotificationEventV1 = Static<typeof NotificationEventV1Schema>;
export const NotificationEventSchema = NotificationEventV1Schema;
export type NotificationEvent = NotificationEventV1;
export const NotificationItemV1Schema = Type.Object(
  {
    event: NotificationEventV1Schema,
    state: NotificationReadStateV1Schema,
  },
  strict,
);
export type NotificationItemV1 = Static<typeof NotificationItemV1Schema>;
export const NotificationItemSchema = NotificationItemV1Schema;
export type NotificationItem = NotificationItemV1;

export const NotificationListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(NotificationCursorSchema),
    limit: Type.Optional(pageSizeSchema),
    state: Type.Optional(NotificationStateFilterSchema),
    workItemKind: Type.Optional(NotificationWorkItemKindFilterSchema),
  },
  strict,
);
export type NotificationListQuery = Static<typeof NotificationListQuerySchema>;
const observationProperties = {
  actor: OperatorPrincipalSchema,
  observedAt: DateTimeSchema,
  coverageStart: DateTimeSchema,
  retainedAfter: DateTimeSchema,
};
export const NotificationListV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("NotificationListV1"),
    repositoryId: EntityIdSchema,
    ...observationProperties,
    items: Type.Array(NotificationItemV1Schema, { maxItems: maximumNotificationPageSize }),
    nextCursor: Type.Union([NotificationCursorSchema, Type.Null()]),
    scanLimited: Type.Boolean(),
    limit: pageSizeSchema,
    filter: Type.Object(
      {
        state: NotificationStateFilterSchema,
        workItemKind: NotificationWorkItemKindFilterSchema,
      },
      strict,
    ),
  },
  strict,
);
export type NotificationListV1 = Static<typeof NotificationListV1Schema>;
export const NotificationListSchema = NotificationListV1Schema;
export type NotificationList = NotificationListV1;
export const NotificationListResponseSchema = NotificationListV1Schema;
export type NotificationListResponse = NotificationListV1;

export const NotificationCountsSchema = Type.Object(
  {
    total: NonNegativeIntegerSchema,
    unread: NonNegativeIntegerSchema,
    read: NonNegativeIntegerSchema,
    archived: NonNegativeIntegerSchema,
  },
  strict,
);
export type NotificationCounts = Static<typeof NotificationCountsSchema>;
export const NotificationRepositoryOverviewSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    fullName: ManagedRepositoryNameSchema,
    counts: NotificationCountsSchema,
  },
  strict,
);
export type NotificationRepositoryOverview = Static<typeof NotificationRepositoryOverviewSchema>;
export const NotificationOverviewQuerySchema = Type.Object(
  {
    page: Type.Optional(pageSchema),
    pageSize: Type.Optional(pageSizeSchema),
  },
  strict,
);
export type NotificationOverviewQuery = Static<typeof NotificationOverviewQuerySchema>;
export const NotificationOverviewV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("NotificationOverviewV1"),
    ...observationProperties,
    items: Type.Array(NotificationRepositoryOverviewSchema, {
      maxItems: maximumNotificationPageSize,
    }),
    page: pageSchema,
    pageSize: pageSizeSchema,
    total: NonNegativeIntegerSchema,
  },
  strict,
);
export type NotificationOverviewV1 = Static<typeof NotificationOverviewV1Schema>;
export const NotificationOverviewSchema = NotificationOverviewV1Schema;
export type NotificationOverview = NotificationOverviewV1;
export const NotificationOverviewResponseSchema = NotificationOverviewV1Schema;
export type NotificationOverviewResponse = NotificationOverviewV1;
export const NotificationSummaryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("NotificationSummaryV1"),
    ...observationProperties,
    repositoryId: Type.Union([EntityIdSchema, Type.Null()]),
    unreadCount: Type.Integer({ minimum: 0, maximum: maximumNotificationUnreadCount }),
    capped: Type.Boolean(),
  },
  strict,
);
export type NotificationSummaryV1 = Static<typeof NotificationSummaryV1Schema>;
export const NotificationSummarySchema = NotificationSummaryV1Schema;
export type NotificationSummary = NotificationSummaryV1;
export const NotificationSummaryResponseSchema = NotificationSummaryV1Schema;
export type NotificationSummaryResponse = NotificationSummaryV1;

export const NotificationStateChangeRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    changes: Type.Array(
      Type.Object(
        {
          notificationId: EntityIdSchema,
          expectedVersion: incrementableVersionSchema,
          state: NotificationStateSchema,
        },
        strict,
      ),
      { minItems: 1, maxItems: maximumNotificationStateChanges },
    ),
  },
  strict,
);
export type NotificationStateChangeRequest = Static<typeof NotificationStateChangeRequestSchema>;
export const NotificationStateChangeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("NotificationStateChangeV1"),
    repositoryId: EntityIdSchema,
    actor: OperatorPrincipalSchema,
    changeId: EntityIdSchema,
    createdAt: DateTimeSchema,
    changes: Type.Array(
      Type.Object(
        {
          notificationId: EntityIdSchema,
          previousVersion: incrementableVersionSchema,
          state: NotificationReadStateV1Schema,
        },
        strict,
      ),
      { minItems: 1, maxItems: maximumNotificationStateChanges },
    ),
    replayed: Type.Boolean(),
  },
  strict,
);
export type NotificationStateChangeV1 = Static<typeof NotificationStateChangeV1Schema>;
export const NotificationStateChangeSchema = NotificationStateChangeV1Schema;
export type NotificationStateChange = NotificationStateChangeV1;
export const NotificationStateChangeResponseSchema = NotificationStateChangeV1Schema;
export type NotificationStateChangeResponse = NotificationStateChangeV1;

export type NotificationScope = { repositoryId?: string | null; actor?: OperatorPrincipal };
export type NotificationListScope = NotificationScope & { query?: NotificationListQuery };
export type NotificationOverviewScope = Pick<NotificationScope, "actor"> & {
  query?: NotificationOverviewQuery;
};

function unique(issues: string[]): string[] {
  return [...new Set(issues)];
}
function canonicalTime(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}
function encodedLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function responseIssues(value: unknown): string[] {
  return encodedLength(value) > maximumNotificationResponseUtf8Bytes ? ["response_too_large"] : [];
}
function actorIssues(actor: OperatorPrincipal): string[] {
  return [actor.issuer, actor.subject].some(
    (part) =>
      part.trim() !== part ||
      !part.isWellFormed() ||
      [...part].some((character) => {
        const code = character.charCodeAt(0);
        return (
          code < 0x20 ||
          (code >= 0x7f && code <= 0x9f) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
        );
      }),
  )
    ? ["invalid_actor"]
    : [];
}
function scopeIssues(
  value: { repositoryId?: string | null; actor?: OperatorPrincipal },
  scope?: NotificationScope,
): string[] {
  const issues: string[] = [];
  if (scope?.repositoryId !== undefined && value.repositoryId !== scope.repositoryId)
    issues.push("repository_scope_mismatch");
  if (
    scope?.actor !== undefined &&
    (value.actor?.issuer !== scope.actor.issuer || value.actor?.subject !== scope.actor.subject)
  )
    issues.push("actor_scope_mismatch");
  return issues;
}
function observationIssues(value: {
  actor: OperatorPrincipal;
  observedAt: string;
  coverageStart: string;
  retainedAfter: string;
}): string[] {
  const issues = actorIssues(value.actor);
  if (![value.observedAt, value.coverageStart, value.retainedAfter].every(canonicalTime))
    issues.push("invalid_observation_time");
  if (value.coverageStart > value.observedAt || value.retainedAfter > value.observedAt)
    issues.push("invalid_coverage_window");
  if (!value.retainedAfter.endsWith("T00:00:00.000Z")) issues.push("invalid_retention_boundary");
  return issues;
}

// Call semantic helpers after schema validation. Source ownership, current ACLs, per-repository
// cursor provenance, and count provenance must come from the database snapshot, not these DTOs.
export function getNotificationCursorIssues(value: NotificationCursor): string[] {
  return /^[1-9][0-9]*$/.test(value) &&
    value.length <= 16 &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0 &&
    String(Number(value)) === value
    ? []
    : ["invalid_cursor"];
}
export function getNotificationListQueryIssues(value: NotificationListQuery): string[] {
  return value.cursor === undefined ? [] : getNotificationCursorIssues(value.cursor);
}
export function getNotificationEventIssues(
  value: NotificationEvent,
  scope?: Pick<NotificationScope, "repositoryId">,
): string[] {
  const issues: string[] = [];
  if (scope?.repositoryId !== undefined && value.repositoryId !== scope.repositoryId)
    issues.push("repository_scope_mismatch");
  if (!canonicalTime(value.occurredAt) || !canonicalTime(value.recordedAt))
    issues.push("invalid_event_time");
  if (value.kind === "validation") {
    if (value.sourceId !== value.jobId) issues.push("validation_source_mismatch");
    const isPullRequest =
      value.workflowKind === "pr_static_build" || value.workflowKind === "pr_ui";
    if ((isPullRequest ? "pull_request" : "issue") !== value.workItemKind)
      issues.push("workflow_kind_mismatch");
    if (
      ((value.workflowKind === "pr_static_build" || value.workflowKind === "issue_triage") &&
        value.target !== "headless") ||
      (value.workflowKind === "pr_ui" && value.target === "headless")
    )
      issues.push("workflow_target_mismatch");
    if (value.result !== null) {
      const { checks } = value.result;
      const total =
        checks.passed +
        checks.failed +
        checks.blocked +
        checks.not_run +
        checks.skipped +
        checks.inconclusive;
      if (checks.total !== total) issues.push("check_total_mismatch");
      if (value.result.requiredNonPassed > checks.total - checks.passed)
        issues.push("required_non_passed_mismatch");
    }
  }
  return unique(issues);
}
export function getNotificationReadStateIssues(
  value: NotificationReadState,
  notificationId?: string,
): string[] {
  const issues: string[] = [];
  if (notificationId !== undefined && value.notificationId !== notificationId)
    issues.push("read_state_identity_mismatch");
  if (value.version === 0) {
    if (value.state !== "unread" || value.updatedAt !== null)
      issues.push("invalid_default_read_state");
  } else if (value.updatedAt === null || !canonicalTime(value.updatedAt))
    issues.push("invalid_read_state_time");
  return issues;
}
export function getNotificationItemIssues(
  value: NotificationItem,
  scope?: Pick<NotificationScope, "repositoryId">,
): string[] {
  const issues = [
    ...getNotificationEventIssues(value.event, scope),
    ...getNotificationReadStateIssues(value.state, value.event.id),
  ];
  if (value.state.updatedAt !== null && value.state.updatedAt < value.event.recordedAt)
    issues.push("read_state_predates_event");
  return unique(issues);
}
export function getNotificationListIssues(
  value: NotificationList,
  scope?: NotificationListScope,
): string[] {
  const issues = [
    ...responseIssues(value),
    ...observationIssues(value),
    ...scopeIssues(value, scope),
  ];
  const query = scope?.query;
  if (query !== undefined) {
    issues.push(...getNotificationListQueryIssues(query));
    if (
      (query.limit ?? defaultNotificationPageSize) !== value.limit ||
      (query.state ?? "all") !== value.filter.state ||
      (query.workItemKind ?? "all") !== value.filter.workItemKind
    )
      issues.push("list_query_mismatch");
  }
  if (value.items.length > value.limit) issues.push("invalid_list_size");
  if (new Set(value.items.map((item) => item.event.id)).size !== value.items.length)
    issues.push("duplicate_notification");
  if (value.nextCursor !== null) {
    issues.push(...getNotificationCursorIssues(value.nextCursor));
    if (query?.cursor !== undefined && Number(value.nextCursor) >= Number(query.cursor))
      issues.push("cursor_did_not_advance");
  }
  if (value.scanLimited && (value.nextCursor === null || value.items.length >= value.limit))
    issues.push("invalid_scan_limit");
  if (!value.scanLimited && value.nextCursor !== null && value.items.length < value.limit)
    issues.push("invalid_continuation");
  for (const item of value.items) {
    issues.push(...getNotificationItemIssues(item, { repositoryId: value.repositoryId }));
    if (
      item.event.recordedAt < value.coverageStart ||
      item.event.recordedAt < value.retainedAfter ||
      item.event.recordedAt > value.observedAt ||
      (item.state.updatedAt !== null && item.state.updatedAt > value.observedAt)
    )
      issues.push("item_outside_observation_window");
    if (
      (value.filter.state !== "all" && item.state.state !== value.filter.state) ||
      (value.filter.workItemKind !== "all" && item.event.workItemKind !== value.filter.workItemKind)
    )
      issues.push("item_filter_mismatch");
  }
  return unique(issues);
}
export function getNotificationCountsIssues(value: NotificationCounts): string[] {
  const total = value.unread + value.read + value.archived;
  return !Number.isSafeInteger(total) || total !== value.total ? ["count_total_mismatch"] : [];
}
export function getNotificationOverviewIssues(
  value: NotificationOverview,
  scope?: NotificationOverviewScope,
): string[] {
  const issues = [
    ...responseIssues(value),
    ...observationIssues(value),
    ...scopeIssues(value, scope),
  ];
  if (new Set(value.items.map((item) => item.repositoryId)).size !== value.items.length)
    issues.push("duplicate_repository");
  const expectedCount = Math.min(
    value.pageSize,
    Math.max(0, value.total - (value.page - 1) * value.pageSize),
  );
  if (value.items.length !== expectedCount) issues.push("invalid_overview_page_size");
  if (
    scope?.query !== undefined &&
    ((scope.query.page ?? 1) !== value.page ||
      (scope.query.pageSize ?? defaultNotificationPageSize) !== value.pageSize)
  )
    issues.push("overview_query_mismatch");
  for (const item of value.items) {
    issues.push(...getNotificationCountsIssues(item.counts));
    if (item.counts.total === 0) issues.push("empty_repository_overview");
  }
  return unique(issues);
}
export function getNotificationSummaryIssues(
  value: NotificationSummary,
  scope?: NotificationScope,
): string[] {
  const issues = [
    ...responseIssues(value),
    ...observationIssues(value),
    ...scopeIssues(value, scope),
  ];
  if (value.capped && value.unreadCount !== maximumNotificationUnreadCount)
    issues.push("invalid_unread_cap");
  return unique(issues);
}
export function getNotificationStateChangeRequestIssues(
  value: NotificationStateChangeRequest,
): string[] {
  const issues: string[] = [];
  if (encodedLength(value) > maximumNotificationRequestUtf8Bytes) issues.push("request_too_large");
  if (new Set(value.changes.map((change) => change.notificationId)).size !== value.changes.length)
    issues.push("duplicate_state_change");
  return issues;
}
export function getNotificationStateChangeIssues(
  value: NotificationStateChange,
  request?: NotificationStateChangeRequest,
  scope?: NotificationScope,
): string[] {
  const issues = [
    ...responseIssues(value),
    ...actorIssues(value.actor),
    ...scopeIssues(value, scope),
  ];
  if (!canonicalTime(value.createdAt)) issues.push("invalid_state_change_time");
  if (new Set(value.changes.map((change) => change.notificationId)).size !== value.changes.length)
    issues.push("duplicate_state_change");
  if (request !== undefined) {
    issues.push(...getNotificationStateChangeRequestIssues(request));
    if (request.changeId !== value.changeId || request.changes.length !== value.changes.length)
      issues.push("state_change_request_mismatch");
  }
  for (const [index, change] of value.changes.entries()) {
    issues.push(...getNotificationReadStateIssues(change.state, change.notificationId));
    if (change.state.version !== change.previousVersion + 1)
      issues.push("state_change_version_mismatch");
    if (change.state.updatedAt !== value.createdAt) issues.push("state_change_time_mismatch");
    if (request !== undefined) {
      const expected = request.changes[index];
      if (
        expected === undefined ||
        expected.notificationId !== change.notificationId ||
        expected.expectedVersion !== change.previousVersion ||
        expected.state !== change.state.state
      )
        issues.push("state_change_request_mismatch");
    }
  }
  return unique(issues);
}
