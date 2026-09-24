import type {
  InvestigationNextActionV1,
  InvestigationReportHeaderV1,
} from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutcomeSummary, reportOutcome } from "./outcome-summary";
import { createSampleInvestigationApi } from "./sample-adapter";

async function header(kind: "pr" | "bug" | "feature" = "pr") {
  return createSampleInvestigationApi().report(
    { pr: "sample-pr-p1-report", bug: "sample-bug-report", feature: "sample-feature-report" }[kind],
  );
}

function savedAction(report: InvestigationReportHeaderV1): InvestigationNextActionV1 {
  return {
    id: "saved-feedback-action",
    action: "comment",
    taskKind: null,
    label: "Share saved assessment",
    reason: "Explain the retained evidence before deciding how to proceed.",
    recommended: true,
    subjectRef: report.assessment.subjectRef,
    planRef: null,
    draftRef: null,
    validationReportRef: null,
    prerequisiteRefs: [],
    state: "saved",
    sourceReportRef: { id: report.report.id, version: report.report.version },
  };
}

describe("saved report outcome", () => {
  it.each([
    ["no-blocking-findings", "No blocking findings"],
    ["changes-requested", "Changes needed"],
    ["inconclusive", "Inconclusive"],
  ] as const)(
    "presents the saved PR conclusion %s independently of counts",
    async (status, label) => {
      const report = await header();
      if (report.assessment.kind !== "pr") throw new Error("Expected a PR fixture");
      report.assessment.reviewConclusion = { status, rationale: "The saved review rationale." };
      report.report.collections.findings = status === "no-blocking-findings" ? 12 : 0;
      const result = reportOutcome(report);

      expect(result.label).toBe(label);
      expect(result.description).toBe("The saved review rationale.");
      expect(result.finality).toBe("Final review conclusion");
      expect(result.isFinal).toBe(true);
    },
  );

  it("does not translate a completed review into successful runtime validation", async () => {
    const report = await header();
    if (report.assessment.kind !== "pr") throw new Error("Expected a PR fixture");
    report.assessment.reviewConclusion.status = "no-blocking-findings";
    report.assessment.e2eAssessment.level = "required";
    report.assessment.e2eAssessment.rationale = "Exercise cancellation against the saved revision.";
    report.validation.summary = "No runtime check has run.";

    expect(reportOutcome(report).validation).toEqual({
      label: "E2E required",
      description: "Exercise cancellation against the saved revision.\nNo runtime check has run.",
    });
    const html = renderToStaticMarkup(<OutcomeSummary header={report} compact />);
    expect(html).toContain("No blocking findings");
    expect(html).toContain("No runtime check has run.");
    expect(html).not.toContain("Validation passed");
  });

  it.each([
    ["complete", "checkpoint", "Checkpoint assessment · Not final"],
    ["partial", "checkpoint", "Checkpoint assessment · Not final"],
    ["partial", "final", "Partial assessment · Not final"],
  ] as const)("keeps %s / %s provisional", async (completeness, delivery, finality) => {
    const report = await header();
    if (report.assessment.kind !== "pr") throw new Error("Expected a PR fixture");
    report.report.completeness = completeness;
    report.report.delivery = delivery;
    report.assessment.reviewConclusion.status = "changes-requested";

    expect(reportOutcome(report)).toMatchObject({
      label: "No final conclusion",
      finality,
      isFinal: false,
    });
    expect(reportOutcome(report).description).toContain("Saved assessment: Changes needed.");
  });

  it.each([
    ["confirmed", "Bug confirmed"],
    ["needs_information", "Needs information"],
    ["needs_verification", "Needs verification"],
    ["already_fixed", "Already fixed"],
    ["duplicate", "Duplicate issue"],
    ["not_a_bug", "Not a bug"],
  ] as const)("presents bug triage %s without deriving reproduction", async (status, label) => {
    const report = await header("bug");
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture");
    report.assessment.bugAssessment.status = status;
    report.assessment.bugAssessment.rationale = "The saved triage rationale.";
    report.assessment.reproduction.status = "not_run";
    report.assessment.reproduction.summary = "Reproduction has not been attempted.";

    const result = reportOutcome(report);
    expect(result.label).toBe(label);
    expect(result.description).toBe("The saved triage rationale.");
    expect(result.finality).toBe("Final triage conclusion");
    expect(result.validation.label).toBe("Reproduction: Not run");
    expect(result.validation.description).toContain("Reproduction has not been attempted.");
  });

  it.each([
    ["reproduced", "Reproduced"],
    ["not_reproduced", "Not reproduced"],
    ["not_run", "Not run"],
    ["blocked", "Blocked"],
  ] as const)("distinguishes the reproduction result %s", async (status, label) => {
    const report = await header("bug");
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture");
    report.assessment.reproduction.status = status;
    expect(reportOutcome(report).validation.label).toBe(`Reproduction: ${label}`);
  });

  it.each([
    ["ready", "Ready for implementation"],
    ["needs_information", "Needs information"],
    ["needs_decision", "Needs decision"],
    ["already_supported", "Already supported"],
    ["duplicate", "Duplicate issue"],
    ["not_feasible", "Not feasible"],
  ] as const)(
    "presents feature triage %s without claiming implementation",
    async (status, label) => {
      const report = await header("feature");
      if (report.assessment.kind !== "feature") throw new Error("Expected a feature fixture");
      report.assessment.featureAssessment.status = status;
      report.assessment.summary = "The retained requirements assessment.";
      report.validation.summary = "No implementation or runtime evidence is recorded.";

      expect(reportOutcome(report)).toMatchObject({
        label,
        description: "The retained requirements assessment.",
        validation: {
          label: "Validation",
          description: "No implementation or runtime evidence is recorded.",
        },
      });
    },
  );

  it("retains another issue classification without inventing a bug or feature decision", async () => {
    const report = await header("bug");
    report.assessment = {
      kind: "other_issue",
      subjectRef: report.assessment.subjectRef,
      summary: "A usage question was classified.",
      evidenceRefs: [],
      classification: "Usage question",
      explanation: "The saved issue asks how to configure the current feature.",
    };
    expect(reportOutcome(report)).toMatchObject({
      label: "Usage question",
      description: "The saved issue asks how to configure the current feature.",
      finality: "Final triage conclusion",
    });
  });

  it("shows current controls separately from saved, report-bound next-step reasons", async () => {
    const report = await header();
    const action = savedAction(report);
    const html = renderToStaticMarkup(
      <OutcomeSummary
        header={report}
        actions={<button type="button">Inspect current action guards</button>}
        nextActions={[
          action,
          {
            ...action,
            id: "other-version",
            label: "Wrong version recommendation",
            sourceReportRef: { id: report.report.id, version: report.report.version + 1 },
          },
          {
            ...action,
            id: "other-report",
            label: "Wrong report recommendation",
            sourceReportRef: { id: "another-report", version: report.report.version },
          },
        ]}
      />,
    );

    expect(html).toContain("Inspect current action guards");
    expect(html).toContain(action.label);
    expect(html).toContain(action.reason);
    expect(html).toContain("Assessment details");
    expect(html).not.toContain("Current permissions and prerequisites determine availability.");
    expect(html).not.toContain("Wrong version recommendation");
    expect(html).not.toContain("Wrong report recommendation");
  });

  it("does not manufacture a recommended action from the header collection count", async () => {
    const report = await header();
    report.report.collections.nextActions = 5;
    const html = renderToStaticMarkup(<OutcomeSummary header={report} />);
    expect(html).not.toContain("Next steps");
    expect(html).not.toContain("Prepare request changes");
  });
});
