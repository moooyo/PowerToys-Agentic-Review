import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  type InvestigationAnalysisV1,
  type InvestigationCandidate,
  InvestigationCandidateSchema,
  type InvestigationResultV1,
  InvestigationResultV1Schema,
  InvestigationReviewBaselineDescriptorSchema,
  type InvestigationReviewBaselineSnapshot,
  InvestigationReviewBaselineSnapshotSchema,
  InvestigationTaskV1Schema,
  validateInvestigationAnalysisForTask,
  validateInvestigationResult,
  validateInvestigationReviewBaselineSnapshot,
  validateInvestigationTask,
} from "./investigation.js";
import { createInvestigationFixture } from "./investigation.testing.js";
import { deriveInvestigationReviewComparison } from "./investigation-review-comparison.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

function baselineSnapshot(findingCount = 1): InvestigationReviewBaselineSnapshot {
  const fixture = createInvestigationFixture("pr", { findingCount });
  const original = fixture.task.subjects[0]!;
  if (original.kind !== "original_pr") throw new Error("Expected an original PR subject.");
  const subject = {
    ...original,
    id: "baseline-pr-subject",
    revisionKey: "6".repeat(64),
    headSha: "7".repeat(40),
  };
  const findings = structuredClone(fixture.result.findings);
  for (const [index, finding] of findings.entries()) {
    finding.id = `baseline-finding-${index + 1}`;
    finding.subjectRef = subject.id;
    for (const location of finding.locations) location.subjectRef = subject.id;
    if (finding.feedbackDraft.suggestion !== null) {
      finding.feedbackDraft.suggestion.subjectRef = subject.id;
      finding.feedbackDraft.suggestion.headSha = subject.headSha;
    }
  }
  return {
    descriptor: {
      reportRef: { id: "baseline-report", version: 2, digest: "8".repeat(64) },
      sourceTaskId: "baseline-task",
      subject,
      findings: findings.map(({ id, version, title }) => ({ id, version, title })),
    },
    findings,
  };
}

function baselineFixture(
  currentFindingCount = 0,
  baselineFindingCount = 1,
  outcome: "completed" | "cancelled" = "completed",
) {
  const fixture = createInvestigationFixture("pr", { findingCount: currentFindingCount, outcome });
  const snapshot = baselineSnapshot(baselineFindingCount);
  fixture.task.reviewBaseline = structuredClone(snapshot.descriptor);
  fixture.result.context.reviewBaseline = structuredClone(snapshot.descriptor);
  const seededCandidates: InvestigationCandidate[] = snapshot.descriptor.findings.map(
    (finding, index) => ({
      id: `baseline-candidate-${index + 1}`,
      subjectRef: fixture.task.subjectRef,
      title: finding.title,
      discoveredRound: 0,
      status: "pending",
      findingId: null,
      findingVersion: null,
      mergedIntoCandidateId: null,
      rationale: "Recheck this previous finding against the current frozen PR source.",
      evidenceRefs: [],
      reviewBaselineFindingRef: { id: finding.id, version: finding.version },
      reviewDisposition: "pending",
    }),
  );
  fixture.result.report.loop.candidates.unshift(...seededCandidates);
  fixture.result.report.collections.candidates = fixture.result.report.loop.candidates.length;
  const evidenceId = "current-review-evidence";
  fixture.result.verificationEvidence.push({
    id: evidenceId,
    subjectRef: fixture.task.subjectRef,
    source: "static_analysis",
    authority: "model",
    summary: "The current source was inspected independently of the previous report.",
    artifactRefs: [],
    evidenceRefs: [fixture.result.verificationEvidence[0]!.id],
    provenance: {
      taskId: fixture.task.id,
      attemptId: fixture.attempt.id,
      producer: "synthetic-rereview",
      recordedAt: "2026-10-01T02:00:00.000Z",
    },
  });
  fixture.result.report.collections.verificationEvidence =
    fixture.result.verificationEvidence.length;
  return { ...fixture, snapshot, seededCandidates, evidenceId };
}

function withdraw(
  fixture: ReturnType<typeof baselineFixture>,
  disposition: "fixed" | "not_confirmed" | "unverified" = "fixed",
): void {
  for (const candidate of fixture.seededCandidates) {
    candidate.status = "withdrawn";
    candidate.reviewDisposition = disposition;
    candidate.rationale = "The current source evidence supports this explicit review conclusion.";
    candidate.evidenceRefs = [fixture.evidenceId];
  }
}

function proposedAnalysis(result: InvestigationResultV1): InvestigationAnalysisV1 {
  return {
    schemaVersion: "InvestigationAnalysisV1",
    summary: result.report.summary,
    coverage: structuredClone(result.report.coverage),
    findings: structuredClone(result.findings),
    assessment: structuredClone(result.assessment),
    candidates: structuredClone(result.report.loop.candidates),
    rechecks: structuredClone(result.report.recheck.records),
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
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...plan }) => plan,
    ),
    nextActions: result.nextActions.map(
      ({ state: _state, sourceReportRef: _source, ...action }) => action,
    ),
    feedbackDrafts: structuredClone(result.feedbackDrafts),
    diagnostics: structuredClone(result.diagnostics),
    limitations: structuredClone(result.report.limitations),
  };
}

function expectInvalidResult(result: InvestigationResultV1): void {
  expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
  expect(validateInvestigationResult(result).valid).toBe(false);
}

describe("frozen review baseline snapshot", () => {
  it("preserves every full previous finding without a page-sized truncation", () => {
    const snapshot = baselineSnapshot(151);
    expect(Value.Check(InvestigationReviewBaselineSnapshotSchema, snapshot)).toBe(true);
    expect(validateInvestigationReviewBaselineSnapshot(snapshot)).toEqual({
      valid: true,
      errors: [],
    });
    expect(snapshot.findings).toHaveLength(151);
    expect(snapshot.findings[150]!.trigger.steps).not.toHaveLength(0);
    expect(snapshot.findings[150]!.rootCause.explanation).not.toBe("");
  });

  it.each([
    "missing",
    "extra",
    "duplicate",
    "version",
    "title",
    "subject",
    "ordinal",
    "location",
    "suggestionHead",
    "order",
  ] as const)(
    "rejects a structurally valid snapshot with a %s finding binding mismatch",
    (mutation) => {
      const snapshot = baselineSnapshot(2);
      if (mutation === "missing") snapshot.findings.pop();
      if (mutation === "extra") {
        const extra = structuredClone(snapshot.findings[0]!);
        extra.id = "unbound-baseline-finding";
        snapshot.findings.push(extra);
      }
      if (mutation === "duplicate") snapshot.findings[1] = structuredClone(snapshot.findings[0]!);
      if (mutation === "version") snapshot.findings[0]!.version += 1;
      if (mutation === "title") snapshot.findings[0]!.title = "A different previous finding";
      if (mutation === "subject") snapshot.findings[0]!.subjectRef = "unbound-baseline-subject";
      if (mutation === "ordinal") snapshot.findings[0]!.ordinal = 1;
      if (mutation === "location")
        snapshot.findings[0]!.locations[0]!.subjectRef = "unbound-location-subject";
      if (mutation === "suggestionHead")
        snapshot.findings[0]!.feedbackDraft.suggestion!.headSha = "9".repeat(40);
      if (mutation === "order") snapshot.findings.reverse();
      expect(Value.Check(InvestigationReviewBaselineSnapshotSchema, snapshot)).toBe(true);
      expect(validateInvestigationReviewBaselineSnapshot(snapshot).valid).toBe(false);
    },
  );

  it("requires the descriptor to identify an original PR source", () => {
    const snapshot = baselineSnapshot();
    const issue = createInvestigationFixture("bug").task.subjects[0]!;
    expect(
      Value.Check(InvestigationReviewBaselineDescriptorSchema, {
        ...snapshot.descriptor,
        subject: issue,
      }),
    ).toBe(false);
  });
});

describe("native review baseline task binding", () => {
  it("keeps the review task rooted in its current source without inheriting the baseline subject", () => {
    const fixture = baselineFixture();
    expect(Value.Check(InvestigationTaskV1Schema, fixture.task)).toBe(true);
    expect(validateInvestigationTask(fixture.task)).toEqual({ valid: true, errors: [] });
    expect(fixture.task.parentTaskId).toBeNull();
    expect(fixture.task.parentReportRef).toBeNull();
    expect(fixture.task.subjects).toHaveLength(1);
    expect(
      fixture.task.subjects.some(
        (subject) => subject.id === fixture.snapshot.descriptor.subject.id,
      ),
    ).toBe(false);
  });

  it.each([
    "repository",
    "workItem",
    "parent",
    "duplicateFinding",
    "sourceTask",
    "plan",
    "execution",
    "inheritedSubject",
  ] as const)("rejects a %s baseline binding outside a native PR review", (mutation) => {
    const fixture = baselineFixture();
    const baseline = fixture.task.reviewBaseline!;
    if (mutation === "repository") baseline.subject.repositoryId = "another-repository";
    if (mutation === "workItem") baseline.subject.workItemId = "another-pr";
    if (mutation === "parent") {
      fixture.task.parentTaskId = baseline.sourceTaskId;
      fixture.task.parentReportRef = structuredClone(baseline.reportRef);
    }
    if (mutation === "duplicateFinding")
      baseline.findings.push(structuredClone(baseline.findings[0]!));
    if (mutation === "sourceTask") baseline.sourceTaskId = fixture.task.id;
    if (mutation === "plan")
      fixture.task.planRef = { id: "a-saved-plan", version: 1, digest: "9".repeat(64) };
    if (mutation === "execution") fixture.task.executionPolicy.mode = "snapshot_only";
    if (mutation === "inheritedSubject")
      fixture.task.subjects.push(structuredClone(baseline.subject));
    expect(Value.Check(InvestigationTaskV1Schema, fixture.task)).toBe(true);
    expect(validateInvestigationTask(fixture.task).valid).toBe(false);
  });
});

describe("review baseline report conclusions", () => {
  it("accepts a fixed finding only with independent current static evidence on a changed head", () => {
    const fixture = baselineFixture();
    withdraw(fixture);
    expect(Value.Check(InvestigationResultV1Schema, fixture.result)).toBe(true);
    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a fixed conclusion when the same head is reviewed again", () => {
    const fixture = baselineFixture();
    withdraw(fixture);
    const current = fixture.task.subjects[0]!;
    if (current.kind !== "original_pr") throw new Error("Expected an original PR subject.");
    fixture.task.reviewBaseline!.subject.headSha = current.headSha;
    fixture.result.context.reviewBaseline!.subject.headSha = current.headSha;
    expectInvalidResult(fixture.result);
    expect(validateInvestigationResult(fixture.result).errors).toContainEqual(
      expect.objectContaining({ code: "REVIEW_FIX_REQUIRES_NEW_HEAD" }),
    );
    expect(
      validateInvestigationAnalysisForTask(fixture.task, proposedAnalysis(fixture.result)).errors,
    ).toContainEqual(expect.objectContaining({ code: "REVIEW_FIX_REQUIRES_NEW_HEAD" }));
  });

  it("allows the previous conclusion to be not confirmed on the same head", () => {
    const fixture = baselineFixture();
    withdraw(fixture, "not_confirmed");
    const current = fixture.task.subjects[0]!;
    if (current.kind !== "original_pr") throw new Error("Expected an original PR subject.");
    fixture.task.reviewBaseline!.subject.headSha = current.headSha;
    fixture.result.context.reviewBaseline!.subject.headSha = current.headSha;
    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });
  });

  it.each(["missing", "pending", "duplicateRef", "wrongVersion", "ordinaryRoundZero"] as const)(
    "does not accept a complete report with a %s baseline candidate",
    (mutation) => {
      const fixture = baselineFixture();
      withdraw(fixture);
      const candidate = fixture.seededCandidates[0]!;
      if (mutation === "missing") fixture.result.report.loop.candidates = [];
      if (mutation === "pending") {
        candidate.status = "pending";
        candidate.reviewDisposition = "pending";
        candidate.evidenceRefs = [];
      }
      if (mutation === "duplicateRef") {
        const duplicate = structuredClone(candidate);
        duplicate.id = "duplicate-baseline-candidate";
        fixture.result.report.loop.candidates.push(duplicate);
      }
      if (mutation === "wrongVersion") candidate.reviewBaselineFindingRef!.version += 1;
      if (mutation === "ordinaryRoundZero") {
        delete candidate.reviewBaselineFindingRef;
        delete candidate.reviewDisposition;
      }
      fixture.result.report.collections.candidates = fixture.result.report.loop.candidates.length;
      expectInvalidResult(fixture.result);
    },
  );

  it.each(["snapshot", "previousSubject", "previousTask", "missing"] as const)(
    "rejects %s evidence used as the current fixed conclusion",
    (mutation) => {
      const fixture = baselineFixture();
      withdraw(fixture);
      const candidate = fixture.seededCandidates[0]!;
      const evidence = fixture.result.verificationEvidence.find(
        (entry) => entry.id === fixture.evidenceId,
      )!;
      if (mutation === "snapshot")
        candidate.evidenceRefs = [fixture.result.verificationEvidence[0]!.id];
      if (mutation === "previousSubject")
        evidence.subjectRef = fixture.snapshot.descriptor.subject.id;
      if (mutation === "previousTask")
        evidence.provenance.taskId = fixture.snapshot.descriptor.sourceTaskId;
      if (mutation === "missing") candidate.evidenceRefs = ["old-baseline-evidence"];
      expectInvalidResult(fixture.result);
    },
  );

  it("requires limitations when a previous finding remains unverified", () => {
    const fixture = baselineFixture();
    withdraw(fixture, "unverified");
    fixture.result.report.limitations.push({
      id: "baseline-runtime-limitation",
      description: "The current static source does not establish the previous runtime diagnosis.",
      impact:
        "The previous finding remains unverified until independent execution evidence is available.",
      evidenceRefs: [fixture.evidenceId],
    });
    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });
    fixture.result.report.limitations = [];
    expectInvalidResult(fixture.result);
  });

  it("allows an unverified previous finding to remain an explicitly rechecked current hypothesis", () => {
    const fixture = baselineFixture(1);
    const finding = fixture.result.findings[0]!;
    finding.confirmation.status = "hypothesis";
    finding.rootCause.status = "hypothesis";
    const candidate = fixture.seededCandidates[0]!;
    candidate.status = "unresolved";
    candidate.reviewDisposition = "unverified";
    candidate.findingId = finding.id;
    candidate.findingVersion = finding.version;
    candidate.evidenceRefs = [...finding.evidenceRefs];
    for (const current of fixture.result.report.loop.candidates) {
      if (current.findingId === finding.id) current.status = "unresolved";
    }
    fixture.result.report.recheck.records[0]!.unresolvedQuestions = [
      "Does the reported behavior reproduce on the current PR head?",
    ];
    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });
    const comparison = deriveInvestigationReviewComparison(fixture.result)!;
    expect(comparison.findings[0]!.status).toBe("unverified");
    expect(comparison.findings[0]!.currentFindingRef).toEqual({
      id: finding.id,
      version: finding.version,
    });
    expect(comparison.newFindingIds).toEqual([]);
  });

  it("retains a still-present conclusion against the current finding and its current final recheck", () => {
    const fixture = baselineFixture(1);
    const candidate = fixture.seededCandidates[0]!;
    const finding = fixture.result.findings[0]!;
    candidate.status = "confirmed";
    candidate.reviewDisposition = "still_present";
    candidate.findingId = finding.id;
    candidate.findingVersion = finding.version;
    candidate.evidenceRefs = [...finding.evidenceRefs];
    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });
    fixture.result.report.recheck.records = [];
    fixture.result.report.recheck.validFinalVersionRecheckCount = 0;
    fixture.result.report.recheck.pendingFindingIds = [finding.id];
    fixture.result.report.collections.rechecks = 0;
    expectInvalidResult(fixture.result);
  });

  it("preserves pending seeds in a cancelled report before the first model round", () => {
    const fixture = baselineFixture(0, 2, "cancelled");
    fixture.result.verificationEvidence = fixture.result.verificationEvidence.filter(
      (entry) => entry.id !== fixture.evidenceId,
    );
    fixture.result.report.collections.verificationEvidence =
      fixture.result.verificationEvidence.length;
    fixture.result.report.loop.completedRounds = 0;
    fixture.result.report.loop.consumed.rounds = 0;
    fixture.result.report.loop.checkpointVersion = 1;
    expect(Value.Check(InvestigationCandidateSchema, fixture.seededCandidates[0]!)).toBe(true);
    expect(Value.Check(InvestigationResultV1Schema, fixture.result)).toBe(true);
    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });
  });

  it("keeps reports without a baseline compatible with the historical native review contract", () => {
    const fixture = createInvestigationFixture("pr", { findingCount: 2 });
    expect(fixture.task.reviewBaseline).toBeUndefined();
    expect(fixture.result.context.reviewBaseline).toBeUndefined();
    expect(Value.Check(InvestigationTaskV1Schema, fixture.task)).toBe(true);
    expect(Value.Check(InvestigationResultV1Schema, fixture.result)).toBe(true);
    expect(validateInvestigationTask(fixture.task)).toEqual({ valid: true, errors: [] });
    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });
    expect(
      fixture.result.report.loop.candidates.every((candidate) => candidate.discoveredRound > 0),
    ).toBe(true);
  });
});

describe("review comparison projection", () => {
  it("projects baseline conclusions in frozen order and identifies only unmatched current findings as new", () => {
    const fixture = baselineFixture(2, 3);
    withdraw(fixture);
    const stillPresent = fixture.seededCandidates[1]!;
    const currentFinding = fixture.result.findings[0]!;
    stillPresent.status = "confirmed";
    stillPresent.reviewDisposition = "still_present";
    stillPresent.findingId = currentFinding.id;
    stillPresent.findingVersion = currentFinding.version;
    stillPresent.evidenceRefs = [...currentFinding.evidenceRefs];
    fixture.seededCandidates[2]!.reviewDisposition = "not_confirmed";

    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });

    const comparison = deriveInvestigationReviewComparison(fixture.result);
    expect(comparison).not.toBeNull();
    expect(comparison!.baselineReportRef).toEqual(fixture.snapshot.descriptor.reportRef);
    expect(comparison!.baselineHeadSha).toBe(fixture.snapshot.descriptor.subject.headSha);
    expect(comparison!.currentHeadSha).toBe("b".repeat(40));
    expect(comparison!.findings.map((entry) => entry.status)).toEqual([
      "fixed",
      "still_present",
      "not_confirmed",
    ]);
    expect(comparison!.findings.map((entry) => entry.baselineFindingRef)).toEqual(
      fixture.snapshot.descriptor.findings.map(({ id, version }) => ({ id, version })),
    );
    expect(comparison!.findings[0]!.currentFindingRef).toBeNull();
    expect(comparison!.findings[1]!).toEqual(
      expect.objectContaining({
        title: fixture.snapshot.descriptor.findings[1]!.title,
        candidateId: stillPresent.id,
        currentFindingRef: { id: currentFinding.id, version: currentFinding.version },
        rationale: stillPresent.rationale,
        evidenceRefs: stillPresent.evidenceRefs,
      }),
    );
    expect(comparison!.newFindingIds).toEqual([fixture.result.findings[1]!.id]);
  });

  it("follows a still-present merge to its retained current finding", () => {
    const fixture = baselineFixture(1);
    const seed = fixture.seededCandidates[0]!;
    const retained = fixture.result.report.loop.candidates.find(
      (candidate) => candidate.reviewBaselineFindingRef === undefined,
    )!;
    seed.status = "merged";
    seed.reviewDisposition = "still_present";
    seed.mergedIntoCandidateId = retained.id;
    seed.evidenceRefs = [...retained.evidenceRefs];
    expect(validateInvestigationResult(fixture.result)).toEqual({ valid: true, errors: [] });
    const comparison = deriveInvestigationReviewComparison(fixture.result)!;
    expect(comparison.findings[0]!.currentFindingRef).toEqual({
      id: fixture.result.findings[0]!.id,
      version: fixture.result.findings[0]!.version,
    });
    expect(comparison.newFindingIds).toEqual([]);
  });

  it("keeps a cancelled pending finding visible without claiming a current finding", () => {
    const fixture = baselineFixture(0, 1, "cancelled");
    const comparison = deriveInvestigationReviewComparison(fixture.result)!;
    expect(comparison.findings[0]!.status).toBe("pending");
    expect(comparison.findings[0]!.currentFindingRef).toBeNull();
    expect(comparison.newFindingIds).toEqual([]);
  });

  it("does not synthesize a comparison for an ordinary historical report", () => {
    const fixture = createInvestigationFixture("pr", { findingCount: 2 });
    expect(deriveInvestigationReviewComparison(fixture.result)).toBeNull();
  });

  it("keeps a missing review record pending instead of inferring a fix from the absence of a current finding", () => {
    const fixture = baselineFixture();
    fixture.result.report.loop.candidates = [];
    const comparison = deriveInvestigationReviewComparison(fixture.result)!;
    expect(comparison.findings[0]!).toEqual(
      expect.objectContaining({
        status: "pending",
        candidateId: null,
        currentFindingRef: null,
        evidenceRefs: [],
      }),
    );
  });
});
