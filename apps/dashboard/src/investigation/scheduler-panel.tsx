import type { InvestigationSchedulerStatus } from "@agentic-review/contracts";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { investigationApi } from "./api";
import { Section } from "./report-sections";
import { useInvestigationSession } from "./session";

export const schedulerQueryKey = ["investigation-scheduler"] as const;

export function parseStaticConcurrency(value: string): number {
  if (!/^(?:[1-9]|1[0-6])$/u.test(value.trim())) {
    throw new Error("Static concurrency must be a whole number between 1 and 16.");
  }
  return Number(value.trim());
}

export async function submitStaticConcurrency(
  value: string,
  update: (input: { staticConcurrency: number }) => Promise<InvestigationSchedulerStatus>,
): Promise<InvestigationSchedulerStatus> {
  return update({ staticConcurrency: parseStaticConcurrency(value) });
}

export function SchedulerForm({
  status,
  canEdit,
  onSave,
}: {
  status: InvestigationSchedulerStatus;
  canEdit: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(String(status.staticConcurrency));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit || busy) return;
    setBusy(true);
    setSaved(false);
    setError(undefined);
    try {
      parseStaticConcurrency(value);
      await onSave(value);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Concurrency could not be updated.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack component="form" onSubmit={(event) => void submit(event)} spacing={2}>
      <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap" }}>
        <Chip label={`Static: ${status.occupiedStatic} / ${status.staticConcurrency} occupied`} />
        <Chip label={`E2E: ${status.occupiedE2e} / 1 occupied`} />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Static tasks can run concurrently with one E2E task. E2E is globally limited to one task
        until desktop cleanup is confirmed. Reducing the static limit does not cancel running tasks.
      </Typography>
      <TextField
        label="Static task concurrency"
        value={value}
        disabled={!canEdit || busy}
        onChange={(event) => {
          setValue(event.target.value);
          setSaved(false);
        }}
        inputMode="numeric"
        helperText={
          canEdit
            ? "Global limit: 1–16 tasks. Worker capacity may be lower."
            : "Only workspace administrators can change this global limit."
        }
        sx={{ maxWidth: 480 }}
      />
      {canEdit && (
        <Button
          type="submit"
          variant="outlined"
          disabled={busy || value === String(status.staticConcurrency)}
          sx={{ alignSelf: "flex-start" }}
        >
          Save concurrency
        </Button>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {saved && <Alert severity="success">Concurrency saved.</Alert>}
    </Stack>
  );
}

export function SchedulerPanel() {
  const { session } = useInvestigationSession();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: schedulerQueryKey,
    queryFn: investigationApi.scheduler,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  return (
    <Section title="Task concurrency">
      {query.isPending && <CircularProgress size={24} aria-label="Loading task concurrency" />}
      {query.isError && (
        <Alert severity="error">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>Retry scheduler</Button>
        </Alert>
      )}
      {query.data && (
        <Stack spacing={2}>
          <SchedulerForm
            key={query.data.staticConcurrency}
            status={query.data}
            canEdit={session.user?.isAdmin === true}
            onSave={async (value) => {
              const updated = await submitStaticConcurrency(
                value,
                investigationApi.updateScheduler,
              );
              client.setQueryData(schedulerQueryKey, updated);
            }}
          />
          {query.data.leases.some((lease) => lease.state === "needs_cleanup") && (
            <Alert severity="warning">
              The next E2E task is blocked until the previous task's owned processes and desktop
              state are cleaned up.
            </Alert>
          )}
          {query.data.leases.length > 0 && (
            <Box>
              <Typography variant="subtitle2">Resource owners visible to your account</Typography>
              {query.data.leases.map((lease) => (
                <Stack
                  key={lease.attemptId}
                  direction="row"
                  useFlexGap
                  spacing={1}
                  sx={{ flexWrap: "wrap", alignItems: "center", mt: 1 }}
                >
                  <Chip size="small" label={lease.pool === "e2e" ? "E2E" : "Static"} />
                  <Chip
                    size="small"
                    label={lease.state === "needs_cleanup" ? "Needs cleanup" : "Running"}
                    color={lease.state === "needs_cleanup" ? "warning" : "default"}
                  />
                  <Button component={Link} to={`/tasks?taskId=${encodeURIComponent(lease.taskId)}`}>
                    Open task
                  </Button>
                  <Typography variant="caption" color="text.secondary">
                    {lease.workerId}
                    {lease.reason ? ` · ${lease.reason}` : ""}
                  </Typography>
                </Stack>
              ))}
            </Box>
          )}
        </Stack>
      )}
    </Section>
  );
}
