import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { composeSummaryPrompt } from "@agentic-review/codex";
import type * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EvidenceVerificationClient } from "../../dist/database/evidence-verification-client.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  closeEvidenceAssetStorage,
  type EvidenceStorageOptions,
  handleEvidenceAssetRequest,
  readEvidenceVerificationCandidate,
} from "./evidence-assets.js";
import { inspectEvidenceFile, inspectEvidenceRoot } from "./evidence-files.js";
import { EvidenceVerificationCoordinator } from "./evidence-verification.js";
import type { AssetVerificationSnapshot } from "./evidence-verification-protocol.js";
import {
  createModelCliFixture,
  type ModelCliFixture,
  modelCliFixtureTime as time,
} from "./model-cli.testing.js";
import {
  freezeValidationSummaryInput,
  prepareValidationSummaryInput,
  readFrozenValidationSummaryInputInTransaction,
  type ValidationSummaryInputEvidenceFacts,
} from "./validation-summary-inputs.js";
import { validationSummaryInputRequest } from "./validation-summary-inputs.testing.js";

const fixtures: ModelCliFixture[] = [],
  directories: string[] = [],
  coordinators: EvidenceVerificationCoordinator[] = [];
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close()));
  for (const fixture of fixtures.splice(0)) {
    closeEvidenceAssetStorage(fixture.database);
    fixture.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
afterAll(() => {
  for (const [name, previous] of formats) {
    if (previous) FormatRegistry.Set(name, previous);
    else FormatRegistry.Delete(name);
  }
});
function fixture(options: Parameters<typeof createModelCliFixture>[0] = {}) {
  const f = createModelCliFixture(options);
  fixtures.push(f);
  return f;
}
function input(f: ModelCliFixture, request = validationSummaryInputRequest(f)) {
  return { workerTokenSha256: f.workerTokenSha256, request };
}
function freeze(
  f: ModelCliFixture,
  request = validationSummaryInputRequest(f),
  options: Parameters<typeof freezeValidationSummaryInput>[3] = {},
) {
  return freezeValidationSummaryInput(f.database, input(f, request), time.opened, options);
}
function records(f: ModelCliFixture) {
  return canonicalJson(
    f.database
      .prepare("SELECT * FROM model_summary_inputs ORDER BY input_id")
      .all()
      .map((row) => ({ ...row })),
  );
}
function stored(f: ModelCliFixture, id: string) {
  f.database.exec("BEGIN");
  try {
    return readFrozenValidationSummaryInputInTransaction(f.database, id);
  } finally {
    f.database.exec("ROLLBACK");
  }
}
function facts(
  coordinator: EvidenceVerificationCoordinator,
  prepared: Parameters<EvidenceVerificationCoordinator["assertPreparedEvidence"]>[0],
): ValidationSummaryInputEvidenceFacts {
  return {
    assertCurrent: (fingerprint) => coordinator.assertPreparedSummaryInput(prepared, fingerprint),
    validateEvidenceReferences: (scope) => coordinator.admittedEvidenceReferences(prepared, scope),
    validateScenarioEvidence: (scope) => coordinator.admittedScenarioEvidence(prepared, scope),
    readScenarioObservations: (scope) => coordinator.admittedScenarioObservations(prepared, scope),
  };
}
function coordinator(f: ModelCliFixture, storage: EvidenceStorageOptions) {
  const value = new EvidenceVerificationCoordinator(f.database, {
    storage,
    now: () => time.opened,
    createVerifier: (storageRoot) => new EvidenceVerificationClient({ storageRoot }),
  });
  coordinators.push(value);
  return value;
}
function storage(): EvidenceStorageOptions {
  const directory = mkdtempSync(join(tmpdir(), "summary-input-evidence-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return {
    evidenceDirectory: directory,
    globalQuotaBytes: 1024 * 1024,
    globalAssetLimit: 16,
    retentionMs: 86400000,
    incompleteUploadTtlMs: 60000,
  };
}

describe("immutable validation summary inputs", () => {
  it("the real verifier binds a supplied steps object to decoded finalized JSON, not merely its manifest", async () => {
    const f = fixture(),
      request = validationSummaryInputRequest(f),
      options = storage(),
      owner = coordinator(f, options);
    const actual = { synthetic: true, observations: [{ outcome: "failed" }] };
    const bytes = Buffer.from(JSON.stringify(actual, null, 2));
    const metadata: C.EvidenceAssetMetadata = {
      kind: "steps",
      mediaType: "application/json",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      capturedAt: time.opened,
      checkId: request.context.report.checks[0]!.id,
    };
    const upload = handleEvidenceAssetRequest(
      f.database,
      {
        operation: "beginEvidenceUpload",
        input: { lease: request.lease, clientAssetId: "synthetic-json-binding", metadata },
      },
      time.opened,
      options,
    ) as C.BeginEvidenceUploadResponse;
    handleEvidenceAssetRequest(
      f.database,
      {
        operation: "appendEvidenceChunk",
        input: {
          lease: request.lease,
          assetId: upload.assetId,
          offset: 0,
          base64: bytes.toString("base64"),
          chunkSha256: metadata.sha256,
        },
      },
      time.opened,
      options,
    );
    const finalization = await owner.prepareFinalizeEvidence(
      { lease: request.lease, assetId: upload.assetId },
      new AbortController().signal,
    );
    owner.commitPreparedFinalization(finalization);
    const candidate = readEvidenceVerificationCandidate(f.database, {
      repositoryId: f.repositoryId,
      runId: request.context.runId,
      requestId: request.context.requestId,
      jobId: request.lease.jobId,
      runAttemptId: request.lease.runAttemptId,
      profileVersionId: request.context.profileVersionId,
      checkId: metadata.checkId!,
      assetId: upload.assetId,
    });
    if (candidate === null) throw new Error("The real finalized evidence candidate is missing.");
    const root = await inspectEvidenceRoot(options.evidenceDirectory, candidate.storageKey);
    const expectedFile = await inspectEvidenceFile(root, {
      assetId: upload.assetId,
      state: "finalized",
      ...candidate.fileBinding,
    });
    const snapshot: AssetVerificationSnapshot = {
      storage: { storageKey: root.storageKey, device: root.device, inode: root.inode },
      asset: candidate.asset,
      manifestDigest: candidate.manifestDigest,
      expectedFile,
      chunks: candidate.chunks,
      expectedJsonSha256: sha256(canonicalJson(actual)),
    };
    const verifier = new EvidenceVerificationClient({ storageRoot: root });
    try {
      expect((await verifier.verifyAsset(snapshot, new AbortController().signal)).sha256).toBe(
        metadata.sha256,
      );
      await expect(
        verifier.verifyAsset(
          {
            ...snapshot,
            expectedJsonSha256: sha256(
              canonicalJson({ ...actual, observations: [{ outcome: "passed" }] }),
            ),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "EVIDENCE_INTEGRITY_FAILED" }));
    } finally {
      await verifier.close();
    }
    expect(records(f)).toBe("[]");
  });
  it("freezes actual composed input separately from the original Prompt without completing a model result", () => {
    const f = fixture(),
      request = validationSummaryInputRequest(f),
      receipt = freeze(f, request);
    const saved = stored(f, receipt.reference.inputId);
    expect(saved).not.toBeNull();
    const cell = f.cells.find((value) => value.arm === "baseline");
    expect(receipt.reference).toMatchObject({
      sourcePromptSha256: cell?.prompt.promptSha256,
      outputSchemaSha256: cell?.prompt.outputSchemaSha256,
      contextSha256: sha256(canonicalJson(request.context)),
      inputSha256: sha256(canonicalJson(saved?.document)),
      actualPromptSha256: sha256(
        composeSummaryPrompt(cell?.prompt.renderedPrompt ?? "", canonicalJson(request.context)),
      ),
    });
    expect(receipt.reference.actualPromptSha256).not.toBe(receipt.reference.sourcePromptSha256);
    expect(saved?.document).toMatchObject({
      evaluationId: f.batch.id,
      cellId: cell?.id,
      context: request.context,
    });
    expect(records(f)).not.toContain(request.lease.leaseToken);
    expect(records(f)).not.toContain(f.workerToken);
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toMatchObject({ count: 0 });
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("preserves exact replay in recovery after expiry and credential rotation, but rejects the old credential and changed intent", () => {
    const f = fixture(),
      request = validationSummaryInputRequest(f),
      receipt = freeze(f, request),
      before = records(f);
    f.database
      .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
      .run(time.opened, request.lease.runAttemptId);
    const nextHash = sha256("synthetic-rotated-credential");
    f.database
      .prepare("UPDATE worker_node_credentials SET token_sha256 = ? WHERE worker_node_id = ?")
      .run(nextHash, request.lease.workerNodeId);
    expect(() => freeze(f, request, { readOnly: true })).toThrow(
      expect.objectContaining({ code: "WORKER_TOKEN_REJECTED" }),
    );
    expect(
      freezeValidationSummaryInput(
        f.database,
        { workerTokenSha256: nextHash, request },
        time.submitted,
        { readOnly: true },
      ),
    ).toEqual(receipt);
    const changed = structuredClone(request);
    changed.context.report.summary = "Changed immutable runner text.";
    expect(() =>
      freezeValidationSummaryInput(
        f.database,
        { workerTokenSha256: nextHash, request: changed },
        time.submitted,
        { readOnly: true },
      ),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_SUMMARY_INPUT_CONFLICT" }));
    expect(records(f)).toBe(before);
  });
  it("isolates both cells and rejects a second input identity for an already frozen attempt", () => {
    const f = fixture(),
      a = freeze(f),
      b = freeze(f, validationSummaryInputRequest(f, "candidate"));
    expect(a.reference.inputSha256).not.toBe(b.reference.inputSha256);
    const another = validationSummaryInputRequest(f);
    another.inputId = "another-input";
    expect(() => freeze(f, another)).toThrow(
      expect.objectContaining({ code: "VALIDATION_SUMMARY_INPUT_CONFLICT" }),
    );
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM model_summary_inputs").get(),
    ).toMatchObject({ count: 2 });
  });
  it.each([
    "runId",
    "requestId",
    "profileVersionId",
    "planDigest",
    "revisionKey",
    "githubRepositoryId",
  ] as const)("rejects a foreign %s before writing", (field) => {
    const f = fixture(),
      request = validationSummaryInputRequest(f);
    const fields = request.context as unknown as Record<string, unknown>;
    fields[field] =
      field === "githubRepositoryId"
        ? 99999
        : field.endsWith("Digest") || field === "revisionKey"
          ? "a".repeat(64)
          : "foreign-id";
    expect(() => freeze(f, request)).toThrow();
    expect(records(f)).toBe("[]");
  });
  it("rejects a profile-only attempt", () => {
    const f = fixture({ modelRequired: false });
    expect(() => freeze(f)).toThrow(
      expect.objectContaining({ code: "VALIDATION_SUMMARY_INPUT_LEASE_REJECTED" }),
    );
    expect(records(f)).toBe("[]");
  });
  it("does not replace an already frozen input", () => {
    const f = fixture();
    freeze(f);
    const replacement = validationSummaryInputRequest(f);
    const original = records(f);
    replacement.inputId = "late-replacement";
    expect(() => freeze(f, replacement)).toThrow(
      expect.objectContaining({ code: "VALIDATION_SUMMARY_INPUT_CONFLICT" }),
    );
    expect(records(f)).toBe(original);
  });
  it.each(["readonly", "expired", "cancelled", "disabled", "credential_revoked"] as const)(
    "rejects new writes while %s",
    (state) => {
      const f = fixture(),
        request = validationSummaryInputRequest(f);
      if (state === "expired")
        f.database
          .prepare("UPDATE run_attempts SET lease_expires_at=? WHERE id=?")
          .run(time.opened, request.lease.runAttemptId);
      if (state === "cancelled")
        f.database
          .prepare("UPDATE jobs SET cancellation_requested_at=? WHERE id=?")
          .run(time.opened, request.lease.jobId);
      if (state === "disabled")
        f.database
          .prepare("UPDATE managed_repositories SET enabled=0 WHERE id=?")
          .run(f.repositoryId);
      if (state === "credential_revoked")
        f.database
          .prepare(
            "UPDATE worker_node_credentials SET auth_state='revoked',revoked_at=? WHERE worker_node_id=?",
          )
          .run(time.opened, request.lease.workerNodeId);
      expect(() => freeze(f, request, { readOnly: state === "readonly" })).toThrow();
      expect(records(f)).toBe("[]");
    },
  );
  it("rejects invented checks, prior model lifecycle facts, and an unmapped reproduction assessment", () => {
    const f = fixture();
    const check = validationSummaryInputRequest(f);
    check.context.report.checks[0]!.id = `${check.context.profileVersionId}:invented`;
    expect(() => freeze(f, check)).toThrow();
    const diagnostic = validationSummaryInputRequest(f);
    diagnostic.context.execution.blockers.push({
      phase: "model_review",
      stepId: null,
      code: "SYNTHETIC_BLOCK",
      message: "Previous model state.",
    });
    expect(() => freeze(f, diagnostic)).toThrow();
    const assessment = validationSummaryInputRequest(f);
    (assessment.context as unknown as Record<string, unknown>).observationResults = {
      reproductionAssessment: { schemaVersion: "forged" },
    };
    expect(() => freeze(f, assessment)).toThrow();
    expect(records(f)).toBe("[]");
  });
  it("uses nested savepoints and leaves the caller transaction intact after conflict", () => {
    const f = fixture();
    f.database.exec("BEGIN IMMEDIATE");
    try {
      freeze(f);
      const changed = validationSummaryInputRequest(f);
      changed.inputId = "another";
      expect(() => freeze(f, changed)).toThrow();
      expect(f.database.isTransaction).toBe(true);
      expect(
        f.database.prepare("SELECT COUNT(*) AS count FROM model_summary_inputs").get(),
      ).toMatchObject({ count: 1 });
    } finally {
      f.database.exec("ROLLBACK");
    }
    expect(records(f)).toBe("[]");
  });
  it("requires an owned current evidence token, including after expiry or for another input", async () => {
    const f = fixture(),
      request = validationSummaryInputRequest(f),
      owner = coordinator(f, storage());
    const initial = prepareValidationSummaryInput(f.database, input(f, request), time.opened);
    if (initial.kind !== "verify") throw new Error("Expected a new input.");
    const prepared = await owner.prepareValidationSummaryInputEvidence(
      initial.evidence,
      new AbortController().signal,
    );
    const foreign = coordinator(f, storage());
    expect(() => freeze(f, request, { evidence: facts(foreign, prepared) })).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
    const changed = structuredClone(request);
    changed.context.report.summary = "Changed before commit.";
    expect(() => freeze(f, changed, { evidence: facts(owner, prepared) })).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
    await setImmediate();
    expect(() => freeze(f, request, { evidence: facts(owner, prepared) })).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
    expect(records(f)).toBe("[]");
  });
  it("verifies actual finalized log bytes, refuses tampering, and does not reread files for an exact committed replay", async () => {
    const f = fixture(),
      request = validationSummaryInputRequest(f),
      options = storage(),
      owner = coordinator(f, options);
    const bytes = Buffer.from("Synthetic compilation failed.\n"),
      check = request.context.report.checks[0]!;
    const metadata: C.EvidenceAssetMetadata = {
      kind: "log",
      mediaType: "text/plain",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      capturedAt: time.opened,
      checkId: check.id,
    };
    const upload = handleEvidenceAssetRequest(
      f.database,
      {
        operation: "beginEvidenceUpload",
        input: { lease: request.lease, clientAssetId: "summary-log", metadata },
      },
      time.opened,
      options,
    ) as C.BeginEvidenceUploadResponse;
    handleEvidenceAssetRequest(
      f.database,
      {
        operation: "appendEvidenceChunk",
        input: {
          lease: request.lease,
          assetId: upload.assetId,
          offset: 0,
          base64: bytes.toString("base64"),
          chunkSha256: metadata.sha256,
        },
      },
      time.opened,
      options,
    );
    const finalization = await owner.prepareFinalizeEvidence(
      { lease: request.lease, assetId: upload.assetId },
      new AbortController().signal,
    );
    const manifest = owner.commitPreparedFinalization(finalization);
    check.evidenceIds = [manifest.id];
    request.context.evidence.assets = [manifest];
    expect(() => freeze(f, request)).toThrow();
    const initial = prepareValidationSummaryInput(f.database, input(f, request), time.opened);
    if (initial.kind !== "verify") throw new Error("Expected a new input.");
    const prepared = await owner.prepareValidationSummaryInputEvidence(
      initial.evidence,
      new AbortController().signal,
    );
    const receipt = freeze(f, request, { evidence: facts(owner, prepared) });
    writeFileSync(
      join(options.evidenceDirectory, `${manifest.id}.asset`),
      Buffer.alloc(bytes.length, 120),
    );
    expect(freeze(f, request)).toEqual(receipt);
    await expect(
      owner.prepareValidationSummaryInputEvidence(initial.evidence, new AbortController().signal),
    ).rejects.toThrow(expect.objectContaining({ code: "EVIDENCE_INTEGRITY_FAILED" }));
    expect(stored(f, receipt.reference.inputId)?.document.context.report.checks[0]?.outcome).toBe(
      "failed",
    );
  });
  it("SQL rejects UPDATE, DELETE, and REPLACE for either immutable unique identity", () => {
    const f = fixture();
    freeze(f);
    const row = f.database.prepare("SELECT * FROM model_summary_inputs").get()!;
    const columns = Object.keys(row),
      values = Object.values(row);
    expect(() => f.database.exec("UPDATE model_summary_inputs SET input_id=input_id")).toThrow(
      /immutable/u,
    );
    expect(() => f.database.exec("DELETE FROM model_summary_inputs")).toThrow(/immutable/u);
    const replace = f.database.prepare(
      `INSERT OR REPLACE INTO model_summary_inputs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    expect(() => replace.run(...values)).toThrow(/immutable/u);
    const distinct = [...values];
    distinct[columns.indexOf("input_id")] = "different-id";
    const document = JSON.parse(String(row.input_json)) as C.FrozenValidationSummaryInputV1;
    document.inputId = "different-id";
    distinct[columns.indexOf("input_json")] = canonicalJson(document);
    distinct[columns.indexOf("input_sha256")] = sha256(canonicalJson(document));
    expect(() => replace.run(...distinct)).toThrow(/immutable/u);
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it.each([
    "foreign_cell",
    "foreign_prompt",
    "duplicate_key",
    "unknown_field",
    "after_deadline",
  ] as const)("SQL independently rejects %s input metadata", (change) => {
    const f = fixture();
    f.database.exec("BEGIN IMMEDIATE");
    const receipt = freeze(f);
    const row = {
      ...f.database
        .prepare("SELECT * FROM model_summary_inputs WHERE input_id=?")
        .get(receipt.reference.inputId)!,
    };
    f.database.exec("ROLLBACK");
    const value = JSON.parse(String(row.input_json)) as C.FrozenValidationSummaryInputV1;
    if (change === "foreign_cell")
      value.cellId = f.cells.find((cell) => cell.arm === "candidate")!.id;
    if (change === "foreign_prompt") value.sourcePromptSha256 = "a".repeat(64);
    if (change === "unknown_field")
      (value as unknown as Record<string, unknown>).unexpectedMetadata = true;
    if (change === "after_deadline") {
      value.frozenAt = time.deadline;
      row.frozen_at = time.deadline;
    }
    row.input_json = canonicalJson(value);
    if (change === "duplicate_key")
      row.input_json = String(row.input_json).replace("{", '{"inputId":"shadowed",');
    row.input_sha256 = sha256(String(row.input_json));
    const columns = Object.keys(row);
    expect(() =>
      f.database
        .prepare(
          `INSERT INTO model_summary_inputs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .run(...Object.values(row)),
    ).toThrow();
    expect(records(f)).toBe("[]");
  });
});
