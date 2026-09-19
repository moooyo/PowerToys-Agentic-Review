import type { InvestigationCommentDeliveryQuery } from "@agentic-review/contracts";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { investigationApi } from "./api";
import {
  CommentDeliveryHistoryPanel,
  CommentPublicationControls,
  commentPollingInterval,
  commentQueryKey,
} from "./comment-deliveries";
import { useInvestigationRepositoryScope } from "./repository-scope";

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

export function CommentDetails({ commentId }: { commentId: string }) {
  const scope = useInvestigationRepositoryScope();
  const query = useQuery({
    queryKey: commentQueryKey(commentId),
    queryFn: () => investigationApi.comment(commentId),
    refetchInterval: (current) =>
      commentPollingInterval(current.state.data ? [current.state.data] : []),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  if (query.isPending) return <CircularProgress size={28} aria-label="Loading comment" />;
  if (query.isError)
    return (
      <Alert severity="error">
        {query.error.message}
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </Alert>
    );
  const comment = query.data;
  if (scope.repositoryId && comment.repositoryId !== scope.repositoryId)
    return (
      <Alert severity="warning">This comment does not belong to the selected repository.</Alert>
    );
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="overline">
          {comment.repositoryFullName} · {comment.workItemKind === "pull_request" ? "PR" : "Issue"}{" "}
          #{comment.workItemNumber}
        </Typography>
        <Typography variant="h4">Comment deliveries</Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button
            component={Link}
            to={`/comments?repositoryId=${encodeURIComponent(comment.repositoryId)}`}
          >
            All comment deliveries
          </Button>
          {comment.taskId && (
            <Button
              component={Link}
              to={`/tasks?repositoryId=${encodeURIComponent(comment.repositoryId)}&taskId=${encodeURIComponent(comment.taskId)}`}
            >
              Open task
            </Button>
          )}
        </Stack>
      </Box>
      <CommentPublicationControls comment={comment} />
      <CommentDeliveryHistoryPanel
        filters={{ commentId }}
        pollInterval={commentPollingInterval([comment])}
        showTarget={false}
      />
    </Stack>
  );
}

export default function CommentsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const parameters = new URLSearchParams(location.search);
  const commentId = parameters.get("commentId");
  const filters = commentHistoryFilters(location.search);
  if (commentId) return <CommentDetails key={commentId} commentId={commentId} />;
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4">Comments</Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Recorded create and update attempts, including their saved comment bodies and delivery
          outcomes.
        </Typography>
      </Box>
      <Box
        key={location.search}
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const next = new URLSearchParams();
          if (filters.repositoryId) next.set("repositoryId", filters.repositoryId);
          for (const key of ["workItemNumber", "taskId", "state"]) {
            const value = String(data.get(key) ?? "").trim();
            if (value) next.set(key, value);
          }
          navigate({ pathname: "/comments", search: next.toString() });
        }}
      >
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          sx={{ alignItems: { md: "center" } }}
        >
          <TextField
            name="workItemNumber"
            label="PR or Issue number"
            size="small"
            defaultValue={filters.workItemNumber ?? ""}
            type="number"
            slotProps={{ htmlInput: { min: 1, step: 1 } }}
            sx={{ width: { md: 190 } }}
          />
          <TextField
            name="taskId"
            label="Task ID"
            size="small"
            defaultValue={filters.taskId ?? ""}
            sx={{ flex: 1 }}
          />
          <TextField
            name="state"
            select
            label="Delivery status"
            size="small"
            defaultValue={filters.state ?? ""}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All statuses</MenuItem>
            <MenuItem value="sending">Sending</MenuItem>
            <MenuItem value="succeeded">Delivered</MenuItem>
            <MenuItem value="failed">Failed</MenuItem>
            <MenuItem value="cancelled">Cancelled</MenuItem>
            <MenuItem value="unknown">Unconfirmed</MenuItem>
          </TextField>
          <Button type="submit" variant="outlined">
            Apply filters
          </Button>
          <Button
            component={Link}
            to={`/comments${filters.repositoryId ? `?repositoryId=${encodeURIComponent(filters.repositoryId)}` : ""}`}
          >
            Clear
          </Button>
        </Stack>
      </Box>
      <CommentDeliveryHistoryPanel key={JSON.stringify(filters)} filters={filters} />
    </Stack>
  );
}
