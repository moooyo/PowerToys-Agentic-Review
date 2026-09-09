import type * as C from "@agentic-review/contracts";
import { cellResultFixture } from "../evaluation-batches/fixtures.testing";
import { evaluationTestActor } from "../evaluations/fixtures.testing";

export const assessmentTestScope = { repositoryId: "repository-a", evaluationId: "evaluation-a" };
const ratio = (
  numerator: number,
  denominator: number,
  value: number | null,
): C.EvaluationRatio => ({ numerator, denominator, value });
function aggregate(correct: boolean): C.EvaluationArmAggregate {
  return {
    coverage: {
      applicableCases: 1,
      notApplicableCases: 0,
      completedCases: 1,
      pendingCases: 0,
      notRunCases: 0,
      failedCases: 0,
      blockedCases: 0,
      cancelledCases: 0,
      invalidCases: 0,
      execution: ratio(1, 1, 1),
      applicableCriteria: 1,
      scoredCriteria: 1,
      unmappedCriteria: 0,
      unavailableCriteria: 0,
      notRunCriteria: 0,
      notApplicableCriteria: 0,
      checks: ratio(1, 1, 1),
      availableModels: 0,
      models: ratio(0, 1, 0),
      completeAnnotationCases: 1,
      partialAnnotationCases: 0,
      unlabeledCases: 0,
      provisionalFindingCases: 1,
    },
    quality: {
      correctChecks: correct ? 1 : 0,
      incorrectChecks: correct ? 0 : 1,
      checkAgreement: ratio(correct ? 1 : 0, 1, correct ? 1 : 0),
      truePositives: 0,
      falsePositives: 0,
      duplicates: 0,
      unjudged: 0,
      falseNegatives: 0,
      unresolvedExpected: 1,
      knownPositiveRecall: ratio(0, 1, null),
      precision: ratio(0, 0, null),
      recall: ratio(0, 1, null),
      provisional: true,
    },
  };
}
export function assessmentScoringFixture(): C.EvaluationScoringSummaryV1 {
  const counts = {
    compared: 0,
    improved: 0,
    regressed: 0,
    unchanged: 0,
    coverageImproved: 0,
    coverageRegressed: 0,
    unavailable: 1,
    notApplicable: 0,
    coverage: ratio(0, 1, 0),
  };
  return {
    rulesVersion: "explicit-matching-v2",
    planDigest: "b".repeat(64),
    baseline: aggregate(true),
    candidate: aggregate(false),
    paired: {
      criteria: { ...counts, compared: 1, regressed: 1, unavailable: 0, coverage: ratio(1, 1, 1) },
      findings: counts,
    },
  };
}
export function assessmentPreviewFixture(): C.EvaluationScorePreviewV1 {
  return {
    schemaVersion: "EvaluationScorePreviewV1",
    ...assessmentTestScope,
    generatedAt: "2026-09-08T00:00:00.000Z",
    assessmentVersion: 0,
    selectionDigest: "a".repeat(64),
    scoringPlanDigest: "b".repeat(64),
    observationDigest: "c".repeat(64),
    adjudicationDigest: "d".repeat(64),
    inputDigest: "e".repeat(64),
    summary: assessmentScoringFixture(),
    caseIds: ["case-1"],
  };
}
export function assessmentRequestFixture(): C.EvaluationAssessmentPublishRequest {
  return {
    changeId: "save-report-a",
    expectedVersion: 0,
    expectedInputDigest: assessmentPreviewFixture().inputDigest,
  };
}
export function assessmentSummaryFixture(): C.EvaluationAssessmentSummaryV1 {
  const preview = assessmentPreviewFixture();
  return {
    schemaVersion: "EvaluationAssessmentSummaryV1",
    ...assessmentTestScope,
    assessmentId: "assessment-a",
    version: 1,
    scorerVersion: preview.summary.rulesVersion,
    scoringPlanDigest: preview.scoringPlanDigest,
    observationDigest: preview.observationDigest,
    adjudicationDigest: preview.adjudicationDigest,
    reportDigest: "f".repeat(64),
    createdAt: preview.generatedAt,
    createdBy: { ...evaluationTestActor },
    summary: preview.summary,
    caseIds: preview.caseIds,
  };
}
export function assessmentListFixture(): C.EvaluationAssessmentListV1 {
  return {
    schemaVersion: "EvaluationAssessmentListV1",
    ...assessmentTestScope,
    page: 1,
    pageSize: 20,
    total: 1,
    items: [assessmentSummaryFixture()],
  };
}
export function assessmentCaseFixture(): C.EvaluationAssessmentCaseV1 {
  const source = cellResultFixture().sourceDigest;
  const arm = (side: "baseline" | "candidate"): C.EvaluationArmCaseAssessment => ({
    cellId: `cell-${side}`,
    runId: `run-${side}`,
    requestId: `request-${side}`,
    executionState: "completed",
    executionReason: null,
    result: {
      resultId: `result-${side}`,
      resultDigest: "a".repeat(64),
      jobId: `job-${side}`,
      runAttemptId: `attempt-${side}`,
      profileVersionId: `profile-${side}`,
      promptVersionId: `prompt-${side}`,
      executionDigest: "c".repeat(64),
      sourceDigest: source,
    },
    criteria: [
      {
        criterionId: "criterion-1",
        checkId: `profile-${side}:build`,
        state: side === "baseline" ? "correct" : "incorrect",
        actualOutcome: side === "baseline" ? "failed" : "passed",
        reason: null,
      },
    ],
    findings: {
      annotation: "complete",
      state: "unavailable",
      reason: "The model output was unavailable.",
      modelAvailable: false,
      expected: [
        {
          expectedFindingId: "expected-one",
          state: "unresolved",
          occurrenceKey: null,
          adjudicationId: null,
        },
      ],
      occurrences: [],
      truePositives: 0,
      falsePositives: 0,
      duplicates: 0,
      unjudged: 0,
      falseNegatives: 0,
      unresolvedExpected: 1,
      knownPositiveRecall: ratio(0, 1, null),
      precision: ratio(0, 0, null),
      recall: ratio(0, 1, null),
    },
  });
  const baseline = arm("baseline"),
    candidate = arm("candidate"),
    summary = assessmentSummaryFixture();
  return {
    schemaVersion: "EvaluationAssessmentCaseV1",
    scope: { ...assessmentTestScope, assessmentId: summary.assessmentId, caseId: "case-1" },
    reportDigest: summary.reportDigest,
    scoringPlanDigest: summary.scoringPlanDigest,
    caseTitle: "Known failing build",
    expectation: {
      caseId: "case-1",
      sourceDigest: source,
      baselineBinding: {
        cellId: baseline.cellId,
        runId: baseline.runId,
        requestId: baseline.requestId,
      },
      candidateBinding: {
        cellId: candidate.cellId,
        runId: candidate.runId,
        requestId: candidate.requestId,
      },
      applicability: { state: "applicable" },
      criteria: [
        {
          criterionId: "criterion-1",
          description: "The original build defect remains a failed check",
          applicability: { state: "applicable" },
          expectedOutcome: "failed",
          baselineCheckId: "profile-baseline:build",
          candidateCheckId: "profile-candidate:build",
        },
      ],
      findings: {
        annotation: "complete",
        expected: [{ expectedFindingId: "expected-one", description: "The known compiler defect" }],
      },
    },
    case: {
      caseId: "case-1",
      applicable: true,
      baseline,
      candidate,
      paired: {
        criteria: [{ criterionId: "criterion-1", change: "regressed" }],
        findings: [{ expectedFindingId: "expected-one", change: "unavailable" }],
        modelCoverage: "unavailable",
        falsePositiveDelta: null,
        duplicateDelta: null,
      },
    },
  };
}
