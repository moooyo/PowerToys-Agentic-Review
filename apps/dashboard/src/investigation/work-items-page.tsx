import type { InvestigationReportHeaderV1, InvestigationTaskV1 } from "@agentic-review/contracts";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import FilterListRounded from "@mui/icons-material/FilterListRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
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
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type ActionPanelRequest, isActionAllowed, reportNavigation } from "./action-panel";
import { investigationApi, type WorkItem } from "./api";
import { ImportWorkItemButton } from "./import-work-item";
import { useGuardedAction } from "./navigation-guard";
import { StandaloneActions } from "./report-workspace";
import { useInvestigationRepositoryScope } from "./repository-scope";
import {
  type ReviewLinkProps,
  type ReviewRecord,
  useReviewListNavigation,
} from "./review-navigation";
import { sessionIdentity, useInvestigationSession } from "./session";
import {
  activeSourceReportTask,
  readableSourceData,
  readableSourceReport,
  SourceResultLabel,
  sourceActionLabel,
  sourceActionReason,
  sourceReportAction,
  sourceTaskReviewRecord,
  useSourceActionContext,
  useSourceReport,
} from "./source-result";
import { StartInvestigationButton } from "./start-investigation";
import { WorkItemDetails } from "./work-item-details";
import {
  currentWorkItemTask,
  filterWorkItems,
  type InvestigationFilter,
  investigationFilters,
  investigationLabels,
  investigationStateLabel,
  relatedWorkItemTasks,
  taskUrl,
  workItemInvestigationState,
  workItemUrl,
} from "./work-item-state";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";
import "./work-items-page.css";

const validStates = ["all", "open", "closed", "merged"];
const statusColor = {
  all: "default",
  not_started: "default",
  running: "info",
  queued: "default",
  blocked: "warning",
  paused: "default",
  completed: "success",
} as const;

function SourceNextAction({
  item,
  current,
  savedTask,
  tasks,
  fresh,
  onAction,
  onCreate,
  relatedLink,
}: {
  item: WorkItem;
  current?: InvestigationTaskV1;
  savedTask?: InvestigationTaskV1;
  tasks: InvestigationTaskV1[];
  fresh: boolean;
  onCreate: (item: WorkItem) => void;
  relatedLink: (target: ReviewRecord) => ReviewLinkProps;
  onAction: (
    item: WorkItem,
    header: InvestigationReportHeaderV1 | undefined,
    request: Omit<ActionPanelRequest, "id">,
  ) => void;
}) {
  const { session } = useInvestigationSession();
  const report = useSourceReport(item, savedTask);
  const header = readableSourceReport(item, savedTask, report.data, report.error);
  const { query, context } = useSourceActionContext(item, header);
  const pending = context?.pendingSubmission;
  const linked = activeSourceReportTask(item, header, tasks);
  const active =
    linked ?? (current && ["queued", "running"].includes(current.state) ? current : undefined);
  const action = context?.recommendation.action;
  const savedAction = context?.nextActions.find((next) => next.id === context?.recommendedActionId);
  const reportAction = context ? sourceReportAction(context) : undefined;
  const allowed = Boolean(
    fresh &&
      !report.isError &&
      !query.isError &&
      context &&
      action &&
      (reportAction?.allowed ?? isActionAllowed(context, action, savedAction?.id)),
  );
  const openAction = () =>
    onAction(item, header, pending || !action ? {} : { action, nextActionId: savedAction?.id });
  const taskLink = (task: InvestigationTaskV1, href = taskUrl(task)) =>
    relatedLink({
      kind: "task",
      id: task.id,
      workItemId: task.workItem.id,
      repositoryId: task.repository.id,
      href,
    });
  const actionId = relatedLink({
    kind: "work-item",
    id: item.id,
    workItemId: item.id,
    repositoryId: item.repositoryId,
    href: workItemUrl(item),
  }).id;
  const canCreate = Boolean(
    session.user?.permissions.includes("task:create") &&
      session.user.repositoryIds.includes(item.repositoryId),
  );
  const subject = `${item.kind === "pull_request" ? "PR" : "Issue"} #${item.number}`;
  const reasonId = `${actionId}-reason`;
  return (
    <Box className="source-next-action">
      {pending ? (
        <Button
          id={actionId}
          variant="outlined"
          size="small"
          disabled={query.isError}
          onClick={openAction}
          aria-haspopup="dialog"
          aria-label={`Check submission for ${subject}`}
        >
          Check submission
        </Button>
      ) : active ? (
        <Button
          component={Link}
          {...taskLink(active)}
          variant="outlined"
          size="small"
          endIcon={<ChevronRightRounded />}
          aria-label={`View progress for ${subject}`}
        >
          View progress
        </Button>
      ) : savedTask?.latestReportRef && !header ? (
        <Button
          id={actionId}
          variant="outlined"
          size="small"
          disabled={!report.isError || report.isFetching}
          onClick={() => void report.refetch()}
          aria-label={`${report.isError ? "Retry result" : "Loading result"} for ${subject}`}
        >
          {report.isError ? "Retry result" : "Loading result…"}
        </Button>
      ) : header && !context ? (
        <Stack spacing={0.75}>
          <Button
            id={actionId}
            variant="outlined"
            size="small"
            disabled={query.isPending || query.isFetching}
            onClick={() => void query.refetch()}
            aria-describedby={query.isError ? reasonId : undefined}
            aria-label={`${query.isPending ? "Loading actions" : "Refresh actions"} for ${subject}`}
          >
            {query.isPending ? "Loading actions…" : "Refresh actions"}
          </Button>
          {query.isError && (
            <Typography id={reasonId} variant="caption" color="text.secondary">
              {query.error.message}
            </Typography>
          )}
        </Stack>
      ) : header && context && action ? (
        <Stack spacing={0.75} sx={{ alignItems: { xs: "flex-start", sm: "flex-end" } }}>
          {reportAction ? (
            <Button
              component={Link}
              {...relatedLink({
                kind: "report",
                id: reportAction.reportId,
                workItemId: item.id,
                repositoryId: item.repositoryId,
                href: reportNavigation(action, reportAction.reportId, item.repositoryId),
              })}
              variant="outlined"
              size="small"
              disabled={!allowed}
              endIcon={<ChevronRightRounded />}
              aria-label={`${sourceActionLabel(action)} for ${subject}`}
              aria-describedby={!allowed ? reasonId : undefined}
            >
              {sourceActionLabel(action)}
            </Button>
          ) : (
            <Button
              variant="outlined"
              size="small"
              id={actionId}
              disabled={!allowed}
              onClick={openAction}
              endIcon={<ChevronRightRounded />}
              aria-haspopup="dialog"
              aria-label={`${sourceActionLabel(action, savedAction?.taskKind)} for ${subject}`}
              aria-describedby={!allowed ? reasonId : undefined}
            >
              {sourceActionLabel(action, savedAction?.taskKind)}
            </Button>
          )}
          {!allowed && (
            <Typography id={reasonId} variant="caption" color="text.secondary">
              {!fresh || report.isError || query.isError
                ? "Refresh to check action availability."
                : sourceActionReason(context, action)}
            </Typography>
          )}
        </Stack>
      ) : current && ["blocked", "failed", "interrupted", "cancelled"].includes(current.state) ? (
        <Button
          component={Link}
          {...taskLink(
            current,
            current.state === "blocked" ? `${taskUrl(current)}&tab=details` : taskUrl(current),
          )}
          variant="outlined"
          size="small"
          endIcon={<ChevronRightRounded />}
        >
          {current.state === "blocked" ? "View prerequisites" : "View task"}
        </Button>
      ) : !current && !savedTask ? (
        <Stack spacing={0.75}>
          <Button
            id={actionId}
            variant="outlined"
            size="small"
            disabled={!fresh || !canCreate}
            onClick={() => onCreate(item)}
            aria-haspopup="dialog"
            aria-label={`${item.kind === "pull_request" ? "Start review" : "Investigate issue"} for ${subject}`}
            aria-describedby={!canCreate ? reasonId : undefined}
          >
            {item.kind === "pull_request" ? "Start review" : "Investigate issue"}
          </Button>
          {!canCreate && (
            <Typography id={reasonId} variant="caption" color="text.secondary">
              Create tasks permission required.
            </Typography>
          )}
        </Stack>
      ) : (
        <Button
          component={Link}
          {...relatedLink(
            header
              ? {
                  kind: "report",
                  id: header.report.id,
                  workItemId: item.id,
                  repositoryId: item.repositoryId,
                  href: `/reports?${new URLSearchParams({ reportId: header.report.id, repositoryId: item.repositoryId })}`,
                }
              : {
                  kind: "work-item",
                  id: item.id,
                  workItemId: item.id,
                  repositoryId: item.repositoryId,
                  href: workItemUrl(item),
                },
          )}
          variant="outlined"
          size="small"
          endIcon={<ChevronRightRounded />}
        >
          {header ? "Review report" : "View source"}
        </Button>
      )}
      {((report.isError && header) || (query.isError && context)) && (
        <Button
          size="small"
          disabled={report.isFetching || query.isFetching}
          onClick={() => {
            if (report.isError) void report.refetch();
            if (query.isError) void query.refetch();
          }}
        >
          Retry refresh
        </Button>
      )}
    </Box>
  );
}

export function WorkItemsPage({ kind }: { kind: WorkItem["kind"] }) {
  const queryClient = useQueryClient();
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const scope = useInvestigationRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  const parameters = new URLSearchParams(location.search);
  const selected = parameters.get("workItemId");
  const plural = kind === "pull_request" ? "Pull requests" : "Issues";
  const singular = kind === "pull_request" ? "pull request" : "issue";
  const search = parameters.get("q") ?? "";
  const state = validStates.includes(parameters.get("state") ?? "")
    ? parameters.get("state")!
    : "all";
  const investigation = investigationFilters.includes(
    parameters.get("investigation") as InvestigationFilter,
  )
    ? (parameters.get("investigation") as InvestigationFilter)
    : "all";
  const pageSize = [10, 20, 50].includes(Number(parameters.get("rows")))
    ? Number(parameters.get("rows"))
    : 10;
  const page = Math.max(1, Number(parameters.get("page")) || 1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState({ state, investigation });
  const [refreshed, setRefreshed] = useState(false);
  const [refreshingResults, setRefreshingResults] = useState(false);
  const [actionTarget, setActionTarget] = useState<{
    item: WorkItem;
    reportId?: string;
    request: ActionPanelRequest;
    openedAt: number;
    onRelatedNavigate?: (target: ReviewRecord) => boolean;
  }>();
  const [actionBusy, setActionBusy] = useState(false);
  const [createTarget, setCreateTarget] = useState<{
    item: WorkItem;
    onCompleted: (task: InvestigationTaskV1) => boolean;
  }>();
  const actionSerial = useRef(0);
  const actionOpener = useRef<string>(undefined);
  const actionTitleId = useId();
  const guardScope = `source-list-actions:${actionTarget?.item.id ?? "none"}`;
  const guardedAction = useGuardedAction(guardScope);
  const openAction = (
    item: WorkItem,
    header: InvestigationReportHeaderV1 | undefined,
    request: Omit<ActionPanelRequest, "id">,
  ) => {
    const record = queueRecords.find(
      (candidate) => candidate.id === item.id && candidate.repositoryId === item.repositoryId,
    );
    actionOpener.current = record ? queue.getRelatedLinkProps(record, record).id : undefined;
    setActionTarget({
      item,
      reportId: header?.report.id,
      request: { id: `source-list-${++actionSerial.current}`, ...request },
      openedAt: Date.now(),
      onRelatedNavigate: record ? queue.captureRelatedNavigation(record) : undefined,
    });
  };
  // Observe source updates accepted by the dialog's existing refresh guard.
  const actionSource = useQuery({
    queryKey: [
      "investigation-work-item",
      identity,
      actionTarget?.item.id,
      actionTarget?.item.repositoryId,
    ],
    queryFn: () => investigationApi.workItem(actionTarget!.item.id),
    initialData: actionTarget?.item,
    enabled: false,
  });
  const actionItem =
    actionTarget &&
    actionSource.data &&
    actionSource.dataUpdatedAt >= actionTarget.openedAt &&
    actionSource.data.id === actionTarget.item.id &&
    actionSource.data.repositoryId === actionTarget.item.repositoryId &&
    actionSource.data.kind === actionTarget.item.kind &&
    actionSource.data.number === actionTarget.item.number
      ? actionSource.data
      : actionTarget?.item;
  const query = useQuery({
    queryKey: ["investigation-work-items", scope.repositoryId, kind],
    queryFn: () => investigationApi.workItems(scope.repositoryId, kind),
    enabled: !selected,
  });
  const tasks = useQuery({
    queryKey: ["investigation-tasks", "source-list"],
    queryFn: () => investigationApi.tasks(),
    enabled: !selected,
    refetchInterval: (current) =>
      current.state.data?.items.some((task) => task.state === "queued" || task.state === "running")
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
  });
  const updateFilters = (values: Record<string, string | number>, replace = false) => {
    const next = new URLSearchParams(location.search);
    next.delete("page");
    for (const [key, value] of Object.entries(values)) {
      if (value === "" || value === "all" || (key === "page" && value === 1)) next.delete(key);
      else next.set(key, String(value));
    }
    navigate({ pathname: location.pathname, search: next.toString() }, { replace });
  };
  const refresh = async () => {
    setRefreshingResults(true);
    setRefreshed(false);
    try {
      const results = await Promise.all([query.refetch(), tasks.refetch()]);
      const visibleIds = new Set(visible.map((item) => item.id));
      await queryClient.refetchQueries(
        {
          predicate: (entry) =>
            entry.isActive() &&
            ((entry.queryKey[0] === "investigation-source-report" &&
              visibleIds.has(String(entry.queryKey[2]))) ||
              (entry.queryKey[0] === "investigation-source-actions" &&
                visibleIds.has(String(entry.queryKey[3])))),
        },
        { throwOnError: true },
      );
      setRefreshed(results.every((result) => !result.isError));
    } catch {
      setRefreshed(false);
    } finally {
      setRefreshingResults(false);
    }
  };
  const sourceOptions = validStates.filter(
    (value) => kind === "pull_request" || value !== "merged",
  );
  const activeFilters = !!search || state !== "all" || investigation !== "all";
  const activeFilterCount = Number(state !== "all") + Number(investigation !== "all");
  const taskItems = readableSourceData(tasks.data, tasks.error)?.items ?? [];
  const filtered = filterWorkItems(query.data?.items ?? [], taskItems, {
    search,
    state,
    investigation: tasks.isSuccess ? investigation : "all",
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(Math.floor(page), pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const queueRecords: ReviewRecord[] = filtered.map((item) => ({
    kind: "work-item",
    id: item.id,
    workItemId: item.id,
    repositoryId: item.repositoryId,
    href: workItemUrl(item),
    label: item.title,
  }));
  const queue = useReviewListNavigation({ label: plural, records: queueRecords, complete: true });
  const refreshing = query.isFetching || tasks.isFetching || refreshingResults;
  if (selected) return <WorkItemDetails key={selected} id={selected} />;
  return (
    <Stack spacing={3}>
      <PageHeading
        title={plural}
        action={<ImportWorkItemButton repository={scope.repository} initialKind={kind} />}
      />
      <Stack spacing={1.25}>
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: "center" }}
          role="search"
          aria-label={`${plural} search and filters`}
        >
          <TextField
            type="search"
            value={search}
            onChange={(event) => updateFilters({ q: event.target.value }, true)}
            placeholder={`Search ${plural.toLowerCase()}`}
            size="small"
            sx={{
              flex: { xs: 1, md: "0 1 520px" },
              minWidth: 0,
              "& .MuiOutlinedInput-root": { borderRadius: 1 },
            }}
            slotProps={{
              htmlInput: { "aria-label": `Search ${plural.toLowerCase()} by title or number` },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded />
                  </InputAdornment>
                ),
              },
            }}
          />
          <TextField
            select
            label="Source state"
            value={state}
            size="small"
            onChange={(event) => updateFilters({ state: event.target.value })}
            sx={{ width: 152, display: { xs: "none", md: "block" } }}
          >
            {sourceOptions.map((option) => (
              <MenuItem key={option} value={option}>
                {option === "all" ? "All sources" : option[0]!.toUpperCase() + option.slice(1)}
              </MenuItem>
            ))}
          </TextField>
          <Tooltip title="Refresh sources">
            <span>
              <IconButton
                aria-label="Refresh sources"
                disabled={refreshing}
                onClick={() => void refresh()}
                sx={{ display: { xs: "none", md: "inline-flex" } }}
              >
                <RefreshRounded />
              </IconButton>
            </span>
          </Tooltip>
          <Button
            variant="outlined"
            startIcon={<FilterListRounded />}
            onClick={() => {
              setFilterDraft({ state, investigation });
              setFiltersOpen(true);
            }}
            aria-haspopup="dialog"
            aria-label={`Filters${activeFilterCount ? `, ${activeFilterCount} active` : ""}`}
            sx={{ display: { xs: "inline-flex", md: "none" }, flexShrink: 0 }}
          >
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
          </Button>
        </Stack>
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{ flexWrap: "wrap", display: { xs: "none", md: "flex" } }}
          aria-label="Investigation status"
        >
          {investigationFilters.map((value) => (
            <Chip
              component="button"
              type="button"
              key={value}
              label={`${investigationLabels[value]} ${tasks.isSuccess ? filterWorkItems(query.data?.items ?? [], tasks.data.items, { search, state, investigation: value }).length : ""}`.trim()}
              onClick={() => updateFilters({ investigation: value })}
              aria-pressed={investigation === value}
              variant={investigation === value ? "filled" : "outlined"}
              color={investigation === value ? "primary" : "default"}
              sx={{ borderColor: "transparent", height: 34, cursor: "pointer" }}
            />
          ))}
        </Stack>
        <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between" }}>
          <Typography variant="caption" color="text.secondary" aria-live="polite">
            {refreshing && !query.isPending ? "Refreshing…" : refreshed ? "Updated just now" : ""}
          </Typography>
          {activeFilters && (
            <Button
              size="small"
              onClick={() => updateFilters({ q: "", state: "all", investigation: "all" })}
            >
              Clear filters
            </Button>
          )}
        </Stack>
      </Stack>
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        >
          {query.error.message}
        </Alert>
      )}
      {tasks.isError && (
        <Alert severity="warning">
          Investigation status is unavailable.{" "}
          <Button onClick={() => void tasks.refetch()}>Retry status</Button>
        </Alert>
      )}
      {query.isPending ? (
        <Box role="status" sx={{ py: 8, textAlign: "center" }}>
          <CircularProgress size={28} aria-label="Loading sources" />
        </Box>
      ) : (
        !query.isError &&
        (filtered.length ? (
          <Surface sx={{ overflow: "hidden" }}>
            <Stack
              direction="row"
              sx={{ px: { xs: 2, sm: 3 }, pt: 2, pb: 1, justifyContent: "space-between" }}
            >
              <Typography variant="caption" color="text.secondary">
                {filtered.length} {filtered.length === 1 ? singular : plural.toLowerCase()}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: { xs: "none", sm: "block" } }}
              >
                Action · Validation
              </Typography>
            </Stack>
            {visible.map((item) => {
              const current = currentWorkItemTask(item, taskItems);
              const reviewState = workItemInvestigationState(current);
              const savedTask = current?.latestReportRef
                ? current
                : relatedWorkItemTasks(item, taskItems).find((task) =>
                    Boolean(task.latestReportRef),
                  );
              const record = queueRecords.find((record) => record.id === item.id)!;
              return (
                <Box
                  component="article"
                  className="source-queue-row"
                  key={item.id}
                  aria-labelledby={queue.getLinkProps(record).id}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography
                      component={Link}
                      {...queue.getLinkProps(record)}
                      className="source-queue-title"
                    >
                      {item.title}
                    </Typography>
                    <Stack
                      direction="row"
                      spacing={1.25}
                      useFlexGap
                      sx={{ flexWrap: "wrap", alignItems: "center", mt: 0.75 }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        {item.kind === "pull_request" ? "PR" : "Issue"} #{item.number} ·{" "}
                        {item.state}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {scope.query.data?.items.find(
                          (repository) => repository.id === item.repositoryId,
                        )?.fullName ?? item.repositoryId}
                      </Typography>
                      <Chip
                        size="small"
                        label={
                          tasks.isPending
                            ? "Loading status…"
                            : tasks.isError
                              ? "Status unavailable"
                              : investigationStateLabel(current)
                        }
                        color={
                          tasks.isError || tasks.isPending ? "default" : statusColor[reviewState]
                        }
                        sx={{ height: 24, fontSize: 12 }}
                      />
                    </Stack>
                  </Box>
                  <SourceNextAction
                    item={item}
                    current={current}
                    savedTask={savedTask}
                    tasks={taskItems}
                    fresh={!query.isError && tasks.isSuccess}
                    onAction={openAction}
                    onCreate={(source) => {
                      const follow = queue.captureRelatedNavigation(record);
                      setCreateTarget({
                        item: source,
                        onCompleted: (task) => {
                          const target = sourceTaskReviewRecord(source, task);
                          return target ? follow(target) : false;
                        },
                      });
                    }}
                    relatedLink={(target) => queue.getRelatedLinkProps(record, target)}
                  />
                  <SourceResultLabel item={item} task={savedTask} validationOnly />
                </Box>
              );
            })}
            {pageCount > 1 && (
              <Stack
                component="footer"
                direction="row"
                spacing={2}
                sx={{
                  px: { xs: 2, sm: 3 },
                  py: 1,
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Typography variant="caption" color="text.secondary" aria-live="polite">
                  {`${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, filtered.length)} of ${filtered.length}`}
                </Typography>
                {pageCount > 1 && (
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                    <TextField
                      select
                      size="small"
                      value={pageSize}
                      onChange={(event) => updateFilters({ rows: event.target.value })}
                      slotProps={{ select: { "aria-label": "Rows per page" } }}
                      sx={{ width: 68, mr: 1 }}
                    >
                      {[10, 20, 50].map((size) => (
                        <MenuItem value={size} key={size}>
                          {size}
                        </MenuItem>
                      ))}
                    </TextField>
                    <IconButton
                      aria-label="Previous page"
                      disabled={currentPage === 1}
                      onClick={() => updateFilters({ page: currentPage - 1 })}
                    >
                      <ArrowBackRounded />
                    </IconButton>
                    <IconButton
                      aria-label="Next page"
                      disabled={currentPage === pageCount}
                      onClick={() => updateFilters({ page: currentPage + 1 })}
                    >
                      <ChevronRightRounded />
                    </IconButton>
                  </Stack>
                )}
              </Stack>
            )}
          </Surface>
        ) : (
          <EmptyState
            icon={<SearchRounded />}
            title={activeFilters ? "No matching sources" : `No ${plural.toLowerCase()} yet`}
            action={
              activeFilters ? (
                <Button
                  onClick={() => updateFilters({ q: "", state: "all", investigation: "all" })}
                >
                  Clear filters
                </Button>
              ) : (
                <ImportWorkItemButton repository={scope.repository} initialKind={kind} />
              )
            }
          />
        ))
      )}
      {createTarget && (
        <StartInvestigationButton
          key={createTarget.item.id}
          workItem={createTarget.item}
          initialOpen
          hideTrigger
          onDismiss={() => setCreateTarget(undefined)}
          onCompleted={createTarget.onCompleted}
        />
      )}
      <Dialog
        open={Boolean(actionTarget)}
        onClose={() => {
          if (!actionBusy) guardedAction(() => setActionTarget(undefined));
        }}
        fullWidth
        maxWidth="md"
        aria-labelledby={actionTitleId}
        slotProps={{
          transition: {
            onExited: () => {
              const opener = actionOpener.current
                ? document.getElementById(actionOpener.current)
                : null;
              if (opener && opener.getClientRects().length > 0 && !opener.hasAttribute("disabled"))
                opener.focus({ preventScroll: true });
            },
          },
        }}
      >
        <DialogTitle id={actionTitleId}>
          {actionItem?.kind === "issue" ? "Issue" : "PR"} #{actionItem?.number}
          {actionItem && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {actionItem.title}
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          {actionTarget && actionItem && (
            <StandaloneActions
              key={actionTarget.request.id}
              workItem={actionItem}
              reportId={actionTarget.reportId}
              request={actionTarget.request}
              onRelatedNavigate={actionTarget.onRelatedNavigate}
              onBusyChange={setActionBusy}
              guardScope={guardScope}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={actionBusy}
            onClick={() => guardedAction(() => setActionTarget(undefined))}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        fullWidth
        maxWidth="xs"
        aria-labelledby="source-filter-title"
      >
        <DialogTitle id="source-filter-title">Filter {plural.toLowerCase()}</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            <TextField
              select
              label="Source state"
              value={filterDraft.state}
              onChange={(event) =>
                setFilterDraft((draft) => ({ ...draft, state: event.target.value }))
              }
            >
              {sourceOptions.map((option) => (
                <MenuItem key={option} value={option}>
                  {option === "all" ? "All sources" : option[0]!.toUpperCase() + option.slice(1)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Investigation status"
              value={filterDraft.investigation}
              onChange={(event) =>
                setFilterDraft((draft) => ({
                  ...draft,
                  investigation: event.target.value as InvestigationFilter,
                }))
              }
            >
              {investigationFilters.map((option) => (
                <MenuItem key={option} value={option}>
                  {investigationLabels[option]}
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" sx={{ justifyContent: "space-between" }}>
              <Button onClick={() => setFilterDraft({ state: "all", investigation: "all" })}>
                Reset filters
              </Button>
              <Button
                startIcon={<RefreshRounded />}
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                Refresh
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFiltersOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              updateFilters(filterDraft);
              setFiltersOpen(false);
            }}
          >
            Show results
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
