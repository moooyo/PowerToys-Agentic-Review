import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JobsPage from "./index";

const state = vi.hoisted(() => ({
  search: "?repositoryId=repository-a&jobId=job-a",
  navigate: vi.fn(),
  jobs: [] as { repositoryId: string; jobId: string }[],
  close: undefined as (() => void) | undefined,
}));
vi.mock("@umijs/max", () => ({
  useLocation: () => ({ pathname: "/jobs", search: state.search }),
  useNavigate: () => state.navigate,
}));
vi.mock("@/components/RepositoryScope", () => ({
  useRepositoryScope: () => ({
    ready: true,
    key: "repository-a",
    repositoryId: "repository-a",
    label: "owner/repository-a",
  }),
  RepositoryScopeUnavailable: () => null,
}));
vi.mock("@/components/OperatorAccess", () => ({
  OperatorAccessGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/JobDetails", () => ({
  JobDetailDrawer: ({
    repositoryId,
    jobId,
    onClose,
  }: {
    repositoryId: string;
    jobId: string;
    onClose: () => void;
  }) => {
    state.jobs.push({ repositoryId, jobId });
    state.close = onClose;
    return (
      <span>
        Job {repositoryId}/{jobId}
      </span>
    );
  },
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/StatusTag", () => ({ StatusTag: () => null }));
vi.mock("@/services/review-control", () => ({ reviewControl: {} }));
vi.mock("@ant-design/pro-components", () => ({ ProTable: () => null }));
vi.mock("@ant-design/icons", () => ({ FilterOutlined: () => null, ReloadOutlined: () => null }));
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
    Card: Content,
    Empty: Object.assign(Content, { PRESENTED_IMAGE_SIMPLE: "simple" }),
    Input: { Search: Content },
    Popover: Content,
    Radio: { Group: Content },
    Select: Content,
  };
});

beforeEach(() => {
  state.search = "?repositoryId=repository-a&jobId=job-a";
  state.jobs = [];
  state.close = undefined;
  vi.clearAllMocks();
});

describe("job target navigation", () => {
  it("opens the exact repository and job from the current URL", () => {
    expect(renderToStaticMarkup(<JobsPage />)).toContain("repository-a/job-a");
    expect(state.jobs).toEqual([{ repositoryId: "repository-a", jobId: "job-a" }]);
  });

  it("follows another URL and clears selection when browser history returns to the list", () => {
    renderToStaticMarkup(<JobsPage />);
    state.search = "?repositoryId=repository-a&jobId=job-b";
    expect(renderToStaticMarkup(<JobsPage />)).toContain("repository-a/job-b");
    state.close?.();
    expect(state.navigate).toHaveBeenCalledWith({
      pathname: "/jobs",
      search: "?repositoryId=repository-a",
    });
    state.search = "?repositoryId=repository-a";
    state.jobs = [];
    renderToStaticMarkup(<JobsPage />);
    expect(state.jobs).toHaveLength(0);
  });

  it.each([
    "?repositoryId=repository-a&jobId=job-a&jobId=job-b",
    "?repositoryId=repository-a&jobId=job-a&publicationId=publication-a",
    "?jobId=job-a",
  ])("rejects an ambiguous target without mounting a job query: %s", (search) => {
    state.search = search;
    expect(renderToStaticMarkup(<JobsPage />)).toContain("Invalid job target");
    expect(state.jobs).toHaveLength(0);
  });
});
