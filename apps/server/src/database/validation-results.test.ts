import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createCanonicalResult,
  IssueTriageV1ModelOutputSchema,
  type IssueTriageV2,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV1ModelOutputSchema,
  type PrReviewPlanV2,
  PrReviewPlanV2ModelOutputSchema,
  type ValidationJobResultV1,
  ValidationJobResultV1Schema,
} from "@agentic-review/codex";
import type {
  ActiveAuthorizedRequestEpoch,
  GitHubRepository,
  JobExecutionTemplateV2,
  ManagedRepository,
  ReviewRunPlanInput,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
  ValidationCommandStep,
  ValidationProfileConfig,
  ValidationProfileCreateRequest,
  ValidationSummaryV1,
  WorkflowKind,
} from "@agentic-review/contracts";
import { validationExecutorCapabilityLabels } from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createValidationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import {
  assertCurrentIssueReproductionAuthorization,
  recomputeIssueReproductionRequestAssessment,
} from "./issue-reproduction.js";
import {
  readIssueReproductionCaseInTransaction,
  readIssueReproductionResult,
  readIssueReproductionRunSummary,
} from "./issue-reproduction-queries.js";
import { createJobAdmissionInTransaction, getJobAdmissionRecord } from "./job-admission.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import {
  handlePromptConfigurationRequest,
  type PromptConfigurationOperation,
  type PromptConfigurationOperationMap,
  type PromptConfigurationRequest,
} from "./prompt-configuration.js";
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
  type ReviewRunDetail,
} from "./review-runs.js";
import {
  collectValidationCompletionEvidence,
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

const now = "2026-09-07T00:00:00.000Z";
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
  for (const database of databases.splice(0)) database.close();
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
  legacyVersion?: 1 | 2;
  blockedReproduction?: boolean;
  extraUiScenario?: boolean;
  largeProfile?: boolean;
  mappedReproduction?: boolean;
  mappedUiReproduction?: boolean;
  declaredProbe?: boolean;
  traceOff?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const workflowKind = options.workflowKind ?? "pr_static_build";
  const mappedReproduction = options.mappedReproduction || options.mappedUiReproduction;
  const kind = workflowKind.startsWith("pr_") ? "pull_request" : "issue";
  const observed = openedEvent(kind);
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON");
  runMigrations(database, migrationsDirectory);
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
    options.mappedUiReproduction ? "pr_ui" : workflowKind,
    options.commandRequired,
  );
  if (mappedReproduction || options.declaredProbe)
    present(config.test[0]).probeOutput = {
      schemaVersion: "TestProbeOutputDeclarationV1",
      fields: [{ id: "status", description: "The precise status measurement.", type: "string" }],
    };
  if ((options.traceOff || options.mappedUiReproduction) && config.ui?.target === "web")
    config.ui.evidence.trace = "off";
  if (options.largeProfile) {
    for (const phase of ["setup", "build", "test", "cleanup"] as const)
      config[phase] = Array.from({ length: 32 }, (_, index) => command(`${phase}-${index + 1}`));
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
    ...(workflowKind === "pr_ui"
      ? { workflowKind, target: "web", outputSchemaVersion: "ValidationReportV1" }
      : workflowKind === "pr_static_build"
        ? { workflowKind, target: "headless", outputSchemaVersion: "PrReviewPlanV2" }
        : workflowKind === "issue_triage"
          ? { workflowKind, target: "headless", outputSchemaVersion: "IssueTriageV2" }
          : {
              workflowKind,
              target: options.mappedUiReproduction ? "web" : "headless",
              outputSchemaVersion: "ValidationReportV1",
            }),
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
        capabilities: [
          ...(profile.target === "web" ? ["ui:web"] : []),
          ...(mappedReproduction ? [validationExecutorCapabilityLabels.reproduction] : []),
          ...(mappedReproduction || options.declaredProbe
            ? [validationExecutorCapabilityLabels.probes]
            : []),
          ...(options.traceOff || options.mappedUiReproduction
            ? [validationExecutorCapabilityLabels.uiObservations]
            : []),
        ],
        evidenceDelivery: true,
      },
    ],
  };
  if (mappedReproduction)
    planInput.reproduction = {
      schemaVersion: "IssueReproductionRequestV1",
      claim: "The status is duplicated.",
      cases: [
        {
          id: "status-case",
          profileId: profile.profileId,
          expectedProfileVersionId: profile.id,
          context: "Observe the exact application status.",
          preconditions: options.mappedUiReproduction
            ? [{ kind: "check_passed", checkId: `${profile.id}:settings` }]
            : [],
          presentWhen: {
            allOf: [
              {
                observation: {
                  kind: "probe_value",
                  testStepId: "unit-tests",
                  observationId: "status",
                },
                equals: { type: "string", value: "Duplicate" },
              },
            ],
          },
          absentWhen: {
            allOf: [
              {
                observation: {
                  kind: "probe_value",
                  testStepId: "unit-tests",
                  observationId: "status",
                },
                equals: { type: "string", value: "Ready" },
              },
            ],
          },
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
    if (options.associate !== false)
      associateReviewRunJobInTransaction(
        database,
        { repositoryId: managed.id, reviewRunId: run.id, requestId: "selected", jobId, actor },
        now,
      );
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

function historicM14Fixture(
  migrationDirectory: string,
  options: { workflowKind: "pr_static_build" | "issue_triage"; legacyVersion: 1 | 2 },
) {
  const source = fixture(options);
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON");
  expect(runMigrations(database, migrationDirectory)).toBe(14);

  // Project only historical columns into a fresh M14 database. Current ingestion requires
  // current migrations and must never be called against the schema under migration test.
  const projections = [
    {
      table: "repositories",
      columns: `id, github_repository_id, github_node_id, owner_login, name, full_name,
        html_url, default_branch, is_private, snapshot_json, observed_at, created_at, updated_at`,
    },
    {
      table: "managed_repositories",
      columns: `id, github_repository_id, full_name, enabled, version, reviewer_github_user_id,
        reviewer_github_login, authorization_policy_json, connection_status, connection_message,
        metadata_json, configuration_source, created_at, updated_at`,
    },
    {
      table: "work_items",
      columns: `id, repository_id, resource_kind, github_work_item_id, github_node_id, github_number,
        state, title, body, html_url, author_github_user_id, author_login, author_account_type,
        current_revision_key, is_draft, source_created_at, source_updated_at, source_closed_at,
        snapshot_json, projection_source, observed_at, created_at, updated_at`,
    },
    {
      table: "work_item_revisions",
      columns: `id, work_item_id, revision_key, resource_kind, base_sha, head_sha, content_digest,
        source_updated_at, observed_at, revision_json, created_at`,
    },
    {
      table: "webhook_deliveries",
      columns:
        "delivery_id, event_name, payload_sha256, received_at, processed_at, status, result_json",
    },
    {
      table: "github_events",
      columns: `id, event_key, source, source_event_id, webhook_delivery_id, repository_id,
        work_item_id, revision_id, action, request_kind, close_reason, actor_github_user_id,
        actor_login, target_github_user_id, target_login, occurred_at, observed_at,
        normalized_sha256, normalized_json, result_json, created_at`,
    },
    {
      table: "authorization_decisions",
      columns: `id, decision_key, github_event_id, work_item_id, outcome, basis, reason,
        policy_kind, policy_version, actor_github_user_id, target_github_user_id,
        inherited_from_epoch_id, evaluated_at, policy_json, policy_sha256, decision_json, created_at`,
    },
    {
      table: "request_epochs",
      columns: `id, work_item_id, ordinal, request_kind, target_github_user_id, opening_event_id,
        authorization_decision_id, current_revision_id, status, opened_at, closing_event_id,
        close_reason, closed_at, epoch_json, created_at, updated_at`,
    },
    {
      table: "jobs",
      columns: `id, work_item_id, job_kind, generation, intent_version, semantic_key, concurrency_key,
        status, priority, execution_json, required_capabilities_json, resource_revision,
        execution_affinity_node_id, attempt_count, max_attempts, lease_generation,
        current_run_attempt_id, current_step, next_attempt_at, cancellation_requested_at,
        started_at, completed_at, failure_code, failure_message, created_at, updated_at,
        request_epoch_id, source_event_id, execution_digest, required_capabilities_digest, activation`,
      predicate: "id = ?",
    },
    {
      table: "job_request_epochs",
      columns: "job_id, request_epoch_id, linked_at",
      predicate: "job_id = ?",
    },
    {
      table: "workers",
      columns: `id, node_id, instance_id, display_name, version, protocol_version, max_slots,
        capabilities_json, capabilities_digest, status, heartbeat_sequence, available_slots,
        health_json, superseded_at, registered_at, last_seen_at, updated_at`,
    },
  ] as const;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const projection of projections) {
      const predicate = "predicate" in projection ? projection.predicate : undefined;
      const rows = source.database
        .prepare(
          `SELECT ${projection.columns} FROM ${projection.table}${predicate === undefined ? "" : ` WHERE ${predicate}`}`,
        )
        .all(...(predicate === undefined ? [] : [source.legacyJobId])) as Record<
        string,
        SQLInputValue
      >[];
      expect(rows).toHaveLength(1);
      for (const row of rows) insertRow(database, projection.table, row);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name IN ('validation_job_results', 'github_review_run_sources')",
      )
      .all(),
  ).toEqual([]);
  return { database, legacyJobId: source.legacyJobId };
}

function beginAttempt(
  database: DatabaseSync,
  jobId: string,
  schema: "current" | "historical_m14" = "current",
): ReviewCompletionJobContext {
  const attemptId = `attempt-${jobId}`;
  expect(database.isTransaction).toBe(false);
  database.exec("BEGIN IMMEDIATE");
  try {
    if (schema === "historical_m14") {
      // The upgrade test deliberately creates an old completion before migration 24 exists.
      expect(
        database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({ version: 14 });
    } else {
      // Result tests explicitly admit one complete, frozen Job. Admission selection and runtime
      // capacity policy have separate suites; never grant a fixture-wide admission bypass.
      expect(getJobAdmissionRecord(database, jobId)).toMatchObject({
        state: "pending",
        attemptBase: 0,
        ownershipState: "resolved",
        admittedAt: null,
      });
      const admitted = database
        .prepare(`UPDATE job_admission SET state = 'admitted', admitted_at = ?
        WHERE job_id = ? AND state = 'pending' AND attempt_base = 0`)
        .run(now, jobId);
      expect(Number(admitted.changes)).toBe(1);
    }
    const leased = database
      .prepare(`UPDATE jobs SET status = 'leased', current_run_attempt_id = ?,
      attempt_count = 1, lease_generation = 1 WHERE id = ? AND status = 'queued' AND attempt_count = 0`)
      .run(attemptId, jobId);
    expect(Number(leased.changes)).toBe(1);
    insertRow(database, "run_attempts", {
      id: attemptId,
      job_id: jobId,
      attempt_number: 1,
      worker_id: "worker-1",
      worker_node_id: "node-1",
      worker_instance_id: "instance-1",
      status: "running",
      lease_token_hash: sha256("lease-token"),
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

function prReview(): PrReviewPlanV2 {
  return {
    schemaVersion: "PrReviewPlanV2",
    summary: "A null-handle check is missing.",
    assessment: "request_changes",
    findings: [
      {
        findingId: "finding-1",
        priority: 1,
        title: "Guard null handles",
        body: "A missing handle must be rejected before use.",
        path: "src/settings.ts",
        line: 12,
        endLine: 14,
        confidence: 0.9,
      },
    ],
    requestedRecipeIds: [],
    verification: {
      status: "not_run",
      summary: "The runner performs validation separately.",
      commands: [],
    },
    executionEvidence: {
      schemaVersion: "ReviewExecutionEvidenceV1",
      source: "worker",
      commandCapture: "complete",
      commands: [],
      worktree: { status: "clean", source: "git_status" },
    },
  };
}

function issueReview(): IssueTriageV2 {
  return {
    schemaVersion: "IssueTriageV2",
    summary: "The settings panel crashes.",
    category: "bug",
    priority: 1,
    confidence: 0.9,
    suggestedLabels: ["bug"],
    missingInformation: ["Provide the application version."],
    duplicateCandidates: [],
    requestedRecipeIds: [],
    verification: {
      status: "not_run",
      summary: "The report has not been reproduced.",
      commands: [],
    },
    executionEvidence: {
      schemaVersion: "ReviewExecutionEvidenceV1",
      source: "worker",
      commandCapture: "complete",
      commands: [],
      worktree: { status: "clean", source: "git_status" },
    },
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
          name: `Observed ${step.name}`,
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
  for (const scenario of f.profile.config.ui?.scenarios ?? []) {
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
  }
  const execution: ValidationJobResultV1["execution"] = {
    blockers: [],
    diagnostics,
    cleanupState: f.profile.config.cleanup.length > 0 ? "completed" : "not_needed",
  };
  const commonReport = {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    summary: "Configured validation completed.",
    sourceState: "original",
    checks,
  } as const;
  return f.context.jobKind === "pull_request_review"
    ? {
        schemaVersion: "ValidationJobResultV1",
        report: { ...commonReport, workItemKind: "pull_request" },
        execution,
        modelReview:
          f.profile.workflowKind === "pr_static_build"
            ? { state: "completed", result: prReview() }
            : { state: "not_requested" },
      }
    : {
        schemaVersion: "ValidationJobResultV1",
        report: { ...commonReport, workItemKind: "issue", reproductionConclusion: "inconclusive" },
        execution,
        modelReview:
          f.profile.workflowKind === "issue_triage"
            ? { state: "completed", result: issueReview() }
            : { state: "not_requested" },
      };
}

function validate(
  f: ReturnType<typeof fixture>,
  result: unknown = resultFor(f),
  context = f.context,
) {
  return validateValidationCompletion(
    f.database,
    context,
    createCanonicalResult(result).sha256,
    result,
  );
}

function complete(f: ReturnType<typeof fixture>, result: ValidationJobResultV1 = resultFor(f)) {
  const validated = validate(f, result);
  f.database.exec("BEGIN IMMEDIATE");
  try {
    finishAttempt(f.database, f.context, validated);
    const id = persistValidatedValidationResult(f.database, f.context, validated, later);
    f.database
      .prepare("UPDATE jobs SET status = 'succeeded', completed_at = ? WHERE id = ?")
      .run(later, f.context.jobId);
    f.database.exec("COMMIT");
    return { id, validated };
  } catch (error) {
    f.database.exec("ROLLBACK");
    throw error;
  }
}

function finishAttempt(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
  result: { resultDigest: string; canonicalResultJson: string },
) {
  database
    .prepare(
      "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
    )
    .run(result.resultDigest, result.canonicalResultJson, later, context.runAttemptId);
}

function changedContext(
  f: ReturnType<typeof fixture>,
  mutate: (value: JobExecutionTemplateV2) => void,
): ReviewCompletionJobContext {
  const execution = structuredClone(f.execution);
  mutate(execution);
  const executionJson = canonicalJson(execution);
  return { ...f.context, executionJson, executionDigest: sha256(executionJson) };
}

function invalidResult(action: () => unknown) {
  expect(action).toThrow(expect.objectContaining({ code: "REVIEW_RESULT_INVALID" }));
}

function invalidContext(action: () => unknown) {
  expect(action).toThrow(expect.objectContaining({ code: "STORED_EXECUTION_TEMPLATE_INVALID" }));
}

function mappedResult(f: ReturnType<typeof fixture>): ValidationJobResultV1 {
  const result = resultFor(f);
  const output = {
    schemaVersion: "ProbeObservationsV1" as const,
    observations: [
      {
        id: "status",
        state: "observed" as const,
        value: { type: "string" as const, value: "Duplicate" },
      },
    ],
  };
  result.probeReceipts = [
    {
      schemaVersion: "TestProbeReceiptV1",
      requestId: "selected",
      jobId: f.context.jobId,
      runAttemptId: f.context.runAttemptId,
      planDigest: f.run.planDigest,
      profileVersionId: f.profile.id,
      checkId: `${f.profile.id}:unit-tests`,
      capture: "complete",
      output,
      outputSha256: sha256(canonicalJson(output)),
    },
  ];
  const recomputed = present(
    recomputeIssueReproductionRequestAssessment({
      validation: f.execution.validation,
      jobId: f.context.jobId,
      runAttemptId: f.context.runAttemptId,
      result,
    }),
  );
  if (result.report.workItemKind !== "issue") throw new Error("A mapped fixture must be an Issue.");
  result.report.reproductionConclusion = recomputed.assessment.conclusion;
  Object.assign(result, { reproductionAssessment: recomputed.assessment });
  return result;
}

describe("mapped reproduction completion and current projection", () => {
  it("M22 admits exactly the protocol extensions derived from each immutable profile", () => {
    for (const options of [
      { workflowKind: "issue_validation" as const, mappedReproduction: true },
      { workflowKind: "issue_validation" as const, declaredProbe: true },
      { workflowKind: "pr_ui" as const, traceOff: true },
      { workflowKind: "pr_static_build" as const },
    ]) {
      const f = fixture(options);
      const latest = f.database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number };
      expect(latest.version).toBe(33);
      const labels = f.execution.executionPolicy.requiredCapabilityLabels;
      expect(Object.keys(labels)).toHaveLength(
        options.mappedReproduction ? 4 : options.declaredProbe || options.traceOff ? 3 : 2,
      );
      expect(
        f.database
          .prepare("SELECT job_id FROM review_run_job_links WHERE job_id = ?")
          .get(f.context.jobId),
      ).toBeDefined();
    }
  });

  it("M22 preserves raw association guards against missing, extra, or substituted protocol authority", () => {
    const f = fixture({ workflowKind: "issue_validation", mappedReproduction: true });
    const changes: ((template: JobExecutionTemplateV2) => void)[] = [
      (template) => {
        delete template.executionPolicy.requiredCapabilityLabels.issueReproduction;
      },
      (template) => {
        delete template.executionPolicy.requiredCapabilityLabels.structuredProbeOutput;
      },
      (template) => {
        template.executionPolicy.requiredCapabilityLabels.untrusted = "1";
      },
      (template) => {
        template.executionPolicy.requiredCapabilityLabels.uiAssertionObservation = "1";
      },
      (template) => {
        template.executionPolicy.requiredCapabilityLabels.issueReproduction = "2";
      },
      (template) => {
        delete template.validation.reproduction;
      },
      (template) => {
        present(template.validation.reproduction).bindingDigest = "e".repeat(64);
      },
      (template) => {
        present(template.validation.reproduction).binding.cases = [];
      },
      (template) => {
        template.validation.planDigest = "e".repeat(64);
      },
    ];
    for (const [index, change] of changes.entries()) {
      const template = structuredClone(f.execution);
      template.validation.jobActivation = 2;
      change(template);
      const json = canonicalJson(template);
      const jobId = `rejected-m22-${index}`;
      insertRow(f.database, "jobs", {
        id: jobId,
        work_item_id: f.run.workItemId,
        job_kind: "issue_triage",
        semantic_key: jobId,
        concurrency_key: jobId,
        status: "queued",
        execution_json: json,
        resource_revision: f.run.revisionKey,
        next_attempt_at: later,
        created_at: later,
        updated_at: later,
        request_epoch_id: f.run.requestEpochId,
        execution_digest: sha256(json),
        required_capabilities_digest: sha256("[]"),
      });
      expect(() =>
        f.database
          .prepare(
            "INSERT INTO review_run_job_links (review_run_id, request_id, activation_number, job_id, linked_at) VALUES (?, 'selected', 2, ?, ?)",
          )
          .run(f.run.id, jobId, later),
      ).toThrow(/frozen validation identity/u);
    }
    const unbound = fixture({ workflowKind: "issue_validation" });
    const injected = structuredClone(unbound.execution);
    injected.validation.jobActivation = 2;
    injected.validation.reproduction = present(f.execution.validation.reproduction);
    injected.executionPolicy.requiredCapabilityLabels.issueReproduction = "1";
    const json = canonicalJson(injected);
    insertRow(unbound.database, "jobs", {
      id: "unbound-injection",
      work_item_id: unbound.run.workItemId,
      job_kind: "issue_triage",
      semantic_key: "unbound-injection",
      concurrency_key: "unbound-injection",
      status: "queued",
      execution_json: json,
      resource_revision: unbound.run.revisionKey,
      next_attempt_at: later,
      created_at: later,
      updated_at: later,
      request_epoch_id: unbound.run.requestEpochId,
      execution_digest: sha256(json),
      required_capabilities_digest: sha256("[]"),
    });
    expect(() =>
      unbound.database
        .prepare(
          "INSERT INTO review_run_job_links (review_run_id, request_id, activation_number, job_id, linked_at) VALUES (?, 'selected', 2, 'unbound-injection', ?)",
        )
        .run(unbound.run.id, later),
    ).toThrow(/frozen validation identity/u);
  });

  it("independently validates and stores the request assessment without copying model advice", () => {
    const f = fixture({ workflowKind: "issue_validation", mappedReproduction: true });
    const result = mappedResult(f);
    expect(validate(f, result).result).toMatchObject({
      reproductionAssessment: { conclusion: "confirmed" },
    });
    const forged = structuredClone(result);
    if (forged.report.workItemKind !== "issue") throw new Error("The Issue fixture is missing.");
    forged.report.reproductionConclusion = "not_reproduced";
    invalidResult(() => validate(f, forged));
    const { id } = complete(f, result);
    f.database.exec("BEGIN");
    try {
      const scope = { repositoryId: f.run.repositoryId, reviewRunId: f.run.id };
      expect(readIssueReproductionRunSummary(f.database, scope)?.assessment).toMatchObject({
        conclusion: "confirmed",
        coverage: "complete",
      });
      const detail = present(
        readIssueReproductionCaseInTransaction(f.database, {
          ...scope,
          requestId: "selected",
          caseId: "status-case",
        }),
      );
      expect(detail).toMatchObject({
        resultId: id,
        jobId: f.context.jobId,
        recorded: { state: "present" },
        current: { state: "present" },
      });
      expect(detail.observations).toHaveLength(1);
      expect(detail.observations[0]).toMatchObject({
        state: "observed",
        value: { type: "string", value: "Duplicate" },
      });
      expect(
        readIssueReproductionCaseInTransaction(f.database, {
          ...scope,
          requestId: "another",
          caseId: "status-case",
        }),
      ).toBeNull();
    } finally {
      f.database.exec("ROLLBACK");
    }
  });

  it("projects pending UI proof as inconclusive while retaining a known unsafe probe obstruction", () => {
    for (const unsafe of [false, true]) {
      const f = fixture({ workflowKind: "issue_validation", mappedUiReproduction: true });
      const result = mappedResult(f);
      const uiCheck = present(result.report.checks.find((check) => check.kind === "ui"));
      const assetId = "00000000-0000-4000-8000-000000000001";
      uiCheck.evidenceIds = [assetId];
      const metadata = {
        kind: "steps",
        mediaType: "application/json",
        sizeBytes: 2,
        sha256: sha256("{}"),
        capturedAt: now,
        checkId: uiCheck.id,
      };
      const validation = f.execution.validation;
      // Persist real scoped manifest/chunk transitions. Only file verification is substituted.
      f.database
        .prepare(`INSERT INTO evidence_assets (
        id, repository_id, review_run_id, request_id, job_id, run_attempt_id, profile_version_id,
        revision_key, plan_digest, client_asset_id, metadata_json, kind, media_type, size_bytes,
        sha256, check_id, file_device, file_inode, committed_bytes, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synthetic-steps-proof', ?, 'steps', 'application/json',
        2, ?, ?, '1', '1', 0, 'uploading', ?, ?)`)
        .run(
          assetId,
          validation.repositoryId,
          validation.runId,
          validation.requestId,
          f.context.jobId,
          f.context.runAttemptId,
          validation.profileVersion.id,
          validation.revisionKey,
          validation.planDigest,
          canonicalJson(metadata),
          metadata.sha256,
          uiCheck.id,
          now,
          now,
        );
      f.database
        .prepare(`INSERT INTO evidence_asset_chunks (asset_id, byte_offset, size_bytes, sha256, created_at)
        VALUES (?, 0, 2, ?, ?)`)
        .run(assetId, metadata.sha256, now);
      f.database
        .prepare(`UPDATE evidence_assets SET committed_bytes = 2, state = 'finalized', finalized_at = ?, updated_at = ?
        WHERE id = ?`)
        .run(later, later, assetId);
      result.execution.diagnostics.push({
        stepId: uiCheck.id,
        phase: "ui",
        outcome: "passed",
        exitCode: 0,
        summary: "The controlled UI check completed.",
      });
      for (const diagnostic of result.execution.diagnostics)
        if (diagnostic.phase === "launch") diagnostic.exitCode = 0;
      if (unsafe) {
        const probe = present(result.probeReceipts?.[0]);
        probe.output.observations = [{ id: "status", state: "unavailable" }];
        probe.outputSha256 = sha256(canonicalJson(probe.output));
      }
      // The fixture substitutes the trusted prepared proof boundary without reading asset files.
      const admitted = {
        validateEvidenceReferences: () => true,
        validateScenarioEvidence: () => true,
        readScenarioObservations: () => [],
      };
      const recomputed = present(
        recomputeIssueReproductionRequestAssessment(
          {
            validation: f.execution.validation,
            jobId: f.context.jobId,
            runAttemptId: f.context.runAttemptId,
            result,
          },
          admitted,
        ),
      );
      if (result.report.workItemKind !== "issue") throw new Error("The Issue fixture is missing.");
      result.report.reproductionConclusion = recomputed.assessment.conclusion;
      Object.assign(result, { reproductionAssessment: recomputed.assessment });
      const validated = validateValidationCompletion(
        f.database,
        f.context,
        createCanonicalResult(result).sha256,
        result,
        undefined,
        admitted,
      );
      f.database.exec("BEGIN IMMEDIATE");
      try {
        finishAttempt(f.database, f.context, validated);
        persistValidatedValidationResult(f.database, f.context, validated, later);
        f.database
          .prepare("UPDATE jobs SET status = 'succeeded', completed_at = ? WHERE id = ?")
          .run(later, f.context.jobId);
        const current = present(
          readIssueReproductionCaseInTransaction(
            f.database,
            {
              repositoryId: f.run.repositoryId,
              reviewRunId: f.run.id,
              requestId: "selected",
              caseId: "status-case",
            },
            {
              verificationStatus: () => "pending",
              validateEvidenceReferences: () => false,
              validateScenarioEvidence: () => false,
              readScenarioObservations: () => null,
            },
          ),
        );
        expect(current.recorded?.state).toBe(unsafe ? "blocked" : "present");
        expect(current.current.state).toBe(unsafe ? "blocked" : "inconclusive");
        if (!unsafe) expect(current.current.reasons).toEqual(["execution_pending"]);
      } finally {
        f.database.exec("ROLLBACK");
      }
    }
  });

  it("projects mapped terminal results after completion clears the active attempt pointer", () => {
    const f = fixture({ workflowKind: "issue_validation", mappedReproduction: true });
    const { id } = complete(f, mappedResult(f));
    f.database
      .prepare("UPDATE jobs SET current_run_attempt_id = NULL WHERE id = ?")
      .run(f.context.jobId);
    expect(
      f.database
        .prepare("SELECT status, current_run_attempt_id FROM jobs WHERE id = ?")
        .get(f.context.jobId),
    ).toEqual({ status: "succeeded", current_run_attempt_id: null });
    f.database.exec("BEGIN");
    try {
      const scope = { repositoryId: f.run.repositoryId, reviewRunId: f.run.id };
      expect(readIssueReproductionRunSummary(f.database, scope)?.assessment).toMatchObject({
        conclusion: "confirmed",
        coverage: "complete",
        cases: [{ caseId: "status-case", state: "present" }],
      });
      expect(
        readIssueReproductionResult(f.database, {
          ...scope,
          requestId: "selected",
          jobId: f.context.jobId,
        }),
      ).toMatchObject({
        recordedAssessment: { conclusion: "confirmed", coverage: "complete" },
        currentAssessment: { conclusion: "confirmed", coverage: "complete" },
      });
      const query = { ...scope, requestId: "selected", caseId: "status-case" };
      const detail = present(readIssueReproductionCaseInTransaction(f.database, query));
      expect(detail).toMatchObject({
        jobId: f.context.jobId,
        resultId: id,
        recorded: { state: "present" },
        current: { state: "present" },
        observations: [{ state: "observed", value: { type: "string", value: "Duplicate" } }],
      });
      expect(
        readIssueReproductionCaseInTransaction(f.database, {
          ...query,
          jobId: f.context.jobId,
        }),
      ).toEqual(detail);
    } finally {
      f.database.exec("ROLLBACK");
    }
  });

  it.each([
    {
      identity: "a nonfinal attempt",
      statement: "UPDATE jobs SET attempt_count = 2 WHERE id = ?",
      target: "job",
    },
    {
      identity: "an unsuccessful attempt",
      statement: "UPDATE run_attempts SET status = 'failed' WHERE id = ?",
      target: "attempt",
    },
    {
      identity: "a mismatched attempt digest",
      statement:
        "UPDATE run_attempts SET result_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE id = ?",
      target: "attempt",
    },
    {
      identity: "a foreign job attempt",
      statement: "UPDATE run_attempts SET job_id = 'foreign-job' WHERE id = ?",
      target: "attempt",
    },
  ])("does not project mapped terminal results with $identity", ({ statement, target }) => {
    const f = fixture({ workflowKind: "issue_validation", mappedReproduction: true });
    complete(f, mappedResult(f));
    f.database
      .prepare("UPDATE jobs SET current_run_attempt_id = NULL WHERE id = ?")
      .run(f.context.jobId);
    // Corrupt only this isolated database to exercise read guards beyond persistence protection.
    f.database.exec("PRAGMA foreign_keys = OFF");
    f.database.exec("DROP TRIGGER tr_run_attempt_completed_validation_identity_immutable");
    f.database.prepare(statement).run(target === "job" ? f.context.jobId : f.context.runAttemptId);
    f.database.exec("BEGIN");
    try {
      const scope = { repositoryId: f.run.repositoryId, reviewRunId: f.run.id };
      expect(readIssueReproductionRunSummary(f.database, scope)?.assessment.conclusion).toBe(
        "blocked",
      );
      expect(
        readIssueReproductionResult(f.database, {
          ...scope,
          requestId: "selected",
          jobId: f.context.jobId,
        }),
      ).toBeUndefined();
      expect(
        readIssueReproductionCaseInTransaction(f.database, {
          ...scope,
          requestId: "selected",
          caseId: "status-case",
          jobId: f.context.jobId,
        }),
      ).toMatchObject({
        jobId: f.context.jobId,
        resultId: null,
        recorded: null,
        current: { state: "blocked", reasons: ["execution_blocked"] },
        observations: [],
      });
    } finally {
      f.database.exec("ROLLBACK");
    }
  });

  it("rechecks live Issue and repository authority after asynchronous evidence preparation", () => {
    const f = fixture({ workflowKind: "issue_validation", mappedReproduction: true });
    const result = mappedResult(f);
    collectValidationCompletionEvidence(
      f.database,
      f.context,
      createCanonicalResult(result).sha256,
      result,
    );
    invalidContext(() =>
      assertCurrentIssueReproductionAuthorization(f.database, f.execution, f.context),
    );
    f.database.exec("BEGIN IMMEDIATE");
    try {
      expect(() =>
        assertCurrentIssueReproductionAuthorization(f.database, f.execution, f.context),
      ).not.toThrow();
      f.database
        .prepare("UPDATE managed_repositories SET enabled = 0 WHERE id = ?")
        .run(f.run.repositoryId);
      invalidContext(() =>
        assertCurrentIssueReproductionAuthorization(f.database, f.execution, f.context),
      );
    } finally {
      f.database.exec("ROLLBACK");
    }
    f.database.exec("BEGIN IMMEDIATE");
    try {
      f.database
        .prepare("UPDATE work_items SET current_revision_key = ? WHERE id = ?")
        .run("e".repeat(64), f.run.workItemId);
      invalidContext(() =>
        assertCurrentIssueReproductionAuthorization(f.database, f.execution, f.context),
      );
    } finally {
      f.database.exec("ROLLBACK");
    }
  });

  it("keeps recorded confirmation while current closed-Issue projection is blocked", () => {
    const f = fixture({ workflowKind: "issue_validation", mappedReproduction: true });
    complete(f, mappedResult(f));
    f.database.exec("BEGIN IMMEDIATE");
    try {
      f.database
        .prepare("UPDATE work_items SET state = 'closed' WHERE id = ?")
        .run(f.run.workItemId);
      const scope = { repositoryId: f.run.repositoryId, reviewRunId: f.run.id };
      expect(readIssueReproductionRunSummary(f.database, scope)?.assessment.conclusion).toBe(
        "blocked",
      );
      expect(
        readIssueReproductionResult(f.database, {
          ...scope,
          requestId: "selected",
          jobId: f.context.jobId,
        }),
      ).toMatchObject({
        recordedAssessment: { conclusion: "confirmed" },
        currentAssessment: { conclusion: "blocked" },
      });
      const detail = present(
        readIssueReproductionCaseInTransaction(f.database, {
          ...scope,
          requestId: "selected",
          caseId: "status-case",
        }),
      );
      expect(detail.observations).toEqual([]);
      expect(detail.current.reasons).toEqual(["invalid_scope"]);
    } finally {
      f.database.exec("ROLLBACK");
    }
  });

  it("uses a queued replacement as pending instead of falling back to historical positive evidence", () => {
    const f = fixture({ workflowKind: "issue_validation", mappedReproduction: true });
    complete(f, mappedResult(f));
    f.database
      .prepare("UPDATE jobs SET current_run_attempt_id = NULL WHERE id = ?")
      .run(f.context.jobId);
    const replacement = createValidationExecutionTemplate({
      runId: f.run.id,
      plan: f.run.plan,
      planDigest: f.run.planDigest,
      requestId: "selected",
      jobActivation: 2,
      frozenPrompt: f.execution.prompt,
    });
    const replacementJson = canonicalJson(replacement);
    insertRow(f.database, "jobs", {
      id: "replacement",
      work_item_id: f.run.workItemId,
      job_kind: "issue_triage",
      semantic_key: "replacement",
      concurrency_key: "replacement",
      status: "queued",
      execution_json: replacementJson,
      resource_revision: f.run.revisionKey,
      next_attempt_at: later,
      created_at: later,
      updated_at: later,
      request_epoch_id: f.run.requestEpochId,
      execution_digest: sha256(replacementJson),
      required_capabilities_digest: sha256("[]"),
    });
    f.database.exec("BEGIN IMMEDIATE");
    try {
      associateReviewRunJobInTransaction(
        f.database,
        {
          repositoryId: f.run.repositoryId,
          reviewRunId: f.run.id,
          requestId: "selected",
          jobId: "replacement",
          actor,
        },
        later,
      );
      const scope = { repositoryId: f.run.repositoryId, reviewRunId: f.run.id };
      expect(readIssueReproductionRunSummary(f.database, scope)?.assessment).toMatchObject({
        conclusion: "inconclusive",
        coverage: "partial",
      });
      expect(
        readIssueReproductionCaseInTransaction(f.database, {
          ...scope,
          requestId: "selected",
          caseId: "status-case",
        }),
      ).toMatchObject({
        jobId: "replacement",
        resultId: null,
        recorded: null,
        current: { state: "inconclusive", reasons: ["execution_pending"] },
      });
      expect(
        readIssueReproductionResult(f.database, {
          ...scope,
          requestId: "selected",
          jobId: f.context.jobId,
        }),
      ).toMatchObject({
        recordedAssessment: { conclusion: "confirmed" },
        currentAssessment: { conclusion: "blocked" },
      });
      expect(
        readIssueReproductionCaseInTransaction(f.database, {
          ...scope,
          requestId: "selected",
          caseId: "status-case",
          jobId: f.context.jobId,
        }),
      ).toMatchObject({
        jobId: f.context.jobId,
        recorded: { state: "present" },
        current: { state: "blocked", reasons: ["invalid_scope"] },
        observations: [],
      });
    } finally {
      f.database.exec("ROLLBACK");
    }
  });
});

describe("validation completion frozen identity", () => {
  it("rejects a result digest containing a trailing line terminator", () => {
    const f = fixture();
    const result = resultFor(f);
    const digest = createCanonicalResult(result).sha256;
    expect(() =>
      validateValidationCompletion(f.database, f.context, `${digest}\n`, result),
    ).toThrow(expect.objectContaining({ code: "RESULT_DIGEST_MISMATCH" }));
  });
  it("accepts a real M14 plan and keeps model findings separate from runner checks", () => {
    const f = fixture();
    const result = resultFor(f);
    const validated = validate(f, result);
    expect(validated).toMatchObject({
      schemaId: "ValidationJobResultV1",
      result,
      canonicalResultJson: canonicalJson(result),
      resultDigest: sha256(canonicalJson(result)),
      evidenceComplete: true,
    });
    expect(
      f.database
        .prepare("SELECT COUNT(*) AS count FROM review_run_job_links WHERE job_id = ?")
        .get(f.context.jobId),
    ).toEqual({ count: 1 });
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects an otherwise valid V2 envelope without its persisted run link", () => {
    const f = fixture({ associate: false });
    invalidContext(() => validate(f));
  });

  it("keeps legacy and validation result entry points separate", () => {
    const f = fixture();
    const legacy = beginAttempt(f.database, f.legacyJobId);
    invalidContext(() => validate(f, resultFor(f), legacy));
    invalidContext(() =>
      validateReviewCompletion(f.context, createCanonicalResult(prReview()).sha256, prReview()),
    );
    invalidResult(() => validate(f, prReview()));
  });

  it.each<[string, Partial<ReviewCompletionJobContext>]>([
    ["job", { jobId: "unknown-job" }],
    ["attempt", { runAttemptId: "unknown-attempt" }],
    ["work item", { workItemId: "other-work-item" }],
    ["revision ID", { revisionId: "other-revision" }],
    ["revision key", { resourceRevision: "0".repeat(64) }],
    ["base SHA", { revisionBaseSha: "c".repeat(40) }],
    ["head SHA", { revisionHeadSha: "c".repeat(40) }],
    ["job kind", { jobKind: "issue_triage" }],
    ["work item kind", { workItemResourceKind: "issue" }],
    ["revision kind", { revisionResourceKind: "issue" }],
    ["missing work item", { workItemId: null }],
    ["missing revision", { revisionId: null }],
    ["missing digest", { executionDigest: null }],
    ["digest mismatch", { executionDigest: "0".repeat(64) }],
    ["invalid JSON", { executionJson: "{" }],
  ])("rejects a mismatched completion context: %s", (_name, changed) => {
    const f = fixture();
    invalidContext(() => validate(f, resultFor(f), { ...f.context, ...changed }));
  });

  it.each<[string, (value: JobExecutionTemplateV2) => void]>([
    [
      "run",
      (value) => {
        value.validation.runId = "other-run";
      },
    ],
    [
      "plan digest",
      (value) => {
        value.validation.planDigest = "0".repeat(64);
      },
    ],
    [
      "activation",
      (value) => {
        value.validation.activationId = "other-activation";
      },
    ],
    [
      "request",
      (value) => {
        value.validation.requestId = "other-request";
      },
    ],
    [
      "job activation",
      (value) => {
        value.validation.jobActivation = 2;
      },
    ],
    [
      "repository",
      (value) => {
        value.validation.repositoryId = "other-repository";
      },
    ],
    [
      "epoch",
      (value) => {
        value.validation.requestEpochId = "other-epoch";
      },
    ],
    [
      "profile version",
      (value) => {
        value.validation.profileVersion.id = "other-profile";
      },
    ],
    [
      "prompt version",
      (value) => {
        value.validation.promptVersion.id = "other-prompt";
      },
    ],
    [
      "required checks",
      (value) => {
        value.validation.requiredCheckIds = [];
      },
    ],
    [
      "tested source",
      (value) => {
        value.validation.testedSourceRevision = { kind: "commit", headSha: "c".repeat(40) };
      },
    ],
    [
      "rendered prompt",
      (value) => {
        value.prompt.renderedPrompt = "A different prompt";
        value.prompt.promptSha256 = sha256(value.prompt.renderedPrompt);
      },
    ],
    [
      "output schema",
      (value) => {
        value.prompt.outputSchema = {};
        value.prompt.outputSchemaSha256 = sha256("{}");
      },
    ],
  ])("rejects a recomputed envelope that differs from frozen %s", (_name, mutate) => {
    const f = fixture();
    invalidContext(() => validate(f, resultFor(f), changedContext(f, mutate)));
  });

  it("rejects noncanonical execution bytes even with their matching byte digest", () => {
    const f = fixture();
    const executionJson = JSON.stringify(f.execution, null, 2);
    invalidContext(() =>
      validate(f, resultFor(f), {
        ...f.context,
        executionJson,
        executionDigest: sha256(executionJson),
      }),
    );
  });

  it("rejects a result digest mismatch and oversized UTF-8 input", () => {
    const f = fixture();
    expect(() =>
      validateValidationCompletion(f.database, f.context, "0".repeat(64), resultFor(f)),
    ).toThrow(expect.objectContaining({ code: "RESULT_DIGEST_MISMATCH" }));
    const result = resultFor(f);
    const review = prReview();
    review.findings = Array.from({ length: 100 }, (_, index) => ({
      ...present(prReview().findings[0]),
      findingId: `finding-${index}`,
      body: "\u754c".repeat(8_192),
    }));
    result.modelReview = { state: "completed", result: review };
    const json = canonicalJson(result);
    expect(Value.Check(ValidationJobResultV1Schema, result)).toBe(true);
    expect(json.length).toBeLessThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(2 * 1024 * 1024);
    invalidResult(() => validate(f, result));
  });
});

describe("validation check provenance and completeness", () => {
  it("does not trust a supplied canonical cache that differs from the submitted payload", () => {
    const f = fixture();
    const result = resultFor(f);
    const canonical = canonicalizeReviewResultSubmission(result);
    invalidResult(() =>
      validateValidationCompletion(f.database, f.context, canonical.resultDigest, result, {
        ...canonical,
        canonicalResultJson: "{}",
      }),
    );
    invalidResult(() =>
      validateValidationCompletion(f.database, f.context, canonical.resultDigest, result, {
        ...canonical,
        resultDigest: "0".repeat(64),
      }),
    );
  });
  it.each<[string, (result: ValidationJobResultV1, f: ReturnType<typeof fixture>) => void]>([
    [
      "duplicate check",
      (result) => {
        result.report.checks.push(structuredClone(present(result.report.checks[0])));
      },
    ],
    [
      "unknown profile",
      (result) => {
        present(result.report.checks[0]).id = "other-profile:prepare";
      },
    ],
    [
      "unknown step",
      (result, f) => {
        present(result.report.checks[0]).id = `${f.profile.id}:unknown`;
      },
    ],
    [
      "unqualified ID",
      (result) => {
        present(result.report.checks[0]).id = "prepare";
      },
    ],
    [
      "downgraded required",
      (result) => {
        present(result.report.checks[0]).required = false;
      },
    ],
    [
      "wrong command kind",
      (result) => {
        present(result.report.checks[0]).kind = "ui";
      },
    ],
    [
      "unknown evidence asset",
      (result) => {
        present(result.report.checks[0]).evidenceIds = ["unregistered-screenshot"];
      },
    ],
    [
      "unknown diagnostic",
      (result) => {
        present(result.execution.diagnostics[0]).stepId = "other-profile:prepare";
      },
    ],
    [
      "wrong diagnostic phase",
      (result) => {
        present(result.execution.diagnostics[0]).phase = "build";
      },
    ],
    [
      "wrong diagnostic outcome",
      (result) => {
        present(result.execution.diagnostics[0]).outcome = "failed";
      },
    ],
    [
      "duplicate diagnostic",
      (result) => {
        result.execution.diagnostics.push(
          structuredClone(present(result.execution.diagnostics[0])),
        );
      },
    ],
    [
      "passed command with nonzero exit code",
      (result) => {
        present(result.execution.diagnostics[0]).exitCode = 1;
      },
    ],
    [
      "unknown blocker step",
      (result) => {
        result.execution.blockers.push({
          phase: "setup",
          stepId: "other-profile:prepare",
          code: "SETUP_FAILED",
          message: "Setup failed.",
        });
      },
    ],
    [
      "mismatched blocker phase",
      (result) => {
        result.execution.blockers.push({
          phase: "cleanup",
          stepId: present(result.report.checks[0]).id,
          code: "SETUP_FAILED",
          message: "Setup failed.",
        });
      },
    ],
    [
      "invalid failure code",
      (result) => {
        result.modelReview = {
          state: "failed",
          code: "invalid-code",
          message: "Model execution failed.",
        };
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const f = fixture();
    const result = resultFor(f);
    mutate(result, f);
    invalidResult(() => validate(f, result));
  });

  it.each<[string, (result: ValidationJobResultV1) => void]>([
    [
      "a missing required check",
      (result) => {
        result.report.checks.pop();
        result.execution.diagnostics.pop();
      },
    ],
    [
      "a missing diagnostic",
      (result) => {
        result.execution.diagnostics.pop();
      },
    ],
    [
      "model-sourced evidence",
      (result) => {
        present(result.report.checks[0]).source = "model";
      },
    ],
    [
      "a lifecycle blocker",
      (result) => {
        result.execution.blockers.push({
          phase: "cleanup",
          stepId: null,
          code: "CLEANUP_FAILED",
          message: "Cleanup did not finish.",
        });
        result.execution.cleanupState = "failed";
      },
    ],
  ])("persists %s without claiming complete evidence", (_name, mutate) => {
    const f = fixture();
    const result = resultFor(f);
    mutate(result);
    const { validated } = complete(f, result);
    expect(validated.evidenceComplete).toBe(false);
    expect(
      f.database
        .prepare("SELECT evidence_complete FROM validation_job_results WHERE job_id = ?")
        .get(f.context.jobId),
    ).toEqual({ evidence_complete: 0 });
  });

  it("preserves required step flags when both profile and request are optional", () => {
    const f = fixture({ requestRequired: false, profileRequired: false });
    expect(f.execution.validation.required).toBe(false);
    expect(f.execution.validation.requiredCheckIds).toEqual([]);
    expect(validate(f).evidenceComplete).toBe(true);
    const result = resultFor(f);
    present(result.report.checks[0]).required = false;
    invalidResult(() => validate(f, result));
  });

  it("preserves optional step flags even when the overall request is required", () => {
    const f = fixture({ commandRequired: false });
    expect(f.execution.validation.required).toBe(true);
    expect(validate(f).evidenceComplete).toBe(true);
    const result = resultFor(f);
    present(result.report.checks[0]).required = true;
    invalidResult(() => validate(f, result));
  });

  it("does not equate complete diagnostics with the original source remaining unmodified", () => {
    const f = fixture();
    for (const sourceState of ["modified", "unknown"] as const) {
      const result = resultFor(f);
      result.report.sourceState = sourceState;
      expect(validate(f, result).evidenceComplete).toBe(true);
    }
  });

  it.each(["setup", "cleanup"] as const)(
    "cannot claim successful %s by omitting a lifecycle blocker",
    (phase) => {
      const f = fixture();
      const result = resultFor(f);
      const diagnostic = present(
        result.execution.diagnostics.find((entry) => entry.phase === phase),
      );
      diagnostic.outcome = "failed";
      diagnostic.exitCode = 1;
      present(result.report.checks.find((check) => check.id === diagnostic.stepId)).outcome =
        "failed";
      expect(complete(f, result).validated.evidenceComplete).toBe(false);
    },
  );

  it("does not require display names to equal configured step names", () => {
    const f = fixture();
    const result = resultFor(f);
    present(result.report.checks[0]).name = "Prepare the exact revision workspace";
    expect(validate(f, result).evidenceComplete).toBe(true);
  });

  it("stores a genuine build failure as complete observations rather than infrastructure failure", () => {
    const f = fixture();
    const result = resultFor(f);
    const build = present(result.report.checks.find((check) => check.kind === "build"));
    build.outcome = "failed";
    build.summary = "The compiler reported an unresolved symbol.";
    const diagnostic = present(
      result.execution.diagnostics.find((entry) => entry.stepId === build.id),
    );
    diagnostic.outcome = "failed";
    diagnostic.exitCode = 1;
    diagnostic.stderr = "error TS2304: Cannot find name 'missingHandle'.";
    const { validated } = complete(f, result);
    expect(validated.evidenceComplete).toBe(true);
    expect(validated.result.report.checks.find((check) => check.id === build.id)?.outcome).toBe(
      "failed",
    );
    expect(f.database.prepare("SELECT status FROM jobs WHERE id = ?").get(f.context.jobId)).toEqual(
      { status: "succeeded" },
    );
  });

  it("stores UI scenario observations without claiming complete evidence when no finalized asset validator is available", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultFor(f);
    if (result.report.workItemKind !== "pull_request") throw new Error("A PR report is required.");
    result.report.modelSummary = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "pull_request",
      summary: "The settings panel is visible.",
      recommendation: "needs_human_review",
      observations: [],
    };
    const { validated } = complete(f, result);
    expect(validated.evidenceComplete).toBe(false);
    expect(validated.result.report.checks.some((check) => check.kind === "ui")).toBe(true);
  });

  it("rejects a nested PR review in a UI workflow", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultFor(f);
    result.modelReview = { state: "completed", result: prReview() };
    invalidResult(() => validate(f, result));
  });
});

type EvidenceReferenceValidator = NonNullable<
  NonNullable<Parameters<typeof validateValidationCompletion>[5]>["validateEvidenceReferences"]
>;

function resultWithUiEvidence(f: ReturnType<typeof fixture>): ValidationJobResultV1 {
  const result = resultFor(f);
  for (const [index, check] of result.report.checks
    .filter((entry) => entry.kind === "ui")
    .entries()) {
    check.evidenceIds = [`finalized-evidence-${index + 1}`];
    result.execution.diagnostics.push({
      stepId: check.id,
      phase: "ui",
      outcome: check.outcome,
      exitCode: null,
      summary: "The scenario produced a finalized screenshot.",
    });
  }
  return result;
}

function validateWithEvidence(
  f: ReturnType<typeof fixture>,
  result: ValidationJobResultV1,
  validateEvidenceReferences: EvidenceReferenceValidator,
  validateScenarioEvidence: EvidenceReferenceValidator = () => true,
) {
  return validateValidationCompletion(
    f.database,
    f.context,
    createCanonicalResult(result).sha256,
    result,
    undefined,
    { validateEvidenceReferences, validateScenarioEvidence },
  );
}

describe("validation result finalized evidence references", () => {
  it("retains a typed partial report when asset proofs exist but scenario proof is negative", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    const scenario = vi.fn(() => false);
    const validated = validateWithEvidence(f, result, () => true, scenario);
    expect(scenario).toHaveBeenCalledWith(
      expect.objectContaining({
        checkId: result.report.checks.find((check) => check.kind === "ui")?.id,
        runAttemptId: f.context.runAttemptId,
      }),
    );
    expect(validated.evidenceComplete).toBe(false);
    expect(validated.result).toEqual(result);
  });

  it("does not claim complete UI evidence when the semantic verifier is absent", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    const validated = validateValidationCompletion(
      f.database,
      f.context,
      createCanonicalResult(result).sha256,
      result,
      undefined,
      { validateEvidenceReferences: () => true },
    );
    expect(validated.evidenceComplete).toBe(false);
    expect(
      validated.result.report.checks.some(
        (check) => check.kind === "ui" && check.outcome === "passed",
      ),
    ).toBe(true);
  });

  it("collects frozen evidence dependencies without granting persistence authority", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    const canonical = canonicalizeReviewResultSubmission(result);
    const collected = collectValidationCompletionEvidence(
      f.database,
      f.context,
      canonical.resultDigest,
      result,
    );
    const context = f.execution.validation;
    expect(collected.scopes).toEqual(
      result.report.checks
        .filter((check) => check.evidenceIds.length > 0)
        .map((check) => ({
          repositoryId: context.repositoryId,
          runId: context.runId,
          requestId: context.requestId,
          jobId: f.context.jobId,
          runAttemptId: f.context.runAttemptId,
          profileVersionId: context.profileVersion.id,
          checkId: check.id,
          evidenceIds: check.evidenceIds,
        })),
    );
    expect(collected).not.toHaveProperty("evidenceComplete");
    expect(collected).not.toHaveProperty("schemaId");
    expect(Object.isFrozen(collected.scopes)).toBe(true);
    expect(Object.isFrozen(collected.result.report.checks)).toBe(true);
    present(result.report.checks.find((check) => check.evidenceIds.length > 0)).evidenceIds.push(
      "late-reference",
    );
    expect(collected.scopes.flatMap((scope) => scope.evidenceIds)).not.toContain("late-reference");
    expect(() =>
      persistValidatedValidationResult(
        f.database,
        f.context,
        collected as unknown as Parameters<typeof persistValidatedValidationResult>[2],
        later,
      ),
    ).toThrow(/completion context/u);
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });

  it("checks canonical identity and diagnostic rules before collecting work for the verifier", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    expect(() =>
      collectValidationCompletionEvidence(f.database, f.context, "0".repeat(64), result),
    ).toThrow();
    present(result.execution.diagnostics[0]).phase = "ui";
    const canonical = canonicalizeReviewResultSubmission(result);
    invalidResult(() =>
      collectValidationCompletionEvidence(f.database, f.context, canonical.resultDigest, result),
    );
  });
  it("keeps persistent launch readiness in diagnostics without inventing a static check", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    const launchId = `${f.profile.id}:launch`;
    expect(result.report.checks.some((check) => check.id === launchId)).toBe(false);
    expect(
      result.execution.diagnostics.find((diagnostic) => diagnostic.stepId === launchId),
    ).toMatchObject({
      phase: "launch",
      outcome: "passed",
      exitCode: null,
    });
    expect(validateWithEvidence(f, result, () => true).evidenceComplete).toBe(true);
  });

  it("does not require an additional launch diagnostic when every actual check has evidence", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    result.execution.diagnostics = result.execution.diagnostics.filter(
      (diagnostic) => diagnostic.phase !== "launch",
    );
    expect(validateWithEvidence(f, result, () => true).evidenceComplete).toBe(true);
  });

  it.each(["failed", "blocked"] as const)(
    "does not claim complete evidence after a %s launch diagnostic",
    (outcome) => {
      const f = fixture({ workflowKind: "pr_ui" });
      const result = resultWithUiEvidence(f);
      const launch = present(
        result.execution.diagnostics.find((diagnostic) => diagnostic.phase === "launch"),
      );
      launch.outcome = outcome;
      launch.exitCode = outcome === "failed" ? 1 : null;
      expect(validateWithEvidence(f, result, () => true).evidenceComplete).toBe(false);
    },
  );

  it("rejects an independent launch check in the report", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    result.report.checks.push({
      ...present(result.report.checks[0]),
      id: `${f.profile.id}:launch`,
      name: "Launch readiness",
    });
    invalidResult(() => validateWithEvidence(f, result, () => true));
  });

  it("accepts a lifecycle blocker referring to the frozen launch step", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    result.execution.blockers.push({
      phase: "launch",
      stepId: `${f.profile.id}:launch`,
      code: "LAUNCH_BLOCKED",
      message: "The service did not become ready.",
    });
    expect(validateWithEvidence(f, result, () => true).evidenceComplete).toBe(false);
  });

  it("passes each referenced check and the exact frozen identity to the evidence validator", () => {
    const f = fixture({ workflowKind: "pr_ui", extraUiScenario: true });
    const result = resultWithUiEvidence(f);
    const referencedChecks = result.report.checks.filter((check) => check.evidenceIds.length > 0);
    const validator = vi.fn<EvidenceReferenceValidator>(() => true);
    const validated = validateWithEvidence(f, result, validator);
    expect(validated.evidenceComplete).toBe(true);
    expect(validator).toHaveBeenCalledTimes(2);
    for (const [index, check] of referencedChecks.entries()) {
      expect(validator).toHaveBeenNthCalledWith(index + 1, {
        repositoryId: f.run.repositoryId,
        runId: f.run.id,
        requestId: "selected",
        jobId: f.context.jobId,
        runAttemptId: f.context.runAttemptId,
        profileVersionId: f.profile.id,
        checkId: check.id,
        evidenceIds: check.evidenceIds,
      });
    }
  });

  it.each(["passed", "failed"] as const)(
    "retains a %s UI outcome when its runner observations and finalized references are complete",
    (outcome) => {
      const f = fixture({ workflowKind: "pr_ui" });
      const result = resultWithUiEvidence(f);
      const check = present(result.report.checks.find((entry) => entry.kind === "ui"));
      check.outcome = outcome;
      present(result.execution.diagnostics.find((entry) => entry.stepId === check.id)).outcome =
        outcome;
      const validated = validateWithEvidence(f, result, () => true);
      expect(validated.evidenceComplete).toBe(true);
      expect(validated.result.report.checks.find((entry) => entry.id === check.id)?.outcome).toBe(
        outcome,
      );
    },
  );

  it("rejects an evidence validator returning false for a referenced asset", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const validator = vi.fn<EvidenceReferenceValidator>(() => false);
    invalidResult(() => validateWithEvidence(f, resultWithUiEvidence(f), validator));
    expect(validator).toHaveBeenCalledOnce();
  });

  it("rejects a validator failure without treating unavailable storage as finalized evidence", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const validator = vi.fn<EvidenceReferenceValidator>(() => {
      throw new Error("Evidence storage is unavailable.");
    });
    invalidResult(() => validateWithEvidence(f, resultWithUiEvidence(f), validator));
    expect(validator).toHaveBeenCalledOnce();
  });

  it.each([
    "repositoryId",
    "runId",
    "requestId",
    "jobId",
    "runAttemptId",
    "profileVersionId",
    "checkId",
  ] as const)("rejects a finalized asset from another %s", (identityField) => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    const check = present(result.report.checks.find((entry) => entry.kind === "ui"));
    const assetScope = {
      repositoryId: f.run.repositoryId,
      runId: f.run.id,
      requestId: "selected",
      jobId: f.context.jobId,
      runAttemptId: f.context.runAttemptId,
      profileVersionId: f.profile.id,
      checkId: check.id,
      [identityField]: `other-${identityField}`,
    };
    const validator = vi.fn<EvidenceReferenceValidator>(
      (scope) => scope[identityField] === assetScope[identityField],
    );
    invalidResult(() => validateWithEvidence(f, result, validator));
    expect(validator).toHaveBeenCalledOnce();
  });

  it("does not infer finalized evidence from the presence of a validator alone", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    for (const check of result.report.checks) check.evidenceIds = [];
    const validator = vi.fn<EvidenceReferenceValidator>(() => true);
    expect(validateWithEvidence(f, result, validator).evidenceComplete).toBe(false);
    expect(validator).not.toHaveBeenCalled();
  });

  it("requires every UI scenario to reference finalized evidence independently", () => {
    const f = fixture({ workflowKind: "pr_ui", extraUiScenario: true });
    const result = resultWithUiEvidence(f);
    const checks = result.report.checks.filter((check) => check.kind === "ui");
    present(checks[1]).evidenceIds = [];
    const validator = vi.fn<EvidenceReferenceValidator>(() => true);
    expect(validateWithEvidence(f, result, validator).evidenceComplete).toBe(false);
    expect(validator).toHaveBeenCalledOnce();
  });

  it("does not replace a missing UI diagnostic with a finalized screenshot", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithUiEvidence(f);
    result.execution.diagnostics = result.execution.diagnostics.filter(
      (diagnostic) => diagnostic.phase !== "ui",
    );
    expect(validateWithEvidence(f, result, () => true).evidenceComplete).toBe(false);
  });

  it("retains fail-closed behavior for nonempty UI asset references without a validator", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    invalidResult(() => validate(f, resultWithUiEvidence(f)));
  });

  it("validates references on command checks as well as UI scenarios", () => {
    const f = fixture();
    const result = resultFor(f);
    const check = present(result.report.checks.find((entry) => entry.kind === "build"));
    check.evidenceIds = ["finalized-build-log"];
    const validator = vi.fn<EvidenceReferenceValidator>(() => true);
    expect(validateWithEvidence(f, result, validator).evidenceComplete).toBe(true);
    expect(validator).toHaveBeenCalledOnce();
    expect(validator).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: check.id, evidenceIds: check.evidenceIds }),
    );
  });
});

function resultWithSummary(f: ReturnType<typeof fixture>): ValidationJobResultV1 {
  const result = resultFor(f);
  const observations: ValidationSummaryV1["observations"] = [
    {
      id: "settings-observation",
      title: "Settings behavior needs attention",
      body: "The recorded settings checks warrant operator review.",
      priority: 1,
      path: "src/settings.ts",
      line: 12,
    },
  ];
  const common = {
    schemaVersion: "ValidationSummaryV1" as const,
    summary: "Observed settings behavior.",
    observations,
  };
  if (result.report.workItemKind === "pull_request") {
    result.report.modelSummary = {
      ...common,
      workItemKind: "pull_request",
      recommendation: "needs_human_review",
    };
  } else {
    result.report.modelSummary = {
      ...common,
      workItemKind: "issue",
      reproductionConclusion: "confirmed",
    };
  }
  return result;
}

describe("optional model summary completion semantics", () => {
  it.each(["pr_ui", "issue_validation"] as const)(
    "stores a strict %s summary without replacing the runner report or legacy model state",
    (workflowKind) => {
      const f = fixture({ workflowKind });
      const runner = resultFor(f);
      const result = resultWithSummary(f);
      const summary = present(result.report.modelSummary);
      summary.observations.push(
        { ...present(summary.observations[0]), id: "general-observation", path: null, line: null },
        { ...present(summary.observations[0]), id: "file-observation", line: null },
      );
      const { id, validated } = complete(f, result);
      expect(validated.result.modelReview).toEqual({ state: "not_requested" });
      expect(validated.result.execution).toEqual(runner.execution);
      expect(validated.result.report).toEqual({ ...runner.report, modelSummary: summary });
      expect(validated.evidenceComplete).toBe(workflowKind === "issue_validation");
      const stored = f.database
        .prepare("SELECT result_json, result_digest FROM validation_job_results WHERE id = ?")
        .get(id);
      expect(stored).toEqual({
        result_json: canonicalJson(result),
        result_digest: sha256(canonicalJson(result)),
      });
      expect(() =>
        f.database
          .prepare("UPDATE validation_job_results SET result_json = '{}' WHERE id = ?")
          .run(id),
      ).toThrow(/immutable/u);
    },
  );

  it.each(["pr_ui", "issue_validation"] as const)(
    "rejects failed and legacy completed model states alongside a successful %s summary",
    (workflowKind) => {
      const f = fixture({ workflowKind });
      const result = resultWithSummary(f);
      for (const modelReview of [
        { state: "failed", code: "SUMMARY_FAILED", message: "The optional summary failed." },
        { state: "completed", result: workflowKind === "pr_ui" ? prReview() : issueReview() },
      ])
        invalidResult(() => validate(f, { ...result, modelReview }));
    },
  );

  it.each(["pr_static_build", "issue_triage"] as const)(
    "rejects summary output on a %s legacy review workflow even if no model review was requested",
    (workflowKind) => {
      const f = fixture({ workflowKind });
      const result = resultWithSummary(f);
      invalidResult(() => validate(f, result));
      result.modelReview = { state: "not_requested" };
      invalidResult(() => validate(f, result));
    },
  );

  it.each(["pr_ui", "issue_validation"] as const)(
    "rejects duplicated observation IDs and a foreign summary kind on %s",
    (workflowKind) => {
      const f = fixture({ workflowKind });
      const result = resultWithSummary(f);
      const summary = present(result.report.modelSummary);
      summary.observations.push({
        ...present(summary.observations[0]),
        body: "A different observation with the same identity.",
      });
      invalidResult(() => validate(f, result));
      const foreign =
        workflowKind === "pr_ui"
          ? {
              schemaVersion: "ValidationSummaryV1",
              workItemKind: "issue",
              summary: "Issue advice.",
              reproductionConclusion: "confirmed",
              observations: [],
            }
          : {
              schemaVersion: "ValidationSummaryV1",
              workItemKind: "pull_request",
              summary: "PR advice.",
              recommendation: "approve",
              observations: [],
            };
      invalidResult(() =>
        validate(f, { ...result, report: { ...result.report, modelSummary: foreign } }),
      );
    },
  );

  it.each([
    { path: null, line: 1 },
    { path: "src/settings.ts", line: 0 },
    { path: "src/settings.ts", line: 1.5 },
    { path: "src/settings.ts", line: 10_000_001 },
    { path: "/src/settings.ts", line: null },
    { path: "C:/repo/settings.ts", line: null },
    { path: "src\\settings.ts", line: null },
    { path: "../settings.ts", line: null },
    { path: "src/../settings.ts", line: null },
    { path: "src/./settings.ts", line: null },
    { path: "src//settings.ts", line: null },
    { path: "src/settings.ts/", line: null },
    { path: ".", line: null },
    { path: "src/settings.ts\n", line: null },
    { path: "src/settings\u007f.ts", line: null },
  ])("rejects an incoherent or unsafe observation location: $path:$line", (location) => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithSummary(f);
    Object.assign(present(present(result.report.modelSummary).observations[0]), location);
    invalidResult(() => validate(f, result));
  });

  it("rejects invalid Unicode before accepting a summary digest", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithSummary(f);
    present(present(result.report.modelSummary).observations[0]).path = "src/settings\ud800.ts";
    invalidResult(() =>
      validateValidationCompletion(f.database, f.context, "0".repeat(64), result),
    );
  });

  it.each([
    { checks: [] },
    { sourceState: "original" },
    { source: "worker" },
    { evidenceComplete: true },
    { evidenceIds: ["forged-evidence"] },
    { execution: { blockers: [], cleanupState: "completed", diagnostics: [] } },
    { verification: { status: "passed" } },
    { schemaVersion: "ValidationReportV1" },
  ])("rejects model-supplied execution authority fields: %j", (injected) => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithSummary(f);
    invalidResult(() =>
      validate(f, {
        ...result,
        report: { ...result.report, modelSummary: { ...result.report.modelSummary, ...injected } },
      }),
    );
  });

  it("cannot put execution authority fields inside an observation", () => {
    const f = fixture({ workflowKind: "issue_validation" });
    const result = resultWithSummary(f);
    const summary = present(result.report.modelSummary);
    invalidResult(() =>
      validate(f, {
        ...result,
        report: {
          ...result.report,
          modelSummary: {
            ...summary,
            observations: [
              { ...summary.observations[0], evidenceIds: ["forged-evidence"], outcome: "passed" },
            ],
          },
        },
      }),
    );
  });

  it.each(["pr_ui", "issue_validation"] as const)(
    "keeps %s runner evidence complete when its optional summary fails without an execution blocker",
    (workflowKind) => {
      const f = fixture({ workflowKind });
      const result = workflowKind === "pr_ui" ? resultWithUiEvidence(f) : resultFor(f);
      const runnerBytes = canonicalJson({ report: result.report, execution: result.execution });
      const baseline = validateWithEvidence(f, result, () => true);
      result.modelReview = {
        state: "failed",
        code: "SUMMARY_TIMEOUT",
        message: "The optional summary timed out.",
      };
      const failed = validateWithEvidence(f, result, () => true);
      expect(baseline.evidenceComplete).toBe(true);
      expect(failed.evidenceComplete).toBe(true);
      expect(
        canonicalJson({ report: failed.result.report, execution: failed.result.execution }),
      ).toBe(runnerBytes);
      expect(failed.result.report).not.toHaveProperty("modelSummary");
      expect(failed.result.modelReview).toEqual(result.modelReview);
      if (workflowKind === "issue_validation") {
        const stored = complete(f, result).validated;
        expect(stored.evidenceComplete).toBe(true);
        expect(stored.result.modelReview).toEqual(result.modelReview);
      }
    },
  );

  it("does not let approve advice overwrite a failed runner check or modified source", () => {
    const f = fixture({ workflowKind: "pr_ui" });
    const result = resultWithSummary(f);
    if (result.report.workItemKind !== "pull_request") throw new Error("A PR report is required.");
    present(result.report.modelSummary).recommendation = "approve";
    const build = present(result.report.checks.find((check) => check.kind === "build"));
    build.outcome = "failed";
    const diagnostic = present(
      result.execution.diagnostics.find((entry) => entry.stepId === build.id),
    );
    diagnostic.outcome = "failed";
    diagnostic.exitCode = 1;
    result.report.sourceState = "modified";
    const validated = validate(f, result);
    expect(validated.result.report).toEqual(result.report);
    expect(validated.evidenceComplete).toBe(false);
  });
});

describe("nested review result validation", () => {
  it("accepts triage evidence independently of a blocked sibling reproduction request", () => {
    const f = fixture({ workflowKind: "issue_triage", blockedReproduction: true });
    expect(f.run.plan.jobs).toHaveLength(2);
    expect(complete(f).validated.result.modelReview).toEqual({
      state: "completed",
      result: issueReview(),
    });
  });
  it("stores issue reproduction against its authorized source commit with a separate model summary", () => {
    const f = fixture({ workflowKind: "issue_validation" });
    const result = resultFor(f);
    if (result.report.workItemKind !== "issue") throw new Error("An issue report is required.");
    result.report.reproductionConclusion = "confirmed";
    result.report.modelSummary = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "issue",
      summary: "The crash reproduced on the selected commit.",
      reproductionConclusion: "confirmed",
      observations: [],
    };
    expect(f.execution.validation.testedSourceRevision).toEqual({
      kind: "commit",
      headSha: "c".repeat(40),
    });
    const nested = { ...result, modelReview: { state: "completed", result: issueReview() } };
    invalidResult(() => validate(f, nested));
    expect(complete(f, result).validated.evidenceComplete).toBe(true);
  });
  it.each<[string, (review: PrReviewPlanV2) => void]>([
    [
      "duplicate finding IDs",
      (review) => {
        review.findings.push(structuredClone(present(review.findings[0])));
      },
    ],
    [
      "parent traversal",
      (review) => {
        present(review.findings[0]).path = "src/../settings.ts";
      },
    ],
    [
      "non-normalized path",
      (review) => {
        present(review.findings[0]).path = "src//settings.ts";
      },
    ],
    [
      "absolute path",
      (review) => {
        present(review.findings[0]).path = "C:/repo/settings.ts";
      },
    ],
    [
      "reversed line range",
      (review) => {
        present(review.findings[0]).endLine = 2;
      },
    ],
    [
      "invalid line number",
      (review) => {
        present(review.findings[0]).line = 0;
      },
    ],
    [
      "unapproved recipe",
      (review) => {
        review.requestedRecipeIds = ["not-allowed"];
      },
    ],
  ])("rejects %s inside the completed model review", (_name, mutate) => {
    const f = fixture();
    const result = resultFor(f);
    const review = prReview();
    mutate(review);
    result.modelReview = { state: "completed", result: review };
    invalidResult(() => validate(f, result));
  });

  it("rejects PR/issue result confusion and V1 nested output", () => {
    const f = fixture();
    const result = resultFor(f);
    invalidResult(() =>
      validate(f, { ...result, modelReview: { state: "completed", result: issueReview() } }),
    );
    const { verification: _verification, executionEvidence: _evidence, ...legacy } = prReview();
    invalidResult(() =>
      validate(f, {
        ...result,
        modelReview: { state: "completed", result: { ...legacy, schemaVersion: "PrReviewPlanV1" } },
      }),
    );
  });

  it("accepts issue triage V2 findings only in the matching frozen workflow", () => {
    const f = fixture({ workflowKind: "issue_triage" });
    const result = resultFor(f);
    expect(complete(f, result).validated.result.modelReview).toEqual({
      state: "completed",
      result: issueReview(),
    });
  });
});

describe("immutable validation result persistence", () => {
  it("cannot retrofit validation identity onto an already successful legacy job", () => {
    const f = fixture();
    const jobId = "completed-unlinked-legacy";
    insertRow(f.database, "jobs", {
      id: jobId,
      job_kind: "pull_request_review",
      semantic_key: jobId,
      concurrency_key: jobId,
      status: "succeeded",
      execution_json: "{}",
      resource_revision: "legacy-revision",
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    });
    const before = f.database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    expect(() =>
      f.database
        .prepare("UPDATE jobs SET execution_json = ?, execution_digest = ? WHERE id = ?")
        .run(f.context.executionJson, f.context.executionDigest, jobId),
    ).toThrow();
    expect(f.database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId)).toEqual(before);
  });

  it("persists a legal profile with 129 checks beyond the former 128-check storage limit", () => {
    const f = fixture({ workflowKind: "pr_ui", largeProfile: true });
    const result = resultFor(f);
    expect(result.report.checks).toHaveLength(129);
    expect(result.execution.diagnostics).toHaveLength(129);
    expect(f.execution.validation.requiredCheckIds).toHaveLength(65);
    expect(Value.Check(ValidationJobResultV1Schema, result)).toBe(true);
    const { id, validated } = complete(f, result);
    expect(validated.evidenceComplete).toBe(false);
    expect(
      f.database
        .prepare(`SELECT json_array_length(result_json, '$.report.checks') AS checks,
      json_array_length(result_json, '$.execution.diagnostics') AS diagnostics,
      evidence_complete FROM validation_job_results WHERE id = ?`)
        .get(id),
    ).toEqual({
      checks: 129,
      diagnostics: 129,
      evidence_complete: 0,
    });
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects forged validated values and reuse with a different completion context", () => {
    const f = fixture();
    const validated = validate(f);
    f.database.exec("BEGIN IMMEDIATE");
    finishAttempt(f.database, f.context, validated);
    invalidContext(() =>
      persistValidatedValidationResult(f.database, f.context, { ...validated }, later),
    );
    invalidContext(() =>
      persistValidatedValidationResult(
        f.database,
        { ...f.context, runAttemptId: "other-attempt" },
        validated,
        later,
      ),
    );
    invalidContext(() =>
      persistValidatedValidationResult(f.database, f.context, validated, "invalid-time"),
    );
    persistValidatedValidationResult(f.database, f.context, validated, later);
    f.database.exec("COMMIT");
  });

  it("rejects REPLACE of an immutable result even when recursive triggers are disabled", () => {
    const f = fixture();
    const { id } = complete(f);
    const row = f.database
      .prepare("SELECT * FROM validation_job_results WHERE id = ?")
      .get(id) as Record<string, SQLInputValue>;
    const columns = Object.keys(row);
    f.database.exec("PRAGMA recursive_triggers = OFF");
    expect(() =>
      f.database
        .prepare(
          `INSERT OR REPLACE INTO validation_job_results (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...Object.values(row)),
    ).toThrow();
    expect(f.database.prepare("SELECT * FROM validation_job_results WHERE id = ?").get(id)).toEqual(
      row,
    );
  });
  it("requires the successful attempt and exact result bytes before insertion", () => {
    const f = fixture();
    const validated = validate(f);
    expect(() =>
      persistValidatedValidationResult(f.database, f.context, validated, later),
    ).toThrow();
    f.database.exec("BEGIN IMMEDIATE");
    finishAttempt(f.database, f.context, { ...validated, canonicalResultJson: "{}" });
    expect(() =>
      persistValidatedValidationResult(f.database, f.context, validated, later),
    ).toThrow();
    f.database.exec("ROLLBACK");
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });

  it("does not allow a validation job to succeed without its immutable result", () => {
    const f = fixture();
    finishAttempt(f.database, f.context, validate(f));
    expect(() =>
      f.database.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(f.context.jobId),
    ).toThrow();
    expect(f.database.prepare("SELECT status FROM jobs WHERE id = ?").get(f.context.jobId)).toEqual(
      { status: "running" },
    );
  });

  it("rolls back the attempt and result together when its caller transaction fails", () => {
    const f = fixture();
    const validated = validate(f);
    f.database.exec("BEGIN IMMEDIATE");
    finishAttempt(f.database, f.context, validated);
    persistValidatedValidationResult(f.database, f.context, validated, later);
    f.database.exec("ROLLBACK");
    expect(
      f.database
        .prepare("SELECT status, result_json FROM run_attempts WHERE id = ?")
        .get(f.context.runAttemptId),
    ).toEqual({ status: "running", result_json: null });
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });

  it("stores exact bytes and protects the result, attempt, revision, and frozen execution identity", () => {
    const f = fixture();
    const { id, validated } = complete(f);
    expect(
      f.database
        .prepare(
          "SELECT schema_id, result_json, result_digest, job_id, run_attempt_id, revision_id FROM validation_job_results WHERE id = ?",
        )
        .get(id),
    ).toEqual({
      schema_id: "ValidationJobResultV1",
      result_json: validated.canonicalResultJson,
      result_digest: validated.resultDigest,
      job_id: f.context.jobId,
      run_attempt_id: f.context.runAttemptId,
      revision_id: f.context.revisionId,
    });
    for (const statement of [
      "UPDATE validation_job_results SET result_json = '{}'",
      "UPDATE validation_job_results SET evidence_complete = 0",
      "DELETE FROM validation_job_results",
    ])
      expect(() => f.database.exec(statement)).toThrow(/immutable/u);
    for (const [statement, idValue] of [
      ["UPDATE run_attempts SET result_json = '{}' WHERE id = ?", f.context.runAttemptId],
      ["UPDATE run_attempts SET result_digest = 'bad' WHERE id = ?", f.context.runAttemptId],
      ["UPDATE run_attempts SET status = 'failed' WHERE id = ?", f.context.runAttemptId],
      [
        "UPDATE work_item_revisions SET revision_json = '{}' WHERE id = ?",
        present(f.context.revisionId),
      ],
      ["UPDATE jobs SET execution_json = '{}' WHERE id = ?", f.context.jobId],
    ])
      expect(() => f.database.prepare(present(statement)).run(present(idValue))).toThrow(
        /immutable/u,
      );
    for (const [table, idValue] of [
      ["run_attempts", f.context.runAttemptId],
      ["work_item_revisions", present(f.context.revisionId)],
      ["jobs", f.context.jobId],
    ])
      expect(() =>
        f.database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(present(idValue)),
      ).toThrow();
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects wrong identities and cross-job result insertion even after another valid completion", () => {
    const f = fixture();
    const validated = validate(f);
    f.database.exec("BEGIN IMMEDIATE");
    finishAttempt(f.database, f.context, validated);
    const id = persistValidatedValidationResult(f.database, f.context, validated, later);
    const row = f.database
      .prepare("SELECT * FROM validation_job_results WHERE id = ?")
      .get(id) as Record<string, SQLInputValue>;
    f.database.exec("ROLLBACK");
    finishAttempt(f.database, f.context, validated);
    const legacyContext = beginAttempt(f.database, f.legacyJobId);
    finishAttempt(f.database, legacyContext, validated);
    for (const change of [
      { job_id: f.legacyJobId, run_attempt_id: legacyContext.runAttemptId },
      { revision_id: "missing-revision" },
      { review_run_id: "missing-run" },
      { request_id: "missing-request" },
      { result_digest: "0".repeat(64) },
      { result_json: "{}" },
      { execution_template_sha256: "0".repeat(64) },
    ])
      expect(() =>
        insertRow(f.database, "validation_job_results", {
          ...row,
          id: `invalid-${Object.keys(change)[0]}`,
          ...change,
        }),
      ).toThrow();
    insertRow(f.database, "validation_job_results", row);
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 1 });
  });
});

describe("validation result migration legacy compatibility", () => {
  it.each([
    { workflowKind: "pr_static_build", legacyVersion: 1 },
    { workflowKind: "pr_static_build", legacyVersion: 2 },
    { workflowKind: "issue_triage", legacyVersion: 1 },
    { workflowKind: "issue_triage", legacyVersion: 2 },
  ] as const)(
    "retains the post-migration legacy $workflowKind V$legacyVersion completion gate",
    ({ workflowKind, legacyVersion }) => {
      const f = fixture({ workflowKind, legacyVersion });
      const context = beginAttempt(f.database, f.legacyJobId);
      const review = workflowKind === "pr_static_build" ? prReview() : issueReview();
      const { verification: _verification, executionEvidence: _evidence, ...legacy } = review;
      const result =
        legacyVersion === 2
          ? review
          : {
              ...legacy,
              schemaVersion:
                workflowKind === "pr_static_build" ? "PrReviewPlanV1" : "IssueTriageV1",
            };
      const canonical = canonicalizeReviewResultSubmission(result);
      const validated = validateReviewCompletion(context, canonical.resultDigest, result);
      finishAttempt(f.database, context, validated);
      expect(() =>
        f.database.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(context.jobId),
      ).toThrow(/immutable review result/u);
      persistValidatedReviewResult(f.database, context, validated, later);
      f.database.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(context.jobId);
      expect(f.database.prepare("SELECT status FROM jobs WHERE id = ?").get(context.jobId)).toEqual(
        { status: "succeeded" },
      );
      expect(
        f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
      ).toEqual({ count: 0 });
    },
  );
  it("preserves completed V1/V2 PR and issue bytes and the legacy completion gate", () => {
    const prefix = mkdtempSync(join(tmpdir(), "agentic-review-validation-results-m14-"));
    temporaryDirectories.push(prefix);
    for (const filename of readdirSync(migrationsDirectory)) {
      const version = Number(/^([0-9]+)_.*\.sql$/u.exec(filename)?.[1]);
      if (version >= 1 && version <= 14)
        copyFileSync(join(migrationsDirectory, filename), join(prefix, filename));
    }
    for (const workflowKind of ["pr_static_build", "issue_triage"] as const) {
      for (const legacyVersion of [1, 2] as const) {
        const f = historicM14Fixture(prefix, { workflowKind, legacyVersion });
        const context = beginAttempt(f.database, f.legacyJobId, "historical_m14");
        const review = workflowKind === "pr_static_build" ? prReview() : issueReview();
        const { verification: _verification, executionEvidence: _evidence, ...legacy } = review;
        const result =
          legacyVersion === 2
            ? review
            : {
                ...legacy,
                schemaVersion:
                  workflowKind === "pr_static_build" ? "PrReviewPlanV1" : "IssueTriageV1",
              };
        const canonical = canonicalizeReviewResultSubmission(result);
        const validated = validateReviewCompletion(context, canonical.resultDigest, result);
        finishAttempt(f.database, context, validated);
        expect(() =>
          f.database
            .prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?")
            .run(context.jobId),
        ).toThrow(/immutable review result/u);
        persistValidatedReviewResult(f.database, context, validated, later);
        f.database.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(context.jobId);
        const tables = [
          "review_results",
          "pr_review_results",
          "pr_review_findings",
          "issue_triage_results",
        ] as const;
        const before = tables.map((table) => f.database.prepare(`SELECT * FROM ${table}`).all());
        expect(runMigrations(f.database, migrationsDirectory)).toBeGreaterThanOrEqual(18);
        expect(tables.map((table) => f.database.prepare(`SELECT * FROM ${table}`).all())).toEqual(
          before,
        );
        expect(
          f.database
            .prepare("SELECT result_digest, result_json FROM run_attempts WHERE id = ?")
            .get(context.runAttemptId),
        ).toEqual({
          result_digest: canonical.resultDigest,
          result_json: canonical.canonicalResultJson,
        });
        expect(
          f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
        ).toEqual({ count: 0 });
        expect(
          f.database.prepare("SELECT mode, legacy_job_id FROM github_review_run_activations").all(),
        ).toEqual([{ mode: "legacy", legacy_job_id: context.jobId }]);
        expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(() =>
          f.database
            .prepare("UPDATE run_attempts SET result_json = '{}' WHERE id = ?")
            .run(context.runAttemptId),
        ).toThrow(/immutable/u);
      }
    }
  });
});
