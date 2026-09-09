import type { OperatorAccessContext } from "@agentic-review/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { JobDetails } from "@/services/review-control";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import {
  clearJobDetailsQuery,
  jobAccessDenied,
  jobDetailsQueryRoot,
  jobReadSessionKey,
  visibleJobDetails,
} from "./state";

const job = { id: "job-a", repositoryId: "repository-a", title: "Protected job" } as JobDetails;

describe("job detail authorization and cache scope", () => {
  it("partitions cached jobs by repository, principal, authentication epoch, and permissions", () => {
    const base = jobReadSessionKey("repository-a", ["connected", "issuer", "operator-a"], 1);
    for (const changed of [
      jobReadSessionKey("repository-b", ["connected", "issuer", "operator-a"], 1),
      jobReadSessionKey("repository-a", ["connected", "issuer", "operator-b"], 1),
      jobReadSessionKey("repository-a", ["connected", "issuer", "operator-a"], 2),
      jobReadSessionKey("repository-a", ["connected", "issuer", "operator-a"], 1, {
        platformAdministrator: true,
        repository: null,
      } as OperatorAccessContext),
    ])
      expect(changed).not.toBe(base);
  });

  it("never displays cached data after a failed refresh or an identity mismatch", () => {
    expect(visibleJobDetails(job, "repository-a", "job-a", false)).toBe(job);
    expect(visibleJobDetails(job, "repository-a", "job-a", true)).toBeNull();
    expect(visibleJobDetails(job, "repository-b", "job-a", false)).toBeNull();
    expect(visibleJobDetails(job, "repository-a", "job-b", false)).toBeNull();
    expect(visibleJobDetails(null, "repository-a", "job-a", false)).toBeNull();
  });

  it.each([401, 403, 404])("treats HTTP %s as a protected-data cache invalidation", (status) => {
    expect(
      jobAccessDenied(
        new ReviewControlHttpError("Unavailable", {
          operation: "getJob",
          retryable: false,
          status,
        }),
      ),
    ).toBe(true);
  });

  it("cancels pending reads and prevents a late response from restoring an invalidated job", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = [...jobDetailsQueryRoot, "session-a", "job-a"];
    const otherKey = [...jobDetailsQueryRoot, "session-b", "job-b"];
    client.setQueryData(queryKey, job);
    client.setQueryData(otherKey, { id: "job-b" });
    let resolveRead: (value: JobDetails) => void = () => {};
    let requestSignal: AbortSignal | undefined;
    const pending = client.fetchQuery({
      queryKey,
      queryFn: ({ signal }) => {
        requestSignal = signal;
        return new Promise<JobDetails>((resolve) => {
          resolveRead = resolve;
        });
      },
    });
    const settled = pending.catch(() => undefined);
    clearJobDetailsQuery(client, "session-a", "job-a");
    expect(requestSignal?.aborted).toBe(true);
    resolveRead(job);
    await settled;
    expect(client.getQueryData(queryKey)).toBeUndefined();
    expect(client.getQueryData(otherKey)).toEqual({ id: "job-b" });
    client.clear();
  });
});
