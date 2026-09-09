import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type JobExecutionTemplate,
  maximumClaimLeaseResponseUtf8Bytes,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWaitingAdmissionIntegrity,
  beginRetryAdmissionInTransaction,
  createJobAdmissionInTransaction,
  getJobAdmissionRecord,
  readJobAdmission,
  refineJobAdmissionOwnershipInTransaction,
} from "./job-admission.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest } from "./operator-access.js";

const now = "2026-09-07T12:00:00.000Z";
const later = "2026-09-07T12:01:00.000Z";
const earlier = "2026-09-07T11:59:00.000Z";
const databases: DatabaseSync[] = [];
const template: JobExecutionTemplate = {
  repository: { githubRepositoryId: 42, fullName: "example/admission-fixture" },
  resource: {
    kind: "pull_request",
    githubNodeId: "PR_admission",
    number: 7,
    title: "Admission fixture",
    author: { githubUserId: 9, login: "fixture-author" },
    canonicalSnapshot: {},
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    isDraft: false,
  },
  prompt: {
    name: "review",
    version: "fixture",
    renderedPrompt: "Review the fixture.",
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
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(): DatabaseSync {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(database);
  database.exec("PRAGMA trusted_schema = OFF; PRAGMA recursive_triggers = OFF");
  runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
  return database;
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
function insert(database: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void {
  database
    .prepare(
      `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(row));
}
function rawJob(
  database: DatabaseSync,
  jobId = "job-1",
  extra: Record<string, SQLInputValue> = {},
): void {
  insert(database, "jobs", {
    id: jobId,
    job_kind: "pull_request_review",
    semantic_key: jobId,
    concurrency_key: jobId,
    status: "queued",
    execution_json: JSON.stringify(template),
    resource_revision: "b".repeat(40),
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
    ...extra,
  });
}
function create(
  database: DatabaseSync,
  jobId = "job-1",
  extra: Record<string, SQLInputValue> = {},
) {
  return transaction(database, () => {
    rawJob(database, jobId, extra);
    return createJobAdmissionInTransaction(database, jobId, now);
  });
}
function admit(database: DatabaseSync, jobId = "job-1"): void {
  database
    .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
    .run(now, jobId);
}
function grant(database: DatabaseSync, jobId = "job-1", attemptId = "attempt-1"): void {
  database
    .prepare(`UPDATE jobs SET status = 'leased', current_run_attempt_id = ?,
    attempt_count = attempt_count + 1 WHERE id = ?`)
    .run(attemptId, jobId);
}
function insertAttempt(database: DatabaseSync, jobId = "job-1", attemptId = "attempt-1"): void {
  if (!database.prepare("SELECT 1 FROM workers WHERE id = 'worker-1'").get())
    insert(database, "workers", {
      id: "worker-1",
      node_id: "node-1",
      instance_id: "instance-1",
      display_name: "Fixture worker",
      version: "1.0.0",
      protocol_version: "1.0",
      max_slots: 1,
      capabilities_json: "{}",
      capabilities_digest: "a".repeat(64),
      status: "online",
      registered_at: now,
      last_seen_at: now,
      updated_at: now,
    });
  insert(database, "run_attempts", {
    id: attemptId,
    job_id: jobId,
    attempt_number: 1,
    worker_id: "worker-1",
    worker_node_id: "node-1",
    worker_instance_id: "instance-1",
    status: "leased",
    lease_token_hash: "a".repeat(64),
    lease_generation: 1,
    lease_expires_at: later,
    execution_deadline_at: later,
    no_progress_timeout_ms: 60_000,
    no_progress_deadline_at: later,
    last_heartbeat_at: now,
    phase: "assigned",
    started_at: now,
  });
}
function finishForRetry(database: DatabaseSync): void {
  database
    .prepare("UPDATE run_attempts SET status = 'failed', ended_at = ? WHERE id = 'attempt-1'")
    .run(later);
  database
    .prepare(
      "UPDATE jobs SET status = 'retry_waiting', current_run_attempt_id = NULL WHERE id = 'job-1'",
    )
    .run();
}
function owner(database: DatabaseSync, id: string, number: number): void {
  insert(database, "repositories", {
    id,
    github_repository_id: number,
    github_node_id: `R_${id}`,
    owner_login: "example",
    name: id,
    full_name: `example/${id}`,
    html_url: `https://example.test/${id}`,
    default_branch: "main",
    is_private: 0,
    snapshot_json: "{}",
    observed_at: now,
    created_at: now,
    updated_at: now,
  });
  insert(database, "managed_repositories", {
    id,
    github_repository_id: number,
    full_name: `example/${id}`,
    enabled: 1,
    version: 1,
    connection_status: "unknown",
    configuration_source: "discovered",
    created_at: now,
    updated_at: now,
  });
  insert(database, "work_items", {
    id: `item-${id}`,
    repository_id: id,
    resource_kind: "pull_request",
    github_work_item_id: number,
    github_node_id: `PR_${id}`,
    github_number: 7,
    state: "open",
    title: "Fixture pull request",
    html_url: `https://example.test/${id}/pull/7`,
    author_github_user_id: 9,
    author_login: "fixture-author",
    author_account_type: "user",
    current_revision_key: "b".repeat(40),
    is_draft: 0,
    source_created_at: now,
    source_updated_at: now,
    snapshot_json: "{}",
    projection_source: "webhook",
    observed_at: now,
    created_at: now,
    updated_at: now,
  });
}

describe("durable job admission", () => {
  it("creates a real pending episode with numeric Legacy ownership and no lease", () => {
    const database = open();
    expect(create(database)).toMatchObject({
      jobId: "job-1",
      state: "pending",
      attemptBase: 0,
      episodeSequence: 1,
      requestedAt: now,
      timestampBasis: "recorded",
      admittedAt: null,
      bucketKey: "github:42",
      githubRepositoryId: 42,
      ownershipState: "resolved",
    });
    expect(
      readJobAdmission(database, { jobId: "job-1", status: "queued", attemptCount: 0 }),
    ).toEqual({
      state: "pending",
      attemptBase: 0,
      requestedAt: now,
      timestampBasis: "recorded",
      admittedAt: null,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toMatchObject({
      count: 0,
    });
    expect(() => assertWaitingAdmissionIntegrity(database)).not.toThrow();
  });

  it("requires a transaction and rolls accepted Job and episode sequence back together", () => {
    const database = open();
    rawJob(database);
    expect(() => createJobAdmissionInTransaction(database, "job-1", now)).toThrow(/inconsistent/);
    const before = database.prepare("SELECT * FROM scheduling_state").get();
    expect(() =>
      transaction(database, () => {
        createJobAdmissionInTransaction(database, "job-1", now);
        rawJob(database, "job-2");
        createJobAdmissionInTransaction(database, "job-2", now);
        throw new Error("Rollback fixture");
      }),
    ).toThrow("Rollback fixture");
    expect(database.prepare("SELECT * FROM scheduling_state").get()).toEqual(before);
    expect(database.prepare("SELECT id FROM jobs ORDER BY id").all()).toEqual([{ id: "job-1" }]);
    expect(database.prepare("SELECT * FROM job_admission").all()).toEqual([]);
  });

  it("does not invent admission for a missing or stale current waiting episode", () => {
    const database = open();
    rawJob(database);
    expect(() =>
      readJobAdmission(database, { jobId: "job-1", status: "queued", attemptCount: 0 }),
    ).toThrow(/inconsistent/);
    expect(() => assertWaitingAdmissionIntegrity(database)).toThrow(/inconsistent/);
    transaction(database, () => createJobAdmissionInTransaction(database, "job-1", now));
    database.exec("UPDATE jobs SET attempt_count = 1 WHERE id = 'job-1'");
    expect(() => assertWaitingAdmissionIntegrity(database)).toThrow(/inconsistent/);
    expect(() =>
      readJobAdmission(database, { jobId: "job-1", status: "queued", attemptCount: 1 }),
    ).toThrow(/inconsistent/);
  });

  it.each(["requested_at", "timestamp_basis", "admitted_at"])(
    "rejects corrupt public %s before filtered counts",
    (column) => {
      const database = open();
      create(database);
      admit(database);
      if (column === "timestamp_basis" || column === "requested_at") {
        expect(() =>
          database.prepare(`UPDATE job_admission SET ${column} = ?`).run("invalid"),
        ).toThrow();
        return;
      }
      database.prepare(`UPDATE job_admission SET ${column} = ?`).run("not-a-date");
      expect(() => assertWaitingAdmissionIntegrity(database)).toThrow(/inconsistent/);
      expect(() =>
        readJobAdmission(database, { jobId: "job-1", status: "queued", attemptCount: 0 }),
      ).toThrow(/inconsistent/);
    },
  );

  it("keeps foreign corrupt admission outside repository authorization scope", () => {
    const database = open();
    owner(database, "repo-a", 42);
    owner(database, "repo-b", 43);
    create(database, "job-a", { work_item_id: "item-repo-a" });
    rawJob(database, "job-b", { work_item_id: "item-repo-b" });
    const administrator = { issuer: "https://identity.example.test", subject: "admin" };
    const context = {
      actor: { issuer: "https://identity.example.test", subject: "viewer" },
      administrators: [],
    };
    handleOperatorAccessRequest(
      database,
      {
        operation: "changeRepositoryAccess",
        input: {
          actor: administrator,
          repositoryId: "repo-a",
          request: {
            principal: context.actor,
            role: "viewer",
            expectedVersion: 0,
            changeId: "admission-scope-viewer",
            reason: "Grant read access to the isolated admission fixture.",
          },
        },
      },
      now,
      [administrator],
    );
    expect(() => assertWaitingAdmissionIntegrity(database, { context })).not.toThrow();
    expect(() =>
      assertWaitingAdmissionIntegrity(database, { repositoryId: "repo-a" }),
    ).not.toThrow();
    expect(() => assertWaitingAdmissionIntegrity(database)).toThrow(/inconsistent/);
  });

  it.each(["{", "{}"])(
    "classifies invalid stored templates without losing accepted Jobs: %s",
    (execution) => {
      const database = open();
      expect(create(database, "job-1", { execution_json: execution })).toMatchObject({
        state: "pending",
        ownershipState: "invalid_template",
        bucketKey: "unscoped",
        githubRepositoryId: null,
      });
      admit(database);
      expect(() => grant(database)).toThrow(/matching admitted/);
    },
  );

  it("preserves the known numeric bucket when associated template ownership conflicts", () => {
    const database = open();
    owner(database, "repo-a", 43);
    expect(create(database, "job-1", { work_item_id: "item-repo-a" })).toMatchObject({
      ownershipState: "conflict",
      bucketKey: "github:43",
      githubRepositoryId: 43,
    });
    admit(database);
    expect(() => grant(database)).toThrow(/matching admitted/);
  });

  it("uses persisted bytes to refine bounded unknown ownership without changing the episode", () => {
    const database = open();
    const raw = " ".repeat(maximumClaimLeaseResponseUtf8Bytes) + JSON.stringify(template);
    const before = create(database, "job-1", { execution_json: raw });
    expect(before.ownershipState).toBe("unverified");
    const refined = transaction(database, () =>
      refineJobAdmissionOwnershipInTransaction(database, "job-1", {
        ...template,
        repository: { githubRepositoryId: 999, fullName: "foreign/claim" },
      }),
    );
    expect(refined).toEqual({
      ...before,
      ownershipState: "resolved",
      bucketKey: "github:42",
      githubRepositoryId: 42,
    });
    expect(
      database.prepare("SELECT execution_json FROM jobs WHERE id = 'job-1'").get(),
    ).toMatchObject({ execution_json: raw });
  });

  it("does not refine previously invalid or conflicting ownership from supplied templates", () => {
    const database = open();
    create(database, "job-1", { execution_json: "{}" });
    const before = getJobAdmissionRecord(database, "job-1");
    expect(
      transaction(database, () =>
        refineJobAdmissionOwnershipInTransaction(database, "job-1", template),
      ),
    ).toEqual(before);
  });

  it("requires admission for a lease and the exact Job pointer before an active attempt", () => {
    const database = open();
    create(database);
    expect(() => grant(database)).toThrow(/matching admitted/);
    admit(database);
    expect(() => insertAttempt(database)).toThrow(/admitted queue episode/);
    grant(database);
    insertAttempt(database);
    expect(
      readJobAdmission(database, { jobId: "job-1", status: "leased", attemptCount: 1 }),
    ).toBeNull();
    expect(() =>
      database.exec("UPDATE job_admission SET state = 'pending', admitted_at = NULL"),
    ).toThrow(/unleased waiting/);
    expect(() => create(database, "job-active", { status: "leased", attempt_count: 1 })).toThrow(
      /acquire admission/,
    );
  });

  it("opens one new pending retry episode only after the attempt is terminal", () => {
    const database = open();
    const first = create(database);
    admit(database);
    grant(database);
    insertAttempt(database);
    expect(() =>
      transaction(database, () => beginRetryAdmissionInTransaction(database, "job-1", later)),
    ).toThrow(/inconsistent/);
    const retry = transaction(database, () => {
      finishForRetry(database);
      return beginRetryAdmissionInTransaction(database, "job-1", earlier);
    });
    expect(retry).toMatchObject({
      state: "pending",
      attemptBase: 1,
      episodeSequence: first.episodeSequence + 1,
      requestedAt: earlier,
      timestampBasis: "recorded",
      admittedAt: null,
    });
    const state = database.prepare("SELECT * FROM scheduling_state").get();
    expect(
      transaction(database, () => beginRetryAdmissionInTransaction(database, "job-1", later)),
    ).toEqual(retry);
    expect(database.prepare("SELECT * FROM scheduling_state").get()).toEqual(state);
    expect(() => grant(database, "job-1", "attempt-2")).toThrow(/matching admitted/);
  });

  it("rolls terminal attempt, retry state and new admission sequence back together", () => {
    const database = open();
    create(database);
    admit(database);
    grant(database);
    insertAttempt(database);
    const before = ["jobs", "run_attempts", "job_admission", "scheduling_state"].map((table) =>
      database.prepare(`SELECT * FROM ${table}`).all(),
    );
    expect(() =>
      transaction(database, () => {
        finishForRetry(database);
        beginRetryAdmissionInTransaction(database, "job-1", later);
        throw new Error("Fail after retry");
      }),
    ).toThrow("Fail after retry");
    expect(
      ["jobs", "run_attempts", "job_admission", "scheduling_state"].map((table) =>
        database.prepare(`SELECT * FROM ${table}`).all(),
      ),
    ).toEqual(before);
  });

  it("rejects unsafe episode allocation atomically instead of rounding", () => {
    const database = open();
    database.exec("UPDATE scheduling_state SET episode_sequence = 9007199254740991");
    expect(() => create(database)).toThrow(/inconsistent/);
    expect(database.prepare("SELECT * FROM jobs").all()).toEqual([]);
    expect(database.prepare("SELECT episode_sequence FROM scheduling_state").get()).toMatchObject({
      episode_sequence: Number.MAX_SAFE_INTEGER,
    });
  });

  it("protects admission identity, replacement and deletion even with recursive triggers off", () => {
    const database = open();
    create(database);
    expect(() => database.exec("DELETE FROM job_admission")).toThrow(/cannot be deleted/);
    expect(() =>
      database.exec("INSERT OR REPLACE INTO job_admission SELECT * FROM job_admission"),
    ).toThrow(/cannot be replaced/);
    expect(() => database.exec("UPDATE job_admission SET job_id = 'other'")).toThrow(/immutable/);
    expect(() => database.exec("UPDATE job_admission SET rowid = 2")).toThrow(/rowid/);
    expect(() => database.exec("DELETE FROM scheduling_state")).toThrow(/cannot be deleted/);
    expect(() =>
      database.exec("INSERT OR REPLACE INTO scheduling_state SELECT * FROM scheduling_state"),
    ).toThrow(/cannot be replaced/);
    expect(() => database.exec("UPDATE scheduling_state SET episode_sequence = 0")).toThrow(
      /invalid scheduling/,
    );
  });

  it("freezes the remaining Legacy ownership inputs once admission exists", () => {
    const database = open();
    create(database);
    expect(() =>
      database.prepare("UPDATE jobs SET execution_json = ?").run(
        JSON.stringify({
          ...template,
          repository: { ...template.repository, githubRepositoryId: 99 },
        }),
      ),
    ).toThrow(/ownership inputs are immutable/);
    expect(() => database.exec("UPDATE jobs SET work_item_id = 'unresolved'")).toThrow(
      /ownership inputs are immutable/,
    );
  });
});
