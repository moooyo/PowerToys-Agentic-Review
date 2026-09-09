import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createCanonicalResult,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
  ValidationJobResultV1Schema,
} from "@agentic-review/codex";
import type {
  ActiveAuthorizedRequestEpoch,
  FindingDispositionAction,
  ManagedRepository,
  OperatorPrincipal,
  OperatorRepositoryRole,
  PublicationConfirmRequest,
  PublicationPreviewV1,
  ReviewRunDecisionChangeRequest,
  ReviewRunPlanInput,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
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
import {
  handlePublicationRequest,
  type PublicationOperation,
  type PublicationOperationMap,
  type PublicationRequest,
  type RuntimePublicationPublisher,
  readPublicationReplay,
} from "./publications.js";
import type { ReviewCompletionJobContext } from "./review-results.js";
import {
  handleReviewRunDecisionRequest,
  type ReviewRunDecisionOperation,
  type ReviewRunDecisionOperationMap,
  type ReviewRunDecisionRequest,
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
function publicationFixture(
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

function publicationHarness(options: Parameters<typeof publicationFixture>[0] = {}) {
  const f = publicationFixture(options);
  const repositoryScope = { repositoryId: f.scope.repositoryId, actor };
  const publisher = { githubUserId: 777 };
  function call<K extends PublicationOperation>(
    operation: K,
    input: PublicationOperationMap[K]["input"],
    options: {
      now?: string;
      publisher?: RuntimePublicationPublisher;
      facts?: VerifiedReviewRunEvidenceFacts | null;
    } = {},
  ): PublicationOperationMap[K]["output"] {
    return handlePublicationRequest(
      f.database,
      { operation, input } as PublicationRequest,
      options.now ?? later,
      [actor],
      options.publisher === undefined ? publisher : options.publisher,
      options.facts === null ? undefined : (options.facts ?? f.facts),
    ) as PublicationOperationMap[K]["output"];
  }
  function enable() {
    return call("updateRepositoryPublicationPolicy", {
      ...repositoryScope,
      changeId: "policy-enable",
      expectedVersion: 0,
      enabled: true,
    });
  }
  function decision(
    action: ReviewRunDecisionChangeRequest["action"] = "comment",
    changeId = "decision-1",
  ) {
    return f.call("changeReviewRunDecision", f.input(action, { changeId })).change;
  }
  function preview(decisionId: string, principal = actor) {
    return call("getPublicationPreview", { ...f.scope, actor: principal, decisionId });
  }
  function confirmation(
    preview: PublicationPreviewV1,
    changeId = "confirmation-1",
    principal = actor,
  ) {
    const request: PublicationConfirmRequest = {
      changeId,
      publicationId: preview.publicationId,
      rendererVersion: preview.rendererVersion,
      expectedSelectedDecisionId: preview.binding.selectedDecisionId,
      expectedSelectedDecisionVersion: preview.binding.selectedDecisionVersion,
      expectedDecisionContextVersion: preview.binding.decisionContextVersion,
      expectedPolicyVersion: preview.policyVersion,
      expectedPublisherGitHubUserId: present(preview.publisherGitHubUserId),
      expectedRevisionKey: preview.binding.revisionKey,
      expectedPlanDigest: preview.binding.planDigest,
      expectedResultSetDigest: preview.binding.resultSetDigest,
      expectedPayloadSha256: present(preview.payloadSha256),
    };
    return { ...f.scope, actor: principal, ...request };
  }
  function confirmed() {
    enable();
    const event = decision();
    const candidate = preview(event.id);
    return call("confirmPublication", confirmation(candidate)).intent;
  }
  return {
    ...f,
    callPublication: call,
    repositoryScope,
    publisher,
    enable,
    decision,
    preview,
    confirmation,
    confirmed,
  };
}
const at = (milliseconds: number) => new Date(Date.parse(later) + milliseconds).toISOString();
const leaseKey = (
  lease: NonNullable<PublicationOperationMap["claimPublicationDelivery"]["output"]>,
) => ({
  publicationId: lease.publication.intent.publicationId,
  ownerId: lease.ownerId,
  fence: lease.fence,
});

describe("publication persistence and source binding", () => {
  it("defaults to disabled version zero and records a separate actor-bound CAS policy stream", () => {
    const f = publicationHarness();
    expect(f.callPublication("getRepositoryPublicationPolicy", f.repositoryScope)).toMatchObject({
      version: 0,
      enabled: false,
      updatedAt: null,
      updatedBy: null,
    });
    const enabled = f.enable();
    expect(enabled.change).toMatchObject({
      previousVersion: 0,
      version: 1,
      actor,
      snapshot: { enabled: true },
    });
    expect(f.enable()).toEqual({ change: enabled.change, replayed: true });
    expect(() =>
      f.callPublication("updateRepositoryPublicationPolicy", {
        ...f.repositoryScope,
        changeId: "policy-enable",
        expectedVersion: 0,
        enabled: false,
      }),
    ).toThrow(/another request/u);
    expect(() =>
      f.callPublication("updateRepositoryPublicationPolicy", {
        ...f.repositoryScope,
        changeId: "new-change",
        expectedVersion: 0,
        enabled: false,
      }),
    ).toThrow(/changed/u);
    expect(f.callPublication("listRepositoryPublicationPolicyAudit", f.repositoryScope).total).toBe(
      1,
    );
  });
  it("renders a deterministic read-only preview and refuses unavailable publishers and disabled policy", () => {
    const f = publicationHarness();
    const event = f.decision();
    const before = (f.database.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const first = f.preview(event.id),
      second = f.preview(event.id);
    expect(second).toEqual(first);
    expect(first.blockers).toContain("publication_disabled");
    expect(first.canConfirm).toBe(false);
    expect((f.database.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(
      before,
    );
    f.enable();
    const unavailable = f.callPublication(
      "getPublicationPreview",
      { ...f.scope, decisionId: event.id },
      { publisher: null },
    );
    expect(unavailable).toMatchObject({
      publisherAvailability: "unavailable",
      publisherGitHubUserId: null,
      canConfirm: false,
    });
    expect(unavailable.blockers).toContain("publisher_unavailable");
  });
  it("confirms exact content once and replays the original receipt after policy and evidence changes", () => {
    const f = publicationHarness();
    f.enable();
    const event = f.decision();
    const candidate = f.preview(event.id);
    const input = f.confirmation(candidate);
    const receipt = f.callPublication("confirmPublication", input);
    expect(receipt.intent.payloadSha256).toBe(sha256(canonicalJson(receipt.intent.payload)));
    f.callPublication("updateRepositoryPublicationPolicy", {
      ...f.repositoryScope,
      changeId: "disable",
      expectedVersion: 1,
      enabled: false,
    });
    expect(
      readPublicationReplay(f.database, { operation: "confirmPublication", input }, [actor]),
    ).toEqual({ intent: receipt.intent, replayed: true });
    expect(
      f.callPublication("confirmPublication", input, { facts: null, publisher: null }),
    ).toEqual({ intent: receipt.intent, replayed: true });
    expect(() =>
      f.callPublication("confirmPublication", { ...input, expectedPayloadSha256: "f".repeat(64) }),
    ).toThrow(/another request/u);
    expect(f.callPublication("listPublications", f.repositoryScope).total).toBe(1);
  });
  it("rejects duplicate logical publications with another change identifier and every stale confirmation echo", () => {
    const f = publicationHarness();
    f.enable();
    const event = f.decision();
    const input = f.confirmation(f.preview(event.id));
    for (const changed of [
      { expectedPublisherGitHubUserId: 888 },
      { expectedPayloadSha256: "f".repeat(64) },
      { expectedPolicyVersion: 2 },
      { expectedDecisionContextVersion: 2 },
      { expectedResultSetDigest: "e".repeat(64) },
    ])
      expect(() => f.callPublication("confirmPublication", { ...input, ...changed })).toThrow(
        /changed/u,
      );
    f.callPublication("confirmPublication", input);
    expect(() =>
      f.callPublication("confirmPublication", { ...input, changeId: "duplicate" }),
    ).toThrow(/changed/u);
  });
  it("selects comment events by ID and distinguishes the selected version from current context", () => {
    const f = publicationHarness();
    f.enable();
    const comment = f.decision("comment", "comment-1");
    const second = f.decision("comment", "comment-2");
    const candidate = f.preview(comment.id);
    expect(candidate.binding).toMatchObject({
      selectedDecisionId: comment.id,
      selectedDecisionVersion: comment.version,
      decisionContextVersion: second.version,
    });
    expect(candidate.canConfirm).toBe(true);
    const input = f.confirmation(candidate);
    f.decision("comment", "comment-3");
    expect(() => f.callPublication("confirmPublication", input)).toThrow(/changed/u);
  });
  it("blocks withdrawn or superseded non-comment decisions and maps qualified overrides to comments", () => {
    const f = publicationHarness({ blocking: true });
    f.enable();
    const override = f.decision("override_approve");
    const candidate = f.preview(override.id);
    expect(candidate.payload).toMatchObject({ event: "COMMENT" });
    expect(candidate.payload?.body).toContain("Qualified approval exception");
    expect(candidate.payload?.body).toContain("Guard null handles");
    f.decision("request_changes", "request-changes");
    expect(f.preview(override.id).blockers).toContain("decision_superseded");
  });
  it("keeps preview visibility separate from configure permission and rechecks replay authority", () => {
    const f = publicationHarness();
    f.enable();
    f.grant("reviewer");
    const event = f.decision();
    expect(f.preview(event.id, member).blockers).toContain("confirmation_not_permitted");
    f.grant("maintainer", member, 1);
    const input = f.confirmation(f.preview(event.id, member), "member-confirm", member);
    f.callPublication("confirmPublication", input);
    f.grant(null, member, 2);
    expect(() =>
      readPublicationReplay(f.database, { operation: "confirmPublication", input }, [actor]),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
  });
  it("cannot substitute a repository, publisher, source or unavailable evidence", () => {
    const f = publicationHarness();
    f.enable();
    const event = f.decision();
    const candidate = f.preview(event.id);
    expect(() =>
      f.callPublication("confirmPublication", f.confirmation(candidate), {
        publisher: { githubUserId: 888 },
      }),
    ).toThrow(/changed/u);
    expect(() =>
      f.callPublication("confirmPublication", f.confirmation(candidate), { facts: null }),
    ).toThrow(/changed/u);
    f.database.prepare("UPDATE work_items SET state='closed' WHERE id=?").run(f.run.workItemId);
    expect(f.preview(event.id).blockers).toContain("source_not_current");
    expect(() =>
      f.callPublication("getPublicationPreview", {
        ...f.scope,
        repositoryId: "another-repository",
        decisionId: event.id,
      }),
    ).toThrow();
  });
});

describe("publication send fencing and conservative recovery", () => {
  it("records exactly one durable sending boundary and a matching published remote receipt", () => {
    const f = publicationHarness();
    const intent = f.confirmed();
    const lease = present(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher-1",
        leaseDurationMs: 30_000,
      }),
    );
    expect(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher-2",
        leaseDurationMs: 30_000,
      }),
    ).toBeNull();
    const sending = present(
      f.callPublication("beginPublicationSend", {
        ...leaseKey(lease),
        expectedPayloadSha256: intent.payloadSha256,
      }),
    );
    expect(() =>
      f.callPublication("beginPublicationSend", {
        ...leaseKey(lease),
        expectedPayloadSha256: intent.payloadSha256,
      }),
    ).toThrow(/another send/u);
    expect(intent.payload.kind).toBe("pull_request_review");
    if (intent.payload.kind !== "pull_request_review") throw new Error("A PR fixture is required.");
    const published = f.callPublication("completePublicationDelivery", {
      ...leaseKey(sending),
      outcome: "published",
      failure: null,
      remoteReceipt: {
        kind: "pull_request_review",
        githubId: 901,
        htmlUrl: "https://github.com/example/project/pull/1#pullrequestreview-901",
        createdAt: later,
        publisherGitHubUserId: 777,
        commitId: intent.payload.commitId,
        event: intent.payload.event,
      },
    });
    expect(published.delivery.status).toBe("published");
    expect(
      f
        .callPublication("listPublicationAttempts", {
          ...f.repositoryScope,
          publicationId: intent.publicationId,
        })
        .items.map((item) => item.phase),
    ).toEqual(["outcome", "sending", "preflight"]);
  });
  it("turns preflight loss into explicit retry and sending loss into unknown without automatic resend", () => {
    const f = publicationHarness();
    const intent = f.confirmed();
    const first = present(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher-1",
        leaseDurationMs: 1_000,
      }),
    );
    f.callPublication("recoverExpiredPublications", {}, { now: at(1001) });
    const failed = f.callPublication("getPublication", {
      ...f.repositoryScope,
      publicationId: intent.publicationId,
    });
    expect(failed.delivery.status).toBe("failed");
    expect(
      f.callPublication(
        "claimPublicationDelivery",
        { ownerId: "publisher-2", leaseDurationMs: 1_000 },
        { now: at(1001) },
      ),
    ).toBeNull();
    f.callPublication(
      "retryPublication",
      {
        ...f.repositoryScope,
        publicationId: intent.publicationId,
        changeId: "retry-1",
        expectedVersion: failed.delivery.version,
        expectedPayloadSha256: intent.payloadSha256,
      },
      { now: at(1001) },
    );
    const second = present(
      f.callPublication(
        "claimPublicationDelivery",
        { ownerId: "publisher-2", leaseDurationMs: 1000 },
        { now: at(1001) },
      ),
    );
    expect(second.fence).toBeGreaterThan(first.fence);
    expect(
      f.callPublication(
        "beginPublicationSend",
        { ...leaseKey(first), expectedPayloadSha256: intent.payloadSha256 },
        { now: at(1001) },
      ),
    ).toBeNull();
    f.callPublication(
      "beginPublicationSend",
      { ...leaseKey(second), expectedPayloadSha256: intent.payloadSha256 },
      { now: at(1001) },
    );
    f.callPublication("recoverExpiredPublications", {}, { now: at(2002) });
    const unknown = f.callPublication("getPublication", {
      ...f.repositoryScope,
      publicationId: intent.publicationId,
    });
    expect(unknown.delivery.status).toBe("unknown");
    expect(() =>
      f.callPublication(
        "retryPublication",
        {
          ...f.repositoryScope,
          publicationId: intent.publicationId,
          changeId: "retry-unknown",
          expectedVersion: unknown.delivery.version,
          expectedPayloadSha256: intent.payloadSha256,
        },
        { now: at(2002) },
      ),
    ).toThrow(/unavailable/u);
  });
  it("blocks immediately before sending when policy or credential changes", () => {
    const f = publicationHarness();
    const intent = f.confirmed();
    const lease = present(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    );
    expect(
      f.callPublication(
        "beginPublicationSend",
        { ...leaseKey(lease), expectedPayloadSha256: intent.payloadSha256 },
        { publisher: { githubUserId: 888 } },
      ),
    ).toBeNull();
    const blocked = f.callPublication("getPublication", {
      ...f.repositoryScope,
      publicationId: intent.publicationId,
    });
    expect(blocked.delivery).toMatchObject({
      status: "blocked",
      failure: { code: "publisher_identity_mismatch" },
    });
    expect(
      f
        .callPublication("listPublicationAttempts", {
          ...f.repositoryScope,
          publicationId: intent.publicationId,
        })
        .items.some((item) => item.phase === "sending"),
    ).toBe(false);
  });
  it("blocks a revoked original confirmer before recording that sending may have begun", () => {
    const f = publicationHarness();
    f.enable();
    f.grant("maintainer");
    const event = f.decision();
    const intent = f.callPublication(
      "confirmPublication",
      f.confirmation(f.preview(event.id, member), "member-confirm", member),
    ).intent;
    const lease = present(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    );
    f.grant(null, member, 1);
    expect(
      f.callPublication("beginPublicationSend", {
        ...leaseKey(lease),
        expectedPayloadSha256: intent.payloadSha256,
      }),
    ).toBeNull();
    expect(
      f.callPublication("getPublication", {
        ...f.repositoryScope,
        publicationId: intent.publicationId,
      }).delivery,
    ).toMatchObject({ status: "blocked", failure: { code: "authorization_changed" } });
  });
  it("keeps a complete no-match reconciliation unknown and never introduces another send", () => {
    const f = publicationHarness();
    const intent = f.confirmed();
    const lease = present(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    );
    f.callPublication("beginPublicationSend", {
      ...leaseKey(lease),
      expectedPayloadSha256: intent.payloadSha256,
    });
    const unknown = f.callPublication("completePublicationDelivery", {
      ...leaseKey(lease),
      outcome: "unknown",
      failure: {
        code: "ambiguous_delivery",
        message: "The connection ended after request transmission.",
      },
      remoteReceipt: null,
    });
    f.database.prepare("UPDATE work_items SET state='closed' WHERE id=?").run(f.run.workItemId);
    const request = {
      ...f.repositoryScope,
      publicationId: intent.publicationId,
      changeId: "reconcile-1",
      expectedVersion: unknown.delivery.version,
      expectedPayloadSha256: intent.payloadSha256,
    };
    const accepted = f.callPublication("requestPublicationReconciliation", request);
    expect(f.callPublication("requestPublicationReconciliation", request)).toEqual({
      change: accepted.change,
      replayed: true,
    });
    const reconciliation = present(
      f.callPublication("claimPublicationReconciliation", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    );
    expect(reconciliation.kind).toBe("reconciliation");
    expect(() =>
      f.callPublication("beginPublicationSend", {
        ...leaseKey(reconciliation),
        expectedPayloadSha256: intent.payloadSha256,
      }),
    ).toThrow();
    const result = f.callPublication("completePublicationReconciliation", {
      ...leaseKey(reconciliation),
      outcome: "unknown",
      failure: {
        code: "reconciliation_no_match",
        message: "The complete read found no exact matching publication.",
      },
      remoteReceipt: null,
    });
    expect(result.delivery.status).toBe("unknown");
    expect(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    ).toBeNull();
  });
  it("rechecks the reconciliation requester independently from the original confirming operator", () => {
    const f = publicationHarness();
    const intent = f.confirmed();
    f.grant("maintainer");
    const lease = present(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    );
    f.callPublication("beginPublicationSend", {
      ...leaseKey(lease),
      expectedPayloadSha256: intent.payloadSha256,
    });
    const unknown = f.callPublication("completePublicationDelivery", {
      ...leaseKey(lease),
      outcome: "unknown",
      failure: { code: "ambiguous_delivery", message: "The response was not observed." },
      remoteReceipt: null,
    });
    f.callPublication("requestPublicationReconciliation", {
      ...f.repositoryScope,
      actor: member,
      publicationId: intent.publicationId,
      changeId: "member-reconcile",
      expectedVersion: unknown.delivery.version,
      expectedPayloadSha256: intent.payloadSha256,
    });
    f.grant(null, member, 1);
    expect(
      f.callPublication("claimPublicationReconciliation", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    ).toBeNull();
    const result = f.callPublication("getPublication", {
      ...f.repositoryScope,
      publicationId: intent.publicationId,
    });
    expect(result.delivery).toMatchObject({
      status: "unknown",
      failure: { code: "reconciliation_incomplete" },
    });
    expect(result.delivery.failure?.message).toContain("No upstream scan was started");
    expect(
      f.callPublication("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    ).toBeNull();
  });
  it("preserves immutable intent and audit rows across cancellation and rejects replacement", () => {
    const f = publicationHarness();
    const intent = f.confirmed();
    const input = {
      ...f.repositoryScope,
      publicationId: intent.publicationId,
      changeId: "cancel-1",
      expectedVersion: 1,
      expectedPayloadSha256: intent.payloadSha256,
    };
    const cancelled = f.callPublication("cancelPublication", input);
    expect(cancelled.change.delivery.status).toBe("cancelled");
    expect(f.callPublication("cancelPublication", input)).toEqual({
      change: cancelled.change,
      replayed: true,
    });
    expect(
      f.callPublication("getPublication", {
        ...f.repositoryScope,
        publicationId: intent.publicationId,
      }).intent,
    ).toEqual(intent);
    expect(() =>
      f.database
        .prepare("DELETE FROM publication_intents WHERE publication_id=?")
        .run(intent.publicationId),
    ).toThrow(/immutable/u);
    expect(() =>
      f.database.prepare("UPDATE publication_change_events SET receipt_json='{}'").run(),
    ).toThrow(/immutable/u);
  });
});
