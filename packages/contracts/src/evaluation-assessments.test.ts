import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, describe, expect, it } from "vitest";
import {
  type EvaluationAssessmentCaseReadQuery,
  type EvaluationAssessmentCaseV1,
  EvaluationAssessmentCaseV1Schema,
  type EvaluationAssessmentListV1,
  EvaluationAssessmentListV1Schema,
  type EvaluationAssessmentPublishRequest,
  type EvaluationAssessmentReadQuery,
  type EvaluationAssessmentScope,
  type EvaluationAssessmentSummaryV1,
  EvaluationAssessmentSummaryV1Schema,
  type EvaluationScorePreviewV1,
  type EvaluationScoringSummaryV1,
  getEvaluationAssessmentCaseIssues,
  getEvaluationAssessmentCaseReadQueryIssues,
  getEvaluationAssessmentListIssues,
  getEvaluationAssessmentListQueryIssues,
  getEvaluationAssessmentPublishRequestIssues,
  getEvaluationAssessmentPublishResponseIssues,
  getEvaluationAssessmentReadQueryIssues,
  getEvaluationAssessmentScopeIssues,
  getEvaluationAssessmentSummaryIssues,
  getEvaluationScorePreviewIssues,
  getEvaluationScoringSummaryIssues,
  maximumEvaluationAssessmentReadUtf8Bytes,
  maximumEvaluationAssessmentReceiptUtf8Bytes,
} from "./evaluation-assessments.js";
import type {
  EvaluationArmAggregate,
  EvaluationCaseScore,
  EvaluationRatio,
} from "./evaluation-scoring.js";

const now = "2026-09-08T01:00:00.000Z";
const digest = "a".repeat(64);
const author = { issuer: "https://identity.example", subject: "reviewer-1" };
const originalDateTime = FormatRegistry.Get("date-time");
afterAll(() => {
  if (originalDateTime === undefined) FormatRegistry.Delete("date-time");
  else FormatRegistry.Set("date-time", originalDateTime);
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The fixture entry is missing.");
  return value;
}
function scope(): EvaluationAssessmentScope {
  return { repositoryId: "repository-1", evaluationId: "evaluation-1" };
}
function readQuery(): EvaluationAssessmentReadQuery {
  return { ...scope(), assessmentId: "assessment-1" };
}
function caseQuery(): EvaluationAssessmentCaseReadQuery {
  return { ...readQuery(), caseId: "case-1" };
}
function ratio(numerator = 0, denominator = 0, value: number | null = null): EvaluationRatio {
  return { numerator, denominator, value };
}
// Synthetic read projections exercise the HTTP contract without claiming scorer input authority.
function aggregate(): EvaluationArmAggregate {
  return {
    coverage: {
      applicableCases: 1,
      notApplicableCases: 0,
      completedCases: 0,
      pendingCases: 0,
      notRunCases: 1,
      failedCases: 0,
      blockedCases: 0,
      cancelledCases: 0,
      invalidCases: 0,
      execution: ratio(0, 1, 0),
      applicableCriteria: 0,
      scoredCriteria: 0,
      unmappedCriteria: 0,
      unavailableCriteria: 0,
      notRunCriteria: 0,
      notApplicableCriteria: 0,
      checks: ratio(),
      availableModels: 0,
      models: ratio(0, 1, 0),
      completeAnnotationCases: 0,
      partialAnnotationCases: 0,
      unlabeledCases: 1,
      provisionalFindingCases: 0,
    },
    quality: {
      correctChecks: 0,
      incorrectChecks: 0,
      checkAgreement: ratio(),
      truePositives: 0,
      falsePositives: 0,
      duplicates: 0,
      unjudged: 0,
      falseNegatives: 0,
      unresolvedExpected: 0,
      knownPositiveRecall: ratio(),
      precision: ratio(),
      recall: ratio(),
      provisional: true,
    },
  };
}
function scoringSummary(
  rulesVersion: EvaluationScoringSummaryV1["rulesVersion"] = "explicit-matching-v2",
): EvaluationScoringSummaryV1 {
  const paired = () => ({
    compared: 0,
    improved: 0,
    regressed: 0,
    unchanged: 0,
    coverageImproved: 0,
    coverageRegressed: 0,
    unavailable: 0,
    notApplicable: 0,
    coverage: ratio(),
  });
  return {
    rulesVersion,
    planDigest: digest,
    baseline: aggregate(),
    candidate: aggregate(),
    paired: { criteria: paired(), findings: paired() },
  };
}
function preview(): EvaluationScorePreviewV1 {
  return {
    schemaVersion: "EvaluationScorePreviewV1",
    ...scope(),
    generatedAt: now,
    assessmentVersion: 0,
    selectionDigest: "b".repeat(64),
    scoringPlanDigest: digest,
    observationDigest: "c".repeat(64),
    adjudicationDigest: "d".repeat(64),
    inputDigest: "e".repeat(64),
    summary: scoringSummary(),
    caseIds: ["case-1"],
  };
}
function publishRequest(): EvaluationAssessmentPublishRequest {
  return {
    changeId: "publish-assessment-1",
    expectedVersion: 0,
    expectedInputDigest: "e".repeat(64),
  };
}
function summary(
  version = 1,
  scorerVersion: EvaluationScoringSummaryV1["rulesVersion"] = "explicit-matching-v2",
): EvaluationAssessmentSummaryV1 {
  return {
    schemaVersion: "EvaluationAssessmentSummaryV1",
    ...scope(),
    assessmentId: `assessment-${version}`,
    version,
    scorerVersion,
    scoringPlanDigest: digest,
    observationDigest: "c".repeat(64),
    adjudicationDigest: "d".repeat(64),
    reportDigest: "f".repeat(64),
    createdAt: now,
    createdBy: { ...author },
    summary: scoringSummary(scorerVersion),
    caseIds: ["case-1"],
  };
}
function list(page = 1, pageSize = 2, total = 3): EvaluationAssessmentListV1 {
  const offset = (page - 1) * pageSize;
  return {
    schemaVersion: "EvaluationAssessmentListV1",
    ...scope(),
    page,
    pageSize,
    total,
    items: Array.from({ length: Math.min(pageSize, Math.max(0, total - offset)) }, (_, index) =>
      summary(total - offset - index),
    ),
  };
}
function caseScore(): EvaluationCaseScore {
  const arm = (name: "baseline" | "candidate"): EvaluationCaseScore["baseline"] => ({
    cellId: `cell-${name}`,
    runId: `run-${name}`,
    requestId: `request-${name}`,
    executionState: "not_run",
    executionReason: "No execution was selected.",
    result: null,
    criteria: [],
    findings: {
      annotation: "unlabeled",
      state: "unavailable",
      reason: "The model was not run.",
      modelAvailable: false,
      expected: [],
      occurrences: [],
      truePositives: 0,
      falsePositives: 0,
      duplicates: 0,
      unjudged: 0,
      falseNegatives: 0,
      unresolvedExpected: 0,
      knownPositiveRecall: ratio(),
      precision: ratio(),
      recall: ratio(),
    },
  });
  return {
    caseId: "case-1",
    applicable: true,
    baseline: arm("baseline"),
    candidate: arm("candidate"),
    paired: {
      criteria: [],
      findings: [],
      modelCoverage: "unavailable",
      falsePositiveDelta: null,
      duplicateDelta: null,
    },
  };
}
function caseDetail(): EvaluationAssessmentCaseV1 {
  const scored = caseScore();
  const value: EvaluationAssessmentCaseV1 = {
    schemaVersion: "EvaluationAssessmentCaseV1",
    scope: caseQuery(),
    reportDigest: "f".repeat(64),
    scoringPlanDigest: digest,
    caseTitle: "The original compiler regression",
    expectation: {
      caseId: "case-1",
      sourceDigest: "b".repeat(64),
      baselineBinding: {
        cellId: scored.baseline.cellId,
        runId: scored.baseline.runId,
        requestId: scored.baseline.requestId,
      },
      candidateBinding: {
        cellId: scored.candidate.cellId,
        runId: scored.candidate.runId,
        requestId: scored.candidate.requestId,
      },
      applicability: { state: "applicable" },
      criteria: [
        {
          criterionId: "criterion-1",
          description: "The compiler detects the known failure.",
          applicability: { state: "applicable" },
          expectedOutcome: "failed",
          baselineCheckId: "profile-baseline:build",
          candidateCheckId: "profile-candidate:build",
        },
      ],
      findings: {
        annotation: "complete",
        expected: [
          { expectedFindingId: "expected-1", description: "The known compiler error is reported." },
        ],
      },
    },
    case: scored,
  };
  for (const arm of ["baseline", "candidate"] as const) {
    scored[arm].criteria = [
      {
        criterionId: "criterion-1",
        checkId: `profile-${arm}:build`,
        state: "not_run",
        actualOutcome: null,
        reason: "The mapped check has not run.",
      },
    ];
    scored[arm].findings.annotation = "complete";
    scored[arm].findings.expected = [
      {
        expectedFindingId: "expected-1",
        state: "unresolved",
        occurrenceKey: null,
        adjudicationId: null,
      },
    ];
    scored[arm].findings.unresolvedExpected = 1;
    scored[arm].findings.knownPositiveRecall = ratio(0, 1);
    scored[arm].findings.recall = ratio(0, 1);
  }
  scored.paired.criteria = [{ criterionId: "criterion-1", change: "unavailable" }];
  scored.paired.findings = [{ expectedFindingId: "expected-1", change: "unavailable" }];
  return value;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function fillTimestamp(value: object, previous: string, maximum: number): string {
  const remaining = maximum - bytes(value);
  return previous.replace(".000Z", `.${"0".repeat(remaining + 3)}Z`);
}

function caseAtByteLimit(): EvaluationAssessmentCaseV1 {
  const value = caseDetail();
  value.expectation.criteria = Array.from({ length: 96 }, (_, index) => ({
    criterionId: `criterion-${index}`,
    description: "r",
    applicability: { state: "applicable" },
    expectedOutcome: "failed",
    baselineCheckId: `profile-baseline:check-${index}`,
    candidateCheckId: `profile-candidate:check-${index}`,
  }));
  value.expectation.findings = {
    annotation: "complete",
    expected: Array.from({ length: 64 }, (_, index) => ({
      expectedFindingId: `expected-${index}`,
      description: "r",
    })),
  };
  for (const arm of ["baseline", "candidate"] as const) {
    value.case[arm].criteria = value.expectation.criteria.map((entry) => ({
      criterionId: entry.criterionId,
      checkId: entry[`${arm}CheckId`],
      state: "not_run",
      actualOutcome: null,
      reason: "r",
    }));
    value.case[arm].findings.expected = value.expectation.findings.expected.map((entry) => ({
      expectedFindingId: entry.expectedFindingId,
      state: "unresolved",
      occurrenceKey: null,
      adjudicationId: null,
    }));
    value.case[arm].findings.unresolvedExpected = 64;
    value.case[arm].findings.knownPositiveRecall = ratio(0, 64);
    value.case[arm].findings.recall = ratio(0, 64);
  }
  value.case.paired.criteria = value.expectation.criteria.map((entry) => ({
    criterionId: entry.criterionId,
    change: "unavailable",
  }));
  value.case.paired.findings = value.expectation.findings.expected.map((entry) => ({
    expectedFindingId: entry.expectedFindingId,
    change: "unavailable",
  }));
  let remaining = maximumEvaluationAssessmentReadUtf8Bytes - bytes(value);
  const fill = (text: string): string => {
    const multibyte = Math.min(2048 - text.length, Math.floor(remaining / 3));
    remaining -= multibyte * 3;
    const ascii = Math.min(2048 - text.length - multibyte, remaining);
    remaining -= ascii;
    return `${text}${"雪".repeat(multibyte)}${"x".repeat(ascii)}`;
  };
  for (const criterion of value.expectation.criteria)
    criterion.description = fill(criterion.description);
  for (const arm of ["baseline", "candidate"] as const)
    for (const criterion of value.case[arm].criteria)
      criterion.reason = fill(criterion.reason ?? "r");
  for (const finding of value.expectation.findings.expected)
    finding.description = fill(finding.description);
  if (remaining !== 0) throw new Error("The fixture could not fill the complete case byte budget.");
  return value;
}

describe("assessment selection and publish requests", () => {
  it("requires the complete exact scope at each read level", () => {
    for (const [make, validate] of [
      [scope, getEvaluationAssessmentScopeIssues],
      [readQuery, getEvaluationAssessmentReadQueryIssues],
      [caseQuery, getEvaluationAssessmentCaseReadQueryIssues],
    ] as const) {
      const value = make();
      const original = structuredClone(value);
      expect(validate(value)).toEqual([]);
      expect(value).toEqual(original);
      for (const field of Object.keys(value)) {
        const missing: Record<string, unknown> = { ...value };
        delete missing[field];
        expect(validate(missing).length, field).toBeGreaterThan(0);
        for (const invalid of [
          "",
          "x".repeat(129),
          " id",
          "id ",
          "id\n",
          "id\u007f",
          "id/other",
          ["id"],
          1,
          null,
        ])
          expect(validate({ ...value, [field]: invalid }).length, field).toBeGreaterThan(0);
      }
      expect(validate({ ...value, actor: author }).length).toBeGreaterThan(0);
    }
    expect(getEvaluationAssessmentReadQueryIssues(caseQuery()).length).toBeGreaterThan(0);
  });

  it("accepts only an explicit change, compare-and-swap version, and expected input digest", () => {
    const value = publishRequest();
    expect(getEvaluationAssessmentPublishRequestIssues(value)).toEqual([]);
    expect(
      getEvaluationAssessmentPublishRequestIssues({
        ...value,
        expectedVersion: Number.MAX_SAFE_INTEGER - 1,
      }),
    ).toEqual([]);
    for (const expectedVersion of [-1, 0.5, "0", null, undefined, Number.MAX_SAFE_INTEGER])
      expect(
        getEvaluationAssessmentPublishRequestIssues({ ...value, expectedVersion }).length,
      ).toBeGreaterThan(0);
    for (const field of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[field];
      expect(getEvaluationAssessmentPublishRequestIssues(missing).length).toBeGreaterThan(0);
    }
  });

  it.each([
    "observations",
    "adjudications",
    "report",
    "summary",
    "cases",
    "caseTitle",
    "expectation",
    "scorerVersion",
    "resultId",
    "selectionDigest",
    "inputDigest",
    "actor",
    "createdAt",
    "replayOnly",
  ])("does not accept client-owned scorer input or authority: %s", (field) => {
    expect(
      getEvaluationAssessmentPublishRequestIssues({ ...publishRequest(), [field]: [] }).length,
    ).toBeGreaterThan(0);
  });

  it("bounds list pagination and rejects coerced, unsafe, or extra filters", () => {
    for (const query of [
      {},
      { page: 1, pageSize: 50 },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 1 },
    ])
      expect(getEvaluationAssessmentListQueryIssues(query)).toEqual([]);
    for (const query of [
      { page: 0 },
      { page: "1" },
      { page: 1.5 },
      { pageSize: 0 },
      { pageSize: 51 },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 2 },
      { assessmentId: "assessment-1" },
      { scorerVersion: "explicit-matching-v1" },
    ])
      expect(getEvaluationAssessmentListQueryIssues(query).length).toBeGreaterThan(0);
  });
});

describe("bounded score preview and immutable summaries", () => {
  it("retains previews and published summaries without returning complete snapshots", () => {
    const previewValue = preview();
    const summaryValue = summary();
    const before = structuredClone([previewValue, summaryValue]);
    expect(getEvaluationScoringSummaryIssues(scoringSummary())).toEqual([]);
    expect(getEvaluationScorePreviewIssues(previewValue)).toEqual([]);
    expect(getEvaluationAssessmentSummaryIssues(summaryValue)).toEqual([]);
    expect(getEvaluationAssessmentPublishResponseIssues(summaryValue)).toEqual([]);
    expect([previewValue, summaryValue]).toEqual(before);
    for (const extra of [
      { cases: [caseScore()] },
      { observations: [] },
      { adjudications: [] },
      { report: {} },
    ]) {
      expect(getEvaluationScorePreviewIssues({ ...previewValue, ...extra }).length).toBeGreaterThan(
        0,
      );
      expect(
        getEvaluationAssessmentSummaryIssues({ ...summaryValue, ...extra }).length,
      ).toBeGreaterThan(0);
    }
    expect(
      getEvaluationScoringSummaryIssues({
        ...scoringSummary(),
        schemaVersion: "EvaluationScoringReportV1",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationScoringSummaryIssues({ ...scoringSummary(), cases: [caseScore()] }).length,
    ).toBeGreaterThan(0);
  });

  it("does not add transient selection or input digests to persisted summaries", () => {
    for (const field of ["selectionDigest", "inputDigest", "generatedAt", "expectedInputDigest"])
      expect(
        getEvaluationAssessmentSummaryIssues({ ...summary(), [field]: digest }).length,
      ).toBeGreaterThan(0);
  });

  it("preserves both historical rule versions and checks the stored scorer identity", () => {
    for (const rules of ["explicit-matching-v1", "explicit-matching-v2"] as const) {
      expect(getEvaluationScoringSummaryIssues(scoringSummary(rules))).toEqual([]);
      expect(getEvaluationAssessmentSummaryIssues(summary(1, rules))).toEqual([]);
      expect(getEvaluationAssessmentPublishResponseIssues(summary(1, rules))).toEqual([]);
    }
    const mismatch = { ...summary(), scorerVersion: "explicit-matching-v1" };
    expect(Value.Check(EvaluationAssessmentSummaryV1Schema, mismatch)).toBe(true);
    expect(getEvaluationAssessmentSummaryIssues(mismatch).length).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentSummaryIssues({ ...summary(), scorerVersion: "explicit-matching-v3" })
        .length,
    ).toBeGreaterThan(0);
  });

  it("requires summary plan digests to match the enclosing preview or assessment", () => {
    expect(
      getEvaluationScorePreviewIssues({ ...preview(), scoringPlanDigest: "b".repeat(64) }).length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentSummaryIssues({ ...summary(), scoringPlanDigest: "b".repeat(64) })
        .length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentPublishResponseIssues({
        ...summary(),
        summary: { ...scoringSummary(), planDigest: "b".repeat(64) },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("requires a complete unique case identity list bounded to 32 entries", () => {
    const complete = Array.from({ length: 32 }, (_, index) => `case-${index}`);
    for (const [make, validate] of [
      [preview, getEvaluationScorePreviewIssues],
      [summary, getEvaluationAssessmentSummaryIssues],
    ] as const) {
      expect(validate({ ...make(), caseIds: complete })).toEqual([]);
      for (const caseIds of [
        [],
        ["case-1", "case-1"],
        [...complete, "excess-case"],
        ["case-1\n"],
        [" case-1"],
      ])
        expect(validate({ ...make(), caseIds }).length).toBeGreaterThan(0);
    }
  });

  it("retains final safe read versions and rejects unsupported identity or digest representations", () => {
    expect(
      getEvaluationScorePreviewIssues({ ...preview(), assessmentVersion: Number.MAX_SAFE_INTEGER }),
    ).toEqual([]);
    expect(getEvaluationAssessmentSummaryIssues(summary(Number.MAX_SAFE_INTEGER))).toEqual([]);
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        getEvaluationAssessmentSummaryIssues({ ...summary(), version }).length,
      ).toBeGreaterThan(0);
    for (const field of [
      "selectionDigest",
      "scoringPlanDigest",
      "observationDigest",
      "adjudicationDigest",
      "inputDigest",
    ])
      for (const invalid of ["A".repeat(64), "a".repeat(63), null])
        expect(
          getEvaluationScorePreviewIssues({ ...preview(), [field]: invalid }).length,
        ).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentSummaryIssues({
        ...summary(),
        createdBy: { ...author, subject: " reviewer-1" },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentSummaryIssues({
        ...summary(),
        createdBy: { ...author, issuer: "issuer\u007f" },
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("assessment history and per-case reads", () => {
  it("returns complete latest-first windows with consecutive versions", () => {
    for (const value of [
      list(),
      list(2),
      list(3),
      list(1, 50, 50),
      list(1, 20, 0),
      list(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
    ])
      expect(getEvaluationAssessmentListIssues(value)).toEqual([]);
    const mixed = list();
    mixed.items[1] = summary(2, "explicit-matching-v1");
    expect(getEvaluationAssessmentListIssues(mixed)).toEqual([]);
  });

  it("rejects omitted, repeated, out-of-order, or foreign assessment versions", () => {
    const mutations: ((value: EvaluationAssessmentListV1) => void)[] = [
      (value) => {
        value.items.pop();
      },
      (value) => {
        value.items.reverse();
      },
      (value) => {
        value.total += 1;
      },
      (value) => {
        required(value.items[0]).version = 4;
      },
      (value) => {
        required(value.items[1]).assessmentId = required(value.items[0]).assessmentId;
      },
      (value) => {
        required(value.items[0]).repositoryId = "other-repository";
      },
      (value) => {
        required(value.items[0]).evaluationId = "other-evaluation";
      },
      (value) => {
        required(value.items[0]).summary.planDigest = "b".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const value = list();
      mutate(value);
      expect(Value.Check(EvaluationAssessmentListV1Schema, value)).toBe(true);
      expect(getEvaluationAssessmentListIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("returns only the selected case and preserves nullable unavailable or provisional results", () => {
    const value = caseDetail();
    const original = structuredClone(value);
    expect(getEvaluationAssessmentCaseIssues(value)).toEqual([]);
    expect(value).toEqual(original);
    expect(value.caseTitle).toBe("The original compiler regression");
    expect(value.expectation.criteria[0]).toMatchObject({
      description: "The compiler detects the known failure.",
      expectedOutcome: "failed",
      baselineCheckId: "profile-baseline:build",
    });
    expect(value.expectation.findings.expected[0]).toEqual({
      expectedFindingId: "expected-1",
      description: "The known compiler error is reported.",
    });
    expect(
      getEvaluationAssessmentCaseIssues({ ...value, case: { ...value.case, caseId: "other-case" } })
        .length,
    ).toBeGreaterThan(0);
    for (const extra of [
      { cases: [caseScore()] },
      { observations: [] },
      { report: { cases: [caseScore()] } },
      { available: true },
    ])
      expect(getEvaluationAssessmentCaseIssues({ ...value, ...extra }).length).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentCaseIssues({ ...value, scope: { ...value.scope, actor: author } })
        .length,
    ).toBeGreaterThan(0);
  });

  it("requires a bounded published case title and the complete frozen expectation", () => {
    for (const field of ["caseTitle", "expectation"]) {
      const value: Record<string, unknown> = { ...caseDetail() };
      delete value[field];
      expect(getEvaluationAssessmentCaseIssues(value).length).toBeGreaterThan(0);
    }
    for (const caseTitle of ["", " \n\t", "bad\0title", "x".repeat(257)])
      expect(
        getEvaluationAssessmentCaseIssues({ ...caseDetail(), caseTitle }).length,
      ).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentCaseIssues({ ...caseDetail(), caseTitle: "x".repeat(256) }),
    ).toEqual([]);
    const value = caseDetail();
    expect(
      getEvaluationAssessmentCaseIssues({
        ...value,
        expectation: { ...value.expectation, sourceId: "not-in-scoring-case" },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentCaseIssues({ ...value, expectation: { caseId: value.scope.caseId } })
        .length,
    ).toBeGreaterThan(0);
  });

  it("binds the frozen expectation to the selected case and its applicability", () => {
    const value = caseDetail();
    value.expectation.caseId = "other-case";
    expect(Value.Check(EvaluationAssessmentCaseV1Schema, value)).toBe(true);
    expect(getEvaluationAssessmentCaseIssues(value).length).toBeGreaterThan(0);
    const notApplicable = caseDetail();
    notApplicable.expectation.applicability = {
      state: "not_applicable",
      reason: "The frozen example does not apply to this workflow.",
    };
    expect(getEvaluationAssessmentCaseIssues(notApplicable).length).toBeGreaterThan(0);
    notApplicable.case.applicable = false;
    expect(getEvaluationAssessmentCaseIssues(notApplicable)).toEqual([]);
  });

  it.each(["baseline", "candidate"] as const)(
    "rejects a different frozen %s cell, run, or request binding",
    (arm) => {
      for (const field of ["cellId", "runId", "requestId"] as const) {
        const value = caseDetail();
        value.expectation[`${arm}Binding`][field] = "different-identity";
        expect(Value.Check(EvaluationAssessmentCaseV1Schema, value)).toBe(true);
        expect(getEvaluationAssessmentCaseIssues(value).length).toBeGreaterThan(0);
      }
    },
  );

  it("requires complete unique criterion IDs in both arms and the paired projection", () => {
    const projections: ((value: EvaluationAssessmentCaseV1) => { criterionId: string }[])[] = [
      (value) => value.case.baseline.criteria,
      (value) => value.case.candidate.criteria,
      (value) => value.case.paired.criteria,
    ];
    for (const projection of projections) {
      for (const mutation of ["missing", "foreign", "duplicate"] as const) {
        const value = caseDetail();
        const entries = projection(value);
        if (mutation === "missing") entries.pop();
        else if (mutation === "foreign") required(entries[0]).criterionId = "other-criterion";
        else entries.push({ ...required(entries[0]) });
        expect(Value.Check(EvaluationAssessmentCaseV1Schema, value)).toBe(true);
        expect(getEvaluationAssessmentCaseIssues(value).length).toBeGreaterThan(0);
      }
    }
    const repeated = caseDetail();
    repeated.expectation.criteria.push(structuredClone(required(repeated.expectation.criteria[0])));
    for (const projection of projections)
      projection(repeated).push({ ...required(projection(repeated)[0]) });
    expect(getEvaluationAssessmentCaseIssues(repeated).length).toBeGreaterThan(0);
  });

  it("requires complete unique expected finding IDs even when model scoring is unavailable", () => {
    const projections: ((value: EvaluationAssessmentCaseV1) => { expectedFindingId: string }[])[] =
      [
        (value) => value.case.baseline.findings.expected,
        (value) => value.case.candidate.findings.expected,
        (value) => value.case.paired.findings,
      ];
    for (const projection of projections) {
      for (const mutation of ["missing", "foreign", "duplicate"] as const) {
        const value = caseDetail();
        const entries = projection(value);
        if (mutation === "missing") entries.pop();
        else if (mutation === "foreign") required(entries[0]).expectedFindingId = "other-expected";
        else entries.push({ ...required(entries[0]) });
        expect(Value.Check(EvaluationAssessmentCaseV1Schema, value)).toBe(true);
        expect(getEvaluationAssessmentCaseIssues(value).length).toBeGreaterThan(0);
      }
    }
    const repeated = caseDetail();
    if (repeated.expectation.findings.annotation === "unlabeled")
      throw new Error("The fixture requires labeled findings.");
    repeated.expectation.findings.expected.push(
      structuredClone(required(repeated.expectation.findings.expected[0])),
    );
    for (const projection of projections)
      projection(repeated).push({ ...required(projection(repeated)[0]) });
    expect(getEvaluationAssessmentCaseIssues(repeated).length).toBeGreaterThan(0);
  });

  it("matches expectation sets by identity without imposing display order or rescoring either rules version", () => {
    const value = caseDetail();
    value.expectation.criteria.push({
      ...required(value.expectation.criteria[0]),
      criterionId: "criterion-2",
      baselineCheckId: "profile-baseline:test",
      candidateCheckId: "profile-candidate:test",
    });
    if (value.expectation.findings.annotation === "unlabeled")
      throw new Error("The fixture requires labeled findings.");
    value.expectation.findings.expected.push({
      expectedFindingId: "expected-2",
      description: "A second known regression.",
    });
    for (const arm of ["baseline", "candidate"] as const) {
      value.case[arm].criteria.push({
        ...required(value.case[arm].criteria[0]),
        criterionId: "criterion-2",
        checkId: `profile-${arm}:test`,
      });
      value.case[arm].findings.expected.push({
        ...required(value.case[arm].findings.expected[0]),
        expectedFindingId: "expected-2",
      });
      value.case[arm].findings.unresolvedExpected = 2;
      value.case[arm].findings.knownPositiveRecall = ratio(0, 2);
      value.case[arm].findings.recall = ratio(0, 2);
    }
    value.case.paired.criteria.push({ criterionId: "criterion-2", change: "unavailable" });
    value.case.paired.findings.push({ expectedFindingId: "expected-2", change: "unavailable" });
    value.case.candidate.criteria.reverse();
    value.case.baseline.findings.expected.reverse();
    value.case.paired.findings.reverse();
    expect(getEvaluationAssessmentCaseIssues(value)).toEqual([]);
  });

  it("rejects malformed nested case metrics without claiming to recompute scorer results", () => {
    const value = caseDetail();
    value.case.baseline.findings.precision.value = 2;
    expect(getEvaluationAssessmentCaseIssues(value).length).toBeGreaterThan(0);
    const malformed = caseDetail();
    malformed.case.candidate.cellId += "\n";
    expect(getEvaluationAssessmentCaseIssues(malformed).length).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentCaseIssues({ ...caseDetail(), reportDigest: "g".repeat(64) }).length,
    ).toBeGreaterThan(0);
  });
});

describe("strict assessment JSON and response budgets", () => {
  it("rejects non-JSON inputs without evaluating accessors or accepting discarded properties", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.defineProperty(publishRequest(), "changeId", {
      enumerable: true,
      get() {
        throw new Error("The getter must not execute.");
      },
    });
    const inaccessible = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("The proxy cannot be inspected.");
        },
      },
    );
    for (const value of [
      null,
      undefined,
      [],
      { ...publishRequest(), changeId: "bad\ud800" },
      { ...publishRequest(), extra: 1n },
      { ...publishRequest(), expectedVersion: Number.POSITIVE_INFINITY },
      { ...publishRequest(), extra: new Date(now) },
      { ...publishRequest(), [Symbol("hidden")]: true },
      Object.defineProperty(publishRequest(), "hidden", { value: true }),
      circular,
      accessor,
      inaccessible,
    ]) {
      expect(() => getEvaluationAssessmentPublishRequestIssues(value)).not.toThrow();
      expect(getEvaluationAssessmentPublishRequestIssues(value).length).toBeGreaterThan(0);
    }
    expect(
      getEvaluationAssessmentPublishRequestIssues(
        Object.assign(Object.create(null), publishRequest()),
      ),
    ).toEqual([]);
    for (const items of [new Array(2), Object.assign(list().items, { hidden: true })])
      expect(getEvaluationAssessmentListIssues({ ...list(), items }).length).toBeGreaterThan(0);
    expect(
      getEvaluationAssessmentCaseIssues({
        ...caseDetail(),
        scope: { ...caseQuery(), caseId: "bad\ud800" },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps the 256 KiB publication receipt limit distinct from the 2 MiB summary read limit", () => {
    const value = summary();
    value.createdAt = fillTimestamp(
      value,
      value.createdAt,
      maximumEvaluationAssessmentReceiptUtf8Bytes,
    );
    expect(bytes(value)).toBe(maximumEvaluationAssessmentReceiptUtf8Bytes);
    expect(getEvaluationAssessmentPublishResponseIssues(value)).toEqual([]);
    value.createdBy.subject += "雪";
    expect(bytes(value)).toBe(maximumEvaluationAssessmentReceiptUtf8Bytes + 3);
    expect(Value.Check(EvaluationAssessmentSummaryV1Schema, value)).toBe(true);
    expect(getEvaluationAssessmentPublishResponseIssues(value).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
    expect(getEvaluationAssessmentSummaryIssues(value)).toEqual([]);
    const maximum = summary();
    maximum.createdAt = fillTimestamp(
      maximum,
      maximum.createdAt,
      maximumEvaluationAssessmentReadUtf8Bytes,
    );
    expect(bytes(maximum)).toBe(maximumEvaluationAssessmentReadUtf8Bytes);
    expect(getEvaluationAssessmentSummaryIssues(maximum)).toEqual([]);
    maximum.createdBy.subject += "雪";
    expect(getEvaluationAssessmentSummaryIssues(maximum).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
  });

  it("bounds complete preview and history responses rather than only individual entries", () => {
    const value = preview();
    value.generatedAt = fillTimestamp(
      value,
      value.generatedAt,
      maximumEvaluationAssessmentReadUtf8Bytes,
    );
    expect(getEvaluationScorePreviewIssues(value)).toEqual([]);
    value.generatedAt = value.generatedAt.replace(/Z$/u, "0Z");
    expect(getEvaluationScorePreviewIssues(value).join(" ")).toMatch(/aggregate UTF-8 byte limit/u);
    const history = list();
    const first = required(history.items[0]);
    first.createdAt = fillTimestamp(
      history,
      first.createdAt,
      maximumEvaluationAssessmentReadUtf8Bytes,
    );
    expect(bytes(history)).toBe(maximumEvaluationAssessmentReadUtf8Bytes);
    expect(getEvaluationAssessmentListIssues(history)).toEqual([]);
    required(history.items[1]).createdBy.subject += "雪";
    expect(getEvaluationAssessmentListIssues(history).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
  });

  it("bounds a complete case including frozen expectation text to 2 MiB", () => {
    const value = caseAtByteLimit();
    expect(bytes(value)).toBe(maximumEvaluationAssessmentReadUtf8Bytes);
    expect(getEvaluationAssessmentCaseIssues(value)).toEqual([]);
    const finding = required(
      value.expectation.findings.expected.find((entry) => entry.description.length < 2048),
    );
    finding.description += "雪";
    expect(bytes(value)).toBe(maximumEvaluationAssessmentReadUtf8Bytes + 3);
    expect(Value.Check(EvaluationAssessmentCaseV1Schema, value)).toBe(true);
    expect(getEvaluationAssessmentCaseIssues(value).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
  });
});
