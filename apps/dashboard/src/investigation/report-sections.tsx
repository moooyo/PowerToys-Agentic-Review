import type {
  InvestigationAssessment,
  InvestigationEvidenceV1,
  InvestigationFindingV1,
  InvestigationReportMetadata,
  InvestigationSubjectV1,
  InvestigationValidation,
} from "@agentic-review/contracts";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type ReactNode, useState } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3 }}>
      <Typography variant="h6" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

function contentEntries<T>(
  items: readonly T[],
  content: (item: T) => string,
): { key: string; value: T }[] {
  const occurrences = new Map<string, number>();
  return items.map((value) => {
    const identity = content(value);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { key: JSON.stringify([identity, occurrence]), value };
  });
}

export function TextList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <Box component="ul" sx={{ pl: 2.5, my: 1 }}>
      {contentEntries(items, (item) => item).map(({ key, value }) => (
        <Typography component="li" key={key} variant="body2" sx={{ mb: 0.5 }}>
          {value}
        </Typography>
      ))}
    </Box>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Box sx={{ overflowWrap: "anywhere" }}>{children}</Box>
    </Box>
  );
}

export function AssessmentPanel({ assessment }: { assessment: InvestigationAssessment }) {
  return (
    <Section
      title={
        assessment.kind === "pr"
          ? "PR assessment"
          : assessment.kind === "bug"
            ? "Bug assessment"
            : assessment.kind === "feature"
              ? "Feature assessment"
              : "Issue assessment"
      }
    >
      <Typography sx={{ mb: 2 }}>{assessment.summary}</Typography>
      {assessment.kind === "pr" && (
        <Stack spacing={2}>
          <Field label="Review conclusion">
            <Chip label={assessment.reviewConclusion.status} size="small" />
            <Typography variant="body2" sx={{ mt: 1 }}>
              {assessment.reviewConclusion.rationale}
            </Typography>
          </Field>
          <Field label="Independent E2E assessment">
            <Chip
              label={assessment.e2eAssessment.level}
              size="small"
              color={assessment.e2eAssessment.level === "required" ? "warning" : "default"}
            />
            <Typography variant="body2" sx={{ mt: 1 }}>
              {assessment.e2eAssessment.rationale}
            </Typography>
          </Field>
          {assessment.e2eAssessment.level === "required" && (
            <Alert severity="info">
              Required E2E evidence is tracked independently of investigation completeness. Review
              the actual checks below.
            </Alert>
          )}
          {assessment.e2eAssessment.scenarioIds.length > 0 && (
            <Field label="Planned scenarios">
              <TextList items={assessment.e2eAssessment.scenarioIds} />
            </Field>
          )}
        </Stack>
      )}
      {assessment.kind === "bug" && (
        <Stack spacing={2}>
          <Field label="Bug conclusion">
            <Chip label={assessment.bugAssessment.status} size="small" />
            <Typography variant="body2" sx={{ mt: 1 }}>
              {assessment.bugAssessment.rationale}
            </Typography>
          </Field>
          <Field label="Reproduction">
            <Chip label={assessment.reproduction.status} size="small" />
            <Typography variant="body2" sx={{ mt: 1 }}>
              {assessment.reproduction.summary}
            </Typography>
          </Field>
          <Alert severity="info">
            A failed reproduction does not establish that this is not a bug. A local fix does not
            establish that upstream is fixed.
          </Alert>
          {assessment.bugAssessment.missingInformation.length > 0 && (
            <Field label="Missing information">
              <TextList items={assessment.bugAssessment.missingInformation} />
            </Field>
          )}
          {assessment.bugAssessment.hypotheses.length > 0 && (
            <Field label="Hypotheses to verify">
              <TextList items={assessment.bugAssessment.hypotheses} />
            </Field>
          )}
          {assessment.bugAssessment.upstreamFix && (
            <Field label="Upstream fix">
              <Typography variant="body2">
                {assessment.bugAssessment.upstreamFix.identifier}:{" "}
                {assessment.bugAssessment.upstreamFix.explanation}
              </Typography>
            </Field>
          )}
          {assessment.bugAssessment.duplicateOf && (
            <Field label="Duplicate evidence">
              <Typography variant="body2">
                {assessment.bugAssessment.duplicateOf.identifier}:{" "}
                {assessment.bugAssessment.duplicateOf.explanation}
              </Typography>
            </Field>
          )}
          {assessment.bugAssessment.expectedBehavior && (
            <Field label="Expected behavior">
              <Typography variant="body2">{assessment.bugAssessment.expectedBehavior}</Typography>
            </Field>
          )}
        </Stack>
      )}
      {assessment.kind === "feature" && (
        <Stack spacing={2}>
          <Chip
            label={assessment.featureAssessment.status}
            size="small"
            sx={{ alignSelf: "flex-start" }}
          />
          {assessment.featureAssessment.status === "ready" && (
            <Alert severity="info">
              The plan is implementable. This does not mean the maintainers have accepted the
              feature or that every validation prerequisite is ready.
            </Alert>
          )}
          <Field label="Requirements">
            <TextList items={assessment.featureAssessment.requirements} />
          </Field>
          <Field label="Feasibility">
            <Typography variant="body2">{assessment.featureAssessment.feasibility}</Typography>
          </Field>
          {assessment.featureAssessment.missingInformation.length > 0 && (
            <Field label="Missing information">
              <TextList items={assessment.featureAssessment.missingInformation} />
            </Field>
          )}
          {contentEntries(assessment.featureAssessment.decisions, (decision) =>
            JSON.stringify(decision),
          ).map(({ key, value: decision }) => (
            <Field key={key} label={decision.question}>
              <TextList
                items={decision.options.map((option) => `${option.label}: ${option.tradeoffs}`)}
              />
            </Field>
          ))}
          {assessment.featureAssessment.usage && (
            <Field label="Existing capability">
              <Typography variant="body2">{assessment.featureAssessment.usage}</Typography>
            </Field>
          )}
          {assessment.featureAssessment.duplicateOf && (
            <Field label="Duplicate evidence">
              <Typography variant="body2">
                {assessment.featureAssessment.duplicateOf.identifier}:{" "}
                {assessment.featureAssessment.duplicateOf.explanation}
              </Typography>
            </Field>
          )}
          <Field label="Acceptance criteria">
            <TextList items={assessment.featureAssessment.acceptanceCriteria} />
          </Field>
          {assessment.featureAssessment.alternatives.length > 0 && (
            <Field label="Alternatives">
              <TextList items={assessment.featureAssessment.alternatives} />
            </Field>
          )}
        </Stack>
      )}
      {assessment.kind === "other_issue" && (
        <Typography variant="body2">
          {assessment.classification}: {assessment.explanation}
        </Typography>
      )}
    </Section>
  );
}

export function CoveragePanel({ report }: { report: InvestigationReportMetadata }) {
  return (
    <Section title="Investigation coverage and review loop">
      <Stack direction="row" useFlexGap spacing={1} sx={{ mb: 2, flexWrap: "wrap" }}>
        <Chip
          label={`${report.coverage.completedUnitRefs.length}/${report.coverage.includedUnits.length} scope units completed`}
          size="small"
        />
        <Chip
          label={`${report.recheck.validFinalVersionRecheckCount}/${report.recheck.finalFindingCount} final findings rechecked`}
          size="small"
        />
        <Chip label={`${report.loop.completedRounds} loop rounds`} size="small" />
        <Chip label={`Stop: ${report.loop.stopReason}`} size="small" />
      </Stack>
      {report.coverage.includedUnits.map((unit) => (
        <Box key={unit.id} sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Chip label={unit.status} size="small" />
            <Typography variant="subtitle2">{unit.requiredWork}</Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {unit.subjectRef} · {unit.kind}
          </Typography>
          <TextList items={unit.paths} />
        </Box>
      ))}
      {report.coverage.exclusions.length > 0 && (
        <Field label="Explicit exclusions">
          <TextList
            items={report.coverage.exclusions.map((item) => `${item.description}: ${item.reason}`)}
          />
        </Field>
      )}
      {report.coverage.unresolvedUnitRefs.length > 0 && (
        <Alert severity="warning">
          Unresolved scope: {report.coverage.unresolvedUnitRefs.join(", ")}
        </Alert>
      )}
      {report.recheck.pendingFindingIds.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          Pending final review: {report.recheck.pendingFindingIds.join(", ")}
        </Alert>
      )}
      {report.loop.candidates.length > 0 && (
        <Accordion disableGutters elevation={0} sx={{ mt: 2 }}>
          <AccordionSummary expandIcon={<ExpandMoreRounded />}>
            <Typography>All candidates ({report.loop.candidates.length})</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              {report.loop.candidates.map((candidate) => (
                <Box key={candidate.id}>
                  <Typography variant="subtitle2">
                    {candidate.title} · {candidate.status}
                  </Typography>
                  <Typography variant="body2">{candidate.rationale}</Typography>
                </Box>
              ))}
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}
      {report.limitations.length > 0 && (
        <Field label="Limitations">
          <TextList
            items={report.limitations.map((item) => `${item.description} — ${item.impact}`)}
          />
        </Field>
      )}
    </Section>
  );
}

export function SubjectPanel({ subjects }: { subjects: InvestigationSubjectV1[] }) {
  return (
    <Section title="Exact subjects">
      <Stack spacing={2}>
        {subjects.map((subject) => (
          <Box key={subject.id} sx={{ overflowWrap: "anywhere" }}>
            <Chip size="small" label={subject.kind} />
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {subject.id}
            </Typography>
            <Typography variant="caption" component="div" color="text.secondary">
              Revision: {subject.revisionKey}
            </Typography>
            {"headSha" in subject && (
              <Typography variant="caption" component="div">
                Head SHA: {subject.headSha}
              </Typography>
            )}
            {"baseSha" in subject && (
              <Typography variant="caption" component="div">
                Base SHA: {subject.baseSha}
              </Typography>
            )}
            {subject.kind === "source_commit" && (
              <Typography variant="caption" component="div">
                Commit SHA: {subject.commitSha}
              </Typography>
            )}
            {subject.kind === "issue_snapshot" && (
              <Typography variant="caption" component="div">
                Issue snapshot: {subject.snapshotDigest}
              </Typography>
            )}
            {subject.kind === "local_patch" && (
              <Typography variant="caption" component="div">
                Patch: {subject.patchDigest}
              </Typography>
            )}
            {subject.kind === "remote_branch" && (
              <Typography variant="caption" component="div">
                Verified remote branch: {subject.branch}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Section>
  );
}

export function ValidationPanel({ validation }: { validation: InvestigationValidation }) {
  return (
    <Section title="Actual validation">
      <Typography sx={{ mb: 2 }}>{validation.summary}</Typography>
      <Stack spacing={2}>
        {validation.checks.map((check) => (
          <Box key={check.id}>
            <Stack
              direction="row"
              useFlexGap
              spacing={1}
              sx={{ flexWrap: "wrap", alignItems: "center" }}
            >
              <Chip
                label={check.status}
                size="small"
                color={
                  check.status === "failed"
                    ? "error"
                    : check.status === "passed"
                      ? "success"
                      : "default"
                }
              />
              <Chip
                label={check.required ? "Required" : "Optional"}
                variant="outlined"
                size="small"
              />
              <Typography variant="subtitle2">{check.description}</Typography>
            </Stack>
            <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
              Subject: {check.subjectRef} · Scenario: {check.scenarioId}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {check.executor ? `Executor: ${check.executor}` : "No execution recorded"}
              {check.authoritativeAttemptId ? ` · Attempt: ${check.authoritativeAttemptId}` : ""}
            </Typography>
            <TextList items={check.evidenceRefs.map((ref) => `Evidence: ${ref}`)} />
          </Box>
        ))}
      </Stack>
    </Section>
  );
}

export function FindingCard({
  finding,
  evidence,
  selected,
  draftBody,
  suggestionValid,
  selectionEnabled = true,
  onSelect,
  onDraftChange,
}: {
  finding: InvestigationFindingV1;
  evidence: InvestigationEvidenceV1[];
  selected: boolean;
  draftBody: string;
  suggestionValid: boolean;
  selectionEnabled?: boolean;
  onSelect: (selected: boolean) => void;
  onDraftChange: (body: string) => void;
}) {
  const [expanded, setExpanded] = useState(finding.ordinal === 0);
  const references = new Set([
    ...finding.evidenceRefs,
    ...finding.rootCause.evidenceRefs,
    ...finding.confirmation.evidenceRefs,
  ]);
  return (
    <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <Checkbox
          checked={selected}
          disabled={!selectionEnabled}
          onChange={(event) => onSelect(event.target.checked)}
          slotProps={{ input: { "aria-label": `Select ${finding.title}` } }}
        />
        <Box sx={{ flex: 1, pt: 0.8 }}>
          <Stack
            direction="row"
            useFlexGap
            spacing={1}
            sx={{ flexWrap: "wrap", alignItems: "center" }}
          >
            <Chip
              label={finding.priority}
              color={
                finding.priority === "P0"
                  ? "error"
                  : finding.priority === "P1"
                    ? "warning"
                    : "default"
              }
              size="small"
            />
            <Typography variant="h6">{finding.title}</Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {finding.confirmation.status} · Finding version {finding.version} · {finding.subjectRef}
          </Typography>
        </Box>
      </Stack>
      <Button
        size="small"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        sx={{ mt: 1 }}
      >
        {expanded ? "Hide finding details" : "Show finding details"}
      </Button>
      <Collapse in={expanded}>
        <Stack spacing={2} sx={{ mt: 2 }}>
          <Field label="Trigger conditions">
            <TextList items={finding.trigger.conditions} />
            <TextList items={finding.trigger.inputs} />
            <TextList items={finding.trigger.steps} />
          </Field>
          <Field label="Impact">
            <Typography variant="body2">{finding.impact.description}</Typography>
            <TextList items={finding.impact.affectedParties} />
          </Field>
          <Field label={`Root cause · ${finding.rootCause.status}`}>
            <Typography variant="body2">{finding.rootCause.explanation}</Typography>
          </Field>
          <Field label="Confirmation and final review">
            <Typography variant="body2">{finding.confirmation.rationale}</Typography>
            <Typography variant="caption" color="text.secondary">
              {finding.confirmation.recheckRef ?? "No confirming recheck recorded"}
            </Typography>
          </Field>
          <Field label="Locations">
            <TextList
              items={finding.locations.map((location) =>
                location.kind === "source"
                  ? `${location.path}:${location.startLine}–${location.endLine}`
                  : location.description,
              )}
            />
          </Field>
          <Field label="Evidence">
            <Stack spacing={1}>
              {[...references].map((id) => {
                const record = evidence.find((item) => item.id === id);
                return (
                  <Box key={id}>
                    <Typography variant="body2">
                      {record?.summary ?? `Evidence ${id} is unavailable.`}
                    </Typography>
                    {record && (
                      <Typography variant="caption" color="text.secondary">
                        {id} · {record.source} · {record.authority} · {record.subjectRef}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Stack>
          </Field>
          <Field label="Fix recommendation">
            <Typography variant="body2">{finding.fixRecommendation.summary}</Typography>
            <TextList items={finding.fixRecommendation.constraints} />
          </Field>
          <Divider />
          <TextField
            label="Independent comment draft"
            multiline
            minRows={3}
            fullWidth
            value={draftBody}
            onChange={(event) => onDraftChange(event.target.value)}
            helperText="Only selected findings are included when preparing feedback."
          />
          {finding.feedbackDraft.suggestion && (
            <Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="subtitle2">Code replacement suggestion</Typography>
                <Chip
                  size="small"
                  label={suggestionValid ? "Validated by server" : "Not available for submission"}
                  color={suggestionValid ? "success" : "default"}
                />
              </Stack>
              <Typography variant="caption">
                {finding.feedbackDraft.suggestion.path}:{finding.feedbackDraft.suggestion.startLine}
                –{finding.feedbackDraft.suggestion.endLine}
              </Typography>
              <Box
                component="pre"
                sx={{
                  bgcolor: "action.hover",
                  p: 2,
                  borderRadius: 2,
                  overflowX: "auto",
                  fontSize: 12,
                }}
              >
                {finding.feedbackDraft.suggestion.replacement}
              </Box>
              <Typography variant="caption" color="text.secondary">
                A code suggestion is a comment; it does not choose Request changes.
              </Typography>
            </Box>
          )}
          <FormControlLabel
            control={
              <Checkbox
                checked={selected}
                disabled={!selectionEnabled}
                onChange={(event) => onSelect(event.target.checked)}
              />
            }
            label="Include this finding in prepared feedback"
          />
        </Stack>
      </Collapse>
    </Paper>
  );
}
