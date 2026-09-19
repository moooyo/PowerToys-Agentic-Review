import {
  type InvestigationTaskV1,
  type InvestigationUsageSummary,
  projectInvestigationCheckpointPresentation,
} from "@agentic-review/contracts";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
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
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { DataTable } from "@/components/ui";
import { investigationApi, type WorkItem } from "./api";
import {
  CommentStatus,
  commentDetailsUrl,
  commentPollingInterval,
  commentSummariesQueryKey,
  TaskComments,
} from "./comment-deliveries";
import { Section, SubjectPanel, TextList } from "./report-sections";
import { ReportWorkspace } from "./report-workspace";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { ResumeTaskButton } from "./resume-task";
import { schedulerQueryKey } from "./scheduler-panel";
import { useInvestigationSession } from "./session";
import { TaskProgressPanel } from "./task-progress";
import { TokenUsagePanel, UsageSummaryLabel } from "./usage-panel";

export function StartInvestigationButton({ workItem }: { workItem: WorkItem }) {
  const { session } = useInvestigationSession();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"snapshot_only" | "source_read">(
    workItem.kind === "issue" ? "snapshot_only" : "source_read",
  );
  const [sourceCommit, setSourceCommit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (
        workItem.kind === "issue" &&
        mode === "source_read" &&
        !/^[a-f0-9]{40,64}$/u.test(sourceCommit)
      )
        throw new Error(
          "Provide the full source commit SHA for a source-based issue investigation.",
        );
      const task = await investigationApi.createTask({
        workItemId: workItem.id,
        kind: workItem.kind === "pull_request" ? "pr-review" : "issue-investigate",
        idempotencyKey: key,
        executionMode: mode,
        ...(workItem.kind === "issue" && mode === "source_read" ? { sourceCommit } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
      setOpen(false);
      navigate(
        `/tasks?taskId=${encodeURIComponent(task.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The task could not be created.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="contained"
        disabled={!session.user?.permissions.includes("task:create")}
        onClick={() => {
          setOpen(true);
          setKey(crypto.randomUUID());
          setError(undefined);
        }}
      >
        {workItem.kind === "pull_request" ? "Review pull request" : "Investigate issue"}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Start complete investigation</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography>{workItem.title}</Typography>
            <Alert severity="info">
              Static analysis searches the pinned source and reviews changed behavior. Its prompt
              prohibits building, running tests, or launching applications. Missing evidence and
              budget interruptions are reported explicitly.
            </Alert>
            <TextField
              select
              label="Investigation access"
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as "snapshot_only" | "source_read");
                setKey(crypto.randomUUID());
              }}
            >
              <MenuItem value="snapshot_only">Issue or PR snapshot only</MenuItem>
              <MenuItem value="source_read">Read the exact registered source</MenuItem>
            </TextField>
            {workItem.kind === "issue" && mode === "source_read" && (
              <TextField
                label="Exact source commit SHA"
                fullWidth
                value={sourceCommit}
                onChange={(event) => {
                  setSourceCommit(event.target.value.trim());
                  setKey(crypto.randomUUID());
                }}
                helperText="Choose a full commit SHA; an issue snapshot does not identify a source revision."
              />
            )}
            <Typography variant="body2" color="text.secondary">
              The server records the registered subject, full scope, profile, prompt, and budget.
              E2E execution runs as a separate task with its own results and comment.
            </Typography>
            <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
              Registered revision: {workItem.subject.revisionKey}
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="contained" disabled={busy} onClick={() => void create()}>
            Create task
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export function taskMode(kind: InvestigationTaskV1["kind"]): string {
  return kind === "pr-review" || kind === "issue-investigate"
    ? "Static"
    : kind === "pr-e2e"
      ? "E2E"
      : "Execution";
}

export function TaskList({
  tasks,
  usageByTaskId,
}: {
  tasks: InvestigationTaskV1[];
  usageByTaskId?: Record<string, InvestigationUsageSummary>;
}) {
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(tasks.length / pageSize)));
  const visibleTasks = tasks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const usageWorkItemId =
    visibleTasks.length > 0 &&
    visibleTasks.every((task) => task.workItem.id === visibleTasks[0]?.workItem.id)
      ? visibleTasks[0]?.workItem.id
      : undefined;
  const usageQuery = useQuery({
    queryKey: ["investigation-tasks", usageWorkItemId ?? "all-usage"],
    queryFn: () => investigationApi.tasks(usageWorkItemId),
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
    queryKey: commentSummariesQueryKey(summaryInput),
    queryFn: () => investigationApi.comments(summaryInput),
    enabled: visibleTasks.length > 0,
    refetchInterval: (current) =>
      commentPollingInterval(current.state.data?.items ?? []) ||
      (visibleTasks.some((task) => ["queued", "running"].includes(task.state)) ? 5_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  return (
    <DataTable
      rows={visibleTasks}
      getRowId={(task) => task.id}
      ariaLabel="Investigation tasks"
      emptyTitle="No investigation tasks yet"
      pagination={{
        page: currentPage,
        pageSize,
        total: tasks.length,
        onChange: (next) => setPage(next),
      }}
      columns={[
        {
          id: "task",
          label: "Task",
          render: (task) => (
            <Box>
              <Button
                component={Link}
                to={`/tasks?taskId=${encodeURIComponent(task.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`}
              >
                {task.workItem.title}
              </Button>
              <Typography variant="caption" component="div" color="text.secondary">
                {task.repository.fullName} #{task.workItem.number} · {task.kind}
              </Typography>
              <Chip size="small" variant="outlined" label={taskMode(task.kind)} sx={{ mt: 0.5 }} />
            </Box>
          ),
        },
        {
          id: "usage",
          label: "Token usage",
          render: (task) => <UsageSummaryLabel summary={usage?.[task.id]} />,
        },
        {
          id: "state",
          label: "Execution",
          render: (task) => (
            <Chip
              label={task.state}
              size="small"
              color={
                task.state === "failed"
                  ? "error"
                  : task.state === "completed"
                    ? "success"
                    : "default"
              }
            />
          ),
        },
        {
          id: "report",
          label: "Latest report",
          render: (task) =>
            task.latestReportRef ? (
              <Button
                component={Link}
                to={`/reports?reportId=${encodeURIComponent(task.latestReportRef.id)}&repositoryId=${encodeURIComponent(task.repository.id)}`}
              >
                Open v{task.latestReportRef.version}
              </Button>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Not sealed yet
              </Typography>
            ),
        },
        {
          id: "comment",
          label: "GitHub comment",
          render: (task) => {
            const comment = comments.data?.items
              .filter((item) => item.taskId === task.id)
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
            if (!comment)
              return (
                <Typography variant="caption" color="text.secondary">
                  {comments.isPending
                    ? "Loading…"
                    : comments.isError
                      ? "Status unavailable"
                      : "No comment enrolled"}
                </Typography>
              );
            return (
              <Box>
                <Button
                  component={Link}
                  to={commentDetailsUrl(comment.id, comment.repositoryId)}
                  sx={{ p: 0, minWidth: 0 }}
                >
                  <CommentStatus comment={comment} />
                </Button>
                {comment.lastAttemptAt && (
                  <Typography variant="caption" component="div" color="text.secondary">
                    Last delivery {new Date(comment.lastAttemptAt).toLocaleString()}
                  </Typography>
                )}
              </Box>
            );
          },
        },
        {
          id: "updated",
          label: "Updated",
          render: (task) => new Date(task.updatedAt).toLocaleString(),
        },
      ]}
    />
  );
}

export function TaskDetails({ taskId }: { taskId: string }) {
  const { session } = useInvestigationSession();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["investigation-task", taskId],
    queryFn: () => investigationApi.task(taskId),
    refetchInterval: (current) =>
      current.state.data &&
      (["queued", "running"].includes(current.state.data.task.state) ||
        (current.state.data.usage?.activeInvocationCount ?? 0) > 0 ||
        current.state.data.resourceLeases?.some((lease) => lease.state === "needs_cleanup"))
        ? 5000
        : false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const scheduler = useQuery({
    queryKey: schedulerQueryKey,
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
  const { task, attempts, checkpoint, children, latestReport } = query.data;
  const cancelTask = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await investigationApi.cancelTask(task.id);
      await query.refetch();
      await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The task state could not be updated.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="overline">
          {task.repository.fullName} #{task.workItem.number}
        </Typography>
        <Typography variant="h4">{task.workItem.title}</Typography>
        <Stack direction="row" useFlexGap spacing={1} sx={{ mt: 2, flexWrap: "wrap" }}>
          <Chip label={task.kind} />
          <Chip label={taskMode(task.kind)} variant="outlined" />
          <Chip label={`Execution: ${task.state}`} />
          <Chip label={task.executionPolicy.mode} variant="outlined" />
        </Stack>
        <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 1 }}>
          {task.id}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button startIcon={<RefreshRounded />} onClick={() => void query.refetch()}>
            Refresh
          </Button>
          {["blocked", "failed", "cancelled", "interrupted"].includes(task.state) && (
            <ResumeTaskButton
              task={task}
              checkpoint={checkpoint}
              disabled={busy || !session.user?.permissions.includes("task:create")}
              onResumed={async () => {
                await query.refetch();
                await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
              }}
            />
          )}
          {["queued", "running"].includes(task.state) && (
            <Button
              color="warning"
              disabled={busy || !session.user?.permissions.includes("task:cancel")}
              onClick={() => void cancelTask()}
            >
              Cancel task
            </Button>
          )}
          {task.parentTaskId && (
            <Button
              component={Link}
              to={`/tasks?taskId=${encodeURIComponent(task.parentTaskId)}&repositoryId=${encodeURIComponent(task.repository.id)}`}
            >
              Parent task
            </Button>
          )}
        </Stack>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <Section title="Analysis progress">
        <TaskProgressPanel
          task={task}
          progress={query.data.progress}
          scheduler={scheduler.data}
          resourceLeases={query.data.resourceLeases}
          invocations={query.data.invocations}
        />
        <Typography variant="subtitle2">
          {query.data.usage?.invocationCount ?? "Unknown"} model calls · {checkpoint?.round ?? 0}{" "}
          accepted analysis rounds
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Model calls and accepted analysis rounds are separate counts. Saving state does not start
          another model call.
        </Typography>
        {checkpoint && (
          <Typography sx={{ mt: 2 }}>
            {projectInvestigationCheckpointPresentation(task, checkpoint).summary}
          </Typography>
        )}
      </Section>
      <TokenUsagePanel
        summary={query.data.usage}
        invocations={query.data.invocations}
        legacyTokens={checkpoint?.consumed.tokens}
        active={["queued", "running"].includes(task.state)}
      />
      <Section title="Attempts">
        <Stack spacing={2}>
          {attempts.map((attempt) => (
            <Box key={attempt.id}>
              <Typography variant="subtitle2">
                Attempt {attempt.number} · {attempt.state}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {attempt.workerId ?? "Waiting for worker"} · {attempt.startedAt ?? "Not started"}
              </Typography>
              {attempt.terminationReason && (
                <Typography variant="body2">{attempt.terminationReason}</Typography>
              )}
            </Box>
          ))}
          {query.data.resourceLeases
            ?.filter((lease) => lease.state !== "released")
            .map((lease) => (
              <Alert
                key={lease.attemptId}
                severity={lease.state === "needs_cleanup" ? "warning" : "info"}
              >
                {lease.pool === "e2e" ? "E2E desktop" : "Static capacity"}:{" "}
                {lease.state === "needs_cleanup"
                  ? "Needs cleanup. The next E2E task cannot start until cleanup is confirmed."
                  : "Reserved by this attempt."}
                {lease.reason && (
                  <Typography variant="caption" component="div">
                    {lease.reason}
                  </Typography>
                )}
              </Alert>
            ))}
          {checkpoint && (
            <Accordion disableGutters elevation={0}>
              <AccordionSummary expandIcon={<ExpandMoreRounded />}>
                <Typography>Saved state v{checkpoint.version} · Diagnostics</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" color="text.secondary">
                  A checkpoint is a durable state snapshot used for recovery and duplicate
                  protection. Its version counts saved updates, including initialization and
                  cancellation; it does not count model calls.
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
              </AccordionDetails>
            </Accordion>
          )}
        </Stack>
      </Section>
      <TaskComments taskId={task.id} active={["queued", "running"].includes(task.state)} />
      {!latestReport && (
        <>
          <Alert
            severity={task.state === "queued" || task.state === "running" ? "info" : "warning"}
          >
            {task.state === "queued" || task.state === "running"
              ? "The task has not sealed a report. Interim analysis is saved for recovery and is not a final conclusion."
              : "No sealed report is available. Inspect the termination reason and saved state before resuming."}
          </Alert>
          <SubjectPanel subjects={task.subjects} />
        </>
      )}
      {latestReport && (
        <ReportWorkspace key={latestReport.report.id} reportId={latestReport.report.id} />
      )}
      {children.length > 0 && (
        <Section title="Linked tasks">
          <TaskList tasks={children} />
        </Section>
      )}
    </Stack>
  );
}

export default function TasksPage() {
  const location = useLocation();
  const taskId = new URLSearchParams(location.search).get("taskId");
  const scope = useInvestigationRepositoryScope();
  const query = useQuery({
    queryKey: ["investigation-tasks"],
    queryFn: () => investigationApi.tasks(),
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
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4">Tasks</Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Static analysis and E2E execution, their progress, consumption, and results.
        </Typography>
      </Box>
      {query.isError && <Alert severity="error">{query.error.message}</Alert>}
      {query.isPending ? (
        <CircularProgress size={28} />
      ) : (
        <TaskList
          usageByTaskId={query.data?.usageByTaskId}
          tasks={(query.data?.items ?? []).filter(
            (task) => !scope.repositoryId || task.repository.id === scope.repositoryId,
          )}
        />
      )}
    </Stack>
  );
}
