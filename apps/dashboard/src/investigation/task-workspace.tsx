import {
  type InvestigationTaskV1,
  type InvestigationUsageSummary,
  projectInvestigationCheckpointPresentation,
} from "@agentic-review/contracts";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import CheckRounded from "@mui/icons-material/CheckRounded";
import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import ScheduleRounded from "@mui/icons-material/ScheduleRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import WarningAmberRounded from "@mui/icons-material/WarningAmberRounded";
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
import { useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { investigationApi } from "./api";
import {
  CommentStatus,
  commentDetailsUrl,
  commentPollingInterval,
  commentSummariesQueryKey,
  TaskComments,
} from "./comment-deliveries";
import { useUnsavedChanges } from "./navigation-guard";
import { Section, SubjectPanel, TextList } from "./report-sections";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { ResumeTaskButton } from "./resume-task";
import { schedulerQueryKey } from "./scheduler-panel";
import { sessionIdentity, useInvestigationSession } from "./session";
import { TaskEvidencePanel } from "./task-evidence";
import { outputAccessDenied, TaskOutputPanel } from "./task-output";
import { latestAttemptInvocation } from "./task-output-state";
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

export function TaskList({
  tasks,
  usageByTaskId,
}: {
  tasks: InvestigationTaskV1[];
  usageByTaskId?: Record<string, InvestigationUsageSummary>;
}) {
  const { session } = useInvestigationSession();
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(tasks.length / pageSize)));
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
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ px: { xs: 2, sm: 3 }, py: 1.5, borderBottom: 1, borderColor: "divider" }}
      >
        {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
      </Typography>
      <Box component="ul" aria-label="Investigation tasks" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {visibleTasks.map((task) => {
          const comment = comments.data?.items
            .filter((item) => item.taskId === task.id || item.associatedTaskIds?.includes(task.id))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
          const url = `/tasks?taskId=${encodeURIComponent(task.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`;
          const tone =
            task.state === "failed"
              ? "error"
              : task.state === "completed"
                ? "success"
                : ["blocked", "interrupted"].includes(task.state)
                  ? "warning"
                  : task.state === "running"
                    ? "primary"
                    : "default";
          const icon =
            task.state === "completed" ? (
              <CheckRounded />
            ) : task.state === "running" ? (
              <PlayArrowRounded />
            ) : ["failed", "blocked", "interrupted"].includes(task.state) ? (
              <WarningAmberRounded />
            ) : (
              <ScheduleRounded />
            );
          return (
            <Box
              component="li"
              key={task.id}
              className="production-task-row"
              sx={{ borderBottom: 1, borderColor: "divider", "&:last-child": { borderBottom: 0 } }}
            >
              <Box
                className="production-task-symbol"
                sx={{ color: tone === "default" ? "text.secondary" : `${tone}.main` }}
                aria-hidden="true"
              >
                {icon}
              </Box>
              <Box className="production-task-row-main" sx={{ minWidth: 0 }}>
                <Typography
                  component={Link}
                  to={url}
                  className="production-task-title"
                  sx={{ color: "text.primary", fontWeight: 500 }}
                >
                  {task.workItem.title}
                </Typography>
                <Typography
                  variant="caption"
                  component="div"
                  color="text.secondary"
                  sx={{ mt: 0.5, overflowWrap: "anywhere" }}
                >
                  {taskMode(task.kind)} · {task.repository.fullName} #{task.workItem.number}
                </Typography>
                <Box className="production-task-row-meta-actions">
                  <Typography
                    component="time"
                    dateTime={task.updatedAt}
                    variant="caption"
                    color="text.secondary"
                    title={new Date(task.updatedAt).toLocaleString()}
                  >
                    Updated{" "}
                    {new Date(task.updatedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </Typography>
                  {task.state === "running" && (
                    <Button
                      className="production-task-inline-action"
                      size="small"
                      component={Link}
                      to={url}
                    >
                      View progress
                    </Button>
                  )}
                  {task.latestReportRef && (
                    <Button
                      className="production-task-inline-action"
                      size="small"
                      component={Link}
                      to={`/reports?reportId=${encodeURIComponent(task.latestReportRef.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`}
                    >
                      Open report v{task.latestReportRef.version}
                    </Button>
                  )}
                </Box>
              </Box>
              <Stack
                spacing={0.5}
                direction={{ xs: "row", sm: "column" }}
                useFlexGap
                className="production-task-row-status"
                sx={{ alignItems: { xs: "center", sm: "flex-end" }, flexWrap: "wrap" }}
              >
                <Chip
                  size="small"
                  label={
                    task.state === "running"
                      ? "In progress"
                      : task.state === "completed"
                        ? "Complete"
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
              </Stack>
              <IconButton
                className="production-task-open"
                component={Link}
                to={url}
                aria-label={`Open task: ${task.workItem.title}`}
              >
                <ChevronRightRounded />
              </IconButton>
            </Box>
          );
        })}
      </Box>
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
            onChange={(_, next) => setPage(next)}
            aria-label="Task pages"
          />
        )}
      </Box>
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
  if (query.isPending) return <CircularProgress size={28} aria-label="Loading task" />;
  if (query.isError)
    return (
      <Alert severity="error">
        {query.error.message}
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </Alert>
    );
  const { task, attempts, checkpoint, children, latestReport, usage, invocations, resourceLeases } =
    query.data;
  const currentAttempt = [...attempts].sort((left, right) => right.number - left.number)[0];
  const requestedAttempt = parameters.get("attemptId");
  const attemptId = attempts.some((attempt) => attempt.id === requestedAttempt)
    ? requestedAttempt!
    : currentAttempt?.id;
  const selectedAttempt = attempts.find((attempt) => attempt.id === attemptId);
  const call = latestAttemptInvocation(invocations, attemptId);
  const active = ["queued", "running"].includes(task.state);
  const recoverable = ["blocked", "failed", "cancelled", "interrupted"].includes(task.state);
  const cleanup = !active && resourceLeases?.some((lease) => lease.state !== "released");
  const canCancel = session.user?.permissions.includes("task:cancel") === true;
  const canResume =
    session.user?.permissions.includes("task:create") === true &&
    (task.executionPolicy.mode !== "execute" || session.user.allowRepositoryExecution);
  const stopReason = currentAttempt?.terminationReason ?? checkpoint?.stopReason;
  const updateRoute = (next: { tab?: string; attemptId?: string }) => {
    const search = new URLSearchParams(location.search);
    search.set("taskId", task.id);
    if (next.tab) search.set("tab", next.tab);
    if (next.attemptId) search.set("attemptId", next.attemptId);
    navigate(`${location.pathname}?${search.toString()}`);
  };
  const taskUrl = (id: string) =>
    `/tasks?taskId=${encodeURIComponent(id)}&repositoryId=${encodeURIComponent(task.repository.id)}`;
  const cancelTask = async () => {
    if (!canCancel || busy) return;
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
    ["Recorded model calls", String(usage?.invocationCount ?? "Not recorded")],
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
        <Button
          component={Link}
          to="/tasks"
          startIcon={<ArrowBackRounded />}
          sx={{ minHeight: 32, py: 0.5 }}
        >
          All tasks
        </Button>
        {active && (
          <Button color="error" disabled={!canCancel || busy} onClick={() => setCancelOpen(true)}>
            Cancel task
          </Button>
        )}
      </Stack>
      <PageHeading
        title={task.workItem.title}
        eyebrow={taskKindLabels[task.kind]}
        action={
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {recoverable && (
              <ResumeTaskButton
                task={task}
                checkpoint={checkpoint}
                disabled={busy || !canResume || !!cleanup}
                onResumed={async () => {
                  await query.refetch();
                  await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
                }}
              />
            )}
            {latestReport && (
              <Button
                variant={task.state === "completed" ? "contained" : "outlined"}
                component={Link}
                to={`/reports?reportId=${encodeURIComponent(latestReport.report.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`}
              >
                Open report
              </Button>
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
            {task.repository.fullName}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            {task.id}
          </Typography>
        </Stack>
      </PageHeading>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
        <Chip
          size="small"
          label={
            task.state === "running"
              ? "In progress"
              : task.state === "completed"
                ? "Complete"
                : task.state
          }
          color={
            task.state === "failed"
              ? "error"
              : task.state === "completed"
                ? "success"
                : task.state === "blocked"
                  ? "warning"
                  : "default"
          }
        />
        <Typography variant="body2" color="text.secondary">
          {task.kind === "pr-e2e"
            ? "Desktop verification"
            : task.executionPolicy.mode === "snapshot_only"
              ? "Snapshot investigation"
              : task.executionPolicy.mode === "source_read"
                ? "Source investigation"
                : "Repository execution"}
        </Typography>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
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
          Waiting for cleanup acknowledgment. The worker retains ownership until an accepted receipt
          releases it. Refreshing does not establish cleanup success.
        </Alert>
      )}
      {task.parentTaskId && (
        <Alert
          severity="info"
          action={
            <Button component={Link} to={taskUrl(task.parentTaskId)}>
              Open parent task
            </Button>
          }
        >
          This task continues work from a linked investigation.
        </Alert>
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
            label="Progress"
            id="task-progress-tab"
            aria-controls="task-progress-panel"
          />
          <Tab
            value="evidence"
            label="Evidence"
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
          Cancelling requires Cancel tasks access. Recovery requires Create tasks access and an
          execution grant for execution tasks.
        </Typography>
      )}
      {tab === "progress" && (
        <Stack
          role="tabpanel"
          id="task-progress-panel"
          aria-labelledby="task-progress-tab"
          spacing={2.5}
        >
          <TaskProgressPanel
            task={task}
            progress={query.data.progress}
            scheduler={scheduler.data}
            resourceLeases={resourceLeases}
            invocations={invocations}
            compact
          />
          {checkpoint && (
            <Typography variant="body2" color="text.secondary">
              {projectInvestigationCheckpointPresentation(task, checkpoint).summary}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            {usage?.invocationCount ?? "Unknown"} model calls · {checkpoint?.round ?? 0} accepted
            analysis rounds{checkpoint ? ` · Saved state v${checkpoint.version}` : ""}
          </Typography>
          <TaskOutputPanel
            task={task}
            attempts={attempts}
            attemptId={attemptId}
            onAttemptChange={(id) => updateRoute({ attemptId: id })}
            summary={usage}
            invocations={invocations}
          />
          {!latestReport && !active && (
            <Alert severity="info">
              No sealed report is available. Saved progress and recorded evidence remain available
              for review.
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
          spacing={3}
        >
          <Section title="Run details">
            <Box
              component="dl"
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "180px minmax(0, 1fr)" },
                gap: { xs: 1, sm: 2 },
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
            <Stack spacing={2}>
              {[...attempts]
                .sort((a, b) => b.number - a.number)
                .map((attempt) => (
                  <Box key={attempt.id}>
                    <Typography variant="subtitle2">
                      Attempt {attempt.number} · {attempt.state}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {attempt.workerId ?? "Waiting for worker"} ·{" "}
                      {attempt.startedAt ?? "Not started"}
                    </Typography>
                    <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                      {attempt.id}
                    </Typography>
                    {attempt.terminationReason && (
                      <Typography variant="body2">{attempt.terminationReason}</Typography>
                    )}
                  </Box>
                ))}
              {resourceLeases?.map((lease) => (
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
              <Typography variant="body2" color="text.secondary">
                A checkpoint is a durable state snapshot used for recovery and duplicate protection.
                Its version counts saved updates, including initialization and cancellation; it does
                not count model calls.
              </Typography>
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
          <SubjectPanel subjects={task.subjects} />
          <Box>
            <Button
              component={Link}
              to={`/webhooks?repositoryId=${encodeURIComponent(task.repository.id)}&kind=${task.workItem.kind}&number=${task.workItem.number}`}
            >
              View source events
            </Button>
            <Typography variant="caption" color="text.secondary" component="div">
              Events for this source item can include other attempts and tasks.
            </Typography>
          </Box>
          <TaskComments taskId={task.id} active={active} />
          {children.length > 0 && (
            <Section title="Linked tasks">
              <TaskList tasks={children} />
            </Section>
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
            disabled={busy || !canCancel}
            onClick={() => void cancelTask()}
          >
            {busy ? "Cancelling…" : "Cancel task"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
export default function TasksPage() {
  const { session } = useInvestigationSession();
  const location = useLocation();
  const taskId = new URLSearchParams(location.search).get("taskId");
  const scope = useInvestigationRepositoryScope();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
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
  if (taskId) return <TaskDetails key={taskId} taskId={taskId} />;
  const priority = (task: InvestigationTaskV1) =>
    ["running", "queued"].includes(task.state)
      ? 0
      : ["failed", "interrupted", "blocked"].includes(task.state)
        ? 1
        : 2;
  const tasks = (query.data?.items ?? [])
    .filter(
      (task) =>
        (!scope.repositoryId || task.repository.id === scope.repositoryId) &&
        (filter === "all" ||
          (filter === "active"
            ? ["running", "queued"].includes(task.state)
            : ["failed", "interrupted", "blocked"].includes(task.state))) &&
        `${task.workItem.title} ${task.id} ${task.workItem.number}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    )
    .sort(
      (left, right) =>
        priority(left) - priority(right) || right.createdAt.localeCompare(left.createdAt),
    );
  return (
    <Stack spacing={3}>
      <PageHeading
        title="Tasks"
        subtitle="Follow investigations from the first check to the final report."
        action={
          <Button
            variant="contained"
            component={Link}
            to="/pull-requests"
            disabled={!session.user?.permissions.includes("task:create")}
          >
            Choose a source
          </Button>
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
          placeholder="Search tasks"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
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
            "& .MuiInputBase-root": { height: 48, borderRadius: "28px", bgcolor: "action.hover" },
            "& .MuiOutlinedInput-notchedOutline": { border: 0 },
            "& .Mui-focused .MuiOutlinedInput-notchedOutline": {
              border: "2px solid",
              borderColor: "primary.main",
            },
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
            if (value) setFilter(value);
          }}
        >
          <ToggleButton value="all">All tasks</ToggleButton>
          <ToggleButton value="active">Active</ToggleButton>
          <ToggleButton value="attention">Needs attention</ToggleButton>
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
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Alert>
      )}
      {query.isPending ? (
        <CircularProgress size={28} aria-label="Loading tasks" />
      ) : !tasks.length && (search || filter !== "all") ? (
        <EmptyState
          title="No matching tasks"
          description="Try a different title, source number, or status."
          action={
            <Button
              onClick={() => {
                setSearch("");
                setFilter("all");
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
        />
      )}
    </Stack>
  );
}
