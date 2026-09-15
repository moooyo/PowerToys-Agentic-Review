import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationLoopRoundV1,
  type InvestigationPrDiffManifestV1,
  type InvestigationResultV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";

import {
  applyInvestigationLoopRound,
  applyInvestigationRuntimeCheckpoint,
  applyInvestigationSourceCoverage,
  createInvestigationCheckpoint,
  evaluateInvestigationCompletion,
  increaseInvestigationBudget,
  interruptInvestigationLoop,
  investigationContentDigest,
  normalizeInvestigationAnalysisPlanReferences,
  restoreCompletedInvestigationForDelivery,
  restoreInvestigationCheckpoint,
} from "./investigation-loop.js";

const recordedAt = "2026-09-15T04:00:00.000Z";
const options = { recordedAt, usage: { durationMs: 10, tokens: 100, reportBytes: 1_000 } };

function proposedAnalysis(result: InvestigationResultV1): InvestigationAnalysisV1 {
  return {
    schemaVersion: "InvestigationAnalysisV1",
    summary: result.report.summary,
    coverage: structuredClone(result.report.coverage),
    findings: structuredClone(result.findings),
    assessment: structuredClone(result.assessment),
    candidates: structuredClone(result.report.loop.candidates),
    rechecks: [],
    evidence: result.verificationEvidence
      .filter(
        (entry) => entry.source === "static_analysis" || entry.source === "reporter_statement",
      )
      .map((entry) => ({
        id: entry.id,
        subjectRef: entry.subjectRef,
        source: entry.source as "static_analysis" | "reporter_statement",
        summary: entry.summary,
        evidenceRefs: entry.evidenceRefs,
      })),
    plans: result.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...plan }) =>
        structuredClone(plan),
    ),
    nextActions: result.nextActions.map(({ state: _state, sourceReportRef: _source, ...action }) =>
      structuredClone(action),
    ),
    feedbackDrafts: structuredClone(result.feedbackDrafts),
    diagnostics: structuredClone(result.diagnostics),
    limitations: structuredClone(result.report.limitations),
  };
}

function round(
  checkpoint: InvestigationLoopCheckpointV1,
  analysis: InvestigationAnalysisV1,
  phase: InvestigationLoopRoundV1["phase"] = "discovery",
): InvestigationLoopRoundV1 {
  return {
    schemaVersion: "InvestigationLoopRoundV1",
    taskId: checkpoint.taskId,
    attemptId: checkpoint.attemptId,
    inputCheckpointRef: {
      id: checkpoint.id,
      version: checkpoint.version,
      digest: checkpoint.digest,
    },
    round: checkpoint.round + 1,
    phase,
    analysis,
    continue: false,
    continuationReason: "Submit the complete accepted analysis for completion checks.",
  };
}

function setup(count = 1) {
  const fixture = createInvestigationFixture("pr", { findingCount: count });
  const checkpoint = createInvestigationCheckpoint({
    task: fixture.task,
    attemptId: fixture.attempt.id,
    checkpointId: "checkpoint",
    leaseVersion: 1,
    recordedAt,
  });
  return { ...fixture, checkpoint, analysis: proposedAnalysis(fixture.result) };
}

function finalAnalysis(
  result: InvestigationResultV1,
  analysis: InvestigationAnalysisV1,
  roundNumber: number,
) {
  const next = structuredClone(analysis);
  next.rechecks = result.report.recheck.records.map((entry) => ({ ...entry, round: roundNumber }));
  return next;
}

describe("complete investigation loop", () => {
  it("retains every finding in a report larger than 100 entries", () => {
    const { checkpoint, analysis, result } = setup(137);
    const discovered = applyInvestigationLoopRound(
      checkpoint,
      round(checkpoint, analysis),
      options,
    );
    expect(discovered.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(discovered).pendingFindingIds).toHaveLength(137);
    const final = applyInvestigationLoopRound(
      discovered,
      round(discovered, finalAnalysis(result, analysis, 2), "finalize"),
      options,
    );
    expect(final.stopReason).toBe("complete");
    expect(final.analysis.findings).toHaveLength(137);
    expect(final.analysis.candidates).toHaveLength(137);
    expect(evaluateInvestigationCompletion(final).complete).toBe(true);
  });

  it("does not consider continue false or a fixed third round sufficient", () => {
    const { checkpoint, analysis } = setup();
    let current = checkpoint;
    for (let index = 0; index < 3; index += 1)
      current = applyInvestigationLoopRound(
        current,
        round(current, analysis, "investigation"),
        options,
      );
    expect(current.round).toBe(3);
    expect(current.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(current).reasonCodes).toContain(
      "final_version_rechecks_pending",
    );
  });

  it("requires an investigation phase before a zero-finding result may finalize", () => {
    const { checkpoint, analysis } = setup(0);
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis, "finalize"), options),
    ).toThrow("initial round must investigate");
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    expect(
      applyInvestigationLoopRound(first, round(first, analysis, "finalize"), options).stopReason,
    ).toBe("complete");
  });

  it("keeps new candidates discovered during final review as pending work", () => {
    const { checkpoint, analysis, result } = setup();
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const final = finalAnalysis(result, analysis, 2);
    final.candidates.push({
      id: "new-candidate",
      subjectRef: result.assessment.subjectRef,
      title: "New issue discovered during recheck",
      discoveredRound: 2,
      status: "pending",
      findingId: null,
      findingVersion: null,
      mergedIntoCandidateId: null,
      rationale: "The newly identified caller has not been investigated.",
      evidenceRefs: [],
    });
    const second = applyInvestigationLoopRound(first, round(first, final, "finalize"), options);
    expect(second.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(second).pendingCandidateIds).toEqual(["new-candidate"]);
  });

  it("invalidates old rechecks when finding content advances to a new version", () => {
    const { checkpoint, analysis, result } = setup();
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const review = applyInvestigationLoopRound(
      first,
      round(first, finalAnalysis(result, analysis, 2), "recheck"),
      options,
    );
    const changed = structuredClone(review.analysis);
    changed.findings[0]!.version = 2;
    changed.findings[0]!.priority = "P0";
    changed.candidates[0]!.findingVersion = 2;
    const third = applyInvestigationLoopRound(review, round(review, changed, "finalize"), options);
    expect(third.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(third).pendingFindingIds).toEqual([
      changed.findings[0]!.id,
    ]);
  });

  it("requires confirmation evidence as well as final-version recheck evidence", () => {
    const { checkpoint, analysis, result } = setup();
    analysis.findings[0]!.confirmation.evidenceRefs = [];
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const second = applyInvestigationLoopRound(
      first,
      round(first, finalAnalysis(result, analysis, 2), "finalize"),
      options,
    );
    expect(second.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(second).pendingFindingIds).toEqual([
      analysis.findings[0]!.id,
    ]);
  });

  it("rejects same-version finding edits without mutating the accepted checkpoint", () => {
    const { checkpoint, analysis } = setup();
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const snapshot = structuredClone(first);
    const changed = structuredClone(analysis);
    changed.findings[0]!.title = "Rewritten content";
    expect(() => applyInvestigationLoopRound(first, round(first, changed), options)).toThrow(
      "requires a new content version",
    );
    expect(first).toEqual(snapshot);
  });

  it("refuses to truncate candidate or coverage ledgers", () => {
    const { checkpoint, analysis } = setup(137);
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const truncated = structuredClone(analysis);
    truncated.candidates = truncated.candidates.slice(0, 100);
    expect(() => applyInvestigationLoopRound(first, round(first, truncated), options)).toThrow(
      "ledger cannot discard",
    );
    const narrowed = structuredClone(analysis);
    narrowed.coverage.includedUnits.pop();
    expect(() => applyInvestigationLoopRound(first, round(first, narrowed), options)).toThrow(
      "cannot be removed",
    );
  });

  it("records withdrawn candidates while requiring all retained findings to be rechecked", () => {
    const { checkpoint, analysis, result } = setup(2);
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const revised = finalAnalysis(result, analysis, 2);
    revised.candidates[1]!.status = "withdrawn";
    revised.candidates[1]!.rationale =
      "Reinspection establishes this candidate as expected behavior.";
    revised.findings.pop();
    revised.rechecks.pop();
    const second = applyInvestigationLoopRound(first, round(first, revised, "finalize"), options);
    expect(second.stopReason).toBe("complete");
    expect(second.analysis.candidates).toHaveLength(2);
    expect(second.analysis.findings).toHaveLength(1);
  });

  it("rejects cyclic candidate merging", () => {
    const { checkpoint, analysis } = setup(2);
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const merged = structuredClone(analysis);
    merged.findings = [];
    merged.candidates[0]!.status = "merged";
    merged.candidates[0]!.mergedIntoCandidateId = merged.candidates[1]!.id;
    merged.candidates[1]!.status = "merged";
    merged.candidates[1]!.mergedIntoCandidateId = merged.candidates[0]!.id;
    expect(() => applyInvestigationLoopRound(first, round(first, merged), options)).toThrow(
      "cannot contain a cycle",
    );
  });

  it("preserves every accepted finding when a budget is exhausted", () => {
    const { task, attempt, analysis } = setup(137);
    task.budget.maxRounds = 1;
    const checkpoint = createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "budget-checkpoint",
      leaseVersion: 1,
      recordedAt,
    });
    const exhausted = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    expect(exhausted.stopReason).toBe("budget_exhausted");
    expect(evaluateInvestigationCompletion(exhausted).complete).toBe(false);
    expect(exhausted.analysis.findings).toHaveLength(137);
    expect(() =>
      restoreInvestigationCheckpoint({
        checkpoint: exhausted,
        task,
        attemptId: "attempt-2",
        leaseVersion: 2,
        recordedAt,
      }),
    ).toThrow("budget is exhausted");
  });

  it("does not claim completion when a final report exceeds the byte budget", () => {
    const { task, attempt, analysis, result } = setup();
    const normalized = normalizeInvestigationAnalysisPlanReferences(analysis);
    task.budget.maxReportBytes = Buffer.byteLength(JSON.stringify(normalized)) + 300;
    const checkpoint = createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "byte-checkpoint",
      leaseVersion: 1,
      recordedAt,
    });
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), {
      ...options,
      usage: { ...options.usage, reportBytes: 0 },
    });
    expect(first.stopReason).toBe("continuing");
    const final = applyInvestigationLoopRound(
      first,
      round(first, finalAnalysis(result, analysis, 2), "finalize"),
      { ...options, usage: { ...options.usage, reportBytes: 0 } },
    );
    expect(final.stopReason).toBe("budget_exhausted");
    expect(final.analysis.findings).toHaveLength(1);
  });

  it("preserves accepted execution receipts across an interrupted attempt", () => {
    const { checkpoint, task, result } = setup();
    const runtime = structuredClone(checkpoint.runtime);
    const started = {
      taskId: task.id,
      attemptId: checkpoint.attemptId,
      planRef: { id: result.plans[0]!.id, version: 1, digest: result.plans[0]!.digest },
      subjectRef: task.subjectRef,
      subjectRevisionKey: checkpoint.subjectRevisionKey,
      stepId: "frozen-step",
      stepDigest: "f".repeat(64),
    };
    runtime.startedSteps.push(started);
    const acceptedStart = applyInvestigationRuntimeCheckpoint(checkpoint, runtime, { recordedAt });
    runtime.completedStepIds.push(started.stepId);
    runtime.completedSteps.push({
      ...started,
      outcome: "completed",
      validation: { checks: [], summary: "Synthetic step receipt." },
      verificationEvidence: [],
      artifacts: [],
      diagnostics: [],
      subjects: [],
      modelUsage: { tokens: 100, durationMs: 20 },
    });
    const completed = applyInvestigationRuntimeCheckpoint(acceptedStart, runtime, { recordedAt });
    expect(completed.consumed.tokens).toBe(100);
    expect(completed.consumed.durationMs).toBe(20);
    const replayed = applyInvestigationRuntimeCheckpoint(completed, runtime, { recordedAt });
    expect(replayed.consumed.tokens).toBe(100);
    expect(replayed.consumed.durationMs).toBe(20);
    const serverTimed = applyInvestigationRuntimeCheckpoint(acceptedStart, runtime, {
      recordedAt,
      durationMs: 50,
    });
    expect(serverTimed.consumed.durationMs).toBe(50);
    const restored = restoreInvestigationCheckpoint({
      checkpoint: interruptInvestigationLoop(completed, "interrupted"),
      task,
      attemptId: "attempt-2",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.runtime.completedStepIds).toEqual([started.stepId]);
    const forgotten = structuredClone(restored.runtime);
    forgotten.completedSteps = [];
    forgotten.completedStepIds = [];
    expect(() => applyInvestigationRuntimeCheckpoint(restored, forgotten, { recordedAt })).toThrow(
      "ledger cannot discard",
    );
  });

  it("normalizes only same-version in-round plan references using trusted canonical content", () => {
    const { analysis } = setup();
    const normalized = normalizeInvestigationAnalysisPlanReferences(analysis);
    expect(normalized.findings[0]!.fixRecommendation.planRef?.digest).toBe(
      investigationContentDigest(normalized.plans[0]),
    );
    expect(normalized.nextActions[0]!.planRef?.digest).toBe(
      investigationContentDigest(normalized.plans[0]),
    );
    const originalRef = analysis.findings[0]!.fixRecommendation.planRef!;
    analysis.plans[0]!.version += 1;
    expect(
      normalizeInvestigationAnalysisPlanReferences(analysis).findings[0]!.fixRecommendation.planRef,
    ).toEqual(originalRef);
  });

  it("restores accepted work on a new attempt while preserving consumption and previous identity", () => {
    const { checkpoint, task, analysis } = setup();
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const interrupted = interruptInvestigationLoop(first, "interrupted");
    const restored = restoreInvestigationCheckpoint({
      checkpoint: interrupted,
      task,
      attemptId: "attempt-2",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.consumed).toEqual(first.consumed);
    expect(restored.analysis).toEqual(first.analysis);
    expect(restored.adoptedAttemptIds).toEqual([first.attemptId, "attempt-2"]);
    expect(restored.previousCheckpointRef?.digest).toBe(interrupted.digest);
    expect(() => applyInvestigationLoopRound(restored, round(first, analysis), options)).toThrow(
      "active task and attempt",
    );
  });

  it("recovers delivery of a complete checkpoint without restarting analysis or execution", () => {
    const { checkpoint, task, analysis, result } = setup();
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const completed = applyInvestigationLoopRound(
      first,
      round(first, finalAnalysis(result, analysis, 2), "finalize"),
      options,
    );
    const recovered = restoreCompletedInvestigationForDelivery({
      checkpoint: completed,
      task,
      attemptId: "delivery-attempt",
      leaseVersion: 2,
      recordedAt,
    });
    expect(recovered.stopReason).toBe("complete");
    expect(recovered.analysis).toEqual(completed.analysis);
    expect(recovered.runtime).toEqual(completed.runtime);
    expect(recovered.consumed).toEqual(completed.consumed);
    expect(recovered.adoptedAttemptIds).toContain("delivery-attempt");
    expect(() =>
      applyInvestigationLoopRound(
        recovered,
        round(recovered, recovered.analysis, "finalize"),
        options,
      ),
    ).toThrow("stopped loop");
    expect(() =>
      applyInvestigationRuntimeCheckpoint(recovered, recovered.runtime, { recordedAt }),
    ).toThrow("active investigation attempt");
  });

  it("accounts for trusted runtime and interruption duration before the first model round", () => {
    const { checkpoint } = setup();
    const observed = applyInvestigationRuntimeCheckpoint(checkpoint, checkpoint.runtime, {
      recordedAt,
      durationMs: 70,
    });
    const interrupted = interruptInvestigationLoop(observed, "cancelled", recordedAt, [], 30);
    expect(interrupted.consumed.durationMs).toBe(100);
    expect(interrupted.consumed.rounds).toBe(0);
    expect(interrupted.stopReason).toBe("cancelled");
  });

  it("rejects altered frozen source, execution authorization, or content digest on resume", () => {
    const { checkpoint, task } = setup();
    const interrupted = interruptInvestigationLoop(checkpoint, "interrupted");
    const changed = structuredClone(task);
    changed.executionPolicy.allowRepositoryExecution = true;
    expect(() =>
      restoreInvestigationCheckpoint({
        checkpoint: interrupted,
        task: changed,
        attemptId: "attempt-2",
        leaseVersion: 2,
        recordedAt,
      }),
    ).toThrow("identical frozen scope");
    const corrupted = structuredClone(interrupted);
    corrupted.analysis.summary = "Unaccepted local state";
    expect(() =>
      restoreInvestigationCheckpoint({
        checkpoint: corrupted,
        task,
        attemptId: "attempt-2",
        leaseVersion: 2,
        recordedAt,
      }),
    ).toThrow("does not match its digest");
  });

  it("resumes after an explicit monotonic budget increase without losing accepted findings", () => {
    const { task, attempt, analysis } = setup(137);
    task.budget.maxRounds = 1;
    const checkpoint = createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "budget-extension",
      leaseVersion: 1,
      recordedAt,
    });
    const exhausted = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const revised = increaseInvestigationBudget(
      exhausted,
      task,
      { ...task.budget, maxRounds: 4 },
      { recordedAt },
    );
    const restored = restoreInvestigationCheckpoint({
      checkpoint: revised.checkpoint,
      task: revised.task,
      attemptId: "extended-attempt",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.analysis).toEqual(exhausted.analysis);
    expect(restored.runtime).toEqual(exhausted.runtime);
    expect(restored.consumed).toEqual(exhausted.consumed);
    expect(restored.budget.maxRounds).toBe(4);
    expect(restored.analysis.findings).toHaveLength(137);
    const directlyRevisedTask = { ...task, budget: { ...task.budget, maxRounds: 4 } };
    expect(
      restoreInvestigationCheckpoint({
        checkpoint: exhausted,
        task: directlyRevisedTask,
        attemptId: "direct-extension",
        leaseVersion: 2,
        recordedAt,
      }).budget.maxRounds,
    ).toBe(4);
    expect(() =>
      increaseInvestigationBudget(
        exhausted,
        task,
        { ...task.budget, maxTokens: task.budget.maxTokens - 1 },
        { recordedAt },
      ),
    ).toThrow("cannot decrease");
    const changedScope = structuredClone(directlyRevisedTask);
    changedScope.scope.includedUnits[0]!.requiredWork = "A narrower task";
    expect(() =>
      restoreInvestigationCheckpoint({
        checkpoint: exhausted,
        task: changedScope,
        attemptId: "bad-extension",
        leaseVersion: 2,
        recordedAt,
      }),
    ).toThrow("identical frozen scope");
  });

  it("accounts for diagnostic growth in an interrupted report before allowing resume", () => {
    const { task, attempt } = setup();
    task.budget.maxReportBytes = 2_000;
    const checkpoint = createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "diagnostic-budget",
      leaseVersion: 1,
      recordedAt,
    });
    const interrupted = interruptInvestigationLoop(checkpoint, "interrupted", recordedAt, [
      {
        id: "large-diagnostic",
        code: "MODEL_PROTOCOL_ERROR",
        category: "error",
        message: "diagnostic ".repeat(2_000),
        retryable: true,
        evidenceRefs: [],
        prerequisiteRefs: [],
      },
    ]);
    expect(interrupted.stopReason).toBe("budget_exhausted");
    expect(interrupted.consumed.reportBytes).toBeGreaterThan(task.budget.maxReportBytes);
    expect(interrupted.analysis.diagnostics[0]!.message.length).toBeGreaterThan(2_000);
    expect(() =>
      restoreInvestigationCheckpoint({
        checkpoint: interrupted,
        task,
        attemptId: "blocked-resume",
        leaseVersion: 2,
        recordedAt,
      }),
    ).toThrow("budget is exhausted");
  });

  it("computes canonical digests independent of object key order", () => {
    expect(investigationContentDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      investigationContentDigest({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(investigationContentDigest(["first", "second"])).not.toBe(
      investigationContentDigest(["second", "first"]),
    );
  });
});

function setupSourceCoverage(fileCount = 1) {
  const { task, attempt } = createInvestigationFixture("pr", { findingCount: 0 });
  const subject = task.subjects[0]!;
  if (subject.kind !== "original_pr") throw new Error("PR fixture must have an original subject.");
  task.scope.includedUnits = [
    {
      id: "complete-diff",
      subjectRef: subject.id,
      kind: "full_diff",
      paths: [],
      requiredWork: "Investigate every changed file and its complete content.",
      status: "pending",
      evidenceRefs: [],
    },
  ];
  task.scope.completedUnitRefs = [];
  task.scope.unresolvedUnitRefs = ["complete-diff"];
  const chunks: InvestigationPrDiffManifestV1["chunks"] = [];
  const files: InvestigationPrDiffManifestV1["files"] = [];
  for (let index = 0; index < fileCount; index += 1) {
    const path = `src/file-${index}.ts`;
    const fileChunks = (["diff", "base", "head"] as const).map((kind) => ({
      id: `chunk-${index}-${kind}`,
      path,
      kind,
      ordinal: 0,
      encoding: "utf8" as const,
      contentDigest: "a".repeat(64),
      byteLength: 100,
    }));
    chunks.push(...fileChunks);
    files.push({
      path,
      previousPath: null,
      status: "modified",
      chunkIds: fileChunks.map((chunk) => chunk.id),
    });
  }
  const payload = {
    schemaVersion: "InvestigationPrDiffManifestV1" as const,
    subjectRef: subject.id,
    baseSha: subject.baseSha,
    headSha: subject.headSha,
    mergeBaseSha: subject.baseSha,
    files,
    chunks,
  };
  const manifest: InvestigationPrDiffManifestV1 = {
    ...payload,
    digest: investigationContentDigest(payload),
  };
  const initial = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "source-checkpoint",
    leaseVersion: 1,
    recordedAt,
  });
  const checkpoint = applyInvestigationSourceCoverage(initial, manifest, { task, recordedAt });
  return { task, attempt, initial, checkpoint, manifest };
}

function sourceRoundAnalysis(
  checkpoint: InvestigationLoopCheckpointV1,
  completedIds: readonly string[],
  fullDiffComplete = false,
): InvestigationAnalysisV1 {
  const analysis = structuredClone(checkpoint.analysis);
  for (const unit of analysis.coverage.includedUnits) {
    if (completedIds.includes(unit.id) || (unit.kind === "full_diff" && fullDiffComplete))
      unit.status = "completed";
  }
  analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits
    .filter((unit) => unit.status === "completed")
    .map((unit) => unit.id);
  analysis.coverage.unresolvedUnitRefs = analysis.coverage.includedUnits
    .filter((unit) => unit.status !== "completed")
    .map((unit) => unit.id);
  return analysis;
}

describe("trusted complete PR source coverage", () => {
  it("registers every chunk and rejects completion based on only the first batch", () => {
    const { checkpoint, manifest } = setupSourceCoverage(47);
    expect(manifest.chunks).toHaveLength(141);
    expect(checkpoint.analysis.coverage.includedUnits).toHaveLength(142);
    expect(checkpoint.runtime.sourceCoverage?.brokeredUnitIds).toEqual([]);
    const allIds = manifest.chunks.map((chunk) => chunk.id);
    const allClaimed = sourceRoundAnalysis(checkpoint, allIds, true);
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, allClaimed), {
        ...options,
        sourceUnitIds: allIds.slice(0, 50),
      }),
    ).toThrow("before it was delivered");
    const firstBatch = sourceRoundAnalysis(checkpoint, allIds.slice(0, 50));
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, firstBatch), {
      ...options,
      sourceUnitIds: allIds.slice(0, 50),
    });
    expect(first.runtime.sourceCoverage?.brokeredUnitIds).toHaveLength(50);
    expect(evaluateInvestigationCompletion(first).reasonCodes).toContain(
      "source_chunks_not_delivered",
    );
    const final = applyInvestigationLoopRound(
      first,
      round(first, sourceRoundAnalysis(first, allIds, true), "finalize"),
      { ...options, sourceUnitIds: allIds.slice(50) },
    );
    expect(final.stopReason).toBe("complete");
    expect(final.runtime.sourceCoverage?.brokeredUnitIds).toHaveLength(141);
  });

  it("rejects unknown delivery IDs and premature full-diff completion", () => {
    const { checkpoint, manifest } = setupSourceCoverage();
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, checkpoint.analysis), {
        ...options,
        sourceUnitIds: ["unknown"],
      }),
    ).toThrow("frozen complete manifest");
    const premature = sourceRoundAnalysis(checkpoint, [manifest.chunks[0]!.id], true);
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, premature), {
        ...options,
        sourceUnitIds: [manifest.chunks[0]!.id],
      }),
    ).toThrow("before every registered chunk");
  });

  it("requires the complete manifest before accepting full-diff completion", () => {
    const { initial } = setupSourceCoverage();
    expect(() =>
      applyInvestigationLoopRound(
        initial,
        round(initial, sourceRoundAnalysis(initial, [], true)),
        options,
      ),
    ).toThrow("without a trusted complete source manifest");
  });

  it("preserves chunk progress across resume and repeated source registration", () => {
    const { checkpoint, task, manifest } = setupSourceCoverage();
    const deliveredId = manifest.chunks[0]!.id;
    const first = applyInvestigationLoopRound(
      checkpoint,
      round(checkpoint, sourceRoundAnalysis(checkpoint, [deliveredId])),
      { ...options, sourceUnitIds: [deliveredId] },
    );
    const resumed = restoreInvestigationCheckpoint({
      checkpoint: interruptInvestigationLoop(first, "interrupted"),
      task,
      attemptId: "source-resume",
      leaseVersion: 2,
      recordedAt,
    });
    const registered = applyInvestigationSourceCoverage(resumed, manifest, { task, recordedAt });
    expect(registered.runtime.sourceCoverage).toEqual(first.runtime.sourceCoverage);
    expect(registered.analysis.coverage).toEqual(first.analysis.coverage);
    const changed = structuredClone(manifest);
    changed.mergeBaseSha = "f".repeat(40);
    const { digest: _digest, ...payload } = changed;
    changed.digest = investigationContentDigest(payload);
    expect(() => applyInvestigationSourceCoverage(resumed, changed, { task, recordedAt })).toThrow(
      "previously delivered source chunks",
    );
  });

  it("prevents generic runtime receipts from claiming model delivery", () => {
    const { checkpoint, manifest } = setupSourceCoverage();
    const forged = structuredClone(checkpoint.runtime);
    forged.sourceCoverage!.brokeredUnitIds = manifest.chunks.map((chunk) => chunk.id);
    expect(() => applyInvestigationRuntimeCheckpoint(checkpoint, forged, { recordedAt })).toThrow(
      "cannot change the trusted source manifest",
    );
  });

  it("computes scope digests independently of model-supplied digest and version claims", () => {
    const { checkpoint } = setupSourceCoverage();
    const analysis = structuredClone(checkpoint.analysis);
    analysis.coverage.scopeManifest.digest = "f".repeat(64);
    analysis.coverage.scopeManifest.version = 999;
    const accepted = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    expect(accepted.analysis.coverage.scopeManifest).toEqual(
      checkpoint.analysis.coverage.scopeManifest,
    );
  });
});
