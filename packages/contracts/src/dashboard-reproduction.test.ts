import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  DashboardReviewRunReproductionCaseQuerySchema,
  type DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunReproductionCaseResponseSchema,
  DashboardReviewRunReproductionSummarySchema,
  DashboardReviewRunResultReproductionSchema,
  maximumDashboardReproductionCaseResponseUtf8Bytes,
} from "./dashboard-reproduction.js";
import type { IssueReproductionAssessmentV1 } from "./issue-reproduction.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const digest = "a".repeat(64);
const response: DashboardReviewRunReproductionCaseResponse = {
  repositoryId: "repository-1",
  reviewRunId: "run-1",
  requestId: "request-1",
  caseId: "case-1",
  jobId: null,
  resultId: null,
  binding: {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: "activation-1",
    repositoryId: "repository-1",
    githubRepositoryId: 1,
    workItemId: "issue-1",
    githubWorkItemId: 2,
    issueRevisionKey: digest,
    testedSourceCommit: "b".repeat(40),
    authorizedBy: {
      issuer: "https://identity.example.test",
      subject: "operator-1",
      authorizedAt: "2026-09-07T10:00:00.000Z",
    },
    claim: "Saving once creates two records",
  },
  case: {
    id: "case-1",
    requestId: "request-1",
    profileVersionId: "version-1",
    profileConfigSha256: digest,
    target: "headless",
    context: "Measure matching records after one save",
    preconditions: [],
    presentWhen: {
      allOf: [
        {
          observation: { kind: "probe_value", testStepId: "measure", observationId: "count" },
          equals: { type: "number", value: 2 },
        },
      ],
    },
    absentWhen: null,
  },
  bindingDigest: digest,
  planDigest: digest,
  recorded: null,
  current: {
    caseId: "case-1",
    requestId: "request-1",
    profileVersionId: "version-1",
    target: "headless",
    state: "inconclusive",
    matchedObservationRefs: [],
    evidenceIds: [],
    reasons: ["execution_pending"],
  },
  observations: [],
};
const assessment: IssueReproductionAssessmentV1 = {
  schemaVersion: "IssueReproductionAssessmentV1",
  rulesVersion: 1,
  bindingDigest: digest,
  planDigest: digest,
  issueRevisionKey: digest,
  testedSourceCommit: response.binding.testedSourceCommit,
  conclusion: "inconclusive",
  coverage: "partial",
  cases: [response.current],
};

describe("Dashboard reproduction contracts", () => {
  it("accepts pending and historical case views with independently recorded and current facts", () => {
    expect(Value.Check(DashboardReviewRunReproductionCaseResponseSchema, response)).toBe(true);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseResponseSchema, {
        ...response,
        jobId: "job-1",
        resultId: "result-1",
        recorded: { ...response.current, state: "present", reasons: [] },
        current: { ...response.current, state: "blocked", reasons: ["evidence_unavailable"] },
        observations: [
          {
            observation: { kind: "probe_value", testStepId: "measure", observationId: "count" },
            checkId: "version-1:measure",
            evidenceIds: [],
            state: "unavailable",
            reason: "evidence_unavailable",
          },
        ],
      }),
    ).toBe(true);
    expect(maximumDashboardReproductionCaseResponseUtf8Bytes).toBe(2 * 1024 * 1024);
  });

  it("keeps the scoped binding header separate from the one selected case", () => {
    expect(
      Value.Check(DashboardReviewRunReproductionCaseResponseSchema, {
        ...response,
        binding: { ...response.binding, cases: [response.case] },
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseResponseSchema, { ...response, actual: 2 }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseResponseSchema, {
        ...response,
        case: { ...response.case, profileId: "mutable-profile" },
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseResponseSchema, {
        ...response,
        current: { ...response.current, value: 2 },
      }),
    ).toBe(false);
  });

  it("requires full case scope and accepts an optional historical job selector", () => {
    const query = {
      repositoryId: response.repositoryId,
      reviewRunId: response.reviewRunId,
      requestId: response.requestId,
      caseId: response.caseId,
    };
    expect(Value.Check(DashboardReviewRunReproductionCaseQuerySchema, query)).toBe(true);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseQuerySchema, { ...query, jobId: "job-1" }),
    ).toBe(true);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseQuerySchema, { ...query, jobId: null }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseQuerySchema, { ...query, caseId: undefined }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseQuerySchema, {
        ...query,
        resultId: "result-1",
      }),
    ).toBe(false);
  });

  it("bounds complete observations and rejects actual values for unavailable captures", () => {
    const observations = Array.from({ length: 48 }, (_, index) => ({
      observation: { kind: "probe_value", testStepId: "measure", observationId: `field-${index}` },
      checkId: "version-1:measure",
      evidenceIds: [],
      state: "observed",
      value: { type: "number", value: index },
    }));
    expect(
      Value.Check(DashboardReviewRunReproductionCaseResponseSchema, { ...response, observations }),
    ).toBe(true);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseResponseSchema, {
        ...response,
        observations: [
          ...observations,
          {
            ...observations[0],
            observation: { kind: "probe_value", testStepId: "measure", observationId: "extra" },
          },
        ],
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunReproductionCaseResponseSchema, {
        ...response,
        observations: [{ ...observations[0], state: "unavailable", reason: "unsafe_value" }],
      }),
    ).toBe(false);
  });

  it("separates bounded run summaries from request-scoped result assessments", () => {
    const summary = {
      bindingDigest: digest,
      claim: response.binding.claim,
      caseCount: 1,
      cases: [
        {
          caseId: response.caseId,
          requestId: response.requestId,
          profileVersionId: response.case.profileVersionId,
          target: response.case.target,
          context: response.case.context,
        },
      ],
      assessment,
    };
    expect(Value.Check(DashboardReviewRunReproductionSummarySchema, summary)).toBe(true);
    expect(
      Value.Check(DashboardReviewRunReproductionSummarySchema, {
        ...summary,
        cases: [response.case],
      }),
    ).toBe(false);
    const requestAssessment = {
      ...assessment,
      schemaVersion: "IssueReproductionRequestAssessmentV1",
      requestId: response.requestId,
    };
    expect(
      Value.Check(DashboardReviewRunResultReproductionSchema, {
        recordedAssessment: requestAssessment,
        currentAssessment: requestAssessment,
      }),
    ).toBe(true);
    expect(
      Value.Check(DashboardReviewRunResultReproductionSchema, {
        recordedAssessment: assessment,
        currentAssessment: requestAssessment,
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunResultReproductionSchema, {
        recordedAssessment: requestAssessment,
        currentAssessment: null,
      }),
    ).toBe(false);
  });
});
