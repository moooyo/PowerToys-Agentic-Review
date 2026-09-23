import type {
  ActionContextV1,
  InvestigationReportHeaderV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { investigationApi, type WorkItem } from "./api";
import { reportOutcome } from "./outcome-summary";
import { sessionIdentity, useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";
import { relatedWorkItemTasks, taskReportMatches } from "./work-item-state";

export const sourceAccessDenied = (error: unknown) =>
  error instanceof InvestigationHttpError && [401, 403, 404].includes(error.status);

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

export function SourceResultLabel({ item, task }: { item: WorkItem; task?: InvestigationTaskV1 }) {
  const query = useSourceReport(item, task);
  const header = readableSourceReport(item, task, query.data, query.error);
  const outcome = header ? reportOutcome(header) : null;
  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
      <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
        {outcome?.label ??
          (!task?.latestReportRef
            ? "No saved conclusion"
            : query.isError
              ? "Conclusion unavailable"
              : "Loading conclusion…")}
      </Typography>
      {outcome && (
        <Typography variant="caption" color="text.secondary">
          {outcome.validation.label}
        </Typography>
      )}
      {query.isError && query.data && !sourceAccessDenied(query.error) && (
        <Typography variant="caption" color="text.secondary">
          Saved result · refresh unavailable
        </Typography>
      )}
    </Stack>
  );
}
