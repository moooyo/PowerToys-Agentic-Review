import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  ActiveAuthorizedRequestEpoch,
  GitHubRepository,
  JobExecutionTemplateV2,
  ManagedRepository,
  PromptVersion,
  ReviewRunPlanInput,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
  ValidationProfileConfig,
  ValidationProfileCreateRequest,
  ValidationProfileVersion,
  ValidationTarget,
  WorkerCapabilities,
  WorkerState,
} from "@agentic-review/contracts";
import { evaluateReviewRunPlanReadiness } from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import {
  type ConfigurationActor,
  handlePromptConfigurationRequest,
  type PromptConfigurationOperation,
  type PromptConfigurationOperationMap,
  type PromptConfigurationRequest,
} from "./prompt-configuration.js";
import { handleReviewRunRequest, type ReviewRunDetail } from "./review-runs.js";
import {
  cancelValidationJobInTransaction,
  dispatchPendingReviewRunsInTransaction,
  dispatchReviewRunInTransaction,
  getValidationRunnerSupport,
  handleValidationDispatchRequest,
  isValidationDispatchOperation,
  rerunValidationRequestInTransaction,
} from "./validation-dispatch.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));

const now = "2026-09-07T12:00:00.000Z";
const later = "2026-09-07T12:00:01.000Z";
const latest = "2026-09-07T12:00:02.000Z";
const actor: ConfigurationActor = {
  issuer: "https://identity.example.test",
  subject: "validation-operator",
};
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const databases: DatabaseSync[] = [];

interface CreatedJob {
  requestId: string;
  jobId: string;
  jobActivation: number;
}

interface DispatchResult {
  repositoryId: string;
  reviewRunId: string;
  createdJobs: CreatedJob[];
  blockedRequests: { requestId: string; reasons: unknown[] }[];
  alreadyAssociatedRequestIds: string[];
}

interface PendingResult {
  examinedRequestCount: number;
  createdJobs: (CreatedJob & { repositoryId: string; reviewRunId: string })[];
  blockedRequestCount: number;
}

interface RerunResult extends CreatedJob {
  repositoryId: string;
  reviewRunId: string;
  replayed: boolean;
}

interface CancelResult {
  repositoryId: string;
  reviewRunId: string;
  requestId: string;
  jobId: string;
  jobState: string;
  changed: boolean;
}

interface JobRow {
  id: string;
  status: string;
  work_item_id: string;
  request_epoch_id: string;
  concurrency_key: string;
  execution_json: string;
  execution_digest: string;
  required_capabilities_json: string;
  attempt_count: number;
  lease_generation: number;
  current_run_attempt_id: string | null;
  cancellation_requested_at: string | null;
  completed_at: string | null;
}

interface ProfileSpec {
  requestId: string;
  target?: ValidationTarget;
  requiredCapabilities?: string[];
  probe?: boolean;
  traceOff?: boolean;
  missingProfile?: boolean;
  missingPrompt?: boolean;
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The fixture value is missing.");
  return value;
}

function count(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
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

function repository(number: number): GitHubRepository {
  return {
    githubRepositoryId: number,
    githubNodeId: `repository-${number}`,
    ownerLogin: "example",
    name: `project-${number}`,
    fullName: `example/project-${number}`,
    htmlUrl: `https://github.com/example/project-${number}`,
    defaultBranch: "main",
    isPrivate: false,
  };
}

function requestEvent(
  repositoryNumber: number,
  number: number,
  requestKind: "review_request" | "assignment" = "review_request",
): SchedulingRequestOpenedEvent {
  const metadata = repository(repositoryNumber);
  const githubWorkItemId = repositoryNumber * 1000 + number;
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  return {
    contractVersion: 1,
    eventId: `event-${githubWorkItemId}-${requestKind}`,
    source: "webhook",
    sourceEventId: `delivery-${githubWorkItemId}-${requestKind}`,
    occurredAt: now,
    observedAt: now,
    repository: metadata,
    action: "request_opened",
    requestKind,
    actor: reviewer,
    target: reviewer,
    author: reviewer,
    workItem: {
      kind: "pull_request",
      githubWorkItemId,
      githubNodeId: `PR_${githubWorkItemId}`,
      githubRepositoryId: repositoryNumber,
      number,
      title: "Validate the settings panel",
      body: "Update the settings panel.",
      state: "open",
      author: reviewer,
      htmlUrl: `${metadata.htmlUrl}/pull/${number}`,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      isDraft: false,
    },
    revision: {
      kind: "pull_request",
      githubRepositoryId: repositoryNumber,
      githubWorkItemId,
      revisionKey: sha256(`${baseSha}\0${headSha}`),
      baseSha,
      headSha,
      observedAt: now,
      sourceUpdatedAt: now,
    },
  };
}

function activate(database: DatabaseSync, event: SchedulingRequestOpenedEvent) {
  if (event.workItem.kind !== "pull_request" || event.revision.kind !== "pull_request") {
    throw new Error("The dispatch fixture requires a pull request.");
  }
  const renderedPrompt = "Review the exact pull request.";
  return ingestSchedulingEvent(database, {
    allowScheduling: true,
    event,
    policy,
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: "pull_request",
      payloadSha256: sha256(canonicalJson(event)),
      receivedAt: now,
    },
    schedule: {
      jobKind: "pull_request_review",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 1,
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
          author: reviewer,
          canonicalSnapshot: event.workItem,
          baseSha: event.revision.baseSha,
          headSha: event.revision.headSha,
          isDraft: false,
        },
        prompt: {
          name: "legacy-review",
          version: "fixture",
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          outputSchema: {},
          outputSchemaSha256: sha256("{}"),
        },
        executionPolicy: {
          hardTimeoutMs: 120_000,
          noProgressTimeoutMs: 30_000,
          allowedRecipeIds: [],
          requiredCapabilityLabels: {},
        },
      },
    },
  });
}

function profileConfig(target: ValidationTarget, capabilities: string[]): ValidationProfileConfig {
  const config: ValidationProfileConfig = {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: [
      {
        id: "compile",
        name: "Compile the fixture",
        command: { executable: "dotnet", args: ["build"], workingDirectory: ".", environment: [] },
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
  };
  if (target === "headless") return config;
  config.launch = [
    {
      id: "launch",
      name: "Launch the fixture",
      command: {
        executable: "node",
        args: ["fixture.mjs"],
        workingDirectory: ".",
        environment: [],
      },
      timeoutMs: 30_000,
      required: true,
    },
  ];
  const scenario = {
    id: "settings",
    name: "Settings is available",
    required: true,
    timeoutMs: 20_000,
  };
  const assertion = {
    id: "settings-visible",
    name: "Settings is visible",
    action: "assertVisible" as const,
    expected: true,
    timeoutMs: 5_000,
  };
  config.ui =
    target === "web"
      ? {
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
            readiness: { kind: "http", path: "/health", expectedStatus: 200, timeoutMs: 10_000 },
          },
          reset: { strategy: "restart_process" },
          scenarios: [
            {
              ...scenario,
              path: "/settings",
              steps: [{ ...assertion, locator: { by: "testId", testId: "settings" } }],
            },
          ],
          evidence: {
            screenshots: "every_assertion",
            screenshotScope: "viewport",
            trace: "on_failure",
            required: true,
          },
        }
      : {
          schemaVersion: "UiScenariosV1",
          target: "windows_desktop",
          desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
          launch: {
            stepId: "launch",
            mode: "persistent",
            readiness: { kind: "window", window: { title: "Settings" }, timeoutMs: 10_000 },
          },
          reset: { strategy: "restart_process" },
          scenarios: [
            {
              ...scenario,
              steps: [{ ...assertion, locator: { by: "automationId", automationId: "settings" } }],
            },
          ],
          evidence: {
            screenshots: "every_assertion",
            screenshotScope: "owned_window",
            required: true,
          },
        };
  return config;
}

function publishProfile(
  database: DatabaseSync,
  repositoryId: string,
  spec: ProfileSpec,
): ValidationProfileVersion {
  const target = spec.target ?? "headless";
  const common = {
    name: `Profile ${spec.requestId}`,
    config: profileConfig(target, spec.requiredCapabilities ?? []),
    required: true,
  };
  if (spec.probe)
    common.config.test.push({
      id: "observe",
      name: "Observe the fixture",
      required: true,
      timeoutMs: 30_000,
      command: {
        executable: "node",
        args: ["observe.mjs"],
        workingDirectory: ".",
        environment: [],
      },
      probeOutput: {
        schemaVersion: "TestProbeOutputDeclarationV1",
        fields: [
          { id: "visible", description: "Whether the control is visible.", type: "boolean" },
        ],
      },
    });
  if (spec.traceOff && common.config.ui?.target === "web") common.config.ui.evidence.trace = "off";
  const request: ValidationProfileCreateRequest =
    target === "headless"
      ? {
          ...common,
          workflowKind: "pr_static_build",
          target,
          outputSchemaVersion: "PrReviewPlanV2",
        }
      : { ...common, workflowKind: "pr_ui", target, outputSchemaVersion: "ValidationReportV1" };
  const profile = configure(database, "publishValidationProfile", { repositoryId, request, actor });
  configure(database, "saveValidationProfileBinding", {
    repositoryId,
    profileId: profile.profileId,
    actor,
    request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
  });
  return profile;
}

function publishPrompt(
  database: DatabaseSync,
  repositoryId: string,
  workflowKind: "pr_static_build" | "pr_ui",
  content = "Review the frozen source and report verified evidence.",
): PromptVersion {
  const template = configure(database, "createPromptTemplate", {
    actor,
    request: {
      name: "Validation prompt",
      workflowKind,
      content,
      outputSchemaVersion:
        workflowKind === "pr_static_build" ? "PrReviewPlanV2" : "ValidationSummaryV1",
    },
  });
  const prompt = configure(database, "publishPromptDraft", {
    templateId: template.id,
    actor,
    request: { expectedVersion: template.version },
  });
  const previous = database
    .prepare("SELECT version FROM prompt_bindings WHERE scope_key = ? AND workflow_kind = ?")
    .get(`repository:${repositoryId}`, workflowKind) as { version: number } | undefined;
  configure(database, "savePromptBinding", {
    repositoryId,
    workflowKind,
    actor,
    request: { expectedVersion: previous?.version ?? 0, promptVersionId: prompt.id },
  });
  return prompt;
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA recursive_triggers = ON");
  runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
  handleRepositoryConfigurationRequest(
    database,
    {
      operation: "bootstrapManagedRepositories",
      input: {
        repositories: [repository(1), repository(2)].map(({ githubRepositoryId, fullName }) => ({
          githubRepositoryId,
          fullName,
        })),
        reviewer,
        authorizationPolicy: policy,
      },
    },
    now,
  );
  return database;
}

function createRun(
  database: DatabaseSync,
  options: {
    repositoryNumber?: number;
    number?: number;
    profiles?: ProfileSpec[];
    createdAt?: string;
  } = {},
): ReviewRunDetail {
  const event = requestEvent(options.repositoryNumber ?? 1, options.number ?? 1);
  const activated = activate(database, event);
  const managed = handleRepositoryConfigurationRequest(
    database,
    {
      operation: "getManagedRepository",
      input: { repositoryId: activated.repositoryId },
    },
    now,
  ) as ManagedRepository;
  const epoch = database
    .prepare("SELECT epoch_json FROM request_epochs WHERE id = ?")
    .get(activated.openedRequestEpochId) as { epoch_json: string };
  const prompts = new Map<string, PromptVersion>();
  const requests: ReviewRunPlanInput["requests"] = (
    options.profiles ?? [{ requestId: "static" }]
  ).map((spec) => {
    const profile = spec.missingProfile ? null : publishProfile(database, managed.id, spec);
    const target = spec.target ?? "headless";
    const workflowKind = target === "headless" ? "pr_static_build" : "pr_ui";
    let prompt = spec.missingPrompt ? undefined : prompts.get(workflowKind);
    if (prompt === undefined && !spec.missingPrompt) {
      prompt = publishPrompt(database, managed.id, workflowKind);
      prompts.set(workflowKind, prompt);
    }
    return {
      requestId: spec.requestId,
      workflowKind,
      target,
      required: true,
      profileVersion: profile,
      prompt: prompt === undefined ? null : { workflowKind, version: prompt },
    };
  });
  if (event.revision.kind !== "pull_request") throw new Error("Expected a pull request revision.");
  const planInput: ReviewRunPlanInput = {
    activationId: `run-${event.workItem.githubWorkItemId}`,
    repository: {
      id: managed.id,
      githubRepositoryId: managed.githubRepositoryId,
      fullName: managed.fullName,
      configurationVersion: managed.version,
    },
    workItemId: activated.workItemId,
    workItem: event.workItem,
    revision: event.revision,
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: event.revision.baseSha,
      headSha: event.revision.headSha,
    },
    testedSourceAuthorization: null,
    authorization: JSON.parse(epoch.epoch_json) as ActiveAuthorizedRequestEpoch,
    authorizationPolicy: policy,
    requests,
    runnerSupport: [],
  };
  return handleReviewRunRequest(
    database,
    {
      operation: "createReviewRun",
      input: { planInput, actor },
    },
    options.createdAt ?? now,
  ) as ReviewRunDetail;
}

function targetLabels(target: ValidationTarget): WorkerCapabilities["labels"] {
  if (target === "headless") return { executionEnvelope: "2", validationHeadless: "1" };
  return target === "web"
    ? { executionEnvelope: "2", validationWeb: "1", evidenceDelivery: "1", "ui:web": "1" }
    : {
        executionEnvelope: "2",
        validationWindowsDesktop: "1",
        evidenceDelivery: "1",
        "ui:windows_desktop": "1",
      };
}

function capabilities(overrides: Partial<WorkerCapabilities> = {}): WorkerCapabilities {
  return {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: true,
    codexVersion: "test",
    recipeIds: [],
    labels: targetLabels("headless"),
    ...overrides,
  };
}

function seedWorker(
  database: DatabaseSync,
  options: {
    capabilities?: WorkerCapabilities;
    status?: WorkerState;
    credential?: "active" | "pending" | "revoked" | "missing";
    superseded?: boolean;
    availableSlots?: number;
    nodeId?: string;
  } = {},
) {
  const id = `worker-${count(database, "workers") + 1}`;
  const nodeId = options.nodeId ?? `node-${id}`;
  const instanceId = `instance-${id}`;
  const credential = options.credential ?? "active";
  if (
    credential !== "missing" &&
    !database.prepare("SELECT 1 FROM worker_node_credentials WHERE worker_node_id = ?").get(nodeId)
  ) {
    database
      .prepare(`INSERT INTO worker_node_credentials (
      worker_node_id, display_name, token_sha256, auth_state, created_by_issuer,
      created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at,
      activated_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        nodeId,
        nodeId,
        sha256(nodeId),
        credential,
        actor.issuer,
        actor.subject,
        actor.issuer,
        actor.subject,
        now,
        now,
        credential === "pending" ? null : now,
        credential === "revoked" ? now : null,
      );
  }
  const json = canonicalJson(options.capabilities ?? capabilities());
  database
    .prepare(`INSERT INTO workers (
    id, node_id, instance_id, display_name, version, protocol_version, max_slots,
    capabilities_json, capabilities_digest, status, available_slots, superseded_at,
    registered_at, last_seen_at, updated_at
  ) VALUES (?, ?, ?, ?, 'test', '1.0', 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      nodeId,
      instanceId,
      id,
      json,
      sha256(json),
      options.status ?? "online",
      options.availableSlots ?? 1,
      options.superseded ? now : null,
      now,
      now,
      now,
    );
  return { id, nodeId, instanceId };
}

function scope(run: ReviewRunDetail) {
  return { repositoryId: run.repositoryId, reviewRunId: run.id };
}

function dispatch(database: DatabaseSync, run: ReviewRunDetail, at = now): DispatchResult {
  return handleValidationDispatchRequest(
    database,
    {
      operation: "dispatchReviewRun",
      input: { ...scope(run), actor },
    },
    at,
  ) as DispatchResult;
}

function pending(database: DatabaseSync, limit = 1, at = now): PendingResult {
  return handleValidationDispatchRequest(
    database,
    {
      operation: "dispatchPendingReviewRuns",
      input: { limit },
    },
    at,
  ) as PendingResult;
}

function rerun(
  database: DatabaseSync,
  run: ReviewRunDetail,
  activationId = "rerun-1",
  requestId = "static",
  requestedBy = actor,
  at = later,
): RerunResult {
  return handleValidationDispatchRequest(
    database,
    {
      operation: "rerunValidationRequest",
      input: { ...scope(run), requestId, activationId, actor: requestedBy },
    },
    at,
  ) as RerunResult;
}

function cancel(
  database: DatabaseSync,
  run: ReviewRunDetail,
  jobId: string,
  requestId = "static",
  at = later,
): CancelResult {
  return handleValidationDispatchRequest(
    database,
    {
      operation: "cancelValidationJob",
      input: { ...scope(run), requestId, jobId, actor },
    },
    at,
  ) as CancelResult;
}

function job(database: DatabaseSync, jobId: string): JobRow {
  return present(
    database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId),
  ) as unknown as JobRow;
}

function linkedJobs(database: DatabaseSync, run: ReviewRunDetail): JobRow[] {
  return database
    .prepare(`SELECT job.* FROM jobs AS job
    JOIN review_run_job_links AS link ON link.job_id = job.id
    WHERE link.review_run_id = ? ORDER BY link.request_id, link.activation_number`)
    .all(run.id) as unknown as JobRow[];
}

function admission(database: DatabaseSync, jobId: string) {
  return present(database.prepare("SELECT * FROM job_admission WHERE job_id = ?").get(jobId));
}

function leaseJob(
  database: DatabaseSync,
  jobId: string,
  worker: ReturnType<typeof seedWorker>,
  status: "leased" | "running" = "leased",
) {
  const attemptId = `attempt-${jobId}`;
  const deadline = "2026-09-07T12:02:00.000Z";
  database.exec("BEGIN IMMEDIATE");
  try {
    const admitted = database
      .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
      .run(now, jobId);
    expect(admitted.changes).toBe(1);
    database
      .prepare(`UPDATE jobs SET status = 'leased', attempt_count = 1, lease_generation = 1,
      current_run_attempt_id = ?, current_step = 'leased', started_at = ? WHERE id = ?`)
      .run(attemptId, now, jobId);
    database
      .prepare(`INSERT INTO run_attempts (
    id, job_id, attempt_number, worker_id, worker_node_id, worker_instance_id, status,
    lease_token_hash, lease_generation, lease_expires_at, execution_deadline_at,
    no_progress_timeout_ms, no_progress_deadline_at, last_heartbeat_at, phase, started_at
  ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, 30000, ?, ?, 'leased', ?)`)
      .run(
        attemptId,
        jobId,
        worker.id,
        worker.nodeId,
        worker.instanceId,
        "leased",
        sha256(`lease:${jobId}`),
        deadline,
        deadline,
        deadline,
        now,
        now,
      );
    if (status === "running") {
      database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
      database.prepare("UPDATE run_attempts SET status = 'running' WHERE id = ?").run(attemptId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return attemptId;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("validation dispatch admission", () => {
  it.each([
    { target: "headless" as const, probe: true, label: "structuredProbeOutput" },
    { target: "web" as const, traceOff: true, label: "uiAssertionObservation" },
  ])(
    "persists the exact $label protocol requirement while awaiting a compatible runtime",
    ({ target, label, ...profile }) => {
      const database = createDatabase();
      const run = createRun(database, {
        profiles: [{ requestId: "protocol", target, ...profile }],
      });
      const incompatible = capabilities({
        labels: { ...targetLabels(target), [label]: "2" },
        recipeIds: [label],
      });
      seedWorker(database, { capabilities: incompatible });
      const runtime = evaluateReviewRunPlanReadiness(
        run.plan,
        getValidationRunnerSupport(run.plan, [incompatible]),
      );
      expect(runtime[0]?.reasons).toContainEqual({
        code: "missing_capability",
        capability: label,
      });
      const dispatched = dispatch(database, run);
      expect(dispatched.createdJobs).toHaveLength(1);
      const created = present(dispatched.createdJobs[0]);
      expect(admission(database, created.jobId)).toMatchObject({
        state: "pending",
        attempt_base: 0,
      });
      const template = JSON.parse(
        job(database, created.jobId).execution_json,
      ) as JobExecutionTemplateV2;
      expect(template.executionPolicy.requiredCapabilityLabels[label]).toBe("1");
      expect(Object.hasOwn(template.validation, "reproduction")).toBe(false);
      expect(template.validation.profileVersion.configSha256).toBe(
        run.plan.jobs[0]?.profileVersion?.configSha256,
      );
      const before = admission(database, created.jobId);
      seedWorker(database, {
        capabilities: capabilities({ labels: { ...targetLabels(target), [label]: "1" } }),
      });
      expect(dispatch(database, run, later).createdJobs).toEqual([]);
      expect(admission(database, created.jobId)).toEqual(before);
      expect(count(database, "run_attempts")).toBe(0);
    },
  );

  it("persists a complete frozen request as a pending Job when no Worker is registered", () => {
    const database = createDatabase();
    const run = createRun(database);
    const before = count(database, "jobs");
    const frozen = database
      .prepare("SELECT plan_json, readiness_json FROM review_runs WHERE id = ?")
      .get(run.id);
    const result = dispatch(database, run);
    expect(result).toMatchObject({
      ...scope(run),
      alreadyAssociatedRequestIds: [],
      blockedRequests: [],
    });
    expect(result.createdJobs).toHaveLength(1);
    const created = present(result.createdJobs[0]);
    expect(admission(database, created.jobId)).toMatchObject({ state: "pending", attempt_base: 0 });
    expect(job(database, created.jobId)).toMatchObject({
      status: "queued",
      attempt_count: 0,
      current_run_attempt_id: null,
    });
    expect(count(database, "jobs")).toBe(before + 1);
    expect(count(database, "review_run_job_links")).toBe(1);
    expect(count(database, "run_attempts")).toBe(0);
    expect(
      database
        .prepare("SELECT plan_json, readiness_json FROM review_runs WHERE id = ?")
        .get(run.id),
    ).toEqual(frozen);
    expect(run.readiness[0]?.reasons).toContainEqual({ code: "unsupported_target" });
  });

  it.each(["profile", "prompt"] as const)(
    "retains a missing frozen %s as a request without a Job",
    (missing) => {
      const database = createDatabase();
      const run = createRun(database, {
        profiles: [
          {
            requestId: "static",
            missingProfile: missing === "profile",
            missingPrompt: missing === "prompt",
          },
        ],
      });
      const before = { jobs: count(database, "jobs"), admission: count(database, "job_admission") };
      const result = dispatch(database, run);
      expect(result.createdJobs).toEqual([]);
      expect(result.blockedRequests).toEqual([
        { requestId: "static", reasons: [{ code: `missing_${missing}` }] },
      ]);
      expect(count(database, "jobs")).toBe(before.jobs);
      expect(count(database, "job_admission")).toBe(before.admission);
      expect(linkedJobs(database, run)).toEqual([]);
      expect(count(database, "run_attempts")).toBe(0);
    },
  );

  it.each([
    { name: "missing credentials", options: { credential: "missing" as const } },
    { name: "pending credentials", options: { credential: "pending" as const } },
    { name: "revoked credentials", options: { credential: "revoked" as const } },
    { name: "offline Workers", options: { status: "offline" as const } },
    { name: "draining Workers", options: { status: "draining" as const } },
    { name: "disabled Workers", options: { status: "disabled" as const } },
    { name: "superseded instances", options: { superseded: true } },
    { name: "legacy Workers", options: { capabilities: capabilities({ labels: {} }) } },
    {
      name: "envelope support alone",
      options: { capabilities: capabilities({ labels: { executionEnvelope: "2" } }) },
    },
  ])("retains a real pending Job despite $name without allocating an attempt", ({ options }) => {
    const database = createDatabase();
    const run = createRun(database);
    seedWorker(database, options);
    const result = dispatch(database, run);
    expect(result.createdJobs).toHaveLength(1);
    expect(admission(database, present(result.createdJobs[0]).jobId)).toMatchObject({
      state: "pending",
      attempt_base: 0,
    });
    expect(linkedJobs(database, run)).toHaveLength(1);
    expect(count(database, "run_attempts")).toBe(0);
  });

  it("queues every selected profile once and links only the frozen authorization epoch", () => {
    const database = createDatabase();
    const run = createRun(database, {
      profiles: [{ requestId: "static-a" }, { requestId: "static-b" }],
    });
    const additional = activate(database, requestEvent(1, 1, "assignment"));
    expect(additional.openedRequestEpochId).not.toBe(run.requestEpochId);
    seedWorker(database);
    const result = dispatch(database, run);
    expect(result.blockedRequests).toEqual([]);
    expect(
      result.createdJobs.map(({ requestId, jobActivation }) => ({ requestId, jobActivation })),
    ).toEqual([
      { requestId: "static-a", jobActivation: 1 },
      { requestId: "static-b", jobActivation: 1 },
    ]);
    for (const created of result.createdJobs) {
      const row = job(database, created.jobId);
      expect(row).toMatchObject({
        status: "queued",
        request_epoch_id: run.requestEpochId,
        attempt_count: 0,
        current_run_attempt_id: null,
      });
      expect(admission(database, created.jobId)).toMatchObject({
        state: "pending",
        attempt_base: 0,
      });
      const execution = JSON.parse(row.execution_json) as JobExecutionTemplateV2;
      expect(execution.validation).toMatchObject({
        runId: run.id,
        requestId: created.requestId,
        jobActivation: 1,
        planDigest: run.planDigest,
      });
      expect(execution.validation.profileVersion).toEqual(
        present(run.plan.jobs.find((request) => request.requestId === created.requestId))
          .profileVersion,
      );
      expect(
        database
          .prepare("SELECT request_epoch_id FROM job_request_epochs WHERE job_id = ?")
          .all(created.jobId),
      ).toEqual([{ request_epoch_id: run.requestEpochId }]);
    }
    const jobCount = count(database, "jobs");
    const auditCount = count(database, "review_run_audit");
    const replay = dispatch(database, run, later);
    expect(replay.createdJobs).toEqual([]);
    expect([...replay.alreadyAssociatedRequestIds].sort()).toEqual(["static-a", "static-b"]);
    expect(count(database, "jobs")).toBe(jobCount);
    expect(count(database, "review_run_audit")).toBe(auditCount);
    expect(count(database, "run_attempts")).toBe(0);
  });

  it("retains pending work for a compatible busy Worker without allocating a lease", () => {
    const database = createDatabase();
    const run = createRun(database);
    seedWorker(database, { availableSlots: 0 });
    const created = present(dispatch(database, run).createdJobs[0]);
    expect(job(database, created.jobId)).toMatchObject({
      status: "queued",
      attempt_count: 0,
      current_run_attempt_id: null,
    });
    expect(count(database, "run_attempts")).toBe(0);
    expect(admission(database, created.jobId)).toMatchObject({ state: "pending", attempt_base: 0 });
  });

  it("matches profile requirements through boolean paths, recipes, and exact capability labels", () => {
    const database = createDatabase();
    const requiredCapabilities = ["headless", "dotnet-build", "tool.dotnet"];
    const run = createRun(database, { profiles: [{ requestId: "static", requiredCapabilities }] });
    seedWorker(database, {
      capabilities: capabilities({
        recipeIds: ["dotnet-build"],
        labels: { ...targetLabels("headless"), "tool.dotnet": "1" },
      }),
    });
    const created = present(dispatch(database, run).createdJobs[0]);
    const stored = job(database, created.jobId);
    const execution = JSON.parse(stored.execution_json) as JobExecutionTemplateV2;
    expect(execution.validation.profileVersion.config.requiredCapabilities).toEqual(
      requiredCapabilities,
    );
    expect(JSON.parse(stored.required_capabilities_json)).toMatchObject({
      labels: { executionEnvelope: "2", validationHeadless: "1" },
    });
  });

  it("persists whole-profile requirements without pretending partial Workers are compatible", () => {
    const database = createDatabase();
    const run = createRun(database, {
      profiles: [
        { requestId: "static", requiredCapabilities: ["headless", "dotnet-build", "tool.dotnet"] },
      ],
    });
    seedWorker(database, {
      nodeId: "shared-node",
      superseded: true,
      capabilities: capabilities({
        recipeIds: ["dotnet-build"],
        labels: { ...targetLabels("headless"), "tool.dotnet": "1" },
      }),
    });
    const partial = [
      capabilities({ recipeIds: ["dotnet-build"] }),
      capabilities({
        headless: false,
        labels: { ...targetLabels("headless"), "tool.dotnet": "1" },
      }),
    ];
    seedWorker(database, { nodeId: "shared-node", capabilities: present(partial[0]) });
    seedWorker(database, { capabilities: present(partial[1]) });
    expect(
      evaluateReviewRunPlanReadiness(run.plan, getValidationRunnerSupport(run.plan, partial))[0]
        ?.state,
    ).toBe("blocked");
    const result = dispatch(database, run);
    expect(result.createdJobs).toHaveLength(1);
    expect(result.blockedRequests).toEqual([]);
    expect(admission(database, present(result.createdJobs[0]).jobId)).toMatchObject({
      state: "pending",
    });
    expect(linkedJobs(database, run)).toHaveLength(1);
  });

  it.each(["web", "windows_desktop"] as const)(
    "persists %s UI intent without inventing a Worker with combined capabilities",
    (target) => {
      const database = createDatabase();
      const run = createRun(database, { profiles: [{ requestId: "ui", target }] });
      const driverOnly = targetLabels(target);
      delete driverOnly.evidenceDelivery;
      const evidenceOnly = targetLabels(target);
      delete evidenceOnly[`ui:${target}`];
      seedWorker(database, { capabilities: capabilities({ labels: driverOnly }) });
      seedWorker(database, { capabilities: capabilities({ labels: evidenceOnly }) });
      expect(
        evaluateReviewRunPlanReadiness(
          run.plan,
          getValidationRunnerSupport(run.plan, [
            capabilities({ labels: driverOnly }),
            capabilities({ labels: evidenceOnly }),
          ]),
        )[0]?.state,
      ).toBe("blocked");
      const first = dispatch(database, run);
      const created = present(first.createdJobs[0]);
      expect(first.createdJobs).toHaveLength(1);
      expect(admission(database, created.jobId)).toMatchObject({ state: "pending" });
      seedWorker(database, { capabilities: capabilities({ labels: targetLabels(target) }) });
      const ready = dispatch(database, run, later);
      expect(ready.createdJobs).toEqual([]);
      expect(ready.blockedRequests).toEqual([]);
      expect(JSON.parse(job(database, created.jobId).execution_json).validation.target).toBe(
        target,
      );
    },
  );

  it("rolls back created jobs, links, and scheduling state when association audit fails", () => {
    const database = createDatabase();
    const run = createRun(database);
    seedWorker(database);
    const before = Object.fromEntries(
      [
        "jobs",
        "job_admission",
        "review_run_job_links",
        "validation_control_audit",
        "validation_dispatch_checks",
        "validation_dispatch_state",
      ].map((table) => [table, count(database, table)]),
    );
    const cursorBefore = database.prepare("SELECT * FROM validation_dispatch_state").get();
    const admissionStateBefore = database.prepare("SELECT * FROM scheduling_state").get();
    database.exec(
      "CREATE TEMP TRIGGER reject_dispatch_audit BEFORE INSERT ON review_run_audit BEGIN SELECT RAISE(ABORT, 'Injected dispatch audit failure'); END",
    );
    expect(() => dispatch(database, run)).toThrow("Injected dispatch audit failure");
    for (const [table, expected] of Object.entries(before))
      expect(count(database, table)).toBe(expected);
    expect(database.prepare("SELECT * FROM validation_dispatch_state").get()).toEqual(cursorBefore);
    expect(database.prepare("SELECT * FROM scheduling_state").get()).toEqual(admissionStateBefore);
  });
});

describe("validation rerun activations", () => {
  it.each(["offline", "missing-capability"] as const)(
    "accepts a pending rerun when its previously compatible Worker is %s",
    (condition) => {
      const database = createDatabase();
      const run = createRun(database, {
        profiles: [{ requestId: "static", requiredCapabilities: ["tool.dotnet"] }],
      });
      const worker = seedWorker(database, {
        capabilities: capabilities({
          labels: { ...targetLabels("headless"), "tool.dotnet": "1" },
        }),
      });
      const first = present(dispatch(database, run).createdJobs[0]);
      database
        .prepare("UPDATE jobs SET status = 'failed', completed_at = ? WHERE id = ?")
        .run(later, first.jobId);
      if (condition === "offline") {
        database.prepare("UPDATE workers SET status = 'offline' WHERE id = ?").run(worker.id);
      } else {
        const json = canonicalJson(capabilities());
        database
          .prepare("UPDATE workers SET capabilities_json = ?, capabilities_digest = ? WHERE id = ?")
          .run(json, sha256(json), worker.id);
      }
      const audits = count(database, "validation_control_audit");
      const previousAdmission = admission(database, first.jobId);
      const result = rerun(database, run);
      expect(result).toMatchObject({ jobActivation: 2, replayed: false });
      expect(result.jobId).not.toBe(first.jobId);
      expect(admission(database, result.jobId)).toMatchObject({
        state: "pending",
        attempt_base: 0,
      });
      expect(admission(database, first.jobId)).toEqual(previousAdmission);
      expect(linkedJobs(database, run)).toHaveLength(2);
      expect(count(database, "validation_control_audit")).toBe(audits + 1);
      expect(count(database, "run_attempts")).toBe(0);
      expect(() => rerun(database, run, "another-pending-rerun")).toThrow(/active job/u);
    },
  );

  it.each(["queued", "retry_waiting", "leased", "running", "cancel_requested"] as const)(
    "rejects a new rerun while the previous job is %s",
    (state) => {
      const database = createDatabase();
      const run = createRun(database);
      const worker = seedWorker(database);
      const created = present(dispatch(database, run).createdJobs[0]);
      if (state === "leased" || state === "running" || state === "cancel_requested") {
        leaseJob(database, created.jobId, worker, state === "running" ? "running" : "leased");
      }
      database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(state, created.jobId);
      expect(() => rerun(database, run)).toThrow();
      expect(linkedJobs(database, run)).toHaveLength(1);
    },
  );

  it("appends an independently idempotent activation while preserving the frozen plan and prompt", () => {
    const database = createDatabase();
    const run = createRun(database);
    seedWorker(database);
    const first = present(dispatch(database, run).createdJobs[0]);
    const initial = job(database, first.jobId);
    const initialTemplate = JSON.parse(initial.execution_json) as JobExecutionTemplateV2;
    const planBefore = database
      .prepare("SELECT plan_json, plan_digest FROM review_runs WHERE id = ?")
      .get(run.id);
    database
      .prepare("UPDATE jobs SET status = 'failed', completed_at = ? WHERE id = ?")
      .run(later, first.jobId);
    publishPrompt(
      database,
      run.repositoryId,
      "pr_static_build",
      "This newer prompt must not change a frozen rerun.",
    );
    publishProfile(database, run.repositoryId, {
      requestId: "new-profile",
      requiredCapabilities: ["not-in-frozen-profile"],
    });
    const second = rerun(database, run);
    expect(second).toMatchObject({
      ...scope(run),
      requestId: "static",
      jobActivation: 2,
      replayed: false,
    });
    expect(second.jobId).not.toBe(first.jobId);
    const secondAdmission = admission(database, second.jobId);
    expect(secondAdmission).toMatchObject({ state: "pending", attempt_base: 0 });
    const secondTemplate = JSON.parse(
      job(database, second.jobId).execution_json,
    ) as JobExecutionTemplateV2;
    expect(secondTemplate).toEqual({
      ...initialTemplate,
      validation: { ...initialTemplate.validation, jobActivation: 2 },
    });
    expect(job(database, first.jobId).execution_json).toBe(initial.execution_json);
    expect(
      database.prepare("SELECT plan_json, plan_digest FROM review_runs WHERE id = ?").get(run.id),
    ).toEqual(planBefore);
    const auditCount = count(database, "validation_control_audit");
    expect(auditCount).toBeGreaterThan(0);
    expect(rerun(database, run, "rerun-1", "static", actor, latest)).toEqual({
      ...second,
      replayed: true,
    });
    expect(count(database, "validation_control_audit")).toBe(auditCount);
    expect(admission(database, second.jobId)).toEqual(secondAdmission);
    expect(() =>
      rerun(database, run, "rerun-1", "static", { ...actor, subject: "different-operator" }),
    ).toThrow();
    expect(linkedJobs(database, run)).toHaveLength(2);
    database
      .prepare("UPDATE jobs SET status = 'failed', completed_at = ? WHERE id = ?")
      .run(latest, second.jobId);
    const third = rerun(database, run, "rerun-2");
    expect(third).toMatchObject({ jobActivation: 3, replayed: false });
    expect(rerun(database, run, "rerun-1")).toEqual({ ...second, replayed: true });
    expect(count(database, "run_attempts")).toBe(0);
  });

  it.each(["repository", "revision", "epoch", "policy"] as const)(
    "rejects a fresh rerun after the %s authorization changes",
    (changed) => {
      const database = createDatabase();
      const run = createRun(database);
      seedWorker(database);
      const first = present(dispatch(database, run).createdJobs[0]);
      database
        .prepare("UPDATE jobs SET status = 'failed', completed_at = ? WHERE id = ?")
        .run(later, first.jobId);
      if (changed === "repository")
        database
          .prepare("UPDATE managed_repositories SET enabled = 0 WHERE id = ?")
          .run(run.repositoryId);
      if (changed === "revision")
        database
          .prepare("UPDATE work_items SET current_revision_key = ? WHERE id = ?")
          .run(sha256("unapproved-revision"), run.workItemId);
      if (changed === "epoch")
        database
          .prepare(
            "UPDATE request_epochs SET status = 'closed', closing_event_id = opening_event_id, close_reason = 'review_request_removed', closed_at = ? WHERE id = ?",
          )
          .run(later, run.requestEpochId);
      if (changed === "policy")
        database
          .prepare("UPDATE managed_repositories SET authorization_policy_json = ? WHERE id = ?")
          .run(canonicalJson({ ...policy, policyVersion: 2 }), run.repositoryId);
      const before = count(database, "validation_control_audit");
      expect(() => rerun(database, run)).toThrow();
      expect(linkedJobs(database, run)).toHaveLength(1);
      expect(count(database, "validation_control_audit")).toBe(before);
    },
  );
});

describe("validation job cancellation", () => {
  it.each([
    { state: "queued", admissionState: "pending" },
    { state: "queued", admissionState: "admitted" },
    { state: "retry_waiting", admissionState: "pending" },
    { state: "retry_waiting", admissionState: "admitted" },
  ] as const)(
    "cancels an unleased $state Job with $admissionState admission without allocating an attempt",
    ({ state, admissionState }) => {
      const database = createDatabase();
      const run = createRun(database);
      seedWorker(database);
      const created = present(dispatch(database, run).createdJobs[0]);
      database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(state, created.jobId);
      if (admissionState === "admitted") {
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare(
              "UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?",
            )
            .run(now, created.jobId);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      const before = job(database, created.jobId);
      const admissionBefore = admission(database, created.jobId);
      expect(cancel(database, run, created.jobId)).toMatchObject({
        ...scope(run),
        requestId: "static",
        jobId: created.jobId,
        jobState: "cancelled",
        changed: true,
      });
      const cancelled = job(database, created.jobId);
      expect(cancelled).toMatchObject({
        status: "cancelled",
        current_run_attempt_id: null,
        attempt_count: 0,
        concurrency_key: before.concurrency_key,
        execution_json: before.execution_json,
      });
      expect(cancelled.completed_at).not.toBeNull();
      expect(cancel(database, run, created.jobId, "static", latest)).toMatchObject({
        jobState: "cancelled",
        changed: false,
      });
      expect(job(database, created.jobId)).toEqual(cancelled);
      expect(admission(database, created.jobId)).toEqual(admissionBefore);
      expect(count(database, "run_attempts")).toBe(0);
    },
  );

  it.each(["leased", "running"] as const)(
    "requests cancellation for a %s job while retaining its lease and concurrency fence",
    (state) => {
      const database = createDatabase();
      const run = createRun(database);
      const worker = seedWorker(database);
      const created = present(dispatch(database, run).createdJobs[0]);
      const attemptId = leaseJob(database, created.jobId, worker, state);
      const before = job(database, created.jobId);
      const attempt = database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId);
      expect(cancel(database, run, created.jobId)).toMatchObject({
        jobState: "cancel_requested",
        changed: true,
      });
      const cancelled = job(database, created.jobId);
      expect(cancelled).toMatchObject({
        status: "cancel_requested",
        current_run_attempt_id: attemptId,
        lease_generation: 1,
        concurrency_key: before.concurrency_key,
        execution_json: before.execution_json,
        cancellation_requested_at: later,
      });
      expect(database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId)).toEqual(
        attempt,
      );
      const legacy = present(
        database
          .prepare(
            "SELECT id FROM jobs WHERE id NOT IN (SELECT job_id FROM review_run_job_links) LIMIT 1",
          )
          .get(),
      ) as { id: string };
      database
        .prepare("UPDATE jobs SET concurrency_key = ? WHERE id = ?")
        .run(before.concurrency_key, legacy.id);
      expect(() => leaseJob(database, legacy.id, worker)).toThrow(/UNIQUE|concurrency/iu);
      expect(cancel(database, run, created.jobId, "static", latest)).toMatchObject({
        jobState: "cancel_requested",
        changed: false,
      });
      expect(job(database, created.jobId).cancellation_requested_at).toBe(later);
      expect(database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId)).toEqual(
        attempt,
      );
    },
  );

  it("cannot cancel another request's job through a valid run scope", () => {
    const database = createDatabase();
    const run = createRun(database, {
      profiles: [{ requestId: "static" }, { requestId: "other" }],
    });
    seedWorker(database);
    const created = present(
      dispatch(database, run).createdJobs.find((entry) => entry.requestId === "other"),
    );
    const before = job(database, created.jobId);
    expect(() => cancel(database, run, created.jobId, "static")).toThrow();
    expect(job(database, created.jobId)).toEqual(before);
  });
});

describe("pending validation dispatch fairness", () => {
  it.each(["policy", "reviewer"] as const)(
    "retains pending work while the repository %s differs and dispatches after restoration",
    (setting) => {
      const database = createDatabase();
      const run = createRun(database);
      seedWorker(database);
      const original = database
        .prepare(
          "SELECT authorization_policy_json, reviewer_github_user_id FROM managed_repositories WHERE id = ?",
        )
        .get(run.repositoryId) as {
        authorization_policy_json: string;
        reviewer_github_user_id: number;
      };
      if (setting === "policy") {
        database
          .prepare("UPDATE managed_repositories SET authorization_policy_json = ? WHERE id = ?")
          .run(canonicalJson({ ...policy, policyVersion: 2 }), run.repositoryId);
      } else {
        database
          .prepare("UPDATE managed_repositories SET reviewer_github_user_id = ? WHERE id = ?")
          .run(original.reviewer_github_user_id + 1, run.repositoryId);
      }
      const readCheck = () =>
        database
          .prepare(
            "SELECT pending, blockers_json FROM validation_dispatch_checks WHERE review_run_id = ? AND request_id = 'static'",
          )
          .get(run.id) as { pending: number; blockers_json: string };

      expect(pending(database, 128)).toEqual({
        examinedRequestCount: 1,
        blockedRequestCount: 1,
        createdJobs: [],
      });
      expect(readCheck().pending).toBe(1);
      expect(JSON.parse(readCheck().blockers_json).length).toBeGreaterThan(0);
      expect(linkedJobs(database, run)).toEqual([]);

      database
        .prepare(
          "UPDATE managed_repositories SET authorization_policy_json = ?, reviewer_github_user_id = ? WHERE id = ?",
        )
        .run(
          original.authorization_policy_json,
          original.reviewer_github_user_id,
          run.repositoryId,
        );
      expect(pending(database, 128, later)).toEqual({
        examinedRequestCount: 1,
        blockedRequestCount: 0,
        createdJobs: [
          { ...scope(run), requestId: "static", jobId: expect.any(String), jobActivation: 1 },
        ],
      });
      expect(readCheck()).toEqual({ pending: 0, blockers_json: "[]" });
      expect(linkedJobs(database, run)).toHaveLength(1);
    },
  );

  it("examines a structurally blocked request only once per batch even with limit 128", () => {
    const database = createDatabase();
    const run = createRun(database, {
      profiles: [{ requestId: "static", missingPrompt: true }],
    });
    seedWorker(database);
    const readCheck = () =>
      database
        .prepare(
          "SELECT pending, last_sequence, checked_at, blockers_json FROM validation_dispatch_checks WHERE review_run_id = ? AND request_id = 'static'",
        )
        .get(run.id) as {
        pending: number;
        last_sequence: number;
        checked_at: string | null;
        blockers_json: string;
      };
    const before = database.prepare("SELECT sequence FROM validation_dispatch_state").get() as {
      sequence: number;
    };
    expect(readCheck()).toEqual({
      pending: 1,
      last_sequence: 0,
      checked_at: null,
      blockers_json: "[]",
    });

    expect(pending(database, 128)).toEqual({
      examinedRequestCount: 1,
      blockedRequestCount: 1,
      createdJobs: [],
    });
    expect(readCheck()).toMatchObject({
      pending: 1,
      last_sequence: before.sequence + 1,
      checked_at: now,
    });
    expect(JSON.parse(readCheck().blockers_json)).toContainEqual({
      code: "missing_prompt",
    });
    expect(
      database.prepare("SELECT sequence, last_repository_id FROM validation_dispatch_state").get(),
    ).toEqual({ sequence: before.sequence + 1, last_repository_id: run.repositoryId });

    expect(pending(database, 128, later)).toEqual({
      examinedRequestCount: 1,
      blockedRequestCount: 1,
      createdJobs: [],
    });
    expect(readCheck()).toMatchObject({
      pending: 1,
      last_sequence: before.sequence + 2,
      checked_at: later,
    });
    expect(linkedJobs(database, run)).toEqual([]);
  });

  it("preserves a paused repository's pending request and resumes it when reenabled", () => {
    const database = createDatabase();
    const run = createRun(database);
    seedWorker(database);
    database
      .prepare("UPDATE managed_repositories SET enabled = 0, version = version + 1 WHERE id = ?")
      .run(run.repositoryId);
    const readCheck = () =>
      database
        .prepare(
          "SELECT * FROM validation_dispatch_checks WHERE review_run_id = ? AND request_id = 'static'",
        )
        .get(run.id);
    const before = readCheck();
    const stateBefore = database.prepare("SELECT * FROM validation_dispatch_state").get();
    expect(before).toMatchObject({ pending: 1, last_sequence: 0, checked_at: null });
    expect(pending(database, 128)).toEqual({
      examinedRequestCount: 0,
      blockedRequestCount: 0,
      createdJobs: [],
    });
    expect(readCheck()).toEqual(before);
    expect(database.prepare("SELECT * FROM validation_dispatch_state").get()).toEqual(stateBefore);

    database
      .prepare("UPDATE managed_repositories SET enabled = 1, version = version + 1 WHERE id = ?")
      .run(run.repositoryId);
    const resumed = handleValidationDispatchRequest(
      database,
      {
        operation: "dispatchPendingReviewRuns",
        input: { limit: 128 },
      },
      later,
    ) as PendingResult;
    expect(resumed).toEqual({
      examinedRequestCount: 1,
      blockedRequestCount: 0,
      createdJobs: [
        { ...scope(run), requestId: "static", jobId: expect.any(String), jobActivation: 1 },
      ],
    });
    expect(readCheck()).toMatchObject({ pending: 0, checked_at: later, blockers_json: "[]" });
    expect(linkedJobs(database, run)).toHaveLength(1);
  });

  it("retires an invalidated epoch's pending run without blocking a healthy repository", () => {
    const database = createDatabase();
    const retired = createRun(database, { repositoryNumber: 1 });
    const healthy = createRun(database, { repositoryNumber: 2, createdAt: later });
    seedWorker(database);
    database
      .prepare(
        "UPDATE request_epochs SET status = 'closed', closing_event_id = opening_event_id, close_reason = 'review_request_removed', closed_at = ? WHERE id = ?",
      )
      .run(later, retired.requestEpochId);
    const before = database.prepare("SELECT sequence FROM validation_dispatch_state").get() as {
      sequence: number;
    };

    expect(pending(database, 128, latest)).toEqual({
      examinedRequestCount: 2,
      blockedRequestCount: 1,
      createdJobs: [
        { ...scope(healthy), requestId: "static", jobId: expect.any(String), jobActivation: 1 },
      ],
    });
    const checks = database
      .prepare(
        "SELECT review_run_id, pending, last_sequence, checked_at, blockers_json FROM validation_dispatch_checks",
      )
      .all() as {
      review_run_id: string;
      pending: number;
      last_sequence: number;
      checked_at: string | null;
      blockers_json: string;
    }[];
    const retiredCheck = present(checks.find((check) => check.review_run_id === retired.id));
    const healthyCheck = present(checks.find((check) => check.review_run_id === healthy.id));
    expect(retiredCheck).toMatchObject({ pending: 0, checked_at: latest });
    expect(JSON.parse(retiredCheck.blockers_json)).toEqual([{ code: "authorization_changed" }]);
    expect(healthyCheck).toMatchObject({ pending: 0, checked_at: latest, blockers_json: "[]" });
    expect(checks.map((check) => check.last_sequence).sort((left, right) => left - right)).toEqual([
      before.sequence + 1,
      before.sequence + 2,
    ]);
    expect(database.prepare("SELECT sequence FROM validation_dispatch_state").get()).toEqual({
      sequence: before.sequence + 2,
    });
    expect(linkedJobs(database, retired)).toEqual([]);
    expect(linkedJobs(database, healthy)).toHaveLength(1);
    expect(pending(database, 128, latest)).toEqual({
      examinedRequestCount: 0,
      blockedRequestCount: 0,
      createdJobs: [],
    });
  });

  it("compares the authoritative policy semantically when its JSON key order differs", () => {
    const database = createDatabase();
    const run = createRun(database);
    seedWorker(database);
    const reorderedPolicy = JSON.stringify(policy);
    expect(reorderedPolicy).not.toBe(canonicalJson(run.plan.authorization.policy));
    database
      .prepare("UPDATE managed_repositories SET authorization_policy_json = ? WHERE id = ?")
      .run(reorderedPolicy, run.repositoryId);
    expect(pending(database, 1).createdJobs).toEqual([
      { ...scope(run), requestId: "static", jobId: expect.any(String), jobActivation: 1 },
    ]);
  });

  it("advances past a blocked request within the same repository when limit is one", () => {
    const database = createDatabase();
    const run = createRun(database, {
      profiles: [
        { requestId: "a-blocked", target: "web", missingPrompt: true },
        { requestId: "z-ready" },
      ],
    });
    seedWorker(database);
    const first = pending(database, 1);
    expect(first).toMatchObject({
      examinedRequestCount: 1,
      createdJobs: [],
      blockedRequestCount: 1,
    });
    expect(count(database, "validation_dispatch_checks")).toBeGreaterThan(0);
    const second = pending(database, 1, later);
    expect(second.examinedRequestCount).toBe(1);
    expect(second.createdJobs).toEqual([
      { ...scope(run), requestId: "z-ready", jobId: expect.any(String), jobActivation: 1 },
    ]);
    const third = pending(database, 1, latest);
    expect(third.createdJobs).toEqual([]);
    expect(linkedJobs(database, run)).toHaveLength(1);
  });

  it("persists progress across blocked repositories instead of restarting at the oldest run", () => {
    const database = createDatabase();
    const repositories = database
      .prepare("SELECT github_repository_id FROM managed_repositories ORDER BY id")
      .all() as { github_repository_id: number }[];
    const blocked = createRun(database, {
      repositoryNumber: present(repositories[0]).github_repository_id,
      profiles: [{ requestId: "static", missingPrompt: true }],
    });
    const ready = createRun(database, {
      repositoryNumber: present(repositories[1]).github_repository_id,
      createdAt: later,
    });
    seedWorker(database);
    expect(pending(database, 1, latest)).toMatchObject({
      examinedRequestCount: 1,
      createdJobs: [],
      blockedRequestCount: 1,
    });
    expect(count(database, "validation_dispatch_state")).toBeGreaterThan(0);
    const next = handleValidationDispatchRequest(
      database,
      { operation: "dispatchPendingReviewRuns", input: { limit: 1 } },
      latest,
    ) as PendingResult;
    expect(next.createdJobs).toEqual([
      { ...scope(ready), requestId: "static", jobId: expect.any(String), jobActivation: 1 },
    ]);
    expect(linkedJobs(database, blocked)).toEqual([]);
    expect(linkedJobs(database, ready)).toHaveLength(1);
  });

  it("materializes runtime-blocked requests once and leaves admission to the shared scheduler", () => {
    const database = createDatabase();
    const run = createRun(database);
    const created = pending(database, 1);
    expect(created.createdJobs).toEqual([
      { ...scope(run), requestId: "static", jobId: expect.any(String), jobActivation: 1 },
    ]);
    const jobId = present(created.createdJobs[0]).jobId;
    const originalAdmission = admission(database, jobId);
    expect(originalAdmission).toMatchObject({ state: "pending", attempt_base: 0 });
    seedWorker(database);
    expect(pending(database, 1, later).createdJobs).toEqual([]);
    expect(pending(database, 1, latest).createdJobs).toEqual([]);
    expect(admission(database, jobId)).toEqual(originalAdmission);
    expect(linkedJobs(database, run)).toHaveLength(1);
  });
});

describe("validation dispatch transaction boundaries", () => {
  it("recognizes only the four supported operation names", () => {
    for (const operation of [
      "dispatchReviewRun",
      "dispatchPendingReviewRuns",
      "rerunValidationRequest",
      "cancelValidationJob",
    ]) {
      expect(isValidationDispatchOperation(operation)).toBe(true);
    }
    expect(isValidationDispatchOperation("toString")).toBe(false);
    expect(isValidationDispatchOperation("createReviewRun")).toBe(false);
  });

  it("requires an existing transaction for every composition helper", () => {
    const database = createDatabase();
    const run = createRun(database);
    seedWorker(database);
    const created = present(dispatch(database, run).createdJobs[0]);
    const input = { ...scope(run), actor };
    expect(() => dispatchReviewRunInTransaction(database, input, later)).toThrow(
      /requires an existing transaction/u,
    );
    expect(() => dispatchPendingReviewRunsInTransaction(database, { limit: 1 }, later)).toThrow(
      /requires an existing transaction/u,
    );
    expect(() =>
      rerunValidationRequestInTransaction(
        database,
        { ...input, requestId: "static", activationId: "rerun-helper" },
        later,
      ),
    ).toThrow(/requires an existing transaction/u);
    expect(() =>
      cancelValidationJobInTransaction(
        database,
        { ...input, requestId: "static", jobId: created.jobId },
        later,
      ),
    ).toThrow(/requires an existing transaction/u);
  });

  it("keeps job creation and dispatch bookkeeping inside the caller's transaction", () => {
    const database = createDatabase();
    const run = createRun(database);
    seedWorker(database);
    const tables = [
      "jobs",
      "job_admission",
      "review_run_job_links",
      "review_run_audit",
      "validation_control_audit",
      "validation_dispatch_checks",
      "validation_dispatch_state",
    ];
    const before = tables.map((table) => count(database, table));
    const cursorBefore = database.prepare("SELECT * FROM validation_dispatch_state").get();
    const admissionStateBefore = database.prepare("SELECT * FROM scheduling_state").get();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = dispatchReviewRunInTransaction(
        database,
        { ...scope(run), actor },
        now,
      ) as DispatchResult;
      expect(result.createdJobs).toHaveLength(1);
    } finally {
      database.exec("ROLLBACK");
    }
    expect(tables.map((table) => count(database, table))).toEqual(before);
    expect(database.prepare("SELECT * FROM validation_dispatch_state").get()).toEqual(cursorBefore);
    expect(database.prepare("SELECT * FROM scheduling_state").get()).toEqual(admissionStateBefore);
  });
});
