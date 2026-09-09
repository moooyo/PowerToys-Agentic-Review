import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PrReviewPlanV2ModelOutputSchema } from "@agentic-review/codex";
import type {
  JobExecutionEnvelopeV2,
  JobExecutionTemplateV2,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
  ValidationProfileConfig,
  ValidationProfileCreateRequest,
  WorkerCapabilities,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { ingestSchedulingEvent } from "../../dist/database/github-ingestion.js";
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
const actor = { issuer: "https://identity.example.test", subject: "dispatch-operator" };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const owners: DatabaseClient[] = [];
const directories: string[] = [];

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The dispatch fixture is incomplete.");
  return value;
}

function openedEvent(repositoryNumber: number, at: string): SchedulingRequestOpenedEvent {
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
  const githubWorkItemId = repositoryNumber * 1000 + 1;
  return {
    contractVersion: 1,
    eventId: `dispatch-open-${repositoryNumber}`,
    source: "webhook",
    sourceEventId: `dispatch-delivery-${repositoryNumber}`,
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
      number: 1,
      title: "Validate the settings change",
      body: "Operator dispatch integration fixture.",
      state: "open",
      author: reviewer,
      htmlUrl: `${repository.htmlUrl}/pull/1`,
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

interface Source {
  repositoryId: string;
  workItemId: string;
  revisionKey: string;
}

function seedSource(database: DatabaseSync, number: number, at: string): Source {
  const event = openedEvent(number, at);
  if (event.workItem.kind !== "pull_request" || event.revision.kind !== "pull_request")
    throw new Error("The dispatch fixture requires a pull request.");
  const renderedPrompt = "Review the exact source revision.";
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
      executionTemplate: {
        repository: { githubRepositoryId: number, fullName: event.repository.fullName },
        resource: {
          kind: "pull_request",
          githubNodeId: event.workItem.githubNodeId,
          number: 1,
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
      },
    },
  });
  // Only the legacy authorization fixture is seeded. Every validation job is created by RPC.
  database.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(present(opened.jobId));
  return {
    repositoryId: opened.repositoryId,
    workItemId: opened.workItemId,
    revisionKey: event.revision.revisionKey,
  };
}

function profileConfig(ui: boolean): ValidationProfileConfig {
  const command = (id: string) => ({
    id,
    name: id,
    required: true,
    timeoutMs: 10_000,
    command: { executable: "node", args: ["--version"], workingDirectory: ".", environment: [] },
  });
  return {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: [command("compile")],
    test: [],
    cleanup: [],
    launch: ui ? [command("launch")] : [],
    requiredCapabilities: [],
    hardTimeoutMs: 600_000,
    noProgressTimeoutMs: 120_000,
    ...(ui
      ? {
          ui: {
            schemaVersion: "UiScenariosV1",
            target: "web",
            service: {
              origin: "managed_loopback",
              portEnvironmentVariable: "PORT",
              navigation: "same_origin",
            },
            browser: { engine: "chromium", headless: true, viewport: { width: 1280, height: 720 } },
            launch: {
              stepId: "launch",
              mode: "persistent",
              readiness: { kind: "http", path: "/health", expectedStatus: 200, timeoutMs: 5_000 },
            },
            reset: { strategy: "restart_process" },
            scenarios: [
              {
                id: "settings",
                name: "Settings",
                required: true,
                timeoutMs: 10_000,
                path: "/settings",
                steps: [
                  {
                    id: "visible",
                    name: "Settings is visible",
                    action: "assertVisible",
                    expected: true,
                    timeoutMs: 5_000,
                    locator: { by: "testId", testId: "settings" },
                  },
                ],
              },
            ],
            evidence: {
              screenshots: "every_assertion",
              screenshotScope: "viewport",
              trace: "always",
              required: true,
            },
          } as const,
        }
      : {}),
  };
}

interface Fixture {
  readonly client: DatabaseClient;
  readonly sources: Source[];
  restart(): Promise<void>;
  read<T>(action: (reader: DatabaseSync) => T): T;
}

async function createFixture(repositoryCount = 1): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "validation-dispatch-integration-"));
  directories.push(directory);
  const databaseDirectory = join(directory, "database");
  await mkdir(databaseDirectory, { mode: 0o700 });
  const databasePath = join(databaseDirectory, "server.sqlite");
  const database = new DatabaseSync(databasePath);
  const sources: Source[] = [];
  try {
    database.exec("PRAGMA foreign_keys = ON");
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
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);
  await writeFile(
    databaseInitializationMarkerPath(databasePath),
    databaseInitializationMarkerContent,
    { mode: 0o600 },
  );
  const options = { databasePath, migrationsDirectory, startupTimeoutMilliseconds: 10_000 };
  let client = await DatabaseClient.create(options);
  owners.push(client);
  return {
    get client() {
      return client;
    },
    sources,
    async restart() {
      await client.close();
      client = await DatabaseClient.create(options);
      owners.push(client);
    },
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

async function configureProfile(client: DatabaseClient, repositoryId: string, ui = false) {
  const workflowKind = ui ? "pr_ui" : "pr_static_build";
  const template = await client.request("createPromptTemplate", {
    actor,
    request: {
      name: `${workflowKind} prompt`,
      workflowKind,
      content: "Review the exact source revision.",
      outputSchemaVersion: ui ? "ValidationSummaryV1" : "PrReviewPlanV2",
    },
  });
  const prompt = await client.request("publishPromptDraft", {
    templateId: template.id,
    actor,
    request: { expectedVersion: template.version },
  });
  const promptBinding = await client.request("savePromptBinding", {
    repositoryId,
    workflowKind,
    actor,
    request: { expectedVersion: 0, promptVersionId: prompt.id },
  });
  const request: ValidationProfileCreateRequest = {
    name: ui ? "Settings UI" : "Static build",
    workflowKind,
    target: ui ? "web" : "headless",
    required: true,
    config: profileConfig(ui),
    outputSchemaVersion: ui ? "ValidationReportV1" : "PrReviewPlanV2",
  };
  const profile = await client.request("publishValidationProfile", {
    repositoryId,
    actor,
    request,
  });
  const profileBinding = await client.request("saveValidationProfileBinding", {
    repositoryId,
    profileId: profile.profileId,
    actor,
    request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
  });
  return { profile, profileBinding, prompt, promptBinding, request };
}

async function registerWorker(
  fixture: Fixture,
  name: string,
  labels: WorkerCapabilities["labels"],
) {
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
      codexVersion: "test",
      recipeIds: [],
      labels,
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

const staticLabels = { executionEnvelope: "2", validationHeadless: "1" };
const uiLabels = {
  executionEnvelope: "2",
  validationWeb: "1",
  "ui:web": "1",
  evidenceDelivery: "1",
};
const scope = (run: ReviewRunDetail) => ({ repositoryId: run.repositoryId, reviewRunId: run.id });

async function createRun(
  fixture: Fixture,
  source = present(fixture.sources[0]),
  activationId = "operator-activation",
  profileIds?: string[],
): Promise<ReviewRunDetail> {
  const created = await fixture.client.request("createOperatorReviewRun", {
    repositoryId: source.repositoryId,
    workItemId: source.workItemId,
    actor,
    request: {
      activationId,
      expectedRevisionKey: source.revisionKey,
      ...(profileIds === undefined ? {} : { profileIds }),
    },
  });
  expect(await fixture.client.request("getReviewRun", scope(created))).toEqual(created);
  return created;
}

async function claimV2(
  worker: Awaited<ReturnType<typeof registerWorker>>,
): Promise<JobExecutionEnvelopeV2> {
  const claimed = await worker.claim();
  if (claimed.outcome !== "granted" || claimed.envelope.envelopeVersion !== 2)
    throw new Error(`Expected a validation lease, received ${claimed.outcome}.`);
  return claimed.envelope;
}

const associatedJob = (run: ReviewRunDetail, requestId: string) =>
  present(present(run.requests.find((request) => request.requestId === requestId)).jobs[0]).jobId;

interface JobRow {
  id: string;
  job_kind: string;
  status: string;
  concurrency_key: string;
  execution_json: string;
  execution_digest: string;
  current_run_attempt_id: string | null;
  lease_generation: number;
  attempt_count: number;
}
function readJob(fixture: Fixture, jobId: string): JobRow {
  return fixture.read(
    (database) =>
      present(database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId)) as unknown as JobRow,
  );
}

function readAdmission(fixture: Fixture, jobId: string) {
  return fixture.read((database) =>
    present(database.prepare("SELECT * FROM job_admission WHERE job_id = ?").get(jobId)),
  );
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const owner of owners.splice(0)) {
    try {
      await owner.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const directory of directories.splice(0)) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Dispatch fixture cleanup failed.");
});

describe("validation dispatch through the database owner", () => {
  it("dispatches required static and UI requests independently and grants only matching v2 Workers", async () => {
    const fixture = await createFixture();
    const source = present(fixture.sources[0]);
    const build = await configureProfile(fixture.client, source.repositoryId);
    const ui = await configureProfile(fixture.client, source.repositoryId, true);
    const legacyWorker = await registerWorker(fixture, "legacy", {});
    const staticWorker = await registerWorker(fixture, "static", staticLabels);
    const uiWorker = await registerWorker(fixture, "ui", uiLabels);
    const run = await createRun(fixture, source, "dual-workflow", [build.profile.profileId]);
    expect(run.requests).toHaveLength(2);
    expect(run.requests.every((request) => request.jobs.length === 1)).toBe(true);
    const staticJobId = associatedJob(run, build.profile.profileId);
    const uiJobId = associatedJob(run, ui.profile.profileId);
    expect(readJob(fixture, staticJobId).job_kind).toBe("pull_request_review");
    expect(readJob(fixture, uiJobId).job_kind).toBe("pull_request_review");
    expect(readJob(fixture, staticJobId).concurrency_key).not.toBe(
      readJob(fixture, uiJobId).concurrency_key,
    );
    expect(await legacyWorker.claim()).toMatchObject({ outcome: "no_work" });
    const staticLease = await claimV2(staticWorker);
    const uiLease = await claimV2(uiWorker);
    for (const [lease, configuration, jobId, workflowKind] of [
      [staticLease, build, staticJobId, "pr_static_build"],
      [uiLease, ui, uiJobId, "pr_ui"],
    ] as const) {
      expect(lease.job.jobId).toBe(jobId);
      expect(lease.validation).toMatchObject({
        runId: run.id,
        planDigest: run.planDigest,
        repositoryId: source.repositoryId,
        workItemId: source.workItemId,
        revisionKey: source.revisionKey,
        requestId: configuration.profile.profileId,
        workflowKind,
        required: true,
        jobActivation: 1,
        profileVersion: configuration.profile,
        promptVersion: {
          id: configuration.prompt.id,
          contentSha256: configuration.prompt.contentSha256,
        },
      });
      expect(readJob(fixture, jobId).execution_digest).toBe(
        sha256(readJob(fixture, jobId).execution_json),
      );
      expect(lease.validation.requiredCheckIds).toContain(`${configuration.profile.id}:compile`);
    }
    expect(uiLease.validation.requiredCheckIds).toContain(`${ui.profile.id}:settings`);
    expect(canonicalJson(staticLease)).not.toContain(ui.profile.id);
    expect(canonicalJson(uiLease)).not.toContain(build.profile.id);
    expect(
      await fixture.client.request("dispatchReviewRun", { ...scope(run), actor }),
    ).toMatchObject({
      createdJobs: [],
      alreadyAssociatedRequestIds: expect.arrayContaining([
        build.profile.profileId,
        ui.profile.profileId,
      ]),
    });
  });

  it("preserves real pending Jobs across restart and admits each after its Worker appears", async () => {
    const fixture = await createFixture();
    const source = present(fixture.sources[0]);
    const build = await configureProfile(fixture.client, source.repositoryId);
    const ui = await configureProfile(fixture.client, source.repositoryId, true);
    await registerWorker(fixture, "legacy", {});
    const run = await createRun(fixture);
    const staticJobId = associatedJob(run, build.profile.profileId);
    const uiJobId = associatedJob(run, ui.profile.profileId);
    const jobs = [staticJobId, uiJobId].map((jobId) => readJob(fixture, jobId));
    const admissions = [staticJobId, uiJobId].map((jobId) => readAdmission(fixture, jobId));
    expect(run.requests.every((request) => request.jobs.length === 1)).toBe(true);
    expect(admissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ job_id: staticJobId, state: "pending", attempt_base: 0 }),
        expect.objectContaining({ job_id: uiJobId, state: "pending", attempt_base: 0 }),
      ]),
    );
    expect(
      jobs.every(
        (job) =>
          job.status === "queued" && job.attempt_count === 0 && job.current_run_attempt_id === null,
      ),
    ).toBe(true);
    await fixture.restart();
    expect(await fixture.client.request("getReviewRun", scope(run))).toEqual(run);
    expect([staticJobId, uiJobId].map((jobId) => readAdmission(fixture, jobId))).toEqual(
      admissions,
    );
    const staticWorker = await registerWorker(fixture, "static", staticLabels);
    const firstScan = await fixture.client.request("dispatchPendingReviewRuns", { limit: 128 });
    expect(firstScan).toMatchObject({
      createdJobs: [],
      blockedRequestCount: 0,
    });
    expect(await fixture.client.request("admitPendingJobs", { limit: 128 })).toMatchObject({
      admittedJobCount: 1,
    });
    expect(readAdmission(fixture, staticJobId)).toMatchObject({
      state: "admitted",
      attempt_base: 0,
    });
    expect(readAdmission(fixture, uiJobId)).toMatchObject({ state: "pending", attempt_base: 0 });
    const staticLease = await claimV2(staticWorker);
    expect(staticLease.validation.requestId).toBe(build.profile.profileId);
    expect(staticLease.job.jobId).toBe(staticJobId);
    const uiWorker = await registerWorker(fixture, "ui", uiLabels);
    const secondScan = await fixture.client.request("dispatchPendingReviewRuns", { limit: 128 });
    expect(secondScan.createdJobs).toEqual([]);
    expect(await fixture.client.request("admitPendingJobs", { limit: 128 })).toMatchObject({
      admittedJobCount: 1,
    });
    const uiLease = await claimV2(uiWorker);
    expect(uiLease.validation.requestId).toBe(ui.profile.profileId);
    expect(uiLease.job.jobId).toBe(uiJobId);
    expect(await fixture.client.request("dispatchPendingReviewRuns", {})).toMatchObject({
      createdJobs: [],
    });
    await fixture.restart();
    const restored = present(await fixture.client.request("getReviewRun", scope(run)));
    expect(restored.planDigest).toBe(run.planDigest);
    expect(restored.requests).toEqual(run.requests);
    for (const original of jobs) {
      const current = readJob(fixture, original.id);
      expect(current.execution_json).toBe(original.execution_json);
      expect(current.execution_digest).toBe(original.execution_digest);
    }
  });

  it("keeps a paused repository pending until its operator enables scheduling again", async () => {
    const fixture = await createFixture();
    const source = present(fixture.sources[0]);
    await configureProfile(fixture.client, source.repositoryId);
    const run = await createRun(fixture);
    const jobId = present(present(run.requests[0]).jobs[0]).jobId;
    const original = readJob(fixture, jobId);
    const admission = readAdmission(fixture, jobId);
    expect(admission).toMatchObject({ state: "pending", attempt_base: 0 });
    const repository = present(
      await fixture.client.request("getManagedRepository", { repositoryId: source.repositoryId }),
    );
    const paused = await fixture.client.request("updateManagedRepository", {
      repositoryId: source.repositoryId,
      actor,
      request: { expectedVersion: repository.version, enabled: false },
    });
    const worker = await registerWorker(fixture, "static", staticLabels);
    expect(await fixture.client.request("dispatchPendingReviewRuns", {})).toMatchObject({
      createdJobs: [],
    });
    expect((await fixture.client.request("getReviewRun", scope(run)))?.requests).toEqual(
      run.requests,
    );
    expect(await fixture.client.request("admitPendingJobs", {})).toMatchObject({
      admittedJobCount: 0,
    });
    expect(await worker.claim()).toMatchObject({ outcome: "no_work" });
    expect(readAdmission(fixture, jobId)).toMatchObject({
      state: "pending",
      episode_sequence: admission.episode_sequence,
    });
    await fixture.restart();
    await fixture.client.request("updateManagedRepository", {
      repositoryId: source.repositoryId,
      actor,
      request: { expectedVersion: paused.version, enabled: true },
    });
    expect((await fixture.client.request("dispatchPendingReviewRuns", {})).createdJobs).toEqual([]);
    expect(await fixture.client.request("admitPendingJobs", {})).toMatchObject({
      admittedJobCount: 1,
    });
    expect((await claimV2(worker)).job.jobId).toBe(jobId);
    expect(readJob(fixture, jobId).execution_json).toBe(original.execution_json);
    expect((await fixture.client.request("getReviewRun", scope(run)))?.requests).toEqual(
      run.requests,
    );
  });

  it("reruns the frozen request once per activation after current bindings change and survives restart", async () => {
    const fixture = await createFixture();
    const source = present(fixture.sources[0]);
    const configured = await configureProfile(fixture.client, source.repositoryId);
    const worker = await registerWorker(fixture, "static", staticLabels);
    const run = await createRun(fixture);
    const requestId = configured.profile.profileId;
    const initialJobId = associatedJob(run, requestId);
    const initial = readJob(fixture, initialJobId);
    await fixture.client.request("cancelValidationJob", {
      ...scope(run),
      requestId,
      jobId: initialJobId,
      actor,
    });
    const updatedProfile = await fixture.client.request("publishValidationProfile", {
      repositoryId: source.repositoryId,
      actor,
      request: {
        ...configured.request,
        profileId: requestId,
        expectedVersion: configured.profile.version,
        config: {
          ...configured.profile.config,
          build: [
            {
              ...present(configured.profile.config.build[0]),
              command: {
                executable: "node",
                args: ["--help"],
                workingDirectory: ".",
                environment: [],
              },
            },
          ],
        },
      },
    });
    await fixture.client.request("saveValidationProfileBinding", {
      repositoryId: source.repositoryId,
      profileId: requestId,
      actor,
      request: {
        expectedVersion: configured.profileBinding.version,
        profileVersionId: updatedProfile.id,
        enabled: true,
      },
    });
    const newTemplate = await fixture.client.request("createPromptTemplate", {
      actor,
      request: {
        name: "Revised review prompt",
        workflowKind: "pr_static_build",
        content: "Apply the revised review instructions.",
        outputSchemaVersion: "PrReviewPlanV2",
      },
    });
    const newPrompt = await fixture.client.request("publishPromptDraft", {
      templateId: newTemplate.id,
      actor,
      request: { expectedVersion: newTemplate.version },
    });
    await fixture.client.request("savePromptBinding", {
      repositoryId: source.repositoryId,
      workflowKind: "pr_static_build",
      actor,
      request: { expectedVersion: configured.promptBinding.version, promptVersionId: newPrompt.id },
    });
    const input = { ...scope(run), requestId, activationId: "rerun-activation", actor };
    const rerun = await fixture.client.request("rerunValidationRequest", input);
    expect(rerun).toMatchObject({ ...scope(run), requestId, jobActivation: 2, replayed: false });
    expect(rerun.jobId).not.toBe(initialJobId);
    const next = readJob(fixture, rerun.jobId);
    const initialTemplate = JSON.parse(initial.execution_json) as JobExecutionTemplateV2;
    expect(JSON.parse(next.execution_json)).toEqual({
      ...initialTemplate,
      validation: { ...initialTemplate.validation, jobActivation: 2 },
    });
    expect(next.execution_digest).not.toBe(initial.execution_digest);
    expect(next.execution_digest).toBe(sha256(next.execution_json));
    expect(await fixture.client.request("rerunValidationRequest", input)).toEqual({
      ...rerun,
      replayed: true,
    });
    await expect(
      fixture.client.request("rerunValidationRequest", {
        ...input,
        actor: { ...actor, subject: "other-operator" },
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_CONFLICT" });
    await expect(
      fixture.client.request("rerunValidationRequest", { ...input, activationId: "another-rerun" }),
    ).rejects.toMatchObject({ code: "PLATFORM_CONFLICT" });
    await fixture.restart();
    expect(await fixture.client.request("rerunValidationRequest", input)).toEqual({
      ...rerun,
      replayed: true,
    });
    const replay = await createRun(fixture);
    expect(replay.id).toBe(run.id);
    expect(replay.planDigest).toBe(run.planDigest);
    expect(replay.requests[0]?.jobs).toHaveLength(2);
    const lease = await claimV2(worker);
    expect(lease.job.jobId).toBe(rerun.jobId);
    expect(lease.validation.profileVersion.id).toBe(configured.profile.id);
    expect(lease.validation.promptVersion.id).toBe(configured.prompt.id);
    expect(lease.validation.planDigest).toBe(run.planDigest);
    const fresh = await createRun(fixture, source, "new-operator-activation");
    expect(fresh.plan.jobs[0]?.profileVersion?.id).toBe(updatedProfile.id);
    expect(fresh.plan.jobs[0]?.prompt?.version.id).toBe(newPrompt.id);
    expect(fresh.planDigest).not.toBe(run.planDigest);
  });

  it("cancels queued jobs idempotently without redispatching or creating an attempt", async () => {
    const fixture = await createFixture();
    const source = present(fixture.sources[0]);
    const configured = await configureProfile(fixture.client, source.repositoryId);
    const worker = await registerWorker(fixture, "static", staticLabels);
    const run = await createRun(fixture);
    const requestId = configured.profile.profileId;
    const jobId = associatedJob(run, requestId);
    const input = { ...scope(run), requestId, jobId, actor };
    expect(await fixture.client.request("cancelValidationJob", input)).toMatchObject({
      jobState: "cancelled",
      changed: true,
    });
    expect(await fixture.client.request("cancelValidationJob", input)).toMatchObject({
      jobState: "cancelled",
      changed: false,
    });
    expect(
      await fixture.client.request("dispatchReviewRun", { ...scope(run), actor }),
    ).toMatchObject({ createdJobs: [], alreadyAssociatedRequestIds: [requestId] });
    expect(await fixture.client.request("dispatchPendingReviewRuns", {})).toMatchObject({
      createdJobs: [],
    });
    expect(await worker.claim()).toMatchObject({ outcome: "no_work" });
    expect(readJob(fixture, jobId)).toMatchObject({
      status: "cancelled",
      current_run_attempt_id: null,
      attempt_count: 0,
    });
    await fixture.restart();
    expect(await fixture.client.request("cancelValidationJob", input)).toMatchObject({
      jobState: "cancelled",
      changed: false,
    });
  });

  it.each(["leased", "running"] as const)(
    "retains a %s lease until the Worker confirms cancellation",
    async (state) => {
      const fixture = await createFixture();
      const source = present(fixture.sources[0]);
      const configured = await configureProfile(fixture.client, source.repositoryId);
      const worker = await registerWorker(fixture, "static", staticLabels);
      const run = await createRun(fixture);
      const lease = await claimV2(worker);
      const heartbeat = (progressSequence: number) =>
        fixture.client.request("heartbeatLease", {
          ...lease.lease,
          phase: "validation",
          progressSequence,
          progress: {},
          leaseTtlSeconds: 300,
        });
      if (state === "running") expect((await heartbeat(1)).command).toBe("continue");
      const jobId = lease.job.jobId;
      const before = readJob(fixture, jobId);
      expect(before.status).toBe(state);
      const input = { ...scope(run), requestId: configured.profile.profileId, jobId, actor };
      expect(await fixture.client.request("cancelValidationJob", input)).toMatchObject({
        jobState: "cancel_requested",
        changed: true,
      });
      expect(readJob(fixture, jobId)).toMatchObject({
        status: "cancel_requested",
        current_run_attempt_id: lease.lease.runAttemptId,
        lease_generation: before.lease_generation,
      });
      expect(await fixture.client.request("cancelValidationJob", input)).toMatchObject({
        jobState: "cancel_requested",
        changed: false,
      });
      expect((await heartbeat(2)).command).toBe("cancel");
      await expect(
        fixture.client.request("completeLease", {
          ...lease.lease,
          result: {},
          resultDigest: sha256("{}"),
        }),
      ).rejects.toMatchObject({ code: "LEASE_LOST" });
      await fixture.restart();
      expect(readJob(fixture, jobId).current_run_attempt_id).toBe(lease.lease.runAttemptId);
      const cancelled = await fixture.client.request("failLease", {
        ...lease.lease,
        failureCode: "OPERATOR_CANCELLED",
        failureMessage: "The operator cancelled validation.",
        retryable: false,
        retryDelaySeconds: 1,
      });
      expect(cancelled).toMatchObject({ jobState: "cancelled", runState: "cancelled" });
      expect(readJob(fixture, jobId)).toMatchObject({
        status: "cancelled",
        current_run_attempt_id: null,
        attempt_count: 1,
      });
    },
  );

  it("rejects crossed repository, run, request, job and revision identities without mutating either repository", async () => {
    const fixture = await createFixture(2);
    const first = present(fixture.sources[0]);
    const second = present(fixture.sources[1]);
    const firstProfile = await configureProfile(fixture.client, first.repositoryId);
    const secondProfile = await configureProfile(fixture.client, second.repositoryId);
    await registerWorker(fixture, "static", staticLabels);
    const firstRun = await createRun(fixture, first);
    const secondRun = await createRun(fixture, second);
    const firstJobId = associatedJob(firstRun, firstProfile.profile.profileId);
    const secondJobId = associatedJob(secondRun, secondProfile.profile.profileId);
    const create = {
      repositoryId: first.repositoryId,
      workItemId: first.workItemId,
      actor,
      request: { activationId: "crossed-create", expectedRevisionKey: first.revisionKey },
    };
    await expect(
      fixture.client.request("createOperatorReviewRun", {
        ...create,
        repositoryId: second.repositoryId,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
    await expect(
      fixture.client.request("createOperatorReviewRun", {
        ...create,
        request: { ...create.request, profileIds: [secondProfile.profile.profileId] },
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_INVALID" });
    await expect(
      fixture.client.request("createOperatorReviewRun", {
        ...create,
        request: { ...create.request, expectedRevisionKey: "c".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_CONFLICT" });
    expect(
      await fixture.client.request("getReviewRun", {
        repositoryId: second.repositoryId,
        reviewRunId: firstRun.id,
      }),
    ).toBeNull();
    await expect(
      fixture.client.request("dispatchReviewRun", {
        repositoryId: second.repositoryId,
        reviewRunId: firstRun.id,
        actor,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
    await expect(
      fixture.client.request("rerunValidationRequest", {
        ...scope(firstRun),
        requestId: secondProfile.profile.profileId,
        activationId: "crossed-rerun",
        actor,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
    const cancel = {
      ...scope(firstRun),
      requestId: firstProfile.profile.profileId,
      jobId: firstJobId,
      actor,
    };
    for (const crossed of [
      { ...cancel, repositoryId: second.repositoryId },
      { ...cancel, reviewRunId: secondRun.id },
      { ...cancel, requestId: secondProfile.profile.profileId },
      { ...cancel, jobId: secondJobId },
    ])
      await expect(fixture.client.request("cancelValidationJob", crossed)).rejects.toMatchObject({
        code: "PLATFORM_NOT_FOUND",
      });
    expect(readJob(fixture, firstJobId)).toMatchObject({ status: "queued", attempt_count: 0 });
    expect(readJob(fixture, secondJobId)).toMatchObject({ status: "queued", attempt_count: 0 });
    expect(
      (await fixture.client.request("getReviewRun", scope(firstRun)))?.requests[0]?.jobs,
    ).toHaveLength(1);
    expect(
      (await fixture.client.request("getReviewRun", scope(secondRun)))?.requests[0]?.jobs,
    ).toHaveLength(1);
  });
});
