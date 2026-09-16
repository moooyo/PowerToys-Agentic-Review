import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { passwordChangeProblem } from "./my-account";
import { decodeSession, PasswordSignInForm, sessionIdentity } from "./session";

afterEach(() => vi.unstubAllEnvs());

const user = {
  id: "operator",
  username: "operator",
  displayName: "Operator",
  isAdmin: true,
  email: null,
  repositoryIds: ["repo"],
  permissions: ["action:execute"],
  actionCapabilities: ["approve"],
  allowRepositoryExecution: false,
};
const authenticated = {
  authenticated: true,
  authMode: "password",
  loginPath: "/api/auth/login",
  user,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

describe("password session boundary", () => {
  it("requires the complete shared password session contract and rejects prior login modes", () => {
    expect(decodeSession(authenticated).authenticated).toBe(true);
    expect(() => decodeSession({ ...authenticated, authMode: "oidc" })).toThrow();
    expect(() => decodeSession({ ...authenticated, expiresAt: undefined })).toThrow();
    expect(() =>
      decodeSession({ ...authenticated, user: { ...user, isAdmin: undefined } }),
    ).toThrow();
    expect(() =>
      decodeSession({ ...authenticated, user: { ...user, password: "not-a-session-field" } }),
    ).toThrow();
  });

  it("accepts signed-out sessions without creating a development identity", () => {
    expect(
      decodeSession({
        authenticated: false,
        authMode: "password",
        loginPath: "/api/auth/login",
        user: null,
      }).user,
    ).toBeNull();
  });

  it("replaces the cached workspace when admin rights or repository grants change", () => {
    const session = decodeSession(authenticated);
    const adminRevoked = decodeSession({ ...authenticated, user: { ...user, isAdmin: false } });
    const repositoryRevoked = decodeSession({
      ...authenticated,
      user: { ...user, repositoryIds: [] },
    });
    expect(sessionIdentity(adminRevoked)).not.toBe(sessionIdentity(session));
    expect(sessionIdentity(repositoryRevoked)).not.toBe(sessionIdentity(session));
  });

  it("renders an accessible password-only form without production demo credentials", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderToStaticMarkup(
      <PasswordSignInForm busy={false} onLogin={async () => {}} onRetry={async () => {}} />,
    );
    expect(html.toLowerCase()).toContain('autocomplete="username"');
    expect(html.toLowerCase()).toContain('autocomplete="current-password"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("Demo-password-2026!");
    expect(html).not.toContain("Register");
    expect(html).not.toContain("OIDC");
  });

  it("labels the public demo credentials as development-only", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(
      <PasswordSignInForm busy={false} onLogin={async () => {}} onRetry={async () => {}} />,
    );
    expect(html).toContain("Development sample only");
    expect(html).toContain("Demo-password-2026!");
    expect(html).toContain("Fill demo credentials");
  });

  it("validates new password length and exact confirmation without trimming spaces", () => {
    expect(
      passwordChangeProblem(
        "current-password",
        "new-password-long-enough ",
        "new-password-long-enough ",
      ),
    ).toBeNull();
    expect(
      passwordChangeProblem(
        "current-password",
        "new-password-long-enough ",
        "new-password-long-enough",
      ),
    ).toContain("do not match");
    expect(passwordChangeProblem("current-password", "short", "short")).toContain("15");
    expect(
      passwordChangeProblem("", "new-password-long-enough", "new-password-long-enough"),
    ).toContain("current password");
    expect(
      passwordChangeProblem("current-password", "😀".repeat(128), "😀".repeat(128)),
    ).toBeNull();
    expect(passwordChangeProblem("current-password", "😀".repeat(129), "😀".repeat(129))).toContain(
      "128",
    );
  });
});
