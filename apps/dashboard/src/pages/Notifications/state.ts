import type {
  NotificationEvent,
  NotificationItem,
  NotificationState,
  NotificationStateChangeRequest,
  NotificationSummary,
} from "@agentic-review/contracts";
import { notificationTargetPath } from "@/components/NotificationTarget/targets";

export function notificationLabel(event: NotificationEvent): string {
  if (event.kind === "publication")
    return {
      published: "Publication published",
      failed: "Publication failed",
      blocked: "Publication blocked",
      unknown: "Delivery uncertain",
    }[event.outcome];
  return {
    succeeded: "Validation completed",
    failed: "Execution failed",
    dead_letter: "Execution exhausted retries",
    cancelled: "Execution cancelled",
    stale: "Execution superseded",
  }[event.jobStatus];
}
export function notificationDescription(event: NotificationEvent): string {
  if (event.kind === "publication")
    return event.outcome === "unknown"
      ? "Inspect the outbox and reconcile using GET requests before taking further action. Delivery may already have occurred."
      : `${event.attemptKind === "reconciliation" ? "Reconciliation" : "Delivery"} attempt ${event.attemptNumber}${event.failureCode ? ` · ${event.failureCode}` : ""}.`;
  if (event.result === null)
    return "No completed validation result was recorded for this execution. Inspect the run for details.";
  const result = event.result,
    checks = result.checks;
  return `${checks.total} checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.blocked} blocked, ${checks.not_run} not run, ${checks.skipped} skipped, ${checks.inconclusive} inconclusive. ${result.requiredNonPassed} required checks did not pass. ${result.lifecycleBlockers} lifecycle blockers. Evidence ${result.evidenceComplete ? "complete" : "incomplete"}. Source ${result.sourceState}; cleanup ${result.cleanupState}.`;
}
export function notificationHref(event: NotificationEvent): string {
  return event.kind === "publication"
    ? notificationTargetPath({
        kind: "publication",
        repositoryId: event.repositoryId,
        publicationId: event.publicationId,
      })
    : notificationTargetPath({
        kind: "validation",
        repositoryId: event.repositoryId,
        workItemId: event.workItemId,
        workItemKind: event.workItemKind,
        reviewRunId: event.reviewRunId,
        requestId: event.requestId,
        jobId: event.jobId,
      });
}
export function notificationUnreadLabel(summary: NotificationSummary): string {
  return `${summary.unreadCount}${summary.capped ? "+" : ""} unread`;
}
export function createNotificationStateChange(
  items: readonly NotificationItem[],
  selected: readonly string[],
  state: NotificationState,
  changeId: string,
): NotificationStateChangeRequest {
  if (selected.length === 0 || selected.length > 50 || new Set(selected).size !== selected.length)
    throw new Error("Select between 1 and 50 visible notifications.");
  const byId = new Map(items.map((item) => [item.event.id, item]));
  return {
    changeId,
    changes: selected.map((notificationId) => {
      const item = byId.get(notificationId);
      if (!item)
        throw new Error("The selection changed. Select notifications from the current page.");
      return { notificationId, expectedVersion: item.state.version, state };
    }),
  };
}
