import {
  createInvestigationPreview,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationModelOutputRejectionIssue,
  type InvestigationResultV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  applyInvestigationLoopRound,
  applyInvestigationRuntimeCheckpoint,
  assertInvestigationCheckpointIntegrity,
  createInvestigationCheckpoint,
  interruptInvestigationLoop,
  investigationContentDigest,
  rejectInvestigationModelOutput,
  restoreCompletedInvestigationForDelivery,
  restoreInvestigationCheckpoint,
} from "./investigation-loop.js";

const recordedAt = "2026-09-20T00:00:00.000Z";
const options = { recordedAt, durationMs: 30, accountedTokens: 120 };
const issue: InvestigationModelOutputRejectionIssue = {
  rule: "reference_outside_batch",
  paths: ["/analysis/assessment/evidenceRefs/0"],
};
const reference = ({ id, version, digest }: InvestigationLoopCheckpointV1) => ({
  id,
  version,
  digest,
});

function setup() {
  const fixture = createInvestigationPreview("bug", { findingCount: 0 });
  const checkpoint = createInvestigationCheckpoint({
    task: fixture.task,
    attemptId: fixture.attempt.id,
    checkpointId: "checkpoint",
    leaseVersion: 1,
    recordedAt,
  });
  return { ...fixture, checkpoint };
}

function rejection(checkpoint: InvestigationLoopCheckpointV1, invocationId = "invocation") {
  return {
    attemptId: checkpoint.attemptId,
    inputCheckpointRef: reference(checkpoint),
    round: checkpoint.round + 1,
    invocationId,
    issue: structuredClone(issue),
  };
}

function completeAnalysis(result: InvestigationResultV1): InvestigationAnalysisV1 {
  return {
    schemaVersion: "InvestigationAnalysisV1",
    summary: result.report.summary,
    coverage: structuredClone(result.report.coverage),
    assessment: structuredClone(result.assessment),
    findings: [],
    candidates: [],
    rechecks: [],
    evidence: result.verificationEvidence.flatMap((entry) =>
      entry.source === "static_analysis" || entry.source === "reporter_statement"
        ? [
            {
              id: entry.id,
              subjectRef: entry.subjectRef,
              source: entry.source,
              summary: entry.summary,
              evidenceRefs: entry.evidenceRefs,
            },
          ]
        : [],
    ),
    plans: result.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...plan }) =>
        structuredClone(plan),
    ),
    nextActions: result.nextActions.map(({ state: _state, sourceReportRef: _source, ...action }) =>
      structuredClone(action),
    ),
    feedbackDrafts: [],
    diagnostics: structuredClone(result.diagnostics),
    limitations: structuredClone(result.report.limitations),
  };
}

function reseal(checkpoint: InvestigationLoopCheckpointV1): InvestigationLoopCheckpointV1 {
  const { digest: _digest, ...content } = checkpoint;
  return { ...checkpoint, digest: investigationContentDigest(content) };
}

describe("rejected analysis checkpoints", () => {
  it("charges one invocation and preserves the entire accepted analysis and round", () => {
    const { checkpoint } = setup();
    const original = structuredClone(checkpoint);
    const request = rejection(checkpoint);
    const next = rejectInvestigationModelOutput(checkpoint, request, options);
    expect(next).toMatchObject({
      id: checkpoint.id,
      version: checkpoint.version + 1,
      previousCheckpointRef: reference(checkpoint),
      round: checkpoint.round,
      lastPhase: checkpoint.lastPhase,
      taskBindingDigest: checkpoint.taskBindingDigest,
      subjectRevisionKey: checkpoint.subjectRevisionKey,
      analysis: checkpoint.analysis,
      consumed: { rounds: 0, durationMs: 30, tokens: 120 },
      stopReason: "continuing",
    });
    expect(next.digest).not.toBe(checkpoint.digest);
    expect(next.runtime.modelOutputRejections).toEqual([
      {
        attemptId: checkpoint.attemptId,
        round: 1,
        invocationId: "invocation",
        issue,
        recordedAt,
      },
    ]);
    expect(next.runtime.unacceptedModelUsage).toBeUndefined();
    const { modelOutputRejections: _rejections, ...preservedRuntime } = next.runtime;
    expect(preservedRuntime).toEqual(checkpoint.runtime);
    expect(checkpoint).toEqual(original);
    request.issue.paths.push("/analysis/rechecks/0/findingId");
    expect(next.runtime.modelOutputRejections?.[0]?.issue.paths).toHaveLength(1);
    request.issue.paths.pop();
    expect(() => assertInvestigationCheckpointIntegrity(next)).not.toThrow();
  });

  it("requires the exact checkpoint, active attempt, and next analysis round", () => {
    const { checkpoint } = setup();
    for (const [patch, code] of [
      [{ attemptId: "other-attempt" }, "model_output_rejection_attempt_mismatch"],
      [{ round: 2 }, "round_sequence_mismatch"],
      [{ round: 0 }, "round_sequence_mismatch"],
      [
        { inputCheckpointRef: { ...reference(checkpoint), version: checkpoint.version + 1 } },
        "stale_checkpoint_reference",
      ],
      [
        { inputCheckpointRef: { ...reference(checkpoint), digest: "b".repeat(64) } },
        "stale_checkpoint_reference",
      ],
    ] as const) {
      expect(() =>
        rejectInvestigationModelOutput(checkpoint, { ...rejection(checkpoint), ...patch }, options),
      ).toThrowError(expect.objectContaining({ code }));
    }
    const stopped = interruptInvestigationLoop(checkpoint, "error", recordedAt);
    expect(() => rejectInvestigationModelOutput(stopped, rejection(stopped), options)).toThrowError(
      expect.objectContaining({ code: "loop_already_stopped" }),
    );
  });

  it("preserves the one-correction quota across a runtime checkpoint and serialized recovery", () => {
    const { checkpoint } = setup();
    const rejected = rejectInvestigationModelOutput(checkpoint, rejection(checkpoint), options);
    const persisted: InvestigationLoopCheckpointV1 = JSON.parse(JSON.stringify(rejected));
    const advanced = applyInvestigationRuntimeCheckpoint(persisted, persisted.runtime, {
      recordedAt,
    });
    expect(() =>
      rejectInvestigationModelOutput(advanced, rejection(advanced, "another-invocation"), options),
    ).toThrowError(expect.objectContaining({ code: "model_output_correction_exhausted" }));
    expect(() =>
      rejectInvestigationModelOutput(advanced, rejection(advanced), options),
    ).toThrowError(expect.objectContaining({ code: "model_output_rejection_invocation_reused" }));
  });

  it("preserves rejection history on restore and permits one correction in the new attempt", () => {
    const { checkpoint, task } = setup();
    const rejected = rejectInvestigationModelOutput(checkpoint, rejection(checkpoint), options);
    const stopped = interruptInvestigationLoop(rejected, "error", recordedAt);
    const resumed = restoreInvestigationCheckpoint({
      checkpoint: stopped,
      task,
      attemptId: "resumed-attempt",
      leaseVersion: 2,
      recordedAt,
    });
    expect(resumed.runtime.modelOutputRejections).toEqual(rejected.runtime.modelOutputRejections);
    expect(() => rejectInvestigationModelOutput(resumed, rejection(resumed), options)).toThrowError(
      expect.objectContaining({ code: "model_output_rejection_invocation_reused" }),
    );
    const second = rejectInvestigationModelOutput(
      resumed,
      rejection(resumed, "resumed-invocation"),
      {
        ...options,
        accountedTokens: 250,
      },
    );
    expect(second.runtime.modelOutputRejections).toHaveLength(2);
    expect(second.consumed).toMatchObject({ rounds: 0, durationMs: 60, tokens: 250 });
  });

  it("retains rejected usage when the corrected analysis completes and delivery is restored", () => {
    const { checkpoint, task, result } = setup();
    const rejected = rejectInvestigationModelOutput(checkpoint, rejection(checkpoint), options);
    const completed = applyInvestigationLoopRound(
      rejected,
      {
        schemaVersion: "InvestigationLoopRoundV1",
        taskId: rejected.taskId,
        attemptId: rejected.attemptId,
        inputCheckpointRef: reference(rejected),
        round: 1,
        phase: "investigation",
        analysis: completeAnalysis(result),
        continue: false,
        continuationReason: "The corrected analysis is complete.",
      },
      { recordedAt, usage: { durationMs: 20, tokens: 80, reportBytes: 0 }, accountedTokens: 200 },
    );
    expect(completed.stopReason).toBe("complete");
    expect(completed.consumed).toMatchObject({ rounds: 1, durationMs: 50, tokens: 200 });
    expect(completed.runtime.modelOutputRejections).toEqual(rejected.runtime.modelOutputRejections);
    expect(completed.runtime.unacceptedModelUsage).toBeUndefined();
    const restored = restoreCompletedInvestigationForDelivery({
      checkpoint: completed,
      task,
      attemptId: "delivery-attempt",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.runtime.modelOutputRejections).toEqual(rejected.runtime.modelOutputRejections);
  });

  it("rejects injection, removal, and mutation of rejection history in execution receipts", () => {
    const { checkpoint } = setup();
    const rejected = rejectInvestigationModelOutput(checkpoint, rejection(checkpoint), options);
    const altered = structuredClone(rejected.runtime);
    altered.modelOutputRejections![0]!.invocationId = "replacement";
    for (const [input, runtime] of [
      [checkpoint, rejected.runtime],
      [rejected, checkpoint.runtime],
      [rejected, altered],
      [rejected, { ...rejected.runtime, modelOutputRejections: [] }],
    ] as const) {
      expect(() =>
        applyInvestigationRuntimeCheckpoint(input, runtime, { recordedAt }),
      ).toThrowError(
        expect.objectContaining({ code: "model_output_rejection_history_is_trusted" }),
      );
    }
  });

  it("never corrects subject, binding, permission, immutable, or Worker observation failures", () => {
    const { checkpoint } = setup();
    for (const unsafe of [
      { rule: "reference_outside_batch", paths: ["/analysis/evidence/0/subjectRef"] },
      { rule: "reference_outside_batch", paths: ["/runtime/evidence/0/evidenceRefs/0"] },
      { rule: "reference_outside_batch", paths: ["/analysis/assessment/secret/evidenceRefs/0"] },
      { rule: "delta_binding", paths: ["/taskId"] },
      { rule: "immutable_record_changed", paths: ["/analysis/evidence/0/id"] },
      { rule: "trusted_evidence_collision", paths: ["/analysis/evidence/0/id"] },
      { ...issue, message: "Untrusted response value" },
    ]) {
      expect(() =>
        rejectInvestigationModelOutput(
          checkpoint,
          {
            ...rejection(checkpoint),
            issue: unsafe as InvestigationModelOutputRejectionIssue,
          },
          options,
        ),
      ).toThrowError(expect.objectContaining({ code: "model_output_rejection_not_correctable" }));
    }
  });

  it("stops at token, duration, or retained report budget exhaustion without advancing the round", () => {
    for (const field of ["maxTokens", "maxDurationMs", "maxReportBytes"] as const) {
      const { checkpoint } = setup();
      const constrained = reseal({
        ...checkpoint,
        budget: {
          ...checkpoint.budget,
          [field]: field === "maxTokens" ? 120 : field === "maxDurationMs" ? 30 : 1,
        },
      });
      const next = rejectInvestigationModelOutput(constrained, rejection(constrained), options);
      expect(next.stopReason).toBe("budget_exhausted");
      expect(next.round).toBe(0);
      expect(next.consumed.rounds).toBe(0);
      expect(next.analysis).toEqual(checkpoint.analysis);
    }
  });

  it("rejects invalid accounting totals, elapsed time, and rejection identities", () => {
    const { checkpoint } = setup();
    for (const overrides of [
      { accountedTokens: -1 },
      { accountedTokens: 1.5 },
      { accountedTokens: Number.MAX_SAFE_INTEGER + 1 },
      { durationMs: -1 },
      { durationMs: 0.5 },
      { durationMs: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() =>
        rejectInvestigationModelOutput(checkpoint, rejection(checkpoint), {
          ...options,
          ...overrides,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_worker_consumption" }));
    }
    for (const invocationId of ["", "untrusted/value", "x".repeat(129)]) {
      expect(() =>
        rejectInvestigationModelOutput(checkpoint, rejection(checkpoint, invocationId), options),
      ).toThrowError(expect.objectContaining({ code: "invalid_model_output_rejection_history" }));
    }
    const charged = reseal({ ...checkpoint, consumed: { ...checkpoint.consumed, tokens: 121 } });
    expect(() => rejectInvestigationModelOutput(charged, rejection(charged), options)).toThrowError(
      expect.objectContaining({ code: "invalid_worker_consumption" }),
    );
  });

  it("checks persisted rejection metadata even when the checkpoint digest is consistent", () => {
    const { checkpoint } = setup();
    const rejected = rejectInvestigationModelOutput(checkpoint, rejection(checkpoint), options);
    for (const patch of [
      { attemptId: "unknown-attempt" },
      { round: 2 },
      { recordedAt: "invalid" },
      { issue: { ...issue, paths: ["/analysis/evidence/0/subjectRef"] } },
      { rawProposal: "Untrusted response value" },
    ]) {
      const changed = structuredClone(rejected);
      Object.assign(changed.runtime.modelOutputRejections![0]!, patch);
      expect(() => assertInvestigationCheckpointIntegrity(reseal(changed))).toThrowError(
        expect.objectContaining({ code: "invalid_model_output_rejection_history" }),
      );
    }
    const duplicate = structuredClone(rejected);
    duplicate.runtime.modelOutputRejections!.push({
      ...duplicate.runtime.modelOutputRejections![0]!,
      invocationId: "another-invocation",
    });
    expect(() => assertInvestigationCheckpointIntegrity(reseal(duplicate))).toThrowError(
      expect.objectContaining({ code: "invalid_model_output_rejection_history" }),
    );
  });
});
