import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotificationAccess,
  type NotificationAccessState,
  NotificationSession,
  useNotificationAccess,
} from "./access";

const state = vi.hoisted(() => ({
  mode: "connected",
  subject: "reader-a",
  epoch: 1,
  readable: true,
  checking: false,
  error: null as Error | null,
  platform: false,
}));
vi.mock("@umijs/max", () => ({
  useModel: () => ({ initialState: { authenticationEpoch: state.epoch } }),
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: (repositoryId?: string) => ({
    identityKey: [state.mode, "issuer", state.subject],
    principal: { issuer: "issuer", subject: state.subject },
    context: {
      platformAdministrator: state.platform,
      repository: repositoryId
        ? { repositoryId, permissions: state.readable ? ["read"] : [] }
        : null,
    },
    ready: true,
    pending: false,
    checking: state.checking,
    error: state.error,
    allows: () => state.readable,
    refresh: vi.fn(),
  }),
}));
vi.mock("antd", () => ({
  Alert: ({
    title,
    description,
    action,
  }: {
    title: ReactNode;
    description: ReactNode;
    action: ReactNode;
  }) => (
    <aside>
      {title}
      {description}
      {action}
    </aside>
  ),
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Skeleton: () => <span>Checking access</span>,
}));
let observed: NotificationAccessState | undefined;
const protectedQuery = vi.fn();
function Content({ enabled }: { enabled: boolean }) {
  if (!enabled) return <span>No private events while checking</span>;
  protectedQuery();
  return <span>Private inbox events</span>;
}
function Probe({ repositoryId = "repository-a" }: { repositoryId?: string }) {
  const access = useNotificationAccess(repositoryId);
  observed = access;
  return (
    <NotificationAccess access={access}>
      <Content enabled={access.readable} />
    </NotificationAccess>
  );
}
function render(repositoryId?: string) {
  const client = new QueryClient();
  const result = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <NotificationSession>
        <Probe repositoryId={repositoryId} />
      </NotificationSession>
    </QueryClientProvider>,
  );
  client.clear();
  return result;
}
beforeEach(() => {
  state.mode = "connected";
  state.subject = "reader-a";
  state.epoch = 1;
  state.readable = true;
  state.checking = false;
  state.error = null;
  state.platform = false;
  protectedQuery.mockClear();
  observed = undefined;
});
describe("notification access gate", () => {
  it("allows a repository reader to manage their inbox without requiring configure", () => {
    expect(render()).toContain("Private inbox events");
    expect(protectedQuery).toHaveBeenCalledOnce();
  });
  it.each(["sample", "checking", "revoked", "failed"])(
    "does not mount protected data for %s access",
    (condition) => {
      if (condition === "sample") state.mode = "sample";
      if (condition === "checking") state.checking = true;
      if (condition === "revoked") state.readable = false;
      if (condition === "failed") state.error = new Error("Access unavailable");
      expect(render()).not.toContain("Private inbox events");
      expect(protectedQuery).not.toHaveBeenCalled();
    },
  );
  it("isolates the key across repository, principal, authentication epoch and access grant", () => {
    const keys = new Set<string>();
    render();
    keys.add(observed?.session ?? "");
    render("repository-b");
    keys.add(observed?.session ?? "");
    state.subject = "reader-b";
    render();
    keys.add(observed?.session ?? "");
    state.epoch = 2;
    render();
    keys.add(observed?.session ?? "");
    state.platform = true;
    render();
    keys.add(observed?.session ?? "");
    expect(keys.size).toBe(5);
  });
});
