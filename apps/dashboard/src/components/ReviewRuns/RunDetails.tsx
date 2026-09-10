import type {
  DashboardReviewRunDetail,
  DashboardReviewRunJob,
  DashboardReviewRunRequest,
} from "@agentic-review/contracts";
import { ExpandLess, ExpandMore } from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  IconButton,
  LinearProgress,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { IssueReproductionSummary } from "@/components/IssueReproduction";
import { JobAdmission } from "@/components/JobAdmission";
import { ReviewRunDecisions } from "@/components/ReviewRunDecisions";
import { DataTable, EmptyState } from "@/components/ui";
import { runs } from "@/services/runs";
import {
  CopyValue,
  ErrorNotice,
  EvidenceIds,
  Facts,
  Prose,
  readable,
  timestamp,
  withOccurrenceKeys,
} from "./common";
import {
  evidenceVerificationLabel,
  evidenceVerificationPendingLabel,
  pendingEvidenceRequests,
  requestEvidencePending,
} from "./evidence-verification";
import {
  executionLabel,
  policyFindingPresentation,
  policyPresentation,
  recommendationLabel,
  requestTargetLabel,
  summarizeCheckOutcomes,
} from "./presentation";
import { RequestActions } from "./RequestActions";

export function TestedSource({ run }: { run: DashboardReviewRunDetail }) {
  const source = run.testedSourceRevision;
  return (
    <Facts
      items={
        source
          ? [
              {
                label:
                  source.kind === "pull_request" ? "Tested PR head SHA" : "Tested source commit",
                value: <CopyValue value={source.headSha} />,
              },
              ...(source.kind === "pull_request"
                ? [{ label: "Tested PR base SHA", value: <CopyValue value={source.baseSha} /> }]
                : []),
            ]
          : [
              {
                label: "Tested source revision",
                value: "Not recorded. No tested source commit is established for this run.",
              },
            ]
      }
    />
  );
}

function Policy({ run }: { run: DashboardReviewRunDetail }) {
  const policy = policyPresentation(run.policy);
  const findings = policyFindingPresentation(run.policy);
  const pending = pendingEvidenceRequests(run);
  const reasonRows = withOccurrenceKeys(run.policy.reasons, (reason) => JSON.stringify(reason));
  const [reasonsPage, setReasonsPage] = useState(0);
  const currentReasonsPage = Math.min(
    reasonsPage,
    Math.max(0, Math.ceil(run.policy.reasons.length / 10) - 1),
  );
  return (
    <Stack component="section" spacing={2} sx={{ width: "100%", minWidth: 0 }}>
      <Typography variant="h6" component="h3">
        Policy eligibility
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <Chip size="medium" color={policy.tone} label={policy.label} />
        <Typography variant="body2" color="text.secondary">
          {run.policy.policyVersion}
        </Typography>
      </Stack>
      <Prose>{policy.description}</Prose>
      {(pending.required > 0 || pending.optional > 0) && (
        <Alert severity="info">
          <AlertTitle>{evidenceVerificationPendingLabel}</AlertTitle>
          {pending.required > 0
            ? `Evidence for ${pending.required} required request(s) is being verified.${run.policy.applicable ? " Approval eligibility remains withheld." : ""} Recorded check outcomes are unchanged. Automatic refresh is limited; use Refresh run to check again if needed.`
            : `Evidence for ${pending.optional} optional request(s) is being verified. This does not block completed required validation. Recorded check outcomes are unchanged. Automatic refresh is limited; use Refresh run to check again if needed.`}
        </Alert>
      )}
      {run.policy.applicable && (
        <Typography variant="body2" color="text.secondary">
          {run.policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
            ? "Eligibility reflects the current execution results and finding dispositions for this frozen run."
            : "Eligibility applies to this frozen run."}{" "}
          It does not record an approval or publication.
          {run.freshness === "superseded" ? " This run has been superseded." : ""}
        </Typography>
      )}
      <Facts
        items={[
          ...findings.counts,
          { label: "Policy reasons", value: run.policy.reasonCount },
          ...(findings.dispositionDigest
            ? [
                {
                  label: "Finding disposition digest",
                  value: <CopyValue value={findings.dispositionDigest} />,
                },
              ]
            : []),
        ]}
      />
      <Typography variant="body2" color="text.secondary">
        {findings.description}
      </Typography>
      {run.policy.reasons.length > 0 && (
        <Accordion disableGutters>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
              {`Policy reasons (${run.policy.reasonCount})`}
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              {run.policy.reasonsTruncated && (
                <Alert severity="warning">
                  <AlertTitle>
                    {`Showing ${run.policy.reasons.length} of ${run.policy.reasonCount} reasons`}
                  </AlertTitle>
                  The control plane returned a bounded preview of the reasons.
                </Alert>
              )}
              <Box>
                <TableContainer>
                  <Table size="medium" aria-label="Policy reasons" sx={{ minWidth: 760 }}>
                    <TableHead>
                      <TableRow>
                        <TableCell>Reason code</TableCell>
                        <TableCell>Request / check</TableCell>
                        <TableCell>Outcome</TableCell>
                        <TableCell>Explanation</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {reasonRows
                        .slice(currentReasonsPage * 10, currentReasonsPage * 10 + 10)
                        .map(({ key, item: reason }) => (
                          <TableRow key={key}>
                            <TableCell>{reason.code}</TableCell>
                            <TableCell>
                              <Stack spacing={0}>
                                {reason.requestId && <CopyValue value={reason.requestId} />}
                                {reason.checkId && <CopyValue value={reason.checkId} />}
                                {!reason.requestId && !reason.checkId && "Run policy"}
                              </Stack>
                            </TableCell>
                            <TableCell>
                              {reason.outcome ? readable(reason.outcome) : "Not specified"}
                            </TableCell>
                            <TableCell>
                              {reason.reason ?? "No additional explanation recorded."}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={run.policy.reasons.length}
                  page={currentReasonsPage}
                  rowsPerPage={10}
                  rowsPerPageOptions={[10]}
                  onPageChange={(_, nextPage) => setReasonsPage(nextPage)}
                />
              </Box>
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}
    </Stack>
  );
}

function RequestJobs({
  run,
  request,
  onSelectJob,
}: {
  run: DashboardReviewRunDetail;
  request: DashboardReviewRunRequest;
  onSelectJob: (request: DashboardReviewRunRequest, job: DashboardReviewRunJob) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [expandedJobs, setExpandedJobs] = useState<string[]>([]);
  const jobs = useQuery({
    queryKey: [
      "review-runs",
      run.repositoryId,
      run.workItemId,
      run.id,
      request.requestId,
      "jobs",
      page,
      pageSize,
    ],
    queryFn: () => runs.listJobs(run.repositoryId, run.id, request.requestId, { page, pageSize }),
    retry: false,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data?.items.some((job) =>
        ["queued", "leased", "running", "retry_waiting", "cancel_requested"].includes(job.status),
      )
        ? 5_000
        : false,
  });
  return (
    <Stack component="section" spacing={3} sx={{ width: "100%", minWidth: 0 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <Typography variant="h6" component="h3">
          Job history
        </Typography>
        <Button
          variant="outlined"
          size="medium"
          loading={jobs.isFetching}
          onClick={() => void jobs.refetch()}
        >
          Refresh jobs
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Each activation has its own saved result. Execution completion alone does not establish
        passed validation.
      </Typography>
      {jobs.isError ? (
        <ErrorNotice
          title="Could not load job history"
          error={jobs.error}
          retry={() => void jobs.refetch()}
        />
      ) : jobs.isPending ? (
        <Skeleton variant="rounded" height={180} />
      ) : (
        <Box aria-busy={jobs.isFetching}>
          {jobs.isFetching && <LinearProgress aria-label="Refreshing job history" />}
          <TableContainer>
            <Table size="medium" aria-label="Job history" sx={{ minWidth: 760 }}>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Box
                      component="span"
                      sx={{
                        position: "absolute",
                        width: 1,
                        height: 1,
                        overflow: "hidden",
                        clipPath: "inset(50%)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Job details
                    </Box>
                  </TableCell>
                  <TableCell>Activation</TableCell>
                  <TableCell>Execution</TableCell>
                  <TableCell>Attempts</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Saved result</TableCell>
                  <TableCell>Action</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.data.items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <EmptyState title="No jobs have been scheduled for this request." />
                    </TableCell>
                  </TableRow>
                )}
                {jobs.data.items.map((job) => {
                  const expanded = expandedJobs.includes(job.jobId);
                  return (
                    <Fragment key={job.jobId}>
                      <TableRow hover>
                        <TableCell padding="checkbox">
                          <IconButton
                            size="medium"
                            aria-label={`${expanded ? "Hide" : "Show"} details for activation ${job.activationNumber}`}
                            aria-expanded={expanded}
                            aria-controls={`job-details-${job.jobId}`}
                            onClick={() =>
                              setExpandedJobs((current) =>
                                current.includes(job.jobId)
                                  ? current.filter((jobId) => jobId !== job.jobId)
                                  : [...current, job.jobId],
                              )
                            }
                          >
                            {expanded ? <ExpandLess /> : <ExpandMore />}
                          </IconButton>
                        </TableCell>
                        <TableCell>{job.activationNumber}</TableCell>
                        <TableCell>
                          <Stack spacing={0}>
                            {executionLabel(job.status, job.admission)}
                            <Typography variant="body2" color="text.secondary">
                              {job.phase ? readable(job.phase) : "No active phase"}
                            </Typography>
                          </Stack>
                        </TableCell>
                        <TableCell>{job.attemptCount}</TableCell>
                        <TableCell>{timestamp(job.createdAt)}</TableCell>
                        <TableCell>{job.resultId ? "Available" : "No saved report"}</TableCell>
                        <TableCell>
                          <Button
                            size="medium"
                            variant="outlined"
                            onClick={() => onSelectJob(request, job)}
                          >
                            Inspect job
                          </Button>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          sx={{ py: 0, borderBottom: expanded ? undefined : 0 }}
                        >
                          <Collapse in={expanded} timeout="auto" unmountOnExit>
                            <Box id={`job-details-${job.jobId}`} sx={{ py: 2 }}>
                              <Facts
                                items={[
                                  { label: "Job ID", value: <CopyValue value={job.jobId} /> },
                                  {
                                    label: "Run attempt ID",
                                    value: <CopyValue value={job.runAttemptId} />,
                                  },
                                  { label: "Started", value: timestamp(job.startedAt) },
                                  { label: "Completed", value: timestamp(job.completedAt) },
                                  {
                                    label: "Failure code",
                                    value: job.failureCode ?? "None recorded",
                                  },
                                  {
                                    label: "Failure message",
                                    value: <Prose>{job.failureMessage ?? "None recorded"}</Prose>,
                                  },
                                  { label: "Result ID", value: <CopyValue value={job.resultId} /> },
                                  {
                                    label: "Result digest",
                                    value: <CopyValue value={job.resultDigest} />,
                                  },
                                ]}
                              />
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={jobs.data.total}
            page={page - 1}
            rowsPerPage={pageSize}
            rowsPerPageOptions={[10, 20, 50]}
            onPageChange={(_, nextPage) => setPage(nextPage + 1)}
            onRowsPerPageChange={(event) => {
              setPage(1);
              setPageSize(Math.min(Number(event.target.value), 50));
            }}
          />
        </Box>
      )}
    </Stack>
  );
}

function RequestDetails({
  run,
  request,
  onSelectJob,
  visible,
}: {
  run: DashboardReviewRunDetail;
  request: DashboardReviewRunRequest;
  onSelectJob: (request: DashboardReviewRunRequest, job: DashboardReviewRunJob) => void;
  visible: boolean;
}) {
  const result = request.latestResult;
  return (
    <Stack component="section" spacing={3} sx={{ width: "100%", minWidth: 0 }}>
      <Typography variant="h6" component="h3">
        {requestTargetLabel(request.workflowKind, request.target)} ·{" "}
        {request.profile?.name ?? "Missing profile"}
      </Typography>
      <RequestActions
        key={`${run.id}:${request.requestId}`}
        run={run}
        request={request}
        visible={visible}
      />
      {request.latestJob && <JobAdmission admission={request.latestJob.admission} />}
      <Facts
        items={[
          { label: "Request ID", value: <CopyValue value={request.requestId} /> },
          { label: "Workflow", value: readable(request.workflowKind) },
          {
            label: "Execution target",
            value:
              request.target === "windows_desktop"
                ? "Windows UI"
                : request.target === "web"
                  ? "Web UI"
                  : "Headless",
          },
          { label: "Required request", value: request.required ? "Required" : "Optional" },
          { label: "Execution prerequisites", value: readable(request.readiness) },
          {
            label: "Latest execution",
            value: executionLabel(request.latestJob?.status, request.latestJob?.admission ?? null),
          },
          { label: "Worker checks", value: summarizeCheckOutcomes(result?.checks) },
          {
            label: "Model review",
            value: result ? readable(result.modelReviewState) : "Not available",
          },
          ...(run.workItemKind === "pull_request"
            ? [
                {
                  label: "Model recommendation",
                  value: recommendationLabel(result?.recommendation),
                },
              ]
            : []),
          ...(run.workItemKind === "issue"
            ? [
                {
                  label: "Recorded worker reproduction conclusion",
                  value: result?.reproductionConclusion
                    ? readable(result.reproductionConclusion)
                    : "Not reported",
                },
              ]
            : []),
        ]}
      />
      {request.blockers.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>Request readiness blockers</AlertTitle>
          <Box component="ul" sx={{ my: 0, pl: 2.5 }}>
            {[...new Set(request.blockers)].map((blocker) => (
              <li key={blocker}>
                {blocker === "evidence_verification_pending"
                  ? evidenceVerificationPendingLabel
                  : blocker}
              </li>
            ))}
          </Box>
          {request.blockersTruncated && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Additional blockers were omitted from this preview.
            </Typography>
          )}
        </Alert>
      )}
      <Accordion disableGutters>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
            Frozen profile and prompt versions
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Facts
            items={[
              {
                label: "Profile",
                value: request.profile
                  ? `${request.profile.name} · Version ${request.profile.version}`
                  : "Missing profile snapshot",
              },
              { label: "Profile ID", value: <CopyValue value={request.profile?.profileId} /> },
              { label: "Profile version ID", value: <CopyValue value={request.profile?.id} /> },
              {
                label: "Profile digest",
                value: <CopyValue value={request.profile?.configSha256} />,
              },
              {
                label: "Prompt version",
                value: request.prompt?.version ?? "Missing prompt snapshot",
              },
              {
                label: "Prompt template ID",
                value: <CopyValue value={request.prompt?.templateId} />,
              },
              { label: "Prompt version ID", value: <CopyValue value={request.prompt?.id} /> },
              {
                label: "Prompt content digest",
                value: <CopyValue value={request.prompt?.contentSha256} />,
              },
              {
                label: "Required check IDs",
                value: request.requiredCheckIds.length ? (
                  <EvidenceIds ids={request.requiredCheckIds} />
                ) : (
                  "No required check IDs in this request"
                ),
              },
            ]}
          />
        </AccordionDetails>
      </Accordion>
      {result ? (
        <>
          <Typography variant="h6" component="h3">
            Latest result preview
          </Typography>
          <Prose>{result.summary}</Prose>
          {result.summaryTruncated && (
            <Typography variant="body2" color="text.secondary">
              The summary is truncated. Inspect the saved job report for the complete summary.
            </Typography>
          )}
          <Facts
            items={[
              { label: "Source state", value: readable(result.sourceState) },
              { label: "Findings and observations", value: result.findingCount },
              { label: "Evidence references", value: result.evidenceCount },
              {
                label: "Current evidence availability",
                value: evidenceVerificationLabel(result, runs.mode === "sample"),
              },
              { label: "Lifecycle blockers", value: result.lifecycleBlockerCount },
            ]}
          />
        </>
      ) : (
        <Alert severity="info">
          <AlertTitle>No saved report</AlertTitle>
          {run.workItemKind === "issue"
            ? "No recorded checks or reproduction observations are available for this request."
            : "Validation outcomes and model recommendations are not available for this request."}
        </Alert>
      )}
      <RequestJobs key={request.requestId} run={run} request={request} onSelectJob={onSelectJob} />
    </Stack>
  );
}

export function RunDetails({
  run,
  selectedRequestId,
  onSelectRequest,
  onSelectJob,
  visible = true,
  checking = false,
}: {
  run: DashboardReviewRunDetail;
  selectedRequestId: string | null;
  onSelectRequest: (requestId: string) => void;
  onSelectJob: (request: DashboardReviewRunRequest, job: DashboardReviewRunJob) => void;
  visible?: boolean;
  checking?: boolean;
}) {
  const selectedRequest = run.requests.find((request) => request.requestId === selectedRequestId);
  return (
    <Stack spacing={4} sx={{ width: "100%", minWidth: 0 }}>
      {!checking && (
        <>
          <Stack
            component="section"
            spacing={2}
            sx={{ p: { xs: 2, sm: 3 }, bgcolor: "var(--app-accent-soft)", borderRadius: "12px" }}
          >
            <Typography variant="h6" component="h3">
              Run overview
            </Typography>
            <Facts
              items={[
                { label: "Run ID", value: <CopyValue value={run.id} /> },
                { label: "Created", value: timestamp(run.createdAt) },
                {
                  label: "Run freshness",
                  value: (
                    <Chip
                      size="medium"
                      color={run.freshness === "current" ? "default" : "warning"}
                      label={readable(run.freshness)}
                    />
                  ),
                },
                {
                  label: "Requests",
                  value: `${run.requestCount} total · ${run.requiredRequestCount} required`,
                },
              ]}
            />
            <TestedSource run={run} />
          </Stack>
          <Accordion
            disableGutters
            elevation={0}
            sx={{ bgcolor: "transparent", border: 0, borderBottom: 1, borderColor: "divider" }}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
                Frozen plan identity
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Facts
                items={[
                  { label: "Revision key", value: <CopyValue value={run.revisionKey} /> },
                  {
                    label: "Current revision key",
                    value: <CopyValue value={run.currentRevisionKey} />,
                  },
                  { label: "Plan digest", value: <CopyValue value={run.planDigest} /> },
                  { label: "Activation ID", value: <CopyValue value={run.activationId} /> },
                  {
                    label: "Authorization epoch",
                    value: <CopyValue value={run.requestEpochId} />,
                  },
                ]}
              />
            </AccordionDetails>
          </Accordion>
          {run.workItemKind === "pull_request" && <Policy run={run} />}
          <IssueReproductionSummary key={`reproduction:${run.id}`} run={run} />
        </>
      )}
      <ReviewRunDecisions key={`decisions:${run.id}`} run={run} />
      {!checking && (
        <>
          <Typography variant="h6" component="h3">
            Execution requests
          </Typography>
          <DataTable<DashboardReviewRunRequest>
            rows={run.requests}
            getRowId={(request) => request.requestId}
            ariaLabel="Execution requests"
            emptyTitle="No execution requests"
            columns={[
              {
                id: "target",
                label: "Workflow / target",
                minWidth: 180,
                render: (request) => (
                  <Stack spacing={0}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {requestTargetLabel(request.workflowKind, request.target)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {request.profile
                        ? `${request.profile.name} · v${request.profile.version}`
                        : "Profile not configured"}
                    </Typography>
                  </Stack>
                ),
              },
              {
                id: "required",
                label: "Required",
                render: (request) => (request.required ? "Required" : "Optional"),
              },
              {
                id: "readiness",
                label: "Execution prerequisites",
                minWidth: 160,
                render: (request) => (
                  <Chip
                    size="medium"
                    color={request.readiness === "blocked" ? "warning" : "default"}
                    label={readable(request.readiness)}
                  />
                ),
              },
              {
                id: "execution",
                label: "Execution",
                minWidth: 150,
                render: (request) =>
                  executionLabel(request.latestJob?.status, request.latestJob?.admission ?? null),
              },
              {
                id: "checks",
                label: "Worker checks",
                width: 205,
                minWidth: 205,
                render: (request) => (
                  <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
                    <span>{summarizeCheckOutcomes(request.latestResult?.checks)}</span>
                    {requestEvidencePending(request) && (
                      <Chip size="medium" color="info" label={evidenceVerificationPendingLabel} />
                    )}
                  </Stack>
                ),
              },
              ...(run.workItemKind === "pull_request"
                ? [
                    {
                      id: "recommendation",
                      label: "Model recommendation",
                      minWidth: 180,
                      render: (request: DashboardReviewRunRequest) =>
                        recommendationLabel(request.latestResult?.recommendation),
                    },
                  ]
                : []),
              {
                id: "action",
                label: "Action",
                minWidth: 130,
                render: (request) => (
                  <Button
                    size="medium"
                    variant={request.requestId === selectedRequestId ? "contained" : "outlined"}
                    aria-pressed={request.requestId === selectedRequestId}
                    onClick={() => onSelectRequest(request.requestId)}
                  >
                    View request
                  </Button>
                ),
              },
            ]}
          />
          {selectedRequest ? (
            <>
              <Divider />
              <RequestDetails
                run={run}
                request={selectedRequest}
                onSelectJob={onSelectJob}
                visible={visible}
              />
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Select a request to inspect its frozen versions, readiness blockers, and job history.
            </Typography>
          )}
        </>
      )}
    </Stack>
  );
}
