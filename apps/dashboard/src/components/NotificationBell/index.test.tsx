import type { ElementType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationSummaryFixture } from "../../services/notifications/fixtures.testing";
import { NotificationBell } from "./index";

const state = vi.hoisted(() => ({
  repositoryId: undefined as string | undefined,
  sample: false,
  summary: undefined as unknown,
  ready: true,
  search: "",
}));
vi.mock("@/components/RepositoryScope", () => ({
  useRepositoryScope: () => ({ repositoryId: state.repositoryId, ready: state.ready }),
}));
vi.mock("./access", () => ({
  useNotificationAccess: () => ({ sample: state.sample, readable: !state.sample }),
  useNotificationSummary: (_repositoryId: unknown, access: { readable: boolean }) => ({
    data: access.readable ? state.summary : undefined,
  }),
}));
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ search: state.search }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@mui/icons-material/NotificationsOutlined", () => ({ default: () => <span>Bell</span> }));
vi.mock("@mui/material", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  IconButton: ({
    component: Component,
    to,
    "aria-label": label,
    children,
  }: {
    component: ElementType;
    to: string;
    "aria-label": string;
    children: ReactNode;
  }) => (
    <Component to={to} aria-label={label}>
      {children}
    </Component>
  ),
  Box: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Badge: ({
    children,
    badgeContent,
    showZero,
  }: {
    children: ReactNode;
    badgeContent: ReactNode;
    showZero: boolean;
  }) => (
    <span>
      {children}
      {showZero ? badgeContent : null}
    </span>
  ),
}));
beforeEach(() => {
  state.repositoryId = undefined;
  state.sample = false;
  state.summary = undefined;
  state.ready = true;
  state.search = "";
});
describe("notification bell", () => {
  it("shows unavailable rather than zero while counts cannot be verified", () => {
    const html = renderToStaticMarkup(<NotificationBell />);
    expect(html).toContain("Notification count unavailable");
    expect(html).not.toContain("0 unread");
    expect(html).toContain('href="/notifications"');
  });
  it("uses the exact selected repository and capped server count", () => {
    state.repositoryId = "repository-b";
    state.summary = {
      ...notificationSummaryFixture("repository-b"),
      unreadCount: 99,
      capped: true,
    };
    const html = renderToStaticMarkup(<NotificationBell />);
    expect(html).toContain("99+ unread notifications");
    expect(html).toContain('href="/notifications?repositoryId=repository-b"');
  });
  it("labels sample mode explicitly", () => {
    state.sample = true;
    expect(renderToStaticMarkup(<NotificationBell />)).toContain(
      "Notifications unavailable in sample mode",
    );
  });
  it("does not widen an invalid repository URL to global counts", () => {
    state.ready = false;
    state.search = "?repositoryId=repository-a&repositoryId=repository-b";
    state.summary = { ...notificationSummaryFixture(), unreadCount: 42 };
    const html = renderToStaticMarkup(<NotificationBell />);
    expect(html).toContain("Notification repository scope unavailable");
    expect(html).not.toContain("42");
    expect(html).toContain(
      'href="/notifications?repositoryId=repository-a&amp;repositoryId=repository-b"',
    );
  });
});
