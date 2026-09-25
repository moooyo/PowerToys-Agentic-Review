import type {
  InvestigationCommentDeliveryQuery,
  InvestigationPublicationDirectoryQuery,
} from "@agentic-review/contracts";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import FilterListRounded from "@mui/icons-material/FilterListRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
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
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
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

export function CommentBody({ body }: { body: string }) {
  const sourceId = useId();
  const blocks: ReactNode[] = [];
  let text: string[] = [],
    code = false;
  const flush = () => {
    if (!text.length) return;
    blocks.push(
      code ? (
        <pre key={blocks.length}>{text.join("\n")}</pre>
      ) : (
        <p key={blocks.length}>{text.join("\n")}</p>
      ),
    );
    text = [];
  };
  for (const line of body.split(/\r?\n/u)) {
    if (/^```/u.test(line)) {
      flush();
      code = !code;
      continue;
    }
    if (code) {
      text.push(line);
      continue;
    }
    const title = /^#{1,6}\s+(.+)$/u.exec(line);
    if (title) {
      flush();
      blocks.push(<h3 key={blocks.length}>{title[1]}</h3>);
    } else if (!line.trim()) flush();
    else text.push(line);
  }
  flush();
  return (
    <>
      <div className="comments-body">{blocks}</div>
      <Accordion variant="outlined" disableGutters className="comments-disclosure">
        <AccordionSummary
          id={`${sourceId}-summary`}
          aria-controls={`${sourceId}-source`}
          expandIcon={<ExpandMoreRounded />}
        >
          <Typography>Original Markdown</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <pre className="comments-retained-body">{body}</pre>
        </AccordionDetails>
      </Accordion>
    </>
  );
}

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

export function commentPublicationFilters(search: string): Omit<
  InvestigationPublicationDirectoryQuery,
  "cursor" | "limit"
> & {
  workItemKind?: "pull_request" | "issue";
} {
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
    ...(["pull_request", "issue"].includes(parameters.get("workItemKind") ?? "")
      ? { workItemKind: parameters.get("workItemKind") as "pull_request" | "issue" }
      : {}),
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
  const historyId = useId();
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
      <Alert
        severity="warning"
        action={
          <Button
            component={Link}
            to={`/comments?repositoryId=${encodeURIComponent(scope.repositoryId)}`}
          >
            Back to comments
          </Button>
        }
      >
        This comment does not belong to the selected repository.
      </Alert>
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
        title={comment.workItemTitle || publicationKindLabel(comment)}
        eyebrow={`${comment.repositoryFullName} · ${comment.workItemKind === "pull_request" ? "PR" : "Issue"} #${comment.workItemNumber}`}
        subtitle={publicationKindLabel(comment)}
      >
        <CommentStatus comment={comment} />
      </PageHeading>
      {query.isError && (
        <Alert severity="error">
          {query.error.message} Refresh before scheduling another operation.
          <Button onClick={() => void query.refetch()}>Refresh publication</Button>
        </Alert>
      )}
      <Box className="comments-detail-grid">
        <Stack spacing={3} sx={{ minWidth: 0 }}>
          <Surface sx={{ p: 2 }}>
            <CommentPublicationControls comment={comment} stale={query.isError} />
          </Surface>
          <Surface sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Comment
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
              <Box>
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
                {latest.body ? (
                  <CommentBody body={latest.body} />
                ) : (
                  <Typography color="text.secondary">No comment body recorded.</Typography>
                )}
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
            {attempts.data?.items.length === 0 && <EmptyState title="No retained body yet" />}
            <CommentContextLinks comment={comment} />
          </Surface>
        </Stack>
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          <Accordion variant="outlined" disableGutters className="comments-disclosure">
            <AccordionSummary
              id={`${historyId}-summary`}
              aria-controls={`${historyId}-history`}
              expandIcon={<ExpandMoreRounded />}
            >
              <Typography>Delivery history</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <CommentDeliveryHistoryPanel
                filters={{ commentId }}
                pollInterval={commentPollingInterval([comment])}
                showTarget={false}
                showHeading={false}
              />
            </AccordionDetails>
          </Accordion>
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
    workItemKind: filters.workItemKind
      ? `Work item: ${filters.workItemKind === "pull_request" ? "Pull requests" : "Issues"}`
      : undefined,
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
  const clear = () => {
    setSearch("");
    setFiltersOpen(false);
    navigate(
      `/comments${filters.repositoryId ? `?repositoryId=${encodeURIComponent(filters.repositoryId)}` : ""}`,
    );
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (filters.repositoryId) next.set("repositoryId", filters.repositoryId);
    if (filters.workItemId) next.set("workItemId", filters.workItemId);
    for (const key of [
      "search",
      "workItemNumber",
      "taskId",
      "state",
      "mode",
      "taskKind",
      "workItemKind",
    ]) {
      const value = String(data.get(key) ?? "").trim();
      if (value) next.set(key, value);
    }
    navigate({ pathname: "/comments", search: next.toString() });
    setFiltersOpen(false);
  };
  const fields = (
    <>
      <TextField
        name="workItemKind"
        select
        label="Work item"
        size="small"
        defaultValue={filters.workItemKind ?? ""}
        slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
        fullWidth
      >
        <MenuItem value="">All work items</MenuItem>
        <MenuItem value="pull_request">Pull requests</MenuItem>
        <MenuItem value="issue">Issues</MenuItem>
      </TextField>
      <TextField
        name="state"
        select
        label="Delivery"
        size="small"
        defaultValue={filters.state ?? ""}
        slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
        fullWidth
      >
        <MenuItem value="">All delivery states</MenuItem>
        {Object.entries(publicationLabels).map(([value, label]) => (
          <MenuItem key={value} value={value}>
            {label}
          </MenuItem>
        ))}
      </TextField>
    </>
  );
  const extraFields = (
    <>
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
      <Surface sx={{ p: 3 }}>
        <Box component="form" onSubmit={submit} className="comments-filter-bar">
          <TextField
            name="search"
            label="Search publications"
            placeholder="Title, body or number"
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
          {filters.mode && <input type="hidden" name="mode" value={filters.mode} />}
          {filters.taskKind && <input type="hidden" name="taskKind" value={filters.taskKind} />}
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
            variant="text"
            onClick={() => setFiltersOpen(true)}
          >
            More filters{activeFilters ? ` (${activeFilters})` : ""}
          </Button>
          {activeFilters > 0 && <Button onClick={clear}>Clear</Button>}
          {query.data && (
            <Typography
              className="comments-filter-count"
              variant="body2"
              color="text.secondary"
              role="status"
            >
              {query.data.items.length}{" "}
              {query.data.items.length === 1 ? "publication" : "publications"} on this page
            </Typography>
          )}
        </Box>
      </Surface>
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
                    minHeight: 28,
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
      {query.isPending && <CircularProgress size={28} aria-label="Loading publications" />}
      {query.isError && (
        <Alert severity="error">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Alert>
      )}
      {query.data &&
        (query.data.items.length ? (
          <Surface sx={{ p: { xs: 2, sm: 3 }, overflow: "hidden" }}>
            <Box className="comments-table-wrap">
              <table className="comments-table">
                <thead>
                  <tr>
                    {["Publication", "Target", "Delivery", "Updated", "Actions"].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((comment) => (
                    <CommentPublicationRow key={comment.id} comment={comment} tableRow />
                  ))}
                </tbody>
              </table>
            </Box>
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
            action={
              activeFilters > 0 || filters.repositoryId ? (
                <Stack
                  direction="row"
                  spacing={1}
                  useFlexGap
                  sx={{ justifyContent: "center", flexWrap: "wrap" }}
                >
                  {activeFilters > 0 && (
                    <Button variant="outlined" onClick={clear}>
                      Clear filters
                    </Button>
                  )}
                  {filters.repositoryId && (
                    <Button
                      onClick={() =>
                        navigate(
                          commentPublicationFilterUrl({ ...filters, repositoryId: undefined }),
                        )
                      }
                    >
                      Show all repositories
                    </Button>
                  )}
                </Stack>
              ) : undefined
            }
          />
        ))}
      <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Filter comments</DialogTitle>
        <Box component="form" onSubmit={submit}>
          <DialogContent>
            <Stack spacing={2.5}>
              <TextField
                name="search"
                label="Search publications"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                fullWidth
                slotProps={{ htmlInput: { maxLength: 200 } }}
              />
              {fields}
              {extraFields}
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
                label="Task ID"
                defaultValue={filters.taskId ?? ""}
                fullWidth
              />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ flexWrap: "wrap", gap: 1, p: 2 }}>
            {activeFilters > 0 && <Button onClick={clear}>Clear filters</Button>}
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
