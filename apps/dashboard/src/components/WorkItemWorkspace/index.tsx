import {
  AccountTreeOutlined,
  AdjustRounded,
  ChevronRightRounded,
  CloseRounded,
  ExpandMoreRounded,
  GitHub,
  HistoryRounded,
  InboxOutlined,
  PlayArrowRounded,
  RefreshRounded,
  SearchRounded,
} from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Avatar,
  Box,
  Button,
  Chip,
  type ChipProps,
  Drawer,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  TablePagination,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CreateReviewRunModal } from "@/components/CreateReviewRun";
import { JobDetailsPanel } from "@/components/JobDetails";
import {
  clearNotificationTargetParameters,
  notificationTargetPath,
  parseNotificationTarget,
} from "@/components/NotificationTarget/targets";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { ReviewRunsDrawer, ReviewRunsPanel } from "@/components/ReviewRuns";
import { reviewPermissionUnavailableReason } from "@/components/ReviewRuns/actions";
import { ErrorNotice } from "@/components/ReviewRuns/common";
import { completedLatestJobProgress, loadLatestWorkItemRun } from "@/components/ReviewRuns/latest";
import {
  loadNotificationRun,
  notificationRunWorkItem,
  type ValidationNotificationTarget,
} from "@/components/ReviewRuns/navigation";
import { DetailsGrid, EmptyState } from "@/components/ui";
import { reviewControl, type WorkItem, type WorkItemKind } from "@/services/review-control";
import { runs } from "@/services/runs";
import { shortSha } from "@/utils/format";
import "./index.css";

type ProgressTone = "quiet" | "active" | "success" | "warning" | "danger";

interface WorkItemProgress {
  label: string;
  detail: string;
  tone: ProgressTone;
}

const copy = {
  pull_request: {
    title: "Pull requests",
    description: "Review code changes, read findings, and keep track of the revision under review.",
    item: "pull request",
    search: "Search pull requests by title, number, or author",
    inbox: "Review inbox",
    action: "Open results",
    empty: "No pull requests to review",
    emptyDescription:
      "Pull requests appear here after GitHub synchronization. Request a review on GitHub to start.",
    noRun: "This pull request has no review yet",
    noRunDescription:
      "Ask an authorized maintainer to request a review from the configured reviewer on GitHub. The review will appear here once scheduled.",
  },
  issue: {
    title: "Issues",
    description: "Triage reports, inspect suggested labels, and identify what needs a closer look.",
    item: "issue",
    search: "Search issues by title, number, or author",
    inbox: "Triage inbox",
    action: "Open results",
    empty: "No issues to triage",
    emptyDescription:
      "Issues appear here after GitHub synchronization. Assign an issue to the configured reviewer to start triage.",
    noRun: "This issue has not been triaged",
    noRunDescription:
      "Ask an authorized maintainer to assign this issue to the configured reviewer on GitHub. Triage will appear here once scheduled.",
  },
} as const;

const stageLabels: Record<WorkItem["stage"], string> = {
  not_scheduled: "Not scheduled",
  awaiting_admission: "Awaiting admission",
  queued: "Queued",
  preparing: "Preparing",
  reviewing: "Reviewing",
  validating: "Validating",
  waiting_approval: "Finalizing",
  publishing: "Publishing",
  done: "Finished",
};

const authorizationLabels: Record<WorkItem["authorization"], string> = {
  self: "Authorized by the reviewer",
  allowlisted: "Authorized maintainer",
  denied: "Request not authorized",
  pending: "No authorized request",
};

const stateLabels: Record<WorkItem["state"], string> = {
  active: "Open",
  assigned: "Open · assigned",
  closed: "Closed",
  open: "Open",
  unassigned: "Open · unassigned",
};

function progressFor(item: WorkItem): WorkItemProgress {
  const isPullRequest = item.kind === "pull_request";
  if (!item.latestJobId) {
    return {
      label:
        item.authorization === "denied"
          ? "Not authorized"
          : item.trigger === "not_requested"
            ? "Not requested"
            : "Not scheduled",
      detail: item.state === "closed" ? "Closed on GitHub" : "Start from GitHub",
      tone: item.authorization === "denied" ? "warning" : "quiet",
    };
  }
  if (item.latestJobStatus === "failed" || item.latestJobStatus === "dead_letter") {
    return {
      label: "Needs attention",
      detail: item.latestJobStatus === "dead_letter" ? "Retry limit reached" : "Execution failed",
      tone: "danger",
    };
  }
  if (item.latestJobStatus === "cancelled" || item.latestJobStatus === "stale") {
    return {
      label: item.latestJobStatus === "cancelled" ? "Cancelled" : "Superseded",
      detail: "No current result",
      tone: "quiet",
    };
  }
  if (item.freshness === "superseded") {
    return {
      label: "New revision",
      detail:
        item.latestJobStatus === "succeeded"
          ? "Previous result available"
          : "Execution targets an earlier revision",
      tone: "warning",
    };
  }
  if (item.latestJobStatus === "succeeded") {
    return completedLatestJobProgress;
  }
  if (item.latestJobStatus === "cancel_requested") {
    return { label: "Cancelling", detail: "Waiting for execution to stop", tone: "warning" };
  }
  if (item.latestJobStatus === "retry_waiting") {
    return {
      label: item.latestJobAdmission?.state === "pending" ? "Awaiting admission" : "Queued",
      detail: "Waiting for another attempt; retry backoff still applies",
      tone: "warning",
    };
  }
  if (item.latestJobAdmission?.state === "pending")
    return {
      label: "Awaiting admission",
      detail: "Execution saved; waiting to enter the queue",
      tone: "quiet",
    };
  if (item.latestJobStatus === "queued" || item.stage === "queued") {
    return { label: "Queued", detail: "Waiting for an available worker", tone: "quiet" };
  }
  if (item.stage === "waiting_approval") {
    return { label: "Finalizing", detail: "Collecting the result", tone: "active" };
  }
  return {
    label: !isPullRequest && item.stage === "reviewing" ? "Triaging" : stageLabels[item.stage],
    detail: isPullRequest ? "Review in progress" : "Triage in progress",
    tone: "active",
  };
}

function Progress({ item, compact = false }: { item: WorkItem; compact?: boolean }) {
  const progress = progressFor(item);
  const colors: Record<ProgressTone, ChipProps["color"]> = {
    quiet: "default",
    active: "primary",
    success: "success",
    warning: "warning",
    danger: "error",
  };

  return (
    <div className={`workspace-progress${compact ? " workspace-progress--compact" : ""}`}>
      <Tooltip title={compact ? progress.detail : undefined}>
        <Chip
          color={colors[progress.tone]}
          label={progress.label}
          variant={progress.tone === "active" ? "filled" : "outlined"}
        />
      </Tooltip>
      {!compact ? (
        <Typography variant="body2" color="text.secondary">
          {progress.detail}
        </Typography>
      ) : null}
    </div>
  );
}

function updatedLabel(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function RequestContext({ item }: { item: WorkItem }) {
  if (item.trigger === "not_requested") {
    return <span className="workspace-secondary">No request yet</span>;
  }
  return (
    <span className="workspace-secondary">
      {item.trigger === "review_requested"
        ? "Review requested"
        : item.kind === "issue"
          ? "Assigned for triage"
          : "Assigned for review"}{" "}
      by {item.scheduledBy}
    </span>
  );
}

function ItemIcon({ kind }: { kind: WorkItemKind }) {
  return kind === "pull_request" ? (
    <AccountTreeOutlined fontSize="small" />
  ) : (
    <AdjustRounded fontSize="small" />
  );
}

const itemKey = (item: WorkItem) => `${item.repositoryId}:${item.id}`;

interface WorkItemListRowProps {
  item: WorkItem;
  disabled?: boolean;
  onOpenDetails: (item: WorkItem) => void;
  onViewRuns: (item: WorkItem) => void;
}

export function WorkItemListRow({
  item,
  disabled = false,
  onOpenDetails,
  onViewRuns,
}: WorkItemListRowProps) {
  const content = copy[item.kind];
  const openDetails = () => {
    if (disabled) return;
    onOpenDetails(item);
  };
  return (
    <ListItem
      disablePadding
      className="workspace-list-item"
      secondaryAction={
        <div className="workspace-list-item__actions">
          <Tooltip title="View runs">
            <span>
              <IconButton
                disabled={disabled}
                aria-label={`View runs for ${content.item} ${item.number}`}
                onClick={() => {
                  if (disabled) return;
                  onViewRuns(item);
                }}
              >
                <HistoryRounded />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={item.latestJobStatus === "succeeded" ? content.action : "Open details"}>
            <span>
              <IconButton
                disabled={disabled}
                aria-label={`Open ${content.item} ${item.number}`}
                onClick={openDetails}
              >
                <ChevronRightRounded />
              </IconButton>
            </span>
          </Tooltip>
        </div>
      }
    >
      <ListItemButton
        className="workspace-list-item__button"
        disabled={disabled}
        onClick={openDetails}
        aria-label={`Open ${content.item} ${item.number}: ${item.title}`}
      >
        <ListItemIcon className="workspace-list-item__leading">
          <Avatar className="workspace-list-item__avatar">
            <ItemIcon kind={item.kind} />
          </Avatar>
        </ListItemIcon>
        <ListItemText
          className="workspace-list-item__text"
          primary={item.title}
          secondary={
            <>
              {item.repository} <code>#{item.number}</code> · {item.author}
              {item.state === "closed" ? " · Closed" : null}
              {item.kind === "pull_request" && item.headSha ? (
                <>
                  {" "}
                  · <code>{shortSha(item.headSha)}</code>
                </>
              ) : null}
            </>
          }
          slotProps={{
            primary: {
              component: "span",
              sx: { fontSize: 16, lineHeight: "24px", fontWeight: 500 },
            },
            secondary: {
              component: "span",
              sx: { display: "block", mt: 0.5, fontSize: 14, lineHeight: "20px" },
            },
          }}
        />
        <div className="workspace-list-item__activity">
          <Progress item={item} compact />
          <Tooltip title={`Last synchronized: ${new Date(item.updatedAt).toLocaleString("en-US")}`}>
            <time className="workspace-updated" dateTime={item.updatedAt}>
              {updatedLabel(item.updatedAt)}
            </time>
          </Tooltip>
        </div>
      </ListItemButton>
    </ListItem>
  );
}

function WorkItemRequestContext({ item }: { item: WorkItem }) {
  return (
    <Accordion
      disableGutters
      elevation={0}
      className="workspace-request-context"
      sx={{ mb: 3, bgcolor: "transparent", "&::before": { display: "none" } }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreRounded />}
        aria-controls="work-item-request-context"
        id="work-item-request-context-heading"
      >
        <Typography component="h3" variant="subtitle1">
          Request context
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <DetailsGrid
          columns={2}
          items={[
            { label: "GitHub state", value: stateLabels[item.state] },
            { label: "Request", value: <RequestContext item={item} /> },
            { label: "Authorization", value: authorizationLabels[item.authorization] },
            ...(item.headSha
              ? [
                  {
                    label: "Current revision",
                    value: (
                      <Tooltip title={item.headSha}>
                        <code>{shortSha(item.headSha)}</code>
                      </Tooltip>
                    ),
                  },
                ]
              : []),
            ...(item.reviewedSha
              ? [
                  {
                    label: "Reviewed revision",
                    value: (
                      <Tooltip title={item.reviewedSha}>
                        <code>{shortSha(item.reviewedSha)}</code>
                      </Tooltip>
                    ),
                  },
                ]
              : []),
            ...(item.latestJobAttemptCount !== null
              ? [{ label: "Job attempts", value: item.latestJobAttemptCount }]
              : []),
            ...(item.workerNodeId
              ? [{ label: "Worker", value: <code>{item.workerNodeId}</code> }]
              : []),
            { label: "Last synchronized", value: new Date(item.updatedAt).toLocaleString("en-US") },
          ]}
        />
      </AccordionDetails>
    </Accordion>
  );
}
interface WorkItemDetailsProps {
  item: WorkItem | null;
  onClose: () => void;
  onViewRuns: (item: WorkItem) => void;
  onRunValidation: (item: WorkItem) => void;
}

export function WorkItemDetails(props: WorkItemDetailsProps) {
  if (!props.item) return null;
  return (
    <OperatorAccessGate repositoryId={props.item.repositoryId} permission="read">
      <WorkItemDetailsContent
        key={`${props.item.repositoryId}:${props.item.id}`}
        {...props}
        item={props.item}
      />
    </OperatorAccessGate>
  );
}

function WorkItemDetailsContent({
  item,
  onClose,
  onViewRuns,
  onRunValidation,
}: Omit<WorkItemDetailsProps, "item"> & { item: WorkItem }) {
  const content = copy[item.kind];
  const access = useOperatorAccess(item.repositoryId);
  const permissionReason = reviewPermissionUnavailableReason(access);
  const latestRun = useQuery({
    queryKey: ["review-runs", item.repositoryId, item.id, "latest", ...access.identityKey],
    retry: false,
    enabled: access.can("read"),
    staleTime: Infinity,
    refetchOnMount: "always",
    queryFn: () => loadLatestWorkItemRun(runs, item),
  });
  return (
    <Drawer
      anchor="right"
      open
      onClose={onClose}
      slotProps={{
        paper: {
          className: "workspace-detail",
          role: "dialog",
          "aria-labelledby": "workspace-detail-title",
          sx: { width: { xs: "100%", md: 860 }, maxWidth: "100vw" },
        },
      }}
    >
      <div className="workspace-detail__bar">
        <Typography
          component="h2"
          variant="subtitle1"
          id="workspace-detail-title"
          className="workspace-detail__identity"
        >
          {access.checking ? (
            "Work item"
          ) : (
            <>
              <ItemIcon kind={item.kind} />
              <span>{item.kind === "pull_request" ? "Pull request" : "Issue"}</span>
              <code>#{item.number}</code>
            </>
          )}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          {!access.checking ? (
            <Button href={item.githubUrl} startIcon={<GitHub />} target="_blank" rel="noreferrer">
              GitHub
            </Button>
          ) : null}
          <IconButton aria-label="Close work item details" onClick={onClose}>
            <CloseRounded />
          </IconButton>
        </Stack>
      </div>
      <Box sx={{ p: { xs: 2, sm: 3 } }}>
        {access.checking ? (
          <Stack role="status" aria-label="Verifying repository access" spacing={1.5}>
            <Skeleton width="60%" />
            <Skeleton height={120} />
          </Stack>
        ) : (
          <>
            <header className="workspace-detail__header">
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {item.repository}
              </Typography>
              <Typography component="h2" variant="h5" sx={{ mb: 1.5 }}>
                {item.title}
              </Typography>
              <div className="workspace-detail__context">
                <span className="workspace-secondary">Opened by {item.author}</span>
                <span aria-hidden="true">·</span>
                <RequestContext item={item} />
              </div>
            </header>
            <Box sx={{ mb: 3 }}>
              <Progress item={item} />
              {item.attentionReason ? (
                <Typography variant="body2" color="error.main" sx={{ mt: 1 }}>
                  {item.attentionReason}
                </Typography>
              ) : null}
            </Box>
            <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 2, flexWrap: "wrap" }}>
              <Button
                variant="outlined"
                startIcon={<HistoryRounded />}
                disabled={!access.can("read")}
                onClick={() => {
                  if (!access.can("read")) return;
                  onViewRuns(item);
                }}
              >
                View runs
              </Button>
              <Tooltip title={permissionReason}>
                <span>
                  <Button
                    variant="contained"
                    startIcon={<PlayArrowRounded />}
                    disabled={!access.can("review")}
                    onClick={() => {
                      if (!access.can("review")) return;
                      onRunValidation(item);
                    }}
                  >
                    Run validation
                  </Button>
                </span>
              </Tooltip>
            </Stack>
            {permissionReason ? (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {permissionReason}
              </Typography>
            ) : null}
            <WorkItemRequestContext item={item} />
            {latestRun.data === null && item.freshness === "superseded" ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                <AlertTitle>A newer revision is available</AlertTitle>
                The execution below targets an earlier revision. Start a new authorized request on
                GitHub to review the current revision.
              </Alert>
            ) : null}
            {latestRun.isError ? (
              <ErrorNotice
                title="Could not load the latest validation run"
                error={latestRun.error}
                retry={() => void latestRun.refetch()}
              />
            ) : latestRun.isPending ? (
              <Stack role="status" aria-label="Loading latest validation run" spacing={1}>
                <Skeleton height={48} />
                <Skeleton variant="rounded" height={180} />
              </Stack>
            ) : latestRun.data ? (
              <ReviewRunsPanel
                key={`${itemKey(item)}:${latestRun.data.id}`}
                workItem={item}
                initialRunId={latestRun.data.id}
                embedded
              />
            ) : item.latestJobId ? (
              <JobDetailsPanel
                key={item.latestJobId}
                repositoryId={item.repositoryId}
                jobId={item.latestJobId}
                embedded
              />
            ) : (
              <Stack spacing={3}>
                <Alert severity="info">
                  <AlertTitle>{content.noRun}</AlertTitle>
                  {item.state === "closed"
                    ? "This item is closed on GitHub. Reopen it before making a new authorized request."
                    : content.noRunDescription}
                </Alert>
                <Button
                  href={item.githubUrl}
                  target="_blank"
                  rel="noreferrer"
                  startIcon={<GitHub />}
                  sx={{ alignSelf: "flex-start" }}
                >
                  Open {content.item} on GitHub
                </Button>
              </Stack>
            )}
          </>
        )}
      </Box>
    </Drawer>
  );
}
export function WorkItemWorkspace({ kind }: { kind: WorkItemKind }) {
  const scope = useRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  const selection = parseNotificationTarget(location.pathname, location.search);
  const target =
    selection.kind === "target" && selection.target.kind === "validation" ? selection.target : null;
  const closeTarget = () =>
    navigate({
      pathname: location.pathname,
      search: clearNotificationTargetParameters(location.search),
      hash: location.hash,
    });
  if (!scope.ready) return <RepositoryScopeUnavailable />;
  return (
    <>
      <ScopedWorkItemWorkspace
        key={`${kind}:${scope.key}:${target ? notificationTargetPath(target) : selection.kind}`}
        kind={kind}
        repositoryId={scope.repositoryId}
        repositoryName={scope.label}
      />
      {selection.kind === "invalid" ? (
        <Drawer
          anchor="right"
          open
          onClose={closeTarget}
          slotProps={{
            paper: {
              role: "dialog",
              "aria-labelledby": "workspace-invalid-target-title",
              sx: { width: { xs: "100%", sm: 480 }, maxWidth: "100vw" },
            },
          }}
        >
          <div className="workspace-detail__bar">
            <Typography id="workspace-invalid-target-title" component="h2" variant="subtitle1">
              Validation target unavailable
            </Typography>
            <IconButton aria-label="Close validation target" onClick={closeTarget}>
              <CloseRounded />
            </IconButton>
          </div>
          <Box sx={{ p: 3 }}>
            <Alert severity="error">
              <AlertTitle>Invalid validation target</AlertTitle>
              {selection.message}
            </Alert>
          </Box>
        </Drawer>
      ) : target ? (
        <NotificationRunTarget
          key={notificationTargetPath(target)}
          target={target}
          onClose={closeTarget}
        />
      ) : null}
    </>
  );
}

export function NotificationRunTarget({
  target,
  onClose,
}: {
  target: ValidationNotificationTarget;
  onClose: () => void;
}) {
  return (
    <OperatorAccessGate repositoryId={target.repositoryId} permission="read">
      <NotificationRunTargetContent target={target} onClose={onClose} />
    </OperatorAccessGate>
  );
}

function NotificationRunTargetContent({
  target,
  onClose,
}: {
  target: ValidationNotificationTarget;
  onClose: () => void;
}) {
  const access = useOperatorAccess(target.repositoryId);
  const query = useQuery({
    queryKey: ["notification-run-target", notificationTargetPath(target), ...access.identityKey],
    enabled: access.can("read"),
    retry: false,
    staleTime: Infinity,
    refetchOnMount: "always",
    queryFn: () => loadNotificationRun(runs, target),
  });
  if (!query.isError && query.isSuccess) {
    return (
      <ReviewRunsDrawer
        workItem={notificationRunWorkItem(query.data)}
        initialRunId={target.reviewRunId}
        initialRequestId={target.requestId}
        initialJobId={target.jobId}
        onClose={onClose}
      />
    );
  }
  return (
    <Drawer
      anchor="right"
      open
      onClose={onClose}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-labelledby": "workspace-target-title",
          sx: { width: { xs: "100%", sm: 480 }, maxWidth: "100vw" },
        },
      }}
    >
      <div className="workspace-detail__bar">
        <Typography component="h2" variant="subtitle1" id="workspace-target-title">
          Validation target
        </Typography>
        <IconButton aria-label="Close validation target" onClick={onClose}>
          <CloseRounded />
        </IconButton>
      </div>
      <Stack spacing={2} sx={{ p: 3 }}>
        <Button
          disabled={access.checking}
          loading={access.checking}
          onClick={() => void access.refresh()}
        >
          Refresh access
        </Button>
        {access.checking || query.isPending ? (
          <Stack role="status" aria-label="Loading the exact validation target">
            <Skeleton height={48} />
            <Skeleton variant="rounded" height={120} />
          </Stack>
        ) : (
          <ErrorNotice
            title="Could not load the notification's validation target"
            error={query.error}
            retry={() => void query.refetch()}
          />
        )}
      </Stack>
    </Drawer>
  );
}

function ScopedWorkItemWorkspace({
  kind,
  repositoryId,
  repositoryName,
}: {
  kind: WorkItemKind;
  repositoryId?: string;
  repositoryName: string;
}) {
  const content = copy[kind];
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<string>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [runView, setRunView] = useState<{ item: WorkItem; runId?: string } | null>(null);
  const [creatingRunItem, setCreatingRunItem] = useState<WorkItem | null>(null);
  const listAccess = useOperatorAccess(repositoryId);
  const actionRepositoryId =
    selectedItem?.repositoryId ??
    runView?.item.repositoryId ??
    creatingRunItem?.repositoryId ??
    repositoryId;
  const access = useOperatorAccess(actionRepositoryId);
  const mayRead = listAccess.can("read");
  const requestVersion = useRef(0);
  const queryKey = JSON.stringify({
    kind,
    repositoryId,
    page,
    pageSize,
    search,
    stage,
    identity: listAccess.identityKey,
  });
  const isUpdating = loading || settledQuery !== queryKey || searchInput.trim() !== search;
  const currentError = isUpdating ? null : error;
  const openDetails = (item: WorkItem) => {
    setSelectedItem(item);
  };
  const viewRuns = (item: WorkItem) => {
    setSelectedItem(null);
    setRunView({ item });
  };
  const runValidation = (item: WorkItem) => {
    if (item.repositoryId !== actionRepositoryId || !access.can("review")) return;
    setSelectedItem(null);
    setCreatingRunItem(item);
  };
  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setStage(undefined);
    setPage(1);
  };

  useEffect(() => {
    if (searchInput.trim() === search) return undefined;
    const timeout = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput, search]);

  const loadItems = useCallback(() => {
    if (!mayRead) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    void reviewControl
      .listWorkItems({
        page,
        pageSize,
        search: search || undefined,
        filters: { kind, stage, repositoryId },
      })
      .then((result) => {
        if (version !== requestVersion.current) return;
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setItems(result.items);
        setTotal(result.total);
        setSettledQuery(queryKey);
      })
      .catch((reason: unknown) => {
        if (version !== requestVersion.current) return;
        setItems([]);
        setTotal(0);
        setSettledQuery(queryKey);
        setError(reason instanceof Error ? reason.message : "The request could not be completed.");
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  }, [kind, page, pageSize, queryKey, repositoryId, search, stage, mayRead]);

  useEffect(() => {
    loadItems();
    return () => {
      requestVersion.current += 1;
    };
  }, [loadItems]);

  return (
    <section
      className="workspace-page"
      aria-labelledby={`workspace-${kind}-title`}
      hidden={listAccess.checking}
      inert={listAccess.checking}
      aria-hidden={listAccess.checking}
    >
      <PageHeader
        eyebrow={repositoryName}
        titleId={`workspace-${kind}-title`}
        title={content.title}
        description={content.description}
        actions={
          <Button
            variant="outlined"
            startIcon={<RefreshRounded />}
            onClick={loadItems}
            disabled={isUpdating}
          >
            Refresh
          </Button>
        }
      />
      <Paper elevation={0} aria-label={content.title} className="workspace-panel">
        <search className="workspace-toolbar" aria-label={`Find ${content.title.toLowerCase()}`}>
          <TextField
            className="workspace-search"
            variant="filled"
            hiddenLabel
            placeholder={`Search ${content.title.toLowerCase()}`}
            onChange={(event) => setSearchInput(event.target.value)}
            value={searchInput}
            slotProps={{
              htmlInput: {
                maxLength: 512,
                "aria-label": `Search ${content.title.toLowerCase()}`,
              },
              input: {
                disableUnderline: true,
                sx: {
                  height: 56,
                  borderRadius: "28px",
                  px: 2,
                  bgcolor: "background.default",
                  "&:hover, &.Mui-focused": { bgcolor: "background.default" },
                  "& .MuiFilledInput-input": { p: 0, height: 24, lineHeight: "24px" },
                  "& .MuiInputAdornment-root": { mt: 0 },
                },
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded />
                  </InputAdornment>
                ),
                endAdornment: searchInput ? (
                  <InputAdornment position="end">
                    <IconButton aria-label="Clear search" onClick={() => setSearchInput("")}>
                      <CloseRounded />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
          <TextField
            className="workspace-stage"
            variant="outlined"
            select
            label="Latest job progress"
            value={stage ?? "all"}
            onChange={(event) => {
              setStage(event.target.value === "all" ? undefined : event.target.value);
              setPage(1);
            }}
          >
            <MenuItem value="all">All progress</MenuItem>
            {Object.entries(stageLabels).map(([value, label]) => (
              <MenuItem key={value} value={value}>
                {value === "reviewing" && kind === "issue" ? "Triaging" : label}
              </MenuItem>
            ))}
          </TextField>
          {searchInput || stage ? <Button onClick={clearFilters}>Clear filters</Button> : null}
        </search>
        <Typography
          className="workspace-count"
          id={`workspace-${kind}-count`}
          component="p"
          variant="body2"
          color="text.secondary"
          role="status"
          aria-live="polite"
        >
          {currentError
            ? "Count unavailable"
            : isUpdating
              ? `Loading ${content.title.toLowerCase()}…`
              : `${total} ${total === 1 ? content.item : content.title.toLowerCase()}${search || stage ? " matched" : ""}`}
        </Typography>
        {currentError ? (
          <Alert
            severity="error"
            sx={{ m: 2 }}
            action={<Button onClick={loadItems}>Try again</Button>}
          >
            <AlertTitle>Could not load {content.title.toLowerCase()}</AlertTitle>
            {currentError}
          </Alert>
        ) : isUpdating ? (
          <div role="status" aria-label={`Loading ${content.title.toLowerCase()}`}>
            {[0, 1, 2, 3, 4].map((row) => (
              <div className="workspace-skeleton" key={row} aria-hidden="true">
                <Skeleton variant="circular" width={40} height={40} />
                <Stack spacing={0.5} sx={{ flex: 1 }}>
                  <Skeleton width="70%" height={24} />
                  <Skeleton width="50%" height={20} />
                </Stack>
                <Skeleton
                  variant="rounded"
                  width={120}
                  height={32}
                  sx={{ display: { xs: "none", sm: "block" } }}
                />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={search || stage ? "No matching results" : content.empty}
            description={
              search || stage
                ? "Try another search or clear the progress filter."
                : content.emptyDescription
            }
            icon={<InboxOutlined />}
            action={
              search || stage ? <Button onClick={clearFilters}>Clear filters</Button> : undefined
            }
          />
        ) : (
          <List
            disablePadding
            aria-label={content.inbox}
            aria-describedby={`workspace-${kind}-count`}
          >
            {items.map((item) => (
              <WorkItemListRow
                key={itemKey(item)}
                item={item}
                disabled={isUpdating || listAccess.checking}
                onOpenDetails={openDetails}
                onViewRuns={viewRuns}
              />
            ))}
          </List>
        )}
        {!currentError && !isUpdating && total > 0 ? (
          <footer className="workspace-footer">
            <TablePagination
              component="div"
              count={total}
              page={page - 1}
              rowsPerPage={pageSize}
              rowsPerPageOptions={[20, 50, 100]}
              onPageChange={(_, nextPage) => setPage(nextPage + 1)}
              onRowsPerPageChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              labelRowsPerPage="Items per page"
              labelDisplayedRows={({ from, to, count }) =>
                `${from}–${to} of ${count}${search || stage ? " matching" : ""}`
              }
              showFirstButton
              showLastButton
              disabled={isUpdating}
            />
          </footer>
        ) : null}
      </Paper>
      <p className="workspace-guidance">
        <GitHub fontSize="small" />
        {kind === "pull_request"
          ? "Reviews begin with an authorized review request or assignment on GitHub."
          : "Triage begins when an authorized maintainer assigns an issue on GitHub."}
      </p>
      <WorkItemDetails
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
        onViewRuns={viewRuns}
        onRunValidation={runValidation}
      />
      <ReviewRunsDrawer
        workItem={runView?.item ?? null}
        initialRunId={runView?.runId}
        onClose={() => setRunView(null)}
        onCreateRun={() => {
          if (!runView || runView.item.repositoryId !== actionRepositoryId || !access.can("review"))
            return;
          setCreatingRunItem(runView.item);
          setRunView(null);
        }}
      />
      <CreateReviewRunModal
        workItem={creatingRunItem}
        onClose={() => setCreatingRunItem(null)}
        onCreated={(run) => {
          if (
            !creatingRunItem ||
            run.repositoryId !== creatingRunItem.repositoryId ||
            run.workItemId !== creatingRunItem.id
          )
            return;
          setRunView({ item: creatingRunItem, runId: run.id });
          setCreatingRunItem(null);
          loadItems();
        }}
      />
    </section>
  );
}
