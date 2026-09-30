import {
  createInvestigationPreview,
  type InvestigationAnalysisV1,
  type InvestigationCandidate,
  type InvestigationLoopCheckpointV1,
  type InvestigationLoopRoundV1,
  type InvestigationPrDiffManifestV1,
  type InvestigationReviewBaselineDescriptor,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";

import {
  applyInvestigationLoopRound,
  applyInvestigationRuntimeCheckpoint,
  applyInvestigationSourceCoverage,
  assertInvestigationCheckpointIntegrity,
  createInvestigationCheckpoint,
  evaluateInvestigationCompletion,
  interruptInvestigationLoop,
  investigationContentDigest,
  investigationTaskBindingDigest,
  restoreInvestigationCheckpoint,
} from "./investigation-loop.js";

const recordedAt = "2026-10-01T04:00:00.000Z";
const currentEvidenceId = "current-review-static-evidence";
const options = { recordedAt, usage: { durationMs: 10, tokens: 100, reportBytes: 1_000 } };

function setup(findingCount = 1, sameRevision = false) {
  const previous = createInvestigationPreview("pr", { findingCount });
  const current = createInvestigationPreview("pr", { findingCount: 0 });
  const task = structuredClone(current.task);
  const subject = task.subjects[0]!;
  const previousSubject = structuredClone(previous.task.subjects[0]!);
  if (subject.kind !== "original_pr" || previousSubject.kind !== "original_pr")
    throw new Error("The review fixture must contain original PR subjects.");
  previousSubject.id = "previous-pr-subject";
  subject.headSha = sameRevision ? previousSubject.headSha : "e".repeat(40);
  subject.revisionKey = sameRevision ? previousSubject.revisionKey : "f".repeat(64);
  task.id = "current-review-task";
  task.state = "queued";
  task.latestReportRef = null;
  const baseline: InvestigationReviewBaselineDescriptor = {
    reportRef: { id: previous.result.id, version: previous.result.version, digest: "c".repeat(64) },
    sourceTaskId: previous.task.id,
    subject: previousSubject,
    findings: previous.result.findings.map(({ id, version, title }) => ({ id, version, title })),
  };
  task.reviewBaseline = baseline;
  const initial = createInvestigationCheckpoint({
    task,
    attemptId: "current-review-attempt-1",
    checkpointId: "current-review-checkpoint",
    leaseVersion: 1,
    recordedAt,
  });
  const path = "src/settings-ui/Settings.UI/Services/SettingsPersistence.cs";
  const chunks = (["diff", "base", "head"] as const).map((kind) => ({
    id: `current-source-${kind}`,
    path,
    kind,
    ordinal: 0,
    encoding: "utf8" as const,
    contentDigest: "a".repeat(64),
    byteLength: 100,
  }));
  const payload = {
    schemaVersion: "InvestigationPrDiffManifestV1" as const,
    subjectRef: subject.id,
    baseSha: subject.baseSha,
    headSha: subject.headSha,
    mergeBaseSha: subject.baseSha,
    files: [
      {
        path,
        previousPath: null,
        status: "modified" as const,
        chunkIds: chunks.map((chunk) => chunk.id),
      },
    ],
    chunks,
  };
  const manifest: InvestigationPrDiffManifestV1 = {
    ...payload,
    digest: investigationContentDigest(payload),
  };
  const checkpoint = applyInvestigationSourceCoverage(initial, manifest, { task, recordedAt });
  return { previous, current, task, baseline, checkpoint };
}

function round(
  checkpoint: InvestigationLoopCheckpointV1,
  analysis: InvestigationAnalysisV1,
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
    phase: "discovery",
    analysis,
    continue: false,
    continuationReason: "Complete the new review with fresh current-source evidence.",
  };
}

function currentAnalysis(checkpoint: InvestigationLoopCheckpointV1): InvestigationAnalysisV1 {
  const analysis = structuredClone(checkpoint.analysis);
  const subjectRef = analysis.assessment.subjectRef;
  analysis.summary = "The complete current review scope has been inspected.";
  analysis.evidence = [
    {
      id: currentEvidenceId,
      subjectRef,
      source: "static_analysis",
      summary: "The current source now checks cancellation before committing settings.",
      evidenceRefs: [],
    },
  ];
  for (const unit of analysis.coverage.includedUnits) {
    unit.status = "completed";
    unit.evidenceRefs = [currentEvidenceId];
  }
  analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits.map((unit) => unit.id);
  analysis.coverage.unresolvedUnitRefs = [];
  analysis.assessment.summary = analysis.summary;
  analysis.assessment.evidenceRefs = [currentEvidenceId];
  if (analysis.assessment.kind === "pr")
    analysis.assessment.reviewConclusion = {
      status: "no-blocking-findings",
      rationale: "The current source review found no retained blocking defects.",
    };
  return analysis;
}

function fixedAnalysis(checkpoint: InvestigationLoopCheckpointV1): InvestigationAnalysisV1 {
  const analysis = currentAnalysis(checkpoint);
  for (const candidate of analysis.candidates) {
    candidate.status = "withdrawn";
    candidate.reviewDisposition = "fixed";
    candidate.rationale = "The new current source guard prevents the previous cancellation defect.";
    candidate.evidenceRefs = [currentEvidenceId];
  }
  return analysis;
}

function stillPresentAnalysis(
  context: ReturnType<typeof setup>,
  withRecheck = true,
): InvestigationAnalysisV1 {
  const analysis = currentAnalysis(context.checkpoint);
  const finding = structuredClone(context.previous.result.findings[0]!);
  finding.id = "current-review-finding";
  finding.subjectRef = context.task.subjectRef;
  finding.rootCause.evidenceRefs = [currentEvidenceId];
  finding.evidenceRefs = [currentEvidenceId];
  finding.confirmation.evidenceRefs = [currentEvidenceId];
  finding.confirmation.recheckRef = "current-review-recheck";
  finding.fixRecommendation.planRef = null;
  for (const location of finding.locations) location.subjectRef = context.task.subjectRef;
  if (finding.feedbackDraft.suggestion !== null) {
    finding.feedbackDraft.suggestion.subjectRef = context.task.subjectRef;
    const subject = context.task.subjects[0]!;
    if (subject.kind === "original_pr") finding.feedbackDraft.suggestion.headSha = subject.headSha;
  }
  analysis.findings = [finding];
  const candidate = analysis.candidates[0]!;
  candidate.status = "confirmed";
  candidate.reviewDisposition = "still_present";
  candidate.findingId = finding.id;
  candidate.findingVersion = finding.version;
  candidate.rationale = "The current source still has the same cancellation defect.";
  candidate.evidenceRefs = [currentEvidenceId];
  analysis.evidence[0]!.summary = "The current source still commits without checking cancellation.";
  if (analysis.assessment.kind === "pr")
    analysis.assessment.reviewConclusion = {
      status: "changes-requested",
      rationale: "The current source retains the confirmed cancellation defect.",
    };
  if (withRecheck)
    analysis.rechecks = [
      {
        id: finding.confirmation.recheckRef!,
        findingId: finding.id,
        findingVersion: finding.version,
        subjectRef: finding.subjectRef,
        round: context.checkpoint.round + 1,
        evidenceRefs: [currentEvidenceId],
        conclusion: "The current finding version remains supported by the current source.",
        unresolvedQuestions: [],
      },
    ];
  return analysis;
}

function reseal(checkpoint: InvestigationLoopCheckpointV1): InvestigationLoopCheckpointV1 {
  const { digest: _digest, ...content } = checkpoint;
  return { ...checkpoint, digest: investigationContentDigest(content) };
}

function seed(analysis: InvestigationAnalysisV1): InvestigationCandidate {
  const candidate = analysis.candidates.find(
    (entry) => entry.reviewBaselineFindingRef !== undefined,
  );
  if (candidate === undefined) throw new Error("The baseline candidate must be seeded.");
  return candidate;
}

describe("review baseline checkpoint isolation", () => {
  it("keeps a first review free of comparison state", () => {
    const { task } = createInvestigationPreview("pr", { findingCount: 0 });
    const checkpoint = createInvestigationCheckpoint({
      task,
      attemptId: "first-review-attempt",
      checkpointId: "first-review-checkpoint",
      leaseVersion: 1,
      recordedAt,
    });
    expect(checkpoint.runtime.reviewBaseline).toBeUndefined();
    expect(checkpoint.analysis.candidates).toEqual([]);
    const completed = applyInvestigationLoopRound(
      checkpoint,
      round(checkpoint, currentAnalysis(checkpoint)),
      options,
    );
    expect(completed.stopReason).toBe("complete");
  });

  it("seeds every previous finding without copying previous findings, evidence, or rechecks", () => {
    const { task, baseline, checkpoint } = setup(137);
    expect(checkpoint.analysis.candidates).toHaveLength(137);
    expect(
      checkpoint.analysis.candidates.map((candidate) => candidate.reviewBaselineFindingRef),
    ).toEqual(baseline.findings.map(({ id, version }) => ({ id, version })));
    expect(
      checkpoint.analysis.candidates.every(
        (candidate) =>
          candidate.subjectRef === task.subjectRef &&
          candidate.discoveredRound === 0 &&
          candidate.status === "pending" &&
          candidate.reviewDisposition === "pending" &&
          candidate.findingId === null &&
          candidate.findingVersion === null &&
          candidate.evidenceRefs.length === 0,
      ),
    ).toBe(true);
    expect(checkpoint.analysis.findings).toEqual([]);
    expect(checkpoint.analysis.rechecks).toEqual([]);
    expect(checkpoint.analysis.evidence).toEqual([]);
    expect(checkpoint.runtime.evidence).toEqual([]);
    expect(checkpoint.runtime.subjects).toEqual([]);
    expect(checkpoint.runtime.reviewBaseline).toEqual(baseline);
    expect(checkpoint.runtime.reviewBaseline).not.toBe(task.reviewBaseline);
    expect(task.parentTaskId).toBeNull();
    expect(task.parentReportRef).toBeNull();
    expect(task.subjects.map((subject) => subject.id)).not.toContain(baseline.subject.id);
  });

  it("preserves round-zero baseline candidates when cancelled before the model starts", () => {
    const { checkpoint } = setup(2);
    const cancelled = interruptInvestigationLoop(checkpoint, "cancelled", recordedAt);
    expect(cancelled.round).toBe(0);
    expect(cancelled.stopReason).toBe("cancelled");
    expect(cancelled.analysis.candidates).toEqual(checkpoint.analysis.candidates);
    expect(
      cancelled.analysis.candidates.every((candidate) => candidate.discoveredRound === 0),
    ).toBe(true);
    expect(() => assertInvestigationCheckpointIntegrity(cancelled)).not.toThrow();
  });

  it("binds baseline identity, source revision, and every finding version into the task digest", () => {
    const { task } = setup();
    const digest = investigationTaskBindingDigest(task);
    const changes: Array<(changed: InvestigationTaskV1) => void> = [
      (changed) => {
        delete changed.reviewBaseline;
      },
      (changed) => {
        changed.reviewBaseline!.reportRef.digest = "9".repeat(64);
      },
      (changed) => {
        changed.reviewBaseline!.sourceTaskId = "different-previous-task";
      },
      (changed) => {
        changed.reviewBaseline!.subject.headSha = "8".repeat(40);
      },
      (changed) => {
        changed.reviewBaseline!.findings[0]!.version += 1;
      },
      (changed) => {
        changed.reviewBaseline!.findings[0]!.title = "Changed baseline title";
      },
    ];
    for (const change of changes) {
      const changed = structuredClone(task);
      change(changed);
      expect(investigationTaskBindingDigest(changed)).not.toBe(digest);
    }
  });

  it("does not allow execution receipts to remove or replace the frozen baseline", () => {
    const { checkpoint } = setup();
    const missing = structuredClone(checkpoint.runtime);
    delete missing.reviewBaseline;
    expect(() =>
      applyInvestigationRuntimeCheckpoint(checkpoint, missing, { recordedAt }),
    ).toThrowError(expect.objectContaining({ code: "review_baseline_is_trusted" }));
    const changed = structuredClone(checkpoint.runtime);
    changed.reviewBaseline!.reportRef.version += 1;
    expect(() =>
      applyInvestigationRuntimeCheckpoint(checkpoint, changed, { recordedAt }),
    ).toThrowError(expect.objectContaining({ code: "review_baseline_is_trusted" }));
  });
});

describe("review baseline completion", () => {
  it("completes a new-SHA fixed conclusion using fresh static evidence without claiming runtime validation", () => {
    const { checkpoint } = setup();
    const completed = applyInvestigationLoopRound(
      checkpoint,
      round(checkpoint, fixedAnalysis(checkpoint)),
      options,
    );
    expect(completed.stopReason).toBe("complete");
    expect(evaluateInvestigationCompletion(completed).reasonCodes).toEqual([]);
    expect(seed(completed.analysis).reviewDisposition).toBe("fixed");
    expect(completed.analysis.findings).toEqual([]);
    expect(completed.analysis.rechecks).toEqual([]);
    expect(completed.runtime.checks).toEqual([]);
    expect(completed.runtime.completedSteps).toEqual([]);
  });

  it("rejects a fixed conclusion for an unchanged source revision", () => {
    const { checkpoint } = setup(1, true);
    expect(() =>
      applyInvestigationLoopRound(
        checkpoint,
        round(checkpoint, fixedAnalysis(checkpoint)),
        options,
      ),
    ).toThrowError(expect.objectContaining({ code: "review_baseline_candidate_invalid" }));
  });

  it("can reject the previous diagnosis on the same revision using fresh source evidence", () => {
    const { checkpoint } = setup(1, true);
    const analysis = fixedAnalysis(checkpoint);
    seed(analysis).reviewDisposition = "not_confirmed";
    seed(analysis).rationale =
      "The current source already protects the reported cancellation path.";
    const completed = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    expect(completed.stopReason).toBe("complete");
    expect(seed(completed.analysis).reviewDisposition).toBe("not_confirmed");
  });

  it("retains an evidence-linked limitation when a previous finding cannot be verified", () => {
    const { checkpoint } = setup();
    const analysis = fixedAnalysis(checkpoint);
    seed(analysis).reviewDisposition = "unverified";
    seed(analysis).rationale =
      "The current source was inspected, but the original runtime path is unclear.";
    analysis.limitations = [
      {
        id: "previous-runtime-path-unverified",
        description: "The previous report does not identify the observed runtime path.",
        impact: "The prior defect cannot be confirmed or described as fixed.",
        evidenceRefs: [currentEvidenceId],
      },
    ];
    const completed = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    expect(completed.stopReason).toBe("complete");
    expect(seed(completed.analysis).reviewDisposition).toBe("unverified");
    expect(completed.analysis.limitations).toEqual(analysis.limitations);
  });

  it("does not complete while a previous finding remains pending", () => {
    const { checkpoint } = setup();
    const accepted = applyInvestigationLoopRound(
      checkpoint,
      round(checkpoint, currentAnalysis(checkpoint)),
      options,
    );
    expect(accepted.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(accepted).pendingCandidateIds).toContain(
      seed(accepted.analysis).id,
    );
    expect(evaluateInvestigationCompletion(accepted).complete).toBe(false);
  });

  it("cannot hide previous findings by deleting all baseline candidates", () => {
    const { checkpoint } = setup();
    const analysis = currentAnalysis(checkpoint);
    analysis.candidates = [];
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options),
    ).toThrow();
    const missing = reseal({ ...checkpoint, analysis, round: 1, lastPhase: "discovery" });
    expect(evaluateInvestigationCompletion(missing).reasonCodes).toContain(
      "review_baseline_candidates_incomplete",
    );
  });

  it.each(["reference", "version", "discovery", "subject", "disposition"] as const)(
    "rejects a seeded candidate whose %s is removed or replaced",
    (field) => {
      const { checkpoint } = setup();
      const analysis = fixedAnalysis(checkpoint);
      const candidate = seed(analysis);
      if (field === "reference") delete candidate.reviewBaselineFindingRef;
      if (field === "version") candidate.reviewBaselineFindingRef!.version += 1;
      if (field === "discovery") candidate.discoveredRound = 1;
      if (field === "subject") candidate.subjectRef = "previous-pr-subject";
      if (field === "disposition") delete candidate.reviewDisposition;
      expect(() =>
        applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options),
      ).toThrow();
    },
  );

  it("does not allow two seeded candidates to exchange their previous finding identities", () => {
    const { checkpoint } = setup(2);
    const analysis = fixedAnalysis(checkpoint);
    const first = analysis.candidates[0]!;
    const second = analysis.candidates[1]!;
    [first.reviewBaselineFindingRef, second.reviewBaselineFindingRef] = [
      second.reviewBaselineFindingRef,
      first.reviewBaselineFindingRef,
    ];
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options),
    ).toThrow();
  });

  it("rejects a newly invented candidate that impersonates a frozen baseline finding", () => {
    const { checkpoint } = setup();
    const analysis = fixedAnalysis(checkpoint);
    analysis.candidates.push({
      ...seed(analysis),
      id: "impersonated-baseline-candidate",
      discoveredRound: 1,
    });
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options),
    ).toThrow();
  });

  it("does not accept old-subject static evidence as proof that the current source is fixed", () => {
    const { checkpoint, baseline } = setup();
    const analysis = fixedAnalysis(checkpoint);
    analysis.evidence[0]!.subjectRef = baseline.subject.id;
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options),
    ).toThrowError(expect.objectContaining({ code: "review_baseline_candidate_invalid" }));
  });

  it("does not accept a reporter statement as proof that the current source is fixed", () => {
    const { checkpoint } = setup();
    const analysis = fixedAnalysis(checkpoint);
    analysis.evidence[0]!.source = "reporter_statement";
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options),
    ).toThrowError(expect.objectContaining({ code: "review_baseline_candidate_invalid" }));
  });

  it("requires a fresh final-version recheck for a still-present finding", () => {
    const context = setup();
    const accepted = applyInvestigationLoopRound(
      context.checkpoint,
      round(context.checkpoint, stillPresentAnalysis(context, false)),
      options,
    );
    expect(accepted.stopReason).toBe("continuing");
    expect(evaluateInvestigationCompletion(accepted).pendingFindingIds).toEqual([
      "current-review-finding",
    ]);
    const reviewed = stillPresentAnalysis(context);
    reviewed.rechecks[0]!.round = accepted.round + 1;
    const completed = applyInvestigationLoopRound(accepted, round(accepted, reviewed), options);
    expect(completed.stopReason).toBe("complete");
    expect(completed.analysis.rechecks.map((entry) => entry.id)).toEqual([
      "current-review-recheck",
    ]);
    expect(seed(completed.analysis).reviewBaselineFindingRef!.id).not.toBe(
      completed.analysis.findings[0]!.id,
    );
  });

  it("preserves accepted baseline review work on restore and rejects a changed baseline", () => {
    const { checkpoint, task } = setup(2);
    const analysis = currentAnalysis(checkpoint);
    Object.assign(analysis.candidates[0]!, {
      status: "withdrawn",
      reviewDisposition: "fixed",
      rationale: "The current source guards this previous finding.",
      evidenceRefs: [currentEvidenceId],
    });
    const accepted = applyInvestigationLoopRound(checkpoint, round(checkpoint, analysis), options);
    const interrupted = interruptInvestigationLoop(accepted, "interrupted", recordedAt);
    const restored = restoreInvestigationCheckpoint({
      checkpoint: interrupted,
      task,
      attemptId: "current-review-attempt-2",
      leaseVersion: 2,
      recordedAt,
    });
    expect(restored.analysis).toEqual(accepted.analysis);
    expect(restored.runtime.reviewBaseline).toEqual(checkpoint.runtime.reviewBaseline);
    expect(restored.analysis.candidates.map((candidate) => candidate.reviewDisposition)).toEqual([
      "fixed",
      "pending",
    ]);
    const changedTask = structuredClone(task);
    changedTask.reviewBaseline!.findings[0]!.version += 1;
    expect(() =>
      restoreInvestigationCheckpoint({
        checkpoint: interrupted,
        task: changedTask,
        attemptId: "current-review-attempt-3",
        leaseVersion: 3,
        recordedAt,
      }),
    ).toThrowError(expect.objectContaining({ code: "checkpoint_task_binding_mismatch" }));
  });
});
