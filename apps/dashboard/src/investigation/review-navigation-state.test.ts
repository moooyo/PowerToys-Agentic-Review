import { describe, expect, it } from "vitest";
import {
  bindReviewRecord,
  createReviewQueue,
  type ReviewQueue,
  type ReviewRecord,
  readReviewNavigationMarker,
  relatedReviewTarget,
  reviewOpenerId,
  reviewQueueIndex,
  reviewQueueScopeChanged,
  reviewRecordKey,
  reviewRecordMatchesLocation,
} from "./review-navigation-state";

function record(
  id: string,
  workItemId: string,
  kind: ReviewRecord["kind"] = "task",
  repositoryId = "repo-a",
): ReviewRecord {
  const pathname = kind === "task" ? "/tasks" : kind === "report" ? "/reports" : "/pull-requests";
  const parameter = kind === "task" ? "taskId" : kind === "report" ? "reportId" : "workItemId";
  return {
    kind,
    id,
    workItemId,
    repositoryId,
    href: `${pathname}?${new URLSearchParams({ [parameter]: id, repositoryId })}`,
    label: id,
  };
}

function queue(records: ReviewRecord[], overrides: Partial<ReviewQueue> = {}): ReviewQueue {
  const first = records[0];
  if (!first) throw new Error("Expected at least one fixture result");
  const created = createReviewQueue({
    id: "queue-one",
    identity: "account-and-grants-v1",
    repositoryScope: "repo-a",
    originHref: "/tasks?repositoryId=repo-a&status=active&page=2",
    originKey: "list-location-key",
    scrollTop: 640,
    openerId: reviewOpenerId(first),
    label: "Tasks",
    records,
    ...overrides,
  });
  if (!created) throw new Error("Expected an eligible result queue");
  return created;
}

function memberKey(saved: ReviewQueue, index = 0) {
  const member = saved.members[index];
  if (!member) throw new Error("Expected a frozen result at this index");
  return reviewRecordKey(member);
}

describe("frozen review result queues", () => {
  it("retains the source origin after creation removes it from a live filtered list", () => {
    const source = record("source-one", "source-one", "work-item");
    const live = [source];
    const saved = queue(live, {
      originHref: "/pull-requests?repositoryId=repo-a&investigation=not_started",
      openerId: `${reviewOpenerId(source)}-next`,
      label: "Pull requests",
    });
    live.pop();
    const selection = { queue: saved, originMemberId: reviewRecordKey(source) };
    const created = record("created-task", "source-one");
    expect(relatedReviewTarget(source, created)).toBe(true);
    expect(bindReviewRecord(selection, created, saved.identity)).toBe(selection);
    expect(saved.originHref).toContain("investigation=not_started");
    expect(saved.openerId).toBe(`${reviewOpenerId(source)}-next`);
    expect(saved.scrollTop).toBe(640);
    expect(saved.members).toHaveLength(1);
  });

  it("only binds list shortcuts to related records with valid local detail routes", () => {
    const source = record("source-one", "source-one", "work-item");
    const task = record("task-one", "source-one");
    const report = record("report-one", "source-one", "report");
    expect(relatedReviewTarget(source, task)).toBe(true);
    expect(relatedReviewTarget(source, { ...task, href: `${task.href}&tab=details` })).toBe(true);
    expect(relatedReviewTarget(source, report)).toBe(true);
    expect(relatedReviewTarget(source, record("task-two", "source-two"))).toBe(false);
    expect(relatedReviewTarget(source, record("task-one", "source-one", "task", "repo-b"))).toBe(
      false,
    );
    expect(relatedReviewTarget(source, { ...task, href: "/tasks?taskId=another-task" })).toBe(
      false,
    );
    expect(
      relatedReviewTarget(source, { ...task, href: "https://example.com/tasks?taskId=task-one" }),
    ).toBe(false);
  });

  it("captures the clicked result order and list location independently of later live data", () => {
    const first = record("task-one", "source-one");
    const second = record("task-two", "source-two");
    const records = [first, second, { ...first }];
    const saved = queue(records);
    first.href = "/tasks?taskId=changed";
    first.label = "Changed after the click";
    records.reverse();
    records.pop();
    expect(saved.members.map((member) => member.id)).toEqual(["task-one", "task-two"]);
    expect(saved.members[0]?.href).toContain("taskId=task-one");
    expect(saved.members[0]?.label).toBe("task-one");
    expect(saved.originHref).toBe("/tasks?repositoryId=repo-a&status=active&page=2");
    expect(saved.scrollTop).toBe(640);
    expect(Object.isFrozen(saved.members)).toBe(true);
    expect(Object.isFrozen(saved.members[0])).toBe(true);
  });

  it("labels a server-paginated result snapshot as only its loaded page", () => {
    const saved = queue([record("report-two", "source-one", "report")], {
      originHref: "/reports?repositoryId=repo-a&cursor=opaque-page-two",
      label: "Reports",
      complete: false,
    });
    expect(saved.complete).toBe(false);
    expect(saved.members).toHaveLength(1);
    expect(saved.originHref).toContain("cursor=opaque-page-two");
  });

  it("keeps the origin report position through its Source, Task and child Task", () => {
    const saved = queue(
      [
        record("report-earlier", "source-one", "report"),
        record("report-later", "source-one", "report"),
      ],
      { originHref: "/reports?repositoryId=repo-a", label: "Reports" },
    );
    const selection = { queue: saved, originMemberId: memberKey(saved, 1) };
    for (const related of [
      record("source-one", "source-one", "work-item"),
      record("parent-task", "source-one"),
      record("child-task", "source-one"),
      record("report-earlier", "source-one", "report"),
    ]) {
      const bound = bindReviewRecord(selection, related, saved.identity);
      expect(bound).toBe(selection);
      if (!bound) throw new Error("The related detail must keep its origin member");
      expect(reviewQueueIndex(bound)).toBe(1);
    }
  });

  it("does not relate records just because their route IDs are equal", () => {
    const saved = queue([record("task-one", "source-one")]);
    const selection = { queue: saved, originMemberId: memberKey(saved) };
    expect(
      bindReviewRecord(selection, record("task-one", "source-other"), saved.identity),
    ).toBeNull();
    expect(
      bindReviewRecord(
        selection,
        record("task-one", "source-one", "task", "repo-b"),
        saved.identity,
      ),
    ).toBeNull();
    expect(
      bindReviewRecord(selection, record("child-task", "source-one"), "new-account-or-grants"),
    ).toBeNull();
  });

  it("accepts related detail scope but invalidates a deliberate list repository change", () => {
    const saved = queue([record("task-one", "source-one")], {
      repositoryScope: null,
      originHref: "/tasks?status=active",
    });
    const selection = { queue: saved, originMemberId: memberKey(saved) };
    expect(
      reviewQueueScopeChanged(selection, {
        pathname: "/reports",
        search: "?reportId=report-one&repositoryId=repo-a",
      }),
    ).toBe(false);
    expect(
      reviewQueueScopeChanged(selection, {
        pathname: "/reports",
        search: "?reportId=report-one&repositoryId=repo-b",
      }),
    ).toBe(true);
    expect(
      reviewQueueScopeChanged(selection, { pathname: "/tasks", search: "?repositoryId=repo-a" }),
    ).toBe(true);
    expect(
      reviewQueueScopeChanged(selection, { pathname: "/tasks", search: "?status=active" }),
    ).toBe(false);
    expect(
      reviewQueueScopeChanged(selection, { pathname: "/comments", search: "?repositoryId=repo-b" }),
    ).toBe(true);
  });

  it("registers only the loaded entity bound to the current detail URL", () => {
    const task = record("task-one", "source-one");
    expect(
      reviewRecordMatchesLocation(task, {
        pathname: "/tasks",
        search: "?taskId=task-one&tab=evidence&attemptId=older",
      }),
    ).toBe(true);
    expect(reviewRecordMatchesLocation(task, { pathname: "/tasks", search: "?taskId=other" })).toBe(
      false,
    );
    expect(
      reviewRecordMatchesLocation(task, { pathname: "/reports", search: "?reportId=task-one" }),
    ).toBe(false);
    expect(
      reviewRecordMatchesLocation(task, {
        pathname: "/tasks",
        search: "?taskId=task-one&repositoryId=repo-b",
      }),
    ).toBe(false);
  });

  it("excludes unsafe or wrongly scoped destinations while preserving other valid results", () => {
    const valid = record("task-one", "source-one");
    const saved = queue([
      { ...valid, id: "external", href: "https://other.example/tasks?taskId=external" },
      { ...valid, id: "network-path", href: "//other.example/tasks?taskId=network-path" },
      { ...valid, id: "wrong-record", href: "/tasks?taskId=another-id" },
      record("out-of-scope", "source-one", "task", "repo-b"),
      valid,
    ]);
    expect(saved.members).toEqual([valid]);
  });

  it("uses distinct stable opener identities for actual entity kinds and repositories", () => {
    const task = record("one", "source-one");
    expect(reviewOpenerId({ ...task })).toBe(reviewOpenerId(task));
    expect(reviewOpenerId(record("one", "source-one", "report"))).not.toBe(reviewOpenerId(task));
    expect(reviewOpenerId(record("one", "source-one", "task", "repo-b"))).not.toBe(
      reviewOpenerId(task),
    );
  });

  it("reads only an in-memory history reference rather than accepting serialized queue data", () => {
    const marker = { queueId: "queue-one", originMemberId: "member-one", destination: "detail" };
    expect(
      readReviewNavigationMarker({
        reviewNavigation: { ...marker, payload: "private", members: [] },
      }),
    ).toEqual(marker);
    expect(
      readReviewNavigationMarker({ reviewNavigation: { ...marker, destination: "execute" } }),
    ).toBeNull();
    expect(readReviewNavigationMarker({ queue: { members: [] } })).toBeNull();
    expect(readReviewNavigationMarker(null)).toBeNull();
  });
});
