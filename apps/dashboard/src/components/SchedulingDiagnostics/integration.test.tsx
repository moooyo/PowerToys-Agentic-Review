import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jobs } from "../../services/review-control/mock/fixtures";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import { JobDetailsPanel } from "../JobDetails";
import { RunDetails } from "../ReviewRuns/RunDetails";

const state = vi.hoisted(() => ({
  scopes: [] as { scope: unknown; visible?: boolean }[],
  job: undefined as unknown,
  rerun: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/components/SchedulingDiagnostics", () => ({
  SchedulingDiagnostics: (props: { scope: unknown; visible?: boolean }) => {
    state.scopes.push(props);
    return <span>Exact scoped scheduling</span>;
  },
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: () => ({
    ready: true,
    checking: false,
    identityKey: ["connected", "issuer", "operator"],
    allows: (permission: string) => permission === "read",
    can: (permission: string) => permission === "read",
  }),
}));
vi.mock("@umijs/max", () => ({
  useModel: () => ({ initialState: { authenticationEpoch: 1 } }),
}));
vi.mock("@/components/IssueReproduction", () => ({ IssueReproductionSummary: () => null }));
vi.mock("@/components/ReviewRunDecisions", () => ({ ReviewRunDecisions: () => null }));
vi.mock("@/components/StatusTag", () => ({ StatusTag: () => null }));
vi.mock("@/services/runs", () => ({
  runs: { mode: "connected", rerun: state.rerun, cancel: state.cancel, listJobs: vi.fn() },
}));
vi.mock("@/services/review-control", () => ({ reviewControl: { getJob: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "job-details" ? state.job : { items: [], total: 0 },
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
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
    Space: Content,
    Tag: Content,
    Tooltip: Content,
    Divider: () => <hr />,
    Empty: Object.assign(Content, { PRESENTED_IMAGE_SIMPLE: "simple" }),
    Skeleton: Content,
    Descriptions: ({
      items,
    }: {
      items: { key: string; label: ReactNode; children: ReactNode }[];
    }) => (
      <dl>
        {items.map((item) => (
          <div key={item.key}>
            <dt>{item.label}</dt>
            <dd>{item.children}</dd>
          </div>
        ))}
      </dl>
    ),
    Table: ({ columns }: { columns: { title: ReactNode }[] }) => (
      <div>
        {columns.map((column) => (
          <span key={String(column.title)}>{column.title}</span>
        ))}
      </div>
    ),
    Collapse: () => null,
    Modal: () => null,
    Tabs: ({ items }: { items: { children: ReactNode }[] }) => <div>{items[0]?.children}</div>,
    Grid: { useBreakpoint: () => ({}) },
    Drawer: Content,
    Typography: { Title: Content, Text: Content, Paragraph: Content },
  };
});
beforeEach(() => {
  state.scopes = [];
  state.rerun.mockReset();
  state.cancel.mockReset();
  state.job = {
    ...jobs[0],
    updatedAt: "2026-09-07T08:00:00.000Z",
    failureCode: null,
    failureMessage: null,
    resultDigest: null,
    reviewResult: null,
  };
});
describe("scheduling entry-point wiring", () => {
  it.each([true, false])("forwards the exact run/request and visible=%s", (visible) => {
    const run = sampleReviewRuns[0];
    const request = run?.requests[0];
    if (!run || !request) throw new Error("A sample run request is required.");
    const html = renderToStaticMarkup(
      <RunDetails
        run={run}
        selectedRequestId={request.requestId}
        onSelectRequest={vi.fn()}
        onSelectJob={vi.fn()}
        visible={visible}
      />,
    );
    expect(state.scopes).toEqual([
      {
        scope: {
          kind: "validation_request",
          repositoryId: run.repositoryId,
          workItemId: run.workItemId,
          reviewRunId: run.id,
          requestId: request.requestId,
        },
        visible,
      },
    ]);
    expect(html).toContain("<dt>Execution prerequisites</dt>");
    expect(html).toContain("<span>Execution prerequisites</span>");
    expect(state.rerun).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it("uses the known repository/work-item ownership for existing job details", () => {
    const job = jobs[0];
    if (!job) throw new Error("A sample job is required.");
    renderToStaticMarkup(<JobDetailsPanel repositoryId={job.repositoryId} jobId={job.id} />);
    expect(state.scopes).toEqual([
      {
        scope: {
          kind: "repository_job",
          repositoryId: job.repositoryId,
          workItemId: job.workItemId,
          jobId: job.id,
        },
      },
    ]);
  });
});
