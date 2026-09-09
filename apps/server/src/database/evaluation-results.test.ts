import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import type { ValidationJobResultV1, ValidationJobResultV2 } from "@agentic-review/codex";
import * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EvidenceVerificationClient } from "../../dist/database/evidence-verification-client.js";
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
  validate,
} from "./evaluation-completion.testing.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import {
  evaluationActor,
  evaluationAdministrator,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import { getEvaluationCellResult, prepareEvaluationCellResultRead } from "./evaluation-results.js";
import {
  closeEvidenceAssetStorage,
  type EvidenceAssetOperation,
  type EvidenceAssetOperationMap,
  type EvidenceAssetRequest,
  type EvidenceStorageOptions,
  handleEvidenceAssetRequest,
} from "./evidence-assets.js";
import {
  EvidenceVerificationCoordinator,
  type PreparedRunEvidence,
} from "./evidence-verification.js";
import { insertHistoricalEvaluationResult } from "./historical-evaluation-results.testing.js";
import { handleReviewRunQuery } from "./review-run-queries.js";
import type { VerifiedValidationEvidenceFacts } from "./validation-result-projection.js";
import {
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

type Cell = EvaluationCompletionFixture["cells"][number];
const administrators = [evaluationAdministrator];
const fixtures: EvaluationCompletionFixture[] = [];
const coordinators: EvidenceVerificationCoordinator[] = [];
const directories: string[] = [];
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
  vi.restoreAllMocks();
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
  return value;
}

function complete(
  value: EvaluationCompletionFixture,
  cell: Cell = selected(value),
  submitted: ValidationJobResultV1 = resultFor(cell),
) {
  const completion = beginAttempt(value, cell);
  const validated = validate(value, completion, submitted);
  const resultId = transaction(value.database, () => {
    settle(value.database, completion, validated);
    const id = persistValidatedValidationResult(value.database, completion, validated, completedAt);
    value.database
      .prepare(
        "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
      )
      .run(completedAt, cell.jobId);
    return id;
  });
  const query: C.EvaluationCellResultReadQuery = {
    repositoryId: value.repositoryId,
    evaluationId: value.batch.id,
    cellId: cell.id,
    resultId,
  };
  return { cell, completion, submitted, validated, query };
}

function evidenceCoordinator(value: EvaluationCompletionFixture) {
  const directory = mkdtempSync(join(tmpdir(), "evaluation-result-evidence-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const storage: EvidenceStorageOptions = {
    evidenceDirectory: directory,
    globalQuotaBytes: 1024 * 1024,
    globalAssetLimit: 16,
    retentionMs: 86_400_000,
    incompleteUploadTtlMs: 60_000,
  };
  const coordinator = new EvidenceVerificationCoordinator(value.database, {
    storage,
    now: () => completedAt,
    // Use the built file-verification Worker while retaining this source coordinator's proof maps.
    createVerifier: (storageRoot) => new EvidenceVerificationClient({ storageRoot }),
  });
  coordinators.push(coordinator);
  return { coordinator, directory, storage };
}

function factsFor(coordinator: EvidenceVerificationCoordinator, proof: PreparedRunEvidence) {
  return {
    profiles: proof.profiles,
    assertCurrent: vi.fn(() => coordinator.assertPreparedEvidence(proof.prepared)),
    admittedEvidenceReferences: (scope) =>
      coordinator.admittedEvidenceReferences(proof.prepared, scope),
    admittedScenarioEvidence: (scope) =>
      coordinator.admittedScenarioEvidence(proof.prepared, scope),
  } satisfies VerifiedValidationEvidenceFacts;
}

async function readVerified(
  value: EvaluationCompletionFixture,
  query: C.EvaluationCellResultReadQuery,
  coordinator: EvidenceVerificationCoordinator,
  actor: C.OperatorPrincipal = evaluationActor,
) {
  const input = { ...query, actor };
  const preparedQuery = prepareEvaluationCellResultRead(value.database, input, administrators);
  const proof = await coordinator.prepareEvaluationCellReadEvidence(
    preparedQuery,
    new AbortController().signal,
  );
  const facts = factsFor(coordinator, proof);
  facts.assertCurrent.mockImplementation(() => {
    expect(value.database.isTransaction).toBe(true);
    coordinator.assertPreparedEvidence(proof.prepared);
  });
  const result = getEvaluationCellResult(value.database, input, administrators, facts);
  expect(facts.assertCurrent).toHaveBeenCalledOnce();
  expect(C.getEvaluationCellResultIssues(result)).toEqual([]);
  return { result, proof, facts };
}

function expectMissing(action: () => unknown) {
  expect(action).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
}

describe("evaluation cell results from completed V2 validation jobs", () => {
  it("reads each arm's exact sealed result with a real coordinator proof and no ordinary V1 projection", async () => {
    const value = fixture();
    const baseline = complete(value);
    const candidateCell = selected(value, "candidate");
    const candidateBody = resultFor(candidateCell);
    candidateBody.report.summary = "The candidate has its own recorded compiler observation.";
    const candidate = complete(value, candidateCell, candidateBody);
    const { coordinator } = evidenceCoordinator(value);

    for (const completed of [baseline, candidate]) {
      expect(
        prepareEvaluationCellResultRead(
          value.database,
          { ...completed.query, actor: evaluationActor },
          administrators,
        ),
      ).toEqual(completed.query);
      const { result, proof } = await readVerified(value, completed.query, coordinator);
      expect(proof.profiles).toEqual([
        { requestId: completed.cell.request_id, jobId: completed.cell.jobId, status: "verified" },
      ]);
      expect(result).toMatchObject({
        schemaVersion: "EvaluationCellResultV1",
        ...completed.query,
        caseId: completed.cell.case_id,
        arm: completed.cell.arm,
        trial: 1,
        runId: completed.cell.run_id,
        requestId: completed.cell.request_id,
        jobId: completed.cell.jobId,
        runAttemptId: completed.completion.runAttemptId,
        workItemId: value.planInput.workItemId,
        sourceId: value.source.id,
        sourceDigest: completed.cell.plan.source.sourceDigest,
        revisionKey: completed.cell.plan.revision.revisionKey,
        planDigest: completed.cell.plan_digest,
        executionDigest: sha256(canonicalJson(completed.cell.template)),
        profileVersionId: completed.cell.template.validation.profileVersion.id,
        promptVersionId: completed.cell.template.validation.promptVersion.id,
        workflowKind: "issue_validation",
        target: "headless",
        resultDigest: completed.validated.resultDigest,
        evidenceComplete: true,
      });
      expect(result.report).toEqual(completed.submitted.report);
      expect(result.report.checks[0]?.outcome).toBe("failed");
      expect(result).not.toHaveProperty("evidenceVerificationPending");
      expect(
        handleReviewRunQuery(value.database, {
          operation: "getDashboardReviewRunJobResult",
          input: {
            repositoryId: value.repositoryId,
            reviewRunId: completed.cell.run_id,
            requestId: completed.cell.request_id,
            jobId: completed.cell.jobId,
          },
        }),
      ).toBeNull();
      expect(
        handleReviewRunQuery(value.database, {
          operation: "getDashboardReviewRun",
          input: { repositoryId: value.repositoryId, reviewRunId: completed.cell.run_id },
        }),
      ).toBeNull();
    }
    expect(baseline.query.resultId).not.toBe(candidate.query.resultId);
    expect(baseline.validated.resultDigest).not.toBe(candidate.validated.resultDigest);
  });

  it("rejects repository, evaluation, cell and result substitutions in both preflight and final reads", () => {
    const value = fixture(),
      baseline = complete(value),
      candidate = complete(value, selected(value, "candidate"));
    const otherBatch = value.create({
      ...value.input,
      request: { ...value.input.request, changeId: "another-evaluation-result-scope" },
    });
    for (const query of [
      { ...baseline.query, repositoryId: value.secondRepositoryId },
      { ...baseline.query, evaluationId: otherBatch.id },
      { ...baseline.query, cellId: candidate.cell.id },
      { ...baseline.query, resultId: candidate.query.resultId },
      { ...baseline.query, resultId: "missing-evaluation-result" },
    ]) {
      const input = { ...query, actor: evaluationAdministrator };
      expectMissing(() => prepareEvaluationCellResultRead(value.database, input, administrators));
      expectMissing(() => getEvaluationCellResult(value.database, input, administrators));
      expect(value.database.isTransaction).toBe(false);
    }
  });

  it("does not turn persisted metadata or another arm's proof into verified evidence", async () => {
    const value = fixture(),
      baseline = complete(value),
      candidate = complete(value, selected(value, "candidate"));
    expect(
      value.database
        .prepare("SELECT evidence_complete FROM validation_job_results WHERE id = ?")
        .get(baseline.query.resultId),
    ).toEqual({ evidence_complete: 1 });
    const withoutProof = getEvaluationCellResult(
      value.database,
      { ...baseline.query, actor: evaluationActor },
      administrators,
    );
    expect(withoutProof.evidenceComplete).toBe(false);
    expect(withoutProof.report).toEqual(baseline.submitted.report);
    const { coordinator } = evidenceCoordinator(value);
    const proof = await coordinator.prepareEvaluationCellReadEvidence(
      baseline.query,
      new AbortController().signal,
    );
    const facts = factsFor(coordinator, proof);
    const other = getEvaluationCellResult(
      value.database,
      { ...candidate.query, actor: evaluationActor },
      administrators,
      facts,
    );
    expect(facts.assertCurrent).toHaveBeenCalledOnce();
    expect(other.evidenceComplete).toBe(false);
    expect(other.jobId).toBe(candidate.cell.jobId);
  });

  it.each(["forged", "expired"] as const)(
    "rejects a %s coordinator token before projecting evidence",
    async (kind) => {
      const value = fixture(),
        completed = complete(value),
        { coordinator } = evidenceCoordinator(value);
      const proof = await coordinator.prepareEvaluationCellReadEvidence(
        completed.query,
        new AbortController().signal,
      );
      const invalidProof: PreparedRunEvidence =
        kind === "forged" ? { ...proof, prepared: { kind: "prepared_evidence" } } : proof;
      if (kind === "expired") await immediate();
      const facts = factsFor(coordinator, invalidProof);
      expect(() =>
        getEvaluationCellResult(
          value.database,
          { ...completed.query, actor: evaluationActor },
          administrators,
          facts,
        ),
      ).toThrow(expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }));
      expect(facts.assertCurrent).toHaveBeenCalledOnce();
      expect(value.database.isTransaction).toBe(false);
    },
  );

  it("checks read permission before preparing or consuming a proof, including revocation after preflight", async () => {
    const value = fixture(),
      completed = complete(value),
      { coordinator } = evidenceCoordinator(value);
    const input = { ...completed.query, actor: evaluationActor };
    const query = prepareEvaluationCellResultRead(value.database, input, administrators);
    const proof = await coordinator.prepareEvaluationCellReadEvidence(
      query,
      new AbortController().signal,
    );
    const facts = factsFor(coordinator, proof);
    setEvaluationManagementRole(value.database, value.repositoryId, null, 1);
    expectMissing(() => getEvaluationCellResult(value.database, input, administrators, facts));
    expect(facts.assertCurrent).not.toHaveBeenCalled();
    expectMissing(() => prepareEvaluationCellResultRead(value.database, input, administrators));
    expect(value.database.isTransaction).toBe(false);
  });

  it.each(["cancelled", "repository_disabled"] as const)(
    "retains historical results after %s for an actor with current read permission",
    async (change) => {
      const value = fixture(),
        completed = complete(value),
        { coordinator } = evidenceCoordinator(value);
      const original = (await readVerified(value, completed.query, coordinator)).result;
      if (change === "cancelled") {
        transaction(value.database, () =>
          cancelEvaluationBatchInTransaction(
            value.database,
            {
              repositoryId: value.repositoryId,
              evaluationId: value.batch.id,
              actor: evaluationAdministrator,
              request: {
                changeId: "cancel-after-recorded-result",
                expectedVersion: 1,
                reason: "Keep the recorded baseline while cancelling queued work.",
              },
            },
            completedAt,
            administrators,
          ),
        );
      } else
        value.database
          .prepare("UPDATE managed_repositories SET enabled = 0 WHERE id = ?")
          .run(value.repositoryId);
      setEvaluationManagementRole(value.database, value.repositoryId, "viewer", 1);
      const historical = (await readVerified(value, completed.query, coordinator)).result;
      expect(historical).toEqual(original);
    },
  );

  it("reads a V2 runner-only result through actual completion and prepared evidence without reserializing storage", async () => {
    const value = fixture(),
      cell = selected(value);
    const original = resultFor(cell);
    if (original.report.workItemKind !== "issue")
      throw new Error("The evaluation fixture must contain an Issue result.");
    const { modelSummary: _modelSummary, ...report } = original.report;
    const submitted: ValidationJobResultV2 = {
      ...original,
      schemaVersion: "ValidationJobResultV2",
      report,
      modelReview: { state: "not_requested" },
    };
    const completion = beginAttempt(value, cell);
    const bytes = canonicalJson(submitted),
      digest = sha256(bytes);
    const validated = validateValidationCompletion(value.database, completion, digest, submitted);
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
    const query = {
      repositoryId: value.repositoryId,
      evaluationId: value.batch.id,
      cellId: cell.id,
      resultId,
    };
    const { coordinator } = evidenceCoordinator(value);
    const first = await readVerified(value, query, coordinator);
    expect(first.proof.profiles).toEqual([
      { requestId: cell.request_id, jobId: cell.jobId, status: "verified" },
    ]);
    expect(first.result).toMatchObject({
      resultDigest: digest,
      report,
      execution: submitted.execution,
      evidenceComplete: true,
      modelReview: { state: "not_requested" },
      occurrences: [],
    });
    expect((await readVerified(value, query, coordinator)).result).toEqual(first.result);
    expect(
      value.database
        .prepare("SELECT schema_id, result_json FROM validation_job_results WHERE id = ?")
        .get(resultId),
    ).toEqual({ schema_id: "ValidationJobResultV2", result_json: bytes });
  });

  it("normalizes historical V1 model summaries while preserving diagnostics and stable occurrence ordinals", async () => {
    const value = fixture(),
      cell = selected(value),
      submitted = resultFor(cell);
    if (submitted.report.workItemKind !== "issue")
      throw new Error("The fixture must use Issue validation.");
    submitted.report.modelSummary = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "issue",
      summary: "Two independently recorded observations describe the same visible failure.",
      reproductionConclusion: "inconclusive",
      observations: ["first-observation", "second-observation"].map((id) => ({
        id,
        title: "Compiler failure",
        body: "The declared build failed.",
        priority: 1,
        path: "src/example.ts",
        line: 7,
      })),
    };
    const diagnostic = submitted.execution.diagnostics[0];
    if (!diagnostic) throw new Error("The fixture must contain its compiler diagnostic.");
    diagnostic.stdout = "Synthetic compiler output.\n";
    diagnostic.stderr = "Synthetic error details.\n";
    const archive = insertHistoricalEvaluationResult(
        value.database,
        cell,
        beginAttempt(value, cell),
        submitted,
      ),
      { coordinator } = evidenceCoordinator(value);
    const first = (await readVerified(value, archive.query, coordinator)).result;
    const repeated = (await readVerified(value, archive.query, coordinator)).result;
    expect(first.report).not.toHaveProperty("modelSummary");
    expect(first.report.checks).toEqual(submitted.report.checks);
    expect(first.execution).toEqual(submitted.execution);
    expect(first.modelReview).toMatchObject({
      state: "completed",
      summary: submitted.report.modelSummary.summary,
      reproductionConclusion: "inconclusive",
      observations: submitted.report.modelSummary.observations,
      findings: [],
      error: null,
    });
    expect(first.occurrences.map(({ key: _key, ...ref }) => ref)).toEqual(
      [0, 1].map((ordinal) => ({
        resultId: archive.query.resultId,
        resultDigest: archive.resultDigest,
        kind: "validation_observation",
        ordinal,
      })),
    );
    expect(new Set(first.occurrences.map((occurrence) => occurrence.key)).size).toBe(2);
    expect(repeated.occurrences).toEqual(first.occurrences);
    expect(
      value.database
        .prepare("SELECT result_json FROM validation_job_results WHERE id = ?")
        .get(archive.query.resultId),
    ).toEqual({ result_json: canonicalJson(submitted) });
  });

  it("verifies a real V2 evidence file and downgrades a same-length replacement without changing the recorded outcome", async () => {
    const value = fixture(),
      cell = selected(value);
    const leaseToken = sha256("evaluation-result-evidence-lease");
    const completion = beginAttempt(value, cell, leaseToken);
    const { coordinator, directory, storage } = evidenceCoordinator(value);
    const lease: C.LeaseIdentity = {
      jobId: cell.jobId,
      runAttemptId: completion.runAttemptId,
      workerNodeId: "evaluation-node",
      workerInstanceId: "evaluation-instance",
      leaseGeneration: 1,
      leaseToken,
    };
    const bytes = Buffer.from("The isolated compiler fixture recorded a build failure.\n");
    const checkId = `${cell.template.validation.profileVersion.id}:compile`;
    const uploadedAt = "2026-09-08T04:01:00.000Z";
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
    const upload = request("beginEvidenceUpload", {
      lease,
      clientAssetId: "evaluation-compiler-log",
      metadata: {
        kind: "log",
        mediaType: "text/plain",
        sizeBytes: bytes.length,
        sha256: sha256(bytes.toString("utf8")),
        capturedAt: uploadedAt,
        checkId,
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
    const assetPath = join(directory, `${manifest.id}.asset`);
    expect(readFileSync(assetPath)).toEqual(bytes);
    const submitted = resultFor(cell);
    const check = submitted.report.checks[0];
    if (!check) throw new Error("The fixture must contain its compiler check.");
    check.evidenceIds = [manifest.id];
    const digest = sha256(canonicalJson(submitted));
    const completionProof = await coordinator.prepareCompletionEvidence(
      completion,
      digest,
      submitted,
      new AbortController().signal,
    );
    coordinator.assertPreparedEvidence(completionProof);
    const validated = validateValidationCompletion(
      value.database,
      completion,
      digest,
      submitted,
      undefined,
      {
        validateEvidenceReferences: (scope) =>
          coordinator.admittedEvidenceReferences(completionProof, scope),
        validateScenarioEvidence: (scope) =>
          coordinator.admittedScenarioEvidence(completionProof, scope),
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
    const query: C.EvaluationCellResultReadQuery = {
      repositoryId: value.repositoryId,
      evaluationId: value.batch.id,
      cellId: cell.id,
      resultId,
    };
    const verified = await readVerified(value, query, coordinator);
    expect(verified.proof.profiles).toEqual([
      { requestId: cell.request_id, jobId: cell.jobId, status: "verified" },
    ]);
    expect(verified.result.evidenceComplete).toBe(true);

    // This path was created by the real upload API in this test's owned temporary directory.
    chmodSync(assetPath, 0o600);
    writeFileSync(assetPath, Buffer.alloc(bytes.length, 0x78));
    chmodSync(assetPath, 0o400);
    expect(readFileSync(assetPath)).toHaveLength(bytes.length);
    expect(readFileSync(assetPath)).not.toEqual(bytes);
    const changed = await readVerified(value, query, coordinator);
    expect(changed.proof.profiles[0]?.status).not.toBe("verified");
    expect(changed.result.evidenceComplete).toBe(false);
    expect(changed.result.report).toEqual(verified.result.report);
    expect(changed.result.execution).toEqual(verified.result.execution);
    expect(changed.result.resultDigest).toBe(verified.result.resultDigest);
    expect(changed.result.report.checks[0]?.outcome).toBe("failed");
    expect(
      value.database
        .prepare("SELECT evidence_complete, result_json FROM validation_job_results WHERE id = ?")
        .get(resultId),
    ).toEqual({ evidence_complete: 1, result_json: canonicalJson(submitted) });
  });
});
