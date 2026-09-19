import type { InvestigationCommentDelivery } from "@agentic-review/contracts";

// Older publishers stored this exact system-generated cancellation as a failed receipt.
// Keep the compatibility match narrow and read-only; never infer cancellation from not_sent alone.
export const legacySupersededCommentDeliveryReason =
  "A newer task update superseded this prepared comment before it was sent.";

export function commentDeliveryState(
  delivery: Pick<InvestigationCommentDelivery, "state" | "effect" | "reason">,
): InvestigationCommentDelivery["state"] {
  return delivery.state === "failed" &&
    delivery.effect === "not_sent" &&
    delivery.reason === legacySupersededCommentDeliveryReason
    ? "cancelled"
    : delivery.state;
}
