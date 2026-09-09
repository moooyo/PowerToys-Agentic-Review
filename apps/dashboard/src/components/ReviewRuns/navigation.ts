import type { DashboardReviewRunDetail, DashboardReviewRunJob } from "@agentic-review/contracts";
import type { NotificationTarget } from "@/components/NotificationTarget/targets";
import type { WorkItem } from "@/services/review-control";
import type { ReviewRunAdapter } from "@/services/runs";

export type ReviewRunWorkItem = Pick<
  WorkItem,
  "id" | "repositoryId" | "kind" | "repository" | "title" | "number"
>;
export type ValidationNotificationTarget = Extract<NotificationTarget, { kind: "validation" }>;

export function notificationRunWorkItem(run: DashboardReviewRunDetail): ReviewRunWorkItem {
  return {
    id: run.workItemId,
    repositoryId: run.repositoryId,
    kind: run.workItemKind,
    repository: run.repository,
    title: run.title,
    number: run.number,
  };
}

export async function loadNotificationRun(
  adapter: Pick<ReviewRunAdapter, "get">,
  target: ValidationNotificationTarget,
): Promise<DashboardReviewRunDetail> {
  const run = await adapter.get(target.repositoryId, target.reviewRunId);
  if (
    run.id !== target.reviewRunId ||
    run.repositoryId !== target.repositoryId ||
    run.workItemId !== target.workItemId ||
    run.workItemKind !== target.workItemKind ||
    (target.requestId !== undefined &&
      !run.requests.some((request) => request.requestId === target.requestId))
  )
    throw new Error("The notification target does not match this repository, work item, and run.");
  return run;
}

export async function loadNotificationJob(
  adapter: Pick<ReviewRunAdapter, "listJobs">,
  run: DashboardReviewRunDetail,
  target: { requestId: string; jobId: string },
): Promise<{ requestId: string; job: DashboardReviewRunJob }> {
  if (!run.requests.some((request) => request.requestId === target.requestId))
    throw new Error("The selected request does not belong to this run.");
  const result = await adapter.listJobs(run.repositoryId, run.id, target.requestId, {
    page: 1,
    pageSize: 1,
    jobId: target.jobId,
  });
  const job = result.items[0];
  if (
    result.repositoryId !== run.repositoryId ||
    result.reviewRunId !== run.id ||
    result.requestId !== target.requestId ||
    result.page !== 1 ||
    result.pageSize !== 1 ||
    result.total !== 1 ||
    result.items.length !== 1 ||
    job?.jobId !== target.jobId
  )
    throw new Error("The selected job is unavailable in this request's execution history.");
  return { requestId: target.requestId, job };
}
