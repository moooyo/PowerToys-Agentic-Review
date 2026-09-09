import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  EntityIdSchema,
  type FindingComparisonResponse,
  FindingComparisonResponseSchema,
  type FindingDisposition,
  type FindingDispositionChangeRequest,
  FindingDispositionChangeRequestSchema,
  type FindingDispositionChangeResponse,
  FindingDispositionChangeResponseSchema,
  type FindingDispositionEvent,
  FindingDispositionEventSchema,
  type FindingDispositionHistoryResponse,
  FindingDispositionHistoryResponseSchema,
  type FindingListResponse,
  FindingListResponseSchema,
  type FindingOccurrence,
  type FindingOccurrenceRef,
  type FindingResultContext,
  maximumFindingDispositionRequestUtf8Bytes,
  maximumFindingDispositionResponseUtf8Bytes,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  Sha256Schema,
} from "@agentic-review/contracts";
import { FormatRegistry, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  findingOccurrenceKey,
  findingResultDispositionDigest,
  initialFindingDisposition,
  readFindingDispositionProjection,
} from "./finding-disposition-projection.js";
import { compareFindingResultSets, readFindingResult } from "./finding-occurrences.js";
import { assertRepositoryPermission } from "./operator-access.js";
import { readReviewRunDecisionSnapshotInTransaction } from "./review-run-decision-snapshot.js";

interface Scope {
  readonly repositoryId: string;
  readonly reviewRunId: string;
  readonly requestId: string;
  readonly jobId: string;
  readonly actor: OperatorPrincipal;
}
interface PageScope extends Scope {
  readonly page?: number;
  readonly pageSize?: number;
}
type ChangeInput = Scope & FindingDispositionChangeRequest & { readonly occurrenceKey: string };
export interface FindingDispositionOperationMap {
  listFindingOccurrences: { input: PageScope; output: FindingListResponse };
  getFindingDispositionHistory: {
    input: PageScope & { readonly occurrenceKey: string };
    output: FindingDispositionHistoryResponse;
  };
  changeFindingDisposition: { input: ChangeInput; output: FindingDispositionChangeResponse };
  compareFindingResults: {
    input: PageScope & {
      readonly beforeReviewRunId: string;
      readonly beforeRequestId: string;
      readonly beforeJobId: string;
    };
    output: FindingComparisonResponse;
  };
}
export type FindingDispositionOperation = keyof FindingDispositionOperationMap;
export type FindingDispositionRequest = {
  [K in FindingDispositionOperation]: {
    readonly operation: K;
    readonly input: FindingDispositionOperationMap[K]["input"];
  };
}[FindingDispositionOperation];

class FindingDispositionError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_INVALID"
      | "PLATFORM_NOT_FOUND"
      | "PLATFORM_CONFLICT"
      | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "FindingDispositionError";
  }
}
function invalid(message: string): never {
  throw new FindingDispositionError("PLATFORM_INVALID", message);
}
function conflict(message: string): never {
  throw new FindingDispositionError("PLATFORM_CONFLICT", message);
}
function corrupt(): never {
  throw new FindingDispositionError(
    "PLATFORM_CORRUPT",
    "The stored finding disposition is invalid.",
  );
}
function notFound(): never {
  throw new FindingDispositionError("PLATFORM_NOT_FOUND", "The finding result was not found.");
}
const scopeProperties = {
  repositoryId: EntityIdSchema,
  reviewRunId: EntityIdSchema,
  requestId: EntityIdSchema,
  jobId: EntityIdSchema,
  actor: OperatorPrincipalSchema,
};
const pageProperties = {
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
};
const inputSchemas = {
  listFindingOccurrences: Type.Object(
    { ...scopeProperties, ...pageProperties },
    { additionalProperties: false },
  ),
  getFindingDispositionHistory: Type.Object(
    { ...scopeProperties, ...pageProperties, occurrenceKey: Sha256Schema },
    { additionalProperties: false },
  ),
  changeFindingDisposition: Type.Object(
    {
      ...scopeProperties,
      ...FindingDispositionChangeRequestSchema.properties,
      occurrenceKey: Sha256Schema,
    },
    { additionalProperties: false },
  ),
  compareFindingResults: Type.Object(
    {
      ...scopeProperties,
      ...pageProperties,
      beforeReviewRunId: EntityIdSchema,
      beforeRequestId: EntityIdSchema,
      beforeJobId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
};
export function isFindingDispositionOperation(
  operation: string,
): operation is FindingDispositionOperation {
  return Object.hasOwn(inputSchemas, operation);
}
function containsForbiddenControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159);
  });
}
function normalizeChange(input: ChangeInput): ChangeInput {
  if (
    Buffer.byteLength(JSON.stringify(input), "utf8") > maximumFindingDispositionRequestUtf8Bytes ||
    !input.reason.isWellFormed() ||
    containsForbiddenControls(input.reason) ||
    !input.reason.trim()
  )
    invalid(
      "A bounded, nonempty finding disposition reason without control characters is required.",
    );
  return { ...input, actor: { ...input.actor }, reason: input.reason.trim() };
}
function bounded<T>(schema: TSchema, output: unknown): T {
  if (
    !Value.Check(schema, output) ||
    Buffer.byteLength(JSON.stringify(output), "utf8") > maximumFindingDispositionResponseUtf8Bytes
  )
    corrupt();
  return output as T;
}
function transaction<T>(database: DatabaseSync, write: boolean, action: () => T): T {
  const nested = database.isTransaction;
  const savepoint = `finding_disposition_${randomUUID().replaceAll("-", "")}`;
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
function page(input: PageScope) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) invalid("The finding page offset is too large.");
  return { page, pageSize, offset };
}
function resultScope(input: Scope) {
  return {
    repositoryId: input.repositoryId,
    reviewRunId: input.reviewRunId,
    requestId: input.requestId,
    jobId: input.jobId,
  };
}
function read(database: DatabaseSync, input: Scope) {
  const selected = readFindingResult(database, resultScope(input));
  if (!selected) notFound();
  const resultIdentity = {
    resultId: selected.context.resultId,
    resultDigest: selected.context.resultDigest,
  };
  const projection = readFindingDispositionProjection(database, resultIdentity);
  const keys = new Set(selected.occurrences.map((occurrence) => occurrence.key));
  if (
    keys.size !== selected.occurrences.length ||
    [...projection.keys()].some((key) => !keys.has(key))
  )
    corrupt();
  const context: FindingResultContext = {
    ...selected.context,
    dispositionDigest: findingResultDispositionDigest(resultIdentity, projection),
  };
  const occurrences: FindingOccurrence[] = selected.occurrences.map((occurrence) => ({
    ...occurrence,
    disposition: projection.get(occurrence.key)?.disposition ?? initialFindingDisposition(),
  }));
  return { selected, context, occurrences };
}
function occurrenceByKey(selected: ReturnType<typeof read>, key: string): FindingOccurrence {
  const occurrence = selected.occurrences.find((item) => item.key === key);
  if (!occurrence) notFound();
  return occurrence;
}
function list(database: DatabaseSync, input: PageScope): FindingListResponse {
  const selected = read(database, input);
  const paging = page(input);
  const summary = {
    open: 0,
    accepted: 0,
    dismissed: 0,
    resolved: 0,
    rawBlocking: 0,
    unresolvedBlocking: 0,
  };
  for (const occurrence of selected.occurrences) {
    summary[occurrence.disposition.state] += 1;
    if (occurrence.priority <= 1) {
      summary.rawBlocking += 1;
      if (occurrence.disposition.state === "open" || occurrence.disposition.state === "accepted")
        summary.unresolvedBlocking += 1;
    }
  }
  return bounded(FindingListResponseSchema, {
    context: selected.context,
    items: selected.occurrences.slice(paging.offset, paging.offset + paging.pageSize),
    total: selected.occurrences.length,
    page: paging.page,
    pageSize: paging.pageSize,
    summary,
  });
}

interface EventRow {
  id: string;
  repository_id: string;
  review_run_id: string;
  request_id: string;
  job_id: string;
  result_id: string;
  result_digest: string;
  kind: FindingOccurrenceRef["kind"];
  ordinal: number;
  occurrence_key: string;
  work_item_id: string;
  work_item_kind: "pull_request" | "issue";
  revision_key: string;
  plan_digest: string;
  result_set_digest_at_change: string;
  context_digest_at_change: string;
  source_current_at_change: number;
  latest_for_request_at_change: number;
  change_id: string;
  actor_issuer: string;
  actor_subject: string;
  action: FindingDispositionChangeRequest["action"];
  previous_state: FindingDisposition["state"];
  state: FindingDisposition["state"];
  previous_version: number;
  version: number;
  reason: string;
  created_at: string;
  intent_digest: string;
  receipt_digest: string;
}
const eventColumns = `id, repository_id, review_run_id, request_id, job_id, result_id, result_digest,
  kind, ordinal, occurrence_key, work_item_id, work_item_kind, revision_key, plan_digest,
  result_set_digest_at_change, context_digest_at_change, source_current_at_change, latest_for_request_at_change, change_id,
  actor_issuer, actor_subject, action, previous_state, state, previous_version, version, reason,
  created_at, intent_digest, receipt_digest`;
const states: Record<FindingDispositionChangeRequest["action"], FindingDisposition["state"]> = {
  accept: "accepted",
  dismiss: "dismissed",
  resolve: "resolved",
  reopen: "open",
};
function eventProjection(row: EventRow): FindingDispositionEvent {
  const event = {
    id: row.id,
    changeId: row.change_id,
    repositoryId: row.repository_id,
    reviewRunId: row.review_run_id,
    requestId: row.request_id,
    jobId: row.job_id,
    workItemId: row.work_item_id,
    workItemKind: row.work_item_kind,
    occurrence: {
      key: row.occurrence_key,
      resultId: row.result_id,
      resultDigest: row.result_digest,
      kind: row.kind,
      ordinal: row.ordinal,
    },
    revisionKey: row.revision_key,
    planDigest: row.plan_digest,
    resultSetDigestAtChange: row.result_set_digest_at_change,
    contextDigestAtChange: row.context_digest_at_change,
    sourceCurrentAtChange: row.source_current_at_change === 1,
    latestForRequestAtChange: row.latest_for_request_at_change === 1,
    previousState: row.previous_state,
    state: row.state,
    previousVersion: row.previous_version,
    version: row.version,
    action: row.action,
    reason: row.reason,
    actor: { issuer: row.actor_issuer, subject: row.actor_subject },
    createdAt: row.created_at,
  };
  if (
    !Value.Check(FindingDispositionEventSchema, event) ||
    (row.source_current_at_change !== 0 && row.source_current_at_change !== 1) ||
    (row.latest_for_request_at_change !== 0 && row.latest_for_request_at_change !== 1) ||
    row.occurrence_key !==
      findingOccurrenceKey({
        resultId: row.result_id,
        resultDigest: row.result_digest,
        kind: row.kind,
        ordinal: row.ordinal,
      }) ||
    row.version !== row.previous_version + 1 ||
    row.state !== states[row.action] ||
    row.state === row.previous_state ||
    (row.previous_version === 0 && row.previous_state !== "open") ||
    row.reason !== row.reason.trim() ||
    !row.reason.isWellFormed() ||
    containsForbiddenControls(row.reason) ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    new Date(row.created_at).toISOString() !== row.created_at
  )
    corrupt();
  return event;
}
function mapEvent(row: EventRow, input: Scope, occurrenceKey: string): FindingDispositionEvent {
  const event = eventProjection(row);
  const original: ChangeInput = {
    repositoryId: row.repository_id,
    reviewRunId: row.review_run_id,
    requestId: row.request_id,
    jobId: row.job_id,
    occurrenceKey: row.occurrence_key,
    actor: event.actor,
    changeId: row.change_id,
    expectedVersion: row.previous_version,
    expectedResultDigest: row.result_digest,
    expectedContextDigest: row.context_digest_at_change,
    kind: row.kind,
    ordinal: row.ordinal,
    action: row.action,
    reason: row.reason,
  };
  if (
    row.repository_id !== input.repositoryId ||
    row.review_run_id !== input.reviewRunId ||
    row.request_id !== input.requestId ||
    row.job_id !== input.jobId ||
    row.occurrence_key !== occurrenceKey ||
    intent(original) !== row.intent_digest ||
    sha256(canonicalJson(event)) !== row.receipt_digest
  )
    corrupt();
  return event;
}
function intent(input: ChangeInput): string {
  return sha256(canonicalJson(input));
}
function assertResultContext(row: EventRow, context: FindingResultContext): void {
  if (
    row.result_id !== context.resultId ||
    row.result_digest !== context.resultDigest ||
    row.work_item_id !== context.workItemId ||
    row.work_item_kind !== context.workItemKind ||
    row.revision_key !== context.revisionKey ||
    row.plan_digest !== context.planDigest
  )
    corrupt();
}
function replay(
  database: DatabaseSync,
  input: ChangeInput,
): FindingDispositionChangeResponse | undefined {
  const row = database
    .prepare(
      `SELECT ${eventColumns} FROM finding_disposition_events WHERE repository_id = ? AND change_id = ?`,
    )
    .get(input.repositoryId, input.changeId) as EventRow | undefined;
  if (!row) return undefined;
  if (row.intent_digest !== intent(input))
    conflict("This finding change identifier belongs to another request or actor.");
  const event = mapEvent(row, input, input.occurrenceKey);
  // Accepted retries do not re-evaluate old source/context bindings, but their immutable result
  // must still belong to the same requested scope. They never represent the current state.
  const exists = database
    .prepare(`SELECT 1 FROM validation_job_results AS result
    JOIN work_items AS item ON item.id = result.work_item_id AND item.repository_id = result.repository_id
    WHERE result.id = ? AND result.result_digest = ?
    AND result.repository_id = ? AND result.review_run_id = ? AND result.request_id = ? AND result.job_id = ?
    AND result.work_item_id = ? AND result.resource_revision = ? AND result.plan_digest = ?
    AND item.resource_kind = ?`)
    .get(
      row.result_id,
      row.result_digest,
      input.repositoryId,
      input.reviewRunId,
      input.requestId,
      input.jobId,
      row.work_item_id,
      row.revision_key,
      row.plan_digest,
      row.work_item_kind,
    );
  if (!exists) corrupt();
  return bounded(FindingDispositionChangeResponseSchema, { change: event, replayed: true });
}
function change(
  database: DatabaseSync,
  input: ChangeInput,
  now: string,
): FindingDispositionChangeResponse {
  const previous = replay(database, input);
  if (previous) return previous;
  const selected = read(database, input);
  const occurrence = occurrenceByKey(selected, input.occurrenceKey);
  if (occurrence.kind !== input.kind || occurrence.ordinal !== input.ordinal)
    invalid("The occurrence identity does not match the selected finding.");
  if (
    input.expectedResultDigest !== selected.context.resultDigest ||
    input.expectedContextDigest !== selected.context.contextDigest
  )
    conflict("The finding source or latest execution changed. Reload before saving.");
  if (input.expectedVersion !== occurrence.disposition.version)
    conflict("The finding disposition changed. Reload before saving.");
  if (occurrence.disposition.version === Number.MAX_SAFE_INTEGER)
    conflict("The finding disposition version is exhausted.");
  if (states[input.action] === occurrence.disposition.state)
    conflict("This action does not change the finding disposition.");
  if (occurrence.disposition.updatedAt !== null && occurrence.disposition.updatedAt > now)
    conflict("The disposition timestamp precedes the current audit event.");
  const snapshot = readReviewRunDecisionSnapshotInTransaction(database, {
    repositoryId: input.repositoryId,
    reviewRunId: input.reviewRunId,
  });
  if (!snapshot) notFound();
  const context = selected.context;
  if (
    snapshot.snapshot.workItemId !== context.workItemId ||
    snapshot.snapshot.workItemKind !== context.workItemKind ||
    snapshot.snapshot.revisionKey !== context.revisionKey ||
    snapshot.snapshot.planDigest !== context.planDigest
  )
    corrupt();
  const row: EventRow = {
    id: randomUUID(),
    repository_id: input.repositoryId,
    review_run_id: input.reviewRunId,
    request_id: input.requestId,
    job_id: input.jobId,
    result_id: context.resultId,
    result_digest: context.resultDigest,
    kind: occurrence.kind,
    ordinal: occurrence.ordinal,
    occurrence_key: occurrence.key,
    work_item_id: context.workItemId,
    work_item_kind: context.workItemKind,
    revision_key: context.revisionKey,
    plan_digest: context.planDigest,
    result_set_digest_at_change: snapshot.resultSetDigest,
    context_digest_at_change: context.contextDigest,
    source_current_at_change: Number(context.sourceCurrent),
    latest_for_request_at_change: Number(context.latestForRequest),
    change_id: input.changeId,
    actor_issuer: input.actor.issuer,
    actor_subject: input.actor.subject,
    action: input.action,
    previous_state: occurrence.disposition.state,
    state: states[input.action],
    previous_version: occurrence.disposition.version,
    version: occurrence.disposition.version + 1,
    reason: input.reason,
    created_at: now,
    intent_digest: intent(input),
    receipt_digest: "",
  };
  row.receipt_digest = sha256(canonicalJson(eventProjection(row)));
  const response = bounded<FindingDispositionChangeResponse>(
    FindingDispositionChangeResponseSchema,
    { change: mapEvent(row, input, occurrence.key), replayed: false },
  );
  const columns = eventColumns.split(",").map((column) => column.trim());
  database
    .prepare(
      `INSERT INTO finding_disposition_events (${eventColumns}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...columns.map((column) => row[column as keyof EventRow]));
  const current = readFindingDispositionProjection(database, {
    resultId: row.result_id,
    resultDigest: row.result_digest,
  }).get(row.occurrence_key);
  if (
    current?.disposition.lastEventId !== row.id ||
    current.disposition.version !== row.version ||
    current.disposition.state !== row.state
  )
    corrupt();
  return response;
}
function history(
  database: DatabaseSync,
  input: FindingDispositionOperationMap["getFindingDispositionHistory"]["input"],
): FindingDispositionHistoryResponse {
  const selected = read(database, input);
  const occurrence = occurrenceByKey(selected, input.occurrenceKey);
  const paging = page(input);
  const stream = database
    .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(version), 0) AS version
    FROM finding_disposition_events WHERE repository_id = ? AND result_id = ? AND kind = ? AND ordinal = ?`)
    .get(input.repositoryId, occurrence.resultId, occurrence.kind, occurrence.ordinal) as {
    count: number;
    version: number;
  };
  if (
    !Number.isSafeInteger(stream.count) ||
    stream.count !== stream.version ||
    stream.version !== occurrence.disposition.version
  )
    corrupt();
  const rows = database
    .prepare(`SELECT ${eventColumns} FROM finding_disposition_events
    WHERE repository_id = ? AND result_id = ? AND kind = ? AND ordinal = ? ORDER BY version DESC LIMIT ? OFFSET ?`)
    .all(
      input.repositoryId,
      occurrence.resultId,
      occurrence.kind,
      occurrence.ordinal,
      paging.pageSize,
      paging.offset,
    ) as unknown as EventRow[];
  const items = rows.map((row, index) => {
    if (row.version !== stream.version - paging.offset - index) corrupt();
    assertResultContext(row, selected.context);
    return mapEvent(row, input, occurrence.key);
  });
  const ref: FindingOccurrenceRef = {
    key: occurrence.key,
    resultId: occurrence.resultId,
    resultDigest: occurrence.resultDigest,
    kind: occurrence.kind,
    ordinal: occurrence.ordinal,
  };
  return bounded(FindingDispositionHistoryResponseSchema, {
    ...resultScope(input),
    occurrence: ref,
    page: paging.page,
    pageSize: paging.pageSize,
    total: stream.count,
    items,
  });
}
function compare(
  database: DatabaseSync,
  input: FindingDispositionOperationMap["compareFindingResults"]["input"],
): FindingComparisonResponse {
  const after = read(database, input);
  const before = read(database, {
    ...input,
    reviewRunId: input.beforeReviewRunId,
    requestId: input.beforeRequestId,
    jobId: input.beforeJobId,
  });
  if (
    after.context.workItemId !== before.context.workItemId ||
    after.context.workItemKind !== before.context.workItemKind
  )
    notFound();
  const comparison = compareFindingResultSets(before.selected, after.selected);
  const paging = page(input);
  return bounded(FindingComparisonResponseSchema, {
    ...comparison,
    before: before.context,
    after: after.context,
    items: comparison.items.slice(paging.offset, paging.offset + paging.pageSize),
    total: comparison.items.length,
    page: paging.page,
    pageSize: paging.pageSize,
  });
}

/** Permission, selected result identity, context and CAS are checked synchronously with the append. */
export function handleFindingDispositionRequest(
  database: DatabaseSync,
  request: FindingDispositionRequest,
  now: string,
  administrators: readonly OperatorPrincipal[],
): FindingDispositionOperationMap[FindingDispositionOperation]["output"] {
  // A retry can be the first operation after restart and must not depend on a prior result read.
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  if (
    !request ||
    !isFindingDispositionOperation(request.operation) ||
    !Value.Check(inputSchemas[request.operation], request.input)
  )
    invalid("The finding disposition request is invalid.");
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
    invalid("A canonical finding disposition timestamp is required.");
  return transaction(database, request.operation === "changeFindingDisposition", () => {
    assertRepositoryPermission(
      database,
      request.input.actor,
      request.input.repositoryId,
      request.operation === "changeFindingDisposition" ? "review" : "read",
      administrators,
    );
    switch (request.operation) {
      case "listFindingOccurrences":
        return list(database, request.input);
      case "getFindingDispositionHistory":
        return history(database, request.input);
      case "changeFindingDisposition":
        return change(database, normalizeChange(request.input), now);
      case "compareFindingResults":
        return compare(database, request.input);
    }
  });
}
