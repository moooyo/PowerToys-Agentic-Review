import type { OperatorAccessContext } from "@agentic-review/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { JobDetails } from "@/services/review-control";
import { ReviewControlHttpError } from "@/services/review-control/errors";

export const jobDetailsQueryRoot = ["job-details"] as const;

export function clearJobDetailsQuery(client: QueryClient, session: string, jobId: string): void {
  const queryKey = [...jobDetailsQueryRoot, session, jobId];
  void client.cancelQueries({ queryKey, exact: true });
  client.removeQueries({ queryKey, exact: true });
}

export function jobReadSessionKey(
  repositoryId: string,
  identityKey: readonly (string | null)[],
  authenticationEpoch: number,
  context?: OperatorAccessContext,
): string {
  return JSON.stringify([
    repositoryId,
    identityKey,
    authenticationEpoch,
    context?.platformAdministrator,
    context?.repository,
  ]);
}

export function jobAccessDenied(error: unknown): boolean {
  return error instanceof ReviewControlHttpError && [401, 403, 404].includes(error.status);
}

export function visibleJobDetails(
  job: JobDetails | null | undefined,
  repositoryId: string,
  jobId: string,
  failed: boolean,
): JobDetails | null {
  return !failed && job?.repositoryId === repositoryId && job.id === jobId ? job : null;
}
