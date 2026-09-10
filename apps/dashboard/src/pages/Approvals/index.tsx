import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import DensitySmallIcon from "@mui/icons-material/DensitySmall";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import RefreshIcon from "@mui/icons-material/Refresh";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  MenuItem,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { StatusTag } from "@/components/StatusTag";
import { ConfirmDialog, type DataColumn, DataTable, notify } from "@/components/ui";
import { type Approval, reviewControl } from "@/services/review-control";
import { useOperatorSession } from "@/state/session";
import { shortSha } from "@/utils/format";
import { asSearchValue } from "@/utils/table";

const defaultFilters = { search: "", kind: "", risk: "", status: "" };
const columnsStorageKey = "agentic-review:approvals:columns:v1";
function initialColumns(): Record<string, boolean> {
  const defaults = { decidedBy: false, targetSha: false };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(columnsStorageKey) ?? "null");
    if (!saved || typeof saved !== "object") return defaults;
    const visible: Record<string, boolean> = { ...defaults };
    for (const [key, value] of Object.entries(saved)) {
      if (value && typeof value === "object" && "show" in value && typeof value.show === "boolean")
        visible[key] = value.show;
    }
    return visible;
  } catch {
    return defaults;
  }
}
function ApprovalInbox({ session }: { session: string }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(defaultFilters);
  const [filters, setFilters] = useState(defaultFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [visibleColumns, setVisibleColumns] = useState(initialColumns);
  const [columnAnchor, setColumnAnchor] = useState<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [intent, setIntent] = useState<{
    approval: Approval;
    decision: "approve" | "reject";
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        columnsStorageKey,
        JSON.stringify(
          Object.fromEntries(Object.entries(visibleColumns).map(([key, show]) => [key, { show }])),
        ),
      );
    } catch {
      /* Column visibility still works when browser storage is unavailable. */
    }
  }, [visibleColumns]);
  const queryRoot = ["approval-inbox", session];
  const query = useQuery({
    queryKey: [...queryRoot, page, pageSize, filters],
    queryFn: () =>
      reviewControl.listApprovals({
        page,
        pageSize,
        search: asSearchValue(filters.search),
        filters: {
          kind: filters.kind || undefined,
          risk: filters.risk || undefined,
          status: filters.status || undefined,
        },
      }),
    retry: false,
  });
  const begin = (approval: Approval, decision: "approve" | "reject") => {
    if (approval.status !== "pending" || inFlight.current) return;
    setFailure(null);
    setIntent({ approval: structuredClone(approval), decision });
  };
  const submit = async () => {
    if (intent?.approval.status !== "pending" || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      await reviewControl.decideApproval(intent.approval.id, { decision: intent.decision });
      if (!mounted.current) return;
      notify(intent.decision === "approve" ? "Request approved." : "Request rejected.");
      setIntent(null);
      await client.invalidateQueries({ queryKey: queryRoot });
    } catch (error) {
      if (mounted.current)
        setFailure(error instanceof Error ? error.message : "The decision could not be recorded.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const columns: DataColumn<Approval>[] = [
    {
      id: "workItemRef",
      label: "Work item",
      minWidth: 164,
      render: (entry) => (
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {entry.workItemRef}
        </Typography>
      ),
    },
    { id: "summary", label: "Request", minWidth: 300, render: (entry) => entry.summary },
    {
      id: "kind",
      label: "Kind",
      render: (entry) => (
        <Chip
          size="medium"
          color={entry.kind === "validation" ? "secondary" : "primary"}
          label={entry.kind === "validation" ? "Validation" : "Publication"}
        />
      ),
    },
    {
      id: "risk",
      label: "Risk",
      render: (entry) => (
        <Chip
          size="medium"
          color={entry.risk === "low" ? "success" : entry.risk === "medium" ? "warning" : "error"}
          label={entry.risk.charAt(0).toUpperCase() + entry.risk.slice(1)}
        />
      ),
    },
    {
      id: "targetSha",
      label: "Target",
      render: (entry) => <code>{shortSha(entry.targetSha)}</code>,
    },
    { id: "status", label: "Status", render: (entry) => <StatusTag status={entry.status} /> },
    {
      id: "requestedAt",
      label: "Requested",
      minWidth: 168,
      render: (entry) => (
        <time dateTime={entry.requestedAt}>{new Date(entry.requestedAt).toLocaleString()}</time>
      ),
    },
    { id: "decidedBy", label: "Decision", render: (entry) => entry.decidedBy ?? "Pending" },
    {
      id: "actions",
      label: "Actions",
      render: (entry) => (
        <Stack direction="row">
          <Tooltip title="Approve">
            <span>
              <IconButton
                aria-label={`Approve ${entry.id}`}
                color="success"
                disabled={entry.status !== "pending" || saving}
                onClick={() => begin(entry, "approve")}
              >
                <CheckCircleOutlinedIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Reject">
            <span>
              <IconButton
                aria-label={`Reject ${entry.id}`}
                color="error"
                disabled={entry.status !== "pending" || saving}
                onClick={() => begin(entry, "reject")}
              >
                <HighlightOffIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      ),
    },
  ];
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement === surface.current) await document.exitFullscreen();
      else await surface.current?.requestFullscreen();
    } catch {
      notify("Fullscreen is unavailable in this browser.", "warning");
    }
  };
  return (
    <Stack spacing={3}>
      <PageHeader
        eyebrow="Review gates"
        title="Approvals"
        description="Validation and publication gates"
      />
      <Card variant="elevation" elevation={0} ref={surface} sx={{ overflow: "auto" }}>
        <CardHeader
          sx={{ flexWrap: "wrap", gap: 1, "& .MuiCardHeader-action": { m: 0 } }}
          title="Decision inbox"
          action={
            <Stack direction="row">
              <Tooltip title="Refresh approvals">
                <span>
                  <IconButton
                    aria-label="Refresh approvals"
                    disabled={query.isFetching}
                    onClick={() => void query.refetch()}
                  >
                    <RefreshIcon />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Table density">
                <IconButton
                  aria-label="Toggle table density"
                  aria-pressed={compact}
                  onClick={() => setCompact(!compact)}
                >
                  <DensitySmallIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Columns">
                <IconButton
                  aria-label="Choose columns"
                  onClick={(event) => setColumnAnchor(event.currentTarget)}
                >
                  <ViewColumnIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Fullscreen">
                <IconButton aria-label="Toggle fullscreen" onClick={() => void fullscreen()}>
                  <FullscreenIcon />
                </IconButton>
              </Tooltip>
            </Stack>
          }
        />
        <CardContent sx={{ pt: 0 }}>
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault();
              setFilters({ ...draft });
              setPage(1);
            }}
            sx={{ mb: 3 }}
          >
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={2}
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: { xs: "stretch", md: "center" } }}
            >
              <TextField
                label="Search"
                placeholder="Work item or summary"
                value={draft.search}
                onChange={(event) => setDraft({ ...draft, search: event.target.value })}
                sx={{ flex: 1, minWidth: 200 }}
              />
              <TextField
                select
                label="Kind"
                value={draft.kind}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
                sx={{ minWidth: 150 }}
              >
                <MenuItem value="">All kinds</MenuItem>
                <MenuItem value="validation">Validation</MenuItem>
                <MenuItem value="publication">Publication</MenuItem>
              </TextField>
              <TextField
                select
                label="Risk"
                value={draft.risk}
                onChange={(event) => setDraft({ ...draft, risk: event.target.value })}
                sx={{ minWidth: 120 }}
              >
                <MenuItem value="">All risks</MenuItem>
                <MenuItem value="low">Low</MenuItem>
                <MenuItem value="medium">Medium</MenuItem>
                <MenuItem value="high">High</MenuItem>
              </TextField>
              <TextField
                select
                label="Status"
                value={draft.status}
                onChange={(event) => setDraft({ ...draft, status: event.target.value })}
                sx={{ minWidth: 150 }}
              >
                <MenuItem value="">All statuses</MenuItem>
                {["pending", "approved", "rejected", "expired"].map((status) => (
                  <MenuItem key={status} value={status}>
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </MenuItem>
                ))}
              </TextField>
              <Button type="submit" variant="contained">
                Search
              </Button>
              <Button
                onClick={() => {
                  setDraft(defaultFilters);
                  setFilters(defaultFilters);
                  setPage(1);
                }}
              >
                Reset
              </Button>
            </Stack>
          </Box>
          {query.isError ? (
            <Alert severity="error">
              <AlertTitle>Could not load approvals</AlertTitle>
              {query.error instanceof Error
                ? query.error.message
                : "Try refreshing the decision inbox."}
            </Alert>
          ) : (
            <Box sx={{ "& .MuiTableCell-root": { py: compact ? 1 : 2 } }}>
              <DataTable
                ariaLabel="Decision inbox"
                rows={query.data?.items ?? []}
                columns={columns.filter((column) => visibleColumns[column.id] !== false)}
                getRowId={(entry) => entry.id}
                loading={query.isLoading}
                emptyTitle="No approval requests match these filters."
                pagination={{
                  page,
                  pageSize,
                  pageSizeOptions: [10, 20, 50, 100],
                  total: query.data?.total ?? 0,
                  onChange: (value, size) => {
                    setPage(size === pageSize ? value : 1);
                    setPageSize(size);
                  },
                }}
              />
            </Box>
          )}
        </CardContent>
      </Card>
      <Popover
        open={Boolean(columnAnchor)}
        anchorEl={columnAnchor}
        onClose={() => setColumnAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Stack sx={{ p: 2 }}>
          <Typography variant="subtitle2">Visible columns</Typography>
          {columns.map((column) => (
            <FormControlLabel
              key={column.id}
              label={column.label}
              control={
                <Checkbox
                  checked={visibleColumns[column.id] !== false}
                  onChange={(_event, checked) =>
                    setVisibleColumns({ ...visibleColumns, [column.id]: checked })
                  }
                />
              }
            />
          ))}
        </Stack>
      </Popover>
      <ConfirmDialog
        open={intent !== null}
        title={intent?.decision === "approve" ? "Approve this request?" : "Reject this request?"}
        confirmLabel={intent?.decision === "approve" ? "Approve" : "Reject"}
        destructive={intent?.decision === "reject"}
        loading={saving}
        onClose={() => {
          if (!inFlight.current && !saving) {
            setIntent(null);
            setFailure(null);
          }
        }}
        onConfirm={() => void submit()}
      >
        {intent && (
          <Stack spacing={1}>
            <Typography>{intent.approval.workItemRef}</Typography>
            <Typography color="text.secondary">{intent.approval.summary}</Typography>
            <Typography component="code">Target: {shortSha(intent.approval.targetSha)}</Typography>
            {failure && <Alert severity="error">{failure}</Alert>}
          </Stack>
        )}
      </ConfirmDialog>
    </Stack>
  );
}
export default function ApprovalsPage() {
  const { initialState } = useOperatorSession();
  const session = JSON.stringify([initialState?.sessionEpoch, initialState?.authenticationEpoch]);
  return <ApprovalInbox key={session} session={session} />;
}
