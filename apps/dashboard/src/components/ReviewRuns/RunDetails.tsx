import type {
  DashboardReviewRunDetail,
  DashboardReviewRunJob,
  DashboardReviewRunRequest,
} from "@agentic-review/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Collapse,
  Divider,
  Empty,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { IssueReproductionSummary } from "@/components/IssueReproduction";
import { JobAdmission } from "@/components/JobAdmission";
import { ReviewRunDecisions } from "@/components/ReviewRunDecisions";
import { runs } from "@/services/runs";
import { CopyValue, ErrorNotice, EvidenceIds, Facts, Prose, readable, timestamp } from "./common";
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
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Typography.Title level={5}>Policy eligibility</Typography.Title>
      <Space wrap>
        <Tag color={policy.tone}>{policy.label}</Tag>
        <Typography.Text type="secondary">{run.policy.policyVersion}</Typography.Text>
      </Space>
      <Prose>{policy.description}</Prose>
      {(pending.required > 0 || pending.optional > 0) && (
        <Alert
          type="info"
          showIcon
          title={evidenceVerificationPendingLabel}
          description={
            pending.required > 0
              ? `Evidence for ${pending.required} required request(s) is being verified.${run.policy.applicable ? " Approval eligibility remains withheld." : ""} Recorded check outcomes are unchanged. Automatic refresh is limited; use Refresh run to check again if needed.`
              : `Evidence for ${pending.optional} optional request(s) is being verified. This does not block completed required validation. Recorded check outcomes are unchanged. Automatic refresh is limited; use Refresh run to check again if needed.`
          }
        />
      )}
      {run.policy.applicable && (
        <Typography.Text type="secondary">
          {run.policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
            ? "Eligibility reflects the current execution results and finding dispositions for this frozen run."
            : "Eligibility applies to this frozen run."}{" "}
          It does not record an approval or publication.
          {run.freshness === "superseded" ? " This run has been superseded." : ""}
        </Typography.Text>
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
      <Typography.Paragraph type="secondary">{findings.description}</Typography.Paragraph>
      {run.policy.reasons.length > 0 && (
        <Collapse
          items={[
            {
              key: "reasons",
              label: `Policy reasons (${run.policy.reasonCount})`,
              children: (
                <>
                  {run.policy.reasonsTruncated && (
                    <Alert
                      showIcon
                      type="warning"
                      title={`Showing ${run.policy.reasons.length} of ${run.policy.reasonCount} reasons`}
                      description="The control plane returned a bounded preview of the reasons."
                    />
                  )}
                  <Table
                    size="small"
                    rowKey={(_, index) => `reason-${index}`}
                    dataSource={run.policy.reasons}
                    scroll={{ x: 760 }}
                    pagination={{ defaultPageSize: 10, showSizeChanger: false }}
                    columns={[
                      { title: "Reason code", dataIndex: "code" },
                      {
                        title: "Request / check",
                        render: (_, reason) => (
                          <Space orientation="vertical" size={0}>
                            {reason.requestId && <CopyValue value={reason.requestId} />}
                            {reason.checkId && <CopyValue value={reason.checkId} />}
                            {!reason.requestId && !reason.checkId && "Run policy"}
                          </Space>
                        ),
                      },
                      {
                        title: "Outcome",
                        dataIndex: "outcome",
                        render: (value: string | undefined) =>
                          value ? readable(value) : "Not specified",
                      },
                      {
                        title: "Explanation",
                        dataIndex: "reason",
                        render: (value: string | undefined) =>
                          value ?? "No additional explanation recorded.",
                      },
                    ]}
                  />
                </>
              ),
            },
          ]}
        />
      )}
    </Space>
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
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Job history
        </Typography.Title>
        <Button loading={jobs.isFetching} onClick={() => void jobs.refetch()}>
          Refresh jobs
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">
        Each activation has its own saved result. Execution completion alone does not establish
        passed validation.
      </Typography.Paragraph>
      {jobs.isError ? (
        <ErrorNotice
          title="Could not load job history"
          error={jobs.error}
          retry={() => void jobs.refetch()}
        />
      ) : jobs.isPending ? (
        <Skeleton active />
      ) : (
        <Table<DashboardReviewRunJob>
          size="small"
          rowKey="jobId"
          loading={jobs.isFetching}
          dataSource={jobs.data.items}
          scroll={{ x: 760 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No jobs have been scheduled for this request."
              />
            ),
          }}
          pagination={{
            current: page,
            pageSize,
            total: jobs.data.total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            onChange: (nextPage, nextSize) => {
              setPage(nextSize === pageSize ? nextPage : 1);
              setPageSize(Math.min(nextSize, 50));
            },
          }}
          columns={[
            { title: "Activation", dataIndex: "activationNumber" },
            {
              title: "Execution",
              dataIndex: "status",
              render: (status: DashboardReviewRunJob["status"], job) => (
                <Space orientation="vertical" size={0}>
                  {executionLabel(status, job.admission)}
                  <Typography.Text type="secondary">
                    {job.phase ? readable(job.phase) : "No active phase"}
                  </Typography.Text>
                </Space>
              ),
            },
            { title: "Attempts", dataIndex: "attemptCount" },
            {
              title: "Created",
              dataIndex: "createdAt",
              render: (value: string) => timestamp(value),
            },
            {
              title: "Saved result",
              dataIndex: "resultId",
              render: (value: string | null) => (value ? "Available" : "No saved report"),
            },
            {
              title: "Action",
              key: "action",
              render: (_, job) => (
                <Button onClick={() => onSelectJob(request, job)}>Inspect job</Button>
              ),
            },
          ]}
          expandable={{
            expandedRowRender: (job) => (
              <Facts
                items={[
                  { label: "Job ID", value: <CopyValue value={job.jobId} /> },
                  { label: "Run attempt ID", value: <CopyValue value={job.runAttemptId} /> },
                  { label: "Started", value: timestamp(job.startedAt) },
                  { label: "Completed", value: timestamp(job.completedAt) },
                  { label: "Failure code", value: job.failureCode ?? "None recorded" },
                  {
                    label: "Failure message",
                    value: <Prose>{job.failureMessage ?? "None recorded"}</Prose>,
                  },
                  { label: "Result ID", value: <CopyValue value={job.resultId} /> },
                  { label: "Result digest", value: <CopyValue value={job.resultDigest} /> },
                ]}
              />
            ),
          }}
        />
      )}
    </Space>
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
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Title level={5}>
        {requestTargetLabel(request.workflowKind, request.target)} ·{" "}
        {request.profile?.name ?? "Missing profile"}
      </Typography.Title>
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
        <Alert
          type="warning"
          showIcon
          title="Request readiness blockers"
          description={
            <>
              <ul>
                {[...new Set(request.blockers)].map((blocker) => (
                  <li key={blocker}>
                    {blocker === "evidence_verification_pending"
                      ? evidenceVerificationPendingLabel
                      : blocker}
                  </li>
                ))}
              </ul>
              {request.blockersTruncated && (
                <p>Additional blockers were omitted from this preview.</p>
              )}
            </>
          }
        />
      )}
      <Collapse
        items={[
          {
            key: "versions",
            label: "Frozen profile and prompt versions",
            children: (
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
            ),
          },
        ]}
      />
      {result ? (
        <>
          <Typography.Title level={5}>Latest result preview</Typography.Title>
          <Prose>{result.summary}</Prose>
          {result.summaryTruncated && (
            <Typography.Text type="secondary">
              The summary is truncated. Inspect the saved job report for the complete summary.
            </Typography.Text>
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
        <Alert
          type="info"
          showIcon
          title="No saved report"
          description={
            run.workItemKind === "issue"
              ? "No recorded checks or reproduction observations are available for this request."
              : "Validation outcomes and model recommendations are not available for this request."
          }
        />
      )}
      <RequestJobs key={request.requestId} run={run} request={request} onSelectJob={onSelectJob} />
    </Space>
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
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      {!checking && (
        <>
          <Facts
            items={[
              { label: "Run ID", value: <CopyValue value={run.id} /> },
              { label: "Created", value: timestamp(run.createdAt) },
              {
                label: "Run freshness",
                value: (
                  <Tag color={run.freshness === "current" ? "default" : "warning"}>
                    {readable(run.freshness)}
                  </Tag>
                ),
              },
              {
                label: "Requests",
                value: `${run.requestCount} total · ${run.requiredRequestCount} required`,
              },
            ]}
          />
          <TestedSource run={run} />
          <Collapse
            items={[
              {
                key: "identity",
                label: "Frozen plan identity",
                children: (
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
                ),
              },
            ]}
          />
          {run.workItemKind === "pull_request" && <Policy run={run} />}
          <IssueReproductionSummary key={`reproduction:${run.id}`} run={run} />
        </>
      )}
      <ReviewRunDecisions key={`decisions:${run.id}`} run={run} />
      {!checking && (
        <>
          <Typography.Title level={5}>Execution requests</Typography.Title>
          <Table<DashboardReviewRunRequest>
            size="small"
            rowKey="requestId"
            dataSource={run.requests}
            pagination={false}
            scroll={{ x: 1_080 }}
            columns={[
              {
                title: "Workflow / target",
                render: (_, request) => (
                  <Space orientation="vertical" size={0}>
                    <Typography.Text strong>
                      {requestTargetLabel(request.workflowKind, request.target)}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {request.profile
                        ? `${request.profile.name} · v${request.profile.version}`
                        : "Profile not configured"}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: "Required",
                dataIndex: "required",
                render: (value: boolean) => (value ? "Required" : "Optional"),
              },
              {
                title: "Execution prerequisites",
                dataIndex: "readiness",
                render: (value: string) => (
                  <Tag color={value === "blocked" ? "warning" : "default"}>{readable(value)}</Tag>
                ),
              },
              {
                title: "Execution",
                render: (_, request) =>
                  executionLabel(request.latestJob?.status, request.latestJob?.admission ?? null),
              },
              {
                title: "Worker checks",
                width: 205,
                render: (_, request) => (
                  <Space orientation="vertical" size={4}>
                    <span>{summarizeCheckOutcomes(request.latestResult?.checks)}</span>
                    {requestEvidencePending(request) && (
                      <Tag color="processing">{evidenceVerificationPendingLabel}</Tag>
                    )}
                  </Space>
                ),
              },
              ...(run.workItemKind === "pull_request"
                ? [
                    {
                      title: "Model recommendation",
                      render: (_: unknown, request: DashboardReviewRunRequest) =>
                        recommendationLabel(request.latestResult?.recommendation),
                    },
                  ]
                : []),
              {
                title: "Action",
                render: (_, request) => (
                  <Button
                    type={request.requestId === selectedRequestId ? "primary" : "default"}
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
            <Typography.Paragraph type="secondary">
              Select a request to inspect its frozen versions, readiness blockers, and job history.
            </Typography.Paragraph>
          )}
        </>
      )}
    </Space>
  );
}
