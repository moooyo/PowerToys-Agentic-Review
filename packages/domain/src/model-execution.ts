import type { JobExecutionEnvelope, JobExecutionTemplate } from "@agentic-review/contracts";

/** Classifies validated input; it does not establish execution authority or OS isolation. */
export function jobRequiresModelExecution(
  job: JobExecutionTemplate | JobExecutionEnvelope,
): boolean {
  if (!("validation" in job)) return true;
  const context = job.validation;
  if (context.schemaVersion === "ValidationJobContextV2")
    return context.modelRequirements?.required !== false;
  switch (context.workflowKind) {
    case "pr_static_build":
    case "issue_triage":
      return true;
    case "pr_ui":
    case "issue_validation":
      // Ordinary summaries are optional. A Worker without models cannot opt into them.
      return false;
    default:
      return true;
  }
}
