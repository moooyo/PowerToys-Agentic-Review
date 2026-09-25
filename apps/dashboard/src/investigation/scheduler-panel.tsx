import type { InvestigationSchedulerStatus } from "@agentic-review/contracts";
import DesktopWindowsRounded from "@mui/icons-material/DesktopWindowsRounded";
import HourglassTopRounded from "@mui/icons-material/HourglassTopRounded";
import TuneRounded from "@mui/icons-material/TuneRounded";
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
import { type FormEvent, useEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { investigationApi } from "./api";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { Section } from "./report-sections";
import { useInvestigationSession } from "./session";

export const schedulerQueryKey = ["investigation-scheduler"] as const;
const staticSlotOrdinals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

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

export interface SchedulerDraft {
  value: string;
  baseline: number;
  latest: number;
}

export function createSchedulerDraft(value: number): SchedulerDraft {
  return { value: String(value), baseline: value, latest: value };
}

export function isSchedulerDraftDirty(draft: SchedulerDraft): boolean {
  return draft.value.trim() !== String(draft.latest);
}

export function schedulerDraftReducer(
  draft: SchedulerDraft,
  action:
    | { type: "discard" }
    | { type: "edit"; value: string }
    | { type: "receive" | "reset" | "saved"; value: number },
): SchedulerDraft {
  if (action.type === "discard") return createSchedulerDraft(draft.latest);
  if (action.type === "edit") {
    return action.value.trim() === String(draft.latest)
      ? createSchedulerDraft(draft.latest)
      : { ...draft, value: action.value };
  }
  if (action.type === "receive") {
    if (action.value === draft.latest) return draft;
    if (isSchedulerDraftDirty(draft) && draft.value.trim() !== String(action.value)) {
      return { ...draft, latest: action.value };
    }
  }
  return createSchedulerDraft(action.value);
}

export function SchedulerForm({
  status,
  canEdit,
  onSave,
  onReload,
}: {
  status: InvestigationSchedulerStatus;
  canEdit: boolean;
  onSave: (value: string) => Promise<InvestigationSchedulerStatus | void>;
  onReload?: () => Promise<InvestigationSchedulerStatus>;
}) {
  const [draft, dispatch] = useReducer(
    schedulerDraftReducer,
    status.staticConcurrency,
    createSchedulerDraft,
  );
  const [busy, setBusy] = useState<"save" | "reload">();
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [savedValue, setSavedValue] = useState<number>();
  const dirty = isSchedulerDraftDirty(draft);
  const remoteChanged = draft.latest !== draft.baseline;
  const guardedAction = useGuardedAction();

  useEffect(() => {
    dispatch({ type: "receive", value: status.staticConcurrency });
  }, [status.staticConcurrency]);

  useUnsavedChanges(dirty, {
    busy: busy !== undefined,
    description: "Your unsaved global task concurrency change will be discarded.",
  });

  const reset = () => {
    if (busyRef.current) return;
    dispatch({ type: "discard" });
    setError(undefined);
    setFieldError(undefined);
    setSavedValue(undefined);
  };

  const reload = async () => {
    if (!onReload || busyRef.current) return;
    busyRef.current = true;
    setBusy("reload");
    setError(undefined);
    setSavedValue(undefined);
    try {
      const updated = await onReload();
      dispatch({ type: "reset", value: updated.staticConcurrency });
      setFieldError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Scheduler status could not be reloaded.");
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit || busyRef.current || !dirty) return;
    let concurrency: number;
    try {
      concurrency = parseStaticConcurrency(draft.value);
    } catch (cause) {
      setFieldError(cause instanceof Error ? cause.message : "Enter a whole number from 1 to 16.");
      inputRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy("save");
    setSavedValue(undefined);
    setError(undefined);
    setFieldError(undefined);
    try {
      const updated = await onSave(draft.value);
      const savedConcurrency = updated ? updated.staticConcurrency : concurrency;
      dispatch({ type: "saved", value: savedConcurrency });
      setSavedValue(savedConcurrency);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Concurrency could not be updated.");
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  };

  return (
    <Section title="Static concurrency">
      <Stack component="form" noValidate onSubmit={(event) => void submit(event)} spacing={3}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          sx={{ alignItems: { xs: "flex-start", sm: "center" }, justifyContent: "space-between" }}
        >
          <Chip label="All repositories" size="small" />
        </Stack>
        <Box sx={{ maxWidth: 640 }}>
          <Stack
            direction="row"
            spacing={2}
            sx={{ alignItems: "center", justifyContent: "space-between" }}
          >
            <Typography color="text.secondary">Static investigations</Typography>
            <Typography sx={{ fontSize: 22, fontWeight: 500, whiteSpace: "nowrap" }}>
              {status.occupiedStatic}
              <Typography component="span" variant="body2" color="text.secondary">
                {` / ${status.staticConcurrency} occupied`}
              </Typography>
            </Typography>
          </Stack>
          <Box
            role="img"
            aria-label={`${status.occupiedStatic} of ${status.staticConcurrency} static slots occupied`}
            sx={{ display: "flex", gap: 0.75, height: 10, mt: 1.75 }}
          >
            {staticSlotOrdinals.slice(0, status.staticConcurrency).map((slotOrdinal) => (
              <Box
                key={slotOrdinal}
                aria-hidden="true"
                sx={{
                  flex: 1,
                  borderRadius: 1,
                  bgcolor:
                    slotOrdinal <= status.occupiedStatic ? "primary.main" : "action.selected",
                }}
              />
            ))}
          </Box>
        </Box>
        {status.occupiedStatic > status.staticConcurrency && (
          <Alert severity="info">
            Occupied slots exceed the limit. Existing slots stay reserved until released.
          </Alert>
        )}
        <TextField
          label="Maximum concurrent static investigations"
          value={draft.value}
          disabled={!canEdit || busy !== undefined}
          inputRef={inputRef}
          onChange={(event) => {
            dispatch({ type: "edit", value: event.target.value });
            setSavedValue(undefined);
            setFieldError(undefined);
          }}
          onBlur={() => {
            if (!dirty) return;
            try {
              parseStaticConcurrency(draft.value);
              setFieldError(undefined);
            } catch (cause) {
              setFieldError(
                cause instanceof Error ? cause.message : "Enter a whole number from 1 to 16.",
              );
            }
          }}
          error={fieldError !== undefined}
          slotProps={{ htmlInput: { inputMode: "numeric" } }}
          helperText={
            fieldError ??
            (canEdit
              ? "Whole number from 1 to 16."
              : "Only workspace administrators can change this global limit.")
          }
          sx={{ maxWidth: 640 }}
        />
        <Typography variant="body2" color="text.secondary">
          Lowering the limit lets running work finish.
        </Typography>
        {remoteChanged && (
          <Alert
            severity="warning"
            action={
              <Button disabled={busy !== undefined} onClick={() => guardedAction(reset)}>
                Use saved value
              </Button>
            }
          >
            The saved limit changed from {draft.baseline} to {draft.latest}. Saving replaces it with
            your draft.
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {savedValue === draft.latest && <Alert severity="success">Concurrency saved.</Alert>}
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          sx={{
            alignItems: { xs: "stretch", sm: "center" },
            justifyContent: "space-between",
            pt: 2,
            borderTop: "1px solid",
            borderColor: "divider",
          }}
        >
          <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
            <TuneRounded color={dirty ? "primary" : "disabled"} />
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {busy === "save"
                  ? "Saving…"
                  : busy === "reload"
                    ? "Reloading…"
                    : dirty
                      ? "Unsaved change"
                      : "Saved"}
              </Typography>
            </Box>
          </Stack>
          <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap" }}>
            {onReload && (
              <Button
                disabled={busy !== undefined}
                onClick={() => guardedAction(() => void reload())}
              >
                Reload
              </Button>
            )}
            {canEdit && (
              <>
                <Button
                  disabled={busy !== undefined || !dirty}
                  onClick={() => guardedAction(reset)}
                >
                  Discard changes
                </Button>
                <Button
                  type="submit"
                  variant="contained"
                  disabled={busy !== undefined || !dirty}
                  startIcon={
                    busy === "save" ? <CircularProgress size={16} color="inherit" /> : undefined
                  }
                >
                  Save changes
                </Button>
              </>
            )}
          </Stack>
        </Stack>
      </Stack>
    </Section>
  );
}

export function SchedulerPanel() {
  const { session } = useInvestigationSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const guardedAction = useGuardedAction();
  const query = useQuery({
    queryKey: schedulerQueryKey,
    queryFn: investigationApi.scheduler,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const owners = query.data?.leases.filter((lease) => lease.state !== "released") ?? [];
  const e2eCleanupPending = owners.some(
    (lease) => lease.pool === "e2e" && lease.state === "needs_cleanup",
  );

  return (
    <Stack spacing={3}>
      {query.isPending && <CircularProgress size={24} aria-label="Loading global scheduler" />}
      {query.isError && (
        <Alert severity="error">
          {query.error.message}
          {query.data && " The last received occupancy remains visible until a refresh succeeds."}
          <Button onClick={() => void query.refetch()}>Retry scheduler</Button>
        </Alert>
      )}
      {query.data && (
        <>
          <SchedulerForm
            status={query.data}
            canEdit={session.user?.isAdmin === true}
            onSave={async (value) => {
              await client.cancelQueries({ queryKey: schedulerQueryKey });
              const updated = await submitStaticConcurrency(
                value,
                investigationApi.updateScheduler,
              );
              await client.cancelQueries({ queryKey: schedulerQueryKey });
              client.setQueryData(schedulerQueryKey, updated);
              return updated;
            }}
            onReload={async () => {
              const result = await query.refetch();
              if (result.error) throw result.error;
              if (!result.data) throw new Error("Scheduler status is unavailable.");
              return result.data;
            }}
          />
          <Section title="E2E capacity">
            <Stack spacing={2}>
              <Stack
                direction="row"
                useFlexGap
                spacing={2}
                sx={{ flexWrap: "wrap", alignItems: "center" }}
              >
                <DesktopWindowsRounded color="action" />
                <Box sx={{ minWidth: 170, flex: 1 }}>
                  <Typography sx={{ fontWeight: 500 }}>
                    {`${query.data.occupiedE2e} / ${query.data.e2eConcurrency} occupied`}
                  </Typography>
                  {(e2eCleanupPending || query.data.occupiedE2e > 0) && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {e2eCleanupPending
                        ? "Waiting for worker cleanup confirmation."
                        : "Reserved until cleanup is confirmed."}
                    </Typography>
                  )}
                </Box>
                <Chip
                  label={
                    e2eCleanupPending
                      ? "Cleanup pending"
                      : query.data.occupiedE2e > 0
                        ? "In use"
                        : "Unoccupied"
                  }
                  color={e2eCleanupPending ? "warning" : "default"}
                  size="small"
                />
              </Stack>
              {e2eCleanupPending && (
                <Alert severity="warning">The next E2E task waits until cleanup finishes.</Alert>
              )}
            </Stack>
          </Section>
          <Section title="Current resource owners">
            {owners.length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
                Within your repository access
              </Typography>
            )}
            {owners.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No resource owners within your repository access.
              </Typography>
            ) : (
              <Stack component="ul" spacing={0} sx={{ m: 0, p: 0, listStyle: "none" }}>
                {owners.map((lease) => {
                  const taskPath = `/tasks?taskId=${encodeURIComponent(lease.taskId)}`;
                  return (
                    <Stack
                      component="li"
                      key={lease.attemptId}
                      direction={{ xs: "column", sm: "row" }}
                      spacing={2}
                      sx={{
                        alignItems: { xs: "stretch", sm: "center" },
                        py: 2,
                        borderBottom: "1px solid",
                        borderColor: "divider",
                        "&:first-of-type": { pt: 0 },
                        "&:last-of-type": { borderBottom: 0, pb: 0 },
                      }}
                    >
                      <Stack
                        direction="row"
                        spacing={2}
                        sx={{ alignItems: "center", flex: 1, minWidth: 0 }}
                      >
                        {lease.state === "needs_cleanup" ? (
                          <HourglassTopRounded color="warning" />
                        ) : (
                          <TuneRounded color="action" />
                        )}
                        <Box sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {lease.taskId}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {`${lease.pool === "e2e" ? "E2E" : "Static"} · ${lease.workerId} · ${lease.state === "needs_cleanup" ? "Needs cleanup" : "Slot held"}`}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            component="div"
                            sx={{ mt: 0.5 }}
                          >
                            {`Attempt: ${lease.attemptId}`}
                            {lease.reason ? ` · ${lease.reason}` : ""}
                          </Typography>
                        </Box>
                      </Stack>
                      <Button
                        component={Link}
                        to={taskPath}
                        aria-label={`Open task ${lease.taskId}`}
                        onClick={(event) => {
                          if (
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          ) {
                            return;
                          }
                          event.preventDefault();
                          guardedAction(() => navigate(taskPath));
                        }}
                        sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}
                      >
                        Open task
                      </Button>
                    </Stack>
                  );
                })}
              </Stack>
            )}
          </Section>
        </>
      )}
    </Stack>
  );
}
