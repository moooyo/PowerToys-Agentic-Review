import type { RepositoryConfigurationSnapshot } from "@agentic-review/contracts";
import { schedulingLimitsLabel } from "../SchedulingPolicy/form";

export function repositorySnapshotSchedulingLabels(snapshot: RepositoryConfigurationSnapshot) {
  if (!("schedulingLimits" in snapshot))
    return { active: "Not recorded in this snapshot", queue: "Not recorded in this snapshot" };
  return {
    active: schedulingLimitsLabel(snapshot.schedulingLimits.maxActiveLeases),
    queue: schedulingLimitsLabel(snapshot.schedulingLimits.maxQueuedJobs),
  };
}
