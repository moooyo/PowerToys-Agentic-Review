import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { JobExecutionTemplate, SchedulingConfiguration } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginRetryAdmissionInTransaction,
  createJobAdmissionInTransaction,
} from "./job-admission.js";
import { runMigrations } from "./migrations.js";
import {
  assertActiveSchedulingIntegrity,
  readPlatformSchedulingConfiguration,
  readSchedulingOverage,
  readSchedulingUsage,
  resolveRepositorySchedulingPolicy,
} from "./scheduling-accounting.js";

const migrations = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const databases: DatabaseSync[] = [];
const directories: string[] = [];
const now = "2026-09-07T00:00:00.000Z";
const later = "2026-09-07T00:30:00.000Z";
type Row = Record<string, SQLInputValue>;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directoryThrough(version: number): string {
  const directory = mkdtempSync(join(tmpdir(), "scheduling-policy-migration-"));
  directories.push(directory);
  for (const filename of readdirSync(migrations))
    if (/^\d+_.*\.sql$/u.test(filename) && Number.parseInt(filename, 10) <= version)
      copyFileSync(join(migrations, filename), join(directory, filename));
  return directory;
}

function open(version = 25): DatabaseSync {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(database);
  database.exec("PRAGMA trusted_schema = OFF; PRAGMA recursive_triggers = OFF");
  runMigrations(database, directoryThrough(version));
  return database;
}

function insert(database: DatabaseSync, table: string, row: Row, prefix = "INSERT"): void {
  database
    .prepare(`${prefix} INTO ${table} (${Object.keys(row).join(",")})
    VALUES (${Object.keys(row)
      .map(() => "?")
      .join(",")})`)
    .run(...Object.values(row));
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function template(repositoryNumber = 42): JobExecutionTemplate {
  return {
    repository: { githubRepositoryId: repositoryNumber, fullName: "example/original" },
    resource: {
      kind: "pull_request",
      githubNodeId: "PR_fixture",
      number: 7,
      title: "Scheduling fixture",
      author: { githubUserId: 9, login: "fixture" },
      canonicalSnapshot: {},
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isDraft: false,
    },
    prompt: {
      name: "review",
      version: "fixture",
      renderedPrompt: "Review this fixture.",
      promptSha256: "a".repeat(64),
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

function rawJob(database: DatabaseSync, id: string, extra: Row = {}): void {
  insert(database, "jobs", {
    id,
    job_kind: "pull_request_review",
    semantic_key: id,
    concurrency_key: id,
    status: "queued",
    execution_json: JSON.stringify(template()),
    resource_revision: "b".repeat(40),
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
    ...extra,
  });
}

function create(database: DatabaseSync, id: string, extra: Row = {}): void {
  transaction(database, () => {
    rawJob(database, id, extra);
    createJobAdmissionInTransaction(database, id, now);
  });
}

function admit(database: DatabaseSync, id: string): void {
  database
    .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
    .run(now, id);
}

function worker(database: DatabaseSync): void {
  insert(database, "workers", {
    id: "worker",
    node_id: "node",
    instance_id: "instance",
    display_name: "Fixture worker",
    version: "1.0.0",
    protocol_version: "1.0",
    max_slots: 10,
    capabilities_json: "{}",
    capabilities_digest: "a".repeat(64),
    status: "offline",
    superseded_at: later,
    registered_at: now,
    last_seen_at: now,
    updated_at: later,
  });
}

function attempt(database: DatabaseSync, id: string, number = 1): void {
  insert(database, "run_attempts", {
    id: `attempt-${id}-${number}`,
    job_id: id,
    attempt_number: number,
    worker_id: "worker",
    worker_node_id: "node",
    worker_instance_id: "instance",
    status: "leased",
    lease_token_hash: "a".repeat(64),
    lease_generation: 1,
    lease_expires_at: now,
    execution_deadline_at: now,
    no_progress_timeout_ms: 60_000,
    no_progress_deadline_at: now,
    last_heartbeat_at: now,
    phase: "assigned",
    started_at: now,
  });
}

function grant(database: DatabaseSync, id: string): void {
  admit(database, id);
  database
    .prepare(
      "UPDATE jobs SET status = 'leased', attempt_count = 1, current_run_attempt_id = ? WHERE id = ?",
    )
    .run(`attempt-${id}-1`, id);
  attempt(database, id);
}

function managed(database: DatabaseSync, id = "managed", number = 42): void {
  insert(database, "managed_repositories", {
    id,
    github_repository_id: number,
    full_name: `example/${id}`,
    enabled: 1,
    version: 1,
    connection_status: "unknown",
    configuration_source: "operator",
    created_at: now,
    updated_at: now,
  });
}

function auditRow(database: DatabaseSync, id = "audit"): Row {
  const previous = readPlatformSchedulingConfiguration(database);
  const timestamp = new Date(Date.parse(previous.updatedAt) + 1000).toISOString();
  const snapshot: SchedulingConfiguration = {
    ...previous,
    version: previous.version + 1,
    limits: { maxActiveLeases: 2, maxQueuedJobs: 3 },
    updatedAt: timestamp,
  };
  return {
    id,
    actor_issuer: "https://issuer.example",
    actor_subject: "operator",
    previous_version: previous.version,
    version: snapshot.version,
    previous_snapshot_json: JSON.stringify(previous),
    snapshot_json: JSON.stringify(snapshot),
    created_at: timestamp,
  };
}

describe("scheduling policy migration and accounting", () => {
  it("adds null limits and stable ordering without changing existing job, attempt, or admission episode bytes", () => {
    const database = open(23);
    worker(database);
    managed(database);
    rawJob(database, "queued", { priority: 200 });
    rawJob(database, "active", {
      status: "running",
      attempt_count: 1,
      current_run_attempt_id: "attempt-active-1",
    });
    attempt(database, "active");
    runMigrations(database, directoryThrough(24));
    const jobs = database.prepare("SELECT * FROM jobs ORDER BY id").all();
    const attempts = database.prepare("SELECT * FROM run_attempts ORDER BY id").all();
    const admissions = database.prepare("SELECT * FROM job_admission ORDER BY job_id").all();
    const ledger = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    expect(runMigrations(database, directoryThrough(25))).toBe(25);
    expect(database.prepare("SELECT * FROM jobs ORDER BY id").all()).toEqual(jobs);
    expect(database.prepare("SELECT * FROM run_attempts ORDER BY id").all()).toEqual(attempts);
    const upgraded = database.prepare("SELECT * FROM job_admission ORDER BY job_id").all();
    expect(
      upgraded.map(({ work_class: _workClass, claim_rank_at_ms: _rank, ...row }) => row),
    ).toEqual(admissions);
    expect(
      database
        .prepare("SELECT * FROM schema_migrations WHERE version <= 24 ORDER BY version")
        .all(),
    ).toEqual(ledger);
    expect(resolveRepositorySchedulingPolicy(database, "github:42")?.limits).toEqual({
      maxActiveLeases: null,
      maxQueuedJobs: null,
    });
    expect(readPlatformSchedulingConfiguration(database)).toMatchObject({
      version: 1,
      limits: { maxActiveLeases: null, maxQueuedJobs: null },
    });
    const applied = database
      .prepare("SELECT checksum FROM schema_migrations WHERE version = 25")
      .get();
    expect(applied).toEqual({
      checksum: createHash("sha256")
        .update(readFileSync(join(migrations, "0025_scheduling_policy.sql"), "utf8"))
        .digest("hex"),
    });
    const configuration = readPlatformSchedulingConfiguration(database);
    runMigrations(database, directoryThrough(25));
    expect(readPlatformSchedulingConfiguration(database)).toEqual(configuration);
  });

  it("projects bounded original priority and retry rank while retaining the immutable envelope", () => {
    const database = open();
    create(database, "boosted", { priority: 200, next_attempt_at: later });
    const original = database
      .prepare("SELECT execution_json, priority FROM jobs WHERE id = 'boosted'")
      .get();
    expect(
      database
        .prepare("SELECT work_class, claim_rank_at_ms FROM job_admission WHERE job_id = 'boosted'")
        .get(),
    ).toEqual({
      work_class: "pull_request",
      claim_rank_at_ms: Date.parse(later) - 600_000,
    });
    worker(database);
    grant(database, "boosted");
    database.exec(
      "UPDATE run_attempts SET status = 'failed'; UPDATE jobs SET status = 'retry_waiting', current_run_attempt_id = NULL",
    );
    const retryAt = "2026-09-07T01:00:00.000Z";
    transaction(database, () => beginRetryAdmissionInTransaction(database, "boosted", retryAt));
    expect(
      database.prepare("SELECT claim_rank_at_ms FROM job_admission WHERE job_id = 'boosted'").get(),
    ).toEqual({ claim_rank_at_ms: Date.parse(retryAt) - 600_000 });
    expect(
      database.prepare("SELECT execution_json, priority FROM jobs WHERE id = 'boosted'").get(),
    ).toEqual(original);
    expect(() =>
      database.exec("UPDATE job_admission SET claim_rank_at_ms = 0 WHERE job_id = 'boosted'"),
    ).toThrow(/ordering/u);
  });

  it("counts every active attempt through cancellation, offline supersession, and expiry until terminal transition", () => {
    const database = open();
    worker(database);
    create(database, "active");
    grant(database, "active");
    database.exec(
      "UPDATE jobs SET status = 'cancel_requested', cancellation_requested_at = '2026-09-07T00:30:00.000Z'",
    );
    create(database, "pending");
    create(database, "admitted", { status: "retry_waiting", next_attempt_at: later });
    admit(database, "admitted");
    create(database, "unscoped", { execution_json: "{}" });
    expect(readSchedulingUsage(database)).toEqual({
      activeLeases: 1,
      admittedQueuedJobs: 1,
      awaitingAdmissionJobs: 2,
      awaitingConfigurationRequests: 0,
    });
    expect(readSchedulingUsage(database, { bucketKey: "github:42" })).toEqual({
      activeLeases: 1,
      admittedQueuedJobs: 1,
      awaitingAdmissionJobs: 1,
      awaitingConfigurationRequests: 0,
    });
    expect(readSchedulingUsage(database, { bucketKey: "unscoped" })).toEqual({
      activeLeases: 0,
      admittedQueuedJobs: 0,
      awaitingAdmissionJobs: 1,
      awaitingConfigurationRequests: 0,
    });
    database.exec("UPDATE run_attempts SET status = 'cancelled'");
    expect(readSchedulingUsage(database).activeLeases).toBe(0);
  });

  it("counts attempts rather than distinct historical jobs and refuses conflicting active ownership", () => {
    const database = open(23);
    worker(database);
    rawJob(database, "legacy", {
      status: "running",
      attempt_count: 2,
      current_run_attempt_id: "attempt-legacy-2",
    });
    attempt(database, "legacy", 1);
    attempt(database, "legacy", 2);
    runMigrations(database, directoryThrough(25));
    expect(readSchedulingUsage(database).activeLeases).toBe(2);
    // Synthetic corruption verifies the diagnostic; production admission guards remain installed.
    database.exec(
      "DROP TRIGGER tr_job_admission_update; UPDATE job_admission SET ownership_state = 'conflict' WHERE job_id = 'legacy'",
    );
    expect(() => assertActiveSchedulingIntegrity(database)).toThrow(/ownership/u);
    expect(() => readSchedulingUsage(database)).toThrow(/ownership/u);
  });

  it("resolves current limits by stable upstream identity after later management and rename", () => {
    const database = open();
    create(database, "legacy");
    expect(resolveRepositorySchedulingPolicy(database, "github:42")).toBeNull();
    managed(database);
    database.exec(
      "UPDATE managed_repositories SET full_name = 'transferred/new-name', max_active_leases = 1, max_queued_jobs = 2",
    );
    expect(resolveRepositorySchedulingPolicy(database, "github:42")).toMatchObject({
      repositoryId: "managed",
      githubRepositoryId: 42,
      limits: { maxActiveLeases: 1, maxQueuedJobs: 2 },
    });
    expect(readSchedulingUsage(database, { bucketKey: "github:42" }).awaitingAdmissionJobs).toBe(1);
    expect(
      readSchedulingOverage(
        {
          activeLeases: 3,
          admittedQueuedJobs: 4,
          awaitingAdmissionJobs: 100,
          awaitingConfigurationRequests: 200,
        },
        { maxActiveLeases: 1, maxQueuedJobs: 2 },
      ),
    ).toEqual({ activeLeases: 2, admittedQueuedJobs: 2 });
  });

  it.each([0, 1])(
    "protects configuration snapshots and service history with recursive_triggers=%i",
    (recursive) => {
      const database = open();
      database.exec(`PRAGMA recursive_triggers = ${recursive}`);
      const row = auditRow(database);
      insert(database, "platform_scheduling_configuration_audit", row);
      expect(readPlatformSchedulingConfiguration(database)).toEqual(
        JSON.parse(String(row.snapshot_json)),
      );
      for (const prefix of ["INSERT", "INSERT OR IGNORE", "INSERT OR REPLACE", "REPLACE"])
        expect(() =>
          insert(database, "platform_scheduling_configuration_audit", row, prefix),
        ).toThrow(/replaced/u);
      expect(() =>
        database.exec("UPDATE platform_scheduling_configuration_audit SET actor_subject = 'other'"),
      ).toThrow(/immutable/u);
      expect(() => database.exec("DELETE FROM platform_scheduling_configuration_audit")).toThrow(
        /immutable/u,
      );
      expect(() =>
        database.exec(
          "UPDATE platform_scheduling_configuration SET version = version + 1, max_active_leases = 9",
        ),
      ).toThrow(/audit/u);
      const invalid = auditRow(database, "invalid");
      invalid.previous_snapshot_json = JSON.stringify({
        ...JSON.parse(String(invalid.previous_snapshot_json)),
        extra: true,
      });
      expect(() => insert(database, "platform_scheduling_configuration_audit", invalid)).toThrow(
        /snapshot/u,
      );
      insert(database, "repository_scheduling_state", {
        bucket_key: "github:42",
        last_admission_ticket: 0,
        last_claim_ticket: 0,
      });
      expect(() =>
        database.exec("UPDATE repository_scheduling_state SET admission_pr_streak = 3"),
      ).toThrow();
      expect(() => database.exec("DELETE FROM repository_scheduling_state")).toThrow(/deleted/u);
      database.exec("UPDATE scheduling_state SET successful_claim_sequence = 9007199254740991");
      expect(() =>
        database.exec(
          "UPDATE scheduling_state SET successful_claim_sequence = successful_claim_sequence + 1",
        ),
      ).toThrow();
      expect(() =>
        database.exec("UPDATE scheduling_state SET successful_claim_sequence = 0"),
      ).toThrow(/sequence/u);
    },
  );

  it("rolls back the audit and its configuration projection together", () => {
    const database = open();
    const initial = readPlatformSchedulingConfiguration(database);
    expect(() =>
      transaction(database, () => {
        insert(database, "platform_scheduling_configuration_audit", auditRow(database));
        throw new Error("rollback fixture");
      }),
    ).toThrow(/rollback fixture/u);
    expect(readPlatformSchedulingConfiguration(database)).toEqual(initial);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM platform_scheduling_configuration_audit")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rejects zero, fractional, overflowing, and out-of-range limits at both storage scopes", () => {
    const database = open();
    managed(database);
    for (const [column, field, maximum] of [
      ["max_active_leases", "maxActiveLeases", 65_535],
      ["max_queued_jobs", "maxQueuedJobs", 1_000_000],
    ] as const) {
      for (const value of [0, -1, 1.5, maximum + 1, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() =>
          database.prepare(`UPDATE managed_repositories SET ${column} = ?`).run(value),
        ).toThrow();
        const row = auditRow(database);
        const next = JSON.parse(String(row.snapshot_json));
        next.limits[field] = value;
        row.snapshot_json = JSON.stringify(next);
        expect(() => insert(database, "platform_scheduling_configuration_audit", row)).toThrow();
      }
      database.prepare(`UPDATE managed_repositories SET ${column} = ?`).run(maximum);
      database.exec(`UPDATE managed_repositories SET ${column} = NULL`);
    }
    expect(readPlatformSchedulingConfiguration(database).version).toBe(1);
  });

  it("registers a new bucket at its acceptance-time service sequence", () => {
    const database = open();
    database.exec(
      "UPDATE scheduling_state SET successful_admission_sequence = 7, successful_claim_sequence = 9",
    );
    create(database, "first");
    expect(
      database
        .prepare(
          "SELECT last_admission_ticket, last_claim_ticket FROM repository_scheduling_state WHERE bucket_key = 'github:42'",
        )
        .get(),
    ).toEqual({
      last_admission_ticket: 7,
      last_claim_ticket: 9,
    });
    database.exec(
      "UPDATE scheduling_state SET successful_admission_sequence = 10, successful_claim_sequence = 12",
    );
    create(database, "same-bucket");
    expect(
      database
        .prepare(
          "SELECT last_admission_ticket, last_claim_ticket FROM repository_scheduling_state WHERE bucket_key = 'github:42'",
        )
        .get(),
    ).toEqual({
      last_admission_ticket: 7,
      last_claim_ticket: 9,
    });
    expect(() =>
      database.exec(
        "UPDATE repository_scheduling_state SET claim_pr_streak = 1 WHERE bucket_key = 'github:42'",
      ),
    ).toThrow(/service/u);
  });
});
