import type { InvestigationActionKind } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { isActionAllowed, materializeFeedback } from "./action-panel";
import { createFeedbackSelection, feedbackSelectionReducer } from "./feedback-selection";
import { ReportDetails } from "./report-detail-panels";
import { ReportDirectoryRow } from "./report-directory";
import { AssessmentPanel, CoveragePanel, FindingCard } from "./report-sections";
import {
  assertActionContext,
  assertFindingsPage,
  assertReportBindings,
  selectionContext,
} from "./report-state";
import { recommendedReportRequest, reportTab } from "./report-workspace";
import { createSampleInvestigationApi } from "./sample-adapter";

describe("structured investigation result UI", () => {
  it("carries report selection into recommended feedback while keeping task actions separate", () => {
    for (const action of ["comment", "approve", "suggestion-comment", "request-changes"] as const) {
      expect(recommendedReportRequest(action, "saved-next-action", true)).toEqual({
        action,
        nextActionId: "saved-next-action",
        importReportSelection: true,
      });
      expect(
        recommendedReportRequest(action, undefined, false).importReportSelection,
      ).toBeUndefined();
    }
    for (const action of ["start-task", "reviews.verify", "merge", "close", "trigger-ci"] as const)
      expect(recommendedReportRequest(action, "saved-next-action", true)).toEqual({
        action,
        nextActionId: "saved-next-action",
      });
  });

  it("keeps approval blocked when the P0 is outside the loaded findings page", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p0-report");
    const page = await api.findings(header.report.id, undefined, 25);
    const context = await api.actionContext(header.context.workItem.id, header.report.id);
    expect(page.items.every((finding) => finding.priority !== "P0")).toBe(true);
    expect(page.total).toBe(26);
    expect(context.hardContentBlockers).toHaveLength(1);
    const state = feedbackSelectionReducer(createFeedbackSelection(selectionContext(context)), {
      type: "clear-selection",
    });
    expect(state.selectedFindings).toHaveLength(0);
    expect(isActionAllowed(context, "approve")).toBe(false);
    expect(isActionAllowed(context, "merge")).toBe(true);
  });

  it("separates recommendation from manual approval for P1, required E2E, and partial reports", async () => {
    const api = createSampleInvestigationApi();
    for (const id of ["sample-pr-p1-report", "sample-pr-partial-report"]) {
      const report = await api.exportReport(id);
      const context = await api.actionContext(report.context.workItem.id, id);
      expect(isActionAllowed(context, "approve")).toBe(true);
    }
    const report = await api.exportReport("sample-pr-p1-report");
    expect(report.assessment.kind).toBe("pr");
    if (report.assessment.kind === "pr")
      expect(report.assessment.e2eAssessment.level).toBe("required");
  });

  it("prepares mixed feedback from selected findings without selecting Request changes", async () => {
    const api = createSampleInvestigationApi();
    const result = await api.exportReport("sample-pr-p1-report");
    const context = await api.actionContext(result.context.workItem.id, result.id);
    const plain = result.findings.find((finding) => finding.feedbackDraft.suggestion === null);
    if (!plain) throw new Error("The mixed feedback fixture omitted its plain finding.");
    let selection = createFeedbackSelection<InvestigationActionKind>(selectionContext(context));
    const initial = materializeFeedback(selection, result, {}, "");
    expect(initial.findingIds).not.toContain(plain.id);
    selection = feedbackSelectionReducer(selection, {
      type: "set-finding",
      finding: { findingId: plain.id, draftId: plain.feedbackDraft.id, suggestionId: null },
      selected: true,
    });
    const payload = materializeFeedback(
      selection,
      result,
      { [plain.feedbackDraft.id]: "Edited independent feedback" },
      "Additional context",
    );
    expect(selection.action).toBe("suggestion-comment");
    expect(payload.findingIds).toHaveLength(2);
    expect(payload.drafts.some((draft) => draft.suggestion !== null)).toBe(true);
    expect(payload.drafts.find((draft) => draft.id === plain.feedbackDraft.id)?.body).toBe(
      "Edited independent feedback",
    );
    selection = feedbackSelectionReducer(selection, {
      type: "set-action",
      action: "request-changes",
    });
    selection = feedbackSelectionReducer(selection, { type: "clear-selection" });
    expect(selection.action).toBe("request-changes");
    expect(materializeFeedback(selection, result, {}, "Manual review").drafts).toEqual([]);
  });

  it("permits preparing a saved plan while keeping unmet execution prerequisites visible", async () => {
    const api = createSampleInvestigationApi();
    const result = await api.exportReport("sample-bug-report");
    const context = await api.actionContext(result.context.workItem.id, result.id);
    const next = context.nextActions.find((action) => action.action === "start-task");
    if (!next) throw new Error("The bug fixture omitted its saved verification plan.");
    const pending = {
      ...next,
      allowed: false,
      canPrepare: true,
      readyToExecute: false,
      guards: [
        {
          code: "prerequisite:source",
          satisfied: false,
          message: "An explicit source commit is required.",
        },
      ],
    };
    expect(
      isActionAllowed({ ...context, nextActions: [pending] }, pending.action, pending.id),
    ).toBe(true);
    expect(pending.readyToExecute).toBe(false);
  });

  it("rejects mismatched report versions, missing totals, and cross-work-item action contexts", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const result = await api.exportReport(header.report.id);
    const page = await api.findings(header.report.id);
    assertReportBindings(header, result);
    assertFindingsPage(header, page);
    expect(() =>
      assertReportBindings(header, {
        ...result,
        report: { ...result.report, version: result.report.version + 1 },
      }),
    ).toThrow();
    expect(() => assertFindingsPage(header, { ...page, total: page.total + 1 })).toThrow();
    const context = await api.actionContext(result.context.workItem.id, result.id);
    expect(() =>
      assertActionContext(header, { ...context, workItemId: "different-work-item" }),
    ).toThrow();
  });

  it("renders Bug and Feature conclusions independently of reproduction and acceptance", async () => {
    const api = createSampleInvestigationApi();
    const bug = await api.exportReport("sample-bug-report");
    const feature = await api.exportReport("sample-feature-report");
    const bugUi = renderToStaticMarkup(<AssessmentPanel assessment={bug.assessment} />);
    const featureUi = renderToStaticMarkup(<AssessmentPanel assessment={feature.assessment} />);
    expect(bugUi).toContain("needs_verification");
    expect(bugUi).toContain("Reproduction");
    expect(bugUi).toContain("not_run");
    expect(featureUi).toContain("ready");
    expect(featureUi).toContain("Acceptance criteria");
    expect(featureUi).not.toContain("does not mean the maintainers have accepted");
  });

  it("renders full finding content and partial coverage without claiming a final success", async () => {
    const api = createSampleInvestigationApi();
    const result = await api.exportReport("sample-pr-partial-report");
    const finding = result.findings[0];
    if (!finding) throw new Error("The partial fixture omitted its finding.");
    const findingUi = renderToStaticMarkup(
      <FindingCard
        finding={finding}
        evidence={result.verificationEvidence}
        selected={false}
        draftBody={finding.feedbackDraft.body}
        suggestionValid={false}
        onSelect={() => {}}
        onDraftChange={() => {}}
      />,
    );
    for (const label of [
      "Trigger &amp; impact",
      "Root cause",
      "Source evidence",
      "Proposed fix",
      "Feedback draft",
    ])
      expect(findingUi).toContain(label);
    const coverage = renderToStaticMarkup(<CoveragePanel report={result.report} />);
    expect(coverage).toContain("Unresolved scope");
    expect(result.report.completeness).toBe("partial");
  });

  it("keeps checkpoint status and full finding counts without inferring a final conclusion", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p0-report");
    const checkpoint = {
      ...header,
      outcome: "completed" as const,
      report: {
        ...header.report,
        delivery: "checkpoint" as const,
        completeness: "partial" as const,
      },
    };
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ReportDirectoryRow header={checkpoint} to="/reports?reportId=saved-report" />
      </MemoryRouter>,
    );
    expect(markup).toContain("Checkpoint");
    expect(markup).toContain("Partial");
    expect(markup).toContain("No final conclusion");
    expect(markup).toContain("Review findings");
    expect(markup).toContain("26 findings");
    expect(markup).not.toContain("Evidence ready");
  });

  it("opens a non-first selected finding with its complete detail immediately", async () => {
    const api = createSampleInvestigationApi();
    const result = await api.exportReport("sample-pr-p0-report");
    const finding = result.findings.at(-1)!;
    const markup = renderToStaticMarkup(
      <FindingCard
        detail
        finding={finding}
        evidence={result.verificationEvidence}
        selected={false}
        draftBody={finding.feedbackDraft.body}
        suggestionValid={false}
        onSelect={() => {}}
        onDraftChange={() => {}}
      />,
    );
    expect(markup).toContain(finding.title);
    expect(markup).toContain("Trigger &amp; impact");
    expect(markup).toContain("Provenance");
    expect(markup).not.toContain("Show finding details");
    expect(markup).toContain(finding.subjectRef);
    expect(markup.match(/type="checkbox"/gu)).toHaveLength(1);
    expect(markup).not.toContain("The sealed report stays unchanged");
  });

  it("opens restored unsaved feedback initially without making cleanliness its expansion state", async () => {
    const result = await createSampleInvestigationApi().exportReport("sample-pr-p1-report");
    const finding = result.findings[0]!;
    const markup = renderToStaticMarkup(
      <FindingCard
        detail
        draftDirty
        finding={finding}
        evidence={result.verificationEvidence}
        selected={false}
        draftBody="Retained edits"
        suggestionValid={false}
        onSelect={() => {}}
        onDraftChange={() => {}}
      />,
    );
    expect(markup).toMatch(/<details[^>]*class="[^"]*report-feedback-editor[^"]*"[^>]*open=""/u);
    expect(markup).toContain("Retained edits");
  });

  it("retains saved plans, exact source context, and sealed accounting in Details", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-bug-report");
    const result = await api.exportReport(header.report.id);
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ReportDetails value={header} result={result} />
      </MemoryRouter>,
    );
    expect(markup).toContain("Saved plans");
    expect(markup).toContain("Exact context and report metadata");
    expect(markup).toContain(header.report.logicalContentDigest);
    expect(markup).toContain(header.context.task.id);
    for (const plan of result.plans)
      expect(markup).toContain(
        plan.title
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#x27;"),
      );
    for (const subject of result.context.subjects) expect(markup).toContain(subject.id);
  });

  it("rejects complete exports with a changed repository, delivery, or omitted collections", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const result = await api.exportReport(header.report.id);
    expect(() =>
      assertReportBindings(header, {
        ...result,
        context: {
          ...result.context,
          repository: { ...result.context.repository, id: "other-repository" },
        },
      }),
    ).toThrow();
    expect(() =>
      assertReportBindings(header, {
        ...result,
        report: {
          ...result.report,
          delivery: result.report.delivery === "final" ? "checkpoint" : "final",
        },
      }),
    ).toThrow();
    expect(() =>
      assertReportBindings(
        {
          ...header,
          report: {
            ...header.report,
            collections: {
              ...header.report.collections,
              artifacts: header.report.collections.artifacts + 1,
            },
          },
        },
        result,
      ),
    ).toThrow();
  });

  it("maps legacy report deep links into the three main sections", () => {
    expect(reportTab("validation")).toBe("evidence");
    expect(reportTab("changes")).toBe("evidence");
    expect(reportTab("coverage")).toBe("details");
    expect(reportTab("plans")).toBe("details");
    expect(reportTab("next-steps")).toBe("findings");
  });
});
