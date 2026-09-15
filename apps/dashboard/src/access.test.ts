import type { OperatorAccessContext } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import access from "./access";
import type { InitialState } from "./state/session";

const principal = { issuer: "https://issuer.example", subject: "viewer" };
function state(context: OperatorAccessContext | null): InitialState {
  return {
    authenticated: true,
    sessionEpoch: 1,
    authenticationEpoch: 1,
    apiConnected: true,
    operatorAccess: context,
    accessResolvedAt: Date.now(),
    currentUser: { displayName: "Viewer", principal },
    settings: {},
  };
}
describe("route access", () => {
  it("keeps signed-in users without grants in the workspace without exposing platform pages", () => {
    const result = access(state({ principal, platformAdministrator: false, repository: null }));
    expect(result.canRead).toBe(true);
    expect(result.canManageSystem).toBe(false);
    expect(result.canManageWorkers).toBe(false);
  });
  it("withholds platform navigation when the access request failed", () => {
    expect(access(state(null))).toMatchObject({
      canRead: true,
      canManageSystem: false,
      canManageWorkers: false,
    });
  });
  it("requires the runtime flag for platform navigation", () => {
    expect(
      access(state({ principal, platformAdministrator: true, repository: null })),
    ).toMatchObject({ canRead: true, canManageSystem: true, canManageWorkers: true });
  });
  it("does not infer a session from a cached platform flag", () => {
    expect(
      access({
        ...state({ principal, platformAdministrator: true, repository: null }),
        authenticated: false,
      }),
    ).toMatchObject({ canRead: false, canManageSystem: false, canManageWorkers: false });
    expect(access(undefined).canRead).toBe(false);
  });
});
