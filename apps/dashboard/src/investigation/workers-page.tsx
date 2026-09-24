import type {
  InvestigationResourceLease,
  InvestigationTaskKind,
  InvestigationWorkerControl,
  InvestigationWorkerControlUpdate,
} from "@agentic-review/contracts";
import { ComputerOutlined, ExpandLess, ExpandMore, Refresh, Search } from "@mui/icons-material";
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
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { investigationApi, type Repository } from "./api";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { schedulerQueryKey } from "./scheduler-panel";
import { useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";
import "./workers-page.css";

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

export type WorkerDirectoryFilter = "all" | "recent" | "not-recent" | "never" | "cleanup";
type PolicyReview = { refreshGeneration: number };

export function workerContactLabel(worker: InvestigationWorkerControl, now = Date.now()): string {
  if (worker.lastSeenAt === null) return "Never contacted";
  return now - Date.parse(worker.lastSeenAt) < 120_000 ? "Recent contact" : "No recent contact";
}

export function workerHasE2eOwnership(worker: InvestigationWorkerControl): boolean {
  return worker.activeE2eTaskIds.length > 0 || worker.cleanupPendingAttemptIds.length > 0;
}

export function workerStatusLabel(worker: InvestigationWorkerControl): string {
  if (worker.status === "disabling") return "Disabling E2E";
  if (worker.status === "awaiting_confirmation")
    return workerHasE2eOwnership(worker)
      ? "Awaiting cleanup confirmation"
      : "Awaiting worker contact";
  if (!worker.e2eEnabled) return "Admission off";
  if (worker.advertisedKinds === null) return "Waiting for worker capabilities";
  return worker.effectiveKinds.some((kind) => kind !== "pr-review" && kind !== "issue-investigate")
    ? "Admission on"
    : "No E2E task types";
}

export function filterWorkers(
  workers: InvestigationWorkerControl[],
  search: string,
  filter: WorkerDirectoryFilter,
  repositories: Repository[] = [],
  now = Date.now(),
): InvestigationWorkerControl[] {
  const term = search.trim().toLocaleLowerCase();
  return workers.filter((worker) => {
    const contact = workerContactLabel(worker, now);
    const matchesFilter =
      filter === "all" ||
      (filter === "recent" && contact === "Recent contact") ||
      (filter === "not-recent" && contact === "No recent contact") ||
      (filter === "never" && worker.lastSeenAt === null) ||
      (filter === "cleanup" &&
        (worker.status === "disabling" ||
          worker.cleanupPendingAttemptIds.length > 0 ||
          (!worker.e2eEnabled && workerHasE2eOwnership(worker))));
    return (
      matchesFilter &&
      (!term ||
        [
          worker.id,
          ...worker.repositoryIds,
          ...worker.activeE2eTaskIds,
          ...worker.cleanupPendingAttemptIds,
          ...repositories
            .filter((repository) => worker.repositoryIds.includes(repository.id))
            .map((repository) => repository.fullName),
          ...worker.effectiveKinds.map((kind) => taskLabels[kind]),
        ].some((value) => value.toLocaleLowerCase().includes(term)))
    );
  });
}

export function workerControlError(cause: unknown): string {
  return cause instanceof InvestigationHttpError && cause.status === 409
    ? "This worker's settings changed. Refresh workers and review the saved policy before changing the switch again."
    : cause instanceof Error
      ? cause.message
      : "The worker setting could not be saved.";
}

export function workerAdmissionInput(
  worker: InvestigationWorkerControl,
  e2eEnabled: boolean,
  expectedVersion: number,
  disableConfirmed = false,
): InvestigationWorkerControlUpdate {
  if (expectedVersion !== worker.version)
    throw new InvestigationHttpError(409, "The worker policy changed while you were reviewing it.");
  if (!e2eEnabled && worker.e2eEnabled && !disableConfirmed)
    throw new Error("Confirm turning off E2E task admission before saving.");
  return { version: expectedVersion, e2eEnabled };
}

function WorkerTimestamp({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}

function WorkerReferences({ ids, empty }: { ids: string[]; empty: string }) {
  return ids.length ? (
    <div className="workers-reference-list">
      {ids.map((id) => (
        <code key={id}>{id}</code>
      ))}
    </div>
  ) : (
    <span>{empty}</span>
  );
}

export function WorkerDisableSummary({ worker }: { worker: InvestigationWorkerControl }) {
  return (
    <Stack spacing={2}>
      <Typography variant="body2">
        {workerHasE2eOwnership(worker)
          ? "New E2E assignments stop. Owned E2E work must stop and clean up. Resources stay occupied until the worker confirms release."
          : "New E2E assignments stop. Eligible static task types remain available."}
      </Typography>
      <dl className="workers-definition">
        <div>
          <dt>Worker</dt>
          <dd>{worker.id}</dd>
        </div>
        <div>
          <dt>Owned E2E tasks</dt>
          <dd>
            <WorkerReferences ids={worker.activeE2eTaskIds} empty="None currently owned" />
          </dd>
        </div>
        <div>
          <dt>Pending cleanup attempts</dt>
          <dd>
            <WorkerReferences ids={worker.cleanupPendingAttemptIds} empty="None recorded" />
          </dd>
        </div>
        <div>
          <dt>Applies to</dt>
          <dd>All repositories assigned to this worker</dd>
        </div>
      </dl>
    </Stack>
  );
}

export function WorkerStaticOwnership({
  workerId,
  leases,
  loading = false,
  error,
  onRetry,
}: {
  workerId: string;
  leases?: InvestigationResourceLease[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const owners = leases?.filter(
    (lease) => lease.workerId === workerId && lease.pool === "static" && lease.state !== "released",
  );
  return (
    <section aria-label="Static resource ownership">
      <Typography component="h3" variant="subtitle2">
        Static resource ownership
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        Scheduler records include only owners within your repository access. They do not establish
        total worker capacity.
      </Typography>
      {loading && leases === undefined && (
        <CircularProgress size={20} aria-label="Loading static ownership" sx={{ mt: 2 }} />
      )}
      {error && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {error}
          {leases && " Last received ownership remains visible; release is unconfirmed."}
          {onRetry && <Button onClick={onRetry}>Retry static ownership</Button>}
        </Alert>
      )}
      {owners?.length ? (
        owners.map((lease) => (
          <div key={lease.attemptId} className="workers-static-owner">
            <Chip
              size="small"
              color={lease.state === "needs_cleanup" ? "warning" : "default"}
              label={lease.state === "needs_cleanup" ? "Needs cleanup" : "Slot held"}
            />
            <dl className="workers-definition">
              <div>
                <dt>Task reference</dt>
                <dd>
                  <code>{lease.taskId}</code>
                </dd>
              </div>
              <div>
                <dt>Attempt reference</dt>
                <dd>
                  <code>{lease.attemptId}</code>
                </dd>
              </div>
              {lease.reason && (
                <div>
                  <dt>Reason</dt>
                  <dd>{lease.reason}</dd>
                </div>
              )}
            </dl>
          </div>
        ))
      ) : leases !== undefined ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          No static resource owners are visible for this worker within your repository access. This
          does not confirm that the worker is idle.
        </Typography>
      ) : !loading && !error ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Static ownership has not been loaded.
        </Typography>
      ) : null}
    </section>
  );
}

export function WorkerControlCard({
  worker,
  repositories = [],
  readableRepositoryIds = [],
  canEdit,
  onSave,
  now = Date.now(),
  expanded,
  onExpandedChange,
  onBusyChange,
  disabled = false,
  refreshGeneration = 0,
  review,
  onReviewChange,
  policyUnavailable = false,
  staticLeases,
  staticOwnershipLoading,
  staticOwnershipError,
  onRetryStaticOwnership,
}: {
  worker: InvestigationWorkerControl;
  repositories?: Repository[];
  readableRepositoryIds?: string[];
  canEdit: boolean;
  onSave: (input: InvestigationWorkerControlUpdate) => Promise<void>;
  now?: number;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  refreshGeneration?: number;
  review?: PolicyReview;
  onReviewChange?: (review: PolicyReview | undefined) => void;
  policyUnavailable?: boolean;
  staticLeases?: InvestigationResourceLease[];
  staticOwnershipLoading?: boolean;
  staticOwnershipError?: string;
  onRetryStaticOwnership?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [localReview, setLocalReview] = useState<PolicyReview>();
  const [saved, setSaved] = useState(false);
  const [confirmationVersion, setConfirmationVersion] = useState<number>();
  const [localExpanded, setLocalExpanded] = useState(false);
  const changing = useRef(false);
  const mounted = useRef(true);
  const contentId = useId();
  const dialogTitleId = useId();
  const detailsOpen = expanded ?? localExpanded;
  const reviewRequired = onReviewChange ? review : localReview;
  const setReview = (value: PolicyReview | undefined) => {
    setLocalReview(value);
    onReviewChange?.(value);
  };
  const pendingCleanup =
    worker.status === "disabling" ||
    worker.cleanupPendingAttemptIds.length > 0 ||
    (worker.status === "awaiting_confirmation" && worker.activeE2eTaskIds.length > 0);
  const locked = !canEdit || busy || disabled || policyUnavailable || !!reviewRequired;
  const permittedRepositories = repositories.filter((repository) =>
    readableRepositoryIds.includes(repository.id),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const change = async (enabled: boolean, version: number, disableConfirmed = false) => {
    if (locked || changing.current || enabled === worker.e2eEnabled || (enabled && pendingCleanup))
      return;
    changing.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(undefined);
    setSaved(false);
    try {
      await onSave(workerAdmissionInput(worker, enabled, version, disableConfirmed));
      if (mounted.current) {
        setSaved(true);
        setConfirmationVersion(undefined);
      }
    } catch (cause) {
      if (mounted.current) {
        setReview({ refreshGeneration });
        setError(workerControlError(cause));
        setConfirmationVersion(undefined);
      }
    } finally {
      changing.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <Surface component="article" className="workers-card" aria-label={`Worker ${worker.id}`}>
      <div className="workers-summary">
        <div className="workers-identity">
          <Box
            className="workers-avatar"
            sx={{ bgcolor: "var(--app-surface-container)", color: "text.secondary" }}
          >
            <ComputerOutlined aria-hidden="true" />
          </Box>
          <div className="workers-name">
            <Typography component="h2" variant="subtitle1">
              {worker.id}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {workerContactLabel(worker, now)}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="div">
              {worker.lastSeenAt ? (
                <>
                  Last contact: <WorkerTimestamp value={worker.lastSeenAt} />
                </>
              ) : (
                "No worker contact recorded."
              )}
            </Typography>
          </div>
        </div>
        <div className="workers-policy">
          <Button
            variant={worker.e2eEnabled ? "outlined" : "contained"}
            disabled={locked || (!worker.e2eEnabled && pendingCleanup)}
            onClick={() =>
              worker.e2eEnabled
                ? setConfirmationVersion(worker.version)
                : void change(true, worker.version)
            }
          >
            {busy ? "Saving…" : worker.e2eEnabled ? "Stop E2E work" : "Allow E2E work"}
          </Button>
          <div className="workers-policy-status">
            <Chip
              size="small"
              label={busy ? "Saving policy…" : workerStatusLabel(worker)}
              color={pendingCleanup ? "warning" : "default"}
            />
          </div>
        </div>
      </div>
      <div className="workers-summary-line">
        <Typography variant="body2" color="text.secondary">
          {worker.repositoryIds.length}{" "}
          {worker.repositoryIds.length === 1 ? "repository" : "repositories"} ·{" "}
          {worker.effectiveKinds.length} effective task types
          {worker.activeE2eTaskIds.length > 0 &&
            ` · ${worker.activeE2eTaskIds.length} owned E2E ${worker.activeE2eTaskIds.length === 1 ? "task" : "tasks"}`}
          {worker.cleanupPendingAttemptIds.length > 0 &&
            ` · ${worker.cleanupPendingAttemptIds.length} pending cleanup ${worker.cleanupPendingAttemptIds.length === 1 ? "attempt" : "attempts"}`}
        </Typography>
      </div>
      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          Only workspace administrators can change this setting.
        </Typography>
      )}
      {pendingCleanup && (
        <Alert severity="warning" className="workers-notice">
          {worker.status === "disabling"
            ? "New E2E assignments are stopped. Running E2E tasks are being cancelled and cleaned up. "
            : "The worker has not confirmed cleanup of its owned E2E resources. "}
          Resources stay reserved until the worker confirms cleanup.
        </Alert>
      )}
      {worker.status === "awaiting_confirmation" && !pendingCleanup && (
        <Alert severity="info" className="workers-notice">
          Waiting for the worker to contact the server. Its availability is not confirmed.
        </Alert>
      )}
      {worker.e2eEnabled &&
        !pendingCleanup &&
        !worker.effectiveKinds.some(
          (kind) => kind !== "pr-review" && kind !== "issue-investigate",
        ) && (
          <Typography variant="body2" color="text.secondary" className="workers-notice">
            Waiting for the worker to report E2E support.
          </Typography>
        )}
      {error && (
        <Alert severity="error" className="workers-notice">
          {error}
        </Alert>
      )}
      {reviewRequired && (
        <Alert severity="warning" className="workers-notice">
          The save was not confirmed. Refresh workers, then review the latest saved policy before
          trying again.
          {refreshGeneration > reviewRequired.refreshGeneration && (
            <Stack spacing={1} sx={{ mt: 1 }}>
              <Typography variant="body2">
                Latest saved policy: admission {worker.e2eEnabled ? "on" : "off"} · version{" "}
                {worker.version} · {workerStatusLabel(worker)}
              </Typography>
              <Button
                disabled={busy || disabled || policyUnavailable}
                sx={{ alignSelf: "flex-start" }}
                onClick={() => {
                  setReview(undefined);
                  setError(undefined);
                }}
              >
                I reviewed the latest policy
              </Button>
            </Stack>
          )}
        </Alert>
      )}
      {saved && !error && (
        <Alert severity="success" className="workers-notice">
          E2E setting saved.
        </Alert>
      )}
      {!onExpandedChange && (
        <Button
          className="workers-detail-toggle"
          disabled={busy || disabled}
          aria-expanded={detailsOpen}
          aria-controls={contentId}
          endIcon={detailsOpen ? <ExpandLess /> : <ExpandMore />}
          onClick={() => {
            setLocalExpanded(!detailsOpen);
          }}
        >
          {detailsOpen ? "Hide details" : "Worker details"}
        </Button>
      )}
      {detailsOpen && (
        <div id={contentId} className="workers-details">
          <section aria-label="Task capabilities">
            <Typography component="h3" variant="subtitle2">
              Task capabilities
            </Typography>
            <dl className="workers-definition">
              <div>
                <dt>Effective task types</dt>
                <dd>
                  {worker.effectiveKinds.length
                    ? worker.effectiveKinds.map((kind) => taskLabels[kind]).join(" · ")
                    : "No confirmed task capabilities."}
                </dd>
              </div>
              <div>
                <dt>Advertised task types</dt>
                <dd>
                  {worker.advertisedKinds === null
                    ? "Not reported"
                    : worker.advertisedKinds.map((kind) => taskLabels[kind]).join(" · ") ||
                      "None reported"}
                </dd>
              </div>
            </dl>
          </section>
          <section aria-label="Repository assignments">
            <Typography component="h3" variant="subtitle2">
              Repository assignments
            </Typography>
            <div className="workers-reference-list workers-repositories">
              {worker.repositoryIds.length ? (
                worker.repositoryIds.map((id) => {
                  const repository = permittedRepositories.find((item) => item.id === id);
                  return repository ? (
                    <Button
                      component={Link}
                      key={id}
                      to={`/repositories?repositoryId=${encodeURIComponent(id)}`}
                      title={id}
                    >
                      {repository.fullName}
                    </Button>
                  ) : (
                    <code key={id}>{id}</code>
                  );
                })
              ) : (
                <Typography variant="body2" color="text.secondary">
                  No repositories assigned.
                </Typography>
              )}
            </div>
          </section>
          <section aria-label="Recorded ownership">
            <Typography component="h3" variant="subtitle2">
              Recorded ownership
            </Typography>
            <dl className="workers-definition">
              <div>
                <dt>Owned E2E tasks</dt>
                <dd>
                  <WorkerReferences ids={worker.activeE2eTaskIds} empty="None recorded" />
                </dd>
              </div>
              <div>
                <dt>Pending cleanup attempts</dt>
                <dd>
                  <WorkerReferences ids={worker.cleanupPendingAttemptIds} empty="None recorded" />
                </dd>
              </div>
            </dl>
          </section>
          <WorkerStaticOwnership
            workerId={worker.id}
            leases={staticLeases}
            loading={staticOwnershipLoading}
            error={staticOwnershipError}
            onRetry={onRetryStaticOwnership}
          />
          <section aria-label="Saved policy record">
            <Typography component="h3" variant="subtitle2">
              Saved policy record
            </Typography>
            <dl className="workers-definition">
              <div>
                <dt>E2E admission</dt>
                <dd>
                  {worker.e2eEnabled ? "Allowed by the server" : "Off · static task admission only"}
                </dd>
              </div>
              <div>
                <dt>Last changed</dt>
                <dd>
                  <WorkerTimestamp value={worker.updatedAt} />
                  {worker.updatedBy ? ` by ${worker.updatedBy}` : " · Default policy"}
                </dd>
              </div>
              <div>
                <dt>Policy version</dt>
                <dd>{worker.version}</dd>
              </div>
              <div>
                <dt>Server status</dt>
                <dd>
                  <code>{worker.status}</code>
                </dd>
              </div>
            </dl>
          </section>
        </div>
      )}
      <Dialog
        open={confirmationVersion !== undefined}
        onClose={() => {
          if (!busy) setConfirmationVersion(undefined);
        }}
        aria-labelledby={dialogTitleId}
        maxWidth="sm"
      >
        <DialogTitle id={dialogTitleId}>Stop E2E work?</DialogTitle>
        <DialogContent>
          <WorkerDisableSummary worker={worker} />
          {confirmationVersion !== undefined && confirmationVersion !== worker.version && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              The saved policy changed while this dialog was open. Close this dialog and review the
              current policy before trying again.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button autoFocus disabled={busy} onClick={() => setConfirmationVersion(undefined)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={locked || confirmationVersion !== worker.version}
            onClick={() => {
              if (confirmationVersion !== undefined) void change(false, confirmationVersion, true);
            }}
          >
            {busy ? "Saving…" : "Stop E2E work"}
          </Button>
        </DialogActions>
      </Dialog>
    </Surface>
  );
}

function AdminWorkersPage({ readableRepositoryIds }: { readableRepositoryIds: string[] }) {
  const client = useQueryClient();
  const [parameters, setParameters] = useSearchParams();
  const [mutationBusy, setMutationBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [refreshMessage, setRefreshMessage] = useState<string>();
  const [reviews, setReviews] = useState<Record<string, PolicyReview | undefined>>({});
  const selectedWorkerId = parameters.get("workerId");
  const mounted = useRef(true);
  const guardAction = useGuardedAction();
  const busy = mutationBusy || refreshing;
  useUnsavedChanges(false, {
    busy: mutationBusy,
    description: "A worker admission change is still being saved.",
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: workersQueryKey,
    queryFn: investigationApi.workers,
    refetchInterval: busy ? false : 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !busy,
  });
  const repositories = useQuery({
    queryKey: ["investigation-repositories"],
    queryFn: investigationApi.repositories,
    enabled: readableRepositoryIds.length > 0,
  });
  const scheduler = useQuery({
    queryKey: schedulerQueryKey,
    queryFn: investigationApi.scheduler,
    enabled: !!selectedWorkerId,
    refetchInterval: selectedWorkerId && !busy ? 5_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !busy,
  });
  const permittedRepositories = (repositories.data?.items ?? []).filter((repository) =>
    readableRepositoryIds.includes(repository.id),
  );
  const search = parameters.get("q") ?? "";
  const requestedFilter = parameters.get("contact") ?? "all";
  const filter: WorkerDirectoryFilter = ["recent", "not-recent", "never", "cleanup"].includes(
    requestedFilter,
  )
    ? (requestedFilter as WorkerDirectoryFilter)
    : "all";
  const visible = filterWorkers(query.data?.items ?? [], search, filter, permittedRepositories);
  const setParameter = (key: string, value: string, replace = false) =>
    guardAction(() => {
      const next = new URLSearchParams(parameters);
      if (value) next.set(key, value);
      else next.delete(key);
      setParameters(next, { replace });
    });
  const resetFilters = () =>
    guardAction(() => {
      const next = new URLSearchParams(parameters);
      next.delete("q");
      next.delete("contact");
      setParameters(next, { replace: true });
    });
  const refresh = async () => {
    if (busy) return;
    setRefreshing(true);
    setRefreshMessage(undefined);
    const [result] = await Promise.all([
      query.refetch(),
      selectedWorkerId ? scheduler.refetch() : Promise.resolve(undefined),
    ]);
    if (!mounted.current) return;
    if (result.isSuccess) {
      setRefreshGeneration((value) => value + 1);
      setRefreshMessage("Worker status updated.");
    }
    setRefreshing(false);
  };
  return (
    <Stack spacing={3} className="workers-page">
      {selectedWorkerId && (
        <Box>
          <Button disabled={busy} onClick={() => setParameter("workerId", "")}>
            Back to workers
          </Button>
        </Box>
      )}
      <PageHeading
        title={selectedWorkerId || "Workers"}
        action={
          <Button
            variant="outlined"
            startIcon={<Refresh />}
            disabled={busy || query.isFetching}
            onClick={() => void refresh()}
          >
            {refreshing ? "Refreshing…" : "Refresh status"}
          </Button>
        }
      />
      {query.isPending && <CircularProgress size={28} aria-label="Loading workers" />}
      {query.isError && (
        <Alert severity="error">
          {query.error.message}
          {query.data &&
            " Showing the last loaded worker records; their current state is unconfirmed."}
        </Alert>
      )}
      {repositories.isError && readableRepositoryIds.length > 0 && (
        <Alert severity="warning">
          Repository names could not be loaded. Assigned repository IDs are still available.
        </Alert>
      )}
      {refreshMessage && (
        <Typography role="status" variant="body2" color="text.secondary">
          {refreshMessage}
        </Typography>
      )}
      {query.data && (
        <>
          {!selectedWorkerId && (
            <Surface className="workers-toolbar" sx={{ p: 2 }}>
              <TextField
                label="Search workers"
                placeholder="Worker, repository or ownership ID"
                value={search}
                disabled={busy}
                onChange={(event) => setParameter("q", event.target.value, true)}
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <Search aria-hidden="true" />
                      </InputAdornment>
                    ),
                  },
                }}
              />
              <TextField
                select
                label="Contact and E2E cleanup"
                value={filter}
                disabled={busy}
                onChange={(event) => setParameter("contact", event.target.value, true)}
              >
                <MenuItem value="all">All workers</MenuItem>
                <MenuItem value="recent">Recent contact</MenuItem>
                <MenuItem value="not-recent">No recent contact</MenuItem>
                <MenuItem value="never">Never contacted</MenuItem>
                <MenuItem value="cleanup">E2E cleanup pending</MenuItem>
              </TextField>
              <Typography variant="body2" color="text.secondary" className="workers-count">
                {visible.length} {visible.length === 1 ? "worker" : "workers"}
              </Typography>
              {(search || filter !== "all") && (
                <Button onClick={resetFilters}>Clear filters</Button>
              )}
            </Surface>
          )}
          {selectedWorkerId &&
            !query.data.items.some((worker) => worker.id === selectedWorkerId) && (
              <Alert severity="info">This worker is not in the current directory.</Alert>
            )}
          {query.data.items.length === 0 ? (
            <EmptyState title="No workers registered" icon={<ComputerOutlined />} />
          ) : !selectedWorkerId && visible.length === 0 ? (
            <EmptyState
              title="No workers match this view"
              action={<Button onClick={resetFilters}>Show all workers</Button>}
              icon={<Search />}
            />
          ) : !selectedWorkerId ? (
            <Surface sx={{ overflow: "hidden" }}>
              <div className="workers-table-wrap">
                <table className="workers-table">
                  <thead>
                    <tr>
                      {["Worker", "Current E2E tasks", "E2E work", "Actions"].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((worker) => (
                      <tr key={worker.id}>
                        <td data-label="Worker">
                          <Button
                            className="workers-table-link"
                            onClick={() => setParameter("workerId", worker.id)}
                          >
                            {worker.id}
                          </Button>
                          <Typography variant="caption" color="text.secondary" component="div">
                            {workerContactLabel(worker)}
                          </Typography>
                        </td>
                        <td data-label="Current E2E tasks">
                          {worker.activeE2eTaskIds.length || "—"}
                          {worker.cleanupPendingAttemptIds.length > 0 && (
                            <Typography variant="caption" color="warning.main" component="div">
                              {worker.cleanupPendingAttemptIds.length} awaiting cleanup
                            </Typography>
                          )}
                        </td>
                        <td data-label="E2E work">
                          <Chip
                            size="small"
                            label={workerStatusLabel(worker)}
                            color={
                              workerHasE2eOwnership(worker) && !worker.e2eEnabled
                                ? "warning"
                                : "default"
                            }
                          />
                        </td>
                        <td data-label="Actions">
                          <Button size="small" onClick={() => setParameter("workerId", worker.id)}>
                            {worker.cleanupPendingAttemptIds.length
                              ? "Cleanup status"
                              : "View worker"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Surface>
          ) : (
            <div className="workers-directory">
              {query.data.items
                .filter((worker) => worker.id === selectedWorkerId)
                .map((worker) => (
                  <WorkerControlCard
                    key={worker.id}
                    worker={worker}
                    repositories={permittedRepositories}
                    readableRepositoryIds={readableRepositoryIds}
                    canEdit
                    disabled={busy}
                    policyUnavailable={query.isError}
                    refreshGeneration={refreshGeneration}
                    expanded={selectedWorkerId === worker.id}
                    staticLeases={scheduler.data?.leases}
                    staticOwnershipLoading={scheduler.isPending}
                    staticOwnershipError={scheduler.isError ? scheduler.error.message : undefined}
                    onRetryStaticOwnership={() => {
                      if (!busy) void scheduler.refetch();
                    }}
                    onExpandedChange={(open) => setParameter("workerId", open ? worker.id : "")}
                    onBusyChange={(value) => {
                      if (mounted.current) setMutationBusy(value);
                    }}
                    review={reviews[worker.id]}
                    onReviewChange={(review) =>
                      setReviews((current) => ({ ...current, [worker.id]: review }))
                    }
                    onSave={async (input) => {
                      await client.cancelQueries({ queryKey: workersQueryKey });
                      const updated = await investigationApi.updateWorkerE2e(worker.id, input);
                      if (!mounted.current) return;
                      await client.cancelQueries({ queryKey: workersQueryKey });
                      if (!mounted.current) return;
                      client.setQueryData<Awaited<ReturnType<typeof investigationApi.workers>>>(
                        workersQueryKey,
                        (current) =>
                          current
                            ? {
                                items: current.items.map((item) =>
                                  item.id === updated.id ? updated : item,
                                ),
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
            </div>
          )}
        </>
      )}
    </Stack>
  );
}

export default function WorkersPage() {
  const { session } = useInvestigationSession();
  if (!session.authenticated || !session.user.isAdmin)
    return (
      <Stack spacing={3}>
        <PageHeading title="Workers" />
        <EmptyState
          title="Administrator access is required"
          description="Only workspace administrators can manage worker admission across repositories."
        />
      </Stack>
    );
  return <AdminWorkersPage readableRepositoryIds={session.user.repositoryIds} />;
}
