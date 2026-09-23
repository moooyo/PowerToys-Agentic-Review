import type {
  InvestigationModelInvocationReceipt,
  InvestigationSchedulerStatus,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import type { TaskDetail, TaskProgress } from "./api";

const stageNames: Record<string, string> = {
  prepare_source: "Preparing source",
  model: "Model analysis",
  validate_result: "Validating result",
  save_checkpoint: "Saving analysis",
  build_report: "Building report",
  upload_evidence: "Uploading evidence",
  queued: "Waiting for resources",
  preparing_source: "Preparing source",
  source_preparation: "Preparing source",
  model_analysis: "Model analysis",
  analyzing: "Model analysis",
  processing_result: "Processing model result",
  processing_results: "Processing model result",
  generating_report: "Generating report",
  report_generation: "Generating report",
  e2e_execution: "Running E2E",
  executing: "Running E2E",
  uploading_evidence: "Uploading evidence",
  cleanup: "Cleaning up",
  finalizing: "Finalizing report",
};
const measuredStages = [
  "prepare_source",
  "model",
  "validate_result",
  "save_checkpoint",
  "build_report",
  "upload_evidence",
  "cleanup",
] as const;

function stageDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return elapsedTime("1970-01-01T00:00:00.000Z", milliseconds);
}

export function elapsedTime(from: string | null | undefined, now: number): string {
  if (!from || !Number.isFinite(Date.parse(from))) return "Unknown";
  const seconds = Math.max(0, Math.floor((now - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function taskQueueReason(
  task: Pick<InvestigationTaskV1, "kind" | "state"> &
    Partial<Pick<InvestigationTaskV1, "executionPolicy">>,
  scheduler?: InvestigationSchedulerStatus,
): string | null {
  if (task.state !== "queued") return null;
  const isStatic =
    (task.kind === "pr-review" || task.kind === "issue-investigate") &&
    task.executionPolicy?.mode !== "execute";
  if (!scheduler)
    return isStatic
      ? "Waiting for an eligible worker and available task capacity. Resource status is unavailable."
      : "Waiting for a worker that allows E2E and available task capacity. Resource status is unavailable.";
  if (isStatic && scheduler.occupiedStatic >= scheduler.staticConcurrency)
    return "Waiting for static task capacity. Running tasks will finish before another task is admitted.";
  if (!isStatic && scheduler.occupiedE2e >= scheduler.e2eConcurrency) {
    if (scheduler.leases.some((lease) => lease.pool === "e2e" && lease.state === "needs_cleanup"))
      return "Waiting for desktop cleanup confirmation. The next E2E task cannot start while the previous desktop lease needs cleanup.";
    return "Waiting for the exclusive E2E desktop. Only one E2E task can run globally; static tasks can continue.";
  }
  return isStatic
    ? "Capacity is available. Waiting for an eligible worker to claim this task."
    : "Capacity is available. Waiting for a worker that allows E2E to claim this task.";
}

export function TaskProgressPanel({
  task,
  progress,
  scheduler,
  resourceLeases,
  invocations,
  compact = false,
  now = Date.now(),
}: {
  task: Pick<InvestigationTaskV1, "kind" | "state" | "updatedAt"> &
    Partial<Pick<InvestigationTaskV1, "id" | "executionPolicy">>;
  progress?: TaskProgress;
  scheduler?: InvestigationSchedulerStatus;
  resourceLeases?: TaskDetail["resourceLeases"];
  invocations?: InvestigationModelInvocationReceipt[];
  compact?: boolean;
  now?: number;
}) {
  const queueReason = taskQueueReason(task, scheduler);
  const cleanupPending =
    task.id !== undefined &&
    (resourceLeases ?? scheduler?.leases)?.some(
      (lease) => lease.taskId === task.id && lease.state !== "released",
    ) === true;
  const active = ["queued", "running"].includes(task.state) || cleanupPending;
  const observedUntil = active
    ? now
    : Math.max(
        Date.parse(task.updatedAt),
        progress?.lastActivityAt ? Date.parse(progress.lastActivityAt) : 0,
      );
  const stage = progress?.stage
    ? (stageNames[progress.stage] ?? progress.stage.replaceAll("_", " "))
    : "Not reported";
  const events = [
    ["Latest activity", progress?.lastActivityAt],
    ["Latest meaningful progress", progress?.lastMeaningfulProgressAt],
    ["Worker heartbeat", progress?.lastHeartbeatAt],
  ] as const;
  const durations = measuredStages.flatMap((name) => {
    const duration = progress?.stageDurationsMs?.[name];
    return duration === undefined ? [] : [{ name, duration }];
  });
  if (compact)
    return (
      <Stack spacing={1.5}>
        {queueReason && <Alert severity="info">{queueReason}</Alert>}
        <Box
          sx={{
            display: "flex",
            alignItems: { xs: "flex-start", sm: "center" },
            justifyContent: "space-between",
            flexDirection: { xs: "column", sm: "row" },
            gap: 1,
            px: 0.5,
          }}
        >
          <Box>
            <Typography variant="caption" color="text.secondary">
              {task.state === "queued"
                ? "Waiting to start"
                : active
                  ? "Last reported activity"
                  : task.state === "completed"
                    ? "Execution"
                    : "Saved progress"}
            </Typography>
            <Typography variant="h6" sx={{ mt: 0.5 }}>
              {cleanupPending && !["queued", "running"].includes(task.state)
                ? "Awaiting worker cleanup"
                : progress?.stage
                  ? stage
                  : task.state === "queued"
                    ? "Waiting for resources"
                    : task.state === "completed"
                      ? "Task complete"
                      : task.state === "blocked"
                        ? "Task blocked"
                        : "Stage not reported"}
            </Typography>
            {cleanupPending && !["queued", "running"].includes(task.state) && (
              <Typography variant="body2" color="text.secondary">
                Execution has stopped. Resource ownership ends only after the worker cleanup receipt
                is accepted.
              </Typography>
            )}
          </Box>
          {progress?.stageStartedAt && (
            <Typography variant="caption" color="text.secondary">
              {active ? "Current stage" : "Stage duration at stop"}:{" "}
              {elapsedTime(progress.stageStartedAt, observedUntil)}
            </Typography>
          )}
        </Box>
        {task.state === "running" && invocations?.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No model call has been registered. Source preparation can take place before model
            execution.
          </Typography>
        )}
      </Stack>
    );
  return (
    <Stack spacing={2}>
      {queueReason && <Alert severity="info">{queueReason}</Alert>}
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <Chip label={`Stage: ${stage}`} variant="outlined" />
        {progress?.stageStartedAt && (
          <Typography variant="body2">
            {active ? "Current stage elapsed" : "Stage duration at stop"}:{" "}
            {elapsedTime(progress.stageStartedAt, observedUntil)}
          </Typography>
        )}
      </Stack>
      {durations.length > 0 ? (
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Recorded stage totals
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {durations.map(({ name, duration }) => (
              <Chip
                key={name}
                size="small"
                variant="outlined"
                label={`${stageNames[name]}: ${stageDuration(duration)}`}
              />
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Completed intervals across attempts; the active interval is shown separately. Unrecorded
            stages remain unknown.
          </Typography>
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary">
          Recorded stage timings are unavailable.
        </Typography>
      )}
      {invocations
        ?.filter((call) => ["registered", "running"].includes(call.state))
        .map((call) => (
          <Typography variant="body2" key={call.invocationId}>
            {!active
              ? "Last recorded call status"
              : call.state === "registered"
                ? "Model call registered"
                : "Model call running"}
            : {elapsedTime(call.startedAt, observedUntil)} · {call.purpose} ·{" "}
            {call.model ?? call.engine}
          </Typography>
        ))}
      <Box
        component="dl"
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" },
          gap: 2,
          m: 0,
        }}
      >
        {events.map(([label, timestamp]) => (
          <Box key={label}>
            <Typography component="dt" variant="caption" color="text.secondary">
              {label}
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0 }}>
              {timestamp ? new Date(timestamp).toLocaleString() : "Not reported"}
            </Typography>
            {timestamp && active && (
              <Typography variant="caption" color="text.secondary">
                {elapsedTime(timestamp, now)} ago
              </Typography>
            )}
          </Box>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary">
        A worker heartbeat confirms worker communication. It does not establish model activity or
        analysis progress.
      </Typography>
    </Stack>
  );
}
