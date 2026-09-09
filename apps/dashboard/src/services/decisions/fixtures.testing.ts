import type {
  OperatorPrincipal,
  ReviewRunDecisionChangeRequest,
  ReviewRunDecisionContext,
  ReviewRunDecisionEvent,
  ReviewRunDecisionHistoryResponse,
} from "@agentic-review/contracts";

export const repositoryId = "repository-one";
export const reviewRunId = "review-run-one";
export const actor: OperatorPrincipal = {
  issuer: "https://Identity.example/Issuer",
  subject: "Operator-A",
};
export const input: ReviewRunDecisionChangeRequest = {
  changeId: "change-one",
  expectedVersion: 0,
  expectedRevisionKey: "a".repeat(64),
  expectedPlanDigest: "b".repeat(64),
  expectedResultSetDigest: "c".repeat(64),
  action: "approve",
  reason: "Reviewed the measured validation evidence.",
};
export const event: ReviewRunDecisionEvent = {
  repositoryId,
  reviewRunId,
  workItemId: "work-item-one",
  workItemKind: "pull_request",
  id: "decision-one",
  changeId: input.changeId,
  actor,
  previousVersion: 0,
  version: 1,
  createdAt: "2026-09-07T10:00:00.000Z",
  action: "approve",
  reason: input.reason,
  revisionKey: input.expectedRevisionKey,
  planDigest: input.expectedPlanDigest,
  resultSetDigest: input.expectedResultSetDigest,
  supersedesDecisionId: null,
  targetDecisionId: null,
  policyAtDecision: {
    applicable: true,
    eligible: true,
    policyVersion: "required-checks-and-p0-p1-v1",
    blockingFindingCount: 0,
    reasonCount: 0,
    reasonCodes: [],
    reasonCodesTruncated: false,
  },
};
export const context: ReviewRunDecisionContext = {
  repositoryId,
  reviewRunId,
  workItemId: event.workItemId,
  workItemKind: "pull_request",
  revisionKey: input.expectedRevisionKey,
  currentRevisionKey: input.expectedRevisionKey,
  planDigest: input.expectedPlanDigest,
  resultSetDigest: input.expectedResultSetDigest,
  version: 1,
  sourceCurrent: true,
  canApprove: true,
  recordedDecision: event,
  recordedDecisionState: "current",
  stateReasons: [],
  policy: {
    applicable: true,
    eligible: true,
    policyVersion: "required-checks-and-p0-p1-v1",
    blockingFindingCount: 0,
    reasonCount: 0,
    reasons: [],
    reasonsTruncated: false,
  },
};
export const history: ReviewRunDecisionHistoryResponse = {
  repositoryId,
  reviewRunId,
  page: 1,
  pageSize: 20,
  total: 1,
  items: [event],
};
export function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
