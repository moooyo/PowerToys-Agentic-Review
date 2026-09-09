import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  defaultNotificationPageSize,
  getNotificationCountsIssues,
  getNotificationCursorIssues,
  getNotificationEventIssues,
  getNotificationItemIssues,
  getNotificationListIssues,
  getNotificationListQueryIssues,
  getNotificationOverviewIssues,
  getNotificationReadStateIssues,
  getNotificationStateChangeIssues,
  getNotificationStateChangeRequestIssues,
  getNotificationSummaryIssues,
  maximumNotificationCandidates,
  maximumNotificationPageSize,
  maximumNotificationRequestUtf8Bytes,
  maximumNotificationResponseUtf8Bytes,
  maximumNotificationStateChanges,
  maximumNotificationUnreadCount,
  type NotificationEvent,
  NotificationEventSchema,
  type NotificationItem,
  NotificationItemSchema,
  type NotificationList,
  NotificationListQuerySchema,
  NotificationListSchema,
  type NotificationOverview,
  NotificationOverviewQuerySchema,
  NotificationOverviewSchema,
  type NotificationReadState,
  NotificationReadStateSchema,
  type NotificationStateChange,
  type NotificationStateChangeRequest,
  NotificationStateChangeRequestSchema,
  NotificationStateChangeSchema,
  type NotificationSummary,
  NotificationSummarySchema,
} from "./notifications.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
const actor = { issuer: "https://identity.example", subject: "operator-1" };
const occurredAt = "2026-09-07T09:00:00.000Z";
const recordedAt = "2026-09-07T09:00:01.000Z";
const updatedAt = "2026-09-07T09:00:02.000Z";
const observedAt = "2026-09-07T09:00:03.000Z";
const observation = {
  actor,
  observedAt,
  coverageStart: "2026-09-07T08:00:00.000Z",
  retainedAfter: "2026-09-07T00:00:00.000Z",
};
const scope = { repositoryId: "repository-1", actor };
const event: Extract<NotificationEvent, { jobStatus: "succeeded" }> = {
  schemaVersion: "NotificationEventV1",
  id: "notification-1",
  repositoryId: scope.repositoryId,
  workItemId: "work-item-1",
  workItemKind: "pull_request",
  number: 7,
  reviewRunId: "review-run-1",
  revisionKey: "a".repeat(64),
  sourceId: "job-1",
  occurredAt,
  recordedAt,
  kind: "validation",
  jobId: "job-1",
  requestId: "request-1",
  jobActivation: 1,
  runAttemptId: "attempt-1",
  workflowKind: "pr_static_build",
  target: "headless",
  jobStatus: "succeeded",
  result: {
    resultId: "result-1",
    checks: { total: 6, passed: 1, failed: 1, blocked: 1, not_run: 1, skipped: 1, inconclusive: 1 },
    requiredNonPassed: 3,
    lifecycleBlockers: 1,
    evidenceComplete: false,
    sourceState: "modified",
    cleanupState: "failed",
  },
};
const publication: Extract<NotificationEvent, { outcome: "published" }> = {
  schemaVersion: "NotificationEventV1",
  id: "notification-2",
  repositoryId: scope.repositoryId,
  workItemId: "work-item-2",
  workItemKind: "issue",
  number: 7,
  reviewRunId: "review-run-2",
  revisionKey: "b".repeat(64),
  sourceId: "publication-attempt-2",
  occurredAt,
  recordedAt,
  kind: "publication",
  publicationId: "publication-2",
  attemptKind: "reconciliation",
  attemptNumber: 2,
  outcome: "published",
  failureCode: null,
};
const unread: NotificationReadState = {
  schemaVersion: "NotificationReadStateV1",
  notificationId: event.id,
  version: 0,
  state: "unread",
  updatedAt: null,
};
const read: NotificationReadState = { ...unread, version: 1, state: "read", updatedAt };
const item: NotificationItem = { event, state: unread };
const list: NotificationList = {
  schemaVersion: "NotificationListV1",
  repositoryId: scope.repositoryId,
  ...observation,
  items: [item],
  nextCursor: null,
  scanLimited: false,
  limit: defaultNotificationPageSize,
  filter: { state: "all", workItemKind: "all" },
};
const overview: NotificationOverview = {
  schemaVersion: "NotificationOverviewV1",
  ...observation,
  items: [
    {
      repositoryId: scope.repositoryId,
      fullName: "example/project",
      counts: { total: 3, unread: 1, read: 1, archived: 1 },
    },
  ],
  page: 1,
  pageSize: defaultNotificationPageSize,
  total: 1,
};
const summary: NotificationSummary = {
  schemaVersion: "NotificationSummaryV1",
  ...observation,
  repositoryId: scope.repositoryId,
  unreadCount: 1,
  capped: false,
};
const request: NotificationStateChangeRequest = {
  changeId: "change-1",
  changes: [{ notificationId: event.id, expectedVersion: 0, state: "read" }],
};
const receipt: NotificationStateChange = {
  schemaVersion: "NotificationStateChangeV1",
  repositoryId: scope.repositoryId,
  actor,
  changeId: request.changeId,
  createdAt: updatedAt,
  changes: [{ notificationId: event.id, previousVersion: 0, state: read }],
  replayed: false,
};

describe("notification event contracts", () => {
  it("keeps transport limits explicit and bounded", () => {
    expect([
      defaultNotificationPageSize,
      maximumNotificationPageSize,
      maximumNotificationCandidates,
      maximumNotificationStateChanges,
      maximumNotificationUnreadCount,
    ]).toEqual([20, 50, 256, 50, 99]);
    expect(maximumNotificationRequestUtf8Bytes).toBe(16 * 1024);
    expect(maximumNotificationResponseUtf8Bytes).toBe(1024 * 1024);
  });

  it("represents completed execution with failing checks without claiming approval", () => {
    expect(Value.Check(NotificationEventSchema, event)).toBe(true);
    expect(getNotificationEventIssues(event, scope)).toEqual([]);
    expect(Value.Check(NotificationEventSchema, { ...event, recommendation: "approve" })).toBe(
      false,
    );
    expect(Value.Check(NotificationEventSchema, { ...event, canApprove: true })).toBe(false);
    expect(
      Value.Check(NotificationEventSchema, {
        ...event,
        result: { ...event.result, title: "Private source title" },
      }),
    ).toBe(false);
  });

  it.each(["failed", "dead_letter", "cancelled", "stale"] as const)(
    "represents %s without inventing a result or attempt",
    (jobStatus) => {
      const terminal: NotificationEvent = { ...event, jobStatus, result: null, runAttemptId: null };
      expect(Value.Check(NotificationEventSchema, terminal)).toBe(true);
      expect(getNotificationEventIssues(terminal)).toEqual([]);
      expect(Value.Check(NotificationEventSchema, { ...terminal, result: event.result })).toBe(
        false,
      );
    },
  );

  it("requires a result and attempt for a succeeded job", () => {
    expect(Value.Check(NotificationEventSchema, { ...event, result: null })).toBe(false);
    expect(Value.Check(NotificationEventSchema, { ...event, runAttemptId: null })).toBe(false);
    const { resultId: _resultId, ...missingIdentity } = event.result;
    expect(Value.Check(NotificationEventSchema, { ...event, result: missingIdentity })).toBe(false);
  });

  it.each([
    ["pr_static_build", "headless", "pull_request"],
    ["pr_ui", "web", "pull_request"],
    ["pr_ui", "windows_desktop", "pull_request"],
    ["issue_triage", "headless", "issue"],
    ["issue_validation", "headless", "issue"],
    ["issue_validation", "web", "issue"],
    ["issue_validation", "windows_desktop", "issue"],
  ] as const)("accepts %s on %s for %s", (workflowKind, target, workItemKind) => {
    expect(getNotificationEventIssues({ ...event, workflowKind, target, workItemKind })).toEqual(
      [],
    );
  });

  it.each([
    ["pr_static_build", "web", "pull_request", "workflow_target_mismatch"],
    ["pr_ui", "headless", "pull_request", "workflow_target_mismatch"],
    ["issue_triage", "windows_desktop", "issue", "workflow_target_mismatch"],
    ["issue_validation", "web", "pull_request", "workflow_kind_mismatch"],
    ["pr_ui", "web", "issue", "workflow_kind_mismatch"],
  ] as const)(
    "rejects incompatible workflow %s on %s for %s",
    (workflowKind, target, workItemKind, issue) => {
      expect(
        getNotificationEventIssues({ ...event, workflowKind, target, workItemKind }),
      ).toContain(issue);
    },
  );

  it("checks source and repository bindings", () => {
    expect(getNotificationEventIssues({ ...event, sourceId: "other-job" })).toContain(
      "validation_source_mismatch",
    );
    expect(getNotificationEventIssues(event, { repositoryId: "other-repository" })).toContain(
      "repository_scope_mismatch",
    );
  });

  it("validates aggregate check counts without conflating lifecycle blockers", () => {
    expect(
      getNotificationEventIssues({
        ...event,
        result: { ...event.result, checks: { ...event.result.checks, total: 5 } },
      }),
    ).toContain("check_total_mismatch");
    expect(
      getNotificationEventIssues({ ...event, result: { ...event.result, requiredNonPassed: 6 } }),
    ).toContain("required_non_passed_mismatch");
    expect(
      getNotificationEventIssues({ ...event, result: { ...event.result, lifecycleBlockers: 160 } }),
    ).toEqual([]);
    expect(
      Value.Check(NotificationEventSchema, {
        ...event,
        result: { ...event.result, lifecycleBlockers: 161 },
      }),
    ).toBe(false);
    expect(
      Value.Check(NotificationEventSchema, {
        ...event,
        result: { ...event.result, evidenceComplete: 1 },
      }),
    ).toBe(false);
  });

  it("requires canonical source and recording times but does not reinterpret their provenance", () => {
    expect(getNotificationEventIssues({ ...event, occurredAt: "2026-09-07T09:00:00Z" })).toContain(
      "invalid_event_time",
    );
    expect(getNotificationEventIssues({ ...event, recordedAt: "invalid" })).toContain(
      "invalid_event_time",
    );
    expect(getNotificationEventIssues({ ...event, occurredAt: observedAt })).toEqual([]);
  });

  it.each([
    "id",
    "repositoryId",
    "workItemId",
    "reviewRunId",
    "sourceId",
    "jobId",
    "requestId",
    "runAttemptId",
  ])("rejects trailing newline and overlong %s", (key) => {
    expect(Value.Check(NotificationEventSchema, { ...event, [key]: "identity\n" })).toBe(false);
    expect(Value.Check(NotificationEventSchema, { ...event, [key]: "i".repeat(129) })).toBe(false);
  });

  it("requires safe integer source identifiers and lowercase revision digests", () => {
    expect(
      Value.Check(NotificationEventSchema, { ...event, number: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBe(false);
    expect(Value.Check(NotificationEventSchema, { ...event, jobActivation: 0 })).toBe(false);
    expect(Value.Check(NotificationEventSchema, { ...event, revisionKey: "A".repeat(64) })).toBe(
      false,
    );
  });

  it("represents a published reconciliation without exposing bodies or remote links", () => {
    expect(Value.Check(NotificationEventSchema, publication)).toBe(true);
    expect(getNotificationEventIssues(publication)).toEqual([]);
    for (const property of ["body", "message", "remoteUrl", "error", "token"]) {
      expect(
        Value.Check(NotificationEventSchema, { ...publication, [property]: "sensitive" }),
      ).toBe(false);
    }
    expect(
      Value.Check(NotificationEventSchema, { ...publication, failureCode: "internal_error" }),
    ).toBe(false);
  });

  it.each(["failed", "blocked", "unknown"] as const)(
    "requires a bounded failure code for %s",
    (outcome) => {
      expect(
        Value.Check(NotificationEventSchema, {
          ...publication,
          outcome,
          failureCode: "ambiguous_delivery",
        }),
      ).toBe(true);
      expect(
        Value.Check(NotificationEventSchema, { ...publication, outcome, failureCode: null }),
      ).toBe(false);
      expect(
        Value.Check(NotificationEventSchema, {
          ...publication,
          outcome,
          failureCode: "unexpected raw error",
        }),
      ).toBe(false);
    },
  );
});

describe("personal notification state", () => {
  it("distinguishes absent unread state from an explicitly saved unread state", () => {
    const explicit = { ...read, state: "unread" };
    expect(Value.Check(NotificationReadStateSchema, unread)).toBe(true);
    expect(Value.Check(NotificationReadStateSchema, explicit)).toBe(true);
    expect(getNotificationReadStateIssues(unread, event.id)).toEqual([]);
    expect(getNotificationReadStateIssues(explicit, event.id)).toEqual([]);
    expect(Value.Check(NotificationReadStateSchema, { ...unread, state: "read" })).toBe(false);
    expect(Value.Check(NotificationReadStateSchema, { ...unread, updatedAt })).toBe(false);
    expect(Value.Check(NotificationReadStateSchema, { ...read, updatedAt: null })).toBe(false);
  });

  it("requires item identities to agree and state time to follow recording", () => {
    expect(Value.Check(NotificationItemSchema, item)).toBe(true);
    expect(getNotificationItemIssues(item, scope)).toEqual([]);
    expect(
      getNotificationItemIssues({ ...item, state: { ...read, notificationId: "other" } }),
    ).toContain("read_state_identity_mismatch");
    expect(
      getNotificationItemIssues({ ...item, state: { ...read, updatedAt: occurredAt } }),
    ).toContain("read_state_predates_event");
    expect(
      getNotificationReadStateIssues({ ...read, updatedAt: "2026-09-07T09:00:02Z" }),
    ).toContain("invalid_read_state_time");
  });

  it("rejects duplicate batch identifiers even when versions or target states differ", () => {
    expect(
      getNotificationStateChangeRequestIssues({
        ...request,
        changes: [
          ...request.changes,
          { notificationId: event.id, expectedVersion: 1, state: "archived" },
        ],
      }),
    ).toContain("duplicate_state_change");
  });

  it("bounds batches, versions, identifiers, and property surfaces", () => {
    expect(Value.Check(NotificationStateChangeRequestSchema, request)).toBe(true);
    expect(Value.Check(NotificationStateChangeRequestSchema, { ...request, changes: [] })).toBe(
      false,
    );
    const changes = Array.from({ length: 50 }, (_, index) => ({
      notificationId: `n-${index}`,
      expectedVersion: 0,
      state: "read",
    }));
    expect(Value.Check(NotificationStateChangeRequestSchema, { ...request, changes })).toBe(true);
    expect(
      Value.Check(NotificationStateChangeRequestSchema, {
        ...request,
        changes: [...changes, { notificationId: "n-50", expectedVersion: 0, state: "read" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(NotificationStateChangeRequestSchema, {
        ...request,
        changes: [{ ...request.changes[0], expectedVersion: Number.MAX_SAFE_INTEGER }],
      }),
    ).toBe(false);
    expect(Value.Check(NotificationStateChangeRequestSchema, { ...request, actor })).toBe(false);
    expect(
      Value.Check(NotificationStateChangeRequestSchema, { ...request, changeId: "change\n" }),
    ).toBe(false);
  });

  it("requires exact receipts for first responses and historical replays", () => {
    expect(Value.Check(NotificationStateChangeSchema, receipt)).toBe(true);
    expect(getNotificationStateChangeIssues(receipt, request, scope)).toEqual([]);
    expect(
      getNotificationStateChangeIssues({ ...receipt, replayed: true }, request, scope),
    ).toEqual([]);
    expect(
      getNotificationStateChangeIssues(receipt, { ...request, changeId: "other" }, scope),
    ).toContain("state_change_request_mismatch");
    expect(
      getNotificationStateChangeIssues(receipt, request, {
        ...scope,
        actor: { ...actor, subject: "operator-2" },
      }),
    ).toContain("actor_scope_mismatch");
    expect(
      getNotificationStateChangeIssues(receipt, request, { ...scope, repositoryId: "other" }),
    ).toContain("repository_scope_mismatch");
  });

  it("checks receipt version, state, time, identity, ordering, and uniqueness", () => {
    const secondRequest = {
      notificationId: "notification-2",
      expectedVersion: 2,
      state: "archived",
    } as const;
    const secondChange = {
      notificationId: "notification-2",
      previousVersion: 2,
      state: { ...read, notificationId: "notification-2", version: 3, state: "archived" as const },
    };
    const multipleRequest = { ...request, changes: [...request.changes, secondRequest] };
    const multipleReceipt = { ...receipt, changes: [...receipt.changes, secondChange] };
    expect(getNotificationStateChangeIssues(multipleReceipt, multipleRequest)).toEqual([]);
    expect(
      getNotificationStateChangeIssues(
        { ...multipleReceipt, changes: [...multipleReceipt.changes].reverse() },
        multipleRequest,
      ),
    ).toContain("state_change_request_mismatch");
    expect(
      getNotificationStateChangeIssues({
        ...receipt,
        changes: [...receipt.changes, ...receipt.changes],
      }),
    ).toContain("duplicate_state_change");
    expect(
      getNotificationStateChangeIssues(
        { ...receipt, changes: [{ notificationId: event.id, previousVersion: 1, state: read }] },
        request,
      ),
    ).toContain("state_change_version_mismatch");
    expect(
      getNotificationStateChangeIssues(
        {
          ...receipt,
          changes: [
            { notificationId: event.id, previousVersion: 0, state: { ...read, state: "archived" } },
          ],
        },
        request,
      ),
    ).toContain("state_change_request_mismatch");
    expect(getNotificationStateChangeIssues({ ...receipt, createdAt: observedAt })).toContain(
      "state_change_time_mismatch",
    );
  });
});

describe("bounded notification reads", () => {
  it.each(["1", "256", String(Number.MAX_SAFE_INTEGER)])(
    "accepts canonical positive cursor %s",
    (cursor) => {
      expect(Value.Check(NotificationListQuerySchema, { cursor })).toBe(true);
      expect(getNotificationListQueryIssues({ cursor })).toEqual([]);
    },
  );

  it.each([
    "0",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e3",
    " 1",
    "1\n",
    "9007199254740992",
    "99999999999999999",
  ])("rejects invalid cursor %s", (cursor) => {
    expect(getNotificationCursorIssues(cursor)).toContain("invalid_cursor");
  });

  it("does not accept offset, total, actor, or arbitrary repository query parameters", () => {
    expect(Value.Check(NotificationListQuerySchema, {})).toBe(true);
    for (const query of [
      { offset: 100_000 },
      { total: true },
      { repositoryId: "other" },
      { actor },
      { page: 50 },
      { limit: 51 },
    ]) {
      expect(Value.Check(NotificationListQuerySchema, query)).toBe(false);
    }
    expect(Value.Check(NotificationOverviewQuerySchema, { page: 10_000_000, pageSize: 50 })).toBe(
      true,
    );
    expect(Value.Check(NotificationOverviewQuerySchema, { page: 10_000_001 })).toBe(false);
  });

  it("accepts deployment coverage later than the inclusive retention day boundary", () => {
    expect(Value.Check(NotificationListSchema, list)).toBe(true);
    expect(getNotificationListIssues(list, { ...scope, query: {} })).toEqual([]);
    expect(
      getNotificationListIssues({
        ...list,
        coverageStart: list.retainedAfter,
        items: [{ ...item, event: { ...event, recordedAt: list.retainedAfter } }],
      }),
    ).toEqual([]);
  });

  it("binds list scope, actor, normalized filters, and requested size", () => {
    expect(getNotificationListIssues(list, { ...scope, query: { state: "unread" } })).toContain(
      "list_query_mismatch",
    );
    expect(getNotificationListIssues(list, { ...scope, query: { limit: 1 } })).toContain(
      "list_query_mismatch",
    );
    expect(
      getNotificationListIssues(list, { ...scope, query: { workItemKind: "issue" } }),
    ).toContain("list_query_mismatch");
    expect(getNotificationListIssues(list, { ...scope, repositoryId: "other" })).toContain(
      "repository_scope_mismatch",
    );
    expect(
      getNotificationListIssues(list, {
        ...scope,
        actor: { ...actor, issuer: "https://other.example" },
      }),
    ).toContain("actor_scope_mismatch");
    expect(
      getNotificationListIssues({
        ...list,
        items: [{ ...item, event: { ...event, repositoryId: "other" } }],
      }),
    ).toContain("repository_scope_mismatch");
  });

  it("rejects duplicated events, mismatching personal state, and cross-workspace filters", () => {
    expect(getNotificationListIssues({ ...list, items: [item, item] })).toContain(
      "duplicate_notification",
    );
    expect(
      getNotificationListIssues({ ...list, filter: { ...list.filter, state: "read" } }),
    ).toContain("item_filter_mismatch");
    expect(
      getNotificationListIssues({ ...list, filter: { ...list.filter, workItemKind: "issue" } }),
    ).toContain("item_filter_mismatch");
    expect(
      getNotificationListIssues({
        ...list,
        limit: 1,
        items: [
          item,
          {
            ...item,
            event: { ...event, id: "other" },
            state: { ...unread, notificationId: "other" },
          },
        ],
      }),
    ).toContain("invalid_list_size");
  });

  it("supports an empty bounded scan page that advances the repository cursor", () => {
    const bounded = { ...list, items: [], scanLimited: true, nextCursor: "100" };
    expect(getNotificationListIssues(bounded, { ...scope, query: { cursor: "356" } })).toEqual([]);
    expect(getNotificationListIssues({ ...bounded, nextCursor: null })).toContain(
      "invalid_scan_limit",
    );
    expect(getNotificationListIssues({ ...bounded, items: [item], limit: 1 })).toContain(
      "invalid_scan_limit",
    );
    expect(getNotificationListIssues({ ...bounded, scanLimited: false })).toContain(
      "invalid_continuation",
    );
    expect(getNotificationListIssues(bounded, { query: { cursor: "100" } })).toContain(
      "cursor_did_not_advance",
    );
    expect(getNotificationListIssues(bounded, { query: { cursor: "99" } })).toContain(
      "cursor_did_not_advance",
    );
  });

  it("accepts a full page with or without a continuation", () => {
    const full = { ...list, limit: 1 };
    expect(getNotificationListIssues(full)).toEqual([]);
    expect(getNotificationListIssues({ ...full, nextCursor: "1" })).toEqual([]);
  });

  it("validates returned coverage and observation windows", () => {
    expect(getNotificationListIssues({ ...list, retainedAfter: recordedAt })).toContain(
      "invalid_retention_boundary",
    );
    expect(
      getNotificationListIssues({ ...list, coverageStart: "2026-09-07T10:00:00.000Z" }),
    ).toContain("invalid_coverage_window");
    expect(
      getNotificationListIssues({ ...list, retainedAfter: "2026-09-08T00:00:00.000Z" }),
    ).toContain("invalid_coverage_window");
    expect(getNotificationListIssues({ ...list, observedAt: "2026-09-07T09:00:03Z" })).toContain(
      "invalid_observation_time",
    );
    expect(getNotificationListIssues({ ...list, coverageStart: updatedAt })).toContain(
      "item_outside_observation_window",
    );
    expect(getNotificationListIssues({ ...list, retainedAfter: updatedAt })).toContain(
      "item_outside_observation_window",
    );
    expect(getNotificationListIssues({ ...list, observedAt: occurredAt })).toContain(
      "item_outside_observation_window",
    );
    expect(
      getNotificationListIssues({
        ...list,
        items: [{ ...item, state: read }],
        observedAt: recordedAt,
      }),
    ).toContain("item_outside_observation_window");
  });

  it("requires exact safe count sums and excludes zero-event repository rows", () => {
    expect(Value.Check(NotificationOverviewSchema, overview)).toBe(true);
    expect(getNotificationOverviewIssues(overview, { actor, query: {} })).toEqual([]);
    expect(getNotificationCountsIssues({ total: 2, unread: 1, read: 1, archived: 1 })).toContain(
      "count_total_mismatch",
    );
    expect(
      getNotificationCountsIssues({
        total: Number.MAX_SAFE_INTEGER,
        unread: Number.MAX_SAFE_INTEGER,
        read: 1,
        archived: 0,
      }),
    ).toContain("count_total_mismatch");
    expect(
      getNotificationOverviewIssues({
        ...overview,
        items: [
          {
            repositoryId: scope.repositoryId,
            fullName: "example/project",
            counts: { total: 0, unread: 0, read: 0, archived: 0 },
          },
        ],
      }),
    ).toContain("empty_repository_overview");
  });

  it("validates repository overview pagination, duplicate rows, and current actor", () => {
    expect(getNotificationOverviewIssues({ ...overview, page: 2, items: [] })).toEqual([]);
    expect(getNotificationOverviewIssues({ ...overview, page: 2 })).toContain(
      "invalid_overview_page_size",
    );
    expect(
      getNotificationOverviewIssues({
        ...overview,
        items: [...overview.items, ...overview.items],
        total: 2,
      }),
    ).toContain("duplicate_repository");
    expect(getNotificationOverviewIssues(overview, { query: { page: 2 } })).toContain(
      "overview_query_mismatch",
    );
    expect(
      getNotificationOverviewIssues(overview, { actor: { ...actor, subject: "other" } }),
    ).toContain("actor_scope_mismatch");
  });

  it("distinguishes a capped count from an exact count of 99", () => {
    expect(Value.Check(NotificationSummarySchema, summary)).toBe(true);
    expect(getNotificationSummaryIssues(summary, scope)).toEqual([]);
    expect(getNotificationSummaryIssues({ ...summary, unreadCount: 99, capped: true })).toEqual([]);
    expect(getNotificationSummaryIssues({ ...summary, unreadCount: 99, capped: false })).toEqual(
      [],
    );
    expect(getNotificationSummaryIssues({ ...summary, unreadCount: 98, capped: true })).toContain(
      "invalid_unread_cap",
    );
    expect(Value.Check(NotificationSummarySchema, { ...summary, unreadCount: 100 })).toBe(false);
  });

  it("requires a deliberate global or repository summary scope", () => {
    expect(
      getNotificationSummaryIssues(
        { ...summary, repositoryId: null },
        { actor, repositoryId: null },
      ),
    ).toEqual([]);
    expect(getNotificationSummaryIssues(summary, { actor, repositoryId: null })).toContain(
      "repository_scope_mismatch",
    );
    expect(getNotificationSummaryIssues({ ...summary, repositoryId: null }, scope)).toContain(
      "repository_scope_mismatch",
    );
  });

  it.each([
    " operator-1",
    "operator-1\n",
    "operator\u0085name",
    "operator\u202ename",
    "operator\ud800name",
  ])("rejects unsafe actor identity %s", (subject) => {
    const unsafeActor = { ...actor, subject };
    expect(getNotificationListIssues({ ...list, actor: unsafeActor })).toContain("invalid_actor");
    expect(getNotificationOverviewIssues({ ...overview, actor: unsafeActor })).toContain(
      "invalid_actor",
    );
    expect(getNotificationSummaryIssues({ ...summary, actor: unsafeActor })).toContain(
      "invalid_actor",
    );
    expect(getNotificationStateChangeIssues({ ...receipt, actor: unsafeActor })).toContain(
      "invalid_actor",
    );
  });
});
