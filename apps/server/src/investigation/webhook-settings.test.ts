import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";
import {
  InvestigationWebhookSettings,
  type InvestigationWebhookSettingsUpdate,
} from "../../dist/investigation/webhook-settings.js";

const repository = { id: "repo-1", fullName: "fixture/project", githubRepositoryId: 101 };
const actor: InvestigationOperatorPrincipal = {
  id: "operator-1",
  displayName: "Fixture operator",
  repositoryIds: [repository.id],
  permissions: ["repository:manage"],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};
const binding = { repositoryId: repository.id, reviewerUserId: 200, allowedActorUserIds: [300] };
const enabled: InvestigationWebhookSettingsUpdate = {
  version: 0,
  enabled: true,
  reviewerUserId: 201,
  allowedActorUserIds: [301, 302],
};
const stores: InvestigationStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function open(path?: string): InvestigationStore {
  const store = new InvestigationStore(path);
  stores.push(store);
  store.put("repositories", repository.id, repository);
  return store;
}

function expectError(operation: () => unknown, statusCode: number, code?: string): void {
  expect(operation).toThrow(
    expect.objectContaining({
      statusCode,
      ...(code === undefined ? {} : { code }),
    }),
  );
}

describe("repository webhook settings", () => {
  it("starts disabled without credentials and allows a scoped viewer to read settings", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store);
    expect(settings.read({ ...actor, permissions: [] }, repository.id)).toEqual({
      repositoryId: repository.id,
      version: 0,
      enabled: false,
      reviewerUserId: null,
      allowedActorUserIds: [],
      receiverConfigured: false,
    });
    expect(settings.bindings()).toEqual([]);
    expect(store.list("idempotency")).toEqual([]);
  });

  it("requires exact repository scope for reads and writes even for an administrator", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store, [binding], true);
    for (const repositoryIds of [[], ["*"], ["repo-"], ["Repo-1"], ["repo-2"]]) {
      const denied = { ...actor, isAdmin: true, repositoryIds };
      expectError(() => settings.read(denied, repository.id), 403, "repository_forbidden");
      expectError(
        () => settings.update(denied, repository.id, enabled),
        403,
        "repository_forbidden",
      );
    }
    expect(store.list("idempotency")).toEqual([]);
  });

  it("requires repository:manage for writes without treating other permissions as approval", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store);
    for (const permissions of [[], ["task:create"], ["action:execute"]] as const) {
      expectError(
        () => settings.update({ ...actor, isAdmin: true, permissions }, repository.id, enabled),
        403,
        "permission_denied",
      );
    }
    expect(store.list("idempotency")).toEqual([]);
  });

  it("requires a valid registered repository and does not reveal missing out-of-scope repositories", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store);
    const scopedActor = { ...actor, repositoryIds: [...actor.repositoryIds, "missing"] };
    expectError(() => settings.read(scopedActor, "missing"), 404, "not_found");
    expectError(() => settings.update(scopedActor, "missing", enabled), 404, "not_found");
    expectError(() => settings.read(actor, "missing"), 403, "repository_forbidden");
    expectError(() => settings.update(actor, "missing", enabled), 403, "repository_forbidden");
    expectError(() => settings.read(actor, "repo-1 "), 400, "invalid_repository_id");
    expect(store.list("idempotency")).toEqual([]);
  });

  it("atomically saves settings and increments the version while rejecting stale concurrent editors", () => {
    const store = open();
    const first = new InvestigationWebhookSettings(store, [], true);
    const second = new InvestigationWebhookSettings(store, [], true);
    const previous = second.read(actor, repository.id);
    const saved = first.update(actor, repository.id, enabled);
    expect(saved).toEqual({
      ...enabled,
      version: 1,
      repositoryId: repository.id,
      receiverConfigured: true,
    });
    expectError(
      () =>
        second.update(actor, repository.id, {
          ...enabled,
          version: previous.version,
          reviewerUserId: 999,
        }),
      409,
      "webhook_settings_conflict",
    );
    expect(second.read(actor, repository.id)).toEqual(saved);
    const next = second.update(actor, repository.id, {
      ...enabled,
      version: 1,
      reviewerUserId: 999,
    });
    expect(next.version).toBe(2);
    expect(next.reviewerUserId).toBe(999);
    expect(store.list("idempotency")).toHaveLength(1);
  });

  it("rolls back the settings record if persistence fails before transaction commit", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store, [binding], true);
    const write = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementationOnce((collection, id, value) => {
      write(collection, id, value);
      throw new Error("Synthetic transaction failure");
    });
    expect(() => settings.update(actor, repository.id, enabled)).toThrow(
      "Synthetic transaction failure",
    );
    expect(settings.read(actor, repository.id).version).toBe(0);
    expect(settings.bindings()).toEqual([binding]);
    expect(store.list("idempotency")).toEqual([]);
  });

  it("persists enabled overrides and disabled overrides across restart and changed environment defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webhook-settings-"));
    directories.push(directory);
    const path = join(directory, "settings.sqlite");
    const firstStore = open(path);
    const first = new InvestigationWebhookSettings(firstStore, [binding], true);
    expect(first.read(actor, repository.id)).toMatchObject({
      enabled: true,
      version: 0,
      reviewerUserId: binding.reviewerUserId,
    });
    first.update(actor, repository.id, enabled);
    firstStore.close();
    const secondStore = open(path);
    const changedDefaults = [{ ...binding, reviewerUserId: 999, allowedActorUserIds: [998] }];
    const second = new InvestigationWebhookSettings(secondStore, changedDefaults, true);
    expect(second.bindings()).toEqual([
      {
        repositoryId: repository.id,
        reviewerUserId: enabled.reviewerUserId,
        allowedActorUserIds: enabled.allowedActorUserIds,
      },
    ]);
    second.update(actor, repository.id, {
      version: 1,
      enabled: false,
      reviewerUserId: null,
      allowedActorUserIds: [],
    });
    secondStore.close();
    const third = new InvestigationWebhookSettings(open(path), changedDefaults, true);
    expect(third.bindings()).toEqual([]);
    expect(third.read(actor, repository.id)).toMatchObject({
      version: 2,
      enabled: false,
      reviewerUserId: null,
      allowedActorUserIds: [],
    });
  });

  it("resolves only registered repositories and reloads saved overrides on each binding lookup", () => {
    const store = open();
    const otherBinding = { ...binding, repositoryId: "repo-2", reviewerUserId: 202 };
    const settings = new InvestigationWebhookSettings(store, [binding, otherBinding], true);
    expect(settings.bindings()).toEqual([binding]);
    const otherRepository = { id: "repo-2", fullName: "fixture/other", githubRepositoryId: 102 };
    store.put("repositories", otherRepository.id, otherRepository);
    expect(settings.bindings()).toEqual([binding, otherBinding]);
    settings.update(actor, repository.id, { ...enabled, enabled: false });
    expect(settings.bindings()).toEqual([otherBinding]);
    store.delete("repositories", otherRepository.id);
    expect(settings.bindings()).toEqual([]);
  });

  it("keeps configured values available when the receiver is not yet deployed without exposing secrets", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store, [], false);
    const result = settings.update(actor, repository.id, enabled);
    expect(result.receiverConfigured).toBe(false);
    expect(Object.keys(result).sort()).toEqual([
      "allowedActorUserIds",
      "enabled",
      "receiverConfigured",
      "repositoryId",
      "reviewerUserId",
      "version",
    ]);
    expect(store.get("idempotency", `webhook:settings:${repository.id}`)).toEqual({
      ...enabled,
      version: 1,
      repositoryId: repository.id,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    null,
    [],
    {},
    { ...enabled, version: -1 },
    { ...enabled, version: 0.1 },
    { ...enabled, version: "0" },
    { ...enabled, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...enabled, enabled: "true" },
    { ...enabled, reviewerUserId: null },
    { ...enabled, reviewerUserId: 0 },
    { ...enabled, reviewerUserId: -2 },
    { ...enabled, reviewerUserId: 1.5 },
    { ...enabled, reviewerUserId: "201" },
    { ...enabled, reviewerUserId: Number.NaN },
    { ...enabled, reviewerUserId: Number.MAX_SAFE_INTEGER + 1 },
    { ...enabled, allowedActorUserIds: [] },
    { ...enabled, allowedActorUserIds: [301, 301] },
    { ...enabled, allowedActorUserIds: ["301"] },
    { ...enabled, allowedActorUserIds: [0] },
    { ...enabled, allowedActorUserIds: [-1] },
    { ...enabled, allowedActorUserIds: [1.5] },
    { ...enabled, allowedActorUserIds: [Number.NaN] },
    { ...enabled, allowedActorUserIds: [Number.MAX_SAFE_INTEGER + 1] },
    { ...enabled, allowedActorUserIds: Array.from({ length: 1_025 }, (_, index) => index + 1) },
    { ...enabled, allowedActorUserIds: Array(1) },
    { ...enabled, secret: "forged-secret" },
    { ...enabled, receiverConfigured: true },
    { ...enabled, repositoryId: "repo-2" },
    { ...enabled, reviewerLogin: "reviewer" },
    { ...enabled, enabled: false, reviewerUserId: "201" },
  ])(
    "rejects malformed identities, empty enabled settings, and extra fields without mutation",
    (request) => {
      const store = open();
      const settings = new InvestigationWebhookSettings(store, [], true);
      expectError(
        () => settings.update(actor, repository.id, request as InvestigationWebhookSettingsUpdate),
        400,
        "invalid_webhook_settings",
      );
      expect(settings.read(actor, repository.id).version).toBe(0);
      expect(store.list("idempotency")).toEqual([]);
    },
  );

  it("accepts the maximum safe numeric identity and 1024 trusted users without truncation", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store, [], true);
    const allowedActorUserIds = Array.from({ length: 1_024 }, (_, index) => index + 1);
    const saved = settings.update(actor, repository.id, {
      ...enabled,
      reviewerUserId: Number.MAX_SAFE_INTEGER,
      allowedActorUserIds,
    });
    expect(saved.reviewerUserId).toBe(Number.MAX_SAFE_INTEGER);
    expect(saved.allowedActorUserIds).toEqual(allowedActorUserIds);
  });

  it("allows disabled settings to preserve draft identities or clear them completely", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store, [binding], true);
    settings.update(actor, repository.id, { ...enabled, enabled: false, allowedActorUserIds: [] });
    expect(settings.read(actor, repository.id)).toMatchObject({
      version: 1,
      enabled: false,
      reviewerUserId: 201,
      allowedActorUserIds: [],
    });
    expect(settings.bindings()).toEqual([]);
    settings.update(actor, repository.id, {
      version: 1,
      enabled: false,
      reviewerUserId: null,
      allowedActorUserIds: [],
    });
    expect(settings.read(actor, repository.id).reviewerUserId).toBeNull();
  });

  it("detaches environment inputs, returned views, and effective bindings from stored identities", () => {
    const store = open();
    const mutableBinding = { ...binding, allowedActorUserIds: [...binding.allowedActorUserIds] };
    const settings = new InvestigationWebhookSettings(store, [mutableBinding], true);
    mutableBinding.allowedActorUserIds.push(999);
    mutableBinding.reviewerUserId = 999;
    const view = settings.read(actor, repository.id);
    (view.allowedActorUserIds as number[]).push(998);
    const effective = settings.bindings();
    (effective[0]!.allowedActorUserIds as number[]).push(997);
    expect(settings.bindings()).toEqual([binding]);
    const request = { ...enabled, allowedActorUserIds: [301] };
    settings.update(actor, repository.id, request);
    request.allowedActorUserIds.push(996);
    expect(settings.read(actor, repository.id).allowedActorUserIds).toEqual([301]);
  });

  it("fails closed on invalid persisted settings instead of enabling environment defaults", () => {
    const store = open();
    const settings = new InvestigationWebhookSettings(store, [binding], true);
    for (const value of [
      null,
      { ...enabled, repositoryId: repository.id, version: 0 },
      { ...enabled, repositoryId: "repo-2", version: 1 },
      { ...enabled, repositoryId: repository.id, version: 1, allowedActorUserIds: [] },
      { ...enabled, repositoryId: repository.id, version: 1, secret: "unexpected" },
    ]) {
      store.put("idempotency", `webhook:settings:${repository.id}`, value);
      expectError(() => settings.read(actor, repository.id), 500, "invalid_saved_webhook_settings");
      expectError(() => settings.bindings(), 500, "invalid_saved_webhook_settings");
    }
  });
});
