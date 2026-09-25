import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFeedbackSelection } from "./feedback-selection";
import { createPublicationComposer, setPublicationFinding } from "./publication-composer";
import {
  expandPublicationEditorsForErrors,
  PublicationComposerPanel,
  publicationErrorTarget,
} from "./publication-composer-panel";
import { selectionContext } from "./report-state";
import { createSampleInvestigationApi } from "./sample-adapter";

describe("publication editor accessibility", () => {
  it("routes direct-preview errors to an editable field before selection-wide errors", () => {
    expect(
      publicationErrorTarget({
        selection: "Choose a suggestion.",
        "draft-second-mode": "The source anchor changed.",
      }),
    ).toBe("draft-second-mode");
    expect(publicationErrorTarget({ summary: "Restore the generated summary." })).toBe("summary");
    expect(publicationErrorTarget({ selection: "Select a finding." })).toBe("selection");
  });

  it("presents two publication steps and native labelled selection controls without a compose gate", async () => {
    const api = createSampleInvestigationApi();
    const original = await api.exportReport("sample-pr-p1-report");
    const result = { ...original, findings: original.findings.slice(0, 2) };
    const context = await api.actionContext(result.context.workItem.id, result.id);
    const fieldId = (name: string) => `publication-${encodeURIComponent(name)}`;
    const html = renderToStaticMarkup(
      <PublicationComposerPanel
        action="request-changes"
        context={context}
        result={result}
        draft={createPublicationComposer()}
        reportSelection={createFeedbackSelection(selectionContext(context))}
        editedBodies={{}}
        summary="Requesting changes for the selected findings."
        summaryGenerated={true}
        step="select"
        disabled={false}
        errors={{}}
        fieldId={fieldId}
        onChange={() => {}}
        onSummaryChange={() => {}}
        onUseGeneratedSummary={() => {}}
        onClearError={() => {}}
        onStepChange={() => {}}
      />,
    );
    expect(html).toContain("Select findings");
    expect(html).toContain("Preview");
    expect(html).toContain("Select all");
    expect(html).toContain("Clear selection");
    expect(html).not.toContain("Compose");
    expect(html).not.toContain(">Continue<");
    expect(html).not.toContain('id="publication-summary"');
    for (const finding of result.findings) {
      expect(html).toContain(`id="${fieldId(`include-${finding.feedbackDraft.id}`)}"`);
      expect(html).toContain(finding.title);
    }
    expect(html.match(/type="checkbox"/g)?.length).toBeGreaterThanOrEqual(result.findings.length);
  });

  it("keeps the second editor open while its last error is corrected", () => {
    const initial = new Map([
      ["first-draft", true],
      ["second-draft", false],
    ]);
    const revealed = expandPublicationEditorsForErrors(initial, {
      "draft-second-draft-body": "Add a comment.",
    });
    expect(revealed.get("second-draft")).toBe(true);
    const corrected = expandPublicationEditorsForErrors(revealed, {});
    expect(corrected).toBe(revealed);
    expect(corrected.get("second-draft")).toBe(true);
    expect(corrected.get("first-draft")).toBe(true);
    expect(initial.get("second-draft")).toBe(false);
    const manuallyCollapsed = new Map(corrected).set("second-draft", false);
    expect(expandPublicationEditorsForErrors(manuallyCollapsed, {}).get("second-draft")).toBe(
      false,
    );
  });

  it("keeps publishing labels stable and associates body, mode and replacement errors", async () => {
    const api = createSampleInvestigationApi();
    const result = await api.exportReport("sample-pr-p1-report");
    const context = await api.actionContext(result.context.workItem.id, result.id);
    const finding = result.findings.find((item) => item.feedbackDraft.suggestion !== null);
    if (!finding) throw new Error("Expected a saved suggestion fixture.");
    const draft = setPublicationFinding(
      createPublicationComposer(),
      finding.id,
      true,
      result,
      {},
      "request-changes",
    );
    const key = `draft-${finding.feedbackDraft.id}`;
    const fieldId = (name: string) => `publication-${encodeURIComponent(name)}`;
    const errors = {
      [`${key}-body`]: "Review this changed text.",
      [`${key}-mode`]: "Anchor needs review.",
      [`${key}-replacement`]: "Remove the code fence.",
    };
    const html = renderToStaticMarkup(
      <PublicationComposerPanel
        action="request-changes"
        context={context}
        result={result}
        draft={draft}
        reportSelection={createFeedbackSelection(selectionContext(context))}
        editedBodies={{}}
        summary="Generated review summary."
        summaryGenerated={true}
        step="edit"
        disabled={false}
        errors={errors}
        fieldId={fieldId}
        onChange={() => {}}
        onSummaryChange={() => {}}
        onUseGeneratedSummary={() => {}}
        onClearError={() => {}}
        onStepChange={() => {}}
      />,
    );
    for (const part of ["body", "mode", "replacement"]) {
      expect(html).toContain(`id="${fieldId(`${key}-${part}`)}"`);
      expect(html).toContain(`aria-describedby="${fieldId(`${key}-${part}`)}-helper-text"`);
    }
    const labels = html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? [];
    expect(labels.some((label) => label.includes("comment"))).toBe(true);
    for (const label of labels) expect(label).not.toContain("Review this changed text.");
    expect(html).toContain(finding.feedbackDraft.suggestion!.originalContentDigest);
    expect(html).toContain("Remove the code fence.");
  });

  it("keeps long selections compact and exposes errors inside their finding editor", async () => {
    const api = createSampleInvestigationApi();
    const result = await api.exportReport("sample-pr-p1-report");
    const context = await api.actionContext(result.context.workItem.id, result.id);
    const chosen = result.findings.slice(0, 2);
    expect(chosen).toHaveLength(2);
    let draft = createPublicationComposer();
    for (const finding of chosen)
      draft = setPublicationFinding(draft, finding.id, true, result, {}, "request-changes");
    const fieldId = (name: string) => `publication-${encodeURIComponent(name)}`;
    const render = (errors: Record<string, string>) =>
      renderToStaticMarkup(
        <PublicationComposerPanel
          action="request-changes"
          context={context}
          result={result}
          draft={draft}
          reportSelection={createFeedbackSelection(selectionContext(context))}
          editedBodies={{}}
          summary="Generated review summary."
          summaryGenerated={true}
          step="edit"
          disabled={false}
          errors={errors}
          fieldId={fieldId}
          onChange={() => {}}
          onSummaryChange={() => {}}
          onUseGeneratedSummary={() => {}}
          onClearError={() => {}}
          onStepChange={() => {}}
        />,
      );
    const normal = render({});
    expect(normal.match(/<details\b[^>]*\bopen=""/g)).toHaveLength(1);
    const secondBody = `draft-${chosen[1]!.feedbackDraft.id}-body`;
    const invalid = render({ [secondBody]: "Add a comment." });
    expect(invalid.match(/<details\b[^>]*\bopen=""/g)).toHaveLength(2);
    expect(invalid).toContain(`id="${fieldId(secondBody)}"`);
    expect(invalid).toContain(`aria-describedby="${fieldId(secondBody)}-helper-text"`);
    expect(normal).not.toContain("Report checkboxes");
    expect(normal).not.toContain("not automatically pasted");
    expect(normal).not.toContain("Server preview");
  });
});
