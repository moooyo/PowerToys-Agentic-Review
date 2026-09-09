import { describe, expect, it } from "vitest";
import {
  notificationItemFixture,
  notificationSummaryFixture,
} from "../../services/notifications/fixtures.testing";
import {
  createNotificationStateChange,
  notificationDescription,
  notificationHref,
  notificationLabel,
  notificationUnreadLabel,
} from "./state";

describe("notification presentation and personal mutation selection", () => {
  it("distinguishes completed execution from passing validation", () => {
    const event = notificationItemFixture().event;
    expect(notificationLabel(event)).toBe("Validation completed");
    const description = notificationDescription(event);
    expect(description).toContain("1 failed");
    expect(description).toContain("2 required checks did not pass");
    expect(description).toContain("Evidence incomplete");
    expect(description).toContain("1 lifecycle blockers");
    expect(description).not.toMatch(/recommend.*approv|validation passed/i);
  });
  it("retains the exact run, request, job, work item and repository in a result link", () => {
    const path = notificationHref(notificationItemFixture().event);
    const url = new URL(path, "https://dashboard.invalid");
    expect(url.pathname).toBe("/pull-requests");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      repositoryId: "repository-a",
      workItemId: "work-item-a",
      reviewRunId: "run-a",
      requestId: "request-a",
      jobId: "job-a",
    });
  });
  it("routes unknown delivery to its exact outbox without a sending shortcut", () => {
    const original = notificationItemFixture().event;
    const event = {
      schemaVersion: "NotificationEventV1" as const,
      id: "publication-notification",
      repositoryId: original.repositoryId,
      workItemId: original.workItemId,
      workItemKind: original.workItemKind,
      number: original.number,
      reviewRunId: original.reviewRunId,
      revisionKey: original.revisionKey,
      occurredAt: original.occurredAt,
      recordedAt: original.recordedAt,
      sourceId: "attempt-event-a",
      kind: "publication" as const,
      publicationId: "publication-a",
      attemptKind: "delivery" as const,
      attemptNumber: 1,
      outcome: "unknown" as const,
      failureCode: "ambiguous_delivery" as const,
    };
    expect(notificationLabel(event)).toBe("Delivery uncertain");
    expect(notificationDescription(event)).toContain("reconcile using GET requests");
    expect(notificationHref(event)).toBe(
      "/publications?repositoryId=repository-a&publicationId=publication-a",
    );
  });
  it("freezes only explicitly selected visible IDs with their current CAS versions", () => {
    const first = notificationItemFixture(),
      second = structuredClone(first);
    second.event.id = "second";
    second.state = {
      ...second.state,
      notificationId: "second",
      version: 3,
      state: "archived",
      updatedAt: "2026-09-07T12:00:00.000Z",
    };
    const request = createNotificationStateChange(
      [first, second],
      ["second"],
      "unread",
      "change-a",
    );
    expect(request).toEqual({
      changeId: "change-a",
      changes: [{ notificationId: "second", expectedVersion: 3, state: "unread" }],
    });
    second.state.version = 5;
    expect(request.changes[0]?.expectedVersion).toBe(3);
  });
  it.each([
    { selected: [] },
    { selected: ["outside-page"] },
    { selected: ["notification-a", "notification-a"] },
    { selected: Array.from({ length: 51 }, (_, i) => `item-${i}`) },
  ])("rejects unbounded or stale selection %j", ({ selected }) => {
    expect(() =>
      createNotificationStateChange([notificationItemFixture()], selected, "read", "change-a"),
    ).toThrow();
  });
  it("uses 99+ only for a server-capped summary", () => {
    expect(
      notificationUnreadLabel({ ...notificationSummaryFixture(), unreadCount: 99, capped: true }),
    ).toBe("99+ unread");
    expect(notificationUnreadLabel({ ...notificationSummaryFixture(), unreadCount: 99 })).toBe(
      "99 unread",
    );
  });
});
