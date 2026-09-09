import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createCanonicalResult,
  IssueTriageV2ModelOutputSchema,
  type PrReviewFindingV1,
  PrReviewPlanV2ModelOutputSchema,
  type ValidationJobResultV1,
  ValidationJobResultV1Schema,
} from "@agentic-review/codex";
import {
  type ActiveAuthorizedRequestEpoch,
  FindingComparisonResponseSchema,
  type FindingDispositionChangeRequest,
  FindingDispositionChangeResponseSchema,
  FindingDispositionHistoryResponseSchema,
  FindingListResponseSchema,
  type ManagedRepository,
  type OperatorPrincipal,
  type OperatorRepositoryRole,
  type ReviewRunPlanInput,
  type SchedulingRequestOpenedEvent,
  type SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createValidationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  type FindingDispositionOperationMap,
  type FindingDispositionRequest,
  handleFindingDispositionRequest,
} from "./finding-dispositions.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest } from "./operator-access.js";
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
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

const now = "2026-09-07T00:00:00.000Z";
const later = "2026-09-07T00:05:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "operator-1" };
const member = { ...actor, subject: "reviewer-1" };
type FindingDispositionOperation = keyof FindingDispositionOperationMap;
const findings: PrReviewFindingV1[] = [
  {
    findingId: "finding-first",
    priority: 2,
    title: "Describe the retry state",
    body: "The retry state needs an explanation.\n".repeat(100),
    path: "src/settings.ts",
    line: 91,
    endLine: 94,
    confidence: 0.7,
  },
  {
    findingId: "finding-critical",
    priority: 0,
    title: "Guard null handles",
    body: "A missing handle must be rejected before use.",
    path: "src/settings.ts",
    line: 12,
    endLine: 14,
    confidence: 0.9,
  },
  {
    findingId: "finding-last",
    priority: 1,
    title: "Release the acquired resource",
    body: "An early return leaves the resource allocated.",
    path: "src/resource.ts",
    line: 40,
    endLine: null,
    confidence: 0.8,
  },
];
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
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The fixture is incomplete.");
  return value;
}
function insert(database: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
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
function openedEvent(kind: "pull_request" | "issue"): SchedulingRequestOpenedEvent {
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
        : { ...revisionCommon, kind, revisionKey: issueDigest, contentDigest: issueDigest },
  };
}

// This fixture uses every production migration and real frozen plan/result admission.
// No upstream calls, file evidence callbacks, or external writes are used.
function fixture(
  options: {
    issue?: boolean;
    complete?: boolean;
    associate?: boolean;
    empty?: boolean;
    noModelSummary?: boolean;
  } = {},
) {
  const kind = options.issue ? "issue" : "pull_request";
  const workflowKind = options.issue ? "issue_validation" : "pr_static_build";
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
  const outputSchema = options.issue
    ? IssueTriageV2ModelOutputSchema
    : PrReviewPlanV2ModelOutputSchema;
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
          outputSchema,
          outputSchemaSha256: sha256(canonicalJson(outputSchema)),
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
    { operation: "getManagedRepository", input: { repositoryId: ingested.repositoryId } },
    now,
  ) as ManagedRepository;
  const template = configure(database, "createPromptTemplate", {
    actor,
    request: {
      name: "Review prompt",
      workflowKind,
      content: renderedPrompt,
      outputSchemaVersion: options.issue ? "ValidationSummaryV1" : "PrReviewPlanV2",
    },
  });
  const prompt = configure(database, "publishPromptDraft", {
    templateId: template.id,
    actor,
    request: { expectedVersion: template.version },
  });
  const profile = configure(database, "publishValidationProfile", {
    repositoryId: managed.id,
    actor,
    request: {
      name: "Compile exact source",
      workflowKind,
      target: "headless",
      required: true,
      outputSchemaVersion: options.issue ? "ValidationReportV1" : "PrReviewPlanV2",
      config: {
        schemaVersion: "ValidationProfileV1",
        setup: [],
        build: [
          {
            id: "compile",
            name: "Compile",
            command: {
              executable: "node",
              args: ["--version"],
              workingDirectory: ".",
              environment: [],
            },
            required: true,
            timeoutMs: 10_000,
          },
        ],
        test: [],
        launch: [],
        cleanup: [],
        requiredCapabilities: [],
        hardTimeoutMs: 120_000,
        noProgressTimeoutMs: 30_000,
      },
    },
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
  const epoch = JSON.parse(
    (
      database
        .prepare("SELECT epoch_json FROM request_epochs WHERE id = ?")
        .get(ingested.openedRequestEpochId) as { epoch_json: string }
    ).epoch_json,
  ) as ActiveAuthorizedRequestEpoch;
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
        : { kind: "commit", headSha: "c".repeat(40) },
    testedSourceAuthorization: options.issue
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
        target: "headless",
        required: true,
        profileVersion: profile,
        prompt: { workflowKind, version: prompt },
      },
    ],
    runnerSupport: [{ workflowKind, target: "headless", capabilities: [], evidenceDelivery: true }],
  };
  const run = handleReviewRunRequest(
    database,
    { operation: "createReviewRun", input: { planInput, actor } },
    now,
  ) as ReviewRunDetail;
  const scope = {
    repositoryId: managed.id,
    reviewRunId: run.id,
    requestId: "selected",
    jobId: "validation-job-1",
    actor,
  };
  function addJob(jobId: string, activation: number, associate = true) {
    const execution = createValidationExecutionTemplate({
      runId: run.id,
      plan: run.plan,
      planDigest: run.planDigest,
      requestId: "selected",
      jobActivation: activation,
      frozenPrompt: present(
        getReviewRunPromptEnvelope(database, {
          repositoryId: managed.id,
          reviewRunId: run.id,
          requestId: "selected",
        }),
      ),
    });
    database.exec("BEGIN IMMEDIATE");
    insert(database, "jobs", {
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
    if (associate) {
      associateReviewRunJobInTransaction(
        database,
        { repositoryId: managed.id, reviewRunId: run.id, requestId: "selected", jobId, actor },
        now,
      );
    }
    database.exec("COMMIT");
  }
  addJob("validation-job-1", 1, options.associate !== false);
  insert(database, "workers", {
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
  const rawResult: unknown = {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      summary: "Configured validation completed.",
      sourceState: "original",
      checks: [
        {
          id: `${profile.id}:compile`,
          name: "Compile",
          kind: "build",
          required: true,
          outcome: "passed",
          summary: "The build passed.",
          expected: null,
          actual: null,
          evidenceIds: [],
          source: "runner",
        },
      ],
      ...(options.issue
        ? {
            workItemKind: "issue",
            reproductionConclusion: "inconclusive",
            ...(options.noModelSummary
              ? {}
              : {
                  modelSummary: {
                    schemaVersion: "ValidationSummaryV1" as const,
                    workItemKind: "issue" as const,
                    reproductionConclusion: "inconclusive" as const,
                    summary: "The observed evidence needs review.",
                    observations: options.empty
                      ? []
                      : findings.map((finding) => ({
                          id: finding.findingId,
                          priority: finding.priority,
                          title: finding.title,
                          body: finding.body,
                          path: finding.path,
                          line: finding.line,
                        })),
                  },
                }),
          }
        : { workItemKind: "pull_request" }),
    },
    execution: {
      blockers: [],
      diagnostics: [
        {
          stepId: `${profile.id}:compile`,
          phase: "build",
          outcome: "passed",
          exitCode: 0,
          summary: "The build passed.",
        },
      ],
      cleanupState: "not_needed",
    },
    modelReview: options.issue
      ? { state: "not_requested" }
      : {
          state: "completed",
          result: {
            schemaVersion: "PrReviewPlanV2",
            summary: "The exact revision was reviewed.",
            assessment: options.empty ? "approve" : "request_changes",
            findings: options.empty ? [] : findings,
            requestedRecipeIds: [],
            verification: {
              status: "not_run",
              summary: "Runner checks are recorded separately.",
              commands: [],
            },
            executionEvidence: {
              schemaVersion: "ReviewExecutionEvidenceV1",
              source: "worker",
              commandCapture: "complete",
              commands: [],
              worktree: { status: "clean", source: "git_status" },
            },
          },
        },
  };
  Value.Assert(ValidationJobResultV1Schema, rawResult);
  const result: ValidationJobResultV1 = rawResult;
  function completeJob(jobId = scope.jobId, completedResult = result) {
    const attemptId = `attempt-${jobId}`;
    const completedAt = jobId === scope.jobId ? later : "2026-09-07T00:06:00.000Z";
    database.exec("BEGIN IMMEDIATE");
    // This finite result fixture admits only its exact pending Job; all production guards remain active.
    expect(
      database
        .prepare(
          "UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ? AND state = 'pending' AND attempt_base = 0",
        )
        .run(now, jobId).changes,
    ).toBe(1);
    database
      .prepare(
        "UPDATE jobs SET status = 'leased', current_run_attempt_id = ?, attempt_count = 1, lease_generation = 1 WHERE id = ?",
      )
      .run(attemptId, jobId);
    insert(database, "run_attempts", {
      id: attemptId,
      job_id: jobId,
      attempt_number: 1,
      worker_id: "worker-1",
      worker_node_id: "node-1",
      worker_instance_id: "instance-1",
      status: "leased",
      lease_token_hash: sha256("lease-token"),
      lease_generation: 1,
      lease_expires_at: later,
      execution_deadline_at: later,
      no_progress_timeout_ms: 30_000,
      no_progress_deadline_at: later,
      last_heartbeat_at: now,
      phase: "leased",
      started_at: now,
    });
    database
      .prepare("UPDATE run_attempts SET status = 'running', phase = 'validation' WHERE id = ?")
      .run(attemptId);
    database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    database.exec("COMMIT");
    const completionContext = database
      .prepare(
        `SELECT job.id AS jobId, job.current_run_attempt_id AS runAttemptId, job.job_kind AS jobKind, job.work_item_id AS workItemId, item.resource_kind AS workItemResourceKind, job.resource_revision AS resourceRevision, revision.id AS revisionId, revision.resource_kind AS revisionResourceKind, revision.base_sha AS revisionBaseSha, revision.head_sha AS revisionHeadSha, job.execution_json AS executionJson, job.execution_digest AS executionDigest FROM jobs AS job JOIN work_items AS item ON item.id = job.work_item_id JOIN work_item_revisions AS revision ON revision.work_item_id = job.work_item_id AND revision.revision_key = job.resource_revision WHERE job.id = ?`,
      )
      .get(jobId) as unknown as ReviewCompletionJobContext;
    const validated = validateValidationCompletion(
      database,
      completionContext,
      createCanonicalResult(completedResult).sha256,
      completedResult,
    );
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(validated.resultDigest, validated.canonicalResultJson, completedAt, attemptId);
    persistValidatedValidationResult(database, completionContext, validated, completedAt);
    database
      .prepare(
        "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
      )
      .run(completedAt, jobId);
    database.exec("COMMIT");
  }
  if (options.complete !== false && options.associate !== false) completeJob();
  function call<K extends FindingDispositionOperation>(
    operation: K,
    input: FindingDispositionOperationMap[K]["input"],
    options: { now?: string; administrators?: readonly OperatorPrincipal[] } = {},
  ): FindingDispositionOperationMap[K]["output"] {
    return handleFindingDispositionRequest(
      database,
      { operation, input } as FindingDispositionRequest,
      options.now ?? later,
      options.administrators ?? [actor],
    ) as FindingDispositionOperationMap[K]["output"];
  }
  function list(overrides: Partial<typeof scope> = {}) {
    return call("listFindingOccurrences", { ...scope, ...overrides });
  }
  function input(
    action: FindingDispositionChangeRequest["action"] = "accept",
    overrides: Record<string, unknown> = {},
    ordinal = 1,
  ) {
    const current = list();
    const occurrence = present(current.items.find((item) => item.ordinal === ordinal));
    return {
      ...scope,
      occurrenceKey: occurrence.key,
      changeId: "finding-change-1",
      expectedVersion: occurrence.disposition.version,
      expectedResultDigest: current.context.resultDigest,
      expectedContextDigest: current.context.contextDigest,
      kind: occurrence.kind,
      ordinal: occurrence.ordinal,
      action,
      reason: "Review the finding against the recorded evidence.",
      ...overrides,
    } as FindingDispositionOperationMap["changeFindingDisposition"]["input"];
  }
  function history(ordinal = 1, overrides: Record<string, unknown> = {}) {
    const occurrence = present(list().items.find((item) => item.ordinal === ordinal));
    return call("getFindingDispositionHistory", {
      ...scope,
      occurrenceKey: occurrence.key,
      ...overrides,
    });
  }
  function grant(role: OperatorRepositoryRole | null, principal = member, expectedVersion = 0) {
    return handleOperatorAccessRequest(
      database,
      {
        operation: "changeRepositoryAccess",
        input: {
          actor,
          repositoryId: managed.id,
          request: {
            changeId: `access-${principal.subject}-${expectedVersion}`,
            principal,
            role,
            expectedVersion,
            reason: "Configure synthetic test access.",
          },
        },
      },
      later,
      [actor],
    );
  }
  return { database, run, scope, result, call, list, input, history, grant, addJob, completeJob };
}

const expectCode = (action: () => unknown, code: string) =>
  expect(action).toThrow(expect.objectContaining({ code }));

describe("finding occurrence persistence", () => {
  it("reads complete immutable findings in original model order with an empty disposition", () => {
    const f = fixture();
    const response = f.list();
    expect(Value.Check(FindingListResponseSchema, response)).toBe(true);
    expect(response).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 3,
      context: {
        repositoryId: f.scope.repositoryId,
        reviewRunId: f.run.id,
        requestId: "selected",
        jobId: f.scope.jobId,
        workItemId: f.run.workItemId,
        workItemKind: "pull_request",
        revisionKey: f.run.revisionKey,
        planDigest: f.run.planDigest,
        activationNumber: 1,
        sourceCurrent: true,
        latestForRequest: true,
        historical: false,
        modelAvailability: "complete",
        findingCount: 3,
      },
      summary: {
        open: 3,
        accepted: 0,
        dismissed: 0,
        resolved: 0,
        rawBlocking: 2,
        unresolvedBlocking: 2,
      },
    });
    expect(response.items.map((item) => item.ordinal)).toEqual([0, 1, 2]);
    expect(response.items.map((item) => item.priority)).toEqual([2, 0, 1]);
    for (const [ordinal, finding] of findings.entries()) {
      expect(response.items[ordinal]).toMatchObject({
        kind: "pr_finding",
        ordinal,
        resultId: response.context.resultId,
        resultDigest: response.context.resultDigest,
        modelId: finding.findingId,
        title: finding.title,
        body: finding.body,
        path: finding.path,
        line: finding.line,
        endLine: finding.endLine,
        confidence: finding.confidence,
        disposition: {
          state: "open",
          version: 0,
          lastEventId: null,
          updatedAt: null,
          updatedBy: null,
        },
      });
    }
    expect(new Set(response.items.map((item) => item.key)).size).toBe(3);
    expect(f.list()).toEqual(response);
  });

  it("paginates the immutable order without turning display positions into occurrence ordinals", () => {
    const f = fixture();
    const first = f.call("listFindingOccurrences", { ...f.scope, pageSize: 1 });
    const second = f.call("listFindingOccurrences", { ...f.scope, page: 2, pageSize: 1 });
    expect(first.items[0]?.ordinal).toBe(0);
    expect(second.items[0]?.ordinal).toBe(1);
    expect(second.items[0]?.key).toBe(f.list().items[1]?.key);
    expect(second.context).toEqual(first.context);
    expect(second.summary).toEqual(first.summary);
    expect(second.total).toBe(3);
    expect(f.call("listFindingOccurrences", { ...f.scope, page: 4, pageSize: 1 }).items).toEqual(
      [],
    );
  });

  it("keeps Issue observations in their own namespace without fabricated source metadata", () => {
    const f = fixture({ issue: true });
    const response = f.list();
    expect(Value.Check(FindingListResponseSchema, response)).toBe(true);
    expect(response.context).toMatchObject({
      workItemKind: "issue",
      modelAvailability: "complete",
      findingCount: 3,
    });
    expect(response.items.map((item) => item.kind)).toEqual([
      "validation_observation",
      "validation_observation",
      "validation_observation",
    ]);
    expect(response.items[0]).toMatchObject({
      modelId: findings[0]?.findingId,
      body: findings[0]?.body,
      ordinal: 0,
      endLine: null,
      confidence: null,
    });
    const changed = f.call("changeFindingDisposition", f.input("accept"));
    expect(changed.change).toMatchObject({
      workItemKind: "issue",
      occurrence: { kind: "validation_observation", ordinal: 1 },
    });
  });

  it.each([{ empty: true }, { issue: true, empty: true }])(
    "returns an explicit completed empty model array for %j",
    (options) => {
      const f = fixture(options);
      expect(f.list()).toMatchObject({
        total: 0,
        items: [],
        context: { modelAvailability: "complete", findingCount: 0 },
        summary: {
          open: 0,
          accepted: 0,
          dismissed: 0,
          resolved: 0,
          rawBlocking: 0,
          unresolvedBlocking: 0,
        },
      });
    },
  );

  it("does not treat an unrequested optional summary as a successful empty model review", () => {
    const f = fixture({ issue: true, noModelSummary: true });
    expect(f.list()).toMatchObject({
      total: 0,
      items: [],
      context: { modelAvailability: "not_requested" },
    });
  });

  it.each([{ complete: false }, { associate: false }])(
    "does not expose a result for an incomplete or unassociated job: %j",
    (options) => {
      const f = fixture(options);
      expectCode(() => f.list(), "PLATFORM_NOT_FOUND");
    },
  );
});

describe("finding disposition changes and receipts", () => {
  it("replays a retained receipt before any date-time format has been registered", () => {
    const f = fixture();
    const input = f.input();
    const original = f.call("changeFindingDisposition", input);
    const format = FormatRegistry.Get("date-time");
    FormatRegistry.Delete("date-time");
    try {
      expect(f.call("changeFindingDisposition", input)).toEqual({ ...original, replayed: true });
    } finally {
      if (format) FormatRegistry.Set("date-time", format);
      else FormatRegistry.Delete("date-time");
    }
  });

  it("records each state change and immutable receipt without rewriting the result", () => {
    const f = fixture();
    const immutableResults = f.database.prepare("SELECT * FROM validation_job_results").all();
    const attempts = f.database.prepare("SELECT * FROM run_attempts").all();
    const initialDigest = f.list().context.dispositionDigest;
    const actions = ["accept", "dismiss", "resolve", "reopen"] as const;
    const states = ["accepted", "dismissed", "resolved", "open"] as const;
    const receipts = [];
    for (const [index, action] of actions.entries()) {
      const request = f.input(action, { changeId: `change-${index}` });
      const response = f.call("changeFindingDisposition", request);
      expect(Value.Check(FindingDispositionChangeResponseSchema, response)).toBe(true);
      expect(response).toMatchObject({
        replayed: false,
        change: {
          repositoryId: f.scope.repositoryId,
          reviewRunId: f.run.id,
          requestId: "selected",
          jobId: f.scope.jobId,
          workItemId: f.run.workItemId,
          workItemKind: "pull_request",
          revisionKey: f.run.revisionKey,
          planDigest: f.run.planDigest,
          contextDigestAtChange: request.expectedContextDigest,
          occurrence: { key: f.list().items[1]?.key, kind: "pr_finding", ordinal: 1 },
          action,
          previousState: index === 0 ? "open" : states[index - 1],
          state: states[index],
          previousVersion: index,
          version: index + 1,
          sourceCurrentAtChange: true,
          latestForRequestAtChange: true,
          actor,
          createdAt: later,
        },
      });
      expect(f.list().items[1]?.disposition).toEqual({
        state: states[index],
        version: index + 1,
        lastEventId: response.change.id,
        updatedAt: later,
        updatedBy: actor,
      });
      receipts.push(response.change);
    }
    expect(f.history().items).toEqual(receipts.toReversed());
    expect(f.list().context.dispositionDigest).not.toBe(initialDigest);
    expect(f.database.prepare("SELECT * FROM validation_job_results").all()).toEqual(
      immutableResults,
    );
    expect(f.database.prepare("SELECT * FROM run_attempts").all()).toEqual(attempts);
  });

  it("counts raw blocking findings separately from unresolved dispositions", () => {
    const f = fixture();
    f.call("changeFindingDisposition", f.input("accept"));
    expect(f.list().summary).toEqual({
      open: 2,
      accepted: 1,
      dismissed: 0,
      resolved: 0,
      rawBlocking: 2,
      unresolvedBlocking: 2,
    });
    f.call("changeFindingDisposition", f.input("dismiss", { changeId: "dismiss-blocker" }));
    expect(f.list().summary).toMatchObject({ rawBlocking: 2, unresolvedBlocking: 1, dismissed: 1 });
    f.call("changeFindingDisposition", f.input("resolve", { changeId: "resolve-other" }, 2));
    expect(f.list().summary).toMatchObject({ rawBlocking: 2, unresolvedBlocking: 0, resolved: 1 });
    f.call("changeFindingDisposition", f.input("reopen", { changeId: "reopen-blocker" }));
    expect(f.list().summary).toMatchObject({ rawBlocking: 2, unresolvedBlocking: 1 });
  });

  it("rejects reopening an already open finding without creating an event or projection", () => {
    const f = fixture();
    const initial = f.list();
    expectCode(() => f.call("changeFindingDisposition", f.input("reopen")), "PLATFORM_CONFLICT");
    expect(f.list()).toEqual(initial);
    expect(f.history().items).toEqual([]);
    expect(f.database.prepare("SELECT * FROM finding_dispositions").all()).toEqual([]);
  });

  it.each(["accept", "dismiss", "resolve"] as const)(
    "rejects a new %s intent when the occurrence already has that state",
    (action) => {
      const f = fixture();
      f.call("changeFindingDisposition", f.input(action));
      const after = f.list();
      expectCode(
        () =>
          f.call("changeFindingDisposition", f.input(action, { changeId: "duplicate-state" }), {
            now: "2026-09-07T00:06:00.000Z",
          }),
        "PLATFORM_CONFLICT",
      );
      expect(f.list()).toEqual(after);
      expect(f.history().total).toBe(1);
    },
  );

  it("enforces compare-and-swap independently for each occurrence", () => {
    const f = fixture();
    const stale = f.input("dismiss", { changeId: "parallel" });
    f.call("changeFindingDisposition", f.input("accept"));
    expectCode(() => f.call("changeFindingDisposition", stale), "PLATFORM_CONFLICT");
    f.call("changeFindingDisposition", f.input("resolve", { changeId: "other-occurrence" }, 2));
    expect(f.list().items.map((item) => item.disposition.version)).toEqual([0, 1, 1]);
    expect(f.history(1).total).toBe(1);
    expect(f.history(2).total).toBe(1);
  });

  it("replays the original receipt after later state changes and a rerun", () => {
    const f = fixture();
    const originalInput = f.input("accept");
    const accepted = f.call("changeFindingDisposition", originalInput);
    expect(f.call("changeFindingDisposition", originalInput)).toEqual({
      ...accepted,
      replayed: true,
    });
    f.call("changeFindingDisposition", f.input("resolve", { changeId: "resolved-later" }));
    f.addJob("rerun-2", 2);
    expect(f.list().context).toMatchObject({ latestForRequest: false, historical: true });
    expect(f.call("changeFindingDisposition", originalInput)).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(f.list().items[1]?.disposition).toMatchObject({ state: "resolved", version: 2 });
    expect(f.history().total).toBe(2);
  });

  it("does not reuse a receipt for a changed intent or a different authorized actor", () => {
    const f = fixture();
    f.grant("reviewer");
    const input = f.input();
    f.call("changeFindingDisposition", input);
    for (const changed of [
      { reason: "Another explanation." },
      { action: "dismiss" },
      { expectedVersion: 1 },
      { expectedResultDigest: "f".repeat(64) },
      { expectedContextDigest: "f".repeat(64) },
      { actor: member },
    ]) {
      expectCode(
        () => f.call("changeFindingDisposition", { ...input, ...changed } as typeof input),
        "PLATFORM_CONFLICT",
      );
    }
    expect(f.history().total).toBe(1);
  });

  it.each(["expectedResultDigest", "expectedContextDigest"])(
    "rejects a stale %s without appending history",
    (field) => {
      const f = fixture();
      expectCode(
        () => f.call("changeFindingDisposition", f.input("accept", { [field]: "f".repeat(64) })),
        "PLATFORM_CONFLICT",
      );
      expect(f.history().total).toBe(0);
    },
  );

  it("requires fresh context after a rerun and permits an explicit historical disposition", () => {
    const f = fixture();
    const staleInput = f.input();
    f.addJob("rerun-2", 2);
    expectCode(() => f.call("changeFindingDisposition", staleInput), "PLATFORM_CONFLICT");
    const freshInput = f.input();
    expect(freshInput.expectedContextDigest).not.toBe(staleInput.expectedContextDigest);
    const response = f.call("changeFindingDisposition", freshInput);
    expect(response.change).toMatchObject({
      latestForRequestAtChange: false,
      sourceCurrentAtChange: true,
      occurrence: { ordinal: 1 },
    });
    f.completeJob("rerun-2");
    const rerun = f.list({ jobId: "rerun-2" });
    expect(rerun.context).toMatchObject({
      activationNumber: 2,
      latestForRequest: true,
      historical: false,
    });
    expect(rerun.items.map((item) => item.disposition.state)).toEqual(["open", "open", "open"]);
    expect(rerun.items[1]?.key).not.toBe(f.list().items[1]?.key);
    expect(f.list().items[1]?.disposition.state).toBe("accepted");
  });

  it("requires refreshed context when the current source differs from the retained result", () => {
    const f = fixture();
    const staleInput = f.input();
    f.database
      .prepare("UPDATE work_items SET current_revision_key = ?, updated_at = ? WHERE id = ?")
      .run("f".repeat(64), later, f.run.workItemId);
    expect(f.list().context).toMatchObject({
      sourceCurrent: false,
      latestForRequest: true,
      historical: true,
    });
    expectCode(() => f.call("changeFindingDisposition", staleInput), "PLATFORM_CONFLICT");
    const currentInput = f.input();
    const changed = f.call("changeFindingDisposition", currentInput);
    expect(changed.change).toMatchObject({
      revisionKey: f.run.revisionKey,
      sourceCurrentAtChange: false,
      latestForRequestAtChange: true,
      contextDigestAtChange: currentInput.expectedContextDigest,
    });
  });

  it("returns paged immutable history for the selected occurrence only", () => {
    const f = fixture();
    const first = f.call("changeFindingDisposition", f.input("accept")).change;
    const second = f.call(
      "changeFindingDisposition",
      f.input("dismiss", { changeId: "second" }),
    ).change;
    const third = f.call(
      "changeFindingDisposition",
      f.input("reopen", { changeId: "third" }),
    ).change;
    f.call("changeFindingDisposition", f.input("resolve", { changeId: "unrelated" }, 2));
    const history = f.history(1, { pageSize: 2 });
    expect(Value.Check(FindingDispositionHistoryResponseSchema, history)).toBe(true);
    expect(history).toMatchObject({
      repositoryId: f.scope.repositoryId,
      reviewRunId: f.run.id,
      requestId: "selected",
      jobId: f.scope.jobId,
      total: 3,
      page: 1,
      pageSize: 2,
    });
    expect(history.items).toEqual([third, second]);
    expect(f.history(1, { page: 2, pageSize: 2 }).items).toEqual([first]);
    expect(f.history(1, { page: 3, pageSize: 2 }).items).toEqual([]);
  });

  it("preserves multiline reasons while rejecting an older mutation timestamp", () => {
    const f = fixture();
    const reason = "The evidence is consistent.\n\nThe recorded source contains the missing guard.";
    const changed = f.call("changeFindingDisposition", f.input("accept", { reason }));
    expect(changed.change.reason).toBe(reason);
    expectCode(
      () =>
        f.call("changeFindingDisposition", f.input("resolve", { changeId: "too-old" }), { now }),
      "PLATFORM_CONFLICT",
    );
    expect(f.history().total).toBe(1);
  });

  it("participates in an outer transaction and rolls back audit and projection together", () => {
    const f = fixture();
    const input = f.input();
    const before = f.list();
    f.database.exec("BEGIN IMMEDIATE");
    f.call("changeFindingDisposition", input);
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
    expect(f.list()).toEqual(before);
    expect(f.history().total).toBe(0);
    expect(f.database.prepare("SELECT * FROM finding_dispositions").all()).toEqual([]);
  });
});

describe("finding disposition authorization and scope", () => {
  it("uses current permissions for listing, history, changes, and accepted retries", () => {
    const f = fixture();
    f.grant("viewer");
    expect(f.list({ actor: member }).total).toBe(3);
    expect(f.history(1, { actor: member }).total).toBe(0);
    expectCode(
      () => f.call("changeFindingDisposition", f.input("accept", { actor: member })),
      "PLATFORM_FORBIDDEN",
    );
    f.grant("reviewer", member, 1);
    const input = f.input("accept", { actor: member });
    const receipt = f.call("changeFindingDisposition", input);
    expect(receipt.change.actor).toEqual(member);
    f.grant(null, member, 2);
    expectCode(() => f.list({ actor: member }), "PLATFORM_NOT_FOUND");
    expectCode(() => f.history(1, { actor: member }), "PLATFORM_NOT_FOUND");
    expectCode(() => f.call("changeFindingDisposition", input), "PLATFORM_NOT_FOUND");
    expectCode(
      () => f.list({ actor: { ...member, issuer: member.issuer.toUpperCase() } }),
      "PLATFORM_NOT_FOUND",
    );
    expect(f.history().total).toBe(1);
  });

  it("denies a downgraded reviewer the replay of an accepted write while retaining read access", () => {
    const f = fixture();
    f.grant("reviewer");
    const input = f.input("accept", { actor: member });
    f.call("changeFindingDisposition", input);
    f.grant("viewer", member, 1);
    expect(f.history(1, { actor: member }).total).toBe(1);
    expectCode(() => f.call("changeFindingDisposition", input), "PLATFORM_FORBIDDEN");
  });

  it("treats the administrator snapshot as current authority instead of inferring it from history", () => {
    const f = fixture();
    const input = f.input();
    f.call("changeFindingDisposition", input);
    expectCode(
      () => f.call("listFindingOccurrences", f.scope, { administrators: [] }),
      "PLATFORM_NOT_FOUND",
    );
    expectCode(
      () => f.call("changeFindingDisposition", input, { administrators: [] }),
      "PLATFORM_NOT_FOUND",
    );
    expect(f.history().total).toBe(1);
  });

  it.each(["repositoryId", "reviewRunId", "requestId", "jobId"] as const)(
    "rejects a wrong %s before returning findings or history",
    (field) => {
      const f = fixture();
      insert(f.database, "managed_repositories", {
        id: "other-repo",
        github_repository_id: 2,
        full_name: "example/other",
        enabled: 0,
        version: 1,
        connection_status: "unknown",
        configuration_source: "discovered",
        created_at: now,
        updated_at: now,
      });
      const wrongScope = { [field]: field === "repositoryId" ? "other-repo" : "absent" };
      expectCode(
        () => f.call("listFindingOccurrences", { ...f.scope, ...wrongScope }),
        "PLATFORM_NOT_FOUND",
      );
      expectCode(() => f.history(1, wrongScope), "PLATFORM_NOT_FOUND");
      expectCode(
        () => f.call("changeFindingDisposition", f.input("accept", wrongScope)),
        "PLATFORM_NOT_FOUND",
      );
      expect(f.history().total).toBe(0);
    },
  );

  it("rejects an unknown occurrence key and contradictory identity fields", () => {
    const f = fixture();
    const unknown = { occurrenceKey: "f".repeat(64) };
    expectCode(() => f.history(1, unknown), "PLATFORM_NOT_FOUND");
    expectCode(
      () => f.call("changeFindingDisposition", f.input("accept", unknown)),
      "PLATFORM_NOT_FOUND",
    );
    expectCode(
      () => f.call("changeFindingDisposition", f.input("accept", { ordinal: 2 })),
      "PLATFORM_INVALID",
    );
    expectCode(
      () =>
        f.call("changeFindingDisposition", f.input("accept", { kind: "validation_observation" })),
      "PLATFORM_INVALID",
    );
    expect(f.history().total).toBe(0);
  });

  it.each([
    { page: 0 },
    { pageSize: 0 },
    { pageSize: 21 },
    { page: Number.MAX_SAFE_INTEGER },
    { page: 1.5 },
  ])("rejects invalid pagination for listings and history: %j", (pagination) => {
    const f = fixture();
    expectCode(
      () => f.call("listFindingOccurrences", { ...f.scope, ...pagination }),
      "PLATFORM_INVALID",
    );
    expectCode(() => f.history(1, pagination), "PLATFORM_INVALID");
  });

  it.each([
    { reason: " " },
    { reason: "Contains\u0000control" },
    { reason: "x".repeat(2049) },
    { createdAt: now },
    { state: "resolved" },
    { expectedVersion: -1 },
    { ordinal: 100 },
  ])("rejects invalid mutation properties without modifying state: %j", (properties) => {
    const f = fixture();
    expectCode(
      () => f.call("changeFindingDisposition", f.input("accept", properties)),
      "PLATFORM_INVALID",
    );
    expect(f.history().total).toBe(0);
  });
});

describe("finding persistence across result activations", () => {
  it("compares real retained results without carrying dispositions to a new activation", () => {
    const f = fixture();
    f.call("changeFindingDisposition", f.input("resolve"));
    f.addJob("rerun-2", 2);
    const nextResult = structuredClone(f.result);
    if (
      nextResult.modelReview.state !== "completed" ||
      nextResult.modelReview.result.schemaVersion !== "PrReviewPlanV2"
    ) {
      throw new Error("The fixture must contain a PR model result.");
    }
    nextResult.modelReview.result.findings = [
      { ...present(findings[1]), findingId: "new-model-id", line: 50, endLine: 52, priority: 1 },
      {
        ...present(findings[2]),
        findingId: "brand-new",
        title: "Close the settings window",
        body: "Closing the window must release its focus trap.",
      },
    ];
    f.completeJob("rerun-2", nextResult);
    const comparison = f.call("compareFindingResults", {
      ...f.scope,
      jobId: "rerun-2",
      beforeReviewRunId: f.run.id,
      beforeRequestId: "selected",
      beforeJobId: f.scope.jobId,
    });
    expect(Value.Check(FindingComparisonResponseSchema, comparison)).toBe(true);
    expect(comparison).toMatchObject({
      algorithmVersion: "exact-content-v1",
      compatible: true,
      reasons: [],
      total: 4,
    });
    expect(comparison.items.filter((item) => item.status === "persistent")).toHaveLength(1);
    expect(comparison.items.filter((item) => item.status === "new")).toHaveLength(1);
    expect(comparison.items.filter((item) => item.status === "not_observed_again")).toHaveLength(2);
    expect(comparison.items.find((item) => item.status === "persistent")).toMatchObject({
      before: { ordinal: 1, kind: "pr_finding" },
      after: { ordinal: 0, kind: "pr_finding" },
      reason: null,
    });
    expect(
      f
        .list({ jobId: "rerun-2" })
        .items.every((item) => item.disposition.state === "open" && item.disposition.version === 0),
    ).toBe(true);
    expect(f.list().items[1]?.disposition.state).toBe("resolved");
  });

  it("does not disclose a mismatched comparison baseline", () => {
    const f = fixture();
    f.addJob("rerun-2", 2);
    f.completeJob("rerun-2");
    for (const field of ["beforeReviewRunId", "beforeRequestId", "beforeJobId"] as const) {
      expectCode(
        () =>
          f.call("compareFindingResults", {
            ...f.scope,
            jobId: "rerun-2",
            beforeReviewRunId: f.run.id,
            beforeRequestId: "selected",
            beforeJobId: f.scope.jobId,
            [field]: "absent",
          }),
        "PLATFORM_NOT_FOUND",
      );
    }
  });

  it("does not mutate the retained run, result, audit, or projection during comparison", () => {
    const f = fixture();
    f.call("changeFindingDisposition", f.input());
    f.addJob("rerun-2", 2);
    f.completeJob("rerun-2");
    const tables = [
      "review_runs",
      "validation_job_results",
      "finding_disposition_events",
      "finding_dispositions",
    ];
    const before = tables.map((table) => f.database.prepare(`SELECT * FROM ${table}`).all());
    f.call("compareFindingResults", {
      ...f.scope,
      jobId: "rerun-2",
      beforeReviewRunId: f.run.id,
      beforeRequestId: "selected",
      beforeJobId: f.scope.jobId,
    });
    expect(tables.map((table) => f.database.prepare(`SELECT * FROM ${table}`).all())).toEqual(
      before,
    );
  });
});

describe("finding immutable audit and atomic projection", () => {
  it("reapplies the migration runner without changing retained finding events", () => {
    const f = fixture();
    f.call("changeFindingDisposition", f.input());
    const audit = f.database.prepare("SELECT * FROM finding_disposition_events").all();
    const projection = f.database.prepare("SELECT * FROM finding_dispositions").all();
    runMigrations(f.database, migrationsDirectory);
    expect(
      f.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    ).toMatchObject({ version: 31 });
    expect(f.database.prepare("SELECT * FROM finding_disposition_events").all()).toEqual(audit);
    expect(f.database.prepare("SELECT * FROM finding_dispositions").all()).toEqual(projection);
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    "UPDATE finding_disposition_events SET reason = 'Replace the recorded explanation'",
    "DELETE FROM finding_disposition_events",
    "INSERT OR REPLACE INTO finding_disposition_events SELECT * FROM finding_disposition_events",
    "UPDATE finding_dispositions SET state = 'resolved'",
    "UPDATE finding_dispositions SET version = version + 1",
    "DELETE FROM finding_dispositions",
    "INSERT OR REPLACE INTO finding_dispositions SELECT * FROM finding_dispositions",
  ])("rejects direct immutable mutation: %s", (sql) => {
    const f = fixture();
    f.call("changeFindingDisposition", f.input());
    const before = f.list();
    const history = f.history();
    expect(() => f.database.exec(sql)).toThrow();
    expect(f.list()).toEqual(before);
    expect(f.history()).toEqual(history);
  });
});
