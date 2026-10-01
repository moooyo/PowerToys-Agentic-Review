import { describe, expect, it } from "vitest";
import type { ReviewRecord } from "./model";
import { hasReviewSelection, selectReviewRecord } from "./navigation";

function record(id: string, status: ReviewRecord["status"]): ReviewRecord {
  return {
    id,
    taskId: id,
    workItemId: `source-${id}`,
    repositoryId: "repository",
    repositoryFullName: "microsoft/PowerToys",
    kind: "pr",
    number: 1,
    title: id,
    area: "",
    updatedAt: "2026-10-01T00:00:00Z",
    status,
    ...(status === "attention"
      ? { problem: { type: "review", code: "failed", message: "Failed", hint: "Retry" } as const }
      : {}),
  };
}

describe("review resource navigation", () => {
  it("selects attention before live and published work only for an unqualified inbox", () => {
    const records = [
      record("published", "posted"),
      record("live", "running"),
      record("failed", "attention"),
    ];
    expect(selectReviewRecord(records, new URLSearchParams())?.id).toBe("failed");
    expect(selectReviewRecord(records.slice(0, 2), new URLSearchParams())?.id).toBe("live");
  });
  it.each(["recordId", "taskId", "reportId", "commentId", "workItemId"])(
    "does not substitute an unrelated review for an unknown %s",
    (key) => {
      const parameters = new URLSearchParams({ [key]: "missing-resource" });
      expect(hasReviewSelection(parameters)).toBe(true);
      expect(selectReviewRecord([record("failed", "attention")], parameters)).toBeUndefined();
    },
  );
  it("opens an exact follow-up inside its parent review", () => {
    const parent = record("parent", "posted");
    const child = record("verification", "running");
    parent.relatedWork = [parent, child];
    expect(
      selectReviewRecord([parent], new URLSearchParams({ taskId: child.taskId || "" })),
    ).toMatchObject({ id: parent.id, currentWorkId: child.taskId });
  });
  it("rejects conflicting source and work identifiers", () => {
    const selected = record("known", "running");
    expect(
      selectReviewRecord(
        [selected],
        new URLSearchParams({ taskId: selected.id, workItemId: "another-source" }),
      ),
    ).toBeUndefined();
  });
  it("treats an empty identifier as an unqualified inbox", () => {
    expect(hasReviewSelection(new URLSearchParams("recordId="))).toBe(false);
    expect(
      selectReviewRecord([record("live", "running")], new URLSearchParams("recordId="))?.id,
    ).toBe("live");
  });
});
