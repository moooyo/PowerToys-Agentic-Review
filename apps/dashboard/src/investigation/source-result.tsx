import type {
  ActionContextV1,
  InvestigationActionKind,
  InvestigationReportHeaderV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { Chip, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { investigationApi, type WorkItem } from "./api";
import { reportOutcome } from "./outcome-summary";
import { assertActionContext } from "./report-state";
import type { ReviewRecord } from "./review-navigation-state";
import { sessionIdentity, useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";
import { relatedWorkItemTasks, taskReportMatches, taskUrl } from "./work-item-state";

export const sourceAccessDenied = (error: unknown) =>
  error instanceof InvestigationHttpError && [401, 403, 404].includes(error.status);

export function sourceTaskReviewRecord(
  source: WorkItem,
  task: InvestigationTaskV1,
): ReviewRecord | undefined {
  if (
    task.workItem.id !== source.id ||
    task.repository.id !== source.repositoryId ||
    task.workItem.kind !== source.kind ||
    task.workItem.number !== source.number
  )
    return undefined;
  return {
    kind: "task",
    id: task.id,
    workItemId: task.workItem.id,
    repositoryId: task.repository.id,
    href: taskUrl(task),
    label: task.workItem.title,
  };
}

export function readableSourceData<T>(data: T | undefined, error: unknown): T | undefined {
  return sourceAccessDenied(error) ? undefined : data;
}

export function readableSourceReport(
  item: WorkItem | undefined,
  task: InvestigationTaskV1 | undefined,
  header: InvestigationReportHeaderV1 | undefined,
  error: unknown,
): InvestigationReportHeaderV1 | undefined {
  return item &&
    task &&
    header &&
    !sourceAccessDenied(error) &&
    taskReportMatches(item, task, header)
    ? header
    : undefined;
}

export function sourceActionKey(
  identity: string,
  source: WorkItem,
  header: InvestigationReportHeaderV1,
) {
  return [
    "investigation-source-actions",
    identity,
    source.repositoryId,
    source.id,
    source.kind,
    source.state,
    source.subject.revisionKey,
    source.subject.kind === "original_pr" ? source.subject.headSha : null,
    header.report.id,
    header.report.version,
    header.report.logicalContentDigest,
  ] as const;
}

export function sourceActionContextMatches(
  source: WorkItem,
  header: InvestigationReportHeaderV1,
  context: ActionContextV1,
  actorId: string | undefined,
): boolean {
  return (
    !!actorId &&
    context.actor.id === actorId &&
    context.workItemId === source.id &&
    context.repositoryId === source.repositoryId &&
    context.target.kind === source.kind &&
    context.target.state === source.state &&
    context.target.revisionKey === source.subject.revisionKey &&
    context.target.headSha ===
      (source.subject.kind === "original_pr" ? source.subject.headSha : null) &&
    header.context.repository.id === source.repositoryId &&
    header.context.workItem.id === source.id &&
    header.context.workItem.kind === source.kind &&
    header.context.workItem.number === source.number &&
    context.reportRef?.id === header.report.id &&
    context.reportRef.version === header.report.version &&
    context.reportRef.digest === header.report.logicalContentDigest
  );
}

export function activeSourceReportTask(
  source: WorkItem,
  header: InvestigationReportHeaderV1 | undefined,
  tasks: readonly InvestigationTaskV1[],
): InvestigationTaskV1 | undefined {
  if (
    !header ||
    header.context.repository.id !== source.repositoryId ||
    header.context.workItem.id !== source.id ||
    header.context.workItem.kind !== source.kind ||
    header.context.workItem.number !== source.number
  )
    return undefined;
  return relatedWorkItemTasks(source, tasks).find(
    (task) =>
      ["queued", "running"].includes(task.state) &&
      task.parentTaskId === header.context.task.id &&
      task.parentReportRef?.id === header.report.id &&
      task.parentReportRef.version === header.report.version &&
      task.parentReportRef.digest === header.report.logicalContentDigest,
  );
}

export function sourceReportKey(identity: string, sourceId?: string, task?: InvestigationTaskV1) {
  return [
    "investigation-source-report",
    identity,
    sourceId,
    task?.id,
    task?.latestReportRef?.id,
    task?.latestReportRef?.version,
    task?.latestReportRef?.digest,
  ] as const;
}

export function useSourceReport(item: WorkItem | undefined, task: InvestigationTaskV1 | undefined) {
  const { session } = useInvestigationSession();
  const readable = Boolean(
    session.authenticated && item && session.user.repositoryIds.includes(item.repositoryId),
  );
  return useQuery({
    queryKey: sourceReportKey(sessionIdentity(session), item?.id, task),
    queryFn: async () => {
      if (!readable)
        throw new InvestigationHttpError(
          403,
          "Source report access is unavailable for the current account.",
        );
      if (!item || !task?.latestReportRef) throw new Error("No saved source report is available.");
      const header = await investigationApi.report(task.latestReportRef.id);
      if (!taskReportMatches(item, task, header))
        throw new Error("The saved report does not match this source and investigation.");
      return header;
    },
    enabled: readable && Boolean(task?.latestReportRef),
    // A sealed report is immutable; a new version/digest gets a different cache entry.
    staleTime: Infinity,
  });
}

export function sourceActionLabel(
  action: InvestigationActionKind,
  taskKind?: ActionContextV1["nextActions"][number]["taskKind"],
): string {
  const taskLabels: Record<
    NonNullable<ActionContextV1["nextActions"][number]["taskKind"]>,
    string
  > = {
    "pr-review": "Review PR",
    "issue-investigate": "Investigate issue",
    "pr-e2e": "Run E2E",
    "pr-verify": "Verify PR",
    "issue-verify": "Verify issue",
    "reproduction-setup": "Set up reproduction",
    "issue-fix": "Fix issue",
    "feature-implement": "Implement feature",
  };
  const labels: Record<InvestigationActionKind, string> = {
    comment: "Comment",
    approve: "Approve",
    "request-changes": "Request changes",
    "suggestion-comment": "Suggest code",
    close: "Close",
    merge: "Merge",
    "trigger-ci": "Run CI",
    "close-as-duplicate": "Close as duplicate",
    "reviews.verify": "Verify PR",
    "view-validation": "View validation",
    "view-changes": "View changes",
    "view-evidence": "View evidence",
    "create-pr": "Create pull request",
    resume: "Resume task",
    "start-task": taskKind ? taskLabels[taskKind] : "Start linked task",
  };
  return labels[action];
}

export function sourceActionReason(
  context: ActionContextV1,
  action: InvestigationActionKind,
): string {
  const saved = context.nextActions.find(
    (value) => value.id === context.recommendedActionId && value.action === action,
  );
  const available = saved ?? context.fixedActions.find((value) => value.action === action);
  return (
    available?.guards
      .filter((guard) => !guard.satisfied)
      .map((guard) => guard.message)
      .join(" ") ||
    available?.reason ||
    "Action unavailable."
  );
}

/** Fetch live availability for a report-bound action, including unresolved submissions. */
export function useSourceActionContext(
  source: WorkItem,
  header: InvestigationReportHeaderV1 | undefined,
) {
  const { session } = useInvestigationSession();
  const readable =
    session.authenticated && session.user.repositoryIds.includes(source.repositoryId);
  const query = useQuery({
    queryKey: header
      ? sourceActionKey(sessionIdentity(session), source, header)
      : ["investigation-source-actions", sessionIdentity(session), source.id, "no-report"],
    enabled: Boolean(header && readable),
    queryFn: async () => {
      if (!header) throw new Error("No saved report is available.");
      const context = await investigationApi.actionContext(source.id, header.report.id);
      assertActionContext(header, context);
      if (!sourceActionContextMatches(source, header, context, session.user?.id))
        throw new Error("Action availability changed. Refresh the source.");
      return context;
    },
  });
  const context =
    readable &&
    header &&
    query.data &&
    !sourceAccessDenied(query.error) &&
    sourceActionContextMatches(source, header, query.data, session.user?.id)
      ? query.data
      : undefined;
  return { query, context };
}

export function SourceResultLabel({ item, task }: { item: WorkItem; task?: InvestigationTaskV1 }) {
  const query = useSourceReport(item, task);
  const header = readableSourceReport(item, task, query.data, query.error);
  const outcome = header ? reportOutcome(header) : null;
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{ minWidth: 0, flexWrap: "wrap", alignItems: "center" }}
    >
      {item.kind === "issue" && header && ["bug", "feature"].includes(header.assessment.kind) && (
        <Chip
          size="small"
          label={header.assessment.kind === "bug" ? "Bug" : "Feature"}
          variant="outlined"
          sx={{ height: 24, fontSize: 12 }}
        />
      )}
      <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
        {outcome?.label ??
          (!task?.latestReportRef
            ? "No saved conclusion"
            : query.isError
              ? "Conclusion unavailable"
              : "Loading conclusion…")}
      </Typography>
      {outcome && !["feature", "other_issue"].includes(header!.assessment.kind) && (
        <Chip
          size="small"
          label={outcome.validation.label}
          variant="outlined"
          sx={{ fontSize: 12, height: 24 }}
        />
      )}
      {query.isError && query.data && !sourceAccessDenied(query.error) && (
        <Typography variant="caption" color="text.secondary">
          Saved result · refresh unavailable
        </Typography>
      )}
    </Stack>
  );
}
