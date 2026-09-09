import type {
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunResult,
  IssueReproductionAssessmentV1,
  IssueReproductionCaseAssessment,
  ObservationEquals,
} from "@agentic-review/contracts";
import { Alert, Space, Table, Tag, theme, Typography } from "antd";
import { CopyValue, EvidenceIds, Facts, Prose } from "../ReviewRuns/common";
import {
  observationFactLabel,
  observationRefKey,
  observationRefLabel,
  observationValueLabel,
  reproductionCasePresentation,
  reproductionConclusionPresentation,
  reproductionReasonLabel,
  reproductionTargetLabel,
} from "./state";

export function CaseState({
  assessment,
  current = true,
}: {
  assessment?: IssueReproductionCaseAssessment | null;
  current?: boolean;
}) {
  const view = reproductionCasePresentation(assessment, current);
  return <Tag color={view.tone}>{view.label}</Tag>;
}

export function AssessmentSummary({
  assessment,
  recorded,
}: {
  assessment: Pick<
    IssueReproductionAssessmentV1,
    "cases" | "conclusion" | "coverage" | "rulesVersion"
  >;
  recorded?: Pick<
    IssueReproductionAssessmentV1,
    "cases" | "conclusion" | "coverage" | "rulesVersion"
  >;
}) {
  const { token } = theme.useToken();
  const assessments = [
    { title: "Current assessment", value: assessment, current: true },
    ...(recorded ? [{ title: "Recorded assessment", value: recorded, current: false }] : []),
  ];
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
          gap: token.margin,
        }}
      >
        {assessments.map(({ title, value, current }) => {
          const view = reproductionConclusionPresentation(value, current);
          return (
            <section
              key={title}
              aria-label={title}
              style={{
                borderInlineStart: `3px solid ${current ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
                paddingInlineStart: token.paddingSM,
              }}
            >
              <Typography.Text type="secondary">{title}</Typography.Text>
              <div style={{ marginBlock: token.marginXS }}>
                <Tag color={view.tone}>{view.label}</Tag>
                <Typography.Text>
                  {value.coverage === "complete" ? "Complete coverage" : "Partial coverage"}
                </Typography.Text>
              </div>
              <Typography.Text type="secondary">
                {value.cases.length} configured case(s) · rules version {value.rulesVersion}
              </Typography.Text>
            </section>
          );
        })}
      </div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        A confirmed case establishes the claim only in its frozen context. Not reproduced requires
        an explicit absent signature for every configured case. Missing observations never establish
        absence. Coverage describes these configured cases, not all environments.
      </Typography.Paragraph>
      {recorded && (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          The recorded assessment is preserved from this saved result. The current assessment also
          considers whether the execution is still current and its required evidence remains
          available.
        </Typography.Paragraph>
      )}
    </Space>
  );
}

export function CaseAssessmentComparison({
  detail,
}: {
  detail: DashboardReviewRunReproductionCaseResponse;
}) {
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Facts
        items={[
          { label: "Current case state", value: <CaseState assessment={detail.current} /> },
          {
            label: "Recorded case state",
            value: <CaseState assessment={detail.recorded} current={false} />,
          },
        ]}
      />
      {detail.current.reasons.length > 0 && (
        <Alert
          showIcon
          type={detail.current.reasons.includes("execution_pending") ? "info" : "warning"}
          title="Current assessment reasons"
          description={
            <ul style={{ marginBottom: 0, paddingInlineStart: 20 }}>
              {detail.current.reasons.map((reason) => (
                <li key={reason}>{reproductionReasonLabel[reason]}</li>
              ))}
            </ul>
          }
        />
      )}
      {detail.recorded && detail.recorded.reasons.length > 0 && (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Recorded reasons:{" "}
          {detail.recorded.reasons.map((reason) => reproductionReasonLabel[reason]).join("; ")}.
        </Typography.Paragraph>
      )}
    </Space>
  );
}

function Signature({
  title,
  predicates,
  detail,
}: {
  title: string;
  predicates: ObservationEquals[];
  detail: DashboardReviewRunReproductionCaseResponse;
}) {
  const rows = predicates.map((predicate, index) => ({
    key: `${title}:${index}`,
    predicate,
    fact: detail.observations.find(
      (fact) => observationRefKey(fact.observation) === observationRefKey(predicate.observation),
    ),
  }));
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Typography.Text strong>{title} · all conditions must hold</Typography.Text>
      <Table
        size="small"
        rowKey="key"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 680 }}
        columns={[
          {
            title: "Selected observation",
            width: "36%",
            render: (_, row) => observationRefLabel(row.predicate.observation),
          },
          {
            title: "Expected value",
            width: "28%",
            render: (_, row) => (
              <Typography.Text code>{observationValueLabel(row.predicate.equals)}</Typography.Text>
            ),
          },
          {
            title: "Observed fact",
            render: (_, row) => (
              <Space orientation="vertical" size={4}>
                <Typography.Text code={row.fact?.state === "observed"}>
                  {observationFactLabel(row.fact)}
                </Typography.Text>
                {row.fact && <EvidenceIds ids={row.fact.evidenceIds} />}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

export function ReproductionCaseFacts({
  detail,
  result,
}: {
  detail: DashboardReviewRunReproductionCaseResponse;
  result: DashboardReviewRunResult | null;
}) {
  const selected = detail.case;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <CaseAssessmentComparison detail={detail} />
      <Typography.Title level={5} style={{ margin: 0 }}>
        Frozen case context
      </Typography.Title>
      <Prose>{selected.context}</Prose>
      <Facts
        items={[
          { label: "Case ID", value: <CopyValue value={selected.id} /> },
          { label: "Execution target", value: reproductionTargetLabel[selected.target] },
          {
            label: "Tested source commit",
            value: <CopyValue value={detail.binding.testedSourceCommit} />,
          },
          { label: "Profile version ID", value: <CopyValue value={selected.profileVersionId} /> },
          {
            label: "Profile configuration digest",
            value: <CopyValue value={selected.profileConfigSha256} />,
          },
        ]}
      />
      <Typography.Text strong>Preconditions · all required</Typography.Text>
      {selected.preconditions.length === 0 ? (
        <Typography.Text type="secondary">
          No additional preconditions were configured.
        </Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey={(_, index) => `precondition:${index}`}
          dataSource={selected.preconditions}
          pagination={false}
          scroll={{ x: 680 }}
          columns={[
            {
              title: "Required condition",
              width: "36%",
              render: (_, precondition) =>
                precondition.kind === "check_passed"
                  ? `Worker check · ${precondition.checkId}`
                  : observationRefLabel(precondition.predicate.observation),
            },
            {
              title: "Expected value",
              width: "28%",
              render: (_, precondition) =>
                precondition.kind === "check_passed" ? (
                  "Passed"
                ) : (
                  <Typography.Text code>
                    {observationValueLabel(precondition.predicate.equals)}
                  </Typography.Text>
                ),
            },
            {
              title: "Observed fact",
              render: (_, precondition) => {
                if (precondition.kind === "check_passed") {
                  const check = result?.report.checks.find(
                    (entry) => entry.id === precondition.checkId,
                  );
                  return (
                    <Space orientation="vertical" size={4}>
                      <Typography.Text>
                        {check
                          ? `Recorded check · ${check.outcome.replaceAll("_", " ")}`
                          : "Check outcome not recorded"}
                      </Typography.Text>
                      {check && <EvidenceIds ids={check.evidenceIds} />}
                    </Space>
                  );
                }
                const fact = detail.observations.find(
                  (entry) =>
                    observationRefKey(entry.observation) ===
                    observationRefKey(precondition.predicate.observation),
                );
                return (
                  <Typography.Text code={fact?.state === "observed"}>
                    {observationFactLabel(fact)}
                  </Typography.Text>
                );
              },
            },
          ]}
        />
      )}
      <Signature
        title="Present signature"
        predicates={selected.presentWhen.allOf}
        detail={detail}
      />
      {selected.absentWhen ? (
        <Signature
          title="Absent signature"
          predicates={selected.absentWhen.allOf}
          detail={detail}
        />
      ) : (
        <Alert
          showIcon
          type="info"
          title="No absent signature configured"
          description="This case can establish presence. Failure to match the present signature cannot establish absence."
        />
      )}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        These are the selected typed facts supplied by the server. Unavailable captures, missing
        elements, and missing evidence do not become an observed false value. This comparison does
        not change the recorded or current assessment.
      </Typography.Paragraph>
    </Space>
  );
}
