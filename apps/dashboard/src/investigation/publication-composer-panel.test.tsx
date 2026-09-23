import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFeedbackSelection } from "./feedback-selection";
import { createPublicationComposer, setPublicationFinding } from "./publication-composer";
import { PublicationComposerPanel } from "./publication-composer-panel";
import { selectionContext } from "./report-state";
import { createSampleInvestigationApi } from "./sample-adapter";

describe("publication editor accessibility", () => {
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
        summary=""
        step="compose"
        disabled={false}
        errors={errors}
        fieldId={fieldId}
        onChange={() => {}}
        onSummaryChange={() => {}}
        onClearError={() => {}}
        onStepChange={() => {}}
      />,
    );
    for (const part of ["body", "mode", "replacement"]) {
      expect(html).toContain(`id="${fieldId(`${key}-${part}`)}"`);
      expect(html).toContain(`aria-describedby="${fieldId(`${key}-${part}`)}-helper-text"`);
    }
    const labels = html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? [];
    expect(labels.some((label) => label.includes("publishing text"))).toBe(true);
    for (const label of labels) expect(label).not.toContain("Review this changed text.");
    expect(html).toContain(finding.feedbackDraft.suggestion!.originalContentDigest);
    expect(html).toContain("Remove the code fence.");
  });
});
