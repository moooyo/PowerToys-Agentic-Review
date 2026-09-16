import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationPasswordKdf } from "../../dist/investigation/password-crypto.js";
import {
  type InvestigationPasswordAccount,
  type InvestigationPasswordActor,
  InvestigationPasswordStore,
  type InvestigationPasswordStoreOptions,
  investigationPasswordSchemaVersion,
} from "../../dist/investigation/password-store.js";

const password = "Correct horse battery staple 1";
const replacement = "A different correct password 2";
const stores: InvestigationPasswordStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function open(path = ":memory:", options: InvestigationPasswordStoreOptions = {}) {
  const store = new InvestigationPasswordStore(path, options);
  stores.push(store);
  return store;
}

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "investigation-password-store-"));
  directories.push(directory);
  return join(directory, "auth.sqlite");
}

function actor(account: InvestigationPasswordAccount): InvestigationPasswordActor {
  return { id: account.id, version: account.version };
}

async function bootstrap(store: InvestigationPasswordStore) {
  const account = await store.initializeBootstrap({
    username: "  ADMIN  ",
    password,
    displayName: "Administrator",
    repositoryIds: ["repo-1"],
    permissions: ["task:create"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
  });
  if (account === null) throw new Error("Expected a newly initialized administrator.");
  return account;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("InvestigationPasswordStore", () => {
  it("persists only password hashes and session token digests in its independent schema", async () => {
    const path = await databasePath();
    const store = open(path);
    const admin = await bootstrap(store);
    const session = await store.authenticate(" AdMiN ", password);
    expect(session?.account).toEqual(admin);
    expect(admin.username).toBe("admin");
    expect(admin.isAdmin).toBe(true);
    expect(session?.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(admin)).not.toMatch(/password|hash/u);
    store.close();

    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT version FROM investigation_password_metadata").get()?.version,
      ).toBe(investigationPasswordSchemaVersion);
      const storedAccount = reader.prepare("SELECT * FROM investigation_password_accounts").get();
      expect(storedAccount?.password_hash).toMatch(/^\$scrypt\$N=32768,r=8,p=3\$/u);
      expect(JSON.stringify(storedAccount)).not.toContain(password);
      const storedSession = reader.prepare("SELECT * FROM investigation_password_sessions").get();
      expect(storedSession?.token_sha256).toBe(
        createHash("sha256")
          .update(session?.token ?? "")
          .digest("hex"),
      );
      expect(JSON.stringify(storedSession)).not.toContain(session?.token);
      expect(reader.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    } finally {
      reader.close();
    }

    const reopened = open(path);
    expect(reopened.getSession(session?.token ?? "")?.account).toEqual(admin);
    expect(
      await reopened.initializeBootstrap({ username: "overwrite", password: replacement }),
    ).toBeNull();
    expect(reopened.listAccounts()).toEqual([admin]);
  });

  it("rejects legacy and altered schemas without creating password tables", async () => {
    const legacyPath = await databasePath();
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(
      "CREATE TABLE investigation_auth_metadata (version TEXT PRIMARY KEY NOT NULL) STRICT",
    );
    legacy.exec("INSERT INTO investigation_auth_metadata VALUES ('investigation-auth-v1')");
    legacy.close();
    expect(() => open(legacyPath)).toThrow(
      expect.objectContaining({ code: "incompatible_schema" }),
    );
    const reader = new DatabaseSync(legacyPath, { readOnly: true });
    try {
      expect(reader.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([
        { name: "investigation_auth_metadata" },
      ]);
    } finally {
      reader.close();
    }

    const alteredPath = await databasePath();
    open(alteredPath).close();
    const altered = new DatabaseSync(alteredPath);
    altered.exec("UPDATE investigation_password_metadata SET version = 'unknown-password-schema'");
    altered.close();
    expect(() => open(alteredPath)).toThrow(
      expect.objectContaining({ code: "incompatible_schema" }),
    );
  });

  it("requires a bootstrap administrator and initializes an empty database only once", async () => {
    const store = open();
    await expect(store.initializeBootstrap()).rejects.toMatchObject({ code: "bootstrap_required" });
    const results = await Promise.all([
      store.initializeBootstrap({ username: "admin-one", password }),
      store.initializeBootstrap({ username: "admin-two", password: replacement }),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(store.listAccounts()).toHaveLength(1);
    expect(store.listAccounts()[0]).toMatchObject({ enabled: true, isAdmin: true, version: 1 });
  });

  it("never reapplies bootstrap credentials, access, or enabled state after reopening", async () => {
    const path = await databasePath();
    const store = open(path);
    const admin = await bootstrap(store);
    const backup = await store.createAccount(actor(admin), {
      username: "backup-admin",
      password,
      isAdmin: true,
    });
    const accessChanged = store.updateAccount(actor(backup), admin.id, admin.version, {
      repositoryIds: ["repo-2"],
      permissions: ["action:execute"],
      actionCapabilities: ["close"],
      allowRepositoryExecution: true,
    });
    const passwordChanged = await store.adminResetPassword(
      actor(backup),
      admin.id,
      accessChanged.version,
      replacement,
    );
    const disabled = store.updateAccount(actor(backup), admin.id, passwordChanged.version, {
      enabled: false,
    });
    store.close();

    const reopened = open(path);
    expect(
      await reopened.initializeBootstrap({
        username: "admin",
        password,
        repositoryIds: ["repo-1"],
        permissions: ["task:create"],
        enabled: true,
      }),
    ).toBeNull();
    expect(reopened.getAccount(admin.id)).toEqual(disabled);
    expect(await reopened.authenticate("admin", replacement)).toBeNull();
    const enabled = reopened.updateAccount(actor(backup), admin.id, disabled.version, {
      enabled: true,
    });
    expect(await reopened.authenticate("admin", password)).toBeNull();
    expect((await reopened.authenticate("admin", replacement))?.account).toEqual(enabled);
  });

  it("normalizes unique ASCII usernames and preserves password whitespace", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const exactPassword = "  Deliberately spaced password  ";
    const member = await store.createAccount(actor(admin), {
      username: "  Mixed.CASE-1  ",
      password: exactPassword,
    });
    expect(member.username).toBe("mixed.case-1");
    expect(member).toMatchObject({
      isAdmin: false,
      enabled: true,
      repositoryIds: [],
      permissions: [],
    });
    expect(await store.authenticate("MIXED.CASE-1", exactPassword)).not.toBeNull();
    expect(await store.authenticate("mixed.case-1", exactPassword.trim())).toBeNull();
    await expect(
      store.createAccount(actor(admin), { username: "MIXED.case-1", password }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.createAccount(actor(admin), { username: "Kelvin", password }),
    ).rejects.toMatchObject({ code: "invalid_account" });
    await expect(
      store.createAccount(actor(admin), { username: "short-password", password: "short" }),
    ).rejects.toMatchObject({ code: "invalid_password" });
  });

  it("uses dummy verification for missing, malformed, and disabled accounts", async () => {
    const store = open();
    const admin = await bootstrap(store);
    await store.createAccount(actor(admin), { username: "disabled", password, enabled: false });
    const verify = vi.spyOn(InvestigationPasswordKdf.prototype, "verify").mockResolvedValue(false);
    expect(await store.authenticate("unknown", password)).toBeNull();
    expect(await store.authenticate("!!!", password)).toBeNull();
    expect(await store.authenticate("disabled", password)).toBeNull();
    expect(verify.mock.calls).toEqual([
      [password, null],
      [password, null],
      [password, null],
    ]);
  });

  it("expires sessions and revokes logout tokens without retaining raw tokens", async () => {
    let now = Date.UTC(2026, 8, 15);
    const store = open(":memory:", { sessionTtlMs: 1_000, now: () => now });
    await bootstrap(store);
    const first = await store.authenticate("admin", password);
    const second = await store.authenticate("admin", password);
    expect(store.getSession(first?.token ?? "")).not.toBeNull();
    expect(store.getSession("invalid")).toBeNull();
    store.logout(first?.token ?? "");
    expect(store.getSession(first?.token ?? "")).toBeNull();
    expect(store.getSession(second?.token ?? "")).not.toBeNull();
    now += 1_000;
    expect(store.getSession(second?.token ?? "")).toBeNull();
    store.reapExpired();
    now -= 1_000;
    expect(store.getSession(second?.token ?? "")).toBeNull();
  });

  it("does not revive an observed expired session after restart and clock rollback", async () => {
    const path = await databasePath();
    let now = Date.UTC(2026, 8, 15);
    const options = { sessionTtlMs: 1_000, now: () => now };
    const store = open(path, options);
    await bootstrap(store);
    const session = await store.authenticate("admin", password);
    now += 1_000;
    expect(store.getSession(session?.token ?? "")).toBeNull();
    store.close();
    now -= 500;

    const reopened = open(path, options);
    expect(reopened.getSession(session?.token ?? "")).toBeNull();
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT count(*) AS count FROM investigation_password_sessions").get()
          ?.count,
      ).toBe(1);
    } finally {
      reader.close();
    }
  });

  it("checks administrator authority and account versions within account mutations", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const member = await store.createAccount(actor(admin), { username: "member", password });
    await expect(
      store.createAccount(actor(member), { username: "forbidden", password }),
    ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(() => store.listAccountsForAdmin(actor(member))).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    const changed = store.updateAccount(actor(admin), member.id, member.version, {
      displayName: "Changed",
    });
    expect(changed.version).toBe(member.version + 1);
    expect(() =>
      store.updateAccount(actor(admin), member.id, member.version, { displayName: "Stale" }),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() =>
      store.updateAccount(actor(admin), "missing-account", 1, { enabled: false }),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(store.getAccount(member.id)?.displayName).toBe("Changed");
    const rename = { displayName: "Renamed" };
    Reflect.set(rename, "username", "renamed-user");
    expect(() => store.updateAccount(actor(admin), member.id, changed.version, rename)).toThrow(
      expect.objectContaining({ code: "invalid_account" }),
    );
    expect(store.getAccount(member.id)?.username).toBe("member");
  });

  it("revokes every session when access changes or an account is disabled", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const member = await store.createAccount(actor(admin), { username: "member", password });
    const first = await store.authenticate("member", password);
    const second = await store.authenticate("member", password);
    const changed = store.updateAccount(actor(admin), member.id, member.version, {
      repositoryIds: ["repo-2"],
      permissions: ["task:cancel"],
      actionCapabilities: ["comment"],
      allowRepositoryExecution: true,
    });
    expect(store.getSession(first?.token ?? "")).toBeNull();
    expect(store.getSession(second?.token ?? "")).toBeNull();
    const third = await store.authenticate("member", password);
    expect(third?.account).toEqual(changed);
    store.updateAccount(actor(admin), member.id, changed.version, { enabled: false });
    expect(store.getSession(third?.token ?? "")).toBeNull();
    expect(await store.authenticate("member", password)).toBeNull();
  });

  it("checks the persisted account version and enabled state on every session lookup", async () => {
    const path = await databasePath();
    const store = open(path);
    const admin = await bootstrap(store);
    const session = await store.authenticate("admin", password);
    const fixture = new DatabaseSync(path);
    try {
      fixture
        .prepare("UPDATE investigation_password_accounts SET version = version + 1 WHERE id = ?")
        .run(admin.id);
      expect(
        fixture.prepare("SELECT count(*) AS count FROM investigation_password_sessions").get()
          ?.count,
      ).toBe(1);
      expect(store.getSession(session?.token ?? "")).toBeNull();
      fixture
        .prepare("UPDATE investigation_password_accounts SET version = ?, enabled = 0 WHERE id = ?")
        .run(admin.version, admin.id);
      expect(store.getSession(session?.token ?? "")).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it("protects the last enabled administrator across self-demotion and disable operations", async () => {
    const store = open();
    const admin = await bootstrap(store);
    expect(() =>
      store.updateAccount(actor(admin), admin.id, admin.version, { enabled: false }),
    ).toThrow(expect.objectContaining({ code: "last_admin" }));
    expect(() =>
      store.updateAccount(actor(admin), admin.id, admin.version, { isAdmin: false }),
    ).toThrow(expect.objectContaining({ code: "last_admin" }));
    const second = await store.createAccount(actor(admin), {
      username: "admin-two",
      password,
      isAdmin: true,
    });
    const demoted = store.updateAccount(actor(second), admin.id, admin.version, { isAdmin: false });
    expect(demoted.isAdmin).toBe(false);
    expect(() => store.listAccountsForAdmin(actor(admin))).toThrow(
      expect.objectContaining({ code: "unauthorized" }),
    );
    expect(() =>
      store.updateAccount(actor(second), second.id, second.version, { enabled: false }),
    ).toThrow(expect.objectContaining({ code: "last_admin" }));
    expect(store.getAccount(second.id)).toEqual(second);
  });

  it("allows only one of two connections to disable or demote the remaining administrators", async () => {
    const path = await databasePath();
    const first = open(path);
    const admin = await bootstrap(first);
    const backup = await first.createAccount(actor(admin), {
      username: "backup-admin",
      password,
      isAdmin: true,
    });
    const second = open(path);
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() =>
        first.updateAccount(actor(admin), admin.id, admin.version, { enabled: false }),
      ),
      Promise.resolve().then(() =>
        second.updateAccount(actor(backup), backup.id, backup.version, { isAdmin: false }),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "last_admin" } });
    expect(
      first.listAccounts().filter((account) => account.enabled && account.isAdmin),
    ).toHaveLength(1);
  });

  it("resets passwords and invalidates all previous sessions", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const member = await store.createAccount(actor(admin), { username: "member", password });
    const session = await store.authenticate("member", password);
    const reset = await store.adminResetPassword(
      actor(admin),
      member.id,
      member.version,
      replacement,
    );
    expect(reset.version).toBe(member.version + 1);
    expect(store.getSession(session?.token ?? "")).toBeNull();
    expect(await store.authenticate("member", password)).toBeNull();
    expect((await store.authenticate("member", replacement))?.account).toEqual(reset);
  });

  it("requires the current password for self-service changes and revokes the current session", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const session = await store.authenticate("admin", password);
    await expect(
      store.changeOwnPassword(actor(admin), replacement, "Another new password 3"),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(store.getSession(session?.token ?? "")).not.toBeNull();
    const changed = await store.changeOwnPassword(actor(admin), password, replacement);
    expect(changed.version).toBe(2);
    expect(store.getSession(session?.token ?? "")).toBeNull();
    expect(await store.authenticate("admin", password)).toBeNull();
    expect((await store.authenticate("admin", replacement))?.account).toEqual(changed);
  });

  it("rejects a login when an account changes while its password is being verified", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const member = await store.createAccount(actor(admin), { username: "member", password });
    const verification = deferred<boolean>();
    vi.spyOn(InvestigationPasswordKdf.prototype, "verify").mockReturnValue(verification.promise);
    const pending = store.authenticate("member", password);
    store.updateAccount(actor(admin), member.id, member.version, { enabled: false });
    verification.resolve(true);
    expect(await pending).toBeNull();
  });

  it("rechecks administrator authority after asynchronous password derivation", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const second = await store.createAccount(actor(admin), {
      username: "admin-two",
      password,
      isAdmin: true,
    });
    const derivation = deferred<string>();
    vi.spyOn(InvestigationPasswordKdf.prototype, "hash").mockReturnValue(derivation.promise);
    const pending = store.createAccount(actor(admin), { username: "pending-user", password });
    store.updateAccount(actor(second), admin.id, admin.version, { isAdmin: false });
    derivation.resolve("unused-derived-password-hash");
    await expect(pending).rejects.toMatchObject({ code: "unauthorized" });
    expect(store.listAccounts().map((account) => account.username)).not.toContain("pending-user");
  });

  it("rejects password replacement when the target changes during derivation", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const member = await store.createAccount(actor(admin), { username: "member", password });
    const derivation = deferred<string>();
    vi.spyOn(InvestigationPasswordKdf.prototype, "hash").mockReturnValue(derivation.promise);
    const pending = store.adminResetPassword(actor(admin), member.id, member.version, replacement);
    store.updateAccount(actor(admin), member.id, member.version, { enabled: false });
    derivation.resolve("unused-derived-password-hash");
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
  });

  it("recovers only existing enabled administrators without changing their access", async () => {
    const store = open();
    const admin = await bootstrap(store);
    const member = await store.createAccount(actor(admin), { username: "member", password });
    const session = await store.authenticate("admin", password);
    await expect(store.resetAdministratorOffline("unknown", replacement)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      store.resetAdministratorOffline(member.username, replacement),
    ).rejects.toMatchObject({ code: "forbidden" });
    const recovered = await store.resetAdministratorOffline(" ADMIN ", replacement);
    expect(recovered).toEqual({ ...admin, version: 2, updatedAt: expect.any(String) });
    expect(store.getSession(session?.token ?? "")).toBeNull();
    expect((await store.authenticate("admin", replacement))?.account).toEqual(recovered);
  });
});
