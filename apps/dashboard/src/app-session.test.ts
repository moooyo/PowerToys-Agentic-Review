import type { OperatorAccessContext } from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInitialState } from "./app";

const mocks = vi.hoisted(() => ({ context: vi.fn(), assign: vi.fn() }));
vi.mock("@ant-design/icons", () => ({
  BranchesOutlined: () => null,
  GithubOutlined: () => null,
  LogoutOutlined: () => null,
  MenuFoldOutlined: () => null,
  MenuOutlined: () => null,
  MenuUnfoldOutlined: () => null,
  UserOutlined: () => null,
}));
vi.mock("antd", () => ({
  Avatar: () => null,
  Badge: () => null,
  Button: () => null,
  Tooltip: () => null,
}));
vi.mock("@/services/access", () => ({ access: { context: mocks.context } }));
vi.mock("@/components/OperatorSession", () => ({ OperatorSessionBoundary: () => null }));
vi.mock("@/components/OperatorAccess", () => ({
  OperatorAccessEvents: () => null,
  useOperatorAccess: vi.fn(),
}));
vi.mock(
  "@/components/OperatorAccess/state",
  async () => import("./components/OperatorAccess/state"),
);
vi.mock("@/components/RepositoryScope", () => ({
  RepositoryScopedLink: () => null,
  RepositorySelector: () => null,
  useRepositoryScope: vi.fn(),
}));

const principal = { issuer: "https://issuer.example", subject: "operator-1" };
const context: OperatorAccessContext = {
  principal,
  platformAdministrator: false,
  repository: null,
};
const session = {
  authenticated: true,
  operator: { ...principal, displayName: "Signed-in viewer" },
};
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubGlobal("location", { pathname: "/pull-requests", assign: mocks.assign });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(session)),
  );
  mocks.assign.mockReset();
  mocks.context.mockReset().mockResolvedValue(context);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("operator session initialization", () => {
  it("keeps an authenticated user without any grants signed in", async () => {
    const state = await getInitialState();
    expect(state).toMatchObject({
      authenticated: true,
      apiConnected: true,
      operatorAccess: context,
      currentUser: { principal },
    });
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.context).toHaveBeenCalledOnce();
  });

  it("does not turn an access failure into logout or sample data", async () => {
    mocks.context.mockRejectedValue(new Error("Forbidden"));
    expect(await getInitialState()).toMatchObject({
      authenticated: true,
      operatorAccess: null,
      currentUser: { principal },
    });
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.context).toHaveBeenCalledOnce();
  });

  it("rejects access for another identity without changing the current session", async () => {
    mocks.context.mockResolvedValue({
      ...context,
      principal: { ...principal, subject: "other" },
      platformAdministrator: true,
    });
    expect(await getInitialState()).toMatchObject({
      authenticated: true,
      operatorAccess: null,
      currentUser: { principal },
    });
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("redirects only an explicitly unauthenticated session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ authenticated: false })),
    );
    expect(await getInitialState()).toMatchObject({ authenticated: false, operatorAccess: null });
    expect(mocks.assign).toHaveBeenCalledWith("/signed-out");
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("does not fetch system or worker data during initialization", async () => {
    await getInitialState();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/auth/session",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("keeps the same business cache epoch when the same identity is verified again", async () => {
    const first = await getInitialState();
    const second = await getInitialState();
    expect(second.sessionEpoch).toBe(first.sessionEpoch);
    expect(second.authenticationEpoch).toBeGreaterThan(first.authenticationEpoch);
    mocks.context.mockRejectedValue(new Error("Access unavailable"));
    const failedAccess = await getInitialState();
    expect(failedAccess.sessionEpoch).toBe(first.sessionEpoch);
    expect(failedAccess.operatorAccess).toBeNull();
  });

  it("changes the cache epoch for an exact identity change and logout/relogin", async () => {
    const first = await getInitialState();
    const nextPrincipal = { ...principal, subject: "operator-2" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          authenticated: true,
          operator: { ...nextPrincipal, displayName: "Viewer" },
        }),
      ),
    );
    mocks.context.mockResolvedValue({ ...context, principal: nextPrincipal });
    const second = await getInitialState();
    expect(second.sessionEpoch).toBeGreaterThan(first.sessionEpoch);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ authenticated: false })),
    );
    const signedOut = await getInitialState();
    expect(signedOut.sessionEpoch).toBeGreaterThan(second.sessionEpoch);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(session)),
    );
    mocks.context.mockResolvedValue(context);
    expect((await getInitialState()).sessionEpoch).toBeGreaterThan(signedOut.sessionEpoch);
  });
});
