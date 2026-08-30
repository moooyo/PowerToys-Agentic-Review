import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { IssueTriageV1Schema, PrReviewPlanV1Schema } from "./review-results.js";

const validPrReviewPlan = {
  schemaVersion: "PrReviewPlanV1",
  summary: "The change is mostly sound but has one correctness issue.",
  assessment: "request_changes",
  findings: [
    {
      findingId: "finding-1",
      priority: 1,
      title: "Reject an expired lease before accepting the result",
      body: "The completion path does not compare the server time with the lease expiry.",
      path: "apps/server/src/lease-service.ts",
      line: 47,
      endLine: 52,
      confidence: 0.98,
    },
  ],
  requestedRecipeIds: ["server-unit-tests"],
} as const;

const validIssueTriage = {
  schemaVersion: "IssueTriageV1",
  summary: "The report describes a reproducible crash in the launcher.",
  category: "bug",
  priority: 1,
  confidence: 0.91,
  suggestedLabels: ["Product-Launcher", "Issue-Bug"],
  missingInformation: ["Provide the Windows build number."],
  duplicateCandidates: [{ number: 12345, reason: "The stack trace has the same top frame." }],
  requestedRecipeIds: ["launcher-static-analysis"],
} as const;

describe("PrReviewPlanV1Schema", () => {
  it("accepts a bounded review plan with repository-relative locations", () => {
    expect(Value.Check(PrReviewPlanV1Schema, validPrReviewPlan)).toBe(true);
  });

  it("rejects additional fields at the root and finding levels", () => {
    expect(Value.Check(PrReviewPlanV1Schema, { ...validPrReviewPlan, command: "build.cmd" })).toBe(
      false,
    );
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], executable: "cmd.exe" }],
      }),
    ).toBe(false);
  });

  it("rejects absolute paths, invalid lines, and duplicate recipe IDs", () => {
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], path: "C:\\repo\\file.ts" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], line: 0 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        requestedRecipeIds: ["server-unit-tests", "server-unit-tests"],
      }),
    ).toBe(false);
  });
});

describe("IssueTriageV1Schema", () => {
  it("accepts a bounded issue triage result", () => {
    expect(Value.Check(IssueTriageV1Schema, validIssueTriage)).toBe(true);
  });

  it("rejects unknown fields and executable recipe requests", () => {
    expect(
      Value.Check(IssueTriageV1Schema, {
        ...validIssueTriage,
        privateNotes: "not part of the protocol",
      }),
    ).toBe(false);
    expect(
      Value.Check(IssueTriageV1Schema, {
        ...validIssueTriage,
        requestedRecipeIds: ["powershell -Command build"],
      }),
    ).toBe(false);
  });

  it("rejects unbounded collection growth", () => {
    expect(
      Value.Check(IssueTriageV1Schema, {
        ...validIssueTriage,
        missingInformation: Array.from({ length: 33 }, (_, index) => `Question ${index}`),
      }),
    ).toBe(false);
  });
});
