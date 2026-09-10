import type {
  NotificationItem,
  NotificationListQuery,
  NotificationRepositoryOverview,
  NotificationState,
  NotificationStateChangeRequest,
} from "@agentic-review/contracts";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Pagination,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  NotificationAccess,
  type NotificationAccessState,
  notificationAccessDenied,
  useNotificationAccess,
  useNotificationFailure,
  useNotificationSummary,
} from "@/components/NotificationBell/access";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { EmptyState } from "@/components/ui";
import { notificationQueryRoot, notifications } from "@/services/notifications";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import {
  createNotificationStateChange,
  notificationDescription,
  notificationHref,
  notificationLabel,
  notificationUnreadLabel,
} from "./state";
import "./index.css";

const queryOptions = {
  retry: false,
  gcTime: 0,
  refetchInterval: 20_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
} as const;
const workflowLabels = {
  pr_static_build: "Static + build",
  pr_ui: "UI validation",
  issue_triage: "Issue triage",
  issue_validation: "Issue validation",
};

function NotificationSummary({
  repositoryId,
  access,
}: {
  repositoryId?: string;
  access: NotificationAccessState;
}) {
  const query = useNotificationSummary(repositoryId, access);
  return (
    <div className="notifications-summary" role="status">
      <Typography component="span" variant="body1" sx={{ fontWeight: 500 }}>
        {query.data ? notificationUnreadLabel(query.data) : "Unread count unavailable"}
      </Typography>
      <Typography component="span" color="text.secondary" variant="body2">
        For your account · events are immutable records, not current approval recommendations
      </Typography>
    </div>
  );
}
function Coverage({ data }: { data: { coverageStart: string; retainedAfter: string } }) {
  return (
    <Typography color="text.secondary" variant="body2" className="notifications-coverage">
      Coverage starts {data.coverageStart}. Retained events since {data.retainedAfter}. Older
      activity may not be included.
    </Typography>
  );
}
function RepositoryOverview({ access }: { access: NotificationAccessState }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [...notificationQueryRoot, access.session, "overview", page],
    enabled: access.readable,
    queryFn: ({ signal }) => {
      if (!access.principal) throw new Error("A verified operator is required.");
      return notifications.overview({ page, pageSize: 20 }, access.principal, signal);
    },
    ...queryOptions,
  });
  useNotificationFailure(access, query.error);
  return (
    <Box component="section" aria-label="Repository inboxes">
      <Stack
        direction="row"
        className="notifications-section-header"
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 2 }}
      >
        <Typography component="h2" variant="h6">
          Repository inboxes
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Button onClick={() => void access.refreshAccess()}>Refresh access</Button>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
        </Stack>
      </Stack>
      <Box>
        <NotificationSummary access={access} />
        <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
          Repositories with retained events that you can currently read. Open a repository to
          inspect events and manage your personal read state.
        </Typography>
        {query.isError ? (
          <Alert severity="error">
            <AlertTitle>Could not load notification overview</AlertTitle>
            No previous counts are shown. Refresh to try again.
          </Alert>
        ) : !query.data ? (
          <Stack role="status" sx={{ alignItems: "center", py: 6 }}>
            <CircularProgress aria-label="Loading notification overview" />
          </Stack>
        ) : (
          <>
            <TableContainer sx={{ bgcolor: "background.paper", borderRadius: "12px" }}>
              <Table aria-label="Repository notification inboxes">
                <TableHead>
                  <TableRow>
                    <TableCell>Repository</TableCell>
                    <TableCell align="right">Unread</TableCell>
                    <TableCell align="right">Read</TableCell>
                    <TableCell align="right">Archived</TableCell>
                    <TableCell align="right">Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {query.data.items.map((item: NotificationRepositoryOverview) => (
                    <TableRow key={item.repositoryId} hover>
                      <TableCell component="th" scope="row">
                        <Link
                          component={RouterLink}
                          underline="hover"
                          variant="body2"
                          to={`/notifications?${new URLSearchParams({ repositoryId: item.repositoryId })}`}
                        >
                          {item.fullName}
                        </Link>
                      </TableCell>
                      <TableCell align="right">{item.counts.unread}</TableCell>
                      <TableCell align="right">{item.counts.read}</TableCell>
                      <TableCell align="right">{item.counts.archived}</TableCell>
                      <TableCell align="right">{item.counts.total}</TableCell>
                    </TableRow>
                  ))}
                  {query.data.items.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 4, color: "text.secondary" }}>
                        <EmptyState title="No retained notifications are available in your repositories." />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
            {query.data.total > 20 && (
              <Pagination
                page={page}
                count={Math.ceil(query.data.total / 20)}
                onChange={(_, nextPage) => setPage(nextPage)}
                sx={{ mt: 2 }}
              />
            )}
            <Coverage data={query.data} />
          </>
        )}
      </Box>
    </Box>
  );
}

function RepositoryInbox({
  repositoryId,
  access,
}: {
  repositoryId: string;
  access: NotificationAccessState;
}) {
  const client = useQueryClient();
  const [filter, setFilter] = useState<NotificationListQuery>({
    state: "all",
    workItemKind: "all",
  });
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<string[]>([]);
  const [intent, setIntent] = useState<NotificationStateChangeRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  const selectionEpoch = useRef(access.session);
  useEffect(() => {
    if (!access.readable || selectionEpoch.current !== access.session) {
      setSelected([]);
      selectionEpoch.current = access.session;
    }
  }, [access.readable, access.session]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const cursor = cursors.at(-1);
  const input = { limit: 20, ...filter, ...(cursor ? { cursor } : {}) };
  const query = useQuery({
    queryKey: [...notificationQueryRoot, access.session, "list", repositoryId, input],
    enabled: access.readable,
    queryFn: ({ signal }) => {
      if (!access.principal) throw new Error("A verified operator is required.");
      return notifications.list(repositoryId, input, access.principal, signal);
    },
    ...queryOptions,
  });
  useNotificationFailure(access, query.error);
  const items = !query.isError ? query.data?.items : undefined;
  const visibleSelection = selected.filter((id) => items?.some((item) => item.event.id === id));
  useEffect(() => {
    if (query.isError) {
      setSelected([]);
    } else if (query.data)
      setSelected((previous) =>
        previous.filter((id) => query.data.items.some((item) => item.event.id === id)),
      );
  }, [query.isError, query.data]);
  const clearSelection = () => {
    setSelected([]);
    setIntent(null);
    setFailure(null);
    setNotice(null);
  };
  const submit = async (request: NotificationStateChangeRequest) => {
    if (!live.current || !access.readable || !access.principal || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    setIntent(request);
    try {
      const receipt = await notifications.change(repositoryId, request, access.principal);
      if (!live.current) return;
      setIntent(null);
      setSelected([]);
      setNotice(
        `${receipt.changes.length} notification${receipt.changes.length === 1 ? "" : "s"} updated for your account${receipt.replayed ? " (original change confirmed)" : ""}.`,
      );
      await client.invalidateQueries({ queryKey: notificationQueryRoot });
    } catch (error) {
      if (!live.current) return;
      if (notificationAccessDenied(error)) {
        clearSelection();
        access.invalidate();
        return;
      }
      if (error instanceof ReviewControlHttpError && error.status >= 400 && error.status < 500) {
        setIntent(null);
        setSelected([]);
        setFailure(
          error.status === 409
            ? "Notification state changed. Refresh and select the current rows before trying again."
            : "The state change was rejected. Refresh before trying again.",
        );
      } else
        setFailure(
          "The response could not be confirmed. Retry the original change to recover its receipt, or discard it and refresh before making a new selection.",
        );
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  };
  const change = (state: NotificationState) => {
    if (!items || intent || busy) return;
    try {
      void submit(
        createNotificationStateChange(items, visibleSelection, state, crypto.randomUUID()),
      );
    } catch {
      setFailure("Select notifications from the current page before applying a change.");
    }
  };
  const changeFilter = (value: NotificationListQuery) => {
    setFilter(value);
    setCursors([undefined]);
    clearSelection();
  };
  return (
    <Box component="section" aria-label="Your notification inbox">
      <Stack
        direction="row"
        className="notifications-section-header"
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 2 }}
      >
        <Typography component="h2" variant="h6">
          Your notification inbox
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Button disabled={busy} onClick={() => void access.refreshAccess()}>
            Refresh access
          </Button>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            disabled={busy || !!intent}
            loading={query.isFetching}
            onClick={() => {
              clearSelection();
              void query.refetch();
            }}
          >
            Refresh
          </Button>
        </Stack>
      </Stack>
      <Box>
        <NotificationSummary repositoryId={repositoryId} access={access} />
        <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
          Opening an event does not mark it as read. Read and archive changes affect only your
          account. Events refresh every 20 seconds while this page is visible.
        </Typography>
        <Stack
          direction="row"
          spacing={2}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
          className="notifications-toolbar"
        >
          <FormControl sx={{ minWidth: 170 }} disabled={busy || !!intent}>
            <InputLabel id="notification-state-filter-label">Notification state</InputLabel>
            <Select
              labelId="notification-state-filter-label"
              label="Notification state"
              value={filter.state ?? "all"}
              inputProps={{ "aria-label": "Filter notification state" }}
              onChange={(event) =>
                changeFilter({
                  ...filter,
                  state: event.target.value as NotificationListQuery["state"],
                })
              }
            >
              <MenuItem value="all">All states</MenuItem>
              <MenuItem value="unread">Unread</MenuItem>
              <MenuItem value="read">Read</MenuItem>
              <MenuItem value="archived">Archived</MenuItem>
            </Select>
          </FormControl>
          <FormControl sx={{ minWidth: 180 }} disabled={busy || !!intent}>
            <InputLabel id="notification-kind-filter-label">Work item kind</InputLabel>
            <Select
              labelId="notification-kind-filter-label"
              label="Work item kind"
              value={filter.workItemKind ?? "all"}
              inputProps={{ "aria-label": "Filter notification work item kind" }}
              onChange={(event) =>
                changeFilter({
                  ...filter,
                  workItemKind: event.target.value as NotificationListQuery["workItemKind"],
                })
              }
            >
              <MenuItem value="all">PRs and issues</MenuItem>
              <MenuItem value="pull_request">Pull requests</MenuItem>
              <MenuItem value="issue">Issues</MenuItem>
            </Select>
          </FormControl>
          <Typography variant="body2" sx={{ ml: { sm: "auto" } }}>
            {visibleSelection.length} selected on this page
          </Typography>
          <Button
            disabled={busy || !!intent || visibleSelection.length === 0 || query.isError}
            onClick={() => change("read")}
          >
            Mark read
          </Button>
          <Button
            disabled={busy || !!intent || visibleSelection.length === 0 || query.isError}
            onClick={() => change("unread")}
          >
            Mark unread
          </Button>
          <Button
            disabled={busy || !!intent || visibleSelection.length === 0 || query.isError}
            onClick={() => change("archived")}
          >
            Archive
          </Button>
        </Stack>
        {notice && <Alert severity="success">{notice}</Alert>}
        {failure && (
          <Alert
            severity="error"
            action={
              intent ? (
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                  <Button loading={busy} onClick={() => void submit(intent)}>
                    Retry original change
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      clearSelection();
                      void query.refetch();
                    }}
                  >
                    Discard and refresh
                  </Button>
                </Stack>
              ) : undefined
            }
          >
            <AlertTitle>Notification state was not confirmed</AlertTitle>
            {failure}
          </Alert>
        )}
        {query.isError ? (
          <Alert severity="error">
            <AlertTitle>Could not load notifications</AlertTitle>
            Previous events and selection are hidden. Refresh to try again.
          </Alert>
        ) : !query.data || !items ? (
          <Stack role="status" sx={{ alignItems: "center", py: 6 }}>
            <CircularProgress aria-label="Loading notifications" />
          </Stack>
        ) : (
          <>
            <TableContainer sx={{ bgcolor: "background.paper", borderRadius: "12px" }}>
              <Table aria-label="Your notifications" sx={{ minWidth: 850 }}>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={items.length > 0 && visibleSelection.length === items.length}
                        indeterminate={
                          visibleSelection.length > 0 && visibleSelection.length < items.length
                        }
                        disabled={busy || !!intent || items.length === 0}
                        slotProps={{
                          input: { "aria-label": "Select all notifications on this page" },
                        }}
                        onChange={(event) => {
                          setSelected(
                            event.target.checked ? items.map((item) => item.event.id) : [],
                          );
                          setNotice(null);
                        }}
                      />
                    </TableCell>
                    <TableCell>Event</TableCell>
                    <TableCell sx={{ width: 120 }}>Work item</TableCell>
                    <TableCell sx={{ width: 110 }}>Your state</TableCell>
                    <TableCell sx={{ width: 200 }}>Occurred</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item: NotificationItem) => (
                    <TableRow
                      key={item.event.id}
                      selected={visibleSelection.includes(item.event.id)}
                      hover
                    >
                      <TableCell padding="checkbox">
                        <Checkbox
                          checked={visibleSelection.includes(item.event.id)}
                          disabled={busy || !!intent}
                          slotProps={{
                            input: { "aria-label": `Select notification ${item.event.id}` },
                          }}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setSelected((previous) =>
                              checked
                                ? [...previous.filter((id) => id !== item.event.id), item.event.id]
                                : previous.filter((id) => id !== item.event.id),
                            );
                            setNotice(null);
                          }}
                        />
                      </TableCell>
                      <TableCell component="th" scope="row">
                        <Box className="notification-event">
                          <Link
                            component={RouterLink}
                            underline="hover"
                            variant="body1"
                            aria-label={`Open notification ${item.event.id}`}
                            to={notificationHref(item.event)}
                          >
                            {notificationLabel(item.event)}
                          </Link>
                          <Typography color="text.secondary" variant="body2">
                            {notificationDescription(item.event)}
                          </Typography>
                          {item.event.kind === "validation" && (
                            <Typography color="text.secondary" variant="body2">
                              {workflowLabels[item.event.workflowKind]} · {item.event.target}
                            </Typography>
                          )}
                        </Box>
                      </TableCell>
                      <TableCell>
                        {`${item.event.workItemKind === "pull_request" ? "PR" : "Issue"} #${item.event.number}`}
                      </TableCell>
                      <TableCell>
                        <Chip
                          color={item.state.state === "unread" ? "primary" : "default"}
                          label={item.state.state}
                        />
                      </TableCell>
                      <TableCell>
                        <time dateTime={item.event.occurredAt}>{item.event.occurredAt}</time>
                      </TableCell>
                    </TableRow>
                  ))}
                  {items.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 4, color: "text.secondary" }}>
                        <EmptyState
                          title={
                            query.data.nextCursor
                              ? "No matching events in this time window. Continue to older events."
                              : "No matching notifications in the retained event history."
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
            {query.data.scanLimited && (
              <Typography color="text.secondary" variant="body2" sx={{ mt: 2 }}>
                This page covers a bounded window of events. Continue to older events to look
                further back.
              </Typography>
            )}
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap" }}
              className="notifications-pagination"
            >
              <Button
                disabled={busy || !!intent || cursors.length === 1}
                onClick={() => {
                  setCursors((previous) => previous.slice(0, -1));
                  clearSelection();
                }}
              >
                Newer page
              </Button>
              <Button
                variant="outlined"
                disabled={busy || !!intent || !query.data.nextCursor}
                onClick={() => {
                  const next = query.data.nextCursor;
                  if (next) {
                    setCursors((previous) => [...previous, next]);
                    clearSelection();
                  }
                }}
              >
                Older events
              </Button>
              <Button
                disabled={busy || !!intent || cursors.length === 1}
                onClick={() => {
                  setCursors([undefined]);
                  clearSelection();
                }}
              >
                Newest events
              </Button>
            </Stack>
            <Coverage data={query.data} />
          </>
        )}
      </Box>
    </Box>
  );
}

export default function NotificationsPage() {
  const scope = useRepositoryScope();
  const access = useNotificationAccess(scope.repositoryId);
  return (
    <section className="notifications-page">
      <PageHeader
        eyebrow="Operations"
        title="Notifications"
        description="Follow validation outcomes and publication delivery across your repositories."
      />
      {access.sample ? (
        <NotificationAccess access={access}>{null}</NotificationAccess>
      ) : !scope.ready ? (
        <RepositoryScopeUnavailable />
      ) : (
        <NotificationAccess access={access}>
          {scope.repositoryId ? (
            <RepositoryInbox
              key={access.bindingSession}
              repositoryId={scope.repositoryId}
              access={access}
            />
          ) : (
            <RepositoryOverview key={access.bindingSession} access={access} />
          )}
        </NotificationAccess>
      )}
    </section>
  );
}
