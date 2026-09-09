import * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../scheduling/canonical-json.js";
import {
  assertEvaluationAdjudicationSnapshotBudget,
  type EvaluationAdjudicationOperation,
  type EvaluationAdjudicationOperationMap,
  type EvaluationAdjudicationRequest,
  evaluationAdjudicationContextProjection,
  evaluationAdjudicationSetIssues,
  handleEvaluationAdjudicationRequest,
} from "./evaluation-adjudication.js";
import { createEvaluationBatchFixture } from "./evaluation-batches.testing.js";
import {
  beginAttempt,
  createEvaluationCompletionFixture,
  type EvaluationCompletionFixture,
  prepareEvaluationCompletionFixture,
  resultFor,
  selected,
  transaction,
} from "./evaluation-completion.testing.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import { handleEvaluationManagementRequest } from "./evaluation-management.js";
import {
  evaluationActor,
  evaluationAdministrator,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import { findingOccurrenceKey } from "./finding-disposition-projection.js";
import { insertHistoricalEvaluationResult } from "./historical-evaluation-results.testing.js";
import { getJobAdmissionRecord } from "./job-admission.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";

const now = "2026-09-08T04:03:00.000Z";
const administrators = [evaluationAdministrator];
const fixtures: EvaluationCompletionFixture[] = [];
const formats = new Map(["date-time", "uri"].map((key) => [key, FormatRegistry.Get(key)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
afterAll(() => {
  for (const [key, original] of formats) {
    if (original === undefined) FormatRegistry.Delete(key);
    else FormatRegistry.Set(key, original);
  }
});
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("The adjudication fixture is incomplete.");
  return value;
}
function fixture() {
  const value = createEvaluationCompletionFixture();
  fixtures.push(value);
  const cell = selected(value),
    body = resultFor(cell);
  if (body.report.workItemKind !== "issue")
    throw new Error("The fixture requires Issue validation.");
  body.report.modelSummary = {
    schemaVersion: "ValidationSummaryV1",
    workItemKind: "issue",
    summary: "Two independent compiler observations.",
    reproductionConclusion: "inconclusive",
    observations: ["first", "second"].map((id) => ({
      id,
      title: "Compiler failure",
      body: "The declared build failed.",
      priority: 1,
      path: "src/example.ts",
      line: 7,
    })),
  };
  const completion = beginAttempt(value, cell);
  const { resultId, resultDigest } = insertHistoricalEvaluationResult(
    value.database,
    cell,
    completion,
    body,
  );
  const input = {
    repositoryId: value.repositoryId,
    evaluationId: value.batch.id,
    cellId: cell.id,
    resultId,
    actor: evaluationActor,
  };
  const refs: C.FindingOccurrenceRef[] = [0, 1].map((ordinal) => {
    const ref = {
      resultId,
      resultDigest,
      kind: "validation_observation" as const,
      ordinal,
    };
    return { ...ref, key: findingOccurrenceKey(ref) };
  });
  function request<K extends EvaluationAdjudicationOperation>(
    operation: K,
    input: EvaluationAdjudicationOperationMap[K]["input"],
    options: { readOnly?: boolean } = {},
  ): EvaluationAdjudicationOperationMap[K]["output"] {
    return handleEvaluationAdjudicationRequest(
      value.database,
      { operation, input } as EvaluationAdjudicationRequest,
      now,
      administrators,
      options,
    ) as EvaluationAdjudicationOperationMap[K]["output"];
  }
  const change = (
    judgment: C.EvaluationAdjudicationChangeRequest["judgment"] = {
      kind: "false_positive",
      reason: "This does not describe a defect.",
    },
  ) => ({
    ...input,
    occurrenceKey: present(refs[0]).key,
    request: {
      changeId: "adjudicate-one",
      expectedVersion: 0,
      resultDigest,
      judgment,
    },
  });
  const counts = () =>
    value.database
      .prepare(`SELECT (SELECT COUNT(*) FROM evaluation_adjudication_events) AS events,
    (SELECT COUNT(*) FROM evaluation_mutation_receipts) AS receipts`)
      .get();
  return {
    value,
    cell,
    input,
    refs,
    resultDigest,
    request,
    change,
    counts,
  };
}

describe("evaluation adjudication owner boundaries", () => {
  it("reads stable actual occurrences and frozen expectations without claiming the profile-only model dimension", () => {
    const f = fixture();
    const context = f.request("getEvaluationAdjudicationContext", f.input);
    expect(context).toEqual({
      schemaVersion: "EvaluationAdjudicationContextV1",
      scope: {
        repositoryId: f.input.repositoryId,
        evaluationId: f.input.evaluationId,
        cellId: f.input.cellId,
        resultId: f.input.resultId,
      },
      resultDigest: f.resultDigest,
      caseId: f.cell.case_id,
      arm: "baseline",
      modelRequired: false,
      modelState: "completed",
      expectations: { annotation: "complete", expected: [] },
      items: f.refs.map((occurrence) => ({ occurrence, version: 0, adjudication: null })),
    });
    expect(C.getEvaluationAdjudicationContextIssues(context)).toEqual([]);
    const suite = handleEvaluationManagementRequest(
      f.value.database,
      {
        operation: "getEvaluationSuite",
        input: {
          repositoryId: f.value.repositoryId,
          actor: evaluationActor,
          suiteId: f.value.suite.id,
        },
      },
      now,
      administrators,
    ) as C.EvaluationSuiteDetailV1;
    const draft = structuredClone(suite.draft);
    present(draft.cases[0]).findings = {
      annotation: "complete",
      expected: [
        { expectedFindingId: "new-draft-label", description: "A later unpublished label." },
      ],
    };
    handleEvaluationManagementRequest(
      f.value.database,
      {
        operation: "saveEvaluationSuiteDraft",
        input: {
          repositoryId: f.value.repositoryId,
          actor: evaluationActor,
          suiteId: f.value.suite.id,
          request: {
            changeId: "save-later-adjudication-draft",
            expectedRevision: suite.draftRevision,
            draft,
          },
        },
      },
      now,
      administrators,
    );
    expect(f.request("getEvaluationAdjudicationContext", f.input)).toEqual(context);
  });

  it("returns complete empty history pages for real occurrences and rejects foreign selectors", () => {
    const f = fixture(),
      occurrenceKey = present(f.refs[0]).key;
    const history = f.request("listEvaluationAdjudicationHistory", {
      ...f.input,
      occurrenceKey,
      query: { page: 2, pageSize: 1 },
    });
    expect(history).toMatchObject({
      resultDigest: f.resultDigest,
      page: 2,
      pageSize: 1,
      total: 0,
      items: [],
    });
    expect(C.getEvaluationAdjudicationHistoryIssues(history)).toEqual([]);
    for (const scope of [
      { ...f.input, repositoryId: f.value.secondRepositoryId, actor: evaluationAdministrator },
      { ...f.input, evaluationId: "foreign-evaluation" },
      { ...f.input, cellId: selected(f.value, "candidate").id },
      { ...f.input, resultId: "foreign-result" },
    ])
      expect(() => f.request("getEvaluationAdjudicationContext", scope)).toThrow(
        expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
      );
    expect(() =>
      f.request("listEvaluationAdjudicationHistory", {
        ...f.input,
        occurrenceKey: "f".repeat(64),
        query: {},
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
  });

  it("requires current read or review permission before receipt lookup and recovery denial", () => {
    const f = fixture(),
      before = f.counts();
    setEvaluationManagementRole(f.value.database, f.value.repositoryId, "viewer", 1);
    expect(f.request("getEvaluationAdjudicationContext", f.input).items).toHaveLength(2);
    const collision = f.change();
    collision.request.changeId = "batch-capture-source";
    expect(() => f.request("changeEvaluationAdjudication", collision, { readOnly: true })).toThrow(
      expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }),
    );
    setEvaluationManagementRole(f.value.database, f.value.repositoryId, null, 2);
    expect(() => f.request("getEvaluationAdjudicationContext", f.input)).toThrow(
      expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
    );
    expect(() =>
      f.request("listEvaluationAdjudicationHistory", {
        ...f.input,
        occurrenceKey: present(f.refs[0]).key,
        query: {},
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(() => f.request("changeEvaluationAdjudication", f.change())).toThrow(
      expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
    );
    expect(f.counts()).toEqual(before);
  });

  it("rejects every new profile-only judgment without inserting an event or receipt", () => {
    const f = fixture(),
      before = f.counts();
    for (const judgment of [
      { kind: "false_positive", reason: "This is not a defect." },
      { kind: "unjudged", reason: "Leave this unresolved." },
      { kind: "match", expectedFindingId: "some-label", reason: "A proposed match." },
      {
        kind: "duplicate",
        primaryOccurrenceKey: present(f.refs[1]).key,
        reason: "A proposed duplicate.",
      },
    ] as const)
      expect(() => f.request("changeEvaluationAdjudication", f.change(judgment))).toThrow(
        expect.objectContaining({ code: "PLATFORM_INVALID" }),
      );
    expect(f.counts()).toEqual(before);
  });

  it("rejects unknown occurrences and mismatched result digests before any write", () => {
    const f = fixture(),
      before = f.counts();
    const digest = f.change();
    digest.request.resultDigest = "f".repeat(64);
    expect(() => f.request("changeEvaluationAdjudication", digest)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
    );
    expect(() =>
      f.request("changeEvaluationAdjudication", { ...f.change(), occurrenceKey: "e".repeat(64) }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(f.counts()).toEqual(before);
  });

  it("checks the shared exact change namespace before model eligibility and never grants a recovery write", () => {
    const f = fixture(),
      before = f.counts();
    const collision = f.change();
    collision.request.changeId = "batch-capture-source";
    expect(() => f.request("changeEvaluationAdjudication", collision)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
    );
    expect(() => f.request("changeEvaluationAdjudication", collision, { readOnly: true })).toThrow(
      expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
    );
    expect(() => f.request("changeEvaluationAdjudication", f.change(), { readOnly: true })).toThrow(
      expect.objectContaining({ code: "DATABASE_READ_ONLY" }),
    );
    expect(() =>
      f.request("changeEvaluationAdjudication", { ...f.change(), replayOnly: true }),
    ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
    expect(f.counts()).toEqual(before);
  });

  it("preserves the caller transaction on an operation failure", () => {
    const f = fixture();
    f.value.database.exec("CREATE TEMP TABLE adjudication_outer_probe(value TEXT)");
    f.value.database.exec("BEGIN IMMEDIATE");
    try {
      f.value.database
        .prepare("INSERT INTO adjudication_outer_probe(value) VALUES (?)")
        .run("outer-owned");
      expect(() => f.request("changeEvaluationAdjudication", f.change())).toThrow(
        expect.objectContaining({ code: "PLATFORM_INVALID" }),
      );
      expect(f.value.database.isTransaction).toBe(true);
      expect(f.value.database.prepare("SELECT value FROM adjudication_outer_probe").all()).toEqual([
        { value: "outer-owned" },
      ]);
      expect(
        f.value.database
          .prepare("SELECT COUNT(*) AS count FROM evaluation_adjudication_events")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      f.value.database.exec("ROLLBACK");
    }
  });

  it.each(["cancelled", "disabled"] as const)(
    "keeps historical context and history readable after %s",
    (state) => {
      const f = fixture(),
        expected = f.request("getEvaluationAdjudicationContext", f.input);
      if (state === "cancelled")
        transaction(f.value.database, () =>
          cancelEvaluationBatchInTransaction(
            f.value.database,
            {
              repositoryId: f.value.repositoryId,
              evaluationId: f.value.batch.id,
              actor: evaluationActor,
              request: {
                changeId: "cancel-adjudication-history",
                expectedVersion: 1,
                reason: "Stop future execution.",
              },
            },
            now,
            administrators,
          ),
        );
      else {
        const current = f.value.database
          .prepare("SELECT version FROM managed_repositories WHERE id = ?")
          .get(f.value.repositoryId) as { version: number };
        handleRepositoryConfigurationRequest(
          f.value.database,
          {
            operation: "updateManagedRepository",
            input: {
              repositoryId: f.value.repositoryId,
              actor: evaluationAdministrator,
              request: { expectedVersion: current.version, enabled: false },
            },
          },
          now,
        );
      }
      expect(f.request("getEvaluationAdjudicationContext", f.input)).toEqual(expected);
      expect(
        f.request("listEvaluationAdjudicationHistory", {
          ...f.input,
          occurrenceKey: present(f.refs[0]).key,
          query: {},
        }).total,
      ).toBe(0);
    },
  );

  it("rejects malformed selectors, authority fields, CAS values and pagination", () => {
    const f = fixture();
    for (const input of [
      { ...f.change(), cellId: `${f.input.cellId}\n` },
      { ...f.change(), replayOnly: false },
      { ...f.change(), request: { ...f.change().request, expectedVersion: -1 } },
      {
        ...f.change(),
        request: { ...f.change().request, expectedVersion: Number.MAX_SAFE_INTEGER },
      },
      { ...f.change(), request: { ...f.change().request, actor: evaluationAdministrator } },
      {
        ...f.change(),
        request: { ...f.change().request, judgment: { kind: "unjudged", reason: "bad\ud800" } },
      },
    ])
      expect(() => f.request("changeEvaluationAdjudication", input as never)).toThrow(
        expect.objectContaining({ code: "PLATFORM_INVALID" }),
      );
    for (const query of [
      { page: 0 },
      { pageSize: 51 },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
      { resultDigest: f.resultDigest },
    ])
      expect(() =>
        f.request("listEvaluationAdjudicationHistory", {
          ...f.input,
          occurrenceKey: present(f.refs[0]).key,
          query,
        } as never),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });

  it("admits model-required work to a Worker with CLI execution capability", () => {
    const value = prepareEvaluationCompletionFixture(
      createEvaluationBatchFixture("pull_request", { notApplicableCase: false }),
      "pull_request",
      { [C.evaluationModelExecutionCapabilityLabels.review]: "1" },
    );
    fixtures.push(value);
    const cell = selected(value),
      admission = present(getJobAdmissionRecord(value.database, cell.jobId));
    expect(cell.plan.modelRequirements).toEqual({
      required: true,
    });
    expect(admission.state).toBe("admitted");
    expect(admission.blockers).toEqual([]);
    expect(value.database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
    expect(
      value.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });
});

describe("evaluation adjudication current-set invariants", () => {
  function setFixture() {
    const resultId = "result-a",
      resultDigest = "a".repeat(64);
    const occurrences: C.FindingOccurrenceRef[] = [0, 1, 2].map((ordinal) => {
      const occurrence = { resultId, resultDigest, kind: "pr_finding" as const, ordinal };
      return { ...occurrence, key: findingOccurrenceKey(occurrence) };
    });
    const binding = {
      caseId: "case-a",
      arm: "baseline" as const,
      resultId,
      resultDigest,
      occurrences,
      expectations: {
        annotation: "complete" as const,
        expected: [
          { expectedFindingId: "expected-a", description: "First known defect." },
          { expectedFindingId: "expected-b", description: "Second known defect." },
        ],
      },
    };
    const judgment = (
      index: number,
      choice: C.EvaluationAdjudicationChangeRequest["judgment"],
    ): C.EvaluationFindingAdjudication => ({
      ...choice,
      adjudicationId: `event-${index}`,
      caseId: binding.caseId,
      arm: binding.arm,
      resultId,
      resultDigest,
      occurrenceKey: present(occurrences[index]).key,
      actor: evaluationActor,
      createdAt: now,
    });
    const primary = judgment(0, {
      kind: "match",
      expectedFindingId: "expected-a",
      reason: "The known defect was observed.",
    });
    const duplicate = judgment(1, {
      kind: "duplicate",
      primaryOccurrenceKey: primary.occurrenceKey,
      reason: "The same defect was repeated.",
    });
    return { binding, judgment, primary, duplicate };
  }

  it("accepts explicit primary, duplicate, false-positive and unjudged selections", () => {
    const f = setFixture();
    expect(
      evaluationAdjudicationSetIssues(f.binding, [
        f.primary,
        f.duplicate,
        f.judgment(2, { kind: "false_positive", reason: "This does not identify a defect." }),
      ]),
    ).toEqual([]);
    expect(
      evaluationAdjudicationSetIssues(f.binding, [
        f.primary,
        f.duplicate,
        f.judgment(2, { kind: "unjudged", reason: "This is not yet judged." }),
      ]),
    ).toEqual([]);
  });

  it("rejects duplicate chains, self-links and non-matched or absent primaries", () => {
    const f = setFixture();
    for (const judgments of [
      [f.duplicate],
      [f.primary, { ...f.duplicate, primaryOccurrenceKey: f.duplicate.occurrenceKey }],
      [
        f.primary,
        f.duplicate,
        f.judgment(2, {
          kind: "duplicate",
          primaryOccurrenceKey: f.duplicate.occurrenceKey,
          reason: "An invalid second hop.",
        }),
      ],
      [
        f.judgment(0, { kind: "false_positive", reason: "The primary is no longer matched." }),
        f.duplicate,
      ],
      [f.judgment(0, { kind: "unjudged", reason: "Reset the primary." }), f.duplicate],
    ])
      expect(evaluationAdjudicationSetIssues(f.binding, judgments).length).toBeGreaterThan(0);
  });

  it("rejects duplicate expected matches, unknown labels and foreign result/case/arm/occurrence bindings", () => {
    const f = setFixture();
    for (const judgments of [
      [
        f.primary,
        f.judgment(1, {
          kind: "match",
          expectedFindingId: "expected-a",
          reason: "A second primary is invalid.",
        }),
      ],
      [
        f.judgment(0, {
          kind: "match",
          expectedFindingId: "unknown",
          reason: "Unknown frozen label.",
        }),
      ],
      [f.primary, { ...f.primary, adjudicationId: "another-event" }],
      [{ ...f.primary, resultId: "other-result" }],
      [{ ...f.primary, resultDigest: "b".repeat(64) }],
      [{ ...f.primary, caseId: "other-case" }],
      [{ ...f.primary, arm: "candidate" as const }],
      [{ ...f.primary, occurrenceKey: "f".repeat(64) }],
    ])
      expect(evaluationAdjudicationSetIssues(f.binding, judgments).length).toBeGreaterThan(0);
  });

  it("keeps duplicate relationships attached to stable primary occurrences across valid primary edits", () => {
    const f = setFixture();
    const changed = {
      ...f.primary,
      adjudicationId: "new-primary-event",
      reason: "A revised explanation.",
    };
    expect(evaluationAdjudicationSetIssues(f.binding, [changed, f.duplicate])).toEqual([]);
    if (changed.kind !== "match") throw new Error("The primary fixture must be a match.");
    expect(
      evaluationAdjudicationSetIssues(f.binding, [
        { ...changed, expectedFindingId: "expected-b" },
        f.duplicate,
      ]),
    ).toEqual([]);
  });

  it("rejects an aggregate context budget even when each individual event fits its storage limit", () => {
    const f = setFixture();
    const occurrences: C.FindingOccurrenceRef[] = Array.from(
      { length: C.maximumFindingResultOccurrenceCount },
      (_, index) => {
        const ref = {
          resultId: f.binding.resultId,
          resultDigest: f.binding.resultDigest,
          kind: index < 100 ? ("pr_finding" as const) : ("validation_observation" as const),
          ordinal: index % 100,
        };
        return { ...ref, key: findingOccurrenceKey(ref) };
      },
    );
    const bound = {
      ...f.binding,
      occurrences,
      modelRequired: true,
      modelState: "completed" as const,
    };
    const current = new Map<
      string,
      { version: number; adjudication: C.EvaluationFindingAdjudication }
    >();
    for (const occurrence of occurrences) {
      const adjudication: C.EvaluationFindingAdjudication = {
        adjudicationId: `large-event-${occurrence.kind}-${occurrence.ordinal}`,
        caseId: bound.caseId,
        arm: bound.arm,
        resultId: bound.resultId,
        resultDigest: bound.resultDigest,
        occurrenceKey: occurrence.key,
        kind: "false_positive",
        reason: "述".repeat(2048),
        actor: { issuer: `https://example.test/${"源".repeat(2020)}`, subject: "人".repeat(512) },
        createdAt: now,
      };
      C.assertEvaluationFindingAdjudications([adjudication]);
      expect(Buffer.byteLength(canonicalJson(adjudication), "utf8")).toBeLessThanOrEqual(16384);
      current.set(occurrence.key, { version: 1, adjudication });
    }
    const scope = {
      repositoryId: "repository-a",
      evaluationId: "evaluation-a",
      cellId: "cell-a",
      resultId: bound.resultId,
    };
    // This exercises only the shared projection budget, without any execution or write authority.
    const first = present(occurrences[0]);
    const small = evaluationAdjudicationContextProjection(
      scope,
      bound,
      new Map([[first.key, present(current.get(first.key))]]),
    );
    expect(C.getEvaluationAdjudicationContextIssues(small)).toEqual([]);
    const oversized = evaluationAdjudicationContextProjection(scope, bound, current);
    expect(Buffer.byteLength(canonicalJson(oversized), "utf8")).toBeGreaterThan(
      C.maximumEvaluationAdjudicationReadUtf8Bytes,
    );
    expect(
      C.getEvaluationAdjudicationContextIssues(oversized).some((issue) => issue.includes("UTF-8")),
    ).toBe(true);
  });
});

describe("evaluation adjudication batch snapshot budget", () => {
  const bytes = (value: unknown) => Buffer.byteLength(canonicalJson(value), "utf8");
  function event(
    index = 0,
    reason = "The reviewer inspected the frozen occurrence.",
  ): C.EvaluationFindingAdjudication {
    return {
      adjudicationId: `budget-event-${index}`,
      caseId: "budget-case",
      arm: "baseline",
      resultId: "budget-result",
      resultDigest: "a".repeat(64),
      occurrenceKey: index.toString(16).padStart(64, "0"),
      kind: "false_positive",
      reason,
      actor: { issuer: "i", subject: "s" },
      createdAt: now,
    };
  }
  function aggregate(events: readonly C.EvaluationFindingAdjudication[]) {
    return {
      currentCount: events.length,
      currentEventBytes: events.reduce((total, entry) => total + bytes(entry), 0),
    };
  }
  function eventAtBytes(size: number): C.EvaluationFindingAdjudication {
    const value = event(0, "r");
    let remaining = size - bytes(value);
    const fill = (original: string, maximumLength: number): string => {
      const unicode = Math.min(maximumLength - original.length, Math.floor(remaining / 3));
      remaining -= unicode * 3;
      const ascii = Math.min(maximumLength - original.length - unicode, remaining);
      remaining -= ascii;
      return `${original}${"雪".repeat(unicode)}${"x".repeat(ascii)}`;
    };
    value.reason = fill(value.reason, 2048);
    value.actor.issuer = fill(value.actor.issuer, 2048);
    value.actor.subject = fill(value.actor.subject, 512);
    if (remaining !== 0) throw new Error("The pure budget fixture could not fill the byte target.");
    C.assertEvaluationFindingAdjudications([value]);
    expect(bytes(value)).toBe(size);
    expect(bytes(value)).toBeLessThanOrEqual(16384);
    return value;
  }

  it("accounts for brackets on the first UTF-8 event and commas on an addition", () => {
    const first = event(1, 'Unicode 雪😀, a quote ", and a newline\nremain exact.');
    const firstBudget = assertEvaluationAdjudicationSnapshotBudget({
      ...aggregate([]),
      replacedEventBytes: null,
      proposedEventJson: canonicalJson(first),
    });
    expect(firstBudget).toEqual({ count: 1, utf8Bytes: bytes([first]) });
    expect(firstBudget.utf8Bytes).toBe(bytes(first) + 2);
    const added = event(2, "Another independently selected occurrence.");
    const next = assertEvaluationAdjudicationSnapshotBudget({
      ...aggregate([first]),
      replacedEventBytes: null,
      proposedEventJson: canonicalJson(added),
    });
    expect(next).toEqual({ count: 2, utf8Bytes: bytes([first, added]) });
    expect(next.utf8Bytes).toBe(firstBudget.utf8Bytes + bytes(added) + 1);
  });

  it("subtracts exactly the replaced UTF-8 head without adding another array element", () => {
    const first = event(1, "The first head remains unchanged."),
      replaced = event(2, "雪".repeat(100)),
      replacement = event(3, "A shorter replacement.");
    const budget = assertEvaluationAdjudicationSnapshotBudget({
      ...aggregate([first, replaced]),
      replacedEventBytes: bytes(replaced),
      proposedEventJson: canonicalJson(replacement),
    });
    expect(budget).toEqual({ count: 2, utf8Bytes: bytes([first, replacement]) });
    expect(budget.utf8Bytes).toBe(bytes([first, replaced]) - bytes(replaced) + bytes(replacement));
  });

  it("permits replacement at the current-head count limit but rejects a new head", () => {
    const heads = Array.from({ length: C.maximumEvaluationAdjudicationCount }, (_, index) =>
      event(index, "r"),
    );
    const replacement = event(C.maximumEvaluationAdjudicationCount, "r");
    const current = aggregate(heads);
    const replaced = present(heads[0]);
    const proposed = [replacement, ...heads.slice(1)];
    expect(bytes(proposed)).toBeLessThan(C.maximumEvaluationScoringInputUtf8Bytes);
    expect(
      assertEvaluationAdjudicationSnapshotBudget({
        ...current,
        replacedEventBytes: bytes(replaced),
        proposedEventJson: canonicalJson(replacement),
      }),
    ).toEqual({ count: C.maximumEvaluationAdjudicationCount, utf8Bytes: bytes(proposed) });
    expect(() =>
      assertEvaluationAdjudicationSnapshotBudget({
        ...current,
        replacedEventBytes: null,
        proposedEventJson: canonicalJson(replacement),
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });

  it("accepts exactly 16 MiB including the final comma and rejects one more UTF-8 byte", () => {
    const maximum = C.maximumEvaluationScoringInputUtf8Bytes;
    const full = eventAtBytes(12_000);
    const minimum = bytes(event(0, "r"));
    const count = Math.floor((maximum - minimum - 3) / (bytes(full) + 1));
    // These objects exercise serialization arithmetic only; they create no model result or event.
    const heads = Array.from({ length: count }, () => full);
    const remaining = maximum - bytes(heads) - 1;
    const last = eventAtBytes(remaining);
    const oversizedLast = eventAtBytes(remaining + 1);
    const current = aggregate(heads);
    const exact = [...heads, last];
    expect(exact.length).toBeLessThan(C.maximumEvaluationAdjudicationCount);
    expect(bytes(exact)).toBe(maximum);
    expect(
      assertEvaluationAdjudicationSnapshotBudget({
        ...current,
        replacedEventBytes: null,
        proposedEventJson: canonicalJson(last),
      }),
    ).toEqual({ count: exact.length, utf8Bytes: maximum });
    expect(bytes([...heads, oversizedLast])).toBe(maximum + 1);
    expect(() =>
      assertEvaluationAdjudicationSnapshotBudget({
        ...current,
        replacedEventBytes: null,
        proposedEventJson: canonicalJson(oversizedLast),
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));

    const exactAggregate = aggregate(exact);
    const smaller = eventAtBytes(bytes(full) - 1);
    expect(
      assertEvaluationAdjudicationSnapshotBudget({
        ...exactAggregate,
        replacedEventBytes: bytes(full),
        proposedEventJson: canonicalJson(smaller),
      }),
    ).toEqual({ count: exact.length, utf8Bytes: bytes([smaller, ...heads.slice(1), last]) });
    expect(() =>
      assertEvaluationAdjudicationSnapshotBudget({
        ...exactAggregate,
        replacedEventBytes: bytes(full),
        proposedEventJson: canonicalJson(eventAtBytes(bytes(full) + 1)),
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });

  it("rejects impossible or unsafe aggregate arithmetic as an invalid proposed write", () => {
    const json = canonicalJson(event());
    for (const invalid of [
      { currentCount: -1, currentEventBytes: 0, replacedEventBytes: null },
      { currentCount: 0, currentEventBytes: 1, replacedEventBytes: null },
      { currentCount: 0, currentEventBytes: 0, replacedEventBytes: 1 },
      { currentCount: 1, currentEventBytes: 100, replacedEventBytes: 101 },
      { currentCount: 1, currentEventBytes: 100, replacedEventBytes: 0 },
      { currentCount: Number.MAX_SAFE_INTEGER, currentEventBytes: 100, replacedEventBytes: null },
      { currentCount: 1, currentEventBytes: Number.MAX_SAFE_INTEGER, replacedEventBytes: null },
      { currentCount: 1.5, currentEventBytes: 100, replacedEventBytes: null },
      { currentCount: 1, currentEventBytes: Number.NaN, replacedEventBytes: null },
    ])
      expect(() =>
        assertEvaluationAdjudicationSnapshotBudget({ ...invalid, proposedEventJson: json }),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });
});
