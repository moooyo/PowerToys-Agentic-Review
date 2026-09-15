import { describe, expect, it } from "vitest";
import {
  createFeedbackSelection,
  type FeedbackFindingSelection,
  type FeedbackSelectionContext,
  type FeedbackSuggestionOption,
  feedbackSelectionReducer,
  isFindingSelected,
  isSuggestionSelected,
  selectedFeedback,
} from "./feedback-selection";

type Action = "approve" | "comment" | "suggestion-comment" | "request-changes";

const first: FeedbackSuggestionOption = {
  findingId: "finding-first-page",
  draftId: "draft-first-page",
  suggestionId: "suggestion-first-page",
  valid: true,
  selectedByDefault: true,
};
const second: FeedbackSuggestionOption = {
  findingId: "finding-second-page",
  draftId: "draft-second-page",
  suggestionId: "suggestion-second-page",
  valid: true,
  selectedByDefault: true,
};
const textFinding: FeedbackFindingSelection = {
  findingId: "finding-text",
  draftId: "draft-text",
  suggestionId: null,
};

function context(
  overrides: Partial<FeedbackSelectionContext<Action>> = {},
): FeedbackSelectionContext<Action> {
  return {
    reportId: "report-one",
    reportVersion: 1,
    recommendedAction: "approve",
    suggestionOptions: [first, second],
    ...overrides,
  };
}

describe("server defaults and cross-page feedback selection", () => {
  it("selects only server-validated defaults from the complete report", () => {
    const state = createFeedbackSelection(
      context({
        suggestionOptions: [
          first,
          second,
          { ...first, findingId: "invalid", draftId: "invalid", valid: false },
          { ...first, findingId: "opt-in", draftId: "opt-in", selectedByDefault: false },
        ],
      }),
    );

    expect(selectedFeedback(state)).toEqual({
      findingIds: [first.findingId, second.findingId],
      draftIds: [],
      suggestionIds: [first.suggestionId, second.suggestionId],
    });
    expect(state.action).toBe("suggestion-comment");
    expect(state.explicitAction).toBe(false);
    expect(isFindingSelected(state, second.findingId)).toBe(true);
    expect(isSuggestionSelected(state, first.suggestionId)).toBe(true);
  });

  it("keeps a cancellation and a plain comment across pages and repeated refreshes", () => {
    let state = createFeedbackSelection(context());
    state = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: first,
      selected: false,
    });
    state = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: textFinding,
      selected: true,
    });
    state = feedbackSelectionReducer(state, { type: "refresh", context: context() });
    state = feedbackSelectionReducer(state, {
      type: "refresh",
      context: context({ suggestionOptions: [second, first] }),
    });

    expect(new Set(selectedFeedback(state).findingIds)).toEqual(
      new Set([second.findingId, textFinding.findingId]),
    );
    expect(selectedFeedback(state).suggestionIds).toEqual([second.suggestionId]);
    expect(isFindingSelected(state, first.findingId)).toBe(false);
    expect(state.selectedFindings).toContainEqual(textFinding);
    expect(state.action).toBe("suggestion-comment");
  });

  it("keeps the selected text when the user deselects its code suggestion", () => {
    const original = createFeedbackSelection(context({ suggestionOptions: [first] }));
    const textOnly = feedbackSelectionReducer(original, {
      type: "set-suggestion",
      finding: first,
      suggestionId: first.suggestionId,
      selected: false,
    });
    const refreshed = feedbackSelectionReducer(textOnly, {
      type: "refresh",
      context: context({ suggestionOptions: [first] }),
    });

    expect(refreshed.selectedFindings).toEqual([
      { findingId: first.findingId, draftId: first.draftId, suggestionId: null },
    ]);
    expect(selectedFeedback(refreshed).suggestionIds).toEqual([]);
    expect(refreshed.action).toBe("comment");
    expect(isSuggestionSelected(original, first.suggestionId)).toBe(true);
  });

  it("outputs only selected findings and independent drafts for mixed feedback", () => {
    let state = createFeedbackSelection(context());
    state = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: second,
      selected: false,
    });
    state = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: textFinding,
      selected: true,
    });
    state = feedbackSelectionReducer(state, {
      type: "set-draft",
      draftId: "additional-comment",
      selected: true,
    });
    state = feedbackSelectionReducer(state, {
      type: "set-draft",
      draftId: "additional-comment",
      selected: true,
    });
    state = feedbackSelectionReducer(state, {
      type: "set-draft",
      draftId: "removed-comment",
      selected: true,
    });
    state = feedbackSelectionReducer(state, {
      type: "set-draft",
      draftId: "removed-comment",
      selected: false,
    });

    expect(selectedFeedback(state)).toEqual({
      findingIds: [first.findingId, textFinding.findingId],
      draftIds: ["additional-comment"],
      suggestionIds: [first.suggestionId],
    });
    expect(state.action).toBe("suggestion-comment");
  });

  it("adds newly available defaults without restoring touched findings", () => {
    let state = createFeedbackSelection(context({ suggestionOptions: [first] }));
    state = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: first,
      selected: false,
    });
    state = feedbackSelectionReducer(state, { type: "refresh", context: context() });

    expect(selectedFeedback(state).findingIds).toEqual([second.findingId]);
    expect(state.defaultsCleared).toBe(false);
  });

  it("keeps all defaults cleared even when later refreshes discover more suggestions", () => {
    let state = createFeedbackSelection(context({ suggestionOptions: [first] }));
    state = feedbackSelectionReducer(state, { type: "clear-selection" });
    state = feedbackSelectionReducer(state, { type: "refresh", context: context() });
    expect(selectedFeedback(state)).toEqual({ findingIds: [], draftIds: [], suggestionIds: [] });
    expect(state.action).toBe("approve");

    state = feedbackSelectionReducer(state, {
      type: "set-suggestion",
      finding: second,
      suggestionId: second.suggestionId,
      selected: true,
    });
    state = feedbackSelectionReducer(state, { type: "refresh", context: context() });
    expect(selectedFeedback(state).findingIds).toEqual([second.findingId]);
    expect(state.defaultsCleared).toBe(true);
  });
});

describe("feedback actions and report isolation", () => {
  it("moves from suggestions to text to the latest server recommendation", () => {
    let state = createFeedbackSelection(context({ suggestionOptions: [first] }));
    state = feedbackSelectionReducer(state, {
      type: "set-draft",
      draftId: "additional-comment",
      selected: true,
    });
    expect(state.action).toBe("suggestion-comment");

    state = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: first,
      selected: false,
    });
    expect(state.action).toBe("comment");
    state = feedbackSelectionReducer(state, {
      type: "refresh",
      context: context({ recommendedAction: "request-changes", suggestionOptions: [first] }),
    });
    expect(state.action).toBe("comment");

    state = feedbackSelectionReducer(state, {
      type: "set-draft",
      draftId: "additional-comment",
      selected: false,
    });
    expect(state.action).toBe("request-changes");
    expect(state.explicitAction).toBe(false);
  });

  it.each(["request-changes", "approve"] as const)(
    "preserves explicit %s through selection changes and server refreshes",
    (action) => {
      let state = createFeedbackSelection(context());
      state = feedbackSelectionReducer(state, { type: "set-action", action });
      state = feedbackSelectionReducer(state, { type: "clear-selection" });
      state = feedbackSelectionReducer(state, {
        type: "set-finding",
        finding: textFinding,
        selected: true,
      });
      state = feedbackSelectionReducer(state, {
        type: "refresh",
        context: context({ recommendedAction: "comment" }),
      });
      state = feedbackSelectionReducer(state, { type: "clear-selection" });

      expect(state.action).toBe(action);
      expect(state.explicitAction).toBe(true);
      expect(state).not.toHaveProperty("canApprove");
      expect(state).not.toHaveProperty("hardContentBlockers");
      const automatic = feedbackSelectionReducer(state, { type: "reset-action" });
      expect(automatic.action).toBe("comment");
      expect(automatic.explicitAction).toBe(false);
    },
  );

  it.each([
    { reportId: "report-two", reportVersion: 1 },
    { reportId: "report-one", reportVersion: 2 },
  ])("resets all user state when switching to $reportId version $reportVersion", (report) => {
    let state = createFeedbackSelection(context());
    state = feedbackSelectionReducer(state, { type: "clear-selection" });
    state = feedbackSelectionReducer(state, { type: "set-action", action: "request-changes" });
    state = feedbackSelectionReducer(state, {
      type: "set-draft",
      draftId: "previous-report-comment",
      selected: true,
    });
    state = feedbackSelectionReducer(state, {
      type: "refresh",
      context: context({ ...report, suggestionOptions: [second] }),
    });

    expect(selectedFeedback(state)).toEqual({
      findingIds: [second.findingId],
      draftIds: [],
      suggestionIds: [second.suggestionId],
    });
    expect(state.action).toBe("suggestion-comment");
    expect(state.explicitAction).toBe(false);
    expect(state.defaultsCleared).toBe(false);
    expect(state.touchedFindingIds).toEqual([]);
  });

  it("allows an empty recommendation without inventing an approval action", () => {
    const state = createFeedbackSelection(
      context({ recommendedAction: null, suggestionOptions: [] }),
    );
    expect(state.action).toBeNull();
    expect(feedbackSelectionReducer(state, { type: "clear-selection" }).action).toBeNull();
  });
});

describe("suggestion bindings and immutable updates", () => {
  it("rejects unvalidated or mismatched code suggestions while allowing plain feedback", () => {
    const state = createFeedbackSelection(
      context({ suggestionOptions: [{ ...first, selectedByDefault: false }] }),
    );
    for (const event of [
      { finding: first, suggestionId: "unknown" },
      { finding: { ...first, draftId: "different-draft" }, suggestionId: first.suggestionId },
      { finding: { ...first, findingId: "different-finding" }, suggestionId: first.suggestionId },
    ]) {
      expect(
        feedbackSelectionReducer(state, { type: "set-suggestion", ...event, selected: true }),
      ).toBe(state);
    }
    const plain = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: { ...first, suggestionId: "unknown" },
      selected: true,
    });
    expect(selectedFeedback(plain).suggestionIds).toEqual([]);
    expect(plain.action).toBe("comment");
  });

  it("removes invalid defaults and keeps explicitly selected text without invalid code", () => {
    let state = createFeedbackSelection(context());
    state = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: first,
      selected: true,
    });
    state = feedbackSelectionReducer(state, {
      type: "refresh",
      context: context({
        suggestionOptions: [
          { ...first, valid: false },
          { ...second, valid: false },
        ],
      }),
    });

    expect(state.selectedFindings).toEqual([
      { findingId: first.findingId, draftId: first.draftId, suggestionId: null },
    ]);
    expect(state.action).toBe("comment");
    const refreshed = feedbackSelectionReducer(state, { type: "refresh", context: context() });
    expect(isSuggestionSelected(refreshed, first.suggestionId)).toBe(false);
    expect(isSuggestionSelected(refreshed, second.suggestionId)).toBe(true);
  });

  it("does not transfer a user's selection to an unseen replacement draft", () => {
    let state = createFeedbackSelection(context({ suggestionOptions: [first] }));
    state = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: first,
      selected: true,
    });
    const replacement = { ...first, draftId: "replacement-draft", suggestionId: "replacement" };
    state = feedbackSelectionReducer(state, {
      type: "refresh",
      context: context({ suggestionOptions: [replacement] }),
    });

    expect(selectedFeedback(state)).toEqual({ findingIds: [], draftIds: [], suggestionIds: [] });
    expect(state.touchedFindingIds).toContain(first.findingId);
    expect(state.action).toBe("approve");
    expect(
      feedbackSelectionReducer(state, { type: "set-finding", finding: first, selected: true }),
    ).toBe(state);
  });

  it("ignores a stale suggestion cancellation for a different draft", () => {
    const state = createFeedbackSelection(context({ suggestionOptions: [first] }));
    const next = feedbackSelectionReducer(state, {
      type: "set-suggestion",
      finding: { ...first, draftId: "stale-draft" },
      suggestionId: first.suggestionId,
      selected: false,
    });
    expect(next).toBe(state);
  });

  it("does not share mutable input references or mutate previous state", () => {
    const option = { ...first };
    const state = createFeedbackSelection(context({ suggestionOptions: [option] }));
    option.valid = false;
    expect(state.suggestionOptions[0]?.valid).toBe(true);

    Object.freeze(state);
    Object.freeze(state.selectedFindings);
    Object.freeze(state.selectedFindings[0]);
    Object.freeze(state.touchedFindingIds);
    Object.freeze(state.selectedDraftIds);
    const next = feedbackSelectionReducer(state, {
      type: "set-finding",
      finding: first,
      selected: false,
    });
    expect(selectedFeedback(state).findingIds).toEqual([first.findingId]);
    expect(selectedFeedback(next).findingIds).toEqual([]);
    expect(state.touchedFindingIds).toEqual([]);

    const selectedInput = { ...textFinding };
    const selected = feedbackSelectionReducer(next, {
      type: "set-finding",
      finding: selectedInput,
      selected: true,
    });
    selectedInput.draftId = "changed-outside-reducer";
    expect(selected.selectedFindings[0]?.draftId).toBe(textFinding.draftId);
  });
});
