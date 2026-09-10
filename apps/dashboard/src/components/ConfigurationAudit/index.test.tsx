import type { ConfigurationAuditEvent, ConfigurationAuditSummary } from "@agentic-review/contracts";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalPromptActivity, RepositoryConfigurationActivity } from "./index";

interface QueryOptions {
  readonly queryKey: readonly unknown[];
  readonly queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
}
const state = vi.hoisted(() => ({
  canRead: true,
  administrator: false,
  checking: false,
  epoch: 1,
  mode: "connected",
  role: "viewer",
  principal: { issuer: "https://issuer.example", subject: "Viewer" },
  page: 1,
  changePage: null as ((event: unknown, page: number) => void) | null,
  selected: null as unknown,
  list: undefined as unknown,
  detail: undefined as unknown,
  error: null as Error | null,
  fetching: false,
  queries: [] as QueryOptions[],
  scopes: [] as (string | undefined)[],
  listRepository: vi.fn(),
  listGlobal: vi.fn(),
  getRepository: vi.fn(),
  getGlobal: vi.fn(),
  refreshAccess: vi.fn(async (_repositoryId?: string) => {}),
  buttons: [] as { children: unknown; onClick?: () => void }[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [
      initial === null ? state.selected : initial === 1 ? state.page : initial,
      (value: unknown) => {
        if (initial === 1) state.page = value as number;
        else if (initial === null) state.selected = value;
      },
    ],
  };
});
vi.mock("@/state/session", () => ({
  useOperatorSession: () => ({ initialState: { authenticationEpoch: state.epoch } }),
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: (repositoryId?: string) => {
    state.scopes.push(repositoryId);
    return {
      ready: state.canRead,
      checking: state.checking,
      principal: state.principal,
      identityKey: [state.mode, state.principal.issuer, state.principal.subject],
      platformAdministrator: state.administrator,
      context: {
        platformAdministrator: state.administrator,
        repository: repositoryId ? { repositoryId, role: state.role } : undefined,
      },
      can: () => state.canRead && !state.checking,
      refresh: () => state.refreshAccess(repositoryId),
    };
  },
}));
vi.mock("@/services/configuration-audit", () => ({
  configurationAudit: {
    get mode() {
      return state.mode;
    },
    listRepositoryConfigurationAudit: state.listRepository,
    listGlobalConfigurationAudit: state.listGlobal,
    getRepositoryConfigurationAudit: state.getRepository,
    getGlobalConfigurationAudit: state.getGlobal,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    state.queries.push(options);
    return {
      data: options.queryKey.includes("detail") ? state.detail : state.list,
      isError: state.error !== null,
      error: state.error,
      isFetching: state.fetching,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@mui/icons-material/Refresh", () => ({ default: () => <span /> }));
vi.mock("@mui/icons-material/Close", () => ({ default: () => <span /> }));
vi.mock("@mui/material", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: ({ children, action }: { children?: ReactNode; action?: ReactNode }) => (
      <aside>
        {children}
        {action}
      </aside>
    ),
    AlertTitle: Content,
    Box: Content,
    Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
      state.buttons.push({ children, onClick });
      return (
        <button type="button" onClick={onClick}>
          {children}
        </button>
      );
    },
    IconButton: Content,
    Drawer: Content,
    Chip: ({ label }: { label: ReactNode }) => <span>{label}</span>,
    Pagination: ({
      page,
      count,
      onChange,
    }: {
      page: number;
      count: number;
      onChange: (event: unknown, page: number) => void;
    }) => {
      state.changePage = onChange;
      return (
        <div>
          Page {page} of {count}
        </div>
      );
    },
    Skeleton: () => <span>Loading audit</span>,
    Typography: Content,
  };
});
vi.mock("@/components/ui", () => ({
  DetailsGrid: ({ items }: { items: { key?: string; label: ReactNode; value: ReactNode }[] }) => (
    <dl>
      {items.map((entry, index) => (
        <div key={entry.key ?? index}>
          <dt>{entry.label}</dt>
          <dd>{entry.value}</dd>
        </div>
      ))}
    </dl>
  ),
  DataTable: ({
    rows,
    columns,
    getRowId,
    emptyTitle,
  }: {
    rows: ConfigurationAuditSummary[];
    columns: { id: string; render: (row: ConfigurationAuditSummary, index: number) => ReactNode }[];
    getRowId: (row: ConfigurationAuditSummary) => string;
    emptyTitle: string;
  }) =>
    rows.length === 0 ? (
      <span>{emptyTitle}</span>
    ) : (
      <table>
        <tbody>
          {rows.map((row, index) => (
            <tr key={getRowId(row)}>
              {columns.map((column) => (
                <td key={column.id}>{column.render(row, index)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
}));

const summary = {
  id: "event-one",
  source: "prompt",
  action: "draft_saved",
  entityId: "template-one",
  repositoryId: null,
  actor: { issuer: "https://audit-issuer.example", subject: "ExactActor" },
  createdAt: "2026-09-07T02:00:00.000Z",
  version: 3,
} satisfies ConfigurationAuditSummary;
const detail: ConfigurationAuditEvent = { ...summary, snapshot: { version: 3, draftRevision: 2 } };
const repositorySummary: ConfigurationAuditSummary = {
  ...summary,
  action: "prompt_bound",
  repositoryId: "repo-one",
};
const repositoryDetail: ConfigurationAuditEvent = {
  ...repositorySummary,
  snapshot: {
    version: 3,
    workflowKind: "pr_ui",
    promptVersionId: "version-one",
    previousVersionId: "version-zero",
  },
};
const renderRepository = () =>
  renderToStaticMarkup(<RepositoryConfigurationActivity repositoryId="repo-one" />);
const renderGlobal = (templateId?: string) =>
  renderToStaticMarkup(<GlobalPromptActivity templateId={templateId} />);
function lastQuery() {
  const query = state.queries.at(-1);
  if (!query) throw new Error("An audit query was expected.");
  return query;
}
function sessionKey() {
  const boundary = RepositoryConfigurationActivity({ repositoryId: "repo-one" });
  return (boundary.type as (props: unknown) => ReactElement)(boundary.props).key;
}

beforeEach(() => {
  state.canRead = true;
  state.administrator = false;
  state.checking = false;
  state.epoch = 1;
  state.role = "viewer";
  state.mode = "connected";
  state.principal = { issuer: "https://issuer.example", subject: "Viewer" };
  state.page = 1;
  state.changePage = null;
  state.selected = null;
  state.list = {
    repositoryId: "repo-one",
    items: [repositorySummary],
    total: 1,
    page: 1,
    pageSize: 20,
  };
  state.detail = repositoryDetail;
  state.error = null;
  state.fetching = false;
  state.queries = [];
  state.scopes = [];
  state.buttons = [];
  state.refreshAccess.mockReset();
  for (const mock of [state.listRepository, state.listGlobal, state.getRepository, state.getGlobal])
    mock.mockReset();
});

describe("configuration audit access and caching", () => {
  it("lets viewers read only repository events with complete actor identity", async () => {
    const html = renderRepository();
    expect(html).toContain("ExactActor");
    expect(html).toContain("https://audit-issuer.example");
    expect(state.scopes).toEqual(["repo-one"]);
    await lastQuery().queryFn({ signal: new AbortController().signal });
    expect(state.listRepository).toHaveBeenCalledWith("repo-one", { page: 1, pageSize: 20 });
    expect(state.listGlobal).not.toHaveBeenCalled();
    expect(state.getGlobal).not.toHaveBeenCalled();
  });

  it("does not issue a global query for a repository viewer", () => {
    expect(renderGlobal()).toContain("Verify platform administrator access");
    expect(state.queries).toHaveLength(0);
  });

  it.each(["denied", "checking", "fetching", "failed"])(
    "hides previously loaded events while %s",
    (condition) => {
      state.canRead = condition !== "denied";
      state.checking = condition === "checking";
      state.fetching = condition === "fetching";
      state.error = condition === "failed" ? new Error("Audit is unavailable") : null;
      state.selected = repositorySummary;
      const html = renderRepository();
      expect(html).not.toContain("ExactActor");
      expect(html).not.toContain("version-one");
    },
  );

  it("labels fixed sample repository history explicitly", () => {
    state.mode = "sample";
    expect(renderRepository()).toContain("Sample configuration history");
    expect(state.queries).toHaveLength(1);
  });

  it("keys retained selection and cache by authentication epoch and permission context", () => {
    const key = sessionKey();
    state.epoch = 2;
    expect(sessionKey()).not.toBe(key);
    state.epoch = 1;
    state.role = "maintainer";
    expect(sessionKey()).not.toBe(key);
    state.role = "viewer";
    state.principal = { ...state.principal, issuer: "https://another-issuer.example" };
    expect(sessionKey()).not.toBe(key);
  });

  it("sends template filtering and pagination to the global server endpoint", async () => {
    state.administrator = true;
    state.page = 3;
    renderGlobal("template-one");
    await lastQuery().queryFn({ signal: new AbortController().signal });
    expect(state.listGlobal).toHaveBeenCalledWith({
      page: 3,
      pageSize: 20,
      templateId: "template-one",
    });
    expect(state.listRepository).not.toHaveBeenCalled();
  });

  it("requests the selected server page and clears the previous event selection", async () => {
    state.selected = repositorySummary;
    state.list = { items: [repositorySummary], total: 41, page: 1, pageSize: 20 };
    renderRepository();
    expect(state.changePage).not.toBeNull();
    state.changePage?.(null, 2);
    expect(state.selected).toBeNull();
    expect(state.page).toBe(2);
    state.queries = [];
    renderRepository();
    await lastQuery().queryFn({ signal: new AbortController().signal });
    expect(state.listRepository).toHaveBeenCalledExactlyOnceWith("repo-one", {
      page: 2,
      pageSize: 20,
    });
  });
});

describe("configuration audit recorded details", () => {
  it("refreshes exact repository access from the open event without changing the recorded selection", () => {
    state.selected = repositorySummary;
    expect(renderRepository()).toContain("version-one");
    const refresh = state.buttons.find((button) => button.children === "Refresh access");
    expect(refresh).toBeDefined();
    refresh?.onClick?.();
    expect(state.refreshAccess).toHaveBeenCalledExactlyOnceWith("repo-one");
    expect(state.selected).toBe(repositorySummary);
    expect(state.getRepository).not.toHaveBeenCalled();
    expect(state.listRepository).not.toHaveBeenCalled();
    state.checking = true;
    expect(renderRepository()).not.toContain("version-one");
    state.checking = false;
    state.canRead = false;
    const denied = renderRepository();
    expect(denied).toContain("Configuration activity is unavailable");
    expect(denied).not.toContain("ExactActor");
    expect(denied).not.toContain("version-one");
  });

  it("uses the platform access context when refreshing an open global prompt event", () => {
    state.administrator = true;
    state.selected = summary;
    state.detail = detail;
    renderGlobal();
    state.buttons.find((button) => button.children === "Refresh access")?.onClick?.();
    expect(state.refreshAccess).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(state.scopes).toEqual([undefined]);
  });

  it("shows only retained draft metadata and never retrieves a current draft", async () => {
    state.administrator = true;
    state.selected = summary;
    state.list = { items: [summary], total: 1, page: 1, pageSize: 20 };
    state.detail = detail;
    state.getGlobal.mockResolvedValue(detail);
    const html = renderGlobal();
    expect(html).toContain("old draft body was not retained");
    expect(html).toContain("draftRevision");
    expect(html).toContain("Template revision 3");
    await lastQuery().queryFn({ signal: new AbortController().signal });
    expect(state.getGlobal).toHaveBeenCalledWith(summary.id, summary);
  });

  it("rejects a changed immutable receipt before showing it", async () => {
    state.selected = repositorySummary;
    state.getRepository.mockResolvedValue({
      ...repositoryDetail,
      actor: { ...repositoryDetail.actor, issuer: "different" },
    });
    renderRepository();
    await expect(lastQuery().queryFn({ signal: new AbortController().signal })).rejects.toThrow(
      "does not match",
    );
  });

  it("hides a cached detail whose immutable actor identity changed", () => {
    state.selected = repositorySummary;
    state.detail = {
      ...repositoryDetail,
      actor: { ...repositoryDetail.actor, subject: "ChangedActor" },
    };
    expect(renderRepository()).not.toContain("ChangedActor");
  });

  it("discards a read completed after cancellation", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    state.listRepository.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    renderRepository();
    const controller = new AbortController();
    const request = lastQuery().queryFn({ signal: controller.signal });
    controller.abort();
    resolve?.(state.list);
    await expect(request).rejects.toThrow();
  });

  it("does not start a read that is already canceled", async () => {
    renderRepository();
    const controller = new AbortController();
    controller.abort();
    await expect(lastQuery().queryFn({ signal: controller.signal })).rejects.toThrow();
    expect(state.listRepository).not.toHaveBeenCalled();
  });
});
