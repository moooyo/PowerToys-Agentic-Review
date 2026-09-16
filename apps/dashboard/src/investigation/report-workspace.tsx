import type { ActionContextV1, InvestigationActionKind } from "@agentic-review/contracts";
import DownloadRounded from "@mui/icons-material/DownloadRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useReducer, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ActionPanel } from "./action-panel";
import { investigationApi, type WorkItem } from "./api";
import { ArtifactPanel } from "./artifact-panel";
import {
  createFeedbackSelection,
  feedbackSelectionReducer,
  isFindingSelected,
} from "./feedback-selection";
import {
  AssessmentPanel,
  CoveragePanel,
  FindingCard,
  Section,
  SubjectPanel,
  TextList,
  ValidationPanel,
} from "./report-sections";
import {
  assertActionContext,
  assertFindingsPage,
  assertReportBindings,
  selectionContext,
} from "./report-state";

export function StandaloneActions({ workItem }: { workItem: WorkItem }) {
  const query = useQuery({
    queryKey: ["investigation-action-context", workItem.id],
    queryFn: () => investigationApi.actionContext(workItem.id),
  });
  if (query.isPending) return <CircularProgress size={24} aria-label="Loading available actions" />;
  if (query.isError) return <Alert severity="error">{query.error.message}</Alert>;
  return (
    <ActionsWithState
      key={`${query.data.reportRef?.id ?? workItem.id}:${query.data.reportRef?.version ?? 0}`}
      workItem={workItem}
      context={query.data}
    />
  );
}

function ActionsWithState({ workItem, context }: { workItem: WorkItem; context: ActionContextV1 }) {
  const [selection, dispatch] = useReducer(
    feedbackSelectionReducer<InvestigationActionKind>,
    selectionContext(context),
    createFeedbackSelection<InvestigationActionKind>,
  );
  const result = useQuery({
    queryKey: ["investigation-report-export", context.reportRef?.id],
    queryFn: async () => {
      const value = await investigationApi.exportReport(context.reportRef!.id);
      if (
        value.report.id !== context.reportRef?.id ||
        value.report.version !== context.reportRef.version ||
        value.report.logicalContentDigest !== context.reportRef.digest ||
        value.context.workItem.id !== workItem.id
      )
        throw new Error("The report no longer matches the selected action context.");
      return value;
    },
    enabled: Boolean(context.reportRef),
  });
  useEffect(() => dispatch({ type: "refresh", context: selectionContext(context) }), [context]);
  return (
    <Stack spacing={2}>
      {result.isError && <Alert severity="error">{result.error.message}</Alert>}
      <ActionPanel
        workItem={workItem}
        context={context}
        result={result.data}
        selection={selection}
        dispatch={dispatch}
        editedBodies={{}}
      />
    </Stack>
  );
}

export function ReportWorkspace({ reportId }: { reportId: string }) {
  const section = new URLSearchParams(useLocation().search).get("section");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [tab, setTab] = useState(0);
  const [editedBodies, setEditedBodies] = useState<Record<string, string>>({});
  const [exportError, setExportError] = useState<string>();
  const header = useQuery({
    queryKey: ["investigation-report", reportId],
    queryFn: () => investigationApi.report(reportId),
  });
  const full = useQuery({
    queryKey: ["investigation-report-export", reportId],
    queryFn: async () => {
      if (!header.data) throw new Error("The report header is unavailable.");
      const result = await investigationApi.exportReport(reportId);
      assertReportBindings(header.data, result);
      return result;
    },
    enabled: Boolean(header.data),
  });
  const page = useQuery({
    queryKey: ["investigation-findings", reportId, cursors[pageIndex]],
    queryFn: async () => {
      if (!header.data) throw new Error("The report header is unavailable.");
      const result = await investigationApi.findings(reportId, cursors[pageIndex], 25);
      assertFindingsPage(header.data, result);
      return result;
    },
    enabled: Boolean(header.data),
  });
  const workItemId = header.data?.context.workItem.id;
  const workItem = useQuery({
    queryKey: ["investigation-work-item", workItemId],
    queryFn: () => investigationApi.workItem(workItemId!),
    enabled: Boolean(workItemId),
  });
  const context = useQuery({
    queryKey: ["investigation-action-context", workItemId, reportId],
    queryFn: async () => {
      if (!header.data) throw new Error("The report header is unavailable.");
      const result = await investigationApi.actionContext(
        header.data.context.workItem.id,
        reportId,
      );
      assertActionContext(header.data, result);
      return result;
    },
    enabled: Boolean(header.data),
  });
  const [selection, dispatch] = useReducer(
    feedbackSelectionReducer<InvestigationActionKind>,
    { reportId, reportVersion: 0, recommendedAction: null, suggestionOptions: [] },
    createFeedbackSelection<InvestigationActionKind>,
  );
  useEffect(() => {
    if (["evidence", "validation", "changes"].includes(section ?? "")) setTab(2);
  }, [section]);
  useEffect(() => {
    if (context.data) dispatch({ type: "refresh", context: selectionContext(context.data) });
  }, [context.data]);
  if (header.isPending)
    return (
      <Box role="status" sx={{ py: 4 }}>
        <CircularProgress size={28} />
        <Typography sx={{ mt: 1 }}>Loading structured report…</Typography>
      </Box>
    );
  if (header.isError)
    return (
      <Alert severity="error">
        {header.error.message}
        <Button onClick={() => void header.refetch()}>Retry report</Button>
      </Alert>
    );
  const value = header.data;
  const result = full.data;
  const selectionReady =
    Boolean(context.data) &&
    selection.reportId === value.report.id &&
    selection.reportVersion === value.report.version;
  const download = async () => {
    setExportError(undefined);
    try {
      const exported = result ?? (await investigationApi.exportReport(reportId));
      assertReportBindings(value, exported);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${reportId}-v${exported.report.version}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "The report could not be exported.");
    }
  };
  const refresh = () => {
    void context.refetch();
    void workItem.refetch();
  };
  return (
    <Stack spacing={3}>
      <Box>
        <Stack direction="row" useFlexGap spacing={1} sx={{ mb: 1, flexWrap: "wrap" }}>
          <Chip
            label={`Execution: ${value.outcome}`}
            color={
              value.outcome === "completed"
                ? "success"
                : value.outcome === "failed"
                  ? "error"
                  : "warning"
            }
          />
          <Chip
            label={`Report: ${value.report.completeness}`}
            color={value.report.completeness === "complete" ? "default" : "warning"}
          />
          <Chip
            label={value.report.delivery === "final" ? "Final delivery" : "Checkpoint only"}
            variant="outlined"
          />
          <Chip label={`${value.report.collections.findings} total findings`} variant="outlined" />
        </Stack>
        <Typography variant="h4" sx={{ mb: 1 }}>
          {value.context.workItem.title}
        </Typography>
        <Typography color="text.secondary">
          {value.context.repository.fullName} #{value.context.workItem.number} · Report version{" "}
          {value.report.version}
        </Typography>
        <Typography sx={{ mt: 2 }}>{value.report.summary}</Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button
            component={Link}
            to={`/tasks?taskId=${encodeURIComponent(value.context.task.id)}&repositoryId=${encodeURIComponent(value.context.repository.id)}`}
          >
            Open task
          </Button>
          <Button startIcon={<DownloadRounded />} onClick={() => void download()}>
            Export complete JSON
          </Button>
          <Button startIcon={<RefreshRounded />} onClick={refresh}>
            Refresh actions
          </Button>
        </Stack>
      </Box>
      {value.report.completeness === "partial" && (
        <Alert severity="warning">
          This is an incomplete investigation. Retained findings and evidence are available, but the
          report does not claim to cover the entire frozen scope. Stop reason:{" "}
          {value.report.loop.stopReason}.
        </Alert>
      )}
      <Alert severity="info">
        Execution outcome and report completeness are independent of code correctness and runtime
        validation. The server evaluates action availability against the complete findings
        collection.
      </Alert>
      {(exportError || full.isError) && (
        <Alert severity="error">
          {exportError ?? full.error?.message}
          <Button onClick={() => void full.refetch()}>Reload report details</Button>
        </Alert>
      )}
      <AssessmentPanel assessment={value.assessment} />
      <Tabs
        value={tab}
        onChange={(_event, next: number) => setTab(next)}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Report sections"
      >
        <Tab label={`Findings (${value.report.collections.findings})`} />
        <Tab label="Coverage and loop" />
        <Tab label="Validation and evidence" />
        <Tab label="Plans and diagnostics" />
      </Tabs>
      {tab === 0 && (
        <Stack spacing={2}>
          {page.isPending && <CircularProgress size={24} aria-label="Loading findings" />}
          {page.isError && (
            <Alert severity="error">
              {page.error.message}
              <Button onClick={() => void page.refetch()}>Retry page</Button>
            </Alert>
          )}
          {page.data && (
            <>
              <Stack
                direction="row"
                useFlexGap
                spacing={1}
                sx={{ flexWrap: "wrap", alignItems: "center" }}
              >
                <Typography sx={{ flex: 1 }}>
                  {page.data.total === 0
                    ? "No retained findings."
                    : `Showing ${page.data.offset + 1}–${page.data.offset + page.data.items.length} of ${page.data.total} findings`}{" "}
                  · {selection.selectedFindings.length} selected across all pages
                </Typography>
                <Button
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex((index) => index - 1)}
                >
                  Previous
                </Button>
                <Button
                  disabled={page.data.nextCursor === null}
                  onClick={() => {
                    const nextCursor = page.data?.nextCursor;
                    if (!nextCursor) return;
                    setCursors((previous) => [...previous.slice(0, pageIndex + 1), nextCursor]);
                    setPageIndex((index) => index + 1);
                  }}
                >
                  Next
                </Button>
              </Stack>
              {page.data.items.map((finding) => (
                <FindingCard
                  key={`${finding.id}:${finding.version}`}
                  finding={finding}
                  evidence={result?.verificationEvidence ?? []}
                  selected={isFindingSelected(selection, finding.id)}
                  selectionEnabled={selectionReady}
                  draftBody={editedBodies[finding.feedbackDraft.id] ?? finding.feedbackDraft.body}
                  suggestionValid={
                    context.data?.suggestionSelectionDefaults.some(
                      (option) =>
                        option.findingId === finding.id &&
                        option.draftId === finding.feedbackDraft.id &&
                        option.valid,
                    ) ?? false
                  }
                  onSelect={(selected) =>
                    dispatch({
                      type: "set-finding",
                      finding: {
                        findingId: finding.id,
                        draftId: finding.feedbackDraft.id,
                        suggestionId: finding.feedbackDraft.suggestion
                          ? finding.feedbackDraft.id
                          : null,
                      },
                      selected,
                    })
                  }
                  onDraftChange={(body) =>
                    setEditedBodies((previous) => ({
                      ...previous,
                      [finding.feedbackDraft.id]: body,
                    }))
                  }
                />
              ))}
            </>
          )}
          {result && result.feedbackDrafts.length > 0 && (
            <Section title="Independent feedback drafts">
              <Stack spacing={2}>
                {result.feedbackDrafts.map((draft) => (
                  <Box key={draft.id}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          disabled={!selectionReady}
                          checked={selection.selectedDraftIds.includes(draft.id)}
                          onChange={(event) =>
                            dispatch({
                              type: "set-draft",
                              draftId: draft.id,
                              selected: event.target.checked,
                            })
                          }
                        />
                      }
                      label="Include this draft"
                    />
                    <TextField
                      multiline
                      fullWidth
                      minRows={3}
                      label="Feedback draft"
                      value={editedBodies[draft.id] ?? draft.body}
                      onChange={(event) =>
                        setEditedBodies((previous) => ({
                          ...previous,
                          [draft.id]: event.target.value,
                        }))
                      }
                    />
                  </Box>
                ))}
              </Stack>
            </Section>
          )}
        </Stack>
      )}
      {tab !== 0 && full.isPending && (
        <CircularProgress size={24} aria-label="Loading complete report details" />
      )}
      {tab === 1 && result && (
        <>
          <CoveragePanel report={result.report} />
          <SubjectPanel subjects={result.context.subjects} />
        </>
      )}
      {tab === 2 && result && (
        <>
          <ValidationPanel validation={result.validation} />
          <Section title="Verification evidence">
            <Stack spacing={2}>
              {result.verificationEvidence.map((evidence) => (
                <Box key={evidence.id}>
                  <Typography variant="subtitle2">{evidence.summary}</Typography>
                  <Typography variant="caption" component="div" color="text.secondary">
                    {evidence.id} · {evidence.source} · {evidence.authority} · {evidence.subjectRef}
                  </Typography>
                  <Typography variant="caption">
                    {evidence.provenance.producer} · {evidence.provenance.recordedAt} · Attempt{" "}
                    {evidence.provenance.attemptId}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Section>
          <ArtifactPanel artifacts={result.artifacts} />
          {result.context.sourceArtifacts && result.context.sourceArtifacts.length > 0 && (
            <ArtifactPanel artifacts={result.context.sourceArtifacts} origin="inherited" />
          )}
        </>
      )}
      {tab === 3 && result && (
        <>
          <Section title="Saved plans">
            <Stack spacing={2}>
              {result.plans.map((plan) => (
                <Box key={plan.id}>
                  <Typography variant="subtitle2">{plan.title}</Typography>
                  <Typography variant="body2">{plan.rationale}</Typography>
                  <Typography variant="caption">
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
                  <TextList items={plan.prerequisites.map((entry) => entry.description)} />
                  <Typography variant="overline">Acceptance criteria</Typography>
                  <TextList items={plan.acceptanceCriteria} />
                </Box>
              ))}
            </Stack>
          </Section>
          <Section title="Diagnostics">
            {result.diagnostics.length === 0 ? (
              <Typography color="text.secondary">No diagnostics recorded.</Typography>
            ) : (
              <Stack spacing={1}>
                {result.diagnostics.map((diagnostic) => (
                  <Alert
                    key={diagnostic.id}
                    severity={
                      diagnostic.category === "error"
                        ? "error"
                        : diagnostic.category === "blocker"
                          ? "warning"
                          : "info"
                    }
                  >
                    <Typography variant="subtitle2">{diagnostic.code}</Typography>
                    {diagnostic.message}
                    <Typography variant="caption" component="div">
                      {diagnostic.retryable
                        ? "Retry may resolve this condition."
                        : "Review the recorded prerequisites before continuing."}
                    </Typography>
                  </Alert>
                ))}
              </Stack>
            )}
          </Section>
        </>
      )}
      {context.isError && (
        <Alert severity="error">
          {context.error.message}
          <Button onClick={() => void context.refetch()}>Retry actions</Button>
        </Alert>
      )}
      {workItem.isError && <Alert severity="error">{workItem.error.message}</Alert>}
      {context.data && workItem.data && selectionReady && (
        <ActionPanel
          workItem={workItem.data}
          context={context.data}
          result={result}
          selection={selection}
          dispatch={dispatch}
          editedBodies={editedBodies}
        />
      )}
    </Stack>
  );
}

export default function ReportPage() {
  const reportId = new URLSearchParams(useLocation().search).get("reportId");
  return reportId ? (
    <ReportWorkspace key={reportId} reportId={reportId} />
  ) : (
    <Alert severity="info">Open a report from a pull request, issue, or task.</Alert>
  );
}
