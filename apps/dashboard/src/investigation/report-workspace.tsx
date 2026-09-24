import type {
  ActionContextV1,
  InvestigationActionKind,
  InvestigationReportHeaderV1,
} from "@agentic-review/contracts";
import DownloadRounded from "@mui/icons-material/DownloadRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ActionPanel, type ActionPanelRequest, actionLabels } from "./action-panel";
import { investigationApi, type WorkItem } from "./api";
import {
  createFeedbackSelection,
  type FeedbackSelectionEvent,
  feedbackSelectionReducer,
} from "./feedback-selection";
import { GithubSourceLink } from "./github-source-link";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { OutcomeSummary } from "./outcome-summary";
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
import { findingViewParameters } from "./report-findings";
import { ReportFindingsReader } from "./report-findings-reader";
import { assertActionContext, assertReportBindings, selectionContext } from "./report-state";
import { ReviewQueueBar } from "./review-navigation";
import { sessionIdentity, useInvestigationSession } from "./session";
import { sourceActionLabel } from "./source-result";
import { PageHeading } from "./workspace-ui";
import "./report-workspace.css";

export function StandaloneActions({
  workItem,
  reportId,
  request,
  onBusyChange,
  guardScope,
}: {
  workItem: WorkItem;
  reportId?: string;
  request?: ActionPanelRequest;
  onBusyChange?: (busy: boolean) => void;
  guardScope?: string;
}) {
  const { session } = useInvestigationSession();
  const query = useQuery({
    queryKey: ["investigation-action-context", sessionIdentity(session), workItem.id, reportId],
    queryFn: async () => {
      const context = await investigationApi.actionContext(workItem.id, reportId);
      if (
        context.workItemId !== workItem.id ||
        context.repositoryId !== workItem.repositoryId ||
        context.target.kind !== workItem.kind ||
        (reportId && context.reportRef?.id !== reportId)
      )
        throw new Error("The action context does not match this source and saved report.");
      return context;
    },
  });
  if (query.isPending) return <CircularProgress size={24} aria-label="Loading available actions" />;
  if (query.isError)
    return (
      <Alert
        severity="error"
        action={<Button onClick={() => void query.refetch()}>Retry actions</Button>}
      >
        {query.error.message}
      </Alert>
    );
  return (
    <ActionsWithState
      key={`${query.data.reportRef?.id ?? workItem.id}:${query.data.reportRef?.version ?? 0}:${query.data.reportRef?.digest ?? ""}`}
      workItem={workItem}
      context={query.data}
      request={request}
      onBusyChange={onBusyChange}
      guardScope={guardScope}
    />
  );
}

function ActionsWithState({
  workItem,
  context,
  request,
  onBusyChange,
  guardScope,
}: {
  workItem: WorkItem;
  context: ActionContextV1;
  request?: ActionPanelRequest;
  onBusyChange?: (busy: boolean) => void;
  guardScope?: string;
}) {
  const { session } = useInvestigationSession();
  const [selection, dispatch] = useReducer(
    feedbackSelectionReducer<InvestigationActionKind>,
    selectionContext(context),
    createFeedbackSelection<InvestigationActionKind>,
  );
  const result = useQuery({
    queryKey: [
      "investigation-report-export",
      sessionIdentity(session),
      context.reportRef?.id,
      context.reportRef?.version,
      context.reportRef?.digest,
    ],
    queryFn: async () => {
      if (!context.reportRef) throw new Error("No saved report is bound to this action context.");
      const value = await investigationApi.exportReport(context.reportRef.id);
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
        request={request}
        onBusyChange={onBusyChange}
        guardScope={guardScope}
      />
    </Stack>
  );
}

export type ReportTab = "findings" | "evidence" | "details";
export function recommendedReportRequest(
  action: InvestigationActionKind,
  nextActionId: string | undefined,
  hasSelection: boolean,
): Omit<ActionPanelRequest, "id"> {
  return {
    action,
    nextActionId,
    ...(hasSelection &&
    ["comment", "approve", "suggestion-comment", "request-changes"].includes(action)
      ? { importReportSelection: true }
      : {}),
  };
}
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
        <Typography sx={{ mt: 1 }}>Loading report…</Typography>
      </Box>
    );
  if (!header.data)
    return (
      <Alert
        severity="error"
        action={<Button onClick={() => void header.refetch()}>Retry report</Button>}
      >
        {header.error?.message ?? "The report could not be loaded."}
      </Alert>
    );
  return (
    <Stack spacing={2}>
      {header.isError && (
        <Alert
          severity="warning"
          action={<Button onClick={() => void header.refetch()}>Retry report</Button>}
        >
          Refresh failed. Showing the last loaded report.
        </Alert>
      )}
      <BoundReportWorkspace
        key={`${identity}:${header.data.report.id}:${header.data.report.version}:${header.data.report.logicalContentDigest}`}
        value={header.data}
        identity={identity}
      />
    </Stack>
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
  const [actionOpen, setActionOpen] = useState(false);
  const [actionRequest, setActionRequest] = useState<ActionPanelRequest>();
  const requestSequence = useRef(0);
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
    description: "Unsaved feedback changes will be lost.",
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
  const canOpenActions = Boolean(
    context.data && workItem.data && selectionReady && !context.isError && !workItem.isError,
  );
  const openActions = (request?: Omit<ActionPanelRequest, "id">) => {
    setActionRequest(
      request ? { ...request, id: `${reportId}:${++requestSequence.current}` } : undefined,
    );
    setActionOpen(true);
  };
  const setSection = (next: ReportTab) => {
    const search = new URLSearchParams(params);
    search.set("section", next);
    search.delete("tab");
    setParams(search);
  };
  const recommendation = context.data?.recommendation;
  const suggested = context.data?.nextActions.find(
    (entry) =>
      entry.id === context.data?.recommendedActionId && entry.action === recommendation?.action,
  );
  const fixed = context.data?.fixedActions.find((entry) => entry.action === recommendation?.action);
  const recommendedReady = suggested ? suggested.canPrepare : (fixed?.allowed ?? false);
  const recommendedLabel = recommendation?.action
    ? recommendation.action === "start-task"
      ? sourceActionLabel(recommendation.action, suggested?.taskKind)
      : actionLabels[recommendation.action]
    : actionLabels["view-evidence"];
  const recommendationNeedsDetails = Boolean(suggested?.planRef || suggested?.draftRef);
  const recommendationDisabled =
    !canOpenActions || !recommendedReady || (recommendationNeedsDetails && !result);
  const navigationRecommendation = ["view-evidence", "view-validation", "view-changes"].includes(
    recommendation?.action ?? "",
  );
  const recommendationTarget = `/reports?${new URLSearchParams({
    reportId: suggested?.validationReportRef?.id ?? reportId,
    repositoryId: value.context.repository.id,
    section: "evidence",
  })}`;
  const backParams = new URLSearchParams(params);
  backParams.delete("reportId");
  backParams.delete("section");
  backParams.delete("tab");
  for (const name of findingViewParameters) backParams.delete(name);
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
    <Stack spacing={2} className="report-workspace">
      <ReviewQueueBar
        record={{
          kind: "report",
          id: reportId,
          workItemId: value.context.workItem.id,
          repositoryId: value.context.repository.id,
          href: `/reports?reportId=${encodeURIComponent(reportId)}&repositoryId=${encodeURIComponent(value.context.repository.id)}`,
          label: value.context.workItem.title,
        }}
        fallbackTo={`/reports${backParams.size ? `?${backParams}` : ""}`}
        fallbackLabel="Reports"
      />
      <PageHeading
        eyebrow={`${reportKindLabel(value.context.task.kind)} · ${value.context.repository.fullName} · ${value.context.workItem.kind === "pull_request" ? "Pull request" : "Issue"} #${value.context.workItem.number}`}
        title={value.context.workItem.title}
        subtitle={`Report v${value.report.version} · ${value.report.completeness === "partial" ? "Partial" : "Complete"}`}
        action={
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <GithubSourceLink
              repositoryFullName={value.context.repository.fullName}
              kind={value.context.workItem.kind}
              number={value.context.workItem.number}
            />
          </Stack>
        }
      />
      <OutcomeSummary
        header={value}
        nextActions={
          context.data
            ? undefined
            : result?.nextActions.filter((entry) => entry.recommended).slice(0, 1)
        }
        actions={
          <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
            {recommendation ? (
              <>
                {recommendation.action &&
                  (navigationRecommendation ? (
                    <Button
                      component={Link}
                      to={recommendationTarget}
                      variant="contained"
                      disabled={recommendationDisabled}
                    >
                      {recommendedLabel}
                    </Button>
                  ) : (
                    <Button
                      variant="contained"
                      disabled={recommendationDisabled}
                      onClick={() => {
                        if (recommendation.action)
                          openActions(
                            recommendedReportRequest(
                              recommendation.action,
                              suggested?.id,
                              selection.selectedFindings.length +
                                selection.selectedDraftIds.length >
                                0,
                            ),
                          );
                      }}
                    >
                      {recommendedLabel}
                    </Button>
                  ))}
                {(suggested?.guards ?? fixed?.guards ?? [])
                  .filter((guard) => !guard.satisfied)
                  .map((guard) => (
                    <Typography key={guard.code} variant="caption" color="text.secondary">
                      {guard.message}
                    </Typography>
                  ))}
                {recommendationNeedsDetails && !result && (
                  <Typography variant="caption" color="text.secondary">
                    Loading plan and feedback…
                  </Typography>
                )}
              </>
            ) : (
              <Typography color="text.secondary" role="status">
                {context.isPending
                  ? "Checking available actions…"
                  : "Actions unavailable. Refresh to try again."}
              </Typography>
            )}
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
              <Button onClick={() => setSection("evidence")}>View evidence</Button>
              <Button disabled={!canOpenActions} onClick={() => openActions()}>
                Other actions
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
          </Stack>
        }
      />
      {value.report.completeness === "partial" && (
        <Alert severity="warning">Partial report · {value.report.loop.stopReason}.</Alert>
      )}
      {context.data?.pendingSubmission && (
        <Alert
          severity="warning"
          action={<Button onClick={() => openActions()}>Inspect submission</Button>}
        >
          A submission needs review. Check it before submitting again.
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
      {workItem.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void workItem.refetch()}>Retry source</Button>}
        >
          {workItem.error.message}
        </Alert>
      )}
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
            label={`${value.report.collections.findings === 1 ? "Finding" : "Findings"} (${value.report.collections.findings})`}
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
          Export JSON
        </Button>
      </Box>
      <Box role="tabpanel" id={`report-panel-${tab}`} aria-labelledby={`report-tab-${tab}`}>
        {tab === "findings" && (
          <ReportFindingsReader
            header={value}
            result={result}
            context={context.data}
            loading={full.isPending}
            draft={draft}
            onDraft={updateDraft}
            dispatch={dispatch}
            canEdit={canEdit}
            canPublish={canEdit && canOpenActions}
            onPublish={() => openActions({ importReportSelection: true })}
          />
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
        <DialogTitle id="prepare-report-action-title">Actions</DialogTitle>
        <DialogContent dividers>
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
              request={actionRequest}
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
