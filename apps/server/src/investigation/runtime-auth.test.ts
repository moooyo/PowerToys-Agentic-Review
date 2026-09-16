import type {
  InvestigationAccount,
  InvestigationCreateAccountRequest,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InvestigationRuntimeAuth } from "../../dist/investigation/runtime-auth.js";
import { loadInvestigationRuntimeConfig } from "../../dist/investigation/runtime-config.js";

const applications: FastifyInstance[] = [];
const origin = "http://127.0.0.1:8000";
const host = "127.0.0.1:8000";
const adminPassword = "Synthetic administrator password";
const userPassword = "Synthetic regular user password";
const newPassword = "  Synthetic replacement password  ";
const workerToken = "W".repeat(43);

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
});

async function application(environment: Record<string, string> = {}, logs?: string[]) {
  const config = {
    ...loadInvestigationRuntimeConfig({
      INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
      INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      INVESTIGATION_LOGIN_ACCOUNT_LIMIT: "100",
      INVESTIGATION_LOGIN_IP_LIMIT: "100",
      INVESTIGATION_WORKERS_JSON: JSON.stringify([
        { id: "worker-1", token: workerToken, repositoryIds: ["repo-1"] },
      ]),
      ...environment,
    }),
    authDatabasePath: ":memory:",
  };
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    logger:
      logs === undefined
        ? false
        : {
            level: "trace",
            stream: {
              write(value: string) {
                logs.push(value);
              },
            },
          },
  });
  const auth = new InvestigationRuntimeAuth(config);
  await auth.initialize();
  auth.registerRoutes(app);
  app.addHook("onClose", async () => auth.close());
  app.route({
    method: ["GET", "POST"],
    url: "/protected",
    handler: async (request, reply) => {
      const principal = auth.authenticateOperator(request);
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

function cookies(response: { cookies: { name: string; value: string }[] }): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
function post(app: FastifyInstance, url: string, payload: unknown, cookie = "") {
  return app.inject({ method: "POST", url, payload, headers: { host, origin, cookie } });
}
async function login(app: FastifyInstance, username = "fixture-admin", password = adminPassword) {
  const response = await post(app, "/api/auth/login", { username, password });
  expect(response.statusCode, response.body).toBe(200);
  return cookies(response);
}
function accountInput(
  overrides: Partial<InvestigationCreateAccountRequest> = {},
): InvestigationCreateAccountRequest {
  return {
    username: "fixture-user",
    password: userPassword,
    displayName: "Fixture User",
    isAdmin: false,
    repositoryIds: ["repo-1"],
    permissions: ["task:create"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
    ...overrides,
  };
}
function updateInput(account: InvestigationAccount, overrides: Partial<InvestigationAccount> = {}) {
  const value = { ...account, ...overrides };
  return {
    version: value.version,
    displayName: value.displayName,
    enabled: value.enabled,
    isAdmin: value.isAdmin,
    repositoryIds: value.repositoryIds,
    permissions: value.permissions,
    actionCapabilities: value.actionCapabilities,
    allowRepositoryExecution: value.allowRepositoryExecution,
  };
}

describe("password-only browser authentication", () => {
  it("requires credentials and exposes neither an OIDC callback nor a loopback login bypass", async () => {
    const app = await application();
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { host },
    });
    expect(anonymous.json()).toEqual({
      authenticated: false,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: null,
    });
    expect((await post(app, "/api/auth/login", {})).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/auth/callback", headers: { host } }))
        .statusCode,
    ).toBe(404);
    const signedIn = await post(app, "/api/auth/login", {
      username: "  FIXTURE-ADMIN  ",
      password: adminPassword,
    });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toMatchObject({
      authenticated: true,
      authMode: "password",
      user: {
        username: "fixture-admin",
        isAdmin: true,
        email: null,
        repositoryIds: [],
        permissions: [],
        actionCapabilities: [],
        allowRepositoryExecution: false,
      },
    });
    expect(signedIn.json()).not.toHaveProperty("authorizationUrl");
    expect(String(signedIn.headers["set-cookie"])).toContain("HttpOnly; SameSite=Strict");
    const cookie = cookies(signedIn);
    expect(
      (await app.inject({ method: "GET", url: "/protected", headers: { host, cookie } }))
        .statusCode,
    ).toBe(200);
    expect((await post(app, "/api/auth/logout", undefined, cookie)).statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/protected", headers: { host, cookie } }))
        .statusCode,
    ).toBe(401);
  }, 20000);

  it("uses the same failure response for a missing account, wrong password, and disabled account", async () => {
    const app = await application();
    const admin = await login(app);
    const created = await post(app, "/api/accounts", accountInput(), admin);
    expect(created.statusCode).toBe(201);
    const account = created.json<InvestigationAccount>();
    expect(
      (
        await post(
          app,
          `/api/accounts/${account.id}/update`,
          updateInput(account, { enabled: false }),
          admin,
        )
      ).statusCode,
    ).toBe(200);
    const missing = await post(app, "/api/auth/login", {
      username: "missing-user",
      password: userPassword,
    });
    const wrong = await post(app, "/api/auth/login", {
      username: "fixture-admin",
      password: userPassword,
    });
    const disabled = await post(app, "/api/auth/login", {
      username: "fixture-user",
      password: userPassword,
    });
    for (const response of [missing, wrong, disabled]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(missing.json());
    }
  }, 20000);

  it("enforces Host, Origin, real loopback HTTP, and Secure cookies for an HTTPS origin", async () => {
    const app = await application();
    for (const headers of [
      { host, origin: "https://attacker.example" },
      { host: "attacker.example", origin },
      { host, origin, "x-forwarded-for": "127.0.0.1" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            headers,
            payload: { username: "fixture-admin", password: adminPassword },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "192.0.2.1",
          headers: { host, origin },
          payload: { username: "fixture-admin", password: adminPassword },
        })
      ).statusCode,
    ).toBe(403);
    const cookie = await login(app);
    expect(
      (await app.inject({ method: "POST", url: "/protected", headers: { host, cookie } }))
        .statusCode,
    ).toBe(401);
    const secure = await application({ INVESTIGATION_PUBLIC_ORIGIN: "https://review.example" });
    const response = await secure.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "review.example", origin: "https://review.example" },
      payload: { username: "fixture-admin", password: adminPassword },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toContain("__Host-investigation_session=");
    expect(String(response.headers["set-cookie"])).toContain("; Secure");
  }, 20000);

  it("keeps bearer workers isolated from accounts and never trusts a claimed identity", async () => {
    const app = await application();
    expect(
      (await app.inject({ method: "POST", url: "/worker", payload: { id: "worker-1" } }))
        .statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: "POST",
      url: "/worker",
      headers: { authorization: `Bearer ${workerToken}` },
      payload: { id: "other-worker", repositoryIds: ["repo-2"] },
    });
    expect(response.json()).toEqual({ id: "worker-1", repositoryIds: ["repo-1"] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/accounts",
          headers: { host, authorization: `Bearer ${workerToken}` },
        })
      ).statusCode,
    ).toBe(401);
    const admin = await login(app);
    expect(
      (await app.inject({ method: "POST", url: "/worker", headers: { cookie: admin } })).statusCode,
    ).toBe(401);
  }, 20000);

  it("rate limits IPs, normalized accounts, and authenticated password guessing", async () => {
    const app = await application({ INVESTIGATION_LOGIN_IP_LIMIT: "2" });
    for (const username of ["missing-one", "missing-two"])
      expect(
        (await post(app, "/api/auth/login", { username, password: userPassword })).statusCode,
      ).toBe(401);
    expect(
      (await post(app, "/api/auth/login", { username: "missing-three", password: userPassword }))
        .statusCode,
    ).toBe(429);
    const accountLimited = await application({ INVESTIGATION_LOGIN_ACCOUNT_LIMIT: "2" });
    const admin = await login(accountLimited);
    expect(
      (
        await post(
          accountLimited,
          "/api/auth/password",
          { currentPassword: userPassword, newPassword },
          admin,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post(
          accountLimited,
          "/api/auth/password",
          { currentPassword: userPassword, newPassword },
          admin,
        )
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await post(accountLimited, "/api/auth/login", {
          username: "  FIXTURE-ADMIN ",
          password: adminPassword,
        })
      ).statusCode,
    ).toBe(429);
  }, 20000);

  it("changes the exact password and revokes every existing session", async () => {
    const app = await application();
    const first = await login(app);
    const second = await login(app);
    expect(
      (
        await post(
          app,
          "/api/auth/password",
          { currentPassword: adminPassword, newPassword },
          first,
        )
      ).statusCode,
    ).toBe(204);
    for (const cookie of [first, second])
      expect(
        (await app.inject({ method: "GET", url: "/protected", headers: { host, cookie } }))
          .statusCode,
      ).toBe(401);
    expect(
      (await post(app, "/api/auth/login", { username: "fixture-admin", password: adminPassword }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await post(app, "/api/auth/login", {
          username: "fixture-admin",
          password: newPassword.trim(),
        })
      ).statusCode,
    ).toBe(401);
    await login(app, "fixture-admin", newPassword);
  }, 20000);
});

describe("administrator account management", () => {
  it("creates canonical accounts, applies explicit permissions, uses CAS, and revokes changed access", async () => {
    const app = await application();
    const admin = await login(app);
    const created = await post(
      app,
      "/api/accounts",
      accountInput({ username: "  CASE.User  " }),
      admin,
    );
    expect(created.statusCode).toBe(201);
    const account = created.json<InvestigationAccount>();
    expect(account).toMatchObject({
      username: "case.user",
      isAdmin: false,
      enabled: true,
      version: 1,
      repositoryIds: ["repo-1"],
    });
    expect(created.body).not.toMatch(/password_hash|\$scrypt\$/u);
    expect(
      (await post(app, "/api/accounts", accountInput({ username: "CASE.USER" }), admin)).statusCode,
    ).toBe(409);
    const user = await login(app, "case.user", userPassword);
    expect(
      (await app.inject({ method: "GET", url: "/api/accounts", headers: { host, cookie: user } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(app, "/api/accounts", accountInput({ username: "another-user" }), user))
        .statusCode,
    ).toBe(403);
    const updated = await post(
      app,
      `/api/accounts/${account.id}/update`,
      updateInput(account, { repositoryIds: ["repo-2"] }),
      admin,
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ version: 2, repositoryIds: ["repo-2"] });
    expect(
      (await app.inject({ method: "GET", url: "/protected", headers: { host, cookie: user } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(app, `/api/accounts/${account.id}/update`, updateInput(account), admin))
        .statusCode,
    ).toBe(409);
    const renewed = await login(app, "case.user", userPassword);
    expect(
      (
        await app.inject({ method: "GET", url: "/protected", headers: { host, cookie: renewed } })
      ).json(),
    ).toMatchObject({ repositoryIds: ["repo-2"], permissions: ["task:create"], isAdmin: false });
    const reset = await post(
      app,
      `/api/accounts/${account.id}/password`,
      { version: 2, newPassword },
      admin,
    );
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ version: 3 });
    expect(
      (await app.inject({ method: "GET", url: "/protected", headers: { host, cookie: renewed } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(app, "/api/auth/login", { username: "case.user", password: userPassword }))
        .statusCode,
    ).toBe(401);
    await login(app, "case.user", newPassword);
  }, 20000);

  it("protects the final enabled administrator and hides password material from logs and DTOs", async () => {
    const logs: string[] = [];
    const app = await application({}, logs);
    const admin = await login(app);
    const accounts = await app.inject({
      method: "GET",
      url: "/api/accounts",
      headers: { host, cookie: admin },
    });
    const account = accounts.json<{ items: InvestigationAccount[] }>().items[0]!;
    const demote = await post(
      app,
      `/api/accounts/${account.id}/update`,
      updateInput(account, { isAdmin: false }),
      admin,
    );
    expect(demote.statusCode).toBe(409);
    expect(demote.json().code).toBe("last_admin");
    expect(
      (
        await post(
          app,
          `/api/accounts/${account.id}/update`,
          updateInput(account, { enabled: false }),
          admin,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { host, cookie: admin },
        })
      ).json().authenticated,
    ).toBe(true);
    expect(accounts.body).not.toMatch(/password|scrypt|token_sha256/iu);
    expect(logs.join("")).not.toContain(adminPassword);
    expect(logs.join("")).not.toContain("$scrypt$");
  }, 20000);
});
