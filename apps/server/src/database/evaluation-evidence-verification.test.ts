import { DatabaseSync } from "node:sqlite";
import { setImmediate as immediate } from "node:timers/promises";
import type { EvaluationCellResultReadQuery } from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationResultSelection } from "./evaluation-result-selection.js";
import * as evidenceAssets from "./evidence-assets.js";
import { EvidenceVerificationCoordinator } from "./evidence-verification.js";
import { EvidenceVerificationError } from "./evidence-verification-protocol.js";
import type { ValidationEvidenceReferenceScope } from "./validation-results.js";

const readers = vi.hoisted(() => ({ selection: vi.fn(), identity: vi.fn() }));
vi.mock("./evaluation-result-selection.js", () => ({
  readEvaluationResultSelectionInTransaction: readers.selection,
  readEvaluationResultIdentityInTransaction: readers.identity,
}));

const query: EvaluationCellResultReadQuery = {
  repositoryId: "repository-a",
  evaluationId: "evaluation-a",
  cellId: "cell-baseline",
  resultId: "result-baseline",
};
const evidenceScope: ValidationEvidenceReferenceScope = {
  repositoryId: query.repositoryId,
  runId: "run-baseline",
  requestId: "request-baseline",
  jobId: "job-baseline",
  runAttemptId: "attempt-baseline",
  profileVersionId: "profile-baseline",
  checkId: "profile-baseline:compile",
  evidenceIds: ["00000000-0000-4000-8000-000000000001"],
};
const resources: { database: DatabaseSync; coordinator: EvidenceVerificationCoordinator }[] = [];
beforeEach(() => {
  readers.selection.mockReset();
  readers.identity.mockReset();
});
afterEach(async () => {
  for (const { database, coordinator } of resources.splice(0)) {
    await coordinator.close();
    database.close();
  }
  vi.restoreAllMocks();
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  const coordinator = new EvidenceVerificationCoordinator(database, {
    storage: {
      evidenceDirectory: "/unused-evaluation-evidence",
      globalQuotaBytes: 1024,
      globalAssetLimit: 1,
      retentionMs: 1000,
      incompleteUploadTtlMs: 1000,
    },
  });
  resources.push({ database, coordinator });
  // This unit seam represents already-validated owner output. Real sealed/result/file binding
  // belongs to the owner integration tests; no result or execution authority is inserted here.
  const selection = {
    identityDigest: "a".repeat(64),
    row: {
      id: query.resultId,
      jobId: "job-baseline",
      requestId: "request-baseline",
      runAttemptId: "attempt-baseline",
      resultDigest: "b".repeat(64),
    },
    cell: {
      repositoryId: query.repositoryId,
      evaluationId: query.evaluationId,
      cellId: query.cellId,
      requestId: "request-baseline",
      repositoryEnabled: false,
      controlStatus: "cancelled",
      request: {},
    },
    template: {
      validation: {
        schemaVersion: "ValidationJobContextV2",
        purpose: { kind: "evaluation", evaluationId: query.evaluationId, cellId: query.cellId },
      },
    },
    result: {},
    scopes: [],
  } as unknown as EvaluationResultSelection;
  let current: { identityDigest: string; requestId: string; jobId: string } | null = {
    identityDigest: selection.identityDigest,
    requestId: selection.row.requestId,
    jobId: selection.row.jobId,
  };
  readers.selection.mockImplementation((db, input) => {
    expect(db).toBe(database);
    expect(database.isTransaction).toBe(true);
    expect(input).toEqual(query);
    return selection;
  });
  readers.identity.mockImplementation((db, input) => {
    expect(db).toBe(database);
    expect(database.isTransaction).toBe(true);
    expect(input).toEqual(query);
    return current;
  });
  return {
    database,
    coordinator,
    selection,
    changeIdentity(value: typeof current) {
      current = value;
    },
  };
}

describe("evaluation evidence coordinator boundary", () => {
  it("verifies a cold result without evidence immediately and reuses the final caller transaction", async () => {
    const f = fixture();
    const value = await f.coordinator.prepareEvaluationCellReadEvidence(
      query,
      new AbortController().signal,
    );
    expect(value.profiles).toEqual([
      { requestId: "request-baseline", jobId: "job-baseline", status: "verified" },
    ]);
    expect(f.database.isTransaction).toBe(false);
    f.database.exec("BEGIN");
    try {
      expect(() => f.coordinator.assertPreparedEvidence(value.prepared)).not.toThrow();
      expect(f.database.isTransaction).toBe(true);
    } finally {
      f.database.exec("ROLLBACK");
    }
    expect(readers.selection).toHaveBeenCalledOnce();
    expect(readers.identity).toHaveBeenCalled();
  });

  it("captures all four scope identities before queued asynchronous work", async () => {
    const f = fixture(),
      mutable = { ...query };
    const pending = f.coordinator.prepareEvaluationCellReadEvidence(
      mutable,
      new AbortController().signal,
    );
    mutable.repositoryId = "changed-repository";
    mutable.evaluationId = "changed-evaluation";
    mutable.cellId = "changed-cell";
    mutable.resultId = "changed-result";
    const value = await pending;
    expect(() => f.coordinator.assertPreparedEvidence(value.prepared)).not.toThrow();
    expect(readers.selection.mock.calls[0]?.[1]).toEqual(query);
  });

  it("rolls back its short read transaction when owner selection fails", async () => {
    const f = fixture();
    const failure = new Error("The owner could not read a consistent selection.");
    readers.selection.mockImplementation((db) => {
      expect(db.isTransaction).toBe(true);
      throw failure;
    });
    await expect(
      f.coordinator.prepareEvaluationCellReadEvidence(query, new AbortController().signal),
    ).rejects.toBe(failure);
    expect(f.database.isTransaction).toBe(false);
    expect(readers.identity).not.toHaveBeenCalled();
  });

  it("rejects a selection change between asynchronous preparation and its continuation", async () => {
    const f = fixture();
    const pending = f.coordinator.prepareEvaluationCellReadEvidence(
      query,
      new AbortController().signal,
    );
    queueMicrotask(() =>
      f.changeIdentity({
        identityDigest: "c".repeat(64),
        requestId: "request-baseline",
        jobId: "job-baseline",
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_UNAVAILABLE" });
    expect(f.database.isTransaction).toBe(false);
  });

  it("pins an absent selection and rejects a later selected result", async () => {
    const f = fixture();
    readers.selection.mockImplementation((db) => {
      expect(db.isTransaction).toBe(true);
      return null;
    });
    f.changeIdentity(null);
    const value = await f.coordinator.prepareEvaluationCellReadEvidence(
      query,
      new AbortController().signal,
    );
    expect(value.profiles).toEqual([]);
    expect(() => f.coordinator.assertPreparedEvidence(value.prepared)).not.toThrow();
    f.changeIdentity({
      identityDigest: "a".repeat(64),
      requestId: "request-baseline",
      jobId: "job-baseline",
    });
    expect(() => f.coordinator.assertPreparedEvidence(value.prepared)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_VERIFIER_UNAVAILABLE" }),
    );
  });

  it("rejects forged and expired tokens and exact result identity changes at final consumption", async () => {
    const f = fixture();
    expect(() => f.coordinator.assertPreparedEvidence({ kind: "prepared_evidence" })).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
    const value = await f.coordinator.prepareEvaluationCellReadEvidence(
      query,
      new AbortController().signal,
    );
    f.changeIdentity({
      identityDigest: "a".repeat(64),
      requestId: "request-candidate",
      jobId: "job-baseline",
    });
    expect(() => f.coordinator.assertPreparedEvidence(value.prepared)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_VERIFIER_UNAVAILABLE" }),
    );
    await immediate();
    expect(() => f.coordinator.assertPreparedEvidence(value.prepared)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
  });

  it.each([
    { code: "EVIDENCE_FILE_UNAVAILABLE", status: "unavailable" },
    { code: "EVIDENCE_VERIFIER_BUSY", status: "pending" },
    { code: "EVIDENCE_VERIFIER_TIMEOUT", status: "pending" },
  ] as const)("reports $code without admitting evidence", async ({ code, status }) => {
    const f = fixture();
    readers.selection.mockReturnValue({ ...f.selection, scopes: [evidenceScope] });
    vi.spyOn(evidenceAssets, "finalizedEvidenceReferences").mockImplementation(() => {
      expect(f.database.isTransaction).toBe(false);
      throw new EvidenceVerificationError(code);
    });
    const value = await f.coordinator.prepareEvaluationCellReadEvidence(
      query,
      new AbortController().signal,
    );
    expect(value.profiles).toEqual([
      { requestId: "request-baseline", jobId: "job-baseline", status, code },
    ]);
    expect(() => f.coordinator.assertPreparedEvidence(value.prepared)).not.toThrow();
    expect(f.coordinator.admittedEvidenceReferences(value.prepared, evidenceScope)).toBe(false);
    expect(f.coordinator.admittedScenarioEvidence(value.prepared, evidenceScope)).toBe(false);
  });

  it("does not accept a V1 selection or a foreign cell from the evaluation reader", async () => {
    const f = fixture();
    for (const selection of [
      { ...f.selection, template: { validation: { schemaVersion: "ValidationJobContextV1" } } },
      { ...f.selection, cell: { ...f.selection.cell, cellId: "cell-candidate" } },
      { ...f.selection, row: { ...f.selection.row, id: "old-result" } },
    ]) {
      readers.selection.mockReturnValue(selection);
      await expect(
        f.coordinator.prepareEvaluationCellReadEvidence(query, new AbortController().signal),
      ).rejects.toMatchObject({ code: "EVIDENCE_INVALID_SNAPSHOT" });
    }
  });

  it("does not open a read transaction for a pre-cancelled request", async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    expect(() => f.coordinator.prepareEvaluationCellReadEvidence(query, controller.signal)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_VERIFIER_CANCELLED" }),
    );
    expect(readers.selection).not.toHaveBeenCalled();
    expect(f.database.isTransaction).toBe(false);
  });
});
