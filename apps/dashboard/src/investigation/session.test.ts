import { describe, expect, it } from "vitest";
import { decodeSession, sessionIdentity } from "./session";

describe("investigation session", () => {
  it("requires an authenticated identity with explicit repository permissions", () => {
    expect(() =>
      decodeSession({
        authenticated: true,
        authMode: "loopback",
        loginPath: "/api/auth/login",
        user: null,
      }),
    ).toThrow();
    expect(() =>
      decodeSession({
        authenticated: true,
        authMode: "loopback",
        loginPath: "/api/auth/login",
        user: {
          id: "operator",
          displayName: "Operator",
          repositoryIds: ["repo"],
          capabilities: ["admin"],
        },
      }),
    ).toThrow();
  });

  it("accepts a signed-out session without inventing a development operator", () => {
    expect(
      decodeSession({
        authenticated: false,
        authMode: "oidc",
        loginPath: "/api/auth/login",
        user: null,
      }).user,
    ).toBeNull();
  });

  it("changes the workspace identity when repository grants or action permissions are revoked", () => {
    const session = decodeSession({
      authenticated: true,
      authMode: "oidc",
      loginPath: "/api/auth/login",
      user: {
        id: "operator",
        displayName: "Operator",
        repositoryIds: ["repo"],
        permissions: ["action:execute"],
        actionCapabilities: ["approve"],
        allowRepositoryExecution: false,
      },
    });
    const revoked = {
      ...session,
      user: session.user ? { ...session.user, actionCapabilities: [] } : null,
    };
    expect(sessionIdentity(revoked)).not.toBe(sessionIdentity(session));
  });
});
