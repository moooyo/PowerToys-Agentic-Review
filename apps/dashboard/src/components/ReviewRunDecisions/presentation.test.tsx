import type { ReviewRunDecisionContext, ReviewRunDecisionEvent } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CurrentDecision, DecisionBinding, DecisionEvent } from "./presentation";

vi.mock("@mui/material", async () => {
  const { materialComponents } = await import("../FindingReview/material.testing");
  return { ...materialComponents };
});
vi.mock(
  "@/components/ui",
  async () => (await import("../FindingReview/material.testing")).materialUiHelpers,
);
vi.mock("@mui/icons-material/ExpandMore", () => ({ default: () => null }));
vi.mock("@mui/icons-material/ContentCopy", () => ({ default: () => null }));

const event: ReviewRunDecisionEvent = {
  repositoryId: "repository-one",
  reviewRunId: "review-run-one",
  workItemId: "work-item-one",
  workItemKind: "pull_request",
  revisionKey: "a".repeat(64),
  planDigest: "b".repeat(64),
  resultSetDigest: "c".repeat(64),
  id: "decision-one",
  changeId: "change-one",
  actor: { issuer: "https://exact-issuer.example/tenant", subject: "CaseSensitiveSubject" },
  previousVersion: 6,
  version: 7,
  createdAt: "2026-09-07T01:00:00.000Z",
  reason: "The recorded reason belongs to this exact result set.",
  action: "approve",
  targetDecisionId: null,
  supersedesDecisionId: "earlier-decision",
  policyAtDecision: {
    applicable: true,
    eligible: true,
    policyVersion: "required-checks-and-p0-p1-v1",
    blockingFindingCount: 0,
    reasonCount: 0,
    reasonCodes: [],
    reasonCodesTruncated: false,
  },
};
const context: ReviewRunDecisionContext = {
  repositoryId: event.repositoryId,
  reviewRunId: event.reviewRunId,
  workItemId: event.workItemId,
  workItemKind: "pull_request",
  revisionKey: event.revisionKey,
  currentRevisionKey: "d".repeat(64),
  planDigest: event.planDigest,
  resultSetDigest: "e".repeat(64),
  sourceCurrent: false,
  version: 8,
  policy: {
    applicable: true,
    eligible: false,
    policyVersion: "required-checks-and-p0-p1-v1",
    blockingFindingCount: 1,
    reasonCount: 1,
    reasons: [{ code: "required_check_failed" }],
    reasonsTruncated: false,
  },
  canApprove: false,
  recordedDecision: event,
  recordedDecisionState: "stale",
  stateReasons: ["result_set_changed", "source_not_current"],
};

describe("decision event presentation", () => {
  it("attributes a historical entry to its exact principal and immutable binding", () => {
    const html = renderToStaticMarkup(<DecisionEvent event={event} />);
    for (const value of [
      event.reason,
      event.actor.issuer,
      event.actor.subject,
      event.id,
      event.changeId,
      event.repositoryId,
      event.workItemId,
      event.reviewRunId,
      event.revisionKey,
      event.planDigest,
      event.resultSetDigest,
    ])
      expect(html).toContain(value);
    expect(html).toContain("Recorded by · subject");
    expect(html).toContain("Recorded by · issuer");
    expect(html).toContain("Version 7");
    expect(html).toContain("6 → 7");
    expect(html).toContain("earlier-decision");
    expect(html).toContain("Policy eligibility at recording</dt><dd>Eligible");
    expect(html).toContain("Blocking P0 / P1 findings at recording</dt><dd>0");
    expect(html).not.toContain("Unresolved P0 / P1 findings at recording");
    expect(html).not.toContain("Finding disposition digest at recording");
  });

  it("preserves v2 reported counts and the historical disposition snapshot after manual closure", () => {
    const recorded: ReviewRunDecisionEvent = {
      ...event,
      policyAtDecision: {
        ...event.policyAtDecision,
        policyVersion: "required-checks-and-unresolved-p0-p1-v2",
        blockingFindingCount: 5,
        unresolvedBlockingFindingCount: 0,
        findingDispositionDigest: "f".repeat(64),
      },
    };
    const html = renderToStaticMarkup(<DecisionEvent event={recorded} />);
    expect(html).toContain("Policy eligibility at recording</dt><dd>Eligible");
    expect(html).toContain("Reported P0 / P1 findings at recording</dt><dd>5");
    expect(html).toContain("Unresolved P0 / P1 findings at recording</dt><dd>0");
    expect(html).toContain("Finding disposition digest at recording");
    expect(html).toContain("f".repeat(64));
    expect(html).toContain("open and accepted findings remain unresolved");
    expect(html).toContain("dismissed and resolved findings are excluded");
    expect(html).toContain("Required checks, evidence, and source requirements still apply");
    expect(html).not.toContain("Blocking P0 / P1 findings at recording");
  });

  it("labels an override as a human exception while retaining the failed policy snapshot", () => {
    const override: ReviewRunDecisionEvent = {
      ...event,
      action: "override_approve",
      policyAtDecision: {
        ...event.policyAtDecision,
        eligible: false,
        blockingFindingCount: 2,
        reasonCount: 4,
        reasonCodes: ["required_check_failed", "evidence_missing"],
        reasonCodesTruncated: true,
      },
    };
    const html = renderToStaticMarkup(<DecisionEvent event={override} />);
    expect(html).toContain("Approval with exception");
    expect(html).toContain("Explicit human override");
    expect(html).toContain("Validation checks, findings, and policy eligibility are unchanged");
    expect(html).toContain("Policy eligibility at recording</dt><dd>Not eligible");
    expect(html).toContain("Blocking P0 / P1 findings at recording</dt><dd>2");
    expect(html).toContain("Policy reasons at recording</dt><dd>4");
    expect(html).toContain("required_check_failed, evidence_missing (bounded preview)");
  });

  it("shows the withdrawal target and original event binding without implying approval", () => {
    const withdrawal: ReviewRunDecisionEvent = {
      ...event,
      action: "withdraw",
      targetDecisionId: "withdrawn-decision",
    };
    const html = renderToStaticMarkup(<DecisionEvent event={withdrawal} />);
    expect(html).toContain("Withdraw decision");
    expect(html).toContain("Withdrawal target</dt><dd><div>withdrawn-decision");
    expect(html).toContain(event.resultSetDigest);
    expect(html).not.toContain("Explicit human override");
  });

  it("uses an Issue information request label and inapplicable policy", () => {
    const issue: ReviewRunDecisionEvent = {
      ...event,
      workItemKind: "issue",
      action: "request_changes",
      policyAtDecision: { ...event.policyAtDecision, applicable: false, eligible: null },
    };
    const html = renderToStaticMarkup(<DecisionEvent event={issue} />);
    expect(html).toContain("Request more information");
    expect(html).toContain("Policy eligibility at recording</dt><dd>Not applicable");
    expect(html).not.toContain("Request changes");
    expect(html).not.toContain("Approve");
  });

  it("renders actor-supplied reasoning as text rather than active markup", () => {
    const html = renderToStaticMarkup(
      <DecisionEvent event={{ ...event, reason: "<script>window.externalWrite()</script>" }} />,
    );
    expect(html).toContain("&lt;script&gt;window.externalWrite()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("current decision and policy presentation", () => {
  it("keeps a historical v1 approval separate from the current v2 finding state", () => {
    const current: ReviewRunDecisionContext = {
      ...context,
      policy: {
        ...context.policy,
        policyVersion: "required-checks-and-unresolved-p0-p1-v2",
        blockingFindingCount: 4,
        unresolvedBlockingFindingCount: 1,
        findingDispositionDigest: "9".repeat(64),
      },
    };
    const html = renderToStaticMarkup(
      <>
        <CurrentDecision context={current} />
        <DecisionBinding context={current} />
      </>,
    );
    expect(html).toContain("Blocking P0 / P1 findings at recording</dt><dd>0");
    expect(html).toContain("Reported P0 / P1 findings in current policy</dt><dd>4");
    expect(html).toContain("Unresolved P0 / P1 findings in current policy</dt><dd>1");
    expect(html).toContain("Current finding disposition digest");
    expect(html).toContain("9".repeat(64));
    expect(html).toContain("required-checks-and-p0-p1-v1");
    expect(html).toContain("required-checks-and-unresolved-p0-p1-v2");
    expect(html).not.toContain("Unresolved P0 / P1 findings at recording");
    expect(html).not.toContain("Finding disposition digest at recording");
  });

  it("does not replace the recorded v2 disposition digest with the current digest", () => {
    const current: ReviewRunDecisionContext = {
      ...context,
      policy: {
        ...context.policy,
        policyVersion: "required-checks-and-unresolved-p0-p1-v2",
        blockingFindingCount: 5,
        unresolvedBlockingFindingCount: 2,
        findingDispositionDigest: "8".repeat(64),
      },
      recordedDecision: {
        ...event,
        policyAtDecision: {
          ...event.policyAtDecision,
          policyVersion: "required-checks-and-unresolved-p0-p1-v2",
          blockingFindingCount: 5,
          unresolvedBlockingFindingCount: 0,
          findingDispositionDigest: "7".repeat(64),
        },
      },
    };
    const html = renderToStaticMarkup(
      <>
        <CurrentDecision context={current} />
        <DecisionBinding context={current} />
      </>,
    );
    expect(html).toContain("Unresolved P0 / P1 findings at recording</dt><dd>0");
    expect(html).toContain("Unresolved P0 / P1 findings in current policy</dt><dd>2");
    expect(html).toContain(
      `Finding disposition digest at recording</dt><dd><div>${"7".repeat(64)}`,
    );
    expect(html).toContain(`Current finding disposition digest</dt><dd><div>${"8".repeat(64)}`);
  });

  it("distinguishes the latest result binding from the earlier approval snapshot", () => {
    const html = renderToStaticMarkup(
      <>
        <CurrentDecision context={context} />
        <DecisionBinding context={context} />
      </>,
    );
    expect(html).toContain("Earlier decision · review again");
    expect(html).toContain("The execution result set has changed since this decision");
    expect(html).toContain(
      "This run&#x27;s source or execution authorization is no longer current",
    );
    expect(html).toContain("Policy eligibility at recording</dt><dd>Eligible");
    expect(html).toContain("Current policy eligibility</dt><dd>Not eligible");
    expect(html).toContain(event.resultSetDigest);
    expect(html).toContain(context.resultSetDigest);
    expect(html).toContain(context.currentRevisionKey);
    expect(html).toContain("Source and execution authorization current</dt><dd>No");
    expect(html).toContain("Decision stream version</dt><dd>8");
  });

  it("does not turn an old approval into a currently eligible approval", () => {
    const html = renderToStaticMarkup(
      <CurrentDecision
        context={{
          ...context,
          recordedDecisionState: "ineligible",
          stateReasons: ["approval_policy_not_satisfied"],
        }}
      />,
    );
    expect(html).toContain("Approval no longer eligible");
    expect(html).toContain("The current validation policy does not permit approval");
    expect(html).not.toContain("Current recorded decision");
  });

  it("keeps comments in history without describing them as a decision", () => {
    const html = renderToStaticMarkup(
      <CurrentDecision
        context={{
          ...context,
          recordedDecision: null,
          recordedDecisionState: "none",
          stateReasons: [],
        }}
      />,
    );
    expect(html).toContain("No decision recorded");
    expect(html).toContain("Comments are retained in history and do not replace a decision");
    expect(html).not.toContain(event.id);
  });

  it("shows a withdrawal tombstone with its target rather than resurrecting the earlier approval", () => {
    const withdrawal: ReviewRunDecisionEvent = {
      ...event,
      action: "withdraw",
      targetDecisionId: "withdrawn-decision",
    };
    const html = renderToStaticMarkup(
      <CurrentDecision
        context={{
          ...context,
          recordedDecision: withdrawal,
          recordedDecisionState: "withdrawn",
          stateReasons: [],
        }}
      />,
    );
    expect(html).toContain("Decision withdrawn");
    expect(html).toContain("withdrawn-decision");
    expect(html).not.toContain("Current recorded decision");
  });
});
