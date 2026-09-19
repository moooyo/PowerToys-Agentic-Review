import type { InvestigationArtifactV1, InvestigationE2eResult } from "@agentic-review/contracts";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import { ArtifactPanel } from "./artifact-panel";
import { Section, TextList } from "./report-sections";

function outcomeLabel(outcome: string): string {
  return outcome === "not_run" ? "Not run" : outcome[0]!.toUpperCase() + outcome.slice(1);
}

export function E2eCoveragePanel({
  result,
  artifacts,
}: {
  result?: InvestigationE2eResult;
  artifacts?: InvestigationArtifactV1[];
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
        <Box sx={{ overflowWrap: "anywhere" }}>
          <Typography variant="body2">Tested HEAD: {result.headSha}</Typography>
          <Typography variant="body2">Build: {result.buildIdentity}</Typography>
        </Box>
        {result.features.map((feature) => (
          <Box key={feature.id}>
            <Stack
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
              <Typography variant="h6">{feature.title}</Typography>
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
            {feature.artifactRefs.length > 0 ? (
              artifacts ? (
                <ArtifactPanel
                  artifacts={artifacts.filter((artifact) =>
                    feature.artifactRefs.includes(artifact.id),
                  )}
                />
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
