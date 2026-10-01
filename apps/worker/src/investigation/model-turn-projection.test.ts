import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationReviewBaselineSnapshot,
  isCorrectableInvestigationModelOutputIssue,
} from "@agentic-review/contracts";
import {
  applyInvestigationLoopRound,
  createInvestigationCheckpoint,
  investigationContentDigest,
  normalizeInvestigationAnalysisPlanReferences,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ModelOutputValidationError,
  safeModelOutputValidationIssue,
} from "./model-output-diagnostics.js";
import {
  InvestigationModelCandidateSchema,
  type InvestigationModelTurnDeltaV1,
  InvestigationModelTurnDeltaV1Schema,
  type ModelTurnProjection,
  ModelTurnProjectionError,
  mergeModelTurnDelta,
  prepareModelTurnProjection,
} from "./model-turn-projection.js";

function fixture(findingCount = 4) {
  const synthetic = createInvestigationFixture("pr", { findingCount });
  const task = structuredClone(synthetic.task);
  task.budget.maxRounds = 100;
  task.budget.maxReportBytes = 32 * 1024 * 1024;
  const analysis: InvestigationAnalysisV1 = {
    schemaVersion: "InvestigationAnalysisV1",
    summary: "All scope is retained for independent final rechecks.",
    coverage: synthetic.result.report.coverage,
    findings: synthetic.result.findings,
    assessment: synthetic.result.assessment,
    candidates: synthetic.result.report.loop.candidates,
    rechecks: synthetic.result.report.recheck.records,
    evidence: synthetic.result.verificationEvidence.flatMap((entry) =>
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
    plans: synthetic.result.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...plan }) => plan,
    ),
    nextActions: synthetic.result.nextActions.map(
      ({ state: _state, sourceReportRef: _source, ...action }) => action,
    ),
    feedbackDrafts: synthetic.result.feedbackDrafts,
    diagnostics: synthetic.result.diagnostics,
    limitations: synthetic.result.report.limitations,
  };
  for (const finding of analysis.findings) finding.confirmation.recheckRef = null;
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: synthetic.attempt.id,
    checkpointId: "projection-checkpoint",
    leaseVersion: synthetic.attempt.leaseVersion,
    recordedAt: task.updatedAt,
  });
  delete checkpoint.runtime.reviewMode;
  checkpoint.analysis = normalizeInvestigationAnalysisPlanReferences(analysis);
  checkpoint.round = 1;
  checkpoint.lastPhase = "discovery";
  return { task, attempt: synthetic.attempt, checkpoint: seal(checkpoint) };
}

function sourceContinuationFixture() {
  const f = fixture(1);
  const analysis = f.checkpoint.analysis;
  const candidate = analysis.candidates[0]!;
  candidate.status = "pending";
  candidate.findingId = null;
  candidate.findingVersion = null;
  candidate.evidenceRefs = ["candidate-source-evidence"];
  analysis.findings = [];
  analysis.rechecks = [];
  analysis.evidence = [
    {
      id: "first-chunk-leaf",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary: "The first complete diff chunk exposes the source condition.",
      evidenceRefs: [],
    },
    {
      id: "first-chunk-summary",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary: "The accepted first-chunk review preserves its original evidence.",
      evidenceRefs: ["first-chunk-leaf"],
    },
    {
      id: "candidate-source-evidence",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary: "The candidate requires a separate disposition using the first chunk.",
      evidenceRefs: ["first-chunk-summary"],
    },
    {
      id: "second-chunk-summary",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary: "The second complete diff chunk was also inspected.",
      evidenceRefs: [],
    },
  ];
  const metadata: InvestigationAnalysisV1["coverage"]["includedUnits"][number] = {
    id: "original-full-diff",
    subjectRef: f.task.subjectRef,
    kind: "full_diff",
    paths: [],
    requiredWork: "Review the full frozen diff and resolve its source-backed candidates.",
    status: "blocked",
    evidenceRefs: [],
  };
  const chunks: InvestigationAnalysisV1["coverage"]["includedUnits"] = [
    {
      id: "first-completed-chunk",
      subjectRef: f.task.subjectRef,
      kind: "pr_diff_chunk",
      paths: ["src/first.ts"],
      requiredWork: "Inspect the first complete diff chunk.",
      status: "completed",
      evidenceRefs: ["first-chunk-summary"],
    },
    {
      id: "second-completed-chunk",
      subjectRef: f.task.subjectRef,
      kind: "pr_diff_chunk",
      paths: ["src/second.ts"],
      requiredWork: "Inspect the second complete diff chunk.",
      status: "completed",
      evidenceRefs: ["second-chunk-summary"],
    },
  ];
  analysis.coverage.includedUnits = [metadata, ...chunks];
  analysis.coverage.completedUnitRefs = chunks.map((unit) => unit.id);
  analysis.coverage.unresolvedUnitRefs = [metadata.id];
  return { ...f, metadata, chunks, candidate };
}

function reviewBaselineFixture(findingCount = 3, historicalDetailRepeats = 0) {
  const f = fixture(0);
  const historical = createInvestigationFixture("pr", { findingCount });
  const subject = structuredClone(historical.task.subjects[0]!);
  if (subject.kind !== "original_pr")
    throw new Error("The historical review fixture must have an original PR subject.");
  subject.id = "previous-native-review-subject";
  subject.headSha = "7".repeat(40);
  subject.revisionKey = "8".repeat(64);
  const findings = structuredClone(historical.result.findings);
  for (const finding of findings) {
    finding.subjectRef = subject.id;
    finding.locations = finding.locations.map((location) => ({
      ...location,
      subjectRef: subject.id,
    }));
    if (finding.feedbackDraft.suggestion !== null) {
      finding.feedbackDraft.suggestion.subjectRef = subject.id;
      finding.feedbackDraft.suggestion.headSha = subject.headSha;
    }
    finding.rootCause.explanation += " Historical root cause evidence is retained in full.".repeat(
      historicalDetailRepeats,
    );
  }
  const reviewBaseline: InvestigationReviewBaselineSnapshot = {
    descriptor: {
      reportRef: { id: "previous-native-review-report", version: 4, digest: "6".repeat(64) },
      sourceTaskId: "previous-native-review-task",
      subject,
      findings: findings.map(({ id, version, title }) => ({ id, version, title })),
    },
    findings,
  };
  f.task.reviewBaseline = structuredClone(reviewBaseline.descriptor);
  const checkpoint = createInvestigationCheckpoint({
    task: f.task,
    attemptId: f.attempt.id,
    checkpointId: "review-baseline-projection-checkpoint",
    leaseVersion: f.attempt.leaseVersion,
    recordedAt: f.task.updatedAt,
  });
  checkpoint.analysis.evidence = structuredClone(f.checkpoint.analysis.evidence);
  checkpoint.round = 1;
  checkpoint.lastPhase = "discovery";
  delete checkpoint.runtime.reviewMode;
  return { task: f.task, attempt: f.attempt, checkpoint: seal(checkpoint), reviewBaseline };
}

function focusedSourceContinuationFixture() {
  const f = sourceContinuationFixture();
  f.task.executionPolicy.mode = "source_read";
  f.candidate.evidenceRefs = [];
  const chunks = Array.from({ length: 68 }, (_, index) => ({
    ...f.chunks[0]!,
    id: `completed-changed-chunk-${index}`,
    paths: [`src/changed/file-${index}.ts`],
  }));
  const core: InvestigationAnalysisV1["coverage"]["includedUnits"][number] = {
    id: "pending-core-source",
    subjectRef: f.task.subjectRef,
    kind: "source_file",
    paths: ["src/Core.cs"],
    requiredWork: "Read Core and preserve all source-backed dependencies.",
    status: "pending",
    evidenceRefs: ["core-summary"],
  };
  f.checkpoint.analysis.evidence.push(
    {
      id: "core-leaf",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary: "The retained Core source condition needs further investigation.",
      evidenceRefs: [],
    },
    {
      id: "core-summary",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary: "The pending Core analysis retains its accepted evidence dependency.",
      evidenceRefs: ["core-leaf"],
    },
  );
  f.checkpoint.analysis.coverage.includedUnits = [f.metadata, ...chunks, core];
  f.checkpoint.analysis.coverage.completedUnitRefs = chunks.map((unit) => unit.id);
  f.checkpoint.analysis.coverage.unresolvedUnitRefs = [f.metadata.id, core.id];
  f.checkpoint.runtime.evidence = [
    {
      id: "unrelated-worker-observation",
      subjectRef: f.task.subjectRef,
      source: "executor_observation",
      authority: "worker",
      summary: "An unrelated authorized check still needs an analysis summary.",
      artifactRefs: [],
      evidenceRefs: [],
      provenance: {
        taskId: f.task.id,
        attemptId: f.attempt.id,
        producer: "Synthetic executor",
        recordedAt: f.task.updatedAt,
      },
    },
  ];
  return { ...f, chunks, core };
}

function readonlySourceRecord(unit: InvestigationAnalysisV1["coverage"]["includedUnits"][number]) {
  const { id, subjectRef, kind, paths, status, evidenceRefs } = unit;
  return { id, subjectRef, kind, paths, status, evidenceRefs };
}

function seal(checkpoint: InvestigationLoopCheckpointV1): InvestigationLoopCheckpointV1 {
  const { digest: _digest, ...content } = checkpoint;
  return { ...checkpoint, digest: investigationContentDigest(content) };
}

function snapshotProjection(): ModelTurnProjection {
  const { task, attempt } = createInvestigationFixture("bug", { findingCount: 0 });
  task.executionPolicy.mode = "snapshot_only";
  task.scope.includedUnits = task.scope.includedUnits.map((unit) => ({
    ...unit,
    status: "pending" as const,
    evidenceRefs: [],
  }));
  task.scope.completedUnitRefs = [];
  task.scope.unresolvedUnitRefs = task.scope.includedUnits.map((unit) => unit.id);
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "snapshot-projection-checkpoint",
    leaseVersion: attempt.leaseVersion,
    recordedAt: task.updatedAt,
  });
  return prepareModelTurnProjection({ task, attempt, checkpoint, maximumContextBytes: 32 * 1024 });
}

function emptyDelta(projection: ModelTurnProjection): InvestigationModelTurnDeltaV1 {
  return {
    schemaVersion: "InvestigationModelTurnDeltaV1",
    taskId: projection.context.task.id,
    attemptId: projection.context.attempt.id,
    inputCheckpointRef: projection.context.inputCheckpointRef,
    round: projection.context.round,
    phase: projection.phase,
    continue: false,
    continuationReason: "All records in the supplied batch have been considered.",
    analysis: {
      summary: null,
      assessment: null,
      coverageUnits: [],
      findings: [],
      candidates: [],
      rechecks: [],
      evidence: [],
      plans: [],
      nextActions: [],
      feedbackDrafts: [],
      diagnostics: [],
      limitations: [],
      removedFindingIds: [],
    },
  };
}

function recheckDelta(projection: ModelTurnProjection): InvestigationModelTurnDeltaV1 {
  const delta = emptyDelta(projection);
  for (const supplied of projection.context.analysis.findings) {
    const finding = structuredClone(supplied);
    finding.version += 1;
    const recheckId = `recheck-${projection.context.round}-${finding.id}`;
    finding.confirmation.recheckRef = recheckId;
    delta.analysis.findings.push(finding);
    delta.analysis.rechecks.push({
      id: recheckId,
      findingId: finding.id,
      findingVersion: finding.version,
      subjectRef: finding.subjectRef,
      round: projection.context.round,
      evidenceRefs: [...finding.evidenceRefs],
      conclusion: "The complete finding was checked against its evidence.",
      unresolvedQuestions: [],
    });
  }
  for (const candidate of projection.context.analysis.candidates) {
    const finding = delta.analysis.findings.find((entry) => entry.id === candidate.findingId);
    if (finding !== undefined)
      delta.analysis.candidates.push({ ...candidate, findingVersion: finding.version });
  }
  return delta;
}

function outputFailure(
  projection: ModelTurnProjection,
  delta: InvestigationModelTurnDeltaV1,
  trustedContext?: Parameters<typeof mergeModelTurnDelta>[2],
): ModelOutputValidationError {
  try {
    mergeModelTurnDelta(projection, delta, trustedContext);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelOutputValidationError);
    return error as ModelOutputValidationError;
  }
  throw new Error("The synthetic delta must fail model output validation.");
}

function projectionInputFailure(
  input: Parameters<typeof prepareModelTurnProjection>[0],
): ModelTurnProjectionError {
  try {
    prepareModelTurnProjection(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelTurnProjectionError);
    return error as ModelTurnProjectionError;
  }
  throw new Error("The synthetic projection input must fail validation.");
}

function newIssueFinding(projection: ModelTurnProjection) {
  const finding = structuredClone(
    createInvestigationFixture("bug", { findingCount: 1 }).result.findings[0]!,
  );
  finding.subjectRef = projection.context.task.subjectRef;
  finding.locations = finding.locations.map((location) => ({
    ...location,
    subjectRef: finding.subjectRef,
  }));
  finding.evidenceRefs = [];
  finding.rootCause.evidenceRefs = [];
  finding.confirmation.evidenceRefs = [];
  finding.confirmation.recheckRef = null;
  finding.fixRecommendation.planRef = null;
  finding.feedbackDraft.suggestion = null;
  return finding;
}

function newIssuePlan(projection: ModelTurnProjection): InvestigationAnalysisV1["plans"][number] {
  return {
    id: "synthetic-verification-plan",
    version: 1,
    kind: "verification",
    subjectRef: projection.context.task.subjectRef,
    title: "Verify the recorded issue hypothesis",
    rationale: "A saved experiment is needed before claiming a reproduced failure.",
    prerequisites: [],
    steps: [
      {
        id: "observe",
        description: "Observe the reported behavior.",
        expectedObservation: "Record the actual outcome.",
        checkIds: [],
      },
    ],
    acceptanceCriteria: ["Retain the actual observed result."],
  };
}

describe("safe model delta validation diagnostics", () => {
  it.each(["ordinary reference", "duplicate"] as const)(
    "does not let a correctable %s hide a PR assessment on an Issue task",
    (kind) => {
      const projection = snapshotProjection();
      const { task } = createInvestigationFixture("bug", { findingCount: 0 });
      const delta = emptyDelta(projection);
      const evidence = {
        id: "new-evidence",
        subjectRef: task.subjectRef,
        source: "static_analysis" as const,
        summary: "Synthetic analysis.",
        evidenceRefs: kind === "ordinary reference" ? ["missing-evidence"] : [],
      };
      delta.analysis.evidence =
        kind === "duplicate" ? [evidence, structuredClone(evidence)] : [evidence];
      delta.analysis.assessment = {
        kind: "pr",
        subjectRef: task.subjectRef,
        summary: "The wrong work item classification.",
        evidenceRefs: [],
        reviewConclusion: { status: "inconclusive", rationale: "Synthetic review." },
        e2eAssessment: {
          level: "not_needed",
          rationale: "No runtime claim.",
          planRef: null,
          scenarioIds: [],
          prerequisiteRefs: [],
          linkedValidationReportRefs: [],
        },
      };
      expect(
        isCorrectableInvestigationModelOutputIssue(
          safeModelOutputValidationIssue(outputFailure(projection, delta)),
        ),
      ).toBe(true);
      const error = outputFailure(projection, delta, { task });
      expect(error).toMatchObject({
        rule: "task_scope_violation",
        paths: ["/analysis/assessment/kind"],
      });
      expect(
        isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error)),
      ).toBe(false);
    },
  );

  it("preserves the primary assessment subject even when another subject is visible and authorized", () => {
    const original = snapshotProjection();
    const { task } = createInvestigationFixture("bug", { findingCount: 0 });
    const secondary = { ...task.subjects[0]!, id: "authorized-secondary-subject" };
    task.subjects.push(secondary);
    task.executionPolicy.allowedSubjectRefs.push(secondary.id);
    const projection: ModelTurnProjection = {
      ...original,
      context: { ...original.context, subjects: [...original.context.subjects, secondary] },
    };
    const delta = emptyDelta(projection);
    delta.analysis.assessment = { ...projection.baseAnalysis.assessment, subjectRef: secondary.id };
    delta.analysis.evidence = [
      {
        id: "new-evidence",
        subjectRef: task.subjectRef,
        source: "static_analysis",
        summary: "Synthetic analysis.",
        evidenceRefs: ["missing-evidence"],
      },
    ];
    const error = outputFailure(projection, delta, { task });
    expect(error).toMatchObject({
      rule: "task_scope_violation",
      paths: ["/analysis/assessment/subjectRef"],
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      false,
    );
  });

  it("audits an unauthorized earlier duplicate copy that last-wins assembly would otherwise hide", () => {
    const original = snapshotProjection();
    const { task } = createInvestigationFixture("bug", { findingCount: 0 });
    const secondary = { ...task.subjects[0]!, id: "visible-but-unauthorized-subject" };
    task.subjects.push(secondary);
    const projection: ModelTurnProjection = {
      ...original,
      context: { ...original.context, subjects: [...original.context.subjects, secondary] },
    };
    const delta = emptyDelta(projection);
    const evidence = {
      id: "duplicate-evidence",
      subjectRef: secondary.id,
      source: "static_analysis" as const,
      summary: "Synthetic analysis.",
      evidenceRefs: [],
    };
    delta.analysis.evidence = [evidence, { ...evidence, subjectRef: task.subjectRef }];
    const error = outputFailure(projection, delta, { task });
    expect(error).toMatchObject({
      rule: "task_scope_violation",
      paths: ["/analysis/evidence/0/subjectRef"],
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      false,
    );
  });

  it("keeps trusted runtime scope failures outside the model analysis path", () => {
    const projection = snapshotProjection();
    const { task, attempt } = createInvestigationFixture("bug", { findingCount: 0 });
    const runtime = createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "runtime-scope-checkpoint",
      leaseVersion: attempt.leaseVersion,
      recordedAt: task.updatedAt,
    }).runtime;
    runtime.reviewMode = "local_checkout";
    const delta = emptyDelta(projection);
    delta.analysis.evidence = [
      {
        id: "new-evidence",
        subjectRef: task.subjectRef,
        source: "static_analysis",
        summary: "Synthetic analysis.",
        evidenceRefs: ["missing-evidence"],
      },
    ];
    const error = outputFailure(projection, delta, { task, runtime });
    expect(error).toMatchObject({ rule: "task_scope_violation", paths: ["/runtime/reviewMode"] });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      false,
    );
  });

  it("retains ordinary reference correction eligibility after complete native task scope validation", () => {
    const projection = snapshotProjection();
    const { task } = createInvestigationFixture("bug", { findingCount: 0 });
    const delta = emptyDelta(projection);
    delta.analysis.evidence = [
      {
        id: "new-evidence",
        subjectRef: task.subjectRef,
        source: "static_analysis",
        summary: "Synthetic analysis.",
        evidenceRefs: ["missing-evidence"],
      },
    ];
    const error = outputFailure(projection, delta, { task });
    expect(error).toMatchObject({
      rule: "reference_outside_batch",
      paths: ["/analysis/evidence/0/evidenceRefs/0"],
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      true,
    );
  });

  it("rejects a foreign subject even when an ordinary missing reference appears first", () => {
    const projection = snapshotProjection();
    const original = structuredClone(projection.baseAnalysis);
    const delta = emptyDelta(projection);
    delta.analysis.evidence = [
      {
        id: "new-evidence",
        subjectRef: "foreign-subject",
        source: "static_analysis",
        summary: "This proposed evidence is outside the supplied subject scope.",
        evidenceRefs: ["missing-evidence"],
      },
    ];
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({
      rule: "reference_outside_batch",
      paths: ["/analysis/evidence/0/subjectRef"],
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      false,
    );
    expect(projection.baseAnalysis).toEqual(original);
  });

  it("does not let a duplicate proposed record hide its foreign subject", () => {
    const projection = snapshotProjection();
    const delta = emptyDelta(projection);
    const entry = {
      id: "duplicate-evidence",
      subjectRef: projection.context.task.subjectRef,
      source: "static_analysis" as const,
      summary: "Synthetic analysis.",
      evidenceRefs: [],
    };
    delta.analysis.evidence = [entry, { ...entry, subjectRef: "foreign-subject" }];
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({
      rule: "reference_outside_batch",
      paths: ["/analysis/evidence/1/subjectRef"],
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      false,
    );
  });

  it("checks frozen coverage definitions after detecting a duplicate coverage ID", () => {
    const projection = snapshotProjection();
    const delta = emptyDelta(projection);
    const unit = projection.context.analysis.coverageUnits[0]!;
    delta.analysis.coverageUnits = [
      unit,
      { ...unit, requiredWork: "An unauthorized replacement scope." },
    ];
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({
      rule: "coverage_definition_changed",
      paths: ["/analysis/coverageUnits/1"],
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      false,
    );
  });

  it("does not let a duplicate candidate hide a later accepted evidence mutation", () => {
    const f = fixture(1);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const delta = emptyDelta(projection);
    const candidate = { ...projection.context.analysis.candidates[0]!, id: "new-candidate" };
    delta.analysis.candidates = [candidate, structuredClone(candidate)];
    delta.analysis.evidence = [
      { ...projection.context.analysis.evidence[0]!, summary: "Changed accepted evidence." },
    ];
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({
      rule: "immutable_record_changed",
      paths: ["/analysis/evidence/0"],
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      false,
    );
  });

  it.each(["duplicate", "ordinary reference"] as const)(
    "preserves the hidden-record boundary in a delta that also has a correctable %s error",
    (kind) => {
      const f = fixture(20);
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 12 * 1024 });
      const omitted = f.checkpoint.analysis.findings.find(
        (finding) => !projection.selectedFindingIds.includes(finding.id),
      )!;
      expect(omitted).toBeDefined();
      const delta = emptyDelta(projection);
      if (kind === "duplicate") {
        const finding = newIssueFinding(projection);
        delta.analysis.findings = [finding, structuredClone(finding)];
      } else {
        delta.analysis.evidence = [
          {
            id: "new-evidence",
            subjectRef: projection.context.task.subjectRef,
            source: "static_analysis",
            summary: "Synthetic analysis.",
            evidenceRefs: ["missing-evidence"],
          },
        ];
      }
      const index = delta.analysis.findings.length;
      delta.analysis.findings.push({ ...omitted, version: omitted.version + 1 });
      const error = outputFailure(projection, delta);
      expect(error).toMatchObject({
        rule: "record_outside_batch",
        paths: [`/analysis/findings/${index}/id`],
      });
      expect(
        isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error)),
      ).toBe(false);
    },
  );

  it("retains bounded correctable duplicate diagnostics without treating new proposals as accepted evidence", () => {
    const projection = snapshotProjection();
    const delta = emptyDelta(projection);
    delta.analysis.evidence = Array.from({ length: 12 }, (_, index) => ({
      id: "duplicate-proposed-evidence",
      subjectRef: projection.context.task.subjectRef,
      source: "static_analysis" as const,
      summary: `Proposed content ${index}.`,
      evidenceRefs: [],
    }));
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({
      rule: "duplicate_record_id",
      paths: Array.from({ length: 8 }, (_, index) => `/analysis/evidence/${index + 1}/id`),
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      true,
    );
    expect(projection.baseAnalysis.evidence).toEqual([]);
  });

  it("aggregates ordinary missing references while keeping the rejected delta out of the ledger", () => {
    const projection = snapshotProjection();
    const delta = emptyDelta(projection);
    delta.analysis.evidence = [
      {
        id: "new-evidence",
        subjectRef: projection.context.task.subjectRef,
        source: "static_analysis",
        summary: "Synthetic analysis.",
        evidenceRefs: ["missing-first", "missing-second"],
      },
    ];
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({
      rule: "reference_outside_batch",
      paths: ["/analysis/evidence/0/evidenceRefs/0", "/analysis/evidence/0/evidenceRefs/1"],
    });
    expect(isCorrectableInvestigationModelOutputIssue(safeModelOutputValidationIssue(error))).toBe(
      true,
    );
    expect(projection.baseAnalysis.evidence).toEqual([]);
  });

  it.each(["taskId", "attemptId", "round", "phase", "inputCheckpointRef"] as const)(
    "locates the mismatched %s binding without retaining its rejected value",
    (field) => {
      const projection = snapshotProjection();
      const delta = emptyDelta(projection);
      const privateValue = "private-binding-value-never-disclosed";
      if (field === "taskId" || field === "attemptId") delta[field] = privateValue;
      else if (field === "round") delta.round += 1;
      else if (field === "phase") delta.phase = "finalize";
      else delta.inputCheckpointRef = { ...delta.inputCheckpointRef!, id: privateValue };
      const error = outputFailure(projection, delta);
      expect(error).toMatchObject({
        code: "MODEL_OUTPUT_INVALID",
        rule: "delta_binding",
        paths: [`/${field}`],
      });
      expect(error.message).not.toContain(privateValue);
    },
  );

  it("keeps schema failures typed and does not expose invalid response content", () => {
    const projection = snapshotProjection();
    const delta = emptyDelta(projection);
    Object.assign(delta, { schemaVersion: "private-invalid-version-never-disclosed" });
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({ rule: "delta_schema", paths: ["/schemaVersion"] });
    expect(error.message).not.toContain("private-invalid-version-never-disclosed");
  });

  it.each(["evidence", "plans", "feedbackDrafts"] as const)(
    "locates the second duplicate %s record without exposing its ID or content",
    (collection) => {
      const projection = snapshotProjection();
      const delta = emptyDelta(projection);
      const privateId = "private-duplicate-id-never-disclosed";
      if (collection === "evidence") {
        const entry = {
          id: privateId,
          subjectRef: projection.context.task.subjectRef,
          source: "static_analysis" as const,
          summary: "Private response content.",
          evidenceRefs: [],
        };
        delta.analysis.evidence = [entry, structuredClone(entry)];
      } else if (collection === "plans") {
        const entry = { ...newIssuePlan(projection), id: privateId };
        delta.analysis.plans = [entry, structuredClone(entry)];
      } else {
        const entry = { id: privateId, body: "Private response content.", suggestion: null };
        delta.analysis.feedbackDrafts = [entry, structuredClone(entry)];
      }
      const error = outputFailure(projection, delta);
      expect(error).toMatchObject({
        rule: "duplicate_record_id",
        paths: [`/analysis/${collection}/1/id`],
      });
      expect(error.message).not.toContain(privateId);
      expect(error.message).not.toContain("Private response content.");
    },
  );

  it("identifies a frozen coverage mutation without copying the proposed required work", () => {
    const projection = snapshotProjection();
    const delta = emptyDelta(projection);
    delta.analysis.coverageUnits = [
      { ...projection.context.analysis.coverageUnits[0]!, requiredWork: "Private narrowed scope." },
    ];
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({
      rule: "coverage_definition_changed",
      paths: ["/analysis/coverageUnits/0"],
    });
    expect(error.message).not.toContain("Private narrowed scope.");
  });

  it("identifies a Worker evidence identity collision before merging model evidence", () => {
    const f = fixture(0);
    f.checkpoint.runtime.evidence.push({
      id: "private-worker-observation-id",
      subjectRef: f.task.subjectRef,
      source: "executor_observation",
      authority: "worker",
      summary: "Trusted synthetic observation.",
      artifactRefs: [],
      evidenceRefs: [],
      provenance: {
        taskId: f.task.id,
        attemptId: f.attempt.id,
        producer: "Synthetic executor",
        recordedAt: f.task.updatedAt,
      },
    });
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const delta = emptyDelta(projection);
    delta.analysis.evidence = [
      {
        id: "private-worker-observation-id",
        subjectRef: f.task.subjectRef,
        source: "static_analysis",
        summary: "A model cannot overwrite this observation.",
        evidenceRefs: [],
      },
    ];
    const error = outputFailure(projection, delta);
    expect(error).toMatchObject({
      rule: "trusted_evidence_collision",
      paths: ["/analysis/evidence/0/id"],
    });
    expect(error.message).not.toContain("private-worker-observation-id");
  });

  const referenceCases: ReadonlyArray<{
    name: string;
    path: string;
    set: (
      projection: ModelTurnProjection,
      delta: InvestigationModelTurnDeltaV1,
      id: string,
    ) => void;
  }> = [
    {
      name: "evidence",
      path: "/analysis/evidence/0/evidenceRefs/0",
      set: (projection, delta, id) => {
        delta.analysis.evidence = [
          {
            id: "new-evidence",
            subjectRef: projection.context.task.subjectRef,
            source: "reporter_statement",
            summary: "Synthetic reporter statement.",
            evidenceRefs: [id],
          },
        ];
      },
    },
    {
      name: "finding plan",
      path: "/analysis/findings/0/fixRecommendation/planRef/id",
      set: (projection, delta, id) => {
        const finding = newIssueFinding(projection);
        finding.fixRecommendation.planRef = { id, version: 1, digest: "0".repeat(64) };
        delta.analysis.findings = [finding];
      },
    },
    {
      name: "embedded location subject",
      path: "/analysis/findings/0/locations/0/subjectRef",
      set: (projection, delta, id) => {
        const finding = newIssueFinding(projection);
        finding.locations = [
          { kind: "behavior", subjectRef: id, description: "Synthetic behavior." },
        ];
        delta.analysis.findings = [finding];
      },
    },
    {
      name: "draft",
      path: "/analysis/nextActions/0/draftRef",
      set: (projection, delta, id) => {
        delta.analysis.nextActions = [
          {
            id: "comment-action",
            action: "comment",
            taskKind: null,
            label: "Review the draft",
            reason: "The draft is a proposal only.",
            recommended: true,
            subjectRef: projection.context.task.subjectRef,
            planRef: null,
            draftRef: id,
            validationReportRef: null,
            prerequisiteRefs: [],
          },
        ];
      },
    },
    {
      name: "candidate finding",
      path: "/analysis/candidates/0/findingId",
      set: (projection, delta, id) => {
        delta.analysis.candidates = [
          {
            ...createInvestigationFixture("bug", { findingCount: 1 }).result.report.loop
              .candidates[0]!,
            id: "new-candidate",
            subjectRef: projection.context.task.subjectRef,
            status: "unresolved",
            findingId: id,
            findingVersion: 1,
            evidenceRefs: [],
            mergedIntoCandidateId: null,
          },
        ];
      },
    },
    {
      name: "candidate merge target",
      path: "/analysis/candidates/0/mergedIntoCandidateId",
      set: (projection, delta, id) => {
        delta.analysis.candidates = [
          {
            ...createInvestigationFixture("bug", { findingCount: 1 }).result.report.loop
              .candidates[0]!,
            id: "new-candidate",
            subjectRef: projection.context.task.subjectRef,
            status: "merged",
            findingId: null,
            findingVersion: null,
            evidenceRefs: [],
            mergedIntoCandidateId: id,
          },
        ];
      },
    },
    {
      name: "recheck finding",
      path: "/analysis/rechecks/0/findingId",
      set: (projection, delta, id) => {
        delta.analysis.rechecks = [
          {
            id: "new-recheck",
            findingId: id,
            findingVersion: 1,
            subjectRef: projection.context.task.subjectRef,
            round: projection.context.round,
            evidenceRefs: [],
            conclusion: "Synthetic review.",
            unresolvedQuestions: [],
          },
        ];
      },
    },
    {
      name: "finding recheck",
      path: "/analysis/findings/0/confirmation/recheckRef",
      set: (projection, delta, id) => {
        const finding = newIssueFinding(projection);
        finding.confirmation.recheckRef = id;
        delta.analysis.findings = [finding];
      },
    },
  ];
  it.each(referenceCases)(
    "locates the unresolved $name reference without exposing it",
    ({ path, set }) => {
      const projection = snapshotProjection();
      const delta = emptyDelta(projection);
      const privateId = "private-reference-never-disclosed";
      set(projection, delta, privateId);
      expect(Value.Check(InvestigationModelTurnDeltaV1Schema, delta)).toBe(true);
      const error = outputFailure(projection, delta);
      expect(error).toMatchObject({ rule: "reference_outside_batch", paths: [path] });
      expect(error.message).not.toContain(privateId);
      expect(projection.baseAnalysis.findings).toEqual([]);
    },
  );

  it("reports a missing Issue reproduction plan while accepting its provisional digest when supplied", () => {
    const projection = snapshotProjection();
    const delta = emptyDelta(projection);
    const assessment = structuredClone(
      createInvestigationFixture("bug", { findingCount: 0 }).result.assessment,
    );
    if (assessment.kind !== "bug") throw new Error("The synthetic assessment must describe a bug.");
    const plan = newIssuePlan(projection);
    assessment.subjectRef = projection.context.task.subjectRef;
    assessment.evidenceRefs = [];
    assessment.reproduction.evidenceRefs = [];
    assessment.reproduction.planRef = {
      id: plan.id,
      version: plan.version,
      digest: "0".repeat(64),
    };
    delta.analysis.assessment = assessment;
    expect(outputFailure(projection, delta)).toMatchObject({
      rule: "reference_outside_batch",
      paths: ["/analysis/assessment/reproduction/planRef/id"],
    });
    delta.analysis.plans = [plan];
    const merged = mergeModelTurnDelta(projection, delta);
    expect(merged.analysis.assessment).toEqual(assessment);
    const normalized = normalizeInvestigationAnalysisPlanReferences(merged.analysis);
    if (normalized.assessment.kind !== "bug")
      throw new Error("The normalized assessment must describe a bug.");
    expect(normalized.assessment.reproduction.planRef?.digest).toBe(
      investigationContentDigest(plan),
    );
  });
});

describe("bounded investigation model context", () => {
  it("lets a fresh snapshot-only investigation finish without an empty finalize batch", () => {
    const projection = snapshotProjection();
    expect(projection.autonomousReview).toBe(true);
    expect(projection.localSourceReview).toBe(false);
    const delta = emptyDelta(projection);
    delta.analysis.coverageUnits = projection.context.analysis.coverageUnits.map((unit) => ({
      ...unit,
      status: "completed",
    }));
    expect(mergeModelTurnDelta(projection, delta).continue).toBe(false);
    expect(projection.context.task.primarySubject.kind).toBe("issue_snapshot");
  });

  it("does not force another invocation after local source coverage is complete", () => {
    const f = fixture(0);
    f.checkpoint.runtime.reviewMode = "local_checkout";
    f.checkpoint.round = 0;
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const delta = emptyDelta(projection);
    delta.analysis.coverageUnits = projection.context.analysis.coverageUnits.map((unit) => ({
      ...unit,
      status: "completed",
    }));
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.phase).toBe("discovery");
    expect(round.continue).toBe(false);
  });

  it("preserves an honest local-source blocker instead of forcing unchanged analysis", () => {
    const f = fixture(0);
    f.checkpoint.runtime.reviewMode = "local_checkout";
    f.checkpoint.analysis.coverage.includedUnits.forEach((unit) => {
      unit.status = "blocked";
    });
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const delta = emptyDelta(projection);
    delta.continuationReason =
      "The required dependency is absent after searching the pinned checkout.";
    expect(mergeModelTurnDelta(projection, delta).continue).toBe(false);
  });

  it.each(["confirmed", "unresolved"] as const)(
    "requires concrete finding links for a model %s disposition before merging",
    (status) => {
      const f = fixture(1);
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
      const candidate = { ...projection.context.analysis.candidates[0]!, status };
      expect(Value.Check(InvestigationModelCandidateSchema, candidate)).toBe(true);
      for (const invalidFields of [
        { findingId: null },
        { findingVersion: null },
        { findingVersion: 0 },
        { findingVersion: -1 },
        { findingVersion: 1.5 },
        { mergedIntoCandidateId: "another-candidate" },
      ]) {
        const delta = emptyDelta(projection);
        delta.analysis.candidates = [{ ...candidate, ...invalidFields }];
        expect(Value.Check(InvestigationModelTurnDeltaV1Schema, delta)).toBe(false);
        expect(() => mergeModelTurnDelta(projection, delta)).toThrow(/schema/u);
      }
    },
  );

  it("requires merge targets only for merged candidates without erasing historical finding links", () => {
    const candidate = fixture(1).checkpoint.analysis.candidates[0]!;
    for (const status of ["pending", "withdrawn"] as const) {
      expect(Value.Check(InvestigationModelCandidateSchema, { ...candidate, status })).toBe(true);
      expect(
        Value.Check(InvestigationModelCandidateSchema, {
          ...candidate,
          status,
          findingId: null,
          findingVersion: null,
        }),
      ).toBe(true);
      expect(
        Value.Check(InvestigationModelCandidateSchema, {
          ...candidate,
          status,
          mergedIntoCandidateId: "target-candidate",
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(InvestigationModelCandidateSchema, {
        ...candidate,
        status: "merged",
        mergedIntoCandidateId: "target-candidate",
      }),
    ).toBe(true);
    expect(
      Value.Check(InvestigationModelCandidateSchema, {
        ...candidate,
        status: "merged",
        mergedIntoCandidateId: null,
      }),
    ).toBe(false);
  });

  it("keeps the domain finding-version check authoritative after candidate shape validation", () => {
    const f = fixture(1);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const delta = emptyDelta(projection);
    const candidate = projection.context.analysis.candidates[0]!;
    delta.analysis.candidates = [{ ...candidate, findingVersion: candidate.findingVersion! + 1 }];
    expect(Value.Check(InvestigationModelTurnDeltaV1Schema, delta)).toBe(true);
    const round = mergeModelTurnDelta(projection, delta);
    expect(() =>
      applyInvestigationLoopRound(f.checkpoint, round, {
        recordedAt: f.checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      }),
    ).toThrow(/current finding version/u);
  });

  it("accepts an upgraded hypothesis recheck while maintaining an omitted visible owner version", () => {
    const f = fixture(1);
    f.checkpoint.analysis.findings[0]!.confirmation.status = "hypothesis";
    f.checkpoint.analysis.candidates[0]!.status = "unresolved";
    f.checkpoint.analysis.limitations.push({
      id: "runtime-remains-unverified",
      description: "The supplied snapshot does not include runtime evidence.",
      impact: "The retained concern remains a hypothesis.",
      evidenceRefs: [],
    });
    const checkpoint = seal(f.checkpoint);
    const projection = prepareModelTurnProjection({
      ...f,
      checkpoint,
      maximumContextBytes: 100 * 1024,
    });
    const originalCandidate = structuredClone(checkpoint.analysis.candidates[0]!);
    const originalFinding = structuredClone(checkpoint.analysis.findings[0]!);
    expect(originalFinding.version).toBe(1);
    const delta = recheckDelta(projection);
    delta.analysis.candidates = [];
    delta.analysis.rechecks[0]!.unresolvedQuestions = [
      "Does runtime evidence reproduce this reported concern?",
    ];
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.candidates[0]).toEqual({ ...originalCandidate, findingVersion: 2 });
    expect(delta.analysis.candidates).toEqual([]);
    expect(projection.baseAnalysis.candidates[0]).toEqual(originalCandidate);
    expect(projection.baseAnalysis.findings[0]).toEqual(originalFinding);
    const accepted = applyInvestigationLoopRound(checkpoint, round, {
      recordedAt: checkpoint.recordedAt,
      usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
    });
    expect(accepted.analysis.findings[0]!.version).toBe(2);
    expect(accepted.analysis.rechecks).toContainEqual(delta.analysis.rechecks[0]);
    expect(accepted.analysis.candidates[0]).toEqual({ ...originalCandidate, findingVersion: 2 });
  });

  it("does not repair an explicitly submitted stale owner version", () => {
    const f = fixture(1);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const delta = recheckDelta(projection);
    delta.analysis.candidates = [structuredClone(projection.context.analysis.candidates[0]!)];
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.candidates[0]!.findingVersion).toBe(1);
    expect(() =>
      applyInvestigationLoopRound(f.checkpoint, round, {
        recordedAt: f.checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      }),
    ).toThrow(/current finding version/u);
  });

  it("does not change an omitted candidate disposition when the upgraded finding confirmation changes", () => {
    const f = fixture(1);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const candidate = structuredClone(projection.context.analysis.candidates[0]!);
    const delta = recheckDelta(projection);
    delta.analysis.candidates = [];
    delta.analysis.findings[0]!.confirmation.status =
      candidate.status === "confirmed" ? "hypothesis" : "confirmed";
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.candidates[0]).toEqual(candidate);
    expect(() =>
      applyInvestigationLoopRound(f.checkpoint, round, {
        recordedAt: f.checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      }),
    ).toThrow(/current finding version/u);
  });

  it("does not maintain the version of an owner outside the visible batch", () => {
    const f = fixture(1);
    f.checkpoint.analysis.candidates.push({
      ...f.checkpoint.analysis.candidates[0]!,
      id: "hidden-owner",
    });
    const checkpoint = seal(f.checkpoint);
    const full = prepareModelTurnProjection({ ...f, checkpoint, maximumContextBytes: 100 * 1024 });
    const projection: ModelTurnProjection = {
      ...full,
      selectedCandidateIds: full.selectedCandidateIds.filter((id) => id !== "hidden-owner"),
      context: {
        ...full.context,
        analysis: {
          ...full.context.analysis,
          candidates: full.context.analysis.candidates.filter(
            (candidate) => candidate.id !== "hidden-owner",
          ),
        },
      },
    };
    const delta = recheckDelta(projection);
    delta.analysis.candidates = [];
    const round = mergeModelTurnDelta(projection, delta);
    expect(
      round.analysis.candidates.find((candidate) => candidate.id !== "hidden-owner")!
        .findingVersion,
    ).toBe(2);
    expect(round.analysis.candidates.find((candidate) => candidate.id === "hidden-owner")).toEqual(
      checkpoint.analysis.candidates.find((candidate) => candidate.id === "hidden-owner"),
    );
    expect(() =>
      applyInvestigationLoopRound(checkpoint, round, {
        recordedAt: checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      }),
    ).toThrow(/current finding version/u);
  });
  it("exposes the accepted consumption and clamped remaining budget without spending the next round", () => {
    const f = fixture(0);
    const budget = structuredClone(f.task.budget);
    for (const consumed of [
      { rounds: 0, durationMs: 0, tokens: 0, reportBytes: 0 },
      { rounds: 7, durationMs: 1234, tokens: 4567, reportBytes: 8910 },
      {
        rounds: 24,
        durationMs: budget.maxDurationMs,
        tokens: 12_000_000,
        reportBytes: budget.maxReportBytes,
      },
      {
        rounds: 25,
        durationMs: budget.maxDurationMs + 1,
        tokens: 12_000_001,
        reportBytes: budget.maxReportBytes + 1,
      },
    ]) {
      f.checkpoint.consumed = consumed;
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 32 * 1024 });
      expect(projection.context.task.budget).toEqual({
        maxDurationMs: 7_200_000,
        maxReportBytes: budget.maxReportBytes,
      });
      expect(projection.context.budgetState).toEqual({
        consumed,
        remaining: {
          durationMs: Math.max(0, 7_200_000 - consumed.durationMs),
          reportBytes: Math.max(0, budget.maxReportBytes - consumed.reportBytes),
        },
      });
      expect(f.checkpoint.consumed).toEqual(consumed);
    }
    const initial = prepareModelTurnProjection({
      ...f,
      checkpoint: null,
      maximumContextBytes: 32 * 1024,
    });
    expect(initial.context.budgetState.consumed).toEqual({
      rounds: 0,
      durationMs: 0,
      tokens: 0,
      reportBytes: 0,
    });
    expect(f.task.budget).toEqual(budget);
  });

  it("rechecks every finding across byte-bounded batches without sending a multi-megabyte ledger", () => {
    const f = fixture(145);
    f.checkpoint.analysis.summary = "Historical summary. ".repeat(100_000);
    f.checkpoint.analysis.assessment.summary = "Historical assessment. ".repeat(100_000);
    f.checkpoint.analysis.evidence.push({
      id: "historical-unrelated-evidence",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary: "Historical source context. ".repeat(100_000),
      evidenceRefs: [],
    });
    f.checkpoint.analysis.findings[0]!.priority = "P3";
    f.checkpoint.analysis.findings[144]!.priority = "P0";
    let checkpoint = seal(f.checkpoint);
    const initial = structuredClone(checkpoint.analysis);
    expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeGreaterThan(2 * 1024 * 1024);
    const seen: string[] = [];
    const batchSizes: number[] = [];
    for (let turn = 0; turn < 20; turn += 1) {
      const projection = prepareModelTurnProjection({
        ...f,
        checkpoint,
        maximumContextBytes: 128 * 1024,
      });
      expect(Buffer.byteLength(JSON.stringify(projection.context))).toBeLessThanOrEqual(128 * 1024);
      expect(projection.context.analysis.summary.truncated).toBe(true);
      expect(projection.context.analysis.assessment.summary.truncated).toBe(true);
      if (projection.phase === "finalize") {
        expect(mergeModelTurnDelta(projection, emptyDelta(projection)).continue).toBe(false);
        break;
      }
      expect(projection.phase).toBe("recheck");
      seen.push(...projection.selectedFindingIds);
      batchSizes.push(projection.selectedFindingIds.length);
      for (const finding of projection.context.analysis.findings)
        expect(finding).toEqual(
          checkpoint.analysis.findings.find((entry) => entry.id === finding.id),
        );
      const merged = mergeModelTurnDelta(projection, recheckDelta(projection));
      expect(merged.continue).toBe(true);
      expect(merged.analysis.findings).toHaveLength(145);
      expect(merged.analysis.evidence).toEqual(initial.evidence);
      checkpoint = applyInvestigationLoopRound(checkpoint, merged, {
        recordedAt: checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      });
    }
    expect(seen).toEqual(initial.findings.map((finding) => finding.id));
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(batchSizes.some((size) => size > 1)).toBe(true);
    expect(checkpoint.analysis.findings.map((finding) => finding.rootCause)).toEqual(
      initial.findings.map((finding) => finding.rootCause),
    );
    expect(f.checkpoint.analysis).toEqual(initial);
  });

  it("stops an unlinked recheck without progress while accepting a correctly linked recheck", () => {
    const f = fixture(1);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    expect(projection.phase).toBe("recheck");
    const finding = projection.context.analysis.findings[0]!;
    const unlinkedDelta = emptyDelta(projection);
    unlinkedDelta.analysis.rechecks.push({
      id: "synthetic-unlinked-recheck",
      findingId: finding.id,
      findingVersion: finding.version,
      subjectRef: finding.subjectRef,
      round: projection.context.round,
      evidenceRefs: [...finding.evidenceRefs],
      conclusion: "The synthetic finding was rechecked without updating its confirmation link.",
      unresolvedQuestions: [],
    });
    expect(unlinkedDelta.analysis.findings).toEqual([]);
    const unlinkedRound = mergeModelTurnDelta(projection, unlinkedDelta);
    expect(unlinkedRound.continue).toBe(true);
    let checkpoint = applyInvestigationLoopRound(f.checkpoint, unlinkedRound, {
      recordedAt: f.checkpoint.recordedAt,
      usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
    });
    expect(checkpoint.analysis.rechecks).toContainEqual(unlinkedDelta.analysis.rechecks[0]);
    expect(checkpoint.analysis.findings[0]).toEqual(finding);
    expect(checkpoint.analysis.findings[0]!.confirmation.recheckRef).toBeNull();
    expect(checkpoint.stopReason).toBe("blocked");
    const retryProjection = prepareModelTurnProjection({
      ...f,
      checkpoint: f.checkpoint,
      maximumContextBytes: 100 * 1024,
    });
    expect(retryProjection.phase).toBe("recheck");
    expect(retryProjection.context.counts.pendingFindings).toBe(1);
    expect(retryProjection.selectedFindingIds).toEqual([finding.id]);

    const linkedDelta = recheckDelta(retryProjection);
    const updatedFinding = linkedDelta.analysis.findings[0]!;
    const linkedRecheck = linkedDelta.analysis.rechecks[0]!;
    expect(updatedFinding.version).toBe(finding.version + 1);
    expect(updatedFinding.confirmation.recheckRef).toBe(linkedRecheck.id);
    expect(linkedRecheck.id).not.toBe(unlinkedDelta.analysis.rechecks[0]!.id);
    expect(linkedRecheck.findingVersion).toBe(updatedFinding.version);
    expect(linkedDelta.analysis.candidates.length).toBeGreaterThan(0);
    for (const candidate of linkedDelta.analysis.candidates) {
      expect(candidate.findingId).toBe(updatedFinding.id);
      expect(candidate.findingVersion).toBe(updatedFinding.version);
    }
    checkpoint = applyInvestigationLoopRound(
      f.checkpoint,
      mergeModelTurnDelta(retryProjection, linkedDelta),
      {
        recordedAt: checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      },
    );
    const finalProjection = prepareModelTurnProjection({
      ...f,
      checkpoint,
      maximumContextBytes: 100 * 1024,
    });
    expect(finalProjection.phase).toBe("finalize");
    expect(finalProjection.context.counts.pendingFindings).toBe(0);
    expect(mergeModelTurnDelta(finalProjection, emptyDelta(finalProjection)).continue).toBe(false);
  });

  it("continues through more than one hundred frozen scope units without dropping pending work", () => {
    const f = fixture(0);
    f.task.scope.includedUnits = Array.from({ length: 130 }, (_, index) => ({
      id: `unit-${index}`,
      subjectRef: f.task.subjectRef,
      kind: "source",
      paths: [`src/${index}.ts`],
      requiredWork: `Read this entire scope unit. ${"Source behavior. ".repeat(80)}`,
      status: "pending" as const,
      evidenceRefs: [],
    }));
    f.task.scope.completedUnitRefs = [];
    f.task.scope.unresolvedUnitRefs = f.task.scope.includedUnits.map((unit) => unit.id);
    let checkpoint = createInvestigationCheckpoint({
      task: f.task,
      attemptId: f.attempt.id,
      checkpointId: "scope-checkpoint",
      leaseVersion: 1,
      recordedAt: f.task.updatedAt,
    });
    delete checkpoint.runtime.reviewMode;
    checkpoint = seal(checkpoint);
    const seen: string[] = [];
    for (let turn = 0; turn < 20; turn += 1) {
      const projection = prepareModelTurnProjection({
        ...f,
        checkpoint,
        maximumContextBytes: 32 * 1024,
      });
      if (projection.phase === "finalize") break;
      const delta = emptyDelta(projection);
      delta.analysis.coverageUnits = projection.context.analysis.coverageUnits.map((unit) => ({
        ...unit,
        status: "completed",
      }));
      seen.push(...projection.selectedUnitIds);
      const round = mergeModelTurnDelta(projection, delta);
      expect(round.analysis.coverage.includedUnits).toHaveLength(130);
      checkpoint = applyInvestigationLoopRound(checkpoint, round, {
        recordedAt: checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      });
    }
    expect(seen).toEqual(f.task.scope.includedUnits.map((unit) => unit.id));
    expect(checkpoint.analysis.coverage.unresolvedUnitRefs).toEqual([]);
  });

  it("retains omitted records and refuses mutations to an unprovided finding", () => {
    const f = fixture(20);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 12 * 1024 });
    const omitted = f.checkpoint.analysis.findings.find(
      (finding) => !projection.selectedFindingIds.includes(finding.id),
    )!;
    expect(omitted).toBeDefined();
    expect(mergeModelTurnDelta(projection, emptyDelta(projection)).analysis).toEqual(
      f.checkpoint.analysis,
    );
    const delta = emptyDelta(projection);
    delta.analysis.findings = [
      { ...omitted, version: omitted.version + 1, title: "An unprovided finding was changed." },
    ];
    expect(outputFailure(projection, delta)).toMatchObject({
      rule: "record_outside_batch",
      paths: ["/analysis/findings/0/id"],
    });
  });

  it("includes complete transitive evidence and every owning candidate for a selected finding", () => {
    const f = fixture(1);
    const evidence = f.checkpoint.analysis.evidence[0]!;
    evidence.evidenceRefs.push("transitive-evidence");
    f.checkpoint.analysis.evidence.push({
      id: "transitive-evidence",
      subjectRef: evidence.subjectRef,
      source: "static_analysis",
      summary: "Dependency evidence.",
      evidenceRefs: [],
    });
    f.checkpoint.analysis.candidates.push({
      ...f.checkpoint.analysis.candidates[0]!,
      id: "second-owner",
    });
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    expect(projection.context.analysis.evidence.map((entry) => entry.id)).toContain(
      "transitive-evidence",
    );
    expect(projection.selectedCandidateIds).toContain("second-owner");
  });

  it("requires an explicit removal and dispositions for all owners before withdrawing a finding", () => {
    const f = fixture(1);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const delta = emptyDelta(projection);
    delta.analysis.removedFindingIds = [...projection.selectedFindingIds];
    expect(outputFailure(projection, delta)).toMatchObject({
      rule: "finding_owner_required",
      paths: ["/analysis/removedFindingIds/0"],
    });
    delta.analysis.candidates = projection.context.analysis.candidates.map((candidate) => ({
      ...candidate,
      status: "withdrawn",
      rationale: "Rechecking the source disproved the candidate.",
    }));
    expect(Value.Check(InvestigationModelTurnDeltaV1Schema, delta)).toBe(true);
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.findings).toEqual([]);
    expect(round.analysis.candidates).toHaveLength(f.checkpoint.analysis.candidates.length);
    expect(round.analysis.rechecks).toEqual(f.checkpoint.analysis.rechecks);
    expect(round.analysis.candidates.map((candidate) => candidate.findingId)).toEqual(
      projection.context.analysis.candidates.map((candidate) => candidate.findingId),
    );
  });

  it("retains historical finding ownership when merging a candidate and explicitly removing its finding", () => {
    const f = fixture(1);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const original = projection.context.analysis.candidates[0]!;
    const delta = emptyDelta(projection);
    delta.analysis.removedFindingIds = [...projection.selectedFindingIds];
    delta.analysis.candidates = [
      {
        ...original,
        status: "merged",
        mergedIntoCandidateId: "replacement-candidate",
        rationale: "The retained concern is represented by the explicitly identified candidate.",
      },
      {
        ...original,
        id: "replacement-candidate",
        status: "pending",
        findingId: null,
        findingVersion: null,
        discoveredRound: projection.context.round,
      },
    ];
    expect(Value.Check(InvestigationModelTurnDeltaV1Schema, delta)).toBe(true);
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.findings).toEqual([]);
    expect(
      round.analysis.candidates.find((candidate) => candidate.id === original.id),
    ).toMatchObject({
      status: "merged",
      findingId: original.findingId,
      findingVersion: original.findingVersion,
      mergedIntoCandidateId: "replacement-candidate",
    });
  });

  it("rejects duplicate updates, immutable evidence changes, and stale round binding", () => {
    const f = fixture(1);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 100 * 1024 });
    const delta = emptyDelta(projection);
    const candidate = projection.context.analysis.candidates[0]!;
    delta.analysis.candidates = [candidate, candidate];
    expect(outputFailure(projection, delta)).toMatchObject({
      rule: "duplicate_record_id",
      paths: ["/analysis/candidates/1/id"],
    });
    delta.analysis.candidates = [];
    delta.analysis.evidence = [
      { ...projection.context.analysis.evidence[0]!, summary: "Changed accepted evidence." },
    ];
    expect(outputFailure(projection, delta)).toMatchObject({
      rule: "immutable_record_changed",
      paths: ["/analysis/evidence/0"],
    });
    delta.analysis.evidence = [];
    delta.round += 1;
    expect(outputFailure(projection, delta)).toMatchObject({
      rule: "delta_binding",
      paths: ["/round"],
    });
  });

  it.each(["reporter_statement", "static_analysis"] as const)(
    "rejects a supplied snapshot subject ID used as a %s evidence reference",
    (source) => {
      const projection = snapshotProjection();
      const subject = projection.context.task.primarySubject;
      expect(subject.kind).toBe("issue_snapshot");
      expect(projection.context.subjects).toContainEqual(subject);
      expect(projection.context.analysis.evidence).toEqual([]);
      expect(projection.context.observations).toEqual([]);
      const delta = emptyDelta(projection);
      delta.analysis.evidence = [
        {
          id: "synthetic-snapshot-leaf",
          subjectRef: subject.id,
          source,
          summary: "A synthetic observation drawn directly from the supplied snapshot.",
          evidenceRefs: [subject.id],
        },
      ];
      expect(() => mergeModelTurnDelta(projection, delta)).toThrow(
        /references a record outside its supplied batch or new records/u,
      );
    },
  );

  it.each(["reporter_statement", "static_analysis"] as const)(
    "accepts leaf %s evidence from a supplied snapshot and evidence derived in the same turn",
    (source) => {
      const projection = snapshotProjection();
      const delta = emptyDelta(projection);
      delta.analysis.evidence = [
        {
          id: "synthetic-snapshot-leaf",
          subjectRef: projection.context.task.subjectRef,
          source,
          summary: "A synthetic observation drawn directly from the supplied snapshot.",
          evidenceRefs: [],
        },
        {
          id: "synthetic-derived-analysis",
          subjectRef: projection.context.task.subjectRef,
          source: "static_analysis",
          summary: "The snapshot observation supports a hypothesis, not a reproduced defect.",
          evidenceRefs: ["synthetic-snapshot-leaf"],
        },
      ];
      expect(mergeModelTurnDelta(projection, delta).analysis.evidence).toEqual(
        delta.analysis.evidence,
      );
    },
  );

  it("rejects an oversized individual finding instead of truncating its content", () => {
    const f = fixture(1);
    f.checkpoint.analysis.findings[0]!.rootCause.explanation = "Complete source reasoning. ".repeat(
      30_000,
    );
    expect(() => prepareModelTurnProjection({ ...f, maximumContextBytes: 32 * 1024 })).toThrow(
      ModelTurnProjectionError,
    );
    expect(() => prepareModelTurnProjection({ ...f, maximumContextBytes: 32 * 1024 })).toThrow(
      /complete context/u,
    );
  });

  it("preserves Worker observation-backed rechecks during an empty finalization batch", () => {
    const f = fixture(1);
    const finding = f.checkpoint.analysis.findings[0]!;
    finding.confirmation.recheckRef = f.checkpoint.analysis.rechecks[0]!.id;
    f.checkpoint.runtime.evidence = f.checkpoint.analysis.evidence.map((entry) => ({
      ...entry,
      source: "executor_observation",
      authority: "worker",
      artifactRefs: [],
      provenance: {
        taskId: f.task.id,
        attemptId: f.attempt.id,
        producer: "Synthetic test executor",
        recordedAt: f.task.updatedAt,
      },
    }));
    f.checkpoint.analysis.evidence = f.checkpoint.runtime.evidence.map((entry) => ({
      id: `model-summary-${entry.id}`,
      subjectRef: entry.subjectRef,
      source: "static_analysis",
      summary: "The independent observation was considered.",
      evidenceRefs: [entry.id],
    }));
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 32 * 1024 });
    expect(projection.phase).toBe("finalize");
    expect(projection.context.observations).toEqual([]);
    expect(mergeModelTurnDelta(projection, emptyDelta(projection)).continue).toBe(false);
  });

  it("projects unsummarized runtime observations and their independent check outcomes in bounded batches", () => {
    const f = fixture(0);
    f.checkpoint.runtime.evidence = Array.from({ length: 20 }, (_, index) => ({
      id: `worker-observation-${index}`,
      subjectRef: f.task.subjectRef,
      source: "executor_observation",
      authority: "worker",
      summary: `Observed result ${index}. ${"Captured output. ".repeat(400)}`,
      artifactRefs: [],
      evidenceRefs: [],
      provenance: {
        taskId: f.task.id,
        attemptId: f.attempt.id,
        producer: "Synthetic executor",
        recordedAt: f.task.updatedAt,
      },
    }));
    f.checkpoint.runtime.checks = f.checkpoint.runtime.evidence.map((entry, index) => ({
      id: `check-${index}`,
      scenarioId: `scenario-${index}`,
      subjectRef: entry.subjectRef,
      planRef: null,
      required: true,
      description: "Observe the authorized check result.",
      status: index % 2 === 0 ? "passed" : "failed",
      executor: "Synthetic executor",
      evidenceRefs: [entry.id],
      authoritativeAttemptId: f.attempt.id,
    }));
    let checkpoint = seal(f.checkpoint);
    const observed: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const projection = prepareModelTurnProjection({
        ...f,
        checkpoint,
        maximumContextBytes: 32 * 1024,
      });
      if (projection.phase === "finalize") break;
      expect(projection.phase).toBe("investigation");
      expect(projection.context.observations.length).toBeGreaterThan(0);
      expect(projection.context.observations.length).toBeLessThan(20);
      expect(projection.context.runtime.checks.map((check) => check.status)).toEqual(
        projection.context.observations.map(
          (entry) =>
            checkpoint.runtime.checks.find((check) => check.evidenceRefs.includes(entry.id))!
              .status,
        ),
      );
      const delta = emptyDelta(projection);
      delta.analysis.evidence = projection.context.observations.map((entry) => ({
        id: `analysis-${entry.id}`,
        subjectRef: entry.subjectRef,
        source: "static_analysis",
        summary: "The independent check result constrains the conclusion.",
        evidenceRefs: [entry.id],
      }));
      observed.push(...projection.context.observations.map((entry) => entry.id));
      checkpoint = applyInvestigationLoopRound(checkpoint, mergeModelTurnDelta(projection, delta), {
        recordedAt: checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      });
    }
    expect(observed).toEqual(f.checkpoint.runtime.evidence.map((entry) => entry.id));
    expect(checkpoint.runtime.evidence).toEqual(f.checkpoint.runtime.evidence);
  });

  it("does not expand a single finding through a shared coverage unit into every other finding's evidence", () => {
    const f = fixture(40);
    const finding = f.checkpoint.analysis.findings[0]!;
    const location = finding.locations[0]!;
    if (location.kind !== "source")
      throw new Error("The synthetic PR fixture must have a source location.");
    f.checkpoint.analysis.coverage.includedUnits[0]!.paths = [location.path];
    f.checkpoint.analysis.coverage.includedUnits[0]!.kind = "pr_diff_chunk";
    f.checkpoint.analysis.coverage.includedUnits[0]!.evidenceRefs =
      f.checkpoint.analysis.evidence.map((entry) => entry.id);
    f.checkpoint.analysis.evidence.push({
      id: "large-unrelated-scope-evidence",
      subjectRef: finding.subjectRef,
      source: "static_analysis",
      summary: "Unrelated scope evidence. ".repeat(30_000),
      evidenceRefs: [],
    });
    f.checkpoint.analysis.coverage.includedUnits[0]!.evidenceRefs.push(
      "large-unrelated-scope-evidence",
    );
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 16 * 1024 });
    expect(projection.selectedFindingIds).toContain(finding.id);
    expect(projection.selectedUnitIds).toEqual([]);
    expect(projection.context.sourceCoverage.units).toEqual([]);
    expect(projection.context.analysis.evidence.map((entry) => entry.id)).not.toContain(
      "large-unrelated-scope-evidence",
    );
  });

  it("summarizes plan observations before an empty blocked scope unit and then supplies its accepted evidence", () => {
    const f = fixture(0);
    f.task.kind = "pr-verify";
    const unit = f.checkpoint.analysis.coverage.includedUnits[0]!;
    unit.status = "blocked";
    unit.evidenceRefs = [];
    f.checkpoint.analysis.coverage.completedUnitRefs = f.checkpoint.analysis.coverage.includedUnits
      .filter((entry) => entry.status === "completed")
      .map((entry) => entry.id);
    f.checkpoint.analysis.coverage.unresolvedUnitRefs = [unit.id];
    f.checkpoint.runtime.evidence = Array.from({ length: 12 }, (_, index) => ({
      id: `plan-observation-${index}`,
      subjectRef: f.task.subjectRef,
      source: "executor_observation",
      authority: "worker",
      summary: `Observed plan result ${index}. ${"Independent check detail. ".repeat(180)}`,
      artifactRefs: [],
      evidenceRefs: [],
      provenance: {
        taskId: f.task.id,
        attemptId: f.attempt.id,
        producer: "Synthetic plan executor",
        recordedAt: f.task.updatedAt,
      },
    }));
    f.checkpoint.runtime.checks = f.checkpoint.runtime.evidence.map((entry, index) => ({
      id: `plan-check-${index}`,
      scenarioId: "authorized-scenario",
      subjectRef: entry.subjectRef,
      planRef: null,
      required: true,
      description: "Record the authorized execution result.",
      status: index === 11 ? "failed" : "passed",
      executor: "Synthetic plan executor",
      evidenceRefs: [entry.id],
      authoritativeAttemptId: f.attempt.id,
    }));
    let checkpoint = seal(f.checkpoint);
    const seen: string[] = [];
    let observationBatches = 0;
    for (let turn = 0; turn < 12; turn += 1) {
      const projection = prepareModelTurnProjection({
        ...f,
        checkpoint,
        maximumContextBytes: 24 * 1024,
      });
      const pendingObservations = projection.context.counts.pendingObservations!;
      if (pendingObservations === 0) {
        expect(projection.selectedUnitIds).toContain(unit.id);
        expect(projection.context.analysis.evidence.length).toBeGreaterThan(0);
        expect(projection.context.observations.length).toBeGreaterThan(0);
        expect(projection.context.counts.failedRuntimeChecks).toBe(1);
        const delta = emptyDelta(projection);
        delta.analysis.coverageUnits = [
          {
            ...unit,
            status: "completed",
            evidenceRefs: projection.context.analysis.evidence.map((entry) => entry.id),
          },
        ];
        const round = mergeModelTurnDelta(projection, delta);
        expect(round.analysis.coverage.unresolvedUnitRefs).toEqual([]);
        expect(round.analysis.evidence).toHaveLength(12);
        expect(round.continue).toBe(true);
        checkpoint = applyInvestigationLoopRound(checkpoint, round, {
          recordedAt: checkpoint.recordedAt,
          usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
        });
        expect(
          prepareModelTurnProjection({ ...f, checkpoint, maximumContextBytes: 24 * 1024 }).phase,
        ).toBe("finalize");
        break;
      }
      observationBatches += 1;
      expect(projection.context.observations.length).toBeGreaterThan(0);
      expect(projection.selectedUnitIds).toContain(unit.id);
      expect(projection.context.runtime.checks.length).toBe(projection.context.observations.length);
      expect(
        projection.baseAnalysis.coverage.includedUnits.find((entry) => entry.id === unit.id)!
          .status,
      ).toBe("blocked");
      const delta = emptyDelta(projection);
      delta.analysis.evidence = projection.context.observations.map((entry) => ({
        id: `summary-${entry.id}`,
        subjectRef: entry.subjectRef,
        source: "static_analysis",
        summary: "The plan result was considered without assuming the check passed.",
        evidenceRefs: [entry.id],
      }));
      seen.push(...projection.context.observations.map((entry) => entry.id));
      const round = mergeModelTurnDelta(projection, delta);
      expect(round.analysis.coverage.unresolvedUnitRefs).toEqual([unit.id]);
      checkpoint = applyInvestigationLoopRound(checkpoint, round, {
        recordedAt: checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      });
      expect(checkpoint.stopReason).toBe("continuing");
    }
    expect(observationBatches).toBeGreaterThan(1);
    expect(seen).toEqual(f.checkpoint.runtime.evidence.map((entry) => entry.id));
    expect(
      checkpoint.analysis.coverage.includedUnits.find((entry) => entry.id === unit.id)!.status,
    ).toBe("completed");
    expect(checkpoint.runtime.checks.at(-1)!.status).toBe("failed");
  });

  it("requires every real PR diff chunk before selecting the earlier full-diff metadata unit", () => {
    const f = fixture(1);
    const coverage = f.checkpoint.analysis.coverage;
    const metadata = {
      id: "full-diff-summary",
      subjectRef: f.task.subjectRef,
      kind: "full_diff",
      paths: [],
      requiredWork: "Summarize the complete frozen PR diff after every real chunk was inspected.",
      status: "pending" as const,
      evidenceRefs: [],
    };
    const chunks = ["changed-file-chunk", "deleted-file-base-chunk"].map((id) => ({
      id,
      subjectRef: f.task.subjectRef,
      kind: "pr_diff_chunk",
      paths: [id === "changed-file-chunk" ? "src/current.ts" : "src/deleted.ts"],
      requiredWork: "Review this complete chunk using its brokered base, head, and diff material.",
      status: "pending" as const,
      evidenceRefs: [],
    }));
    coverage.includedUnits = [metadata, ...chunks];
    coverage.completedUnitRefs = [];
    coverage.unresolvedUnitRefs = coverage.includedUnits.map((unit) => unit.id);
    let checkpoint = seal(f.checkpoint);
    const prepare = () =>
      prepareModelTurnProjection({ ...f, checkpoint, maximumContextBytes: 64 * 1024 });
    const acceptProjectionDelta = (
      projection: ModelTurnProjection,
      delta: InvestigationModelTurnDeltaV1,
    ) => {
      const round = mergeModelTurnDelta(projection, delta);
      checkpoint = seal({
        ...checkpoint,
        analysis: round.analysis,
        round: round.round,
        version: checkpoint.version + 1,
      });
    };
    let projection = prepare();
    expect(projection.selectedUnitIds).toEqual(chunks.map((unit) => unit.id));
    expect(projection.context.counts.pendingDiffChunks).toBe(2);
    const attemptedMetadataCompletion = emptyDelta(projection);
    attemptedMetadataCompletion.analysis.coverageUnits = [{ ...metadata, status: "completed" }];
    expect(() => mergeModelTurnDelta(projection, attemptedMetadataCompletion)).toThrow(
      /outside its supplied batch/u,
    );
    let delta = emptyDelta(projection);
    delta.analysis.coverageUnits = [{ ...chunks[0]!, status: "completed" }];
    acceptProjectionDelta(projection, delta);
    projection = prepare();
    expect(projection.selectedUnitIds).toEqual([chunks[1]!.id]);
    expect(projection.baseAnalysis.coverage.includedUnits[0]!.status).toBe("pending");
    delta = emptyDelta(projection);
    delta.analysis.coverageUnits = [{ ...chunks[1]!, status: "completed" }];
    acceptProjectionDelta(projection, delta);
    projection = prepare();
    expect(projection.selectedUnitIds).toEqual([metadata.id]);
    expect(projection.context.counts.pendingDiffChunks).toBe(0);
    delta = emptyDelta(projection);
    delta.analysis.coverageUnits = [{ ...metadata, status: "completed" }];
    acceptProjectionDelta(projection, delta);
    projection = prepare();
    expect(projection.phase).toBe("recheck");
    expect(projection.selectedFindingIds).toEqual(
      f.checkpoint.analysis.findings.map((finding) => finding.id),
    );
  });

  it("keeps unfinished diff chunks ahead of candidates, other scope, and runtime observation seeds", () => {
    const f = sourceContinuationFixture();
    f.chunks[0]!.status = "pending";
    f.chunks[0]!.evidenceRefs = [];
    f.checkpoint.analysis.coverage.includedUnits.push({
      ...f.metadata,
      id: "pending-caller-unit",
      kind: "source",
      paths: ["src/caller.ts"],
      status: "pending",
    });
    f.checkpoint.runtime.evidence = [
      {
        id: "unsummarized-worker-observation",
        subjectRef: f.task.subjectRef,
        source: "executor_observation",
        authority: "worker",
        summary: "A separate authorized runtime check produced this observation.",
        artifactRefs: [],
        evidenceRefs: [],
        provenance: {
          taskId: f.task.id,
          attemptId: f.attempt.id,
          producer: "Synthetic executor",
          recordedAt: f.task.updatedAt,
        },
      },
    ];
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 64 * 1024 });
    expect(projection.selectedUnitIds).toEqual([f.chunks[0]!.id]);
    expect(projection.selectedCandidateIds).toEqual([]);
    expect(projection.context.observations).toEqual([]);
    expect(projection.context.sourceCoverage.units).toEqual([]);
    expect(projection.context.counts.pendingDiffChunks).toBe(1);
  });

  it.each(["pr-review", "issue-investigate"] as const)(
    "focuses %s on Core without appending candidate, full-diff, or observation seeds",
    (kind) => {
      const f = focusedSourceContinuationFixture();
      f.task.kind = kind;
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
      expect(projection.selectedUnitIds).toEqual([f.core.id]);
      expect(projection.context.analysis.coverageUnits).toEqual([f.core]);
      expect(projection.selectedCandidateIds).toEqual([]);
      expect(projection.selectedFindingIds).toEqual([]);
      expect(projection.context.sourceCoverage.units).toEqual([]);
      expect(projection.context.observations).toEqual([]);
      expect(projection.context.analysis.evidence.map((entry) => entry.id)).toEqual([
        "core-leaf",
        "core-summary",
      ]);
      expect(projection.context.counts.pendingDiffChunks).toBe(0);
      expect(projection.context.counts.coverageUnits).toBe(70);
      expect(projection.context.counts.pendingCandidates).toBe(1);
      expect(projection.context.counts.pendingObservations).toBe(1);
    },
  );

  it("preserves the original full-diff requirements and blocked status after Core completes", () => {
    const f = focusedSourceContinuationFixture();
    const originalMetadata = structuredClone(f.metadata);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    const delta = emptyDelta(projection);
    delta.analysis.coverageUnits = [{ ...f.core, status: "completed" }];
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.coverage.includedUnits.find((unit) => unit.id === f.metadata.id)).toEqual(
      originalMetadata,
    );
    expect(round.analysis.coverage.unresolvedUnitRefs).toEqual([f.metadata.id]);
    expect(round.analysis.candidates).toEqual([f.candidate]);
    expect(round.continue).toBe(true);
    const checkpoint = seal({
      ...f.checkpoint,
      analysis: round.analysis,
      round: round.round,
      version: f.checkpoint.version + 1,
    });
    const continuation = prepareModelTurnProjection({
      ...f,
      checkpoint,
      maximumContextBytes: 1024 * 1024,
    });
    expect(continuation.selectedUnitIds).toEqual([f.metadata.id]);
    expect(continuation.selectedCandidateIds).toEqual([f.candidate.id]);
    expect(continuation.context.analysis.coverageUnits).toEqual([originalMetadata]);
    expect(continuation.context.sourceCoverage.units.map((unit) => unit.id)).toEqual([
      ...f.chunks.map((unit) => unit.id),
      f.core.id,
    ]);
    expect(
      continuation.context.sourceCoverage.units.find((unit) => unit.id === f.core.id),
    ).toMatchObject({ kind: "source_file", paths: ["src/Core.cs"], status: "completed" });
  });

  it("selects only the first pending source file even when all source files fit", () => {
    const f = focusedSourceContinuationFixture();
    const second = { ...f.core, id: "pending-second-source", paths: ["src/Second.cs"] };
    f.checkpoint.analysis.coverage.includedUnits.push(second);
    f.checkpoint.analysis.coverage.unresolvedUnitRefs.push(second.id);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    expect(projection.selectedUnitIds).toEqual([f.core.id]);
    expect(projection.context.analysis.coverageUnits).toEqual([f.core]);
    expect(projection.selectedCandidateIds).toEqual([]);
  });

  it("supplies every blocked source unit together without mixing the full diff or completing any obligation", () => {
    const f = focusedSourceContinuationFixture();
    f.core.status = "blocked";
    const subscriber = { ...f.core, id: "blocked-subscriber-source", paths: ["src/Subscriber.cs"] };
    const consumer = {
      ...f.core,
      id: "blocked-consumer-source",
      paths: [...f.core.paths, "src/Consumer.cs"],
      requiredWork:
        "Evaluate the consumer with its subscriber and shared source available together.",
    };
    const unrelated = {
      ...f.core,
      id: "blocked-source-dependency",
      kind: "source_dependency" as const,
      paths: ["src/Other.cs"],
    };
    f.checkpoint.analysis.coverage.includedUnits.push(subscriber, consumer, unrelated);
    f.checkpoint.analysis.coverage.unresolvedUnitRefs.push(
      subscriber.id,
      consumer.id,
      unrelated.id,
    );
    const original = structuredClone(f.checkpoint.analysis);
    const expectedIds = [f.core.id, subscriber.id, consumer.id];
    for (const maximumContextBytes of [1024 * 1024, 256 * 1024]) {
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes });
      expect(projection.selectedUnitIds).toEqual(expectedIds);
      expect(projection.context.analysis.coverageUnits).toEqual([f.core, subscriber, consumer]);
      expect(projection.context.sourceCoverage.units).toEqual([]);
      expect(projection.selectedCandidateIds).toEqual([]);
      expect(projection.context.observations).toEqual([]);
      const round = mergeModelTurnDelta(projection, emptyDelta(projection));
      expect(round.analysis.coverage).toEqual(original.coverage);
      expect(round.analysis.candidates).toEqual(original.candidates);
      expect(round.continue).toBe(true);
    }
  });

  it("rejects a joint blocked source batch when only an individual unit fits the metadata budget", () => {
    const f = focusedSourceContinuationFixture();
    f.core.status = "blocked";
    const single = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    const singletonBudget = Buffer.byteLength(JSON.stringify(single.context), "utf8") + 256;
    expect(
      prepareModelTurnProjection({ ...f, maximumContextBytes: singletonBudget }).selectedUnitIds,
    ).toEqual([f.core.id]);
    const extra = ["subscriber", "consumer"].map((name) => ({
      ...f.core,
      id: `blocked-${name}-source`,
      paths: [`src/${name}.cs`],
      requiredWork: `Inspect the complete ${name} in the joint context. `.repeat(80),
    }));
    f.checkpoint.analysis.coverage.includedUnits.push(...extra);
    f.checkpoint.analysis.coverage.unresolvedUnitRefs.push(...extra.map((unit) => unit.id));
    const full = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    expect(full.selectedUnitIds).toEqual([f.core.id, ...extra.map((unit) => unit.id)]);
    expect(() =>
      prepareModelTurnProjection({ ...f, maximumContextBytes: singletonBudget }),
    ).toThrow(ModelTurnProjectionError);
    expect(
      f.checkpoint.analysis.coverage.includedUnits
        .filter((unit) => unit.kind === "source_file")
        .every((unit) => unit.status === "blocked"),
    ).toBe(true);
  });
  it("removes completed source from blocked retries without marking other work complete", () => {
    const f = focusedSourceContinuationFixture();
    f.core.status = "completed";
    const blocked = {
      ...f.core,
      id: "remaining-blocked-source",
      paths: ["src/Remaining.cs"],
      status: "blocked" as const,
    };
    f.checkpoint.analysis.coverage.includedUnits.push(blocked);
    f.checkpoint.analysis.coverage.completedUnitRefs.push(f.core.id);
    f.checkpoint.analysis.coverage.unresolvedUnitRefs = [f.metadata.id, blocked.id];
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    expect(projection.selectedUnitIds).toEqual([blocked.id]);
    expect(projection.context.analysis.coverageUnits).toEqual([blocked]);
    expect(projection.context.sourceCoverage.units).toEqual([readonlySourceRecord(f.core)]);
    expect(
      projection.baseAnalysis.coverage.includedUnits.find((unit) => unit.id === f.metadata.id),
    ).toEqual(f.metadata);
  });

  it.each(["pending", "blocked"] as const)(
    "restores same-subject completed typed source as read-only context for a %s focused unit",
    (status) => {
      const f = focusedSourceContinuationFixture();
      f.core.status = status;
      const completed = {
        ...f.core,
        id: "completed-lifecycle",
        status: "completed" as const,
        paths: ["src/Entry.cs", "src/Application.cs", "src/Core.cs"],
        requiredWork: "Retain the complete application lifecycle evidence.",
      };
      const duplicatePath = {
        ...completed,
        id: "completed-application-owner",
        paths: ["src/Application.cs"],
      };
      const foreign = {
        ...completed,
        id: "completed-other-subject",
        subjectRef: "other-subject",
        paths: ["other/Entry.cs"],
      };
      const otherKind = {
        ...completed,
        id: "completed-other-kind",
        kind: "source_dependency",
        paths: ["src/Other.cs"],
      };
      const empty = { ...completed, id: "completed-empty-source", paths: [] };
      f.checkpoint.analysis.coverage.includedUnits.push(
        completed,
        duplicatePath,
        foreign,
        otherKind,
        empty,
      );
      f.checkpoint.analysis.coverage.completedUnitRefs.push(
        ...[completed, duplicatePath, foreign, otherKind, empty].map((unit) => unit.id),
      );
      const original = structuredClone(f.checkpoint.analysis.coverage);
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
      expect(projection.selectedUnitIds).toEqual([f.core.id]);
      expect(projection.context.analysis.coverageUnits).toEqual([f.core]);
      expect(projection.context.sourceCoverage.units).toEqual(
        [completed, duplicatePath].map(readonlySourceRecord),
      );
      expect(
        projection.context.sourceCoverage.units.some(
          (unit) => unit.kind === "pr_diff_chunk" || unit.kind === "full_diff",
        ),
      ).toBe(false);
      expect(mergeModelTurnDelta(projection, emptyDelta(projection)).analysis.coverage).toEqual(
        original,
      );
      const invalidUpdate = emptyDelta(projection);
      invalidUpdate.analysis.coverageUnits = [{ ...completed, status: "blocked" }];
      expect(() => mergeModelTurnDelta(projection, invalidUpdate)).toThrow(
        ModelOutputValidationError,
      );
    },
  );

  it("refuses to omit required completed source context when only the selected unit fits", () => {
    const f = focusedSourceContinuationFixture();
    f.core.status = "blocked";
    const selectedOnly = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    const selectedOnlyBudget =
      Buffer.byteLength(JSON.stringify(selectedOnly.context), "utf8") + 256;
    expect(
      prepareModelTurnProjection({ ...f, maximumContextBytes: selectedOnlyBudget }).selectedUnitIds,
    ).toEqual([f.core.id]);
    const completed = {
      ...f.core,
      id: "completed-lifecycle",
      status: "completed" as const,
      paths: ["src/Entry.cs", "src/Application.cs"],
      requiredWork: "Preserve the complete accepted lifecycle obligation as read-only context.",
      evidenceRefs: ["accepted-lifecycle-evidence"],
    };
    f.checkpoint.analysis.coverage.includedUnits.push(completed);
    f.checkpoint.analysis.coverage.completedUnitRefs.push(completed.id);
    f.checkpoint.analysis.evidence.push({
      id: "accepted-lifecycle-evidence",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary:
        "The retained lifecycle evidence must accompany its completed source context. ".repeat(100),
      evidenceRefs: [],
    });
    const complete = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    expect(complete.selectedUnitIds).toEqual([f.core.id]);
    expect(complete.context.sourceCoverage.units).toEqual([readonlySourceRecord(completed)]);
    expect(() =>
      prepareModelTurnProjection({ ...f, maximumContextBytes: selectedOnlyBudget }),
    ).toThrow(ModelTurnProjectionError);
    expect(f.core.status).toBe("blocked");
    expect(completed.status).toBe("completed");
  });

  it("keeps pending diff chunks ahead of completed typed source restoration", () => {
    const f = focusedSourceContinuationFixture();
    f.core.status = "blocked";
    const completed = {
      ...f.core,
      id: "completed-lifecycle",
      paths: ["src/Entry.cs"],
      status: "completed" as const,
    };
    f.checkpoint.analysis.coverage.includedUnits.push(completed);
    f.checkpoint.analysis.coverage.completedUnitRefs.push(completed.id);
    const chunk = f.chunks[0]!;
    chunk.status = "pending";
    f.checkpoint.analysis.coverage.completedUnitRefs =
      f.checkpoint.analysis.coverage.completedUnitRefs.filter((id) => id !== chunk.id);
    f.checkpoint.analysis.coverage.unresolvedUnitRefs.push(chunk.id);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    expect(projection.selectedUnitIds).toEqual([chunk.id]);
    expect(projection.context.sourceCoverage.units).toEqual([]);
  });

  it("prioritizes newly pending typed source over an earlier blocked source unit", () => {
    const f = focusedSourceContinuationFixture();
    f.core.status = "blocked";
    const pending = {
      ...f.core,
      id: "new-pending-source",
      paths: ["src/NewDependency.cs"],
      status: "pending" as const,
    };
    f.checkpoint.analysis.coverage.includedUnits.push(pending);
    f.checkpoint.analysis.coverage.unresolvedUnitRefs.push(pending.id);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    expect(projection.selectedUnitIds).toEqual([pending.id]);
    expect(projection.context.analysis.coverageUnits).toEqual([pending]);
    expect(projection.context.sourceCoverage.units).toEqual([]);
    expect(
      projection.baseAnalysis.coverage.includedUnits.find((unit) => unit.id === f.core.id),
    ).toEqual(f.core);
  });

  it("retains ordinary combined seeding for snapshot-only analysis tasks", () => {
    const f = focusedSourceContinuationFixture();
    f.task.executionPolicy.mode = "snapshot_only";
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    expect(projection.selectedUnitIds).toEqual([f.metadata.id, f.core.id]);
    expect(projection.selectedCandidateIds).toEqual([f.candidate.id]);
    expect(projection.context.observations.map((entry) => entry.id)).toEqual([
      "unrelated-worker-observation",
    ]);
    expect(projection.context.sourceCoverage.units).toHaveLength(68);
  });

  it("retains observation-first seeding for non-analysis tasks with pending source files", () => {
    const f = focusedSourceContinuationFixture();
    f.task.kind = "pr-verify";
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
    expect(projection.selectedUnitIds).toEqual([f.metadata.id]);
    expect(projection.selectedCandidateIds).toEqual([]);
    expect(projection.context.observations.map((entry) => entry.id)).toEqual([
      "unrelated-worker-observation",
    ]);
    expect(projection.context.sourceCoverage.units.map((unit) => unit.id)).toEqual(
      f.chunks.map((unit) => unit.id),
    );
  });

  it.each(["pending", "blocked"] as const)(
    "keeps a pending diff chunk ahead of %s source-file continuation",
    (status) => {
      const f = focusedSourceContinuationFixture();
      f.core.status = status;
      const chunk = f.chunks[0]!;
      chunk.status = "pending";
      chunk.evidenceRefs = [];
      f.checkpoint.analysis.coverage.completedUnitRefs = f.chunks.slice(1).map((unit) => unit.id);
      f.checkpoint.analysis.coverage.unresolvedUnitRefs.push(chunk.id);
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 1024 * 1024 });
      expect(projection.selectedUnitIds).toEqual([chunk.id]);
      expect(projection.selectedCandidateIds).toEqual([]);
      expect(projection.context.observations).toEqual([]);
      expect(projection.context.sourceCoverage.units).toEqual([]);
      expect(projection.context.counts.pendingDiffChunks).toBe(1);
    },
  );

  it("supplies completed diff evidence as read-only context for a stateless full-diff continuation", () => {
    const f = sourceContinuationFixture();
    f.checkpoint.analysis.candidates = [];
    f.checkpoint.analysis.evidence.push({
      id: "unrelated-historical-evidence",
      subjectRef: f.task.subjectRef,
      source: "static_analysis",
      summary: "Unrelated accepted history. ".repeat(10_000),
      evidenceRefs: [],
    });
    f.checkpoint.runtime.evidence = [
      {
        id: "chunk-worker-observation",
        subjectRef: f.task.subjectRef,
        source: "executor_observation",
        authority: "worker",
        summary: "The original accepted observation supports the chunk evidence.",
        artifactRefs: [],
        evidenceRefs: [],
        provenance: {
          taskId: f.task.id,
          attemptId: f.attempt.id,
          producer: "Synthetic source executor",
          recordedAt: f.task.updatedAt,
        },
      },
    ];
    f.checkpoint.analysis.evidence[0]!.evidenceRefs = ["chunk-worker-observation"];
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 32 * 1024 });
    expect(projection.selectedUnitIds).toEqual([f.metadata.id]);
    expect(projection.context.sourceCoverage.units).toEqual(
      f.chunks.map(({ requiredWork: _requiredWork, ...unit }) => unit),
    );
    expect(projection.context.sourceCoverage.digest).toBe(
      investigationContentDigest(projection.context.sourceCoverage.units),
    );
    expect(projection.context.analysis.evidence.map((entry) => entry.id)).toEqual([
      "first-chunk-leaf",
      "first-chunk-summary",
      "second-chunk-summary",
    ]);
    expect(projection.context.observations.map((entry) => entry.id)).toEqual([
      "chunk-worker-observation",
    ]);
    const illegalUpdate = emptyDelta(projection);
    illegalUpdate.analysis.coverageUnits = [{ ...f.chunks[0]!, status: "blocked" }];
    expect(() => mergeModelTurnDelta(projection, illegalUpdate)).toThrow(
      /outside its supplied batch/u,
    );
    const delta = emptyDelta(projection);
    delta.analysis.coverageUnits = [
      {
        ...f.metadata,
        status: "completed",
        evidenceRefs: f.chunks.flatMap((unit) => unit.evidenceRefs),
      },
    ];
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.coverage.includedUnits.slice(1)).toEqual(f.chunks);
    expect(round.continue).toBe(true);
    const checkpoint = seal({
      ...f.checkpoint,
      analysis: round.analysis,
      round: round.round,
      version: f.checkpoint.version + 1,
    });
    const finalProjection = prepareModelTurnProjection({
      ...f,
      checkpoint,
      maximumContextBytes: 32 * 1024,
    });
    expect(finalProjection.phase).toBe("finalize");
    expect(mergeModelTurnDelta(finalProjection, emptyDelta(finalProjection)).continue).toBe(false);
  });

  it("selects a pending candidate before blocked full-diff work and retains both when they fit", () => {
    const f = sourceContinuationFixture();
    const combined = prepareModelTurnProjection({ ...f, maximumContextBytes: 64 * 1024 });
    expect(combined.selectedCandidateIds).toEqual([f.candidate.id]);
    expect(combined.selectedUnitIds).toEqual([f.metadata.id]);
    expect(combined.context.sourceCoverage.units.map((unit) => unit.id)).toEqual(
      f.chunks.map((unit) => unit.id),
    );
    f.metadata.requiredWork = "The original complete scope must remain required. ".repeat(2000);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 16 * 1024 });
    expect(projection.selectedCandidateIds).toEqual([f.candidate.id]);
    expect(projection.selectedUnitIds).toEqual([]);
    expect(projection.context.sourceCoverage.units.map((unit) => unit.id)).toEqual([
      f.chunks[0]!.id,
    ]);
    expect(projection.context.analysis.evidence.map((entry) => entry.id)).toEqual([
      "first-chunk-leaf",
      "first-chunk-summary",
      "candidate-source-evidence",
    ]);
    const delta = emptyDelta(projection);
    delta.analysis.candidates = [
      {
        ...f.candidate,
        status: "withdrawn",
        rationale: "The supplied source evidence disproves the candidate after independent review.",
      },
    ];
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.candidates[0]!.status).toBe("withdrawn");
    expect(round.analysis.coverage.includedUnits[0]).toEqual(f.metadata);
    expect(round.analysis.coverage.unresolvedUnitRefs).toEqual([f.metadata.id]);
    expect(round.continue).toBe(true);
  });

  it("recovers candidate source paths only through typed evidence dependencies", () => {
    const f = sourceContinuationFixture();
    f.metadata.status = "completed";
    const caller = {
      ...f.metadata,
      id: "typed-caller-source",
      kind: "source",
      paths: ["src/caller.ts"],
      requiredWork: "Complete all original caller analysis. ".repeat(2000),
      status: "blocked" as const,
      evidenceRefs: ["first-chunk-leaf"],
    };
    f.checkpoint.analysis.coverage.includedUnits.push(caller);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 16 * 1024 });
    expect(projection.selectedCandidateIds).toEqual([f.candidate.id]);
    expect(projection.selectedUnitIds).toEqual([]);
    expect(projection.context.sourceCoverage.units.map((unit) => unit.id)).toEqual([
      f.chunks[0]!.id,
      caller.id,
    ]);
    expect(
      projection.context.sourceCoverage.units.find((unit) => unit.id === caller.id)?.paths,
    ).toEqual(["src/caller.ts"]);
    expect(projection.context.analysis.evidence.map((entry) => entry.id)).not.toContain(
      "second-chunk-summary",
    );
    const delta = emptyDelta(projection);
    delta.analysis.coverageUnits = [{ ...caller, status: "completed" }];
    expect(() => mergeModelTurnDelta(projection, delta)).toThrow(/outside its supplied batch/u);
  });

  it("falls back to the completed frozen diff when candidate evidence only matches empty metadata", () => {
    const f = sourceContinuationFixture();
    f.metadata.status = "completed";
    f.metadata.evidenceRefs = [...f.candidate.evidenceRefs];
    f.checkpoint.analysis.evidence.find(
      (entry) => entry.id === "candidate-source-evidence",
    )!.evidenceRefs = [];
    f.candidate.title = "A prose-only reference to src/unproven-caller.ts must not invent a path.";
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 32 * 1024 });
    expect(projection.selectedUnitIds).toEqual([]);
    expect(projection.context.sourceCoverage.units.map((unit) => unit.id)).toEqual(
      f.chunks.map((unit) => unit.id),
    );
    expect(projection.context.sourceCoverage.units.flatMap((unit) => unit.paths)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
  });
});

describe("bounded native review baseline context", () => {
  it("keeps ordinary candidate wire objects closed while requiring baseline fields together", () => {
    const ordinary = fixture(1).checkpoint.analysis.candidates[0]!;
    expect(Object.hasOwn(ordinary, "reviewBaselineFindingRef")).toBe(false);
    expect(Object.hasOwn(ordinary, "reviewDisposition")).toBe(false);
    expect(Value.Check(InvestigationModelCandidateSchema, ordinary)).toBe(true);
    const reviewBaselineFindingRef = { id: "previous-finding", version: 2 };
    for (const reviewDisposition of [
      "pending",
      "fixed",
      "still_present",
      "not_confirmed",
      "unverified",
    ] as const)
      expect(
        Value.Check(InvestigationModelCandidateSchema, {
          ...ordinary,
          discoveredRound: 0,
          reviewBaselineFindingRef,
          reviewDisposition,
        }),
      ).toBe(true);
    for (const partial of [
      { reviewBaselineFindingRef },
      { reviewDisposition: "pending" },
      { reviewBaselineFindingRef, reviewDisposition: null },
      { reviewBaselineFindingRef: null, reviewDisposition: "pending" },
      { reviewBaselineFindingRef, reviewDisposition: "resolved" },
    ])
      expect(
        Value.Check(InvestigationModelCandidateSchema, {
          ...ordinary,
          discoveredRound: 0,
          ...partial,
        }),
      ).toBe(false);
    expect(
      Value.Check(InvestigationModelCandidateSchema, { ...ordinary, discoveredRound: 0 }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationModelCandidateSchema, {
        ...ordinary,
        discoveredRound: 1,
        reviewBaselineFindingRef,
        reviewDisposition: "pending",
      }),
    ).toBe(false);
  });

  it("omits baseline context entirely for an ordinary review", () => {
    const projection = prepareModelTurnProjection({
      ...fixture(1),
      maximumContextBytes: 100 * 1024,
    });
    expect(Object.hasOwn(projection.context, "reviewBaseline")).toBe(false);
    expect(Object.hasOwn(projection.context.counts, "baselineFindings")).toBe(false);
  });

  it("keeps every current diff chunk ahead of historical finding disposition", () => {
    const f = reviewBaselineFixture(2);
    const metadata: InvestigationAnalysisV1["coverage"]["includedUnits"][number] = {
      id: "current-full-diff",
      subjectRef: f.task.subjectRef,
      kind: "full_diff",
      paths: [],
      requiredWork: "Review the entire current PR before completing the review.",
      status: "pending",
      evidenceRefs: [],
    };
    const chunks: InvestigationAnalysisV1["coverage"]["includedUnits"] = [
      {
        ...metadata,
        id: "current-unrelated-diff-chunk",
        kind: "pr_diff_chunk",
        paths: ["src/unrelated-current.ts"],
        requiredWork: "Review changed code outside every historical finding location.",
      },
      {
        ...metadata,
        id: "current-deleted-diff-chunk",
        kind: "pr_diff_chunk",
        paths: ["src/deleted-current.ts"],
        requiredWork: "Review the deleted code using the current frozen base and head.",
      },
    ];
    const coverage = {
      ...f.checkpoint.analysis.coverage,
      includedUnits: [metadata, ...chunks],
      completedUnitRefs: [],
      unresolvedUnitRefs: [metadata.id, ...chunks.map((unit) => unit.id)],
    };
    f.task.scope = structuredClone(coverage);
    f.checkpoint.analysis.coverage = structuredClone(coverage);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 64 * 1024 });
    expect(projection.selectedUnitIds).toEqual(chunks.map((unit) => unit.id));
    expect(projection.selectedCandidateIds).toEqual([]);
    expect(projection.context.counts.pendingDiffChunks).toBe(2);
    expect(projection.context.reviewBaseline!.findings).toEqual([]);
    expect(projection.context.reviewBaseline!.totalFindingCount).toBe(2);
    expect(projection.baseAnalysis.coverage).toEqual(coverage);
    expect(projection.context.subjects).toEqual(f.task.subjects);
    const prematureCompletion = emptyDelta(projection);
    prematureCompletion.analysis.coverageUnits = [{ ...metadata, status: "completed" }];
    expect(() => mergeModelTurnDelta(projection, prematureCompletion)).toThrow(
      /outside its supplied batch/u,
    );
    const delta = emptyDelta(projection);
    delta.analysis.coverageUnits = chunks.map((unit) => ({ ...unit, status: "completed" }));
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.coverage.unresolvedUnitRefs).toEqual([metadata.id]);
    expect(round.analysis.candidates).toEqual(f.checkpoint.analysis.candidates);
    const checkpoint = seal({
      ...f.checkpoint,
      analysis: round.analysis,
      round: round.round,
      version: f.checkpoint.version + 1,
    });
    const next = prepareModelTurnProjection({ ...f, checkpoint, maximumContextBytes: 64 * 1024 });
    expect(next.selectedUnitIds).toContain(metadata.id);
    expect(next.selectedCandidateIds).toEqual(f.checkpoint.analysis.candidates.map(({ id }) => id));
    expect(next.context.reviewBaseline!.findings).toEqual(f.reviewBaseline.findings);
    expect(f.task.scope).toEqual(coverage);
  });

  it("supplies complete historical findings only for selected candidates while retaining the full ledger", () => {
    const f = reviewBaselineFixture(8, 200);
    const maximumContextBytes = 32 * 1024;
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes });
    const selectedReferences = new Set(
      projection.context.analysis.candidates.map(
        (candidate) => candidate.reviewBaselineFindingRef!.id,
      ),
    );
    const supplied = f.reviewBaseline.findings.filter((finding) =>
      selectedReferences.has(finding.id),
    );
    const omitted = f.reviewBaseline.findings.filter(
      (finding) => !selectedReferences.has(finding.id),
    );
    expect(projection.selectedCandidateIds.length).toBeGreaterThan(0);
    expect(projection.selectedCandidateIds.length).toBeLessThan(f.reviewBaseline.findings.length);
    expect(Buffer.byteLength(JSON.stringify(projection.context), "utf8")).toBeLessThanOrEqual(
      maximumContextBytes,
    );
    expect(projection.context.reviewBaseline).toEqual({
      reportRef: f.reviewBaseline.descriptor.reportRef,
      sourceTaskId: f.reviewBaseline.descriptor.sourceTaskId,
      subject: f.reviewBaseline.descriptor.subject,
      totalFindingCount: f.reviewBaseline.findings.length,
      findings: supplied,
    });
    expect(projection.context.analysis.findings).toEqual([]);
    expect(projection.context.analysis.evidence).toEqual([]);
    expect(projection.baseAnalysis.findings).toEqual([]);
    expect(projection.baseAnalysis.candidates).toEqual(f.checkpoint.analysis.candidates);
    expect(projection.context.subjects).not.toContainEqual(f.reviewBaseline.descriptor.subject);
    expect(omitted.length).toBeGreaterThan(0);
    for (const finding of omitted) {
      expect(projection.context.reviewBaseline!.findings.map(({ id }) => id)).not.toContain(
        finding.id,
      );
      expect(projection.baseAnalysis.candidates).toContainEqual(
        expect.objectContaining({
          reviewBaselineFindingRef: { id: finding.id, version: finding.version },
          status: "pending",
          reviewDisposition: "pending",
        }),
      );
    }
  });

  it("processes many historical findings across bounded batches without dropping comparison detail", () => {
    const f = reviewBaselineFixture(18, 120);
    const maximumContextBytes = 32 * 1024;
    let checkpoint = f.checkpoint;
    const seen: string[] = [];
    let batches = 0;
    for (let turn = 0; turn < f.reviewBaseline.findings.length; turn += 1) {
      const projection = prepareModelTurnProjection({ ...f, checkpoint, maximumContextBytes });
      if (projection.selectedCandidateIds.length === 0) break;
      batches += 1;
      expect(Buffer.byteLength(JSON.stringify(projection.context), "utf8")).toBeLessThanOrEqual(
        maximumContextBytes,
      );
      const selected = projection.context.analysis.candidates;
      const selectedReferences = new Set(
        selected.map((candidate) => candidate.reviewBaselineFindingRef!.id),
      );
      expect(projection.context.reviewBaseline!.findings).toEqual(
        f.reviewBaseline.findings.filter((finding) => selectedReferences.has(finding.id)),
      );
      const delta = emptyDelta(projection);
      delta.analysis.evidence = selected.map((candidate) => ({
        id: `fresh-current-source-${candidate.id}`,
        subjectRef: f.task.subjectRef,
        source: "static_analysis",
        summary:
          "The current frozen source was independently checked and does not confirm the old diagnosis.",
        evidenceRefs: [],
      }));
      delta.analysis.candidates = selected.map((candidate, index) => ({
        ...candidate,
        status: "withdrawn",
        reviewDisposition: "not_confirmed",
        rationale: "Fresh current-source evidence does not confirm the previous diagnosis.",
        evidenceRefs: [delta.analysis.evidence[index]!.id],
      }));
      seen.push(...projection.context.reviewBaseline!.findings.map(({ id }) => id));
      const round = mergeModelTurnDelta(projection, delta, { task: f.task });
      const omitted = new Set(checkpoint.analysis.candidates.map(({ id }) => id));
      for (const candidate of selected) omitted.delete(candidate.id);
      for (const candidate of checkpoint.analysis.candidates.filter(({ id }) => omitted.has(id)))
        expect(round.analysis.candidates).toContainEqual(candidate);
      expect(round.analysis.candidates).toHaveLength(f.reviewBaseline.findings.length);
      checkpoint = applyInvestigationLoopRound(checkpoint, round, {
        recordedAt: checkpoint.recordedAt,
        usage: { durationMs: 0, tokens: 0, reportBytes: 0 },
      });
    }
    expect(batches).toBeGreaterThan(1);
    expect(seen).toEqual(f.reviewBaseline.findings.map(({ id }) => id));
    expect(new Set(seen).size).toBe(f.reviewBaseline.findings.length);
    expect(
      checkpoint.analysis.candidates.every(
        (candidate) => candidate.reviewDisposition === "not_confirmed",
      ),
    ).toBe(true);
    expect(checkpoint.analysis.findings).toEqual([]);
    const finalProjection = prepareModelTurnProjection({ ...f, checkpoint, maximumContextBytes });
    expect(finalProjection.phase).toBe("finalize");
    expect(finalProjection.context.reviewBaseline!.findings).toEqual([]);
    expect(finalProjection.context.reviewBaseline!.totalFindingCount).toBe(
      f.reviewBaseline.findings.length,
    );
  });

  it("rejects an oversized historical finding instead of truncating the comparison context", () => {
    const f = reviewBaselineFixture(1, 30_000);
    expect(projectionInputFailure({ ...f, maximumContextBytes: 32 * 1024 }).code).toBe(
      "MODEL_INPUT_LIMIT_EXCEEDED",
    );
  });

  it("rejects a task baseline without its complete snapshot and a snapshot without a task baseline", () => {
    const f = reviewBaselineFixture();
    expect(
      projectionInputFailure({
        task: f.task,
        attempt: f.attempt,
        checkpoint: f.checkpoint,
        maximumContextBytes: 64 * 1024,
      }).code,
    ).toBe("MODEL_INPUT_INVALID");
    const task = structuredClone(f.task);
    delete task.reviewBaseline;
    expect(projectionInputFailure({ ...f, task, maximumContextBytes: 64 * 1024 }).code).toBe(
      "MODEL_INPUT_INVALID",
    );
  });

  const invalidSnapshots: Array<[string, (snapshot: InvestigationReviewBaselineSnapshot) => void]> =
    [
      [
        "a different report",
        (snapshot) => {
          snapshot.descriptor.reportRef.version += 1;
        },
      ],
      [
        "a different source task",
        (snapshot) => {
          snapshot.descriptor.sourceTaskId = "another-task";
        },
      ],
      [
        "a different frozen subject",
        (snapshot) => {
          snapshot.descriptor.subject.headSha = "9".repeat(40);
        },
      ],
      [
        "different descriptor finding metadata",
        (snapshot) => {
          snapshot.descriptor.findings[0]!.title = "A rewritten title";
        },
      ],
      [
        "a missing full finding",
        (snapshot) => {
          snapshot.findings.pop();
        },
      ],
      [
        "an extra full finding",
        (snapshot) => {
          snapshot.findings.push(structuredClone(snapshot.findings[0]!));
        },
      ],
      [
        "a different full finding ID",
        (snapshot) => {
          snapshot.findings[0]!.id = "another-finding";
        },
      ],
      [
        "a different full finding version",
        (snapshot) => {
          snapshot.findings[0]!.version += 1;
        },
      ],
      [
        "a different full finding title",
        (snapshot) => {
          snapshot.findings[0]!.title = "A rewritten title";
        },
      ],
      [
        "a full finding from another subject",
        (snapshot) => {
          snapshot.findings[0]!.subjectRef = "another-subject";
        },
      ],
    ];
  it.each(invalidSnapshots)("rejects %s in the complete baseline snapshot", (_label, mutate) => {
    const f = reviewBaselineFixture();
    const reviewBaseline = structuredClone(f.reviewBaseline);
    mutate(reviewBaseline);
    expect(
      projectionInputFailure({ ...f, reviewBaseline, maximumContextBytes: 64 * 1024 }).code,
    ).toBe("MODEL_INPUT_INVALID");
  });

  it.each(["replace", "change version", "remove"] as const)(
    "rejects an attempt to %s an accepted candidate's historical finding reference",
    (operation) => {
      const f = reviewBaselineFixture(2);
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 64 * 1024 });
      const candidate = structuredClone(projection.context.analysis.candidates[0]!);
      if (operation === "replace")
        candidate.reviewBaselineFindingRef = {
          id: f.reviewBaseline.findings[1]!.id,
          version: f.reviewBaseline.findings[1]!.version,
        };
      else if (operation === "change version") candidate.reviewBaselineFindingRef!.version += 1;
      else {
        delete candidate.reviewBaselineFindingRef;
        delete candidate.reviewDisposition;
        expect(Value.Check(InvestigationModelCandidateSchema, candidate)).toBe(false);
        candidate.discoveredRound = 1;
      }
      const delta = emptyDelta(projection);
      delta.analysis.candidates = [candidate];
      expect(Value.Check(InvestigationModelTurnDeltaV1Schema, delta)).toBe(true);
      expect(safeModelOutputValidationIssue(outputFailure(projection, delta))!.rule).toBe(
        "candidate_identity_changed",
      );
      expect(projection.baseAnalysis.candidates).toEqual(f.checkpoint.analysis.candidates);
    },
  );

  it("preserves omitted visible and hidden pending candidates without inferring a fixed disposition", () => {
    const f = reviewBaselineFixture(8, 200);
    const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 32 * 1024 });
    expect(projection.selectedCandidateIds.length).toBeGreaterThan(0);
    expect(projection.selectedCandidateIds.length).toBeLessThan(f.reviewBaseline.findings.length);
    const delta = emptyDelta(projection);
    delta.analysis.summary = "The supplied batch contains no confirmed current finding.";
    const round = mergeModelTurnDelta(projection, delta);
    expect(round.analysis.candidates).toEqual(f.checkpoint.analysis.candidates);
    expect(round.analysis.candidates.every((candidate) => candidate.status === "pending")).toBe(
      true,
    );
    expect(
      round.analysis.candidates.every((candidate) => candidate.reviewDisposition === "pending"),
    ).toBe(true);
    expect(round.analysis.findings).toEqual([]);
    expect(round.continue).toBe(true);
    expect(delta.analysis.candidates).toEqual([]);
  });
});
