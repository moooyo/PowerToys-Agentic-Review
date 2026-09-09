import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OperatorPrincipal } from "@agentic-review/contracts";
import * as C from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  assertRepositoryPermission,
  isPlatformAdministrator,
  OperatorAccessError,
  repositoryReadSql,
} from "./operator-access.js";

type ReadState = "unread" | "read" | "archived";
type ListFilter = { state: "all" | ReadState; workItemKind: "all" | "pull_request" | "issue" };
type ActorInput = { readonly actor: OperatorPrincipal };
type RepositoryInput = ActorInput & { readonly repositoryId: string };
type ListQuery = C.NotificationListQuery;
type StateChangeRequest = C.NotificationStateChangeRequest;
export interface NotificationOperationMap {
  listNotificationOverview: {
    input: ActorInput & { readonly page?: number; readonly pageSize?: number };
    output: C.NotificationOverviewV1;
  };
  getNotificationSummary: {
    input: ActorInput & { readonly repositoryId?: string };
    output: C.NotificationSummaryV1;
  };
  listRepositoryNotifications: {
    input: RepositoryInput & { readonly query: ListQuery };
    output: C.NotificationListV1;
  };
  changeNotificationStates: {
    input: RepositoryInput & { readonly request: StateChangeRequest };
    output: C.NotificationStateChangeV1;
  };
  maintainNotifications: {
    input: { readonly limit?: number };
    output: NotificationMaintenanceResult;
  };
}
export type NotificationOperation = keyof NotificationOperationMap;
export type NotificationRequest = {
  [K in NotificationOperation]: { operation: K; input: NotificationOperationMap[K]["input"] };
}[NotificationOperation];
export interface NotificationMaintenanceResult {
  readonly retainedAfter: string;
  readonly deletedStates: number;
  readonly deletedReceipts: number;
  readonly deletedEvents: number;
  readonly deletedCounters: number;
  readonly hasMore: boolean;
}

const operations = new Set<string>([
  "listNotificationOverview",
  "getNotificationSummary",
  "listRepositoryNotifications",
  "changeNotificationStates",
  "maintainNotifications",
]);
export function isNotificationOperation(operation: string): operation is NotificationOperation {
  return operations.has(operation);
}
function invalid(message = "The notification request is invalid."): never {
  throw new OperatorAccessError("PLATFORM_INVALID", message);
}
function notFound(): never {
  throw new OperatorAccessError("PLATFORM_NOT_FOUND", "The notification was not found.");
}
function conflict(message = "The notification state changed. Refresh before trying again."): never {
  throw new OperatorAccessError("PLATFORM_CONFLICT", message);
}
function corrupt(): never {
  const error = new Error("The stored notification projection is invalid.");
  Object.assign(error, { code: "PLATFORM_CORRUPT" });
  throw error;
}
function checked<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (
    !Value.Check(schema, value) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > C.maximumNotificationResponseUtf8Bytes
  )
    corrupt();
  return value;
}
function timestamp(value: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid("The notification observation time is invalid.");
}
function entity(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\0"))
    invalid();
}
function integer(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) invalid();
  return row;
}
function transaction<T>(db: DatabaseSync, write: boolean, action: () => T): T {
  const nested = db.isTransaction;
  const savepoint = `notification_${randomUUID().replaceAll("-", "")}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = action();
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (nested) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else db.exec("ROLLBACK");
    throw error;
  }
}
interface Retention {
  coverageStart: string;
  retainedAfter: string;
}
function retention(db: DatabaseSync): Retention {
  const value = db
    .prepare(
      "SELECT coverage_start AS coverageStart, retained_after AS retainedAfter FROM notification_retention WHERE singleton = 1",
    )
    .get() as unknown as Retention | undefined;
  if (!value) corrupt();
  return value;
}
interface Counts {
  total: number;
  unread: number;
  read: number;
  archived: number;
}
function counts(value: { total: number; read: number; archived: number }): Counts {
  if (
    ![value.total, value.read, value.archived].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) ||
    value.read + value.archived > value.total
  )
    corrupt();
  return { ...value, unread: value.total - value.read - value.archived };
}
function repositoryCounts(
  db: DatabaseSync,
  repositoryId: string,
  actor: OperatorPrincipal,
  retainedAfter: string,
): Counts {
  const row = db
    .prepare(`SELECT COALESCE(SUM(total.total), 0) AS total,
    COALESCE(SUM(personal.read_count), 0) AS read, COALESCE(SUM(personal.archived_count), 0) AS archived
    FROM notification_repository_daily_counts AS total
    LEFT JOIN notification_principal_counters AS personal ON personal.repository_id = total.repository_id
      AND personal.recorded_day = total.recorded_day AND personal.principal_issuer = ? AND personal.principal_subject = ?
    WHERE total.repository_id = ? AND total.recorded_day >= ?`)
    .get(actor.issuer, actor.subject, repositoryId, retainedAfter.slice(0, 10)) as unknown as {
    total: number;
    read: number;
    archived: number;
  };
  return counts(row);
}
function overview(
  db: DatabaseSync,
  input: NotificationOperationMap["listNotificationOverview"]["input"],
  now: string,
  administrators: readonly OperatorPrincipal[],
) {
  object(input, ["actor", "page", "pageSize"]);
  const page = input.page ?? 1,
    pageSize = input.pageSize ?? 20;
  integer(page, 1, 10_000_000);
  integer(pageSize, 1, 50);
  const boundary = retention(db);
  const access = repositoryReadSql("repository.id", input.actor, administrators);
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM managed_repositories AS repository WHERE ${access.sql}`,
      )
      .get(...access.parameters) as { total: number }
  ).total;
  const rows = db
    .prepare(`SELECT repository.id AS repositoryId, repository.full_name AS fullName
    FROM managed_repositories AS repository WHERE ${access.sql}
    ORDER BY repository.id LIMIT ? OFFSET ?`)
    .all(...access.parameters, pageSize, (page - 1) * pageSize) as unknown as {
    repositoryId: string;
    fullName: string;
  }[];
  const result = checked(C.NotificationOverviewV1Schema, {
    schemaVersion: "NotificationOverviewV1",
    actor: input.actor,
    observedAt: now,
    ...boundary,
    page,
    pageSize,
    total,
    items: rows.map((row) => ({
      ...row,
      counts: repositoryCounts(db, row.repositoryId, input.actor, boundary.retainedAfter),
    })),
  });
  if (
    C.getNotificationOverviewIssues(result, { actor: input.actor, query: { page, pageSize } })
      .length
  )
    corrupt();
  return result;
}
function summary(
  db: DatabaseSync,
  input: NotificationOperationMap["getNotificationSummary"]["input"],
  now: string,
  administrators: readonly OperatorPrincipal[],
) {
  object(input, ["actor", "repositoryId"]);
  const boundary = retention(db);
  let unread: number;
  if (input.repositoryId !== undefined) {
    assertRepositoryPermission(db, input.actor, input.repositoryId, "read", administrators);
    unread = repositoryCounts(db, input.repositoryId, input.actor, boundary.retainedAfter).unread;
  } else {
    const access = repositoryReadSql("total.repository_id", input.actor, administrators);
    const row = db
      .prepare(`SELECT MIN(100, COALESCE(SUM(total.total - COALESCE(personal.read_count, 0) - COALESCE(personal.archived_count, 0)), 0)) AS unread
      FROM notification_repository_daily_counts AS total
      LEFT JOIN notification_principal_counters AS personal ON personal.repository_id = total.repository_id
        AND personal.recorded_day = total.recorded_day AND personal.principal_issuer = ? AND personal.principal_subject = ?
      WHERE total.recorded_day >= ? AND ${access.sql}`)
      .get(
        input.actor.issuer,
        input.actor.subject,
        boundary.retainedAfter.slice(0, 10),
        ...access.parameters,
      ) as { unread: number };
    unread = row.unread;
  }
  if (!Number.isSafeInteger(unread) || unread < 0) corrupt();
  const result = checked(C.NotificationSummaryV1Schema, {
    schemaVersion: "NotificationSummaryV1",
    actor: input.actor,
    repositoryId: input.repositoryId ?? null,
    observedAt: now,
    ...boundary,
    unreadCount: Math.min(unread, 99),
    capped: unread > 99,
  });
  if (
    C.getNotificationSummaryIssues(result, {
      actor: input.actor,
      repositoryId: input.repositoryId ?? null,
    }).length
  )
    corrupt();
  return result;
}
interface EventRow {
  id: string;
  repository_id: string;
  sequence: number;
  source_kind: "validation_job_terminal" | "publication_attempt";
  source_id: string;
  occurred_at: string;
  recorded_at: string;
  recorded_day: string;
  work_item_id: string;
  work_item_kind: "pull_request" | "issue";
  work_item_number: number;
  review_run_id: string;
  revision_key: string;
  request_id: string | null;
  job_id: string | null;
  job_activation: number | null;
  run_attempt_id: string | null;
  workflow_kind: string | null;
  target: string | null;
  publication_id: string | null;
  outcome: string;
  summary_json: string;
  personal_state: ReadState | null;
  personal_version: number | null;
  personal_updated_at: string | null;
}
function readState(
  row: Pick<EventRow, "id" | "personal_state" | "personal_version" | "personal_updated_at">,
) {
  return {
    schemaVersion: "NotificationReadStateV1",
    notificationId: row.id,
    state: row.personal_state ?? "unread",
    version: row.personal_version ?? 0,
    updatedAt: row.personal_updated_at,
  };
}
function item(row: EventRow) {
  let facts: Record<string, unknown>;
  try {
    facts = JSON.parse(row.summary_json) as Record<string, unknown>;
  } catch {
    return corrupt();
  }
  const common = {
    schemaVersion: "NotificationEventV1",
    id: row.id,
    repositoryId: row.repository_id,
    workItemId: row.work_item_id,
    workItemKind: row.work_item_kind,
    number: row.work_item_number,
    reviewRunId: row.review_run_id,
    revisionKey: row.revision_key,
    sourceId: row.source_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
  let event: unknown;
  if (row.source_kind === "validation_job_terminal") {
    let result = null;
    if (row.outcome === "succeeded") {
      const check = facts.checks as {
        passed: number;
        failed: number;
        blocked: number;
        notRun: number;
        skipped: number;
        inconclusive: number;
        requiredNonPassed: number;
      };
      if (!check) corrupt();
      const checkCounts = {
        passed: check.passed,
        failed: check.failed,
        blocked: check.blocked,
        not_run: check.notRun,
        skipped: check.skipped,
        inconclusive: check.inconclusive,
      };
      result = {
        resultId: facts.resultId,
        checks: {
          total: Object.values(checkCounts).reduce((sum, count) => sum + count, 0),
          ...checkCounts,
        },
        requiredNonPassed: check.requiredNonPassed,
        lifecycleBlockers: facts.blockerCount,
        evidenceComplete: facts.evidenceComplete === 1,
        sourceState: facts.sourceState,
        cleanupState: facts.cleanupState,
      };
    }
    event = {
      ...common,
      kind: "validation",
      jobId: row.job_id,
      requestId: row.request_id,
      jobActivation: row.job_activation,
      runAttemptId: row.run_attempt_id,
      workflowKind: row.workflow_kind,
      target: row.target,
      jobStatus: row.outcome,
      result,
    };
  } else {
    event = {
      ...common,
      kind: "publication",
      publicationId: row.publication_id,
      attemptKind: facts.attemptKind,
      attemptNumber: facts.attemptNumber,
      outcome: row.outcome,
      failureCode: facts.failureCode,
    };
  }
  const result = checked(C.NotificationItemV1Schema, { event, state: readState(row) });
  if (C.getNotificationItemIssues(result).length) corrupt();
  return result;
}
function filter(query: ListQuery): ListFilter {
  if (
    !Value.Check(C.NotificationListQuerySchema, query) ||
    C.getNotificationListQueryIssues(query).length
  )
    invalid();
  object(query, ["cursor", "limit", "state", "workItemKind"]);
  const state = query.state ?? "all",
    workItemKind = query.workItemKind ?? "all";
  if (
    !["all", "unread", "read", "archived"].includes(state) ||
    !["all", "pull_request", "issue"].includes(workItemKind)
  )
    invalid();
  return { state, workItemKind };
}
function list(
  db: DatabaseSync,
  input: NotificationOperationMap["listRepositoryNotifications"]["input"],
  now: string,
  administrators: readonly OperatorPrincipal[],
) {
  object(input, ["actor", "repositoryId", "query"]);
  assertRepositoryPermission(db, input.actor, input.repositoryId, "read", administrators);
  const selected = filter(input.query),
    limit = input.query.limit ?? 20;
  integer(limit, 1, 50);
  let before: number | null = null;
  if (input.query.cursor !== undefined) {
    if (!/^[1-9][0-9]{0,15}$/u.test(input.query.cursor)) invalid();
    before = Number(input.query.cursor);
    integer(before, 1, Number.MAX_SAFE_INTEGER);
  }
  const boundary = retention(db);
  const currentCounts = repositoryCounts(
    db,
    input.repositoryId,
    input.actor,
    boundary.retainedAfter,
  );
  const candidates =
    currentCounts.total === 0
      ? []
      : (db
          .prepare(`WITH candidates AS MATERIALIZED (
    SELECT * FROM notification_events WHERE repository_id = ? ${before === null ? "" : "AND sequence < ?"}
    ORDER BY sequence DESC LIMIT 256)
    SELECT event.*, personal.state AS personal_state,
    personal.version AS personal_version, personal.updated_at AS personal_updated_at
    FROM candidates AS event LEFT JOIN notification_read_states AS personal
      ON personal.notification_id = event.id AND personal.repository_id = event.repository_id
      AND personal.principal_issuer = ? AND personal.principal_subject = ?
    ORDER BY event.sequence DESC`)
          .all(
            input.repositoryId,
            ...(before === null ? [] : [before]),
            input.actor.issuer,
            input.actor.subject,
          ) as unknown as EventRow[]);
  const items: ReturnType<typeof item>[] = [];
  let consumed = 0;
  for (const row of candidates) {
    consumed++;
    if (
      row.recorded_at >= boundary.retainedAfter &&
      (selected.state === "all" || (row.personal_state ?? "unread") === selected.state) &&
      (selected.workItemKind === "all" || row.work_item_kind === selected.workItemKind)
    )
      items.push(item(row));
    if (items.length === limit) break;
  }
  const last = candidates[consumed - 1];
  const hasMore =
    last !== undefined &&
    (consumed < candidates.length ||
      db
        .prepare(`SELECT 1 FROM notification_events
    WHERE repository_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1`)
        .get(input.repositoryId, last.sequence) !== undefined);
  const result = checked(C.NotificationListV1Schema, {
    schemaVersion: "NotificationListV1",
    repositoryId: input.repositoryId,
    actor: input.actor,
    observedAt: now,
    ...boundary,
    filter: selected,
    limit,
    items,
    nextCursor: hasMore && last ? String(last.sequence) : null,
    scanLimited: consumed === 256 && items.length < limit && hasMore,
  });
  if (
    C.getNotificationListIssues(result, {
      actor: input.actor,
      repositoryId: input.repositoryId,
      query: input.query,
    }).length
  )
    corrupt();
  return result;
}
function change(
  db: DatabaseSync,
  input: NotificationOperationMap["changeNotificationStates"]["input"],
  now: string,
  administrators: readonly OperatorPrincipal[],
) {
  object(input, ["actor", "repositoryId", "request"]);
  assertRepositoryPermission(db, input.actor, input.repositoryId, "read", administrators);
  const request = input.request;
  if (
    !Value.Check(C.NotificationStateChangeRequestSchema, request) ||
    C.getNotificationStateChangeRequestIssues(request).length ||
    Buffer.byteLength(JSON.stringify(request), "utf8") > C.maximumNotificationRequestUtf8Bytes
  )
    invalid();
  object(request, ["changeId", "changes"]);
  entity(request.changeId);
  if (!Array.isArray(request.changes)) invalid();
  integer(request.changes.length, 1, 50);
  const ids = new Set<string>();
  for (const entry of request.changes) {
    object(entry, ["notificationId", "expectedVersion", "state"]);
    entity(entry.notificationId);
    integer(entry.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1);
    if (!["unread", "read", "archived"].includes(entry.state) || ids.has(entry.notificationId))
      invalid();
    ids.add(entry.notificationId);
  }
  const boundary = retention(db);
  const intentDigest = sha256(
    canonicalJson({ repositoryId: input.repositoryId, actor: input.actor, request }),
  );
  const prior = db
    .prepare(`SELECT intent_digest, receipt_digest, receipt_json, created_at, retention_day
    FROM notification_change_receipts WHERE repository_id = ? AND principal_issuer = ? AND principal_subject = ? AND change_id = ?`)
    .get(input.repositoryId, input.actor.issuer, input.actor.subject, request.changeId) as
    | {
        intent_digest: string;
        receipt_digest: string;
        receipt_json: string;
        created_at: string;
        retention_day: string;
      }
    | undefined;
  if (prior) {
    if (prior.retention_day < boundary.retainedAfter.slice(0, 10))
      conflict("The original notification receipt has expired.");
    if (prior.intent_digest !== intentDigest)
      conflict("This change identifier belongs to another notification request.");
    if (sha256(prior.receipt_json) !== prior.receipt_digest) corrupt();
    let stored: unknown;
    try {
      stored = JSON.parse(prior.receipt_json);
    } catch {
      return corrupt();
    }
    const replay = checked(C.NotificationStateChangeV1Schema, stored);
    if (
      replay.replayed ||
      C.getNotificationStateChangeIssues(replay, request, {
        actor: input.actor,
        repositoryId: input.repositoryId,
      }).length
    )
      corrupt();
    return { ...replay, replayed: true };
  }
  const changes = [];
  let retentionDay: string | undefined;
  for (const entry of request.changes) {
    const event = db
      .prepare(`SELECT event.id, event.recorded_day, event.recorded_at, personal.state AS personal_state,
      personal.version AS personal_version, personal.updated_at AS personal_updated_at
      FROM notification_events AS event LEFT JOIN notification_read_states AS personal
      ON personal.notification_id = event.id AND personal.repository_id = event.repository_id
        AND personal.principal_issuer = ? AND personal.principal_subject = ?
      WHERE event.repository_id = ? AND event.id = ? AND event.recorded_at >= ?`)
      .get(
        input.actor.issuer,
        input.actor.subject,
        input.repositoryId,
        entry.notificationId,
        boundary.retainedAfter,
      ) as
      | Pick<
          EventRow,
          | "id"
          | "recorded_day"
          | "recorded_at"
          | "personal_state"
          | "personal_version"
          | "personal_updated_at"
        >
      | undefined;
    if (!event) notFound();
    if (retentionDay === undefined || event.recorded_day < retentionDay)
      retentionDay = event.recorded_day;
    const previousVersion = event.personal_version ?? 0;
    if (entry.expectedVersion !== previousVersion) conflict();
    if (
      now < event.recorded_at ||
      (event.personal_updated_at !== null && now < event.personal_updated_at)
    )
      conflict("The notification observation time precedes its current state.");
    const state = {
      schemaVersion: "NotificationReadStateV1",
      notificationId: entry.notificationId,
      state: entry.state,
      version: previousVersion + 1,
      updatedAt: now,
    };
    if (previousVersion === 0)
      db.prepare(`INSERT INTO notification_read_states
      (repository_id, notification_id, recorded_day, principal_issuer, principal_subject, state, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(
        input.repositoryId,
        entry.notificationId,
        event.recorded_day,
        input.actor.issuer,
        input.actor.subject,
        entry.state,
        now,
      );
    else {
      const changed = db
        .prepare(`UPDATE notification_read_states SET state = ?, version = version + 1, updated_at = ?
        WHERE repository_id = ? AND notification_id = ? AND principal_issuer = ? AND principal_subject = ? AND version = ?`)
        .run(
          entry.state,
          now,
          input.repositoryId,
          entry.notificationId,
          input.actor.issuer,
          input.actor.subject,
          previousVersion,
        );
      if (changed.changes !== 1) conflict();
    }
    changes.push({ notificationId: entry.notificationId, previousVersion, state });
  }
  const receipt = checked(C.NotificationStateChangeV1Schema, {
    schemaVersion: "NotificationStateChangeV1",
    repositoryId: input.repositoryId,
    actor: input.actor,
    changeId: request.changeId,
    createdAt: now,
    changes,
    replayed: false,
  });
  if (
    C.getNotificationStateChangeIssues(receipt, request, {
      actor: input.actor,
      repositoryId: input.repositoryId,
    }).length
  )
    corrupt();
  const raw = canonicalJson(receipt);
  db.prepare(`INSERT INTO notification_change_receipts
    (id, repository_id, principal_issuer, principal_subject, change_id, intent_digest, receipt_digest, receipt_json, created_at, retention_day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(),
    input.repositoryId,
    input.actor.issuer,
    input.actor.subject,
    request.changeId,
    intentDigest,
    sha256(raw),
    raw,
    now,
    retentionDay ?? corrupt(),
  );
  return receipt;
}
function maintenance(
  db: DatabaseSync,
  input: NotificationOperationMap["maintainNotifications"]["input"],
  now: string,
): NotificationMaintenanceResult {
  object(input, ["limit"]);
  const limit = input.limit ?? 128;
  integer(limit, 1, 128);
  const boundary = retention(db);
  // Keep the current UTC calendar day and the preceding 89 days.
  const today = Date.parse(`${now.slice(0, 10)}T00:00:00.000Z`);
  const next = new Date(today - 89 * 86_400_000).toISOString();
  const retainedAfter = next > boundary.retainedAfter ? next : boundary.retainedAfter;
  if (retainedAfter !== boundary.retainedAfter)
    db.prepare("UPDATE notification_retention SET retained_after = ? WHERE singleton = 1").run(
      retainedAfter,
    );
  const result = {
    retainedAfter,
    deletedStates: 0,
    deletedReceipts: 0,
    deletedEvents: 0,
    deletedCounters: 0,
    hasMore: false,
  };
  const day = retainedAfter.slice(0, 10);
  const expired = [
    {
      table: "notification_read_states",
      condition: "recorded_day < ?",
      value: day,
      output: "deletedStates",
    },
    {
      table: "notification_change_receipts",
      condition: "retention_day < ?",
      value: day,
      output: "deletedReceipts",
    },
    {
      table: "notification_events",
      condition: "recorded_at < ?",
      value: retainedAfter,
      output: "deletedEvents",
    },
    {
      table: "notification_principal_counters",
      condition: "recorded_day < ? AND read_count = 0 AND archived_count = 0",
      value: day,
      output: "deletedCounters",
    },
  ] as const;
  for (const phase of expired) {
    const rows = db
      .prepare(`SELECT rowid AS id FROM ${phase.table} WHERE ${phase.condition} LIMIT ?`)
      .all(phase.value, limit) as { id: number }[];
    if (rows.length === 0) continue;
    const statement = db.prepare(`DELETE FROM ${phase.table} WHERE rowid = ?`);
    for (const row of rows) statement.run(row.id);
    result[phase.output] = rows.length;
    break;
  }
  result.hasMore = expired.some(
    (phase) =>
      db
        .prepare(`SELECT 1 FROM ${phase.table} WHERE ${phase.condition} LIMIT 1`)
        .get(phase.value) !== undefined,
  );
  return result;
}

export function handleNotificationRequest(
  database: DatabaseSync,
  request: NotificationRequest,
  now: string,
  administrators: readonly OperatorPrincipal[] = [],
): unknown {
  timestamp(now);
  object(request, ["operation", "input"]);
  if (!isNotificationOperation(request.operation)) invalid();
  const mutation =
    request.operation === "changeNotificationStates" ||
    request.operation === "maintainNotifications";
  return transaction(database, mutation, () => {
    if (request.operation !== "maintainNotifications")
      isPlatformAdministrator(request.input.actor, administrators);
    switch (request.operation) {
      case "listNotificationOverview":
        return overview(database, request.input, now, administrators);
      case "getNotificationSummary":
        return summary(database, request.input, now, administrators);
      case "listRepositoryNotifications":
        return list(database, request.input, now, administrators);
      case "changeNotificationStates":
        return change(database, request.input, now, administrators);
      case "maintainNotifications":
        return maintenance(database, request.input, now);
    }
  });
}
