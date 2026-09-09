import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  JobExecutionTemplate,
  SchedulingLimits,
  WorkerCapabilities,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createJobAdmissionInTransaction, getJobAdmissionRecord } from "./job-admission.js";
import { runMigrations } from "./migrations.js";
import { admitPendingJobsInTransaction } from "./scheduling-admission.js";
import {
  readPlatformSchedulingConfiguration,
  readSchedulingUsage,
} from "./scheduling-accounting.js";
import { readRepositorySchedulingService, type SchedulingWorkClass } from "./scheduling-service.js";

const now = "2026-09-07T12:00:00.000Z";
const databases: DatabaseSync[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
function open(): DatabaseSync {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(database);
  runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
  return database;
}
function job(
  database: DatabaseSync,
  id: string,
  requiredPool = "ready",
  paddingBytes = 0,
  repositoryNumber = 1,
  workClass: SchedulingWorkClass = "pull_request",
): string {
  const template: JobExecutionTemplate = {
    repository: { githubRepositoryId: repositoryNumber, fullName: "fixture/admission" },
    resource:
      workClass === "issue"
        ? {
            kind: "issue",
            githubNodeId: `ISSUE_${id}`,
            number: 1,
            title: "Isolated issue fixture",
            author: { githubUserId: 1, login: "fixture" },
            canonicalSnapshot: {},
            revisionDigest: hash(id),
          }
        : {
            kind: "pull_request",
            githubNodeId: `PR_${id}`,
            number: 1,
            title: "Isolated admission fixture",
            author: { githubUserId: 1, login: "fixture" },
            canonicalSnapshot: {},
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            isDraft: false,
          },
    prompt: {
      name: "fixture",
      version: "1",
      renderedPrompt: "Inspect the isolated fixture.",
      promptSha256: hash("Inspect the isolated fixture."),
      outputSchema: {},
      outputSchemaSha256: hash("{}"),
    },
    executionPolicy: {
      hardTimeoutMs: 600_000,
      noProgressTimeoutMs: 120_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
  const execution = `${" ".repeat(paddingBytes)}${JSON.stringify(template)}`;
  const required = JSON.stringify({ labels: { pool: requiredPool } });
  transaction(database, () => {
    database
      .prepare(`INSERT INTO jobs (id, job_kind, generation, intent_version, semantic_key,
      concurrency_key, status, priority, execution_json, execution_digest, required_capabilities_json,
      required_capabilities_digest, resource_revision, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, 1, 1, ?, ?, 'queued', 100, ?, ?, ?, ?, ?, 3, ?, ?, ?)`)
      .run(
        id,
        workClass === "issue" ? "issue_triage" : "pull_request_review",
        `semantic:${id}`,
        `concurrency:${id}`,
        execution,
        hash(execution),
        required,
        hash(required),
        hash("revision"),
        now,
        now,
        now,
      );
    createJobAdmissionInTransaction(database, id, now);
  });
  return id;
}
function worker(database: DatabaseSync, id = "worker-ready", pool = "ready"): string {
  const capabilities: WorkerCapabilities = {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    codexVersion: "test",
    recipeIds: [],
    labels: { pool },
  };
  const json = JSON.stringify(capabilities);
  const node = `node-${id}`;
  database
    .prepare(`INSERT INTO worker_node_credentials (worker_node_id, display_name, token_sha256,
    auth_state, created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject,
    created_at, updated_at, activated_at)
    VALUES (?, 'Fixture Worker', ?, 'active', 'fixture', 'fixture', 'fixture', 'fixture', ?, ?, ?)`)
    .run(node, hash(node), now, now, now);
  database
    .prepare(`INSERT INTO workers (id, node_id, instance_id, display_name, version,
    protocol_version, max_slots, capabilities_json, capabilities_digest, status, available_slots,
    registered_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, 'Fixture Worker', 'test', '1.0', 1, ?, ?, 'online', 0, ?, ?, ?)`)
    .run(id, node, `instance-${id}`, json, hash(json), now, now, now);
  return id;
}
const pump = (database: DatabaseSync, limit = 32, workerId?: string) =>
  transaction(database, () =>
    admitPendingJobsInTransaction(
      database,
      { limit, ...(workerId === undefined ? {} : { workerId }) },
      now,
    ),
  );

describe("durable job admission foundation", () => {
  it("keeps accepted work pending without a Worker and admits it without consuming an attempt", () => {
    const database = open();
    const id = job(database, "pending-job");
    const original = database.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    expect(getJobAdmissionRecord(database, id).state).toBe("pending");
    expect(pump(database)).toEqual({ examinedJobCount: 1, admittedJobCount: 0 });
    worker(database);
    expect(pump(database)).toEqual({ examinedJobCount: 1, admittedJobCount: 1 });
    expect(getJobAdmissionRecord(database, id)).toMatchObject({
      state: "admitted",
      attemptBase: 0,
    });
    expect(database.prepare("SELECT * FROM jobs WHERE id = ?").get(id)).toEqual(original);
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
  });

  it("does not require retry backoff to expire or a local-capacity report for admission", () => {
    const database = open();
    worker(database);
    const id = job(database, "backoff-job");
    database
      .prepare("UPDATE jobs SET next_attempt_at = ? WHERE id = ?")
      .run("2026-09-08T12:00:00.000Z", id);
    expect(pump(database).admittedJobCount).toBe(1);
    expect(
      database
        .prepare("SELECT status, attempt_count, next_attempt_at FROM jobs WHERE id = ?")
        .get(id),
    ).toEqual({ status: "queued", attempt_count: 0, next_attempt_at: "2026-09-08T12:00:00.000Z" });
  });

  it("retains one finite pass while new episodes arrive, reaching a later compatible Job", () => {
    const database = open();
    worker(database);
    for (let index = 1; index < 140; index++) job(database, `incompatible-${index}`, "missing");
    const target = job(database, "later-compatible");
    for (let round = 0; round < 8; round++) {
      expect(pump(database, 16)).toEqual({ examinedJobCount: 16, admittedJobCount: 0 });
      job(database, `new-arrival-${round}`, "missing");
    }
    expect(pump(database, 16)).toEqual({ examinedJobCount: 12, admittedJobCount: 1 });
    expect(getJobAdmissionRecord(database, target).state).toBe("admitted");
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM job_admission WHERE last_inspection_sequence > 0")
        .get(),
    ).toEqual({ count: 140 });
    const state = database
      .prepare("SELECT pending_pass_high_water, pending_pass_after_sequence FROM scheduling_state")
      .get();
    expect(state).toEqual({ pending_pass_high_water: 140, pending_pass_after_sequence: 140 });
  });

  it("uses a current claimant as positive runtime evidence beyond the public raw JSON budget", () => {
    const database = open();
    const witness = worker(database);
    const id = job(database, "padded-template", "ready", 16 * 1024 * 1024 + 1);
    expect(pump(database).admittedJobCount).toBe(0);
    expect(pump(database, 32, witness).admittedJobCount).toBe(1);
    expect(getJobAdmissionRecord(database, id)).toMatchObject({
      state: "admitted",
      ownershipState: "resolved",
    });
    expect(
      database.prepare("SELECT length(execution_json) AS bytes FROM jobs WHERE id = ?").get(id)
        ?.bytes,
    ).toBeGreaterThan(16 * 1024 * 1024);
  });

  it("rolls back sequence allocation and episode state together when the sequence is exhausted", () => {
    const database = open();
    worker(database);
    const id = job(database, "exhausted-job");
    database
      .prepare("UPDATE scheduling_state SET inspection_sequence = ?")
      .run(Number.MAX_SAFE_INTEGER);
    const before = getJobAdmissionRecord(database, id);
    const cursor = database.prepare("SELECT * FROM scheduling_state").get();
    expect(() => pump(database)).toThrow(/sequence is exhausted/u);
    expect(getJobAdmissionRecord(database, id)).toEqual(before);
    expect(database.prepare("SELECT * FROM scheduling_state").get()).toEqual(cursor);
  });

  it("keeps a pending cancellation terminal and outside subsequent admission", () => {
    const database = open();
    const id = job(database, "cancelled-pending");
    database
      .prepare("UPDATE jobs SET status = 'cancelled', completed_at = ? WHERE id = ?")
      .run(now, id);
    const before = getJobAdmissionRecord(database, id);
    worker(database);
    expect(pump(database)).toEqual({ examinedJobCount: 0, admittedJobCount: 0 });
    expect(getJobAdmissionRecord(database, id)).toEqual(before);
  });
});

function setPlatformLimits(database: DatabaseSync, limits: SchedulingLimits): void {
  const previous = readPlatformSchedulingConfiguration(database);
  const updatedAt = new Date(Date.parse(previous.updatedAt) + 1000).toISOString();
  const next = { ...previous, version: previous.version + 1, limits, updatedAt };
  database
    .prepare(`INSERT INTO platform_scheduling_configuration_audit
    (id, actor_issuer, actor_subject, previous_version, version, previous_snapshot_json, snapshot_json, created_at)
    VALUES (?, 'https://fixture.example.test', 'fixture-admin', ?, ?, ?, ?, ?)`)
    .run(
      `limits-${next.version}`,
      previous.version,
      next.version,
      JSON.stringify(previous),
      JSON.stringify(next),
      updatedAt,
    );
}
function managed(
  database: DatabaseSync,
  number: number,
  limits: SchedulingLimits = {
    maxActiveLeases: null,
    maxQueuedJobs: null,
  },
): void {
  database
    .prepare(`INSERT INTO managed_repositories
    (id, github_repository_id, full_name, enabled, version, connection_status, configuration_source,
      created_at, updated_at, max_active_leases, max_queued_jobs)
    VALUES (?, ?, ?, 1, 1, 'unknown', 'operator', ?, ?, ?, ?)`)
    .run(
      `managed-${number}`,
      number,
      `fixture/repository-${number}`,
      now,
      now,
      limits.maxActiveLeases,
      limits.maxQueuedJobs,
    );
}
function captureAdmissions(database: DatabaseSync): () => string[] {
  database.exec(`CREATE TEMP TABLE admission_trace (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT);
    CREATE TEMP TRIGGER trace_admission AFTER UPDATE OF state ON main.job_admission
    WHEN OLD.state = 'pending' AND NEW.state = 'admitted'
    BEGIN INSERT INTO admission_trace (job_id) VALUES (NEW.job_id); END;`);
  return () =>
    (
      database.prepare("SELECT job_id FROM admission_trace ORDER BY sequence").all() as {
        job_id: string;
      }[]
    ).map((row) => row.job_id);
}
function releaseQueued(database: DatabaseSync, id: string): void {
  database
    .prepare("UPDATE jobs SET status = 'cancelled', completed_at = ? WHERE id = ?")
    .run(now, id);
}
function fixtureGrant(database: DatabaseSync, id: string): void {
  transaction(database, () => {
    database
      .prepare(`UPDATE jobs SET status = 'leased', attempt_count = 1,
      current_run_attempt_id = ? WHERE id = ?`)
      .run(`attempt-${id}`, id);
    database
      .prepare(`INSERT INTO run_attempts (id, job_id, attempt_number, worker_id,
      worker_node_id, worker_instance_id, status, lease_token_hash, lease_generation,
      lease_expires_at, execution_deadline_at, no_progress_timeout_ms, no_progress_deadline_at,
      last_heartbeat_at, phase, started_at)
      VALUES (?, ?, 1, 'worker-ready', 'node-worker-ready', 'instance-worker-ready',
        'leased', ?, 1, ?, ?, 60000, ?, ?, 'assigned', ?)`)
      .run(`attempt-${id}`, id, hash(id), now, now, now, now, now);
  });
}

describe("fair admission and revocable queue credit", () => {
  it("shares an inline four-bucket budget and preserves discovery beyond recovery reservations", () => {
    const database = open();
    worker(database);
    for (let repository = 1; repository <= 3; repository++)
      job(database, `ready-reservation-${repository}`, "ready", 0, repository);
    pump(database);
    setPlatformLimits(database, { maxActiveLeases: null, maxQueuedJobs: 10 });
    for (let repository = 10; repository < 25; repository++)
      job(database, `incompatible-repository-${repository}`, "missing", 0, repository);
    job(database, "compatible-after-many-repositories", "ready", 0, 25);
    for (let round = 0; round < 16; round++) {
      const inspectionBuckets = new Set<string>();
      const result = transaction(database, () =>
        admitPendingJobsInTransaction(
          database,
          { limit: 32, inspectionBuckets, maximumInspectedBuckets: 4 },
          now,
        ),
      );
      expect(inspectionBuckets.size).toBeLessThanOrEqual(4);
      expect(result.examinedJobCount).toBeLessThanOrEqual(32);
      job(database, `new-repository-${round}`, "missing", 0, 100 + round);
    }
    expect(getJobAdmissionRecord(database, "compatible-after-many-repositories").state).toBe(
      "admitted",
    );
  });

  it("alternates successful repository service and uses independent PR/Issue debt", () => {
    const database = open();
    worker(database);
    const trace = captureAdmissions(database);
    job(database, "a-pr-1");
    job(database, "a-pr-2");
    job(database, "a-pr-3");
    job(database, "a-issue-1", "ready", 0, 1, "issue");
    job(database, "b-pr-1", "ready", 0, 2);
    job(database, "b-pr-2", "ready", 0, 2);
    job(database, "b-pr-3", "ready", 0, 2);
    job(database, "b-issue-1", "ready", 0, 2, "issue");
    expect(pump(database).admittedJobCount).toBe(8);
    expect(trace()).toEqual([
      "a-pr-1",
      "b-pr-1",
      "a-pr-2",
      "b-pr-2",
      "a-issue-1",
      "b-issue-1",
      "a-pr-3",
      "b-pr-3",
    ]);
    expect(readRepositorySchedulingService(database, "github:1")).toMatchObject({
      lastAdmissionTicket: 7,
      admissionPrStreak: 1,
      lastClaimTicket: 0,
      claimPrStreak: 0,
    });
  });

  it("retains Issue debt through PR-only work and spends it at the next compatible opportunity", () => {
    const database = open();
    worker(database);
    job(database, "pr-1");
    job(database, "pr-2");
    job(database, "pr-3");
    pump(database);
    expect(readRepositorySchedulingService(database, "github:1").admissionPrStreak).toBe(2);
    setPlatformLimits(database, { maxActiveLeases: null, maxQueuedJobs: 1 });
    for (const id of ["pr-1", "pr-2", "pr-3"]) releaseQueued(database, id);
    job(database, "pr-next");
    job(database, "issue-next", "ready", 0, 1, "issue");
    expect(pump(database).admittedJobCount).toBe(1);
    expect(getJobAdmissionRecord(database, "issue-next").state).toBe("admitted");
    expect(getJobAdmissionRecord(database, "pr-next").state).toBe("pending");
    expect(readRepositorySchedulingService(database, "github:1").admissionPrStreak).toBe(0);
  });

  it("keeps an older discovered repository ahead of continuously accepted refill work", () => {
    const database = open();
    worker(database);
    setPlatformLimits(database, { maxActiveLeases: null, maxQueuedJobs: 1 });
    job(database, "a-first");
    job(database, "b-waiting", "ready", 0, 2);
    pump(database);
    expect(getJobAdmissionRecord(database, "b-waiting").blockers).toContain("platform_queue_limit");
    for (let index = 0; index < 160; index++) job(database, `a-new-${index}`);
    releaseQueued(database, "a-first");
    expect(pump(database, 8).admittedJobCount).toBe(1);
    expect(getJobAdmissionRecord(database, "b-waiting").state).toBe("admitted");
    expect(readRepositorySchedulingService(database, "github:2").lastAdmissionTicket).toBe(2);
    job(database, "new-repository", "ready", 0, 3);
    expect(readRepositorySchedulingService(database, "github:3").lastAdmissionTicket).toBe(2);
  });

  it("applies repository queue quotas while another repository uses remaining global capacity", () => {
    const database = open();
    worker(database);
    managed(database, 1, { maxActiveLeases: null, maxQueuedJobs: 1 });
    setPlatformLimits(database, { maxActiveLeases: null, maxQueuedJobs: 3 });
    job(database, "a-one");
    job(database, "a-two");
    job(database, "b-one", "ready", 0, 2);
    job(database, "b-two", "ready", 0, 2);
    expect(pump(database).admittedJobCount).toBe(3);
    expect(getJobAdmissionRecord(database, "a-two").blockers).toContain("repository_queue_limit");
    expect(getJobAdmissionRecord(database, "b-two").state).toBe("admitted");
    expect(readSchedulingUsage(database).admittedQueuedJobs).toBe(3);
  });

  it("recovers a paused reservation without replacing the episode and later fairly re-admits it", () => {
    const database = open();
    worker(database);
    managed(database, 1);
    setPlatformLimits(database, { maxActiveLeases: null, maxQueuedJobs: 1 });
    job(database, "paused-credit");
    pump(database);
    const original = getJobAdmissionRecord(database, "paused-credit");
    const jobBytes = database.prepare("SELECT * FROM jobs WHERE id = 'paused-credit'").get();
    database
      .prepare("UPDATE managed_repositories SET enabled = 0 WHERE github_repository_id = 1")
      .run();
    job(database, "other-repository", "ready", 0, 2);
    expect(pump(database, 8)).toMatchObject({ reclaimedJobCount: 1, admittedJobCount: 1 });
    expect(getJobAdmissionRecord(database, "paused-credit")).toMatchObject({
      state: "pending",
      episodeSequence: original.episodeSequence,
      requestedAt: original.requestedAt,
      attemptBase: original.attemptBase,
      blockers: ["repository_paused"],
    });
    expect(database.prepare("SELECT * FROM jobs WHERE id = 'paused-credit'").get()).toEqual(
      jobBytes,
    );
    releaseQueued(database, "other-repository");
    database
      .prepare("UPDATE managed_repositories SET enabled = 1 WHERE github_repository_id = 1")
      .run();
    expect(pump(database).admittedJobCount).toBe(1);
    expect(getJobAdmissionRecord(database, "paused-credit")).toMatchObject({
      state: "admitted",
      episodeSequence: original.episodeSequence,
      requestedAt: original.requestedAt,
    });
  });

  it("recovers only completely unsupported fleet credit while another execution path can progress", () => {
    const database = open();
    worker(database, "worker-original", "original");
    setPlatformLimits(database, { maxActiveLeases: null, maxQueuedJobs: 1 });
    job(database, "unsupported-credit", "original");
    pump(database);
    const original = getJobAdmissionRecord(database, "unsupported-credit");
    database.prepare("UPDATE workers SET status = 'offline' WHERE id = 'worker-original'").run();
    worker(database);
    job(database, "supported-other", "ready", 0, 2);
    expect(pump(database, 8)).toMatchObject({ reclaimedJobCount: 1, admittedJobCount: 1 });
    expect(getJobAdmissionRecord(database, "unsupported-credit")).toMatchObject({
      state: "pending",
      episodeSequence: original.episodeSequence,
      requestedAt: original.requestedAt,
    });
    expect(getJobAdmissionRecord(database, "supported-other").state).toBe("admitted");
  });

  it("does not churn busy slots, future backoff, or incomplete runtime inventory", () => {
    const database = open();
    worker(database, "worker-original", "original");
    setPlatformLimits(database, { maxActiveLeases: null, maxQueuedJobs: 1 });
    job(database, "held-credit", "original");
    pump(database);
    database
      .prepare("UPDATE jobs SET next_attempt_at = ? WHERE id = 'held-credit'")
      .run("2026-09-08T12:00:00.000Z");
    job(database, "waiting-other", "ready", 0, 2);
    expect(pump(database, 8).reclaimedJobCount).toBeUndefined();
    expect(getJobAdmissionRecord(database, "held-credit").state).toBe("admitted");
    database.prepare("UPDATE workers SET status = 'offline' WHERE id = 'worker-original'").run();
    for (let index = 0; index < 129; index++) worker(database, `partial-worker-${index}`);
    expect(pump(database, 8).reclaimedJobCount).toBeUndefined();
    expect(getJobAdmissionRecord(database, "held-credit").state).toBe("admitted");
    expect(getJobAdmissionRecord(database, "waiting-other").state).toBe("pending");
  });

  it.each([false, true])(
    "keeps active attempts intact and distinguishes shared saturation: %s",
    (globalFull) => {
      const database = open();
      worker(database);
      managed(database, 1);
      job(database, "active-job");
      job(database, "reserved-job");
      pump(database);
      fixtureGrant(database, "active-job");
      const active = database
        .prepare("SELECT * FROM run_attempts WHERE job_id = 'active-job'")
        .get();
      const activeAdmission = getJobAdmissionRecord(database, "active-job");
      database
        .prepare(
          "UPDATE managed_repositories SET max_active_leases = 1 WHERE github_repository_id = 1",
        )
        .run();
      setPlatformLimits(database, { maxActiveLeases: globalFull ? 1 : 2, maxQueuedJobs: 1 });
      job(database, "other-job", "ready", 0, 2);
      const result = pump(database, 8);
      expect(result.reclaimedJobCount ?? 0).toBe(globalFull ? 0 : 1);
      expect(getJobAdmissionRecord(database, "other-job").state).toBe(
        globalFull ? "pending" : "admitted",
      );
      expect(getJobAdmissionRecord(database, "active-job")).toEqual(activeAdmission);
      expect(
        database.prepare("SELECT * FROM run_attempts WHERE job_id = 'active-job'").get(),
      ).toEqual(active);
      expect(readSchedulingUsage(database).activeLeases).toBe(1);
    },
  );

  it("bounds recovery plus discovery together and retains a finite recovery pass", () => {
    const database = open();
    worker(database);
    managed(database, 1);
    for (let index = 0; index < 10; index++) job(database, `old-credit-${index}`);
    pump(database);
    setPlatformLimits(database, { maxActiveLeases: null, maxQueuedJobs: 1 });
    database
      .prepare("UPDATE managed_repositories SET enabled = 0 WHERE github_repository_id = 1")
      .run();
    job(database, "later-repository", "ready", 0, 2);
    for (let round = 0; round < 10; round++) {
      const result = pump(database, 4);
      expect(result.examinedJobCount).toBeLessThanOrEqual(4);
      expect(result.reclaimedJobCount).toBe(1);
      job(database, `continuous-arrival-${round}`, "missing", 0, 3);
    }
    // Recovering the last credit may consume the final discovery opportunity in a small
    // batch. The next owned wake rechecks the known eligible waiter under the same bound.
    const admittedAfterRecovery = pump(database, 4);
    expect(admittedAfterRecovery.examinedJobCount).toBeLessThanOrEqual(4);
    expect(admittedAfterRecovery.admittedJobCount).toBe(1);
    expect(getJobAdmissionRecord(database, "later-repository").state).toBe("admitted");
    expect(
      database
        .prepare(
          "SELECT recovery_pass_high_water, recovery_pass_after_sequence FROM scheduling_state",
        )
        .get(),
    ).toEqual({ recovery_pass_high_water: 11, recovery_pass_after_sequence: 11 });
  });
});
