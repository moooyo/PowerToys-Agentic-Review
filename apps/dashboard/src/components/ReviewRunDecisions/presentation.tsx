import type { ReviewRunDecisionContext, ReviewRunDecisionEvent } from "@agentic-review/contracts";
import { Alert, Collapse, Space, Tag, Typography } from "antd";
import { CopyValue, Facts, Prose, timestamp } from "../ReviewRuns/common";
import { policyFindingPresentation } from "../ReviewRuns/presentation";
import { decisionActionLabel, decisionStateLabel, decisionStateReason } from "./state";

export function DecisionBinding({ context }: { context: ReviewRunDecisionContext }) {
  const findings = policyFindingPresentation(context.policy);
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Facts
        items={[
          { label: "Decision stream version", value: context.version },
          { label: "Reviewed revision key", value: <CopyValue value={context.revisionKey} /> },
          {
            label: "Current revision key",
            value: <CopyValue value={context.currentRevisionKey} />,
          },
          { label: "Plan digest", value: <CopyValue value={context.planDigest} /> },
          { label: "Result set digest", value: <CopyValue value={context.resultSetDigest} /> },
          {
            label: "Source and execution authorization current",
            value: context.sourceCurrent ? "Yes" : "No",
          },
          {
            label: "Current policy eligibility",
            value: context.policy.applicable
              ? context.policy.eligible
                ? "Eligible"
                : "Not eligible"
              : "Not applicable to Issue approval",
          },
          { label: "Current policy version", value: context.policy.policyVersion },
          ...findings.counts.map(({ label, value }) => ({
            label: `${label} in current policy`,
            value,
          })),
          ...(findings.dispositionDigest
            ? [
                {
                  label: "Current finding disposition digest",
                  value: <CopyValue value={findings.dispositionDigest} />,
                },
              ]
            : []),
        ]}
      />
      <Typography.Paragraph type="secondary">{findings.description}</Typography.Paragraph>
    </Space>
  );
}

export function DecisionEvent({ event }: { event: ReviewRunDecisionEvent }) {
  const findings = policyFindingPresentation(event.policyAtDecision);
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Space wrap>
        <Tag>{decisionActionLabel(event.action, event.workItemKind)}</Tag>
        <Typography.Text type="secondary">Version {event.version}</Typography.Text>
        <Typography.Text type="secondary">{timestamp(event.createdAt)}</Typography.Text>
      </Space>
      <Prose>{event.reason}</Prose>
      <Facts
        items={[
          { label: "Recorded by · subject", value: event.actor.subject },
          { label: "Recorded by · issuer", value: event.actor.issuer },
          { label: "Decision ID", value: <CopyValue value={event.id} /> },
        ]}
      />
      {event.action === "override_approve" && (
        <Alert
          type="warning"
          showIcon
          title="Explicit human override"
          description="This records a human exception. Validation checks, findings, and policy eligibility are unchanged."
        />
      )}
      <Collapse
        items={[
          {
            key: "identity",
            label: "Recorded source, result set, and policy snapshot",
            children: (
              <Space orientation="vertical" size="small" style={{ width: "100%" }}>
                <Facts
                  items={[
                    { label: "Repository ID", value: <CopyValue value={event.repositoryId} /> },
                    { label: "Work item ID", value: <CopyValue value={event.workItemId} /> },
                    { label: "Run ID", value: <CopyValue value={event.reviewRunId} /> },
                    { label: "Revision key", value: <CopyValue value={event.revisionKey} /> },
                    { label: "Plan digest", value: <CopyValue value={event.planDigest} /> },
                    {
                      label: "Result set digest",
                      value: <CopyValue value={event.resultSetDigest} />,
                    },
                    { label: "Change ID", value: <CopyValue value={event.changeId} /> },
                    {
                      label: "Version change",
                      value: `${event.previousVersion} → ${event.version}`,
                    },
                    {
                      label: "Supersedes decision",
                      value: event.supersedesDecisionId ? (
                        <CopyValue value={event.supersedesDecisionId} />
                      ) : (
                        "None"
                      ),
                    },
                    {
                      label: "Withdrawal target",
                      value: event.targetDecisionId ? (
                        <CopyValue value={event.targetDecisionId} />
                      ) : (
                        "None"
                      ),
                    },
                    {
                      label: "Recorded policy version",
                      value: event.policyAtDecision.policyVersion,
                    },
                    {
                      label: "Policy eligibility at recording",
                      value: event.policyAtDecision.applicable
                        ? event.policyAtDecision.eligible
                          ? "Eligible"
                          : "Not eligible"
                        : "Not applicable",
                    },
                    ...findings.counts.map(({ label, value }) => ({
                      label: `${label} at recording`,
                      value,
                    })),
                    ...(findings.dispositionDigest
                      ? [
                          {
                            label: "Finding disposition digest at recording",
                            value: <CopyValue value={findings.dispositionDigest} />,
                          },
                        ]
                      : []),
                    {
                      label: "Policy reasons at recording",
                      value: event.policyAtDecision.reasonCount,
                    },
                    {
                      label: "Recorded reason codes",
                      value: event.policyAtDecision.reasonCodes.length
                        ? `${event.policyAtDecision.reasonCodes.join(", ")}${event.policyAtDecision.reasonCodesTruncated ? " (bounded preview)" : ""}`
                        : "None",
                    },
                  ]}
                />
                <Typography.Paragraph type="secondary">{findings.description}</Typography.Paragraph>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

export function CurrentDecision({ context }: { context: ReviewRunDecisionContext }) {
  const attention =
    context.recordedDecisionState === "stale" || context.recordedDecisionState === "ineligible";
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Tag color={attention ? "warning" : "default"}>
        {decisionStateLabel(context.recordedDecisionState)}
      </Tag>
      {context.stateReasons.length > 0 && (
        <Alert
          showIcon
          type="warning"
          title="Review the current validation state"
          description={context.stateReasons.map(decisionStateReason).join(" ")}
        />
      )}
      {context.recordedDecision ? (
        <DecisionEvent event={context.recordedDecision} />
      ) : (
        <Typography.Text type="secondary">
          No approval or change request has been recorded for this run. Comments are retained in
          history and do not replace a decision.
        </Typography.Text>
      )}
    </Space>
  );
}
