import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type JobAdmission,
  type JobExecutionTemplate,
  type JobState,
  JobStateSchema,
  maximumClaimLeaseResponseUtf8Bytes,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type OperatorReadContext, repositoryReadSql } from "./operator-access.js";
import { parseExecutionTemplate } from "./scheduling-eligibility.js";

export type JobAdmissionOwnershipState =
  | "resolved"
  | "invalid_template"
  | "unverified"
  | "conflict"
  | "unscoped";

export interface StoredJobAdmission {
  readonly jobId: string;
  readonly state: "pending" | "admitted";
  readonly attemptBase: number;
  readonly episodeSequence: number;
  readonly requestedAt: string;
  readonly timestampBasis: "recorded" | "migration_backfill";
  readonly admittedAt: string | null;
  readonly bucketKey: string;
  readonly githubRepositoryId: number | null;
  readonly ownershipState: JobAdmissionOwnershipState;
  readonly lastCheckedAt: string | null;
  readonly lastInspectionSequence: number;
  readonly blockers: readonly string[];
}

export class JobAdmissionError extends Error {
  constructor(
    readonly code: "PLATFORM_CORRUPT" | "PLATFORM_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "JobAdmissionError";
  }
}

function corrupt(): never {
  throw new JobAdmissionError("PLATFORM_CORRUPT", "The stored job admission is inconsistent.");
}
function canonicalTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) && time.toISOString() === value;
}
function requireTransaction(database: DatabaseSync, now?: string): void {
  if (!database.isTransaction) corrupt();
  if (now !== undefined && !canonicalTime(now))
    throw new JobAdmissionError("PLATFORM_INVALID", "The admission timestamp is invalid.");
}
function safeInteger(value: unknown, minimum = 0): number {
  if (typeof value !== "bigint" && typeof value !== "number") corrupt();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) corrupt();
  return number;
}
function optionalRepositoryNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
const waiting = (status: string): boolean => status === "queued" || status === "retry_waiting";
const active = (status: string): boolean =>
  status === "leased" || status === "running" || status === "cancel_requested";

interface JobRow {
  id: string;
  status: JobState;
  attempt_count: bigint;
  current_run_attempt_id: string | null;
  work_item_id: string | null;
  repository_id: string | null;
  github_repository_id: bigint | null;
  managed_github_repository_id: bigint | null;
  item_kind: string | null;
  item_node_id: string | null;
  item_number: bigint | null;
  resource_revision: string;
  request_epoch_id: string | null;
  execution_json: string | null;
}

function loadJob(database: DatabaseSync, jobId: string, fullTemplate = false): JobRow {
  const statement = database.prepare(`SELECT job.id, job.status, job.attempt_count,
    job.current_run_attempt_id, job.work_item_id, job.resource_revision, job.request_epoch_id,
    item.repository_id, repository.github_repository_id,
    managed.github_repository_id AS managed_github_repository_id,
    item.resource_kind AS item_kind, item.github_node_id AS item_node_id,
    item.github_number AS item_number,
    ${fullTemplate ? "job.execution_json" : `CASE WHEN length(CAST(job.execution_json AS BLOB)) <= ${maximumClaimLeaseResponseUtf8Bytes} THEN job.execution_json ELSE NULL END`} AS execution_json
    FROM jobs AS job LEFT JOIN work_items AS item ON item.id = job.work_item_id
    LEFT JOIN repositories AS repository ON repository.id = item.repository_id
    LEFT JOIN managed_repositories AS managed ON managed.id = item.repository_id
    WHERE job.id = ?`);
  statement.setReadBigInts(true);
  const row = statement.get(jobId) as unknown as JobRow | undefined;
  if (!row || typeof row.id !== "string" || !Value.Check(JobStateSchema, row.status)) corrupt();
  safeInteger(row.attempt_count);
  return row;
}

// Migration execution also runs without the DatabaseWorker bootstrap. Register only the
// same production formats if that bootstrap has not already registered them.
function ensureParserFormats(): void {
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
}

interface Ownership {
  readonly bucketKey: string;
  readonly githubRepositoryId: number | null;
  readonly ownershipState: JobAdmissionOwnershipState;
}
function ownership(row: JobRow): Ownership {
  const associatedNumber = optionalRepositoryNumber(row.github_repository_id);
  const result = (state: JobAdmissionOwnershipState, number = associatedNumber): Ownership => ({
    ownershipState: state,
    githubRepositoryId: number,
    bucketKey: number === null ? "unscoped" : `github:${number}`,
  });
  if (
    row.work_item_id !== null &&
    (row.repository_id === null ||
      associatedNumber === null ||
      (row.managed_github_repository_id !== null &&
        optionalRepositoryNumber(row.managed_github_repository_id) !== associatedNumber))
  )
    return result("conflict");
  if (row.execution_json === null) return result("unverified");
  ensureParserFormats();
  const parsed = parseExecutionTemplate(row.execution_json);
  if (!parsed.ok) return result("invalid_template");
  const template = parsed.template;
  const number = optionalRepositoryNumber(template.repository.githubRepositoryId);
  if (number === null) return result("invalid_template");
  if (row.work_item_id === null)
    return "validation" in template ? result("conflict") : result("resolved", number);
  if (
    number !== associatedNumber ||
    template.resource.kind !== row.item_kind ||
    template.resource.githubNodeId !== row.item_node_id ||
    template.resource.number !== optionalRepositoryNumber(row.item_number) ||
    ("validation" in template &&
      (template.validation.repositoryId !== row.repository_id ||
        template.validation.workItemId !== row.work_item_id ||
        template.validation.profileVersion.repositoryId !== row.repository_id ||
        template.validation.requestEpochId !== row.request_epoch_id ||
        template.validation.revisionKey !== row.resource_revision))
  )
    return result("conflict");
  return result("resolved");
}

interface PublicRow {
  state: unknown;
  attempt_base: unknown;
  requested_at: unknown;
  timestamp_basis: unknown;
  admitted_at: unknown;
}
function decodePublic(row: PublicRow | undefined): JobAdmission {
  if (
    !row ||
    !canonicalTime(row.requested_at) ||
    (row.timestamp_basis !== "recorded" && row.timestamp_basis !== "migration_backfill")
  )
    corrupt();
  const common: Pick<JobAdmission, "attemptBase" | "requestedAt" | "timestampBasis"> = {
    attemptBase: safeInteger(row.attempt_base),
    requestedAt: row.requested_at,
    timestampBasis: row.timestamp_basis,
  };
  if (row.state === "pending" && row.admitted_at === null)
    return { ...common, state: "pending", admittedAt: null };
  if (row.state === "admitted" && canonicalTime(row.admitted_at))
    return { ...common, state: "admitted", admittedAt: row.admitted_at };
  corrupt();
}

export function readJobAdmission(
  database: DatabaseSync,
  input: { readonly jobId: string; readonly status: JobState; readonly attemptCount: number },
): JobAdmission | null {
  if (!Value.Check(JobStateSchema, input.status)) corrupt();
  safeInteger(input.attemptCount);
  const statement = database.prepare(`SELECT state, attempt_base, requested_at,
    timestamp_basis, admitted_at FROM job_admission WHERE job_id = ?`);
  statement.setReadBigInts(true);
  const admission = decodePublic(statement.get(input.jobId) as unknown as PublicRow | undefined);
  if (waiting(input.status)) {
    if (admission.attemptBase !== input.attemptCount) corrupt();
    return admission;
  }
  if (admission.attemptBase > input.attemptCount) corrupt();
  return null;
}

export function getJobAdmissionRecord(database: DatabaseSync, jobId: string): StoredJobAdmission {
  const statement = database.prepare("SELECT * FROM job_admission WHERE job_id = ?");
  statement.setReadBigInts(true);
  const row = statement.get(jobId) as (PublicRow & Record<string, unknown>) | undefined;
  const projection = decodePublic(row);
  if (
    !row ||
    typeof row.job_id !== "string" ||
    typeof row.bucket_key !== "string" ||
    typeof row.ownership_state !== "string" ||
    !["resolved", "invalid_template", "unverified", "conflict", "unscoped"].includes(
      row.ownership_state,
    ) ||
    (row.last_checked_at !== null && !canonicalTime(row.last_checked_at)) ||
    typeof row.blockers_json !== "string" ||
    Buffer.byteLength(row.blockers_json, "utf8") > 8192
  )
    corrupt();
  const githubRepositoryId =
    row.github_repository_id === null ? null : safeInteger(row.github_repository_id, 1);
  if (
    row.bucket_key !==
      (githubRepositoryId === null ? "unscoped" : `github:${githubRepositoryId}`) ||
    (row.ownership_state === "resolved" && githubRepositoryId === null)
  )
    corrupt();
  let blockers: unknown;
  try {
    blockers = JSON.parse(row.blockers_json) as unknown;
  } catch {
    corrupt();
  }
  if (
    !Array.isArray(blockers) ||
    blockers.length > 32 ||
    blockers.some(
      (value: unknown) => typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value),
    )
  )
    corrupt();
  return {
    ...projection,
    jobId: row.job_id,
    episodeSequence: safeInteger(row.episode_sequence, 1),
    bucketKey: row.bucket_key,
    githubRepositoryId,
    ownershipState: row.ownership_state as JobAdmissionOwnershipState,
    lastCheckedAt: row.last_checked_at as string | null,
    lastInspectionSequence: safeInteger(row.last_inspection_sequence),
    blockers: blockers as string[],
  };
}

/** Validate before applying admission filters or aggregation, so a missing/stale row cannot
 * disappear from a scoped result. Authorization is based only on the real work-item link. */
export function assertWaitingAdmissionIntegrity(
  database: DatabaseSync,
  scope: { readonly repositoryId?: string; readonly context?: OperatorReadContext } = {},
): void {
  const clauses = ["job.status IN ('queued', 'retry_waiting')"];
  const parameters: SQLInputValue[] = [];
  if (scope.repositoryId !== undefined) {
    clauses.push("item.repository_id = ?");
    parameters.push(scope.repositoryId);
  }
  if (scope.context !== undefined) {
    const visibility = repositoryReadSql(
      "item.repository_id",
      scope.context.actor,
      scope.context.administrators,
    );
    clauses.push(visibility.sql);
    parameters.push(...visibility.parameters);
  }
  const row = database
    .prepare(`SELECT 1 FROM jobs AS job
    LEFT JOIN work_items AS item ON item.id = job.work_item_id
    LEFT JOIN job_admission AS admission ON admission.job_id = job.id
    WHERE ${clauses.join(" AND ")} AND (
      admission.job_id IS NULL OR admission.attempt_base IS NOT job.attempt_count
      OR admission.attempt_base NOT BETWEEN 0 AND 9007199254740991
      OR admission.state IS NULL OR admission.state NOT IN ('pending', 'admitted')
      OR admission.timestamp_basis IS NULL OR admission.timestamp_basis NOT IN ('recorded', 'migration_backfill')
      OR admission.requested_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', admission.requested_at) IS NOT admission.requested_at
      OR (admission.state = 'pending' AND admission.admitted_at IS NOT NULL)
      OR (admission.state = 'admitted' AND (admission.admitted_at IS NULL
        OR strftime('%Y-%m-%dT%H:%M:%fZ', admission.admitted_at) IS NOT admission.admitted_at))
    ) LIMIT 1`)
    .get(...parameters);
  if (row !== undefined) corrupt();
}

function allocateEpisode(database: DatabaseSync): number {
  const statement =
    database.prepare(`UPDATE scheduling_state SET episode_sequence = episode_sequence + 1
    WHERE singleton = 1 AND episode_sequence < 9007199254740991 RETURNING episode_sequence`);
  statement.setReadBigInts(true);
  const row = statement.get() as { episode_sequence: bigint } | undefined;
  if (!row) corrupt();
  return safeInteger(row.episode_sequence, 1);
}
function requireUnleasedWaiting(database: DatabaseSync, row: JobRow): void {
  if (
    !waiting(row.status) ||
    row.current_run_attempt_id !== null ||
    database
      .prepare(
        "SELECT 1 FROM run_attempts WHERE job_id = ? AND status IN ('leased', 'running') LIMIT 1",
      )
      .get(row.id)
  )
    corrupt();
}

function insertAdmission(
  database: DatabaseSync,
  row: JobRow,
  now: string,
  migration: boolean,
): StoredJobAdmission {
  const attemptCount = safeInteger(row.attempt_count);
  const attemptBase = migration && active(row.status) ? attemptCount - 1 : attemptCount;
  if (attemptBase < 0) corrupt();
  const owner = ownership(row);
  const episode = allocateEpisode(database);
  const state = migration && waiting(row.status) ? "admitted" : "pending";
  database
    .prepare(`INSERT INTO job_admission (job_id, state, attempt_base, episode_sequence,
    requested_at, timestamp_basis, admitted_at, bucket_key, github_repository_id, ownership_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id,
      state,
      attemptBase,
      episode,
      now,
      migration ? "migration_backfill" : "recorded",
      state === "admitted" ? now : null,
      owner.bucketKey,
      owner.githubRepositoryId,
      owner.ownershipState,
    );
  return getJobAdmissionRecord(database, row.id);
}

export function createJobAdmissionInTransaction(
  database: DatabaseSync,
  jobId: string,
  now: string,
): StoredJobAdmission {
  requireTransaction(database, now);
  const row = loadJob(database, jobId);
  requireUnleasedWaiting(database, row);
  if (database.prepare("SELECT 1 FROM job_admission WHERE job_id = ?").get(jobId)) corrupt();
  return insertAdmission(database, row, now, false);
}

export function beginRetryAdmissionInTransaction(
  database: DatabaseSync,
  jobId: string,
  now: string,
): StoredJobAdmission {
  requireTransaction(database, now);
  const row = loadJob(database, jobId);
  if (row.status !== "retry_waiting") corrupt();
  requireUnleasedWaiting(database, row);
  const old = getJobAdmissionRecord(database, jobId);
  const attemptCount = safeInteger(row.attempt_count);
  if (old.attemptBase === attemptCount) return old;
  if (old.attemptBase + 1 !== attemptCount) corrupt();
  const sequence = allocateEpisode(database);
  database
    .prepare(`UPDATE job_admission SET state = 'pending', attempt_base = ?, episode_sequence = ?,
    requested_at = ?, timestamp_basis = 'recorded', admitted_at = NULL,
    last_checked_at = NULL, last_inspection_sequence = 0, blockers_json = '[]' WHERE job_id = ?`)
    .run(attemptCount, sequence, now, jobId);
  return getJobAdmissionRecord(database, jobId);
}

/** A trusted claim witness may refine a bounded backfill's unknown ownership. Reparse the
 * persisted bytes here, rather than letting any caller-provided bucket establish authority. */
export function refineJobAdmissionOwnershipInTransaction(
  database: DatabaseSync,
  jobId: string,
  _parsedTemplate: JobExecutionTemplate,
): StoredJobAdmission {
  requireTransaction(database);
  const old = getJobAdmissionRecord(database, jobId);
  if (old.ownershipState !== "unverified" && old.ownershipState !== "unscoped") return old;
  const row = loadJob(database, jobId, true);
  requireUnleasedWaiting(database, row);
  if (old.attemptBase !== safeInteger(row.attempt_count)) corrupt();
  const owner = ownership(row);
  if (owner.ownershipState !== "resolved") return old;
  database
    .prepare(`UPDATE job_admission SET ownership_state = 'resolved', bucket_key = ?,
    github_repository_id = ? WHERE job_id = ?`)
    .run(owner.bucketKey, owner.githubRepositoryId, jobId);
  return getJobAdmissionRecord(database, jobId);
}

/** Called only by the exact migration-24 transaction, never as a startup repair. */
export function backfillJobAdmissions(database: DatabaseSync, now: string): void {
  requireTransaction(database, now);
  const state = database
    .prepare("SELECT backfill_complete FROM scheduling_state WHERE singleton = 1")
    .get();
  if (!state || state.backfill_complete !== 0) corrupt();
  let after: string | undefined;
  for (;;) {
    const rows = database
      .prepare(`SELECT id FROM jobs ${after === undefined ? "" : "WHERE id > ?"}
      ORDER BY id LIMIT 128`)
      .all(...(after === undefined ? [] : [after])) as { id: string }[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (typeof row.id !== "string") corrupt();
      insertAdmission(database, loadJob(database, row.id), now, true);
      after = row.id;
    }
  }
  database.prepare("UPDATE scheduling_state SET backfill_complete = 1 WHERE singleton = 1").run();
}
