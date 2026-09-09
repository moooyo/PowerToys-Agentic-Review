import type {
  DashboardReviewRunDetail,
  DashboardReviewRunResult,
  DashboardValidationPolicy,
  ReviewRunDecisionEvent,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  type PublicationRenderInput,
  publicationIdentity,
  renderPublication,
} from "./publication-renderer.js";

// Renderer fixtures contain only its typed data dependencies. Storage admission and relational
// integrity use production migrations and immutable result fixtures in publications.test.ts.
function input(): PublicationRenderInput {
  const policy = {
    policyVersion: "required-checks-and-unresolved-p0-p1-v2",
    applicable: true,
    eligible: false,
    reasons: [
      {
        code: "required_check_failed",
        requestId: "request-1",
        checkId: "profile:compile",
        outcome: "failed",
        reason: "Compilation failed with a type mismatch.",
      },
    ],
    reasonCount: 1,
    reasonsTruncated: false,
    blockingFindingCount: 1,
    unresolvedBlockingFindingCount: 1,
    findingDispositionDigest: "d".repeat(64),
  } as DashboardValidationPolicy;
  const decision = {
    id: "decision-1",
    action: "override_approve",
    reason: "Accept the explicit limitation for this revision.",
    version: 1,
    workItemKind: "pull_request",
    resultSetDigest: "f".repeat(64),
  } as ReviewRunDecisionEvent;
  const detail = {
    id: "run-1",
    repository: "example/project",
    number: 1,
    revisionKey: "a".repeat(64),
    planDigest: "b".repeat(64),
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    requests: [
      {
        requestId: "request-1",
        workflowKind: "pr_static_build",
        target: "headless",
        required: true,
        latestJob: { status: "succeeded" },
        blockers: [],
        blockersTruncated: false,
      },
    ],
  } as unknown as DashboardReviewRunDetail;
  const result = {
    id: "result-1",
    requestId: "request-1",
    resultDigest: "c".repeat(64),
    evidenceComplete: true,
    report: {
      workItemKind: "pull_request",
      summary: "The compilation attempt failed.",
      sourceState: "original",
      checks: [
        {
          id: "profile:compile",
          name: "Compile",
          kind: "build",
          required: true,
          outcome: "failed",
          summary: "The compiler rejected the original source.",
          expected: "Compilation succeeds.",
          actual: "Type mismatch at line 7.",
          evidenceIds: ["evidence-1"],
          source: "runner",
        },
      ],
    },
    execution: {
      blockers: [
        { phase: "build", code: "BUILD_FAILED", message: "A required build check failed." },
      ],
    },
    modelReview: {
      state: "completed",
      recommendation: "request_changes",
      summary: "Inspect the type mismatch.",
      findings: Array.from({ length: 12 }, (_, index) => ({
        id: `finding-${index}`,
        priority: index === 11 ? 1 : 2,
        title: `Finding ${index}`,
        body: `Full finding body ${index}.`,
      })),
      observations: [],
      reproductionConclusion: null,
    },
  } as unknown as DashboardReviewRunResult;
  return {
    publicationId: publicationIdentity("repository-1", "run-1", "decision-1"),
    detail,
    decision,
    policy,
    results: [result],
  };
}

describe("publication renderer", () => {
  it("preserves required failure, all policy reasons and findings after the Dashboard preview limit", () => {
    const fixture = input();
    const output = renderPublication(fixture);
    expect(output?.payload).toMatchObject({
      kind: "pull_request_review",
      event: "COMMENT",
      commitId: "b".repeat(40),
    });
    expect(output?.payload.body).toContain("Qualified approval exception");
    expect(output?.payload.body).toContain("profile:compile: failed; required");
    expect(output?.payload.body).toContain("Compilation failed with a type mismatch.");
    expect(output?.payload.body).toContain("Full finding body 11.");
    expect(output?.payload.body).toContain("A required build check failed.");
    expect(output?.payloadSha256).toBe(sha256(canonicalJson(output?.payload)));
    expect(renderPublication(fixture)).toEqual(output);
  });
  it("rejects an oversized report instead of omitting required failures or late findings", () => {
    const fixture = input();
    const result = fixture.results[0];
    if (!result) throw new Error("The renderer fixture requires a result.");
    result.report.summary = "x".repeat(60_000);
    expect(renderPublication(fixture)).toBeNull();
  });
  it("rejects policy projections that truncated their blocking reasons", () => {
    const fixture = input();
    fixture.policy.reasonsTruncated = true;
    expect(renderPublication(fixture)).toBeNull();
  });
  it("uses stable identity scoped to the exact selected event and prevents source marker forgery", () => {
    expect(publicationIdentity("repo-a", "run", "decision")).not.toBe(
      publicationIdentity("repo-b", "run", "decision"),
    );
    expect(publicationIdentity("repo", "run", "decision-1")).not.toBe(
      publicationIdentity("repo", "run", "decision-2"),
    );
    const fixture = input();
    fixture.decision.reason = "<!-- forged-publication-marker -->";
    const output = renderPublication(fixture);
    expect(output?.payload.body).toContain("&lt;!-- forged-publication-marker --&gt;");
    expect(output?.payload.body.match(/<!--/gu)).toHaveLength(1);
  });
  it("publishes an Issue decision as a comment while distinguishing measured and model conclusions", () => {
    const fixture = input();
    fixture.decision = {
      ...fixture.decision,
      workItemKind: "issue",
      action: "comment",
    } as ReviewRunDecisionEvent;
    const result = fixture.results[0];
    if (!result) throw new Error("The renderer fixture requires a result.");
    result.report = {
      ...result.report,
      workItemKind: "issue",
      reproductionConclusion: "inconclusive",
    };
    result.modelReview.reproductionConclusion = "confirmed";
    const output = renderPublication(fixture);
    expect(output?.payload.kind).toBe("issue_comment");
    expect(output?.payload.body).toContain("Measured reproduction conclusion: inconclusive");
    expect(output?.payload.body).toContain("Model reproduction advice: confirmed");
  });
});
