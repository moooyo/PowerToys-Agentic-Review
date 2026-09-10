import type {
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunResult,
  IssueReproductionAssessmentV1,
  IssueReproductionCaseAssessment,
  ObservationEquals,
} from "@agentic-review/contracts";
import { Alert, AlertTitle, Box, Chip, Stack, Typography } from "@mui/material";
import { DataTable } from "@/components/ui";
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
  return (
    <Chip
      size="medium"
      color={view.tone === "processing" ? "info" : view.tone}
      label={view.label}
    />
  );
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
  const assessments = [
    { title: "Current assessment", value: assessment, current: true },
    ...(recorded ? [{ title: "Recorded assessment", value: recorded, current: false }] : []),
  ];
  return (
    <Stack spacing={2} sx={{ width: "100%" }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
          gap: 3,
        }}
      >
        {assessments.map(({ title, value, current }) => {
          const view = reproductionConclusionPresentation(value, current);
          return (
            <Box
              component="section"
              key={title}
              aria-label={title}
              sx={{
                pb: 2,
                borderBottom: 1,
                borderColor: "divider",
              }}
            >
              <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
                {title}
              </Typography>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ my: 1, flexWrap: "wrap", alignItems: "center" }}
              >
                <Chip
                  size="medium"
                  color={view.tone === "processing" ? "info" : view.tone}
                  label={view.label}
                />
                <Typography variant="body2">
                  {value.coverage === "complete" ? "Complete coverage" : "Partial coverage"}
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {value.cases.length} configured case(s) · rules version {value.rulesVersion}
              </Typography>
            </Box>
          );
        })}
      </Box>
      <Typography variant="body2" color="text.secondary">
        A confirmed case establishes the claim only in its frozen context. Not reproduced requires
        an explicit absent signature for every configured case. Missing observations never establish
        absence. Coverage describes these configured cases, not all environments.
      </Typography>
      {recorded && (
        <Typography variant="body2" color="text.secondary">
          The recorded assessment is preserved from this saved result. The current assessment also
          considers whether the execution is still current and its required evidence remains
          available.
        </Typography>
      )}
    </Stack>
  );
}

export function CaseAssessmentComparison({
  detail,
}: {
  detail: DashboardReviewRunReproductionCaseResponse;
}) {
  return (
    <Stack spacing={2} sx={{ width: "100%" }}>
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
        <Alert severity={detail.current.reasons.includes("execution_pending") ? "info" : "warning"}>
          <AlertTitle>Current assessment reasons</AlertTitle>
          <ul style={{ marginBottom: 0, paddingInlineStart: 20 }}>
            {detail.current.reasons.map((reason) => (
              <li key={reason}>{reproductionReasonLabel[reason]}</li>
            ))}
          </ul>
        </Alert>
      )}
      {detail.recorded && detail.recorded.reasons.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          Recorded reasons:{" "}
          {detail.recorded.reasons.map((reason) => reproductionReasonLabel[reason]).join("; ")}.
        </Typography>
      )}
    </Stack>
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
    <Stack spacing={2} sx={{ width: "100%" }}>
      <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
        {title} · all conditions must hold
      </Typography>
      <DataTable
        getRowId={(row) => row.key}
        rows={rows}
        ariaLabel={`${title} conditions`}
        columns={[
          {
            id: "observation",
            label: "Selected observation",
            width: "36%",
            minWidth: 240,
            render: (row) => observationRefLabel(row.predicate.observation),
          },
          {
            id: "expected",
            label: "Expected value",
            width: "28%",
            minWidth: 180,
            render: (row) => (
              <Typography
                variant="body2"
                component="code"
                sx={{ fontFamily: '"Roboto Mono", monospace' }}
              >
                {observationValueLabel(row.predicate.equals)}
              </Typography>
            ),
          },
          {
            id: "observed",
            label: "Observed fact",
            minWidth: 260,
            render: (row) => (
              <Stack spacing={0.5}>
                <Typography
                  variant="body2"
                  component={row.fact?.state === "observed" ? "code" : "span"}
                  sx={
                    row.fact?.state === "observed"
                      ? { fontFamily: '"Roboto Mono", monospace' }
                      : undefined
                  }
                >
                  {observationFactLabel(row.fact)}
                </Typography>
                {row.fact && <EvidenceIds ids={row.fact.evidenceIds} />}
              </Stack>
            ),
          },
        ]}
      />
    </Stack>
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
    <Stack spacing={3} sx={{ width: "100%" }}>
      <CaseAssessmentComparison detail={detail} />
      <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
        Frozen case context
      </Typography>
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
      <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
        Preconditions · all required
      </Typography>
      {selected.preconditions.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No additional preconditions were configured.
        </Typography>
      ) : (
        <DataTable
          getRowId={(row) => row.key}
          rows={selected.preconditions.map((precondition, index) => ({
            key: `precondition:${index}`,
            precondition,
          }))}
          ariaLabel="Reproduction preconditions"
          columns={[
            {
              id: "condition",
              label: "Required condition",
              width: "36%",
              minWidth: 240,
              render: ({ precondition }) =>
                precondition.kind === "check_passed"
                  ? `Worker check · ${precondition.checkId}`
                  : observationRefLabel(precondition.predicate.observation),
            },
            {
              id: "expected",
              label: "Expected value",
              width: "28%",
              minWidth: 180,
              render: ({ precondition }) =>
                precondition.kind === "check_passed" ? (
                  "Passed"
                ) : (
                  <Typography
                    variant="body2"
                    component="code"
                    sx={{ fontFamily: '"Roboto Mono", monospace' }}
                  >
                    {observationValueLabel(precondition.predicate.equals)}
                  </Typography>
                ),
            },
            {
              id: "observed",
              label: "Observed fact",
              minWidth: 260,
              render: ({ precondition }) => {
                if (precondition.kind === "check_passed") {
                  const check = result?.report.checks.find(
                    (entry) => entry.id === precondition.checkId,
                  );
                  return (
                    <Stack spacing={0.5}>
                      <Typography variant="body2">
                        {check
                          ? `Recorded check · ${check.outcome.replaceAll("_", " ")}`
                          : "Check outcome not recorded"}
                      </Typography>
                      {check && <EvidenceIds ids={check.evidenceIds} />}
                    </Stack>
                  );
                }
                const fact = detail.observations.find(
                  (entry) =>
                    observationRefKey(entry.observation) ===
                    observationRefKey(precondition.predicate.observation),
                );
                return (
                  <Typography
                    variant="body2"
                    component={fact?.state === "observed" ? "code" : "span"}
                    sx={
                      fact?.state === "observed"
                        ? { fontFamily: '"Roboto Mono", monospace' }
                        : undefined
                    }
                  >
                    {observationFactLabel(fact)}
                  </Typography>
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
        <Alert severity="info">
          <AlertTitle>No absent signature configured</AlertTitle>
          This case can establish presence. Failure to match the present signature cannot establish
          absence.
        </Alert>
      )}
      <Typography variant="body2" color="text.secondary">
        These are the selected typed facts supplied by the server. Unavailable captures, missing
        elements, and missing evidence do not become an observed false value. This comparison does
        not change the recorded or current assessment.
      </Typography>
    </Stack>
  );
}
