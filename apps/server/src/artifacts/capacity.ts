import { ArtifactStorageCapacityError } from "./errors.js";
import { requireArtifactByteCount } from "./names.js";
import type {
  ArtifactCapacityAccounting,
  ArtifactCapacityAdmission,
  ArtifactCapacityAdmissionRequest,
  ArtifactCapacityEvaluationAccounting,
  ArtifactCapacityLimits,
  ArtifactFilesystemCapacity,
  ArtifactStorageInventory,
} from "./types.js";

export const artifactCapacityEntriesPerUpload = 4;
export const maximumArtifactCapacityLiveUploads = 4_096;

export const snapshotArtifactCapacityLimits = (
  limits: ArtifactCapacityLimits,
): ArtifactCapacityLimits => {
  const snapshot = Object.freeze({
    hardBytes: limits.hardBytes,
    hardEntries: limits.hardEntries,
    emergencyReserveBytes: limits.emergencyReserveBytes,
    perUploadMetadataHeadroomBytes: limits.perUploadMetadataHeadroomBytes,
    cleanupBacklogHighWaterEntries: limits.cleanupBacklogHighWaterEntries,
  });
  validateArtifactCapacityLimits(snapshot);
  return snapshot;
};

export const snapshotArtifactCapacityAdmissionRequest = (
  request: ArtifactCapacityAdmissionRequest,
): Readonly<Required<ArtifactCapacityAdmissionRequest>> => {
  const expectedTotalBytes = requireArtifactByteCount(
    request.expectedTotalBytes,
    "Artifact expected total bytes",
  );
  const configuredRequiredEntries = request.requiredEntries;
  const requiredEntries =
    configuredRequiredEntries === undefined
      ? artifactCapacityEntriesPerUpload
      : configuredRequiredEntries;
  requireNonNegativeSafeInteger(requiredEntries, "Artifact required entries", false);
  if (requiredEntries < artifactCapacityEntriesPerUpload) {
    throw new TypeError(
      `Artifact required entries must reserve at least ${artifactCapacityEntriesPerUpload} ` +
        "managed entries.",
    );
  }
  return Object.freeze({ expectedTotalBytes, requiredEntries });
};

export const snapshotArtifactCapacityEvaluationAccounting = (
  accounting: ArtifactCapacityEvaluationAccounting,
): ArtifactCapacityEvaluationAccounting => {
  const accountingCertain = accounting.accountingCertain;
  const liveUploadCount = accounting.liveUploadCount;
  const untrustedBuckets = accounting.liveUploadExpectedByteSizeBuckets;
  const cleanupBacklogEntries = accounting.cleanupBacklogEntries;
  if (typeof accountingCertain !== "boolean") {
    throw new TypeError("Artifact accounting certainty must be boolean.");
  }
  requireNonNegativeSafeInteger(liveUploadCount, "Artifact live upload count", true);
  if (liveUploadCount > maximumArtifactCapacityLiveUploads) {
    throw new TypeError("Artifact live upload count exceeds its bounded representation.");
  }
  if (
    !Array.isArray(untrustedBuckets) ||
    untrustedBuckets.length > maximumArtifactCapacityLiveUploads
  ) {
    throw new TypeError("Artifact live upload byte-size buckets must be a bounded array.");
  }
  requireNonNegativeSafeInteger(cleanupBacklogEntries, "Artifact cleanup backlog entries", true);

  let representedUploadCount = 0;
  let previousExpectedTotalBytes = 0;
  const buckets: { readonly expectedTotalBytes: number; readonly uploadCount: number }[] = [];
  for (let index = 0; index < untrustedBuckets.length; index += 1) {
    if (!Object.hasOwn(untrustedBuckets, index)) {
      throw new TypeError("Artifact live upload byte-size buckets must not contain holes.");
    }
    const bucket = untrustedBuckets[index];
    if (typeof bucket !== "object" || bucket === null) {
      throw new TypeError("Artifact live upload byte-size bucket is invalid.");
    }
    const expectedTotalBytes = requireArtifactByteCount(
      bucket.expectedTotalBytes,
      "Artifact live upload expected byte size",
    );
    const uploadCount = bucket.uploadCount;
    requireNonNegativeSafeInteger(uploadCount, "Artifact live upload bucket count", false);
    if (
      uploadCount > maximumArtifactCapacityLiveUploads ||
      representedUploadCount > maximumArtifactCapacityLiveUploads - uploadCount
    ) {
      throw new TypeError(
        "Artifact live upload bucket counts exceed their bounded representation.",
      );
    }
    if (expectedTotalBytes <= previousExpectedTotalBytes) {
      throw new TypeError("Artifact live upload byte-size buckets must be strictly ordered.");
    }
    previousExpectedTotalBytes = expectedTotalBytes;
    representedUploadCount += uploadCount;
    buckets.push(Object.freeze({ expectedTotalBytes, uploadCount }));
  }
  if (representedUploadCount !== liveUploadCount) {
    throw new TypeError("Artifact live upload byte-size buckets do not match the upload count.");
  }
  return Object.freeze({
    accountingCertain,
    liveUploadCount,
    liveUploadExpectedByteSizeBuckets: Object.freeze(buckets),
    cleanupBacklogEntries,
  });
};

export const deriveArtifactCapacityAccounting = (
  accounting: ArtifactCapacityEvaluationAccounting,
  filesystem: ArtifactFilesystemCapacity,
  metadataHeadroomBytes: bigint,
): ArtifactCapacityAccounting => {
  const accountingSnapshot = snapshotArtifactCapacityEvaluationAccounting(accounting);
  const filesystemSnapshot = snapshotArtifactFilesystemCapacity(filesystem);
  if (typeof metadataHeadroomBytes !== "bigint" || metadataHeadroomBytes < 0n) {
    throw new TypeError("Artifact metadata headroom must be non-negative.");
  }
  let outstandingReservationBytes = 0n;
  for (const bucket of accountingSnapshot.liveUploadExpectedByteSizeBuckets) {
    outstandingReservationBytes +=
      calculateArtifactReservationBytes(
        bucket.expectedTotalBytes,
        filesystemSnapshot,
        metadataHeadroomBytes,
      ) * BigInt(bucket.uploadCount);
  }
  return Object.freeze({
    accountingCertain: accountingSnapshot.accountingCertain,
    outstandingReservationBytes,
    outstandingReservationEntries:
      accountingSnapshot.liveUploadCount * artifactCapacityEntriesPerUpload,
    cleanupBacklogEntries: accountingSnapshot.cleanupBacklogEntries,
  });
};

export const snapshotArtifactCapacityAccounting = (
  accounting: ArtifactCapacityAccounting,
): ArtifactCapacityAccounting => {
  const snapshot = Object.freeze({
    accountingCertain: accounting.accountingCertain,
    outstandingReservationBytes: accounting.outstandingReservationBytes,
    outstandingReservationEntries: accounting.outstandingReservationEntries,
    cleanupBacklogEntries: accounting.cleanupBacklogEntries,
  });
  if (typeof snapshot.accountingCertain !== "boolean") {
    throw new TypeError("Artifact accounting certainty must be boolean.");
  }
  if (
    typeof snapshot.outstandingReservationBytes !== "bigint" ||
    snapshot.outstandingReservationBytes < 0n
  ) {
    throw new TypeError("Artifact outstanding reservation bytes must be non-negative.");
  }
  requireNonNegativeSafeInteger(
    snapshot.outstandingReservationEntries,
    "Artifact outstanding reservation entries",
    true,
  );
  requireNonNegativeSafeInteger(
    snapshot.cleanupBacklogEntries,
    "Artifact cleanup backlog entries",
    true,
  );
  return snapshot;
};

export const snapshotArtifactFilesystemCapacity = (
  filesystem: ArtifactFilesystemCapacity,
): ArtifactFilesystemCapacity => {
  const snapshot = Object.freeze({
    availableBytes: filesystem.availableBytes,
    allocationUnitBytes: filesystem.allocationUnitBytes,
  });
  if (typeof snapshot.availableBytes !== "bigint" || snapshot.availableBytes < 0n) {
    throw new TypeError("Artifact filesystem available bytes must be non-negative.");
  }
  if (typeof snapshot.allocationUnitBytes !== "bigint" || snapshot.allocationUnitBytes < 1n) {
    throw new TypeError("Artifact filesystem allocation unit must be positive.");
  }
  return snapshot;
};

export const snapshotArtifactStorageInventory = (
  inventory: ArtifactStorageInventory,
): ArtifactStorageInventory => {
  const snapshot = Object.freeze({
    allocatedBytes: inventory.allocatedBytes,
    entries: inventory.entries,
    immutableObjects: inventory.immutableObjects,
    publicationTemporaries: inventory.publicationTemporaries,
    stagingFiles: inventory.stagingFiles,
  });
  if (typeof snapshot.allocatedBytes !== "bigint" || snapshot.allocatedBytes < 0n) {
    throw new TypeError("Artifact physical allocated bytes must be non-negative.");
  }
  requireNonNegativeSafeInteger(snapshot.entries, "Artifact physical entries", true);
  requireNonNegativeSafeInteger(snapshot.immutableObjects, "Artifact immutable object count", true);
  requireNonNegativeSafeInteger(
    snapshot.publicationTemporaries,
    "Artifact publication temporary count",
    true,
  );
  requireNonNegativeSafeInteger(snapshot.stagingFiles, "Artifact staging file count", true);
  return snapshot;
};

export const validateArtifactCapacityLimits = (limits: ArtifactCapacityLimits): void => {
  if (typeof limits.hardBytes !== "bigint" || limits.hardBytes < 1n) {
    throw new TypeError("Artifact storage hardBytes must be positive.");
  }
  if (
    typeof limits.emergencyReserveBytes !== "bigint" ||
    limits.emergencyReserveBytes < 0n ||
    limits.emergencyReserveBytes >= limits.hardBytes
  ) {
    throw new TypeError(
      "Artifact storage emergencyReserveBytes must be non-negative and less than hardBytes.",
    );
  }
  if (
    typeof limits.perUploadMetadataHeadroomBytes !== "bigint" ||
    limits.perUploadMetadataHeadroomBytes < 0n
  ) {
    throw new TypeError("Artifact storage perUploadMetadataHeadroomBytes must be non-negative.");
  }
  requireNonNegativeSafeInteger(limits.hardEntries, "Artifact storage hardEntries", false);
  requireNonNegativeSafeInteger(
    limits.cleanupBacklogHighWaterEntries,
    "Artifact storage cleanupBacklogHighWaterEntries",
    true,
  );
};

export const evaluateArtifactCapacity = (
  limits: ArtifactCapacityLimits,
  accounting: ArtifactCapacityAccounting,
  inventory: ArtifactStorageInventory,
  filesystem: ArtifactFilesystemCapacity,
  request: ArtifactCapacityAdmissionRequest,
): ArtifactCapacityAdmission => {
  const limitSnapshot = snapshotArtifactCapacityLimits(limits);
  const requestSnapshot = snapshotArtifactCapacityAdmissionRequest(request);
  const accountingSnapshot = snapshotArtifactCapacityAccounting(accounting);
  const inventorySnapshot = snapshotArtifactStorageInventory(inventory);
  const filesystemSnapshot = snapshotArtifactFilesystemCapacity(filesystem);
  if (!accountingSnapshot.accountingCertain) {
    throw new ArtifactStorageCapacityError(
      "Artifact storage accounting is uncertain; new uploads are disabled.",
    );
  }
  if (accountingSnapshot.cleanupBacklogEntries > limitSnapshot.cleanupBacklogHighWaterEntries) {
    throw new ArtifactStorageCapacityError(
      "Artifact storage cleanup backlog exceeds its configured high-water mark.",
    );
  }

  const requiredBytes = calculateArtifactReservationBytes(
    requestSnapshot.expectedTotalBytes,
    filesystemSnapshot,
    limitSnapshot.perUploadMetadataHeadroomBytes,
  );
  const projectedChargedBytes =
    inventorySnapshot.allocatedBytes +
    accountingSnapshot.outstandingReservationBytes +
    requiredBytes;
  const projectedChargedEntries =
    inventorySnapshot.entries +
    accountingSnapshot.outstandingReservationEntries +
    requestSnapshot.requiredEntries;
  if (projectedChargedBytes > limitSnapshot.hardBytes) {
    throw new ArtifactStorageCapacityError(
      "Artifact storage hard byte capacity would be exceeded.",
    );
  }
  if (projectedChargedEntries > limitSnapshot.hardEntries) {
    throw new ArtifactStorageCapacityError(
      "Artifact storage hard entry capacity would be exceeded.",
    );
  }
  if (filesystemSnapshot.availableBytes < accountingSnapshot.outstandingReservationBytes) {
    throw new ArtifactStorageCapacityError(
      "Artifact outstanding reservations exceed filesystem availability.",
    );
  }
  const filesystemAvailableAfterReservationsBytes =
    filesystemSnapshot.availableBytes - accountingSnapshot.outstandingReservationBytes;
  if (
    filesystemAvailableAfterReservationsBytes < limitSnapshot.emergencyReserveBytes ||
    filesystemAvailableAfterReservationsBytes - limitSnapshot.emergencyReserveBytes < requiredBytes
  ) {
    throw new ArtifactStorageCapacityError("Artifact storage filesystem reserve would be crossed.");
  }

  return Object.freeze({
    requiredBytes,
    requiredEntries: requestSnapshot.requiredEntries,
    physicalAllocatedBytes: inventorySnapshot.allocatedBytes,
    physicalEntries: inventorySnapshot.entries,
    outstandingReservationBytes: accountingSnapshot.outstandingReservationBytes,
    outstandingReservationEntries: accountingSnapshot.outstandingReservationEntries,
    filesystemAvailableBytes: filesystemSnapshot.availableBytes,
    filesystemAvailableAfterReservationsBytes,
    filesystemAllocationUnitBytes: filesystemSnapshot.allocationUnitBytes,
    projectedChargedBytes,
    projectedChargedEntries,
  });
};

export const calculateArtifactReservationBytes = (
  expectedTotalBytes: number,
  filesystem: ArtifactFilesystemCapacity,
  metadataHeadroomBytes: bigint,
): bigint => {
  requireArtifactByteCount(expectedTotalBytes, "Artifact expected total bytes");
  const allocationUnitBytes = snapshotArtifactFilesystemCapacity(filesystem).allocationUnitBytes;
  if (typeof metadataHeadroomBytes !== "bigint" || metadataHeadroomBytes < 0n) {
    throw new TypeError("Artifact metadata headroom must be non-negative.");
  }
  const logicalBytes = BigInt(expectedTotalBytes);
  const allocatedCopyBytes =
    ((logicalBytes + allocationUnitBytes - 1n) / allocationUnitBytes) * allocationUnitBytes;
  return allocatedCopyBytes * 2n + metadataHeadroomBytes;
};

const requireNonNegativeSafeInteger = (value: number, name: string, allowZero: boolean): void => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
};
