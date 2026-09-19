// These descriptions follow source-import.ts, webhook-intake.ts, and e2e-intake.ts.
// A reason does not establish Task existence, retry scheduling, or attempt exhaustion.
const descriptions: Readonly<Record<string, string>> = {
  source_read_failed: "The complete source could not be read from GitHub.",
  source_import_unavailable: "GitHub read access is not configured for source import.",
  invalid_source_response: "GitHub returned source data that could not be validated.",
  invalid_source_pagination: "The source pages could not be read completely.",
  source_budget_exceeded: "The complete source exceeds the configured import limits.",
  source_changed_during_import: "The source changed while it was being imported.",
  source_assignment_target_changed: "The current source no longer matches the assigned work item.",
  source_assignment_stale: "The assigned work item is no longer open.",
  source_assignment_missing: "The configured reviewer is no longer assigned to this work item.",
  source_assignment_revision_changed:
    "The pull request revision changed after the assignment event.",
  source_account_mismatch:
    "GitHub read access uses a different account than the configured identity.",
  source_repository_mismatch: "The GitHub repository no longer matches its registered identity.",
  source_target_mismatch: "The imported work item does not match the requested source.",
  source_kind_mismatch: "The imported source has a different work item type.",
  work_item_identity_conflict: "More than one saved work item matches this source.",
  webhook_preparation_failed: "Event preparation could not complete.",
  webhook_authorization_revoked: "Repository intake settings no longer authorize this assignment.",
  webhook_task_missing: "The task recorded for this event is unavailable.",
  webhook_task_conflict: "The saved task request no longer matches this event.",
  webhook_claim_lost: "This event's handling session is no longer current.",
  webhook_queue_full: "The event queue has reached its configured capacity.",
  webhook_attempts_exhausted: "Event handling could not continue under its configured limits.",
  duplicate_assignment: "The canonical event already represents this assignment.",
  active_assignment_cycle: "The canonical event already represents this active assignment.",
  duplicate_comment: "The canonical event already represents this command comment.",
  unsupported_event: "This event type is not handled by the configured intake.",
  unsupported_action: "This event action is not handled by the configured intake.",
  repository_not_configured: "Assignment intake is not enabled for this repository.",
  assignment_not_authorized: "The assignment does not match the permitted reviewer and requester.",
  work_item_not_open: "The source work item was not open when the event was received.",
  e2e_preparation_failed: "E2E request preparation could not complete.",
  e2e_authorization_revoked: "Repository settings no longer authorize this E2E request.",
  e2e_attempts_exhausted: "E2E request handling could not continue under its configured limits.",
  e2e_not_enabled: "E2E intake is not enabled for this repository.",
  automation_comment: "This automation comment is excluded from E2E intake.",
  not_e2e_command: "The comment does not contain a recognized E2E request.",
  e2e_repository_mismatch: "The pull request does not match the configured repository.",
  e2e_revision_changed: "The pull request revision changed after this E2E request was accepted.",
  e2e_already_active: "An E2E task is already active for this pull request.",
  active_e2e_revision: "An active E2E task already covers this pull request revision.",
  revision_observed: "The current pull request revision was recorded.",
  pull_request_revision_changed: "The pull request revision changed.",
};

export const unknownWebhookReasonDescription =
  "Additional handling details are available in diagnostics.";

export function webhookReasonDescription(reason: string | null): string | null {
  if (reason === null) return null;
  return Object.hasOwn(descriptions, reason)
    ? descriptions[reason]!
    : unknownWebhookReasonDescription;
}
