import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertEvaluationSuiteCaseDetail,
  assertEvaluationSuiteCaseList,
  assertEvaluationSuiteCaseSummary,
  type EvaluationSuiteCaseDetailV1,
  EvaluationSuiteCaseDetailV1Schema,
  type EvaluationSuiteCaseListV1,
  EvaluationSuiteCaseListV1Schema,
  type EvaluationSuiteCaseSummaryV1,
  EvaluationSuiteCaseSummaryV1Schema,
  getEvaluationSuiteCaseDetailIssues,
  getEvaluationSuiteCaseListIssues,
  getEvaluationSuiteCaseSummaryIssues,
  maximumEvaluationSuiteCaseDetailUtf8Bytes,
  maximumEvaluationSuiteCaseExpectationUtf8Bytes,
  maximumEvaluationSuiteCaseListUtf8Bytes,
} from "./evaluation-cases.js";
import {
  maximumEvaluationCaseCount,
  maximumEvaluationCriterionCount,
  maximumEvaluationExpectedFindingCount,
} from "./evaluation-scoring.js";
import type { EvaluationSourceSummaryV1 } from "./evaluation-source.js";

const now = "2026-09-08T01:00:00.000Z";
const originalDateTime = FormatRegistry.Get("date-time");
beforeAll(() => FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value))));
afterAll(() => {
  if (originalDateTime === undefined) FormatRegistry.Delete("date-time");
  else FormatRegistry.Set("date-time", originalDateTime);
});

const versionScope = {
  repositoryId: "repository-1",
  suiteId: "suite-1",
  versionId: "suite-version-1",
};
const manifestScope = {
  ...versionScope,
  sourceVersionId: "source-version-1",
  expectationVersionId: "expectation-version-1",
  sourceManifestSha256: "a".repeat(64),
  expectationManifestSha256: "b".repeat(64),
};

function source(): EvaluationSourceSummaryV1 {
  return {
    schemaVersion: "EvaluationSourceSummaryV1",
    id: "source-1",
    repositoryId: versionScope.repositoryId,
    workItemId: "work-item-1",
    revisionId: "revision-1",
    revisionKey: "c".repeat(64),
    sourceDigest: "d".repeat(64),
    workItemKind: "pull_request",
    number: 7,
    title: "A source title may differ from the assessment case title",
    createdAt: now,
    createdBy: { issuer: "https://identity.example.test", subject: "source-operator" },
  };
}

function expectation(): EvaluationSuiteCaseDetailV1["expectation"] {
  return {
    caseId: "case-1",
    title: "A complete negative example with a known build failure",
    applicability: { state: "applicable" },
    criteria: [
      {
        criterionId: "criterion-1",
        description: "The known compiler error is detected.",
        applicability: { state: "applicable" },
        expectedOutcome: "failed",
      },
    ],
    findings: { annotation: "complete", expected: [] },
  };
}

function summary(caseId = "case-1"): EvaluationSuiteCaseSummaryV1 {
  const expected = expectation();
  return {
    schemaVersion: "EvaluationSuiteCaseSummaryV1",
    ...versionScope,
    caseId,
    title: expected.title,
    sourceId: source().id,
    sourceDigest: source().sourceDigest,
    applicability: expected.applicability,
    criterionCount: expected.criteria.length,
    annotation: expected.findings.annotation,
    expectedFindingCount: expected.findings.expected.length,
  };
}

function list(): EvaluationSuiteCaseListV1 {
  return {
    schemaVersion: "EvaluationSuiteCaseListV1",
    ...manifestScope,
    items: [summary()],
    total: 1,
  };
}

function detail(): EvaluationSuiteCaseDetailV1 {
  return {
    schemaVersion: "EvaluationSuiteCaseDetailV1",
    ...manifestScope,
    caseId: "case-1",
    source: source(),
    expectation: expectation(),
  };
}

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("published evaluation suite case read contracts", () => {
  it("retains explicit frozen manifest identities and complete expected labels", () => {
    const value = detail();
    const original = structuredClone(value);
    expect(Value.Check(EvaluationSuiteCaseSummaryV1Schema, summary())).toBe(true);
    expect(Value.Check(EvaluationSuiteCaseListV1Schema, list())).toBe(true);
    expect(Value.Check(EvaluationSuiteCaseDetailV1Schema, value)).toBe(true);
    expect(getEvaluationSuiteCaseSummaryIssues(summary())).toEqual([]);
    expect(getEvaluationSuiteCaseListIssues(list())).toEqual([]);
    expect(getEvaluationSuiteCaseDetailIssues(value)).toEqual([]);
    assertEvaluationSuiteCaseSummary(summary());
    assertEvaluationSuiteCaseList(list());
    assertEvaluationSuiteCaseDetail(value);
    expect(value).toEqual(original);
    expect(value.expectation.criteria[0]?.expectedOutcome).toBe("failed");
    expect(value.expectation.findings).toEqual({ annotation: "complete", expected: [] });
    expect(value.source.title).not.toBe(value.expectation.title);
  });

  it("accepts complete negative, partial, unlabeled, and inapplicable frozen cases", () => {
    for (const annotation of ["complete", "partial", "unlabeled"] as const) {
      const value = detail();
      value.expectation.findings = { annotation, expected: [] };
      value.expectation.applicability = {
        state: "not_applicable",
        reason: "This platform is outside the frozen example scope.",
      };
      expect(getEvaluationSuiteCaseDetailIssues(value)).toEqual([]);
      expect(getEvaluationSuiteCaseSummaryIssues({ ...summary(), annotation })).toEqual([]);
    }
  });

  it("rejects nonzero expected findings for unlabeled summaries and detail labels", () => {
    expect(
      getEvaluationSuiteCaseSummaryIssues({
        ...summary(),
        annotation: "unlabeled",
        expectedFindingCount: 1,
      }),
    ).toContain("An unlabeled evaluation case cannot claim expected findings.");
    const value = detail();
    value.expectation.findings = {
      annotation: "unlabeled",
      expected: [{ expectedFindingId: "finding-1", description: "This was never labeled." }],
    };
    expect(getEvaluationSuiteCaseDetailIssues(value).length).toBeGreaterThan(0);
  });

  it.each([
    { criterionCount: -1 },
    { criterionCount: maximumEvaluationCriterionCount + 1 },
    { criterionCount: 1.5 },
    { expectedFindingCount: -1 },
    { expectedFindingCount: maximumEvaluationExpectedFindingCount + 1 },
    { annotation: "unknown" },
    { title: " " },
    { title: "" },
    { sourceDigest: "A".repeat(64) },
    { applicability: { state: "not_applicable" } },
  ])("rejects invalid summary counts, labels, or identities: %j", (changed) => {
    const value = { ...summary(), ...changed };
    expect(getEvaluationSuiteCaseSummaryIssues(value).length).toBeGreaterThan(0);
    expect(() => assertEvaluationSuiteCaseSummary(value)).toThrow(TypeError);
  });

  it("returns every immutable case once while allowing a source to be reused across cases", () => {
    const value = list();
    value.items = Array.from({ length: maximumEvaluationCaseCount }, (_, index) =>
      summary(`case-${index + 1}`),
    );
    value.total = maximumEvaluationCaseCount;
    expect(getEvaluationSuiteCaseListIssues(value)).toEqual([]);
    expect(new Set(value.items.map((entry) => entry.sourceId)).size).toBe(1);
    expect(getEvaluationSuiteCaseListIssues({ ...value, total: 31 }).length).toBeGreaterThan(0);
    expect(
      getEvaluationSuiteCaseListIssues({
        ...value,
        items: [...value.items, summary("case-33")],
        total: 33,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationSuiteCaseListIssues({ ...value, items: [], total: 0 }).length,
    ).toBeGreaterThan(0);
    expect(getEvaluationSuiteCaseListIssues({ ...value, page: 1 }).length).toBeGreaterThan(0);
    const duplicate = { ...list(), items: [summary(), summary()], total: 2 };
    expect(getEvaluationSuiteCaseListIssues(duplicate)).toContain(
      "Case identifiers must be unique within their scope.",
    );
  });

  it.each([
    { repositoryId: "repository-2" },
    { suiteId: "suite-2" },
    { versionId: "suite-version-2" },
  ])("binds every case list item to its immutable version scope: %j", (changed) => {
    const value = { ...list(), items: [{ ...summary(), ...changed }] };
    expect(getEvaluationSuiteCaseListIssues(value)).toContain(
      "Evaluation case summaries must belong to the requested repository, suite, and version.",
    );
    expect(() => assertEvaluationSuiteCaseList(value)).toThrow(TypeError);
  });

  it("validates summary semantics within list responses", () => {
    const value = list();
    value.items = [{ ...summary(), annotation: "unlabeled", expectedFindingCount: 1 }];
    expect(getEvaluationSuiteCaseListIssues(value)).toContain(
      "An unlabeled evaluation case cannot claim expected findings.",
    );
  });

  it("requires the published source and expectation manifest version identities and full hashes", () => {
    const { expectationVersionId: _omitted, ...missingIdentity } = detail();
    const { sourceManifestSha256: _digest, ...missingDigest } = list();
    expect(getEvaluationSuiteCaseDetailIssues(missingIdentity).length).toBeGreaterThan(0);
    expect(getEvaluationSuiteCaseListIssues(missingDigest).length).toBeGreaterThan(0);
    for (const changed of [
      { sourceVersionId: "" },
      { expectationVersionId: "../draft" },
      { sourceManifestSha256: "a".repeat(40) },
      { expectationManifestSha256: "B".repeat(64) },
    ]) {
      expect(
        getEvaluationSuiteCaseDetailIssues({ ...detail(), ...changed }).length,
      ).toBeGreaterThan(0);
      expect(getEvaluationSuiteCaseListIssues({ ...list(), ...changed }).length).toBeGreaterThan(0);
    }
  });

  it("binds detail labels to the requested case and the source to the repository", () => {
    const wrongCase = { ...detail(), caseId: "case-2" };
    expect(getEvaluationSuiteCaseDetailIssues(wrongCase)).toContain(
      "The frozen evaluation expectation must belong to the requested case.",
    );
    const wrongSource = { ...detail(), source: { ...source(), repositoryId: "repository-2" } };
    expect(getEvaluationSuiteCaseDetailIssues(wrongSource)).toContain(
      "The frozen evaluation source must belong to the requested repository.",
    );
    expect(() => assertEvaluationSuiteCaseDetail(wrongCase)).toThrow(TypeError);
    expect(() => assertEvaluationSuiteCaseDetail(wrongSource)).toThrow(TypeError);
  });

  it("rejects duplicate criterion and expected-finding identities within a case", () => {
    const value = detail();
    value.expectation.criteria.push(...structuredClone(value.expectation.criteria));
    expect(getEvaluationSuiteCaseDetailIssues(value)).toContain(
      "Criterion identifiers must be unique within their scope.",
    );
    const findings = detail();
    findings.expectation.findings = {
      annotation: "partial",
      expected: [
        { expectedFindingId: "finding-1", description: "The known defect." },
        { expectedFindingId: "finding-1", description: "The same identity was reused." },
      ],
    };
    expect(getEvaluationSuiteCaseDetailIssues(findings)).toContain(
      "Expected finding identifiers must be unique within their scope.",
    );
  });

  it("retains maximum-sized valid criterion and finding sets with full Unicode descriptions", () => {
    const value = detail();
    value.expectation.criteria = Array.from(
      { length: maximumEvaluationCriterionCount },
      (_, index) => ({
        criterionId: `criterion-${index + 1}`,
        description: "界".repeat(2_048),
        applicability: { state: "applicable" },
        expectedOutcome: "failed",
      }),
    );
    value.expectation.findings = {
      annotation: "complete",
      expected: Array.from({ length: maximumEvaluationExpectedFindingCount }, (_, index) => ({
        expectedFindingId: `finding-${index + 1}`,
        description: "界".repeat(2_048),
      })),
    };
    expect(byteLength(value.expectation)).toBeLessThan(
      maximumEvaluationSuiteCaseExpectationUtf8Bytes,
    );
    expect(byteLength(value)).toBeLessThan(maximumEvaluationSuiteCaseDetailUtf8Bytes);
    expect(getEvaluationSuiteCaseDetailIssues(value)).toEqual([]);
    value.expectation.criteria.push(...structuredClone(value.expectation.criteria.slice(0, 1)));
    expect(getEvaluationSuiteCaseDetailIssues(value).length).toBeGreaterThan(0);
    value.expectation.criteria.pop();
    value.expectation.findings.expected.push({
      expectedFindingId: "finding-extra",
      description: "Overflow.",
    });
    expect(getEvaluationSuiteCaseDetailIssues(value).length).toBeGreaterThan(0);
  });

  it("rejects source snapshots, draft substitutions, Worker mappings, and unknown fields", () => {
    const value = detail();
    for (const forged of [
      { ...value, draft: expectation() },
      { ...value, authorization: {} },
      { ...value, snapshot: {} },
      { ...value, source: { ...source(), body: "Fetch the source detail separately." } },
      { ...value, source: { ...source(), snapshot: {} } },
      { ...value, expectation: { ...expectation(), sourceId: "source-1" } },
      {
        ...value,
        expectation: {
          ...expectation(),
          criteria: [
            {
              criterionId: "criterion-1",
              description: "Frozen expectation.",
              applicability: { state: "applicable" },
              expectedOutcome: "failed",
              baselineCheckId: null,
            },
          ],
        },
      },
    ])
      expect(getEvaluationSuiteCaseDetailIssues(forged).length).toBeGreaterThan(0);
    for (const forged of [
      { ...summary(), expectation: expectation() },
      { ...summary(), source: source() },
      { ...summary(), body: "No full source body in a case summary." },
      { ...summary(), criteria: expectation().criteria },
    ])
      expect(getEvaluationSuiteCaseSummaryIssues(forged).length).toBeGreaterThan(0);
  });

  it("reuses source summary validation for exact operator identities", () => {
    const value = detail();
    value.source.createdBy.subject = " operator";
    expect(getEvaluationSuiteCaseDetailIssues(value)).toContain(
      "An evaluation source operator must have an exact nonempty identity.",
    );
  });

  it("rejects UTF-8 payload overflow for expectations, complete detail, and the case list", () => {
    const value = detail();
    value.expectation.title = "界".repeat(
      Math.ceil(maximumEvaluationSuiteCaseExpectationUtf8Bytes / 3),
    );
    expect(byteLength(value.expectation)).toBeGreaterThan(
      maximumEvaluationSuiteCaseExpectationUtf8Bytes,
    );
    expect(getEvaluationSuiteCaseDetailIssues(value).length).toBeGreaterThan(0);
    value.expectation.title += "界".repeat(64 * 1024);
    expect(getEvaluationSuiteCaseDetailIssues(value)).toEqual([
      expect.stringContaining("aggregate UTF-8 byte limit"),
    ]);
    const oversizedList = {
      ...list(),
      extra: "界".repeat(maximumEvaluationSuiteCaseListUtf8Bytes / 2),
    };
    expect(getEvaluationSuiteCaseListIssues(oversizedList)).toEqual([
      expect.stringContaining("aggregate UTF-8 byte limit"),
    ]);
  });

  it("returns issues for malformed Unicode, non-JSON values, and cyclic objects", () => {
    const cyclic: Record<string, unknown> = { ...detail() };
    cyclic.self = cyclic;
    for (const value of [
      cyclic,
      new Date(now),
      { ...detail(), missing: undefined },
      { ...detail(), [Symbol("hidden")]: true },
      { ...detail(), number: Number.NaN },
      { ...detail(), expectation: { ...expectation(), title: "\ud800" } },
    ])
      expect(getEvaluationSuiteCaseDetailIssues(value)).toEqual([
        expect.stringContaining("well-formed JSON"),
      ]);
    expect(getEvaluationSuiteCaseSummaryIssues({ ...summary(), title: "\ud800" })).toEqual([
      expect.stringContaining("well-formed JSON"),
    ]);
    expect(getEvaluationSuiteCaseListIssues({ ...list(), extra: "\ud800" })).toEqual([
      expect.stringContaining("well-formed JSON"),
    ]);
  });
});
