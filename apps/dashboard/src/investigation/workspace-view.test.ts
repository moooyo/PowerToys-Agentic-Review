import { describe, expect, it } from "vitest";
import {
  changeRepositorySearch,
  publicWorkspaceHref,
  publicWorkspaceSearch,
  scopedWorkspaceHref,
} from "./workspace-view";

describe("public workspace view", () => {
  it("retains the Comments work item filter without accepting an unknown source type", () => {
    expect(publicWorkspaceSearch("/comments", "?workItemKind=issue&search=settings")).toBe(
      "workItemKind=issue&search=settings",
    );
    expect(publicWorkspaceSearch("/comments", "?workItemKind=unknown&payload=private")).toBe("");
  });
  it("copies allowed report context but excludes arbitrary payloads, credentials and anchors", () => {
    const result = new URLSearchParams(
      publicWorkspaceSearch(
        "/reports",
        "?reportId=report-one&findingId=finding-2&findingSearch=cancel&payload=secret&body=private&token=credential&role=admin&findingPage=2",
      ),
    );
    expect(Object.fromEntries(result)).toEqual({
      reportId: "report-one",
      findingId: "finding-2",
      findingSearch: "cancel",
      findingPage: "2",
    });
  });
  it("rejects malformed identifiers, pagination and control characters", () => {
    expect(
      publicWorkspaceSearch(
        "/tasks",
        "?taskId=../private&page=-1&q=%00bad&attemptId=valid:attempt",
      ),
    ).toBe("attemptId=valid%3Aattempt");
  });
  it("switches repository without carrying a detail, page or finding into the new scope", () => {
    expect(
      Object.fromEntries(
        new URLSearchParams(
          changeRepositorySearch(
            "?repositoryId=old&taskId=t1&attemptId=a1&tab=evidence&page=5&cursor=opaque&q=Settings&status=active",
            "new",
          ),
        ),
      ),
    ).toEqual({ q: "Settings", status: "active", repositoryId: "new" });
    expect(scopedWorkspaceHref("/tasks", "repo-one")).toBe("/tasks?repositoryId=repo-one");
    expect(scopedWorkspaceHref("/accounts", "repo-one")).toBe("/accounts");
  });

  it("shares the repository reply-template view without serializing the editor", () => {
    const search = new URLSearchParams({
      repositoryId: "repo-one",
      tab: "replies",
      replyTemplate: "failed",
      q: "PowerToys",
      templateBody: "private draft",
      password: "not-a-real-password",
      actionPayload: "private intent",
      reviewNavigation: "private queue",
    });
    expect(
      Object.fromEntries(
        new URLSearchParams(publicWorkspaceSearch("/repositories", search.toString())),
      ),
    ).toEqual({
      repositoryId: "repo-one",
      q: "PowerToys",
      tab: "replies",
      replyTemplate: "failed",
    });
    expect(
      publicWorkspaceSearch("/repositories", "?replyTemplate=arbitrary-template&tab=publish"),
    ).toBe("");
    expect(publicWorkspaceSearch("/tasks", "?taskId=task-one&replyTemplate=issue")).toBe(
      "taskId=task-one",
    );
  });

  it("retains a complete report directory view and its opaque cursor separately from finding controls", () => {
    const query = new URLSearchParams({
      repositoryId: "repo-one",
      search: "cancel migration",
      kind: "pr-review",
      completeness: "partial",
      delivery: "checkpoint",
      cursor: "opaque:+/page==",
      reportId: "report-one",
      section: "findings",
      findingId: "finding-26",
      findingPriority: "P0",
      findingAssessment: "confirmed",
      findingPage: "2",
    });
    const copied = new URLSearchParams(publicWorkspaceSearch("/reports", query.toString()));
    expect(Object.fromEntries(copied)).toEqual(Object.fromEntries(query));
  });

  it("copies task output controls but excludes output content and an unknown event type", () => {
    const copied = new URLSearchParams(
      publicWorkspaceSearch(
        "/tasks",
        "?taskId=task-one&attemptId=attempt-two&tab=progress&outputSearch=settings&outputType=tool&output=private-output&body=private-feedback",
      ),
    );
    expect(Object.fromEntries(copied)).toEqual({
      taskId: "task-one",
      attemptId: "attempt-two",
      tab: "progress",
      outputSearch: "settings",
      outputType: "tool",
    });
    expect(publicWorkspaceSearch("/tasks", "?taskId=task-one&outputType=reasoning")).toBe(
      "taskId=task-one",
    );
  });

  it("clears every detail/presentation binding on a repository switch while retaining ordinary list filters", () => {
    const query = new URLSearchParams({
      repositoryId: "repo-old",
      workItemId: "source-one",
      taskId: "task-one",
      reportId: "report-one",
      commentId: "comment-one",
      deliveryId: "delivery-one",
      workerId: "worker-one",
      findingId: "finding-one",
      attemptId: "attempt-one",
      tab: "replies",
      section: "findings",
      replyTemplate: "issue",
      findingSearch: "private search",
      findingPriority: "P1",
      findingAssessment: "confirmed",
      findingPage: "2",
      outputSearch: "settings",
      outputType: "tool",
      page: "3",
      cursor: "cursor-one",
      q: "Settings",
      state: "open",
      rows: "16",
    });
    expect(
      Object.fromEntries(new URLSearchParams(changeRepositorySearch(query.toString(), "repo-new"))),
    ).toEqual({
      q: "Settings",
      state: "open",
      rows: "16",
      repositoryId: "repo-new",
    });
    expect(
      Object.fromEntries(new URLSearchParams(changeRepositorySearch(query.toString(), ""))),
    ).toEqual({
      q: "Settings",
      state: "open",
      rows: "16",
    });
  });

  it("keeps management destinations workspace-wide and cannot copy an external destination", () => {
    for (const path of ["/repositories", "/workers", "/accounts", "/account"])
      expect(scopedWorkspaceHref(path, "repo-one")).toBe(path);
    expect(
      publicWorkspaceHref(
        "/accounts",
        "?repositoryId=repo-one&q=reviewer&status=enabled&role=admin",
      ),
    ).toBe("/accounts?q=reviewer&status=enabled");
    expect(publicWorkspaceHref("//outside.example", "?q=Settings&password=secret")).toBe(
      "/pull-requests?q=Settings",
    );
  });
});
