import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedJobDetails } from "../../pages/Jobs";
import type { WorkItem } from "../../services/review-control";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import { NotificationRunTarget, WorkItemDetails } from "../WorkItemWorkspace";
import { ReviewRunsDrawer, ReviewRunsPanel } from "./index";

type ReadState = "viewer" | "denied" | "unknown" | "error";

const state = vi.hoisted(() => ({
  access: new Map<string | undefined, ReadState>(),
  gates: [] as { repositoryId?: string; permission: string }[],
  queryKeys: [] as unknown[][],
  accessHookScopes: [] as (string | undefined)[],
  jobMounts: [] as string[],
  cachedRun: {} as Record<string, unknown>,
  detailError: null as Error | null,
  targetError: null as Error | null,
  jobError: null as Error | null,
  resultError: null as Error | null,
  historicalJob: {} as Record<string, unknown>,
  result: null as Record<string, unknown> | null,
  queries: [] as { queryKey: unknown[]; enabled?: boolean }[],
  checking: false,
  refreshAccess: vi.fn(async (_repositoryId?: string) => {}),
  buttons: [] as { children: unknown; disabled?: boolean; onClick?: () => void }[],
}));

vi.mock("@/components/OperatorAccess", () => ({
  OperatorAccessGate: ({
    repositoryId,
    permission = "read",
    children,
  }: {
    repositoryId?: string;
    permission?: string;
    children: ReactNode;
  }) => {
    state.gates.push({ repositoryId, permission });
    const access = state.access.get(repositoryId);
    return access === "viewer" && permission === "read" ? (
      children
    ) : (
      <aside>{access === "unknown" ? "Loading permissions" : "Repository read unavailable"}</aside>
    );
  },
  useOperatorAccess: (repositoryId?: string) => {
    state.accessHookScopes.push(repositoryId);
    return {
      ready: state.access.get(repositoryId) === "viewer",
      checking: state.checking,
      identityKey: ["connected", "test-issuer", "test-operator"],
      allows: (permission: string) =>
        state.access.get(repositoryId) === "viewer" && permission === "read",
      can: (permission: string) =>
        !state.checking && state.access.get(repositoryId) === "viewer" && permission === "read",
      refresh: () => state.refreshAccess(repositoryId),
    };
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => {
    state.queryKeys.push(queryKey);
    state.queries.push({ queryKey, enabled });
    const error =
      queryKey[0] === "notification-run-target"
        ? state.targetError
        : queryKey.includes("notification-job")
          ? state.jobError
          : queryKey.includes("result")
            ? state.resultError
            : queryKey.includes("detail")
              ? state.detailError
              : null;
    return {
      data: queryKey.includes("history")
        ? { items: [], total: 0 }
        : queryKey[0] === "notification-run-target"
          ? state.cachedRun
          : queryKey.includes("notification-job")
            ? { requestId: "cached-request", job: state.historicalJob }
            : queryKey.includes("result")
              ? state.result
              : { ...state.cachedRun, repositoryId: queryKey[1], workItemId: queryKey[2] },
      isPending: false,
      isFetching: false,
      isError: error !== null,
      error,
      isSuccess: true,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/components/JobDetails", () => ({
  JobDetailDrawer: ({ jobId }: { jobId: string }) => {
    state.jobMounts.push(jobId);
    return <span>Cached job result {jobId}</span>;
  },
  JobDetailsPanel: ({ jobId }: { jobId: string }) => {
    state.jobMounts.push(jobId);
    return <span>Cached job result {jobId}</span>;
  },
}));
vi.mock("./RunDetails", () => ({
  RunDetails: ({ run }: { run: { id: string } }) => <span>Cached validation report {run.id}</span>,
  TestedSource: () => null,
}));
vi.mock("./ReportView", () => ({ ReportView: () => <span>Cached full job report</span> }));
vi.mock("./EvidenceView", () => ({ EvidenceView: () => null }));
vi.mock("@/components/ReviewRuns", async () => import("./index"));
vi.mock("@/components/ReviewRuns/actions", async () => import("./actions"));
vi.mock("@/components/ReviewRuns/common", async () => import("./common"));
vi.mock("@/components/ReviewRuns/latest", () => ({
  completedLatestJobProgress: {},
  loadLatestWorkItemRun: vi.fn(),
}));
vi.mock("@/components/CreateReviewRun", () => ({ CreateReviewRunModal: () => null }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/StatusTag", () => ({ StatusTag: () => null }));
vi.mock("@/components/RepositoryScope", () => ({
  RepositoryScopeUnavailable: () => null,
  useRepositoryScope: () => ({ ready: true, repositoryId: undefined, key: "all" }),
}));
vi.mock("@/services/review-control", () => ({ reviewControl: {} }));
vi.mock("@/services/runs", () => ({ runs: { mode: "connected" } }));
vi.mock("@/utils/format", () => ({
  shortSha: (value: string) => value,
  formatDuration: vi.fn(),
}));
vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  type ContentProps = { children?: ReactNode };
  return {
    ...actual,
    Button: ({
      children,
      disabled,
      onClick,
    }: ContentProps & { disabled?: boolean; onClick?: () => void }) => {
      state.buttons.push({ children, disabled, onClick });
      return (
        <button type="button" disabled={disabled} onClick={onClick}>
          {children}
        </button>
      );
    },
    // Portals do not render in SSR. Keep the protected drawer body observable for these tests.
    Drawer: ({ children, open }: ContentProps & { open?: boolean }) =>
      open ? <section>{children}</section> : null,
  };
});
const workItem: WorkItem = {
  id: "cached-work-item",
  repositoryId: "repository-selected-item",
  revisionKey: "a".repeat(64),
  activeRequestEpoch: null,
  kind: "pull_request",
  repository: "owner/cached-repository",
  number: 42,
  title: "Cached pull request title",
  author: "contributor",
  githubUrl: "https://github.com/owner/cached-repository/pull/42",
  trigger: "review_requested",
  scheduledBy: "maintainer",
  authorization: "allowlisted",
  priority: "normal",
  state: "open",
  stage: "not_scheduled",
  latestJobAttemptCount: null,
  latestJobAdmission: null,
  freshness: "current",
  updatedAt: "2026-09-07T00:00:00.000Z",
};

const views = [
  {
    name: "selected work item details",
    content: "Cached validation report",
    query: "latest",
    render: (item: WorkItem) => (
      <WorkItemDetails
        item={item}
        onClose={vi.fn()}
        onViewRuns={vi.fn()}
        onRunValidation={vi.fn()}
      />
    ),
  },
  {
    name: "review run details",
    content: "Cached validation report",
    query: "detail",
    render: (item: WorkItem) => <ReviewRunsPanel workItem={item} initialRunId="cached-run" />,
  },
  {
    name: "review run drawer",
    content: "Cached validation report",
    query: "detail",
    render: (item: WorkItem) => (
      <ReviewRunsDrawer
        workItem={item}
        initialRunId="cached-run"
        onClose={vi.fn()}
        onCreateRun={vi.fn()}
      />
    ),
  },
  {
    name: "selected job drawer",
    content: "Cached job result",
    query: null,
    render: (item: WorkItem) => (
      <SelectedJobDetails
        job={{ id: "cached-job", repositoryId: item.repositoryId }}
        onClose={vi.fn()}
      />
    ),
  },
  {
    name: "notification run target",
    content: "Cached validation report",
    query: "detail",
    render: (item: WorkItem) => (
      <NotificationRunTarget
        target={{
          kind: "validation",
          repositoryId: item.repositoryId,
          workItemId: item.id,
          workItemKind: item.kind,
          reviewRunId: "cached-run",
        }}
        onClose={vi.fn()}
      />
    ),
  },
  {
    name: "historical failed notification job",
    content: "Historical build failure",
    query: "notification-job",
    render: (item: WorkItem) => (
      <ReviewRunsDrawer
        workItem={item}
        initialRunId="cached-run"
        initialRequestId="cached-request"
        initialJobId="historical-job"
        onClose={vi.fn()}
      />
    ),
  },
] as const;

function clearObservations() {
  state.gates = [];
  state.queryKeys = [];
  state.queries = [];
  state.accessHookScopes = [];
  state.jobMounts = [];
  state.buttons = [];
}

function expectNoProtectedMounts() {
  expect(state.queryKeys).toEqual([]);
  expect(state.accessHookScopes).toEqual([]);
  expect(state.jobMounts).toEqual([]);
}

beforeEach(() => {
  state.access.clear();
  state.detailError = null;
  state.targetError = null;
  state.jobError = null;
  state.resultError = null;
  state.result = null;
  const sample = structuredClone(sampleReviewRuns[0]);
  if (!sample) throw new Error("A sample run is required.");
  const request = sample.requests.find((item) => item.latestJob !== null);
  if (!request?.latestJob) throw new Error("A sample job is required.");
  state.historicalJob = {
    ...request.latestJob,
    jobId: "historical-job",
    activationNumber: 1,
    status: "failed",
    resultId: null,
    resultDigest: null,
    failureCode: "BUILD_FAILED",
    failureMessage: "Historical build failure",
  };
  state.cachedRun = {
    ...sample,
    id: "cached-run",
    repositoryId: workItem.repositoryId,
    repository: workItem.repository,
    workItemId: workItem.id,
    title: workItem.title,
    number: workItem.number,
    requests: [
      {
        ...request,
        requestId: "cached-request",
        latestJob: { ...request.latestJob, jobId: "newest-job", activationNumber: 9 },
      },
    ],
  };
  state.checking = false;
  clearObservations();
  vi.clearAllMocks();
});

describe.each(views)("$name read permissions", (view) => {
  it.each(["denied", "unknown", "error"] as const)(
    "does not mount protected queries when repository read is %s",
    (read) => {
      state.access.set(workItem.repositoryId, read);
      const html = renderToStaticMarkup(view.render(workItem));
      expect(html).not.toContain(workItem.title);
      expect(html).not.toContain(view.content);
      expectNoProtectedMounts();
      expect(state.gates).toEqual([{ repositoryId: workItem.repositoryId, permission: "read" }]);
    },
  );

  it("lets a viewer mount the selected repository's results", () => {
    state.access.set(workItem.repositoryId, "viewer");
    expect(renderToStaticMarkup(view.render(workItem))).toContain(view.content);
    expect(state.gates.length).toBeGreaterThan(0);
    expect(
      state.gates.every(
        (gate) => gate.repositoryId === workItem.repositoryId && gate.permission === "read",
      ),
    ).toBe(true);
    if (view.query) {
      expect(
        state.queryKeys.some(
          (key) =>
            key[0] === "review-runs" &&
            key[1] === workItem.repositoryId &&
            key[2] === workItem.id &&
            key.includes(view.query),
        ),
      ).toBe(true);
    } else {
      expect(state.jobMounts).toEqual(["cached-job"]);
    }
  });

  it("withholds cached selection and queries after read access is revoked", () => {
    const cachedSelection = view.render(workItem);
    state.access.set(workItem.repositoryId, "viewer");
    expect(renderToStaticMarkup(cachedSelection)).toContain(view.content);

    state.access.set(workItem.repositoryId, "denied");
    clearObservations();
    const html = renderToStaticMarkup(cachedSelection);
    expect(html).not.toContain(workItem.title);
    expect(html).not.toContain(view.content);
    expectNoProtectedMounts();
  });

  it("uses the cached item's repository instead of global or other repository access", () => {
    state.access.set(undefined, "viewer");
    state.access.set("another-repository", "viewer");
    state.access.set(workItem.repositoryId, "denied");
    expect(renderToStaticMarkup(view.render(workItem))).not.toContain(view.content);
    expect(state.gates).toEqual([{ repositoryId: workItem.repositoryId, permission: "read" }]);
    expectNoProtectedMounts();
  });
});

it("does not mount a gate or query without a selected work item or job", () => {
  renderToStaticMarkup(
    <>
      <WorkItemDetails
        item={null}
        onClose={vi.fn()}
        onViewRuns={vi.fn()}
        onRunValidation={vi.fn()}
      />
      <ReviewRunsDrawer workItem={null} onClose={vi.fn()} />
      <SelectedJobDetails job={null} onClose={vi.fn()} />
    </>,
  );
  expect(state.gates).toEqual([]);
  expectNoProtectedMounts();
});

it("keeps an exact-repository access refresh in the run drawer after a detail read fails", () => {
  state.access.set(workItem.repositoryId, "viewer");
  state.detailError = new Error("The requested run was not found.");
  const drawer = (
    <ReviewRunsDrawer workItem={workItem} initialRunId="cached-run" onClose={vi.fn()} />
  );
  const html = renderToStaticMarkup(drawer);
  expect(html).toContain("Could not load this run");
  expect(html).toContain("Refresh access");
  expect(html).not.toContain("Cached validation report");
  const refresh = state.buttons.find((button) => button.children === "Refresh access");
  expect(refresh?.disabled).toBe(false);
  refresh?.onClick?.();
  expect(state.refreshAccess).toHaveBeenCalledExactlyOnceWith(workItem.repositoryId);
  expect(state.accessHookScopes.every((scope) => scope === workItem.repositoryId)).toBe(true);
  state.access.set(workItem.repositoryId, "denied");
  clearObservations();
  expect(renderToStaticMarkup(drawer)).toContain("Repository read unavailable");
  expectNoProtectedMounts();
});

it("disables duplicate access refreshes while the run drawer permissions are being checked", () => {
  state.access.set(workItem.repositoryId, "viewer");
  state.checking = true;
  renderToStaticMarkup(
    <ReviewRunsDrawer workItem={workItem} initialRunId="cached-run" onClose={vi.fn()} />,
  );
  expect(state.buttons.find((button) => button.children === "Refresh access")?.disabled).toBe(true);
});

it("hides run and historical result payloads while current repository access is being checked", () => {
  state.access.set(workItem.repositoryId, "viewer");
  state.checking = true;
  const html = renderToStaticMarkup(
    <ReviewRunsPanel
      workItem={workItem}
      initialRunId="cached-run"
      initialRequestId="cached-request"
      initialJobId="historical-job"
    />,
  );
  expect(html).not.toContain("Historical build failure");
  expect(html).not.toContain("Cached validation report");
  expect(state.queries.every((query) => query.enabled === false)).toBe(true);
});

it.each(["detailError", "jobError"] as const)(
  "does not retain a cached historical selection after %s",
  (field) => {
    state.access.set(workItem.repositoryId, "viewer");
    state[field] = new Error("Selected scope is no longer available.");
    const html = renderToStaticMarkup(
      <ReviewRunsPanel
        workItem={workItem}
        initialRunId="cached-run"
        initialRequestId="cached-request"
        initialJobId="historical-job"
      />,
    );
    expect(html).toContain("Selected scope is no longer available.");
    expect(html).not.toContain("Historical build failure");
    expect(html).not.toContain("Cached full job report");
  },
);

it("opens an exact historical failed execution directly in the Job result tab", () => {
  state.access.set(workItem.repositoryId, "viewer");
  const html = renderToStaticMarkup(
    <ReviewRunsPanel
      workItem={workItem}
      initialRunId="cached-run"
      initialRequestId="cached-request"
      initialJobId="historical-job"
    />,
  );
  expect(
    state.queryKeys.some((key) => key.includes("result") && key.includes("historical-job")),
  ).toBe(true);
  expect(html).toContain("Historical build failure");
  expect(html).toContain("No saved report for this job");
  expect(html).not.toContain("newest-job");
});

it("does not show a cached report after the exact result read fails", () => {
  state.access.set(workItem.repositoryId, "viewer");
  state.result = { id: "old-report" };
  state.resultError = new Error("The exact result is unavailable.");
  const html = renderToStaticMarkup(
    <ReviewRunsPanel
      workItem={workItem}
      initialRunId="cached-run"
      initialRequestId="cached-request"
      initialJobId="historical-job"
    />,
  );
  expect(html).toContain("The exact result is unavailable.");
  expect(html).not.toContain("Cached full job report");
});

it("does not retain a cached notification run after target verification fails", () => {
  state.access.set(workItem.repositoryId, "viewer");
  state.targetError = new Error("The notification target is unavailable.");
  const html = renderToStaticMarkup(
    <NotificationRunTarget
      target={{
        kind: "validation",
        repositoryId: workItem.repositoryId,
        workItemId: workItem.id,
        workItemKind: workItem.kind,
        reviewRunId: "cached-run",
      }}
      onClose={vi.fn()}
    />,
  );
  expect(html).toContain("The notification target is unavailable.");
  expect(html).not.toContain(workItem.title);
  expect(state.queryKeys.some((key) => key.includes("detail"))).toBe(false);
});
