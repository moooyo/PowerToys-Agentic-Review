import {
  type InvestigationReportHeaderV1,
  type InvestigationResourceLease,
  type InvestigationTaskV1,
  type InvestigationUsageSummary,
  projectInvestigationCheckpointPresentation,
} from "@agentic-review/contracts";
import AddRounded from "@mui/icons-material/AddRounded";
import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Pagination,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { investigationApi } from "./api";
import {
  CommentStatus,
  commentDetailsUrl,
  commentPollingInterval,
  commentSummariesQueryKey,
  TaskComments,
} from "./comment-deliveries";
import { GithubSourceLink } from "./github-source-link";
import { useUnsavedChanges } from "./navigation-guard";
import { reportOutcome } from "./outcome-summary";
import { Section, SubjectPanel, TextList } from "./report-sections";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { ResumeTaskButton } from "./resume-task";
import { ReviewQueueBar, type ReviewRecord, useReviewListNavigation } from "./review-navigation";
import { schedulerQueryKey } from "./scheduler-panel";
import { sessionIdentity, useInvestigationSession } from "./session";
import { StartInvestigationButton } from "./start-investigation";
import { TaskEvidencePanel } from "./task-evidence";
import { outputAccessDenied, TaskOutputPanel } from "./task-output";
import {
  latestAttemptInvocation,
  normalizeTaskOutputView,
  orderedTaskAttempts,
  selectedTaskAttempt,
} from "./task-output-state";
import { TaskProgressPanel } from "./task-progress";
import { TokenUsagePanel, UsageSummaryLabel } from "./usage-panel";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";
import "./task-workspace.css";

export { StartInvestigationButton } from "./start-investigation";

export function taskMode(kind: InvestigationTaskV1["kind"]): string {
  return kind === "pr-review" || kind === "issue-investigate"
    ? "Static"
    : kind === "pr-e2e"
      ? "E2E"
      : "Execution";
}

const taskKindLabels: Record<InvestigationTaskV1["kind"], string> = {
  "pr-review": "Pull request review",
  "issue-investigate": "Issue investigation",
  "pr-e2e": "E2E check",
  "pr-verify": "Pull request verification",
  "issue-verify": "Issue verification",
  "reproduction-setup": "Reproduction setup",
  "issue-fix": "Issue fix",
  "feature-implement": "Feature implementation",
};

export function taskCleanupPending(
  task: Pick<InvestigationTaskV1, "id" | "state">,
  leases: readonly InvestigationResourceLease[] = [],
): boolean {
  return leases.some(
    (lease) =>
      lease.taskId === task.id &&
      lease.state !== "released" &&
      (lease.state === "needs_cleanup" || !["queued", "running"].includes(task.state)),
  );
}

export function taskIsActive(
  task: Pick<InvestigationTaskV1, "id" | "state">,
  leases: readonly InvestigationResourceLease[] = [],
): boolean {
  return ["queued", "running"].includes(task.state) || taskCleanupPending(task, leases);
}

export function taskReportMatches(
  task: InvestigationTaskV1,
  header: InvestigationReportHeaderV1 | null | undefined,
): header is InvestigationReportHeaderV1 {
  const ref = task.latestReportRef;
  return (
    !!header &&
    !!ref &&
    header.context.task.id === task.id &&
    header.context.task.kind === task.kind &&
    header.context.repository.id === task.repository.id &&
    header.context.repository.fullName === task.repository.fullName &&
    header.context.workItem.id === task.workItem.id &&
    header.context.workItem.kind === task.workItem.kind &&
    header.context.workItem.number === task.workItem.number &&
    header.report.id === ref.id &&
    header.report.version === ref.version &&
    header.report.logicalContentDigest === ref.digest
  );
}

const taskReviewRecord = (task: InvestigationTaskV1): ReviewRecord => ({
  kind: "task",
  id: task.id,
  workItemId: task.workItem.id,
  repositoryId: task.repository.id,
  href: `/tasks?taskId=${encodeURIComponent(task.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`,
  label: task.workItem.title,
});

export function TaskList({
  tasks,
  usageByTaskId,
  resourceLeases,
  page,
  onPageChange,
}: {
  tasks: InvestigationTaskV1[];
  usageByTaskId?: Record<string, InvestigationUsageSummary>;
  resourceLeases?: readonly InvestigationResourceLease[];
  page?: number;
  onPageChange?: (page: number) => void;
}) {
  const { session } = useInvestigationSession();
  const records = useMemo(() => tasks.map(taskReviewRecord), [tasks]);
  const listNavigation = useReviewListNavigation({ label: "Tasks", records, complete: true });
  const [localPage, setLocalPage] = useState(1);
  const pageSize = 10;
  const currentPage = Math.min(
    Math.max(1, page ?? localPage),
    Math.max(1, Math.ceil(tasks.length / pageSize)),
  );
  const visibleTasks = tasks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const usageWorkItemId =
    visibleTasks.length > 0 &&
    visibleTasks.every((task) => task.workItem.id === visibleTasks[0]?.workItem.id)
      ? visibleTasks[0]?.workItem.id
      : undefined;
  const usageQuery = useQuery({
    queryKey: ["investigation-tasks", usageWorkItemId ?? "all-usage", sessionIdentity(session)],
    queryFn: ({ signal }) => investigationApi.tasks(usageWorkItemId, signal),
    enabled: usageByTaskId === undefined && visibleTasks.length > 0,
    refetchInterval: (current) =>
      current.state.data?.items.some((task) => ["queued", "running"].includes(task.state)) ||
      Object.values(current.state.data?.usageByTaskId ?? {}).some(
        (usage) => usage.activeInvocationCount > 0,
      )
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
  });
  const usage = usageByTaskId ?? usageQuery.data?.usageByTaskId;
  const summaryInput = { taskIds: visibleTasks.map((task) => task.id).sort() };
  const comments = useQuery({
    queryKey: [...commentSummariesQueryKey(summaryInput), sessionIdentity(session)],
    queryFn: () => investigationApi.comments(summaryInput),
    enabled: visibleTasks.length > 0,
    refetchInterval: (current) =>
      commentPollingInterval(current.state.data?.items ?? []) ||
      (visibleTasks.some((task) => ["queued", "running"].includes(task.state)) ? 5_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  if (!tasks.length)
    return (
      <EmptyState
        title="No investigation tasks yet"
        description="Choose a pull request or issue to start an investigation."
      />
    );
  return (
    <Surface sx={{ border: 1, borderColor: "divider", overflow: "hidden" }}>
      <Box
        className="production-task-list-heading"
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Typography variant="body2" color="text.secondary">
          {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Action
        </Typography>
      </Box>
      <Box component="ul" aria-label="Investigation tasks" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {visibleTasks.map((task) => {
          const cleanupPending = taskCleanupPending(task, resourceLeases);
          const comment = comments.data?.items
            .filter((item) => item.taskId === task.id || item.associatedTaskIds?.includes(task.id))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
          const record = taskReviewRecord(task);
          const tone = cleanupPending
            ? "warning"
            : task.state === "failed"
              ? "error"
              : task.state === "completed"
                ? "success"
                : ["blocked", "interrupted"].includes(task.state)
                  ? "warning"
                  : task.state === "running"
                    ? "primary"
                    : "default";
          const reportAction =
            !cleanupPending && task.state === "completed" && task.latestReportRef;
          const nextAction = cleanupPending
            ? "View cleanup"
            : reportAction
              ? "Review report"
              : "View output";
          const nextRecord: ReviewRecord = reportAction
            ? {
                ...record,
                kind: "report",
                id: reportAction.id,
                href: `/reports?reportId=${encodeURIComponent(reportAction.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`,
              }
            : { ...record, href: `${record.href}${cleanupPending ? "&tab=details" : ""}` };
          return (
            <Box
              component="li"
              key={task.id}
              className="production-task-row"
              sx={{ borderBottom: 1, borderColor: "divider", "&:last-child": { borderBottom: 0 } }}
            >
              <Box className="production-task-row-main" sx={{ minWidth: 0 }}>
                <Typography
                  component={Link}
                  {...listNavigation.getLinkProps(record)}
                  className="production-task-title"
                  sx={{ color: "text.primary", fontWeight: 500 }}
                >
                  {task.workItem.title}
                </Typography>
                <Box className="production-task-row-meta">
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ overflowWrap: "anywhere" }}
                  >
                    {task.workItem.kind === "issue" ? "Issue" : "PR"} #{task.workItem.number} ·{" "}
                    {taskMode(task.kind)} · {task.repository.fullName}
                  </Typography>
                  <Chip
                    size="small"
                    label={
                      cleanupPending
                        ? `${task.state} · awaiting cleanup`
                        : task.state === "running"
                          ? "In progress"
                          : task.state === "completed"
                            ? "Completed"
                            : task.state
                    }
                    color={tone}
                    sx={{ height: 24, fontSize: 12, borderRadius: "6px" }}
                  />
                  <UsageSummaryLabel summary={usage?.[task.id]} compact />
                  {comment ? (
                    <Button
                      size="small"
                      component={Link}
                      to={commentDetailsUrl(comment.id, comment.repositoryId)}
                      className="production-task-inline-action"
                    >
                      <CommentStatus comment={comment} />
                    </Button>
                  ) : comments.isError ? (
                    <Typography variant="caption" color="text.secondary">
                      Comment status unavailable
                    </Typography>
                  ) : null}
                </Box>
              </Box>
              <Button
                className="production-task-next"
                variant="outlined"
                size="small"
                component={Link}
                {...listNavigation.getRelatedLinkProps(record, nextRecord)}
                endIcon={<ChevronRightRounded />}
                aria-label={`${nextAction}: ${task.workItem.title}`}
              >
                {nextAction}
              </Button>
            </Box>
          );
        })}
      </Box>
      {tasks.length > pageSize && (
        <Box
          sx={{
            px: { xs: 2, sm: 3 },
            py: 1.5,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, tasks.length)} of{" "}
            {tasks.length} tasks
          </Typography>
          {tasks.length > pageSize && (
            <Pagination
              size="small"
              count={Math.ceil(tasks.length / pageSize)}
              page={currentPage}
              onChange={(_, next) => (onPageChange ? onPageChange(next) : setLocalPage(next))}
              aria-label="Task pages"
            />
          )}
        </Box>
      )}
    </Surface>
  );
}
export function taskDetailTab(value: string | null): "progress" | "evidence" | "details" {
  return value === "evidence"
    ? "evidence"
    : ["details", "usage", "comments", "activity"].includes(value ?? "")
      ? "details"
      : "progress";
}

export function taskDetailQueryKey(identity: string, taskId: string) {
  return ["investigation-task", taskId, identity] as const;
}

export function TaskDetails({ taskId }: { taskId: string }) {
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  return (
    <TaskDetailsReader
      key={JSON.stringify([taskId, identity])}
      taskId={taskId}
      identity={identity}
    />
  );
}

function TaskDetailsReader({ taskId, identity }: { taskId: string; identity: string }) {
  const usageAccordionId = useId();
  const { session } = useInvestigationSession();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const parameters = new URLSearchParams(location.search);
  const tab = taskDetailTab(parameters.get("tab"));
  const query = useQuery({
    queryKey: taskDetailQueryKey(identity, taskId),
    queryFn: ({ signal }) => investigationApi.task(taskId, signal),
    enabled: session.authenticated,
    refetchInterval: (current) =>
      !outputAccessDenied(current.state.error) &&
      current.state.data &&
      (["queued", "running"].includes(current.state.data.task.state) ||
        (current.state.data.usage?.activeInvocationCount ?? 0) > 0 ||
        current.state.data.resourceLeases?.some((lease) => lease.state !== "released"))
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
  });
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [error, setError] = useState<string>();
  useUnsavedChanges(false, { busy });
  const scheduler = useQuery({
    queryKey: [...schedulerQueryKey, identity],
    queryFn: investigationApi.scheduler,
    enabled: query.data?.task.state === "queued",
    refetchInterval: query.data?.task.state === "queued" ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  if (!session.authenticated) return <Alert severity="warning">Sign in to read this task.</Alert>;
  if (query.isPending) return <CircularProgress size={28} aria-label="Loading task" />;
  if (query.isError && (!query.data || outputAccessDenied(query.error)))
    return (
      <Alert severity="error">
        {query.error.message}
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </Alert>
    );
  if (!query.data) return <Alert severity="warning">No task snapshot is available.</Alert>;
  const { task, usage, resourceLeases } = query.data;
  if (
    task.id !== taskId ||
    !session.user.repositoryIds.includes(task.repository.id) ||
    (parameters.get("repositoryId") && parameters.get("repositoryId") !== task.repository.id)
  )
    return (
      <Alert severity="warning">This task is unavailable in the current repository scope.</Alert>
    );
  const attempts = orderedTaskAttempts(task.id, query.data.attempts);
  const checkpoint = query.data.checkpoint?.taskId === task.id ? query.data.checkpoint : null;
  const checkpointMismatch = !!query.data.checkpoint && !checkpoint;
  const invocations = query.data.invocations?.filter(
    (call) => call.taskId === task.id && attempts.some((attempt) => attempt.id === call.attemptId),
  );
  const currentAttempt = attempts[0];
  const latestReport = taskReportMatches(task, query.data.latestReport)
    ? query.data.latestReport
    : null;
  const children = query.data.children.filter(
    (child) =>
      child.parentTaskId === task.id &&
      child.repository.id === task.repository.id &&
      child.workItem.id === task.workItem.id &&
      child.workItem.kind === task.workItem.kind &&
      child.workItem.number === task.workItem.number,
  );
  const requestedAttempt = parameters.get("attemptId");
  const selectedAttempt = selectedTaskAttempt(task.id, attempts, requestedAttempt);
  const attemptId = selectedAttempt?.id;
  const call = latestAttemptInvocation(invocations, attemptId);
  const active = ["queued", "running"].includes(task.state);
  const recoverable = ["blocked", "failed", "cancelled", "interrupted"].includes(task.state);
  const cleanup = taskCleanupPending(task, resourceLeases);
  const fresh = !query.isError;
  const canCancel = session.user?.permissions.includes("task:cancel") === true;
  const canResume =
    session.user?.permissions.includes("task:create") === true &&
    (task.executionPolicy.mode !== "execute" || session.user.allowRepositoryExecution) &&
    !checkpointMismatch;
  const stopReason = currentAttempt?.terminationReason ?? checkpoint?.stopReason;
  const outputView = normalizeTaskOutputView({
    search: parameters.get("outputSearch"),
    type: parameters.get("outputType"),
  });
  const updateRoute = (
    next: { tab?: string; attemptId?: string; outputSearch?: string; outputType?: string },
    replace = false,
  ) => {
    const search = new URLSearchParams(location.search);
    search.set("taskId", task.id);
    if (next.tab) search.set("tab", next.tab);
    if (next.attemptId !== undefined) {
      if (next.attemptId) search.set("attemptId", next.attemptId);
      else search.delete("attemptId");
    }
    if (next.outputSearch !== undefined || next.outputType !== undefined) {
      const view = normalizeTaskOutputView({
        search: next.outputSearch ?? outputView.search,
        type: next.outputType ?? outputView.type,
      });
      if (view.search) search.set("outputSearch", view.search);
      else search.delete("outputSearch");
      if (view.type !== "all") search.set("outputType", view.type);
      else search.delete("outputType");
    }
    search.set("repositoryId", task.repository.id);
    navigate(`${location.pathname}?${search.toString()}`, { replace, state: location.state });
  };
  const taskUrl = (id: string) =>
    `/tasks?taskId=${encodeURIComponent(id)}&repositoryId=${encodeURIComponent(task.repository.id)}`;
  const cancelTask = async () => {
    if (!canCancel || busy || !fresh) return;
    setBusy(true);
    setError(undefined);
    try {
      await investigationApi.cancelTask(task.id);
      await query.refetch();
      await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
      setCancelOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The task state could not be updated.");
    } finally {
      setBusy(false);
    }
  };
  const runFields = [
    [
      "Selected output",
      selectedAttempt
        ? `Attempt ${selectedAttempt.number} · ${selectedAttempt.id === currentAttempt?.id ? "latest" : "historical"}`
        : "No attempt recorded",
    ],
    ["Agent", call ? (call.engine === "copilot" ? "Copilot CLI" : "Codex CLI") : "Not started"],
    ["Requested model", call ? (call.model ?? "CLI default") : "Not started"],
    ["Reasoning effort", "Not recorded"],
    ["Worker", selectedAttempt?.workerId ?? "Awaiting assignment"],
    ["Task", task.id],
    ["Task kind", task.kind],
    [
      "Started",
      selectedAttempt?.startedAt
        ? new Date(selectedAttempt.startedAt).toLocaleString()
        : "Not started",
    ],
    ["Task model calls", String(usage?.invocationCount ?? "Not recorded")],
    ["Execution mode", task.executionPolicy.mode],
    [
      "Execution authorization",
      task.executionPolicy.authorizationRef ?? "No execution grant recorded",
    ],
    ["Profile", `${task.profileRef.id} · v${task.profileRef.version}`],
    ["Prompt", `${task.promptRef.id} · v${task.promptRef.version}`],
  ];
  return (
    <Stack
      spacing={1.5}
      className="production-task-detail"
      sx={{ "& > .workspace-page-heading > .MuiBox-root:last-child": { mt: 1 } }}
    >
      <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center" }}>
        <ReviewQueueBar
          record={{
            kind: "task",
            id: task.id,
            workItemId: task.workItem.id,
            repositoryId: task.repository.id,
            href: taskUrl(task.id),
            label: task.workItem.title,
          }}
          fallbackTo={`/tasks?repositoryId=${encodeURIComponent(task.repository.id)}`}
          fallbackLabel="All tasks"
        />
      </Stack>
      <PageHeading
        title={task.workItem.title}
        action={
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {active && (
              <Button
                color="error"
                disabled={!canCancel || busy || !fresh}
                onClick={() => setCancelOpen(true)}
              >
                Cancel task
              </Button>
            )}
            {recoverable && (
              <ResumeTaskButton
                task={task}
                checkpoint={checkpoint}
                disabled={busy || !canResume || !!cleanup || !fresh}
                disabledReason={
                  !fresh
                    ? "Refresh the retained task snapshot before resuming."
                    : checkpointMismatch
                      ? "The returned checkpoint does not belong to this task. Reload its saved state before recovery."
                      : cleanup
                        ? "Wait for the worker cleanup receipt before starting another attempt."
                        : !canResume
                          ? "Recovery requires Create tasks access and an execution grant for execution tasks."
                          : undefined
                }
                onResumed={async () => {
                  await query.refetch();
                  await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
                  updateRoute({ tab: "progress", attemptId: "" });
                }}
              />
            )}
          </Stack>
        }
      >
        <Stack
          direction="row"
          spacing={1.5}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Button
            size="small"
            component={Link}
            to={`/${task.workItem.kind === "issue" ? "issues" : "pull-requests"}?workItemId=${encodeURIComponent(task.workItem.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`}
            sx={{ p: 0 }}
          >
            {task.workItem.kind === "issue" ? "Issue" : "Pull request"} #{task.workItem.number}
          </Button>
          <Typography variant="body2" color="text.secondary">
            {taskKindLabels[task.kind]} · {task.repository.fullName}
          </Typography>
          <GithubSourceLink
            repositoryFullName={task.repository.fullName}
            kind={task.workItem.kind}
            number={task.workItem.number}
          />
        </Stack>
      </PageHeading>
      {query.isError && (
        <Alert
          severity="warning"
          action={
            <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
              Retry refresh
            </Button>
          }
        >
          Refresh failed. Showing saved task data; refresh before cancelling or resuming.
        </Alert>
      )}
      <Box className="production-task-statusline" aria-label="Task status and saved report">
        <Box className="production-task-execution">
          <Chip
            size="small"
            label={
              cleanup
                ? `${task.state} · awaiting cleanup`
                : task.state === "running"
                  ? "In progress"
                  : task.state === "completed"
                    ? "Completed"
                    : task.state
            }
            color={
              cleanup
                ? "warning"
                : task.state === "failed"
                  ? "error"
                  : task.state === "completed"
                    ? "success"
                    : task.state === "blocked"
                      ? "warning"
                      : "default"
            }
          />
          <TaskProgressPanel
            task={task}
            progress={query.data.progress}
            scheduler={scheduler.data}
            resourceLeases={resourceLeases}
            invocations={invocations}
            compact
          />
        </Box>
        {latestReport && (
          <Box className="production-task-saved-report">
            <Typography variant="body2" color="text.secondary">
              {latestReport.report.delivery === "checkpoint" ? "Checkpoint" : "Report"} ·{" "}
              {reportOutcome(latestReport).label}
            </Typography>
            <Button
              size="small"
              variant={task.state === "completed" && !cleanup ? "contained" : "text"}
              component={Link}
              to={`/reports?reportId=${encodeURIComponent(latestReport.report.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`}
            >
              Read report
            </Button>
          </Box>
        )}
      </Box>
      {!latestReport && (query.data.latestReport || task.latestReportRef) && (
        <Alert severity="warning">
          {query.data.latestReport
            ? "The saved report does not match this task. Refresh to reload it."
            : "The saved report is unavailable. Refresh to load it."}
          <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
            Refresh
          </Button>
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {checkpointMismatch && (
        <Alert severity="warning">
          The returned checkpoint does not belong to this task. It is hidden and recovery is
          unavailable until the saved state is reloaded.
        </Alert>
      )}
      {recoverable && stopReason && (
        <Alert severity={task.state === "failed" ? "error" : "warning"}>
          {task.state === "blocked" ? "Task blocked" : "Why this task stopped"}: {stopReason}
          {task.state === "blocked" && task.kind === "pr-e2e" && !checkpoint?.runtime.e2e && (
            <Typography variant="body2">
              No final E2E feature results were recorded. Resolve the prerequisite before
              restarting.
            </Typography>
          )}
        </Alert>
      )}
      {cleanup && (
        <Alert
          severity="warning"
          action={<Button onClick={() => void query.refetch()}>Refresh receipt</Button>}
        >
          Awaiting worker cleanup. Resources remain reserved until cleanup is confirmed.
        </Alert>
      )}
      {task.parentTaskId && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Button component={Link} to={taskUrl(task.parentTaskId)}>
            Parent task
          </Button>
          {task.parentReportRef && (
            <Button
              component={Link}
              to={`/reports?reportId=${encodeURIComponent(task.parentReportRef.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`}
            >
              Parent report v{task.parentReportRef.version}
            </Button>
          )}
        </Stack>
      )}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          borderBottom: 1,
          borderColor: "divider",
          minWidth: 0,
        }}
      >
        <Tabs
          value={tab}
          onChange={(_, value: string) => updateRoute({ tab: value })}
          aria-label="Task detail"
          sx={{
            flex: 1,
            minWidth: 0,
            "& .MuiTab-root": { minWidth: { xs: 0, sm: 90 }, px: { xs: 1, sm: 2 } },
          }}
        >
          <Tab
            value="progress"
            label="Output"
            id="task-progress-tab"
            aria-controls="task-progress-panel"
          />
          <Tab
            value="evidence"
            label="Files"
            id="task-evidence-tab"
            aria-controls="task-evidence-panel"
          />
          <Tab
            value="details"
            label="Details"
            id="task-details-tab"
            aria-controls="task-details-panel"
          />
        </Tabs>
        <Button
          aria-label="Refresh task status"
          sx={{ minWidth: 44, px: 1 }}
          disabled={query.isFetching || busy}
          onClick={() => void query.refetch()}
        >
          <RefreshRounded />
        </Button>
      </Box>
      {((active && !canCancel) || (recoverable && !canResume)) && (
        <Typography variant="caption" color="text.secondary">
          {active && !canCancel
            ? "Cancel tasks permission required."
            : "Recovery requires Create tasks access and an execution grant for execution tasks."}
        </Typography>
      )}
      {tab === "progress" && (
        <Stack
          role="tabpanel"
          id="task-progress-panel"
          aria-labelledby="task-progress-tab"
          spacing={2.5}
        >
          <TaskOutputPanel
            task={task}
            attempts={attempts}
            attemptId={attemptId}
            onAttemptChange={(id) => updateRoute({ attemptId: id })}
            onHistory={() => updateRoute({ tab: "details" })}
            view={outputView}
            onViewChange={(view) =>
              updateRoute({ outputSearch: view.search, outputType: view.type }, true)
            }
            summary={usage}
            invocations={invocations}
          />
          {checkpoint && recoverable && (
            <Typography variant="body2" color="text.secondary">
              {projectInvestigationCheckpointPresentation(task, checkpoint).summary}
            </Typography>
          )}
          {requestedAttempt && requestedAttempt !== attemptId && (
            <Alert severity="warning">
              The requested attempt is not available for this task. Showing the latest retained
              attempt.
            </Alert>
          )}
          {children.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Related tasks
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                {children.map((child) => (
                  <Button key={child.id} component={Link} to={taskUrl(child.id)} variant="outlined">
                    {taskMode(child.kind)} · {child.state}
                  </Button>
                ))}
              </Stack>
            </Box>
          )}
        </Stack>
      )}
      {tab === "evidence" && (
        <Box role="tabpanel" id="task-evidence-panel" aria-labelledby="task-evidence-tab">
          <TaskEvidencePanel task={task} checkpoint={checkpoint} active={active} />
        </Box>
      )}
      {tab === "details" && (
        <Stack
          role="tabpanel"
          id="task-details-panel"
          aria-labelledby="task-details-tab"
          spacing={0}
          className="production-task-details-grid"
        >
          <Section title="Run details">
            <Box
              component="dl"
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "140px minmax(0, 1fr)" },
                gap: 1,
                m: 0,
              }}
            >
              {runFields.map(([label, value]) => (
                <Box key={label} sx={{ display: "contents" }}>
                  <Typography component="dt" variant="body2" color="text.secondary">
                    {label}
                  </Typography>
                  <Typography
                    component="dd"
                    variant="body2"
                    sx={{ m: 0, mb: { xs: 1, sm: 0 }, overflowWrap: "anywhere" }}
                  >
                    {value}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Section>
          <Section title="Attempts">
            <Stack spacing={1}>
              {[...attempts]
                .sort((a, b) => b.number - a.number)
                .map((attempt) => (
                  <Box key={attempt.id} className="production-task-attempt">
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle2">
                        Attempt {attempt.number} · {attempt.state}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ overflowWrap: "anywhere" }}
                      >
                        {attempt.workerId ?? "Waiting for worker"} ·{" "}
                        {attempt.startedAt
                          ? new Date(attempt.startedAt).toLocaleString()
                          : "Not started"}
                      </Typography>
                      {attempt.terminationReason && (
                        <Typography variant="body2">{attempt.terminationReason}</Typography>
                      )}
                    </Box>
                    <Button
                      size="small"
                      aria-label={`View attempt ${attempt.number} output`}
                      onClick={() =>
                        updateRoute({
                          tab: "progress",
                          attemptId: attempt.id === currentAttempt?.id ? "" : attempt.id,
                        })
                      }
                    >
                      Output
                    </Button>
                  </Box>
                ))}
              {resourceLeases
                ?.filter((lease) => lease.taskId === task.id)
                .map((lease) => (
                  <Alert
                    key={lease.attemptId}
                    severity={lease.state === "needs_cleanup" ? "warning" : "info"}
                  >
                    {lease.pool === "e2e" ? "E2E desktop" : "Static capacity"}:{" "}
                    {lease.state === "released"
                      ? "Ownership released by a cleanup receipt."
                      : lease.state === "needs_cleanup"
                        ? "Needs cleanup confirmation."
                        : "Reserved by this attempt."}
                    <Typography variant="caption" component="div">
                      Attempt {lease.attemptId} · {new Date(lease.updatedAt).toLocaleString()}
                      {lease.reason ? ` · ${lease.reason}` : ""}
                    </Typography>
                  </Alert>
                ))}
            </Stack>
          </Section>
          <Accordion
            disableGutters
            elevation={0}
            defaultExpanded={parameters.get("tab") === "usage"}
          >
            <AccordionSummary
              id={`${usageAccordionId}-summary`}
              aria-controls={`${usageAccordionId}-region`}
              expandIcon={<ExpandMoreRounded />}
            >
              <Typography>Usage and budgets</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2}>
                <Box
                  component="dl"
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
                    gap: 2,
                    m: 0,
                  }}
                >
                  {[
                    ["Token budget", task.budget.maxTokens.toLocaleString("en-US")],
                    [
                      "Review rounds",
                      `${checkpoint?.consumed.rounds ?? 0} / ${task.budget.maxRounds}`,
                    ],
                    ["Duration limit", `${task.budget.maxDurationMs / 60_000} minutes`],
                    [
                      "Report size limit",
                      `${task.budget.maxReportBytes.toLocaleString("en-US")} bytes`,
                    ],
                  ].map(([label, value]) => (
                    <Box key={label}>
                      <Typography component="dt" variant="caption" color="text.secondary">
                        {label}
                      </Typography>
                      <Typography component="dd" sx={{ m: 0 }}>
                        {value}
                      </Typography>
                    </Box>
                  ))}
                </Box>
                <TokenUsagePanel summary={usage} invocations={invocations} active={active} />
              </Stack>
            </AccordionDetails>
          </Accordion>
          <Section title="Recorded progress">
            <TaskProgressPanel
              task={task}
              progress={query.data.progress}
              resourceLeases={resourceLeases}
              invocations={invocations}
            />
          </Section>
          {checkpoint && (
            <Section title={`Saved state v${checkpoint.version}`}>
              <Typography variant="body2" sx={{ mt: 1 }}>
                {checkpoint.round} accepted analysis rounds · Stop reason:{" "}
                {checkpoint.stopReason ?? "Not stopped"}
              </Typography>
              <TextList
                items={checkpoint.analysis.coverage.unresolvedUnitRefs.map(
                  (id) => `Unresolved scope: ${id}`,
                )}
              />
              <Typography variant="caption">
                {checkpoint.analysis.candidates.length} candidates retained ·{" "}
                {checkpoint.analysis.rechecks.length} recheck records
              </Typography>
            </Section>
          )}
          <Box
            component="details"
            className="production-task-full-span production-task-source-disclosure"
          >
            <Typography component="summary">Source snapshots</Typography>
            <SubjectPanel subjects={task.subjects} />
          </Box>
          <Box className="production-task-full-span">
            <Button
              component={Link}
              to={`/webhooks?repositoryId=${encodeURIComponent(task.repository.id)}&kind=${task.workItem.kind}&number=${task.workItem.number}`}
            >
              View source events
            </Button>
          </Box>
          <Box className="production-task-full-span">
            <TaskComments taskId={task.id} active={active} />
          </Box>
          {children.length > 0 && (
            <Box className="production-task-full-span">
              <Section title="Linked tasks">
                <TaskList tasks={children} />
              </Section>
            </Box>
          )}
        </Stack>
      )}
      <Dialog
        open={cancelOpen}
        onClose={() => {
          if (!busy) setCancelOpen(false);
        }}
        fullWidth
        maxWidth="sm"
        aria-labelledby="cancel-task-title"
      >
        <DialogTitle id="cancel-task-title">Cancel this task?</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography>
              {task.state === "queued"
                ? "This task will leave the queue before further work is admitted."
                : "The investigation will stop at its current point."}{" "}
              Completed work stays available. Worker cleanup may still require acknowledgment.
            </Typography>
            <Typography variant="subtitle2">{task.workItem.title}</Typography>
            <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
              {task.id}
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setCancelOpen(false)}>
            {task.state === "queued" ? "Keep queued" : "Keep running"}
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={busy || !canCancel || !fresh}
            onClick={() => void cancelTask()}
          >
            {busy ? "Cancelling…" : "Cancel task"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
function TaskSourceChooser({
  repositoryId,
  repositories = [],
}: {
  repositoryId?: string;
  repositories?: readonly { id: string; fullName: string }[];
}) {
  const { session } = useInvestigationSession();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "pull_request" | "issue">("all");
  const [page, setPage] = useState(1);
  const titleId = useId();
  const canCreate = session.user?.permissions.includes("task:create") === true;
  const sources = useQuery({
    queryKey: ["task-source-chooser", sessionIdentity(session), repositoryId ?? "all"],
    queryFn: () => investigationApi.workItems(repositoryId),
    enabled: open && canCreate,
    retry: false,
  });
  const items = (outputAccessDenied(sources.error) ? [] : (sources.data?.items ?? [])).filter(
    (item) =>
      session.user?.repositoryIds.includes(item.repositoryId) &&
      (!repositoryId || item.repositoryId === repositoryId) &&
      (kind === "all" || item.kind === kind) &&
      `${item.title} ${item.number}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / 10)));
  return (
    <>
      <Button
        variant="outlined"
        startIcon={<AddRounded />}
        disabled={!canCreate}
        aria-describedby={!canCreate ? `${titleId}-permission` : undefined}
        onClick={() => setOpen(true)}
      >
        New task
      </Button>
      {!canCreate && (
        <Typography
          id={`${titleId}-permission`}
          variant="caption"
          color="text.secondary"
          component="p"
        >
          Create tasks permission required.
        </Typography>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="md"
        aria-labelledby={titleId}
      >
        <DialogTitle id={titleId}>New task</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <TextField
              size="small"
              type="search"
              label="Search sources"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              slotProps={{ htmlInput: { maxLength: 160 } }}
            />
            <ToggleButtonGroup
              value={kind}
              exclusive
              size="small"
              aria-label="Source type"
              sx={{
                flexWrap: "wrap",
                gap: 0.5,
                "& .MuiToggleButtonGroup-grouped": {
                  borderRadius: "8px",
                  border: 1,
                  borderColor: "divider",
                },
              }}
              onChange={(_, value: typeof kind | null) => {
                if (value) {
                  setKind(value);
                  setPage(1);
                }
              }}
            >
              <ToggleButton value="all">All sources</ToggleButton>
              <ToggleButton value="pull_request">Pull requests</ToggleButton>
              <ToggleButton value="issue">Issues</ToggleButton>
            </ToggleButtonGroup>
            {sources.isError && (
              <Alert
                severity="error"
                action={<Button onClick={() => void sources.refetch()}>Retry</Button>}
              >
                {sources.error.message}
              </Alert>
            )}
            {sources.isPending ? (
              <CircularProgress size={24} aria-label="Loading sources" />
            ) : items.length ? (
              <Box component="ul" className="production-task-source-list" aria-label="Task sources">
                {items.slice((currentPage - 1) * 10, currentPage * 10).map((item) => (
                  <Box component="li" key={item.id} className="production-task-source-row">
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ overflowWrap: "anywhere" }}>
                        {item.title}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ overflowWrap: "anywhere" }}
                      >
                        {item.kind === "issue" ? "Issue" : "PR"} #{item.number} · {item.state} ·{" "}
                        {repositories.find((repository) => repository.id === item.repositoryId)
                          ?.fullName ?? item.repositoryId}
                      </Typography>
                    </Box>
                    <StartInvestigationButton
                      workItem={item}
                      variant="outlined"
                      disabled={sources.isError || sources.isFetching}
                    />
                  </Box>
                ))}
              </Box>
            ) : (
              !sources.isError && (
                <EmptyState
                  title={search || kind !== "all" ? "No matching sources" : "No sources available"}
                />
              )
            )}
            {items.length > 10 && (
              <Pagination
                size="small"
                count={Math.ceil(items.length / 10)}
                page={currentPage}
                onChange={(_, next) => setPage(next)}
                aria-label="Source pages"
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
export default function TasksPage() {
  const { session } = useInvestigationSession();
  const location = useLocation();
  const navigate = useNavigate();
  const parameters = new URLSearchParams(location.search);
  const taskId = parameters.get("taskId");
  const scope = useInvestigationRepositoryScope();
  const search = (parameters.get("q") ?? "").slice(0, 160);
  const requestedFilter = parameters.get("status") ?? "all";
  const filter = ["all", "active", "attention"].includes(requestedFilter) ? requestedFilter : "all";
  const requestedPage = parameters.get("page") ?? "1";
  const page = /^[1-9]\d{0,4}$/.test(requestedPage) ? Number(requestedPage) : 1;
  const updateList = (next: { search?: string; filter?: string; page?: number }) => {
    const query = new URLSearchParams(location.search);
    if (next.search !== undefined) {
      if (next.search) query.set("q", next.search.slice(0, 160));
      else query.delete("q");
    }
    if (next.filter !== undefined) {
      if (next.filter !== "all") query.set("status", next.filter);
      else query.delete("status");
    }
    if ((next.page ?? 1) > 1) query.set("page", String(next.page));
    else query.delete("page");
    navigate({ pathname: location.pathname, search: query.toString() }, { replace: true });
  };
  const query = useQuery({
    queryKey: ["investigation-tasks", sessionIdentity(session)],
    queryFn: ({ signal }) => investigationApi.tasks(undefined, signal),
    enabled: !taskId,
    refetchInterval: (current) =>
      current.state.data?.items.some((task) => ["queued", "running"].includes(task.state)) ||
      Object.values(current.state.data?.usageByTaskId ?? {}).some(
        (usage) => usage.activeInvocationCount > 0,
      )
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const resources = useQuery({
    queryKey: [...schedulerQueryKey, sessionIdentity(session)],
    queryFn: investigationApi.scheduler,
    enabled: !taskId && session.authenticated && !!query.data?.items.length,
    refetchInterval: (current) =>
      !outputAccessDenied(current.state.error) &&
      (current.state.data?.leases.some((lease) => lease.state !== "released") ||
        query.data?.items.some((task) => ["queued", "running"].includes(task.state)))
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  if (taskId) return <TaskDetails key={taskId} taskId={taskId} />;
  const leases = outputAccessDenied(resources.error) ? [] : (resources.data?.leases ?? []);
  const priority = (task: InvestigationTaskV1) =>
    taskIsActive(task, leases)
      ? 0
      : ["failed", "interrupted", "blocked"].includes(task.state)
        ? 1
        : 2;
  const scopedTasks = (query.data?.items ?? []).filter(
    (task) =>
      session.user?.repositoryIds.includes(task.repository.id) &&
      (!scope.repositoryId || task.repository.id === scope.repositoryId) &&
      `${task.workItem.title} ${task.id} ${task.workItem.number}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const tasks = scopedTasks
    .filter(
      (task) =>
        filter === "all" ||
        (filter === "active"
          ? taskIsActive(task, leases)
          : ["failed", "interrupted", "blocked"].includes(task.state)),
    )
    .sort(
      (left, right) =>
        priority(left) - priority(right) || right.createdAt.localeCompare(left.createdAt),
    );
  return (
    <Stack spacing={3}>
      <PageHeading
        title="Tasks"
        action={
          <TaskSourceChooser
            key={JSON.stringify([sessionIdentity(session), scope.repositoryId])}
            repositoryId={scope.repositoryId}
            repositories={scope.query.data?.items}
          />
        }
      />
      <Stack
        component="section"
        aria-label="Task search and filters"
        className="production-task-controls"
        direction="row"
        useFlexGap
        spacing={1.5}
        sx={{ flexWrap: "wrap", alignItems: "center" }}
      >
        <TextField
          size="small"
          type="search"
          label="Search tasks"
          placeholder="Title or number"
          value={search}
          onChange={(event) => updateList({ search: event.target.value })}
          slotProps={{
            htmlInput: { "aria-label": "Search tasks by title or source number" },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{
            flex: { xs: "1 1 100%", sm: "0 1 380px" },
            width: { xs: "100%", sm: 380 },
            maxWidth: "100%",
          }}
        />
        <ToggleButtonGroup
          exclusive
          size="small"
          value={filter}
          aria-label="Filter tasks"
          sx={{
            gap: 0.5,
            "& .MuiToggleButtonGroup-grouped": {
              border: 0,
              borderRadius: "20px",
              px: 1.5,
              minHeight: 36,
            },
          }}
          onChange={(_, value: string | null) => {
            if (value) updateList({ filter: value });
          }}
        >
          <ToggleButton value="all">
            All tasks <span className="production-task-filter-count">{scopedTasks.length}</span>
          </ToggleButton>
          <ToggleButton value="active">
            Active{" "}
            <span className="production-task-filter-count">
              {resources.isError || (resources.isPending && !!scopedTasks.length)
                ? "?"
                : scopedTasks.filter((task) => taskIsActive(task, leases)).length}
            </span>
          </ToggleButton>
          <ToggleButton value="attention">
            Needs attention{" "}
            <span className="production-task-filter-count">
              {
                scopedTasks.filter((task) =>
                  ["failed", "interrupted", "blocked"].includes(task.state),
                ).length
              }
            </span>
          </ToggleButton>
        </ToggleButtonGroup>
        <IconButton
          aria-label="Refresh tasks"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          sx={{ ml: "auto" }}
        >
          <RefreshRounded />
        </IconButton>
      </Stack>
      {query.isError && (
        <Alert severity="error">
          {query.error.message}
          {query.data && !outputAccessDenied(query.error)
            ? " Showing the last successful task list."
            : ""}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Alert>
      )}
      {resources.isError && query.data && (
        <Alert
          severity="warning"
          action={<Button onClick={() => void resources.refetch()}>Retry cleanup status</Button>}
        >
          Cleanup status could not be refreshed. Active tasks may be missing from this view.
        </Alert>
      )}
      {query.isPending ||
      (filter === "active" &&
        !query.isError &&
        resources.isPending &&
        !!query.data?.items.length) ? (
        <CircularProgress size={28} aria-label="Loading tasks" />
      ) : query.isError &&
        (!query.data || outputAccessDenied(query.error)) ? null : !tasks.length &&
        filter === "active" &&
        resources.isError ? (
        <EmptyState
          title="Active resource state unavailable"
          description="Retry cleanup status or view all tasks to inspect retained execution records."
          action={<Button onClick={() => updateList({ filter: "all" })}>View all tasks</Button>}
        />
      ) : !tasks.length && (search || filter !== "all") ? (
        <EmptyState
          title="No matching tasks"
          description="Try a different title, source number, or status."
          action={
            <Button
              onClick={() => {
                updateList({ search: "", filter: "all" });
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <TaskList
          key={JSON.stringify([search, filter, scope.repositoryId])}
          tasks={tasks}
          usageByTaskId={query.data?.usageByTaskId}
          resourceLeases={leases}
          page={page}
          onPageChange={(page) => updateList({ page })}
        />
      )}
    </Stack>
  );
}
