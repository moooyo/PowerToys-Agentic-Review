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
import {
  type JobExecutionTemplate,
  maximumClaimLeaseResponseUtf8Bytes,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const filename = "0024_job_admission.sql";
const migrationSql = readFileSync(join(migrationsDirectory, filename), "utf8");
const databases: DatabaseSync[] = [];
const directories: string[] = [];
const now = "2026-09-07T00:00:00.000Z";
const later = "2026-09-07T00:01:00.000Z";
const digest = "a".repeat(64);
const rawJson =
  ' { "z": 1e+02, "a": "\\u0061", "a": "duplicate key", "text": "caf\u00e9 \ud83d\ude80" }\r\n';
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
  const directory = mkdtempSync(join(tmpdir(), "job-admission-migration-"));
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

function template(githubRepositoryId = 42): JobExecutionTemplate {
  return {
    repository: { githubRepositoryId, fullName: "example/legacy-name" },
    resource: {
      kind: "pull_request",
      githubNodeId: "PR_admission_fixture",
      number: 7,
      title: "Retained scheduling fixture",
      author: { githubUserId: 9, login: "fixture-author" },
      canonicalSnapshot: {},
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isDraft: false,
    },
    prompt: {
      name: "review",
      version: "legacy",
      renderedPrompt: "Retain every historical byte.\r\n",
      promptSha256: digest,
      outputSchema: {},
      outputSchemaSha256: "b".repeat(64),
    },
    executionPolicy: {
      hardTimeoutMs: 600_000,
      noProgressTimeoutMs: 120_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}

function execution(githubRepositoryId = 42): string {
  return ` \r\n${JSON.stringify(template(githubRepositoryId), null, 2).replace(
    '"canonicalSnapshot": {}',
    `"canonicalSnapshot": ${rawJson.trim()}`,
  )}\r\n `;
}

function job(id: string, overrides: Row = {}): Row {
  return {
    id,
    job_kind: "pull_request_review",
    semantic_key: `semantic-${id}`,
    concurrency_key: `concurrency-${id}`,
    status: "queued",
    execution_json: execution(),
    required_capabilities_json: ' [ "compiler", { "preserved": true } ] \r\n',
    resource_revision: digest,
    attempt_count: 0,
    max_attempts: 8,
    current_step: "legacy step\0suffix\r\n",
    next_attempt_at: later,
    failure_message: "legacy message\0suffix\r\n",
    created_at: now,
    updated_at: later,
    ...overrides,
  };
}

function seedRepository(database: DatabaseSync): void {
  insert(database, "repositories", {
    id: "repository-1",
    github_repository_id: 42,
    github_node_id: "R_admission_fixture",
    owner_login: "example",
    name: "current-name",
    full_name: "example/current-name",
    html_url: "https://github.com/example/current-name",
    default_branch: "main",
    is_private: 0,
    snapshot_json: rawJson,
    observed_at: now,
    created_at: now,
    updated_at: later,
  });
  insert(database, "managed_repositories", {
    id: "repository-1",
    github_repository_id: 42,
    full_name: "example/current-name",
    enabled: 0,
    version: 1,
    connection_status: "unknown",
    metadata_json: rawJson,
    configuration_source: "operator",
    created_at: now,
    updated_at: later,
  });
  insert(database, "work_items", {
    id: "item-1",
    repository_id: "repository-1",
    resource_kind: "pull_request",
    github_work_item_id: 42007,
    github_node_id: "PR_admission_fixture",
    github_number: 7,
    state: "open",
    title: "Retained scheduling fixture",
    body: "Legacy body\0suffix\r\n",
    html_url: "https://github.com/example/current-name/pull/7",
    author_github_user_id: 9,
    author_login: "fixture-author",
    author_account_type: "user",
    current_revision_key: digest,
    is_draft: 0,
    source_created_at: now,
    source_updated_at: later,
    snapshot_json: rawJson,
    projection_source: "poll",
    observed_at: later,
    created_at: now,
    updated_at: later,
  });
  insert(database, "work_item_revisions", {
    id: "revision-1",
    work_item_id: "item-1",
    revision_key: digest,
    resource_kind: "pull_request",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    source_updated_at: later,
    observed_at: later,
    revision_json: rawJson,
    created_at: now,
  });
  insert(database, "repository_configuration_audit", {
    id: "repository-audit-1",
    repository_id: "repository-1",
    action: "legacy action\0suffix\r\n",
    actor_issuer: "legacy issuer\0suffix",
    actor_subject: " legacy subject ",
    version: -1,
    configuration_json: rawJson,
    created_at: now,
  });
  insert(database, "prompt_configuration_audit", {
    id: "prompt-audit-1",
    repository_id: "repository-1",
    action: "draft_saved",
    entity_id: "legacy-entity\0suffix",
    actor_issuer: "https://identity.example.test",
    actor_subject: "legacy-operator",
    detail_json: rawJson,
    created_at: now,
  });
}

function seedWorker(database: DatabaseSync): void {
  insert(database, "workers", {
    id: "worker-1",
    node_id: "worker-node-1",
    instance_id: "worker-instance-1",
    display_name: "Legacy worker",
    version: "legacy",
    protocol_version: "1.0",
    max_slots: 8,
    capabilities_json: rawJson,
    capabilities_digest: digest,
    status: "offline",
    available_slots: 0,
    registered_at: now,
    last_seen_at: now,
    updated_at: later,
  });
}

function attempt(jobId: string, status: string, number: number): Row {
  const active = status === "leased" || status === "running";
  return {
    id: `attempt-${jobId}`,
    job_id: jobId,
    attempt_number: number,
    worker_id: "worker-1",
    worker_node_id: "worker-node-1",
    worker_instance_id: "worker-instance-1",
    status,
    lease_token_hash: digest,
    lease_generation: number,
    lease_expires_at: later,
    execution_deadline_at: later,
    no_progress_timeout_ms: 30_000,
    no_progress_deadline_at: later,
    last_heartbeat_at: now,
    phase: "legacy phase\0suffix",
    progress_json: rawJson,
    result_digest: active ? null : digest,
    result_json: active ? null : rawJson,
    started_at: now,
    ended_at: active ? null : later,
    failure_message: "Retained failure\0suffix\r\n",
  };
}

const statusCases = [
  ["queued", 0, "admitted", 0],
  ["retry_waiting", 2, "admitted", 2],
  ["leased", 1, "pending", 0],
  ["running", 3, "pending", 2],
  ["cancel_requested", 2, "pending", 1],
  ["stale", 0, "pending", 0],
  ["succeeded", 1, "pending", 1],
  ["failed", 2, "pending", 2],
  ["dead_letter", 3, "pending", 3],
  ["cancelled", 1, "pending", 1],
] as const;

function fixture(oversized = false): { database: DatabaseSync; directory: string } {
  const database = open();
  const directory = migrationDirectory(23);
  expect(runMigrations(database, directory)).toBe(23);
  seedRepository(database);
  seedWorker(database);
  for (const [status, attemptCount] of statusCases) {
    const id = `legacy-${status}`;
    const active = status === "leased" || status === "running" || status === "cancel_requested";
    insert(
      database,
      "jobs",
      job(id, {
        status,
        attempt_count: attemptCount,
        lease_generation: attemptCount,
        current_run_attempt_id: active ? `attempt-${id}` : null,
      }),
    );
    if (attemptCount > 0)
      insert(
        database,
        "run_attempts",
        attempt(
          id,
          active
            ? status === "leased"
              ? "leased"
              : "running"
            : status === "succeeded" || status === "cancelled"
              ? status
              : "failed",
          attemptCount,
        ),
      );
  }
  for (const [id, overrides] of [
    ["associated-resolved", { work_item_id: "item-1" }],
    ["associated-conflict", { work_item_id: "item-1", execution_json: execution(43) }],
    ["associated-invalid", { work_item_id: "item-1", execution_json: " { } \r\n" }],
    ["legacy-invalid", { execution_json: " { } \r\n" }],
    ["legacy-malformed", { execution_json: '{ "repository": ' }],
  ] satisfies [string, Row][])
    insert(database, "jobs", job(id, overrides));
  if (oversized) {
    const serialized = " ".repeat(maximumClaimLeaseResponseUtf8Bytes + 1) + execution();
    insert(database, "jobs", job("legacy-unverified", { execution_json: serialized }));
    insert(
      database,
      "jobs",
      job("associated-unverified", {
        work_item_id: "item-1",
        execution_json: serialized,
      }),
    );
  }
  return { database, directory };
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableBytes(database: DatabaseSync, table: string) {
  const identifier = quote(table);
  const columns = database.prepare(`PRAGMA table_info(${identifier})`).all() as { name: string }[];
  return database
    .prepare(`SELECT ${columns
      .flatMap(({ name }, index) => [
        `typeof(${quote(name)}) AS column_${index}_type`,
        `hex(${quote(name)}) AS column_${index}_hex`,
      ])
      .join(", ")} FROM ${identifier}
    ${table === "schema_migrations" ? "WHERE version <= 23" : ""}
    ORDER BY ${columns.map(({ name }) => quote(name)).join(", ")}`)
    .all();
}

function legacyState(database: DatabaseSync) {
  const tables = database
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name NOT IN ('scheduling_state', 'job_admission') ORDER BY name`)
    .all() as { name: string }[];
  return tables.map(({ name }) => ({
    name,
    columns: database.prepare(`PRAGMA table_xinfo(${quote(name)})`).all(),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all(),
    bytes: tableBytes(database, name),
  }));
}

function schema(database: DatabaseSync) {
  return database
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all();
}

function expectForeignKeys(database: DatabaseSync): void {
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(database.prepare("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("job admission migration", () => {
  it("runs every production migration on a clean database and records the exact v24 checksum", () => {
    const database = open();
    expect(runMigrations(database, migrationDirectory(24))).toBe(24);
    expect(rows(database, "job_admission", "job_id")).toEqual([]);
    expect(rows(database, "scheduling_state", "singleton")).toEqual([
      {
        singleton: 1,
        episode_sequence: 0,
        inspection_sequence: 0,
        pending_pass_high_water: 0,
        pending_pass_after_sequence: 0,
        backfill_complete: 1,
      },
    ]);
    expect(
      database.prepare("SELECT checksum FROM schema_migrations WHERE version = 24").get(),
    ).toEqual({
      checksum: createHash("sha256").update(migrationSql).digest("hex"),
    });
    expect(
      database
        .prepare(`SELECT name, wr, strict FROM pragma_table_list
      WHERE name IN ('scheduling_state', 'job_admission') ORDER BY name`)
        .all(),
    ).toEqual([
      { name: "job_admission", wr: 1, strict: 1 },
      { name: "scheduling_state", wr: 1, strict: 1 },
    ]);
    const ledger = rows(database, "schema_migrations", "version");
    const before = schema(database);
    expect(runMigrations(database, migrationDirectory(24))).toBe(24);
    expect(rows(database, "schema_migrations", "version")).toEqual(ledger);
    expect(schema(database)).toEqual(before);
    expectForeignKeys(database);
  });

  it("backfills real v23 rows without changing any historical bytes, schema, or checksums", () => {
    const { database } = fixture(true);
    const before = legacyState(database);
    const previousSchema = schema(database);
    expect(runMigrations(database, migrationDirectory(24))).toBe(24);
    expect(legacyState(database)).toEqual(before);
    expect(schema(database)).toEqual(expect.arrayContaining(previousSchema));
    const applied = database
      .prepare("SELECT applied_at FROM schema_migrations WHERE version = 24")
      .get() as {
      applied_at: string;
    };
    const admissions = rows(database, "job_admission", "episode_sequence") as Row[];
    expect(admissions).toHaveLength(17);
    expect(admissions.map((row) => row.episode_sequence)).toEqual(
      Array.from({ length: admissions.length }, (_, index) => index + 1),
    );
    for (const [status, , state, attemptBase] of statusCases) {
      expect(
        database.prepare("SELECT * FROM job_admission WHERE job_id = ?").get(`legacy-${status}`),
      ).toMatchObject({
        state,
        attempt_base: attemptBase,
        timestamp_basis: "migration_backfill",
        requested_at: applied.applied_at,
        admitted_at: state === "admitted" ? applied.applied_at : null,
        bucket_key: "github:42",
        github_repository_id: 42,
        ownership_state: "resolved",
      });
    }
    for (const [jobId, ownershipState, repositoryNumber] of [
      ["associated-resolved", "resolved", 42],
      ["associated-conflict", "conflict", 42],
      ["associated-invalid", "invalid_template", 42],
      ["associated-unverified", "unverified", 42],
      ["legacy-invalid", "invalid_template", null],
      ["legacy-malformed", "invalid_template", null],
      ["legacy-unverified", "unverified", null],
    ] as const) {
      expect(
        database.prepare("SELECT * FROM job_admission WHERE job_id = ?").get(jobId),
      ).toMatchObject({
        state: "admitted",
        attempt_base: 0,
        timestamp_basis: "migration_backfill",
        requested_at: applied.applied_at,
        admitted_at: applied.applied_at,
        ownership_state: ownershipState,
        bucket_key: repositoryNumber === null ? "unscoped" : `github:${repositoryNumber}`,
        github_repository_id: repositoryNumber,
      });
    }
    for (const admission of admissions)
      expect(admission).toMatchObject({
        last_checked_at: null,
        last_inspection_sequence: 0,
        blockers_json: "[]",
      });
    expect(rows(database, "scheduling_state", "singleton")).toEqual([
      {
        singleton: 1,
        episode_sequence: admissions.length,
        inspection_sequence: 0,
        pending_pass_high_water: 0,
        pending_pass_after_sequence: 0,
        backfill_complete: 1,
      },
    ]);
    expectForeignKeys(database);
  });

  it("does not repeat backfill or repair a subsequently missing admission on startup", () => {
    const { database } = fixture();
    expect(runMigrations(database, migrationDirectory(24))).toBe(24);
    const admissions = rows(database, "job_admission", "job_id");
    const scheduling = rows(database, "scheduling_state", "singleton");
    const ledger = rows(database, "schema_migrations", "version");
    insert(database, "jobs", job("missing-admission"));
    expect(runMigrations(database, migrationDirectory(24))).toBe(24);
    expect(rows(database, "job_admission", "job_id")).toEqual(admissions);
    expect(rows(database, "scheduling_state", "singleton")).toEqual(scheduling);
    expect(rows(database, "schema_migrations", "version")).toEqual(ledger);
    expect(
      database.prepare("SELECT * FROM job_admission WHERE job_id = 'missing-admission'").get(),
    ).toBeUndefined();
    expect(() =>
      database.exec(`UPDATE jobs SET status = 'leased', attempt_count = 1,
      current_run_attempt_id = 'missing-attempt' WHERE id = 'missing-admission'`),
    ).toThrow(/matching admitted queue episode/u);
    expectForeignKeys(database);
  });

  it.each(["sql", "backfill", "completion"])(
    "rolls back the entire v24 upgrade after a %s failure",
    (failure) => {
      const { database, directory } = fixture();
      const before = legacyState(database);
      const previousSchema = schema(database);
      const ledger = rows(database, "schema_migrations", "version");
      const injection =
        failure === "sql"
          ? "SELECT * FROM deliberately_missing_m24_table;"
          : failure === "backfill"
            ? `CREATE TRIGGER test_backfill_failure BEFORE INSERT ON job_admission
          WHEN EXISTS (SELECT 1 FROM job_admission)
          BEGIN SELECT RAISE(ABORT, 'deliberate m24 backfill failure'); END;`
            : `CREATE TRIGGER test_backfill_completion_failure BEFORE UPDATE OF backfill_complete ON scheduling_state
          WHEN NEW.backfill_complete = 1
          BEGIN SELECT RAISE(ABORT, 'deliberate m24 completion failure'); END;`;
      writeFileSync(join(directory, filename), `${migrationSql}\n${injection}\n`);
      expect(() => runMigrations(database, directory)).toThrow(/deliberate/u);
      expect(legacyState(database)).toEqual(before);
      expect(schema(database)).toEqual(previousSchema);
      expect(rows(database, "schema_migrations", "version")).toEqual(ledger);
      expect(
        database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({ version: 23 });
      expect(
        database
          .prepare(`SELECT name FROM sqlite_schema
      WHERE name IN ('job_admission', 'scheduling_state')`)
          .all(),
      ).toEqual([]);
      expectForeignKeys(database);
      expect(runMigrations(database, migrationDirectory(24))).toBe(24);
      expect(legacyState(database)).toEqual(before);
      expectForeignKeys(database);
    },
  );

  describe.each([0, 1])("with recursive_triggers = %i", (recursiveTriggers) => {
    it("protects backfilled admission and scheduling rows from replacement and deletion", () => {
      const { database } = fixture();
      expect(runMigrations(database, migrationDirectory(24))).toBe(24);
      database.exec(`PRAGMA recursive_triggers = ${recursiveTriggers}`);
      const admission = database
        .prepare("SELECT * FROM job_admission WHERE job_id = 'legacy-queued'")
        .get() as Row;
      const scheduling = database
        .prepare("SELECT * FROM scheduling_state WHERE singleton = 1")
        .get() as Row;
      const before = rows(database, "job_admission", "job_id");
      for (const statement of ["INSERT", "INSERT OR IGNORE", "INSERT OR REPLACE", "REPLACE"]) {
        expect(() => insert(database, "job_admission", admission, statement)).toThrow(
          /cannot be replaced/u,
        );
        expect(() => insert(database, "scheduling_state", scheduling, statement)).toThrow(
          /cannot be replaced/u,
        );
      }
      for (const suffix of [
        "ON CONFLICT(job_id) DO NOTHING",
        "ON CONFLICT(job_id) DO UPDATE SET requested_at = excluded.requested_at",
      ])
        expect(() => insert(database, "job_admission", admission, "INSERT", suffix)).toThrow(
          /cannot be replaced/u,
        );
      expect(() => database.exec("DELETE FROM job_admission")).toThrow(/cannot be deleted/u);
      expect(() => database.exec("DELETE FROM scheduling_state")).toThrow(/cannot be deleted/u);
      expect(() => database.exec("DELETE FROM jobs WHERE id = 'associated-resolved'")).toThrow(
        /FOREIGN KEY/u,
      );
      expect(() => database.exec("UPDATE scheduling_state SET backfill_complete = 0")).toThrow(
        /invalid scheduling sequence/u,
      );
      expect(rows(database, "job_admission", "job_id")).toEqual(before);
      expect(rows(database, "scheduling_state", "singleton")).toEqual([scheduling]);
      expectForeignKeys(database);
    });

    it("rejects stale, unresolved, and already consumed migration grants at the SQL lease boundary", () => {
      const { database } = fixture();
      expect(runMigrations(database, migrationDirectory(24))).toBe(24);
      database.exec(`PRAGMA recursive_triggers = ${recursiveTriggers}`);
      database.exec("UPDATE jobs SET attempt_count = attempt_count + 1 WHERE id = 'legacy-queued'");
      for (const id of [
        "legacy-queued",
        "associated-conflict",
        "associated-invalid",
        "legacy-invalid",
      ])
        expect(() =>
          database
            .prepare(`UPDATE jobs SET status = 'leased', attempt_count = attempt_count + 1,
          current_run_attempt_id = ? WHERE id = ?`)
            .run(`next-${id}`, id),
        ).toThrow(/matching admitted queue episode/u);
      expect(() =>
        database.exec(`UPDATE job_admission SET state = 'admitted', admitted_at = '${later}'
        WHERE job_id = 'legacy-running'`),
      ).toThrow(/only an unleased waiting job/u);
      database.exec("UPDATE run_attempts SET status = 'failed' WHERE job_id = 'legacy-running'");
      database.exec(`UPDATE jobs SET status = 'retry_waiting', current_run_attempt_id = NULL
        WHERE id = 'legacy-running'`);
      expect(() =>
        database.exec(`UPDATE jobs SET status = 'leased', attempt_count = attempt_count + 1,
        current_run_attempt_id = 'next-running' WHERE id = 'legacy-running'`),
      ).toThrow(/matching admitted queue episode/u);
      expect(() =>
        database.exec("UPDATE run_attempts SET status = 'running' WHERE job_id = 'legacy-failed'"),
      ).toThrow(/cannot be reactivated/u);
      expect(() =>
        database.exec("UPDATE jobs SET execution_json = '{}' WHERE id = 'legacy-retry_waiting'"),
      ).toThrow(/ownership inputs are immutable/u);
      expectForeignKeys(database);
    });
  });
});
