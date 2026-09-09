import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setImmediate as immediate } from "node:timers/promises";
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
  EvidenceAssetManifest,
  EvidenceAssetMetadata,
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
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../scheduling/canonical-json.js";
import { createValidationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  closeEvidenceAssetStorage,
  type EvidenceAssetOperation,
  type EvidenceAssetOperationMap,
  type EvidenceAssetRequest,
  type EvidenceStorageOptions,
  handleEvidenceAssetRequest,
  readEvidenceStorageKey,
} from "./evidence-assets.js";
import { inspectEvidenceRoot, probeEvidenceIdentities } from "./evidence-files.js";
import {
  EvidenceVerificationCoordinator,
  type EvidenceVerificationCoordinatorOptions,
  type EvidenceVerifier,
  type PreparedEvidence,
} from "./evidence-verification.js";
import {
  type AssetAttestation,
  type AssetVerificationSnapshot,
  type EvidenceFileIdentity,
  EvidenceVerificationError,
  type EvidenceVerificationRoot,
  type EvidenceVerificationTiming,
  evidenceSnapshotDigest,
  type IdentityAttestation,
  type IdentityProbeSnapshot,
  reusableEvidenceVerification,
  type ScenarioAttestation,
  type ScenarioVerificationSnapshot,
} from "./evidence-verification-protocol.js";
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
import {
  collectValidationCompletionEvidence,
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

const coordinators: EvidenceVerificationCoordinator[] = [];
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

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close()));
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
  uiReproduction?: boolean;
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
  const config = profileConfig(
    options.uiReproduction ? "pr_ui" : workflowKind,
    options.commandRequired,
  );
  if (options.uiReproduction) {
    const ui = present(config.ui);
    if (ui.target !== "web") throw new Error("The reproduction fixture requires a Web profile.");
    ui.evidence.trace = "off";
    const scenario = present(ui.scenarios[0]);
    const step = present(scenario.steps[0]);
    for (const id of ["absent-only", "precondition-only", "unselected"])
      scenario.steps.push({ ...step, id, name: id });
    scenario.steps = ["absent-only", "precondition-only", step.id, "unselected"].map((id) =>
      present(scenario.steps.find((candidate) => candidate.id === id)),
    );
  }
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
    ...(workflowKind === "pr_ui" || options.uiReproduction
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
  if (options.uiReproduction) {
    const predicate = (stepId: string, value = true) => ({
      observation: { kind: "ui_assertion" as const, scenarioId: "settings", stepId },
      equals: { type: "boolean" as const, value },
    });
    planInput.reproduction = {
      schemaVersion: "IssueReproductionRequestV1",
      claim: "The settings control is present.",
      cases: [
        {
          id: "settings-case",
          profileId: profile.profileId,
          expectedProfileVersionId: profile.id,
          context: "Observe the selected settings assertions.",
          preconditions: [
            { kind: "observation_equals", predicate: predicate("precondition-only") },
          ],
          presentWhen: { allOf: [predicate("visible")] },
          absentWhen: { allOf: [predicate("visible", false), predicate("absent-only")] },
        },
      ],
    };
  }
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

function evidenceFixture(
  bytes = Buffer.from("Evidence log content."),
  fixtureOptions: FixtureOptions = {},
) {
  const f = fixture(fixtureOptions);
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

function resultFor(f: ReturnType<typeof fixture>): ValidationJobResultV1 {
  const checks: ValidationJobResultV1["report"]["checks"] = [];
  const diagnostics: ValidationJobResultV1["execution"]["diagnostics"] = [];
  for (const phase of ["setup", "build", "test", "launch", "cleanup"] as const) {
    for (const step of f.profile.config[phase]) {
      const id = `${f.profile.id}:${step.id}`;
      if (phase !== "launch")
        checks.push({
          id,
          name: step.name,
          kind: phase === "build" || phase === "test" ? phase : "static",
          required: step.required,
          outcome: "passed",
          summary: "The command completed.",
          expected: null,
          actual: null,
          evidenceIds: [],
          source: "runner",
        });
      diagnostics.push({
        stepId: id,
        phase,
        outcome: "passed",
        exitCode: phase === "launch" ? null : 0,
        summary: "The command completed.",
      });
    }
  }
  for (const scenario of f.profile.config.ui?.scenarios ?? [])
    checks.push({
      id: `${f.profile.id}:${scenario.id}`,
      name: scenario.name,
      kind: "ui",
      required: scenario.required,
      outcome: "passed",
      summary: "The scenario completed.",
      expected: null,
      actual: null,
      evidenceIds: [],
      source: "runner",
    });
  const result = {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      workItemKind: "pull_request",
      source: "worker",
      summary: "Configured validation completed.",
      sourceState: "original",
      checks,
    },
    execution: {
      blockers: [],
      diagnostics: [
        ...diagnostics,
        ...(f.profile.config.ui?.scenarios ?? []).map((scenario) => ({
          stepId: `${f.profile.id}:${scenario.id}`,
          phase: "ui" as const,
          outcome: "passed" as const,
          exitCode: null,
          summary: "The UI scenario completed.",
        })),
      ],
      cleanupState: "completed",
    },
    modelReview: { state: "not_requested" },
  } satisfies ValidationJobResultV1;
  return f.profile.workflowKind === "issue_validation" || f.profile.workflowKind === "issue_triage"
    ? {
        ...result,
        report: { ...result.report, workItemKind: "issue", reproductionConclusion: "inconclusive" },
      }
    : result;
}

function submission(f: ReturnType<typeof evidenceFixture>, asset: EvidenceAssetManifest) {
  const result = resultFor(f);
  present(result.report.checks.find((check) => check.id === asset.metadata.checkId)).evidenceIds = [
    asset.id,
  ];
  const digest = sha256(canonicalJson(result));
  const collection = collectValidationCompletionEvidence(f.database, f.context, digest, result);
  return { result, digest, scope: present(collection.scopes[0]) };
}

function barrier() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    arrived: arrived.promise,
    release: () => released.resolve(),
    wait: async () => {
      arrived.resolve();
      await released.promise;
    },
  };
}

type Barrier = ReturnType<typeof barrier>;
class FakeVerifier implements EvidenceVerifier {
  readonly assetCache = new Map<string, AssetAttestation>();
  readonly scenarioCache = new Map<string, ScenarioAttestation>();
  readonly assets: AssetVerificationSnapshot[] = [];
  readonly scenarios: ScenarioVerificationSnapshot[] = [];
  probeCalls = 0;
  closeCalls = 0;
  reusable = true;
  assetBarrier: Barrier | undefined;
  probeBarrier: Barrier | undefined;
  closeBarrier: Barrier | undefined;
  assetFailure: EvidenceVerificationError | undefined;
  scenarioFailure: EvidenceVerificationError | undefined;
  transformAsset: ((proof: AssetAttestation) => AssetAttestation) | undefined;
  transformScenario: ((proof: ScenarioAttestation) => ScenarioAttestation) | undefined;
  observationFacts = false;
  constructor(readonly root: EvidenceVerificationRoot) {}

  timing(identities: EvidenceFileIdentity[]): EvidenceVerificationTiming {
    // The fake clock explicitly models old stable identities; the low-level suite tests real clocks.
    const startedAtUnixMs =
      Math.max(
        ...identities.flatMap((item) => [
          Number(BigInt(item.ctimeNs) / 1000000n),
          Number(BigInt(item.mtimeNs) / 1000000n),
        ]),
      ) + 3_000;
    const timing = {
      filesystemType: this.reusable ? 0xef53 : 0,
      startedAtUnixMs,
      finishedAtUnixMs: startedAtUnixMs + 1,
      elapsedMonotonicMs: 1,
      clockStable: true,
    };
    return { ...timing, reusable: reusableEvidenceVerification(timing, identities) };
  }

  async verifyAsset(
    snapshot: AssetVerificationSnapshot,
    _signal: AbortSignal,
  ): Promise<AssetAttestation> {
    this.assets.push(structuredClone(snapshot));
    if (this.assetBarrier) await this.assetBarrier.wait();
    if (this.assetFailure) throw this.assetFailure;
    let result: AssetAttestation = {
      kind: "asset_verified",
      snapshotDigest: evidenceSnapshotDigest(snapshot),
      manifestDigest: snapshot.manifestDigest,
      assetId: snapshot.asset.id,
      storage: snapshot.storage,
      sha256: snapshot.asset.metadata.sha256,
      sizeBytes: snapshot.asset.metadata.sizeBytes,
      before: snapshot.expectedFile,
      after: snapshot.expectedFile,
      verification: this.timing([snapshot.expectedFile]),
    };
    result = this.transformAsset?.(result) ?? result;
    if (result.verification.reusable)
      this.assetCache.set(evidenceSnapshotDigest(snapshot), structuredClone(result));
    return result;
  }

  async verifyScenario(
    snapshot: ScenarioVerificationSnapshot,
    _signal: AbortSignal,
  ): Promise<ScenarioAttestation> {
    this.scenarios.push(structuredClone(snapshot));
    if (this.scenarioFailure) throw this.scenarioFailure;
    const dependencies = [snapshot.steps, ...snapshot.dependencies];
    let result: ScenarioAttestation = {
      kind: "scenario_verified",
      snapshotDigest: evidenceSnapshotDigest(snapshot),
      storage: snapshot.storage,
      resultDigest: snapshot.resultDigest,
      scope: snapshot.steps.asset.scope,
      scenarioId: snapshot.scenario.id,
      stepsManifestDigest: snapshot.steps.manifestDigest,
      dependencyManifestDigests: snapshot.dependencies.map((item) => item.manifestDigest),
      observed: dependencies.map((item) => ({
        assetId: item.asset.id,
        state: item.asset.state,
        before: item.expectedFile,
        after: item.expectedFile,
      })),
      verification: this.timing(dependencies.map((item) => item.expectedFile)),
      ...(this.observationFacts && snapshot.observationSelection !== undefined
        ? {
            observations: snapshot.observationSelection.stepIds.map((stepId) => ({
              observation: {
                kind: "ui_assertion" as const,
                scenarioId: snapshot.scenario.id,
                stepId,
              },
              checkId: snapshot.steps.asset.scope.checkId as string,
              evidenceIds: [snapshot.steps.asset.id],
              state: "observed" as const,
              value: { type: "boolean" as const, value: true },
            })),
          }
        : {}),
    };
    result = this.transformScenario?.(result) ?? result;
    if (result.verification.reusable)
      this.scenarioCache.set(evidenceSnapshotDigest(snapshot), structuredClone(result));
    return result;
  }

  async probeIdentities(
    snapshot: IdentityProbeSnapshot,
    signal: AbortSignal,
  ): Promise<IdentityAttestation> {
    this.probeCalls += 1;
    if (this.probeBarrier) await this.probeBarrier.wait();
    return probeEvidenceIdentities(this.root, snapshot, signal);
  }
  peekAssetAttestation(snapshot: AssetVerificationSnapshot): AssetAttestation | null {
    return structuredClone(this.assetCache.get(evidenceSnapshotDigest(snapshot)) ?? null);
  }
  peekScenarioAttestation(snapshot: ScenarioVerificationSnapshot): ScenarioAttestation | null {
    return structuredClone(this.scenarioCache.get(evidenceSnapshotDigest(snapshot)) ?? null);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeBarrier) await this.closeBarrier.wait();
  }
}

async function owner(
  f: ReturnType<typeof evidenceFixture>,
  options: Partial<EvidenceVerificationCoordinatorOptions> = {},
) {
  const verifier = new FakeVerifier(
    await inspectEvidenceRoot(f.directory, readEvidenceStorageKey(f.database)),
  );
  const coordinator = new EvidenceVerificationCoordinator(f.database, {
    storage: f.options,
    now: () => now,
    verifier,
    ...options,
  });
  coordinators.push(coordinator);
  return { verifier, coordinator };
}
const activeSignal = () => new AbortController().signal;

function validatePrepared(
  f: ReturnType<typeof evidenceFixture>,
  coordinator: EvidenceVerificationCoordinator,
  prepared: PreparedEvidence,
  result: ValidationJobResultV1,
) {
  coordinator.assertPreparedEvidence(prepared);
  return validateValidationCompletion(
    f.database,
    f.context,
    sha256(canonicalJson(result)),
    result,
    undefined,
    {
      validateEvidenceReferences: (scope) =>
        coordinator.admittedEvidenceReferences(prepared, scope),
      validateScenarioEvidence: (scope) => coordinator.admittedScenarioEvidence(prepared, scope),
    },
  );
}

function persist(
  f: ReturnType<typeof evidenceFixture>,
  coordinator: EvidenceVerificationCoordinator,
  prepared: PreparedEvidence,
  result: ValidationJobResultV1,
) {
  f.database.exec("BEGIN IMMEDIATE");
  try {
    const validated = validatePrepared(f, coordinator, prepared, result);
    f.database
      .prepare(
        "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(validated.resultDigest, validated.canonicalResultJson, now, f.context.runAttemptId);
    const id = persistValidatedValidationResult(f.database, f.context, validated, now);
    f.database
      .prepare("UPDATE jobs SET status = 'succeeded', completed_at = ? WHERE id = ?")
      .run(now, f.context.jobId);
    f.database.exec("COMMIT");
    return { id, validated };
  } catch (error) {
    f.database.exec("ROLLBACK");
    throw error;
  }
}

async function terminalFixture(options: FixtureOptions = {}) {
  const f = evidenceFixture(undefined, options);
  const asset = f.complete();
  const submitted = submission(f, asset);
  const { coordinator } = await owner(f);
  const prepared = await coordinator.prepareCompletionEvidence(
    f.context,
    submitted.digest,
    submitted.result,
    activeSignal(),
  );
  persist(f, coordinator, prepared, submitted.result);
  await coordinator.close();
  return {
    ...f,
    ...submitted,
    asset,
    query: { repositoryId: f.run.repositoryId, reviewRunId: f.run.id },
  };
}

async function backgroundFinished(verifier: FakeVerifier) {
  await expect.poll(() => verifier.probeCalls, { timeout: 2_000 }).toBeGreaterThan(0);
  // The read-only probe uses asynchronous descriptor checks; wait for its completion in a later read.
  await immediate();
}

function uploadForCheck(
  f: ReturnType<typeof evidenceFixture>,
  checkId: string,
  kind: "steps" | "log",
) {
  const bytes = Buffer.from(
    kind === "steps" ? '{"schemaVersion":"fixture"}' : "Partial capture diagnostics.",
  );
  const metadata: EvidenceAssetMetadata = {
    kind,
    mediaType: kind === "steps" ? "application/json" : "text/plain",
    checkId,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    capturedAt: now,
  } as EvidenceAssetMetadata;
  const upload = f.request("beginEvidenceUpload", {
    lease: f.lease,
    clientAssetId: `capture-${kind}`,
    metadata,
  });
  f.append(upload.assetId, bytes);
  return f.request("finalizeEvidenceUpload", { lease: f.lease, assetId: upload.assetId });
}

function newerActivation(f: ReturnType<typeof evidenceFixture>) {
  const execution = createValidationExecutionTemplate({
    runId: f.run.id,
    plan: f.run.plan,
    planDigest: f.run.planDigest,
    requestId: "selected",
    jobActivation: 2,
    frozenPrompt: present(
      getReviewRunPromptEnvelope(f.database, {
        repositoryId: f.run.repositoryId,
        reviewRunId: f.run.id,
        requestId: "selected",
      }),
    ),
  });
  const jobId = "validation-job-2";
  f.database.exec("BEGIN IMMEDIATE");
  try {
    insertRow(f.database, "jobs", {
      id: jobId,
      work_item_id: f.run.workItemId,
      job_kind: "pull_request_review",
      semantic_key: jobId,
      concurrency_key: jobId,
      status: "queued",
      execution_json: canonicalJson(execution),
      resource_revision: f.run.revisionKey,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
      request_epoch_id: f.run.requestEpochId,
      execution_digest: sha256(canonicalJson(execution)),
      required_capabilities_digest: sha256("[]"),
    });
    createJobAdmissionInTransaction(f.database, jobId, now);
    associateReviewRunJobInTransaction(
      f.database,
      {
        repositoryId: f.run.repositoryId,
        reviewRunId: f.run.id,
        requestId: "selected",
        jobId,
        actor,
      },
      now,
    );
    f.database.exec("COMMIT");
  } catch (error) {
    f.database.exec("ROLLBACK");
    throw error;
  }
}
const linuxDescribe = describe.skipIf(process.platform !== "linux");
linuxDescribe("SQLite evidence verification owner", () => {
  it("keeps SQLite free while hashing and admits only scoped prepared facts", async () => {
    const f = evidenceFixture();
    const asset = f.complete();
    const submitted = submission(f, asset);
    const { coordinator, verifier } = await owner(f);
    const gate = barrier();
    verifier.assetBarrier = gate;
    const pending = coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    await gate.arrived;
    expect(f.database.isTransaction).toBe(false);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toMatchObject({
      count: 2,
    });
    f.database
      .prepare("UPDATE run_attempts SET last_heartbeat_at = ?, lease_expires_at = ? WHERE id = ?")
      .run("2026-09-07T00:00:01.000Z", "2026-09-07T00:06:00.000Z", f.context.runAttemptId);
    expect(verifier.assets).toHaveLength(1);
    expect(JSON.stringify(verifier.assets[0])).not.toContain("lease-token");
    gate.release();
    const prepared = await pending;
    const calls = verifier.assets.length;
    f.database.exec("BEGIN IMMEDIATE");
    expect(validatePrepared(f, coordinator, prepared, submitted.result).evidenceComplete).toBe(
      true,
    );
    f.database.exec("ROLLBACK");
    expect(verifier.assets).toHaveLength(calls);
    expect(
      coordinator.admittedEvidenceReferences({ kind: "prepared_evidence" }, submitted.scope),
    ).toBe(false);
    expect(
      coordinator.admittedEvidenceReferences(prepared, {
        ...submitted.scope,
        requestId: "another",
      }),
    ).toBe(false);
    expect(() => coordinator.assertPreparedEvidence({ kind: "prepared_evidence" })).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
  });

  it.each(["cancel", "generation", "supersession", "expiry"] as const)(
    "rejects completion after %s changes during hashing",
    async (change) => {
      const f = evidenceFixture();
      const submitted = submission(f, f.complete());
      let clock = now;
      const { coordinator, verifier } = await owner(f, { now: () => clock });
      const gate = barrier();
      verifier.assetBarrier = gate;
      const pending = coordinator.prepareCompletionEvidence(
        f.context,
        submitted.digest,
        submitted.result,
        activeSignal(),
      );
      const rejected = expect(pending).rejects.toMatchObject({ code: "EVIDENCE_LEASE_REJECTED" });
      await gate.arrived;
      if (change === "cancel")
        f.database
          .prepare(
            "UPDATE jobs SET status = 'cancel_requested', cancellation_requested_at = ? WHERE id = ?",
          )
          .run(now, f.context.jobId);
      if (change === "generation")
        f.database
          .prepare("UPDATE jobs SET lease_generation = lease_generation + 1 WHERE id = ?")
          .run(f.context.jobId);
      if (change === "supersession")
        f.database
          .prepare("UPDATE workers SET superseded_at = ? WHERE id = ?")
          .run(now, "worker-1");
      if (change === "expiry") clock = later;
      expect(f.database.isTransaction).toBe(false);
      gate.release();
      await rejected;
      expect(
        f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
      ).toMatchObject({ count: 0 });
    },
  );

  it("rejects assets retired after the snapshot and before admission", async () => {
    const f = evidenceFixture();
    const asset = f.complete();
    const submitted = submission(f, asset);
    const { coordinator, verifier } = await owner(f);
    const gate = barrier();
    verifier.assetBarrier = gate;
    const pending = coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "EVIDENCE_FILE_UNAVAILABLE",
      retryable: true,
    });
    await gate.arrived;
    f.database
      .prepare("UPDATE evidence_assets SET state = 'retired', retired_at = ? WHERE id = ?")
      .run(now, asset.id);
    gate.release();
    await rejected;
  });

  it("rejects uploading or cross-check references before sending verification work", async () => {
    const f = evidenceFixture();
    const uploading = f.begin();
    f.append(uploading.assetId);
    const result = resultFor(f);
    present(result.report.checks.find((check) => check.id === f.metadata.checkId)).evidenceIds = [
      uploading.assetId,
    ];
    const { coordinator, verifier } = await owner(f);
    await expect(
      coordinator.prepareCompletionEvidence(
        f.context,
        sha256(canonicalJson(result)),
        result,
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
    const asset = f.request("finalizeEvidenceUpload", {
      lease: f.lease,
      assetId: uploading.assetId,
    });
    present(result.report.checks.find((check) => check.id === f.metadata.checkId)).evidenceIds = [];
    present(result.report.checks.find((check) => check.id.endsWith(":unit-tests"))).evidenceIds = [
      asset.id,
    ];
    await expect(
      coordinator.prepareCompletionEvidence(
        f.context,
        sha256(canonicalJson(result)),
        result,
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
    expect(verifier.assets).toHaveLength(0);
  });

  it("checks the returned attestation binding before granting authority", async () => {
    const f = evidenceFixture();
    const submitted = submission(f, f.complete());
    const { coordinator, verifier } = await owner(f);
    verifier.transformAsset = (proof) => ({ ...proof, snapshotDigest: "0".repeat(64) });
    await expect(
      coordinator.prepareCompletionEvidence(
        f.context,
        submitted.digest,
        submitted.result,
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_PROTOCOL" });
  });

  it("finalizes verified uploads without rehashing and rechecks the lease at commit", async () => {
    const f = evidenceFixture();
    const uploading = f.begin();
    f.append(uploading.assetId);
    const { coordinator, verifier } = await owner(f);
    verifier.reusable = false;
    const prepared = await coordinator.prepareFinalizeEvidence(
      { lease: f.lease, assetId: uploading.assetId },
      activeSignal(),
    );
    const finalized = coordinator.commitPreparedFinalization(prepared);
    expect(finalized.id).toBe(uploading.assetId);
    expect(verifier.assets).toHaveLength(1);
    expect(() => coordinator.commitPreparedFinalization(prepared)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
    const another = f.begin("another");
    f.append(another.assetId);
    const next = await coordinator.prepareFinalizeEvidence(
      { lease: f.lease, assetId: another.assetId },
      activeSignal(),
    );
    f.database
      .prepare(
        "UPDATE jobs SET status = 'cancel_requested', cancellation_requested_at = ? WHERE id = ?",
      )
      .run(now, f.context.jobId);
    expect(() => coordinator.commitPreparedFinalization(next)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_LEASE_REJECTED" }),
    );
    expect(
      f.database.prepare("SELECT state FROM evidence_assets WHERE id = ?").get(another.assetId),
    ).toMatchObject({ state: "uploading" });
    expect(verifier.assets).toHaveLength(2);
  });

  it("does not authorize a finalization whose lease expires while the verifier is paused", async () => {
    const f = evidenceFixture();
    const uploading = f.begin();
    f.append(uploading.assetId);
    let clock = now;
    const { coordinator, verifier } = await owner(f, { now: () => clock });
    const gate = barrier();
    verifier.assetBarrier = gate;
    const pending = coordinator.prepareFinalizeEvidence(
      { lease: f.lease, assetId: uploading.assetId },
      activeSignal(),
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: "EVIDENCE_LEASE_REJECTED" });
    await gate.arrived;
    expect(f.database.isTransaction).toBe(false);
    clock = later;
    gate.release();
    await rejected;
  });

  it("returns cold reads as pending, deduplicates work, and probes warm cache without hashing", async () => {
    const f = await terminalFixture();
    const { coordinator, verifier } = await owner(f);
    const gate = barrier();
    verifier.assetBarrier = gate;
    const cold = await coordinator.prepareRunReadEvidence(f.query, activeSignal());
    expect(cold.profiles).toMatchObject([{ status: "pending" }]);
    expect(coordinator.admittedEvidenceReferences(cold.prepared, f.scope)).toBe(false);
    await gate.arrived;
    for (let count = 0; count < 3; count += 1)
      expect(
        (await coordinator.prepareRunReadEvidence(f.query, activeSignal())).profiles[0]?.status,
      ).toBe("pending");
    expect(verifier.assets).toHaveLength(1);
    gate.release();
    await backgroundFinished(verifier);
    let warm = await coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
      background: false,
    });
    await expect
      .poll(async () => {
        warm = await coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
          background: false,
        });
        return warm.profiles[0]?.status;
      })
      .toBe("verified");
    coordinator.assertPreparedEvidence(warm.prepared);
    expect(coordinator.admittedEvidenceReferences(warm.prepared, f.scope)).toBe(true);
    expect(verifier.assets).toHaveLength(1);
    expect(verifier.probeCalls).toBeGreaterThan(1);
    verifier.assetCache.clear();
    const evicted = await coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
      background: false,
    });
    expect(evicted.profiles[0]?.status).toBe("pending");
    expect(verifier.assets).toHaveLength(1);
  });

  it("uses uncacheable verification for this completion and later fresh read preflights", async () => {
    const f = evidenceFixture();
    const submitted = submission(f, f.complete());
    const { coordinator, verifier } = await owner(f);
    verifier.reusable = false;
    const prepared = await coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    expect(validatePrepared(f, coordinator, prepared, submitted.result).evidenceComplete).toBe(
      true,
    );
    persist(f, coordinator, prepared, submitted.result);
    const query = { repositoryId: f.run.repositoryId, reviewRunId: f.run.id };
    const read = await coordinator.prepareRunReadEvidence(query, activeSignal());
    expect(read.profiles[0]?.status).toBe("verified");
    expect(verifier.assets).toHaveLength(2);
    expect(verifier.assetCache.size).toBe(0);
    const next = await coordinator.prepareRunReadEvidence(query, activeSignal());
    expect(next.profiles[0]?.status).toBe("verified");
    expect(verifier.assets).toHaveLength(3);
  });

  it("does not leave a cold uncacheable terminal result pending forever", async () => {
    const f = await terminalFixture();
    const { coordinator, verifier } = await owner(f);
    verifier.reusable = false;
    const cold = await coordinator.prepareRunReadEvidence(f.query, activeSignal());
    expect(cold.profiles[0]?.status).toBe("pending");
    await backgroundFinished(verifier);
    let read = await coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
      background: false,
    });
    await expect
      .poll(async () => {
        read = await coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
          background: false,
        });
        return read.profiles[0]?.status;
      })
      .toBe("verified");
    coordinator.assertPreparedEvidence(read.prepared);
    expect(verifier.assets.length).toBeGreaterThanOrEqual(2);
    expect(verifier.assetCache.size).toBe(0);
  });

  it("rechecks retirement after a warm probe and before projection", async () => {
    const f = await terminalFixture();
    const { coordinator, verifier } = await owner(f);
    await coordinator.prepareRunReadEvidence(f.query, activeSignal());
    await backgroundFinished(verifier);
    await expect
      .poll(
        async () =>
          (await coordinator.prepareRunReadEvidence(f.query, activeSignal(), { background: false }))
            .profiles[0]?.status,
      )
      .toBe("verified");
    const gate = barrier();
    verifier.probeBarrier = gate;
    const pending = coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
      background: false,
    });
    await gate.arrived;
    f.database
      .prepare("UPDATE evidence_assets SET state = 'retired', retired_at = ? WHERE id = ?")
      .run(now, f.asset.id);
    gate.release();
    const read = await pending;
    expect(read.profiles[0]?.status).toBe("unavailable");
    expect(coordinator.admittedEvidenceReferences(read.prepared, f.scope)).toBe(false);
    expect(
      f.database.prepare("SELECT status FROM jobs WHERE id = ?").get(f.context.jobId),
    ).toMatchObject({ status: "succeeded" });
  });

  it("invalidates a warm identity when the same file is changed", async () => {
    const f = await terminalFixture();
    const { coordinator, verifier } = await owner(f);
    await coordinator.prepareRunReadEvidence(f.query, activeSignal());
    await backgroundFinished(verifier);
    await expect
      .poll(
        async () =>
          (await coordinator.prepareRunReadEvidence(f.query, activeSignal(), { background: false }))
            .profiles[0]?.status,
      )
      .toBe("verified");
    const calls = verifier.assets.length;
    writeFileSync(join(f.directory, `${f.asset.id}.asset`), Buffer.alloc(f.bytes.length, 120));
    const read = await coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
      background: false,
    });
    expect(read.profiles[0]?.status).toBe("pending");
    expect(verifier.assets).toHaveLength(calls);
    expect(coordinator.admittedEvidenceReferences(read.prepared, f.scope)).toBe(false);
  });

  it("keeps queue pressure typed and settles a paused verifier on shutdown", async () => {
    const f = evidenceFixture();
    const submitted = submission(f, f.complete());
    const { coordinator, verifier } = await owner(f, { maximumForeground: 1 });
    const gate = barrier();
    verifier.assetBarrier = gate;
    const first = coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    const rejected = expect(first).rejects.toMatchObject({
      code: "EVIDENCE_VERIFIER_SHUTDOWN",
      retryable: true,
    });
    await gate.arrived;
    await expect(
      coordinator.prepareCompletionEvidence(
        f.context,
        submitted.digest,
        submitted.result,
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_BUSY", retryable: true });
    await coordinator.close();
    await rejected;
    expect(verifier.closeCalls).toBe(1);
    closeEvidenceAssetStorage(f.database);
    f.database.close();
    databases.splice(databases.indexOf(f.database), 1);
    gate.release();
    await immediate();
    expect(() => coordinator.assertPreparedEvidence({ kind: "prepared_evidence" })).toThrow(
      expect.objectContaining({ code: "EVIDENCE_VERIFIER_SHUTDOWN" }),
    );
  });

  it("times out a waiter without treating valid references as unknown", async () => {
    const f = evidenceFixture();
    const submitted = submission(f, f.complete());
    const { coordinator, verifier } = await owner(f, { foregroundTimeoutMs: 50 });
    const gate = barrier();
    verifier.assetBarrier = gate;
    const pending = coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    await expect(pending).rejects.toMatchObject({
      code: "EVIDENCE_VERIFIER_TIMEOUT",
      retryable: true,
    });
    gate.release();
  });

  it("refuses to start asynchronous preflight inside an existing transaction", async () => {
    const f = evidenceFixture();
    const submitted = submission(f, f.complete());
    const { coordinator } = await owner(f);
    f.database.exec("BEGIN IMMEDIATE");
    expect(() =>
      coordinator.prepareCompletionEvidence(
        f.context,
        submitted.digest,
        submitted.result,
        activeSignal(),
      ),
    ).toThrow(expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }));
    f.database.exec("ROLLBACK");
  });

  it.each(["verified", "semantic_mismatch", "partial_capture"] as const)(
    "keeps UI reports displayable with %s scenario evidence",
    async (mode) => {
      const f = evidenceFixture(undefined, { workflowKind: "pr_ui" });
      const checkId = `${f.profile.id}:settings`;
      const asset = uploadForCheck(f, checkId, mode === "partial_capture" ? "log" : "steps");
      const submitted = submission(f, asset);
      const { coordinator, verifier } = await owner(f);
      if (mode === "semantic_mismatch")
        verifier.scenarioFailure = new EvidenceVerificationError("EVIDENCE_SCENARIO_MISMATCH");
      const prepared = await coordinator.prepareCompletionEvidence(
        f.context,
        submitted.digest,
        submitted.result,
        activeSignal(),
      );
      expect(coordinator.admittedEvidenceReferences(prepared, submitted.scope)).toBe(true);
      expect(coordinator.admittedScenarioEvidence(prepared, submitted.scope)).toBe(
        mode === "verified",
      );
      expect(coordinator.admittedScenarioObservations(prepared, submitted.scope)).toBeNull();
      const stored = persist(f, coordinator, prepared, submitted.result);
      expect(stored.validated.evidenceComplete).toBe(mode === "verified");
      expect(
        f.database
          .prepare("SELECT evidence_complete FROM validation_job_results WHERE id = ?")
          .get(stored.id),
      ).toMatchObject({ evidence_complete: mode === "verified" ? 1 : 0 });
      expect(verifier.scenarios.length).toBe(mode === "partial_capture" ? 0 : 1);
      if (mode !== "partial_capture")
        expect(verifier.scenarios[0]).toMatchObject({
          target: "web",
          resultDigest: submitted.digest,
          scenario: { id: "settings" },
          policy: f.profile.config.ui?.evidence,
          steps: {
            asset: { scope: { requestId: "selected", profileVersionId: f.profile.id, checkId } },
          },
        });
    },
  );

  it("admits only the frozen current scenario selection and clones its typed facts", async () => {
    const f = evidenceFixture(undefined, {
      workflowKind: "issue_validation",
      uiReproduction: true,
    });
    const submitted = submission(f, uploadForCheck(f, `${f.profile.id}:settings`, "steps"));
    const { coordinator, verifier } = await owner(f);
    verifier.observationFacts = true;
    const prepared = await coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    expect(verifier.scenarios[0]?.observationSelection).toEqual({
      schemaVersion: "UiObservationSelectionV1",
      stepIds: ["absent-only", "precondition-only", "visible"],
    });
    const facts = present(coordinator.admittedScenarioObservations(prepared, submitted.scope));
    expect(facts.map((fact) => fact.observation)).toEqual(
      ["absent-only", "precondition-only", "visible"].map((stepId) => ({
        kind: "ui_assertion",
        scenarioId: "settings",
        stepId,
      })),
    );
    const first = present(facts[0]);
    if (first.state !== "observed" || first.value.type !== "boolean")
      throw new Error("Missing observed boolean fixture.");
    first.value.value = false;
    first.evidenceIds.splice(0);
    expect(coordinator.admittedScenarioObservations(prepared, submitted.scope)?.[0]).toMatchObject({
      state: "observed",
      value: { type: "boolean", value: true },
      evidenceIds: submitted.scope.evidenceIds,
    });
    expect(
      coordinator.admittedScenarioObservations(prepared, {
        ...submitted.scope,
        requestId: "another-request",
      }),
    ).toBeNull();
    expect(
      coordinator.admittedScenarioObservations({ kind: "prepared_evidence" }, submitted.scope),
    ).toBeNull();
    expect(f.database.isTransaction).toBe(false);
    await immediate();
    expect(coordinator.admittedScenarioObservations(prepared, submitted.scope)).toBeNull();
  });

  it("retains generic scenario proof when selected observations have only legacy capture", async () => {
    const f = evidenceFixture(undefined, {
      workflowKind: "issue_validation",
      uiReproduction: true,
    });
    const submitted = submission(f, uploadForCheck(f, `${f.profile.id}:settings`, "steps"));
    const { coordinator } = await owner(f);
    const prepared = await coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    expect(coordinator.admittedScenarioEvidence(prepared, submitted.scope)).toBe(true);
    expect(coordinator.admittedScenarioObservations(prepared, submitted.scope)).toBeNull();
  });

  it("rejects forged selected observations from a verifier before issuing an operation proof", async () => {
    const f = evidenceFixture(undefined, {
      workflowKind: "issue_validation",
      uiReproduction: true,
    });
    const submitted = submission(f, uploadForCheck(f, `${f.profile.id}:settings`, "steps"));
    const { coordinator, verifier } = await owner(f);
    verifier.observationFacts = true;
    verifier.transformScenario = (proof) => {
      const fact = present(proof.observations?.[0]);
      fact.observation = { kind: "ui_assertion", scenarioId: "settings", stepId: "unselected" };
      return proof;
    };
    await expect(
      coordinator.prepareCompletionEvidence(
        f.context,
        submitted.digest,
        submitted.result,
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_PROTOCOL" });
  });

  it("rechecks current lease authority when admitting selected observations", async () => {
    const f = evidenceFixture(undefined, {
      workflowKind: "issue_validation",
      uiReproduction: true,
    });
    const submitted = submission(f, uploadForCheck(f, `${f.profile.id}:settings`, "steps"));
    const { coordinator, verifier } = await owner(f);
    verifier.observationFacts = true;
    const prepared = await coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    f.database
      .prepare("UPDATE jobs SET cancellation_requested_at = ? WHERE id = ?")
      .run(now, f.context.jobId);
    expect(() => coordinator.admittedScenarioObservations(prepared, submitted.scope)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_LEASE_REJECTED" }),
    );
  });

  it("reuses a scenario only after a fresh identity probe", async () => {
    const f = evidenceFixture(undefined, { workflowKind: "pr_ui" });
    const submitted = submission(f, uploadForCheck(f, `${f.profile.id}:settings`, "steps"));
    const { coordinator, verifier } = await owner(f);
    const prepared = await coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    persist(f, coordinator, prepared, submitted.result);
    const read = await coordinator.prepareRunReadEvidence(
      { repositoryId: f.run.repositoryId, reviewRunId: f.run.id },
      activeSignal(),
    );
    expect(read.profiles[0]?.status).toBe("verified");
    expect(coordinator.admittedScenarioEvidence(read.prepared, submitted.scope)).toBe(true);
    expect(verifier.scenarios).toHaveLength(1);
    expect(verifier.assets).toHaveLength(1);
    expect(verifier.probeCalls).toBe(2);
  });

  it("returns verifier queue failures as pending in subsequent reads", async () => {
    const f = await terminalFixture();
    const { coordinator, verifier } = await owner(f);
    const gate = barrier();
    verifier.assetBarrier = gate;
    verifier.assetFailure = new EvidenceVerificationError("EVIDENCE_VERIFIER_BUSY");
    await coordinator.prepareRunReadEvidence(f.query, activeSignal());
    await gate.arrived;
    gate.release();
    await immediate();
    let read = await coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
      background: false,
    });
    await expect
      .poll(async () => {
        read = await coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
          background: false,
        });
        return read.profiles[0]?.code;
      })
      .toBe("EVIDENCE_VERIFIER_BUSY");
    expect(read.profiles[0]?.status).toBe("pending");
    expect(verifier.assets).toHaveLength(1);
  });

  it("invalidates the current result selection when a newer activation is associated during probing", async () => {
    const f = await terminalFixture();
    const { coordinator, verifier } = await owner(f);
    await coordinator.prepareRunReadEvidence(f.query, activeSignal());
    await backgroundFinished(verifier);
    await expect
      .poll(
        async () =>
          (await coordinator.prepareRunReadEvidence(f.query, activeSignal(), { background: false }))
            .profiles[0]?.status,
      )
      .toBe("verified");
    const gate = barrier();
    verifier.probeBarrier = gate;
    const pending = coordinator.prepareRunReadEvidence(f.query, activeSignal(), {
      background: false,
    });
    await gate.arrived;
    newerActivation(f);
    gate.release();
    const read = await pending;
    expect(read.profiles[0]?.status).toBe("pending");
    coordinator.assertPreparedEvidence(read.prepared);
    expect(coordinator.admittedEvidenceReferences(read.prepared, f.scope)).toBe(false);
    expect(
      f.database
        .prepare("SELECT COUNT(*) AS count FROM review_run_job_links WHERE review_run_id = ?")
        .get(f.run.id),
    ).toMatchObject({ count: 2 });
  });

  it("expires operation proofs before a later event-loop turn can reuse them", async () => {
    const f = evidenceFixture();
    const submitted = submission(f, f.complete());
    const { coordinator } = await owner(f);
    const prepared = await coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    expect(coordinator.admittedEvidenceReferences(prepared, submitted.scope)).toBe(true);
    await immediate();
    expect(coordinator.admittedEvidenceReferences(prepared, submitted.scope)).toBe(false);
    expect(() => coordinator.assertPreparedEvidence(prepared)).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID_SNAPSHOT" }),
    );
  });

  it("drains pending preflights before awaiting explicit verifier exit confirmation", async () => {
    const f = evidenceFixture();
    const submitted = submission(f, f.complete());
    const { coordinator, verifier } = await owner(f, { closeTimeoutMs: 1_000 });
    const hashGate = barrier();
    const exitGate = barrier();
    verifier.assetBarrier = hashGate;
    verifier.closeBarrier = exitGate;
    const pending = coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_SHUTDOWN" });
    await hashGate.arrived;
    let confirmed = false;
    const closing = coordinator.close().then(() => {
      confirmed = true;
    });
    await rejected;
    await exitGate.arrived;
    expect(confirmed).toBe(false);
    expect(verifier.closeCalls).toBe(1);
    hashGate.release();
    await immediate();
    expect(confirmed).toBe(false);
    exitGate.release();
    await closing;
    expect(confirmed).toBe(true);
  });

  it("rejects a hung verifier close and never upgrades a late exit to confirmed shutdown", async () => {
    const f = evidenceFixture();
    const submitted = submission(f, f.complete());
    const { coordinator, verifier } = await owner(f, { closeTimeoutMs: 10 });
    const hashGate = barrier();
    const exitGate = barrier();
    verifier.assetBarrier = hashGate;
    verifier.closeBarrier = exitGate;
    const pending = coordinator.prepareCompletionEvidence(
      f.context,
      submitted.digest,
      submitted.result,
      activeSignal(),
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_SHUTDOWN" });
    await hashGate.arrived;
    const closing = coordinator.close();
    await rejected;
    await expect(closing).rejects.toMatchObject({
      code: "EVIDENCE_VERIFIER_TIMEOUT",
      retryable: true,
    });
    coordinators.splice(coordinators.indexOf(coordinator), 1);
    expect(f.database.isTransaction).toBe(false);
    closeEvidenceAssetStorage(f.database);
    f.database.close();
    databases.splice(databases.indexOf(f.database), 1);
    hashGate.release();
    exitGate.release();
    await immediate();
    expect(coordinator.close()).toBe(closing);
    await expect(coordinator.close()).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_TIMEOUT" });
    expect(verifier.closeCalls).toBe(1);
  });
});
