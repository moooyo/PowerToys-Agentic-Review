import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  SchedulingConfiguration,
  SchedulingLimits,
  SchedulingOverage,
  SchedulingUsage,
} from "@agentic-review/contracts";
import { assertWaitingAdmissionIntegrity } from "./job-admission.js";

export interface RepositorySchedulingPolicy {
  readonly repositoryId: string;
  readonly githubRepositoryId: number;
  readonly version: number;
  readonly enabled: boolean;
  readonly limits: SchedulingLimits;
}

function corrupt(message: string): never {
  throw Object.assign(new Error(message), { code: "PLATFORM_CORRUPT" });
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" && typeof value !== "bigint")
    corrupt("A scheduling count is not an integer.");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    corrupt("A scheduling count exceeds its supported range.");
  return result;
}

function limits(row: { max_active_leases: unknown; max_queued_jobs: unknown }): SchedulingLimits {
  return {
    maxActiveLeases:
      row.max_active_leases === null ? null : integer(row.max_active_leases, 1, 65_535),
    maxQueuedJobs: row.max_queued_jobs === null ? null : integer(row.max_queued_jobs, 1, 1_000_000),
  };
}

function repositoryNumber(bucketKey: string): number | null {
  if (bucketKey === "unscoped") return null;
  if (!/^github:[1-9]\d*$/u.test(bucketKey))
    corrupt("The scheduling repository bucket is invalid.");
  const result = integer(Number(bucketKey.slice(7)), 1);
  if (bucketKey !== `github:${result}`) corrupt("The scheduling repository bucket is invalid.");
  return result;
}

/** Configuration follows the upstream numeric identity across renames and later management. */
export function resolveRepositorySchedulingPolicy(
  database: DatabaseSync,
  bucketKey: string,
): RepositorySchedulingPolicy | null {
  const githubRepositoryId = repositoryNumber(bucketKey);
  if (githubRepositoryId === null) return null;
  const statement = database.prepare(`SELECT id, github_repository_id, version, enabled,
    max_active_leases, max_queued_jobs FROM managed_repositories WHERE github_repository_id = ?`);
  statement.setReadBigInts(true);
  const row = statement.get(githubRepositoryId) as
    | {
        id: string;
        github_repository_id: bigint;
        version: bigint;
        enabled: bigint;
        max_active_leases: bigint | null;
        max_queued_jobs: bigint | null;
      }
    | undefined;
  if (!row) return null;
  if (typeof row.id !== "string" || row.id.length === 0)
    corrupt("The scheduling repository configuration is invalid.");
  return {
    repositoryId: row.id,
    githubRepositoryId: integer(row.github_repository_id, 1),
    version: integer(row.version, 1),
    enabled: integer(row.enabled, 0, 1) === 1,
    limits: limits(row),
  };
}

export function readPlatformSchedulingConfiguration(
  database: DatabaseSync,
): SchedulingConfiguration {
  const statement = database.prepare(`SELECT version, max_active_leases, max_queued_jobs,
    policy_id, updated_at FROM platform_scheduling_configuration WHERE singleton = 1`);
  statement.setReadBigInts(true);
  const row = statement.get() as
    | {
        version: bigint;
        max_active_leases: bigint | null;
        max_queued_jobs: bigint | null;
        policy_id: string;
        updated_at: string;
      }
    | undefined;
  if (
    row?.policy_id !== "repository-service-v1" ||
    typeof row.updated_at !== "string" ||
    !Number.isFinite(Date.parse(row.updated_at)) ||
    new Date(row.updated_at).toISOString() !== row.updated_at
  )
    corrupt("The platform scheduling configuration is invalid.");
  return {
    version: integer(row.version, 1),
    limits: limits(row),
    policyId: "repository-service-v1",
    updatedAt: row.updated_at,
  };
}

/** Active attempts never disappear because their Job was cancelled or their Worker went away.
 * A known ownership conflict blocks grants instead of silently charging the wrong repository. */
export function assertActiveSchedulingIntegrity(database: DatabaseSync): void {
  const invalid = database
    .prepare(`SELECT attempt.id FROM run_attempts AS attempt
      JOIN jobs AS job ON job.id = attempt.job_id
      LEFT JOIN job_admission AS admission ON admission.job_id = job.id
      LEFT JOIN work_items AS item ON item.id = job.work_item_id
      LEFT JOIN repositories AS repository ON repository.id = item.repository_id
      LEFT JOIN managed_repositories AS managed ON managed.id = item.repository_id
      WHERE attempt.status IN ('leased', 'running') AND (
        admission.job_id IS NULL OR admission.ownership_state = 'conflict'
        OR admission.bucket_key IS NULL
        OR (admission.github_repository_id IS NULL AND admission.bucket_key != 'unscoped')
        OR (admission.github_repository_id IS NOT NULL AND
          admission.bucket_key != 'github:' || CAST(admission.github_repository_id AS TEXT))
        OR (job.work_item_id IS NOT NULL AND (item.id IS NULL OR repository.id IS NULL
          OR repository.github_repository_id IS NOT admission.github_repository_id
          OR (managed.id IS NOT NULL AND managed.github_repository_id IS NOT repository.github_repository_id)))
      ) LIMIT 1`)
    .get();
  if (invalid)
    corrupt("Active attempt ownership is inconsistent; new scheduling service is blocked.");
}

/** Integrity must already have been checked in this transaction. Counts are always fresh,
 * including at the actual grant boundary after earlier candidates consumed capacity. */
export function readSchedulingActiveLeaseCount(database: DatabaseSync, bucketKey?: string): number {
  if (bucketKey !== undefined) repositoryNumber(bucketKey);
  const statement = database.prepare(`SELECT COUNT(*) AS count
    FROM run_attempts AS attempt JOIN job_admission AS admission ON admission.job_id = attempt.job_id
    WHERE attempt.status IN ('leased', 'running')${bucketKey === undefined ? "" : " AND admission.bucket_key = ?"}`);
  statement.setReadBigInts(true);
  const row = statement.get(...(bucketKey === undefined ? [] : [bucketKey])) as { count: bigint };
  return integer(row.count);
}

/** Call inside the same synchronous snapshot used for authorization or the admission/grant.
 * All counters use compact relational ownership; execution templates are never parsed here. */
export function readSchedulingUsage(
  database: DatabaseSync,
  scope: { readonly bucketKey?: string; readonly integrityAlreadyChecked?: boolean } = {},
): SchedulingUsage {
  const githubRepositoryId =
    scope.bucketKey === undefined ? undefined : repositoryNumber(scope.bucketKey);
  if (!scope.integrityAlreadyChecked) {
    assertWaitingAdmissionIntegrity(database);
    assertActiveSchedulingIntegrity(database);
  } else if (!database.isTransaction) {
    corrupt("Checked scheduling accounting requires the original transaction.");
  }
  const parameters: SQLInputValue[] = [];
  const bucketFilter = scope.bucketKey === undefined ? "" : " AND admission.bucket_key = ?";
  if (scope.bucketKey !== undefined) parameters.push(scope.bucketKey);
  const waitingStatement = database.prepare(`SELECT
      COUNT(CASE WHEN admission.state = 'admitted' THEN 1 END) AS admitted,
      COUNT(CASE WHEN admission.state = 'pending' THEN 1 END) AS pending
    FROM job_admission AS admission JOIN jobs AS job ON job.id = admission.job_id
    WHERE job.status IN ('queued', 'retry_waiting')${bucketFilter}`);
  waitingStatement.setReadBigInts(true);
  const waiting = waitingStatement.get(...parameters) as { admitted: bigint; pending: bigint };
  // M17's pending set is separate from accepted Jobs. Keep a defensive no-association predicate
  // so an inconsistent inspection bit cannot count a real Job as missing configuration.
  const requestStatement = database.prepare(`SELECT COUNT(*) AS count
    FROM validation_dispatch_checks AS checked
    JOIN managed_repositories AS repository ON repository.id = checked.repository_id
    WHERE checked.pending = 1
      AND NOT EXISTS (SELECT 1 FROM review_run_job_links AS link
        WHERE link.review_run_id = checked.review_run_id AND link.request_id = checked.request_id)
      ${githubRepositoryId === undefined ? "" : githubRepositoryId === null ? "AND 0 = 1" : "AND repository.github_repository_id = ?"}`);
  requestStatement.setReadBigInts(true);
  const requests = requestStatement.get(
    ...(githubRepositoryId === undefined || githubRepositoryId === null
      ? []
      : [githubRepositoryId]),
  ) as { count: bigint };
  return {
    activeLeases: readSchedulingActiveLeaseCount(database, scope.bucketKey),
    admittedQueuedJobs: integer(waiting.admitted),
    awaitingAdmissionJobs: integer(waiting.pending),
    awaitingConfigurationRequests: integer(requests.count),
  };
}

export function readSchedulingOverage(
  usage: SchedulingUsage,
  configuredLimits: SchedulingLimits,
): SchedulingOverage {
  return {
    activeLeases:
      configuredLimits.maxActiveLeases === null
        ? 0
        : Math.max(0, usage.activeLeases - configuredLimits.maxActiveLeases),
    admittedQueuedJobs:
      configuredLimits.maxQueuedJobs === null
        ? 0
        : Math.max(0, usage.admittedQueuedJobs - configuredLimits.maxQueuedJobs),
  };
}
