import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
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

describe("bounded investigation model context", () => {
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
  it("exposes the accepted consumption and clamped remaining budget without spending the next round", () => {
    const f = fixture(0);
    const budget = structuredClone(f.task.budget);
    for (const consumed of [
      { rounds: 0, durationMs: 0, tokens: 0, reportBytes: 0 },
      { rounds: 7, durationMs: 1234, tokens: 4567, reportBytes: 8910 },
      {
        rounds: budget.maxRounds,
        durationMs: budget.maxDurationMs,
        tokens: budget.maxTokens,
        reportBytes: budget.maxReportBytes,
      },
      {
        rounds: budget.maxRounds + 1,
        durationMs: budget.maxDurationMs + 1,
        tokens: budget.maxTokens + 1,
        reportBytes: budget.maxReportBytes + 1,
      },
    ]) {
      f.checkpoint.consumed = consumed;
      const projection = prepareModelTurnProjection({ ...f, maximumContextBytes: 32 * 1024 });
      expect(projection.context.task.budget).toEqual(budget);
      expect(projection.context.budgetState).toEqual({
        consumed,
        remaining: {
          rounds: Math.max(0, budget.maxRounds - consumed.rounds),
          durationMs: Math.max(0, budget.maxDurationMs - consumed.durationMs),
          tokens: Math.max(0, budget.maxTokens - consumed.tokens),
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

  it("keeps an appended recheck pending until the updated finding and its owners link to that version", () => {
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
    const retryProjection = prepareModelTurnProjection({
      ...f,
      checkpoint,
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
      checkpoint,
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
    expect(() => mergeModelTurnDelta(projection, delta)).toThrow(/outside its supplied batch/u);
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
    expect(() => mergeModelTurnDelta(projection, delta)).toThrow(/every owning candidate/u);
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
    expect(() => mergeModelTurnDelta(projection, delta)).toThrow(/duplicate/u);
    delta.analysis.candidates = [];
    delta.analysis.evidence = [
      { ...projection.context.analysis.evidence[0]!, summary: "Changed accepted evidence." },
    ];
    expect(() => mergeModelTurnDelta(projection, delta)).toThrow(/immutable/u);
    delta.analysis.evidence = [];
    delta.round += 1;
    expect(() => mergeModelTurnDelta(projection, delta)).toThrow(/does not match/u);
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
        /references evidence outside its supplied batch or new records/u,
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
        ModelTurnProjectionError,
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
