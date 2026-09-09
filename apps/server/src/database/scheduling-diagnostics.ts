import type { DatabaseSync } from "node:sqlite";
import {
  EntityIdSchema,
  getSchedulingCapacity,
  getSchedulingDiagnosticsIssues,
  getSchedulingLimitReasons,
  type JobExecutionTemplate,
  type JobState,
  JobStateSchema,
  maximumClaimLeaseResponseUtf8Bytes,
  maximumSchedulingDiagnosticReasonCount,
  maximumSchedulingDiagnosticRequirementCount,
  maximumSchedulingDiagnosticsResponseUtf8Bytes,
  type ReviewRunPlannedJob,
  type SchedulingDiagnosticPolicy,
  type SchedulingDiagnosticReasonV2,
  type SchedulingDiagnosticRequirements,
  type SchedulingDiagnosticSubject,
  type SchedulingDiagnostics,
  SchedulingDiagnosticsSchema,
  type SchedulingDiagnosticsV2,
  SchedulingDiagnosticsV2Schema,
  SchedulingRequirementNameSchema,
  type WorkerCapabilities,
  WorkerCapabilitiesSchema,
  WorkerHeartbeatRequestSchema,
} from "@agentic-review/contracts";
import {
  evaluateReviewRunPlanReadiness,
  getReviewRunExecutorCapabilityLabels,
  getReviewRunRequiredCapabilities,
} from "@agentic-review/domain";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { readEvaluationJobBindingInTransaction } from "./evaluation-execution.js";
import { readJobAdmission } from "./job-admission.js";
import {
  assertPlatformAdministrator,
  assertRepositoryPermission,
  isPlatformAdministrator,
  type OperatorReadContext,
} from "./operator-access.js";
import {
  handleReviewRunRequest,
  maximumReviewRunJobAssociationCount,
  type ReviewRunDetail,
} from "./review-runs.js";
import {
  readPlatformSchedulingConfiguration,
  readSchedulingOverage,
  readSchedulingUsage,
  resolveRepositorySchedulingPolicy,
} from "./scheduling-accounting.js";
import {
  evaluateJobWorkerCapabilities,
  parseExecutionTemplate,
  prepareClaimExecutionEnvelope,
  type SchedulingClaimCandidate,
} from "./scheduling-eligibility.js";
import { getValidationRunnerSupport } from "./validation-dispatch.js";

export interface SchedulingDiagnosticsOperationMap {
  getRepositoryJobScheduling: {
    input: { readonly repositoryId: string; readonly jobId: string };
    output: SchedulingDiagnostics | null;
  };
  getValidationRequestScheduling: {
    input: {
      readonly repositoryId: string;
      readonly reviewRunId: string;
      readonly requestId: string;
    };
    output: SchedulingDiagnostics | null;
  };
  getPlatformJobScheduling: {
    input: { readonly jobId: string };
    output: SchedulingDiagnostics | null;
  };
}
export type SchedulingDiagnosticsOperation = keyof SchedulingDiagnosticsOperationMap;
export type SchedulingDiagnosticsRequest = {
  [K in SchedulingDiagnosticsOperation]: {
    readonly operation: K;
    readonly input: SchedulingDiagnosticsOperationMap[K]["input"];
  };
}[SchedulingDiagnosticsOperation];
const inputSchemas = {
  getRepositoryJobScheduling: Type.Object(
    { repositoryId: EntityIdSchema, jobId: EntityIdSchema },
    { additionalProperties: false },
  ),
  getValidationRequestScheduling: Type.Object(
    { repositoryId: EntityIdSchema, reviewRunId: EntityIdSchema, requestId: EntityIdSchema },
    { additionalProperties: false },
  ),
  getPlatformJobScheduling: Type.Object({ jobId: EntityIdSchema }, { additionalProperties: false }),
};
export function isSchedulingDiagnosticsOperation(
  operation: string,
): operation is SchedulingDiagnosticsOperation {
  return Object.hasOwn(inputSchemas, operation);
}
export class SchedulingDiagnosticsError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_CORRUPT" | "PLATFORM_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SchedulingDiagnosticsError";
  }
}
function invalid(): never {
  throw new SchedulingDiagnosticsError(
    "PLATFORM_INVALID",
    "The scheduling diagnostic query is invalid.",
  );
}
function corrupt(): never {
  throw new SchedulingDiagnosticsError(
    "PLATFORM_CORRUPT",
    "The stored scheduling observation is invalid.",
  );
}
function canonicalTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function readTransaction<T>(database: DatabaseSync, action: () => T): T {
  if (database.isTransaction) return action();
  database.exec("BEGIN");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
function response(value: SchedulingDiagnostics): SchedulingDiagnostics {
  if (
    !Value.Check(SchedulingDiagnosticsSchema, value) ||
    getSchedulingDiagnosticsIssues(value).length > 0 ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > maximumSchedulingDiagnosticsResponseUtf8Bytes
  )
    corrupt();
  return value;
}
function runtimeResponse(value: SchedulingDiagnosticsV2): SchedulingDiagnosticsV2 {
  if (
    !Value.Check(SchedulingDiagnosticsV2Schema, value) ||
    getSchedulingDiagnosticsIssues(value).length > 0 ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > maximumSchedulingDiagnosticsResponseUtf8Bytes
  )
    corrupt();
  return value;
}
class Reasons {
  readonly items: SchedulingDiagnosticReasonV2[] = [];
  add(reason: SchedulingDiagnosticReasonV2): void {
    if (!this.items.some((existing) => canonicalJson(existing) === canonicalJson(reason)))
      this.items.push(reason);
  }
  finish(): Pick<SchedulingDiagnosticsV2, "reasons" | "reasonsTruncated"> {
    // Incomplete inspection must remain visible even when many own prerequisite names are present.
    const ordered = [...this.items].sort((left, right) =>
      left.code === "inspection_incomplete" ? -1 : right.code === "inspection_incomplete" ? 1 : 0,
    );
    return {
      reasons: ordered.slice(0, maximumSchedulingDiagnosticReasonCount),
      reasonsTruncated: ordered.length > maximumSchedulingDiagnosticReasonCount,
    };
  }
}
function requirements(values: readonly unknown[]): SchedulingDiagnosticRequirements {
  const names = new Set<string>();
  let omitted = false;
  let remaining = 4096;
  const consume = () => {
    if (remaining === 0) {
      omitted = true;
      return false;
    }
    remaining--;
    return true;
  };
  const append = (name: string) => {
    if (!consume()) return;
    if (Value.Check(SchedulingRequirementNameSchema, name)) names.add(name);
    else omitted = true;
  };
  function* ownKeys(value: object): Generator<string> {
    for (const key in value) if (Object.hasOwn(value, key)) yield key;
  }
  interface Frame {
    value: unknown;
    path: string;
    index: number;
    keys?: Iterator<string>;
  }
  const stack: Frame[] = values.map((value) => ({ value, path: "", index: 0 }));
  while (stack.length > 0 && consume()) {
    const entry = stack.at(-1);
    if (!entry) break;
    if (Array.isArray(entry.value)) {
      if (entry.index >= entry.value.length) {
        stack.pop();
        continue;
      }
      const value = entry.value[entry.index++];
      if (typeof value === "string") append(entry.path ? `${entry.path}.${value}` : value);
    } else if (entry.value !== null && typeof entry.value === "object") {
      entry.keys ??= ownKeys(entry.value);
      const next = entry.keys.next();
      if (next.done) {
        stack.pop();
        continue;
      }
      const key = next.value;
      const path = entry.path ? `${entry.path}.${key}` : key;
      if (path.length > 128) {
        omitted = true;
        continue;
      }
      if (!consume()) break;
      // Visit each child before obtaining its next sibling so wide objects cannot consume
      // the entire budget on enqueuing while already reachable names remain unreported.
      stack.push({ value: (entry.value as Record<string, unknown>)[key], path, index: 0 });
    } else {
      stack.pop();
      if (entry.path) append(entry.path);
    }
  }
  omitted ||= stack.length > 0;
  const sorted = [...names].sort();
  return {
    names: sorted.slice(0, maximumSchedulingDiagnosticRequirementCount),
    truncated: omitted || sorted.length > maximumSchedulingDiagnosticRequirementCount,
  };
}

interface JobRow extends SchedulingClaimCandidate {
  id: string;
  work_item_id: string | null;
  status: JobState;
  job_kind: string;
  attempt_count: number;
  max_attempts: number;
  current_run_attempt_id: string | null;
  execution_affinity_node_id: string | null;
  concurrency_key: string;
  created_at: string;
  next_attempt_at: string;
  execution_json: string | null;
  required_capabilities_json: string | null;
  resource_revision: string;
  request_epoch_id: string | null;
  lease_generation: number;
  repository_id: string | null;
  github_repository_id: number | null;
  item_kind: string | null;
  item_node_id: string | null;
  item_number: number | null;
  item_state: string | null;
  current_revision_key: string | null;
  enabled: number | null;
  scheduling_bucket_key: string | null;
}
const jobSelect = `SELECT job.id, job.work_item_id, job.status, job.job_kind, job.attempt_count,
  job.generation, job.intent_version, job.semantic_key, job.priority, job.lease_generation,
  job.max_attempts, job.current_run_attempt_id, job.execution_affinity_node_id, job.concurrency_key,
  job.created_at, job.next_attempt_at, job.resource_revision, job.request_epoch_id,
  CASE WHEN length(CAST(job.execution_json AS BLOB)) <= ${maximumClaimLeaseResponseUtf8Bytes} THEN job.execution_json ELSE NULL END AS execution_json,
  CASE WHEN length(CAST(job.required_capabilities_json AS BLOB)) <= ${maximumClaimLeaseResponseUtf8Bytes} THEN job.required_capabilities_json ELSE NULL END AS required_capabilities_json,
  item.repository_id, repository.github_repository_id, item.resource_kind AS item_kind,
  item.github_node_id AS item_node_id, item.github_number AS item_number, item.state AS item_state,
  item.current_revision_key, repository.enabled, admission.bucket_key AS scheduling_bucket_key
  FROM jobs AS job LEFT JOIN work_items AS item ON item.id = job.work_item_id
  LEFT JOIN managed_repositories AS repository ON repository.id = item.repository_id
  LEFT JOIN job_admission AS admission ON admission.job_id = job.id`;
function getJob(database: DatabaseSync, jobId: string, repositoryId?: string): JobRow | null {
  const row = database
    .prepare(
      `${jobSelect} WHERE job.id = ?${repositoryId === undefined ? "" : " AND item.repository_id = ? AND repository.id = ?"}`,
    )
    .get(
      ...(repositoryId === undefined ? [jobId] : [jobId, repositoryId, repositoryId]),
    ) as unknown as JobRow | undefined;
  if (!row) return null;
  if (
    !Value.Check(EntityIdSchema, row.id) ||
    !Value.Check(JobStateSchema, row.status) ||
    !safeInteger(row.attempt_count) ||
    !safeInteger(row.max_attempts, 1) ||
    typeof row.scheduling_bucket_key !== "string" ||
    !canonicalTime(row.created_at) ||
    !canonicalTime(row.next_attempt_at)
  )
    corrupt();
  if (
    row.work_item_id !== null &&
    (!Value.Check(EntityIdSchema, row.work_item_id) ||
      !Value.Check(EntityIdSchema, row.repository_id) ||
      !safeInteger(row.github_repository_id, 1))
  )
    corrupt();
  return row;
}
function diagnosticPolicy(
  database: DatabaseSync,
  bucketKey: string,
  subject: SchedulingDiagnosticSubject,
  fullPlatform: boolean,
): SchedulingDiagnosticPolicy {
  if (!database.isTransaction) corrupt();
  const configuration = readPlatformSchedulingConfiguration(database);
  const platformUsage = readSchedulingUsage(database);
  const repository = resolveRepositorySchedulingPolicy(database, bucketKey);
  if (
    subject.kind !== "platform_job" &&
    (repository === null || repository.repositoryId !== subject.repositoryId)
  )
    corrupt();
  const usage =
    repository === null
      ? null
      : readSchedulingUsage(database, { bucketKey, integrityAlreadyChecked: true });
  return {
    repository:
      repository === null || usage === null
        ? null
        : {
            repositoryId: repository.repositoryId,
            version: repository.version,
            enabled: repository.enabled,
            limits: repository.limits,
            usage,
            overage: readSchedulingOverage(usage, repository.limits),
          },
    platform: fullPlatform
      ? {
          visibility: "full",
          configuration,
          usage: platformUsage,
          overage: readSchedulingOverage(platformUsage, configuration.limits),
        }
      : {
          visibility: "restricted",
          version: configuration.version,
          ...getSchedulingCapacity(configuration.limits, platformUsage),
        },
  };
}
// Public policy observations run once per authorized read. Trusted candidate inspection retains
// the strict V2 runtime shape so bounded scheduler scans never recount global usage per candidate.
function currentObservation(
  database: DatabaseSync,
  observation: SchedulingDiagnosticsV2,
  bucketKey: string,
  fullPlatform: boolean,
): SchedulingDiagnostics {
  const policy = diagnosticPolicy(database, bucketKey, observation.subject, fullPlatform);
  const reasons = [
    ...getSchedulingLimitReasons(policy, observation.job, observation.stage),
    ...observation.reasons,
  ].sort((left, right) =>
    left.code === "inspection_incomplete" ? -1 : right.code === "inspection_incomplete" ? 1 : 0,
  );
  return response({
    ...observation,
    schemaVersion: "SchedulingDiagnosticsV3",
    policy,
    reasons: reasons.slice(0, maximumSchedulingDiagnosticReasonCount),
    reasonsTruncated:
      observation.reasonsTruncated || reasons.length > maximumSchedulingDiagnosticReasonCount,
  });
}
function jobSubject(row: JobRow): SchedulingDiagnosticSubject {
  return row.work_item_id === null
    ? { kind: "platform_job", jobId: row.id, association: "unassociated_legacy" }
    : {
        kind: "repository_job",
        repositoryId: row.repository_id as string,
        workItemId: row.work_item_id,
        jobId: row.id,
      };
}
function validateJobOwnership(row: JobRow, template: JobExecutionTemplate): void {
  if (row.work_item_id === null) {
    if ("validation" in template) corrupt();
    return;
  }
  if (
    template.repository.githubRepositoryId !== row.github_repository_id ||
    template.resource.kind !== row.item_kind ||
    template.resource.githubNodeId !== row.item_node_id ||
    template.resource.number !== row.item_number
  )
    corrupt();
  if (
    "validation" in template &&
    (template.validation.repositoryId !== row.repository_id ||
      template.validation.workItemId !== row.work_item_id ||
      template.validation.revisionKey !== row.resource_revision ||
      template.validation.requestEpochId !== row.request_epoch_id ||
      template.validation.profileVersion.repositoryId !== row.repository_id)
  )
    corrupt();
}
function readRun(
  database: DatabaseSync,
  repositoryId: string,
  reviewRunId: string,
  now: string,
): ReviewRunDetail | null {
  try {
    return handleReviewRunRequest(
      database,
      { operation: "getReviewRun", input: { repositoryId, reviewRunId } },
      now,
    ) as ReviewRunDetail | null;
  } catch {
    return corrupt();
  }
}
function runSourceReasons(database: DatabaseSync, run: ReviewRunDetail, reasons: Reasons): void {
  const current = database
    .prepare(`SELECT repository.enabled, repository.github_repository_id,
      repository.reviewer_github_user_id, repository.authorization_policy_json,
      item.state, item.current_revision_key, epoch.status AS epoch_status, epoch.ordinal,
      epoch.target_github_user_id, revision.revision_key
    FROM managed_repositories AS repository
    JOIN work_items AS item ON item.repository_id = repository.id
    JOIN request_epochs AS epoch ON epoch.work_item_id = item.id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
      AND revision.work_item_id = item.id
    WHERE repository.id = ? AND item.id = ? AND epoch.id = ?`)
    .get(run.repositoryId, run.workItemId, run.requestEpochId) as
    | {
        enabled: number;
        github_repository_id: number;
        reviewer_github_user_id: number | null;
        authorization_policy_json: string | null;
        state: string;
        current_revision_key: string;
        epoch_status: string;
        ordinal: number;
        target_github_user_id: number;
        revision_key: string;
      }
    | undefined;
  if (!current) corrupt();
  if (
    current.state !== "open" ||
    current.current_revision_key !== run.revisionKey ||
    current.revision_key !== run.revisionKey
  )
    reasons.add({ code: "source_obsolete", effect: "current_prerequisite" });
  let policy: unknown = null;
  try {
    policy =
      current.authorization_policy_json === null
        ? null
        : JSON.parse(current.authorization_policy_json);
  } catch {
    corrupt();
  }
  if (
    current.epoch_status !== "active" ||
    current.github_repository_id !== run.plan.repository.githubRepositoryId ||
    current.ordinal !== run.plan.authorization.sequence ||
    current.target_github_user_id !== run.plan.authorization.targetGithubUserId ||
    current.reviewer_github_user_id !== run.plan.authorization.targetGithubUserId ||
    canonicalJson(policy) !== canonicalJson(run.plan.authorization.policy)
  )
    reasons.add({ code: "authorization_changed", effect: "current_prerequisite" });
  const automatic = database
    .prepare(`SELECT activation.work_item_id, activation.request_epoch_id,
      activation.source_sequence, activation.revision_key, source.sequence AS current_sequence,
      source.current_revision_key FROM github_review_run_activations AS activation
    LEFT JOIN github_review_run_sources AS source ON source.work_item_id = activation.work_item_id
    WHERE activation.mode = 'review_run' AND activation.review_run_id = ?`)
    .get(run.id) as
    | {
        work_item_id: string;
        request_epoch_id: string;
        source_sequence: number;
        revision_key: string;
        current_sequence: number | null;
        current_revision_key: string | null;
      }
    | undefined;
  if (
    automatic &&
    (automatic.work_item_id !== run.workItemId ||
      automatic.request_epoch_id !== run.requestEpochId ||
      automatic.revision_key !== run.revisionKey ||
      automatic.current_sequence !== automatic.source_sequence ||
      automatic.current_revision_key !== automatic.revision_key)
  )
    reasons.add({ code: "source_obsolete", effect: "current_prerequisite" });
}
function legacySourceReasons(database: DatabaseSync, row: JobRow, reasons: Reasons): void {
  if (row.work_item_id === null) return;
  if (row.item_state !== "open" || row.current_revision_key !== row.resource_revision)
    reasons.add({ code: "source_obsolete", effect: "current_prerequisite" });
  // A Legacy Job may be retained by any active linked epoch, not only its primary epoch.
  const authorized = database
    .prepare(`SELECT 1 FROM job_request_epochs AS link
    JOIN request_epochs AS epoch ON epoch.id = link.request_epoch_id AND epoch.work_item_id = ?
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
      AND revision.work_item_id = epoch.work_item_id AND revision.revision_key = ?
    WHERE link.job_id = ? AND epoch.status = 'active' LIMIT 1`)
    .get(row.work_item_id, row.resource_revision, row.id);
  if (!authorized) reasons.add({ code: "authorization_changed", effect: "current_prerequisite" });
  const obsolete = database
    .prepare(`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM github_review_run_activations WHERE mode = 'legacy' AND legacy_job_id = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM github_review_run_activations AS activation
      JOIN github_review_run_sources AS source ON source.work_item_id = activation.work_item_id
        AND source.sequence = activation.source_sequence AND source.current_revision_key = activation.revision_key
      WHERE activation.mode = 'legacy' AND activation.legacy_job_id = ? AND activation.work_item_id = ?
        AND activation.revision_key = ?
    )`)
    .get(row.id, row.id, row.work_item_id, row.resource_revision);
  if (obsolete) reasons.add({ code: "source_obsolete", effect: "current_prerequisite" });
}

interface WorkerRow {
  id: string;
  node_id: string;
  instance_id: string;
  protocol_version: string;
  max_slots: number;
  available_slots: number;
  capabilities_json: string | null;
  capabilities_digest: string;
  health_json: string | null;
  status: string;
  superseded_at: string | null;
  last_seen_at: string;
  auth_state: string | null;
  active_count: number;
}
const maximumWorkerInspectionCount = 128;
interface WorkerEvaluation {
  match: (capabilities: unknown, worker: WorkerRow) => boolean | null;
  envelope?: (worker: WorkerRow) => boolean | null;
  affinity?: string | null;
  effect: "claim_gate" | "current_prerequisite";
  includeSlots: boolean;
  workerId?: string;
  onSupportedExecutor?: () => void;
}
function inspectWorkers(
  database: DatabaseSync,
  reasons: Reasons,
  evaluation: WorkerEvaluation,
): SchedulingDiagnostics["workerInspection"] {
  const identities: { id: string }[] = [];
  if (evaluation.workerId !== undefined) {
    identities.push(
      ...(database
        .prepare("SELECT id FROM workers WHERE id = ? AND (? IS NULL OR node_id = ?)")
        .all(evaluation.workerId, evaluation.affinity ?? null, evaluation.affinity ?? null) as {
        id: string;
      }[]),
    );
  } else if (evaluation.affinity) {
    identities.push(
      ...(database
        .prepare("SELECT id FROM workers WHERE node_id = ? ORDER BY instance_id LIMIT ?")
        .all(evaluation.affinity, maximumWorkerInspectionCount + 1) as { id: string }[]),
    );
  } else {
    // Each phase uses (status, last_seen_at); a CASE sort would visit all historical Workers.
    const select = database.prepare(
      "SELECT id FROM workers WHERE status = ? ORDER BY last_seen_at DESC LIMIT ?",
    );
    for (const status of ["online", "draining", "disabled", "offline"]) {
      const remaining = maximumWorkerInspectionCount + 1 - identities.length;
      if (remaining === 0) break;
      identities.push(...(select.all(status, remaining) as { id: string }[]));
    }
  }
  let partial = identities.length > maximumWorkerInspectionCount;
  const selectedIds = identities.slice(0, maximumWorkerInspectionCount).map((row) => row.id);
  const rows =
    selectedIds.length === 0
      ? []
      : (database
          .prepare(`SELECT worker.id, worker.node_id, worker.instance_id,
      worker.protocol_version, worker.max_slots, worker.available_slots,
      CASE WHEN length(CAST(worker.capabilities_json AS BLOB)) <= 65536 THEN worker.capabilities_json ELSE NULL END AS capabilities_json,
      CASE WHEN length(CAST(worker.health_json AS BLOB)) <= 4096 THEN worker.health_json ELSE NULL END AS health_json,
      worker.capabilities_digest, worker.status, worker.superseded_at, worker.last_seen_at, credential.auth_state,
      (SELECT COUNT(*) FROM run_attempts AS attempt WHERE attempt.worker_id = worker.id
        AND attempt.worker_instance_id = worker.instance_id AND attempt.status IN ('leased', 'running')) AS active_count
    FROM workers AS worker LEFT JOIN worker_node_credentials AS credential ON credential.worker_node_id = worker.node_id
    WHERE worker.id IN (${selectedIds.map(() => "?").join(", ")})`)
          .all(...selectedIds) as unknown as WorkerRow[]);
  if (rows.length !== selectedIds.length) corrupt();
  let latestContactAt: string | null = null;
  let compatible = false;
  let activeCompatible = false;
  let serverSlot = false;
  let advertisedSlot = false;
  let capacityUnknown = false;
  let envelopeAccepted = false;
  for (const worker of rows) {
    if (
      !canonicalTime(worker.last_seen_at) ||
      !Value.Check(EntityIdSchema, worker.node_id) ||
      !Value.Check(EntityIdSchema, worker.instance_id) ||
      !safeInteger(worker.max_slots, 1) ||
      !safeInteger(worker.available_slots) ||
      !safeInteger(worker.active_count)
    ) {
      partial = true;
      continue;
    }
    let capabilities: unknown;
    try {
      if (worker.capabilities_json === null) throw new Error();
      capabilities = JSON.parse(worker.capabilities_json);
    } catch {
      partial = true;
      continue;
    }
    const match = evaluation.match(capabilities, worker);
    if (match === null) {
      partial = true;
      continue;
    }
    if (!match) continue;
    compatible = true;
    if (latestContactAt === null || worker.last_seen_at > latestContactAt)
      latestContactAt = worker.last_seen_at;
    // Claim validates the selected instance's persisted state/credential/protocol. Its fresh
    // availableSlots argument is deliberately represented only as a heartbeat observation here.
    if (
      worker.status !== "online" ||
      worker.auth_state !== "active" ||
      worker.protocol_version !== "1.0" ||
      (evaluation.effect === "current_prerequisite" && worker.superseded_at !== null)
    )
      continue;
    activeCompatible = true;
    const envelope = evaluation.envelope?.(worker);
    if (envelope === null) {
      partial = true;
      continue;
    }
    if (envelope === false) continue;
    envelopeAccepted = true;
    evaluation.onSupportedExecutor?.();
    if (worker.active_count < worker.max_slots) {
      serverSlot = true;
      let health: unknown;
      try {
        health = worker.health_json === null ? null : JSON.parse(worker.health_json);
      } catch {
        health = null;
      }
      if (!Value.Check(WorkerHeartbeatRequestSchema.properties.health, health))
        capacityUnknown = true;
      else if (worker.available_slots > 0) advertisedSlot = true;
    }
  }
  if (partial) reasons.add({ code: "inspection_incomplete", effect: "observation" });
  else if (rows.length === 0)
    reasons.add(
      evaluation.affinity
        ? { code: "affinity_worker_unavailable", effect: "claim_gate" }
        : { code: "no_registered_worker", effect: evaluation.effect },
    );
  else if (!compatible) reasons.add({ code: "no_compatible_worker", effect: evaluation.effect });
  else if (!activeCompatible)
    reasons.add(
      evaluation.affinity
        ? { code: "affinity_worker_unavailable", effect: "claim_gate" }
        : { code: "compatible_worker_unavailable", effect: evaluation.effect },
    );
  else if (evaluation.includeSlots && envelopeAccepted && !serverSlot)
    reasons.add({ code: "worker_slots_occupied", effect: evaluation.effect });
  if (
    evaluation.includeSlots &&
    activeCompatible &&
    serverSlot &&
    !advertisedSlot &&
    !capacityUnknown &&
    !partial
  )
    reasons.add({ code: "worker_capacity_unavailable", effect: "observation" });
  if (!partial && activeCompatible && !envelopeAccepted && evaluation.envelope !== undefined)
    reasons.add({ code: "invalid_job_configuration", effect: "claim_gate" });
  return { state: partial ? "partial" : "complete", latestContactAt };
}
function jobObservation(
  database: DatabaseSync,
  row: JobRow,
  now: string,
  subject = jobSubject(row),
  runtime: {
    readonly workerId?: string;
    readonly includeSlots?: boolean;
    readonly onSupportedExecutor?: () => void;
    readonly onValidatedTemplate?: (template: JobExecutionTemplate) => void;
  } = {},
): SchedulingDiagnosticsV2 {
  const stage: SchedulingDiagnostics["stage"] =
    row.status === "queued" || row.status === "retry_waiting"
      ? "waiting"
      : ["leased", "running", "cancel_requested"].includes(row.status)
        ? "executing"
        : "terminal";
  const base = {
    schemaVersion: "SchedulingDiagnosticsV2" as const,
    observedAt: now,
    subject,
    stage,
    job: {
      jobId: row.id,
      status: row.status,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      nextAttemptAt: stage === "waiting" ? row.next_attempt_at : null,
      admission: readJobAdmission(database, {
        jobId: row.id,
        status: row.status,
        attemptCount: row.attempt_count,
      }),
    },
  };
  const empty = {
    workerInspection: { state: "not_applicable" as const, latestContactAt: null },
    requirements: { names: [], truncated: false },
    reasons: [],
    reasonsTruncated: false,
  };
  if (stage !== "waiting") return runtimeResponse({ ...base, ...empty });
  const reasons = new Reasons();
  if (base.job.admission?.state === "pending")
    reasons.add({ code: "awaiting_admission", effect: "claim_gate" });
  if (row.next_attempt_at > now)
    reasons.add({ code: "retry_backoff", effect: "claim_gate", until: row.next_attempt_at });
  if (row.attempt_count >= row.max_attempts)
    reasons.add({ code: "attempt_limit_reached", effect: "claim_gate" });
  if (row.current_run_attempt_id !== null)
    reasons.add({ code: "current_attempt_attached", effect: "claim_gate" });
  if (
    database
      .prepare(
        "SELECT 1 FROM jobs WHERE id <> ? AND concurrency_key = ? AND status IN ('leased', 'running', 'cancel_requested') LIMIT 1",
      )
      .get(row.id, row.concurrency_key)
  )
    reasons.add({ code: "concurrency_busy", effect: "claim_gate" });
  if (row.enabled === 0) reasons.add({ code: "repository_paused", effect: "claim_gate" });
  if (row.execution_json === null || row.required_capabilities_json === null) {
    reasons.add({ code: "inspection_incomplete", effect: "observation" });
    return runtimeResponse({
      ...base,
      ...empty,
      requirements: { names: [], truncated: true },
      workerInspection: { state: "partial", latestContactAt: null },
      ...reasons.finish(),
    });
  }
  const parsed = parseExecutionTemplate(row.execution_json);
  if (!parsed.ok) {
    reasons.add({ code: "invalid_job_configuration", effect: "claim_gate" });
    return runtimeResponse({ ...base, ...empty, ...reasons.finish() });
  }
  const template = parsed.template;
  validateJobOwnership(row, template);
  runtime.onValidatedTemplate?.(template);
  if (
    row.work_item_id === null &&
    database
      .prepare("SELECT 1 FROM managed_repositories WHERE github_repository_id = ? AND enabled = 0")
      .get(template.repository.githubRepositoryId)
  )
    reasons.add({ code: "repository_paused", effect: "claim_gate" });
  let required: unknown;
  try {
    if (row.required_capabilities_json === null) throw new Error();
    required = JSON.parse(row.required_capabilities_json);
  } catch {
    reasons.add({ code: "invalid_job_configuration", effect: "claim_gate" });
    return runtimeResponse({ ...base, ...empty, ...reasons.finish() });
  }
  if ("validation" in template && template.validation.schemaVersion === "ValidationJobContextV2") {
    const cell = readEvaluationJobBindingInTransaction(database, row.id, template, now);
    if (!cell.applicable || cell.controlStatus !== "active") {
      reasons.add({ code: "authorization_changed", effect: "current_prerequisite" });
    }
    if (cell.reproductionReadiness.state === "blocked") {
      reasons.add({
        code: "plan_prerequisite_missing",
        effect: "current_prerequisite",
        requirement: "evaluation_reproduction_mapping",
      });
    }
  } else if ("validation" in template) {
    const run = readRun(database, template.validation.repositoryId, template.validation.runId, now);
    const request = run?.requests.find(
      (entry) => entry.requestId === template.validation.requestId,
    );
    if (
      !run ||
      !request?.jobs.some(
        (entry) =>
          entry.jobId === row.id && entry.activationNumber === template.validation.jobActivation,
      )
    )
      corrupt();
    runSourceReasons(database, run, reasons);
  } else legacySourceReasons(database, row, reasons);
  const names = requirements([
    required,
    ...("validation" in template
      ? [
          template.validation.profileVersion.config.requiredCapabilities,
          {
            labels: getReviewRunExecutorCapabilityLabels(template.validation, template.validation),
          },
        ]
      : []),
  ]);
  const envelopeByIdentityLength = new Map<string, boolean | null>();
  // Bound repeated schema checks and JSON serialization independently of inventory row count.
  let envelopeInspectionBytes = 0;
  const maximumEnvelopeInspectionBytes = 64 * 1024 * 1024;
  const envelopeWorkBytes =
    Buffer.byteLength(row.execution_json, "utf8") +
    Buffer.byteLength(row.semantic_key, "utf8") +
    4096;
  const executionDeadlineAt = new Date(
    Date.parse(now) + template.executionPolicy.hardTimeoutMs,
  ).toISOString();
  const workerInspection = inspectWorkers(database, reasons, {
    affinity: row.execution_affinity_node_id,
    effect: "claim_gate",
    includeSlots: runtime.includeSlots ?? true,
    ...(runtime.workerId === undefined ? {} : { workerId: runtime.workerId }),
    ...(runtime.onSupportedExecutor === undefined
      ? {}
      : { onSupportedExecutor: runtime.onSupportedExecutor }),
    match: (capabilities) => evaluateJobWorkerCapabilities(template, required, capabilities),
    envelope: (worker) => {
      // Valid EntityIds are ASCII without JSON escapes. Cache only identical identity lengths;
      // the helper still constructs its observation using an actual inspected Worker identity.
      const key = `${worker.node_id.length}:${worker.instance_id.length}`;
      const previous = envelopeByIdentityLength.get(key);
      if (previous !== undefined) return previous;
      if (
        runtime.workerId === undefined &&
        envelopeInspectionBytes + envelopeWorkBytes > maximumEnvelopeInspectionBytes
      ) {
        envelopeByIdentityLength.set(key, null);
        return null;
      }
      envelopeInspectionBytes += envelopeWorkBytes;
      const valid = prepareClaimExecutionEnvelope(template, row, {
        protocolVersion: "1.0",
        assignedAt: now,
        leaseExpiresAt: executionDeadlineAt,
        executionDeadlineAt,
        workerNodeId: worker.node_id,
        workerInstanceId: worker.instance_id,
        runAttemptId: "00000000-0000-4000-8000-000000000000",
        leaseToken: "a".repeat(43),
        leaseGeneration: row.lease_generation + 1,
      }).ok;
      envelopeByIdentityLength.set(key, valid);
      return valid;
    },
  });
  return runtimeResponse({ ...base, workerInspection, requirements: names, ...reasons.finish() });
}

/** Trusted scheduler-only inspection. It shares the exact source and executor observations
 * used by scoped diagnostic reads; caller authorization remains outside this internal helper. */
export function inspectJobAdmissionReadinessInTransaction(
  database: DatabaseSync,
  jobId: string,
  now: string,
  workerId?: string,
): {
  readonly ready: boolean;
  readonly reasons: readonly SchedulingDiagnosticReasonV2[];
  readonly validatedTemplate?: JobExecutionTemplate;
} {
  if (!database.isTransaction || !canonicalTime(now)) invalid();
  const row = getJob(database, jobId);
  if (row === null) corrupt();
  if (
    workerId !== undefined &&
    (row.execution_json === null || row.required_capabilities_json === null)
  ) {
    // Public diagnostics use a smaller observation budget. A real claimant retains the existing
    // claim parser's full stored representation, whose wire response is checked independently.
    // In particular, harmless raw JSON whitespace is not a permanent admission prohibition.
    const stored = database
      .prepare("SELECT execution_json, required_capabilities_json FROM jobs WHERE id = ?")
      .get(jobId) as { execution_json: string; required_capabilities_json: string } | undefined;
    if (stored === undefined) corrupt();
    row.execution_json = stored.execution_json;
    row.required_capabilities_json = stored.required_capabilities_json;
  }
  let supportedExecutor = false;
  let validatedTemplate: JobExecutionTemplate | undefined;
  const observation = jobObservation(database, row, now, jobSubject(row), {
    includeSlots: false,
    ...(workerId === undefined ? {} : { workerId }),
    onSupportedExecutor: () => {
      supportedExecutor = true;
    },
    onValidatedTemplate: (template) => {
      validatedTemplate = template;
    },
  });
  // Admission reserves queue space, not an immediately free execution slot. Retry backoff and
  // concurrency remain fresh claim gates. Partial inventory cannot prove absence, while one
  // positively validated compatible executor is enough to prove an available execution path.
  const reasons = observation.reasons.filter(
    (reason) =>
      reason.code !== "awaiting_admission" &&
      reason.code !== "retry_backoff" &&
      reason.code !== "concurrency_busy" &&
      !(reason.code === "inspection_incomplete" && supportedExecutor),
  );
  return {
    ready: observation.stage === "waiting" && supportedExecutor && reasons.length === 0,
    reasons,
    ...(validatedTemplate === undefined ? {} : { validatedTemplate }),
  };
}

function noJobObservation(
  database: DatabaseSync,
  run: ReviewRunDetail,
  request: ReviewRunPlannedJob,
  now: string,
): SchedulingDiagnosticsV2 {
  const reasons = new Reasons();
  const subject: SchedulingDiagnosticSubject = {
    kind: "validation_request",
    repositoryId: run.repositoryId,
    workItemId: run.workItemId,
    reviewRunId: run.id,
    requestId: request.requestId,
  };
  runSourceReasons(database, run, reasons);
  const repository = database
    .prepare("SELECT enabled FROM managed_repositories WHERE id = ?")
    .get(run.repositoryId);
  if (repository?.enabled === 0)
    reasons.add({ code: "repository_paused", effect: "current_prerequisite" });
  const associations = database
    .prepare("SELECT COUNT(*) AS count FROM review_run_job_links WHERE review_run_id = ?")
    .get(run.id) as { count: number };
  if (!safeInteger(associations.count)) corrupt();
  if (associations.count >= maximumReviewRunJobAssociationCount)
    reasons.add({
      code: "plan_prerequisite_missing",
      effect: "current_prerequisite",
      requirement: "job_association_limit",
    });
  const required = getReviewRunRequiredCapabilities(run.plan, request);
  const optimistic = evaluateReviewRunPlanReadiness(run.plan, [
    {
      workflowKind: request.workflowKind,
      target: request.target,
      capabilities: required,
      evidenceDelivery: true,
    },
  ]).find((entry) => entry.requestId === request.requestId);
  if (!optimistic) corrupt();
  for (const reason of optimistic.reasons)
    reasons.add({
      code: "plan_prerequisite_missing",
      effect: "current_prerequisite",
      requirement: reason.capability ?? reason.code,
    });
  const workerInspection = inspectWorkers(database, reasons, {
    effect: "current_prerequisite",
    includeSlots: false,
    match: (capabilities, worker) => {
      if (
        !Value.Check(WorkerCapabilitiesSchema, capabilities) ||
        sha256(canonicalJson(capabilities)) !== worker.capabilities_digest
      )
        return null;
      if (capabilities.labels.executionEnvelope !== "2") return false;
      const support = getValidationRunnerSupport(run.plan, [capabilities as WorkerCapabilities]);
      const readiness = evaluateReviewRunPlanReadiness(run.plan, support).find(
        (entry) => entry.requestId === request.requestId,
      );
      return (
        readiness !== undefined &&
        !readiness.reasons.some((reason) =>
          ["unsupported_target", "missing_capability", "evidence_delivery_unavailable"].includes(
            reason.code,
          ),
        )
      );
    },
  });
  return runtimeResponse({
    schemaVersion: "SchedulingDiagnosticsV2",
    observedAt: now,
    subject,
    stage: "waiting",
    job: null,
    workerInspection,
    requirements: requirements([required]),
    ...reasons.finish(),
  });
}

/** No asynchronous work or state transition occurs inside this scoped database observation. */
export function handleSchedulingDiagnosticsRequest(
  database: DatabaseSync,
  request: SchedulingDiagnosticsRequest,
  now: string,
  context?: OperatorReadContext,
): SchedulingDiagnostics | null {
  if (
    !request ||
    !isSchedulingDiagnosticsOperation(request.operation) ||
    !Value.Check(inputSchemas[request.operation], request.input) ||
    !canonicalTime(now)
  )
    invalid();
  return readTransaction(database, () => {
    if (request.operation === "getPlatformJobScheduling") {
      if (context) assertPlatformAdministrator(context.actor, context.administrators);
      const job = getJob(database, request.input.jobId);
      return job === null
        ? null
        : currentObservation(
            database,
            jobObservation(database, job, now),
            job.scheduling_bucket_key as string,
            true,
          );
    }
    if (context)
      assertRepositoryPermission(
        database,
        context.actor,
        request.input.repositoryId,
        "read",
        context.administrators,
      );
    else if (
      !database
        .prepare("SELECT 1 FROM managed_repositories WHERE id = ?")
        .get(request.input.repositoryId)
    )
      return null;
    const fullPlatform =
      context === undefined || isPlatformAdministrator(context.actor, context.administrators);
    if (request.operation === "getRepositoryJobScheduling") {
      const job = getJob(database, request.input.jobId, request.input.repositoryId);
      return job === null
        ? null
        : currentObservation(
            database,
            jobObservation(database, job, now),
            job.scheduling_bucket_key as string,
            fullPlatform,
          );
    }
    const input = request.input;
    const association = database
      .prepare(`SELECT run.work_item_id FROM review_runs AS run
      JOIN work_items AS item ON item.id = run.work_item_id AND item.repository_id = run.repository_id
      JOIN review_run_requests AS request ON request.review_run_id = run.id
      WHERE run.repository_id = ? AND run.id = ? AND request.request_id = ?`)
      .get(input.repositoryId, input.reviewRunId, input.requestId);
    if (!association) return null;
    const latest = database
      .prepare(
        "SELECT job_id FROM review_run_job_links WHERE review_run_id = ? AND request_id = ? ORDER BY activation_number DESC LIMIT 1",
      )
      .get(input.reviewRunId, input.requestId) as { job_id: string } | undefined;
    if (latest) {
      const job = getJob(database, latest.job_id, input.repositoryId);
      if (!job || job.work_item_id !== association.work_item_id) corrupt();
      const observation = jobObservation(database, job, now, {
        kind: "validation_request",
        repositoryId: input.repositoryId,
        workItemId: job.work_item_id as string,
        reviewRunId: input.reviewRunId,
        requestId: input.requestId,
      });
      return currentObservation(
        database,
        observation,
        job.scheduling_bucket_key as string,
        fullPlatform,
      );
    }
    const run = readRun(database, input.repositoryId, input.reviewRunId, now);
    const planned = run?.plan.jobs.find((entry) => entry.requestId === input.requestId);
    if (!run || !planned) corrupt();
    const repository = database
      .prepare("SELECT github_repository_id FROM managed_repositories WHERE id = ?")
      .get(input.repositoryId);
    if (!repository || !safeInteger(repository.github_repository_id, 1)) corrupt();
    return currentObservation(
      database,
      noJobObservation(database, run, planned, now),
      `github:${repository.github_repository_id}`,
      fullPlatform,
    );
  });
}
