import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { assertRepositoryPermission } from "./operator-access.js";
import {
  publicationIdentity,
  publicationRendererVersion,
  renderPublication,
} from "./publication-renderer.js";
import { handleReviewRunDecisionRequest } from "./review-run-decisions.js";
import {
  readVerifiedReviewRunDetailInTransaction,
  readVerifiedReviewRunResultInTransaction,
  type VerifiedReviewRunEvidenceFacts,
} from "./review-run-queries.js";

type ActorScope = { readonly repositoryId: string; readonly actor: C.OperatorPrincipal };
type ReadScope = ActorScope & { readonly publicationId: string };
type Page = { readonly page?: number; readonly pageSize?: number };
export type RuntimePublicationPublisher = { readonly githubUserId: number } | null;
export interface PublicationLease {
  readonly publication: C.PublicationDetailV1;
  readonly ownerId: string;
  readonly fence: number;
  readonly expiresAt: string;
  readonly attemptNumber: number;
  readonly kind: "delivery" | "reconciliation";
}
type LeaseIdentity = {
  readonly publicationId: string;
  readonly ownerId: string;
  readonly fence: number;
};
type Failure = C.PublicationDeliveryV1["failure"];
type RemoteReceipt = C.PublicationDeliveryV1["remoteReceipt"];
type OutcomeInput = LeaseIdentity & {
  readonly outcome: "published" | "failed" | "blocked" | "unknown";
  readonly failure: Failure;
  readonly remoteReceipt: RemoteReceipt;
};
export interface PublicationOperationMap {
  getRepositoryPublicationPolicy: { input: ActorScope; output: C.RepositoryPublicationPolicyV1 };
  updateRepositoryPublicationPolicy: {
    input: ActorScope & C.RepositoryPublicationPolicyUpdateRequest;
    output: { change: C.RepositoryPublicationPolicyAuditEventV1; replayed: boolean };
  };
  listRepositoryPublicationPolicyAudit: {
    input: ActorScope & Page;
    output: {
      repositoryId: string;
      items: C.RepositoryPublicationPolicyAuditEventV1[];
      total: number;
      page: number;
      pageSize: number;
    };
  };
  getRepositoryPublicationPolicyAudit: {
    input: ActorScope & { readonly eventId: string };
    output: C.RepositoryPublicationPolicyAuditEventV1;
  };
  getPublicationPreview: {
    input: ActorScope & { readonly reviewRunId: string; readonly decisionId: string };
    output: C.PublicationPreviewV1;
  };
  confirmPublication: {
    input: ActorScope & { readonly reviewRunId: string } & C.PublicationConfirmRequest;
    output: C.PublicationConfirmResponse;
  };
  listPublications: {
    input: ActorScope &
      Page & { readonly reviewRunId?: string; readonly status?: C.PublicationDeliveryV1["status"] };
    output: C.PublicationListResponse;
  };
  getPublication: { input: ReadScope; output: C.PublicationDetailV1 };
  listPublicationAttempts: { input: ReadScope & Page; output: C.PublicationAttemptListResponse };
  cancelPublication: {
    input: ReadScope & C.PublicationControlRequest;
    output: C.PublicationControlResponse;
  };
  retryPublication: {
    input: ReadScope & C.PublicationControlRequest;
    output: C.PublicationControlResponse;
  };
  requestPublicationReconciliation: {
    input: ReadScope & C.PublicationControlRequest;
    output: C.PublicationControlResponse;
  };
  claimPublicationDelivery: {
    input: { readonly ownerId: string; readonly leaseDurationMs: number };
    output: PublicationLease | null;
  };
  claimPublicationReconciliation: {
    input: { readonly ownerId: string; readonly leaseDurationMs: number };
    output: PublicationLease | null;
  };
  renewPublicationLease: {
    input: LeaseIdentity & { readonly leaseDurationMs: number };
    output: PublicationLease | null;
  };
  beginPublicationSend: {
    input: LeaseIdentity & { readonly expectedPayloadSha256: string };
    output: PublicationLease | null;
  };
  completePublicationDelivery: { input: OutcomeInput; output: C.PublicationDetailV1 };
  completePublicationReconciliation: {
    input: Omit<OutcomeInput, "outcome"> & { readonly outcome: "published" | "unknown" };
    output: C.PublicationDetailV1;
  };
  recoverExpiredPublications: { input: { readonly limit?: number }; output: { recovered: number } };
}
export type PublicationOperation = keyof PublicationOperationMap;
export type PublicationRequest = {
  [K in PublicationOperation]: {
    readonly operation: K;
    readonly input: PublicationOperationMap[K]["input"];
  };
}[PublicationOperation];
const names: Record<PublicationOperation, true> = {
  getRepositoryPublicationPolicy: true,
  updateRepositoryPublicationPolicy: true,
  listRepositoryPublicationPolicyAudit: true,
  getRepositoryPublicationPolicyAudit: true,
  getPublicationPreview: true,
  confirmPublication: true,
  listPublications: true,
  getPublication: true,
  listPublicationAttempts: true,
  cancelPublication: true,
  retryPublication: true,
  requestPublicationReconciliation: true,
  claimPublicationDelivery: true,
  claimPublicationReconciliation: true,
  renewPublicationLease: true,
  beginPublicationSend: true,
  completePublicationDelivery: true,
  completePublicationReconciliation: true,
  recoverExpiredPublications: true,
};
export function isPublicationOperation(operation: string): operation is PublicationOperation {
  return Object.hasOwn(names, operation);
}
class PublicationError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_INVALID"
      | "PLATFORM_NOT_FOUND"
      | "PLATFORM_CONFLICT"
      | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "PublicationError";
  }
}
function invalid(message: string): never {
  throw new PublicationError("PLATFORM_INVALID", message);
}
function conflict(message: string): never {
  throw new PublicationError("PLATFORM_CONFLICT", message);
}
function corrupt(): never {
  throw new PublicationError("PLATFORM_CORRUPT", "The stored publication data is invalid.");
}
function notFound(): never {
  throw new PublicationError("PLATFORM_NOT_FOUND", "The publication resource was not found.");
}
function checked<T>(schema: TSchema, value: unknown): T {
  if (!Value.Check(schema, value)) corrupt();
  return value as T;
}
function json<T>(schema: TSchema, raw: string, digest?: string): T {
  if (
    Buffer.byteLength(raw, "utf8") > 1024 * 1024 ||
    (digest !== undefined && sha256(raw) !== digest)
  )
    corrupt();
  try {
    return checked<T>(schema, JSON.parse(raw));
  } catch {
    return corrupt();
  }
}
function transaction<T>(db: DatabaseSync, write: boolean, action: () => T): T {
  const nested = db.isTransaction;
  const point = `publication_${randomUUID().replaceAll("-", "")}`;
  db.exec(nested ? `SAVEPOINT ${point}` : write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = action();
    db.exec(nested ? `RELEASE SAVEPOINT ${point}` : "COMMIT");
    return result;
  } catch (error) {
    if (nested) {
      db.exec(`ROLLBACK TO SAVEPOINT ${point}`);
      db.exec(`RELEASE SAVEPOINT ${point}`);
    } else db.exec("ROLLBACK");
    throw error;
  }
}
function authorize(
  db: DatabaseSync,
  input: ActorScope,
  permission: "read" | "configure",
  admins: readonly C.OperatorPrincipal[],
): void {
  assertRepositoryPermission(db, input.actor, input.repositoryId, permission, admins);
}
function pagination(input: Page) {
  const page = input.page ?? 1,
    pageSize = input.pageSize ?? 20;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  )
    invalid("The publication page is invalid.");
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function validateActor(input: ActorScope): void {
  if (
    !Value.Check(C.EntityIdSchema, input.repositoryId) ||
    !Value.Check(C.OperatorPrincipalSchema, input.actor)
  )
    invalid("The publication actor or scope is invalid.");
}
function policy(db: DatabaseSync, repositoryId: string): C.RepositoryPublicationPolicyV1 {
  if (!db.prepare("SELECT id FROM managed_repositories WHERE id = ?").get(repositoryId)) notFound();
  const row = db
    .prepare(
      "SELECT version, enabled, snapshot_json FROM publication_policies WHERE repository_id = ?",
    )
    .get(repositoryId) as { version: number; enabled: number; snapshot_json: string } | undefined;
  if (!row)
    return {
      schemaVersion: "RepositoryPublicationPolicyV1",
      repositoryId,
      version: 0,
      enabled: false,
      updatedAt: null,
      updatedBy: null,
    };
  const value = json<C.RepositoryPublicationPolicyV1>(
    C.RepositoryPublicationPolicyV1Schema,
    row.snapshot_json,
  );
  if (
    value.repositoryId !== repositoryId ||
    value.version !== row.version ||
    value.enabled !== (row.enabled === 1) ||
    C.getRepositoryPublicationPolicyIssues(value).length
  )
    corrupt();
  const event = db
    .prepare(
      "SELECT receipt_json,receipt_digest FROM publication_policy_events WHERE repository_id=? AND version=?",
    )
    .get(repositoryId, row.version) as ReceiptRow | undefined;
  if (!event) corrupt();
  const audit = json<C.RepositoryPublicationPolicyAuditEventV1>(
    C.RepositoryPublicationPolicyAuditEventV1Schema,
    event.receipt_json,
    event.receipt_digest,
  );
  if (
    canonicalJson(audit.snapshot) !== row.snapshot_json ||
    C.getRepositoryPublicationPolicyAuditEventIssues(audit).length
  )
    corrupt();
  return value;
}
type ReceiptRow = { receipt_json: string; receipt_digest: string; intent_digest: string };
function policyReplay(
  db: DatabaseSync,
  input: PublicationOperationMap["updateRepositoryPublicationPolicy"]["input"],
) {
  const row = db
    .prepare(
      "SELECT receipt_json, receipt_digest, intent_digest FROM publication_policy_events WHERE repository_id = ? AND change_id = ?",
    )
    .get(input.repositoryId, input.changeId) as ReceiptRow | undefined;
  if (!row) return undefined;
  if (row.intent_digest !== sha256(canonicalJson(input)))
    conflict("The policy change identifier belongs to another request or actor.");
  return {
    change: json<C.RepositoryPublicationPolicyAuditEventV1>(
      C.RepositoryPublicationPolicyAuditEventV1Schema,
      row.receipt_json,
      row.receipt_digest,
    ),
    replayed: true,
  };
}
function updatePolicy(
  db: DatabaseSync,
  input: PublicationOperationMap["updateRepositoryPublicationPolicy"]["input"],
  now: string,
  admins: readonly C.OperatorPrincipal[],
) {
  authorize(db, input, "configure", admins);
  const { repositoryId: _repositoryId, actor: _actor, ...request } = input;
  if (!Value.Check(C.RepositoryPublicationPolicyUpdateRequestSchema, request))
    invalid("The publication policy change is invalid.");
  const replay = policyReplay(db, input);
  if (replay) return replay;
  const previousSnapshot = policy(db, input.repositoryId);
  if (
    previousSnapshot.version !== input.expectedVersion ||
    input.expectedVersion === Number.MAX_SAFE_INTEGER
  )
    conflict("The repository publication policy changed. Reload before saving.");
  if (previousSnapshot.updatedAt !== null && previousSnapshot.updatedAt > now)
    conflict("The policy timestamp precedes the current version.");
  const snapshot: C.RepositoryPublicationPolicyV1 = {
    schemaVersion: "RepositoryPublicationPolicyV1",
    repositoryId: input.repositoryId,
    version: previousSnapshot.version + 1,
    enabled: input.enabled,
    updatedAt: now,
    updatedBy: input.actor,
  };
  const change = checked<C.RepositoryPublicationPolicyAuditEventV1>(
    C.RepositoryPublicationPolicyAuditEventV1Schema,
    {
      schemaVersion: "RepositoryPublicationPolicyAuditEventV1",
      id: randomUUID(),
      repositoryId: input.repositoryId,
      changeId: input.changeId,
      actor: input.actor,
      previousVersion: previousSnapshot.version,
      version: snapshot.version,
      previousSnapshot,
      snapshot,
      createdAt: now,
    },
  );
  if (previousSnapshot.version === 0) {
    db.prepare(
      "INSERT INTO publication_policies(repository_id,version,enabled,snapshot_json) VALUES (?,?,?,?)",
    ).run(input.repositoryId, snapshot.version, snapshot.enabled ? 1 : 0, canonicalJson(snapshot));
  } else {
    const updated = db
      .prepare(
        "UPDATE publication_policies SET version=?,enabled=?,snapshot_json=? WHERE repository_id=? AND version=?",
      )
      .run(
        snapshot.version,
        snapshot.enabled ? 1 : 0,
        canonicalJson(snapshot),
        input.repositoryId,
        previousSnapshot.version,
      );
    if (updated.changes !== 1) conflict("The repository publication policy changed.");
  }
  const raw = canonicalJson(change);
  db.prepare(
    "INSERT INTO publication_policy_events(id,repository_id,change_id,version,intent_digest,receipt_digest,receipt_json) VALUES(?,?,?,?,?,?,?)",
  ).run(
    change.id,
    input.repositoryId,
    input.changeId,
    snapshot.version,
    sha256(canonicalJson(input)),
    sha256(raw),
    raw,
  );
  return { change, replayed: false };
}
function policyAudit(
  db: DatabaseSync,
  input: ActorScope & Page,
  admins: readonly C.OperatorPrincipal[],
) {
  authorize(db, input, "read", admins);
  policy(db, input.repositoryId);
  const { page, pageSize, offset } = pagination(input);
  const total = (
    db
      .prepare("SELECT COUNT(*) AS total FROM publication_policy_events WHERE repository_id=?")
      .get(input.repositoryId) as { total: number }
  ).total;
  const rows = db
    .prepare(
      "SELECT receipt_json,receipt_digest FROM publication_policy_events WHERE repository_id=? ORDER BY version DESC LIMIT ? OFFSET ?",
    )
    .all(input.repositoryId, pageSize, offset) as unknown as ReceiptRow[];
  return {
    repositoryId: input.repositoryId,
    total,
    page,
    pageSize,
    items: rows.map((row) =>
      json<C.RepositoryPublicationPolicyAuditEventV1>(
        C.RepositoryPublicationPolicyAuditEventV1Schema,
        row.receipt_json,
        row.receipt_digest,
      ),
    ),
  };
}

interface IntentRow {
  publication_id: string;
  repository_id: string;
  review_run_id: string;
  selected_decision_id: string;
  renderer_version: string;
  confirmation_change_id: string;
  confirmation_intent_digest: string;
  intent_digest: string;
  intent_json: string;
  created_at: string;
}
interface StateRow {
  publication_id: string;
  repository_id: string;
  version: number;
  status: C.PublicationDeliveryV1["status"];
  state_json: string;
  fence: number;
  lease_owner: string | null;
  lease_kind: "delivery" | "reconciliation" | null;
  lease_expires_at: string | null;
  send_started_at: string | null;
  reconciliation_requested: number;
  reconciliation_event_id: string | null;
  attempt_number: number;
}
function intentRow(db: DatabaseSync, publicationId: string): IntentRow | undefined {
  return db
    .prepare("SELECT * FROM publication_intents WHERE publication_id=?")
    .get(publicationId) as unknown as IntentRow | undefined;
}
function readIntent(row: IntentRow): C.PublicationIntentV1 {
  const value = json<C.PublicationIntentV1>(
    C.PublicationIntentV1Schema,
    row.intent_json,
    row.intent_digest,
  );
  if (
    value.publicationId !== row.publication_id ||
    value.binding.repositoryId !== row.repository_id ||
    value.binding.reviewRunId !== row.review_run_id ||
    value.binding.selectedDecisionId !== row.selected_decision_id ||
    value.rendererVersion !== row.renderer_version ||
    value.confirmationChangeId !== row.confirmation_change_id ||
    value.createdAt !== row.created_at ||
    value.payloadSha256 !== sha256(canonicalJson(value.payload)) ||
    value.decision.id !== value.binding.selectedDecisionId ||
    value.decision.version !== value.binding.selectedDecisionVersion ||
    C.getPublicationIntentIssues(value).length
  )
    corrupt();
  if (value.rendererVersion === publicationRendererVersion) {
    const marker = `\n<!-- agentic-review-publication:${value.publicationId} semantic-sha256:${value.semanticSha256} -->`;
    if (
      value.publicationId !==
        publicationIdentity(
          value.binding.repositoryId,
          value.binding.reviewRunId,
          value.binding.selectedDecisionId,
        ) ||
      !value.payload.body.endsWith(marker) ||
      sha256(value.payload.body.slice(0, -marker.length)) !== value.semanticSha256
    )
      corrupt();
  }
  return value;
}
function stateRow(db: DatabaseSync, publicationId: string): StateRow {
  const row = db
    .prepare("SELECT * FROM publication_states WHERE publication_id=?")
    .get(publicationId) as unknown as StateRow | undefined;
  if (!row) corrupt();
  return row;
}
function readState(row: StateRow): C.PublicationDeliveryV1 {
  const value = json<C.PublicationDeliveryV1>(C.PublicationDeliveryV1Schema, row.state_json);
  if (
    value.publicationId !== row.publication_id ||
    value.version !== row.version ||
    value.status !== row.status ||
    value.attemptCount !== row.attempt_number ||
    C.getPublicationDeliveryIssues(value).length
  )
    corrupt();
  return value;
}
function detail(
  db: DatabaseSync,
  publicationId: string,
  repositoryId?: string,
): C.PublicationDetailV1 {
  const row = intentRow(db, publicationId);
  if (!row || (repositoryId !== undefined && row.repository_id !== repositoryId)) notFound();
  const intent = readIntent(row),
    state = stateRow(db, publicationId);
  if (state.repository_id !== intent.binding.repositoryId) corrupt();
  const value = checked<C.PublicationDetailV1>(C.PublicationDetailV1Schema, {
    schemaVersion: "PublicationDetailV1",
    intent,
    delivery: readState(state),
  });
  if (C.getPublicationDetailIssues(value).length) corrupt();
  return value;
}
export function getPublicationVerificationScope(
  db: DatabaseSync,
  publicationId: string,
): { repositoryId: string; reviewRunId: string } {
  const row = intentRow(db, publicationId);
  if (!row) notFound();
  const value = readIntent(row);
  return { repositoryId: value.binding.repositoryId, reviewRunId: value.binding.reviewRunId };
}

function selectedDecision(
  db: DatabaseSync,
  input: PublicationOperationMap["getPublicationPreview"]["input"],
  context: C.ReviewRunDecisionContext,
  now: string,
  admins: readonly C.OperatorPrincipal[],
): C.ReviewRunDecisionEvent {
  const row = db
    .prepare(
      "SELECT version FROM review_run_decision_events WHERE repository_id=? AND review_run_id=? AND id=?",
    )
    .get(input.repositoryId, input.reviewRunId, input.decisionId) as
    | { version: number }
    | undefined;
  if (!row || row.version > context.version) notFound();
  // Reuse the complete decision receipt verifier, including immutable event and intent digests.
  const history = handleReviewRunDecisionRequest(
    db,
    {
      operation: "listReviewRunDecisionHistory",
      input: {
        repositoryId: input.repositoryId,
        reviewRunId: input.reviewRunId,
        actor: input.actor,
        page: Math.floor((context.version - row.version) / 20) + 1,
        pageSize: 20,
      },
    },
    now,
    admins,
  ) as C.ReviewRunDecisionHistoryResponse;
  const selected = history.items.find((event) => event.id === input.decisionId);
  if (!selected) corrupt();
  return selected;
}
function previewFacts(
  db: DatabaseSync,
  input: PublicationOperationMap["getPublicationPreview"]["input"],
  now: string,
  admins: readonly C.OperatorPrincipal[],
  publisher: RuntimePublicationPublisher,
  facts?: VerifiedReviewRunEvidenceFacts,
  excludeExisting = false,
): { preview: C.PublicationPreviewV1; selected: C.ReviewRunDecisionEvent } {
  authorize(db, input, "read", admins);
  const publicationPolicy = policy(db, input.repositoryId);
  const context = handleReviewRunDecisionRequest(
    db,
    {
      operation: "getReviewRunDecisionContext",
      input: {
        repositoryId: input.repositoryId,
        reviewRunId: input.reviewRunId,
        actor: input.actor,
      },
    },
    now,
    admins,
    facts,
  ) as C.ReviewRunDecisionContext;
  const selected = selectedDecision(db, input, context, now, admins);
  let fullPolicy: C.DashboardValidationPolicy | undefined;
  const run = readVerifiedReviewRunDetailInTransaction(
    db,
    { repositoryId: input.repositoryId, reviewRunId: input.reviewRunId },
    facts,
    (value) => {
      fullPolicy = value;
    },
  );
  if (!run || !fullPolicy) notFound();
  const targetRow = db
    .prepare(`SELECT repository.github_repository_id AS githubRepositoryId, repository.full_name AS fullName,
    item.github_work_item_id AS githubWorkItemId, item.github_number AS number, item.resource_kind AS kind
    FROM managed_repositories AS repository JOIN work_items AS item ON item.repository_id=repository.id
    WHERE repository.id=? AND item.id=?`)
    .get(input.repositoryId, run.workItemId);
  const target = checked<C.PublicationTargetV1>(C.PublicationTargetV1Schema, targetRow);
  const publicationId = publicationIdentity(input.repositoryId, input.reviewRunId, selected.id);
  const blockers: C.PublicationBlocker[] = [];
  if (!publicationPolicy.enabled) blockers.push("publication_disabled");
  if (publisher === null) blockers.push("publisher_unavailable");
  try {
    authorize(db, input, "configure", admins);
  } catch (error) {
    if ((error as { code?: string }).code !== "PLATFORM_FORBIDDEN") throw error;
    blockers.push("confirmation_not_permitted");
  }
  if (!context.sourceCurrent) blockers.push("source_not_current");
  if (selected.resultSetDigest !== context.resultSetDigest) blockers.push("result_set_changed");
  if (selected.action === "withdraw")
    blockers.push("decision_withdrawn", "decision_not_publishable");
  else if (
    selected.action !== "comment" &&
    (context.recordedDecision?.id !== selected.id || context.recordedDecisionState !== "current")
  )
    blockers.push("decision_superseded");
  if (selected.action === "approve" && !context.canApprove)
    blockers.push("decision_not_publishable");
  const results: C.DashboardReviewRunResult[] = [];
  for (const request of run.requests) {
    if (request.latestJob?.status !== "succeeded") continue;
    const result = readVerifiedReviewRunResultInTransaction(
      db,
      {
        repositoryId: input.repositoryId,
        reviewRunId: input.reviewRunId,
        requestId: request.requestId,
        jobId: request.latestJob.jobId,
      },
      facts,
    );
    if (!result) corrupt();
    if (!result.authoritative || !result.evidenceComplete || result.evidenceVerificationPending)
      blockers.push("evidence_unavailable");
    results.push(result);
  }
  if (results.length === 0) blockers.push("evidence_unavailable");
  const bindingCurrent =
    selected.resultSetDigest === context.resultSetDigest &&
    selected.revisionKey === run.revisionKey &&
    selected.planDigest === run.planDigest;
  const rendered = bindingCurrent
    ? renderPublication({
        publicationId,
        decision: selected,
        detail: run,
        policy: fullPolicy,
        results,
      })
    : null;
  if (!bindingCurrent) blockers.push("rendering_failed");
  if (!rendered && selected.action !== "withdraw") blockers.push("payload_oversized");
  if (rendered && C.getPublicationPayloadIssues(rendered.payload, target).length !== 0)
    blockers.push("rendering_failed");
  const payload = rendered && !blockers.includes("rendering_failed") ? rendered : null;
  let existingIntent: C.PublicationExistingIntentV1 | null = null;
  if (!excludeExisting && intentRow(db, publicationId)) {
    const existing = detail(db, publicationId, input.repositoryId);
    existingIntent = {
      publicationId,
      deliveryVersion: existing.delivery.version,
      status: existing.delivery.status,
      payloadSha256: existing.intent.payloadSha256,
    };
    blockers.push("existing_publication");
  }
  const preview = checked<C.PublicationPreviewV1>(C.PublicationPreviewV1Schema, {
    schemaVersion: "PublicationPreviewV1",
    publicationId,
    rendererVersion: publicationRendererVersion,
    binding: {
      repositoryId: input.repositoryId,
      reviewRunId: input.reviewRunId,
      workItemId: run.workItemId,
      selectedDecisionId: selected.id,
      selectedDecisionVersion: selected.version,
      decisionContextVersion: context.version,
      revisionKey: selected.revisionKey,
      planDigest: selected.planDigest,
      resultSetDigest: selected.resultSetDigest,
    },
    target,
    payload: payload?.payload ?? null,
    payloadSha256: payload?.payloadSha256 ?? null,
    semanticSha256: payload?.semanticSha256 ?? null,
    observedAt: now,
    policyVersion: publicationPolicy.version,
    publisherAvailability: publisher === null ? "unavailable" : "available",
    publisherGitHubUserId: publisher?.githubUserId ?? null,
    blockers: [...new Set(blockers)],
    canConfirm: blockers.length === 0 && payload !== null,
    existingIntent,
  });
  // A historical intent can retain a prior exact body after a newer context changes rendering.
  if (existingIntent && preview.payloadSha256 !== existingIntent.payloadSha256) {
    const immutable = detail(db, publicationId).intent;
    preview.payload = immutable.payload;
    preview.payloadSha256 = immutable.payloadSha256;
    preview.semanticSha256 = immutable.semanticSha256;
  }
  if (C.getPublicationPreviewIssues(preview).length !== 0) corrupt();
  return { preview, selected };
}

function confirmationReplay(
  db: DatabaseSync,
  input: PublicationOperationMap["confirmPublication"]["input"],
): C.PublicationConfirmResponse | undefined {
  const row = db
    .prepare("SELECT * FROM publication_intents WHERE repository_id=? AND confirmation_change_id=?")
    .get(input.repositoryId, input.changeId) as unknown as IntentRow | undefined;
  if (!row) return undefined;
  if (row.confirmation_intent_digest !== sha256(canonicalJson(input)))
    conflict("The confirmation change identifier belongs to another request or actor.");
  return { intent: readIntent(row), replayed: true };
}
function confirm(
  db: DatabaseSync,
  input: PublicationOperationMap["confirmPublication"]["input"],
  now: string,
  admins: readonly C.OperatorPrincipal[],
  publisher: RuntimePublicationPublisher,
  facts?: VerifiedReviewRunEvidenceFacts,
): C.PublicationConfirmResponse {
  authorize(db, input, "configure", admins);
  const replay = confirmationReplay(db, input);
  if (replay) return replay;
  if (
    db
      .prepare("SELECT id FROM publication_change_events WHERE repository_id=? AND change_id=?")
      .get(input.repositoryId, input.changeId)
  )
    conflict("The confirmation identifier belongs to another publication operation.");
  const { repositoryId: _repo, reviewRunId: _run, actor: _actor, ...request } = input;
  if (!Value.Check(C.PublicationConfirmRequestSchema, request))
    invalid("The publication confirmation is invalid.");
  const { preview, selected } = previewFacts(
    db,
    {
      repositoryId: input.repositoryId,
      reviewRunId: input.reviewRunId,
      decisionId: input.expectedSelectedDecisionId,
      actor: input.actor,
    },
    now,
    admins,
    publisher,
    facts,
  );
  if (C.getPublicationConfirmRequestIssues(request, preview).length !== 0)
    conflict(
      "The publication preview, authority or exact payload changed. Reload before confirming.",
    );
  if (
    !preview.payload ||
    !preview.payloadSha256 ||
    !preview.semanticSha256 ||
    preview.publisherGitHubUserId === null
  )
    corrupt();
  if (selected.createdAt > now)
    conflict("The confirmation timestamp precedes the selected decision.");
  const intent = checked<C.PublicationIntentV1>(C.PublicationIntentV1Schema, {
    schemaVersion: "PublicationIntentV1",
    publicationId: preview.publicationId,
    rendererVersion: preview.rendererVersion,
    policyVersion: preview.policyVersion,
    binding: preview.binding,
    decision: selected,
    target: preview.target,
    payload: preview.payload,
    payloadSha256: preview.payloadSha256,
    semanticSha256: preview.semanticSha256,
    publisherGitHubUserId: preview.publisherGitHubUserId,
    actor: input.actor,
    createdAt: now,
    confirmationChangeId: input.changeId,
  });
  if (C.getPublicationIntentIssues(intent).length) corrupt();
  const raw = canonicalJson(intent);
  db.prepare(
    `INSERT INTO publication_intents(publication_id,repository_id,review_run_id,selected_decision_id,renderer_version,confirmation_change_id,confirmation_intent_digest,intent_digest,intent_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    intent.publicationId,
    input.repositoryId,
    input.reviewRunId,
    selected.id,
    publicationRendererVersion,
    input.changeId,
    sha256(canonicalJson(input)),
    sha256(raw),
    raw,
    now,
  );
  const state: C.PublicationDeliveryV1 = {
    schemaVersion: "PublicationDeliveryV1",
    publicationId: intent.publicationId,
    version: 1,
    status: "pending",
    attemptCount: 0,
    failure: null,
    remoteReceipt: null,
    updatedAt: now,
  };
  db.prepare(
    "INSERT INTO publication_states(publication_id,repository_id,version,status,state_json) VALUES(?,?,?,?,?)",
  ).run(intent.publicationId, input.repositoryId, 1, "pending", canonicalJson(state));
  return { intent, replayed: false };
}

function controlReplay(
  db: DatabaseSync,
  input: ReadScope & C.PublicationControlRequest,
  action: C.PublicationControlAction,
): C.PublicationControlResponse | undefined {
  const row = db
    .prepare(
      "SELECT receipt_json,receipt_digest,intent_digest FROM publication_change_events WHERE repository_id=? AND change_id=?",
    )
    .get(input.repositoryId, input.changeId) as ReceiptRow | undefined;
  if (!row) return undefined;
  if (row.intent_digest !== sha256(canonicalJson({ ...input, action })))
    conflict("The publication change identifier belongs to another request or actor.");
  return {
    change: json<C.PublicationControlReceiptV1>(
      C.PublicationControlReceiptV1Schema,
      row.receipt_json,
      row.receipt_digest,
    ),
    replayed: true,
  };
}

/** Accepted historical receipts are independent of current evidence retention. Authority is
 * always current; this helper never treats a replay as authorization for a new send. */
export function readPublicationReplay(
  db: DatabaseSync,
  request: PublicationRequest,
  admins: readonly C.OperatorPrincipal[],
):
  | C.PublicationConfirmResponse
  | C.PublicationControlResponse
  | C.RepositoryPublicationPolicyUpdateResponse
  | undefined {
  if (
    ![
      "confirmPublication",
      "cancelPublication",
      "retryPublication",
      "requestPublicationReconciliation",
      "updateRepositoryPublicationPolicy",
    ].includes(request.operation)
  )
    return undefined;
  return transaction(db, false, () => {
    const input = request.input as ActorScope;
    validateActor(input);
    authorize(db, input, "configure", admins);
    if (request.operation === "confirmPublication") return confirmationReplay(db, request.input);
    if (request.operation === "updateRepositoryPublicationPolicy")
      return policyReplay(db, request.input);
    if (request.operation === "cancelPublication")
      return controlReplay(db, request.input, "cancel");
    if (request.operation === "retryPublication") return controlReplay(db, request.input, "retry");
    if (request.operation === "requestPublicationReconciliation")
      return controlReplay(db, request.input, "reconcile");
    return undefined;
  });
}

function saveState(db: DatabaseSync, row: StateRow, value: C.PublicationDeliveryV1): void {
  if (
    value.version !== row.version + 1 ||
    row.version >= Number.MAX_SAFE_INTEGER ||
    value.updatedAt < readState(row).updatedAt ||
    C.getPublicationDeliveryIssues(value).length
  )
    corrupt();
  const result = db
    .prepare(
      "UPDATE publication_states SET version=?,status=?,state_json=?,attempt_number=? WHERE publication_id=? AND version=?",
    )
    .run(
      value.version,
      value.status,
      canonicalJson(value),
      value.attemptCount,
      row.publication_id,
      row.version,
    );
  if (result.changes !== 1) conflict("The publication delivery changed.");
}
function nextState(
  row: StateRow,
  now: string,
  status: C.PublicationDeliveryV1["status"],
  failure: Failure = null,
  remoteReceipt: RemoteReceipt = null,
): C.PublicationDeliveryV1 {
  return {
    ...readState(row),
    version: row.version + 1,
    status,
    failure,
    remoteReceipt,
    updatedAt: now,
  };
}
function currentIntentFailure(
  db: DatabaseSync,
  intent: C.PublicationIntentV1,
  now: string,
  admins: readonly C.OperatorPrincipal[],
  publisher: RuntimePublicationPublisher,
  facts?: VerifiedReviewRunEvidenceFacts,
): Failure {
  if (publisher === null)
    return {
      code: "publisher_unavailable",
      message: "The configured publication credential is unavailable.",
    };
  if (publisher.githubUserId !== intent.publisherGitHubUserId)
    return {
      code: "publisher_identity_mismatch",
      message: "The publication credential no longer identifies the confirmed publisher.",
    };
  try {
    authorize(
      db,
      { repositoryId: intent.binding.repositoryId, actor: intent.actor },
      "configure",
      admins,
    );
    const { preview } = previewFacts(
      db,
      {
        repositoryId: intent.binding.repositoryId,
        reviewRunId: intent.binding.reviewRunId,
        decisionId: intent.binding.selectedDecisionId,
        actor: intent.actor,
      },
      now,
      admins,
      publisher,
      facts,
      true,
    );
    if (!preview.canConfirm) {
      const first = preview.blockers[0];
      const code: C.PublicationFailureCode =
        first === "publication_disabled"
          ? "publication_disabled"
          : first === "source_not_current"
            ? "source_changed"
            : first === "result_set_changed"
              ? "result_set_changed"
              : first === "evidence_unavailable" || first === "evidence_verification_failed"
                ? "evidence_unavailable"
                : "decision_changed";
      return {
        code,
        message: `The confirmed publication is no longer eligible: ${preview.blockers.join(", ")}.`,
      };
    }
    if (canonicalJson(preview.binding) !== canonicalJson(intent.binding))
      return {
        code: "decision_changed",
        message: "The selected decision, current decision context or result binding changed.",
      };
    if (canonicalJson(preview.target) !== canonicalJson(intent.target))
      return {
        code: "target_identity_mismatch",
        message: "The confirmed publication target changed.",
      };
    if (
      preview.payloadSha256 !== intent.payloadSha256 ||
      preview.semanticSha256 !== intent.semanticSha256 ||
      canonicalJson(preview.payload) !== canonicalJson(intent.payload)
    )
      return {
        code: "decision_changed",
        message: "The exact confirmed publication payload no longer matches its verified source.",
      };
    return null;
  } catch (error) {
    if (
      ["PLATFORM_FORBIDDEN", "PLATFORM_NOT_FOUND"].includes((error as { code?: string }).code ?? "")
    )
      return {
        code: "authorization_changed",
        message: "The confirming operator no longer has publication authority.",
      };
    throw error;
  }
}

/** Rejects stale ownership and records cheap authority blockers before the owner queues any
 * evidence work. The later begin-send transaction must still verify every current fact. */
export function preparePublicationSend(
  db: DatabaseSync,
  input: PublicationOperationMap["beginPublicationSend"]["input"],
  now: string,
  admins: readonly C.OperatorPrincipal[],
  publisher: RuntimePublicationPublisher,
): { repositoryId: string; reviewRunId: string } | null {
  validateRequest({ operation: "beginPublicationSend", input });
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
    invalid("A canonical publication timestamp is required.");
  return transaction(db, true, () => {
    const row = matchingLease(db, input, now);
    if (!row) return null;
    if (
      row.lease_kind !== "delivery" ||
      row.status !== "delivering" ||
      row.send_started_at !== null
    )
      conflict("The publication cannot begin another send.");
    const value = detail(db, row.publication_id);
    if (value.intent.payloadSha256 !== input.expectedPayloadSha256)
      conflict("The publication payload does not match the lease.");
    let failure: Failure = null;
    if (publisher === null)
      failure = {
        code: "publisher_unavailable",
        message: "The configured publication credential is unavailable.",
      };
    else if (publisher.githubUserId !== value.intent.publisherGitHubUserId)
      failure = {
        code: "publisher_identity_mismatch",
        message: "The publication credential no longer identifies the confirmed publisher.",
      };
    else {
      try {
        authorize(
          db,
          { repositoryId: value.intent.binding.repositoryId, actor: value.intent.actor },
          "configure",
          admins,
        );
      } catch (error) {
        if (
          !["PLATFORM_FORBIDDEN", "PLATFORM_NOT_FOUND"].includes(
            (error as { code?: string }).code ?? "",
          )
        )
          throw error;
        failure = {
          code: "authorization_changed",
          message: "The confirming operator no longer has publication authority.",
        };
      }
      if (failure === null && !policy(db, value.intent.binding.repositoryId).enabled)
        failure = { code: "publication_disabled", message: "Repository publication is disabled." };
    }
    if (failure) {
      finish(db, row, { outcome: "blocked", failure, remoteReceipt: null }, now);
      return null;
    }
    return {
      repositoryId: value.intent.binding.repositoryId,
      reviewRunId: value.intent.binding.reviewRunId,
    };
  });
}
function control(
  db: DatabaseSync,
  input: ReadScope & C.PublicationControlRequest,
  action: C.PublicationControlAction,
  now: string,
  admins: readonly C.OperatorPrincipal[],
  publisher: RuntimePublicationPublisher,
  facts?: VerifiedReviewRunEvidenceFacts,
): C.PublicationControlResponse {
  authorize(db, input, "configure", admins);
  const replay = controlReplay(db, input, action);
  if (replay) return replay;
  if (
    db
      .prepare(
        "SELECT publication_id FROM publication_intents WHERE repository_id=? AND confirmation_change_id=?",
      )
      .get(input.repositoryId, input.changeId)
  )
    conflict("The control identifier belongs to a publication confirmation.");
  const { repositoryId: _repo, publicationId: _publication, actor: _actor, ...request } = input;
  if (!Value.Check(C.PublicationControlRequestSchema, request))
    invalid("The publication control request is invalid.");
  const value = detail(db, input.publicationId, input.repositoryId);
  if (C.getPublicationControlRequestIssues(request, value, action).length)
    conflict("The publication state or exact payload changed, or this operation is unavailable.");
  const row = stateRow(db, input.publicationId);
  if (row.lease_owner !== null || row.reconciliation_requested !== 0)
    conflict("A publication operation is already in progress.");
  if (action === "retry") {
    const failure = currentIntentFailure(db, value.intent, now, admins, publisher, facts);
    if (failure) conflict(failure.message);
  }
  if (
    action === "reconcile" &&
    (publisher === null || publisher.githubUserId !== value.intent.publisherGitHubUserId)
  )
    conflict("The confirmed publisher must be available for reconciliation.");
  const delivery = nextState(
    row,
    now,
    action === "cancel" ? "cancelled" : action === "retry" ? "pending" : "unknown",
    action === "reconcile" ? value.delivery.failure : null,
  );
  if (action !== "reconcile")
    db.prepare("UPDATE publication_states SET send_started_at=NULL WHERE publication_id=?").run(
      input.publicationId,
    );
  saveState(db, row, delivery);
  db.prepare(
    "UPDATE publication_states SET reconciliation_requested=?,send_started_at=? WHERE publication_id=?",
  ).run(
    action === "reconcile" ? 1 : 0,
    action === "reconcile" ? row.send_started_at : null,
    input.publicationId,
  );
  const change = checked<C.PublicationControlReceiptV1>(C.PublicationControlReceiptV1Schema, {
    schemaVersion: "PublicationControlReceiptV1",
    id: randomUUID(),
    changeId: input.changeId,
    publicationId: input.publicationId,
    repositoryId: input.repositoryId,
    action,
    actor: input.actor,
    previousVersion: row.version,
    version: delivery.version,
    payloadSha256: value.intent.payloadSha256,
    createdAt: now,
    delivery,
  });
  if (C.getPublicationControlReceiptIssues(change).length) corrupt();
  const raw = canonicalJson(change);
  db.prepare(
    "INSERT INTO publication_change_events(id,repository_id,publication_id,change_id,intent_digest,receipt_digest,receipt_json) VALUES(?,?,?,?,?,?,?)",
  ).run(
    change.id,
    input.repositoryId,
    input.publicationId,
    input.changeId,
    sha256(canonicalJson({ ...input, action })),
    sha256(raw),
    raw,
  );
  db.prepare("UPDATE publication_states SET reconciliation_event_id=? WHERE publication_id=?").run(
    action === "reconcile" ? change.id : null,
    input.publicationId,
  );
  return { change, replayed: false };
}
function list(
  db: DatabaseSync,
  input: PublicationOperationMap["listPublications"]["input"],
  admins: readonly C.OperatorPrincipal[],
): C.PublicationListResponse {
  authorize(db, input, "read", admins);
  policy(db, input.repositoryId);
  const { actor: _actor, ...query } = input;
  if (!Value.Check(C.PublicationListQuerySchema, query))
    invalid("The publication list query is invalid.");
  const { page, pageSize, offset } = pagination(input);
  const clauses = ["intent.repository_id=?"],
    args: SQLInputValue[] = [input.repositoryId];
  if (input.reviewRunId !== undefined) {
    clauses.push("intent.review_run_id=?");
    args.push(input.reviewRunId);
  }
  if (input.status !== undefined) {
    clauses.push("state.status=?");
    args.push(input.status);
  }
  const from = `FROM publication_intents AS intent JOIN publication_states AS state ON state.publication_id=intent.publication_id WHERE ${clauses.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS total ${from}`).get(...args) as { total: number })
    .total;
  const rows = db
    .prepare(
      `SELECT intent.publication_id ${from} ORDER BY intent.created_at DESC,intent.publication_id LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, offset) as { publication_id: string }[];
  const items = rows.map((row) => {
    const { intent, delivery } = detail(db, row.publication_id, input.repositoryId);
    return checked<C.PublicationSummaryV1>(C.PublicationSummaryV1Schema, {
      schemaVersion: "PublicationSummaryV1",
      publicationId: intent.publicationId,
      repositoryId: intent.binding.repositoryId,
      reviewRunId: intent.binding.reviewRunId,
      workItemId: intent.binding.workItemId,
      selectedDecisionId: intent.binding.selectedDecisionId,
      selectedDecisionVersion: intent.binding.selectedDecisionVersion,
      rendererVersion: intent.rendererVersion,
      target: intent.target,
      payloadSha256: intent.payloadSha256,
      publisherGitHubUserId: intent.publisherGitHubUserId,
      actor: intent.actor,
      createdAt: intent.createdAt,
      delivery,
    });
  });
  return checked(C.PublicationListResponseSchema, {
    repositoryId: input.repositoryId,
    total,
    page,
    pageSize,
    items,
  });
}
function attempts(
  db: DatabaseSync,
  input: ReadScope & Page,
  admins: readonly C.OperatorPrincipal[],
): C.PublicationAttemptListResponse {
  authorize(db, input, "read", admins);
  const publication = detail(db, input.publicationId, input.repositoryId);
  const { page, pageSize, offset } = pagination(input);
  const total = (
    db
      .prepare(
        "SELECT COUNT(*) AS total FROM publication_attempt_events WHERE repository_id=? AND publication_id=?",
      )
      .get(input.repositoryId, input.publicationId) as { total: number }
  ).total;
  const rows = db
    .prepare(
      "SELECT receipt_json,receipt_digest FROM publication_attempt_events WHERE repository_id=? AND publication_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?",
    )
    .all(input.repositoryId, input.publicationId, pageSize, offset) as unknown as ReceiptRow[];
  const items = rows.map((row) =>
    json<C.PublicationAttemptV1>(
      C.PublicationAttemptV1Schema,
      row.receipt_json,
      row.receipt_digest,
    ),
  );
  for (const item of items)
    if (
      C.getPublicationAttemptIssues(
        item,
        input.publicationId,
        publication.intent.publisherGitHubUserId,
      ).length
    )
      corrupt();
  return checked(C.PublicationAttemptListResponseSchema, {
    repositoryId: input.repositoryId,
    publicationId: input.publicationId,
    total,
    page,
    pageSize,
    items,
  });
}

function appendAttempt(
  db: DatabaseSync,
  intent: C.PublicationIntentV1,
  row: StateRow,
  now: string,
  phase: "preflight" | "sending" | "outcome",
  outcome: OutcomeInput["outcome"] | null = null,
  failure: Failure = null,
  remoteReceipt: RemoteReceipt = null,
): void {
  if (!row.lease_kind) corrupt();
  const value = checked<C.PublicationAttemptV1>(C.PublicationAttemptV1Schema, {
    schemaVersion: "PublicationAttemptV1",
    id: randomUUID(),
    publicationId: intent.publicationId,
    attemptNumber: row.attempt_number,
    publisherGitHubUserId: intent.publisherGitHubUserId,
    createdAt: now,
    kind: row.lease_kind,
    phase,
    outcome,
    failure,
    remoteReceipt,
  });
  if (C.getPublicationAttemptIssues(value).length) corrupt();
  const sequence = (
    db
      .prepare(
        "SELECT COALESCE(MAX(sequence),0)+1 AS value FROM publication_attempt_events WHERE publication_id=?",
      )
      .get(intent.publicationId) as { value: number }
  ).value;
  const raw = canonicalJson(value);
  db.prepare(
    "INSERT INTO publication_attempt_events(id,publication_id,repository_id,sequence,receipt_digest,receipt_json) VALUES(?,?,?,?,?,?)",
  ).run(value.id, intent.publicationId, intent.binding.repositoryId, sequence, sha256(raw), raw);
}
function leaseDuration(input: { ownerId: string; leaseDurationMs: number }): void {
  if (
    !Value.Check(C.EntityIdSchema, input.ownerId) ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1_000 ||
    input.leaseDurationMs > 300_000
  )
    invalid("The publication lease is invalid.");
}
function leaseProjection(db: DatabaseSync, row: StateRow): PublicationLease {
  if (!row.lease_owner || !row.lease_expires_at || !row.lease_kind) corrupt();
  return {
    publication: detail(db, row.publication_id),
    ownerId: row.lease_owner,
    fence: row.fence,
    expiresAt: row.lease_expires_at,
    attemptNumber: row.attempt_number,
    kind: row.lease_kind,
  };
}
function matchingLease(db: DatabaseSync, input: LeaseIdentity, now: string): StateRow | null {
  if (
    !Value.Check(C.EntityIdSchema, input.publicationId) ||
    !Value.Check(C.EntityIdSchema, input.ownerId) ||
    !Number.isSafeInteger(input.fence) ||
    input.fence < 1
  )
    invalid("The publication lease identity is invalid.");
  const row = stateRow(db, input.publicationId);
  if (
    row.lease_owner !== input.ownerId ||
    row.fence !== input.fence ||
    row.lease_expires_at === null ||
    row.lease_expires_at <= now
  )
    return null;
  return row;
}
function claim(
  db: DatabaseSync,
  input: { ownerId: string; leaseDurationMs: number },
  now: string,
  kind: "delivery" | "reconciliation",
  admins: readonly C.OperatorPrincipal[],
): PublicationLease | null {
  leaseDuration(input);
  const row = db
    .prepare(
      `SELECT * FROM publication_states WHERE lease_owner IS NULL AND ${kind === "delivery" ? "status='pending'" : "status='unknown' AND reconciliation_requested=1"} ORDER BY publication_id LIMIT 1`,
    )
    .get() as unknown as StateRow | undefined;
  if (!row) return null;
  if (row.fence === Number.MAX_SAFE_INTEGER || row.attempt_number === Number.MAX_SAFE_INTEGER)
    conflict("The publication lease sequence is exhausted.");
  const existing = detail(db, row.publication_id);
  let reconciliationAuthorized = true;
  if (kind === "reconciliation") {
    if (row.reconciliation_event_id === null) corrupt();
    const eventRow = db
      .prepare(
        "SELECT receipt_json,receipt_digest FROM publication_change_events WHERE id=? AND publication_id=? AND repository_id=?",
      )
      .get(row.reconciliation_event_id, row.publication_id, row.repository_id) as
      | ReceiptRow
      | undefined;
    if (!eventRow) corrupt();
    const event = json<C.PublicationControlReceiptV1>(
      C.PublicationControlReceiptV1Schema,
      eventRow.receipt_json,
      eventRow.receipt_digest,
    );
    if (
      event.action !== "reconcile" ||
      event.version !== row.version ||
      event.payloadSha256 !== existing.intent.payloadSha256 ||
      C.getPublicationControlReceiptIssues(event).length
    )
      corrupt();
    // A read-only reconciliation has its own requesting actor. An old confirming actor does
    // not substitute for the current authority of the operator who requested this scan.
    try {
      authorize(db, { repositoryId: row.repository_id, actor: event.actor }, "configure", admins);
    } catch (error) {
      if (
        !["PLATFORM_FORBIDDEN", "PLATFORM_NOT_FOUND"].includes(
          (error as { code?: string }).code ?? "",
        )
      )
        throw error;
      reconciliationAuthorized = false;
    }
  }
  const value = nextState(
    row,
    now,
    kind === "delivery" ? "delivering" : "unknown",
    kind === "reconciliation" ? existing.delivery.failure : null,
  );
  value.attemptCount += 1;
  saveState(db, row, value);
  const expiresAt = new Date(Date.parse(now) + input.leaseDurationMs).toISOString();
  db.prepare(
    "UPDATE publication_states SET lease_owner=?,lease_kind=?,lease_expires_at=?,fence=fence+1,reconciliation_requested=0,send_started_at=? WHERE publication_id=?",
  ).run(
    input.ownerId,
    kind,
    expiresAt,
    kind === "delivery" ? null : row.send_started_at,
    row.publication_id,
  );
  const claimed = stateRow(db, row.publication_id);
  appendAttempt(db, existing.intent, claimed, now, "preflight");
  if (!reconciliationAuthorized) {
    finish(
      db,
      claimed,
      {
        outcome: "unknown",
        failure: {
          code: "reconciliation_incomplete",
          message:
            "The requesting operator no longer has reconciliation authority. No upstream scan was started.",
        },
        remoteReceipt: null,
      },
      now,
    );
    return null;
  }
  return leaseProjection(db, claimed);
}
function finish(
  db: DatabaseSync,
  row: StateRow,
  input: Pick<OutcomeInput, "outcome" | "failure" | "remoteReceipt">,
  now: string,
): C.PublicationDetailV1 {
  const existing = detail(db, row.publication_id);
  if (input.outcome === "published") {
    if (
      !input.remoteReceipt ||
      input.failure !== null ||
      C.getPublicationRemoteReceiptIssues(
        input.remoteReceipt,
        existing.intent.target,
        existing.intent.publisherGitHubUserId,
        existing.intent.payload,
      ).length
    )
      invalid("The remote publication receipt does not match the confirmed intent.");
  }
  const delivery = nextState(row, now, input.outcome, input.failure, input.remoteReceipt);
  if (C.getPublicationDeliveryIssues(delivery).length)
    invalid("The publication outcome has inconsistent certainty or receipt fields.");
  saveState(db, row, delivery);
  appendAttempt(
    db,
    existing.intent,
    row,
    now,
    "outcome",
    input.outcome,
    input.failure,
    input.remoteReceipt,
  );
  db.prepare(
    "UPDATE publication_states SET lease_owner=NULL,lease_kind=NULL,lease_expires_at=NULL,reconciliation_requested=0,reconciliation_event_id=NULL WHERE publication_id=?",
  ).run(row.publication_id);
  return detail(db, row.publication_id);
}
function recover(db: DatabaseSync, now: string, limit = 50): { recovered: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    invalid("The publication recovery limit is invalid.");
  const rows = db
    .prepare(
      "SELECT * FROM publication_states WHERE lease_expires_at IS NOT NULL AND lease_expires_at<=? ORDER BY lease_expires_at,publication_id LIMIT ?",
    )
    .all(now, limit) as unknown as StateRow[];
  for (const row of rows) {
    const uncertain = row.send_started_at !== null || row.lease_kind === "reconciliation";
    finish(
      db,
      row,
      {
        outcome: uncertain ? "unknown" : "failed",
        failure: {
          code: uncertain ? "delivery_interrupted" : "preflight_failed",
          message: uncertain
            ? "The lease expired after sending may have begun or during reconciliation. Delivery remains unknown."
            : "The delivery lease expired before the durable send boundary. An explicit retry is required.",
        },
        remoteReceipt: null,
      },
      now,
    );
  }
  return { recovered: rows.length };
}

function validateRequest(request: PublicationRequest): void {
  const input = request.input;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Buffer.byteLength(JSON.stringify(input), "utf8") > 32768
  )
    invalid("The publication operation input is invalid.");
  const actor = "actor" in input;
  if (actor) validateActor(input as ActorScope);
  const actorSchema = C.OperatorPrincipalSchema;
  const repositoryId = C.EntityIdSchema,
    publicationId = C.EntityIdSchema,
    reviewRunId = C.EntityIdSchema;
  const page = Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 }));
  const pageSize = Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }));
  const scope = { repositoryId, actor: actorSchema },
    read = { ...scope, publicationId };
  const lease = { publicationId, ownerId: C.EntityIdSchema, fence: C.PositiveIntegerSchema };
  const duration = Type.Integer({ minimum: 1000, maximum: 300000 });
  const outcome = {
    ...lease,
    outcome: Type.Union([
      Type.Literal("published"),
      Type.Literal("failed"),
      Type.Literal("blocked"),
      Type.Literal("unknown"),
    ]),
    failure: Type.Union([C.PublicationFailureSchema, Type.Null()]),
    remoteReceipt: Type.Union([C.PublicationRemoteReceiptV1Schema, Type.Null()]),
  };
  const schemas: Record<PublicationOperation, TSchema> = {
    getRepositoryPublicationPolicy: Type.Object(scope, { additionalProperties: false }),
    updateRepositoryPublicationPolicy: Type.Object(
      { ...scope, ...C.RepositoryPublicationPolicyUpdateRequestSchema.properties },
      { additionalProperties: false },
    ),
    listRepositoryPublicationPolicyAudit: Type.Object(
      { ...scope, page, pageSize },
      { additionalProperties: false },
    ),
    getRepositoryPublicationPolicyAudit: Type.Object(
      { ...scope, eventId: C.EntityIdSchema },
      { additionalProperties: false },
    ),
    getPublicationPreview: Type.Object(
      { ...scope, reviewRunId, decisionId: C.EntityIdSchema },
      { additionalProperties: false },
    ),
    confirmPublication: Type.Object(
      { ...scope, reviewRunId, ...C.PublicationConfirmRequestSchema.properties },
      { additionalProperties: false },
    ),
    listPublications: Type.Object(
      { ...scope, ...C.PublicationListQuerySchema.properties },
      { additionalProperties: false },
    ),
    getPublication: Type.Object(read, { additionalProperties: false }),
    listPublicationAttempts: Type.Object(
      { ...read, page, pageSize },
      { additionalProperties: false },
    ),
    cancelPublication: Type.Object(
      { ...read, ...C.PublicationControlRequestSchema.properties },
      { additionalProperties: false },
    ),
    retryPublication: Type.Object(
      { ...read, ...C.PublicationControlRequestSchema.properties },
      { additionalProperties: false },
    ),
    requestPublicationReconciliation: Type.Object(
      { ...read, ...C.PublicationControlRequestSchema.properties },
      { additionalProperties: false },
    ),
    claimPublicationDelivery: Type.Object(
      { ownerId: C.EntityIdSchema, leaseDurationMs: duration },
      { additionalProperties: false },
    ),
    claimPublicationReconciliation: Type.Object(
      { ownerId: C.EntityIdSchema, leaseDurationMs: duration },
      { additionalProperties: false },
    ),
    renewPublicationLease: Type.Object(
      { ...lease, leaseDurationMs: duration },
      { additionalProperties: false },
    ),
    beginPublicationSend: Type.Object(
      { ...lease, expectedPayloadSha256: C.Sha256Schema },
      { additionalProperties: false },
    ),
    completePublicationDelivery: Type.Object(outcome, { additionalProperties: false }),
    completePublicationReconciliation: Type.Object(
      { ...outcome, outcome: Type.Union([Type.Literal("published"), Type.Literal("unknown")]) },
      { additionalProperties: false },
    ),
    recoverExpiredPublications: Type.Object(
      { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false },
    ),
  };
  if (!Value.Check(schemas[request.operation], input))
    invalid("The publication operation input does not match its strict contract.");
}

/** Internal delivery operations remain outside the operator allowlist. The caller must supply
 * configured runtime publisher identity, never an operator-provided identity or credential. */
export function handlePublicationRequest(
  db: DatabaseSync,
  request: PublicationRequest,
  now: string,
  admins: readonly C.OperatorPrincipal[],
  publisher: RuntimePublicationPublisher,
  facts?: VerifiedReviewRunEvidenceFacts,
): PublicationOperationMap[PublicationOperation]["output"] {
  if (!request || !isPublicationOperation(request.operation))
    invalid("The publication operation is invalid.");
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
    invalid("A canonical publication timestamp is required.");
  if (
    publisher !== null &&
    (!Value.Check(C.GitHubNumericIdSchema, publisher.githubUserId) ||
      Object.keys(publisher).length !== 1)
  )
    invalid("The configured publisher identity is invalid.");
  validateRequest(request);
  const write = ![
    "getRepositoryPublicationPolicy",
    "listRepositoryPublicationPolicyAudit",
    "getRepositoryPublicationPolicyAudit",
    "getPublicationPreview",
    "listPublications",
    "getPublication",
    "listPublicationAttempts",
  ].includes(request.operation);
  return transaction(db, write, () => {
    switch (request.operation) {
      case "getRepositoryPublicationPolicy":
        authorize(db, request.input, "read", admins);
        return policy(db, request.input.repositoryId);
      case "updateRepositoryPublicationPolicy":
        return updatePolicy(db, request.input, now, admins);
      case "listRepositoryPublicationPolicyAudit":
        return policyAudit(db, request.input, admins);
      case "getRepositoryPublicationPolicyAudit": {
        authorize(db, request.input, "read", admins);
        const row = db
          .prepare(
            "SELECT receipt_json,receipt_digest FROM publication_policy_events WHERE repository_id=? AND id=?",
          )
          .get(request.input.repositoryId, request.input.eventId) as ReceiptRow | undefined;
        if (!row) notFound();
        return json<C.RepositoryPublicationPolicyAuditEventV1>(
          C.RepositoryPublicationPolicyAuditEventV1Schema,
          row.receipt_json,
          row.receipt_digest,
        );
      }
      case "getPublicationPreview":
        return previewFacts(db, request.input, now, admins, publisher, facts).preview;
      case "confirmPublication":
        return confirm(db, request.input, now, admins, publisher, facts);
      case "listPublications":
        return list(db, request.input, admins);
      case "getPublication":
        authorize(db, request.input, "read", admins);
        return detail(db, request.input.publicationId, request.input.repositoryId);
      case "listPublicationAttempts":
        return attempts(db, request.input, admins);
      case "cancelPublication":
        return control(db, request.input, "cancel", now, admins, publisher, facts);
      case "retryPublication":
        return control(db, request.input, "retry", now, admins, publisher, facts);
      case "requestPublicationReconciliation":
        return control(db, request.input, "reconcile", now, admins, publisher, facts);
      case "claimPublicationDelivery":
        return publisher === null ? null : claim(db, request.input, now, "delivery", admins);
      case "claimPublicationReconciliation":
        return publisher === null ? null : claim(db, request.input, now, "reconciliation", admins);
      case "renewPublicationLease": {
        const row = matchingLease(db, request.input, now);
        if (!row) return null;
        const expiresAt = new Date(Date.parse(now) + request.input.leaseDurationMs).toISOString();
        db.prepare(
          "UPDATE publication_states SET lease_expires_at=? WHERE publication_id=? AND fence=? AND lease_owner=?",
        ).run(expiresAt, row.publication_id, row.fence, row.lease_owner);
        return leaseProjection(db, stateRow(db, row.publication_id));
      }
      case "beginPublicationSend": {
        const row = matchingLease(db, request.input, now);
        if (!row) return null;
        if (
          row.lease_kind !== "delivery" ||
          row.status !== "delivering" ||
          row.send_started_at !== null
        )
          conflict("The publication cannot begin another send.");
        const value = detail(db, row.publication_id);
        if (value.intent.payloadSha256 !== request.input.expectedPayloadSha256)
          conflict("The publication payload does not match the lease.");
        const failure = currentIntentFailure(db, value.intent, now, admins, publisher, facts);
        if (failure) {
          finish(db, row, { outcome: "blocked", failure, remoteReceipt: null }, now);
          return null;
        }
        const delivery = nextState(row, now, "delivering");
        saveState(db, row, delivery);
        db.prepare("UPDATE publication_states SET send_started_at=? WHERE publication_id=?").run(
          now,
          row.publication_id,
        );
        const sending = stateRow(db, row.publication_id);
        appendAttempt(db, value.intent, sending, now, "sending");
        return leaseProjection(db, sending);
      }
      case "completePublicationDelivery": {
        const row = matchingLease(db, request.input, now);
        if (!row) conflict("The publication delivery lease is no longer current.");
        if (row.lease_kind !== "delivery" || row.status !== "delivering")
          conflict("This lease does not own a delivery.");
        if (row.send_started_at === null && !["failed", "blocked"].includes(request.input.outcome))
          invalid("A publication cannot claim a send outcome before the send boundary.");
        if (
          row.send_started_at !== null &&
          (request.input.outcome === "blocked" ||
            (request.input.outcome === "failed" &&
              !["github_rejected", "rate_limited"].includes(request.input.failure?.code ?? "")))
        )
          invalid("A possible send cannot become a definite preflight failure.");
        return finish(db, row, request.input, now);
      }
      case "completePublicationReconciliation": {
        const row = matchingLease(db, request.input, now);
        if (!row) conflict("The publication reconciliation lease is no longer current.");
        if (row.lease_kind !== "reconciliation" || row.status !== "unknown")
          conflict("This lease does not own reconciliation.");
        return finish(db, row, request.input, now);
      }
      case "recoverExpiredPublications":
        return recover(db, now, request.input.limit);
    }
  });
}
