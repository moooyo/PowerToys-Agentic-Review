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
  const [discardOpen, setDiscardOpen] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  const [message, setMessage] = useState("");
  const detailRef = useRef<HTMLDivElement>(null);
  const directoryRef = useRef<HTMLDivElement>(null);
  const focusRequested = useRef(false);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectedDone = useRef<HTMLButtonElement>(null);
  const singleFinding = result?.findings.length === 1;
  const issue = header.context.workItem.kind === "issue";
  const filters = useMemo(() => {
    const current = readFindingFilters(params);
    return singleFinding
      ? { search: "", priority: "all" as const, assessment: "all" as const }
      : issue
        ? { ...current, priority: "all" as const }
        : current;
  }, [params, singleFinding, issue]);
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
  const findingId = finding?.id;
  const firstFinding = result?.findings[0];
  const dirty = isReportDraftDirty(draft);
  const currentEdited = finding
    ? (editedBodies[finding.feedbackDraft.id] ?? finding.feedbackDraft.body) !==
      (draft.saved.editedBodies[finding.feedbackDraft.id] ?? finding.feedbackDraft.body)
    : false;
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

  useEffect(() => {
    const directory = directoryRef.current;
    if (!directory || directory.dataset.findingPage !== String(view.page)) return;
    const selected = Array.from(directory.querySelectorAll<HTMLElement>("[data-finding-id]")).find(
      (entry) => entry.dataset.findingId === findingId,
    );
    if (!selected || !directory.clientHeight) return;
    const bounds = directory.getBoundingClientRect();
    const entry = selected.getBoundingClientRect();
    if (entry.top < bounds.top) directory.scrollTop += entry.top - bounds.top;
    else if (entry.bottom > bounds.bottom) directory.scrollTop += entry.bottom - bounds.bottom;
  }, [findingId, view.page]);

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
    if (currentEdited) onDraft({ type: "save-finding", draftId: finding.feedbackDraft.id });
    if (view.next) selectFinding(view.next.id);
    if (currentEdited) setMessage("Draft saved.");
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
      setMessage("Finding link copied.");
    } catch {
      setCopyFallback(link);
    }
  };

  if (!result)
    return loading ? (
      <Box role="status" sx={{ py: 4, textAlign: "center" }}>
        <CircularProgress size={24} aria-label="Loading all report findings" />
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Loading findings…
        </Typography>
      </Box>
    ) : null;

  return (
    <Stack spacing={2}>
      {result.findings.some((entry) => entry.priority === "P0") && (
        <Alert severity="warning" action={<Button onClick={locateP0}>Locate P0</Button>}>
          {result.findings.filter((entry) => entry.priority === "P0").length} P0 finding
          {result.findings.filter((entry) => entry.priority === "P0").length === 1 ? "" : "s"}.
          Review the evidence before approving.
        </Alert>
      )}
      {!singleFinding && result.findings.length > 0 && (
        <Box className="report-findings-tools-toggle">
          <Button
            startIcon={<FilterListRounded />}
            onClick={() => setToolsOpen((open) => !open)}
            aria-expanded={toolsOpen}
            aria-controls="report-findings-tools"
          >
            Filters
          </Button>
          <Typography variant="body2" color="text.secondary">
            {view.matching.length} finding{view.matching.length === 1 ? "" : "s"}
          </Typography>
        </Box>
      )}
      {!singleFinding && result.findings.length > 0 && (
        <Box id="report-findings-tools" className="report-findings-tools" data-open={toolsOpen}>
          <Box className="report-finding-filters">
            <TextField
              type="search"
              label="Search findings"
              placeholder="Title, file or text"
              value={filters.search}
              onChange={(event) => setFilter("findingSearch", event.target.value)}
              fullWidth
            />
            {!issue && (
              <TextField
                select
                label="Priority"
                value={filters.priority}
                onChange={(event) => setFilter("findingPriority", event.target.value)}
              >
                <MenuItem value="all">All priorities</MenuItem>
                {["P0", "P1", "P2", "P3"].map((priority) => (
                  <MenuItem value={priority} key={priority}>
                    {priority} ·{" "}
                    {result.findings.filter((entry) => entry.priority === priority).length}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              select
              label="Assessment"
              value={filters.assessment}
              onChange={(event) => setFilter("findingAssessment", event.target.value)}
            >
              <MenuItem value="all">All assessments</MenuItem>
              <MenuItem value="confirmed">Confirmed</MenuItem>
              <MenuItem value="hypothesis">Needs verification</MenuItem>
            </TextField>
            {(filters.search || filters.priority !== "all" || filters.assessment !== "all") && (
              <Button onClick={clearFilters}>Clear</Button>
            )}
          </Box>
        </Box>
      )}
      {totalSelected > 0 && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          className="report-selection-bar"
          sx={{ flexWrap: "wrap", alignItems: "center", bgcolor: "action.selected" }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {totalSelected} selected
          </Typography>
          <Button onClick={() => setSelectedOpen(true)}>Review selection</Button>
          <Button
            disabled={!canEdit || !totalSelected}
            onClick={() => {
              for (const entry of selection.selectedFindings)
                dispatch({ type: "set-finding", finding: entry, selected: false });
              for (const draftId of selection.selectedDraftIds)
                dispatch({ type: "set-draft", draftId, selected: false });
            }}
          >
            Clear
          </Button>
          <Button
            variant="contained"
            disabled={!canPublish}
            onClick={onPublish}
            sx={{ ml: "auto" }}
          >
            Publish selected
          </Button>
        </Stack>
      )}
      {dirty && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", alignItems: "center" }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ mr: "auto" }}>
            Unsaved feedback
          </Typography>
          <Button disabled={!canEdit} onClick={() => setDiscardOpen(true)}>
            Discard
          </Button>
          <Button
            disabled={!canEdit}
            onClick={() => {
              onDraft({ type: "save" });
              setMessage("Draft saved.");
            }}
          >
            Save draft{singleFinding ? "" : "s"}
          </Button>
        </Stack>
      )}
      {message && (
        <Typography role="status" aria-live="polite" variant="body2" color="text.secondary">
          {message}
        </Typography>
      )}
      {result.findings.length === 0 ? (
        <EmptyState
          title="No review findings"
          action={
            <Button
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("section", "evidence");
                setParams(next);
              }}
            >
              View evidence
            </Button>
          }
        />
      ) : (
        <>
          {!view.matching.length && (
            <EmptyState
              title="No matching findings"
              action={<Button onClick={clearFilters}>Clear finding filters</Button>}
            />
          )}
          {!singleFinding && view.matching.length > 0 && (
            <Box className="report-mobile-finding-picker">
              <TextField
                select
                fullWidth
                label="Finding"
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
                    {issue ? "" : `${entry.priority} · `}
                    {entry.ordinal + 1}. {entry.title}
                  </MenuItem>
                ))}
              </TextField>
              <Button
                onClick={() => setIndexOpen((open) => !open)}
                aria-expanded={indexOpen}
                aria-controls="report-finding-directory"
              >
                {indexOpen ? "Hide directory" : "Show directory"}
              </Button>
            </Box>
          )}
          <Box
            className={`report-findings-layout${singleFinding ? " report-findings-single" : ""}`}
          >
            {!singleFinding && (
              <Box
                component="nav"
                id="report-finding-directory"
                className="report-finding-nav"
                data-open={indexOpen}
                aria-label="Report findings"
                sx={{ borderColor: "divider" }}
              >
                <Stack
                  direction="row"
                  useFlexGap
                  sx={{ gap: 1, justifyContent: "space-between", alignItems: "center", p: 1 }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {view.matching.length
                      ? `${view.offset + 1}–${view.offset + view.visible.length}`
                      : "0"}{" "}
                    of {view.matching.length}
                  </Typography>
                  <Button
                    size="small"
                    disabled={!canEdit || !view.visible.length}
                    onClick={() => {
                      for (const entry of view.visible) setFindingSelected(entry, true);
                    }}
                  >
                    Select page
                  </Button>
                </Stack>
                <Box
                  className="report-finding-directory-items"
                  ref={directoryRef}
                  data-finding-page={view.page}
                >
                  {view.visible.map((entry) => (
                    <ButtonBase
                      key={entry.id}
                      data-finding-id={entry.id}
                      className="report-finding-nav-item"
                      aria-current={finding?.id === entry.id ? "true" : undefined}
                      aria-controls="selected-report-finding"
                      onClick={() => selectFinding(entry.id)}
                      sx={{
                        bgcolor: finding?.id === entry.id ? "action.selected" : "transparent",
                        "&:hover": { bgcolor: "action.hover" },
                        borderRadius: 0,
                      }}
                    >
                      <Stack
                        direction="row"
                        spacing={1}
                        useFlexGap
                        sx={{ width: "100%", flexWrap: "wrap", alignItems: "center" }}
                      >
                        {!issue && (
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
                        )}
                        <Typography variant="subtitle2">
                          {entry.ordinal + 1}. {entry.title}
                        </Typography>
                        {isFindingSelected(selection, entry.id) && (
                          <CheckRounded
                            fontSize="small"
                            aria-label="Included in feedback"
                            sx={{ ml: "auto" }}
                          />
                        )}
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {findingLocation(entry)} ·{" "}
                        {entry.confirmation.status === "confirmed"
                          ? "Confirmed"
                          : "Needs verification"}
                      </Typography>
                    </ButtonBase>
                  ))}
                </Box>
                {view.pageCount > 1 && (
                  <>
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
                  </>
                )}
              </Box>
            )}
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
                  This finding is hidden by the current filters.
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
                    issue={issue}
                    draftDirty={currentEdited}
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
                  {!singleFinding && (
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
                        Previous
                      </Button>
                      {canEdit ? (
                        <Button
                          variant={currentEdited ? "contained" : "outlined"}
                          disabled={!currentEdited && !view.next}
                          onClick={saveAndNext}
                        >
                          {currentEdited ? (view.next ? "Save & next" : "Save draft") : "Next"}
                        </Button>
                      ) : (
                        <Button
                          variant="contained"
                          endIcon={<ArrowForwardRounded />}
                          disabled={!view.next}
                          onClick={() => view.next && selectFinding(view.next.id)}
                        >
                          Next
                        </Button>
                      )}
                    </Stack>
                  )}
                </>
              ) : view.unavailable ? (
                <EmptyState
                  title="Finding unavailable"
                  description="This link does not identify a finding in this report."
                  action={
                    firstFinding ? (
                      <Button onClick={() => selectFinding(firstFinding.id)}>
                        Open first finding
                      </Button>
                    ) : undefined
                  }
                />
              ) : null}
            </Box>
          </Box>
        </>
      )}
      {result.feedbackDrafts.length > 0 && (
        <Box component="details" className="report-independent-drafts">
          <Typography component="summary">
            Additional feedback ({result.feedbackDrafts.length})
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
                  label="Include in feedback"
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
          Selected feedback ({totalSelected})
        </DialogTitle>
        <DialogContent dividers>
          {hiddenSelected > 0 && (
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              {hiddenSelected} selected finding{hiddenSelected === 1 ? " is" : "s are"} hidden by
              filters.
            </Typography>
          )}
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
          {!totalSelected && <EmptyState title="No selected feedback" />}
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
            Publish selected
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        aria-labelledby="discard-report-feedback-title"
      >
        <DialogTitle id="discard-report-feedback-title">Discard feedback changes?</DialogTitle>
        <DialogContent>Unsaved text and selection changes will be lost.</DialogContent>
        <DialogActions>
          <Button onClick={() => setDiscardOpen(false)}>Keep editing</Button>
          <Button
            color="error"
            onClick={() => {
              onDraft({ type: "discard" });
              setDiscardOpen(false);
              setMessage("Changes discarded.");
            }}
          >
            Discard
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
            Copy this link manually.
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
