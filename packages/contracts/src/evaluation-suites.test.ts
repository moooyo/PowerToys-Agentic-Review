import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, describe, expect, it } from "vitest";

import {
  maximumEvaluationCaseCount,
  maximumEvaluationCriterionCount,
} from "./evaluation-scoring.js";
import {
  assertEvaluationExpectationManifest,
  assertEvaluationSourceManifest,
  assertEvaluationSuiteCreateRequest,
  assertEvaluationSuiteDetail,
  assertEvaluationSuiteDraft,
  assertEvaluationSuiteListQuery,
  assertEvaluationSuiteListResponse,
  assertEvaluationSuitePublication,
  assertEvaluationSuitePublishRequest,
  assertEvaluationSuiteSaveRequest,
  assertEvaluationSuiteSummary,
  assertEvaluationSuiteVersion,
  assertEvaluationSuiteVersionListResponse,
  type EvaluationExpectationManifestV1,
  EvaluationExpectationManifestV1Schema,
  type EvaluationSourceManifestV1,
  EvaluationSourceManifestV1Schema,
  type EvaluationSuiteCreateRequest,
  EvaluationSuiteCreateRequestSchema,
  type EvaluationSuiteDetailV1,
  EvaluationSuiteDetailV1Schema,
  type EvaluationSuiteDraft,
  type EvaluationSuiteDraftCase,
  EvaluationSuiteDraftCaseSchema,
  EvaluationSuiteDraftSchema,
  EvaluationSuiteListQuerySchema,
  EvaluationSuiteListResponseSchema,
  EvaluationSuitePublishRequestSchema,
  EvaluationSuiteSaveRequestSchema,
  type EvaluationSuiteSummaryV1,
  EvaluationSuiteSummaryV1Schema,
  EvaluationSuiteVersionListResponseSchema,
  type EvaluationSuiteVersionV1,
  EvaluationSuiteVersionV1Schema,
  getEvaluationExpectationManifestIssues,
  getEvaluationSourceManifestIssues,
  getEvaluationSuiteCreateRequestIssues,
  getEvaluationSuiteDetailIssues,
  getEvaluationSuiteDraftIssues,
  getEvaluationSuiteListQueryIssues,
  getEvaluationSuiteListResponseIssues,
  getEvaluationSuitePublicationIssues,
  getEvaluationSuitePublishRequestIssues,
  getEvaluationSuiteSaveRequestIssues,
  getEvaluationSuiteSummaryIssues,
  getEvaluationSuiteVersionIssues,
  getEvaluationSuiteVersionListResponseIssues,
  maximumEvaluationSourceManifestUtf8Bytes,
  maximumEvaluationSuitePageSize,
  maximumEvaluationSuiteUtf8Bytes,
} from "./evaluation-suites.js";
import { ValidationTargetValues, WorkflowKindValues } from "./platform-configuration.js";

const originalDateTime = FormatRegistry.Get("date-time");
afterAll(() => {
  if (originalDateTime === undefined) FormatRegistry.Delete("date-time");
  else FormatRegistry.Set("date-time", originalDateTime);
});

const now = "2026-09-08T01:00:00.000Z";
const actor = { issuer: "https://identity.example", subject: "operator-1" };
const digest = "a".repeat(64);

function draftCase(index = 1): EvaluationSuiteDraftCase {
  return {
    caseId: `case-${index}`,
    title: "A known negative example",
    sourceId: "source-1",
    applicability: { state: "applicable" },
    criteria: [
      {
        criterionId: "criterion-1",
        description: "The known build failure is detected.",
        applicability: { state: "applicable" },
        expectedOutcome: "failed",
      },
    ],
    findings: { annotation: "complete", expected: [] },
  };
}

function draft(): EvaluationSuiteDraft {
  return {
    name: "Compiler regressions",
    description: "Frozen build examples.",
    cases: [draftCase()],
  };
}

function summary(): EvaluationSuiteSummaryV1 {
  return {
    schemaVersion: "EvaluationSuiteSummaryV1",
    id: "suite-1",
    repositoryId: "repository-1",
    name: draft().name,
    description: draft().description,
    workflowKind: "pr_static_build",
    target: "headless",
    draftRevision: 1,
    caseCount: 1,
    latestVersionId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
  };
}

function detail(): EvaluationSuiteDetailV1 {
  return { ...summary(), draft: draft() };
}

function version(): EvaluationSuiteVersionV1 {
  return {
    schemaVersion: "EvaluationSuiteVersionV1",
    id: "suite-version-1",
    suiteId: "suite-1",
    repositoryId: "repository-1",
    version: 1,
    sourceDraftRevision: 3,
    name: draft().name,
    description: draft().description,
    workflowKind: "pr_static_build",
    target: "headless",
    sourceVersionId: "source-version-1",
    expectationVersionId: "expectation-version-1",
    sourceManifestSha256: digest,
    expectationManifestSha256: "b".repeat(64),
    caseCount: 1,
    createdAt: now,
    createdBy: actor,
  };
}

function sourceManifest(): EvaluationSourceManifestV1 {
  return {
    schemaVersion: "EvaluationSourceManifestV1",
    repositoryId: "repository-1",
    workflowKind: "pr_static_build",
    target: "headless",
    cases: [{ caseId: "case-1", sourceId: "source-1", sourceDigest: digest }],
  };
}

function expectationManifest(): EvaluationExpectationManifestV1 {
  const { sourceId: _sourceId, ...entry } = draftCase();
  return {
    schemaVersion: "EvaluationExpectationManifestV1",
    repositoryId: "repository-1",
    workflowKind: "pr_static_build",
    target: "headless",
    cases: [entry],
  };
}

const createRequest = (): EvaluationSuiteCreateRequest => ({
  changeId: "create-1",
  name: "Compiler regressions",
  description: "Frozen build examples.",
  workflowKind: "pr_static_build",
  target: "headless",
});

describe("evaluation suite drafts and publication", () => {
  it("retains complete negative examples, unlabeled examples and expected failed outcomes", () => {
    const value = draft();
    value.cases.push({ ...draftCase(2), findings: { annotation: "unlabeled", expected: [] } });
    value.cases.push({ ...draftCase(3), findings: { annotation: "partial", expected: [] } });
    const original = structuredClone(value);
    assertEvaluationSuiteDraft(value);
    assertEvaluationSuitePublication(value);
    expect(value).toEqual(original);
    expect(Value.Check(EvaluationSuiteDraftCaseSchema, draftCase())).toBe(true);
  });

  it("allows empty and wholly inapplicable drafts but requires applicable scope to publish", () => {
    const empty = { ...draft(), cases: [] };
    expect(getEvaluationSuiteDraftIssues(empty)).toEqual([]);
    expect(() => assertEvaluationSuitePublication(empty)).toThrow(/applicable case/u);
    const inapplicable = draft();
    inapplicable.cases[0] = {
      ...draftCase(),
      applicability: { state: "not_applicable", reason: "A different platform is required." },
    };
    expect(getEvaluationSuiteDraftIssues(inapplicable)).toEqual([]);
    expect(getEvaluationSuitePublicationIssues(inapplicable)).toHaveLength(1);
    inapplicable.cases.push(draftCase(2));
    expect(getEvaluationSuitePublicationIssues(inapplicable)).toEqual([]);
    expect(inapplicable.cases).toHaveLength(2);
  });

  it("rejects duplicate scoped assessment identities while allowing reusable IDs across cases", () => {
    const value = draft();
    value.cases.push(draftCase(2));
    expect(getEvaluationSuiteDraftIssues(value)).toEqual([]);
    value.cases.push(draftCase(2));
    expect(getEvaluationSuiteDraftIssues(value).join(" ")).toMatch(/Case identifiers/u);
    const repeatedCriterion = draftCase();
    repeatedCriterion.criteria.push(...structuredClone(repeatedCriterion.criteria));
    expect(
      getEvaluationSuiteDraftIssues({ ...draft(), cases: [repeatedCriterion] }).join(" "),
    ).toMatch(/Criterion identifiers/u);
    const repeatedFinding = draftCase();
    repeatedFinding.findings = {
      annotation: "partial",
      expected: [
        { expectedFindingId: "problem-1", description: "One known problem." },
        { expectedFindingId: "problem-1", description: "A conflicting duplicate annotation." },
      ],
    };
    expect(
      getEvaluationSuiteDraftIssues({ ...draft(), cases: [repeatedFinding] }).join(" "),
    ).toMatch(/Expected finding identifiers/u);
  });

  it("bounds cases, criteria, expected findings and display text", () => {
    const cases = Array.from({ length: maximumEvaluationCaseCount }, (_, index) =>
      draftCase(index),
    );
    expect(getEvaluationSuiteDraftIssues({ ...draft(), cases })).toEqual([]);
    expect(
      getEvaluationSuiteDraftIssues({ ...draft(), cases: [...cases, draftCase(99)] }),
    ).not.toEqual([]);
    const entry = draftCase();
    entry.criteria = Array.from({ length: maximumEvaluationCriterionCount }, (_, index) => ({
      criterionId: `criterion-${index}`,
      description: "A check",
      applicability: { state: "applicable" },
      expectedOutcome: "passed",
    }));
    expect(getEvaluationSuiteDraftIssues({ ...draft(), cases: [entry] })).toEqual([]);
    entry.criteria.push({
      criterionId: "overflow",
      description: "A check",
      applicability: { state: "applicable" },
      expectedOutcome: "passed",
    });
    expect(getEvaluationSuiteDraftIssues({ ...draft(), cases: [entry] })).not.toEqual([]);
    expect(
      Value.Check(EvaluationSuiteDraftCaseSchema, { ...draftCase(), title: "x".repeat(257) }),
    ).toBe(false);
    expect(Value.Check(EvaluationSuiteDraftSchema, { ...draft(), name: "x".repeat(129) })).toBe(
      false,
    );
    expect(
      Value.Check(EvaluationSuiteDraftSchema, { ...draft(), description: "x".repeat(2_049) }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationSuiteDraftCaseSchema, {
        ...draftCase(),
        findings: {
          annotation: "complete",
          expected: Array.from({ length: 65 }, (_, index) => ({
            expectedFindingId: `problem-${index}`,
            description: "Known finding",
          })),
        },
      }),
    ).toBe(false);
  });

  it("rejects source bodies, arm mappings and untrusted result attachments in a draft", () => {
    for (const extra of [
      { source: { body: "arbitrary source" } },
      { sourceUrl: "https://example.org/pr/1" },
      { resultId: "historical-success" },
      { actor },
    ]) {
      expect(
        getEvaluationSuiteDraftIssues({ ...draft(), cases: [{ ...draftCase(), ...extra }] }),
      ).not.toEqual([]);
    }
    expect(
      getEvaluationSuiteDraftIssues({
        ...draft(),
        cases: [
          {
            ...draftCase(),
            criteria: [
              {
                ...draftCase().criteria[0],
                baselineCheckId: "profile-1:check-1",
                candidateCheckId: null,
              },
            ],
          },
        ],
      }),
    ).not.toEqual([]);
    expect(
      getEvaluationSuiteDraftIssues({
        ...draft(),
        cases: [
          {
            ...draftCase(),
            applicability: {
              state: "not_applicable",
            },
          },
        ],
      }),
    ).not.toEqual([]);
  });

  it("measures aggregate UTF-8 bytes and rejects malformed JSON without mutation", () => {
    const value = draft();
    value.cases = Array.from({ length: 4 }, (_, caseIndex) => ({
      ...draftCase(caseIndex),
      criteria: Array.from({ length: maximumEvaluationCriterionCount }, (_, index) => ({
        criterionId: `criterion-${index}`,
        description: "\u754c".repeat(2_048),
        applicability: { state: "applicable" },
        expectedOutcome: "passed",
      })),
    }));
    expect(Value.Check(EvaluationSuiteDraftSchema, value)).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThan(maximumEvaluationSuiteUtf8Bytes);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(
      maximumEvaluationSuiteUtf8Bytes,
    );
    expect(getEvaluationSuiteDraftIssues(value).join(" ")).toMatch(/aggregate UTF-8 byte limit/u);
    expect(
      getEvaluationSuiteSaveRequestIssues({
        changeId: "save-1",
        expectedRevision: 1,
        draft: value,
      }).join(" "),
    ).toMatch(/aggregate UTF-8 byte limit/u);
    for (const malformed of ["\ud800", "\udfff"]) {
      expect(
        getEvaluationSuiteDraftIssues({ ...draft(), description: malformed }).join(" "),
      ).toMatch(/well-formed JSON/u);
    }
    const circular: Record<string, unknown> = { ...draft() };
    circular.self = circular;
    expect(getEvaluationSuiteDraftIssues(circular).join(" ")).toMatch(/well-formed JSON/u);
    expect(getEvaluationSuiteDraftIssues({ ...draft(), cases: [undefined] }).join(" ")).toMatch(
      /well-formed JSON/u,
    );
    expect(getEvaluationSuiteDraftIssues({ ...draft(), description: "bad\0text" })).not.toEqual([]);
    expect(getEvaluationSuiteDraftIssues({ ...draft(), name: "Title\n" })).not.toEqual([]);
  });
});

describe("evaluation suite request and frozen manifest contracts", () => {
  it("requires change IDs and positive CAS revisions without allowing identity changes", () => {
    const create = createRequest();
    const save = { changeId: "save-1", expectedRevision: 1, draft: draft() };
    const publish = { changeId: "publish-1", expectedRevision: 2 };
    assertEvaluationSuiteCreateRequest(create);
    assertEvaluationSuiteSaveRequest(save);
    assertEvaluationSuitePublishRequest(publish);
    expect(Value.Check(EvaluationSuiteCreateRequestSchema, create)).toBe(true);
    expect(Value.Check(EvaluationSuiteSaveRequestSchema, save)).toBe(true);
    expect(Value.Check(EvaluationSuitePublishRequestSchema, publish)).toBe(true);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        getEvaluationSuiteSaveRequestIssues({ ...save, expectedRevision: invalid }),
      ).not.toEqual([]);
      expect(
        getEvaluationSuitePublishRequestIssues({ ...publish, expectedRevision: invalid }),
      ).not.toEqual([]);
    }
    for (const field of ["repositoryId", "workflowKind", "target", "actor"]) {
      expect(getEvaluationSuiteSaveRequestIssues({ ...save, [field]: "override" })).not.toEqual([]);
    }
    expect(getEvaluationSuiteCreateRequestIssues({ ...create, changeId: "" })).not.toEqual([]);
    expect(getEvaluationSuitePublishRequestIssues({ ...publish, expectations: [] })).not.toEqual(
      [],
    );
  });

  it("uses the same workflow and target combinations as validation profiles", () => {
    for (const workflowKind of WorkflowKindValues) {
      for (const target of ValidationTargetValues) {
        const accepted =
          workflowKind === "issue_validation" ||
          (workflowKind === "pr_ui" ? target !== "headless" : target === "headless");
        expect(
          getEvaluationSuiteCreateRequestIssues({ ...createRequest(), workflowKind, target })
            .length === 0,
        ).toBe(accepted);
        expect(
          getEvaluationSourceManifestIssues({ ...sourceManifest(), workflowKind, target })
            .length === 0,
        ).toBe(accepted);
        expect(
          getEvaluationExpectationManifestIssues({ ...expectationManifest(), workflowKind, target })
            .length === 0,
        ).toBe(accepted);
      }
    }
  });

  it("keeps source and expectation manifests separate and nonempty", () => {
    const sources = sourceManifest();
    const expectations = expectationManifest();
    assertEvaluationSourceManifest(sources);
    assertEvaluationExpectationManifest(expectations);
    expect(Value.Check(EvaluationSourceManifestV1Schema, sources)).toBe(true);
    expect(Value.Check(EvaluationExpectationManifestV1Schema, expectations)).toBe(true);
    expect(getEvaluationSourceManifestIssues({ ...sources, cases: [] })).not.toEqual([]);
    expect(getEvaluationExpectationManifestIssues({ ...expectations, cases: [] })).not.toEqual([]);
    expect(
      getEvaluationSourceManifestIssues({
        ...sources,
        cases: [
          {
            ...sources.cases[0],
            findings: draftCase().findings,
          },
        ],
      }),
    ).not.toEqual([]);
    expect(
      getEvaluationExpectationManifestIssues({ ...expectations, cases: [draftCase()] }),
    ).not.toEqual([]);
    expect(
      getEvaluationSourceManifestIssues({
        ...sources,
        cases: [sources.cases[0], sources.cases[0]],
      }).join(" "),
    ).toMatch(/Case identifiers/u);
    expect(
      getEvaluationExpectationManifestIssues({
        ...expectations,
        cases: [expectations.cases[0], expectations.cases[0]],
      }).join(" "),
    ).toMatch(/Case identifiers/u);
    expect(maximumEvaluationSourceManifestUtf8Bytes).toBe(65_536);
    expect(new TextEncoder().encode(JSON.stringify(sources)).byteLength).toBeLessThan(
      maximumEvaluationSourceManifestUtf8Bytes,
    );
  });

  it("bounds expectation manifests by their complete serialized content", () => {
    const manifest = expectationManifest();
    manifest.cases = Array.from({ length: 4 }, (_, index) => ({
      ...manifest.cases[0],
      caseId: `case-${index}`,
      title: "A labeled sample",
      applicability: { state: "applicable" },
      findings: { annotation: "complete", expected: [] },
      criteria: Array.from({ length: maximumEvaluationCriterionCount }, (_, criterionIndex) => ({
        criterionId: `criterion-${criterionIndex}`,
        description: "\u754c".repeat(2_048),
        applicability: { state: "applicable" },
        expectedOutcome: "failed",
      })),
    }));
    expect(Value.Check(EvaluationExpectationManifestV1Schema, manifest)).toBe(true);
    expect(getEvaluationExpectationManifestIssues(manifest).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
  });
});

describe("evaluation suite read contracts", () => {
  it("preserves draft revisions, independent manifest identities and attributed versions", () => {
    assertEvaluationSuiteSummary(summary());
    assertEvaluationSuiteDetail(detail());
    assertEvaluationSuiteVersion(version());
    expect(Value.Check(EvaluationSuiteSummaryV1Schema, summary())).toBe(true);
    expect(Value.Check(EvaluationSuiteDetailV1Schema, detail())).toBe(true);
    expect(Value.Check(EvaluationSuiteVersionV1Schema, version())).toBe(true);
    expect(getEvaluationSuiteDetailIssues({ ...detail(), caseCount: 2 }).join(" ")).toMatch(
      /match its draft/u,
    );
    expect(getEvaluationSuiteDetailIssues({ ...detail(), name: "Other name" }).join(" ")).toMatch(
      /match its draft/u,
    );
    expect(
      getEvaluationSuiteSummaryIssues({ ...summary(), updatedAt: "2026-09-07T00:00:00.000Z" }),
    ).not.toEqual([]);
    expect(
      getEvaluationSuiteSummaryIssues({
        ...summary(),
        updatedBy: { ...actor, subject: " operator " },
      }),
    ).not.toEqual([]);
    expect(getEvaluationSuiteVersionIssues({ ...version(), caseCount: 0 })).not.toEqual([]);
    expect(
      getEvaluationSuiteVersionIssues({
        ...version(),
        createdBy: { ...actor, issuer: "bad\0issuer" },
      }),
    ).not.toEqual([]);
    expect(getEvaluationSuiteVersionIssues({ ...version(), createdAt: "yesterday" })).not.toEqual(
      [],
    );
    expect(
      getEvaluationSuiteVersionIssues({ ...version(), sourceManifestSha256: "not-a-digest" }),
    ).not.toEqual([]);
  });

  it("returns at most 50 scoped summaries and excludes draft and expectation bodies", () => {
    const response = {
      repositoryId: "repository-1",
      items: [summary()],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    const versions = { ...response, suiteId: "suite-1", items: [version()] };
    assertEvaluationSuiteListQuery({});
    assertEvaluationSuiteListQuery({ page: 2, pageSize: maximumEvaluationSuitePageSize });
    assertEvaluationSuiteListResponse(response);
    assertEvaluationSuiteVersionListResponse(versions);
    expect(Value.Check(EvaluationSuiteListQuerySchema, {})).toBe(true);
    expect(Value.Check(EvaluationSuiteListResponseSchema, response)).toBe(true);
    expect(Value.Check(EvaluationSuiteVersionListResponseSchema, versions)).toBe(true);
    expect(getEvaluationSuiteListQueryIssues({ pageSize: 51 })).not.toEqual([]);
    expect(getEvaluationSuiteListQueryIssues({ page: 0 })).not.toEqual([]);
    expect(
      getEvaluationSuiteListQueryIssues({ page: Number.MAX_SAFE_INTEGER, pageSize: 50 }),
    ).not.toEqual([]);
    expect(getEvaluationSuiteListResponseIssues({ ...response, total: 2 })).not.toEqual([]);
    expect(getEvaluationSuiteVersionListResponseIssues({ ...versions, total: 2 })).not.toEqual([]);
    expect(
      getEvaluationSuiteListResponseIssues({
        ...response,
        items: [],
        page: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toEqual([]);
    expect(getEvaluationSuiteListResponseIssues({ ...response, items: [detail()] })).not.toEqual(
      [],
    );
    expect(
      getEvaluationSuiteVersionListResponseIssues({
        ...versions,
        items: [{ ...version(), cases: expectationManifest().cases }],
      }),
    ).not.toEqual([]);
    expect(
      getEvaluationSuiteListResponseIssues({ ...response, repositoryId: "other-repository" }),
    ).not.toEqual([]);
    expect(
      getEvaluationSuiteVersionListResponseIssues({ ...versions, suiteId: "other-suite" }),
    ).not.toEqual([]);
    expect(getEvaluationSuiteListResponseIssues({ ...response, page: 2 })).not.toEqual([]);
    expect(
      getEvaluationSuiteListResponseIssues({
        ...response,
        total: 2,
        items: [summary(), summary()],
      }),
    ).not.toEqual([]);
    expect(
      getEvaluationSuiteListResponseIssues({
        ...response,
        total: 51,
        pageSize: 50,
        items: Array.from({ length: 51 }, (_, index) => ({ ...summary(), id: `suite-${index}` })),
      }),
    ).not.toEqual([]);
  });
});
