export interface ArtifactStorageFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface ArtifactStorageDirectoryBinding {
  readonly path: string;
  readonly identity: ArtifactStorageFileIdentity;
  readonly device: bigint;
  readonly mode: bigint;
  readonly userId: bigint;
  readonly privateDirectory: boolean;
}

export interface ArtifactStorageLayout {
  readonly rootPath: string;
  readonly root: ArtifactStorageDirectoryBinding;
  readonly staging: ArtifactStorageDirectoryBinding;
  readonly objects: ArtifactStorageDirectoryBinding;
  readonly sha256: ArtifactStorageDirectoryBinding;
  readonly ancestors: readonly ArtifactStorageDirectoryBinding[];
}

export type ArtifactStorageFileKind = "staging" | "publication-temporary" | "object";

export interface ArtifactStorageFileHandle {
  readonly descriptor: number;
  readonly path: string;
  readonly parent: ArtifactStorageDirectoryBinding;
  readonly identity: ArtifactStorageFileIdentity;
  readonly device: bigint;
  readonly kind: ArtifactStorageFileKind;
  readonly allowedLinkCounts: readonly bigint[];
  readonly writable: boolean;
}

export interface ArtifactStorageOpenedFile {
  readonly file: ArtifactStorageFileHandle;
  readonly created: boolean;
}

export interface ArtifactStorageShardDirectory {
  readonly directory: ArtifactStorageDirectoryBinding;
  readonly created: boolean;
}

/**
 * Production callers MUST run these synchronous operations inside a dedicated storage Worker or
 * process. Fastify request handlers and the SQLite Worker must not invoke them directly. The
 * adapter owns the external hard watchdog because JavaScript cannot time out a blocked syscall.
 */
export interface ArtifactStorageOperations {
  initialize(rootPath: string): ArtifactStorageLayout;
  inspectManagedLayout(
    layout: ArtifactStorageLayout,
    maximumEntries: number,
  ): ArtifactStorageInventory;
  filesystemCapacity(layout: ArtifactStorageLayout): ArtifactFilesystemCapacity;
  getObjectShardDirectory(
    layout: ArtifactStorageLayout,
    sha256: string,
    createIfMissing: boolean,
  ): ArtifactStorageShardDirectory | undefined;
  openStagingFile(
    layout: ArtifactStorageLayout,
    uploadId: string,
    writable: boolean,
    createIfMissing: boolean,
  ): ArtifactStorageOpenedFile | undefined;
  openPublicationTemporaryFile(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    uploadId: string,
    finalizationId: string,
    sha256: string,
    createIfMissing: boolean,
  ): ArtifactStorageOpenedFile | undefined;
  openObjectFile(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    sha256: string,
    publicationTemporaryIdentity?: ArtifactStorageFileIdentity,
  ): ArtifactStorageFileHandle | undefined;
  fileSize(file: ArtifactStorageFileHandle): number;
  read(
    file: ArtifactStorageFileHandle,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    fileOffset: number,
  ): number;
  write(
    file: ArtifactStorageFileHandle,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    fileOffset: number,
  ): number;
  syncFile(file: ArtifactStorageFileHandle): void;
  syncDirectory(directory: ArtifactStorageDirectoryBinding): void;
  closeFile(file: ArtifactStorageFileHandle): void;
  publishTemporaryWithoutReplacement(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    uploadId: string,
    finalizationId: string,
    sha256: string,
    expectedTemporaryIdentity: ArtifactStorageFileIdentity,
  ): "published" | "exists";
  unlinkPublicationTemporary(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    uploadId: string,
    finalizationId: string,
    sha256: string,
    expectedIdentity: ArtifactStorageFileIdentity,
  ): boolean;
  unlinkStaging(
    layout: ArtifactStorageLayout,
    uploadId: string,
    expectedIdentity: ArtifactStorageFileIdentity,
  ): boolean;
}

export interface PreparedArtifactChunk {
  readonly uploadId: string;
  readonly prepareId: string;
  readonly chunkIndex: number;
  readonly offsetBytes: number;
  readonly chunkSha256: string;
  readonly bytes: Uint8Array;
  readonly receiptState: "prepared" | "committed";
  readonly committedOffsetBytes: number;
  /**
   * The DB adapter MUST query and supply every immutable committed receipt through
   * committedOffsetBytes. PrepareArtifactChunkResult does not currently carry this projection, so
   * artifact routes must not call the kernel until that adapter obligation is implemented.
   */
  readonly committedPrefix: readonly ArtifactCommittedChunkReceipt[];
}

export interface ArtifactCommittedChunkReceipt {
  readonly chunkIndex: number;
  readonly offsetBytes: number;
  readonly chunkBytes: number;
  readonly chunkSha256: string;
}

export interface DurableArtifactChunk {
  readonly uploadId: string;
  readonly prepareId: string;
  readonly durableOffsetBytes: number;
  readonly replayed: boolean;
}

export interface PreparedArtifactFinalization {
  readonly uploadId: string;
  readonly finalizationId: string;
  readonly totalBytes: number;
  readonly sha256: string;
}

export interface PublishedArtifactObject {
  readonly uploadId: string;
  readonly finalizationId: string;
  readonly storageObjectKey: string;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly reused: boolean;
}

export interface ArtifactPublicationCleanupTarget {
  readonly finalizationId: string;
  readonly totalBytes: number;
  readonly sha256: string;
}

export interface ArtifactUploadCleanupRequest {
  readonly uploadId: string;
  readonly publications?: readonly ArtifactPublicationCleanupTarget[];
}

export interface ArtifactUploadCleanupResult {
  readonly stagingRemoved: boolean;
  readonly publicationTemporariesRemoved: number;
}

export interface ArtifactCapacityLimits {
  readonly hardBytes: bigint;
  readonly hardEntries: number;
  readonly emergencyReserveBytes: bigint;
  readonly perUploadMetadataHeadroomBytes: bigint;
  readonly cleanupBacklogHighWaterEntries: number;
}

export interface ArtifactFilesystemCapacity {
  readonly availableBytes: bigint;
  readonly allocationUnitBytes: bigint;
}

export interface ArtifactStorageInventory {
  readonly allocatedBytes: bigint;
  readonly entries: number;
  readonly immutableObjects: number;
  readonly publicationTemporaries: number;
  readonly stagingFiles: number;
}

export interface ArtifactCapacityAccounting {
  readonly accountingCertain: boolean;
  /**
   * The DB adapter MUST sum durable, not-yet-allocated byte liabilities for every existing live
   * upload. The value must be re-read inside each serialized admission and survive restart.
   */
  readonly outstandingReservationBytes: bigint;
  /** Durable, not-yet-materialized entry liabilities for every existing live upload. */
  readonly outstandingReservationEntries: number;
  readonly cleanupBacklogEntries: number;
}

export interface ArtifactCapacityAdmissionRequest {
  readonly expectedTotalBytes: number;
  readonly requiredEntries?: number;
}

export interface ArtifactCapacityAdmission {
  readonly requiredBytes: bigint;
  readonly requiredEntries: number;
  readonly physicalAllocatedBytes: bigint;
  readonly physicalEntries: number;
  readonly outstandingReservationBytes: bigint;
  readonly outstandingReservationEntries: number;
  readonly filesystemAvailableBytes: bigint;
  readonly filesystemAvailableAfterReservationsBytes: bigint;
  readonly filesystemAllocationUnitBytes: bigint;
  readonly projectedChargedBytes: bigint;
  readonly projectedChargedEntries: number;
}

export type ArtifactCapacityProbe<T> =
  | { readonly disposition: "exact-replay"; readonly result: T }
  | { readonly disposition: "new"; readonly accounting: ArtifactCapacityAccounting };

export interface ArtifactStorageKernelOptions {
  readonly rootPath: string;
  readonly capacity: ArtifactCapacityLimits;
  /** Bounds asynchronous queue drain only; the dedicated storage watchdog owns syscall timeout. */
  readonly closeTimeoutMilliseconds?: number;
}
