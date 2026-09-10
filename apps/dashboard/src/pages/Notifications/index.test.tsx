import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  notificationListFixture,
  notificationOverviewFixture,
  notificationSummaryFixture,
} from "../../services/notifications/fixtures.testing";
import NotificationsPage from "./index";

const state = vi.hoisted(() => ({
  repositoryId: undefined as string | undefined,
  sample: false,
  readable: true,
  failed: false,
  list: undefined as unknown,
  overview: undefined as unknown,
  keys: [] as unknown[][],
  links: [] as { to: string; onClick: unknown }[],
  change: vi.fn(),
}));
vi.mock("@/components/RepositoryScope", () => ({
  useRepositoryScope: () => ({ repositoryId: state.repositoryId, ready: true }),
  RepositoryScopeUnavailable: () => <aside>Scope unavailable</aside>,
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => <h1>Notifications</h1> }));
vi.mock("@/components/NotificationBell/access", () => ({
  useNotificationAccess: () => ({
    sample: state.sample,
    readable: state.readable,
    session: `session-${state.repositoryId ?? "all"}`,
    principal: { issuer: "issuer", subject: "reader" },
    refreshAccess: vi.fn(),
  }),
  NotificationAccess: ({ children }: { children: ReactNode }) =>
    state.sample ? (
      <aside>Personal notifications are unavailable in sample mode.</aside>
    ) : state.readable ? (
      children
    ) : (
      <aside>Access unavailable</aside>
    ),
  useNotificationFailure: vi.fn(),
  notificationAccessDenied: () => false,
  useNotificationSummary: () => ({ data: notificationSummaryFixture() }),
}));
vi.mock("@/services/notifications", () => ({
  notificationQueryRoot: ["notifications"],
  notifications: { overview: vi.fn(), list: vi.fn(), change: state.change },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: { queryKey: unknown[] }) => {
    state.keys.push(options.queryKey);
    return {
      data: options.queryKey.includes("overview") ? state.overview : state.list,
      isError: state.failed,
      error: state.failed ? new Error("unavailable") : null,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("react-router-dom", () => ({
  Link: ({
    to,
    children,
    onClick,
    ...props
  }: {
    to: string;
    children: ReactNode;
    onClick?: unknown;
  }) => {
    state.links.push({ to, onClick });
    return (
      <a href={to} {...props}>
        {children}
      </a>
    );
  },
}));
function buttonMarkup(html: string, label: string): string {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const button = buttons.find((markup) => markup.replace(/<[^>]*>/g, "").includes(label));
  expect(button).toBeDefined();
  return button ?? "";
}
beforeEach(() => {
  state.repositoryId = undefined;
  state.sample = false;
  state.readable = true;
  state.failed = false;
  state.list = notificationListFixture();
  state.overview = notificationOverviewFixture();
  state.keys = [];
  state.links = [];
  state.change.mockClear();
});
describe("notification inbox", () => {
  it("uses the overview without issuing a fanout list of repository events", () => {
    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain("Repository inboxes");
    expect(html).toContain('aria-label="Repository notification inboxes"');
    expect(html).toContain("synthetic/repository-a");
    expect(state.keys).toEqual([["notifications", "session-all", "overview", 1]]);
    expect(state.links).toEqual([
      { to: "/notifications?repositoryId=repository-a", onClick: undefined },
    ]);
  });
  it("renders outcome checks and exact result links without automatic mark read", () => {
    state.repositoryId = "repository-a";
    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain("Validation completed");
    expect(html).toContain("1 failed");
    expect(html).toContain("Opening an event does not mark it as read");
    expect(state.links[0]?.to).toContain("requestId=request-a&jobId=job-a");
    expect(state.links[0]?.onClick).toBeUndefined();
    expect(state.change).not.toHaveBeenCalled();
    expect(buttonMarkup(html, "Mark read")).toContain('disabled=""');
    expect(html).toContain('aria-label="Select notification notification-a"');
    expect(html).toContain('aria-label="Select all notifications on this page"');
  });
  it("keeps the older continuation enabled for an empty bounded filter window", () => {
    state.repositoryId = "repository-a";
    state.list = { ...notificationListFixture(), items: [], nextCursor: "80", scanLimited: true };
    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain("No matching events in this time window");
    expect(buttonMarkup(html, "Older events")).not.toContain('disabled=""');
  });
  it("hides cached event rows after a failed refresh", () => {
    state.repositoryId = "repository-a";
    state.failed = true;
    const html = renderToStaticMarkup(<NotificationsPage />);
    expect(html).toContain("Could not load notifications");
    expect(html).not.toContain("Validation completed");
    expect(state.links).toHaveLength(0);
  });
  it.each(["sample", "revoked"])("does not mount business queries in %s mode", (mode) => {
    if (mode === "sample") state.sample = true;
    else state.readable = false;
    renderToStaticMarkup(<NotificationsPage />);
    expect(state.keys).toHaveLength(0);
    expect(state.change).not.toHaveBeenCalled();
  });
});
