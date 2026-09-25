import type {
  InvestigationReportHeaderV1,
  InvestigationTaskV1,
  InvestigationWorkItemDiscussion,
} from "@agentic-review/contracts";
import ChatBubbleOutlineRounded from "@mui/icons-material/ChatBubbleOutlineRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import {
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
import { type ActionPanelRequest, isActionAllowed, reportNavigation } from "./action-panel";
import { investigationApi, type WorkItem } from "./api";
import { CommentStatus, commentDetailsUrl, commentPollingInterval } from "./comment-deliveries";
import { GithubSourceLink } from "./github-source-link";
import { useGuardedAction } from "./navigation-guard";
import { OutcomeSummary } from "./outcome-summary";
import { StandaloneActions } from "./report-workspace";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { ReviewQueueBar } from "./review-navigation";
import { sessionIdentity, useInvestigationSession } from "./session";
import {
  activeSourceReportTask,
  readableSourceData,
  readableSourceReport,
  sourceAccessDenied,
  sourceActionLabel,
  sourceActionReason,
  sourceReportAction,
  useSourceActionContext,
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
      sx={{ py: 1.5, borderBottom: 1, borderColor: "divider", justifyContent: "space-between" }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography
          component={Link}
          to={taskUrl(task)}
          sx={{
            fontSize: 14,
            fontWeight: 500,
            color: "text.primary",
            textDecoration: "none",
            "&:hover": { color: "primary.main", textDecoration: "underline" },
          }}
        >
          {taskNames[task.kind]}
        </Typography>
        <Typography
          variant="caption"
          component="p"
          color="text.secondary"
          sx={{ mt: 0.75, mb: 0, overflowWrap: "anywhere" }}
        >
          {task.executionPolicy.mode === "snapshot_only"
            ? "Snapshot only"
            : task.executionPolicy.mode === "source_read"
              ? "Source review"
              : "Execution"}{" "}
          · {currentSource ? "Current revision" : "Earlier or linked revision"}
        </Typography>
        <Box
          component="details"
          sx={{
            mt: 0.5,
            overflowWrap: "anywhere",
            "& summary": {
              cursor: "pointer",
              typography: "caption",
              color: "text.secondary",
              minHeight: 44,
              py: 1,
            },
          }}
        >
          <summary>Task ID</summary>
          <Typography component="code" variant="caption">
            {task.id}
          </Typography>
        </Box>
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
            Read report
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
        Discussion is unavailable. The description is available in Overview.
      </Alert>
    );
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Authors and timestamps were not recorded.
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
    <DetailSection title="Workspace updates">
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
        <Typography color="text.secondary">No updates yet.</Typography>
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
            </Typography>
            <Box>
              <Button
                size="small"
                component={Link}
                to={commentDetailsUrl(entry.id, item.repositoryId)}
              >
                View delivery
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
  const { query: context, context: currentContext } = useSourceActionContext(source, header);
  const reportUrl = `/reports?${new URLSearchParams({ reportId: header.report.id, repositoryId: source.repositoryId })}`;
  const action = currentContext?.recommendation.action;
  const saved = currentContext?.nextActions.find(
    (value) => value.id === currentContext?.recommendedActionId,
  );
  const reportAction = currentContext ? sourceReportAction(currentContext) : undefined;
  const allowed = Boolean(
    fresh &&
      !context.isError &&
      currentContext &&
      action &&
      (reportAction?.allowed ?? isActionAllowed(currentContext, action, saved?.id)),
  );
  return (
    <OutcomeSummary
      header={header}
      actions={
        <Stack spacing={1}>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: "wrap", alignItems: "center" }}
          >
            {activeTask && !currentContext?.pendingSubmission ? (
              <Button component={Link} to={taskUrl(activeTask)} variant="contained">
                View follow-up
              </Button>
            ) : reportAction && !currentContext?.pendingSubmission ? (
              <Button
                component={Link}
                to={reportNavigation(
                  reportAction.action,
                  reportAction.reportId,
                  source.repositoryId,
                )}
                variant="contained"
                disabled={!allowed}
              >
                {sourceActionLabel(reportAction.action)}
              </Button>
            ) : (
              <>
                {(action || currentContext?.pendingSubmission) && (
                  <Button
                    variant="contained"
                    disabled={currentContext?.pendingSubmission ? context.isError : !allowed}
                    aria-haspopup="dialog"
                    onClick={() =>
                      openActions(
                        currentContext?.pendingSubmission || !action
                          ? undefined
                          : { action, nextActionId: saved?.id },
                      )
                    }
                  >
                    {currentContext?.pendingSubmission
                      ? "Check submission"
                      : action
                        ? sourceActionLabel(action, saved?.taskKind)
                        : "Choose action"}
                  </Button>
                )}
              </>
            )}
            <Button component={Link} to={reportUrl}>
              Read report
            </Button>
            <Button disabled={!fresh} onClick={() => openActions()} aria-haspopup="dialog">
              Other actions
            </Button>
          </Stack>
          {currentContext &&
            action &&
            !allowed &&
            !currentContext.pendingSubmission &&
            !activeTask &&
            fresh &&
            !context.isError && (
              <Typography variant="caption" color="text.secondary">
                {sourceActionReason(currentContext, action)}
              </Typography>
            )}
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
              Action context changed. Refresh to continue.
            </Alert>
          )}
          {!fresh && (
            <Typography variant="caption" color="text.secondary">
              Refresh the source and task status to enable actions.
            </Typography>
          )}
          {context.isPending && (
            <Typography variant="body2" role="status">
              Loading actions…
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
  const fresh = item.isSuccess && tasks.isSuccess;
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
        title={source.title}
        subtitle={`${source.kind === "pull_request" ? "PR" : "Issue"} #${source.number} · ${source.state} · ${repository?.fullName ?? source.repositoryId}`}
        action={
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {repository && (
              <GithubSourceLink
                repositoryFullName={repository.fullName}
                kind={source.kind}
                number={source.number}
              />
            )}
          </Stack>
        }
      />
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
          {currentReport.isError && (
            <Alert
              severity="warning"
              action={
                <Button
                  disabled={currentReport.isFetching}
                  onClick={() => void currentReport.refetch()}
                >
                  Retry report
                </Button>
              }
            >
              Report refresh failed. Showing the saved result.
            </Alert>
          )}
          {latestSavedTask && !taskUsesCurrentSource(source, latestSavedTask) && (
            <Alert severity="warning">
              This report covers an earlier saved source. Recheck the current revision.
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
          Investigation access is unavailable. Cached tasks and saved conclusions are hidden.
        </Alert>
      ) : currentReport.isError ? (
        <Alert
          severity="warning"
          action={<Button onClick={() => void currentReport.refetch()}>Retry report</Button>}
        >
          {currentReport.error.message}
        </Alert>
      ) : (
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
        >
          <Typography component="h2" variant="h6">
            {latestSavedTask?.latestReportRef ? "Loading conclusion…" : "No saved conclusion"}
          </Typography>
          <Button onClick={() => openActions()} disabled={!fresh}>
            Other actions
          </Button>
        </Stack>
      )}
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
              gridTemplateColumns: {
                xs: "minmax(0, 1fr)",
                md: "minmax(0, 1.7fr) minmax(240px, 1fr)",
              },
              gap: 3,
              alignItems: "start",
            }}
          >
            <Surface sx={{ p: { xs: 2, sm: 3 }, border: 1, borderColor: "divider" }}>
              <DetailSection
                title={
                  source.kind === "pull_request"
                    ? "About this change"
                    : header?.assessment.kind === "feature"
                      ? "Feature request"
                      : "Reported behavior"
                }
              >
                <Typography
                  sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}
                >
                  {source.body || "No description."}
                </Typography>
              </DetailSection>
              <Box
                component="details"
                sx={{
                  mt: 3,
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1.5,
                  "& summary": {
                    cursor: "pointer",
                    minHeight: 44,
                    typography: "body2",
                    color: "text.secondary",
                  },
                }}
              >
                <summary>Source snapshot</summary>
                <Stack spacing={1.5} sx={{ pt: 1 }}>
                  <Typography variant="body2" color="text.secondary">
                    Updated {new Date(source.updatedAt).toLocaleString()}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {snapshot.isPending
                      ? "Loading discussion…"
                      : snapshot.isError
                        ? "Discussion unavailable"
                        : snapshotData?.availability === "available"
                          ? `${snapshotData.inputSnapshot?.comments.length ?? 0} imported comments`
                          : "Discussion not retained"}
                  </Typography>
                  <Typography component="code" sx={{ fontSize: 12, overflowWrap: "anywhere" }}>
                    {source.subject.kind === "original_pr"
                      ? source.subject.headSha
                      : source.subject.revisionKey}
                  </Typography>
                  <Box>
                    <Button onClick={() => setSourceOpen(true)}>Inspect snapshot</Button>
                  </Box>
                </Stack>
              </Box>
            </Surface>
            <Surface
              component="aside"
              aria-label="Related work"
              sx={{ p: { xs: 2, sm: 3 }, border: 1, borderColor: "divider" }}
            >
              <DetailSection
                title="Related work"
                action={
                  related.length > 1 ? (
                    <Button onClick={() => changeTab("investigations")}>
                      View all ({related.length})
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
                  <SourceTaskRow task={current} item={source} />
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No investigation for this revision.
                  </Typography>
                )}
                <Box sx={{ mt: 2 }}>
                  <StartInvestigationButton
                    workItem={source}
                    variant="outlined"
                    disabled={!fresh}
                  />
                </Box>
                {!canCreate && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 1 }}
                  >
                    Create tasks permission and repository access required.
                  </Typography>
                )}
              </DetailSection>
            </Surface>
          </Box>
        )}
        {tab === "investigations" && (
          <DetailSection title="Investigations and linked work">
            {tasks.isPending ? (
              <CircularProgress size={24} aria-label="Loading investigations" />
            ) : tasks.isError ? (
              <Alert
                severity="error"
                action={<Button onClick={() => void tasks.refetch()}>Retry</Button>}
              >
                {tasks.error.message}
              </Alert>
            ) : related.length ? (
              related.map((task) => <SourceTaskRow key={task.id} task={task} item={source} />)
            ) : (
              <EmptyState title="No investigations yet" icon={<SearchRounded />} />
            )}
          </DetailSection>
        )}
        {tab === "discussion" && (
          <Stack spacing={4} sx={{ maxWidth: 900 }}>
            <DetailSection title="Discussion">
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
            {sourceAccessDenied(snapshot.error) && (
              <Typography variant="body2" color="text.secondary">
                Saved snapshot access is unavailable. Showing the registered description.
              </Typography>
            )}
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
