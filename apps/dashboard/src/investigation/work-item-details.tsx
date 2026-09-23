import type {
  InvestigationReportHeaderV1,
  InvestigationTaskV1,
  InvestigationWorkItemDiscussion,
} from "@agentic-review/contracts";
import ChatBubbleOutlineRounded from "@mui/icons-material/ChatBubbleOutlineRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import HistoryRounded from "@mui/icons-material/HistoryRounded";
import OpenInNewRounded from "@mui/icons-material/OpenInNewRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type ActionPanelRequest, actionLabels, isActionAllowed } from "./action-panel";
import { investigationApi, type WorkItem } from "./api";
import { CommentStatus, commentDetailsUrl, commentPollingInterval } from "./comment-deliveries";
import { GithubSourceLink } from "./github-source-link";
import { useGuardedAction } from "./navigation-guard";
import { OutcomeSummary } from "./outcome-summary";
import { assertActionContext } from "./report-state";
import { StandaloneActions } from "./report-workspace";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { ReviewQueueBar } from "./review-navigation";
import { sessionIdentity, useInvestigationSession } from "./session";
import {
  activeSourceReportTask,
  readableSourceData,
  readableSourceReport,
  sourceAccessDenied,
  sourceActionContextMatches,
  sourceActionKey,
  useSourceReport,
} from "./source-result";
import { StartInvestigationButton } from "./start-investigation";
import {
  assertSourceSnapshot,
  currentWorkItemTask,
  investigationStateLabel,
  relatedWorkItemTasks,
  taskUrl,
  taskUsesCurrentSource,
  workItemUrl,
} from "./work-item-state";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";

const taskNames: Record<InvestigationTaskV1["kind"], string> = {
  "pr-review": "Pull request review",
  "issue-investigate": "Issue investigation",
  "pr-e2e": "E2E verification",
  "pr-verify": "Pull request verification",
  "issue-verify": "Issue verification",
  "reproduction-setup": "Reproduction setup",
  "issue-fix": "Issue fix",
  "feature-implement": "Feature implementation",
};

function DetailSection({
  title,
  children,
  action,
  description,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  description?: string;
}) {
  return (
    <Box component="section">
      <Stack
        direction="row"
        spacing={2}
        sx={{ mb: 2, justifyContent: "space-between", alignItems: "center" }}
      >
        <Box>
          <Typography component="h2" variant="h6">
            {title}
          </Typography>
          {description && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {description}
            </Typography>
          )}
        </Box>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

export function SourceTaskRow({ task, item }: { task: InvestigationTaskV1; item: WorkItem }) {
  const currentSource = taskUsesCurrentSource(item, task);
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={1.5}
      sx={{ py: 2, borderBottom: 1, borderColor: "divider", justifyContent: "space-between" }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography
          component={Link}
          to={taskUrl(task)}
          sx={{
            fontSize: 16,
            fontWeight: 500,
            color: "text.primary",
            textDecoration: "none",
            "&:hover": { color: "primary.main", textDecoration: "underline" },
          }}
        >
          {taskNames[task.kind]}
        </Typography>
        <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.75, mb: 0 }}>
          {new Date(task.createdAt).toLocaleString()} ·{" "}
          {task.executionPolicy.mode === "snapshot_only"
            ? "Snapshot only"
            : task.executionPolicy.mode === "source_read"
              ? "Exact source"
              : "Execution"}{" "}
          · {currentSource ? "Current source revision" : "Earlier or linked source revision"}
        </Typography>
      </Box>
      <Stack
        direction={{ xs: "row", sm: "column" }}
        spacing={1}
        sx={{ alignItems: { xs: "center", sm: "flex-end" }, justifyContent: "space-between" }}
      >
        <Chip
          size="small"
          label={investigationStateLabel(task)}
          color={
            task.state === "running"
              ? "info"
              : task.state === "completed"
                ? "success"
                : task.state === "failed" || task.state === "blocked"
                  ? "warning"
                  : "default"
          }
        />
        {task.latestReportRef && (
          <Button
            size="small"
            component={Link}
            to={`/reports?${new URLSearchParams({ repositoryId: item.repositoryId, reportId: task.latestReportRef.id })}`}
          >
            View saved report
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

function FrozenDiscussion({
  item,
  snapshot,
}: {
  item: WorkItem;
  snapshot: InvestigationWorkItemDiscussion | undefined;
}) {
  const input = snapshot?.inputSnapshot;
  if (!input)
    return (
      <Alert severity="info">
        The frozen discussion is unavailable for this source revision. The registered description
        remains available in Overview.
      </Alert>
    );
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        These posts belong to the saved source snapshot. Author names and post times were not
        recorded.
      </Typography>
      {[
        { id: "opening-post", body: input.body, opening: true, provenance: undefined },
        ...input.comments.map((comment) => ({ ...comment, opening: false })),
      ].map((comment) => (
        <Box
          component="article"
          key={comment.id}
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "28px minmax(0, 1fr)", sm: "36px minmax(0, 1fr)" },
            gap: 2,
            py: 3,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Avatar
            aria-hidden="true"
            sx={{
              width: { xs: 28, sm: 36 },
              height: { xs: 28, sm: 36 },
              bgcolor: "action.selected",
              color: "text.secondary",
            }}
          >
            <ChatBubbleOutlineRounded sx={{ fontSize: 18 }} />
          </Avatar>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {comment.opening
                ? "Opening post"
                : comment.provenance
                  ? "Recorded workspace progress"
                  : "Imported comment"}
              <Typography
                component="span"
                variant="caption"
                color="text.secondary"
                sx={{ ml: 1.5 }}
              >
                Source snapshot
              </Typography>
            </Typography>
            <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}>
              {comment.body || "This post has no text."}
            </Typography>
            {comment.provenance && (
              <Button
                size="small"
                component={Link}
                to={commentDetailsUrl(comment.provenance.publicationId, item.repositoryId)}
              >
                View publication record
              </Button>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function WorkspaceUpdates({ item, tasks }: { item: WorkItem; tasks: InvestigationTaskV1[] }) {
  const query = useInfiniteQuery({
    queryKey: ["investigation-publications", "work-item", item.repositoryId, item.id],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const page = await investigationApi.publications(
        { repositoryId: item.repositoryId, workItemId: item.id, limit: 25, cursor: pageParam },
        signal,
      );
      if (
        page.items.some(
          (entry) =>
            entry.repositoryId !== item.repositoryId ||
            entry.workItemId !== item.id ||
            entry.workItemKind !== item.kind ||
            entry.workItemNumber !== item.number,
        )
      )
        throw new Error("The publication history does not match this source.");
      return page;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (current) =>
      commentPollingInterval(current.state.data?.pages.flatMap((page) => page.items) ?? []),
    refetchIntervalInBackground: false,
  });
  const entries = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <DetailSection
      title="Workspace updates"
      description="Delivery records are separate from the frozen source discussion."
    >
      {query.isPending ? (
        <CircularProgress size={24} aria-label="Loading workspace updates" />
      ) : query.isError ? (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        >
          {query.error.message}
        </Alert>
      ) : entries.length === 0 ? (
        <Typography color="text.secondary">
          Updates appear here when an investigation prepares progress or results.
        </Typography>
      ) : (
        entries.map((entry) => (
          <Stack
            component="article"
            key={entry.id}
            spacing={1.5}
            sx={{ py: 2.5, borderBottom: 1, borderColor: "divider" }}
          >
            <Stack
              direction="row"
              useFlexGap
              spacing={1.5}
              sx={{ flexWrap: "wrap", alignItems: "center" }}
            >
              <Typography variant="subtitle2">
                {tasks.find((task) => task.id === entry.taskId)?.kind === "pr-e2e"
                  ? "E2E verification"
                  : entry.mode === "progress"
                    ? "Investigation progress"
                    : "Investigation result"}
              </Typography>
              <CommentStatus comment={entry} />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {entry.state === "synced"
                ? `Delivery confirmed${entry.lastConfirmedAt ? ` ${new Date(entry.lastConfirmedAt).toLocaleString()}` : ""}.`
                : "The current update has not been confirmed as delivered."}{" "}
              Open its delivery record to read the recorded content and attempt history.
            </Typography>
            <Box>
              <Button
                size="small"
                component={Link}
                to={commentDetailsUrl(entry.id, item.repositoryId)}
              >
                View delivery details
              </Button>
            </Box>
          </Stack>
        ))
      )}
      {query.hasNextPage && (
        <Button
          sx={{ mt: 2 }}
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more updates"}
        </Button>
      )}
    </DetailSection>
  );
}

function SourceDecision({
  source,
  header,
  activeTask,
  fresh,
  openActions,
  refreshSource,
}: {
  source: WorkItem;
  header: InvestigationReportHeaderV1;
  activeTask?: InvestigationTaskV1;
  fresh: boolean;
  openActions: (request?: Omit<ActionPanelRequest, "id">) => void;
  refreshSource: () => void;
}) {
  const { session } = useInvestigationSession();
  const context = useQuery({
    queryKey: sourceActionKey(sessionIdentity(session), source, header),
    queryFn: async () => {
      const result = await investigationApi.actionContext(source.id, header.report.id);
      assertActionContext(header, result);
      if (!sourceActionContextMatches(source, header, result, session.user?.id))
        throw new Error("Action availability changed. Refresh the source before preparing.");
      return result;
    },
  });
  const currentContext =
    context.data &&
    !sourceAccessDenied(context.error) &&
    sourceActionContextMatches(source, header, context.data, session.user?.id)
      ? context.data
      : undefined;
  const reportUrl = `/reports?${new URLSearchParams({ reportId: header.report.id, repositoryId: source.repositoryId })}`;
  const action = currentContext?.recommendation.action;
  const saved = currentContext?.nextActions.find(
    (value) => value.id === currentContext?.recommendedActionId,
  );
  const allowed = Boolean(
    fresh &&
      !context.isError &&
      currentContext &&
      action &&
      isActionAllowed(currentContext, action, saved?.id),
  );
  return (
    <OutcomeSummary
      header={header}
      actions={
        <Stack spacing={1.5}>
          {activeTask ? (
            <>
              <Typography variant="body2">
                A linked task is {activeTask.state}. Its execution and validation remain separate
                from this saved report.
              </Typography>
              <Button component={Link} to={taskUrl(activeTask)} variant="contained">
                Open linked task
              </Button>
            </>
          ) : (
            <>
              {currentContext && (
                <Typography variant="body2">{currentContext.recommendation.reason}</Typography>
              )}
              {(action || currentContext?.pendingSubmission) && (
                <Button
                  variant="contained"
                  disabled={currentContext?.pendingSubmission ? context.isError : !allowed}
                  onClick={() =>
                    openActions(
                      currentContext?.pendingSubmission || !action
                        ? undefined
                        : { action, nextActionId: saved?.id },
                    )
                  }
                >
                  {currentContext?.pendingSubmission
                    ? "Inspect pending submission"
                    : (saved?.label ?? (action ? actionLabels[action] : "Choose an action"))}
                </Button>
              )}
            </>
          )}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button component={Link} to={reportUrl}>
              Read saved report
            </Button>
            <Button disabled={!fresh} onClick={() => openActions()}>
              Other actions
            </Button>
          </Stack>
          {context.isError && (
            <Alert
              severity="warning"
              action={
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                  <Button onClick={refreshSource}>Refresh source</Button>
                  <Button onClick={() => void context.refetch()}>Retry actions</Button>
                </Stack>
              }
            >
              {context.error.message}
            </Alert>
          )}
          {context.data && !currentContext && !context.isError && (
            <Alert
              severity="warning"
              action={<Button onClick={() => void context.refetch()}>Refresh actions</Button>}
            >
              The cached action context does not match this source revision or account. Reload
              current action availability.
            </Alert>
          )}
          {!fresh && (
            <Typography variant="caption" color="text.secondary">
              Saved data remains readable. Refresh the source and task status before preparing an
              action.
            </Typography>
          )}
          {context.isPending && (
            <Typography variant="body2" role="status">
              Loading current next actions…
            </Typography>
          )}
        </Stack>
      }
    />
  );
}

export function WorkItemDetails({ id }: { id: string }) {
  const sourceActionsId = useId();
  const scope = useInvestigationRepositoryScope();
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const location = useLocation();
  const navigate = useNavigate();
  const [sourceOpen, setSourceOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionRequest, setActionRequest] = useState<ActionPanelRequest>();
  const actionSerial = useRef(0);
  const guardScope = `source-actions:${id}`;
  const guardActions = useGuardedAction(guardScope);
  const requestedTab = new URLSearchParams(location.search).get("tab");
  const tab =
    requestedTab === "investigations" || requestedTab === "discussion" ? requestedTab : "overview";
  const item = useQuery({
    queryKey: ["investigation-work-item", identity, id, scope.repositoryId],
    queryFn: async () => {
      const result = await investigationApi.workItem(id);
      if (result.id !== id || (scope.repositoryId && result.repositoryId !== scope.repositoryId))
        throw new Error("The returned source does not match this address and repository.");
      return result;
    },
  });
  const itemData = readableSourceData(item.data, item.error);
  const tasks = useQuery({
    queryKey: ["investigation-tasks", identity, id],
    queryFn: () => investigationApi.tasks(id),
    refetchInterval: (current) =>
      !sourceAccessDenied(current.state.error) &&
      current.state.data?.items.some((task) => task.state === "queued" || task.state === "running")
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
  });
  const snapshot = useQuery({
    queryKey: ["investigation-work-item-snapshot", identity, id, itemData?.subject.revisionKey],
    queryFn: async ({ signal }) => {
      if (!itemData) throw new Error("Load this source before reading its snapshot.");
      const value = await investigationApi.workItemSnapshot(
        id,
        { revisionKey: itemData.subject.revisionKey },
        signal,
      );
      assertSourceSnapshot(itemData, value);
      return value;
    },
    enabled: !!itemData,
  });
  const taskData = readableSourceData(tasks.data, tasks.error);
  const snapshotData = readableSourceData(snapshot.data, snapshot.error);
  const related = itemData ? relatedWorkItemTasks(itemData, taskData?.items ?? []) : [];
  const current = itemData ? currentWorkItemTask(itemData, related) : undefined;
  const latestSavedTask = current?.latestReportRef
    ? current
    : related.find((task) => !!task.latestReportRef);
  const currentReport = useSourceReport(itemData, latestSavedTask);
  if (item.isPending) return <CircularProgress size={28} aria-label="Loading source" />;
  if (item.isError && (!item.data || sourceAccessDenied(item.error)))
    return (
      <Stack spacing={3}>
        <PageHeading
          title="Source unavailable"
          subtitle="This source could not be loaded with your current workspace access."
        />
        <Alert severity="error" action={<Button onClick={() => void item.refetch()}>Retry</Button>}>
          {item.error.message}
        </Alert>
        <Button component={Link} to={location.pathname}>
          Back to sources
        </Button>
      </Stack>
    );
  const source = itemData;
  if (!source)
    return <EmptyState title="Source unavailable" description="Refresh to load this source." />;
  const fresh = !item.isError && !tasks.isError;
  const header = readableSourceReport(
    source,
    latestSavedTask,
    currentReport.data,
    currentReport.error,
  );
  const openActions = (request: Omit<ActionPanelRequest, "id"> = {}) => {
    setActionRequest({ id: `source-${++actionSerial.current}`, ...request });
    setActionsOpen(true);
  };
  const activeLinkedTask = activeSourceReportTask(source, header, related);

  const repository = scope.query.data?.items.find((entry) => entry.id === source.repositoryId);
  const canCreate =
    !!session.user?.permissions.includes("task:create") &&
    !!session.user.repositoryIds.includes(source.repositoryId);
  const sourceUrl =
    repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.fullName)
      ? `https://github.com/${repository.fullName}/${source.kind === "pull_request" ? "pull" : "issues"}/${source.number}`
      : undefined;
  const changeTab = (value: string) => {
    const parameters = new URLSearchParams(location.search);
    if (value === "overview") parameters.delete("tab");
    else parameters.set("tab", value);
    navigate({ pathname: location.pathname, search: parameters.toString() });
  };
  return (
    <Stack spacing={3}>
      <ReviewQueueBar
        record={{
          kind: "work-item",
          id: source.id,
          workItemId: source.id,
          repositoryId: source.repositoryId,
          href: workItemUrl(source),
          label: source.title,
        }}
        fallbackTo={`${source.kind === "pull_request" ? "/pull-requests" : "/issues"}?repositoryId=${encodeURIComponent(source.repositoryId)}`}
        fallbackLabel={source.kind === "pull_request" ? "Pull requests" : "Issues"}
      />
      <PageHeading
        eyebrow={`${source.kind === "pull_request" ? "Pull request" : "Issue"} #${source.number}`}
        title={source.title}
        subtitle={`${repository?.fullName ?? source.repositoryId} · Updated ${new Date(source.updatedAt).toLocaleString()}`}
        action={
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {repository && (
              <GithubSourceLink
                repositoryFullName={repository.fullName}
                kind={source.kind}
                number={source.number}
              />
            )}
            <StartInvestigationButton
              workItem={source}
              variant={header ? "outlined" : "contained"}
              disabled={!fresh}
            />
          </Stack>
        }
      >
        <Chip
          label={source.state.charAt(0).toUpperCase() + source.state.slice(1)}
          color={source.state === "open" ? "success" : "default"}
          size="small"
        />
      </PageHeading>
      {item.isError && (
        <Alert
          severity="warning"
          action={
            <Button
              onClick={() => {
                void item.refetch();
                void tasks.refetch();
              }}
            >
              Retry refresh
            </Button>
          }
        >
          Refresh failed. Showing the last saved source snapshot.
        </Alert>
      )}
      {header ? (
        <>
          {latestSavedTask && !taskUsesCurrentSource(source, latestSavedTask) && (
            <Alert severity="warning">
              This report describes an earlier saved source. Its findings have not been verified
              against the current revision.
            </Alert>
          )}
          <SourceDecision
            source={source}
            header={header}
            activeTask={activeLinkedTask}
            fresh={fresh && !currentReport.isError}
            openActions={openActions}
            refreshSource={() => {
              void item.refetch();
              void tasks.refetch();
            }}
          />
        </>
      ) : sourceAccessDenied(tasks.error) ? (
        <Alert
          severity="warning"
          action={<Button onClick={() => void tasks.refetch()}>Check investigation access</Button>}
        >
          Investigation access is unavailable. Cached tasks and their saved conclusions are hidden
          until access is confirmed.
        </Alert>
      ) : currentReport.isError ? (
        <Alert
          severity="warning"
          action={<Button onClick={() => void currentReport.refetch()}>Retry report</Button>}
        >
          {currentReport.error.message}
        </Alert>
      ) : (
        <Surface sx={{ p: { xs: 2, sm: 3 }, bgcolor: "var(--app-surface-container)" }}>
          <Typography component="h2" variant="h6">
            {latestSavedTask?.latestReportRef
              ? "Loading saved conclusion…"
              : "No saved conclusion yet"}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            Task progress is separate from a saved assessment and accepted validation.
          </Typography>
        </Surface>
      )}
      {!canCreate && (
        <Alert severity="info">
          Read-only access. Creating an investigation requires the Create tasks permission and
          access to this repository.
        </Alert>
      )}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "repeat(2, minmax(0, 1fr))",
            sm: "fit-content(320px) fit-content(180px) minmax(0, 1fr)",
          },
          columnGap: { xs: 2, sm: 3 },
          rowGap: 1.5,
          p: 2,
          bgcolor: "var(--app-surface-container)",
          borderRadius: "14px",
          "& .MuiButton-root": {
            display: "block",
            minWidth: 0,
            minHeight: 0,
            maxWidth: "100%",
            p: 0,
            mt: 0.25,
            borderRadius: "4px",
            fontSize: 13,
            lineHeight: "20px",
            textAlign: "left",
            whiteSpace: "normal",
            overflowWrap: "anywhere",
            "@media (pointer: coarse)": { minHeight: 48 },
          },
        }}
      >
        <Box sx={{ minWidth: 0, gridColumn: 1, gridRow: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Source
          </Typography>
          <Button size="small" onClick={() => setSourceOpen(true)}>
            {repository?.fullName ?? source.repositoryId} #{source.number}
          </Button>
        </Box>
        <Box sx={{ minWidth: 0, gridColumn: 2, gridRow: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Current investigation
          </Typography>
          {current ? (
            <Button size="small" component={Link} to={taskUrl(current)}>
              {investigationStateLabel(current)}
            </Button>
          ) : (
            <Typography variant="body2" sx={{ mt: 0.25, lineHeight: "20px" }}>
              {tasks.isPending ? "Loading…" : tasks.isError ? "Unavailable" : "Not started"}
            </Typography>
          )}
        </Box>
        <Box
          sx={{
            minWidth: 0,
            gridColumn: { xs: "1 / -1", sm: 3 },
            gridRow: { xs: 2, sm: 1 },
          }}
        >
          <Typography variant="caption" color="text.secondary">
            Saved result
          </Typography>
          {latestSavedTask?.latestReportRef ? (
            <Button
              size="small"
              component={Link}
              to={`/reports?${new URLSearchParams({ reportId: latestSavedTask.latestReportRef.id, repositoryId: source.repositoryId })}`}
            >
              {latestSavedTask.id === current?.id
                ? header?.report.delivery === "checkpoint"
                  ? "Checkpoint available"
                  : "View saved report"
                : "From an earlier or linked investigation"}
            </Button>
          ) : (
            <Typography variant="body2" sx={{ mt: 0.25, lineHeight: "20px" }}>
              {sourceAccessDenied(tasks.error)
                ? "Unavailable with current access"
                : "Not available yet"}
            </Typography>
          )}
        </Box>
      </Box>
      <Tabs
        value={tab}
        onChange={(_event, value: string) => changeTab(value)}
        aria-label="Source details"
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab
          id="source-tab-overview"
          aria-controls="source-panel-overview"
          value="overview"
          label="Overview"
        />
        <Tab
          id="source-tab-investigations"
          aria-controls="source-panel-investigations"
          value="investigations"
          label={`Investigations${related.length ? ` (${related.length})` : ""}`}
        />
        <Tab
          id="source-tab-discussion"
          aria-controls="source-panel-discussion"
          value="discussion"
          label="Discussion"
        />
      </Tabs>
      <Box role="tabpanel" id={`source-panel-${tab}`} aria-labelledby={`source-tab-${tab}`}>
        {tab === "overview" && (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 1fr) 280px" },
              gap: { xs: 3, lg: 4 },
              alignItems: "start",
            }}
          >
            <Stack spacing={4} sx={{ minWidth: 0 }}>
              <DetailSection
                title={source.kind === "pull_request" ? "About this change" : "Reported behavior"}
              >
                <Typography
                  sx={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    lineHeight: 1.7,
                    maxWidth: "72ch",
                  }}
                >
                  {source.body || "This source has no description."}
                </Typography>
                {source.kind === "issue" && (
                  <Alert severity="info" sx={{ mt: 3 }}>
                    This issue is a source snapshot. Choose an exact commit when investigating the
                    code behind it.
                  </Alert>
                )}
              </DetailSection>
              <DetailSection
                title="Current investigation"
                action={
                  related.length > 1 ? (
                    <Button onClick={() => changeTab("investigations")}>
                      View all {related.length}
                    </Button>
                  ) : undefined
                }
              >
                {tasks.isError ? (
                  <Alert
                    severity="error"
                    action={<Button onClick={() => void tasks.refetch()}>Retry</Button>}
                  >
                    {tasks.error.message}
                  </Alert>
                ) : tasks.isPending ? (
                  <CircularProgress size={24} aria-label="Loading investigations" />
                ) : current ? (
                  <>
                    <SourceTaskRow task={current} item={source} />
                    {currentReport.isError && (
                      <Alert severity="error" sx={{ mt: 2 }}>
                        {currentReport.error.message}
                      </Alert>
                    )}
                  </>
                ) : (
                  <Stack direction="row" spacing={2} sx={{ py: 2 }}>
                    <SearchRounded color="action" />
                    <Box>
                      <Typography variant="subtitle1">
                        No investigation for this source revision
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        Start an investigation to turn this source into findings and a clear next
                        step.
                        {related.length
                          ? " Earlier and linked work remains in Investigations."
                          : ""}
                      </Typography>
                    </Box>
                  </Stack>
                )}
              </DetailSection>
              <Accordion
                disableGutters
                elevation={0}
                sx={{
                  bgcolor: "transparent",
                  "&:before": { display: "none" },
                  borderTop: 1,
                  borderColor: "divider",
                }}
              >
                <AccordionSummary
                  id={`${sourceActionsId}-summary`}
                  aria-controls={`${sourceActionsId}-region`}
                  expandIcon={<ExpandMoreRounded />}
                >
                  <Typography variant="subtitle2">Available source actions</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Button onClick={() => openActions()} disabled={!fresh}>
                    Choose an action
                  </Button>
                </AccordionDetails>
              </Accordion>
            </Stack>
            <Surface
              component="aside"
              aria-label="Source snapshot"
              sx={{ p: 3, bgcolor: "action.hover" }}
            >
              <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: "center" }}>
                <HistoryRounded color="action" />
                <Typography component="h2" variant="subtitle1">
                  Source snapshot
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Investigations record their source so the evidence stays traceable.
              </Typography>
              <Box
                component="dl"
                sx={{
                  display: "grid",
                  gap: 2.5,
                  my: 3,
                  "& dt": { typography: "caption", color: "text.secondary", mb: 0.5 },
                  "& dd": { m: 0, typography: "body2", overflowWrap: "anywhere" },
                }}
              >
                <Box>
                  <Box component="dt">Repository</Box>
                  <Box component="dd">{repository?.fullName ?? source.repositoryId}</Box>
                </Box>
                <Box>
                  <Box component="dt">Source type</Box>
                  <Box component="dd">
                    {source.kind === "pull_request"
                      ? "Pull request and discussion"
                      : "Issue and discussion"}
                  </Box>
                </Box>
                <Box>
                  <Box component="dt">Saved discussion</Box>
                  <Box component="dd">
                    {snapshot.isPending
                      ? "Loading…"
                      : snapshot.isError
                        ? "Unavailable"
                        : snapshot.data.availability === "available"
                          ? `${snapshot.data.inputSnapshot?.comments.length ?? 0} imported comments`
                          : "Not retained for this revision"}
                  </Box>
                </Box>
              </Box>
              <Box
                component="details"
                sx={{
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1.5,
                  "& summary": {
                    cursor: "pointer",
                    typography: "body2",
                    color: "text.secondary",
                    minHeight: 40,
                  },
                }}
              >
                <summary>Revision details</summary>
                <Typography variant="caption" component="p" color="text.secondary">
                  {source.subject.kind === "original_pr" ? "Pinned commit" : "Snapshot revision"}
                </Typography>
                <Typography component="code" sx={{ fontSize: 12, overflowWrap: "anywhere" }}>
                  {source.subject.kind === "original_pr"
                    ? source.subject.headSha
                    : source.subject.revisionKey}
                </Typography>
              </Box>
              <Button sx={{ mt: 2 }} onClick={() => setSourceOpen(true)}>
                View source snapshot
              </Button>
              {sourceUrl && (
                <Button
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  endIcon={<OpenInNewRounded />}
                  size="small"
                >
                  Open on GitHub
                </Button>
              )}
            </Surface>
          </Box>
        )}
        {tab === "investigations" && (
          <DetailSection
            title="Investigations and linked work"
            description="Each investigation keeps its source, budget, and report together."
          >
            {tasks.isPending ? (
              <CircularProgress size={24} aria-label="Loading investigations" />
            ) : tasks.isError ? (
              <Alert severity="error">{tasks.error.message}</Alert>
            ) : related.length ? (
              related.map((task) => <SourceTaskRow key={task.id} task={task} item={source} />)
            ) : (
              <EmptyState
                title="No investigations yet"
                description="Create an investigation from this snapshot to collect findings and evidence."
                icon={<SearchRounded />}
              />
            )}
          </DetailSection>
        )}
        {tab === "discussion" && (
          <Stack spacing={4} sx={{ maxWidth: 900 }}>
            <DetailSection
              title="Discussion and updates"
              description="The saved opening post and imported discussion for this source revision."
            >
              {snapshot.isPending ? (
                <CircularProgress size={24} aria-label="Loading saved discussion" />
              ) : snapshot.isError ? (
                <Alert
                  severity="error"
                  action={<Button onClick={() => void snapshot.refetch()}>Retry</Button>}
                >
                  {snapshot.error.message}
                </Alert>
              ) : (
                <FrozenDiscussion item={source} snapshot={snapshotData} />
              )}
            </DetailSection>
            <WorkspaceUpdates item={source} tasks={related} />
          </Stack>
        )}
      </Box>
      <Dialog
        open={actionsOpen}
        onClose={() => {
          if (!actionBusy) guardActions(() => setActionsOpen(false));
        }}
        fullWidth
        maxWidth="md"
        aria-labelledby={`${sourceActionsId}-dialog-title`}
      >
        <DialogTitle id={`${sourceActionsId}-dialog-title`}>
          Actions for {source.kind === "pull_request" ? "PR" : "Issue"} #{source.number}
        </DialogTitle>
        <DialogContent>
          {actionsOpen && (
            <StandaloneActions
              workItem={source}
              reportId={header?.report.id}
              request={actionRequest}
              onBusyChange={setActionBusy}
              guardScope={guardScope}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={actionBusy} onClick={() => guardActions(() => setActionsOpen(false))}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        fullWidth
        maxWidth="sm"
        aria-labelledby="source-snapshot-title"
      >
        <DialogTitle id="source-snapshot-title">Recorded source snapshot</DialogTitle>
        <DialogContent>
          <Stack spacing={3}>
            <Typography variant="body2" color="text.secondary">
              {sourceAccessDenied(snapshot.error)
                ? "Saved snapshot access is unavailable. Only the registered source description is shown."
                : "A saved reference for investigations and reports."}
            </Typography>
            <Typography variant="h6">
              {snapshotData?.inputSnapshot?.title ?? source.title}
            </Typography>
            <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {snapshotData?.inputSnapshot?.body ?? source.body}
            </Typography>
            {snapshot.isError && <Alert severity="error">{snapshot.error.message}</Alert>}
            {snapshotData?.availability === "unavailable" && (
              <Alert severity="info">
                This legacy record has no retained input snapshot. The registered description is
                shown.
              </Alert>
            )}
            <Box sx={{ overflowWrap: "anywhere" }}>
              <Typography variant="caption" color="text.secondary">
                Registered revision
              </Typography>
              <Typography component="p" sx={{ fontFamily: "monospace", fontSize: 12 }}>
                {source.subject.revisionKey}
              </Typography>
              {snapshotData?.snapshotRef && (
                <>
                  <Typography variant="caption" color="text.secondary">
                    Snapshot digest
                  </Typography>
                  <Typography component="p" sx={{ fontFamily: "monospace", fontSize: 12 }}>
                    {snapshotData.snapshotRef.digest}
                  </Typography>
                </>
              )}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setSourceOpen(false);
              changeTab("discussion");
            }}
          >
            Read discussion
          </Button>
          <Button variant="contained" onClick={() => setSourceOpen(false)}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
