import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadInvestigationRuntimeConfig } from "../../dist/investigation/runtime-config.js";
import { createInvestigationRuntime } from "../../dist/investigation/runtime-main.js";

const applications: FastifyInstance[] = [];
const directories: string[] = [];
const origin = "http://127.0.0.1:8000";
const host = "127.0.0.1:8000";

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "investigation-runtime-"));
  directories.push(directory);
  const dashboard = join(directory, "dashboard");
  await mkdir(dashboard);
  await writeFile(
    join(dashboard, "index.html"),
    "<!doctype html><title>Investigation Dashboard</title>",
  );
  const config = loadInvestigationRuntimeConfig({
    INVESTIGATION_DATABASE_PATH: join(directory, "investigation.sqlite"),
    INVESTIGATION_AUTH_DATABASE_PATH: join(directory, "auth.sqlite"),
    INVESTIGATION_DASHBOARD_DIRECTORY: dashboard,
    INVESTIGATION_OPERATORS_JSON: JSON.stringify([
      {
        id: "operator-1",
        subject: "operator-1",
        displayName: "Test Operator",
        repositoryIds: ["repo-1"],
        permissions: ["repository:manage"],
        actionCapabilities: [],
        allowRepositoryExecution: false,
      },
    ]),
  });
  return config;
}

describe("production investigation runtime assembly", () => {
  it("serves the new dashboard and API with persistent scoped authentication across restart", async () => {
    const config = await fixture();
    const first = await createInvestigationRuntime(config, { logger: false });
    applications.push(first);
    const dashboard = await first.inject({
      method: "GET",
      url: "/pull-requests",
      headers: { accept: "text/html" },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("Investigation Dashboard");
    expect(dashboard.headers["cache-control"]).toBe("no-store");
    expect(
      (await first.inject({ method: "GET", url: "/api/repositories", headers: { host } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await first.inject({
          method: "GET",
          url: "/api/v1/repositories",
          headers: { accept: "text/html" },
        })
      ).statusCode,
    ).toBe(404);
    const login = await first.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host, origin },
      payload: {},
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const repository = { id: "repo-1", githubRepositoryId: 123, fullName: "fixture/repository" };
    const register = await first.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { host, origin, cookie },
      payload: repository,
    });
    expect(register.statusCode).toBe(201);
    const forbidden = await first.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { host, origin, cookie },
      payload: { ...repository, id: "repo-2", githubRepositoryId: 456, fullName: "fixture/other" },
    });
    expect(forbidden.statusCode).toBe(403);
    const crossOrigin = await first.inject({
      method: "POST",
      url: "/api/repositories",
      headers: { host, origin: "https://attacker.example", cookie },
      payload: repository,
    });
    expect(crossOrigin.statusCode).toBe(401);
    await first.close();
    const second = await createInvestigationRuntime(config, { logger: false });
    applications.push(second);
    const stored = await second.inject({
      method: "GET",
      url: "/api/repositories",
      headers: { host, cookie },
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual({ items: [repository] });
    const logout = await second.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { host, origin, cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(
      (await second.inject({ method: "GET", url: "/api/repositories", headers: { host, cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it("does not start a partially configured service without its dashboard bundle", async () => {
    const config = await fixture();
    await expect(
      createInvestigationRuntime(
        { ...config, dashboardDirectory: join(config.dashboardDirectory, "missing") },
        { logger: false },
      ),
    ).rejects.toThrow("dashboard bundle is missing");
  });

  it("refuses to serve a directory containing private database files", async () => {
    const config = await fixture();
    await expect(
      createInvestigationRuntime(
        { ...config, authDatabasePath: join(config.dashboardDirectory, "auth.sqlite") },
        { logger: false },
      ),
    ).rejects.toThrow("outside the dashboard static directory");
  });

  it("connects authenticated read-only import to the worker's complete frozen Issue input", async () => {
    const config = await fixture();
    const configuredOperator = config.operators[0]!;
    const workerToken = "Q".repeat(43);
    const upstream = {
      number: 7,
      title: "Imported Issue",
      body: "Complete Issue body",
      comments: 1,
      state: "open",
      updated_at: "2026-09-15T10:00:00.000Z",
    };
    const calls: string[] = [];
    const app = await createInvestigationRuntime(
      {
        ...config,
        github: { token: "synthetic-read-token", expectedGitHubUserId: 55 },
        operators: [{ ...configuredOperator, permissions: ["repository:manage", "task:create"] }],
        workers: [{ id: "worker-1", token: workerToken, repositoryIds: ["repo-1"] }],
      },
      {
        logger: false,
        actionTransport: {
          supportedActions: [],
          async readTarget(_repository, item) {
            return {
              kind: item.kind,
              state: item.state,
              headSha: null,
              revisionKey: item.subject.revisionKey,
            };
          },
          async execute() {
            throw new Error("External writes are not part of this runtime import test.");
          },
          async reconcile() {
            throw new Error("External writes are not part of this runtime import test.");
          },
        },
        sourceImportFetch: async (input, init) => {
          expect(init?.method).toBe("GET");
          const url = new URL(String(input));
          expect(url.origin).toBe("https://api.github.com");
          calls.push(url.pathname);
          if (url.pathname === "/user") return Response.json({ id: 55 });
          if (url.pathname === "/repos/fixture/repository")
            return Response.json({ id: 123, full_name: "fixture/repository" });
          if (url.pathname === "/repos/fixture/repository/issues/7") return Response.json(upstream);
          if (url.pathname === "/repos/fixture/repository/issues/7/comments")
            return Response.json([{ id: 91, body: "Complete imported comment" }]);
          throw new Error("Unexpected mocked GitHub source request.");
        },
      },
    );
    applications.push(app);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host, origin },
      payload: {},
    });
    const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const headers = { host, origin, cookie };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/repositories",
          headers,
          payload: { id: "repo-1", githubRepositoryId: 123, fullName: "fixture/repository" },
        })
      ).statusCode,
    ).toBe(201);
    const imported = await app.inject({
      method: "POST",
      url: "/api/repositories/repo-1/import-work-item",
      headers,
      payload: { kind: "issue", number: 7 },
    });
    expect(imported.statusCode).toBe(201);
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers,
      payload: {
        kind: "issue-investigate",
        workItemId: imported.json().workItem.id,
        idempotencyKey: "imported-issue-task",
      },
    });
    expect(created.statusCode).toBe(201);
    const claim = await app.inject({
      method: "POST",
      url: "/api/worker/claims",
      headers: { authorization: `Bearer ${workerToken}` },
      payload: { supportedKinds: ["issue-investigate"] },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().claim.inputSnapshot).toMatchObject({
      title: upstream.title,
      body: upstream.body,
      comments: [{ id: "issue-comment:91", body: "Complete imported comment" }],
      source: null,
    });
    expect(calls).toHaveLength(5);
  });
});
