import { describe, expect, it } from "vitest";
import {
  hasAppliedRepositoryFilter,
  isWorkspaceDetail,
  withoutRepositoryFilter,
  workspaceRecordKey,
} from "./workspace-navigation";

describe("contextual workspace navigation", () => {
  it("does not hide group navigation for a source-filtered activity list or expanded Worker", () => {
    expect(isWorkspaceDetail("/comments", "?workItemId=source-one")).toBe(false);
    expect(isWorkspaceDetail("/webhooks", "?workItemId=source-one")).toBe(false);
    expect(isWorkspaceDetail("/workers", "?workerId=worker-one")).toBe(false);
    expect(isWorkspaceDetail("/comments", "?commentId=comment-one")).toBe(true);
    expect(isWorkspaceDetail("/webhooks", "?deliveryId=delivery-one")).toBe(true);
    expect(isWorkspaceDetail("/tasks", "?taskId=")).toBe(false);
  });

  it("exposes only a real list repository filter, without inventing a global scope", () => {
    expect(hasAppliedRepositoryFilter("/tasks", "?repositoryId=repo-one")).toBe(true);
    expect(hasAppliedRepositoryFilter("/pull-requests", "?repositoryId=repo-one")).toBe(true);
    expect(hasAppliedRepositoryFilter("/tasks", "?repositoryId=repo-one&taskId=task-one")).toBe(
      false,
    );
    expect(hasAppliedRepositoryFilter("/repositories", "?repositoryId=repo-one")).toBe(false);
    expect(hasAppliedRepositoryFilter("/reports", "?repositoryId=repo-one")).toBe(false);
  });

  it("clears the repository and its bound pagination while retaining the user's other filters", () => {
    const next = new URLSearchParams(
      withoutRepositoryFilter(
        "?repositoryId=repo-one&page=3&cursor=opaque&state=failed&search=settings",
      ),
    );
    expect([...next.entries()]).toEqual([
      ["state", "failed"],
      ["search", "settings"],
    ]);
  });

  it("keeps reader position for attempt selection and inline Worker expansion, but separates task records", () => {
    expect(workspaceRecordKey("/tasks", "?taskId=one&attemptId=first")).toBe(
      workspaceRecordKey("/tasks", "?attemptId=second&taskId=one"),
    );
    expect(workspaceRecordKey("/tasks", "?taskId=one")).not.toBe(
      workspaceRecordKey("/tasks", "?taskId=two"),
    );
    expect(workspaceRecordKey("/workers", "?workerId=one")).toBe(
      workspaceRecordKey("/workers", "?workerId=two"),
    );
  });
});
