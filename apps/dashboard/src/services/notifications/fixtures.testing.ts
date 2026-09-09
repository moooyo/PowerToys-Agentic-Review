import type {
  NotificationItem,
  NotificationList,
  NotificationOverview,
  NotificationStateChange,
  NotificationStateChangeRequest,
  NotificationSummary,
} from "@agentic-review/contracts";

export const notificationTestActor = {
  issuer: "https://notifications.example",
  subject: "reader-a",
};
export const notificationTestTime = "2026-09-07T12:00:00.000Z";
const observation = {
  actor: notificationTestActor,
  observedAt: notificationTestTime,
  coverageStart: "2026-09-01T00:00:00.000Z",
  retainedAfter: "2026-09-01T00:00:00.000Z",
};
export function notificationItemFixture(): NotificationItem {
  return {
    event: {
      schemaVersion: "NotificationEventV1",
      id: "notification-a",
      repositoryId: "repository-a",
      workItemId: "work-item-a",
      workItemKind: "pull_request",
      number: 7,
      reviewRunId: "run-a",
      revisionKey: "a".repeat(64),
      sourceId: "job-a",
      occurredAt: notificationTestTime,
      recordedAt: notificationTestTime,
      kind: "validation",
      jobId: "job-a",
      requestId: "request-a",
      jobActivation: 1,
      workflowKind: "pr_static_build",
      target: "headless",
      jobStatus: "succeeded",
      runAttemptId: "attempt-a",
      result: {
        resultId: "result-a",
        checks: {
          total: 5,
          passed: 2,
          failed: 1,
          blocked: 1,
          not_run: 1,
          skipped: 0,
          inconclusive: 0,
        },
        requiredNonPassed: 2,
        lifecycleBlockers: 1,
        evidenceComplete: false,
        sourceState: "original",
        cleanupState: "completed",
      },
    },
    state: {
      schemaVersion: "NotificationReadStateV1",
      notificationId: "notification-a",
      version: 0,
      state: "unread",
      updatedAt: null,
    },
  };
}
export function notificationListFixture(): NotificationList {
  return {
    schemaVersion: "NotificationListV1",
    repositoryId: "repository-a",
    ...observation,
    items: [notificationItemFixture()],
    nextCursor: null,
    scanLimited: false,
    limit: 20,
    filter: { state: "all", workItemKind: "all" },
  };
}
export function notificationOverviewFixture(): NotificationOverview {
  return {
    schemaVersion: "NotificationOverviewV1",
    ...observation,
    items: [
      {
        repositoryId: "repository-a",
        fullName: "synthetic/repository-a",
        counts: { total: 3, unread: 1, read: 1, archived: 1 },
      },
    ],
    page: 1,
    pageSize: 20,
    total: 1,
  };
}
export function notificationSummaryFixture(
  repositoryId: string | null = null,
): NotificationSummary {
  return {
    schemaVersion: "NotificationSummaryV1",
    ...observation,
    repositoryId,
    unreadCount: 1,
    capped: false,
  };
}
export function notificationChangeFixture(
  request: NotificationStateChangeRequest,
): NotificationStateChange {
  return {
    schemaVersion: "NotificationStateChangeV1",
    repositoryId: "repository-a",
    actor: notificationTestActor,
    changeId: request.changeId,
    createdAt: notificationTestTime,
    changes: request.changes.map((change) => ({
      notificationId: change.notificationId,
      previousVersion: change.expectedVersion,
      state: {
        schemaVersion: "NotificationReadStateV1",
        notificationId: change.notificationId,
        version: change.expectedVersion + 1,
        state: change.state,
        updatedAt: notificationTestTime,
      },
    })),
    replayed: false,
  };
}
