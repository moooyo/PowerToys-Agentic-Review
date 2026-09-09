import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { verifyModelInvocationSubmission } from "@agentic-review/domain";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { readEvaluationJobBindingInTransaction } from "./evaluation-execution.js";
import { readBoundValidationSummaryInputInTransaction } from "./validation-summary-inputs.js";

export interface ModelInvocationOperationMap {
  beginModelInvocation: {
    input: { readonly workerTokenSha256: string; readonly request: C.ModelInvocationBeginRequest };
    output: C.ModelInvocationOpening;
  };
  sealModelInvocation: {
    input: { readonly workerTokenSha256: string; readonly request: C.ModelInvocationSealRequest };
    output: C.ModelInvocationSealV1;
  };
  submitModelInvocationReceipts: {
    input: { readonly workerTokenSha256: string; readonly request: C.ModelInvocationSubmitRequest };
    output: C.ModelInvocationSubmissionV1;
  };
}
export type ModelInvocationOperation = keyof ModelInvocationOperationMap;
export type ModelInvocationRequest = {
  [K in ModelInvocationOperation]: {
    readonly operation: K;
    readonly input: ModelInvocationOperationMap[K]["input"];
  };
}[ModelInvocationOperation];
const schemas = {
  beginModelInvocation: C.ModelInvocationBeginRequestSchema,
  sealModelInvocation: C.ModelInvocationSealRequestSchema,
  submitModelInvocationReceipts: C.ModelInvocationSubmitRequestSchema,
};
const issues = {
  beginModelInvocation: C.getModelInvocationBeginRequestIssues,
  sealModelInvocation: C.getModelInvocationSealRequestIssues,
  submitModelInvocationReceipts: C.getModelInvocationSubmitRequestIssues,
};
const hashPattern = /^[a-f0-9]{64}(?![\s\S])/u;
export function isModelInvocationOperation(
  operation: string,
): operation is ModelInvocationOperation {
  return Object.hasOwn(schemas, operation);
}
export class ModelInvocationError extends Error {
  constructor(
    readonly code:
      | "MODEL_INVOCATION_INVALID"
      | "MODEL_INVOCATION_NOT_FOUND"
      | "MODEL_INVOCATION_CONFLICT"
      | "MODEL_INVOCATION_CORRUPT"
      | "MODEL_INVOCATION_LEASE_REJECTED"
      | "WORKER_TOKEN_REJECTED"
      | "DATABASE_READ_ONLY",
  ) {
    super(
      code === "WORKER_TOKEN_REJECTED"
        ? "The current Worker credential was rejected."
        : code === "MODEL_INVOCATION_LEASE_REJECTED"
          ? "The model invocation lease was rejected."
          : code === "MODEL_INVOCATION_NOT_FOUND"
            ? "The model invocation opening was not found."
            : code === "MODEL_INVOCATION_CONFLICT"
              ? "The model invocation conflicts with an existing immutable record."
              : code === "MODEL_INVOCATION_CORRUPT"
                ? "The stored model invocation is inconsistent."
                : code === "DATABASE_READ_ONLY"
                  ? "New model invocation records are unavailable during recovery maintenance."
                  : "The model invocation request is invalid.",
    );
    this.name = "ModelInvocationError";
  }
}
function fail(code: ModelInvocationError["code"]): never {
  throw new ModelInvocationError(code);
}
function timestamp(value: string, stored = false): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    fail(stored ? "MODEL_INVOCATION_CORRUPT" : "MODEL_INVOCATION_INVALID");
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function secretHashMatches(left: string, right: string): boolean {
  return (
    hashPattern.test(left) &&
    hashPattern.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}
function checked<T>(value: T, validate: (value: unknown) => string[]): T {
  if (validate(value).length) fail("MODEL_INVOCATION_CORRUPT");
  return value;
}
function decode<T>(
  json: string | null,
  digest: string,
  maximum: number,
  validate: (value: unknown) => string[],
): T {
  if (json === null || Buffer.byteLength(json) > maximum) fail("MODEL_INVOCATION_CORRUPT");
  let value: T;
  try {
    value = JSON.parse(json) as T;
  } catch {
    return fail("MODEL_INVOCATION_CORRUPT");
  }
  checked(value, validate);
  if (canonicalJson(value) !== json || sha256(json) !== digest) fail("MODEL_INVOCATION_CORRUPT");
  return value;
}
function transaction<T>(database: DatabaseSync, readOnly: boolean, work: () => T): T {
  const outer = database.isTransaction;
  if (outer && readOnly) return work();
  const savepoint = `model_invocation_${randomUUID().replaceAll("-", "")}`;
  database.exec(outer ? `SAVEPOINT ${savepoint}` : readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
  try {
    const value = work();
    database.exec(outer ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return value;
  } catch (error) {
    if (outer) {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else database.exec("ROLLBACK");
    throw error;
  }
}

interface AttemptRow {
  id: string;
  job_id: string;
  worker_node_id: string;
  worker_instance_id: string;
  lease_generation: number;
  lease_token_hash: string;
  status: string;
  lease_expires_at: string;
  execution_deadline_at: string;
  no_progress_deadline_at: string;
  started_at: string;
  job_status: string;
  current_run_attempt_id: string | null;
  job_lease_generation: number;
  cancellation_requested_at: string | null;
  execution_json: string | null;
  execution_digest: string;
  worker_status: string;
  superseded_at: string | null;
  actual_worker_node_id: string;
  actual_worker_instance_id: string;
}
interface OpeningRow {
  invocation_id: string;
  run_attempt_id: string;
  job_id: string;
  worker_node_id: string;
  worker_instance_id: string;
  lease_generation: number;
  scope_sha256: string;
  opening_json: string | null;
  opening_sha256: string;
  begin_intent_sha256: string;
  opened_at: string;
}
interface SealRow {
  invocation_id: string;
  scope_sha256: string;
  receipt_set_sha256: string;
  seal_json: string | null;
  seal_sha256: string;
  seal_intent_sha256: string;
  recorded_at: string;
}
interface SubmissionRow {
  invocation_id: string;
  scope_sha256: string;
  receipt_set_sha256: string;
  receipt_set_json: string | null;
  response_json: string | null;
  response_sha256: string;
  submit_intent_sha256: string;
  received_at: string;
}
const controlLimit = C.maximumModelInvocationControlRequestUtf8Bytes;
const openingColumns = `invocation_id, run_attempt_id, job_id, worker_node_id, worker_instance_id, lease_generation,
  scope_sha256, opening_sha256, begin_intent_sha256, opened_at,
  CASE WHEN length(CAST(opening_json AS BLOB)) <= ${controlLimit} THEN opening_json END AS opening_json`;
const sealColumns = `invocation_id, scope_sha256, receipt_set_sha256, seal_sha256, seal_intent_sha256, recorded_at,
  CASE WHEN length(CAST(seal_json AS BLOB)) <= ${controlLimit} THEN seal_json END AS seal_json`;
function authenticate(
  database: DatabaseSync,
  workerTokenSha256: string,
  lease: C.LeaseIdentity,
): AttemptRow {
  const credential = database
    .prepare(
      "SELECT worker_node_id FROM worker_node_credentials WHERE token_sha256 = ? AND auth_state = 'active'",
    )
    .get(workerTokenSha256) as { worker_node_id: string } | undefined;
  if (!credential || credential.worker_node_id !== lease.workerNodeId)
    fail("WORKER_TOKEN_REJECTED");
  const row = readAttempt(database, lease.runAttemptId);
  if (
    !row ||
    row.job_id !== lease.jobId ||
    row.worker_node_id !== lease.workerNodeId ||
    row.worker_instance_id !== lease.workerInstanceId ||
    row.lease_generation !== lease.leaseGeneration ||
    !secretHashMatches(sha256(lease.leaseToken), row.lease_token_hash)
  )
    fail("MODEL_INVOCATION_LEASE_REJECTED");
  if (
    row.actual_worker_node_id !== row.worker_node_id ||
    row.actual_worker_instance_id !== row.worker_instance_id
  )
    fail("MODEL_INVOCATION_CORRUPT");
  return row;
}
function readAttempt(database: DatabaseSync, attemptId: string): AttemptRow | undefined {
  return database
    .prepare(`SELECT attempt.id, attempt.job_id, attempt.worker_node_id, attempt.worker_instance_id,
    attempt.lease_generation, attempt.lease_token_hash, attempt.status, attempt.lease_expires_at,
    attempt.execution_deadline_at, attempt.no_progress_deadline_at, attempt.started_at,
    job.status AS job_status, job.current_run_attempt_id, job.lease_generation AS job_lease_generation,
    job.cancellation_requested_at, job.execution_digest,
    CASE WHEN length(CAST(job.execution_json AS BLOB)) <= ${C.maximumReviewRunPlanUtf8Bytes} THEN job.execution_json END AS execution_json,
    worker.node_id AS actual_worker_node_id, worker.instance_id AS actual_worker_instance_id,
    worker.status AS worker_status, worker.superseded_at
    FROM run_attempts AS attempt JOIN jobs AS job ON job.id = attempt.job_id
    JOIN workers AS worker ON worker.id = attempt.worker_id WHERE attempt.id = ?`)
    .get(attemptId) as AttemptRow | undefined;
}
function binding(database: DatabaseSync, attempt: AttemptRow, now?: string) {
  if (attempt.execution_json === null) fail("MODEL_INVOCATION_CORRUPT");
  let template: unknown;
  try {
    template = JSON.parse(attempt.execution_json);
  } catch {
    return fail("MODEL_INVOCATION_CORRUPT");
  }
  if (
    !Value.Check(C.JobExecutionTemplateV2Schema, template) ||
    template.validation.schemaVersion !== "ValidationJobContextV2"
  )
    fail("MODEL_INVOCATION_LEASE_REJECTED");
  if (
    canonicalJson(template) !== attempt.execution_json ||
    sha256(attempt.execution_json) !== attempt.execution_digest
  )
    fail("MODEL_INVOCATION_CORRUPT");
  const cell = readEvaluationJobBindingInTransaction(database, attempt.job_id, template, now);
  const registration = cell.plan.modelRuntimeRegistration;
  if (
    !cell.plan.modelRequirements.required ||
    !registration ||
    !cell.plan.modelRequirements.runtimeRegistration
  )
    fail("MODEL_INVOCATION_LEASE_REJECTED");
  return { cell, registration };
}
type Binding = ReturnType<typeof binding>;
function active(attempt: AttemptRow, frozen: Binding, now: string): void {
  for (const date of [
    attempt.lease_expires_at,
    attempt.execution_deadline_at,
    attempt.no_progress_deadline_at,
    attempt.started_at,
  ])
    timestamp(date, true);
  if (
    !frozen.cell.applicable ||
    !frozen.cell.repositoryEnabled ||
    frozen.cell.controlStatus !== "active" ||
    frozen.cell.reproductionReadiness.state === "blocked" ||
    !["leased", "running"].includes(attempt.status) ||
    !["leased", "running"].includes(attempt.job_status) ||
    !["online", "draining"].includes(attempt.worker_status) ||
    attempt.superseded_at !== null ||
    attempt.cancellation_requested_at !== null ||
    attempt.current_run_attempt_id !== attempt.id ||
    attempt.job_lease_generation !== attempt.lease_generation ||
    attempt.lease_expires_at <= now ||
    attempt.execution_deadline_at <= now ||
    attempt.no_progress_deadline_at <= now ||
    attempt.started_at > now
  )
    fail("MODEL_INVOCATION_LEASE_REJECTED");
}
/** Shared owner preflight; callers still decide exact replay before requiring an active lease. */
export function readModelInvocationAttemptInTransaction(
  database: DatabaseSync,
  input: { readonly workerTokenSha256: string; readonly lease: C.LeaseIdentity },
  now: string,
) {
  if (!database.isTransaction) fail("MODEL_INVOCATION_INVALID");
  timestamp(now);
  const attempt = authenticate(database, input.workerTokenSha256, input.lease);
  const frozen = binding(database, attempt, now);
  return { attempt, frozen };
}
export function assertActiveModelInvocationAttempt(
  value: ReturnType<typeof readModelInvocationAttemptInTransaction>,
  now: string,
): void {
  active(value.attempt, value.frozen, now);
}
function scope(
  attempt: AttemptRow,
  frozen: Binding,
  invocationId: string,
): C.ModelInvocationScopeV1 {
  const { cell, registration } = frozen;
  return checked(
    {
      schemaVersion: "ModelInvocationScopeV1",
      repositoryId: cell.repositoryId,
      evaluationId: cell.evaluationId,
      cellId: cell.cellId,
      runId: cell.runId,
      requestId: cell.requestId,
      jobId: attempt.job_id,
      attemptId: attempt.id,
      invocationId,
      authorizationId: cell.plan.authorization.id,
      executionManifestSha256: cell.plan.purpose.executionManifestSha256,
      promptSha256: cell.prompt.promptSha256,
      outputSchemaSha256: cell.prompt.outputSchemaSha256,
      expectedModelIdentitySha256: registration.identitySha256,
      requestedModel: registration.requestedModel,
      workerNodeId: attempt.worker_node_id,
      workerInstanceId: attempt.worker_instance_id,
      leaseGeneration: attempt.lease_generation,
    } as C.ModelInvocationScopeV1,
    C.getModelInvocationScopeIssues,
  );
}
function intent(request: ModelInvocationRequest): string {
  const { lease, ...payload } = request.input.request;
  const { leaseToken, ...identity } = lease;
  return sha256(
    canonicalJson({
      operation: request.operation,
      request: { ...payload, lease: { ...identity, leaseTokenSha256: sha256(leaseToken) } },
    }),
  );
}
function opening(
  database: DatabaseSync,
  row: OpeningRow,
  attempt: AttemptRow,
  frozen: Binding,
): C.ModelInvocationOpening {
  const value = decode<C.ModelInvocationOpening>(
    row.opening_json,
    row.opening_sha256,
    controlLimit,
    C.getModelInvocationOpeningIssues,
  );
  if (
    row.run_attempt_id !== attempt.id ||
    row.job_id !== attempt.job_id ||
    row.worker_node_id !== attempt.worker_node_id ||
    row.worker_instance_id !== attempt.worker_instance_id ||
    row.lease_generation !== attempt.lease_generation
  )
    fail("MODEL_INVOCATION_LEASE_REJECTED");
  timestamp(row.opened_at, true);
  let expected: C.ModelInvocationScope = scope(attempt, frozen, row.invocation_id);
  if (value.scope.schemaVersion === "ModelInvocationScopeV2") {
    readBoundValidationSummaryInputInTransaction(
      database,
      value.scope.inputRef,
      { attempt, frozen },
      value.openedAt,
    );
    expected = {
      ...expected,
      schemaVersion: "ModelInvocationScopeV2",
      purpose: "validation_summary",
      inputRef: value.scope.inputRef,
    };
  }
  if (
    row.invocation_id !== value.scope.invocationId ||
    row.opened_at !== value.openedAt ||
    row.scope_sha256 !== value.scopeSha256 ||
    sha256(canonicalJson(value.scope)) !== row.scope_sha256 ||
    !equal(value.scope, expected)
  )
    fail("MODEL_INVOCATION_CORRUPT");
  return value;
}
function seal(row: SealRow, opened: C.ModelInvocationOpening): C.ModelInvocationSealV1 {
  const value = decode<C.ModelInvocationSealV1>(
    row.seal_json,
    row.seal_sha256,
    controlLimit,
    C.getModelInvocationSealIssues,
  );
  timestamp(row.recorded_at, true);
  if (
    row.invocation_id !== opened.scope.invocationId ||
    value.invocationId !== row.invocation_id ||
    row.scope_sha256 !== opened.scopeSha256 ||
    value.scopeSha256 !== row.scope_sha256 ||
    row.receipt_set_sha256 !== value.receiptSetSha256 ||
    row.recorded_at !== value.recordedAt ||
    row.recorded_at < opened.openedAt
  )
    fail("MODEL_INVOCATION_CORRUPT");
  return value;
}
function outerMatches(
  set: C.ModelInvocationReceiptSet,
  opened: C.ModelInvocationOpening,
  closed: C.ModelInvocationSealV1,
): boolean {
  return (
    (opened.schemaVersion === "ModelInvocationOpeningV2"
      ? set.schemaVersion === "ModelInvocationReceiptSetV2"
      : set.schemaVersion === "ModelInvocationReceiptSetV1") &&
    sha256(canonicalJson(set)) === closed.receiptSetSha256 &&
    equal(set.scope, opened.scope) &&
    set.scopeSha256 === opened.scopeSha256 &&
    sha256(canonicalJson(set.scope)) === opened.scopeSha256 &&
    equal(set.runtime, opened.runtime) &&
    set.closedAt === closed.closedAt &&
    set.state === closed.state &&
    set.calls.length === closed.callCount &&
    (set.calls.at(-1)?.sha256 ?? null) === closed.lastReceiptSha256 &&
    set.modelOutputSha256 === closed.modelOutputSha256 &&
    set.observedIdentitySha256 === closed.observedIdentitySha256
  );
}
function submission(
  row: SubmissionRow,
  opened: C.ModelInvocationOpening,
  closed: C.ModelInvocationSealV1,
  frozen: Binding,
  observe?: (set: C.ModelInvocationReceiptSet) => void,
): C.ModelInvocationSubmissionV1 {
  const set = decode<C.ModelInvocationReceiptSet>(
    row.receipt_set_json,
    row.receipt_set_sha256,
    C.maximumModelRuntimeUtf8Bytes,
    C.getModelInvocationReceiptSetIssues,
  );
  const result = decode<C.ModelInvocationSubmissionV1>(
    row.response_json,
    row.response_sha256,
    controlLimit,
    C.getModelInvocationSubmissionIssues,
  );
  timestamp(row.received_at, true);
  if (
    row.invocation_id !== opened.scope.invocationId ||
    row.scope_sha256 !== opened.scopeSha256 ||
    !outerMatches(set, opened, closed) ||
    row.received_at < closed.recordedAt ||
    result.invocationId !== row.invocation_id ||
    result.scopeSha256 !== row.scope_sha256 ||
    result.receiptSetSha256 !== row.receipt_set_sha256 ||
    result.receivedAt !== row.received_at ||
    !equal(
      result.consistency,
      verifyModelInvocationSubmission({
        opening: opened,
        seal: closed,
        receiptSet: set,
        expectedIdentity: frozen.registration.identity,
      }),
    )
  )
    fail("MODEL_INVOCATION_CORRUPT");
  observe?.(set);
  return result;
}

function historicalIntent(
  operation: ModelInvocationOperation,
  payload: object,
  attempt: AttemptRow,
): string {
  if (!hashPattern.test(attempt.lease_token_hash)) fail("MODEL_INVOCATION_CORRUPT");
  return sha256(
    canonicalJson({
      operation,
      request: {
        ...payload,
        lease: {
          jobId: attempt.job_id,
          runAttemptId: attempt.id,
          workerNodeId: attempt.worker_node_id,
          workerInstanceId: attempt.worker_instance_id,
          leaseGeneration: attempt.lease_generation,
          leaseTokenSha256: attempt.lease_token_hash,
        },
      },
    }),
  );
}

/** Internal history read. The caller establishes current operator access in this same
 * synchronous transaction; expired leases, revoked Worker tokens and cancellation are history.
 * Omitting now validates historical content without asserting a current-clock upper bound. */
export function readModelInvocationHistoryInTransaction(
  database: DatabaseSync,
  input: {
    readonly repositoryId: string;
    readonly evaluationId: string;
    readonly cellId: string;
    readonly invocationId: string;
  },
  now?: string,
): C.EvaluationCellInvocationItem {
  if (!database.isTransaction) fail("MODEL_INVOCATION_CORRUPT");
  if (now !== undefined) timestamp(now);
  const row = database
    .prepare(`SELECT ${openingColumns} FROM model_invocation_openings WHERE invocation_id = ?`)
    .get(input.invocationId) as OpeningRow | undefined;
  if (!row) fail("MODEL_INVOCATION_CORRUPT");
  const attempt = readAttempt(database, row.run_attempt_id);
  if (
    !attempt ||
    attempt.actual_worker_node_id !== attempt.worker_node_id ||
    attempt.actual_worker_instance_id !== attempt.worker_instance_id
  )
    fail("MODEL_INVOCATION_CORRUPT");
  timestamp(attempt.started_at, true);
  const frozen = binding(database, attempt, now);
  if (
    frozen.cell.repositoryId !== input.repositoryId ||
    frozen.cell.evaluationId !== input.evaluationId ||
    frozen.cell.cellId !== input.cellId
  )
    fail("MODEL_INVOCATION_CORRUPT");
  const opened = opening(database, row, attempt, frozen);
  if (
    (now !== undefined && opened.openedAt > now) ||
    opened.openedAt < attempt.started_at ||
    row.begin_intent_sha256 !==
      historicalIntent(
        "beginModelInvocation",
        {
          invocationId: input.invocationId,
          runtime: opened.runtime,
          ...(opened.scope.schemaVersion === "ModelInvocationScopeV2"
            ? { summaryInput: opened.scope.inputRef }
            : {}),
        },
        attempt,
      )
  )
    fail("MODEL_INVOCATION_CORRUPT");
  const closureRow = database
    .prepare(`SELECT ${sealColumns} FROM model_invocation_seals WHERE invocation_id = ?`)
    .get(input.invocationId) as SealRow | undefined;
  const closed = closureRow ? seal(closureRow, opened) : null;
  if (closed && closureRow) {
    const { schemaVersion: _schemaVersion, recordedAt: _recordedAt, ...payload } = closed;
    if (
      (now !== undefined && closed.recordedAt > now) ||
      closureRow.seal_intent_sha256 !== historicalIntent("sealModelInvocation", payload, attempt)
    )
      fail("MODEL_INVOCATION_CORRUPT");
  }
  // Only one bounded ledger is materialized at a time; the returned item has counters only.
  const stored = database
    .prepare(`SELECT invocation_id, scope_sha256, receipt_set_sha256, response_sha256, submit_intent_sha256, received_at,
    CASE WHEN length(CAST(receipt_set_json AS BLOB)) <= ${C.maximumModelRuntimeUtf8Bytes} THEN receipt_set_json END AS receipt_set_json,
    CASE WHEN length(CAST(response_json AS BLOB)) <= ${controlLimit} THEN response_json END AS response_json
    FROM model_invocation_submissions WHERE invocation_id = ?`)
    .get(input.invocationId) as SubmissionRow | undefined;
  let callOutcomes: C.EvaluationCellInvocationCallOutcomes | null = null;
  let observedIdentity: C.ModelRuntimeIdentityV1 | null = null;
  let submitted: C.ModelInvocationSubmissionV1 | null = null;
  if (stored) {
    if (!closed) fail("MODEL_INVOCATION_CORRUPT");
    submitted = submission(stored, opened, closed, frozen, (set) => {
      if (
        stored.submit_intent_sha256 !==
        historicalIntent(
          "submitModelInvocationReceipts",
          { invocationId: input.invocationId, receiptSet: set },
          attempt,
        )
      )
        fail("MODEL_INVOCATION_CORRUPT");
      const counts: C.EvaluationCellInvocationCallOutcomes = {
        completed: 0,
        provider_failed: 0,
        provider_incomplete: 0,
        transport_failed: 0,
        cancelled: 0,
        protocol_invalid: 0,
        budget_exceeded: 0,
      };
      for (const call of set.calls) counts[call.receipt.outcome] += 1;
      callOutcomes = counts;
      observedIdentity = set.observedIdentity;
    });
    if (now !== undefined && submitted.receivedAt > now) fail("MODEL_INVOCATION_CORRUPT");
  }
  return {
    opening: opened,
    seal: closed,
    submission: submitted,
    callOutcomes,
    observedIdentity: submitted?.consistency.state === "invalid" ? null : observedIdentity,
  };
}

/** Authenticated observations are persisted independently; this API never grants execution acceptance. */
export function handleModelInvocationRequest(
  database: DatabaseSync,
  request: ModelInvocationRequest,
  now: string,
  options: { readonly readOnly?: boolean } = {},
): ModelInvocationOperationMap[ModelInvocationOperation]["output"] {
  if (
    !request ||
    !isModelInvocationOperation(request.operation) ||
    !Value.Check(
      Type.Object(
        { workerTokenSha256: C.Sha256Schema, request: schemas[request.operation] },
        { additionalProperties: false },
      ),
      request.input,
    ) ||
    issues[request.operation](request.input.request).length
  )
    fail("MODEL_INVOCATION_INVALID");
  timestamp(now);
  return transaction(database, options.readOnly === true, () => {
    const attempt = authenticate(
      database,
      request.input.workerTokenSha256,
      request.input.request.lease,
    );
    const frozen = binding(database, attempt, now);
    const digest = intent(request);
    const invocationId = request.input.request.invocationId;
    const row = database
      .prepare(`SELECT ${openingColumns} FROM model_invocation_openings WHERE invocation_id = ?`)
      .get(invocationId) as OpeningRow | undefined;
    if (request.operation === "beginModelInvocation") {
      if (row) {
        const value = opening(database, row, attempt, frozen);
        if (
          row.begin_intent_sha256 !== digest ||
          !equal(value.runtime, request.input.request.runtime)
        )
          fail("MODEL_INVOCATION_CONFLICT");
        return value;
      }
      if (
        database
          .prepare("SELECT 1 FROM model_invocation_openings WHERE run_attempt_id = ?")
          .get(attempt.id)
      )
        fail("MODEL_INVOCATION_CONFLICT");
      if (options.readOnly) fail("DATABASE_READ_ONLY");
      active(attempt, frozen, now);
      const original = scope(attempt, frozen, invocationId);
      const summary = ["pr_ui", "issue_validation"].includes(frozen.cell.request.workflowKind);
      const ref = request.input.request.summaryInput;
      if (summary !== (ref !== undefined)) fail("MODEL_INVOCATION_INVALID");
      if (ref !== undefined)
        readBoundValidationSummaryInputInTransaction(
          database,
          ref,
          { attempt, frozen },
          now,
          "request",
        );
      const derived: C.ModelInvocationScope =
        ref === undefined
          ? original
          : {
              ...original,
              schemaVersion: "ModelInvocationScopeV2",
              purpose: "validation_summary",
              inputRef: ref,
            };
      const value = checked(
        {
          schemaVersion:
            ref === undefined ? "ModelInvocationOpeningV1" : "ModelInvocationOpeningV2",
          scope: derived,
          scopeSha256: sha256(canonicalJson(derived)),
          runtime: request.input.request.runtime,
          openedAt: now,
        } as C.ModelInvocationOpening,
        C.getModelInvocationOpeningIssues,
      );
      const json = canonicalJson(value);
      database
        .prepare(`INSERT INTO model_invocation_openings
        (invocation_id, run_attempt_id, job_id, worker_node_id, worker_instance_id, lease_generation, scope_sha256,
        opening_json, opening_sha256, begin_intent_sha256, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          invocationId,
          attempt.id,
          attempt.job_id,
          attempt.worker_node_id,
          attempt.worker_instance_id,
          attempt.lease_generation,
          value.scopeSha256,
          json,
          sha256(json),
          digest,
          now,
        );
      return value;
    }
    if (!row) fail("MODEL_INVOCATION_NOT_FOUND");
    const opened = opening(database, row, attempt, frozen);
    const closureRow = database
      .prepare(`SELECT ${sealColumns} FROM model_invocation_seals WHERE invocation_id = ?`)
      .get(invocationId) as SealRow | undefined;
    if (request.operation === "sealModelInvocation") {
      if (closureRow) {
        const value = seal(closureRow, opened);
        if (closureRow.seal_intent_sha256 !== digest) fail("MODEL_INVOCATION_CONFLICT");
        return value;
      }
      if (options.readOnly) fail("DATABASE_READ_ONLY");
      active(attempt, frozen, now);
      if (request.input.request.scopeSha256 !== opened.scopeSha256 || now < opened.openedAt)
        fail("MODEL_INVOCATION_CONFLICT");
      const { lease: _lease, ...properties } = request.input.request;
      const value = checked(
        {
          schemaVersion: "ModelInvocationSealV1",
          ...properties,
          recordedAt: now,
        } as C.ModelInvocationSealV1,
        C.getModelInvocationSealIssues,
      );
      const json = canonicalJson(value);
      database
        .prepare(`INSERT INTO model_invocation_seals
        (invocation_id, scope_sha256, receipt_set_sha256, seal_json, seal_sha256, seal_intent_sha256, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          invocationId,
          opened.scopeSha256,
          value.receiptSetSha256,
          json,
          sha256(json),
          digest,
          now,
        );
      return value;
    }
    if (!closureRow) fail("MODEL_INVOCATION_CONFLICT");
    const closed = seal(closureRow, opened);
    const stored = database
      .prepare(`SELECT invocation_id, scope_sha256, receipt_set_sha256, response_sha256, submit_intent_sha256, received_at,
      CASE WHEN length(CAST(receipt_set_json AS BLOB)) <= ${C.maximumModelRuntimeUtf8Bytes} THEN receipt_set_json END AS receipt_set_json,
      CASE WHEN length(CAST(response_json AS BLOB)) <= ${controlLimit} THEN response_json END AS response_json
      FROM model_invocation_submissions WHERE invocation_id = ?`)
      .get(invocationId) as SubmissionRow | undefined;
    if (stored) {
      const value = submission(stored, opened, closed, frozen);
      if (stored.submit_intent_sha256 !== digest) fail("MODEL_INVOCATION_CONFLICT");
      return value;
    }
    if (options.readOnly) fail("DATABASE_READ_ONLY");
    active(attempt, frozen, now);
    const set = request.input.request.receiptSet;
    if (!outerMatches(set, opened, closed) || now < closed.recordedAt)
      fail("MODEL_INVOCATION_CONFLICT");
    const result = checked(
      {
        schemaVersion: "ModelInvocationSubmissionV1",
        invocationId,
        scopeSha256: opened.scopeSha256,
        receiptSetSha256: closed.receiptSetSha256,
        receivedAt: now,
        executionAccepted: false,
        consistency: verifyModelInvocationSubmission({
          opening: opened,
          seal: closed,
          receiptSet: set,
          expectedIdentity: frozen.registration.identity,
        }),
      } as C.ModelInvocationSubmissionV1,
      C.getModelInvocationSubmissionIssues,
    );
    const json = canonicalJson(result);
    database
      .prepare(`INSERT INTO model_invocation_submissions
      (invocation_id, scope_sha256, receipt_set_sha256, receipt_set_json, response_json, response_sha256, submit_intent_sha256, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        invocationId,
        opened.scopeSha256,
        closed.receiptSetSha256,
        canonicalJson(set),
        json,
        sha256(json),
        digest,
        now,
      );
    return result;
  });
}
