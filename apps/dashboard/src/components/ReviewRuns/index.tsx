import type {
  DashboardReviewRunDetail,
  DashboardReviewRunJob,
  DashboardReviewRunRequest,
  DashboardReviewRunSummary,
} from "@agentic-review/contracts";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { JobAdmission } from "@/components/JobAdmission";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { DataTable, EmptyState } from "@/components/ui";
import { runs } from "@/services/runs";
import { reviewPermissionUnavailableReason } from "./actions";
import { CopyValue, ErrorNotice, Facts, Prose, readable, timestamp } from "./common";
import { EvidenceView } from "./EvidenceView";
import {
  createEvidencePollingController,
  evidencePollingViewVisible,
  reproductionRefreshInterval,
  requestEvidencePending,
} from "./evidence-verification";
import { loadNotificationJob, type ReviewRunWorkItem } from "./navigation";
import { executionLabel, requestTargetLabel, runBelongsToWorkItem } from "./presentation";
import { ReportView } from "./ReportView";
import { RunDetails, TestedSource } from "./RunDetails";

interface SelectedJob {
  requestId: string;
  job: DashboardReviewRunJob;
}

function executionSummary(execution: DashboardReviewRunSummary["execution"]): string {
  return [
    `${execution.queued} queued`,
    `${execution.awaitingAdmission} awaiting admission`,
    `${execution.active} active`,
    `${execution.succeeded} completed`,
    `${execution.failed} failed`,
    `${execution.cancelled} cancelled`,
    `${execution.missing} unscheduled`,
  ].join(" · ");
}

function JobResult({ run, selection }: { run: DashboardReviewRunDetail; selection: SelectedJob }) {
  const queryClient = useQueryClient();
  const verificationPolling = useRef(createEvidencePollingController()).current;
  const request = run.requests.find((candidate) => candidate.requestId === selection.requestId);
  const job = request?.latestJob?.jobId === selection.job.jobId ? request.latestJob : selection.job;
  const result = useQuery({
    queryKey: [
      "review-runs",
      run.repositoryId,
      run.workItemId,
      run.id,
      selection.requestId,
      job.jobId,
      "result",
      // Completion discovered by the run's existing execution polling starts a fresh report read.
      job.resultId,
    ],
    enabled: request !== undefined,
    retry: false,
    refetchOnMount: "always",
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const pending = query.state.data?.evidenceVerificationPending === true;
      const visible = evidencePollingViewVisible();
      const hasError = query.state.status === "error";
      const verificationInterval = verificationPolling.next({
        scope: `${run.id}:${selection.requestId}:${job.jobId}`,
        pending,
        completedReads: query.state.dataUpdateCount,
        visible,
        hasError,
      });
      return reproductionRefreshInterval({
        verificationInterval,
        mapped: query.state.data?.reproduction !== undefined,
        pending,
        visible,
        hasError,
      });
    },
    queryFn: async () => {
      const response = await runs.getResult(
        run.repositoryId,
        run.id,
        selection.requestId,
        job.jobId,
      );
      if (
        response &&
        (response.repositoryId !== run.repositoryId ||
          response.workItemId !== run.workItemId ||
          response.reviewRunId !== run.id ||
          response.requestId !== selection.requestId ||
          response.jobId !== job.jobId ||
          response.report.workItemKind !== run.workItemKind ||
          response.revisionKey !== run.revisionKey ||
          response.planDigest !== run.planDigest)
      ) {
        throw new Error(
          "The result does not match the selected work item, run, and job. Refresh the run before continuing.",
        );
      }
      return response;
    },
  });
  const resultId = result.data?.id;
  const verificationPending = result.data?.evidenceVerificationPending === true;
  const verificationSnapshot = resultId
    ? `${resultId}:${verificationPending ? "pending" : "settled"}`
    : null;
  const latestJobId = request?.latestJob?.jobId;
  useEffect(() => {
    if (!verificationSnapshot || latestJobId !== job.jobId || !evidencePollingViewVisible()) return;
    // A selected report can warm the evidence proof after the run overview was read.
    // Refresh its policy when verification changes without replacing any runner outcome.
    void queryClient.invalidateQueries({
      queryKey: ["review-runs", run.repositoryId, run.workItemId, run.id, "detail"],
      exact: true,
    });
  }, [
    queryClient,
    run.repositoryId,
    run.workItemId,
    run.id,
    latestJobId,
    job.jobId,
    verificationSnapshot,
  ]);
  const refreshResult = () => {
    verificationPolling.reset();
    void result.refetch();
  };
  if (!request) {
    return (
      <Alert severity="error">
        <AlertTitle>The selected request is unavailable in this run</AlertTitle>Select a request
        from Run details to inspect its jobs.
      </Alert>
    );
  }
  return (
    <Stack spacing={3} sx={{ width: "100%" }}>
      <Stack
        direction="row"
        spacing={2}
        useFlexGap
        sx={{ flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}
      >
        <Typography variant="h6">
          {requestTargetLabel(request.workflowKind, request.target)} · Activation{" "}
          {job.activationNumber}
        </Typography>
        <Button loading={result.isFetching} onClick={refreshResult}>
          Refresh result
        </Button>
      </Stack>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <Chip label={executionLabel(job.status, job.admission)} />
        <Typography variant="body2" color="text.secondary">
          {job.phase ? readable(job.phase) : "No active phase"}
        </Typography>
      </Stack>
      <Accordion
        disableGutters
        elevation={0}
        sx={{ bgcolor: "transparent", border: 0, borderBottom: 1, borderColor: "divider" }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1" component="span">
            Execution and source details
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={3}>
            <Facts
              items={[
                { label: "Job ID", value: <CopyValue value={job.jobId} /> },
                { label: "Execution status", value: executionLabel(job.status, job.admission) },
                { label: "Phase", value: job.phase ? readable(job.phase) : "No active phase" },
                { label: "Required request", value: request.required ? "Required" : "Optional" },
                {
                  label: "Profile",
                  value: request.profile
                    ? `${request.profile.name} · Version ${request.profile.version}`
                    : "Missing profile snapshot",
                },
                {
                  label: "Prompt version",
                  value: request.prompt?.version ?? "Missing prompt snapshot",
                },
              ]}
            />
            <TestedSource run={run} />
          </Stack>
        </AccordionDetails>
      </Accordion>
      <JobAdmission admission={job.admission} />
      {(job.failureCode || job.failureMessage) && (
        <Alert severity="error">
          <AlertTitle>{job.failureCode ?? "Execution failure"}</AlertTitle>
          <Prose>{job.failureMessage ?? "No failure message was recorded."}</Prose>
        </Alert>
      )}
      {result.isError ? (
        <ErrorNotice
          title="Could not load this job result"
          error={result.error}
          retry={refreshResult}
        />
      ) : result.isPending ? (
        <Skeleton variant="rounded" height={180} />
      ) : result.data ? (
        <ReportView result={result.data} />
      ) : (
        <>
          <Alert severity="info">
            <AlertTitle>No saved report for this job</AlertTitle>Validation outcomes, evidence, and
            a model recommendation have not been recorded for this job. Its execution status does
            not establish policy eligibility. Refresh this result after execution completes.
          </Alert>
          {job.runAttemptId && request.profile && (
            <EvidenceView
              scope={{
                repositoryId: run.repositoryId,
                runId: run.id,
                jobId: job.jobId,
                runAttemptId: job.runAttemptId,
                requestId: request.requestId,
                profileVersionId: request.profile.id,
                revisionKey: run.revisionKey,
                planDigest: run.planDigest,
              }}
            />
          )}
        </>
      )}
    </Stack>
  );
}

interface ReviewRunsPanelProps {
  workItem: ReviewRunWorkItem;
  initialRunId?: string;
  initialRequestId?: string;
  initialJobId?: string;
  embedded?: boolean;
}

export function ReviewRunsPanel(props: ReviewRunsPanelProps) {
  return (
    <OperatorAccessGate repositoryId={props.workItem.repositoryId} permission="read">
      <ReviewRunsPanelContent
        key={`${props.workItem.repositoryId}:${props.workItem.id}:${props.initialRunId ?? "history"}:${props.initialRequestId ?? ""}:${props.initialJobId ?? ""}`}
        {...props}
      />
    </OperatorAccessGate>
  );
}

function ReviewRunsPanelContent({
  workItem,
  initialRunId,
  initialRequestId,
  initialJobId,
  embedded = false,
}: ReviewRunsPanelProps) {
  const viewId = useId();
  const access = useOperatorAccess(workItem.repositoryId);
  const canRead = access.can("read");
  const [activeTab, setActiveTab] = useState(
    initialJobId ? "result" : initialRunId ? "detail" : "history",
  );
  const [notificationJobSelected, setNotificationJobSelected] = useState(
    initialRunId !== undefined && initialRequestId !== undefined && initialJobId !== undefined,
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(
    initialRequestId ?? null,
  );
  const [selectedJob, setSelectedJob] = useState<SelectedJob | null>(null);
  const verificationPolling = useRef(createEvidencePollingController()).current;
  const validScope = Boolean(workItem.repositoryId && workItem.id);
  const history = useQuery({
    queryKey: ["review-runs", workItem.repositoryId, workItem.id, "history", page, pageSize],
    enabled: canRead && validScope && activeTab === "history",
    retry: false,
    refetchOnMount: "always",
    queryFn: async () => {
      const response = await runs.list(workItem.repositoryId, {
        workItemId: workItem.id,
        page,
        pageSize,
      });
      if (
        response.items.some(
          (run) => !runBelongsToWorkItem(run, workItem) || run.workItemKind !== workItem.kind,
        )
      ) {
        throw new Error(
          "The run history contains a different repository or work item. No run history will be shown until the scope is corrected.",
        );
      }
      return response;
    },
  });
  const detail = useQuery({
    queryKey: ["review-runs", workItem.repositoryId, workItem.id, selectedRunId, "detail"],
    enabled: canRead && validScope && selectedRunId !== null && activeTab !== "history",
    retry: false,
    refetchOnMount: "always",
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const current = query.state.data;
      const visible = evidencePollingViewVisible();
      if (
        current &&
        (current.execution.active > 0 ||
          current.execution.queued > 0 ||
          current.execution.awaitingAdmission > 0 ||
          current.execution.missing > 0)
      ) {
        verificationPolling.reset();
        return visible && query.state.status !== "error" && activeTab !== "history" ? 5_000 : false;
      }
      const pending = current?.requests.some(requestEvidencePending) === true;
      const hasError = query.state.status === "error";
      const verificationInterval = verificationPolling.next({
        scope: selectedRunId ?? "",
        pending,
        completedReads: query.state.dataUpdateCount,
        visible: visible && activeTab === "detail",
        hasError,
      });
      return reproductionRefreshInterval({
        verificationInterval,
        mapped: current?.reproduction !== undefined,
        pending,
        visible: visible && activeTab !== "history",
        hasError,
      });
    },
    queryFn: async () => {
      if (!selectedRunId) throw new Error("Select a run first.");
      const response = await runs.get(workItem.repositoryId, selectedRunId);
      if (
        !runBelongsToWorkItem(response, workItem) ||
        response.id !== selectedRunId ||
        response.workItemKind !== workItem.kind
      ) {
        throw new Error(
          "The selected run does not belong to this repository and work item. Select a run from this work item's history.",
        );
      }
      return response;
    },
  });
  const refreshDetail = () => {
    if (!canRead) return;
    verificationPolling.reset();
    void detail.refetch();
  };
  // A verified scope may retain its selected run while access is being checked. It cannot
  // start reads then, but retaining this identity keeps an uncertain publication mounted.
  const retainRun = canRead || (access.ready && access.checking);
  const run = detail.isError || !retainRun ? undefined : detail.data;
  const notificationJob = useQuery({
    queryKey: [
      "review-runs",
      workItem.repositoryId,
      workItem.id,
      initialRunId,
      initialRequestId,
      initialJobId,
      "notification-job",
    ],
    enabled:
      canRead &&
      notificationJobSelected &&
      run !== undefined &&
      selectedRunId === initialRunId &&
      activeTab !== "history",
    retry: false,
    refetchOnMount: "always",
    queryFn: () => {
      if (!run || !initialRequestId || !initialJobId || run.id !== initialRunId)
        throw new Error("The notification does not identify a job in the selected run.");
      return loadNotificationJob(runs, run, { requestId: initialRequestId, jobId: initialJobId });
    },
  });
  const displayedJob = notificationJobSelected
    ? notificationJob.isError
      ? null
      : (notificationJob.data ?? null)
    : selectedJob;
  const selectRun = (reviewRunId: string) => {
    setNotificationJobSelected(false);
    setSelectedRunId(reviewRunId);
    setSelectedRequestId(null);
    setSelectedJob(null);
    setActiveTab("detail");
  };
  const selectJob = (request: DashboardReviewRunRequest, job: DashboardReviewRunJob) => {
    setNotificationJobSelected(false);
    setSelectedJob({ requestId: request.requestId, job });
    setActiveTab("result");
  };

  if (!validScope) {
    return (
      <Alert severity="error">
        <AlertTitle>Repository and work item identity are required</AlertTitle>Reopen the work item
        from a selected repository to load its runs.
      </Alert>
    );
  }

  const detailsContent = detail.isError ? (
    <ErrorNotice title="Could not load this run" error={detail.error} retry={refreshDetail} />
  ) : selectedRunId && detail.isPending ? (
    <Skeleton variant="rounded" height={180} />
  ) : run ? (
    <RunDetails
      run={run}
      visible={activeTab === "detail"}
      checking={access.checking}
      selectedRequestId={selectedRequestId}
      onSelectRequest={setSelectedRequestId}
      onSelectJob={selectJob}
    />
  ) : (
    <EmptyState
      title="Select a run"
      description="Select a run from History to inspect its requests and policy."
    />
  );

  return (
    <>
      {access.checking && (
        <Skeleton variant="rounded" height={180} aria-label="Verifying repository access" />
      )}
      <div hidden={access.checking} inert={access.checking} aria-hidden={access.checking}>
        <Stack spacing={3} sx={{ width: "100%" }}>
          {!embedded && (
            <Box>
              <Typography variant="h5" sx={{ mb: 1 }}>
                {workItem.title}
              </Typography>
              <Typography variant="body1" color="text.secondary">
                {workItem.repository} #{workItem.number}
              </Typography>
            </Box>
          )}
          {run?.freshness === "superseded" && activeTab !== "history" && (
            <Alert severity="warning">
              <AlertTitle>This run has been superseded</AlertTitle>The revision or authorization
              state changed. Inspect a current run before making a decision.
            </Alert>
          )}
          {selectedRunId && activeTab !== "history" && (
            <Button
              sx={{ alignSelf: "flex-start" }}
              loading={detail.isFetching}
              onClick={refreshDetail}
            >
              Refresh run
            </Button>
          )}
          <Tabs
            value={activeTab}
            onChange={(_, value: string) => setActiveTab(value)}
            variant="scrollable"
            scrollButtons="auto"
            aria-label="Review run views"
            sx={{ borderBottom: 1, borderColor: "divider" }}
          >
            <Tab
              value="history"
              label="History"
              id={`${viewId}-tab-history`}
              aria-controls={`${viewId}-panel-history`}
            />
            <Tab
              value="detail"
              label="Run details"
              disabled={!selectedRunId}
              id={`${viewId}-tab-detail`}
              aria-controls={`${viewId}-panel-detail`}
            />
            <Tab
              value="result"
              label="Job result"
              disabled={!notificationJobSelected && selectedJob === null}
              id={`${viewId}-tab-result`}
              aria-controls={`${viewId}-panel-result`}
            />
          </Tabs>
          {activeTab === "history" && (
            <Stack
              role="tabpanel"
              id={`${viewId}-panel-history`}
              aria-labelledby={`${viewId}-tab-history`}
              spacing={2}
            >
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: "wrap", alignItems: "center" }}
              >
                <Typography variant="body2" color="text.secondary">
                  Runs for this {workItem.kind === "pull_request" ? "pull request" : "issue"} only
                </Typography>
                <Button loading={history.isFetching} onClick={() => void history.refetch()}>
                  Refresh history
                </Button>
              </Stack>
              {history.isError ? (
                <ErrorNotice
                  title="Could not load run history"
                  error={history.error}
                  retry={() => void history.refetch()}
                />
              ) : history.isPending ? (
                <Skeleton variant="rounded" height={180} />
              ) : (
                <DataTable<DashboardReviewRunSummary>
                  ariaLabel="Review run history"
                  rows={history.data.items}
                  getRowId={(item) => item.id}
                  loading={history.isFetching}
                  emptyTitle="No review runs"
                  emptyDescription="No review runs have been created for this work item."
                  pagination={{
                    page,
                    pageSize,
                    total: history.data.total,
                    onChange: (nextPage, nextSize) => {
                      setPage(nextSize === pageSize ? nextPage : 1);
                      setPageSize(Math.min(nextSize, 50));
                    },
                  }}
                  columns={[
                    {
                      id: "run",
                      label: "Run",
                      minWidth: 200,
                      render: (item) => (
                        <Stack spacing={0.5}>
                          <Typography variant="subtitle2">{timestamp(item.createdAt)}</Typography>
                          <CopyValue value={item.id} />
                        </Stack>
                      ),
                    },
                    {
                      id: "revision",
                      label: "Revision",
                      render: (item) => (
                        <Chip
                          size="medium"
                          color={item.freshness === "superseded" ? "warning" : "default"}
                          label={readable(item.freshness)}
                        />
                      ),
                    },
                    {
                      id: "requests",
                      label: "Requests",
                      render: (item) =>
                        `${item.requestCount} total · ${item.requiredRequestCount} required`,
                    },
                    {
                      id: "execution",
                      label: "Execution",
                      minWidth: 230,
                      render: (item) => executionSummary(item.execution),
                    },
                    {
                      id: "action",
                      label: "Action",
                      render: (item) => (
                        <Button onClick={() => selectRun(item.id)}>View run</Button>
                      ),
                    },
                  ]}
                />
              )}
            </Stack>
          )}
          {activeTab === "detail" && (
            <Box
              role="tabpanel"
              id={`${viewId}-panel-detail`}
              aria-labelledby={`${viewId}-tab-detail`}
            >
              {detailsContent}
            </Box>
          )}
          {activeTab === "result" && (
            <Box
              role="tabpanel"
              id={`${viewId}-panel-result`}
              aria-labelledby={`${viewId}-tab-result`}
            >
              {access.checking ? (
                <Skeleton variant="rounded" height={180} />
              ) : detail.isError ? (
                <ErrorNotice
                  title="Could not confirm the selected run"
                  error={detail.error}
                  retry={refreshDetail}
                />
              ) : notificationJobSelected && notificationJob.isError ? (
                <ErrorNotice
                  title="Could not locate this job in the selected run"
                  error={notificationJob.error}
                  retry={() => void notificationJob.refetch()}
                />
              ) : run && displayedJob ? (
                <JobResult
                  key={`${run.id}:${displayedJob.requestId}:${displayedJob.job.jobId}`}
                  run={run}
                  selection={displayedJob}
                />
              ) : (
                <Skeleton variant="rounded" height={180} />
              )}
            </Box>
          )}
        </Stack>
      </div>
    </>
  );
}
interface ReviewRunsDrawerProps {
  workItem: ReviewRunWorkItem | null;
  onClose: () => void;
  initialRunId?: string;
  initialRequestId?: string;
  initialJobId?: string;
  onCreateRun?: () => void;
}

export function ReviewRunsDrawer(props: ReviewRunsDrawerProps) {
  if (!props.workItem) return null;
  return (
    <OperatorAccessGate repositoryId={props.workItem.repositoryId} permission="read">
      <ReviewRunsDrawerContent
        key={`${props.workItem.repositoryId}:${props.workItem.id}`}
        {...props}
        workItem={props.workItem}
      />
    </OperatorAccessGate>
  );
}

function ReviewRunsDrawerContent({
  workItem,
  onClose,
  initialRunId,
  initialRequestId,
  initialJobId,
  onCreateRun,
}: Omit<ReviewRunsDrawerProps, "workItem"> & { workItem: ReviewRunWorkItem }) {
  const access = useOperatorAccess(workItem?.repositoryId);
  const permissionReason = reviewPermissionUnavailableReason(access);
  return (
    <Drawer
      anchor="right"
      open={workItem !== null}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: "100%", lg: 1160 }, maxWidth: "100%" } } }}
    >
      <Stack
        direction="row"
        spacing={2}
        sx={{
          px: { xs: 2, sm: 3 },
          py: 2,
          minHeight: 72,
          alignItems: "center",
          justifyContent: "space-between",
          bgcolor: "background.default",
        }}
      >
        <Typography variant="h6">
          {workItem.kind === "issue" ? "Issue runs" : "Pull request runs"}
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}
        >
          <Button
            loading={access.checking}
            disabled={access.checking}
            onClick={() => void access.refresh()}
          >
            Refresh access
          </Button>
          {workItem && onCreateRun ? (
            <Tooltip title={permissionReason}>
              <span>
                <Button
                  variant="contained"
                  disabled={!access.can("review")}
                  onClick={() => {
                    if (!access.can("review")) return;
                    onCreateRun();
                  }}
                >
                  Run validation
                </Button>
              </span>
            </Tooltip>
          ) : null}
          <IconButton aria-label="Close review runs" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>
      </Stack>
      <Divider />
      <Box sx={{ p: { xs: 2, sm: 3 }, minWidth: 0 }}>
        {access.checking && (
          <Skeleton variant="rounded" height={180} aria-label="Verifying repository access" />
        )}
        <div hidden={access.checking} inert={access.checking} aria-hidden={access.checking}>
          {workItem && (
            <Stack spacing={2} sx={{ width: "100%" }}>
              {onCreateRun && permissionReason && (
                <Typography variant="body2" color="text.secondary">
                  {permissionReason}
                </Typography>
              )}
              <ReviewRunsPanel
                key={`${workItem.repositoryId}:${workItem.id}:${initialRunId ?? "history"}`}
                workItem={workItem}
                initialRunId={initialRunId}
                initialRequestId={initialRequestId}
                initialJobId={initialJobId}
              />
            </Stack>
          )}
        </div>
      </Box>
    </Drawer>
  );
}
