import type {
  ActionContextV1,
  InvestigationActionKind,
  InvestigationResultV1,
} from "@agentic-review/contracts";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import type { FeedbackSelectionState } from "./feedback-selection";
import {
  importPublicationSelection,
  type PublicationComposerDraft,
  type PublicationEntry,
  publicationEntrySourceBody,
  publicationSelectionKey,
  publicationSuggestionStatus,
  setPublicationFinding,
  setPublicationIndependentDraft,
} from "./publication-composer";

export type PublicationStep = "select" | "edit";

export function publicationErrorTarget(errors: Readonly<Record<string, string>>): string {
  const fields = Object.keys(errors);
  return (
    fields.find((field) => field === "summary" || field.startsWith("draft-")) ??
    fields[0] ??
    "selection"
  );
}

export function PublicationSteps({ step }: { step: "select" | "preview" }) {
  return (
    <Stepper activeStep={step === "select" ? 0 : 1} aria-label="Publication steps">
      {["Select findings", "Preview"].map((label, index) => (
        <Step key={label} aria-current={index === (step === "select" ? 0 : 1) ? "step" : undefined}>
          <StepLabel>{label}</StepLabel>
        </Step>
      ))}
    </Stepper>
  );
}

export function expandPublicationEditorsForErrors(
  expanded: ReadonlyMap<string, boolean>,
  errors: Readonly<Record<string, string>>,
): ReadonlyMap<string, boolean> {
  let next = expanded;
  for (const [key, message] of Object.entries(errors)) {
    const match = key.match(/^draft-(.+)-(?:body|mode|replacement)$/u);
    if (!message || !match || next.get(match[1]!) === true) continue;
    next = new Map(next).set(match[1]!, true);
  }
  return next;
}

export function PublicationComposerPanel({
  action,
  context,
  result,
  draft,
  reportSelection,
  editedBodies,
  summary,
  summaryGenerated,
  step,
  disabled,
  errors,
  fieldId,
  onChange,
  onSummaryChange,
  onUseGeneratedSummary,
  onClearError,
  onStepChange,
}: {
  action: InvestigationActionKind;
  context: ActionContextV1;
  result?: InvestigationResultV1;
  draft: PublicationComposerDraft;
  reportSelection: FeedbackSelectionState<InvestigationActionKind>;
  editedBodies: Record<string, string>;
  summary: string;
  summaryGenerated: boolean;
  step: PublicationStep;
  disabled: boolean;
  errors: Record<string, string>;
  fieldId: (key: string) => string;
  onChange: (draft: PublicationComposerDraft) => void;
  onSummaryChange: (body: string) => void;
  onUseGeneratedSummary: () => void;
  onClearError: (key: string) => void;
  onStepChange: (step: PublicationStep) => void;
}) {
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<"all" | "selected">("all");
  const [focusIntent, setFocusIntent] = useState<{ id: string; alignTop: boolean } | null>(null);
  const stepTop = useRef<HTMLDivElement>(null);
  const findings = result?.findings ?? [];
  const selectionChanged =
    draft.reportSelectionKey !== publicationSelectionKey(reportSelection) &&
    (draft.reportSelectionKey !== null ||
      reportSelection.selectedFindings.length + reportSelection.selectedDraftIds.length > 0);
  const visible = findings.filter(
    (finding) =>
      (show !== "selected" || draft.selectedFindingIds.includes(finding.id)) &&
      `${finding.id} ${finding.title} ${finding.priority} ${finding.confirmation.status}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const hidden = draft.selectedFindingIds.filter(
    (id) => !visible.some((finding) => finding.id === id),
  ).length;
  const selectedIds = [
    ...new Set([
      ...draft.selectedFindingIds.flatMap(
        (id) => findings.find((finding) => finding.id === id)?.feedbackDraft.id ?? [],
      ),
      ...draft.selectedDraftIds,
    ]),
  ];
  const entries = selectedIds.flatMap((id) => (draft.entries[id] ? [draft.entries[id]!] : []));
  const [expandedEditors, setExpandedEditors] = useState<ReadonlyMap<string, boolean>>(() =>
    expandPublicationEditorsForErrors(
      new Map(selectedIds[0] ? [[selectedIds[0], true]] : []),
      errors,
    ),
  );
  useEffect(() => {
    setExpandedEditors((current) => expandPublicationEditorsForErrors(current, errors));
  }, [errors]);
  const findingDraftIds = new Set(
    draft.selectedFindingIds.flatMap(
      (id) => findings.find((finding) => finding.id === id)?.feedbackDraft.id ?? [],
    ),
  );
  const independentCount = new Set(draft.selectedDraftIds.filter((id) => !findingDraftIds.has(id)))
    .size;
  const suggestionCount = entries.filter((entry) => entry.mode === "suggestion").length;
  useEffect(() => {
    if (!focusIntent) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(focusIntent.id);
      for (let parent = target?.parentElement; parent; parent = parent.parentElement)
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      if (focusIntent.alignTop) stepTop.current?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
      if (!focusIntent.alignTop) target?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusIntent]);

  const changeEntry = (
    entry: PublicationEntry,
    update: Partial<PublicationEntry>,
    errorKey: string,
  ) => {
    onChange({ ...draft, entries: { ...draft.entries, [entry.draftId]: { ...entry, ...update } } });
    onClearError(errorKey);
  };
  const removeEntry = (entry: PublicationEntry) => {
    const index = entries.findIndex((candidate) => candidate.draftId === entry.draftId);
    const neighbour = entries[index + 1] ?? entries[index - 1];
    setFocusIntent({
      id: fieldId(neighbour ? `draft-${neighbour.draftId}-body` : "summary"),
      alignTop: false,
    });
    onChange({
      ...draft,
      selectedFindingIds: draft.selectedFindingIds.filter(
        (id) => findings.find((finding) => finding.id === id)?.feedbackDraft.id !== entry.draftId,
      ),
      selectedDraftIds: draft.selectedDraftIds.filter((id) => id !== entry.draftId),
    });
    onClearError("selection");
    for (const part of ["body", "mode", "replacement"])
      onClearError(`draft-${entry.draftId}-${part}`);
  };
  const importReport = () => {
    onChange(importPublicationSelection(draft, reportSelection, result, editedBodies, action));
    onClearError("selection");
  };
  const selectedFindingCount = draft.selectedFindingIds.length;
  const nextDisabled = action === "request-changes" && selectedFindingCount === 0;

  return (
    <Stack
      id={fieldId("publication-step")}
      ref={stepTop}
      spacing={2}
      sx={{ minWidth: 0, scrollMarginBlockStart: 16 }}
    >
      {step === "select" ? (
        <PublicationSteps step="select" />
      ) : (
        <Typography variant="h6">Edit feedback</Typography>
      )}
      {selectionChanged && (
        <Alert severity="info">
          {draft.reportSelectionKey === null
            ? "Use the selected report findings?"
            : "Report selection changed."}
          <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap", mt: 1 }}>
            <Button disabled={disabled || !result} onClick={importReport}>
              Use report selection ({reportSelection.selectedFindings.length})
            </Button>
            <Button
              disabled={disabled}
              onClick={() =>
                onChange({ ...draft, reportSelectionKey: publicationSelectionKey(reportSelection) })
              }
            >
              Keep current selection
            </Button>
          </Stack>
        </Alert>
      )}
      {step === "select" ? (
        <>
          {findings.length > 8 && (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
              <TextField
                id={fieldId("search")}
                label="Search findings"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                fullWidth
              />
              <TextField
                id={fieldId("show")}
                select
                label="Show"
                value={show}
                onChange={(event) => setShow(event.target.value as "all" | "selected")}
                sx={{ minWidth: 180 }}
              >
                <MenuItem value="all">All findings</MenuItem>
                <MenuItem value="selected">Selected findings</MenuItem>
              </TextField>
            </Stack>
          )}
          <Typography
            id={fieldId("selection")}
            tabIndex={-1}
            variant="body2"
            role="status"
            aria-describedby={errors.selection ? `${fieldId("selection")}-error` : undefined}
          >
            {selectedFindingCount} of {findings.length}{" "}
            {findings.length === 1 ? "finding" : "findings"} selected
            {independentCount > 0
              ? ` · ${independentCount} additional ${independentCount === 1 ? "comment" : "comments"}`
              : ""}
            {hidden > 0 ? ` · ${hidden} selected hidden by filters` : ""}
          </Typography>
          <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap" }}>
            <Button
              disabled={
                disabled ||
                visible.length === 0 ||
                visible.every((finding) => draft.selectedFindingIds.includes(finding.id))
              }
              onClick={() => {
                let next = draft;
                for (const finding of visible)
                  next = setPublicationFinding(
                    next,
                    finding.id,
                    true,
                    result,
                    editedBodies,
                    action,
                  );
                onChange(next);
                onClearError("selection");
              }}
            >
              {findings.length > 8 ? `Select visible (${visible.length})` : "Select all"}
            </Button>
            <Button
              disabled={disabled || selectedFindingCount + draft.selectedDraftIds.length === 0}
              onClick={() => {
                setFocusIntent({ id: fieldId("selection"), alignTop: false });
                onChange({ ...draft, selectedFindingIds: [], selectedDraftIds: [] });
                onClearError("selection");
              }}
            >
              Clear selection
            </Button>
          </Stack>
          {errors.selection && (
            <Typography id={`${fieldId("selection")}-error`} color="error" variant="body2">
              {errors.selection}
            </Typography>
          )}
          {!result && <Alert severity="info">Load the saved report to choose findings.</Alert>}
          {visible.map((finding, index) => {
            const saved = finding.feedbackDraft;
            const option = context.suggestionSelectionDefaults.find(
              (item) => item.findingId === finding.id && item.draftId === saved.id,
            );
            return (
              <Box
                component="section"
                key={finding.id}
                sx={{ borderBottom: 1, borderColor: "divider", py: 1.5, minWidth: 0 }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <FormControlLabel
                    sx={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}
                    control={
                      <Checkbox
                        id={fieldId(`include-${saved.id}`)}
                        disabled={disabled}
                        checked={draft.selectedFindingIds.includes(finding.id)}
                        onChange={(event) => {
                          if (!event.target.checked && show === "selected") {
                            const neighbour = visible[index + 1] ?? visible[index - 1];
                            setFocusIntent({
                              id: fieldId(
                                neighbour ? `include-${neighbour.feedbackDraft.id}` : "selection",
                              ),
                              alignTop: false,
                            });
                          }
                          onChange(
                            setPublicationFinding(
                              draft,
                              finding.id,
                              event.target.checked,
                              result,
                              editedBodies,
                              action,
                            ),
                          );
                          onClearError("selection");
                        }}
                      />
                    }
                    label={
                      <Typography
                        variant="body2"
                        sx={{ fontWeight: 500, overflowWrap: "anywhere" }}
                      >
                        {finding.ordinal + 1}. {finding.title}
                      </Typography>
                    }
                  />
                  <Chip
                    size="small"
                    label={finding.priority}
                    color={finding.priority === "P0" ? "error" : "default"}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {finding.confirmation.status === "confirmed" ? "Confirmed" : "Needs verification"}
                  {saved.suggestion ? " · " : ""}
                  {saved.suggestion
                    ? option?.valid
                      ? "Code suggestion available"
                      : "Suggestion needs review"
                    : ""}
                </Typography>
                <Box component="details" sx={{ mt: 1 }}>
                  <Typography component="summary" variant="body2" sx={{ cursor: "pointer" }}>
                    {context.target.kind === "issue" ? "Evidence" : "Evidence & fix"}
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {finding.impact.description}
                  </Typography>
                  {finding.fixRecommendation.summary && (
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      {finding.fixRecommendation.summary}
                    </Typography>
                  )}
                </Box>
              </Box>
            );
          })}
          {result && visible.length === 0 && (
            <Typography color="text.secondary">No matching findings.</Typography>
          )}
          {(result?.feedbackDrafts.length ?? 0) > 0 && (
            <Box component="details">
              <Typography component="summary" sx={{ cursor: "pointer" }}>
                Additional comments
              </Typography>
              {result?.feedbackDrafts.map((saved) => (
                <FormControlLabel
                  key={saved.id}
                  sx={{ display: "flex", alignItems: "flex-start", overflowWrap: "anywhere" }}
                  control={
                    <Checkbox
                      id={fieldId(`include-extra-${saved.id}`)}
                      checked={draft.selectedDraftIds.includes(saved.id)}
                      disabled={disabled}
                      onChange={(event) => {
                        onChange(
                          setPublicationIndependentDraft(
                            draft,
                            saved.id,
                            event.target.checked,
                            result,
                            editedBodies,
                            action,
                          ),
                        );
                        onClearError("selection");
                      }}
                    />
                  }
                  label={
                    <Typography variant="body2">
                      {saved.id} · {saved.body}
                    </Typography>
                  }
                />
              ))}
            </Box>
          )}
          {nextDisabled && (
            <Typography variant="body2" color="text.secondary">
              Select at least one finding to request changes.
            </Typography>
          )}
        </>
      ) : (
        <>
          <Stack
            direction="row"
            useFlexGap
            spacing={1}
            sx={{ alignItems: "center", flexWrap: "wrap" }}
          >
            <Button
              id={fieldId("step-back")}
              disabled={disabled}
              onClick={() => {
                setFocusIntent({ id: fieldId("selection"), alignTop: true });
                onStepChange("select");
              }}
            >
              Back to findings
            </Button>
            <Typography variant="body2">
              {selectedFindingCount} {selectedFindingCount === 1 ? "finding" : "findings"} selected
              {independentCount > 0
                ? ` · ${independentCount} additional ${independentCount === 1 ? "comment" : "comments"}`
                : ""}
              {suggestionCount > 0
                ? ` · ${suggestionCount} code ${suggestionCount === 1 ? "suggestion" : "suggestions"}`
                : ""}
            </Typography>
          </Stack>
          <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
            <Button disabled={disabled || summaryGenerated} onClick={onUseGeneratedSummary}>
              Use generated summary
            </Button>
          </Stack>
          <TextField
            id={fieldId("summary")}
            label={action === "comment" ? "Comment introduction" : "Review summary"}
            multiline
            minRows={3}
            fullWidth
            value={summary}
            disabled={disabled}
            onChange={(event) => {
              onSummaryChange(event.target.value);
              onClearError("summary");
            }}
            error={Boolean(errors.summary)}
            helperText={errors.summary}
          />
          {errors.selection && (
            <Alert severity="error">
              <Button
                id={fieldId("selection")}
                onClick={() => {
                  setFocusIntent({ id: fieldId("selection"), alignTop: false });
                  onStepChange("select");
                }}
              >
                Review selected findings
              </Button>{" "}
              {errors.selection}
            </Alert>
          )}
          {entries.map((entry, index) => {
            const finding = findings.find((item) => item.id === entry.findingId);
            const saved =
              finding?.feedbackDraft ??
              result?.feedbackDrafts.find((item) => item.id === entry.draftId);
            const label = finding ? `Finding ${finding.ordinal + 1}` : `Draft ${entry.draftId}`;
            const currentBody = publicationEntrySourceBody(entry, result, editedBodies);
            const changed = currentBody !== entry.sourceBody;
            const status = publicationSuggestionStatus(entry, result, context);
            const bodyKey = `draft-${entry.draftId}-body`,
              modeKey = `draft-${entry.draftId}-mode`,
              replacementKey = `draft-${entry.draftId}-replacement`;
            return (
              <Box
                component="details"
                key={entry.draftId}
                open={expandedEditors.get(entry.draftId) ?? index === 0}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setExpandedEditors((current) =>
                    current.get(entry.draftId) === open
                      ? current
                      : new Map(current).set(entry.draftId, open),
                  );
                }}
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1.5,
                  minWidth: 0,
                }}
              >
                <Box
                  component="summary"
                  sx={{
                    cursor: "pointer",
                    p: 1.5,
                    overflowWrap: "anywhere",
                    typography: "body2",
                    fontWeight: 500,
                  }}
                >
                  {finding ? `${finding.ordinal + 1}. ${finding.title}` : label}
                  <Stack direction="row" spacing={1} sx={{ mt: 0.5, ml: 2, alignItems: "center" }}>
                    {finding && (
                      <Chip
                        size="small"
                        label={finding.priority}
                        color={finding.priority === "P0" ? "error" : "default"}
                      />
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {changed
                        ? "Feedback changed"
                        : finding?.confirmation.status === "hypothesis"
                          ? "Needs verification"
                          : entry.mode === "suggestion"
                            ? "Code suggestion"
                            : "Comment"}
                    </Typography>
                  </Stack>
                </Box>
                <Stack spacing={1.5} sx={{ p: 1.5, pt: 0 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                    <Box sx={{ flex: 1 }} />
                    <Button
                      disabled={disabled}
                      aria-label={`Remove ${label.toLowerCase()} from this publication`}
                      onClick={() => removeEntry(entry)}
                    >
                      Remove
                    </Button>
                  </Stack>
                  {changed && (
                    <Alert severity="warning">
                      Report feedback changed.
                      <Stack
                        direction="row"
                        useFlexGap
                        spacing={1}
                        sx={{ flexWrap: "wrap", mt: 1 }}
                      >
                        <Button
                          disabled={disabled}
                          onClick={() => {
                            setFocusIntent({ id: fieldId(bodyKey), alignTop: false });
                            changeEntry(
                              entry,
                              { body: currentBody, sourceBody: currentBody },
                              bodyKey,
                            );
                          }}
                        >
                          Use latest feedback
                        </Button>
                        <Button
                          disabled={disabled}
                          onClick={() => {
                            setFocusIntent({ id: fieldId(bodyKey), alignTop: false });
                            changeEntry(entry, { sourceBody: currentBody }, bodyKey);
                          }}
                        >
                          Keep my text
                        </Button>
                      </Stack>
                    </Alert>
                  )}
                  <TextField
                    id={fieldId(bodyKey)}
                    label={`${label} · comment`}
                    multiline
                    minRows={3}
                    fullWidth
                    value={entry.body}
                    disabled={disabled}
                    onChange={(event) => changeEntry(entry, { body: event.target.value }, bodyKey)}
                    error={Boolean(errors[bodyKey])}
                    helperText={errors[bodyKey]}
                  />
                  <TextField
                    id={fieldId(modeKey)}
                    select
                    label={`${label} · include as`}
                    value={entry.mode}
                    disabled={disabled}
                    onChange={(event) => {
                      changeEntry(
                        entry,
                        { mode: event.target.value as PublicationEntry["mode"] },
                        modeKey,
                      );
                      onClearError(replacementKey);
                    }}
                    error={Boolean(errors[modeKey])}
                    helperText={errors[modeKey]}
                  >
                    <MenuItem value="summary">
                      {action === "comment" ? "Comment" : "Review summary"}
                    </MenuItem>
                    <MenuItem
                      value="suggestion"
                      disabled={action === "comment" || !finding || !saved?.suggestion}
                    >
                      Code suggestion{!saved?.suggestion ? " · unavailable" : ""}
                    </MenuItem>
                  </TextField>
                  {entry.mode === "suggestion" ? (
                    <>
                      {!status.valid && (
                        <Alert severity="error">
                          {status.reason} Choose summary text or remove this item.
                        </Alert>
                      )}
                      {saved?.suggestion && (
                        <Box component="details">
                          <Typography
                            component="summary"
                            variant="body2"
                            sx={{ cursor: "pointer" }}
                          >
                            Source details
                          </Typography>
                          <Typography variant="body2" sx={{ mt: 1, overflowWrap: "anywhere" }}>
                            {saved.suggestion.path} · lines {saved.suggestion.startLine}–
                            {saved.suggestion.endLine}
                          </Typography>
                          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                            Head: {saved.suggestion.headSha}
                          </Typography>
                          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                            Subject: {saved.suggestion.subjectRef}
                          </Typography>
                          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                            Original content digest: {saved.suggestion.originalContentDigest}
                          </Typography>
                        </Box>
                      )}
                      <TextField
                        id={fieldId(replacementKey)}
                        label={`${label} · replacement code`}
                        multiline
                        minRows={4}
                        fullWidth
                        value={entry.replacement}
                        disabled={disabled}
                        onChange={(event) =>
                          changeEntry(entry, { replacement: event.target.value }, replacementKey)
                        }
                        error={Boolean(errors[replacementKey])}
                        helperText={
                          errors[replacementKey] ||
                          (!entry.replacement
                            ? "Empty replacement deletes the selected code."
                            : undefined)
                        }
                        sx={{ "& textarea": { fontFamily: "monospace" } }}
                      />
                    </>
                  ) : null}
                </Stack>
              </Box>
            );
          })}
          {entries.length === 0 && (
            <Typography color="text.secondary">
              {action === "request-changes"
                ? "Choose at least one finding before requesting changes."
                : "No findings selected. This action contains only its summary."}
            </Typography>
          )}
        </>
      )}
    </Stack>
  );
}
