import { describe, expect, it } from "vitest";
import { filterReportFindings, readFindingFilters, reportFindingView } from "./report-findings";
import { createSampleInvestigationApi } from "./sample-adapter";

const unfiltered = { search: "", priority: "all", assessment: "all" } as const;

async function collection() {
  const report = await createSampleInvestigationApi().exportReport("sample-pr-p1-report");
  const first = report.findings[0];
  if (!first) throw new Error("The sample report must include a finding.");
  return Array.from({ length: 26 }, (_, index) => ({
    ...structuredClone(first),
    id: `finding-${index + 1}`,
    ordinal: index,
    title:
      index === 25
        ? "Deletion can remove saved configuration"
        : `Cancellation finding ${index + 1}`,
    priority: index === 25 ? ("P0" as const) : ("P1" as const),
    confirmation: {
      ...first.confirmation,
      status: index === 3 ? ("hypothesis" as const) : ("confirmed" as const),
    },
    feedbackDraft: { ...first.feedbackDraft, id: `feedback-${index + 1}` },
  }));
}

describe("complete report finding navigation", () => {
  it("searches and filters the complete collection, including a P0 beyond page one", async () => {
    const findings = await collection();
    const result = filterReportFindings(findings, {
      ...unfiltered,
      search: "saved configuration",
      priority: "P0",
    });
    expect(result.map((entry) => entry.id)).toEqual(["finding-26"]);
    const view = reportFindingView(findings, unfiltered, "finding-26", "1");
    expect(view.page).toBe(2);
    expect(view.finding?.id).toBe("finding-26");
    expect(view.previous?.id).toBe("finding-25");
    expect(view.next).toBeUndefined();
    expect(findings).toHaveLength(26);
  });

  it("keeps an explicit linked finding readable outside a filter without substituting another", async () => {
    const findings = await collection();
    const view = reportFindingView(
      findings,
      { ...unfiltered, assessment: "hypothesis" },
      "finding-26",
      "2",
    );
    expect(view.matching.map((entry) => entry.id)).toEqual(["finding-4"]);
    expect(view.finding?.id).toBe("finding-26");
    expect(view.outsideFilters).toBe(true);
    expect(view.previous).toBeUndefined();
    expect(view.next).toBeUndefined();
    const missing = reportFindingView(findings, unfiltered, "missing-finding", "1");
    expect(missing.unavailable).toBe(true);
    expect(missing.finding).toBeUndefined();
  });

  it("navigates pages and clamps malformed page input without changing the saved findings", async () => {
    const findings = await collection();
    expect(reportFindingView(findings, unfiltered, null, "2").finding?.id).toBe("finding-26");
    expect(reportFindingView(findings, unfiltered, null, "-1").page).toBe(1);
    expect(reportFindingView(findings, unfiltered, null, "9999").page).toBe(2);
    expect(reportFindingView(findings, unfiltered, null, "1.5").page).toBe(1);
    expect(
      readFindingFilters(
        new URLSearchParams("findingPriority=unknown&findingAssessment=ready&findingSearch=cancel"),
      ),
    ).toEqual({ ...unfiltered, search: "cancel" });
  });
});
