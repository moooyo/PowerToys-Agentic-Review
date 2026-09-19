import type {
  InvestigationCommentPublicationSummary,
  InvestigationReportRef,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type { AutomaticReplyPolicy } from "./auto-reply-settings.js";
import { defaultE2eAutomaticReplyTemplate } from "./auto-reply-template.js";
import type {
  InvestigationProgressTrigger,
  ProgressReplyContext,
  ProgressReplyStage,
  ProgressReplyTemplates,
} from "./progress-reply-template.js";
import { defaultE2eProgressReplyTemplates } from "./progress-reply-template.js";
import type {
  InvestigationCommentTarget,
  InvestigationGitHubIdentity,
  InvestigationProgressCommentDelivery,
  InvestigationProgressCommentRequest,
  InvestigationRepositoryRecord,
} from "./types.js";

export type PublicationState = InvestigationCommentPublicationSummary["state"];
export interface PublicationPolicySnapshot {
  readonly settingsVersion: number;
  readonly templateVersion: number;
  readonly templates: ProgressReplyTemplates;
  readonly resultTemplate: string;
}
export interface PublicationRevision {
  readonly id: string;
  readonly sequence: number;
  readonly sourceEventId: string;
  readonly stage: ProgressReplyStage;
  readonly context: ProgressReplyContext;
  readonly updatedAt: string;
  readonly failure: string | null;
  readonly reportRef: InvestigationReportRef | null;
  readonly reportDigest: string | null;
  readonly policy: PublicationPolicySnapshot;
  readonly legacy?: boolean;
}
export interface PublicationOperation {
  readonly revision: PublicationRevision;
  readonly request: InvestigationProgressCommentRequest;
  readonly attemptId: string | null;
  readonly dispatched: boolean;
  readonly finished: boolean;
  readonly limitationCode?: "summary_only";
}
export interface PublicationConfirmation {
  readonly revision: PublicationRevision;
  readonly body: string;
  readonly externalId: string;
  readonly attemptId: string | null;
  readonly confirmedAt: string | null;
}
export interface PublicationClaim {
  readonly ownerId: string;
  readonly token: string;
  readonly expiresAt: number;
}
export interface PublicationGrant {
  readonly authorizationEpoch: number;
  readonly authorizedById: string;
}
export interface CommentPublication {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly receiptId: string | null;
  readonly taskId: string | null;
  readonly taskKind: InvestigationTaskV1["kind"] | null;
  readonly taskCreatedAt: string | null;
  readonly repository: InvestigationRepositoryRecord;
  readonly target: InvestigationCommentTarget;
  readonly workItemId: string | null;
  readonly trigger: InvestigationProgressTrigger;
  readonly marker: string;
  readonly receivedAt: string;
  readonly firstStartedAt: string | null;
  readonly desired: PublicationRevision;
  readonly confirmed: PublicationConfirmation | null;
  readonly operation: PublicationOperation | null;
  readonly githubIdentity: InvestigationGitHubIdentity | null;
  readonly grant: PublicationGrant;
  readonly grantHistory: readonly (PublicationGrant & {
    readonly at: string;
    readonly actorId: string;
    readonly source: "enrollment" | "legacy" | "sync";
  })[];
  readonly state: PublicationState;
  readonly reasonCode: string | null;
  readonly requiresAttention: boolean;
  readonly pendingId: string;
  readonly writeAttempts: number;
  readonly readAttempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastAttemptAt: string | null;
  readonly lastAttemptId: string | null;
  readonly nextPhaseAt: number;
  readonly reconcileRequested: boolean;
  readonly claim: PublicationClaim | null;
  readonly historyAvailableSince: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const publicationEqual = (left: unknown, right: unknown): boolean =>
  investigationContentDigest(left) === investigationContentDigest(right);

export function publicationPolicy(
  policy: AutomaticReplyPolicy,
  kind: "issue" | "pull_request",
  mode?: "static" | "e2e",
): PublicationPolicySnapshot {
  return {
    settingsVersion: policy.version,
    templateVersion: policy.templateVersion,
    templates: structuredClone(
      mode === "e2e" ? defaultE2eProgressReplyTemplates : policy.progressTemplates,
    ),
    resultTemplate:
      mode === "e2e"
        ? defaultE2eAutomaticReplyTemplate
        : kind === "pull_request"
          ? policy.pullRequestTemplate
          : policy.issueTemplate,
  };
}

export function publicationStage(
  status: NonNullable<ProgressReplyContext["status"]>,
): ProgressReplyStage {
  if (status === "completed") return "completed";
  if (status === "running") return "started";
  if (["received", "preparing", "queued"].includes(status)) return "received";
  return "failed";
}

/** Never expose worker diagnostics, upstream responses, or exception messages as public copy. */
export function publicationReason(code: string | null): string | null {
  if (code === null) return null;
  if (code.startsWith("conflict_") || code === "comment_missing")
    return "The remote comment was changed, removed, or could not be uniquely verified. A repository operator must review it before repair.";
  if (
    [
      "authorization_changed",
      "authorization_revoked",
      "publisher_disabled",
      "repository_scope_denied",
      "action_permission_denied",
      "publisher_identity_changed",
      "repository_identity_changed",
      "work_item_identity_changed",
      "assignment_not_current",
      "github_conversation_locked",
    ].includes(code)
  )
    return "Comment publication is paused because the required authorization, publisher, or target is no longer valid.";
  if (code === "queue_full")
    return "The comment queue is full. The latest task outcome is retained and can be synchronized when capacity is available.";
  if (code === "retry_exhausted")
    return "Safe automatic retries have been exhausted. A repository operator can request synchronization without rerunning the investigation.";
  if (code === "synchronization_required")
    return "Readback completed. A newer task update is available and requires an explicit synchronization request.";
  if (code === "report_binding_changed")
    return "The sealed report no longer matches this task and conversation. Publication requires operator review.";
  if (code === "content_unavailable")
    return "A safe comment body could not be prepared. The complete task and report remain available in the Dashboard.";
  if (code === "summary_only")
    return "The complete report exceeds the comment size limit. A safe conclusion summary was published; the full report remains in the Dashboard.";
  if (code === "github_rate_limited")
    return "GitHub limited the request rate. The next safe attempt will respect its retry interval.";
  if (
    [
      "mutation_response_unknown",
      "mutation_receipt_unverified",
      "previous_body_observed",
      "comment_not_observed",
      "reconciliation_incomplete",
      "reconciliation_exhausted",
      "dispatched_without_receipt",
    ].includes(code)
  )
    return "The earlier write is unconfirmed. Only read-only reconciliation is allowed; the comment will not be blindly resent.";
  if (code === "superseded")
    return "A newer task update superseded this prepared comment before it was sent.";
  if (code === "publisher_stopped")
    return "The publisher stopped before sending this attempt. Its saved content is retained for safe recovery.";
  if (code === "lease_lost")
    return "This publisher lost its processing lease before sending the comment.";
  if (
    code === "preparation_failed" ||
    code.startsWith("github_") ||
    code.startsWith("invalid_") ||
    code.startsWith("missing_")
  )
    return "Comment preparation or delivery could not complete. Safe retries are bounded and do not change the task outcome.";
  return "Comment delivery needs attention. The task outcome and retained delivery history remain available.";
}

export function stoppedCopy(
  status: NonNullable<ProgressReplyContext["status"]>,
  reasonCode?: string,
  mode?: "static" | "e2e",
): { failure: string | null; nextStep: string } {
  if (mode === "e2e") {
    if (status === "queued")
      return {
        failure: null,
        nextStep:
          "Wait for the exclusive E2E execution slot and an eligible worker. Static review can run in parallel.",
      };
    if (status === "running")
      return {
        failure: null,
        nextStep:
          "The worker will verify the pinned PR revision, capture screenshot or video evidence, and clean up before releasing the E2E slot.",
      };
    if (["received", "preparing"].includes(status))
      return {
        failure: null,
        nextStep: "Prepare the pinned pull request revision for E2E runtime verification.",
      };
    const copy = stoppedCopy(status, reasonCode);
    return {
      failure: copy.failure?.replaceAll("investigation", "E2E verification") ?? null,
      nextStep: copy.nextStep.replaceAll("investigation", "E2E verification"),
    };
  }
  if (reasonCode === "budget_exhausted")
    return {
      failure: "The task stopped because its authorized investigation budget was exhausted.",
      nextStep:
        "A repository operator must review the budget and explicitly resume the task if more investigation is needed.",
    };
  if (status === "blocked")
    return {
      failure:
        "The task is waiting for required information, an environment, or authorization before it can continue.",
      nextStep:
        "A repository operator must review the recorded prerequisites and explicitly resume the task after resolving them.",
    };
  if (status === "interrupted")
    return {
      failure:
        reasonCode === "lease_expired"
          ? "The worker lease expired before the investigation completed."
          : "The investigation was interrupted before completion.",
      nextStep:
        "A repository operator can explicitly resume the task after an eligible worker is available.",
    };
  if (status === "cancelled")
    return {
      failure: "The investigation was cancelled before completion.",
      nextStep: "No automatic continuation is scheduled.",
    };
  if (status === "failed")
    return {
      failure:
        reasonCode === "source_preparation_failed"
          ? "The source could not be prepared for investigation."
          : "The investigation failed before a complete conclusion was available.",
      nextStep: "A repository operator must review the task or assignment details before retrying.",
    };
  if (status === "running")
    return {
      failure: null,
      nextStep:
        "The worker will continue the recorded investigation. This comment will be updated with the outcome.",
    };
  if (status === "queued")
    return { failure: null, nextStep: "Wait for an eligible worker to claim the task." };
  if (status === "completed")
    return {
      failure: null,
      nextStep:
        "Review the conclusion and recommended follow-up. Publication does not authorize a merge or other repository action.",
    };
  return {
    failure: null,
    nextStep: "Capture the input snapshot for this investigation before creating the task.",
  };
}

export function classifyDelivery(
  delivery: InvestigationProgressCommentDelivery,
  dispatched: boolean,
) {
  const effect =
    delivery.effect ??
    (delivery.state === "succeeded"
      ? "applied"
      : delivery.state === "unknown" || dispatched
        ? "unknown"
        : "not_sent");
  return {
    effect,
    state:
      effect === "applied"
        ? ("succeeded" as const)
        : effect === "unknown"
          ? ("unknown" as const)
          : ("failed" as const),
    retryable: delivery.retryable ?? false,
    reasonCode:
      delivery.reasonCode ??
      (effect === "applied"
        ? "comment_reconciled"
        : effect === "unknown"
          ? "mutation_response_unknown"
          : "preparation_failed"),
    externalId: delivery.externalId,
    retryAfterMs: Number.isFinite(delivery.retryAfterMs) ? Math.max(0, delivery.retryAfterMs!) : 0,
  };
}

export function problemState(code: string): PublicationState {
  if (code.startsWith("conflict_") || code === "comment_missing") return "conflict";
  if (
    [
      "authorization_changed",
      "authorization_revoked",
      "publisher_disabled",
      "repository_scope_denied",
      "action_permission_denied",
      "publisher_identity_changed",
      "repository_identity_changed",
      "work_item_identity_changed",
      "assignment_not_current",
      "github_conversation_locked",
      "transport_unavailable",
    ].includes(code)
  )
    return "paused";
  return "needs_attention";
}
