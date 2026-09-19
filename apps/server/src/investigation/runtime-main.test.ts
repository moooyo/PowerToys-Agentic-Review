import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInvestigationPreview } from "@agentic-review/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InvestigationPasswordStore } from "../../dist/investigation/password-store.js";
import { loadInvestigationRuntimeConfig } from "../../dist/investigation/runtime-config.js";
import { createInvestigationRuntime } from "../../dist/investigation/runtime-main.js";
import { InvestigationStore } from "../../dist/investigation/store.js";

const applications: FastifyInstance[] = [];
const directories: string[] = [];
const origin = "http://127.0.0.1:8000";
const host = "127.0.0.1:8000";
const password = "Synthetic runtime administrator password";

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(seedAccount = true) {
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
    INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
    INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: password,
  });
  if (seedAccount) {
    const accounts = new InvestigationPasswordStore(config.authDatabasePath);
    try {
      await accounts.initializeBootstrap({
        username: "fixture-admin",
        password,
        displayName: "Test Operator",
        repositoryIds: ["repo-1"],
        permissions: ["repository:manage", "task:create"],
      });
    } finally {
      accounts.close();
    }
  }
  return config;
}

describe("production investigation runtime assembly", () => {
  it("initializes configured worker controls as static-only and retains administrator grants across restart", async () => {
    const configured = await fixture();
    const workerToken = "W".repeat(43);
    const config = {
      ...configured,
      workers: [{ id: "worker-controls-runtime", token: workerToken, repositoryIds: ["repo-1"] }],
    };
    const first = await createInvestigationRuntime(config, { logger: false });
    applications.push(first);
    const login = await first.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host, origin },
      payload: { username: "fixture-admin", password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const headers = { host, origin, cookie };
    const initial = await first.inject({ method: "GET", url: "/api/workers", headers });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      items: [
        {
          id: "worker-controls-runtime",
          version: 1,
          e2eEnabled: false,
          lastSeenAt: null,
          advertisedKinds: null,
          status: "static_only",
        },
      ],
    });
    const policyRequest = {
      method: "POST" as const,
      url: "/api/worker/policy",
      headers: { authorization: `Bearer ${workerToken}` },
      payload: { supportedKinds: ["pr-review", "pr-e2e"] },
    };
    const staticPolicy = await first.inject(policyRequest);
    expect(staticPolicy.statusCode, staticPolicy.body).toBe(200);
    expect(staticPolicy.json()).toMatchObject({ e2eEnabled: false, effectiveKinds: ["pr-review"] });
    const enabled = await first.inject({
      method: "POST",
      url: "/api/workers/worker-controls-runtime/e2e",
      headers,
      payload: { version: 1, e2eEnabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ e2eEnabled: true, version: 2 });
    await first.close();
    const second = await createInvestigationRuntime(config, { logger: false });
    applications.push(second);
    const retainedPolicy = await second.inject(policyRequest);
    expect(retainedPolicy.statusCode, retainedPolicy.body).toBe(200);
    expect(retainedPolicy.json()).toMatchObject({
      e2eEnabled: true,
      version: 2,
      effectiveKinds: ["pr-review", "pr-e2e"],
    });
    const disabled = await second.inject({
      method: "POST",
      url: "/api/workers/worker-controls-runtime/e2e",
      headers,
      payload: { version: 2, e2eEnabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect((await second.inject(policyRequest)).json()).toMatchObject({
      e2eEnabled: false,
      version: 3,
      effectiveKinds: ["pr-review"],
    });
  });

  it("exposes scoped E2E media status without triggering an upload from a Dashboard read", async () => {
    const config = await fixture();
    const { result } = createInvestigationPreview("pr", { findingCount: 0 });
    result.context.repository.id = "repo-1";
    result.context.task.kind = "pr-e2e";
    const store = new InvestigationStore(config.databasePath);
    try {
      store.insert("reports", result.report.id, result);
    } finally {
      store.close();
    }
    let uploads = 0;
    const app = await createInvestigationRuntime(config, {
      logger: false,
      mediaUploadFetch: async () => {
        uploads += 1;
        throw new Error("A status read must not upload media.");
      },
    });
    applications.push(app);
    const url = `/api/reports/${result.report.id}/media-publication`;
    expect((await app.inject({ method: "GET", url, headers: { host } })).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host, origin },
      payload: { username: "fixture-admin", password },
    });
    const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const status = await app.inject({ method: "GET", url, headers: { host, cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json()).toMatchObject({
      reportId: result.report.id,
      state: "blocked",
      blockers: ["media_manifest_missing"],
      uploads: [],
    });
    expect(uploads).toBe(0);
  });

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
      payload: { username: "fixture-admin", password },
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
          if (url.pathname === "/user")
            return Response.json({ id: 55, login: "synthetic-publisher" });
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
      payload: { username: "fixture-admin", password },
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

  it("refuses to start an empty account database without explicit bootstrap credentials", async () => {
    const config = await fixture(false);
    await expect(
      createInvestigationRuntime(
        { ...config, auth: { ...config.auth, bootstrapAdmin: undefined } },
        { logger: false },
      ),
    ).rejects.toMatchObject({ code: "bootstrap_required" });
  });
});
