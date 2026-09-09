import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detailFixture } from "../../services/publications/fixtures.testing";
import PublicationsPage from "./index";

const state = vi.hoisted(() => ({
  repositoryId: undefined as string | undefined,
  readable: true,
  configure: true,
  detail: undefined as unknown,
  detailError: false,
  queryKeys: [] as unknown[][],
  buttons: new Map<string, boolean>(),
  list: vi.fn(),
  search: "?repositoryId=repository-a&publicationId=publication-a",
  navigate: vi.fn(),
  close: undefined as (() => void) | undefined,
}));
vi.mock("@umijs/max", () => ({
  useLocation: () => ({ pathname: "/publications", search: state.search }),
  useNavigate: () => state.navigate,
}));
vi.mock("@/components/RepositoryScope", () => ({
  useRepositoryScope: () => ({ repositoryId: state.repositoryId, ready: true }),
  RepositoryScopeUnavailable: () => <span>Scope unavailable</span>,
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => <h1>Publications</h1> }));
vi.mock("@/components/PublicationPreview/access", () => ({
  PublicationAccess: ({
    children,
  }: {
    children: (session: string, access: unknown) => ReactNode;
  }) =>
    state.readable ? (
      children("session-a", {
        principal: { issuer: "fixture", subject: "reader" },
        can: () => state.configure,
        allows: () => state.configure,
        refresh: vi.fn(),
      })
    ) : (
      <aside>Publication access is unavailable</aside>
    ),
  usePublicationReadGuard: () => ({
    denied: false,
    guard: {
      read: (operation: () => Promise<unknown>) => operation(),
      deny: vi.fn(),
      snapshot: () => false,
    },
  }),
  publicationAccessDenied: () => false,
  publicationError: () => "Unavailable",
}));
vi.mock("@/services/publications", () => ({
  publicationQueryRoot: ["publications"],
  publications: { list: state.list, get: vi.fn(), attempts: vi.fn(), control: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: { queryKey: unknown[] }) => {
    state.queryKeys.push(options.queryKey);
    return {
      isError: options.queryKey.includes("detail") && state.detailError,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
      data: options.queryKey.includes("detail")
        ? state.detail
        : options.queryKey.includes("attempts")
          ? { items: [], total: 0 }
          : { items: [], total: 0 },
    };
  },
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
    Button: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => {
      if (typeof children === "string") state.buttons.set(children, !!disabled);
      return (
        <button type="button" disabled={disabled}>
          {children}
        </button>
      );
    },
    Card: ({
      children,
      title,
      extra,
    }: {
      children?: ReactNode;
      title?: ReactNode;
      extra?: ReactNode;
    }) => (
      <section>
        {title}
        {extra}
        {children}
      </section>
    ),
    Descriptions: Content,
    Drawer: ({
      children,
      title,
      extra,
      onClose,
    }: {
      children: ReactNode;
      title: ReactNode;
      extra: ReactNode;
      onClose: () => void;
    }) => {
      state.close = onClose;
      return (
        <section>
          {title}
          {extra}
          {children}
        </section>
      );
    },
    Modal: Content,
    Pagination: Content,
    Select: Content,
    Skeleton: Content,
    Space: Content,
    Table: Content,
    Tag: Content,
    Typography: { Text: Content, Paragraph: Content, Title: Content },
  };
});
beforeEach(() => {
  state.repositoryId = undefined;
  state.readable = true;
  state.configure = true;
  state.detail = detailFixture();
  state.detailError = false;
  state.queryKeys = [];
  state.search = "?repositoryId=repository-a&publicationId=publication-a";
  state.close = undefined;
  state.buttons.clear();
  vi.clearAllMocks();
});
describe("repository publication outbox", () => {
  it("follows the current publication URL when navigation selects another record", () => {
    state.repositoryId = "repository-a";
    renderToStaticMarkup(<PublicationsPage />);
    expect(
      state.queryKeys.some((key) => key.includes("detail") && key.includes("publication-a")),
    ).toBe(true);
    state.queryKeys = [];
    state.search = "?repositoryId=repository-a&publicationId=publication-b";
    renderToStaticMarkup(<PublicationsPage />);
    expect(
      state.queryKeys.some((key) => key.includes("detail") && key.includes("publication-b")),
    ).toBe(true);
    expect(state.queryKeys.some((key) => key.includes("publication-a"))).toBe(false);
    state.close?.();
    expect(state.navigate).toHaveBeenCalledWith({
      pathname: "/publications",
      search: "?repositoryId=repository-a",
    });
  });
  it.each([
    "?repositoryId=repository-a&publicationId=publication-a&publicationId=publication-b",
    "?repositoryId=repository-a&publicationId=publication-a&jobId=job-a",
    "?publicationId=publication-a",
  ])("rejects an ambiguous target without requesting any publication: %s", (search) => {
    state.repositoryId = "repository-a";
    state.search = search;
    expect(renderToStaticMarkup(<PublicationsPage />)).toContain("Invalid publication target");
    expect(state.queryKeys).toHaveLength(0);
  });
  it("requires an exact repository before making any outbox query", () => {
    expect(renderToStaticMarkup(<PublicationsPage />)).toContain("Select a repository");
    expect(state.queryKeys).toHaveLength(0);
  });
  it("shows only GET reconciliation for an unknown publication", () => {
    state.repositoryId = "repository-a";
    const detail = detailFixture();
    detail.delivery = {
      ...detail.delivery,
      status: "unknown",
      attemptCount: 1,
      failure: { code: "ambiguous_delivery", message: "Sending may have begun." },
    };
    state.detail = detail;
    const html = renderToStaticMarkup(<PublicationsPage />);
    expect(html).toContain("Delivery is uncertain");
    expect(state.buttons.has("Check GitHub (GET only)")).toBe(true);
    expect(state.buttons.has("Retry delivery")).toBe(false);
    expect(state.buttons.has("Cancel publication")).toBe(false);
    expect(html).toContain("Complete exact review text.");
  });
  it("retains read visibility without granting a reader control actions", () => {
    state.repositoryId = "repository-a";
    state.configure = false;
    const html = renderToStaticMarkup(<PublicationsPage />);
    expect(html).toContain("Complete exact review text.");
    expect(state.buttons.get("Cancel publication")).toBe(true);
  });
  it("clears the frozen publication body on revoked access or failed detail refresh", () => {
    state.repositoryId = "repository-a";
    expect(renderToStaticMarkup(<PublicationsPage />)).toContain("Complete exact review text.");
    state.readable = false;
    expect(renderToStaticMarkup(<PublicationsPage />)).not.toContain("Complete exact review text.");
    state.readable = true;
    state.detailError = true;
    expect(renderToStaticMarkup(<PublicationsPage />)).not.toContain("Complete exact review text.");
  });
});
