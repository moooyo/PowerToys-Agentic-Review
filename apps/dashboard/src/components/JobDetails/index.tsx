import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Skeleton,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useState } from "react";
import { JobAdmission } from "@/components/JobAdmission";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { SchedulingDiagnostics } from "@/components/SchedulingDiagnostics";
import { StatusTag } from "@/components/StatusTag";
import { DataTable, DetailsGrid, notify } from "@/components/ui";
import { type JobDetails, type JobReviewResult, reviewControl } from "@/services/review-control";
import { jobDisplayStatus } from "@/services/review-control/admission";
import { useOperatorSession } from "@/state/session";
import { formatDuration } from "@/utils/format";
import {
  clearJobDetailsQuery,
  jobAccessDenied,
  jobDetailsQueryRoot,
  jobReadSessionKey,
  visibleJobDetails,
} from "./state";
import "./index.css";

const activeStatuses = new Set([
  "queued",
  "leased",
  "running",
  "retry_waiting",
  "cancel_requested",
]);
const recommendationLabels = {
  approve: "Approve",
  comment: "Comment",
  request_changes: "Request changes",
};
const verificationLabels = {
  not_run: "Not run",
  passed: "Passed",
  failed: "Failed",
  unknown: "Unknown",
};
const commandLabels = { completed: "Completed", failed: "Failed", unknown: "Unknown" };
const worktreeLabels = { clean: "Clean", modified: "Modified", unknown: "Unknown" };
const stageLabels: Record<string, string> = {
  awaiting_admission: "Awaiting admission",
  queued: "Waiting for a worker",
  leased: "Worker assigned",
  preparing: "Preparing the workspace",
  cli_review: "CLI review",
  validation: "Validating",
  cli_revision: "CLI revision",
  uploading: "Transferring results",
  completing: "Saving the result",
  cancelling: "Stopping execution",
  done: "Finished",
};

function readable(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function timestamp(value?: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

function CopyValue({ value }: { value?: string | null }) {
  return value ? (
    <span className="job-details__copy-value">
      <code className="job-details__code">{value}</code>
      <Tooltip title="Copy value">
        <IconButton
          size="medium"
          aria-label="Copy value"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              notify("Copied to clipboard.");
            } catch {
              notify("Unable to copy this value to the clipboard.", "error");
            }
          }}
        >
          <ContentCopyIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
    </span>
  ) : (
    <span className="job-details__muted">Not recorded</span>
  );
}

function Facts({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div className="job-details__facts">
      <DetailsGrid items={items} columns={2} />
    </div>
  );
}

function DetailsSkeleton({ lines = 7 }: { lines?: number }) {
  return (
    <Box sx={{ py: 1 }}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: Loading skeleton rows have no data identity, state, or reorder behavior.
          key={`line-${index}`}
          animation="wave"
          height={28}
          width={index === lines - 1 ? "68%" : "100%"}
        />
      ))}
    </Box>
  );
}

function PendingResult({ job, showExecution }: { job: JobDetails; showExecution: () => void }) {
  const state = (() => {
    if (job.admission?.state === "pending")
      return {
        title: "Awaiting admission",
        body: "This job has been recorded and is waiting to enter the execution queue. Its result will appear after an attempt completes.",
      };
    switch (job.status) {
      case "queued":
        return {
          title: "Queued",
          body: "This job is queued. Its review result will appear here when execution finishes.",
        };
      case "retry_waiting":
        return {
          title: "Waiting to retry",
          body: "The last attempt did not complete. The job will retry when a worker is available. Open Execution to inspect the last failure.",
        };
      case "leased":
      case "running":
        return {
          title: "Review in progress",
          body: "A worker is processing this job. This panel refreshes every five seconds while the job is active.",
        };
      case "cancel_requested":
        return {
          title: "Stopping the job",
          body: "Cancellation has been requested. The worker is finishing shutdown; no review result has been saved.",
        };
      case "failed":
      case "dead_letter":
        return {
          title: "No review result was saved",
          body: "Open Execution for the failure details. After resolving the cause, use the work item on GitHub to request another run.",
        };
      case "cancelled":
        return {
          title: "The job was cancelled",
          body: "This attempt stopped before saving a review result. Open Execution to inspect its final state.",
        };
      case "stale":
        return {
          title: "This job was superseded",
          body: "The work item changed after this job was scheduled. Return to the work item to inspect its latest job.",
        };
      default:
        return {
          title: "The result is unavailable",
          body: "This job has no saved review result. Open Execution to inspect the recorded state and identifiers.",
        };
    }
  })();
  return (
    <Alert severity={job.status === "failed" || job.status === "dead_letter" ? "error" : "info"}>
      <AlertTitle>{state.title}</AlertTitle>
      <div className="job-details__pending">
        <p>{state.body}</p>
        <Button variant="outlined" onClick={showExecution}>
          View execution
        </Button>
      </div>
    </Alert>
  );
}

function ResultContent({ result }: { result: JobReviewResult }) {
  const pr = result.prReview;
  const issue = result.issueTriage;
  return (
    <div className="job-details__stack job-details__report">
      <section className="job-details__section job-details__section--summary">
        <div className="job-details__section-heading">
          <h3>{pr ? "Review recommendation" : "Triage summary"}</h3>
          {pr && (
            <Chip
              size="medium"
              color={
                pr.assessment === "approve"
                  ? "success"
                  : pr.assessment === "request_changes"
                    ? "warning"
                    : "default"
              }
              label={recommendationLabels[pr.assessment]}
            />
          )}
        </div>
        <p className="job-details__prose">{result.summary}</p>
      </section>

      {pr && (
        <section
          className="job-details__section job-details__section--findings"
          aria-label="Findings"
        >
          <div className="job-details__section-heading">
            <h3>Findings</h3>
            <Chip size="medium" label={pr.findings.length} />
          </div>
          {pr.findings.length === 0 ? (
            <p className="job-details__quiet-message">
              No actionable findings were reported. Open Validation to assess the verification
              coverage.
            </p>
          ) : (
            <div className="job-details__finding-list">
              {pr.findings.map((finding) => (
                <article className="job-details__finding" key={finding.findingId}>
                  <Chip
                    size="medium"
                    className="job-details__priority"
                    aria-label={`Priority ${finding.priority}`}
                    color={
                      finding.priority === 0
                        ? "error"
                        : finding.priority === 1
                          ? "warning"
                          : "default"
                    }
                    label={`P${finding.priority}`}
                  />
                  <div className="job-details__finding-content">
                    <h4>{finding.title}</h4>
                    <div className="job-details__location job-details__code">
                      {finding.path}:{finding.line}
                      {finding.endLine === null ? "" : `–${finding.endLine}`}
                    </div>
                    <p className="job-details__prose">{finding.body}</p>
                    <span className="job-details__utility">
                      Model confidence {Math.round(finding.confidence * 100)}%
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {issue && (
        <>
          <section className="job-details__section">
            <h3>Classification</h3>
            <Facts
              items={[
                { label: "Category", value: readable(issue.category) },
                { label: "Priority", value: `P${issue.priority}` },
                { label: "Model confidence", value: `${Math.round(issue.confidence * 100)}%` },
              ]}
            />
            <div className="job-details__field">
              <span className="job-details__field-label">Suggested labels</span>
              {issue.suggestedLabels.length === 0 ? (
                <span className="job-details__muted">None suggested</span>
              ) : (
                <div className="job-details__labels">
                  {issue.suggestedLabels.map((label) => (
                    <Chip size="medium" key={label} label={label} />
                  ))}
                </div>
              )}
            </div>
          </section>
          <section className="job-details__section">
            <h3>Missing information</h3>
            {issue.missingInformation.length === 0 ? (
              <p className="job-details__muted">No additional information was requested.</p>
            ) : (
              <ul className="job-details__text-list">
                {issue.missingInformation.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>
          <section className="job-details__section">
            <h3>Possible duplicates</h3>
            {issue.duplicateCandidates.length === 0 ? (
              <p className="job-details__muted">No duplicate candidates were reported.</p>
            ) : (
              <ul className="job-details__duplicates">
                {issue.duplicateCandidates.map((candidate) => (
                  <li key={candidate.number}>
                    <strong>#{candidate.number}</strong>
                    <p className="job-details__prose">{candidate.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ValidationContent({ result }: { result: JobReviewResult | null }) {
  const report = result?.verification;
  const evidence = result?.executionEvidence;
  const reportedCommandOccurrences = new Map<string, number>();
  const reportedCommands = report?.commands.map((command) => {
    const identity = JSON.stringify(command);
    const occurrence = (reportedCommandOccurrences.get(identity) ?? 0) + 1;
    reportedCommandOccurrences.set(identity, occurrence);
    return { ...command, rowKey: `${identity}:${occurrence}` };
  });
  return (
    <div className="job-details__stack">
      <section className="job-details__section">
        <div className="job-details__section-heading">
          <h3>Reported verification</h3>
          <Chip size="medium" label="Model report" />
        </div>
        <p className="job-details__evidence-note">
          The model describes what it checked. Compare this report with the worker observations
          below.
        </p>
        <Facts
          items={[
            { label: "Reported status", value: verificationLabels[report?.status ?? "unknown"] },
          ]}
        />
        <p className="job-details__prose">
          {report?.summary ?? "No model verification report was recorded for this job."}
        </p>
        {reportedCommands && reportedCommands.length > 0 ? (
          <section className="job-details__table-wrap" aria-label="Commands reported by the model">
            <DataTable
              ariaLabel="Commands reported by the model"
              getRowId={(command) => command.rowKey}
              rows={reportedCommands}
              columns={[
                {
                  id: "command",
                  label: "Command",
                  render: (command) => <code className="job-details__code">{command.command}</code>,
                },
                {
                  id: "status",
                  label: "Reported outcome",
                  width: 144,
                  render: (command) => verificationLabels[command.status],
                },
              ]}
            />
          </section>
        ) : (
          <p className="job-details__quiet-message">No verification commands were reported.</p>
        )}
      </section>

      <section className="job-details__section">
        <div className="job-details__section-heading">
          <h3>Observed execution</h3>
          <Chip size="medium" label="Worker capture" />
        </div>
        <p className="job-details__evidence-note">
          These commands and exit codes come from captured CLI events. Exit code 0 describes a
          command's outcome; it does not establish test coverage or correctness.
        </p>
        <Facts
          items={[
            {
              label: "Command capture",
              value: evidence ? readable(evidence.commandCapture) : "Not recorded",
            },
            {
              label: "Final worktree",
              value: worktreeLabels[evidence?.worktree.status ?? "unknown"],
            },
            {
              label: "Worktree observation",
              value:
                evidence?.worktree.source === "git_status" ? "Final Git status" : "Not observed",
            },
          ]}
        />
        {evidence?.commandCapture === "incomplete" && (
          <Alert className="job-details__capture-warning" severity="warning">
            <AlertTitle>Incomplete command capture</AlertTitle>
            Some command events, exit codes, or command text may be missing.
          </Alert>
        )}
        {evidence && evidence.commands.length > 0 ? (
          <section className="job-details__table-wrap" aria-label="Commands captured by the worker">
            <DataTable
              ariaLabel="Commands captured by the worker"
              getRowId={(command) => command.itemId}
              rows={evidence.commands}
              columns={[
                {
                  id: "command",
                  label: "Command",
                  render: (command) => <code className="job-details__code">{command.command}</code>,
                },
                {
                  id: "status",
                  label: "Outcome",
                  width: 112,
                  render: (command) => commandLabels[command.status],
                },
                {
                  id: "exitCode",
                  label: "Exit code",
                  width: 80,
                  render: (command) => command.exitCode ?? "Unknown",
                },
              ]}
            />
          </section>
        ) : (
          <p className="job-details__quiet-message">
            {evidence
              ? "No commands were captured."
              : "No worker execution evidence was recorded for this job."}
          </p>
        )}
      </section>
    </div>
  );
}

function ExecutionContent({ job }: { job: JobDetails }) {
  const diagnostics = job.failureDiagnostics;
  const result = job.reviewResult;
  const metadataId = useId();
  return (
    <div className="job-details__stack">
      {(job.failureCode || job.failureMessage || diagnostics) && (
        <section className="job-details__section job-details__diagnostics">
          <h3>Failure details</h3>
          <Facts
            items={[
              { label: "Failure code", value: <CopyValue value={job.failureCode} /> },
              {
                label: "Category",
                value: diagnostics ? readable(diagnostics.category) : "Not recorded",
              },
              { label: "Exit code", value: diagnostics?.exitCode ?? "Not recorded" },
            ]}
          />
          {job.failureMessage && <p className="job-details__prose">{job.failureMessage}</p>}
          {diagnostics && (
            <>
              <Alert className="job-details__diagnostic-summary" severity="error">
                {diagnostics.summary}
              </Alert>
              <div className="job-details__field">
                <span className="job-details__field-label">Correlation ID</span>
                <CopyValue value={diagnostics.correlationId} />
              </div>
            </>
          )}
        </section>
      )}
      <section className="job-details__section">
        <h3>Run details</h3>
        <div className="job-details__field">
          <span className="job-details__field-label">Job ID</span>
          <CopyValue value={job.id} />
        </div>
        <Facts
          items={[
            { label: "Status", value: readable(job.status) },
            { label: "Stage", value: stageLabels[job.stage] ?? readable(job.stage) },
            { label: "Outcome", value: job.outcome ? readable(job.outcome) : "Not completed" },
            { label: "Attempt", value: `${job.attempt} of ${job.maxAttempts}` },
            { label: "Generation", value: job.generation },
            { label: "Elapsed", value: formatDuration(job.elapsedSeconds) },
            {
              label: "Worker",
              value: job.workerNodeId ? <CopyValue value={job.workerNodeId} /> : "Unassigned",
            },
            { label: "Lease generation", value: job.leaseGeneration ?? "Not leased" },
            { label: "Lease expires", value: timestamp(job.leaseExpiresAt) },
            { label: "Last progress", value: timestamp(job.progressUpdatedAt) },
            { label: "Created", value: timestamp(job.createdAt) },
            { label: "Updated", value: timestamp(job.updatedAt) },
          ]}
        />
        <div className="job-details__field">
          <span className="job-details__field-label">Target revision</span>
          <CopyValue value={job.targetSha} />
        </div>
      </section>
      <Accordion className="job-details__metadata" disableGutters>
        <AccordionSummary
          expandIcon={<ExpandMoreIcon />}
          id={`${metadataId}-summary`}
          aria-controls={`${metadataId}-content`}
        >
          Result metadata
        </AccordionSummary>
        <AccordionDetails>
          <Facts
            items={[
              { label: "Work item ID", value: <CopyValue value={job.workItemId} /> },
              { label: "Result ID", value: <CopyValue value={result?.reviewResultId} /> },
              { label: "Schema", value: result?.schemaId ?? "Not recorded" },
              { label: "Result saved", value: timestamp(result?.createdAt) },
              {
                label: "Evidence schema",
                value: result?.executionEvidence?.schemaVersion ?? "Not recorded",
              },
              {
                label: "Requested recipes",
                value: result?.requestedRecipeIds.length
                  ? result.requestedRecipeIds.join(", ")
                  : "None",
              },
            ]}
          />
          <div className="job-details__field">
            <span className="job-details__field-label">Result digest</span>
            <CopyValue value={result?.resultDigest ?? job.resultDigest} />
          </div>
        </AccordionDetails>
      </Accordion>
    </div>
  );
}

function useClearJobSession(session: string, jobId: string, discard = false) {
  const client = useQueryClient();
  useEffect(() => {
    const clear = () => clearJobDetailsQuery(client, session, jobId);
    if (discard) clear();
    return clear;
  }, [client, session, jobId, discard]);
}

function JobDetailsContent({
  repositoryId,
  jobId,
  session,
  embedded = false,
}: {
  repositoryId: string;
  jobId: string;
  session: string;
  embedded?: boolean;
}) {
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState("result");
  const [visitedTabs, setVisitedTabs] = useState(() => new Set(["result"]));
  const selectTab = (tab: string) => {
    setActiveTab(tab);
    setVisitedTabs((previous) => new Set(previous).add(tab));
  };
  const query = useQuery({
    queryKey: [...jobDetailsQueryRoot, session, jobId],
    queryFn: async ({ signal }) => {
      const result = await reviewControl.getJob(jobId, signal);
      if (result !== null && (result.id !== jobId || result.repositoryId !== repositoryId))
        throw new Error("The job does not belong to the selected repository and job identity.");
      return result;
    },
    retry: false,
    gcTime: 0,
    staleTime: 5_000,
    refetchInterval: (currentQuery) => {
      const job = currentQuery.state.data;
      return currentQuery.state.status !== "error" && job && activeStatuses.has(job.status)
        ? 5_000
        : false;
    },
  });
  useClearJobSession(session, jobId, jobAccessDenied(query.error));
  const job = visibleJobDetails(query.data, repositoryId, jobId, query.isError);

  if (query.isPending) {
    return (
      <div
        className="job-details-panel"
        role="status"
        aria-label="Loading job details"
        aria-busy="true"
      >
        <DetailsSkeleton />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="job-details-panel job-details__empty" role="alert">
        <h3>Unable to load this job</h3>
        <p>
          {query.error instanceof Error ? query.error.message : "The job details request failed."}
        </p>
        <Button
          startIcon={<RefreshIcon />}
          variant="outlined"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!job) {
    return (
      <div className="job-details-panel job-details__empty">
        <h3>Job not found</h3>
        <p>This job is no longer available. Return to the work item or refresh the job list.</p>
      </div>
    );
  }

  return (
    <div className={`job-details-panel${embedded ? " job-details-panel--embedded" : ""}`}>
      <header className="job-details__header">
        <div className="job-details__identity">
          {!embedded && (
            <>
              <h2>{job.title}</h2>
              <span className="job-details__reference">{job.workItemRef}</span>
            </>
          )}
          <div className="job-details__header-status">
            <span role="status" aria-live="polite" aria-atomic="true">
              <StatusTag status={jobDisplayStatus(job.status, job.admission)} />
            </span>
            <span className="job-details__utility">
              {activeStatuses.has(job.status)
                ? "Refreshes every 5 seconds"
                : `Updated ${timestamp(job.updatedAt)}`}
            </span>
          </div>
        </div>
        <IconButton
          aria-label="Refresh job details"
          title="Refresh job details"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshIcon />
        </IconButton>
      </header>
      <JobAdmission admission={job.admission} />
      <Tabs
        className="job-details__tabs"
        value={activeTab}
        onChange={(_, tab: string) => selectTab(tab)}
        aria-label="Job details sections"
        variant="scrollable"
        scrollButtons="auto"
      >
        {[
          ["result", "Result"],
          ["validation", "Validation"],
          ["execution", "Execution"],
        ].map(([value, label]) => (
          <Tab
            key={value}
            value={value}
            label={label}
            id={`${tabsId}-${value}-tab`}
            aria-controls={`${tabsId}-${value}-panel`}
          />
        ))}
      </Tabs>
      <div
        className="job-details__tab-panel"
        role="tabpanel"
        id={`${tabsId}-result-panel`}
        aria-labelledby={`${tabsId}-result-tab`}
        hidden={activeTab !== "result"}
        tabIndex={activeTab === "result" ? 0 : -1}
      >
        {job.reviewResult ? (
          <ResultContent result={job.reviewResult} />
        ) : (
          <PendingResult job={job} showExecution={() => selectTab("execution")} />
        )}
      </div>
      <div
        className="job-details__tab-panel"
        role="tabpanel"
        id={`${tabsId}-validation-panel`}
        aria-labelledby={`${tabsId}-validation-tab`}
        hidden={activeTab !== "validation"}
        tabIndex={activeTab === "validation" ? 0 : -1}
      >
        {visitedTabs.has("validation") && <ValidationContent result={job.reviewResult} />}
      </div>
      <div
        className="job-details__tab-panel"
        role="tabpanel"
        id={`${tabsId}-execution-panel`}
        aria-labelledby={`${tabsId}-execution-tab`}
        hidden={activeTab !== "execution"}
        tabIndex={activeTab === "execution" ? 0 : -1}
      >
        {visitedTabs.has("execution") && <ExecutionContent job={job} />}
      </div>
      <div className="job-details__scheduling">
        <SchedulingDiagnostics
          scope={{
            kind: "repository_job",
            repositoryId: job.repositoryId,
            workItemId: job.workItemId,
            jobId: job.id,
          }}
        />
      </div>
    </div>
  );
}

export function JobDetailsPanel({
  repositoryId,
  jobId,
  embedded = false,
}: {
  repositoryId: string;
  jobId: string;
  embedded?: boolean;
}) {
  const access = useOperatorAccess(repositoryId);
  const { initialState } = useOperatorSession();
  const session = jobReadSessionKey(
    repositoryId,
    access.identityKey,
    initialState?.authenticationEpoch ?? 0,
    access.context,
  );
  const unavailable =
    access.pending || access.checking || !access.ready || !!access.error || !access.allows("read");
  useClearJobSession(session, jobId, unavailable);
  if (access.pending || access.checking)
    return (
      <div role="status" aria-label="Checking job access" aria-busy="true">
        <DetailsSkeleton lines={5} />
      </div>
    );
  if (unavailable)
    return (
      <Alert
        severity="info"
        action={<Button onClick={() => void access.refresh()}>Refresh access</Button>}
      >
        <AlertTitle>Job access is unavailable</AlertTitle>
        Repository read access is required. Previous job details have been cleared.
      </Alert>
    );
  return (
    <JobDetailsContent
      key={`${session}:${jobId}`}
      repositoryId={repositoryId}
      jobId={jobId}
      session={session}
      embedded={embedded}
    />
  );
}

export function JobDetailDrawer({
  repositoryId,
  jobId,
  onClose,
}: {
  repositoryId: string;
  jobId: string | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const access = useOperatorAccess(repositoryId);
  return (
    <Drawer
      className="job-detail-drawer"
      anchor="right"
      open={jobId !== null}
      onClose={onClose}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": titleId,
          sx: { width: "100%", "@media (min-width: 992px)": { width: 860 } },
        },
      }}
    >
      <header className="job-detail-drawer__header">
        <Typography component="h2" variant="h6" id={titleId}>
          Job details
        </Typography>
        <div className="job-detail-drawer__actions">
          <Button loading={access.checking} onClick={() => void access.refresh()}>
            Refresh access
          </Button>
          <IconButton aria-label="Close job details" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
      </header>
      <div className="job-detail-drawer__body">
        {jobId !== null && <JobDetailsPanel repositoryId={repositoryId} jobId={jobId} />}
      </div>
    </Drawer>
  );
}
