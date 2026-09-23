import type {
  ActionContextV1,
  InvestigationActionKind,
  InvestigationFindingV1,
  InvestigationReportHeaderV1,
  InvestigationResultV1,
} from "@agentic-review/contracts";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import ArrowForwardRounded from "@mui/icons-material/ArrowForwardRounded";
import CheckRounded from "@mui/icons-material/CheckRounded";
import FilterListRounded from "@mui/icons-material/FilterListRounded";
import LinkRounded from "@mui/icons-material/LinkRounded";
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
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { type FeedbackSelectionEvent, isFindingSelected } from "./feedback-selection";
import {
  isReportDraftDirty,
  type PrivateReportDraft,
  type ReportDraftEvent,
} from "./report-draft-store";
import { findingPageSize, readFindingFilters, reportFindingView } from "./report-findings";
import { FindingCard } from "./report-sections";
import { EmptyState } from "./workspace-ui";

function findingLocation(finding: InvestigationFindingV1) {
  const location = finding.locations[0];
  if (!location) return finding.subjectRef;
  return location.kind === "source"
    ? `${location.path}:${location.startLine}`
    : location.description;
}

export function ReportFindingsReader({
  header,
  result,
  context,
  loading,
  draft,
  onDraft,
  dispatch,
  canEdit,
  canPublish,
  onPublish,
}: {
  header: InvestigationReportHeaderV1;
  result?: InvestigationResultV1;
  context?: ActionContextV1;
  loading: boolean;
  draft: PrivateReportDraft;
  onDraft: (event: ReportDraftEvent) => void;
  dispatch: (event: FeedbackSelectionEvent<InvestigationActionKind>) => void;
  canEdit: boolean;
  canPublish: boolean;
  onPublish: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const [selectedOpen, setSelectedOpen] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  const [message, setMessage] = useState("");
  const detailRef = useRef<HTMLDivElement>(null);
  const focusRequested = useRef(false);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectedDone = useRef<HTMLButtonElement>(null);
  const filters = useMemo(() => readFindingFilters(params), [params]);
  const selection = draft.current.selection;
  const editedBodies = draft.current.editedBodies;
  const view = useMemo(
    () =>
      reportFindingView(
        result?.findings ?? [],
        filters,
        params.get("findingId"),
        params.get("findingPage"),
      ),
    [result, filters, params],
  );
  const finding = view.finding;
  const totalSelected = selection.selectedFindings.length + selection.selectedDraftIds.length;
  const hiddenSelected = selection.selectedFindings.filter(
    (selected) => !view.matching.some((entry) => entry.id === selected.findingId),
  ).length;

  useEffect(() => {
    if (!focusRequested.current || !finding) return;
    focusRequested.current = false;
    detailRef.current?.scrollIntoView({ block: "start" });
    detailRef.current?.focus({ preventScroll: true });
  }, [finding]);

  const selectFinding = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("findingId", id);
    next.set("section", "findings");
    next.delete("tab");
    const index = view.matching.findIndex((entry) => entry.id === id);
    if (index >= findingPageSize)
      next.set("findingPage", String(Math.floor(index / findingPageSize) + 1));
    else next.delete("findingPage");
    focusRequested.current = true;
    setIndexOpen(false);
    setParams(next);
  };
  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(name, value);
    else next.delete(name);
    next.delete("findingId");
    next.delete("findingPage");
    setParams(next, { replace: true });
  };
  const clearFilters = () => {
    const next = new URLSearchParams(params);
    for (const name of ["findingSearch", "findingPriority", "findingAssessment", "findingPage"])
      next.delete(name);
    setParams(next, { replace: true });
  };
  const locateP0 = () => {
    const first = result?.findings.find((entry) => entry.priority === "P0");
    if (!first) return;
    const next = new URLSearchParams(params);
    next.set("findingPriority", "P0");
    next.set("findingId", first.id);
    next.set("section", "findings");
    for (const name of ["findingSearch", "findingAssessment", "findingPage", "tab"])
      next.delete(name);
    focusRequested.current = true;
    setParams(next);
  };
  const changePage = (page: number) => {
    const next = new URLSearchParams(params);
    next.delete("findingId");
    if (page > 1) next.set("findingPage", String(page));
    else next.delete("findingPage");
    focusRequested.current = true;
    setParams(next);
  };
  const setFindingSelected = (entry: InvestigationFindingV1, selected: boolean) => {
    dispatch({
      type: "set-finding",
      finding: {
        findingId: entry.id,
        draftId: entry.feedbackDraft.id,
        suggestionId: entry.feedbackDraft.suggestion ? entry.feedbackDraft.id : null,
      },
      selected,
    });
  };
  const saveAndNext = () => {
    if (!finding || !canEdit) return;
    onDraft({ type: "save-finding", draftId: finding.feedbackDraft.id });
    if (view.next) selectFinding(view.next.id);
    setMessage(
      view.next
        ? "Current feedback saved. Showing the next matching finding."
        : "Current feedback saved. This is the last matching finding.",
    );
  };
  const removeSelected = (key: string, remove: () => void) => {
    const keys = [
      ...selection.selectedFindings.map((entry) => `finding:${entry.findingId}`),
      ...selection.selectedDraftIds.map((id) => `draft:${id}`),
    ];
    const index = keys.indexOf(key);
    const neighbor = keys[index + 1] ?? keys[index - 1];
    remove();
    requestAnimationFrame(() => {
      const target = neighbor ? removeButtons.current.get(neighbor) : selectedDone.current;
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    });
  };
  const copyFinding = async () => {
    if (!finding) return;
    const publicParams = new URLSearchParams({
      reportId: header.report.id,
      repositoryId: header.context.repository.id,
      section: "findings",
      findingId: finding.id,
    });
    const link = new URL(`/reports?${publicParams}`, window.location.href).toString();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link);
      setMessage("Finding link copied. Private selections and feedback are not included.");
    } catch {
      setCopyFallback(link);
    }
  };

  if (!result)
    return loading ? (
      <Box role="status" sx={{ py: 4, textAlign: "center" }}>
        <CircularProgress size={24} aria-label="Loading all report findings" />
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Loading the complete saved collection for search and selection…
        </Typography>
      </Box>
    ) : null;

  return (
    <Stack spacing={2}>
      {result.findings.some((entry) => entry.priority === "P0") && (
        <Alert severity="warning" action={<Button onClick={locateP0}>Locate P0</Button>}>
          This saved report includes{" "}
          {result.findings.filter((entry) => entry.priority === "P0").length} P0 findings. Review
          their evidence and confirmation status.
        </Alert>
      )}
      <Box className="report-findings-tools-toggle">
        <Button
          startIcon={<FilterListRounded />}
          onClick={() => setToolsOpen((open) => !open)}
          aria-expanded={toolsOpen}
          aria-controls="report-findings-tools"
        >
          Filters and feedback
        </Button>
        <Typography variant="body2" color="text.secondary">
          {result.findings.length} total · {view.matching.length} matching · {totalSelected}{" "}
          selected
        </Typography>
      </Box>
      <Box id="report-findings-tools" className="report-findings-tools" data-open={toolsOpen}>
        <Box className="report-finding-filters">
          <TextField
            type="search"
            label="Search all findings"
            placeholder="Title, file path or saved finding text"
            value={filters.search}
            onChange={(event) => setFilter("findingSearch", event.target.value)}
            fullWidth
          />
          <TextField
            select
            label="Priority"
            value={filters.priority}
            onChange={(event) => setFilter("findingPriority", event.target.value)}
          >
            <MenuItem value="all">All priorities</MenuItem>
            {["P0", "P1", "P2", "P3"].map((priority) => (
              <MenuItem value={priority} key={priority}>
                {priority} · {result.findings.filter((entry) => entry.priority === priority).length}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Finding assessment"
            value={filters.assessment}
            onChange={(event) => setFilter("findingAssessment", event.target.value)}
          >
            <MenuItem value="all">All assessments</MenuItem>
            <MenuItem value="confirmed">Confirmed</MenuItem>
            <MenuItem value="hypothesis">Hypothesis · needs verification</MenuItem>
          </TextField>
          {(filters.search || filters.priority !== "all" || filters.assessment !== "all") && (
            <Button onClick={clearFilters}>Clear finding filters</Button>
          )}
        </Box>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", alignItems: "center", mt: 2 }}
        >
          <Button variant="outlined" onClick={() => setSelectedOpen(true)}>
            Review selected ({totalSelected})
          </Button>
          <Button
            disabled={!canEdit || !view.visible.length}
            onClick={() => {
              for (const entry of view.visible) setFindingSelected(entry, true);
            }}
          >
            Select current page
          </Button>
          <Button
            disabled={!canEdit || !totalSelected}
            onClick={() => {
              for (const entry of selection.selectedFindings)
                dispatch({ type: "set-finding", finding: entry, selected: false });
              for (const draftId of selection.selectedDraftIds)
                dispatch({ type: "set-draft", draftId, selected: false });
            }}
          >
            Clear selection
          </Button>
          <Button
            disabled={!canEdit || !isReportDraftDirty(draft)}
            onClick={() => {
              onDraft({ type: "save" });
              setMessage(
                "All private report feedback saved for this session. Nothing was published.",
              );
            }}
          >
            Save all report drafts
          </Button>
          <Button
            disabled={!canEdit || !isReportDraftDirty(draft)}
            onClick={() => onDraft({ type: "discard" })}
          >
            Discard report edits
          </Button>
          <Button variant="contained" disabled={!canPublish || !totalSelected} onClick={onPublish}>
            Publish selected findings
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          {isReportDraftDirty(draft)
            ? "Unsaved private feedback"
            : "Private feedback saved for this session"}{" "}
          · {hiddenSelected} selected findings hidden by filters
        </Typography>
      </Box>
      <Typography role="status" aria-live="polite" variant="body2" color="text.secondary">
        {message}
      </Typography>
      {result.findings.length === 0 ? (
        <EmptyState
          title="No review findings"
          description="Review the saved coverage and supporting evidence before choosing the next action."
          action={
            <Button
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("section", "evidence");
                setParams(next);
              }}
            >
              Review evidence
            </Button>
          }
        />
      ) : (
        <>
          {!view.matching.length && (
            <EmptyState
              title="No matching findings"
              description="Search covers the complete saved collection. Your selections and private drafts are kept."
              action={<Button onClick={clearFilters}>Clear finding filters</Button>}
            />
          )}
          {view.matching.length > 0 && (
            <Box className="report-mobile-finding-picker">
              <TextField
                select
                fullWidth
                label={`Current finding · ${view.matching.length} matches`}
                value={view.outsideFilters || view.unavailable ? "" : (finding?.id ?? "")}
                onChange={(event) => selectFinding(event.target.value)}
              >
                {(view.outsideFilters || view.unavailable) && (
                  <MenuItem value="" disabled>
                    Choose a finding in these results
                  </MenuItem>
                )}
                {view.matching.map((entry) => (
                  <MenuItem key={entry.id} value={entry.id}>
                    {entry.priority} · {entry.ordinal + 1}. {entry.title}
                  </MenuItem>
                ))}
              </TextField>
              <Button
                onClick={() => setIndexOpen((open) => !open)}
                aria-expanded={indexOpen}
                aria-controls="report-finding-directory"
              >
                {indexOpen ? "Hide findings directory" : "Show findings directory"}
              </Button>
            </Box>
          )}
          <Box className="report-findings-layout">
            <Box
              component="nav"
              id="report-finding-directory"
              className="report-finding-nav"
              data-open={indexOpen}
              aria-label="Report findings"
              sx={{ borderColor: "divider" }}
            >
              <Typography variant="caption" color="text.secondary">
                {view.matching.length
                  ? `${view.offset + 1}–${view.offset + view.visible.length}`
                  : "0"}{" "}
                of {view.matching.length} matching · {result.findings.length} total
              </Typography>
              {view.visible.map((entry) => (
                <ButtonBase
                  key={entry.id}
                  className="report-finding-nav-item"
                  aria-current={finding?.id === entry.id ? "true" : undefined}
                  aria-controls="selected-report-finding"
                  onClick={() => selectFinding(entry.id)}
                  sx={{
                    bgcolor: finding?.id === entry.id ? "action.selected" : "transparent",
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
                      label={entry.priority}
                      color={
                        entry.priority === "P0"
                          ? "error"
                          : entry.priority === "P1"
                            ? "warning"
                            : "default"
                      }
                    />
                    <Typography variant="caption">{entry.confirmation.status}</Typography>
                    {isFindingSelected(selection, entry.id) && (
                      <CheckRounded
                        fontSize="small"
                        aria-label="Included in feedback"
                        sx={{ ml: "auto" }}
                      />
                    )}
                  </Stack>
                  <Typography variant="subtitle2">
                    {entry.ordinal + 1}. {entry.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {findingLocation(entry)}
                  </Typography>
                </ButtonBase>
              ))}
              <Stack direction="row" sx={{ justifyContent: "space-between" }}>
                <Button disabled={view.page === 1} onClick={() => changePage(view.page - 1)}>
                  Previous page
                </Button>
                <Button
                  disabled={view.page === view.pageCount}
                  onClick={() => changePage(view.page + 1)}
                >
                  Next page
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Page {view.page} of {view.pageCount} · {findingPageSize} per page
              </Typography>
            </Box>
            <Box
              id="selected-report-finding"
              ref={detailRef}
              tabIndex={-1}
              role="region"
              className="report-finding-detail"
              aria-label={
                finding ? `Finding ${finding.ordinal + 1}: ${finding.title}` : "Finding detail"
              }
              sx={{ borderColor: "divider" }}
            >
              {view.outsideFilters && (
                <Alert
                  severity="info"
                  action={<Button onClick={clearFilters}>Clear filters</Button>}
                  sx={{ mb: 2 }}
                >
                  This linked finding belongs to the complete report but is outside the current
                  filters.
                </Alert>
              )}
              {finding ? (
                <>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ justifyContent: "space-between", mb: 1 }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      Finding {finding.ordinal + 1} of {result.findings.length}
                    </Typography>
                    <Button
                      startIcon={<LinkRounded />}
                      onClick={() => void copyFinding()}
                      aria-label={`Copy link to finding ${finding.ordinal + 1}`}
                    >
                      Copy link
                    </Button>
                  </Stack>
                  <FindingCard
                    key={`${finding.id}:${finding.version}`}
                    detail
                    finding={finding}
                    evidence={result.verificationEvidence}
                    selected={isFindingSelected(selection, finding.id)}
                    selectionEnabled={canEdit}
                    draftBody={editedBodies[finding.feedbackDraft.id] ?? finding.feedbackDraft.body}
                    suggestionValid={
                      context?.suggestionSelectionDefaults.some(
                        (option) =>
                          option.findingId === finding.id &&
                          option.draftId === finding.feedbackDraft.id &&
                          option.valid,
                      ) ?? false
                    }
                    onSelect={(checked) => setFindingSelected(finding, checked)}
                    onDraftChange={(body) =>
                      onDraft({ type: "edit", draftId: finding.feedbackDraft.id, body })
                    }
                  />
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ flexWrap: "wrap", justifyContent: "space-between", mt: 2 }}
                  >
                    <Button
                      startIcon={<ArrowBackRounded />}
                      disabled={!view.previous}
                      onClick={() => view.previous && selectFinding(view.previous.id)}
                    >
                      Previous finding
                    </Button>
                    {canEdit ? (
                      <Button variant="contained" onClick={saveAndNext}>
                        {view.next ? "Save draft & next" : "Save current draft"}
                      </Button>
                    ) : (
                      <Button
                        variant="contained"
                        endIcon={<ArrowForwardRounded />}
                        disabled={!view.next}
                        onClick={() => view.next && selectFinding(view.next.id)}
                      >
                        Next finding
                      </Button>
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {canEdit
                      ? "Saves only this finding’s text. Selection and other edits stay unchanged."
                      : "Navigate within the current filtered collection."}
                  </Typography>
                </>
              ) : view.unavailable ? (
                <EmptyState
                  title="Finding unavailable"
                  description="This link does not identify a finding in the complete saved report. Choose a finding from the directory."
                />
              ) : null}
            </Box>
          </Box>
        </>
      )}
      {result.feedbackDrafts.length > 0 && (
        <Box component="details" className="report-independent-drafts">
          <Typography component="summary">
            Independent feedback drafts ({result.feedbackDrafts.length})
          </Typography>
          <Stack spacing={2} sx={{ mt: 2 }}>
            {result.feedbackDrafts.map((entry) => (
              <Box key={entry.id}>
                <FormControlLabel
                  control={
                    <Checkbox
                      disabled={!canEdit}
                      checked={selection.selectedDraftIds.includes(entry.id)}
                      onChange={(event) =>
                        dispatch({
                          type: "set-draft",
                          draftId: entry.id,
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
                  value={editedBodies[entry.id] ?? entry.body}
                  onChange={(event) =>
                    onDraft({ type: "edit", draftId: entry.id, body: event.target.value })
                  }
                />
              </Box>
            ))}
          </Stack>
        </Box>
      )}
      <Dialog
        className="report-workspace"
        open={selectedOpen}
        onClose={() => setSelectedOpen(false)}
        fullWidth
        maxWidth="md"
        aria-labelledby="selected-report-feedback-title"
      >
        <DialogTitle id="selected-report-feedback-title">
          Review selected feedback ({totalSelected})
        </DialogTitle>
        <DialogContent dividers>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            {hiddenSelected} selected findings are hidden by the current filters. Removing a
            selection keeps its private text.
          </Typography>
          <Stack spacing={2}>
            {selection.selectedFindings.map((entry) => {
              const record = result.findings.find((candidate) => candidate.id === entry.findingId);
              const key = `finding:${entry.findingId}`;
              return (
                <Box key={key} className="report-selected-review-row">
                  <Box sx={{ minWidth: 0 }}>
                    <Typography component="h3" variant="subtitle1">
                      {record
                        ? `${record.priority} · ${record.ordinal + 1}. ${record.title}`
                        : `Unavailable finding · ${entry.findingId}`}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {record
                        ? findingLocation(record)
                        : "Remove this unavailable selection before preparing."}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    {record && (
                      <Button
                        onClick={() => {
                          setSelectedOpen(false);
                          selectFinding(record.id);
                        }}
                      >
                        Read finding
                      </Button>
                    )}
                    <Button
                      ref={(node) => {
                        if (node) removeButtons.current.set(key, node);
                        else removeButtons.current.delete(key);
                      }}
                      disabled={!canEdit}
                      aria-label={`Remove finding ${record?.ordinal !== undefined ? record.ordinal + 1 : entry.findingId} from selected feedback`}
                      onClick={() =>
                        removeSelected(key, () =>
                          dispatch({ type: "set-finding", finding: entry, selected: false }),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </Stack>
                </Box>
              );
            })}
            {selection.selectedDraftIds.map((id) => (
              <Box key={id} className="report-selected-review-row">
                <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {editedBodies[id] ??
                    result.feedbackDrafts.find((entry) => entry.id === id)?.body ??
                    `Unavailable draft · ${id}`}
                </Typography>
                <Button
                  ref={(node) => {
                    if (node) removeButtons.current.set(`draft:${id}`, node);
                    else removeButtons.current.delete(`draft:${id}`);
                  }}
                  disabled={!canEdit}
                  aria-label={`Remove independent draft ${id}`}
                  onClick={() =>
                    removeSelected(`draft:${id}`, () =>
                      dispatch({ type: "set-draft", draftId: id, selected: false }),
                    )
                  }
                >
                  Remove
                </Button>
              </Box>
            ))}
          </Stack>
          {!totalSelected && (
            <EmptyState
              title="No selected feedback"
              description="Choose findings or independent drafts before publishing."
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button ref={selectedDone} onClick={() => setSelectedOpen(false)}>
            Done
          </Button>
          <Button
            variant="contained"
            disabled={!canPublish || !totalSelected}
            onClick={() => {
              setSelectedOpen(false);
              onPublish();
            }}
          >
            Publish selected findings
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={Boolean(copyFallback)}
        onClose={() => setCopyFallback("")}
        fullWidth
        maxWidth="sm"
        aria-labelledby="copy-finding-link-title"
      >
        <DialogTitle id="copy-finding-link-title">Copy finding link</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            Clipboard access is unavailable. This link does not contain private selections or
            feedback.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Finding link"
            value={copyFallback}
            slotProps={{ input: { readOnly: true } }}
            onFocus={(event) => {
              if (
                event.target instanceof HTMLInputElement ||
                event.target instanceof HTMLTextAreaElement
              )
                event.target.select();
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCopyFallback("")}>Done</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
