import type { InvestigationTaskV1 } from "@agentic-review/contracts";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import {
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
import { Section, SubjectPanel, TextList } from "./report-sections";
import { ReportWorkspace } from "./report-workspace";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { ResumeTaskButton } from "./resume-task";
import { useInvestigationSession } from "./session";

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
              The task will investigate the entire declared scope, revisit every candidate, and
              deliver a final complete report when all required investigation work is resolved. A
              budget interruption is reported as partial.
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
              The server freezes the registered subject, full scope, profile, prompt, and budget.
              Runtime execution is prepared separately from a saved verification plan.
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

export function TaskList({ tasks }: { tasks: InvestigationTaskV1[] }) {
  return (
    <DataTable
      rows={tasks}
      getRowId={(task) => task.id}
      ariaLabel="Investigation tasks"
      emptyTitle="No investigation tasks yet"
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
            </Box>
          ),
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
      current.state.data && ["queued", "running"].includes(current.state.data.task.state)
        ? 5000
        : false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
      <Section title="Attempts and checkpoint">
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
          {checkpoint && (
            <Box>
              <Typography variant="subtitle2">
                Checkpoint version {checkpoint.version} · Round {checkpoint.round}
              </Typography>
              <Typography variant="body2">{checkpoint.analysis.summary}</Typography>
              <TextList
                items={checkpoint.analysis.coverage.unresolvedUnitRefs.map(
                  (id) => `Unresolved scope: ${id}`,
                )}
              />
              <Typography variant="caption">
                {checkpoint.analysis.candidates.length} candidates retained ·{" "}
                {checkpoint.analysis.rechecks.length} recheck records
              </Typography>
            </Box>
          )}
        </Stack>
      </Section>
      {!latestReport && (
        <>
          <Alert
            severity={task.state === "queued" || task.state === "running" ? "info" : "warning"}
          >
            {task.state === "queued" || task.state === "running"
              ? "The task has not sealed a report. Progress is recorded in its checkpoint; interim candidates are not a final conclusion."
              : "No sealed report is available. Inspect the attempt termination and checkpoint before resuming."}
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
  });
  if (taskId) return <TaskDetails key={taskId} taskId={taskId} />;
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4">Tasks</Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Investigations, saved checkpoints, linked verification, and implementation work.
        </Typography>
      </Box>
      {query.isError && <Alert severity="error">{query.error.message}</Alert>}
      {query.isPending ? (
        <CircularProgress size={28} />
      ) : (
        <TaskList
          tasks={(query.data?.items ?? []).filter(
            (task) => !scope.repositoryId || task.repository.id === scope.repositoryId,
          )}
        />
      )}
    </Stack>
  );
}
