import * as C from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvaluationBatchFixture,
  publishEvaluationConfiguration,
} from "./evaluation-batches.testing.js";
import {
  evaluationActor,
  evaluationAdministrator,
  reviseEvaluationManagementSource,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import {
  type EvaluationBatchOperation,
  type EvaluationBatchOperationMap,
  type EvaluationBatchRequest,
  handleEvaluationBatchRequest,
  isEvaluationBatchOperation,
} from "./evaluation-queries.js";
import { handleValidationDispatchRequest } from "./validation-dispatch.js";

const now = "2026-09-08T04:00:00.000Z";
type Fixture = ReturnType<typeof createEvaluationBatchFixture>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
function fixture(kind: "issue" | "pull_request" = "issue") {
  const value = createEvaluationBatchFixture(kind);
  fixtures.push(value);
  return value;
}
function execute<K extends EvaluationBatchOperation>(
  value: Fixture,
  operation: K,
  input: EvaluationBatchOperationMap[K]["input"],
  options?: { readOnly?: boolean },
): EvaluationBatchOperationMap[K]["output"] {
  return handleEvaluationBatchRequest(
    value.database,
    { operation, input } as EvaluationBatchRequest,
    now,
    [evaluationAdministrator],
    options,
  ) as EvaluationBatchOperationMap[K]["output"];
}
const scope = (value: Fixture, actor = evaluationActor) => ({
  repositoryId: value.repositoryId,
  actor,
});
function create(
  value: Fixture,
  mode: C.EvaluationBatchMode = "profile_only",
  changeId = "public-create",
) {
  return execute(value, "createEvaluationBatch", {
    ...value.input,
    request: { ...value.input.request, mode, changeId },
  });
}
function read(value: Fixture, evaluationId: string) {
  return execute(value, "getEvaluationBatch", { ...scope(value), evaluationId });
}
function matrix(value: Fixture, evaluationId: string) {
  return execute(value, "getEvaluationBatchMatrix", { ...scope(value), evaluationId });
}
function dispatch(value: Fixture) {
  return handleValidationDispatchRequest(
    value.database,
    { operation: "dispatchPendingReviewRuns", input: { limit: 128 } },
    now,
  );
}
function cancel(value: Fixture, evaluationId: string, options?: { readOnly?: boolean }) {
  return execute(
    value,
    "cancelEvaluationBatch",
    {
      ...scope(value),
      evaluationId,
      request: { changeId: "public-cancel", expectedVersion: 1, reason: "Stop this comparison." },
    },
    options,
  );
}
function options(
  value: Fixture,
  actor = evaluationActor,
  query: Partial<C.EvaluationPromptOptionsQuery> = {},
) {
  return execute(value, "listEvaluationPromptOptions", {
    ...scope(value, actor),
    query: { workflowKind: "issue_validation", ...query },
  });
}

describe("public evaluation batch owner", () => {
  it("creates in an owned transaction and returns paired immutable identities without execution claims", () => {
    const value = fixture(),
      batch = create(value);
    expect(value.database.isTransaction).toBe(false);
    const detail = read(value, batch.id),
      paired = matrix(value, batch.id);
    expect(detail.summary).toEqual(batch);
    expect(detail.suiteVersion).toEqual(value.version);
    expect(detail).toMatchObject({
      status: "pending",
      controlStatus: "active",
      controlVersion: 1,
      progress: {
        totalCells: 4,
        applicableCells: 2,
        notApplicableCells: 2,
        not_run: 2,
        blocked: 0,
        completed: 0,
      },
    });
    expect(paired.cases.map((entry) => entry.caseId)).toEqual([
      "case-compiler",
      "case-other-target",
    ]);
    const first = paired.cases[0];
    expect(first?.baseline.runId).not.toBe(first?.candidate.runId);
    expect(first?.baseline.job).toBeNull();
    expect(first?.baseline.result).toBeNull();
    expect(C.getEvaluationBatchDetailIssues(detail)).toEqual([]);
    expect(C.getEvaluationBatchMatrixIssues(paired)).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(value.baseline.prompt.content);
    expect(JSON.stringify(paired)).not.toContain("original full report body");
    expect(value.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["issue", "pull_request"] as const)(
    "reports missing verified model identity for %s without completed cells",
    (kind) => {
      const value = fixture(kind),
        batch = create(value, "prompt_and_profile");
      for (const checked of [false, true]) {
        if (checked) dispatch(value);
        const result = matrix(value, batch.id);
        expect(result).toMatchObject({
          status: "blocked",
          progress: { blocked: 2, completed: 0, notApplicableCells: 2 },
        });
        expect(result.cases[0]?.baseline.blockers).toContainEqual({
          code: "missing_capability",
          capability: "verified_model_identity",
        });
        expect(result.cases[1]?.baseline.state).toBe("not_run");
      }
    },
  );

  it("moves applicable cells from pending to queued and then cancelled while retaining frozen content", () => {
    const value = fixture(),
      batch = create(value),
      original = matrix(value, batch.id);
    reviseEvaluationManagementSource(value, "A different current report.");
    dispatch(value);
    expect(read(value, batch.id)).toMatchObject({
      status: "awaiting_admission",
      progress: { awaiting_admission: 2, queued: 0, not_run: 0 },
    });
    const receipt = cancel(value, batch.id);
    expect(receipt).toMatchObject({ cancelledJobCount: 2, cancellationRequestedJobCount: 0 });
    expect(cancel(value, batch.id, { readOnly: true })).toEqual(receipt);
    const result = matrix(value, batch.id);
    expect(result).toMatchObject({
      status: "cancelled",
      progress: { cancelled: 2, notApplicableCells: 2 },
    });
    expect(result.cases.map((entry) => entry.source)).toEqual(
      original.cases.map((entry) => entry.source),
    );
    expect(result.cases[1]?.baseline).toMatchObject({ state: "not_run", job: null, result: null });
    expect(read(value, batch.id).control).toMatchObject({
      version: 2,
      reason: receipt.reason,
      updatedBy: evaluationActor,
    });
  });

  it("cancels pending cells without creating Jobs or counting not-applicable cells as cancelled", () => {
    const value = fixture(),
      batch = create(value);
    expect(cancel(value, batch.id)).toMatchObject({ cancelledJobCount: 0 });
    const result = matrix(value, batch.id);
    expect(result.progress).toMatchObject({ cancelled: 2, notApplicableCells: 2 });
    for (const entry of result.cases)
      for (const arm of ["baseline", "candidate"] as const) expect(entry[arm].job).toBeNull();
  });

  it("bounds displayed blockers while preserving the complete reason count", () => {
    const value = fixture(),
      batch = create(value);
    const blockers = Array.from({ length: 20 }, (_, index) => ({
      code: "missing_capability",
      capability: `fixture-${index}`,
    }));
    value.database
      .prepare(`UPDATE validation_dispatch_checks SET checked_at = ?, blockers_json = ?
      WHERE review_run_id IN (SELECT run_id FROM evaluation_cells WHERE evaluation_id = ? AND applicable = 1)`)
      .run(now, JSON.stringify(blockers), batch.id);
    const result = matrix(value, batch.id);
    expect(result.cases[0]?.baseline).toMatchObject({
      state: "blocked",
      blockerCount: 20,
      blockers: blockers.slice(0, 16),
    });
    expect(read(value, batch.id).progress.blocked).toBe(2);
  });

  it("keeps repository-scoped pagination and suite/workflow filters consistent", () => {
    const value = fixture(),
      first = create(value),
      second = create(value, "profile_only", "second-create");
    const firstPage = execute(value, "listEvaluationBatches", {
      ...scope(value),
      query: { page: 1, pageSize: 1, suiteId: value.suite.id, workflowKind: "issue_validation" },
    });
    const nextPage = execute(value, "listEvaluationBatches", {
      ...scope(value),
      query: { page: 2, pageSize: 1 },
    });
    expect(firstPage.total).toBe(2);
    expect(
      new Set([...firstPage.items, ...nextPage.items].map((entry) => entry.summary.id)),
    ).toEqual(new Set([first.id, second.id]));
    for (const query of [
      { page: 3, pageSize: 1 },
      { suiteId: "missing-suite" },
      { workflowKind: "pr_static_build" as const },
    ]) {
      expect(execute(value, "listEvaluationBatches", { ...scope(value), query }).items).toEqual([]);
    }
    expect(
      execute(value, "listEvaluationBatches", {
        repositoryId: value.secondRepositoryId,
        actor: evaluationAdministrator,
        query: {},
      }),
    ).toMatchObject({ total: 0, items: [] });
    for (const operation of ["getEvaluationBatch", "getEvaluationBatchMatrix"] as const) {
      expect(() =>
        execute(value, operation, {
          repositoryId: value.secondRepositoryId,
          actor: evaluationAdministrator,
          evaluationId: first.id,
        }),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    }
  });

  it("restricts Prompt choices to the current binding or the same repository's frozen runs", () => {
    const value = fixture();
    const unrelated = publishEvaluationConfiguration(
      value.database,
      value.repositoryId,
      "issue_validation",
      "Unselected prompt",
    );
    const otherWorkflow = publishEvaluationConfiguration(
      value.database,
      value.repositoryId,
      "pr_static_build",
      "PR-only prompt",
    );
    expect(options(value).items.map((entry) => [entry.id, entry.visibility])).toEqual([
      [value.baseline.prompt.id, "binding"],
    ]);
    create(value);
    const visible = options(value);
    expect(visible.items.map((entry) => entry.id).sort()).toEqual(
      [value.baseline.prompt.id, value.candidate.prompt.id].sort(),
    );
    expect(visible.items.find((entry) => entry.id === value.candidate.prompt.id)?.visibility).toBe(
      "frozen_run",
    );
    expect(JSON.stringify(visible)).not.toContain(value.candidate.prompt.content);
    const all = options(value, evaluationAdministrator);
    expect(all.items.map((entry) => entry.id)).toContain(unrelated.prompt.id);
    expect(all.items.map((entry) => entry.id)).not.toContain(otherWorkflow.prompt.id);
    expect(all.items.every((entry) => entry.visibility === "platform")).toBe(true);
    expect(options(value, evaluationAdministrator, { page: 2, pageSize: 2 })).toMatchObject({
      total: 3,
      items: [expect.any(Object)],
    });
    setEvaluationManagementRole(value.database, value.secondRepositoryId, "maintainer");
    expect(
      execute(value, "listEvaluationPromptOptions", {
        repositoryId: value.secondRepositoryId,
        actor: evaluationActor,
        query: { workflowKind: "issue_validation" },
      }).items,
    ).toEqual([]);
  });

  it.each(["viewer", "reviewer"] as const)(
    "allows %s reads but refuses configuration, Prompt choices and cancellation",
    (role) => {
      const value = fixture(),
        batch = create(value);
      setEvaluationManagementRole(value.database, value.repositoryId, role, 1);
      expect(read(value, batch.id).summary.id).toBe(batch.id);
      expect(matrix(value, batch.id).evaluationId).toBe(batch.id);
      expect(() => options(value)).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
      expect(() => cancel(value, batch.id)).toThrow(
        expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }),
      );
      expect(() =>
        execute(value, "createEvaluationBatch", { ...value.input, actor: evaluationActor }),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
    },
  );

  it("rechecks current permission before returning retained mutation receipts", () => {
    const value = fixture();
    const input = {
      ...value.input,
      actor: evaluationActor,
      request: {
        ...value.input.request,
        candidate: value.baseline.selection,
        checkMappings: value.input.request.checkMappings.map((entry) => ({
          ...entry,
          candidateCheckId: entry.baselineCheckId,
        })),
        mode: "profile_only" as const,
      },
    };
    const batch = execute(value, "createEvaluationBatch", input);
    expect(
      execute(value, "createEvaluationBatch", { ...input, replayOnly: true }, { readOnly: true }),
    ).toEqual(batch);
    setEvaluationManagementRole(value.database, value.repositoryId, "viewer", 1);
    expect(() =>
      execute(value, "createEvaluationBatch", { ...input, replayOnly: true }, { readOnly: true }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
    setEvaluationManagementRole(value.database, value.repositoryId, null, 2);
    expect(() => read(value, batch.id)).toThrow(
      expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
    );
  });

  it.each(["owner", "transport"] as const)(
    "prevents new %s recovery mutations and preserves the transaction",
    (boundary) => {
      const value = fixture();
      const input = {
        ...value.input,
        ...(boundary === "transport" ? { replayOnly: true as const } : {}),
      };
      expect(() =>
        execute(value, "createEvaluationBatch", input, { readOnly: boundary === "owner" }),
      ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
      expect(value.database.isTransaction).toBe(false);
      expect(execute(value, "listEvaluationBatches", { ...scope(value), query: {} }).total).toBe(0);
    },
  );

  it("uses a savepoint so outer rollback also removes the complete new batch and receipt", () => {
    const value = fixture();
    value.database.exec("BEGIN IMMEDIATE");
    const batch = create(value);
    expect(value.database.isTransaction).toBe(true);
    expect(read(value, batch.id).summary.id).toBe(batch.id);
    value.database.exec("ROLLBACK");
    expect(execute(value, "listEvaluationBatches", { ...scope(value), query: {} }).total).toBe(0);
    expect(
      value.database
        .prepare(
          "SELECT COUNT(*) AS count FROM evaluation_mutation_receipts WHERE change_id = 'public-create'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it.each([
    { page: 0 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
    { pageSize: 51 },
    { unknown: true },
  ])("rejects invalid list query %j before SQL", (query) => {
    const value = fixture();
    expect(() =>
      execute(value, "listEvaluationBatches", {
        ...scope(value),
        query,
      } as EvaluationBatchOperationMap["listEvaluationBatches"]["input"]),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
    expect(value.database.isTransaction).toBe(false);
  });

  it("exposes only the six reviewed public operations", () => {
    expect(isEvaluationBatchOperation("createEvaluationBatch")).toBe(true);
    for (const operation of [
      "cancelEvaluationJob",
      "dispatchPendingReviewRuns",
      "toString",
      "__proto__",
    ])
      expect(isEvaluationBatchOperation(operation)).toBe(false);
  });
});
