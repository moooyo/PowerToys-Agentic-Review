import { createHash, timingSafeEqual } from "node:crypto";
import {
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunks,
} from "@agentic-review/contracts";
import {
  type ArtifactNamespaceCleanupResult,
  type ArtifactNamespaceObservation,
  type ArtifactNamespaceScanPageInput,
  type ArtifactNamespaceScanPageResult,
  type CloseArtifactNamespaceScanInput,
  type CloseArtifactNamespaceScanResult,
  parseArtifactNamespaceEntryKey,
  requireArtifactNamespaceObservationSha256,
  requireArtifactNamespaceScanSessionId,
  snapshotArtifactNamespaceObservation,
  snapshotArtifactNamespaceObservations,
  snapshotArtifactNamespaceScanPageInput,
  snapshotArtifactNamespaceSweepGeneration,
  snapshotCloseArtifactNamespaceScanInput,
} from "./artifact-namespace-contract.js";
import {
  artifactCapacityEntriesPerUpload,
  calculateArtifactReservationBytes,
  deriveArtifactCapacityAccounting,
  maximumArtifactCapacityLiveUploads,
  snapshotArtifactCapacityEvaluationAccounting,
  snapshotArtifactCapacityLimits,
} from "./capacity.js";
import {
  ArtifactStorageCapacityError,
  ArtifactStorageClosedError,
  ArtifactStorageCloseTimeoutError,
  ArtifactStorageIntegrityError,
} from "./errors.js";
import {
  artifactObjectKey,
  requireArtifactByteCount,
  requireArtifactOperationId,
  requireArtifactSha256,
  requireArtifactUploadId,
} from "./names.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactCapacityEvaluationAccounting,
  ArtifactCapacityEvaluationInput,
  ArtifactCapacityLimits,
  ArtifactStorageKernelOptions,
  ArtifactUploadCleanupRequest,
  ArtifactUploadCleanupResult,
  DurableArtifactChunk,
  PreparedArtifactChunk,
  PreparedArtifactFinalization,
  PublishedArtifactObject,
} from "./types.js";

export const artifactStorageProtocolVersion = 1;
export const maximumArtifactStorageRequestId = 2_147_483_647;

export type ArtifactStorageWireErrorCode =
  | "ARTIFACT_STORAGE_CAPACITY"
  | "ARTIFACT_STORAGE_CLOSED"
  | "ARTIFACT_STORAGE_CLOSE_TIMEOUT"
  | "ARTIFACT_STORAGE_INTEGRITY"
  | "ARTIFACT_STORAGE_INTERNAL"
  | "ARTIFACT_STORAGE_INVALID_REQUEST"
  | "ARTIFACT_STORAGE_IO_FAILURE";

export interface ArtifactStorageWireError {
  readonly code: ArtifactStorageWireErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ArtifactObjectReadInput {
  readonly sha256: string;
  readonly totalBytes: number;
}

export interface ArtifactObjectReadOutput {
  readonly bytes: Uint8Array;
}

export interface ArtifactStorageWorkerOperationMap {
  readonly writePreparedChunk: {
    readonly input: PreparedArtifactChunk;
    readonly output: DurableArtifactChunk;
  };
  readonly finalizeArtifact: {
    readonly input: PreparedArtifactFinalization;
    readonly output: PublishedArtifactObject;
  };
  readonly readObject: {
    readonly input: ArtifactObjectReadInput;
    readonly output: ArtifactObjectReadOutput;
  };
  readonly cleanupUpload: {
    readonly input: ArtifactUploadCleanupRequest;
    readonly output: ArtifactUploadCleanupResult;
  };
  readonly scanNamespacePage: {
    readonly input: ArtifactNamespaceScanPageInput;
    readonly output: ArtifactNamespaceScanPageResult;
  };
  readonly closeNamespaceScan: {
    readonly input: CloseArtifactNamespaceScanInput;
    readonly output: CloseArtifactNamespaceScanResult;
  };
  readonly cleanupNamespaceEntry: {
    readonly input: ArtifactNamespaceObservation;
    readonly output: ArtifactNamespaceCleanupResult;
  };
  readonly evaluateCapacity: {
    readonly input: ArtifactCapacityEvaluationInput;
    readonly output: ArtifactCapacityAdmission;
  };
  readonly shutdown: {
    readonly input: Record<string, never>;
    readonly output: { readonly closed: true };
  };
}

export type ArtifactStorageWorkerOperation = keyof ArtifactStorageWorkerOperationMap;

export type ArtifactStorageWorkerRequest = {
  [TOperation in ArtifactStorageWorkerOperation]: {
    readonly type: "request";
    readonly protocolVersion: typeof artifactStorageProtocolVersion;
    readonly id: number;
    readonly operation: TOperation;
    readonly input: ArtifactStorageWorkerOperationMap[TOperation]["input"];
  };
}[ArtifactStorageWorkerOperation];

export type ArtifactStorageWorkerResponse = {
  [TOperation in ArtifactStorageWorkerOperation]:
    | {
        readonly type: "response";
        readonly protocolVersion: typeof artifactStorageProtocolVersion;
        readonly id: number;
        readonly operation: TOperation;
        readonly ok: true;
        readonly output: ArtifactStorageWorkerOperationMap[TOperation]["output"];
      }
    | {
        readonly type: "response";
        readonly protocolVersion: typeof artifactStorageProtocolVersion;
        readonly id: number;
        readonly operation: TOperation;
        readonly ok: false;
        readonly error: ArtifactStorageWireError;
      };
}[ArtifactStorageWorkerOperation];

export type ArtifactStorageWorkerMessage =
  | ArtifactStorageWorkerResponse
  | {
      readonly type: "ready";
      readonly protocolVersion: typeof artifactStorageProtocolVersion;
    }
  | {
      readonly type: "fatal";
      readonly protocolVersion: typeof artifactStorageProtocolVersion;
      readonly error: ArtifactStorageWireError;
    };

export interface ArtifactStorageWorkerData {
  readonly protocolVersion: typeof artifactStorageProtocolVersion;
  readonly storage: ArtifactStorageKernelOptions;
}

export type ArtifactStorageResponseExpectation =
  | {
      readonly operation: "writePreparedChunk";
      readonly uploadId: string;
      readonly prepareId: string;
      readonly durableOffsetBytes: number;
      readonly replayed: boolean;
    }
  | {
      readonly operation: "finalizeArtifact";
      readonly uploadId: string;
      readonly finalizationId: string;
      readonly totalBytes: number;
      readonly sha256: string;
    }
  | { readonly operation: "readObject"; readonly totalBytes: number; readonly sha256: string }
  | { readonly operation: "cleanupUpload"; readonly maximumPublicationRemovals: number }
  | {
      readonly operation: "scanNamespacePage";
      readonly scanSessionId: string;
      readonly sweepGeneration: number;
      readonly expectedAfterKey: string | null;
      readonly maximumEntries: number;
    }
  | {
      readonly operation: "closeNamespaceScan";
      readonly scanSessionId: string;
      readonly sweepGeneration: number;
      readonly expectedAfterKey: string | null;
    }
  | {
      readonly operation: "cleanupNamespaceEntry";
      readonly entryKey: string;
      readonly observationSha256: string;
    }
  | {
      readonly operation: "evaluateCapacity";
      readonly expectedTotalBytes: number;
      readonly accounting: ArtifactCapacityEvaluationAccounting;
    }
  | { readonly operation: "shutdown" };

const workerOperations = new Set<ArtifactStorageWorkerOperation>([
  "writePreparedChunk",
  "finalizeArtifact",
  "readObject",
  "cleanupUpload",
  "scanNamespacePage",
  "closeNamespaceScan",
  "cleanupNamespaceEntry",
  "evaluateCapacity",
  "shutdown",
]);

const wireErrorCodes = new Set<ArtifactStorageWireErrorCode>([
  "ARTIFACT_STORAGE_CAPACITY",
  "ARTIFACT_STORAGE_CLOSED",
  "ARTIFACT_STORAGE_CLOSE_TIMEOUT",
  "ARTIFACT_STORAGE_INTEGRITY",
  "ARTIFACT_STORAGE_INTERNAL",
  "ARTIFACT_STORAGE_INVALID_REQUEST",
  "ARTIFACT_STORAGE_IO_FAILURE",
]);

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

const requireExactKeys = (
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new TypeError("Artifact storage protocol object has unsupported or missing fields.");
  }
};

const requireString = (value: unknown, name: string, maximumLength = 4_096): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`${name} must be bounded non-empty text without NUL characters.`);
  }
  return value;
};

const requireSafeInteger = (
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be a bounded safe integer.`);
  }
  return value as number;
};

const requireBoolean = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be boolean.`);
  }
  return value;
};

const copyBoundedBytes = (value: unknown, maximumBytes: number, name: string): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximumBytes) {
    throw new TypeError(`${name} must be a bounded Uint8Array.`);
  }
  return new Uint8Array(value);
};

const requireDenseArray = (
  value: unknown,
  maximumEntries: number,
  name: string,
): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new TypeError(`${name} must be a bounded array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${name} must not contain holes.`);
    }
  }
  return value;
};

export const normalizeArtifactStorageWorkerData = (value: unknown): ArtifactStorageWorkerData => {
  const record = requireRecord(value, "Artifact storage Worker data");
  requireExactKeys(record, ["protocolVersion", "storage"]);
  if (record.protocolVersion !== artifactStorageProtocolVersion) {
    throw new TypeError("Artifact storage Worker protocol version is unsupported.");
  }
  const storage = requireRecord(record.storage, "Artifact storage Worker configuration");
  requireExactKeys(storage, ["rootPath", "capacity"], ["closeTimeoutMilliseconds"]);
  const capacityRecord = requireRecord(storage.capacity, "Artifact storage capacity");
  requireExactKeys(capacityRecord, [
    "hardBytes",
    "hardEntries",
    "emergencyReserveBytes",
    "perUploadMetadataHeadroomBytes",
    "cleanupBacklogHighWaterEntries",
  ]);
  const capacity = snapshotArtifactCapacityLimits(
    capacityRecord as unknown as ArtifactStorageKernelOptions["capacity"],
  );
  const untrustedCloseTimeoutMilliseconds = storage.closeTimeoutMilliseconds;
  const closeTimeoutMilliseconds =
    untrustedCloseTimeoutMilliseconds === undefined
      ? undefined
      : requireSafeInteger(
          untrustedCloseTimeoutMilliseconds,
          "Artifact storage close timeout",
          1,
          600_000,
        );
  return Object.freeze({
    protocolVersion: artifactStorageProtocolVersion,
    storage: Object.freeze({
      rootPath: requireString(storage.rootPath, "Artifact storage root path"),
      capacity,
      ...(closeTimeoutMilliseconds === undefined ? {} : { closeTimeoutMilliseconds }),
    }),
  });
};

const normalizeCommittedPrefix = (value: unknown): PreparedArtifactChunk["committedPrefix"] => {
  const receipts = requireDenseArray(
    value,
    maximumResultArtifactChunks,
    "Artifact committed prefix",
  );
  let nextExpectedOffset = 0;
  return Object.freeze(
    receipts.map((entry, index) => {
      const record = requireRecord(entry, "Artifact committed prefix receipt");
      requireExactKeys(record, ["chunkIndex", "offsetBytes", "chunkBytes", "chunkSha256"]);
      const receipt = Object.freeze({
        chunkIndex: requireSafeInteger(
          record.chunkIndex,
          "Artifact committed chunk index",
          0,
          maximumResultArtifactChunks - 1,
        ),
        offsetBytes: requireSafeInteger(
          record.offsetBytes,
          "Artifact committed chunk offset",
          0,
          maximumResultArtifactBytes,
        ),
        chunkBytes: requireSafeInteger(
          record.chunkBytes,
          "Artifact committed chunk bytes",
          1,
          maximumResultArtifactChunkBytes,
        ),
        chunkSha256: requireArtifactSha256(
          requireString(record.chunkSha256, "Artifact committed chunk digest", 64),
        ),
      });
      if (receipt.chunkIndex !== index || receipt.offsetBytes !== nextExpectedOffset) {
        throw new TypeError("Artifact committed prefix receipts must be contiguous.");
      }
      nextExpectedOffset += receipt.chunkBytes;
      if (
        !Number.isSafeInteger(nextExpectedOffset) ||
        nextExpectedOffset > maximumResultArtifactBytes
      ) {
        throw new TypeError("Artifact committed prefix exceeds the artifact byte limit.");
      }
      return receipt;
    }),
  );
};

const normalizePreparedChunk = (value: unknown): PreparedArtifactChunk => {
  const record = requireRecord(value, "Prepared artifact chunk");
  requireExactKeys(record, [
    "uploadId",
    "prepareId",
    "chunkIndex",
    "offsetBytes",
    "chunkSha256",
    "bytes",
    "receiptState",
    "committedOffsetBytes",
    "committedPrefix",
  ]);
  const receiptState = record.receiptState;
  if (receiptState !== "prepared" && receiptState !== "committed") {
    throw new TypeError("Artifact chunk receipt state is unsupported.");
  }
  const chunkIndex = requireSafeInteger(
    record.chunkIndex,
    "Artifact chunk index",
    0,
    maximumResultArtifactChunks - 1,
  );
  const offsetBytes = requireSafeInteger(
    record.offsetBytes,
    "Artifact chunk offset",
    0,
    maximumResultArtifactBytes - 1,
  );
  const chunkSha256 = requireArtifactSha256(
    requireString(record.chunkSha256, "Artifact chunk digest", 64),
  );
  const bytes = copyBoundedBytes(
    record.bytes,
    maximumResultArtifactChunkBytes,
    "Artifact chunk bytes",
  );
  const endOffsetBytes = offsetBytes + bytes.byteLength;
  if (!Number.isSafeInteger(endOffsetBytes) || endOffsetBytes > maximumResultArtifactBytes) {
    throw new TypeError("Artifact chunk range exceeds the artifact byte limit.");
  }
  const actualDigest = createHash("sha256").update(bytes).digest();
  if (!timingSafeEqual(actualDigest, Buffer.from(chunkSha256, "hex"))) {
    throw new TypeError("Artifact chunk bytes do not match their digest.");
  }
  const committedOffsetBytes = requireSafeInteger(
    record.committedOffsetBytes,
    "Artifact committed offset",
    0,
    maximumResultArtifactBytes,
  );
  const committedPrefix = normalizeCommittedPrefix(record.committedPrefix);
  const prefixOffsetBytes = committedPrefix.reduce(
    (offset, receipt) => offset + receipt.chunkBytes,
    0,
  );
  if (prefixOffsetBytes !== committedOffsetBytes) {
    throw new TypeError("Artifact committed prefix does not cover its staging cursor.");
  }
  if (receiptState === "prepared") {
    if (committedOffsetBytes !== offsetBytes || chunkIndex !== committedPrefix.length) {
      throw new TypeError("Prepared artifact chunk does not follow its committed prefix.");
    }
  } else {
    const receipt = committedPrefix[chunkIndex];
    if (
      committedOffsetBytes < endOffsetBytes ||
      receipt === undefined ||
      receipt.offsetBytes !== offsetBytes ||
      receipt.chunkBytes !== bytes.byteLength ||
      receipt.chunkSha256 !== chunkSha256
    ) {
      throw new TypeError("Committed artifact chunk does not match its committed receipt.");
    }
  }
  return Object.freeze({
    uploadId: requireArtifactUploadId(requireString(record.uploadId, "Artifact upload ID", 36)),
    prepareId: requireArtifactOperationId(
      requireString(record.prepareId, "Artifact prepare ID", 36),
      "Artifact prepare ID",
    ),
    chunkIndex,
    offsetBytes,
    chunkSha256,
    bytes,
    receiptState,
    committedOffsetBytes,
    committedPrefix,
  });
};

const normalizeFinalization = (value: unknown): PreparedArtifactFinalization => {
  const record = requireRecord(value, "Prepared artifact finalization");
  requireExactKeys(record, ["uploadId", "finalizationId", "totalBytes", "sha256"]);
  return Object.freeze({
    uploadId: requireArtifactUploadId(requireString(record.uploadId, "Artifact upload ID", 36)),
    finalizationId: requireArtifactOperationId(
      requireString(record.finalizationId, "Artifact finalization ID", 36),
      "Artifact finalization ID",
    ),
    totalBytes: requireArtifactByteCount(record.totalBytes as number, "Artifact total bytes"),
    sha256: requireArtifactSha256(requireString(record.sha256, "Artifact digest", 64)),
  });
};

const normalizeObjectRead = (value: unknown): ArtifactObjectReadInput => {
  const record = requireRecord(value, "Artifact object read");
  requireExactKeys(record, ["sha256", "totalBytes"]);
  return Object.freeze({
    sha256: requireArtifactSha256(requireString(record.sha256, "Artifact digest", 64)),
    totalBytes: requireArtifactByteCount(record.totalBytes as number, "Artifact total bytes"),
  });
};

const normalizeCleanup = (value: unknown): ArtifactUploadCleanupRequest => {
  const record = requireRecord(value, "Artifact upload cleanup");
  requireExactKeys(record, ["uploadId"], ["publications"]);
  const uploadId = requireArtifactUploadId(
    requireString(record.uploadId, "Artifact upload ID", 36),
  );
  if (!Object.hasOwn(record, "publications")) {
    return Object.freeze({ uploadId });
  }
  const publicationEntries = requireDenseArray(
    record.publications,
    maximumResultArtifactChunks,
    "Artifact cleanup publications",
  );
  const identities = new Set<string>();
  const publications = publicationEntries.map((entry) => {
    const publication = requireRecord(entry, "Artifact cleanup publication");
    requireExactKeys(publication, ["finalizationId", "totalBytes", "sha256"]);
    const finalizationId = requireArtifactOperationId(
      requireString(publication.finalizationId, "Artifact finalization ID", 36),
      "Artifact finalization ID",
    );
    const sha256 = requireArtifactSha256(requireString(publication.sha256, "Artifact digest", 64));
    const identity = `${finalizationId}:${sha256}`;
    if (identities.has(identity)) {
      throw new TypeError("Artifact cleanup publications must be unique.");
    }
    identities.add(identity);
    return Object.freeze({
      finalizationId,
      totalBytes: requireArtifactByteCount(
        publication.totalBytes as number,
        "Artifact total bytes",
      ),
      sha256,
    });
  });
  return Object.freeze({ uploadId, publications: Object.freeze(publications) });
};

const normalizeCapacityEvaluation = (value: unknown): ArtifactCapacityEvaluationInput => {
  const record = requireRecord(value, "Artifact capacity evaluation");
  requireExactKeys(record, ["request", "accounting"]);
  const request = requireRecord(record.request, "Artifact capacity request");
  requireExactKeys(request, ["expectedTotalBytes"]);
  const accounting = requireRecord(record.accounting, "Artifact capacity accounting");
  requireExactKeys(accounting, [
    "accountingCertain",
    "liveUploadCount",
    "liveUploadExpectedByteSizeBuckets",
    "cleanupBacklogEntries",
  ]);
  const bucketEntries = requireDenseArray(
    accounting.liveUploadExpectedByteSizeBuckets,
    maximumArtifactCapacityLiveUploads,
    "Artifact live upload byte-size buckets",
  );
  const buckets = bucketEntries.map((entry) => {
    const bucket = requireRecord(entry, "Artifact live upload byte-size bucket");
    requireExactKeys(bucket, ["expectedTotalBytes", "uploadCount"]);
    return Object.freeze({
      expectedTotalBytes: requireSafeInteger(
        bucket.expectedTotalBytes,
        "Artifact live upload expected byte size",
        1,
        maximumResultArtifactBytes,
      ),
      uploadCount: requireSafeInteger(
        bucket.uploadCount,
        "Artifact live upload bucket count",
        1,
        maximumArtifactCapacityLiveUploads,
      ),
    });
  });
  return Object.freeze({
    request: Object.freeze({
      expectedTotalBytes: requireArtifactByteCount(
        request.expectedTotalBytes as number,
        "Artifact expected total bytes",
      ),
    }),
    accounting: snapshotArtifactCapacityEvaluationAccounting({
      accountingCertain: accounting.accountingCertain as boolean,
      liveUploadCount: accounting.liveUploadCount as number,
      liveUploadExpectedByteSizeBuckets: buckets,
      cleanupBacklogEntries: accounting.cleanupBacklogEntries as number,
    }),
  });
};

export const normalizeArtifactStorageOperationInput = <
  TOperation extends ArtifactStorageWorkerOperation,
>(
  operation: TOperation,
  value: unknown,
): ArtifactStorageWorkerOperationMap[TOperation]["input"] => {
  let normalized: ArtifactStorageWorkerOperationMap[ArtifactStorageWorkerOperation]["input"];
  switch (operation) {
    case "writePreparedChunk":
      normalized = normalizePreparedChunk(value);
      break;
    case "finalizeArtifact":
      normalized = normalizeFinalization(value);
      break;
    case "readObject":
      normalized = normalizeObjectRead(value);
      break;
    case "cleanupUpload":
      normalized = normalizeCleanup(value);
      break;
    case "scanNamespacePage":
      normalized = snapshotArtifactNamespaceScanPageInput(value);
      break;
    case "closeNamespaceScan":
      normalized = snapshotCloseArtifactNamespaceScanInput(value);
      break;
    case "cleanupNamespaceEntry":
      normalized = snapshotArtifactNamespaceObservation(value);
      break;
    case "evaluateCapacity":
      normalized = normalizeCapacityEvaluation(value);
      break;
    case "shutdown": {
      const record = requireRecord(value, "Artifact storage shutdown");
      requireExactKeys(record, []);
      normalized = Object.freeze({});
      break;
    }
    default:
      throw new TypeError("Artifact storage operation is unsupported.");
  }
  return normalized as ArtifactStorageWorkerOperationMap[TOperation]["input"];
};

export const createArtifactStorageResponseExpectation = <
  TOperation extends ArtifactStorageWorkerOperation,
>(
  operation: TOperation,
  input: ArtifactStorageWorkerOperationMap[TOperation]["input"],
): ArtifactStorageResponseExpectation => {
  switch (operation) {
    case "writePreparedChunk": {
      const chunk = input as ArtifactStorageWorkerOperationMap["writePreparedChunk"]["input"];
      return Object.freeze({
        operation: "writePreparedChunk" as const,
        uploadId: chunk.uploadId,
        prepareId: chunk.prepareId,
        durableOffsetBytes: chunk.offsetBytes + chunk.bytes.byteLength,
        replayed: chunk.receiptState === "committed",
      });
    }
    case "finalizeArtifact": {
      const finalization = input as ArtifactStorageWorkerOperationMap["finalizeArtifact"]["input"];
      return Object.freeze({
        operation: "finalizeArtifact" as const,
        uploadId: finalization.uploadId,
        finalizationId: finalization.finalizationId,
        totalBytes: finalization.totalBytes,
        sha256: finalization.sha256,
      });
    }
    case "readObject": {
      const read = input as ArtifactStorageWorkerOperationMap["readObject"]["input"];
      return Object.freeze({
        operation: "readObject" as const,
        totalBytes: read.totalBytes,
        sha256: read.sha256,
      });
    }
    case "cleanupUpload": {
      const cleanup = input as ArtifactStorageWorkerOperationMap["cleanupUpload"]["input"];
      return Object.freeze({
        operation: "cleanupUpload" as const,
        maximumPublicationRemovals: cleanup.publications?.length ?? 0,
      });
    }
    case "scanNamespacePage": {
      const scan = input as ArtifactStorageWorkerOperationMap["scanNamespacePage"]["input"];
      return Object.freeze({ operation: "scanNamespacePage" as const, ...scan });
    }
    case "closeNamespaceScan": {
      const scan = input as ArtifactStorageWorkerOperationMap["closeNamespaceScan"]["input"];
      return Object.freeze({ operation: "closeNamespaceScan" as const, ...scan });
    }
    case "cleanupNamespaceEntry": {
      const cleanup = input as ArtifactStorageWorkerOperationMap["cleanupNamespaceEntry"]["input"];
      return Object.freeze({
        operation: "cleanupNamespaceEntry" as const,
        entryKey: cleanup.entryKey,
        observationSha256: cleanup.observationSha256,
      });
    }
    case "evaluateCapacity": {
      const evaluation = input as ArtifactStorageWorkerOperationMap["evaluateCapacity"]["input"];
      return Object.freeze({
        operation: "evaluateCapacity" as const,
        expectedTotalBytes: evaluation.request.expectedTotalBytes,
        accounting: evaluation.accounting,
      });
    }
    case "shutdown":
      return Object.freeze({ operation: "shutdown" as const });
    default:
      throw new TypeError("Artifact storage response expectation operation is unsupported.");
  }
};

export const assertArtifactStorageResponseMatchesExpectation = (
  expectation: ArtifactStorageResponseExpectation,
  operation: ArtifactStorageWorkerOperation,
  output: ArtifactStorageWorkerOperationMap[ArtifactStorageWorkerOperation]["output"],
  capacity?: ArtifactCapacityLimits,
): void => {
  if (expectation.operation !== operation) {
    throw new TypeError("Artifact storage response operation does not match its request.");
  }
  switch (expectation.operation) {
    case "writePreparedChunk": {
      const chunk = output as DurableArtifactChunk;
      if (
        chunk.uploadId !== expectation.uploadId ||
        chunk.prepareId !== expectation.prepareId ||
        chunk.durableOffsetBytes !== expectation.durableOffsetBytes ||
        chunk.replayed !== expectation.replayed
      ) {
        throw new TypeError("Artifact storage durable chunk does not match its request.");
      }
      return;
    }
    case "scanNamespacePage": {
      const page = output as ArtifactNamespaceScanPageResult;
      if (
        page.scanSessionId !== expectation.scanSessionId ||
        page.sweepGeneration !== expectation.sweepGeneration ||
        page.expectedAfterKey !== expectation.expectedAfterKey ||
        page.observations.length > expectation.maximumEntries ||
        (!page.completedSweep && page.observations.length !== expectation.maximumEntries) ||
        (page.completedSweep && page.nextAfterKey !== null) ||
        (!page.completedSweep && page.nextAfterKey !== (page.observations.at(-1)?.entryKey ?? null))
      ) {
        throw new TypeError("Artifact namespace scan page does not match its request.");
      }
      return;
    }
    case "closeNamespaceScan": {
      const closed = output as CloseArtifactNamespaceScanResult;
      if (
        closed.scanSessionId !== expectation.scanSessionId ||
        closed.sweepGeneration !== expectation.sweepGeneration ||
        closed.expectedAfterKey !== expectation.expectedAfterKey ||
        closed.closed !== true
      ) {
        throw new TypeError("Artifact namespace scan closure does not match its request.");
      }
      return;
    }
    case "cleanupNamespaceEntry": {
      const cleanup = output as ArtifactNamespaceCleanupResult;
      if (
        cleanup.entryKey !== expectation.entryKey ||
        cleanup.observationSha256 !== expectation.observationSha256
      ) {
        throw new TypeError("Artifact namespace cleanup result does not match its request.");
      }
      return;
    }
    case "finalizeArtifact": {
      const published = output as PublishedArtifactObject;
      if (
        published.uploadId !== expectation.uploadId ||
        published.finalizationId !== expectation.finalizationId ||
        published.totalBytes !== expectation.totalBytes ||
        published.sha256 !== expectation.sha256
      ) {
        throw new TypeError("Artifact storage published object does not match its request.");
      }
      return;
    }
    case "readObject": {
      const bytes = (output as ArtifactObjectReadOutput).bytes;
      const actualDigest = createHash("sha256").update(bytes).digest();
      if (
        bytes.byteLength !== expectation.totalBytes ||
        !timingSafeEqual(actualDigest, Buffer.from(expectation.sha256, "hex"))
      ) {
        throw new TypeError("Artifact storage object bytes do not match the request.");
      }
      return;
    }
    case "cleanupUpload":
      if (
        (output as ArtifactUploadCleanupResult).publicationTemporariesRemoved >
        expectation.maximumPublicationRemovals
      ) {
        throw new TypeError("Artifact storage cleanup result exceeds its request.");
      }
      return;
    case "evaluateCapacity": {
      if (capacity === undefined) {
        throw new TypeError("Artifact storage capacity configuration is required.");
      }
      const limits = snapshotArtifactCapacityLimits(capacity);
      const admission = output as ArtifactCapacityAdmission;
      const filesystem = {
        availableBytes: admission.filesystemAvailableBytes,
        allocationUnitBytes: admission.filesystemAllocationUnitBytes,
      };
      const requiredBytes = calculateArtifactReservationBytes(
        expectation.expectedTotalBytes,
        filesystem,
        limits.perUploadMetadataHeadroomBytes,
      );
      const outstanding = deriveArtifactCapacityAccounting(
        expectation.accounting,
        filesystem,
        limits.perUploadMetadataHeadroomBytes,
      );
      if (
        !outstanding.accountingCertain ||
        outstanding.cleanupBacklogEntries > limits.cleanupBacklogHighWaterEntries ||
        admission.requiredBytes !== requiredBytes ||
        admission.requiredEntries !== artifactCapacityEntriesPerUpload ||
        admission.outstandingReservationBytes !== outstanding.outstandingReservationBytes ||
        admission.outstandingReservationEntries !== outstanding.outstandingReservationEntries ||
        admission.projectedChargedBytes > limits.hardBytes ||
        admission.projectedChargedEntries > limits.hardEntries ||
        admission.filesystemAvailableAfterReservationsBytes < limits.emergencyReserveBytes ||
        admission.filesystemAvailableAfterReservationsBytes - limits.emergencyReserveBytes <
          admission.requiredBytes
      ) {
        throw new TypeError("Artifact storage capacity admission does not match its request.");
      }
      return;
    }
    case "shutdown":
      return;
    default:
      throw new TypeError("Artifact storage response expectation is unsupported.");
  }
};

export const parseArtifactStorageWorkerRequest = (value: unknown): ArtifactStorageWorkerRequest => {
  const record = requireRecord(value, "Artifact storage Worker request");
  requireExactKeys(record, ["type", "protocolVersion", "id", "operation", "input"]);
  if (record.type !== "request" || record.protocolVersion !== artifactStorageProtocolVersion) {
    throw new TypeError("Artifact storage Worker request envelope is invalid.");
  }
  if (
    typeof record.operation !== "string" ||
    !workerOperations.has(record.operation as ArtifactStorageWorkerOperation)
  ) {
    throw new TypeError("Artifact storage Worker operation is unsupported.");
  }
  const operation = record.operation as ArtifactStorageWorkerOperation;
  const id = requireSafeInteger(
    record.id,
    "Artifact storage request ID",
    1,
    maximumArtifactStorageRequestId,
  );
  if (id === maximumArtifactStorageRequestId && operation !== "shutdown") {
    throw new TypeError("The final artifact storage request ID is reserved for shutdown.");
  }
  return {
    type: "request",
    protocolVersion: artifactStorageProtocolVersion,
    id,
    operation,
    input: normalizeArtifactStorageOperationInput(operation, record.input),
  } as ArtifactStorageWorkerRequest;
};

const errorCatalog: Readonly<
  Record<ArtifactStorageWireErrorCode, { readonly message: string; readonly retryable: boolean }>
> = Object.freeze({
  ARTIFACT_STORAGE_CAPACITY: {
    message: "Artifact storage capacity is unavailable.",
    retryable: true,
  },
  ARTIFACT_STORAGE_CLOSED: {
    message: "Artifact storage is closed.",
    retryable: false,
  },
  ARTIFACT_STORAGE_CLOSE_TIMEOUT: {
    message: "Artifact storage shutdown timed out.",
    retryable: false,
  },
  ARTIFACT_STORAGE_INTEGRITY: {
    message: "Artifact storage integrity validation failed.",
    retryable: false,
  },
  ARTIFACT_STORAGE_INTERNAL: {
    message: "Artifact storage failed internally.",
    retryable: false,
  },
  ARTIFACT_STORAGE_INVALID_REQUEST: {
    message: "Artifact storage request is invalid.",
    retryable: false,
  },
  ARTIFACT_STORAGE_IO_FAILURE: {
    message: "Artifact storage I/O failed.",
    retryable: false,
  },
});

const canonicalWireError = (code: ArtifactStorageWireErrorCode): ArtifactStorageWireError =>
  Object.freeze({ code, ...errorCatalog[code] });

export const serializeArtifactStorageError = (error: unknown): ArtifactStorageWireError => {
  if (error instanceof ArtifactStorageCapacityError) {
    return canonicalWireError("ARTIFACT_STORAGE_CAPACITY");
  }
  if (error instanceof ArtifactStorageIntegrityError) {
    return canonicalWireError("ARTIFACT_STORAGE_INTEGRITY");
  }
  if (error instanceof ArtifactStorageClosedError) {
    return canonicalWireError("ARTIFACT_STORAGE_CLOSED");
  }
  if (error instanceof ArtifactStorageCloseTimeoutError) {
    return canonicalWireError("ARTIFACT_STORAGE_CLOSE_TIMEOUT");
  }
  if (error instanceof TypeError) {
    return canonicalWireError("ARTIFACT_STORAGE_INVALID_REQUEST");
  }
  if (error instanceof Error && "code" in error) {
    if (error.code === "ENOSPC" || error.code === "EDQUOT") {
      return canonicalWireError("ARTIFACT_STORAGE_CAPACITY");
    }
    if (["EIO", "EROFS", "ESTALE"].includes(String(error.code))) {
      return canonicalWireError("ARTIFACT_STORAGE_IO_FAILURE");
    }
  }
  return canonicalWireError("ARTIFACT_STORAGE_INTERNAL");
};

export const serializeArtifactStorageFatalError = (error: unknown): ArtifactStorageWireError => {
  const serialized = serializeArtifactStorageError(error);
  return Object.freeze({ ...serialized, retryable: false });
};

const normalizeWireError = (
  value: unknown,
  allowRetryableCapacity: boolean,
): ArtifactStorageWireError => {
  const record = requireRecord(value, "Artifact storage wire error");
  requireExactKeys(record, ["code", "message", "retryable"]);
  if (
    typeof record.code !== "string" ||
    !wireErrorCodes.has(record.code as ArtifactStorageWireErrorCode)
  ) {
    throw new TypeError("Artifact storage wire error code is unsupported.");
  }
  requireString(record.message, "Artifact storage wire error message", 256);
  requireBoolean(record.retryable, "Artifact storage wire retryable flag");
  const code = record.code as ArtifactStorageWireErrorCode;
  const canonical = canonicalWireError(code);
  const retryable = allowRetryableCapacity && code === "ARTIFACT_STORAGE_CAPACITY";
  if (record.message !== canonical.message || record.retryable !== retryable) {
    throw new TypeError("Artifact storage wire error does not match its canonical code.");
  }
  return Object.freeze({ code, message: canonical.message, retryable });
};

export const isFatalArtifactStorageOperationError = (
  operation: ArtifactStorageWorkerOperation,
  error: ArtifactStorageWireError,
): boolean => !(operation === "evaluateCapacity" && error.code === "ARTIFACT_STORAGE_CAPACITY");

const normalizeDurableChunk = (value: unknown): DurableArtifactChunk => {
  const record = requireRecord(value, "Durable artifact chunk");
  requireExactKeys(record, ["uploadId", "prepareId", "durableOffsetBytes", "replayed"]);
  return Object.freeze({
    uploadId: requireArtifactUploadId(requireString(record.uploadId, "Artifact upload ID", 36)),
    prepareId: requireArtifactOperationId(
      requireString(record.prepareId, "Artifact prepare ID", 36),
      "Artifact prepare ID",
    ),
    durableOffsetBytes: requireSafeInteger(
      record.durableOffsetBytes,
      "Artifact durable offset",
      1,
      maximumResultArtifactBytes,
    ),
    replayed: requireBoolean(record.replayed, "Artifact chunk replay flag"),
  });
};

const normalizePublishedObject = (value: unknown): PublishedArtifactObject => {
  const record = requireRecord(value, "Published artifact object");
  requireExactKeys(record, [
    "uploadId",
    "finalizationId",
    "storageObjectKey",
    "totalBytes",
    "sha256",
    "reused",
  ]);
  const sha256 = requireArtifactSha256(requireString(record.sha256, "Artifact digest", 64));
  const storageObjectKey = requireString(record.storageObjectKey, "Artifact object key", 80);
  if (storageObjectKey !== artifactObjectKey(sha256)) {
    throw new TypeError("Artifact object key does not match its digest.");
  }
  return Object.freeze({
    uploadId: requireArtifactUploadId(requireString(record.uploadId, "Artifact upload ID", 36)),
    finalizationId: requireArtifactOperationId(
      requireString(record.finalizationId, "Artifact finalization ID", 36),
      "Artifact finalization ID",
    ),
    storageObjectKey,
    totalBytes: requireArtifactByteCount(record.totalBytes as number, "Artifact total bytes"),
    sha256,
    reused: requireBoolean(record.reused, "Artifact object reuse flag"),
  });
};

const normalizeCleanupOutput = (value: unknown): ArtifactUploadCleanupResult => {
  const record = requireRecord(value, "Artifact cleanup result");
  requireExactKeys(record, ["stagingRemoved", "publicationTemporariesRemoved"]);
  return Object.freeze({
    stagingRemoved: requireBoolean(record.stagingRemoved, "Artifact staging removal flag"),
    publicationTemporariesRemoved: requireSafeInteger(
      record.publicationTemporariesRemoved,
      "Artifact publication temporary removal count",
      0,
      8,
    ),
  });
};

const requireNonnegativeBigInt = (value: unknown, name: string): bigint => {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${name} must be a non-negative bigint.`);
  }
  return value;
};

const normalizeCapacityAdmission = (value: unknown): ArtifactCapacityAdmission => {
  const record = requireRecord(value, "Artifact capacity admission");
  requireExactKeys(record, [
    "requiredBytes",
    "requiredEntries",
    "physicalAllocatedBytes",
    "physicalEntries",
    "outstandingReservationBytes",
    "outstandingReservationEntries",
    "filesystemAvailableBytes",
    "filesystemAvailableAfterReservationsBytes",
    "filesystemAllocationUnitBytes",
    "projectedChargedBytes",
    "projectedChargedEntries",
  ]);
  const admission = Object.freeze({
    requiredBytes: requireNonnegativeBigInt(record.requiredBytes, "Artifact required bytes"),
    requiredEntries: requireSafeInteger(
      record.requiredEntries,
      "Artifact required entries",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    physicalAllocatedBytes: requireNonnegativeBigInt(
      record.physicalAllocatedBytes,
      "Artifact physical bytes",
    ),
    physicalEntries: requireSafeInteger(
      record.physicalEntries,
      "Artifact physical entries",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    outstandingReservationBytes: requireNonnegativeBigInt(
      record.outstandingReservationBytes,
      "Artifact outstanding reservation bytes",
    ),
    outstandingReservationEntries: requireSafeInteger(
      record.outstandingReservationEntries,
      "Artifact outstanding reservation entries",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    filesystemAvailableBytes: requireNonnegativeBigInt(
      record.filesystemAvailableBytes,
      "Artifact filesystem available bytes",
    ),
    filesystemAvailableAfterReservationsBytes: requireNonnegativeBigInt(
      record.filesystemAvailableAfterReservationsBytes,
      "Artifact filesystem available bytes after reservations",
    ),
    filesystemAllocationUnitBytes: requireNonnegativeBigInt(
      record.filesystemAllocationUnitBytes,
      "Artifact filesystem allocation unit",
    ),
    projectedChargedBytes: requireNonnegativeBigInt(
      record.projectedChargedBytes,
      "Artifact projected charged bytes",
    ),
    projectedChargedEntries: requireSafeInteger(
      record.projectedChargedEntries,
      "Artifact projected charged entries",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  });
  if (
    admission.requiredBytes < 1n ||
    admission.filesystemAllocationUnitBytes < 1n ||
    admission.filesystemAvailableBytes < admission.outstandingReservationBytes ||
    admission.filesystemAvailableAfterReservationsBytes !==
      admission.filesystemAvailableBytes - admission.outstandingReservationBytes ||
    admission.projectedChargedBytes !==
      admission.physicalAllocatedBytes +
        admission.outstandingReservationBytes +
        admission.requiredBytes ||
    admission.projectedChargedEntries !==
      admission.physicalEntries +
        admission.outstandingReservationEntries +
        admission.requiredEntries
  ) {
    throw new TypeError("Artifact capacity admission contains inconsistent values.");
  }
  return admission;
};

const normalizeNamespaceScanPage = (value: unknown): ArtifactNamespaceScanPageResult => {
  const record = requireRecord(value, "Artifact namespace scan page");
  requireExactKeys(record, [
    "scanSessionId",
    "sweepGeneration",
    "expectedAfterKey",
    "observations",
    "completedSweep",
    "nextAfterKey",
  ]);
  const expectedAfterKey =
    record.expectedAfterKey === null
      ? null
      : parseArtifactNamespaceEntryKey(record.expectedAfterKey).entryKey;
  const nextAfterKey =
    record.nextAfterKey === null
      ? null
      : parseArtifactNamespaceEntryKey(record.nextAfterKey).entryKey;
  const observations = snapshotArtifactNamespaceObservations(record.observations);
  const completedSweep = requireBoolean(
    record.completedSweep,
    "Artifact namespace scan completion",
  );
  let priorKey = expectedAfterKey;
  for (const observation of observations) {
    if (priorKey !== null && observation.entryKey <= priorKey) {
      throw new TypeError("Artifact namespace scan entries must be strictly increasing.");
    }
    priorKey = observation.entryKey;
  }
  if (
    (completedSweep && nextAfterKey !== null) ||
    (!completedSweep &&
      (observations.length < 1 || nextAfterKey !== (observations.at(-1)?.entryKey ?? null)))
  ) {
    throw new TypeError("Artifact namespace scan cursor is inconsistent.");
  }
  return Object.freeze({
    scanSessionId: requireArtifactNamespaceScanSessionId(record.scanSessionId),
    sweepGeneration: snapshotArtifactNamespaceSweepGeneration(record.sweepGeneration),
    expectedAfterKey,
    observations,
    completedSweep,
    nextAfterKey,
  });
};

const normalizeNamespaceScanClosure = (value: unknown): CloseArtifactNamespaceScanResult => {
  const record = requireRecord(value, "Artifact namespace scan closure");
  requireExactKeys(record, ["scanSessionId", "sweepGeneration", "expectedAfterKey", "closed"]);
  if (record.closed !== true) {
    throw new TypeError("Artifact namespace scan closure is invalid.");
  }
  const input = snapshotCloseArtifactNamespaceScanInput({
    scanSessionId: record.scanSessionId,
    sweepGeneration: record.sweepGeneration,
    expectedAfterKey: record.expectedAfterKey,
  });
  return Object.freeze({ ...input, closed: true });
};

const normalizeNamespaceCleanupResult = (value: unknown): ArtifactNamespaceCleanupResult => {
  const record = requireRecord(value, "Artifact namespace cleanup result");
  requireExactKeys(record, ["entryKey", "observationSha256", "outcome"]);
  if (
    record.outcome !== "removed" &&
    record.outcome !== "already_absent" &&
    record.outcome !== "identity_changed"
  ) {
    throw new TypeError("Artifact namespace cleanup outcome is unsupported.");
  }
  return Object.freeze({
    entryKey: parseArtifactNamespaceEntryKey(record.entryKey).entryKey,
    observationSha256: requireArtifactNamespaceObservationSha256(record.observationSha256),
    outcome: record.outcome,
  });
};

export const normalizeArtifactStorageOperationOutput = <
  TOperation extends ArtifactStorageWorkerOperation,
>(
  operation: TOperation,
  value: unknown,
): ArtifactStorageWorkerOperationMap[TOperation]["output"] => {
  let normalized: ArtifactStorageWorkerOperationMap[ArtifactStorageWorkerOperation]["output"];
  switch (operation) {
    case "writePreparedChunk":
      normalized = normalizeDurableChunk(value);
      break;
    case "finalizeArtifact":
      normalized = normalizePublishedObject(value);
      break;
    case "readObject": {
      const record = requireRecord(value, "Artifact object read output");
      requireExactKeys(record, ["bytes"]);
      normalized = Object.freeze({
        bytes: copyBoundedBytes(record.bytes, maximumResultArtifactBytes, "Artifact object bytes"),
      });
      break;
    }
    case "cleanupUpload":
      normalized = normalizeCleanupOutput(value);
      break;
    case "scanNamespacePage":
      normalized = normalizeNamespaceScanPage(value);
      break;
    case "closeNamespaceScan":
      normalized = normalizeNamespaceScanClosure(value);
      break;
    case "cleanupNamespaceEntry":
      normalized = normalizeNamespaceCleanupResult(value);
      break;
    case "evaluateCapacity":
      normalized = normalizeCapacityAdmission(value);
      break;
    case "shutdown": {
      const record = requireRecord(value, "Artifact storage shutdown output");
      requireExactKeys(record, ["closed"]);
      if (record.closed !== true) {
        throw new TypeError("Artifact storage shutdown output is invalid.");
      }
      normalized = Object.freeze({ closed: true });
      break;
    }
    default:
      throw new TypeError("Artifact storage response operation is unsupported.");
  }
  return normalized as ArtifactStorageWorkerOperationMap[TOperation]["output"];
};

export const parseArtifactStorageWorkerMessage = (value: unknown): ArtifactStorageWorkerMessage => {
  const record = requireRecord(value, "Artifact storage Worker message");
  if (record.type === "ready") {
    requireExactKeys(record, ["type", "protocolVersion"]);
    if (record.protocolVersion !== artifactStorageProtocolVersion) {
      throw new TypeError("Artifact storage ready version is unsupported.");
    }
    return { type: "ready", protocolVersion: artifactStorageProtocolVersion };
  }
  if (record.type === "fatal") {
    requireExactKeys(record, ["type", "protocolVersion", "error"]);
    if (record.protocolVersion !== artifactStorageProtocolVersion) {
      throw new TypeError("Artifact storage fatal version is unsupported.");
    }
    return {
      type: "fatal",
      protocolVersion: artifactStorageProtocolVersion,
      error: normalizeWireError(record.error, false),
    };
  }
  if (record.type !== "response") {
    throw new TypeError("Artifact storage Worker message type is unsupported.");
  }
  requireExactKeys(
    record,
    ["type", "protocolVersion", "id", "operation", "ok"],
    record.ok === true ? ["output"] : ["error"],
  );
  if (record.protocolVersion !== artifactStorageProtocolVersion) {
    throw new TypeError("Artifact storage response version is unsupported.");
  }
  if (
    typeof record.operation !== "string" ||
    !workerOperations.has(record.operation as ArtifactStorageWorkerOperation)
  ) {
    throw new TypeError("Artifact storage response operation is unsupported.");
  }
  const id = requireSafeInteger(
    record.id,
    "Artifact storage response ID",
    1,
    maximumArtifactStorageRequestId,
  );
  const operation = record.operation as ArtifactStorageWorkerOperation;
  if (record.ok === true) {
    if (!Object.hasOwn(record, "output") || Object.hasOwn(record, "error")) {
      throw new TypeError("Artifact storage success response is malformed.");
    }
    return {
      type: "response",
      protocolVersion: artifactStorageProtocolVersion,
      id,
      operation,
      ok: true,
      output: normalizeArtifactStorageOperationOutput(operation, record.output),
    } as ArtifactStorageWorkerResponse;
  }
  if (record.ok !== false || !Object.hasOwn(record, "error") || Object.hasOwn(record, "output")) {
    throw new TypeError("Artifact storage failure response is malformed.");
  }
  return {
    type: "response",
    protocolVersion: artifactStorageProtocolVersion,
    id,
    operation,
    ok: false,
    error: normalizeWireError(record.error, operation === "evaluateCapacity"),
  } as ArtifactStorageWorkerResponse;
};
