import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { maximumClaimLeaseResponseUtf8Bytes } from "@agentic-review/contracts";
import { readRepositorySchedulingService, type SchedulingWorkClass } from "./scheduling-service.js";

export interface SchedulingClaimWorker {
  readonly id: string;
  readonly instanceId: string;
  readonly protocolVersion: string;
  readonly capabilitiesDigest: string;
}

export interface FairClaimCandidate {
  readonly id: string;
  readonly job_kind: string;
  readonly generation: number;
  readonly intent_version: number;
  readonly semantic_key: string;
  readonly priority: number;
  readonly execution_json: string;
  readonly required_capabilities_json: string;
  readonly next_attempt_at: string;
  readonly created_at: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly lease_generation: number;
  readonly execution_affinity_node_id: string | null;
  readonly concurrency_key: string;
  readonly bucket_key: string;
  readonly work_class: SchedulingWorkClass;
  readonly episode_sequence: number;
  readonly claim_rank_at_ms: number;
}

interface Cursor {
  scope_kind: "coordinator" | "bucket" | "concurrency" | "affinity" | "backoff";
  scope_key: string;
  work_class: SchedulingWorkClass | "all";
  scan_kind: "coordinator" | "primary" | "recheck";
  pass_generation: number;
  high_water_sequence: number;
  after_rank_at_ms: number | null;
  after_episode_sequence: number;
  after_job_id: string;
  completed: number;
  dirty_generation: number;
  recheck_at: string;
  updated_at: string;
}

export interface InspectedClaimCandidate<T> {
  readonly value: T;
  readonly candidate: FairClaimCandidate;
  readonly bucketKey: string;
}

function corrupt(message: string): never {
  throw Object.assign(new Error(message), { code: "PLATFORM_CORRUPT" });
}

function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
    corrupt("The finite claim pass sequence is exhausted.");
  return value + 1;
}

function identity(worker: SchedulingClaimWorker): SQLInputValue[] {
  return [worker.id, worker.instanceId, worker.protocolVersion, worker.capabilitiesDigest];
}

function loadCursor(
  database: DatabaseSync,
  worker: SchedulingClaimWorker,
  key: Pick<Cursor, "scope_kind" | "scope_key" | "work_class" | "scan_kind">,
  now: string,
): Cursor {
  const row = database
    .prepare(`SELECT * FROM claim_scan_state WHERE worker_id = ?
    AND worker_instance_id = ? AND protocol_version = ? AND capabilities_digest = ?
    AND scope_kind = ? AND scope_key = ? AND work_class = ? AND scan_kind = ?`)
    .get(
      ...identity(worker),
      key.scope_kind,
      key.scope_key,
      key.work_class,
      key.scan_kind,
    ) as unknown as Cursor | undefined;
  return (
    row ?? {
      ...key,
      pass_generation: 0,
      high_water_sequence: 0,
      after_rank_at_ms: null,
      after_episode_sequence: 0,
      after_job_id: "",
      completed: 0,
      dirty_generation: 0,
      recheck_at: "1970-01-01T00:00:00.000Z",
      updated_at: now,
    }
  );
}

function saveCursor(database: DatabaseSync, worker: SchedulingClaimWorker, cursor: Cursor): void {
  database
    .prepare(`INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, pass_generation,
    high_water_sequence, after_rank_at_ms, after_episode_sequence, after_job_id, completed,
    dirty_generation, recheck_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
      scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
      pass_generation = excluded.pass_generation, high_water_sequence = excluded.high_water_sequence,
      after_rank_at_ms = excluded.after_rank_at_ms, after_episode_sequence = excluded.after_episode_sequence,
      after_job_id = excluded.after_job_id, completed = excluded.completed,
      dirty_generation = excluded.dirty_generation, recheck_at = excluded.recheck_at,
      updated_at = excluded.updated_at`)
    .run(
      ...identity(worker),
      cursor.scope_kind,
      cursor.scope_key,
      cursor.work_class,
      cursor.scan_kind,
      cursor.pass_generation,
      cursor.high_water_sequence,
      cursor.after_rank_at_ms,
      cursor.after_episode_sequence,
      cursor.after_job_id,
      cursor.completed,
      cursor.dirty_generation,
      cursor.recheck_at,
      cursor.updated_at,
    );
}

function restart(cursor: Cursor, generation: number, highWater: number, now: string): Cursor {
  return {
    ...cursor,
    pass_generation: generation,
    high_water_sequence: highWater,
    after_rank_at_ms: null,
    after_episode_sequence: 0,
    after_job_id: "",
    completed: 0,
    updated_at: now,
  };
}

/** A finite pass never admits newer episodes into its search. Compatibility history belongs to
 * one exact Worker instance/protocol/capability identity; ordinary heartbeats do not reset it. */
export function inspectFairClaimCandidates<T>(
  database: DatabaseSync,
  worker: SchedulingClaimWorker,
  now: string,
  inspect: (candidate: FairClaimCandidate) => InspectedClaimCandidate<T> | undefined,
  options: {
    readonly inspectionBudget?: number;
    readonly primaryBudget?: number;
    readonly inspectionBuckets?: Set<string>;
  } = {},
): {
  readonly selected: InspectedClaimCandidate<T> | undefined;
  readonly inspectedJobCount: number;
  readonly inspectedTemplateBytes: number;
  readonly inspectedRepositoryCount: number;
  readonly partial: boolean;
} {
  if (!database.isTransaction) corrupt("Claim scanning requires the lease transaction.");
  const budget = options.inspectionBudget ?? 128;
  const primaryBudget = options.primaryBudget ?? Math.min(96, budget);
  if (
    !Number.isSafeInteger(budget) ||
    budget < 0 ||
    budget > 128 ||
    !Number.isSafeInteger(primaryBudget) ||
    primaryBudget < 0 ||
    primaryBudget > budget
  )
    corrupt("The claim inspection budget is invalid.");
  const state = database
    .prepare("SELECT episode_sequence FROM scheduling_state WHERE singleton = 1")
    .get() as { episode_sequence: number } | undefined;
  if (!state || !Number.isSafeInteger(state.episode_sequence))
    corrupt("The queue high-water mark is invalid.");
  let coordinator = loadCursor(
    database,
    worker,
    { scope_kind: "coordinator", scope_key: "*", work_class: "all", scan_kind: "coordinator" },
    now,
  );
  if (coordinator.pass_generation === 0 || coordinator.completed === 1) {
    coordinator = restart(
      coordinator,
      increment(coordinator.pass_generation),
      state.episode_sequence,
      now,
    );
    saveCursor(database, worker, coordinator);
  }
  const buckets = database
    .prepare(`SELECT service.bucket_key FROM repository_scheduling_state AS service
    LEFT JOIN claim_scan_state AS pr ON pr.worker_id = ? AND pr.worker_instance_id = ?
      AND pr.protocol_version = ? AND pr.capabilities_digest = ? AND pr.scope_kind = 'bucket'
      AND pr.scope_key = service.bucket_key AND pr.work_class = 'pull_request' AND pr.scan_kind = 'primary'
    LEFT JOIN claim_scan_state AS issue ON issue.worker_id = ? AND issue.worker_instance_id = ?
      AND issue.protocol_version = ? AND issue.capabilities_digest = ? AND issue.scope_kind = 'bucket'
      AND issue.scope_key = service.bucket_key AND issue.work_class = 'issue' AND issue.scan_kind = 'primary'
    WHERE NOT (COALESCE(pr.pass_generation, 0) = ? AND COALESCE(pr.completed, 0) = 1
      AND COALESCE(issue.pass_generation, 0) = ? AND COALESCE(issue.completed, 0) = 1)
      AND EXISTS (SELECT 1 FROM job_admission AS admission JOIN jobs AS job ON job.id = admission.job_id
        WHERE admission.bucket_key = service.bucket_key AND admission.state = 'admitted'
          AND admission.episode_sequence <= ? AND job.status IN ('queued', 'retry_waiting'))
    ORDER BY service.last_claim_ticket, service.bucket_key LIMIT 12`)
    .all(
      ...identity(worker),
      ...identity(worker),
      coordinator.pass_generation,
      coordinator.pass_generation,
      coordinator.high_water_sequence,
    ) as { bucket_key: string }[];
  const cursors: Cursor[] = [];
  for (const bucket of buckets) {
    const service = readRepositorySchedulingService(database, bucket.bucket_key);
    const classes: SchedulingWorkClass[] =
      service.claimPrStreak >= 2 ? ["issue", "pull_request"] : ["pull_request", "issue"];
    for (const workClass of classes) {
      let cursor = loadCursor(
        database,
        worker,
        {
          scope_kind: "bucket",
          scope_key: bucket.bucket_key,
          work_class: workClass,
          scan_kind: "primary",
        },
        now,
      );
      if (cursor.pass_generation !== coordinator.pass_generation)
        cursor = restart(cursor, coordinator.pass_generation, coordinator.high_water_sequence, now);
      if (!cursor.completed) cursors.push(cursor);
    }
  }
  if (buckets.length === 0) {
    coordinator.completed = 1;
    coordinator.updated_at = now;
    saveCursor(database, worker, coordinator);
  }

  const visited = options.inspectionBuckets ?? new Set<string>();
  if (visited.size > 16) corrupt("The shared claim repository budget is exhausted.");
  let repositoryCeiling = 12;
  const ready = new Map<string, InspectedClaimCandidate<T>>();
  const stopped = new Set<Cursor>();
  let inspections = 0;
  let bytes = 0;
  let partial = false;
  let bytesExhausted = false;
  const step = (cursor: Cursor): void => {
    if (cursor.completed || stopped.has(cursor)) return;
    const scopeParameters: SQLInputValue[] = [];
    let scope: string;
    switch (cursor.scope_kind) {
      case "bucket":
        scope = "admission.bucket_key = ?";
        scopeParameters.push(cursor.scope_key);
        break;
      case "concurrency":
        scope = "candidate.concurrency_key = ?";
        scopeParameters.push(cursor.scope_key);
        break;
      case "affinity":
        scope = "candidate.execution_affinity_node_id = ?";
        scopeParameters.push(cursor.scope_key);
        break;
      case "backoff":
        scope =
          "candidate.next_attempt_at > admission.requested_at AND candidate.next_attempt_at <= ?";
        scopeParameters.push(now);
        break;
      default:
        corrupt("A coordinator cannot inspect Jobs.");
    }
    if (cursor.work_class !== "all") {
      scope += " AND admission.work_class = ?";
      scopeParameters.push(cursor.work_class);
    }
    // Read only one compact ordering row before deciding whether its template fits this RPC.
    const row = database
      .prepare(`SELECT candidate.id, admission.bucket_key, admission.work_class,
      admission.episode_sequence, admission.claim_rank_at_ms,
      length(CAST(candidate.execution_json AS BLOB)) + length(CAST(candidate.required_capabilities_json AS BLOB)) AS template_bytes
      FROM job_admission AS admission JOIN jobs AS candidate ON candidate.id = admission.job_id
      WHERE admission.state = 'admitted' AND candidate.status IN ('queued', 'retry_waiting')
        AND candidate.current_run_attempt_id IS NULL AND admission.attempt_base = candidate.attempt_count
        AND admission.episode_sequence <= ? AND (${scope})
        ${cursor.after_rank_at_ms === null ? "" : "AND (admission.claim_rank_at_ms, admission.episode_sequence, admission.job_id) > (?, ?, ?)"}
      ORDER BY admission.claim_rank_at_ms, admission.episode_sequence, candidate.id LIMIT 1`)
      .get(
        cursor.high_water_sequence,
        ...scopeParameters,
        ...(cursor.after_rank_at_ms === null
          ? []
          : [cursor.after_rank_at_ms, cursor.after_episode_sequence, cursor.after_job_id]),
      ) as
      | {
          id: string;
          bucket_key: string;
          work_class: SchedulingWorkClass;
          episode_sequence: number;
          claim_rank_at_ms: number;
          template_bytes: number;
        }
      | undefined;
    if (!row) {
      cursor.completed = 1;
      cursor.updated_at = now;
      saveCursor(database, worker, cursor);
      return;
    }
    const inspectionBucket = row.bucket_key === "unscoped" ? `unscoped:${row.id}` : row.bucket_key;
    if (!visited.has(inspectionBucket) && visited.size >= repositoryCeiling) {
      stopped.add(cursor);
      partial = true;
      return;
    }
    if (inspections > 0 && bytes + row.template_bytes > maximumClaimLeaseResponseUtf8Bytes) {
      bytesExhausted = true;
      partial = true;
      return;
    }
    visited.add(inspectionBucket);
    const candidate = database
      .prepare(`SELECT job.*, admission.bucket_key, admission.work_class,
      admission.episode_sequence, admission.claim_rank_at_ms FROM jobs AS job
      JOIN job_admission AS admission ON admission.job_id = job.id WHERE job.id = ?`)
      .get(row.id) as unknown as FairClaimCandidate;
    inspections++;
    bytes += row.template_bytes;
    const result = ready.get(candidate.id) ?? inspect(candidate);
    if (result) {
      if (inspectionBucket !== result.bucketKey) {
        visited.delete(inspectionBucket);
        visited.add(result.bucketKey);
      }
      ready.set(candidate.id, result);
      // Preserve the position before an eligible candidate until actual successful service.
      // Non-winners are not silently skipped until the next pass.
      stopped.add(cursor);
      cursor.updated_at = now;
      saveCursor(database, worker, cursor);
      return;
    }
    cursor.after_rank_at_ms = candidate.claim_rank_at_ms;
    cursor.after_episode_sequence = candidate.episode_sequence;
    cursor.after_job_id = candidate.id;
    cursor.updated_at = now;
    saveCursor(database, worker, cursor);
  };
  const rounds = (items: Cursor[], ceiling: number): void => {
    while (inspections < ceiling && !bytesExhausted) {
      let progressed = false;
      for (const cursor of items) {
        if (cursor.completed || stopped.has(cursor)) continue;
        if (inspections >= ceiling || bytesExhausted) break;
        step(cursor);
        progressed = true;
      }
      if (!progressed) break;
    }
  };
  rounds(cursors, primaryBudget);

  const eventQuery = `SELECT producer.scope_kind, producer.scope_key, producer.dirty_generation
    FROM claim_scan_state AS producer LEFT JOIN claim_scan_state AS consumer
      ON consumer.worker_id = ? AND consumer.worker_instance_id = ? AND consumer.protocol_version = ?
      AND consumer.capabilities_digest = ? AND consumer.scope_kind = producer.scope_kind
      AND consumer.scope_key = producer.scope_key AND consumer.work_class = 'all' AND consumer.scan_kind = 'recheck'
    WHERE producer.scan_kind = 'event' AND `;
  type RecheckEvent = {
    scope_kind: Cursor["scope_kind"];
    scope_key: string;
    dirty_generation: number;
  };
  // Reserve progress for an already captured pass. New affected keys cannot repeatedly
  // displace it; reopening/first inspection consumes the oldest outstanding producer ticket.
  const inProgress = database
    .prepare(`${eventQuery}consumer.completed = 0 AND consumer.pass_generation > 0
    ORDER BY consumer.updated_at, producer.scope_kind, producer.scope_key LIMIT 1`)
    .all(...identity(worker)) as RecheckEvent[];
  const waitingEvents = database
    .prepare(`${eventQuery}(consumer.worker_id IS NULL OR
      (consumer.completed = 1 AND consumer.dirty_generation < producer.dirty_generation))
    ORDER BY producer.dirty_generation, producer.scope_kind, producer.scope_key LIMIT ?`)
    .all(...identity(worker), 3 - inProgress.length) as RecheckEvent[];
  const events = [...inProgress, ...waitingEvents];
  const rechecks: Cursor[] = [];
  const recheckGroups: { coordinator: Cursor; children: Cursor[] }[] = [];
  const addRecheck = (cursor: Cursor): void => {
    saveCursor(database, worker, cursor);
    const children: Cursor[] = [];
    // Each class has its own position. A newly due Issue must not hide behind a compatible
    // PR at the front of a broad concurrency/bucket recheck.
    for (const workClass of ["issue", "pull_request"] as const) {
      let child = loadCursor(
        database,
        worker,
        {
          scope_kind: cursor.scope_kind,
          scope_key: cursor.scope_key,
          work_class: workClass,
          scan_kind: "recheck",
        },
        now,
      );
      if (child.pass_generation !== cursor.pass_generation) {
        child = restart(child, cursor.pass_generation, cursor.high_water_sequence, now);
        child.dirty_generation = cursor.dirty_generation;
      }
      children.push(child);
      if (!child.completed) rechecks.push(child);
    }
    recheckGroups.push({ coordinator: cursor, children });
  };
  for (const event of events) {
    let cursor = loadCursor(
      database,
      worker,
      {
        scope_kind: event.scope_kind,
        scope_key: event.scope_key,
        work_class: "all",
        scan_kind: "recheck",
      },
      now,
    );
    if (cursor.pass_generation === 0 || cursor.completed === 1) {
      cursor = restart(cursor, increment(cursor.pass_generation), state.episode_sequence, now);
      cursor.dirty_generation = event.dirty_generation;
    }
    addRecheck(cursor);
  }
  let due = loadCursor(
    database,
    worker,
    { scope_kind: "backoff", scope_key: "due", work_class: "all", scan_kind: "recheck" },
    now,
  );
  if (due.pass_generation === 0 || (due.completed === 1 && due.recheck_at <= now)) {
    due = restart(due, increment(due.pass_generation), state.episode_sequence, now);
    due.recheck_at = new Date(Date.parse(now) + 1_000).toISOString();
  }
  if (!due.completed) addRecheck(due);
  repositoryCeiling = 16;
  rounds(rechecks, budget);
  // Unused recheck capacity remains available to the primary pass, without resetting either.
  rounds(cursors, budget);
  for (const group of recheckGroups) {
    if (group.children.every((child) => child.completed === 1)) group.coordinator.completed = 1;
    group.coordinator.updated_at = now;
    saveCursor(database, worker, group.coordinator);
  }
  if (
    inspections === budget &&
    [...cursors, ...rechecks].some((c) => !c.completed && !stopped.has(c))
  )
    partial = true;

  const byBucket = new Map<string, InspectedClaimCandidate<T>[]>();
  for (const result of ready.values()) {
    const values = byBucket.get(result.bucketKey) ?? [];
    values.push(result);
    byBucket.set(result.bucketKey, values);
  }
  const orderedBuckets = [...byBucket.keys()].sort((left, right) => {
    const a = readRepositorySchedulingService(database, left);
    const b = readRepositorySchedulingService(database, right);
    return a.lastClaimTicket - b.lastClaimTicket || left.localeCompare(right, "en");
  });
  let selected: InspectedClaimCandidate<T> | undefined;
  const bucket = orderedBuckets[0];
  if (bucket !== undefined) {
    const service = readRepositorySchedulingService(database, bucket);
    const candidates = byBucket.get(bucket);
    if (!candidates || candidates.length === 0)
      corrupt("A selected scheduling bucket has no candidate.");
    const preferred = service.claimPrStreak >= 2 ? "issue" : "pull_request";
    candidates.sort(
      (a, b) =>
        Number(b.candidate.work_class === preferred) -
          Number(a.candidate.work_class === preferred) ||
        a.candidate.claim_rank_at_ms - b.candidate.claim_rank_at_ms ||
        a.candidate.episode_sequence - b.candidate.episode_sequence ||
        a.candidate.id.localeCompare(b.candidate.id, "en"),
    );
    selected = candidates[0];
  }
  return {
    selected,
    inspectedJobCount: inspections,
    inspectedTemplateBytes: bytes,
    inspectedRepositoryCount: visited.size,
    partial: partial || coordinator.completed === 0,
  };
}
