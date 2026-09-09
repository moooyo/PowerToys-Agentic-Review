import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  JobExecutionEnvelope,
  JobExecutionTemplate,
  SchedulingLimits,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { createJobAdmissionInTransaction } from "../../dist/database/job-admission.js";
import { runMigrations } from "../../dist/database/migrations.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";
import { canonicalJson, sha256 } from "../../dist/scheduling/canonical-json.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const actor = { issuer: "https://identity.example.test", subject: "scheduling-limits-integration" };
const fixtures: Fixture[] = [];
interface SeedJob {
  readonly id: string;
  readonly repository: number;
}
interface Fixture {
  readonly client: DatabaseClient;
  readonly databasePath: string;
  readonly directory: string;
  readonly repositoryIds: Map<number, string>;
}
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The scheduling fixture is incomplete.");
  return value;
}
function template(repository: number, number: number): JobExecutionTemplate {
  const prompt = "Review this synthetic scheduling fixture.";
  return {
    repository: { githubRepositoryId: repository, fullName: `example/project-${repository}` },
    resource: {
      kind: "pull_request",
      githubNodeId: `PR_${repository}_${number}`,
      number,
      title: "Scheduling limit integration",
      author: { githubUserId: 7, login: "fixture-author" },
      canonicalSnapshot: {},
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isDraft: false,
    },
    prompt: {
      name: "review",
      version: "fixture",
      renderedPrompt: prompt,
      promptSha256: sha256(prompt),
      outputSchema: {},
      outputSchemaSha256: sha256("{}"),
    },
    executionPolicy: {
      hardTimeoutMs: 600_000,
      noProgressTimeoutMs: 120_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}
async function createFixture(jobs: readonly SeedJob[]): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "scheduling-limits-integration-"));
  const databasePath = join(directory, "server.sqlite");
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    runMigrations(database, migrationsDirectory);
    database.exec("BEGIN IMMEDIATE");
    const now = new Date(Date.now() - 60_000).toISOString();
    jobs.forEach((job, index) => {
      const execution = canonicalJson(template(job.repository, index + 1));
      // Synthetic unassociated Legacy rows model durable accepted work before this owner starts.
      database
        .prepare(`INSERT INTO jobs (id, job_kind, semantic_key, concurrency_key, status,
        priority, execution_json, execution_digest, required_capabilities_json, resource_revision,
        max_attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, 'pull_request_review', ?, ?, 'queued', 10, ?, ?, '[]', ?, 3, ?, ?, ?)`)
        .run(job.id, job.id, job.id, execution, sha256(execution), "b".repeat(40), now, now, now);
      createJobAdmissionInTransaction(database, job.id, now);
    });
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);
  await writeFile(
    databaseInitializationMarkerPath(databasePath),
    databaseInitializationMarkerContent,
    { mode: 0o600 },
  );
  const client = await DatabaseClient.create({
    databasePath,
    migrationsDirectory,
    operatorAccess: { administrators: [actor] },
  });
  const fixture = { client, databasePath, directory, repositoryIds: new Map<number, string>() };
  fixtures.push(fixture);
  await client.request("bootstrapManagedRepositories", {
    repositories: [1, 2].map((number) => ({
      githubRepositoryId: number,
      fullName: `example/project-${number}`,
    })),
    reviewer: { githubUserId: 100, login: "reviewer" },
    authorizationPolicy: {
      kind: "self_or_allowlist",
      policyVersion: 1,
      schedulingTargetGithubUserId: 100,
      allowlistedActorGithubUserIds: [],
      unknownActorPolicy: "deny",
      newRevisionPolicy: "require_new_authorization",
    },
  });
  for (const number of [1, 2])
    fixture.repositoryIds.set(
      number,
      present(
        await client.request("getManagedRepositoryByGitHubId", { githubRepositoryId: number }),
      ).id,
    );
  return fixture;
}
function inspect<T>(fixture: Fixture, action: (database: DatabaseSync) => T, write = false): T {
  const database = new DatabaseSync(fixture.databasePath, {
    readOnly: !write,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  try {
    return action(database);
  } finally {
    database.close();
  }
}
function jobState(fixture: Fixture, jobId: string) {
  return inspect(fixture, (database) =>
    present(
      database
        .prepare(`SELECT job.status, job.attempt_count,
    job.current_run_attempt_id, job.execution_json, admission.state AS admission_state,
    admission.attempt_base, admission.episode_sequence FROM jobs AS job
    JOIN job_admission AS admission ON admission.job_id = job.id WHERE job.id = ?`)
        .get(jobId),
    ),
  ) as {
    status: string;
    attempt_count: number;
    current_run_attempt_id: string | null;
    execution_json: string;
    admission_state: string;
    attempt_base: number;
    episode_sequence: number;
  };
}
async function platformLimits(fixture: Fixture, limits: SchedulingLimits) {
  const current = await fixture.client.request("getPlatformSchedulingStatus", {});
  return fixture.client.request("updatePlatformSchedulingConfiguration", {
    actor,
    request: { expectedVersion: current.configuration.version, limits },
  });
}
async function repositoryLimits(fixture: Fixture, number: number, limits: SchedulingLimits) {
  const repositoryId = present(fixture.repositoryIds.get(number));
  const current = present(await fixture.client.request("getManagedRepository", { repositoryId }));
  return fixture.client.request("updateManagedRepository", {
    repositoryId,
    actor,
    request: { expectedVersion: current.version, schedulingLimits: limits },
  });
}
async function repositoryStatus(fixture: Fixture, number: number) {
  return present(
    await fixture.client.request("getRepositorySchedulingStatus", {
      repositoryId: present(fixture.repositoryIds.get(number)),
    }),
  );
}
async function worker(fixture: Fixture, name: string, instance = "initial") {
  const workerNodeId = `worker-${name}`;
  const workerInstanceId = `instance-${name}-${instance}`;
  const workerTokenSha256 = sha256(`worker-token-${name}`);
  const auth = await fixture.client.request("authenticateWorkerToken", { workerTokenSha256 });
  if (auth.outcome === "invalid")
    await fixture.client.request("createWorkerNodeCredential", {
      workerNodeId,
      workerTokenSha256,
      displayName: workerNodeId,
      createdByIssuer: actor.issuer,
      createdBySubject: actor.subject,
    });
  const registered = await fixture.client.request("registerWorker", {
    workerNodeId,
    workerInstanceId,
    workerTokenSha256,
    protocolVersion: "1.0",
    displayName: workerInstanceId,
    workerVersion: "test",
    maxSlots: 1,
    capabilities: {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      codexVersion: "test",
      recipeIds: [],
      labels: {},
    },
  });
  return {
    workerNodeId,
    workerInstanceId,
    claim: () =>
      fixture.client.request("claimLease", {
        workerNodeId,
        workerInstanceId,
        availableSlots: 1,
        capabilitiesDigest: registered.capabilitiesDigest,
        protocolVersion: "1.0",
        leaseTtlSeconds: 300,
      }),
  };
}
async function granted(
  registered: Awaited<ReturnType<typeof worker>>,
): Promise<JobExecutionEnvelope> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const claim = await registered.claim();
    if (claim.outcome === "granted") return claim.envelope;
    expect(claim.outcome).toBe("no_work");
  }
  throw new Error("The finite synthetic backlog did not yield an expected lease.");
}
const failure = (lease: JobExecutionEnvelope, retryable = false) => ({
  ...lease.lease,
  failureCode: "SYNTHETIC_FAILURE",
  failureMessage: "The synthetic scheduling test ended this attempt.",
  retryable,
  retryDelaySeconds: 0,
});
function expireLease(fixture: Fixture, lease: JobExecutionEnvelope) {
  // Advance only the recorded synthetic deadline; production reap owns every lifecycle transition.
  inspect(
    fixture,
    (database) =>
      expect(
        database
          .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
          .run(new Date(Date.now() - 60_000).toISOString(), lease.lease.runAttemptId).changes,
      ).toBe(1),
    true,
  );
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("execution scheduling limits through the database owner", () => {
  it("serializes two racing Workers against one global active slot", async () => {
    const fixture = await createFixture([
      { id: "a", repository: 1 },
      { id: "b", repository: 2 },
    ]);
    const first = await worker(fixture, "first");
    const second = await worker(fixture, "second");
    await platformLimits(fixture, { maxActiveLeases: 1, maxQueuedJobs: null });
    const results = await Promise.all([first.claim(), second.claim()]);
    expect(results.filter((result) => result.outcome === "granted")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "no_work")).toHaveLength(1);
    const winner = results.find((result) => result.outcome === "granted");
    if (winner?.outcome !== "granted") throw new Error("Expected exactly one race winner.");
    expect(
      (await fixture.client.request("getPlatformSchedulingStatus", {})).usage.activeLeases,
    ).toBe(1);
    expect(
      inspect(fixture, (database) =>
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM run_attempts WHERE status IN ('leased', 'running')",
          )
          .get(),
      ),
    ).toEqual({ count: 1 });
    await fixture.client.request("failLease", failure(winner.envelope));
    const next = await granted(
      winner.envelope.lease.workerNodeId === first.workerNodeId ? second : first,
    );
    expect(next.job.jobId).not.toBe(winner.envelope.job.jobId);
    expect(
      (await fixture.client.request("getPlatformSchedulingStatus", {})).usage.activeLeases,
    ).toBe(1);
  });

  it("keeps repository B runnable while repository A occupies its only active slot", async () => {
    const fixture = await createFixture([
      { id: "a-first", repository: 1 },
      { id: "a-second", repository: 1 },
      { id: "b-only", repository: 2 },
    ]);
    await repositoryLimits(fixture, 1, { maxActiveLeases: 1, maxQueuedJobs: null });
    const first = await worker(fixture, "first");
    const second = await worker(fixture, "second");
    const third = await worker(fixture, "third");
    const held = await granted(first);
    expect(held.repository.githubRepositoryId).toBe(1);
    const progressed = await granted(second);
    expect(progressed.repository.githubRepositoryId).toBe(2);
    expect((await third.claim()).outcome).toBe("no_work");
    expect((await repositoryStatus(fixture, 1)).usage.activeLeases).toBe(1);
    expect((await repositoryStatus(fixture, 2)).usage.activeLeases).toBe(1);
    await fixture.client.request("failLease", failure(held));
    const resumed = await granted(third);
    expect(resumed.repository.githubRepositoryId).toBe(1);
    expect(resumed.job.jobId).not.toBe(held.job.jobId);
  });

  it("keeps overage visible after lowering limits and never preempts the existing attempts", async () => {
    const fixture = await createFixture([
      { id: "a-first", repository: 1 },
      { id: "a-second", repository: 1 },
      { id: "a-third", repository: 1 },
    ]);
    const first = await worker(fixture, "first");
    const second = await worker(fixture, "second");
    const third = await worker(fixture, "third");
    const held = [await granted(first), await granted(second)];
    await platformLimits(fixture, { maxActiveLeases: 1, maxQueuedJobs: 1 });
    await repositoryLimits(fixture, 1, { maxActiveLeases: 1, maxQueuedJobs: 1 });
    expect(await repositoryStatus(fixture, 1)).toMatchObject({
      usage: { activeLeases: 2 },
      overage: { activeLeases: 1 },
    });
    expect(await fixture.client.request("getPlatformSchedulingStatus", {})).toMatchObject({
      usage: { activeLeases: 2 },
      overage: { activeLeases: 1 },
    });
    for (const envelope of held)
      expect(jobState(fixture, envelope.job.jobId)).toMatchObject({
        status: "leased",
        current_run_attempt_id: envelope.lease.runAttemptId,
        attempt_count: 1,
      });
    expect((await third.claim()).outcome).toBe("no_work");
    await fixture.client.request("failLease", failure(present(held[0])));
    expect((await third.claim()).outcome).toBe("no_work");
    expect((await repositoryStatus(fixture, 1)).overage.activeLeases).toBe(0);
    await fixture.client.request("failLease", failure(present(held[1])));
    expect((await granted(third)).job.jobId).toBe("a-third");
  });

  it.each(["offline", "superseded", "expired-unreaped"] as const)(
    "counts an %s active attempt until a production terminal transition",
    async (state) => {
      const fixture = await createFixture([
        { id: "held", repository: 1 },
        { id: "waiting", repository: 2 },
      ]);
      await platformLimits(fixture, { maxActiveLeases: 1, maxQueuedJobs: null });
      const owner = await worker(fixture, "owner");
      const contender = await worker(fixture, "contender");
      const held = await granted(owner);
      if (state === "offline") {
        inspect(
          fixture,
          (database) =>
            expect(
              database
                .prepare(
                  "UPDATE workers SET last_seen_at = ? WHERE node_id = ? AND instance_id = ?",
                )
                .run(
                  new Date(Date.now() - 120_000).toISOString(),
                  owner.workerNodeId,
                  owner.workerInstanceId,
                ).changes,
            ).toBe(1),
          true,
        );
        expect(
          await fixture.client.request("reapExpiredLeases", {
            retryDelaySeconds: 3600,
            workerOfflineAfterSeconds: 60,
          }),
        ).toEqual({ expiredCount: 0 });
        expect(
          inspect(fixture, (database) =>
            database
              .prepare("SELECT status FROM workers WHERE node_id = ? AND instance_id = ?")
              .get(owner.workerNodeId, owner.workerInstanceId),
          ),
        ).toEqual({ status: "offline" });
      } else if (state === "superseded") {
        await worker(fixture, "owner", "replacement");
        await expect(fixture.client.request("failLease", failure(held))).rejects.toMatchObject({
          code: "LEASE_LOST",
        });
      } else expireLease(fixture, held);
      expect(
        (await fixture.client.request("getPlatformSchedulingStatus", {})).usage.activeLeases,
      ).toBe(1);
      expect((await repositoryStatus(fixture, 1)).usage.activeLeases).toBe(1);
      expect((await contender.claim()).outcome).toBe("no_work");
      if (state === "offline") await fixture.client.request("failLease", failure(held));
      else {
        if (state === "superseded") expireLease(fixture, held);
        expect(
          await fixture.client.request("reapExpiredLeases", {
            retryDelaySeconds: 3600,
            workerOfflineAfterSeconds: 60,
          }),
        ).toEqual({ expiredCount: 1 });
        expect(jobState(fixture, held.job.jobId)).toMatchObject({
          status: "retry_waiting",
          attempt_count: 1,
          attempt_base: 1,
          admission_state: "pending",
        });
      }
      expect(
        (await fixture.client.request("getPlatformSchedulingStatus", {})).usage.activeLeases,
      ).toBe(0);
      expect((await granted(contender)).job.jobId).toBe("waiting");
    },
  );

  it("requires a new retry admission episode and cannot bypass either finite capacity gate", async () => {
    const fixture = await createFixture([
      { id: "retry", repository: 1 },
      { id: "older-waiter", repository: 1 },
    ]);
    await platformLimits(fixture, { maxActiveLeases: 1, maxQueuedJobs: 1 });
    await repositoryLimits(fixture, 1, { maxActiveLeases: 1, maxQueuedJobs: 1 });
    const first = await worker(fixture, "first");
    const second = await worker(fixture, "second");
    const initial = await granted(first);
    expect(initial.job.jobId).toBe("retry");
    const before = jobState(fixture, "retry");
    const failed = await fixture.client.request("failLease", failure(initial, true));
    expect(failed).toMatchObject({ jobState: "retry_waiting", runState: "failed" });
    const retried = jobState(fixture, "retry");
    expect(retried).toMatchObject({
      status: "retry_waiting",
      attempt_count: 1,
      attempt_base: 1,
      admission_state: "pending",
      execution_json: before.execution_json,
    });
    expect(retried.episode_sequence).toBeGreaterThan(before.episode_sequence);
    await fixture.client.request("failLease", failure(initial, true));
    expect(jobState(fixture, "retry")).toEqual(retried);
    const older = await granted(second);
    expect(older.job.jobId).toBe("older-waiter");
    expect((await first.claim()).outcome).toBe("no_work");
    // A free admitted-buffer credit may be used while the active lease limit still blocks grants.
    expect(jobState(fixture, "retry")).toMatchObject({
      attempt_count: 1,
      attempt_base: 1,
      current_run_attempt_id: null,
    });
    const usage = (await fixture.client.request("getPlatformSchedulingStatus", {})).usage;
    expect(usage.activeLeases).toBe(1);
    expect(usage.admittedQueuedJobs).toBeLessThanOrEqual(1);
    await fixture.client.request("failLease", failure(older));
    const resumed = await granted(first);
    expect(resumed.job.jobId).toBe("retry");
    expect(resumed.lease.runAttemptId).not.toBe(initial.lease.runAttemptId);
    expect(jobState(fixture, "retry")).toMatchObject({
      attempt_count: 2,
      attempt_base: 1,
      execution_json: before.execution_json,
    });
  });
});
