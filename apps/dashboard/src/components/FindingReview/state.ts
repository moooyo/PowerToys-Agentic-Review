import type {
  DashboardReviewRunResult,
  FindingDispositionAction,
  FindingDispositionChangeRequest,
  FindingDispositionEvent,
  FindingOccurrence,
  FindingResultContext,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import { ReviewControlHttpError } from "../../services/review-control/errors";

export const findingPublicationNotice =
  "Disposition records stay in this platform. No GitHub comment, review, or issue update is published.";

export function findingQueryKey(
  mode: "connected" | "sample",
  result: DashboardReviewRunResult,
  actor: OperatorPrincipal,
) {
  return [
    "finding-review",
    mode,
    result.repositoryId,
    result.reviewRunId,
    result.requestId,
    result.jobId,
    result.id,
    result.resultDigest,
    actor.issuer,
    actor.subject,
  ] as const;
}

export function findingContextMatchesResult(
  context: FindingResultContext | undefined,
  result: DashboardReviewRunResult,
): context is FindingResultContext {
  return Boolean(
    context &&
      context.repositoryId === result.repositoryId &&
      context.reviewRunId === result.reviewRunId &&
      context.requestId === result.requestId &&
      context.jobId === result.jobId &&
      context.workItemId === result.workItemId &&
      context.workItemKind === result.report.workItemKind &&
      context.resultId === result.id &&
      context.resultDigest === result.resultDigest &&
      context.revisionKey === result.revisionKey &&
      context.planDigest === result.planDigest &&
      context.profileVersionId === result.profileVersionId &&
      context.promptVersionId === result.promptVersionId &&
      context.activationNumber === result.activationNumber,
  );
}

export function findingActionLabel(action: FindingDispositionAction) {
  return {
    accept: "Confirm issue",
    dismiss: "Dismiss finding",
    resolve: "Record as resolved",
    reopen: "Reopen finding",
  }[action];
}

export function findingStateLabel(state: FindingOccurrence["disposition"]["state"]) {
  return {
    open: "Open",
    accepted: "Confirmed · unresolved",
    dismissed: "Dismissed",
    resolved: "Resolved by reviewer",
  }[state];
}

export function findingActionDescription(action: FindingDispositionAction) {
  return {
    accept:
      "Confirm that this finding is valid. A confirmed P0 / P1 finding remains unresolved and blocks policy eligibility.",
    dismiss:
      "Record why this finding should not block policy eligibility. The original model finding remains unchanged.",
    resolve:
      "Record the reviewer's conclusion that this finding has been resolved. This does not change checks or prove that a later run passed.",
    reopen: "Return this finding to open. A P0 / P1 finding will count as unresolved again.",
  }[action];
}

export interface FindingEditor {
  readonly occurrence: FindingOccurrence;
  readonly context: FindingResultContext;
  readonly action: FindingDispositionAction;
  readonly reason: string;
  readonly request: FindingDispositionChangeRequest | null;
  readonly conflict: boolean;
  readonly candidate: { context: FindingResultContext; occurrence: FindingOccurrence } | null;
}

export function createFindingEditor(
  context: FindingResultContext,
  occurrence: FindingOccurrence,
  action: FindingDispositionAction,
): FindingEditor {
  if (occurrence.resultId !== context.resultId || occurrence.resultDigest !== context.resultDigest)
    throw new Error("The finding does not belong to this result.");
  return {
    context: structuredClone(context),
    occurrence: structuredClone(occurrence),
    action,
    reason: "",
    request: null,
    conflict: false,
    candidate: null,
  };
}

export function findingBindingMatches(
  editor: Pick<FindingEditor, "context" | "occurrence">,
  context: FindingResultContext,
  occurrence: FindingOccurrence,
) {
  return (
    editor.context.contextDigest === context.contextDigest &&
    editor.context.resultId === context.resultId &&
    editor.context.resultDigest === context.resultDigest &&
    editor.context.sourceCurrent === context.sourceCurrent &&
    editor.context.latestForRequest === context.latestForRequest &&
    editor.occurrence.key === occurrence.key &&
    editor.occurrence.kind === occurrence.kind &&
    editor.occurrence.ordinal === occurrence.ordinal &&
    editor.occurrence.disposition.version === occurrence.disposition.version &&
    editor.occurrence.disposition.state === occurrence.disposition.state &&
    editor.occurrence.disposition.lastEventId === occurrence.disposition.lastEventId
  );
}

export function prepareFindingSubmission(
  editor: FindingEditor,
  createId: () => string = () => crypto.randomUUID(),
): FindingEditor {
  if (editor.conflict)
    throw new Error("Review and explicitly use the latest state before submitting again.");
  if (editor.request) return editor;
  if (
    !editor.reason.trim() ||
    editor.reason.length > 2_048 ||
    Array.from(editor.reason).some(
      (character) =>
        /\p{Cs}/u.test(character) ||
        (/\p{Cc}/u.test(character) && !["\n", "\r", "\t"].includes(character)),
    )
  )
    throw new Error("Enter a reason of up to 2,048 characters using valid text.");
  return {
    ...editor,
    request: {
      changeId: createId(),
      expectedVersion: editor.occurrence.disposition.version,
      expectedResultDigest: editor.context.resultDigest,
      expectedContextDigest: editor.context.contextDigest,
      kind: editor.occurrence.kind,
      ordinal: editor.occurrence.ordinal,
      action: editor.action,
      reason: editor.reason,
    },
  };
}

export function receiveFindingFailure(editor: FindingEditor, error: unknown): FindingEditor {
  return {
    ...editor,
    conflict: editor.conflict || (error instanceof ReviewControlHttpError && error.status === 409),
  };
}

export function reviewFindingCandidate(
  editor: FindingEditor,
  context: FindingResultContext,
  occurrence: FindingOccurrence,
): FindingEditor {
  if (
    editor.context.repositoryId !== context.repositoryId ||
    editor.context.reviewRunId !== context.reviewRunId ||
    editor.context.requestId !== context.requestId ||
    editor.context.jobId !== context.jobId ||
    editor.context.resultId !== context.resultId ||
    editor.context.resultDigest !== context.resultDigest ||
    editor.occurrence.key !== occurrence.key ||
    editor.occurrence.kind !== occurrence.kind ||
    editor.occurrence.ordinal !== occurrence.ordinal
  )
    throw new Error("The refreshed finding belongs to a different immutable result.");
  return {
    ...editor,
    candidate: { context: structuredClone(context), occurrence: structuredClone(occurrence) },
  };
}

export function acceptReviewedFinding(editor: FindingEditor): FindingEditor {
  if (!editor.candidate) throw new Error("Load and review the latest finding state first.");
  return { ...editor, ...editor.candidate, request: null, conflict: false, candidate: null };
}

export function findingEditorUnavailable(
  editor: FindingEditor,
  context: FindingResultContext | undefined,
  occurrence: FindingOccurrence | undefined,
  canReview: boolean,
) {
  if (!canReview) return "Reviewer access is required to change finding dispositions.";
  if (editor.conflict)
    return "Fresh review is required after the server rejected the original binding.";
  // An uncertain transport outcome must retry the exact original immutable intent.
  if (editor.request) return null;
  if (!context || !occurrence) return "Refresh this finding before recording a disposition.";
  if (!findingBindingMatches(editor, context, occurrence))
    return "The finding or execution context changed. Review and explicitly use the latest state.";
  return null;
}

export function findingAccessDenied(error: unknown) {
  return error instanceof ReviewControlHttpError && [401, 403, 404].includes(error.status);
}

export function findingPollingInterval(input: {
  mode: "connected" | "sample";
  visible: boolean;
  canRead: boolean;
  hasError: boolean;
}) {
  return input.mode === "connected" && input.visible && input.canRead && !input.hasError
    ? 30_000
    : false;
}

export function findingReceiptSummary(event: FindingDispositionEvent) {
  return `${findingActionLabel(event.action)} recorded at version ${event.version}. This receipt records an accepted historical change. Refresh findings to see the current disposition.`;
}
