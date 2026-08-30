import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  DEVELOPMENT_OPERATOR_BROWSER_BINDING_COOKIE,
  DEVELOPMENT_OPERATOR_LOGIN_TRANSACTION_COOKIE,
  DEVELOPMENT_OPERATOR_SESSION_COOKIE,
  OPERATOR_BROWSER_BINDING_COOKIE,
  OPERATOR_CALLBACK_PATH,
  OPERATOR_LOGIN_PATH,
  OPERATOR_LOGIN_TRANSACTION_COOKIE,
  OPERATOR_LOGOUT_PATH,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_PATH,
  type OperatorAuthRouteService,
  readOperatorSession,
  registerOperatorAuthRoutes,
} from "../../dist/routes/auth.js";
import { OperatorAuthError, type OperatorSession } from "../../dist/security/operator-auth.js";

const transactionToken = "T".repeat(43);
const sessionToken = "S".repeat(43);
const browserBindingToken = "B".repeat(43);
const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "operator-123",
  displayName: "Test Operator",
  email: "operator@example.com",
  createdAt: "2026-08-30T05:00:00.000Z",
  expiresAt: "2026-08-30T06:00:00.000Z",
};

const createService = (): OperatorAuthRouteService => ({
  publicOrigin: "https://review.example.com",
  postLoginRedirectPath: "/work-items",
  requiresLoopbackRequest: false,
  secureCookies: true,
  usesBrowserBinding: true,
  ensureBrowserBinding: vi.fn((existingToken?: string) =>
    existingToken === undefined
      ? { token: browserBindingToken, expiresAt: "2026-08-30T06:00:00.000Z" }
      : undefined,
  ),
  startLogin: vi.fn(async () => ({
    kind: "authorization_redirect" as const,
    authorizationUrl: new URL(
      "https://identity.example.com/authorize?state=state-value&code_challenge=challenge",
    ),
    transactionToken,
    transactionExpiresAt: "2026-08-30T05:05:00.000Z",
    browserBindingToken,
    browserBindingExpiresAt: "2026-08-30T06:00:00.000Z",
  })),
  completeLogin: vi.fn(async () => ({
    sessionToken,
    session,
    browserBindingExpiresAt: session.expiresAt,
  })),
  getSession: vi.fn(async () => null),
  logout: vi.fn(async () => undefined),
});

const createApp = (auth: OperatorAuthRouteService): FastifyInstance => {
  const app = Fastify({ logger: false });
  registerOperatorAuthRoutes(app, auth);
  return app;
};

const setCookies = (value: string | string[] | undefined): readonly string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const expectHardenedCookie = (serialized: string, name: string): void => {
  expect(serialized).toContain(`${name}=`);
  expect(serialized).toContain("Path=/");
  expect(serialized).toContain("HttpOnly");
  expect(serialized).toContain("Secure");
  expect(serialized).toContain("SameSite=Lax");
};

describe("operator authentication routes", () => {
  it("starts OIDC login with a hardened opaque transaction cookie", async () => {
    const auth = createService();
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "POST",
        url: OPERATOR_LOGIN_PATH,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
          host: "127.0.0.1:8080",
          origin: auth.publicOrigin,
        },
        payload: "",
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        "https://identity.example.com/authorize?state=state-value&code_challenge=challenge",
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      const cookies = setCookies(response.headers["set-cookie"]);
      expect(cookies).toHaveLength(2);
      const transactionCookie =
        cookies.find((value) => value.startsWith(`${OPERATOR_LOGIN_TRANSACTION_COOKIE}=`)) ?? "";
      const browserCookie =
        cookies.find((value) => value.startsWith(`${OPERATOR_BROWSER_BINDING_COOKIE}=`)) ?? "";
      expectHardenedCookie(transactionCookie, OPERATOR_LOGIN_TRANSACTION_COOKIE);
      expectHardenedCookie(browserCookie, OPERATOR_BROWSER_BINDING_COOKIE);
      expect(transactionCookie).toContain(transactionToken);
      expect(browserCookie).toContain(browserBindingToken);
      expect(auth.startLogin).toHaveBeenCalledWith(browserBindingToken);
    } finally {
      await app.close();
    }
  });

  it("rate limits anonymous login transaction creation", async () => {
    const auth = createService();
    const app = createApp(auth);

    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: OPERATOR_LOGIN_PATH,
          headers: {
            cookie: `${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
            origin: auth.publicOrigin,
          },
        });
        expect(response.statusCode).toBe(302);
      }
      const limited = await app.inject({
        method: "POST",
        url: OPERATOR_LOGIN_PATH,
        headers: {
          cookie: `${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
          origin: auth.publicOrigin,
        },
      });
      expect(limited.statusCode).toBe(429);
      expect(auth.startLogin).toHaveBeenCalledTimes(10);
    } finally {
      await app.close();
    }
  });

  it("makes parsed session cookies available to protected routes registered after auth", async () => {
    const auth = createService();
    auth.getSession = vi.fn(async (token) => (token === sessionToken ? session : null));
    const app = createApp(auth);
    app.get(
      "/protected",
      {
        onRequest: async (request, reply) => {
          if ((await readOperatorSession(request, auth)) === null) {
            return reply.code(401).send();
          }
        },
      },
      async () => ({ ok: true }),
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}; ${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(auth.getSession).toHaveBeenCalledWith(sessionToken, browserBindingToken);
    } finally {
      await app.close();
    }
  });

  it("completes the callback without clearing a potentially newer login transaction", async () => {
    const auth = createService();
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "GET",
        url: `${OPERATOR_CALLBACK_PATH}?code=authorization-code&state=state-value`,
        headers: {
          cookie: `${OPERATOR_LOGIN_TRANSACTION_COOKIE}=${transactionToken}; ${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
        },
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/work-items");
      expect(auth.completeLogin).toHaveBeenCalledOnce();
      const callbackParameters = vi.mocked(auth.completeLogin).mock.calls[0]?.[0];
      expect(callbackParameters?.get("code")).toBe("authorization-code");
      expect(vi.mocked(auth.completeLogin).mock.calls[0]?.[1]).toBe(transactionToken);
      expect(vi.mocked(auth.completeLogin).mock.calls[0]?.[2]).toBe(browserBindingToken);
      const cookies = setCookies(response.headers["set-cookie"]);
      expect(cookies).toHaveLength(2);
      const serializedSession =
        cookies.find((value) => value.startsWith(`${OPERATOR_SESSION_COOKIE}=`)) ?? "";
      expectHardenedCookie(serializedSession, OPERATOR_SESSION_COOKIE);
      expect(serializedSession).toContain(sessionToken);
      expect(serializedSession).not.toContain(`${OPERATOR_LOGIN_TRANSACTION_COOKIE}=`);
      const serializedBrowser =
        cookies.find((value) => value.startsWith(`${OPERATOR_BROWSER_BINDING_COOKIE}=`)) ?? "";
      expectHardenedCookie(serializedBrowser, OPERATOR_BROWSER_BINDING_COOKIE);
      expect(serializedBrowser).toContain(browserBindingToken);
    } finally {
      await app.close();
    }
  });

  it("returns only server-side session identity and expiry", async () => {
    const auth = createService();
    auth.getSession = vi.fn(async () => session);
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "GET",
        url: OPERATOR_SESSION_PATH,
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}; ${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        authenticated: true,
        operator: {
          issuer: session.issuer,
          subject: session.subject,
          displayName: session.displayName,
          email: session.email,
        },
        expiresAt: session.expiresAt,
      });
      expect(auth.getSession).toHaveBeenCalledWith(sessionToken, browserBindingToken);
    } finally {
      await app.close();
    }
  });

  it("reports an anonymous session without clearing a potentially newer session cookie", async () => {
    const auth = createService();
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "GET",
        url: OPERATOR_SESSION_PATH,
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}; ${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ authenticated: false });
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("bootstraps an HttpOnly browser binding before login begins", async () => {
    const auth = createService();
    const app = createApp(auth);

    try {
      const response = await app.inject({ method: "GET", url: OPERATOR_SESSION_PATH });
      const browserCookie =
        setCookies(response.headers["set-cookie"]).find((value) =>
          value.startsWith(`${OPERATOR_BROWSER_BINDING_COOKIE}=`),
        ) ?? "";

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ authenticated: false });
      expectHardenedCookie(browserCookie, OPERATOR_BROWSER_BINDING_COOKIE);
      expect(browserCookie).toContain(browserBindingToken);
      expect(auth.getSession).toHaveBeenCalledWith(undefined, browserBindingToken);
    } finally {
      await app.close();
    }
  });

  it("requires same-origin POST and a bootstrapped browser binding for login", async () => {
    const auth = createService();
    const app = createApp(auth);

    try {
      const getResponse = await app.inject({ method: "GET", url: OPERATOR_LOGIN_PATH });
      expect(getResponse.statusCode).toBe(404);

      const crossOrigin = await app.inject({
        method: "POST",
        url: OPERATOR_LOGIN_PATH,
        headers: {
          cookie: `${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
          origin: "https://attacker.example.com",
        },
      });
      expect(crossOrigin.statusCode).toBe(403);

      const missingBinding = await app.inject({
        method: "POST",
        url: OPERATOR_LOGIN_PATH,
        headers: { origin: auth.publicOrigin },
      });
      expect(missingBinding.statusCode).toBe(409);
      expect(missingBinding.json()).toMatchObject({ code: "browser_binding_required" });
      expect(setCookies(missingBinding.headers["set-cookie"])[0]).toContain(
        `${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
      );
      expect(auth.startLogin).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("revokes the server-side session before clearing browser cookies", async () => {
    const auth = createService();
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "POST",
        url: OPERATOR_LOGOUT_PATH,
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}; ${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
          origin: auth.publicOrigin,
        },
      });

      expect(response.statusCode).toBe(204);
      expect(auth.logout).toHaveBeenCalledWith(sessionToken, browserBindingToken);
      const cookies = setCookies(response.headers["set-cookie"]);
      expect(cookies).toHaveLength(3);
      expect(
        cookies.every((value) => value.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT")),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects logout from a different or missing origin", async () => {
    const auth = createService();
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "POST",
        url: OPERATOR_LOGOUT_PATH,
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}`,
          origin: "https://attacker.example.com",
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "invalid_operator_auth_origin" });
      expect(auth.logout).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("uses non-Secure browser binding for loopback OIDC development", async () => {
    const auth: OperatorAuthRouteService = {
      ...createService(),
      publicOrigin: "http://127.0.0.1:8080",
      requiresLoopbackRequest: true,
      secureCookies: false,
      usesBrowserBinding: true,
    };
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "POST",
        url: OPERATOR_LOGIN_PATH,
        headers: {
          cookie: `${DEVELOPMENT_OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
          host: "127.0.0.1:8080",
          origin: auth.publicOrigin,
        },
      });
      const cookies = setCookies(response.headers["set-cookie"]);
      const transactionCookie =
        cookies.find((value) =>
          value.startsWith(`${DEVELOPMENT_OPERATOR_LOGIN_TRANSACTION_COOKIE}=`),
        ) ?? "";
      const browserCookie =
        cookies.find((value) =>
          value.startsWith(`${DEVELOPMENT_OPERATOR_BROWSER_BINDING_COOKIE}=`),
        ) ?? "";

      expect(response.statusCode).toBe(302);
      expect(cookies).toHaveLength(2);
      expect(transactionCookie).toContain(transactionToken);
      expect(browserCookie).toContain(browserBindingToken);
      expect(transactionCookie).not.toContain("Secure");
      expect(browserCookie).not.toContain("Secure");
      expect(transactionCookie).not.toContain("__Host-");
      expect(browserCookie).not.toContain("__Host-");
    } finally {
      await app.close();
    }
  });

  it("uses non-prefixed non-Secure cookies only for HTTP loopback development", async () => {
    const auth: OperatorAuthRouteService = {
      ...createService(),
      publicOrigin: "http://127.0.0.1:8080",
      requiresLoopbackRequest: true,
      secureCookies: false,
      usesBrowserBinding: false,
      startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken, session })),
    };
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "POST",
        url: OPERATOR_LOGIN_PATH,
        headers: { host: "127.0.0.1:8080", origin: auth.publicOrigin },
      });

      expect(response.statusCode).toBe(303);
      const serialized = setCookies(response.headers["set-cookie"])[0] ?? "";
      expect(serialized).toContain(`${DEVELOPMENT_OPERATOR_SESSION_COOKIE}=${sessionToken}`);
      expect(serialized).toContain("HttpOnly");
      expect(serialized).toContain("SameSite=Lax");
      expect(serialized).not.toContain("__Host-");
      expect(serialized).not.toContain("Secure");
      expect(setCookies(response.headers["set-cookie"])).toHaveLength(1);
      expect(auth.startLogin).toHaveBeenCalledWith(undefined);

      const forwarded = await app.inject({
        method: "GET",
        url: OPERATOR_SESSION_PATH,
        headers: {
          host: "127.0.0.1:8080",
          "x-forwarded-for": "203.0.113.10",
        },
      });
      expect(forwarded.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns a sanitized callback error without clearing a newer login transaction", async () => {
    const auth = createService();
    auth.completeLogin = vi.fn(async () => {
      throw new OperatorAuthError(
        "oidc_authentication_failed",
        401,
        "The identity provider could not authenticate the operator.",
      );
    });
    const app = createApp(auth);

    try {
      const response = await app.inject({
        method: "GET",
        url: `${OPERATOR_CALLBACK_PATH}?error=access_denied&state=state-value`,
        headers: {
          cookie: `${OPERATOR_LOGIN_TRANSACTION_COOKIE}=${transactionToken}; ${OPERATOR_BROWSER_BINDING_COOKIE}=${browserBindingToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        code: "oidc_authentication_failed",
        message: "The identity provider could not authenticate the operator.",
        retryable: false,
      });
      expect(response.body).not.toContain("access_denied");
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
