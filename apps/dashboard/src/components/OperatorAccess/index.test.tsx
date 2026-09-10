import type { OperatorAccessContext, OperatorRepositoryRole } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InitialState } from "@/state/session";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import { OperatorAccessGate, useOperatorAccess } from "./index";

const model = vi.hoisted(() => ({ initialState: null as InitialState | null }));
vi.mock("@/state/session", () => ({ useOperatorSession: () => model }));
vi.mock("@/services/access", () => ({ access: { mode: "connected", context: vi.fn() } }));
vi.mock("@/services/review-control/http-client", () => ({
  OPERATOR_ACCESS_DENIED_EVENT: "operator-access-denied",
}));
vi.mock(
  "@/services/review-control/errors",
  async () => import("../../services/review-control/errors"),
);
vi.mock("@mui/material", () => ({
  Alert: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  AlertTitle: ({ children }: { children: ReactNode }) => <strong>{children}</strong>,
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Skeleton: () => <div>Loading permissions</div>,
}));

const principal = { issuer: "https://issuer.example", subject: "operator-1" };
const globalContext: OperatorAccessContext = {
  principal,
  platformAdministrator: false,
  repository: null,
};
const key = (repositoryId: string | null) => [
  "operator-access",
  "context",
  "connected",
  principal.issuer,
  principal.subject,
  1,
  repositoryId,
];
const repoContext = (role: OperatorRepositoryRole): OperatorAccessContext => ({
  principal,
  platformAdministrator: false,
  repository: {
    repositoryId: "repo-1",
    role,
    source: "repository",
    permissions: role === "viewer" ? ["read"] : ["read", "review", "configure", "manage_access"],
  },
});
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const render = (queryClient: QueryClient, node: ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
function StateProbe() {
  const state = useOperatorAccess("repo-1");
  return (
    <span>
      {JSON.stringify({
        ready: state.ready,
        pending: state.pending,
        checking: state.checking,
        read: state.allows("read"),
        review: state.can("review"),
      })}
    </span>
  );
}

beforeEach(() => {
  model.initialState = {
    authenticated: true,
    sessionEpoch: 1,
    authenticationEpoch: 1,
    apiConnected: true,
    operatorAccess: globalContext,
    accessResolvedAt: Date.now(),
    currentUser: { displayName: "Operator", principal },
    settings: {},
  };
});

describe("operator permission gates", () => {
  it("mounts directory content for a signed-in operator with no repository grants", () => {
    expect(
      render(client(), <OperatorAccessGate>Repository directory</OperatorAccessGate>),
    ).toContain("Repository directory");
  });

  it("does not mount a platform-only query component for a viewer", () => {
    const platformQuery = vi.fn();
    function SystemQueries() {
      platformQuery();
      return <span>System data</span>;
    }
    const html = render(
      client(),
      <OperatorAccessGate platformOnly>
        <SystemQueries />
      </OperatorAccessGate>,
    );
    expect(html).toContain("platform administrator");
    expect(platformQuery).not.toHaveBeenCalled();
  });

  it("mounts platform content only for the explicit runtime grant", () => {
    if (!model.initialState) throw new Error("Initial state is required.");
    model.initialState.operatorAccess = { ...globalContext, platformAdministrator: true };
    expect(
      render(client(), <OperatorAccessGate platformOnly>System data</OperatorAccessGate>),
    ).toContain("System data");
  });

  it("withholds repository content while access is unknown", () => {
    const protectedRead = vi.fn();
    function RepoQueries() {
      protectedRead();
      return <span>Repository data</span>;
    }
    expect(
      render(
        client(),
        <OperatorAccessGate repositoryId="repo-1">
          <RepoQueries />
        </OperatorAccessGate>,
      ),
    ).toContain("Loading permissions");
    expect(protectedRead).not.toHaveBeenCalled();
  });

  it("lets a viewer read results while withholding the review action session", () => {
    const queryClient = client();
    queryClient.setQueryData(key("repo-1"), repoContext("viewer"));
    expect(
      render(
        queryClient,
        <OperatorAccessGate repositoryId="repo-1">Actual results</OperatorAccessGate>,
      ),
    ).toContain("Actual results");
    expect(
      render(
        queryClient,
        <OperatorAccessGate repositoryId="repo-1" permission="review">
          Create run
        </OperatorAccessGate>,
      ),
    ).not.toContain("Create run");
  });

  it("does not reuse a cached grant after a failed permission refresh", () => {
    const queryClient = client();
    queryClient.setQueryData(key("repo-1"), repoContext("admin"));
    queryClient
      .getQueryCache()
      .find({ queryKey: key("repo-1") })
      ?.setState({ status: "error", error: new Error("Unavailable"), fetchStatus: "idle" });
    const html = render(
      queryClient,
      <OperatorAccessGate repositoryId="repo-1">Protected data</OperatorAccessGate>,
    );
    expect(html).toContain("Access could not be verified");
    expect(html).not.toContain("Protected data");
    expect(render(queryClient, <StateProbe />)).toContain("&quot;review&quot;:false");
  });

  it.each([403, 404])("withholds an earlier grant after HTTP %i without logging out", (status) => {
    const queryClient = client();
    queryClient.setQueryData(key("repo-1"), repoContext("admin"));
    queryClient
      .getQueryCache()
      .find({ queryKey: key("repo-1") })
      ?.setState({
        status: "error",
        error: new ReviewControlHttpError("Access unavailable", {
          operation: "get operator access",
          status,
          retryable: false,
        }),
        fetchStatus: "idle",
      });
    const html = render(
      queryClient,
      <OperatorAccessGate repositoryId="repo-1">Old administrator detail</OperatorAccessGate>,
    );
    expect(html).toContain("Access required");
    expect(html).not.toContain("Old administrator detail");
    expect(model.initialState?.authenticated).toBe(true);
  });

  it("preserves permitted reads but disables mutation while refreshing", () => {
    const queryClient = client();
    queryClient.setQueryData(key("repo-1"), repoContext("admin"));
    queryClient
      .getQueryCache()
      .find({ queryKey: key("repo-1") })
      ?.setState({ fetchStatus: "fetching" });
    const html = render(queryClient, <StateProbe />);
    expect(html).toContain("&quot;read&quot;:true");
    expect(html).toContain("&quot;review&quot;:false");
  });

  it("rejects a successful response that belongs to another identity", () => {
    const queryClient = client();
    queryClient.setQueryData(key("repo-1"), {
      ...repoContext("admin"),
      principal: { ...principal, subject: "operator-2" },
    });
    const html = render(
      queryClient,
      <OperatorAccessGate repositoryId="repo-1">Protected data</OperatorAccessGate>,
    );
    expect(html).toContain("Access could not be verified");
    expect(html).not.toContain("Protected data");
  });

  it("does not expose the old administrator cache while the new viewer access is loading", () => {
    const queryClient = client();
    queryClient.setQueryData(key("repo-1"), repoContext("admin"));
    if (!model.initialState) throw new Error("Initial state is required.");
    model.initialState = {
      ...model.initialState,
      currentUser: { displayName: "Viewer", principal: { ...principal, subject: "operator-2" } },
      operatorAccess: null,
    };
    const html = render(
      queryClient,
      <OperatorAccessGate repositoryId="repo-1">
        Administrator repository title and result
      </OperatorAccessGate>,
    );
    expect(html).toContain("Loading permissions");
    expect(html).not.toContain("Administrator repository title and result");
  });

  it("does not reuse an old access grant after same-identity session verification fails", () => {
    const queryClient = client();
    queryClient.setQueryData(key(null), globalContext);
    queryClient.setQueryData(key("repo-1"), repoContext("admin"));
    if (!model.initialState) throw new Error("Initial state is required.");
    model.initialState = { ...model.initialState, operatorAccess: null, authenticationEpoch: 2 };
    expect(
      render(
        queryClient,
        <OperatorAccessGate repositoryId="repo-1">Old allowed result</OperatorAccessGate>,
      ),
    ).not.toContain("Old allowed result");
  });
});
