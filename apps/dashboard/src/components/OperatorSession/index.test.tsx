import { useQueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InitialState } from "../../app";
import { OperatorSessionBoundary } from "./index";
import { operatorSessionKey } from "./state";

const model = vi.hoisted(() => ({
  initialState: undefined as InitialState | undefined,
  loading: false,
}));
vi.mock("@umijs/max", () => ({ useModel: () => model }));
vi.mock("@/components/OperatorAccess", () => ({ OperatorAccessEvents: () => null }));
vi.mock("@/services/access", () => ({ access: { mode: "connected" } }));
vi.mock("antd", () => ({ Skeleton: () => <div>Verifying session</div> }));
const principal = { issuer: "https://issuer.example", subject: "admin" };
const state = (): InitialState => ({
  apiConnected: true,
  authenticated: true,
  sessionEpoch: 1,
  authenticationEpoch: 1,
  accessResolvedAt: 1,
  operatorAccess: { principal, platformAdministrator: true, repository: null },
  currentUser: { displayName: "Admin", principal },
  settings: {},
});

beforeEach(() => {
  model.initialState = state();
  model.loading = false;
});

describe("operator session cache boundary", () => {
  it("separates every exact identity, explicit logout, and sample mode", () => {
    const first = state();
    const key = operatorSessionKey(first, "connected");
    expect(
      operatorSessionKey(
        {
          ...first,
          currentUser: { ...first.currentUser, principal: { ...principal, subject: "viewer" } },
        },
        "connected",
      ),
    ).not.toBe(key);
    expect(
      operatorSessionKey(
        {
          ...first,
          currentUser: {
            ...first.currentUser,
            principal: { ...principal, issuer: "https://ISSUER.example" },
          },
        },
        "connected",
      ),
    ).not.toBe(key);
    expect(operatorSessionKey({ ...first, authenticated: false }, "connected")).not.toBe(key);
    expect(operatorSessionKey(first, "sample")).not.toBe(key);
  });

  it("preserves the cache key during ordinary permission and scope refreshes", () => {
    const first = state();
    expect(
      operatorSessionKey(
        { ...first, operatorAccess: null, authenticationEpoch: 2, accessResolvedAt: 0 },
        "connected",
      ),
    ).toBe(operatorSessionKey(first, "connected"));
  });

  it("does not initialize business queries before the first session is known", () => {
    model.initialState = undefined;
    model.loading = true;
    const query = vi.fn();
    function SensitivePage() {
      query();
      return <div>Old repository titles</div>;
    }
    expect(
      renderToStaticMarkup(
        <OperatorSessionBoundary>
          <SensitivePage />
        </OperatorSessionBoundary>,
      ),
    ).not.toContain("Old repository titles");
    expect(query).not.toHaveBeenCalled();
  });

  it("hides and disables the previous route tree while a session is being checked", () => {
    model.loading = true;
    const html = renderToStaticMarkup(
      <OperatorSessionBoundary>
        <div>Previous selection</div>
      </OperatorSessionBoundary>,
    );
    expect(html).toContain("Verifying operator session");
    expect(html).toMatch(/hidden=""[^>]*inert=""[^>]*aria-hidden="true"/u);
  });

  it("creates an empty business cache for the next identity", () => {
    function BusinessData({ seed }: { seed?: boolean }) {
      const queryClient = useQueryClient();
      if (seed) {
        queryClient.setQueryData(
          ["managed-repositories", "scope-options"],
          ["Admin-only repository"],
        );
        queryClient.setQueryData(["search-count"], 20);
        queryClient.setQueryData(["selected-work-item"], "Private PR title");
      }
      return (
        <span>
          {JSON.stringify([
            queryClient.getQueryData(["managed-repositories", "scope-options"]),
            queryClient.getQueryData(["search-count"]),
            queryClient.getQueryData(["selected-work-item"]),
          ])}
        </span>
      );
    }
    const first = state();
    expect(
      renderToStaticMarkup(
        <OperatorSessionBoundary>
          <BusinessData seed />
        </OperatorSessionBoundary>,
      ),
    ).toContain("Admin-only repository");
    model.initialState = {
      ...first,
      sessionEpoch: 2,
      currentUser: { displayName: "Viewer", principal: { ...principal, subject: "viewer" } },
      operatorAccess: null,
    };
    expect(operatorSessionKey(model.initialState, "connected")).not.toBe(
      operatorSessionKey(first, "connected"),
    );
    expect(
      renderToStaticMarkup(
        <OperatorSessionBoundary>
          <BusinessData />
        </OperatorSessionBoundary>,
      ),
    ).toContain("[null,null,null]");
  });
});
