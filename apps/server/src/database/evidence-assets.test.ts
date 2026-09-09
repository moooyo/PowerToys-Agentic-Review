import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  IssueTriageV1ModelOutputSchema,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "@agentic-review/codex";
import type {
  ActiveAuthorizedRequestEpoch,
  EvidenceAssetManifest,
  GitHubRepository,
  LeaseIdentity,
  ManagedRepository,
  ReviewRunPlanInput,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
  ValidationCommandStep,
  ValidationProfileConfig,
  ValidationProfileCreateRequest,
  WorkflowKind,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../scheduling/canonical-json.js";
import { createValidationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  closeEvidenceAssetStorage,
  commitVerifiedEvidenceFinalization,
  type EvidenceAssetOperation,
  type EvidenceAssetOperationMap,
  type EvidenceAssetRequest,
  type EvidenceStorageOptions,
  finalizedEvidenceReferences,
  handleEvidenceAssetRequest,
  initializeEvidenceStorage,
  prepareEvidenceFinalizationCandidate,
  readEvidenceStorageKey,
  readEvidenceVerificationCandidate,
} from "./evidence-assets.js";
import { inspectEvidenceFile, inspectEvidenceRoot, verifyEvidenceAsset } from "./evidence-files.js";
import type { AssetVerificationSnapshot } from "./evidence-verification-protocol.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    fsyncSync: vi.fn(original.fsyncSync),
    mkdirSync: vi.fn(original.mkdirSync),
    openSync: vi.fn(original.openSync),
  };
});

import { ingestSchedulingEvent } from "./github-ingestion.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import {
  handlePromptConfigurationRequest,
  type PromptConfigurationOperation,
  type PromptConfigurationOperationMap,
  type PromptConfigurationRequest,
} from "./prompt-configuration.js";
import type { ReviewCompletionJobContext } from "./review-results.js";
import {
  associateReviewRunJobInTransaction,
  getReviewRunPromptEnvelope,
  handleReviewRunRequest,
  type ReviewRunDetail,
} from "./review-runs.js";

const now = "2026-09-07T00:00:00.000Z";
const sha256 = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");
const later = "2026-09-07T00:05:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "operator-1" };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const databases: DatabaseSync[] = [];
const temporaryDirectories: string[] = [];
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));

afterEach(() => {
  for (const database of databases.splice(0)) {
    closeEvidenceAssetStorage(database);
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The test fixture is incomplete.");
  return value;
}

function insertRow(database: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
  const columns = Object.keys(row);
  database
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
}

function evidenceReferenceGuardProbe(database: DatabaseSync) {
  const definition = present(
    database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'tr_validation_result_evidence_references'",
      )
      .get() as { sql: string } | undefined,
  ).sql;
  // The deliberately incomplete payloads violate several result guards. SQLite does not promise
  // their execution order. Keep every production guard intact, and exercise this exact stored
  // reference guard on a temporary result-shaped table backed by the same real asset rows.
  database.exec(
    "CREATE TEMP TABLE evidence_reference_probe AS SELECT * FROM validation_job_results WHERE 0",
  );
  const isolated = definition.replace(
    /^CREATE TRIGGER tr_validation_result_evidence_references BEFORE INSERT ON validation_job_results\b/u,
    "CREATE TEMP TRIGGER test_evidence_reference_guard BEFORE INSERT ON evidence_reference_probe",
  );
  expect(isolated).not.toBe(definition);
  database.exec(isolated);
  return (row: Record<string, SQLInputValue>) => {
    expect(() => insertRow(database, "validation_job_results", row)).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get()).toEqual({
      count: 0,
    });
    insertRow(database, "evidence_reference_probe", row);
  };
}

function configure<K extends PromptConfigurationOperation>(
  database: DatabaseSync,
  operation: K,
  input: PromptConfigurationOperationMap[K]["input"],
): PromptConfigurationOperationMap[K]["output"] {
  return handlePromptConfigurationRequest(
    database,
    { operation, input } as PromptConfigurationRequest,
    now,
  ) as PromptConfigurationOperationMap[K]["output"];
}

function command(id: string, required = true): ValidationCommandStep {
  return {
    id,
    name: id,
    command: { executable: "node", args: ["--version"], workingDirectory: ".", environment: [] },
    required,
    timeoutMs: 10_000,
  };
}

function profileConfig(
  workflowKind: WorkflowKind,
  commandRequired = true,
): ValidationProfileConfig {
  const config: ValidationProfileConfig = {
    schemaVersion: "ValidationProfileV1",
    setup: workflowKind === "issue_triage" ? [] : [command("prepare", commandRequired)],
    build: workflowKind === "issue_triage" ? [] : [command("compile", commandRequired)],
    test: workflowKind === "issue_triage" ? [] : [command("unit-tests", commandRequired)],
    launch: workflowKind === "pr_ui" ? [command("launch", commandRequired)] : [],
    cleanup: workflowKind === "issue_triage" ? [] : [command("clean", commandRequired)],
    requiredCapabilities: [],
    hardTimeoutMs: 120_000,
    noProgressTimeoutMs: 30_000,
  };
  if (workflowKind === "pr_ui") {
    config.ui = {
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
          required: commandRequired,
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
    };
  }
  return config;
}

function openedEvent(kind: "pull_request" | "issue"): SchedulingRequestOpenedEvent {
  const repository: GitHubRepository = {
    githubRepositoryId: 1,
    githubNodeId: "repository-1",
    ownerLogin: "example",
    name: "project",
    fullName: "example/project",
    htmlUrl: "https://github.com/example/project",
    defaultBranch: "main",
    isPrivate: false,
  };
  const common = {
    githubWorkItemId: 1001,
    githubNodeId: "work-item-1",
    githubRepositoryId: 1,
    number: 1,
    title: "Validate the settings panel",
    body: "Update settings.",
    state: "open" as const,
    author: reviewer,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  const revisionCommon = {
    githubRepositoryId: 1,
    githubWorkItemId: 1001,
    observedAt: now,
    sourceUpdatedAt: now,
  };
  const issueDigest = sha256(
    JSON.stringify([common.title, common.body, common.state, common.updatedAt]),
  );
  return {
    contractVersion: 1,
    eventId: "event-1",
    source: "webhook",
    sourceEventId: "delivery-1",
    occurredAt: now,
    observedAt: now,
    repository,
    author: reviewer,
    action: "request_opened",
    requestKind: kind === "pull_request" ? "review_request" : "assignment",
    actor: reviewer,
    target: reviewer,
    workItem:
      kind === "pull_request"
        ? { ...common, kind, htmlUrl: `${repository.htmlUrl}/pull/1`, isDraft: false }
        : { ...common, kind, htmlUrl: `${repository.htmlUrl}/issues/1` },
    revision:
      kind === "pull_request"
        ? {
            ...revisionCommon,
            kind,
            revisionKey: sha256(`${"a".repeat(40)}\0${"b".repeat(40)}`),
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
          }
        : {
            ...revisionCommon,
            kind,
            revisionKey: issueDigest,
            contentDigest: issueDigest,
          },
  };
}

interface FixtureOptions {
  workflowKind?: WorkflowKind;
  requestRequired?: boolean;
  profileRequired?: boolean;
  commandRequired?: boolean;
  associate?: boolean;
  migrationDirectory?: string;
  legacyVersion?: 1 | 2;
  blockedReproduction?: boolean;
  extraUiScenario?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const workflowKind = options.workflowKind ?? "pr_static_build";
  const kind = workflowKind.startsWith("pr_") ? "pull_request" : "issue";
  const observed = openedEvent(kind);
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON");
  runMigrations(database, options.migrationDirectory ?? migrationsDirectory);
  handleRepositoryConfigurationRequest(
    database,
    {
      operation: "bootstrapManagedRepositories",
      input: {
        repositories: [{ githubRepositoryId: 1, fullName: "example/project" }],
        reviewer,
        authorizationPolicy: policy,
      },
    },
    now,
  );
  const legacyOutputSchema =
    kind === "pull_request"
      ? options.legacyVersion === 1
        ? PrReviewPlanV1ModelOutputSchema
        : PrReviewPlanV2ModelOutputSchema
      : options.legacyVersion === 1
        ? IssueTriageV1ModelOutputSchema
        : IssueTriageV2ModelOutputSchema;
  const renderedPrompt = "Review the exact source revision.";
  const ingested = ingestSchedulingEvent(database, {
    allowScheduling: true,
    event: observed,
    policy,
    schedule: {
      jobKind: kind === "pull_request" ? "pull_request_review" : "issue_triage",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 2,
      requiredCapabilities: [],
      executionTemplate: {
        repository: { githubRepositoryId: 1, fullName: "example/project" },
        resource: {
          githubNodeId: observed.workItem.githubNodeId,
          number: 1,
          title: observed.workItem.title,
          author: reviewer,
          canonicalSnapshot: observed.workItem,
          ...(observed.revision.kind === "pull_request"
            ? {
                kind: "pull_request",
                baseSha: observed.revision.baseSha,
                headSha: observed.revision.headSha,
                isDraft: false,
              }
            : { kind: "issue", revisionDigest: observed.revision.revisionKey }),
        },
        prompt: {
          name: "review",
          version: "fixture",
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          outputSchema: legacyOutputSchema,
          outputSchemaSha256: sha256(canonicalJson(legacyOutputSchema)),
        },
        executionPolicy: {
          hardTimeoutMs: 120_000,
          noProgressTimeoutMs: 30_000,
          allowedRecipeIds: [],
          requiredCapabilityLabels: {},
        },
      },
    },
    delivery: {
      deliveryId: observed.sourceEventId,
      eventName: "pull_request",
      payloadSha256: sha256(canonicalJson(observed)),
      receivedAt: now,
    },
  });
  const legacyJobId = (database.prepare("SELECT id FROM jobs").get() as { id: string }).id;
  const managed = handleRepositoryConfigurationRequest(
    database,
    { operation: "getManagedRepository", input: { repositoryId: ingested.repositoryId } },
    now,
  ) as ManagedRepository;
  const template = configure(database, "createPromptTemplate", {
    actor,
    request: {
      name: "Review prompt",
      workflowKind,
      content: renderedPrompt,
      outputSchemaVersion:
        workflowKind === "pr_static_build"
          ? "PrReviewPlanV2"
          : workflowKind === "issue_triage"
            ? "IssueTriageV2"
            : "ValidationSummaryV1",
    },
  });
  const prompt = configure(database, "publishPromptDraft", {
    templateId: template.id,
    actor,
    request: { expectedVersion: template.version },
  });
  const config = profileConfig(workflowKind, options.commandRequired);
  if (options.extraUiScenario) {
    const ui = present(config.ui);
    if (ui.target !== "web") throw new Error("The extra scenario fixture requires a Web profile.");
    const additional = structuredClone(present(ui.scenarios[0]));
    additional.id = "secondary-settings";
    additional.name = "Secondary settings";
    present(additional.steps[0]).id = "secondary-visible";
    ui.scenarios.push(additional);
  }
  // Keep one required build check so an optional lifecycle step can be tested in a ready plan.
  if (options.commandRequired === false && config.build[0] !== undefined)
    config.build[0].required = true;
  const profileRequest = {
    name: "Configured validation",
    required: options.profileRequired ?? true,
    config,
    ...(workflowKind === "pr_ui"
      ? { workflowKind, target: "web", outputSchemaVersion: "ValidationReportV1" }
      : workflowKind === "pr_static_build"
        ? { workflowKind, target: "headless", outputSchemaVersion: "PrReviewPlanV2" }
        : workflowKind === "issue_triage"
          ? { workflowKind, target: "headless", outputSchemaVersion: "IssueTriageV2" }
          : { workflowKind, target: "headless", outputSchemaVersion: "ValidationReportV1" }),
  } as ValidationProfileCreateRequest;
  const profile = configure(database, "publishValidationProfile", {
    repositoryId: managed.id,
    request: profileRequest,
    actor,
  });
  configure(database, "saveValidationProfileBinding", {
    repositoryId: managed.id,
    profileId: profile.profileId,
    actor,
    request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
  });
  configure(database, "savePromptBinding", {
    repositoryId: managed.id,
    workflowKind,
    actor,
    request: { expectedVersion: 0, promptVersionId: prompt.id },
  });
  const epochRow = database
    .prepare("SELECT epoch_json FROM request_epochs WHERE id = ?")
    .get(ingested.openedRequestEpochId) as { epoch_json: string };
  const epoch = JSON.parse(epochRow.epoch_json) as ActiveAuthorizedRequestEpoch;
  const planInput: ReviewRunPlanInput = {
    activationId: "activation-1",
    repository: {
      id: managed.id,
      githubRepositoryId: 1,
      fullName: managed.fullName,
      configurationVersion: managed.version,
    },
    workItemId: ingested.workItemId,
    workItem: observed.workItem,
    revision: observed.revision,
    testedSourceRevision:
      observed.revision.kind === "pull_request"
        ? {
            kind: "pull_request",
            baseSha: observed.revision.baseSha,
            headSha: observed.revision.headSha,
          }
        : workflowKind === "issue_validation"
          ? { kind: "commit", headSha: "c".repeat(40) }
          : null,
    testedSourceAuthorization:
      workflowKind === "issue_validation"
        ? {
            kind: "operator",
            activationId: "activation-1",
            issuer: actor.issuer,
            subject: actor.subject,
            authorizedAt: now,
            githubRepositoryId: 1,
            githubWorkItemId: observed.workItem.githubWorkItemId,
            issueRevisionKey: observed.revision.revisionKey,
            headSha: "c".repeat(40),
          }
        : null,
    authorization: epoch,
    authorizationPolicy: policy,
    requests: [
      {
        requestId: "selected",
        workflowKind,
        target: profile.target,
        required: options.requestRequired ?? true,
        profileVersion: profile,
        prompt: { workflowKind, version: prompt },
      },
    ],
    runnerSupport: [
      {
        workflowKind,
        target: profile.target,
        capabilities: profile.target === "web" ? ["ui:web"] : [],
        evidenceDelivery: true,
      },
    ],
  };
  if (options.blockedReproduction)
    planInput.requests.push({
      requestId: "reproduction",
      workflowKind: "issue_validation",
      target: "headless",
      required: true,
      profileVersion: null,
      prompt: null,
    });
  const run = handleReviewRunRequest(
    database,
    { operation: "createReviewRun", input: { planInput, actor } },
    now,
  ) as ReviewRunDetail;
  const execution = createValidationExecutionTemplate({
    runId: run.id,
    plan: run.plan,
    planDigest: run.planDigest,
    requestId: "selected",
    jobActivation: 1,
    frozenPrompt: present(
      getReviewRunPromptEnvelope(database, {
        repositoryId: managed.id,
        reviewRunId: run.id,
        requestId: "selected",
      }),
    ),
  });
  const jobId = "validation-job-1";
  database.exec("BEGIN IMMEDIATE");
  try {
    insertRow(database, "jobs", {
      id: jobId,
      work_item_id: run.workItemId,
      job_kind: kind === "pull_request" ? "pull_request_review" : "issue_triage",
      semantic_key: jobId,
      concurrency_key: jobId,
      status: "queued",
      execution_json: canonicalJson(execution),
      resource_revision: run.revisionKey,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
      request_epoch_id: run.requestEpochId,
      execution_digest: sha256(canonicalJson(execution)),
      required_capabilities_digest: sha256("[]"),
    });
    createJobAdmissionInTransaction(database, jobId, now);
    if (options.associate !== false) {
      associateReviewRunJobInTransaction(
        database,
        { repositoryId: managed.id, reviewRunId: run.id, requestId: "selected", jobId, actor },
        now,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  insertRow(database, "workers", {
    id: "worker-1",
    node_id: "node-1",
    instance_id: "instance-1",
    display_name: "Validation Worker",
    version: "1",
    protocol_version: "1",
    max_slots: 2,
    capabilities_json: "[]",
    capabilities_digest: sha256("[]"),
    status: "online",
    registered_at: now,
    last_seen_at: now,
    updated_at: now,
  });
  const context = beginAttempt(database, jobId);
  return { database, execution, context, run, profile, legacyJobId };
}

function beginAttempt(database: DatabaseSync, jobId: string): ReviewCompletionJobContext {
  const attemptId = `attempt-${jobId}`;
  database.exec("BEGIN IMMEDIATE");
  try {
    // Evidence tests begin with an admitted synthetic Job; they do not exercise Worker
    // registration or scheduler readiness. Keep the exact episode and ownership guards.
    const admitted = database
      .prepare(`UPDATE job_admission SET state = 'admitted', admitted_at = ?
      WHERE job_id = ? AND state = 'pending' AND attempt_base = 0 AND ownership_state = 'resolved'`)
      .run(now, jobId);
    expect(admitted.changes).toBe(1);
    const leased = database
      .prepare(
        "UPDATE jobs SET status = 'leased', current_run_attempt_id = ?, attempt_count = 1, lease_generation = 1 WHERE id = ? AND status = 'queued' AND attempt_count = 0",
      )
      .run(attemptId, jobId);
    expect(leased.changes).toBe(1);
    insertRow(database, "run_attempts", {
      id: attemptId,
      job_id: jobId,
      attempt_number: 1,
      worker_id: "worker-1",
      worker_node_id: "node-1",
      worker_instance_id: "instance-1",
      status: "running",
      lease_token_hash: sha256("lease-token".repeat(4)),
      lease_generation: 1,
      lease_expires_at: later,
      execution_deadline_at: later,
      no_progress_timeout_ms: 30_000,
      no_progress_deadline_at: later,
      last_heartbeat_at: now,
      phase: "validation",
      started_at: now,
    });
    database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return database
    .prepare(`SELECT job.id AS jobId, job.current_run_attempt_id AS runAttemptId, job.job_kind AS jobKind,
    job.work_item_id AS workItemId, item.resource_kind AS workItemResourceKind, job.resource_revision AS resourceRevision,
    revision.id AS revisionId, revision.resource_kind AS revisionResourceKind, revision.base_sha AS revisionBaseSha,
    revision.head_sha AS revisionHeadSha, job.execution_json AS executionJson, job.execution_digest AS executionDigest
    FROM jobs AS job JOIN work_items AS item ON item.id = job.work_item_id
    JOIN work_item_revisions AS revision ON revision.work_item_id = job.work_item_id AND revision.revision_key = job.resource_revision
    WHERE job.id = ?`)
    .get(jobId) as unknown as ReviewCompletionJobContext;
}

function evidenceFixture(bytes = Buffer.from("Evidence log content.")) {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "evidence-assets-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  const options = {
    evidenceDirectory: directory,
    globalQuotaBytes: 1024 * 1024 * 1024,
    globalAssetLimit: 1024,
    retentionMs: 60_000,
    incompleteUploadTtlMs: 60_000,
  } satisfies EvidenceStorageOptions;
  const lease: LeaseIdentity = {
    jobId: f.context.jobId,
    runAttemptId: f.context.runAttemptId,
    workerNodeId: "node-1",
    workerInstanceId: "instance-1",
    leaseGeneration: 1,
    leaseToken: "lease-token".repeat(4),
  };
  const scope = {
    repositoryId: f.run.repositoryId,
    runId: f.run.id,
    jobId: lease.jobId,
    runAttemptId: lease.runAttemptId,
  };
  const metadata = {
    kind: "log" as const,
    mediaType: "text/plain" as const,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    capturedAt: now,
    checkId: `${f.profile.id}:compile`,
  };
  function request<K extends EvidenceAssetOperation>(
    operation: K,
    input: EvidenceAssetOperationMap[K]["input"],
    clock = now,
  ): EvidenceAssetOperationMap[K]["output"] {
    return handleEvidenceAssetRequest(
      f.database,
      { operation, input } as EvidenceAssetRequest,
      clock,
      options,
    ) as EvidenceAssetOperationMap[K]["output"];
  }
  function begin(clientAssetId = "client-asset-1") {
    return request("beginEvidenceUpload", { lease, clientAssetId, metadata });
  }
  function append(assetId: string, content = bytes, offset = 0) {
    return request("appendEvidenceChunk", {
      lease,
      assetId,
      offset,
      base64: content.toString("base64"),
      chunkSha256: sha256(content),
    });
  }
  function complete(clientAssetId = "client-asset-1"): EvidenceAssetManifest {
    const upload = begin(clientAssetId);
    append(upload.assetId);
    return request("finalizeEvidenceUpload", { lease, assetId: upload.assetId });
  }
  return {
    ...f,
    bytes,
    directory,
    options,
    lease,
    scope,
    metadata,
    request,
    begin,
    append,
    complete,
  };
}

const storageDescribe = describe.skipIf(process.platform !== "linux");
storageDescribe("durable evidence assets", () => {
  it("uploads, finalizes and reads only the exact scoped bytes", () => {
    const f = evidenceFixture();
    const upload = f.begin();
    expect(f.request("getEvidenceAsset", { ...f.scope, assetId: upload.assetId })).toBeNull();
    expect(() =>
      f.request("readEvidenceAssetChunk", { ...f.scope, assetId: upload.assetId, offset: 0 }),
    ).toThrow(/not found/u);
    f.append(upload.assetId);
    const result = f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId });
    expect(result.metadata.sha256).toBe(f.metadata.sha256);
    expect(result.repositoryId).toBe(f.scope.repositoryId);
    expect(JSON.stringify(result)).not.toContain(f.directory);
    const read = f.request("readEvidenceAssetChunk", {
      ...f.scope,
      assetId: result.id,
      offset: 2,
      maximumBytes: 5,
    });
    expect(Buffer.from(read.base64, "base64")).toEqual(f.bytes.subarray(2, 7));
    expect(read.eof).toBe(false);
    expect(
      f.request("getEvidenceAsset", { ...f.scope, repositoryId: "wrong-repo", assetId: result.id }),
    ).toBeNull();
    expect(
      f.request("listEvidenceAssets", { ...f.scope, runAttemptId: "wrong-attempt" }).items,
    ).toEqual([]);
  });
  it("accepts idempotent begin, chunk and finalization only for identical bytes", () => {
    const f = evidenceFixture();
    const first = f.begin();
    expect(f.begin()).toEqual(first);
    f.append(first.assetId);
    expect(f.begin().offset).toBe(f.bytes.length);
    expect(f.append(first.assetId).offset).toBe(f.bytes.length);
    const result = f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: first.assetId });
    expect(f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: first.assetId })).toEqual(
      result,
    );
    expect(f.append(first.assetId).state).toBe("finalized");
    expect(() =>
      f.request("beginEvidenceUpload", {
        lease: f.lease,
        clientAssetId: "client-asset-1",
        metadata: { ...f.metadata, sha256: "a".repeat(64) },
      }),
    ).toThrow(/different evidence/u);
    expect(() => f.append(first.assetId, Buffer.from("Different evidence."))).toThrow(/Replayed/u);
  });
  it("enforces sequential offsets, decoded chunk bounds, hashes and expected size", () => {
    const f = evidenceFixture();
    const upload = f.begin();
    expect(() => f.append(upload.assetId, f.bytes, 1)).toThrow(/committed offset/u);
    expect(() =>
      f.request("appendEvidenceChunk", {
        lease: f.lease,
        assetId: upload.assetId,
        offset: 0,
        base64: f.bytes.toString("base64"),
        chunkSha256: "0".repeat(64),
      }),
    ).toThrow(/digest/u);
    expect(() => f.append(upload.assetId, Buffer.alloc(524289))).toThrow(/invalid/u);
    expect(() => f.append(upload.assetId, Buffer.alloc(f.bytes.length + 1))).toThrow(
      /committed offset/u,
    );
    expect(() =>
      f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId }),
    ).toThrow(/incomplete/u);
  });
  it("streams multiple full chunks and detects content changes during downloads", () => {
    const f = evidenceFixture(Buffer.alloc(524288 + 71, 19));
    const upload = f.begin();
    f.append(upload.assetId, f.bytes.subarray(0, 524288));
    f.append(upload.assetId, f.bytes.subarray(524288), 524288);
    const result = f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId });
    expect(
      f.request("readEvidenceAssetChunk", {
        ...f.scope,
        assetId: result.id,
        offset: 524285,
        maximumBytes: 10,
      }).base64,
    ).toBe(f.bytes.subarray(524285, 524295).toString("base64"));
    writeFileSync(join(f.directory, `${result.id}.asset`), Buffer.alloc(f.bytes.length, 20));
    expect(() =>
      f.request("readEvidenceAssetChunk", { ...f.scope, assetId: result.id, offset: 0 }),
    ).toThrow(/integrity/u);
  });
  it("rejects a final whole-file digest mismatch", () => {
    const f = evidenceFixture();
    f.metadata.sha256 = "0".repeat(64);
    const upload = f.begin();
    f.append(upload.assetId);
    expect(() =>
      f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId }),
    ).toThrow(/integrity/u);
    expect(f.request("listEvidenceAssets", f.scope).items).toEqual([]);
  });
  it("recovers bytes written before a database rollback", () => {
    const f = evidenceFixture();
    const upload = f.begin();
    f.database.exec(
      "CREATE TRIGGER reject_chunk BEFORE INSERT ON evidence_asset_chunks BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    expect(() => f.append(upload.assetId)).toThrow();
    expect(readFileSync(join(f.directory, `${upload.assetId}.upload`))).toEqual(f.bytes);
    f.database.exec("DROP TRIGGER reject_chunk");
    expect(f.begin().offset).toBe(0);
    f.append(upload.assetId);
    expect(
      f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId }).state,
    ).toBe("finalized");
  });
  it("recovers a rename completed before the final database commit", () => {
    const f = evidenceFixture();
    const upload = f.begin();
    f.append(upload.assetId);
    f.database.exec(
      "CREATE TRIGGER reject_finalize BEFORE UPDATE ON evidence_assets WHEN NEW.state = 'finalized' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    expect(() =>
      f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId }),
    ).toThrow();
    expect(readdirSync(f.directory)).toContain(`${upload.assetId}.asset`);
    f.database.exec("DROP TRIGGER reject_finalize");
    expect(
      f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId }).state,
    ).toBe("finalized");
  });
  it.each([
    "jobId",
    "runAttemptId",
    "workerNodeId",
    "workerInstanceId",
    "leaseToken",
    "leaseGeneration",
  ] as const)("rejects a forged lease field %s", (key) => {
    const f = evidenceFixture();
    const lease = {
      ...f.lease,
      [key]: key === "leaseGeneration" ? 2 : "invalid-identity".repeat(3),
    };
    expect(() =>
      f.request("beginEvidenceUpload", { lease, clientAssetId: "forged", metadata: f.metadata }),
    ).toThrow(/lease/u);
  });
  it.each([
    "UPDATE jobs SET status = 'cancel_requested'",
    "UPDATE jobs SET cancellation_requested_at = '2026-09-07T00:00:00.000Z'",
    "UPDATE jobs SET current_run_attempt_id = NULL",
    "UPDATE jobs SET lease_generation = 2",
    "UPDATE run_attempts SET status = 'expired'",
    "UPDATE run_attempts SET lease_expires_at = '2026-09-07T00:00:00.000Z'",
    "UPDATE run_attempts SET no_progress_deadline_at = '2026-09-07T00:00:00.000Z'",
    "UPDATE run_attempts SET execution_deadline_at = '2026-09-07T00:00:00.000Z'",
    "UPDATE workers SET superseded_at = '2026-09-07T00:00:00.000Z'",
    "UPDATE workers SET status = 'disabled'",
  ])("rejects stale execution state: %s", (sql) => {
    const f = evidenceFixture();
    const upload = f.begin();
    const legacyBefore = f.database.prepare("SELECT * FROM jobs WHERE id = ?").get(f.legacyJobId);
    const targetId = sql.startsWith("UPDATE jobs ")
      ? f.lease.jobId
      : sql.startsWith("UPDATE run_attempts ")
        ? f.lease.runAttemptId
        : "worker-1";
    const mutation = f.database.prepare(`${sql} WHERE id = ?`).run(targetId);
    expect(mutation.changes).toBe(1);
    expect(f.database.prepare("SELECT * FROM jobs WHERE id = ?").get(f.legacyJobId)).toEqual(
      legacyBefore,
    );
    expect(() => f.append(upload.assetId)).toThrow(/lease/u);
    expect(() =>
      f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId }),
    ).toThrow(/lease/u);
  });
  it("does not trust worker-supplied repository or check ownership", () => {
    const f = evidenceFixture();
    expect(() =>
      f.request("beginEvidenceUpload", {
        lease: f.lease,
        clientAssetId: "bad-check",
        metadata: { ...f.metadata, checkId: "other:compile" },
      }),
    ).toThrow(/frozen profile/u);
    expect(() =>
      f.request("beginEvidenceUpload", {
        lease: f.lease,
        clientAssetId: "future",
        metadata: { ...f.metadata, capturedAt: later },
      }),
    ).toThrow(/future/u);
    const extra = {
      lease: f.lease,
      clientAssetId: "bad-owner",
      metadata: { ...f.metadata, repositoryId: "other" },
    };
    expect(() => f.request("beginEvidenceUpload", extra)).toThrow(/invalid/u);
  });
  it.each(["symlink", "hardlink", "size", "missing", "replacement", "permissions"])(
    "fails closed for file tampering: %s",
    (kind) => {
      const f = evidenceFixture();
      const result = f.complete();
      const path = join(f.directory, `${result.id}.asset`);
      if (kind === "symlink") {
        renameSync(path, `${path}.outside`);
        symlinkSync(`${path}.outside`, path);
      }
      if (kind === "hardlink") linkSync(path, `${path}.linked`);
      if (kind === "size") truncateSync(path, 1);
      if (kind === "missing") unlinkSync(path);
      if (kind === "replacement") {
        renameSync(path, `${path}.old`);
        writeFileSync(path, f.bytes, { mode: 0o600 });
      }
      if (kind === "permissions") chmodSync(path, 0o644);
      expect(() =>
        f.request("readEvidenceAssetChunk", { ...f.scope, assetId: result.id, offset: 0 }),
      ).toThrow(/integrity/u);
    },
  );
  it("rejects nonprivate, symlinked and foreign database directories without path leakage", () => {
    const f = evidenceFixture();
    chmodSync(f.directory, 0o755);
    expect(() => f.begin()).toThrow(/integrity/u);
    chmodSync(f.directory, 0o700);
    f.begin();
    const foreign = fixture();
    expect(() =>
      handleEvidenceAssetRequest(
        foreign.database,
        { operation: "listEvidenceAssets", input: f.scope },
        now,
        f.options,
      ),
    ).toThrow(/integrity/u);
    const alias = `${f.directory}-link`;
    symlinkSync(f.directory, alias);
    temporaryDirectories.push(alias);
    expect(() =>
      handleEvidenceAssetRequest(
        f.database,
        { operation: "listEvidenceAssets", input: f.scope },
        now,
        { ...f.options, evidenceDirectory: alias },
      ),
    ).toThrow(/integrity/u);
  });
  it("enforces explicit global byte and file quotas before creating files", () => {
    const f = evidenceFixture();
    f.options.globalQuotaBytes = f.bytes.length;
    f.begin();
    expect(() => f.begin("another")).toThrow(/quota/u);
    f.options.globalQuotaBytes = 100000;
    f.options.globalAssetLimit = 1;
    expect(() => f.begin("another")).toThrow(/quota/u);
    expect(readdirSync(f.directory).filter((name) => name.endsWith(".upload"))).toHaveLength(1);
  });
  it("checks finalized evidence scope and check attribution for terminal results", () => {
    const f = evidenceFixture();
    const upload = f.begin();
    const scope = {
      ...f.scope,
      requestId: "selected",
      profileVersionId: f.profile.id,
      evidenceIds: [upload.assetId],
      checkId: f.metadata.checkId,
    };
    expect(finalizedEvidenceReferences(f.database, scope, f.options)).toBe(false);
    f.append(upload.assetId);
    f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId });
    expect(finalizedEvidenceReferences(f.database, scope, f.options)).toBe(true);
    for (const key of [
      "repositoryId",
      "runId",
      "requestId",
      "jobId",
      "runAttemptId",
      "profileVersionId",
      "checkId",
    ] as const)
      expect(finalizedEvidenceReferences(f.database, { ...scope, [key]: "other" }, f.options)).toBe(
        false,
      );
    expect(
      finalizedEvidenceReferences(
        f.database,
        { ...scope, evidenceIds: [upload.assetId, upload.assetId] },
        f.options,
      ),
    ).toBe(false);
    writeFileSync(join(f.directory, `${upload.assetId}.asset`), Buffer.alloc(f.bytes.length));
    expect(finalizedEvidenceReferences(f.database, scope, f.options)).toBe(false);
    writeFileSync(join(f.directory, `${upload.assetId}.asset`), f.bytes);
    expect(finalizedEvidenceReferences(f.database, scope, f.options)).toBe(true);
    unlinkSync(join(f.directory, `${upload.assetId}.asset`));
    expect(finalizedEvidenceReferences(f.database, scope, f.options)).toBe(false);
  });
  it("retires expired bytes while retaining immutable manifests and hashes", () => {
    const f = evidenceFixture();
    const result = f.complete();
    expect(f.request("cleanupEvidenceAssets", {}, later).retired).toBe(0);
    f.database.exec(
      "UPDATE jobs SET status = 'cancelled'; UPDATE run_attempts SET status = 'cancelled'",
    );
    expect(f.request("cleanupEvidenceAssets", {}, later).retired).toBe(1);
    const retired = f.request("getEvidenceAsset", { ...f.scope, assetId: result.id });
    expect(retired?.state).toBe("retired");
    expect(retired?.metadata.sha256).toBe(result.metadata.sha256);
    expect(() =>
      f.request("readEvidenceAssetChunk", { ...f.scope, assetId: result.id, offset: 0 }),
    ).toThrow(/integrity/u);
    expect(() =>
      f.database
        .prepare("UPDATE evidence_assets SET sha256 = ? WHERE id = ?")
        .run("a".repeat(64), result.id),
    ).toThrow(/immutable/u);
    expect(() =>
      f.database.prepare("DELETE FROM evidence_assets WHERE id = ?").run(result.id),
    ).toThrow(/immutable/u);
  });
  it("cleans expired partial uploads within a bounded batch", () => {
    const f = evidenceFixture();
    const first = f.begin();
    f.begin("second");
    expect(f.request("cleanupEvidenceAssets", { limit: 1 }, later).retired).toBe(1);
    expect(f.request("listEvidenceAssets", f.scope).items).toEqual([]);
    expect(f.request("cleanupEvidenceAssets", { limit: 1 }, later).retired).toBe(1);
    expect(readdirSync(f.directory)).not.toContain(`${first.assetId}.upload`);
  });
});

storageDescribe("evidence persistence boundaries", () => {
  it("accepts 34 finalized references for one check and rejects 35", () => {
    const f = evidenceFixture(Buffer.from("small finalized evidence"));
    const evidenceIds = Array.from(
      { length: 35 },
      (_, index) => f.complete(`check-asset-${index}`).id,
    );
    const scope = {
      ...f.scope,
      requestId: "selected",
      profileVersionId: f.profile.id,
      checkId: f.metadata.checkId,
      evidenceIds: evidenceIds.slice(0, 34),
    };
    expect(finalizedEvidenceReferences(f.database, scope, f.options)).toBe(true);
    expect(finalizedEvidenceReferences(f.database, { ...scope, evidenceIds }, f.options)).toBe(
      false,
    );
  });
  it("enforces the total reserved byte limit per attempt", () => {
    const f = evidenceFixture();
    f.metadata.sizeBytes = 64 * 1024 * 1024;
    f.begin("first-large");
    f.begin("second-large");
    expect(() => f.begin("third-large")).toThrow(/quota/u);
    expect(readdirSync(f.directory).filter((name) => name.endsWith(".upload"))).toHaveLength(2);
  });
  it("enforces the asset count limit per attempt", () => {
    const f = evidenceFixture(Buffer.from("x"));
    for (let index = 0; index < 256; index++) f.begin(`asset-${index}`);
    expect(() => f.begin("asset-257")).toThrow(/quota/u);
  });
  it("removes orphaned files after the configured upload TTL", () => {
    const f = evidenceFixture();
    f.begin();
    const orphan = join(f.directory, "12345678-1234-1234-1234-123456789abc.upload");
    writeFileSync(orphan, Buffer.from("orphan"), { mode: 0o600 });
    utimesSync(orphan, new Date(now), new Date(now));
    expect(f.request("cleanupEvidenceAssets", { limit: 256 }, later).orphanFilesRemoved).toBe(1);
    expect(readdirSync(f.directory)).not.toContain("12345678-1234-1234-1234-123456789abc.upload");
  });
  it("protects committed chunks, owner identity and audit records from REPLACE", () => {
    const f = evidenceFixture();
    const asset = f.complete();
    expect(() =>
      f.database.exec(
        "INSERT OR REPLACE INTO evidence_storage_identity VALUES(1, 'ffffffffffffffffffffffffffffffff')",
      ),
    ).toThrow(/immutable/u);
    expect(() =>
      f.database
        .prepare(
          "INSERT OR REPLACE INTO evidence_asset_chunks SELECT * FROM evidence_asset_chunks WHERE asset_id = ?",
        )
        .run(asset.id),
    ).toThrow(/consecutive/u);
    expect(() =>
      f.database
        .prepare("UPDATE evidence_asset_chunks SET sha256 = ? WHERE asset_id = ?")
        .run("a".repeat(64), asset.id),
    ).toThrow(/immutable/u);
    expect(() =>
      f.database
        .prepare(
          "INSERT OR REPLACE INTO evidence_asset_audit SELECT * FROM evidence_asset_audit WHERE asset_id = ?",
        )
        .run(asset.id),
    ).toThrow(/immutable/u);
  });
  it("guards validation result inserts against unavailable and cross-check references in SQL", () => {
    const f = evidenceFixture();
    const asset = f.complete();
    const probe = evidenceReferenceGuardProbe(f.database);
    function insertReference(
      evidenceId: string,
      checkId = f.metadata.checkId,
      overrides: Record<string, SQLInputValue> = {},
    ) {
      probe({
        id: "result-1",
        run_attempt_id: f.scope.runAttemptId,
        job_id: f.scope.jobId,
        repository_id: f.scope.repositoryId,
        review_run_id: f.scope.runId,
        request_id: "selected",
        profile_version_id: f.profile.id,
        resource_revision: f.run.revisionKey,
        plan_digest: f.run.planDigest,
        target: "headless",
        evidence_complete: 0,
        result_json: JSON.stringify({
          report: { checks: [{ id: checkId, kind: "build", evidenceIds: [evidenceId] }] },
        }),
        ...overrides,
      });
    }
    expect(() => insertReference("missing")).toThrow(/evidence reference/u);
    expect(() => insertReference(asset.id, "other:compile")).toThrow(/evidence reference/u);
    expect(() =>
      insertReference(asset.id, f.metadata.checkId, { run_attempt_id: "old-attempt" }),
    ).toThrow(/evidence reference/u);
    // This partial payload passes only the reference guard; the real result insert is rejected.
    expect(() => insertReference(asset.id)).not.toThrow();
    f.database.exec(
      "UPDATE jobs SET status = 'cancelled'; UPDATE run_attempts SET status = 'cancelled'",
    );
    f.request("cleanupEvidenceAssets", {}, later);
    expect(() => insertReference(asset.id)).toThrow(/evidence reference/u);
  });
  it.each([{ checks: [] }, { checks: [{ id: "check:ui", kind: "ui", evidenceIds: [] }] }])(
    "does not allow complete UI evidence without durable UI assets",
    ({ checks }) => {
      const f = evidenceFixture();
      const probe = evidenceReferenceGuardProbe(f.database);
      expect(() =>
        probe({
          id: "result-empty",
          target: "web",
          evidence_complete: 1,
          result_json: JSON.stringify({ report: { checks } }),
        }),
      ).toThrow(/evidence reference/u);
    },
  );
});

storageDescribe("evidence cleanup recovery", () => {
  it("does not let retained active assets starve expired uploads", () => {
    const f = evidenceFixture();
    f.complete();
    const incomplete = f.request(
      "beginEvidenceUpload",
      { lease: f.lease, clientAssetId: "later-partial", metadata: f.metadata },
      "2026-09-07T00:00:00.001Z",
    );
    expect(f.request("cleanupEvidenceAssets", { limit: 1 }, later).retired).toBe(1);
    expect(
      f.database.prepare("SELECT state FROM evidence_assets WHERE id = ?").get(incomplete.assetId),
    ).toMatchObject({ state: "retired" });
  });
  it("continues bounded orphan scans past retained files across cleanup calls", () => {
    const f = evidenceFixture();
    let expected = 0;
    for (let index = 0; index < 8; index++) {
      f.begin(`live-${index}`);
      const id = `12345678-1234-1234-1234-${String(index).padStart(12, "0")}`;
      const path = join(f.directory, `${id}.upload`);
      writeFileSync(path, "orphan", { mode: 0o600 });
      utimesSync(path, new Date("2026-09-06T00:00:00.000Z"), new Date("2026-09-06T00:00:00.000Z"));
      expected++;
    }
    let removed = 0;
    for (let call = 0; call < 50; call++)
      removed += f.request("cleanupEvidenceAssets", { limit: 1 }).orphanFilesRemoved;
    expect(removed).toBe(expected);
  });
  it("recovers a published empty identity marker and durably creates nested storage roots", () => {
    const f = evidenceFixture();
    const key = (
      f.database.prepare("SELECT storage_key FROM evidence_storage_identity").get() as {
        storage_key: string;
      }
    ).storage_key;
    writeFileSync(join(f.directory, `.owner-${key}`), "", { mode: 0o600 });
    expect(f.begin().offset).toBe(0);
    const nested = evidenceFixture();
    nested.options.evidenceDirectory = join(nested.directory, "new", "nested");
    expect(nested.begin().offset).toBe(0);
    expect(
      readdirSync(nested.options.evidenceDirectory).some((name) => name.startsWith(".owner-")),
    ).toBe(true);
  });
});

storageDescribe("owner evidence preflight hooks", () => {
  async function prepared(f: ReturnType<typeof evidenceFixture>, recoveredRename = false) {
    const upload = f.begin();
    f.append(upload.assetId);
    if (recoveredRename)
      renameSync(
        join(f.directory, `${upload.assetId}.upload`),
        join(f.directory, `${upload.assetId}.asset`),
      );
    const input = { lease: f.lease, assetId: upload.assetId };
    const candidate = prepareEvidenceFinalizationCandidate(f.database, input, now);
    expect(f.database.isTransaction).toBe(false);
    const root = await inspectEvidenceRoot(f.directory, readEvidenceStorageKey(f.database));
    const expectedFile = await inspectEvidenceFile(root, {
      assetId: candidate.asset.id,
      state: candidate.asset.state,
      ...candidate.fileBinding,
    });
    const snapshot: AssetVerificationSnapshot = {
      storage: { storageKey: root.storageKey, device: root.device, inode: root.inode },
      asset: candidate.asset,
      manifestDigest: candidate.manifestDigest,
      chunks: candidate.chunks,
      expectedFile,
    };
    const { attestation } = await verifyEvidenceAsset(root, snapshot, new AbortController().signal);
    return { input, candidate, snapshot, attestation };
  }
  it.each([false, true])("commits verified bytes with rename recovery=%s", async (recovery) => {
    const f = evidenceFixture();
    const preflight = await prepared(f, recovery);
    const result = commitVerifiedEvidenceFinalization(
      f.database,
      preflight.input,
      preflight.snapshot,
      preflight.attestation,
      now,
      f.options,
    );
    expect(result.state).toBe("finalized");
    expect(f.database.isTransaction).toBe(false);
    const current = readEvidenceVerificationCandidate(f.database, {
      ...f.scope,
      assetId: result.id,
      requestId: "selected",
      profileVersionId: f.profile.id,
      checkId: f.metadata.checkId,
    });
    expect(current?.asset.state).toBe("finalized");
    expect(current?.storageKey).toBe(preflight.candidate.storageKey);
    expect(current?.metadataToken.fingerprint).not.toBe(
      preflight.candidate.metadataToken.fingerprint,
    );
    expect(
      readEvidenceVerificationCandidate(f.database, {
        ...f.scope,
        assetId: result.id,
        requestId: "wrong",
        profileVersionId: f.profile.id,
        checkId: f.metadata.checkId,
      }),
    ).toBeNull();
  });
  it("rechecks cancellation after asynchronous verification", async () => {
    const f = evidenceFixture();
    const preflight = await prepared(f);
    const legacyBefore = f.database.prepare("SELECT * FROM jobs WHERE id = ?").get(f.legacyJobId);
    const cancellation = f.database
      .prepare("UPDATE jobs SET status = 'cancel_requested' WHERE id = ?")
      .run(f.lease.jobId);
    expect(cancellation.changes).toBe(1);
    expect(f.database.prepare("SELECT * FROM jobs WHERE id = ?").get(f.legacyJobId)).toEqual(
      legacyBefore,
    );
    expect(() =>
      commitVerifiedEvidenceFinalization(
        f.database,
        preflight.input,
        preflight.snapshot,
        preflight.attestation,
        now,
        f.options,
      ),
    ).toThrow(/lease/u);
    expect(readdirSync(f.directory)).toContain(`${preflight.input.assetId}.upload`);
  });
  it("rejects observable identity changes and mismatched attestations before committing", async () => {
    const f = evidenceFixture();
    const preflight = await prepared(f);
    expect(() =>
      commitVerifiedEvidenceFinalization(
        f.database,
        preflight.input,
        preflight.snapshot,
        { ...preflight.attestation, snapshotDigest: "f".repeat(64) },
        now,
        f.options,
      ),
    ).toThrow(/attestation/u);
    writeFileSync(
      join(f.directory, `${preflight.input.assetId}.upload`),
      Buffer.alloc(f.bytes.length),
    );
    // Identity admission is not a byte lock; same-tick ambiguity has separate cache tests.
    utimesSync(join(f.directory, `${preflight.input.assetId}.upload`), new Date(0), new Date(0));
    expect(() =>
      commitVerifiedEvidenceFinalization(
        f.database,
        preflight.input,
        preflight.snapshot,
        preflight.attestation,
        now,
        f.options,
      ),
    ).toThrow(/changed/u);
    expect(f.request("listEvidenceAssets", f.scope).items).toEqual([]);
  });
  it("does not admit an upload retired during verification", async () => {
    const f = evidenceFixture();
    const preflight = await prepared(f);
    f.request("cleanupEvidenceAssets", {}, "2026-09-07T00:02:00.000Z");
    expect(() =>
      commitVerifiedEvidenceFinalization(
        f.database,
        preflight.input,
        preflight.snapshot,
        preflight.attestation,
        "2026-09-07T00:02:00.000Z",
        f.options,
      ),
    ).toThrow(/not available/u);
  });
});

storageDescribe("evidence read-only directory opens", () => {
  function clearFileOperations() {
    vi.mocked(fsyncSync).mockClear();
    vi.mocked(mkdirSync).mockClear();
    vi.mocked(openSync).mockClear();
  }
  function expectReadOnlyOperations() {
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(openSync)
        .mock.calls.every(
          (call) =>
            typeof call[1] === "number" &&
            (call[1] &
              (constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_RDWR)) ===
              0,
        ),
    ).toBe(true);
  }
  it("does not initialize an empty or foreign root during reads", () => {
    const f = evidenceFixture();
    clearFileOperations();
    expect(() => f.request("listEvidenceAssets", f.scope)).toThrow(/integrity/u);
    expect(readdirSync(f.directory)).toEqual([]);
    expectReadOnlyOperations();
    writeFileSync(join(f.directory, `.owner-${"f".repeat(32)}`), "", { mode: 0o600 });
    clearFileOperations();
    expect(() => f.request("getEvidenceAsset", { ...f.scope, assetId: "missing" })).toThrow();
    expect(readdirSync(f.directory)).toEqual([`.owner-${"f".repeat(32)}`]);
    expectReadOnlyOperations();
  });
  it("initializes once and serves an empty initialized root without durability writes", () => {
    const f = evidenceFixture();
    clearFileOperations();
    initializeEvidenceStorage(f.database, f.options);
    expect(vi.mocked(fsyncSync).mock.calls.length).toBeGreaterThan(0);
    clearFileOperations();
    initializeEvidenceStorage(f.database, f.options);
    expect(f.request("listEvidenceAssets", f.scope).items).toEqual([]);
    expect(f.request("getEvidenceAsset", { ...f.scope, assetId: "missing" })).toBeNull();
    expectReadOnlyOperations();
  });
  it("keeps repeated manifest, content and reference reads free of create and fsync", () => {
    const f = evidenceFixture();
    const asset = f.complete();
    clearFileOperations();
    for (let index = 0; index < 3; index++) {
      expect(f.request("getEvidenceAsset", { ...f.scope, assetId: asset.id })?.id).toBe(asset.id);
      expect(f.request("listEvidenceAssets", f.scope).items).toHaveLength(1);
      expect(
        f.request("readEvidenceAssetChunk", { ...f.scope, assetId: asset.id, offset: 0 }).eof,
      ).toBe(true);
      expect(
        finalizedEvidenceReferences(
          f.database,
          {
            ...f.scope,
            requestId: "selected",
            profileVersionId: f.profile.id,
            checkId: f.metadata.checkId,
            evidenceIds: [asset.id],
          },
          f.options,
        ),
      ).toBe(true);
    }
    expectReadOnlyOperations();
  });
  it("retains append and finalization recovery barriers without resyncing ancestors", () => {
    const f = evidenceFixture();
    const upload = f.begin();
    clearFileOperations();
    f.append(upload.assetId);
    expect(vi.mocked(fsyncSync).mock.calls).toHaveLength(1);
    f.database.exec(
      "CREATE TRIGGER reject_finalized BEFORE UPDATE ON evidence_assets WHEN NEW.state = 'finalized' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    clearFileOperations();
    expect(() =>
      f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId }),
    ).toThrow();
    expect(vi.mocked(fsyncSync).mock.calls).toHaveLength(1);
    f.database.exec("DROP TRIGGER reject_finalized");
    clearFileOperations();
    expect(
      f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId }).state,
    ).toBe("finalized");
    expect(vi.mocked(fsyncSync).mock.calls).toHaveLength(1);
    clearFileOperations();
    closeEvidenceAssetStorage(f.database);
    initializeEvidenceStorage(f.database, f.options);
    expect(vi.mocked(fsyncSync).mock.calls.length).toBeGreaterThan(1);
  });
});
