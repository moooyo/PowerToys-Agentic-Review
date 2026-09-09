import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createCanonicalResult,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
  ValidationJobResultV1Schema,
} from "@agentic-review/codex";
import {
  type ActiveAuthorizedRequestEpoch,
  type FindingDispositionAction,
  type ManagedRepository,
  type OperatorPrincipal,
  type OperatorRepositoryRole,
  type ReviewRunDecisionChangeRequest,
  ReviewRunDecisionChangeResponseSchema,
  ReviewRunDecisionContextSchema,
  ReviewRunDecisionHistoryResponseSchema,
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
  handleReviewRunDecisionRequest,
  isReviewRunDecisionOperation,
  type ReviewRunDecisionOperation,
  type ReviewRunDecisionOperationMap,
  type ReviewRunDecisionRequest,
  readReviewRunDecisionReplay,
} from "./review-run-decisions.js";
import type { VerifiedReviewRunEvidenceFacts } from "./review-run-queries.js";
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
const secondMember = { ...actor, subject: "reviewer-2" };
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
// Prepared evidence callbacks model the coordinator's authority; they do not verify files.
function fixture(
  options: { issue?: boolean; complete?: boolean; associate?: boolean; blocking?: boolean } = {},
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
  const scope = { repositoryId: managed.id, reviewRunId: run.id, actor };
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
  const result = {
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
        ? { workItemKind: "issue", reproductionConclusion: "inconclusive" }
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
            assessment: options.blocking ? "request_changes" : "approve",
            findings: options.blocking
              ? [
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
                ]
              : [],
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
  Value.Assert(ValidationJobResultV1Schema, result);
  function completeJob(jobId = "validation-job-1", attemptId = "attempt-1") {
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
      createCanonicalResult(result).sha256,
      result,
    );
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(validated.resultDigest, validated.canonicalResultJson, later, attemptId);
    persistValidatedValidationResult(database, completionContext, validated, later);
    database
      .prepare(
        "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
      )
      .run(later, jobId);
    database.exec("COMMIT");
  }
  if (options.complete !== false && options.associate !== false) completeJob();
  const facts: VerifiedReviewRunEvidenceFacts = {
    profiles: [{ requestId: "selected", jobId: "validation-job-1", status: "verified" }],
    assertCurrent: vi.fn(() => {
      expect(database.isTransaction).toBe(true);
    }),
    admittedEvidenceReferences: () => true,
    admittedScenarioEvidence: () => true,
  };
  function call<K extends ReviewRunDecisionOperation>(
    operation: K,
    input: ReviewRunDecisionOperationMap[K]["input"],
    options: {
      facts?: VerifiedReviewRunEvidenceFacts | null;
      now?: string;
      administrators?: readonly OperatorPrincipal[];
    } = {},
  ): ReviewRunDecisionOperationMap[K]["output"] {
    return handleReviewRunDecisionRequest(
      database,
      { operation, input } as ReviewRunDecisionRequest,
      options.now ?? later,
      options.administrators ?? [actor],
      options.facts === null ? undefined : (options.facts ?? facts),
    ) as ReviewRunDecisionOperationMap[K]["output"];
  }
  function context(options: Parameters<typeof call>[2] = {}, principal = actor) {
    return call("getReviewRunDecisionContext", { ...scope, actor: principal }, options);
  }
  function input(
    action: ReviewRunDecisionChangeRequest["action"] = "approve",
    overrides: Record<string, unknown> = {},
  ) {
    const current = context();
    return {
      ...scope,
      changeId: "decision-1",
      expectedVersion: current.version,
      expectedRevisionKey: current.revisionKey,
      expectedPlanDigest: current.planDigest,
      expectedResultSetDigest: current.resultSetDigest,
      action,
      reason: "Review the validated revision.",
      ...overrides,
    } as ReviewRunDecisionOperationMap["changeReviewRunDecision"]["input"];
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
  function findings(jobId = "validation-job-1") {
    return handleFindingDispositionRequest(
      database,
      {
        operation: "listFindingOccurrences",
        input: { ...scope, requestId: "selected", jobId },
      },
      later,
      [actor],
    ) as FindingDispositionOperationMap["listFindingOccurrences"]["output"];
  }
  function dispose(action: FindingDispositionAction, jobId = "validation-job-1") {
    const current = findings(jobId);
    const occurrence = present(current.items[0]);
    return handleFindingDispositionRequest(
      database,
      {
        operation: "changeFindingDisposition",
        input: {
          ...scope,
          requestId: "selected",
          jobId,
          occurrenceKey: occurrence.key,
          changeId: `${jobId}-${action}-${occurrence.disposition.version}`,
          expectedVersion: occurrence.disposition.version,
          expectedResultDigest: current.context.resultDigest,
          expectedContextDigest: current.context.contextDigest,
          kind: occurrence.kind,
          ordinal: occurrence.ordinal,
          action,
          reason: "Review the finding against the immutable validation result.",
        },
      },
      later,
      [actor],
    ) as FindingDispositionOperationMap["changeFindingDisposition"]["output"];
  }
  return {
    database,
    run,
    scope,
    facts,
    call,
    context,
    input,
    grant,
    addJob,
    completeJob,
    findings,
    dispose,
  };
}

const expectCode = (action: () => unknown, code: string) =>
  expect(action).toThrow(expect.objectContaining({ code }));

describe("review run decision persistence", () => {
  it("migrates an empty database and returns an empty scoped context and history", () => {
    const f = fixture();
    const context = f.context();
    expect(Value.Check(ReviewRunDecisionContextSchema, context)).toBe(true);
    expect(context).toMatchObject({
      version: 0,
      recordedDecision: null,
      recordedDecisionState: "none",
      stateReasons: [],
      sourceCurrent: true,
      canApprove: true,
    });
    const history = f.call("listReviewRunDecisionHistory", f.scope);
    expect(Value.Check(ReviewRunDecisionHistoryResponseSchema, history)).toBe(true);
    expect(history).toMatchObject({ page: 1, pageSize: 20, total: 0, items: [] });
  });
  it("records a policy-bound approval without changing the immutable runner result", () => {
    const f = fixture();
    const before = f.database.prepare("SELECT * FROM validation_job_results").all();
    const response = f.call("changeReviewRunDecision", f.input());
    expect(Value.Check(ReviewRunDecisionChangeResponseSchema, response)).toBe(true);
    expect(response).toMatchObject({
      replayed: false,
      change: {
        action: "approve",
        version: 1,
        previousVersion: 0,
        actor,
        targetDecisionId: null,
        supersedesDecisionId: null,
        createdAt: later,
        policyAtDecision: { eligible: true, reasonCount: 0, reasonCodes: [] },
      },
    });
    expect(f.context()).toMatchObject({
      version: 1,
      recordedDecision: response.change,
      recordedDecisionState: "current",
      canApprove: true,
    });
    expect(f.database.prepare("SELECT * FROM validation_job_results").all()).toEqual(before);
    const stored = f.database
      .prepare("SELECT snapshot_json, policy_json, policy_digest FROM review_run_decision_events")
      .get() as { snapshot_json: string; policy_json: string; policy_digest: string };
    expect(sha256(stored.snapshot_json)).toBe(response.change.resultSetDigest);
    expect(sha256(stored.policy_json)).toBe(stored.policy_digest);
    expect(response.change).not.toHaveProperty("snapshot_json");
  });
  it("keeps comments separate while sharing the stream version and history ordering", () => {
    const f = fixture();
    const approval = f.call("changeReviewRunDecision", f.input()).change;
    const comment = f.call(
      "changeReviewRunDecision",
      f.input("comment", { changeId: "comment-1" }),
    ).change;
    expect(comment).toMatchObject({ version: 2, previousVersion: 1, supersedesDecisionId: null });
    expect(f.context()).toMatchObject({ version: 2, recordedDecision: approval });
    const replacement = f.call(
      "changeReviewRunDecision",
      f.input("request_changes", { changeId: "changes-1" }),
    ).change;
    expect(replacement.supersedesDecisionId).toBe(approval.id);
    const history = f.call("listReviewRunDecisionHistory", { ...f.scope, pageSize: 2 });
    expect(history.total).toBe(3);
    expect(history.items.map((event) => event.id)).toEqual([replacement.id, comment.id]);
    expect(
      f.call("listReviewRunDecisionHistory", { ...f.scope, page: 2, pageSize: 2 }).items,
    ).toEqual([approval]);
    expect(
      f.call("listReviewRunDecisionHistory", { ...f.scope, page: 3, pageSize: 2 }).items,
    ).toEqual([]);
  });
  it("withdraws only the active decision, leaves a tombstone, and never revives older approval", () => {
    const f = fixture();
    const approval = f.call("changeReviewRunDecision", f.input()).change;
    const changes = f.call(
      "changeReviewRunDecision",
      f.input("request_changes", { changeId: "changes-1" }),
    ).change;
    expectCode(
      () =>
        f.call(
          "changeReviewRunDecision",
          f.input("withdraw", { changeId: "withdraw-old", targetDecisionId: approval.id }),
        ),
      "PLATFORM_CONFLICT",
    );
    const withdrawal = f.call(
      "changeReviewRunDecision",
      f.input("withdraw", { changeId: "withdraw-1", targetDecisionId: changes.id }),
    ).change;
    expect(withdrawal).toMatchObject({
      targetDecisionId: changes.id,
      supersedesDecisionId: changes.id,
    });
    expect(f.context()).toMatchObject({
      recordedDecision: withdrawal,
      recordedDecisionState: "withdrawn",
      stateReasons: [],
    });
    f.call("changeReviewRunDecision", f.input("comment", { changeId: "after-withdraw-comment" }));
    expect(f.context().recordedDecision).toEqual(withdrawal);
    const fresh = f.call(
      "changeReviewRunDecision",
      f.input("approve", { changeId: "fresh-approval" }),
    ).change;
    expect(fresh.supersedesDecisionId).toBeNull();
  });
  it("normalizes outer whitespace and preserves multiline reasons in exact immutable retries", () => {
    const f = fixture();
    const request = f.input("comment", {
      reason: "  First paragraph.\n\nSecond\tparagraph.\r\n  ",
    });
    const result = f.call("changeReviewRunDecision", request);
    expect(result.change.reason).toBe("First paragraph.\n\nSecond\tparagraph.");
    expect(f.call("changeReviewRunDecision", request)).toEqual({ ...result, replayed: true });
    expect(f.call("listReviewRunDecisionHistory", f.scope).items[0]?.reason).toBe(
      result.change.reason,
    );
  });
  it.each([
    "",
    "   ",
    "\u0000",
    "Text\u0001",
    "Text\u000b",
    "Text\u000c",
    "Text\u007f",
    "Text\u0085",
    "Text\ud800",
    "x".repeat(2049),
  ])("rejects an invalid reason %j without writing", (reason) => {
    const f = fixture();
    expectCode(
      () => f.call("changeReviewRunDecision", f.input("comment", { reason })),
      "PLATFORM_INVALID",
    );
    expect(f.context().version).toBe(0);
  });
  it.each(["expectedRevisionKey", "expectedPlanDigest", "expectedResultSetDigest"])(
    "checks the exact %s on new comments as well as decisions",
    (field) => {
      const f = fixture();
      expectCode(
        () => f.call("changeReviewRunDecision", f.input("comment", { [field]: "f".repeat(64) })),
        "PLATFORM_CONFLICT",
      );
      expect(f.context().version).toBe(0);
    },
  );
  it("enforces compare-and-swap and rejects the reuse of an identifier for a changed intent", () => {
    const f = fixture();
    const input = f.input();
    f.call("changeReviewRunDecision", input);
    f.grant("reviewer");
    expectCode(
      () => f.call("changeReviewRunDecision", { ...input, changeId: "parallel-approval" }),
      "PLATFORM_CONFLICT",
    );
    for (const changed of [
      { reason: "Different explanation." },
      { action: "comment" },
      { expectedVersion: 1 },
      { expectedResultSetDigest: "f".repeat(64) },
      { actor: member },
    ]) {
      expectCode(
        () => f.call("changeReviewRunDecision", { ...input, ...changed } as typeof input),
        "PLATFORM_CONFLICT",
      );
    }
    expect(f.context().version).toBe(1);
  });
  it("returns historical approval receipts after rerun without requiring evidence or current bindings", () => {
    const f = fixture();
    const input = f.input();
    const accepted = f.call("changeReviewRunDecision", input);
    f.addJob("rerun-2", 2);
    expect(f.context()).toMatchObject({
      recordedDecisionState: "stale",
      stateReasons: ["result_set_changed", "approval_policy_not_satisfied"],
      canApprove: false,
    });
    const facts = {
      ...f.facts,
      assertCurrent: vi.fn(() => {
        throw new Error("Evidence preparation must be bypassed.");
      }),
    };
    expect(f.call("changeReviewRunDecision", input, { facts })).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(readReviewRunDecisionReplay(f.database, input, [actor])).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(facts.assertCurrent).not.toHaveBeenCalled();
  });
  it("replays a withdrawal by original target authority after a newer decision exists", () => {
    const f = fixture();
    f.grant("reviewer");
    const approval = f.call(
      "changeReviewRunDecision",
      f.input("approve", { actor: member }),
    ).change;
    const input = f.input("withdraw", {
      actor: member,
      changeId: "withdraw-1",
      targetDecisionId: approval.id,
    });
    const response = f.call("changeReviewRunDecision", input);
    f.call("changeReviewRunDecision", f.input("request_changes", { changeId: "new-decision" }));
    expect(f.call("changeReviewRunDecision", input, { facts: null })).toEqual({
      ...response,
      replayed: true,
    });
    f.grant(null, member, 1);
    expectCode(() => readReviewRunDecisionReplay(f.database, input, [actor]), "PLATFORM_NOT_FOUND");
  });
  it.each(["approve", "override_approve"] as const)(
    "rejects %s for Issues while allowing comments, requested changes and withdrawal",
    (action) => {
      const f = fixture({ issue: true });
      expect(f.context()).toMatchObject({
        workItemKind: "issue",
        canApprove: false,
        policy: { applicable: false, eligible: null },
      });
      expectCode(() => f.call("changeReviewRunDecision", f.input(action)), "PLATFORM_INVALID");
      f.call("changeReviewRunDecision", f.input("comment"));
      const change = f.call(
        "changeReviewRunDecision",
        f.input("request_changes", { changeId: "changes" }),
      ).change;
      f.call(
        "changeReviewRunDecision",
        f.input("withdraw", { changeId: "withdraw", targetDecisionId: change.id }),
      );
      expect(f.context().recordedDecisionState).toBe("withdrawn");
    },
  );
  it.each([{ complete: false }, { associate: false }])(
    "never approves missing results or undispatched requests: %j",
    (options) => {
      const f = fixture(options);
      expect(f.context().canApprove).toBe(false);
      expectCode(() => f.call("changeReviewRunDecision", f.input()), "PLATFORM_CONFLICT");
      expect(f.context().version).toBe(0);
    },
  );
  it.each(["pending", "unavailable"] as const)("never approves %s prepared evidence", (status) => {
    const f = fixture();
    const facts: VerifiedReviewRunEvidenceFacts = {
      ...f.facts,
      profiles: [{ requestId: "selected", jobId: "validation-job-1", status }],
    };
    expect(f.context({ facts }).canApprove).toBe(false);
    expectCode(() => f.call("changeReviewRunDecision", f.input(), { facts }), "PLATFORM_CONFLICT");
    expect(f.context().version).toBe(0);
  });
  it("does not approve with absent or expired prepared authority", () => {
    const f = fixture();
    expectCode(
      () => f.call("changeReviewRunDecision", f.input(), { facts: null }),
      "PLATFORM_CONFLICT",
    );
    const input = f.input();
    const facts = {
      ...f.facts,
      assertCurrent: () => {
        throw new Error("The prepared proof expired.");
      },
    };
    expect(() => f.call("changeReviewRunDecision", input, { facts })).toThrow(
      "The prepared proof expired.",
    );
    expect(f.context().version).toBe(0);
  });
  it("keeps approval ineligible while preserving its original accepted receipt", () => {
    const f = fixture();
    const receipt = f.call("changeReviewRunDecision", f.input());
    const state = f.context({ facts: null });
    expect(state).toMatchObject({
      recordedDecision: receipt.change,
      recordedDecisionState: "ineligible",
      stateReasons: ["approval_policy_not_satisfied"],
      canApprove: false,
    });
    expect(receipt.change.policyAtDecision.eligible).toBe(true);
  });
  it.each(["resolve", "dismiss"] as const)(
    "allows approval after %s while retaining the original blocking finding",
    (action) => {
      const f = fixture({ blocking: true });
      const originalResults = f.database.prepare("SELECT * FROM validation_job_results").all();
      const before = f.context();
      expect(before).toMatchObject({
        canApprove: false,
        policy: {
          policyVersion: "required-checks-and-unresolved-p0-p1-v2",
          eligible: false,
          blockingFindingCount: 1,
          unresolvedBlockingFindingCount: 1,
        },
      });
      f.dispose(action);
      const current = f.context();
      expect(current).toMatchObject({
        canApprove: true,
        policy: {
          eligible: true,
          blockingFindingCount: 1,
          unresolvedBlockingFindingCount: 0,
        },
      });
      expect(current.resultSetDigest).not.toBe(before.resultSetDigest);
      const accepted = f.call("changeReviewRunDecision", f.input()).change;
      expect(accepted.policyAtDecision).toMatchObject({
        policyVersion: "required-checks-and-unresolved-p0-p1-v2",
        eligible: true,
        blockingFindingCount: 1,
        unresolvedBlockingFindingCount: 0,
      });
      const stored = f.database
        .prepare("SELECT snapshot_json, policy_json FROM review_run_decision_events WHERE id = ?")
        .get(accepted.id) as { snapshot_json: string; policy_json: string };
      const snapshot = JSON.parse(stored.snapshot_json);
      expect(snapshot).toMatchObject({ schemaVersion: "ReviewRunDecisionSnapshotV2" });
      expect(snapshot.findingDispositionDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.parse(stored.policy_json).findingDispositionDigest).toBe(
        snapshot.findingDispositionDigest,
      );
      expect(accepted.policyAtDecision).toHaveProperty(
        "findingDispositionDigest",
        snapshot.findingDispositionDigest,
      );
      expect(f.context().recordedDecisionState).toBe("current");
      expect(f.database.prepare("SELECT * FROM validation_job_results").all()).toEqual(
        originalResults,
      );
    },
  );
  it("keeps an accepted blocking finding ineligible for ordinary approval", () => {
    const f = fixture({ blocking: true });
    const before = f.context();
    f.dispose("accept");
    const accepted = f.context();
    expect(accepted).toMatchObject({
      canApprove: false,
      policy: { eligible: false, blockingFindingCount: 1, unresolvedBlockingFindingCount: 1 },
    });
    expect(accepted.resultSetDigest).not.toBe(before.resultSetDigest);
    expect(f.findings().items[0]?.disposition).toMatchObject({ state: "accepted", version: 1 });
    expectCode(() => f.call("changeReviewRunDecision", f.input()), "PLATFORM_CONFLICT");
    expect(f.context().version).toBe(0);
  });
  it("never revives an approval when a disposition changes away and returns to its previous state", () => {
    const f = fixture({ blocking: true });
    f.dispose("resolve");
    const request = f.input();
    const accepted = f.call("changeReviewRunDecision", request);
    const originalDigest = f.context().resultSetDigest;
    f.dispose("reopen");
    expect(f.context()).toMatchObject({
      recordedDecisionState: "stale",
      stateReasons: ["result_set_changed", "approval_policy_not_satisfied"],
      canApprove: false,
    });
    f.dispose("resolve");
    const current = f.context();
    expect(current).toMatchObject({
      recordedDecision: accepted.change,
      recordedDecisionState: "stale",
      stateReasons: ["result_set_changed"],
      canApprove: true,
    });
    expect(f.findings().items[0]?.disposition).toMatchObject({ state: "resolved", version: 3 });
    expect(current.resultSetDigest).not.toBe(originalDigest);
    expect(f.call("changeReviewRunDecision", request, { facts: null })).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(f.context().recordedDecisionState).toBe("stale");
  });
  it("rejects a preflight result-set digest after a finding disposition changes", () => {
    const f = fixture({ blocking: true });
    f.dispose("resolve");
    const request = f.input();
    // Both dispositions allow approval; the rejection must be an exact basis conflict.
    f.dispose("dismiss");
    const current = f.context();
    expect(current).toMatchObject({ canApprove: true, version: request.expectedVersion });
    expect(current.revisionKey).toBe(request.expectedRevisionKey);
    expect(current.planDigest).toBe(request.expectedPlanDigest);
    expect(current.resultSetDigest).not.toBe(request.expectedResultSetDigest);
    expectCode(() => f.call("changeReviewRunDecision", request), "PLATFORM_CONFLICT");
    expect(f.call("listReviewRunDecisionHistory", f.scope).total).toBe(0);
    expect(f.call("changeReviewRunDecision", f.input()).change.action).toBe("approve");
  });
  it("does not invalidate the current approval when an old rerun occurrence is edited", () => {
    const f = fixture({ blocking: true });
    f.dispose("resolve");
    f.addJob("validation-job-2", 2);
    f.completeJob("validation-job-2", "attempt-2");
    f.dispose("dismiss", "validation-job-2");
    const facts: VerifiedReviewRunEvidenceFacts = {
      ...f.facts,
      profiles: [{ requestId: "selected", jobId: "validation-job-2", status: "verified" }],
    };
    const accepted = f.call("changeReviewRunDecision", f.input(), { facts });
    const before = f.context({ facts });
    const originalResults = f.database.prepare("SELECT * FROM validation_job_results").all();
    const historicalChange = f.dispose("reopen");
    expect(historicalChange.change).toMatchObject({ latestForRequestAtChange: false });
    expect(f.findings().context).toMatchObject({ historical: true, latestForRequest: false });
    expect(f.findings().items[0]?.disposition.state).toBe("open");
    expect(f.context({ facts })).toEqual(before);
    expect(before).toMatchObject({
      recordedDecision: accepted.change,
      recordedDecisionState: "current",
      stateReasons: [],
      canApprove: true,
    });
    expect(f.database.prepare("SELECT * FROM validation_job_results").all()).toEqual(
      originalResults,
    );
  });
  it("requires configure permission for override and never rewrites the validation policy", () => {
    const f = fixture({ blocking: true });
    f.grant("reviewer");
    const before = f.context().policy;
    expectCode(() => f.call("changeReviewRunDecision", f.input()), "PLATFORM_CONFLICT");
    expectCode(
      () => f.call("changeReviewRunDecision", f.input("override_approve", { actor: member })),
      "PLATFORM_FORBIDDEN",
    );
    f.grant("maintainer", member, 1);
    const event = f.call(
      "changeReviewRunDecision",
      f.input("override_approve", { actor: member }),
    ).change;
    expect(event.policyAtDecision).toMatchObject({ eligible: false, blockingFindingCount: 1 });
    expect(f.context()).toMatchObject({
      policy: before,
      recordedDecisionState: "current",
      canApprove: false,
    });
  });
  it.each(["approve", "request_changes", "override_approve"] as const)(
    "rejects new %s after repository pause but permits comments and withdrawal",
    (action) => {
      const f = fixture();
      const accepted = f.call("changeReviewRunDecision", f.input()).change;
      f.database
        .prepare("UPDATE managed_repositories SET enabled = 0, version = version + 1 WHERE id = ?")
        .run(f.scope.repositoryId);
      expect(f.context()).toMatchObject({
        sourceCurrent: false,
        recordedDecisionState: "stale",
        canApprove: false,
      });
      expectCode(
        () => f.call("changeReviewRunDecision", f.input(action, { changeId: "paused" })),
        "PLATFORM_CONFLICT",
      );
      f.call("changeReviewRunDecision", f.input("comment", { changeId: "historical-comment" }));
      f.call(
        "changeReviewRunDecision",
        f.input("withdraw", { changeId: "historical-withdraw", targetDecisionId: accepted.id }),
      );
      expect(f.context()).toMatchObject({ recordedDecisionState: "withdrawn", stateReasons: [] });
    },
  );
  it("uses current repository permissions for context, history, mutations and accepted retries", () => {
    const f = fixture();
    f.grant("viewer");
    expect(f.context({}, member).version).toBe(0);
    expect(f.call("listReviewRunDecisionHistory", { ...f.scope, actor: member }).total).toBe(0);
    expectCode(
      () => f.call("changeReviewRunDecision", f.input("comment", { actor: member })),
      "PLATFORM_FORBIDDEN",
    );
    f.grant("reviewer", member, 1);
    const input = f.input("comment", { actor: member });
    f.call("changeReviewRunDecision", input);
    f.grant(null, member, 2);
    expectCode(() => f.context({}, member), "PLATFORM_NOT_FOUND");
    expectCode(
      () => f.call("listReviewRunDecisionHistory", { ...f.scope, actor: member }),
      "PLATFORM_NOT_FOUND",
    );
    expectCode(() => f.call("changeReviewRunDecision", input), "PLATFORM_NOT_FOUND");
    expectCode(() => readReviewRunDecisionReplay(f.database, input, [actor]), "PLATFORM_NOT_FOUND");
    expectCode(
      () => f.context({}, { ...member, issuer: member.issuer.toUpperCase() }),
      "PLATFORM_NOT_FOUND",
    );
  });
  it("allows withdrawal by the original author or a maintainer, and rejects a peer reviewer", () => {
    const f = fixture();
    f.grant("reviewer", member);
    f.grant("reviewer", secondMember);
    const decision = f.call(
      "changeReviewRunDecision",
      f.input("approve", { actor: member }),
    ).change;
    const input = f.input("withdraw", {
      actor: secondMember,
      changeId: "withdraw",
      targetDecisionId: decision.id,
    });
    expectCode(() => f.call("changeReviewRunDecision", input), "PLATFORM_FORBIDDEN");
    f.grant("maintainer", secondMember, 1);
    expect(f.call("changeReviewRunDecision", input).change.action).toBe("withdraw");
    f.grant("reviewer", secondMember, 2);
    expectCode(() => f.call("changeReviewRunDecision", input), "PLATFORM_FORBIDDEN");
  });
  it("does not permit comments or withdrawal tombstones as withdrawal targets", () => {
    const f = fixture();
    const comment = f.call("changeReviewRunDecision", f.input("comment")).change;
    expectCode(
      () =>
        f.call(
          "changeReviewRunDecision",
          f.input("withdraw", { changeId: "withdraw", targetDecisionId: comment.id }),
        ),
      "PLATFORM_CONFLICT",
    );
    expectCode(
      () =>
        f.call(
          "changeReviewRunDecision",
          f.input("withdraw", { changeId: "withdraw", targetDecisionId: "absent" }),
        ),
      "PLATFORM_CONFLICT",
    );
    expect(f.context().version).toBe(1);
  });
  it("returns opaque not-found for cross-repository scope before disclosing history", () => {
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
    for (const operation of [
      "getReviewRunDecisionContext",
      "listReviewRunDecisionHistory",
    ] as const)
      expectCode(
        () => f.call(operation, { ...f.scope, repositoryId: "other-repo" }),
        "PLATFORM_NOT_FOUND",
      );
    expectCode(
      () => f.call("changeReviewRunDecision", f.input("comment", { repositoryId: "other-repo" })),
      "PLATFORM_NOT_FOUND",
    );
  });
  it("rejects stale timestamps and invalid pagination without appending a record", () => {
    const f = fixture();
    f.call("changeReviewRunDecision", f.input("comment"));
    expectCode(
      () => f.call("changeReviewRunDecision", f.input("comment", { changeId: "older" }), { now }),
      "PLATFORM_CONFLICT",
    );
    expectCode(
      () => f.call("listReviewRunDecisionHistory", { ...f.scope, pageSize: 21 }),
      "PLATFORM_INVALID",
    );
    expectCode(
      () => f.call("listReviewRunDecisionHistory", { ...f.scope, page: Number.MAX_SAFE_INTEGER }),
      "PLATFORM_INVALID",
    );
    expectCode(
      () => f.call("getReviewRunDecisionContext", f.scope, { now: "yesterday" }),
      "PLATFORM_INVALID",
    );
    expect(f.context().version).toBe(1);
  });
  it("participates in the caller transaction and rolls back the complete event", () => {
    const f = fixture();
    const input = f.input("comment");
    f.database.exec("BEGIN IMMEDIATE");
    f.call("changeReviewRunDecision", input);
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
    expect(f.context().version).toBe(0);
  });
  it("recognizes only the explicit decision operations and rejects unexpected input properties", () => {
    for (const operation of [
      "getReviewRunDecisionContext",
      "listReviewRunDecisionHistory",
      "changeReviewRunDecision",
    ])
      expect(isReviewRunDecisionOperation(operation)).toBe(true);
    for (const operation of ["__proto__", "constructor", "operatorRequest", "approve"])
      expect(isReviewRunDecisionOperation(operation)).toBe(false);
    const f = fixture();
    expectCode(
      () => f.call("changeReviewRunDecision", f.input("approve", { targetDecisionId: "invalid" })),
      "PLATFORM_INVALID",
    );
    expectCode(
      () => f.call("changeReviewRunDecision", f.input("comment", { createdAt: now })),
      "PLATFORM_INVALID",
    );
    expectCode(() => f.call("changeReviewRunDecision", f.input("withdraw")), "PLATFORM_INVALID");
  });
});

describe("decision migration and immutable audit integrity", () => {
  it("retains existing decision events when the current migration runner is reapplied", () => {
    const f = fixture();
    f.call("changeReviewRunDecision", f.input("comment"));
    const before = f.database.prepare("SELECT * FROM review_run_decision_events").all();
    runMigrations(f.database, migrationsDirectory);
    expect(f.database.prepare("SELECT * FROM review_run_decision_events").all()).toEqual(before);
    expect(
      f.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    ).toMatchObject({ version: 31 });
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it.each([
    "UPDATE review_run_decision_events SET reason = 'Replace history'",
    "DELETE FROM review_run_decision_events",
    "INSERT OR REPLACE INTO review_run_decision_events SELECT * FROM review_run_decision_events",
  ])("rejects immutable mutation: %s", (sql) => {
    const f = fixture();
    const response = f.call("changeReviewRunDecision", f.input());
    expect(() => f.database.exec(sql)).toThrow(/immutable|cannot be replaced/u);
    expect(f.context().recordedDecision).toEqual(response.change);
  });
  it.each([
    "version",
    "repository_id",
    "snapshot_json",
    "policy_json",
    "target_decision_id",
    "supersedes_decision_id",
  ])("rejects an inserted receipt with mismatched %s", (column) => {
    const f = fixture();
    const event = f.call("changeReviewRunDecision", f.input()).change;
    const row = {
      ...f.database.prepare("SELECT * FROM review_run_decision_events").get(),
      id: "forged",
      change_id: "forged",
      previous_version: 1,
      version: 2,
      supersedes_decision_id: event.id,
    } as Record<string, SQLInputValue>;
    switch (column) {
      case "version":
        row.version = 9;
        break;
      case "repository_id":
        row.repository_id = "foreign-repository";
        break;
      case "snapshot_json":
        row.snapshot_json = JSON.stringify({
          ...JSON.parse(String(row.snapshot_json)),
          reviewRunId: "foreign-run",
        });
        break;
      case "policy_json":
        row.policy_json = JSON.stringify({
          ...JSON.parse(String(row.policy_json)),
          applicable: false,
        });
        break;
      case "target_decision_id":
        row.target_decision_id = event.id;
        break;
      case "supersedes_decision_id":
        row.supersedes_decision_id = null;
        break;
    }
    expect(() => insert(f.database, "review_run_decision_events", row)).toThrow();
    expect(f.context().version).toBe(1);
  });
  it.each(["result_set_digest", "receipt_digest", "intent_digest", "supersedes_decision_id"])(
    "fails closed when a stored %s is corrupted",
    (column) => {
      const f = fixture();
      f.call("changeReviewRunDecision", f.input());
      f.call("changeReviewRunDecision", f.input("request_changes", { changeId: "replace" }));
      // Deliberately damage an isolated database; production triggers otherwise prohibit this.
      f.database.exec("DROP TRIGGER tr_review_run_decision_no_update");
      f.database
        .prepare(`UPDATE review_run_decision_events SET ${column} = ? WHERE version = 2`)
        .run(column === "supersedes_decision_id" ? null : "f".repeat(64));
      expectCode(() => f.context(), "PLATFORM_CORRUPT");
      expectCode(() => f.call("listReviewRunDecisionHistory", f.scope), "PLATFORM_CORRUPT");
    },
  );
  it("rejects a forged supersession link even when its public receipt digest was recomputed", () => {
    const f = fixture();
    f.call("changeReviewRunDecision", f.input());
    const replacement = f.call(
      "changeReviewRunDecision",
      f.input("request_changes", { changeId: "changes" }),
    ).change;
    f.database.exec("DROP TRIGGER tr_review_run_decision_no_update");
    const forged = { ...replacement, supersedesDecisionId: null };
    f.database
      .prepare(
        "UPDATE review_run_decision_events SET supersedes_decision_id = NULL, receipt_digest = ? WHERE version = 2",
      )
      .run(sha256(canonicalJson(forged)));
    expectCode(() => f.context(), "PLATFORM_CORRUPT");
  });
  it("reads a page backed by more than 40 MiB of private policy without selecting private JSON", () => {
    const f = fixture({ blocking: true });
    const original = f.call("changeReviewRunDecision", f.input("comment")).change;
    const base = f.database.prepare("SELECT * FROM review_run_decision_events").get() as Record<
      string,
      SQLInputValue
    >;
    const privatePolicy = {
      ...JSON.parse(String(base.policy_json)),
      reasons: Array.from({ length: 4200 }, () => ({
        code: "required_check_not_passed",
        reason: "x".repeat(512),
      })),
      reasonCount: 4200,
      reasonsTruncated: false,
    };
    const policyJson = canonicalJson(privatePolicy);
    expect(Buffer.byteLength(policyJson, "utf8")).toBeGreaterThan(2 * 1024 * 1024);
    const compact = {
      ...original.policyAtDecision,
      reasonCount: 4200,
      reasonCodes: ["required_check_not_passed"],
      reasonCodesTruncated: false,
    };
    let lastInput = f.input("comment");
    for (let version = 2; version <= 21; version++) {
      const event = {
        ...original,
        id: `large-${version}`,
        changeId: `large-${version}`,
        previousVersion: version - 1,
        version,
        policyAtDecision: compact,
      };
      lastInput = {
        ...f.scope,
        action: "comment",
        changeId: event.changeId,
        expectedVersion: event.previousVersion,
        expectedRevisionKey: event.revisionKey,
        expectedPlanDigest: event.planDigest,
        expectedResultSetDigest: event.resultSetDigest,
        reason: event.reason,
      };
      // Synthetic trusted append data exercises the read boundary, not model policy evaluation.
      insert(f.database, "review_run_decision_events", {
        ...base,
        id: event.id,
        change_id: event.changeId,
        previous_version: event.previousVersion,
        version,
        policy_json: policyJson,
        policy_digest: sha256(policyJson),
        policy_snapshot_json: canonicalJson(compact),
        intent_digest: sha256(canonicalJson(lastInput)),
        receipt_digest: sha256(canonicalJson(event)),
      });
    }
    const prepare = vi.spyOn(f.database, "prepare");
    const history = f.call("listReviewRunDecisionHistory", f.scope);
    expect(history).toMatchObject({ total: 21, pageSize: 20 });
    expect(history.items).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(history), "utf8")).toBeLessThan(32 * 1024);
    expect(f.context()).toMatchObject({ version: 21, recordedDecision: null });
    expect(readReviewRunDecisionReplay(f.database, lastInput, [actor])?.replayed).toBe(true);
    const selects = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes("FROM review_run_decision_events"));
    expect(selects.length).toBeGreaterThan(3);
    for (const sql of selects) {
      const projection = sql.slice(0, sql.indexOf("FROM review_run_decision_events"));
      expect(projection).not.toMatch(/SELECT\s+\*/iu);
      expect(projection).not.toMatch(/\b(?:snapshot_json|policy_json|policy_digest)\b/u);
    }
  });
});
