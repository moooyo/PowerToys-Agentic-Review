import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { JobExecutionTemplate } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import { runMigrations } from "./migrations.js";
import {
  type FairClaimCandidate,
  inspectFairClaimCandidates,
  type SchedulingClaimWorker,
} from "./scheduling-claim-scan.js";
import { parseExecutionTemplate, satisfiesRequirement } from "./scheduling-eligibility.js";
import {
  readRepositorySchedulingService,
  recordSuccessfulSchedulingServiceInTransaction,
  type SchedulingWorkClass,
} from "./scheduling-service.js";

const now = "2026-09-07T12:00:00.000Z";
const migrations = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const databases: DatabaseSync[] = [];
const directories: string[] = [];
const worker: SchedulingClaimWorker = {
  id: "scanner-worker",
  instanceId: "scanner-instance",
  protocolVersion: "1.0",
  capabilitiesDigest: "a".repeat(64),
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

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

function open(path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  databases.push(database);
  database.exec("PRAGMA trusted_schema = OFF; PRAGMA recursive_triggers = OFF");
  runMigrations(database, migrations);
  return database;
}

interface JobOptions {
  readonly repository?: number;
  readonly workClass?: SchedulingWorkClass;
  readonly pool?: string;
  readonly requestedAt?: string;
  readonly nextAttemptAt?: string;
  readonly priority?: number;
  readonly concurrencyKey?: string;
  readonly affinityNodeId?: string;
}

function addJob(database: DatabaseSync, id: string, options: JobOptions = {}): void {
  const workClass = options.workClass ?? "pull_request";
  const requestedAt = options.requestedAt ?? now;
  const template: JobExecutionTemplate = {
    repository: {
      githubRepositoryId: options.repository ?? 101,
      fullName: `fixture/repository-${options.repository ?? 101}`,
    },
    resource:
      workClass === "issue"
        ? {
            kind: "issue",
            githubNodeId: `ISSUE_${id}`,
            number: 1,
            title: "Isolated scanner fixture",
            author: { githubUserId: 1, login: "fixture" },
            canonicalSnapshot: {},
            revisionDigest: hash(id),
          }
        : {
            kind: "pull_request",
            githubNodeId: `PR_${id}`,
            number: 1,
            title: "Isolated scanner fixture",
            author: { githubUserId: 1, login: "fixture" },
            canonicalSnapshot: {},
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            isDraft: false,
          },
    prompt: {
      name: "fixture",
      version: "1",
      renderedPrompt: "Inspect the isolated scanner fixture.",
      promptSha256: hash("fixture"),
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
  const execution = JSON.stringify(template);
  const requirements = JSON.stringify({ labels: { pool: options.pool ?? "ready" } });
  const insert = () => {
    database
      .prepare(`INSERT INTO jobs (id, job_kind, semantic_key, concurrency_key,
      status, priority, execution_json, execution_digest, required_capabilities_json,
      required_capabilities_digest, resource_revision, execution_affinity_node_id,
      next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        workClass === "issue" ? "issue_triage" : "pull_request_review",
        `semantic:${id}`,
        options.concurrencyKey ?? `concurrency:${id}`,
        options.priority ?? 0,
        execution,
        hash(execution),
        requirements,
        hash(requirements),
        hash("revision"),
        options.affinityNodeId ?? null,
        options.nextAttemptAt ?? requestedAt,
        requestedAt,
        requestedAt,
      );
    createJobAdmissionInTransaction(database, id, requestedAt);
    database
      .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
      .run(requestedAt, id);
  };
  if (database.isTransaction) insert();
  else transaction(database, insert);
}

function backlog(
  database: DatabaseSync,
  count: number,
  options: JobOptions = {},
  prefix = "blocked",
): void {
  transaction(database, () => {
    for (let index = 0; index < count; index++)
      addJob(database, `${prefix}-${index.toString().padStart(4, "0")}`, {
        pool: "unsupported",
        ...options,
      });
  });
}

// Primary-pass tests discard fixture insertion invalidations. Recheck tests inject explicit
// operational events below; atomic lease release is exercised by the claim integration suites.
function clearInsertionEvents(database: DatabaseSync): void {
  database.exec("DELETE FROM claim_scan_state WHERE scan_kind = 'event'");
}

function notifyAffectedKey(
  database: DatabaseSync,
  kind: "bucket" | "concurrency" | "affinity",
  key: string,
  at = now,
): number {
  return transaction(database, () => {
    const row = database
      .prepare(`UPDATE scheduling_state SET recheck_sequence = recheck_sequence + 1
      WHERE singleton = 1 RETURNING recheck_sequence`)
      .get() as { recheck_sequence: number };
    database
      .prepare(`INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
      capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
      VALUES ('*', '*', '*', '*', ?, ?, 'all', 'event', ?, ?)
      ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
        scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
        dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at`)
      .run(kind, key, row.recheck_sequence, at);
    return row.recheck_sequence;
  });
}

interface ScanOptions {
  readonly worker?: SchedulingClaimWorker;
  readonly at?: string;
  readonly repositories?: readonly number[];
  readonly classes?: readonly SchedulingWorkClass[];
  readonly inspectionBudget?: number;
  readonly primaryBudget?: number;
  readonly eligible?: (candidate: FairClaimCandidate) => boolean;
  readonly serve?: boolean;
}

function serve(database: DatabaseSync, candidate: FairClaimCandidate, at = now): void {
  const action = () => {
    recordSuccessfulSchedulingServiceInTransaction(
      database,
      candidate.bucket_key,
      "claim",
      candidate.work_class,
    );
    // This is a scanner/service simulation, not lease evidence. The real waiting Job is removed
    // through its ordinary terminal state; no run_attempts row or fabricated grant is created.
    database
      .prepare(
        "UPDATE jobs SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(at, at, candidate.id);
  };
  if (database.isTransaction) action();
  else transaction(database, action);
}

function scan(database: DatabaseSync, options: ScanOptions = {}) {
  const seen: FairClaimCandidate[] = [];
  const at = options.at ?? now;
  return transaction(database, () => {
    const result = inspectFairClaimCandidates(
      database,
      options.worker ?? worker,
      at,
      (candidate) => {
        seen.push(candidate);
        const parsed = parseExecutionTemplate(candidate.execution_json);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return undefined;
        if (
          !satisfiesRequirement(
            { labels: { pool: "ready" } },
            JSON.parse(candidate.required_capabilities_json),
          ) ||
          candidate.next_attempt_at > at ||
          (options.repositories &&
            !options.repositories.includes(parsed.template.repository.githubRepositoryId)) ||
          (options.classes && !options.classes.includes(candidate.work_class)) ||
          (options.eligible && !options.eligible(candidate))
        )
          return undefined;
        return { value: candidate.id, candidate, bucketKey: candidate.bucket_key };
      },
      {
        ...(options.inspectionBudget === undefined
          ? {}
          : { inspectionBudget: options.inspectionBudget }),
        ...(options.primaryBudget === undefined ? {} : { primaryBudget: options.primaryBudget }),
      },
    );
    expect(result.inspectedJobCount).toBeLessThanOrEqual(options.inspectionBudget ?? 128);
    expect(result.inspectedRepositoryCount).toBeLessThanOrEqual(16);
    expect(new Set(seen.map((candidate) => candidate.bucket_key)).size).toBeLessThanOrEqual(16);
    if (options.serve && result.selected) serve(database, result.selected.candidate, at);
    return { ...result, seen };
  });
}

function cursor(
  database: DatabaseSync,
  scope: { kind?: string; key?: string; workClass?: string; scanKind?: string } = {},
  owner = worker,
) {
  return database
    .prepare(`SELECT pass_generation, high_water_sequence, after_episode_sequence,
    after_job_id, completed, dirty_generation FROM claim_scan_state WHERE worker_id = ?
    AND worker_instance_id = ? AND protocol_version = ? AND capabilities_digest = ?
    AND scope_kind = ? AND scope_key = ? AND work_class = ? AND scan_kind = ?`)
    .get(
      owner.id,
      owner.instanceId,
      owner.protocolVersion,
      owner.capabilitiesDigest,
      scope.kind ?? "bucket",
      scope.key ?? "github:101",
      scope.workClass ?? "pull_request",
      scope.scanKind ?? "primary",
    ) as
    | {
        pass_generation: number;
        high_water_sequence: number;
        after_episode_sequence: number;
        after_job_id: string;
        completed: number;
        dirty_generation: number;
      }
    | undefined;
}

describe("bounded persistent claim scanning", () => {
  it("reaches a compatible tail after more than 128 incompatible Jobs across bounded calls", () => {
    const database = open();
    backlog(database, 260);
    addJob(database, "compatible-tail");
    clearInsertionEvents(database);
    const first = scan(database);
    expect(first.selected).toBeUndefined();
    expect(first.inspectedJobCount).toBe(128);
    expect(first.partial).toBe(true);
    const firstAfter = cursor(database)?.after_episode_sequence;
    const second = scan(database);
    expect(second.selected).toBeUndefined();
    expect(second.inspectedJobCount).toBe(128);
    expect(cursor(database)?.after_episode_sequence).toBeGreaterThan(firstAfter ?? 0);
    const third = scan(database);
    expect(third.selected?.value).toBe("compatible-tail");
    expect(third.seen[0]?.id).toBe("blocked-0256");
  });

  it("does not let a completed incompatible repository prefix starve repository 17", () => {
    const database = open();
    for (let index = 0; index < 17; index++)
      addJob(database, `repository-${index + 1}`, {
        repository: 101 + index,
        pool: index === 16 ? "ready" : "unsupported",
      });
    clearInsertionEvents(database);
    const first = scan(database);
    expect(first.selected).toBeUndefined();
    expect(first.inspectedRepositoryCount).toBe(12);
    expect(first.partial).toBe(true);
    expect(scan(database).selected?.value).toBe("repository-17");
  });

  it("finishes the captured primary pass while higher-priority episodes continuously arrive", () => {
    const database = open();
    backlog(database, 200);
    addJob(database, "older-compatible");
    clearInsertionEvents(database);
    const initial = scan(database, { inspectionBudget: 32, primaryBudget: 32 });
    expect(initial.selected).toBeUndefined();
    const captured = cursor(database, {
      kind: "coordinator",
      key: "*",
      workClass: "all",
      scanKind: "coordinator",
    });
    expect(captured?.high_water_sequence).toBe(201);
    let selected: string | undefined;
    let previousAfter = cursor(database)?.after_episode_sequence ?? 0;
    for (let round = 1; round <= 8 && !selected; round++) {
      addJob(database, `arrival-${round}`, {
        priority: 100,
        requestedAt: "2026-09-07T12:00:01.000Z",
      });
      clearInsertionEvents(database);
      const result = scan(database, {
        at: "2026-09-07T12:00:02.000Z",
        inspectionBudget: 32,
        primaryBudget: 32,
        serve: true,
      });
      expect(result.seen.every((candidate) => candidate.episode_sequence <= 201)).toBe(true);
      expect(cursor(database)?.after_episode_sequence).toBeGreaterThanOrEqual(previousAfter);
      previousAfter = cursor(database)?.after_episode_sequence ?? 0;
      expect(
        cursor(database, {
          kind: "coordinator",
          key: "*",
          workClass: "all",
          scanKind: "coordinator",
        })?.high_water_sequence,
      ).toBe(201);
      selected = result.selected?.value;
    }
    expect(selected).toBe("older-compatible");
    let arrival: string | undefined;
    for (let round = 0; round < 4 && !arrival; round++)
      arrival = scan(database, { at: "2026-09-07T12:00:02.000Z" }).selected?.value;
    expect(arrival).toBe("arrival-1");
  });

  it("starts another finite pass without a new episode when prerequisites become usable", () => {
    const database = open();
    addJob(database, "restored-prerequisite");
    clearInsertionEvents(database);
    expect(scan(database, { eligible: () => false }).selected).toBeUndefined();
    expect(scan(database, { eligible: () => false }).selected).toBeUndefined();
    const before = cursor(database, {
      kind: "coordinator",
      key: "*",
      workClass: "all",
      scanKind: "coordinator",
    });
    expect(before).toMatchObject({ completed: 1, high_water_sequence: 1 });
    expect(scan(database).selected?.value).toBe("restored-prerequisite");
    expect(
      cursor(database, {
        kind: "coordinator",
        key: "*",
        workClass: "all",
        scanKind: "coordinator",
      }),
    ).toMatchObject({
      pass_generation: (before?.pass_generation ?? 0) + 1,
      high_water_sequence: 1,
    });
  });

  it("resumes the same persisted primary cursor after reopening its isolated database", () => {
    const directory = mkdtempSync(join(tmpdir(), "claim-scan-restart-"));
    directories.push(directory);
    const path = join(directory, "fixture.sqlite");
    const firstDatabase = open(path);
    backlog(firstDatabase, 140);
    addJob(firstDatabase, "after-restart");
    clearInsertionEvents(firstDatabase);
    expect(scan(firstDatabase).selected).toBeUndefined();
    const persisted = cursor(firstDatabase);
    firstDatabase.close();
    databases.splice(databases.indexOf(firstDatabase), 1);
    const reopened = open(path);
    expect(cursor(reopened)).toEqual(persisted);
    const result = scan(reopened);
    expect(result.seen[0]?.id).toBe("blocked-0128");
    expect(result.selected?.value).toBe("after-restart");
  });

  it.each([
    ["worker", { id: "another-worker" }],
    ["instance", { instanceId: "another-instance" }],
    ["protocol", { protocolVersion: "2.0" }],
    ["capabilities", { capabilitiesDigest: "b".repeat(64) }],
  ])("isolates compatibility progress by %s identity", (_name, changed) => {
    const database = open();
    for (let index = 0; index < 20; index++)
      addJob(database, `identity-${index.toString().padStart(2, "0")}`);
    clearInsertionEvents(database);
    scan(database, { inspectionBudget: 8, primaryBudget: 8, eligible: () => false });
    const original = cursor(database);
    const nextWorker = { ...worker, ...changed } as SchedulingClaimWorker;
    expect(scan(database, { worker: nextWorker }).selected?.value).toBe("identity-00");
    expect(cursor(database)).toEqual(original);
    const resumed = scan(database, {
      inspectionBudget: 1,
      primaryBudget: 1,
      eligible: () => false,
      at: "2026-09-07T12:00:05.000Z",
    });
    expect(resumed.seen[0]?.id).toBe("identity-08");
  });

  it("retains B's old service ticket under interleaved ABC and AC-only Workers", () => {
    const database = open();
    for (const [name, repository] of [
      ["A", 101],
      ["B", 102],
      ["C", 103],
    ] as const)
      for (let index = 1; index <= 5; index++) addJob(database, `${name}-${index}`, { repository });
    clearInsertionEvents(database);
    const ac = { ...worker, id: "ac-worker", capabilitiesDigest: "c".repeat(64) };
    const trace: string[] = [];
    for (const owner of [worker, ac, worker, ac, worker, ac, worker]) {
      const result = scan(database, {
        worker: owner,
        repositories: owner === ac ? [101, 103] : [101, 102, 103],
        serve: true,
      });
      trace.push(result.selected?.value ?? "none");
    }
    expect(trace).toEqual(["A-1", "C-1", "B-1", "A-2", "C-2", "A-3", "B-2"]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
  });

  it("serves an independently expected PR, PR, Issue trace while scans alone leave service history unchanged", () => {
    const database = open();
    for (let index = 1; index <= 4; index++) addJob(database, `pr-${index}`);
    for (let index = 1; index <= 2; index++)
      addJob(database, `issue-${index}`, { workClass: "issue" });
    clearInsertionEvents(database);
    const before = readRepositorySchedulingService(database, "github:101");
    expect(scan(database).selected?.value).toBe("pr-1");
    expect(readRepositorySchedulingService(database, "github:101")).toEqual(before);
    const trace = Array.from({ length: 6 }, () => scan(database, { serve: true }).selected?.value);
    expect(trace).toEqual(["pr-1", "pr-2", "issue-1", "pr-3", "pr-4", "issue-2"]);
    expect(readRepositorySchedulingService(database, "github:101")).toMatchObject({
      claimPrStreak: 0,
      lastClaimTicket: 6,
      lastAdmissionTicket: 0,
    });
  });

  it("preserves Issue debt through PR-only service and pays it on a compatible opportunity", () => {
    const database = open();
    for (let index = 1; index <= 4; index++) addJob(database, `pr-${index}`);
    addJob(database, "waiting-issue", { workClass: "issue" });
    clearInsertionEvents(database);
    const prOnly = { ...worker, capabilitiesDigest: "d".repeat(64) };
    for (let index = 1; index <= 3; index++)
      expect(
        scan(database, { worker: prOnly, classes: ["pull_request"], serve: true }).selected?.value,
      ).toBe(`pr-${index}`);
    expect(readRepositorySchedulingService(database, "github:101").claimPrStreak).toBe(2);
    expect(scan(database, { serve: true }).selected?.value).toBe("waiting-issue");
    expect(readRepositorySchedulingService(database, "github:101").claimPrStreak).toBe(0);
  });

  it("keeps Issue debt while its incompatible prefix needs several bounded inspections", () => {
    const database = open();
    for (let index = 1; index <= 20; index++)
      addJob(database, `pr-${index.toString().padStart(2, "0")}`);
    backlog(database, 40, { workClass: "issue" }, "unsupported-issue");
    addJob(database, "compatible-issue", { workClass: "issue" });
    clearInsertionEvents(database);
    const trace: string[] = [];
    for (let round = 0; round < 12; round++) {
      const result = scan(database, { inspectionBudget: 8, primaryBudget: 8, serve: true });
      trace.push(result.selected?.value ?? "none");
      if (result.selected?.value === "compatible-issue") break;
      if (round >= 1)
        expect(readRepositorySchedulingService(database, "github:101").claimPrStreak).toBe(2);
    }
    expect(trace.slice(0, 2)).toEqual(["pr-01", "pr-02"]);
    expect(trace.at(-1)).toBe("compatible-issue");
    expect(readRepositorySchedulingService(database, "github:101").claimPrStreak).toBe(0);
  });

  it("lets a low-priority Job older than the finite boost outrank a new high-priority Job", () => {
    const database = open();
    addJob(database, "old-low", { priority: 0 });
    addJob(database, "new-high", { priority: 100, requestedAt: "2026-09-07T12:10:00.001Z" });
    clearInsertionEvents(database);
    const before = database
      .prepare("SELECT id, execution_json, execution_digest, priority FROM jobs ORDER BY id")
      .all();
    expect(scan(database, { at: "2026-09-07T12:10:01.000Z" }).selected?.value).toBe("old-low");
    expect(
      database
        .prepare("SELECT id, execution_json, execution_digest, priority FROM jobs ORDER BY id")
        .all(),
    ).toEqual(before);
  });

  it("leaves a non-winning compatible candidate before its persisted cursor", () => {
    const database = open();
    addJob(database, "A", { repository: 101 });
    addJob(database, "B", { repository: 102 });
    clearInsertionEvents(database);
    const first = scan(database);
    expect(first.selected?.value).toBe("A");
    expect(first.seen.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(["A", "B"]));
    expect(cursor(database, { key: "github:102" })).toMatchObject({
      after_episode_sequence: 0,
      after_job_id: "",
      completed: 0,
    });
    expect(first.selected).toBeDefined();
    if (!first.selected) throw new Error("The first compatible candidate was not selected.");
    serve(database, first.selected.candidate);
    expect(scan(database).selected?.value).toBe("B");
  });

  it("rechecks a shared concurrency key across repositories without restarting the long primary pass", () => {
    const database = open();
    backlog(database, 100);
    addJob(database, "B-waiter", { repository: 102, concurrencyKey: "shared-key" });
    addJob(database, "C-waiter", { repository: 103, concurrencyKey: "shared-key" });
    clearInsertionEvents(database);
    const blocked = new Set(["B-waiter", "C-waiter"]);
    expect(
      scan(database, {
        inspectionBudget: 12,
        primaryBudget: 12,
        eligible: (candidate) => !blocked.has(candidate.id),
      }).selected,
    ).toBeUndefined();
    const primary = cursor(database);
    expect(cursor(database, { key: "github:102" })?.completed).toBe(1);
    blocked.clear();
    notifyAffectedKey(database, "concurrency", "shared-key");
    expect(
      scan(database, { inspectionBudget: 12, primaryBudget: 8, serve: true }).selected?.value,
    ).toBe("B-waiter");
    expect(cursor(database)?.pass_generation).toBe(primary?.pass_generation);
    expect(cursor(database)?.after_episode_sequence).toBeGreaterThan(
      primary?.after_episode_sequence ?? 0,
    );
    expect(
      scan(database, { inspectionBudget: 12, primaryBudget: 8, serve: true }).selected?.value,
    ).toBe("C-waiter");
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM claim_scan_state WHERE scan_kind = 'event' AND scope_kind = 'concurrency' AND scope_key = 'shared-key'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rechecks the exact restored affinity key while unrelated primary work remains", () => {
    const database = open();
    backlog(database, 100);
    addJob(database, "affinity-waiter", { repository: 102, affinityNodeId: "restored-node" });
    clearInsertionEvents(database);
    const readyNodes = new Set<string>();
    const eligible = (candidate: FairClaimCandidate) =>
      candidate.execution_affinity_node_id === null ||
      readyNodes.has(candidate.execution_affinity_node_id);
    expect(
      scan(database, { inspectionBudget: 12, primaryBudget: 12, eligible }).selected,
    ).toBeUndefined();
    expect(cursor(database, { key: "github:102" })?.completed).toBe(1);
    readyNodes.add("restored-node");
    notifyAffectedKey(database, "affinity", "restored-node");
    const result = scan(database, { inspectionBudget: 12, primaryBudget: 8, eligible });
    expect(result.selected?.value).toBe("affinity-waiter");
    expect(
      cursor(database, { kind: "affinity", key: "restored-node", scanKind: "recheck" }),
    ).toBeDefined();
  });

  it("finds a newly due Issue through its class recheck despite a compatible PR prefix", () => {
    const database = open();
    backlog(database, 256, { repository: 102 });
    for (let index = 1; index <= 3; index++) addJob(database, `pr-${index}`);
    addJob(database, "due-issue", {
      workClass: "issue",
      nextAttemptAt: "2026-09-07T12:00:01.000Z",
    });
    clearInsertionEvents(database);
    for (let index = 1; index <= 2; index++)
      expect(
        scan(database, { inspectionBudget: 16, primaryBudget: 12, serve: true }).selected?.value,
      ).toBe(`pr-${index}`);
    expect(readRepositorySchedulingService(database, "github:101").claimPrStreak).toBe(2);
    expect(cursor(database, { workClass: "issue" })?.completed).toBe(1);
    const result = scan(database, {
      at: "2026-09-07T12:00:01.000Z",
      inspectionBudget: 16,
      primaryBudget: 12,
      serve: true,
    });
    expect(result.selected?.value).toBe("due-issue");
    expect(
      cursor(database, { kind: "backoff", key: "due", workClass: "issue", scanKind: "recheck" }),
    ).toBeDefined();
  });

  it("finds a newly admitted Issue outside the primary high-water without erasing PR debt", () => {
    const database = open();
    backlog(database, 256, { repository: 102 });
    for (let index = 1; index <= 3; index++) addJob(database, `pr-${index}`);
    clearInsertionEvents(database);
    for (let index = 1; index <= 2; index++)
      expect(
        scan(database, { inspectionBudget: 16, primaryBudget: 12, serve: true }).selected?.value,
      ).toBe(`pr-${index}`);
    const primary = cursor(database, {
      kind: "coordinator",
      key: "*",
      workClass: "all",
      scanKind: "coordinator",
    });
    addJob(database, "new-issue", { workClass: "issue" });
    const result = scan(database, { inspectionBudget: 16, primaryBudget: 12, serve: true });
    expect(result.selected?.value).toBe("new-issue");
    expect(result.selected?.candidate.episode_sequence).toBeGreaterThan(
      primary?.high_water_sequence ?? 0,
    );
    expect(
      cursor(database, { kind: "coordinator", key: "*", workClass: "all", scanKind: "coordinator" })
        ?.high_water_sequence,
    ).toBe(primary?.high_water_sequence);
  });

  it("retains an in-progress affected-key pass during repeated and unrelated invalidations", () => {
    const database = open();
    backlog(database, 129, { concurrencyKey: "storm" });
    addJob(database, "storm-tail", { concurrencyKey: "storm" });
    clearInsertionEvents(database);
    const capturedDirty = notifyAffectedKey(database, "concurrency", "storm");
    expect(scan(database, { inspectionBudget: 16, primaryBudget: 0 }).selected).toBeUndefined();
    const key = { kind: "concurrency", key: "storm", scanKind: "recheck" };
    const captured = cursor(database, { ...key, workClass: "all" });
    expect(captured).toMatchObject({
      pass_generation: 1,
      high_water_sequence: 130,
      dirty_generation: capturedDirty,
    });
    let previousAfter = cursor(database, key)?.after_episode_sequence ?? 0;
    let selected: string | undefined;
    for (let round = 1; round <= 12 && !selected; round++) {
      notifyAffectedKey(database, "concurrency", `noise-${round}`);
      notifyAffectedKey(database, "concurrency", "storm");
      const result = scan(database, { inspectionBudget: 16, primaryBudget: 0 });
      const current = cursor(database, key);
      expect(current?.after_episode_sequence).toBeGreaterThan(previousAfter);
      previousAfter = current?.after_episode_sequence ?? 0;
      expect(cursor(database, { ...key, workClass: "all" })).toMatchObject({
        pass_generation: captured?.pass_generation,
        high_water_sequence: 130,
        dirty_generation: capturedDirty,
      });
      selected = result.selected?.value;
    }
    expect(selected).toBe("storm-tail");
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM claim_scan_state WHERE scan_kind = 'event' AND scope_kind = 'concurrency' AND scope_key = 'storm'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("bounds a broad cross-repository recheck and still resumes later repositories", () => {
    const database = open();
    for (let index = 0; index < 24; index++)
      addJob(database, `broad-${index}`, {
        repository: 101 + index,
        pool: "unsupported",
        concurrencyKey: "broad",
      });
    clearInsertionEvents(database);
    notifyAffectedKey(database, "concurrency", "broad");
    const first = scan(database);
    expect(first.inspectedRepositoryCount).toBe(16);
    expect(first.partial).toBe(true);
    const second = scan(database);
    const repositories = new Set(
      [...first.seen, ...second.seen].map((candidate) => candidate.bucket_key),
    );
    expect(repositories.size).toBe(24);
    expect(
      cursor(database, { kind: "concurrency", key: "broad", scanKind: "recheck" })
        ?.after_episode_sequence,
    ).toBe(24);
  });

  it("preserves candidates when the surrounding claim operation has no inspection budget left", () => {
    const database = open();
    addJob(database, "reserved-for-next-call");
    clearInsertionEvents(database);
    const exhausted = scan(database, { inspectionBudget: 0, primaryBudget: 0 });
    expect(exhausted.selected).toBeUndefined();
    expect(exhausted.seen).toEqual([]);
    expect(exhausted.inspectedJobCount).toBe(0);
    expect(exhausted.partial).toBe(true);
    expect(scan(database).selected?.value).toBe("reserved-for-next-call");
  });
});
