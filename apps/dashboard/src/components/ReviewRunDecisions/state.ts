import type {
  DashboardReviewRunDetail,
  OperatorPrincipal,
  OperatorRepositoryPermission,
  ReviewRunDecisionChangeRequest,
  ReviewRunDecisionContext,
  ReviewRunDecisionEvent,
} from "@agentic-review/contracts";
import { ReviewControlHttpError } from "../../services/review-control/errors";

export type DecisionAction = ReviewRunDecisionChangeRequest["action"];
export interface DecisionAccess {
  readonly ready: boolean;
  readonly checking: boolean;
  readonly principal: OperatorPrincipal | null;
  readonly can: (permission: OperatorRepositoryPermission) => boolean;
}

export const decisionPublicationNotice =
  "Recording a decision does not publish a GitHub review or comment. Publication requires a separate preview and confirmation.";

export function decisionPollingInterval(input: {
  readonly mode: "sample" | "connected";
  readonly visible: boolean;
  readonly canRead: boolean;
  readonly hasError: boolean;
}): number | false {
  return input.mode === "connected" && input.visible && input.canRead && !input.hasError
    ? 30_000
    : false;
}

export function decisionActionLabel(action: DecisionAction, kind: "pull_request" | "issue") {
  switch (action) {
    case "approve":
      return "Approve";
    case "request_changes":
      return kind === "issue" ? "Request more information" : "Request changes";
    case "comment":
      return "Comment";
    case "override_approve":
      return "Approval with exception";
    case "withdraw":
      return "Withdraw decision";
  }
}

export function decisionStateLabel(state: ReviewRunDecisionContext["recordedDecisionState"]) {
  return {
    none: "No decision recorded",
    current: "Current recorded decision",
    stale: "Earlier decision · review again",
    withdrawn: "Decision withdrawn",
    ineligible: "Approval no longer eligible",
  }[state];
}

export function decisionStateReason(reason: ReviewRunDecisionContext["stateReasons"][number]) {
  return {
    result_set_changed: "The execution result set has changed since this decision.",
    source_not_current: "This run's source or execution authorization is no longer current.",
    approval_policy_not_satisfied: "The current validation policy does not permit approval.",
  }[reason];
}

export function decisionQueryKey(
  mode: "sample" | "connected",
  repositoryId: string,
  reviewRunId: string,
  principal: OperatorPrincipal,
) {
  return [
    "review-run-decisions",
    mode,
    repositoryId,
    reviewRunId,
    principal.issuer,
    principal.subject,
  ] as const;
}

export function runDecisionRefreshKey(run: DashboardReviewRunDetail) {
  return JSON.stringify([
    run.revisionKey,
    run.currentRevisionKey,
    run.planDigest,
    run.requestEpochId,
    run.activationId,
    run.freshness,
    run.policy.eligible,
    run.policy.blockingFindingCount,
    run.policy.reasonCount,
    run.requests.map((request) => [
      request.requestId,
      request.latestJob?.jobId,
      request.latestJob?.status,
      request.latestJob?.activationNumber,
      request.latestJob?.attemptCount,
      request.latestJob?.runAttemptId,
      request.latestJob?.resultId,
      request.latestJob?.resultDigest,
      request.latestResult?.evidenceComplete,
      request.latestResult?.evidenceVerificationPending,
    ]),
  ]);
}

export function decisionContextMatchesRun(
  context: ReviewRunDecisionContext | undefined,
  run: DashboardReviewRunDetail,
): context is ReviewRunDecisionContext {
  return Boolean(
    context &&
      context.repositoryId === run.repositoryId &&
      context.reviewRunId === run.id &&
      context.workItemId === run.workItemId &&
      context.workItemKind === run.workItemKind &&
      context.revisionKey === run.revisionKey &&
      context.planDigest === run.planDigest,
  );
}

export function decisionEventMatchesRun(
  event: ReviewRunDecisionEvent,
  run: DashboardReviewRunDetail,
) {
  return (
    event.repositoryId === run.repositoryId &&
    event.reviewRunId === run.id &&
    event.workItemId === run.workItemId &&
    event.workItemKind === run.workItemKind &&
    event.revisionKey === run.revisionKey &&
    event.planDigest === run.planDigest
  );
}

export function decisionUnavailableReason(
  action: DecisionAction,
  context: ReviewRunDecisionContext,
  access: DecisionAccess,
) {
  if (access.checking) return "Checking repository permissions.";
  if (!access.ready || !access.principal) return "Repository permissions are unavailable.";
  if (!access.can("read")) return "Repository read access is required.";
  if (action === "withdraw") {
    if (!access.can("review")) return "Reviewer access is required to withdraw a decision.";
    const current = context.recordedDecision;
    if (!current || current.action === "withdraw") return "There is no decision to withdraw.";
    if (
      !access.can("configure") &&
      (current.actor.issuer !== access.principal.issuer ||
        current.actor.subject !== access.principal.subject)
    ) {
      return "Only the decision author or a maintainer can withdraw this decision.";
    }
    return null;
  }
  if (!access.can(action === "override_approve" ? "configure" : "review")) {
    return action === "override_approve"
      ? "Maintainer access is required for an override."
      : "Reviewer access is required to record a decision or comment.";
  }
  if (context.workItemKind === "issue" && (action === "approve" || action === "override_approve")) {
    return "Issue runs do not support approval.";
  }
  if (action !== "comment" && !context.sourceCurrent) {
    return "Review a run with current source and execution authorization before recording a new decision.";
  }
  if (action === "approve" && !context.canApprove) {
    return "Required validation and current policy must permit approval.";
  }
  return null;
}

export function decisionRetryUnavailableReason(
  editor: DecisionEditorState,
  access: DecisionAccess,
) {
  // An exact retry may return an earlier receipt even after source or policy changes.
  // If the original intent was never accepted, the server still checks its original binding.
  return decisionUnavailableReason(
    editor.action,
    {
      ...editor.reviewed,
      sourceCurrent: true,
      canApprove: editor.reviewed.workItemKind === "pull_request",
    } as ReviewRunDecisionContext,
    access,
  );
}

export function isDecisionAccessDenied(error: unknown) {
  return error instanceof ReviewControlHttpError && [401, 403, 404].includes(error.status);
}

export interface DecisionEditorState {
  readonly action: DecisionAction;
  readonly reason: string;
  readonly reviewed: ReviewRunDecisionContext;
  readonly request: ReviewRunDecisionChangeRequest | null;
  readonly conflict: boolean;
  readonly candidate: ReviewRunDecisionContext | null;
}

export function createDecisionEditor(
  context: ReviewRunDecisionContext,
  action: DecisionAction,
): DecisionEditorState {
  return {
    action,
    reason: "",
    reviewed: structuredClone(context),
    request: null,
    conflict: false,
    candidate: null,
  };
}

export function decisionBindingMatches(
  left: ReviewRunDecisionContext,
  right: ReviewRunDecisionContext,
) {
  return (
    left.repositoryId === right.repositoryId &&
    left.reviewRunId === right.reviewRunId &&
    left.workItemId === right.workItemId &&
    left.workItemKind === right.workItemKind &&
    left.version === right.version &&
    left.revisionKey === right.revisionKey &&
    left.planDigest === right.planDigest &&
    left.resultSetDigest === right.resultSetDigest &&
    left.currentRevisionKey === right.currentRevisionKey &&
    left.sourceCurrent === right.sourceCurrent &&
    left.recordedDecision?.id === right.recordedDecision?.id
  );
}

export function decisionEditorUnavailableReason(
  editor: DecisionEditorState,
  current: ReviewRunDecisionContext | undefined,
  access: DecisionAccess,
) {
  if (editor.conflict) return "Review and explicitly use the latest state after this rejection.";
  if (editor.request) return decisionRetryUnavailableReason(editor, access);
  if (!current) return "Refresh decision state before continuing.";
  if (!decisionBindingMatches(editor.reviewed, current)) {
    return "The reviewed binding changed. Review and explicitly use the latest state.";
  }
  return decisionUnavailableReason(editor.action, current, access);
}

export function prepareDecisionSubmission(
  editor: DecisionEditorState,
  createId: () => string = () => crypto.randomUUID(),
): DecisionEditorState {
  if (editor.conflict)
    throw new Error("Review the latest state before preparing another decision.");
  if (editor.request) return editor;
  const reason = editor.reason.trim();
  if (
    !reason ||
    editor.reason.length > 2_048 ||
    Array.from(editor.reason).some(
      (character) =>
        /\p{Cs}/u.test(character) ||
        (/\p{Cc}/u.test(character) && !["\n", "\r", "\t"].includes(character)),
    )
  ) {
    throw new Error("Enter a reason of up to 2,048 characters using valid text.");
  }
  const common = {
    changeId: createId(),
    action: editor.action,
    expectedVersion: editor.reviewed.version,
    expectedRevisionKey: editor.reviewed.revisionKey,
    expectedPlanDigest: editor.reviewed.planDigest,
    expectedResultSetDigest: editor.reviewed.resultSetDigest,
    reason,
  };
  const target = editor.reviewed.recordedDecision;
  if (editor.action === "withdraw" && (!target || target.action === "withdraw")) {
    throw new Error("There is no decision to withdraw in the reviewed state.");
  }
  const request: ReviewRunDecisionChangeRequest =
    editor.action === "withdraw" && target
      ? { ...common, action: "withdraw", targetDecisionId: target.id }
      : { ...common, action: editor.action as Exclude<DecisionAction, "withdraw"> };
  return { ...editor, request };
}

export function receiveDecisionFailure(editor: DecisionEditorState, failure: unknown) {
  return {
    ...editor,
    conflict:
      editor.conflict || (failure instanceof ReviewControlHttpError && failure.status === 409),
  };
}

export function reviewDecisionCandidate(
  editor: DecisionEditorState,
  candidate: ReviewRunDecisionContext,
): DecisionEditorState {
  if (
    candidate.repositoryId !== editor.reviewed.repositoryId ||
    candidate.reviewRunId !== editor.reviewed.reviewRunId ||
    candidate.workItemId !== editor.reviewed.workItemId ||
    candidate.revisionKey !== editor.reviewed.revisionKey ||
    candidate.planDigest !== editor.reviewed.planDigest
  ) {
    throw new Error("The refreshed state belongs to a different run.");
  }
  return { ...editor, candidate: structuredClone(candidate) };
}

export function acceptReviewedDecisionState(editor: DecisionEditorState): DecisionEditorState {
  if (!editor.candidate) throw new Error("Load and review the latest state first.");
  return {
    ...editor,
    reviewed: editor.candidate,
    candidate: null,
    request: null,
    conflict: false,
  };
}

export function decisionReceiptSummary(event: ReviewRunDecisionEvent) {
  return `${decisionActionLabel(event.action, event.workItemKind)} recorded at version ${event.version}. This is an accepted historical receipt; the refreshed state below determines the current decision.`;
}
