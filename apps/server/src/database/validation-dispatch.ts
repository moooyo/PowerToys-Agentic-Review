import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  EntityIdSchema,
  evaluationExecutionCapabilityLabel,
  type JobState,
  type ReviewRunBlockedReason,
  type ReviewRunExecutionPlanV1,
  type ReviewRunPlannedJob,
  type ReviewRunRunnerSupport,
  UiDriverCapabilities,
  validationExecutorCapabilityLabels,
  type WorkerCapabilities,
} from "@agentic-review/contracts";
import {
  evaluateEvaluationRunReadiness,
  evaluateReviewRunStructuralReadiness,
  getReviewRunRequiredCapabilities,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  createEvaluationExecutionTemplate,
  createValidationExecutionTemplate,
} from "../scheduling/validation-job-factory.js";
import {
  type EvaluationExecutionCell,
  readEvaluationExecutionCellInTransaction,
} from "./evaluation-execution.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import type { ConfigurationActor } from "./prompt-configuration.js";
import {
  associateReviewRunJobInTransaction,
  getReviewRunPromptEnvelope,
  handleReviewRunRequest,
  maximumReviewRunJobAssociationCount,
  type ReviewRunDetail,
} from "./review-runs.js";

export interface ValidationDispatchedJob {
  readonly requestId: string;
  readonly jobId: string;
  readonly jobActivation: number;
}

export interface ValidationDispatchResult {
  readonly repositoryId: string;
  readonly reviewRunId: string;
  readonly createdJobs: ValidationDispatchedJob[];
  readonly blockedRequests: {
    readonly requestId: string;
    readonly reasons: ReviewRunBlockedReason[];
  }[];
  readonly alreadyAssociatedRequestIds: string[];
}

interface RunScope {
  readonly repositoryId: string;
  readonly reviewRunId: string;
}

interface OperatorRunScope extends RunScope {
  readonly actor: ConfigurationActor;
}

interface RerunResult extends RunScope, ValidationDispatchedJob {
  readonly replayed: boolean;
}

interface CancelResult extends RunScope {
  readonly requestId: string;
  readonly jobId: string;
  readonly jobState: JobState;
  readonly changed: boolean;
}

export interface ValidationDispatchOperationMap {
  readonly dispatchReviewRun: {
    readonly input: OperatorRunScope;
    readonly output: ValidationDispatchResult;
  };
  readonly dispatchPendingReviewRuns: {
    readonly input: { readonly limit?: number };
    readonly output: {
      readonly examinedRequestCount: number;
      readonly createdJobs: (RunScope & ValidationDispatchedJob)[];
      readonly blockedRequestCount: number;
    };
  };
  readonly rerunValidationRequest: {
    readonly input: OperatorRunScope & {
      readonly requestId: string;
      readonly activationId: string;
    };
    readonly output: RerunResult;
  };
  readonly cancelValidationJob: {
    readonly input: OperatorRunScope & { readonly requestId: string; readonly jobId: string };
    readonly output: CancelResult;
  };
}

export type ValidationDispatchOperation = keyof ValidationDispatchOperationMap;
export type ValidationDispatchRequest = {
  [K in ValidationDispatchOperation]: {
    readonly operation: K;
    readonly input: ValidationDispatchOperationMap[K]["input"];
  };
}[ValidationDispatchOperation];

export const maximumValidationDispatchBatchSize = 128;
const backgroundActor: ConfigurationActor = {
  issuer: "urn:agentic-review:server",
  subject: "validation-dispatch",
};

type DispatchCheckReason =
  | ReviewRunBlockedReason
  | {
      readonly code: "authorization_changed" | "job_association_limit";
    };

class ValidationDispatchError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_NOT_FOUND" | "PLATFORM_CONFLICT",
    message: string,
    readonly retainPending = false,
  ) {
    super(message);
    this.name = "ValidationDispatchError";
  }
}

function invalid(message: string): never {
  throw new ValidationDispatchError("PLATFORM_INVALID", message);
}

function conflict(message: string, retainPending = false): never {
  throw new ValidationDispatchError("PLATFORM_CONFLICT", message, retainPending);
}

function notFound(): never {
  throw new ValidationDispatchError(
    "PLATFORM_NOT_FOUND",
    "The scoped validation request does not exist.",
  );
}

function validId(value: unknown): void {
  if (!Value.Check(EntityIdSchema, value)) invalid("The validation operation identity is invalid.");
}

function validActor(actor: ConfigurationActor): void {
  if (!actor || typeof actor !== "object") invalid("An authenticated operator is required.");
  for (const [value, limit] of [
    [actor.issuer, 2_048],
    [actor.subject, 512],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > limit ||
      value.trim() !== value ||
      !value.isWellFormed() ||
      value.includes("\0")
    )
      invalid("An authenticated operator is required.");
  }
}

function assertTransaction(database: DatabaseSync, now: string): void {
  if (!database.isTransaction) invalid("Validation dispatch requires an existing transaction.");
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
    invalid("A canonical validation operation timestamp is required.");
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  if (database.isTransaction) invalid("The public validation operation must own its transaction.");
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readRun(database: DatabaseSync, input: RunScope, now: string): ReviewRunDetail {
  validId(input.repositoryId);
  validId(input.reviewRunId);
  const run = handleReviewRunRequest(
    database,
    { operation: "getReviewRun", input },
    now,
  ) as ReviewRunDetail | null;
  if (run === null) notFound();
  return run;
}

function assertCurrentAuthorization(database: DatabaseSync, run: ReviewRunDetail): void {
  const current = database
    .prepare(`SELECT repository.enabled, repository.github_repository_id,
    repository.reviewer_github_user_id, repository.authorization_policy_json,
    item.state, item.current_revision_key, epoch.status, epoch.ordinal,
    epoch.target_github_user_id, revision.revision_key
    FROM managed_repositories AS repository
    JOIN work_items AS item ON item.repository_id = repository.id
    JOIN request_epochs AS epoch ON epoch.work_item_id = item.id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
    WHERE repository.id = ? AND item.id = ? AND epoch.id = ?`)
    .get(run.repositoryId, run.workItemId, run.requestEpochId) as
    | {
        enabled: number;
        github_repository_id: number;
        reviewer_github_user_id: number | null;
        authorization_policy_json: string | null;
        state: string;
        current_revision_key: string;
        status: string;
        ordinal: number;
        target_github_user_id: number;
        revision_key: string;
      }
    | undefined;
  if (
    current === undefined ||
    current.state !== "open" ||
    current.status !== "active" ||
    current.github_repository_id !== run.plan.repository.githubRepositoryId ||
    current.current_revision_key !== run.revisionKey ||
    current.revision_key !== run.revisionKey ||
    current.ordinal !== run.plan.authorization.sequence ||
    current.target_github_user_id !== run.plan.authorization.targetGithubUserId
  )
    conflict("The active exact-revision authorization no longer covers this run.");
  const automatic = database
    .prepare(`SELECT activation.work_item_id, activation.request_epoch_id,
      activation.source_sequence, activation.revision_key,
      source.sequence AS current_source_sequence, source.current_revision_key
      FROM github_review_run_activations AS activation
      LEFT JOIN github_review_run_sources AS source ON source.work_item_id = activation.work_item_id
      WHERE activation.mode = 'review_run' AND activation.review_run_id = ?`)
    .get(run.id) as
    | {
        work_item_id: string;
        request_epoch_id: string;
        source_sequence: number;
        revision_key: string;
        current_source_sequence: number | null;
        current_revision_key: string | null;
      }
    | undefined;
  if (
    automatic !== undefined &&
    (automatic.work_item_id !== run.workItemId ||
      automatic.request_epoch_id !== run.requestEpochId ||
      automatic.revision_key !== run.revisionKey ||
      automatic.current_source_sequence !== automatic.source_sequence ||
      automatic.current_revision_key !== automatic.revision_key)
  )
    conflict("The automatic review run belongs to an obsolete GitHub source activation.");
  if (
    current.enabled !== 1 ||
    current.reviewer_github_user_id !== run.plan.authorization.targetGithubUserId ||
    current.authorization_policy_json === null ||
    canonicalJson(JSON.parse(current.authorization_policy_json)) !==
      canonicalJson(run.plan.authorization.policy)
  )
    conflict("Repository scheduling settings no longer permit this frozen run.", true);
}

function hasProfileCapability(capabilities: WorkerCapabilities, name: string): boolean {
  let value: unknown = capabilities;
  for (const part of name.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return (
    value === true || capabilities.recipeIds.includes(name) || capabilities.labels[name] === "1"
  );
}

export function getValidationRunnerSupport(
  plan: Pick<ReviewRunExecutionPlanV1, "jobs" | "reproduction"> & {
    readonly schemaVersion?: string;
  },
  inventory: readonly WorkerCapabilities[],
): ReviewRunRunnerSupport[] {
  const relevant = new Set(
    plan.jobs.flatMap((request) => getReviewRunRequiredCapabilities(plan, request)),
  );
  relevant.add(UiDriverCapabilities.web);
  relevant.add(UiDriverCapabilities.windows_desktop);
  const support: ReviewRunRunnerSupport[] = [];
  for (const worker of inventory) {
    const capabilities = [...relevant].filter((capability) =>
      capability === validationExecutorCapabilityLabels.reproduction ||
      capability === validationExecutorCapabilityLabels.probes ||
      capability === validationExecutorCapabilityLabels.uiObservations ||
      capability === evaluationExecutionCapabilityLabel
        ? worker.labels[capability] === "1"
        : hasProfileCapability(worker, capability),
    );
    for (const target of ["headless", "windows_desktop", "web"] as const) {
      if (worker.labels[validationExecutorCapabilityLabels[target]] !== "1") continue;
      const driver = target === "headless" ? null : UiDriverCapabilities[target];
      const implemented =
        driver === null || worker.labels[driver] === "1"
          ? capabilities
          : capabilities.filter((capability) => capability !== driver);
      for (const workflowKind of target === "headless"
        ? (["pr_static_build", "issue_triage", "issue_validation"] as const)
        : (["pr_ui", "issue_validation"] as const)) {
        support.push({
          workflowKind,
          target,
          capabilities: implemented,
          evidenceDelivery: worker.labels.evidenceDelivery === "1",
        });
      }
    }
  }
  return support;
}

function recordCheck(
  database: DatabaseSync,
  run: Pick<ReviewRunDetail, "repositoryId" | "id">,
  requestId: string,
  reasons: readonly DispatchCheckReason[],
  now: string,
  pending = true,
): void {
  const state = database
    .prepare("SELECT sequence FROM validation_dispatch_state WHERE singleton = 1")
    .get() as { sequence: number } | undefined;
  if (!state || !Number.isSafeInteger(state.sequence + 1))
    conflict("The validation dispatch sequence is exhausted.");
  const next = state.sequence + 1;
  database
    .prepare(
      "UPDATE validation_dispatch_state SET sequence = ?, last_repository_id = ? WHERE singleton = 1",
    )
    .run(next, run.repositoryId);
  database
    .prepare(`INSERT INTO validation_dispatch_checks (repository_id, review_run_id, request_id, pending, last_sequence, checked_at, blockers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(review_run_id, request_id) DO UPDATE SET
    pending = excluded.pending, last_sequence = excluded.last_sequence,
    checked_at = excluded.checked_at, blockers_json = excluded.blockers_json`)
    .run(run.repositoryId, run.id, requestId, Number(pending), next, now, canonicalJson(reasons));
}

function appendAudit(
  database: DatabaseSync,
  input: OperatorRunScope & {
    readonly requestId?: string;
    readonly activationId?: string;
    readonly jobId?: string;
  },
  action: "dispatch" | "rerun" | "cancel",
  result: unknown,
  now: string,
  requestId: string | null = null,
  activationId: string | null = null,
): void {
  database
    .prepare(`INSERT INTO validation_control_audit (id, repository_id, review_run_id, request_id,
    action, activation_id, intent_digest, actor_issuer, actor_subject, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      input.repositoryId,
      input.reviewRunId,
      requestId,
      action,
      activationId,
      controlIntentDigest(action, input),
      input.actor.issuer,
      input.actor.subject,
      canonicalJson(result),
      now,
    );
}

function controlIntentDigest(
  action: "dispatch" | "rerun" | "cancel",
  input: OperatorRunScope & {
    readonly requestId?: string;
    readonly activationId?: string;
    readonly jobId?: string;
  },
): string {
  return sha256(
    canonicalJson({
      schemaVersion: "ValidationControlIntentV1",
      action,
      repositoryId: input.repositoryId,
      reviewRunId: input.reviewRunId,
      requestId: input.requestId ?? null,
      activationId: input.activationId ?? null,
      jobId: input.jobId ?? null,
      actor: { issuer: input.actor.issuer, subject: input.actor.subject },
    }),
  );
}

function insertJob(
  database: DatabaseSync,
  run: ReviewRunDetail,
  request: ReviewRunPlannedJob,
  activation: number,
  actor: ConfigurationActor,
  now: string,
): ValidationDispatchedJob {
  const frozenPrompt = getReviewRunPromptEnvelope(database, {
    repositoryId: run.repositoryId,
    reviewRunId: run.id,
    requestId: request.requestId,
  });
  if (frozenPrompt === null || request.profileVersion === null)
    conflict("A frozen prompt and profile are required.");
  const template = createValidationExecutionTemplate({
    runId: run.id,
    plan: run.plan,
    planDigest: run.planDigest,
    requestId: request.requestId,
    jobActivation: activation,
    frozenPrompt,
  });
  const executionJson = canonicalJson(template);
  const requiredCapabilities = { labels: { ...template.executionPolicy.requiredCapabilityLabels } };
  if (request.target !== "headless") {
    Object.assign(requiredCapabilities.labels, {
      evidenceDelivery: "1",
      [UiDriverCapabilities[request.target]]: "1",
    });
  }
  const requiredJson = canonicalJson(requiredCapabilities);
  const jobId = randomUUID();
  const semanticKey = `validation:${sha256(canonicalJson([run.id, request.requestId, activation]))}`;
  const concurrencyKey = `validation:${sha256(canonicalJson([run.repositoryId, run.workItemId, request.workflowKind, request.profileVersion.profileId, request.target]))}`;
  database
    .prepare(`INSERT INTO jobs (id, work_item_id, job_kind, generation, intent_version,
    semantic_key, concurrency_key, status, priority, execution_json, execution_digest,
    required_capabilities_json, required_capabilities_digest, resource_revision, max_attempts,
    next_attempt_at, created_at, updated_at, request_epoch_id, activation)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?, ?)`)
    .run(
      jobId,
      run.workItemId,
      run.plan.workItem.kind === "pull_request" ? "pull_request_review" : "issue_triage",
      run.plan.authorization.sequence,
      semanticKey,
      concurrencyKey,
      run.plan.workItem.kind === "pull_request" ? 100 : 50,
      executionJson,
      sha256(executionJson),
      requiredJson,
      sha256(requiredJson),
      run.revisionKey,
      now,
      now,
      now,
      run.requestEpochId,
      activation,
    );
  createJobAdmissionInTransaction(database, jobId, now);
  database
    .prepare(
      "INSERT INTO job_request_epochs (job_id, request_epoch_id, linked_at) VALUES (?, ?, ?)",
    )
    .run(jobId, run.requestEpochId, now);
  associateReviewRunJobInTransaction(
    database,
    {
      repositoryId: run.repositoryId,
      reviewRunId: run.id,
      requestId: request.requestId,
      jobId,
      actor,
    },
    now,
  );
  return { requestId: request.requestId, jobId, jobActivation: activation };
}

function dispatchSelected(
  database: DatabaseSync,
  run: ReviewRunDetail,
  actor: ConfigurationActor,
  now: string,
  selected?: ReadonlySet<string>,
): ValidationDispatchResult {
  assertCurrentAuthorization(database, run);
  const result: ValidationDispatchResult = {
    repositoryId: run.repositoryId,
    reviewRunId: run.id,
    createdJobs: [],
    blockedRequests: [],
    alreadyAssociatedRequestIds: [],
  };
  const readiness = evaluateReviewRunStructuralReadiness(run.plan);
  for (const request of run.plan.jobs) {
    if (selected && !selected.has(request.requestId)) continue;
    const associated = run.requests.find((entry) => entry.requestId === request.requestId);
    if (!associated) conflict("The planned request association is missing.");
    if (associated.jobs.length > 0) {
      result.alreadyAssociatedRequestIds.push(request.requestId);
      continue;
    }
    const ready = readiness.find((entry) => entry.requestId === request.requestId);
    if (!ready) conflict("The planned request readiness is missing.");
    recordCheck(database, run, request.requestId, ready.reasons, now);
    if (ready.state === "blocked")
      result.blockedRequests.push({ requestId: request.requestId, reasons: ready.reasons });
    else result.createdJobs.push(insertJob(database, run, request, 1, actor, now));
  }
  return result;
}

function insertEvaluationJob(
  database: DatabaseSync,
  cell: EvaluationExecutionCell,
  now: string,
): ValidationDispatchedJob {
  const request = cell.request;
  const template = createEvaluationExecutionTemplate({
    runId: cell.runId,
    plan: cell.plan,
    planDigest: cell.planDigest,
    frozenPrompt: cell.prompt,
  });
  const execution = canonicalJson(template);
  const required = { labels: { ...template.executionPolicy.requiredCapabilityLabels } };
  if (request.target !== "headless") {
    Object.assign(required.labels, {
      evidenceDelivery: "1",
      [UiDriverCapabilities[request.target]]: "1",
    });
  }
  const requiredJson = canonicalJson(required),
    jobId = randomUUID();
  const semanticKey = `evaluation:${sha256(canonicalJson([cell.evaluationId, cell.cellId, cell.runId, cell.requestId, 1]))}`;
  const concurrencyKey = `evaluation:${sha256(canonicalJson([cell.repositoryId, cell.cellId, request.target]))}`;
  database
    .prepare(`INSERT INTO jobs (id, work_item_id, job_kind, generation, intent_version, semantic_key, concurrency_key,
    status, priority, execution_json, execution_digest, required_capabilities_json, required_capabilities_digest,
    resource_revision, max_attempts, next_attempt_at, created_at, updated_at, request_epoch_id, activation)
    VALUES (?, ?, ?, 1, 1, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, NULL, 1)`)
    .run(
      jobId,
      cell.plan.workItemId,
      cell.plan.workItem.kind === "pull_request" ? "pull_request_review" : "issue_triage",
      semanticKey,
      concurrencyKey,
      cell.plan.workItem.kind === "pull_request" ? 100 : 50,
      execution,
      sha256(execution),
      requiredJson,
      sha256(requiredJson),
      cell.plan.revision.revisionKey,
      now,
      now,
      now,
    );
  createJobAdmissionInTransaction(database, jobId, now);
  database
    .prepare(`INSERT INTO review_run_job_links (review_run_id, request_id, activation_number, job_id, linked_at)
    VALUES (?, ?, 1, ?, ?)`)
    .run(cell.runId, cell.requestId, jobId, now);
  database
    .prepare(`INSERT INTO review_run_audit (id, review_run_id, action, actor_issuer, actor_subject, detail_json, created_at)
    VALUES (?, ?, 'job_associated', ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      cell.runId,
      backgroundActor.issuer,
      backgroundActor.subject,
      canonicalJson({
        requestId: cell.requestId,
        jobId,
        activationNumber: 1,
        evaluationId: cell.evaluationId,
        cellId: cell.cellId,
      }),
      now,
    );
  return { requestId: cell.requestId, jobId, jobActivation: 1 };
}

/** Uses the same bounded fair request queue; every evaluation cell has exactly one Job activation. */
export function dispatchEvaluationRequestInTransaction(
  database: DatabaseSync,
  input: { repositoryId: string; reviewRunId: string; requestId: string },
  now: string,
): ValidationDispatchResult {
  assertTransaction(database, now);
  const cell = readEvaluationExecutionCellInTransaction(
    database,
    { repositoryId: input.repositoryId, runId: input.reviewRunId },
    now,
  );
  if (!cell || cell.requestId !== input.requestId) notFound();
  const result: ValidationDispatchResult = {
    repositoryId: cell.repositoryId,
    reviewRunId: cell.runId,
    createdJobs: [],
    blockedRequests: [],
    alreadyAssociatedRequestIds: [],
  };
  const scope = { repositoryId: cell.repositoryId, id: cell.runId };
  if (cell.jobs.length > 0) {
    result.alreadyAssociatedRequestIds.push(cell.requestId);
    recordCheck(database, scope, cell.requestId, [], now, false);
    return result;
  }
  if (!cell.applicable || cell.controlStatus !== "active" || !cell.repositoryEnabled) {
    recordCheck(
      database,
      scope,
      cell.requestId,
      [{ code: "authorization_changed" }],
      now,
      cell.applicable && cell.controlStatus === "active",
    );
    return result;
  }
  const readiness = evaluateEvaluationRunReadiness(cell.plan, [])[0];
  if (!readiness) conflict("The evaluation request readiness is missing.");
  const reasons = readiness.reasons.filter((reason) => reason.code !== "unsupported_target");
  if (cell.reproductionReadiness.state === "blocked")
    reasons.push({ code: "reproduction_mapping_blocked" });
  recordCheck(database, scope, cell.requestId, reasons, now, reasons.length > 0);
  if (reasons.length > 0) result.blockedRequests.push({ requestId: cell.requestId, reasons });
  else {
    result.createdJobs.push(insertEvaluationJob(database, cell, now));
    appendAudit(
      database,
      { repositoryId: cell.repositoryId, reviewRunId: cell.runId, actor: backgroundActor },
      "dispatch",
      result,
      now,
    );
  }
  return result;
}

export function dispatchReviewRunInTransaction(
  database: DatabaseSync,
  input: ValidationDispatchOperationMap["dispatchReviewRun"]["input"],
  now: string,
): ValidationDispatchResult {
  assertTransaction(database, now);
  validActor(input.actor);
  const result = dispatchSelected(database, readRun(database, input, now), input.actor, now);
  appendAudit(database, input, "dispatch", result, now);
  return result;
}

export function dispatchPendingReviewRunsInTransaction(
  database: DatabaseSync,
  input: ValidationDispatchOperationMap["dispatchPendingReviewRuns"]["input"],
  now: string,
): ValidationDispatchOperationMap["dispatchPendingReviewRuns"]["output"] {
  assertTransaction(database, now);
  const limit = input.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumValidationDispatchBatchSize)
    invalid(`Dispatch limit must be between 1 and ${maximumValidationDispatchBatchSize}.`);
  const state = database
    .prepare(
      "SELECT sequence, last_repository_id FROM validation_dispatch_state WHERE singleton = 1",
    )
    .get() as { sequence: number; last_repository_id: string | null } | undefined;
  if (!state) conflict("The validation dispatch cursor is missing.");
  const result = {
    examinedRequestCount: 0,
    createdJobs: [] as (RunScope & ValidationDispatchedJob)[],
    blockedRequestCount: 0,
  };
  let lastRepositoryId = state.last_repository_id;
  for (let visited = 0; visited < limit; visited += 1) {
    const repositoryId = nextPendingRepository(database, lastRepositoryId, state.sequence);
    if (repositoryId === null) break;
    lastRepositoryId = repositoryId;
    const candidate = database
      .prepare(`SELECT checked.review_run_id, checked.request_id, json_extract(run.plan_json, '$.schemaVersion') AS plan_schema
      FROM validation_dispatch_checks AS checked JOIN review_runs AS run ON run.id = checked.review_run_id
      WHERE checked.repository_id = ? AND checked.pending = 1 AND checked.last_sequence <= ?
      ORDER BY checked.last_sequence, checked.review_run_id, checked.request_id LIMIT 1`)
      .get(repositoryId, state.sequence) as
      | { review_run_id: string; request_id: string; plan_schema: string }
      | undefined;
    if (!candidate) conflict("The pending validation candidate disappeared.");
    const scope = {
      repositoryId,
      reviewRunId: candidate.review_run_id,
      actor: backgroundActor,
    };
    if (candidate.plan_schema === "ReviewRunExecutionPlanV2") {
      const dispatched = dispatchEvaluationRequestInTransaction(
        database,
        { ...scope, requestId: candidate.request_id },
        now,
      );
      result.examinedRequestCount += 1;
      result.blockedRequestCount += dispatched.blockedRequests.length;
      result.createdJobs.push(
        ...dispatched.createdJobs.map((job) => ({
          repositoryId: scope.repositoryId,
          reviewRunId: scope.reviewRunId,
          ...job,
        })),
      );
      continue;
    }
    const run = readRun(database, scope, now);
    result.examinedRequestCount += 1;
    if (run.requests.find((entry) => entry.requestId === candidate.request_id)?.jobs.length) {
      recordCheck(database, run, candidate.request_id, [], now, false);
      continue;
    }
    let blocker: DispatchCheckReason | null = null;
    let retainPending = false;
    try {
      assertCurrentAuthorization(database, run);
    } catch (error) {
      if (!(error instanceof ValidationDispatchError) || error.code !== "PLATFORM_CONFLICT")
        throw error;
      blocker = { code: "authorization_changed" };
      retainPending = error.retainPending;
    }
    if (
      run.requests.reduce((count, request) => count + request.jobs.length, 0) >=
      maximumReviewRunJobAssociationCount
    ) {
      blocker = { code: "job_association_limit" };
      retainPending = false;
    }
    if (blocker !== null) {
      recordCheck(database, run, candidate.request_id, [blocker], now, retainPending);
      result.blockedRequestCount += 1;
      continue;
    }
    const dispatched = dispatchSelected(
      database,
      run,
      backgroundActor,
      now,
      new Set([candidate.request_id]),
    );
    result.blockedRequestCount += dispatched.blockedRequests.length;
    result.createdJobs.push(
      ...dispatched.createdJobs.map((job) => ({
        repositoryId: scope.repositoryId,
        reviewRunId: scope.reviewRunId,
        ...job,
      })),
    );
    if (dispatched.createdJobs.length > 0)
      appendAudit(database, scope, "dispatch", dispatched, now);
  }
  return result;
}

function nextPendingRepository(
  database: DatabaseSync,
  afterRepositoryId: string | null,
  throughSequence: number,
): string | null {
  const read = (after: string | null) => {
    const statement = database.prepare(`SELECT repository.id
    FROM managed_repositories AS repository
    WHERE repository.enabled = 1 ${after === null ? "" : "AND repository.id > ?"}
      AND EXISTS (SELECT 1 FROM validation_dispatch_checks AS checked
        WHERE checked.repository_id = repository.id AND checked.pending = 1
          AND checked.last_sequence <= ?)
    ORDER BY repository.id LIMIT 1`);
    return (
      after === null ? statement.get(throughSequence) : statement.get(after, throughSequence)
    ) as { id: string } | undefined;
  };
  return (
    (read(afterRepositoryId) ?? (afterRepositoryId === null ? undefined : read(null)))?.id ?? null
  );
}

export function rerunValidationRequestInTransaction(
  database: DatabaseSync,
  input: ValidationDispatchOperationMap["rerunValidationRequest"]["input"],
  now: string,
): RerunResult {
  assertTransaction(database, now);
  validActor(input.actor);
  validId(input.requestId);
  validId(input.activationId);
  const run = readRun(database, input, now);
  const prior = database
    .prepare(`SELECT intent_digest, result_json FROM validation_control_audit
    WHERE action = 'rerun' AND review_run_id = ? AND request_id = ? AND activation_id = ?`)
    .get(run.id, input.requestId, input.activationId) as
    | { intent_digest: string; result_json: string }
    | undefined;
  if (prior) {
    if (prior.intent_digest !== controlIntentDigest("rerun", input))
      conflict("This rerun activation belongs to another intent or operator.");
    const stored = JSON.parse(prior.result_json) as RerunResult;
    if (
      stored.repositoryId !== input.repositoryId ||
      stored.reviewRunId !== input.reviewRunId ||
      stored.requestId !== input.requestId ||
      !Value.Check(EntityIdSchema, stored.jobId) ||
      !Number.isSafeInteger(stored.jobActivation) ||
      stored.jobActivation < 2 ||
      stored.replayed !== false
    )
      conflict("The recorded rerun receipt is inconsistent.");
    return { ...stored, replayed: true };
  }
  assertCurrentAuthorization(database, run);
  const request = run.plan.jobs.find((entry) => entry.requestId === input.requestId);
  if (!request) notFound();
  const associated = run.requests.find((entry) => entry.requestId === input.requestId);
  if (!associated || associated.jobs.length === 0)
    conflict("Dispatch the initial request before creating a rerun.");
  const active = database
    .prepare(`SELECT job.id FROM review_run_job_links AS link JOIN jobs AS job ON job.id = link.job_id
    WHERE link.review_run_id = ? AND link.request_id = ? AND job.status IN ('queued', 'retry_waiting', 'leased', 'running', 'cancel_requested') LIMIT 1`)
    .get(run.id, input.requestId);
  if (active) conflict("The validation request still has an active job.");
  const readiness = evaluateReviewRunStructuralReadiness(run.plan).find(
    (entry) => entry.requestId === input.requestId,
  );
  if (readiness?.state !== "ready")
    conflict("The validation request has unresolved execution prerequisites.");
  const nextActivation = Math.max(...associated.jobs.map((job) => job.activationNumber)) + 1;
  const job = insertJob(database, run, request, nextActivation, input.actor, now);
  const result: RerunResult = {
    repositoryId: run.repositoryId,
    reviewRunId: run.id,
    ...job,
    replayed: false,
  };
  appendAudit(database, input, "rerun", result, now, input.requestId, input.activationId);
  return result;
}

export function cancelValidationJobInTransaction(
  database: DatabaseSync,
  input: ValidationDispatchOperationMap["cancelValidationJob"]["input"],
  now: string,
): CancelResult {
  return cancelScopedValidationJobInTransaction(database, input, now, "ReviewRunExecutionPlanV1");
}

/** Internal only: evaluation-control supplies configure permission, CAS and its batch receipt. */
export function cancelEvaluationJobInTransaction(
  database: DatabaseSync,
  input: ValidationDispatchOperationMap["cancelValidationJob"]["input"],
  now: string,
): CancelResult {
  return cancelScopedValidationJobInTransaction(database, input, now, "ReviewRunExecutionPlanV2");
}

function cancelScopedValidationJobInTransaction(
  database: DatabaseSync,
  input: ValidationDispatchOperationMap["cancelValidationJob"]["input"],
  now: string,
  planSchema: "ReviewRunExecutionPlanV1" | "ReviewRunExecutionPlanV2",
): CancelResult {
  assertTransaction(database, now);
  validActor(input.actor);
  validId(input.repositoryId);
  validId(input.reviewRunId);
  validId(input.requestId);
  validId(input.jobId);
  const job = database
    .prepare(`SELECT job.status, job.current_run_attempt_id FROM review_runs AS run
    JOIN review_run_job_links AS link ON link.review_run_id = run.id JOIN jobs AS job ON job.id = link.job_id
    WHERE run.repository_id = ? AND run.id = ? AND link.request_id = ? AND job.id = ?
      AND json_extract(run.plan_json, '$.schemaVersion') = ?`)
    .get(input.repositoryId, input.reviewRunId, input.requestId, input.jobId, planSchema) as
    | { status: JobState; current_run_attempt_id: string | null }
    | undefined;
  if (!job) notFound();
  let next = job.status;
  if (job.status === "queued" || job.status === "retry_waiting") {
    if (job.current_run_attempt_id !== null)
      conflict("The queued validation job has an unexpected lease.");
    database
      .prepare(`UPDATE jobs SET status = 'cancelled', current_step = NULL, completed_at = ?,
      cancellation_requested_at = COALESCE(cancellation_requested_at, ?), failure_code = 'operator_cancelled',
      failure_message = 'An operator cancelled this validation job.', updated_at = ? WHERE id = ?`)
      .run(now, now, now, input.jobId);
    next = "cancelled";
  } else if (job.status === "leased" || job.status === "running") {
    if (job.current_run_attempt_id === null) conflict("The active validation job has no lease.");
    database
      .prepare(`UPDATE jobs SET status = 'cancel_requested', cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
      failure_code = 'operator_cancelled', failure_message = 'An operator requested validation cancellation.', updated_at = ? WHERE id = ?`)
      .run(now, now, input.jobId);
    next = "cancel_requested";
  }
  const result: CancelResult = {
    repositoryId: input.repositoryId,
    reviewRunId: input.reviewRunId,
    requestId: input.requestId,
    jobId: input.jobId,
    jobState: next,
    changed: next !== job.status,
  };
  appendAudit(database, input, "cancel", result, now, input.requestId);
  return result;
}

export function isValidationDispatchOperation(
  operation: string,
): operation is ValidationDispatchOperation {
  return (
    operation === "dispatchReviewRun" ||
    operation === "dispatchPendingReviewRuns" ||
    operation === "rerunValidationRequest" ||
    operation === "cancelValidationJob"
  );
}

export function handleValidationDispatchRequest(
  database: DatabaseSync,
  request: ValidationDispatchRequest,
  now: string,
): unknown {
  return transaction(database, () => {
    switch (request.operation) {
      case "dispatchReviewRun":
        return dispatchReviewRunInTransaction(database, request.input, now);
      case "dispatchPendingReviewRuns":
        return dispatchPendingReviewRunsInTransaction(database, request.input, now);
      case "rerunValidationRequest":
        return rerunValidationRequestInTransaction(database, request.input, now);
      case "cancelValidationJob":
        return cancelValidationJobInTransaction(database, request.input, now);
    }
  });
}
