import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  JobExecutionTemplate,
  NormalizedSchedulingEvent,
  SelfOrAllowlistPolicy,
  WorkerCapabilities,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { runMigrations } from "../../dist/database/migrations.js";
import type { IngestSchedulingEventInput } from "../../dist/database/protocol.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const protocolVersion = "1.0";
const leaseTtlSeconds = 300;

const workerCapabilities = {
  operatingSystem: "windows",
  architecture: "x64",
  headless: true,
  interactiveDesktop: false,
  codexVersion: "test",
  recipeIds: ["pull-request-review"],
  labels: { pool: "test" },
} satisfies WorkerCapabilities;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
    .join(",")}}`;
};

const executionTemplate = {
  repository: {
    githubRepositoryId: 1,
    fullName: "microsoft/PowerToys",
  },
  resource: {
    kind: "pull_request",
    githubNodeId: "PR_test",
    number: 1,
    title: "Test pull request",
    author: {
      githubUserId: 1,
      login: "test-author",
    },
    canonicalSnapshot: {},
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    isDraft: false,
  },
  prompt: {
    name: "pull-request-review",
    version: "test",
    renderedPrompt: "Review this pull request.",
    promptSha256: sha256("Review this pull request."),
    outputSchema: {},
    outputSchemaSha256: sha256("{}"),
  },
  executionPolicy: {
    hardTimeoutMs: 600_000,
    noProgressTimeoutMs: 600_000,
    maxCodexTurns: 3,
    allowedRecipeIds: ["pull-request-review"],
    requiredCapabilityLabels: {},
  },
} satisfies JobExecutionTemplate;

const reviewer = {
  githubUserId: 99,
  login: "reviewer",
  accountType: "user",
} as const;

const pullRequestAuthor = {
  githubUserId: 7,
  login: "contributor",
  accountType: "user",
} as const;

const repository = {
  githubRepositoryId: 1,
  githubNodeId: "R_test",
  ownerLogin: "microsoft",
  name: "PowerToys",
  fullName: "microsoft/PowerToys",
  htmlUrl: "https://github.com/microsoft/PowerToys",
  defaultBranch: "main",
  isPrivate: false,
} as const;

const pullRequestRevisionKey = (headSha: string): string =>
  sha256(`${"a".repeat(40)}\0${headSha.toLowerCase()}`);

const schedulingPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [42],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
} satisfies SelfOrAllowlistPolicy;

const makePullRequest = (
  state: "open" | "closed",
  updatedAt: string,
): Extract<NormalizedSchedulingEvent["workItem"], { kind: "pull_request" }> => ({
  kind: "pull_request",
  githubWorkItemId: 501,
  githubNodeId: "PR_ingestion_test",
  githubRepositoryId: repository.githubRepositoryId,
  number: 501,
  title: "Test normalized ingestion",
  body: "Review body",
  state,
  author: pullRequestAuthor,
  htmlUrl: "https://github.com/microsoft/PowerToys/pull/501",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt,
  closedAt: state === "closed" ? updatedAt : null,
  isDraft: false,
});

const makePullRequestRevision = (
  headSha: string,
  observedAt: string,
): Extract<NormalizedSchedulingEvent["revision"], { kind: "pull_request" }> => ({
  kind: "pull_request",
  githubRepositoryId: repository.githubRepositoryId,
  githubWorkItemId: 501,
  revisionKey: pullRequestRevisionKey(headSha),
  baseSha: "a".repeat(40),
  headSha,
  observedAt,
  sourceUpdatedAt: observedAt,
});

const makeJobSchedule = (
  event: NormalizedSchedulingEvent,
): IngestSchedulingEventInput["schedule"] => {
  if (event.workItem.kind !== "pull_request" || event.revision.kind !== "pull_request") {
    throw new Error("This test schedule factory only supports pull requests.");
  }
  const renderedPrompt = "Review the normalized pull request.";
  const outputSchema = {};
  return {
    jobKind: "pull_request_review",
    priority: 100,
    intentVersion: 1,
    maxAttempts: 3,
    requiredCapabilities: [],
    executionTemplate: {
      repository: {
        githubRepositoryId: event.repository.githubRepositoryId,
        fullName: event.repository.fullName,
      },
      resource: {
        kind: "pull_request",
        githubNodeId: event.workItem.githubNodeId,
        number: event.workItem.number,
        title: event.workItem.title,
        author: event.workItem.author,
        canonicalSnapshot: event.workItem,
        baseSha: event.revision.baseSha,
        headSha: event.revision.headSha,
        isDraft: event.workItem.isDraft,
      },
      prompt: {
        name: "pull-request-review",
        version: "test",
        renderedPrompt,
        promptSha256: sha256(renderedPrompt),
        outputSchema,
        outputSchemaSha256: sha256(canonicalJson(outputSchema)),
      },
      executionPolicy: {
        hardTimeoutMs: 600_000,
        noProgressTimeoutMs: 600_000,
        maxCodexTurns: 3,
        allowedRecipeIds: ["pull-request-review"],
        requiredCapabilityLabels: {},
      },
    },
  };
};

const delivery = (deliveryId: string, payload = `payload:${deliveryId}`) => ({
  deliveryId,
  eventName: "pull_request",
  payloadSha256: sha256(payload),
  receivedAt: "2026-08-30T00:00:10.000Z",
});

const makeRequestOpenedInput = (
  deliveryId: string,
  headSha = "b".repeat(40),
): IngestSchedulingEventInput => {
  const observedAt = "2026-08-30T00:00:10.000Z";
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("open", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "request_opened",
    requestKind: "assignment",
    actor: reviewer,
    target: reviewer,
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: delivery(deliveryId),
    schedule: makeJobSchedule(event),
  };
};

const makeRevisionObservedInput = (
  deliveryId: string,
  headSha: string,
  observedAt: string,
  withSchedule: boolean,
): IngestSchedulingEventInput => {
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("open", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "revision_observed",
    requestKind: null,
    actor: pullRequestAuthor,
    target: null,
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: { ...delivery(deliveryId), receivedAt: observedAt },
    schedule: withSchedule ? makeJobSchedule(event) : null,
  };
};

const makeRequestClosedInput = (
  deliveryId: string,
  headSha: string,
  observedAt: string,
): IngestSchedulingEventInput => {
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("open", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "request_closed",
    requestKind: "assignment",
    actor: reviewer,
    target: reviewer,
    closeReason: "assignment_removed",
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: { ...delivery(deliveryId), receivedAt: observedAt },
    schedule: null,
  };
};

const makeWorkItemClosedInput = (
  deliveryId: string,
  headSha: string,
  observedAt: string,
): IngestSchedulingEventInput => {
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("closed", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "work_item_closed",
    requestKind: null,
    actor: reviewer,
    target: null,
    closeReason: "work_item_closed",
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: { ...delivery(deliveryId), receivedAt: observedAt },
    schedule: null,
  };
};

const makeWorkItemReopenedInput = (
  deliveryId: string,
  headSha: string,
  observedAt: string,
): IngestSchedulingEventInput => {
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("open", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "work_item_reopened",
    requestKind: null,
    actor: reviewer,
    target: null,
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: { ...delivery(deliveryId), receivedAt: observedAt },
    schedule: null,
  };
};

interface DatabaseFixture {
  readonly client: DatabaseClient;
  readonly directory: string;
  readonly databasePath: string;
}

const fixtures: DatabaseFixture[] = [];

const createFixture = async (seedLeaseJob = true): Promise<DatabaseFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-server-"));
  const databasePath = join(directory, "server.sqlite");

  try {
    const seedDatabase = new DatabaseSync(databasePath);
    try {
      runMigrations(seedDatabase, migrationsDirectory);
      if (seedLeaseJob) {
        const now = new Date().toISOString();
        seedDatabase
          .prepare(`
          INSERT INTO jobs (
            id,
            job_kind,
            semantic_key,
            concurrency_key,
            status,
            priority,
            execution_json,
            required_capabilities_json,
            resource_revision,
            next_attempt_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, '[]', ?, ?, ?, ?)
          `)
          .run(
            "job-1",
            "pull_request_review",
            "microsoft/PowerToys#1:review",
            "microsoft/PowerToys#1",
            100,
            JSON.stringify(executionTemplate),
            executionTemplate.resource.headSha,
            now,
            now,
            now,
          );
      }
    } finally {
      seedDatabase.close();
    }

    const client = await DatabaseClient.create({
      databasePath,
      migrationsDirectory,
    });
    const fixture = { client, directory, databasePath };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};

const withFixtureDatabase = <T>(
  fixture: DatabaseFixture,
  action: (database: DatabaseSync) => T,
): T => {
  const database = new DatabaseSync(fixture.databasePath, { timeout: 5_000 });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return action(database);
  } finally {
    database.close();
  }
};

const setWorkerState = (
  fixture: DatabaseFixture,
  workerNodeId: string,
  workerInstanceId: string,
  status: "online" | "draining" | "offline" | "disabled",
): void => {
  withFixtureDatabase(fixture, (database) => {
    const update = database
      .prepare(`
        UPDATE workers
        SET status = ?, updated_at = ?
        WHERE node_id = ? AND instance_id = ?
      `)
      .run(status, new Date().toISOString(), workerNodeId, workerInstanceId);
    if (Number(update.changes) !== 1) {
      throw new Error("Expected one Worker record to be updated.");
    }
  });
};

const registerWorker = async (
  client: DatabaseClient,
  workerNodeId: string,
  workerInstanceId: string,
) =>
  client.request("registerWorker", {
    protocolVersion,
    workerNodeId,
    workerInstanceId,
    displayName: workerInstanceId,
    workerVersion: "test",
    maxSlots: 1,
    capabilities: workerCapabilities,
  });

const claimLease = async (
  client: DatabaseClient,
  workerNodeId: string,
  workerInstanceId: string,
  capabilitiesDigest: string,
) =>
  client.request("claimLease", {
    workerNodeId,
    workerInstanceId,
    availableSlots: 1,
    capabilitiesDigest,
    protocolVersion,
    leaseTtlSeconds,
  });

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.client.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(fixture.directory, { force: true, recursive: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Database fixture cleanup failed.");
  }
});

describe("DatabaseClient lease integration", () => {
  it("grants a queued job to only one of two concurrent claimers", async () => {
    const { client } = await createFixture();
    const firstWorker = await registerWorker(client, "worker-a", "instance-a");
    const secondWorker = await registerWorker(client, "worker-b", "instance-b");

    const results = await Promise.all([
      claimLease(client, "worker-a", "instance-a", firstWorker.capabilitiesDigest),
      claimLease(client, "worker-b", "instance-b", secondWorker.capabilitiesDigest),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["granted", "no_work"]);
    const granted = results.find((result) => result.outcome === "granted");
    expect(granted?.outcome).toBe("granted");
    if (granted?.outcome === "granted") {
      expect(["worker-a", "worker-b"]).toContain(granted.envelope.lease.workerNodeId);
    }
  });

  it("reaches a compatible claim candidate after a full incompatible page", async () => {
    const fixture = await createFixture(false);
    const firstCreatedAt = Date.now() - 120_000;
    const nextAttemptAt = new Date(firstCreatedAt).toISOString();

    withFixtureDatabase(fixture, (database) => {
      const insert = database.prepare(`
        INSERT INTO jobs (
          id,
          job_kind,
          semantic_key,
          concurrency_key,
          status,
          priority,
          execution_json,
          required_capabilities_json,
          resource_revision,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (?, 'pull_request_review', ?, ?, 'queued', 100, ?, ?, ?, ?, ?, ?)
      `);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index <= 100; index += 1) {
          const jobId = `job-paged-${index.toString().padStart(3, "0")}`;
          const createdAt = new Date(firstCreatedAt + index).toISOString();
          const requiredCapabilities =
            index < 100 ? ["unsupported-recipe"] : ["pull-request-review"];
          insert.run(
            jobId,
            `paged-semantic-${index}`,
            `paged-concurrency-${index}`,
            JSON.stringify(executionTemplate),
            JSON.stringify(requiredCapabilities),
            executionTemplate.resource.headSha,
            nextAttemptAt,
            createdAt,
            createdAt,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });

    const worker = await registerWorker(fixture.client, "worker-paged", "instance-paged");
    const claim = await claimLease(
      fixture.client,
      "worker-paged",
      "instance-paged",
      worker.capabilitiesDigest,
    );

    expect(claim.outcome).toBe("granted");
    if (claim.outcome === "granted") {
      expect(claim.envelope.job.jobId).toBe("job-paged-100");
    }
  });

  it("allows an authoritative offline Worker instance to complete its live lease", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(fixture.client, "worker-offline", "instance-complete");
    const claim = await claimLease(
      fixture.client,
      "worker-offline",
      "instance-complete",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    setWorkerState(fixture, "worker-offline", "instance-complete", "offline");
    const result = { findings: [], summary: "completed after the Worker became offline" };
    const terminal = await fixture.client.request("completeLease", {
      ...claim.envelope.lease,
      resultDigest: sha256(canonicalJson(result)),
      result,
    });

    expect(terminal).toMatchObject({ jobState: "succeeded", runState: "succeeded" });
  });

  it("allows an authoritative offline Worker instance to fail its live lease", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(fixture.client, "worker-offline", "instance-fail");
    const claim = await claimLease(
      fixture.client,
      "worker-offline",
      "instance-fail",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    setWorkerState(fixture, "worker-offline", "instance-fail", "offline");
    const terminal = await fixture.client.request("failLease", {
      ...claim.envelope.lease,
      failureCode: "test_failure",
      failureMessage: "A focused reliability test requested failure.",
      retryable: false,
      retryDelaySeconds: 1,
    });

    expect(terminal).toMatchObject({ jobState: "failed", runState: "failed" });
  });

  it.each(["draining", "disabled"] as const)(
    "renews and completes the current lease while the Worker is %s",
    async (workerState) => {
      const fixture = await createFixture();
      const worker = await registerWorker(
        fixture.client,
        `worker-${workerState}`,
        `instance-${workerState}`,
      );
      const claim = await claimLease(
        fixture.client,
        `worker-${workerState}`,
        `instance-${workerState}`,
        worker.capabilitiesDigest,
      );
      expect(claim.outcome).toBe("granted");
      if (claim.outcome !== "granted") {
        throw new Error("Expected the Worker instance to receive the lease.");
      }

      setWorkerState(fixture, `worker-${workerState}`, `instance-${workerState}`, workerState);
      const additionalClaim = await claimLease(
        fixture.client,
        `worker-${workerState}`,
        `instance-${workerState}`,
        worker.capabilitiesDigest,
      );
      expect(additionalClaim).toMatchObject({
        outcome: "worker_unavailable",
        reason: workerState,
      });

      const heartbeat = await fixture.client.request("heartbeatLease", {
        ...claim.envelope.lease,
        phase: "codex_review",
        progressSequence: 1,
        progress: { completedTurns: 1 },
        leaseTtlSeconds,
      });
      expect(heartbeat.command).toBe("drain");

      const result = { findings: [], summary: `completed while ${workerState}` };
      const terminal = await fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      });
      expect(terminal).toMatchObject({ jobState: "succeeded", runState: "succeeded" });
    },
  );

  it("keeps Server-controlled Worker states and recovers only offline instances", async () => {
    const fixture = await createFixture(false);
    await registerWorker(fixture.client, "worker-state", "instance-state");
    const heartbeat = (heartbeatSequence: number, state: string) =>
      fixture.client.request("heartbeatWorker", {
        workerNodeId: "worker-state",
        workerInstanceId: "instance-state",
        heartbeatSequence,
        availableSlots: 1,
        health: { state },
      });

    await expect(heartbeat(1, "draining")).resolves.toEqual({ state: "online" });

    setWorkerState(fixture, "worker-state", "instance-state", "draining");
    await expect(heartbeat(2, "online")).resolves.toEqual({ state: "draining" });

    setWorkerState(fixture, "worker-state", "instance-state", "disabled");
    await expect(heartbeat(3, "online")).resolves.toEqual({ state: "disabled" });

    setWorkerState(fixture, "worker-state", "instance-state", "offline");
    await expect(heartbeat(4, "draining")).resolves.toEqual({ state: "online" });
  });

  it("rejects terminal completion from an instance superseded by registration", async () => {
    const { client } = await createFixture();
    const oldWorker = await registerWorker(client, "worker-node", "instance-old");
    const claim = await claimLease(
      client,
      "worker-node",
      "instance-old",
      oldWorker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the old Worker instance to receive the lease.");
    }

    await registerWorker(client, "worker-node", "instance-new");
    const result = { summary: "completed by the stale instance" };

    await expect(
      client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });

  it("rejects a superseded instance registration without fencing the current instance", async () => {
    const { client } = await createFixture(false);
    await registerWorker(client, "worker-node", "instance-old");
    await registerWorker(client, "worker-node", "instance-current");

    await expect(registerWorker(client, "worker-node", "instance-old")).rejects.toMatchObject({
      code: "WORKER_INSTANCE_SUPERSEDED",
    });
    await expect(
      client.request("heartbeatWorker", {
        workerNodeId: "worker-node",
        workerInstanceId: "instance-current",
        heartbeatSequence: 1,
        availableSlots: 1,
        health: { state: "online" },
      }),
    ).resolves.toEqual({ state: "online" });
  });

  it("rejects completion when the result digest does not match", async () => {
    const { client } = await createFixture();
    const worker = await registerWorker(client, "worker-node", "instance-current");
    const claim = await claimLease(
      client,
      "worker-node",
      "instance-current",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    const result = { findings: [], summary: "complete" };
    const validDigest = sha256(canonicalJson(result));
    const invalidDigest = `${validDigest.startsWith("0") ? "1" : "0"}${validDigest.slice(1)}`;

    await expect(
      client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: invalidDigest,
        result,
      }),
    ).rejects.toMatchObject({ code: "RESULT_DIGEST_MISMATCH" });
  });
});

describe("DatabaseClient scheduling ingestion integration", () => {
  it("atomically projects and schedules an authorized delivery exactly once", async () => {
    const { client } = await createFixture(false);
    const input = makeRequestOpenedInput("delivery-authorized");

    const first = await client.request("ingestSchedulingEvent", input);
    const duplicate = await client.request("ingestSchedulingEvent", input);

    expect(first).toMatchObject({
      outcome: "processed",
      authorized: true,
      jobCreated: true,
      staleJobCount: 0,
      cancelRequestedJobCount: 0,
    });
    expect(first.openedRequestEpochId).not.toBeNull();
    expect(first.jobId).not.toBeNull();
    expect(duplicate).toMatchObject({
      outcome: "duplicate",
      eventId: first.eventId,
      workItemId: first.workItemId,
      jobId: first.jobId,
      jobCreated: true,
    });

    const workItems = await client.request("listWorkItems", {
      page: 1,
      pageSize: 20,
      search: "normalized ingestion",
      kind: ["pull_request"],
      state: ["assigned"],
      authorization: ["self"],
    });
    const jobs = await client.request("listJobs", {
      page: 1,
      pageSize: 20,
      status: ["queued"],
      phase: [],
    });
    const system = await client.request("getSystemSnapshot", {});

    expect(workItems.total).toBe(1);
    expect(workItems.items[0]).toMatchObject({
      id: first.workItemId,
      state: "assigned",
      trigger: "assignment",
      authorization: "self",
      latestJobId: first.jobId,
    });
    expect(jobs.total).toBe(1);
    expect(jobs.items[0]).toMatchObject({ id: first.jobId, status: "queued" });
    expect(system.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(system.databaseSizeBytes).toBeGreaterThan(0);
    expect(system.oldestQueuedAt).not.toBeNull();
  });

  it("rejects reuse of a webhook delivery identifier with a different payload", async () => {
    const { client } = await createFixture(false);
    const input = makeRequestOpenedInput("delivery-conflict");
    await client.request("ingestSchedulingEvent", input);

    await expect(
      client.request("ingestSchedulingEvent", {
        ...input,
        delivery: delivery("delivery-conflict", "different-payload"),
      }),
    ).rejects.toMatchObject({ code: "WEBHOOK_DELIVERY_CONFLICT" });
  });

  it("inherits an active epoch for one job per new pull request revision", async () => {
    const { client } = await createFixture(false);
    const originalHead = "b".repeat(40);
    const newHead = "c".repeat(40);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-open", originalHead),
    );

    const revision = await client.request(
      "ingestSchedulingEvent",
      makeRevisionObservedInput("delivery-revision", newHead, "2026-08-30T00:01:00.000Z", true),
    );
    const unchanged = await client.request(
      "ingestSchedulingEvent",
      makeRevisionObservedInput(
        "delivery-revision-repeat",
        newHead,
        "2026-08-30T00:02:00.000Z",
        false,
      ),
    );
    const jobs = await client.request("listJobs", {
      page: 1,
      pageSize: 20,
      status: [],
      phase: [],
    });

    expect(revision).toMatchObject({ authorized: true, jobCreated: true, staleJobCount: 1 });
    expect(unchanged).toMatchObject({ authorized: false, jobId: null, jobCreated: false });
    expect(jobs.total).toBe(2);
    expect(jobs.items.map((job) => job.status).sort()).toEqual(["queued", "stale"]);
    expect(
      jobs.items.filter((job) => job.targetRevisionKey === pullRequestRevisionKey(newHead)),
    ).toHaveLength(1);
  });

  it("does not let an equal-timestamp webhook overwrite a canonical polling revision", async () => {
    const { client } = await createFixture(false);
    const originalHead = "4".repeat(40);
    const currentHead = "5".repeat(40);
    const sourceUpdatedAt = "2026-08-30T00:00:10.000Z";
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-equal-time-open", originalHead),
    );

    const canonicalCandidate = makeRevisionObservedInput(
      "poll-equal-time-current",
      currentHead,
      "2026-08-30T00:01:00.000Z",
      true,
    );
    const canonicalEvent = {
      ...canonicalCandidate.event,
      eventId: "poll-equal-time-current",
      source: "poll" as const,
      sourceEventId: "poll-equal-time-current",
      workItem: {
        ...canonicalCandidate.event.workItem,
        updatedAt: sourceUpdatedAt,
      },
      revision: {
        ...canonicalCandidate.event.revision,
        sourceUpdatedAt,
      },
    } satisfies NormalizedSchedulingEvent;
    const canonical = await client.request("ingestSchedulingEvent", {
      event: canonicalEvent,
      policy: schedulingPolicy,
      delivery: null,
      schedule: makeJobSchedule(canonicalEvent),
    });

    const delayedCandidate = makeRevisionObservedInput(
      "delivery-equal-time-delayed",
      originalHead,
      "2026-08-30T00:02:00.000Z",
      true,
    );
    const delayedEvent = {
      ...delayedCandidate.event,
      workItem: {
        ...delayedCandidate.event.workItem,
        updatedAt: sourceUpdatedAt,
      },
      revision: {
        ...delayedCandidate.event.revision,
        sourceUpdatedAt,
      },
    } satisfies NormalizedSchedulingEvent;
    const delayed = await client.request("ingestSchedulingEvent", {
      ...delayedCandidate,
      event: delayedEvent,
      schedule: makeJobSchedule(delayedEvent),
    });
    const workItems = await client.request("listWorkItems", { pageSize: 20 });
    const jobs = await client.request("listJobs", { pageSize: 20 });

    expect(canonical).toMatchObject({ authorized: true, jobCreated: true });
    expect(delayed).toMatchObject({ authorized: false, jobCreated: false });
    expect(workItems.items[0]?.currentRevision).toMatchObject({ headSha: currentHead });
    expect(jobs.items.filter((job) => job.status === "queued")).toHaveLength(1);
    expect(jobs.items.find((job) => job.status === "queued")?.targetRevisionKey).toBe(
      pullRequestRevisionKey(currentHead),
    );
  });

  it("reuses only an identical active-epoch job intent and configuration", async () => {
    const { client } = await createFixture(false);
    const headSha = "c".repeat(40);
    const firstInput = makeRequestOpenedInput("delivery-config-first", headSha);
    const first = await client.request("ingestSchedulingEvent", firstInput);

    const secondInput = makeRequestOpenedInput("delivery-config-second", headSha);
    if (secondInput.event.action !== "request_opened") {
      throw new Error("Expected a request_opened event.");
    }
    const sharedAcrossEpochs = await client.request("ingestSchedulingEvent", {
      ...secondInput,
      event: { ...secondInput.event, requestKind: "review_request" },
    });
    expect(sharedAcrossEpochs).toMatchObject({
      jobId: first.jobId,
      jobCreated: false,
    });

    if (firstInput.schedule === null) {
      throw new Error("Expected a candidate schedule.");
    }
    const changedIntentInput = makeRequestOpenedInput("delivery-config-intent", headSha);
    const changedIntent = await client.request("ingestSchedulingEvent", {
      ...changedIntentInput,
      schedule: { ...firstInput.schedule, intentVersion: 2 },
    });
    expect(changedIntent).toMatchObject({ jobCreated: true });
    expect(changedIntent.jobId).not.toBe(first.jobId);

    const changedCapabilitiesInput = makeRequestOpenedInput(
      "delivery-config-capabilities",
      headSha,
    );
    const changedCapabilities = await client.request("ingestSchedulingEvent", {
      ...changedCapabilitiesInput,
      schedule: {
        ...firstInput.schedule,
        intentVersion: 2,
        requiredCapabilities: ["static-review"],
      },
    });
    expect(changedCapabilities).toMatchObject({ jobCreated: true });
    expect(changedCapabilities.jobId).not.toBe(changedIntent.jobId);

    const changedTemplateInput = makeRequestOpenedInput("delivery-config-template", headSha);
    const changedPrompt = "Review with the updated policy prompt.";
    const changedTemplate = await client.request("ingestSchedulingEvent", {
      ...changedTemplateInput,
      schedule: {
        ...firstInput.schedule,
        intentVersion: 2,
        requiredCapabilities: ["static-review"],
        executionTemplate: {
          ...firstInput.schedule.executionTemplate,
          prompt: {
            ...firstInput.schedule.executionTemplate.prompt,
            version: "test-2",
            renderedPrompt: changedPrompt,
            promptSha256: sha256(changedPrompt),
          },
        },
      },
    });
    expect(changedTemplate).toMatchObject({ jobCreated: true });
    expect(changedTemplate.jobId).not.toBe(changedCapabilities.jobId);

    const jobs = await client.request("listJobs", { page: 1, pageSize: 20 });
    expect(jobs.total).toBe(4);
  });

  it("fences an old revision even when the event actor is not authorized", async () => {
    const { client } = await createFixture(false);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-fence-original", "b".repeat(40)),
    );
    const untrustedRevision = makeRequestOpenedInput("delivery-fence-untrusted", "f".repeat(40));
    if (untrustedRevision.event.action !== "request_opened") {
      throw new Error("Expected a request_opened event.");
    }
    const result = await client.request("ingestSchedulingEvent", {
      ...untrustedRevision,
      event: {
        ...untrustedRevision.event,
        actor: { githubUserId: 1234, login: "untrusted", accountType: "user" },
      },
    });
    const jobs = await client.request("listJobs", { page: 1, pageSize: 20 });

    expect(result).toMatchObject({ authorized: false, jobId: null, staleJobCount: 1 });
    expect(jobs.total).toBe(1);
    expect(jobs.items[0]?.status).toBe("stale");
  });

  it("uses the epoch opening policy snapshot for inherited revision decisions", async () => {
    const { client, directory } = await createFixture(false);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-policy-open", "b".repeat(40)),
    );
    const revisionInput = makeRevisionObservedInput(
      "delivery-policy-revision",
      "c".repeat(40),
      "2026-08-30T00:06:00.000Z",
      true,
    );
    await client.request("ingestSchedulingEvent", {
      ...revisionInput,
      policy: {
        ...schedulingPolicy,
        policyVersion: 9,
        allowlistedActorGithubUserIds: [777],
      },
    });
    await client.close();

    const auditDatabase = new DatabaseSync(join(directory, "server.sqlite"));
    try {
      const inherited = auditDatabase
        .prepare(`
          SELECT policy_version, policy_json, policy_sha256
          FROM authorization_decisions
          WHERE basis = 'active_epoch'
        `)
        .get() as unknown as {
        readonly policy_version: number;
        readonly policy_json: string;
        readonly policy_sha256: string;
      };
      expect(inherited.policy_version).toBe(schedulingPolicy.policyVersion);
      expect(JSON.parse(inherited.policy_json)).toEqual(schedulingPolicy);
      expect(inherited.policy_sha256).toBe(sha256(canonicalJson(schedulingPolicy)));
    } finally {
      auditDatabase.close();
    }
  });

  it("requests cancellation when the final active request is removed from a leased job", async () => {
    const { client } = await createFixture(false);
    const headSha = "d".repeat(40);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-before-close", headSha),
    );
    const worker = await registerWorker(client, "worker-close", "instance-close");
    const claim = await claimLease(
      client,
      "worker-close",
      "instance-close",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");

    const closed = await client.request(
      "ingestSchedulingEvent",
      makeRequestClosedInput("delivery-close", headSha, "2026-08-30T00:03:00.000Z"),
    );
    const jobs = await client.request("listJobs", {
      page: 1,
      pageSize: 20,
      status: ["cancel_requested"],
      phase: [],
    });
    const workers = await client.request("listWorkers", {
      page: 1,
      pageSize: 20,
      search: "worker-close",
      status: ["online"],
    });

    expect(closed.closedRequestEpochIds).toHaveLength(1);
    expect(closed.activeRequestEpochIds).toEqual([]);
    expect(closed.cancelRequestedJobCount).toBe(1);
    expect(jobs.total).toBe(1);
    expect(jobs.items[0]?.status).toBe("cancel_requested");
    expect(workers.total).toBe(1);
    expect(workers.items[0]).toMatchObject({
      workerNodeId: "worker-close",
      instanceId: "instance-close",
      activeSlots: 1,
    });
  });

  it("projects a reopened work item without reactivating its closed epoch", async () => {
    const { client } = await createFixture(false);
    const headSha = "e".repeat(40);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-before-resource-close", headSha),
    );
    const closed = await client.request(
      "ingestSchedulingEvent",
      makeWorkItemClosedInput("delivery-resource-close", headSha, "2026-08-30T00:04:00.000Z"),
    );
    const reopened = await client.request(
      "ingestSchedulingEvent",
      makeWorkItemReopenedInput("delivery-resource-reopen", headSha, "2026-08-30T00:05:00.000Z"),
    );
    const workItems = await client.request("listWorkItems", {
      page: 1,
      pageSize: 20,
      state: "open",
    });

    expect(closed.closedRequestEpochIds).toHaveLength(1);
    expect(closed.staleJobCount).toBe(1);
    expect(reopened).toMatchObject({
      authorized: false,
      activeRequestEpochIds: [],
      openedRequestEpochId: null,
      jobId: null,
      jobCreated: false,
    });
    expect(workItems.total).toBe(1);
    expect(workItems.items[0]?.state).toBe("open");
  });

  it("audits but does not schedule an actor outside the allowlist", async () => {
    const { client } = await createFixture(false);
    const authorizedInput = makeRequestOpenedInput("delivery-denied");
    if (authorizedInput.event.action !== "request_opened") {
      throw new Error("Expected a request_opened event.");
    }
    const deniedInput: IngestSchedulingEventInput = {
      ...authorizedInput,
      event: {
        ...authorizedInput.event,
        actor: { githubUserId: 1234, login: "untrusted", accountType: "user" },
      },
    };

    const result = await client.request("ingestSchedulingEvent", deniedInput);
    const jobs = await client.request("listJobs", {
      page: 1,
      pageSize: 20,
      status: [],
      phase: [],
    });

    expect(result).toMatchObject({
      authorized: false,
      activeRequestEpochIds: [],
      openedRequestEpochId: null,
      jobId: null,
    });
    expect(result.authorizationDecisionIds).toHaveLength(1);
    expect(jobs.total).toBe(0);
  });
});
