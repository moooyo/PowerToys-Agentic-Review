import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { DashboardJobDetailReadSchema, DashboardJobReadQuerySchema } from "./dashboard.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const baseJob = {
  id: "job-1",
  workItemId: "item-1",
  workItemRef: "microsoft/PowerToys#1",
  title: "PR review",
  generation: 1,
  status: "succeeded",
  phase: null,
  attempt: 1,
  maxAttempts: 3,
  workerNodeId: null,
  leaseGeneration: null,
  leaseExpiresAt: null,
  progressUpdatedAt: null,
  elapsedSeconds: 12,
  targetRevisionKey: "revision-1",
  outcome: "success",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:01:00.000Z",
  failureCode: null,
  failureMessage: null,
  resultDigest: "a".repeat(64),
} as const;

describe("dashboard job detail contract", () => {
  const baseReviewResult = {
    reviewResultId: "result-1",
    schemaId: "PrReviewPlanV1",
    resultDigest: "a".repeat(64),
    summary: "Looks good.",
    requestedRecipeIds: ["pull-request-review"],
    createdAt: "2026-09-05T00:01:30.000Z",
    prReview: {
      assessment: "comment",
      findings: [
        {
          findingId: "f-1",
          ordinal: 0,
          title: "Keep contract strict",
          body: "The route should reject invalid params.",
          path: "apps/server/src/routes/dashboard.ts",
          line: 120,
          endLine: 121,
          priority: 1,
          confidence: 0.8,
        },
      ],
    },
    issueTriage: null,
  } as const;

  it("accepts a structured review result payload", () => {
    const response = {
      ...baseJob,
      reviewResult: baseReviewResult,
    };

    expect(Value.Check(DashboardJobDetailReadSchema, response)).toBe(true);
  });

  it("rejects legacy raw resultJson and out-of-contract review result limits", () => {
    expect(
      Value.Check(DashboardJobDetailReadSchema, {
        ...baseJob,
        reviewResult: {
          ...baseReviewResult,
          resultJson: "{}",
        },
      }),
    ).toBe(false);

    expect(
      Value.Check(DashboardJobDetailReadSchema, {
        ...baseJob,
        reviewResult: {
          ...baseReviewResult,
          requestedRecipeIds: Array.from({ length: 33 }, (_value, index) => `recipe-${index}`),
        },
      }),
    ).toBe(false);

    expect(
      Value.Check(DashboardJobDetailReadSchema, {
        ...baseJob,
        reviewResult: {
          ...baseReviewResult,
          prReview: {
            ...baseReviewResult.prReview,
            findings: [
              {
                ...baseReviewResult.prReview.findings[0],
                line: 10_000_001,
              },
            ],
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects non-object reviewResult payloads", () => {
    expect(
      Value.Check(DashboardJobDetailReadSchema, {
        ...baseJob,
        reviewResult: "invalid",
      }),
    ).toBe(false);
  });

  it("enforces strict job path parameters", () => {
    expect(Value.Check(DashboardJobReadQuerySchema, { jobId: "job-1" })).toBe(true);
    expect(Value.Check(DashboardJobReadQuerySchema, { jobId: "/job-1" })).toBe(false);
    expect(Value.Check(DashboardJobReadQuerySchema, { jobId: "job-1", extra: true })).toBe(false);
  });
});
