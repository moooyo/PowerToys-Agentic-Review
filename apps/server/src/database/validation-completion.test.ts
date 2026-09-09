import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  IssueTriageV1ModelOutputSchema,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
  type ValidationJobResultV1,
} from "@agentic-review/codex";
import type {
  ActiveAuthorizedRequestEpoch,
  EvidenceAssetMetadata,
  JobExecutionEnvelope,
  JobExecutionTemplateV2,
  ManagedRepository,
  ReviewRunPlanInput,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
  ValidationProfileConfig,
  ValidationProfileCreateRequest,
  WorkerCapabilities,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import type { EvidenceStorageOptions } from "../../dist/database/evidence-assets.js";
import { ingestSchedulingEvent } from "../../dist/database/github-ingestion.js";
import { createJobAdmissionInTransaction } from "../../dist/database/job-admission.js";
import { handleRepositoryConfigurationRequest } from "../../dist/database/managed-repositories.js";
import { runMigrations } from "../../dist/database/migrations.js";
import {
  handlePromptConfigurationRequest,
  type PromptConfigurationOperation,
  type PromptConfigurationOperationMap,
  type PromptConfigurationRequest,
} from "../../dist/database/prompt-configuration.js";
import {
  associateReviewRunJobInTransaction,
  getReviewRunPromptEnvelope,
  handleReviewRunRequest,
  type ReviewRunDetail,
} from "../../dist/database/review-runs.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";
import { canonicalJson, sha256 } from "../../dist/scheduling/canonical-json.js";
import { createValidationExecutionTemplate } from "../../dist/scheduling/validation-job-factory.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const actor = { issuer: "https://identity.example.test", subject: "completion-test" };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: 100,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const workerNodeId = "validation-completion-worker";
const workerInstanceId = "validation-completion-instance";
const workerTokenSha256 = sha256("validation-completion-test-token");
const capabilities: WorkerCapabilities = {
  operatingSystem: "windows",
  architecture: "x64",
  headless: true,
  interactiveDesktop: false,
  codexVersion: "test",
  recipeIds: [],
  labels: { executionEnvelope: "2", validationHeadless: "1", validationWeb: "1" },
};

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The completion fixture is incomplete.");
  return value;
}

function openedEvent(kind: "pull_request" | "issue", at: string): SchedulingRequestOpenedEvent {
  const repository = {
    githubRepositoryId: 1,
    githubNodeId: "repository-1",
    ownerLogin: "example",
    name: "project",
    fullName: "example/project",
    htmlUrl: "https://github.com/example/project",
    defaultBranch: "main",
    isPrivate: false,
  };
  const workItem = {
    githubRepositoryId: 1,
    githubWorkItemId: 1001,
    githubNodeId: "work-item-1",
    number: 1,
    title: "Validate this change",
    body: "Completion integration fixture.",
    state: "open" as const,
    author: reviewer,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
  const revision = {
    githubRepositoryId: 1,
    githubWorkItemId: 1001,
    observedAt: at,
    sourceUpdatedAt: at,
  };
  const issueDigest = sha256(canonicalJson([workItem.title, workItem.body, workItem.state, at]));
  return {
    contractVersion: 1,
    eventId: "completion-open",
    source: "webhook",
    sourceEventId: "completion-delivery",
    occurredAt: at,
    observedAt: at,
    repository,
    author: reviewer,
    actor: reviewer,
    target: reviewer,
    action: "request_opened",
    requestKind: kind === "pull_request" ? "review_request" : "assignment",
    workItem:
      kind === "pull_request"
        ? { ...workItem, kind, htmlUrl: `${repository.htmlUrl}/pull/1`, isDraft: false }
        : { ...workItem, kind, htmlUrl: `${repository.htmlUrl}/issues/1` },
    revision:
      kind === "pull_request"
        ? {
            ...revision,
            kind,
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            revisionKey: sha256(`${"a".repeat(40)}\0${"b".repeat(40)}`),
          }
        : { ...revision, kind, revisionKey: issueDigest, contentDigest: issueDigest },
  };
}

function configure<K extends PromptConfigurationOperation>(
  database: DatabaseSync,
  operation: K,
  input: PromptConfigurationOperationMap[K]["input"],
  at: string,
): PromptConfigurationOperationMap[K]["output"] {
  return handlePromptConfigurationRequest(
    database,
    { operation, input } as PromptConfigurationRequest,
    at,
  ) as PromptConfigurationOperationMap[K]["output"];
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

interface Seed {
  readonly event: SchedulingRequestOpenedEvent;
  readonly jobId: string;
  readonly run: ReviewRunDetail | null;
  readonly template: JobExecutionTemplateV2 | null;
}

function seedDatabase(
  database: DatabaseSync,
  options: { ui?: boolean; legacyVersion?: 1 | 2; kind?: "pull_request" | "issue" },
): Seed {
  const at = new Date(Date.now() - 60_000).toISOString();
  const kind = options.kind ?? "pull_request";
  const event = openedEvent(kind, at);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, migrationsDirectory);
  handleRepositoryConfigurationRequest(
    database,
    {
      operation: "bootstrapManagedRepositories",
      input: {
        repositories: [{ githubRepositoryId: 1, fullName: event.repository.fullName }],
        reviewer,
        authorizationPolicy: policy,
      },
    },
    at,
  );
  const outputSchema =
    kind === "pull_request"
      ? options.legacyVersion === 1
        ? PrReviewPlanV1ModelOutputSchema
        : PrReviewPlanV2ModelOutputSchema
      : options.legacyVersion === 1
        ? IssueTriageV1ModelOutputSchema
        : IssueTriageV2ModelOutputSchema;
  const renderedPrompt = "Review the exact source revision.";
  const opened = ingestSchedulingEvent(database, {
    event,
    policy,
    allowScheduling: true,
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: kind === "issue" ? "issues" : "pull_request",
      payloadSha256: sha256(canonicalJson(event)),
      receivedAt: at,
    },
    schedule: {
      jobKind: kind === "pull_request" ? "pull_request_review" : "issue_triage",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 2,
      requiredCapabilities: [],
      executionTemplate: {
        repository: { githubRepositoryId: 1, fullName: event.repository.fullName },
        resource: {
          githubNodeId: event.workItem.githubNodeId,
          number: 1,
          title: event.workItem.title,
          author: reviewer,
          canonicalSnapshot: event.workItem,
          ...(event.revision.kind === "pull_request"
            ? {
                kind: "pull_request",
                baseSha: event.revision.baseSha,
                headSha: event.revision.headSha,
                isDraft: false,
              }
            : { kind: "issue", revisionDigest: event.revision.revisionKey }),
        },
        prompt: {
          name: "review",
          version: "fixture",
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          outputSchema,
          outputSchemaSha256: sha256(canonicalJson(outputSchema)),
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
  const legacyJobId = present(opened.jobId);
  if (options.legacyVersion !== undefined)
    return { event, jobId: legacyJobId, run: null, template: null };
  database.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(legacyJobId);
  const managed = handleRepositoryConfigurationRequest(
    database,
    { operation: "getManagedRepository", input: { repositoryId: opened.repositoryId } },
    at,
  ) as ManagedRepository;
  const workflowKind = options.ui ? "pr_ui" : "pr_static_build";
  const promptTemplate = configure(
    database,
    "createPromptTemplate",
    {
      actor,
      request: {
        name: "Completion prompt",
        workflowKind,
        content: renderedPrompt,
        outputSchemaVersion: options.ui ? "ValidationSummaryV1" : "PrReviewPlanV2",
      },
    },
    at,
  );
  const prompt = configure(
    database,
    "publishPromptDraft",
    { templateId: promptTemplate.id, actor, request: { expectedVersion: promptTemplate.version } },
    at,
  );
  const profileRequest: ValidationProfileCreateRequest = options.ui
    ? {
        name: "UI completion",
        workflowKind: "pr_ui",
        target: "web",
        required: true,
        config: profileConfig(true),
        outputSchemaVersion: "ValidationReportV1",
      }
    : {
        name: "Build completion",
        workflowKind: "pr_static_build",
        target: "headless",
        required: true,
        config: profileConfig(false),
        outputSchemaVersion: "PrReviewPlanV2",
      };
  const profile = configure(
    database,
    "publishValidationProfile",
    { repositoryId: managed.id, actor, request: profileRequest },
    at,
  );
  configure(
    database,
    "saveValidationProfileBinding",
    {
      repositoryId: managed.id,
      profileId: profile.profileId,
      actor,
      request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
    },
    at,
  );
  configure(
    database,
    "savePromptBinding",
    {
      repositoryId: managed.id,
      workflowKind,
      actor,
      request: { expectedVersion: 0, promptVersionId: prompt.id },
    },
    at,
  );
  const epochRow = database
    .prepare("SELECT epoch_json FROM request_epochs WHERE id = ?")
    .get(opened.openedRequestEpochId) as { epoch_json: string };
  const planInput: ReviewRunPlanInput = {
    activationId: "completion-activation",
    repository: {
      id: managed.id,
      githubRepositoryId: 1,
      fullName: managed.fullName,
      configurationVersion: managed.version,
    },
    workItemId: opened.workItemId,
    workItem: event.workItem,
    revision: event.revision,
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    testedSourceAuthorization: null,
    authorization: JSON.parse(epochRow.epoch_json) as ActiveAuthorizedRequestEpoch,
    authorizationPolicy: policy,
    requests: [
      {
        requestId: "selected",
        workflowKind,
        target: profile.target,
        required: true,
        profileVersion: profile,
        prompt: { workflowKind, version: prompt },
      },
    ],
    runnerSupport: [
      {
        workflowKind,
        target: profile.target,
        capabilities: options.ui ? ["ui:web"] : [],
        evidenceDelivery: true,
      },
    ],
  };
  const run = handleReviewRunRequest(
    database,
    { operation: "createReviewRun", input: { planInput, actor } },
    at,
  ) as ReviewRunDetail;
  const seeded = addValidationJob(database, run, 1, at);
  return { event, run, ...seeded };
}

function addValidationJob(
  database: DatabaseSync,
  run: ReviewRunDetail,
  activation: number,
  at: string,
) {
  const template = createValidationExecutionTemplate({
    runId: run.id,
    plan: run.plan,
    planDigest: run.planDigest,
    requestId: "selected",
    jobActivation: activation,
    frozenPrompt: present(
      getReviewRunPromptEnvelope(database, {
        repositoryId: run.repositoryId,
        reviewRunId: run.id,
        requestId: "selected",
      }),
    ),
  });
  const jobId = `validation-completion-${activation}`;
  const executionJson = canonicalJson(template);
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`INSERT INTO jobs (
    id, work_item_id, request_epoch_id, job_kind, semantic_key, concurrency_key, status,
    execution_json, execution_digest, resource_revision, required_capabilities_json,
    required_capabilities_digest, priority, max_attempts, next_attempt_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'pull_request_review', ?, ?, 'queued', ?, ?, ?, '[]', ?, 100, 2, ?, ?, ?)`)
      .run(
        jobId,
        run.workItemId,
        run.requestEpochId,
        jobId,
        run.workItemId,
        executionJson,
        sha256(executionJson),
        run.revisionKey,
        sha256("[]"),
        at,
        at,
        at,
      );
    createJobAdmissionInTransaction(database, jobId, at);
    associateReviewRunJobInTransaction(
      database,
      { repositoryId: run.repositoryId, reviewRunId: run.id, requestId: "selected", jobId, actor },
      at,
    );
    database
      .prepare(
        "INSERT OR IGNORE INTO job_request_epochs(job_id, request_epoch_id, linked_at) VALUES (?, ?, ?)",
      )
      .run(jobId, run.requestEpochId, at);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { jobId, template };
}

interface Fixture {
  readonly directory: string;
  readonly databasePath: string;
  readonly event: SchedulingRequestOpenedEvent;
  readonly run: ReviewRunDetail | null;
  readonly jobId: string;
  readonly template: JobExecutionTemplateV2 | null;
  readonly client: DatabaseClient;
  claim(): Promise<JobExecutionEnvelope>;
  read<T>(action: (reader: DatabaseSync) => T): T;
  editWithOwnerClosed(action: (writer: DatabaseSync) => void): Promise<void>;
  rerun(): Promise<void>;
}
const owners: DatabaseClient[] = [];
const directories: string[] = [];

async function createFixture(
  options: { ui?: boolean; legacyVersion?: 1 | 2; kind?: "pull_request" | "issue" } = {},
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "validation-completion-"));
  directories.push(directory);
  const databaseDirectory = join(directory, "database");
  await mkdir(databaseDirectory, { mode: 0o700 });
  const databasePath = join(databaseDirectory, "server.sqlite");
  let seed: Seed;
  const database = new DatabaseSync(databasePath);
  try {
    seed = seedDatabase(database, options);
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);
  await writeFile(
    databaseInitializationMarkerPath(databasePath),
    databaseInitializationMarkerContent,
    { mode: 0o600 },
  );
  const evidenceStorage: EvidenceStorageOptions | undefined = options.ui
    ? {
        evidenceDirectory: join(directory, "evidence"),
        globalQuotaBytes: 16 * 1024 * 1024,
        globalAssetLimit: 100,
        retentionMs: 60_000,
        incompleteUploadTtlMs: 60_000,
      }
    : undefined;
  if (evidenceStorage !== undefined)
    await mkdir(evidenceStorage.evidenceDirectory, { mode: 0o700 });
  const ownerOptions = {
    databasePath,
    migrationsDirectory,
    startupTimeoutMilliseconds: 10_000,
    ...(evidenceStorage === undefined ? {} : { evidenceStorage }),
  };
  let client = await DatabaseClient.create(ownerOptions);
  owners.push(client);
  const registered = await client.request("createWorkerNodeCredential", {
    workerNodeId,
    displayName: workerNodeId,
    workerTokenSha256,
    createdByIssuer: actor.issuer,
    createdBySubject: actor.subject,
  });
  expect(registered.authState).toBe("pending");
  const worker = await client.request("registerWorker", {
    protocolVersion: "1.0",
    workerNodeId,
    workerInstanceId,
    workerTokenSha256,
    displayName: workerInstanceId,
    workerVersion: "test",
    maxSlots: 1,
    capabilities,
  });
  const result: Fixture = {
    directory,
    databasePath,
    event: seed.event,
    run: seed.run,
    get jobId() {
      return seed.jobId;
    },
    get template() {
      return seed.template;
    },
    get client() {
      return client;
    },
    async claim(): Promise<JobExecutionEnvelope> {
      const claimed = await client.request("claimLease", {
        workerNodeId,
        workerInstanceId,
        availableSlots: 1,
        capabilitiesDigest: worker.capabilitiesDigest,
        protocolVersion: "1.0",
        leaseTtlSeconds: 300,
      });
      if (claimed.outcome !== "granted")
        throw new Error(`Expected a lease, received ${claimed.outcome}.`);
      expect(claimed.envelope.job.jobId).toBe(seed.jobId);
      expect(claimed.envelope.envelopeVersion).toBe(options.legacyVersion === undefined ? 2 : 1);
      return claimed.envelope;
    },
    read<T>(action: (reader: DatabaseSync) => T): T {
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return action(reader);
      } finally {
        reader.close();
      }
    },
    async editWithOwnerClosed(action: (writer: DatabaseSync) => void) {
      await client.close();
      const writer = new DatabaseSync(databasePath);
      try {
        writer.exec("PRAGMA foreign_keys = ON");
        action(writer);
      } finally {
        writer.close();
      }
      client = await DatabaseClient.create(ownerOptions);
      owners.push(client);
    },
    async rerun() {
      await result.editWithOwnerClosed((writer) => {
        const next = addValidationJob(
          writer,
          present(seed.run),
          2,
          new Date(Date.now() - 1_000).toISOString(),
        );
        seed = { ...seed, ...next };
      });
    },
  };
  return result;
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
  if (failures.length > 0) throw new AggregateError(failures, "Completion fixture cleanup failed.");
});

function report(fixture: Fixture, failedBuild = true): ValidationJobResultV1 {
  const profile = present(fixture.template).validation.profileVersion;
  const buildId = `${profile.id}:compile`;
  const checks: ValidationJobResultV1["report"]["checks"] = [
    {
      id: buildId,
      name: "Compile",
      kind: "build",
      required: true,
      source: "runner",
      outcome: failedBuild ? "failed" : "passed",
      summary: failedBuild ? "Compilation failed." : "Compilation passed.",
      expected: "Exit code 0",
      actual: failedBuild ? "Exit code 1" : "Exit code 0",
      evidenceIds: [],
    },
  ];
  const diagnostics: ValidationJobResultV1["execution"]["diagnostics"] = [
    {
      stepId: buildId,
      phase: "build",
      outcome: failedBuild ? "failed" : "passed",
      exitCode: failedBuild ? 1 : 0,
      summary: "The compiler completed.",
      stdout: "Compiler output.",
      stderr: failedBuild ? "Build error." : "",
    },
  ];
  for (const scenario of profile.config.ui?.scenarios ?? []) {
    const id = `${profile.id}:${scenario.id}`;
    checks.push({
      id,
      name: scenario.name,
      kind: "ui",
      required: scenario.required,
      source: "runner",
      outcome: "passed",
      summary: "The scenario passed.",
      expected: "Settings is visible",
      actual: "Settings is visible",
      evidenceIds: [],
    });
    diagnostics.push({
      stepId: id,
      phase: "ui",
      outcome: "passed",
      exitCode: null,
      summary: "The assertion completed.",
    });
  }
  return {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "pull_request",
      sourceState: "original",
      summary: "Validation completed.",
      checks,
    },
    execution: { blockers: [], diagnostics, cleanupState: "not_needed" },
    modelReview: { state: "not_requested" },
  };
}

function submission<T>(envelope: JobExecutionEnvelope, result: T) {
  return { ...envelope.lease, resultDigest: sha256(canonicalJson(result)), result };
}

function resultRows(fixture: Fixture) {
  return fixture.read((reader) =>
    reader
      .prepare(`SELECT result.job_id, result.run_attempt_id,
    result.result_digest, result.result_json, result.evidence_complete, job.status AS job_status,
    attempt.status AS attempt_status, attempt.result_json AS attempt_json
    FROM validation_job_results result JOIN jobs job ON job.id = result.job_id
    JOIN run_attempts attempt ON attempt.id = result.run_attempt_id ORDER BY result.job_id`)
      .all(),
  );
}

async function upload(
  fixture: Fixture,
  envelope: JobExecutionEnvelope,
  checkId: string,
  kind: "screenshot" | "trace" | "steps",
  finalize = true,
  content?: Buffer,
) {
  const bytes =
    content ??
    (kind === "screenshot"
      ? Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
          "base64",
        )
      : Buffer.from('{"format":"completion-test-trace","events":[]}'));
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata: EvidenceAssetMetadata = {
    kind,
    mediaType: kind === "screenshot" ? "image/png" : "application/json",
    sizeBytes: bytes.length,
    sha256: contentSha256,
    capturedAt: new Date().toISOString(),
    checkId,
  } as EvidenceAssetMetadata;
  const begun = await fixture.client.request("beginEvidenceUpload", {
    lease: envelope.lease,
    clientAssetId: `evidence-${kind}`,
    metadata,
  });
  await fixture.client.request("appendEvidenceChunk", {
    lease: envelope.lease,
    assetId: begun.assetId,
    offset: 0,
    base64: bytes.toString("base64"),
    chunkSha256: contentSha256,
  });
  if (finalize)
    await fixture.client.request("finalizeEvidenceUpload", {
      lease: envelope.lease,
      assetId: begun.assetId,
    });
  return begun.assetId;
}

describe.skipIf(process.platform !== "linux")(
  "validation completion through the SQLite owner",
  () => {
    it("commits a failed compiler result as a succeeded execution with immutable validation evidence", async () => {
      const f = await createFixture();
      const lease = await f.claim();
      const body = report(f);
      const sent = submission(lease, body);
      expect(await f.client.request("completeLease", sent)).toEqual({
        jobId: f.jobId,
        runAttemptId: lease.lease.runAttemptId,
        jobState: "succeeded",
        runState: "succeeded",
      });
      expect(resultRows(f)).toEqual([
        {
          job_id: f.jobId,
          run_attempt_id: lease.lease.runAttemptId,
          result_digest: sent.resultDigest,
          result_json: canonicalJson(body),
          attempt_json: canonicalJson(body),
          evidence_complete: 1,
          job_status: "succeeded",
          attempt_status: "succeeded",
        },
      ]);
      expect(
        f.read((reader) =>
          reader
            .prepare("SELECT COUNT(*) AS total FROM review_results WHERE job_id = ?")
            .get(f.jobId),
        ),
      ).toEqual({ total: 0 });
    });

    it("replays exact terminal bytes after owner restart and lease expiry while rejecting changed results", async () => {
      const f = await createFixture();
      const lease = await f.claim();
      const sent = submission(lease, report(f));
      const completed = await f.client.request("completeLease", sent);
      const saved = resultRows(f);
      await f.editWithOwnerClosed((writer) =>
        writer
          .prepare(
            "UPDATE run_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
          )
          .run(lease.lease.runAttemptId),
      );
      expect(await f.client.request("completeLease", sent)).toEqual(completed);
      const changed = {
        ...sent.result,
        report: { ...sent.result.report, summary: "A different terminal result." },
      };
      await expect(
        f.client.request("completeLease", submission(lease, changed)),
      ).rejects.toMatchObject({ code: "TERMINAL_SUBMISSION_CONFLICT" });
      await expect(
        f.client.request("completeLease", { ...sent, leaseToken: `${sent.leaseToken}-invalid` }),
      ).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(resultRows(f)).toEqual(saved);
    });

    it("rejects mismatched lease identities without consuming the valid lease", async () => {
      const f = await createFixture();
      const lease = await f.claim();
      const sent = submission(lease, report(f));
      for (const change of [
        { jobId: "other-job" },
        { runAttemptId: "other-attempt" },
        { workerNodeId: "other-node" },
        { workerInstanceId: "other-instance" },
        { leaseToken: "other-token" },
        { leaseGeneration: sent.leaseGeneration + 1 },
      ])
        await expect(
          f.client.request("completeLease", { ...sent, ...change }),
        ).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(resultRows(f)).toEqual([]);
      expect(await f.client.request("completeLease", sent)).toMatchObject({
        jobState: "succeeded",
      });
    });

    it("rolls back an invalid validation report and accepts a corrected submission on the same lease", async () => {
      const f = await createFixture();
      const lease = await f.claim();
      const invalid = report(f);
      present(invalid.report.checks[0]).required = false;
      await expect(
        f.client.request("completeLease", submission(lease, invalid)),
      ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
      expect(resultRows(f)).toEqual([]);
      expect(
        f.read((reader) =>
          reader
            .prepare("SELECT status, result_json FROM run_attempts WHERE id = ?")
            .get(lease.lease.runAttemptId),
        ),
      ).toEqual({ status: "leased", result_json: null });
      expect(await f.client.request("completeLease", submission(lease, report(f)))).toMatchObject({
        runState: "succeeded",
      });
    });

    it.each(["lease_expires_at", "execution_deadline_at", "no_progress_deadline_at"] as const)(
      "rejects completion when %s elapsed before submission",
      async (deadline) => {
        const f = await createFixture();
        const lease = await f.claim();
        await f.editWithOwnerClosed((writer) =>
          writer
            .prepare(
              `UPDATE run_attempts SET ${deadline} = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
            )
            .run(lease.lease.runAttemptId),
        );
        await expect(
          f.client.request("completeLease", submission(lease, report(f))),
        ).rejects.toMatchObject({ code: "LEASE_LOST" });
        expect(resultRows(f)).toEqual([]);
      },
    );

    it("rejects an expired attempt after its successor acquires the job", async () => {
      const f = await createFixture();
      const previous = await f.claim();
      await f.editWithOwnerClosed((writer) =>
        writer
          .prepare(
            "UPDATE run_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
          )
          .run(previous.lease.runAttemptId),
      );
      expect(
        await f.client.request("reapExpiredLeases", {
          retryDelaySeconds: 1,
          workerOfflineAfterSeconds: 90,
        }),
      ).toEqual({ expiredCount: 1 });
      await f.editWithOwnerClosed((writer) =>
        writer
          .prepare("UPDATE jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
          .run(f.jobId),
      );
      const current = await f.claim();
      expect(current.lease.leaseGeneration).toBeGreaterThan(previous.lease.leaseGeneration);
      await expect(
        f.client.request("completeLease", submission(previous, report(f))),
      ).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(await f.client.request("completeLease", submission(current, report(f)))).toMatchObject(
        { runState: "succeeded" },
      );
      expect(resultRows(f)).toMatchObject([{ run_attempt_id: current.lease.runAttemptId }]);
    });

    it("honors cancellation from a real GitHub closure before completion", async () => {
      const f = await createFixture();
      const lease = await f.claim();
      const at = new Date().toISOString();
      const event = {
        ...f.event,
        eventId: "completion-closed",
        sourceEventId: "completion-close-delivery",
        occurredAt: at,
        observedAt: at,
        action: "work_item_closed" as const,
        requestKind: null,
        target: null,
        closeReason: "work_item_closed" as const,
        workItem: { ...f.event.workItem, state: "closed" as const, updatedAt: at, closedAt: at },
      };
      expect(
        await f.client.request("ingestSchedulingEvent", {
          event,
          policy,
          schedule: null,
          delivery: {
            deliveryId: event.sourceEventId,
            eventName: "pull_request",
            receivedAt: at,
            payloadSha256: sha256(canonicalJson(event)),
          },
        }),
      ).toMatchObject({ cancelRequestedJobCount: 1 });
      await expect(
        f.client.request("completeLease", submission(lease, report(f))),
      ).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(resultRows(f)).toEqual([]);
      expect(
        await f.client.request("failLease", {
          ...lease.lease,
          failureCode: "REQUEST_WITHDRAWN",
          failureMessage: "The request was withdrawn.",
          retryable: false,
          retryDelaySeconds: 1,
        }),
      ).toMatchObject({ jobState: "cancelled", runState: "cancelled" });
    });

    it("keeps UI reports incomplete without assets and rejects references that never finalized", async () => {
      const f = await createFixture({ ui: true });
      const lease = await f.claim();
      const body = report(f, false);
      const check = present(body.report.checks.find((entry) => entry.kind === "ui"));
      check.evidenceIds = ["missing-asset"];
      await expect(
        f.client.request("completeLease", submission(lease, body)),
      ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
      const pending = await upload(f, lease, check.id, "screenshot", false);
      check.evidenceIds = [pending];
      await expect(
        f.client.request("completeLease", submission(lease, body)),
      ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
      expect(resultRows(f)).toEqual([]);
      check.evidenceIds = [];
      expect(await f.client.request("completeLease", submission(lease, body))).toMatchObject({
        jobState: "succeeded",
      });
      expect(resultRows(f)).toMatchObject([{ evidence_complete: 0 }]);
    });

    it.each([
      { label: "verified scenario steps", includeSteps: true, expectedComplete: 1 },
      { label: "missing scenario steps", includeSteps: false, expectedComplete: 0 },
    ])(
      "preserves UI assets with $label and rejects reuse on a new activation",
      async ({ includeSteps, expectedComplete }) => {
        const f = await createFixture({ ui: true });
        const first = await f.claim();
        const body = report(f, false);
        const check = present(body.report.checks.find((entry) => entry.kind === "ui"));
        check.evidenceIds = [
          await upload(f, first, check.id, "screenshot"),
          await upload(f, first, check.id, "trace"),
        ];
        if (includeSteps) {
          const steps = {
            schemaVersion: "UiScenarioExecutionEvidenceV1",
            source: "ui_driver",
            scenarioId: "settings",
            target: "web",
            steps: [
              {
                stepId: "visible",
                name: "Settings is visible",
                action: "assertVisible",
                outcome: "passed",
                summary: "The settings element is visible.",
                expected: true,
                actual: true,
                evidenceIds: [check.evidenceIds[0]],
              },
            ],
          };
          check.evidenceIds.push(
            await upload(f, first, check.id, "steps", true, Buffer.from(JSON.stringify(steps))),
          );
        }
        const sent = submission(first, body);
        expect(await f.client.request("completeLease", sent)).toMatchObject({
          jobState: "succeeded",
        });
        expect(resultRows(f)).toMatchObject([
          { evidence_complete: expectedComplete, result_digest: sent.resultDigest },
        ]);
        expect(await f.client.request("completeLease", sent)).toMatchObject({
          runState: "succeeded",
        });
        await f.rerun();
        const second = await f.claim();
        await expect(
          f.client.request("completeLease", submission(second, body)),
        ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
        expect(resultRows(f)).toHaveLength(1);
        expect(
          f.read((reader) => reader.prepare("SELECT status FROM jobs WHERE id = ?").get(f.jobId)),
        ).toEqual({ status: "leased" });
      },
    );

    it.each([
      { kind: "pull_request" as const, legacyVersion: 1 as const },
      { kind: "pull_request" as const, legacyVersion: 2 as const },
      { kind: "issue" as const, legacyVersion: 1 as const },
      { kind: "issue" as const, legacyVersion: 2 as const },
    ])("retains the $kind V$legacyVersion completion and replay path", async (options) => {
      const f = await createFixture(options);
      const lease = await f.claim();
      const common = { summary: "Legacy review completed.", requestedRecipeIds: [] };
      const versionTwo =
        options.legacyVersion === 2
          ? {
              verification: {
                status: "not_run",
                summary: "No commands were requested.",
                commands: [],
              },
              executionEvidence: {
                schemaVersion: "ReviewExecutionEvidenceV1",
                source: "worker",
                commandCapture: "complete",
                commands: [],
                worktree: { status: "clean", source: "git_status" },
              },
            }
          : {};
      const result =
        options.kind === "pull_request"
          ? {
              ...common,
              ...versionTwo,
              schemaVersion: `PrReviewPlanV${options.legacyVersion}`,
              assessment: "comment",
              findings: [],
            }
          : {
              ...common,
              ...versionTwo,
              schemaVersion: `IssueTriageV${options.legacyVersion}`,
              category: "bug",
              priority: 2,
              confidence: 0.8,
              suggestedLabels: [],
              missingInformation: [],
              duplicateCandidates: [],
            };
      const sent = submission(lease, result);
      const completed = await f.client.request("completeLease", sent);
      expect(completed).toMatchObject({ jobState: "succeeded", runState: "succeeded" });
      expect(await f.client.request("completeLease", sent)).toEqual(completed);
      expect(
        f.read((reader) =>
          reader
            .prepare(
              "SELECT schema_id, result_json, result_digest FROM review_results WHERE job_id = ?",
            )
            .get(f.jobId),
        ),
      ).toEqual({
        schema_id: result.schemaVersion,
        result_json: canonicalJson(result),
        result_digest: sent.resultDigest,
      });
      expect(resultRows(f)).toEqual([]);
    });
  },
);
