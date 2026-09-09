import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  OperatorAccessContextSchema,
  type OperatorPrincipal,
  type OperatorRepositoryPermission,
  type OperatorRepositoryRole,
  RepositoryAccessAuditListResponseSchema,
  RepositoryAccessChangeResponseSchema,
  RepositoryAccessListResponseSchema,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";
import {
  assertPlatformAdministrator,
  assertRepositoryPermission,
  handleOperatorAccessRequest,
  isOperatorAccessOperation,
  isPlatformAdministrator,
  type OperatorAccessOperation,
  type OperatorAccessOperationMap,
  type OperatorAccessRequest,
  repositoryReadSql,
} from "./operator-access.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const now = "2026-09-07T12:00:00.000Z";
const later = "2026-09-07T12:01:00.000Z";
const root = { issuer: "https://identity.example.test", subject: "root" };
const otherRoot = { ...root, subject: "other-root" };
const user = { ...root, subject: "user" };
const otherUser = { ...root, subject: "other-user" };
const repositoryId = "repository-1";
const secondRepositoryId = "repository-2";
const databases: DatabaseSync[] = [];
const directories: string[] = [];
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function createDatabase(directory = migrationsDirectory): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON");
  runMigrations(database, directory);
  for (const [index, id] of [repositoryId, secondRepositoryId].entries())
    database
      .prepare(`INSERT INTO managed_repositories
      (id, github_repository_id, full_name, enabled, version, connection_status, configuration_source, created_at, updated_at)
      VALUES (?, ?, ?, 0, 1, 'unknown', 'discovered', ?, ?)`)
      .run(id, index + 1, `example/project-${index + 1}`, now, now);
  return database;
}

function execute<K extends OperatorAccessOperation>(
  database: DatabaseSync,
  operation: K,
  input: OperatorAccessOperationMap[K]["input"],
  administrators: readonly OperatorPrincipal[] = [root],
  timestamp = now,
): OperatorAccessOperationMap[K]["output"] {
  return handleOperatorAccessRequest(
    database,
    { operation, input } as OperatorAccessRequest,
    timestamp,
    administrators,
  ) as OperatorAccessOperationMap[K]["output"];
}
function change(
  database: DatabaseSync,
  role: OperatorRepositoryRole | null,
  options: {
    actor?: OperatorPrincipal;
    principal?: OperatorPrincipal;
    repositoryId?: string;
    expectedVersion?: number;
    changeId?: string;
    reason?: string;
    administrators?: readonly OperatorPrincipal[];
    timestamp?: string;
  } = {},
) {
  return execute(
    database,
    "changeRepositoryAccess",
    {
      actor: options.actor ?? root,
      repositoryId: options.repositoryId ?? repositoryId,
      request: {
        principal: options.principal ?? user,
        role,
        expectedVersion: options.expectedVersion ?? 0,
        changeId: options.changeId ?? "change-1",
        reason: options.reason ?? "Grant access for review.",
      },
    },
    options.administrators ?? [root],
    options.timestamp ?? now,
  );
}
const code = (action: () => unknown, code: string) =>
  expect(action).toThrow(expect.objectContaining({ code }));
function grantRow(database: DatabaseSync, principal = user) {
  return database
    .prepare(
      "SELECT * FROM repository_operator_grants WHERE repository_id = ? AND principal_issuer = ? AND principal_subject = ?",
    )
    .get(repositoryId, principal.issuer, principal.subject);
}

describe("repository authorization", () => {
  it("recognizes only the exact configured identity pair without using session history", () => {
    const database = createDatabase();
    for (const other of [
      user,
      { ...root, subject: "Root" },
      { ...root, issuer: root.issuer.toUpperCase() },
      { ...root, issuer: "https://other.example.test" },
    ]) {
      expect(isPlatformAdministrator(other, [root])).toBe(false);
      code(() => assertPlatformAdministrator(other, [root]), "PLATFORM_FORBIDDEN");
    }
    expect(isPlatformAdministrator(root, [root])).toBe(true);
    expect(isPlatformAdministrator(root, [])).toBe(false);
    expect(execute(database, "getOperatorAccessContext", { actor: user })).toEqual({
      principal: user,
      platformAdministrator: false,
      repository: null,
    });
    code(
      () => execute(database, "getOperatorAccessContext", { actor: user, repositoryId }),
      "PLATFORM_NOT_FOUND",
    );
  });

  it.each([
    ["viewer", ["read"]],
    ["reviewer", ["read", "review"]],
    ["maintainer", ["read", "review", "configure"]],
    ["admin", ["read", "review", "configure", "manage_access"]],
  ] as const)("applies the current %s role to every permission", (role, allowed) => {
    const database = createDatabase();
    change(database, role);
    const permissions: readonly OperatorRepositoryPermission[] = [
      "read",
      "review",
      "configure",
      "manage_access",
    ];
    for (const permission of permissions) {
      const check = () =>
        assertRepositoryPermission(database, user, repositoryId, permission, [root]);
      if ((allowed as readonly string[]).includes(permission))
        expect(check()).toMatchObject({ role, source: "repository", permissions: allowed });
      else code(check, "PLATFORM_FORBIDDEN");
    }
    expect(
      Value.Check(
        OperatorAccessContextSchema,
        execute(database, "getOperatorAccessContext", { actor: user, repositoryId }),
      ),
    ).toBe(true);
    code(
      () => assertRepositoryPermission(database, user, secondRepositoryId, "read", [root]),
      "PLATFORM_NOT_FOUND",
    );
    code(
      () => assertRepositoryPermission(database, user, "missing-repository", "review", [root]),
      "PLATFORM_NOT_FOUND",
    );
  });

  it("allows platform recovery on paused repositories and applies a separate grant after runtime removal", () => {
    const database = createDatabase();
    change(database, "viewer", { principal: root });
    expect(
      assertRepositoryPermission(database, root, repositoryId, "manage_access", [root]),
    ).toMatchObject({ role: "admin", source: "platform" });
    expect(assertRepositoryPermission(database, root, repositoryId, "read", [])).toMatchObject({
      role: "viewer",
      source: "repository",
    });
    code(
      () => assertRepositoryPermission(database, root, repositoryId, "configure", []),
      "PLATFORM_FORBIDDEN",
    );
    code(
      () => assertRepositoryPermission(database, root, secondRepositoryId, "read", []),
      "PLATFORM_NOT_FOUND",
    );
    code(
      () => assertRepositoryPermission(database, root, "missing-repository", "read", [root]),
      "PLATFORM_NOT_FOUND",
    );
  });

  it("does not freeze access across awaits or reuse the trusted administrator array as a cache", async () => {
    const database = createDatabase();
    const administrators = [root];
    change(database, "reviewer");
    expect(
      assertRepositoryPermission(database, user, repositoryId, "review", administrators).role,
    ).toBe("reviewer");
    await Promise.resolve();
    change(database, null, { expectedVersion: 1, changeId: "revoke" });
    code(
      () => assertRepositoryPermission(database, user, repositoryId, "review", administrators),
      "PLATFORM_NOT_FOUND",
    );
    expect(isPlatformAdministrator(root, administrators)).toBe(true);
    administrators.splice(0);
    expect(isPlatformAdministrator(root, administrators)).toBe(false);
  });

  it.each([
    { issuer: "", subject: "user" },
    { ...user, subject: " user" },
    { ...user, issuer: `${user.issuer}\n` },
    { ...user, subject: "user\0" },
    { ...user, subject: "user\ud800" },
    { ...user, email: "root@example.test" },
  ])("rejects invalid or expanded principal identities: %j", (principal) => {
    code(() => isPlatformAdministrator(principal, [root]), "PLATFORM_INVALID");
  });
});

describe("ACL SQL projection", () => {
  it.each(["repository_id", "item.repository_id"])(
    "filters %s before count and pagination without correlated column capture",
    (expression) => {
      const database = createDatabase();
      database.exec("CREATE TABLE fixture_items (repository_id TEXT, github_number INTEGER)");
      database
        .prepare("INSERT INTO fixture_items VALUES (?, 1), (?, 1), (?, 2), (NULL, 99)")
        .run(repositoryId, secondRepositoryId, secondRepositoryId);
      change(database, "viewer", { repositoryId: secondRepositoryId });
      const scope = repositoryReadSql(expression, user, [root]);
      expect(scope.parameters).toEqual([user.issuer, user.subject]);
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM fixture_items AS item WHERE ${scope.sql}`)
          .get(...scope.parameters),
      ).toEqual({ count: 2 });
      expect(
        database
          .prepare(
            `SELECT github_number FROM fixture_items AS item WHERE ${scope.sql} ORDER BY github_number LIMIT 1 OFFSET 1`,
          )
          .all(...scope.parameters),
      ).toEqual([{ github_number: 2 }]);
      const platformScope = repositoryReadSql(expression, root, [root]);
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM fixture_items AS item WHERE ${platformScope.sql}`)
          .get(...platformScope.parameters),
      ).toEqual({ count: 4 });
      change(database, null, {
        repositoryId: secondRepositoryId,
        expectedVersion: 1,
        changeId: "revoke",
      });
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM fixture_items AS item WHERE ${scope.sql}`)
          .get(...scope.parameters),
      ).toEqual({ count: 0 });
    },
  );
  it.each([
    "r.id OR 1=1",
    "r.id; DELETE FROM jobs",
    "(SELECT id FROM managed_repositories)",
    "r.id--",
    "r.id\n",
    "r.id.extra",
    "",
  ])("rejects an untrusted SQL expression: %j", (expression) => {
    code(() => repositoryReadSql(expression, root, [root]), "PLATFORM_INVALID");
  });
  it("parameterizes arbitrary exact principal strings", () => {
    const database = createDatabase();
    const injected = { issuer: "issuer' OR 1=1 --", subject: "subject' OR 1=1 --" };
    const scope = repositoryReadSql("repository_id", injected, [root]);
    expect(scope.sql).not.toContain(injected.subject);
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM repository_operator_grants WHERE ${scope.sql}`)
        .get(...scope.parameters),
    ).toEqual({ count: 0 });
  });
});

describe("repository access changes and receipts", () => {
  it("retains revocation versions and replays an immutable receipt without restoring old access", () => {
    const database = createDatabase();
    const initial = change(database, "reviewer");
    expect(Value.Check(RepositoryAccessChangeResponseSchema, initial)).toBe(true);
    expect(initial.change).toMatchObject({
      principal: user,
      actor: root,
      previousRole: null,
      role: "reviewer",
      previousVersion: 0,
      version: 1,
    });
    const revoked = change(database, null, {
      expectedVersion: 1,
      changeId: "revoke",
      timestamp: later,
    });
    expect(revoked.change).toMatchObject({
      previousRole: "reviewer",
      role: null,
      previousVersion: 1,
      version: 2,
    });
    expect(grantRow(database)).toMatchObject({
      role: null,
      version: 2,
      created_at: now,
      updated_at: later,
    });
    const replay = change(database, "reviewer", { timestamp: later });
    expect(replay).toEqual({ ...initial, replayed: true });
    expect(grantRow(database)).toMatchObject({ role: null, version: 2 });
    code(() => change(database, "admin", { changeId: "stale-create" }), "PLATFORM_CONFLICT");
    const restored = change(database, "viewer", {
      expectedVersion: 2,
      changeId: "restore",
      timestamp: later,
    });
    expect(restored.change.version).toBe(3);
  });

  it("checks current authorization before revealing an old idempotency receipt", () => {
    const database = createDatabase();
    change(database, "admin");
    const options = { actor: user, principal: otherUser, changeId: "member-change" };
    change(database, "viewer", options);
    change(database, null, { expectedVersion: 1, changeId: "revoke-admin" });
    code(() => change(database, "viewer", options), "PLATFORM_NOT_FOUND");
    change(database, "viewer", { expectedVersion: 2, changeId: "read-only" });
    code(() => change(database, "viewer", options), "PLATFORM_FORBIDDEN");
  });

  it("rejects a reused change ID with another actor, target, role, reason or expected version", () => {
    const database = createDatabase();
    const administrators = [root, otherRoot];
    change(database, "viewer", { administrators });
    for (const options of [
      { actor: otherRoot },
      { principal: otherUser },
      { reason: "Different intent." },
      { expectedVersion: 1 },
    ])
      code(() => change(database, "viewer", { ...options, administrators }), "PLATFORM_CONFLICT");
    code(() => change(database, "admin", { administrators }), "PLATFORM_CONFLICT");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM repository_operator_access_audit").get(),
    ).toEqual({ count: 1 });
  });

  it("allows change IDs in distinct repository scopes without crossing their grants", () => {
    const database = createDatabase();
    const first = change(database, "viewer");
    const second = change(database, "maintainer", { repositoryId: secondRepositoryId });
    expect(first.change.repositoryId).toBe(repositoryId);
    expect(second.change.repositoryId).toBe(secondRepositoryId);
    expect(assertRepositoryPermission(database, user, repositoryId, "read", [root]).role).toBe(
      "viewer",
    );
    expect(
      assertRepositoryPermission(database, user, secondRepositoryId, "configure", [root]).role,
    ).toBe("maintainer");
  });

  it("prevents nonplatform administrators from removing the last repository administrator", () => {
    const database = createDatabase();
    change(database, "admin");
    for (const role of [null, "viewer", "reviewer", "maintainer"] as const)
      code(
        () =>
          change(database, role, { actor: user, expectedVersion: 1, changeId: `remove-${role}` }),
        "PLATFORM_CONFLICT",
      );
    change(database, "admin", { actor: user, principal: otherUser, changeId: "add-admin" });
    change(database, "viewer", { actor: user, expectedVersion: 1, changeId: "step-down" });
    code(
      () =>
        change(database, null, {
          actor: otherUser,
          principal: otherUser,
          expectedVersion: 1,
          changeId: "last-admin",
        }),
      "PLATFORM_CONFLICT",
    );
    change(database, null, {
      principal: otherUser,
      expectedVersion: 1,
      changeId: "platform-remove-last",
    });
    expect(
      assertRepositoryPermission(database, root, repositoryId, "manage_access", [root]).source,
    ).toBe("platform");
    change(database, "admin", {
      principal: otherUser,
      expectedVersion: 2,
      changeId: "platform-restore",
    });
  });

  it("lists current tombstones and immutable audit within the exact repository before pagination", () => {
    const database = createDatabase();
    change(database, "admin");
    change(database, "viewer", { principal: otherUser, changeId: "second", timestamp: later });
    change(database, null, {
      principal: otherUser,
      expectedVersion: 1,
      changeId: "revoke",
      timestamp: later,
    });
    change(database, "admin", { repositoryId: secondRepositoryId, changeId: "unrelated" });
    const grants = execute(database, "listRepositoryAccessGrants", {
      actor: user,
      repositoryId,
      page: 2,
      pageSize: 1,
    });
    expect(Value.Check(RepositoryAccessListResponseSchema, grants)).toBe(true);
    expect(grants).toMatchObject({
      total: 2,
      page: 2,
      pageSize: 1,
      items: [{ principal: user, role: "admin" }],
    });
    const audit = execute(database, "listRepositoryAccessAudit", {
      actor: user,
      repositoryId,
      page: 3,
      pageSize: 1,
    });
    expect(Value.Check(RepositoryAccessAuditListResponseSchema, audit)).toBe(true);
    expect(audit).toMatchObject({ total: 3, items: [{ changeId: "change-1" }] });
    code(
      () => execute(database, "listRepositoryAccessGrants", { actor: otherUser, repositoryId }),
      "PLATFORM_NOT_FOUND",
    );
    change(database, "viewer", {
      principal: otherUser,
      expectedVersion: 2,
      changeId: "readonly",
      timestamp: later,
    });
    code(
      () => execute(database, "listRepositoryAccessAudit", { actor: otherUser, repositoryId }),
      "PLATFORM_FORBIDDEN",
    );
  });

  it("supports a caller transaction and rolls back only the failed change savepoint", () => {
    const database = createDatabase();
    database.exec("BEGIN IMMEDIATE");
    change(database, "viewer");
    code(() => change(database, "reviewer", { changeId: "stale" }), "PLATFORM_CONFLICT");
    expect(database.isTransaction).toBe(true);
    expect(grantRow(database)).toMatchObject({ role: "viewer", version: 1 });
    database.exec("ROLLBACK");
    expect(grantRow(database)).toBeUndefined();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM repository_operator_access_audit").get(),
    ).toEqual({ count: 0 });
  });

  it.each([false, true])(
    "atomically rolls back the receipt when its projection update fails; caller transaction=%s",
    (nested) => {
      const database = createDatabase();
      change(database, "viewer");
      const before = grantRow(database);
      database.exec(
        "CREATE TRIGGER fixture_reject_grant BEFORE UPDATE ON repository_operator_grants BEGIN SELECT RAISE(ABORT, 'fixture projection rejected'); END",
      );
      if (nested) database.exec("BEGIN IMMEDIATE");
      expect(() =>
        change(database, "reviewer", { expectedVersion: 1, changeId: "failed-projection" }),
      ).toThrow(/fixture projection rejected/u);
      expect(database.isTransaction).toBe(nested);
      expect(grantRow(database)).toEqual(before);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM repository_operator_access_audit WHERE change_id = 'failed-projection'",
          )
          .get(),
      ).toEqual({ count: 0 });
      database.exec("DROP TRIGGER fixture_reject_grant");
      expect(
        change(database, "reviewer", { expectedVersion: 1, changeId: "failed-projection" }).change
          .version,
      ).toBe(2);
      if (nested) database.exec("COMMIT");
    },
  );
});

describe("ACL storage boundaries", () => {
  it("serves context and audit from a read-only database without changing grants", () => {
    const source = createDatabase();
    change(source, "admin");
    const directory = mkdtempSync(join(tmpdir(), "operator-access-readonly-"));
    directories.push(directory);
    const path = join(directory, "access.sqlite");
    source.prepare("VACUUM INTO ?").run(path);
    const reader = new DatabaseSync(path, { readOnly: true });
    databases.push(reader);
    expect(
      execute(reader, "getOperatorAccessContext", { actor: user, repositoryId }).repository?.role,
    ).toBe("admin");
    expect(execute(reader, "listRepositoryAccessGrants", { actor: user, repositoryId }).total).toBe(
      1,
    );
    expect(execute(reader, "listRepositoryAccessAudit", { actor: user, repositoryId }).total).toBe(
      1,
    );
    expect(reader.isTransaction).toBe(false);
  });

  it("rejects direct grant edits and immutable audit replacement, including recursive triggers disabled", () => {
    const database = createDatabase();
    change(database, "admin");
    database.exec("PRAGMA recursive_triggers = OFF");
    for (const table of ["repository_operator_grants", "repository_operator_access_audit"]) {
      const row = database.prepare(`SELECT * FROM ${table}`).get() as Record<string, SQLInputValue>;
      const columns = Object.keys(row);
      expect(() =>
        database
          .prepare(
            `INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(row)),
      ).toThrow();
      expect(() => database.exec(`DELETE FROM ${table}`)).toThrow();
      expect(database.prepare(`SELECT * FROM ${table}`).get()).toEqual(row);
    }
    expect(() =>
      database.exec("UPDATE repository_operator_grants SET role = 'viewer', version = version + 1"),
    ).toThrow();
    expect(() =>
      database.exec("UPDATE repository_operator_access_audit SET reason = 'Changed history'"),
    ).toThrow(/immutable/u);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    { actor: { ...root, platformAdministrator: true } },
    { administrators: [user] },
    { repositoryId: "repository-1\n" },
    {
      request: {
        changeId: "bad",
        principal: user,
        role: "owner",
        expectedVersion: 0,
        reason: "Invalid role.",
      },
    },
    {
      request: {
        changeId: "bad",
        principal: user,
        role: "viewer",
        expectedVersion: -1,
        reason: "Invalid version.",
      },
    },
    {
      request: {
        changeId: "bad",
        principal: user,
        role: "viewer",
        expectedVersion: 0,
        reason: " ",
      },
    },
  ])("rejects malformed or injected access inputs: %j", (changeInput) => {
    const database = createDatabase();
    const request = {
      operation: "changeRepositoryAccess",
      input: {
        actor: root,
        repositoryId,
        request: {
          changeId: "change",
          principal: user,
          role: "viewer",
          expectedVersion: 0,
          reason: "Test access.",
        },
        ...changeInput,
      },
    } as unknown as OperatorAccessRequest;
    code(() => handleOperatorAccessRequest(database, request, now, [root]), "PLATFORM_INVALID");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM repository_operator_access_audit").get(),
    ).toEqual({ count: 0 });
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { pageSize: 51 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
  ])("bounds list pagination: %j", (pagination) => {
    const database = createDatabase();
    code(
      () =>
        execute(database, "listRepositoryAccessGrants", {
          actor: root,
          repositoryId,
          ...pagination,
        }),
      "PLATFORM_INVALID",
    );
  });

  it("recognizes only supported operations and rejects invalid timestamps without writes", () => {
    const database = createDatabase();
    expect(isOperatorAccessOperation("changeRepositoryAccess")).toBe(true);
    expect(isOperatorAccessOperation("toString")).toBe(false);
    code(() => change(database, "viewer", { timestamp: "not-a-time" }), "PLATFORM_INVALID");
    change(database, "viewer", { timestamp: later });
    code(
      () => change(database, "reviewer", { expectedVersion: 1, changeId: "clock-backwards" }),
      "PLATFORM_CONFLICT",
    );
  });

  it("migrates M18 without inferring grants or administrators from historical sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "operator-access-m18-"));
    directories.push(directory);
    for (const filename of readdirSync(migrationsDirectory)) {
      const version = Number(/^([0-9]+)_.*\.sql$/u.exec(filename)?.[1]);
      if (version >= 1 && version <= 18)
        copyFileSync(join(migrationsDirectory, filename), join(directory, filename));
    }
    const database = createDatabase(directory);
    database
      .prepare(
        "INSERT INTO operator_sessions (token_sha256, issuer, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("a".repeat(64), user.issuer, user.subject, now, later);
    const before = database.prepare("SELECT * FROM operator_sessions").all();
    expect(runMigrations(database, migrationsDirectory)).toBeGreaterThanOrEqual(19);
    expect(database.prepare("SELECT * FROM operator_sessions").all()).toEqual(before);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM repository_operator_grants").get(),
    ).toEqual({ count: 0 });
    expect(execute(database, "getOperatorAccessContext", { actor: user })).toEqual({
      principal: user,
      platformAdministrator: false,
      repository: null,
    });
    code(
      () => assertRepositoryPermission(database, user, repositoryId, "read", [root]),
      "PLATFORM_NOT_FOUND",
    );
    expect(
      assertRepositoryPermission(database, root, repositoryId, "manage_access", [root]).source,
    ).toBe("platform");
  });
});
