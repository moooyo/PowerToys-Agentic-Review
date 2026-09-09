import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceAssetMetadata, LeaseIdentity } from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EvidenceVerificationClient } from "../../dist/database/evidence-verification-client.js";
import { sha256 } from "../scheduling/canonical-json.js";
import {
  beginAttempt,
  createEvaluationCompletionFixture,
  type EvaluationCompletionFixture,
  selected,
  transaction,
} from "./evaluation-completion.testing.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import { evaluationActor, evaluationAdministrator } from "./evaluation-management.testing.js";
import {
  closeEvidenceAssetStorage,
  type EvidenceAssetOperation,
  type EvidenceAssetOperationMap,
  type EvidenceAssetRequest,
  type EvidenceStorageOptions,
  handleEvidenceAssetRequest,
  prepareEvidenceFinalizationCandidate,
} from "./evidence-assets.js";
import { EvidenceVerificationCoordinator } from "./evidence-verification.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";

const uploadedAt = "2026-09-08T04:01:00.000Z";
const changedAt = "2026-09-08T04:01:01.000Z";
const attemptedAt = "2026-09-08T04:01:02.000Z";
const fixtures: EvaluationCompletionFixture[] = [];
const directories: string[] = [];
const coordinators: EvidenceVerificationCoordinator[] = [];
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((value) => value.close()));
  for (const value of fixtures.splice(0)) {
    closeEvidenceAssetStorage(value.database);
    value.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
afterAll(() => {
  for (const [name, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, previous);
  }
});

function fixture() {
  const value = createEvaluationCompletionFixture();
  fixtures.push(value);
  const cell = selected(value);
  const leaseToken = sha256("evaluation-evidence-upload-lease");
  const completion = beginAttempt(value, cell, leaseToken);
  const lease: LeaseIdentity = {
    jobId: cell.jobId,
    runAttemptId: completion.runAttemptId,
    workerNodeId: "evaluation-node",
    workerInstanceId: "evaluation-instance",
    leaseGeneration: 1,
    leaseToken,
  };
  const directory = mkdtempSync(join(tmpdir(), "evaluation-upload-boundary-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const storage: EvidenceStorageOptions = {
    evidenceDirectory: directory,
    globalQuotaBytes: 1024 * 1024,
    globalAssetLimit: 16,
    retentionMs: 86_400_000,
    incompleteUploadTtlMs: 60_000,
  };
  const bytes = Buffer.from("The frozen synthetic compiler check failed.\n", "utf8");
  const metadata: EvidenceAssetMetadata = {
    kind: "log" as const,
    mediaType: "text/plain",
    sizeBytes: bytes.length,
    sha256: sha256(bytes.toString("utf8")),
    capturedAt: uploadedAt,
    checkId: `${cell.template.validation.profileVersion.id}:compile`,
  };
  function request<K extends EvidenceAssetOperation>(
    operation: K,
    input: EvidenceAssetOperationMap[K]["input"],
    at = uploadedAt,
  ): EvidenceAssetOperationMap[K]["output"] {
    return handleEvidenceAssetRequest(
      value.database,
      { operation, input } as EvidenceAssetRequest,
      at,
      storage,
    ) as EvidenceAssetOperationMap[K]["output"];
  }
  const begin = (at = uploadedAt) =>
    request(
      "beginEvidenceUpload",
      { lease, clientAssetId: "evaluation-compiler-log", metadata },
      at,
    );
  const append = (assetId: string, at = uploadedAt) =>
    request(
      "appendEvidenceChunk",
      {
        lease,
        assetId,
        offset: 0,
        base64: bytes.toString("base64"),
        chunkSha256: metadata.sha256,
      },
      at,
    );
  const rows = () =>
    value.database
      .prepare("SELECT id, state, committed_bytes FROM evidence_assets ORDER BY id")
      .all();
  return { value, cell, lease, directory, storage, bytes, metadata, request, begin, append, rows };
}

type Fixture = ReturnType<typeof fixture>;
function stopUploads(fixture: Fixture, change: "cancelled" | "disabled") {
  const { value } = fixture;
  if (change === "cancelled") {
    transaction(value.database, () =>
      cancelEvaluationBatchInTransaction(
        value.database,
        {
          repositoryId: value.repositoryId,
          evaluationId: value.batch.id,
          actor: evaluationActor,
          request: {
            changeId: "cancel-evaluation-upload",
            expectedVersion: 1,
            reason: "Stop this synthetic evaluation.",
          },
        },
        changedAt,
        [evaluationAdministrator],
      ),
    );
  } else {
    const current = value.database
      .prepare("SELECT version FROM managed_repositories WHERE id = ?")
      .get(value.repositoryId) as { version: number };
    handleRepositoryConfigurationRequest(
      value.database,
      {
        operation: "updateManagedRepository",
        input: {
          repositoryId: value.repositoryId,
          actor: evaluationAdministrator,
          request: { expectedVersion: current.version, enabled: false },
        },
      },
      changedAt,
    );
  }
}

function rejected(action: () => unknown) {
  expect(action).toThrow(expect.objectContaining({ code: "EVIDENCE_LEASE_REJECTED" }));
}

describe("evidence uploads from real V2 evaluation leases", () => {
  it.each([
    { change: "cancelled", stage: "begin" },
    { change: "cancelled", stage: "append" },
    { change: "cancelled", stage: "finalize" },
    { change: "disabled", stage: "begin" },
    { change: "disabled", stage: "append" },
    { change: "disabled", stage: "finalize" },
  ] as const)(
    "rejects $stage after the evaluation becomes $change without changing asset state",
    ({ change, stage }) => {
      const f = fixture();
      const upload = stage === "begin" ? undefined : f.begin();
      if (stage === "finalize" && upload !== undefined) f.append(upload.assetId);
      stopUploads(f, change);
      const before = f.rows();
      if (stage === "begin") rejected(() => f.begin(attemptedAt));
      else {
        if (upload === undefined) throw new Error("The upload fixture is missing its asset.");
        if (stage === "append") rejected(() => f.append(upload.assetId, attemptedAt));
        else {
          rejected(() =>
            f.request(
              "finalizeEvidenceUpload",
              { lease: f.lease, assetId: upload.assetId },
              attemptedAt,
            ),
          );
          rejected(() =>
            prepareEvidenceFinalizationCandidate(
              f.value.database,
              { lease: f.lease, assetId: upload.assetId },
              attemptedAt,
            ),
          );
          expect(readFileSync(join(f.directory, `${upload.assetId}.upload`))).toEqual(f.bytes);
          expect(readdirSync(f.directory)).not.toContain(`${upload.assetId}.asset`);
        }
      }
      expect(f.rows()).toEqual(before);
      expect(f.value.database.isTransaction).toBe(false);
    },
  );

  it.each(["cancelled", "disabled"] as const)(
    "rejects finalized upload retries after %s while keeping historical bytes readable",
    (change) => {
      const f = fixture();
      const upload = f.begin();
      f.append(upload.assetId);
      const manifest = f.request("finalizeEvidenceUpload", {
        lease: f.lease,
        assetId: upload.assetId,
      });
      expect(manifest).toMatchObject({
        repositoryId: f.value.repositoryId,
        runId: f.cell.run_id,
        requestId: f.cell.request_id,
        jobId: f.cell.jobId,
        runAttemptId: f.lease.runAttemptId,
        profileVersionId: f.cell.template.validation.profileVersion.id,
        state: "finalized",
      });
      expect(readFileSync(join(f.directory, `${manifest.id}.asset`))).toEqual(f.bytes);
      stopUploads(f, change);
      const before = f.rows();
      rejected(() => f.begin(attemptedAt));
      rejected(() => f.append(upload.assetId, attemptedAt));
      rejected(() =>
        f.request(
          "finalizeEvidenceUpload",
          { lease: f.lease, assetId: upload.assetId },
          attemptedAt,
        ),
      );
      const scope = {
        repositoryId: f.value.repositoryId,
        runId: f.cell.run_id,
        jobId: f.cell.jobId,
        runAttemptId: f.lease.runAttemptId,
        assetId: manifest.id,
      };
      expect(f.request("getEvidenceAsset", scope, attemptedAt)).toEqual(manifest);
      expect(
        f.request("readEvidenceAssetChunk", { ...scope, offset: 0 }, attemptedAt),
      ).toMatchObject({
        manifest,
        base64: f.bytes.toString("base64"),
        eof: true,
      });
      expect(f.rows()).toEqual(before);
    },
  );

  it.each(["cancelled", "disabled"] as const)(
    "rechecks %s between real finalization preflight and synchronous commit",
    async (change) => {
      const f = fixture(),
        upload = f.begin();
      f.append(upload.assetId);
      let now = uploadedAt;
      const coordinator = new EvidenceVerificationCoordinator(f.value.database, {
        storage: f.storage,
        now: () => now,
        // The compiled client resolves its fixed Worker URL beside the real emitted verifier.
        // Keep the coordinator and asset owner in source so their private tokens share a module.
        createVerifier: (storageRoot) => new EvidenceVerificationClient({ storageRoot }),
      });
      coordinators.push(coordinator);
      const proof = await coordinator.prepareFinalizeEvidence(
        { lease: f.lease, assetId: upload.assetId },
        new AbortController().signal,
      );
      stopUploads(f, change);
      now = attemptedAt;
      rejected(() => coordinator.commitPreparedFinalization(proof));
      expect(f.rows()).toEqual([
        { id: upload.assetId, state: "uploading", committed_bytes: f.bytes.length },
      ]);
      expect(readdirSync(f.directory)).not.toContain(`${upload.assetId}.asset`);
      expect(f.value.database.isTransaction).toBe(false);
    },
  );

  it("retains exact Job, attempt, Worker and token fences for V2 uploads", () => {
    const f = fixture();
    for (const lease of [
      { ...f.lease, jobId: "completion-candidate" },
      { ...f.lease, runAttemptId: "attempt-other" },
      { ...f.lease, workerNodeId: "other-node" },
      { ...f.lease, workerInstanceId: "other-instance" },
      { ...f.lease, leaseGeneration: 2 },
      { ...f.lease, leaseToken: sha256("wrong-lease-token") },
    ])
      rejected(() =>
        f.request("beginEvidenceUpload", {
          lease,
          clientAssetId: "wrong-lease",
          metadata: f.metadata,
        }),
      );
    rejected(() =>
      f.request(
        "beginEvidenceUpload",
        { lease: f.lease, clientAssetId: "expired-lease", metadata: f.metadata },
        "2026-09-08T04:10:00.000Z",
      ),
    );
    expect(f.rows()).toEqual([]);
  });
});
