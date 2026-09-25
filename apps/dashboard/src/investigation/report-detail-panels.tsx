import type { InvestigationReportHeaderV1, InvestigationResultV1 } from "@agentic-review/contracts";
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { investigationApi } from "./api";
import { ArtifactPanel } from "./artifact-panel";
import { E2eCoveragePanel } from "./e2e-panel";
import {
  AssessmentPanel,
  CoveragePanel,
  Section,
  SubjectPanel,
  TextList,
  ValidationPanel,
} from "./report-sections";
import { InvestigationHttpError } from "./transport";
import { TokenUsagePanel } from "./usage-panel";

function ExactRecord({ label, value }: { label: string; value: unknown }) {
  return (
    <Box component="details" sx={{ overflowWrap: "anywhere" }}>
      <Typography component="summary" sx={{ cursor: "pointer", py: 1 }}>
        {label}
      </Typography>
      <Box component="pre" sx={{ whiteSpace: "pre-wrap", fontSize: 12, overflowWrap: "anywhere" }}>
        {JSON.stringify(value, null, 2)}
      </Box>
    </Box>
  );
}

export function ReportEvidence({
  result,
  identity,
}: {
  result: InvestigationResultV1;
  identity: string;
}) {
  return (
    <Stack spacing={2}>
      {result.context.task.kind === "pr-e2e" && (
        <E2eCoveragePanel
          result={result.context.e2e}
          artifacts={result.artifacts}
          showArtifacts={false}
        />
      )}
      <ValidationPanel validation={result.validation} />
      <Section title="Evidence">
        {result.verificationEvidence.length === 0 ? (
          <Typography color="text.secondary">No evidence recorded.</Typography>
        ) : (
          <Stack spacing={2}>
            {result.verificationEvidence.map((evidence) => (
              <Box key={evidence.id} sx={{ overflowWrap: "anywhere" }}>
                <Typography variant="subtitle2">{evidence.summary}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {evidence.source} · {evidence.authority}
                </Typography>
                <ExactRecord label="Provenance" value={evidence} />
              </Box>
            ))}
          </Stack>
        )}
      </Section>
      <ArtifactPanel artifacts={result.artifacts} />
      {result.context.sourceArtifacts && result.context.sourceArtifacts.length > 0 && (
        <ArtifactPanel artifacts={result.context.sourceArtifacts} origin="inherited" />
      )}
      {result.context.task.kind === "pr-e2e" && (
        <ReportMediaPublication result={result} identity={identity} />
      )}
    </Stack>
  );
}

function ReportMediaPublication({
  result,
  identity,
}: {
  result: InvestigationResultV1;
  identity: string;
}) {
  const query = useQuery({
    queryKey: ["investigation-report-media-publication", identity, result.report.id],
    queryFn: ({ signal }) => investigationApi.reportMediaPublication(result.report.id, signal),
    retry: false,
  });
  return (
    <Section title="GitHub media publication">
      {query.isPending && <CircularProgress size={22} aria-label="Loading media publication" />}
      {query.isError && (
        <Alert
          severity={
            query.error instanceof InvestigationHttpError && query.error.status === 404
              ? "info"
              : "warning"
          }
          action={<Button onClick={() => void query.refetch()}>Refresh</Button>}
        >
          {query.error instanceof InvestigationHttpError && query.error.status === 404
            ? "Media publication status is unavailable."
            : query.error.message}
        </Alert>
      )}
      {query.data && (
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Chip label={query.data.state} size="small" />
            <Typography variant="body2">
              {query.data.uploadedCount} of {query.data.totalCount} files uploaded
            </Typography>
          </Stack>
          <TextList items={query.data.blockers} />
          {query.data.uploads.map((upload) => {
            const artifact = result.artifacts.find(
              (item) =>
                item.id === upload.artifactId &&
                item.digest === upload.digest &&
                item.name === upload.name &&
                item.mediaType === upload.mediaType,
            );
            return (
              <Box key={upload.artifactId} sx={{ overflowWrap: "anywhere" }}>
                <Typography variant="subtitle2">
                  {upload.name} · {upload.state}
                </Typography>
                {upload.reason && <Typography variant="body2">{upload.reason}</Typography>}
                {!artifact && (
                  <Typography variant="caption" color="text.secondary">
                    No matching artifact in this report.
                  </Typography>
                )}
                <ExactRecord label="Publication details" value={upload} />
              </Box>
            );
          })}
        </Stack>
      )}
    </Section>
  );
}

export function ReportDetails({
  value,
  result,
  actions,
}: {
  value: InvestigationReportHeaderV1;
  result: InvestigationResultV1;
  actions?: ReactNode;
}) {
  return (
    <Box className="report-details-layout">
      <Stack spacing={2}>
        <AssessmentPanel assessment={value.assessment} />
        <Section title="Saved plans">
          {result.plans.length === 0 ? (
            <Typography color="text.secondary">No saved plans.</Typography>
          ) : (
            <Stack spacing={3}>
              {result.plans.map((plan) => (
                <Box key={plan.id}>
                  <Typography variant="subtitle2">{plan.title}</Typography>
                  <Typography variant="body2">{plan.rationale}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {plan.kind} · Saved version {plan.version} · Subject {plan.subjectRef}
                  </Typography>
                  <Box component="ol" sx={{ pl: 3 }}>
                    {plan.steps.map((step) => (
                      <Typography component="li" variant="body2" key={step.id}>
                        {step.description} Expected: {step.expectedObservation}
                      </Typography>
                    ))}
                  </Box>
                  <Typography variant="overline">Prerequisites</Typography>
                  <TextList items={plan.prerequisites.map((item) => item.description)} />
                  <Typography variant="overline">Acceptance criteria</Typography>
                  <TextList items={plan.acceptanceCriteria} />
                  <ExactRecord label="Exact saved plan" value={plan} />
                </Box>
              ))}
            </Stack>
          )}
        </Section>
        {result.diagnostics.length > 0 && (
          <Section title="Diagnostics">
            <Stack spacing={1}>
              {result.diagnostics.map((diagnostic) => {
                const recovered =
                  result.outcome === "completed" &&
                  result.context.task.kind === "pr-e2e" &&
                  result.context.e2e?.cleanup.confirmed === true &&
                  diagnostic.code === "SOURCE_TREE_UNSUPPORTED";
                return (
                  <Alert
                    key={diagnostic.id}
                    severity={
                      recovered
                        ? "info"
                        : diagnostic.category === "error"
                          ? "error"
                          : diagnostic.category === "blocker"
                            ? "warning"
                            : "info"
                    }
                  >
                    <Typography variant="subtitle2">
                      {diagnostic.code}
                      {recovered ? " · Earlier preparation attempt" : ""}
                    </Typography>
                    {diagnostic.message}
                    <Typography variant="caption" component="div">
                      {recovered
                        ? "Source preparation subsequently succeeded and this task completed. The earlier diagnostic is retained for history."
                        : diagnostic.retryable
                          ? "Retry may resolve this condition."
                          : ""}
                    </Typography>
                    <ExactRecord label="Exact diagnostic" value={diagnostic} />
                  </Alert>
                );
              })}
            </Stack>
          </Section>
        )}
      </Stack>
      <Stack spacing={2} className="report-identity-column">
        <Section title="Report details">
          <Typography variant="body2">{value.report.summary}</Typography>
          <Box component="dl" className="report-identity">
            <Typography component="dt" color="text.secondary">
              Report
            </Typography>
            <Typography component="dd">{value.report.id}</Typography>
            <Typography component="dt" color="text.secondary">
              Version
            </Typography>
            <Typography component="dd">{value.report.version}</Typography>
            <Typography component="dt" color="text.secondary">
              Producer
            </Typography>
            <Typography component="dd">
              <Link
                to={`/tasks?taskId=${encodeURIComponent(value.context.task.id)}&repositoryId=${encodeURIComponent(value.context.repository.id)}`}
              >
                {value.context.task.id}
              </Link>
            </Typography>
            <Typography component="dt" color="text.secondary">
              Execution outcome
            </Typography>
            <Typography component="dd">{value.outcome}</Typography>
            <Typography component="dt" color="text.secondary">
              Completeness
            </Typography>
            <Typography component="dd">{value.report.completeness}</Typography>
            <Typography component="dt" color="text.secondary">
              Delivery
            </Typography>
            <Typography component="dd">{value.report.delivery}</Typography>
          </Box>
          <Box component="details">
            <Typography component="summary">Digest</Typography>
            <Typography variant="caption">{value.report.logicalContentDigest}</Typography>
          </Box>
          {actions && <Box sx={{ mt: 2 }}>{actions}</Box>}
        </Section>
        <Box component="details" className="report-detail-disclosure">
          <Typography component="summary">Coverage</Typography>
          <CoveragePanel report={result.report} />
        </Box>
        <Box component="details" className="report-detail-disclosure">
          <Typography component="summary">Usage</Typography>
          <TokenUsagePanel
            summary={value.report.usage}
            legacyTokens={value.report.loop.consumed.tokens}
            scope="report"
          />
        </Box>
        <Box component="details" className="report-detail-disclosure">
          <Typography component="summary">Sources</Typography>
          <SubjectPanel subjects={result.context.subjects} />
        </Box>
        <Section title="Provenance">
          <ExactRecord
            label="Exact context and report metadata"
            value={{
              schemaVersion: result.schemaVersion,
              id: result.id,
              version: result.version,
              context: result.context,
              report: result.report,
              assessment: result.assessment,
              validation: result.validation,
              nextActions: result.nextActions,
              feedbackDrafts: result.feedbackDrafts,
            }}
          />
        </Section>
      </Stack>
    </Box>
  );
}
