import type {
  ActionContextV1,
  InvestigationActionKind,
  InvestigationActionPayload,
  InvestigationFeedbackDraft,
  InvestigationResultV1,
} from "@agentic-review/contracts";
import type { FeedbackSelectionState } from "./feedback-selection";

export interface PublicationEntry {
  draftId: string;
  findingId: string | null;
  body: string;
  /** The report feedback last explicitly reviewed by the author of this publication. */
  sourceBody: string;
  mode: "summary" | "suggestion";
  replacement: string;
}

export interface PublicationComposerDraft {
  selectedFindingIds: string[];
  selectedDraftIds: string[];
  /** Entries are keyed by saved feedback draft ID, never by visible list position. */
  entries: Record<string, PublicationEntry>;
  reportSelectionKey: string | null;
}

type FeedbackPayload = Extract<InvestigationActionPayload, { kind: "feedback" }>;
type Report = InvestigationResultV1 | undefined;
type EditedBodies = Readonly<Record<string, string>>;
const encoder = new TextEncoder();
const feedbackActions = new Set<InvestigationActionKind>([
  "comment",
  "approve",
  "request-changes",
  "suggestion-comment",
]);
// A preparation has no server intent ID yet. Reserve the contract's maximum 128-byte
// EntityId plus the SHA-256 digest so an otherwise valid summary still fits its marker.
const maximumSubmissionMarker = `<!-- agentic-review-action:${"x".repeat(128)}:${"0".repeat(64)} -->`;

export function createPublicationComposer(): PublicationComposerDraft {
  return { selectedFindingIds: [], selectedDraftIds: [], entries: {}, reportSelectionKey: null };
}

export function publicationSelectionKey(
  selection: FeedbackSelectionState<InvestigationActionKind>,
): string {
  return JSON.stringify([
    selection.reportId,
    selection.reportVersion,
    selection.selectedFindings
      .map((item) => [item.findingId, item.draftId, item.suggestionId])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [...selection.selectedDraftIds].sort(),
  ]);
}

function createEntry(
  saved: InvestigationFeedbackDraft,
  findingId: string | null,
  editedBodies: EditedBodies,
  includeSuggestion: boolean,
): PublicationEntry {
  const body = editedBodies[saved.id] ?? saved.body;
  return {
    draftId: saved.id,
    findingId,
    body,
    sourceBody: body,
    mode: findingId !== null && includeSuggestion && saved.suggestion ? "suggestion" : "summary",
    replacement: saved.suggestion?.replacement ?? "",
  };
}

function alignSelectedEntryRoles(
  draft: PublicationComposerDraft,
  result: Report,
): PublicationComposerDraft {
  const roles = new Map<string, string | null>(
    draft.selectedDraftIds.map((id) => [id, null] as const),
  );
  for (const findingId of draft.selectedFindingIds) {
    const finding = result?.findings.find((item) => item.id === findingId);
    if (finding) roles.set(finding.feedbackDraft.id, finding.id);
  }
  const entries = { ...draft.entries };
  for (const [draftId, findingId] of roles) {
    const entry = entries[draftId];
    if (entry && entry.findingId !== findingId) entries[draftId] = { ...entry, findingId };
  }
  return { ...draft, entries };
}

export function importPublicationSelection(
  draft: PublicationComposerDraft,
  selection: FeedbackSelectionState<InvestigationActionKind>,
  result: Report,
  editedBodies: EditedBodies = {},
  action: InvestigationActionKind | null = selection.action,
): PublicationComposerDraft {
  const entries = { ...draft.entries };
  for (const selected of selection.selectedFindings) {
    const finding = result?.findings.find(
      (item) => item.id === selected.findingId && item.feedbackDraft.id === selected.draftId,
    );
    if (finding && !entries[selected.draftId])
      entries[selected.draftId] = createEntry(
        finding.feedbackDraft,
        finding.id,
        editedBodies,
        action !== "comment",
      );
  }
  for (const draftId of selection.selectedDraftIds) {
    const saved = result?.feedbackDrafts.find((item) => item.id === draftId);
    if (saved && !entries[draftId])
      entries[draftId] = createEntry(saved, null, editedBodies, false);
  }
  return alignSelectedEntryRoles(
    {
      ...draft,
      selectedFindingIds: [...new Set(selection.selectedFindings.map((item) => item.findingId))],
      selectedDraftIds: [...new Set(selection.selectedDraftIds)],
      entries,
      reportSelectionKey: publicationSelectionKey(selection),
    },
    result,
  );
}

export function setPublicationFinding(
  draft: PublicationComposerDraft,
  findingId: string,
  selected: boolean,
  result: Report,
  editedBodies: EditedBodies = {},
  action: InvestigationActionKind | null = null,
): PublicationComposerDraft {
  const finding = result?.findings.find((item) => item.id === findingId);
  const entries = { ...draft.entries };
  if (selected && finding && !entries[finding.feedbackDraft.id])
    entries[finding.feedbackDraft.id] = createEntry(
      finding.feedbackDraft,
      finding.id,
      editedBodies,
      action !== "comment",
    );
  return alignSelectedEntryRoles(
    {
      ...draft,
      entries,
      selectedFindingIds: selected
        ? [...new Set([...draft.selectedFindingIds, findingId])]
        : draft.selectedFindingIds.filter((id) => id !== findingId),
    },
    result,
  );
}

export function setPublicationIndependentDraft(
  draft: PublicationComposerDraft,
  draftId: string,
  selected: boolean,
  result: Report,
  editedBodies: EditedBodies = {},
  _action: InvestigationActionKind | null = null,
): PublicationComposerDraft {
  const saved = result?.feedbackDrafts.find((item) => item.id === draftId);
  const entries = { ...draft.entries };
  if (selected && saved && !entries[draftId])
    entries[draftId] = createEntry(saved, null, editedBodies, false);
  return alignSelectedEntryRoles(
    {
      ...draft,
      entries,
      selectedDraftIds: selected
        ? [...new Set([...draft.selectedDraftIds, draftId])]
        : draft.selectedDraftIds.filter((id) => id !== draftId),
    },
    result,
  );
}

function savedDraft(
  entry: PublicationEntry,
  result: Report,
): InvestigationFeedbackDraft | undefined {
  return entry.findingId === null
    ? result?.feedbackDrafts.find((item) => item.id === entry.draftId)
    : result?.findings.find(
        (item) => item.id === entry.findingId && item.feedbackDraft.id === entry.draftId,
      )?.feedbackDraft;
}

export function publicationEntrySourceBody(
  entry: PublicationEntry,
  result: Report,
  editedBodies: EditedBodies = {},
): string {
  return editedBodies[entry.draftId] ?? savedDraft(entry, result)?.body ?? entry.sourceBody;
}

function reportMatchesContext(result: Report, context: ActionContextV1): boolean {
  return Boolean(
    result &&
      context.repositoryId === result.context.repository.id &&
      context.workItemId === result.context.workItem.id &&
      context.reportRef?.id === result.report.id &&
      context.reportRef.version === result.report.version &&
      context.reportRef.digest === result.report.logicalContentDigest,
  );
}

export function publicationSuggestionStatus(
  entry: PublicationEntry,
  result: Report,
  context: ActionContextV1,
): { valid: boolean; reason: string | null } {
  const saved = savedDraft(entry, result);
  if (entry.findingId === null || !saved?.suggestion)
    return {
      valid: false,
      reason: "This draft has no saved code suggestion. Publish it as summary text.",
    };
  if (!reportMatchesContext(result, context))
    return {
      valid: false,
      reason: "Refresh the exact report and action context before using this suggestion.",
    };
  const option = context.suggestionSelectionDefaults.find(
    (item) => item.findingId === entry.findingId && item.draftId === entry.draftId,
  );
  if (!option?.valid)
    return {
      valid: false,
      reason:
        option?.reason ||
        "The saved suggestion anchor is unavailable. Refresh it or explicitly choose summary text.",
    };
  if (
    context.target.kind !== "pull_request" ||
    context.target.headSha !== saved.suggestion.headSha ||
    saved.suggestion.startLine < 1 ||
    saved.suggestion.endLine < saved.suggestion.startLine
  )
    return {
      valid: false,
      reason:
        "The saved suggestion no longer matches this PR revision. Refresh it or explicitly choose summary text.",
    };
  return { valid: true, reason: null };
}

interface SelectedEntry {
  entry: PublicationEntry;
  saved: InvestigationFeedbackDraft;
}

function selectedEntries(
  draft: PublicationComposerDraft,
  result: Report,
): { rows: SelectedEntry[]; unavailable: boolean } {
  const rows: SelectedEntry[] = [];
  const seen = new Set<string>();
  let unavailable = false;
  for (const findingId of draft.selectedFindingIds) {
    const finding = result?.findings.find((item) => item.id === findingId);
    const entry = finding && draft.entries[finding.feedbackDraft.id];
    if (!finding || !entry || entry.draftId !== finding.feedbackDraft.id) {
      unavailable = true;
      continue;
    }
    if (!seen.has(entry.draftId)) {
      rows.push({ entry: { ...entry, findingId }, saved: finding.feedbackDraft });
      seen.add(entry.draftId);
    }
  }
  for (const draftId of draft.selectedDraftIds) {
    const saved = result?.feedbackDrafts.find((item) => item.id === draftId);
    const entry = draft.entries[draftId];
    if (!saved || !entry || entry.draftId !== draftId) {
      unavailable = true;
      continue;
    }
    if (!seen.has(draftId)) {
      rows.push({ entry: { ...entry, findingId: null }, saved });
      seen.add(draftId);
    }
  }
  return { rows, unavailable };
}

export function validatePublication(
  draft: PublicationComposerDraft,
  result: Report,
  context: ActionContextV1,
  action: InvestigationActionKind | null,
  summary: string,
  editedBodies: EditedBodies = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  const add = (key: string, message: string) => {
    errors[key] = errors[key] ? `${errors[key]} ${message}` : message;
  };
  if (!action || !feedbackActions.has(action)) add("selection", "Choose a feedback operation.");
  if (action === "request-changes" && draft.selectedFindingIds.length === 0)
    add("selection", "Select at least one finding to request changes.");
  if (action === "approve" && context.hardContentBlockers.length > 0)
    add(
      "selection",
      "Approve is blocked by a confirmed unresolved P0 in the complete original report.",
    );
  if (
    new Set(draft.selectedFindingIds).size !== draft.selectedFindingIds.length ||
    new Set(draft.selectedDraftIds).size !== draft.selectedDraftIds.length
  )
    add("selection", "Select each finding and independent draft only once.");
  const { rows, unavailable } = selectedEntries(draft, result);
  if (unavailable)
    add(
      "selection",
      "A selected finding or draft is unavailable in this report. Refresh and review the selection.",
    );
  if (
    (draft.selectedFindingIds.length > 0 || draft.selectedDraftIds.length > 0) &&
    !reportMatchesContext(result, context)
  )
    add(
      "selection",
      "The selected feedback is not bound to the current report and source. Refresh before preparing.",
    );
  if (new Set(rows.map(({ entry }) => entry.draftId)).size !== rows.length)
    add("selection", "The selected feedback contains a duplicate draft.");
  if (action !== "approve" && !summary.trim() && rows.length === 0)
    add("selection", "Add a message or select feedback to publish.");

  const ranges = new Map<string, Array<{ start: number; end: number; draftId: string }>>();
  let suggestions = 0;
  for (const { entry, saved } of rows) {
    const field = `draft-${entry.draftId}`;
    if (!entry.body.trim())
      add(`${field}-body`, "Add publishing text or remove this draft from the selection.");
    if (publicationEntrySourceBody(entry, result, editedBodies) !== entry.sourceBody)
      add(
        `${field}-body`,
        "Report feedback changed. Choose Use latest feedback or Keep publishing text before preparing.",
      );
    if (entry.mode !== "suggestion") continue;
    suggestions += 1;
    if (action === "comment")
      add(
        `${field}-mode`,
        "Conversation comments contain text only. Explicitly choose summary text or another review operation.",
      );
    const status = publicationSuggestionStatus(entry, result, context);
    if (!status.valid) add(`${field}-mode`, status.reason!);
    if (entry.replacement.includes("```"))
      add(`${field}-replacement`, "Replacement code cannot contain a triple-backtick fence.");
    const inlineBody = `${entry.body}\n\n\`\`\`suggestion\n${entry.replacement}\n\`\`\``;
    if (encoder.encode(inlineBody).length > 60_000)
      add(
        `${field}-replacement`,
        "Publishing text and replacement code together exceed the 60,000-byte UTF-8 limit. Shorten them explicitly.",
      );
    if (saved.suggestion) {
      const anchor = saved.suggestion;
      const previous = ranges.get(anchor.path) ?? [];
      for (const other of previous) {
        if (other.start <= anchor.endLine && anchor.startLine <= other.end) {
          add(
            `${field}-mode`,
            "This suggestion overlaps another selected suggestion. Choose summary text or remove one of them.",
          );
          add(
            `draft-${other.draftId}-mode`,
            "This suggestion overlaps another selected suggestion. Choose summary text or remove one of them.",
          );
        }
      }
      previous.push({ start: anchor.startLine, end: anchor.endLine, draftId: entry.draftId });
      ranges.set(anchor.path, previous);
    }
  }
  if (suggestions > 100)
    add(
      "selection",
      "A review can include at most 100 code suggestions. Explicitly reduce the selection.",
    );
  if (action === "suggestion-comment" && suggestions === 0)
    add("selection", "Select at least one valid code suggestion for a comment review.");
  const transportSummary = [
    summary,
    ...rows.filter(({ entry }) => entry.mode === "summary").map(({ entry }) => entry.body),
    maximumSubmissionMarker,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (encoder.encode(transportSummary).length > 60_000)
    add(
      "summary",
      "The summary and text findings exceed the 60,000-byte UTF-8 limit including reserved submission identity space. Shorten them explicitly.",
    );
  return errors;
}

export function materializePublication(
  draft: PublicationComposerDraft,
  result: Report,
  context: ActionContextV1,
  action: InvestigationActionKind | null,
  summary: string,
  editedBodies: EditedBodies = {},
): FeedbackPayload {
  const errors = validatePublication(draft, result, context, action, summary, editedBodies);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(" "));
  return {
    kind: "feedback",
    body: summary,
    findingIds: [...draft.selectedFindingIds],
    drafts: selectedEntries(draft, result).rows.map(({ entry, saved }) => ({
      id: saved.id,
      body: entry.body,
      suggestion:
        entry.findingId !== null && entry.mode === "suggestion" && saved.suggestion
          ? { ...saved.suggestion, replacement: entry.replacement }
          : null,
    })),
  };
}
