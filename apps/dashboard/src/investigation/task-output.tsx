import type {
  InvestigationAttemptV1,
  InvestigationModelInvocationReceipt,
  InvestigationTaskV1,
  InvestigationUsageSummary,
} from "@agentic-review/contracts";
import CloseRounded from "@mui/icons-material/CloseRounded";
import CodeRounded from "@mui/icons-material/CodeRounded";
import DownloadRounded from "@mui/icons-material/DownloadRounded";
import InfoRounded from "@mui/icons-material/InfoRounded";
import PauseRounded from "@mui/icons-material/PauseRounded";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import SmartToyRounded from "@mui/icons-material/SmartToyRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentRuntimeMetadata } from "./agent-runtime-metadata";
import { investigationApi } from "./api";
import { sessionIdentity, useInvestigationSession } from "./session";
import {
  emptyTaskOutput,
  exportLoadedOutput,
  mergeTaskOutput,
  normalizeTaskOutputView,
  type OutputItem,
  orderedTaskAttempts,
  outputMatches,
  type TaskOutputState,
  type TaskOutputView,
} from "./task-output-state";
import { InvestigationHttpError } from "./transport";
import "./task-output.css";

export function taskOutputQueryKey(identity: string, taskId: string, attemptId: string) {
  return ["investigation-task-output", identity, taskId, attemptId] as const;
}

export function taskOutputAccessKey(identity: string, taskId: string, attemptId: string) {
  return ["investigation-task-output-denied", identity, taskId, attemptId] as const;
}

export function outputAccessDenied(error: unknown): boolean {
  return error instanceof InvestigationHttpError && [401, 403].includes(error.status);
}

function OutputText({ text, code = false }: { text: string; code?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 1_800 || text.split("\n").length > 16;
  const visible =
    long && !expanded ? `${text.slice(0, 1_800).split("\n").slice(0, 16).join("\n")}…` : text;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        component={code ? "pre" : "p"}
        className={code ? "task-output-code" : "task-output-text"}
      >
        {visible}
      </Typography>
      {long && (
        <Button size="small" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Expand content"}
        </Button>
      )}
    </Box>
  );
}

export function OutputEventRow({ item }: { item: OutputItem }) {
  const icon =
    item.kind === "assistant" ? (
      <SmartToyRounded fontSize="small" />
    ) : item.kind === "tool" ? (
      <CodeRounded fontSize="small" />
    ) : (
      <InfoRounded fontSize="small" />
    );
  const title =
    item.kind === "assistant"
      ? "Agent"
      : item.kind === "tool"
        ? "Tool"
        : item.kind === "gap"
          ? "Output gap"
          : "Task event";
  return (
    <Box component="li" className={`task-output-event task-output-${item.kind}`}>
      <Box
        className="task-output-event-icon"
        sx={{
          color:
            item.kind === "assistant"
              ? "primary.main"
              : item.kind === "gap"
                ? "warning.main"
                : "text.secondary",
          bgcolor: item.kind === "assistant" ? "action.selected" : "transparent",
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Box className="task-output-event-meta">
          <Typography variant="subtitle2">{title}</Typography>
          {item.status && (
            <Typography variant="caption" color="text.secondary">
              {item.status}
            </Typography>
          )}
          <Typography
            component="time"
            dateTime={item.observedAt}
            variant="caption"
            color="text.secondary"
            title={new Date(item.observedAt).toLocaleString()}
          >
            {new Date(item.observedAt).toLocaleTimeString()}
          </Typography>
        </Box>
        {item.text && <OutputText text={item.text} />}
        {(item.command || item.result) && (
          <Box className="task-output-tool" sx={{ bgcolor: "action.hover" }}>
            {item.command && <OutputText text={item.command} code />}
            {item.result && <OutputText text={item.result} code />}
          </Box>
        )}
      </Box>
    </Box>
  );
}

interface TaskOutputProps {
  task: InvestigationTaskV1;
  attempts: InvestigationAttemptV1[];
  attemptId?: string;
  onAttemptChange: (attemptId: string) => void;
  onHistory?: () => void;
  view?: TaskOutputView;
  onViewChange?: (view: TaskOutputView) => void;
  summary?: InvestigationUsageSummary;
  invocations?: InvestigationModelInvocationReceipt[];
}

interface OutputReadSnapshot {
  state: TaskOutputState;
  checkedAt: number;
}

export function TaskOutputPanel(props: TaskOutputProps) {
  const { session } = useInvestigationSession();
  if (!session.authenticated) return <Alert severity="warning">Sign in to read task output.</Alert>;
  if (!session.user.repositoryIds.includes(props.task.repository.id))
    return <Alert severity="warning">Task output is unavailable for the current account.</Alert>;
  const identity = sessionIdentity(session);
  return (
    <TaskOutputReader
      key={JSON.stringify([identity, props.task.id, props.attemptId])}
      {...props}
      identity={identity}
      enabled={session.authenticated}
    />
  );
}

function TaskOutputReader({
  task,
  attempts,
  attemptId,
  onAttemptChange,
  onHistory,
  view,
  onViewChange,
  summary,
  invocations,
  identity,
  enabled,
}: TaskOutputProps & { identity: string; enabled: boolean }) {
  const queryClient = useQueryClient();
  const [output, setOutput] = useState(() => emptyTaskOutput(task.id, attemptId ?? ""));
  const state = useRef(output);
  const accessKey = useMemo(
    () => taskOutputAccessKey(identity, task.id, attemptId ?? ""),
    [identity, task.id, attemptId],
  );
  const access = useQuery<boolean>({
    queryKey: accessKey,
    queryFn: () => false,
    initialData: false,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const denied = access.data;
  const setDenied = useCallback(
    (value: boolean) => queryClient.setQueryData(accessKey, value),
    [queryClient, accessKey],
  );
  const [localView, setLocalView] = useState<TaskOutputView>({ search: "", type: "all" });
  const currentView = normalizeTaskOutputView(view ?? localView);
  const search = currentView.search;
  const filter = currentView.type;
  const [searchOpen, setSearchOpen] = useState(false);
  const searchVisible = searchOpen || !!search || filter !== "all";
  const updateView = (next: Partial<TaskOutputView>) => {
    const updated = normalizeTaskOutputView({ ...currentView, ...next });
    if (view === undefined) setLocalView(updated);
    onViewChange?.(updated);
  };
  const [following, setFollowing] = useState(!search && filter === "all");
  const [seenCount, setSeenCount] = useState(0);
  const [exportError, setExportError] = useState<string>();
  const viewport = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const terminalQuietPolls = useRef(0);
  const wasActive = useRef<boolean | undefined>(undefined);
  const orderedAttempts = orderedTaskAttempts(task.id, attempts);
  const selectedAttempt = orderedAttempts.find((attempt) => attempt.id === attemptId);
  const latestAttempt = orderedAttempts[0];
  const historical = Boolean(selectedAttempt && latestAttempt?.id !== selectedAttempt.id);
  const active =
    selectedAttempt !== undefined &&
    ["queued", "leased", "running"].includes(selectedAttempt.state);
  const queryKey = useMemo(
    () => taskOutputQueryKey(identity, task.id, attemptId ?? ""),
    [identity, task.id, attemptId],
  );
  const query = useQuery<OutputReadSnapshot>({
    queryKey,
    enabled: (current) =>
      enabled && !!attemptId && !denied && !outputAccessDenied(current.state.error),
    queryFn: async ({ signal }) => {
      if (queryClient.getQueryData(accessKey) === true)
        throw new InvestigationHttpError(403, "Output access requires an explicit retry.");
      const page = await investigationApi.taskOutput(
        task.id,
        { attemptId: attemptId!, after: state.current.cursor, limit: 200 },
        signal,
      );
      signal.throwIfAborted();
      const next = mergeTaskOutput(state.current, page);
      terminalQuietPolls.current =
        page.items.length === 0 && !page.nextCursor ? terminalQuietPolls.current + 1 : 0;
      state.current = next;
      return { state: next, checkedAt: Date.now() };
    },
    refetchInterval: (current) => {
      if (outputAccessDenied(current.state.error)) return false;
      if (!active && current.state.errorUpdateCount >= 3) return false;
      if (current.state.error) return 5_000;
      if (current.state.data?.state.hasMore) return 100;
      return active || terminalQuietPolls.current < 3 ? 1_500 : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (current) => !denied && !outputAccessDenied(current.state.error),
    refetchOnReconnect: (current) => !denied && !outputAccessDenied(current.state.error),
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    if (query.data) setOutput(query.data.state);
  }, [query.data]);
  useEffect(() => {
    if (wasActive.current === true && !active) {
      terminalQuietPolls.current = 0;
      if (attemptId && !denied) void query.refetch();
    }
    wasActive.current = active;
  }, [active, attemptId, denied, query.refetch]);
  useEffect(() => {
    if (!denied && !outputAccessDenied(query.error)) return;
    if (!denied) setDenied(true);
    const empty = emptyTaskOutput(task.id, attemptId ?? "");
    state.current = empty;
    setOutput(empty);
    queryClient.removeQueries({ queryKey, exact: true });
  }, [denied, query.error, queryClient, queryKey, setDenied, task.id, attemptId]);
  const inaccessible = denied || outputAccessDenied(query.error);
  const shown = useMemo(
    () => (inaccessible ? [] : output.items.filter((item) => outputMatches(item, search, filter))),
    [inaccessible, output.items, search, filter],
  );
  useEffect(() => {
    if (following) {
      setSeenCount(output.eventCount);
      if (viewport.current && shown.length > 0) {
        viewport.current.scrollTop = viewport.current.scrollHeight;
      }
    }
  }, [following, output.eventCount, shown.length]);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (search || filter !== "all") setFollowing(false);
  }, [search, filter]);
  const disconnected = query.isError && !inaccessible;
  const lastReceived = output.items.reduce(
    (latest, item) => Math.max(latest, Date.parse(item.receivedAt)),
    0,
  );
  const status = inaccessible
    ? "Unavailable"
    : disconnected
      ? "Disconnected"
      : !attemptId || (selectedAttempt?.state === "queued" && output.items.length === 0)
        ? "Waiting"
        : query.isPending
          ? "Connecting"
          : !active
            ? output.items.length
              ? "Saved"
              : "Not recorded"
            : !output.items.length
              ? "Waiting for output"
              : query.data && Date.now() - lastReceived > 30_000
                ? "No recent output"
                : "Connected";
  const gap =
    output.retentionGap || output.localGap || output.items.some((item) => item.kind === "gap");
  const follow = () => {
    setFollowing(true);
    setSeenCount(output.eventCount);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    updateView({ search: "", type: "all" });
    searchTrigger.current?.focus();
  };
  const download = () => {
    if (inaccessible) return;
    setExportError(undefined);
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([exportLoadedOutput(output)], { type: "text/plain;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${task.id}-${attemptId}-loaded-output.txt`;
      anchor.click();
    } catch (cause) {
      setExportError(
        cause instanceof Error ? cause.message : "The loaded output could not be downloaded.",
      );
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };
  return (
    <Box
      component="section"
      className="task-output-surface"
      aria-label="Agent output"
      sx={{ border: 1, borderColor: "divider", bgcolor: "background.paper", borderRadius: "16px" }}
    >
      <Box
        component="header"
        className="task-output-heading"
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Stack
          direction="row"
          useFlexGap
          spacing={1.5}
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography component="h2" variant="h6">
            Output
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={status}
            color={disconnected || denied ? "warning" : "default"}
          />
        </Stack>
        <Box className="task-output-actions">
          {orderedAttempts.length > 0 && (
            <TextField
              select
              size="small"
              value={attemptId ?? ""}
              label="Attempt"
              onChange={(event) => onAttemptChange(event.target.value)}
              sx={{ minWidth: 136, maxWidth: 220 }}
            >
              {orderedAttempts.map((attempt) => (
                <MenuItem key={attempt.id} value={attempt.id}>
                  Attempt {attempt.number}
                  {attempt.id === latestAttempt?.id ? " · latest" : " · historical"} ·{" "}
                  {attempt.state}
                </MenuItem>
              ))}
            </TextField>
          )}
          <Tooltip title="Find or filter output">
            <IconButton
              ref={searchTrigger}
              aria-label="Find or filter output"
              aria-expanded={searchVisible}
              onClick={() => (searchVisible ? closeSearch() : setSearchOpen(true))}
            >
              <SearchRounded />
            </IconButton>
          </Tooltip>
          <Tooltip title="Download loaded output">
            <span>
              <IconButton
                aria-label="Download loaded output"
                disabled={inaccessible || !output.items.length}
                onClick={download}
              >
                <DownloadRounded />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={following ? "Pause follow" : "Follow output"}>
            <IconButton
              aria-label={following ? "Pause follow" : "Follow output"}
              aria-pressed={following}
              onClick={() => (following ? setFollowing(false) : follow())}
            >
              {following ? <PauseRounded /> : <PlayArrowRounded />}
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
      <AgentRuntimeMetadata
        taskId={task.id}
        attemptId={attemptId}
        summary={summary}
        invocations={invocations}
        compact
        actions={
          selectedAttempt && (
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
              {historical && (
                <Button size="small" onClick={() => onAttemptChange("")}>
                  Latest attempt
                </Button>
              )}
              {onHistory && (
                <Button size="small" onClick={onHistory}>
                  History
                </Button>
              )}
            </Stack>
          )
        }
      />
      {searchVisible && (
        <Box
          className="task-output-search"
          sx={{ borderBottom: 1, borderColor: "divider" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeSearch();
            }
          }}
        >
          <TextField
            inputRef={searchInput}
            size="small"
            type="search"
            label="Find in loaded output"
            value={search}
            onChange={(event) => {
              updateView({ search: event.target.value });
              if (event.target.value) setFollowing(false);
            }}
            sx={{ flex: "1 1 180px" }}
            slotProps={{ htmlInput: { maxLength: 160 } }}
          />
          <TextField
            select
            size="small"
            label="Event type"
            value={filter}
            onChange={(event) => {
              updateView(normalizeTaskOutputView({ search, type: event.target.value }));
              setFollowing(false);
            }}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="all">All events</MenuItem>
            <MenuItem value="assistant">Messages</MenuItem>
            <MenuItem value="tool">Tools</MenuItem>
            <MenuItem value="system">Task events</MenuItem>
            <MenuItem value="gap">Gaps</MenuItem>
          </TextField>
          <IconButton aria-label="Close output search" onClick={closeSearch}>
            <CloseRounded />
          </IconButton>
        </Box>
      )}
      {gap && (
        <Alert severity="warning" sx={{ borderRadius: 0 }}>
          Some output is unavailable.{" "}
          {output.retentionGap ? "Earlier events are no longer retained. " : ""}
          {output.localGap ? "This view reached its display limit. " : ""}Search and download cover
          loaded output only.
        </Alert>
      )}
      {disconnected && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0 }}
          action={
            <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
              Reconnect
            </Button>
          }
        >
          Output disconnected. {active ? "The task may still be running. " : ""}
          {query.error?.message}
        </Alert>
      )}
      {inaccessible && (
        <Alert
          severity="error"
          sx={{ borderRadius: 0 }}
          action={<Button onClick={() => setDenied(false)}>Check access</Button>}
        >
          Output access is unavailable. Previously loaded output has been cleared.
        </Alert>
      )}
      {exportError && <Alert severity="error">{exportError}</Alert>}
      {status === "No recent output" && (
        <Alert severity="info" sx={{ borderRadius: 0 }}>
          No recent output. This alone does not confirm that the task has stopped.
        </Alert>
      )}
      <Box
        ref={viewport}
        className="task-output-viewport"
        role="log"
        aria-label="Task output events"
        aria-live="off"
        tabIndex={0}
        onScroll={() => {
          const el = viewport.current;
          if (el && following && el.scrollHeight - el.scrollTop - el.clientHeight > 48)
            setFollowing(false);
        }}
        onPointerUp={() => {
          if (window.getSelection()?.toString().trim()) setFollowing(false);
        }}
        onKeyUp={() => {
          if (window.getSelection()?.toString().trim()) setFollowing(false);
        }}
      >
        {shown.length > 0 ? (
          <Box component="ol" className="task-output-events">
            {shown.map((item) => (
              <OutputEventRow
                key={JSON.stringify([item.invocationId, item.kind, item.itemId])}
                item={item}
              />
            ))}
          </Box>
        ) : (
          <Box sx={{ px: 3, py: 7, textAlign: "center" }}>
            <Typography variant="subtitle1">
              {inaccessible
                ? "Output unavailable"
                : query.isPending && attemptId
                  ? "Connecting to output…"
                  : output.items.length
                    ? "No matching output"
                    : active || !attemptId
                      ? "Waiting for recorded output"
                      : "No output recorded for this attempt"}
            </Typography>
            {(search || filter !== "all") && (
              <Button
                sx={{ mt: 1 }}
                onClick={() => {
                  updateView({ search: "", type: "all" });
                }}
              >
                Clear filters
              </Button>
            )}
          </Box>
        )}
      </Box>
      <Box
        component="footer"
        className="task-output-footer"
        sx={{
          borderTop: 1,
          borderColor: "divider",
          bgcolor: following ? "transparent" : "action.hover",
        }}
      >
        <Typography variant="caption" color="text.secondary" role="status">
          {following
            ? `${shown.length} loaded ${shown.length === 1 ? "item" : "items"}${output.hasMore ? " · Loading history…" : ""}`
            : `Follow paused${output.eventCount > seenCount ? ` · ${output.eventCount - seenCount} new updates` : ""}`}
          {query.data
            ? ` · Last checked ${new Date(query.data.checkedAt).toLocaleTimeString()}`
            : ""}
        </Typography>
        <Stack direction="row" spacing={1}>
          {!following && (
            <Button size="small" onClick={follow}>
              Jump to latest
            </Button>
          )}
          <Button
            size="small"
            disabled={!attemptId || denied || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh output
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
