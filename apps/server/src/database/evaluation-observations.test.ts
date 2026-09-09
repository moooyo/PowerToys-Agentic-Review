import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as immediate } from "node:timers/promises";
import type { ValidationJobResultV1 } from "@agentic-review/codex";
import type * as C from "@agentic-review/contracts";
import { EVALUATION_SCORING_RULES_VERSION, scoreEvaluation } from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EvidenceVerificationClient } from "../../dist/database/evidence-verification-client.js";
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
  validate,
} from "./evaluation-completion.testing.js";
import {
  evaluationActor,
  evaluationAdministrator,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import {
  captureEvaluationScoreInputsInTransaction,
  type EvaluationScoreInputs,
  evaluationScoreInputDigest,
  type VerifiedEvaluationBatchEvidenceFacts,
} from "./evaluation-observations.js";
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
  type PreparedEvaluationBatchEvidence,
} from "./evidence-verification.js";
import { insertHistoricalEvaluationResult } from "./historical-evaluation-results.testing.js";
import { getJobAdmissionRecord } from "./job-admission.js";
import type { ReviewCompletionJobContext } from "./review-results.js";
import {
  completeValidationModelResultFixture,
  createValidationModelResultBindingFixture,
} from "./validation-model-result-binding.testing.js";
import type { VerifiedValidationEvidenceFacts } from "./validation-result-projection.js";
import {
  persistValidatedValidationResult,
  type ValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

type Cell = EvaluationCompletionFixture["cells"][number];
interface BatchOwner {
  database: DatabaseSync;
  repositoryId: string;
  batch: C.EvaluationBatchSummaryV1;
}
const administrators = [evaluationAdministrator];
const fixtures: { database: DatabaseSync; close: () => void }[] = [];
const coordinators: EvidenceVerificationCoordinator[] = [];
const directories: string[] = [];
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));

beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close()));
  for (const value of fixtures.splice(0)) {
    closeEvidenceAssetStorage(value.database);
    value.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const [name, original] of formats) {
    if (original === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, original);
  }
});

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The observation fixture is incomplete.");
  return value;
}
function fixture() {
  const value = createEvaluationCompletionFixture();
  fixtures.push(value);
  return value;
}
function unexecutedFixture(kind: "issue" | "pull_request" = "issue") {
  const value = createEvaluationBatchFixture(kind);
  fixtures.push(value);
  const batch = value.create({
    ...value.input,
    request: {
      ...value.input.request,
      mode: kind === "issue" ? "profile_only" : "prompt_and_profile",
    },
  });
  return { ...value, batch };
}
const scopeFor = (value: BatchOwner) => ({
  repositoryId: value.repositoryId,
  evaluationId: value.batch.id,
});
function persistCompletion(
  value: EvaluationCompletionFixture,
  cell: Cell,
  completion: ReviewCompletionJobContext,
  validated: ValidatedValidationResult,
) {
  return transaction(value.database, () => {
    settle(value.database, completion, validated);
    const resultId = persistValidatedValidationResult(
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
    return resultId;
  });
}
function complete(
  value: EvaluationCompletionFixture,
  cell = selected(value),
  submitted: ValidationJobResultV1 = resultFor(cell),
) {
  const completion = beginAttempt(value, cell);
  const validated = validate(value, completion, submitted);
  const resultId = persistCompletion(value, cell, completion, validated);
  return { cell, completion, submitted, validated, resultId };
}
function evidenceCoordinator(value: Pick<BatchOwner, "database">) {
  const directory = mkdtempSync(join(tmpdir(), "evaluation-observations-evidence-"));
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
    // The compiled Worker performs real file verification; source modules retain their own proof maps.
    createVerifier: (storageRoot) => new EvidenceVerificationClient({ storageRoot }),
  });
  coordinators.push(coordinator);
  return { coordinator, storage, directory };
}
function factsFor(
  value: BatchOwner,
  coordinator: EvidenceVerificationCoordinator,
  proof: PreparedEvaluationBatchEvidence,
) {
  const current = () => {
    expect(value.database.isTransaction).toBe(true);
    coordinator.assertPreparedEvidence(proof.prepared);
  };
  const cells = new Map(
    proof.cells.map(
      (cell) =>
        [
          cell.cellId,
          {
            profiles:
              cell.jobId !== null && cell.verification !== null
                ? [{ requestId: cell.requestId, jobId: cell.jobId, ...cell.verification }]
                : [],
            assertCurrent: vi.fn(current),
            admittedEvidenceReferences: (scope) =>
              coordinator.admittedEvidenceReferences(proof.prepared, scope),
            admittedScenarioEvidence: (scope) =>
              coordinator.admittedScenarioEvidence(proof.prepared, scope),
            admittedScenarioObservations: (scope) =>
              coordinator.admittedScenarioObservations(proof.prepared, scope),
          } satisfies VerifiedValidationEvidenceFacts,
        ] as const,
    ),
  );
  return {
    selectionDigest: proof.selectionDigest,
    cells,
    assertCurrent: vi.fn(current),
  } satisfies VerifiedEvaluationBatchEvidenceFacts;
}
function capture(
  value: BatchOwner,
  facts?: VerifiedEvaluationBatchEvidenceFacts,
  actor = evaluationActor,
) {
  return transaction(value.database, () =>
    captureEvaluationScoreInputsInTransaction(
      value.database,
      scopeFor(value),
      actor,
      administrators,
      facts,
    ),
  );
}
async function verified(value: BatchOwner, coordinator: EvidenceVerificationCoordinator) {
  const proof = await coordinator.prepareEvaluationBatchReadEvidence(
    scopeFor(value),
    new AbortController().signal,
  );
  const facts = factsFor(value, coordinator, proof);
  const inputs = capture(value, facts);
  expect(facts.assertCurrent).toHaveBeenCalledOnce();
  return { proof, facts, inputs };
}
const observation = (inputs: EvaluationScoreInputs, cellId: string) =>
  present(inputs.observations.find((entry) => entry.cellId === cellId));
const reportFor = (inputs: EvaluationScoreInputs) =>
  scoreEvaluation(inputs.frozen, inputs.captured, inputs.adjudications);

async function completeWithLog(value: EvaluationCompletionFixture, cell = selected(value)) {
  const { coordinator, storage, directory } = evidenceCoordinator(value);
  const leaseToken = sha256(`evaluation-observation-log-lease:${cell.jobId}`);
  const completion = beginAttempt(value, cell, leaseToken);
  const lease: C.LeaseIdentity = {
    jobId: cell.jobId,
    runAttemptId: completion.runAttemptId,
    workerNodeId: "evaluation-node",
    workerInstanceId: "evaluation-instance",
    leaseGeneration: 1,
    leaseToken,
  };
  const uploadedAt = "2026-09-08T04:01:00.000Z";
  const bytes = Buffer.from("Synthetic compiler log for the frozen baseline result.\n");
  const hash = sha256(bytes.toString("utf8"));
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
    clientAssetId: "evaluation-observation-log",
    metadata: {
      kind: "log",
      mediaType: "text/plain",
      sizeBytes: bytes.length,
      sha256: hash,
      capturedAt: uploadedAt,
      checkId: `${cell.template.validation.profileVersion.id}:compile`,
    },
  });
  request("appendEvidenceChunk", {
    lease,
    assetId: upload.assetId,
    offset: 0,
    base64: bytes.toString("base64"),
    chunkSha256: hash,
  });
  const manifest = request("finalizeEvidenceUpload", { lease, assetId: upload.assetId });
  const assetPath = join(directory, `${manifest.id}.asset`);
  expect(readFileSync(assetPath)).toEqual(bytes);
  const submitted = resultFor(cell);
  present(submitted.report.checks[0]).evidenceIds = [manifest.id];
  const digest = sha256(canonicalJson(submitted));
  const proof = await coordinator.prepareCompletionEvidence(
    completion,
    digest,
    submitted,
    new AbortController().signal,
  );
  coordinator.assertPreparedEvidence(proof);
  const validated = validateValidationCompletion(
    value.database,
    completion,
    digest,
    submitted,
    undefined,
    {
      validateEvidenceReferences: (scope) => coordinator.admittedEvidenceReferences(proof, scope),
      validateScenarioEvidence: (scope) => coordinator.admittedScenarioEvidence(proof, scope),
    },
  );
  expect(validated.evidenceComplete).toBe(true);
  const resultId = persistCompletion(value, cell, completion, validated);
  return { coordinator, assetPath, bytes, manifest, cell, submitted, validated, resultId };
}

describe("evaluation observations from the complete frozen owner matrix", () => {
  it("retains both arms and not-applicable cases without inventing execution or dropping denominators", async () => {
    const value = unexecutedFixture();
    const { coordinator } = evidenceCoordinator(value);
    const { inputs, proof } = await verified(value, coordinator);
    expect(inputs.frozen.plan.cases).toHaveLength(2);
    expect(inputs.observations).toHaveLength(4);
    expect(proof.cells).toHaveLength(4);
    expect(
      proof.cells.every(
        (cell) => cell.jobId === null && cell.resultId === null && cell.verification === null,
      ),
    ).toBe(true);
    for (const entry of inputs.frozen.plan.cases)
      for (const arm of ["baseline", "candidate"] as const) {
        const binding = entry[`${arm}Binding`];
        expect(observation(inputs, binding.cellId)).toMatchObject({
          ...scopeFor(value),
          caseId: entry.caseId,
          arm,
          ...binding,
          executionState: "not_run",
          result: null,
          sourceState: "unknown",
          checks: [],
          model: { state: "not_applicable" },
        });
      }
    const report = reportFor(inputs);
    expect(report.cases).toHaveLength(2);
    for (const arm of ["baseline", "candidate"] as const)
      expect(report[arm].coverage).toMatchObject({
        applicableCases: 1,
        notRunCases: 1,
        applicableCriteria: 1,
        checks: { numerator: 0, denominator: 1, value: 0 },
      });
    expect(
      value.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });

  it("binds two independently completed arms to one real batch evidence token", async () => {
    const value = fixture();
    const baseline = complete(value);
    const candidateCell = selected(value, "candidate");
    const candidateBody = resultFor(candidateCell);
    present(candidateBody.report.checks[0]).outcome = "passed";
    Object.assign(present(candidateBody.execution.diagnostics[0]), {
      outcome: "passed",
      exitCode: 0,
    });
    const candidate = complete(value, candidateCell, candidateBody);
    const { coordinator } = evidenceCoordinator(value);
    const { inputs, proof, facts } = await verified(value, coordinator);
    expect(inputs.observations).toHaveLength(2);
    expect(inputs.captured.observations).toEqual(inputs.observations);
    expect(inputs.adjudications).toEqual([]);
    expect(facts.assertCurrent).toHaveBeenCalledOnce();
    for (const completed of [baseline, candidate]) {
      expect(present(proof.cells.find((cell) => cell.cellId === completed.cell.id))).toEqual({
        cellId: completed.cell.id,
        requestId: completed.cell.request_id,
        jobId: completed.cell.jobId,
        resultId: completed.resultId,
        verification: { status: "verified" },
      });
      expect(observation(inputs, completed.cell.id)).toMatchObject({
        caseId: completed.cell.case_id,
        arm: completed.cell.arm,
        cellId: completed.cell.id,
        runId: completed.cell.run_id,
        requestId: completed.cell.request_id,
        executionState: "completed",
        sourceState: "original",
        result: {
          resultId: completed.resultId,
          resultDigest: completed.validated.resultDigest,
          jobId: completed.cell.jobId,
          runAttemptId: completed.completion.runAttemptId,
          profileVersionId: completed.cell.template.validation.profileVersion.id,
          promptVersionId: completed.cell.template.validation.promptVersion.id,
          executionDigest: sha256(canonicalJson(completed.cell.template)),
          sourceDigest: completed.cell.plan.source.sourceDigest,
        },
        checks: [
          {
            checkId: present(completed.submitted.report.checks[0]).id,
            outcome: present(completed.submitted.report.checks[0]).outcome,
            evidenceAvailable: true,
          },
        ],
        model: { state: "not_applicable" },
      });
    }
    expect(baseline.resultId).not.toBe(candidate.resultId);
    const report = reportFor(inputs);
    expect(report.baseline.quality.checkAgreement.value).toBe(1);
    expect(report.candidate.quality.checkAgreement.value).toBe(0);
    expect(report.paired.criteria.regressed).toBe(1);
  });

  it("does not replace the queued candidate with the baseline's completed result", async () => {
    const value = fixture();
    const baseline = complete(value);
    const candidate = selected(value, "candidate");
    expect(getJobAdmissionRecord(value.database, candidate.jobId)?.state).toBe("admitted");
    const { coordinator } = evidenceCoordinator(value);
    const { inputs, proof } = await verified(value, coordinator);
    expect(observation(inputs, baseline.cell.id).result?.resultId).toBe(baseline.resultId);
    expect(observation(inputs, candidate.id)).toMatchObject({
      arm: "candidate",
      cellId: candidate.id,
      runId: candidate.run_id,
      requestId: candidate.request_id,
      executionState: "queued",
      result: null,
      checks: [],
      model: { state: "not_applicable" },
    });
    expect(proof.cells.find((cell) => cell.cellId === candidate.id)).toMatchObject({
      jobId: candidate.jobId,
      resultId: null,
      verification: null,
    });
    expect(present(inputs.frozen.plan.cases[0]).candidateBinding.cellId).toBe(candidate.id);
    const report = reportFor(inputs);
    expect(report.candidate.coverage).toMatchObject({
      applicableCases: 1,
      completedCases: 0,
      checks: { numerator: 0, denominator: 1, value: 0 },
    });
    expect(
      value.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 1 });
  });

  it("does not trust stored evidence metadata or omitted cell facts", async () => {
    const value = fixture();
    const baseline = complete(value);
    const candidate = complete(value, selected(value, "candidate"));
    const without = capture(value);
    expect(
      without.observations.every((entry) =>
        entry.checks.every((check) => !check.evidenceAvailable),
      ),
    ).toBe(true);
    expect(observation(without, baseline.cell.id).checks[0]?.outcome).toBe("failed");
    expect(
      value.database
        .prepare("SELECT evidence_complete FROM validation_job_results WHERE id = ?")
        .get(baseline.resultId),
    ).toEqual({ evidence_complete: 1 });
    const { coordinator } = evidenceCoordinator(value);
    const proof = await coordinator.prepareEvaluationBatchReadEvidence(
      scopeFor(value),
      new AbortController().signal,
    );
    const facts = factsFor(value, coordinator, proof);
    facts.cells.delete(baseline.cell.id);
    const partial = capture(value, facts);
    expect(observation(partial, baseline.cell.id).checks[0]).toMatchObject({
      outcome: "failed",
      evidenceAvailable: false,
    });
    expect(observation(partial, candidate.cell.id).checks[0]).toMatchObject({
      outcome: "failed",
      evidenceAvailable: true,
    });
    const report = reportFor(partial);
    expect(report.baseline.coverage.scoredCriteria).toBe(0);
    expect(present(report.cases[0]).baseline.criteria[0]).toMatchObject({
      state: "unavailable",
      actualOutcome: "failed",
    });
  });

  it("does not reuse the other arm's verified profile status", async () => {
    const value = fixture();
    const baseline = complete(value);
    const candidate = complete(value, selected(value, "candidate"));
    const { coordinator } = evidenceCoordinator(value);
    const proof = await coordinator.prepareEvaluationBatchReadEvidence(
      scopeFor(value),
      new AbortController().signal,
    );
    const facts = factsFor(value, coordinator, proof);
    const baselineFacts = present(facts.cells.get(baseline.cell.id));
    facts.cells.set(baseline.cell.id, {
      ...baselineFacts,
      profiles: [...present(facts.cells.get(candidate.cell.id)).profiles],
    });
    const inputs = capture(value, facts);
    expect(facts.assertCurrent).toHaveBeenCalledOnce();
    expect(observation(inputs, baseline.cell.id).checks[0]).toMatchObject({
      outcome: "failed",
      evidenceAvailable: false,
    });
    expect(observation(inputs, candidate.cell.id).checks[0]).toMatchObject({
      outcome: "failed",
      evidenceAvailable: true,
    });
  });

  it("uses frozen profile-only requirements even when historical V1 advice normalizes to a completed model summary", async () => {
    const value = fixture();
    const cell = selected(value),
      body = resultFor(cell);
    if (body.report.workItemKind !== "issue")
      throw new Error("The fixture requires Issue validation.");
    body.report.modelSummary = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "issue",
      summary: "Synthetic optional advice does not make the model dimension required.",
      reproductionConclusion: "inconclusive",
      observations: [
        {
          id: "optional-observation",
          title: "Compiler failure",
          body: "The known failure was observed.",
          priority: 1,
          path: "src/example.ts",
          line: 7,
        },
      ],
    };
    insertHistoricalEvaluationResult(value.database, cell, beginAttempt(value, cell), body);
    const { coordinator } = evidenceCoordinator(value);
    const { inputs } = await verified(value, coordinator);
    expect(body.modelReview.state).toBe("not_requested");
    expect(observation(inputs, cell.id).model).toEqual({
      state: "not_applicable",
      reason: "Model review is not required by this frozen configuration.",
    });
    expect(reportFor(inputs).baseline.coverage.models).toEqual({
      numerator: 0,
      denominator: 0,
      value: null,
    });
  });

  it.each(["modified", "unknown"] as const)(
    "retains actual %s source state and check outcomes while withholding a quality score",
    async (sourceState) => {
      const value = fixture();
      const cell = selected(value),
        body = resultFor(cell);
      body.report.sourceState = sourceState;
      complete(value, cell, body);
      const { coordinator } = evidenceCoordinator(value);
      const { inputs } = await verified(value, coordinator);
      expect(observation(inputs, cell.id)).toMatchObject({
        sourceState,
        executionState: "completed",
        checks: [{ outcome: "failed", evidenceAvailable: true }],
      });
      const report = reportFor(inputs);
      expect(present(report.cases[0]).baseline.criteria[0]).toMatchObject({
        state: "unavailable",
        reason: "Original source was not verified.",
      });
      expect(report.baseline.quality.checkAgreement.value).toBeNull();
      expect(report.baseline.coverage).toMatchObject({ applicableCriteria: 1, scoredCriteria: 0 });
    },
  );

  it("does not count frozen summary input without a completed CLI result", async () => {
    const value = createValidationModelResultBindingFixture();
    fixtures.push(value);
    const { coordinator } = evidenceCoordinator(value);
    const { inputs } = await verified(value, coordinator);
    const observed = observation(inputs, value.cell.id);
    expect(observed).toMatchObject({ result: null, checks: [], model: { state: "not_run" } });
    expect(observed.model).not.toHaveProperty("cli");
    expect(reportFor(inputs).baseline.coverage.models).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    expect(
      value.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });
  it("scores a completed model result with its Worker CLI metadata", async () => {
    const value = createValidationModelResultBindingFixture();
    fixtures.push(value);
    const stored = completeValidationModelResultFixture(value);
    const { coordinator } = evidenceCoordinator(value);
    const { inputs } = await verified(value, coordinator);
    expect(observation(inputs, value.cell.id)).toMatchObject({
      executionState: "completed",
      result: { resultId: stored.resultId, resultDigest: stored.resultDigest },
      model: {
        state: "complete",
        evidenceAvailable: true,
        cli: value.cli,
      },
    });
    expect(reportFor(inputs).baseline.coverage.models).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    const candidate = value.cells.find((cell) => cell.arm === "candidate");
    if (!candidate) throw new Error("The synthetic candidate cell is missing.");
    expect(observation(inputs, candidate.id).model).toMatchObject({ state: "not_run" });
  });

  it("keeps unexecuted model cells available without inventing CLI metadata or a result", async () => {
    const value = unexecutedFixture("pull_request");
    const { coordinator } = evidenceCoordinator(value);
    const { inputs } = await verified(value, coordinator);
    const applicable = present(
      inputs.frozen.plan.cases.find((entry) => entry.applicability.state === "applicable"),
    );
    for (const arm of ["baseline", "candidate"] as const) {
      const entry = observation(inputs, applicable[`${arm}Binding`].cellId);
      expect(entry).toMatchObject({
        executionState: "not_run",
        result: null,
        checks: [],
        model: { state: "not_run" },
      });
      expect(entry.model).not.toHaveProperty("cli");
      expect(reportFor(inputs)[arm].coverage.models).toEqual({
        numerator: 0,
        denominator: 1,
        value: 0,
      });
    }
    expect(
      value.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
    expect(value.database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
  });
});

describe("evaluation observation proof and digest binding", () => {
  it("keeps input digests stable across read times and changes them when current evidence changes", async () => {
    const value = fixture();
    complete(value);
    const { coordinator } = evidenceCoordinator(value);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2030-01-01T00:00:00.000Z");
    const first = (await verified(value, coordinator)).inputs;
    vi.setSystemTime("2031-02-03T04:05:06.000Z");
    const second = (await verified(value, coordinator)).inputs;
    expect(second.selectionDigest).toBe(first.selectionDigest);
    expect(second.observationDigest).toBe(first.observationDigest);
    expect(second.adjudicationDigest).toBe(first.adjudicationDigest);
    expect(second.inputDigest).toBe(first.inputDigest);
    expect(canonicalJson(second.observations)).not.toContain("2031-02-03");
    const unavailable = capture(value);
    expect(unavailable.selectionDigest).toBe(first.selectionDigest);
    expect(unavailable.observationDigest).not.toBe(first.observationDigest);
    expect(unavailable.inputDigest).not.toBe(first.inputDigest);
  });

  it("includes observed source, check outcome and evidence state in the digest rather than just the selection", () => {
    const value = fixture();
    const completed = complete(value);
    const inputs = capture(value);
    const digest = (observations: readonly C.EvaluationOwnerObservation[]) =>
      evaluationScoreInputDigest({
        ...scopeFor(value),
        scorerVersion: EVALUATION_SCORING_RULES_VERSION,
        scoringPlanDigest: inputs.frozen.digest,
        observationDigest: sha256(canonicalJson(observations)),
        adjudicationDigest: inputs.adjudicationDigest,
      });
    expect(digest(inputs.observations)).toBe(inputs.inputDigest);
    const changes: ((entry: C.EvaluationOwnerObservation) => void)[] = [
      (entry) => {
        entry.sourceState = "modified";
      },
      (entry) => {
        present(entry.checks[0]).outcome = "passed";
      },
      (entry) => {
        present(entry.checks[0]).evidenceAvailable = true;
      },
    ];
    for (const change of changes) {
      // Pure digest variants do not overwrite an immutable result or claim owner-verified facts.
      const observations = structuredClone(inputs.observations);
      change(present(observations.find((entry) => entry.cellId === completed.cell.id)));
      expect(digest(observations)).not.toBe(inputs.inputDigest);
    }
    expect(capture(value).inputDigest).toBe(inputs.inputDigest);
  });

  it.each(["forged", "foreign_coordinator", "expired"] as const)(
    "rejects a %s prepared token before accepting profile statuses",
    async (kind) => {
      const value = fixture();
      complete(value);
      const { coordinator } = evidenceCoordinator(value);
      const proof = await coordinator.prepareEvaluationBatchReadEvidence(
        scopeFor(value),
        new AbortController().signal,
      );
      const selectedCoordinator =
        kind === "foreign_coordinator" ? evidenceCoordinator(value).coordinator : coordinator;
      const selectedProof =
        kind === "forged" ? { ...proof, prepared: { kind: "prepared_evidence" as const } } : proof;
      const facts = factsFor(value, selectedCoordinator, selectedProof);
      if (kind === "expired") await immediate();
      expect(() => capture(value, facts)).toThrow(
        expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
      );
      expect(facts.assertCurrent).toHaveBeenCalledOnce();
      expect(value.database.isTransaction).toBe(false);
    },
  );

  it("rejects a real candidate completion that changes selection after preflight", async () => {
    const value = fixture();
    complete(value);
    const { coordinator } = evidenceCoordinator(value);
    const proof = await coordinator.prepareEvaluationBatchReadEvidence(
      scopeFor(value),
      new AbortController().signal,
    );
    const facts = factsFor(value, coordinator, proof);
    complete(value, selected(value, "candidate"));
    expect(() => capture(value, facts)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_VERIFIER_UNAVAILABLE" }),
    );
    const fresh = await verified(value, coordinator);
    expect(fresh.inputs.selectionDigest).not.toBe(proof.selectionDigest);
    expect(fresh.inputs.observations.every((entry) => entry.executionState === "completed")).toBe(
      true,
    );
  });

  it("rejects a foreign batch's prepared selection and an extra cell facts entry", async () => {
    const value = fixture();
    complete(value);
    const other = value.create({
      ...value.input,
      request: {
        ...value.input.request,
        mode: "profile_only",
        changeId: "another-observation-batch",
      },
    });
    const { coordinator } = evidenceCoordinator(value);
    const proof = await coordinator.prepareEvaluationBatchReadEvidence(
      { repositoryId: value.repositoryId, evaluationId: other.id },
      new AbortController().signal,
    );
    const facts = factsFor(value, coordinator, proof);
    expect(() => capture(value, facts)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
    );
    const current = await coordinator.prepareEvaluationBatchReadEvidence(
      scopeFor(value),
      new AbortController().signal,
    );
    const extra = factsFor(value, coordinator, current);
    extra.cells.set("foreign-cell", present(extra.cells.values().next().value));
    expect(() => capture(value, extra)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
  });

  it("checks current read permission before consuming prepared evidence and requires the owner's transaction", async () => {
    const value = fixture();
    complete(value);
    expect(() =>
      captureEvaluationScoreInputsInTransaction(
        value.database,
        scopeFor(value),
        evaluationActor,
        administrators,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    const { coordinator } = evidenceCoordinator(value);
    const proof = await coordinator.prepareEvaluationBatchReadEvidence(
      scopeFor(value),
      new AbortController().signal,
    );
    const facts = factsFor(value, coordinator, proof);
    setEvaluationManagementRole(value.database, value.repositoryId, null, 1);
    expect(() => capture(value, facts)).toThrow(
      expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
    );
    expect(facts.assertCurrent).not.toHaveBeenCalled();
    expect(value.database.isTransaction).toBe(false);
  });

  it("verifies uploaded V2 log bytes and downgrades tampered evidence without changing the result outcome", async () => {
    const value = fixture();
    const uploaded = await completeWithLog(value);
    complete(value, selected(value, "candidate"));
    const verifiedRead = await verified(value, uploaded.coordinator);
    expect(verifiedRead.proof.cells.every((cell) => cell.verification?.status === "verified")).toBe(
      true,
    );
    const before = observation(verifiedRead.inputs, uploaded.cell.id);
    expect(before.checks[0]).toMatchObject({ outcome: "failed", evidenceAvailable: true });
    expect(reportFor(verifiedRead.inputs).baseline.quality.checkAgreement.value).toBe(1);
    // This exact file belongs to the real upload API in this test's isolated temporary directory.
    chmodSync(uploaded.assetPath, 0o600);
    writeFileSync(uploaded.assetPath, Buffer.alloc(uploaded.bytes.length, 0x78));
    chmodSync(uploaded.assetPath, 0o400);
    expect(readFileSync(uploaded.assetPath)).toHaveLength(uploaded.bytes.length);
    expect(readFileSync(uploaded.assetPath)).not.toEqual(uploaded.bytes);
    const changed = await verified(value, uploaded.coordinator);
    expect(
      changed.proof.cells.find((cell) => cell.cellId === uploaded.cell.id)?.verification?.status,
    ).toBe("unavailable");
    const after = observation(changed.inputs, uploaded.cell.id);
    expect(after.result).toEqual(before.result);
    expect(after.checks[0]).toMatchObject({ outcome: "failed", evidenceAvailable: false });
    expect(changed.inputs.selectionDigest).toBe(verifiedRead.inputs.selectionDigest);
    expect(changed.inputs.inputDigest).not.toBe(verifiedRead.inputs.inputDigest);
    expect(reportFor(changed.inputs).baseline.quality.checkAgreement.value).toBeNull();
    expect(
      observation(changed.inputs, selected(value, "candidate").id).checks[0]?.evidenceAvailable,
    ).toBe(true);
    expect(
      value.database
        .prepare("SELECT result_json, evidence_complete FROM validation_job_results WHERE id = ?")
        .get(uploaded.resultId),
    ).toEqual({ result_json: canonicalJson(uploaded.submitted), evidence_complete: 1 });
  });
});
