import type { JobAdmissionState } from "@agentic-review/contracts";
import { FilterOutlined, ReloadOutlined } from "@ant-design/icons";
import { type ActionType, type ProColumns, ProTable } from "@ant-design/pro-components";
import { useLocation, useNavigate } from "@umijs/max";
import { Alert, Button, Card, Empty, Input, Popover, Radio, Select } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  { value: "codex_review", label: "Reviewing" },
  { value: "validation", label: "Validating" },
  { value: "codex_revision", label: "Revising" },
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

interface JobsParameters {
  current?: number;
  pageSize?: number;
  search?: string;
  statuses?: string[];
  stages?: string[];
  repositoryId?: string;
  admission?: JobAdmissionState;
}

interface JobsTableResult {
  data: Job[];
  success: boolean;
  total: number;
}

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
  const actionRef = useRef<ActionType>(null);
  const requestGeneration = useRef(0);
  const latestRequest = useRef<Promise<JobsTableResult> | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [stages, setStages] = useState<string[]>([]);
  const [admission, setAdmission] = useState<JobAdmissionState>();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      requestGeneration.current += 1;
      latestRequest.current = null;
    };
  }, []);

  const parameters = useMemo(
    () => ({ search, statuses, stages, admission, repositoryId }),
    [search, statuses, stages, admission, repositoryId],
  );
  const activeView = views.find(
    (view) => sameStatuses(view.statuses, statuses) && view.admission === admission,
  )?.id;
  const filterCount = statuses.length + stages.length + (admission ? 1 : 0);
  const hasConstraints = search.length > 0 || filterCount > 0;

  const resetPage = () => {
    actionRef.current?.setPageInfo?.({ current: 1 });
  };

  const requestJobs = useCallback((params: JobsParameters): Promise<JobsTableResult> => {
    const generation = ++requestGeneration.current;
    setError(null);
    setTotal(null);
    const pending = (async (): Promise<JobsTableResult> => {
      try {
        const response = await reviewControl.listJobs({
          page: params.current ?? 1,
          pageSize: params.pageSize ?? 20,
          search: params.search || undefined,
          filters: {
            repositoryId: params.repositoryId,
            status: params.statuses?.length ? params.statuses : undefined,
            stage: params.stages?.length ? params.stages : undefined,
            admission: params.admission,
          },
        });
        if (generation !== requestGeneration.current) {
          return latestRequest.current ?? { data: [], success: false, total: 0 };
        }
        setTotal(response.total);
        return { data: response.items, success: true, total: response.total };
      } catch (failure) {
        if (generation !== requestGeneration.current) {
          return latestRequest.current ?? { data: [], success: false, total: 0 };
        }
        setError(failure instanceof Error ? failure.message : "The jobs request failed.");
        setTotal(null);
        // Clear prior rows on failure; the explicit error state replaces result counts.
        return { data: [], success: true, total: 0 };
      }
    })();
    // Older responses resolve to the newest request, so slow pages cannot replace a newer view.
    latestRequest.current = pending;
    return pending;
  }, []);

  const clearFilters = () => {
    setStatuses([]);
    setStages([]);
    setAdmission(undefined);
    resetPage();
  };

  const clearAll = () => {
    clearFilters();
    setSearchInput("");
    setSearch("");
  };

  const columns: ProColumns<Job>[] = [
    {
      title: "Work item / job",
      dataIndex: "workItemRef",
      width: 256,
      render: (_, job) => (
        <div className="jobs-cell-stack">
          <span className="jobs-work-item">{job.workItemRef}</span>
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
      title: "Execution",
      dataIndex: "status",
      width: 168,
      render: (_, job) => (
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
      title: "Worker",
      dataIndex: "workerNodeId",
      width: 192,
      render: (_, job) => (
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
      title: "Elapsed",
      dataIndex: "elapsedSeconds",
      width: 88,
      render: (_, job) => (
        <span className="jobs-numeric">{formatDuration(job.elapsedSeconds)}</span>
      ),
    },
    {
      title: "Created",
      dataIndex: "createdAt",
      width: 136,
      render: (_, job) => <CreatedTime value={job.createdAt} />,
    },
    {
      title: "",
      key: "details",
      width: 80,
      fixed: "right",
      render: (_, job) => (
        <Button
          className="jobs-details-button"
          type="link"
          size="small"
          onClick={() =>
            navigate(
              notificationTargetPath({
                kind: "job",
                repositoryId: job.repositoryId,
                jobId: job.id,
              }),
            )
          }
          aria-label={`View details for ${job.workItemRef}, job ${job.id}`}
        >
          Details
        </Button>
      ),
    },
  ];

  const filters = (
    <div className="jobs-filters">
      <div className="jobs-filter-field">
        <label htmlFor="jobs-admission-filter">Queue admission</label>
        <Select
          id="jobs-admission-filter"
          aria-label="Filter jobs by admission"
          allowClear
          placeholder="Any admission state"
          value={admission}
          options={[
            { value: "pending", label: "Awaiting admission" },
            { value: "admitted", label: "Queued" },
          ]}
          onChange={(value: JobAdmissionState | undefined) => {
            setAdmission(value);
            resetPage();
          }}
        />
        <span className="jobs-utility">Admission filters apply only to waiting jobs.</span>
      </div>
      <div className="jobs-filter-field">
        <label htmlFor="jobs-status-filter">Status</label>
        <Select
          id="jobs-status-filter"
          aria-label="Filter jobs by status"
          mode="multiple"
          allowClear
          placeholder="Any status"
          options={statusOptions}
          value={statuses}
          onChange={(value: string[]) => {
            setStatuses(value);
            resetPage();
          }}
          maxTagCount="responsive"
        />
      </div>
      <div className="jobs-filter-field">
        <label htmlFor="jobs-stage-filter">Stage</label>
        <Select
          id="jobs-stage-filter"
          aria-label="Filter jobs by stage"
          mode="multiple"
          allowClear
          placeholder="Any stage"
          options={stageOptions}
          value={stages}
          onChange={(value: string[]) => {
            setStages(value);
            resetPage();
          }}
          maxTagCount="responsive"
        />
      </div>
      <div className="jobs-filter-actions">
        <Button type="text" disabled={filterCount === 0} onClick={clearFilters}>
          Clear filters
        </Button>
        <Button onClick={() => setFiltersOpen(false)}>Done</Button>
      </div>
    </div>
  );

  return (
    <div className="jobs-page">
      <PageHeader
        eyebrow={repositoryName}
        title="Jobs"
        description="Follow each execution from queue to result."
        actions={
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void actionRef.current?.reload()}
          >
            Refresh
          </Button>
        }
      />

      <Card className="jobs-panel" role="region" aria-label="Job execution monitor">
        <div className="jobs-views">
          <Radio.Group
            role="radiogroup"
            aria-label="Job status views"
            optionType="button"
            value={activeView ?? "custom"}
            options={views.map((view) => ({ value: view.id, label: view.label }))}
            onChange={(event) => {
              const view = views.find((item) => item.id === event.target.value);
              if (view) {
                setStatuses([...view.statuses]);
                setAdmission(view.admission);
                resetPage();
              }
            }}
          />
        </div>

        <div className="jobs-toolbar">
          <Input.Search
            className="jobs-search"
            aria-label="Search jobs"
            placeholder="Search work item, job, or worker"
            allowClear
            maxLength={512}
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              if (event.target.value.length === 0) {
                setSearch("");
                resetPage();
              }
            }}
            onSearch={(value) => {
              setSearch(value.trim());
              resetPage();
            }}
          />
          <Popover
            content={filters}
            trigger="click"
            placement="bottomLeft"
            open={filtersOpen}
            onOpenChange={setFiltersOpen}
          >
            <Button icon={<FilterOutlined />} aria-expanded={filtersOpen}>
              Filters{filterCount > 0 ? ` (${filterCount})` : ""}
            </Button>
          </Popover>
          {hasConstraints && (
            <Button className="jobs-reset" type="text" onClick={clearAll}>
              Reset
            </Button>
          )}
          <span className="jobs-result-count" aria-live="polite">
            {loading
              ? "Loading jobs…"
              : error
                ? "Results unavailable"
                : total === null
                  ? ""
                  : `${total.toLocaleString("en-US")} ${total === 1 ? "job" : "jobs"}`}
          </span>
        </div>

        {error && (
          <Alert
            className="jobs-error"
            type="error"
            showIcon
            title="Unable to load jobs"
            description={error}
            action={
              <Button
                size="small"
                loading={loading}
                onClick={() => void actionRef.current?.reload()}
              >
                Try again
              </Button>
            }
          />
        )}

        <ProTable<Job, JobsParameters>
          actionRef={actionRef}
          className="operational-table jobs-table"
          cardProps={false}
          columns={columns}
          rowKey="id"
          request={requestJobs}
          params={parameters}
          onLoadingChange={(value) =>
            setLoading(
              value === true ||
                (typeof value === "object" && value !== null && value.spinning !== false),
            )
          }
          search={false}
          options={false}
          toolBarRender={false}
          tableAlertRender={false}
          size="middle"
          scroll={{ x: 920 }}
          tableLayout="fixed"
          pagination={{
            defaultPageSize: 20,
            hideOnSinglePage: true,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (count, range) => (error ? "" : `${range[0]}–${range[1]} of ${count}`),
          }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  error
                    ? "Job results could not be retrieved."
                    : hasConstraints
                      ? "No jobs match this view. Adjust the search or filters."
                      : "No jobs have been scheduled yet."
                }
              >
                {!error && hasConstraints && (
                  <Button onClick={clearAll}>Clear search and filters</Button>
                )}
              </Empty>
            ),
          }}
        />
      </Card>

      {target.kind === "invalid" ? (
        <Alert
          type="error"
          showIcon
          title="Invalid job target"
          description={target.message}
          action={<Button onClick={closeTarget}>Clear target</Button>}
        />
      ) : (
        <SelectedJobDetails job={selectedJob} onClose={closeTarget} />
      )}
    </div>
  );
}
