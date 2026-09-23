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

export type PublicationStep = "select" | "compose";

export function PublicationComposerPanel({
  action,
  context,
  result,
  draft,
  reportSelection,
  editedBodies,
  summary,
  step,
  disabled,
  errors,
  fieldId,
  onChange,
  onSummaryChange,
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
  step: PublicationStep;
  disabled: boolean;
  errors: Record<string, string>;
  fieldId: (key: string) => string;
  onChange: (draft: PublicationComposerDraft) => void;
  onSummaryChange: (body: string) => void;
  onClearError: (key: string) => void;
  onStepChange: (step: PublicationStep) => void;
}) {
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<"all" | "selected">("all");
  const [focusIntent, setFocusIntent] = useState<{ id: string; alignTop: boolean } | null>(null);
  const stepTop = useRef<HTMLDivElement>(null);
  const findings = result?.findings ?? [];
  const selectionChanged = draft.reportSelectionKey !== publicationSelectionKey(reportSelection);
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
      <Stack
        direction="row"
        useFlexGap
        spacing={1}
        sx={{ flexWrap: "wrap" }}
        aria-label="Publication steps"
      >
        <Chip label="1 · Select findings" color={step === "select" ? "primary" : "default"} />
        <Chip label="2 · Compose" color={step === "compose" ? "primary" : "default"} />
        <Chip label="3 · Server preview" />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        This action keeps its own selection and publishing text. Report checkboxes and private
        report feedback stay unchanged.
      </Typography>
      {selectionChanged && (
        <Alert severity="info">
          {draft.reportSelectionKey === null
            ? "Report selection has not been imported into this action."
            : "Report selection changed. This action still uses its own saved selection."}
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
              Keep this action selection
            </Button>
          </Stack>
        </Alert>
      )}
      {action === "approve" && (
        <Alert severity="info">
          Findings and summary are optional. Approval does not clear saved findings or establish
          that runtime validation passed.
        </Alert>
      )}
      {action === "comment" && (
        <Alert severity="info">
          Conversation comments contain text only. Choose a review action to publish inline code
          suggestions.
        </Alert>
      )}
      {step === "select" ? (
        <>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField
              id={fieldId("search")}
              label="Search all findings"
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
          <Typography variant="body2" role="status">
            {selectedFindingCount} of {findings.length}{" "}
            {findings.length === 1 ? "finding" : "findings"} selected · {independentCount}{" "}
            independent {independentCount === 1 ? "draft" : "drafts"}
            {hidden > 0 ? ` · ${hidden} selected hidden by filters` : ""}
          </Typography>
          <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap" }}>
            <Button
              disabled={disabled || visible.length === 0}
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
              Select visible ({visible.length})
            </Button>
            <Button
              disabled={disabled || selectedFindingCount + draft.selectedDraftIds.length === 0}
              onClick={() => {
                setFocusIntent({ id: fieldId("show"), alignTop: false });
                onChange({ ...draft, selectedFindingIds: [], selectedDraftIds: [] });
                onClearError("selection");
              }}
            >
              Clear this action selection
            </Button>
          </Stack>
          <Button
            id={fieldId("selection")}
            disabled={disabled || !result}
            onClick={importReport}
            aria-describedby={errors.selection ? `${fieldId("selection")}-error` : undefined}
          >
            Import report selection
          </Button>
          {errors.selection && (
            <Typography id={`${fieldId("selection")}-error`} color="error" variant="body2">
              {errors.selection}
            </Typography>
          )}
          {!result && (
            <Alert severity="info">
              Load the complete saved report to choose findings. A manual conversation comment or an
              empty approval can still be prepared when the server permits it.
            </Alert>
          )}
          {visible.map((finding, index) => {
            const saved = finding.feedbackDraft;
            const option = context.suggestionSelectionDefaults.find(
              (item) => item.findingId === finding.id && item.draftId === saved.id,
            );
            return (
              <Box
                component="section"
                key={finding.id}
                sx={{ border: 1, borderColor: "divider", borderRadius: 3, p: 2, minWidth: 0 }}
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
                                neighbour ? `include-${neighbour.feedbackDraft.id}` : "show",
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
                      <Typography sx={{ overflowWrap: "anywhere" }}>
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
                  {finding.confirmation.status === "confirmed" ? "Confirmed" : "Needs verification"}{" "}
                  ·{" "}
                  {saved.suggestion
                    ? option?.valid
                      ? "Saved suggestion available"
                      : "Saved suggestion needs anchor review"
                    : "No saved code replacement"}
                </Typography>
                <Box component="details" sx={{ mt: 1 }}>
                  <Typography component="summary" variant="body2" sx={{ cursor: "pointer" }}>
                    Finding context and fix recommendation
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {finding.impact.description}
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {finding.fixRecommendation.summary}
                  </Typography>
                </Box>
              </Box>
            );
          })}
          {result && visible.length === 0 && (
            <Typography color="text.secondary">
              No matching findings. Existing selections are retained.
            </Typography>
          )}
          {(result?.feedbackDrafts.length ?? 0) > 0 && (
            <Box component="details">
              <Typography component="summary" sx={{ cursor: "pointer" }}>
                Independent saved feedback
              </Typography>
              <Typography variant="body2" color="text.secondary">
                These drafts publish text only; their saved suggestions are not sent from this
                section.
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
          <Button
            variant="contained"
            disabled={disabled || nextDisabled}
            onClick={() => {
              setFocusIntent({ id: fieldId("step-back"), alignTop: true });
              onStepChange("compose");
            }}
          >
            Continue to compose
          </Button>
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
                setFocusIntent({ id: fieldId("show"), alignTop: true });
                onStepChange("select");
              }}
            >
              Back to findings
            </Button>
            <Typography variant="body2">
              {selectedFindingCount} {selectedFindingCount === 1 ? "finding" : "findings"} ·{" "}
              {independentCount} independent {independentCount === 1 ? "draft" : "drafts"} ·{" "}
              {suggestionCount} suggested {suggestionCount === 1 ? "change" : "changes"}
            </Typography>
          </Stack>
          <TextField
            id={fieldId("summary")}
            label={action === "comment" ? "Conversation introduction" : "Review summary"}
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
            helperText={
              errors.summary ||
              "Selected publishing text is included once; it is not automatically pasted into this summary."
            }
          />
          {errors.selection && (
            <Alert severity="error">
              <Button
                id={fieldId("selection")}
                onClick={() => {
                  setFocusIntent({ id: fieldId("show"), alignTop: false });
                  onStepChange("select");
                }}
              >
                Review selected findings
              </Button>{" "}
              {errors.selection}
            </Alert>
          )}
          {entries.map((entry) => {
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
                component="section"
                key={entry.draftId}
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 3,
                  p: { xs: 1.5, sm: 2 },
                  minWidth: 0,
                }}
              >
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                    <Typography
                      variant="subtitle1"
                      component="h3"
                      sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
                    >
                      {finding ? `${finding.ordinal + 1}. ${finding.title}` : label}
                    </Typography>
                    <Button
                      disabled={disabled}
                      aria-label={`Remove ${label.toLowerCase()} from this publication`}
                      onClick={() => removeEntry(entry)}
                    >
                      Remove
                    </Button>
                  </Stack>
                  {finding?.confirmation.status === "hypothesis" && (
                    <Alert severity="warning">
                      Needs verification. Publishing this opinion does not confirm it or establish a
                      passed runtime check.
                    </Alert>
                  )}
                  {changed && (
                    <Alert severity="warning">
                      Report feedback changed after this publishing draft was reviewed.
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
                          Keep publishing text
                        </Button>
                      </Stack>
                    </Alert>
                  )}
                  <TextField
                    id={fieldId(bodyKey)}
                    label={`${label} · publishing text`}
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
                    label={`${label} · delivery`}
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
                    helperText={
                      errors[modeKey] ||
                      (action === "comment"
                        ? "Conversation comments contain summary text only."
                        : entry.findingId === null
                          ? "Independent drafts publish summary text only."
                          : !saved?.suggestion
                            ? "No saved code suggestion is available; this finding publishes summary text."
                            : "Choose explicitly whether to include the saved code suggestion.")
                    }
                  >
                    <MenuItem value="summary">
                      Text in {action === "comment" ? "conversation comment" : "review summary"}
                    </MenuItem>
                    <MenuItem
                      value="suggestion"
                      disabled={action === "comment" || !finding || !saved?.suggestion}
                    >
                      GitHub suggested change{!saved?.suggestion ? " · no saved replacement" : ""}
                    </MenuItem>
                  </TextField>
                  {entry.mode === "suggestion" ? (
                    <>
                      {!status.valid && (
                        <Alert severity="error">
                          {status.reason} Choose summary text or remove this item; no automatic
                          fallback is applied.
                        </Alert>
                      )}
                      {saved?.suggestion && (
                        <Box component="details">
                          <Typography
                            component="summary"
                            variant="body2"
                            sx={{ cursor: "pointer" }}
                          >
                            Saved source anchor
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
                          "Only replacement code is editable. An empty replacement proposes deleting the bound content; publishing does not apply a commit."
                        }
                        sx={{ "& textarea": { fontFamily: "monospace" } }}
                      />
                    </>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {saved?.suggestion
                        ? "The saved code suggestion is omitted by your delivery choice."
                        : finding?.fixRecommendation.summary ||
                          "This independent draft publishes summary text only."}
                    </Typography>
                  )}
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
