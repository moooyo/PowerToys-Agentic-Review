import type * as C from "@agentic-review/contracts";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  createHttpEvaluationAdjudicationAdapter,
  type EvaluationAdjudicationAdapter,
} from "@/services/evaluation-adjudication";
import type { EvaluationBatchAdapter } from "@/services/evaluation-batches";
import {
  createHttpEvaluationEvidenceAdapter,
  type EvaluationEvidenceAdapter,
} from "@/services/evaluation-evidence";
import { Adjudication } from "./Adjudication";
import { armLabels } from "./batch-state";
import {
  assertCellResultBinding,
  type CellResultBinding,
  cellResultBindingKey,
  currentEvidenceLabel,
} from "./cell-result-state";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { EvaluationEvidence } from "./EvaluationEvidence";
import { errorMessage } from "./state";

export function CellResultContent({
  result,
  evidenceAdapter,
  active = true,
}: {
  result: C.EvaluationCellResultV1;
  evidenceAdapter?: EvaluationEvidenceAdapter;
  active?: boolean;
}) {
  const model = result.modelReview;
  const evidenceIds = [...new Set(result.report.checks.flatMap((check) => check.evidenceIds))];
  return (
    <div className="evaluation-cell-result">
      <Alert
        type="info"
        showIcon
        title="Recorded execution and model advice"
        description="Check outcomes and model recommendations do not approve a pull request. Expected check values are execution assertions, not the sample set's assessment labels."
      />
      <Descriptions
        size="small"
        column={2}
        items={[
          {
            key: "result",
            label: "Result",
            children: <Typography.Text copyable>{result.resultId}</Typography.Text>,
          },
          {
            key: "arm",
            label: "Arm",
            children: `${armLabels[result.arm]} · trial ${result.trial}`,
          },
          {
            key: "source",
            label: "Source state",
            children: <Tag>{result.report.sourceState}</Tag>,
          },
          {
            key: "evidence",
            label: "Evidence",
            children: <Tag>{currentEvidenceLabel(result)}</Tag>,
          },
          {
            key: "revision",
            label: "Frozen revision",
            children: <span className="evaluation-meta">{result.revisionKey}</span>,
          },
          {
            key: "attempt",
            label: "Job attempt",
            children: (
              <span className="evaluation-meta">
                {result.jobId} · {result.runAttemptId}
              </span>
            ),
          },
          {
            key: "profile",
            label: "Profile version",
            children: <span className="evaluation-meta">{result.profileVersionId}</span>,
          },
          {
            key: "prompt",
            label: "Prompt version",
            children: <span className="evaluation-meta">{result.promptVersionId}</span>,
          },
          { key: "cleanup", label: "Cleanup", children: result.execution.cleanupState },
          { key: "created", label: "Recorded", children: result.createdAt },
        ]}
      />
      <Typography.Paragraph>{result.report.summary}</Typography.Paragraph>
      {result.report.workItemKind === "issue" ? (
        <p>Runner reproduction conclusion: {result.report.reproductionConclusion}</p>
      ) : null}
      <Typography.Title level={5}>Checks</Typography.Title>
      <Table<C.ValidationCheckResult>
        rowKey="id"
        size="small"
        dataSource={result.report.checks}
        pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: 700 }}
        columns={[
          {
            title: "Check",
            key: "check",
            render: (_, check) => (
              <div>
                <strong>{check.name}</strong>
                <span className="evaluation-meta">
                  {check.id} · {check.kind} · {check.source} ·{" "}
                  {check.required ? "Required" : "Optional"}
                </span>
                <p>{check.summary}</p>
              </div>
            ),
          },
          { title: "Outcome", dataIndex: "outcome", key: "outcome", width: 105 },
          {
            title: "Expected",
            key: "expected",
            render: (_, check) => (
              <span className="evaluation-result-text">{check.expected ?? "Not recorded"}</span>
            ),
          },
          {
            title: "Actual",
            key: "actual",
            render: (_, check) => (
              <span className="evaluation-result-text">{check.actual ?? "Not recorded"}</span>
            ),
          },
          {
            title: "Evidence IDs",
            key: "evidence",
            render: (_, check) =>
              check.evidenceIds.map((id) => (
                <span key={id} className="evaluation-meta">
                  {id}
                </span>
              )),
          },
        ]}
      />
      <Typography.Title level={5}>Execution diagnostics</Typography.Title>
      {result.execution.blockers.length ? (
        <Table<C.ValidationLifecycleBlocker & { ordinal: number }>
          rowKey="ordinal"
          size="small"
          dataSource={result.execution.blockers.map((blocker, ordinal) => ({
            ...blocker,
            ordinal,
          }))}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          columns={[
            { title: "Phase", dataIndex: "phase", key: "phase" },
            { title: "Code", dataIndex: "code", key: "code" },
            { title: "Blocker", dataIndex: "message", key: "message" },
          ]}
        />
      ) : (
        <Typography.Text type="secondary">No execution blockers were recorded.</Typography.Text>
      )}
      <Table<C.ValidationStepDiagnostic & { ordinal: number }>
        rowKey="ordinal"
        size="small"
        dataSource={result.execution.diagnostics.map((diagnostic, ordinal) => ({
          ...diagnostic,
          ordinal,
        }))}
        pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
        columns={[
          {
            title: "Step",
            key: "step",
            render: (_, diagnostic) => (
              <span className="evaluation-meta">
                {diagnostic.phase} · {diagnostic.stepId}
              </span>
            ),
          },
          {
            title: "Outcome",
            key: "outcome",
            render: (_, diagnostic) =>
              `${diagnostic.outcome} · exit ${diagnostic.exitCode ?? "not recorded"}`,
          },
          {
            title: "Diagnostic",
            key: "diagnostic",
            render: (_, diagnostic) => (
              <div>
                <p>{diagnostic.summary}</p>
                {diagnostic.stdout !== undefined ? (
                  <pre className="evaluation-source-body">{diagnostic.stdout}</pre>
                ) : null}
                {diagnostic.stderr !== undefined ? (
                  <pre className="evaluation-source-body">{diagnostic.stderr}</pre>
                ) : null}
              </div>
            ),
          },
        ]}
      />
      <Card
        size="small"
        title="Model advice"
        extra={<Tag>{result.modelRequirements.required ? model.state : "Not required"}</Tag>}
      >
        {!result.modelRequirements.required ? (
          <Typography.Paragraph>
            Model execution was not required for this cell. This is not a model failure.
          </Typography.Paragraph>
        ) : null}
        {result.modelRequirements.required && model.error ? (
          <Alert type="warning" title={model.error.code} description={model.error.message} />
        ) : null}
        {model.summary ? <Typography.Paragraph>{model.summary}</Typography.Paragraph> : null}
        {model.recommendation ? <p>Model recommendation: {model.recommendation}</p> : null}
        {model.reproductionConclusion ? (
          <p>Model reproduction advice: {model.reproductionConclusion}</p>
        ) : null}
        {model.issueTriage ? (
          <Descriptions
            size="small"
            column={1}
            items={[
              {
                key: "triage",
                label: "Triage",
                children: `${model.issueTriage.category} · priority ${model.issueTriage.priority} · confidence ${model.issueTriage.confidence}`,
              },
              {
                key: "labels",
                label: "Suggested labels",
                children: model.issueTriage.suggestedLabels.join(", ") || "None",
              },
              {
                key: "missing",
                label: "Missing information",
                children: model.issueTriage.missingInformation.join("; ") || "None",
              },
              {
                key: "duplicates",
                label: "Duplicate candidates",
                children:
                  model.issueTriage.duplicateCandidates
                    .map((entry) => JSON.stringify(entry))
                    .join("; ") || "None",
              },
            ]}
          />
        ) : null}
        <Typography.Title level={5}>Findings</Typography.Title>
        <Table
          rowKey="ordinal"
          size="small"
          dataSource={model.findings}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          columns={[
            { title: "Priority", dataIndex: "priority", key: "priority", width: 80 },
            {
              title: "Finding",
              key: "finding",
              render: (_, finding) => (
                <div>
                  <strong>{finding.title}</strong>
                  <p className="evaluation-result-text">{finding.body}</p>
                  <span className="evaluation-meta">
                    {finding.findingId} · occurrence {finding.ordinal} · {finding.path ?? "No file"}
                    {finding.line ? `:${finding.line}` : ""}
                  </span>
                </div>
              ),
            },
          ]}
        />
        <Typography.Title level={5}>Observations</Typography.Title>
        <Table<C.ValidationObservation & { ordinal: number }>
          rowKey="ordinal"
          size="small"
          dataSource={model.observations.map((observation, ordinal) => ({
            ...observation,
            ordinal,
          }))}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          columns={[
            { title: "Priority", dataIndex: "priority", key: "priority", width: 80 },
            {
              title: "Observation",
              key: "observation",
              render: (_, observation) => (
                <div>
                  <strong>{observation.title}</strong>
                  <p className="evaluation-result-text">{observation.body}</p>
                  <span className="evaluation-meta">
                    {observation.id} · {observation.path ?? "No file"}
                    {observation.line ? `:${observation.line}` : ""}
                  </span>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {evidenceAdapter ? (
        <EvaluationEvidence result={result} adapter={evidenceAdapter} active={active} />
      ) : (
        <>
          <Typography.Title level={5}>Evidence references</Typography.Title>
          <p className="evaluation-meta">
            These are the result's recorded evidence IDs. Evaluation evidence download is not
            available in this view; no file availability is inferred from an ID.
          </p>
          {evidenceIds.length ? (
            <Space orientation="vertical">
              {evidenceIds.map((id) => (
                <Typography.Text key={id} copyable>
                  {id}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            <Typography.Text type="secondary">No evidence IDs were recorded.</Typography.Text>
          )}
        </>
      )}
    </div>
  );
}

export interface RetainedAdjudicationResult {
  identity: string;
  result: C.EvaluationCellResultV1;
}
export function retainAdjudicationResult(
  previous: RetainedAdjudicationResult | null,
  identity: string | null,
  verified: C.EvaluationCellResultV1 | undefined,
): RetainedAdjudicationResult | null {
  if (identity === null) return previous;
  if (verified) return { identity, result: verified };
  return previous?.identity === identity ? previous : null;
}

export function CellResultDrawer({
  api,
  binding,
  active,
  onClose,
  evidenceAdapter,
  adjudicationAdapter,
}: {
  api: EvaluationBatchAdapter;
  binding: CellResultBinding | null;
  active: boolean;
  onClose: () => void;
  evidenceAdapter?: EvaluationEvidenceAdapter;
  adjudicationAdapter?: EvaluationAdjudicationAdapter;
}) {
  const page = useEvaluationPage();
  const evidence = useMemo(
    () => evidenceAdapter ?? createHttpEvaluationEvidenceAdapter(),
    [evidenceAdapter],
  );
  const adjudication = useMemo(
    () => adjudicationAdapter ?? createHttpEvaluationAdjudicationAdapter(),
    [adjudicationAdapter],
  );
  const [adjudicationResult, setAdjudicationResult] = useState<RetainedAdjudicationResult | null>(
    null,
  );
  const identity = binding ? cellResultBindingKey(binding) : null;
  const query = useEvaluationQuery(
    ["cell-result", binding ? cellResultBindingKey(binding) : null],
    async (signal) => {
      if (!binding) throw new Error("Select a current result before reading it.");
      const result = await api.getCellResult(binding.scope, signal);
      assertCellResultBinding(result, binding);
      return result;
    },
    active && binding !== null,
  );
  useEffect(() => {
    setAdjudicationResult((previous) =>
      retainAdjudicationResult(
        previous,
        identity,
        !query.isFetching && !query.error ? query.data : undefined,
      ),
    );
  }, [identity, query.data, query.isFetching, query.error]);
  const adjudicationActive =
    active &&
    page.readable &&
    identity !== null &&
    identity === adjudicationResult?.identity &&
    !query.isFetching &&
    !query.error &&
    query.data !== undefined;
  const close = () => {
    setAdjudicationResult(null);
    onClose();
  };
  return (
    <Drawer
      title={
        binding
          ? `${armLabels[binding.expected.arm]} result · ${binding.caseTitle}`
          : "Evaluation result"
      }
      open={active && page.readable && binding !== null}
      onClose={close}
      getContainer={false}
      rootStyle={{ position: "fixed" }}
      styles={{ wrapper: { maxWidth: "96vw" } }}
      size={1100}
      extra={
        <Button
          disabled={!active || !page.readable || !binding}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh evidence
        </Button>
      }
    >
      {query.isFetching || query.isPending ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : query.error ? (
        <Alert type="error" title="Result unavailable" description={errorMessage(query.error)} />
      ) : active && binding && query.data ? (
        <CellResultContent
          result={query.data}
          evidenceAdapter={evidence}
          active={active && page.readable}
        />
      ) : null}
      {adjudicationResult && (identity === null || identity === adjudicationResult.identity) ? (
        <div
          hidden={!adjudicationActive}
          inert={!adjudicationActive}
          aria-hidden={!adjudicationActive}
        >
          <Adjudication
            key={JSON.stringify([page.session, adjudicationResult.identity])}
            result={adjudicationResult.result}
            adapter={adjudication}
            active={adjudicationActive}
          />
        </div>
      ) : null}
    </Drawer>
  );
}
