import { createHash, timingSafeEqual } from "node:crypto";
import {
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunks,
} from "@agentic-review/contracts";
import {
  deriveArtifactCapacityAccounting,
  evaluateArtifactCapacity,
  snapshotArtifactCapacityAccounting,
  snapshotArtifactCapacityAdmissionRequest,
  snapshotArtifactCapacityEvaluationAccounting,
  snapshotArtifactCapacityLimits,
  snapshotArtifactFilesystemCapacity,
  snapshotArtifactStorageInventory,
} from "./capacity.js";
import {
  ArtifactStorageClosedError,
  ArtifactStorageCloseTimeoutError,
  ArtifactStorageIntegrityError,
} from "./errors.js";
import { KeyedFifo, SerialFifo } from "./fifo.js";
import {
  artifactObjectKey,
  requireArtifactByteCount,
  requireArtifactOperationId,
  requireArtifactSha256,
  requireArtifactUploadId,
} from "./names.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactCapacityAdmissionRequest,
  ArtifactCapacityEvaluationInput,
  ArtifactCapacityProbe,
  ArtifactCommittedChunkReceipt,
  ArtifactStorageDirectoryBinding,
  ArtifactStorageFileHandle,
  ArtifactStorageFileIdentity,
  ArtifactStorageKernelOptions,
  ArtifactStorageLayout,
  ArtifactStorageOperations,
  ArtifactUploadCleanupRequest,
  ArtifactUploadCleanupResult,
  DurableArtifactChunk,
  PreparedArtifactChunk,
  PreparedArtifactFinalization,
  PublishedArtifactObject,
} from "./types.js";

const defaultCloseTimeoutMilliseconds = 30_000;
const digestReadBufferBytes = 64 * 1024;

interface ValidatedArtifactUploadCleanupRequest {
  readonly uploadId: string;
  readonly publications: readonly {
    readonly finalizationId: string;
    readonly totalBytes: number;
    readonly sha256: string;
  }[];
}

interface ExistingPublicationState {
  readonly objectExists: boolean;
  readonly temporary:
    | {
        readonly identity: ArtifactStorageFileIdentity;
        readonly partial: boolean;
      }
    | undefined;
}

/**
 * This kernel contains synchronous filesystem calls and MUST run inside the dedicated storage
 * owner process. Fastify and the SQLite Worker communicate with it through an asynchronous adapter;
 * that adapter also owns the hard process watchdog for a blocked syscall.
 */
export class ArtifactStorageKernel {
  readonly #operations: ArtifactStorageOperations;
  readonly #layout: ArtifactStorageLayout;
  readonly #options: ArtifactStorageKernelOptions;
  readonly #uploadFifo = new KeyedFifo();
  readonly #objectFifo = new KeyedFifo();
  readonly #capacityFifo = new SerialFifo();
  readonly #inFlight = new Set<Promise<unknown>>();
  #state: "open" | "closing" | "closed" = "open";

  constructor(options: ArtifactStorageKernelOptions, operations: ArtifactStorageOperations) {
    const capacity = snapshotArtifactCapacityLimits(options.capacity);
    const closeTimeoutMilliseconds =
      options.closeTimeoutMilliseconds ?? defaultCloseTimeoutMilliseconds;
    if (!Number.isSafeInteger(closeTimeoutMilliseconds) || closeTimeoutMilliseconds < 1) {
      throw new TypeError("Artifact storage close timeout must be a positive integer.");
    }
    this.#options = Object.freeze({
      rootPath: options.rootPath,
      capacity,
      closeTimeoutMilliseconds,
    });
    this.#operations = operations;
    this.#layout = operations.initialize(this.#options.rootPath);
    operations.inspectManagedLayout(this.#layout, this.#options.capacity.hardEntries);
  }

  writePreparedChunk(input: PreparedArtifactChunk): Promise<DurableArtifactChunk> {
    this.#requireOpen();
    const validated = validatePreparedChunk(input);
    return this.#track(
      this.#uploadFifo.run(validated.uploadId, () => this.#writePreparedChunk(validated)),
    );
  }

  finalizeArtifact(input: PreparedArtifactFinalization): Promise<PublishedArtifactObject> {
    this.#requireOpen();
    const validated = validateFinalization(input);
    return this.#track(
      this.#uploadFifo.run(validated.uploadId, () =>
        this.#objectFifo.run(validated.sha256, () => this.#finalizeArtifact(validated)),
      ),
    );
  }

  readObject(input: { readonly sha256: string; readonly totalBytes: number }): Promise<Buffer> {
    this.#requireOpen();
    const sha256 = requireArtifactSha256(input.sha256);
    const totalBytes = requireArtifactByteCount(input.totalBytes, "Artifact object byte count");
    return this.#track(this.#objectFifo.run(sha256, () => this.#readObject(sha256, totalBytes)));
  }

  cleanupUpload(input: ArtifactUploadCleanupRequest): Promise<ArtifactUploadCleanupResult> {
    this.#requireOpen();
    const validated = validateCleanupRequest(input);
    return this.#track(
      this.#uploadFifo.run(validated.uploadId, () => this.#cleanupUpload(validated)),
    );
  }

  /** @internal Callback-based admission is test-only and must never cross the Worker RPC. */
  withCapacityAdmission<T>(
    request: ArtifactCapacityAdmissionRequest,
    probeCreate: () => Promise<ArtifactCapacityProbe<T>> | ArtifactCapacityProbe<T>,
    createDurableReservation: (admission: ArtifactCapacityAdmission) => Promise<T> | T,
  ): Promise<T> {
    this.#requireOpen();
    const requestSnapshot = snapshotArtifactCapacityAdmissionRequest(request);
    return this.#track(
      this.#capacityFifo.run(async () => {
        const probe = await probeCreate();
        const disposition = probe.disposition;
        if (disposition === "exact-replay") {
          return probe.result;
        }
        if (disposition !== "new") {
          throw new TypeError("Artifact capacity probe returned an unsupported disposition.");
        }
        const accountingSnapshot = snapshotArtifactCapacityAccounting(probe.accounting);
        const inventory = snapshotArtifactStorageInventory(
          this.#operations.inspectManagedLayout(this.#layout, this.#options.capacity.hardEntries),
        );
        const filesystem = snapshotArtifactFilesystemCapacity(
          this.#operations.filesystemCapacity(this.#layout),
        );
        const admission = evaluateArtifactCapacity(
          this.#options.capacity,
          accountingSnapshot,
          inventory,
          filesystem,
          requestSnapshot,
        );
        return createDurableReservation(admission);
      }),
    );
  }

  evaluateCapacity(input: ArtifactCapacityEvaluationInput): Promise<ArtifactCapacityAdmission> {
    this.#requireOpen();
    const requestSnapshot = snapshotArtifactCapacityAdmissionRequest(input.request);
    const evaluationAccountingSnapshot = snapshotArtifactCapacityEvaluationAccounting(
      input.accounting,
    );
    return this.#track(
      this.#capacityFifo.run(() => {
        const inventory = snapshotArtifactStorageInventory(
          this.#operations.inspectManagedLayout(this.#layout, this.#options.capacity.hardEntries),
        );
        const filesystem = snapshotArtifactFilesystemCapacity(
          this.#operations.filesystemCapacity(this.#layout),
        );
        const accountingSnapshot = deriveArtifactCapacityAccounting(
          evaluationAccountingSnapshot,
          filesystem,
          this.#options.capacity.perUploadMetadataHeadroomBytes,
        );
        return evaluateArtifactCapacity(
          this.#options.capacity,
          accountingSnapshot,
          inventory,
          filesystem,
          requestSnapshot,
        );
      }),
    );
  }

  async close(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closing";
    const timeoutMilliseconds =
      this.#options.closeTimeoutMilliseconds ?? defaultCloseTimeoutMilliseconds;
    const idle = Promise.allSettled([...this.#inFlight]);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        idle,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ArtifactStorageCloseTimeoutError(timeoutMilliseconds)),
            timeoutMilliseconds,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    if (this.#inFlight.size !== 0) {
      throw new ArtifactStorageCloseTimeoutError(timeoutMilliseconds);
    }
    this.#state = "closed";
  }

  #writePreparedChunk(input: PreparedArtifactChunk): DurableArtifactChunk {
    this.#inspectManagedLayout();
    const chunkBytes = toBuffer(input.bytes);
    const endOffset = input.offsetBytes + chunkBytes.byteLength;
    const createIfMissing = input.receiptState === "prepared" && input.offsetBytes === 0;
    const opened = this.#operations.openStagingFile(
      this.#layout,
      input.uploadId,
      input.receiptState === "prepared",
      createIfMissing,
    );
    if (opened === undefined) {
      throw new ArtifactStorageIntegrityError(
        "Artifact staging data is missing for its prepared database receipt.",
      );
    }

    return this.#usingFile(opened.file, () => {
      const size = this.#operations.fileSize(opened.file);
      if (size > maximumResultArtifactBytes) {
        throw new ArtifactStorageIntegrityError(
          "Artifact staging data exceeds the result artifact byte limit.",
        );
      }
      this.#requireCommittedPrefix(opened.file, input.committedPrefix);
      if (input.receiptState === "committed") {
        if (size < input.committedOffsetBytes || size < endOffset) {
          throw new ArtifactStorageIntegrityError(
            "Committed artifact chunk bytes are missing from staging storage.",
          );
        }
        this.#requireMatchingRange(opened.file, input.offsetBytes, chunkBytes);
        return {
          uploadId: input.uploadId,
          prepareId: input.prepareId,
          durableOffsetBytes: endOffset,
          replayed: true,
        };
      }

      if (size < input.offsetBytes || size > endOffset) {
        throw new ArtifactStorageIntegrityError(
          "Prepared artifact staging length does not match its database cursor.",
        );
      }
      const existingChunkBytes = size - input.offsetBytes;
      if (existingChunkBytes > 0) {
        this.#requireMatchingRange(
          opened.file,
          input.offsetBytes,
          chunkBytes.subarray(0, existingChunkBytes),
        );
      }
      if (size < endOffset) {
        this.#writeAll(
          opened.file,
          chunkBytes,
          existingChunkBytes,
          chunkBytes.byteLength - existingChunkBytes,
          size,
        );
      }
      if (this.#operations.fileSize(opened.file) !== endOffset) {
        throw new ArtifactStorageIntegrityError(
          "Prepared artifact staging write did not reach the exact expected length.",
        );
      }
      this.#operations.syncFile(opened.file);
      this.#operations.syncDirectory(this.#layout.staging);
      if (this.#operations.fileSize(opened.file) !== endOffset) {
        throw new ArtifactStorageIntegrityError(
          "Prepared artifact staging length changed after synchronization.",
        );
      }
      this.#requireMatchingRange(opened.file, input.offsetBytes, chunkBytes);
      return {
        uploadId: input.uploadId,
        prepareId: input.prepareId,
        durableOffsetBytes: endOffset,
        replayed: false,
      };
    });
  }

  #finalizeArtifact(input: PreparedArtifactFinalization): PublishedArtifactObject {
    this.#inspectManagedLayout();
    const openedStaging = this.#operations.openStagingFile(
      this.#layout,
      input.uploadId,
      false,
      false,
    );
    if (openedStaging === undefined) {
      throw new ArtifactStorageIntegrityError(
        "Artifact staging data is missing for its prepared finalization.",
      );
    }
    const bytes = this.#usingFile(openedStaging.file, () =>
      this.#readAndVerifyWholeFile(openedStaging.file, input.totalBytes, input.sha256),
    );

    const shard = this.#operations.getObjectShardDirectory(this.#layout, input.sha256, true);
    if (shard === undefined) {
      throw new ArtifactStorageIntegrityError("Artifact object shard could not be created.");
    }
    this.#operations.syncDirectory(shard.directory);
    this.#operations.syncDirectory(this.#layout.sha256);

    const existingTemporary = this.#operations.openPublicationTemporaryFile(
      this.#layout,
      shard.directory,
      input.uploadId,
      input.finalizationId,
      input.sha256,
      false,
    );
    const existing = this.#inspectExistingPublication(shard.directory, input, existingTemporary);
    if (existing.objectExists) {
      if (existing.temporary !== undefined) {
        this.#operations.syncDirectory(shard.directory);
        if (
          !this.#operations.unlinkPublicationTemporary(
            this.#layout,
            shard.directory,
            input.uploadId,
            input.finalizationId,
            input.sha256,
            existing.temporary.identity,
          )
        ) {
          throw new ArtifactStorageIntegrityError(
            "Artifact publication temporary disappeared during exact finalization recovery.",
          );
        }
        this.#operations.syncDirectory(shard.directory);
        this.#verifyPublishedObject(shard.directory, input);
      } else {
        this.#operations.syncDirectory(shard.directory);
      }
      return this.#publishedResult(input, true);
    }

    let temporaryIdentity: ArtifactStorageFileIdentity;
    if (existing.temporary !== undefined) {
      if (existing.temporary.partial) {
        if (
          !this.#operations.unlinkPublicationTemporary(
            this.#layout,
            shard.directory,
            input.uploadId,
            input.finalizationId,
            input.sha256,
            existing.temporary.identity,
          )
        ) {
          throw new ArtifactStorageIntegrityError(
            "Partial artifact publication temporary disappeared during recovery.",
          );
        }
        this.#operations.syncDirectory(shard.directory);
        temporaryIdentity = this.#createPublicationTemporary(shard.directory, input, bytes);
      } else {
        this.#operations.syncDirectory(shard.directory);
        temporaryIdentity = existing.temporary.identity;
      }
    } else {
      temporaryIdentity = this.#createPublicationTemporary(shard.directory, input, bytes);
    }

    const publication = this.#operations.publishTemporaryWithoutReplacement(
      this.#layout,
      shard.directory,
      input.uploadId,
      input.finalizationId,
      input.sha256,
      temporaryIdentity,
    );
    if (publication === "published") {
      this.#operations.syncDirectory(shard.directory);
    }
    const publishedObject = this.#operations.openObjectFile(
      this.#layout,
      shard.directory,
      input.sha256,
      publication === "published" ? temporaryIdentity : undefined,
    );
    if (publishedObject === undefined) {
      throw new ArtifactStorageIntegrityError(
        "Artifact CAS object is missing after no-replace publication.",
      );
    }
    this.#usingFile(publishedObject, () => {
      this.#readAndVerifyWholeFile(publishedObject, input.totalBytes, input.sha256);
    });
    if (
      !this.#operations.unlinkPublicationTemporary(
        this.#layout,
        shard.directory,
        input.uploadId,
        input.finalizationId,
        input.sha256,
        temporaryIdentity,
      )
    ) {
      throw new ArtifactStorageIntegrityError(
        "Artifact publication temporary disappeared before durable cleanup.",
      );
    }
    this.#operations.syncDirectory(shard.directory);
    this.#verifyPublishedObject(shard.directory, input);
    return this.#publishedResult(input, publication === "exists");
  }

  #inspectExistingPublication(
    shard: ArtifactStorageDirectoryBinding,
    input: PreparedArtifactFinalization,
    temporary: ReturnType<ArtifactStorageOperations["openPublicationTemporaryFile"]>,
  ): ExistingPublicationState {
    const inspectObject = (temporaryIdentity?: ArtifactStorageFileIdentity): boolean => {
      const object = this.#operations.openObjectFile(
        this.#layout,
        shard,
        input.sha256,
        temporaryIdentity,
      );
      if (object === undefined) {
        return false;
      }
      this.#usingFile(object, () => {
        this.#readAndVerifyWholeFile(object, input.totalBytes, input.sha256);
      });
      return true;
    };

    if (temporary === undefined) {
      return { objectExists: inspectObject(), temporary: undefined };
    }
    return this.#usingFile(temporary.file, () => {
      const objectExists = inspectObject(temporary.file.identity);
      const partial = this.#verifyOrClassifyPublicationTemporary(
        temporary.file,
        input.totalBytes,
        input.sha256,
      );
      if (!partial && temporary.file.writable) {
        this.#operations.syncFile(temporary.file);
      }
      return {
        objectExists,
        temporary: { identity: temporary.file.identity, partial },
      };
    });
  }

  #createPublicationTemporary(
    shard: ArtifactStorageDirectoryBinding,
    input: PreparedArtifactFinalization,
    bytes: Buffer,
  ): ArtifactStorageFileIdentity {
    const opened = this.#operations.openPublicationTemporaryFile(
      this.#layout,
      shard,
      input.uploadId,
      input.finalizationId,
      input.sha256,
      true,
    );
    if (opened === undefined) {
      throw new ArtifactStorageIntegrityError(
        "Artifact publication temporary could not be exclusively created.",
      );
    }
    if (!opened.created) {
      return this.#usingFile(opened.file, (): never => {
        throw new ArtifactStorageIntegrityError(
          "Artifact publication temporary appeared during exclusive creation.",
        );
      });
    }
    this.#usingFile(opened.file, () => {
      this.#writeAll(opened.file, bytes, 0, bytes.byteLength, 0);
      if (this.#operations.fileSize(opened.file) !== input.totalBytes) {
        throw new ArtifactStorageIntegrityError(
          "Artifact publication temporary has an unexpected size after copy.",
        );
      }
      this.#requireMatchingRange(opened.file, 0, bytes);
      this.#operations.syncFile(opened.file);
    });
    this.#operations.syncDirectory(shard);
    return opened.file.identity;
  }

  #verifyPublishedObject(
    shard: ArtifactStorageDirectoryBinding,
    input: PreparedArtifactFinalization,
  ): void {
    const object = this.#operations.openObjectFile(this.#layout, shard, input.sha256);
    if (object === undefined) {
      throw new ArtifactStorageIntegrityError("Artifact CAS object disappeared after publication.");
    }
    this.#usingFile(object, () => {
      this.#readAndVerifyWholeFile(object, input.totalBytes, input.sha256);
    });
  }

  #readObject(sha256: string, totalBytes: number): Buffer {
    this.#inspectManagedLayout();
    const shard = this.#operations.getObjectShardDirectory(this.#layout, sha256, false);
    if (shard === undefined) {
      throw new ArtifactStorageIntegrityError("Artifact CAS object shard does not exist.");
    }
    const object = this.#operations.openObjectFile(this.#layout, shard.directory, sha256);
    if (object === undefined) {
      throw new ArtifactStorageIntegrityError("Artifact CAS object does not exist.");
    }
    return this.#usingFile(object, () => this.#readAndVerifyWholeFile(object, totalBytes, sha256));
  }

  async #cleanupUpload(
    input: ValidatedArtifactUploadCleanupRequest,
  ): Promise<ArtifactUploadCleanupResult> {
    this.#inspectManagedLayout();
    let stagingRemoved = false;
    const staging = this.#operations.openStagingFile(this.#layout, input.uploadId, false, false);
    if (staging !== undefined) {
      this.#usingFile(staging.file, () => undefined);
      stagingRemoved = this.#operations.unlinkStaging(
        this.#layout,
        input.uploadId,
        staging.file.identity,
      );
    }
    this.#operations.syncDirectory(this.#layout.staging);
    if (staging !== undefined && !stagingRemoved) {
      throw new ArtifactStorageIntegrityError(
        "Artifact staging file disappeared before durable cleanup.",
      );
    }

    let publicationTemporariesRemoved = 0;
    for (const publication of input.publications) {
      publicationTemporariesRemoved += await this.#objectFifo.run(publication.sha256, () => {
        const shard = this.#operations.getObjectShardDirectory(
          this.#layout,
          publication.sha256,
          false,
        );
        if (shard === undefined) {
          this.#operations.syncDirectory(this.#layout.sha256);
          return 0;
        }
        const temporary = this.#operations.openPublicationTemporaryFile(
          this.#layout,
          shard.directory,
          input.uploadId,
          publication.finalizationId,
          publication.sha256,
          false,
        );
        if (temporary === undefined) {
          this.#operations.syncDirectory(shard.directory);
          return 0;
        }
        const temporaryIdentity = this.#usingFile(temporary.file, () => {
          if (temporary.file.allowedLinkCounts.includes(2n)) {
            const object = this.#operations.openObjectFile(
              this.#layout,
              shard.directory,
              publication.sha256,
              temporary.file.identity,
            );
            if (object === undefined) {
              throw new ArtifactStorageIntegrityError(
                "Linked artifact publication temporary has no immutable object twin.",
              );
            }
            this.#usingFile(object, () => {
              this.#readAndVerifyWholeFile(object, publication.totalBytes, publication.sha256);
            });
          }
          return temporary.file.identity;
        });
        const removed = this.#operations.unlinkPublicationTemporary(
          this.#layout,
          shard.directory,
          input.uploadId,
          publication.finalizationId,
          publication.sha256,
          temporaryIdentity,
        );
        this.#operations.syncDirectory(shard.directory);
        if (!removed) {
          throw new ArtifactStorageIntegrityError(
            "Artifact publication temporary disappeared before cleanup completed.",
          );
        }
        return 1;
      });
    }
    return { stagingRemoved, publicationTemporariesRemoved };
  }

  #verifyOrClassifyPublicationTemporary(
    file: ArtifactStorageFileHandle,
    totalBytes: number,
    sha256: string,
  ): boolean {
    const size = this.#operations.fileSize(file);
    if (size > totalBytes) {
      throw new ArtifactStorageIntegrityError(
        "Artifact publication temporary exceeds the prepared final size.",
      );
    }
    if (size < totalBytes) {
      return true;
    }
    this.#readAndVerifyWholeFile(file, totalBytes, sha256);
    return false;
  }

  #readAndVerifyWholeFile(
    file: ArtifactStorageFileHandle,
    totalBytes: number,
    sha256: string,
  ): Buffer {
    if (this.#operations.fileSize(file) !== totalBytes) {
      throw new ArtifactStorageIntegrityError(
        "Artifact storage file size does not match its authoritative metadata.",
      );
    }
    const bytes = Buffer.allocUnsafe(totalBytes);
    this.#readAll(file, bytes, 0, totalBytes, 0);
    if (this.#operations.fileSize(file) !== totalBytes) {
      throw new ArtifactStorageIntegrityError("Artifact storage file size changed while read.");
    }
    const actualDigest = createHash("sha256").update(bytes).digest();
    const expectedDigest = Buffer.from(requireArtifactSha256(sha256), "hex");
    if (!timingSafeEqual(actualDigest, expectedDigest)) {
      throw new ArtifactStorageIntegrityError(
        "Artifact storage file digest does not match its authoritative metadata.",
      );
    }
    return bytes;
  }

  #requireMatchingRange(
    file: ArtifactStorageFileHandle,
    fileOffset: number,
    expected: Buffer,
  ): void {
    const actual = Buffer.allocUnsafe(expected.byteLength);
    this.#readAll(file, actual, 0, actual.byteLength, fileOffset);
    if (!timingSafeEqual(actual, expected)) {
      throw new ArtifactStorageIntegrityError(
        "Artifact staging bytes do not match the immutable chunk receipt.",
      );
    }
  }

  #requireCommittedPrefix(
    file: ArtifactStorageFileHandle,
    receipts: readonly ArtifactCommittedChunkReceipt[],
  ): void {
    for (const receipt of receipts) {
      const bytes = Buffer.allocUnsafe(receipt.chunkBytes);
      this.#readAll(file, bytes, 0, bytes.byteLength, receipt.offsetBytes);
      const actualDigest = createHash("sha256").update(bytes).digest();
      const expectedDigest = Buffer.from(receipt.chunkSha256, "hex");
      if (!timingSafeEqual(actualDigest, expectedDigest)) {
        throw new ArtifactStorageIntegrityError(
          "Artifact staging committed prefix does not match its immutable receipts.",
        );
      }
    }
  }

  #readAll(
    file: ArtifactStorageFileHandle,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    fileOffset: number,
  ): void {
    let consumed = 0;
    while (consumed < length) {
      const bytesRead = this.#operations.read(
        file,
        buffer,
        bufferOffset + consumed,
        Math.min(length - consumed, digestReadBufferBytes),
        fileOffset + consumed,
      );
      if (bytesRead < 1 || bytesRead > Math.min(length - consumed, digestReadBufferBytes)) {
        throw new ArtifactStorageIntegrityError("Artifact storage file ended during bounded read.");
      }
      consumed += bytesRead;
    }
  }

  #writeAll(
    file: ArtifactStorageFileHandle,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    fileOffset: number,
  ): void {
    let written = 0;
    while (written < length) {
      const bytesWritten = this.#operations.write(
        file,
        buffer,
        bufferOffset + written,
        length - written,
        fileOffset + written,
      );
      if (bytesWritten < 1 || bytesWritten > length - written) {
        throw new ArtifactStorageIntegrityError("Artifact storage write made no forward progress.");
      }
      written += bytesWritten;
    }
  }

  #usingFile<T>(file: ArtifactStorageFileHandle, operation: () => T): T {
    let result: T | undefined;
    let completed = false;
    let operationError: unknown;
    try {
      result = operation();
      completed = true;
    } catch (error) {
      operationError = error;
    }

    let closeError: unknown;
    try {
      this.#operations.closeFile(file);
    } catch (error) {
      closeError = error;
    }
    if (operationError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [operationError, closeError],
        "Artifact file operation and descriptor close both failed.",
        { cause: operationError },
      );
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    if (closeError !== undefined) {
      throw closeError;
    }
    if (!completed) {
      throw new ArtifactStorageIntegrityError("Artifact file operation did not complete.");
    }
    return result as T;
  }

  #publishedResult(input: PreparedArtifactFinalization, reused: boolean): PublishedArtifactObject {
    return {
      uploadId: input.uploadId,
      finalizationId: input.finalizationId,
      storageObjectKey: artifactObjectKey(input.sha256),
      totalBytes: input.totalBytes,
      sha256: input.sha256,
      reused,
    };
  }

  #inspectManagedLayout(): void {
    this.#operations.inspectManagedLayout(this.#layout, this.#options.capacity.hardEntries);
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#inFlight.add(operation);
    void operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation),
    );
    return operation;
  }

  #requireOpen(): void {
    if (this.#state !== "open") {
      throw new ArtifactStorageClosedError();
    }
  }
}

const validatePreparedChunk = (input: PreparedArtifactChunk): PreparedArtifactChunk => {
  const uploadId = requireArtifactUploadId(input.uploadId);
  const prepareId = requireArtifactOperationId(input.prepareId, "Artifact chunk prepare ID");
  if (
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    input.chunkIndex >= maximumResultArtifactChunks
  ) {
    throw new TypeError(
      `Artifact chunk index must be between 0 and ${maximumResultArtifactChunks - 1}.`,
    );
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw new TypeError("Artifact chunk bytes must be a Uint8Array.");
  }
  const bytes = toBuffer(input.bytes);
  if (bytes.byteLength < 1 || bytes.byteLength > maximumResultArtifactChunkBytes) {
    throw new TypeError(
      `Artifact chunk bytes must contain 1 through ${maximumResultArtifactChunkBytes} bytes.`,
    );
  }
  if (!Number.isSafeInteger(input.offsetBytes) || input.offsetBytes < 0) {
    throw new TypeError("Artifact chunk offset must be a non-negative safe integer.");
  }
  const endOffset = input.offsetBytes + bytes.byteLength;
  if (!Number.isSafeInteger(endOffset) || endOffset > maximumResultArtifactBytes) {
    throw new TypeError("Artifact chunk range exceeds the result artifact byte limit.");
  }
  const chunkSha256 = requireArtifactSha256(input.chunkSha256);
  const actualDigest = createHash("sha256").update(bytes).digest();
  if (!timingSafeEqual(actualDigest, Buffer.from(chunkSha256, "hex"))) {
    throw new TypeError("Artifact chunk bytes do not match chunkSha256.");
  }
  if (
    !Number.isSafeInteger(input.committedOffsetBytes) ||
    input.committedOffsetBytes < 0 ||
    input.committedOffsetBytes > maximumResultArtifactBytes
  ) {
    throw new TypeError("Artifact committed offset must be a bounded safe integer.");
  }
  if (!Array.isArray(input.committedPrefix) || input.committedPrefix.length > 8) {
    throw new TypeError("Artifact committed prefix must contain at most eight receipts.");
  }
  let prefixOffset = 0;
  const committedPrefix = input.committedPrefix.map((receipt, index) => {
    if (receipt.chunkIndex !== index) {
      throw new TypeError("Artifact committed prefix chunk indices must be contiguous.");
    }
    if (receipt.offsetBytes !== prefixOffset) {
      throw new TypeError("Artifact committed prefix byte ranges must be contiguous.");
    }
    if (
      !Number.isSafeInteger(receipt.chunkBytes) ||
      receipt.chunkBytes < 1 ||
      receipt.chunkBytes > maximumResultArtifactChunkBytes
    ) {
      throw new TypeError("Artifact committed prefix chunk size is out of range.");
    }
    const nextOffset = prefixOffset + receipt.chunkBytes;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > maximumResultArtifactBytes) {
      throw new TypeError("Artifact committed prefix exceeds the artifact byte limit.");
    }
    const validatedReceipt = Object.freeze({
      chunkIndex: receipt.chunkIndex,
      offsetBytes: receipt.offsetBytes,
      chunkBytes: receipt.chunkBytes,
      chunkSha256: requireArtifactSha256(receipt.chunkSha256),
    });
    prefixOffset = nextOffset;
    return validatedReceipt;
  });
  if (prefixOffset !== input.committedOffsetBytes) {
    throw new TypeError("Artifact committed prefix must cover the committed staging cursor.");
  }
  if (input.receiptState === "prepared") {
    if (input.committedOffsetBytes !== input.offsetBytes) {
      throw new TypeError("A prepared chunk must begin at the committed staging cursor.");
    }
    if (input.chunkIndex !== committedPrefix.length) {
      throw new TypeError("A prepared chunk must follow the committed prefix.");
    }
  } else if (input.receiptState === "committed") {
    if (input.committedOffsetBytes < endOffset) {
      throw new TypeError("A committed chunk must be covered by the committed staging cursor.");
    }
    const matchingReceipt = committedPrefix[input.chunkIndex];
    if (
      matchingReceipt === undefined ||
      matchingReceipt.offsetBytes !== input.offsetBytes ||
      matchingReceipt.chunkBytes !== bytes.byteLength ||
      matchingReceipt.chunkSha256 !== chunkSha256
    ) {
      throw new TypeError("A committed chunk must match its committed prefix receipt.");
    }
  } else {
    throw new TypeError("Artifact chunk receipt state is unsupported.");
  }

  return Object.freeze({
    uploadId,
    prepareId,
    chunkIndex: input.chunkIndex,
    offsetBytes: input.offsetBytes,
    chunkSha256,
    bytes,
    receiptState: input.receiptState,
    committedOffsetBytes: input.committedOffsetBytes,
    committedPrefix: Object.freeze(committedPrefix),
  });
};

const validateFinalization = (input: PreparedArtifactFinalization): PreparedArtifactFinalization =>
  Object.freeze({
    uploadId: requireArtifactUploadId(input.uploadId),
    finalizationId: requireArtifactOperationId(input.finalizationId, "Artifact finalization ID"),
    totalBytes: requireArtifactByteCount(input.totalBytes, "Artifact finalization byte count"),
    sha256: requireArtifactSha256(input.sha256),
  });

const validateCleanupRequest = (
  input: ArtifactUploadCleanupRequest,
): ValidatedArtifactUploadCleanupRequest => {
  const uploadId = requireArtifactUploadId(input.uploadId);
  const publications = input.publications ?? [];
  if (publications.length > 8) {
    throw new TypeError("Artifact cleanup accepts at most eight publication temporaries.");
  }
  const identities = new Set<string>();
  const validated = publications.map((publication) => {
    const finalizationId = requireArtifactOperationId(
      publication.finalizationId,
      "Artifact cleanup finalization ID",
    );
    const sha256 = requireArtifactSha256(publication.sha256);
    const key = `${finalizationId}:${sha256}`;
    if (identities.has(key)) {
      throw new TypeError("Artifact cleanup publication targets must be unique.");
    }
    identities.add(key);
    return Object.freeze({
      finalizationId,
      totalBytes: requireArtifactByteCount(
        publication.totalBytes,
        "Artifact cleanup publication byte count",
      ),
      sha256,
    });
  });
  return Object.freeze({ uploadId, publications: Object.freeze(validated) });
};

const toBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes);
