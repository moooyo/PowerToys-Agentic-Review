import type {
  InvestigationCommentDelivery,
  InvestigationCommentDeliveryQuery,
  InvestigationCommentPublicationSummary,
} from "@agentic-review/contracts";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { type CommentSummaryQuery, investigationApi } from "./api";
import { Section } from "./report-sections";
import { InvestigationHttpError } from "./transport";

export const commentSummariesQueryKey = (query: CommentSummaryQuery) => [
  "investigation-comments",
  query,
];
export const commentQueryKey = (id: string) => ["investigation-comment", id];
export const commentDeliveriesQueryKey = (query: InvestigationCommentDeliveryQuery) => [
  "investigation-comment-deliveries",
  query,
];

const publicationLabels = {
  pending: "Pending",
  sending: "Sending",
  synced: "Synced",
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

function RecordedTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}

export function CommentDeliveryHistory({
  items,
  showTarget = true,
}: {
  items: InvestigationCommentDelivery[];
  showTarget?: boolean;
}) {
  if (items.length === 0)
    return <Typography color="text.secondary">No comment deliveries recorded yet.</Typography>;
  return (
    <Stack spacing={1.5}>
      {items.map((delivery) => {
        const state = delivery.state;
        return (
          <Box key={delivery.id} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}>
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
                {delivery.taskId && (
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
              {state !== "succeeded" && delivery.reason && (
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
              <Accordion variant="outlined" disableGutters>
                <AccordionSummary expandIcon={<span aria-hidden="true">+</span>}>
                  <Typography variant="body2">View delivery details</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={1.5}>
                    <Typography variant="caption" color="text.secondary">
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
}: {
  filters: Omit<InvestigationCommentDeliveryQuery, "cursor" | "limit">;
  pollInterval?: number | false;
  showTarget?: boolean;
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
  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center" }}>
        <Typography variant="subtitle1">Comment delivery history</Typography>
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh history
        </Button>
      </Stack>
      {query.isPending && <CircularProgress size={24} aria-label="Loading comment deliveries" />}
      {query.isError && <Alert severity="error">{query.error.message}</Alert>}
      {query.data && <CommentDeliveryHistory items={query.data.items} showTarget={showTarget} />}
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

export function CommentPublicationControls({
  comment,
}: {
  comment: InvestigationCommentPublicationSummary;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [commandKeys, setCommandKeys] = useState<Record<string, string>>({});
  const refresh = async () => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: commentQueryKey(comment.id) }),
        queryClient.invalidateQueries({ queryKey: ["investigation-comments"] }),
      ]);
    } finally {
      setBusy(false);
    }
  };
  const perform = async (action: "sync" | "reconcile") => {
    if (busy || !comment.availableActions.includes(action)) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    const commandKey = `${comment.version}:${action}`;
    const idempotencyKey = commandKeys[commandKey] ?? crypto.randomUUID();
    setCommandKeys((value) => ({ ...value, [commandKey]: idempotencyKey }));
    try {
      const updated = await (action === "sync"
        ? investigationApi.syncComment
        : investigationApi.reconcileComment)(comment.id, {
        version: comment.version,
        idempotencyKey,
      });
      queryClient.setQueryData(commentQueryKey(comment.id), updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["investigation-comments"] }),
        queryClient.invalidateQueries({ queryKey: ["investigation-comment-deliveries"] }),
      ]);
      setMessage(
        action === "sync"
          ? "Synchronization scheduled."
          : "Delivery check scheduled. This check does not write to GitHub.",
      );
    } catch (cause) {
      setError(
        cause instanceof InvestigationHttpError && cause.status === 409
          ? "This comment changed. Refresh its status before trying again."
          : cause instanceof Error
            ? cause.message
            : "The comment operation could not be scheduled.",
      );
    } finally {
      setBusy(false);
    }
  };
  const commentUrl = safeCommentUrl(comment);
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <CommentStatus comment={comment} />
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
          Refresh status
        </Button>
        {comment.availableActions.includes("reconcile") && (
          <Button size="small" disabled={busy} onClick={() => void perform("reconcile")}>
            Check delivery
          </Button>
        )}
        {comment.availableActions.includes("sync") && (
          <Button size="small" disabled={busy} onClick={() => void perform("sync")}>
            Sync latest progress
          </Button>
        )}
      </Stack>
      {comment.reason && (
        <Typography variant="body2" color="text.secondary">
          {comment.reason}
        </Typography>
      )}
      {comment.nextAttemptAt && (
        <Typography variant="caption" color="text.secondary">
          Next attempt <RecordedTime value={comment.nextAttemptAt} />
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {message && <Alert severity="success">{message}</Alert>}
    </Stack>
  );
}

export function TaskComments({ taskId, active }: { taskId: string; active: boolean }) {
  const input = { taskIds: [taskId] };
  const query = useQuery({
    queryKey: commentSummariesQueryKey(input),
    queryFn: () => investigationApi.comments(input),
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
          <CommentPublicationControls key={comment.id} comment={comment} />
        ))}
        <CommentDeliveryHistoryPanel
          filters={{ taskId }}
          pollInterval={interval}
          showTarget={false}
        />
      </Stack>
    </Section>
  );
}
