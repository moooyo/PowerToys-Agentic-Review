import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SystemPage from "@/pages/System";
import { runtimeList } from "@/services/model-runtime-registrations/fixtures.testing";
import { ModelRuntimeRegistrations } from "./index";

interface QueryOptions {
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
  enabled?: boolean;
  gcTime?: number;
}
const state = vi.hoisted(() => ({
  mode: "connected",
  allowed: true,
  ready: true,
  checking: false,
  pending: false,
  authenticated: true,
  accessError: null as Error | null,
  epoch: 1,
  actor: { issuer: "https://identity.example.test", subject: "administrator" },
  value: undefined as unknown,
  error: null as Error | null,
  queries: [] as QueryOptions[],
  effects: [] as (() => (() => void) | undefined)[],
  list: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
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
  OperatorAccessGate: ({ children }: { children: ReactNode }) =>
    state.accessError ? <aside>Access unavailable</aside> : children,
  useOperatorAccess: () => ({
    ready: state.ready && !state.pending,
    authenticated: state.authenticated,
    error: state.accessError,
    pending: state.pending,
    checking: state.checking,
    platformAdministrator: state.allowed,
    principal: state.authenticated ? state.actor : null,
    identityKey: [state.mode, state.actor.issuer, state.actor.subject],
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/SchedulingPolicy", () => ({
  PlatformSchedulingPolicy: () => <div>Scheduling policy</div>,
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => <h1>System</h1> }));
vi.mock("@/components/StatusTag", () => ({ StatusTag: () => <span /> }));
vi.mock("@/services/review-control", () => ({ reviewControl: { getSystemSnapshot: vi.fn() } }));
vi.mock("@/services/model-runtime-registrations", () => ({
  createHttpModelRuntimeRegistrationAdapter: () => ({ mode: "connected", list: state.list }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    state.queries.push(options);
    if (options.queryKey[0] === "system-snapshot")
      return { isError: true, error: new Error("System health is unavailable"), refetch: vi.fn() };
    return {
      data: state.value,
      isError: state.error !== null,
      error: state.error,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({
    cancelQueries: state.cancel,
    removeQueries: state.remove,
    invalidateQueries: vi.fn(),
  }),
}));
vi.mock("@ant-design/icons", () => ({
  ReloadOutlined: () => <span />,
  PlusOutlined: () => <span />,
}));
vi.mock("antd", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: ({
      title,
      description,
      action,
    }: {
      title?: ReactNode;
      description?: ReactNode;
      action?: ReactNode;
    }) => (
      <aside>
        {title}
        {description}
        {action}
      </aside>
    ),
    Button: Content,
    Col: Content,
    Row: Content,
    Space: Content,
    Switch: Content,
    Tag: Content,
    Pagination: Content,
    Select: Content,
    Card: ({
      title,
      children,
      extra,
    }: {
      title?: ReactNode;
      children?: ReactNode;
      extra?: ReactNode;
    }) => (
      <section>
        {title}
        {extra}
        {children}
      </section>
    ),
    Drawer: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <section>{children}</section> : null,
    Skeleton: () => <span>Loading registry</span>,
    Descriptions: Content,
    Collapse: Content,
    Table: ({ dataSource, columns }: { dataSource: unknown[]; columns: { title: string }[] }) => (
      <div>
        {columns.map((column) => (
          <span key={column.title}>{column.title}</span>
        ))}
        {JSON.stringify(dataSource)}
      </div>
    ),
    Typography: { Title: Content, Text: Content, Paragraph: Content },
    Form: Object.assign(Content, { Item: Content }),
    Input: Object.assign(Content, { TextArea: Content }),
  };
});
beforeEach(() => {
  state.mode = "connected";
  state.allowed = true;
  state.ready = true;
  state.checking = false;
  state.pending = false;
  state.authenticated = true;
  state.accessError = null;
  state.epoch = 1;
  state.actor = { issuer: "https://identity.example.test", subject: "administrator" };
  state.value = runtimeList();
  state.error = null;
  state.queries = [];
  state.effects = [];
  vi.clearAllMocks();
});
const render = () => renderToStaticMarkup(<ModelRuntimeRegistrations />);
describe("model runtime registry administrator boundary", () => {
  it("remains reachable in System when its independent health snapshot fails", () => {
    const markup = renderToStaticMarkup(<SystemPage />);
    expect(markup).toContain("System data is unavailable");
    expect(markup).toContain("Register expected runtime");
    expect(markup).toContain("Expected runtime");
    expect(state.queries.map((query) => query.queryKey[0])).toEqual([
      "system-snapshot",
      "model-runtime-registrations",
    ]);
  });
  it("shows registration expectations independently of any system snapshot", () => {
    const markup = render();
    expect(markup).toContain("Expected runtime");
    expect(markup).toContain("Allow new evaluation selections");
    expect(markup).toContain("does not verify a runtime, prove its availability, or start a model");
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]).toMatchObject({ enabled: true, gcTime: 0 });
  });
  it("requires a connected control plane without fake reads or writes in sample mode", () => {
    state.mode = "sample";
    expect(render()).toContain("Connect to manage model runtime registrations");
    expect(state.queries).toHaveLength(0);
    expect(state.list).not.toHaveBeenCalled();
  });
  it.each(["revoked", "signed-out", "pending"])(
    "does not read or retain displayed identities when %s",
    (kind) => {
      if (kind === "revoked") state.allowed = false;
      if (kind === "signed-out") {
        state.ready = false;
        state.authenticated = false;
      }
      if (kind === "pending") state.pending = true;
      const markup = render();
      expect(markup).not.toContain("Expected runtime");
      expect(markup).not.toContain("Register expected runtime");
      expect(state.queries).toHaveLength(kind === "pending" ? 1 : 0);
      if (kind === "pending") expect(state.queries[0]?.enabled).toBe(false);
    },
  );
  it("disables reads and hides cached identities during permission revalidation", () => {
    state.checking = true;
    const markup = render();
    expect(markup).toContain("Verifying current administrator access");
    expect(markup).not.toContain("Expected runtime");
    expect(state.queries[0]?.enabled).toBe(false);
  });
  it("does not show stale successful data after a failed read", () => {
    state.error = new Error("Read failed");
    const markup = render();
    expect(markup).toContain("Registrations could not be loaded");
    expect(markup).not.toContain("Expected runtime");
  });
  it("uses abortable reads scoped to the current principal and authentication epoch", async () => {
    render();
    const first = state.queries[0];
    if (!first) throw new Error("A list query was expected.");
    const controller = new AbortController();
    state.list.mockResolvedValueOnce(runtimeList());
    await first.queryFn({ signal: controller.signal });
    expect(state.list).toHaveBeenCalledExactlyOnceWith(
      { page: 1, pageSize: 20 },
      controller.signal,
    );
    state.actor = { ...state.actor, subject: "other" };
    render();
    state.epoch += 1;
    render();
    expect(new Set(state.queries.map((query) => JSON.stringify(query.queryKey))).size).toBe(3);
  });
  it("cancels and removes only the departed session cache on sign-out or revocation", () => {
    render();
    const session = state.queries[0]?.queryKey[1];
    for (const effect of state.effects) effect()?.();
    expect(state.cancel).toHaveBeenCalledWith({
      queryKey: ["model-runtime-registrations", session],
    });
    expect(state.remove).toHaveBeenCalledWith({
      queryKey: ["model-runtime-registrations", session],
    });
    state.allowed = false;
    state.queries = [];
    expect(render()).toContain("Platform administrator access required");
    expect(state.queries).toHaveLength(0);
  });
  it("keeps its session host across unknown access failures while rendering no registry data", () => {
    render();
    const first = state.queries[0]?.queryKey[1];
    state.ready = false;
    state.allowed = false;
    state.accessError = new Error("Temporary access request failure");
    const hidden = renderToStaticMarkup(<SystemPage />);
    expect(hidden).toContain("Access unavailable");
    expect(hidden).toContain("Any unconfirmed change is retained for this signed-in session");
    expect(hidden).not.toContain("Expected runtime");
    expect(hidden).not.toContain("Register expected runtime");
    expect(state.queries[1]).toMatchObject({ enabled: false });
    expect(state.queries[1]?.queryKey[1]).toBe(first);
    state.ready = true;
    state.allowed = true;
    state.accessError = null;
    render();
    expect(state.queries[2]?.queryKey[1]).toBe(first);
  });
});
