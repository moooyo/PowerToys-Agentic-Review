import type {
  InvestigationReportHeaderV1,
  InvestigationTaskV1,
  InvestigationWorkItemDiscussion,
} from "@agentic-review/contracts";
import type { WorkItem } from "./api";

export const investigationFilters = [
  "all",
  "not_started",
  "running",
  "queued",
  "blocked",
  "paused",
  "completed",
] as const;
export type InvestigationFilter = (typeof investigationFilters)[number];
export const investigationLabels: Record<InvestigationFilter, string> = {
  all: "All investigations",
  not_started: "Needs review",
  running: "Running",
  queued: "Waiting",
  blocked: "Needs attention",
  paused: "Paused",
  completed: "Completed",
};

export function workItemUrl(
  item: Pick<WorkItem, "id" | "repositoryId" | "kind">,
  tab?: string,
): string {
  const query = new URLSearchParams({ repositoryId: item.repositoryId, workItemId: item.id });
  if (tab && tab !== "overview") query.set("tab", tab);
  return `${item.kind === "pull_request" ? "/pull-requests" : "/issues"}?${query}`;
}

export function taskUrl(task: InvestigationTaskV1): string {
  return `/tasks?${new URLSearchParams({ repositoryId: task.repository.id, taskId: task.id })}`;
}

export function relatedWorkItemTasks(
  item: WorkItem,
  tasks: readonly InvestigationTaskV1[],
): InvestigationTaskV1[] {
  return tasks
    .filter(
      (task) =>
        task.workItem.id === item.id &&
        task.repository.id === item.repositoryId &&
        task.workItem.kind === item.kind &&
        task.workItem.number === item.number,
    )
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
}

export function taskUsesCurrentSource(item: WorkItem, task: InvestigationTaskV1): boolean {
  return task.subjects.some(
    (subject) =>
      subject.id === item.subject.id &&
      subject.repositoryId === item.repositoryId &&
      subject.workItemId === item.id &&
      subject.revisionKey === item.subject.revisionKey,
  );
}

export function currentWorkItemTask(
  item: WorkItem,
  tasks: readonly InvestigationTaskV1[],
): InvestigationTaskV1 | undefined {
  const kind = item.kind === "pull_request" ? "pr-review" : "issue-investigate";
  const current = relatedWorkItemTasks(item, tasks).filter(
    (task) => task.kind === kind && taskUsesCurrentSource(item, task),
  );
  return current.find((task) => task.state === "running" || task.state === "queued") ?? current[0];
}

export function workItemInvestigationState(
  task: InvestigationTaskV1 | undefined,
): Exclude<InvestigationFilter, "all"> {
  if (!task) return "not_started";
  if (task.state === "failed" || task.state === "blocked") return "blocked";
  if (task.state === "cancelled" || task.state === "interrupted") return "paused";
  return task.state;
}

export function investigationStateLabel(task: InvestigationTaskV1 | undefined): string {
  return task?.state === "failed"
    ? "Failed"
    : task?.state === "cancelled"
      ? "Cancelled"
      : task?.state === "interrupted"
        ? "Interrupted"
        : investigationLabels[workItemInvestigationState(task)];
}

export function taskReportMatches(
  item: WorkItem,
  task: InvestigationTaskV1,
  report: InvestigationReportHeaderV1,
): boolean {
  const ref = task.latestReportRef;
  return (
    !!ref &&
    report.id === ref.id &&
    report.version === ref.version &&
    report.report.id === ref.id &&
    report.report.version === ref.version &&
    report.report.logicalContentDigest === ref.digest &&
    report.context.task.id === task.id &&
    report.context.task.subjectRef === task.subjectRef &&
    report.context.repository.id === item.repositoryId &&
    report.context.workItem.id === item.id &&
    report.context.workItem.kind === item.kind &&
    report.context.workItem.number === item.number &&
    report.context.subjects.some(
      (subject) =>
        subject.id === task.subjectRef &&
        task.subjects.some(
          (saved) =>
            saved.id === subject.id &&
            saved.repositoryId === subject.repositoryId &&
            saved.workItemId === subject.workItemId &&
            saved.revisionKey === subject.revisionKey,
        ),
    )
  );
}

export function assertSourceSnapshot(item: WorkItem, value: InvestigationWorkItemDiscussion): void {
  const snapshot = value.inputSnapshot;
  if (
    value.workItemId !== item.id ||
    value.repositoryId !== item.repositoryId ||
    value.revisionKey !== item.subject.revisionKey ||
    (value.availability === "available"
      ? !snapshot || !value.snapshotRef
      : snapshot !== null || value.snapshotRef !== null) ||
    (snapshot &&
      (snapshot.workItemId !== item.id ||
        snapshot.repositoryId !== item.repositoryId ||
        snapshot.subjectRef !== item.subject.id ||
        snapshot.subjectRevisionKey !== item.subject.revisionKey))
  ) {
    throw new Error(
      "The saved discussion does not match this source revision. Refresh the source before continuing.",
    );
  }
}

export function filterWorkItems(
  items: readonly WorkItem[],
  tasks: readonly InvestigationTaskV1[],
  filter: {
    search: string;
    state: string;
    investigation: InvestigationFilter;
  },
): WorkItem[] {
  const search = filter.search
    .trim()
    .toLowerCase()
    .replace(/^#(?=\d)/u, "");
  return items
    .filter(
      (item) =>
        (!search ||
          item.title.toLowerCase().includes(search) ||
          String(item.number).includes(search)) &&
        (filter.state === "all" || item.state === filter.state) &&
        (filter.investigation === "all" ||
          workItemInvestigationState(currentWorkItemTask(item, tasks)) === filter.investigation),
    )
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    );
}
