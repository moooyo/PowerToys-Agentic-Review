import type {
  PublicationBlocker,
  PublicationConfirmRequest,
  PublicationControlAction,
  PublicationDetail,
  PublicationPreview,
} from "@agentic-review/contracts";
import {
  getPublicationConfirmRequestIssues,
  getPublicationControlRequestIssues,
} from "@agentic-review/contracts";

export const publicationBlockerLabels: Record<PublicationBlocker, string> = {
  publication_disabled: "Publication is disabled for this repository.",
  publisher_unavailable: "The separate GitHub publisher credential is unavailable.",
  confirmation_not_permitted: "Maintainer access or higher is required to confirm publication.",
  decision_not_publishable: "This decision cannot be published.",
  decision_withdrawn: "This decision was withdrawn.",
  decision_superseded: "A newer decision superseded this decision.",
  decision_stale: "This decision no longer matches the current source or results.",
  source_not_current: "The reviewed source is no longer current.",
  result_set_changed: "The reviewed result set changed. Review a new preview.",
  evidence_unavailable: "Required evidence is unavailable.",
  evidence_verification_failed: "Required evidence could not be verified.",
  unsupported_target: "This target is unsupported. Check runs are not available.",
  payload_oversized: "The complete outgoing body exceeds the supported size.",
  rendering_failed: "The complete publication body could not be rendered.",
  existing_publication: "This decision already has a publication. Inspect its outbox entry.",
};
export const publicationDeliveryLimitations =
  "GitHub creation endpoints have no general idempotency key or revision compare-and-swap. A PR review is bound to the displayed commit; a latest-head check cannot be atomic with sending. Issue comments have no revision compare-and-swap. An uncertain result is never automatically resent.";
export function publicationFingerprint(value: PublicationPreview): string {
  return JSON.stringify([
    value.publicationId,
    value.rendererVersion,
    value.binding,
    value.policyVersion,
    value.publisherAvailability,
    value.publisherGitHubUserId,
    value.payloadSha256,
    value.target,
    value.payload,
    value.canConfirm,
    value.blockers,
  ]);
}
export function confirmationFromPreview(
  value: PublicationPreview,
  changeId: string,
): PublicationConfirmRequest {
  if (
    !value.canConfirm ||
    value.payload === null ||
    value.payloadSha256 === null ||
    value.publisherGitHubUserId === null ||
    value.policyVersion < 1
  )
    throw new Error("Review a confirmable publication preview first.");
  const binding = value.binding;
  const request: PublicationConfirmRequest = {
    changeId,
    publicationId: value.publicationId,
    rendererVersion: value.rendererVersion,
    expectedSelectedDecisionId: binding.selectedDecisionId,
    expectedSelectedDecisionVersion: binding.selectedDecisionVersion,
    expectedDecisionContextVersion: binding.decisionContextVersion,
    expectedPolicyVersion: value.policyVersion,
    expectedPublisherGitHubUserId: value.publisherGitHubUserId,
    expectedRevisionKey: binding.revisionKey,
    expectedPlanDigest: binding.planDigest,
    expectedResultSetDigest: binding.resultSetDigest,
    expectedPayloadSha256: value.payloadSha256,
  };
  if (getPublicationConfirmRequestIssues(request, value).length > 0)
    throw new Error("The confirmation does not match the reviewed publication.");
  return request;
}
export function publicationActions(detail: PublicationDetail): PublicationControlAction[] {
  return detail.delivery.status === "unknown"
    ? ["reconcile"]
    : detail.delivery.status === "pending"
      ? ["cancel"]
      : ["failed", "blocked"].includes(detail.delivery.status)
        ? ["retry", "cancel"]
        : [];
}
export function publicationControl(
  detail: PublicationDetail,
  action: PublicationControlAction,
  changeId: string,
) {
  const request = {
    changeId,
    expectedVersion: detail.delivery.version,
    expectedPayloadSha256: detail.intent.payloadSha256,
  };
  if (getPublicationControlRequestIssues(request, detail, action).length > 0)
    throw new Error("This action is unavailable for the current publication state.");
  return request;
}
export const publicationOutboxPath = (repositoryId: string, publicationId?: string) =>
  `/publications?${new URLSearchParams({ repositoryId, ...(publicationId ? { publicationId } : {}) })}`;
