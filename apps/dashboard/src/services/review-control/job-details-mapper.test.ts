import { describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError, ReviewControlProtocolError } from "./errors";
import { HttpReviewControlAdapter } from "./http-adapter";
import { mapJobDetailsResponse } from "./http-mappers";

const baseJobDetails = {
  id: "job-1",
  workItemId: "item-1",
  workItemRef: "microsoft/PowerToys#501",
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
  elapsedSeconds: 20,
  targetRevisionKey: "a".repeat(40),
  outcome: "success",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:01:00.000Z",
  failureCode: null,
  failureMessage: null,
  resultDigest: "a".repeat(64),
  reviewResult: {
    reviewResultId: "result-1",
    schemaId: "PrReviewPlanV1",
    resultDigest: "a".repeat(64),
    summary: "One finding needs attention.",
    requestedRecipeIds: ["pull-request-review"],
    createdAt: "2026-09-05T00:01:00.000Z",
    prReview: {
      assessment: "request_changes",
      findings: [
        {
          findingId: "f-1",
          ordinal: 0,
          priority: 2,
          title: "Guard stale handle",
          body: "The code path can dereference a stale handle.",
          path: "src/modules/FancyZones/LayoutRestore.cs",
          line: 120,
          endLine: 124,
          confidence: 0.88,
        },
      ],
    },
    issueTriage: null,
  },
} as const;

describe("job details mapper", () => {
  it("maps structured review results without raw result JSON", () => {
    expect(mapJobDetailsResponse(baseJobDetails).reviewResult).toMatchObject({
      schemaId: "PrReviewPlanV1",
      requestedRecipeIds: ["pull-request-review"],
    });
  });

  it("rejects legacy raw resultJson and invalid requested recipe identifiers", () => {
    expect(() =>
      mapJobDetailsResponse({
        ...baseJobDetails,
        reviewResult: {
          ...baseJobDetails.reviewResult,
          resultJson: "{}",
        },
      }),
    ).toThrow(ReviewControlProtocolError);

    expect(() =>
      mapJobDetailsResponse({
        ...baseJobDetails,
        reviewResult: {
          ...baseJobDetails.reviewResult,
          requestedRecipeIds: ["pull-request-review", "Pull-Request-Review"],
        },
      }),
    ).toThrow(ReviewControlProtocolError);
  });

  it("enforces finding bounds and issue triage caps", () => {
    expect(() =>
      mapJobDetailsResponse({
        ...baseJobDetails,
        reviewResult: {
          ...baseJobDetails.reviewResult,
          prReview: {
            ...baseJobDetails.reviewResult.prReview,
            findings: [
              {
                ...baseJobDetails.reviewResult.prReview.findings[0],
                endLine: 119,
              },
            ],
          },
        },
      }),
    ).toThrow(ReviewControlProtocolError);

    expect(() =>
      mapJobDetailsResponse({
        ...baseJobDetails,
        reviewResult: {
          reviewResultId: "result-2",
          schemaId: "IssueTriageV1",
          resultDigest: "b".repeat(64),
          summary: "Needs more reproduction detail.",
          requestedRecipeIds: ["issue-triage"],
          createdAt: "2026-09-05T00:01:00.000Z",
          prReview: null,
          issueTriage: {
            category: "bug",
            priority: 1,
            confidence: 0.82,
            suggestedLabels: Array.from({ length: 33 }, (_value, index) => `label-${index}`),
            missingInformation: [],
            duplicateCandidates: [],
          },
        },
      }),
    ).toThrow(ReviewControlProtocolError);
  });
});

describe("job details HTTP adapter", () => {
  it("returns null only for the canonical missing-job response", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "dashboard_job_not_found",
            message: "The dashboard job does not exist.",
            retryable: false,
          }),
          { headers: { "content-type": "application/json" }, status: 404 },
        ),
    );
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.getJob("job-1")).resolves.toBeNull();
  });

  it("preserves unrelated 404 responses as HTTP failures", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "route_not_found",
            message: "The route does not exist.",
            retryable: false,
          }),
          { headers: { "content-type": "application/json" }, status: 404 },
        ),
    );
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.getJob("job-1")).rejects.toBeInstanceOf(ReviewControlHttpError);
  });
});
