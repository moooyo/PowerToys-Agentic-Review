import type {
  PublicationControlAction,
  PublicationControlRequest,
  PublicationDetail,
  PublicationStatus,
  PublicationSummary,
} from "@agentic-review/contracts";
import {
  getPublicationAttemptIssues,
  getPublicationRemoteReceiptIssues,
} from "@agentic-review/contracts";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Pagination,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearNotificationTargetParameters,
  notificationTargetPath,
  parseNotificationTarget,
} from "@/components/NotificationTarget/targets";
import type { useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import {
  PublicationAccess,
  publicationAccessDenied,
  publicationError,
  usePublicationReadGuard,
} from "@/components/PublicationPreview/access";
import { PublicationDocument } from "@/components/PublicationPreview/Document";
import {
  publicationActions,
  publicationControl,
  publicationDeliveryLimitations,
} from "@/components/PublicationPreview/state";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { DataTable, DetailsGrid } from "@/components/ui";
import { publicationQueryRoot, publications } from "@/services/publications";
import "./index.css";

const statuses: PublicationStatus[] = [
  "pending",
  "delivering",
  "published",
  "failed",
  "blocked",
  "unknown",
  "cancelled",
];
const labels: Record<PublicationControlAction, string> = {
  cancel: "Cancel publication",
  retry: "Retry delivery",
  reconcile: "Check GitHub (GET only)",
};
const actionDescriptions: Record<PublicationControlAction, string> = {
  cancel:
    "Cancel this confirmed publication before sending. Its frozen content and attempt history are retained.",
  retry:
    "Request another delivery attempt for this exact frozen body. The server rechecks current permission, policy, source and evidence before sending.",
  reconcile:
    "Read GitHub to find an exact match for this target, marker, body and publisher. This action uses GET requests only and cannot resend the publication. No match or an incomplete scan remains uncertain.",
};
function Status({ status }: { status: PublicationStatus }) {
  return (
    <Chip
      size="medium"
      label={status}
      color={
        status === "published"
          ? "success"
          : status === "unknown"
            ? "warning"
            : ["failed", "blocked"].includes(status)
              ? "error"
              : "default"
      }
    />
  );
}
function OutboxDetail({
  repositoryId,
  publicationId,
  session,
  access,
  onClose,
}: {
  repositoryId: string;
  publicationId: string;
  session: string;
  access: ReturnType<typeof useOperatorAccess>;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [page, setPage] = useState(1),
    [failure, setFailure] = useState<unknown>(null),
    [notice, setNotice] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  const [intent, setIntent] = useState<{
    action: PublicationControlAction;
    request: PublicationControlRequest;
    detail: PublicationDetail;
  } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const scope = { repositoryId, publicationId };
  const detailKey = [...publicationQueryRoot, session, "outbox", "detail", publicationId];
  const attemptsKey = [...publicationQueryRoot, session, "outbox", "attempts", publicationId];
  const read = usePublicationReadGuard([detailKey, attemptsKey]);
  const query = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => read.guard.read(() => publications.get(scope, signal)),
    enabled: !read.denied && !access.checking,
    retry: false,
    refetchInterval: read.denied || access.checking ? false : 5_000,
    gcTime: 0,
  });
  const attempts = useQuery({
    queryKey: [...attemptsKey, page],
    queryFn: ({ signal }) =>
      read.guard.read(() => publications.attempts({ ...scope, page, pageSize: 20 }, signal)),
    enabled: !read.denied && !access.checking,
    retry: false,
    refetchInterval: read.denied || access.checking ? false : 5_000,
    gcTime: 0,
  });
  const denied =
    read.denied ||
    publicationAccessDenied(query.error) ||
    publicationAccessDenied(attempts.error) ||
    publicationAccessDenied(failure);
  const detail = !query.isError && !denied && !access.checking ? query.data : undefined;
  const historyMismatch =
    !!detail &&
    !!attempts.data &&
    attempts.data.items.some(
      (entry) =>
        getPublicationAttemptIssues(entry, publicationId, detail.intent.publisherGitHubUserId)
          .length > 0 ||
        (entry.remoteReceipt !== null &&
          getPublicationRemoteReceiptIssues(
            entry.remoteReceipt,
            detail.intent.target,
            detail.intent.publisherGitHubUserId,
            detail.intent.payload,
          ).length > 0),
    );
  const currentActionAllowed =
    intent !== null &&
    detail !== undefined &&
    publicationActions(detail).includes(intent.action) &&
    intent.request.expectedVersion === detail.delivery.version;
  const begin = (action: PublicationControlAction) => {
    if (
      !detail ||
      !access.can("configure") ||
      inFlight.current ||
      !publicationActions(detail).includes(action)
    )
      return;
    setFailure(null);
    setNotice(null);
    setIntent({
      action,
      request: publicationControl(detail, action, crypto.randomUUID()),
      detail: structuredClone(detail),
    });
  };
  const submit = async () => {
    if (
      !intent ||
      read.guard.snapshot() ||
      !access.can("configure") ||
      !currentActionAllowed ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const result = await publications.control(scope, intent.action, intent.request);
      if (!mounted.current || read.guard.snapshot()) return;
      if (
        result.change.actor.issuer !== access.principal?.issuer ||
        result.change.actor.subject !== access.principal?.subject
      )
        throw new Error("The publication control receipt does not match this operator.");
      setNotice(
        `${result.replayed ? "Original action recovered" : "Action recorded"}: ${labels[intent.action]}. Current delivery state is shown below.`,
      );
      setIntent(null);
      await client.invalidateQueries({ queryKey: [...publicationQueryRoot, session, "outbox"] });
    } catch (error) {
      if (!mounted.current) return;
      read.guard.deny(error);
      setFailure(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const closeDetails = () => {
    if (inFlight.current || saving) return;
    onClose();
  };
  const closeControl = () => {
    if (inFlight.current || saving) return;
    setIntent(null);
    setFailure(null);
  };
  return (
    <Dialog
      open
      fullWidth
      maxWidth="lg"
      aria-labelledby="publication-details-title"
      onClose={(_event, reason) => {
        if (reason === "escapeKeyDown" || reason === "backdropClick") closeDetails();
      }}
    >
      <DialogTitle id="publication-details-title">Publication details</DialogTitle>
      <DialogContent>
        {access.checking ? (
          <Skeleton variant="rounded" height={240} />
        ) : denied ? (
          <Alert severity="info">
            <AlertTitle>Publication access is unavailable</AlertTitle>The previous publication
            content has been cleared.
          </Alert>
        ) : query.isError ? (
          <Alert
            severity="error"
            action={<Button onClick={() => void query.refetch()}>Try again</Button>}
          >
            <AlertTitle>Could not load publication</AlertTitle>
            {publicationError(query.error)}
          </Alert>
        ) : !detail ? (
          <Skeleton variant="rounded" height={240} />
        ) : (
          <Stack spacing={3}>
            {notice && <Alert severity="success">{notice}</Alert>}
            <Stack
              direction="row"
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: "center", gap: 2 }}
            >
              <Status status={detail.delivery.status} />
              <Typography variant="body2" color="text.secondary">
                Delivery version {detail.delivery.version} · Updated {detail.delivery.updatedAt}
              </Typography>
            </Stack>
            <section className="publication-section" aria-label="Publication delivery record">
              <Typography variant="h6" component="h3">
                Delivery record
              </Typography>
              <DetailsGrid
                columns={2}
                items={[
                  {
                    key: "id",
                    label: "Publication ID",
                    value: <code>{detail.intent.publicationId}</code>,
                  },
                  {
                    key: "actor",
                    label: "Confirmed by",
                    value: `${detail.intent.actor.subject} · ${detail.intent.actor.issuer}`,
                  },
                  { key: "created", label: "Confirmed at", value: detail.intent.createdAt },
                  {
                    key: "attempts",
                    label: "Delivery and reconciliation attempts",
                    value: detail.delivery.attemptCount,
                  },
                  {
                    key: "failure",
                    label: "Current result",
                    value: detail.delivery.failure
                      ? `${detail.delivery.failure.code}: ${detail.delivery.failure.message}`
                      : "No failure recorded",
                  },
                  {
                    key: "remote",
                    label: "Verified remote publication",
                    value: detail.delivery.remoteReceipt ? (
                      <a
                        href={detail.delivery.remoteReceipt.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open the recorded GitHub publication
                      </a>
                    ) : (
                      "No verified remote receipt"
                    ),
                  },
                ]}
              />
            </section>
            {detail.delivery.status === "unknown" && (
              <Alert severity="warning">
                <AlertTitle>Delivery is uncertain</AlertTitle>
                Sending may have begun. This publication cannot be retried or cancelled. Check
                GitHub using read-only reconciliation; an absent match never authorizes another
                send.
              </Alert>
            )}
            <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 1 }}>
              {publicationActions(detail).map((action) => (
                <Button
                  key={action}
                  color={action === "cancel" ? "error" : "primary"}
                  variant="outlined"
                  disabled={!access.can("configure") || saving}
                  onClick={() => begin(action)}
                >
                  {labels[action]}
                </Button>
              ))}
            </Stack>
            {!access.allows("configure") && (
              <Typography color="text.secondary">
                Maintainer access or higher is required to cancel, retry, or reconcile publication.
              </Typography>
            )}
            <PublicationDocument
              target={detail.intent.target}
              payload={detail.intent.payload}
              binding={detail.intent.binding}
              publisherGitHubUserId={detail.intent.publisherGitHubUserId}
              payloadSha256={detail.intent.payloadSha256}
            />
            <Typography color="text.secondary">{publicationDeliveryLimitations}</Typography>
            <section className="publication-section" aria-label="Publication history">
              <Typography variant="h6" component="h3">
                Append-only delivery and reconciliation history
              </Typography>
              {attempts.isError || historyMismatch ? (
                <Alert severity="error">
                  <AlertTitle>Could not load publication history</AlertTitle>
                  {historyMismatch
                    ? "The history does not match this publication target and publisher."
                    : publicationError(attempts.error)}
                </Alert>
              ) : !attempts.data ? (
                <Skeleton variant="rounded" height={140} />
              ) : (
                <>
                  <DataTable
                    ariaLabel="Delivery and reconciliation history"
                    rows={attempts.data.items}
                    getRowId={(entry) => entry.id}
                    emptyTitle="No delivery or reconciliation observations have been recorded."
                    columns={[
                      { id: "attempt", label: "Attempt", render: (entry) => entry.attemptNumber },
                      { id: "kind", label: "Kind", render: (entry) => entry.kind },
                      { id: "phase", label: "Phase", render: (entry) => entry.phase },
                      {
                        id: "result",
                        label: "Result",
                        render: (entry) =>
                          entry.phase === "outcome" ? entry.outcome : "No outcome recorded",
                      },
                      {
                        id: "details",
                        label: "Details",
                        render: (entry) =>
                          entry.failure ? (
                            `${entry.failure.code}: ${entry.failure.message}`
                          ) : entry.remoteReceipt ? (
                            <a href={entry.remoteReceipt.htmlUrl} target="_blank" rel="noreferrer">
                              Verified GitHub receipt
                            </a>
                          ) : (
                            "No remote receipt"
                          ),
                      },
                      { id: "time", label: "Recorded at", render: (entry) => entry.createdAt },
                    ]}
                  />
                  {attempts.data.total > 20 && (
                    <Pagination
                      aria-label="Publication history pages"
                      page={page}
                      count={Math.ceil(attempts.data.total / 20)}
                      onChange={(_event, value) => setPage(value)}
                      sx={{ mt: 2 }}
                    />
                  )}
                </>
              )}
            </section>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button disabled={saving} onClick={() => void access.refresh()}>
          Refresh access
        </Button>
        <Button disabled={saving} onClick={closeDetails}>
          Close
        </Button>
      </DialogActions>
      {intent && !denied && !access.checking && (
        <Dialog
          open
          fullWidth
          maxWidth="sm"
          aria-labelledby="publication-control-title"
          onClose={(_event, reason) => {
            if (reason === "escapeKeyDown" || reason === "backdropClick") closeControl();
          }}
        >
          <DialogTitle id="publication-control-title">{labels[intent.action]}</DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography>{actionDescriptions[intent.action]}</Typography>
              {!currentActionAllowed && (
                <Alert severity="warning">
                  <AlertTitle>Delivery state changed</AlertTitle>
                  Close this dialog and review the current state before choosing an action. Unknown
                  delivery permits only read-only reconciliation.
                </Alert>
              )}
              <DetailsGrid
                columns={1}
                items={[
                  { key: "id", label: "Publication", value: <code>{publicationId}</code> },
                  {
                    key: "version",
                    label: "Expected delivery version",
                    value: intent.request.expectedVersion,
                  },
                  {
                    key: "body",
                    label: "Frozen payload digest",
                    value: <code>{intent.request.expectedPayloadSha256}</code>,
                  },
                ]}
              />
              {!!failure && (
                <Alert severity="error">
                  <AlertTitle>Publication action failed</AlertTitle>
                  {`${publicationError(failure)} The original request identity is retained. Close this dialog to discard it and review current state.`}
                </Alert>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button disabled={saving} onClick={closeControl}>
              Cancel
            </Button>
            <Button
              variant="contained"
              color={intent.action === "cancel" ? "error" : "primary"}
              loading={saving}
              disabled={!access.can("configure") || !currentActionAllowed}
              onClick={() => void submit()}
            >
              {failure ? "Retry original action" : labels[intent.action]}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Dialog>
  );
}
function Outbox({
  repositoryId,
  session,
  access,
  selectedPublicationId,
  onSelectPublication,
}: {
  repositoryId: string;
  session: string;
  access: ReturnType<typeof useOperatorAccess>;
  selectedPublicationId?: string;
  onSelectPublication: (publicationId: string | null) => void;
}) {
  const [page, setPage] = useState(1),
    [status, setStatus] = useState<PublicationStatus>();
  const listKey = [...publicationQueryRoot, session, "outbox", "list", repositoryId];
  const read = usePublicationReadGuard([listKey]);
  const query = useQuery({
    queryKey: [...listKey, page, status],
    queryFn: ({ signal }) =>
      read.guard.read(() =>
        publications.list(
          { repositoryId, page, pageSize: 20, ...(status ? { status } : {}) },
          signal,
        ),
      ),
    enabled: !read.denied && !access.checking,
    retry: false,
    refetchInterval: read.denied || access.checking ? false : 5_000,
    gcTime: 0,
  });
  return (
    <>
      <Card variant="elevation" elevation={0}>
        <CardHeader
          sx={{ flexWrap: "wrap", gap: 1, "& .MuiCardHeader-action": { m: 0 } }}
          title="Repository outbox"
          action={
            <Stack direction="row" sx={{ gap: 1 }}>
              <Button onClick={() => void access.refresh()}>Refresh access</Button>
              <Button
                startIcon={<RefreshIcon />}
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Refresh
              </Button>
            </Stack>
          }
        />
        <CardContent sx={{ pt: 0 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Confirmed immutable publications for this repository only. Current delivery state
            refreshes every 5 seconds.
          </Typography>
          <TextField
            select
            label="Filter publication status"
            value={status ?? ""}
            sx={{ minWidth: 240, mb: 3 }}
            onChange={(event) => {
              setStatus(event.target.value ? (event.target.value as PublicationStatus) : undefined);
              setPage(1);
              onSelectPublication(null);
            }}
          >
            <MenuItem value="">All delivery states</MenuItem>
            {statuses.map((value) => (
              <MenuItem key={value} value={value}>
                {value}
              </MenuItem>
            ))}
          </TextField>
          {read.denied ? (
            <Alert severity="info">
              <AlertTitle>Publication access is unavailable</AlertTitle>
              The previous outbox content has been cleared. Refresh access before loading
              publications.
            </Alert>
          ) : query.isError ? (
            <Alert severity="error">
              <AlertTitle>Could not load repository publications</AlertTitle>
              {publicationError(query.error)}
            </Alert>
          ) : !query.data ? (
            <Skeleton variant="rounded" height={180} />
          ) : (
            <>
              <DataTable<PublicationSummary>
                ariaLabel="Repository publication outbox"
                rows={query.data.items}
                getRowId={(entry) => entry.publicationId}
                emptyTitle="No publications have been confirmed for this repository."
                columns={[
                  {
                    id: "target",
                    label: "Target",
                    minWidth: 230,
                    render: (entry) =>
                      `${entry.target.kind === "pull_request" ? "PR" : "Issue"} #${entry.target.number} · ${entry.target.fullName}`,
                  },
                  {
                    id: "state",
                    label: "State",
                    render: (entry) => <Status status={entry.delivery.status} />,
                  },
                  {
                    id: "decision",
                    label: "Decision",
                    render: (entry) => <code>{entry.selectedDecisionId}</code>,
                  },
                  {
                    id: "attempts",
                    label: "Attempts",
                    render: (entry) => entry.delivery.attemptCount,
                  },
                  { id: "updated", label: "Updated", render: (entry) => entry.delivery.updatedAt },
                  {
                    id: "details",
                    label: "Details",
                    render: (entry) => (
                      <Button
                        aria-label={`Inspect publication ${entry.publicationId}`}
                        onClick={() => onSelectPublication(entry.publicationId)}
                      >
                        Inspect
                      </Button>
                    ),
                  },
                ]}
              />
              {query.data.total > 20 && (
                <Pagination
                  aria-label="Publication pages"
                  page={page}
                  count={Math.ceil(query.data.total / 20)}
                  onChange={(_event, value) => {
                    setPage(value);
                    onSelectPublication(null);
                  }}
                  sx={{ mt: 2 }}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>
      {selectedPublicationId && !query.isError && !read.denied && (
        <OutboxDetail
          key={selectedPublicationId}
          repositoryId={repositoryId}
          publicationId={selectedPublicationId}
          session={session}
          access={access}
          onClose={() => onSelectPublication(null)}
        />
      )}
    </>
  );
}
export default function PublicationsPage() {
  const scope = useRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  const target = parseNotificationTarget(location.pathname, location.search);
  const validSelection =
    target.kind === "target" &&
    target.target.kind === "publication" &&
    target.target.repositoryId === scope.repositoryId
      ? target.target.publicationId
      : undefined;
  const selectPublication = (publicationId: string | null) => {
    if (publicationId !== null && scope.repositoryId)
      navigate(
        notificationTargetPath({
          kind: "publication",
          repositoryId: scope.repositoryId,
          publicationId,
        }),
      );
    else
      navigate({
        pathname: location.pathname,
        search: clearNotificationTargetParameters(location.search),
      });
  };
  return (
    <section className="publications-page">
      <PageHeader
        eyebrow="Delivery"
        title="Publications"
        description="Review confirmed publication content, delivery history and conservative recovery."
      />
      {target.kind === "invalid" ? (
        <Alert
          severity="error"
          action={<Button onClick={() => selectPublication(null)}>Clear target</Button>}
        >
          <AlertTitle>Invalid publication target</AlertTitle>
          {target.message}
        </Alert>
      ) : !scope.repositoryId ? (
        <Alert severity="info">
          <AlertTitle>Select a repository</AlertTitle>
          Choose one repository in the repository selector to inspect its publication outbox. There
          is no cross-repository outbox view.
        </Alert>
      ) : !scope.ready ? (
        <RepositoryScopeUnavailable />
      ) : (
        <PublicationAccess repositoryId={scope.repositoryId}>
          {(session, access) => (
            <Outbox
              key={session}
              repositoryId={scope.repositoryId as string}
              session={session}
              access={access}
              selectedPublicationId={validSelection}
              onSelectPublication={selectPublication}
            />
          )}
        </PublicationAccess>
      )}
    </section>
  );
}
