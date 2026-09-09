import { describe, expect, it, vi } from "vitest";
import { workItems } from "../../services/review-control/mock/fixtures";
import type { ReviewRunAdapter } from "../../services/runs/adapter";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import { completedLatestJobProgress, loadLatestWorkItemRun } from "./latest";

const item = workItems.find((entry) => entry.id === "wi-pr-41982");
const run = sampleReviewRuns.find((entry) => entry.workItemId === item?.id);
if (!item || !run) throw new Error("A scoped work item and run fixture are required.");

describe("the selected work item's current results", () => {
  it("loads only the latest scoped run after an item is selected", async () => {
    const list = vi
      .fn<ReviewRunAdapter["list"]>()
      .mockResolvedValue({ items: [run], page: 1, pageSize: 1, total: 3 });
    expect(await loadLatestWorkItemRun({ list }, item)).toEqual(run);
    expect(list).toHaveBeenCalledExactlyOnceWith(item.repositoryId, {
      workItemId: item.id,
      page: 1,
      pageSize: 1,
    });
  });

  it("allows legacy results only when the selected item truly has no review runs", async () => {
    const list = vi
      .fn<ReviewRunAdapter["list"]>()
      .mockResolvedValue({ items: [], page: 1, pageSize: 1, total: 0 });
    expect(await loadLatestWorkItemRun({ list }, item)).toBeNull();
    list.mockRejectedValueOnce(new Error("The server could not be reached."));
    await expect(loadLatestWorkItemRun({ list }, item)).rejects.toThrow("could not be reached");
  });

  it.each(["repositoryId", "workItemId", "workItemKind"] as const)(
    "does not substitute a run with another %s",
    async (field) => {
      const wrong = { ...run, [field]: field === "workItemKind" ? "issue" : "another-scope" };
      const list = vi
        .fn<ReviewRunAdapter["list"]>()
        .mockResolvedValue({ items: [wrong], page: 1, pageSize: 1, total: 1 });
      await expect(loadLatestWorkItemRun({ list }, item)).rejects.toThrow(
        "another repository or work item",
      );
    },
  );

  it("does not fall back to an old result when the latest-run page is incomplete", async () => {
    const list = vi
      .fn<ReviewRunAdapter["list"]>()
      .mockResolvedValue({ items: [], page: 1, pageSize: 1, total: 1 });
    await expect(loadLatestWorkItemRun({ list }, item)).rejects.toThrow("incomplete");
  });

  it("does not equate one succeeded job with overall validation success", () => {
    expect(completedLatestJobProgress).toEqual({
      label: "Latest job completed",
      detail: "Open results to inspect all validation tracks",
      tone: "quiet",
    });
  });
});
