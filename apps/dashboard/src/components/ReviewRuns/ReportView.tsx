import type {
  DashboardReviewRunResult,
  DashboardValidationModelReview,
  ValidationCheckResult,
  ValidationStepDiagnostic,
} from "@agentic-review/contracts";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Chip,
  Collapse,
  IconButton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tabs,
  Typography,
} from "@mui/material";
import { useEffect, useId, useState } from "react";
import { CliExecutionDetails } from "@/components/CliExecutionDetails";
import { FindingReview } from "@/components/FindingReview";
import { IssueReproductionResult } from "@/components/IssueReproduction";
import { EmptyState } from "@/components/ui";
import { findings } from "@/services/findings";
import {
  CopyValue,
  EvidenceIds,
  Facts,
  Prose,
  readable,
  timestamp,
  withOccurrenceKeys,
} from "./common";
import { EvidenceView } from "./EvidenceView";
import { evidenceVerificationPendingLabel } from "./evidence-verification";
import { outcomePresentation, recommendationLabel } from "./presentation";

function CheckOutcome({ outcome }: { outcome: ValidationCheckResult["outcome"] }) {
  const presentation = outcomePresentation(outcome);
  return <Chip size="medium" color={presentation.tone} label={presentation.label} />;
}

function CheckRow({
  check,
  expanded,
  onToggle,
}: {
  check: ValidationCheckResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detailId = useId();
  return (
    <>
      <TableRow>
        <TableCell sx={{ width: 48 }}>
          <IconButton
            size="medium"
            aria-label={`${expanded ? "Collapse" : "Expand"} check ${check.name}`}
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={onToggle}
          >
            {expanded ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
          </IconButton>
        </TableCell>
        <TableCell component="th" scope="row">
          <Stack spacing={0.25}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {check.name}
            </Typography>
            <CopyValue value={check.id} />
          </Stack>
        </TableCell>
        <TableCell>{readable(check.kind)}</TableCell>
        <TableCell>{readable(check.source)}</TableCell>
        <TableCell>{check.required ? "Required" : "Optional"}</TableCell>
        <TableCell>
          <CheckOutcome outcome={check.outcome} />
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={6} sx={{ p: 0, borderBottom: expanded ? undefined : 0 }}>
          <Collapse in={expanded} timeout="auto" unmountOnExit>
            <Box id={detailId} sx={{ p: 2, bgcolor: "action.hover" }}>
              <Facts
                columns={1}
                items={[
                  { label: "Summary", value: <Prose>{check.summary}</Prose> },
                  { label: "Expected", value: <Prose>{check.expected ?? "Not recorded"}</Prose> },
                  { label: "Actual", value: <Prose>{check.actual ?? "Not recorded"}</Prose> },
                  { label: "Evidence IDs", value: <EvidenceIds ids={check.evidenceIds} /> },
                ]}
              />
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function Checks({ result }: { result: DashboardReviewRunResult }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(() => new Set());
  const checks = result.report.checks;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(checks.length / pageSize) - 1));
  return (
    <Stack spacing={3} sx={{ width: "100%" }}>
      <Stack
        component="section"
        spacing={2}
        sx={{ p: { xs: 2, sm: 3 }, bgcolor: "var(--app-accent-soft)", borderRadius: "12px" }}
      >
        <Prose>{result.report.summary}</Prose>
        <Facts
          items={[
            { label: "Report source", value: "Worker" },
            { label: "Source state", value: readable(result.report.sourceState) },
            ...(result.report.workItemKind === "issue"
              ? [
                  {
                    label: "Recorded worker reproduction conclusion",
                    value: readable(result.report.reproductionConclusion),
                  },
                ]
              : []),
          ]}
        />
      </Stack>
      {result.report.sourceState !== "original" && (
        <Alert severity="warning">
          <AlertTitle>
            {result.report.sourceState === "modified"
              ? "The tested source was modified during execution"
              : "The final source state is unknown"}
          </AlertTitle>
          Assess these checks with the recorded source state and run policy.
        </Alert>
      )}
      <Typography color="text.secondary">
        Expand a check to compare expected and actual behavior and inspect its evidence references.
      </Typography>
      <Box>
        <TableContainer>
          <Table size="medium" aria-label="Worker checks" sx={{ minWidth: 720 }}>
            <TableHead>
              <TableRow>
                <TableCell aria-label="Check details" />
                <TableCell>Check</TableCell>
                <TableCell>Kind</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Required</TableCell>
                <TableCell>Outcome</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {checks.length ? (
                checks.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((check) => (
                  <CheckRow
                    key={check.id}
                    check={check}
                    expanded={expandedChecks.has(check.id)}
                    onToggle={() =>
                      setExpandedChecks((previous) => {
                        const next = new Set(previous);
                        if (next.has(check.id)) next.delete(check.id);
                        else next.add(check.id);
                        return next;
                      })
                    }
                  />
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6}>
                    <EmptyState title="No checks were recorded. Validation has not been established." />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={checks.length}
          page={currentPage}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[10, 20, 50]}
          onPageChange={(_, nextPage) => setPage(nextPage)}
          onRowsPerPageChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(0);
          }}
        />
      </Box>
    </Stack>
  );
}

function ModelReview({
  model,
  workItemKind,
}: {
  model: DashboardValidationModelReview;
  workItemKind: "issue" | "pull_request";
}) {
  const issue = model.issueTriage;
  const sectionId = useId();
  const modelFindings = withOccurrenceKeys(model.findings, (row) => JSON.stringify(row));
  const modelObservations = withOccurrenceKeys(model.observations, (row) => JSON.stringify(row));
  return (
    <Stack spacing={3} sx={{ width: "100%" }}>
      <Facts
        items={[
          { label: "Model review", value: readable(model.state) },
          ...(workItemKind === "pull_request"
            ? [{ label: "Model recommendation", value: recommendationLabel(model.recommendation) }]
            : [
                {
                  label: "Model reproduction conclusion",
                  value: model.reproductionConclusion
                    ? readable(model.reproductionConclusion)
                    : "Not reported",
                },
              ]),
        ]}
      />
      {model.error && (
        <Alert severity="error">
          <AlertTitle>{`Model review failed: ${model.error.code}`}</AlertTitle>
          {model.error.message}
        </Alert>
      )}
      <CliExecutionDetails execution={model.execution} />
      <Box
        component="section"
        sx={{ p: { xs: 2, sm: 3 }, bgcolor: "var(--app-accent-soft)", borderRadius: "12px" }}
      >
        <Prose>{model.summary ?? "No model summary was recorded."}</Prose>
      </Box>
      <Typography color="text.secondary">
        {workItemKind === "pull_request"
          ? "Model recommendations are separate from worker checks and policy eligibility."
          : "Model reproduction conclusions are separate from the worker's recorded checks and observations."}
      </Typography>
      {findings.mode === "sample" && (
        <>
          <Typography variant="h6" component="h3">
            Model findings
          </Typography>
          {model.findings.length ? (
            <Box>
              {modelFindings.map(({ key, item: finding }, ordinal) => (
                <Accordion
                  key={key}
                  elevation={0}
                  disableGutters
                  sx={{
                    border: 0,
                    borderBottom: 1,
                    borderColor: "divider",
                    borderRadius: 0,
                    bgcolor: "transparent",
                  }}
                >
                  <AccordionSummary
                    expandIcon={<ExpandMoreIcon />}
                    id={`${sectionId}-finding-${ordinal}-header`}
                    aria-controls={`${sectionId}-finding-${ordinal}-content`}
                  >
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <Chip
                        size="medium"
                        color={finding.priority < 2 ? "warning" : "default"}
                        label={`P${finding.priority}`}
                      />
                      <Typography>{finding.title}</Typography>
                    </Stack>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={2}>
                      <Prose>{finding.body}</Prose>
                      <Facts
                        items={[
                          {
                            label: "Location",
                            value: `${finding.path}:${finding.line}${finding.endLine === null ? "" : `–${finding.endLine}`}`,
                          },
                          {
                            label: "Confidence",
                            value: `${Math.round(finding.confidence * 100)}%`,
                          },
                          { label: "Finding ID", value: <CopyValue value={finding.findingId} /> },
                        ]}
                      />
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              ))}
            </Box>
          ) : (
            <Typography color="text.secondary">
              {model.state === "completed"
                ? "No findings were reported by the model."
                : "No findings are available from a completed model review."}
            </Typography>
          )}
          <Typography variant="h6" component="h3">
            Model observations
          </Typography>
          {model.observations.length ? (
            <Box>
              {modelObservations.map(({ key, item: observation }, ordinal) => (
                <Accordion
                  key={key}
                  elevation={0}
                  disableGutters
                  sx={{
                    border: 0,
                    borderBottom: 1,
                    borderColor: "divider",
                    borderRadius: 0,
                    bgcolor: "transparent",
                  }}
                >
                  <AccordionSummary
                    expandIcon={<ExpandMoreIcon />}
                    id={`${sectionId}-observation-${ordinal}-header`}
                    aria-controls={`${sectionId}-observation-${ordinal}-content`}
                  >
                    <Typography>{`P${observation.priority} · ${observation.title}`}</Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={2}>
                      <Prose>{observation.body}</Prose>
                      <Facts
                        items={[
                          { label: "Observation ID", value: <CopyValue value={observation.id} /> },
                          {
                            label: "Location",
                            value: observation.path
                              ? `${observation.path}${observation.line === null ? "" : `:${observation.line}`}`
                              : "Not recorded",
                          },
                        ]}
                      />
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              ))}
            </Box>
          ) : (
            <Typography color="text.secondary">No model observations were recorded.</Typography>
          )}
        </>
      )}
      {workItemKind === "issue" && (
        <>
          <Typography variant="h6" component="h3">
            Issue triage
          </Typography>
          {issue ? (
            <Facts
              items={[
                { label: "Category", value: readable(issue.category) },
                { label: "Priority", value: `P${issue.priority}` },
                { label: "Confidence", value: `${Math.round(issue.confidence * 100)}%` },
                {
                  label: "Suggested labels",
                  value: issue.suggestedLabels.length ? (
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap" }}>
                      {issue.suggestedLabels.map((label) => (
                        <Chip key={label} size="medium" label={label} />
                      ))}
                    </Stack>
                  ) : (
                    "None suggested"
                  ),
                },
                {
                  label: "Missing information",
                  value: issue.missingInformation.length ? (
                    <ul>
                      {issue.missingInformation.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    "None requested"
                  ),
                },
                {
                  label: "Possible duplicates",
                  value: issue.duplicateCandidates.length ? (
                    <ul>
                      {issue.duplicateCandidates.map((candidate) => (
                        <li key={candidate.number}>
                          #{candidate.number}: {candidate.reason}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "None reported"
                  ),
                },
              ]}
            />
          ) : (
            <Typography color="text.secondary">No issue triage report was recorded.</Typography>
          )}
        </>
      )}
    </Stack>
  );
}

function DiagnosticRow({
  diagnostic,
  expanded,
  onToggle,
}: {
  diagnostic: ValidationStepDiagnostic;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detailId = useId();
  const expandable = diagnostic.stdout !== undefined || diagnostic.stderr !== undefined;
  return (
    <>
      <TableRow>
        <TableCell sx={{ width: 48 }}>
          {expandable && (
            <IconButton
              size="medium"
              aria-label={`${expanded ? "Collapse" : "Expand"} diagnostic ${diagnostic.stepId}`}
              aria-expanded={expanded}
              aria-controls={detailId}
              onClick={onToggle}
            >
              {expanded ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
            </IconButton>
          )}
        </TableCell>
        <TableCell component="th" scope="row">
          <CopyValue value={diagnostic.stepId} />
        </TableCell>
        <TableCell>{readable(diagnostic.phase)}</TableCell>
        <TableCell>
          <CheckOutcome outcome={diagnostic.outcome} />
        </TableCell>
        <TableCell>{diagnostic.exitCode ?? "Not recorded"}</TableCell>
        <TableCell>{diagnostic.summary}</TableCell>
      </TableRow>
      {expandable && (
        <TableRow>
          <TableCell colSpan={6} sx={{ p: 0, borderBottom: expanded ? undefined : 0 }}>
            <Collapse in={expanded} timeout="auto" unmountOnExit>
              <Box id={detailId} sx={{ p: 2, bgcolor: "action.hover" }}>
                <Facts
                  columns={1}
                  items={[
                    {
                      label: "Standard output",
                      value: <Prose>{diagnostic.stdout ?? "Not captured"}</Prose>,
                    },
                    {
                      label: "Standard error",
                      value: <Prose>{diagnostic.stderr ?? "Not captured"}</Prose>,
                    },
                  ]}
                />
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function Execution({ result }: { result: DashboardReviewRunResult }) {
  const [blockerPage, setBlockerPage] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [expandedDiagnostics, setExpandedDiagnostics] = useState<Set<string>>(() => new Set());
  const blockers = withOccurrenceKeys(result.execution.blockers, (row) => JSON.stringify(row));
  const diagnostics = withOccurrenceKeys(result.execution.diagnostics, (row) =>
    JSON.stringify(row),
  );
  const currentBlockerPage = Math.min(
    blockerPage,
    Math.max(0, Math.ceil(blockers.length / 10) - 1),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(diagnostics.length / pageSize) - 1));
  return (
    <Stack spacing={3} sx={{ width: "100%" }}>
      <Facts items={[{ label: "Cleanup", value: readable(result.execution.cleanupState) }]} />
      <Typography variant="h6" component="h3">
        Execution blockers
      </Typography>
      {blockers.length ? (
        <Box>
          <TableContainer>
            <Table size="medium" aria-label="Execution blockers" sx={{ minWidth: 680 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Phase</TableCell>
                  <TableCell>Step</TableCell>
                  <TableCell>Code</TableCell>
                  <TableCell>Message</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {blockers
                  .slice(currentBlockerPage * 10, (currentBlockerPage + 1) * 10)
                  .map(({ key, item: blocker }) => (
                    <TableRow key={key}>
                      <TableCell>{readable(blocker.phase)}</TableCell>
                      <TableCell>
                        <CopyValue value={blocker.stepId} />
                      </TableCell>
                      <TableCell>{blocker.code}</TableCell>
                      <TableCell>{blocker.message}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={blockers.length}
            page={currentBlockerPage}
            rowsPerPage={10}
            rowsPerPageOptions={[]}
            onPageChange={(_, nextPage) => setBlockerPage(nextPage)}
          />
        </Box>
      ) : (
        <Typography color="text.secondary">No lifecycle blockers were recorded.</Typography>
      )}
      <Typography variant="h6" component="h3">
        Step diagnostics
      </Typography>
      <Box>
        <TableContainer>
          <Table size="medium" aria-label="Step diagnostics" sx={{ minWidth: 700 }}>
            <TableHead>
              <TableRow>
                <TableCell aria-label="Diagnostic details" />
                <TableCell>Step</TableCell>
                <TableCell>Phase</TableCell>
                <TableCell>Outcome</TableCell>
                <TableCell>Exit code</TableCell>
                <TableCell>Summary</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {diagnostics.length ? (
                diagnostics
                  .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
                  .map(({ key, item: diagnostic }) => (
                    <DiagnosticRow
                      key={key}
                      diagnostic={diagnostic}
                      expanded={expandedDiagnostics.has(key)}
                      onToggle={() =>
                        setExpandedDiagnostics((previous) => {
                          const next = new Set(previous);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    />
                  ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6}>
                    <EmptyState title="No step diagnostics were recorded." />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={diagnostics.length}
          page={currentPage}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[10, 20, 50]}
          onPageChange={(_, nextPage) => setPage(nextPage)}
          onRowsPerPageChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(0);
          }}
        />
      </Box>
    </Stack>
  );
}

function Evidence({ result }: { result: DashboardReviewRunResult }) {
  const evidenceIds = [...new Set(result.report.checks.flatMap((check) => check.evidenceIds))];
  return (
    <EvidenceView
      scope={{
        repositoryId: result.repositoryId,
        runId: result.reviewRunId,
        jobId: result.jobId,
        runAttemptId: result.runAttemptId,
        requestId: result.requestId,
        profileVersionId: result.profileVersionId,
        revisionKey: result.revisionKey,
        planDigest: result.planDigest,
      }}
      references={evidenceIds.map((id) => ({
        id,
        checkIds: result.report.checks
          .filter((check) => check.evidenceIds.includes(id))
          .map((check) => check.id),
      }))}
    />
  );
}

export function ReportView({ result }: { result: DashboardReviewRunResult }) {
  const [activeTab, setActiveTab] = useState(result.reproduction ? "reproduction" : "checks");
  const [visitedTabs, setVisitedTabs] = useState(() => new Set([activeTab]));
  const reportId = useId();
  const tabs = [
    ...(result.report.workItemKind === "issue"
      ? [
          {
            key: "reproduction",
            label: "Issue reproduction",
            content: <IssueReproductionResult result={result} />,
          },
        ]
      : []),
    { key: "checks", label: "Worker checks", content: <Checks result={result} /> },
    {
      key: "model",
      label: "Model review",
      content: <ModelReview model={result.modelReview} workItemKind={result.report.workItemKind} />,
    },
    {
      key: "findings",
      label: "Findings and dispositions",
      content: <FindingReview result={result} />,
    },
    { key: "execution", label: "Execution diagnostics", content: <Execution result={result} /> },
    { key: "evidence", label: "Evidence files", content: <Evidence result={result} /> },
  ];
  const selectedTab = tabs.some((tab) => tab.key === activeTab) ? activeTab : "checks";
  useEffect(() => {
    setVisitedTabs((previous) =>
      previous.has(selectedTab) ? previous : new Set([...previous, selectedTab]),
    );
  }, [selectedTab]);
  return (
    <Stack spacing={3} sx={{ width: "100%", minWidth: 0 }}>
      {result.evidenceVerificationPending === true && (
        <Alert severity="info">
          <AlertTitle>{evidenceVerificationPendingLabel}</AlertTitle>
          {`The recorded runner checks remain available while the server verifies their evidence.${result.report.workItemKind === "pull_request" ? " This pending verification does not establish approval eligibility." : " Recorded reproduction observations are unchanged."} Automatic refresh is limited; use Refresh result if verification is still pending.`}
        </Alert>
      )}
      {!result.authoritative && (
        <Alert severity="warning">
          <AlertTitle>Historical result</AlertTitle>
          {result.report.workItemKind === "issue"
            ? "This result is not current for its request. Its recorded reproduction assessment remains historical; inspect the current assessment and latest execution."
            : "This result is not authoritative for its request. Review the latest execution and run policy before making a decision."}
        </Alert>
      )}

      <Box sx={{ minWidth: 0 }}>
        <Tabs
          value={selectedTab}
          onChange={(_, value: string) => {
            setActiveTab(value);
            setVisitedTabs((previous) => new Set([...previous, value]));
          }}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Report sections"
          sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}
        >
          {tabs.map((tab) => (
            <Tab
              key={tab.key}
              value={tab.key}
              label={tab.label}
              id={`${reportId}-tab-${tab.key}`}
              aria-controls={`${reportId}-panel-${tab.key}`}
            />
          ))}
        </Tabs>
        {tabs.map((tab) => (
          <Box
            key={tab.key}
            role="tabpanel"
            id={`${reportId}-panel-${tab.key}`}
            aria-labelledby={`${reportId}-tab-${tab.key}`}
            hidden={selectedTab !== tab.key}
          >
            {(selectedTab === tab.key || visitedTabs.has(tab.key)) && tab.content}
          </Box>
        ))}
      </Box>
      <Accordion
        elevation={0}
        disableGutters
        sx={{
          border: 0,
          borderTop: 1,
          borderColor: "divider",
          borderRadius: 0,
          bgcolor: "transparent",
        }}
      >
        <AccordionSummary
          expandIcon={<ExpandMoreIcon />}
          id={`${reportId}-identity-header`}
          aria-controls={`${reportId}-identity-content`}
        >
          <Typography variant="subtitle1" component="span">
            Saved result identity
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Facts
            items={[
              { label: "Result ID", value: <CopyValue value={result.id} /> },
              { label: "Job ID", value: <CopyValue value={result.jobId} /> },
              { label: "Run attempt ID", value: <CopyValue value={result.runAttemptId} /> },
              { label: "Activation", value: result.activationNumber },
              { label: "Saved", value: timestamp(result.createdAt) },
              { label: "Authoritative for request", value: result.authoritative ? "Yes" : "No" },
              { label: "Revision key", value: <CopyValue value={result.revisionKey} /> },
              { label: "Plan digest", value: <CopyValue value={result.planDigest} /> },
              { label: "Profile version ID", value: <CopyValue value={result.profileVersionId} /> },
              { label: "Prompt version ID", value: <CopyValue value={result.promptVersionId} /> },
              { label: "Worker result digest", value: <CopyValue value={result.resultDigest} /> },
            ]}
          />
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}
