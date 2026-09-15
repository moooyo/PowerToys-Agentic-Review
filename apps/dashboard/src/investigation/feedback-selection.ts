export interface FeedbackFindingReference {
  readonly findingId: string;
  readonly draftId: string;
}

export interface FeedbackFindingSelection extends FeedbackFindingReference {
  readonly suggestionId: string | null;
}

export interface FeedbackSuggestionOption extends FeedbackFindingReference {
  readonly suggestionId: string;
  readonly valid: boolean;
  readonly selectedByDefault: boolean;
}

export interface FeedbackSelectionContext<Action extends string = string> {
  readonly reportId: string;
  readonly reportVersion: number;
  readonly recommendedAction: Action | null;
  // This is the server's complete selection context, independent of the visible page.
  readonly suggestionOptions: readonly FeedbackSuggestionOption[];
}

export interface FeedbackSelectionState<Action extends string = string>
  extends FeedbackSelectionContext<Action> {
  readonly selectedFindings: readonly FeedbackFindingSelection[];
  readonly selectedDraftIds: readonly string[];
  readonly touchedFindingIds: readonly string[];
  readonly defaultsCleared: boolean;
  readonly action: Action | "comment" | "suggestion-comment" | null;
  readonly explicitAction: boolean;
}

export type FeedbackSelectionEvent<Action extends string = string> =
  | { readonly type: "refresh"; readonly context: FeedbackSelectionContext<Action> }
  | {
      readonly type: "set-finding";
      readonly finding: FeedbackFindingSelection;
      readonly selected: boolean;
    }
  | {
      readonly type: "set-suggestion";
      readonly finding: FeedbackFindingReference;
      readonly suggestionId: string;
      readonly selected: boolean;
    }
  | { readonly type: "set-draft"; readonly draftId: string; readonly selected: boolean }
  | {
      readonly type: "set-action";
      readonly action: Action | "comment" | "suggestion-comment" | null;
    }
  | { readonly type: "reset-action" }
  | { readonly type: "clear-selection" };

function copyContext<Action extends string>(
  context: FeedbackSelectionContext<Action>,
): FeedbackSelectionContext<Action> {
  return {
    reportId: context.reportId,
    reportVersion: context.reportVersion,
    recommendedAction: context.recommendedAction,
    suggestionOptions: context.suggestionOptions.map((option) => ({ ...option })),
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function validSuggestion(
  context: FeedbackSelectionContext,
  finding: FeedbackFindingReference,
  suggestionId: string,
): boolean {
  return context.suggestionOptions.some(
    (option) =>
      option.valid &&
      option.findingId === finding.findingId &&
      option.draftId === finding.draftId &&
      option.suggestionId === suggestionId,
  );
}

function currentDraft(
  context: FeedbackSelectionContext,
  finding: FeedbackFindingReference,
): boolean {
  const options = context.suggestionOptions.filter(
    (option) => option.findingId === finding.findingId,
  );
  return options.length === 0 || options.some((option) => option.draftId === finding.draftId);
}

function normalizeFinding(
  context: FeedbackSelectionContext,
  finding: FeedbackFindingSelection,
): FeedbackFindingSelection {
  return {
    findingId: finding.findingId,
    draftId: finding.draftId,
    suggestionId:
      finding.suggestionId !== null && validSuggestion(context, finding, finding.suggestionId)
        ? finding.suggestionId
        : null,
  };
}

function defaultFindings(context: FeedbackSelectionContext): FeedbackFindingSelection[] {
  const findings = new Map<string, FeedbackFindingSelection>();
  for (const option of context.suggestionOptions) {
    if (option.valid && option.selectedByDefault) {
      findings.set(option.findingId, {
        findingId: option.findingId,
        draftId: option.draftId,
        suggestionId: option.suggestionId,
      });
    }
  }
  return [...findings.values()];
}

function automaticAction<Action extends string>(
  state: FeedbackSelectionState<Action>,
): FeedbackSelectionState<Action> {
  if (state.explicitAction) return state;
  return {
    ...state,
    action: state.selectedFindings.some((finding) => finding.suggestionId !== null)
      ? "suggestion-comment"
      : state.selectedFindings.length > 0 || state.selectedDraftIds.length > 0
        ? "comment"
        : state.recommendedAction,
  };
}

export function createFeedbackSelection<Action extends string>(
  context: FeedbackSelectionContext<Action>,
): FeedbackSelectionState<Action> {
  const copied = copyContext(context);
  return automaticAction({
    ...copied,
    selectedFindings: defaultFindings(copied),
    selectedDraftIds: [],
    touchedFindingIds: [],
    defaultsCleared: false,
    action: copied.recommendedAction,
    explicitAction: false,
  });
}

function refreshSelection<Action extends string>(
  state: FeedbackSelectionState<Action>,
  context: FeedbackSelectionContext<Action>,
): FeedbackSelectionState<Action> {
  if (state.reportId !== context.reportId || state.reportVersion !== context.reportVersion) {
    return createFeedbackSelection(context);
  }

  const copied = copyContext(context);
  const touched = new Set(state.touchedFindingIds);
  const selectedFindings = state.selectedFindings
    .filter((finding) => touched.has(finding.findingId) && currentDraft(copied, finding))
    .map((finding) => normalizeFinding(copied, finding));
  if (!state.defaultsCleared) {
    selectedFindings.push(
      ...defaultFindings(copied).filter((finding) => !touched.has(finding.findingId)),
    );
  }
  return automaticAction({ ...state, ...copied, selectedFindings });
}

function setFinding<Action extends string>(
  state: FeedbackSelectionState<Action>,
  finding: FeedbackFindingSelection,
  selected: boolean,
): FeedbackSelectionState<Action> {
  if (selected && !currentDraft(state, finding)) return state;
  const previousIndex = state.selectedFindings.findIndex(
    (item) => item.findingId === finding.findingId,
  );
  const selectedFindings = state.selectedFindings.filter(
    (item) => item.findingId !== finding.findingId,
  );
  if (selected) {
    selectedFindings.splice(
      previousIndex < 0 ? selectedFindings.length : previousIndex,
      0,
      normalizeFinding(state, finding),
    );
  }
  return automaticAction({
    ...state,
    selectedFindings,
    touchedFindingIds: uniqueIds([...state.touchedFindingIds, finding.findingId]),
  });
}

export function feedbackSelectionReducer<Action extends string>(
  state: FeedbackSelectionState<Action>,
  event: FeedbackSelectionEvent<Action>,
): FeedbackSelectionState<Action> {
  switch (event.type) {
    case "refresh":
      return refreshSelection(state, event.context);
    case "set-finding":
      return setFinding(state, event.finding, event.selected);
    case "set-suggestion": {
      if (event.selected) {
        if (!validSuggestion(state, event.finding, event.suggestionId)) return state;
        return setFinding(state, { ...event.finding, suggestionId: event.suggestionId }, true);
      }
      const selected = state.selectedFindings.find(
        (finding) => finding.findingId === event.finding.findingId,
      );
      if (
        selected &&
        (selected.draftId !== event.finding.draftId ||
          (selected.suggestionId !== null && selected.suggestionId !== event.suggestionId))
      ) {
        return state;
      }
      return setFinding(state, { ...event.finding, suggestionId: null }, selected !== undefined);
    }
    case "set-draft":
      return automaticAction({
        ...state,
        selectedDraftIds: event.selected
          ? uniqueIds([...state.selectedDraftIds, event.draftId])
          : state.selectedDraftIds.filter((draftId) => draftId !== event.draftId),
      });
    case "set-action":
      return { ...state, action: event.action, explicitAction: true };
    case "reset-action":
      return automaticAction({ ...state, explicitAction: false });
    case "clear-selection":
      return automaticAction({
        ...state,
        selectedFindings: [],
        selectedDraftIds: [],
        touchedFindingIds: uniqueIds([
          ...state.touchedFindingIds,
          ...state.selectedFindings.map((finding) => finding.findingId),
          ...state.suggestionOptions.map((option) => option.findingId),
        ]),
        defaultsCleared: true,
      });
  }
}

export function selectedFeedback(state: FeedbackSelectionState): {
  readonly findingIds: readonly string[];
  // Finding drafts are bound in selectedFindings; these are independent extra drafts.
  readonly draftIds: readonly string[];
  readonly suggestionIds: readonly string[];
} {
  return {
    findingIds: state.selectedFindings.map((finding) => finding.findingId),
    draftIds: [...state.selectedDraftIds],
    suggestionIds: uniqueIds(
      state.selectedFindings.flatMap((finding) =>
        finding.suggestionId === null ? [] : [finding.suggestionId],
      ),
    ),
  };
}

export function isFindingSelected(state: FeedbackSelectionState, findingId: string): boolean {
  return state.selectedFindings.some((finding) => finding.findingId === findingId);
}

export function isSuggestionSelected(state: FeedbackSelectionState, suggestionId: string): boolean {
  return state.selectedFindings.some((finding) => finding.suggestionId === suggestionId);
}
