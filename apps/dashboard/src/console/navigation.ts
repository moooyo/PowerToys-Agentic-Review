import type { ReviewRecord } from "./model";

/** An explicit resource link must never silently open a different review. */
export function selectReviewRecord(
  records: ReviewRecord[],
  parameters: URLSearchParams,
): ReviewRecord | undefined {
  const recordId = parameters.get("recordId") || parameters.get("taskId");
  const reportId = parameters.get("reportId");
  const commentId = parameters.get("commentId");
  const workItemId = parameters.get("workItemId");
  if (!recordId && !reportId && !commentId && !workItemId) {
    return (
      records.find((record) => record.status === "attention" && record.problem) ||
      records.find((record) => record.status === "running") ||
      records.find((record) => record.status === "publishing") ||
      records.find((record) => record.status === "queued") ||
      records[0]
    );
  }
  for (const record of records) {
    if (recordId === record.id && !reportId && !commentId && !workItemId) return record;
    const related = record.relatedWork || [record];
    const work = related.find(
      (item) =>
        (!recordId || record.id === recordId || item.taskId === recordId) &&
        (!reportId || item.header?.report.id === reportId) &&
        (!commentId ||
          item.publication?.id === commentId ||
          item.progressPublication?.id === commentId) &&
        (!workItemId || item.workItemId === workItemId),
    );
    if (work) return { ...record, currentWorkId: work.taskId };
  }
  return undefined;
}

export function hasReviewSelection(parameters: URLSearchParams): boolean {
  return ["recordId", "taskId", "reportId", "commentId", "workItemId"].some((key) =>
    Boolean(parameters.get(key)),
  );
}
