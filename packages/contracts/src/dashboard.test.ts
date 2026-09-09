import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  DashboardJobDetailReadSchema,
  DashboardJobListQuerySchema,
  DashboardJobReadQuerySchema,
  DashboardWorkItemListQuerySchema,
} from "./dashboard.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const baseJob = {
  id: "job-1",
  repositoryId: "repository-1",
  workItemId: "item-1",
  workItemRef: "microsoft/PowerToys#1",
  title: "PR review",
  generation: 1,
  status: "succeeded",
  admission: null,
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

describe("dashboard repository scope contracts", () => {
  it.each([
    ["work items", DashboardWorkItemListQuerySchema],
    ["jobs", DashboardJobListQuerySchema],
  ])("accepts an optional exact repository identifier for %s", (_name, schema) => {
    expect(Value.Check(schema, {})).toBe(true);
    expect(Value.Check(schema, { repositoryId: "repository-1", page: 2, pageSize: 10 })).toBe(true);
    for (const repositoryId of [
      "",
      "/repository-1",
      "owner/repo",
      "repository-1,repository-2",
      "x".repeat(129),
      ["repository-1", "repository-2"],
      null,
    ]) {
      expect(Value.Check(schema, { repositoryId }), JSON.stringify(repositoryId)).toBe(false);
    }
  });
});

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
    expect(
      Value.Check(DashboardJobDetailReadSchema, { ...response, repositoryId: "repository-1" }),
    ).toBe(true);
    expect(
      Value.Check(DashboardJobDetailReadSchema, { ...response, repositoryId: "owner/repo" }),
    ).toBe(false);
    const { repositoryId: _repositoryId, ...missingRepository } = response;
    expect(Value.Check(DashboardJobDetailReadSchema, missingRepository)).toBe(false);
  });

  it("accepts V2 model verification alongside worker execution evidence", () => {
    const response = {
      ...baseJob,
      failureDiagnostics: null,
      reviewResult: {
        ...baseReviewResult,
        schemaId: "PrReviewPlanV2",
        verification: {
          status: "not_run",
          summary: "Static review only.",
          commands: [],
        },
        executionEvidence: {
          schemaVersion: "ReviewExecutionEvidenceV1",
          source: "worker",
          commandCapture: "complete",
          commands: [
            { itemId: "item-1", command: "git diff --stat", status: "completed", exitCode: 0 },
          ],
          worktree: { status: "clean", source: "git_status" },
        },
      },
    };

    expect(Value.Check(DashboardJobDetailReadSchema, response)).toBe(true);
    expect(
      Value.Check(DashboardJobDetailReadSchema, {
        ...response,
        reviewResult: {
          ...response.reviewResult,
          verification: { ...response.reviewResult.verification, status: "verified" },
        },
      }),
    ).toBe(false);
  });

  it("accepts structured failures and rejects unbounded diagnostics", () => {
    const failureDiagnostics = {
      category: "process",
      exitCode: 17,
      summary: "The process exited before producing a result.",
      correlationId: "run-1",
    };
    expect(
      Value.Check(DashboardJobDetailReadSchema, {
        ...baseJob,
        failureDiagnostics,
        reviewResult: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(DashboardJobDetailReadSchema, {
        ...baseJob,
        failureDiagnostics: { ...failureDiagnostics, summary: "x".repeat(2_049) },
        reviewResult: null,
      }),
    ).toBe(false);
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

  it("requires an explicit admission projection even for terminal Jobs", () => {
    const { admission: _omitted, ...missing } = baseJob;
    expect(Value.Check(DashboardJobDetailReadSchema, { ...missing, reviewResult: null })).toBe(
      false,
    );
    expect(Value.Check(DashboardJobDetailReadSchema, { ...baseJob, reviewResult: null })).toBe(
      true,
    );
  });
});
