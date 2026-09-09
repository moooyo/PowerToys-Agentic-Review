import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MigrationRebuildError, runPromptProfileEvaluationRebuild } from "./migration-rebuild.js";
import { runMigrations } from "./migrations.js";

const migrationDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const migrationFilename = "0028_prompt_profile_evaluations.sql";
const timestamp = "2026-09-08T00:00:00.000Z";
const digest = "a".repeat(64);
const directories: string[] = [];
const databases: DatabaseSync[] = [];
type SqlRow = Record<string, string | number | null>;
interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// This suite tests the startup mechanism with a deliberately small M28 fixture.
// It does not stand in for acceptance of the actual evaluation schema migration.
describe("controlled prompt/profile evaluation migration rebuild", () => {
  it("upgrades stored M27 runs through the actual M28 SQL without changing legacy bytes or rowids", async () => {
    const fixture = await createFixture();
    const before = readStoredRows(fixture.database);
    const completeLegacyRuns = fixture.database
      .prepare("SELECT rowid, * FROM review_runs ORDER BY rowid")
      .all();
    await installMigration(
      fixture,
      await readFile(join(migrationDirectory, migrationFilename), "utf8"),
    );

    expect(runMigrations(fixture.database, fixture.directory)).toBe(28);

    expect(readStoredRows(fixture.database)).toEqual(before);
    expect(
      fixture.database
        .prepare("SELECT rowid, * FROM review_runs ORDER BY rowid")
        .all()
        .map(({ purpose: _purpose, evaluation_cell_id: _cell, ...legacy }) => legacy),
    ).toEqual(completeLegacyRuns);
    expect(
      fixture.database
        .prepare("SELECT id, purpose, evaluation_cell_id FROM review_runs ORDER BY rowid")
        .all(),
    ).toEqual([
      { id: "run-1", purpose: "review", evaluation_cell_id: null },
      { id: "run-2", purpose: "review", evaluation_cell_id: null },
    ]);
    expect(fixture.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readForeignKeysEnabled(fixture.database)).toBe(1);
    expect(runMigrations(fixture.database, fixture.directory)).toBe(28);
    expect(readStoredRows(fixture.database)).toEqual(before);
  });

  it("rolls the actual M28 tables and parent replacement back when its transaction fails", async () => {
    const fixture = await createFixture();
    const schema = readSchema(fixture.database);
    const rows = readStoredRows(fixture.database);
    const sql = await readFile(join(migrationDirectory, migrationFilename), "utf8");
    await installMigration(fixture, `${sql}\nSELECT * FROM missing_actual_migration_fault;`);

    const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

    expect(error.committed).toBe(false);
    expect(error.message).toContain("missing_actual_migration_fault");
    expectRolledBack(fixture.database, schema, rows);
  });

  it("rebuilds the full M27 parent inside the FK-off transaction and preserves old bytes, rowids, and dependencies", async () => {
    const fixture = await createFixture();
    const { database, directory } = fixture;
    const before = readStoredRows(database);
    const childDefinitions = readSchema(database).filter(
      (row) => row.type === "table" && row.name !== "review_runs",
    );
    const windows: { transaction: boolean; foreignKeys: number }[] = [];
    database.function("observe_rebuild_window", () => {
      windows.push({
        transaction: database.isTransaction,
        foreignKeys: readForeignKeysEnabled(database),
      });
      return 1;
    });
    await installMigration(fixture, `SELECT observe_rebuild_window();\n${rebuildSql(database)}`);
    const exec = vi.spyOn(database, "exec");

    expect(runMigrations(database, directory)).toBe(28);

    expect(windows).toEqual([{ transaction: true, foreignKeys: 0 }]);
    const statements = exec.mock.calls.map(([sql]) => sql);
    const start = statements.indexOf("PRAGMA foreign_keys = OFF");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(statements[start + 1]).toBe("BEGIN IMMEDIATE");
    expect(statements.slice(-2)).toEqual(["COMMIT", "PRAGMA foreign_keys = ON"]);
    expect(readStoredRows(database)).toEqual(before);
    expect(
      readSchema(database).filter((row) => row.type === "table" && row.name !== "review_runs"),
    ).toEqual(childDefinitions);
    expect(
      database.prepare("SELECT DISTINCT migration_test_marker FROM review_runs").all(),
    ).toEqual([{ migration_test_marker: "review" }]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readForeignKeysEnabled(database)).toBe(1);
    expect(database.isTransaction).toBe(false);
    expect(() => database.exec("DELETE FROM review_runs")).toThrow("review runs are immutable");
    expect(() => database.exec("UPDATE review_runs SET plan_json = plan_json")).toThrow(
      "review runs are immutable",
    );
    expect(() =>
      database.exec(`INSERT INTO review_run_audit
      (id, review_run_id, action, actor_issuer, actor_subject, detail_json, created_at)
      VALUES ('invalid-audit', 'missing-run', 'planned', 'issuer', 'subject', '{}', '${timestamp}')`),
    ).toThrow(/FOREIGN KEY/u);
  });

  it.each(["afterCopy", "afterDrop", "afterRename"] as const)(
    "rolls back schema, bytes, rowids, and the ledger on a failure at %s",
    async (stage) => {
      const fixture = await createFixture();
      const schema = readSchema(fixture.database);
      const rows = readStoredRows(fixture.database);
      await installMigration(
        fixture,
        rebuildSql(fixture.database, { [stage]: "SELECT * FROM missing_rebuild_fault;" }),
      );

      const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

      expect(error.committed).toBe(false);
      expect(error.primaryError).toBeInstanceOf(Error);
      expect(error.message).toContain("missing_rebuild_fault");
      expect(error.rollbackError).toBeUndefined();
      expect(error.restoreError).toBeUndefined();
      expectRolledBack(fixture.database, schema, rows);
    },
  );

  it("rejects a dangling reference before commit and reads only the first foreign-key violation", async () => {
    const fixture = await createFixture();
    const schema = readSchema(fixture.database);
    const rows = readStoredRows(fixture.database);
    await installMigration(
      fixture,
      `${rebuildSql(fixture.database)}
      INSERT INTO review_run_audit (id, review_run_id, action, actor_issuer, actor_subject, detail_json, created_at)
      VALUES ('dangling-audit', 'missing-run', 'planned', 'issuer', 'subject', '{}', '${timestamp}');`,
    );
    const prepare = fixture.database.prepare.bind(fixture.database);
    const fullCheckReads = vi.fn(() => {
      throw new Error("The check must not materialize every violation.");
    });
    const firstCheckReads = vi.fn();
    vi.spyOn(fixture.database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA foreign_key_check") {
        vi.spyOn(statement, "all").mockImplementation(fullCheckReads);
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...parameters) => {
          firstCheckReads();
          return get(...parameters);
        });
      }
      return statement;
    });

    const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

    expect(error.message).toMatch(/foreign_key_check.*review_run_audit/u);
    expect(firstCheckReads).toHaveBeenCalledOnce();
    expect(fullCheckReads).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expectRolledBack(fixture.database, schema, rows);
  });

  it.each([
    ["index", "CREATE INDEX unexpected_run_index ON review_runs (created_at);"],
    [
      "trigger",
      "CREATE TRIGGER unexpected_run_trigger AFTER INSERT ON review_run_audit BEGIN SELECT id FROM review_runs; END;",
    ],
    ["view", 'CREATE VIEW unexpected_run_view AS SELECT id FROM main."REVIEW_RUNS";'],
    [
      "view sharing an allowed trigger name",
      "CREATE VIEW tr_review_run_job_links_consistency AS SELECT id FROM review_runs;",
    ],
    [
      "foreign-key child",
      'CREATE TABLE unexpected_run_child (run_id TEXT REFERENCES "REVIEW_RUNS"(id));',
    ],
    [
      "temporary trigger",
      "CREATE TEMP TRIGGER unexpected_temp_trigger AFTER INSERT ON main.review_run_audit BEGIN SELECT id FROM review_runs; END;",
    ],
  ])("fails closed on an unknown dependent %s", async (_kind, sql) => {
    const fixture = await createFixture();
    await installMigration(fixture, rebuildSql(fixture.database));
    fixture.database.exec(sql);
    const schema = readSchema(fixture.database);
    const rows = readStoredRows(fixture.database);

    const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

    expect(error.message).toMatch(
      /unknown dependent schema object|unexpected inbound foreign-key inventory/u,
    );
    expectRolledBack(fixture.database, schema, rows);
  });

  it.each([
    [
      "missing dependency",
      "DROP TRIGGER tr_review_run_job_links_consistency;",
      /missing expected trigger tr_review_run_job_links_consistency/u,
    ],
    [
      "wrong trigger owner",
      "DROP TRIGGER tr_notification_validation_terminal; CREATE TRIGGER tr_notification_validation_terminal AFTER INSERT ON review_run_audit BEGIN SELECT 1; END;",
      /missing expected trigger tr_notification_validation_terminal on jobs/u,
    ],
    [
      "unrelated schema removal",
      "DROP INDEX ix_notification_events_retention;",
      /unrelated schema object.*ix_notification_events_retention/u,
    ],
    [
      "leftover temporary reference",
      "CREATE VIEW leftover_rebuild_view AS SELECT id FROM new_review_runs;",
      /remaining new_review_runs reference/u,
    ],
    [
      "lost unique constraint",
      "DROP INDEX ix_review_runs_work_item_history; CREATE INDEX ix_review_runs_work_item_history ON review_runs (id);",
      /changed an existing index or unique constraint/u,
    ],
  ])("rejects %s after the SQL and rolls the rebuild back", async (_kind, suffix, expected) => {
    const fixture = await createFixture();
    const schema = readSchema(fixture.database);
    const rows = readStoredRows(fixture.database);
    await installMigration(fixture, `${rebuildSql(fixture.database)}\n${suffix}`);

    const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

    expect(error.message).toMatch(expected);
    expectRolledBack(fixture.database, schema, rows);
  });

  it("rejects a copy that loses existing parent rows even when the foreign-key check is clean", async () => {
    const fixture = await createFixture();
    const schema = readSchema(fixture.database);
    const rows = readStoredRows(fixture.database);
    // The second run has no child rows, so FK checking alone cannot detect this loss.
    await installMigration(
      fixture,
      rebuildSql(fixture.database, { copyPredicate: "WHERE id != 'run-2'" }),
    );

    const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

    expect(error.message).toContain("changed the existing row count: review_runs");
    expectRolledBack(fixture.database, schema, rows);
  });

  it("does not disable foreign keys or enforce the M27 inventory when the exact migration is already applied", async () => {
    const fixture = await createFixture();
    await installMigration(fixture, rebuildSql(fixture.database));
    expect(runMigrations(fixture.database, fixture.directory)).toBe(28);
    fixture.database.exec("CREATE VIEW later_run_view AS SELECT id FROM review_runs");
    const exec = vi.spyOn(fixture.database, "exec");

    expect(runMigrations(fixture.database, fixture.directory)).toBe(28);

    expect(exec.mock.calls.some(([sql]) => sql.includes("PRAGMA foreign_keys"))).toBe(false);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 28")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("keeps another version-28 filename on the ordinary FK-on migration path", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.directory, "0028_unrelated.sql"),
      "CREATE TABLE ordinary_fk_state AS SELECT foreign_keys FROM pragma_foreign_keys;",
    );
    const exec = vi.spyOn(fixture.database, "exec");

    expect(runMigrations(fixture.database, fixture.directory)).toBe(28);

    expect(fixture.database.prepare("SELECT foreign_keys FROM ordinary_fk_state").get()).toEqual({
      foreign_keys: 1,
    });
    expect(exec.mock.calls.some(([sql]) => sql.includes("PRAGMA foreign_keys"))).toBe(false);
  });

  it("rechecks the ledger in the rebuild transaction before inspecting the pending M27 inventory", async () => {
    const fixture = await createFixture();
    const sql = rebuildSql(fixture.database);
    await installMigration(fixture, sql);
    fixture.database.exec(
      "CREATE VIEW concurrently_applied_run_view AS SELECT id FROM review_runs",
    );
    const exec = fixture.database.exec.bind(fixture.database);
    const checksum = createHash("sha256").update(sql).digest("hex");
    vi.spyOn(fixture.database, "exec").mockImplementation((statement) => {
      exec(statement);
      if (statement === "PRAGMA foreign_keys = OFF") {
        // Simulate a matching ledger entry becoming visible after the initial read.
        fixture.database
          .prepare("INSERT INTO schema_migrations VALUES (28, ?, ?, ?)")
          .run(migrationFilename, checksum, timestamp);
      }
    });

    expect(runMigrations(fixture.database, fixture.directory)).toBe(28);

    expect(
      fixture.database
        .prepare(
          "SELECT name FROM pragma_table_info('review_runs') WHERE name = 'migration_test_marker'",
        )
        .get(),
    ).toBeUndefined();
    expect(readForeignKeysEnabled(fixture.database)).toBe(1);
  });

  it("rejects a conflicting ledger row introduced after BEGIN and rolls it back", async () => {
    const fixture = await createFixture();
    await installMigration(fixture, rebuildSql(fixture.database));
    const exec = fixture.database.exec.bind(fixture.database);
    let rebuildWindow = false;
    vi.spyOn(fixture.database, "exec").mockImplementation((statement) => {
      exec(statement);
      if (statement === "PRAGMA foreign_keys = OFF") rebuildWindow = true;
      if (rebuildWindow && statement === "BEGIN IMMEDIATE") {
        fixture.database
          .prepare("INSERT INTO schema_migrations VALUES (28, ?, ?, ?)")
          .run(migrationFilename, "0".repeat(64), timestamp);
      }
    });

    const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

    expect(error.message).toContain("Applied migration 28 does not match");
    expect(readVersion(fixture.database)).toBe(27);
    expect(readForeignKeysEnabled(fixture.database)).toBe(1);
  });

  it("rejects a nested transaction or initially disabled FK enforcement before invoking its callbacks", async () => {
    const { database } = await createFixture();
    const actions = { isPending: vi.fn(() => true), apply: vi.fn() };
    database.exec("BEGIN IMMEDIATE");

    expect(
      captureRebuildError(() => runPromptProfileEvaluationRebuild(database, actions)).message,
    ).toContain("requires no active transaction");
    expect(database.isTransaction).toBe(true);
    expect(readForeignKeysEnabled(database)).toBe(1);
    database.exec("ROLLBACK");
    database.exec("PRAGMA foreign_keys = OFF");
    expect(
      captureRebuildError(() => runPromptProfileEvaluationRebuild(database, actions)).message,
    ).toContain("requires PRAGMA foreign_keys = 1");
    expect(readForeignKeysEnabled(database)).toBe(0);
    expect(actions.isPending).not.toHaveBeenCalled();
    expect(actions.apply).not.toHaveBeenCalled();
  });

  it("checks the disabled readback before BEGIN and still restores enforcement on failure", async () => {
    const { database } = await createFixture();
    const exec = database.exec.bind(database);
    const actions = { isPending: vi.fn(() => true), apply: vi.fn() };
    const spy = vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql !== "PRAGMA foreign_keys = OFF") exec(sql);
    });

    const error = captureRebuildError(() => runPromptProfileEvaluationRebuild(database, actions));

    expect(error.message).toContain("requires PRAGMA foreign_keys = 0");
    expect(spy.mock.calls.map(([sql]) => sql)).toEqual([
      "PRAGMA foreign_keys = OFF",
      "PRAGMA foreign_keys = ON",
    ]);
    expect(actions.isPending).not.toHaveBeenCalled();
    expect(readForeignKeysEnabled(database)).toBe(1);
  });

  it.each(["BEGIN IMMEDIATE", "COMMIT"])(
    "restores enforcement after an injected %s failure",
    async (failingStatement) => {
      const fixture = await createFixture();
      const schema = readSchema(fixture.database);
      const rows = readStoredRows(fixture.database);
      await installMigration(fixture, rebuildSql(fixture.database));
      const exec = fixture.database.exec.bind(fixture.database);
      let rebuildWindow = false;
      vi.spyOn(fixture.database, "exec").mockImplementation((statement) => {
        if (statement === "PRAGMA foreign_keys = OFF") rebuildWindow = true;
        if (rebuildWindow && statement === failingStatement)
          throw new Error("Injected transaction failure.");
        exec(statement);
      });

      const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

      expect(error.committed).toBe(false);
      expect(error.message).toContain("Injected transaction failure");
      expectRolledBack(fixture.database, schema, rows);
    },
  );

  it("retains the primary, rollback, and FK-restoration errors when rollback itself fails", async () => {
    const fixture = await createFixture();
    await installMigration(
      fixture,
      `${rebuildSql(fixture.database)}\nSELECT * FROM missing_primary_failure;`,
    );
    const exec = fixture.database.exec.bind(fixture.database);
    const rollbackFailure = new Error("Injected rollback failure.");
    vi.spyOn(fixture.database, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw rollbackFailure;
      exec(sql);
    });

    const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

    expect(error.committed).toBe(false);
    expect(error.primaryError).toBeInstanceOf(Error);
    expect(error.rollbackError).toBe(rollbackFailure);
    expect(error.restoreError).toBeInstanceOf(Error);
    expect(error.errors).toHaveLength(3);
    expect(error.message).toMatch(
      /primary:.*missing_primary_failure.*rollback:.*Injected rollback failure.*restore:/u,
    );
    expect(fixture.database.isTransaction).toBe(true);
    expect(readForeignKeysEnabled(fixture.database)).toBe(0);
  });

  it.each(["throws", "does not take effect"])(
    "reports a committed migration as startup failure when FK restoration %s",
    async (mode) => {
      const fixture = await createFixture();
      await installMigration(fixture, rebuildSql(fixture.database));
      const exec = fixture.database.exec.bind(fixture.database);
      const spy = vi.spyOn(fixture.database, "exec").mockImplementation((sql) => {
        if (sql === "PRAGMA foreign_keys = ON") {
          if (mode === "throws") throw new Error("Injected FK restoration failure.");
          return;
        }
        exec(sql);
      });

      const error = captureRebuildError(() => runMigrations(fixture.database, fixture.directory));

      expect(error.committed).toBe(true);
      expect(error.primaryError).toBeUndefined();
      expect(error.rollbackError).toBeUndefined();
      expect(error.restoreError).toBeInstanceOf(Error);
      expect(error.message).toContain("committed but startup failed");
      expect(readVersion(fixture.database)).toBe(28);
      expect(fixture.database.isTransaction).toBe(false);
      expect(readForeignKeysEnabled(fixture.database)).toBe(0);
      expect(spy.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    },
  );
});

const createFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-controlled-rebuild-"));
  directories.push(directory);
  const filenames = (await readdir(migrationDirectory)).filter((name) => {
    const version = /^(\d+)_.*\.sql$/u.exec(name)?.[1];
    return version !== undefined && Number.parseInt(version, 10) <= 27;
  });
  await Promise.all(
    filenames.map((name) => copyFile(join(migrationDirectory, name), join(directory, name))),
  );
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA recursive_triggers = ON");
  expect(runMigrations(database, directory)).toBe(27);
  seedRows(database);
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return { database, directory };
};

const installMigration = (fixture: { directory: string }, sql: string): Promise<void> =>
  writeFile(join(fixture.directory, migrationFilename), sql);

const readSchema = (database: DatabaseSync): readonly SchemaRow[] =>
  database
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all() as unknown as SchemaRow[];

const readStoredRows = (database: DatabaseSync) => ({
  runs: database
    .prepare(`SELECT rowid, id, activation_id, plan_digest, plan_json, readiness_json,
    required_request_blockers_json, created_at FROM review_runs ORDER BY rowid`)
    .all(),
  requests: database.prepare("SELECT rowid, * FROM review_run_requests ORDER BY rowid").all(),
  audit: database.prepare("SELECT rowid, * FROM review_run_audit ORDER BY rowid").all(),
  dispatch: database
    .prepare("SELECT rowid, * FROM validation_dispatch_checks ORDER BY rowid")
    .all(),
});

const readForeignKeysEnabled = (database: DatabaseSync): number =>
  (database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
const readVersion = (database: DatabaseSync): number =>
  (
    database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    }
  ).version;

const captureRebuildError = (action: () => unknown): MigrationRebuildError => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationRebuildError);
    return error as MigrationRebuildError;
  }
  throw new Error("Expected a controlled rebuild failure.");
};

const expectRolledBack = (
  database: DatabaseSync,
  schema: readonly SchemaRow[],
  rows: ReturnType<typeof readStoredRows>,
): void => {
  expect(readVersion(database)).toBe(27);
  expect(database.isTransaction).toBe(false);
  expect(readForeignKeysEnabled(database)).toBe(1);
  expect(readSchema(database)).toEqual(schema);
  expect(readStoredRows(database)).toEqual(rows);
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
};

const rebuildSql = (
  database: DatabaseSync,
  faults: {
    afterCopy?: string;
    afterDrop?: string;
    afterRename?: string;
    copyPredicate?: string;
  } = {},
): string => {
  const schema = readSchema(database);
  const tableSql = schema.find(
    (object) => object.type === "table" && object.name === "review_runs",
  )?.sql;
  if (tableSql === null || tableSql === undefined)
    throw new Error("The fixture must contain the M27 review_runs table.");
  const create = tableSql
    .replace("CREATE TABLE review_runs", "CREATE TABLE new_review_runs")
    .replace(
      "created_at TEXT NOT NULL,",
      "created_at TEXT NOT NULL, migration_test_marker TEXT NOT NULL DEFAULT 'review',",
    );
  const columns = (
    database.prepare("SELECT name FROM pragma_table_info('review_runs') ORDER BY cid").all() as {
      name: string;
    }[]
  )
    .map(({ name }) => `"${name}"`)
    .join(", ");
  const externalTriggers = schema.filter(
    (object) =>
      object.type === "trigger" &&
      object.tbl_name !== "review_runs" &&
      /\breview_runs\b/iu.test(object.sql ?? ""),
  );
  expect(externalTriggers).toHaveLength(14);
  const ownObjects = schema.filter(
    (object) => object.tbl_name === "review_runs" && object.type !== "table" && object.sql !== null,
  );
  return [
    `${create};`,
    `INSERT INTO new_review_runs (rowid, ${columns}) SELECT rowid, ${columns} FROM review_runs ${faults.copyPredicate ?? ""};`,
    faults.afterCopy ?? "",
    ...externalTriggers.map((trigger) => `DROP TRIGGER "${trigger.name}";`),
    "DROP TABLE review_runs;",
    faults.afterDrop ?? "",
    "ALTER TABLE new_review_runs RENAME TO review_runs;",
    faults.afterRename ?? "",
    ...[...ownObjects, ...externalTriggers].map((object) => `${object.sql};`),
  ].join("\n");
};

const insertRow = (database: DatabaseSync, table: string, row: SqlRow): void => {
  const columns = Object.keys(row);
  database
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
};

const seedRows = (database: DatabaseSync): void => {
  insertRow(database, "repositories", {
    id: "repository-1",
    github_repository_id: 1,
    github_node_id: "repository-node-1",
    owner_login: "fixture",
    name: "repository",
    full_name: "fixture/repository",
    html_url: "https://example.test/fixture/repository",
    default_branch: "main",
    is_private: 0,
    snapshot_json: "{}",
    observed_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
  insertRow(database, "managed_repositories", {
    id: "repository-1",
    github_repository_id: 1,
    full_name: "fixture/repository",
    enabled: 0,
    version: 1,
    connection_status: "unknown",
    configuration_source: "discovered",
    created_at: timestamp,
    updated_at: timestamp,
  });
  insertRow(database, "work_items", {
    id: "item-1",
    repository_id: "repository-1",
    resource_kind: "pull_request",
    github_work_item_id: 1,
    github_node_id: "item-node-1",
    github_number: 1,
    state: "open",
    title: "Stored migration fixture",
    body: "Stored source bytes.\n",
    html_url: "https://example.test/fixture/repository/pull/1",
    author_github_user_id: 1,
    author_login: "author",
    author_account_type: "user",
    current_revision_key: digest,
    is_draft: 0,
    source_created_at: timestamp,
    source_updated_at: timestamp,
    snapshot_json: "{}",
    projection_source: "poll",
    observed_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
  insertRow(database, "work_item_revisions", {
    id: "revision-1",
    work_item_id: "item-1",
    revision_key: digest,
    resource_kind: "pull_request",
    base_sha: "b".repeat(40),
    head_sha: "c".repeat(40),
    source_updated_at: timestamp,
    observed_at: timestamp,
    revision_json: '{ "stored": "\\u0062ytes" }',
    created_at: timestamp,
  });
  insertRow(database, "github_events", {
    id: "event-1",
    event_key: "event-1",
    source: "poll",
    source_event_id: "event-1",
    repository_id: "repository-1",
    work_item_id: "item-1",
    revision_id: "revision-1",
    action: "request_opened",
    request_kind: "review_request",
    actor_github_user_id: 1,
    actor_login: "author",
    target_github_user_id: 2,
    target_login: "reviewer",
    occurred_at: timestamp,
    observed_at: timestamp,
    normalized_sha256: digest,
    normalized_json: "{}",
    created_at: timestamp,
  });
  insertRow(database, "authorization_decisions", {
    id: "authorization-1",
    decision_key: "authorization-1",
    github_event_id: "event-1",
    work_item_id: "item-1",
    outcome: "authorized",
    basis: "allowlist",
    reason: "authorized_allowlisted",
    policy_kind: "self_or_allowlist",
    policy_version: 1,
    actor_github_user_id: 1,
    target_github_user_id: 2,
    evaluated_at: timestamp,
    policy_json: "{}",
    policy_sha256: digest,
    decision_json: "{}",
    created_at: timestamp,
  });
  insertRow(database, "request_epochs", {
    id: "epoch-1",
    work_item_id: "item-1",
    ordinal: 1,
    request_kind: "review_request",
    target_github_user_id: 2,
    opening_event_id: "event-1",
    authorization_decision_id: "authorization-1",
    current_revision_id: "revision-1",
    status: "active",
    opened_at: timestamp,
    epoch_json: "{}",
    created_at: timestamp,
    updated_at: timestamp,
  });
  const requestJson =
    '{ "requestId": "request-1", "workflowKind": "pr_static_build", "target": "headless", "required": true, "profileVersion": null, "prompt": null }';
  for (const [id, rowid] of [
    ["run-1", 17],
    ["run-2", 9001],
  ] as const) {
    const planJson = `{ "schemaVersion": "ReviewRunExecutionPlanV1", "repository": { "id": "repository-1" }, "workItemId": "item-1", "revision": { "revisionKey": "${digest}" }, "authorization": { "requestEpochId": "epoch-1" }, "activationId": "activation-${id}", "jobs": [${requestJson}], "stored": "\\u0062ytes" }`;
    insertRow(database, "review_runs", {
      rowid,
      id,
      repository_id: "repository-1",
      work_item_id: "item-1",
      revision_id: "revision-1",
      revision_key: digest,
      request_epoch_id: "epoch-1",
      activation_id: `activation-${id}`,
      creation_intent_digest: digest,
      plan_digest: createHash("sha256").update(planJson).digest("hex"),
      plan_json: planJson,
      readiness_json: '[ { "requestId": "request-1", "reasons": [] } ]',
      required_request_blockers_json: "[ ]",
      request_count: 1,
      blocked_request_count: 0,
      required_blocker_count: 0,
      actor_issuer: "issuer",
      actor_subject: "subject",
      created_at: timestamp,
    });
  }
  insertRow(database, "review_run_requests", {
    review_run_id: "run-1",
    request_id: "request-1",
    workflow_kind: "pr_static_build",
    target: "headless",
    required: 1,
    profile_version_id: null,
    prompt_version_id: null,
    prompt_envelope_json: null,
    request_json: requestJson,
  });
  insertRow(database, "review_run_audit", {
    id: "audit-1",
    review_run_id: "run-1",
    action: "planned",
    actor_issuer: "issuer",
    actor_subject: "subject",
    detail_json: '{ "stored": "\\u0062ytes" }',
    created_at: timestamp,
  });
};
