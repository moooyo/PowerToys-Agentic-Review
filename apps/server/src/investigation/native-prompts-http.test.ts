import {
  createInvestigationPreview,
  type InvestigationNativePromptBinding,
  type InvestigationNativePromptCatalog,
  type InvestigationNativePromptContent,
  type InvestigationNativePromptVersion,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationOperatorAuthenticator,
  InvestigationOperatorPrincipal,
} from "../../dist/investigation/types.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const resources: Array<{ app: FastifyInstance; store: InvestigationStore }> = [];
const timestamp = "2026-10-01T02:00:00.000Z";
const content: InvestigationNativePromptContent = {
  localCheckout: "Apply the synthetic HTTP local review checklist.",
  snapshot: "Apply the synthetic HTTP snapshot review checklist.",
};

afterEach(async () => {
  for (const { app, store } of resources.splice(0)) {
    await app.close();
    store.close();
  }
});

/** These HTTP fixtures never start a Worker, model provider, or upstream transport. */
function fixture() {
  const store = new InvestigationStore();
  const repository = createInvestigationPreview("pr", { findingCount: 0 }).task.repository;
  store.insert("repositories", repository.id, repository);
  const manager: InvestigationOperatorPrincipal = {
    id: "synthetic-http-prompt-manager",
    displayName: "Synthetic HTTP prompt manager",
    repositoryIds: [repository.id],
    permissions: ["repository:manage"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  };
  const reader: InvestigationOperatorPrincipal = {
    ...manager,
    id: "synthetic-http-prompt-reader",
    permissions: [],
  };
  const outsideReader: InvestigationOperatorPrincipal = {
    ...reader,
    id: "synthetic-http-outside-reader",
    repositoryIds: ["synthetic-unrelated-repository"],
  };
  const principals = new Map([
    ["manager", manager],
    ["reader", reader],
    ["outside-reader", outsideReader],
  ]);
  const authenticateOperator = vi.fn<InvestigationOperatorAuthenticator>(async (request) => {
    await Promise.resolve();
    return principals.get(request.headers.authorization ?? "") ?? null;
  });
  let sequence = 0;
  const app = buildInvestigationApp({
    store,
    now: () => new Date(timestamp),
    idFactory: () => `synthetic-http-native-prompt-${++sequence}`,
    authenticateOperator,
    authenticateWorker: async (request) =>
      request.headers.authorization === "worker"
        ? { id: "synthetic-http-worker", repositoryIds: [repository.id] }
        : null,
  });
  resources.push({ app, store });
  const catalogPath = `/api/repositories/${repository.id}/native-prompts`;
  const versionsPath = `${catalogPath}/pr-review/versions`;
  const bindingPath = `${catalogPath}/pr-review/binding`;
  const get = (identity?: string) =>
    app.inject({
      method: "GET",
      url: catalogPath,
      ...(identity === undefined ? {} : { headers: { authorization: identity } }),
    });
  const post = (url: string, payload: unknown, identity = "manager") =>
    app.inject({
      method: "POST",
      url,
      payload: JSON.stringify(payload),
      headers: { authorization: identity, "content-type": "application/json" },
    });
  return {
    app,
    store,
    repository,
    manager,
    authenticateOperator,
    catalogPath,
    versionsPath,
    bindingPath,
    get,
    post,
  };
}

function prItem(catalog: InvestigationNativePromptCatalog) {
  const item = catalog.items.find((entry) => entry.kind === "pr-review");
  if (item === undefined) throw new Error("Expected the synthetic HTTP PR prompt catalog.");
  return item;
}

describe("authenticated native prompt HTTP routes", () => {
  it("awaits authentication and separates repository reads from management permission", async () => {
    const f = fixture();
    for (const identity of [undefined, "worker"]) {
      expect((await f.get(identity)).statusCode).toBe(401);
    }
    const read = await f.get("reader");
    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    const catalog = read.json<InvestigationNativePromptCatalog>();
    expect(catalog.repositoryId).toBe(f.repository.id);
    expect(catalog.items).toHaveLength(2);
    expect(f.authenticateOperator).toHaveBeenCalled();
    expect((await f.get("outside-reader")).statusCode).toBe(403);
    const before = f.store.list("idempotency");
    const publish = await f.post(
      f.versionsPath,
      {
        expectedVersion: 1,
        name: "Reader cannot publish",
        content,
      },
      "reader",
    );
    expect(publish.statusCode).toBe(403);
    expect(publish.json()).toMatchObject({ code: "native_prompt_access_denied" });
    const bind = await f.post(
      f.bindingPath,
      {
        expectedVersion: 0,
        promptRef: prItem(catalog).binding.promptRef,
      },
      "reader",
    );
    expect(bind.statusCode).toBe(403);
    expect(f.store.list("idempotency")).toEqual(before);
  });

  it("publishes and binds the exact returned version while rejecting stale CAS requests", async () => {
    const f = fixture();
    const initial = await f.get("manager");
    expect(initial.statusCode, initial.body).toBe(200);
    const current = prItem(initial.json<InvestigationNativePromptCatalog>());
    const published = await f.post(f.versionsPath, {
      expectedVersion: current.versions[0]!.version,
      name: "Synthetic HTTP published guidance",
      content,
    });
    expect(published.statusCode, published.body).toBe(201);
    const version = published.json<InvestigationNativePromptVersion>();
    expect(version).toMatchObject({
      repositoryId: f.repository.id,
      kind: "pr-review",
      version: 2,
      content,
      createdBy: f.manager.id,
    });
    const promptRef = { id: version.id, version: version.version, digest: version.digest };
    const bound = await f.post(f.bindingPath, {
      expectedVersion: current.binding.version,
      promptRef,
    });
    expect(bound.statusCode, bound.body).toBe(200);
    const binding = bound.json<InvestigationNativePromptBinding>();
    expect(binding).toMatchObject({ version: 1, promptRef, updatedBy: f.manager.id });
    const before = f.store.list("idempotency");
    const stalePublish = await f.post(f.versionsPath, {
      expectedVersion: 1,
      name: "Stale HTTP version",
      content,
    });
    expect(stalePublish.statusCode).toBe(409);
    expect(stalePublish.json()).toMatchObject({ code: "native_prompt_version_conflict" });
    const staleBind = await f.post(f.bindingPath, {
      expectedVersion: 0,
      promptRef: current.binding.promptRef,
    });
    expect(staleBind.statusCode).toBe(409);
    expect(staleBind.json()).toMatchObject({ code: "native_prompt_binding_conflict" });
    expect(f.store.list("idempotency")).toEqual(before);
    const latest = await f.get("manager");
    expect(prItem(latest.json<InvestigationNativePromptCatalog>()).binding).toEqual(binding);
  });

  it("rejects unsupported kinds and invalid payloads without adding catalog versions", async () => {
    const f = fixture();
    const initial = await f.get("manager");
    expect(initial.statusCode, initial.body).toBe(200);
    const catalog = initial.json<InvestigationNativePromptCatalog>();
    const before = f.store.list("idempotency");
    const valid = { expectedVersion: 1, name: "Invalid HTTP fixture", content };
    const unsupported = await f.post(`${f.catalogPath}/pr-e2e/versions`, valid);
    expect(unsupported.statusCode).toBe(400);
    for (const payload of [
      { ...valid, expectedVersion: 0 },
      { ...valid, name: "" },
      { ...valid, content: { ...content, snapshot: "" } },
      { ...valid, content: { localCheckout: content.localCheckout } },
      { ...valid, unexpected: true },
    ]) {
      expect((await f.post(f.versionsPath, payload)).statusCode).toBe(400);
    }
    const invalidBind = await f.post(f.bindingPath, {
      expectedVersion: -1,
      promptRef: prItem(catalog).binding.promptRef,
    });
    expect(invalidBind.statusCode).toBe(400);
    expect(f.store.list("idempotency")).toEqual(before);
    const latest = (await f.get("reader")).json<InvestigationNativePromptCatalog>();
    expect(latest).toEqual(catalog);
    expect(latest.items.map((item) => item.kind)).toEqual(["pr-review", "issue-investigate"]);
    expect(latest.items.every((item) => item.versions.length === 1)).toBe(true);
  });
});
