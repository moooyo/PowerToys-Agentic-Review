import type { InvestigationArtifactV1, InvestigationE2eResult } from "@agentic-review/contracts";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import { ArtifactPanel } from "./artifact-panel";
import { Section, TextList } from "./report-sections";

function outcomeLabel(outcome: string): string {
  return outcome === "not_run" ? "Not run" : outcome[0]!.toUpperCase() + outcome.slice(1);
}

export function e2eOutcomeSummary(result: InvestigationE2eResult): string {
  return (["passed", "failed", "blocked", "not_run"] as const)
    .map((outcome) => ({
      outcome,
      count: result.features.filter((feature) => feature.outcome === outcome).length,
    }))
    .filter(({ count }) => count > 0)
    .map(({ outcome, count }) => `${count} ${outcome === "not_run" ? "not run" : outcome}`)
    .join(" · ");
}

export function E2eCoveragePanel({
  result,
  artifacts,
  showArtifacts = true,
}: {
  result?: InvestigationE2eResult;
  artifacts?: InvestigationArtifactV1[];
  showArtifacts?: boolean;
}) {
  if (!result)
    return (
      <Alert severity="info">
        No E2E feature results were recorded in this report. A completed static review does not
        establish runtime verification.
      </Alert>
    );
  return (
    <Section title="E2E feature coverage">
      <Stack spacing={3}>
        <Typography variant="body2" color="text.secondary">
          {e2eOutcomeSummary(result)}. These outcomes come from the recorded assertions; uploaded
          media alone does not establish a pass.
        </Typography>
        <Box sx={{ overflowWrap: "anywhere" }}>
          <Typography variant="body2">Tested HEAD: {result.headSha}</Typography>
          <Typography variant="body2">Build: {result.buildIdentity}</Typography>
        </Box>
        {result.features.map((feature) => (
          <Box key={feature.id} component="details" className="task-e2e-feature">
            <Stack
              component="summary"
              direction="row"
              useFlexGap
              spacing={1}
              sx={{ alignItems: "center", flexWrap: "wrap" }}
            >
              <Chip
                size="small"
                label={outcomeLabel(feature.outcome)}
                color={
                  feature.outcome === "passed"
                    ? "success"
                    : feature.outcome === "failed"
                      ? "error"
                      : feature.outcome === "blocked"
                        ? "warning"
                        : "default"
                }
              />
              <Typography component="span" variant="subtitle1">
                {feature.title}
              </Typography>
              <ExpandMoreRounded
                className="task-e2e-expand"
                aria-hidden="true"
                sx={{ ml: "auto" }}
              />
            </Stack>
            <Typography sx={{ mt: 1 }}>{feature.scenario}</Typography>
            <Typography variant="caption" color="text.secondary">
              {feature.userVisible ? "User-visible behavior" : "Non-visual behavior"}
            </Typography>
            <TextList items={feature.paths} />
            <Stack spacing={1} sx={{ my: 2 }}>
              {feature.assertions.map((assertion) => (
                <Box key={assertion.id} sx={{ borderLeft: 2, borderColor: "divider", pl: 2 }}>
                  <Typography variant="subtitle2">{outcomeLabel(assertion.outcome)}</Typography>
                  <Typography variant="body2">Expected: {assertion.expected}</Typography>
                  <Typography variant="body2">Observed: {assertion.observed}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Evidence:{" "}
                    {assertion.evidenceRefs.length > 0
                      ? assertion.evidenceRefs.join(", ")
                      : "No execution evidence recorded"}
                  </Typography>
                </Box>
              ))}
            </Stack>
            <TextList items={feature.limitations} />
            {!showArtifacts ? (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ overflowWrap: "anywhere" }}
              >
                Registered artifact references:{" "}
                {feature.artifactRefs.length ? feature.artifactRefs.join(", ") : "None recorded"}
              </Typography>
            ) : feature.artifactRefs.length > 0 ? (
              artifacts ? (
                <>
                  <ArtifactPanel
                    artifacts={artifacts.filter((artifact) =>
                      feature.artifactRefs.includes(artifact.id),
                    )}
                  />
                  {feature.artifactRefs.some(
                    (id) => !artifacts.some((artifact) => artifact.id === id),
                  ) && (
                    <Alert severity="warning" sx={{ mt: 1 }}>
                      Some referenced artifact records are unavailable in this report. Recorded
                      assertions are unchanged.
                    </Alert>
                  )}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Loading screenshots and videos for this feature…
                </Typography>
              )
            ) : (
              <Typography variant="body2" color="text.secondary">
                No screenshot or video evidence was recorded for this feature.
              </Typography>
            )}
          </Box>
        ))}
        <Alert severity={result.cleanup.confirmed ? "success" : "warning"}>
          {result.cleanup.confirmed
            ? "Desktop cleanup confirmed"
            : "Desktop cleanup needs confirmation"}
          : {result.cleanup.summary}
          <Typography variant="caption" component="div">
            {new Date(result.cleanup.recordedAt).toLocaleString()}
          </Typography>
        </Alert>
      </Stack>
    </Section>
  );
}
