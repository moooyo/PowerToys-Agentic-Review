import type {
  InvestigationActionKind,
  InvestigationFeedbackDraft,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { createFeedbackSelection, feedbackSelectionReducer } from "./feedback-selection";
import {
  createPublicationComposer,
  importPublicationSelection,
  materializePublication,
  publicationEntrySourceBody,
  publicationSelectionKey,
  publicationSuggestionStatus,
  setPublicationFinding,
  setPublicationIndependentDraft,
  validatePublication,
} from "./publication-composer";
import { selectionContext } from "./report-state";
import { createSampleInvestigationApi } from "./sample-adapter";

async function fixture() {
  const api = createSampleInvestigationApi();
  const result = await api.exportReport("sample-pr-p1-report");
  const context = await api.actionContext(result.context.workItem.id, result.id);
  const suggestion = result.findings.find((finding) => finding.feedbackDraft.suggestion !== null);
  const plain = result.findings.find((finding) => finding.feedbackDraft.suggestion === null);
  if (!suggestion || !plain)
    throw new Error("The fixture requires a saved suggestion and plain finding.");
  let selection = createFeedbackSelection<InvestigationActionKind>(selectionContext(context));
  selection = feedbackSelectionReducer(selection, { type: "clear-selection" });
  selection = feedbackSelectionReducer(selection, {
    type: "set-action",
    action: "request-changes",
  });
  selection = feedbackSelectionReducer(selection, {
    type: "set-finding",
    finding: {
      findingId: suggestion.id,
      draftId: suggestion.feedbackDraft.id,
      suggestionId: suggestion.feedbackDraft.id,
    },
    selected: true,
  });
  return { result, context, suggestion, plain, selection };
}

describe("publication composer", () => {
  it("starts independently and imports only explicit report selections", async () => {
    const { result, suggestion, plain, selection } = await fixture();
    const approve = createPublicationComposer();
    const requestChanges = importPublicationSelection(
      createPublicationComposer(),
      selection,
      result,
    );
    expect(approve.selectedFindingIds).toEqual([]);
    expect(requestChanges.selectedFindingIds).toEqual([suggestion.id]);
    expect(requestChanges.entries[plain.feedbackDraft.id]).toBeUndefined();
    expect(approve.entries).toEqual({});
    expect(requestChanges.reportSelectionKey).toBe(publicationSelectionKey(selection));
  });

  it("synchronizes selection without overwriting publication edits or the report selection", async () => {
    const { result, suggestion, plain, selection } = await fixture();
    const initial = importPublicationSelection(createPublicationComposer(), selection, result);
    const draftId = suggestion.feedbackDraft.id;
    const authored = {
      ...initial,
      entries: {
        ...initial.entries,
        [draftId]: {
          ...initial.entries[draftId]!,
          body: "My publishing text",
          replacement: "myCode();",
        },
      },
    };
    const nextSelection = feedbackSelectionReducer(selection, {
      type: "set-finding",
      finding: { findingId: plain.id, draftId: plain.feedbackDraft.id, suggestionId: null },
      selected: true,
    });
    const beforeSelection = structuredClone(nextSelection);
    const imported = importPublicationSelection(authored, nextSelection, result);
    expect(imported.entries[draftId]).toMatchObject({
      body: "My publishing text",
      replacement: "myCode();",
    });
    expect(imported.selectedFindingIds).toEqual([suggestion.id, plain.id]);
    expect(nextSelection).toEqual(beforeSelection);
    expect(authored.selectedFindingIds).toEqual([suggestion.id]);
    const cleared = importPublicationSelection(
      imported,
      { ...nextSelection, selectedFindings: [] },
      result,
    );
    expect(cleared.selectedFindingIds).toEqual([]);
    expect(cleared.entries[draftId]?.body).toBe("My publishing text");
  });

  it("compares report selection as a set while retaining suggestion choices", async () => {
    const { selection, plain } = await fixture();
    const items = [
      ...selection.selectedFindings,
      { findingId: plain.id, draftId: plain.feedbackDraft.id, suggestionId: null },
    ];
    expect(publicationSelectionKey({ ...selection, selectedFindings: items })).toBe(
      publicationSelectionKey({ ...selection, selectedFindings: [...items].reverse() }),
    );
    expect(publicationSelectionKey(selection)).not.toBe(
      publicationSelectionKey({
        ...selection,
        selectedFindings: selection.selectedFindings.map((item) => ({
          ...item,
          suggestionId: null,
        })),
      }),
    );
  });

  it("requires explicit review of changed feedback and can keep publishing text repeatedly", async () => {
    const { result, context, suggestion, selection } = await fixture();
    const draftId = suggestion.feedbackDraft.id;
    const initialSource = { [draftId]: "Report editor first revision" };
    const draft = importPublicationSelection(
      createPublicationComposer(),
      selection,
      result,
      initialSource,
    );
    expect(
      validatePublication(draft, result, context, "request-changes", "", initialSource),
    ).toEqual({});
    const authored = {
      ...draft,
      entries: {
        ...draft.entries,
        [draftId]: { ...draft.entries[draftId]!, body: "Text for publication" },
      },
    };
    const changedSource = { [draftId]: "Report editor second revision" };
    const imported = importPublicationSelection(authored, selection, result, changedSource);
    expect(imported.entries[draftId]?.body).toBe("Text for publication");
    expect(
      validatePublication(imported, result, context, "request-changes", "", changedSource)[
        `draft-${draftId}-body`
      ],
    ).toContain("Report feedback changed");
    const entry = imported.entries[draftId]!;
    const kept = {
      ...imported,
      entries: {
        ...imported.entries,
        [draftId]: {
          ...entry,
          sourceBody: publicationEntrySourceBody(entry, result, changedSource),
        },
      },
    };
    expect(
      validatePublication(kept, result, context, "request-changes", "", changedSource),
    ).toEqual({});
    expect(kept.entries[draftId]?.body).toBe("Text for publication");
    expect(
      validatePublication(kept, result, context, "request-changes", "", {
        [draftId]: "Third revision",
      })[`draft-${draftId}-body`],
    ).toContain("Report feedback changed");
  });

  it("keeps every saved anchor field and edits only replacement, including an empty deletion", async () => {
    const { result, context, suggestion, selection } = await fixture();
    const draft = importPublicationSelection(createPublicationComposer(), selection, result);
    const draftId = suggestion.feedbackDraft.id;
    const edited = {
      ...draft,
      entries: { ...draft.entries, [draftId]: { ...draft.entries[draftId]!, replacement: "" } },
    };
    const payload = materializePublication(
      edited,
      result,
      context,
      "request-changes",
      "Review summary",
    );
    expect(payload.body).toBe("Review summary");
    expect(payload.drafts[0]?.suggestion).toEqual({
      ...suggestion.feedbackDraft.suggestion,
      replacement: "",
    });
    expect(suggestion.feedbackDraft.suggestion?.replacement).not.toBe("");
  });

  it("blocks stale anchors without silently converting them into summary text", async () => {
    const { result, context, suggestion, selection } = await fixture();
    const draft = importPublicationSelection(createPublicationComposer(), selection, result);
    const draftId = suggestion.feedbackDraft.id;
    const stale = {
      ...context,
      suggestionSelectionDefaults: context.suggestionSelectionDefaults.map((option) => ({
        ...option,
        valid: false,
        reason: "Saved lines moved outside the diff.",
      })),
    };
    expect(publicationSuggestionStatus(draft.entries[draftId]!, result, stale)).toEqual({
      valid: false,
      reason: "Saved lines moved outside the diff.",
    });
    expect(
      validatePublication(draft, result, stale, "request-changes", "")[`draft-${draftId}-mode`],
    ).toContain("outside the diff");
    expect(() => materializePublication(draft, result, stale, "request-changes", "")).toThrow(
      "outside the diff",
    );
    expect(draft.entries[draftId]?.mode).toBe("suggestion");
    const textOnly = {
      ...draft,
      entries: {
        ...draft.entries,
        [draftId]: { ...draft.entries[draftId]!, mode: "summary" as const },
      },
    };
    expect(
      materializePublication(textOnly, result, stale, "request-changes", "").drafts[0]?.suggestion,
    ).toBeNull();
  });

  it("rejects stale report identity and a changed PR head", async () => {
    const { result, context, suggestion, selection } = await fixture();
    const draft = importPublicationSelection(createPublicationComposer(), selection, result);
    const entry = draft.entries[suggestion.feedbackDraft.id]!;
    const differentReport = {
      ...context,
      reportRef: { ...context.reportRef!, digest: "f".repeat(64) },
    };
    expect(
      validatePublication(draft, result, differentReport, "request-changes", "").selection,
    ).toContain("not bound");
    expect(
      publicationSuggestionStatus(entry, result, {
        ...context,
        target: { ...context.target, headSha: "f".repeat(40) },
      }).valid,
    ).toBe(false);
  });

  it("does not inherit the report reducer's automatic invalid-suggestion downgrade", async () => {
    const { result, context, suggestion, selection } = await fixture();
    const normalized = {
      ...selection,
      selectedFindings: selection.selectedFindings.map((item) => ({ ...item, suggestionId: null })),
    };
    const stale = {
      ...context,
      suggestionSelectionDefaults: context.suggestionSelectionDefaults.map((option) => ({
        ...option,
        valid: false,
        reason: "Saved anchor must be reviewed.",
      })),
    };
    const draft = importPublicationSelection(createPublicationComposer(), normalized, result);
    expect(draft.entries[suggestion.feedbackDraft.id]?.mode).toBe("suggestion");
    expect(
      validatePublication(draft, result, stale, "request-changes", "")[
        `draft-${suggestion.feedbackDraft.id}-mode`
      ],
    ).toContain("Saved anchor must be reviewed");
  });

  it("keeps Request changes, Approve, conversation comments, and suggestion reviews distinct", async () => {
    const { result, context, suggestion, selection } = await fixture();
    const empty = createPublicationComposer();
    expect(
      validatePublication(empty, result, context, "request-changes", "Summary only").selection,
    ).toContain("at least one finding");
    expect(validatePublication(empty, result, context, "approve", "")).toEqual({});
    const full = importPublicationSelection(empty, selection, result);
    expect(
      validatePublication(full, result, context, "comment", "")[
        `draft-${suggestion.feedbackDraft.id}-mode`
      ],
    ).toContain("Comments contain text only");
    const conversation = importPublicationSelection(empty, selection, result, {}, "comment");
    expect(
      materializePublication(conversation, result, context, "comment", "").drafts.every(
        (item) => item.suggestion === null,
      ),
    ).toBe(true);
    expect(
      validatePublication(conversation, result, context, "suggestion-comment", "").selection,
    ).toContain("at least one valid code suggestion");
    expect(validatePublication(full, result, context, "suggestion-comment", "")).toEqual({});
    expect(
      materializePublication(full, result, context, "approve", "").drafts[0]?.suggestion,
    ).not.toBeNull();
  });

  it("retains the complete-report P0 block even with no selected findings", async () => {
    const { result, context } = await fixture();
    const blocked = {
      ...context,
      hardContentBlockers: [
        {
          findingId: "off-page-p0",
          reportRef: context.reportRef!,
          checkpointRef: null,
          reason: "Confirmed unresolved P0",
        },
      ],
    };
    expect(
      validatePublication(createPublicationComposer(), result, blocked, "approve", "").selection,
    ).toContain("complete original report");
  });

  it("publishes only selected drafts and keeps summary composition separate from inline bodies", async () => {
    const { result, context, suggestion, plain, selection } = await fixture();
    const independent: InvestigationFeedbackDraft = {
      id: "independent-extra",
      body: "Independent report text",
      suggestion: suggestion.feedbackDraft.suggestion,
    };
    result.feedbackDrafts.push(independent);
    const initial = importPublicationSelection(createPublicationComposer(), selection, result);
    const withText = setPublicationFinding(initial, plain.id, true, result, {}, "request-changes");
    const withExtra = setPublicationIndependentDraft(withText, independent.id, true, result);
    const payload = materializePublication(
      withExtra,
      result,
      context,
      "request-changes",
      "Only the summary",
    );
    expect(payload.body).toBe("Only the summary");
    expect(payload.findingIds).toEqual([suggestion.id, plain.id]);
    expect(payload.drafts.map((item) => item.id)).toEqual([
      suggestion.feedbackDraft.id,
      plain.feedbackDraft.id,
      independent.id,
    ]);
    expect(payload.drafts[2]?.suggestion).toBeNull();
    const removed = setPublicationFinding(withExtra, suggestion.id, false, result);
    expect(
      materializePublication(removed, result, context, "request-changes", "").drafts.map(
        (item) => item.id,
      ),
    ).toEqual([plain.feedbackDraft.id, independent.id]);
    expect(withExtra.selectedFindingIds).toContain(suggestion.id);
    const extraOnly = setPublicationIndependentDraft(
      createPublicationComposer(),
      independent.id,
      true,
      result,
    );
    expect(
      validatePublication(extraOnly, result, context, "request-changes", "").selection,
    ).toContain("at least one finding");
  });

  it("does not invent a code suggestion or drop an unavailable selection", async () => {
    const { result, context, plain } = await fixture();
    const draft = setPublicationFinding(
      createPublicationComposer(),
      plain.id,
      true,
      result,
      {},
      "request-changes",
    );
    const invented = {
      ...draft,
      entries: {
        ...draft.entries,
        [plain.feedbackDraft.id]: {
          ...draft.entries[plain.feedbackDraft.id]!,
          mode: "suggestion" as const,
          replacement: "newCode();",
        },
      },
    };
    expect(
      validatePublication(invented, result, context, "request-changes", "")[
        `draft-${plain.feedbackDraft.id}-mode`
      ],
    ).toContain("no saved code suggestion");
    const unavailable = setPublicationFinding(draft, "missing-finding", true, result);
    expect(
      validatePublication(unavailable, result, context, "request-changes", "").selection,
    ).toContain("unavailable");
  });

  it("sends shared finding and independent draft references only once", async () => {
    const { result, context, plain } = await fixture();
    result.feedbackDrafts.push(structuredClone(plain.feedbackDraft));
    const independent = setPublicationIndependentDraft(
      createPublicationComposer(),
      plain.feedbackDraft.id,
      true,
      result,
    );
    const both = setPublicationFinding(independent, plain.id, true, result, {}, "request-changes");
    const payload = materializePublication(both, result, context, "request-changes", "");
    expect(payload.findingIds).toEqual([plain.id]);
    expect(payload.drafts).toHaveLength(1);
    expect(payload.drafts[0]?.id).toBe(plain.feedbackDraft.id);
    const onlyIndependent = setPublicationFinding(both, plain.id, false, result);
    expect(
      materializePublication(onlyIndependent, result, context, "comment", "").drafts,
    ).toHaveLength(1);
    expect(onlyIndependent.entries[plain.feedbackDraft.id]?.findingId).toBeNull();
  });

  it("does not apply the 100-suggestion limit to ordinary text drafts", async () => {
    const { result, context } = await fixture();
    let draft = createPublicationComposer();
    for (let index = 0; index < 101; index += 1) {
      const saved = { id: `plain-extra-${index}`, body: `Short note ${index}.`, suggestion: null };
      result.feedbackDrafts.push(saved);
      draft = setPublicationIndependentDraft(draft, saved.id, true, result);
    }
    expect(validatePublication(draft, result, context, "comment", "")).toEqual({});
    expect(materializePublication(draft, result, context, "comment", "").drafts).toHaveLength(101);
  });

  it("validates UTF-8 transport limits and complete inline bodies without truncating text", async () => {
    const { result, context, suggestion, selection } = await fixture();
    const empty = createPublicationComposer();
    expect(
      validatePublication(empty, result, context, "comment", "界".repeat(20_000)).summary,
    ).toContain("UTF-8");
    const draft = importPublicationSelection(empty, selection, result);
    const draftId = suggestion.feedbackDraft.id;
    const oversized = {
      ...draft,
      entries: {
        ...draft.entries,
        [draftId]: {
          ...draft.entries[draftId]!,
          body: "界".repeat(10_000),
          replacement: "界".repeat(10_000),
        },
      },
    };
    expect(
      validatePublication(oversized, result, context, "request-changes", "")[
        `draft-${draftId}-replacement`
      ],
    ).toContain("60,000-byte");
    expect(oversized.entries[draftId]?.replacement).toHaveLength(10_000);
    const fenced = {
      ...draft,
      entries: {
        ...draft.entries,
        [draftId]: { ...draft.entries[draftId]!, body: "  ", replacement: "```js\nunsafe fence" },
      },
    };
    const errors = validatePublication(fenced, result, context, "request-changes", "");
    expect(errors[`draft-${draftId}-body`]).toContain("Add a comment");
    expect(errors[`draft-${draftId}-replacement`]).toContain("triple-backtick");
  });

  it("rejects overlapping saved ranges and more than 100 inline suggestions", async () => {
    const { result, context, suggestion, selection } = await fixture();
    const duplicate = structuredClone(suggestion);
    duplicate.id = "second-finding";
    duplicate.feedbackDraft.id = "second-draft";
    result.findings.push(duplicate);
    context.suggestionSelectionDefaults.push({
      findingId: duplicate.id,
      draftId: duplicate.feedbackDraft.id,
      valid: true,
      selectedByDefault: false,
      reason: "Saved suggestion is available.",
    });
    const first = importPublicationSelection(createPublicationComposer(), selection, result);
    const both = setPublicationFinding(first, duplicate.id, true, result, {}, "request-changes");
    const overlapErrors = validatePublication(both, result, context, "request-changes", "");
    expect(overlapErrors[`draft-${suggestion.feedbackDraft.id}-mode`]).toContain("overlaps");
    expect(overlapErrors[`draft-${duplicate.feedbackDraft.id}-mode`]).toContain("overlaps");
    let many = first;
    for (let index = 0; index < 100; index += 1) {
      const additional = structuredClone(suggestion);
      additional.id = `additional-finding-${index}`;
      additional.feedbackDraft.id = `additional-draft-${index}`;
      additional.feedbackDraft.suggestion!.path = `src/file-${index}.ts`;
      result.findings.push(additional);
      context.suggestionSelectionDefaults.push({
        findingId: additional.id,
        draftId: additional.feedbackDraft.id,
        valid: true,
        selectedByDefault: false,
        reason: "Saved suggestion is available.",
      });
      many = setPublicationFinding(many, additional.id, true, result, {}, "request-changes");
    }
    expect(validatePublication(many, result, context, "request-changes", "").selection).toContain(
      "at most 100 code suggestions",
    );
  });
});
