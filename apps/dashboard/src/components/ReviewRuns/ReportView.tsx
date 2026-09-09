import type {
  DashboardReviewRunResult,
  DashboardValidationModelReview,
  ValidationCheckResult,
  ValidationStepDiagnostic,
} from "@agentic-review/contracts";
import { Alert, Collapse, Empty, Space, Table, Tabs, Tag, Typography } from "antd";
import { CliExecutionDetails } from "@/components/CliExecutionDetails";
import { FindingReview } from "@/components/FindingReview";
import { IssueReproductionResult } from "@/components/IssueReproduction";
import { findings } from "@/services/findings";
import { CopyValue, EvidenceIds, Facts, Prose, readable, timestamp } from "./common";
import { EvidenceView } from "./EvidenceView";
import { evidenceVerificationPendingLabel } from "./evidence-verification";
import { outcomePresentation, recommendationLabel } from "./presentation";

function CheckOutcome({ outcome }: { outcome: ValidationCheckResult["outcome"] }) {
  const presentation = outcomePresentation(outcome);
  return <Tag color={presentation.tone}>{presentation.label}</Tag>;
}

function Checks({ result }: { result: DashboardReviewRunResult }) {
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Prose>{result.report.summary}</Prose>
      <Facts
        items={[
          { label: "Report source", value: "Worker" },
          { label: "Source state", value: readable(result.report.sourceState) },
          ...(result.report.workItemKind === "issue"
            ? [
                {
                  label: "Recorded worker reproduction conclusion",
                  value: readable(result.report.reproductionConclusion),
                },
              ]
            : []),
        ]}
      />
      {result.report.sourceState !== "original" && (
        <Alert
          showIcon
          type="warning"
          title={
            result.report.sourceState === "modified"
              ? "The tested source was modified during execution"
              : "The final source state is unknown"
          }
          description="Assess these checks with the recorded source state and run policy."
        />
      )}
      <Typography.Paragraph type="secondary">
        Expand a check to compare expected and actual behavior and inspect its evidence references.
      </Typography.Paragraph>
      <Table<ValidationCheckResult>
        size="small"
        rowKey="id"
        dataSource={result.report.checks}
        scroll={{ x: 720 }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No checks were recorded. Validation has not been established."
            />
          ),
        }}
        pagination={{ defaultPageSize: 10, pageSizeOptions: [10, 20, 50], showSizeChanger: true }}
        columns={[
          {
            title: "Check",
            dataIndex: "name",
            render: (name: string, check) => (
              <Space orientation="vertical" size={0}>
                <Typography.Text strong>{name}</Typography.Text>
                <CopyValue value={check.id} />
              </Space>
            ),
          },
          { title: "Kind", dataIndex: "kind", render: (kind: string) => readable(kind) },
          { title: "Source", dataIndex: "source", render: (source: string) => readable(source) },
          {
            title: "Required",
            dataIndex: "required",
            render: (required: boolean) => (required ? "Required" : "Optional"),
          },
          {
            title: "Outcome",
            dataIndex: "outcome",
            render: (outcome: ValidationCheckResult["outcome"]) => (
              <CheckOutcome outcome={outcome} />
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (check) => (
            <Facts
              items={[
                { label: "Summary", value: <Prose>{check.summary}</Prose> },
                { label: "Expected", value: <Prose>{check.expected ?? "Not recorded"}</Prose> },
                { label: "Actual", value: <Prose>{check.actual ?? "Not recorded"}</Prose> },
                { label: "Evidence IDs", value: <EvidenceIds ids={check.evidenceIds} /> },
              ]}
            />
          ),
        }}
      />
    </Space>
  );
}

function ModelReview({
  model,
  workItemKind,
}: {
  model: DashboardValidationModelReview;
  workItemKind: "issue" | "pull_request";
}) {
  const issue = model.issueTriage;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Facts
        items={[
          { label: "Model review", value: readable(model.state) },
          ...(workItemKind === "pull_request"
            ? [{ label: "Model recommendation", value: recommendationLabel(model.recommendation) }]
            : [
                {
                  label: "Model reproduction conclusion",
                  value: model.reproductionConclusion
                    ? readable(model.reproductionConclusion)
                    : "Not reported",
                },
              ]),
        ]}
      />
      {model.error && (
        <Alert
          showIcon
          type="error"
          title={`Model review failed: ${model.error.code}`}
          description={model.error.message}
        />
      )}
      <CliExecutionDetails execution={model.execution} />
      <Prose>{model.summary ?? "No model summary was recorded."}</Prose>
      <Typography.Paragraph type="secondary">
        {workItemKind === "pull_request"
          ? "Model recommendations are separate from worker checks and policy eligibility."
          : "Model reproduction conclusions are separate from the worker's recorded checks and observations."}
      </Typography.Paragraph>
      {findings.mode === "sample" && (
        <>
          <Typography.Title level={5}>Model findings</Typography.Title>
          {model.findings.length ? (
            <Collapse
              items={model.findings.map((finding, ordinal) => ({
                key: `finding:${ordinal}:${finding.findingId}`,
                label: (
                  <Space>
                    <Tag color={finding.priority < 2 ? "warning" : "default"}>
                      P{finding.priority}
                    </Tag>
                    {finding.title}
                  </Space>
                ),
                children: (
                  <>
                    <Prose>{finding.body}</Prose>
                    <Facts
                      items={[
                        {
                          label: "Location",
                          value: `${finding.path}:${finding.line}${finding.endLine === null ? "" : `–${finding.endLine}`}`,
                        },
                        { label: "Confidence", value: `${Math.round(finding.confidence * 100)}%` },
                        { label: "Finding ID", value: <CopyValue value={finding.findingId} /> },
                      ]}
                    />
                  </>
                ),
              }))}
            />
          ) : (
            <Typography.Text type="secondary">
              {model.state === "completed"
                ? "No findings were reported by the model."
                : "No findings are available from a completed model review."}
            </Typography.Text>
          )}
          <Typography.Title level={5}>Model observations</Typography.Title>
          {model.observations.length ? (
            <Collapse
              items={model.observations.map((observation, ordinal) => ({
                key: `observation:${ordinal}:${observation.id}`,
                label: `P${observation.priority} · ${observation.title}`,
                children: (
                  <>
                    <Prose>{observation.body}</Prose>
                    <Facts
                      items={[
                        { label: "Observation ID", value: <CopyValue value={observation.id} /> },
                        {
                          label: "Location",
                          value: observation.path
                            ? `${observation.path}${observation.line === null ? "" : `:${observation.line}`}`
                            : "Not recorded",
                        },
                      ]}
                    />
                  </>
                ),
              }))}
            />
          ) : (
            <Typography.Text type="secondary">No model observations were recorded.</Typography.Text>
          )}
        </>
      )}
      {workItemKind === "issue" && (
        <>
          <Typography.Title level={5}>Issue triage</Typography.Title>
          {issue ? (
            <Facts
              items={[
                { label: "Category", value: readable(issue.category) },
                { label: "Priority", value: `P${issue.priority}` },
                { label: "Confidence", value: `${Math.round(issue.confidence * 100)}%` },
                {
                  label: "Suggested labels",
                  value: issue.suggestedLabels.length
                    ? issue.suggestedLabels.map((label) => <Tag key={label}>{label}</Tag>)
                    : "None suggested",
                },
                {
                  label: "Missing information",
                  value: issue.missingInformation.length ? (
                    <ul>
                      {issue.missingInformation.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    "None requested"
                  ),
                },
                {
                  label: "Possible duplicates",
                  value: issue.duplicateCandidates.length ? (
                    <ul>
                      {issue.duplicateCandidates.map((candidate) => (
                        <li key={candidate.number}>
                          #{candidate.number}: {candidate.reason}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "None reported"
                  ),
                },
              ]}
            />
          ) : (
            <Typography.Text type="secondary">No issue triage report was recorded.</Typography.Text>
          )}
        </>
      )}
    </Space>
  );
}

function Execution({ result }: { result: DashboardReviewRunResult }) {
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Facts items={[{ label: "Cleanup", value: readable(result.execution.cleanupState) }]} />
      <Typography.Title level={5}>Execution blockers</Typography.Title>
      {result.execution.blockers.length ? (
        <Table
          size="small"
          rowKey={(_, index) => `blocker-${index}`}
          dataSource={result.execution.blockers}
          scroll={{ x: 680 }}
          pagination={{ defaultPageSize: 10, showSizeChanger: false }}
          columns={[
            { title: "Phase", dataIndex: "phase", render: (value: string) => readable(value) },
            { title: "Step", dataIndex: "stepId", render: (value) => <CopyValue value={value} /> },
            { title: "Code", dataIndex: "code" },
            { title: "Message", dataIndex: "message" },
          ]}
        />
      ) : (
        <Typography.Text type="secondary">No lifecycle blockers were recorded.</Typography.Text>
      )}
      <Typography.Title level={5}>Step diagnostics</Typography.Title>
      <Table<ValidationStepDiagnostic>
        size="small"
        rowKey={(_, index) => `diagnostic-${index}`}
        dataSource={result.execution.diagnostics}
        scroll={{ x: 700 }}
        locale={{ emptyText: "No step diagnostics were recorded." }}
        pagination={{ defaultPageSize: 10, pageSizeOptions: [10, 20, 50], showSizeChanger: true }}
        columns={[
          { title: "Step", dataIndex: "stepId", render: (value) => <CopyValue value={value} /> },
          { title: "Phase", dataIndex: "phase", render: (value: string) => readable(value) },
          {
            title: "Outcome",
            dataIndex: "outcome",
            render: (outcome: ValidationStepDiagnostic["outcome"]) => (
              <CheckOutcome outcome={outcome} />
            ),
          },
          {
            title: "Exit code",
            dataIndex: "exitCode",
            render: (value: number | null) => value ?? "Not recorded",
          },
          { title: "Summary", dataIndex: "summary" },
        ]}
        expandable={{
          rowExpandable: (diagnostic) =>
            diagnostic.stdout !== undefined || diagnostic.stderr !== undefined,
          expandedRowRender: (diagnostic) => (
            <Facts
              items={[
                {
                  label: "Standard output",
                  value: <Prose>{diagnostic.stdout ?? "Not captured"}</Prose>,
                },
                {
                  label: "Standard error",
                  value: <Prose>{diagnostic.stderr ?? "Not captured"}</Prose>,
                },
              ]}
            />
          ),
        }}
      />
    </Space>
  );
}

function Evidence({ result }: { result: DashboardReviewRunResult }) {
  const evidenceIds = [...new Set(result.report.checks.flatMap((check) => check.evidenceIds))];
  return (
    <EvidenceView
      scope={{
        repositoryId: result.repositoryId,
        runId: result.reviewRunId,
        jobId: result.jobId,
        runAttemptId: result.runAttemptId,
        requestId: result.requestId,
        profileVersionId: result.profileVersionId,
        revisionKey: result.revisionKey,
        planDigest: result.planDigest,
      }}
      references={evidenceIds.map((id) => ({
        id,
        checkIds: result.report.checks
          .filter((check) => check.evidenceIds.includes(id))
          .map((check) => check.id),
      }))}
    />
  );
}

export function ReportView({ result }: { result: DashboardReviewRunResult }) {
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {result.evidenceVerificationPending === true && (
        <Alert
          showIcon
          type="info"
          title={evidenceVerificationPendingLabel}
          description={`The recorded runner checks remain available while the server verifies their evidence.${result.report.workItemKind === "pull_request" ? " This pending verification does not establish approval eligibility." : " Recorded reproduction observations are unchanged."} Automatic refresh is limited; use Refresh result if verification is still pending.`}
        />
      )}
      {!result.authoritative && (
        <Alert
          showIcon
          type="warning"
          title="Historical result"
          description={
            result.report.workItemKind === "issue"
              ? "This result is not current for its request. Its recorded reproduction assessment remains historical; inspect the current assessment and latest execution."
              : "This result is not authoritative for its request. Review the latest execution and run policy before making a decision."
          }
        />
      )}
      <Collapse
        items={[
          {
            key: "identity",
            label: "Saved result identity",
            children: (
              <Facts
                items={[
                  { label: "Result ID", value: <CopyValue value={result.id} /> },
                  { label: "Job ID", value: <CopyValue value={result.jobId} /> },
                  { label: "Run attempt ID", value: <CopyValue value={result.runAttemptId} /> },
                  { label: "Activation", value: result.activationNumber },
                  { label: "Saved", value: timestamp(result.createdAt) },
                  {
                    label: "Authoritative for request",
                    value: result.authoritative ? "Yes" : "No",
                  },
                  { label: "Revision key", value: <CopyValue value={result.revisionKey} /> },
                  { label: "Plan digest", value: <CopyValue value={result.planDigest} /> },
                  {
                    label: "Profile version ID",
                    value: <CopyValue value={result.profileVersionId} />,
                  },
                  {
                    label: "Prompt version ID",
                    value: <CopyValue value={result.promptVersionId} />,
                  },
                  {
                    label: "Worker result digest",
                    value: <CopyValue value={result.resultDigest} />,
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Tabs
        defaultActiveKey={result.reproduction ? "reproduction" : "checks"}
        items={[
          ...(result.report.workItemKind === "issue"
            ? [
                {
                  key: "reproduction",
                  label: "Issue reproduction",
                  children: <IssueReproductionResult result={result} />,
                },
              ]
            : []),
          { key: "checks", label: "Worker checks", children: <Checks result={result} /> },
          {
            key: "model",
            label: "Model review",
            children: (
              <ModelReview model={result.modelReview} workItemKind={result.report.workItemKind} />
            ),
          },
          {
            key: "findings",
            label: "Findings and dispositions",
            children: <FindingReview result={result} />,
          },
          {
            key: "execution",
            label: "Execution diagnostics",
            children: <Execution result={result} />,
          },
          { key: "evidence", label: "Evidence files", children: <Evidence result={result} /> },
        ]}
      />
    </Space>
  );
}
