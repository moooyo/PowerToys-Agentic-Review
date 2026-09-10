import type { DatabaseSync } from "node:sqlite";
import { getSchedulingCapacity, type SchedulingUsage } from "@agentic-review/contracts";
import {
  assertWaitingAdmissionIntegrity,
  getJobAdmissionRecord,
  refineJobAdmissionOwnershipInTransaction,
  type StoredJobAdmission,
} from "./job-admission.js";
import {
  assertActiveSchedulingIntegrity,
  type RepositorySchedulingPolicy,
  readPlatformSchedulingConfiguration,
  readSchedulingUsage,
  resolveRepositorySchedulingPolicy,
} from "./scheduling-accounting.js";
import { inspectJobAdmissionReadinessInTransaction } from "./scheduling-diagnostics.js";
import {
  ensureRepositorySchedulingStateInTransaction,
  type RepositorySchedulingService,
  readRepositorySchedulingService,
  recordSuccessfulSchedulingServiceInTransaction,
  type SchedulingWorkClass,
} from "./scheduling-service.js";

export const maximumJobAdmissionBatchSize = 128;
interface AdmissionState {
  episode_sequence: number;
  inspection_sequence: number;
  pending_pass_high_water: number;
  pending_pass_after_sequence: number;
  recovery_pass_high_water: number;
  recovery_pass_after_sequence: number;
}
interface Candidate {
  job_id: string;
  episode_sequence: number;
  work_class: SchedulingWorkClass;
  bucket_key: string;
  ownership_state: string;
}
interface InspectedCandidate extends Candidate {
  episode: StoredJobAdmission;
  ready: boolean;
  codes: string[];
  inspectionSequence: number;
}
interface BucketState {
  policy: RepositorySchedulingPolicy | null;
  usage: SchedulingUsage;
  service: RepositorySchedulingService;
}
function corrupt(message: string): never {
  throw Object.assign(new Error(message), { code: "PLATFORM_CORRUPT" });
}
const knownQueueBlockers = [
  "[]",
  '["repository_queue_limit"]',
  '["platform_queue_limit"]',
  '["repository_queue_limit","platform_queue_limit"]',
];

/** Finite discovery passes retain progress while known queue-blocked candidates receive a
 * reserved recheck share. Finding a winner while capacity is full never loses that discovery. */
export function admitPendingJobsInTransaction(
  database: DatabaseSync,
  input: {
    readonly limit?: number;
    readonly workerId?: string;
    readonly inspectionBuckets?: Set<string>;
    readonly maximumInspectedBuckets?: number;
  },
  now: string,
): {
  readonly examinedJobCount: number;
  readonly admittedJobCount: number;
  readonly reclaimedJobCount?: number;
} {
  if (!database.isTransaction) corrupt("Job admission requires an immediate transaction.");
  const limit = input.limit ?? 32;
  const maximumBuckets = input.maximumInspectedBuckets ?? 16;
  const inspectionBuckets = input.inspectionBuckets ?? new Set<string>();
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximumJobAdmissionBatchSize ||
    !Number.isSafeInteger(maximumBuckets) ||
    maximumBuckets < 1 ||
    maximumBuckets > 16 ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    throw Object.assign(new Error("The admission batch is invalid."), { code: "PLATFORM_INVALID" });
  assertWaitingAdmissionIntegrity(database);
  assertActiveSchedulingIntegrity(database);
  const state = database
    .prepare(`SELECT episode_sequence, inspection_sequence,
    pending_pass_high_water, pending_pass_after_sequence, recovery_pass_high_water,
    recovery_pass_after_sequence FROM scheduling_state WHERE singleton = 1 AND backfill_complete = 1`)
    .get() as AdmissionState | undefined;
  if (!state || Object.values(state).some((value) => !Number.isSafeInteger(value) || value < 0))
    corrupt("The durable admission cursor is invalid.");
  for (const [highWater, after] of [
    [state.pending_pass_high_water, state.pending_pass_after_sequence],
    [state.recovery_pass_high_water, state.recovery_pass_after_sequence],
  ] as const)
    if (highWater > state.episode_sequence || after > highWater)
      corrupt("The durable admission cursor exceeds its captured episode range.");

  const platform = readPlatformSchedulingConfiguration(database);
  let globalUsage = readSchedulingUsage(database, { integrityAlreadyChecked: true });
  const buckets = new Map<string, BucketState>();
  const bucket = (bucketKey: string): BucketState => {
    let current = buckets.get(bucketKey);
    if (!current) {
      ensureRepositorySchedulingStateInTransaction(database, bucketKey);
      current = {
        policy: resolveRepositorySchedulingPolicy(database, bucketKey),
        usage: readSchedulingUsage(database, { bucketKey, integrityAlreadyChecked: true }),
        service: readRepositorySchedulingService(database, bucketKey),
      };
      buckets.set(bucketKey, current);
    }
    return current;
  };
  let examinedJobCount = 0;
  let admittedJobCount = 0;
  let reclaimedJobCount = 0;
  let inspectionSequence = state.inspection_sequence;
  const inspectedIds = new Set<string>();
  // Unknown ownership consumes a separate slot until the bounded parser establishes its
  // actual bucket. Many unknown Jobs cannot share one apparent unscoped inspection slot.
  const inspectionKey = (candidate: Candidate): string =>
    ["unverified", "unscoped"].includes(candidate.ownership_state)
      ? `unverified:${candidate.job_id}`
      : candidate.bucket_key;
  const reserveBucket = (candidate: Candidate, ceiling = maximumBuckets): boolean => {
    const key = inspectionKey(candidate);
    if (inspectionBuckets.has(key)) return true;
    if (inspectionBuckets.size >= ceiling) return false;
    inspectionBuckets.add(key);
    return true;
  };
  const nextInspection = (): number => {
    if (!Number.isSafeInteger(inspectionSequence + 1))
      corrupt("The admission inspection sequence is exhausted.");
    inspectionSequence++;
    examinedJobCount++;
    database
      .prepare("UPDATE scheduling_state SET inspection_sequence = ? WHERE singleton = 1")
      .run(inspectionSequence);
    return inspectionSequence;
  };
  const writeObservation = (
    episode: StoredJobAdmission,
    newState: "pending" | "admitted",
    codes: readonly string[],
    sequence: number,
  ): void => {
    const changed = database
      .prepare(`UPDATE job_admission SET state = ?, admitted_at = ?,
      last_checked_at = ?, last_inspection_sequence = ?, blockers_json = ?
      WHERE job_id = ? AND state = ? AND episode_sequence = ? AND attempt_base = ?
        AND EXISTS (SELECT 1 FROM jobs AS job WHERE job.id = job_admission.job_id
          AND job.status IN ('queued', 'retry_waiting') AND job.current_run_attempt_id IS NULL
          AND job.attempt_count = job_admission.attempt_base)
        AND NOT EXISTS (SELECT 1 FROM run_attempts AS attempt WHERE attempt.job_id = job_admission.job_id
          AND attempt.status IN ('leased', 'running'))`)
      .run(
        newState,
        newState === "admitted" ? (episode.admittedAt ?? now) : null,
        now,
        sequence,
        JSON.stringify([...new Set(codes)].slice(0, 32)),
        episode.jobId,
        episode.state,
        episode.episodeSequence,
        episode.attemptBase,
      );
    if (Number(changed.changes) !== 1)
      corrupt("The current admission episode changed during inspection.");
  };
  const queueUsageChanged = (current: BucketState, admittedDelta: number): void => {
    globalUsage = {
      ...globalUsage,
      admittedQueuedJobs: globalUsage.admittedQueuedJobs + admittedDelta,
      awaitingAdmissionJobs: globalUsage.awaitingAdmissionJobs - admittedDelta,
    };
    current.usage = {
      ...current.usage,
      admittedQueuedJobs: current.usage.admittedQueuedJobs + admittedDelta,
      awaitingAdmissionJobs: current.usage.awaitingAdmissionJobs - admittedDelta,
    };
  };
  const repositoryActiveHold = (current: BucketState): boolean => {
    const globalActiveFull =
      getSchedulingCapacity(platform.limits, globalUsage).activeCapacity === "limited";
    return (
      !globalActiveFull &&
      current.policy !== null &&
      getSchedulingCapacity(current.policy.limits, current.usage).activeCapacity === "limited" &&
      (platform.limits.maxQueuedJobs !== null || current.policy?.limits.maxQueuedJobs != null)
    );
  };

  // Only a complete fleet observation can justify recovering unsupported runtime credit.
  // Pause and repository saturation are exact independent scalar evidence. Busy slots,
  // shared global active limits, concurrency, and future backoff never demote reservations.
  // A claim's witness path leaves full-fleet recovery to the owned background pump, so a
  // candidate inspection cannot multiply into an entire inventory scan inside that claim RPC.
  const finiteQueue =
    platform.limits.maxQueuedJobs !== null ||
    database
      .prepare("SELECT 1 FROM managed_repositories WHERE max_queued_jobs IS NOT NULL LIMIT 1")
      .get() !== undefined;
  if (finiteQueue && globalUsage.awaitingAdmissionJobs > 0 && globalUsage.admittedQueuedJobs > 0) {
    const recoveryLimit = Math.max(1, Math.floor(limit / 4));
    let highWater = state.recovery_pass_high_water;
    let after = state.recovery_pass_after_sequence;
    if (after >= highWater) {
      highWater = state.episode_sequence;
      after = 0;
    }
    const rows = database
      .prepare(`SELECT admission.job_id, admission.episode_sequence, admission.work_class,
        admission.bucket_key, admission.ownership_state
      FROM job_admission AS admission JOIN jobs AS job ON job.id = admission.job_id
      WHERE admission.state = 'admitted' AND admission.episode_sequence > ? AND admission.episode_sequence <= ?
        AND job.status IN ('queued', 'retry_waiting') AND job.current_run_attempt_id IS NULL
      ORDER BY admission.episode_sequence LIMIT ?`)
      .all(after, highWater, recoveryLimit + 1) as unknown as Candidate[];
    const observed = rows.slice(0, recoveryLimit);
    let recoveryAfter = after;
    let recoveryStopped = false;
    for (const candidate of observed) {
      if (!reserveBucket(candidate, Math.max(1, maximumBuckets - 1))) {
        recoveryStopped = true;
        break;
      }
      const sequence = nextInspection();
      recoveryAfter = candidate.episode_sequence;
      inspectedIds.add(candidate.job_id);
      const episode = getJobAdmissionRecord(database, candidate.job_id);
      const current = bucket(episode.bucketKey);
      if (platform.limits.maxQueuedJobs === null && current.policy?.limits.maxQueuedJobs == null)
        continue;
      let codes: string[] = [];
      if (current.policy?.enabled === false) codes = ["repository_paused"];
      else if (repositoryActiveHold(current)) codes = ["repository_active_limit"];
      else if (
        input.workerId === undefined &&
        (platform.limits.maxQueuedJobs !== null || current.policy?.limits.maxQueuedJobs != null)
      ) {
        const assessment = inspectJobAdmissionReadinessInTransaction(
          database,
          candidate.job_id,
          now,
        );
        const observedCodes = assessment.reasons.map((reason) => reason.code);
        if (
          !observedCodes.includes("inspection_incomplete") &&
          observedCodes.some((code) =>
            [
              "no_registered_worker",
              "no_compatible_worker",
              "compatible_worker_unavailable",
              "affinity_worker_unavailable",
            ].includes(code),
          )
        )
          codes = observedCodes;
      }
      if (codes.length > 0) {
        writeObservation(episode, "pending", codes, sequence);
        queueUsageChanged(current, -1);
        reclaimedJobCount++;
      }
    }
    const finalAfter = recoveryStopped || rows.length > recoveryLimit ? recoveryAfter : highWater;
    database
      .prepare(`UPDATE scheduling_state SET recovery_pass_high_water = ?, recovery_pass_after_sequence = ?
      WHERE singleton = 1`)
      .run(highWater, finalAfter);
  }

  let highWater = state.pending_pass_high_water;
  let after = state.pending_pass_after_sequence;
  if (after >= highWater) {
    highWater = state.episode_sequence;
    after = 0;
  }
  const remaining = limit - examinedJobCount;
  const cachedLimit = Math.floor(remaining / 4);
  const cached =
    cachedLimit === 0
      ? []
      : (database
          .prepare(`SELECT admission.job_id, admission.bucket_key, admission.ownership_state,
      admission.episode_sequence, admission.work_class FROM job_admission AS admission
      JOIN jobs AS job ON job.id = admission.job_id
      JOIN repository_scheduling_state AS service ON service.bucket_key = admission.bucket_key
      WHERE admission.state = 'pending' AND admission.episode_sequence <= ?
        AND admission.last_checked_at IS NOT NULL AND admission.blockers_json IN (?, ?, ?, ?)
        AND job.status IN ('queued', 'retry_waiting') AND job.current_run_attempt_id IS NULL
      ORDER BY service.last_admission_ticket, service.bucket_key,
        CASE WHEN (service.admission_pr_streak = 2 AND admission.work_class = 'issue')
          OR (service.admission_pr_streak < 2 AND admission.work_class = 'pull_request') THEN 0 ELSE 1 END,
        admission.episode_sequence LIMIT ?`)
          .all(highWater, ...knownQueueBlockers, cachedLimit) as unknown as Candidate[]);
  const cache = cached.filter(
    (candidate) =>
      !inspectedIds.has(candidate.job_id) &&
      reserveBucket(candidate, Math.max(0, maximumBuckets - 1)),
  );
  const excluded = [...inspectedIds, ...cache.map((candidate) => candidate.job_id)];
  const primaryLimit = remaining - cache.length;
  const rows =
    primaryLimit === 0
      ? []
      : (database
          .prepare(`SELECT admission.job_id, admission.bucket_key, admission.ownership_state,
      admission.episode_sequence, admission.work_class FROM job_admission AS admission
      JOIN jobs AS job ON job.id = admission.job_id
      WHERE admission.state = 'pending' AND admission.episode_sequence > ? AND admission.episode_sequence <= ?
        AND job.status IN ('queued', 'retry_waiting') AND job.current_run_attempt_id IS NULL
        ${excluded.length === 0 ? "" : `AND admission.job_id NOT IN (${excluded.map(() => "?").join(",")})`}
      ORDER BY admission.episode_sequence LIMIT ?`)
          .all(after, highWater, ...excluded, primaryLimit + 1) as unknown as Candidate[]);
  const primary = rows.slice(0, primaryLimit);
  const primaryIds = new Set(primary.map((candidate) => candidate.job_id));
  let primaryAfter = after;
  let primaryStopped = false;
  const inspected: InspectedCandidate[] = [];
  for (const candidate of [...cache, ...primary]) {
    if (!reserveBucket(candidate)) {
      primaryStopped = true;
      break;
    }
    const sequence = nextInspection();
    if (primaryIds.has(candidate.job_id)) primaryAfter = candidate.episode_sequence;
    let episode = getJobAdmissionRecord(database, candidate.job_id);
    const assessment =
      episode.ownershipState === "conflict"
        ? { ready: false, reasons: [{ code: "invalid_job_configuration" }] }
        : inspectJobAdmissionReadinessInTransaction(
            database,
            candidate.job_id,
            now,
            input.workerId,
          );
    if (
      assessment.ready &&
      "validatedTemplate" in assessment &&
      assessment.validatedTemplate &&
      ["unverified", "unscoped"].includes(episode.ownershipState)
    ) {
      refineJobAdmissionOwnershipInTransaction(
        database,
        candidate.job_id,
        assessment.validatedTemplate,
      );
      episode = getJobAdmissionRecord(database, candidate.job_id);
      if (episode.ownershipState === "resolved") {
        inspectionBuckets.delete(inspectionKey(candidate));
        inspectionBuckets.add(episode.bucketKey);
      }
    }
    const current = bucket(episode.bucketKey);
    const codes = [...new Set(assessment.reasons.map((reason) => reason.code))].slice(0, 32);
    if (current.policy?.enabled === false && !codes.includes("repository_paused"))
      codes.push("repository_paused");
    if (repositoryActiveHold(current) && !codes.includes("repository_active_limit"))
      codes.push("repository_active_limit");
    const ready = assessment.ready && episode.ownershipState === "resolved" && codes.length === 0;
    if (assessment.ready && !ready && codes.length === 0) codes.push("inspection_incomplete");
    inspected.push({ ...candidate, episode, ready, codes, inspectionSequence: sequence });
  }

  // Tickets are re-evaluated after every success, including multiple profiles from one Run.
  const ready = inspected.filter((candidate) => candidate.ready);
  while (ready.length > 0) {
    ready.sort((left, right) => {
      const leftService = bucket(left.episode.bucketKey).service;
      const rightService = bucket(right.episode.bucketKey).service;
      const ticket = leftService.lastAdmissionTicket - rightService.lastAdmissionTicket;
      if (ticket !== 0) return ticket;
      const repository = left.episode.bucketKey.localeCompare(right.episode.bucketKey);
      if (repository !== 0) return repository;
      const preferred = leftService.admissionPrStreak === 2 ? "issue" : "pull_request";
      const classOrder =
        Number(right.work_class === preferred) - Number(left.work_class === preferred);
      return (
        classOrder ||
        left.episode.episodeSequence - right.episode.episodeSequence ||
        left.job_id.localeCompare(right.job_id)
      );
    });
    const candidate = ready.shift();
    if (!candidate) break;
    const current = bucket(candidate.episode.bucketKey);
    if (
      current.policy !== null &&
      getSchedulingCapacity(current.policy.limits, current.usage).queueCapacity === "limited"
    )
      candidate.codes.push("repository_queue_limit");
    if (getSchedulingCapacity(platform.limits, globalUsage).queueCapacity === "limited")
      candidate.codes.push("platform_queue_limit");
    if (candidate.codes.length > 0) continue;
    writeObservation(candidate.episode, "admitted", [], candidate.inspectionSequence);
    recordSuccessfulSchedulingServiceInTransaction(
      database,
      candidate.episode.bucketKey,
      "admission",
      candidate.work_class,
    );
    current.service = readRepositorySchedulingService(database, candidate.episode.bucketKey);
    queueUsageChanged(current, 1);
    admittedJobCount++;
    candidate.episode = { ...candidate.episode, state: "admitted", admittedAt: now };
  }
  for (const candidate of inspected)
    if (candidate.episode.state === "pending")
      writeObservation(candidate.episode, "pending", candidate.codes, candidate.inspectionSequence);
  if (primaryLimit > 0) {
    const finalAfter = primaryStopped || rows.length > primaryLimit ? primaryAfter : highWater;
    database
      .prepare(`UPDATE scheduling_state SET pending_pass_high_water = ?, pending_pass_after_sequence = ?
      WHERE singleton = 1`)
      .run(highWater, finalAfter);
  }
  return {
    examinedJobCount,
    admittedJobCount,
    ...(reclaimedJobCount === 0 ? {} : { reclaimedJobCount }),
  };
}
