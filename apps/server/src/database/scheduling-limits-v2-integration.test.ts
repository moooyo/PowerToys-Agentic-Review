import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PrReviewPlanV2ModelOutputSchema } from "@agentic-review/codex";
import type {
  JobExecutionEnvelope,
  JobExecutionEnvelopeV2,
  JobExecutionTemplate,
  JobExecutionTemplateV2,
  SchedulingLimits,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
  ValidationProfileConfig,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { ingestSchedulingEvent } from "../../dist/database/github-ingestion.js";
import { createJobAdmissionInTransaction } from "../../dist/database/job-admission.js";
import { handleRepositoryConfigurationRequest } from "../../dist/database/managed-repositories.js";
import { runMigrations } from "../../dist/database/migrations.js";
import type { ReviewRunDetail } from "../../dist/database/review-runs.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";
import { canonicalJson, sha256 } from "../../dist/scheduling/canonical-json.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const actor = { issuer: "https://identity.example.test", subject: "scheduling-limits-v2" };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const clients: DatabaseClient[] = [];
const directories: string[] = [];

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The V2 scheduling fixture is incomplete.");
  return value;
}

function openedEvent(
  repositoryNumber: number,
  workItemNumber: number,
  at: string,
): SchedulingRequestOpenedEvent {
  const repository = {
    githubRepositoryId: repositoryNumber,
    githubNodeId: `repository-${repositoryNumber}`,
    ownerLogin: "example",
    name: `project-${repositoryNumber}`,
    fullName: `example/project-${repositoryNumber}`,
    htmlUrl: `https://github.com/example/project-${repositoryNumber}`,
    defaultBranch: "main",
    isPrivate: false,
  };
  const githubWorkItemId = repositoryNumber * 1000 + workItemNumber;
  return {
    contractVersion: 1,
    eventId: `scheduling-open-${repositoryNumber}-${workItemNumber}`,
    source: "webhook",
    sourceEventId: `scheduling-delivery-${repositoryNumber}-${workItemNumber}`,
    occurredAt: at,
    observedAt: at,
    repository,
    author: reviewer,
    actor: reviewer,
    target: reviewer,
    action: "request_opened",
    requestKind: "review_request",
    workItem: {
      kind: "pull_request",
      githubRepositoryId: repositoryNumber,
      githubWorkItemId,
      githubNodeId: `PR_${githubWorkItemId}`,
      number: workItemNumber,
      title: "Validate the scheduling change",
      body: "V2 scheduling limit integration fixture.",
      state: "open",
      author: reviewer,
      htmlUrl: `${repository.htmlUrl}/pull/${workItemNumber}`,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      isDraft: false,
    },
    revision: {
      kind: "pull_request",
      githubRepositoryId: repositoryNumber,
      githubWorkItemId,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      revisionKey: sha256(`${"a".repeat(40)}\0${"b".repeat(40)}`),
      observedAt: at,
      sourceUpdatedAt: at,
    },
  };
}

function legacyTemplate(event: SchedulingRequestOpenedEvent): JobExecutionTemplate {
  if (event.workItem.kind !== "pull_request" || event.revision.kind !== "pull_request")
    throw new Error("The scheduling fixture requires a pull request.");
  const renderedPrompt = "Review the exact source revision.";
  return {
    repository: {
      githubRepositoryId: event.repository.githubRepositoryId,
      fullName: event.repository.fullName,
    },
    resource: {
      kind: "pull_request",
      githubNodeId: event.workItem.githubNodeId,
      number: event.workItem.number,
      title: event.workItem.title,
      author: reviewer,
      canonicalSnapshot: event.workItem,
      baseSha: event.revision.baseSha,
      headSha: event.revision.headSha,
      isDraft: false,
    },
    prompt: {
      name: "review",
      version: "fixture",
      renderedPrompt,
      promptSha256: sha256(renderedPrompt),
      outputSchema: PrReviewPlanV2ModelOutputSchema,
      outputSchemaSha256: sha256(canonicalJson(PrReviewPlanV2ModelOutputSchema)),
    },
    executionPolicy: {
      hardTimeoutMs: 600_000,
      noProgressTimeoutMs: 120_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}

interface Source {
  readonly repositoryId: string;
  readonly workItemId: string;
  readonly revisionKey: string;
  readonly legacyJobId: string;
}

function seedSource(
  database: DatabaseSync,
  repositoryNumber: number,
  at: string,
  workItemNumber = 1,
  keepLegacy = false,
): Source {
  const event = openedEvent(repositoryNumber, workItemNumber, at);
  const opened = ingestSchedulingEvent(database, {
    event,
    policy,
    allowScheduling: true,
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: "pull_request",
      payloadSha256: sha256(canonicalJson(event)),
      receivedAt: at,
    },
    schedule: {
      jobKind: "pull_request_review",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 2,
      requiredCapabilities: [],
      executionTemplate: legacyTemplate(event),
    },
  });
  const legacyJobId = present(opened.jobId);
  // Initial source fixtures retain authorization without competing with their V2 Jobs.
  // The mixed-work test separately keeps a real associated Legacy Job on another work item.
  if (!keepLegacy)
    database.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(legacyJobId);
  return {
    repositoryId: opened.repositoryId,
    workItemId: opened.workItemId,
    revisionKey: event.revision.revisionKey,
    legacyJobId,
  };
}

function seedUnassociatedLegacy(database: DatabaseSync, at: string): string {
  const id = "unassociated-legacy";
  const template = legacyTemplate(openedEvent(1, 99, at));
  const execution = canonicalJson({
    ...template,
    repository: { githubRepositoryId: 1, fullName: "previous-owner/previous-name" },
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`INSERT INTO jobs (id, job_kind, semantic_key, concurrency_key, status,
        priority, execution_json, execution_digest, required_capabilities_json, resource_revision,
        max_attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, 'pull_request_review', ?, ?, 'queued', 1, ?, ?, '[]', ?, 2, ?, ?, ?)`)
      .run(id, id, id, execution, sha256(execution), "b".repeat(40), at, at, at);
    createJobAdmissionInTransaction(database, id, at);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return id;
}

interface Fixture {
  readonly client: DatabaseClient;
  readonly sources: Source[];
  readonly associatedLegacyJobId: string | null;
  readonly unassociatedLegacyJobId: string | null;
  read<T>(action: (reader: DatabaseSync) => T): T;
}

async function createFixture(repositoryCount = 1, mixedLegacy = false): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "scheduling-limits-v2-integration-"));
  directories.push(directory);
  const databaseDirectory = join(directory, "database");
  await mkdir(databaseDirectory, { mode: 0o700 });
  const databasePath = join(databaseDirectory, "server.sqlite");
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  const sources: Source[] = [];
  let associatedLegacyJobId: string | null = null;
  let unassociatedLegacyJobId: string | null = null;
  try {
    runMigrations(database, migrationsDirectory);
    const at = new Date(Date.now() - 60_000).toISOString();
    handleRepositoryConfigurationRequest(
      database,
      {
        operation: "bootstrapManagedRepositories",
        input: {
          repositories: Array.from({ length: repositoryCount }, (_, index) => ({
            githubRepositoryId: index + 1,
            fullName: `example/project-${index + 1}`,
          })),
          reviewer,
          authorizationPolicy: policy,
        },
      },
      at,
    );
    for (let number = 1; number <= repositoryCount; number += 1)
      sources.push(seedSource(database, number, at));
    if (mixedLegacy) {
      associatedLegacyJobId = seedSource(database, 1, at, 2, true).legacyJobId;
      unassociatedLegacyJobId = seedUnassociatedLegacy(database, at);
    }
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
    startupTimeoutMilliseconds: 10_000,
    operatorAccess: { administrators: [actor] },
  });
  clients.push(client);
  return {
    client,
    sources,
    associatedLegacyJobId,
    unassociatedLegacyJobId,
    read<T>(action: (reader: DatabaseSync) => T): T {
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return action(reader);
      } finally {
        reader.close();
      }
    },
  };
}

async function configureProfile(client: DatabaseClient, repositoryId: string) {
  const template = await client.request("createPromptTemplate", {
    actor,
    request: {
      name: "Static build prompt",
      workflowKind: "pr_static_build",
      content: "Review the exact source revision.",
      outputSchemaVersion: "PrReviewPlanV2",
    },
  });
  const prompt = await client.request("publishPromptDraft", {
    templateId: template.id,
    actor,
    request: { expectedVersion: template.version },
  });
  await client.request("savePromptBinding", {
    repositoryId,
    workflowKind: "pr_static_build",
    actor,
    request: { expectedVersion: 0, promptVersionId: prompt.id },
  });
  const config: ValidationProfileConfig = {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: [
      {
        id: "compile",
        name: "Compile",
        required: true,
        timeoutMs: 10_000,
        command: {
          executable: "node",
          args: ["--version"],
          workingDirectory: ".",
          environment: [],
        },
      },
    ],
    test: [],
    cleanup: [],
    launch: [],
    requiredCapabilities: [],
    hardTimeoutMs: 600_000,
    noProgressTimeoutMs: 120_000,
  };
  const profile = await client.request("publishValidationProfile", {
    repositoryId,
    actor,
    request: {
      name: "Static build",
      workflowKind: "pr_static_build",
      target: "headless",
      required: true,
      config,
      outputSchemaVersion: "PrReviewPlanV2",
    },
  });
  await client.request("saveValidationProfileBinding", {
    repositoryId,
    profileId: profile.profileId,
    actor,
    request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
  });
  return { profile, prompt };
}

const scope = (run: ReviewRunDetail) => ({ repositoryId: run.repositoryId, reviewRunId: run.id });

async function createRun(fixture: Fixture, source: Source): Promise<ReviewRunDetail> {
  return fixture.client.request("createOperatorReviewRun", {
    repositoryId: source.repositoryId,
    workItemId: source.workItemId,
    actor,
    request: { activationId: "scheduling-v2-run", expectedRevisionKey: source.revisionKey },
  });
}

const associatedJob = (run: ReviewRunDetail, requestId: string) =>
  present(present(run.requests.find((request) => request.requestId === requestId)).jobs[0]).jobId;

async function registerWorker(fixture: Fixture, name: string) {
  const workerNodeId = `node-${name}`;
  const workerInstanceId = `instance-${name}`;
  const workerTokenSha256 = sha256(`token-${name}`);
  await fixture.client.request("createWorkerNodeCredential", {
    workerNodeId,
    displayName: workerNodeId,
    workerTokenSha256,
    createdByIssuer: actor.issuer,
    createdBySubject: actor.subject,
  });
  const worker = await fixture.client.request("registerWorker", {
    protocolVersion: "1.0",
    workerNodeId,
    workerInstanceId,
    workerTokenSha256,
    displayName: workerInstanceId,
    workerVersion: "test",
    maxSlots: 1,
    capabilities: {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      cliEngine: "codex",
      cliVersion: "test",
      recipeIds: [],
      labels: { executionEnvelope: "2", validationHeadless: "1" },
    },
  });
  return {
    claim: () =>
      fixture.client.request("claimLease", {
        workerNodeId,
        workerInstanceId,
        availableSlots: 1,
        capabilitiesDigest: worker.capabilitiesDigest,
        protocolVersion: "1.0",
        leaseTtlSeconds: 300,
      }),
  };
}

async function granted(
  worker: Awaited<ReturnType<typeof registerWorker>>,
): Promise<JobExecutionEnvelope> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimed = await worker.claim();
    if (claimed.outcome === "granted") return claimed.envelope;
    expect(claimed.outcome).toBe("no_work");
  }
  throw new Error("The finite scheduling fixture did not grant its expected lease.");
}

async function claimV2(
  worker: Awaited<ReturnType<typeof registerWorker>>,
): Promise<JobExecutionEnvelopeV2> {
  const envelope = await granted(worker);
  if (envelope.envelopeVersion !== 2) throw new Error("Expected a V2 validation lease.");
  return envelope;
}

async function platformLimits(fixture: Fixture, limits: SchedulingLimits) {
  const current = await fixture.client.request("getPlatformSchedulingStatus", {});
  return fixture.client.request("updatePlatformSchedulingConfiguration", {
    actor,
    request: { expectedVersion: current.configuration.version, limits },
  });
}

async function repositoryLimits(fixture: Fixture, repositoryId: string, limits: SchedulingLimits) {
  const current = present(await fixture.client.request("getManagedRepository", { repositoryId }));
  return fixture.client.request("updateManagedRepository", {
    repositoryId,
    actor,
    request: { expectedVersion: current.version, schedulingLimits: limits },
  });
}

async function repositoryUsage(fixture: Fixture, repositoryId: string) {
  return present(await fixture.client.request("getRepositorySchedulingStatus", { repositoryId }))
    .usage;
}

function readAttempt(fixture: Fixture, jobId: string) {
  return fixture.read((database) =>
    present(
      database
        .prepare(`SELECT job.status AS job_status, job.attempt_count, job.current_run_attempt_id,
          attempt.id AS attempt_id, attempt.status AS attempt_status
          FROM jobs AS job LEFT JOIN run_attempts AS attempt ON attempt.job_id = job.id
          WHERE job.id = ? ORDER BY attempt.attempt_number DESC LIMIT 1`)
        .get(jobId),
    ),
  );
}

function frozenBytes(fixture: Fixture, run: ReviewRunDetail, jobId: string) {
  return fixture.read(
    (database) =>
      present(
        database
          .prepare(`SELECT review_run.plan_json, review_run.plan_digest,
            job.execution_json, job.execution_digest FROM review_runs AS review_run
            JOIN review_run_job_links AS link ON link.review_run_id = review_run.id
            JOIN jobs AS job ON job.id = link.job_id WHERE review_run.id = ? AND job.id = ?`)
          .get(run.id, jobId),
      ) as {
        plan_json: string;
        plan_digest: string;
        execution_json: string;
        execution_digest: string;
      },
  );
}

const usage = (activeLeases: number, admittedQueuedJobs = 0, awaitingAdmissionJobs = 0) => ({
  activeLeases,
  admittedQueuedJobs,
  awaitingAdmissionJobs,
  awaitingConfigurationRequests: 0,
});

afterEach(async () => {
  const errors: unknown[] = [];
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const directory of directories.splice(0)) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "V2 scheduling cleanup failed.");
});

describe("V2 scheduling limits through the database owner", () => {
  it("claims an existing frozen V2 Run after a scheduling-only repository version change", async () => {
    const fixture = await createFixture();
    const source = present(fixture.sources[0]);
    const configured = await configureProfile(fixture.client, source.repositoryId);
    const run = await createRun(fixture, source);
    const jobId = associatedJob(run, configured.profile.profileId);
    const before = frozenBytes(fixture, run, jobId);
    const frozenTemplate = JSON.parse(before.execution_json) as JobExecutionTemplateV2;
    expect(before.plan_digest).toBe(run.planDigest);
    expect(before.execution_digest).toBe(sha256(before.execution_json));
    expect(await repositoryUsage(fixture, source.repositoryId)).toEqual(usage(0, 0, 1));

    const changed = await repositoryLimits(fixture, source.repositoryId, {
      maxActiveLeases: 1,
      maxQueuedJobs: 1,
    });
    expect(changed.version).toBe(run.plan.repository.configurationVersion + 1);
    expect(changed.schedulingLimits).toEqual({ maxActiveLeases: 1, maxQueuedJobs: 1 });
    expect(frozenBytes(fixture, run, jobId)).toEqual(before);
    expect(await fixture.client.request("getReviewRun", scope(run))).toEqual(run);

    const worker = await registerWorker(fixture, "frozen");
    const lease = await claimV2(worker);
    expect(lease.job.jobId).toBe(jobId);
    expect(lease.validation).toEqual(frozenTemplate.validation);
    expect(lease.validation.planDigest).toBe(run.planDigest);
    expect(lease.validation.profileVersion.id).toBe(configured.profile.id);
    expect(lease.validation.promptVersion.id).toBe(configured.prompt.id);
    expect(frozenBytes(fixture, run, jobId)).toEqual(before);
    expect(await repositoryUsage(fixture, source.repositoryId)).toEqual(usage(1));
    expect(readAttempt(fixture, jobId)).toEqual({
      job_status: "leased",
      attempt_count: 1,
      current_run_attempt_id: lease.lease.runAttemptId,
      attempt_id: lease.lease.runAttemptId,
      attempt_status: "leased",
    });
  });

  it.each(["leased", "running"] as const)(
    "keeps a cancelled %s V2 attempt in the global cap until failLease confirms cancellation",
    async (state) => {
      const fixture = await createFixture(2);
      const first = present(fixture.sources[0]);
      const second = present(fixture.sources[1]);
      const firstProfile = await configureProfile(fixture.client, first.repositoryId);
      const secondProfile = await configureProfile(fixture.client, second.repositoryId);
      await platformLimits(fixture, { maxActiveLeases: 1, maxQueuedJobs: null });
      const run = await createRun(fixture, first);
      const owner = await registerWorker(fixture, "owner");
      const contender = await registerWorker(fixture, "contender");
      const held = await claimV2(owner);
      expect(held.job.jobId).toBe(associatedJob(run, firstProfile.profile.profileId));
      if (state === "running")
        expect(
          await fixture.client.request("heartbeatLease", {
            ...held.lease,
            phase: "validation",
            progressSequence: 1,
            progress: {},
            leaseTtlSeconds: 300,
          }),
        ).toMatchObject({ command: "continue" });
      expect(readAttempt(fixture, held.job.jobId)).toMatchObject({
        job_status: state,
        attempt_status: state,
      });
      const waitingRun = await createRun(fixture, second);
      const waitingJobId = associatedJob(waitingRun, secondProfile.profile.profileId);
      expect(
        await fixture.client.request("cancelValidationJob", {
          ...scope(run),
          requestId: firstProfile.profile.profileId,
          jobId: held.job.jobId,
          actor,
        }),
      ).toMatchObject({ changed: true, jobState: "cancel_requested" });
      expect(readAttempt(fixture, held.job.jobId)).toEqual({
        job_status: "cancel_requested",
        attempt_count: 1,
        current_run_attempt_id: held.lease.runAttemptId,
        attempt_id: held.lease.runAttemptId,
        attempt_status: state,
      });
      expect(await contender.claim()).toMatchObject({ outcome: "no_work" });
      expect((await fixture.client.request("getPlatformSchedulingStatus", {})).usage).toEqual(
        usage(1, 1),
      );
      expect(await repositoryUsage(fixture, first.repositoryId)).toEqual(usage(1));
      expect(await repositoryUsage(fixture, second.repositoryId)).toEqual(usage(0, 1));
      expect(readAttempt(fixture, waitingJobId)).toEqual({
        job_status: "queued",
        attempt_count: 0,
        current_run_attempt_id: null,
        attempt_id: null,
        attempt_status: null,
      });

      expect(
        await fixture.client.request("failLease", {
          ...held.lease,
          failureCode: "OPERATOR_CANCELLED",
          failureMessage: "The operator cancelled the synthetic validation attempt.",
          retryable: false,
          retryDelaySeconds: 1,
        }),
      ).toMatchObject({ jobState: "cancelled", runState: "cancelled" });
      expect(readAttempt(fixture, held.job.jobId)).toEqual({
        job_status: "cancelled",
        attempt_count: 1,
        current_run_attempt_id: null,
        attempt_id: held.lease.runAttemptId,
        attempt_status: "cancelled",
      });
      expect((await fixture.client.request("getPlatformSchedulingStatus", {})).usage).toEqual(
        usage(0, 1),
      );
      const next = await claimV2(contender);
      expect(next.job.jobId).toBe(waitingJobId);
      expect(next.repository.githubRepositoryId).toBe(2);
      expect(await repositoryUsage(fixture, first.repositoryId)).toEqual(usage(0));
      expect(await repositoryUsage(fixture, second.repositoryId)).toEqual(usage(1));
      expect((await fixture.client.request("getPlatformSchedulingStatus", {})).usage).toEqual(
        usage(1),
      );
    },
  );

  it("counts associated Legacy, V2, and renamed unassociated Legacy attempts in one numeric repository bucket", async () => {
    const fixture = await createFixture(1, true);
    const source = present(fixture.sources[0]);
    const configured = await configureProfile(fixture.client, source.repositoryId);
    const run = await createRun(fixture, source);
    const v2JobId = associatedJob(run, configured.profile.profileId);
    const associatedLegacyJobId = present(fixture.associatedLegacyJobId);
    const unassociatedLegacyJobId = present(fixture.unassociatedLegacyJobId);
    const expectedJobIds = [associatedLegacyJobId, v2JobId, unassociatedLegacyJobId].sort();
    await repositoryLimits(fixture, source.repositoryId, {
      maxActiveLeases: 3,
      maxQueuedJobs: 3,
    });
    expect(await repositoryUsage(fixture, source.repositoryId)).toEqual(usage(0, 0, 3));
    const leases: JobExecutionEnvelope[] = [];
    for (const name of ["associated", "validation", "unassociated"]) {
      const worker = await registerWorker(fixture, name);
      leases.push(await granted(worker));
      const currentUsage = usage(leases.length, 3 - leases.length);
      expect(await repositoryUsage(fixture, source.repositoryId)).toEqual(currentUsage);
      expect((await fixture.client.request("getPlatformSchedulingStatus", {})).usage).toEqual(
        currentUsage,
      );
    }
    expect(leases.map((lease) => lease.job.jobId).sort()).toEqual(expectedJobIds);
    expect(
      leases.filter((lease) => lease.envelopeVersion === 2).map((lease) => lease.job.jobId),
    ).toEqual([v2JobId]);
    expect(
      present(leases.find((lease) => lease.job.jobId === unassociatedLegacyJobId)).repository,
    ).toEqual({ githubRepositoryId: 1, fullName: "previous-owner/previous-name" });
    const expectedUsage = usage(3);
    expect(await repositoryUsage(fixture, source.repositoryId)).toEqual(expectedUsage);
    expect((await fixture.client.request("getPlatformSchedulingStatus", {})).usage).toEqual(
      expectedUsage,
    );
    expect(
      fixture.read((database) =>
        database
          .prepare(`SELECT job.id AS job_id, job.work_item_id IS NOT NULL AS associated,
            json_type(job.execution_json, '$.validation') IS NOT NULL AS v2,
            admission.bucket_key, admission.github_repository_id, admission.ownership_state,
            job.status AS job_status, attempt.status AS attempt_status
            FROM run_attempts AS attempt JOIN jobs AS job ON job.id = attempt.job_id
            JOIN job_admission AS admission ON admission.job_id = job.id
            WHERE attempt.status IN ('leased', 'running') ORDER BY job.id`)
          .all(),
      ),
    ).toEqual(
      expectedJobIds.map((jobId) => ({
        job_id: jobId,
        associated: jobId === unassociatedLegacyJobId ? 0 : 1,
        v2: jobId === v2JobId ? 1 : 0,
        bucket_key: "github:1",
        github_repository_id: 1,
        ownership_state: "resolved",
        job_status: "leased",
        attempt_status: "leased",
      })),
    );
  });
});
