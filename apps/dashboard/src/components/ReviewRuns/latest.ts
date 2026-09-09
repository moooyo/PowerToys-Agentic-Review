import type { DashboardReviewRunSummary } from "@agentic-review/contracts";
import type { WorkItem } from "../../services/review-control/types";
import type { ReviewRunAdapter } from "../../services/runs/adapter";
import { runBelongsToWorkItem } from "./presentation";

export const completedLatestJobProgress = {
  label: "Latest job completed",
  detail: "Open results to inspect all validation tracks",
  tone: "quiet",
} as const;

export async function loadLatestWorkItemRun(
  adapter: Pick<ReviewRunAdapter, "list">,
  workItem: WorkItem,
): Promise<DashboardReviewRunSummary | null> {
  const result = await adapter.list(workItem.repositoryId, {
    workItemId: workItem.id,
    page: 1,
    pageSize: 1,
  });
  if (
    result.page !== 1 ||
    result.pageSize !== 1 ||
    result.items.length > 1 ||
    (result.total > 0 && result.items.length === 0)
  )
    throw new Error("The latest run response is incomplete. Refresh before inspecting results.");
  const run = result.items[0];
  if (run && (!runBelongsToWorkItem(run, workItem) || run.workItemKind !== workItem.kind))
    throw new Error(
      "The latest run belongs to another repository or work item. No previous result will be substituted.",
    );
  return run ?? null;
}
