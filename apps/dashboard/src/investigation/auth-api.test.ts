import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAuthApi } from "./auth-api";
import { resumeInvestigationRequests, subscribeInvestigationSessionExpired } from "./transport";

afterEach(() => resumeInvestigationRequests());

describe("password account HTTP boundary", () => {
  it("sends explicit credentials only in the same-origin sign-in POST", async () => {
    const session = {
      authenticated: true,
      authMode: "password",
      loginPath: "/api/auth/login",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: {
        id: "demo",
        username: "demo",
        displayName: "Demo",
        isAdmin: false,
        repositoryIds: [],
        permissions: [],
        actionCapabilities: [],
        allowRepositoryExecution: false,
        email: null,
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(session));
    const api = createHttpAuthApi(fetcher);
    await expect(api.login({ username: "Demo", password: "Demo-password-2026!" })).resolves.toEqual(
      session,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify({ username: "Demo", password: "Demo-password-2026!" }),
      }),
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("invalidates protected sessions on 401 but does not create a login failure refresh loop", async () => {
    const expired = vi.fn();
    const unsubscribe = subscribeInvestigationSessionExpired(expired);
    try {
      const protectedFetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ message: "Session expired" }, { status: 401 }));
      await expect(createHttpAuthApi(protectedFetcher).listAccounts()).rejects.toMatchObject({
        status: 401,
      });
      expect(expired).toHaveBeenCalledOnce();
      const loginFetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ message: "Account existence must not be exposed" }, { status: 401 }),
        );
      await expect(
        createHttpAuthApi(loginFetcher).login({ username: "demo", password: "wrong" }),
      ).rejects.toThrow("username or password is incorrect");
      expect(expired).toHaveBeenCalledOnce();
      expect(loginFetcher).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("requires the 204 session-revocation receipt for password changes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await createHttpAuthApi(fetcher).changePassword({
      currentPassword: "old-password",
      newPassword: "new-password-long-enough",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/password",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          currentPassword: "old-password",
          newPassword: "new-password-long-enough",
        }),
      }),
    );
  });
});
