import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  beginAttempt,
  completedAt,
  createEvaluationCompletionFixture,
  type EvaluationCompletionFixture,
  resultFor,
  selected,
  settle,
  transaction,
} from "./evaluation-completion.testing.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import {
  type EvaluationEvidenceOperation,
  type EvaluationEvidenceOperationMap,
  type EvaluationEvidenceRequest,
  handleEvaluationEvidenceRequest,
} from "./evaluation-evidence.js";
import {
  evaluationActor,
  evaluationAdministrator,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import type {
  EvidenceAssetOperation,
  EvidenceAssetOperationMap,
  EvidenceAssetRequest,
  EvidenceStorageOptions,
} from "./evidence-assets.js";
import * as assetStore from "./evidence-assets.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { authorizeOperatorRequest } from "./operator-request.js";
import {
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

const uploadedAt = "2026-09-08T04:01:00.000Z";
const readAt = "2026-09-08T04:03:00.000Z";
const retiredAt = "2026-09-08T04:05:00.000Z";
const administrators = [evaluationAdministrator];
const fixtures: EvaluationCompletionFixture[] = [];
const directories: string[] = [];
const formats = new Map(["date-time", "uri"].map((key) => [key, FormatRegistry.Get(key)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) {
    assetStore.closeEvidenceAssetStorage(value.database);
    value.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
afterAll(() => {
  for (const [key, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(key);
    else FormatRegistry.Set(key, previous);
  }
});

function fixture() {
  const value = createEvaluationCompletionFixture();
  fixtures.push(value);
  const directory = mkdtempSync(join(tmpdir(), "evaluation-evidence-owner-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const storage: EvidenceStorageOptions = {
    evidenceDirectory: directory,
    globalQuotaBytes: 1024 * 1024,
    globalAssetLimit: 16,
    retentionMs: 1000,
    incompleteUploadTtlMs: 60_000,
  };
  function assets<K extends EvidenceAssetOperation>(
    operation: K,
    input: EvidenceAssetOperationMap[K]["input"],
    now = uploadedAt,
  ): EvidenceAssetOperationMap[K]["output"] {
    return assetStore.handleEvidenceAssetRequest(
      value.database,
      { operation, input } as EvidenceAssetRequest,
      now,
      storage,
    ) as EvidenceAssetOperationMap[K]["output"];
  }
  function request<K extends EvaluationEvidenceOperation>(
    operation: K,
    input: EvaluationEvidenceOperationMap[K]["input"],
    options: EvidenceStorageOptions | undefined = storage,
  ): EvaluationEvidenceOperationMap[K]["output"] {
    return handleEvaluationEvidenceRequest(
      value.database,
      { operation, input } as EvaluationEvidenceRequest,
      readAt,
      administrators,
      options,
    ) as EvaluationEvidenceOperationMap[K]["output"];
  }
  function complete(arm: "baseline" | "candidate" = "baseline", withEvidence = true) {
    const cell = selected(value, arm);
    const leaseToken = sha256(`evaluation-evidence-owner-${arm}`);
    const completion = beginAttempt(value, cell, leaseToken);
    const lease: C.LeaseIdentity = {
      jobId: cell.jobId,
      runAttemptId: completion.runAttemptId,
      workerNodeId: "evaluation-node",
      workerInstanceId: "evaluation-instance",
      leaseGeneration: 1,
      leaseToken,
    };
    const body = resultFor(cell);
    const check = body.report.checks[0];
    if (check === undefined) throw new Error("The fixture requires its frozen compiler check.");
    const bytes = Buffer.from(`The ${arm} compiler recorded its own failure.\n`, "utf8");
    const upload = (clientAssetId: string) => {
      const begun = assets("beginEvidenceUpload", {
        lease,
        clientAssetId,
        metadata: {
          kind: "log",
          mediaType: "text/plain",
          sizeBytes: bytes.length,
          sha256: sha256(bytes.toString("utf8")),
          capturedAt: uploadedAt,
          checkId: check.id,
        },
      });
      assets("appendEvidenceChunk", {
        lease,
        assetId: begun.assetId,
        offset: 0,
        base64: bytes.toString("base64"),
        chunkSha256: sha256(bytes.toString("utf8")),
      });
      return assets("finalizeEvidenceUpload", { lease, assetId: begun.assetId });
    };
    const manifest = withEvidence ? upload(`referenced-${arm}`) : undefined;
    const unreferenced = withEvidence ? upload(`unreferenced-${arm}`) : undefined;
    if (manifest !== undefined) check.evidenceIds = [manifest.id];
    const validated = validateValidationCompletion(
      value.database,
      completion,
      sha256(canonicalJson(body)),
      body,
      undefined,
      {
        validateEvidenceReferences: (scope) =>
          assetStore.finalizedEvidenceReferences(value.database, scope, storage),
      },
    );
    expect(validated.evidenceComplete).toBe(true);
    const resultId = transaction(value.database, () => {
      settle(value.database, completion, validated);
      const id = persistValidatedValidationResult(
        value.database,
        completion,
        validated,
        completedAt,
      );
      value.database
        .prepare(
          "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
        )
        .run(completedAt, cell.jobId);
      return id;
    });
    const input = {
      repositoryId: value.repositoryId,
      evaluationId: value.batch.id,
      cellId: cell.id,
      resultId,
      actor: evaluationActor,
    };
    const binding: C.EvaluationEvidenceBinding = {
      repositoryId: value.repositoryId,
      evaluationId: value.batch.id,
      cellId: cell.id,
      resultId,
      resultDigest: validated.resultDigest,
      runId: cell.run_id,
      requestId: cell.request_id,
      jobId: cell.jobId,
      runAttemptId: completion.runAttemptId,
      profileVersionId: cell.template.validation.profileVersion.id,
      revisionKey: cell.template.validation.revisionKey,
      planDigest: cell.plan_digest,
    };
    return { input, binding, manifest, unreferenced, checkId: check.id, bytes, cell };
  }
  return { value, directory, storage, assets, request, complete };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The evidence fixture requires a finalized asset.");
  return value;
}
function missing(action: () => unknown) {
  expect(action).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
}

describe("evaluation result evidence owner", () => {
  it("lists only the exact result's referenced assets and binds every downloaded chunk", () => {
    const f = fixture(),
      result = f.complete();
    const manifest = required(result.manifest),
      unreferenced = required(result.unreferenced);
    expect(
      f.assets("listEvidenceAssets", {
        repositoryId: result.binding.repositoryId,
        runId: result.binding.runId,
        jobId: result.binding.jobId,
        runAttemptId: result.binding.runAttemptId,
      }).items,
    ).toHaveLength(2);
    const list = f.request("listEvaluationResultEvidence", result.input);
    expect(list).toEqual({
      schemaVersion: "EvaluationResultEvidenceListV1",
      binding: result.binding,
      items: [{ assetId: manifest.id, checkIds: [result.checkId], manifest }],
    });
    expect(C.getEvaluationResultEvidenceListIssues(list)).toEqual([]);
    const detail = f.request("getEvaluationResultEvidenceAsset", {
      ...result.input,
      assetId: manifest.id,
    });
    expect(detail).toEqual({
      schemaVersion: "EvaluationResultEvidenceAssetV1",
      binding: result.binding,
      assetId: manifest.id,
      checkIds: [result.checkId],
      manifest,
    });
    expect(C.getEvaluationResultEvidenceAssetIssues(detail)).toEqual([]);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < result.bytes.length; offset += 8) {
      const chunk = f.request("readEvaluationResultEvidenceChunk", {
        ...result.input,
        assetId: manifest.id,
        offset,
        maximumBytes: 8,
      });
      expect(chunk.binding).toEqual(result.binding);
      expect(chunk.manifest).toEqual(manifest);
      expect(chunk.offset).toBe(offset);
      expect(chunk.eof).toBe(offset + 8 >= result.bytes.length);
      chunks.push(Buffer.from(chunk.base64, "base64"));
    }
    expect(Buffer.concat(chunks)).toEqual(result.bytes);
    missing(() =>
      f.request("getEvaluationResultEvidenceAsset", { ...result.input, assetId: unreferenced.id }),
    );
    missing(() =>
      f.request("readEvaluationResultEvidenceChunk", {
        ...result.input,
        assetId: unreferenced.id,
        offset: 0,
      }),
    );
    expect(f.value.database.isTransaction).toBe(false);
  });

  it("rejects foreign cells, results, assets and repository identities", () => {
    const f = fixture(),
      baseline = f.complete(),
      candidate = f.complete("candidate");
    const assetId = required(baseline.manifest).id;
    for (const input of [
      {
        ...baseline.input,
        actor: evaluationAdministrator,
        repositoryId: f.value.secondRepositoryId,
      },
      { ...baseline.input, evaluationId: "another-evaluation" },
      { ...baseline.input, cellId: candidate.input.cellId },
      { ...baseline.input, resultId: candidate.input.resultId },
    ]) {
      missing(() => f.request("listEvaluationResultEvidence", input));
      missing(() => f.request("getEvaluationResultEvidenceAsset", { ...input, assetId }));
      missing(() =>
        f.request("readEvaluationResultEvidenceChunk", { ...input, assetId, offset: 0 }),
      );
    }
    missing(() =>
      f.request("getEvaluationResultEvidenceAsset", {
        ...baseline.input,
        assetId: required(candidate.manifest).id,
      }),
    );
    missing(() =>
      f.request("readEvaluationResultEvidenceChunk", {
        ...baseline.input,
        assetId: required(candidate.manifest).id,
        offset: 0,
      }),
    );
  });

  it("retains missing reference metadata as null and refuses manifest or content substitution", () => {
    const f = fixture(),
      result = f.complete(),
      assetId = required(result.manifest).id;
    const original = assetStore.handleEvidenceAssetRequest;
    // Simulate unavailable metadata at the existing storage-reader seam without weakening SQL guards.
    vi.spyOn(assetStore, "handleEvidenceAssetRequest").mockImplementation(
      (db, request, now, options) =>
        request.operation === "getEvidenceAsset" && request.input.assetId === assetId
          ? null
          : original(db, request, now, options),
    );
    expect(f.request("listEvaluationResultEvidence", result.input).items).toEqual([
      { assetId, checkIds: [result.checkId], manifest: null },
    ]);
    missing(() => f.request("getEvaluationResultEvidenceAsset", { ...result.input, assetId }));
    missing(() =>
      f.request("readEvaluationResultEvidenceChunk", { ...result.input, assetId, offset: 0 }),
    );
  });

  it("rejects a storage manifest that differs from the immutable result binding", () => {
    const f = fixture(),
      baseline = f.complete(),
      candidate = f.complete("candidate");
    const assetId = required(baseline.manifest).id,
      foreign = required(candidate.manifest);
    const original = assetStore.handleEvidenceAssetRequest;
    const storage = vi
      .spyOn(assetStore, "handleEvidenceAssetRequest")
      .mockImplementation((db, request, now, options) =>
        request.operation === "getEvidenceAsset" && request.input.assetId === assetId
          ? foreign
          : original(db, request, now, options),
      );
    expect(() => f.request("listEvaluationResultEvidence", baseline.input)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
    expect(() =>
      f.request("getEvaluationResultEvidenceAsset", { ...baseline.input, assetId }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    expect(() =>
      f.request("readEvaluationResultEvidenceChunk", { ...baseline.input, assetId, offset: 0 }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    expect(
      storage.mock.calls.some(([, request]) => request.operation === "readEvidenceAssetChunk"),
    ).toBe(false);
  });

  it("requires current read access on each chunk and stamps only the operator's trusted identity", () => {
    const f = fixture(),
      result = f.complete(),
      assetId = required(result.manifest).id;
    setEvaluationManagementRole(f.value.database, f.value.repositoryId, "viewer", 1);
    for (const operation of [
      "listEvaluationResultEvidence",
      "getEvaluationResultEvidenceAsset",
      "readEvaluationResultEvidenceChunk",
    ] as const) {
      const input = {
        ...result.input,
        ...(operation === "listEvaluationResultEvidence" ? {} : { assetId }),
        ...(operation === "readEvaluationResultEvidenceChunk" ? { offset: 0 } : {}),
      };
      const authorized = authorizeOperatorRequest(
        f.value.database,
        { context: { kind: "operator", actor: evaluationActor }, operation, input },
        administrators,
      );
      expect(authorized.request.input.actor).toEqual(evaluationActor);
      expect(Object.isFrozen(authorized.request.input.actor)).toBe(true);
      expect(() =>
        authorizeOperatorRequest(
          f.value.database,
          {
            context: { kind: "operator", actor: evaluationActor },
            operation,
            input: { ...input, actor: evaluationAdministrator },
          },
          administrators,
        ),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
    }
    expect(
      f.request("readEvaluationResultEvidenceChunk", {
        ...result.input,
        assetId,
        offset: 0,
        maximumBytes: 8,
      }).eof,
    ).toBe(false);
    setEvaluationManagementRole(f.value.database, f.value.repositoryId, null, 2);
    missing(() => f.request("listEvaluationResultEvidence", result.input));
    missing(() => f.request("getEvaluationResultEvidenceAsset", { ...result.input, assetId }));
    missing(() =>
      f.request("readEvaluationResultEvidenceChunk", {
        ...result.input,
        assetId,
        offset: 8,
        maximumBytes: 8,
      }),
    );
  });

  it.each(["cancelled", "disabled"] as const)(
    "keeps historical metadata and bytes readable after %s",
    (state) => {
      const f = fixture(),
        result = f.complete(),
        assetId = required(result.manifest).id;
      if (state === "cancelled")
        transaction(f.value.database, () =>
          cancelEvaluationBatchInTransaction(
            f.value.database,
            {
              repositoryId: f.value.repositoryId,
              evaluationId: f.value.batch.id,
              actor: evaluationActor,
              request: {
                changeId: "cancel-evidence-history",
                expectedVersion: 1,
                reason: "Stop further evaluation execution.",
              },
            },
            readAt,
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
          readAt,
        );
      }
      expect(
        f.request("getEvaluationResultEvidenceAsset", { ...result.input, assetId }).manifest,
      ).toEqual(result.manifest);
      expect(
        f.request("readEvaluationResultEvidenceChunk", { ...result.input, assetId, offset: 0 })
          .base64,
      ).toBe(result.bytes.toString("base64"));
    },
  );

  it("returns retired metadata while the existing storage boundary refuses its content", () => {
    const f = fixture(),
      result = f.complete(),
      assetId = required(result.manifest).id;
    expect(f.assets("cleanupEvidenceAssets", { limit: 16 }, retiredAt).retired).toBe(2);
    const detail = f.request("getEvaluationResultEvidenceAsset", { ...result.input, assetId });
    expect(detail.manifest).toMatchObject({ state: "retired", retiredAt });
    expect(f.request("listEvaluationResultEvidence", result.input).items[0]?.manifest).toEqual(
      detail.manifest,
    );
    expect(() =>
      f.request("readEvaluationResultEvidenceChunk", { ...result.input, assetId, offset: 0 }),
    ).toThrow(expect.objectContaining({ code: "EVIDENCE_UNAVAILABLE" }));
  });

  it("rehashes touched committed chunks while metadata remains only a recorded manifest", () => {
    const f = fixture(),
      result = f.complete(),
      manifest = required(result.manifest);
    const path = join(f.directory, `${manifest.id}.asset`);
    chmodSync(path, 0o600);
    writeFileSync(path, Buffer.alloc(result.bytes.length, 0x78));
    expect(
      f.request("getEvaluationResultEvidenceAsset", { ...result.input, assetId: manifest.id })
        .manifest,
    ).toEqual(manifest);
    expect(() =>
      f.request("readEvaluationResultEvidenceChunk", {
        ...result.input,
        assetId: manifest.id,
        offset: 0,
        maximumBytes: 8,
      }),
    ).toThrow(expect.objectContaining({ code: "EVIDENCE_UNAVAILABLE" }));
  });

  it("validates exact selectors, authority-free inputs and bounded offsets without leaving a transaction", () => {
    const f = fixture(),
      result = f.complete(),
      assetId = required(result.manifest).id;
    for (const input of [
      { ...result.input, assetId: `${assetId}\n`, offset: 0 },
      { ...result.input, assetId, offset: -1 },
      { ...result.input, assetId, offset: 0.5 },
      { ...result.input, assetId, offset: 0, maximumBytes: 0 },
      { ...result.input, assetId, offset: 0, maximumBytes: C.maximumEvidenceChunkBytes + 1 },
      { ...result.input, assetId, offset: 0, replayOnly: true },
      { ...result.input, assetId, offset: 0, requestEpochId: "ordinary-epoch" },
    ])
      expect(() => f.request("readEvaluationResultEvidenceChunk", input)).toThrow(
        expect.objectContaining({ code: "PLATFORM_INVALID" }),
      );
    expect(f.value.database.isTransaction).toBe(false);
  });

  it("returns an empty reference list without requiring configured evidence storage", () => {
    const f = fixture(),
      result = f.complete("baseline", false);
    expect(
      handleEvaluationEvidenceRequest(
        f.value.database,
        { operation: "listEvaluationResultEvidence", input: result.input },
        readAt,
        administrators,
      ),
    ).toEqual({
      schemaVersion: "EvaluationResultEvidenceListV1",
      binding: result.binding,
      items: [],
    });
    missing(() =>
      f.request("getEvaluationResultEvidenceAsset", { ...result.input, assetId: "unreferenced" }),
    );
  });
});
