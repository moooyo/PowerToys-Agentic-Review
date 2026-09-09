import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type DashboardValidationPolicy,
  DashboardValidationPolicyReasonSchema,
  DashboardValidationPolicySchema,
  EntityIdSchema,
  maximumReviewRunDecisionRequestUtf8Bytes,
  maximumReviewRunDecisionResponseUtf8Bytes,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  type ReviewRunDecisionChangeRequest,
  ReviewRunDecisionChangeRequestSchema,
  type ReviewRunDecisionChangeResponse,
  ReviewRunDecisionChangeResponseSchema,
  type ReviewRunDecisionContext,
  ReviewRunDecisionContextSchema,
  type ReviewRunDecisionEvent,
  ReviewRunDecisionEventSchema,
  type ReviewRunDecisionHistoryResponse,
  ReviewRunDecisionHistoryResponseSchema,
  type ReviewRunDecisionPolicySnapshot,
} from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { assertRepositoryPermission } from "./operator-access.js";
import {
  type ReviewRunDecisionSnapshot,
  ReviewRunDecisionSnapshotV2Schema,
  readReviewRunDecisionSnapshotInTransaction,
} from "./review-run-decision-snapshot.js";
import {
  readVerifiedReviewRunDetailInTransaction,
  type VerifiedReviewRunEvidenceFacts,
} from "./review-run-queries.js";

interface Scope {
  readonly repositoryId: string;
  readonly reviewRunId: string;
  readonly actor: OperatorPrincipal;
}
type ChangeInput = Scope & ReviewRunDecisionChangeRequest;
export interface ReviewRunDecisionOperationMap {
  getReviewRunDecisionContext: { input: Scope; output: ReviewRunDecisionContext };
  listReviewRunDecisionHistory: {
    input: Scope & { readonly page?: number; readonly pageSize?: number };
    output: ReviewRunDecisionHistoryResponse;
  };
  changeReviewRunDecision: { input: ChangeInput; output: ReviewRunDecisionChangeResponse };
}
export type ReviewRunDecisionOperation = keyof ReviewRunDecisionOperationMap;
export type ReviewRunDecisionRequest = {
  [K in ReviewRunDecisionOperation]: {
    readonly operation: K;
    readonly input: ReviewRunDecisionOperationMap[K]["input"];
  };
}[ReviewRunDecisionOperation];

class ReviewRunDecisionError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_INVALID"
      | "PLATFORM_NOT_FOUND"
      | "PLATFORM_CONFLICT"
      | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "ReviewRunDecisionError";
  }
}
function invalid(message: string): never {
  throw new ReviewRunDecisionError("PLATFORM_INVALID", message);
}
function conflict(message: string): never {
  throw new ReviewRunDecisionError("PLATFORM_CONFLICT", message);
}
function corrupt(): never {
  throw new ReviewRunDecisionError(
    "PLATFORM_CORRUPT",
    "The stored review run decision is invalid.",
  );
}
function notFound(): never {
  throw new ReviewRunDecisionError("PLATFORM_NOT_FOUND", "The review run was not found.");
}
const scopeProperties = {
  repositoryId: EntityIdSchema,
  reviewRunId: EntityIdSchema,
  actor: OperatorPrincipalSchema,
};
const inputSchemas = {
  getReviewRunDecisionContext: Type.Object(scopeProperties, { additionalProperties: false }),
  listReviewRunDecisionHistory: Type.Object(
    {
      ...scopeProperties,
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    },
    { additionalProperties: false },
  ),
  changeReviewRunDecision: Type.Union(
    ReviewRunDecisionChangeRequestSchema.anyOf.map((schema) =>
      Type.Object({ ...scopeProperties, ...schema.properties }, { additionalProperties: false }),
    ),
  ),
};
const fullPolicySchema = Type.Union(
  DashboardValidationPolicySchema.anyOf.map((schema) =>
    Type.Object(
      {
        ...schema.properties,
        reasons: Type.Array(DashboardValidationPolicyReasonSchema, { maxItems: 131_072 }),
        reasonsTruncated: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  ),
);
export function isReviewRunDecisionOperation(
  operation: string,
): operation is ReviewRunDecisionOperation {
  return Object.hasOwn(inputSchemas, operation);
}

function validateInput(operation: ReviewRunDecisionOperation, input: unknown): void {
  if (!Value.Check(inputSchemas[operation], input))
    invalid("The review run decision request is invalid.");
}
function normalizeChange(input: ChangeInput): ChangeInput {
  validateInput("changeReviewRunDecision", input);
  // Validate the submitted bytes before normalization. Control characters cannot hide in trim.
  if (
    Buffer.byteLength(JSON.stringify(input), "utf8") > maximumReviewRunDecisionRequestUtf8Bytes ||
    !input.reason.isWellFormed() ||
    containsForbiddenControls(input.reason) ||
    !input.reason.trim()
  )
    invalid("A bounded, nonempty decision reason without control characters is required.");
  return { ...input, actor: { ...input.actor }, reason: input.reason.trim() };
}
function containsForbiddenControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code < 0x20 && code !== 9 && code !== 10 && code !== 13) || (code >= 0x7f && code <= 0x9f)
    );
  });
}
function checked<T>(schema: TSchema, output: unknown): T {
  if (!Value.Check(schema, output)) corrupt();
  return output as T;
}
function bounded<T>(schema: TSchema, output: unknown): T {
  const value = checked<T>(schema, output);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumReviewRunDecisionResponseUtf8Bytes)
    corrupt();
  return value;
}
function transaction<T>(database: DatabaseSync, write: boolean, action: () => T): T {
  const nested = database.isTransaction;
  const savepoint = `review_run_decision_${randomUUID().replaceAll("-", "")}`;
  database.exec(nested ? `SAVEPOINT ${savepoint}` : write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const output = action();
    database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return output;
  } catch (error) {
    if (nested) {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else database.exec("ROLLBACK");
    throw error;
  }
}

interface RunScope {
  repository_id: string;
  review_run_id: string;
  work_item_id: string;
  work_item_kind: "pull_request" | "issue";
  revision_key: string;
  plan_digest: string;
}
interface EventRow extends RunScope {
  id: string;
  change_id: string;
  actor_issuer: string;
  actor_subject: string;
  action: ReviewRunDecisionEvent["action"];
  reason: string;
  previous_version: number;
  version: number;
  result_set_digest: string;
  target_decision_id: string | null;
  supersedes_decision_id: string | null;
  policy_snapshot_json: string;
  intent_digest: string;
  receipt_digest: string;
  created_at: string;
}
interface AppendRow extends EventRow {
  snapshot_json: string;
  policy_json: string;
  policy_digest: string;
}
// Ordinary reads must not materialize the potentially large private policy or source snapshots.
const eventColumns = `id, repository_id, review_run_id, work_item_id, work_item_kind, change_id,
  actor_issuer, actor_subject, action, reason, previous_version, version, revision_key,
  plan_digest, result_set_digest, target_decision_id, supersedes_decision_id,
  policy_snapshot_json, intent_digest, receipt_digest, created_at`;
function runScope(database: DatabaseSync, input: Scope): RunScope {
  const row = database
    .prepare(`SELECT run.repository_id, run.id AS review_run_id,
    run.work_item_id, item.resource_kind AS work_item_kind, run.revision_key, run.plan_digest
    FROM review_runs AS run JOIN work_items AS item ON item.id = run.work_item_id
    WHERE run.id = ? AND run.repository_id = ? AND run.purpose = 'review'`)
    .get(input.reviewRunId, input.repositoryId) as RunScope | undefined;
  if (!row) notFound();
  return row;
}
function readRow(database: DatabaseSync, input: Scope, id: string): EventRow | undefined {
  return database
    .prepare(`SELECT ${eventColumns} FROM review_run_decision_events
    WHERE repository_id = ? AND review_run_id = ? AND id = ?`)
    .get(input.repositoryId, input.reviewRunId, id) as EventRow | undefined;
}
function compactPolicy(policy: DashboardValidationPolicy): ReviewRunDecisionPolicySnapshot {
  if (
    policy.reasonCount < policy.reasons.length ||
    (!policy.reasonsTruncated && policy.reasonCount !== policy.reasons.length)
  )
    corrupt();
  const codes = [...new Set(policy.reasons.map((reason) => reason.code))];
  const common = {
    blockingFindingCount: policy.blockingFindingCount,
    reasonCount: policy.reasonCount,
    reasonCodes: codes.slice(0, 128),
    reasonCodesTruncated: codes.length > 128,
  };
  const versioned =
    policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
      ? {
          ...common,
          policyVersion: policy.policyVersion,
          unresolvedBlockingFindingCount: policy.unresolvedBlockingFindingCount,
          findingDispositionDigest: policy.findingDispositionDigest,
        }
      : { ...common, policyVersion: policy.policyVersion };
  return policy.applicable
    ? { ...versioned, applicable: true, eligible: policy.eligible }
    : { ...versioned, applicable: false, eligible: null };
}
function intent(input: ChangeInput): string {
  return sha256(canonicalJson(input));
}
function eventProjection(row: EventRow): ReviewRunDecisionEvent {
  if (Buffer.byteLength(row.policy_snapshot_json, "utf8") > 32_768) corrupt();
  let policyAtDecision: unknown;
  try {
    policyAtDecision = JSON.parse(row.policy_snapshot_json);
  } catch {
    return corrupt();
  }
  return checked<ReviewRunDecisionEvent>(ReviewRunDecisionEventSchema, {
    id: row.id,
    repositoryId: row.repository_id,
    reviewRunId: row.review_run_id,
    workItemId: row.work_item_id,
    workItemKind: row.work_item_kind,
    changeId: row.change_id,
    actor: { issuer: row.actor_issuer, subject: row.actor_subject },
    action: row.action,
    reason: row.reason,
    previousVersion: row.previous_version,
    version: row.version,
    revisionKey: row.revision_key,
    planDigest: row.plan_digest,
    resultSetDigest: row.result_set_digest,
    targetDecisionId: row.target_decision_id,
    supersedesDecisionId: row.supersedes_decision_id,
    policyAtDecision,
    createdAt: row.created_at,
  });
}
function validateAppend(row: AppendRow): void {
  let snapshot: unknown;
  let policy: DashboardValidationPolicy;
  try {
    snapshot = JSON.parse(row.snapshot_json);
    policy = checked<DashboardValidationPolicy>(fullPolicySchema, JSON.parse(row.policy_json));
  } catch {
    corrupt();
  }
  // New appends always use the disposition-aware basis. Historical V1 receipts are read and
  // replayed through their immutable compact policy without rewriting their stored JSON.
  if (!Value.Check(ReviewRunDecisionSnapshotV2Schema, snapshot)) corrupt();
  if (
    policy.policyVersion !== "required-checks-and-unresolved-p0-p1-v2" ||
    policy.findingDispositionDigest !== snapshot.findingDispositionDigest ||
    policy.unresolvedBlockingFindingCount > policy.blockingFindingCount ||
    snapshot.repositoryId !== row.repository_id ||
    snapshot.reviewRunId !== row.review_run_id ||
    snapshot.workItemId !== row.work_item_id ||
    snapshot.workItemKind !== row.work_item_kind ||
    snapshot.revisionKey !== row.revision_key ||
    snapshot.planDigest !== row.plan_digest ||
    Buffer.byteLength(row.snapshot_json, "utf8") > 131_072 ||
    Buffer.byteLength(row.policy_json, "utf8") > 16_777_216 ||
    sha256(canonicalJson(snapshot)) !== row.result_set_digest ||
    sha256(canonicalJson(policy)) !== row.policy_digest ||
    canonicalJson(compactPolicy(policy)) !== row.policy_snapshot_json ||
    policy.applicable !== (row.work_item_kind === "pull_request")
  )
    corrupt();
}
function mapEvent(
  database: DatabaseSync,
  row: EventRow,
  scope: RunScope,
  persisted = true,
): ReviewRunDecisionEvent {
  const event = eventProjection(row);
  if (
    Object.entries(scope).some(([key, value]) => row[key as keyof RunScope] !== value) ||
    sha256(canonicalJson(event)) !== row.receipt_digest ||
    row.version !== row.previous_version + 1 ||
    row.reason !== row.reason.trim() ||
    !row.reason.isWellFormed() ||
    containsForbiddenControls(row.reason)
  )
    corrupt();
  const original = {
    repositoryId: row.repository_id,
    reviewRunId: row.review_run_id,
    actor: event.actor,
    changeId: row.change_id,
    expectedVersion: row.previous_version,
    expectedRevisionKey: row.revision_key,
    expectedPlanDigest: row.plan_digest,
    expectedResultSetDigest: row.result_set_digest,
    reason: row.reason,
    ...(event.action === "withdraw"
      ? { action: event.action, targetDecisionId: event.targetDecisionId }
      : { action: event.action }),
  };
  if (
    intent(original) !== row.intent_digest ||
    (event.action === "comment" && event.supersedesDecisionId !== null) ||
    (event.action === "withdraw" && event.supersedesDecisionId !== event.targetDecisionId) ||
    (event.action === "approve" && !event.policyAtDecision.eligible)
  )
    corrupt();
  if (persisted && event.action !== "comment") {
    const previous = database
      .prepare(`SELECT id, action, repository_id, review_run_id, version
      FROM review_run_decision_events WHERE review_run_id = ? AND version < ?
      AND action != 'comment' ORDER BY version DESC LIMIT 1`)
      .get(row.review_run_id, row.version) as
      | {
          id: string;
          action: string;
          repository_id: string;
          review_run_id: string;
          version: number;
        }
      | undefined;
    const expected = previous?.action === "withdraw" ? null : (previous?.id ?? null);
    if (
      event.supersedesDecisionId !== expected ||
      (previous && previous.repository_id !== row.repository_id) ||
      (event.action === "withdraw" && (expected === null || event.targetDecisionId !== expected))
    )
      corrupt();
  }
  return event;
}
function authorizeChange(
  database: DatabaseSync,
  input: ChangeInput,
  administrators: readonly OperatorPrincipal[],
): RunScope {
  assertRepositoryPermission(database, input.actor, input.repositoryId, "review", administrators);
  const scope = runScope(database, input);
  if (input.action === "override_approve")
    assertRepositoryPermission(
      database,
      input.actor,
      input.repositoryId,
      "configure",
      administrators,
    );
  if (
    (input.action === "approve" || input.action === "override_approve") &&
    scope.work_item_kind !== "pull_request"
  )
    invalid("Approval decisions apply only to pull requests.");
  if (input.action === "withdraw") {
    // Even an old accepted retry rechecks authority against the original target's author.
    const target = readRow(database, input, input.targetDecisionId);
    if (!target || target.action === "comment" || target.action === "withdraw")
      conflict("The withdrawal target is not a decision in this run.");
    mapEvent(database, target, scope);
    if (target.actor_issuer !== input.actor.issuer || target.actor_subject !== input.actor.subject)
      assertRepositoryPermission(
        database,
        input.actor,
        input.repositoryId,
        "configure",
        administrators,
      );
  }
  return scope;
}
function replay(
  database: DatabaseSync,
  input: ChangeInput,
  scope: RunScope,
): ReviewRunDecisionChangeResponse | undefined {
  const row = database
    .prepare(`SELECT ${eventColumns} FROM review_run_decision_events
    WHERE repository_id = ? AND review_run_id = ? AND change_id = ?`)
    .get(input.repositoryId, input.reviewRunId, input.changeId) as EventRow | undefined;
  if (!row) return undefined;
  if (row.intent_digest !== intent(input))
    conflict("This decision change identifier belongs to another request or actor.");
  return bounded(ReviewRunDecisionChangeResponseSchema, {
    change: mapEvent(database, row, scope),
    replayed: true,
  });
}

/** Synchronous preflight: accepted retries never require a new evidence proof or a current result set.
 * Authorization remains current, and a receipt is not a claim about the live decision state. */
export function readReviewRunDecisionReplay(
  database: DatabaseSync,
  input: ChangeInput,
  administrators: readonly OperatorPrincipal[],
): ReviewRunDecisionChangeResponse | undefined {
  const normalized = normalizeChange(input);
  return transaction(database, false, () =>
    replay(database, normalized, authorizeChange(database, normalized, administrators)),
  );
}
function stream(
  database: DatabaseSync,
  scope: RunScope,
): { version: number; latest: EventRow | undefined; recorded: ReviewRunDecisionEvent | null } {
  const summary = database
    .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(version), 0) AS version
    FROM review_run_decision_events WHERE review_run_id = ?`)
    .get(scope.review_run_id) as { count: number; version: number };
  if (!Number.isSafeInteger(summary.version) || summary.count !== summary.version) corrupt();
  const latest = database
    .prepare(`SELECT ${eventColumns} FROM review_run_decision_events WHERE review_run_id = ?
    ORDER BY version DESC LIMIT 1`)
    .get(scope.review_run_id) as EventRow | undefined;
  if (latest) mapEvent(database, latest, scope);
  const recorded = database
    .prepare(`SELECT ${eventColumns} FROM review_run_decision_events WHERE review_run_id = ?
    AND action != 'comment' ORDER BY version DESC LIMIT 1`)
    .get(scope.review_run_id) as EventRow | undefined;
  return {
    version: summary.version,
    latest,
    recorded: recorded ? mapEvent(database, recorded, scope) : null,
  };
}
function currentFacts(
  database: DatabaseSync,
  input: Scope,
  scope: RunScope,
  facts?: VerifiedReviewRunEvidenceFacts,
  capturePolicy = false,
) {
  const query = { repositoryId: input.repositoryId, reviewRunId: input.reviewRunId };
  let fullPolicy: DashboardValidationPolicy | undefined;
  const detail = readVerifiedReviewRunDetailInTransaction(
    database,
    query,
    facts,
    capturePolicy
      ? (value) => {
          if (fullPolicy !== undefined) corrupt();
          fullPolicy = checked<DashboardValidationPolicy>(fullPolicySchema, value);
        }
      : undefined,
  );
  const snapshot = readReviewRunDecisionSnapshotInTransaction(database, query);
  if (!detail || !snapshot) notFound();
  if (
    capturePolicy &&
    (fullPolicy === undefined || Buffer.byteLength(canonicalJson(fullPolicy), "utf8") > 16_777_216)
  )
    corrupt();
  if (
    detail.workItemKind !== scope.work_item_kind ||
    detail.workItemId !== scope.work_item_id ||
    detail.revisionKey !== snapshot.snapshot.revisionKey ||
    detail.planDigest !== snapshot.snapshot.planDigest ||
    detail.policy.policyVersion !== "required-checks-and-unresolved-p0-p1-v2" ||
    detail.policy.findingDispositionDigest !== snapshot.snapshot.findingDispositionDigest
  )
    corrupt();
  return { detail, snapshot, fullPolicy };
}
function context(
  database: DatabaseSync,
  input: Scope,
  administrators: readonly OperatorPrincipal[],
  facts?: VerifiedReviewRunEvidenceFacts,
): ReviewRunDecisionContext {
  assertRepositoryPermission(database, input.actor, input.repositoryId, "read", administrators);
  const scope = runScope(database, input);
  const { detail, snapshot } = currentFacts(database, input, scope, facts);
  const sourceCurrent = currentAuthority(snapshot);
  const { version, recorded } = stream(database, scope);
  const reasons: ReviewRunDecisionContext["stateReasons"] = [];
  let state: ReviewRunDecisionContext["recordedDecisionState"] = "none";
  if (recorded?.action === "withdraw") state = "withdrawn";
  else if (recorded) {
    if (recorded.resultSetDigest !== snapshot.resultSetDigest) reasons.push("result_set_changed");
    if (!sourceCurrent) reasons.push("source_not_current");
    if (recorded.action === "approve" && !detail.policy.eligible)
      reasons.push("approval_policy_not_satisfied");
    state =
      reasons.includes("result_set_changed") || reasons.includes("source_not_current")
        ? "stale"
        : reasons.includes("approval_policy_not_satisfied")
          ? "ineligible"
          : "current";
  }
  return bounded(ReviewRunDecisionContextSchema, {
    repositoryId: input.repositoryId,
    reviewRunId: input.reviewRunId,
    workItemId: scope.work_item_id,
    workItemKind: scope.work_item_kind,
    revisionKey: scope.revision_key,
    currentRevisionKey: snapshot.snapshot.currentRevisionKey,
    planDigest: scope.plan_digest,
    resultSetDigest: snapshot.resultSetDigest,
    version,
    sourceCurrent,
    policy: detail.policy,
    recordedDecision: recorded,
    recordedDecisionState: state,
    stateReasons: reasons,
    canApprove:
      scope.work_item_kind === "pull_request" && sourceCurrent && detail.policy.eligible === true,
  });
}
function change(
  database: DatabaseSync,
  input: ChangeInput,
  now: string,
  administrators: readonly OperatorPrincipal[],
  facts?: VerifiedReviewRunEvidenceFacts,
): ReviewRunDecisionChangeResponse {
  const scope = authorizeChange(database, input, administrators);
  const existing = replay(database, input, scope);
  if (existing) return existing;
  const { detail, snapshot, fullPolicy } = currentFacts(database, input, scope, facts, true);
  if (fullPolicy === undefined) corrupt();
  const current = stream(database, scope);
  if (input.expectedVersion !== current.version)
    conflict("The run decision changed. Reload before saving.");
  if (current.version === Number.MAX_SAFE_INTEGER)
    conflict("The run decision version is exhausted.");
  if (current.latest && current.latest.created_at > now)
    conflict("The decision timestamp precedes the current audit event.");
  assertBindings(input, snapshot);
  if (input.action !== "comment" && input.action !== "withdraw" && !currentAuthority(snapshot))
    conflict("The run source or authorization is no longer current.");
  if (input.action === "approve" && detail.policy.eligible !== true)
    conflict("The current verified validation policy does not allow approval.");
  const active = current.recorded?.action === "withdraw" ? null : current.recorded;
  if (input.action === "withdraw" && active?.id !== input.targetDecisionId)
    conflict("The withdrawal target is no longer the active decision. Reload before saving.");
  const row: AppendRow = {
    ...scope,
    id: randomUUID(),
    change_id: input.changeId,
    actor_issuer: input.actor.issuer,
    actor_subject: input.actor.subject,
    action: input.action,
    reason: input.reason,
    previous_version: current.version,
    version: current.version + 1,
    result_set_digest: snapshot.resultSetDigest,
    policy_digest: sha256(canonicalJson(fullPolicy)),
    target_decision_id: input.action === "withdraw" ? input.targetDecisionId : null,
    supersedes_decision_id: input.action === "comment" ? null : (active?.id ?? null),
    snapshot_json: canonicalJson(snapshot.snapshot),
    policy_json: canonicalJson(fullPolicy),
    policy_snapshot_json: canonicalJson(compactPolicy(fullPolicy)),
    intent_digest: intent(input),
    receipt_digest: "",
    created_at: now,
  };
  validateAppend(row);
  row.receipt_digest = sha256(canonicalJson(eventProjection(row)));
  const receipt = bounded<ReviewRunDecisionChangeResponse>(ReviewRunDecisionChangeResponseSchema, {
    change: mapEvent(database, row, scope, false),
    replayed: false,
  });
  database
    .prepare(`INSERT INTO review_run_decision_events (
    id, repository_id, review_run_id, work_item_id, work_item_kind, change_id,
    actor_issuer, actor_subject, action, reason, previous_version, version,
    revision_key, plan_digest, result_set_digest, target_decision_id, supersedes_decision_id,
    snapshot_json, policy_json, policy_snapshot_json, intent_digest, created_at, policy_digest, receipt_digest
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id,
      row.repository_id,
      row.review_run_id,
      row.work_item_id,
      row.work_item_kind,
      row.change_id,
      row.actor_issuer,
      row.actor_subject,
      row.action,
      row.reason,
      row.previous_version,
      row.version,
      row.revision_key,
      row.plan_digest,
      row.result_set_digest,
      row.target_decision_id,
      row.supersedes_decision_id,
      row.snapshot_json,
      row.policy_json,
      row.policy_snapshot_json,
      row.intent_digest,
      row.created_at,
      row.policy_digest,
      row.receipt_digest,
    );
  return receipt;
}
function assertBindings(input: ChangeInput, current: ReviewRunDecisionSnapshot): void {
  if (
    input.expectedRevisionKey !== current.snapshot.revisionKey ||
    input.expectedPlanDigest !== current.snapshot.planDigest ||
    input.expectedResultSetDigest !== current.resultSetDigest
  )
    conflict("The source, plan, or result set changed. Reload before saving a decision.");
}
function currentAuthority(current: ReviewRunDecisionSnapshot): boolean {
  return (
    current.sourceCurrent &&
    current.snapshot.itemState === "open" &&
    current.snapshot.epochStatus === "active" &&
    current.snapshot.repositoryEnabled &&
    current.snapshot.authorizationPolicyCurrent
  );
}
function history(
  database: DatabaseSync,
  input: ReviewRunDecisionOperationMap["listReviewRunDecisionHistory"]["input"],
  administrators: readonly OperatorPrincipal[],
): ReviewRunDecisionHistoryResponse {
  assertRepositoryPermission(database, input.actor, input.repositoryId, "read", administrators);
  const scope = runScope(database, input);
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) invalid("The decision history page offset is too large.");
  const { version: total } = stream(database, scope);
  const rows = database
    .prepare(`SELECT ${eventColumns} FROM review_run_decision_events WHERE repository_id = ?
    AND review_run_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`)
    .all(input.repositoryId, input.reviewRunId, pageSize, offset) as unknown as EventRow[];
  const items = rows.map((row, index) => {
    if (row.version !== total - offset - index) corrupt();
    return mapEvent(database, row, scope);
  });
  return bounded(ReviewRunDecisionHistoryResponseSchema, {
    repositoryId: input.repositoryId,
    reviewRunId: input.reviewRunId,
    page,
    pageSize,
    total,
    items,
  });
}

/** All final policy, scope and permission checks and the append happen synchronously together. */
export function handleReviewRunDecisionRequest(
  database: DatabaseSync,
  request: ReviewRunDecisionRequest,
  now: string,
  administrators: readonly OperatorPrincipal[],
  facts?: VerifiedReviewRunEvidenceFacts,
): ReviewRunDecisionOperationMap[ReviewRunDecisionOperation]["output"] {
  if (!request || !isReviewRunDecisionOperation(request.operation))
    invalid("The review run decision operation is invalid.");
  validateInput(request.operation, request.input);
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
    invalid("A canonical decision timestamp is required.");
  return transaction(database, request.operation === "changeReviewRunDecision", () => {
    switch (request.operation) {
      case "getReviewRunDecisionContext":
        return context(database, request.input, administrators, facts);
      case "listReviewRunDecisionHistory":
        return history(database, request.input, administrators);
      case "changeReviewRunDecision":
        return change(database, normalizeChange(request.input), now, administrators, facts);
    }
  });
}
