import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EvaluationSourceSnapshotV1,
  maximumEvaluationSourceSnapshotUtf8Bytes,
} from "./evaluation-execution.js";
import {
  assertEvaluationSourceCaptureRequest,
  assertEvaluationSourceDetail,
  assertEvaluationSourceListQuery,
  assertEvaluationSourceListResponse,
  assertEvaluationSourceReference,
  assertEvaluationSourceSummary,
  EvaluationSourceCaptureRequestSchema,
  type EvaluationSourceDetailV1,
  EvaluationSourceDetailV1Schema,
  type EvaluationSourceListResponse,
  EvaluationSourceListResponseSchema,
  EvaluationSourceReferenceV1Schema,
  type EvaluationSourceSummaryV1,
  EvaluationSourceSummaryV1Schema,
  getEvaluationSourceCaptureRequestIssues,
  getEvaluationSourceDetailIssues,
  getEvaluationSourceListQueryIssues,
  getEvaluationSourceListResponseIssues,
  getEvaluationSourceReferenceIssues,
  getEvaluationSourceSummaryIssues,
  maximumEvaluationSourceCaptureRequestUtf8Bytes,
  maximumEvaluationSourceDetailUtf8Bytes,
  maximumEvaluationSourcePageSize,
} from "./evaluation-source.js";

const current = {
  kind: "current_work_item",
  workItemId: "work-item-1",
  expectedRevisionKey: "a".repeat(64),
  testedIssueCommit: null,
};
const historical = {
  kind: "review_run",
  reviewRunId: "review-run-1",
  expectedPlanDigest: "b".repeat(64),
};
const now = "2026-09-08T01:00:00.000Z";
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));

beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterAll(() => {
  for (const [name, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, previous);
  }
});

function sourceSnapshot(): EvaluationSourceSnapshotV1 {
  return {
    schemaVersion: "EvaluationSourceSnapshotV1",
    repository: {
      id: "repository-1",
      githubRepositoryId: 100,
      fullName: "example/project",
      configurationVersion: 1,
    },
    workItemId: "work-item-1",
    revisionId: "revision-1",
    workItem: {
      kind: "pull_request",
      githubWorkItemId: 200,
      githubNodeId: "NODE_200",
      githubRepositoryId: 100,
      number: 7,
      title: "Preserve the original source",
      body: "This complete body is only available in the source detail.",
      state: "open",
      author: { githubUserId: 300, login: "contributor" },
      htmlUrl: "https://github.com/example/project/pull/7",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      isDraft: false,
    },
    revision: {
      kind: "pull_request",
      githubRepositoryId: 100,
      githubWorkItemId: 200,
      revisionKey: "a".repeat(64),
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
    freshness: "frozen",
    sourceDigest: "d".repeat(64),
    provenance: { kind: "current_work_item", capturedAt: now, expectedRevisionKey: "a".repeat(64) },
  };
}

function summary(snapshot = sourceSnapshot()): EvaluationSourceSummaryV1 {
  return {
    schemaVersion: "EvaluationSourceSummaryV1",
    id: "source-1",
    repositoryId: snapshot.repository.id,
    workItemId: snapshot.workItemId,
    revisionId: snapshot.revisionId,
    revisionKey: snapshot.revision.revisionKey,
    sourceDigest: snapshot.sourceDigest,
    workItemKind: snapshot.workItem.kind,
    number: snapshot.workItem.number,
    title: snapshot.workItem.title,
    createdAt: snapshot.provenance.capturedAt,
    createdBy: { issuer: "https://identity.example.test", subject: "capturing-operator" },
  };
}

function detail(snapshot = sourceSnapshot()): EvaluationSourceDetailV1 {
  return { ...summary(snapshot), snapshot };
}

function page(): EvaluationSourceListResponse {
  return { repositoryId: "repository-1", total: 1, page: 1, pageSize: 20, items: [summary()] };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("evaluation source references", () => {
  it("accepts only an explicit checkout selection or an immutable run reference", () => {
    for (const value of [
      current,
      historical,
      { ...current, testedIssueCommit: "c".repeat(40) },
      { ...current, testedIssueCommit: "d".repeat(64) },
    ])
      expect(Value.Check(EvaluationSourceReferenceV1Schema, value)).toBe(true);
  });

  it("rejects omitted selection, abbreviated hashes, and intermediate hash lengths", () => {
    const { testedIssueCommit: _selection, ...missingSelection } = current;
    for (const value of [
      missingSelection,
      ...["", "abc123", "a".repeat(41), "a".repeat(63), "A".repeat(40), "main"].map(
        (testedIssueCommit) => ({ ...current, testedIssueCommit }),
      ),
      { ...current, expectedRevisionKey: "a".repeat(40) },
      { ...historical, expectedPlanDigest: "A".repeat(64) },
    ])
      expect(Value.Check(EvaluationSourceReferenceV1Schema, value)).toBe(false);
  });

  it("rejects raw snapshots, mixed branches, and invalid entity identities", () => {
    for (const value of [
      { ...current, workItem: {} },
      { ...current, reviewRunId: historical.reviewRunId },
      { ...historical, testedIssueCommit: null },
      { ...historical, authorization: {} },
      { ...current, workItemId: "../work-item" },
      { ...historical, reviewRunId: "" },
    ])
      expect(Value.Check(EvaluationSourceReferenceV1Schema, value)).toBe(false);
  });
});

describe("evaluation source public contracts", () => {
  it("accepts bounded capture requests containing only a change ID and a persisted reference", () => {
    for (const source of [current, historical]) {
      const request = { changeId: "capture-1", source };
      expect(Value.Check(EvaluationSourceCaptureRequestSchema, request)).toBe(true);
      expect(getEvaluationSourceCaptureRequestIssues(request)).toEqual([]);
      expect(getEvaluationSourceReferenceIssues(source)).toEqual([]);
      expect(() => assertEvaluationSourceCaptureRequest(request)).not.toThrow();
      expect(() => assertEvaluationSourceReference(source)).not.toThrow();
    }
  });

  it("rejects client snapshots, actors, digests, and execution authority in capture requests", () => {
    const request = { changeId: "capture-1", source: current };
    for (const forged of [
      { ...request, snapshot: sourceSnapshot() },
      { ...request, actor: summary().createdBy },
      { ...request, sourceDigest: "d".repeat(64) },
      { ...request, authorization: {} },
      { ...request, source: { ...current, snapshot: sourceSnapshot() } },
      { source: current },
      { ...request, changeId: "../capture" },
    ]) {
      expect(getEvaluationSourceCaptureRequestIssues(forged).length).toBeGreaterThan(0);
      expect(() => assertEvaluationSourceCaptureRequest(forged)).toThrow(TypeError);
    }
  });

  it("enforces the capture request UTF-8 budget", () => {
    const forged = {
      changeId: "capture-1",
      source: current,
      snapshot: "界".repeat(maximumEvaluationSourceCaptureRequestUtf8Bytes / 2),
    };
    expect(byteLength(forged)).toBeGreaterThan(maximumEvaluationSourceCaptureRequestUtf8Bytes);
    expect(getEvaluationSourceCaptureRequestIssues(forged)).toEqual([
      expect.stringContaining("aggregate UTF-8 byte limit"),
    ]);
  });

  it("exposes bounded summaries and a separately retrieved full snapshot", () => {
    const value = detail();
    expect(Value.Check(EvaluationSourceSummaryV1Schema, summary())).toBe(true);
    expect(Value.Check(EvaluationSourceDetailV1Schema, value)).toBe(true);
    expect(getEvaluationSourceSummaryIssues(summary())).toEqual([]);
    expect(getEvaluationSourceDetailIssues(value)).toEqual([]);
    expect(() => assertEvaluationSourceSummary(summary())).not.toThrow();
    expect(() => assertEvaluationSourceDetail(value)).not.toThrow();
    for (const extra of [
      { snapshot: value.snapshot },
      { body: value.snapshot.workItem.body },
      { provenance: value.snapshot.provenance },
      { authorization: {} },
    ])
      expect(getEvaluationSourceSummaryIssues({ ...summary(), ...extra }).length).toBeGreaterThan(
        0,
      );
    expect(
      getEvaluationSourceDetailIssues({ ...value, schemaVersion: "EvaluationSourceDetailV1" })
        .length,
    ).toBeGreaterThan(0);
  });

  it.each([
    { repositoryId: "repository-2" },
    { workItemId: "work-item-2" },
    { revisionId: "revision-2" },
    { revisionKey: "f".repeat(64) },
    { sourceDigest: "f".repeat(64) },
    { workItemKind: "issue" },
    { number: 8 },
    { title: "A substituted summary title" },
    { createdAt: "2026-09-08T02:00:00.000Z" },
  ])("binds every summary identity and capture field to the snapshot: %j", (changed) => {
    expect(getEvaluationSourceDetailIssues({ ...detail(), ...changed })).toContain(
      "The evaluation source summary must match its frozen snapshot and capture time.",
    );
  });

  it("validates nested snapshot scope and commit bindings without claiming digest attestation", () => {
    const inconsistent = detail();
    inconsistent.snapshot.repository.githubRepositoryId = 999;
    expect(getEvaluationSourceDetailIssues(inconsistent)).toContain(
      "Evaluation source repository, work item, and revision scope must match.",
    );
    const noAttestation = detail();
    noAttestation.sourceDigest = "f".repeat(64);
    noAttestation.snapshot.sourceDigest = noAttestation.sourceDigest;
    // Content digests are recomputed by the owner, never attested by public contract validation.
    expect(getEvaluationSourceDetailIssues(noAttestation)).toEqual([]);
    expect(
      getEvaluationSourceDetailIssues({ ...detail(), authorization: {} }).length,
    ).toBeGreaterThan(0);
  });

  it("binds historical capture time while retaining historical authorization as provenance only", () => {
    const snapshot = sourceSnapshot();
    snapshot.provenance = {
      kind: "review_run",
      capturedAt: now,
      reviewRunId: "old-run-1",
      planDigest: "e".repeat(64),
      requestEpochId: "old-epoch-1",
    };
    expect(getEvaluationSourceDetailIssues(detail(snapshot))).toEqual([]);
    expect(summary(snapshot)).not.toHaveProperty("requestEpochId");
    expect(detail(snapshot)).not.toHaveProperty("authorization");
  });

  it("rejects invalid summary fields and non-exact operator identities", () => {
    for (const changed of [
      { number: 0 },
      { number: Number.MAX_SAFE_INTEGER + 1 },
      { title: "" },
      { sourceDigest: "a".repeat(40) },
      { revisionKey: "A".repeat(64) },
      { createdAt: "not-a-timestamp" },
      { createdBy: { ...summary().createdBy, subject: " operator" } },
      { createdBy: { ...summary().createdBy, subject: "operator\u0007" } },
      { createdBy: { ...summary().createdBy, subject: "operator\u007f" } },
    ])
      expect(getEvaluationSourceSummaryIssues({ ...summary(), ...changed }).length).toBeGreaterThan(
        0,
      );
  });

  it("allows a maximum-sized snapshot plus bounded detail metadata and rejects a larger snapshot", () => {
    const snapshot = sourceSnapshot();
    snapshot.workItem.body = "";
    const remaining = maximumEvaluationSourceSnapshotUtf8Bytes - byteLength(snapshot);
    snapshot.workItem.body = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
    expect(byteLength(snapshot)).toBe(maximumEvaluationSourceSnapshotUtf8Bytes);
    const value = detail(snapshot);
    expect(byteLength(value)).toBeGreaterThan(maximumEvaluationSourceSnapshotUtf8Bytes);
    expect(byteLength(value)).toBeLessThan(maximumEvaluationSourceDetailUtf8Bytes);
    expect(getEvaluationSourceDetailIssues(value)).toEqual([]);
    snapshot.workItem.body += "x";
    expect(getEvaluationSourceDetailIssues(value)).toContain(
      "Evaluation source snapshot exceeds its aggregate UTF-8 byte limit.",
    );
    snapshot.workItem.body += "x".repeat(64 * 1024);
    expect(getEvaluationSourceDetailIssues(value)).toEqual([
      expect.stringContaining("Evaluation source detail exceeds its aggregate UTF-8 byte limit"),
    ]);
  });

  it("returns issues for malformed Unicode, non-JSON values, and cyclic inputs", () => {
    const cyclic: Record<string, unknown> = { changeId: "capture-1", source: current };
    cyclic.cycle = cyclic;
    const invalidValues: unknown[] = [
      cyclic,
      new Date(now),
      new Map(),
      { changeId: "capture-1", source: current, optional: undefined },
      { changeId: "capture-1", source: current, number: Number.NaN },
      { changeId: "capture-1", source: current, [Symbol("hidden")]: true },
      { changeId: "capture-1", source: current, malformed: "\ud800" },
    ];
    for (const value of invalidValues)
      expect(getEvaluationSourceCaptureRequestIssues(value)).toEqual([
        expect.stringContaining("well-formed JSON"),
      ]);
    expect(getEvaluationSourceSummaryIssues({ ...summary(), title: "\ud800" })).toEqual([
      expect.stringContaining("well-formed JSON"),
    ]);
    const value = detail();
    value.snapshot.workItem.body = "\ud800";
    expect(getEvaluationSourceDetailIssues(value)).toEqual([
      expect.stringContaining("well-formed JSON"),
    ]);
  });

  it("accepts bounded queries with the suite-compatible default page size and safe offset", () => {
    for (const query of [{}, { page: 1 }, { pageSize: 50 }, { page: 2, pageSize: 10 }]) {
      expect(getEvaluationSourceListQueryIssues(query)).toEqual([]);
      expect(() => assertEvaluationSourceListQuery(query)).not.toThrow();
    }
    for (const query of [
      { page: 0 },
      { page: 1.5 },
      { pageSize: 0 },
      { pageSize: maximumEvaluationSourcePageSize + 1 },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
      { page: Number.MAX_SAFE_INTEGER },
      { repositoryId: "client-supplied-scope" },
    ]) {
      expect(getEvaluationSourceListQueryIssues(query).length).toBeGreaterThan(0);
      expect(() => assertEvaluationSourceListQuery(query)).toThrow(TypeError);
    }
  });

  it("validates list response counts, repository scope, unique IDs and summary-only items", () => {
    expect(Value.Check(EvaluationSourceListResponseSchema, page())).toBe(true);
    expect(getEvaluationSourceListResponseIssues(page())).toEqual([]);
    expect(() => assertEvaluationSourceListResponse(page())).not.toThrow();
    expect(getEvaluationSourceListResponseIssues({ ...page(), total: 0, items: [] })).toEqual([]);
    expect(getEvaluationSourceListResponseIssues({ ...page(), page: 2, items: [] })).toEqual([]);
    expect(
      getEvaluationSourceListResponseIssues({ ...page(), page: 2, pageSize: 1, total: 2 }),
    ).toEqual([]);
    for (const response of [
      { ...page(), repositoryId: "repository-2" },
      { ...page(), items: [] },
      { ...page(), total: 0 },
      { ...page(), total: 2, items: [summary(), summary()] },
      { ...page(), items: [detail()] },
      { ...page(), items: [{ ...summary(), body: "No raw body in lists." }] },
      { ...page(), page: Number.MAX_SAFE_INTEGER, items: [] },
      { ...page(), total: Number.MAX_SAFE_INTEGER + 1 },
      { ...page(), pageSize: 51 },
    ]) {
      expect(getEvaluationSourceListResponseIssues(response).length).toBeGreaterThan(0);
      expect(() => assertEvaluationSourceListResponse(response)).toThrow(TypeError);
    }
  });
});
