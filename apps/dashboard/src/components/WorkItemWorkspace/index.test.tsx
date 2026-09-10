import type { ButtonProps, DrawerProps, IconButtonProps, ListItemButtonProps } from "@mui/material";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItem } from "@/services/review-control";
import { WorkItemDetails, WorkItemListRow } from "./index";

type AccessState = "reviewer" | "viewer" | "denied" | "unknown" | "error";

const state = vi.hoisted(() => ({
  permissions: new Map<string, AccessState>(),
  checking: false,
  gates: [] as string[],
  scopes: [] as string[],
  queries: [] as { queryKey: unknown[]; enabled?: boolean }[],
  latestRun: null as { id: string } | null,
  buttons: [] as { children?: ReactNode; disabled?: boolean; onClick?: () => void }[],
  icons: [] as { label?: string; disabled?: boolean; onClick?: () => void }[],
  rows: [] as { disabled?: boolean; onClick?: () => void }[],
}));

vi.mock("@mui/material", async (importOriginal) => {
  const material = await importOriginal<typeof import("@mui/material")>();
  return {
    ...material,
    Button: (props: ButtonProps) => {
      state.buttons.push({
        children: props.children,
        disabled: props.disabled,
        onClick: props.onClick as (() => void) | undefined,
      });
      return <material.Button {...props} />;
    },
    IconButton: (props: IconButtonProps) => {
      state.icons.push({
        label: props["aria-label"],
        disabled: props.disabled,
        onClick: props.onClick as (() => void) | undefined,
      });
      return <material.IconButton {...props} />;
    },
    ListItemButton: (props: ListItemButtonProps) => {
      state.rows.push({
        disabled: props.disabled,
        onClick: props.onClick as (() => void) | undefined,
      });
      return <material.ListItemButton {...props} />;
    },
    // Make the protected drawer body observable in SSR without changing its access gate.
    Drawer: ({ open, children }: DrawerProps) => (open ? <section>{children}</section> : null),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => {
    state.queries.push({ queryKey, enabled });
    return {
      data: state.latestRun,
      isError: false,
      isPending: false,
      isSuccess: true,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/components/OperatorAccess", () => ({
  OperatorAccessGate: ({
    repositoryId,
    children,
  }: {
    repositoryId: string;
    children: ReactNode;
  }) => {
    state.gates.push(repositoryId);
    const permission = state.permissions.get(repositoryId);
    return permission === "viewer" || permission === "reviewer" ? (
      children
    ) : (
      <aside>Repository read unavailable</aside>
    );
  },
  useOperatorAccess: (repositoryId: string) => {
    state.scopes.push(repositoryId);
    return {
      ready: ["viewer", "reviewer"].includes(state.permissions.get(repositoryId) ?? ""),
      checking: state.checking,
      identityKey: ["sample", "test-issuer", "test-operator"],
      can: (permission: string) =>
        !state.checking &&
        (permission === "review"
          ? state.permissions.get(repositoryId) === "reviewer"
          : ["reviewer", "viewer"].includes(state.permissions.get(repositoryId) ?? "")),
    };
  },
}));

vi.mock("@/components/CreateReviewRun", () => ({ CreateReviewRunModal: () => null }));
vi.mock("@/components/JobDetails", () => ({
  JobDetailsPanel: ({ jobId }: { jobId: string }) => <span>Job result {jobId}</span>,
}));
vi.mock("@/components/ReviewRuns", () => ({
  ReviewRunsDrawer: () => null,
  ReviewRunsPanel: ({ initialRunId }: { initialRunId: string }) => (
    <span>Run result {initialRunId}</span>
  ),
}));
vi.mock("@/components/ReviewRuns/common", () => ({ ErrorNotice: () => null }));
vi.mock("@/components/RepositoryScope", () => ({
  RepositoryScopeUnavailable: () => null,
  useRepositoryScope: vi.fn(),
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/services/review-control", () => ({ reviewControl: {} }));
vi.mock("@/services/runs", () => ({ runs: {} }));
vi.mock("@/components/ui", () => ({
  EmptyState: () => null,
  DetailsGrid: ({ items }: { items: { label: string; value: ReactNode }[] }) => (
    <dl>
      {items.map((entry) => (
        <div key={entry.label}>
          <dt>{entry.label}</dt>
          <dd>{entry.value}</dd>
        </div>
      ))}
    </dl>
  ),
}));

const item: WorkItem = {
  id: "work-item-501",
  repositoryId: "repository-selected",
  revisionKey: "a".repeat(64),
  activeRequestEpoch: null,
  kind: "pull_request",
  repository: "owner/repository",
  number: 501,
  title: "Restore the selected window after a monitor change",
  author: "contributor",
  githubUrl: "https://github.com/owner/repository/pull/501",
  trigger: "review_requested",
  scheduledBy: "maintainer",
  authorization: "allowlisted",
  priority: "normal",
  state: "open",
  stage: "reviewing",
  latestJobId: "job-501",
  latestJobStatus: "running",
  latestJobAttemptCount: 2,
  latestJobAdmission: null,
  headSha: "b".repeat(40),
  reviewedSha: "c".repeat(40),
  workerNodeId: "worker-windows-02",
  freshness: "current",
  updatedAt: "2026-09-10T03:00:00.000Z",
};

const detailActions = () => ({ onClose: vi.fn(), onViewRuns: vi.fn(), onRunValidation: vi.fn() });

beforeEach(() => {
  state.permissions.clear();
  state.permissions.set(item.repositoryId, "viewer");
  state.checking = false;
  state.gates = [];
  state.scopes = [];
  state.queries = [];
  state.latestRun = null;
  state.buttons = [];
  state.icons = [];
  state.rows = [];
});

describe("selected work item details", () => {
  it("retains the selected item's source, request, and execution context in the detail surface", () => {
    const html = renderToStaticMarkup(<WorkItemDetails item={item} {...detailActions()} />);
    expect(html).toContain(item.title);
    expect(html).toContain(item.repository);
    expect(html).toContain(item.author);
    expect(html).toContain("Request context");
    expect(html).toContain("Review requested");
    expect(html).toContain(item.scheduledBy);
    expect(html).toContain("Authorized maintainer");
    expect(html).toContain(item.headSha?.slice(0, 7));
    expect(html).toContain(item.reviewedSha?.slice(0, 7));
    expect(html).toContain(item.workerNodeId);
    expect(html).toContain("<dt>Job attempts</dt><dd>2</dd>");
    expect(html).toContain(`href="${item.githubUrl}"`);
    expect(state.gates).toEqual([item.repositoryId]);
    expect(state.scopes).toEqual([item.repositoryId]);
    expect(state.queries).toEqual([
      {
        queryKey: [
          "review-runs",
          item.repositoryId,
          item.id,
          "latest",
          "sample",
          "test-issuer",
          "test-operator",
        ],
        enabled: true,
      },
    ]);
  });

  it("keeps results and history available to viewers while disabling validation", () => {
    const callbacks = detailActions();
    const html = renderToStaticMarkup(<WorkItemDetails item={item} {...callbacks} />);
    state.buttons.find((button) => button.children === "View runs")?.onClick?.();
    const validation = state.buttons.find((button) => button.children === "Run validation");
    expect(validation?.disabled).toBe(true);
    validation?.onClick?.();
    expect(callbacks.onViewRuns).toHaveBeenCalledExactlyOnceWith(item);
    expect(callbacks.onRunValidation).not.toHaveBeenCalled();
    expect(html).toContain("Job result job-501");
    expect(html).toContain("Read-only access.");
  });

  it("validates the exact selected item and rechecks review access at activation", () => {
    state.permissions.set(item.repositoryId, "reviewer");
    const callbacks = detailActions();
    renderToStaticMarkup(<WorkItemDetails item={item} {...callbacks} />);
    const validation = state.buttons.find((button) => button.children === "Run validation");
    expect(validation?.disabled).toBe(false);
    validation?.onClick?.();
    expect(callbacks.onRunValidation).toHaveBeenCalledExactlyOnceWith(item);
    callbacks.onRunValidation.mockClear();
    state.permissions.set(item.repositoryId, "viewer");
    validation?.onClick?.();
    expect(callbacks.onRunValidation).not.toHaveBeenCalled();
  });

  it.each(["denied", "unknown", "error"] as const)(
    "withholds cached item content and queries when its own repository read is %s",
    (permission) => {
      state.permissions.set(item.repositoryId, permission);
      state.permissions.set("another-repository", "reviewer");
      const html = renderToStaticMarkup(<WorkItemDetails item={item} {...detailActions()} />);
      expect(html).toContain("Repository read unavailable");
      expect(html).not.toContain(item.title);
      expect(html).not.toContain(item.repository);
      expect(state.scopes).toEqual([]);
      expect(state.buttons).toEqual([]);
      expect(state.queries).toEqual([]);
    },
  );

  it("withholds cached context and actions and disables queries while permissions are checked", () => {
    state.checking = true;
    state.latestRun = { id: "cached-run" };
    const html = renderToStaticMarkup(<WorkItemDetails item={item} {...detailActions()} />);
    expect(html).toContain("Verifying repository access");
    expect(html).not.toContain(item.title);
    expect(html).not.toContain("Run result cached-run");
    expect(state.buttons).toEqual([]);
    expect(state.queries.every((query) => query.enabled === false)).toBe(true);
  });

  it("does not infer an overall validation result from one completed latest job", () => {
    const html = renderToStaticMarkup(
      <WorkItemDetails
        item={{ ...item, latestJobStatus: "succeeded", stage: "done" }}
        {...detailActions()}
      />,
    );
    expect(html).toContain("Latest job completed");
    expect(html).toContain("Open results to inspect all validation tracks");
    expect(html).toContain("Job result job-501");
    expect(html).not.toContain("All validations passed");
  });

  it("retains earlier-revision context and its warning", () => {
    const html = renderToStaticMarkup(
      <WorkItemDetails
        item={{ ...item, freshness: "superseded", latestJobStatus: "succeeded" }}
        {...detailActions()}
      />,
    );
    expect(html).toContain("New revision");
    expect(html).toContain("Previous result available");
    expect(html).toContain("targets an earlier revision");
    expect(html).toContain("Reviewed revision");
  });
});

describe("Material work item list row", () => {
  it("opens the exact item from the whole row and trailing action without an automatic selection", () => {
    const onOpenDetails = vi.fn();
    const html = renderToStaticMarkup(
      <WorkItemListRow item={item} onOpenDetails={onOpenDetails} onViewRuns={vi.fn()} />,
    );
    expect(html).toContain("<li");
    expect(html).toContain(item.title);
    expect(html).toContain(item.repository);
    expect(html).toContain(item.author);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain(">Details<");
    state.rows[0]?.onClick?.();
    state.icons.find((icon) => icon.label === "Open pull request 501")?.onClick?.();
    expect(onOpenDetails).toHaveBeenCalledTimes(2);
    expect(onOpenDetails).toHaveBeenNthCalledWith(1, item);
    expect(onOpenDetails).toHaveBeenNthCalledWith(2, item);
  });

  it("keeps history separate from opening details", () => {
    const onOpenDetails = vi.fn();
    const onViewRuns = vi.fn();
    renderToStaticMarkup(
      <WorkItemListRow item={item} onOpenDetails={onOpenDetails} onViewRuns={onViewRuns} />,
    );
    state.icons.find((icon) => icon.label === "View runs for pull request 501")?.onClick?.();
    expect(onViewRuns).toHaveBeenCalledExactlyOnceWith(item);
    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it("keeps row, history, and open actions inactive while the list is busy", () => {
    const onOpenDetails = vi.fn();
    const onViewRuns = vi.fn();
    renderToStaticMarkup(
      <WorkItemListRow
        item={item}
        disabled
        onOpenDetails={onOpenDetails}
        onViewRuns={onViewRuns}
      />,
    );
    expect(state.rows[0]?.disabled).toBe(true);
    expect(state.icons.every((icon) => icon.disabled)).toBe(true);
    state.rows[0]?.onClick?.();
    for (const icon of state.icons) icon.onClick?.();
    expect(onOpenDetails).not.toHaveBeenCalled();
    expect(onViewRuns).not.toHaveBeenCalled();
  });
});
