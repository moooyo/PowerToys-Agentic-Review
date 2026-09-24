import type {
  InvestigationNextActionV1,
  InvestigationReportHeaderV1,
} from "@agentic-review/contracts";
import { Box, Chip, Stack, Typography } from "@mui/material";
import { type ReactNode, useId } from "react";
import { Surface } from "./workspace-ui";

export type ReportOutcome = {
  label: string;
  description: string;
  finality: string;
  isFinal: boolean;
  validation: { label: string; description: string };
};

export type OutcomeSummaryProps = {
  header: InvestigationReportHeaderV1;
  actions?: ReactNode;
  compact?: boolean;
  nextActions?: readonly InvestigationNextActionV1[];
};

const joined = (...parts: string[]) =>
  [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join("\n");

/** Presents a saved report assessment, never a conclusion inferred from task state or counts. */
export function reportOutcome(header: InvestigationReportHeaderV1): ReportOutcome {
  const assessment = header.assessment;
  const isFinal = header.report.completeness === "complete" && header.report.delivery === "final";
  let label: string;
  let description: string;
  let validation: ReportOutcome["validation"];

  switch (assessment.kind) {
    case "pr":
      label = {
        "no-blocking-findings": "No blocking findings",
        "changes-requested": "Changes needed",
        inconclusive: "Inconclusive",
      }[assessment.reviewConclusion.status];
      description = assessment.reviewConclusion.rationale;
      validation = {
        label: {
          not_needed: "E2E not required",
          recommended: "E2E recommended",
          required: "E2E required",
        }[assessment.e2eAssessment.level],
        description: joined(assessment.e2eAssessment.rationale, header.validation.summary),
      };
      break;
    case "bug":
      label = {
        confirmed: "Bug confirmed",
        needs_information: "Needs information",
        needs_verification: "Needs verification",
        already_fixed: "Already fixed",
        duplicate: "Duplicate issue",
        not_a_bug: "Not a bug",
      }[assessment.bugAssessment.status];
      description = assessment.bugAssessment.rationale;
      validation = {
        label: `Reproduction: ${
          {
            reproduced: "Reproduced",
            not_reproduced: "Not reproduced",
            not_run: "Not run",
            blocked: "Blocked",
          }[assessment.reproduction.status]
        }`,
        description: joined(assessment.reproduction.summary, header.validation.summary),
      };
      break;
    case "feature":
      label = {
        ready: "Ready for implementation",
        needs_information: "Needs information",
        needs_decision: "Needs decision",
        already_supported: "Already supported",
        duplicate: "Duplicate issue",
        not_feasible: "Not feasible",
      }[assessment.featureAssessment.status];
      description = assessment.summary;
      validation = { label: "Validation", description: header.validation.summary };
      break;
    case "other_issue":
      label = assessment.classification;
      description = assessment.explanation;
      validation = { label: "Validation", description: header.validation.summary };
      break;
  }

  return {
    label: isFinal ? label : "No final conclusion",
    description: isFinal ? description : `Saved assessment: ${label}. ${description}`,
    finality: isFinal
      ? assessment.kind === "pr"
        ? "Final review conclusion"
        : "Final triage conclusion"
      : header.report.delivery === "checkpoint"
        ? "Checkpoint assessment · Not final"
        : "Partial assessment · Not final",
    isFinal,
    validation,
  };
}

/** The caller supplies current action availability; a saved recommendation is not authorization. */
export function OutcomeSummary({
  header,
  actions,
  compact = false,
  nextActions = [],
}: OutcomeSummaryProps) {
  const titleId = useId();
  const outcome = reportOutcome(header);
  const savedActions = nextActions.filter(
    (action) =>
      action.state === "saved" &&
      action.sourceReportRef.id === header.report.id &&
      action.sourceReportRef.version === header.report.version,
  );

  return (
    <Surface
      component="section"
      aria-labelledby={titleId}
      sx={{ p: compact ? 2 : { xs: 2, sm: 3 }, overflowWrap: "anywhere" }}
    >
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{
          alignItems: { xs: "stretch", sm: "center" },
          justifyContent: "space-between",
          py: compact ? 1 : 1.5,
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", alignItems: "center", minWidth: 0 }}
        >
          <Typography id={titleId} component="h2" variant="h6" sx={{ fontSize: compact ? 16 : 18 }}>
            {outcome.label}
          </Typography>
          {!outcome.isFinal && (
            <Chip
              size="small"
              label={header.report.delivery === "checkpoint" ? "Checkpoint" : "Partial report"}
              color="warning"
              variant="outlined"
            />
          )}
          {!["feature", "other_issue"].includes(header.assessment.kind) && (
            <Chip size="small" label={outcome.validation.label} variant="outlined" />
          )}
        </Stack>
        {actions && (
          <Box sx={{ minWidth: 0, "& .MuiButton-root": { whiteSpace: "normal" } }}>{actions}</Box>
        )}
      </Stack>
      <Box
        component="details"
        sx={{
          borderTop: 1,
          borderColor: "divider",
          py: 0.5,
          "& summary": {
            cursor: "pointer",
            typography: "body2",
            color: "text.secondary",
            py: 1,
            minHeight: 36,
          },
        }}
      >
        <summary>Assessment details</summary>
        <Stack spacing={1.5} sx={{ pt: 1, pb: 2 }}>
          <Typography>{outcome.description}</Typography>
          {outcome.validation.description && (
            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "pre-line" }}>
              {outcome.validation.description}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            Report v{header.report.version} ·{" "}
            {header.report.completeness === "complete" ? "Complete" : "Partial"} ·{" "}
            {header.report.delivery === "final" ? "Final" : "Checkpoint"}
          </Typography>
          {savedActions.length > 0 && (
            <Stack component="ul" spacing={1.5} sx={{ pl: 2.5, my: 0 }}>
              {savedActions.map((action) => (
                <Box component="li" key={action.id}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {action.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {action.reason}
                  </Typography>
                </Box>
              ))}
            </Stack>
          )}
        </Stack>
      </Box>
    </Surface>
  );
}
