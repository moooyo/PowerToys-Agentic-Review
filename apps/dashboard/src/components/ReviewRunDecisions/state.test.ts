import type { ReviewRunDecisionContext, ReviewRunDecisionEvent } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import {
  acceptReviewedDecisionState,
  createDecisionEditor,
  type DecisionAccess,
  decisionActionLabel,
  decisionBindingMatches,
  decisionContextMatchesRun,
  decisionEditorUnavailableReason,
  decisionEventMatchesRun,
  decisionPollingInterval,
  decisionQueryKey,
  decisionReceiptSummary,
  decisionRetryUnavailableReason,
  decisionUnavailableReason,
  prepareDecisionSubmission,
  receiveDecisionFailure,
  reviewDecisionCandidate,
  runDecisionRefreshKey,
} from "./state";

const principal = { issuer: "https://issuer.example", subject: "Reviewer" };
const run = sampleReviewRuns.find((item) => item.workItemKind === "pull_request");
if (!run?.policy.applicable) throw new Error("A pull request sample is required.");
const context: ReviewRunDecisionContext = {
  repositoryId: run.repositoryId,
  reviewRunId: run.id,
  workItemId: run.workItemId,
  workItemKind: "pull_request",
  revisionKey: run.revisionKey,
  currentRevisionKey: run.revisionKey,
  planDigest: run.planDigest,
  resultSetDigest: "c".repeat(64),
  sourceCurrent: true,
  version: 0,
  policy: {
    ...run.policy,
    eligible: true,
    reasonCount: 0,
    reasons: [],
    reasonsTruncated: false,
    blockingFindingCount: 0,
  },
  canApprove: true,
  recordedDecision: null,
  recordedDecisionState: "none",
  stateReasons: [],
};
const event: ReviewRunDecisionEvent = {
  repositoryId: context.repositoryId,
  reviewRunId: context.reviewRunId,
  workItemId: context.workItemId,
  workItemKind: "pull_request",
  revisionKey: context.revisionKey,
  planDigest: context.planDigest,
  resultSetDigest: context.resultSetDigest,
  id: "decision-one",
  changeId: "change-one",
  actor: principal,
  previousVersion: 0,
  version: 1,
  createdAt: "2026-09-07T01:00:00.000Z",
  reason: "Reviewed required checks and the saved evidence.",
  action: "approve",
  targetDecisionId: null,
  supersedesDecisionId: null,
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
const reviewed = {
  ...context,
  version: 1,
  recordedDecision: event,
  recordedDecisionState: "current",
} satisfies ReviewRunDecisionContext;
const access = (role: "viewer" | "reviewer" | "maintainer", actor = principal): DecisionAccess => ({
  principal: actor,
  ready: true,
  checking: false,
  can: (permission) =>
    permission === "read" ||
    (permission === "review" && role !== "viewer") ||
    (permission === "configure" && role === "maintainer"),
});

describe("decision authorization and source boundaries", () => {
  it("requires current verified review access even when policy says approve", () => {
    expect(decisionUnavailableReason("approve", context, access("viewer"))).toContain("Reviewer");
    expect(decisionUnavailableReason("approve", context, access("reviewer"))).toBeNull();
    const can = vi.fn(() => true);
    expect(
      decisionUnavailableReason("approve", context, { ...access("reviewer"), checking: true, can }),
    ).toContain("Checking");
    expect(can).not.toHaveBeenCalled();
    expect(
      decisionUnavailableReason("approve", context, { ...access("reviewer"), ready: false }),
    ).toContain("unavailable");
  });

  it("allows an explicit maintainer exception while ordinary approval remains blocked", () => {
    const blocked = {
      ...context,
      canApprove: false,
      policy: { ...context.policy, eligible: false },
    } satisfies ReviewRunDecisionContext;
    expect(decisionUnavailableReason("approve", blocked, access("maintainer"))).toContain("policy");
    expect(decisionUnavailableReason("override_approve", blocked, access("reviewer"))).toContain(
      "Maintainer",
    );
    expect(decisionUnavailableReason("override_approve", blocked, access("maintainer"))).toBeNull();
    expect(blocked.policy.eligible).toBe(false);
  });

  it.each(["approve", "request_changes", "override_approve"] as const)(
    "withholds new %s on historical sources",
    (action) => {
      expect(
        decisionUnavailableReason(
          action,
          { ...reviewed, sourceCurrent: false },
          access("maintainer"),
        ),
      ).toContain("current source");
    },
  );

  it("permits comments and authorized withdrawal on a historical run", () => {
    const historical = { ...reviewed, sourceCurrent: false };
    expect(decisionUnavailableReason("comment", historical, access("reviewer"))).toBeNull();
    expect(decisionUnavailableReason("withdraw", historical, access("viewer"))).toContain(
      "Reviewer",
    );
    expect(decisionUnavailableReason("withdraw", historical, access("reviewer"))).toBeNull();
    expect(
      decisionUnavailableReason(
        "withdraw",
        historical,
        access("reviewer", { ...principal, subject: "reviewer" }),
      ),
    ).toContain("author");
    expect(
      decisionUnavailableReason(
        "withdraw",
        historical,
        access("maintainer", { ...principal, subject: "other" }),
      ),
    ).toBeNull();
    expect(decisionUnavailableReason("withdraw", context, access("maintainer"))).toContain(
      "no decision",
    );
  });

  it("keeps Issue decisions separate from PR approval", () => {
    const issue: ReviewRunDecisionContext = {
      ...context,
      workItemKind: "issue",
      policy: {
        applicable: false,
        eligible: null,
        policyVersion: "required-checks-and-p0-p1-v1",
        blockingFindingCount: 0,
        reasonCount: 0,
        reasons: [],
        reasonsTruncated: false,
      },
      canApprove: false,
      recordedDecision: null,
    };
    expect(decisionActionLabel("request_changes", "issue")).toBe("Request more information");
    expect(decisionUnavailableReason("request_changes", issue, access("reviewer"))).toBeNull();
    expect(decisionUnavailableReason("approve", issue, access("maintainer"))).toContain("Issue");
    expect(decisionUnavailableReason("override_approve", issue, access("maintainer"))).toContain(
      "Issue",
    );
  });
});

describe("immutable decision intent and explicit fresh review", () => {
  it("freezes the reviewed state before editing and preserves the exact retry payload", () => {
    const source = structuredClone(context);
    const initial = {
      ...createDecisionEditor(source, "comment"),
      reason: "  Keep this observation.  ",
    };
    source.version = 99;
    const createId = vi.fn(() => "intent-one");
    const first = prepareDecisionSubmission(initial, createId);
    expect(first.request).toEqual({
      changeId: "intent-one",
      action: "comment",
      expectedVersion: 0,
      expectedRevisionKey: context.revisionKey,
      expectedPlanDigest: context.planDigest,
      expectedResultSetDigest: context.resultSetDigest,
      reason: "Keep this observation.",
    });
    const failed = receiveDecisionFailure(first, new Error("Response lost"));
    const retry = prepareDecisionSubmission(failed, createId);
    expect(retry.request).toBe(first.request);
    expect(createId).toHaveBeenCalledTimes(1);
    expect(retry.reason).toBe(initial.reason);
  });

  it("permits only an unchanged submitted intent to retrieve its historical receipt", () => {
    const historical = {
      ...context,
      sourceCurrent: false,
      canApprove: false,
      resultSetDigest: "e".repeat(64),
    };
    const draft = prepareDecisionSubmission(
      { ...createDecisionEditor(historical, "approve"), reason: "Previously submitted decision." },
      () => "original",
    );
    expect(decisionUnavailableReason("approve", historical, access("reviewer"))).toContain(
      "current source",
    );
    expect(decisionRetryUnavailableReason(draft, access("reviewer"))).toBeNull();
    expect(decisionRetryUnavailableReason(draft, access("viewer"))).toContain("Reviewer");
    expect(prepareDecisionSubmission(draft).request).toBe(draft.request);
  });

  it("blocks unsubmitted stale drafts but preserves original retries until a definitive conflict", () => {
    const draft = { ...createDecisionEditor(context, "approve"), reason: "Current checks passed." };
    const newer = { ...reviewed, resultSetDigest: "e".repeat(64) };
    expect(decisionEditorUnavailableReason(draft, newer, access("reviewer"))).toContain(
      "reviewed binding changed",
    );
    expect(decisionEditorUnavailableReason(draft, undefined, access("reviewer"))).toContain(
      "Refresh",
    );
    const sent = prepareDecisionSubmission(draft, () => "sent-once");
    expect(decisionEditorUnavailableReason(sent, newer, access("reviewer"))).toBeNull();
    expect(decisionEditorUnavailableReason(sent, undefined, access("reviewer"))).toBeNull();
    expect(
      decisionEditorUnavailableReason({ ...sent, conflict: true }, newer, access("reviewer")),
    ).toContain("after this rejection");
    expect(sent.request?.expectedVersion).toBe(context.version);
    expect(sent.request?.expectedResultSetDigest).toBe(context.resultSetDigest);
  });

  it("never rebases or resubmits a conflicting draft without explicit fresh review", () => {
    const draft = prepareDecisionSubmission(
      { ...createDecisionEditor(context, "approve"), reason: "Required checks passed." },
      () => "intent-old",
    );
    const conflicted = receiveDecisionFailure(
      draft,
      new ReviewControlHttpError("Result set changed", {
        operation: "decision",
        retryable: false,
        status: 409,
      }),
    );
    expect(() => prepareDecisionSubmission(conflicted)).toThrow("Review the latest");
    const current = { ...reviewed, resultSetDigest: "d".repeat(64) };
    const candidate = reviewDecisionCandidate(conflicted, current);
    expect(candidate.request).toBe(draft.request);
    expect(candidate.reviewed).toBe(draft.reviewed);
    expect(candidate.conflict).toBe(true);
    expect(() => prepareDecisionSubmission(candidate)).toThrow("Review the latest");
    const accepted = acceptReviewedDecisionState(candidate);
    expect(accepted.reason).toBe(draft.reason);
    expect(accepted.request).toBeNull();
    expect(accepted.conflict).toBe(false);
    const next = prepareDecisionSubmission(accepted, () => "intent-new");
    expect(next.request?.changeId).toBe("intent-new");
    expect(next.request?.expectedVersion).toBe(1);
    expect(next.request?.expectedResultSetDigest).toBe(current.resultSetDigest);
  });

  it("failed or wrong-scope fresh reads cannot discard a reason or replace a binding", () => {
    const draft = {
      ...createDecisionEditor(reviewed, "comment"),
      reason: "A persistent explanation.",
    };
    expect(() => reviewDecisionCandidate(draft, { ...reviewed, repositoryId: "another" })).toThrow(
      "different run",
    );
    expect(() => acceptReviewedDecisionState(draft)).toThrow("Load and review");
    expect(draft.reason).toBe("A persistent explanation.");
    expect(draft.reviewed.version).toBe(1);
    expect(draft.request).toBeNull();
  });

  it("binds only withdrawal to the exact recorded target", () => {
    const withdrawal = prepareDecisionSubmission(
      {
        ...createDecisionEditor(reviewed, "withdraw"),
        reason: "Reconsider after additional evidence.",
      },
      () => "withdraw-one",
    );
    expect(withdrawal.request).toMatchObject({ action: "withdraw", targetDecisionId: event.id });
    const comment = prepareDecisionSubmission(
      { ...createDecisionEditor(reviewed, "comment"), reason: "More context." },
      () => "comment-one",
    );
    expect(comment.request).not.toHaveProperty("targetDecisionId");
    expect(() =>
      prepareDecisionSubmission({
        ...createDecisionEditor(context, "withdraw"),
        reason: "Missing target.",
      }),
    ).toThrow("no decision");
  });

  it("preserves paragraphs and tabs in a valid explanation", () => {
    const reason = "First paragraph.\r\n\nSecond paragraph.\tEvidence reviewed.";
    const prepared = prepareDecisionSubmission({
      ...createDecisionEditor(context, "comment"),
      reason: `  ${reason}  `,
    });
    expect(prepared.request?.reason).toBe(reason);
  });

  it.each([
    "",
    "   ",
    "x".repeat(2_049),
    "control\u0000character",
    "control\u000bcharacter",
    "control\u0085character",
    "invalid\ud800text",
  ])("rejects unusable reason %j before request creation", (reason) => {
    const createId = vi.fn(() => "not-created");
    expect(() =>
      prepareDecisionSubmission({ ...createDecisionEditor(context, "comment"), reason }, createId),
    ).toThrow("reason");
    expect(createId).not.toHaveBeenCalled();
  });
});

describe("run, actor and receipt isolation", () => {
  it("refreshes connected foreground decisions without retrying errors or reading in the background", () => {
    const active = { mode: "connected" as const, visible: true, canRead: true, hasError: false };
    expect(decisionPollingInterval(active)).toBe(30_000);
    expect(decisionPollingInterval({ ...active, visible: false })).toBe(false);
    expect(decisionPollingInterval({ ...active, canRead: false })).toBe(false);
    expect(decisionPollingInterval({ ...active, hasError: true })).toBe(false);
    expect(decisionPollingInterval({ ...active, mode: "sample" })).toBe(false);
  });

  it("separates repository, run, exact issuer, exact subject and sample caches", () => {
    const base = decisionQueryKey("connected", "repo", "run", principal);
    expect(decisionQueryKey("sample", "repo", "run", principal)).not.toEqual(base);
    expect(decisionQueryKey("connected", "repo-other", "run", principal)).not.toEqual(base);
    expect(decisionQueryKey("connected", "repo", "run-other", principal)).not.toEqual(base);
    expect(
      decisionQueryKey("connected", "repo", "run", { ...principal, subject: "reviewer" }),
    ).not.toEqual(base);
    expect(
      decisionQueryKey("connected", "repo", "run", {
        ...principal,
        issuer: "https://ISSUER.example",
      }),
    ).not.toEqual(base);
  });

  it("refuses neighboring work item or run data even inside the same repository", () => {
    expect(decisionContextMatchesRun(context, run)).toBe(true);
    expect(decisionEventMatchesRun(event, run)).toBe(true);
    for (const field of [
      "repositoryId",
      "reviewRunId",
      "workItemId",
      "revisionKey",
      "planDigest",
    ] as const) {
      expect(decisionContextMatchesRun({ ...context, [field]: "different" }, run)).toBe(false);
      expect(decisionEventMatchesRun({ ...event, [field]: "different" }, run)).toBe(false);
    }
  });

  it("requires another review after a rerun, new stream event, or source change", () => {
    expect(decisionBindingMatches(reviewed, { ...reviewed })).toBe(true);
    expect(decisionBindingMatches(reviewed, { ...reviewed, version: 2 })).toBe(false);
    expect(decisionBindingMatches(reviewed, { ...reviewed, resultSetDigest: "d".repeat(64) })).toBe(
      false,
    );
    expect(decisionBindingMatches(reviewed, { ...reviewed, sourceCurrent: false })).toBe(false);
    expect(
      decisionBindingMatches(reviewed, { ...reviewed, currentRevisionKey: "f".repeat(64) }),
    ).toBe(false);
  });

  it("refreshes decision reads when the displayed run changes without manufacturing the server digest", () => {
    expect(runDecisionRefreshKey(run)).not.toBe(
      runDecisionRefreshKey({ ...run, freshness: "superseded" }),
    );
    expect(runDecisionRefreshKey(run)).not.toContain(context.resultSetDigest);
  });

  it("describes an accepted receipt as historical, not current approval", () => {
    expect(decisionReceiptSummary(event)).toContain("historical receipt");
    expect(decisionReceiptSummary(event)).toContain("refreshed state");
  });
});
