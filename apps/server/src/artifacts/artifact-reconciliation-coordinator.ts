import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { maximumResultArtifactBytes, maximumResultArtifactChunks } from "@agentic-review/contracts";
import {
  type ArtifactCleanupRetryErrorCode,
  type ArtifactCleanupWorkItem,
  type ArtifactHealthAccounting,
  type ArtifactNamespaceCleanupWorkItem,
  type ArtifactReconciliationDatabaseOperation,
  artifactReconciliationCursorName,
  maximumArtifactCleanupRetryDelaySeconds,
  maximumArtifactReconciliationBatchSize,
} from "../database/artifacts.js";
import type { DatabaseOperationMap } from "../database/protocol.js";
import {
  type ArtifactNamespaceCleanupResult,
  type ArtifactNamespaceObservation,
  type ArtifactNamespaceScanPageInput,
  type ArtifactNamespaceScanPageResult,
  type CloseArtifactNamespaceScanInput,
  type CloseArtifactNamespaceScanResult,
  maximumArtifactNamespacePageSize,
  parseArtifactNamespaceEntryKey,
  snapshotArtifactNamespaceObservation,
  snapshotArtifactNamespaceSweepGeneration,
} from "./artifact-namespace-contract.js";
import {
  maximumArtifactCapacityLiveUploads,
  snapshotArtifactCapacityEvaluationAccounting,
} from "./capacity.js";
import { ArtifactStorageClientError } from "./errors.js";
import {
  requireArtifactByteCount,
  requireArtifactOperationId,
  requireArtifactSha256,
  requireArtifactUploadId,
} from "./names.js";
import type { ArtifactUploadCleanupRequest, ArtifactUploadCleanupResult } from "./types.js";
import {
  assertArtifactStorageResponseMatchesExpectation,
  createArtifactStorageResponseExpectation,
  normalizeArtifactStorageOperationInput,
  normalizeArtifactStorageOperationOutput,
} from "./worker-protocol.js";

const maximumCoordinatorMilliseconds = 600_000;
const artifactReconciliationDatabaseHandleBrand: unique symbol = Symbol(
  "artifact-reconciliation-database-handle",
);
const authorityClosureReasons = new Set([
  "attempt_inactive",
  "job_inactive",
  "attempt_not_current",
  "lease_expired",
  "execution_deadline_expired",
  "no_progress_deadline_expired",
  "worker_superseded",
  "completion_mode_inactive",
  "metadata_fence_mismatch",
]);

type ArtifactCleanupDatabaseOperation =
  | "classifyArtifactNamespacePageAndAdvanceCursor"
  | "completeArtifactCleanup"
  | "completeArtifactNamespaceCleanup"
  | "listDueArtifactCleanups"
  | "listDueArtifactNamespaceCleanups"
  | "readArtifactHealthAccounting"
  | "readArtifactReconciliationCursor"
  | "recordArtifactCleanupFailure"
  | "recordArtifactNamespaceCleanupFailure"
  | "terminalizeInactiveArtifactUploads";

type ArtifactCleanupDatabaseRequest = <TOperation extends ArtifactCleanupDatabaseOperation>(
  operation: TOperation,
  input: DatabaseOperationMap[TOperation]["input"],
) => Promise<DatabaseOperationMap[TOperation]["output"]>;

type ArtifactReconciliationDatabaseRequest = <
  TOperation extends ArtifactReconciliationDatabaseOperation,
>(
  operation: TOperation,
  input: DatabaseOperationMap[TOperation]["input"],
) => Promise<DatabaseOperationMap[TOperation]["output"]>;

type FatalWaiter = (error: ArtifactReconciliationCoordinatorError) => void;

export type ArtifactReconciliationCoordinatorErrorCode =
  | "ARTIFACT_RECONCILIATION_CLOSE_TIMEOUT"
  | "ARTIFACT_RECONCILIATION_DATABASE_FAILURE"
  | "ARTIFACT_RECONCILIATION_HEALTH_SATURATED"
  | "ARTIFACT_RECONCILIATION_NAMESPACE_CLEANUP_FAILED"
  | "ARTIFACT_RECONCILIATION_OWNER_EXIT"
  | "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE"
  | "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN";

const errorMessages: Readonly<Record<ArtifactReconciliationCoordinatorErrorCode, string>> =
  Object.freeze({
    ARTIFACT_RECONCILIATION_CLOSE_TIMEOUT:
      "Artifact reconciliation did not quiesce before its shutdown deadline.",
    ARTIFACT_RECONCILIATION_DATABASE_FAILURE:
      "Artifact reconciliation database state is unavailable or uncertain.",
    ARTIFACT_RECONCILIATION_HEALTH_SATURATED:
      "Artifact namespace cleanup health exceeded its bounded accounting limit.",
    ARTIFACT_RECONCILIATION_NAMESPACE_CLEANUP_FAILED:
      "Artifact namespace cleanup exhausted its durable retry budget.",
    ARTIFACT_RECONCILIATION_OWNER_EXIT:
      "Artifact reconciliation storage owner exited unexpectedly.",
    ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE:
      "Artifact reconciliation received invalid owner data.",
    ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN: "Artifact staging cleanup outcome is unknown.",
  });

export class ArtifactReconciliationCoordinatorError extends Error {
  readonly code: ArtifactReconciliationCoordinatorErrorCode;
  readonly requiresFailStop = true;

  constructor(code: ArtifactReconciliationCoordinatorErrorCode) {
    super(errorMessages[code]);
    this.name = "ArtifactReconciliationCoordinatorError";
    this.code = code;
  }
}

interface ArtifactReconciliationDatabaseOwner {
  readonly request: ArtifactReconciliationDatabaseRequest;
}

export interface ArtifactReconciliationDatabaseHandle {
  readonly [artifactReconciliationDatabaseHandleBrand]: true;
}

export interface ArtifactReconciliationStorageOwner {
  readonly ownerExit: Promise<number>;
  cleanupUpload(input: ArtifactUploadCleanupRequest): Promise<ArtifactUploadCleanupResult>;
  scanNamespacePage(
    input: ArtifactNamespaceScanPageInput,
  ): Promise<ArtifactNamespaceScanPageResult>;
  closeNamespaceScan(
    input: CloseArtifactNamespaceScanInput,
  ): Promise<CloseArtifactNamespaceScanResult>;
  cleanupNamespaceEntry(
    input: ArtifactNamespaceObservation,
  ): Promise<ArtifactNamespaceCleanupResult>;
}

export interface ArtifactReconciliationCoordinatorOptions {
  /** Opaque one-shot handle minted by DatabaseClient. */
  readonly database: ArtifactReconciliationDatabaseHandle;
  readonly storage: ArtifactReconciliationStorageOwner;
  readonly batchSize: number;
  readonly intervalMilliseconds: number;
  readonly passTimeoutMilliseconds: number;
  readonly closeTimeoutMilliseconds: number;
  readonly initialRetryDelaySeconds: number;
  readonly maximumRetryDelaySeconds: number;
  readonly onFailStop: (error: ArtifactReconciliationCoordinatorError) => void | Promise<void>;
}

interface ArtifactReconciliationDatabaseHandleRecord {
  readonly owner: ArtifactReconciliationDatabaseOwner;
}

const databaseHandleRecords = new WeakMap<object, ArtifactReconciliationDatabaseHandleRecord>();

/** @internal Imported only by DatabaseClient and the isolated fake-owner testing adapter. */
export const registerArtifactReconciliationDatabaseHandle = (
  owner: ArtifactReconciliationDatabaseOwner,
): ArtifactReconciliationDatabaseHandle => {
  const request = owner.request;
  if (typeof request !== "function") {
    throw new TypeError("Artifact reconciliation database owner binding is invalid.");
  }
  const handle = Object.freeze(Object.create(null)) as ArtifactReconciliationDatabaseHandle;
  databaseHandleRecords.set(handle, {
    owner: Object.freeze({
      request: (<TOperation extends ArtifactReconciliationDatabaseOperation>(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ): Promise<DatabaseOperationMap[TOperation]["output"]> =>
        Reflect.apply(request, owner, [operation, input]) as Promise<
          DatabaseOperationMap[TOperation]["output"]
        >) as ArtifactReconciliationDatabaseRequest,
    }),
  });
  return handle;
};

const consumeDatabaseHandle = (
  handle: ArtifactReconciliationDatabaseHandle,
): {
  readonly record: ArtifactReconciliationDatabaseHandleRecord;
  readonly restore: () => void;
} => {
  if (typeof handle !== "object" || handle === null) {
    throw new TypeError("Artifact reconciliation database handle is invalid.");
  }
  const record = databaseHandleRecords.get(handle);
  if (record === undefined) {
    throw new TypeError("Artifact reconciliation database handle was already consumed or forged.");
  }
  databaseHandleRecords.delete(handle);
  return {
    record,
    restore: () => {
      if (!databaseHandleRecords.has(handle)) {
        databaseHandleRecords.set(handle, record);
      }
    },
  };
};

interface ArtifactReconciliationPassResult {
  readonly continueImmediately: boolean;
  readonly sweepCompleted: boolean;
  readonly health: ArtifactHealthAccounting;
}

const requirePositiveInteger = (value: unknown, maximum: number, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${name} must be a positive bounded integer.`);
  }
  return value as number;
};

const requireRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value as Record<string, unknown>;
};

const requireExactKeys = (record: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new TypeError("Artifact reconciliation data contains unsupported or missing fields.");
  }
};

const requireDenseArray = (value: unknown, maximum: number, name: string): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${name} must be a bounded array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${name} must not contain holes.`);
    }
  }
  return value;
};

const requireBoolean = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be boolean.`);
  }
  return value;
};

const requireText = (value: unknown, name: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be text.`);
  }
  return value;
};

const requireNonnegativeInteger = (value: unknown, maximum: number, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${name} must be a bounded non-negative integer.`);
  }
  return value as number;
};

const requireCanonicalDateTime = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new TypeError(`${name} must be a canonical timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical timestamp.`);
  }
  return value;
};

const snapshotTerminalizationResult = (
  value: unknown,
  batchSize: number,
): { readonly hasMore: boolean } => {
  const record = requireRecord(value, "Artifact terminalization result");
  requireExactKeys(record, ["terminalized", "hasMore"]);
  const terminalized = requireDenseArray(record.terminalized, batchSize, "Terminalized uploads");
  const identifiers = new Set<string>();
  for (const item of terminalized) {
    const entry = requireRecord(item, "Terminalized artifact upload");
    requireExactKeys(entry, ["uploadId", "state", "reason", "terminatedAt"]);
    const uploadId = requireArtifactUploadId(
      requireText(entry.uploadId, "Terminalized artifact upload ID"),
    );
    if (
      identifiers.has(uploadId) ||
      (entry.state !== "abandoned" && entry.state !== "corrupt") ||
      typeof entry.reason !== "string" ||
      !authorityClosureReasons.has(entry.reason) ||
      (entry.state === "corrupt") !== (entry.reason === "metadata_fence_mismatch")
    ) {
      throw new TypeError("Terminalized artifact upload is invalid.");
    }
    identifiers.add(uploadId);
    requireCanonicalDateTime(entry.terminatedAt, "Artifact termination time");
  }
  const hasMore = requireBoolean(record.hasMore, "Terminalization continuation");
  if (hasMore && terminalized.length !== batchSize) {
    throw new TypeError("Terminalization continuation requires a full bounded page.");
  }
  return Object.freeze({ hasMore });
};

const snapshotCleanupWorkItem = (value: unknown): ArtifactCleanupWorkItem => {
  const record = requireRecord(value, "Artifact cleanup work item");
  requireExactKeys(record, [
    "uploadId",
    "terminalStatus",
    "cleanupScope",
    "expectedAttemptCount",
    "lastRetryDelaySeconds",
    "publications",
  ]);
  const expectedAttemptCount = requireNonnegativeInteger(
    record.expectedAttemptCount,
    7,
    "Artifact cleanup attempt count",
  );
  const lastRetryDelaySeconds =
    record.lastRetryDelaySeconds === null
      ? null
      : requirePositiveInteger(
          record.lastRetryDelaySeconds,
          maximumArtifactCleanupRetryDelaySeconds,
          "Artifact cleanup retry identity",
        );
  if (
    (record.terminalStatus !== "committed" &&
      record.terminalStatus !== "abandoned" &&
      record.terminalStatus !== "corrupt") ||
    record.cleanupScope !== "staging_only_v1" ||
    (expectedAttemptCount === 0) !== (lastRetryDelaySeconds === null)
  ) {
    throw new TypeError("Artifact cleanup work item state is invalid.");
  }
  const publications = requireDenseArray(
    record.publications,
    maximumResultArtifactChunks,
    "Artifact cleanup publications",
  ).map((value) => {
    const publication = requireRecord(value, "Artifact cleanup publication");
    requireExactKeys(publication, ["finalizationId", "totalBytes", "sha256"]);
    return Object.freeze({
      finalizationId: requireArtifactOperationId(
        requireText(publication.finalizationId, "Artifact finalization ID"),
        "Artifact finalization ID",
      ),
      totalBytes: requireArtifactByteCount(
        publication.totalBytes as number,
        "Artifact total bytes",
      ),
      sha256: requireArtifactSha256(requireText(publication.sha256, "Artifact digest")),
    });
  });
  if (
    publications.length > 1 ||
    (record.terminalStatus === "committed" && publications.length !== 1)
  ) {
    throw new TypeError("Artifact cleanup publication state is invalid.");
  }
  return Object.freeze({
    uploadId: requireArtifactUploadId(requireText(record.uploadId, "Artifact upload ID")),
    terminalStatus: record.terminalStatus,
    cleanupScope: "staging_only_v1",
    expectedAttemptCount,
    lastRetryDelaySeconds,
    publications: Object.freeze(publications),
  }) as ArtifactCleanupWorkItem;
};

const snapshotCleanupPage = (
  value: unknown,
  batchSize: number,
): { readonly items: readonly ArtifactCleanupWorkItem[]; readonly hasMore: boolean } => {
  const record = requireRecord(value, "Artifact cleanup page");
  requireExactKeys(record, ["items", "hasMore"]);
  const identifiers = new Set<string>();
  const items = requireDenseArray(record.items, batchSize, "Artifact cleanup work page").map(
    (value) => {
      const item = snapshotCleanupWorkItem(value);
      if (identifiers.has(item.uploadId)) {
        throw new TypeError("Artifact cleanup page contains a duplicate upload.");
      }
      identifiers.add(item.uploadId);
      return item;
    },
  );
  const hasMore = requireBoolean(record.hasMore, "Artifact cleanup page continuation");
  if (hasMore && items.length !== batchSize) {
    throw new TypeError("Artifact cleanup continuation requires a full bounded page.");
  }
  return Object.freeze({ items: Object.freeze(items), hasMore });
};

interface ArtifactNamespaceCursorSnapshot {
  readonly sweepGeneration: number;
  readonly afterKey: string | null;
  readonly updatedAt: string;
  readonly lastCompletedAt: string | null;
}

const snapshotNamespaceCursor = (value: unknown): ArtifactNamespaceCursorSnapshot => {
  const record = requireRecord(value, "Artifact namespace cursor");
  requireExactKeys(record, ["name", "sweepGeneration", "afterKey", "updatedAt", "lastCompletedAt"]);
  if (record.name !== artifactReconciliationCursorName) {
    throw new TypeError("Artifact namespace cursor identity is invalid.");
  }
  const afterKey =
    record.afterKey === null ? null : parseArtifactNamespaceEntryKey(record.afterKey).entryKey;
  return Object.freeze({
    sweepGeneration: snapshotArtifactNamespaceSweepGeneration(record.sweepGeneration),
    afterKey,
    updatedAt: requireCanonicalDateTime(record.updatedAt, "Artifact namespace cursor time"),
    lastCompletedAt:
      record.lastCompletedAt === null
        ? null
        : requireCanonicalDateTime(
            record.lastCompletedAt,
            "Artifact namespace last completed time",
          ),
  });
};

const namespaceObservationKeys = [
  "entryKey",
  "observationSha256",
  "kind",
  "uploadId",
  "finalizationId",
  "linkedObjectSha256",
  "observedBytes",
  "expectedLinkCount",
  "fileDevice",
  "fileInode",
  "fileCtimeNs",
  "fileMode",
  "fileUid",
  "parentDevice",
  "parentInode",
  "parentMode",
  "parentUid",
  "linkedObjectDevice",
  "linkedObjectInode",
  "linkedObjectCtimeNs",
] as const;

const snapshotNamespaceCleanupWorkItem = (value: unknown): ArtifactNamespaceCleanupWorkItem => {
  const record = requireRecord(value, "Artifact namespace cleanup work item");
  requireExactKeys(record, [
    ...namespaceObservationKeys,
    "reason",
    "observedSweepGeneration",
    "expectedAttemptCount",
    "lastRetryDelaySeconds",
  ]);
  const observationData: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of namespaceObservationKeys) {
    observationData[key] = record[key];
  }
  const observation = snapshotArtifactNamespaceObservation(observationData);
  if (
    record.reason !== "orphan" &&
    record.reason !== "completed_residual" &&
    record.reason !== "stale_identity_mismatch"
  ) {
    throw new TypeError("Artifact namespace cleanup reason is unsupported.");
  }
  const expectedAttemptCount = requireNonnegativeInteger(
    record.expectedAttemptCount,
    7,
    "Artifact namespace cleanup attempt count",
  );
  const lastRetryDelaySeconds =
    record.lastRetryDelaySeconds === null
      ? null
      : requirePositiveInteger(
          record.lastRetryDelaySeconds,
          maximumArtifactCleanupRetryDelaySeconds,
          "Artifact namespace cleanup retry identity",
        );
  if ((expectedAttemptCount === 0) !== (lastRetryDelaySeconds === null)) {
    throw new TypeError("Artifact namespace cleanup retry identity is inconsistent.");
  }
  return Object.freeze({
    ...observation,
    reason: record.reason,
    observedSweepGeneration: snapshotArtifactNamespaceSweepGeneration(
      record.observedSweepGeneration,
    ),
    expectedAttemptCount,
    lastRetryDelaySeconds,
  });
};

const snapshotNamespaceCleanupPage = (
  value: unknown,
  batchSize: number,
): { readonly items: readonly ArtifactNamespaceCleanupWorkItem[]; readonly hasMore: boolean } => {
  const record = requireRecord(value, "Artifact namespace cleanup page");
  requireExactKeys(record, ["items", "hasMore"]);
  const identities = new Set<string>();
  const items = requireDenseArray(
    record.items,
    batchSize,
    "Artifact namespace cleanup work page",
  ).map((entry) => {
    const item = snapshotNamespaceCleanupWorkItem(entry);
    const identity = `${item.entryKey}:${item.observationSha256}`;
    if (identities.has(identity)) {
      throw new TypeError("Artifact namespace cleanup page contains duplicate work.");
    }
    identities.add(identity);
    return item;
  });
  const hasMore = requireBoolean(record.hasMore, "Artifact namespace cleanup continuation");
  if (hasMore && items.length !== batchSize) {
    throw new TypeError("Artifact namespace cleanup continuation requires a full page.");
  }
  return Object.freeze({ items: Object.freeze(items), hasMore });
};

const assertNamespaceClassificationResult = (
  value: unknown,
  page: ArtifactNamespaceScanPageResult,
): ArtifactNamespaceCursorSnapshot => {
  const record = requireRecord(value, "Artifact namespace classification result");
  requireExactKeys(record, ["classifications", "cursor"]);
  const classifications = requireDenseArray(
    record.classifications,
    page.observations.length,
    "Artifact namespace classifications",
  );
  if (classifications.length !== page.observations.length) {
    throw new TypeError("Artifact namespace classification count is inconsistent.");
  }
  for (const [index, value] of classifications.entries()) {
    const classification = requireRecord(value, "Artifact namespace classification");
    requireExactKeys(classification, [
      "entryKey",
      "observationSha256",
      "disposition",
      "reason",
      "supersededPriorIntent",
    ]);
    const observation = page.observations[index];
    const disposition = classification.disposition;
    const cleanupReason =
      classification.reason === "orphan" ||
      classification.reason === "completed_residual" ||
      classification.reason === "stale_identity_mismatch";
    const referenceDisposition =
      disposition === "active_reference" || disposition === "upload_cleanup_covered";
    const cleanupDisposition =
      disposition === "cleanup_intent_created" || disposition === "cleanup_intent_replayed";
    if (
      observation === undefined ||
      classification.entryKey !== observation.entryKey ||
      classification.observationSha256 !== observation.observationSha256 ||
      typeof classification.supersededPriorIntent !== "boolean" ||
      (referenceDisposition &&
        (classification.reason !== null || classification.supersededPriorIntent)) ||
      (cleanupDisposition &&
        (!cleanupReason ||
          (disposition === "cleanup_intent_replayed" && classification.supersededPriorIntent))) ||
      (!referenceDisposition && !cleanupDisposition)
    ) {
      throw new TypeError("Artifact namespace classification identity is inconsistent.");
    }
  }
  const cursor = snapshotNamespaceCursor(record.cursor);
  const expectedGeneration = page.completedSweep ? page.sweepGeneration + 1 : page.sweepGeneration;
  if (cursor.sweepGeneration !== expectedGeneration || cursor.afterKey !== page.nextAfterKey) {
    throw new TypeError("Artifact namespace classification cursor is inconsistent.");
  }
  return cursor;
};

const snapshotHealth = (value: unknown): ArtifactHealthAccounting => {
  const record = requireRecord(value, "Artifact health accounting");
  requireExactKeys(record, ["activeUploads", "cleanup", "namespaceCleanup", "capacity"]);
  const active = requireRecord(record.activeUploads, "Active artifact uploads");
  requireExactKeys(active, ["receiving", "finalizing"]);
  const cleanup = requireRecord(record.cleanup, "Artifact cleanup health");
  requireExactKeys(cleanup, [
    "pending",
    "retryWaiting",
    "due",
    "completed",
    "failed",
    "invalidRetryIdentity",
    "oldestOutstandingAt",
  ]);
  const namespaceCleanup = requireRecord(
    record.namespaceCleanup,
    "Artifact namespace cleanup health",
  );
  requireExactKeys(namespaceCleanup, [
    "pending",
    "retryWaiting",
    "due",
    "completed",
    "failed",
    "superseded",
    "oldestOutstandingAt",
    "operationalSaturated",
    "historicalSaturated",
  ]);
  const capacity = requireRecord(record.capacity, "Artifact capacity health");
  requireExactKeys(capacity, [
    "accountingCertain",
    "liveUploadCount",
    "liveUploadExpectedByteSizeBuckets",
    "cleanupBacklogEntries",
  ]);
  const buckets = requireDenseArray(
    capacity.liveUploadExpectedByteSizeBuckets,
    maximumArtifactCapacityLiveUploads,
    "Artifact capacity buckets",
  ).map((value) => {
    const bucket = requireRecord(value, "Artifact capacity bucket");
    requireExactKeys(bucket, ["expectedTotalBytes", "uploadCount"]);
    return Object.freeze({
      expectedTotalBytes: requirePositiveInteger(
        bucket.expectedTotalBytes,
        maximumResultArtifactBytes,
        "Artifact expected bytes",
      ),
      uploadCount: requirePositiveInteger(
        bucket.uploadCount,
        maximumArtifactCapacityLiveUploads,
        "Artifact upload count",
      ),
    });
  });
  const normalizedCapacity = snapshotArtifactCapacityEvaluationAccounting({
    accountingCertain: requireBoolean(capacity.accountingCertain, "Artifact accounting certainty"),
    liveUploadCount: requireNonnegativeInteger(
      capacity.liveUploadCount,
      maximumArtifactCapacityLiveUploads,
      "Live artifact upload count",
    ),
    liveUploadExpectedByteSizeBuckets: buckets,
    cleanupBacklogEntries: requireNonnegativeInteger(
      capacity.cleanupBacklogEntries,
      Number.MAX_SAFE_INTEGER,
      "Artifact cleanup backlog",
    ),
  });
  return Object.freeze({
    activeUploads: Object.freeze({
      receiving: requireNonnegativeInteger(
        active.receiving,
        Number.MAX_SAFE_INTEGER,
        "Receiving artifact count",
      ),
      finalizing: requireNonnegativeInteger(
        active.finalizing,
        Number.MAX_SAFE_INTEGER,
        "Finalizing artifact count",
      ),
    }),
    cleanup: Object.freeze({
      pending: requireNonnegativeInteger(
        cleanup.pending,
        Number.MAX_SAFE_INTEGER,
        "Pending cleanup count",
      ),
      retryWaiting: requireNonnegativeInteger(
        cleanup.retryWaiting,
        Number.MAX_SAFE_INTEGER,
        "Retrying cleanup count",
      ),
      due: requireNonnegativeInteger(cleanup.due, Number.MAX_SAFE_INTEGER, "Due cleanup count"),
      completed: requireNonnegativeInteger(
        cleanup.completed,
        Number.MAX_SAFE_INTEGER,
        "Completed cleanup count",
      ),
      failed: requireNonnegativeInteger(
        cleanup.failed,
        Number.MAX_SAFE_INTEGER,
        "Failed cleanup count",
      ),
      invalidRetryIdentity: requireNonnegativeInteger(
        cleanup.invalidRetryIdentity,
        Number.MAX_SAFE_INTEGER,
        "Invalid cleanup retry identity count",
      ),
      oldestOutstandingAt:
        cleanup.oldestOutstandingAt === null
          ? null
          : requireCanonicalDateTime(cleanup.oldestOutstandingAt, "Oldest artifact cleanup time"),
    }),
    namespaceCleanup: Object.freeze({
      pending: requireNonnegativeInteger(
        namespaceCleanup.pending,
        Number.MAX_SAFE_INTEGER,
        "Pending artifact namespace cleanup count",
      ),
      retryWaiting: requireNonnegativeInteger(
        namespaceCleanup.retryWaiting,
        Number.MAX_SAFE_INTEGER,
        "Retrying artifact namespace cleanup count",
      ),
      due: requireNonnegativeInteger(
        namespaceCleanup.due,
        Number.MAX_SAFE_INTEGER,
        "Due artifact namespace cleanup count",
      ),
      completed: requireNonnegativeInteger(
        namespaceCleanup.completed,
        Number.MAX_SAFE_INTEGER,
        "Completed artifact namespace cleanup count",
      ),
      failed: requireNonnegativeInteger(
        namespaceCleanup.failed,
        Number.MAX_SAFE_INTEGER,
        "Failed artifact namespace cleanup count",
      ),
      superseded: requireNonnegativeInteger(
        namespaceCleanup.superseded,
        Number.MAX_SAFE_INTEGER,
        "Superseded artifact namespace cleanup count",
      ),
      oldestOutstandingAt:
        namespaceCleanup.oldestOutstandingAt === null
          ? null
          : requireCanonicalDateTime(
              namespaceCleanup.oldestOutstandingAt,
              "Oldest artifact namespace cleanup time",
            ),
      operationalSaturated: requireBoolean(
        namespaceCleanup.operationalSaturated,
        "Artifact namespace cleanup operational health saturation",
      ),
      historicalSaturated: requireBoolean(
        namespaceCleanup.historicalSaturated,
        "Artifact namespace cleanup historical health saturation",
      ),
    }),
    capacity: normalizedCapacity,
  });
};

export class ArtifactReconciliationCoordinator {
  readonly #requestDatabase: ArtifactCleanupDatabaseRequest;
  readonly #cleanupUpload: (
    input: ArtifactUploadCleanupRequest,
  ) => Promise<ArtifactUploadCleanupResult>;
  readonly #scanNamespacePage: (
    input: ArtifactNamespaceScanPageInput,
  ) => Promise<ArtifactNamespaceScanPageResult>;
  readonly #closeNamespaceScan: (
    input: CloseArtifactNamespaceScanInput,
  ) => Promise<CloseArtifactNamespaceScanResult>;
  readonly #cleanupNamespaceEntry: (
    input: ArtifactNamespaceObservation,
  ) => Promise<ArtifactNamespaceCleanupResult>;
  readonly #batchSize: number;
  readonly #namespaceBatchSize: number;
  readonly #intervalMilliseconds: number;
  readonly #passTimeoutMilliseconds: number;
  readonly #closeTimeoutMilliseconds: number;
  readonly #initialRetryDelaySeconds: number;
  readonly #maximumRetryDelaySeconds: number;
  readonly #onFailStop: (error: ArtifactReconciliationCoordinatorError) => void | Promise<void>;
  readonly #fatalSignal = Promise.withResolvers<ArtifactReconciliationCoordinatorError>();
  readonly #firstPass = Promise.withResolvers<void>();
  readonly #firstSweep = Promise.withResolvers<void>();
  readonly #fatalWaiters = new Set<FatalWaiter>();
  #state: "open" | "closing" | "closed" | "fatal" = "open";
  #startupTimer: NodeJS.Timeout | undefined;
  #timer: NodeJS.Timeout | undefined;
  #currentPass: Promise<ArtifactReconciliationPassResult> | undefined;
  #fatalError: ArtifactReconciliationCoordinatorError | undefined;
  #failStopCallbackCompletion: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #health: ArtifactHealthAccounting | undefined;
  #firstPassSettled = false;
  #firstSweepSettled = false;
  #ownerExitObserved = false;
  #namespaceScanSessionId: string | undefined;
  #namespaceScanGeneration: number | undefined;
  #namespaceScanAfterKey: string | null | undefined;

  private constructor(
    options: ArtifactReconciliationCoordinatorOptions,
    database: ArtifactReconciliationDatabaseOwner,
  ) {
    const storage = options.storage;
    const batchSize = options.batchSize;
    const intervalMilliseconds = options.intervalMilliseconds;
    const passTimeoutMilliseconds = options.passTimeoutMilliseconds;
    const closeTimeoutMilliseconds = options.closeTimeoutMilliseconds;
    const initialRetryDelaySeconds = options.initialRetryDelaySeconds;
    const maximumRetryDelaySeconds = options.maximumRetryDelaySeconds;
    const onFailStop = options.onFailStop;
    if (
      (typeof database !== "object" && typeof database !== "function") ||
      database === null ||
      (typeof storage !== "object" && typeof storage !== "function") ||
      storage === null
    ) {
      throw new TypeError("Artifact reconciliation owner bindings are invalid.");
    }
    const requestDatabase = database.request;
    const cleanupUpload = storage.cleanupUpload;
    const scanNamespacePage = storage.scanNamespacePage;
    const closeNamespaceScan = storage.closeNamespaceScan;
    const cleanupNamespaceEntry = storage.cleanupNamespaceEntry;
    const ownerExit = storage.ownerExit;
    if (
      typeof requestDatabase !== "function" ||
      typeof cleanupUpload !== "function" ||
      typeof scanNamespacePage !== "function" ||
      typeof closeNamespaceScan !== "function" ||
      typeof cleanupNamespaceEntry !== "function" ||
      !(ownerExit instanceof Promise) ||
      typeof onFailStop !== "function"
    ) {
      throw new TypeError("Artifact reconciliation owner bindings are invalid.");
    }

    this.#requestDatabase = (<TOperation extends ArtifactCleanupDatabaseOperation>(
      operation: TOperation,
      input: DatabaseOperationMap[TOperation]["input"],
    ): Promise<DatabaseOperationMap[TOperation]["output"]> =>
      Reflect.apply(requestDatabase, database, [operation, input]) as Promise<
        DatabaseOperationMap[TOperation]["output"]
      >) as ArtifactCleanupDatabaseRequest;
    this.#cleanupUpload = (input) =>
      Reflect.apply(cleanupUpload, storage, [input]) as Promise<ArtifactUploadCleanupResult>;
    this.#scanNamespacePage = (input) =>
      Reflect.apply(scanNamespacePage, storage, [
        input,
      ]) as Promise<ArtifactNamespaceScanPageResult>;
    this.#closeNamespaceScan = (input) =>
      Reflect.apply(closeNamespaceScan, storage, [
        input,
      ]) as Promise<CloseArtifactNamespaceScanResult>;
    this.#cleanupNamespaceEntry = (input) =>
      Reflect.apply(cleanupNamespaceEntry, storage, [
        input,
      ]) as Promise<ArtifactNamespaceCleanupResult>;
    this.#batchSize = requirePositiveInteger(
      batchSize,
      maximumArtifactReconciliationBatchSize,
      "Artifact reconciliation batch size",
    );
    this.#namespaceBatchSize = Math.min(this.#batchSize, maximumArtifactNamespacePageSize);
    this.#intervalMilliseconds = requirePositiveInteger(
      intervalMilliseconds,
      maximumCoordinatorMilliseconds,
      "Artifact reconciliation interval",
    );
    this.#passTimeoutMilliseconds = requirePositiveInteger(
      passTimeoutMilliseconds,
      maximumCoordinatorMilliseconds,
      "Artifact reconciliation pass timeout",
    );
    this.#closeTimeoutMilliseconds = requirePositiveInteger(
      closeTimeoutMilliseconds,
      maximumCoordinatorMilliseconds,
      "Artifact reconciliation close timeout",
    );
    this.#initialRetryDelaySeconds = requirePositiveInteger(
      initialRetryDelaySeconds,
      maximumArtifactCleanupRetryDelaySeconds,
      "Artifact cleanup initial retry delay",
    );
    this.#maximumRetryDelaySeconds = requirePositiveInteger(
      maximumRetryDelaySeconds,
      maximumArtifactCleanupRetryDelaySeconds,
      "Artifact cleanup maximum retry delay",
    );
    if (this.#maximumRetryDelaySeconds < this.#initialRetryDelaySeconds) {
      throw new TypeError("Artifact cleanup maximum retry delay must cover its initial delay.");
    }
    this.#onFailStop = onFailStop;
    void this.#firstPass.promise.catch(() => undefined);
    void this.#firstSweep.promise.catch(() => undefined);
    void Reflect.apply(Promise.prototype.then, ownerExit, [
      () => this.#observeOwnerExit(),
      () => this.#observeOwnerExit(),
    ]);
    // The timer callback is the startup linearization point after prior promise reactions drain.
    this.#startupTimer = setTimeout(() => {
      this.#startupTimer = undefined;
      this.#startPass();
    }, 0);
  }

  static start(
    options: ArtifactReconciliationCoordinatorOptions,
  ): ArtifactReconciliationCoordinator {
    const databaseHandle = options.database;
    const consumedDatabase = consumeDatabaseHandle(databaseHandle);
    try {
      return new ArtifactReconciliationCoordinator(options, consumedDatabase.record.owner);
    } catch (error) {
      consumedDatabase.restore();
      throw error;
    }
  }

  get fatal(): Promise<ArtifactReconciliationCoordinatorError> {
    return this.#fatalSignal.promise;
  }

  get firstPass(): Promise<void> {
    return this.#firstPass.promise;
  }

  get firstSweep(): Promise<void> {
    return this.#firstSweep.promise;
  }

  get health(): ArtifactHealthAccounting | undefined {
    return this.#health;
  }

  get failStopCallbackCompletion(): Promise<void> | undefined {
    return this.#failStopCallbackCompletion;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close(performance.now() + this.#closeTimeoutMilliseconds);
    return this.#closePromise;
  }

  #startPass(): void {
    if (this.#state !== "open" || this.#ownerExitObserved || this.#currentPass !== undefined) {
      return;
    }
    const deadline = performance.now() + this.#passTimeoutMilliseconds;
    const pass = Promise.resolve().then(() => this.#runPass(deadline));
    this.#currentPass = pass;
    void pass.then(
      (result) => {
        this.#health = result.health;
        if (result.sweepCompleted) {
          this.#settleFirstSweep();
        }
        this.#settleFirstPass();
        this.#currentPass = undefined;
        if (this.#state === "open") {
          this.#schedulePass(result.continueImmediately ? 0 : this.#intervalMilliseconds);
        }
      },
      (error: unknown) => {
        const fatal = this.#asFatal(error, "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
        this.#currentPass = undefined;
        this.#rejectFirstPass(fatal);
      },
    );
  }

  #schedulePass(delayMilliseconds: number): void {
    if (this.#state !== "open") {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#startPass();
    }, delayMilliseconds);
    this.#timer.unref();
  }

  async #runPass(deadline: number): Promise<ArtifactReconciliationPassResult> {
    let terminalized: { readonly hasMore: boolean };
    try {
      terminalized = snapshotTerminalizationResult(
        await this.#databaseRequest(
          "terminalizeInactiveArtifactUploads",
          { batchSize: this.#batchSize },
          deadline,
        ),
        this.#batchSize,
      );
    } catch (error) {
      throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    let cleanupPage: {
      readonly items: readonly ArtifactCleanupWorkItem[];
      readonly hasMore: boolean;
    };
    try {
      cleanupPage = snapshotCleanupPage(
        await this.#databaseRequest(
          "listDueArtifactCleanups",
          { batchSize: this.#batchSize },
          deadline,
        ),
        this.#batchSize,
      );
    } catch (error) {
      throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    for (const item of cleanupPage.items) {
      await this.#cleanup(item, deadline);
    }

    const namespaceScan = await this.#reconcileNamespacePage(deadline);
    let namespaceCleanupPage: {
      readonly items: readonly ArtifactNamespaceCleanupWorkItem[];
      readonly hasMore: boolean;
    };
    try {
      namespaceCleanupPage = snapshotNamespaceCleanupPage(
        await this.#databaseRequest(
          "listDueArtifactNamespaceCleanups",
          { batchSize: this.#batchSize },
          deadline,
        ),
        this.#batchSize,
      );
    } catch (error) {
      throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    for (const item of namespaceCleanupPage.items) {
      await this.#cleanupNamespace(item, deadline);
    }

    let health: ArtifactHealthAccounting;
    try {
      health = snapshotHealth(
        await this.#databaseRequest("readArtifactHealthAccounting", {}, deadline),
      );
    } catch (error) {
      throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    if (health.namespaceCleanup.failed > 0) {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_NAMESPACE_CLEANUP_FAILED");
    }
    if (health.namespaceCleanup.operationalSaturated) {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_HEALTH_SATURATED");
    }
    return Object.freeze({
      continueImmediately:
        terminalized.hasMore ||
        cleanupPage.hasMore ||
        namespaceScan.hasMore ||
        namespaceCleanupPage.hasMore,
      sweepCompleted: namespaceScan.sweepCompleted,
      health,
    });
  }

  async #reconcileNamespacePage(
    deadline: number,
  ): Promise<{ readonly hasMore: boolean; readonly sweepCompleted: boolean }> {
    let cursor: ArtifactNamespaceCursorSnapshot;
    try {
      cursor = snapshotNamespaceCursor(
        await this.#databaseRequest("readArtifactReconciliationCursor", {}, deadline),
      );
    } catch (error) {
      throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    if (this.#namespaceScanSessionId === undefined) {
      this.#namespaceScanSessionId = randomUUID();
      this.#namespaceScanGeneration = cursor.sweepGeneration;
      this.#namespaceScanAfterKey = cursor.afterKey;
    } else if (
      this.#namespaceScanGeneration !== cursor.sweepGeneration ||
      this.#namespaceScanAfterKey !== cursor.afterKey
    ) {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    const input = normalizeArtifactStorageOperationInput("scanNamespacePage", {
      scanSessionId: this.#namespaceScanSessionId,
      sweepGeneration: cursor.sweepGeneration,
      expectedAfterKey: cursor.afterKey,
      maximumEntries: this.#namespaceBatchSize,
    });
    const expectation = createArtifactStorageResponseExpectation("scanNamespacePage", input);
    let rawPage: ArtifactNamespaceScanPageResult;
    try {
      rawPage = await this.#awaitBeforeDeadline(
        () => this.#scanNamespacePage(input),
        deadline,
        "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN",
      );
    } catch (error) {
      throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN");
    }
    let page: ArtifactNamespaceScanPageResult;
    try {
      page = normalizeArtifactStorageOperationOutput("scanNamespacePage", rawPage);
      assertArtifactStorageResponseMatchesExpectation(expectation, "scanNamespacePage", page);
    } catch {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    let nextCursor: ArtifactNamespaceCursorSnapshot;
    try {
      const classification = await this.#databaseRequest(
        "classifyArtifactNamespacePageAndAdvanceCursor",
        {
          expectedSweepGeneration: page.sweepGeneration,
          expectedAfterKey: page.expectedAfterKey,
          observations: page.observations,
          completedSweep: page.completedSweep,
        },
        deadline,
      );
      nextCursor = assertNamespaceClassificationResult(classification, page);
    } catch (error) {
      throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    if (page.completedSweep) {
      this.#namespaceScanSessionId = undefined;
      this.#namespaceScanGeneration = undefined;
      this.#namespaceScanAfterKey = undefined;
    } else {
      this.#namespaceScanAfterKey = nextCursor.afterKey;
    }
    return Object.freeze({
      hasMore: !page.completedSweep,
      sweepCompleted: page.completedSweep,
    });
  }

  async #cleanupNamespace(item: ArtifactNamespaceCleanupWorkItem, deadline: number): Promise<void> {
    const rawObservation: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of namespaceObservationKeys) {
      rawObservation[key] = item[key];
    }
    const input = normalizeArtifactStorageOperationInput("cleanupNamespaceEntry", rawObservation);
    const expectation = createArtifactStorageResponseExpectation("cleanupNamespaceEntry", input);
    let rawResult: ArtifactNamespaceCleanupResult;
    try {
      rawResult = await this.#awaitBeforeDeadline(
        () => this.#cleanupNamespaceEntry(input),
        deadline,
        "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN",
      );
    } catch (error) {
      const retryCode = this.#safeUndispatchedRetryCode(error);
      if (retryCode === undefined) {
        throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN");
      }
      await this.#recordNamespaceCleanupFailure(item, retryCode, deadline);
      return;
    }
    let result: ArtifactNamespaceCleanupResult;
    try {
      result = normalizeArtifactStorageOperationOutput("cleanupNamespaceEntry", rawResult);
      assertArtifactStorageResponseMatchesExpectation(expectation, "cleanupNamespaceEntry", result);
    } catch {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    if (result.outcome === "identity_changed") {
      await this.#recordNamespaceCleanupFailure(item, "storage_busy", deadline);
      return;
    }
    const completed = await this.#databaseRequest(
      "completeArtifactNamespaceCleanup",
      {
        entryKey: item.entryKey,
        observationSha256: item.observationSha256,
        expectedAttemptCount: item.expectedAttemptCount,
      },
      deadline,
    );
    try {
      const record = requireRecord(completed, "Artifact namespace cleanup completion");
      requireExactKeys(record, [
        "entryKey",
        "observationSha256",
        "status",
        "attemptCount",
        "completedAt",
        "replayed",
      ]);
      if (
        record.entryKey !== item.entryKey ||
        record.observationSha256 !== item.observationSha256 ||
        record.status !== "completed" ||
        record.attemptCount !== item.expectedAttemptCount ||
        typeof record.replayed !== "boolean"
      ) {
        throw new TypeError("Artifact namespace cleanup completion is inconsistent.");
      }
      requireCanonicalDateTime(record.completedAt, "Artifact namespace cleanup completion time");
    } catch {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
  }

  async #recordNamespaceCleanupFailure(
    item: ArtifactNamespaceCleanupWorkItem,
    errorCode: ArtifactCleanupRetryErrorCode,
    deadline: number,
  ): Promise<void> {
    const retryDelaySeconds = this.#nextNamespaceRetryDelay(item);
    const failure = await this.#databaseRequest(
      "recordArtifactNamespaceCleanupFailure",
      {
        entryKey: item.entryKey,
        observationSha256: item.observationSha256,
        expectedAttemptCount: item.expectedAttemptCount,
        errorCode,
        retryDelaySeconds,
      },
      deadline,
    );
    try {
      const record = requireRecord(failure, "Artifact namespace cleanup failure result");
      requireExactKeys(record, [
        "entryKey",
        "observationSha256",
        "status",
        "attemptCount",
        "nextAttemptAt",
        "errorCode",
        "retryDelaySeconds",
        "replayed",
      ]);
      const attemptCount = item.expectedAttemptCount + 1;
      const failed = attemptCount === 8;
      if (
        record.entryKey !== item.entryKey ||
        record.observationSha256 !== item.observationSha256 ||
        record.status !== (failed ? "failed" : "retry_waiting") ||
        record.attemptCount !== attemptCount ||
        record.errorCode !== errorCode ||
        record.retryDelaySeconds !== retryDelaySeconds ||
        typeof record.replayed !== "boolean" ||
        (failed && record.nextAttemptAt !== null) ||
        (!failed && record.nextAttemptAt === null)
      ) {
        throw new TypeError("Artifact namespace cleanup failure result is inconsistent.");
      }
      if (!failed) {
        requireCanonicalDateTime(
          record.nextAttemptAt,
          "Artifact namespace cleanup next attempt time",
        );
      }
    } catch {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
  }

  #nextNamespaceRetryDelay(item: ArtifactNamespaceCleanupWorkItem): number {
    const prior = item.lastRetryDelaySeconds;
    return prior === null
      ? this.#initialRetryDelaySeconds
      : Math.min(this.#maximumRetryDelaySeconds, prior * 2);
  }

  async #cleanup(item: ArtifactCleanupWorkItem, deadline: number): Promise<void> {
    const input = normalizeArtifactStorageOperationInput("cleanupUpload", {
      uploadId: item.uploadId,
      publications: item.publications,
    });
    const expectation = createArtifactStorageResponseExpectation("cleanupUpload", input);
    let rawResult: ArtifactUploadCleanupResult;
    try {
      rawResult = await this.#awaitBeforeDeadline(
        () => this.#cleanupUpload(input),
        deadline,
        "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN",
      );
    } catch (error) {
      const retryCode = this.#safeUndispatchedRetryCode(error);
      if (retryCode === undefined) {
        throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN");
      }
      const retryDelaySeconds = this.#nextRetryDelay(item);
      const failure = await this.#databaseRequest(
        "recordArtifactCleanupFailure",
        {
          uploadId: item.uploadId,
          expectedAttemptCount: item.expectedAttemptCount,
          errorCode: retryCode,
          retryDelaySeconds,
        },
        deadline,
      );
      this.#assertFailureResult(failure, item, retryCode, retryDelaySeconds);
      return;
    }
    try {
      const result = normalizeArtifactStorageOperationOutput("cleanupUpload", rawResult);
      assertArtifactStorageResponseMatchesExpectation(expectation, "cleanupUpload", result);
    } catch {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
    const completed = await this.#databaseRequest(
      "completeArtifactCleanup",
      { uploadId: item.uploadId, expectedAttemptCount: item.expectedAttemptCount },
      deadline,
    );
    try {
      const record = requireRecord(completed, "Artifact cleanup completion");
      requireExactKeys(record, ["uploadId", "status", "attemptCount", "completedAt", "replayed"]);
      if (
        record.uploadId !== item.uploadId ||
        record.status !== "completed" ||
        record.attemptCount !== item.expectedAttemptCount ||
        typeof record.replayed !== "boolean"
      ) {
        throw new TypeError("Artifact cleanup completion is inconsistent.");
      }
      requireCanonicalDateTime(record.completedAt, "Artifact cleanup completion time");
    } catch {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
  }

  #assertFailureResult(
    value: unknown,
    item: ArtifactCleanupWorkItem,
    errorCode: ArtifactCleanupRetryErrorCode,
    retryDelaySeconds: number,
  ): void {
    try {
      const record = requireRecord(value, "Artifact cleanup failure result");
      requireExactKeys(record, [
        "uploadId",
        "status",
        "attemptCount",
        "nextAttemptAt",
        "errorCode",
        "retryDelaySeconds",
        "replayed",
      ]);
      const attemptCount = item.expectedAttemptCount + 1;
      const failed = attemptCount === 8;
      if (
        record.uploadId !== item.uploadId ||
        record.status !== (failed ? "failed" : "retry_waiting") ||
        record.attemptCount !== attemptCount ||
        record.errorCode !== errorCode ||
        record.retryDelaySeconds !== retryDelaySeconds ||
        typeof record.replayed !== "boolean" ||
        (failed && record.nextAttemptAt !== null) ||
        (!failed && record.nextAttemptAt === null)
      ) {
        throw new TypeError("Artifact cleanup failure result is inconsistent.");
      }
      if (!failed) {
        requireCanonicalDateTime(record.nextAttemptAt, "Artifact cleanup next attempt time");
      }
    } catch {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
    }
  }

  #safeUndispatchedRetryCode(error: unknown): ArtifactCleanupRetryErrorCode | undefined {
    return error instanceof ArtifactStorageClientError &&
      error.code === "ARTIFACT_STORAGE_CLIENT_BUSY" &&
      error.retryable
      ? "storage_busy"
      : undefined;
  }

  #nextRetryDelay(item: ArtifactCleanupWorkItem): number {
    const prior = item.lastRetryDelaySeconds;
    return prior === null
      ? this.#initialRetryDelaySeconds
      : Math.min(this.#maximumRetryDelaySeconds, prior * 2);
  }

  async #databaseRequest<TOperation extends ArtifactCleanupDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
    deadline: number,
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    try {
      return await this.#awaitBeforeDeadline(
        () => this.#requestDatabase(operation, input),
        deadline,
        "ARTIFACT_RECONCILIATION_DATABASE_FAILURE",
      );
    } catch (error) {
      throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_DATABASE_FAILURE");
    }
  }

  async #awaitBeforeDeadline<T>(
    action: () => Promise<T>,
    deadline: number,
    timeoutCode: ArtifactReconciliationCoordinatorErrorCode,
  ): Promise<T> {
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (performance.now() >= deadline) {
      throw this.#enterFatal(timeoutCode);
    }

    const interrupted = Promise.withResolvers<never>();
    void interrupted.promise.catch(() => undefined);
    const rejectFatal: FatalWaiter = (error) => interrupted.reject(error);
    this.#fatalWaiters.add(rejectFatal);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (this.#fatalError !== undefined) {
        throw this.#fatalError;
      }
      if (performance.now() >= deadline) {
        throw this.#enterFatal(timeoutCode);
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(this.#enterFatal(timeoutCode)),
          Math.max(1, Math.ceil(deadline - performance.now())),
        );
        timer.unref();
      });
      if (this.#fatalError !== undefined) {
        throw this.#fatalError;
      }
      if (performance.now() >= deadline) {
        throw this.#enterFatal(timeoutCode);
      }
      const operation = action();
      if (!(operation instanceof Promise)) {
        throw new TypeError("Artifact reconciliation owner operations must return promises.");
      }
      if (performance.now() >= deadline) {
        throw this.#enterFatal(timeoutCode);
      }
      if (this.#fatalError !== undefined) {
        throw this.#fatalError;
      }
      const result = await Promise.race([operation, interrupted.promise, timeout]);
      if (performance.now() >= deadline) {
        throw this.#enterFatal(timeoutCode);
      }
      if (this.#fatalError !== undefined) {
        throw this.#fatalError;
      }
      return result;
    } finally {
      this.#fatalWaiters.delete(rejectFatal);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async #awaitNextTurn(deadline: number): Promise<void> {
    let turnTimer: NodeJS.Timeout | undefined;
    try {
      await this.#awaitBeforeDeadline(
        () =>
          new Promise<void>((resolve) => {
            turnTimer = setTimeout(resolve, 0);
          }),
        deadline,
        "ARTIFACT_RECONCILIATION_CLOSE_TIMEOUT",
      );
    } finally {
      if (turnTimer !== undefined) {
        clearTimeout(turnTimer);
      }
    }
  }

  async #close(deadline: number): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    if (this.#state === "open") {
      this.#state = "closing";
    }
    if (this.#startupTimer !== undefined) {
      clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
    }
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const currentPass = this.#currentPass;
    if (currentPass !== undefined) {
      try {
        await this.#awaitBeforeDeadline(
          () => currentPass,
          deadline,
          "ARTIFACT_RECONCILIATION_CLOSE_TIMEOUT",
        );
      } catch (error) {
        throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_CLOSE_TIMEOUT");
      }
    }

    if (
      this.#namespaceScanSessionId !== undefined &&
      this.#namespaceScanGeneration !== undefined &&
      this.#namespaceScanAfterKey !== undefined
    ) {
      const input = normalizeArtifactStorageOperationInput("closeNamespaceScan", {
        scanSessionId: this.#namespaceScanSessionId,
        sweepGeneration: this.#namespaceScanGeneration,
        expectedAfterKey: this.#namespaceScanAfterKey,
      });
      const expectation = createArtifactStorageResponseExpectation("closeNamespaceScan", input);
      let rawClosed: CloseArtifactNamespaceScanResult;
      try {
        rawClosed = await this.#awaitBeforeDeadline(
          () => this.#closeNamespaceScan(input),
          deadline,
          "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN",
        );
      } catch (error) {
        throw this.#asFatal(error, "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN");
      }
      try {
        const closed = normalizeArtifactStorageOperationOutput("closeNamespaceScan", rawClosed);
        assertArtifactStorageResponseMatchesExpectation(expectation, "closeNamespaceScan", closed);
        this.#namespaceScanSessionId = undefined;
        this.#namespaceScanGeneration = undefined;
        this.#namespaceScanAfterKey = undefined;
      } catch {
        throw this.#enterFatal("ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE");
      }
    }

    await this.#awaitNextTurn(deadline);
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (this.#ownerExitObserved) {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_OWNER_EXIT");
    }
    if (performance.now() >= deadline) {
      throw this.#enterFatal("ARTIFACT_RECONCILIATION_CLOSE_TIMEOUT");
    }
    // This assignment is the close linearization point; later owner exit belongs to owner teardown.
    this.#state = "closed";
    this.#settleFirstPass();
    this.#rejectFirstSweep(new Error("Artifact reconciliation closed before its first sweep."));
  }

  #observeOwnerExit(): void {
    this.#ownerExitObserved = true;
    if (this.#state === "closed" || this.#fatalError !== undefined) {
      return;
    }
    this.#enterFatal("ARTIFACT_RECONCILIATION_OWNER_EXIT");
  }

  #enterFatal(
    code: ArtifactReconciliationCoordinatorErrorCode,
  ): ArtifactReconciliationCoordinatorError {
    if (this.#fatalError !== undefined) {
      return this.#fatalError;
    }
    const error = new ArtifactReconciliationCoordinatorError(code);
    this.#fatalError = error;
    this.#state = "fatal";
    if (this.#startupTimer !== undefined) {
      clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
    }
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#fatalSignal.resolve(error);
    this.#rejectFirstPass(error);
    this.#rejectFirstSweep(error);
    for (const reject of [...this.#fatalWaiters]) {
      reject(error);
    }
    let completion: Promise<void>;
    try {
      completion = Promise.resolve(this.#onFailStop(error));
    } catch (callbackError) {
      completion = Promise.reject(callbackError);
    }
    void completion.catch(() => undefined);
    this.#failStopCallbackCompletion = completion;
    return error;
  }

  #asFatal(
    error: unknown,
    fallback: ArtifactReconciliationCoordinatorErrorCode,
  ): ArtifactReconciliationCoordinatorError {
    const localFatal = this.#fatalError;
    return localFatal !== undefined && error === localFatal
      ? localFatal
      : this.#enterFatal(fallback);
  }

  #settleFirstPass(): void {
    if (!this.#firstPassSettled) {
      this.#firstPassSettled = true;
      this.#firstPass.resolve();
    }
  }

  #rejectFirstPass(error: ArtifactReconciliationCoordinatorError): void {
    if (!this.#firstPassSettled) {
      this.#firstPassSettled = true;
      this.#firstPass.reject(error);
    }
  }

  #settleFirstSweep(): void {
    if (!this.#firstSweepSettled) {
      this.#firstSweepSettled = true;
      this.#firstSweep.resolve();
    }
  }

  #rejectFirstSweep(error: unknown): void {
    if (!this.#firstSweepSettled) {
      this.#firstSweepSettled = true;
      this.#firstSweep.reject(error);
    }
  }
}
