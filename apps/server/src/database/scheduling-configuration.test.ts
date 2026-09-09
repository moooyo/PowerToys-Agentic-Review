import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  JobExecutionTemplate,
  ManagedRepository,
  SchedulingLimits,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest, type OperatorReadContext } from "./operator-access.js";
import {
  handleSchedulingConfigurationRequest,
  isSchedulingConfigurationOperation,
  type SchedulingConfigurationOperation,
  type SchedulingConfigurationOperationMap,
  type SchedulingConfigurationRequest,
} from "./scheduling-configuration.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
const actor = { issuer: "https://identity.example.test", subject: "platform-admin" };
const principal = { issuer: actor.issuer, subject: "repository-reader" };
const administrator: OperatorReadContext = { actor, administrators: [actor] };
const reader: OperatorReadContext = { actor: principal, administrators: [actor] };
const unlimited: SchedulingLimits = { maxActiveLeases: null, maxQueuedJobs: null };
const migrations = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const databases: DatabaseSync[] = [];

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The scheduling fixture is missing.");
  return value;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open() {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(database);
  database.exec("PRAGMA trusted_schema = OFF; PRAGMA recursive_triggers = OFF");
  runMigrations(database, migrations);
  const bootstrap = database
    .prepare("SELECT updated_at FROM platform_scheduling_configuration")
    .get() as { updated_at: string };
  // Configuration starts at the real migration instant; observations use a later synthetic time.
  const now = new Date(Date.parse(bootstrap.updated_at) + 60_000).toISOString();
  return { database, now };
}
function execute<K extends SchedulingConfigurationOperation>(
  database: DatabaseSync,
  operation: K,
  input: SchedulingConfigurationOperationMap[K]["input"],
  now: string,
  context: OperatorReadContext = administrator,
): SchedulingConfigurationOperationMap[K]["output"] {
  return handleSchedulingConfigurationRequest(
    database,
    { operation, input } as SchedulingConfigurationRequest,
    now,
    context,
  ) as SchedulingConfigurationOperationMap[K]["output"];
}
function update(database: DatabaseSync, now: string, limits = unlimited, expectedVersion = 1) {
  return execute(
    database,
    "updatePlatformSchedulingConfiguration",
    {
      actor,
      request: { expectedVersion, limits },
    },
    now,
  );
}
function repository(database: DatabaseSync, now: string, number: number): ManagedRepository {
  return handleRepositoryConfigurationRequest(
    database,
    {
      operation: "createManagedRepository",
      input: {
        actor,
        request: {
          githubRepositoryId: number,
          fullName: `example/repository-${number}`,
          enabled: true,
        },
      },
    },
    now,
  ) as ManagedRepository;
}
function access(database: DatabaseSync, now: string, repositoryId: string, revoke = false) {
  handleOperatorAccessRequest(
    database,
    {
      operation: "changeRepositoryAccess",
      input: {
        actor,
        repositoryId,
        request: {
          changeId: `access-${revoke ? "revoke" : "grant"}-${repositoryId}`,
          principal,
          role: revoke ? null : "viewer",
          expectedVersion: revoke ? 1 : 0,
          reason: "Synthetic scheduling status access.",
        },
      },
    },
    now,
    [actor],
  );
}
function job(database: DatabaseSync, now: string, id: string, number: number, admitted: boolean) {
  const template: JobExecutionTemplate = {
    repository: { githubRepositoryId: number, fullName: `example/repository-${number}` },
    resource: {
      kind: "pull_request",
      githubNodeId: `PR_${id}`,
      number: 1,
      title: "Scheduling fixture",
      author: { githubUserId: 2, login: "fixture" },
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
      hardTimeoutMs: 60_000,
      noProgressTimeoutMs: 30_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`INSERT INTO jobs (id, job_kind, semantic_key, concurrency_key, status,
      execution_json, resource_revision, next_attempt_at, created_at, updated_at)
      VALUES (?, 'pull_request_review', ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .run(id, id, id, JSON.stringify(template), "b".repeat(40), now, now, now);
    createJobAdmissionInTransaction(database, id, now);
    if (admitted)
      database
        .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
        .run(now, id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("platform scheduling configuration and history", () => {
  it("bootstraps unlimited once and preserves saved configuration across migration reruns", () => {
    const { database, now } = open();
    const initial = execute(database, "getPlatformSchedulingStatus", {}, now);
    expect(initial.configuration).toMatchObject({
      version: 1,
      limits: unlimited,
      policyId: "repository-service-v1",
    });
    expect(initial.usage).toEqual({
      activeLeases: 0,
      admittedQueuedJobs: 0,
      awaitingAdmissionJobs: 0,
      awaitingConfigurationRequests: 0,
    });
    expect(execute(database, "listPlatformSchedulingConfigurationAudit", {}, now).total).toBe(0);
    const saved = update(database, now, { maxActiveLeases: 2, maxQueuedJobs: 5 });
    expect(runMigrations(database, migrations)).toBe(31);
    expect(execute(database, "getPlatformSchedulingStatus", {}, now).configuration).toEqual(saved);
  });

  it("records exact previous/new snapshots atomically and clears limits through explicit null", () => {
    const { database, now } = open();
    const previous = execute(database, "getPlatformSchedulingStatus", {}, now).configuration;
    const saved = update(database, now, { maxActiveLeases: 65_535, maxQueuedJobs: 1_000_000 });
    const listing = execute(
      database,
      "listPlatformSchedulingConfigurationAudit",
      { page: 1, pageSize: 1 },
      now,
    );
    expect(listing).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    const summary = present(listing.items[0]);
    expect(summary).toMatchObject({ actor, previousVersion: 1, version: 2, createdAt: now });
    expect(
      execute(database, "getPlatformSchedulingConfigurationAudit", { eventId: summary.id }, now),
    ).toEqual({
      ...summary,
      previousSnapshot: previous,
      snapshot: saved,
    });
    const bytes = database
      .prepare(
        "SELECT previous_snapshot_json, snapshot_json FROM platform_scheduling_configuration_audit WHERE id = ?",
      )
      .get(summary.id);
    expect(bytes).toEqual({
      previous_snapshot_json: JSON.stringify(previous),
      snapshot_json: JSON.stringify(saved),
    });
    expect(update(database, now, unlimited, 2).limits).toEqual(unlimited);
    expect(
      database
        .prepare(
          "SELECT previous_snapshot_json, snapshot_json FROM platform_scheduling_configuration_audit WHERE id = ?",
        )
        .get(summary.id),
    ).toEqual(bytes);
  });

  it("rejects stale CAS and rolls back an audit write failure without changing settings", () => {
    const { database, now } = open();
    const saved = update(database, now, { maxActiveLeases: 1, maxQueuedJobs: 1 });
    expect(() => update(database, now, unlimited, 1)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
    );
    database.exec(`CREATE TRIGGER fixture_reject_scheduling_audit BEFORE INSERT ON platform_scheduling_configuration_audit
      BEGIN SELECT RAISE(ABORT, 'Synthetic audit failure'); END`);
    expect(() => update(database, now, unlimited, 2)).toThrow("Synthetic audit failure");
    expect(execute(database, "getPlatformSchedulingStatus", {}, now).configuration).toEqual(saved);
    expect(execute(database, "listPlatformSchedulingConfigurationAudit", {}, now).total).toBe(1);
  });

  it("accepts either JSON property order without treating the saved limits as corrupt", () => {
    const { database, now } = open();
    const saved = update(database, now, { maxQueuedJobs: 10, maxActiveLeases: 2 });
    expect(saved).toMatchObject({ version: 2, limits: { maxActiveLeases: 2, maxQueuedJobs: 10 } });
    const [summary] = execute(database, "listPlatformSchedulingConfigurationAudit", {}, now).items;
    const event = execute(
      database,
      "getPlatformSchedulingConfigurationAudit",
      { eventId: present(summary).id },
      now,
    );
    expect(present(event).snapshot).toEqual(saved);
  });

  it.each([
    { maxActiveLeases: 0, maxQueuedJobs: null },
    { maxActiveLeases: -1, maxQueuedJobs: 1 },
    { maxActiveLeases: 1.5, maxQueuedJobs: 1 },
    { maxActiveLeases: 65_536, maxQueuedJobs: 1 },
    { maxActiveLeases: null, maxQueuedJobs: 1_000_001 },
    { maxActiveLeases: null },
    { maxActiveLeases: null, maxQueuedJobs: null, injected: true },
  ])("rejects invalid complete limit replacements: %j", (limits) => {
    const { database, now } = open();
    expect(() => update(database, now, limits as SchedulingLimits)).toThrow(
      expect.objectContaining({ code: "PLATFORM_INVALID" }),
    );
    expect(execute(database, "getPlatformSchedulingStatus", {}, now).configuration.version).toBe(1);
    expect(execute(database, "listPlatformSchedulingConfigurationAudit", {}, now).total).toBe(0);
  });

  it("requires platform authority for global reads, writes and both audit operations", () => {
    const { database, now } = open();
    const requests: SchedulingConfigurationRequest[] = [
      { operation: "getPlatformSchedulingStatus", input: {} },
      {
        operation: "updatePlatformSchedulingConfiguration",
        input: { actor: principal, request: { expectedVersion: 1, limits: unlimited } },
      },
      { operation: "listPlatformSchedulingConfigurationAudit", input: {} },
      { operation: "getPlatformSchedulingConfigurationAudit", input: { eventId: "foreign-event" } },
    ];
    for (const request of requests)
      expect(() => handleSchedulingConfigurationRequest(database, request, now, reader)).toThrow(
        expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }),
      );
    expect(() =>
      execute(
        database,
        "updatePlatformSchedulingConfiguration",
        { actor: principal, request: { expectedVersion: 1, limits: unlimited } },
        now,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });

  it("uses bounded stable audit pages, rejects query overrides, and does not mutate on reads", () => {
    const { database, now } = open();
    update(database, now, unlimited, 1);
    update(database, now, { maxActiveLeases: 1, maxQueuedJobs: 1 }, 2);
    const changes = database.prepare("SELECT total_changes() AS count").get();
    const full = execute(database, "listPlatformSchedulingConfigurationAudit", {}, now);
    expect(full.items.map((event) => event.id)).toEqual(
      full.items
        .map((event) => event.id)
        .sort()
        .reverse(),
    );
    expect(
      execute(database, "listPlatformSchedulingConfigurationAudit", { page: 2, pageSize: 1 }, now)
        .items,
    ).toEqual([full.items[1]]);
    expect(
      execute(
        database,
        "getPlatformSchedulingConfigurationAudit",
        { eventId: "missing-event" },
        now,
      ),
    ).toBeNull();
    execute(database, "getPlatformSchedulingStatus", {}, now);
    expect(database.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
    for (const input of [
      { page: 0 },
      { pageSize: 21 },
      { page: 10_000_001 },
      { repositoryId: "injected" },
    ])
      expect(() =>
        execute(database, "listPlatformSchedulingConfigurationAudit", input, now),
      ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });
});

describe("repository scheduling status", () => {
  it("counts numeric Legacy ownership while restricting global usage and rechecking revocation", () => {
    const { database, now } = open();
    const first = repository(database, now, 1);
    const second = repository(database, now, 2);
    access(database, now, first.id);
    job(database, now, "own-pending", 1, false);
    job(database, now, "foreign-admitted", 2, true);
    update(database, now, { maxActiveLeases: null, maxQueuedJobs: 1 });
    const changes = database.prepare("SELECT total_changes() AS count").get();
    const status = present(
      execute(database, "getRepositorySchedulingStatus", { repositoryId: first.id }, now, reader),
    );
    expect(status).toMatchObject({
      repositoryId: first.id,
      repositoryVersion: 1,
      enabled: true,
      limits: unlimited,
      usage: {
        activeLeases: 0,
        admittedQueuedJobs: 0,
        awaitingAdmissionJobs: 1,
        awaitingConfigurationRequests: 0,
      },
      overage: { activeLeases: 0, admittedQueuedJobs: 0 },
      platform: {
        visibility: "restricted",
        version: 2,
        activeCapacity: "available",
        queueCapacity: "limited",
      },
    });
    expect(Object.keys(status.platform).sort()).toEqual([
      "activeCapacity",
      "queueCapacity",
      "version",
      "visibility",
    ]);
    expect(JSON.stringify(status)).not.toContain(second.id);
    expect(
      present(execute(database, "getRepositorySchedulingStatus", { repositoryId: first.id }, now))
        .platform,
    ).toMatchObject({
      visibility: "full",
      usage: { admittedQueuedJobs: 1, awaitingAdmissionJobs: 1 },
    });
    expect(() =>
      execute(database, "getRepositorySchedulingStatus", { repositoryId: second.id }, now, reader),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(database.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
    access(database, now, first.id, true);
    expect(() =>
      execute(database, "getRepositorySchedulingStatus", { repositoryId: first.id }, now, reader),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
  });

  it("registers only the five explicit configuration operations", () => {
    expect(isSchedulingConfigurationOperation("getRepositorySchedulingStatus")).toBe(true);
    expect(isSchedulingConfigurationOperation("updatePlatformSchedulingConfiguration")).toBe(true);
    expect(isSchedulingConfigurationOperation("getPlatformJobScheduling")).toBe(false);
    expect(isSchedulingConfigurationOperation("advanceSchedulingCursor")).toBe(false);
  });
});
