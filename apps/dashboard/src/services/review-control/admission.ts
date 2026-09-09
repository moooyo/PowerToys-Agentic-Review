import type { JobAdmission, JobState } from "@agentic-review/contracts";

export function jobDisplayStatus(status: JobState, admission: JobAdmission | null): string {
  if (status !== "queued" && status !== "retry_waiting") return status;
  if (admission?.state === "pending") return "awaiting_admission";
  return admission?.state === "admitted" ? "queued" : "unknown";
}
