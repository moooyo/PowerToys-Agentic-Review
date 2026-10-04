import type { ReviewRecord } from "./model";

/** An explicit resource link must never silently open a different review. */
export function selectReviewRecord(
  records: ReviewRecord[],
  parameters: URLSearchParams,
): ReviewRecord | undefined {
  const recordId = parameters.get("recordId");
  const taskId = parameters.get("taskId");
  const reportId = parameters.get("reportId");
  const commentId = parameters.get("commentId");
  const workItemId = parameters.get("workItemId");
  if (!recordId && !taskId && !reportId && !commentId && !workItemId) {
    return (
      records.find((record) => record.status === "attention" && record.problem) ||
      records.find((record) => record.status === "running") ||
      records.find((record) => record.status === "publishing") ||
      records.find((record) => record.status === "queued") ||
      records[0]
    );
  }
  for (const record of records) {
    if (workItemId && record.workItemId !== workItemId) continue;
    const related = (record.relatedWork ?? [record]).filter(
      (item) =>
        item.repositoryId === record.repositoryId &&
        item.workItemId === record.workItemId &&
        item.kind === record.kind &&
        item.number === record.number,
    );
    const historical =
      recordId && recordId !== record.id
        ? related.find((item) => item.taskId === recordId)
        : undefined;
    if (recordId && recordId !== record.id && !historical) continue;
    // A source or container link preserves its current activity; an explicit task selects history.
    if (!taskId && !reportId && !commentId && !historical) return record;
    const candidates = taskId
      ? related.filter((item) => item.taskId === taskId)
      : historical
        ? [historical]
        : related;
    const work = candidates.find(
      (item) =>
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
