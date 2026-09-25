import type { InvestigationActionKind } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  createPublicationComposer,
  setPublicationFinding,
  setPublicationIndependentDraft,
} from "./publication-composer";
import { generatePublicationSummary } from "./publication-summary";
import { createSampleInvestigationApi } from "./sample-adapter";

async function fixture(reportId = "sample-pr-p1-report") {
  return createSampleInvestigationApi().exportReport(reportId);
}

describe("publication summary", () => {
  it("summarizes only selected findings, prioritizes them, and retains unrun validation", async () => {
    const result = await fixture();
    const first = result.findings[0]!;
    const second = result.findings[1]!;
    first.title = "Cancellation can overwrite saved values";
    second.title = "A retry can duplicate persistence";
    let draft = setPublicationFinding(createPublicationComposer(), second.id, true, result);
    const single = generatePublicationSummary("comment", draft, result);
    expect(single).toContain("P2: A retry can duplicate persistence");
    expect(single).not.toContain(first.title);
    draft = setPublicationFinding(draft, first.id, true, result);
    const summary = generatePublicationSummary("request-changes", draft, result);
    expect(summary).toBe(
      "Requesting changes for 2 findings: P1: Cancellation can overwrite saved values; P2: A retry can duplicate persistence. Recorded validation: 1 not run.",
    );
    expect(draft.selectedFindingIds).toEqual([second.id, first.id]);
    expect(result.findings.map((finding) => finding.id)).toEqual([first.id, second.id]);
  });

  it("uses the current independent draft body and excludes unselected or stale entries", async () => {
    const result = await fixture();
    const saved = result.feedbackDrafts[0]!;
    let draft = setPublicationIndependentDraft(createPublicationComposer(), saved.id, true, result);
    draft = {
      ...draft,
      entries: {
        ...draft.entries,
        [saved.id]: {
          ...draft.entries[saved.id]!,
          body: "Please preserve existing settings on cancellation. The next step is a targeted check.",
        },
      },
    };
    const summary = generatePublicationSummary("comment", draft, result);
    expect(summary).toContain(
      "Review feedback on 1 selected feedback item: Please preserve existing settings on cancellation.",
    );
    expect(summary).not.toContain(saved.body);
    const deselected = setPublicationIndependentDraft(draft, saved.id, false, result);
    expect(generatePublicationSummary("comment", deselected, result)).not.toContain(
      "Please preserve existing settings",
    );
    result.feedbackDrafts = [];
    expect(generatePublicationSummary("comment", draft, result)).not.toContain(
      "Please preserve existing settings",
    );
  });

  it("deduplicates shared drafts and bounds summaries for large selections", async () => {
    const result = await fixture();
    const first = result.findings[0]!;
    first.title = "Preserve cancellation boundaries";
    result.feedbackDrafts.push(structuredClone(first.feedbackDraft));
    let draft = setPublicationFinding(createPublicationComposer(), first.id, true, result);
    draft = setPublicationIndependentDraft(draft, first.feedbackDraft.id, true, result);
    for (let index = 0; index < 6; index += 1) {
      const saved = {
        id: `additional-summary-${index}`,
        body: `Selected note ${index} ${"with supporting detail ".repeat(40)}`,
        suggestion: null,
      };
      result.feedbackDrafts.push(saved);
      draft = setPublicationIndependentDraft(draft, saved.id, true, result);
    }
    const summary = generatePublicationSummary("comment", draft, result);
    expect(summary).toContain("Review feedback on 7 selected feedback items");
    expect(summary.match(/Preserve cancellation boundaries/gu)).toHaveLength(1);
    expect(summary).toContain("5 more selected items");
    expect(summary.length).toBeLessThan(320);
    expect(summary).not.toContain(first.feedbackDraft.body);
  });

  it("uses report assessment for an empty comment and preserves incomplete coverage", async () => {
    const result = await fixture("sample-pr-partial-report");
    const summary = generatePublicationSummary("comment", createPublicationComposer(), result);
    expect(summary).toContain("Synthetic source review is incomplete");
    expect(summary).toContain("Investigation interrupted; report remains partial");
    expect(summary).toContain("1 not run");
    expect(summary).not.toMatch(/approved|tests passed|safe to merge/iu);
    result.assessment.summary = " ";
    expect(generatePublicationSummary("comment", createPublicationComposer(), result)).toContain(
      "Synthetic investigation stopped before full scope coverage",
    );
  });

  it("describes approval intent without manufacturing successful verification", async () => {
    const result = await fixture();
    const summary = generatePublicationSummary("approve", createPublicationComposer(), result);
    expect(summary).toBe("Approving the reviewed revision. Recorded validation: 1 not run.");
    expect(summary).not.toMatch(/tests passed|no blocking findings|safe to merge|approved/iu);
  });

  it("retains hypotheses instead of presenting an unverified issue as confirmed", async () => {
    const result = await fixture("sample-bug-report");
    const finding = result.findings[0]!;
    finding.title = "Settings initialization may fail before opening";
    const draft = setPublicationFinding(createPublicationComposer(), finding.id, true, result);
    const summary = generatePublicationSummary("comment", draft, result);
    expect(summary).toContain("P2 hypothesis: Settings initialization may fail before opening");
    expect(summary).toContain("1 not run");
    expect(summary).not.toContain("confirmed");
  });

  it("reports failed, blocked, unrun, and passed checks without converting them to a verdict", async () => {
    const result = await fixture();
    const template = result.validation.checks[0]!;
    result.validation.checks = (["passed", "blocked", "failed", "not_run"] as const).map(
      (status) => ({ ...template, id: `check-${status}`, status }),
    );
    result.outcome = "blocked";
    result.report.completeness = "partial";
    const summary = generatePublicationSummary("approve", createPublicationComposer(), result);
    expect(summary).toContain("Investigation blocked; report remains partial");
    expect(summary).toContain("recorded validation: 1 failed, 1 blocked, 1 not run, 1 passed");
    expect(summary).not.toMatch(/all checks passed|tests passed|safe to merge/iu);
  });

  it("retains recorded E2E build blockers when there are no ordinary validation checks", async () => {
    const result = await fixture();
    result.validation.checks = [];
    result.outcome = "blocked";
    result.report.completeness = "partial";
    result.report.delivery = "checkpoint";
    result.report.loop.stopReason = "blocked";
    result.context.task.kind = "pr-e2e";
    result.context.e2e = {
      headSha: "a".repeat(40),
      buildIdentity: "isolated-summary-fixture",
      blockers: [
        {
          stage: "build",
          code: "E2E_BUILD_FAILED",
          diagnosticCodes: ["C2653"],
          evidenceRefs: ["isolated-build-evidence"],
        },
      ],
      features: [
        {
          id: "isolated-feature",
          title: "Settings cancellation",
          paths: [],
          scenario: "Cancel before persistence",
          userVisible: true,
          outcome: "not_run",
          assertions: [
            {
              id: "isolated-assertion",
              expected: "Cancellation preserves stored values",
              observed: "Application execution was blocked by the build failure",
              outcome: "not_run",
              evidenceRefs: [],
            },
          ],
          artifactRefs: [],
          limitations: [],
        },
      ],
      cleanup: { confirmed: true, recordedAt: "2026-09-25T00:00:00.000Z", summary: "Fixture" },
    };
    const summary = generatePublicationSummary("approve", createPublicationComposer(), result);
    expect(summary).toContain("E2E build blocked; recorded E2E features: 1 not run");
    expect(summary).not.toContain("passed");
  });

  it("does not infer runtime success from an assessment with no recorded checks", async () => {
    const result = await fixture("sample-feature-report");
    const summary = generatePublicationSummary("comment", createPublicationComposer(), result);
    expect(summary).toContain("maintainer acceptance is a separate decision");
    expect(summary).toContain("No validation checks are recorded");
    expect(summary).not.toMatch(/tests passed|approved|accepted/iu);
  });

  it("preserves technical symbols while condensing selected Markdown feedback", async () => {
    const result = await fixture();
    const finding = result.findings[0]!;
    finding.title = "Preserve C# cache_key when x > 0";
    const saved = result.feedbackDrafts[0]!;
    saved.body = "## Recheck `C#` cache_key when x > 0\n\n```csharp\nthrow new Exception();\n```";
    let draft = setPublicationFinding(createPublicationComposer(), finding.id, true, result);
    draft = setPublicationIndependentDraft(draft, saved.id, true, result);
    const summary = generatePublicationSummary("suggestion-comment", draft, result);
    expect(summary).toContain("Suggested updates for 2 selected feedback items");
    expect(summary).toContain("P1: Preserve C# cache_key when x > 0");
    expect(summary).toContain("Recheck C# cache_key when x > 0");
    expect(summary).not.toContain("throw new Exception");
    expect(summary).not.toContain("##");
  });

  it("provides concise action-specific defaults without a report", () => {
    const actions: Array<InvestigationActionKind | null> = [
      "comment",
      "approve",
      "request-changes",
      "suggestion-comment",
      null,
    ];
    for (const action of actions) {
      const summary = generatePublicationSummary(action, createPublicationComposer());
      expect(summary.trim().length).toBeGreaterThan(0);
      expect(summary).toContain("No investigation report is available");
      expect(summary.length).toBeLessThan(110);
      expect(summary).not.toMatch(/tests passed|no blocking findings|safe to merge/iu);
    }
    expect(generatePublicationSummary("approve", createPublicationComposer())).toContain(
      "Approving the reviewed revision",
    );
  });
});
