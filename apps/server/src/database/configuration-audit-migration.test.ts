import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const filename = "0023_configuration_audit_reads.sql";
const migrationSql = readFileSync(join(migrationsDirectory, filename), "utf8");
const auditTables = ["repository_configuration_audit", "prompt_configuration_audit"] as const;
const databases: DatabaseSync[] = [];
const directories: string[] = [];
const now = "2026-09-07T00:00:00.000Z";
const digest = "a".repeat(64);
type AuditTable = (typeof auditTables)[number];
type Row = Record<string, SQLInputValue>;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function open(): DatabaseSync {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(database);
  database.exec(
    "PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF",
  );
  return database;
}

function migrationDirectory(version: number): string {
  const directory = mkdtempSync(join(tmpdir(), "configuration-audit-migration-"));
  directories.push(directory);
  for (const entry of readdirSync(migrationsDirectory)) {
    if (/^\d+_.*\.sql$/u.test(entry) && Number.parseInt(entry, 10) <= version)
      copyFileSync(join(migrationsDirectory, entry), join(directory, entry));
  }
  return directory;
}

function insert(
  database: DatabaseSync,
  table: string,
  row: Row,
  statement = "INSERT",
  suffix = "",
): void {
  database
    .prepare(`${statement} INTO ${table} (${Object.keys(row).join(", ")})
      VALUES (${Object.keys(row)
        .map(() => "?")
        .join(", ")}) ${suffix}`)
    .run(...Object.values(row));
}

function rows(database: DatabaseSync, table: string, order = "id") {
  return database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
}

function auditRow(table: AuditTable, number = 1): Row {
  const common = {
    id: `${table}-${number}`,
    repository_id: "repository-1",
    actor_issuer: "https://identity.example.test",
    actor_subject: "operator-1",
    created_at: now,
  };
  return table === "repository_configuration_audit"
    ? {
        ...common,
        action: "legacy_configuration_changed",
        version: number - 2,
        configuration_json:
          ' {\n  "z": 1e+02, "a": "\\u0061", "a": "duplicate key", "text": "caf\u00e9 \ud83d\ude80"\n}\r\n ',
      }
    : {
        ...common,
        action: "draft_saved",
        entity_id: `template-${number}`,
        detail_json:
          '{ "z": [true, null], "a": "\\u0061", "a": "duplicate key", "text": "caf\u00e9 \ud83d\ude80" }\r\n',
      };
}

function seedConfiguration(database: DatabaseSync): void {
  for (const number of [1, 2]) {
    insert(database, "managed_repositories", {
      id: `repository-${number}`,
      github_repository_id: number,
      full_name: `example/repository-${number}`,
      enabled: number - 1,
      version: number,
      connection_status: "unknown",
      metadata_json: ' { "preserved": true }\n',
      configuration_source: "operator",
      created_at: now,
      updated_at: now,
    });
  }
  insert(database, "repository_configuration_bootstrap", {
    bootstrap_key: "legacy-bootstrap",
    completed_at: now,
  });
  insert(database, "prompt_templates", {
    id: "template-1",
    name: "Legacy prompt",
    description: "Retained prompt template.",
    workflow_kind: "pr_static_build",
    version: 1,
    draft_revision: 1,
    draft_content: "Retain every historical byte.\r\n",
    draft_output_schema_version: "PrReviewPlanV2",
    created_at: now,
    updated_at: now,
  });
  insert(database, "prompt_versions", {
    id: "prompt-1",
    template_id: "template-1",
    version: 1,
    source_draft_revision: 1,
    content: "Retain every historical byte.\r\n",
    content_sha256: digest,
    output_schema_version: "PrReviewPlanV2",
    created_at: now,
    published_at: now,
    created_by: "legacy-operator",
  });
  for (const repositoryId of [null, "repository-1"]) {
    const scopeKey = repositoryId === null ? "global" : `repository:${repositoryId}`;
    insert(database, "prompt_bindings", {
      scope_key: scopeKey,
      repository_id: repositoryId,
      workflow_kind: "pr_static_build",
      prompt_version_id: "prompt-1",
      version: 1,
      updated_at: now,
    });
    insert(database, "prompt_binding_history", {
      id: `prompt-history-${scopeKey}`,
      scope_key: scopeKey,
      repository_id: repositoryId,
      workflow_kind: "pr_static_build",
      prompt_version_id: "prompt-1",
      previous_version_id: null,
      version: 1,
      created_at: now,
      created_by: "legacy-operator",
    });
  }
  insert(database, "prompt_configuration_bootstrap", {
    workflow_kind: "pr_static_build",
    prompt_version_id: "prompt-1",
    created_at: now,
  });
  insert(database, "validation_profiles", {
    id: "profile-1",
    repository_id: "repository-1",
    workflow_kind: "pr_static_build",
    target: "headless",
    created_at: now,
  });
  insert(database, "validation_profile_versions", {
    id: "profile-version-1",
    profile_id: "profile-1",
    version: 1,
    name: "Legacy profile",
    config_json: ' { "schemaVersion": "ValidationProfileV1" }\n',
    config_sha256: digest,
    output_schema_version: "PrReviewPlanV2",
    required: 1,
    created_at: now,
    published_at: now,
    created_by: "legacy-operator",
  });
  insert(database, "validation_profile_bindings", {
    repository_id: "repository-1",
    profile_id: "profile-1",
    profile_version_id: "profile-version-1",
    enabled: 1,
    version: 1,
    updated_at: now,
  });
  insert(database, "validation_profile_binding_history", {
    id: "profile-history-1",
    repository_id: "repository-1",
    profile_id: "profile-1",
    profile_version_id: "profile-version-1",
    previous_version_id: null,
    enabled: 1,
    version: 1,
    created_at: now,
    created_by: "legacy-operator",
  });
}

function fixture(): { database: DatabaseSync; directory: string } {
  const database = open();
  const directory = migrationDirectory(22);
  expect(runMigrations(database, directory)).toBe(22);
  seedConfiguration(database);
  for (const table of auditTables) {
    insert(database, table, auditRow(table));
    insert(database, table, {
      ...auditRow(table, 2),
      ...(table === "repository_configuration_audit"
        ? {
            repository_id: "repository-2",
            action: "\tlegacy action\0suffix\r\n",
            actor_issuer: "\0legacy issuer\n",
            actor_subject: " legacy subject\0suffix ",
            configuration_json: " [ 1, true, null, 1.000 ] \r\n",
          }
        : {
            repository_id: null,
            entity_id: "global-entity\0suffix",
            detail_json: '{ "scope": "global", "nested": { "extra": 1 } }\n',
          }),
    });
  }
  return { database, directory };
}

function auditBytes(database: DatabaseSync, table: AuditTable) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return database
    .prepare(
      `SELECT ${columns
        .flatMap(({ name }) => [`typeof(${name}) AS ${name}_type`, `hex(${name}) AS ${name}_hex`])
        .join(", ")} FROM ${table} ORDER BY id`,
    )
    .all();
}

function auditDefinition(database: DatabaseSync, table: AuditTable) {
  const definition = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string };
  return {
    columns: database.prepare(`PRAGMA table_xinfo(${table})`).all(),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${table})`).all(),
    constraints: definition.sql
      .slice(definition.sql.indexOf("("))
      .replace(/STRICT(?:,\s*WITHOUT ROWID)?$/u, "STRICT"),
  };
}

function auditObjects(database: DatabaseSync, table: AuditTable) {
  return database
    .prepare(`SELECT type, name, sql FROM sqlite_schema
      WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name`)
    .all(table);
}

function otherState(database: DatabaseSync) {
  const schema = database
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE tbl_name NOT IN ('repository_configuration_audit', 'prompt_configuration_audit')
      ORDER BY type, name`)
    .all();
  const tables = database
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name NOT IN ('repository_configuration_audit', 'prompt_configuration_audit') ORDER BY name`)
    .all() as { name: string }[];
  return {
    schema,
    tables: tables.map(({ name }) => {
      const identifier = `"${name.replaceAll('"', '""')}"`;
      const columns = database.prepare(`PRAGMA table_info(${identifier})`).all();
      return {
        name,
        rows: database
          .prepare(`SELECT * FROM ${identifier} ${name === "schema_migrations" ? "WHERE version <= 22" : ""}
            ORDER BY ${columns.map((_, index) => index + 1).join(", ")}`)
          .all(),
      };
    }),
  };
}

function expectForeignKeys(database: DatabaseSync): void {
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(database.prepare("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

function expectStorage(database: DatabaseSync): void {
  expect(
    database
      .prepare(`SELECT name, wr, strict FROM pragma_table_list
        WHERE name IN ('repository_configuration_audit', 'prompt_configuration_audit') ORDER BY name`)
      .all(),
  ).toEqual([
    { name: "prompt_configuration_audit", wr: 1, strict: 1 },
    { name: "repository_configuration_audit", wr: 1, strict: 1 },
  ]);
  expect(
    database
      .prepare(`SELECT name, "desc" FROM pragma_index_xinfo('ix_prompt_configuration_audit_repository')
        WHERE "key" = 1 ORDER BY seqno`)
      .all(),
  ).toEqual([
    { name: "repository_id", desc: 0 },
    { name: "created_at", desc: 1 },
    { name: "id", desc: 1 },
  ]);
  expectForeignKeys(database);
}

describe("repository scheduling limits audit migration compatibility", () => {
  it("preserves every historical audit byte and audit schema object during the limits upgrade", () => {
    const database = open();
    expect(runMigrations(database, migrationDirectory(24))).toBe(24);
    seedConfiguration(database);
    for (const table of auditTables) {
      insert(database, table, auditRow(table));
      insert(database, table, {
        ...auditRow(table, 2),
        ...(table === "repository_configuration_audit"
          ? { configuration_json: " [ 1, true, null, 1.000 ] \r\n" }
          : { repository_id: null, detail_json: '{ "scope": "global" }\r\n' }),
      });
    }
    const previous = auditTables.map((table) => ({
      table,
      rows: rows(database, table),
      bytes: auditBytes(database, table),
      definition: auditDefinition(database, table),
      objects: auditObjects(database, table),
    }));
    const repositories = rows(database, "managed_repositories");
    expect(runMigrations(database, migrationDirectory(25))).toBe(25);
    expect(rows(database, "managed_repositories")).toEqual(
      repositories.map((repository) => ({
        ...repository,
        max_active_leases: null,
        max_queued_jobs: null,
      })),
    );
    for (const before of previous) {
      expect(rows(database, before.table)).toEqual(before.rows);
      expect(auditBytes(database, before.table)).toEqual(before.bytes);
      expect(auditDefinition(database, before.table)).toEqual(before.definition);
      expect(auditObjects(database, before.table)).toEqual(before.objects);
    }
    expect(runMigrations(database, migrationDirectory(25))).toBe(25);
    for (const before of previous)
      expect(auditBytes(database, before.table)).toEqual(before.bytes);
    expectForeignKeys(database);
  });
});

describe("configuration audit migration", () => {
  // This historical upgrade ends at M23; unrelated later migrations have their own fixtures.
  it("preserves raw legacy rows, text bytes, constraints, and every unrelated schema object and row", () => {
    const { database } = fixture();
    const previous = auditTables.map((table) => ({
      table,
      rows: rows(database, table),
      bytes: auditBytes(database, table),
      definition: auditDefinition(database, table),
      objects: auditObjects(database, table),
    }));
    const unrelated = otherState(database);
    expect(runMigrations(database, migrationDirectory(23))).toBe(23);
    for (const before of previous) {
      expect(rows(database, before.table)).toEqual(before.rows);
      expect(auditBytes(database, before.table)).toEqual(before.bytes);
      expect(auditDefinition(database, before.table)).toEqual(before.definition);
      const objects = auditObjects(database, before.table);
      expect(objects).toEqual(expect.arrayContaining(before.objects));
      expect(objects).toHaveLength(
        before.objects.length + (before.table === "repository_configuration_audit" ? 1 : 2),
      );
    }
    expect(otherState(database)).toEqual(unrelated);
    expectStorage(database);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    for (const version of [12, 13]) {
      const originalFilename = readdirSync(migrationsDirectory).find((entry) =>
        entry.startsWith(`00${version}_`),
      );
      expect(originalFilename).toBeDefined();
      const checksum = createHash("sha256")
        .update(readFileSync(join(migrationsDirectory, originalFilename ?? ""), "utf8"))
        .digest("hex");
      expect(
        database.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(version),
      ).toEqual({ checksum });
    }
  });

  it("runs a fresh installation and repeats it without rewriting the migration ledger", () => {
    const database = open();
    expect(runMigrations(database, migrationDirectory(23))).toBe(23);
    expectStorage(database);
    seedConfiguration(database);
    for (const table of auditTables) {
      insert(database, table, auditRow(table));
      expect(() => insert(database, table, auditRow(table), "REPLACE")).toThrow(/replaced/u);
    }
    const ledger = rows(database, "schema_migrations", "version");
    expect(runMigrations(database, migrationDirectory(23))).toBe(23);
    expect(rows(database, "schema_migrations", "version")).toEqual(ledger);
    expectForeignKeys(database);
  });

  it.each(auditTables)("rolls back the full upgrade after dropping %s", (table) => {
    const { database, directory } = fixture();
    const previous = auditTables.map((name) => ({
      name,
      rows: rows(database, name),
      objects: auditObjects(database, name),
      definition: auditDefinition(database, name),
    }));
    const unrelated = otherState(database);
    writeFileSync(
      join(directory, filename),
      migrationSql.replace(
        `DROP TABLE ${table};`,
        `DROP TABLE ${table}; SELECT * FROM deliberately_missing_m23_table;`,
      ),
    );
    expect(() => runMigrations(database, directory)).toThrow(/deliberately_missing_m23_table/u);
    for (const before of previous) {
      expect(rows(database, before.name)).toEqual(before.rows);
      expect(auditDefinition(database, before.name)).toEqual(before.definition);
      expect(auditObjects(database, before.name)).toEqual(before.objects);
      expect(() => database.exec(`DELETE FROM ${before.name}`)).toThrow(/immutable/u);
    }
    expect(otherState(database)).toEqual(unrelated);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual(
      { version: 22 },
    );
    expectForeignKeys(database);
    expect(runMigrations(database, migrationDirectory(23))).toBe(23);
    expectStorage(database);
  });

  it.each(["0012_managed_repositories.sql", "0013_prompt_profiles.sql", filename])(
    "rejects a changed checksum for applied migration %s",
    (changedFilename) => {
      const database = open();
      const directory = migrationDirectory(23);
      expect(runMigrations(database, directory)).toBe(23);
      const ledger = rows(database, "schema_migrations", "version");
      const path = join(directory, changedFilename);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n-- Deliberate checksum mismatch.\n`);
      expect(() => runMigrations(database, directory)).toThrow(/does not match/u);
      expect(rows(database, "schema_migrations", "version")).toEqual(ledger);
      expectStorage(database);
    },
  );

  describe.each([0, 1])("with recursive_triggers = %i", (recursiveTriggers) => {
    it.each(auditTables)("rejects every replacement and mutation of %s", (table) => {
      const { database } = fixture();
      const legacyRowId = database
        .prepare(`SELECT rowid FROM ${table} WHERE id = ?`)
        .get(auditRow(table).id ?? null) as { rowid: number };
      expect(runMigrations(database, migrationDirectory(23))).toBe(23);
      database.exec(`PRAGMA recursive_triggers = ${recursiveTriggers}`);
      const before = auditBytes(database, table);
      const replacement = {
        ...auditRow(table),
        actor_subject: "replacement-operator",
      };
      for (const statement of ["INSERT", "INSERT OR IGNORE", "INSERT OR REPLACE", "REPLACE"]) {
        expect(() => insert(database, table, replacement, statement)).toThrow(/replaced/u);
        expect(auditBytes(database, table)).toEqual(before);
      }
      for (const suffix of [
        "ON CONFLICT(id) DO UPDATE SET actor_subject = excluded.actor_subject",
        "ON CONFLICT(id) DO UPDATE SET id = 'replacement-id'",
        "ON CONFLICT(id) DO NOTHING",
      ]) {
        expect(() => insert(database, table, replacement, "INSERT", suffix)).toThrow(/replaced/u);
        expect(auditBytes(database, table)).toEqual(before);
      }
      for (const change of [
        "actor_subject = 'replacement-operator'",
        "id = id",
        "id = 'replacement-id'",
      ]) {
        expect(() => database.exec(`UPDATE ${table} SET ${change}`)).toThrow(/immutable/u);
        expect(auditBytes(database, table)).toEqual(before);
      }
      expect(() =>
        database
          .prepare(`UPDATE OR REPLACE ${table} SET id = ? WHERE id = ?`)
          .run(auditRow(table, 2).id ?? null, auditRow(table).id ?? null),
      ).toThrow(/immutable/u);
      expect(() => database.exec(`DELETE FROM ${table}`)).toThrow(/immutable/u);
      expect(auditBytes(database, table)).toEqual(before);
      for (const alias of ["rowid", "_rowid_", "oid"]) {
        expect(() => database.prepare(`SELECT ${alias} FROM ${table}`)).toThrow(/no such column/u);
        for (const statement of ["INSERT OR REPLACE", "REPLACE"]) {
          expect(() =>
            insert(
              database,
              table,
              { [alias]: legacyRowId.rowid, ...auditRow(table, 3) },
              statement,
            ),
          ).toThrow(/no column named/u);
        }
        expect(() => database.exec(`UPDATE OR REPLACE ${table} SET ${alias} = 1`)).toThrow(
          /no such column/u,
        );
        expect(auditBytes(database, table)).toEqual(before);
      }
      insert(database, table, auditRow(table, 3), "INSERT OR REPLACE");
      insert(database, table, auditRow(table, 4), "REPLACE");
      expect(rows(database, table)).toHaveLength(4);
      expect(auditBytes(database, table).slice(0, 2)).toEqual(before);
      expectForeignKeys(database);
    });
  });
});
