import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import FilterListRounded from "@mui/icons-material/FilterListRounded";
import MergeRounded from "@mui/icons-material/MergeRounded";
import RadioButtonCheckedRounded from "@mui/icons-material/RadioButtonCheckedRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
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
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { investigationApi, type WorkItem } from "./api";
import { ImportWorkItemButton } from "./import-work-item";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { type ReviewRecord, useReviewListNavigation } from "./review-navigation";
import { SourceResultLabel } from "./source-result";
import { WorkItemDetails } from "./work-item-details";
import {
  currentWorkItemTask,
  filterWorkItems,
  type InvestigationFilter,
  investigationFilters,
  investigationLabels,
  investigationStateLabel,
  relatedWorkItemTasks,
  workItemInvestigationState,
  workItemUrl,
} from "./work-item-state";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";

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

export function WorkItemsPage({ kind }: { kind: WorkItem["kind"] }) {
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
  const pageSize = [8, 16, 32].includes(Number(parameters.get("rows")))
    ? Number(parameters.get("rows"))
    : 8;
  const page = Math.max(1, Number(parameters.get("page")) || 1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState({ state, investigation });
  const [refreshed, setRefreshed] = useState(false);
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
    const results = await Promise.all([query.refetch(), tasks.refetch()]);
    setRefreshed(results.every((result) => !result.isError));
  };
  const sourceOptions = validStates.filter(
    (value) => kind === "pull_request" || value !== "merged",
  );
  const activeFilters = !!search || state !== "all" || investigation !== "all";
  const activeFilterCount = Number(state !== "all") + Number(investigation !== "all");
  const filtered = filterWorkItems(query.data?.items ?? [], tasks.data?.items ?? [], {
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
  const refreshing = query.isFetching || tasks.isFetching;
  if (selected) return <WorkItemDetails key={selected} id={selected} />;
  return (
    <Stack spacing={3}>
      <PageHeading
        title={plural}
        subtitle={
          kind === "pull_request"
            ? "From a source change to a confident review."
            : "Understand the reported behavior and decide what comes next."
        }
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
              "& .MuiOutlinedInput-root": { borderRadius: 8, bgcolor: "action.hover" },
              "& fieldset": { border: 0 },
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
              label={investigationLabels[value]}
              onClick={() => updateFilters({ investigation: value })}
              aria-pressed={investigation === value}
              variant={investigation === value ? "filled" : "outlined"}
              color={investigation === value ? "primary" : "default"}
              sx={{ borderColor: "transparent", height: 34, cursor: "pointer" }}
            />
          ))}
        </Stack>
        <Typography variant="caption" color="text.secondary" aria-live="polite">
          {refreshing && !query.isPending ? "Refreshing…" : refreshed ? "Updated just now" : ""}
        </Typography>
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
          Investigation status could not be loaded. Source snapshots remain available; investigation
          filtering will resume when status is loaded.{" "}
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
                Source snapshot · Investigation
              </Typography>
            </Stack>
            {visible.map((item) => {
              const current = currentWorkItemTask(item, tasks.data?.items ?? []);
              const reviewState = workItemInvestigationState(current);
              const savedTask = current?.latestReportRef
                ? current
                : relatedWorkItemTasks(item, tasks.data?.items ?? []).find((task) =>
                    Boolean(task.latestReportRef),
                  );
              const record = queueRecords.find((record) => record.id === item.id)!;
              return (
                <ButtonBase
                  component={Link}
                  {...queue.getLinkProps(record)}
                  key={item.id}
                  sx={{
                    display: "grid",
                    width: "100%",
                    textAlign: "left",
                    gridTemplateColumns: {
                      xs: "28px minmax(0, 1fr) 40px",
                      md: "40px minmax(0, 1fr) 172px 40px",
                    },
                    gap: { xs: "8px 12px", md: 2 },
                    alignItems: "center",
                    px: { xs: 2, sm: 3 },
                    py: 2,
                    borderBottom: 1,
                    borderColor: "divider",
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                >
                  <Box
                    aria-hidden="true"
                    sx={{
                      gridColumn: 1,
                      gridRow: 1,
                      width: { xs: 28, md: 40 },
                      height: 40,
                      display: "grid",
                      placeItems: "center",
                      alignSelf: "start",
                      borderRadius: 3,
                      color: item.kind === "issue" ? "success.main" : "primary.main",
                      bgcolor: { xs: "transparent", md: "action.selected" },
                    }}
                  >
                    {item.kind === "pull_request" ? (
                      <MergeRounded />
                    ) : (
                      <RadioButtonCheckedRounded />
                    )}
                  </Box>
                  <Box sx={{ minWidth: 0, gridColumn: 2, gridRow: 1 }}>
                    <Typography
                      component="span"
                      sx={{
                        display: "block",
                        fontSize: 16,
                        fontWeight: 500,
                        lineHeight: 1.5,
                        textDecoration: "none",
                        color: "text.primary",
                        overflowWrap: "anywhere",
                        "&:hover": { color: "primary.main", textDecoration: "underline" },
                      }}
                    >
                      {item.title}
                    </Typography>
                    <Stack
                      direction="row"
                      spacing={1.5}
                      useFlexGap
                      sx={{ flexWrap: "wrap", mt: 0.5 }}
                    >
                      <Typography variant="caption">#{item.number}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {scope.query.data?.items.find(
                          (repository) => repository.id === item.repositoryId,
                        )?.fullName ?? item.repositoryId}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Updated {new Date(item.updatedAt).toLocaleDateString()}
                      </Typography>
                    </Stack>
                  </Box>
                  <Stack
                    spacing={0.75}
                    sx={{
                      gridColumn: { xs: "2 / 4", md: 3 },
                      gridRow: { xs: 2, md: 1 },
                      flexDirection: { xs: "row", md: "column" },
                      alignItems: { xs: "center", md: "flex-start" },
                      gap: { xs: 1.5, md: 0 },
                    }}
                  >
                    <SourceResultLabel item={item} task={savedTask} />
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
                    />
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ textTransform: "capitalize" }}
                    >
                      {item.state} · Snapshot
                    </Typography>
                  </Stack>
                  <Box aria-hidden="true" sx={{ gridColumn: { xs: 3, md: 4 }, gridRow: 1 }}>
                    <ChevronRightRounded />
                  </Box>
                </ButtonBase>
              );
            })}
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
                {pageCount === 1
                  ? `${filtered.length} ${filtered.length === 1 ? singular : plural.toLowerCase()} shown`
                  : `${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, filtered.length)} of ${filtered.length}`}
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
                    {[8, 16, 32].map((size) => (
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
          </Surface>
        ) : (
          <EmptyState
            icon={<SearchRounded />}
            title={activeFilters ? "No matching sources" : `No ${plural.toLowerCase()} yet`}
            description={
              activeFilters
                ? "Try a different title, number, or investigation status."
                : `Import a ${singular} to capture its source and discussion.`
            }
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
