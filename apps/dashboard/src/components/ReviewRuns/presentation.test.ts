import type {
  DashboardValidationOutcomeCounts,
  DashboardValidationPolicy,
  JobState,
  ReviewRunDecisionPolicySnapshot,
  ValidationOutcome,
  ValidationRecommendation,
  ValidationTarget,
  WorkflowKind,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  executionLabel,
  outcomePresentation,
  policyFindingPresentation,
  policyPresentation,
  recommendationLabel,
  requestTargetLabel,
  runBelongsToWorkItem,
  summarizeCheckOutcomes,
} from "./presentation";

const emptyChecks: DashboardValidationOutcomeCounts = {
  passed: 0,
  failed: 0,
  blocked: 0,
  not_run: 0,
  skipped: 0,
  inconclusive: 0,
};

const policy: DashboardValidationPolicy = {
  policyVersion: "required-checks-and-p0-p1-v1",
  applicable: true,
  eligible: true,
  reasons: [],
  reasonCount: 0,
  reasonsTruncated: false,
  blockingFindingCount: 0,
};
const dispositionPolicy: DashboardValidationPolicy = {
  ...policy,
  policyVersion: "required-checks-and-unresolved-p0-p1-v2",
  blockingFindingCount: 4,
  unresolvedBlockingFindingCount: 0,
  findingDispositionDigest: "f".repeat(64),
};

describe("independent review result dimensions", () => {
  it("keeps completed execution, failed checks, model advice, and policy eligibility distinct", () => {
    expect(executionLabel("succeeded")).toBe("Execution complete");
    expect(outcomePresentation("failed")).toEqual({ label: "Failed", tone: "error" });
    expect(recommendationLabel("approve")).toBe("Model suggests approval");
    expect(policyPresentation({ ...policy, eligible: false })).toMatchObject({
      label: "Not eligible",
      tone: "warning",
    });
    expect(executionLabel("succeeded")).not.toMatch(/approv|passed|eligible/i);
    expect(policyPresentation(policy).label).toBe("Eligible");
    expect(policyPresentation(policy).label).not.toMatch(/approv/i);
  });

  it("does not invent a result for a completed execution with no checks or model review", () => {
    expect(executionLabel("succeeded")).toBe("Execution complete");
    expect(summarizeCheckOutcomes(null)).toBe("Checks not available");
    expect(summarizeCheckOutcomes(null)).not.toMatch(/passed/i);
    expect(recommendationLabel(null)).toBe("Not available");
    expect(policyPresentation(null)).toMatchObject({ label: "Not evaluated", tone: "default" });
  });
});

describe("executionLabel", () => {
  it.each([null, undefined])("distinguishes %s execution from queued work", (status) => {
    expect(executionLabel(status)).toBe("Not scheduled");
    expect(executionLabel(status)).not.toBe(executionLabel("queued"));
  });

  it.each<[JobState, string]>([
    ["queued", "Queued"],
    ["retry_waiting", "Queued"],
    ["leased", "Assigned to worker"],
    ["running", "Running"],
    ["cancel_requested", "Cancellation requested"],
    ["stale", "Stale execution"],
    ["failed", "Execution failed"],
    ["dead_letter", "Execution exhausted retries"],
    ["cancelled", "Cancelled"],
  ])("preserves the execution state of %s", (status, label) => {
    const admission =
      status === "queued" || status === "retry_waiting"
        ? {
            state: "admitted" as const,
            attemptBase: 0,
            requestedAt: "2026-09-07T00:00:00.000Z",
            admittedAt: "2026-09-07T00:00:00.000Z",
            timestampBasis: "recorded" as const,
          }
        : null;
    expect(executionLabel(status, admission)).toBe(label);
  });
});

describe("requestTargetLabel", () => {
  it.each<[WorkflowKind, ValidationTarget, string]>([
    ["pr_static_build", "headless", "PR static / build"],
    ["pr_ui", "windows_desktop", "PR UI · Windows UI"],
    ["pr_ui", "web", "PR UI · Web UI"],
    ["issue_triage", "headless", "Issue triage"],
    ["issue_validation", "headless", "Issue validation · Headless"],
    ["issue_validation", "windows_desktop", "Issue validation · Windows UI"],
    ["issue_validation", "web", "Issue validation · Web UI"],
  ])("identifies %s with target %s", (workflow, target, label) => {
    expect(requestTargetLabel(workflow, target)).toBe(label);
  });
});

describe("policyPresentation", () => {
  it.each([null, undefined])("shows a missing policy as not evaluated for %s", (value) => {
    expect(policyPresentation(value)).toEqual({
      label: "Not evaluated",
      tone: "default",
      description: "No automated policy evaluation is available.",
    });
  });

  it("shows issue policy as inapplicable instead of eligible or blocked", () => {
    expect(policyPresentation({ ...policy, applicable: false, eligible: null })).toEqual({
      label: "Not applicable",
      tone: "default",
      description: "Pull request approval policy does not apply to this issue.",
    });
  });

  it("keeps v1 automated policy semantics separate from disposition-aware v2 eligibility", () => {
    expect(policyPresentation(policy).description).toContain("automated policy requirements");
    expect(policyPresentation({ ...policy, eligible: false }).description).toContain(
      "Automated policy requirements are not satisfied",
    );
    const eligible = policyPresentation(dispositionPolicy);
    expect(eligible.label).toBe("Eligible");
    expect(eligible.description).toContain("including recorded finding dispositions");
    expect(eligible.description).toContain("Human approval and publication are separate actions");
    expect(eligible.description).not.toMatch(/automated/i);
    const blocked = policyPresentation({ ...dispositionPolicy, eligible: false });
    expect(blocked.description).toContain("policy reasons and unresolved findings");
    expect(blocked.description).not.toMatch(/automated/i);
  });
});

describe("policy finding counts and disposition binding", () => {
  it("retains the v1 blocking count without inventing a disposition digest or unresolved count", () => {
    const view = policyFindingPresentation({ ...policy, blockingFindingCount: 3 });
    expect(view.counts).toEqual([{ label: "Blocking P0 / P1 findings", value: 3 }]);
    expect(view.dispositionDigest).toBeNull();
    expect(view.description).toContain("does not apply manual finding dispositions");
  });

  it("shows reported findings after all blockers are manually resolved without implying checks passed", () => {
    const view = policyFindingPresentation(dispositionPolicy);
    expect(view.counts).toEqual([
      { label: "Reported P0 / P1 findings", value: 4 },
      { label: "Unresolved P0 / P1 findings", value: 0 },
    ]);
    expect(view.dispositionDigest).toBe(dispositionPolicy.findingDispositionDigest);
    expect(view.description).toContain("open and accepted findings remain unresolved");
    expect(view.description).toContain("dismissed and resolved findings are excluded");
    expect(view.description).toContain("Original findings and check outcomes are unchanged");
    expect(view.description).toContain(
      "Required checks, evidence, and source requirements still apply to PR approval",
    );
  });

  it("uses the policy-provided unresolved count and immutable historical digest", () => {
    const snapshot: ReviewRunDecisionPolicySnapshot = {
      applicable: true,
      eligible: false,
      policyVersion: "required-checks-and-unresolved-p0-p1-v2",
      blockingFindingCount: 7,
      unresolvedBlockingFindingCount: 2,
      findingDispositionDigest: "a".repeat(64),
      reasonCount: 1,
      reasonCodes: ["blocking_findings"],
      reasonCodesTruncated: false,
    };
    expect(policyFindingPresentation(snapshot)).toMatchObject({
      counts: [
        { label: "Reported P0 / P1 findings", value: 7 },
        { label: "Unresolved P0 / P1 findings", value: 2 },
      ],
      dispositionDigest: snapshot.findingDispositionDigest,
    });
  });

  it("does not present Issue finding disposition as approval or reproduction evidence", () => {
    const issue: DashboardValidationPolicy = {
      ...dispositionPolicy,
      applicable: false,
      eligible: null,
    };
    expect(policyPresentation(issue).label).toBe("Not applicable");
    const view = policyFindingPresentation(issue);
    expect(view.counts).toHaveLength(2);
    expect(view.description).toContain("do not establish an Issue reproduction conclusion");
    expect(view.description).not.toContain("apply to PR approval");
  });
});

describe("recommendationLabel", () => {
  it.each([null, undefined])("does not infer model advice from %s", (value) => {
    expect(recommendationLabel(value)).toBe("Not available");
  });

  it.each<[ValidationRecommendation, string]>([
    ["approve", "Model suggests approval"],
    ["comment", "Model suggests a comment"],
    ["request_changes", "Model suggests changes"],
    ["needs_human_review", "Model requests human review"],
  ])("attributes %s to the model", (recommendation, label) => {
    expect(recommendationLabel(recommendation)).toBe(label);
  });
});

describe("check outcome presentation", () => {
  it.each<[ValidationOutcome, string, string]>([
    ["passed", "Passed", "success"],
    ["failed", "Failed", "error"],
    ["blocked", "Blocked", "warning"],
    ["not_run", "Not run", "default"],
    ["skipped", "Skipped", "default"],
    ["inconclusive", "Inconclusive", "warning"],
  ])("keeps %s distinct", (outcome, label, tone) => {
    expect(outcomePresentation(outcome)).toEqual({ label, tone });
  });

  it.each([null, undefined])(
    "keeps absent checks distinct from a reported empty set for %s",
    (value) => {
      expect(summarizeCheckOutcomes(value)).toBe("Checks not available");
      expect(summarizeCheckOutcomes(emptyChecks)).toBe(
        "0 passed · 0 failed · 0 blocked · 0 not run · 0 skipped · 0 inconclusive",
      );
    },
  );

  it("reports every outcome count without treating non-failures as passes", () => {
    expect(
      summarizeCheckOutcomes({
        passed: 1,
        failed: 2,
        blocked: 3,
        not_run: 4,
        skipped: 5,
        inconclusive: 6,
      }),
    ).toBe("1 passed · 2 failed · 3 blocked · 4 not run · 5 skipped · 6 inconclusive");
  });
});

describe("runBelongsToWorkItem", () => {
  const scope = { repositoryId: "repo-one", id: "item-one" };

  it("accepts only a run matching both repository and work item", () => {
    expect(runBelongsToWorkItem({ repositoryId: "repo-one", workItemId: "item-one" }, scope)).toBe(
      true,
    );
  });

  it.each([
    { repositoryId: "repo-two", workItemId: "item-one" },
    { repositoryId: "repo-one", workItemId: "item-two" },
    { repositoryId: "repo-two", workItemId: "item-two" },
  ])("rejects a run outside the current scope: %j", (run) => {
    expect(runBelongsToWorkItem(run, scope)).toBe(false);
  });
});
