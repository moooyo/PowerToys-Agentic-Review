import { describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError, ReviewControlProtocolError } from "./errors";
import { HttpReviewControlAdapter } from "./http-adapter";
import { mapJobDetailsResponse } from "./http-mappers";

const baseJobDetails = {
  id: "job-1",
  repositoryId: "repo-powertoys",
  workItemId: "item-1",
  workItemRef: "microsoft/PowerToys#501",
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

const verification = {
  status: "not_run",
  summary: "Only static review was performed.",
  commands: [],
} as const;

const executionEvidence = {
  schemaVersion: "ReviewExecutionEvidenceV1",
  source: "worker",
  commandCapture: "complete",
  commands: [{ itemId: "item-1", command: "git diff --stat", status: "completed", exitCode: 0 }],
  worktree: { status: "clean", source: "git_status" },
} as const;

const failureDiagnostics = {
  category: "process",
  exitCode: 17,
  summary: "The review process exited before producing a result.",
  correlationId: "run-1",
} as const;

describe("job details mapper", () => {
  it("preserves the repository identity for execution detail scope checks", () => {
    expect(mapJobDetailsResponse(baseJobDetails).repositoryId).toBe("repo-powertoys");
  });

  it.each([undefined, null, "", "microsoft/PowerToys"])(
    "rejects job details without a canonical repository identity: %j",
    (repositoryId) => {
      expect(() => mapJobDetailsResponse({ ...baseJobDetails, repositoryId })).toThrow(
        ReviewControlProtocolError,
      );
    },
  );

  it("maps structured review results without raw result JSON", () => {
    expect(mapJobDetailsResponse(baseJobDetails).reviewResult).toMatchObject({
      schemaId: "PrReviewPlanV1",
      requestedRecipeIds: ["pull-request-review"],
    });
    expect(mapJobDetailsResponse(baseJobDetails).reviewResult?.verification).toBeUndefined();
    expect(mapJobDetailsResponse(baseJobDetails).reviewResult?.executionEvidence).toBeUndefined();
    expect(mapJobDetailsResponse(baseJobDetails).failureDiagnostics).toBeUndefined();
  });

  it("keeps a V2 model report separate from successful captured commands", () => {
    const response = mapJobDetailsResponse({
      ...baseJobDetails,
      reviewResult: {
        ...baseJobDetails.reviewResult,
        schemaId: "PrReviewPlanV2",
        verification,
        executionEvidence,
      },
    });

    expect(response.reviewResult).toMatchObject({
      schemaId: "PrReviewPlanV2",
      verification,
      executionEvidence,
    });
    expect(response.reviewResult?.verification?.status).toBe("not_run");
  });

  it.each(["IssueTriageV1", "IssueTriageV2"])("maps %s issue triage projections", (schemaId) => {
    const response = mapJobDetailsResponse({
      ...baseJobDetails,
      reviewResult: {
        ...baseJobDetails.reviewResult,
        schemaId,
        prReview: null,
        issueTriage: {
          category: "bug",
          priority: 2,
          confidence: 0.8,
          suggestedLabels: [],
          missingInformation: [],
          duplicateCandidates: [],
        },
        verification,
      },
    });

    expect(response.reviewResult?.schemaId).toBe(schemaId);
    expect(response.reviewResult?.prReview).toBeNull();
    expect(response.reviewResult?.issueTriage?.category).toBe("bug");
  });

  it("preserves Windows process exit codes", () => {
    const evidence = {
      ...executionEvidence,
      commands: [{ ...executionEvidence.commands[0], status: "failed", exitCode: 4_294_967_295 }],
    };
    expect(
      mapJobDetailsResponse({
        ...baseJobDetails,
        reviewResult: { ...baseJobDetails.reviewResult, executionEvidence: evidence },
      }).reviewResult?.executionEvidence?.commands[0]?.exitCode,
    ).toBe(4_294_967_295);
  });

  it("preserves incomplete capture and unknown exit codes without inventing success", () => {
    const evidence = {
      ...executionEvidence,
      commandCapture: "incomplete",
      commands: [{ ...executionEvidence.commands[0], status: "unknown", exitCode: null }],
      worktree: { status: "unknown", source: "not_observed" },
    };
    expect(
      mapJobDetailsResponse({
        ...baseJobDetails,
        reviewResult: { ...baseJobDetails.reviewResult, executionEvidence: evidence },
      }).reviewResult?.executionEvidence,
    ).toEqual(evidence);
  });

  it("maps structured failures and permits legacy null diagnostics", () => {
    expect(
      mapJobDetailsResponse({ ...baseJobDetails, failureDiagnostics }).failureDiagnostics,
    ).toEqual(failureDiagnostics);
    expect(
      mapJobDetailsResponse({ ...baseJobDetails, failureDiagnostics: null }).failureDiagnostics,
    ).toBeNull();
  });

  it.each([
    { ...verification, status: "verified" },
    { ...verification, commands: [{ command: "npm test", status: "completed" }] },
    {
      ...verification,
      commands: Array.from({ length: 33 }, () => ({ command: "npm test", status: "passed" })),
    },
  ])("rejects invalid model verification reports", (report) => {
    expect(() =>
      mapJobDetailsResponse({
        ...baseJobDetails,
        reviewResult: { ...baseJobDetails.reviewResult, verification: report },
      }),
    ).toThrow(ReviewControlProtocolError);
  });

  it.each([
    { ...executionEvidence, source: "model" },
    { ...executionEvidence, commands: [{ ...executionEvidence.commands[0], exitCode: 0.5 }] },
    {
      ...executionEvidence,
      commands: [{ ...executionEvidence.commands[0], exitCode: 4_294_967_296 }],
    },
    {
      ...executionEvidence,
      commands: [{ ...executionEvidence.commands[0], exitCode: -2_147_483_649 }],
    },
    { ...executionEvidence, commands: [{ ...executionEvidence.commands[0], status: "passed" }] },
    {
      ...executionEvidence,
      commands: Array.from({ length: 129 }, () => executionEvidence.commands[0]),
    },
    { ...executionEvidence, worktree: { status: "unknown", source: "assumed" } },
    { ...executionEvidence, verificationStatus: "passed" },
  ])("rejects invalid runtime evidence", (evidence) => {
    expect(() =>
      mapJobDetailsResponse({
        ...baseJobDetails,
        reviewResult: { ...baseJobDetails.reviewResult, executionEvidence: evidence },
      }),
    ).toThrow(ReviewControlProtocolError);
  });

  it.each([
    { ...failureDiagnostics, category: "arbitrary_error" },
    { ...failureDiagnostics, correlationId: "" },
    { ...failureDiagnostics, exitCode: 4_294_967_296 },
    { ...failureDiagnostics, summary: "x".repeat(2_049) },
  ])("rejects invalid failure diagnostics", (diagnostics) => {
    expect(() =>
      mapJobDetailsResponse({ ...baseJobDetails, failureDiagnostics: diagnostics }),
    ).toThrow(ReviewControlProtocolError);
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
  it("cancels a pending job read when its scoped view is discarded", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetch = vi.fn((_input: unknown, options?: RequestInit) => {
      requestSignal = options?.signal;
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const adapter = new HttpReviewControlAdapter({ fetch: fetch as typeof globalThis.fetch });
    const pending = adapter.getJob("job-1", controller.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    controller.abort();
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
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
