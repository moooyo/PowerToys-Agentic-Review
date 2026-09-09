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
  ValidationJobContext,
  ValidationProfileCreateRequest,
  ValidationProfileVersion,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createValidationExecutionTemplate } from "../scheduling/validation-job-factory.js";
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
import {
  associateReviewRunJobInTransaction,
  createReviewRunInTransaction,
  getReviewRunPromptEnvelope,
  handleReviewRunRequest,
  isReviewRunOperation,
  type ReviewRunDetail,
  type ReviewRunOperation,
  type ReviewRunOperationMap,
  type ReviewRunRequest,
} from "./review-runs.js";

const now = "2026-09-07T00:00:00.000Z";
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
const later = "2026-09-07T01:00:00.000Z";
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
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function execute<K extends ReviewRunOperation>(
  database: DatabaseSync,
  operation: K,
  input: ReviewRunOperationMap[K]["input"],
  at = now,
): ReviewRunOperationMap[K]["output"] {
  return handleReviewRunRequest(
    database,
    { operation, input } as ReviewRunRequest,
    at,
  ) as ReviewRunOperationMap[K]["output"];
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

function repository(githubRepositoryId: number): GitHubRepository {
  return {
    githubRepositoryId,
    githubNodeId: `repository-${githubRepositoryId}`,
    ownerLogin: "example",
    name: `project-${githubRepositoryId}`,
    fullName: `example/project-${githubRepositoryId}`,
    htmlUrl: `https://github.com/example/project-${githubRepositoryId}`,
    defaultBranch: "main",
    isPrivate: false,
  };
}

function event(metadata: GitHubRepository, number = 1): SchedulingRequestOpenedEvent {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const githubWorkItemId = metadata.githubRepositoryId * 1000 + number;
  return {
    contractVersion: 1,
    eventId: `event-${githubWorkItemId}`,
    source: "webhook",
    sourceEventId: `delivery-${githubWorkItemId}`,
    occurredAt: now,
    observedAt: now,
    repository: metadata,
    author: reviewer,
    action: "request_opened",
    requestKind: "review_request",
    actor: reviewer,
    target: reviewer,
    workItem: {
      kind: "pull_request",
      githubWorkItemId,
      githubNodeId: `PR_${githubWorkItemId}`,
      githubRepositoryId: metadata.githubRepositoryId,
      number,
      title: "Validate the settings panel",
      body: "Update settings.",
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
      githubRepositoryId: metadata.githubRepositoryId,
      githubWorkItemId,
      revisionKey: sha256(`${baseSha}\0${headSha}`),
      baseSha,
      headSha,
      observedAt: now,
      sourceUpdatedAt: now,
    },
  };
}

function publishPrompt(
  database: DatabaseSync,
  workflowKind: "pr_static_build" | "pr_ui" = "pr_static_build",
  content = "Review the exact source revision.",
): PromptVersion {
  const template = configure(database, "createPromptTemplate", {
    actor,
    request: {
      name: "Review prompt",
      workflowKind,
      content,
      outputSchemaVersion:
        workflowKind === "pr_static_build" ? "PrReviewPlanV2" : "ValidationSummaryV1",
    },
  });
  return configure(database, "publishPromptDraft", {
    templateId: template.id,
    actor,
    request: { expectedVersion: template.version },
  });
}

function publishProfile(
  database: DatabaseSync,
  repositoryId: string,
  options: { required?: boolean; ui?: boolean } = {},
): ValidationProfileVersion {
  const request: ValidationProfileCreateRequest = {
    name: "Build and unit tests",
    workflowKind: "pr_static_build",
    target: "headless",
    required: options.required ?? true,
    outputSchemaVersion: "PrReviewPlanV2",
    config: {
      schemaVersion: "ValidationProfileV1",
      setup: [],
      build: [
        {
          id: "compile",
          name: "Compile",
          command: {
            executable: "dotnet",
            args: ["build"],
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
      requiredCapabilities: [],
      hardTimeoutMs: 120_000,
      noProgressTimeoutMs: 30_000,
    },
  };
  const actualRequest: ValidationProfileCreateRequest = options.ui
    ? {
        ...request,
        workflowKind: "pr_ui",
        target: "web",
        outputSchemaVersion: "ValidationReportV1",
      }
    : request;
  const profile = configure(database, "publishValidationProfile", {
    repositoryId,
    request: actualRequest,
    actor,
  });
  configure(database, "saveValidationProfileBinding", {
    repositoryId,
    profileId: profile.profileId,
    actor,
    request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
  });
  return profile;
}

function activate(
  database: DatabaseSync,
  metadata: GitHubRepository,
  number = 1,
  kind: "pull_request" | "issue" = "pull_request",
): ReviewRunPlanInput {
  let observed = event(metadata, number);
  if (observed.revision.kind !== "pull_request" || observed.workItem.kind !== "pull_request")
    throw new Error("Fixture revision must be a pull request.");
  if (kind === "issue") {
    const { isDraft: _isDraft, ...common } = observed.workItem;
    const workItem = {
      ...common,
      kind: "issue" as const,
      htmlUrl: `${metadata.htmlUrl}/issues/${number}`,
    };
    const revisionKey = sha256(
      JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]),
    );
    observed = {
      ...observed,
      requestKind: "assignment",
      workItem,
      revision: {
        kind: "issue",
        githubRepositoryId: metadata.githubRepositoryId,
        githubWorkItemId: workItem.githubWorkItemId,
        revisionKey,
        contentDigest: revisionKey,
        observedAt: now,
        sourceUpdatedAt: now,
      },
    };
  }
  const renderedPrompt = "Review the exact pull request.";
  const result = ingestSchedulingEvent(database, {
    allowScheduling: true,
    event: observed,
    policy,
    schedule: {
      jobKind: kind === "pull_request" ? "pull_request_review" : "issue_triage",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 1,
      requiredCapabilities: [],
      executionTemplate: {
        repository: {
          githubRepositoryId: metadata.githubRepositoryId,
          fullName: metadata.fullName,
        },
        resource: {
          githubNodeId: observed.workItem.githubNodeId,
          number: observed.workItem.number,
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
    delivery: {
      deliveryId: observed.sourceEventId,
      eventName: "pull_request",
      payloadSha256: sha256(canonicalJson(observed)),
      receivedAt: now,
    },
  });
  const managed = handleRepositoryConfigurationRequest(
    database,
    {
      operation: "getManagedRepository",
      input: { repositoryId: result.repositoryId },
    },
    now,
  ) as ManagedRepository;
  const epoch = database
    .prepare("SELECT epoch_json FROM request_epochs WHERE id = ?")
    .get(result.openedRequestEpochId) as { epoch_json: string };
  return {
    activationId: `activation-${number}`,
    repository: {
      id: managed.id,
      githubRepositoryId: managed.githubRepositoryId,
      fullName: managed.fullName,
      configurationVersion: managed.version,
    },
    workItemId: result.workItemId,
    workItem: observed.workItem,
    revision: observed.revision,
    testedSourceRevision:
      observed.revision.kind === "pull_request"
        ? {
            kind: "pull_request",
            baseSha: observed.revision.baseSha,
            headSha: observed.revision.headSha,
          }
        : { kind: "commit", headSha: "c".repeat(40) },
    testedSourceAuthorization: null,
    authorization: JSON.parse(epoch.epoch_json) as ActiveAuthorizedRequestEpoch,
    authorizationPolicy: policy,
    requests: [
      {
        requestId: "static",
        workflowKind: kind === "pull_request" ? "pr_static_build" : "issue_validation",
        target: "headless",
        required: true,
        profileVersion: null,
        prompt: null,
      },
    ],
    runnerSupport: [
      {
        workflowKind: "pr_static_build",
        target: "headless",
        capabilities: [],
        evidenceDelivery: false,
      },
    ],
  };
}

function fixture(options: { configured?: boolean; kind?: "pull_request" | "issue" } = {}) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
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
  const input = activate(database, repository(1), 1, options.kind);
  if (options.configured !== false) {
    const profile = publishProfile(database, input.repository.id);
    const prompt = publishPrompt(database);
    configure(database, "savePromptBinding", {
      repositoryId: null,
      workflowKind: "pr_static_build",
      actor,
      request: { expectedVersion: 0, promptVersionId: prompt.id },
    });
    input.requests = [
      {
        ...present(input.requests[0]),
        profileVersion: profile,
        prompt: { workflowKind: "pr_static_build", version: prompt },
      },
    ];
  }
  return {
    database,
    input,
    create: (planInput = input, at = now) =>
      execute(database, "createReviewRun", { planInput, actor }, at),
  };
}

function changeInput(
  input: ReviewRunPlanInput,
  change: (copy: ReviewRunPlanInput) => void,
): ReviewRunPlanInput {
  const copy = structuredClone(input);
  change(copy);
  return copy;
}

function storedCount(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function validationJob(
  database: DatabaseSync,
  run: ReviewRunDetail,
  activation = 1,
  modify?: (context: ValidationJobContext) => void,
  identity: Pick<ReviewRunDetail, "workItemId" | "requestEpochId" | "revisionKey"> = run,
  modifyExecution?: (execution: JobExecutionTemplateV2) => void,
): string {
  const request = present(run.plan.jobs[0]);
  if (!request.profileVersion || !request.prompt)
    throw new Error("The fixture requires a configured plan.");
  const execution = createValidationExecutionTemplate({
    runId: run.id,
    plan: run.plan,
    planDigest: run.planDigest,
    requestId: request.requestId,
    jobActivation: activation,
    frozenPrompt: present(
      getReviewRunPromptEnvelope(database, {
        repositoryId: run.repositoryId,
        reviewRunId: run.id,
        requestId: request.requestId,
      }),
    ),
  });
  modify?.(execution.validation);
  modifyExecution?.(execution);
  const id = `validation-${run.id}-${activation}-${storedCount(database, "jobs")}`;
  const ownsTransaction = !database.isTransaction;
  if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`INSERT INTO jobs (id, work_item_id, job_kind, semantic_key, concurrency_key, status,
    execution_json, resource_revision, next_attempt_at, created_at, updated_at, request_epoch_id,
    execution_digest, required_capabilities_digest, priority) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        identity.workItemId,
        run.plan.workItem.kind === "pull_request" ? "pull_request_review" : "issue_triage",
        id,
        id,
        canonicalJson(execution),
        identity.revisionKey,
        now,
        now,
        now,
        identity.requestEpochId,
        sha256(canonicalJson(execution)),
        sha256("[]"),
        storedCount(database, "jobs"),
      );
    createJobAdmissionInTransaction(database, id, now);
    if (ownsTransaction) database.exec("COMMIT");
    return id;
  } catch (error) {
    if (ownsTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function startValidationJob(database: DatabaseSync, jobId: string): void {
  const workerId = `worker-${jobId}`;
  const nodeId = `node-${jobId}`;
  const instanceId = `instance-${jobId}`;
  const attemptId = `attempt-${jobId}`;
  const deadline = new Date(Date.parse(now) + 120_000).toISOString();
  const noProgressDeadline = new Date(Date.parse(now) + 30_000).toISOString();
  const capabilities = canonicalJson({
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    codexVersion: "test",
    recipeIds: [],
    labels: { executionEnvelope: "2", validationHeadless: "1" },
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`INSERT INTO worker_node_credentials (worker_node_id, display_name, token_sha256, auth_state,
      created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at, activated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        nodeId,
        nodeId,
        sha256(nodeId),
        actor.issuer,
        actor.subject,
        actor.issuer,
        actor.subject,
        now,
        now,
        now,
      );
    database
      .prepare(`INSERT INTO workers (id, node_id, instance_id, display_name, version, protocol_version,
      max_slots, capabilities_json, capabilities_digest, status, available_slots, registered_at, last_seen_at, updated_at)
      VALUES (?, ?, ?, ?, 'test', '1.0', 1, ?, ?, 'online', 1, ?, ?, ?)`)
      .run(
        workerId,
        nodeId,
        instanceId,
        workerId,
        capabilities,
        sha256(capabilities),
        now,
        now,
        now,
      );
    expect(
      database
        .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
        .run(now, jobId).changes,
    ).toBe(1);
    database
      .prepare(`UPDATE jobs SET status = 'leased', attempt_count = 1, lease_generation = 1,
      current_run_attempt_id = ?, current_step = 'leased', started_at = ? WHERE id = ?`)
      .run(attemptId, now, jobId);
    database
      .prepare(`INSERT INTO run_attempts (id, job_id, attempt_number, worker_id, worker_node_id,
      worker_instance_id, status, lease_token_hash, lease_generation, lease_expires_at, execution_deadline_at,
      no_progress_timeout_ms, no_progress_deadline_at, last_heartbeat_at, phase, started_at)
      VALUES (?, ?, 1, ?, ?, ?, 'leased', ?, 1, ?, ?, 30000, ?, ?, 'leased', ?)`)
      .run(
        attemptId,
        jobId,
        workerId,
        nodeId,
        instanceId,
        sha256(attemptId),
        deadline,
        deadline,
        noProgressDeadline,
        now,
        now,
      );
    database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    database.prepare("UPDATE run_attempts SET status = 'running' WHERE id = ?").run(attemptId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function associate(database: DatabaseSync, run: ReviewRunDetail, jobId: string) {
  return execute(database, "associateReviewRunJob", {
    repositoryId: run.repositoryId,
    reviewRunId: run.id,
    requestId: "static",
    jobId,
    actor,
  });
}

function rejects(action: () => unknown, code = "PLATFORM_CONFLICT") {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The fixture value is missing.");
  return value;
}

describe("review run persistence", () => {
  it("stores the exact plan, immutable request mapping, and authenticated audit without creating jobs", () => {
    const f = fixture();
    const result = f.create();
    expect(result).toMatchObject({
      repositoryId: f.input.repository.id,
      workItemId: f.input.workItemId,
      revisionKey: f.input.revision.revisionKey,
      requestEpochId: f.input.authorization.requestEpochId,
      activationId: f.input.activationId,
      requestCount: 1,
      blockedRequestCount: 0,
      requiredBlockerCount: 0,
      createdBy: actor,
    });
    expect(result.planDigest).toBe(sha256(canonicalJson(result.plan)));
    expect(result.requests).toEqual([{ requestId: "static", jobs: [] }]);
    expect(result.plan.revision).not.toHaveProperty("observedAt");
    expect(storedCount(f.database, "review_run_audit")).toBe(1);
    expect(storedCount(f.database, "jobs")).toBe(1);
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves missing prompt and profile blockers without fabricating execution results", () => {
    const f = fixture({ configured: false });
    const result = f.create();
    expect(result.readiness).toEqual([
      {
        requestId: "static",
        required: true,
        state: "blocked",
        reasons: [{ code: "missing_profile" }, { code: "missing_prompt" }],
      },
    ]);
    expect(result.requiredBlockerCount).toBe(2);
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("status");
  });

  it("keeps activation replay idempotent even after current repository settings change", () => {
    const f = fixture();
    const first = f.create();
    f.database
      .prepare("UPDATE managed_repositories SET enabled = 0 WHERE id = ?")
      .run(f.input.repository.id);
    expect(f.create(f.input, later)).toEqual(first);
    expect(storedCount(f.database, "review_runs")).toBe(1);
    expect(storedCount(f.database, "review_run_audit")).toBe(1);
  });

  it("creates within the caller's transaction and leaves commit or rollback to that caller", () => {
    const f = fixture();
    rejects(
      () => createReviewRunInTransaction(f.database, { planInput: f.input, actor }, now),
      "PLATFORM_INVALID",
    );
    f.database.exec("BEGIN IMMEDIATE");
    const created = createReviewRunInTransaction(f.database, { planInput: f.input, actor }, now);
    expect(created.intentDigest).toBeNull();
    expect(f.database.isTransaction).toBe(true);
    expect(storedCount(f.database, "review_runs")).toBe(1);
    f.database.exec("ROLLBACK");
    expect(storedCount(f.database, "review_runs")).toBe(0);
    expect(storedCount(f.database, "review_run_requests")).toBe(0);
    expect(storedCount(f.database, "review_run_audit")).toBe(0);
  });

  it("replays an authenticated creation intent before rebuilding changed configuration", () => {
    const f = fixture();
    const intentDigest = sha256("normalized operator body and actor");
    const first = execute(f.database, "createReviewRun", {
      planInput: f.input,
      actor,
      intentDigest,
    });
    f.database
      .prepare("UPDATE managed_repositories SET enabled = 0, version = version + 1 WHERE id = ?")
      .run(f.input.repository.id);
    const changed = changeInput(f.input, (copy) => {
      copy.repository.configurationVersion += 1;
      present(copy.requests[0]).prompt = null;
      copy.runnerSupport = [];
    });
    expect(
      execute(f.database, "createReviewRun", { planInput: changed, actor, intentDigest }, later),
    ).toEqual(first);
    expect(first.intentDigest).toBe(intentDigest);
    expect(storedCount(f.database, "review_runs")).toBe(1);
    expect(storedCount(f.database, "review_run_audit")).toBe(1);
  });

  it("rejects a different normalized request digest for the same activation", () => {
    const f = fixture();
    execute(f.database, "createReviewRun", {
      planInput: f.input,
      actor,
      intentDigest: sha256("first request"),
    });
    rejects(() =>
      execute(f.database, "createReviewRun", {
        planInput: f.input,
        actor,
        intentDigest: sha256("different request"),
      }),
    );
    expect(storedCount(f.database, "review_run_audit")).toBe(1);
  });

  it.each([undefined, sha256("same normalized request")])(
    "rejects actor changes on activation replay with intent %#",
    (intentDigest) => {
      const f = fixture();
      const intent = intentDigest === undefined ? {} : { intentDigest };
      execute(f.database, "createReviewRun", { planInput: f.input, actor, ...intent });
      rejects(() =>
        execute(f.database, "createReviewRun", {
          planInput: f.input,
          actor: { ...actor, subject: "another-operator" },
          ...intent,
        }),
      );
      rejects(() =>
        execute(f.database, "createReviewRun", {
          planInput: f.input,
          actor: { ...actor, issuer: "https://another-issuer.example.test" },
          ...intent,
        }),
      );
    },
  );

  it.each([false, true])(
    "rejects changing whether an activation has an authenticated intent: %s",
    (withIntent) => {
      const f = fixture();
      const intent = { intentDigest: sha256("operator request") };
      execute(f.database, "createReviewRun", {
        planInput: f.input,
        actor,
        ...(withIntent ? intent : {}),
      });
      rejects(() =>
        execute(f.database, "createReviewRun", {
          planInput: f.input,
          actor,
          ...(withIntent ? {} : intent),
        }),
      );
    },
  );

  it.each(["", "a".repeat(63), "g".repeat(64), "A".repeat(64)])(
    "validates creation intent digest %s",
    (intentDigest) => {
      const f = fixture();
      rejects(
        () => execute(f.database, "createReviewRun", { planInput: f.input, actor, intentDigest }),
        "PLATFORM_INVALID",
      );
      expect(storedCount(f.database, "review_runs")).toBe(0);
    },
  );

  it("reads activation identity within the exact repository and work item scope", () => {
    const f = fixture();
    const intentDigest = sha256("operator body and actor");
    const first = execute(f.database, "createReviewRun", {
      planInput: f.input,
      actor,
      intentDigest,
    });
    const lookup = {
      repositoryId: f.input.repository.id,
      workItemId: f.input.workItemId,
      activationId: f.input.activationId,
    };
    expect(execute(f.database, "getReviewRunByActivation", lookup)).toEqual(first);
    expect(
      execute(f.database, "getReviewRunByActivation", {
        ...lookup,
        repositoryId: "other-repository",
      }),
    ).toBeNull();
    expect(
      execute(f.database, "getReviewRunByActivation", { ...lookup, workItemId: "other-work-item" }),
    ).toBeNull();
    expect(
      execute(f.database, "getReviewRunByActivation", {
        ...lookup,
        activationId: "other-activation",
      }),
    ).toBeNull();
    expect(
      execute(f.database, "listReviewRuns", { repositoryId: lookup.repositoryId }).items[0],
    ).not.toHaveProperty("intentDigest");
  });

  it("keeps the first readiness observation on identical plan replay", () => {
    const f = fixture();
    const first = f.create();
    const changed = changeInput(f.input, (copy) => {
      copy.runnerSupport = [];
    });
    expect(f.create(changed)).toEqual(first);
  });

  it("rejects reuse of an activation for a changed plan", () => {
    const f = fixture();
    f.create();
    rejects(() =>
      f.create(
        changeInput(f.input, (copy) => {
          present(copy.requests[0]).requestId = "different-request";
        }),
      ),
    );
    expect(storedCount(f.database, "review_runs")).toBe(1);
  });

  it.each(["review_runs", "review_run_requests", "review_run_audit"])(
    "prevents update and deletion of %s",
    (table) => {
      const f = fixture();
      f.create();
      const column =
        table === "review_runs"
          ? "plan_digest"
          : table === "review_run_requests"
            ? "request_id"
            : "actor_subject";
      expect(() => f.database.exec(`UPDATE ${table} SET ${column} = ${column}`)).toThrow(
        /immutable/u,
      );
      expect(() => f.database.exec(`DELETE FROM ${table}`)).toThrow(/immutable/u);
    },
  );

  it("rolls back the plan and every request when the audit append fails", () => {
    const f = fixture();
    f.database.exec(
      "CREATE TEMP TRIGGER reject_run_audit BEFORE INSERT ON review_run_audit BEGIN SELECT RAISE(ABORT, 'Injected audit failure'); END",
    );
    expect(() => f.create()).toThrow("Injected audit failure");
    expect(storedCount(f.database, "review_runs")).toBe(0);
    expect(storedCount(f.database, "review_run_requests")).toBe(0);
    expect(storedCount(f.database, "review_run_audit")).toBe(0);
  });

  it.each([
    { issuer: "", subject: "operator" },
    { issuer: "x".repeat(2049), subject: "operator" },
    { issuer: "identity", subject: "" },
    { issuer: "identity", subject: "x".repeat(513) },
    { issuer: "identity\0", subject: "operator" },
    { issuer: "identity", subject: "\uD800" },
  ])("rejects malformed authenticated actor %#", (invalidActor) => {
    const f = fixture();
    rejects(
      () => execute(f.database, "createReviewRun", { planInput: f.input, actor: invalidActor }),
      "PLATFORM_INVALID",
    );
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });

  it.each(["invalid", "2026-09-07", "2026-09-07T00:00:00Z"])(
    "requires canonical creation time %s",
    (at) => {
      const f = fixture();
      rejects(() => f.create(f.input, at), "PLATFORM_INVALID");
    },
  );

  it.each([
    "UPDATE managed_repositories SET enabled = 0",
    "UPDATE managed_repositories SET version = version + 1",
    "UPDATE managed_repositories SET full_name = 'example/renamed' WHERE github_repository_id = 1",
    "UPDATE managed_repositories SET reviewer_github_user_id = 200, reviewer_github_login = 'different'",
    "UPDATE work_items SET state = 'closed'",
    "UPDATE work_items SET current_revision_key = 'changed'",
  ])("rejects changed source configuration: %s", (sql) => {
    const f = fixture();
    f.database.exec(sql);
    expect(() => f.create()).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(/^PLATFORM_(?:CONFLICT|NOT_FOUND)$/u),
      }),
    );
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });

  it("rejects a revoked authorization epoch even if the caller retains an active snapshot", () => {
    const f = fixture();
    f.database.exec(
      "UPDATE request_epochs SET status = 'closed', closing_event_id = opening_event_id, close_reason = 'review_request_removed', closed_at = '2026-09-07T00:30:00.000Z'",
    );
    rejects(() => f.create());
  });

  it("rejects an epoch JSON snapshot that no longer agrees with its authoritative decision", () => {
    const f = fixture();
    f.database
      .prepare("UPDATE request_epochs SET epoch_json = json_set(epoch_json, '$.sequence', 20)")
      .run();
    rejects(() => f.create());
  });

  it("rejects an omitted required UI profile even when static validation is present", () => {
    const f = fixture();
    publishProfile(f.database, f.input.repository.id, { ui: true });
    rejects(() => f.create());
  });

  it("permits omitting optional profiles while preserving all required profiles", () => {
    const f = fixture();
    publishProfile(f.database, f.input.repository.id, { ui: true, required: false });
    expect(f.create().requestCount).toBe(1);
  });

  it("prevents a required profile from being disguised as a missing-profile placeholder", () => {
    const f = fixture();
    rejects(() =>
      f.create(
        changeInput(f.input, (copy) => {
          present(copy.requests[0]).profileVersion = null;
        }),
      ),
    );
  });

  it("rejects disabled profile bindings", () => {
    const f = fixture();
    const profile = present(present(f.input.requests[0]).profileVersion);
    configure(f.database, "saveValidationProfileBinding", {
      repositoryId: f.input.repository.id,
      profileId: profile.profileId,
      actor,
      request: { expectedVersion: 1, enabled: false, profileVersionId: profile.id },
    });
    rejects(() => f.create());
  });

  it("rejects edited published snapshots even when their content hash is internally correct", () => {
    const f = fixture();
    rejects(() =>
      f.create(
        changeInput(f.input, (copy) => {
          const prompt = present(present(copy.requests[0]).prompt).version;
          prompt.content = "A different review policy.";
          prompt.contentSha256 = sha256(prompt.content);
        }),
      ),
    );
  });

  it("rejects edited profile snapshots even when their configuration hash is internally correct", () => {
    const f = fixture();
    rejects(() =>
      f.create(
        changeInput(f.input, (copy) => {
          const profile = present(present(copy.requests[0]).profileVersion);
          present(profile.config.build[0]).command.executable = "different-tool";
          profile.configSha256 = sha256(canonicalJson(profile.config));
        }),
      ),
    );
  });

  it("rejects a stale global prompt after a repository override is bound", () => {
    const f = fixture();
    const override = publishPrompt(
      f.database,
      "pr_static_build",
      "Review this repository's rules.",
    );
    configure(f.database, "savePromptBinding", {
      repositoryId: f.input.repository.id,
      workflowKind: "pr_static_build",
      actor,
      request: { expectedVersion: 0, promptVersionId: override.id },
    });
    rejects(() => f.create());
    const changed = changeInput(f.input, (copy) => {
      present(present(copy.requests[0]).prompt).version = override;
    });
    expect(present(present(f.create(changed).plan.jobs[0]).prompt).version).toEqual(override);
  });

  it("rejects missing prompt placeholders when a binding exists", () => {
    const f = fixture();
    rejects(() =>
      f.create(
        changeInput(f.input, (copy) => {
          present(copy.requests[0]).prompt = null;
        }),
      ),
    );
  });

  it("does not consult newer bindings when reading a previously frozen plan", () => {
    const f = fixture();
    const previous = f.create();
    const next = publishPrompt(f.database, "pr_static_build", "New review instructions.");
    configure(f.database, "savePromptBinding", {
      repositoryId: null,
      workflowKind: "pr_static_build",
      actor,
      request: { expectedVersion: 1, promptVersionId: next.id },
    });
    expect(
      execute(f.database, "getReviewRun", {
        repositoryId: f.input.repository.id,
        reviewRunId: previous.id,
      }),
    ).toEqual(previous);
  });

  it("lists exact repository and work item histories before pagination and excludes large snapshots", () => {
    const f = fixture({ configured: false });
    const first = f.create();
    f.create({ ...f.input, activationId: "activation-new" }, later);
    const secondItem = activate(f.database, repository(1), 2);
    f.create(secondItem);
    const otherRepository = activate(f.database, repository(2));
    f.create(otherRepository);
    const page = execute(f.database, "listReviewRuns", {
      repositoryId: f.input.repository.id,
      workItemId: f.input.workItemId,
      page: 2,
      pageSize: 1,
    });
    expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [{ id: first.id }] });
    expect(page.items[0]).not.toHaveProperty("plan");
    expect(page.items[0]).not.toHaveProperty("requests");
    expect(
      execute(f.database, "listReviewRuns", { repositoryId: f.input.repository.id }).total,
    ).toBe(3);
    expect(
      execute(f.database, "listReviewRuns", { repositoryId: otherRepository.repository.id }).total,
    ).toBe(1);
    expect(
      execute(f.database, "getReviewRun", {
        repositoryId: otherRepository.repository.id,
        reviewRunId: first.id,
      }),
    ).toBeNull();
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { pageSize: 0 },
    { pageSize: 51 },
    { pageSize: 1.5 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
  ])("bounds history queries %#", (query) => {
    const f = fixture();
    rejects(
      () =>
        execute(f.database, "listReviewRuns", { repositoryId: f.input.repository.id, ...query }),
      "PLATFORM_INVALID",
    );
  });

  it("recognizes only supported review run operations", () => {
    expect(isReviewRunOperation("associateReviewRunJob")).toBe(true);
    expect(isReviewRunOperation("createReviewRun")).toBe(true);
    expect(isReviewRunOperation("listReviewRuns")).toBe(true);
    expect(isReviewRunOperation("getReviewRun")).toBe(true);
    expect(isReviewRunOperation("toString")).toBe(false);
  });

  it("persists a valid highly escaped prompt within the total plan byte limit", () => {
    const f = fixture();
    const prompt = publishPrompt(f.database, "pr_static_build", "\u0001".repeat(262_144));
    configure(f.database, "savePromptBinding", {
      repositoryId: null,
      workflowKind: "pr_static_build",
      actor,
      request: { expectedVersion: 1, promptVersionId: prompt.id },
    });
    const changed = changeInput(f.input, (copy) => {
      present(present(copy.requests[0]).prompt).version = prompt;
    });
    const created = f.create(changed);
    expect(Buffer.byteLength(canonicalJson(created.plan.jobs[0]), "utf8")).toBeGreaterThan(
      1024 * 1024,
    );
    expect(present(present(created.plan.jobs[0]).prompt).version.content).toBe(prompt.content);
  });

  it("associates pending validation Jobs without runtime support and keeps reruns separate from attempts", () => {
    const f = fixture();
    const run = f.create(
      changeInput(f.input, (input) => {
        input.runnerSupport = [];
      }),
    );
    const firstJob = validationJob(f.database, run);
    expect(run.readiness[0]?.reasons).toContainEqual({ code: "unsupported_target" });
    const pendingAdmission = f.database
      .prepare("SELECT * FROM job_admission WHERE job_id = ?")
      .get(firstJob);
    expect(pendingAdmission).toMatchObject({ state: "pending", attempt_base: 0 });
    const first = associate(f.database, run, firstJob);
    expect(first.requests).toEqual([
      { requestId: "static", jobs: [{ jobId: firstJob, activationNumber: 1 }] },
    ]);
    expect(associate(f.database, run, firstJob)).toEqual(first);
    expect(
      f.database.prepare("SELECT * FROM job_admission WHERE job_id = ?").get(firstJob),
    ).toEqual(pendingAdmission);
    const secondJob = validationJob(f.database, run, 2);
    const second = associate(f.database, run, secondJob);
    expect(present(second.requests[0]).jobs).toEqual([
      { jobId: firstJob, activationNumber: 1 },
      { jobId: secondJob, activationNumber: 2 },
    ]);
    expect(storedCount(f.database, "review_run_audit")).toBe(3);
    expect(storedCount(f.database, "run_attempts")).toBe(0);
  });

  it("requires an existing transaction for scheduler job association", () => {
    const f = fixture();
    const run = f.create();
    const jobId = validationJob(f.database, run);
    rejects(
      () =>
        associateReviewRunJobInTransaction(
          f.database,
          {
            repositoryId: run.repositoryId,
            reviewRunId: run.id,
            requestId: "static",
            jobId,
            actor,
          },
          now,
        ),
      "PLATFORM_INVALID",
    );
    f.database.exec("BEGIN IMMEDIATE");
    expect(
      associateReviewRunJobInTransaction(
        f.database,
        { repositoryId: run.repositoryId, reviewRunId: run.id, requestId: "static", jobId, actor },
        now,
      ).requests[0]?.jobs,
    ).toHaveLength(1);
    f.database.exec("ROLLBACK");
    expect(storedCount(f.database, "review_run_job_links")).toBe(0);
  });

  it("rejects unversioned legacy jobs even when their work item and revision match", () => {
    const f = fixture();
    const run = f.create();
    const legacy = f.database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
    rejects(() => associate(f.database, run, legacy.id));
    expect(() =>
      f.database
        .prepare("INSERT INTO review_run_job_links VALUES (?, 'static', 1, ?, ?)")
        .run(run.id, legacy.id, now),
    ).toThrow(/frozen validation identity/u);
  });

  it.each<[(context: ValidationJobContext) => void, string]>([
    [
      (context) => {
        context.runId = "other-run";
      },
      "run",
    ],
    [
      (context) => {
        context.planDigest = "0".repeat(64);
      },
      "plan digest",
    ],
    [
      (context) => {
        context.activationId = "other-activation";
      },
      "activation",
    ],
    [
      (context) => {
        context.requestId = "other-request";
      },
      "request",
    ],
    [
      (context) => {
        context.repositoryId = "other-repository";
      },
      "repository",
    ],
    [
      (context) => {
        context.workItemId = "other-item";
      },
      "work item",
    ],
    [
      (context) => {
        context.revisionKey = "0".repeat(64);
      },
      "revision",
    ],
    [
      (context) => {
        context.requestEpochId = "other-epoch";
      },
      "epoch",
    ],
    [
      (context) => {
        context.workflowKind = "pr_ui";
      },
      "workflow",
    ],
    [
      (context) => {
        context.target = "web";
      },
      "target",
    ],
    [
      (context) => {
        context.required = false;
      },
      "requirement",
    ],
    [
      (context) => {
        context.profileVersion.id = "other-version";
      },
      "profile",
    ],
    [
      (context) => {
        context.promptVersion.contentSha256 = "0".repeat(64);
      },
      "prompt",
    ],
    [
      (context) => {
        context.requiredCheckIds = [];
      },
      "checks",
    ],
    [
      (context) => {
        context.testedSourceRevision = null;
      },
      "source",
    ],
  ])("rejects mismatched validation %s (%s) through the API and SQL trigger", (modify) => {
    const f = fixture();
    const run = f.create();
    const jobId = validationJob(f.database, structuredClone(run), 1, modify);
    rejects(() => associate(f.database, run, jobId));
    expect(() =>
      f.database
        .prepare("INSERT INTO review_run_job_links VALUES (?, 'static', 1, ?, ?)")
        .run(run.id, jobId, now),
    ).toThrow(/frozen validation identity/u);
  });

  it("rejects skipped activations and replacement jobs for a previously associated activation", () => {
    const f = fixture();
    const run = f.create();
    rejects(() => associate(f.database, run, validationJob(f.database, run, 2)));
    associate(f.database, run, validationJob(f.database, run, 1));
    rejects(() => associate(f.database, run, validationJob(f.database, run, 1)));
  });

  it("rechecks repository enablement before association and rolls back audit failures", () => {
    const f = fixture();
    const run = f.create();
    const job = validationJob(f.database, run);
    f.database
      .prepare("UPDATE managed_repositories SET enabled = 0 WHERE id = ?")
      .run(run.repositoryId);
    rejects(() => associate(f.database, run, job));
    f.database
      .prepare("UPDATE managed_repositories SET enabled = 1 WHERE id = ?")
      .run(run.repositoryId);
    f.database.exec(
      "CREATE TEMP TRIGGER reject_run_audit BEFORE INSERT ON review_run_audit BEGIN SELECT RAISE(ABORT, 'Injected audit failure'); END",
    );
    expect(() => associate(f.database, run, job)).toThrow("Injected audit failure");
    expect(storedCount(f.database, "review_run_job_links")).toBe(0);
  });

  it("locks associated execution identity while allowing normal job state transitions", () => {
    const f = fixture();
    const run = f.create();
    const jobId = validationJob(f.database, run);
    associate(f.database, run, jobId);
    expect(() =>
      f.database.prepare("UPDATE jobs SET execution_json = '{}' WHERE id = ?").run(jobId),
    ).toThrow(/immutable/u);
    expect(() =>
      f.database.prepare("UPDATE jobs SET resource_revision = 'changed' WHERE id = ?").run(jobId),
    ).toThrow(/immutable/u);
    expect(() => f.database.exec("UPDATE review_run_job_links SET activation_number = 2")).toThrow(
      /immutable/u,
    );
    expect(() => f.database.exec("DELETE FROM review_run_job_links")).toThrow(/immutable/u);
    startValidationJob(f.database, jobId);
    expect(associate(f.database, run, jobId).requests[0]?.jobs).toHaveLength(1);
  });

  it("rejects first association after a job has already started", () => {
    const f = fixture();
    const run = f.create();
    const jobId = validationJob(f.database, run);
    startValidationJob(f.database, jobId);
    rejects(() => associate(f.database, run, jobId));
    expect(() =>
      f.database
        .prepare("INSERT INTO review_run_job_links VALUES (?, 'static', 1, ?, ?)")
        .run(run.id, jobId, now),
    ).toThrow(/frozen validation identity/u);
  });

  it("rejects jobs whose real work item differs from their claimed validation context", () => {
    const f = fixture();
    const run = f.create();
    const other = activate(f.database, repository(2));
    const jobId = validationJob(f.database, run, 1, undefined, {
      workItemId: other.workItemId,
      requestEpochId: other.authorization.requestEpochId,
      revisionKey: other.revision.revisionKey,
    });
    rejects(() => associate(f.database, run, jobId));
    expect(() =>
      f.database
        .prepare("INSERT INTO review_run_job_links VALUES (?, 'static', 1, ?, ?)")
        .run(run.id, jobId, now),
    ).toThrow(/frozen validation identity/u);
  });

  it.each<[(execution: JobExecutionTemplateV2) => void, string]>([
    [
      (execution) => {
        execution.executionPolicy.hardTimeoutMs += 1_000;
      },
      "hard timeout",
    ],
    [
      (execution) => {
        execution.executionPolicy.noProgressTimeoutMs += 1_000;
      },
      "progress timeout",
    ],
    [
      (execution) => {
        execution.executionPolicy.allowedRecipeIds = ["unplanned-recipe"];
      },
      "recipe permissions",
    ],
    [
      (execution) => {
        execution.executionPolicy.requiredCapabilityLabels = {};
      },
      "runner capability gate",
    ],
    [
      (execution) => {
        execution.repository.githubRepositoryId = 900;
      },
      "checkout repository ID",
    ],
    [
      (execution) => {
        execution.repository.fullName = "different/repository";
      },
      "checkout repository name",
    ],
    [
      (execution) => {
        if (execution.resource.kind === "pull_request") execution.resource.baseSha = "d".repeat(40);
      },
      "base commit",
    ],
    [
      (execution) => {
        if (execution.resource.kind === "pull_request") execution.resource.headSha = "d".repeat(40);
      },
      "head commit",
    ],
    [
      (execution) => {
        execution.resource.canonicalSnapshot = { title: "Different work item" };
      },
      "work item snapshot",
    ],
    [
      (execution) => {
        execution.prompt.renderedPrompt = "Different instructions with unchanged version metadata.";
        execution.prompt.promptSha256 = sha256(execution.prompt.renderedPrompt);
      },
      "rendered prompt with a matching hash",
    ],
    [
      (execution) => {
        execution.prompt.outputSchema = {};
        execution.prompt.outputSchemaSha256 = sha256("{}");
      },
      "output schema with a matching hash",
    ],
  ])("rejects actual execution content substitution %s (%s) through API and SQL", (modify) => {
    const f = fixture();
    const run = f.create();
    const jobId = validationJob(f.database, run, 1, undefined, run, modify);
    rejects(() => associate(f.database, run, jobId));
    expect(() =>
      f.database
        .prepare("INSERT INTO review_run_job_links VALUES (?, 'static', 1, ?, ?)")
        .run(run.id, jobId, now),
    ).toThrow(/frozen validation identity/u);
  });

  it("reads only the requested frozen prompt and keeps it unchanged after configuration updates", () => {
    const f = fixture();
    const run = f.create();
    const input = { repositoryId: run.repositoryId, reviewRunId: run.id, requestId: "static" };
    const before = execute(f.database, "getReviewRunPromptEnvelope", input);
    expect(before).toMatchObject({
      name: present(present(f.input.requests[0]).prompt).version.templateId,
      version: "1",
    });
    expect(before?.renderedPrompt).toContain(
      present(present(f.input.requests[0]).prompt).version.content,
    );
    const next = publishPrompt(f.database, "pr_static_build", "New instructions.");
    configure(f.database, "savePromptBinding", {
      repositoryId: null,
      workflowKind: "pr_static_build",
      actor,
      request: { expectedVersion: 1, promptVersionId: next.id },
    });
    expect(execute(f.database, "getReviewRunPromptEnvelope", input)).toEqual(before);
    rejects(
      () =>
        execute(f.database, "getReviewRunPromptEnvelope", {
          ...input,
          repositoryId: "other-repository",
        }),
      "PLATFORM_NOT_FOUND",
    );
  });

  it("enforces the complete plan encoded byte limit before any database writes", () => {
    const f = fixture({ configured: false });
    const prompt = publishPrompt(f.database, "pr_static_build", "\u0001".repeat(262_144));
    const input = changeInput(f.input, (copy) => {
      copy.requests = Array.from({ length: 12 }, (_, index) => ({
        ...present(copy.requests[0]),
        requestId: `request-${index}`,
        prompt: { workflowKind: "pr_static_build", version: prompt },
      }));
    });
    rejects(() => f.create(input), "PLATFORM_INVALID");
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });

  it("keeps issue source selection blocked until explicit operator authorization is recorded", () => {
    const f = fixture({ kind: "issue", configured: false });
    const created = f.create();
    expect(created.plan.testedSourceAuthorization).toBeNull();
    expect(created.requiredRequestBlockers).toContainEqual({
      requestId: "static",
      reason: "missing_source_authorization",
    });
  });

  it("records exact issue source authorization from the creating operator", () => {
    const f = fixture({ kind: "issue", configured: false });
    const input = changeInput(f.input, (copy) => {
      copy.testedSourceAuthorization = {
        kind: "operator",
        activationId: copy.activationId,
        ...actor,
        authorizedAt: now,
        githubRepositoryId: copy.repository.githubRepositoryId,
        githubWorkItemId: copy.workItem.githubWorkItemId,
        issueRevisionKey: copy.revision.revisionKey,
        headSha: "c".repeat(40),
      };
    });
    const created = f.create(input);
    expect(created.plan.testedSourceAuthorization).toEqual(input.testedSourceAuthorization);
    expect(created.requiredRequestBlockers).not.toContainEqual({
      requestId: "static",
      reason: "missing_source_authorization",
    });
    expect(present(created.readiness[0]).state).toBe("blocked");
  });

  it.each(["issuer", "subject", "future time"])(
    "rejects issue source authorization from another %s",
    (mismatch) => {
      const f = fixture({ kind: "issue", configured: false });
      const input = changeInput(f.input, (copy) => {
        copy.testedSourceAuthorization = {
          kind: "operator",
          activationId: copy.activationId,
          ...actor,
          authorizedAt: now,
          githubRepositoryId: copy.repository.githubRepositoryId,
          githubWorkItemId: copy.workItem.githubWorkItemId,
          issueRevisionKey: copy.revision.revisionKey,
          headSha: "c".repeat(40),
        };
        if (mismatch === "issuer") copy.testedSourceAuthorization.issuer = "different-identity";
        else if (mismatch === "subject")
          copy.testedSourceAuthorization.subject = "different-operator";
        else copy.testedSourceAuthorization.authorizedAt = later;
      });
      rejects(() => f.create(input), "PLATFORM_INVALID");
      expect(storedCount(f.database, "review_runs")).toBe(0);
    },
  );
});
