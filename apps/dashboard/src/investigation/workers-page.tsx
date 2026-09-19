import type { InvestigationTaskKind, InvestigationWorkerControl } from "@agentic-review/contracts";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { investigationApi, type Repository } from "./api";
import { schedulerQueryKey } from "./scheduler-panel";
import { useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";

export const workersQueryKey = ["investigation-workers"] as const;

const taskLabels: Record<InvestigationTaskKind, string> = {
  "pr-review": "PR review",
  "issue-investigate": "Issue analysis",
  "pr-e2e": "PR E2E",
  "pr-verify": "PR verification",
  "issue-verify": "Issue verification",
  "reproduction-setup": "Reproduction setup",
  "issue-fix": "Issue fix",
  "feature-implement": "Feature implementation",
};

export function workerStatusLabel(worker: InvestigationWorkerControl): string {
  if (worker.status === "disabling") return "Disabling E2E";
  if (worker.status === "awaiting_confirmation")
    return worker.activeE2eTaskIds.length || worker.cleanupPendingAttemptIds.length
      ? "Awaiting cleanup confirmation"
      : "Awaiting worker contact";
  if (!worker.e2eEnabled) return "Static only";
  if (worker.advertisedKinds === null) return "Waiting for worker capabilities";
  return worker.effectiveKinds.some((kind) => kind !== "pr-review" && kind !== "issue-investigate")
    ? "E2E allowed"
    : "Static capability";
}

export function workerControlError(cause: unknown): string {
  return cause instanceof InvestigationHttpError && cause.status === 409
    ? "This worker's settings changed. Refresh workers before changing the switch again."
    : cause instanceof Error
      ? cause.message
      : "The worker setting could not be saved.";
}

export function WorkerControlCard({
  worker,
  repositories = [],
  canEdit,
  onSave,
  now = Date.now(),
}: {
  worker: InvestigationWorkerControl;
  repositories?: Repository[];
  canEdit: boolean;
  onSave: (enabled: boolean) => Promise<void>;
  now?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [staleVersion, setStaleVersion] = useState<number>();
  const [saved, setSaved] = useState(false);
  const changing = useRef(false);
  const pendingCleanup =
    worker.status === "disabling" ||
    (worker.status === "awaiting_confirmation" &&
      (worker.activeE2eTaskIds.length > 0 || worker.cleanupPendingAttemptIds.length > 0));
  const stale = staleVersion === worker.version;
  const recentlySeen = worker.lastSeenAt !== null && now - Date.parse(worker.lastSeenAt) <= 120_000;
  const change = async (enabled: boolean) => {
    if (!canEdit || changing.current || stale || enabled === worker.e2eEnabled) return;
    changing.current = true;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await onSave(enabled);
      setSaved(true);
    } catch (cause) {
      if (cause instanceof InvestigationHttpError && cause.status === 409)
        setStaleVersion(worker.version);
      setError(workerControlError(cause));
    } finally {
      changing.current = false;
      setBusy(false);
    }
  };
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack spacing={2}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          sx={{ justifyContent: "space-between", alignItems: { sm: "center" } }}
        >
          <Box>
            <Typography variant="h6" sx={{ overflowWrap: "anywhere" }}>
              {worker.id}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {worker.repositoryIds.length
                ? worker.repositoryIds
                    .map(
                      (id) =>
                        repositories.find((repository) => repository.id === id)?.fullName ?? id,
                    )
                    .join(", ")
                : "No repositories assigned"}
            </Typography>
          </Box>
          <Chip
            size="small"
            label={workerStatusLabel(worker)}
            color={pendingCleanup ? "warning" : worker.e2eEnabled ? "info" : "default"}
          />
        </Stack>
        <FormControlLabel
          control={
            <Switch
              checked={worker.e2eEnabled}
              disabled={!canEdit || busy || stale}
              onChange={(_event, checked) => void change(checked)}
              slotProps={{ input: { "aria-label": `Allow E2E on ${worker.id}` } }}
            />
          }
          label="Allow E2E"
        />
        <Typography variant="body2" color="text.secondary">
          {worker.e2eEnabled
            ? "E2E is permitted by the server. The worker must also advertise the required task type."
            : "New tasks are limited to static PR review and Issue analysis."}
        </Typography>
        {!canEdit && (
          <Typography variant="body2" color="text.secondary">
            Only workspace administrators can change this setting.
          </Typography>
        )}
        {pendingCleanup && (
          <Alert severity="warning">
            {worker.status === "awaiting_confirmation"
              ? "The worker has not confirmed desktop cleanup. E2E remains blocked until its owned resources are released."
              : "New E2E assignments are stopped. Running E2E tasks are being cancelled and cleaned up."}
          </Alert>
        )}
        {worker.status === "awaiting_confirmation" && !pendingCleanup && (
          <Alert severity="info">
            Waiting for the worker to contact the server. Its availability is not confirmed.
          </Alert>
        )}
        <Box>
          <Typography variant="subtitle2">Effective task types</Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
            {worker.effectiveKinds.length ? (
              worker.effectiveKinds.map((kind) => (
                <Chip key={kind} size="small" variant="outlined" label={taskLabels[kind]} />
              ))
            ) : (
              <Typography variant="body2" color="text.secondary">
                No confirmed task capabilities.
              </Typography>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            Advertised by worker:{" "}
            {worker.advertisedKinds === null
              ? "Not reported"
              : worker.advertisedKinds.map((kind) => taskLabels[kind]).join(", ") || "None"}
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary">
          {worker.lastSeenAt ? (
            <>
              {recentlySeen ? "Recently contacted" : "No recent contact"} · Last contact{" "}
              <time dateTime={worker.lastSeenAt} title={worker.lastSeenAt}>
                {new Date(worker.lastSeenAt).toLocaleString()}
              </time>
            </>
          ) : (
            "No worker contact recorded."
          )}
        </Typography>
        {worker.activeE2eTaskIds.length > 0 && (
          <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap" }}>
            {worker.activeE2eTaskIds.map((id) => (
              <Button key={id} component={Link} to={`/tasks?taskId=${encodeURIComponent(id)}`}>
                Open E2E task {id}
              </Button>
            ))}
          </Stack>
        )}
        {worker.cleanupPendingAttemptIds.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            Attempts awaiting cleanup: {worker.cleanupPendingAttemptIds.join(", ")}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          Setting last changed{" "}
          <time dateTime={worker.updatedAt} title={worker.updatedAt}>
            {new Date(worker.updatedAt).toLocaleString()}
          </time>
          {worker.updatedBy ? ` by ${worker.updatedBy}` : ""}
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {saved && !error && <Alert severity="success">Worker setting saved.</Alert>}
      </Stack>
    </Paper>
  );
}

function AdminWorkersPage() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: workersQueryKey,
    queryFn: investigationApi.workers,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const repositories = useQuery({
    queryKey: ["investigation-repositories"],
    queryFn: investigationApi.repositories,
  });
  return (
    <Stack spacing={3}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <Box>
          <Typography variant="h4">Workers</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            Choose which workers can run E2E. Static task images and videos are not published to
            GitHub.
          </Typography>
        </Box>
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh workers
        </Button>
      </Stack>
      {query.isPending && <CircularProgress size={28} aria-label="Loading workers" />}
      {query.isError && <Alert severity="error">{query.error.message}</Alert>}
      {query.data?.items.length === 0 && (
        <Alert severity="info">No workers have been registered in this workspace.</Alert>
      )}
      {query.data?.items.map((worker) => (
        <WorkerControlCard
          key={worker.id}
          worker={worker}
          repositories={repositories.data?.items}
          canEdit
          onSave={async (e2eEnabled) => {
            await client.cancelQueries({ queryKey: workersQueryKey });
            const updated = await investigationApi.updateWorkerE2e(worker.id, {
              version: worker.version,
              e2eEnabled,
            });
            await client.cancelQueries({ queryKey: workersQueryKey });
            client.setQueryData<Awaited<ReturnType<typeof investigationApi.workers>>>(
              workersQueryKey,
              (current) =>
                current
                  ? {
                      items: current.items.map((item) => (item.id === updated.id ? updated : item)),
                    }
                  : { items: [updated] },
            );
            await Promise.all([
              client.invalidateQueries({ queryKey: workersQueryKey }),
              client.invalidateQueries({ queryKey: schedulerQueryKey }),
              client.invalidateQueries({ queryKey: ["investigation-tasks"] }),
            ]);
          }}
        />
      ))}
    </Stack>
  );
}

export default function WorkersPage() {
  const { session } = useInvestigationSession();
  if (!session.authenticated || !session.user.isAdmin)
    return <Alert severity="warning">Administrator access is required to manage workers.</Alert>;
  return <AdminWorkersPage />;
}
