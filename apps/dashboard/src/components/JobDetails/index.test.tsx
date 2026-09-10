import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDetails } from "@/services/review-control";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import { JobDetailsPanel } from "./index";

const state = vi.hoisted(() => ({
  ready: true,
  pending: false,
  checking: false,
  readable: true,
  epoch: 1,
  accessError: null as unknown,
  error: null as unknown,
  queryPending: false,
  job: null as unknown,
  options: [] as {
    queryKey: unknown[];
    queryFn: (input: { signal: AbortSignal }) => Promise<unknown>;
    retry: boolean;
    gcTime: number;
    staleTime: number;
    refetchInterval: (query: {
      state: { data: JobDetails | null | undefined; status: string };
    }) => number | false;
  }[],
  getJob: vi.fn(),
}));
vi.mock("@/state/session", () => ({
  useOperatorSession: () => ({ initialState: { authenticationEpoch: state.epoch } }),
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: () => ({
    ready: state.ready,
    pending: state.pending,
    checking: state.checking,
    error: state.accessError,
    identityKey: ["connected", "issuer-a", "operator-a"],
    allows: () => state.readable,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/JobAdmission", () => ({ JobAdmission: () => null }));
vi.mock("@/components/SchedulingDiagnostics", () => ({ SchedulingDiagnostics: () => null }));
vi.mock("@/components/StatusTag", () => ({ StatusTag: () => null }));
vi.mock("@/services/review-control", () => ({ reviewControl: { getJob: state.getJob } }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ cancelQueries: vi.fn(), removeQueries: vi.fn() }),
  useQuery: (options: (typeof state.options)[number]) => {
    state.options.push(options);
    return {
      data: state.job,
      isPending: state.queryPending,
      isError: state.error !== null,
      isFetching: false,
      error: state.error,
      refetch: vi.fn(),
    };
  },
}));

beforeEach(() => {
  state.ready = true;
  state.pending = false;
  state.checking = false;
  state.readable = true;
  state.epoch = 1;
  state.accessError = null;
  state.error = null;
  state.queryPending = false;
  state.options = [];
  state.job = {
    id: "job-a",
    repositoryId: "repository-a",
    workItemId: "item-a",
    workItemRef: "owner/private-repository#7",
    title: "Private validation result",
    status: "succeeded",
    admission: null,
    stage: "done",
    attempt: 1,
    maxAttempts: 3,
    generation: 1,
    elapsedSeconds: 42,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    failureCode: null,
    failureMessage: null,
    resultDigest: null,
    reviewResult: null,
  } as JobDetails;
  vi.clearAllMocks();
});

describe("scoped job details", () => {
  const render = () =>
    renderToStaticMarkup(<JobDetailsPanel repositoryId="repository-a" jobId="job-a" />);

  it.each(["pending", "checking", "unverified", "revoked", "error"])(
    "does not mount protected queries while access is %s",
    (mode) => {
      state.pending = mode === "pending";
      state.checking = mode === "checking";
      state.ready = mode !== "unverified";
      state.readable = mode !== "revoked";
      state.accessError = mode === "error" ? new Error("Access check failed") : null;
      expect(render()).not.toContain("owner/private-repository#7");
      expect(state.options).toHaveLength(0);
    },
  );

  it("marks pending job access as busy without mounting a job query", () => {
    state.pending = true;
    const markup = render();
    expect(markup).toContain('aria-label="Checking job access"');
    expect(markup).toContain('aria-busy="true"');
    expect(state.options).toHaveLength(0);
  });

  it.each([401, 403, 404])("withholds a previously retrieved job after HTTP %s", (status) => {
    expect(render()).toContain("owner/private-repository#7");
    state.error = new ReviewControlHttpError("Unavailable", {
      operation: "getJob",
      retryable: false,
      status,
    });
    expect(render()).not.toContain("owner/private-repository#7");
    expect(render()).toContain("Unable to load this job");
  });

  it("withholds stale details after an ordinary refresh failure", () => {
    state.error = new Error("The request timed out");
    const markup = render();
    expect(markup).not.toContain("owner/private-repository#7");
    expect(markup).toContain("The request timed out");
    expect(markup).toContain("Try again");
  });

  it("shows an accessible loading state without revealing cached details", () => {
    state.queryPending = true;
    const markup = render();
    expect(markup).toContain('aria-label="Loading job details"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("owner/private-repository#7");
  });

  it("rechecks the exact repository and forwards the query cancellation signal", async () => {
    render();
    const options = state.options[0];
    if (!options) throw new Error("Expected a scoped job query.");
    expect(JSON.stringify(options.queryKey)).toContain("operator-a");
    state.getJob.mockResolvedValue({ ...(state.job as JobDetails), repositoryId: "repository-b" });
    const signal = new AbortController().signal;
    await expect(options.queryFn({ signal })).rejects.toThrow("selected repository");
    expect(state.getJob).toHaveBeenCalledWith("job-a", signal);
  });

  it("selects a new query scope after authentication is reverified", () => {
    render();
    state.epoch = 2;
    render();
    expect(state.options[0]?.queryKey).not.toEqual(state.options[1]?.queryKey);
  });

  it("rejects a response for a different job", async () => {
    render();
    const options = state.options[0];
    if (!options) throw new Error("Expected a scoped job query.");
    state.getJob.mockResolvedValue({ ...(state.job as JobDetails), id: "job-b" });
    await expect(options.queryFn({ signal: new AbortController().signal })).rejects.toThrow(
      "selected repository and job identity",
    );
  });

  it("preserves polling only for active jobs with a successful query", () => {
    render();
    const options = state.options[0];
    if (!options) throw new Error("Expected a scoped job query.");
    expect(options.retry).toBe(false);
    expect(options.gcTime).toBe(0);
    expect(options.staleTime).toBe(5_000);
    for (const status of [
      "queued",
      "leased",
      "running",
      "retry_waiting",
      "cancel_requested",
    ] as const) {
      const data = { ...(state.job as JobDetails), status };
      expect(options.refetchInterval({ state: { data, status: "success" } })).toBe(5_000);
      expect(options.refetchInterval({ state: { data, status: "error" } })).toBe(false);
    }
    for (const status of ["succeeded", "failed", "cancelled", "stale", "dead_letter"] as const) {
      const data = { ...(state.job as JobDetails), status };
      expect(options.refetchInterval({ state: { data, status: "success" } })).toBe(false);
    }
    expect(options.refetchInterval({ state: { data: null, status: "success" } })).toBe(false);
  });

  it("renders Material tabs and the execution shortcut for a pending result", () => {
    state.job = { ...(state.job as JobDetails), status: "running" };
    const markup = render();
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/role="tab"/g)).toHaveLength(3);
    expect(markup.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Job details sections"');
    expect(markup).toContain('aria-label="Refresh job details"');
    expect(markup).toContain("Review in progress");
    expect(markup).toContain("Refreshes every 5 seconds");
    expect(markup).toContain("View execution");
  });

  it("preserves the review recommendation, finding location, and confidence", () => {
    state.job = {
      ...(state.job as JobDetails),
      reviewResult: {
        reviewResultId: "result-a",
        schemaId: "PrReviewPlanV2",
        resultDigest: "digest-a",
        summary: "A repository scope check is missing.",
        requestedRecipeIds: [],
        createdAt: "2026-09-07T00:00:00.000Z",
        prReview: {
          assessment: "request_changes",
          findings: [
            {
              findingId: "finding-a",
              ordinal: 0,
              priority: 1,
              title: "Retain the selected repository scope",
              body: "Validate the response before showing protected details.",
              path: "src/details.ts",
              line: 12,
              endLine: 18,
              confidence: 0.92,
            },
          ],
        },
        issueTriage: null,
      },
    } satisfies JobDetails;
    const markup = render();
    expect(markup).toContain("Request changes");
    expect(markup).toContain('aria-label="Findings"');
    expect(markup).toContain('aria-label="Priority 1"');
    expect(markup).toContain("src/details.ts:12–18");
    expect(markup).toContain("Retain the selected repository scope");
    expect(markup).toContain("Validate the response before showing protected details.");
    expect(markup).toContain("Model confidence 92%");
  });

  it("keeps embedded details compact while retaining status and refresh controls", () => {
    const markup = renderToStaticMarkup(
      <JobDetailsPanel repositoryId="repository-a" jobId="job-a" embedded />,
    );
    expect(markup).not.toContain("owner/private-repository#7");
    expect(markup).not.toContain("Private validation result");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-label="Refresh job details"');
  });
});
