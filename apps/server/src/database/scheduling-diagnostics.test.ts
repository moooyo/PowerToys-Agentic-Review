import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PrReviewPlanV1ModelOutputSchema } from "@agentic-review/codex";
import {
  type ActiveAuthorizedRequestEpoch,
  type GitHubRepository,
  getSchedulingDiagnosticsIssues,
  type JobExecutionTemplate,
  type ManagedRepository,
  maximumClaimLeaseResponseUtf8Bytes,
  type PromptTemplate,
  type PromptVersion,
  type ReviewRunPlanInput,
  type SchedulingDiagnostics,
  SchedulingDiagnosticsSchema,
  SchedulingDiagnosticsV1Schema,
  type SchedulingLimits,
  type SchedulingRequestOpenedEvent,
  type SelfOrAllowlistPolicy,
  type ValidationProfileVersion,
  type WorkerCapabilities,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createValidationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest, type OperatorReadContext } from "./operator-access.js";
import { handlePromptConfigurationRequest } from "./prompt-configuration.js";
import {
  canonicalizeReviewResultSubmission,
  persistValidatedReviewResult,
  type ReviewCompletionJobContext,
  validateReviewCompletion,
} from "./review-results.js";
import {
  associateReviewRunJobInTransaction,
  getReviewRunPromptEnvelope,
  handleReviewRunRequest,
  maximumReviewRunJobAssociationCount,
  type ReviewRunDetail,
} from "./review-runs.js";
import { readPlatformSchedulingConfiguration } from "./scheduling-accounting.js";
import { admitPendingJobsInTransaction } from "./scheduling-admission.js";
import { handleSchedulingConfigurationRequest } from "./scheduling-configuration.js";
import {
  handleSchedulingDiagnosticsRequest,
  inspectJobAdmissionReadinessInTransaction,
  type SchedulingDiagnosticsOperation,
  type SchedulingDiagnosticsOperationMap,
  type SchedulingDiagnosticsRequest,
} from "./scheduling-diagnostics.js";
import {
  prepareClaimExecutionEnvelope,
  type SchedulingClaimCandidate,
} from "./scheduling-eligibility.js";
import {
  handleValidationDispatchRequest,
  type ValidationDispatchResult,
} from "./validation-dispatch.js";

const now = "2026-09-07T12:00:00.000Z";
const later = "2026-09-07T12:01:00.000Z";
const before = "2026-09-07T11:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "scheduling-admin" };
const viewer = { issuer: actor.issuer, subject: "scheduling-viewer" };
const adminContext: OperatorReadContext = { actor, administrators: [actor] };
const viewerContext: OperatorReadContext = { actor: viewer, administrators: [actor] };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: 100,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const databases: DatabaseSync[] = [];
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
beforeEach(() => {
  // Legacy ingestion timestamps acceptance with Date, while diagnostic reads take an explicit
  // observation time. Keep both clocks aligned without replacing real timeout scheduling.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});
function present<T>(value: T | undefined | null): T {
  if (value === null || value === undefined) throw new Error("The scheduling fixture is missing.");
  return value;
}
function open(): DatabaseSync {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(database);
  runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
  handleRepositoryConfigurationRequest(
    database,
    {
      operation: "bootstrapManagedRepositories",
      input: {
        repositories: [1, 2].map((number) => ({
          githubRepositoryId: number,
          fullName: `example/project-${number}`,
        })),
        reviewer,
        authorizationPolicy: policy,
      },
    },
    now,
  );
  return database;
}
function event(
  number = 1,
  requestKind: "review_request" | "assignment" = "review_request",
): SchedulingRequestOpenedEvent {
  const repository: GitHubRepository = {
    githubRepositoryId: number,
    githubNodeId: `repository-${number}`,
    ownerLogin: "example",
    name: `project-${number}`,
    fullName: `example/project-${number}`,
    htmlUrl: `https://github.com/example/project-${number}`,
    defaultBranch: "main",
    isPrivate: false,
  };
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  return {
    contractVersion: 1,
    eventId: `event-${number}-${requestKind}`,
    sourceEventId: `delivery-${number}-${requestKind}`,
    source: "webhook",
    occurredAt: now,
    observedAt: now,
    repository,
    author: reviewer,
    actor: reviewer,
    target: reviewer,
    action: "request_opened",
    requestKind,
    workItem: {
      kind: "pull_request",
      githubRepositoryId: number,
      githubWorkItemId: number * 1000 + 1,
      githubNodeId: `PR_${number}`,
      number: 1,
      title: "Scheduling fixture",
      body: "Synthetic configuration only.",
      state: "open",
      author: reviewer,
      htmlUrl: `${repository.htmlUrl}/pull/1`,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      isDraft: false,
    },
    revision: {
      kind: "pull_request",
      githubRepositoryId: number,
      githubWorkItemId: number * 1000 + 1,
      baseSha,
      headSha,
      revisionKey: sha256(`${baseSha}\0${headSha}`),
      observedAt: now,
      sourceUpdatedAt: now,
    },
  };
}
function template(source: SchedulingRequestOpenedEvent): JobExecutionTemplate {
  if (source.revision.kind !== "pull_request" || source.workItem.kind !== "pull_request")
    throw new Error("A pull request fixture is required.");
  return {
    repository: {
      githubRepositoryId: source.repository.githubRepositoryId,
      fullName: source.repository.fullName,
    },
    resource: {
      kind: "pull_request",
      githubNodeId: source.workItem.githubNodeId,
      number: source.workItem.number,
      title: source.workItem.title,
      author: reviewer,
      canonicalSnapshot: source.workItem,
      baseSha: source.revision.baseSha,
      headSha: source.revision.headSha,
      isDraft: false,
    },
    prompt: {
      name: "scheduling-fixture",
      version: "1",
      renderedPrompt: "Read the fixture.",
      promptSha256: sha256("Read the fixture."),
      outputSchema: {},
      outputSchemaSha256: sha256("{}"),
    },
    executionPolicy: {
      hardTimeoutMs: 120_000,
      noProgressTimeoutMs: 30_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}
function activate(
  database: DatabaseSync,
  number = 1,
  requestKind: "review_request" | "assignment" = "review_request",
  admitted = true,
) {
  const source = event(number, requestKind);
  const executionTemplate = template(source);
  const result = ingestSchedulingEvent(database, {
    event: source,
    policy,
    allowScheduling: true,
    delivery: {
      deliveryId: source.sourceEventId,
      eventName: "pull_request",
      payloadSha256: sha256(canonicalJson(source)),
      receivedAt: now,
    },
    schedule: {
      jobKind: "pull_request_review",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 3,
      requiredCapabilities: [],
      executionTemplate,
    },
  });
  if (admitted) admitFixtureJob(database, present(result.jobId));
  return {
    source,
    template: executionTemplate,
    jobId: present(result.jobId),
    repositoryId: result.repositoryId,
    workItemId: result.workItemId,
    epochId: present(result.openedRequestEpochId),
  };
}
function read<K extends SchedulingDiagnosticsOperation>(
  database: DatabaseSync,
  operation: K,
  input: SchedulingDiagnosticsOperationMap[K]["input"],
  context: OperatorReadContext = adminContext,
  at = now,
) {
  const value = handleSchedulingDiagnosticsRequest(
    database,
    { operation, input } as SchedulingDiagnosticsRequest,
    at,
    context,
  );
  if (value !== null) {
    expect(Value.Check(SchedulingDiagnosticsSchema, value)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(value)).toEqual([]);
  }
  return value;
}
function observe(
  database: DatabaseSync,
  scope: { repositoryId: string; jobId: string },
  at = now,
): SchedulingDiagnostics {
  return present(
    read(
      database,
      "getRepositoryJobScheduling",
      { repositoryId: scope.repositoryId, jobId: scope.jobId },
      adminContext,
      at,
    ),
  );
}
function codes(value: SchedulingDiagnostics): string[] {
  return value.reasons.map((reason) => reason.code);
}
function workerCapabilities(labels: Record<string, string> = {}): WorkerCapabilities {
  return {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: true,
    cliEngine: "codex",
    cliVersion: "test",
    recipeIds: [],
    labels,
  };
}
function worker(
  database: DatabaseSync,
  options: {
    id?: string;
    status?: string;
    auth?: string;
    labels?: Record<string, string>;
    availableSlots?: number;
    maxSlots?: number;
    health?: boolean;
    protocol?: string;
    superseded?: boolean;
    at?: string;
  } = {},
) {
  const id = options.id ?? randomUUID();
  const node = `node-${id}`;
  const instance = `instance-${id}`;
  const capabilities = canonicalJson(workerCapabilities(options.labels));
  database
    .prepare(`INSERT INTO worker_node_credentials (worker_node_id, display_name, token_sha256, auth_state,
    created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at, activated_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      node,
      "FOREIGN_WORKER_NAME",
      sha256(node),
      options.auth ?? "active",
      actor.issuer,
      actor.subject,
      actor.issuer,
      actor.subject,
      now,
      now,
      options.auth === "pending" ? null : now,
      options.auth === "revoked" ? now : null,
    );
  database
    .prepare(`INSERT INTO workers (id, node_id, instance_id, display_name, version, protocol_version, max_slots,
    capabilities_json, capabilities_digest, status, available_slots, health_json, superseded_at, registered_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, 'FOREIGN_WORKER_NAME', 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      node,
      instance,
      options.protocol ?? "1.0",
      options.maxSlots ?? 1,
      capabilities,
      sha256(capabilities),
      options.status ?? "online",
      options.availableSlots ?? 1,
      options.health === false
        ? null
        : canonicalJson({
            state: options.status ?? "online",
            freeDiskBytes: 1000,
            memoryUsageBytes: 1000,
          }),
      options.superseded ? now : null,
      now,
      options.at ?? now,
      now,
    );
  return { id, node, instance };
}
function updateJob(
  database: DatabaseSync,
  jobId: string,
  values: Record<string, SQLInputValue>,
): void {
  database
    .prepare(
      `UPDATE jobs SET ${Object.keys(values)
        .map((key) => `${key} = ?`)
        .join(", ")} WHERE id = ?`,
    )
    .run(...Object.values(values), jobId);
}
function fixtureTransaction<T>(database: DatabaseSync, operation: () => T): T {
  if (database.isTransaction) return operation();
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
function admitFixtureJob(database: DatabaseSync, jobId: string): void {
  // Preserve the P0 matrix as observations of an already-admitted queue episode, even when
  // its current Workers or prerequisites have changed. This bounded synthetic setup is not
  // the production admission scheduler and never grants a lease or bypasses a SQL trigger.
  fixtureTransaction(database, () => {
    const row = present(
      database
        .prepare(`SELECT admission.state, admission.attempt_base,
      job.attempt_count FROM job_admission AS admission JOIN jobs AS job ON job.id = admission.job_id
      WHERE admission.job_id = ?`)
        .get(jobId),
    );
    expect(row.attempt_base).toBe(row.attempt_count);
    if (row.state === "pending") {
      const result = database
        .prepare(`UPDATE job_admission SET state = 'admitted', admitted_at = ?
        WHERE job_id = ? AND state = 'pending' AND attempt_base = ?`)
        .run(now, jobId, row.attempt_base);
      expect(result.changes).toBe(1);
    } else expect(row.state).toBe("admitted");
  });
}
function cloneJob(
  database: DatabaseSync,
  jobId: string,
  changes: Record<string, SQLInputValue> = {},
): string {
  const row = present(database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId)) as Record<
    string,
    SQLInputValue
  >;
  const id = typeof changes.id === "string" ? changes.id : randomUUID();
  const copy = { ...row, id, semantic_key: id, concurrency_key: id, ...changes };
  fixtureTransaction(database, () => {
    database
      .prepare(
        `INSERT INTO jobs (${Object.keys(copy).join(", ")}) VALUES (${Object.keys(copy)
          .map(() => "?")
          .join(", ")})`,
      )
      .run(...Object.values(copy));
    createJobAdmissionInTransaction(database, id, now);
    admitFixtureJob(database, id);
  });
  return id;
}
function variant(
  database: DatabaseSync,
  fixture: ReturnType<typeof activate>,
  changes: Record<string, SQLInputValue>,
): ReturnType<typeof activate> {
  // Insert a separate, unrouted Legacy fixture with its final immutable bytes. Never change
  // a scheduled Job's frozen identity or disable the production consistency triggers.
  const values = { ...changes };
  if (typeof values.execution_json === "string")
    values.execution_digest = sha256(values.execution_json);
  if (typeof values.required_capabilities_json === "string")
    values.required_capabilities_digest = sha256(values.required_capabilities_json);
  const jobId = cloneJob(database, fixture.jobId, values);
  if (values.work_item_id !== null)
    database
      .prepare(`INSERT INTO job_request_epochs (job_id, request_epoch_id, linked_at)
    SELECT ?, request_epoch_id, linked_at FROM job_request_epochs WHERE job_id = ?`)
      .run(jobId, fixture.jobId);
  return { ...fixture, jobId };
}
function occupy(
  database: DatabaseSync,
  workerRow: ReturnType<typeof worker>,
  jobId: string,
  cancelled = false,
): void {
  const attempt = randomUUID();
  admitFixtureJob(database, jobId);
  const row = present(
    database.prepare("SELECT attempt_count, lease_generation FROM jobs WHERE id = ?").get(jobId),
  );
  const attemptNumber = Number(row.attempt_count) + 1;
  const leaseGeneration = Number(row.lease_generation) + 1;
  fixtureTransaction(database, () => {
    updateJob(database, jobId, {
      status: "leased",
      current_run_attempt_id: attempt,
      attempt_count: attemptNumber,
      lease_generation: leaseGeneration,
    });
    database
      .prepare(`INSERT INTO run_attempts (id, job_id, attempt_number, worker_id, worker_node_id, worker_instance_id,
    status, lease_token_hash, lease_generation, lease_expires_at, execution_deadline_at, no_progress_timeout_ms,
    no_progress_deadline_at, last_heartbeat_at, phase, started_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 30000, ?, ?, 'executing', ?)`)
      .run(
        attempt,
        jobId,
        attemptNumber,
        workerRow.id,
        workerRow.node,
        workerRow.instance,
        sha256(attempt),
        leaseGeneration,
        before,
        before,
        before,
        before,
        before,
      );
    updateJob(database, jobId, { status: cancelled ? "cancel_requested" : "running" });
  });
}
function grant(database: DatabaseSync, repositoryId: string): void {
  handleOperatorAccessRequest(
    database,
    {
      operation: "changeRepositoryAccess",
      input: {
        repositoryId,
        actor,
        request: {
          changeId: randomUUID(),
          principal: viewer,
          role: "viewer",
          expectedVersion: 0,
          reason: "Read scoped scheduling observations.",
        },
      },
    },
    now,
    [actor],
  );
}
function makeRun(
  database: DatabaseSync,
  configured = true,
  capabilities: string[] = [],
  anotherRequest = false,
) {
  const active = activate(database);
  const managed = handleRepositoryConfigurationRequest(
    database,
    { operation: "getManagedRepository", input: { repositoryId: active.repositoryId } },
    now,
  ) as ManagedRepository;
  let profileVersion: ValidationProfileVersion | null = null;
  let published: PromptVersion | null = null;
  if (configured) {
    const draft = handlePromptConfigurationRequest(
      database,
      {
        operation: "createPromptTemplate",
        input: {
          actor,
          request: {
            name: "Scheduling prompt",
            workflowKind: "pr_static_build",
            content: "Read the frozen request.",
            outputSchemaVersion: "PrReviewPlanV2",
          },
        },
      },
      now,
    ) as PromptTemplate;
    published = handlePromptConfigurationRequest(
      database,
      {
        operation: "publishPromptDraft",
        input: { actor, templateId: draft.id, request: { expectedVersion: 1 } },
      },
      now,
    ) as PromptVersion;
    profileVersion = handlePromptConfigurationRequest(
      database,
      {
        operation: "publishValidationProfile",
        input: {
          actor,
          repositoryId: active.repositoryId,
          request: {
            name: "Scheduling profile",
            workflowKind: "pr_static_build",
            target: "headless",
            required: true,
            outputSchemaVersion: "PrReviewPlanV2",
            config: {
              schemaVersion: "ValidationProfileV1",
              setup: [],
              build: [
                {
                  id: "compile",
                  name: "Compile fixture",
                  command: {
                    executable: "node",
                    args: ["build.mjs"],
                    workingDirectory: ".",
                    environment: [],
                  },
                  timeoutMs: 30_000,
                  required: true,
                },
              ],
              test: [],
              launch: [],
              cleanup: [],
              requiredCapabilities: capabilities,
              hardTimeoutMs: 120_000,
              noProgressTimeoutMs: 30_000,
            },
          },
        },
      },
      now,
    ) as ValidationProfileVersion;
    handlePromptConfigurationRequest(
      database,
      {
        operation: "savePromptBinding",
        input: {
          actor,
          repositoryId: active.repositoryId,
          workflowKind: "pr_static_build",
          request: { expectedVersion: 0, promptVersionId: published.id },
        },
      },
      now,
    );
    handlePromptConfigurationRequest(
      database,
      {
        operation: "saveValidationProfileBinding",
        input: {
          actor,
          repositoryId: active.repositoryId,
          profileId: profileVersion.profileId,
          request: { expectedVersion: 0, profileVersionId: profileVersion.id, enabled: true },
        },
      },
      now,
    );
  }
  const epoch = present(
    database.prepare("SELECT epoch_json FROM request_epochs WHERE id = ?").get(active.epochId),
  );
  const source = active.source;
  if (source.revision.kind !== "pull_request") throw new Error("Expected a pull request.");
  const requests: ReviewRunPlanInput["requests"] = [
    {
      requestId: "request-one",
      workflowKind: "pr_static_build",
      target: "headless",
      required: true,
      profileVersion,
      prompt: published === null ? null : { workflowKind: "pr_static_build", version: published },
    },
  ];
  if (anotherRequest) {
    const original = present(profileVersion);
    const secondProfile = handlePromptConfigurationRequest(
      database,
      {
        operation: "publishValidationProfile",
        input: {
          actor,
          repositoryId: active.repositoryId,
          request: {
            name: "Other request profile",
            workflowKind: "pr_static_build",
            target: "headless",
            required: true,
            outputSchemaVersion: "PrReviewPlanV2",
            config: { ...original.config, requiredCapabilities: [] },
          },
        },
      },
      now,
    ) as ValidationProfileVersion;
    handlePromptConfigurationRequest(
      database,
      {
        operation: "saveValidationProfileBinding",
        input: {
          actor,
          repositoryId: active.repositoryId,
          profileId: secondProfile.profileId,
          request: { expectedVersion: 0, profileVersionId: secondProfile.id, enabled: true },
        },
      },
      now,
    );
    requests.push({
      requestId: "request-two",
      workflowKind: "pr_static_build",
      target: "headless",
      required: true,
      profileVersion: secondProfile,
      prompt: { workflowKind: "pr_static_build", version: present(published) },
    });
  }
  const planInput: ReviewRunPlanInput = {
    activationId: randomUUID(),
    repository: {
      id: managed.id,
      githubRepositoryId: managed.githubRepositoryId,
      fullName: managed.fullName,
      configurationVersion: managed.version,
    },
    workItemId: active.workItemId,
    workItem: source.workItem,
    revision: source.revision,
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: source.revision.baseSha,
      headSha: source.revision.headSha,
    },
    testedSourceAuthorization: null,
    authorization: JSON.parse(epoch.epoch_json as string) as ActiveAuthorizedRequestEpoch,
    authorizationPolicy: policy,
    requests,
    runnerSupport: [],
  };
  const run = handleReviewRunRequest(
    database,
    { operation: "createReviewRun", input: { actor, planInput } },
    now,
  ) as ReviewRunDetail;
  return { ...active, run, requestId: "request-one", profileVersion };
}
function observeRequest(
  database: DatabaseSync,
  fixture: ReturnType<typeof makeRun>,
  at = now,
): SchedulingDiagnostics {
  return present(
    read(
      database,
      "getValidationRequestScheduling",
      {
        repositoryId: fixture.repositoryId,
        reviewRunId: fixture.run.id,
        requestId: fixture.requestId,
      },
      adminContext,
      at,
    ),
  );
}
function snapshot(database: DatabaseSync): string {
  return JSON.stringify(
    [
      "jobs",
      "run_attempts",
      "workers",
      "review_runs",
      "review_run_requests",
      "review_run_job_links",
      "validation_dispatch_checks",
      "validation_dispatch_state",
      "job_admission",
      "scheduling_state",
      "managed_repositories",
      "repository_configuration_audit",
      "platform_scheduling_configuration",
      "platform_scheduling_configuration_audit",
    ].map((table) => ({ table, rows: database.prepare(`SELECT * FROM ${table}`).all() })),
  );
}

function configureLimits(
  database: DatabaseSync,
  repositoryId: string,
  repositoryLimits: SchedulingLimits,
  platformLimits: SchedulingLimits = repositoryLimits,
): void {
  const repository = handleRepositoryConfigurationRequest(
    database,
    { operation: "getManagedRepository", input: { repositoryId } },
    now,
  ) as ManagedRepository;
  handleRepositoryConfigurationRequest(
    database,
    {
      operation: "updateManagedRepository",
      input: {
        repositoryId,
        actor,
        request: { expectedVersion: repository.version, schedulingLimits: repositoryLimits },
      },
    },
    now,
  );
  const platform = readPlatformSchedulingConfiguration(database);
  handleSchedulingConfigurationRequest(
    database,
    {
      operation: "updatePlatformSchedulingConfiguration",
      input: { actor, request: { expectedVersion: platform.version, limits: platformLimits } },
    },
    new Date(Math.max(Date.parse(now), Date.parse(platform.updatedAt))).toISOString(),
    adminContext,
  );
}

describe("current scheduling policy and exact capacity", () => {
  // Distinct immutable priorities represent separate accepted schedules for the same source.
  // Assign them before insertion so every fixture retains the semantic uniqueness constraint.
  it("counts admitted retries, pending Jobs and unreaped cancellation attempts in their exact scope", () => {
    const database = open();
    const fixture = activate(database, 1, "review_request", false);
    cloneJob(database, fixture.jobId, { priority: 2 });
    cloneJob(database, fixture.jobId, {
      priority: 3,
      status: "retry_waiting",
      next_attempt_at: later,
    });
    occupy(database, worker(database), cloneJob(database, fixture.jobId, { priority: 4 }), true);
    occupy(database, worker(database), cloneJob(database, fixture.jobId, { priority: 5 }));
    const foreign = activate(database, 2);
    occupy(database, worker(database), cloneJob(database, foreign.jobId, { priority: 2 }));
    const unmanagedTemplate = canonicalJson(template(event(99)));
    cloneJob(database, fixture.jobId, {
      work_item_id: null,
      request_epoch_id: null,
      source_event_id: null,
      execution_json: unmanagedTemplate,
      execution_digest: sha256(unmanagedTemplate),
    });
    configureLimits(
      database,
      fixture.repositoryId,
      { maxActiveLeases: 1, maxQueuedJobs: 1 },
      { maxActiveLeases: 2, maxQueuedJobs: 3 },
    );
    const previous = snapshot(database);
    const observation = observe(database, fixture);
    expect(observation.policy.repository).toMatchObject({
      repositoryId: fixture.repositoryId,
      enabled: true,
      limits: { maxActiveLeases: 1, maxQueuedJobs: 1 },
      usage: {
        activeLeases: 2,
        admittedQueuedJobs: 2,
        awaitingAdmissionJobs: 1,
        awaitingConfigurationRequests: 0,
      },
      overage: { activeLeases: 1, admittedQueuedJobs: 1 },
    });
    expect(observation.policy.platform).toMatchObject({
      visibility: "full",
      configuration: { limits: { maxActiveLeases: 2, maxQueuedJobs: 3 } },
      usage: {
        activeLeases: 3,
        admittedQueuedJobs: 4,
        awaitingAdmissionJobs: 1,
        awaitingConfigurationRequests: 0,
      },
      overage: { activeLeases: 1, admittedQueuedJobs: 1 },
    });
    expect(observation.reasons).toEqual(
      expect.arrayContaining([
        { code: "repository_queue_limit", effect: "admission_gate" },
        { code: "platform_queue_limit", effect: "admission_gate" },
        { code: "repository_active_limit", effect: "claim_gate" },
        { code: "platform_active_limit", effect: "claim_gate" },
      ]),
    );
    expect(snapshot(database)).toBe(previous);
  });

  it.each([1, 2])(
    "diagnoses the queue boundary at limit %i only for pending admission",
    (maxQueuedJobs) => {
      const database = open();
      const fixture = activate(database, 1, "review_request", false);
      const admittedJob = cloneJob(database, fixture.jobId, { priority: 2 });
      worker(database);
      configureLimits(database, fixture.repositoryId, { maxActiveLeases: null, maxQueuedJobs });
      const pending = observe(database, fixture);
      for (const code of ["repository_queue_limit", "platform_queue_limit"])
        expect(codes(pending).includes(code)).toBe(maxQueuedJobs === 1);
      const admitted = observe(database, { ...fixture, jobId: admittedJob });
      expect(codes(admitted)).not.toContain("repository_queue_limit");
      expect(codes(admitted)).not.toContain("platform_queue_limit");
      expect(admitted.policy.repository?.usage.admittedQueuedJobs).toBe(1);
    },
  );

  it.each([1, 2])(
    "diagnoses the active boundary at limit %i without preempting an existing attempt",
    (maxActiveLeases) => {
      const database = open();
      const fixture = activate(database);
      const activeJob = cloneJob(database, fixture.jobId, { priority: 2 });
      occupy(database, worker(database), activeJob, true);
      configureLimits(database, fixture.repositoryId, { maxActiveLeases, maxQueuedJobs: null });
      const waiting = observe(database, fixture);
      for (const code of ["repository_active_limit", "platform_active_limit"])
        expect(codes(waiting).includes(code)).toBe(maxActiveLeases === 1);
      const executing = observe(database, { ...fixture, jobId: activeJob });
      expect(executing.stage).toBe("executing");
      expect(executing.reasons).toEqual([]);
      expect(executing.policy.repository?.usage.activeLeases).toBe(1);
      updateJob(database, fixture.jobId, { status: "cancelled" });
      const terminal = observe(database, fixture);
      expect(terminal.stage).toBe("terminal");
      expect(terminal.reasons).toEqual([]);
    },
  );

  it("keeps missing-configuration requests separate from accepted Jobs without inventing quota reasons", () => {
    const database = open();
    const fixture = makeRun(database, false);
    handleValidationDispatchRequest(
      database,
      {
        operation: "dispatchReviewRun",
        input: { repositoryId: fixture.repositoryId, reviewRunId: fixture.run.id, actor },
      },
      now,
    );
    configureLimits(database, fixture.repositoryId, { maxActiveLeases: 1, maxQueuedJobs: 1 });
    const observation = observeRequest(database, fixture);
    expect(observation.job).toBeNull();
    expect(observation.policy.repository?.usage).toEqual({
      activeLeases: 0,
      admittedQueuedJobs: 1,
      awaitingAdmissionJobs: 0,
      awaitingConfigurationRequests: 1,
    });
    expect(observation.reasons.every((reason) => !reason.code.endsWith("_limit"))).toBe(true);
    expect(observation.reasons.some((reason) => reason.effect === "admission_gate")).toBe(false);
  });

  it("returns only coarse platform capacity to a repository reader while administrators see full usage", () => {
    const database = open();
    const fixture = activate(database, 1, "review_request", false);
    const foreign = activate(database, 2);
    configureLimits(
      database,
      fixture.repositoryId,
      { maxActiveLeases: null, maxQueuedJobs: null },
      { maxActiveLeases: null, maxQueuedJobs: 1 },
    );
    grant(database, fixture.repositoryId);
    const input = { repositoryId: fixture.repositoryId, jobId: fixture.jobId };
    const restricted = present(read(database, "getRepositoryJobScheduling", input, viewerContext));
    expect(restricted.policy.platform).toEqual({
      visibility: "restricted",
      version: 2,
      activeCapacity: "available",
      queueCapacity: "limited",
    });
    expect(restricted.policy.repository?.usage.admittedQueuedJobs).toBe(0);
    expect(codes(restricted)).toContain("platform_queue_limit");
    expect(JSON.stringify(restricted)).not.toContain(foreign.repositoryId);
    expect(JSON.stringify(restricted)).not.toContain(foreign.jobId);
    const full = present(read(database, "getPlatformJobScheduling", { jobId: fixture.jobId }));
    expect(full.policy.platform).toMatchObject({
      visibility: "full",
      usage: { admittedQueuedJobs: 1 },
    });
    expect(full.policy.repository).toEqual(restricted.policy.repository);
  });

  it("resolves platform-only Legacy policies by upstream identity and keeps unknown upstreams explicit", () => {
    const database = open();
    const fixture = activate(database);
    const known = cloneJob(database, fixture.jobId, {
      work_item_id: null,
      request_epoch_id: null,
      source_event_id: null,
    });
    const unmanagedTemplate = canonicalJson(template(event(99)));
    const unknown = cloneJob(database, fixture.jobId, {
      work_item_id: null,
      request_epoch_id: null,
      source_event_id: null,
      execution_json: unmanagedTemplate,
      execution_digest: sha256(unmanagedTemplate),
    });
    const knownObservation = present(read(database, "getPlatformJobScheduling", { jobId: known }));
    const unknownObservation = present(
      read(database, "getPlatformJobScheduling", { jobId: unknown }),
    );
    expect(knownObservation.subject.kind).toBe("platform_job");
    expect(knownObservation.policy.repository?.repositoryId).toBe(fixture.repositoryId);
    expect(knownObservation.policy.repository?.usage.admittedQueuedJobs).toBe(2);
    expect(unknownObservation.policy.repository).toBeNull();
    expect(unknownObservation.policy.platform).toMatchObject({
      visibility: "full",
      usage: { admittedQueuedJobs: 3 },
    });
  });

  it.each(["platform", "repository"])(
    "fails closed when the current %s policy is missing",
    (scope) => {
      const database = open();
      const fixture = activate(database);
      const previous = snapshot(database);
      const prepare = database.prepare.bind(database);
      const spy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
        if (
          scope === "platform"
            ? sql.includes("FROM platform_scheduling_configuration")
            : sql.includes(
                "max_active_leases, max_queued_jobs FROM managed_repositories WHERE github_repository_id",
              )
        )
          return { setReadBigInts: () => undefined, get: () => undefined } as unknown as ReturnType<
            typeof prepare
          >;
        return prepare(sql);
      });
      expect(() => observe(database, fixture)).toThrow(
        expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
      );
      spy.mockRestore();
      expect(snapshot(database)).toBe(previous);
    },
  );

  it("keeps quota accounting out of trusted candidate readiness and never changes admission on read", () => {
    const database = open();
    const fixture = activate(database, 1, "review_request", false);
    cloneJob(database, fixture.jobId, { priority: 2 });
    const host = worker(database, { maxSlots: 2 });
    occupy(database, host, cloneJob(database, fixture.jobId, { priority: 3 }));
    configureLimits(database, fixture.repositoryId, { maxActiveLeases: 1, maxQueuedJobs: 1 });
    const previous = snapshot(database);
    const prepare = database.prepare.bind(database);
    const spy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
      expect(sql).not.toContain("FROM platform_scheduling_configuration");
      expect(sql).not.toContain("COUNT(CASE WHEN admission.state");
      return prepare(sql);
    });
    const readiness = fixtureTransaction(database, () =>
      inspectJobAdmissionReadinessInTransaction(database, fixture.jobId, now, host.id),
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.reasons).toEqual([]);
    spy.mockRestore();
    expect(snapshot(database)).toBe(previous);
  });
});

describe("current scheduling diagnostics", () => {
  it("observes a newly pending Legacy episode without admitting or assigning it", () => {
    const database = open();
    const fixture = activate(database, 1, "review_request", false);
    const requestedAt = present(
      database.prepare("SELECT created_at FROM jobs WHERE id = ?").get(fixture.jobId),
    ).created_at as string;
    expect(requestedAt).toBe(now);
    worker(database);
    const previous = snapshot(database);
    const observation = observe(database, fixture);
    expect(observation.schemaVersion).toBe("SchedulingDiagnosticsV3");
    expect(Value.Check(SchedulingDiagnosticsV1Schema, observation)).toBe(false);
    expect(observation.job).toMatchObject({
      jobId: fixture.jobId,
      status: "queued",
      attemptCount: 0,
      nextAttemptAt: now,
      admission: {
        state: "pending",
        attemptBase: 0,
        requestedAt,
        timestampBasis: "recorded",
        admittedAt: null,
      },
    });
    expect(observation.reasons).toEqual([{ code: "awaiting_admission", effect: "claim_gate" }]);
    expect(read(database, "getPlatformJobScheduling", { jobId: fixture.jobId })).toEqual(
      observation,
    );
    expect(snapshot(database)).toBe(previous);
  });

  it("clears the pending gate only after the real admission pass accepts the current episode", () => {
    const database = open();
    const fixture = activate(database, 1, "review_request", false);
    const requestedAt = present(
      database.prepare("SELECT created_at FROM jobs WHERE id = ?").get(fixture.jobId),
    ).created_at as string;
    const host = worker(database);
    expect(codes(observe(database, fixture))).toContain("awaiting_admission");
    const admitted = fixtureTransaction(database, () =>
      admitPendingJobsInTransaction(database, { limit: 1, workerId: host.id }, now),
    );
    expect(admitted).toEqual({ examinedJobCount: 1, admittedJobCount: 1 });
    const previous = snapshot(database);
    const observation = observe(database, fixture);
    expect(observation.job?.admission).toEqual({
      state: "admitted",
      attemptBase: 0,
      requestedAt,
      timestampBasis: "recorded",
      admittedAt: now,
    });
    expect(observation.reasons).toEqual([]);
    expect(
      database
        .prepare("SELECT status, attempt_count, current_run_attempt_id FROM jobs WHERE id = ?")
        .get(fixture.jobId),
    ).toEqual({
      status: "queued",
      attempt_count: 0,
      current_run_attempt_id: null,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
    expect(snapshot(database)).toBe(previous);
  });

  it("rejects a waiting Job whose persisted admission belongs to another attempt base", () => {
    const database = open();
    const fixture = activate(database, 1, "review_request", false);
    // Simulate damaged Job metadata without removing admission rows or weakening their guards.
    updateJob(database, fixture.jobId, { attempt_count: 1 });
    const previous = snapshot(database);
    expect(() => observe(database, fixture)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
    expect(snapshot(database)).toBe(previous);
  });

  it("observes a ready queued job without assigning work, changing history or exposing workers", () => {
    const database = open();
    const fixture = activate(database);
    worker(database);
    const previous = snapshot(database);
    const observation = observe(database, fixture);
    expect(observation).toMatchObject({
      stage: "waiting",
      subject: {
        kind: "repository_job",
        repositoryId: fixture.repositoryId,
        workItemId: fixture.workItemId,
        jobId: fixture.jobId,
      },
      reasons: [],
      workerInspection: { state: "complete", latestContactAt: now },
    });
    expect(JSON.stringify(observation)).not.toContain("FOREIGN_WORKER_NAME");
    expect(snapshot(database)).toBe(previous);
    expect(database.isTransaction).toBe(false);
  });

  it("enforces scoped work-item ownership while platform access includes unassociated Legacy jobs", () => {
    const database = open();
    const first = activate(database);
    const second = activate(database, 2);
    grant(database, first.repositoryId);
    expect(
      read(
        database,
        "getRepositoryJobScheduling",
        { repositoryId: first.repositoryId, jobId: second.jobId },
        viewerContext,
      ),
    ).toBeNull();
    expect(() =>
      read(
        database,
        "getRepositoryJobScheduling",
        { repositoryId: second.repositoryId, jobId: second.jobId },
        viewerContext,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(() =>
      read(database, "getPlatformJobScheduling", { jobId: first.jobId }, viewerContext),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
    const orphan = cloneJob(database, first.jobId, {
      work_item_id: null,
      request_epoch_id: null,
      source_event_id: null,
    });
    expect(
      read(database, "getRepositoryJobScheduling", {
        repositoryId: first.repositoryId,
        jobId: orphan,
      }),
    ).toBeNull();
    expect(read(database, "getPlatformJobScheduling", { jobId: orphan })).toMatchObject({
      subject: { kind: "platform_job", jobId: orphan, association: "unassociated_legacy" },
    });
    expect(read(database, "getPlatformJobScheduling", { jobId: first.jobId })?.subject).toEqual({
      kind: "repository_job",
      repositoryId: first.repositoryId,
      workItemId: first.workItemId,
      jobId: first.jobId,
    });
    expect(read(database, "getPlatformJobScheduling", { jobId: "missing" })).toBeNull();
  });

  it("reports pause for associated and unassociated stable upstream identities", () => {
    const database = open();
    const fixture = activate(database);
    worker(database);
    const orphan = cloneJob(database, fixture.jobId, {
      work_item_id: null,
      request_epoch_id: null,
      source_event_id: null,
    });
    database
      .prepare("UPDATE managed_repositories SET enabled = 0 WHERE id = ?")
      .run(fixture.repositoryId);
    expect(codes(observe(database, fixture))).toContain("repository_paused");
    expect(codes(present(read(database, "getPlatformJobScheduling", { jobId: orphan })))).toContain(
      "repository_paused",
    );
  });

  it.each(["leased", "running", "cancel_requested", "failed", "dead_letter", "cancelled", "stale"])(
    "does not diagnose old waiting causes for %s jobs",
    (status) => {
      const database = open();
      const fixture = activate(database);
      if (["leased", "running", "cancel_requested"].includes(status))
        occupy(database, worker(database), fixture.jobId, status === "cancel_requested");
      if (status === "leased")
        database
          .prepare("UPDATE run_attempts SET status = 'leased' WHERE job_id = ?")
          .run(fixture.jobId);
      updateJob(database, fixture.jobId, {
        status,
        next_attempt_at: later,
      });
      const observation = observe(database, fixture);
      expect(observation.stage).toBe(
        ["leased", "running", "cancel_requested"].includes(status) ? "executing" : "terminal",
      );
      expect(observation.reasons).toEqual([]);
      expect(observation.workerInspection).toEqual({
        state: "not_applicable",
        latestContactAt: null,
      });
      expect(observation.job?.nextAttemptAt).toBeNull();
      expect(observation.job?.admission).toBeNull();
    },
  );

  it("reads a succeeded Job after its complete immutable review result is persisted", () => {
    const database = open();
    const original = activate(database);
    const execution = {
      ...original.template,
      prompt: {
        ...original.template.prompt,
        outputSchema: PrReviewPlanV1ModelOutputSchema,
        outputSchemaSha256: sha256(canonicalJson(PrReviewPlanV1ModelOutputSchema)),
      },
    };
    const fixture = variant(database, original, { execution_json: canonicalJson(execution) });
    occupy(database, worker(database), fixture.jobId);
    const stored = present(
      database
        .prepare(
          "SELECT current_run_attempt_id, execution_json, execution_digest, resource_revision FROM jobs WHERE id = ?",
        )
        .get(fixture.jobId),
    );
    const revision = present(
      database
        .prepare(
          "SELECT id, base_sha, head_sha FROM work_item_revisions WHERE work_item_id = ? AND revision_key = ?",
        )
        .get(fixture.workItemId, stored.resource_revision as string),
    );
    const context: ReviewCompletionJobContext = {
      jobId: fixture.jobId,
      runAttemptId: stored.current_run_attempt_id as string,
      jobKind: "pull_request_review",
      workItemId: fixture.workItemId,
      workItemResourceKind: "pull_request",
      resourceRevision: stored.resource_revision as string,
      revisionId: revision.id as string,
      revisionResourceKind: "pull_request",
      revisionBaseSha: revision.base_sha as string,
      revisionHeadSha: revision.head_sha as string,
      executionJson: stored.execution_json as string,
      executionDigest: stored.execution_digest as string,
    };
    const deadline = new Date(Date.parse(now) + 120_000).toISOString();
    database
      .prepare(
        "UPDATE run_attempts SET started_at = ?, last_heartbeat_at = ?, lease_expires_at = ?, execution_deadline_at = ?, no_progress_deadline_at = ? WHERE id = ?",
      )
      .run(
        now,
        now,
        deadline,
        deadline,
        new Date(Date.parse(now) + 30_000).toISOString(),
        context.runAttemptId,
      );
    updateJob(database, fixture.jobId, { started_at: now });
    const result = {
      schemaVersion: "PrReviewPlanV1",
      summary: "The isolated review completed.",
      assessment: "comment",
      findings: [],
      requestedRecipeIds: [],
    };
    const canonical = canonicalizeReviewResultSubmission(result);
    const validated = validateReviewCompletion(context, canonical.resultDigest, result, canonical);
    database.exec("BEGIN");
    try {
      database
        .prepare(
          "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
        )
        .run(validated.resultDigest, validated.canonicalResultJson, now, context.runAttemptId);
      expect(() => updateJob(database, fixture.jobId, { status: "succeeded" })).toThrow(
        /immutable review result/u,
      );
      persistValidatedReviewResult(database, context, validated, now);
      updateJob(database, fixture.jobId, {
        status: "succeeded",
        current_run_attempt_id: null,
        completed_at: now,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const previous = snapshot(database);
    const observation = observe(database, fixture);
    expect(observation).toMatchObject({
      stage: "terminal",
      job: { status: "succeeded", admission: null },
      reasons: [],
      workerInspection: { state: "not_applicable", latestContactAt: null },
    });
    expect(snapshot(database)).toBe(previous);
  });

  it("separates retry time, attempt limit and an attached current attempt", () => {
    const database = open();
    const fixture = variant(database, activate(database), {
      intent_version: 2,
      status: "retry_waiting",
      next_attempt_at: later,
      attempt_count: 3,
    });
    worker(database);
    updateJob(database, fixture.jobId, {
      current_run_attempt_id: "stale-attempt",
    });
    const observation = observe(database, fixture);
    expect(observation.reasons).toEqual(
      expect.arrayContaining([
        { code: "retry_backoff", effect: "claim_gate", until: later },
        { code: "attempt_limit_reached", effect: "claim_gate" },
        { code: "current_attempt_attached", effect: "claim_gate" },
      ]),
    );
    expect(codes(observe(database, fixture, later))).not.toContain("retry_backoff");
  });

  it("keeps expired unreaped cancellation attempts in Worker occupancy without exposing the foreign holder", () => {
    const database = open();
    const own = activate(database);
    const foreign = activate(database, 2);
    const host = worker(database);
    occupy(database, host, foreign.jobId, true);
    const previous = snapshot(database);
    const observation = observe(database, own);
    expect(codes(observation)).toContain("worker_slots_occupied");
    for (const secret of [
      foreign.repositoryId,
      foreign.jobId,
      host.node,
      host.id,
      "FOREIGN_WORKER_NAME",
    ])
      expect(JSON.stringify(observation)).not.toContain(secret);
    expect(snapshot(database)).toBe(previous);
  });

  it("reports a foreign concurrency holder without returning its identity", () => {
    const database = open();
    const own = activate(database);
    const foreign = activate(database, 2);
    const host = worker(database, { maxSlots: 2 });
    const key = present(
      database.prepare("SELECT concurrency_key FROM jobs WHERE id = ?").get(own.jobId),
    ).concurrency_key as string;
    updateJob(database, foreign.jobId, { concurrency_key: key });
    occupy(database, host, foreign.jobId);
    const observation = observe(database, own);
    expect(codes(observation)).toContain("concurrency_busy");
    expect(JSON.stringify(observation)).not.toContain(foreign.jobId);
  });

  it("uses existing Legacy recursive-object and array capability semantics", () => {
    const database = open();
    let fixture = activate(database);
    worker(database, { labels: { "tool.dotnet": "1", executionEnvelope: "2" } });
    fixture = variant(database, fixture, {
      required_capabilities_json: JSON.stringify(["tool.dotnet"]),
    });
    expect(codes(observe(database, fixture))).not.toContain("no_compatible_worker");
    fixture = variant(database, fixture, {
      required_capabilities_json: JSON.stringify({ labels: { executionEnvelope: "2" } }),
    });
    expect(observe(database, fixture).requirements.names).toEqual(["labels.executionEnvelope"]);
    fixture = variant(database, fixture, {
      required_capabilities_json: JSON.stringify({ labels: { executionEnvelope: "3" } }),
    });
    expect(codes(observe(database, fixture))).toContain("no_compatible_worker");
  });

  it.each([
    { status: "offline" },
    { status: "draining" },
    { status: "disabled" },
    { auth: "revoked" },
    { auth: "pending" },
    { protocol: "0.9" },
  ])("reports compatible unavailable Workers from committed state %j", (options) => {
    const database = open();
    const fixture = activate(database);
    worker(database, options);
    expect(codes(observe(database, fixture))).toContain("compatible_worker_unavailable");
  });

  it("distinguishes no registrations and an unavailable affinity", () => {
    const database = open();
    const fixture = activate(database);
    expect(codes(observe(database, fixture))).toContain("no_registered_worker");
    worker(database);
    updateJob(database, fixture.jobId, { execution_affinity_node_id: "unobserved-private-node" });
    const affinity = observe(database, fixture);
    expect(codes(affinity)).toContain("affinity_worker_unavailable");
    expect(JSON.stringify(affinity)).not.toContain("unobserved-private-node");
  });

  it("does not confuse registration's default zero with an actual capacity report", () => {
    const database = open();
    const fixture = activate(database);
    const host = worker(database, { availableSlots: 0, health: false });
    expect(codes(observe(database, fixture))).not.toContain("worker_capacity_unavailable");
    database
      .prepare("UPDATE workers SET health_json = ? WHERE id = ?")
      .run(canonicalJson({ state: "online", freeDiskBytes: 1, memoryUsageBytes: 1 }), host.id);
    const known = observe(database, fixture);
    expect(known.reasons).toContainEqual({
      code: "worker_capacity_unavailable",
      effect: "observation",
    });
    database.prepare("UPDATE workers SET health_json = '{}' WHERE id = ?").run(host.id);
    expect(codes(observe(database, fixture))).not.toContain("worker_capacity_unavailable");
  });

  it("does not infer all local capacity is zero when another compatible Worker has no report", () => {
    const database = open();
    const fixture = activate(database);
    worker(database, { availableSlots: 0 });
    worker(database, { availableSlots: 0, health: false });
    expect(codes(observe(database, fixture))).not.toContain("worker_capacity_unavailable");
  });

  it("bounds inventory to 128 checks and never turns partial absence into a blocker", () => {
    const database = open();
    const fixture = variant(database, activate(database), {
      required_capabilities_json: JSON.stringify(["tool.required"]),
    });
    for (let index = 0; index < 129; index++)
      worker(database, {
        id: `worker-${index.toString().padStart(3, "0")}`,
        availableSlots: 0,
        labels: index === 128 ? { "tool.required": "1" } : {},
      });
    const observation = observe(database, fixture);
    expect(observation.workerInspection.state).toBe("partial");
    expect(codes(observation)).toContain("inspection_incomplete");
    for (const reason of [
      "no_registered_worker",
      "no_compatible_worker",
      "compatible_worker_unavailable",
      "worker_slots_occupied",
      "worker_capacity_unavailable",
    ])
      expect(codes(observation)).not.toContain(reason);
    expect(Object.keys(observation.workerInspection).sort()).toEqual(["latestContactAt", "state"]);
  });

  it("retains canonical contact and creation times when the server clock moves backwards", () => {
    const database = open();
    const fixture = activate(database);
    worker(database, { at: later });
    const recorded = present(
      database.prepare("SELECT created_at FROM jobs WHERE id = ?").get(fixture.jobId),
    ).created_at as string;
    const observation = observe(
      database,
      fixture,
      new Date(Date.parse(recorded) - 1000).toISOString(),
    );
    expect(observation.job?.createdAt).toBe(recorded);
    expect(observation.workerInspection.latestContactAt).toBe(later);
  });

  it("reports malformed templates without dead-lettering them or exposing payload text", () => {
    const database = open();
    const fixture = variant(database, activate(database), {
      execution_json: '{"PRIVATE_PAYLOAD":',
    });
    const previous = snapshot(database);
    const observation = observe(database, fixture);
    expect(codes(observation)).toContain("invalid_job_configuration");
    expect(JSON.stringify(observation)).not.toContain("PRIVATE_PAYLOAD");
    expect(snapshot(database)).toBe(previous);
  });

  it("does not expose requirement names from an execution snapshot for another repository", () => {
    const database = open();
    let fixture = activate(database);
    const wrong = {
      ...fixture.template,
      repository: { githubRepositoryId: 2, fullName: "example/project-2" },
    };
    fixture = variant(database, fixture, {
      execution_json: canonicalJson(wrong),
      required_capabilities_json: '["PRIVATE_FOREIGN_REQUIREMENT"]',
    });
    expect(() => observe(database, fixture)).toThrow(
      expect.objectContaining({
        code: "PLATFORM_CORRUPT",
        message: "The stored scheduling observation is invalid.",
      }),
    );
  });

  it("bounds own requirement names and honestly omits names that cannot fit the display contract", () => {
    const database = open();
    let fixture = variant(database, activate(database), {
      required_capabilities_json: JSON.stringify(
        Array.from({ length: 70 }, (_, index) => `tool.${index}`),
      ),
    });
    expect(observe(database, fixture).requirements).toMatchObject({
      names: expect.any(Array),
      truncated: true,
    });
    expect(observe(database, fixture).requirements.names).toHaveLength(64);
    fixture = variant(database, fixture, {
      required_capabilities_json: JSON.stringify(["valid", "x".repeat(129)]),
    });
    expect(observe(database, fixture).requirements).toEqual({ names: ["valid"], truncated: true });
  });

  it("recognizes any active Legacy epoch and labels source changes as prerequisites, not claim gates", () => {
    const database = open();
    const fixture = activate(database);
    const secondary = activate(database, 1, "assignment");
    worker(database);
    expect(secondary.jobId).toBe(fixture.jobId);
    database
      .prepare(
        "UPDATE request_epochs SET status = 'closed', closing_event_id = opening_event_id, close_reason = 'review_request_removed', closed_at = ? WHERE id = ?",
      )
      .run(now, fixture.epochId);
    expect(codes(observe(database, fixture))).not.toContain("authorization_changed");
    database.prepare("UPDATE work_items SET state = 'closed' WHERE id = ?").run(fixture.workItemId);
    expect(observe(database, fixture).reasons).toContainEqual({
      code: "source_obsolete",
      effect: "current_prerequisite",
    });
  });

  it("keeps authorization and all final reads in the same synchronous snapshot", () => {
    const database = open();
    const fixture = activate(database);
    worker(database);
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      expect(database.isTransaction).toBe(true);
      return prepare(sql);
    });
    observe(database, fixture);
    expect(database.isTransaction).toBe(false);
    database.exec("BEGIN");
    observe(database, fixture);
    expect(database.isTransaction).toBe(true);
    database.exec("ROLLBACK");
  });
});

describe("pending validation request scheduling", () => {
  it("distinguishes no Job and frozen missing configuration from a queued Job", () => {
    const database = open();
    const fixture = makeRun(database, false);
    const observation = observeRequest(database, fixture);
    expect(observation).toMatchObject({
      stage: "waiting",
      job: null,
      subject: { kind: "validation_request", requestId: "request-one" },
    });
    expect(observation.reasons).toEqual(
      expect.arrayContaining([
        {
          code: "plan_prerequisite_missing",
          effect: "current_prerequisite",
          requirement: "missing_profile",
        },
        {
          code: "plan_prerequisite_missing",
          effect: "current_prerequisite",
          requirement: "missing_prompt",
        },
      ]),
    );
    expect(observation.reasons.some((reason) => reason.effect === "claim_gate")).toBe(false);
  });

  it("recomputes runtime readiness rather than reusing historical blockers", () => {
    const database = open();
    const fixture = makeRun(database);
    expect(codes(observeRequest(database, fixture))).toContain("no_registered_worker");
    worker(database, {
      labels: { executionEnvelope: "2", validationHeadless: "1" },
      availableSlots: 0,
    });
    const previous = snapshot(database);
    const observation = observeRequest(database, fixture);
    expect(observation.job).toBeNull();
    expect(observation.reasons).toEqual([]);
    expect(snapshot(database)).toBe(previous);
  });

  it("requires one matching Worker rather than combining capabilities across machines", () => {
    const database = open();
    const fixture = makeRun(database, true, ["tool.one", "tool.two"]);
    worker(database, {
      labels: { executionEnvelope: "2", validationHeadless: "1", "tool.one": "1" },
    });
    worker(database, {
      labels: { executionEnvelope: "2", validationHeadless: "1", "tool.two": "1" },
    });
    expect(observeRequest(database, fixture).reasons).toContainEqual({
      code: "no_compatible_worker",
      effect: "current_prerequisite",
    });
  });

  it("uses the latest request Job, including its terminal state", () => {
    const database = open();
    const fixture = makeRun(database);
    worker(database, { labels: { executionEnvelope: "2", validationHeadless: "1" } });
    const dispatched = handleValidationDispatchRequest(
      database,
      {
        operation: "dispatchReviewRun",
        input: { repositoryId: fixture.repositoryId, reviewRunId: fixture.run.id, actor },
      },
      now,
    ) as ValidationDispatchResult;
    const first = present(dispatched.createdJobs[0]);
    const pending = observeRequest(database, fixture);
    expect(pending.job?.jobId).toBe(first.jobId);
    expect(pending.job?.admission).toMatchObject({ state: "pending", attemptBase: 0 });
    expect(codes(pending)).toContain("awaiting_admission");
    updateJob(database, first.jobId, { status: "cancelled" });
    const rerun = handleValidationDispatchRequest(
      database,
      {
        operation: "rerunValidationRequest",
        input: {
          repositoryId: fixture.repositoryId,
          reviewRunId: fixture.run.id,
          requestId: fixture.requestId,
          activationId: "rerun-two",
          actor,
        },
      },
      later,
    ) as { jobId: string };
    updateJob(database, rerun.jobId, { status: "cancelled" });
    const observation = observeRequest(database, fixture, later);
    expect(observation.job?.jobId).toBe(rerun.jobId);
    expect(observation.job?.status).toBe("cancelled");
    expect(observation.job?.admission).toBeNull();
    expect(observation.stage).toBe("terminal");
    expect(observation.reasons).toEqual([]);
  });

  it("reports changed current authorization without pretending claim enforcement exists", () => {
    const database = open();
    const fixture = makeRun(database);
    worker(database, { labels: { executionEnvelope: "2", validationHeadless: "1" } });
    const dispatched = handleValidationDispatchRequest(
      database,
      {
        operation: "dispatchReviewRun",
        input: { repositoryId: fixture.repositoryId, reviewRunId: fixture.run.id, actor },
      },
      now,
    ) as ValidationDispatchResult;
    const job = present(dispatched.createdJobs[0]);
    database
      .prepare("UPDATE managed_repositories SET reviewer_github_user_id = 101 WHERE id = ?")
      .run(fixture.repositoryId);
    const observation = observe(database, { repositoryId: fixture.repositoryId, jobId: job.jobId });
    expect(observation.reasons).toContainEqual({
      code: "authorization_changed",
      effect: "current_prerequisite",
    });
  });

  it("does not resolve another repository or nonexistent request via a valid Run id", () => {
    const database = open();
    const fixture = makeRun(database);
    const other = activate(database, 2);
    expect(
      read(database, "getValidationRequestScheduling", {
        repositoryId: other.repositoryId,
        reviewRunId: fixture.run.id,
        requestId: fixture.requestId,
      }),
    ).toBeNull();
    expect(
      read(database, "getValidationRequestScheduling", {
        repositoryId: fixture.repositoryId,
        reviewRunId: fixture.run.id,
        requestId: "missing",
      }),
    ).toBeNull();
  });
});

describe("scheduling inspection budgets", () => {
  it.each(["execution_json", "required_capabilities_json"])(
    "does not turn oversized raw %s whitespace into an invented claim gate",
    (column) => {
      const database = open();
      let fixture = activate(database);
      const original = present(
        database.prepare(`SELECT ${column} AS value FROM jobs WHERE id = ?`).get(fixture.jobId),
      ).value as string;
      fixture = variant(database, fixture, { [column]: " ".repeat(16 * 1024 * 1024) + original });
      const observation = observe(database, fixture);
      expect(observation.workerInspection.state).toBe("partial");
      expect(codes(observation)).toContain("inspection_incomplete");
      expect(codes(observation)).not.toContain("invalid_job_configuration");
    },
  );

  it("bounds array and object requirement traversal without returning the entire raw input", () => {
    const database = open();
    let fixture = activate(database);
    const many = Array.from({ length: 12_000 }, (_, index) => `tool.${index}`);
    fixture = variant(database, fixture, { required_capabilities_json: canonicalJson(many) });
    expect(observe(database, fixture).requirements).toMatchObject({ truncated: true });
    fixture = variant(database, fixture, {
      required_capabilities_json: canonicalJson(
        Object.fromEntries(many.map((name) => [name, true])),
      ),
    });
    expect(observe(database, fixture).requirements.names).toHaveLength(64);
    expect(observe(database, fixture).requirements.truncated).toBe(true);
  });

  it("uses the same final claim envelope gate for invalid stored job metadata", () => {
    const database = open();
    const original = activate(database);
    const intent = present(
      database.prepare("SELECT intent_version FROM jobs WHERE id = ?").get(original.jobId),
    ).intent_version as number;
    const fixture = variant(database, original, {
      semantic_key: "x".repeat(1025),
      intent_version: intent + 1,
    });
    worker(database);
    const previous = snapshot(database);
    expect(codes(observe(database, fixture))).toContain("invalid_job_configuration");
    expect(snapshot(database)).toBe(previous);
  });

  it("stops repeated large envelope projections without inventing a claim failure", () => {
    const database = open();
    let fixture = activate(database);
    const large = {
      ...fixture.template,
      resource: {
        ...fixture.template.resource,
        canonicalSnapshot: { padding: "x".repeat(12 * 1024 * 1024) },
      },
    };
    fixture = variant(database, fixture, { execution_json: JSON.stringify(large) });
    for (let index = 1; index <= 8; index++)
      worker(database, { id: `worker-${"a".repeat(index)}` });
    const observation = observe(database, fixture);
    expect(observation.workerInspection.state).toBe("partial");
    expect(codes(observation)).toContain("inspection_incomplete");
    expect(codes(observation)).not.toContain("invalid_job_configuration");
  });
});

describe("scheduling diagnostic intersections", () => {
  it("requires free slots and an admissible wire envelope on the same Worker", () => {
    const database = open();
    let fixture = activate(database);
    const foreign = activate(database, 2);
    const occupied = worker(database, { id: "a" });
    const free = worker(database, { id: "b".repeat(110) });
    occupy(database, occupied, foreign.jobId);
    const finalJobId = randomUUID();
    const candidate = {
      ...present(database.prepare("SELECT * FROM jobs WHERE id = ?").get(fixture.jobId)),
      id: finalJobId,
      semantic_key: finalJobId,
    } as unknown as SchedulingClaimCandidate;
    const bare: JobExecutionTemplate = {
      ...fixture.template,
      resource: { ...fixture.template.resource, canonicalSnapshot: { padding: "" } },
    };
    const assignment = {
      protocolVersion: "1.0",
      assignedAt: now,
      leaseExpiresAt: "2026-09-07T12:02:00.000Z",
      executionDeadlineAt: "2026-09-07T12:02:00.000Z",
      workerNodeId: occupied.node,
      workerInstanceId: occupied.instance,
      runAttemptId: "00000000-0000-4000-8000-000000000000",
      leaseToken: "a".repeat(43),
      leaseGeneration: 1,
    };
    const baseline = prepareClaimExecutionEnvelope(bare, candidate, assignment);
    if (!baseline.ok) throw new Error("The envelope fixture is invalid.");
    const bytes = Buffer.byteLength(
      JSON.stringify({ outcome: "granted", envelope: baseline.envelope, serverTime: now }),
    );
    const large: JobExecutionTemplate = {
      ...bare,
      resource: {
        ...bare.resource,
        canonicalSnapshot: {
          padding: "x".repeat(maximumClaimLeaseResponseUtf8Bytes - bytes - 100),
        },
      },
    };
    expect(prepareClaimExecutionEnvelope(large, candidate, assignment).ok).toBe(true);
    expect(
      prepareClaimExecutionEnvelope(large, candidate, {
        ...assignment,
        workerNodeId: free.node,
        workerInstanceId: free.instance,
      }).ok,
    ).toBe(false);
    fixture = variant(database, fixture, {
      id: finalJobId,
      semantic_key: finalJobId,
      execution_json: JSON.stringify(large),
    });
    const observation = observe(database, fixture);
    expect(codes(observation)).toContain("worker_slots_occupied");
    expect(codes(observation)).not.toContain("invalid_job_configuration");
  });

  it("observes the current Run association cap for an otherwise ready request without a Job", () => {
    const database = open();
    const fixture = makeRun(database, true, ["tool.required"], true);
    worker(database, { labels: { executionEnvelope: "2", validationHeadless: "1" } });
    // M28 dispatch creates both structurally complete requests before Worker admission.
    // Seed only request-two's history through the frozen-template and association boundaries,
    // leaving request-one as a real, structurally ready request that has not been dispatched.
    const execution = createValidationExecutionTemplate({
      runId: fixture.run.id,
      plan: fixture.run.plan,
      planDigest: fixture.run.planDigest,
      requestId: "request-two",
      jobActivation: 1,
      frozenPrompt: present(
        getReviewRunPromptEnvelope(database, {
          repositoryId: fixture.repositoryId,
          reviewRunId: fixture.run.id,
          requestId: "request-two",
        }),
      ),
    });
    const encoded = canonicalJson(execution);
    const required = canonicalJson({ labels: execution.executionPolicy.requiredCapabilityLabels });
    const selected = fixtureTransaction(database, () => {
      const jobId = cloneJob(database, fixture.jobId, {
        activation: 1,
        execution_json: encoded,
        execution_digest: sha256(encoded),
        required_capabilities_json: required,
        required_capabilities_digest: sha256(required),
      });
      associateReviewRunJobInTransaction(
        database,
        {
          repositoryId: fixture.repositoryId,
          reviewRunId: fixture.run.id,
          requestId: "request-two",
          jobId,
          actor,
        },
        now,
      );
      return { jobId };
    });
    expect(
      database
        .prepare("SELECT request_id FROM review_run_job_links WHERE review_run_id = ?")
        .all(fixture.run.id),
    ).toEqual([{ request_id: "request-two" }]);
    updateJob(database, selected.jobId, { status: "cancelled" });
    // Synthetic history uses the actual M14 identity guards for every association.
    database.exec("BEGIN");
    try {
      for (let activation = 2; activation <= maximumReviewRunJobAssociationCount; activation++) {
        const encoded = canonicalJson({
          ...execution,
          validation: { ...execution.validation, jobActivation: activation },
        });
        const id = cloneJob(database, selected.jobId, {
          status: "queued",
          activation,
          execution_json: encoded,
          execution_digest: sha256(encoded),
        });
        database
          .prepare(
            "INSERT INTO review_run_job_links (review_run_id, request_id, activation_number, job_id, linked_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(fixture.run.id, "request-two", activation, id, now);
        updateJob(database, id, { status: "cancelled" });
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    worker(database, {
      labels: { executionEnvelope: "2", validationHeadless: "1", "tool.required": "1" },
    });
    const observation = observeRequest(database, fixture);
    expect(observation.job).toBeNull();
    expect(observation.reasons).toEqual([
      {
        code: "plan_prerequisite_missing",
        effect: "current_prerequisite",
        requirement: "job_association_limit",
      },
    ]);
    expect(codes(observation)).not.toContain("no_compatible_worker");
  }, 30_000);

  it("uses indexed bounded identity reads before inspecting a large Worker history", () => {
    const database = open();
    const fixture = variant(database, activate(database), {
      required_capabilities_json: '["tool.required"]',
    });
    const current = worker(database, { id: "current", labels: { "tool.required": "1" } });
    for (let index = 0; index < 1_500; index++)
      worker(database, { id: `historical-${index}`, status: "offline", at: later });
    const statements: string[] = [];
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      statements.push(sql);
      return prepare(sql);
    });
    const observation = observe(database, fixture);
    expect(observation.workerInspection).toEqual({ state: "partial", latestContactAt: now });
    const identities = present(
      statements.find((sql) => sql.startsWith("SELECT id FROM workers WHERE status")),
    );
    const payload = present(statements.find((sql) => sql.includes("worker.id IN (")));
    expect(payload.match(/\?/gu)).toHaveLength(128);
    expect(statements.every((sql) => !sql.includes("ORDER BY CASE"))).toBe(true);
    vi.restoreAllMocks();
    const plan = JSON.stringify(
      database.prepare(`EXPLAIN QUERY PLAN ${identities}`).all("offline", 129),
    );
    expect(plan).toContain("ix_workers_status_last_seen");
    expect(plan).not.toContain("TEMP B-TREE");
    updateJob(database, fixture.jobId, { execution_affinity_node_id: current.node });
    const affinitySql = "SELECT id FROM workers WHERE node_id = ? ORDER BY instance_id LIMIT ?";
    const affinityPlan = JSON.stringify(
      database.prepare(`EXPLAIN QUERY PLAN ${affinitySql}`).all(current.node, 129),
    );
    expect(affinityPlan).toContain("INDEX");
    expect(affinityPlan).not.toContain("TEMP B-TREE");
    expect(observe(database, fixture).workerInspection.state).toBe("complete");
    const activePlan = JSON.stringify(
      database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM run_attempts WHERE worker_id = ? AND worker_instance_id = ? AND status IN ('leased', 'running')",
        )
        .all(current.id, current.instance),
    );
    expect(activePlan).toContain("ix_run_attempts_worker");
  });
});
