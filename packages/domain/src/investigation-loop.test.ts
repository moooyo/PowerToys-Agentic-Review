import {
  createInvestigationPreview as createInvestigationFixture,
  INVESTIGATION_EXECUTION_DURATION_LIMIT_MS,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationLoopRoundV1,
  type InvestigationPrDiffManifestV1,
  type InvestigationResultV1,
  validateInvestigationAnalysisForTask,
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
  projectInvestigationTokenConsumption,
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

function setup(count = 1, localCheckout = false) {
  const fixture = createInvestigationFixture("pr", { findingCount: count });
  if (!localCheckout) fixture.task.executionPolicy.mode = "snapshot_only";
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

function setupSnapshot(count = 0) {
  const fixture = createInvestigationFixture("bug", { findingCount: count });
  const checkpoint = createInvestigationCheckpoint({
    task: fixture.task,
    attemptId: fixture.attempt.id,
    checkpointId: "snapshot-checkpoint",
    leaseVersion: fixture.attempt.leaseVersion,
    recordedAt,
  });
  return { ...fixture, checkpoint, analysis: proposedAnalysis(fixture.result) };
}

describe("complete investigation loop", () => {
  it("finishes a fresh snapshot-only issue in one invocation without guessing a source revision", () => {
    const { checkpoint, task, analysis } = setupSnapshot();
    expect(checkpoint.runtime.reviewMode).toBe("local_snapshot");
    expect(task.subjects[0]!.kind).toBe("issue_snapshot");
    const completed = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    expect(completed.stopReason).toBe("complete");
    expect(completed.round).toBe(1);
    expect(completed.runtime.sourceCoverage).toBeUndefined();
    expect(evaluateInvestigationCompletion(completed).reasonCodes).toEqual([]);
    expect(
      validateInvestigationAnalysisForTask(task, completed.analysis, completed.runtime).valid,
    ).toBe(true);
  });

  it("accepts a same-invocation snapshot hypothesis recheck only with explicit uncertainty and limitations", () => {
    const { checkpoint, analysis, result } = setupSnapshot(1);
    const reviewed = finalAnalysis(result, analysis, 1);
    reviewed.findings[0]!.confirmation.status = "hypothesis";
    reviewed.candidates[0]!.status = "unresolved";
    reviewed.rechecks[0]!.unresolvedQuestions = [
      "The reported runtime behavior still needs independent execution evidence.",
    ];
    reviewed.limitations = [
      {
        id: "snapshot-runtime-limitation",
        description: "Only the supplied issue snapshot was inspected.",
        impact: "The runtime behavior remains unverified.",
        evidenceRefs: [],
      },
    ];
    const completed = applyInvestigationLoopRound(checkpoint, round(checkpoint, reviewed), options);
    expect(completed.stopReason).toBe("complete");
    for (const omit of ["questions", "limitations", "recheck"] as const) {
      const incomplete = structuredClone(reviewed);
      if (omit === "questions") incomplete.rechecks[0]!.unresolvedQuestions = [];
      if (omit === "limitations") incomplete.limitations = [];
      if (omit === "recheck") incomplete.rechecks = [];
      const accepted = applyInvestigationLoopRound(
        checkpoint,
        round(checkpoint, incomplete),
        options,
      );
      expect(accepted.stopReason).toBe("continuing");
      expect(evaluateInvestigationCompletion(accepted).pendingFindingIds).toEqual([
        reviewed.findings[0]!.id,
      ]);
    }
  });

  it("keeps a historical snapshot checkpoint on its original separate-finalization semantics", () => {
    const { checkpoint, task, analysis } = setupSnapshot();
    delete checkpoint.runtime.reviewMode;
    const { digest: _digest, ...content } = checkpoint;
    checkpoint.digest = investigationContentDigest(content);
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    expect(first.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(first).reasonCodes).toContain(
      "finalization_round_missing",
    );
    const restored = restoreInvestigationCheckpoint({
      checkpoint: interruptInvestigationLoop(first, "interrupted"),
      task,
      attemptId: "snapshot-restored",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.runtime.reviewMode).toBeUndefined();
    const completed = applyInvestigationLoopRound(
      restored,
      round(restored, restored.analysis, "finalize"),
      options,
    );
    expect(completed.stopReason).toBe("complete");
  });

  it("rejects snapshot review mode on a task with a different execution policy", () => {
    const { task, checkpoint, analysis } = setup(0, true);
    checkpoint.runtime.reviewMode = "local_snapshot";
    expect(
      validateInvestigationAnalysisForTask(task, analysis, checkpoint.runtime).errors,
    ).toContainEqual(expect.objectContaining({ code: "REVIEW_MODE_TASK_MISMATCH" }));
  });

  it("allows a local checkout invocation to finish without a separate finalize round", () => {
    const { checkpoint, analysis } = setup(0, true);
    expect(checkpoint.runtime.reviewMode).toBe("local_checkout");
    const proposal = round(checkpoint, analysis);
    proposal.continue = true;
    const completed = applyInvestigationLoopRound(checkpoint, proposal, options);
    expect(completed.stopReason).toBe("complete");
    expect(completed.round).toBe(1);
    expect(evaluateInvestigationCompletion(completed).reasonCodes).toEqual([]);
  });

  it("accepts evidenced discovery and independent recheck within one local invocation", () => {
    const { checkpoint, analysis, result } = setup(1, true);
    const completed = applyInvestigationLoopRound(
      checkpoint,
      round(checkpoint, finalAnalysis(result, analysis, 1)),
      options,
    );
    expect(completed.stopReason).toBe("complete");
    expect(completed.analysis.rechecks[0]!.round).toBe(1);
  });

  it("still requires current finding evidence in local checkout mode", () => {
    const { checkpoint, analysis, result } = setup(1, true);
    const proposed = finalAnalysis(result, analysis, 1);
    proposed.rechecks[0]!.evidenceRefs = [];
    const accepted = applyInvestigationLoopRound(checkpoint, round(checkpoint, proposed), options);
    expect(accepted.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(accepted).pendingFindingIds).toEqual([
      proposed.findings[0]!.id,
    ]);
  });

  it("preserves the historical mode when restoring a source-reading checkpoint without a mode", () => {
    const { checkpoint, task } = setup(0, true);
    const historical = structuredClone(checkpoint);
    delete historical.runtime.reviewMode;
    const { digest: _digest, ...payload } = historical;
    historical.digest = investigationContentDigest(payload);
    const restored = restoreInvestigationCheckpoint({
      checkpoint: interruptInvestigationLoop(historical, "interrupted"),
      task,
      attemptId: "legacy-resume",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.runtime.reviewMode).toBeUndefined();
    expect(evaluateInvestigationCompletion(restored).reasonCodes).toContain(
      "finalization_round_missing",
    );
  });

  it.each([false, true])("prevents execution receipts from changing review mode: %s", (local) => {
    const { checkpoint } = setup(0, local);
    const runtime = structuredClone(checkpoint.runtime);
    if (local) delete runtime.reviewMode;
    else runtime.reviewMode = "local_checkout";
    expect(() => applyInvestigationRuntimeCheckpoint(checkpoint, runtime, { recordedAt })).toThrow(
      "cannot change the trusted source review mode",
    );
  });

  it.each(["summary", "diagnostic", "order", "version", "evidence-id"] as const)(
    "does not count %s changes as semantic progress",
    (mutation) => {
      const { checkpoint, analysis } = setup(2);
      const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
      const repeated = structuredClone(first.analysis);
      if (mutation === "summary") {
        repeated.summary = "The same review described in different words.";
        repeated.assessment.summary = "A reformatted summary with no new source or result.";
        repeated.candidates[0]!.rationale = "The same unresolved investigation restated.";
      }
      if (mutation === "diagnostic")
        repeated.diagnostics.push({
          id: "reworded-diagnostic",
          code: "SOURCE_UNAVAILABLE",
          category: "blocker",
          message: "No additional source was obtained.",
          retryable: false,
          evidenceRefs: [],
          prerequisiteRefs: [],
        });
      if (mutation === "order") {
        repeated.evidence.reverse();
        repeated.findings.reverse();
        repeated.candidates.reverse();
      }
      if (mutation === "version") {
        repeated.findings[0]!.version += 1;
        repeated.candidates[0]!.findingVersion = repeated.findings[0]!.version;
      }
      if (mutation === "evidence-id")
        repeated.evidence.push({
          ...structuredClone(repeated.evidence[0]!),
          id: "same-evidence-new-id",
        });
      const stopped = applyInvestigationLoopRound(first, round(first, repeated), {
        ...options,
        recordedAt: "2026-09-15T04:10:00.000Z",
        usage: { durationMs: 5_000, tokens: 30_000, reportBytes: 10_000 },
      });
      expect(stopped.stopReason).toBe("blocked");
      expect(stopped.analysis.diagnostics).toContainEqual(
        expect.objectContaining({ code: "INVESTIGATION_NO_PROGRESS" }),
      );
      expect(stopped.consumed.tokens).toBe(30_100);
    },
  );

  it("counts a valid required recheck as progress without requiring new source evidence", () => {
    const { checkpoint, analysis, result } = setup();
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const reviewed = applyInvestigationLoopRound(
      first,
      round(first, finalAnalysis(result, analysis, 2), "recheck"),
      options,
    );
    expect(reviewed.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(reviewed).pendingFindingIds).toEqual([]);
    expect(
      reviewed.analysis.diagnostics.some((entry) => entry.code === "INVESTIGATION_NO_PROGRESS"),
    ).toBe(false);
  });

  it("does not allow completed coverage to alternate states to manufacture progress", () => {
    const { checkpoint, analysis } = setup();
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const repeated = structuredClone(first.analysis);
    repeated.coverage.includedUnits[0]!.status = "pending";
    expect(() => applyInvestigationLoopRound(first, round(first, repeated), options)).toThrow(
      "cannot be reopened",
    );
  });

  it("records trusted model identity only for accepted analysis rounds", () => {
    const { checkpoint, analysis } = setup();
    const modelIdentity = { engine: "codex" as const, model: "gpt-6-astra" };
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), {
      ...options,
      modelIdentity,
    });
    expect(first.runtime.modelExecutions).toEqual([
      { ...modelIdentity, attemptId: checkpoint.attemptId, round: 1 },
    ]);
    expect(checkpoint.runtime.modelExecutions).toBeUndefined();
    const changed = structuredClone(analysis);
    changed.findings[0]!.title = "Rejected same-version finding edit";
    const accepted = structuredClone(first);
    expect(() =>
      applyInvestigationLoopRound(first, round(first, changed), {
        ...options,
        modelIdentity: { engine: "copilot", model: null },
      }),
    ).toThrow();
    expect(first).toEqual(accepted);
  });

  it("preserves mixed model history and exact round ownership across resume", () => {
    const { checkpoint, task, analysis } = setup();
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), {
      ...options,
      modelIdentity: { engine: "codex", model: "gpt-6-astra" },
    });
    const restored = restoreInvestigationCheckpoint({
      checkpoint: interruptInvestigationLoop(first, "interrupted"),
      task,
      attemptId: "attempt-2",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.runtime.modelExecutions).toEqual(first.runtime.modelExecutions);
    const second = applyInvestigationLoopRound(restored, round(restored, analysis), {
      ...options,
      modelIdentity: { engine: "copilot", model: null },
    });
    expect(second.adoptedAttemptIds).toEqual([checkpoint.attemptId, "attempt-2"]);
    expect(second.runtime.modelExecutions).toEqual([
      { attemptId: checkpoint.attemptId, round: 1, engine: "codex", model: "gpt-6-astra" },
      { attemptId: "attempt-2", round: 2, engine: "copilot", model: null },
    ]);
    expect(first.runtime.modelExecutions).toHaveLength(1);
  });

  it("does not invent model identities for legacy rounds when recording a later round", () => {
    const { checkpoint, analysis } = setup();
    const legacy = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    expect(legacy.runtime.modelExecutions).toBeUndefined();
    const next = applyInvestigationLoopRound(legacy, round(legacy, analysis), {
      ...options,
      modelIdentity: { engine: "codex", model: null },
    });
    expect(next.runtime.modelExecutions).toEqual([
      { attemptId: checkpoint.attemptId, round: 2, engine: "codex", model: null },
    ]);
  });

  it.each(["model", "engine", "attempt", "round", "discard", "omit", "append"])(
    "rejects generic runtime changes to trusted model history: %s",
    (mutation) => {
      const { checkpoint, analysis } = setup();
      const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), {
        ...options,
        modelIdentity: { engine: "codex", model: "gpt-6-astra" },
      });
      const runtime = structuredClone(first.runtime);
      const execution = runtime.modelExecutions![0]!;
      if (mutation === "model") execution.model = "forged-model";
      if (mutation === "engine") execution.engine = "copilot";
      if (mutation === "attempt") execution.attemptId = "forged-attempt";
      if (mutation === "round") execution.round = 2;
      if (mutation === "discard") runtime.modelExecutions = [];
      if (mutation === "omit") delete runtime.modelExecutions;
      if (mutation === "append") runtime.modelExecutions!.push({ ...execution, round: 2 });
      expect(() => applyInvestigationRuntimeCheckpoint(first, runtime, { recordedAt })).toThrow(
        "Execution receipts cannot add, replace, or remove accepted analysis model identities",
      );
      expect(first.runtime.modelExecutions).toEqual([
        { attemptId: checkpoint.attemptId, round: 1, engine: "codex", model: "gpt-6-astra" },
      ]);
    },
  );

  it("does not let a generic runtime update invent history for legacy analysis", () => {
    const { checkpoint, analysis } = setup();
    const legacy = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const runtime = structuredClone(legacy.runtime);
    runtime.modelExecutions = [
      { attemptId: legacy.attemptId, round: 1, engine: "codex", model: "forged-model" },
    ];
    expect(() => applyInvestigationRuntimeCheckpoint(legacy, runtime, { recordedAt })).toThrow(
      "Execution receipts cannot add, replace, or remove accepted analysis model identities",
    );
  });

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

  it("stops identical incomplete analysis instead of spending a third round", () => {
    const { checkpoint, analysis } = setup();
    let current = checkpoint;
    for (let index = 0; index < 2; index += 1)
      current = applyInvestigationLoopRound(
        current,
        round(current, analysis, "investigation"),
        options,
      );
    expect(current.round).toBe(2);
    expect(current.stopReason).toBe("blocked");
    expect(current.analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: "INVESTIGATION_NO_PROGRESS", retryable: false }),
    );
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
    expect(evaluateInvestigationCompletion(second).complete).toBe(false);
    expect(
      second.analysis.diagnostics.some((entry) => entry.code === "INVESTIGATION_NO_PROGRESS"),
    ).toBe(false);
    const unchanged = applyInvestigationLoopRound(
      second,
      round(second, second.analysis, "finalize"),
      options,
    );
    expect(unchanged.stopReason).toBe("blocked");
    expect(evaluateInvestigationCompletion(unchanged).pendingFindingIds).toEqual([
      analysis.findings[0]!.id,
    ]);
  });

  it("does not treat a recheck ID, version, or wording replacement as progress while confirmation remains missing", () => {
    const { checkpoint, analysis, result } = setup();
    analysis.findings[0]!.confirmation.evidenceRefs = [];
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const second = applyInvestigationLoopRound(
      first,
      round(first, finalAnalysis(result, analysis, 2), "finalize"),
      options,
    );
    const repeated = structuredClone(second.analysis);
    const finding = repeated.findings[0]!;
    finding.version += 1;
    finding.confirmation.recheckRef = "equivalent-recheck";
    repeated.candidates[0]!.findingVersion = finding.version;
    repeated.rechecks.push({
      ...repeated.rechecks[0]!,
      id: "equivalent-recheck",
      findingVersion: finding.version,
      round: 3,
      conclusion: "The same source check expressed again without additional evidence.",
    });
    const stopped = applyInvestigationLoopRound(
      second,
      round(second, repeated, "finalize"),
      options,
    );
    expect(stopped.stopReason).toBe("blocked");
    expect(stopped.analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: "INVESTIGATION_NO_PROGRESS" }),
    );
    expect(evaluateInvestigationCompletion(stopped).complete).toBe(false);
  });

  it("can complete the remaining confirmation evidence after a valid recheck made progress", () => {
    const { checkpoint, analysis, result } = setup();
    analysis.findings[0]!.confirmation.evidenceRefs = [];
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const second = applyInvestigationLoopRound(
      first,
      round(first, finalAnalysis(result, analysis, 2), "finalize"),
      options,
    );
    const completed = structuredClone(second.analysis);
    const finding = completed.findings[0]!;
    finding.version += 1;
    finding.confirmation.evidenceRefs = [...finding.evidenceRefs];
    finding.confirmation.recheckRef = "confirmed-final-recheck";
    completed.candidates[0]!.findingVersion = finding.version;
    completed.rechecks.push({
      ...completed.rechecks[0]!,
      id: "confirmed-final-recheck",
      findingVersion: finding.version,
      round: 3,
    });
    const accepted = applyInvestigationLoopRound(
      second,
      round(second, completed, "finalize"),
      options,
    );
    expect(accepted.stopReason).toBe("complete");
    expect(evaluateInvestigationCompletion(accepted).pendingFindingIds).toEqual([]);
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
    const exhausted = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), {
      ...options,
      usage: { ...options.usage, durationMs: INVESTIGATION_EXECUTION_DURATION_LIMIT_MS },
    });
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

  it("continues beyond legacy token and round limits while preserving their original checkpoint", () => {
    const { task, attempt, analysis, result } = setup();
    task.budget.maxRounds = 1;
    task.budget.maxTokens = 1;
    const initial = createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "legacy-counter-checkpoint",
      leaseVersion: 1,
      recordedAt,
    });
    const original = structuredClone(initial);
    const first = applyInvestigationLoopRound(initial, round(initial, analysis), options);
    expect(first.stopReason).toBe("continuing");
    const final = applyInvestigationLoopRound(
      first,
      round(first, finalAnalysis(result, analysis, 2), "finalize"),
      options,
    );
    expect(final.stopReason).toBe("complete");
    expect(final.consumed).toMatchObject({ rounds: 2, tokens: 200, durationMs: 20 });
    expect(initial).toEqual(original);
    expect(initial.budget).toMatchObject({ maxRounds: 1, maxTokens: 1 });
  });

  it("completes past a legacy thirty-minute allowance while within the fixed two hours", () => {
    const { task, analysis } = setup(0, true);
    task.budget = { ...task.budget, maxDurationMs: 30 * 60_000, maxRounds: 1, maxTokens: 1 };
    const initial = createInvestigationCheckpoint({
      task,
      attemptId: "legacy-duration-attempt",
      checkpointId: "legacy-duration-checkpoint",
      leaseVersion: 1,
      recordedAt,
    });
    const completed = applyInvestigationLoopRound(initial, round(initial, analysis), {
      ...options,
      usage: { ...options.usage, durationMs: 90 * 60_000 },
    });
    expect(completed.stopReason).toBe("complete");
    expect(completed.consumed.durationMs).toBe(90 * 60_000);
    expect(completed.budget).toEqual(initial.budget);
  });

  it.each([1, INVESTIGATION_EXECUTION_DURATION_LIMIT_MS * 2])(
    "shares the two-hour duration across recovery with a legacy duration allowance of %s",
    (legacyDurationMs) => {
      const { task, attempt, analysis } = setup();
      task.budget.maxDurationMs = legacyDurationMs;
      task.budget.maxRounds = 1;
      task.budget.maxTokens = 1;
      const initial = createInvestigationCheckpoint({
        task,
        attemptId: attempt.id,
        checkpointId: "cumulative-duration-checkpoint",
        leaseVersion: 1,
        recordedAt,
      });
      const original = structuredClone(initial);
      const advanced = applyInvestigationRuntimeCheckpoint(initial, initial.runtime, {
        recordedAt,
        durationMs: INVESTIGATION_EXECUTION_DURATION_LIMIT_MS - 100,
        accountedTokens: 1_000_000_000,
      });
      expect(advanced.stopReason).toBe("continuing");
      const interrupted = interruptInvestigationLoop(advanced, "interrupted", recordedAt, [], 30);
      const resumed = restoreInvestigationCheckpoint({
        checkpoint: JSON.parse(JSON.stringify(interrupted)),
        task,
        attemptId: "duration-recovery-attempt",
        leaseVersion: 2,
        recordedAt,
      });
      expect(resumed.consumed.durationMs).toBe(INVESTIGATION_EXECUTION_DURATION_LIMIT_MS - 70);
      expect(resumed.consumed.tokens).toBe(1_000_000_000);
      expect(resumed.budget).toEqual(task.budget);
      const exhausted = applyInvestigationLoopRound(resumed, round(resumed, analysis), {
        ...options,
        usage: { ...options.usage, durationMs: 70 },
      });
      expect(exhausted.stopReason).toBe("budget_exhausted");
      expect(exhausted.consumed.durationMs).toBe(INVESTIGATION_EXECUTION_DURATION_LIMIT_MS);
      expect(exhausted.analysis.findings).toHaveLength(1);
      expect(() =>
        restoreInvestigationCheckpoint({
          checkpoint: exhausted,
          task,
          attemptId: "duration-reset-attempt",
          leaseVersion: 3,
          recordedAt,
        }),
      ).toThrow("cannot be reset or extended");
      expect(initial).toEqual(original);
    },
  );

  it("charges interruption time against the same total execution limit", () => {
    const { checkpoint } = setup();
    const stopped = interruptInvestigationLoop(
      checkpoint,
      "error",
      recordedAt,
      [],
      INVESTIGATION_EXECUTION_DURATION_LIMIT_MS,
    );
    expect(stopped.stopReason).toBe("budget_exhausted");
    expect(stopped.consumed.durationMs).toBe(INVESTIGATION_EXECUTION_DURATION_LIMIT_MS);
  });

  it.each([100, null])(
    "preserves accepted execution receipts with token usage %s across an interrupted attempt",
    (tokens) => {
      const { checkpoint, task, result } = setup();
      const knownTokens = tokens ?? 0;
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
      const acceptedStart = applyInvestigationRuntimeCheckpoint(checkpoint, runtime, {
        recordedAt,
      });
      runtime.completedStepIds.push(started.stepId);
      runtime.completedSteps.push({
        ...started,
        outcome: "completed",
        validation: { checks: [], summary: "Synthetic step receipt." },
        verificationEvidence: [],
        artifacts: [],
        diagnostics: [],
        subjects: [],
        modelUsage: { tokens, durationMs: 20 },
      });
      const completed = applyInvestigationRuntimeCheckpoint(acceptedStart, runtime, { recordedAt });
      const ledgerKnownTokens = knownTokens + 37;
      const precharged = projectInvestigationTokenConsumption(acceptedStart, ledgerKnownTokens);
      const ledgerRecorded = applyInvestigationRuntimeCheckpoint(precharged, runtime, {
        recordedAt,
        accountedTokens: ledgerKnownTokens,
      });
      expect(ledgerRecorded.consumed.tokens).toBe(ledgerKnownTokens);
      expect(completed.consumed.tokens).toBe(knownTokens);
      expect(completed.consumed.durationMs).toBe(20);
      const replayed = applyInvestigationRuntimeCheckpoint(completed, runtime, { recordedAt });
      expect(replayed.consumed.tokens).toBe(knownTokens);
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
      expect(restored.runtime.completedSteps[0]!.modelUsage).toEqual({ tokens, durationMs: 20 });
      expect(restored.consumed.tokens).toBe(knownTokens);
      for (const invalidTokens of [-1, Number.NaN]) {
        const invalid = structuredClone(runtime);
        invalid.completedSteps[0]!.modelUsage!.tokens = invalidTokens;
        expect(() =>
          applyInvestigationRuntimeCheckpoint(acceptedStart, invalid, { recordedAt }),
        ).toThrow("known token count or null");
      }
      const forgotten = structuredClone(restored.runtime);
      forgotten.completedSteps = [];
      forgotten.completedStepIds = [];
      expect(() =>
        applyInvestigationRuntimeCheckpoint(restored, forgotten, { recordedAt }),
      ).toThrow("ledger cannot discard");
    },
  );

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
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), {
      ...options,
      modelIdentity: { engine: "codex", model: "gpt-6-astra" },
    });
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
    expect(recovered.runtime.modelExecutions).toEqual([
      { attemptId: checkpoint.attemptId, round: 1, engine: "codex", model: "gpt-6-astra" },
    ]);
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

  it("charges a rejected model invocation without accepting its analysis or a completed round", () => {
    const { checkpoint, analysis } = setup();
    const accepted = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const interrupted = interruptInvestigationLoop(accepted, "error", recordedAt, [], 30, {
      round: 2,
      tokens: 37,
    });
    expect(interrupted.consumed.tokens).toBe(137);
    expect(interrupted.consumed.rounds).toBe(1);
    expect(interrupted.round).toBe(1);
    expect(interrupted.consumed.durationMs).toBe(40);
    expect(interrupted.analysis).toEqual(accepted.analysis);
    expect(interrupted.runtime.unacceptedModelUsage).toEqual([
      { attemptId: checkpoint.attemptId, round: 2, tokens: 37 },
    ]);
    expect(accepted.runtime.unacceptedModelUsage).toBeUndefined();
  });

  it("deduplicates rejected invocation usage independently of interruption diagnostics", () => {
    const { checkpoint } = setup();
    const usage = { round: 1, tokens: 37 };
    const interrupted = interruptInvestigationLoop(checkpoint, "error", recordedAt, [], 10, usage);
    const repeated = interruptInvestigationLoop(
      interrupted,
      "interrupted",
      recordedAt,
      [
        {
          id: "additional-interruption-detail",
          code: "MODEL_PROTOCOL_ERROR",
          category: "error",
          message: "The same invocation is being reported with an additional diagnostic.",
          retryable: false,
          evidenceRefs: [],
          prerequisiteRefs: [],
        },
      ],
      20,
      usage,
    );
    expect(repeated.consumed.tokens).toBe(37);
    expect(repeated.consumed.durationMs).toBe(30);
    expect(repeated.runtime.unacceptedModelUsage).toEqual(interrupted.runtime.unacceptedModelUsage);
    expect(repeated.analysis.diagnostics).toHaveLength(1);
    for (const tokens of [38, null])
      expect(() =>
        interruptInvestigationLoop(repeated, "error", recordedAt, [], 0, { round: 1, tokens }),
      ).toThrow("different token usage receipt");
    expect(() =>
      interruptInvestigationLoop(repeated, "error", recordedAt, [], 0, { round: 2, tokens: 1 }),
    ).toThrow("next unaccepted analysis round");
  });

  it("retains unavailable usage and its subtotal diagnostic across explicit recovery", () => {
    const { checkpoint, task, analysis } = setup();
    const interrupted = interruptInvestigationLoop(checkpoint, "cancelled", recordedAt, [], 10, {
      round: 1,
      tokens: null,
    });
    expect(interrupted.consumed.tokens).toBe(0);
    expect(interrupted.consumed.rounds).toBe(0);
    expect(interrupted.runtime.unacceptedModelUsage).toEqual([
      { attemptId: checkpoint.attemptId, round: 1, tokens: null },
    ]);
    expect(interrupted.analysis.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MODEL_USAGE_UNAVAILABLE",
        message: expect.stringContaining("only known usage"),
      }),
    );
    const revised = increaseInvestigationBudget(
      interrupted,
      task,
      { ...task.budget, maxReportBytes: task.budget.maxReportBytes + 100 },
      { recordedAt },
    );
    const restored = restoreInvestigationCheckpoint({
      checkpoint: revised.checkpoint,
      task: revised.task,
      attemptId: "explicit-recovery-attempt",
      leaseVersion: 2,
      recordedAt,
    });
    const conflicting = structuredClone(analysis);
    conflicting.diagnostics = interrupted.analysis.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: "The rejected invocation used zero tokens.",
    }));
    expect(() =>
      applyInvestigationLoopRound(restored, round(restored, conflicting), options),
    ).toThrow("unavailable model usage diagnostic cannot be replaced");
    const proposed = structuredClone(analysis);
    proposed.diagnostics = [];
    const next = applyInvestigationLoopRound(restored, round(restored, proposed), options);
    expect(next.consumed.tokens).toBe(100);
    expect(next.runtime.unacceptedModelUsage).toEqual(interrupted.runtime.unacceptedModelUsage);
    expect(next.analysis.diagnostics).toEqual(interrupted.analysis.diagnostics);
  });

  it.each(["omit", "replace", "append"] as const)(
    "prevents execution receipts from changing rejected invocation usage by %s",
    (mutation) => {
      const { checkpoint, task } = setup();
      const interrupted = interruptInvestigationLoop(checkpoint, "error", recordedAt, [], 0, {
        round: 1,
        tokens: 37,
      });
      const restored = restoreInvestigationCheckpoint({
        checkpoint: interrupted,
        task,
        attemptId: "execution-recovery-attempt",
        leaseVersion: 2,
        recordedAt,
      });
      const runtime = structuredClone(restored.runtime);
      if (mutation === "omit") delete runtime.unacceptedModelUsage;
      if (mutation === "replace") runtime.unacceptedModelUsage![0]!.tokens = 0;
      if (mutation === "append")
        runtime.unacceptedModelUsage!.push({ attemptId: restored.attemptId, round: 1, tokens: 1 });
      expect(() => applyInvestigationRuntimeCheckpoint(restored, runtime, { recordedAt })).toThrow(
        "cannot add, replace, or remove unaccepted model usage",
      );
    },
  );

  it("charges a distinct invocation after recovery even when its analysis round number is unchanged", () => {
    const { checkpoint, task } = setup();
    const interrupted = interruptInvestigationLoop(checkpoint, "error", recordedAt, [], 0, {
      round: 1,
      tokens: 37,
    });
    const restored = restoreInvestigationCheckpoint({
      checkpoint: interrupted,
      task,
      attemptId: "second-model-attempt",
      leaseVersion: 2,
      recordedAt,
    });
    const failed = interruptInvestigationLoop(restored, "error", recordedAt, [], 0, {
      round: 1,
      tokens: 41,
    });
    expect(failed.consumed.tokens).toBe(78);
    expect(failed.consumed.rounds).toBe(0);
    expect(failed.runtime.unacceptedModelUsage).toEqual([
      { attemptId: checkpoint.attemptId, round: 1, tokens: 37 },
      { attemptId: restored.attemptId, round: 1, tokens: 41 },
    ]);
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

  it("resumes after a storage allowance increase without losing findings or elapsed time", () => {
    const { task, attempt, analysis } = setup(137);
    const sufficientReportBytes = task.budget.maxReportBytes;
    task.budget.maxReportBytes = 1;
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
      { ...task.budget, maxReportBytes: sufficientReportBytes },
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
    expect(restored.budget).toEqual({
      maxDurationMs: INVESTIGATION_EXECUTION_DURATION_LIMIT_MS,
      maxReportBytes: sufficientReportBytes,
    });
    expect(restored.analysis.findings).toHaveLength(137);
    const directlyRevisedTask = {
      ...task,
      budget: { ...task.budget, maxReportBytes: sufficientReportBytes },
    };
    expect(
      restoreInvestigationCheckpoint({
        checkpoint: exhausted,
        task: directlyRevisedTask,
        attemptId: "direct-extension",
        leaseVersion: 2,
        recordedAt,
      }).budget.maxReportBytes,
    ).toBe(sufficientReportBytes);
    expect(() =>
      increaseInvestigationBudget(
        exhausted,
        task,
        { ...task.budget, maxReportBytes: 0 },
        { recordedAt },
      ),
    ).toThrow("positive safe integers");
    expect(() =>
      increaseInvestigationBudget(
        revised.checkpoint,
        revised.task,
        { ...revised.task.budget, maxReportBytes: sufficientReportBytes - 1 },
        { recordedAt },
      ),
    ).toThrow("cannot decrease");
    expect(() =>
      increaseInvestigationBudget(
        exhausted,
        task,
        { ...task.budget, maxDurationMs: INVESTIGATION_EXECUTION_DURATION_LIMIT_MS + 1 },
        { recordedAt },
      ),
    ).toThrow("fixed two-hour limit");
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

function setupSourceCoverage(fileCount = 1, localCheckout = false) {
  const { task, attempt } = createInvestigationFixture("pr", { findingCount: 0 });
  if (!localCheckout) task.executionPolicy.mode = "snapshot_only";
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
  it("registers changed files while retaining chunks only as a local source identity manifest", () => {
    const { checkpoint, manifest, task } = setupSourceCoverage(2, true);
    expect(checkpoint.analysis.coverage.includedUnits).toHaveLength(3);
    expect(
      checkpoint.analysis.coverage.includedUnits.filter((unit) => unit.kind === "source_file"),
    ).toHaveLength(2);
    expect(checkpoint.runtime.sourceCoverage?.manifest).toEqual(manifest);
    expect(manifest.chunks).toHaveLength(6);
    expect(checkpoint.runtime.sourceCoverage?.brokeredUnitIds).toEqual([]);
    const completed = applyInvestigationLoopRound(
      checkpoint,
      round(
        checkpoint,
        sourceRoundAnalysis(
          checkpoint,
          checkpoint.analysis.coverage.includedUnits.map((unit) => unit.id),
          true,
        ),
      ),
      options,
    );
    expect(completed.stopReason).toBe("complete");
    expect(completed.round).toBe(1);
    expect(completed.runtime.sourceCoverage?.brokeredUnitIds).toEqual([]);
    expect(
      validateInvestigationAnalysisForTask(task, completed.analysis, completed.runtime).valid,
    ).toBe(true);
  });

  it("still requires a trusted manifest before local full-diff completion", () => {
    const { initial } = setupSourceCoverage(1, true);
    expect(() =>
      applyInvestigationLoopRound(
        initial,
        round(initial, sourceRoundAnalysis(initial, [], true)),
        options,
      ),
    ).toThrow("without a trusted complete source manifest");
  });

  it("stops when all remaining work is blocked even if the model requests another invocation", () => {
    const { checkpoint } = setupSourceCoverage(1, true);
    const analysis = structuredClone(checkpoint.analysis);
    for (const unit of analysis.coverage.includedUnits)
      if (unit.kind !== "full_diff") unit.status = "blocked";
    const proposal = round(checkpoint, analysis);
    proposal.continue = true;
    const stopped = applyInvestigationLoopRound(checkpoint, proposal, options);
    expect(stopped.stopReason).toBe("blocked");
    expect(stopped.round).toBe(1);
    expect(stopped.analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: "INVESTIGATION_BLOCKED", retryable: false }),
    );
  });

  it("allows new source evidence to advance pending work despite a historical blocker", () => {
    const { checkpoint } = setupSourceCoverage(1, true);
    const analysis = structuredClone(checkpoint.analysis);
    analysis.diagnostics.push({
      id: "missing-helper",
      code: "SOURCE_UNAVAILABLE",
      category: "blocker",
      message: "The helper source was initially unavailable.",
      retryable: false,
      evidenceRefs: [],
      prerequisiteRefs: [],
    });
    const first = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const advanced = structuredClone(first.analysis);
    advanced.evidence.push({
      id: "helper-source",
      subjectRef: checkpoint.analysis.assessment.subjectRef,
      source: "static_analysis",
      summary: "The pinned Helper.cs implementation was found and inspected.",
      evidenceRefs: [],
    });
    const second = applyInvestigationLoopRound(first, round(first, advanced), options);
    expect(second.stopReason).toBe("continuing");
    expect(second.analysis.diagnostics).toEqual(first.analysis.diagnostics);
  });

  it("allows blocked coverage to consume trusted observation batches but stops after unchanged summaries", () => {
    const { checkpoint } = setupSourceCoverage(1, true);
    checkpoint.runtime.evidence = [0, 1].map((index) => ({
      id: `trusted-observation-${index}`,
      subjectRef: checkpoint.analysis.assessment.subjectRef,
      source: "executor_observation" as const,
      authority: "worker" as const,
      summary: `Trusted result ${index}.`,
      artifactRefs: [],
      evidenceRefs: [],
      provenance: {
        taskId: checkpoint.taskId,
        attemptId: checkpoint.attemptId,
        producer: "Synthetic executor",
        recordedAt,
      },
    }));
    const { digest: _digest, ...content } = checkpoint;
    checkpoint.digest = investigationContentDigest(content);
    let current = checkpoint;
    for (const observation of checkpoint.runtime.evidence) {
      const analysis = structuredClone(current.analysis);
      for (const unit of analysis.coverage.includedUnits)
        if (unit.kind !== "full_diff") unit.status = "blocked";
      analysis.evidence.push({
        id: `analysis-${observation.id}`,
        subjectRef: observation.subjectRef,
        source: "static_analysis",
        summary: "The observed result was analyzed before resolving aggregate coverage.",
        evidenceRefs: [observation.id],
      });
      current = applyInvestigationLoopRound(current, round(current, analysis), options);
      expect(current.stopReason).toBe("continuing");
    }
    const stopped = applyInvestigationLoopRound(current, round(current, current.analysis), options);
    expect(stopped.stopReason).toBe("blocked");
    expect(evaluateInvestigationCompletion(stopped).complete).toBe(false);
  });

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

describe("ledger token projection", () => {
  it("accepts unavailable analysis usage across recovery while preserving the known aggregate", () => {
    const { task, analysis, result } = setup();
    task.budget.maxRounds = 1;
    task.budget.maxTokens = 1;
    const initial = createInvestigationCheckpoint({
      task,
      attemptId: "unknown-analysis-attempt",
      checkpointId: "unknown-analysis-checkpoint",
      leaseVersion: 1,
      recordedAt,
    });
    const precharged = projectInvestigationTokenConsumption(initial, 37);
    const unavailableUsage = { ...options.usage, tokens: null };
    const accepted = applyInvestigationLoopRound(precharged, round(precharged, analysis), {
      ...options,
      usage: unavailableUsage,
    });
    expect(accepted.stopReason).toBe("continuing");
    expect(accepted.consumed).toMatchObject({ tokens: 37, rounds: 1, durationMs: 10 });
    const restored = restoreInvestigationCheckpoint({
      checkpoint: JSON.parse(JSON.stringify(interruptInvestigationLoop(accepted, "interrupted"))),
      task,
      attemptId: "unknown-analysis-recovery",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.consumed.tokens).toBe(37);
    const completed = applyInvestigationLoopRound(
      restored,
      round(restored, finalAnalysis(result, analysis, 2), "finalize"),
      { ...options, usage: unavailableUsage },
    );
    expect(completed.stopReason).toBe("complete");
    expect(completed.consumed).toMatchObject({ tokens: 37, rounds: 2, durationMs: 20 });
    for (const tokens of [-1, Number.NaN])
      expect(() =>
        applyInvestigationLoopRound(initial, round(initial, analysis), {
          ...options,
          usage: { ...options.usage, tokens },
        }),
      ).toThrow("nonnegative safe integer");
  });

  it("replaces the compatibility total without charging a pre-accounted analysis twice", () => {
    const { task, analysis } = setup(0, true);
    task.budget.maxTokens = 50;
    const initial = createInvestigationCheckpoint({
      task,
      attemptId: "ledger-attempt",
      checkpointId: "ledger-checkpoint",
      leaseVersion: 1,
      recordedAt,
    });
    const precharged = projectInvestigationTokenConsumption(initial, 40);
    const accepted = applyInvestigationLoopRound(precharged, round(precharged, analysis), {
      ...options,
      usage: { ...options.usage, tokens: 40 },
      accountedTokens: 40,
    });
    expect(accepted.consumed.tokens).toBe(40);
    expect(accepted.stopReason).toBe("complete");
    const exceeded = applyInvestigationLoopRound(initial, round(initial, analysis), {
      ...options,
      accountedTokens: 70,
    });
    expect(exceeded.consumed.tokens).toBe(70);
    expect(exceeded.stopReason).toBe("complete");
  });

  it("records tokens above a legacy limit without stopping and reseals the compatibility snapshot", () => {
    const { checkpoint } = setup();
    const projected = projectInvestigationTokenConsumption(checkpoint, 1_000_000_000);
    expect(projected.stopReason).toBe("continuing");
    expect(projected.consumed.tokens).toBe(1_000_000_000);
    const { digest, ...content } = projected;
    expect(digest).toBe(investigationContentDigest(content));
    expect(() => projectInvestigationTokenConsumption(checkpoint, -1)).toThrow(/nonnegative/u);
  });
});
