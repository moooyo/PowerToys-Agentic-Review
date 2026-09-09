import type {
  FindingComparisonResponse,
  FindingDispositionEvent,
  FindingListSummary,
  FindingOccurrence,
  FindingResultContext,
} from "@agentic-review/contracts";
import { Alert, Collapse, Space, Table, Tag, Typography } from "antd";
import { CopyValue, Facts, Prose, readable, timestamp } from "../ReviewRuns/common";
import { findingActionLabel, findingStateLabel } from "./state";

export function FindingBinding({ context }: { context: FindingResultContext }) {
  return (
    <Facts
      items={[
        { label: "Result ID", value: <CopyValue value={context.resultId} /> },
        { label: "Result digest", value: <CopyValue value={context.resultDigest} /> },
        { label: "Source revision key", value: <CopyValue value={context.revisionKey} /> },
        { label: "Plan digest", value: <CopyValue value={context.planDigest} /> },
        { label: "Saved", value: timestamp(context.createdAt) },
        { label: "Execution context digest", value: <CopyValue value={context.contextDigest} /> },
        { label: "Source current", value: context.sourceCurrent ? "Yes" : "No" },
        { label: "Latest activation for request", value: context.latestForRequest ? "Yes" : "No" },
        { label: "Review run", value: <CopyValue value={context.reviewRunId} /> },
        { label: "Request", value: <CopyValue value={context.requestId} /> },
        { label: "Job", value: <CopyValue value={context.jobId} /> },
        {
          label: "Workflow / target",
          value: `${readable(context.workflowKind)} / ${readable(context.target)}`,
        },
        { label: "Profile version", value: <CopyValue value={context.profileVersionId} /> },
        { label: "Prompt version", value: <CopyValue value={context.promptVersionId} /> },
      ]}
    />
  );
}

export function FindingSummary({ summary }: { summary: FindingListSummary }) {
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Facts
        items={[
          { label: "Reported P0 / P1 findings", value: summary.rawBlocking },
          { label: "Unresolved P0 / P1 findings", value: summary.unresolvedBlocking },
          { label: "Open", value: summary.open },
          { label: "Confirmed · unresolved", value: summary.accepted },
          { label: "Dismissed", value: summary.dismissed },
          { label: "Resolved by reviewer", value: summary.resolved },
        ]}
      />
      <Typography.Paragraph type="secondary">
        Confirming an issue keeps it unresolved. Dismissal and a recorded resolution affect finding
        eligibility only; required checks and evidence must still pass. Each rerun starts with its
        own findings and dispositions.
      </Typography.Paragraph>
    </Space>
  );
}

export function OriginalFinding({ finding }: { finding: FindingOccurrence }) {
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Typography.Text strong>Original model finding</Typography.Text>
      <Prose>{finding.body}</Prose>
      <Facts
        items={[
          {
            label: "Location",
            value: finding.path
              ? `${finding.path}${finding.line === null ? "" : `:${finding.line}${finding.endLine === null ? "" : `–${finding.endLine}`}`}`
              : "Not recorded",
          },
          {
            label: "Kind",
            value: finding.kind === "pr_finding" ? "PR finding" : "Validation observation",
          },
          { label: "Original array index", value: finding.ordinal },
          { label: "Model ID", value: <CopyValue value={finding.modelId} /> },
          { label: "Occurrence key", value: <CopyValue value={finding.key} /> },
          {
            label: "Confidence",
            value:
              finding.confidence === null
                ? "Not recorded"
                : `${Math.round(finding.confidence * 100)}%`,
          },
          {
            label: "Disposition",
            value: `${findingStateLabel(finding.disposition.state)} · Version ${finding.disposition.version}`,
          },
          { label: "Updated", value: timestamp(finding.disposition.updatedAt) },
        ]}
      />
    </Space>
  );
}

export function FindingEvent({ event }: { event: FindingDispositionEvent }) {
  return (
    <Collapse
      items={[
        {
          key: event.id,
          label: `${findingActionLabel(event.action)} · ${event.previousVersion} → ${event.version} · ${timestamp(event.createdAt)}`,
          children: (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Prose>{event.reason}</Prose>
              <Facts
                items={[
                  { label: "Actor issuer", value: <CopyValue value={event.actor.issuer} /> },
                  { label: "Actor subject", value: <CopyValue value={event.actor.subject} /> },
                  {
                    label: "Disposition transition",
                    value: `${findingStateLabel(event.previousState)} → ${findingStateLabel(event.state)}`,
                  },
                  { label: "Change ID", value: <CopyValue value={event.changeId} /> },
                  { label: "Event ID", value: <CopyValue value={event.id} /> },
                  { label: "Occurrence key", value: <CopyValue value={event.occurrence.key} /> },
                  {
                    label: "Result digest",
                    value: <CopyValue value={event.occurrence.resultDigest} />,
                  },
                  {
                    label: "Context at recording",
                    value: <CopyValue value={event.contextDigestAtChange} />,
                  },
                  {
                    label: "Result set at recording",
                    value: <CopyValue value={event.resultSetDigestAtChange} />,
                  },
                  {
                    label: "Source current at recording",
                    value: event.sourceCurrentAtChange ? "Yes" : "No",
                  },
                  {
                    label: "Latest activation at recording",
                    value: event.latestForRequestAtChange ? "Yes" : "No",
                  },
                ]}
              />
            </Space>
          ),
        },
      ]}
    />
  );
}

const comparisonLabels = {
  persistent: "Still reported",
  new: "Newly reported",
  not_observed_again: "Not observed again",
  incomparable: "Cannot compare",
} as const;
const comparisonReasons = {
  configuration_changed: "The workflow, target, profile, or prompt version changed.",
  model_unavailable: "A complete model output is unavailable on one or both sides.",
  same_result: "Choose a different saved result as the baseline.",
  baseline_not_earlier: "The baseline must have been recorded before the selected result.",
  ambiguous_match: "Identical content has multiple possible matches.",
} as const;

export function FindingComparisonView({ comparison }: { comparison: FindingComparisonResponse }) {
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        showIcon
        type={comparison.compatible ? "info" : "warning"}
        title={
          comparison.compatible
            ? "Comparison of complete model outputs"
            : "Results are not comparable"
        }
        description={
          <>
            {comparison.reasons.map((reason) => (
              <p key={reason}>{comparisonReasons[reason]}</p>
            ))}
            <p>
              Matching uses unique, exact normalized content. Changed line numbers and model IDs are
              not identities. A finding absent from the later output is not automatically resolved,
              and dispositions never carry over.
            </p>
          </>
        }
      />
      <Collapse
        items={[
          {
            key: "before",
            label: "Baseline source and configuration",
            children: <FindingBinding context={comparison.before} />,
          },
          {
            key: "after",
            label: "Selected result source and configuration",
            children: <FindingBinding context={comparison.after} />,
          },
        ]}
      />
      <Table
        size="small"
        pagination={false}
        dataSource={comparison.items}
        rowKey={(row) => `${row.before?.key ?? "none"}:${row.after?.key ?? "none"}`}
        scroll={{ x: 650 }}
        columns={[
          {
            title: "Comparison",
            render: (_, row) => (
              <Space orientation="vertical" size={0}>
                <Tag>{comparisonLabels[row.status]}</Tag>
                {row.reason && (
                  <Typography.Text type="secondary">
                    {comparisonReasons[row.reason]}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: "Baseline finding",
            render: (_, row) =>
              row.before ? (
                <>
                  <Typography.Text>
                    P{row.before.priority} · {row.before.title}
                  </Typography.Text>
                  <br />
                  <Typography.Text type="secondary">
                    {row.before.path ?? "No location"}
                    {row.before.line ? `:${row.before.line}` : ""}
                  </Typography.Text>
                </>
              ) : (
                "No paired finding"
              ),
          },
          {
            title: "Selected result finding",
            render: (_, row) =>
              row.after ? (
                <>
                  <Typography.Text>
                    P{row.after.priority} · {row.after.title}
                  </Typography.Text>
                  <br />
                  <Typography.Text type="secondary">
                    {row.after.path ?? "No location"}
                    {row.after.line ? `:${row.after.line}` : ""}
                  </Typography.Text>
                </>
              ) : row.status === "not_observed_again" ? (
                "Not observed again"
              ) : (
                "No paired finding"
              ),
          },
        ]}
      />
    </Space>
  );
}
