import type {
  InvestigationNextActionV1,
  InvestigationReportHeaderV1,
} from "@agentic-review/contracts";
import { Box, Stack, Typography } from "@mui/material";
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
  const hasNextSteps = Boolean(actions) || savedActions.length > 0;

  return (
    <Surface
      component="section"
      aria-labelledby={titleId}
      sx={{
        p: compact ? 2 : { xs: 2, sm: 3 },
        bgcolor: (theme) => `var(--app-surface-container, ${theme.palette.background.paper})`,
        display: "grid",
        gridTemplateColumns: {
          xs: "minmax(0, 1fr)",
          md: hasNextSteps ? "minmax(0, 1.35fr) minmax(0, 1fr)" : "minmax(0, 1fr)",
        },
        gap: compact ? 2 : 3,
        overflowWrap: "anywhere",
      }}
    >
      <Stack spacing={1} sx={{ minWidth: 0 }}>
        <Typography variant="body2" color="text.secondary">
          {outcome.finality}
        </Typography>
        <Typography id={titleId} component="h2" variant={compact ? "h6" : "h5"}>
          {outcome.label}
        </Typography>
        <Typography variant={compact ? "body2" : "body1"}>{outcome.description}</Typography>
        <Box sx={{ pt: 1 }}>
          <Typography component="h3" variant="subtitle2">
            {outcome.validation.label}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5, whiteSpace: "pre-line" }}
          >
            {outcome.validation.description}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">
          Saved report v{header.report.version} ·{" "}
          {header.report.completeness === "complete" ? "Complete" : "Partial"} ·{" "}
          {header.report.delivery === "final" ? "Final delivery" : "Checkpoint delivery"}
        </Typography>
      </Stack>
      {hasNextSteps && (
        <Stack
          spacing={1.5}
          sx={{
            minWidth: 0,
            pt: { xs: 2, md: 0 },
            pl: { xs: 0, md: 3 },
            borderTop: { xs: 1, md: 0 },
            borderLeft: { xs: 0, md: 1 },
            borderColor: "divider",
          }}
        >
          <Typography component="h3" variant="subtitle2">
            Next steps
          </Typography>
          {actions && <Box sx={{ minWidth: 0 }}>{actions}</Box>}
          {savedActions.length > 0 && (
            <>
              <Stack component="ul" spacing={1.5} sx={{ p: 0, m: 0, listStyle: "none" }}>
                {savedActions.map((action) => (
                  <Box component="li" key={action.id}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {action.label}
                      {action.recommended ? " · Recommended in saved report" : ""}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {action.reason}
                    </Typography>
                  </Box>
                ))}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Saved suggestions describe the report’s next steps. Current permissions and
                prerequisites determine availability.
              </Typography>
            </>
          )}
        </Stack>
      )}
    </Surface>
  );
}
