import type { JobAdmissionState } from "@agentic-review/contracts";
import { FilterList, Refresh, Search } from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  IconButton,
  InputAdornment,
  Link,
  MenuItem,
  Popover,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { JobDetailDrawer } from "@/components/JobDetails";
import {
  clearNotificationTargetParameters,
  notificationTargetPath,
  parseNotificationTarget,
} from "@/components/NotificationTarget/targets";
import { OperatorAccessGate } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { StatusTag } from "@/components/StatusTag";
import { type DataColumn, DataTable } from "@/components/ui";
import { type Job, reviewControl } from "@/services/review-control";
import { jobDisplayStatus } from "@/services/review-control/admission";
import { formatDuration } from "@/utils/format";
import "./index.css";

const statusOptions = [
  { value: "queued", label: "Waiting to start" },
  { value: "leased", label: "Leased" },
  { value: "running", label: "Running" },
  { value: "cancel_requested", label: "Cancel requested" },
  { value: "retry_waiting", label: "Retry waiting" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "stale", label: "Superseded" },
  { value: "dead_letter", label: "Retry limit reached" },
];
const stageOptions = [
  { value: "awaiting_admission", label: "Awaiting admission" },
  { value: "queued", label: "Queued" },
  { value: "leased", label: "Worker assigned" },
  { value: "preparing", label: "Preparing workspace" },
  { value: "cli_review", label: "CLI review" },
  { value: "validation", label: "Validating" },
  { value: "cli_revision", label: "CLI revision" },
  { value: "uploading", label: "Transferring results" },
  { value: "completing", label: "Saving result" },
  { value: "cancelling", label: "Stopping execution" },
  { value: "done", label: "Finished" },
];
const stageLabels = Object.fromEntries(stageOptions.map((option) => [option.value, option.label]));
const views: { id: string; label: string; statuses: string[]; admission?: JobAdmissionState }[] = [
  { id: "all", label: "All jobs", statuses: [] },
  { id: "active", label: "In progress", statuses: ["leased", "running", "cancel_requested"] },
  {
    id: "pending",
    label: "Awaiting admission",
    statuses: ["queued", "retry_waiting"],
    admission: "pending",
  },
  { id: "queued", label: "Queued", statuses: ["queued", "retry_waiting"], admission: "admitted" },
  { id: "succeeded", label: "Succeeded", statuses: ["succeeded"] },
  { id: "attention", label: "Needs attention", statuses: ["failed", "dead_letter"] },
];

function sameStatuses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((status) => right.includes(status));
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 13)}…` : id;
}

function CreatedTime({ value }: { value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="jobs-utility">Not recorded</span>;
  return (
    <time className="jobs-cell-stack" dateTime={value}>
      <span>
        {date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
      </span>
      <span className="jobs-utility">
        {date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
      </span>
    </time>
  );
}

export default function JobsPage() {
  const scope = useRepositoryScope();
  if (!scope.ready) return <RepositoryScopeUnavailable />;
  return (
    <ScopedJobsPage
      key={scope.key}
      repositoryId={scope.repositoryId}
      repositoryName={scope.label}
    />
  );
}

export function SelectedJobDetails({
  job,
  onClose,
}: {
  job: Pick<Job, "id" | "repositoryId"> | null;
  onClose: () => void;
}) {
  if (!job) return null;
  return (
    <OperatorAccessGate
      key={`${job.repositoryId}:${job.id}`}
      repositoryId={job.repositoryId}
      permission="read"
    >
      <JobDetailDrawer repositoryId={job.repositoryId} jobId={job.id} onClose={onClose} />
    </OperatorAccessGate>
  );
}

function ScopedJobsPage({
  repositoryId,
  repositoryName,
}: {
  repositoryId?: string;
  repositoryName: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const target = parseNotificationTarget(location.pathname, location.search);
  const selectedJob =
    target.kind === "target" &&
    target.target.kind === "job" &&
    target.target.repositoryId === repositoryId
      ? { id: target.target.jobId, repositoryId: target.target.repositoryId }
      : null;
  const closeTarget = () =>
    navigate({
      pathname: location.pathname,
      search: clearNotificationTargetParameters(location.search),
    });
  const requestGeneration = useRef(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [stages, setStages] = useState<string[]>([]);
  const [admission, setAdmission] = useState<JobAdmissionState>();
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  const refresh = useCallback(() => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    setTotal(null);
    void reviewControl
      .listJobs({
        page,
        pageSize,
        search: search || undefined,
        filters: {
          repositoryId,
          status: statuses.length ? statuses : undefined,
          stage: stages.length ? stages : undefined,
          admission,
        },
      })
      .then((response) => {
        if (generation !== requestGeneration.current) return;
        setRows(response.items);
        setTotal(response.total);
      })
      .catch((failure: unknown) => {
        if (generation !== requestGeneration.current) return;
        setRows([]);
        setError(failure instanceof Error ? failure.message : "The jobs request failed.");
      })
      .finally(() => {
        if (generation === requestGeneration.current) setLoading(false);
      });
  }, [page, pageSize, search, statuses, stages, admission, repositoryId]);

  useEffect(() => {
    refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);

  const activeView = views.find(
    (view) => sameStatuses(view.statuses, statuses) && view.admission === admission,
  )?.id;
  const filterCount = statuses.length + stages.length + (admission ? 1 : 0);
  const hasConstraints = search.length > 0 || filterCount > 0;
  const clearFilters = () => {
    setStatuses([]);
    setStages([]);
    setAdmission(undefined);
    setPage(1);
  };
  const clearAll = () => {
    clearFilters();
    setSearchInput("");
    setSearch("");
  };
  const openJob = (job: Job) =>
    navigate(
      notificationTargetPath({
        kind: "job",
        repositoryId: job.repositoryId,
        jobId: job.id,
      }),
    );
  const columns: DataColumn<Job>[] = [
    {
      id: "workItemRef",
      label: "Work item / job",
      minWidth: 256,
      render: (job) => (
        <div className="jobs-cell-stack">
          <Link
            component="button"
            type="button"
            underline="hover"
            variant="body1"
            className="jobs-work-item"
            onClick={() => openJob(job)}
            aria-label={`View details for ${job.workItemRef}, job ${job.id}`}
          >
            {job.workItemRef}
          </Link>
          <span className="jobs-utility jobs-job-identity">
            {job.title}
            <span aria-hidden="true"> · </span>
            <span className="jobs-code" title={job.id}>
              {shortId(job.id)}
            </span>
          </span>
        </div>
      ),
    },
    {
      id: "status",
      label: "Execution",
      minWidth: 176,
      render: (job) => (
        <div className="jobs-cell-stack">
          <StatusTag status={jobDisplayStatus(job.status, job.admission)} />
          <span className="jobs-utility">
            {job.status === "succeeded"
              ? "Result available"
              : job.status === "failed" || job.status === "dead_letter"
                ? "Inspect failure details"
                : job.admission?.state === "pending"
                  ? "Execution recorded; awaiting queue entry"
                  : job.status === "retry_waiting"
                    ? "Waiting for another attempt"
                    : job.stage === "queued"
                      ? "Waiting for a worker"
                      : (stageLabels[job.stage] ?? job.stage.replaceAll("_", " "))}
          </span>
        </div>
      ),
    },
    {
      id: "workerNodeId",
      label: "Worker",
      minWidth: 192,
      render: (job) => (
        <div className="jobs-cell-stack">
          <span className="jobs-worker" title={job.workerNodeId}>
            {job.workerNodeId ?? "Unassigned"}
          </span>
          <span className="jobs-utility">
            Attempt {job.attempt} / {job.maxAttempts}
          </span>
        </div>
      ),
    },
    {
      id: "elapsedSeconds",
      label: "Elapsed",
      width: 96,
      render: (job) => <span className="jobs-numeric">{formatDuration(job.elapsedSeconds)}</span>,
    },
    {
      id: "createdAt",
      label: "Created",
      minWidth: 140,
      render: (job) => <CreatedTime value={job.createdAt} />,
    },
  ];

  return (
    <div className="jobs-page">
      <PageHeader
        eyebrow={repositoryName}
        title="Jobs"
        description="Follow each execution from queue to result."
        actions={
          <Button variant="outlined" startIcon={<Refresh />} loading={loading} onClick={refresh}>
            Refresh
          </Button>
        }
      />
      <Box
        component="section"
        className="jobs-panel"
        role="region"
        aria-label="Job execution monitor"
      >
        <Tabs
          value={activeView ?? false}
          aria-label="Job status views"
          variant="scrollable"
          scrollButtons="auto"
          onChange={(_, value: string) => {
            const view = views.find((item) => item.id === value);
            if (!view) return;
            setStatuses([...view.statuses]);
            setAdmission(view.admission);
            setPage(1);
          }}
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          {views.map((view) => (
            <Tab key={view.id} value={view.id} label={view.label} />
          ))}
        </Tabs>
        <Box className="jobs-toolbar" sx={{ py: 3 }}>
          <Box
            component="form"
            className="jobs-search"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchInput.trim());
              setPage(1);
            }}
          >
            <TextField
              fullWidth
              label="Search jobs"
              placeholder="Search work item, job, or worker"
              value={searchInput}
              slotProps={{
                htmlInput: { "aria-label": "Search jobs", maxLength: 512 },
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton type="submit" aria-label="Submit job search">
                        <Search />
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
              onChange={(event) => {
                setSearchInput(event.target.value);
                if (event.target.value.length === 0) {
                  setSearch("");
                  setPage(1);
                }
              }}
            />
          </Box>
          <Button
            variant="outlined"
            startIcon={<FilterList />}
            aria-expanded={filterAnchor !== null}
            aria-controls={filterAnchor ? "jobs-filter-popover" : undefined}
            onClick={(event) => setFilterAnchor(event.currentTarget)}
          >
            Filters{filterCount > 0 ? ` (${filterCount})` : ""}
          </Button>
          {hasConstraints && <Button onClick={clearAll}>Reset</Button>}
        </Box>
        <Typography variant="body2" className="jobs-result-count" aria-live="polite" sx={{ mb: 2 }}>
          {loading
            ? "Loading jobs…"
            : error
              ? "Results unavailable"
              : total === null
                ? ""
                : `${total.toLocaleString("en-US")}${total === 1 ? " job" : " jobs"}`}
        </Typography>
        <Popover
          id="jobs-filter-popover"
          open={filterAnchor !== null}
          anchorEl={filterAnchor}
          onClose={() => setFilterAnchor(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        >
          <Stack className="jobs-filters" spacing={3} sx={{ p: 3 }}>
            <Typography component="h2" variant="subtitle1">
              Filter jobs
            </Typography>
            <TextField
              select
              label="Queue admission"
              value={admission ?? ""}
              helperText="Admission filters apply only to waiting jobs."
              slotProps={{ select: { inputProps: { "aria-label": "Filter jobs by admission" } } }}
              onChange={(event) => {
                setAdmission((event.target.value || undefined) as JobAdmissionState | undefined);
                setPage(1);
              }}
            >
              <MenuItem value="">Any admission state</MenuItem>
              <MenuItem value="pending">Awaiting admission</MenuItem>
              <MenuItem value="admitted">Queued</MenuItem>
            </TextField>
            <Autocomplete
              multiple
              options={statusOptions}
              value={statusOptions.filter((option) => statuses.includes(option.value))}
              onChange={(_, selected) => {
                setStatuses(selected.map((option) => option.value));
                setPage(1);
              }}
              getOptionLabel={(option) => option.label}
              renderInput={(params) => (
                <TextField {...params} label="Status" placeholder="Any status" />
              )}
            />
            <Autocomplete
              multiple
              options={stageOptions}
              value={stageOptions.filter((option) => stages.includes(option.value))}
              onChange={(_, selected) => {
                setStages(selected.map((option) => option.value));
                setPage(1);
              }}
              getOptionLabel={(option) => option.label}
              renderInput={(params) => (
                <TextField {...params} label="Stage" placeholder="Any stage" />
              )}
            />
            <Stack direction="row" sx={{ justifyContent: "space-between" }}>
              <Button disabled={filterCount === 0} onClick={clearFilters}>
                Clear filters
              </Button>
              <Button variant="contained" onClick={() => setFilterAnchor(null)}>
                Done
              </Button>
            </Stack>
          </Stack>
        </Popover>
        {error && (
          <Alert
            severity="error"
            sx={{ mb: 2 }}
            action={
              <Button loading={loading} onClick={refresh}>
                Try again
              </Button>
            }
          >
            <AlertTitle>Unable to load jobs</AlertTitle>
            {error}
          </Alert>
        )}
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(job) => job.id}
          loading={loading}
          ariaLabel="Job executions"
          emptyTitle={
            error
              ? "Job results could not be retrieved."
              : hasConstraints
                ? "No jobs match this view."
                : "No jobs have been scheduled yet."
          }
          emptyDescription={
            !error && hasConstraints
              ? "Adjust the search or filters to find an execution."
              : undefined
          }
          pagination={{
            page,
            pageSize,
            pageSizeOptions: [20, 50, 100],
            total: total ?? 0,
            onChange: (nextPage, nextPageSize) => {
              setPage(nextPageSize === pageSize ? nextPage : 1);
              setPageSize(nextPageSize);
            },
          }}
        />
        {!loading && !error && rows.length === 0 && hasConstraints && (
          <Box sx={{ pb: 2, textAlign: "center" }}>
            <Button onClick={clearAll}>Clear search and filters</Button>
          </Box>
        )}
      </Box>
      {target.kind === "invalid" ? (
        <Alert severity="error" action={<Button onClick={closeTarget}>Clear target</Button>}>
          <AlertTitle>Invalid job target</AlertTitle>
          {target.message}
        </Alert>
      ) : (
        <SelectedJobDetails job={selectedJob} onClose={closeTarget} />
      )}
    </div>
  );
}
