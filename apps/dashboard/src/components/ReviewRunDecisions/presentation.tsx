import type { ReviewRunDecisionContext, ReviewRunDecisionEvent } from "@agentic-review/contracts";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import { CopyValue, Facts, Prose, timestamp } from "../ReviewRuns/common";
import { policyFindingPresentation } from "../ReviewRuns/presentation";
import { decisionActionLabel, decisionStateLabel, decisionStateReason } from "./state";
export function DecisionBinding({ context }: { context: ReviewRunDecisionContext }) {
  const findings = policyFindingPresentation(context.policy);
  return (
    <Stack spacing={2} sx={{ width: "100%" }}>
      <Facts
        items={[
          {
            label: "Decision stream version",
            value: context.version,
          },
          {
            label: "Reviewed revision key",
            value: <CopyValue value={context.revisionKey} />,
          },
          {
            label: "Current revision key",
            value: <CopyValue value={context.currentRevisionKey} />,
          },
          {
            label: "Plan digest",
            value: <CopyValue value={context.planDigest} />,
          },
          {
            label: "Result set digest",
            value: <CopyValue value={context.resultSetDigest} />,
          },
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
          {
            label: "Current policy version",
            value: context.policy.policyVersion,
          },
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
      <Typography variant="body2" component="p" color="text.secondary">
        {findings.description}
      </Typography>
    </Stack>
  );
}
export function DecisionEvent({ event }: { event: ReviewRunDecisionEvent }) {
  const findings = policyFindingPresentation(event.policyAtDecision);
  return (
    <Stack component="article" spacing={2} sx={{ width: "100%" }}>
      <Stack spacing={1} direction="row" useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Chip
          size="medium"
          label={decisionActionLabel(event.action, event.workItemKind)}
          sx={{
            alignSelf: "flex-start",
          }}
        />
        <Typography variant="body2" component="span" color="text.secondary">
          Version {event.version}
        </Typography>
        <Typography variant="body2" component="span" color="text.secondary">
          {timestamp(event.createdAt)}
        </Typography>
      </Stack>
      <Prose>{event.reason}</Prose>
      <Facts
        items={[
          {
            label: "Recorded by · subject",
            value: event.actor.subject,
          },
          {
            label: "Recorded by · issuer",
            value: event.actor.issuer,
          },
          {
            label: "Decision ID",
            value: <CopyValue value={event.id} />,
          },
        ]}
      />
      {event.action === "override_approve" && (
        <Alert severity="warning">
          <AlertTitle>{"Explicit human override"}</AlertTitle>
          {
            "This records a human exception. Validation checks, findings, and policy eligibility are unchanged."
          }
        </Alert>
      )}
      <Accordion key="identity" disableGutters elevation={0} sx={{ bgcolor: "transparent" }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 56 }}>
          <Typography variant="subtitle1" component="div">
            {"Recorded source, result set, and policy snapshot"}
          </Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0, pb: 3 }}>
          <Stack
            style={{
              width: "100%",
            }}
            spacing={1}
          >
            <Facts
              items={[
                {
                  label: "Repository ID",
                  value: <CopyValue value={event.repositoryId} />,
                },
                {
                  label: "Work item ID",
                  value: <CopyValue value={event.workItemId} />,
                },
                {
                  label: "Run ID",
                  value: <CopyValue value={event.reviewRunId} />,
                },
                {
                  label: "Revision key",
                  value: <CopyValue value={event.revisionKey} />,
                },
                {
                  label: "Plan digest",
                  value: <CopyValue value={event.planDigest} />,
                },
                {
                  label: "Result set digest",
                  value: <CopyValue value={event.resultSetDigest} />,
                },
                {
                  label: "Change ID",
                  value: <CopyValue value={event.changeId} />,
                },
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
            <Typography variant="body2" component="p" color="text.secondary">
              {findings.description}
            </Typography>
          </Stack>
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}
export function CurrentDecision({ context }: { context: ReviewRunDecisionContext }) {
  const attention =
    context.recordedDecisionState === "stale" || context.recordedDecisionState === "ineligible";
  return (
    <Stack spacing={2} sx={{ width: "100%" }}>
      <Chip
        color={attention ? "warning" : "default"}
        size="medium"
        label={decisionStateLabel(context.recordedDecisionState)}
        sx={{
          alignSelf: "flex-start",
        }}
      />
      {context.stateReasons.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>{"Review the current validation state"}</AlertTitle>
          {context.stateReasons.map(decisionStateReason).join(" ")}
        </Alert>
      )}
      {context.recordedDecision ? (
        <DecisionEvent event={context.recordedDecision} />
      ) : (
        <Typography variant="body2" component="span" color="text.secondary">
          No approval or change request has been recorded for this run. Comments are retained in
          history and do not replace a decision.
        </Typography>
      )}
    </Stack>
  );
}
