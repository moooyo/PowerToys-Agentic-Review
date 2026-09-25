import type {
  InvestigationCommentDelivery,
  InvestigationCommentDeliveryQuery,
  InvestigationCommentPublicationSummary,
  InvestigationPublicationDirectoryQuery,
} from "@agentic-review/contracts";
import ChatBubbleRounded from "@mui/icons-material/ChatBubbleRounded";
import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
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
  Stack,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { type CommentSummaryQuery, investigationApi } from "./api";
import {
  type CommentAction,
  canScheduleCommentAction,
  commentCommandQueryKey,
  hasCommentActionGrant,
  type RetainedCommentCommand,
  scheduleCommentCommand,
} from "./comment-publication-state";
import { GithubSourceLink as GitHubSourceLink } from "./github-source-link";
import { useUnsavedChanges } from "./navigation-guard";
import { Section } from "./report-sections";
import { useInvestigationSession } from "./session";
import "./comments-activity.css";

export const commentSummariesQueryKey = (query: CommentSummaryQuery) => [
  "investigation-comments",
  query,
];
export const commentQueryKey = (id: string) => ["investigation-comment", id];
export const commentDeliveriesQueryKey = (query: InvestigationCommentDeliveryQuery) => [
  "investigation-comment-deliveries",
  query,
];
export const publicationsQueryKey = (query: InvestigationPublicationDirectoryQuery) => [
  "investigation-publications",
  query,
];

export const publicationLabels = {
  pending: "Pending",
  sending: "Sending",
  synced: "Delivered",
  retrying: "Retrying",
  unconfirmed: "Unconfirmed",
  paused: "Paused",
  needs_attention: "Needs attention",
  conflict: "Conflict",
} as const;
const publicationColors = {
  pending: "default",
  sending: "info",
  synced: "success",
  retrying: "warning",
  unconfirmed: "warning",
  paused: "default",
  needs_attention: "error",
  conflict: "warning",
} as const;
const deliveryColors = {
  sending: "info",
  succeeded: "success",
  failed: "error",
  cancelled: "default",
  unknown: "warning",
} as const;
const deliveryLabels = {
  sending: "Sending",
  succeeded: "Delivered",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unconfirmed",
} as const;

export function commentPollingInterval(
  items: readonly InvestigationCommentPublicationSummary[],
  now = Date.now(),
): number | false {
  if (items.some((item) => item.state === "pending" || item.state === "sending")) return 5_000;
  const retries = items.filter((item) => item.state === "retrying");
  if (retries.length) {
    return Math.min(
      ...retries.map((item) =>
        item.nextAttemptAt
          ? Math.max(5_000, Math.min(30_000, Date.parse(item.nextAttemptAt) - now + 1_000))
          : 5_000,
      ),
    );
  }
  return items.some((item) => item.state === "unconfirmed" || item.requiresAttention)
    ? 30_000
    : false;
}

export function CommentStatus({ comment }: { comment: InvestigationCommentPublicationSummary }) {
  return (
    <Chip
      size="small"
      label={publicationLabels[comment.state]}
      color={publicationColors[comment.state]}
      sx={{
        height: "auto",
        minHeight: 28,
        flexShrink: 0,
        "& .MuiChip-label": { whiteSpace: "normal", overflowWrap: "normal" },
      }}
    />
  );
}

export function commentDetailsUrl(commentId: string, repositoryId: string): string {
  return `/comments?repositoryId=${encodeURIComponent(repositoryId)}&commentId=${encodeURIComponent(commentId)}`;
}

export function safeCommentUrl(
  comment: InvestigationCommentPublicationSummary,
): string | undefined {
  if (!comment.commentUrl || !comment.externalId || !/^[1-9][0-9]*$/u.test(comment.externalId))
    return undefined;
  if (
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(comment.repositoryFullName) ||
    comment.repositoryFullName.split("/").some((part) => part === "." || part === "..")
  )
    return undefined;
  const kind = comment.workItemKind === "pull_request" ? "pull" : "issues";
  const expected = `https://github.com/${comment.repositoryFullName}/${kind}/${comment.workItemNumber}#issuecomment-${comment.externalId}`;
  return comment.commentUrl === expected ? expected : undefined;
}

export function RecordedTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}

export function publicationKindLabel(comment: InvestigationCommentPublicationSummary): string {
  if (comment.producerTaskKind === "pr-e2e")
    return comment.mode === "progress" ? "E2E progress" : "E2E result";
  return comment.mode === "progress" ? "Progress update" : "Review result";
}

export function commentSourceUrl(
  comment: InvestigationCommentPublicationSummary,
): string | undefined {
  return comment.workItemId
    ? `${comment.workItemKind === "pull_request" ? "/pull-requests" : "/issues"}?repositoryId=${encodeURIComponent(comment.repositoryId)}&workItemId=${encodeURIComponent(comment.workItemId)}`
    : undefined;
}

export function CommentContextLinks({
  comment,
}: {
  comment: InvestigationCommentPublicationSummary;
}) {
  const source = commentSourceUrl(comment);
  return (
    <Stack direction="row" spacing={1} useFlexGap className="comments-actions">
      <GitHubSourceLink
        repositoryFullName={comment.repositoryFullName}
        kind={comment.workItemKind}
        number={comment.workItemNumber}
      />
      {source && (
        <Button component={Link} to={source}>
          Open {comment.workItemKind === "pull_request" ? "pull request" : "issue"} #
          {comment.workItemNumber}
        </Button>
      )}
      {comment.taskId && (
        <Button
          component={Link}
          to={`/tasks?repositoryId=${encodeURIComponent(comment.repositoryId)}&taskId=${encodeURIComponent(comment.taskId)}`}
        >
          Open task
        </Button>
      )}
      {comment.reportId && (
        <Button
          component={Link}
          to={`/reports?repositoryId=${encodeURIComponent(comment.repositoryId)}&reportId=${encodeURIComponent(comment.reportId)}`}
        >
          Read saved report
        </Button>
      )}
    </Stack>
  );
}

export function CommentPublicationRow({
  comment,
  tableRow = false,
}: {
  comment: InvestigationCommentPublicationSummary;
  tableRow?: boolean;
}) {
  const request = useQuery<RetainedCommentCommand | null>({
    queryKey: commentCommandQueryKey(comment.id),
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  }).data;
  const pendingRequest = request && ["submitting", "unknown", "conflict"].includes(request.state);
  const actionLabel = pendingRequest
    ? "Review request"
    : comment.state === "needs_attention" || comment.state === "retrying"
      ? "Review retry"
      : ["sending", "pending"].includes(comment.state)
        ? "Track delivery"
        : "View publication";
  if (tableRow)
    return (
      <tr>
        <td data-label="Publication">
          <strong>{comment.workItemTitle || publicationKindLabel(comment)}</strong>
          <Typography variant="caption" color="text.secondary" component="div">
            {publicationKindLabel(comment)}
          </Typography>
        </td>
        <td data-label="Target">
          <span className="comments-target">
            {comment.workItemKind === "pull_request" ? "PR" : "Issue"} #{comment.workItemNumber}
          </span>
          <Typography variant="caption" color="text.secondary" component="div">
            {comment.repositoryFullName}
          </Typography>
        </td>
        <td data-label="Delivery">
          <CommentStatus comment={comment} />
          {pendingRequest && (
            <Typography variant="caption" color="warning.main" component="div">
              {request.state === "submitting"
                ? "Request in progress"
                : request.state === "unknown"
                  ? "Request unconfirmed"
                  : "Request needs review"}
            </Typography>
          )}
        </td>
        <td data-label="Updated">
          <RecordedTime value={comment.updatedAt} />
        </td>
        <td data-label="Actions">
          <Button
            component={Link}
            to={commentDetailsUrl(comment.id, comment.repositoryId)}
            size="small"
            variant={actionLabel === "Review retry" ? "contained" : "text"}
          >
            {actionLabel}
          </Button>
        </td>
      </tr>
    );
  return (
    <Box
      component={Link}
      to={commentDetailsUrl(comment.id, comment.repositoryId)}
      className="comments-record"
      sx={{
        color: "text.primary",
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover" },
        "&:focus-visible": { outlineColor: "primary.main" },
      }}
    >
      <Box
        className="comments-record-symbol"
        sx={{ bgcolor: "action.hover", color: "text.secondary" }}
      >
        <ChatBubbleRounded fontSize="small" />
      </Box>
      <Box className="comments-record-main">
        <Typography variant="caption" color="text.secondary">
          {comment.repositoryFullName} · {comment.workItemKind === "pull_request" ? "PR" : "Issue"}{" "}
          #{comment.workItemNumber} · {publicationKindLabel(comment)}
        </Typography>
        <Typography variant="subtitle1">
          {comment.workItemTitle || publicationKindLabel(comment)}
        </Typography>
        {comment.reason && (
          <Typography variant="body2" color="text.secondary">
            {comment.reason}
          </Typography>
        )}
      </Box>
      <Box className="comments-record-state">
        <CommentStatus comment={comment} />
        {request && ["submitting", "unknown", "conflict"].includes(request.state) && (
          <Typography variant="caption" color="warning.main">
            {request.state === "submitting"
              ? "Request in progress"
              : request.state === "unknown"
                ? "Request unconfirmed"
                : "Request needs review"}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          <RecordedTime value={comment.updatedAt} />
        </Typography>
      </Box>
      <ChevronRightRounded className="comments-record-chevron" fontSize="small" />
    </Box>
  );
}

export function CommentDeliveryHistory({
  items,
  showTarget = true,
}: {
  items: InvestigationCommentDelivery[];
  showTarget?: boolean;
}) {
  const historyId = useId();
  if (items.length === 0)
    return <Typography color="text.secondary">No comment deliveries recorded yet.</Typography>;
  return (
    <Stack component="ol" className="comments-timeline" spacing={0}>
      {items.map((delivery) => {
        const state = delivery.state;
        const detailsId = `${historyId}-${encodeURIComponent(delivery.id)}-details`;
        return (
          <Box
            component="li"
            key={delivery.id}
            className="comments-timeline-entry"
            sx={{
              borderColor: "divider",
              "&::before": {
                bgcolor:
                  state === "succeeded"
                    ? "success.main"
                    : state === "failed"
                      ? "error.main"
                      : "text.secondary",
              },
            }}
          >
            <Stack spacing={1}>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: "center", flexWrap: "wrap" }}
              >
                <Typography variant="subtitle2">
                  {delivery.operation === "create" ? "Create" : "Update"}
                </Typography>
                <Chip size="small" label={deliveryLabels[state]} color={deliveryColors[state]} />
                <Typography variant="body2" color="text.secondary">
                  <RecordedTime value={delivery.startedAt} />
                </Typography>
                {showTarget && (
                  <Button
                    size="small"
                    component={Link}
                    to={commentDetailsUrl(delivery.commentId, delivery.repositoryId)}
                  >
                    {delivery.repositoryFullName} ·{" "}
                    {delivery.workItemKind === "pull_request" ? "PR" : "Issue"} #
                    {delivery.workItemNumber}
                  </Button>
                )}
                {showTarget && delivery.taskId && (
                  <Button
                    size="small"
                    component={Link}
                    to={`/tasks?taskId=${encodeURIComponent(delivery.taskId)}&repositoryId=${encodeURIComponent(delivery.repositoryId)}`}
                  >
                    Open task
                  </Button>
                )}
                {!delivery.taskId && (
                  <Typography variant="caption" color="text.secondary">
                    Assignment preparation
                  </Typography>
                )}
              </Stack>
              {delivery.reason && (
                <Typography variant="body2" color={state === "failed" ? "error" : "text.secondary"}>
                  {delivery.reason}
                </Typography>
              )}
              {state === "unknown" && (
                <Typography variant="body2" color="text.secondary">
                  The write may have reached GitHub. Its outcome still needs to be checked.
                </Typography>
              )}
              {delivery.legacy && (
                <Typography variant="caption" color="text.secondary">
                  Imported delivery record. Earlier delivery history is unavailable.
                </Typography>
              )}
              <Accordion
                variant="outlined"
                disableGutters
                sx={{ border: 0, bgcolor: "transparent", "&::before": { display: "none" } }}
              >
                <AccordionSummary
                  id={`${detailsId}-summary`}
                  aria-controls={detailsId}
                  expandIcon={<ExpandMoreRounded />}
                >
                  <Typography variant="body2">View delivery details</Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 0 }}>
                  <Stack spacing={1.5}>
                    <Typography variant="caption" color="text.secondary">
                      Attempt {delivery.attemptNumber} ·{" "}
                      {delivery.effect?.replaceAll("_", " ") ?? "Effect not recorded"} ·{" "}
                      {delivery.finishedAt ? (
                        <>
                          Finished <RecordedTime value={delivery.finishedAt} />
                        </>
                      ) : (
                        "No completion recorded."
                      )}
                    </Typography>
                    <Typography variant="subtitle2">Comment body</Typography>
                    {delivery.body === null ? (
                      <Typography variant="body2" color="text.secondary">
                        No prepared comment body was retained for this delivery.
                      </Typography>
                    ) : (
                      <Box
                        component="pre"
                        sx={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          typography: "body2",
                          maxHeight: 480,
                          overflowY: "auto",
                          m: 0,
                        }}
                      >
                        {delivery.body}
                      </Box>
                    )}
                    {delivery.observations.length > 0 && (
                      <>
                        <Typography variant="subtitle2">Delivery checks</Typography>
                        {delivery.observations.map((observation) => (
                          <Box
                            key={JSON.stringify([
                              observation.at,
                              observation.state,
                              observation.reason,
                            ])}
                          >
                            <Typography variant="body2">
                              <RecordedTime value={observation.at} /> ·{" "}
                              {deliveryLabels[observation.state]}
                            </Typography>
                            {observation.reason && (
                              <Typography variant="body2" color="text.secondary">
                                {observation.reason}
                              </Typography>
                            )}
                          </Box>
                        ))}
                      </>
                    )}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

export function CommentDeliveryHistoryPanel({
  filters,
  pollInterval = false,
  showTarget = true,
  showHeading = true,
}: {
  filters: Omit<InvestigationCommentDeliveryQuery, "cursor" | "limit">;
  pollInterval?: number | false;
  showTarget?: boolean;
  showHeading?: boolean;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const queryInput = { ...filters, cursor, limit: 25 };
  const query = useQuery({
    queryKey: commentDeliveriesQueryKey(queryInput),
    queryFn: () =>
      filters.commentId
        ? investigationApi.commentAttempts(filters.commentId, { cursor, limit: 25 })
        : investigationApi.commentDeliveries(queryInput),
    refetchInterval: (current) =>
      pollInterval ||
      (current.state.data?.items.some((item) => item.state === "sending")
        ? 5_000
        : current.state.data?.items.some((item) => item.state === "unknown")
          ? 30_000
          : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const matchesScope = query.data?.items.every(
    (item) =>
      (!filters.commentId || item.commentId === filters.commentId) &&
      (!filters.repositoryId || item.repositoryId === filters.repositoryId) &&
      (!filters.taskId || item.taskId === filters.taskId) &&
      (!filters.workItemNumber || item.workItemNumber === filters.workItemNumber),
  );
  return (
    <Stack spacing={2}>
      <Stack
        direction="row"
        useFlexGap
        sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1 }}
      >
        {showHeading && <Typography variant="h6">Delivery timeline</Typography>}
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh history
        </Button>
      </Stack>
      {query.isPending && <CircularProgress size={24} aria-label="Loading comment deliveries" />}
      {query.isError && <Alert severity="error">{query.error.message}</Alert>}
      {query.data &&
        (matchesScope ? (
          <CommentDeliveryHistory items={query.data.items} showTarget={showTarget} />
        ) : (
          <Alert severity="error">
            The delivery history does not match the selected publication or task.
          </Alert>
        ))}
      {(cursors.length > 1 || query.data?.nextCursor) && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
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

export function CommentPublicationControls({
  comment,
  stale = false,
}: {
  comment: InvestigationCommentPublicationSummary;
  stale?: boolean;
}) {
  const requestDetailsId = useId();
  const queryClient = useQueryClient();
  const { session } = useInvestigationSession();
  const requestKey = commentCommandQueryKey(comment.id);
  const requestQuery = useQuery<RetainedCommentCommand | null>({
    queryKey: requestKey,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const request = requestQuery.data;
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{
    action: CommentAction;
    version: string;
    commentId: string;
  }>();
  useUnsavedChanges(Boolean(preview), {
    description: "A publication preview is open. Leave without scheduling it?",
    onDiscard: () => setPreview(undefined),
  });
  const busy = refreshing || request?.state === "submitting";
  const canSchedule = (action: CommentAction) =>
    !stale && canScheduleCommentAction(comment, session.user, action, request);
  const refresh = async () => {
    if (busy) return;
    setRefreshing(true);
    setError(undefined);
    try {
      await queryClient.cancelQueries({ queryKey: commentQueryKey(comment.id) });
      await queryClient.fetchQuery({
        queryKey: commentQueryKey(comment.id),
        queryFn: async () => {
          const updated = await investigationApi.comment(comment.id);
          if (updated.id !== comment.id || updated.repositoryId !== comment.repositoryId)
            throw new Error("The service returned a different publication.");
          return updated;
        },
        staleTime: 0,
      });
      const current = queryClient.getQueryData<RetainedCommentCommand | null>(requestKey);
      if (current && ["conflict", "rejected"].includes(current.state)) {
        queryClient.setQueryData(requestKey, {
          ...current,
          state: "refreshed",
          message: "Latest status loaded. Review the action before retrying.",
        } satisfies RetainedCommentCommand);
      } else if (current?.state === "unknown") {
        queryClient.setQueryData(requestKey, {
          ...current,
          message:
            "Status refreshed. The saved request is still unconfirmed; retry it before starting another.",
        } satisfies RetainedCommentCommand);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["investigation-comments"] }),
        queryClient.invalidateQueries({ queryKey: ["investigation-publications"] }),
        queryClient.invalidateQueries({ queryKey: ["investigation-comment-deliveries"] }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The latest publication status could not be loaded.",
      );
    } finally {
      setRefreshing(false);
    }
  };
  const confirm = () => {
    if (
      !preview ||
      busy ||
      preview.commentId !== comment.id ||
      preview.version !== comment.version ||
      !canSchedule(preview.action)
    )
      return;
    void scheduleCommentCommand(queryClient, comment, preview.action);
    setPreview(undefined);
  };
  const commentUrl = safeCommentUrl(comment);
  const syncLabel =
    comment.state === "synced" && comment.producerTaskKind === "pr-e2e"
      ? "Republish"
      : "Publish update";
  return (
    <Stack spacing={2} className="comments-publication-controls">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        {comment.lastAttemptAt && (
          <Typography variant="caption" color="text.secondary">
            Last delivery <RecordedTime value={comment.lastAttemptAt} />
          </Typography>
        )}
        {commentUrl && (
          <Button
            size="small"
            component="a"
            href={commentUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View GitHub comment
          </Button>
        )}
        <Button size="small" disabled={busy} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh status"}
        </Button>
      </Stack>
      {comment.reason && (
        <Typography variant="body2" color="text.secondary">
          {comment.reason}
        </Typography>
      )}
      {comment.nextAttemptAt && (
        <Alert severity="info">
          Automatic processing is scheduled for <RecordedTime value={comment.nextAttemptAt} />.
        </Alert>
      )}
      {comment.state === "unconfirmed" && (
        <Alert severity="warning">
          The earlier write may have reached GitHub. Check that delivery before publishing another
          update.
        </Alert>
      )}
      {request && (
        <Alert
          severity={
            request.state === "completed"
              ? "success"
              : request.state === "submitting" || request.state === "refreshed"
                ? "info"
                : "warning"
          }
        >
          {request.message}
          {request.state === "unknown" && (
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              className="comments-actions"
              sx={{ mt: 1 }}
            >
              <Button
                disabled={busy || !hasCommentActionGrant(comment, session.user, request.action)}
                onClick={() =>
                  void scheduleCommentCommand(queryClient, comment, request.action, request)
                }
              >
                Retry saved request
              </Button>
            </Stack>
          )}
          <Accordion
            disableGutters
            sx={{
              mt: 1,
              bgcolor: "transparent",
              boxShadow: "none",
              "&::before": { display: "none" },
            }}
          >
            <AccordionSummary
              id={`${requestDetailsId}-summary`}
              aria-controls={`${requestDetailsId}-details`}
              expandIcon={<ExpandMoreRounded />}
              sx={{ px: 0 }}
            >
              <Typography>Saved request</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0 }}>
              <Typography variant="body2">
                {request.action === "sync" ? "Publication" : "Delivery check"} ·{" "}
                <RecordedTime value={request.requestedAt} />
              </Typography>
              <Typography variant="caption" component="div" sx={{ overflowWrap: "anywhere" }}>
                Version: {request.version}
              </Typography>
              <Typography variant="caption" component="div" sx={{ overflowWrap: "anywhere" }}>
                Request: {request.idempotencyKey}
              </Typography>
            </AccordionDetails>
          </Accordion>
        </Alert>
      )}
      {(comment.availableActions.includes("sync") || comment.mode === "result") && (
        <Box className="comments-command-actions">
          {comment.availableActions.includes("sync") ? (
            <Button
              variant="contained"
              disabled={busy || !canSchedule("sync")}
              onClick={() =>
                setPreview({ action: "sync", version: comment.version, commentId: comment.id })
              }
            >
              {syncLabel}
            </Button>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Open the report to review publication actions.
            </Typography>
          )}
          {comment.availableActions.includes("sync") &&
            !hasCommentActionGrant(comment, session.user, "sync") && (
              <Typography variant="caption" component="p" color="text.secondary">
                Requires repository access, Prepare actions, Confirm actions, and the Comment
                action.
              </Typography>
            )}
        </Box>
      )}
      {comment.availableActions.includes("reconcile") && (
        <Box className="comments-command-actions">
          <Button
            variant="outlined"
            disabled={busy || !canSchedule("reconcile")}
            onClick={() =>
              setPreview({ action: "reconcile", version: comment.version, commentId: comment.id })
            }
          >
            Check delivery
          </Button>
          {!hasCommentActionGrant(comment, session.user, "reconcile") && (
            <Typography variant="caption" component="p" color="text.secondary">
              Requires repository access, Prepare actions, and the Comment action.
            </Typography>
          )}
        </Box>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      <Dialog open={Boolean(preview)} onClose={() => setPreview(undefined)} fullWidth maxWidth="sm">
        <DialogTitle>
          {preview?.action === "sync" ? `${syncLabel}?` : "Check this delivery?"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Box sx={{ bgcolor: "action.hover", p: 2, borderRadius: 2, overflowWrap: "anywhere" }}>
              <Typography variant="caption" color="text.secondary">
                Destination
              </Typography>
              <Typography>
                {comment.repositoryFullName} ·{" "}
                {comment.workItemKind === "pull_request" ? "PR" : "Issue"} #{comment.workItemNumber}
              </Typography>
              <Typography variant="body2">{publicationKindLabel(comment)}</Typography>
            </Box>
            {preview?.action === "sync" ? (
              <Alert severity="warning">
                Creates or updates the GitHub comment using the latest task state and configured
                template. The next body may differ from the recorded comment.
              </Alert>
            ) : (
              <Alert severity="info">
                Checks the existing GitHub comment without publishing another update.
              </Alert>
            )}
            {preview &&
              (preview.commentId !== comment.id || preview.version !== comment.version) && (
                <Alert severity="warning">
                  The publication changed while this preview was open. Close this preview and review
                  the latest status.
                </Alert>
              )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ flexWrap: "wrap", gap: 1, p: 2 }}>
          <Button onClick={() => setPreview(undefined)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={
              !preview ||
              busy ||
              preview.commentId !== comment.id ||
              preview.version !== comment.version ||
              !canSchedule(preview.action)
            }
            onClick={confirm}
          >
            {preview?.action === "sync" ? "Schedule publication" : "Schedule delivery check"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export function TaskComments(props: { taskId: string; active: boolean }) {
  return <TaskCommentPublications key={props.taskId} {...props} />;
}

function TaskCommentPublications({ taskId, active }: { taskId: string; active: boolean }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const input = { taskId, cursor: cursors.at(-1), limit: 25 };
  const query = useQuery({
    queryKey: publicationsQueryKey(input),
    queryFn: ({ signal }) => investigationApi.publications(input, signal),
    refetchInterval: (current) =>
      commentPollingInterval(current.state.data?.items ?? []) || (active ? 5_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const interval = commentPollingInterval(query.data?.items ?? []) || (active ? 5_000 : false);
  return (
    <Section title="GitHub comments">
      <Stack spacing={2}>
        {query.isPending && <CircularProgress size={24} aria-label="Loading comment status" />}
        {query.isError && (
          <Alert severity="error">
            {query.error.message}
            <Button onClick={() => void query.refetch()}>Refresh comments</Button>
          </Alert>
        )}
        {query.data?.items.map((comment) => (
          <CommentPublicationRow key={comment.id} comment={comment} />
        ))}
        {query.data?.items.length === 0 && (
          <Typography color="text.secondary">
            No publications are recorded for this task.
          </Typography>
        )}
        {(cursors.length > 1 || query.data?.nextCursor) && (
          <Stack direction="row" spacing={1} useFlexGap className="comments-actions">
            <Button
              disabled={cursors.length === 1 || query.isFetching}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              Previous publications
            </Button>
            <Button
              disabled={!query.data?.nextCursor || query.isFetching}
              onClick={() => {
                const next = query.data?.nextCursor;
                if (next) setCursors((value) => [...value, next]);
              }}
            >
              Next publications
            </Button>
          </Stack>
        )}
        <CommentDeliveryHistoryPanel
          filters={{ taskId }}
          pollInterval={interval}
          showTarget={false}
        />
      </Stack>
    </Section>
  );
}
