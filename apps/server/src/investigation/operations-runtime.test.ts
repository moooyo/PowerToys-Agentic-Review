import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InvestigationPasswordStore } from "../../dist/investigation/password-store.js";
import { loadInvestigationRuntimeConfig } from "../../dist/investigation/runtime-config.js";
import { createInvestigationRuntime } from "../../dist/investigation/runtime-main.js";

const applications: FastifyInstance[] = [];
const directories: string[] = [];
const origin = "http://127.0.0.1:8000";
const host = "127.0.0.1:8000";
const password = "Synthetic operations authentication password";
const statusUrl = "/api/operations/status";

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "investigation-operations-"));
  directories.push(directory);
  const dashboard = join(directory, "dashboard");
  await mkdir(dashboard);
  await writeFile(
    join(dashboard, "index.html"),
    "<!doctype html><title>Operations fixture</title>",
  );
  const config = loadInvestigationRuntimeConfig({
    INVESTIGATION_DATABASE_PATH: join(directory, "investigation.sqlite"),
    INVESTIGATION_AUTH_DATABASE_PATH: join(directory, "authentication.sqlite"),
    INVESTIGATION_DASHBOARD_DIRECTORY: dashboard,
    INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
    INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: password,
  });
  const accounts = new InvestigationPasswordStore(config.authDatabasePath);
  try {
    const admin = await accounts.initializeBootstrap({ username: "fixture-admin", password });
    if (admin === null) throw new Error("The isolated fixture must initialize its administrator.");
    await accounts.createAccount(admin, {
      username: "fixture-operator",
      password,
      repositoryIds: ["unrelated-repository"],
      permissions: ["repository:manage", "task:create", "action:execute"],
      isAdmin: false,
    });
    await accounts.createAccount(admin, { username: "second-admin", password, isAdmin: true });
  } finally {
    accounts.close();
  }
  const workerToken = "W".repeat(43);
  const app = await createInvestigationRuntime(
    { ...config, workers: [{ id: "worker", repositoryIds: [], token: workerToken }] },
    { logger: false },
  );
  applications.push(app);
  const login = async (username: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host, origin },
      payload: { username, password },
    });
    expect(response.statusCode).toBe(200);
    return response.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
  };
  return { app, config, directory, workerToken, login };
}

describe("production operations authorization", () => {
  it("requires a current administrator session and does not disclose filesystem paths", async () => {
    const f = await fixture();
    for (const headers of [{ host }, { host, authorization: `Bearer ${f.workerToken}` }]) {
      const denied = await f.app.inject({ method: "GET", url: statusUrl, headers });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers["cache-control"]).toBe("no-store");
      expect(denied.body).not.toContain("storage");
    }
    const operatorCookie = await f.login("fixture-operator");
    const operator = await f.app.inject({
      method: "GET",
      url: statusUrl,
      headers: { host, cookie: operatorCookie },
    });
    expect(operator.statusCode).toBe(403);
    expect(operator.body).not.toContain("storage");

    const cookie = await f.login("fixture-admin");
    const status = await f.app.inject({ method: "GET", url: statusUrl, headers: { host, cookie } });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json()).toMatchObject({
      schemaVersion: "InvestigationOperationsStatusV1",
      tasks: { total: 0 },
      storage: {
        investigation: { files: { database: { status: "present" } } },
        authentication: { files: { database: { status: "present" } } },
      },
    });
    expect(status.body).not.toContain(f.directory);
    expect(status.body).not.toContain("fixture-admin");
    expect(status.body).not.toContain(f.workerToken);

    const accounts = new InvestigationPasswordStore(f.config.authDatabasePath);
    try {
      const admin = accounts.listAccounts().find((entry) => entry.username === "fixture-admin");
      const second = accounts.listAccounts().find((entry) => entry.username === "second-admin");
      if (admin === undefined || second === undefined) throw new Error("Missing fixture account.");
      accounts.updateAccount(second, admin.id, admin.version, { isAdmin: false });
    } finally {
      accounts.close();
    }
    const revoked = await f.app.inject({
      method: "GET",
      url: statusUrl,
      headers: { host, cookie },
    });
    expect(revoked.statusCode).toBe(401);
    const demotedCookie = await f.login("fixture-admin");
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: statusUrl,
          headers: { host, cookie: demotedCookie },
        })
      ).statusCode,
    ).toBe(403);
  });
});
