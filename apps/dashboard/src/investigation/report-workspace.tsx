import type {
  ActionContextV1,
  InvestigationActionKind,
  InvestigationReportHeaderV1,
} from "@agentic-review/contracts";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import CheckRounded from "@mui/icons-material/CheckRounded";
import DownloadRounded from "@mui/icons-material/DownloadRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ActionPanel } from "./action-panel";
import { investigationApi, type WorkItem } from "./api";
import {
  createFeedbackSelection,
  type FeedbackSelectionEvent,
  feedbackSelectionReducer,
  isFindingSelected,
} from "./feedback-selection";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { ReportDetails, ReportEvidence } from "./report-detail-panels";
import { ReportDirectory, reportKindLabel } from "./report-directory";
import {
  createReportDraft,
  isReportDraftDirty,
  type PrivateReportDraft,
  type ReportDraftEvent,
  reportDraftKey,
  reportDraftReducer,
  retainReportDraft,
} from "./report-draft-store";
import { FindingCard, Section } from "./report-sections";
import {
  assertActionContext,
  assertFindingsPage,
  assertReportBindings,
  selectionContext,
} from "./report-state";
import { sessionIdentity, useInvestigationSession } from "./session";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";
import "./report-workspace.css";

export function StandaloneActions({ workItem }: { workItem: WorkItem }) {
  const { session } = useInvestigationSession();
  const query = useQuery({
    queryKey: ["investigation-action-context", sessionIdentity(session), workItem.id],
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
  const { session } = useInvestigationSession();
  const [selection, dispatch] = useReducer(
    feedbackSelectionReducer<InvestigationActionKind>,
    selectionContext(context),
    createFeedbackSelection<InvestigationActionKind>,
  );
  const result = useQuery({
    queryKey: ["investigation-report-export", sessionIdentity(session), context.reportRef?.id],
    queryFn: async () => {
      const value = await investigationApi.exportReport(context.reportRef!.id);
      if (
        value.report.id !== context.reportRef?.id ||
        value.report.version !== context.reportRef.version ||
        value.report.logicalContentDigest !== context.reportRef.digest ||
        value.context.workItem.id !== workItem.id ||
        value.context.repository.id !== workItem.repositoryId
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

export type ReportTab = "findings" | "evidence" | "details";
export function reportTab(value: string | null): ReportTab {
  if (["evidence", "validation", "changes"].includes(value ?? "")) return "evidence";
  if (["details", "coverage", "plans", "diagnostics", "usage"].includes(value ?? ""))
    return "details";
  return "findings";
}

export function ReportWorkspace({ reportId }: { reportId: string }) {
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const header = useQuery({
    queryKey: ["investigation-report", identity, reportId],
    queryFn: async () => {
      const result = await investigationApi.report(reportId);
      if (result.id !== reportId || result.report.id !== reportId)
        throw new Error("The server returned a different report identity.");
      return result;
    },
  });
  if (header.isPending)
    return (
      <Box role="status" sx={{ py: 4 }}>
        <CircularProgress size={28} />
        <Typography sx={{ mt: 1 }}>Loading structured report…</Typography>
      </Box>
    );
  if (header.isError)
    return (
      <Alert
        severity="error"
        action={<Button onClick={() => void header.refetch()}>Retry report</Button>}
      >
        {header.error.message}
      </Alert>
    );
  return (
    <BoundReportWorkspace
      key={`${identity}:${header.data.report.id}:${header.data.report.version}:${header.data.report.logicalContentDigest}`}
      value={header.data}
      identity={identity}
    />
  );
}

function BoundReportWorkspace({
  value,
  identity,
}: {
  value: InvestigationReportHeaderV1;
  identity: string;
}) {
  const { session } = useInvestigationSession();
  const client = useQueryClient();
  const actionGuardScope = `report-action:${value.report.id}`;
  const guarded = useGuardedAction(actionGuardScope);
  const [params, setParams] = useSearchParams();
  const tab = reportTab(params.get("section") ?? params.get("tab"));
  const reportId = value.report.id;
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [actionOpen, setActionOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const exportBusy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const key = useMemo(() => reportDraftKey(identity, value), [identity, value]);
  const [draft, setDraft] = useState<PrivateReportDraft>(
    () =>
      client.getQueryData<PrivateReportDraft>(key) ??
      createReportDraft({
        reportId,
        reportVersion: value.report.version,
        recommendedAction: null,
        suggestionOptions: [],
      }),
  );
  const draftRef = useRef(draft);
  const updateDraft = useCallback(
    (event: ReportDraftEvent) => {
      const next = reportDraftReducer(draftRef.current, event);
      draftRef.current = next;
      retainReportDraft(client, key, next);
      setDraft(next);
    },
    [client, key],
  );
  const dispatch = useCallback(
    (event: FeedbackSelectionEvent<InvestigationActionKind>) =>
      updateDraft({ type: "selection", event }),
    [updateDraft],
  );
  const selection = draft.current.selection;
  const editedBodies = draft.current.editedBodies;
  const dirty = isReportDraftDirty(draft);
  useUnsavedChanges(dirty, {
    description:
      "Your report feedback has unsaved edits. Save a private draft to retain it when navigating.",
    busy: exporting,
    allowPresentationNavigation: true,
    onDiscard: () => updateDraft({ type: "discard" }),
  });
  const full = useQuery({
    queryKey: [
      "investigation-report-export",
      identity,
      reportId,
      value.report.version,
      value.report.logicalContentDigest,
    ],
    queryFn: async () => {
      const result = await investigationApi.exportReport(reportId);
      assertReportBindings(value, result);
      return result;
    },
  });
  const page = useQuery({
    queryKey: [
      "investigation-findings",
      identity,
      reportId,
      value.report.version,
      cursors[pageIndex],
    ],
    queryFn: async () => {
      const result = await investigationApi.findings(reportId, cursors[pageIndex], 25);
      assertFindingsPage(value, result);
      return result;
    },
  });
  const workItem = useQuery({
    queryKey: ["investigation-work-item", identity, value.context.workItem.id],
    queryFn: async () => {
      const item = await investigationApi.workItem(value.context.workItem.id);
      if (
        item.id !== value.context.workItem.id ||
        item.repositoryId !== value.context.repository.id ||
        item.kind !== value.context.workItem.kind ||
        item.number !== value.context.workItem.number
      )
        throw new Error("The live source does not match this report's original destination.");
      return item;
    },
  });
  const context = useQuery({
    queryKey: ["investigation-action-context", identity, value.context.workItem.id, reportId],
    queryFn: async () => {
      const result = await investigationApi.actionContext(value.context.workItem.id, reportId);
      assertActionContext(value, result);
      return result;
    },
  });
  useEffect(() => {
    if (context.data) dispatch({ type: "refresh", context: selectionContext(context.data) });
  }, [context.data, dispatch]);
  const selectionReady =
    Boolean(context.data) &&
    selection.reportId === reportId &&
    selection.reportVersion === value.report.version;
  const canEdit = selectionReady && session.user?.permissions.includes("action:prepare") === true;
  const result = full.data;
  const findingId = params.get("findingId");
  const finding = findingId
    ? (result?.findings.find((item) => item.id === findingId) ??
      page.data?.items.find((item) => item.id === findingId))
    : page.data?.items[0];
  const detailRef = useRef<HTMLDivElement>(null);
  const focusDetail = useRef(false);
  useEffect(() => {
    if (focusDetail.current && finding) {
      focusDetail.current = false;
      detailRef.current?.focus();
    }
  }, [finding]);
  const setSection = (next: ReportTab) => {
    const search = new URLSearchParams(params);
    search.set("section", next);
    search.delete("tab");
    setParams(search);
  };
  const selectFinding = (id: string) => {
    const search = new URLSearchParams(params);
    search.set("findingId", id);
    search.set("section", "findings");
    focusDetail.current = true;
    setParams(search);
  };
  const changePage = (next: number) => {
    const search = new URLSearchParams(params);
    search.delete("findingId");
    focusDetail.current = true;
    setParams(search);
    setPageIndex(next);
  };
  const backParams = new URLSearchParams(params);
  backParams.delete("reportId");
  backParams.delete("section");
  backParams.delete("tab");
  backParams.delete("findingId");
  const download = async () => {
    if (exportBusy.current) return;
    exportBusy.current = true;
    setExporting(true);
    setExportError(undefined);
    try {
      const exported = result ?? (await investigationApi.exportReport(reportId));
      assertReportBindings(value, exported);
      if (!alive.current) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }),
      );
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${reportId}-v${exported.report.version}.json`;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (cause) {
      if (alive.current)
        setExportError(
          cause instanceof Error ? cause.message : "The report could not be exported.",
        );
    } finally {
      exportBusy.current = false;
      if (alive.current) setExporting(false);
    }
  };
  const closeActions = () => {
    if (!actionBusy) guarded(() => setActionOpen(false));
  };
  return (
    <Stack spacing={3} className="report-workspace">
      <Button
        component={Link}
        to={`/reports${backParams.size ? `?${backParams}` : ""}`}
        startIcon={<ArrowBackRounded />}
        sx={{ alignSelf: "flex-start" }}
      >
        Reports
      </Button>
      <PageHeading
        eyebrow={`${reportKindLabel(value.context.task.kind)} · ${value.context.repository.fullName} · ${value.context.workItem.kind === "pull_request" ? "Pull request" : "Issue"} #${value.context.workItem.number}`}
        title={value.context.workItem.title}
        subtitle={`Saved report · Version ${value.report.version}`}
        action={
          <Button
            variant="contained"
            disabled={!context.data || !workItem.data || !selectionReady}
            onClick={() => setActionOpen(true)}
          >
            Prepare action
          </Button>
        }
      />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <Chip
          size="small"
          label={`Execution: ${value.outcome}`}
          color={
            value.outcome === "failed"
              ? "error"
              : value.outcome === "completed"
                ? "success"
                : "warning"
          }
        />
        <Chip
          size="small"
          label={`Report: ${value.report.completeness}`}
          color={value.report.completeness === "partial" ? "warning" : "default"}
        />
        <Chip
          size="small"
          label={value.report.delivery === "final" ? "Final delivery" : "Checkpoint only"}
          variant="outlined"
        />
        <Button
          component={Link}
          to={`/tasks?taskId=${encodeURIComponent(value.context.task.id)}&repositoryId=${encodeURIComponent(value.context.repository.id)}`}
        >
          Open task
        </Button>
        <Button
          startIcon={<RefreshRounded />}
          disabled={context.isFetching || workItem.isFetching}
          onClick={() => {
            void context.refetch();
            void workItem.refetch();
          }}
        >
          Refresh actions
        </Button>
      </Stack>
      <Surface className="report-conclusion" sx={{ p: { xs: 2, sm: 3 }, bgcolor: "action.hover" }}>
        <Typography variant="overline" color="text.secondary">
          Saved conclusion
        </Typography>
        <Typography component="h2" variant="h6" sx={{ mt: 0.5, mb: 1 }}>
          {value.report.summary}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {value.assessment.summary}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {value.validation.summary}
        </Typography>
      </Surface>
      {value.report.completeness === "partial" && (
        <Alert severity="warning">
          This checkpoint is incomplete. Retained findings and evidence do not cover the entire
          declared scope. Stop reason: {value.report.loop.stopReason}.
        </Alert>
      )}
      {context.data?.pendingSubmission && (
        <Alert
          severity="warning"
          action={<Button onClick={() => setActionOpen(true)}>Inspect submission</Button>}
        >
          A saved submission needs review. Its server identity remains available when you leave this
          report or discard private edits.
        </Alert>
      )}
      {(exportError || full.isError) && (
        <Alert
          severity="error"
          action={<Button onClick={() => void full.refetch()}>Reload details</Button>}
        >
          {exportError ?? full.error?.message}
        </Alert>
      )}
      {context.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void context.refetch()}>Retry actions</Button>}
        >
          {context.error.message}
        </Alert>
      )}
      {workItem.isError && <Alert severity="error">{workItem.error.message}</Alert>}
      <Box className="report-tabs-row" sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Tabs
          value={tab}
          onChange={(_event, next: ReportTab) => setSection(next)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Report sections"
        >
          <Tab
            value="findings"
            id="report-tab-findings"
            aria-controls="report-panel-findings"
            label={`Findings (${value.report.collections.findings})`}
          />
          <Tab
            value="evidence"
            id="report-tab-evidence"
            aria-controls="report-panel-evidence"
            label="Evidence"
          />
          <Tab
            value="details"
            id="report-tab-details"
            aria-controls="report-panel-details"
            label="Details"
          />
        </Tabs>
        <Button
          startIcon={<DownloadRounded />}
          disabled={exporting}
          onClick={() => void download()}
          aria-label="Export complete JSON"
        >
          Export report
        </Button>
      </Box>
      <Box role="tabpanel" id={`report-panel-${tab}`} aria-labelledby={`report-tab-${tab}`}>
        {tab === "findings" && (
          <Stack spacing={3}>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: "center" }}
            >
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                {selection.selectedFindings.length} findings selected across all pages ·{" "}
                {selection.selectedDraftIds.length} independent drafts
              </Typography>
              <Typography variant="caption" color="text.secondary" aria-live="polite">
                {dirty ? "Unsaved private edits" : "Private feedback saved for this session"}
              </Typography>
              <Button disabled={!dirty || !canEdit} onClick={() => updateDraft({ type: "save" })}>
                Save private draft
              </Button>
              <Button disabled={!dirty} onClick={() => updateDraft({ type: "discard" })}>
                Discard edits
              </Button>
            </Stack>
            {page.isPending && <CircularProgress size={24} aria-label="Loading findings" />}
            {page.isError && (
              <Alert
                severity="error"
                action={<Button onClick={() => void page.refetch()}>Retry page</Button>}
              >
                {page.error.message}
              </Alert>
            )}
            {page.data?.total === 0 && (
              <EmptyState
                title="No review findings"
                description="Review the saved coverage and supporting evidence before choosing the next action."
                action={<Button onClick={() => setSection("evidence")}>Review evidence</Button>}
              />
            )}
            {page.data && page.data.total > 0 && (
              <Box className="report-findings-layout">
                <Box
                  component="nav"
                  aria-label="Report findings"
                  className="report-finding-nav"
                  sx={{ borderColor: "divider" }}
                >
                  <Typography variant="caption" color="text.secondary" sx={{ px: 1, mb: 1 }}>
                    Showing {page.data.offset + 1}–{page.data.offset + page.data.items.length} of{" "}
                    {page.data.total} findings
                  </Typography>
                  {page.data.items.map((item) => (
                    <ButtonBase
                      key={`${item.id}:${item.version}`}
                      className="report-finding-nav-item"
                      aria-current={finding?.id === item.id ? "true" : undefined}
                      aria-controls="selected-report-finding"
                      onClick={() => selectFinding(item.id)}
                      sx={{
                        bgcolor: finding?.id === item.id ? "action.selected" : "transparent",
                        "&:hover": { bgcolor: "action.hover" },
                        borderRadius: 2,
                      }}
                    >
                      <Stack
                        direction="row"
                        spacing={1}
                        useFlexGap
                        sx={{ width: "100%", flexWrap: "wrap", alignItems: "center" }}
                      >
                        <Chip
                          size="small"
                          label={item.priority}
                          color={
                            item.priority === "P0"
                              ? "error"
                              : item.priority === "P1"
                                ? "warning"
                                : "default"
                          }
                        />
                        <Typography variant="caption" color="text.secondary">
                          {item.confirmation.status}
                        </Typography>
                        {isFindingSelected(selection, item.id) && (
                          <CheckRounded
                            fontSize="small"
                            aria-label="Included in feedback"
                            sx={{ ml: "auto" }}
                          />
                        )}
                      </Stack>
                      <Typography variant="subtitle2" sx={{ overflowWrap: "anywhere" }}>
                        {item.title}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ overflowWrap: "anywhere" }}
                      >
                        {item.locations[0]?.kind === "source"
                          ? `${item.locations[0].path}:${item.locations[0].startLine}`
                          : item.subjectRef}
                      </Typography>
                    </ButtonBase>
                  ))}
                  <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between" }}>
                    <Button disabled={pageIndex === 0} onClick={() => changePage(pageIndex - 1)}>
                      Previous
                    </Button>
                    <Button
                      disabled={!page.data.nextCursor}
                      onClick={() => {
                        const cursor = page.data?.nextCursor;
                        if (cursor) {
                          setCursors((current) => [...current.slice(0, pageIndex + 1), cursor]);
                          changePage(pageIndex + 1);
                        }
                      }}
                    >
                      Next
                    </Button>
                  </Stack>
                </Box>
                <Box
                  id="selected-report-finding"
                  ref={detailRef}
                  tabIndex={-1}
                  className="report-finding-detail"
                  sx={{ borderColor: "divider" }}
                >
                  {finding && !page.data.items.some((item) => item.id === finding.id) && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                      This linked finding is outside the current list page. It belongs to the
                      complete saved report, and selection remains shared across pages.
                    </Alert>
                  )}
                  {finding ? (
                    <FindingCard
                      key={`${finding.id}:${finding.version}`}
                      detail
                      finding={finding}
                      evidence={result?.verificationEvidence ?? []}
                      selected={isFindingSelected(selection, finding.id)}
                      selectionEnabled={canEdit}
                      draftBody={
                        editedBodies[finding.feedbackDraft.id] ?? finding.feedbackDraft.body
                      }
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
                        updateDraft({ type: "edit", draftId: finding.feedbackDraft.id, body })
                      }
                    />
                  ) : full.isPending ? (
                    <CircularProgress size={24} aria-label="Loading linked finding" />
                  ) : (
                    <EmptyState
                      title="Finding unavailable"
                      description="The linked finding does not belong to this saved report. Choose a finding from the list."
                    />
                  )}
                </Box>
              </Box>
            )}
            {result && result.feedbackDrafts.length > 0 && (
              <Section title="Independent feedback drafts">
                <Stack spacing={2}>
                  {result.feedbackDrafts.map((item) => (
                    <Box key={item.id}>
                      <FormControlLabel
                        control={
                          <Checkbox
                            disabled={!canEdit}
                            checked={selection.selectedDraftIds.includes(item.id)}
                            onChange={(event) =>
                              dispatch({
                                type: "set-draft",
                                draftId: item.id,
                                selected: event.target.checked,
                              })
                            }
                          />
                        }
                        label="Include this independent feedback"
                      />
                      <TextField
                        multiline
                        fullWidth
                        minRows={3}
                        label="Feedback draft"
                        disabled={!canEdit}
                        value={editedBodies[item.id] ?? item.body}
                        onChange={(event) =>
                          updateDraft({ type: "edit", draftId: item.id, body: event.target.value })
                        }
                      />
                    </Box>
                  ))}
                </Stack>
              </Section>
            )}
          </Stack>
        )}
        {tab !== "findings" && full.isPending && (
          <CircularProgress size={24} aria-label="Loading complete report details" />
        )}
        {tab === "evidence" && result && <ReportEvidence result={result} identity={identity} />}
        {tab === "details" && result && <ReportDetails value={value} result={result} />}
      </Box>
      <Dialog
        open={actionOpen}
        onClose={(_event, reason) => {
          if (actionBusy && (reason === "escapeKeyDown" || reason === "backdropClick")) return;
          closeActions();
        }}
        fullWidth
        maxWidth="lg"
        aria-labelledby="prepare-report-action-title"
      >
        <DialogTitle id="prepare-report-action-title">Prepare the next action</DialogTitle>
        <DialogContent dividers>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            Choose an operation, then inspect the exact saved preview before confirming it.
          </Typography>
          {actionOpen && context.data && workItem.data && selectionReady && (
            <ActionPanel
              workItem={workItem.data}
              context={context.data}
              result={result}
              selection={selection}
              dispatch={dispatch}
              editedBodies={editedBodies}
              onBusyChange={setActionBusy}
              guardScope={actionGuardScope}
              onSaveDraft={() => updateDraft({ type: "save" })}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={actionBusy} onClick={closeActions}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export default function ReportPage() {
  const reportId = new URLSearchParams(useLocation().search).get("reportId");
  return reportId ? <ReportWorkspace key={reportId} reportId={reportId} /> : <ReportDirectory />;
}
