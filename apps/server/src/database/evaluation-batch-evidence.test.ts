import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as immediate } from "node:timers/promises";
import * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createEvaluationBatchFixture } from "./evaluation-batches.testing.js";
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
import { handleEvaluationManagementRequest } from "./evaluation-management.js";
import { evaluationAdministrator, evaluationLater } from "./evaluation-management.testing.js";
import {
  closeEvidenceAssetStorage,
  type EvidenceAssetOperation,
  type EvidenceAssetOperationMap,
  type EvidenceAssetRequest,
  type EvidenceStorageOptions,
  finalizedEvidenceReferences,
  handleEvidenceAssetRequest,
} from "./evidence-assets.js";
import { probeEvidenceIdentities, verifyEvidenceAsset } from "./evidence-files.js";
import {
  EvidenceVerificationCoordinator,
  type EvidenceVerificationCoordinatorOptions,
  type EvidenceVerifier,
  type PreparedEvaluationBatchEvidence,
} from "./evidence-verification.js";
import {
  type AssetAttestation,
  type AssetVerificationSnapshot,
  EvidenceVerificationError,
  type EvidenceVerificationFailureCode,
  type EvidenceVerificationRoot,
  type IdentityAttestation,
  type IdentityProbeSnapshot,
  maximumIdentityProbeAssets,
  type ScenarioAttestation,
  type ScenarioVerificationSnapshot,
} from "./evidence-verification-protocol.js";
import {
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

type Cell = EvaluationCompletionFixture["cells"][number];
const uploadedAt = "2026-09-08T04:01:00.000Z";
const resources: { database: DatabaseSync; close(): void }[] = [];
const coordinators: EvidenceVerificationCoordinator[] = [];
const directories: string[] = [];
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close()));
  for (const value of resources.splice(0)) {
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

function gate() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    arrived: arrived.promise,
    release: () => released.resolve(),
    wait: async () => {
      arrived.resolve();
      await released.promise;
    },
  };
}

/** Real file hashes and descriptor identity checks, with controlled asynchronous scheduling. */
class ControlledVerifier implements EvidenceVerifier {
  readonly assets: AssetVerificationSnapshot[] = [];
  readonly probes: IdentityProbeSnapshot[] = [];
  beforeAsset?: (snapshot: AssetVerificationSnapshot) => Promise<void>;
  beforeProbe?: (snapshot: IdentityProbeSnapshot) => Promise<void>;
  transformProbe?: (value: IdentityAttestation) => IdentityAttestation;
  closeCalls = 0;
  constructor(
    readonly root: EvidenceVerificationRoot,
    readonly database: DatabaseSync,
  ) {}
  async verifyAsset(
    snapshot: AssetVerificationSnapshot,
    signal: AbortSignal,
  ): Promise<AssetAttestation> {
    expect(this.database.isTransaction).toBe(false);
    this.assets.push(structuredClone(snapshot));
    await this.beforeAsset?.(snapshot);
    expect(this.database.isTransaction).toBe(false);
    signal.throwIfAborted();
    const value = await verifyEvidenceAsset(this.root, snapshot, signal);
    expect(this.database.isTransaction).toBe(false);
    return value.attestation;
  }
  async probeIdentities(
    snapshot: IdentityProbeSnapshot,
    signal: AbortSignal,
  ): Promise<IdentityAttestation> {
    expect(this.database.isTransaction).toBe(false);
    expect(snapshot.assets.length).toBeLessThanOrEqual(maximumIdentityProbeAssets);
    this.probes.push(structuredClone(snapshot));
    await this.beforeProbe?.(snapshot);
    expect(this.database.isTransaction).toBe(false);
    signal.throwIfAborted();
    const value = await probeEvidenceIdentities(this.root, snapshot, signal);
    expect(this.database.isTransaction).toBe(false);
    return this.transformProbe?.(value) ?? value;
  }
  async verifyScenario(
    _snapshot: ScenarioVerificationSnapshot,
    _signal: AbortSignal,
  ): Promise<ScenarioAttestation> {
    throw new Error("The real profile-only fixture contains no UI scenarios.");
  }
  peekAssetAttestation(): null {
    return null;
  }
  peekScenarioAttestation(): null {
    return null;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function fixture() {
  const value = createEvaluationCompletionFixture();
  resources.push(value);
  const directory = mkdtempSync(join(tmpdir(), "evaluation-batch-evidence-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const storage: EvidenceStorageOptions = {
    evidenceDirectory: directory,
    globalQuotaBytes: 4 * 1024 * 1024,
    globalAssetLimit: 256,
    retentionMs: 86_400_000,
    incompleteUploadTtlMs: 60_000,
  };
  const query = { repositoryId: value.repositoryId, evaluationId: value.batch.id };
  const complete = (arm: "baseline" | "candidate", assetCount = 1) => {
    const cell = selected(value, arm);
    const leaseToken = sha256(`batch-evidence-${arm}`);
    const completion = beginAttempt(value, cell, leaseToken);
    const lease: C.LeaseIdentity = {
      jobId: cell.jobId,
      runAttemptId: completion.runAttemptId,
      workerNodeId: "evaluation-node",
      workerInstanceId: "evaluation-instance",
      leaseGeneration: 1,
      leaseToken,
    };
    const request = <K extends EvidenceAssetOperation>(
      operation: K,
      input: EvidenceAssetOperationMap[K]["input"],
    ) =>
      handleEvidenceAssetRequest(
        value.database,
        { operation, input } as EvidenceAssetRequest,
        uploadedAt,
        storage,
      ) as EvidenceAssetOperationMap[K]["output"];
    const submitted = resultFor(cell);
    const check = submitted.report.checks[0];
    if (!check) throw new Error("The frozen fixture must retain its build check.");
    const assets = Array.from({ length: assetCount }, (_, index) => {
      const bytes = Buffer.from(`The ${arm} compiler failed, log ${index}.\n`);
      const upload = request("beginEvidenceUpload", {
        lease,
        clientAssetId: `compiler-${index}`,
        metadata: {
          kind: "log",
          mediaType: "text/plain",
          checkId: check.id,
          sizeBytes: bytes.length,
          sha256: sha256(bytes.toString("utf8")),
          capturedAt: uploadedAt,
        },
      });
      request("appendEvidenceChunk", {
        lease,
        assetId: upload.assetId,
        offset: 0,
        base64: bytes.toString("base64"),
        chunkSha256: sha256(bytes.toString("utf8")),
      });
      const manifest = request("finalizeEvidenceUpload", { lease, assetId: upload.assetId });
      return { manifest, bytes, path: join(directory, `${manifest.id}.asset`) };
    });
    check.evidenceIds = assets.map(({ manifest }) => manifest.id);
    const validated = validateValidationCompletion(
      value.database,
      completion,
      sha256(canonicalJson(submitted)),
      submitted,
      undefined,
      {
        validateEvidenceReferences: (scope) =>
          finalizedEvidenceReferences(value.database, scope, storage),
      },
    );
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
    return {
      cell,
      assets,
      submitted,
      resultId,
      scope: {
        repositoryId: query.repositoryId,
        runId: cell.run_id,
        requestId: cell.request_id,
        jobId: cell.jobId,
        runAttemptId: completion.runAttemptId,
        profileVersionId: cell.template.validation.profileVersion.id,
        checkId: check.id,
        evidenceIds: [...check.evidenceIds],
      },
    };
  };
  const owner = (options: Partial<EvidenceVerificationCoordinatorOptions> = {}) => {
    let verifier: ControlledVerifier | undefined;
    const coordinator = new EvidenceVerificationCoordinator(value.database, {
      storage,
      now: () => completedAt,
      ...options,
      createVerifier: (root) => {
        verifier = new ControlledVerifier(root, value.database);
        return verifier;
      },
    });
    coordinators.push(coordinator);
    return {
      coordinator,
      verifier: () => {
        if (!verifier) throw new Error("The verifier has not been created.");
        return verifier;
      },
    };
  };
  return { ...value, query, storage, directory, complete, owner };
}
const activeSignal = () => new AbortController().signal;
function cellEvidence(proof: PreparedEvaluationBatchEvidence, cell: Cell) {
  const result = proof.cells.find((entry) => entry.cellId === cell.id);
  if (!result) throw new Error("A selected cell disappeared from the complete batch proof.");
  return result;
}

describe("complete evaluation batch evidence preflight", () => {
  it("retains all 64 sealed cells without inventing jobs or results", async () => {
    const value = createEvaluationBatchFixture("issue", { notApplicableCase: false });
    resources.push(value);
    const scope = {
      repositoryId: value.repositoryId,
      actor: evaluationAdministrator,
      suiteId: value.suite.id,
    };
    const current = handleEvaluationManagementRequest(
      value.database,
      { operation: "getEvaluationSuite", input: scope },
      evaluationLater,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteDetailV1;
    const cases: C.EvaluationSuiteDraftCase[] = Array.from({ length: 32 }, (_, index) => ({
      caseId: `case-${index}`,
      title: `Frozen compiler case ${index}`,
      sourceId: value.source.id,
      applicability: { state: "applicable" },
      criteria: [
        {
          criterionId: "compile",
          description: "The known compiler failure is detected.",
          applicability: { state: "applicable" },
          expectedOutcome: "failed",
        },
      ],
      findings: { annotation: "complete", expected: [] },
    }));
    const saved = handleEvaluationManagementRequest(
      value.database,
      {
        operation: "saveEvaluationSuiteDraft",
        input: {
          ...scope,
          request: {
            changeId: "save-32-cases",
            expectedRevision: current.draftRevision,
            draft: { name: value.suite.name, description: value.suite.description, cases },
          },
        },
      },
      evaluationLater,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteSummaryV1;
    const version = handleEvaluationManagementRequest(
      value.database,
      {
        operation: "publishEvaluationSuite",
        input: {
          ...scope,
          request: { changeId: "publish-32-cases", expectedRevision: saved.draftRevision },
        },
      },
      evaluationLater,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteVersionV1;
    const batch = value.create({
      ...value.input,
      request: {
        ...value.input.request,
        suiteVersionId: version.id,
        mode: "profile_only",
        checkMappings: cases.map((entry) => ({
          caseId: entry.caseId,
          criterionId: "compile",
          baselineCheckId: `${value.baseline.profile.id}:compile`,
          candidateCheckId: `${value.candidate.profile.id}:compile`,
        })),
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "evaluation-64-cells-"));
    directories.push(directory);
    const coordinator = new EvidenceVerificationCoordinator(value.database, {
      storage: {
        evidenceDirectory: directory,
        globalQuotaBytes: 4 * 1024 * 1024,
        globalAssetLimit: 256,
        retentionMs: 86_400_000,
        incompleteUploadTtlMs: 60_000,
      },
      createVerifier: () => {
        throw new Error("A batch without results must not start verification.");
      },
    });
    coordinators.push(coordinator);
    const proof = await coordinator.prepareEvaluationBatchReadEvidence(
      { repositoryId: value.repositoryId, evaluationId: batch.id },
      activeSignal(),
    );
    expect(proof.cells).toHaveLength(64);
    expect(new Set(proof.cells.map((cell) => cell.cellId)).size).toBe(64);
    expect(
      proof.cells.every(
        (cell) => cell.jobId === null && cell.resultId === null && cell.verification === null,
      ),
    ).toBe(true);
    coordinator.assertPreparedEvidence(proof.prepared);
  });

  it("retains queued and running cells alongside an actual failed compiler result", async () => {
    const value = fixture(),
      baseline = value.complete("baseline"),
      candidate = selected(value, "candidate");
    const { coordinator } = value.owner();
    const queued = await coordinator.prepareEvaluationBatchReadEvidence(
      value.query,
      activeSignal(),
    );
    expect(cellEvidence(queued, candidate)).toMatchObject({
      jobId: candidate.jobId,
      resultId: null,
      verification: null,
    });
    expect(cellEvidence(queued, baseline.cell).verification).toEqual({ status: "verified" });
    beginAttempt(value, candidate);
    expect(() => coordinator.assertPreparedEvidence(queued.prepared)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_VERIFIER_UNAVAILABLE" }),
    );
    const running = await coordinator.prepareEvaluationBatchReadEvidence(
      value.query,
      activeSignal(),
    );
    expect(cellEvidence(running, candidate).verification).toBeNull();
    expect(baseline.submitted.report.checks[0]?.outcome).toBe("failed");
    coordinator.assertPreparedEvidence(running.prepared);
  });

  it("uses one proof for both exact evidence scopes and does not mint intermediate cell tokens", async () => {
    const value = fixture(),
      baseline = value.complete("baseline"),
      candidate = value.complete("candidate"),
      owner = value.owner();
    const proof = await owner.coordinator.prepareEvaluationBatchReadEvidence(
      value.query,
      activeSignal(),
    );
    expect(proof.cells.map((cell) => cell.verification)).toEqual([
      { status: "verified" },
      { status: "verified" },
    ]);
    for (const result of [baseline, candidate])
      expect(owner.coordinator.admittedEvidenceReferences(proof.prepared, result.scope)).toBe(true);
    expect(
      owner.coordinator.admittedEvidenceReferences(proof.prepared, {
        ...baseline.scope,
        requestId: candidate.scope.requestId,
      }),
    ).toBe(false);
    expect(owner.verifier().assets).toHaveLength(2);
    expect(owner.verifier().probes.map((probe) => probe.assets.length)).toEqual([1, 1, 2]);
    expect(value.database.isTransaction).toBe(false);
  });

  it.each(["changed", "missing", "retired"] as const)(
    "cannot retain an early cell's proof after its file is %s during later verification",
    async (condition) => {
      const value = fixture(),
        baseline = value.complete("baseline"),
        candidate = value.complete("candidate");
      let altered = false;
      const coordinator = new EvidenceVerificationCoordinator(value.database, {
        storage: value.storage,
        createVerifier: (root) => {
          const verifier = new ControlledVerifier(root, value.database);
          verifier.beforeAsset = async (snapshot) => {
            if (snapshot.asset.scope.jobId !== candidate.cell.jobId || altered) return;
            altered = true;
            const asset = baseline.assets[0];
            if (!asset) throw new Error("The early cell evidence must exist.");
            if (condition === "changed") {
              chmodSync(asset.path, 0o600);
              writeFileSync(asset.path, Buffer.alloc(asset.bytes.length, 120));
            } else if (condition === "missing") unlinkSync(asset.path);
            else
              value.database
                .prepare(
                  "UPDATE evidence_assets SET state = 'retired', retired_at = ?, updated_at = ? WHERE id = ?",
                )
                .run(completedAt, completedAt, asset.manifest.id);
          };
          return verifier;
        },
      });
      coordinators.push(coordinator);
      const proof = await coordinator.prepareEvaluationBatchReadEvidence(
        value.query,
        activeSignal(),
      );
      expect(altered).toBe(true);
      expect(cellEvidence(proof, baseline.cell).verification?.status).toBe("unavailable");
      expect(coordinator.admittedEvidenceReferences(proof.prepared, baseline.scope)).toBe(false);
      if (condition === "changed") {
        expect(cellEvidence(proof, candidate.cell).verification).toEqual({ status: "verified" });
        expect(coordinator.admittedEvidenceReferences(proof.prepared, candidate.scope)).toBe(true);
      }
      coordinator.assertPreparedEvidence(proof.prepared);
      expect(
        value.database
          .prepare("SELECT result_json FROM validation_job_results WHERE id = ?")
          .get(baseline.resultId),
      ).toMatchObject({ result_json: canonicalJson(baseline.submitted) });
    },
  );

  it("performs an additional root-wide probe in bounded groups of 64 assets", async () => {
    const value = fixture(),
      baseline = value.complete("baseline", 33),
      candidate = value.complete("candidate", 32),
      owner = value.owner();
    const proof = await owner.coordinator.prepareEvaluationBatchReadEvidence(
      value.query,
      activeSignal(),
    );
    expect(owner.verifier().probes.map((probe) => probe.assets.length)).toEqual([33, 32, 64, 1]);
    expect(owner.coordinator.admittedEvidenceReferences(proof.prepared, baseline.scope)).toBe(true);
    expect(owner.coordinator.admittedEvidenceReferences(proof.prepared, candidate.scope)).toBe(
      true,
    );
  });

  it.each([
    "EVIDENCE_VERIFIER_BUSY",
    "EVIDENCE_VERIFIER_TIMEOUT",
    "EVIDENCE_VERIFIER_CANCELLED",
    "EVIDENCE_VERIFIER_SHUTDOWN",
    "EVIDENCE_INVALID_SNAPSHOT",
    "EVIDENCE_VERIFIER_PROTOCOL",
  ] as const)(
    "propagates %s from a later cell without returning an earlier verified token",
    async (code) => {
      const value = fixture();
      value.complete("baseline");
      const candidate = value.complete("candidate");
      const coordinator = new EvidenceVerificationCoordinator(value.database, {
        storage: value.storage,
        createVerifier: (root) => {
          const verifier = new ControlledVerifier(root, value.database);
          verifier.beforeAsset = async (snapshot) => {
            if (snapshot.asset.scope.jobId === candidate.cell.jobId)
              throw new EvidenceVerificationError(code);
          };
          return verifier;
        },
      });
      coordinators.push(coordinator);
      await expect(
        coordinator.prepareEvaluationBatchReadEvidence(value.query, activeSignal()),
      ).rejects.toMatchObject({ code });
      expect(value.database.isTransaction).toBe(false);
    },
  );

  it("rejects an aggregate probe whose identity binding differs from the requested snapshot", async () => {
    const value = fixture();
    value.complete("baseline");
    value.complete("candidate");
    const coordinator = new EvidenceVerificationCoordinator(value.database, {
      storage: value.storage,
      createVerifier: (root) => {
        const verifier = new ControlledVerifier(root, value.database);
        verifier.transformProbe = (result) =>
          result.assets.length === 2 ? { ...result, snapshotDigest: "f".repeat(64) } : result;
        return verifier;
      },
    });
    coordinators.push(coordinator);
    await expect(
      coordinator.prepareEvaluationBatchReadEvidence(value.query, activeSignal()),
    ).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_PROTOCOL" });
  });

  it.each(["late_result", "running", "cancelled"] as const)(
    "rejects a complete selection changed by %s during asynchronous verification",
    async (change) => {
      const value = fixture();
      value.complete("baseline");
      const pause = gate();
      const coordinator = new EvidenceVerificationCoordinator(value.database, {
        storage: value.storage,
        createVerifier: (root) => {
          const verifier = new ControlledVerifier(root, value.database);
          verifier.beforeAsset = () => pause.wait();
          return verifier;
        },
      });
      coordinators.push(coordinator);
      const pending = coordinator.prepareEvaluationBatchReadEvidence(value.query, activeSignal());
      const rejected = expect(pending).rejects.toMatchObject({
        code: "EVIDENCE_VERIFIER_UNAVAILABLE",
      });
      try {
        await pause.arrived;
        expect(value.database.isTransaction).toBe(false);
        if (change === "late_result") value.complete("candidate");
        else if (change === "running") beginAttempt(value, selected(value, "candidate"));
        else
          transaction(value.database, () =>
            cancelEvaluationBatchInTransaction(
              value.database,
              {
                ...value.query,
                actor: evaluationAdministrator,
                request: {
                  changeId: "cancel-during-batch-read",
                  expectedVersion: 1,
                  reason: "Stop queued evaluation work while evidence is being inspected.",
                },
              },
              completedAt,
              [evaluationAdministrator],
            ),
          );
      } finally {
        pause.release();
      }
      await rejected;
      expect(value.database.isTransaction).toBe(false);
    },
  );

  it.each(["cancelled", "timeout", "shutdown"] as const)(
    "settles a paused whole-batch %s without holding a SQLite transaction",
    async (condition) => {
      const value = fixture();
      value.complete("baseline");
      const pause = gate();
      const coordinator = new EvidenceVerificationCoordinator(value.database, {
        storage: value.storage,
        ...(condition === "timeout" ? { foregroundTimeoutMs: 1_000 } : {}),
        createVerifier: (root) => {
          const verifier = new ControlledVerifier(root, value.database);
          verifier.beforeAsset = () => pause.wait();
          return verifier;
        },
      });
      coordinators.push(coordinator);
      const abort = new AbortController();
      const code: EvidenceVerificationFailureCode =
        condition === "cancelled"
          ? "EVIDENCE_VERIFIER_CANCELLED"
          : condition === "timeout"
            ? "EVIDENCE_VERIFIER_TIMEOUT"
            : "EVIDENCE_VERIFIER_SHUTDOWN";
      const pending = coordinator.prepareEvaluationBatchReadEvidence(value.query, abort.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code });
      try {
        await pause.arrived;
        expect(value.database.isTransaction).toBe(false);
        if (condition === "cancelled") abort.abort();
        if (condition === "shutdown") await coordinator.close();
        await rejected;
        expect(value.database.isTransaction).toBe(false);
      } finally {
        pause.release();
      }
      await immediate();
    },
  );

  it("uses one foreground slot for the batch and releases it after completion", async () => {
    const value = fixture();
    value.complete("baseline");
    value.complete("candidate");
    const pause = gate();
    let first = true;
    const coordinator = new EvidenceVerificationCoordinator(value.database, {
      storage: value.storage,
      maximumForeground: 1,
      createVerifier: (root) => {
        const verifier = new ControlledVerifier(root, value.database);
        verifier.beforeAsset = async () => {
          if (first) {
            first = false;
            await pause.wait();
          }
        };
        return verifier;
      },
    });
    coordinators.push(coordinator);
    const pending = coordinator.prepareEvaluationBatchReadEvidence(value.query, activeSignal());
    try {
      await pause.arrived;
      await expect(
        coordinator.prepareEvaluationBatchReadEvidence(value.query, activeSignal()),
      ).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_BUSY" });
    } finally {
      pause.release();
    }
    const proof = await pending;
    coordinator.assertPreparedEvidence(proof.prepared);
    const next = await coordinator.prepareEvaluationBatchReadEvidence(value.query, activeSignal());
    coordinator.assertPreparedEvidence(next.prepared);
  });

  it.each(["forged", "expired"] as const)("rejects a %s aggregate proof", async (kind) => {
    const value = fixture(),
      result = value.complete("baseline"),
      { coordinator } = value.owner();
    const proof = await coordinator.prepareEvaluationBatchReadEvidence(value.query, activeSignal());
    const prepared = kind === "forged" ? { kind: "prepared_evidence" as const } : proof.prepared;
    if (kind === "expired") await immediate();
    expect(() => coordinator.assertPreparedEvidence(prepared)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
    expect(coordinator.admittedEvidenceReferences(prepared, result.scope)).toBe(false);
  });

  it("rejects unknown batches and refuses to begin preflight inside a transaction", async () => {
    const value = fixture(),
      { coordinator } = value.owner();
    await expect(
      coordinator.prepareEvaluationBatchReadEvidence(
        { ...value.query, evaluationId: "missing-batch" },
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
    transaction(value.database, () =>
      expect(() =>
        coordinator.prepareEvaluationBatchReadEvidence(value.query, activeSignal()),
      ).toThrow(expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" })),
    );
  });
});
