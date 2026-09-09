import { createHash } from "node:crypto";
import {
  type DashboardReviewRunReproductionCaseQuery,
  type DashboardReviewRunReproductionCaseResponse,
  type IssueReproductionCaseAssessment,
  type OperatorReviewRunCreateRequest,
  OperatorReviewRunCreateRequestSchema,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import { MAX_DASHBOARD_RESPONSE_BYTES } from "../review-control/http-client";
import { sampleReviewRunResults, sampleReviewRuns } from "./fixtures";
import { HttpReviewRunAdapter } from "./http-adapter";
import { validateRunDetail, validateRunRequest, validateRunResult } from "./validation";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("The reproduction fixture is incomplete.");
  return value;
}

function fixture() {
  const result = structuredClone(
    required(
      sampleReviewRunResults.find(
        (entry) =>
          entry.report.workItemKind === "issue" &&
          entry.report.reproductionConclusion === "confirmed",
      ),
    ),
  );
  const detail = structuredClone(
    required(sampleReviewRuns.find((entry) => entry.id === result.reviewRunId)),
  );
  const request = required(detail.requests.find((entry) => entry.requestId === result.requestId));
  const profile = required(request.profile);
  const check = required(result.report.checks[0]);
  required(result.execution.diagnostics.find((entry) => entry.stepId === check.id)).exitCode = 0;
  const source = required(detail.testedSourceRevision);
  const ref = {
    kind: "ui_assertion" as const,
    scenarioId: "focus-restoration",
    stepId: "focus-bug",
  };
  const current: IssueReproductionCaseAssessment = {
    caseId: "focus-regression",
    requestId: request.requestId,
    profileVersionId: profile.id,
    target: "windows_desktop",
    state: "present",
    matchedObservationRefs: [ref],
    evidenceIds: [...check.evidenceIds],
    reasons: [],
  };
  const assessment = {
    rulesVersion: 1 as const,
    bindingDigest: "1".repeat(64),
    planDigest: detail.planDigest,
    issueRevisionKey: detail.revisionKey,
    testedSourceCommit: source.headSha,
    conclusion: "confirmed" as const,
    coverage: "complete" as const,
    cases: [current],
  };
  detail.reproduction = {
    bindingDigest: assessment.bindingDigest,
    claim: "Target selection loses editor focus.",
    caseCount: 1,
    cases: [
      {
        caseId: current.caseId,
        requestId: current.requestId,
        profileVersionId: profile.id,
        target: current.target,
        context: "Select a remap target using a public fixture.",
      },
    ],
    assessment: { schemaVersion: "IssueReproductionAssessmentV1", ...structuredClone(assessment) },
  };
  result.reproduction = {
    recordedAssessment: {
      schemaVersion: "IssueReproductionRequestAssessmentV1",
      requestId: result.requestId,
      ...structuredClone(assessment),
    },
    currentAssessment: {
      schemaVersion: "IssueReproductionRequestAssessmentV1",
      requestId: result.requestId,
      ...structuredClone(assessment),
    },
  };
  const response: DashboardReviewRunReproductionCaseResponse = {
    repositoryId: detail.repositoryId,
    reviewRunId: detail.id,
    requestId: request.requestId,
    caseId: current.caseId,
    jobId: result.jobId,
    resultId: result.id,
    binding: {
      schemaVersion: "IssueReproductionBindingV1",
      activationId: detail.activationId,
      repositoryId: detail.repositoryId,
      githubRepositoryId: 1,
      workItemId: detail.workItemId,
      githubWorkItemId: 2,
      issueRevisionKey: detail.revisionKey,
      testedSourceCommit: source.headSha,
      authorizedBy: { issuer: "fixture", subject: "operator", authorizedAt: detail.createdAt },
      claim: detail.reproduction.claim,
    },
    case: {
      id: current.caseId,
      requestId: request.requestId,
      profileVersionId: profile.id,
      profileConfigSha256: profile.configSha256,
      target: current.target,
      context: required(detail.reproduction.cases[0]).context,
      preconditions: [],
      presentWhen: { allOf: [{ observation: ref, equals: { type: "boolean", value: true } }] },
      absentWhen: { allOf: [{ observation: ref, equals: { type: "boolean", value: false } }] },
    },
    bindingDigest: assessment.bindingDigest,
    planDigest: detail.planDigest,
    recorded: structuredClone(current),
    current: structuredClone(current),
    observations: [
      {
        observation: ref,
        checkId: check.id,
        evidenceIds: [...check.evidenceIds],
        state: "observed",
        value: { type: "boolean", value: true },
      },
    ],
  };
  const query: DashboardReviewRunReproductionCaseQuery = {
    repositoryId: detail.repositoryId,
    reviewRunId: detail.id,
    requestId: request.requestId,
    caseId: current.caseId,
    jobId: result.jobId,
  };
  const input: OperatorReviewRunCreateRequest = {
    activationId: detail.activationId,
    expectedRevisionKey: detail.revisionKey,
    testedSourceCommit: source.headSha,
    profileIds: [profile.profileId],
    reproduction: {
      schemaVersion: "IssueReproductionRequestV1",
      claim: detail.reproduction.claim,
      cases: [
        {
          id: response.case.id,
          context: response.case.context,
          profileId: profile.profileId,
          expectedProfileVersionId: profile.id,
          preconditions: [],
          presentWhen: structuredClone(response.case.presentWhen),
          absentWhen: structuredClone(response.case.absentWhen),
        },
      ],
    },
  };
  return { detail, result, response, query, input };
}

function adapterWith(...values: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of values)
    fetch.mockResolvedValueOnce(
      value instanceof Response
        ? value
        : new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }),
    );
  return { fetch, adapter: new HttpReviewRunAdapter({ fetch }) };
}

function blocked(entry: IssueReproductionCaseAssessment): IssueReproductionCaseAssessment {
  return {
    ...entry,
    state: "blocked",
    matchedObservationRefs: [],
    evidenceIds: [],
    reasons: ["evidence_unavailable"],
  };
}

function probeFixture() {
  const value = fixture();
  const { detail, result, response } = value;
  const request = required(detail.requests.find((entry) => entry.requestId === result.requestId));
  const summary = required(detail.reproduction);
  const reproduction = required(result.reproduction);
  const ref = {
    kind: "probe_value" as const,
    testStepId: "focus-restoration",
    observationId: "regression",
  };
  request.target = "headless";
  required(summary.cases[0]).target = "headless";
  response.case.target = "headless";
  for (const assessment of [
    summary.assessment,
    reproduction.recordedAssessment,
    reproduction.currentAssessment,
  ]) {
    const entry = required(assessment.cases[0]);
    entry.target = "headless";
    entry.matchedObservationRefs = [ref];
    entry.evidenceIds = [];
  }
  for (const assessment of [response.current, required(response.recorded)]) {
    assessment.target = "headless";
    assessment.matchedObservationRefs = [ref];
    assessment.evidenceIds = [];
  }
  required(response.case.presentWhen.allOf[0]).observation = ref;
  required(response.case.absentWhen?.allOf[0]).observation = ref;
  const check = required(result.report.checks[0]);
  check.kind = "test";
  check.outcome = "passed";
  check.evidenceIds = [];
  const diagnostic = required(result.execution.diagnostics[0]);
  diagnostic.phase = "test";
  diagnostic.outcome = "passed";
  const preview = required(request.latestResult);
  preview.checks = { passed: 1, failed: 0, blocked: 0, not_run: 0, skipped: 0, inconclusive: 0 };
  preview.evidenceIds = [];
  preview.evidenceCount = 0;
  response.observations = [
    {
      observation: ref,
      checkId: check.id,
      evidenceIds: [],
      state: "observed",
      value: { type: "boolean", value: true },
    },
  ];
  const output = {
    schemaVersion: "ProbeObservationsV1" as const,
    observations: [
      {
        id: ref.observationId,
        state: "observed" as const,
        value: { type: "boolean" as const, value: true },
      },
    ],
  };
  result.probeReceipts = [
    {
      schemaVersion: "TestProbeReceiptV1",
      requestId: result.requestId,
      jobId: result.jobId,
      runAttemptId: result.runAttemptId,
      planDigest: result.planDigest,
      profileVersionId: result.profileVersionId,
      checkId: check.id,
      capture: "complete",
      output,
      outputSha256: createHash("sha256")
        .update(
          JSON.stringify({
            observations: output.observations,
            schemaVersion: output.schemaVersion,
          }),
        )
        .digest("hex"),
    },
  ];
  return value;
}

describe("mapped reproduction creation", () => {
  it("preserves the caller's versioned mapping and activation in the POST body", async () => {
    const { detail, input } = fixture();
    const { adapter, fetch } = adapterWith(detail);
    await expect(adapter.create(detail.repositoryId, detail.workItemId, input)).resolves.toEqual(
      detail,
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
  });

  it.each(["missing", "claim", "profile", "case", "context"])(
    "rejects a changed create mapping: %s",
    async (change) => {
      const { detail, input } = fixture();
      const mapping = required(detail.reproduction);
      if (change === "missing") delete detail.reproduction;
      if (change === "claim") mapping.claim = "Another claim.";
      if (change === "profile")
        required(input.reproduction?.cases[0]).expectedProfileVersionId = "another-version";
      if (change === "case") required(input.reproduction?.cases[0]).id = "another-case";
      if (change === "context") required(input.reproduction?.cases[0]).context = "Another context.";
      const { adapter } = adapterWith(detail);
      await expect(
        adapter.create(detail.repositoryId, detail.workItemId, input),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );

  it.each([
    "missing-source",
    "duplicate-case",
    "duplicate-ref",
    "wrong-type",
    "overlapping",
    "foreign-check",
    "surrogate",
    "unknown",
    "undefined",
  ])("rejects invalid mapped intent before transport: %s", async (change) => {
    const { detail, input } = fixture();
    const mapping = required(input.reproduction);
    const entry = required(mapping.cases[0]);
    if (change === "missing-source") delete input.testedSourceCommit;
    if (change === "duplicate-case")
      mapping.cases.push({ ...entry, context: "Different context." });
    if (change === "duplicate-ref")
      entry.presentWhen.allOf.push({
        ...required(entry.presentWhen.allOf[0]),
        equals: { type: "boolean", value: false },
      });
    if (change === "wrong-type")
      required(entry.absentWhen?.allOf[0]).equals = { type: "string", value: "false" };
    if (change === "overlapping") entry.absentWhen = structuredClone(entry.presentWhen);
    if (change === "foreign-check")
      entry.preconditions.push({ kind: "check_passed", checkId: "foreign:check" });
    if (change === "surrogate") entry.context = "Unsafe \ud800";
    if (change === "unknown") Object.assign(mapping, { authorization: "operator" });
    if (change === "undefined") Object.assign(input, { reproduction: undefined });
    const { adapter, fetch } = adapterWith();
    await expect(
      adapter.create(detail.repositoryId, detail.workItemId, input),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds the entire create request by UTF-8 bytes", () => {
    const { input } = fixture();
    const mapping = required(input.reproduction);
    const original = required(mapping.cases[0]);
    mapping.cases = Array.from({ length: 32 }, (_, caseIndex) => ({
      ...original,
      id: `case-${caseIndex}`,
      presentWhen: {
        allOf: Array.from({ length: 16 }, (_, index) => ({
          observation: {
            kind: "probe_value" as const,
            testStepId: `test-${index}`,
            observationId: "value",
          },
          equals: { type: "string" as const, value: "\u20ac".repeat(1000) },
        })),
      },
      absentWhen: {
        allOf: Array.from({ length: 16 }, (_, index) => ({
          observation: {
            kind: "probe_value" as const,
            testStepId: `test-${index}`,
            observationId: "value",
          },
          equals: { type: "string" as const, value: "\u20ac".repeat(999) },
        })),
      },
    }));
    expect(JSON.stringify(input).length).toBeLessThan(2 * 1024 * 1024);
    expect(() =>
      validateRunRequest(OperatorReviewRunCreateRequestSchema, input, "create review run"),
    ).toThrow(ReviewControlRequestError);
  });
});

describe("mapped reproduction summary and result scope", () => {
  it.each([
    "case-count",
    "duplicate-case",
    "request",
    "profile",
    "target",
    "plan",
    "binding",
    "revision",
    "source",
    "conclusion",
    "coverage",
    "reasons",
    "workflow",
  ])("rejects inconsistent detail reproduction metadata: %s", (change) => {
    const { detail } = fixture();
    const summary = required(detail.reproduction);
    const entry = required(summary.cases[0]);
    if (change === "case-count") summary.caseCount = 2;
    if (change === "duplicate-case") {
      summary.cases.push({ ...entry, context: "Different." });
      summary.caseCount = 2;
    }
    if (change === "request") entry.requestId = "another-request";
    if (change === "profile") entry.profileVersionId = "another-profile";
    if (change === "target") entry.target = "web";
    if (change === "plan") summary.assessment.planDigest = "f".repeat(64);
    if (change === "binding") summary.assessment.bindingDigest = "f".repeat(64);
    if (change === "revision") summary.assessment.issueRevisionKey = "f".repeat(64);
    if (change === "source") summary.assessment.testedSourceCommit = "f".repeat(40);
    if (change === "conclusion") summary.assessment.conclusion = "not_reproduced";
    if (change === "coverage") summary.assessment.coverage = "partial";
    if (change === "reasons") required(summary.assessment.cases[0]).reasons = ["positive_only"];
    if (change === "workflow")
      required(
        detail.requests.find((candidate) => candidate.requestId === entry.requestId),
      ).workflowKind = "issue_triage";
    expect(() => validateRunDetail(detail, "get review run")).toThrow(ReviewControlProtocolError);
  });

  it.each([
    "missing",
    "request",
    "profile",
    "case",
    "source",
    "plan",
    "binding",
    "conclusion",
    "report",
    "evidence",
    "ref",
  ])("rejects inconsistent result reproduction: %s", (change) => {
    const { detail, result } = fixture();
    const reproduction = required(result.reproduction);
    const assessment = reproduction.recordedAssessment;
    if (change === "missing") delete result.reproduction;
    if (change === "request") assessment.requestId = "another-request";
    if (change === "profile") required(assessment.cases[0]).profileVersionId = "another-profile";
    if (change === "case") required(assessment.cases[0]).caseId = "another-case";
    if (change === "source") assessment.testedSourceCommit = "f".repeat(40);
    if (change === "plan") assessment.planDigest = "f".repeat(64);
    if (change === "binding") assessment.bindingDigest = "f".repeat(64);
    if (change === "conclusion") assessment.conclusion = "not_reproduced";
    if (change === "report" && result.report.workItemKind === "issue")
      result.report.reproductionConclusion = "blocked";
    if (change === "evidence") required(assessment.cases[0]).evidenceIds = ["foreign-evidence"];
    if (change === "ref")
      required(assessment.cases[0]).matchedObservationRefs = [
        { kind: "ui_assertion", scenarioId: "foreign", stepId: "assertion" },
      ];
    expect(() =>
      validateRunResult(result, detail, result.requestId, result.jobId, "get result"),
    ).toThrow(ReviewControlProtocolError);
  });

  it("preserves recorded truth when current verification is pending and ignores the model conclusion", () => {
    const { detail, result } = fixture();
    const current = required(result.reproduction).currentAssessment;
    current.cases = [
      {
        ...blocked(required(current.cases[0])),
        state: "inconclusive",
        reasons: ["execution_pending"],
      },
    ];
    current.conclusion = "inconclusive";
    current.coverage = "partial";
    result.evidenceComplete = false;
    result.evidenceVerificationPending = true;
    result.modelReview.reproductionConclusion = "not_reproduced";
    expect(validateRunResult(result, detail, result.requestId, result.jobId, "get result")).toEqual(
      result,
    );
  });

  it("does not allow mappings to appear on an unmapped request", () => {
    const { detail, result } = fixture();
    delete detail.reproduction;
    expect(() =>
      validateRunResult(result, detail, result.requestId, result.jobId, "get result"),
    ).toThrow(ReviewControlProtocolError);
  });
});

describe("selected reproduction case transport and validation", () => {
  it.each([true, false])(
    "accepts independently verified probe facts, inline receipt: %s",
    async (inline) => {
      const { detail, result, response, query } = probeFixture();
      if (!inline) delete result.probeReceipts;
      const { adapter } = adapterWith(detail, response, result);
      await expect(adapter.getReproductionCase(query)).resolves.toEqual(response);
    },
  );

  it.each(["scope", "duplicate", "value", "digest", "capture-type", "unsettled", "evidence"])(
    "rejects invalid inline probe evidence: %s",
    async (change) => {
      const { detail, result, response, query } = probeFixture();
      const receipt = required(result.probeReceipts?.[0]);
      if (change === "scope") receipt.runAttemptId = "another-attempt";
      if (change === "duplicate") result.probeReceipts?.push(structuredClone(receipt));
      if (change === "value")
        Object.assign(required(response.observations[0]), {
          value: { type: "boolean", value: false },
        });
      if (change === "digest") receipt.outputSha256 = "f".repeat(64);
      if (change === "capture-type")
        Object.assign(required(receipt.output.observations[0]), {
          value: { type: "string", value: "true" },
        });
      if (change === "unsettled") required(result.execution.diagnostics[0]).exitCode = null;
      if (change === "evidence")
        required(response.observations[0]).evidenceIds = ["unexpected-evidence"];
      const { adapter } = adapterWith(detail, response, result);
      await expect(adapter.getReproductionCase(query)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it("refreshes a bounded summary when the selected job completes between reads", async () => {
    const { detail, result, response, query } = fixture();
    const pending = structuredClone(detail);
    const request = required(pending.requests.find((entry) => entry.requestId === query.requestId));
    const job = required(request.latestJob);
    job.status = "running";
    job.completedAt = null;
    job.resultId = null;
    job.resultDigest = null;
    request.latestResult = null;
    pending.execution.succeeded--;
    pending.execution.active++;
    const summary = required(pending.reproduction).assessment;
    summary.cases = [
      {
        ...blocked(required(summary.cases[0])),
        state: "inconclusive",
        reasons: ["execution_pending"],
      },
    ];
    summary.conclusion = "inconclusive";
    summary.coverage = "partial";
    const { adapter, fetch } = adapterWith(pending, response, detail, result);
    await expect(adapter.getReproductionCase(query)).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps a historical case recorded result while its current assessment is invalidated", async () => {
    const { detail, result, response, query } = fixture();
    const request = required(detail.requests.find((entry) => entry.requestId === query.requestId));
    Object.assign(required(request.latestJob), {
      jobId: "newer-job",
      activationNumber: 2,
      runAttemptId: "newer-attempt",
      resultId: "newer-result",
      resultDigest: "f".repeat(64),
    });
    Object.assign(required(request.latestResult), {
      id: "newer-result",
      resultDigest: "f".repeat(64),
    });
    result.authoritative = false;
    response.current = { ...blocked(response.current), reasons: ["invalid_scope"] };
    response.observations = [];
    const current = required(result.reproduction).currentAssessment;
    current.cases = [response.current];
    current.conclusion = "blocked";
    current.coverage = "partial";
    const { adapter } = adapterWith(detail, response, detail, result);
    await expect(adapter.getReproductionCase(query)).resolves.toEqual(response);
    current.cases = structuredClone(required(result.reproduction).recordedAssessment.cases);
    current.conclusion = "confirmed";
    current.coverage = "complete";
    const invalid = adapterWith(detail, response, detail, result);
    await expect(invalid.adapter.getReproductionCase(query)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("rejects affirmative evidence from unsettled UI execution", async () => {
    const { detail, result, response, query } = fixture();
    required(result.execution.diagnostics[0]).exitCode = null;
    const { adapter } = adapterWith(detail, response, result);
    await expect(adapter.getReproductionCase(query)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it.each([true, false])(
    "fetches only the selected case and result, explicit job: %s",
    async (explicit) => {
      const { detail, result, response, query } = fixture();
      if (!explicit) delete query.jobId;
      const { adapter, fetch } = adapterWith(detail, response, result);
      await expect(adapter.getReproductionCase(query)).resolves.toEqual(response);
      const prefix = `/api/v1/operator/repositories/${query.repositoryId}/review-runs/${query.reviewRunId}`;
      expect(fetch.mock.calls.map(([path]) => path)).toEqual([
        prefix,
        `${prefix}/requests/${query.requestId}/reproduction-cases/${query.caseId}${explicit ? `?jobId=${result.jobId}` : ""}`,
        `${prefix}/requests/${query.requestId}/jobs/${result.jobId}/result`,
      ]);
    },
  );

  it.each(["repositoryId", "reviewRunId", "requestId", "caseId", "jobId"] as const)(
    "rejects unsafe query %s before any read",
    async (field) => {
      const { query } = fixture();
      query[field] = "../foreign";
      const { adapter, fetch } = adapterWith();
      await expect(adapter.getReproductionCase(query)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown query keys and mismatched case selection before evidence reads", async () => {
    const { detail, query } = fixture();
    const { adapter, fetch } = adapterWith(detail);
    await expect(
      adapter.getReproductionCase({
        ...query,
        extra: "value",
      } as DashboardReviewRunReproductionCaseQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.getReproductionCase({ ...query, caseId: "another-case" }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "repository",
    "activation",
    "work-item",
    "revision",
    "source",
    "claim",
    "profile",
    "config",
    "target",
    "context",
    "binding",
    "plan",
    "recorded",
    "job",
    "result",
    "case-ref",
    "duplicate-ref",
    "type",
    "check",
    "evidence",
    "value",
    "missing-observed",
    "null-absent",
  ])("rejects an inconsistent case response: %s", async (change) => {
    const { detail, result, response, query } = fixture();
    if (change === "repository") response.binding.repositoryId = "other-repo";
    if (change === "activation") response.binding.activationId = "other-activation";
    if (change === "work-item") response.binding.workItemId = "other-item";
    if (change === "revision") response.binding.issueRevisionKey = "f".repeat(64);
    if (change === "source") response.binding.testedSourceCommit = "f".repeat(40);
    if (change === "claim") response.binding.claim = "Another claim.";
    if (change === "profile") response.case.profileVersionId = "other-profile";
    if (change === "config") response.case.profileConfigSha256 = "f".repeat(64);
    if (change === "target") response.case.target = "web";
    if (change === "context") response.case.context = "Another context.";
    if (change === "binding") response.bindingDigest = "f".repeat(64);
    if (change === "plan") response.planDigest = "f".repeat(64);
    if (change === "recorded") response.recorded = blocked(required(response.recorded));
    if (change === "job") response.jobId = "another-job";
    if (change === "result") response.resultId = "another-result";
    if (change === "case-ref")
      required(response.observations[0]).observation = {
        kind: "ui_assertion",
        scenarioId: "another",
        stepId: "other",
      };
    if (change === "duplicate-ref")
      response.observations.push({ ...required(response.observations[0]), evidenceIds: [] });
    if (change === "type")
      Object.assign(required(response.observations[0]), {
        value: { type: "string", value: "true" },
      });
    if (change === "check")
      required(response.observations[0]).checkId = "another-profile:focus-restoration";
    if (change === "evidence")
      required(response.observations[0]).evidenceIds = ["foreign-evidence"];
    if (change === "value")
      Object.assign(required(response.observations[0]), {
        value: { type: "boolean", value: false },
      });
    if (change === "missing-observed") response.observations = [];
    if (change === "null-absent") {
      response.case.absentWhen = null;
      response.current.state = "absent";
    }
    const { adapter } = adapterWith(detail, response, result);
    await expect(adapter.getReproductionCase(query)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("allows current evidence to change between detail, case, and result reads", async () => {
    const { detail, result, response, query } = fixture();
    const summary = required(detail.reproduction).assessment;
    summary.cases = [blocked(required(summary.cases[0]))];
    summary.conclusion = "blocked";
    summary.coverage = "partial";
    const assessment = required(result.reproduction).currentAssessment;
    assessment.cases = [
      {
        ...blocked(required(assessment.cases[0])),
        state: "inconclusive",
        reasons: ["execution_pending"],
      },
    ];
    assessment.conclusion = "inconclusive";
    assessment.coverage = "partial";
    result.evidenceComplete = false;
    result.evidenceVerificationPending = true;
    const { adapter } = adapterWith(detail, response, result);
    await expect(adapter.getReproductionCase(query)).resolves.toEqual(response);
  });

  it("retains recorded confirmation after evidence retention removes current observations", async () => {
    const { detail, result, response, query } = fixture();
    response.current = blocked(response.current);
    response.observations = [];
    const { adapter } = adapterWith(detail, response, result);
    await expect(adapter.getReproductionCase(query)).resolves.toMatchObject({
      recorded: { state: "present" },
      current: { state: "blocked" },
      observations: [],
    });
  });

  it("returns a pending case without fetching a nonexistent result", async () => {
    const { detail, response, query } = fixture();
    const request = required(detail.requests.find((entry) => entry.requestId === query.requestId));
    request.latestJob = null;
    request.latestResult = null;
    detail.execution.missing++;
    detail.execution.succeeded--;
    response.jobId = null;
    response.resultId = null;
    response.recorded = null;
    response.observations = [];
    response.current = {
      ...blocked(response.current),
      state: "inconclusive",
      reasons: ["execution_pending"],
    };
    delete query.jobId;
    const summary = required(detail.reproduction).assessment;
    summary.cases = [response.current];
    summary.conclusion = "inconclusive";
    summary.coverage = "partial";
    const { adapter, fetch } = adapterWith(detail, response);
    await expect(adapter.getReproductionCase(query)).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([403, 404, 409, 503])(
    "preserves case HTTP %s without sample fallback",
    async (status) => {
      const { detail, query } = fixture();
      const error = new Response(
        JSON.stringify({ code: "review_run_not_found", message: "Case unavailable." }),
        {
          status,
          headers: { "content-type": "application/json" },
        },
      );
      const { adapter, fetch } = adapterWith(detail, error);
      await expect(adapter.getReproductionCase(query)).rejects.toBeInstanceOf(
        ReviewControlHttpError,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the existing streamed 2 MiB response boundary", async () => {
    const { detail, query } = fixture();
    const oversized = { padding: "\u20ac".repeat(Math.ceil(MAX_DASHBOARD_RESPONSE_BYTES / 3)) };
    const { adapter } = adapterWith(detail, oversized);
    await expect(adapter.getReproductionCase(query)).rejects.toBeInstanceOf(
      ReviewControlResponseTooLargeError,
    );
  });
});
