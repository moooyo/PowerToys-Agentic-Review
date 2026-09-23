import type {
  InvestigationReportHeaderV1,
  InvestigationSessionUser,
  InvestigationTaskV1,
  InvestigationWebhookDelivery,
  InvestigationWebhookDeliveryQuery,
} from "@agentic-review/contracts";
import ArrowForwardRounded from "@mui/icons-material/ArrowForwardRounded";
import FilterListRounded from "@mui/icons-material/FilterListRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import WebhookRounded from "@mui/icons-material/WebhookRounded";
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
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { investigationApi } from "./api";
import { GithubSourceLink as GitHubSourceLink } from "./github-source-link";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";
import { webhookReasonDescription } from "./webhook-reason";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";
import "./webhook-activity.css";

type WebhookFilters = Omit<InvestigationWebhookDeliveryQuery, "cursor" | "limit">;
export const webhookDeliveryQueryKey = (deliveryId: string) => [
  "investigation-webhook-delivery",
  deliveryId,
];
export const webhookDeliveriesQueryKey = (query: InvestigationWebhookDeliveryQuery) => [
  "investigation-webhook-deliveries",
  query,
];
export const webhookRecoveryQueryKey = (deliveryId: string) => [
  "investigation-webhook-recovery",
  deliveryId,
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

export function webhookRecoveryGrantProblem(
  delivery: InvestigationWebhookDelivery,
  user: InvestigationSessionUser | null | undefined,
): string | null {
  if (!user?.repositoryIds.includes(delivery.repositoryId))
    return "This account does not have access to this repository.";
  if (!user.permissions.includes("repository:manage") || !user.permissions.includes("task:create"))
    return "Recovery requires repository management and task creation access.";
  if (delivery.mode === "e2e" && !user.allowRepositoryExecution)
    return "Recovery of this E2E event also requires repository execution access.";
  return null;
}

export function webhookCanStartRecovery(delivery: InvestigationWebhookDelivery): boolean {
  return (
    delivery.canonicalDeliveryId === delivery.deliveryId &&
    delivery.state === "failed" &&
    !delivery.nextAttemptAt &&
    delivery.availableActions.includes("retry")
  );
}

export interface WebhookRecoveryRequest {
  deliveryId: string;
  repositoryId: string;
  version: string;
  idempotencyKey: string;
  requestedAt: string;
  transmissions: number;
  state: "submitting" | "unknown" | "conflict" | "refreshed" | "accepted" | "rejected";
  message: string;
}

export function createWebhookRecoveryRequest(
  delivery: InvestigationWebhookDelivery,
  idempotencyKey: string = crypto.randomUUID(),
  requestedAt: string = new Date().toISOString(),
): WebhookRecoveryRequest {
  return {
    deliveryId: delivery.deliveryId,
    repositoryId: delivery.repositoryId,
    version: delivery.version,
    idempotencyKey,
    requestedAt,
    transmissions: 0,
    state: "submitting",
    message: "Submitting the reviewed recovery request.",
  };
}

/** SessionProvider clears this cache when the account or its grants change. */
function useWebhookRecoveryRequest(deliveryId: string) {
  return (
    useQuery<WebhookRecoveryRequest | null>({
      queryKey: webhookRecoveryQueryKey(deliveryId),
      queryFn: () => null,
      initialData: null,
      enabled: false,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? null
  );
}

/** A response from an old session must not recreate data after its cache was cleared. */
export async function submitWebhookRecoveryRequest(
  queryClient: QueryClient,
  request: WebhookRecoveryRequest,
): Promise<void> {
  const key = webhookRecoveryQueryKey(request.deliveryId);
  const owner = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  if (!owner) return;
  const retained = queryClient.getQueryData<WebhookRecoveryRequest | null>(key);
  if (retained?.state === "submitting") return;
  if (retained?.state === "conflict" || retained?.state === "rejected") return;
  if (
    retained?.state === "accepted" &&
    request.idempotencyKey === retained.idempotencyKey &&
    request.version === retained.version
  )
    return;
  if (
    retained?.state === "unknown" &&
    (request.state !== "unknown" ||
      request.idempotencyKey !== retained.idempotencyKey ||
      request.version !== retained.version ||
      request.repositoryId !== retained.repositoryId)
  )
    return;
  const current: WebhookRecoveryRequest = {
    ...request,
    transmissions: request.transmissions + 1,
    state: "submitting",
    message: "Submitting the saved recovery request.",
  };
  const isCurrentSession = () =>
    queryClient.getQueryCache().find({ queryKey: key, exact: true }) === owner;
  queryClient.setQueryData(key, current);
  try {
    await queryClient.cancelQueries({ queryKey: webhookDeliveryQueryKey(request.deliveryId) });
    if (!isCurrentSession()) return;
    const updated = await investigationApi.retryWebhookDelivery(request.deliveryId, {
      version: request.version,
      idempotencyKey: request.idempotencyKey,
    });
    if (!isCurrentSession()) return;
    if (updated.deliveryId !== request.deliveryId || updated.repositoryId !== request.repositoryId)
      throw new Error(
        "The recovery response did not match the saved event. Its outcome remains unconfirmed.",
      );
    await queryClient.cancelQueries({ queryKey: webhookDeliveryQueryKey(request.deliveryId) });
    if (!isCurrentSession()) return;
    queryClient.setQueryData(webhookDeliveryQueryKey(request.deliveryId), updated);
    queryClient.setQueryData(key, {
      ...current,
      state: "accepted",
      message:
        "The server confirmed this recovery request. Task execution and comment delivery have separate outcomes.",
    } satisfies WebhookRecoveryRequest);
    void queryClient.invalidateQueries({ queryKey: ["investigation-webhook-deliveries"] });
    void queryClient.invalidateQueries({ queryKey: webhookDeliveryQueryKey(request.deliveryId) });
  } catch (cause) {
    if (!isCurrentSession()) return;
    const conflict = cause instanceof InvestigationHttpError && cause.status === 409;
    const rejected =
      cause instanceof InvestigationHttpError && [400, 401, 403, 404, 422].includes(cause.status);
    queryClient.setQueryData(key, {
      ...current,
      state: conflict ? "conflict" : rejected ? "rejected" : "unknown",
      message: conflict
        ? "The receipt changed or the command was rejected. Load the latest status, then review recovery again."
        : rejected
          ? webhookRetryErrorMessage(cause)
          : "The recovery response was not confirmed. The request may have been accepted. Check the event or resend the same saved request.",
    } satisfies WebhookRecoveryRequest);
  }
}

export async function refreshWebhookRecoveryRequest(
  queryClient: QueryClient,
  deliveryId: string,
): Promise<void> {
  const key = webhookRecoveryQueryKey(deliveryId);
  const owner = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  if (!owner) return;
  const before = queryClient.getQueryData<WebhookRecoveryRequest | null>(key);
  if (before?.state === "submitting") return;
  const isCurrentSession = () =>
    queryClient.getQueryCache().find({ queryKey: key, exact: true }) === owner &&
    queryClient.getQueryData(key) === before;
  await queryClient.cancelQueries({ queryKey: webhookDeliveryQueryKey(deliveryId) });
  if (!isCurrentSession()) return;
  const updated = await investigationApi.webhookDelivery(deliveryId);
  if (!isCurrentSession()) return;
  const request = queryClient.getQueryData<WebhookRecoveryRequest | null>(key);
  if (
    updated.deliveryId !== deliveryId ||
    (request && updated.repositoryId !== request.repositoryId)
  )
    throw new Error("The refreshed receipt does not match this event.");
  await queryClient.cancelQueries({ queryKey: webhookDeliveryQueryKey(deliveryId) });
  if (!isCurrentSession()) return;
  queryClient.setQueryData(webhookDeliveryQueryKey(deliveryId), updated);
  if (request?.state === "conflict" || request?.state === "rejected") {
    queryClient.setQueryData(key, {
      ...request,
      state: "refreshed",
      message:
        "The latest receipt is loaded. Review its currently available recovery action before submitting a new request.",
    } satisfies WebhookRecoveryRequest);
  } else if (request?.state === "unknown") {
    queryClient.setQueryData(key, {
      ...request,
      message:
        "The latest event status is loaded. Reading the event cannot confirm this saved command; its version and request identity are preserved for resending.",
    } satisfies WebhookRecoveryRequest);
  }
  void queryClient.invalidateQueries({ queryKey: ["investigation-webhook-deliveries"] });
}

function RecordedTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}

function TaskLink({
  taskId,
  repositoryId,
  children = "Open task",
}: {
  taskId: string;
  repositoryId: string;
  children?: ReactNode;
}) {
  return (
    <Button
      size="small"
      component={Link}
      to={`/tasks?repositoryId=${encodeURIComponent(repositoryId)}&taskId=${encodeURIComponent(taskId)}`}
    >
      {children}
    </Button>
  );
}

function WebhookStatus({ delivery }: { delivery: InvestigationWebhookDelivery }) {
  return (
    <Chip size="small" label={stateLabels[delivery.state]} color={stateColors[delivery.state]} />
  );
}

function EventSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Surface sx={{ p: { xs: 2, sm: 3 }, minWidth: 0 }}>
      <Typography variant="h6" component="h2" sx={{ mb: description ? 0.5 : 2 }}>
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {description}
        </Typography>
      )}
      {children}
    </Surface>
  );
}

function WebhookRecoveryFlag({ deliveryId }: { deliveryId: string }) {
  const request = useWebhookRecoveryRequest(deliveryId);
  if (!request || !["submitting", "unknown", "conflict"].includes(request.state)) return null;
  return (
    <Typography variant="caption" color="warning.main">
      {request.state === "submitting"
        ? "Recovery request in progress"
        : request.state === "unknown"
          ? "Recovery request unconfirmed"
          : "Recovery needs review"}
    </Typography>
  );
}

export function WebhookDeliveryHistory({
  items,
  emptyAction,
  showRecoveryRequests = false,
}: {
  items: InvestigationWebhookDelivery[];
  emptyAction?: ReactNode;
  showRecoveryRequests?: boolean;
}) {
  if (items.length === 0)
    return (
      <EmptyState
        title="No events match"
        description="No webhook events match these filters."
        icon={<WebhookRounded />}
        action={emptyAction}
      />
    );
  return (
    <Box className="webhook-record-list">
      {items.map((delivery) => (
        <Box
          key={delivery.deliveryId}
          className="webhook-record"
          sx={{ borderColor: "divider", "&:hover": { bgcolor: "action.hover" } }}
        >
          <Box
            className="webhook-record-symbol"
            sx={{
              color: delivery.state === "failed" ? "error.main" : "primary.main",
              bgcolor: "action.hover",
            }}
          >
            <WebhookRounded fontSize="small" />
          </Box>
          <Box className="webhook-record-main">
            <Typography variant="caption" color="text.secondary">
              {delivery.repositoryFullName} ·{" "}
              {delivery.mode === "e2e" ? "E2E verification" : "Static review"}
            </Typography>
            <Typography
              component={Link}
              className="webhook-record-link"
              to={webhookDetailsUrl(delivery.deliveryId, delivery.repositoryId)}
              sx={{ color: "text.primary" }}
            >
              {delivery.kind === "pull_request" ? "Pull request" : "Issue"} #{delivery.number} ·{" "}
              {delivery.eventName}
            </Typography>
            {delivery.reason && (
              <Typography
                variant="body2"
                color="text.secondary"
                className="webhook-record-description"
              >
                {webhookReasonDescription(delivery.reason)}
              </Typography>
            )}
            <Stack
              direction="row"
              useFlexGap
              spacing={1}
              sx={{ flexWrap: "wrap", alignItems: "center" }}
            >
              {delivery.taskId ? (
                <TaskLink taskId={delivery.taskId} repositoryId={delivery.repositoryId} />
              ) : (
                <Typography variant="caption" color="text.secondary">
                  No task linked
                </Typography>
              )}
              {delivery.canonicalDeliveryId !== delivery.deliveryId && (
                <Typography variant="caption" color="text.secondary">
                  Duplicate receipt
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                {delivery.totalAttempts} recorded attempts
              </Typography>
            </Stack>
          </Box>
          <Box className="webhook-record-state">
            <WebhookStatus delivery={delivery} />
            {showRecoveryRequests && <WebhookRecoveryFlag deliveryId={delivery.deliveryId} />}
            <Typography variant="caption" color="text.secondary">
              <RecordedTime value={delivery.receivedAt} />
            </Typography>
            {delivery.nextAttemptAt && (
              <Typography variant="caption" color="text.secondary">
                Next attempt <RecordedTime value={delivery.nextAttemptAt} />
              </Typography>
            )}
          </Box>
          <ArrowForwardRounded
            aria-hidden
            className="webhook-record-arrow"
            sx={{ color: "text.secondary", fontSize: 18 }}
          />
        </Box>
      ))}
    </Box>
  );
}

export function WebhookAttemptHistory({ delivery }: { delivery: InvestigationWebhookDelivery }) {
  const history = [...delivery.attemptHistory].sort((left, right) => right.number - left.number);
  return (
    <EventSection
      title="Handling timeline"
      description={`Current cycle attempts: ${delivery.attempts}; total recorded: ${delivery.totalAttempts}. Latest first.`}
    >
      {history.length === 0 ? (
        <Typography color="text.secondary">No handling attempts recorded yet.</Typography>
      ) : (
        <Box component="ol" className="webhook-timeline">
          {history.map((attempt) => (
            <Box
              component="li"
              key={attempt.id}
              sx={{
                borderColor: "divider",
                "&::before": {
                  bgcolor: attempt.state === "failed" ? "error.main" : "primary.main",
                },
              }}
            >
              <Stack
                direction="row"
                useFlexGap
                spacing={1}
                sx={{ alignItems: "center", flexWrap: "wrap" }}
              >
                <Typography variant="subtitle2">
                  Attempt {attempt.number} · {attemptLabels[attempt.state]}
                </Typography>
                <Chip size="small" variant="outlined" label={phaseLabels[attempt.phase]} />
              </Stack>
              <Typography variant="caption" color="text.secondary">
                <RecordedTime value={attempt.startedAt} />
              </Typography>
              {attempt.reason && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 1, whiteSpace: "pre-wrap" }}
                >
                  {webhookReasonDescription(attempt.reason)}
                </Typography>
              )}
              <Box component="details" className="webhook-disclosure">
                <Box component="summary" sx={{ color: "primary.main" }}>
                  Attempt details
                </Box>
                <Box component="dl" className="webhook-metadata">
                  {attempt.reason && (
                    <div>
                      <dt>Recorded reason</dt>
                      <dd>
                        <code>{attempt.reason}</code>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Phase</dt>
                    <dd>{phaseLabels[attempt.phase]}</dd>
                  </div>
                  <div>
                    <dt>Current cycle attempt</dt>
                    <dd>{attempt.cycleAttempt}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>
                      <RecordedTime value={attempt.startedAt} />
                    </dd>
                  </div>
                  <div>
                    <dt>Finished</dt>
                    <dd>
                      {attempt.finishedAt ? (
                        <RecordedTime value={attempt.finishedAt} />
                      ) : (
                        "No completion recorded"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Task association</dt>
                    <dd>{attempt.taskId ?? "No task recorded for this attempt"}</dd>
                  </div>
                </Box>
                {attempt.taskId && (
                  <TaskLink taskId={attempt.taskId} repositoryId={delivery.repositoryId}>
                    Open this attempt's task
                  </TaskLink>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </EventSection>
  );
}

export function WebhookRetryControls({
  delivery,
  user,
  snapshotStale = false,
}: {
  delivery: InvestigationWebhookDelivery;
  user?: InvestigationSessionUser | null;
  snapshotStale?: boolean;
}) {
  const queryClient = useQueryClient();
  const request = useWebhookRecoveryRequest(delivery.deliveryId);
  const [previewVersion, setPreviewVersion] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef(false);
  const busy = request?.state === "submitting";
  const unknown = request?.state === "unknown";
  const stale = request?.state === "conflict" || request?.state === "rejected";
  const grantProblem = webhookRecoveryGrantProblem(delivery, user);
  const retryOffered = webhookCanStartRecovery(delivery);
  const canReplay = delivery.canonicalDeliveryId === delivery.deliveryId && !grantProblem;
  const canReview =
    retryOffered && !grantProblem && !unknown && !stale && !snapshotStale && !busy && !refreshing;
  useUnsavedChanges(previewVersion !== null, {
    description: "A webhook recovery preview is open. Leave without scheduling it?",
    onDiscard: () => setPreviewVersion(null),
  });
  const refresh = async () => {
    if (active.current || busy) return;
    active.current = true;
    setRefreshing(true);
    setError(undefined);
    setPreviewVersion(null);
    try {
      await refreshWebhookRecoveryRequest(queryClient, delivery.deliveryId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The event status could not be refreshed.");
    } finally {
      active.current = false;
      setRefreshing(false);
    }
  };
  const submit = (saved?: WebhookRecoveryRequest) => {
    if (active.current || busy || grantProblem) return;
    if (
      saved
        ? saved.state !== "unknown" || !canReplay
        : !canReview || previewVersion !== delivery.version
    )
      return;
    setPreviewVersion(null);
    setError(undefined);
    void submitWebhookRecoveryRequest(queryClient, saved ?? createWebhookRecoveryRequest(delivery));
  };
  const nextStep =
    delivery.canonicalDeliveryId !== delivery.deliveryId
      ? "This duplicate has no independent recovery action. Continue from the canonical event."
      : delivery.state === "completed"
        ? "Event intake is complete. If the linked task needs attention, use that task's recovery options. Publication status is tracked separately."
        : delivery.nextAttemptAt
          ? "An automatic attempt is already scheduled. Manual recovery is unavailable while intake is pending."
          : delivery.state === "ignored"
            ? "Read the recorded reason before changing intake settings. This event remains in history."
            : retryOffered
              ? "Recovery checks for a committed task first. If one exists, it restores the association and keeps the task's execution state."
              : "No recovery action is currently available for this receipt.";
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Button
          startIcon={<RefreshRounded />}
          disabled={busy || refreshing}
          onClick={() => void refresh()}
        >
          {refreshing
            ? "Checking status…"
            : stale
              ? "Load latest status"
              : unknown
                ? "Refresh event status"
                : "Refresh status"}
        </Button>
        {unknown && request ? (
          <Button
            variant="outlined"
            disabled={busy || refreshing || !canReplay}
            onClick={() => submit(request)}
          >
            Resend saved request
          </Button>
        ) : (
          retryOffered && (
            <Button
              variant="contained"
              disabled={!canReview}
              onClick={() => setPreviewVersion(delivery.version)}
            >
              Retry event handling
            </Button>
          )
        )}
      </Stack>
      {request && (
        <Alert
          severity={
            unknown || stale ? "warning" : request.state === "accepted" ? "success" : "info"
          }
        >
          <Typography variant="subtitle2">
            {busy
              ? "Recovery request in progress"
              : unknown
                ? "Recovery request unconfirmed"
                : stale
                  ? "Review the latest event"
                  : request.state === "refreshed"
                    ? "Current status loaded"
                    : "Recovery request confirmed"}
          </Typography>
          {request.message}
          {busy && " You can return to this event to see the retained request."}
        </Alert>
      )}
      {unknown && (
        <Typography variant="body2" color="text.secondary">
          No second recovery operation can be started while this request is unconfirmed. Resending
          uses its original version and request identity, even if the displayed event has changed.
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        {nextStep}
      </Typography>
      {retryOffered && (
        <Typography variant="body2" color="text.secondary">
          Retry resumes event handling. It does not rerun an existing task or retry a GitHub comment
          delivery.
        </Typography>
      )}
      {(retryOffered || unknown) && grantProblem && (
        <Alert severity="warning">
          {grantProblem} Reading the event history remains available.
        </Alert>
      )}
      {delivery.nextAttemptAt && (
        <Typography variant="body2" color="text.secondary">
          Next attempt <RecordedTime value={delivery.nextAttemptAt} />
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {request && (
        <Box component="details" className="webhook-disclosure">
          <Box component="summary" sx={{ color: "primary.main" }}>
            Recovery request details
          </Box>
          <Box component="dl" className="webhook-metadata">
            <div>
              <dt>Requested</dt>
              <dd>
                <RecordedTime value={request.requestedAt} />
              </dd>
            </div>
            <div>
              <dt>Request delivery</dt>
              <dd>
                {request.transmissions === 1
                  ? "Sent once"
                  : `Same request sent ${request.transmissions} times`}
              </dd>
            </div>
            <div>
              <dt>Confirmation</dt>
              <dd>
                {request.state === "accepted"
                  ? "Confirmed by the server"
                  : request.state === "conflict" ||
                      request.state === "refreshed" ||
                      request.state === "rejected"
                    ? "Request rejected; review current status"
                    : "Not yet confirmed"}
              </dd>
            </div>
          </Box>
        </Box>
      )}
      <Dialog
        open={previewVersion !== null}
        onClose={() => setPreviewVersion(null)}
        maxWidth="sm"
        fullWidth
        aria-labelledby="webhook-recovery-title"
      >
        <DialogTitle id="webhook-recovery-title">Retry event handling?</DialogTitle>
        <DialogContent>
          <Box
            sx={{ bgcolor: "action.hover", p: 2, borderRadius: 2, mb: 2, overflowWrap: "anywhere" }}
          >
            <Typography variant="overline">Event to recover</Typography>
            <Typography variant="subtitle1">
              {delivery.repositoryFullName} · {delivery.kind === "pull_request" ? "PR" : "Issue"} #
              {delivery.number}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {delivery.eventName} ·{" "}
              {delivery.mode === "e2e" ? "E2E verification" : "Static review"}
            </Typography>
          </Box>
          <Box component="ol" className="webhook-recovery-steps">
            <li>Recheck this receipt and your current repository permissions.</li>
            <li>
              {delivery.taskId
                ? "Find and restore the existing task association without restarting its execution."
                : "Look for an existing committed task before continuing source preparation or creating work."}
            </li>
            <li>Continue configured progress publication only when repository policy allows it.</li>
          </Box>
          <Alert severity="warning">
            Recovery preserves earlier handling attempts. It does not restart a failed task or
            resend a failed comment. If no committed task exists, intake may create work and
            configured comments.
          </Alert>
          {previewVersion !== null && previewVersion !== delivery.version && (
            <Alert severity="error" sx={{ mt: 2 }}>
              This receipt changed while the preview was open. Refresh its status and review it
              again.
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ flexWrap: "wrap", gap: 1, px: 3, pb: 2 }}>
          <Button onClick={() => setPreviewVersion(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!canReview || previewVersion !== delivery.version}
            onClick={() => submit()}
          >
            Schedule recovery
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export function webhookTaskMatches(
  delivery: InvestigationWebhookDelivery,
  task: InvestigationTaskV1,
): boolean {
  const expectedKind =
    delivery.mode === "e2e"
      ? "pr-e2e"
      : delivery.kind === "pull_request"
        ? "pr-review"
        : "issue-investigate";
  return (
    delivery.taskId === task.id &&
    delivery.repositoryId === task.repository.id &&
    delivery.kind === task.workItem.kind &&
    delivery.number === task.workItem.number &&
    task.kind === expectedKind
  );
}

export function webhookReportMatches(
  delivery: InvestigationWebhookDelivery,
  task: InvestigationTaskV1,
  report: InvestigationReportHeaderV1,
): boolean {
  const reference = task.latestReportRef;
  return (
    reference !== null &&
    webhookTaskMatches(delivery, task) &&
    report.context.task.id === task.id &&
    report.context.task.kind === task.kind &&
    report.context.repository.id === task.repository.id &&
    report.context.workItem.id === task.workItem.id &&
    report.context.workItem.kind === task.workItem.kind &&
    report.context.workItem.number === task.workItem.number &&
    report.context.task.subjectRef === task.subjectRef &&
    report.report.id === reference.id &&
    report.report.version === reference.version &&
    report.report.logicalContentDigest === reference.digest
  );
}

function WebhookLinkedContext({ delivery }: { delivery: InvestigationWebhookDelivery }) {
  const query = useQuery({
    queryKey: ["investigation-webhook-linked-task", delivery.repositoryId, delivery.taskId],
    queryFn: () => investigationApi.task(delivery.taskId!),
    enabled: !!delivery.taskId,
  });
  const task =
    query.data?.task && webhookTaskMatches(delivery, query.data.task) ? query.data.task : undefined;
  const report =
    task &&
    query.data?.latestReport &&
    webhookReportMatches(delivery, task, query.data.latestReport)
      ? query.data.latestReport
      : undefined;
  return (
    <Stack spacing={1}>
      <Typography variant="body2" color="text.secondary">
        Source and associated work
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <GitHubSourceLink
          repositoryFullName={delivery.repositoryFullName}
          kind={delivery.kind}
          number={delivery.number}
        />
        {task && (
          <Button
            component={Link}
            to={`/${delivery.kind === "pull_request" ? "pull-requests" : "issues"}?repositoryId=${encodeURIComponent(delivery.repositoryId)}&workItemId=${encodeURIComponent(task.workItem.id)}`}
          >
            Open review source
          </Button>
        )}
        {delivery.taskId ? (
          <TaskLink taskId={delivery.taskId} repositoryId={delivery.repositoryId}>
            {task ? `Open task · ${task.state}` : "Open task"}
          </TaskLink>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No task linked
          </Typography>
        )}
        {task && (
          <Button
            component={Link}
            to={`/comments?repositoryId=${encodeURIComponent(delivery.repositoryId)}&taskId=${encodeURIComponent(task.id)}`}
          >
            Open comment publications
          </Button>
        )}
        {report && (
          <Button
            component={Link}
            to={`/reports?repositoryId=${encodeURIComponent(delivery.repositoryId)}&reportId=${encodeURIComponent(report.report.id)}`}
          >
            Open task report
          </Button>
        )}
      </Stack>
      {task &&
        ["failed", "blocked", "interrupted", "cancelled"].includes(task.state) &&
        delivery.state === "completed" && (
          <Alert severity="warning">
            Intake is complete; the linked task needs attention. Review its own recovery options.
          </Alert>
        )}
      {query.isError && (
        <Typography variant="body2" color="text.secondary">
          The linked task's current outcome could not be loaded. The recorded task association is
          retained.
        </Typography>
      )}
      {query.data && !task && (
        <Alert severity="warning">
          The loaded task does not match this event's source. Its source and report links are
          unavailable.
        </Alert>
      )}
    </Stack>
  );
}

function WebhookIntakeNotice({
  repositoryId,
  user,
}: {
  repositoryId: string;
  user: InvestigationSessionUser | null;
}) {
  const query = useQuery({
    queryKey: ["investigation-webhook-intake-settings", repositoryId],
    queryFn: () => investigationApi.repositoryWebhookSettings(repositoryId),
    enabled:
      !!user?.repositoryIds.includes(repositoryId) &&
      user.permissions.includes("repository:manage"),
    retry: false,
  });
  return query.data?.repositoryId === repositoryId && !query.data.enabled ? (
    <Alert severity="info">
      Assignment intake is paused. Previously received events, handling history, and task
      associations remain available.
    </Alert>
  ) : null;
}

export function WebhookDeliveryDetails({ deliveryId }: { deliveryId: string }) {
  const scope = useInvestigationRepositoryScope();
  const { session } = useInvestigationSession();
  const query = useQuery({
    queryKey: webhookDeliveryQueryKey(deliveryId),
    queryFn: () => investigationApi.webhookDelivery(deliveryId),
    refetchInterval: (current) =>
      webhookPollingInterval(current.state.data ? [current.state.data] : []),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  if (query.isPending) return <CircularProgress size={28} aria-label="Loading webhook event" />;
  if (!query.data)
    return (
      <Alert severity="error">
        {query.error?.message ?? "The webhook event could not be loaded."}
        <Button onClick={() => void query.refetch()}>Refresh event</Button>
      </Alert>
    );
  const delivery = query.data;
  if (
    delivery.deliveryId !== deliveryId ||
    (scope.repositoryId && delivery.repositoryId !== scope.repositoryId)
  )
    return <Alert severity="warning">This event does not belong to the selected repository.</Alert>;
  const duplicate = delivery.canonicalDeliveryId !== delivery.deliveryId;
  const latestAttempt = [...delivery.attemptHistory].sort(
    (left, right) => right.number - left.number,
  )[0];
  const outcomeTitle = duplicate
    ? "Duplicate receipt linked"
    : delivery.state === "failed"
      ? `${phaseLabels[latestAttempt?.phase ?? "recovery"]} needs attention`
      : delivery.state === "completed"
        ? "Event handling complete"
        : delivery.state === "source_ready"
          ? "Source is ready"
          : delivery.state === "ignored"
            ? "Event ignored"
            : "Event accepted";
  return (
    <Stack spacing={3} className="webhook-page">
      <Box>
        <Button
          component={Link}
          to={`/webhooks?repositoryId=${encodeURIComponent(delivery.repositoryId)}`}
        >
          All webhook events
        </Button>
      </Box>
      <PageHeading
        title={`${delivery.kind === "pull_request" ? "Pull request" : "Issue"} #${delivery.number}`}
        eyebrow={delivery.repositoryFullName}
        subtitle={`${delivery.mode === "e2e" ? "E2E verification" : "Static review"} · ${delivery.eventName}`}
      >
        <Stack
          direction="row"
          useFlexGap
          spacing={1}
          sx={{ flexWrap: "wrap", alignItems: "center" }}
        >
          <WebhookStatus delivery={delivery} />
          <Typography variant="body2" color="text.secondary">
            Received <RecordedTime value={delivery.receivedAt} />
          </Typography>
        </Stack>
      </PageHeading>
      <WebhookLinkedContext delivery={delivery} />
      {query.isError && (
        <Alert severity="error">
          {query.error.message} The last loaded event and linked work remain visible. Refresh before
          starting a new recovery request.
          <Button onClick={() => void query.refetch()}>Refresh event</Button>
        </Alert>
      )}
      <WebhookIntakeNotice repositoryId={delivery.repositoryId} user={session.user} />
      {duplicate && (
        <Alert
          severity="info"
          action={
            <Button
              component={Link}
              to={webhookDetailsUrl(delivery.canonicalDeliveryId, delivery.repositoryId)}
            >
              Open canonical event
            </Button>
          }
        >
          Duplicate delivery. The canonical event holds the task association and available recovery
          action.
        </Alert>
      )}
      <Box className="webhook-detail-grid">
        <Stack spacing={3} sx={{ minWidth: 0 }}>
          <EventSection title="Handling outcome">
            <Typography variant="h6" component="h3" sx={{ mb: 1 }}>
              {outcomeTitle}
            </Typography>
            {delivery.reason && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 2, whiteSpace: "pre-wrap" }}
              >
                {webhookReasonDescription(delivery.reason)}
              </Typography>
            )}
            {delivery.reason && (
              <Box component="details" className="webhook-disclosure" sx={{ mb: 2 }}>
                <Box component="summary" sx={{ color: "primary.main" }}>
                  Diagnostic details
                </Box>
                <Box component="dl" className="webhook-metadata">
                  <div>
                    <dt>Recorded reason</dt>
                    <dd>
                      <code>{delivery.reason}</code>
                    </dd>
                  </div>
                </Box>
              </Box>
            )}
            <WebhookRetryControls
              key={delivery.deliveryId}
              delivery={delivery}
              user={session.user}
              snapshotStale={query.isError}
            />
          </EventSection>
          <WebhookAttemptHistory delivery={delivery} />
        </Stack>
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          <EventSection title="Event details">
            <Box component="dl" className="webhook-metadata">
              <div>
                <dt>Received</dt>
                <dd>
                  <RecordedTime value={delivery.receivedAt} />
                </dd>
              </div>
              <div>
                <dt>Task mode</dt>
                <dd>{delivery.mode === "e2e" ? "E2E verification" : "Static review"}</dd>
              </div>
              <div>
                <dt>Receipt identity</dt>
                <dd>{duplicate ? "Duplicate event" : "Canonical event"}</dd>
              </div>
              <div>
                <dt>Source snapshot</dt>
                <dd>{delivery.snapshotRef ? "Recorded" : "Not recorded"}</dd>
              </div>
            </Box>
            <Box component="details" className="webhook-disclosure">
              <Box component="summary" sx={{ color: "primary.main" }}>
                Identity and provenance
              </Box>
              <Box component="dl" className="webhook-metadata">
                <div>
                  <dt>Event</dt>
                  <dd>{delivery.eventName}</dd>
                </div>
                <div>
                  <dt>Delivery</dt>
                  <dd>{delivery.deliveryId}</dd>
                </div>
                <div>
                  <dt>Actor GitHub ID</dt>
                  <dd>{delivery.actorUserId}</dd>
                </div>
                <div>
                  <dt>Assigned reviewer GitHub ID</dt>
                  <dd>{delivery.assigneeUserId}</dd>
                </div>
                <div>
                  <dt>Source snapshot ID</dt>
                  <dd>{delivery.snapshotRef?.id ?? "Not recorded"}</dd>
                </div>
                {delivery.snapshotRef && (
                  <div>
                    <dt>Snapshot digest</dt>
                    <dd>{delivery.snapshotRef.digest}</dd>
                  </div>
                )}
              </Box>
            </Box>
          </EventSection>
          <Typography variant="body2" color="text.secondary">
            Processed means event handling finished. Task execution and GitHub comment delivery have
            separate outcomes.
          </Typography>
        </Stack>
      </Box>
    </Stack>
  );
}

export function WebhookDeliveryHistoryPanel({
  filters,
  clearUrl,
}: {
  filters: WebhookFilters;
  clearUrl?: string;
}) {
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
    <Surface sx={{ minWidth: 0, overflow: "hidden" }}>
      <Stack
        direction="row"
        useFlexGap
        spacing={1}
        sx={{
          px: { xs: 2, sm: 2.5 },
          py: 1.5,
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <Typography variant="subtitle2">Received events</Typography>
        <Button
          startIcon={<RefreshRounded />}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh history
        </Button>
      </Stack>
      {query.isPending && (
        <Box sx={{ p: 3 }}>
          <CircularProgress size={24} aria-label="Loading webhook events" />
        </Box>
      )}
      {query.isError && (
        <Alert severity="error" sx={{ m: 2 }}>
          {query.error.message}
        </Alert>
      )}
      {query.data && (
        <WebhookDeliveryHistory
          items={query.data.items}
          showRecoveryRequests
          emptyAction={
            clearUrl ? (
              <Button component={Link} to={clearUrl}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}
      {query.data && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            px: 2,
            py: 1,
            borderTop: 1,
            borderColor: "divider",
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {query.data.items.length} events on this page
          </Typography>
          {(cursors.length > 1 || query.data.nextCursor) && (
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: "center" }}
            >
              <Button
                disabled={cursors.length === 1 || query.isFetching}
                onClick={() => setCursors((value) => value.slice(0, -1))}
              >
                Previous
              </Button>
              <Typography variant="caption">Page {cursors.length}</Typography>
              <Button
                disabled={!query.data.nextCursor || query.isFetching}
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
      )}
    </Surface>
  );
}

function WebhookFilterFields({ filters }: { filters: WebhookFilters }) {
  return (
    <>
      <TextField
        name="number"
        label="PR or Issue number"
        size="small"
        defaultValue={filters.number ?? ""}
        type="number"
        slotProps={{ htmlInput: { min: 1, step: 1 } }}
      />
      <TextField
        name="kind"
        select
        label="Target type"
        size="small"
        defaultValue={filters.kind ?? ""}
      >
        <MenuItem value="">All targets</MenuItem>
        <MenuItem value="pull_request">Pull requests</MenuItem>
        <MenuItem value="issue">Issues</MenuItem>
      </TextField>
      <TextField
        name="state"
        select
        label="Event status"
        size="small"
        defaultValue={filters.state ?? ""}
      >
        <MenuItem value="">All statuses</MenuItem>
        {Object.entries(stateLabels).map(([value, label]) => (
          <MenuItem key={value} value={value}>
            {label}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        name="mode"
        select
        label="Task mode"
        size="small"
        defaultValue={filters.mode ?? ""}
      >
        <MenuItem value="">All modes</MenuItem>
        <MenuItem value="static">Static</MenuItem>
        <MenuItem value="e2e">E2E</MenuItem>
      </TextField>
    </>
  );
}

export default function WebhookDeliveriesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const guardedAction = useGuardedAction();
  const [filterDialog, setFilterDialog] = useState(false);
  const deliveryId = new URLSearchParams(location.search).get("deliveryId");
  const filters = webhookDeliveryFilters(location.search);
  const clearUrl = `/webhooks${filters.repositoryId ? `?repositoryId=${encodeURIComponent(filters.repositoryId)}` : ""}`;
  const activeCount = [filters.kind, filters.number, filters.state, filters.mode].filter(
    (value) => value !== undefined,
  ).length;
  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (filters.repositoryId) next.set("repositoryId", filters.repositoryId);
    for (const key of ["kind", "number", "state", "mode"]) {
      const value = String(data.get(key) ?? "").trim();
      if (value) next.set(key, value);
    }
    guardedAction(() => {
      setFilterDialog(false);
      navigate({ pathname: "/webhooks", search: next.toString() });
    });
  };
  if (deliveryId) return <WebhookDeliveryDetails key={deliveryId} deliveryId={deliveryId} />;
  return (
    <Stack spacing={2.5} className="webhook-page">
      <PageHeading
        title="Webhook events"
        subtitle="Trace received events from intake to a linked task."
      />
      <Box
        component="form"
        key={location.search}
        onSubmit={applyFilters}
        className="webhook-filter-form"
      >
        <WebhookFilterFields filters={filters} />
        <Button type="submit" variant="outlined">
          Apply filters
        </Button>
        <Button component={Link} to={clearUrl}>
          Clear
        </Button>
      </Box>
      <Stack
        direction="row"
        spacing={1}
        className="webhook-mobile-filters"
        sx={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <Button
          startIcon={<FilterListRounded />}
          variant="outlined"
          onClick={() => setFilterDialog(true)}
        >
          Filters{activeCount > 0 ? ` (${activeCount})` : ""}
        </Button>
        {activeCount > 0 && (
          <Button component={Link} to={clearUrl}>
            Clear filters
          </Button>
        )}
      </Stack>
      <WebhookDeliveryHistoryPanel
        key={JSON.stringify(filters)}
        filters={filters}
        clearUrl={clearUrl}
      />
      <Typography variant="body2" color="text.secondary">
        Received history remains available when assignment intake is paused. Task execution and
        comment publication have separate outcomes.
      </Typography>
      <Dialog
        open={filterDialog}
        onClose={() => setFilterDialog(false)}
        maxWidth="xs"
        fullWidth
        aria-labelledby="webhook-filters-title"
      >
        <DialogTitle id="webhook-filters-title">Filter webhook events</DialogTitle>
        <Box component="form" key={location.search} onSubmit={applyFilters}>
          <DialogContent>
            <Stack spacing={2}>
              <WebhookFilterFields filters={filters} />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ flexWrap: "wrap", gap: 1, px: 3, pb: 2 }}>
            <Button onClick={() => setFilterDialog(false)}>Cancel</Button>
            <Button component={Link} to={clearUrl} onClick={() => setFilterDialog(false)}>
              Clear filters
            </Button>
            <Button type="submit" variant="contained">
              Apply filters
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Stack>
  );
}
