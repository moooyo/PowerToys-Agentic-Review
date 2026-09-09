import type * as C from "@agentic-review/contracts";
import { cellResultFixture } from "../evaluation-batches/fixtures.testing";
import { evaluationTestActor } from "../evaluations/fixtures.testing";

export const adjudicationActorFixture = { ...evaluationTestActor };
export function adjudicationResultFixture(): C.EvaluationCellResultV1 {
  const result = cellResultFixture();
  result.evidenceComplete = false;
  result.modelReview.findings = [0, 1].map((ordinal) => ({
    findingId: "same-display-id",
    ordinal,
    priority: 1,
    title: `Finding ${ordinal + 1}`,
    body: `Model finding body ${ordinal + 1}`,
    path: "src/file.ts",
    line: ordinal + 1,
    endLine: null,
    confidence: 0.9,
  }));
  result.modelReview.observations = [
    {
      id: "observation-one",
      title: "Observation",
      body: "Model observation body",
      priority: 2,
      path: null,
      line: null,
    },
  ];
  result.occurrences = [0, 1, 2].map((index) => ({
    key: String(index + 1).repeat(64),
    resultId: result.resultId,
    resultDigest: result.resultDigest,
    kind: index === 2 ? "validation_observation" : "pr_finding",
    ordinal: index === 2 ? 0 : index,
  }));
  return result;
}
export function adjudicationContextFixture(): C.EvaluationAdjudicationContextV1 {
  const result = adjudicationResultFixture();
  return {
    schemaVersion: "EvaluationAdjudicationContextV1",
    scope: {
      repositoryId: result.repositoryId,
      evaluationId: result.evaluationId,
      cellId: result.cellId,
      resultId: result.resultId,
    },
    resultDigest: result.resultDigest,
    caseId: result.caseId,
    arm: result.arm,
    modelRequired: result.modelRequirements.required,
    modelState: result.modelReview.state,
    expectations: {
      annotation: "partial",
      expected: [
        { expectedFindingId: "expected-one", description: "The known defect" },
        { expectedFindingId: "expected-two", description: "Another expected defect" },
      ],
    },
    items: result.occurrences.map((occurrence) => ({ occurrence, version: 0, adjudication: null })),
  };
}
export function adjudicationScopeFixture(): C.EvaluationAdjudicationScope {
  return { ...adjudicationContextFixture().scope, occurrenceKey: "1".repeat(64) };
}
export function adjudicationRequestFixture(): C.EvaluationAdjudicationChangeRequest {
  return {
    changeId: "judge-one",
    expectedVersion: 0,
    resultDigest: adjudicationResultFixture().resultDigest,
    judgment: {
      kind: "match",
      expectedFindingId: "expected-one",
      reason: "The model found the frozen expected defect.",
    },
  };
}
export function adjudicationChangeFixture(
  request = adjudicationRequestFixture(),
  scope = adjudicationScopeFixture(),
): C.EvaluationAdjudicationChangeV1 {
  return {
    schemaVersion: "EvaluationAdjudicationChangeV1",
    scope,
    previousVersion: request.expectedVersion,
    version: request.expectedVersion + 1,
    adjudication: {
      ...request.judgment,
      adjudicationId: `judgment-${request.expectedVersion + 1}`,
      caseId: adjudicationResultFixture().caseId,
      arm: adjudicationResultFixture().arm,
      resultId: scope.resultId,
      resultDigest: request.resultDigest,
      occurrenceKey: scope.occurrenceKey,
      actor: { ...adjudicationActorFixture },
      createdAt: "2026-09-08T00:00:00.000Z",
    },
  };
}
export function adjudicationHistoryFixture(): C.EvaluationAdjudicationHistoryV1 {
  const change = adjudicationChangeFixture();
  return {
    schemaVersion: "EvaluationAdjudicationHistoryV1",
    scope: change.scope,
    resultDigest: change.adjudication.resultDigest,
    page: 1,
    pageSize: 20,
    total: 1,
    items: [{ version: 1, previousEventId: null, adjudication: change.adjudication }],
  };
}
