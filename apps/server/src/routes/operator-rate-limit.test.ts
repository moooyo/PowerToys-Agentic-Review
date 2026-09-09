import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  readOperatorSession,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { createConfigurationAuthorization } from "./configuration-support.js";
import {
  operatorConfigurationRateLimits as limits,
  registerOperatorConfigurationRateLimits,
} from "./operator-rate-limit.js";

const publicOrigin = "https://review.example.test";
const readPath = "/api/v1/operator/observations";
const writePath = "/api/v1/operator/settings";
const firstToken = "A".repeat(43);
const rotatedFirstToken = "R".repeat(43);
const secondToken = "B".repeat(43);
const invalidToken = "X".repeat(43);
const firstPrincipal = { issuer: "https://identity.example.test", subject: "first" };
const secondPrincipal = { issuer: firstPrincipal.issuer, subject: "second" };
const applications: FastifyInstance[] = [];
const session = (principal = firstPrincipal): OperatorSession => ({
  ...principal,
  displayName: "Synthetic operator",
  email: null,
  createdAt: "2026-09-07T00:00:00.000Z",
  expiresAt: "2027-09-07T00:00:00.000Z",
});
const headers = (token = firstToken) => ({
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  origin: publicOrigin,
});

async function fixture(readOnly = false) {
  const sessions = new Map([
    [firstToken, session()],
    [rotatedFirstToken, session()],
    [secondToken, session(secondPrincipal)],
  ]);
  const getSession = vi.fn(async (token: string | undefined) =>
    token === undefined ? null : (sessions.get(token) ?? null),
  );
  const auth: OperatorAuthRouteService = {
    publicOrigin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: () => undefined,
    startLogin: async () => {
      throw new Error("Rate-limit tests never start an identity-provider flow.");
    },
    completeLogin: async () => {
      throw new Error("Rate-limit tests never complete an identity-provider flow.");
    },
    getSession,
    logout: async () => undefined,
  };
  const app = Fastify({ logger: false });
  applications.push(app);
  registerOperatorAuthRoutes(app, auth);
  const handler = vi.fn(async (request) => {
    // Multiple consumers inside one request must reuse the same verified result.
    const [first, second] = await Promise.all([
      readOperatorSession(request, auth),
      readOperatorSession(request, auth),
    ]);
    expect(first).toBe(second);
    return { principal: first?.subject };
  });
  app.register(async (scope) => {
    await registerOperatorConfigurationRateLimits(scope, auth);
    const authorization = createConfigurationAuthorization(auth, readOnly);
    scope.get(readPath, { onRequest: authorization.read }, handler);
    scope.patch(writePath, { onRequest: authorization.mutate }, handler);
  });
  await app.ready();
  return { app, auth, sessions, getSession, handler };
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("operator configuration request budgets", () => {
  it("allows normal polling bursts from two verified principals behind the same IP", async () => {
    const f = await fixture();
    // More than the old shared 120/min boundary, with both sessions using the same NAT address.
    for (let index = 0; index < 240; index++) {
      const responses = await Promise.all(
        [firstToken, secondToken].map((token) =>
          f.app.inject({
            method: "GET",
            url: readPath,
            remoteAddress: "192.0.2.1",
            headers: headers(token),
          }),
        ),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.headers["x-ratelimit-limit"]).toBe(
          String(limits.readsPerPrincipalPerMinute),
        );
      }
    }
    expect(f.getSession).toHaveBeenCalledTimes(480);
    expect(f.handler).toHaveBeenCalledTimes(480);
  });

  it("keeps mutations available after the principal exhausts its read budget", async () => {
    const f = await fixture();
    for (let index = 0; index < limits.readsPerPrincipalPerMinute; index++)
      expect(
        (await f.app.inject({ method: "GET", url: readPath, headers: headers() })).statusCode,
      ).toBe(200);
    const blocked = await f.app.inject({ method: "HEAD", url: readPath, headers: headers() });
    expect(blocked.statusCode).toBe(429);
    for (let index = 0; index < limits.mutationsPerPrincipalPerMinute; index++)
      expect(
        (await f.app.inject({ method: "PATCH", url: writePath, headers: headers(), payload: {} }))
          .statusCode,
      ).toBe(200);
    const writeBlocked = await f.app.inject({
      method: "PATCH",
      url: writePath,
      headers: headers(),
      payload: {},
    });
    expect(writeBlocked.statusCode).toBe(429);
    expect(writeBlocked.json()).toEqual({
      code: "request_rate_limited",
      message: "Too many requests were received. Retry later.",
      retryable: true,
    });
    expect(writeBlocked.headers["x-ratelimit-limit"]).toBe(
      String(limits.mutationsPerPrincipalPerMinute),
    );
    expect(writeBlocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(writeBlocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(writeBlocked.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(writeBlocked.headers["cache-control"]).toBe("private, no-store");
    expect(writeBlocked.headers.vary).toBe("Cookie");
    expect(writeBlocked.headers["referrer-policy"]).toBe("no-referrer");
    expect(
      (await f.app.inject({ method: "GET", url: readPath, headers: headers(secondToken) }))
        .statusCode,
    ).toBe(200);
  });

  it("shares the principal budget across cookies and IPs without trusting a forged identity header", async () => {
    const f = await fixture();
    for (let index = 0; index < limits.mutationsPerPrincipalPerMinute; index++)
      expect(
        (
          await f.app.inject({
            method: "PATCH",
            url: writePath,
            payload: {},
            remoteAddress: "192.0.2.1",
            headers: headers(index % 2 === 0 ? firstToken : rotatedFirstToken),
          })
        ).statusCode,
      ).toBe(200);
    const blocked = await f.app.inject({
      method: "PATCH",
      url: writePath,
      payload: {},
      remoteAddress: "192.0.2.2",
      headers: { ...headers(rotatedFirstToken), "x-operator-subject": secondPrincipal.subject },
    });
    expect(blocked.statusCode).toBe(429);
    expect(
      (await f.app.inject({ method: "GET", url: readPath, headers: headers() })).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url: writePath,
          payload: {},
          headers: headers(secondToken),
        })
      ).statusCode,
    ).toBe(200);
  });

  it("enforces the cheap IP boundary before authentication even when invalid cookies rotate", async () => {
    const f = await fixture();
    const started = Date.now();
    const time = vi.spyOn(Date, "now").mockReturnValue(started);
    for (let index = 0; index < limits.ipRequestsPerMinute; index++)
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: readPath,
            headers: headers(String(index).padStart(43, "X")),
          })
        ).statusCode,
      ).toBe(401);
    expect(f.getSession).toHaveBeenCalledTimes(limits.ipRequestsPerMinute);
    const denied = await f.app.inject({ method: "GET", url: readPath, headers: headers() });
    expect(denied.statusCode).toBe(429);
    expect(denied.headers["x-ratelimit-limit"]).toBe(String(limits.ipRequestsPerMinute));
    expect(denied.headers["retry-after"]).toBe("60");
    expect(f.getSession).toHaveBeenCalledTimes(limits.ipRequestsPerMinute);
    expect(f.handler).not.toHaveBeenCalled();
    time.mockReturnValue(started + 60_001);
    expect(
      (await f.app.inject({ method: "GET", url: readPath, headers: headers() })).statusCode,
    ).toBe(200);
    expect(f.getSession).toHaveBeenCalledTimes(limits.ipRequestsPerMinute + 1);
  });

  it("does not charge failed authentication to an actor and revalidates sessions on every request", async () => {
    const f = await fixture();
    for (let index = 0; index < 150; index++)
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: readPath,
            headers: { ...headers(invalidToken), "x-operator-subject": firstPrincipal.subject },
          })
        ).statusCode,
      ).toBe(401);
    for (let index = 0; index < limits.readsPerPrincipalPerMinute; index++)
      expect(
        (await f.app.inject({ method: "GET", url: readPath, headers: headers() })).statusCode,
      ).toBe(200);
    f.sessions.delete(firstToken);
    // This must return the current authentication result, rather than cached identity or 429.
    expect(
      (await f.app.inject({ method: "GET", url: readPath, headers: headers() })).statusCode,
    ).toBe(401);
    expect(f.getSession).toHaveBeenCalledTimes(150 + limits.readsPerPrincipalPerMinute + 1);
    f.sessions.set(firstToken, session());
    expect(
      (await f.app.inject({ method: "GET", url: readPath, headers: headers() })).statusCode,
    ).toBe(429);
  });

  it("preserves origin and maintenance guards before charging an authenticated mutation", async () => {
    const f = await fixture(true);
    const invalidOrigin = await f.app.inject({
      method: "PATCH",
      url: writePath,
      payload: {},
      headers: { ...headers(), origin: "https://other.example.test" },
    });
    expect(invalidOrigin.statusCode).toBe(403);
    expect(invalidOrigin.json().code).toBe("invalid_operator_auth_origin");
    expect(f.getSession).not.toHaveBeenCalled();
    const readOnly = await f.app.inject({
      method: "PATCH",
      url: writePath,
      payload: {},
      headers: headers(),
    });
    expect(readOnly.statusCode).toBe(503);
    expect(readOnly.json().code).toBe("configuration_read_only");
    expect(f.getSession).toHaveBeenCalledOnce();
    expect(f.handler).not.toHaveBeenCalled();
    expect(
      (await f.app.inject({ method: "GET", url: readPath, headers: headers() })).statusCode,
    ).toBe(200);
    expect(f.getSession).toHaveBeenCalledTimes(2);
  });
});
