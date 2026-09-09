import type { DatabaseSync } from "node:sqlite";
import type {
  EvaluationExpectationManifestV1,
  EvaluationSourceManifestV1,
  EvaluationSourceReferenceV1,
  EvaluationSuiteCreateRequest,
  EvaluationSuiteDraft,
  EvaluationSuiteDraftCase,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import {
  maximumEvaluationCriterionCount,
  maximumEvaluationSuiteUtf8Bytes,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  type EvaluationManagementOperation,
  type EvaluationManagementOperationMap,
  type EvaluationManagementRequest,
  handleEvaluationManagementRequest,
} from "./evaluation-management.js";
import {
  evaluationActor as actor,
  evaluationAdministrator as administrator,
  createEvaluationManagementFixture,
  evaluationLater as later,
  reviseEvaluationManagementSource,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import { recomputeEvaluationSourceDigest } from "./evaluation-source.js";

type Fixture = ReturnType<typeof createEvaluationManagementFixture>;
const fixtures: Fixture[] = [];
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
const afterPublication = "2026-09-08T03:00:00.000Z";

beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
afterAll(() => {
  for (const [name, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, previous);
  }
});

function fixture(kind: "pull_request" | "issue" = "pull_request"): Fixture {
  const value = createEvaluationManagementFixture(kind);
  fixtures.push(value);
  return value;
}

function execute<Operation extends EvaluationManagementOperation>(
  value: Fixture,
  operation: Operation,
  input: EvaluationManagementOperationMap[Operation]["input"],
  timestamp = later,
  options?: { readOnly?: boolean },
): EvaluationManagementOperationMap[Operation]["output"] {
  return handleEvaluationManagementRequest(
    value.database,
    { operation, input } as EvaluationManagementRequest,
    timestamp,
    [administrator],
    options,
  ) as EvaluationManagementOperationMap[Operation]["output"];
}

const scope = (value: Fixture, principal: OperatorPrincipal = actor) => ({
  repositoryId: value.repositoryId,
  actor: principal,
});

function capture(
  value: Fixture,
  changeId = "capture-source",
  source: EvaluationSourceReferenceV1 = value.reference,
) {
  return execute(value, "captureEvaluationSource", {
    ...scope(value),
    request: { changeId, source },
  });
}

function createSuite(value: Fixture, overrides: Partial<EvaluationSuiteCreateRequest> = {}) {
  return execute(value, "createEvaluationSuite", {
    ...scope(value),
    request: {
      changeId: "create-suite",
      name: "Known compiler regressions",
      description: "Frozen source examples and independent human expectations.",
      workflowKind: value.event.workItem.kind === "issue" ? "issue_validation" : "pr_static_build",
      target: "headless",
      ...overrides,
    },
  });
}

function draftCase(sourceId: string, caseId = "case-build"): EvaluationSuiteDraftCase {
  return {
    caseId,
    title: "A known failing build with no additional findings",
    sourceId,
    applicability: { state: "applicable" },
    criteria: [
      {
        criterionId: "criterion-build",
        description: "The known build failure is observed.",
        applicability: { state: "applicable" },
        expectedOutcome: "failed",
      },
    ],
    findings: { annotation: "complete", expected: [] },
  };
}

function draft(sourceId: string): EvaluationSuiteDraft {
  return {
    name: "Known compiler regressions",
    description: "Frozen source examples and independent human expectations.",
    cases: [draftCase(sourceId)],
  };
}

function populatedSuite(value: Fixture, selectedDraft?: EvaluationSuiteDraft) {
  const source = capture(value);
  const suite = createSuite(value);
  const input = {
    ...scope(value),
    suiteId: suite.id,
    request: {
      changeId: "save-suite",
      expectedRevision: suite.draftRevision,
      draft: selectedDraft ?? draft(source.id),
    },
  };
  const saved = execute(value, "saveEvaluationSuiteDraft", input);
  return { source, suite, saved, saveInput: input };
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrow(expect.objectContaining({ code }));
}

const tables = [
  "evaluation_sources",
  "evaluation_suites",
  "evaluation_source_versions",
  "evaluation_expectation_versions",
  "evaluation_suite_versions",
  "evaluation_mutation_receipts",
] as const;

function persistedState(database: DatabaseSync) {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      database
        .prepare(
          `SELECT * FROM ${table} ORDER BY ${table === "evaluation_mutation_receipts" ? "repository_id, change_id" : "id"}`,
        )
        .all(),
    ]),
  );
}

function manifests(value: Fixture, sourceVersionId: string, expectationVersionId: string) {
  const source = value.database
    .prepare("SELECT manifest_json, manifest_sha256 FROM evaluation_source_versions WHERE id = ?")
    .get(sourceVersionId) as { manifest_json: string; manifest_sha256: string };
  const expectation = value.database
    .prepare(
      "SELECT manifest_json, manifest_sha256 FROM evaluation_expectation_versions WHERE id = ?",
    )
    .get(expectationVersionId) as { manifest_json: string; manifest_sha256: string };
  return { source, expectation };
}

describe("evaluation management against the actual migrations 1-33 database", () => {
  it("persists a current PR source without creating GitHub execution authority", () => {
    const value = fixture();
    expect(
      value.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    ).toEqual({ version: 33 });
    const authority = value.database
      .prepare(`SELECT
      (SELECT COUNT(*) FROM request_epochs) AS epochs,
      (SELECT COUNT(*) FROM jobs) AS jobs,
      (SELECT COUNT(*) FROM github_review_run_activations) AS activations`)
      .get();
    const summary = capture(value);
    const detail = execute(value, "getEvaluationSource", { ...scope(value), sourceId: summary.id });
    expect(summary).toMatchObject({
      schemaVersion: "EvaluationSourceSummaryV1",
      repositoryId: value.repositoryId,
      workItemId: value.planInput.workItemId,
      revisionKey: value.reference.expectedRevisionKey,
      workItemKind: "pull_request",
      createdAt: later,
      createdBy: actor,
    });
    expect(summary).not.toHaveProperty("snapshot");
    expect(detail.snapshot.workItem).toEqual(value.event.workItem);
    expect(detail.snapshot.testedSourceRevision).toEqual({
      kind: "pull_request",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    });
    expect(detail.snapshot.sourceDigest).toBe(recomputeEvaluationSourceDigest(detail.snapshot));
    const row = value.database
      .prepare("SELECT source_json FROM evaluation_sources WHERE id = ?")
      .get(summary.id) as { source_json: string };
    expect(row.source_json).toBe(canonicalJson(detail.snapshot));
    expect(
      value.database
        .prepare(`SELECT
      (SELECT COUNT(*) FROM request_epochs) AS epochs,
      (SELECT COUNT(*) FROM jobs) AS jobs,
      (SELECT COUNT(*) FROM github_review_run_activations) AS activations`)
        .get(),
    ).toEqual(authority);
    expect(() =>
      value.database
        .prepare("UPDATE evaluation_sources SET source_json = source_json WHERE id = ?")
        .run(summary.id),
    ).toThrow();
    expect(() =>
      value.database.prepare("DELETE FROM evaluation_sources WHERE id = ?").run(summary.id),
    ).toThrow();
  });

  it("persists explicit Issue commits independently from its frozen content revision", () => {
    const value = fixture("issue");
    const snapshotOnly = capture(value, "capture-snapshot");
    const checkout = capture(value, "capture-commit", {
      ...value.reference,
      testedIssueCommit: "c".repeat(64),
    });
    const first = execute(value, "getEvaluationSource", {
      ...scope(value),
      sourceId: snapshotOnly.id,
    });
    const second = execute(value, "getEvaluationSource", {
      ...scope(value),
      sourceId: checkout.id,
    });
    expect(first.snapshot.testedSourceRevision).toBeNull();
    expect(second.snapshot.testedSourceRevision).toEqual({
      kind: "commit",
      headSha: "c".repeat(64),
    });
    expect(first.revisionKey).toBe(second.revisionKey);
    expect(first.sourceDigest).not.toBe(second.sourceDigest);
    expect(second.snapshot.workItem).toEqual(value.event.workItem);
    expect(second.snapshot).not.toHaveProperty("authorization");
  });

  it.each(["pull_request", "issue"] as const)(
    "captures the original immutable %s Run after source changes",
    (kind) => {
      const value = fixture(kind);
      const run = value.createRun();
      reviseEvaluationManagementSource(
        value,
        "A later body that must not replace the original plan.",
      );
      const source = capture(value, "capture-historical", {
        kind: "review_run",
        reviewRunId: run.id,
        expectedPlanDigest: run.planDigest,
      });
      const detail = execute(value, "getEvaluationSource", {
        ...scope(value),
        sourceId: source.id,
      });
      expect(detail.snapshot.workItem).toEqual(run.plan.workItem);
      expect(detail.snapshot.revision).toEqual(run.plan.revision);
      expect(detail.snapshot.testedSourceRevision).toEqual(run.plan.testedSourceRevision);
      expect(detail.snapshot.provenance).toMatchObject({
        kind: "review_run",
        reviewRunId: run.id,
        planDigest: run.planDigest,
      });
    },
  );

  it("returns the original capture receipt after the source changes, including read-only recovery", () => {
    const value = fixture();
    const input = {
      ...scope(value),
      request: { changeId: "capture-retry", source: value.reference },
    };
    const original = execute(value, "captureEvaluationSource", input);
    const detail = execute(value, "getEvaluationSource", {
      ...scope(value),
      sourceId: original.id,
    });
    const changed = reviseEvaluationManagementSource(value, "Changed body and commit pair.");
    const before = persistedState(value.database);
    expect(execute(value, "captureEvaluationSource", input, afterPublication)).toEqual(original);
    expect(
      execute(value, "captureEvaluationSource", input, afterPublication, { readOnly: true }),
    ).toEqual(original);
    expect(
      execute(value, "getEvaluationSource", { ...scope(value), sourceId: original.id }),
    ).toEqual(detail);
    expectCode(
      () =>
        execute(
          value,
          "captureEvaluationSource",
          {
            ...scope(value),
            request: {
              changeId: "new-read-only-capture",
              source: { ...value.reference, expectedRevisionKey: changed.revisionKey },
            },
          },
          afterPublication,
          { readOnly: true },
        ),
      "DATABASE_READ_ONLY",
    );
    expect(persistedState(value.database)).toEqual(before);
    expect(value.database.isTransaction).toBe(false);
  });

  it("enforces an HTTP replay-only restriction even when the database owner is in normal mode", () => {
    const value = fixture();
    const input = {
      ...scope(value),
      request: { changeId: "transport-replay", source: value.reference },
    };
    const original = execute(value, "captureEvaluationSource", input);
    const before = persistedState(value.database);
    expect(execute(value, "captureEvaluationSource", { ...input, replayOnly: true })).toEqual(
      original,
    );
    expectCode(
      () =>
        execute(value, "captureEvaluationSource", {
          ...input,
          replayOnly: true,
          request: { ...input.request, changeId: "new-transport-replay" },
        }),
      "DATABASE_READ_ONLY",
    );
    expectCode(
      () =>
        execute(value, "captureEvaluationSource", {
          ...input,
          replayOnly: false,
        } as unknown as EvaluationManagementOperationMap["captureEvaluationSource"]["input"]),
      "PLATFORM_INVALID",
    );
    expect(persistedState(value.database)).toEqual(before);
  });

  it("binds a change ID to its exact payload, operation, entity scope and authorized actor", () => {
    const value = fixture();
    const source = capture(value, "shared-change");
    const otherActor = { ...actor, subject: "second-maintainer" };
    setEvaluationManagementRole(value.database, value.repositoryId, "maintainer", 0, otherActor);
    const before = persistedState(value.database);
    expectCode(
      () =>
        capture(value, "shared-change", {
          ...value.reference,
          expectedRevisionKey: "e".repeat(64),
        }),
      "PLATFORM_CONFLICT",
    );
    expectCode(() => createSuite(value, { changeId: "shared-change" }), "PLATFORM_CONFLICT");
    expectCode(
      () =>
        execute(value, "captureEvaluationSource", {
          ...scope(value, otherActor),
          request: { changeId: "shared-change", source: value.reference },
        }),
      "PLATFORM_CONFLICT",
    );
    expect(persistedState(value.database)).toEqual(before);
    expect(execute(value, "getEvaluationSource", { ...scope(value), sourceId: source.id }).id).toBe(
      source.id,
    );
    const first = createSuite(value, { changeId: "create-first" });
    const second = createSuite(value, { changeId: "create-second" });
    const save = {
      changeId: "save-shared",
      expectedRevision: first.draftRevision,
      draft: draft(source.id),
    };
    execute(value, "saveEvaluationSuiteDraft", {
      ...scope(value),
      suiteId: first.id,
      request: save,
    });
    const afterSave = persistedState(value.database);
    expectCode(
      () =>
        execute(value, "saveEvaluationSuiteDraft", {
          ...scope(value),
          suiteId: second.id,
          request: save,
        }),
      "PLATFORM_CONFLICT",
    );
    expect(persistedState(value.database)).toEqual(afterSave);
  });

  it.each(["viewer", "reviewer", null] as const)(
    "checks current configure permission before replay after role becomes %s",
    (role) => {
      const value = fixture();
      const input = {
        ...scope(value),
        request: { changeId: "authorized-capture", source: value.reference },
      };
      const original = execute(value, "captureEvaluationSource", input);
      setEvaluationManagementRole(value.database, value.repositoryId, role, 1);
      const before = persistedState(value.database);
      const code = role === null ? "PLATFORM_NOT_FOUND" : "PLATFORM_FORBIDDEN";
      expectCode(() => execute(value, "captureEvaluationSource", input), code);
      expectCode(
        () =>
          execute(value, "captureEvaluationSource", input, afterPublication, { readOnly: true }),
        code,
      );
      expect(persistedState(value.database)).toEqual(before);
      setEvaluationManagementRole(value.database, value.repositoryId, "maintainer", 2);
      expect(execute(value, "captureEvaluationSource", input)).toEqual(original);
    },
  );

  it("rolls back a captured source if its immutable mutation receipt cannot be committed", () => {
    const value = fixture();
    const before = persistedState(value.database);
    value.database.exec(`CREATE TEMP TRIGGER fixture_capture_receipt_failure BEFORE INSERT ON evaluation_mutation_receipts
      WHEN NEW.operation = 'source_captured' BEGIN SELECT RAISE(ABORT, 'synthetic capture receipt failure'); END;`);
    expect(() => capture(value)).toThrow();
    expect(persistedState(value.database)).toEqual(before);
    expect(value.database.isTransaction).toBe(false);
    value.database.exec("DROP TRIGGER fixture_capture_receipt_failure");
    expect(capture(value).repositoryId).toBe(value.repositoryId);
  });

  it("publishes exact source and withheld expectation manifests and retains inapplicable cases", () => {
    const value = fixture();
    const { source, suite, saved } = populatedSuite(value);
    const selectedDraft = draft(source.id);
    selectedDraft.cases.push({
      ...draftCase(source.id, "case-unavailable-ui"),
      applicability: { state: "not_applicable", reason: "This source has no UI workflow." },
      criteria: [],
      findings: { annotation: "unlabeled", expected: [] },
    });
    const resaved = execute(value, "saveEvaluationSuiteDraft", {
      ...scope(value),
      suiteId: suite.id,
      request: {
        changeId: "save-complete-manifests",
        expectedRevision: saved.draftRevision,
        draft: selectedDraft,
      },
    });
    const published = execute(value, "publishEvaluationSuite", {
      ...scope(value),
      suiteId: suite.id,
      request: { changeId: "publish-manifests", expectedRevision: resaved.draftRevision },
    });
    expect(published).toMatchObject({
      schemaVersion: "EvaluationSuiteVersionV1",
      repositoryId: value.repositoryId,
      suiteId: suite.id,
      workflowKind: "pr_static_build",
      target: "headless",
      version: 1,
      sourceDraftRevision: resaved.draftRevision,
      caseCount: 2,
      createdBy: actor,
    });
    const stored = manifests(value, published.sourceVersionId, published.expectationVersionId);
    const expectedSource: EvaluationSourceManifestV1 = {
      schemaVersion: "EvaluationSourceManifestV1",
      repositoryId: value.repositoryId,
      workflowKind: "pr_static_build",
      target: "headless",
      cases: selectedDraft.cases.map(({ caseId }) => ({
        caseId,
        sourceId: source.id,
        sourceDigest: source.sourceDigest,
      })),
    };
    const expectedLabels: EvaluationExpectationManifestV1 = {
      schemaVersion: "EvaluationExpectationManifestV1",
      repositoryId: value.repositoryId,
      workflowKind: "pr_static_build",
      target: "headless",
      cases: selectedDraft.cases.map(({ sourceId: _sourceId, ...entry }) => entry),
    };
    expect(stored.source.manifest_json).toBe(canonicalJson(expectedSource));
    expect(stored.expectation.manifest_json).toBe(canonicalJson(expectedLabels));
    expect(stored.source.manifest_sha256).toBe(sha256(stored.source.manifest_json));
    expect(stored.expectation.manifest_sha256).toBe(sha256(stored.expectation.manifest_json));
    expect(published.sourceManifestSha256).toBe(stored.source.manifest_sha256);
    expect(published.expectationManifestSha256).toBe(stored.expectation.manifest_sha256);
    expect(
      execute(value, "getEvaluationSuite", { ...scope(value), suiteId: suite.id }),
    ).toMatchObject({
      draftRevision: resaved.draftRevision + 1,
      latestVersionId: published.id,
      draft: selectedDraft,
    });
    expect(JSON.parse(stored.source.manifest_json).cases[0]).not.toHaveProperty("findings");
    expect(value.database.isTransaction).toBe(false);
  });

  it("preserves published bytes after source and draft changes while publish versions advance independently", () => {
    const value = fixture();
    const { suite, saved, saveInput } = populatedSuite(value);
    const publishInput = {
      ...scope(value),
      suiteId: suite.id,
      request: { changeId: "publish-first", expectedRevision: saved.draftRevision },
    };
    const first = execute(value, "publishEvaluationSuite", publishInput);
    const frozen = manifests(value, first.sourceVersionId, first.expectationVersionId);
    const changed = reviseEvaluationManagementSource(
      value,
      "The source now contains a different known case.",
    );
    const newSource = capture(value, "capture-new-source", {
      ...value.reference,
      expectedRevisionKey: changed.revisionKey,
    });
    const current = execute(value, "getEvaluationSuite", { ...scope(value), suiteId: suite.id });
    const nextDraft = { ...draft(newSource.id), name: "Updated human expectations" };
    const next = execute(
      value,
      "saveEvaluationSuiteDraft",
      {
        ...scope(value),
        suiteId: suite.id,
        request: {
          changeId: "save-next",
          expectedRevision: current.draftRevision,
          draft: nextDraft,
        },
      },
      afterPublication,
    );
    const state = persistedState(value.database);
    expect(
      execute(value, "saveEvaluationSuiteDraft", saveInput, afterPublication, { readOnly: true }),
    ).toEqual(saved);
    expect(
      execute(value, "publishEvaluationSuite", publishInput, afterPublication, { readOnly: true }),
    ).toEqual(first);
    expect(persistedState(value.database)).toEqual(state);
    const second = execute(
      value,
      "publishEvaluationSuite",
      {
        ...scope(value),
        suiteId: suite.id,
        request: { changeId: "publish-second", expectedRevision: next.draftRevision },
      },
      afterPublication,
    );
    expect(second.version).toBe(2);
    expect(second.sourceDraftRevision).toBe(next.draftRevision);
    expect(second.sourceDraftRevision).toBeGreaterThan(second.version);
    expect(second.sourceVersionId).not.toBe(first.sourceVersionId);
    expect(second.expectationVersionId).not.toBe(first.expectationVersionId);
    expect(manifests(value, first.sourceVersionId, first.expectationVersionId)).toEqual(frozen);
    expect(
      execute(value, "getEvaluationSuiteVersion", {
        ...scope(value),
        suiteId: suite.id,
        versionId: first.id,
      }),
    ).toEqual(first);
    expect(() =>
      value.database
        .prepare("UPDATE evaluation_source_versions SET manifest_json = manifest_json WHERE id = ?")
        .run(first.sourceVersionId),
    ).toThrow();
    expect(() =>
      value.database.prepare("DELETE FROM evaluation_suite_versions WHERE id = ?").run(first.id),
    ).toThrow();
  });

  it("reads frozen case summaries and labels after the draft changes without exposing source bodies in the list", () => {
    const value = fixture();
    const { source, suite, saved } = populatedSuite(value);
    const published = execute(value, "publishEvaluationSuite", {
      ...scope(value),
      suiteId: suite.id,
      request: { changeId: "publish-case-reads", expectedRevision: saved.draftRevision },
    });
    const versionScope = { ...scope(value), suiteId: suite.id, versionId: published.id };
    const initialList = execute(value, "listEvaluationSuiteCases", versionScope);
    expect(initialList).toMatchObject({
      total: 1,
      sourceVersionId: published.sourceVersionId,
      expectationVersionId: published.expectationVersionId,
      items: [
        {
          caseId: "case-build",
          sourceId: source.id,
          criterionCount: 1,
          annotation: "complete",
          expectedFindingCount: 0,
        },
      ],
    });
    expect(initialList.items[0]).not.toHaveProperty("expectation");
    expect(initialList.items[0]).not.toHaveProperty("snapshot");
    const detail = execute(value, "getEvaluationSuiteCase", {
      ...versionScope,
      caseId: "case-build",
    });
    expect(detail.expectation.criteria[0]?.expectedOutcome).toBe("failed");
    expect(detail.source).toEqual(source);
    expect(detail.source).not.toHaveProperty("snapshot");
    const current = execute(value, "getEvaluationSuite", { ...scope(value), suiteId: suite.id });
    execute(value, "saveEvaluationSuiteDraft", {
      ...scope(value),
      suiteId: suite.id,
      request: {
        changeId: "clear-later-draft",
        expectedRevision: current.draftRevision,
        draft: { ...current.draft, name: "New draft with no cases", cases: [] },
      },
    });
    setEvaluationManagementRole(value.database, value.repositoryId, "viewer", 1);
    const beforeReads = persistedState(value.database);
    expect(
      execute(value, "listEvaluationSuiteCases", versionScope, afterPublication, {
        readOnly: true,
      }),
    ).toEqual(initialList);
    expect(
      execute(value, "getEvaluationSuiteCase", { ...versionScope, caseId: "case-build" }),
    ).toEqual(detail);
    expectCode(
      () => execute(value, "getEvaluationSuiteCase", { ...versionScope, caseId: "missing-case" }),
      "PLATFORM_NOT_FOUND",
    );
    expectCode(
      () =>
        execute(value, "listEvaluationSuiteCases", {
          ...versionScope,
          repositoryId: value.secondRepositoryId,
        }),
      "PLATFORM_NOT_FOUND",
    );
    expect(persistedState(value.database)).toEqual(beforeReads);
    setEvaluationManagementRole(value.database, value.repositoryId, null, 2);
    expectCode(
      () => execute(value, "getEvaluationSuiteCase", { ...versionScope, caseId: "case-build" }),
      "PLATFORM_NOT_FOUND",
    );
  });

  it("rejects stale save and publish CAS without allocating a receipt or version", () => {
    const value = fixture();
    const { source, suite, saved } = populatedSuite(value);
    const before = persistedState(value.database);
    expectCode(
      () =>
        execute(value, "saveEvaluationSuiteDraft", {
          ...scope(value),
          suiteId: suite.id,
          request: {
            changeId: "stale-save",
            expectedRevision: suite.draftRevision,
            draft: { ...draft(source.id), name: "Stale overwrite" },
          },
        }),
      "PLATFORM_CONFLICT",
    );
    expectCode(
      () =>
        execute(value, "publishEvaluationSuite", {
          ...scope(value),
          suiteId: suite.id,
          request: { changeId: "stale-publish", expectedRevision: suite.draftRevision },
        }),
      "PLATFORM_CONFLICT",
    );
    expect(persistedState(value.database)).toEqual(before);
    expect(
      execute(value, "publishEvaluationSuite", {
        ...scope(value),
        suiteId: suite.id,
        request: { changeId: "stale-publish", expectedRevision: saved.draftRevision },
      }).version,
    ).toBe(1);
  });

  it("rolls back both manifests and the suite CAS when publication insertion fails", () => {
    const value = fixture();
    const { suite, saved } = populatedSuite(value);
    const before = persistedState(value.database);
    value.database.exec(`CREATE TEMP TRIGGER fixture_publication_failure BEFORE INSERT ON evaluation_suite_versions
      BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END;`);
    const input = {
      ...scope(value),
      suiteId: suite.id,
      request: { changeId: "publish-retry", expectedRevision: saved.draftRevision },
    };
    expect(() => execute(value, "publishEvaluationSuite", input)).toThrow();
    expect(persistedState(value.database)).toEqual(before);
    expect(value.database.isTransaction).toBe(false);
    value.database.exec("DROP TRIGGER fixture_publication_failure");
    expect(execute(value, "publishEvaluationSuite", input).version).toBe(1);
  });

  it("rejects incompatible source kinds, unknown sources and out-of-repository sources atomically", () => {
    const value = fixture("issue");
    const issue = capture(value);
    const suite = createSuite(value, { workflowKind: "pr_static_build" });
    const before = persistedState(value.database);
    expectCode(
      () =>
        execute(value, "saveEvaluationSuiteDraft", {
          ...scope(value),
          suiteId: suite.id,
          request: {
            changeId: "save-wrong-kind",
            expectedRevision: suite.draftRevision,
            draft: draft(issue.id),
          },
        }),
      "PLATFORM_INVALID",
    );
    expectCode(
      () =>
        execute(value, "saveEvaluationSuiteDraft", {
          ...scope(value),
          suiteId: suite.id,
          request: {
            changeId: "save-missing-source",
            expectedRevision: suite.draftRevision,
            draft: draft("missing-source"),
          },
        }),
      "PLATFORM_NOT_FOUND",
    );
    expect(persistedState(value.database)).toEqual(before);
    setEvaluationManagementRole(value.database, value.secondRepositoryId, "maintainer");
    const foreign = execute(value, "captureEvaluationSource", {
      repositoryId: value.secondRepositoryId,
      actor,
      request: { changeId: "capture-foreign-source", source: value.secondReference },
    });
    const afterForeign = persistedState(value.database);
    expectCode(
      () =>
        execute(value, "saveEvaluationSuiteDraft", {
          ...scope(value),
          suiteId: suite.id,
          request: {
            changeId: "save-foreign-source",
            expectedRevision: suite.draftRevision,
            draft: draft(foreign.id),
          },
        }),
      "PLATFORM_NOT_FOUND",
    );
    expect(persistedState(value.database)).toEqual(afterForeign);
  });

  it.each(["issue_validation", "issue_triage"] as const)(
    "publishes %s only with its compatible frozen checkout selection",
    (workflowKind) => {
      const value = fixture("issue");
      const snapshot = capture(value, "capture-issue-snapshot");
      const commit = capture(value, "capture-issue-commit", {
        ...value.reference,
        testedIssueCommit: "c".repeat(40),
      });
      const suite = createSuite(value, { workflowKind });
      const compatible = workflowKind === "issue_validation" ? commit : snapshot;
      const incompatible = workflowKind === "issue_validation" ? snapshot : commit;
      const before = persistedState(value.database);
      expectCode(
        () =>
          execute(value, "saveEvaluationSuiteDraft", {
            ...scope(value),
            suiteId: suite.id,
            request: {
              changeId: "save-incompatible-checkout",
              expectedRevision: suite.draftRevision,
              draft: draft(incompatible.id),
            },
          }),
        "PLATFORM_INVALID",
      );
      expect(persistedState(value.database)).toEqual(before);
      const saved = execute(value, "saveEvaluationSuiteDraft", {
        ...scope(value),
        suiteId: suite.id,
        request: {
          changeId: "save-compatible-checkout",
          expectedRevision: suite.draftRevision,
          draft: draft(compatible.id),
        },
      });
      const published = execute(value, "publishEvaluationSuite", {
        ...scope(value),
        suiteId: suite.id,
        request: { changeId: "publish-issue", expectedRevision: saved.draftRevision },
      });
      const stored = manifests(value, published.sourceVersionId, published.expectationVersionId);
      expect(JSON.parse(stored.source.manifest_json)).toMatchObject({
        workflowKind,
        cases: [
          { caseId: "case-build", sourceId: compatible.id, sourceDigest: compatible.sourceDigest },
        ],
      });
    },
  );

  it("enforces case count and aggregate UTF-8 draft budgets without consuming the CAS", () => {
    const value = fixture();
    const source = capture(value);
    const suite = createSuite(value);
    const tooMany: EvaluationSuiteDraft = {
      ...draft(source.id),
      cases: Array.from({ length: 33 }, (_, index) => draftCase(source.id, `case-${index}`)),
    };
    const tooLarge: EvaluationSuiteDraft = {
      ...draft(source.id),
      cases: Array.from({ length: 4 }, (_, caseIndex) => ({
        ...draftCase(source.id, `case-${caseIndex}`),
        criteria: Array.from({ length: maximumEvaluationCriterionCount }, (_, index) => ({
          criterionId: `criterion-${index}`,
          description: "\u754c".repeat(2_048),
          applicability: { state: "applicable" as const },
          expectedOutcome: "failed" as const,
        })),
      })),
    };
    expect(canonicalJson(tooLarge).length).toBeLessThan(maximumEvaluationSuiteUtf8Bytes);
    expect(Buffer.byteLength(canonicalJson(tooLarge), "utf8")).toBeGreaterThan(
      maximumEvaluationSuiteUtf8Bytes,
    );
    const before = persistedState(value.database);
    for (const [changeId, invalidDraft] of [
      ["save-too-many", tooMany],
      ["save-too-large", tooLarge],
    ] as const) {
      expectCode(
        () =>
          execute(value, "saveEvaluationSuiteDraft", {
            ...scope(value),
            suiteId: suite.id,
            request: { changeId, expectedRevision: suite.draftRevision, draft: invalidDraft },
          }),
        "PLATFORM_INVALID",
      );
      expect(persistedState(value.database)).toEqual(before);
    }
    expect(
      execute(value, "saveEvaluationSuiteDraft", {
        ...scope(value),
        suiteId: suite.id,
        request: {
          changeId: "save-too-large",
          expectedRevision: suite.draftRevision,
          draft: draft(source.id),
        },
      }).draftRevision,
    ).toBe(suite.draftRevision + 1);
  });

  it("rejects aggregate frozen source bytes even when the draft and each captured source fit their limits", () => {
    const value = fixture();
    const changed = reviseEvaluationManagementSource(value, "x".repeat(1_048_576));
    const reference = { ...value.reference, expectedRevisionKey: changed.revisionKey };
    const sources = Array.from({ length: 17 }, (_, index) =>
      capture(value, `capture-large-${index}`, reference),
    );
    const suite = createSuite(value);
    const selectedDraft = {
      name: "Aggregate frozen source budget",
      description: "Individually valid captures must fit the complete suite budget.",
      cases: sources.map((source, index) => draftCase(source.id, `case-${index}`)),
    };
    expect(Buffer.byteLength(canonicalJson(selectedDraft), "utf8")).toBeLessThan(
      maximumEvaluationSuiteUtf8Bytes,
    );
    const sourceBytes = value.database
      .prepare("SELECT SUM(length(CAST(source_json AS BLOB))) AS bytes FROM evaluation_sources")
      .get() as { bytes: number };
    expect(sourceBytes.bytes).toBeGreaterThan(16 * 1024 * 1024);
    const before = persistedState(value.database);
    expectCode(
      () =>
        execute(value, "saveEvaluationSuiteDraft", {
          ...scope(value),
          suiteId: suite.id,
          request: {
            changeId: "save-source-budget",
            expectedRevision: suite.draftRevision,
            draft: selectedDraft,
          },
        }),
      "PLATFORM_INVALID",
    );
    expect(persistedState(value.database)).toEqual(before);
    expect(value.database.isTransaction).toBe(false);
  });

  it("rejects empty publication and all new writes in read-only recovery while retaining exact create replay", () => {
    const value = fixture();
    const request: EvaluationSuiteCreateRequest = {
      changeId: "create-replay",
      name: "Recovery suite",
      description: "An initially empty draft.",
      workflowKind: "pr_static_build",
      target: "headless",
    };
    const input = { ...scope(value), request };
    const suite = execute(value, "createEvaluationSuite", input);
    const before = persistedState(value.database);
    expectCode(
      () =>
        execute(value, "publishEvaluationSuite", {
          ...scope(value),
          suiteId: suite.id,
          request: { changeId: "publish-empty", expectedRevision: suite.draftRevision },
        }),
      "PLATFORM_INVALID",
    );
    expect(
      execute(value, "createEvaluationSuite", input, afterPublication, { readOnly: true }),
    ).toEqual(suite);
    expectCode(
      () =>
        execute(
          value,
          "createEvaluationSuite",
          { ...input, request: { ...request, changeId: "new-create" } },
          later,
          { readOnly: true },
        ),
      "DATABASE_READ_ONLY",
    );
    expectCode(
      () =>
        execute(
          value,
          "saveEvaluationSuiteDraft",
          {
            ...scope(value),
            suiteId: suite.id,
            request: {
              changeId: "new-save",
              expectedRevision: suite.draftRevision,
              draft: { name: suite.name, description: suite.description, cases: [] },
            },
          },
          later,
          { readOnly: true },
        ),
      "DATABASE_READ_ONLY",
    );
    expectCode(
      () =>
        execute(
          value,
          "publishEvaluationSuite",
          {
            ...scope(value),
            suiteId: suite.id,
            request: { changeId: "new-publish", expectedRevision: suite.draftRevision },
          },
          later,
          { readOnly: true },
        ),
      "DATABASE_READ_ONLY",
    );
    expect(persistedState(value.database)).toEqual(before);
  });

  it("scopes bounded source, suite and version reads to the authorized repository", () => {
    const value = fixture();
    const source = capture(value, "capture-first");
    capture(value, "capture-second");
    const suite = createSuite(value, { changeId: "create-first" });
    createSuite(value, { changeId: "create-second" });
    const saved = execute(value, "saveEvaluationSuiteDraft", {
      ...scope(value),
      suiteId: suite.id,
      request: {
        changeId: "save-page-suite",
        expectedRevision: suite.draftRevision,
        draft: draft(source.id),
      },
    });
    const published = execute(value, "publishEvaluationSuite", {
      ...scope(value),
      suiteId: suite.id,
      request: { changeId: "publish-page-suite", expectedRevision: saved.draftRevision },
    });
    const page = execute(value, "listEvaluationSources", {
      ...scope(value),
      query: { page: 1, pageSize: 1 },
    });
    const nextPage = execute(value, "listEvaluationSources", {
      ...scope(value),
      query: { page: 2, pageSize: 1 },
    });
    expect(page).toMatchObject({
      repositoryId: value.repositoryId,
      total: 2,
      page: 1,
      pageSize: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(nextPage.items).toHaveLength(1);
    expect(page.items[0]?.id).not.toBe(nextPage.items[0]?.id);
    expect(page.items[0]).not.toHaveProperty("snapshot");
    const suites = execute(value, "listEvaluationSuites", {
      ...scope(value),
      query: { page: 1, pageSize: 1 },
    });
    expect(suites.total).toBe(2);
    expect(suites.items).toHaveLength(1);
    expect(suites.items[0]).not.toHaveProperty("draft");
    expect(
      execute(value, "listEvaluationSuiteVersions", {
        ...scope(value),
        suiteId: suite.id,
        query: { page: 1, pageSize: 1 },
      }).items,
    ).toEqual([published]);
    setEvaluationManagementRole(value.database, value.secondRepositoryId, "maintainer");
    const foreignScope = { repositoryId: value.secondRepositoryId, actor };
    expect(execute(value, "listEvaluationSources", { ...foreignScope, query: {} }).items).toEqual(
      [],
    );
    expect(execute(value, "listEvaluationSuites", { ...foreignScope, query: {} }).items).toEqual(
      [],
    );
    for (const selectedScope of [foreignScope, scope(value)]) {
      const sourceId =
        selectedScope.repositoryId === value.repositoryId ? "missing-source" : source.id;
      expectCode(
        () => execute(value, "getEvaluationSource", { ...selectedScope, sourceId }),
        "PLATFORM_NOT_FOUND",
      );
    }
    expectCode(
      () => execute(value, "getEvaluationSuite", { ...foreignScope, suiteId: suite.id }),
      "PLATFORM_NOT_FOUND",
    );
    expectCode(
      () =>
        execute(value, "getEvaluationSuiteVersion", {
          ...foreignScope,
          suiteId: suite.id,
          versionId: published.id,
        }),
      "PLATFORM_NOT_FOUND",
    );
  });
});
