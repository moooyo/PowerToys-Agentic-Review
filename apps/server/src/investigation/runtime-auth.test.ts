import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvestigationAuthPersistence,
  InvestigationRuntimeAuth,
} from "../../dist/investigation/runtime-auth.js";
import {
  type InvestigationRuntimeConfig,
  loadInvestigationRuntimeConfig,
} from "../../dist/investigation/runtime-config.js";
import type { OperatorOidcClient } from "../../dist/security/operator-auth.js";

const applications: FastifyInstance[] = [];
const persistences: InvestigationAuthPersistence[] = [];
const directories: string[] = [];
const origin = "http://127.0.0.1:8000";
const operator = {
  id: "operator-1",
  subject: "subject-1",
  displayName: "Operator One",
  repositoryIds: ["repo-1"],
  permissions: ["task:create", "action:prepare"],
  actionCapabilities: ["comment"],
  allowRepositoryExecution: true,
};
const worker = { id: "worker-1", token: "W".repeat(43), repositoryIds: ["repo-1"] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const persistence of persistences.splice(0)) persistence.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function config(environment: Record<string, string> = {}): InvestigationRuntimeConfig {
  return {
    ...loadInvestigationRuntimeConfig({
      INVESTIGATION_OPERATORS_JSON: JSON.stringify([operator]),
      INVESTIGATION_WORKERS_JSON: JSON.stringify([worker]),
      ...environment,
    }),
    authDatabasePath: ":memory:",
  };
}

function cookieHeader(response: { cookies: { name: string; value: string }[] }): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function application(configuration = config(), oidc?: OperatorOidcClient) {
  const app = Fastify();
  const auth = new InvestigationRuntimeAuth(configuration, oidc);
  auth.registerRoutes(app);
  app.addHook("onClose", async () => auth.close());
  app.route({
    method: ["GET", "POST"],
    url: "/protected",
    handler: async (request, reply) => {
      const principal = await auth.authenticateOperator(request);
      return principal === null ? reply.code(401).send() : principal;
    },
  });
  app.post("/worker", async (request, reply) => {
    const principal = auth.authenticateWorker(request);
    return principal === null ? reply.code(401).send() : principal;
  });
  applications.push(app);
  await app.ready();
  return app;
}

describe("investigation browser and worker authentication", () => {
  it("issues a scoped HttpOnly session and revokes it on logout", async () => {
    const app = await application();
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { host: "127.0.0.1:8000" },
    });
    expect(anonymous.json()).toMatchObject({
      authenticated: false,
      user: null,
      authMode: "loopback",
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "127.0.0.1:8000", origin },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      authenticated: true,
      user: {
        id: operator.id,
        displayName: operator.displayName,
        repositoryIds: operator.repositoryIds,
        permissions: operator.permissions,
        actionCapabilities: operator.actionCapabilities,
        allowRepositoryExecution: true,
        email: null,
      },
    });
    expect(String(login.headers["set-cookie"])).toContain("HttpOnly; SameSite=Lax");
    const cookie = cookieHeader(login);
    const authenticated = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { host: "127.0.0.1:8000", cookie },
    });
    expect(authenticated.json()).toMatchObject({
      id: "operator-1",
      repositoryIds: ["repo-1"],
      permissions: operator.permissions,
      actionCapabilities: ["comment"],
    });
    expect(authenticated.json()).not.toHaveProperty("subject");
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { host: "127.0.0.1:8000", origin, cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/protected",
          headers: { host: "127.0.0.1:8000", cookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("rejects cross-origin login, forged forwarding, remote addresses, and missing mutation origins", async () => {
    const app = await application();
    for (const headers of [
      { host: "127.0.0.1:8000", origin: "https://attacker.example" },
      { host: "attacker.example", origin },
      { host: "127.0.0.1:8000", origin, "x-forwarded-for": "127.0.0.1" },
    ]) {
      expect(
        (await app.inject({ method: "POST", url: "/api/auth/login", headers })).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "192.0.2.1",
          headers: { host: "127.0.0.1:8000", origin },
        })
      ).statusCode,
    ).toBe(403);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "127.0.0.1:8000", origin },
    });
    const cookie = cookieHeader(login);
    for (const extra of [
      {},
      { origin: "https://attacker.example" },
      { origin, "sec-fetch-site": "cross-site" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/protected",
            headers: { host: "127.0.0.1:8000", cookie, ...extra },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/protected",
          headers: { host: "127.0.0.1:8000", origin, cookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("accepts only configured worker bearer credentials and ignores claimed identities", async () => {
    const app = await application();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/worker",
          payload: { id: "worker-1", repositoryIds: ["repo-1"] },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/worker",
          headers: { authorization: `Bearer ${"X".repeat(43)}` },
        })
      ).statusCode,
    ).toBe(401);
    const authorized = await app.inject({
      method: "POST",
      url: "/worker",
      headers: { authorization: `Bearer ${worker.token}` },
      payload: { id: "forged-worker", repositoryIds: ["repo-2"] },
    });
    expect(authorized.json()).toEqual({ id: "worker-1", repositoryIds: ["repo-1"] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/protected",
          headers: { host: "127.0.0.1:8000", authorization: `Bearer ${worker.token}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("binds OIDC authorization to the browser and consumes each transaction once", async () => {
    const issuer = "https://identity.example";
    const app = await application(
      config({
        INVESTIGATION_AUTH_MODE: "oidc",
        INVESTIGATION_PUBLIC_ORIGIN: "https://review.example",
        INVESTIGATION_OIDC_ISSUER_URL: issuer,
        INVESTIGATION_OIDC_CLIENT_ID: "client-1",
        INVESTIGATION_OIDC_CLIENT_SECRET: "fake-client-secret",
      }),
      {
        issuer,
        async buildAuthorizationUrl(input) {
          return new URL(`https://identity.example/authorize?state=${input.state}`);
        },
        async exchangeAuthorizationCode() {
          return { issuer, subject: "subject-1", displayName: "OIDC Operator", email: null };
        },
      },
    );
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "review.example", origin: "https://review.example" },
    });
    expect(start.json().authenticated).toBe(false);
    expect(start.cookies).toHaveLength(2);
    expect(new Set(start.cookies.map((entry) => entry.name)).size).toBe(2);
    const state = new URL(start.json().authorizationUrl).searchParams.get("state");
    const callback = `/api/auth/callback?state=${state}&code=mock-code`;
    expect(
      (await app.inject({ method: "GET", url: callback, headers: { host: "review.example" } }))
        .statusCode,
    ).toBe(401);
    const completed = await app.inject({
      method: "GET",
      url: callback,
      headers: { host: "review.example", cookie: cookieHeader(start) },
    });
    expect(completed.statusCode, completed.body).toBe(303);
    expect(String(completed.headers["set-cookie"])).toContain("Secure");
    expect(
      (
        await app.inject({
          method: "GET",
          url: callback,
          headers: { host: "review.example", cookie: cookieHeader(start) },
        })
      ).statusCode,
    ).toBe(401);
    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { host: "review.example", cookie: cookieHeader(completed) },
    });
    expect(session.json()).toMatchObject({
      authenticated: true,
      user: { id: "operator-1", displayName: "OIDC Operator" },
    });
  });
});

describe("independent authentication persistence", () => {
  it("persists hashed sessions across restart and refuses an incompatible existing database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "investigation-auth-"));
    directories.push(directory);
    const path = join(directory, "auth.sqlite");
    const first = new InvestigationAuthPersistence(path);
    persistences.push(first);
    const session = {
      issuer: "urn:test",
      subject: "operator",
      displayName: null,
      email: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await first.createSession({
      ...session,
      tokenSha256: hash("private-session"),
      browserSha256: null,
      browserGeneration: null,
    });
    first.close();
    const second = new InvestigationAuthPersistence(path);
    persistences.push(second);
    expect(
      await second.findSession({ tokenSha256: hash("private-session"), browserSha256: null }),
    ).toMatchObject({ issuer: "urn:test", subject: "operator" });
    await second.deleteSession({ tokenSha256: hash("private-session") });
    expect(
      await second.findSession({ tokenSha256: hash("private-session"), browserSha256: null }),
    ).toBeNull();
    second.close();
    const unrelated = join(directory, "unrelated.sqlite");
    const raw = new DatabaseSync(unrelated);
    raw.exec("CREATE TABLE unrelated (id TEXT)");
    raw.close();
    expect(() => new InvestigationAuthPersistence(unrelated)).toThrow("incompatible schema");
  });

  it("rejects a claimed login after a newer login or logout revokes its browser generation", async () => {
    const persistence = new InvestigationAuthPersistence(":memory:");
    persistences.push(persistence);
    const browserSha256 = hash("browser");
    const transactionTokenSha256 = hash("transaction-1");
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = await persistence.beginLogin({
      browserSha256,
      transactionTokenSha256,
      transactionExpiresAt: expiresAt,
      browserExpiresAt: expiresAt,
    });
    expect(await persistence.claimLoginTransaction({ browserSha256, transactionTokenSha256 })).toBe(
      first.browserGeneration,
    );
    expect(
      await persistence.claimLoginTransaction({ browserSha256, transactionTokenSha256 }),
    ).toBeNull();
    await persistence.beginLogin({
      browserSha256,
      transactionTokenSha256: hash("transaction-2"),
      transactionExpiresAt: expiresAt,
      browserExpiresAt: expiresAt,
    });
    expect(
      await persistence.finalizeLogin({
        browserSha256,
        transactionTokenSha256,
        browserGeneration: first.browserGeneration,
        sessionTokenSha256: hash("stale-session"),
        issuer: "urn:test",
        subject: "operator",
        displayName: null,
        email: null,
        createdAt: new Date().toISOString(),
        expiresAt,
      }),
    ).toBe(false);
    await persistence.deleteBrowserFlow({ browserSha256 });
    expect(
      await persistence.claimLoginTransaction({
        browserSha256,
        transactionTokenSha256: hash("transaction-2"),
      }),
    ).toBeNull();
  });
});
