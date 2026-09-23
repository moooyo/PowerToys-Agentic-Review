import type {
  InvestigationCommentDeliveryQuery,
  InvestigationPublicationDirectoryQuery,
} from "@agentic-review/contracts";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
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
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { investigationApi } from "./api";
import {
  CommentContextLinks,
  CommentDeliveryHistoryPanel,
  CommentPublicationControls,
  CommentPublicationRow,
  CommentStatus,
  commentDeliveriesQueryKey,
  commentPollingInterval,
  commentQueryKey,
  publicationKindLabel,
  publicationLabels,
  publicationsQueryKey,
  RecordedTime,
} from "./comment-deliveries";
import { useInvestigationRepositoryScope } from "./repository-scope";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";

/** Retained for existing links to the attempt-history API. */
export function commentHistoryFilters(
  search: string,
): Omit<InvestigationCommentDeliveryQuery, "cursor" | "limit"> {
  const parameters = new URLSearchParams(search);
  const state = parameters.get("state");
  const number = parameters.get("workItemNumber");
  return {
    ...(parameters.get("repositoryId") ? { repositoryId: parameters.get("repositoryId")! } : {}),
    ...(parameters.get("taskId") ? { taskId: parameters.get("taskId")! } : {}),
    ...(number && /^[1-9][0-9]*$/u.test(number) && Number.isSafeInteger(Number(number))
      ? { workItemNumber: Number(number) }
      : {}),
    ...(["sending", "succeeded", "failed", "cancelled", "unknown"].includes(state ?? "")
      ? { state: state as InvestigationCommentDeliveryQuery["state"] }
      : {}),
  };
}

export function commentPublicationFilters(
  search: string,
): Omit<InvestigationPublicationDirectoryQuery, "cursor" | "limit"> {
  const parameters = new URLSearchParams(search);
  const state = parameters.get("state");
  const mode = parameters.get("mode");
  const number = parameters.get("workItemNumber");
  const query = parameters.get("search")?.trim().slice(0, 200);
  return {
    ...(parameters.get("repositoryId") ? { repositoryId: parameters.get("repositoryId")! } : {}),
    ...(parameters.get("workItemId") ? { workItemId: parameters.get("workItemId")! } : {}),
    ...(parameters.get("taskId") ? { taskId: parameters.get("taskId")! } : {}),
    ...(number && /^[1-9][0-9]*$/u.test(number) && Number.isSafeInteger(Number(number))
      ? { workItemNumber: Number(number) }
      : {}),
    ...(query ? { search: query } : {}),
    ...(state && Object.hasOwn(publicationLabels, state)
      ? { state: state as InvestigationPublicationDirectoryQuery["state"] }
      : {}),
    ...(mode === "progress" || mode === "result" ? { mode } : {}),
    ...(parameters.get("taskKind") === "pr-e2e" ? { taskKind: "pr-e2e" as const } : {}),
  };
}

export function commentPublicationFilterUrl(
  filters: ReturnType<typeof commentPublicationFilters>,
  remove?: Exclude<keyof ReturnType<typeof commentPublicationFilters>, "repositoryId">,
): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key !== remove && value !== undefined) parameters.set(key, String(value));
  }
  return `/comments${parameters.size ? `?${parameters.toString()}` : ""}`;
}

export function CommentDetails({ commentId }: { commentId: string }) {
  const scope = useInvestigationRepositoryScope();
  const query = useQuery({
    queryKey: commentQueryKey(commentId),
    queryFn: async () => {
      const comment = await investigationApi.comment(commentId);
      if (comment.id !== commentId)
        throw new Error("The publication does not match the requested comment.");
      return comment;
    },
    refetchInterval: (current) =>
      commentPollingInterval(current.state.data ? [current.state.data] : []),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const attemptInput = { commentId, cursor: undefined, limit: 25 };
  const attempts = useQuery({
    queryKey: commentDeliveriesQueryKey(attemptInput),
    queryFn: () => investigationApi.commentAttempts(commentId, { limit: 25 }),
    enabled: Boolean(
      query.data && (!scope.repositoryId || query.data.repositoryId === scope.repositoryId),
    ),
    refetchInterval: commentPollingInterval(query.data ? [query.data] : []),
    refetchIntervalInBackground: false,
  });
  if (query.isPending) return <CircularProgress size={28} aria-label="Loading comment" />;
  if (!query.data)
    return (
      <Alert severity="error">
        {query.error?.message ?? "The publication could not be loaded."}
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </Alert>
    );
  const comment = query.data;
  if (scope.repositoryId && comment.repositoryId !== scope.repositoryId)
    return (
      <Alert severity="warning">This comment does not belong to the selected repository.</Alert>
    );
  const latest = attempts.data?.items[0];
  const exactAttempt =
    latest?.commentId === comment.id &&
    latest.repositoryId === comment.repositoryId &&
    latest.workItemKind === comment.workItemKind &&
    latest.workItemNumber === comment.workItemNumber;
  return (
    <Stack spacing={3} className="comments-page">
      <Box>
        <Button
          component={Link}
          startIcon={<ArrowBackRounded />}
          to={`/comments?repositoryId=${encodeURIComponent(comment.repositoryId)}`}
        >
          All comments
        </Button>
      </Box>
      <PageHeading
        title={publicationKindLabel(comment)}
        eyebrow={`${comment.repositoryFullName} · ${comment.workItemKind === "pull_request" ? "PR" : "Issue"} #${comment.workItemNumber}`}
        subtitle={comment.workItemTitle || "Recorded publication and delivery history"}
      >
        <CommentStatus comment={comment} />
      </PageHeading>
      <CommentContextLinks comment={comment} />
      {query.isError && (
        <Alert severity="error">
          {query.error.message} The last loaded publication and retained history remain visible.
          Refresh before scheduling a new operation.
          <Button onClick={() => void query.refetch()}>Refresh publication</Button>
        </Alert>
      )}
      <Box className="comments-detail-grid">
        <Stack spacing={3} sx={{ minWidth: 0 }}>
          <Surface sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Last recorded comment
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              The retained body belongs to its recorded delivery attempt. A newer task update may
              still be waiting for preparation.
            </Typography>
            {attempts.isPending && (
              <CircularProgress size={24} aria-label="Loading retained comment" />
            )}
            {attempts.isError && (
              <Alert severity="error">
                {attempts.error.message}
                <Button onClick={() => void attempts.refetch()}>Retry</Button>
              </Alert>
            )}
            {latest && !exactAttempt && (
              <Alert severity="error">The retained attempt does not match this publication.</Alert>
            )}
            {latest && exactAttempt && (
              <Box sx={{ bgcolor: "action.hover", borderRadius: 3, p: { xs: 2, sm: 3 } }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 2 }}>
                  <Box
                    className="comments-author"
                    sx={{ bgcolor: "primary.main", color: "primary.contrastText" }}
                  >
                    AR
                  </Box>
                  <Box>
                    <Typography variant="subtitle2">Agentic Review</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {publicationKindLabel(comment)} ·{" "}
                      {latest.state === "succeeded" ? "Delivered body" : "Attempted body"}
                    </Typography>
                  </Box>
                </Stack>
                <Box
                  component="pre"
                  className="comments-retained-body"
                  sx={{ typography: "body1" }}
                >
                  {latest.body ?? "No prepared comment body was retained for this delivery."}
                </Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  component="p"
                  sx={{ mt: 2, mb: 0 }}
                >
                  Recorded <RecordedTime value={latest.startedAt} /> ·{" "}
                  {latest.operation === "create" ? "Create" : "Update"}
                </Typography>
              </Box>
            )}
            {attempts.data?.items.length === 0 && (
              <EmptyState
                title="No retained body yet"
                description="The publication has no recorded delivery attempts. The task and report remain available."
              />
            )}
          </Surface>
          <Surface sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Delivery options
            </Typography>
            <CommentPublicationControls comment={comment} stale={query.isError} />
          </Surface>
        </Stack>
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          <Surface sx={{ p: { xs: 2, sm: 3 } }}>
            <CommentDeliveryHistoryPanel
              filters={{ commentId }}
              pollInterval={commentPollingInterval([comment])}
              showTarget={false}
            />
          </Surface>
          <Typography variant="caption" color="text.secondary">
            Create and update attempts retain their own bodies. Later checks are recorded as
            observations. Publication status does not establish a successful investigation or
            application test.
          </Typography>
        </Stack>
      </Box>
    </Stack>
  );
}

function PublicationDirectory({
  filters,
}: {
  filters: ReturnType<typeof commentPublicationFilters>;
}) {
  const navigate = useNavigate();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState(filters.search ?? "");
  const input = { ...filters, cursor: cursors.at(-1), limit: 25 };
  const query = useQuery({
    queryKey: publicationsQueryKey(input),
    queryFn: ({ signal }) => investigationApi.publications(input, signal),
    refetchInterval: (current) => commentPollingInterval(current.state.data?.items ?? []),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const activeFilters = Object.keys(filters).filter((key) => key !== "repositoryId").length;
  const filterLabels = {
    search: filters.search ? `Search: ${filters.search}` : undefined,
    state: filters.state ? `State: ${publicationLabels[filters.state]}` : undefined,
    mode: filters.mode
      ? `Type: ${filters.mode === "progress" ? "Progress updates" : "Review results"}`
      : undefined,
    taskKind: filters.taskKind ? "Producer: E2E tasks" : undefined,
    taskId: filters.taskId ? `Task ID: ${filters.taskId}` : undefined,
    workItemNumber: filters.workItemNumber ? `Source: #${filters.workItemNumber}` : undefined,
    workItemId: filters.workItemId ? `Source ID: ${filters.workItemId}` : undefined,
  };
  const removeFilter = (key: keyof typeof filterLabels) =>
    navigate(commentPublicationFilterUrl(filters, key));
  const clear = () =>
    navigate(
      `/comments${filters.repositoryId ? `?repositoryId=${encodeURIComponent(filters.repositoryId)}` : ""}`,
    );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (filters.repositoryId) next.set("repositoryId", filters.repositoryId);
    if (filters.workItemId) next.set("workItemId", filters.workItemId);
    for (const key of ["search", "workItemNumber", "taskId", "state", "mode", "taskKind"]) {
      const value = String(data.get(key) ?? "").trim();
      if (value) next.set(key, value);
    }
    navigate({ pathname: "/comments", search: next.toString() });
    setFiltersOpen(false);
  };
  const fields = (
    <>
      <TextField
        name="state"
        select
        label="Publication state"
        size="small"
        defaultValue={filters.state ?? ""}
        fullWidth
      >
        <MenuItem value="">All states</MenuItem>
        {Object.entries(publicationLabels).map(([value, label]) => (
          <MenuItem key={value} value={value}>
            {label}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        name="mode"
        select
        label="Publication type"
        size="small"
        defaultValue={filters.mode ?? ""}
        fullWidth
      >
        <MenuItem value="">All publications</MenuItem>
        <MenuItem value="progress">Progress updates</MenuItem>
        <MenuItem value="result">Review results</MenuItem>
      </TextField>
      <TextField
        name="taskKind"
        select
        label="Producer"
        size="small"
        defaultValue={filters.taskKind ?? ""}
        fullWidth
      >
        <MenuItem value="">All tasks</MenuItem>
        <MenuItem value="pr-e2e">E2E tasks</MenuItem>
      </TextField>
    </>
  );
  return (
    <Stack spacing={2.5} className="comments-page">
      <PageHeading
        title="Comments"
        subtitle="Track published updates and resolve delivery issues."
        action={
          <Button
            startIcon={<RefreshRounded />}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      <Box component="form" onSubmit={submit} className="comments-filter-bar">
        <TextField
          name="search"
          label="Search comments"
          placeholder="Title, source number, or task ID"
          size="small"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="comments-search"
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded fontSize="small" />
                </InputAdornment>
              ),
            },
            htmlInput: { maxLength: 200 },
          }}
        />
        <Box className="comments-desktop-filters">{fields}</Box>
        {filters.taskId && <input type="hidden" name="taskId" value={filters.taskId} />}
        {filters.workItemNumber && (
          <input type="hidden" name="workItemNumber" value={filters.workItemNumber} />
        )}
        <Button type="submit" className="comments-desktop-apply">
          Apply
        </Button>
        <Button
          startIcon={<FilterListRounded />}
          className="comments-more-filters"
          variant={activeFilters ? "contained" : "outlined"}
          onClick={() => setFiltersOpen(true)}
        >
          More filters{activeFilters ? ` (${activeFilters})` : ""}
        </Button>
        {activeFilters > 0 && <Button onClick={clear}>Clear</Button>}
      </Box>
      {activeFilters > 0 && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap" }}
          role="group"
          aria-label="Active comment filters"
        >
          {Object.entries(filterLabels).map(
            ([key, label]) =>
              label && (
                <Chip
                  key={key}
                  label={label}
                  variant="outlined"
                  onClick={() => removeFilter(key as keyof typeof filterLabels)}
                  onDelete={() => removeFilter(key as keyof typeof filterLabels)}
                  aria-label={`Remove ${label}`}
                  sx={{
                    maxWidth: "100%",
                    height: "auto",
                    minHeight: 44,
                    "@media (pointer: coarse)": { minHeight: 48 },
                    "& .MuiChip-label": {
                      whiteSpace: "normal",
                      overflowWrap: "anywhere",
                      py: 0.75,
                    },
                  }}
                />
              ),
          )}
        </Stack>
      )}
      {(filters.taskId || filters.workItemNumber || filters.workItemId) && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          Showing{" "}
          {filters.taskId
            ? `task ${filters.taskId}`
            : filters.workItemNumber
              ? `source #${filters.workItemNumber}`
              : `source ${filters.workItemId}`}{" "}
          publications.
        </Typography>
      )}
      {query.isPending && <CircularProgress size={28} aria-label="Loading publications" />}
      {query.isError && (
        <Alert severity="error">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Alert>
      )}
      {query.data &&
        (query.data.items.length ? (
          <Surface sx={{ p: 0, overflow: "hidden" }}>
            <Stack
              direction="row"
              sx={{ px: { xs: 2, sm: 2.5 }, py: 1.5, justifyContent: "space-between", gap: 1 }}
            >
              <Typography variant="subtitle2">Publication history</Typography>
            </Stack>
            {query.data.items.map((comment) => (
              <CommentPublicationRow key={comment.id} comment={comment} />
            ))}
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{
                px: 2,
                py: 1,
                alignItems: "center",
                flexWrap: "wrap",
                borderTop: 1,
                borderColor: "divider",
              }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ mr: "auto" }}>
                {query.data.items.length} publications on this page
              </Typography>
              {(cursors.length > 1 || query.data.nextCursor) && (
                <>
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
                </>
              )}
            </Stack>
          </Surface>
        ) : (
          <EmptyState
            title={activeFilters ? "No comments match" : "No comments yet"}
            description={
              activeFilters
                ? "Try another source number or clear the publication filters."
                : "Comments appear here after a task prepares a progress update or report publication."
            }
            action={
              activeFilters ? (
                <Button variant="outlined" onClick={clear}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ))}
      <Typography variant="caption" color="text.secondary">
        Delivery state describes the comment. Open its task to review the investigation outcome.
        Recorded history remains available when intake or publishing is paused.
      </Typography>
      <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Filter comments</DialogTitle>
        <Box component="form" onSubmit={submit}>
          <DialogContent>
            <Stack spacing={2.5}>
              <TextField
                name="search"
                label="Search comments"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                fullWidth
                slotProps={{ htmlInput: { maxLength: 200 } }}
              />
              {fields}
              <TextField
                name="workItemNumber"
                label="PR or issue number"
                type="number"
                defaultValue={filters.workItemNumber ?? ""}
                slotProps={{ htmlInput: { min: 1, step: 1 } }}
                fullWidth
              />
              <TextField
                name="taskId"
                label="Exact Task ID"
                defaultValue={filters.taskId ?? ""}
                helperText="Filter by the recorded Task ID, independently of the source number."
                fullWidth
              />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ flexWrap: "wrap", gap: 1, p: 2 }}>
            <Button onClick={clear}>Clear filters</Button>
            <Button onClick={() => setFiltersOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained">
              Show comments
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Stack>
  );
}

export default function CommentsPage() {
  const location = useLocation();
  const parameters = new URLSearchParams(location.search);
  const commentId = parameters.get("commentId");
  if (commentId) return <CommentDetails key={commentId} commentId={commentId} />;
  if (
    parameters.get("view") === "attempts" ||
    ["succeeded", "failed", "cancelled", "unknown"].includes(parameters.get("state") ?? "")
  ) {
    const filters = commentHistoryFilters(location.search);
    return (
      <Stack spacing={3} className="comments-page">
        <PageHeading
          title="Comment delivery attempts"
          subtitle="Recorded create and update attempts, with their original bodies and outcomes."
          action={
            <Button
              component={Link}
              to={`/comments${filters.repositoryId ? `?repositoryId=${encodeURIComponent(filters.repositoryId)}` : ""}`}
            >
              All publications
            </Button>
          }
        />
        <Surface sx={{ p: { xs: 2, sm: 3 } }}>
          <CommentDeliveryHistoryPanel key={JSON.stringify(filters)} filters={filters} />
        </Surface>
      </Stack>
    );
  }
  const filters = commentPublicationFilters(location.search);
  return <PublicationDirectory key={JSON.stringify(filters)} filters={filters} />;
}
