import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDetails } from "@/services/review-control";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import { JobDetailsPanel } from "./index";

const state = vi.hoisted(() => ({
  ready: true,
  checking: false,
  readable: true,
  epoch: 1,
  error: null as unknown,
  job: null as unknown,
  options: [] as {
    queryKey: unknown[];
    queryFn: (input: { signal: AbortSignal }) => Promise<unknown>;
  }[],
  getJob: vi.fn(),
}));
vi.mock("@umijs/max", () => ({
  useModel: () => ({ initialState: { authenticationEpoch: state.epoch } }),
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: () => ({
    ready: state.ready,
    checking: state.checking,
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
      isPending: false,
      isError: state.error !== null,
      error: state.error,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("antd", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: ({ title, description }: { title?: ReactNode; description?: ReactNode }) => (
      <aside>
        {title}
        {description}
      </aside>
    ),
    Button: Content,
    Collapse: Content,
    Descriptions: Content,
    Drawer: Content,
    Grid: { useBreakpoint: () => ({}) },
    Skeleton: () => <span>Checking access</span>,
    Table: Content,
    Tabs: () => null,
    Tag: Content,
    Typography: { Text: Content, Paragraph: Content, Title: Content },
  };
});

beforeEach(() => {
  state.ready = true;
  state.checking = false;
  state.readable = true;
  state.epoch = 1;
  state.error = null;
  state.options = [];
  state.job = {
    id: "job-a",
    repositoryId: "repository-a",
    workItemId: "item-a",
    workItemRef: "owner/private-repository#7",
    title: "Private validation result",
    status: "succeeded",
    admission: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  } as JobDetails;
  vi.clearAllMocks();
});

describe("scoped job details", () => {
  const render = () =>
    renderToStaticMarkup(<JobDetailsPanel repositoryId="repository-a" jobId="job-a" />);

  it.each(["checking", "unverified", "revoked"])(
    "does not mount protected queries while access is %s",
    (mode) => {
      state.checking = mode === "checking";
      state.ready = mode !== "unverified";
      state.readable = mode !== "revoked";
      expect(render()).not.toContain("owner/private-repository#7");
      expect(state.options).toHaveLength(0);
    },
  );

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
});
