import type {
  InvestigationWebhookDelivery,
  InvestigationWebhookDeliveryQuery,
} from "@agentic-review/contracts";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { investigationApi } from "./api";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { InvestigationHttpError } from "./transport";

type WebhookFilters = Omit<InvestigationWebhookDeliveryQuery, "cursor" | "limit">;

export const webhookDeliveryQueryKey = (deliveryId: string) => [
  "investigation-webhook-delivery",
  deliveryId,
];
export const webhookDeliveriesQueryKey = (query: InvestigationWebhookDeliveryQuery) => [
  "investigation-webhook-deliveries",
  query,
];

const stateLabels = {
  accepted: "Accepted",
  source_ready: "Source ready",
  completed: "Processed",
  ignored: "Ignored",
  failed: "Failed",
} as const;
const stateColors = {
  accepted: "info",
  source_ready: "info",
  completed: "success",
  ignored: "default",
  failed: "error",
} as const;
const attemptLabels = {
  processing: "Processing",
  retrying: "Retry scheduled",
  completed: "Processed",
  failed: "Failed",
  ignored: "Ignored",
  interrupted: "Interrupted",
} as const;
const phaseLabels = {
  authorization: "Authorization",
  source: "Source import",
  task: "Task creation",
  recovery: "Recovery",
} as const;

export function webhookDeliveryFilters(search: string): WebhookFilters {
  const parameters = new URLSearchParams(search);
  const number = parameters.get("number");
  const state = parameters.get("state");
  const kind = parameters.get("kind");
  const mode = parameters.get("mode");
  return {
    ...(parameters.get("repositoryId") ? { repositoryId: parameters.get("repositoryId")! } : {}),
    ...(number && /^[1-9][0-9]*$/u.test(number) && Number.isSafeInteger(Number(number))
      ? { number: Number(number) }
      : {}),
    ...(kind === "pull_request" || kind === "issue" ? { kind } : {}),
    ...(mode === "static" || mode === "e2e" ? { mode } : {}),
    ...(["accepted", "source_ready", "completed", "ignored", "failed"].includes(state ?? "")
      ? { state: state as InvestigationWebhookDeliveryQuery["state"] }
      : {}),
  };
}

export function webhookDetailsUrl(deliveryId: string, repositoryId: string): string {
  return `/webhooks?repositoryId=${encodeURIComponent(repositoryId)}&deliveryId=${encodeURIComponent(deliveryId)}`;
}

export function webhookPollingInterval(
  items: readonly InvestigationWebhookDelivery[],
  now = Date.now(),
): number | false {
  const pending = items.filter(
    (item) => item.state === "accepted" || item.state === "source_ready",
  );
  if (pending.length === 0) return false;
  return Math.min(
    ...pending.map((item) =>
      item.nextAttemptAt
        ? Math.max(5_000, Math.min(30_000, Date.parse(item.nextAttemptAt) - now + 1_000))
        : 5_000,
    ),
  );
}

export function webhookRetryErrorMessage(cause: unknown): string {
  return cause instanceof InvestigationHttpError && cause.status === 409
    ? "This event changed. Refresh its status before retrying event handling."
    : cause instanceof Error
      ? cause.message
      : "Event handling could not be scheduled.";
}

function RecordedTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}

function TaskLink({ taskId, repositoryId }: { taskId: string; repositoryId: string }) {
  return (
    <Button
      size="small"
      component={Link}
      to={`/tasks?repositoryId=${encodeURIComponent(repositoryId)}&taskId=${encodeURIComponent(taskId)}`}
    >
      Open task
    </Button>
  );
}

function WebhookStatus({ delivery }: { delivery: InvestigationWebhookDelivery }) {
  return (
    <Chip size="small" label={stateLabels[delivery.state]} color={stateColors[delivery.state]} />
  );
}

export function WebhookDeliveryHistory({ items }: { items: InvestigationWebhookDelivery[] }) {
  if (items.length === 0)
    return <Typography color="text.secondary">No webhook events match these filters.</Typography>;
  return (
    <Stack spacing={1.5}>
      {items.map((delivery) => (
        <Box
          key={delivery.deliveryId}
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            p: 2,
            overflowWrap: "anywhere",
          }}
        >
          <Stack spacing={1}>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ alignItems: "center", flexWrap: "wrap" }}
            >
              <WebhookStatus delivery={delivery} />
              <Typography variant="subtitle2">
                {delivery.mode === "e2e" ? "E2E" : "Static"} · {delivery.eventName}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <RecordedTime value={delivery.receivedAt} />
              </Typography>
            </Stack>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ alignItems: "center", flexWrap: "wrap" }}
            >
              <Button
                size="small"
                component={Link}
                to={webhookDetailsUrl(delivery.deliveryId, delivery.repositoryId)}
              >
                {delivery.repositoryFullName} · {delivery.kind === "pull_request" ? "PR" : "Issue"}{" "}
                #{delivery.number}
              </Button>
              {delivery.taskId ? (
                <TaskLink taskId={delivery.taskId} repositoryId={delivery.repositoryId} />
              ) : (
                <Typography variant="caption" color="text.secondary">
                  No task linked
                </Typography>
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Delivery {delivery.deliveryId} · {delivery.totalAttempts} recorded attempts
            </Typography>
            {delivery.reason && (
              <Typography
                variant="body2"
                color={delivery.state === "failed" ? "error" : "text.secondary"}
              >
                {delivery.reason}
              </Typography>
            )}
            {delivery.nextAttemptAt && (
              <Typography variant="caption" color="text.secondary">
                Next attempt <RecordedTime value={delivery.nextAttemptAt} />
              </Typography>
            )}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

export function WebhookAttemptHistory({ delivery }: { delivery: InvestigationWebhookDelivery }) {
  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Event handling attempts</Typography>
      <Typography variant="body2" color="text.secondary">
        Current cycle attempts: {delivery.attempts}; total recorded: {delivery.totalAttempts}.
      </Typography>
      {delivery.attemptHistory.length === 0 && (
        <Typography color="text.secondary">No handling attempts recorded yet.</Typography>
      )}
      {delivery.attemptHistory.map((attempt) => (
        <Box key={attempt.id} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}>
          <Stack spacing={1}>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ alignItems: "center", flexWrap: "wrap" }}
            >
              <Typography variant="subtitle2">Attempt {attempt.number}</Typography>
              <Chip
                size="small"
                label={attemptLabels[attempt.state]}
                color={
                  attempt.state === "failed"
                    ? "error"
                    : attempt.state === "completed"
                      ? "success"
                      : "default"
                }
              />
              <Typography variant="body2">{phaseLabels[attempt.phase]}</Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Cycle attempt {attempt.cycleAttempt} · Started{" "}
              <RecordedTime value={attempt.startedAt} />
              {attempt.finishedAt ? (
                <>
                  {" "}
                  · Finished <RecordedTime value={attempt.finishedAt} />
                </>
              ) : (
                " · No completion recorded"
              )}
            </Typography>
            {attempt.reason && (
              <Typography
                variant="body2"
                color={attempt.state === "failed" ? "error" : "text.secondary"}
              >
                {attempt.reason}
              </Typography>
            )}
            {attempt.taskId && (
              <TaskLink taskId={attempt.taskId} repositoryId={delivery.repositoryId} />
            )}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

export function WebhookRetryControls({ delivery }: { delivery: InvestigationWebhookDelivery }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const active = useRef(false);
  const commandKeys = useRef(new Map<string, string>());
  const refresh = async () => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await queryClient.cancelQueries({ queryKey: webhookDeliveryQueryKey(delivery.deliveryId) });
      const updated = await investigationApi.webhookDelivery(delivery.deliveryId);
      await queryClient.cancelQueries({ queryKey: webhookDeliveryQueryKey(delivery.deliveryId) });
      queryClient.setQueryData(webhookDeliveryQueryKey(delivery.deliveryId), updated);
      await queryClient.invalidateQueries({ queryKey: ["investigation-webhook-deliveries"] });
      setStale(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The event status could not be refreshed.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const retry = async () => {
    if (active.current || stale || !delivery.availableActions.includes("retry")) return;
    active.current = true;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    const idempotencyKey = commandKeys.current.get(delivery.version) ?? crypto.randomUUID();
    commandKeys.current.set(delivery.version, idempotencyKey);
    try {
      await queryClient.cancelQueries({ queryKey: webhookDeliveryQueryKey(delivery.deliveryId) });
      const updated = await investigationApi.retryWebhookDelivery(delivery.deliveryId, {
        version: delivery.version,
        idempotencyKey,
      });
      await queryClient.cancelQueries({ queryKey: webhookDeliveryQueryKey(delivery.deliveryId) });
      queryClient.setQueryData(webhookDeliveryQueryKey(delivery.deliveryId), updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: webhookDeliveryQueryKey(delivery.deliveryId) }),
        queryClient.invalidateQueries({ queryKey: ["investigation-webhook-deliveries"] }),
      ]);
      setMessage(
        "Event handling retry scheduled. An existing task will be linked without rerunning it.",
      );
    } catch (cause) {
      setStale(cause instanceof InvestigationHttpError && cause.status === 409);
      setError(webhookRetryErrorMessage(cause));
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <WebhookStatus delivery={delivery} />
        <Button size="small" disabled={busy} onClick={() => void refresh()}>
          Refresh status
        </Button>
        {delivery.availableActions.includes("retry") && (
          <Button
            size="small"
            variant="outlined"
            disabled={busy || stale}
            onClick={() => void retry()}
          >
            Retry event handling
          </Button>
        )}
      </Stack>
      {delivery.reason && (
        <Typography
          variant="body2"
          color={delivery.state === "failed" ? "error" : "text.secondary"}
        >
          {delivery.reason}
        </Typography>
      )}
      {delivery.nextAttemptAt && (
        <Typography variant="caption" color="text.secondary">
          Next attempt <RecordedTime value={delivery.nextAttemptAt} />
        </Typography>
      )}
      {delivery.availableActions.includes("retry") && (
        <Typography variant="body2" color="text.secondary">
          Retry resumes event handling and checks for an existing task first. It does not rerun an
          existing task or retry a GitHub comment delivery.
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {message && <Alert severity="success">{message}</Alert>}
    </Stack>
  );
}

export function WebhookDeliveryDetails({ deliveryId }: { deliveryId: string }) {
  const scope = useInvestigationRepositoryScope();
  const query = useQuery({
    queryKey: webhookDeliveryQueryKey(deliveryId),
    queryFn: () => investigationApi.webhookDelivery(deliveryId),
    refetchInterval: (current) =>
      webhookPollingInterval(current.state.data ? [current.state.data] : []),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  if (query.isPending) return <CircularProgress size={28} aria-label="Loading webhook event" />;
  if (query.isError)
    return (
      <Alert severity="error">
        {query.error.message}
        <Button onClick={() => void query.refetch()}>Refresh event</Button>
      </Alert>
    );
  const delivery = query.data;
  if (scope.repositoryId && delivery.repositoryId !== scope.repositoryId)
    return <Alert severity="warning">This event does not belong to the selected repository.</Alert>;
  return (
    <Stack spacing={3}>
      <Box sx={{ overflowWrap: "anywhere" }}>
        <Typography variant="overline">
          {delivery.repositoryFullName} · {delivery.kind === "pull_request" ? "PR" : "Issue"} #
          {delivery.number}
        </Typography>
        <Typography variant="h4">Webhook event</Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          {delivery.mode === "e2e" ? "E2E" : "Static"} · {delivery.eventName} ·{" "}
          {delivery.deliveryId}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Received <RecordedTime value={delivery.receivedAt} /> · Actor {delivery.actorUserId} ·
          Assignee {delivery.assigneeUserId}
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ mt: 2, alignItems: "center", flexWrap: "wrap" }}
        >
          <Button
            component={Link}
            to={`/webhooks?repositoryId=${encodeURIComponent(delivery.repositoryId)}`}
          >
            All webhook events
          </Button>
          {delivery.taskId ? (
            <TaskLink taskId={delivery.taskId} repositoryId={delivery.repositoryId} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              No task linked
            </Typography>
          )}
          {delivery.canonicalDeliveryId !== delivery.deliveryId && (
            <Button
              component={Link}
              to={webhookDetailsUrl(delivery.canonicalDeliveryId, delivery.repositoryId)}
            >
              Open canonical event
            </Button>
          )}
        </Stack>
      </Box>
      <Alert severity="info">
        Processed means event handling finished. Task execution and GitHub comment delivery have
        separate outcomes.
      </Alert>
      <WebhookRetryControls key={delivery.deliveryId} delivery={delivery} />
      <WebhookAttemptHistory delivery={delivery} />
    </Stack>
  );
}

export function WebhookDeliveryHistoryPanel({ filters }: { filters: WebhookFilters }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const queryInput = { ...filters, cursor: cursors.at(-1), limit: 25 };
  const query = useQuery({
    queryKey: webhookDeliveriesQueryKey(queryInput),
    queryFn: () => investigationApi.webhookDeliveries(queryInput),
    refetchInterval: (current) => webhookPollingInterval(current.state.data?.items ?? []),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center" }}>
        <Typography variant="subtitle1">Webhook event history</Typography>
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh history
        </Button>
      </Stack>
      {query.isPending && <CircularProgress size={24} aria-label="Loading webhook events" />}
      {query.isError && <Alert severity="error">{query.error.message}</Alert>}
      {query.data && <WebhookDeliveryHistory items={query.data.items} />}
      {(cursors.length > 1 || query.data?.nextCursor) && (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Button
            disabled={cursors.length === 1 || query.isFetching}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            Previous
          </Button>
          <Typography variant="caption">Page {cursors.length}</Typography>
          <Button
            disabled={!query.data?.nextCursor || query.isFetching}
            onClick={() => {
              const next = query.data?.nextCursor;
              if (next) setCursors((value) => [...value, next]);
            }}
          >
            Next
          </Button>
        </Stack>
      )}
    </Stack>
  );
}

export default function WebhookDeliveriesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const parameters = new URLSearchParams(location.search);
  const deliveryId = parameters.get("deliveryId");
  const filters = webhookDeliveryFilters(location.search);
  if (deliveryId) return <WebhookDeliveryDetails key={deliveryId} deliveryId={deliveryId} />;
  const clearUrl = `/webhooks${filters.repositoryId ? `?repositoryId=${encodeURIComponent(filters.repositoryId)}` : ""}`;
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4">Webhook events</Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Received GitHub events, task creation outcomes, and event handling attempts. Task
          execution and comment delivery are tracked separately.
        </Typography>
      </Box>
      <Box
        key={location.search}
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const next = new URLSearchParams();
          if (filters.repositoryId) next.set("repositoryId", filters.repositoryId);
          for (const key of ["kind", "number", "state", "mode"]) {
            const value = String(data.get(key) ?? "").trim();
            if (value) next.set(key, value);
          }
          navigate({ pathname: "/webhooks", search: next.toString() });
        }}
      >
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          sx={{ alignItems: { md: "center" }, flexWrap: "wrap" }}
        >
          <TextField
            name="kind"
            select
            label="Target type"
            size="small"
            defaultValue={filters.kind ?? ""}
            sx={{ minWidth: 170 }}
          >
            <MenuItem value="">All targets</MenuItem>
            <MenuItem value="pull_request">Pull requests</MenuItem>
            <MenuItem value="issue">Issues</MenuItem>
          </TextField>
          <TextField
            name="number"
            label="PR or Issue number"
            size="small"
            defaultValue={filters.number ?? ""}
            type="number"
            slotProps={{ htmlInput: { min: 1, step: 1 } }}
            sx={{ width: { md: 190 } }}
          />
          <TextField
            name="state"
            select
            label="Event status"
            size="small"
            defaultValue={filters.state ?? ""}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">All statuses</MenuItem>
            <MenuItem value="accepted">Accepted</MenuItem>
            <MenuItem value="source_ready">Source ready</MenuItem>
            <MenuItem value="completed">Processed</MenuItem>
            <MenuItem value="ignored">Ignored</MenuItem>
            <MenuItem value="failed">Failed</MenuItem>
          </TextField>
          <TextField
            name="mode"
            select
            label="Task mode"
            size="small"
            defaultValue={filters.mode ?? ""}
            sx={{ minWidth: 130 }}
          >
            <MenuItem value="">All modes</MenuItem>
            <MenuItem value="static">Static</MenuItem>
            <MenuItem value="e2e">E2E</MenuItem>
          </TextField>
          <Button type="submit" variant="outlined">
            Apply filters
          </Button>
          <Button component={Link} to={clearUrl}>
            Clear
          </Button>
        </Stack>
      </Box>
      <WebhookDeliveryHistoryPanel key={JSON.stringify(filters)} filters={filters} />
    </Stack>
  );
}
