import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CommittedRunArtifact,
  type CreateResultArtifactUploadRequest,
  type CreateResultArtifactUploadResponse,
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunks,
  type ResultArtifactChunkResponse,
  type ResultArtifactUploadState,
  type TerminateResultArtifactUploadResponse,
} from "@agentic-review/contracts";
import {
  type ArtifactNamespaceObservation,
  type ArtifactNamespaceObservationIdentity,
  type ArtifactNamespaceObservationKind,
  calculateArtifactNamespaceObservationSha256,
  maximumArtifactNamespacePageSize,
  type ParsedArtifactNamespaceEntryKey,
  parseArtifactNamespaceEntryKey,
  snapshotArtifactNamespaceObservations,
  snapshotArtifactNamespaceSweepGeneration,
} from "../artifacts/artifact-namespace-contract.js";
import {
  ArtifactCompletionModeMismatchError,
  ArtifactReconciliationConflictError,
  ArtifactReconciliationInvalidRequestError,
  ArtifactReconciliationStateError,
  ArtifactUploadConflictError,
  ArtifactUploadQuotaExceededError,
  LeaseLostError,
} from "./errors.js";

export const maximumResultArtifactUploadIdentitiesPerAttempt = 8;
export const maximumDeclaredResultArtifactBytesPerAttempt = 16 * 1024 * 1024;
export const maximumArtifactCreateAccountingRows = 4_096;
export const maximumArtifactReconciliationBatchSize = 1_024;
export const maximumArtifactNamespaceHealthRows = 4_096;
export const maximumArtifactCleanupRetryDelaySeconds = 86_400;
export const artifactReconciliationCursorName = "managed_namespace_v2" as const;
export type {
  ArtifactNamespaceObservation,
  ArtifactNamespaceObservationIdentity,
  ArtifactNamespaceObservationKind,
};
export { calculateArtifactNamespaceObservationSha256, maximumArtifactNamespacePageSize };
export const artifactCleanupLiabilityPageSql = `
  WITH due_cleanup AS MATERIALIZED (
    SELECT cleanup.upload_id
    FROM artifact_upload_cleanup_journal AS cleanup
      INDEXED BY ix_artifact_upload_cleanup_journal_due
    WHERE cleanup.status IN ('pending', 'retry_waiting', 'failed')
    ORDER BY cleanup.status, cleanup.next_attempt_at, cleanup.created_at, cleanup.upload_id
    LIMIT ?
  )
  SELECT upload.expected_total_bytes
  FROM due_cleanup
  CROSS JOIN artifact_uploads AS upload
  WHERE upload.id = due_cleanup.upload_id
    AND upload.status IN ('committed', 'abandoned', 'corrupt')
`;
export const artifactDueCleanupPageSql = `
  SELECT
    cleanup.upload_id,
    cleanup.terminal_status AS journal_terminal_status,
    cleanup.cleanup_scope,
    cleanup.status AS cleanup_status,
    cleanup.attempt_count,
    cleanup.next_attempt_at,
    cleanup.last_error_code,
    cleanup.last_error_message,
    cleanup.last_retry_delay_seconds,
    upload.status AS upload_status,
    upload.finalization_id,
    upload.final_total_bytes,
    upload.final_sha256
  FROM artifact_upload_cleanup_journal AS cleanup
    INDEXED BY ix_artifact_upload_cleanup_journal_due_v2
  JOIN artifact_uploads AS upload ON upload.id = cleanup.upload_id
  WHERE cleanup.status IN ('pending', 'retry_waiting')
    AND (
      cleanup.status = 'pending'
      OR (cleanup.status = 'retry_waiting' AND cleanup.next_attempt_at <= ?)
    )
  ORDER BY COALESCE(cleanup.next_attempt_at, cleanup.created_at), cleanup.upload_id
  LIMIT ?
`;
export const artifactNamespaceHealthStatusPageSql = `
  SELECT 1 AS present
  FROM artifact_namespace_cleanup_journal
    INDEXED BY ix_artifact_namespace_cleanup_health_status
  WHERE status = ?
  ORDER BY entry_key, observation_sha256
  LIMIT ?
`;
export const artifactNamespaceHealthDuePageSql = `
  SELECT 1 AS present
  FROM artifact_namespace_cleanup_journal
    INDEXED BY ix_artifact_namespace_cleanup_due
  WHERE status IN ('pending', 'retry_waiting')
    AND (
      status = 'pending'
      OR (status = 'retry_waiting' AND next_attempt_at <= ?)
    )
  ORDER BY COALESCE(next_attempt_at, created_at), entry_key, observation_sha256
  LIMIT ?
`;
export const artifactNamespaceHealthOldestOutstandingSql = `
  SELECT created_at
  FROM artifact_namespace_cleanup_journal
    INDEXED BY ix_artifact_namespace_cleanup_outstanding_created
  WHERE status IN ('pending', 'retry_waiting', 'failed')
  ORDER BY created_at, entry_key, observation_sha256
  LIMIT 1
`;

type ArtifactLeaseIdentity = Pick<
  CreateResultArtifactUploadRequest,
  "jobId" | "runAttemptId" | "workerNodeId" | "workerInstanceId" | "leaseToken" | "leaseGeneration"
>;

export type CreateArtifactUploadInput = CreateResultArtifactUploadRequest;

export type CreateArtifactUploadResult = CreateResultArtifactUploadResponse;

export interface ArtifactUploadExpectedByteSizeBucket {
  readonly expectedTotalBytes: number;
  readonly uploadCount: number;
}

export interface ArtifactUploadCreateAccounting {
  /** Capacity admission must fail closed when a bounded aggregate cannot be represented exactly. */
  readonly accountingCertain: boolean;
  /** Counts active uploads plus terminal uploads whose staging cleanup remains unresolved. */
  readonly liveUploadCount: number;
  readonly liveUploadExpectedByteSizeBuckets: readonly ArtifactUploadExpectedByteSizeBucket[];
  readonly cleanupBacklogEntries: number;
}

export type ArtifactUploadAuthorityClosureReason =
  | "attempt_inactive"
  | "job_inactive"
  | "attempt_not_current"
  | "lease_expired"
  | "execution_deadline_expired"
  | "no_progress_deadline_expired"
  | "worker_superseded"
  | "completion_mode_inactive"
  | "metadata_fence_mismatch";

export interface TerminalizeInactiveArtifactUploadsInput {
  readonly batchSize: number;
}

export interface TerminalizedInactiveArtifactUpload {
  readonly uploadId: string;
  readonly state: "abandoned" | "corrupt";
  readonly reason: ArtifactUploadAuthorityClosureReason;
  readonly terminatedAt: string;
}

export interface TerminalizeInactiveArtifactUploadsResult {
  readonly terminalized: readonly TerminalizedInactiveArtifactUpload[];
  readonly hasMore: boolean;
}

export type ArtifactCleanupRetryErrorCode =
  | "storage_busy"
  | "storage_io_failure"
  | "storage_timeout"
  | "storage_unavailable";

export interface ListDueArtifactCleanupsInput {
  readonly batchSize: number;
}

export interface ArtifactCleanupWorkItem {
  readonly uploadId: string;
  readonly terminalStatus: "committed" | "abandoned" | "corrupt";
  readonly cleanupScope: "staging_only_v1";
  readonly expectedAttemptCount: number;
  readonly lastRetryDelaySeconds: number | null;
  readonly publications: readonly {
    readonly finalizationId: string;
    readonly totalBytes: number;
    readonly sha256: string;
  }[];
}

export interface ListDueArtifactCleanupsResult {
  readonly items: readonly ArtifactCleanupWorkItem[];
  readonly hasMore: boolean;
}

export interface CompleteArtifactCleanupInput {
  readonly uploadId: string;
  readonly expectedAttemptCount: number;
}

export interface CompleteArtifactCleanupResult {
  readonly uploadId: string;
  readonly status: "completed";
  readonly attemptCount: number;
  readonly completedAt: string;
  readonly replayed: boolean;
}

export interface RecordArtifactCleanupFailureInput extends CompleteArtifactCleanupInput {
  readonly errorCode: ArtifactCleanupRetryErrorCode;
  readonly retryDelaySeconds: number;
}

export interface RecordArtifactCleanupFailureResult {
  readonly uploadId: string;
  readonly status: "retry_waiting" | "failed";
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly errorCode: ArtifactCleanupRetryErrorCode;
  readonly retryDelaySeconds: number;
  readonly replayed: boolean;
}

export interface ArtifactHealthAccounting {
  readonly activeUploads: {
    readonly receiving: number;
    readonly finalizing: number;
  };
  readonly cleanup: {
    readonly pending: number;
    readonly retryWaiting: number;
    readonly due: number;
    readonly completed: number;
    readonly failed: number;
    readonly invalidRetryIdentity: number;
    readonly oldestOutstandingAt: string | null;
  };
  readonly namespaceCleanup: {
    readonly pending: number;
    readonly retryWaiting: number;
    readonly due: number;
    readonly completed: number;
    readonly failed: number;
    readonly superseded: number;
    readonly oldestOutstandingAt: string | null;
    readonly operationalSaturated: boolean;
    readonly historicalSaturated: boolean;
  };
  readonly capacity: ArtifactUploadCreateAccounting;
}

export interface ArtifactReconciliationCursor {
  readonly name: typeof artifactReconciliationCursorName;
  readonly sweepGeneration: number;
  readonly afterKey: string | null;
  readonly updatedAt: string;
  readonly lastCompletedAt: string | null;
}

export interface ClassifyArtifactNamespacePageInput {
  readonly expectedSweepGeneration: number;
  readonly expectedAfterKey: string | null;
  readonly observations: readonly ArtifactNamespaceObservation[];
  readonly completedSweep: boolean;
}

export type ArtifactNamespaceCleanupReason =
  | "orphan"
  | "completed_residual"
  | "stale_identity_mismatch";

export interface ArtifactNamespaceClassification {
  readonly entryKey: string;
  readonly observationSha256: string;
  readonly disposition:
    | "active_reference"
    | "upload_cleanup_covered"
    | "cleanup_intent_created"
    | "cleanup_intent_replayed";
  readonly reason: ArtifactNamespaceCleanupReason | null;
  readonly supersededPriorIntent: boolean;
}

export interface ClassifyArtifactNamespacePageResult {
  readonly classifications: readonly ArtifactNamespaceClassification[];
  readonly cursor: ArtifactReconciliationCursor;
}

export interface ListDueArtifactNamespaceCleanupsInput {
  readonly batchSize: number;
}

export interface ArtifactNamespaceCleanupWorkItem extends ArtifactNamespaceObservation {
  readonly reason: ArtifactNamespaceCleanupReason;
  readonly observedSweepGeneration: number;
  readonly expectedAttemptCount: number;
  readonly lastRetryDelaySeconds: number | null;
}

export interface ListDueArtifactNamespaceCleanupsResult {
  readonly items: readonly ArtifactNamespaceCleanupWorkItem[];
  readonly hasMore: boolean;
}

export interface CompleteArtifactNamespaceCleanupInput {
  readonly entryKey: string;
  readonly observationSha256: string;
  readonly expectedAttemptCount: number;
}

export interface CompleteArtifactNamespaceCleanupResult {
  readonly entryKey: string;
  readonly observationSha256: string;
  readonly status: "completed";
  readonly attemptCount: number;
  readonly completedAt: string;
  readonly replayed: boolean;
}

export interface RecordArtifactNamespaceCleanupFailureInput
  extends CompleteArtifactNamespaceCleanupInput {
  readonly errorCode: ArtifactCleanupRetryErrorCode;
  readonly retryDelaySeconds: number;
}

export interface RecordArtifactNamespaceCleanupFailureResult {
  readonly entryKey: string;
  readonly observationSha256: string;
  readonly status: "retry_waiting" | "failed";
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly errorCode: ArtifactCleanupRetryErrorCode;
  readonly retryDelaySeconds: number;
  readonly replayed: boolean;
}

export type ProbeArtifactUploadCreateResult =
  | {
      readonly disposition: "exact-replay";
      readonly result: CreateArtifactUploadResult;
    }
  | {
      readonly disposition: "new";
      readonly accounting: ArtifactUploadCreateAccounting;
    };

interface ArtifactChunkMetadata {
  readonly chunkIndex: number;
  readonly offsetBytes: number;
  readonly chunkBytes: number;
  readonly chunkSha256: string;
}

export interface ArtifactCommittedChunkReceipt {
  readonly chunkIndex: number;
  readonly offsetBytes: number;
  readonly chunkBytes: number;
  readonly chunkSha256: string;
}

export interface PrepareArtifactChunkInput extends ArtifactLeaseIdentity, ArtifactChunkMetadata {
  readonly uploadId: string;
}

export interface PrepareArtifactChunkResult extends ArtifactChunkMetadata {
  readonly uploadId: string;
  readonly prepareId: string;
  readonly receiptState: "prepared" | "committed";
  readonly replayed: boolean;
  readonly committedNextChunkIndex: number;
  readonly committedOffsetBytes: number;
  readonly committedPrefix: readonly ArtifactCommittedChunkReceipt[];
  readonly preparedNextChunkIndex: number;
  readonly preparedNextOffsetBytes: number;
}

export interface CommitArtifactChunkInput extends PrepareArtifactChunkInput {
  readonly prepareId: string;
}

interface CommitArtifactChunkResultFields {
  readonly uploadId: string;
  readonly prepareId: string;
  readonly chunkIndex: number;
  readonly nextChunkIndex: number;
  readonly nextOffsetBytes: number;
}

export type CommitArtifactChunkResult =
  | (CommitArtifactChunkResultFields & {
      readonly state: "receiving";
      readonly outcome: "accepted";
    })
  | (CommitArtifactChunkResultFields & {
      readonly state: "receiving" | "finalizing" | "committed";
      readonly outcome: "replayed";
    });

export const toResultArtifactChunkResponse = (
  result: CommitArtifactChunkResult,
): ResultArtifactChunkResponse => {
  const response = {
    uploadId: result.uploadId,
    chunkIndex: result.chunkIndex,
    nextChunkIndex: result.nextChunkIndex,
    nextOffsetBytes: result.nextOffsetBytes,
  };
  if (result.outcome === "accepted") {
    return { ...response, state: "receiving", outcome: "accepted" };
  }
  return { ...response, state: result.state, outcome: "replayed" };
};

interface ArtifactFinalizeMetadata {
  readonly chunkCount: number;
  readonly totalBytes: number;
  readonly sha256: string;
}

export interface PrepareArtifactFinalizeInput
  extends ArtifactLeaseIdentity,
    ArtifactFinalizeMetadata {
  readonly uploadId: string;
}

export interface PrepareArtifactFinalizeResult extends ArtifactFinalizeMetadata {
  readonly uploadId: string;
  readonly finalizationId: string;
  readonly artifactId: string;
  readonly storageObjectKey: string;
  readonly state: "finalizing" | "committed";
  readonly replayed: boolean;
}

export interface CommitArtifactFinalizeInput extends PrepareArtifactFinalizeInput {
  readonly finalizationId: string;
  readonly storageObjectKey: string;
}

export interface CommitArtifactFinalizeResult {
  readonly state: "committed";
  readonly replayed: boolean;
  readonly artifact: CommittedRunArtifact & { readonly storageObjectKey: string };
}

export interface TerminateArtifactUploadInput extends ArtifactLeaseIdentity {
  readonly uploadId: string;
  readonly state: "abandoned" | "corrupt";
  readonly reason: string;
}

export interface TerminateArtifactUploadResult {
  readonly uploadId: string;
  readonly state: "abandoned" | "corrupt";
  readonly reason: string;
  readonly terminatedAt: string;
  readonly replayed: boolean;
}

export const toTerminateResultArtifactUploadResponse = (
  result: TerminateArtifactUploadResult,
): TerminateResultArtifactUploadResponse => {
  if (result.state !== "abandoned" || result.reason !== "client_abandoned") {
    throw new TypeError(
      "Only client-abandoned artifact upload terminations can be returned to a Worker.",
    );
  }
  return {
    uploadId: result.uploadId,
    state: "abandoned",
    reason: "client_abandoned",
    terminatedAt: result.terminatedAt,
    replayed: result.replayed,
  };
};

interface ActiveLeaseRow {
  readonly job_id: string;
  readonly worker_node_id: string;
  readonly worker_instance_id: string;
  readonly attempt_status: string;
  readonly completion_mode: "inline_result_v1" | "result_artifact_v1";
  readonly lease_token_hash: string;
  readonly lease_generation: number;
  readonly lease_expires_at: string;
  readonly execution_deadline_at: string;
  readonly no_progress_deadline_at: string;
  readonly job_status: string;
  readonly current_run_attempt_id: string | null;
  readonly worker_superseded_at: string | null;
}

interface ArtifactUploadRow {
  readonly id: string;
  readonly job_id: string;
  readonly run_attempt_id: string;
  readonly worker_node_id: string;
  readonly worker_instance_id: string;
  readonly lease_generation: number;
  readonly client_artifact_id: string;
  readonly purpose: "result";
  readonly name: string;
  readonly media_type: "application/json";
  readonly expected_total_bytes: number;
  readonly expected_sha256: string;
  readonly status: ResultArtifactUploadState;
  readonly next_chunk_index: number;
  readonly received_bytes: number;
  readonly finalization_id: string | null;
  readonly final_chunk_count: number | null;
  readonly final_total_bytes: number | null;
  readonly final_sha256: string | null;
  readonly terminated_at: string | null;
  readonly termination_reason: string | null;
}

interface ArtifactChunkRow {
  readonly upload_id: string;
  readonly chunk_index: number;
  readonly prepare_id: string;
  readonly offset_bytes: number;
  readonly chunk_bytes: number;
  readonly chunk_sha256: string;
  readonly status: "prepared" | "committed";
}

interface CommittedArtifactChunkRow {
  readonly chunk_index: number;
  readonly offset_bytes: number;
  readonly chunk_bytes: number;
  readonly chunk_sha256: string;
}

interface RunArtifactRow {
  readonly id: string;
  readonly upload_id: string;
  readonly job_id: string;
  readonly run_attempt_id: string;
  readonly client_artifact_id: string;
  readonly purpose: "result";
  readonly name: string;
  readonly media_type: "application/json";
  readonly total_bytes: number;
  readonly sha256: string;
  readonly storage_object_key: string;
}

interface InactiveArtifactUploadRow {
  readonly id: string;
  readonly upload_run_attempt_id: string;
  readonly upload_worker_node_id: string;
  readonly upload_worker_instance_id: string;
  readonly upload_lease_generation: number;
  readonly attempt_worker_node_id: string;
  readonly attempt_worker_instance_id: string;
  readonly attempt_lease_generation: number;
  readonly attempt_status: string;
  readonly completion_mode: string;
  readonly lease_expires_at: string;
  readonly execution_deadline_at: string;
  readonly no_progress_deadline_at: string;
  readonly job_status: string;
  readonly current_run_attempt_id: string | null;
  readonly worker_superseded_at: string | null;
}

interface ArtifactCleanupWorkRow {
  readonly upload_id: string;
  readonly journal_terminal_status: string;
  readonly cleanup_scope: string;
  readonly cleanup_status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly last_retry_delay_seconds: number | null;
  readonly upload_status: string;
  readonly finalization_id: string | null;
  readonly final_total_bytes: number | null;
  readonly final_sha256: string | null;
}

interface ArtifactCleanupJournalRow {
  readonly upload_id: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly last_retry_delay_seconds: number | null;
  readonly completed_at: string | null;
}

interface ArtifactReconciliationCursorRow {
  readonly name: string;
  readonly sweep_generation: number;
  readonly after_key: string | null;
  readonly updated_at: string;
  readonly last_completed_at: string | null;
}

interface ArtifactNamespaceUploadRow {
  readonly id: string;
  readonly status: string;
  readonly expected_total_bytes: number;
  readonly received_bytes: number;
  readonly finalization_id: string | null;
  readonly final_total_bytes: number | null;
  readonly final_sha256: string | null;
}

interface ArtifactNamespaceCleanupRow {
  readonly entry_key: string;
  readonly observation_sha256: string;
  readonly kind: string;
  readonly linked_object_sha256: string | null;
  readonly observed_bytes: number;
  readonly expected_link_count: number;
  readonly file_device: string;
  readonly file_inode: string;
  readonly file_ctime_ns: string;
  readonly file_mode: string;
  readonly file_uid: string;
  readonly parent_device: string;
  readonly parent_inode: string;
  readonly parent_mode: string;
  readonly parent_uid: string;
  readonly linked_object_device: string | null;
  readonly linked_object_inode: string | null;
  readonly linked_object_ctime_ns: string | null;
  readonly reason: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly last_retry_delay_seconds: number | null;
  readonly observed_sweep_generation: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly superseded_at: string | null;
}

const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const artifactNamePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const cleanupRetryMessages: Readonly<Record<ArtifactCleanupRetryErrorCode, string>> = Object.freeze(
  {
    storage_busy: "Artifact staging cleanup is temporarily busy.",
    storage_io_failure: "Artifact staging cleanup encountered a storage I/O failure.",
    storage_timeout: "Artifact staging cleanup exceeded its bounded deadline.",
    storage_unavailable: "Artifact staging cleanup owner is unavailable.",
  },
);
const namespaceCleanupRetryMessages: Readonly<Record<ArtifactCleanupRetryErrorCode, string>> =
  Object.freeze({
    storage_busy: "Artifact namespace cleanup is temporarily busy.",
    storage_io_failure: "Artifact namespace cleanup encountered a storage I/O failure.",
    storage_timeout: "Artifact namespace cleanup exceeded its bounded deadline.",
    storage_unavailable: "Artifact namespace cleanup owner is unavailable.",
  });
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const securelyMatchesSha256 = (actual: string, expected: string): boolean =>
  sha256Pattern.test(actual) &&
  sha256Pattern.test(expected) &&
  timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));

const snapshotExactInput = (
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      throw new TypeError();
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw new ArtifactReconciliationInvalidRequestError();
  }
};

const snapshotEmptyReconciliationInput = (value: unknown): void => {
  snapshotExactInput(value, []);
};

const snapshotReconciliationBatchSize = (value: unknown): number => {
  const snapshot = snapshotExactInput(value, ["batchSize"]);
  const batchSize = snapshot.batchSize;
  if (
    !Number.isSafeInteger(batchSize) ||
    (batchSize as number) < 1 ||
    (batchSize as number) > maximumArtifactReconciliationBatchSize
  ) {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  return batchSize as number;
};

const requireCanonicalDateTime = (value: unknown): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new ArtifactReconciliationStateError();
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ArtifactReconciliationStateError();
  }
  return value;
};

const requireReconciliationCount = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ArtifactReconciliationStateError();
  }
  return value as number;
};

const requireReconciliationCursorKey = (value: unknown): string => {
  try {
    return parseArtifactNamespaceEntryKey(value).entryKey;
  } catch {
    throw new ArtifactReconciliationInvalidRequestError();
  }
};

const snapshotExpectedCleanupAttempt = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 7) {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  return value as number;
};

const expectedCleanupStatus = (attemptCount: number): "pending" | "retry_waiting" =>
  attemptCount === 0 ? "pending" : "retry_waiting";

const snapshotClassifyArtifactNamespacePageInput = (
  value: unknown,
): ClassifyArtifactNamespacePageInput => {
  const snapshot = snapshotExactInput(value, [
    "expectedSweepGeneration",
    "expectedAfterKey",
    "observations",
    "completedSweep",
  ]);
  let expectedSweepGeneration: number;
  let expectedAfterKey: string | null;
  let observations: readonly ArtifactNamespaceObservation[];
  try {
    expectedSweepGeneration = snapshotArtifactNamespaceSweepGeneration(
      snapshot.expectedSweepGeneration,
    );
    expectedAfterKey =
      snapshot.expectedAfterKey === null
        ? null
        : parseArtifactNamespaceEntryKey(snapshot.expectedAfterKey).entryKey;
    observations = snapshotArtifactNamespaceObservations(snapshot.observations);
  } catch {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  const completedSweep = snapshot.completedSweep;
  if (
    typeof completedSweep !== "boolean" ||
    (!completedSweep && observations.length === 0) ||
    (completedSweep && expectedSweepGeneration === Number.MAX_SAFE_INTEGER)
  ) {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  let priorKey = expectedAfterKey;
  for (const observation of observations) {
    if (priorKey !== null && observation.entryKey <= priorKey) {
      throw new ArtifactReconciliationInvalidRequestError();
    }
    priorKey = observation.entryKey;
  }
  return Object.freeze({
    expectedSweepGeneration,
    expectedAfterKey,
    observations,
    completedSweep,
  });
};

/** Internal Server authority only; Worker-facing routes must never dispatch these operations. */
export type ArtifactReconciliationDatabaseOperation =
  | "terminalizeInactiveArtifactUploads"
  | "listDueArtifactCleanups"
  | "completeArtifactCleanup"
  | "recordArtifactCleanupFailure"
  | "classifyArtifactNamespacePageAndAdvanceCursor"
  | "listDueArtifactNamespaceCleanups"
  | "completeArtifactNamespaceCleanup"
  | "recordArtifactNamespaceCleanupFailure"
  | "readArtifactHealthAccounting"
  | "readArtifactReconciliationCursor";

export const isArtifactReconciliationDatabaseOperation = (
  operation: string,
): operation is ArtifactReconciliationDatabaseOperation => {
  switch (operation) {
    case "terminalizeInactiveArtifactUploads":
    case "listDueArtifactCleanups":
    case "completeArtifactCleanup":
    case "recordArtifactCleanupFailure":
    case "classifyArtifactNamespacePageAndAdvanceCursor":
    case "listDueArtifactNamespaceCleanups":
    case "completeArtifactNamespaceCleanup":
    case "recordArtifactNamespaceCleanupFailure":
    case "readArtifactHealthAccounting":
    case "readArtifactReconciliationCursor":
      return true;
    default:
      return false;
  }
};

export const snapshotArtifactReconciliationDatabaseInput = (
  operation: ArtifactReconciliationDatabaseOperation,
  value: unknown,
): Readonly<Record<string, unknown>> => {
  switch (operation) {
    case "terminalizeInactiveArtifactUploads":
    case "listDueArtifactCleanups":
    case "listDueArtifactNamespaceCleanups":
      return snapshotExactInput(value, ["batchSize"]);
    case "completeArtifactCleanup":
      return snapshotExactInput(value, ["uploadId", "expectedAttemptCount"]);
    case "recordArtifactCleanupFailure":
      return snapshotExactInput(value, [
        "uploadId",
        "expectedAttemptCount",
        "errorCode",
        "retryDelaySeconds",
      ]);
    case "classifyArtifactNamespacePageAndAdvanceCursor":
      return snapshotClassifyArtifactNamespacePageInput(value) as unknown as Readonly<
        Record<string, unknown>
      >;
    case "completeArtifactNamespaceCleanup":
      return snapshotArtifactNamespaceCleanupMutationIdentity(value) as unknown as Readonly<
        Record<string, unknown>
      >;
    case "recordArtifactNamespaceCleanupFailure":
      return snapshotExactInput(value, [
        "entryKey",
        "observationSha256",
        "expectedAttemptCount",
        "errorCode",
        "retryDelaySeconds",
      ]);
    case "readArtifactHealthAccounting":
    case "readArtifactReconciliationCursor":
      return snapshotExactInput(value, []);
    default:
      throw new ArtifactReconciliationInvalidRequestError();
  }
};

const withImmediateTransaction = <T>(database: DatabaseSync, action: () => T): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const withArtifactReconciliationTransaction = <T>(database: DatabaseSync, action: () => T): T => {
  try {
    return withImmediateTransaction(database, action);
  } catch (error) {
    if (
      error instanceof ArtifactReconciliationInvalidRequestError ||
      error instanceof ArtifactReconciliationConflictError ||
      error instanceof ArtifactReconciliationStateError
    ) {
      throw error;
    }
    throw new ArtifactReconciliationStateError();
  }
};

export const probeArtifactUploadCreate = (
  database: DatabaseSync,
  input: CreateArtifactUploadInput,
): ProbeArtifactUploadCreateResult =>
  withImmediateTransaction(database, () => {
    validateCreateInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);

    const replay = resolveArtifactUploadCreateReplay(database, input);
    if (replay !== undefined) {
      return { disposition: "exact-replay", result: replay };
    }

    requireArtifactUploadQuota(database, input.runAttemptId, input.totalBytes);
    requireNoLiveResultArtifactUpload(database, input.runAttemptId);
    return {
      disposition: "new",
      accounting: readArtifactUploadCreateAccounting(database),
    };
  });

export const createArtifactUpload = (
  database: DatabaseSync,
  input: CreateArtifactUploadInput,
): CreateArtifactUploadResult =>
  withImmediateTransaction(database, () => {
    validateCreateInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);

    const replay = resolveArtifactUploadCreateReplay(database, input);
    if (replay !== undefined) {
      return replay;
    }

    requireArtifactUploadQuota(database, input.runAttemptId, input.totalBytes);
    requireNoLiveResultArtifactUpload(database, input.runAttemptId);

    const uploadId = randomUUID();
    database
      .prepare(`
        INSERT INTO artifact_uploads (
          id,
          job_id,
          run_attempt_id,
          worker_node_id,
          worker_instance_id,
          lease_generation,
          client_artifact_id,
          purpose,
          name,
          media_type,
          expected_total_bytes,
          expected_sha256,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receiving', ?, ?)
      `)
      .run(
        uploadId,
        input.jobId,
        input.runAttemptId,
        input.workerNodeId,
        input.workerInstanceId,
        input.leaseGeneration,
        input.clientArtifactId,
        input.purpose,
        input.name,
        input.mediaType,
        input.totalBytes,
        input.sha256,
        now,
        now,
      );

    const created = requireUpload(database, uploadId);
    return createNewUploadResult(created);
  });

function resolveArtifactUploadCreateReplay(
  database: DatabaseSync,
  input: CreateArtifactUploadInput,
): CreateArtifactUploadResult | undefined {
  const existing = findUploadByClientId(database, input.runAttemptId, input.clientArtifactId);
  if (existing === undefined) {
    return undefined;
  }
  requireUploadBinding(existing, input);
  if (!matchesCreateMetadata(existing, input)) {
    throw new ArtifactUploadConflictError();
  }
  return createUploadReplayResult(existing);
}

function requireNoLiveResultArtifactUpload(database: DatabaseSync, runAttemptId: string): void {
  const liveResult = database
    .prepare(`
      SELECT id
      FROM artifact_uploads
      WHERE run_attempt_id = ?
        AND purpose = 'result'
        AND status IN ('receiving', 'finalizing', 'committed')
    `)
    .get(runAttemptId) as unknown as { readonly id: string } | undefined;
  if (liveResult !== undefined) {
    throw new ArtifactUploadConflictError(
      "The run attempt already has a live result artifact upload.",
    );
  }
}

function readArtifactUploadCreateAccounting(
  database: DatabaseSync,
): ArtifactUploadCreateAccounting {
  const activeRows = database
    .prepare(`
      SELECT upload.expected_total_bytes
      FROM artifact_uploads AS upload INDEXED BY ix_artifact_uploads_recovery
      WHERE upload.status IN ('receiving', 'finalizing')
      ORDER BY upload.status, upload.updated_at
      LIMIT ?
    `)
    .all(maximumArtifactCreateAccountingRows + 1) as unknown as readonly {
    readonly expected_total_bytes: number;
  }[];
  let accountingCertain = activeRows.length <= maximumArtifactCreateAccountingRows;
  const initialNamespaceSweepCompleted =
    readReconciliationCursor(database).lastCompletedAt !== null;
  const liabilityRows = activeRows.slice(0, maximumArtifactCreateAccountingRows);
  let cleanupBacklogEntries = 0;
  if (accountingCertain) {
    const remainingRows = maximumArtifactCreateAccountingRows - liabilityRows.length;
    const cleanupRows = database
      .prepare(artifactCleanupLiabilityPageSql)
      .all(remainingRows + 1) as unknown as readonly {
      readonly expected_total_bytes: number;
    }[];
    cleanupBacklogEntries = cleanupRows.length;
    if (cleanupRows.length > remainingRows) {
      accountingCertain = false;
    }
    liabilityRows.push(...cleanupRows.slice(0, remainingRows));
  }
  const namespaceCleanupRows = database
    .prepare(`
      SELECT status
      FROM artifact_namespace_cleanup_journal
        INDEXED BY ux_artifact_namespace_cleanup_unresolved_entry
      WHERE status IN ('pending', 'retry_waiting', 'failed')
      ORDER BY entry_key
      LIMIT ?
    `)
    .all(maximumArtifactCreateAccountingRows + 1) as unknown as readonly {
    readonly status: "pending" | "retry_waiting" | "failed";
  }[];
  const failedNamespaceCleanup = database
    .prepare(`
      SELECT 1 AS present
      FROM artifact_namespace_cleanup_journal
        INDEXED BY ix_artifact_namespace_cleanup_health_status
      WHERE status = 'failed'
      LIMIT 1
    `)
    .get();
  if (
    namespaceCleanupRows.length > maximumArtifactCreateAccountingRows ||
    failedNamespaceCleanup !== undefined
  ) {
    accountingCertain = false;
  }
  cleanupBacklogEntries += Math.min(
    namespaceCleanupRows.length,
    maximumArtifactCreateAccountingRows,
  );
  if (!initialNamespaceSweepCompleted) {
    accountingCertain = false;
  }

  const bucketCounts = new Map<number, number>();
  for (const row of liabilityRows) {
    if (
      !Number.isSafeInteger(row.expected_total_bytes) ||
      row.expected_total_bytes < 1 ||
      row.expected_total_bytes > maximumResultArtifactBytes
    ) {
      throw new ArtifactUploadConflictError(
        "Artifact capacity accounting contains an invalid expected byte size.",
      );
    }
    bucketCounts.set(
      row.expected_total_bytes,
      (bucketCounts.get(row.expected_total_bytes) ?? 0) + 1,
    );
  }
  const liveUploadExpectedByteSizeBuckets = Object.freeze(
    [...bucketCounts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([expectedTotalBytes, uploadCount]) =>
        Object.freeze({ expectedTotalBytes, uploadCount }),
      ),
  );

  return Object.freeze({
    accountingCertain,
    liveUploadCount: liabilityRows.length,
    liveUploadExpectedByteSizeBuckets,
    cleanupBacklogEntries,
  });
}

function requireArtifactUploadQuota(
  database: DatabaseSync,
  runAttemptId: string,
  requestedBytes: number,
): void {
  const usage = database
    .prepare(`
      SELECT
        COUNT(*) AS upload_count,
        COALESCE(SUM(expected_total_bytes), 0) AS declared_bytes
      FROM artifact_uploads
      WHERE run_attempt_id = ?
    `)
    .get(runAttemptId) as unknown as {
    readonly upload_count: number;
    readonly declared_bytes: number;
  };
  if (usage.declared_bytes > maximumDeclaredResultArtifactBytesPerAttempt - requestedBytes) {
    throw new ArtifactUploadQuotaExceededError(
      "The run attempt has exhausted its declared result artifact byte quota.",
    );
  }
  if (usage.upload_count >= maximumResultArtifactUploadIdentitiesPerAttempt) {
    throw new ArtifactUploadQuotaExceededError(
      "The run attempt has exhausted its result artifact upload identity quota.",
    );
  }
}

export const prepareArtifactChunk = (
  database: DatabaseSync,
  input: PrepareArtifactChunkInput,
): PrepareArtifactChunkResult =>
  withImmediateTransaction(database, () => {
    validateChunkInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);
    const committedPrefix = readCommittedArtifactPrefix(database, upload);

    const existing = findChunk(database, input.uploadId, input.chunkIndex);
    if (existing !== undefined) {
      if (!matchesChunkMetadata(existing, input)) {
        throw new ArtifactUploadConflictError(
          "The artifact chunk index already has different immutable metadata.",
        );
      }
      if (
        existing.status === "prepared" &&
        (upload.status !== "receiving" ||
          existing.chunk_index !== upload.next_chunk_index ||
          existing.offset_bytes !== upload.received_bytes)
      ) {
        throw new ArtifactUploadConflictError(
          "The prepared artifact chunk no longer follows the committed upload prefix.",
        );
      }
      if (
        existing.status === "committed" &&
        upload.status !== "receiving" &&
        upload.status !== "finalizing" &&
        upload.status !== "committed"
      ) {
        throw new ArtifactUploadConflictError(
          "The committed artifact chunk belongs to a terminated upload.",
        );
      }
      if (existing.status === "committed") {
        requireCommittedReplayReceipt(committedPrefix, existing);
      }
      return prepareChunkResult(upload, existing, committedPrefix, true);
    }

    if (
      upload.status !== "receiving" ||
      input.chunkIndex !== upload.next_chunk_index ||
      input.offsetBytes !== upload.received_bytes ||
      input.offsetBytes + input.chunkBytes > upload.expected_total_bytes
    ) {
      throw new ArtifactUploadConflictError(
        "The artifact chunk does not match the current upload cursor.",
      );
    }

    const receipt: ArtifactChunkRow = {
      upload_id: input.uploadId,
      chunk_index: input.chunkIndex,
      prepare_id: randomUUID(),
      offset_bytes: input.offsetBytes,
      chunk_bytes: input.chunkBytes,
      chunk_sha256: input.chunkSha256,
      status: "prepared",
    };
    database
      .prepare(`
        INSERT INTO artifact_upload_chunks (
          upload_id,
          chunk_index,
          prepare_id,
          offset_bytes,
          chunk_bytes,
          chunk_sha256,
          status,
          prepared_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)
      `)
      .run(
        receipt.upload_id,
        receipt.chunk_index,
        receipt.prepare_id,
        receipt.offset_bytes,
        receipt.chunk_bytes,
        receipt.chunk_sha256,
        now,
      );
    database.prepare("UPDATE artifact_uploads SET updated_at = ? WHERE id = ?").run(now, upload.id);
    return prepareChunkResult(upload, receipt, committedPrefix, false);
  });

export const commitArtifactChunk = (
  database: DatabaseSync,
  input: CommitArtifactChunkInput,
): CommitArtifactChunkResult =>
  // The caller may commit only after the prepared bytes are durable in the staging object.
  withImmediateTransaction(database, () => {
    validateChunkInput(input);
    requireUuid(input.prepareId, "prepareId");
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);
    const receipt = findChunk(database, input.uploadId, input.chunkIndex);
    if (
      receipt === undefined ||
      receipt.prepare_id !== input.prepareId ||
      !matchesChunkMetadata(receipt, input)
    ) {
      throw new ArtifactUploadConflictError(
        "The artifact chunk commit does not match its prepared receipt.",
      );
    }

    if (receipt.status === "committed") {
      if (
        upload.status !== "receiving" &&
        upload.status !== "finalizing" &&
        upload.status !== "committed"
      ) {
        throw new ArtifactUploadConflictError(
          "The committed artifact chunk belongs to a terminated upload.",
        );
      }
      return commitChunkReplayResult(upload, receipt);
    }
    if (
      upload.status !== "receiving" ||
      upload.next_chunk_index !== receipt.chunk_index ||
      upload.received_bytes !== receipt.offset_bytes
    ) {
      throw new ArtifactUploadConflictError(
        "The prepared artifact chunk no longer matches the upload cursor.",
      );
    }

    const receiptUpdate = database
      .prepare(`
        UPDATE artifact_upload_chunks
        SET status = 'committed', committed_at = ?
        WHERE upload_id = ? AND chunk_index = ? AND prepare_id = ? AND status = 'prepared'
      `)
      .run(now, receipt.upload_id, receipt.chunk_index, receipt.prepare_id);
    if (Number(receiptUpdate.changes) !== 1) {
      throw new ArtifactUploadConflictError("The prepared artifact chunk could not be committed.");
    }

    const nextChunkIndex = receipt.chunk_index + 1;
    const nextOffsetBytes = receipt.offset_bytes + receipt.chunk_bytes;
    const uploadUpdate = database
      .prepare(`
        UPDATE artifact_uploads
        SET next_chunk_index = ?, received_bytes = ?, updated_at = ?
        WHERE id = ?
          AND status = 'receiving'
          AND next_chunk_index = ?
          AND received_bytes = ?
      `)
      .run(
        nextChunkIndex,
        nextOffsetBytes,
        now,
        upload.id,
        receipt.chunk_index,
        receipt.offset_bytes,
      );
    if (Number(uploadUpdate.changes) !== 1) {
      throw new ArtifactUploadConflictError("The artifact upload cursor could not be advanced.");
    }

    return {
      uploadId: upload.id,
      prepareId: receipt.prepare_id,
      state: "receiving",
      chunkIndex: receipt.chunk_index,
      outcome: "accepted",
      nextChunkIndex,
      nextOffsetBytes,
    };
  });

export const prepareArtifactFinalize = (
  database: DatabaseSync,
  input: PrepareArtifactFinalizeInput,
): PrepareArtifactFinalizeResult =>
  withImmediateTransaction(database, () => {
    validateFinalizeInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);

    if (upload.status === "finalizing" || upload.status === "committed") {
      requireMatchingFinalization(upload, input);
      return prepareFinalizeResult(upload, true);
    }
    if (
      upload.status !== "receiving" ||
      upload.next_chunk_index !== input.chunkCount ||
      upload.received_bytes !== input.totalBytes ||
      upload.expected_total_bytes !== input.totalBytes ||
      upload.expected_sha256 !== input.sha256
    ) {
      throw new ArtifactUploadConflictError(
        "The artifact finalization does not match the completed upload cursor.",
      );
    }

    const receiptSummary = database
      .prepare(`
        SELECT
          COUNT(*) AS receipt_count,
          COALESCE(SUM(chunk_bytes), 0) AS receipt_bytes,
          COALESCE(SUM(CASE WHEN status = 'committed' THEN 0 ELSE 1 END), 0)
            AS uncommitted_count
        FROM artifact_upload_chunks
        WHERE upload_id = ?
      `)
      .get(upload.id) as unknown as {
      readonly receipt_count: number;
      readonly receipt_bytes: number;
      readonly uncommitted_count: number;
    };
    if (
      receiptSummary.receipt_count !== input.chunkCount ||
      receiptSummary.receipt_bytes !== input.totalBytes ||
      receiptSummary.uncommitted_count !== 0
    ) {
      throw new ArtifactUploadConflictError(
        "The artifact finalization lacks a complete set of committed chunk receipts.",
      );
    }

    const finalizationId = randomUUID();
    const update = database
      .prepare(`
        UPDATE artifact_uploads
        SET
          status = 'finalizing',
          finalization_id = ?,
          final_chunk_count = ?,
          final_total_bytes = ?,
          final_sha256 = ?,
          finalizing_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'receiving'
      `)
      .run(finalizationId, input.chunkCount, input.totalBytes, input.sha256, now, now, upload.id);
    if (Number(update.changes) !== 1) {
      throw new ArtifactUploadConflictError("The artifact upload could not enter finalization.");
    }
    return prepareFinalizeResult(requireUpload(database, upload.id), false);
  });

export const commitArtifactFinalize = (
  database: DatabaseSync,
  input: CommitArtifactFinalizeInput,
): CommitArtifactFinalizeResult =>
  // The caller may commit only after the verified object is atomically published and durable.
  withImmediateTransaction(database, () => {
    validateFinalizeInput(input);
    requireUuid(input.finalizationId, "finalizationId");
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);
    requireMatchingFinalization(upload, input);
    const expectedObjectKey = storageObjectKey(input.sha256);
    if (input.storageObjectKey !== expectedObjectKey) {
      throw new ArtifactUploadConflictError(
        "The published artifact object key does not match the prepared finalization.",
      );
    }

    if (upload.status === "committed") {
      return { state: "committed", replayed: true, artifact: requireRunArtifact(database, upload) };
    }
    if (upload.status !== "finalizing") {
      throw new ArtifactUploadConflictError("The artifact upload is not ready to commit.");
    }

    database
      .prepare(`
        INSERT INTO run_artifacts (
          id,
          upload_id,
          job_id,
          run_attempt_id,
          client_artifact_id,
          purpose,
          name,
          media_type,
          total_bytes,
          sha256,
          storage_object_key,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.finalizationId,
        upload.id,
        upload.job_id,
        upload.run_attempt_id,
        upload.client_artifact_id,
        upload.purpose,
        upload.name,
        upload.media_type,
        input.totalBytes,
        input.sha256,
        input.storageObjectKey,
        now,
      );
    const update = database
      .prepare(`
        UPDATE artifact_uploads
        SET status = 'committed', committed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'finalizing' AND finalization_id = ?
      `)
      .run(now, now, upload.id, input.finalizationId);
    if (Number(update.changes) !== 1) {
      throw new ArtifactUploadConflictError(
        "The finalized artifact upload could not be committed.",
      );
    }
    return { state: "committed", replayed: false, artifact: requireRunArtifact(database, upload) };
  });

export const terminateArtifactUpload = (
  database: DatabaseSync,
  input: TerminateArtifactUploadInput,
): TerminateArtifactUploadResult =>
  withImmediateTransaction(database, () => {
    validateTerminationInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);

    if (upload.status === "abandoned" || upload.status === "corrupt") {
      if (
        upload.status !== input.state ||
        upload.termination_reason !== input.reason ||
        upload.terminated_at === null
      ) {
        throw new ArtifactUploadConflictError(
          "The artifact upload already has a different terminal disposition.",
        );
      }
      return {
        uploadId: upload.id,
        state: upload.status,
        reason: upload.termination_reason,
        terminatedAt: upload.terminated_at,
        replayed: true,
      };
    }
    if (upload.status === "committed") {
      throw new ArtifactUploadConflictError("A committed artifact upload cannot be terminated.");
    }

    const update = database
      .prepare(`
        UPDATE artifact_uploads
        SET
          status = ?,
          terminated_at = ?,
          termination_reason = ?,
          updated_at = ?
        WHERE id = ?
          AND status IN ('receiving', 'finalizing')
          AND NOT EXISTS (
            SELECT 1 FROM run_artifacts AS artifact
            WHERE artifact.upload_id = artifact_uploads.id
          )
      `)
      .run(input.state, now, input.reason, now, upload.id);
    if (Number(update.changes) !== 1) {
      throw new ArtifactUploadConflictError(
        "The artifact upload could not be terminated from its current state.",
      );
    }
    return {
      uploadId: upload.id,
      state: input.state,
      reason: input.reason,
      terminatedAt: now,
      replayed: false,
    };
  });

/** Closes artifact authority without presenting or manufacturing a Worker lease token. */
export const terminalizeInactiveArtifactUploads = (
  database: DatabaseSync,
  input: TerminalizeInactiveArtifactUploadsInput,
): TerminalizeInactiveArtifactUploadsResult => {
  const batchSize = snapshotReconciliationBatchSize(input);
  return withArtifactReconciliationTransaction(database, () => {
    const now = new Date().toISOString();
    const rows = database
      .prepare(`
        SELECT
          upload.id,
          upload.run_attempt_id AS upload_run_attempt_id,
          upload.worker_node_id AS upload_worker_node_id,
          upload.worker_instance_id AS upload_worker_instance_id,
          upload.lease_generation AS upload_lease_generation,
          attempt.worker_node_id AS attempt_worker_node_id,
          attempt.worker_instance_id AS attempt_worker_instance_id,
          attempt.lease_generation AS attempt_lease_generation,
          attempt.status AS attempt_status,
          attempt.completion_mode,
          attempt.lease_expires_at,
          attempt.execution_deadline_at,
          attempt.no_progress_deadline_at,
          job.status AS job_status,
          job.current_run_attempt_id,
          worker.superseded_at AS worker_superseded_at
        FROM artifact_uploads AS upload INDEXED BY ix_artifact_uploads_reconciliation_v1
        JOIN run_attempts AS attempt
          ON attempt.id = upload.run_attempt_id AND attempt.job_id = upload.job_id
        JOIN jobs AS job ON job.id = upload.job_id
        JOIN workers AS worker ON worker.id = attempt.worker_id
        WHERE upload.status IN ('receiving', 'finalizing')
          AND (
            upload.worker_node_id <> attempt.worker_node_id
            OR upload.worker_instance_id <> attempt.worker_instance_id
            OR upload.lease_generation <> attempt.lease_generation
            OR attempt.status NOT IN ('leased', 'running')
            OR attempt.completion_mode <> 'result_artifact_v1'
            OR job.status NOT IN ('leased', 'running')
            OR job.current_run_attempt_id IS NULL
            OR job.current_run_attempt_id <> upload.run_attempt_id
            OR attempt.lease_expires_at <= ?
            OR attempt.execution_deadline_at <= ?
            OR attempt.no_progress_deadline_at <= ?
            OR worker.superseded_at IS NOT NULL
          )
        ORDER BY upload.updated_at, upload.id
        LIMIT ?
      `)
      .all(now, now, now, batchSize + 1) as unknown as readonly InactiveArtifactUploadRow[];
    const selected = rows.slice(0, batchSize);
    const terminalized = selected.map((row): TerminalizedInactiveArtifactUpload => {
      const disposition = classifyInactiveArtifactUpload(row, now);
      const update = database
        .prepare(`
          UPDATE artifact_uploads
          SET
            status = ?,
            terminated_at = ?,
            termination_reason = ?,
            updated_at = ?
          WHERE id = ? AND status IN ('receiving', 'finalizing')
        `)
        .run(disposition.state, now, disposition.reason, now, row.id);
      if (Number(update.changes) !== 1) {
        throw new ArtifactReconciliationConflictError();
      }
      return Object.freeze({
        uploadId: row.id,
        state: disposition.state,
        reason: disposition.reason,
        terminatedAt: now,
      });
    });
    return Object.freeze({
      terminalized: Object.freeze(terminalized),
      hasMore: rows.length > batchSize,
    });
  });
};

export const listDueArtifactCleanups = (
  database: DatabaseSync,
  input: ListDueArtifactCleanupsInput,
): ListDueArtifactCleanupsResult => {
  const batchSize = snapshotReconciliationBatchSize(input);
  return withArtifactReconciliationTransaction(database, () => {
    const now = new Date().toISOString();
    const rows = database
      .prepare(artifactDueCleanupPageSql)
      .all(now, batchSize + 1) as unknown as readonly ArtifactCleanupWorkRow[];
    return Object.freeze({
      items: Object.freeze(
        rows.slice(0, batchSize).map((row) => snapshotCleanupWorkItem(row, now)),
      ),
      hasMore: rows.length > batchSize,
    });
  });
};

export const completeArtifactCleanup = (
  database: DatabaseSync,
  input: CompleteArtifactCleanupInput,
): CompleteArtifactCleanupResult => {
  const snapshot = snapshotExactInput(input, ["uploadId", "expectedAttemptCount"]);
  const uploadId = requireReconciliationUploadId(snapshot.uploadId);
  const expectedAttemptCount = snapshotExpectedCleanupAttempt(snapshot.expectedAttemptCount);
  return withArtifactReconciliationTransaction(database, () => {
    const existing = requireArtifactCleanupJournal(database, uploadId);
    if (
      existing.status === "completed" &&
      existing.attempt_count === expectedAttemptCount &&
      existing.completed_at !== null
    ) {
      return Object.freeze({
        uploadId,
        status: "completed" as const,
        attemptCount: expectedAttemptCount,
        completedAt: requireCanonicalDateTime(existing.completed_at),
        replayed: true,
      });
    }
    if (
      existing.status !== expectedCleanupStatus(expectedAttemptCount) ||
      existing.attempt_count !== expectedAttemptCount
    ) {
      throw new ArtifactReconciliationConflictError();
    }
    const now = new Date().toISOString();
    const update = database
      .prepare(`
        UPDATE artifact_upload_cleanup_journal
        SET
          status = 'completed',
          next_attempt_at = NULL,
          updated_at = ?,
          completed_at = ?
        WHERE upload_id = ? AND status = ? AND attempt_count = ?
      `)
      .run(now, now, uploadId, expectedCleanupStatus(expectedAttemptCount), expectedAttemptCount);
    if (Number(update.changes) !== 1) {
      throw new ArtifactReconciliationConflictError();
    }
    return Object.freeze({
      uploadId,
      status: "completed" as const,
      attemptCount: expectedAttemptCount,
      completedAt: now,
      replayed: false,
    });
  });
};

export const recordArtifactCleanupFailure = (
  database: DatabaseSync,
  input: RecordArtifactCleanupFailureInput,
): RecordArtifactCleanupFailureResult => {
  const snapshot = snapshotExactInput(input, [
    "uploadId",
    "expectedAttemptCount",
    "errorCode",
    "retryDelaySeconds",
  ]);
  const uploadId = requireReconciliationUploadId(snapshot.uploadId);
  const expectedAttemptCount = snapshotExpectedCleanupAttempt(snapshot.expectedAttemptCount);
  const errorCode = snapshot.errorCode;
  if (typeof errorCode !== "string" || !Object.hasOwn(cleanupRetryMessages, errorCode)) {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  const retryDelaySeconds = snapshot.retryDelaySeconds;
  if (
    !Number.isSafeInteger(retryDelaySeconds) ||
    (retryDelaySeconds as number) < 1 ||
    (retryDelaySeconds as number) > maximumArtifactCleanupRetryDelaySeconds
  ) {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  const canonicalRetryDelaySeconds = retryDelaySeconds as number;
  const canonicalErrorCode = errorCode as ArtifactCleanupRetryErrorCode;
  return withArtifactReconciliationTransaction(database, () => {
    const existing = requireArtifactCleanupJournal(database, uploadId);
    const nextAttemptCount = expectedAttemptCount + 1;
    const nextStatus = nextAttemptCount === 8 ? "failed" : "retry_waiting";
    if (
      existing.attempt_count === nextAttemptCount &&
      existing.status === nextStatus &&
      existing.last_error_code === canonicalErrorCode &&
      existing.last_error_message === cleanupRetryMessages[canonicalErrorCode] &&
      existing.last_retry_delay_seconds === canonicalRetryDelaySeconds
    ) {
      return Object.freeze({
        uploadId,
        status: nextStatus,
        attemptCount: nextAttemptCount,
        nextAttemptAt:
          nextStatus === "failed" ? null : requireCanonicalDateTime(existing.next_attempt_at),
        errorCode: canonicalErrorCode,
        retryDelaySeconds: canonicalRetryDelaySeconds,
        replayed: true,
      });
    }
    if (
      existing.status !== expectedCleanupStatus(expectedAttemptCount) ||
      existing.attempt_count !== expectedAttemptCount
    ) {
      throw new ArtifactReconciliationConflictError();
    }
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const nextAttemptAt =
      nextStatus === "failed"
        ? null
        : new Date(nowDate.getTime() + canonicalRetryDelaySeconds * 1_000).toISOString();
    const update = database
      .prepare(`
        UPDATE artifact_upload_cleanup_journal
        SET
          status = ?,
          attempt_count = ?,
          next_attempt_at = ?,
          last_error_code = ?,
          last_error_message = ?,
          last_retry_delay_seconds = ?,
          updated_at = ?,
          completed_at = NULL
        WHERE upload_id = ? AND status = ? AND attempt_count = ?
      `)
      .run(
        nextStatus,
        nextAttemptCount,
        nextAttemptAt,
        canonicalErrorCode,
        cleanupRetryMessages[canonicalErrorCode],
        canonicalRetryDelaySeconds,
        now,
        uploadId,
        expectedCleanupStatus(expectedAttemptCount),
        expectedAttemptCount,
      );
    if (Number(update.changes) !== 1) {
      throw new ArtifactReconciliationConflictError();
    }
    return Object.freeze({
      uploadId,
      status: nextStatus,
      attemptCount: nextAttemptCount,
      nextAttemptAt,
      errorCode: canonicalErrorCode,
      retryDelaySeconds: canonicalRetryDelaySeconds,
      replayed: false,
    });
  });
};

const artifactNamespaceHealthStatuses = [
  "pending",
  "retry_waiting",
  "completed",
  "failed",
  "superseded",
] as const;

function readBoundedArtifactNamespaceHealth(
  database: DatabaseSync,
  now: string,
): {
  readonly pending: number;
  readonly retry_waiting: number;
  readonly due: number;
  readonly completed: number;
  readonly failed: number;
  readonly superseded: number;
  readonly oldest_outstanding_at: string | null;
  readonly operational_saturated: boolean;
  readonly historical_saturated: boolean;
} {
  const counts = new Map<(typeof artifactNamespaceHealthStatuses)[number], number>();
  let operationalSaturated = false;
  let historicalSaturated = false;
  for (const status of artifactNamespaceHealthStatuses) {
    const rows = database
      .prepare(artifactNamespaceHealthStatusPageSql)
      .all(status, maximumArtifactNamespaceHealthRows + 1);
    if (rows.length > maximumArtifactNamespaceHealthRows) {
      if (status === "completed" || status === "superseded") {
        historicalSaturated = true;
      } else {
        operationalSaturated = true;
      }
    }
    counts.set(status, Math.min(rows.length, maximumArtifactNamespaceHealthRows));
  }
  const dueRows = database
    .prepare(artifactNamespaceHealthDuePageSql)
    .all(now, maximumArtifactNamespaceHealthRows + 1);
  if (dueRows.length > maximumArtifactNamespaceHealthRows) {
    operationalSaturated = true;
  }
  const oldest = database.prepare(artifactNamespaceHealthOldestOutstandingSql).get() as unknown as
    | { readonly created_at: string }
    | undefined;
  return {
    pending: counts.get("pending") ?? 0,
    retry_waiting: counts.get("retry_waiting") ?? 0,
    due: Math.min(dueRows.length, maximumArtifactNamespaceHealthRows),
    completed: counts.get("completed") ?? 0,
    failed: counts.get("failed") ?? 0,
    superseded: counts.get("superseded") ?? 0,
    oldest_outstanding_at: oldest?.created_at ?? null,
    operational_saturated: operationalSaturated,
    historical_saturated: historicalSaturated,
  };
}

export const readArtifactHealthAccounting = (
  database: DatabaseSync,
  input: Record<string, never>,
): ArtifactHealthAccounting => {
  snapshotEmptyReconciliationInput(input);
  return withArtifactReconciliationTransaction(database, () => {
    const now = new Date().toISOString();
    const active = database
      .prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'receiving' THEN 1 ELSE 0 END), 0) AS receiving,
          COALESCE(SUM(CASE WHEN status = 'finalizing' THEN 1 ELSE 0 END), 0) AS finalizing
        FROM artifact_uploads
      `)
      .get() as unknown as { readonly receiving: number; readonly finalizing: number };
    const cleanup = database
      .prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN status = 'retry_waiting' THEN 1 ELSE 0 END), 0)
            AS retry_waiting,
          COALESCE(SUM(CASE
            WHEN status = 'pending'
              OR (status = 'retry_waiting' AND next_attempt_at <= ?)
            THEN 1 ELSE 0 END), 0) AS due,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE
            WHEN (status = 'pending' AND last_retry_delay_seconds IS NOT NULL)
              OR (status IN ('retry_waiting', 'failed')
                AND last_retry_delay_seconds IS NULL)
              OR (status = 'completed'
                AND (
                  (attempt_count = 0 AND last_retry_delay_seconds IS NOT NULL)
                  OR (attempt_count > 0 AND last_retry_delay_seconds IS NULL)
                ))
            THEN 1 ELSE 0 END), 0) AS invalid_retry_identity,
          MIN(CASE
            WHEN status IN ('pending', 'retry_waiting', 'failed') THEN created_at
            ELSE NULL
          END) AS oldest_outstanding_at
        FROM artifact_upload_cleanup_journal
      `)
      .get(now) as unknown as {
      readonly pending: number;
      readonly retry_waiting: number;
      readonly due: number;
      readonly completed: number;
      readonly failed: number;
      readonly invalid_retry_identity: number;
      readonly oldest_outstanding_at: string | null;
    };
    const namespaceCleanup = readBoundedArtifactNamespaceHealth(database, now);
    const capacity = readArtifactUploadCreateAccounting(database);
    const boundedCapacity = namespaceCleanup.operational_saturated
      ? Object.freeze({ ...capacity, accountingCertain: false })
      : capacity;
    return Object.freeze({
      activeUploads: Object.freeze({
        receiving: requireReconciliationCount(active.receiving),
        finalizing: requireReconciliationCount(active.finalizing),
      }),
      cleanup: Object.freeze({
        pending: requireReconciliationCount(cleanup.pending),
        retryWaiting: requireReconciliationCount(cleanup.retry_waiting),
        due: requireReconciliationCount(cleanup.due),
        completed: requireReconciliationCount(cleanup.completed),
        failed: requireReconciliationCount(cleanup.failed),
        invalidRetryIdentity: requireReconciliationCount(cleanup.invalid_retry_identity),
        oldestOutstandingAt:
          cleanup.oldest_outstanding_at === null
            ? null
            : requireCanonicalDateTime(cleanup.oldest_outstanding_at),
      }),
      namespaceCleanup: Object.freeze({
        pending: requireReconciliationCount(namespaceCleanup.pending),
        retryWaiting: requireReconciliationCount(namespaceCleanup.retry_waiting),
        due: requireReconciliationCount(namespaceCleanup.due),
        completed: requireReconciliationCount(namespaceCleanup.completed),
        failed: requireReconciliationCount(namespaceCleanup.failed),
        superseded: requireReconciliationCount(namespaceCleanup.superseded),
        oldestOutstandingAt:
          namespaceCleanup.oldest_outstanding_at === null
            ? null
            : requireCanonicalDateTime(namespaceCleanup.oldest_outstanding_at),
        operationalSaturated: namespaceCleanup.operational_saturated,
        historicalSaturated: namespaceCleanup.historical_saturated,
      }),
      capacity: boundedCapacity,
    });
  });
};

export const readArtifactReconciliationCursor = (
  database: DatabaseSync,
  input: Record<string, never>,
): ArtifactReconciliationCursor => {
  snapshotEmptyReconciliationInput(input);
  return withArtifactReconciliationTransaction(database, () => readReconciliationCursor(database));
};

export const classifyArtifactNamespacePageAndAdvanceCursor = (
  database: DatabaseSync,
  input: ClassifyArtifactNamespacePageInput,
): ClassifyArtifactNamespacePageResult => {
  const snapshot = snapshotClassifyArtifactNamespacePageInput(input);
  const { expectedSweepGeneration, expectedAfterKey, observations, completedSweep } = snapshot;

  return withArtifactReconciliationTransaction(database, () => {
    const cursor = readReconciliationCursor(database);
    if (
      cursor.sweepGeneration !== expectedSweepGeneration ||
      cursor.afterKey !== expectedAfterKey
    ) {
      throw new ArtifactReconciliationConflictError();
    }
    const now = new Date().toISOString();
    const classifications = observations.map((observation) =>
      classifyAndJournalArtifactNamespaceObservation(
        database,
        observation,
        expectedSweepGeneration,
        now,
      ),
    );
    const nextAfterKey = completedSweep ? null : (observations.at(-1)?.entryKey ?? null);
    if (!completedSweep && nextAfterKey === null) {
      throw new ArtifactReconciliationInvalidRequestError();
    }
    const nextGeneration = completedSweep ? expectedSweepGeneration + 1 : expectedSweepGeneration;
    const update = database
      .prepare(`
        UPDATE artifact_namespace_reconciliation_cursors
        SET
          sweep_generation = ?,
          after_key = ?,
          updated_at = ?,
          last_completed_at = CASE WHEN ? THEN ? ELSE last_completed_at END
        WHERE name = ? AND sweep_generation = ? AND after_key IS ?
      `)
      .run(
        nextGeneration,
        nextAfterKey,
        now,
        completedSweep ? 1 : 0,
        now,
        artifactReconciliationCursorName,
        expectedSweepGeneration,
        expectedAfterKey,
      );
    if (Number(update.changes) !== 1) {
      throw new ArtifactReconciliationConflictError();
    }
    return Object.freeze({
      classifications: Object.freeze(classifications),
      cursor: readReconciliationCursor(database),
    });
  });
};

export const listDueArtifactNamespaceCleanups = (
  database: DatabaseSync,
  input: ListDueArtifactNamespaceCleanupsInput,
): ListDueArtifactNamespaceCleanupsResult => {
  const batchSize = snapshotReconciliationBatchSize(input);
  return withArtifactReconciliationTransaction(database, () => {
    const now = new Date().toISOString();
    const rows = database
      .prepare(`
        SELECT *
        FROM artifact_namespace_cleanup_journal
          INDEXED BY ix_artifact_namespace_cleanup_due
        WHERE status IN ('pending', 'retry_waiting')
          AND (
            status = 'pending'
            OR (status = 'retry_waiting' AND next_attempt_at <= ?)
          )
        ORDER BY COALESCE(next_attempt_at, created_at), entry_key, observation_sha256
        LIMIT ?
      `)
      .all(now, batchSize + 1) as unknown as readonly ArtifactNamespaceCleanupRow[];
    return Object.freeze({
      items: Object.freeze(
        rows.slice(0, batchSize).map((row) => snapshotArtifactNamespaceCleanupWorkItem(row, now)),
      ),
      hasMore: rows.length > batchSize,
    });
  });
};

export const completeArtifactNamespaceCleanup = (
  database: DatabaseSync,
  input: CompleteArtifactNamespaceCleanupInput,
): CompleteArtifactNamespaceCleanupResult => {
  const identity = snapshotArtifactNamespaceCleanupMutationIdentity(input);
  return withArtifactReconciliationTransaction(database, () => {
    const existing = requireArtifactNamespaceCleanupRow(
      database,
      identity.entryKey,
      identity.observationSha256,
    );
    if (
      existing.status === "completed" &&
      existing.attempt_count === identity.expectedAttemptCount &&
      existing.completed_at !== null
    ) {
      return Object.freeze({
        entryKey: identity.entryKey,
        observationSha256: identity.observationSha256,
        status: "completed" as const,
        attemptCount: identity.expectedAttemptCount,
        completedAt: requireCanonicalDateTime(existing.completed_at),
        replayed: true,
      });
    }
    if (
      existing.status !== expectedCleanupStatus(identity.expectedAttemptCount) ||
      existing.attempt_count !== identity.expectedAttemptCount
    ) {
      throw new ArtifactReconciliationConflictError();
    }
    const now = new Date().toISOString();
    const update = database
      .prepare(`
        UPDATE artifact_namespace_cleanup_journal
        SET status = 'completed', next_attempt_at = NULL,
            updated_at = ?, completed_at = ?, superseded_at = NULL
        WHERE entry_key = ? AND observation_sha256 = ?
          AND status = ? AND attempt_count = ?
      `)
      .run(
        now,
        now,
        identity.entryKey,
        identity.observationSha256,
        expectedCleanupStatus(identity.expectedAttemptCount),
        identity.expectedAttemptCount,
      );
    if (Number(update.changes) !== 1) {
      throw new ArtifactReconciliationConflictError();
    }
    return Object.freeze({
      entryKey: identity.entryKey,
      observationSha256: identity.observationSha256,
      status: "completed" as const,
      attemptCount: identity.expectedAttemptCount,
      completedAt: now,
      replayed: false,
    });
  });
};

export const recordArtifactNamespaceCleanupFailure = (
  database: DatabaseSync,
  input: RecordArtifactNamespaceCleanupFailureInput,
): RecordArtifactNamespaceCleanupFailureResult => {
  const snapshot = snapshotExactInput(input, [
    "entryKey",
    "observationSha256",
    "expectedAttemptCount",
    "errorCode",
    "retryDelaySeconds",
  ]);
  const identity = snapshotArtifactNamespaceCleanupMutationIdentity({
    entryKey: snapshot.entryKey,
    observationSha256: snapshot.observationSha256,
    expectedAttemptCount: snapshot.expectedAttemptCount,
  });
  const errorCode = snapshot.errorCode;
  const retryDelaySeconds = snapshot.retryDelaySeconds;
  if (
    typeof errorCode !== "string" ||
    !Object.hasOwn(namespaceCleanupRetryMessages, errorCode) ||
    !Number.isSafeInteger(retryDelaySeconds) ||
    (retryDelaySeconds as number) < 1 ||
    (retryDelaySeconds as number) > maximumArtifactCleanupRetryDelaySeconds
  ) {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  const canonicalErrorCode = errorCode as ArtifactCleanupRetryErrorCode;
  const canonicalRetryDelaySeconds = retryDelaySeconds as number;
  return withArtifactReconciliationTransaction(database, () => {
    const existing = requireArtifactNamespaceCleanupRow(
      database,
      identity.entryKey,
      identity.observationSha256,
    );
    const nextAttemptCount = identity.expectedAttemptCount + 1;
    const nextStatus = nextAttemptCount === 8 ? "failed" : "retry_waiting";
    if (
      existing.status === nextStatus &&
      existing.attempt_count === nextAttemptCount &&
      existing.last_error_code === canonicalErrorCode &&
      existing.last_error_message === namespaceCleanupRetryMessages[canonicalErrorCode] &&
      existing.last_retry_delay_seconds === canonicalRetryDelaySeconds
    ) {
      return namespaceCleanupFailureResult(
        existing,
        canonicalErrorCode,
        canonicalRetryDelaySeconds,
        true,
      );
    }
    if (
      existing.status !== expectedCleanupStatus(identity.expectedAttemptCount) ||
      existing.attempt_count !== identity.expectedAttemptCount
    ) {
      throw new ArtifactReconciliationConflictError();
    }
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const nextAttemptAt =
      nextStatus === "failed"
        ? null
        : new Date(nowDate.getTime() + canonicalRetryDelaySeconds * 1_000).toISOString();
    const update = database
      .prepare(`
        UPDATE artifact_namespace_cleanup_journal
        SET status = ?, attempt_count = ?, next_attempt_at = ?,
            last_error_code = ?, last_error_message = ?, last_retry_delay_seconds = ?,
            updated_at = ?, completed_at = NULL, superseded_at = NULL
        WHERE entry_key = ? AND observation_sha256 = ?
          AND status = ? AND attempt_count = ?
      `)
      .run(
        nextStatus,
        nextAttemptCount,
        nextAttemptAt,
        canonicalErrorCode,
        namespaceCleanupRetryMessages[canonicalErrorCode],
        canonicalRetryDelaySeconds,
        now,
        identity.entryKey,
        identity.observationSha256,
        expectedCleanupStatus(identity.expectedAttemptCount),
        identity.expectedAttemptCount,
      );
    if (Number(update.changes) !== 1) {
      throw new ArtifactReconciliationConflictError();
    }
    return Object.freeze({
      entryKey: identity.entryKey,
      observationSha256: identity.observationSha256,
      status: nextStatus,
      attemptCount: nextAttemptCount,
      nextAttemptAt,
      errorCode: canonicalErrorCode,
      retryDelaySeconds: canonicalRetryDelaySeconds,
      replayed: false,
    });
  });
};

type ArtifactNamespaceReferenceDisposition =
  | { readonly disposition: "active_reference" | "upload_cleanup_covered" }
  | { readonly reason: ArtifactNamespaceCleanupReason };

function classifyAndJournalArtifactNamespaceObservation(
  database: DatabaseSync,
  observation: ArtifactNamespaceObservation,
  sweepGeneration: number,
  now: string,
): ArtifactNamespaceClassification {
  const reference = classifyArtifactNamespaceReference(database, observation);
  const unresolved = readUnresolvedArtifactNamespaceCleanup(database, observation.entryKey);
  if ("disposition" in reference) {
    if (unresolved !== undefined) {
      throw new ArtifactReconciliationStateError();
    }
    return Object.freeze({
      entryKey: observation.entryKey,
      observationSha256: observation.observationSha256,
      disposition: reference.disposition,
      reason: null,
      supersededPriorIntent: false,
    });
  }

  if (unresolved?.observation_sha256 === observation.observationSha256) {
    if (
      !artifactNamespaceObservationMatchesRow(observation, unresolved) ||
      unresolved.reason !== reference.reason
    ) {
      throw new ArtifactReconciliationStateError();
    }
    return Object.freeze({
      entryKey: observation.entryKey,
      observationSha256: observation.observationSha256,
      disposition: "cleanup_intent_replayed" as const,
      reason: reference.reason,
      supersededPriorIntent: false,
    });
  }

  const supersededPriorIntent =
    unresolved === undefined ? false : supersedeArtifactNamespaceCleanup(database, unresolved, now);
  const existingIdentity = readArtifactNamespaceCleanup(
    database,
    observation.entryKey,
    observation.observationSha256,
  );
  if (existingIdentity !== undefined) {
    throw new ArtifactReconciliationStateError();
  }
  const insert = database
    .prepare(`
      INSERT INTO artifact_namespace_cleanup_journal (
        entry_key,
        observation_sha256,
        kind,
        linked_object_sha256,
        observed_bytes,
        expected_link_count,
        file_device,
        file_inode,
        file_ctime_ns,
        file_mode,
        file_uid,
        parent_device,
        parent_inode,
        parent_mode,
        parent_uid,
        linked_object_device,
        linked_object_inode,
        linked_object_ctime_ns,
        reason,
        status,
        attempt_count,
        observed_sweep_generation,
        created_at,
        updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, 'pending', 0, ?, ?, ?
      )
    `)
    .run(
      observation.entryKey,
      observation.observationSha256,
      observation.kind,
      observation.linkedObjectSha256,
      observation.observedBytes,
      observation.expectedLinkCount,
      observation.fileDevice,
      observation.fileInode,
      observation.fileCtimeNs,
      observation.fileMode,
      observation.fileUid,
      observation.parentDevice,
      observation.parentInode,
      observation.parentMode,
      observation.parentUid,
      observation.linkedObjectDevice,
      observation.linkedObjectInode,
      observation.linkedObjectCtimeNs,
      reference.reason,
      sweepGeneration,
      now,
      now,
    );
  if (Number(insert.changes) !== 1) {
    throw new ArtifactReconciliationConflictError();
  }
  return Object.freeze({
    entryKey: observation.entryKey,
    observationSha256: observation.observationSha256,
    disposition: "cleanup_intent_created" as const,
    reason: reference.reason,
    supersededPriorIntent,
  });
}

function classifyArtifactNamespaceReference(
  database: DatabaseSync,
  observation: ArtifactNamespaceObservation,
): ArtifactNamespaceReferenceDisposition {
  const upload = database
    .prepare(`
      SELECT id, status, expected_total_bytes, received_bytes,
             finalization_id, final_total_bytes, final_sha256
      FROM artifact_uploads
      WHERE id = ?
    `)
    .get(observation.uploadId) as unknown as ArtifactNamespaceUploadRow | undefined;
  if (upload === undefined) {
    return { reason: "orphan" };
  }
  if (upload.id !== observation.uploadId) {
    throw new ArtifactReconciliationStateError();
  }

  const terminal =
    upload.status === "committed" || upload.status === "abandoned" || upload.status === "corrupt";
  if (terminal) {
    if (
      observation.kind === "publication-temporary" &&
      !artifactNamespaceTemporaryIdentityMatchesUpload(observation, upload)
    ) {
      return { reason: "stale_identity_mismatch" };
    }
    let cleanup: ArtifactCleanupJournalRow;
    try {
      cleanup = requireArtifactCleanupJournal(database, upload.id);
    } catch {
      throw new ArtifactReconciliationStateError();
    }
    if (
      cleanup.status === "pending" ||
      cleanup.status === "retry_waiting" ||
      cleanup.status === "failed"
    ) {
      return { disposition: "upload_cleanup_covered" };
    }
    if (cleanup.status === "completed") {
      return { reason: "completed_residual" };
    }
    throw new ArtifactReconciliationStateError();
  }

  if (observation.kind === "staging") {
    if (
      (upload.status === "receiving" &&
        Number.isSafeInteger(upload.received_bytes) &&
        Number.isSafeInteger(upload.expected_total_bytes) &&
        observation.observedBytes >= upload.received_bytes &&
        observation.observedBytes <= upload.expected_total_bytes) ||
      (upload.status === "finalizing" &&
        Number.isSafeInteger(upload.final_total_bytes) &&
        observation.observedBytes === upload.final_total_bytes)
    ) {
      return { disposition: "active_reference" };
    }
    throw new ArtifactReconciliationStateError();
  }

  if (
    upload.status === "finalizing" &&
    artifactNamespaceTemporaryIdentityMatchesUpload(observation, upload) &&
    Number.isSafeInteger(upload.final_total_bytes) &&
    ((observation.expectedLinkCount === 1 &&
      observation.observedBytes <= (upload.final_total_bytes as number)) ||
      (observation.expectedLinkCount === 2 &&
        observation.observedBytes === upload.final_total_bytes &&
        observation.linkedObjectSha256 === upload.final_sha256))
  ) {
    return { disposition: "active_reference" };
  }
  throw new ArtifactReconciliationStateError();
}

function artifactNamespaceTemporaryIdentityMatchesUpload(
  observation: ArtifactNamespaceObservation,
  upload: ArtifactNamespaceUploadRow,
): boolean {
  const parsed = parseArtifactNamespaceEntryKey(observation.entryKey, "publication-temporary");
  return (
    upload.finalization_id !== null &&
    upload.final_sha256 !== null &&
    observation.finalizationId === upload.finalization_id &&
    parsed.shard === upload.final_sha256.slice(0, 2)
  );
}

function readUnresolvedArtifactNamespaceCleanup(
  database: DatabaseSync,
  entryKey: string,
): ArtifactNamespaceCleanupRow | undefined {
  const row = database
    .prepare(`
      SELECT * FROM artifact_namespace_cleanup_journal
      WHERE entry_key = ? AND status IN ('pending', 'retry_waiting', 'failed')
    `)
    .get(entryKey) as unknown as ArtifactNamespaceCleanupRow | undefined;
  return row === undefined ? undefined : validateArtifactNamespaceCleanupRow(row);
}

function supersedeArtifactNamespaceCleanup(
  database: DatabaseSync,
  row: ArtifactNamespaceCleanupRow,
  now: string,
): true {
  const update = database
    .prepare(`
      UPDATE artifact_namespace_cleanup_journal
      SET status = 'superseded', next_attempt_at = NULL,
          updated_at = ?, completed_at = NULL, superseded_at = ?
      WHERE entry_key = ? AND observation_sha256 = ?
        AND status IN ('pending', 'retry_waiting', 'failed')
    `)
    .run(now, now, row.entry_key, row.observation_sha256);
  if (Number(update.changes) !== 1) {
    throw new ArtifactReconciliationConflictError();
  }
  return true;
}

function readArtifactNamespaceCleanup(
  database: DatabaseSync,
  entryKey: string,
  observationSha256: string,
): ArtifactNamespaceCleanupRow | undefined {
  const row = database
    .prepare(`
      SELECT * FROM artifact_namespace_cleanup_journal
      WHERE entry_key = ? AND observation_sha256 = ?
    `)
    .get(entryKey, observationSha256) as unknown as ArtifactNamespaceCleanupRow | undefined;
  return row === undefined ? undefined : validateArtifactNamespaceCleanupRow(row);
}

function requireArtifactNamespaceCleanupRow(
  database: DatabaseSync,
  entryKey: string,
  observationSha256: string,
): ArtifactNamespaceCleanupRow {
  const row = readArtifactNamespaceCleanup(database, entryKey, observationSha256);
  if (row === undefined) {
    throw new ArtifactReconciliationConflictError();
  }
  return row;
}

function validateArtifactNamespaceCleanupRow(
  row: ArtifactNamespaceCleanupRow,
): ArtifactNamespaceCleanupRow {
  let parsed: ParsedArtifactNamespaceEntryKey;
  try {
    parsed = parseArtifactNamespaceEntryKey(row.entry_key);
  } catch {
    throw new ArtifactReconciliationStateError();
  }
  const knownReason =
    row.reason === "orphan" ||
    row.reason === "completed_residual" ||
    row.reason === "stale_identity_mismatch";
  const knownError =
    typeof row.last_error_code === "string" &&
    Object.hasOwn(namespaceCleanupRetryMessages, row.last_error_code) &&
    row.last_error_message ===
      namespaceCleanupRetryMessages[row.last_error_code as ArtifactCleanupRetryErrorCode] &&
    Number.isSafeInteger(row.last_retry_delay_seconds) &&
    (row.last_retry_delay_seconds as number) >= 1 &&
    (row.last_retry_delay_seconds as number) <= maximumArtifactCleanupRetryDelaySeconds;
  const noError =
    row.last_error_code === null &&
    row.last_error_message === null &&
    row.last_retry_delay_seconds === null;
  const validState =
    (row.status === "pending" &&
      row.attempt_count === 0 &&
      row.next_attempt_at === null &&
      noError &&
      row.completed_at === null &&
      row.superseded_at === null) ||
    (row.status === "retry_waiting" &&
      row.attempt_count >= 1 &&
      row.attempt_count <= 7 &&
      row.next_attempt_at !== null &&
      knownError &&
      row.completed_at === null &&
      row.superseded_at === null) ||
    (row.status === "completed" &&
      row.attempt_count >= 0 &&
      row.attempt_count <= 7 &&
      row.next_attempt_at === null &&
      (row.attempt_count === 0 ? noError : knownError) &&
      row.completed_at !== null &&
      row.superseded_at === null) ||
    (row.status === "failed" &&
      row.attempt_count === 8 &&
      row.next_attempt_at === null &&
      knownError &&
      row.completed_at === null &&
      row.superseded_at === null) ||
    (row.status === "superseded" &&
      row.attempt_count >= 0 &&
      row.attempt_count <= 8 &&
      row.next_attempt_at === null &&
      (row.attempt_count === 0 ? noError : knownError) &&
      row.completed_at === null &&
      row.superseded_at !== null);
  if (
    !sha256Pattern.test(row.observation_sha256) ||
    row.kind !== parsed.kind ||
    !knownReason ||
    !Number.isSafeInteger(row.observed_bytes) ||
    row.observed_bytes < 0 ||
    row.observed_bytes > maximumResultArtifactBytes ||
    (row.expected_link_count !== 1 && row.expected_link_count !== 2) ||
    !Number.isSafeInteger(row.observed_sweep_generation) ||
    row.observed_sweep_generation < 0 ||
    !Number.isSafeInteger(row.attempt_count) ||
    !validState
  ) {
    throw new ArtifactReconciliationStateError();
  }
  const identity: ArtifactNamespaceObservationIdentity = {
    entryKey: row.entry_key,
    kind: parsed.kind,
    uploadId: parsed.uploadId,
    finalizationId: parsed.finalizationId,
    linkedObjectSha256: row.linked_object_sha256,
    observedBytes: row.observed_bytes,
    expectedLinkCount: row.expected_link_count as 1 | 2,
    fileDevice: row.file_device,
    fileInode: row.file_inode,
    fileCtimeNs: row.file_ctime_ns,
    fileMode: row.file_mode,
    fileUid: row.file_uid,
    parentDevice: row.parent_device,
    parentInode: row.parent_inode,
    parentMode: row.parent_mode,
    parentUid: row.parent_uid,
    linkedObjectDevice: row.linked_object_device,
    linkedObjectInode: row.linked_object_inode,
    linkedObjectCtimeNs: row.linked_object_ctime_ns,
  };
  try {
    if (
      !securelyMatchesSha256(
        row.observation_sha256,
        calculateArtifactNamespaceObservationSha256(identity),
      )
    ) {
      throw new ArtifactReconciliationStateError();
    }
  } catch (error) {
    if (error instanceof ArtifactReconciliationStateError) {
      throw error;
    }
    throw new ArtifactReconciliationStateError();
  }
  requireCanonicalDateTime(row.created_at);
  requireCanonicalDateTime(row.updated_at);
  if (row.next_attempt_at !== null) {
    requireCanonicalDateTime(row.next_attempt_at);
  }
  if (row.completed_at !== null) {
    requireCanonicalDateTime(row.completed_at);
  }
  if (row.superseded_at !== null) {
    requireCanonicalDateTime(row.superseded_at);
  }
  return row;
}

function artifactNamespaceObservationMatchesRow(
  observation: ArtifactNamespaceObservation,
  row: ArtifactNamespaceCleanupRow,
): boolean {
  return (
    row.entry_key === observation.entryKey &&
    row.observation_sha256 === observation.observationSha256 &&
    row.kind === observation.kind &&
    row.linked_object_sha256 === observation.linkedObjectSha256 &&
    row.observed_bytes === observation.observedBytes &&
    row.expected_link_count === observation.expectedLinkCount &&
    row.file_device === observation.fileDevice &&
    row.file_inode === observation.fileInode &&
    row.file_ctime_ns === observation.fileCtimeNs &&
    row.file_mode === observation.fileMode &&
    row.file_uid === observation.fileUid &&
    row.parent_device === observation.parentDevice &&
    row.parent_inode === observation.parentInode &&
    row.parent_mode === observation.parentMode &&
    row.parent_uid === observation.parentUid &&
    row.linked_object_device === observation.linkedObjectDevice &&
    row.linked_object_inode === observation.linkedObjectInode &&
    row.linked_object_ctime_ns === observation.linkedObjectCtimeNs
  );
}

function snapshotArtifactNamespaceCleanupMutationIdentity(
  value: unknown,
): CompleteArtifactNamespaceCleanupInput {
  const snapshot = snapshotExactInput(value, [
    "entryKey",
    "observationSha256",
    "expectedAttemptCount",
  ]);
  let entryKey: string;
  try {
    entryKey = parseArtifactNamespaceEntryKey(snapshot.entryKey).entryKey;
  } catch {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  if (
    typeof snapshot.observationSha256 !== "string" ||
    !sha256Pattern.test(snapshot.observationSha256)
  ) {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  return Object.freeze({
    entryKey,
    observationSha256: snapshot.observationSha256,
    expectedAttemptCount: snapshotExpectedCleanupAttempt(snapshot.expectedAttemptCount),
  });
}

function snapshotArtifactNamespaceCleanupWorkItem(
  row: ArtifactNamespaceCleanupRow,
  now: string,
): ArtifactNamespaceCleanupWorkItem {
  validateArtifactNamespaceCleanupRow(row);
  if (
    (row.status !== "pending" && row.status !== "retry_waiting") ||
    (row.status === "retry_waiting" &&
      (row.next_attempt_at === null || requireCanonicalDateTime(row.next_attempt_at) > now))
  ) {
    throw new ArtifactReconciliationStateError();
  }
  const parsed = parseArtifactNamespaceEntryKey(row.entry_key);
  return Object.freeze({
    entryKey: row.entry_key,
    observationSha256: row.observation_sha256,
    kind: parsed.kind,
    uploadId: parsed.uploadId,
    finalizationId: parsed.finalizationId,
    linkedObjectSha256: row.linked_object_sha256,
    observedBytes: row.observed_bytes,
    expectedLinkCount: row.expected_link_count as 1 | 2,
    fileDevice: row.file_device,
    fileInode: row.file_inode,
    fileCtimeNs: row.file_ctime_ns,
    fileMode: row.file_mode,
    fileUid: row.file_uid,
    parentDevice: row.parent_device,
    parentInode: row.parent_inode,
    parentMode: row.parent_mode,
    parentUid: row.parent_uid,
    linkedObjectDevice: row.linked_object_device,
    linkedObjectInode: row.linked_object_inode,
    linkedObjectCtimeNs: row.linked_object_ctime_ns,
    reason: row.reason as ArtifactNamespaceCleanupReason,
    observedSweepGeneration: row.observed_sweep_generation,
    expectedAttemptCount: row.attempt_count,
    lastRetryDelaySeconds: row.last_retry_delay_seconds,
  });
}

function namespaceCleanupFailureResult(
  row: ArtifactNamespaceCleanupRow,
  errorCode: ArtifactCleanupRetryErrorCode,
  retryDelaySeconds: number,
  replayed: boolean,
): RecordArtifactNamespaceCleanupFailureResult {
  return Object.freeze({
    entryKey: row.entry_key,
    observationSha256: row.observation_sha256,
    status: row.status as "retry_waiting" | "failed",
    attemptCount: row.attempt_count,
    nextAttemptAt:
      row.next_attempt_at === null ? null : requireCanonicalDateTime(row.next_attempt_at),
    errorCode,
    retryDelaySeconds,
    replayed,
  });
}

function classifyInactiveArtifactUpload(
  row: InactiveArtifactUploadRow,
  now: string,
): {
  readonly state: "abandoned" | "corrupt";
  readonly reason: ArtifactUploadAuthorityClosureReason;
} {
  requireReconciliationStateUploadId(row.id);
  if (
    row.upload_worker_node_id !== row.attempt_worker_node_id ||
    row.upload_worker_instance_id !== row.attempt_worker_instance_id ||
    row.upload_lease_generation !== row.attempt_lease_generation
  ) {
    return { state: "corrupt", reason: "metadata_fence_mismatch" };
  }
  if (row.attempt_status !== "leased" && row.attempt_status !== "running") {
    return { state: "abandoned", reason: "attempt_inactive" };
  }
  if (row.job_status !== "leased" && row.job_status !== "running") {
    return { state: "abandoned", reason: "job_inactive" };
  }
  if (row.current_run_attempt_id !== row.upload_run_attempt_id) {
    return { state: "abandoned", reason: "attempt_not_current" };
  }
  if (row.completion_mode !== "result_artifact_v1") {
    return { state: "abandoned", reason: "completion_mode_inactive" };
  }
  if (requireCanonicalDateTime(row.lease_expires_at) <= now) {
    return { state: "abandoned", reason: "lease_expired" };
  }
  if (requireCanonicalDateTime(row.execution_deadline_at) <= now) {
    return { state: "abandoned", reason: "execution_deadline_expired" };
  }
  if (requireCanonicalDateTime(row.no_progress_deadline_at) <= now) {
    return { state: "abandoned", reason: "no_progress_deadline_expired" };
  }
  if (row.worker_superseded_at !== null) {
    requireCanonicalDateTime(row.worker_superseded_at);
    return { state: "abandoned", reason: "worker_superseded" };
  }
  throw new ArtifactReconciliationStateError();
}

function snapshotCleanupWorkItem(
  row: ArtifactCleanupWorkRow,
  now: string,
): ArtifactCleanupWorkItem {
  const uploadId = requireReconciliationStateUploadId(row.upload_id);
  if (
    (row.journal_terminal_status !== "committed" &&
      row.journal_terminal_status !== "abandoned" &&
      row.journal_terminal_status !== "corrupt") ||
    row.upload_status !== row.journal_terminal_status ||
    row.cleanup_scope !== "staging_only_v1" ||
    (row.cleanup_status !== "pending" && row.cleanup_status !== "retry_waiting") ||
    !Number.isSafeInteger(row.attempt_count) ||
    (row.cleanup_status === "pending" &&
      (row.attempt_count !== 0 ||
        row.next_attempt_at !== null ||
        row.last_error_code !== null ||
        row.last_error_message !== null ||
        row.last_retry_delay_seconds !== null)) ||
    (row.cleanup_status === "retry_waiting" &&
      (row.attempt_count < 1 ||
        row.attempt_count > 7 ||
        row.next_attempt_at === null ||
        requireCanonicalDateTime(row.next_attempt_at) > now ||
        typeof row.last_error_code !== "string" ||
        !Object.hasOwn(cleanupRetryMessages, row.last_error_code) ||
        row.last_error_message !==
          cleanupRetryMessages[row.last_error_code as ArtifactCleanupRetryErrorCode] ||
        !Number.isSafeInteger(row.last_retry_delay_seconds) ||
        (row.last_retry_delay_seconds as number) < 1 ||
        (row.last_retry_delay_seconds as number) > maximumArtifactCleanupRetryDelaySeconds))
  ) {
    throw new ArtifactReconciliationStateError();
  }
  const hasFinalization = row.finalization_id !== null;
  if (
    hasFinalization !== (row.final_total_bytes !== null) ||
    hasFinalization !== (row.final_sha256 !== null) ||
    (row.journal_terminal_status === "committed" && !hasFinalization)
  ) {
    throw new ArtifactReconciliationStateError();
  }
  const publications = hasFinalization
    ? [
        Object.freeze({
          finalizationId: requireReconciliationUuid(row.finalization_id),
          totalBytes: requireReconciliationArtifactBytes(row.final_total_bytes),
          sha256: requireReconciliationSha256(row.final_sha256),
        }),
      ]
    : [];
  return Object.freeze({
    uploadId,
    terminalStatus: row.journal_terminal_status,
    cleanupScope: "staging_only_v1",
    expectedAttemptCount: row.attempt_count,
    lastRetryDelaySeconds: row.last_retry_delay_seconds,
    publications: Object.freeze(publications),
  });
}

function requireArtifactCleanupJournal(
  database: DatabaseSync,
  uploadId: string,
): ArtifactCleanupJournalRow {
  const row = database
    .prepare(`
      SELECT
        upload_id,
        status,
        attempt_count,
        next_attempt_at,
        last_error_code,
        last_error_message,
        last_retry_delay_seconds,
        completed_at
      FROM artifact_upload_cleanup_journal
      WHERE upload_id = ?
    `)
    .get(uploadId) as unknown as ArtifactCleanupJournalRow | undefined;
  if (row === undefined) {
    throw new ArtifactReconciliationConflictError();
  }
  requireReconciliationStateUploadId(row.upload_id);
  if (!Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 || row.attempt_count > 8) {
    throw new ArtifactReconciliationStateError();
  }
  const hasKnownError =
    typeof row.last_error_code === "string" &&
    Object.hasOwn(cleanupRetryMessages, row.last_error_code) &&
    row.last_error_message ===
      cleanupRetryMessages[row.last_error_code as ArtifactCleanupRetryErrorCode];
  const hasKnownRetryDelay =
    Number.isSafeInteger(row.last_retry_delay_seconds) &&
    (row.last_retry_delay_seconds as number) >= 1 &&
    (row.last_retry_delay_seconds as number) <= maximumArtifactCleanupRetryDelaySeconds;
  const valid =
    (row.status === "pending" &&
      row.attempt_count === 0 &&
      row.next_attempt_at === null &&
      row.last_error_code === null &&
      row.last_error_message === null &&
      row.last_retry_delay_seconds === null &&
      row.completed_at === null) ||
    (row.status === "retry_waiting" &&
      row.attempt_count >= 1 &&
      row.attempt_count <= 7 &&
      row.next_attempt_at !== null &&
      hasKnownError &&
      hasKnownRetryDelay &&
      row.completed_at === null) ||
    (row.status === "completed" &&
      row.attempt_count <= 7 &&
      row.next_attempt_at === null &&
      row.completed_at !== null &&
      ((row.attempt_count === 0 &&
        row.last_error_code === null &&
        row.last_error_message === null &&
        row.last_retry_delay_seconds === null) ||
        (row.attempt_count >= 1 && hasKnownError && hasKnownRetryDelay))) ||
    (row.status === "failed" &&
      row.attempt_count === 8 &&
      row.next_attempt_at === null &&
      hasKnownError &&
      hasKnownRetryDelay &&
      row.completed_at === null);
  if (!valid) {
    throw new ArtifactReconciliationStateError();
  }
  if (row.next_attempt_at !== null) {
    requireCanonicalDateTime(row.next_attempt_at);
  }
  if (row.completed_at !== null) {
    requireCanonicalDateTime(row.completed_at);
  }
  return row;
}

function readReconciliationCursor(database: DatabaseSync): ArtifactReconciliationCursor {
  const row = database
    .prepare(`
      SELECT name, sweep_generation, after_key, updated_at, last_completed_at
      FROM artifact_namespace_reconciliation_cursors
      WHERE name = ?
    `)
    .get(artifactReconciliationCursorName) as unknown as
    | ArtifactReconciliationCursorRow
    | undefined;
  if (
    row === undefined ||
    row.name !== artifactReconciliationCursorName ||
    !Number.isSafeInteger(row.sweep_generation) ||
    row.sweep_generation < 0
  ) {
    throw new ArtifactReconciliationStateError();
  }
  const afterKey =
    row.after_key === null
      ? null
      : (() => {
          try {
            return requireReconciliationCursorKey(row.after_key);
          } catch {
            throw new ArtifactReconciliationStateError();
          }
        })();
  return Object.freeze({
    name: artifactReconciliationCursorName,
    sweepGeneration: row.sweep_generation,
    afterKey,
    updatedAt: requireCanonicalDateTime(row.updated_at),
    lastCompletedAt:
      row.last_completed_at === null ? null : requireCanonicalDateTime(row.last_completed_at),
  });
}

function requireReconciliationUploadId(value: unknown): string {
  if (typeof value !== "string" || !entityIdPattern.test(value)) {
    throw new ArtifactReconciliationInvalidRequestError();
  }
  return value;
}

function requireReconciliationStateUploadId(value: unknown): string {
  if (typeof value !== "string" || !entityIdPattern.test(value)) {
    throw new ArtifactReconciliationStateError();
  }
  return value;
}

function requireReconciliationUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) {
    throw new ArtifactReconciliationStateError();
  }
  return value;
}

function requireReconciliationSha256(value: unknown): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new ArtifactReconciliationStateError();
  }
  return value;
}

function requireReconciliationArtifactBytes(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximumResultArtifactBytes
  ) {
    throw new ArtifactReconciliationStateError();
  }
  return value as number;
}

function requireActiveLease(
  database: DatabaseSync,
  input: ArtifactLeaseIdentity,
  now: string,
): ActiveLeaseRow {
  validateLeaseIdentity(input);
  const row = database
    .prepare(`
      SELECT
        attempt.job_id,
        attempt.worker_node_id,
        attempt.worker_instance_id,
        attempt.status AS attempt_status,
        attempt.completion_mode,
        attempt.lease_token_hash,
        attempt.lease_generation,
        attempt.lease_expires_at,
        attempt.execution_deadline_at,
        attempt.no_progress_deadline_at,
        job.status AS job_status,
        job.current_run_attempt_id,
        worker.superseded_at AS worker_superseded_at
      FROM run_attempts AS attempt
      JOIN jobs AS job ON job.id = attempt.job_id
      JOIN workers AS worker ON worker.id = attempt.worker_id
      WHERE attempt.id = ?
    `)
    .get(input.runAttemptId) as unknown as ActiveLeaseRow | undefined;
  const tokenHash = sha256(input.leaseToken);
  if (
    row === undefined ||
    row.job_id !== input.jobId ||
    row.worker_node_id !== input.workerNodeId ||
    row.worker_instance_id !== input.workerInstanceId ||
    row.lease_generation !== input.leaseGeneration ||
    !securelyMatchesSha256(row.lease_token_hash, tokenHash) ||
    !["leased", "running"].includes(row.attempt_status) ||
    !["leased", "running"].includes(row.job_status) ||
    row.current_run_attempt_id !== input.runAttemptId ||
    row.lease_expires_at <= now ||
    row.execution_deadline_at <= now ||
    row.no_progress_deadline_at <= now ||
    row.worker_superseded_at !== null
  ) {
    throw new LeaseLostError();
  }
  if (row.completion_mode !== "result_artifact_v1") {
    throw new ArtifactCompletionModeMismatchError();
  }
  return row;
}

function findUploadByClientId(
  database: DatabaseSync,
  runAttemptId: string,
  clientArtifactId: string,
): ArtifactUploadRow | undefined {
  return database
    .prepare(`
      SELECT
        id,
        job_id,
        run_attempt_id,
        worker_node_id,
        worker_instance_id,
        lease_generation,
        client_artifact_id,
        purpose,
        name,
        media_type,
        expected_total_bytes,
        expected_sha256,
        status,
        next_chunk_index,
        received_bytes,
        finalization_id,
        final_chunk_count,
        final_total_bytes,
        final_sha256,
        terminated_at,
        termination_reason
      FROM artifact_uploads
      WHERE run_attempt_id = ? AND client_artifact_id = ?
    `)
    .get(runAttemptId, clientArtifactId) as unknown as ArtifactUploadRow | undefined;
}

function requireUpload(database: DatabaseSync, uploadId: string): ArtifactUploadRow {
  requireEntityId(uploadId, "uploadId");
  const row = database
    .prepare(`
      SELECT
        id,
        job_id,
        run_attempt_id,
        worker_node_id,
        worker_instance_id,
        lease_generation,
        client_artifact_id,
        purpose,
        name,
        media_type,
        expected_total_bytes,
        expected_sha256,
        status,
        next_chunk_index,
        received_bytes,
        finalization_id,
        final_chunk_count,
        final_total_bytes,
        final_sha256,
        terminated_at,
        termination_reason
      FROM artifact_uploads
      WHERE id = ?
    `)
    .get(uploadId) as unknown as ArtifactUploadRow | undefined;
  if (row === undefined) {
    throw new ArtifactUploadConflictError("The artifact upload does not exist.");
  }
  return row;
}

function findChunk(
  database: DatabaseSync,
  uploadId: string,
  chunkIndex: number,
): ArtifactChunkRow | undefined {
  return database
    .prepare(`
      SELECT
        upload_id,
        chunk_index,
        prepare_id,
        offset_bytes,
        chunk_bytes,
        chunk_sha256,
        status
      FROM artifact_upload_chunks
      WHERE upload_id = ? AND chunk_index = ?
    `)
    .get(uploadId, chunkIndex) as unknown as ArtifactChunkRow | undefined;
}

function readCommittedArtifactPrefix(
  database: DatabaseSync,
  upload: ArtifactUploadRow,
): readonly ArtifactCommittedChunkReceipt[] {
  const rows = database
    .prepare(`
      SELECT chunk_index, offset_bytes, chunk_bytes, chunk_sha256
      FROM artifact_upload_chunks
      WHERE upload_id = ? AND status = 'committed'
      ORDER BY chunk_index
      LIMIT 9
    `)
    .all(upload.id) as unknown as readonly CommittedArtifactChunkRow[];
  if (rows.length !== upload.next_chunk_index) {
    throw new ArtifactUploadConflictError(
      "The committed artifact prefix count does not match the durable upload cursor.",
    );
  }

  let expectedOffset = 0;
  const committedPrefix = rows.map((row, expectedIndex): ArtifactCommittedChunkReceipt => {
    if (
      row.chunk_index !== expectedIndex ||
      row.offset_bytes !== expectedOffset ||
      !Number.isSafeInteger(row.chunk_bytes) ||
      row.chunk_bytes < 1 ||
      row.chunk_bytes > maximumResultArtifactChunkBytes ||
      !sha256Pattern.test(row.chunk_sha256)
    ) {
      throw new ArtifactUploadConflictError(
        "The committed artifact prefix is not contiguous immutable receipt state.",
      );
    }
    const nextOffset = expectedOffset + row.chunk_bytes;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > upload.expected_total_bytes) {
      throw new ArtifactUploadConflictError(
        "The committed artifact prefix exceeds the declared artifact size.",
      );
    }
    const receipt = Object.freeze({
      chunkIndex: row.chunk_index,
      offsetBytes: row.offset_bytes,
      chunkBytes: row.chunk_bytes,
      chunkSha256: row.chunk_sha256,
    });
    expectedOffset = nextOffset;
    return receipt;
  });
  if (expectedOffset !== upload.received_bytes) {
    throw new ArtifactUploadConflictError(
      "The committed artifact prefix bytes do not match the durable upload cursor.",
    );
  }
  return Object.freeze(committedPrefix);
}

function requireCommittedReplayReceipt(
  committedPrefix: readonly ArtifactCommittedChunkReceipt[],
  receipt: ArtifactChunkRow,
): void {
  const committed = committedPrefix[receipt.chunk_index];
  if (
    committed === undefined ||
    committed.chunkIndex !== receipt.chunk_index ||
    committed.offsetBytes !== receipt.offset_bytes ||
    committed.chunkBytes !== receipt.chunk_bytes ||
    committed.chunkSha256 !== receipt.chunk_sha256
  ) {
    throw new ArtifactUploadConflictError(
      "The replayed artifact chunk is not present in the committed upload prefix.",
    );
  }
}

function requireRunArtifact(
  database: DatabaseSync,
  upload: ArtifactUploadRow,
): CommittedRunArtifact & { readonly storageObjectKey: string } {
  const row = database
    .prepare(`
      SELECT
        id,
        upload_id,
        job_id,
        run_attempt_id,
        client_artifact_id,
        purpose,
        name,
        media_type,
        total_bytes,
        sha256,
        storage_object_key
      FROM run_artifacts
      WHERE upload_id = ?
    `)
    .get(upload.id) as unknown as RunArtifactRow | undefined;
  if (row === undefined) {
    throw new ArtifactUploadConflictError(
      "The committed artifact upload has no immutable artifact record.",
    );
  }
  return {
    artifactId: row.id,
    uploadId: row.upload_id,
    clientArtifactId: row.client_artifact_id,
    jobId: row.job_id,
    runAttemptId: row.run_attempt_id,
    purpose: row.purpose,
    name: row.name,
    mediaType: row.media_type,
    totalBytes: row.total_bytes,
    sha256: row.sha256,
    storageObjectKey: row.storage_object_key,
  };
}

function createNewUploadResult(upload: ArtifactUploadRow): CreateArtifactUploadResult {
  if (
    upload.status !== "receiving" ||
    upload.next_chunk_index !== 0 ||
    upload.received_bytes !== 0
  ) {
    throw new ArtifactUploadConflictError(
      "A newly created artifact upload has invalid initial state.",
    );
  }
  return {
    uploadId: upload.id,
    state: "receiving",
    replayed: false,
    nextChunkIndex: 0,
    nextOffsetBytes: 0,
    maximumChunkBytes: maximumResultArtifactChunkBytes,
    maximumChunkCount: maximumResultArtifactChunks,
  };
}

function createUploadReplayResult(upload: ArtifactUploadRow): CreateArtifactUploadResult {
  const replay = {
    uploadId: upload.id,
    replayed: true,
    nextChunkIndex: upload.next_chunk_index,
    nextOffsetBytes: upload.received_bytes,
    maximumChunkBytes: maximumResultArtifactChunkBytes,
    maximumChunkCount: maximumResultArtifactChunks,
  } satisfies Pick<
    Extract<CreateArtifactUploadResult, { replayed: true }>,
    | "uploadId"
    | "replayed"
    | "nextChunkIndex"
    | "nextOffsetBytes"
    | "maximumChunkBytes"
    | "maximumChunkCount"
  >;
  if (upload.status === "abandoned" || upload.status === "corrupt") {
    if (upload.termination_reason === null || upload.terminated_at === null) {
      throw new ArtifactUploadConflictError(
        "The terminal artifact upload has incomplete termination state.",
      );
    }
    return {
      ...replay,
      state: upload.status,
      reason: upload.termination_reason,
      terminatedAt: upload.terminated_at,
    };
  }
  return { ...replay, state: upload.status };
}

function prepareChunkResult(
  upload: ArtifactUploadRow,
  receipt: ArtifactChunkRow,
  committedPrefix: readonly ArtifactCommittedChunkReceipt[],
  replayed: boolean,
): PrepareArtifactChunkResult {
  return {
    uploadId: upload.id,
    prepareId: receipt.prepare_id,
    receiptState: receipt.status,
    replayed,
    chunkIndex: receipt.chunk_index,
    offsetBytes: receipt.offset_bytes,
    chunkBytes: receipt.chunk_bytes,
    chunkSha256: receipt.chunk_sha256,
    committedNextChunkIndex: upload.next_chunk_index,
    committedOffsetBytes: upload.received_bytes,
    committedPrefix: Object.freeze(
      committedPrefix.map((committed) =>
        Object.freeze({
          chunkIndex: committed.chunkIndex,
          offsetBytes: committed.offsetBytes,
          chunkBytes: committed.chunkBytes,
          chunkSha256: committed.chunkSha256,
        }),
      ),
    ),
    preparedNextChunkIndex: receipt.chunk_index + 1,
    preparedNextOffsetBytes: receipt.offset_bytes + receipt.chunk_bytes,
  };
}

function commitChunkReplayResult(
  upload: ArtifactUploadRow,
  receipt: ArtifactChunkRow,
): CommitArtifactChunkResult {
  if (
    upload.status !== "receiving" &&
    upload.status !== "finalizing" &&
    upload.status !== "committed"
  ) {
    throw new ArtifactUploadConflictError(
      "The committed artifact chunk belongs to a terminated upload.",
    );
  }
  if (
    upload.next_chunk_index < receipt.chunk_index + 1 ||
    upload.received_bytes < receipt.offset_bytes + receipt.chunk_bytes
  ) {
    throw new ArtifactUploadConflictError(
      "The committed artifact chunk is ahead of the durable upload cursor.",
    );
  }
  return {
    uploadId: upload.id,
    prepareId: receipt.prepare_id,
    state: upload.status,
    chunkIndex: receipt.chunk_index,
    outcome: "replayed",
    nextChunkIndex: upload.next_chunk_index,
    nextOffsetBytes: upload.received_bytes,
  };
}

function prepareFinalizeResult(
  upload: ArtifactUploadRow,
  replayed: boolean,
): PrepareArtifactFinalizeResult {
  if (
    upload.finalization_id === null ||
    upload.final_chunk_count === null ||
    upload.final_total_bytes === null ||
    upload.final_sha256 === null ||
    (upload.status !== "finalizing" && upload.status !== "committed")
  ) {
    throw new ArtifactUploadConflictError("The artifact finalization state is incomplete.");
  }
  return {
    uploadId: upload.id,
    finalizationId: upload.finalization_id,
    artifactId: upload.finalization_id,
    storageObjectKey: storageObjectKey(upload.final_sha256),
    state: upload.status,
    replayed,
    chunkCount: upload.final_chunk_count,
    totalBytes: upload.final_total_bytes,
    sha256: upload.final_sha256,
  };
}

function requireUploadBinding(upload: ArtifactUploadRow, input: ArtifactLeaseIdentity): void {
  if (
    upload.job_id !== input.jobId ||
    upload.run_attempt_id !== input.runAttemptId ||
    upload.worker_node_id !== input.workerNodeId ||
    upload.worker_instance_id !== input.workerInstanceId ||
    upload.lease_generation !== input.leaseGeneration
  ) {
    throw new LeaseLostError();
  }
}

function matchesCreateMetadata(
  upload: ArtifactUploadRow,
  input: CreateArtifactUploadInput,
): boolean {
  return (
    upload.purpose === input.purpose &&
    upload.name === input.name &&
    upload.media_type === input.mediaType &&
    upload.expected_total_bytes === input.totalBytes &&
    upload.expected_sha256 === input.sha256
  );
}

function matchesChunkMetadata(receipt: ArtifactChunkRow, input: ArtifactChunkMetadata): boolean {
  return (
    receipt.chunk_index === input.chunkIndex &&
    receipt.offset_bytes === input.offsetBytes &&
    receipt.chunk_bytes === input.chunkBytes &&
    receipt.chunk_sha256 === input.chunkSha256
  );
}

function requireMatchingFinalization(
  upload: ArtifactUploadRow,
  input: ArtifactFinalizeMetadata & { readonly finalizationId?: string },
): void {
  if (
    upload.finalization_id === null ||
    upload.final_chunk_count !== input.chunkCount ||
    upload.final_total_bytes !== input.totalBytes ||
    upload.final_sha256 !== input.sha256 ||
    (input.finalizationId !== undefined && upload.finalization_id !== input.finalizationId)
  ) {
    throw new ArtifactUploadConflictError(
      "The artifact finalization request does not match its prepared identity.",
    );
  }
}

function storageObjectKey(digest: string): string {
  return `sha256/${digest.slice(0, 2)}/${digest}`;
}

function validateCreateInput(input: CreateArtifactUploadInput): void {
  validateLeaseIdentity(input);
  requireUuid(input.clientArtifactId, "clientArtifactId");
  if (input.purpose !== "result") {
    throw new TypeError("Result artifact uploads require purpose=result.");
  }
  if (!artifactNamePattern.test(input.name)) {
    throw new TypeError("Result artifact names must use the canonical artifact-name format.");
  }
  if (input.mediaType !== "application/json") {
    throw new TypeError("Result artifacts must use application/json.");
  }
  requireInteger(input.totalBytes, 1, maximumResultArtifactBytes, "totalBytes");
  requireSha256(input.sha256, "sha256");
}

function validateChunkInput(input: PrepareArtifactChunkInput): void {
  validateLeaseIdentity(input);
  requireEntityId(input.uploadId, "uploadId");
  requireInteger(input.chunkIndex, 0, maximumResultArtifactChunks - 1, "chunkIndex");
  requireInteger(input.offsetBytes, 0, maximumResultArtifactBytes - 1, "offsetBytes");
  requireInteger(input.chunkBytes, 1, maximumResultArtifactChunkBytes, "chunkBytes");
  requireSha256(input.chunkSha256, "chunkSha256");
  if (input.offsetBytes + input.chunkBytes > maximumResultArtifactBytes) {
    throw new RangeError("The artifact chunk exceeds the result artifact byte ceiling.");
  }
}

function validateFinalizeInput(input: PrepareArtifactFinalizeInput): void {
  validateLeaseIdentity(input);
  requireEntityId(input.uploadId, "uploadId");
  requireInteger(input.chunkCount, 1, maximumResultArtifactChunks, "chunkCount");
  requireInteger(input.totalBytes, 1, maximumResultArtifactBytes, "totalBytes");
  requireSha256(input.sha256, "sha256");
}

function validateTerminationInput(input: TerminateArtifactUploadInput): void {
  validateLeaseIdentity(input);
  requireEntityId(input.uploadId, "uploadId");
  if (input.state !== "abandoned" && input.state !== "corrupt") {
    throw new TypeError("Artifact upload termination requires an abandoned or corrupt state.");
  }
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(input.reason)) {
    throw new TypeError("Artifact upload termination requires a canonical reason code.");
  }
}

function validateLeaseIdentity(input: ArtifactLeaseIdentity): void {
  requireEntityId(input.jobId, "jobId");
  requireEntityId(input.runAttemptId, "runAttemptId");
  requireEntityId(input.workerNodeId, "workerNodeId");
  requireEntityId(input.workerInstanceId, "workerInstanceId");
  requireInteger(input.leaseGeneration, 1, Number.MAX_SAFE_INTEGER, "leaseGeneration");
  if (
    typeof input.leaseToken !== "string" ||
    input.leaseToken.length < 32 ||
    input.leaseToken.length > 1024
  ) {
    throw new TypeError("leaseToken must contain between 32 and 1024 characters.");
  }
}

function requireEntityId(value: string, name: string): void {
  if (typeof value !== "string" || !entityIdPattern.test(value)) {
    throw new TypeError(`${name} must be a valid entity identifier.`);
  }
}

function requireUuid(value: string, name: string): void {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) {
    throw new TypeError(`${name} must be a lowercase UUIDv4.`);
  }
}

function requireSha256(value: string, name: string): void {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest.`);
  }
}

function requireInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}
