import type { RepositorySchedulingStatus } from "@agentic-review/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformSchedulingPolicy, RepositorySchedulingPolicy } from "./index";

interface QueryOptions {
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
  enabled?: boolean;
  refetchInterval?: number;
  gcTime?: number;
}
const state = vi.hoisted(() => ({
  readable: true,
  administrator: false,
  checking: false,
  epoch: 1,
  principal: { issuer: "https://identity.example", subject: "reader" },
  value: undefined as unknown,
  error: null as Error | null,
  queries: [] as QueryOptions[],
  effects: [] as (() => (() => void) | undefined)[],
  repository: vi.fn(),
  cancelQueries: vi.fn(),
  removeQueries: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => (() => void) | undefined) => {
    state.effects.push(effect);
  },
}));
vi.mock("@umijs/max", () => ({
  useModel: () => ({ initialState: { authenticationEpoch: state.epoch } }),
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: (repositoryId?: string) => ({
    ready: state.readable,
    error: null,
    pending: false,
    checking: state.checking,
    platformAdministrator: state.administrator,
    identityKey: ["connected", state.principal.issuer, state.principal.subject],
    context: {
      platformAdministrator: state.administrator,
      repository: repositoryId ? { repositoryId, role: "viewer" } : undefined,
    },
    allows: () => state.readable,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/services/scheduling-policy", () => ({
  schedulingPolicy: { mode: "connected", repository: state.repository },
  schedulingPolicyQueryRoot: ["scheduling-policy"],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    state.queries.push(options);
    return {
      data: options.queryKey.includes("activity")
        ? { items: [], total: 0, page: 1, pageSize: 20 }
        : state.value,
      isError: state.error !== null,
      error: state.error,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({
    cancelQueries: state.cancelQueries,
    removeQueries: state.removeQueries,
    invalidateQueries: vi.fn(),
  }),
}));
vi.mock("@ant-design/icons", () => ({ ReloadOutlined: () => <span /> }));
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
    Col: Content,
    Divider: Content,
    Drawer: Content,
    Row: Content,
    Space: Content,
    Tag: Content,
    Pagination: Content,
    Card: ({ title, children }: { title: ReactNode; children?: ReactNode }) => (
      <section>
        {title}
        {children}
      </section>
    ),
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
    Skeleton: () => <span>Loading scheduling</span>,
    Statistic: ({ title, value }: { title: ReactNode; value: number }) => (
      <div>
        {title}: {value}
      </div>
    ),
    Table: () => <div>Scheduling event list</div>,
    Typography: { Title: Content, Text: Content, Paragraph: Content },
    Form: Object.assign(Content, { useForm: () => [{ setFieldsValue: vi.fn() }] }),
  };
});

const repository: RepositorySchedulingStatus = {
  repositoryId: "repo-one",
  observedAt: "2026-09-07T10:00:00.000Z",
  repositoryVersion: 3,
  enabled: true,
  limits: { maxActiveLeases: 2, maxQueuedJobs: 3 },
  usage: {
    activeLeases: 3,
    admittedQueuedJobs: 3,
    awaitingAdmissionJobs: 17,
    awaitingConfigurationRequests: 5,
  },
  overage: { activeLeases: 1, admittedQueuedJobs: 0 },
  platform: {
    visibility: "restricted",
    version: 1,
    activeCapacity: "limited",
    queueCapacity: "available",
  },
};
const renderRepository = (id = "repo-one") =>
  renderToStaticMarkup(<RepositorySchedulingPolicy repositoryId={id} />);
beforeEach(() => {
  state.readable = true;
  state.administrator = false;
  state.checking = false;
  state.epoch = 1;
  state.principal = { issuer: "https://identity.example", subject: "reader" };
  state.value = structuredClone(repository);
  state.error = null;
  state.queries = [];
  state.effects = [];
  vi.clearAllMocks();
});

describe("scheduling policy scope and observations", () => {
  it("shows exact repository counters, overage and restricted global capacity", () => {
    const markup = renderRepository();
    expect(markup).toContain("Active leases: 3");
    expect(markup).toContain("Admitted queued jobs: 3");
    expect(markup).toContain("Awaiting admission: 17");
    expect(markup).toContain("Awaiting valid configuration: 5");
    expect(markup).toContain("Usage exceeds a configured limit");
    expect(markup).toContain("Global capacity details are restricted");
    expect(markup).toContain("Restricted details do not mean unlimited capacity");
    expect(state.queries[0]).toMatchObject({ enabled: true, refetchInterval: 5000, gcTime: 0 });
  });
  it("does not render previously loaded counts on a failed refresh", () => {
    state.error = new Error("Access was revoked");
    const markup = renderRepository();
    expect(markup).toContain("Could not load current scheduling");
    expect(markup).not.toContain("Awaiting admission: 17");
  });
  it("pauses observations while access is being rechecked", () => {
    state.checking = true;
    expect(renderRepository()).toContain("Loading scheduling");
    expect(state.queries[0]?.enabled).toBe(false);
  });
  it("denies global usage and audit reads to repository-only users", () => {
    expect(renderToStaticMarkup(<PlatformSchedulingPolicy />)).toContain(
      "Platform administrator access is required",
    );
    expect(state.queries).toHaveLength(0);
  });
  it("changes query keys across repository, principal and authentication epoch", () => {
    renderRepository();
    renderRepository("repo-two");
    state.principal = { ...state.principal, subject: "another-reader" };
    renderRepository();
    state.epoch = 2;
    renderRepository();
    expect(new Set(state.queries.map((query) => JSON.stringify(query.queryKey))).size).toBe(4);
  });
  it("cancels and removes only the departed scheduling session", () => {
    renderRepository();
    const session = state.queries[0]?.queryKey[1];
    for (const effect of state.effects) effect()?.();
    expect(state.cancelQueries).toHaveBeenCalledWith({ queryKey: ["scheduling-policy", session] });
    expect(state.removeQueries).toHaveBeenCalledWith({ queryKey: ["scheduling-policy", session] });
    state.readable = false;
    state.queries = [];
    expect(renderRepository()).toContain("Scheduling information is unavailable");
    expect(state.queries).toHaveLength(0);
  });
  it("rejects global details returned beyond a repository reader's authority", async () => {
    renderRepository();
    state.repository.mockResolvedValue({ ...repository, platform: { visibility: "full" } });
    const query = state.queries[0];
    if (!query) throw new Error("Expected a scheduling query.");
    await expect(query.queryFn({ signal: new AbortController().signal })).rejects.toThrow(
      "exceeded the current operator's scope",
    );
  });
  it("shows global and unscoped usage only to a platform administrator", () => {
    state.administrator = true;
    state.value = {
      observedAt: repository.observedAt,
      configuration: {
        version: 1,
        limits: { maxActiveLeases: 4, maxQueuedJobs: 9 },
        policyId: "repository-service-v1",
        updatedAt: repository.observedAt,
      },
      usage: repository.usage,
      overage: { activeLeases: 0, admittedQueuedJobs: 0 },
      unscopedUsage: {
        activeLeases: 1,
        admittedQueuedJobs: 1,
        awaitingAdmissionJobs: 0,
        awaitingConfigurationRequests: 0,
      },
    };
    const markup = renderToStaticMarkup(<PlatformSchedulingPolicy />);
    expect(markup).toContain("Unscoped usage");
    expect(markup).toContain("Scheduling configuration activity");
    expect(markup).toContain("2:1 service ratio");
    expect(state.queries).toHaveLength(2);
  });
});
