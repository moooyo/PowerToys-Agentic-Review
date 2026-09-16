import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvestigationTaskV1 } from "@agentic-review/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationPasswordStore } from "../../dist/investigation/password-store.js";
import {
  type InvestigationRuntimeConfig,
  loadInvestigationRuntimeConfig,
} from "../../dist/investigation/runtime-config.js";
import { createInvestigationRuntime } from "../../dist/investigation/runtime-main.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationActionTransport } from "../../dist/investigation/types.js";
import type { InvestigationWebhookReceipt } from "../../dist/investigation/webhook-intake.js";

const applications = new Set<FastifyInstance>();
const directories: string[] = [];
const origin = "http://127.0.0.1:8000";
const host = "127.0.0.1:8000";
const password = "Synthetic webhook runtime administrator password";
const secret = "Synthetic webhook runtime secret without live use";
const workerToken = "W".repeat(43);
const repository = { id: "repo-1", githubRepositoryId: 123, fullName: "fixture/webhook-runtime" };
const settingsUrl = `/api/repositories/${repository.id}/webhook-settings`;
const enabledSettings = {
  version: 0,
  enabled: true,
  reviewerUserId: 55,
  allowedActorUserIds: [44],
};

afterEach(async () => {
  for (const app of applications) await app.close();
  applications.clear();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function closeRuntime(app: FastifyInstance) {
  applications.delete(app);
  await app.close();
}

function stored<T>(config: InvestigationRuntimeConfig, read: (store: InvestigationStore) => T): T {
  const store = new InvestigationStore(config.databasePath);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

async function login(app: FastifyInstance, username = "fixture-admin") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { host, origin },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/** Files, accounts, repository data, and every upstream response are isolated synthetic fixtures. */
async function fixture(
  options: {
    receiver?: boolean;
    kind?: "issue" | "pull_request";
    additionalAccounts?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "investigation-webhook-runtime-"));
  directories.push(directory);
  const dashboard = join(directory, "dashboard");
  await mkdir(dashboard);
  await writeFile(
    join(dashboard, "index.html"),
    "<!doctype html><title>Webhook Runtime Fixture</title>",
  );
  const environment = {
    INVESTIGATION_DATABASE_PATH: join(directory, "investigation.sqlite"),
    INVESTIGATION_AUTH_DATABASE_PATH: join(directory, "auth.sqlite"),
    INVESTIGATION_DASHBOARD_DIRECTORY: dashboard,
    INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
    INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: password,
    INVESTIGATION_GITHUB_TOKEN: "synthetic-get-only-token",
    INVESTIGATION_GITHUB_USER_ID: "55",
    INVESTIGATION_WORKERS_JSON: JSON.stringify([
      { id: "worker-1", token: workerToken, repositoryIds: [repository.id] },
    ]),
    ...(options.receiver === false ? {} : { INVESTIGATION_GITHUB_WEBHOOK_SECRET: secret }),
  };
  const config = loadInvestigationRuntimeConfig(environment);
  const accounts = new InvestigationPasswordStore(config.authDatabasePath);
  try {
    const admin = await accounts.initializeBootstrap({
      username: "fixture-admin",
      password,
      displayName: "Synthetic Webhook Administrator",
      repositoryIds: [repository.id],
      permissions: ["repository:manage", "task:create"],
    });
    if (admin === null)
      throw new Error("The isolated runtime fixture must initialize its account.");
    if (options.additionalAccounts) {
      await accounts.createAccount(admin, {
        username: "fixture-viewer",
        password,
        repositoryIds: [repository.id],
        permissions: [],
      });
      await accounts.createAccount(admin, {
        username: "fixture-foreign",
        password,
        repositoryIds: ["other-repository"],
        permissions: ["repository:manage"],
      });
    }
  } finally {
    accounts.close();
  }
  const kind = options.kind ?? "issue";
  const upstream = {
    id: 77,
    number: 7,
    title: "Complete assignment investigation",
    body: "Complete source body with reproduction details.",
    state: "open",
    comments: 1,
    updated_at: "2026-09-16T08:00:00.000Z",
    assignees: [{ id: 55, login: "configured-reviewer", type: "User" }],
    ...(kind === "issue"
      ? {}
      : {
          base: { sha: "b".repeat(40), repo: { id: repository.githubRepositoryId } },
          head: { sha: "a".repeat(40) },
          review_comments: 1,
          merged_at: null,
        }),
  };
  const sourceCalls: { path: string; method: string | undefined }[] = [];
  const sourceEntered = gate();
  let suspendSource = false;
  const sourceImportFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    sourceCalls.push({ path: url.pathname, method: init?.method });
    if (suspendSource) {
      sourceEntered.release();
      const signal = init?.signal;
      if (signal === undefined || signal === null)
        throw new Error("Webhook source reads must receive the runtime shutdown signal.");
      return new Promise<Response>((_resolve, reject) => {
        const aborted = () =>
          reject(new Error("Synthetic source read aborted by runtime shutdown."));
        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, { once: true });
      });
    }
    if (url.pathname === "/user") return Response.json({ id: 55 });
    if (url.pathname === "/repos/fixture/webhook-runtime")
      return Response.json({ id: repository.githubRepositoryId, full_name: repository.fullName });
    if (
      url.pathname === "/repos/fixture/webhook-runtime/issues/7" ||
      url.pathname === "/repos/fixture/webhook-runtime/pulls/7"
    )
      return Response.json(upstream);
    if (url.pathname === "/repos/fixture/webhook-runtime/issues/7/comments")
      return Response.json([{ id: 201, body: "Complete conversation comment" }]);
    if (url.pathname === "/repos/fixture/webhook-runtime/pulls/7/comments")
      return Response.json([{ id: 301, body: "Complete inline review comment" }]);
    if (url.pathname === "/repos/fixture/webhook-runtime/pulls/7/reviews")
      return Response.json([{ id: 401, body: "Complete review summary" }]);
    throw new Error(`Unexpected synthetic source request: ${url.pathname}`);
  };
  const readTarget = vi.fn<InvestigationActionTransport["readTarget"]>(
    async (_repository, item) => ({
      kind: item.kind,
      state: item.state,
      revisionKey: item.subject.revisionKey,
      headSha: item.subject.kind === "original_pr" ? item.subject.headSha : null,
    }),
  );
  const execute = vi.fn<InvestigationActionTransport["execute"]>(async () => {
    throw new Error("The webhook runtime fixture must never write to GitHub.");
  });
  const reconcile = vi.fn<InvestigationActionTransport["reconcile"]>(async () => {
    throw new Error("The webhook runtime fixture has no external writes to reconcile.");
  });
  const dependencies = {
    logger: false as const,
    sourceImportFetch,
    actionTransport: { supportedActions: [], readTarget, execute, reconcile },
  };
  const start = async () => {
    const app = await createInvestigationRuntime(config, dependencies);
    applications.add(app);
    return app;
  };
  const app = await start();
  const cookie = await login(app);
  const register = await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { host, origin, cookie },
    payload: repository,
  });
  expect(register.statusCode).toBe(201);
  function delivery(deliveryId = "runtime-delivery-1") {
    const body = JSON.stringify({
      action: "assigned",
      repository: { id: repository.githubRepositoryId, full_name: repository.fullName },
      sender: { id: 44, login: "trusted-maintainer", type: "User" },
      assignee: { id: 55, login: "configured-reviewer", type: "User" },
      ...(kind === "issue" ? { issue: upstream } : { pull_request: upstream }),
    });
    return {
      method: "POST" as const,
      url: "/api/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": kind === "issue" ? "issues" : "pull_request",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      payload: body,
    };
  }
  return {
    app,
    cookie,
    config,
    start,
    delivery,
    sourceCalls,
    readTarget,
    execute,
    reconcile,
    upstream,
    sourceEntered,
    suspendSource: (value: boolean) => {
      suspendSource = value;
    },
  };
}

async function enable(app: FastifyInstance, cookie: string) {
  const response = await app.inject({
    method: "PUT",
    url: settingsUrl,
    headers: { host, origin, cookie },
    payload: enabledSettings,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ...enabledSettings,
    version: 1,
    repositoryId: repository.id,
  });
}

async function completedReceipt(
  app: FastifyInstance,
  cookie: string,
  deliveryId = "runtime-delivery-1",
) {
  await vi.waitFor(
    async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/github/webhook-deliveries/${deliveryId}`,
        headers: { host, cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ state: "completed", repositoryId: repository.id });
    },
    { timeout: 5_000, interval: 10 },
  );
}

describe("production webhook runtime integration", () => {
  it("keeps repository settings available without a receiver and preserves UI configuration across restart", async () => {
    const test = await fixture({ receiver: false });
    const initial = await test.app.inject({
      method: "GET",
      url: settingsUrl,
      headers: { host, cookie: test.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      repositoryId: repository.id,
      version: 0,
      enabled: false,
      reviewerUserId: null,
      allowedActorUserIds: [],
      receiverConfigured: false,
    });
    expect(initial.headers["cache-control"]).toBe("no-store");
    await enable(test.app, test.cookie);
    expect((await test.app.inject(test.delivery())).statusCode).toBe(404);
    expect(test.sourceCalls).toEqual([]);
    await closeRuntime(test.app);
    const restarted = await test.start();
    const settings = await restarted.inject({
      method: "GET",
      url: settingsUrl,
      headers: { host, cookie: test.cookie },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({
      ...enabledSettings,
      version: 1,
      repositoryId: repository.id,
      receiverConfigured: false,
    });
    expect(settings.body).not.toContain(secret);
    expect(settings.body).not.toContain("synthetic-get-only-token");
  });

  it("requires authentication, repository scope, management permission, same Origin, and current settings version", async () => {
    const test = await fixture({ receiver: false, additionalAccounts: true });
    const viewerCookie = await login(test.app, "fixture-viewer");
    const foreignCookie = await login(test.app, "fixture-foreign");
    expect(
      (await test.app.inject({ method: "GET", url: settingsUrl, headers: { host } })).statusCode,
    ).toBe(401);
    expect(
      (
        await test.app.inject({
          method: "GET",
          url: settingsUrl,
          headers: { host, cookie: viewerCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await test.app.inject({
          method: "GET",
          url: settingsUrl,
          headers: { host, cookie: foreignCookie },
        })
      ).statusCode,
    ).toBe(403);
    for (const [headers, statusCode] of [
      [{ host, origin }, 401],
      [{ host, origin, cookie: viewerCookie }, 403],
      [{ host, origin, cookie: foreignCookie }, 403],
      [{ host, cookie: test.cookie }, 401],
      [{ host, origin: "https://attacker.example", cookie: test.cookie }, 401],
    ] as const) {
      const response = await test.app.inject({
        method: "PUT",
        url: settingsUrl,
        headers,
        payload: enabledSettings,
      });
      expect(response.statusCode).toBe(statusCode);
    }
    await enable(test.app, test.cookie);
    const stale = await test.app.inject({
      method: "PUT",
      url: settingsUrl,
      headers: { host, origin, cookie: test.cookie },
      payload: { ...enabledSettings, enabled: false },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "webhook_settings_conflict" });
    expect(test.sourceCalls).toEqual([]);
  });

  it.each(["issue", "pull_request"] as const)(
    "accepts a signed %s assignment without browser credentials and dispatches its frozen Task",
    async (kind) => {
      const test = await fixture({ kind });
      expect(test.config.enableExternalWrites).toBe(false);
      expect(test.config.webhook?.bindings).toEqual([]);
      const initial = await test.app.inject({
        method: "GET",
        url: settingsUrl,
        headers: { host, cookie: test.cookie },
      });
      expect(initial.json()).toMatchObject({ enabled: false, receiverConfigured: true });
      const disabled = await test.app.inject(test.delivery("disabled-assignment"));
      expect(disabled.statusCode).toBe(202);
      expect(disabled.json()).toMatchObject({
        status: "ignored",
        reason: "repository_not_configured",
      });
      expect(test.sourceCalls).toEqual([]);
      await enable(test.app, test.cookie);
      const request = test.delivery();
      expect(request.headers).not.toHaveProperty("cookie");
      expect(request.headers).not.toHaveProperty("origin");
      const response = await test.app.inject(request);
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        status: "accepted",
        deliveryId: "runtime-delivery-1",
      });
      expect(
        stored(test.config, (store) =>
          store.get<InvestigationWebhookReceipt>(
            "idempotency",
            "webhook:delivery:runtime-delivery-1",
          ),
        ),
      ).toMatchObject({
        deliveryId: "runtime-delivery-1",
        assignment: { repository, kind, number: 7 },
      });
      await completedReceipt(test.app, test.cookie);
      const listing = await test.app.inject({
        method: "GET",
        url: "/api/tasks",
        headers: { host, cookie: test.cookie },
      });
      expect(listing.statusCode).toBe(200);
      const tasks = listing.json<{ items: InvestigationTaskV1[] }>().items;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: kind === "issue" ? "issue-investigate" : "pr-review",
        state: "queued",
        repository,
        executionPolicy: {
          mode: kind === "issue" ? "snapshot_only" : "source_read",
          allowRepositoryExecution: false,
        },
      });
      const duplicate = await test.app.inject(request);
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json()).toMatchObject({ status: "duplicate", taskId: tasks[0]!.id });
      const claim = await test.app.inject({
        method: "POST",
        url: "/api/worker/claims",
        headers: { authorization: `Bearer ${workerToken}` },
        payload: { supportedKinds: [tasks[0]!.kind] },
      });
      expect(claim.statusCode).toBe(200);
      expect(claim.json().claim.inputSnapshot).toMatchObject({
        title: test.upstream.title,
        body: test.upstream.body,
        source: null,
      });
      expect(
        claim.json().claim.inputSnapshot.comments.map((comment: { body: string }) => comment.body),
      ).toEqual(
        kind === "issue"
          ? ["Complete conversation comment"]
          : [
              "Complete conversation comment",
              "Complete inline review comment",
              "Complete review summary",
            ],
      );
      expect(stored(test.config, (store) => store.list("tasks"))).toHaveLength(1);
      expect(stored(test.config, (store) => store.list("actionIntents"))).toEqual([]);
      expect(test.sourceCalls.length).toBeGreaterThan(0);
      expect(test.sourceCalls.every((call) => call.method === "GET")).toBe(true);
      expect(test.execute).not.toHaveBeenCalled();
      expect(test.reconcile).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid signatures before durable admission and keeps receipts scoped to authenticated readers", async () => {
    const test = await fixture({ additionalAccounts: true });
    await enable(test.app, test.cookie);
    const request = test.delivery();
    const invalid = await test.app.inject({
      ...request,
      headers: { ...request.headers, "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    });
    expect(invalid.statusCode).toBe(401);
    expect(
      stored(test.config, (store) =>
        store.get("idempotency", "webhook:delivery:runtime-delivery-1"),
      ),
    ).toBeUndefined();
    expect(stored(test.config, (store) => store.list("tasks"))).toEqual([]);
    expect(test.sourceCalls).toEqual([]);
    expect((await test.app.inject(request)).statusCode).toBe(202);
    await completedReceipt(test.app, test.cookie);
    const receiptUrl = "/api/github/webhook-deliveries/runtime-delivery-1";
    const viewerCookie = await login(test.app, "fixture-viewer");
    const foreignCookie = await login(test.app, "fixture-foreign");
    expect(
      (await test.app.inject({ method: "GET", url: receiptUrl, headers: { host } })).statusCode,
    ).toBe(401);
    expect(
      (
        await test.app.inject({
          method: "GET",
          url: receiptUrl,
          headers: { host, cookie: foreignCookie },
        })
      ).statusCode,
    ).toBe(403);
    const allowed = await test.app.inject({
      method: "GET",
      url: receiptUrl,
      headers: { host, cookie: viewerCookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["cache-control"]).toBe("no-store");
    expect(allowed.json()).toMatchObject({
      state: "completed",
      actorUserId: 44,
      assigneeUserId: 55,
    });
    expect(allowed.body).not.toContain(secret);
    expect(allowed.body).not.toContain("synthetic-get-only-token");
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("aborts an in-flight source read on shutdown and resumes the durable assignment at production startup", async () => {
    const test = await fixture();
    await enable(test.app, test.cookie);
    test.suspendSource(true);
    expect((await test.app.inject(test.delivery())).statusCode).toBe(202);
    await test.sourceEntered.promise;
    expect(stored(test.config, (store) => store.list("tasks"))).toEqual([]);
    await closeRuntime(test.app);
    const receipt = stored(test.config, (store) =>
      store.get<InvestigationWebhookReceipt>("idempotency", "webhook:delivery:runtime-delivery-1"),
    );
    expect(receipt).toMatchObject({ state: "accepted", attempts: 1, claim: { expiresAt: 0 } });
    test.suspendSource(false);
    const restarted = await test.start();
    await completedReceipt(restarted, test.cookie);
    expect(stored(test.config, (store) => store.list("tasks"))).toHaveLength(1);
    expect(
      stored(test.config, (store) =>
        store.get<InvestigationWebhookReceipt>(
          "idempotency",
          "webhook:delivery:runtime-delivery-1",
        ),
      ),
    ).toMatchObject({ state: "completed", attempts: 2 });
    expect(stored(test.config, (store) => store.list("actionIntents"))).toEqual([]);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("honors a UI authorization revocation while the final upstream target read is pending", async () => {
    const test = await fixture();
    await enable(test.app, test.cookie);
    const entered = gate();
    const resumed = gate();
    test.readTarget.mockImplementationOnce(async (_repository, item) => {
      entered.release();
      await resumed.promise;
      return {
        kind: item.kind,
        state: item.state,
        revisionKey: item.subject.revisionKey,
        headSha: null,
      };
    });
    expect((await test.app.inject(test.delivery())).statusCode).toBe(202);
    await entered.promise;
    try {
      const disabled = await test.app.inject({
        method: "PUT",
        url: settingsUrl,
        headers: { host, origin, cookie: test.cookie },
        payload: { ...enabledSettings, version: 1, enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
    } finally {
      resumed.release();
    }
    await vi.waitFor(
      async () => {
        const response = await test.app.inject({
          method: "GET",
          url: "/api/github/webhook-deliveries/runtime-delivery-1",
          headers: { host, cookie: test.cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          state: "failed",
          reason: "webhook_authorization_revoked",
          taskId: null,
        });
      },
      { timeout: 5_000, interval: 10 },
    );
    expect(stored(test.config, (store) => store.list("tasks"))).toEqual([]);
    expect(stored(test.config, (store) => store.list("actionIntents"))).toEqual([]);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("allows a receiver secret without deployment bindings but rejects incomplete credentials", () => {
    const github = {
      INVESTIGATION_GITHUB_TOKEN: "synthetic-get-only-token",
      INVESTIGATION_GITHUB_USER_ID: "55",
    };
    expect(
      loadInvestigationRuntimeConfig({ ...github, INVESTIGATION_GITHUB_WEBHOOK_SECRET: secret })
        .webhook?.bindings,
    ).toEqual([]);
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_GITHUB_WEBHOOK_SECRET: secret }),
    ).toThrow("GitHub credentials");
    expect(() =>
      loadInvestigationRuntimeConfig({
        ...github,
        INVESTIGATION_GITHUB_WEBHOOK_BINDINGS_JSON: "[]",
      }),
    ).toThrow("secret");
    expect(() =>
      loadInvestigationRuntimeConfig({
        ...github,
        INVESTIGATION_GITHUB_WEBHOOK_SECRET: "too-short",
      }),
    ).toThrow("32 to 4096");
  });
});
