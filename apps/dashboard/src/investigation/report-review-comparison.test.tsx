import {
  createInvestigationPreview,
  type InvestigationResultV1,
  type InvestigationReviewDisposition,
} from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ReviewComparisonPanel } from "./report-sections";

function comparisonFixture(): InvestigationResultV1 {
  const result = createInvestigationPreview("pr", { findingCount: 2 }).result;
  const subject = result.context.subjects[0];
  if (subject?.kind !== "original_pr") throw new Error("The fixture requires a PR subject.");
  const dispositions: InvestigationReviewDisposition[] = [
    "still_present",
    "fixed",
    "not_confirmed",
    "unverified",
    "pending",
  ];
  result.context.reviewBaseline = {
    reportRef: { id: "prior-report:1", version: 3, digest: "a".repeat(64) },
    sourceTaskId: "prior-task",
    subject: {
      ...subject,
      id: "prior-subject",
      revisionKey: "8".repeat(64),
      headSha: "8".repeat(40),
    },
    findings: dispositions.map((_, index) => ({
      id: `old-finding-${index + 1}`,
      version: 1,
      title: `Previous problem ${index + 1}`,
    })),
  };
  const evidence = result.verificationEvidence.find((entry) => entry.source === "static_analysis");
  if (!evidence) throw new Error("The fixture requires current static evidence.");
  result.report.loop.candidates[0] = {
    ...result.report.loop.candidates[0]!,
    discoveredRound: 0,
    reviewBaselineFindingRef: { id: "old-finding-1", version: 1 },
    reviewDisposition: "still_present",
    rationale: "The current source still commits after cancellation.",
  };
  for (let index = 1; index < dispositions.length; index += 1) {
    const disposition = dispositions[index]!;
    result.report.loop.candidates.push({
      id: `comparison-candidate-${index}`,
      subjectRef: subject.id,
      title: `Previous problem ${index + 1}`,
      discoveredRound: 0,
      status: disposition === "pending" ? "pending" : "withdrawn",
      findingId: null,
      findingVersion: null,
      mergedIntoCandidateId: null,
      reviewBaselineFindingRef: { id: `old-finding-${index + 1}`, version: 1 },
      reviewDisposition: disposition,
      rationale:
        disposition === "pending" ? "" : `Recorded current-source ${disposition} rationale.`,
      evidenceRefs: disposition === "pending" ? [] : [evidence.id],
    });
  }
  result.findings[1]!.title = "New cancellation path";
  result.report.limitations.push({
    id: "comparison-limitation",
    description: "The current source does not establish the remaining path.",
    impact: "Previous problem 4 remains unverified.",
    evidenceRefs: [evidence.id],
  });
  result.outcome = "interrupted";
  result.report.completeness = "partial";
  return result;
}

const render = (result: InvestigationResultV1) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ReviewComparisonPanel result={result} />
    </MemoryRouter>,
  );

describe("report re-review comparison", () => {
  it("keeps ordinary report presentation unchanged", () => {
    expect(render(createInvestigationPreview("pr").result)).toBe("");
  });

  it("shows all previous outcomes and new finding links without calling static fixes runtime passes", () => {
    const result = comparisonFixture();
    const html = render(result);
    expect(html).toContain("Re-review of previous report");
    expect(html).toContain("Saved version");
    expect(html).toContain("8".repeat(40));
    expect(html).toContain("b".repeat(40));
    expect(html).toContain("Fixed in reviewed code: 1");
    expect(html).toContain("Still present: 1");
    expect(html).toContain("Earlier conclusion not confirmed: 1");
    expect(html).toContain("Unverified: 1");
    expect(html).toContain("Pending: 1");
    expect(html).toContain("New findings: 1");
    for (let index = 1; index <= 5; index += 1) expect(html).toContain(`Previous problem ${index}`);
    expect(html).toContain("The current source still commits after cancellation.");
    expect(html).toContain("No completed re-review rationale was recorded.");
    expect(html).toContain("not a runtime test result");
    expect(html).toContain("not counted as a fix");
    expect(html).toContain('href="/reports?reportId=prior-report%3A1"');
    expect(html).toContain('href="/reports?reportId=prior-report%3A1&amp;findingId=old-finding-1"');
    expect(html).toContain(`findingId=${result.findings[1]!.id}`);
    expect(html).toContain("New cancellation path");
  });

  it("reports a missing previous candidate as pending instead of inferring a fix", () => {
    const result = comparisonFixture();
    result.report.loop.candidates = result.report.loop.candidates.filter(
      (candidate) => candidate.reviewDisposition !== "fixed",
    );
    const html = render(result);
    expect(html).toContain("Fixed in reviewed code: 0");
    expect(html).toContain("Pending: 2");
    expect(html).toContain("Previous problem 2");
  });
});
