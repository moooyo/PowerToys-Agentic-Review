import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ArtifactNamespaceCleanupResult,
  type ArtifactNamespaceObservation,
  calculateArtifactNamespaceObservationSha256,
  maximumArtifactNamespaceManifestEntries,
} from "../../dist/artifacts/artifact-namespace-contract.js";
import { ArtifactStorageKernel } from "../../dist/artifacts/artifact-storage.js";
import {
  ArtifactEntryBudget,
  visitBoundedArtifactEntries,
} from "../../dist/artifacts/bounded-scan.js";
import {
  calculateArtifactReservationBytes,
  deriveArtifactCapacityAccounting,
  evaluateArtifactCapacity,
} from "../../dist/artifacts/capacity.js";
import {
  ArtifactStorageCapacityError,
  ArtifactStorageClosedError,
  ArtifactStorageCloseTimeoutError,
  ArtifactStorageIntegrityError,
} from "../../dist/artifacts/errors.js";
import type {
  ArtifactFilesystemCapacity,
  ArtifactStorageDirectoryBinding,
  ArtifactStorageFileHandle,
  ArtifactStorageFileIdentity,
  ArtifactStorageInventory,
  ArtifactStorageLayout,
  ArtifactStorageOpenedFile,
  ArtifactStorageOperations,
  ArtifactStorageShardDirectory,
  PreparedArtifactChunk,
  PreparedArtifactFinalization,
} from "../../dist/artifacts/types.js";

const uploadId = "11111111-1111-4111-8111-111111111111";
const secondUploadId = "22222222-2222-4222-8222-222222222222";
const prepareId = "33333333-3333-4333-8333-333333333333";
const secondPrepareId = "44444444-4444-4444-8444-444444444444";
const finalizationId = "55555555-5555-4555-8555-555555555555";

interface FakeFile {
  bytes: Buffer;
  readonly identity: ArtifactStorageFileIdentity;
  links: number;
}

interface FakeHandleState {
  readonly file: FakeFile;
  readonly path: string;
}

class FakeArtifactStorageOperations implements ArtifactStorageOperations {
  readonly events: string[] = [];
  readonly files = new Map<string, FakeFile>();
  readonly handles = new Map<number, FakeHandleState>();
  readonly initializedRoots: string[] = [];
  readonly inspectedMaximumEntries: number[] = [];
  readonly layout: ArtifactStorageLayout;
  filesystemBytes = 1_000_000_000n;
  filesystemCapacityOverride: ArtifactFilesystemCapacity | undefined;
  inventoryOverride: ArtifactStorageInventory | undefined;
  namespaceManifest: readonly ArtifactNamespaceObservation[] = [];
  readonly namespaceScanLimits: {
    readonly maximumManifestEntries: number;
    readonly maximumTraversalEntries: number;
  }[] = [];
  namespaceCleanupOutcome: ArtifactNamespaceCleanupResult["outcome"] = "identity_changed";
  onFilesystemCapacity: (() => void) | undefined;
  onInitialize: (() => void) | undefined;
  failAt: string | undefined;
  failOpenObject = false;
  failReadKind: ArtifactStorageFileHandle["kind"] | undefined;
  racePublicationTemporaryOnCreate = false;
  #nextDescriptor = 10;
  #nextInode = 100n;
  #directorySyncCounts = new Map<string, number>();
  #shards = new Map<string, ArtifactStorageDirectoryBinding>();

  constructor() {
    const root = this.#directory("/artifact");
    const staging = this.#directory("/artifact/staging");
    const objects = this.#directory("/artifact/objects");
    const sha256 = this.#directory("/artifact/objects/sha256");
    this.layout = { rootPath: root.path, root, staging, objects, sha256, ancestors: [] };
  }

  initialize(rootPath: string): ArtifactStorageLayout {
    this.initializedRoots.push(rootPath);
    this.onInitialize?.();
    return this.layout;
  }

  inspectManagedLayout(_layout: ArtifactStorageLayout, maximumEntries: number) {
    this.inspectedMaximumEntries.push(maximumEntries);
    return (
      this.inventoryOverride ?? {
        allocatedBytes: 0n,
        entries: this.files.size,
        immutableObjects: 0,
        publicationTemporaries: 0,
        stagingFiles: 0,
      }
    );
  }

  scanArtifactNamespace(
    _layout: ArtifactStorageLayout,
    maximumManifestEntries: number,
    maximumTraversalEntries: number,
  ): readonly ArtifactNamespaceObservation[] {
    this.namespaceScanLimits.push({ maximumManifestEntries, maximumTraversalEntries });
    return this.namespaceManifest;
  }

  cleanupArtifactNamespaceEntry(
    _layout: ArtifactStorageLayout,
    observation: ArtifactNamespaceObservation,
  ): ArtifactNamespaceCleanupResult {
    return {
      entryKey: observation.entryKey,
      observationSha256: observation.observationSha256,
      outcome: this.namespaceCleanupOutcome,
    };
  }

  filesystemCapacity(_layout: ArtifactStorageLayout) {
    this.#event("filesystem-capacity");
    this.onFilesystemCapacity?.();
    return (
      this.filesystemCapacityOverride ?? {
        availableBytes: this.filesystemBytes,
        allocationUnitBytes: 1n,
      }
    );
  }

  getObjectShardDirectory(
    _layout: ArtifactStorageLayout,
    sha256: string,
    createIfMissing: boolean,
  ): ArtifactStorageShardDirectory | undefined {
    const prefix = sha256.slice(0, 2);
    const existing = this.#shards.get(prefix);
    if (existing !== undefined) {
      return { directory: existing, created: false };
    }
    if (!createIfMissing) {
      return undefined;
    }
    const directory = this.#directory(`/artifact/objects/sha256/${prefix}`);
    this.#shards.set(prefix, directory);
    return { directory, created: true };
  }

  seedShard(sha256: string): void {
    const prefix = sha256.slice(0, 2);
    this.#shards.set(prefix, this.#directory(`/artifact/objects/sha256/${prefix}`));
  }

  openStagingFile(
    _layout: ArtifactStorageLayout,
    requestedUploadId: string,
    writable: boolean,
    createIfMissing: boolean,
  ): ArtifactStorageOpenedFile | undefined {
    const path = this.stagingPath(requestedUploadId);
    return this.#open(path, "staging", this.layout.staging, writable, createIfMissing);
  }

  openPublicationTemporaryFile(
    _layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    requestedUploadId: string,
    requestedFinalizationId: string,
    _sha256: string,
    createIfMissing: boolean,
  ): ArtifactStorageOpenedFile | undefined {
    const path = this.temporaryPath(shard, requestedUploadId, requestedFinalizationId);
    let existing = this.files.get(path);
    if (createIfMissing && existing === undefined && this.racePublicationTemporaryOnCreate) {
      existing = this.#file(Buffer.alloc(0));
      this.files.set(path, existing);
      this.racePublicationTemporaryOnCreate = false;
    }
    return this.#open(path, "publication-temporary", shard, existing?.links !== 2, createIfMissing);
  }

  openObjectFile(
    _layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    sha256: string,
    publicationTemporaryIdentity?: ArtifactStorageFileIdentity,
  ): ArtifactStorageFileHandle | undefined {
    if (this.failOpenObject) {
      throw new Error("injected object open failure");
    }
    const path = this.objectPath(shard, sha256);
    const file = this.files.get(path);
    if (file === undefined) {
      return undefined;
    }
    if (
      file.links !== 1 &&
      (file.links !== 2 ||
        publicationTemporaryIdentity === undefined ||
        publicationTemporaryIdentity.inode !== file.identity.inode)
    ) {
      throw new ArtifactStorageIntegrityError("fake object hard-link mismatch");
    }
    return this.#handle(path, "object", shard, false, file);
  }

  fileSize(file: ArtifactStorageFileHandle): number {
    return this.#state(file).file.bytes.byteLength;
  }

  read(
    file: ArtifactStorageFileHandle,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    fileOffset: number,
  ): number {
    if (this.failReadKind === file.kind) {
      throw new Error(`injected ${file.kind} read failure`);
    }
    const source = this.#state(file).file.bytes;
    const available = Math.max(0, Math.min(length, source.byteLength - fileOffset));
    source.copy(buffer, bufferOffset, fileOffset, fileOffset + available);
    return available;
  }

  write(
    file: ArtifactStorageFileHandle,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    fileOffset: number,
  ): number {
    this.#event(`write:${file.kind}:${fileOffset}:${length}`);
    const state = this.#state(file);
    const required = fileOffset + length;
    if (state.file.bytes.byteLength < required) {
      const expanded = Buffer.alloc(required);
      state.file.bytes.copy(expanded);
      state.file.bytes = expanded;
    }
    buffer.copy(state.file.bytes, fileOffset, bufferOffset, bufferOffset + length);
    return length;
  }

  syncFile(file: ArtifactStorageFileHandle): void {
    this.#event(`sync-file:${file.kind}`);
  }

  syncDirectory(directory: ArtifactStorageDirectoryBinding): void {
    const kind =
      directory.path === this.layout.staging.path
        ? "staging"
        : directory.path === this.layout.sha256.path
          ? "sha256-parent"
          : "shard";
    const count = (this.#directorySyncCounts.get(kind) ?? 0) + 1;
    this.#directorySyncCounts.set(kind, count);
    this.#event(`sync-directory:${kind}:${count}`);
  }

  closeFile(file: ArtifactStorageFileHandle): void {
    this.handles.delete(file.descriptor);
  }

  publishTemporaryWithoutReplacement(
    _layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    requestedUploadId: string,
    requestedFinalizationId: string,
    sha256: string,
    expectedTemporaryIdentity: ArtifactStorageFileIdentity,
  ): "published" | "exists" {
    this.#event("publish");
    const temporary = this.files.get(
      this.temporaryPath(shard, requestedUploadId, requestedFinalizationId),
    );
    if (temporary?.identity.inode !== expectedTemporaryIdentity.inode) {
      throw new ArtifactStorageIntegrityError("fake temporary identity mismatch");
    }
    const objectPath = this.objectPath(shard, sha256);
    if (this.files.has(objectPath)) {
      return "exists";
    }
    temporary.links += 1;
    this.files.set(objectPath, temporary);
    return "published";
  }

  unlinkPublicationTemporary(
    _layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    requestedUploadId: string,
    requestedFinalizationId: string,
    _sha256: string,
    expectedIdentity: ArtifactStorageFileIdentity,
  ): boolean {
    this.#event("unlink-temporary");
    const path = this.temporaryPath(shard, requestedUploadId, requestedFinalizationId);
    const file = this.files.get(path);
    if (file === undefined) {
      return false;
    }
    if (file.identity.inode !== expectedIdentity.inode) {
      throw new ArtifactStorageIntegrityError("fake temporary unlink identity mismatch");
    }
    file.links -= 1;
    this.files.delete(path);
    return true;
  }

  unlinkStaging(
    _layout: ArtifactStorageLayout,
    requestedUploadId: string,
    expectedIdentity: ArtifactStorageFileIdentity,
  ): boolean {
    this.#event("unlink-staging");
    const path = this.stagingPath(requestedUploadId);
    const file = this.files.get(path);
    if (file === undefined) {
      return false;
    }
    if (file.identity.inode !== expectedIdentity.inode) {
      throw new ArtifactStorageIntegrityError("fake staging unlink identity mismatch");
    }
    this.files.delete(path);
    return true;
  }

  seedStaging(requestedUploadId: string, bytes: Buffer): void {
    this.files.set(this.stagingPath(requestedUploadId), this.#file(bytes));
  }

  seedObject(sha256: string, bytes: Buffer): void {
    this.seedShard(sha256);
    const shard = this.#shards.get(sha256.slice(0, 2));
    if (shard === undefined) {
      throw new Error("fake shard was not created");
    }
    this.files.set(this.objectPath(shard, sha256), this.#file(bytes));
  }

  stagingBytes(requestedUploadId: string): Buffer | undefined {
    return this.files.get(this.stagingPath(requestedUploadId))?.bytes;
  }

  objectBytes(sha256: string): Buffer | undefined {
    const shard = this.#shards.get(sha256.slice(0, 2));
    return shard === undefined ? undefined : this.files.get(this.objectPath(shard, sha256))?.bytes;
  }

  hasPublicationTemporary(
    sha256: string,
    requestedUploadId = uploadId,
    requestedFinalizationId = finalizationId,
  ): boolean {
    const shard = this.#shards.get(sha256.slice(0, 2));
    return (
      shard !== undefined &&
      this.files.has(this.temporaryPath(shard, requestedUploadId, requestedFinalizationId))
    );
  }

  stagingPath(requestedUploadId: string): string {
    return `/artifact/staging/${requestedUploadId}.upload`;
  }

  temporaryPath(
    shard: ArtifactStorageDirectoryBinding,
    requestedUploadId: string,
    requestedFinalizationId: string,
  ): string {
    return `${shard.path}/.publish-${requestedUploadId}-${requestedFinalizationId}.tmp`;
  }

  objectPath(shard: ArtifactStorageDirectoryBinding, sha256: string): string {
    return `${shard.path}/${sha256}`;
  }

  #open(
    path: string,
    kind: ArtifactStorageFileHandle["kind"],
    parent: ArtifactStorageDirectoryBinding,
    writable: boolean,
    createIfMissing: boolean,
  ): ArtifactStorageOpenedFile | undefined {
    let file = this.files.get(path);
    let created = false;
    if (file === undefined) {
      if (!createIfMissing) {
        return undefined;
      }
      file = this.#file(Buffer.alloc(0));
      this.files.set(path, file);
      created = true;
    }
    return { file: this.#handle(path, kind, parent, writable, file), created };
  }

  #handle(
    path: string,
    kind: ArtifactStorageFileHandle["kind"],
    parent: ArtifactStorageDirectoryBinding,
    writable: boolean,
    file: FakeFile,
  ): ArtifactStorageFileHandle {
    const descriptor = this.#nextDescriptor;
    this.#nextDescriptor += 1;
    this.handles.set(descriptor, { file, path });
    return {
      descriptor,
      path,
      parent,
      identity: file.identity,
      device: 1n,
      kind,
      allowedLinkCounts: [BigInt(file.links)],
      writable,
    };
  }

  #state(file: ArtifactStorageFileHandle): FakeHandleState {
    const state = this.handles.get(file.descriptor);
    if (state === undefined) {
      throw new Error("fake descriptor is closed");
    }
    return state;
  }

  #file(bytes: Buffer): FakeFile {
    const identity = { device: 1n, inode: this.#nextInode };
    this.#nextInode += 1n;
    return { bytes: Buffer.from(bytes), identity, links: 1 };
  }

  #directory(path: string): ArtifactStorageDirectoryBinding {
    const identity = { device: 1n, inode: this.#nextInode };
    this.#nextInode += 1n;
    return {
      path,
      identity,
      device: 1n,
      mode: 0o700n,
      userId: 1000n,
      privateDirectory: true,
    };
  }

  #event(event: string): void {
    this.events.push(event);
    if (this.failAt === event) {
      throw new Error(`injected failure at ${event}`);
    }
  }
}

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

const namespaceObservation = (ordinal: number): ArtifactNamespaceObservation => {
  const upload = `70000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;
  const identity = {
    entryKey: `staging/${upload}.upload`,
    kind: "staging" as const,
    uploadId: upload,
    finalizationId: null,
    linkedObjectSha256: null,
    observedBytes: ordinal,
    expectedLinkCount: 1 as const,
    fileDevice: "1",
    fileInode: String(ordinal + 10),
    fileCtimeNs: String(ordinal + 20),
    fileMode: "384",
    fileUid: "1000",
    parentDevice: "1",
    parentInode: "2",
    parentMode: "448",
    parentUid: "1000",
    linkedObjectDevice: null,
    linkedObjectInode: null,
    linkedObjectCtimeNs: null,
  };
  return {
    ...identity,
    observationSha256: calculateArtifactNamespaceObservationSha256(identity),
  };
};

const kernelOptions = (closeTimeoutMilliseconds = 1_000) => ({
  rootPath: "/artifact",
  closeTimeoutMilliseconds,
  capacity: {
    hardBytes: 100_000_000n,
    hardEntries: 1_000,
    emergencyReserveBytes: 10_000n,
    perUploadMetadataHeadroomBytes: 4_096n,
    cleanupBacklogHighWaterEntries: 100,
  },
});

const preparedChunk = (
  bytes: Buffer,
  overrides: Partial<PreparedArtifactChunk> = {},
): PreparedArtifactChunk => ({
  uploadId,
  prepareId,
  chunkIndex: 0,
  offsetBytes: 0,
  chunkSha256: sha256(bytes),
  bytes,
  receiptState: "prepared",
  committedOffsetBytes: 0,
  committedPrefix: [],
  ...overrides,
});

const committedReceipt = (bytes: Buffer, chunkIndex = 0, offsetBytes = 0) => ({
  chunkIndex,
  offsetBytes,
  chunkBytes: bytes.byteLength,
  chunkSha256: sha256(bytes),
});

const finalization = (bytes: Buffer): PreparedArtifactFinalization => ({
  uploadId,
  finalizationId,
  totalBytes: bytes.byteLength,
  sha256: sha256(bytes),
});

describe("ArtifactStorageKernel namespace scan sessions", () => {
  it("rejects an oversized manifest instead of reporting a truncated completed sweep", async () => {
    const operations = new FakeArtifactStorageOperations();
    operations.namespaceManifest = Array<ArtifactNamespaceObservation>(
      maximumArtifactNamespaceManifestEntries + 1,
    ).fill(namespaceObservation(1));
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    await expect(
      kernel.scanNamespacePage({
        scanSessionId: "80000000-0000-4000-8000-000000000010",
        sweepGeneration: 0,
        expectedAfterKey: null,
        maximumEntries: 8,
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await kernel.close();
  });

  it("paginates one immutable manifest and rejects replay, skipping, and concurrent scanners", async () => {
    const operations = new FakeArtifactStorageOperations();
    operations.namespaceManifest = Array.from({ length: 5 }, (_, index) =>
      namespaceObservation(index),
    );
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    const scanSessionId = "80000000-0000-4000-8000-000000000001";
    const firstOperation = kernel.scanNamespacePage({
      scanSessionId,
      sweepGeneration: 3,
      expectedAfterKey: null,
      maximumEntries: 2,
    });
    expect(() =>
      kernel.scanNamespacePage({
        scanSessionId: "80000000-0000-4000-8000-000000000005",
        sweepGeneration: 3,
        expectedAfterKey: null,
        maximumEntries: 2,
      }),
    ).toThrow(ArtifactStorageIntegrityError);
    const first = await firstOperation;
    expect(operations.namespaceScanLimits[0]).toEqual({
      maximumManifestEntries: maximumArtifactNamespaceManifestEntries,
      maximumTraversalEntries: kernelOptions().capacity.hardEntries,
    });
    expect(first).toMatchObject({
      completedSweep: false,
      nextAfterKey: first.observations[1]?.entryKey,
    });
    await expect(
      kernel.scanNamespacePage({
        scanSessionId,
        sweepGeneration: 3,
        expectedAfterKey: null,
        maximumEntries: 2,
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await expect(
      kernel.scanNamespacePage({
        scanSessionId,
        sweepGeneration: 3,
        expectedAfterKey: operations.namespaceManifest[3]?.entryKey ?? null,
        maximumEntries: 2,
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await expect(
      kernel.scanNamespacePage({
        scanSessionId: "80000000-0000-4000-8000-000000000002",
        sweepGeneration: 3,
        expectedAfterKey: first.nextAfterKey,
        maximumEntries: 2,
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    const second = await kernel.scanNamespacePage({
      scanSessionId,
      sweepGeneration: 3,
      expectedAfterKey: first.nextAfterKey,
      maximumEntries: 2,
    });
    const final = await kernel.scanNamespacePage({
      scanSessionId,
      sweepGeneration: 3,
      expectedAfterKey: second.nextAfterKey,
      maximumEntries: 2,
    });
    expect(final).toMatchObject({ completedSweep: true, nextAfterKey: null });
    expect(final.observations).toEqual([operations.namespaceManifest[4]]);
    await expect(
      kernel.scanNamespacePage({
        scanSessionId,
        sweepGeneration: 3,
        expectedAfterKey: null,
        maximumEntries: 2,
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);

    const resumed = await kernel.scanNamespacePage({
      scanSessionId: "80000000-0000-4000-8000-000000000003",
      sweepGeneration: 3,
      expectedAfterKey: operations.namespaceManifest[2]?.entryKey ?? null,
      maximumEntries: 2,
    });
    expect(resumed).toMatchObject({ completedSweep: true });
    expect(resumed.observations).toEqual(operations.namespaceManifest.slice(3));

    const closeSessionId = "80000000-0000-4000-8000-000000000004";
    const open = await kernel.scanNamespacePage({
      scanSessionId: closeSessionId,
      sweepGeneration: 4,
      expectedAfterKey: null,
      maximumEntries: 1,
    });
    await expect(
      kernel.closeNamespaceScan({
        scanSessionId: closeSessionId,
        sweepGeneration: 4,
        expectedAfterKey: open.nextAfterKey,
      }),
    ).resolves.toMatchObject({ closed: true });
    await expect(
      kernel.scanNamespacePage({
        scanSessionId: closeSessionId,
        sweepGeneration: 4,
        expectedAfterKey: open.nextAfterKey,
        maximumEntries: 1,
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await kernel.close();
  });
});

describe("bounded artifact directory scanning", () => {
  it("stops a large fake directory at the first entry beyond the hard budget and closes it", () => {
    let reads = 0;
    let visits = 0;
    let closes = 0;
    const budget = new ArtifactEntryBudget(8);

    expect(() =>
      visitBoundedArtifactEntries(
        {
          read: () => {
            reads += 1;
            return reads <= 1_000_000 ? `entry-${reads}` : null;
          },
          close: () => {
            closes += 1;
          },
        },
        budget,
        () => {
          visits += 1;
        },
      ),
    ).toThrow(/bounded scan budget/u);
    expect(reads).toBe(9);
    expect(visits).toBe(8);
    expect(closes).toBe(1);
  });

  it("preserves both a bounded scan failure and reader close failure", () => {
    const closeError = new Error("injected directory close failure");
    let thrown: unknown;
    try {
      visitBoundedArtifactEntries(
        {
          read: () => "entry",
          close: () => {
            throw closeError;
          },
        },
        new ArtifactEntryBudget(1),
        () => undefined,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[1]).toBe(closeError);
  });
});

describe("ArtifactStorageKernel chunk durability", () => {
  it("writes the exact prepared range before file and directory synchronization", async () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    const bytes = Buffer.from("chunk");

    await expect(kernel.writePreparedChunk(preparedChunk(bytes))).resolves.toEqual({
      uploadId,
      prepareId,
      durableOffsetBytes: bytes.byteLength,
      replayed: false,
    });
    expect(operations.stagingBytes(uploadId)).toEqual(bytes);
    expect(operations.events).toEqual([
      `write:staging:0:${bytes.byteLength}`,
      "sync-file:staging",
      "sync-directory:staging:1",
    ]);
    await kernel.close();
  });

  it("stops at every chunk durability fault boundary", async () => {
    const bytes = Buffer.from("chunk");
    const cases = [
      {
        failure: `write:staging:0:${bytes.byteLength}`,
        absent: ["sync-file:staging", "sync-directory:staging:1"],
      },
      {
        failure: "sync-file:staging",
        absent: ["sync-directory:staging:1"],
      },
      {
        failure: "sync-directory:staging:1",
        absent: [] as string[],
      },
    ];

    for (const testCase of cases) {
      const operations = new FakeArtifactStorageOperations();
      operations.failAt = testCase.failure;
      const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
      await expect(kernel.writePreparedChunk(preparedChunk(bytes))).rejects.toThrow(
        /injected failure/u,
      );
      expect(operations.events).toContain(testCase.failure);
      for (const event of testCase.absent) {
        expect(operations.events).not.toContain(event);
      }
      expect(operations.handles.size).toBe(0);
      await kernel.close();
    }
  });

  it("resumes a matching partial write and verifies committed replays without writing", async () => {
    const operations = new FakeArtifactStorageOperations();
    operations.seedStaging(uploadId, Buffer.from("ch"));
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    const bytes = Buffer.from("chunk");

    await kernel.writePreparedChunk(preparedChunk(bytes));
    expect(operations.stagingBytes(uploadId)).toEqual(bytes);
    expect(operations.events[0]).toBe(`write:staging:2:${bytes.byteLength - 2}`);

    operations.events.splice(0);
    await expect(
      kernel.writePreparedChunk(
        preparedChunk(bytes, {
          receiptState: "committed",
          committedOffsetBytes: bytes.byteLength,
          committedPrefix: [committedReceipt(bytes)],
        }),
      ),
    ).resolves.toMatchObject({ replayed: true });
    expect(operations.events).toEqual([]);

    operations.seedStaging(uploadId, Buffer.from("chunx"));
    await expect(
      kernel.writePreparedChunk(
        preparedChunk(bytes, {
          receiptState: "committed",
          committedOffsetBytes: bytes.byteLength,
          committedPrefix: [committedReceipt(bytes)],
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await kernel.close();
  });

  it("serializes independently prepared chunks for one upload in FIFO order", async () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    const first = Buffer.from("ab");
    const second = Buffer.from("cd");

    const firstWrite = kernel.writePreparedChunk(preparedChunk(first));
    const secondWrite = kernel.writePreparedChunk(
      preparedChunk(second, {
        prepareId: secondPrepareId,
        chunkIndex: 1,
        offsetBytes: first.byteLength,
        committedOffsetBytes: first.byteLength,
        committedPrefix: [committedReceipt(first)],
      }),
    );
    await expect(Promise.all([firstWrite, secondWrite])).resolves.toHaveLength(2);
    expect(operations.stagingBytes(uploadId)).toEqual(Buffer.from("abcd"));
    expect(operations.events.filter((event) => event.startsWith("write:"))).toEqual([
      "write:staging:0:2",
      "write:staging:2:2",
    ]);
    await kernel.close();
  });

  it("verifies every committed prefix receipt before appending a prepared chunk", async () => {
    const operations = new FakeArtifactStorageOperations();
    operations.seedStaging(uploadId, Buffer.from("ax"));
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    const committed = Buffer.from("ab");
    const next = Buffer.from("cd");

    await expect(
      kernel.writePreparedChunk(
        preparedChunk(next, {
          prepareId: secondPrepareId,
          chunkIndex: 1,
          offsetBytes: committed.byteLength,
          committedOffsetBytes: committed.byteLength,
          committedPrefix: [committedReceipt(committed)],
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    expect(operations.events.some((event) => event.startsWith("write:"))).toBe(false);
    await kernel.close();
  });

  it("rejects invalid prepared metadata before opening storage", () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    expect(() =>
      kernel.writePreparedChunk(
        preparedChunk(Buffer.from("chunk"), {
          uploadId: "../escape",
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      kernel.writePreparedChunk(
        preparedChunk(Buffer.from("chunk"), {
          chunkSha256: "0".repeat(64),
        }),
      ),
    ).toThrow(/chunkSha256/u);
    expect(operations.files.size).toBe(0);
  });
});

describe("ArtifactStorageKernel CAS publication", () => {
  it("durably publishes with link-no-replace and removes only the temporary link", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    operations.seedStaging(uploadId, bytes);
    operations.seedShard(input.sha256);
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);

    await expect(kernel.finalizeArtifact(input)).resolves.toEqual({
      ...input,
      storageObjectKey: `sha256/${input.sha256.slice(0, 2)}/${input.sha256}`,
      reused: false,
    });
    expect(operations.objectBytes(input.sha256)).toEqual(bytes);
    expect(operations.hasPublicationTemporary(input.sha256)).toBe(false);
    expect(operations.stagingBytes(uploadId)).toEqual(bytes);
    expect(operations.events).toEqual([
      "sync-directory:shard:1",
      "sync-directory:sha256-parent:1",
      `write:publication-temporary:0:${bytes.byteLength}`,
      "sync-file:publication-temporary",
      "sync-directory:shard:2",
      "publish",
      "sync-directory:shard:3",
      "unlink-temporary",
      "sync-directory:shard:4",
    ]);
    await kernel.close();
  });

  it("does not cross the temporary write, fsync, or publish failure boundaries", async () => {
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    const cases = [
      {
        failure: `write:publication-temporary:0:${bytes.byteLength}`,
        absent: ["sync-file:publication-temporary", "publish"],
      },
      {
        failure: "sync-file:publication-temporary",
        absent: ["publish"],
      },
      {
        failure: "publish",
        absent: ["sync-directory:shard:3", "unlink-temporary"],
      },
    ];

    for (const testCase of cases) {
      const operations = new FakeArtifactStorageOperations();
      operations.seedStaging(uploadId, bytes);
      operations.seedShard(input.sha256);
      operations.failAt = testCase.failure;
      const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
      await expect(kernel.finalizeArtifact(input)).rejects.toThrow(/injected failure/u);
      for (const event of testCase.absent) {
        expect(operations.events).not.toContain(event);
      }
      expect(operations.handles.size).toBe(0);
      await kernel.close();
    }
  });

  it("closes an existing temporary when object open or verification fails", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    operations.seedStaging(uploadId, bytes);
    operations.seedShard(input.sha256);
    operations.failAt = "publish";
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    await expect(kernel.finalizeArtifact(input)).rejects.toThrow(/injected failure/u);

    operations.failAt = undefined;
    operations.failOpenObject = true;
    await expect(kernel.finalizeArtifact(input)).rejects.toThrow(/object open failure/u);
    expect(operations.handles.size).toBe(0);
    operations.failOpenObject = false;
    await kernel.close();

    const linkedOperations = new FakeArtifactStorageOperations();
    linkedOperations.seedStaging(uploadId, bytes);
    linkedOperations.seedShard(input.sha256);
    linkedOperations.failAt = "sync-directory:shard:3";
    const linkedKernel = new ArtifactStorageKernel(kernelOptions(), linkedOperations);
    await expect(linkedKernel.finalizeArtifact(input)).rejects.toThrow(/injected failure/u);
    linkedOperations.failAt = undefined;
    linkedOperations.failReadKind = "object";
    await expect(linkedKernel.finalizeArtifact(input)).rejects.toThrow(/object read failure/u);
    expect(linkedOperations.handles.size).toBe(0);
    linkedOperations.failReadKind = undefined;
    await linkedKernel.close();
  });

  it("closes the file returned by an exclusive-create EEXIST race", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    operations.seedStaging(uploadId, bytes);
    operations.seedShard(input.sha256);
    operations.racePublicationTemporaryOnCreate = true;
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);

    await expect(kernel.finalizeArtifact(input)).rejects.toThrow(/appeared during exclusive/u);
    expect(operations.handles.size).toBe(0);
    await kernel.close();
  });

  it("recovers a published link after failure before its directory fsync", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    operations.seedStaging(uploadId, bytes);
    operations.seedShard(input.sha256);
    operations.failAt = "sync-directory:shard:3";
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);

    await expect(kernel.finalizeArtifact(input)).rejects.toThrow(/injected failure/u);
    expect(operations.objectBytes(input.sha256)).toEqual(bytes);
    expect(operations.hasPublicationTemporary(input.sha256)).toBe(true);

    operations.failAt = undefined;
    operations.events.splice(0);
    await expect(kernel.finalizeArtifact(input)).resolves.toMatchObject({ reused: true });
    expect(operations.hasPublicationTemporary(input.sha256)).toBe(false);
    expect(operations.events).toEqual([
      "sync-directory:shard:4",
      "sync-directory:sha256-parent:2",
      "sync-directory:shard:5",
      "unlink-temporary",
      "sync-directory:shard:6",
    ]);
    await kernel.close();
  });

  it("recovers complete and partial publication temporaries without replacing an object", async () => {
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    const completeOperations = new FakeArtifactStorageOperations();
    completeOperations.seedStaging(uploadId, bytes);
    completeOperations.seedShard(input.sha256);
    completeOperations.failAt = "publish";
    const completeKernel = new ArtifactStorageKernel(kernelOptions(), completeOperations);
    await expect(completeKernel.finalizeArtifact(input)).rejects.toThrow(/injected failure/u);
    completeOperations.failAt = undefined;
    await expect(completeKernel.finalizeArtifact(input)).resolves.toMatchObject({ reused: false });
    await completeKernel.close();

    const partialOperations = new FakeArtifactStorageOperations();
    partialOperations.seedStaging(uploadId, bytes);
    partialOperations.seedShard(input.sha256);
    const shard = partialOperations.getObjectShardDirectory(
      partialOperations.layout,
      input.sha256,
      false,
    );
    if (shard === undefined) {
      throw new Error("fake shard was not seeded");
    }
    const partialPath = partialOperations.temporaryPath(shard.directory, uploadId, finalizationId);
    partialOperations.files.set(partialPath, {
      bytes: bytes.subarray(0, 3),
      identity: { device: 1n, inode: 9_999n },
      links: 1,
    });
    const partialKernel = new ArtifactStorageKernel(kernelOptions(), partialOperations);
    await expect(partialKernel.finalizeArtifact(input)).resolves.toMatchObject({ reused: false });
    expect(partialOperations.objectBytes(input.sha256)).toEqual(bytes);
    expect(partialOperations.events).toContain("unlink-temporary");
    await partialKernel.close();
  });

  it("fully verifies an existing CAS value and never overwrites a corrupt object", async () => {
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    const operations = new FakeArtifactStorageOperations();
    operations.seedStaging(uploadId, bytes);
    operations.seedObject(input.sha256, bytes);
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);

    await expect(kernel.finalizeArtifact(input)).resolves.toMatchObject({ reused: true });
    expect(operations.events).not.toContain("publish");

    operations.seedObject(input.sha256, Buffer.from('{"no":true}'));
    await expect(kernel.finalizeArtifact(input)).rejects.toBeInstanceOf(
      ArtifactStorageIntegrityError,
    );
    expect(operations.objectBytes(input.sha256)).toEqual(Buffer.from('{"no":true}'));
    expect(operations.events).not.toContain("unlink-object");
    await kernel.close();
  });

  it("serializes different uploads that publish the same digest", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    operations.seedStaging(uploadId, bytes);
    operations.seedStaging(secondUploadId, bytes);
    operations.seedShard(input.sha256);
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);

    const results = await Promise.all([
      kernel.finalizeArtifact(input),
      kernel.finalizeArtifact({
        ...input,
        uploadId: secondUploadId,
        finalizationId: "66666666-6666-4666-8666-666666666666",
      }),
    ]);
    expect(results.map((result) => result.reused)).toEqual([false, true]);
    expect(operations.events.filter((event) => event === "publish")).toHaveLength(1);
    await kernel.close();
  });

  it("securely reads only the exact bounded object identity", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const digest = sha256(bytes);
    operations.seedObject(digest, bytes);
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);

    await expect(
      kernel.readObject({ sha256: digest, totalBytes: bytes.byteLength }),
    ).resolves.toEqual(bytes);
    await expect(
      kernel.readObject({ sha256: digest, totalBytes: bytes.byteLength - 1 }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await expect(
      kernel.readObject({ sha256: "0".repeat(64), totalBytes: bytes.byteLength }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await kernel.close();
  });

  it("cleanup removes staging and recognized temporaries but never the immutable object", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    operations.seedStaging(uploadId, bytes);
    operations.seedShard(input.sha256);
    operations.failAt = "sync-directory:shard:3";
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    await expect(kernel.finalizeArtifact(input)).rejects.toThrow(/injected failure/u);

    operations.failAt = undefined;
    await expect(
      kernel.cleanupUpload({
        uploadId,
        publications: [{ finalizationId, totalBytes: bytes.byteLength, sha256: input.sha256 }],
      }),
    ).resolves.toEqual({ stagingRemoved: true, publicationTemporariesRemoved: 1 });
    expect(operations.stagingBytes(uploadId)).toBeUndefined();
    expect(operations.hasPublicationTemporary(input.sha256)).toBe(false);
    expect(operations.objectBytes(input.sha256)).toEqual(bytes);
    await kernel.close();
  });

  it("retries staging directory durability after unlink succeeded but fsync failed", async () => {
    const operations = new FakeArtifactStorageOperations();
    operations.seedStaging(uploadId, Buffer.from("staging"));
    operations.failAt = "sync-directory:staging:1";
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);

    await expect(kernel.cleanupUpload({ uploadId })).rejects.toThrow(/injected failure/u);
    expect(operations.stagingBytes(uploadId)).toBeUndefined();
    expect(operations.handles.size).toBe(0);

    operations.failAt = undefined;
    await expect(kernel.cleanupUpload({ uploadId })).resolves.toEqual({
      stagingRemoved: false,
      publicationTemporariesRemoved: 0,
    });
    expect(operations.events).toContain("sync-directory:staging:2");
    await kernel.close();
  });

  it("retries temporary directory durability after unlink succeeded but fsync failed", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    operations.seedStaging(uploadId, bytes);
    operations.seedShard(input.sha256);
    operations.failAt = "sync-directory:shard:3";
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    await expect(kernel.finalizeArtifact(input)).rejects.toThrow(/injected failure/u);

    operations.failAt = "sync-directory:shard:4";
    await expect(
      kernel.cleanupUpload({
        uploadId,
        publications: [{ finalizationId, totalBytes: bytes.byteLength, sha256: input.sha256 }],
      }),
    ).rejects.toThrow(/injected failure/u);
    expect(operations.hasPublicationTemporary(input.sha256)).toBe(false);
    expect(operations.objectBytes(input.sha256)).toEqual(bytes);
    expect(operations.handles.size).toBe(0);

    operations.failAt = undefined;
    await expect(
      kernel.cleanupUpload({
        uploadId,
        publications: [{ finalizationId, totalBytes: bytes.byteLength, sha256: input.sha256 }],
      }),
    ).resolves.toEqual({ stagingRemoved: false, publicationTemporariesRemoved: 0 });
    expect(operations.events).toContain("sync-directory:shard:5");
    expect(operations.objectBytes(input.sha256)).toEqual(bytes);
    await kernel.close();
  });

  it("closes cleanup handles when linked object open fails", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from('{"ok":true}');
    const input = finalization(bytes);
    operations.seedStaging(uploadId, bytes);
    operations.seedShard(input.sha256);
    operations.failAt = "sync-directory:shard:3";
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    await expect(kernel.finalizeArtifact(input)).rejects.toThrow(/injected failure/u);

    operations.failAt = undefined;
    operations.failOpenObject = true;
    await expect(
      kernel.cleanupUpload({
        uploadId,
        publications: [{ finalizationId, totalBytes: bytes.byteLength, sha256: input.sha256 }],
      }),
    ).rejects.toThrow(/object open failure/u);
    expect(operations.handles.size).toBe(0);
    operations.failOpenObject = false;
    operations.failReadKind = "object";
    await expect(
      kernel.cleanupUpload({
        uploadId,
        publications: [{ finalizationId, totalBytes: bytes.byteLength, sha256: input.sha256 }],
      }),
    ).rejects.toThrow(/object read failure/u);
    expect(operations.handles.size).toBe(0);
    operations.failReadKind = undefined;
    await kernel.close();
  });

  it("synchronizes the sha256 parent when a cleanup shard is already absent", async () => {
    const operations = new FakeArtifactStorageOperations();
    const bytes = Buffer.from("missing shard");
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    await expect(
      kernel.cleanupUpload({
        uploadId,
        publications: [{ finalizationId, totalBytes: bytes.byteLength, sha256: sha256(bytes) }],
      }),
    ).resolves.toEqual({ stagingRemoved: false, publicationTemporariesRemoved: 0 });
    expect(operations.events).toContain("sync-directory:sha256-parent:1");
    await kernel.close();
  });
});

describe("artifact storage capacity admission", () => {
  const limits = {
    hardBytes: 20_000n,
    hardEntries: 20,
    emergencyReserveBytes: 1_000n,
    perUploadMetadataHeadroomBytes: 512n,
    cleanupBacklogHighWaterEntries: 5,
  } as const;
  const accounting = {
    accountingCertain: true,
    outstandingReservationBytes: 0n,
    outstandingReservationEntries: 0,
    cleanupBacklogEntries: 1,
  } as const;
  const inventory = {
    allocatedBytes: 2_000n,
    entries: 4,
    immutableObjects: 1,
    publicationTemporaries: 0,
    stagingFiles: 1,
  } as const;

  it("reads direct reservation calculator filesystem fields exactly once", () => {
    let availableByteReads = 0;
    let allocationUnitReads = 0;
    const filesystem = {
      get availableBytes() {
        availableByteReads += 1;
        return availableByteReads === 1 ? 10_000n : 0n;
      },
      get allocationUnitBytes() {
        allocationUnitReads += 1;
        return allocationUnitReads === 1 ? 4_096n : 1n;
      },
    };
    expect(calculateArtifactReservationBytes(1_000, filesystem, 512n)).toBe(8_704n);
    expect(availableByteReads).toBe(1);
    expect(allocationUnitReads).toBe(1);
  });

  it("snapshots filesystem and inventory getters before capacity check and use", () => {
    let allocatedByteReads = 0;
    let entryReads = 0;
    let availableByteReads = 0;
    let allocationUnitReads = 0;
    const admission = evaluateArtifactCapacity(
      limits,
      accounting,
      {
        get allocatedBytes() {
          allocatedByteReads += 1;
          return allocatedByteReads === 1 ? 2_000n : 99_999n;
        },
        get entries() {
          entryReads += 1;
          return entryReads === 1 ? 4 : 999;
        },
        immutableObjects: 1,
        publicationTemporaries: 0,
        stagingFiles: 1,
      },
      {
        get availableBytes() {
          availableByteReads += 1;
          return availableByteReads === 1 ? 10_000n : 0n;
        },
        get allocationUnitBytes() {
          allocationUnitReads += 1;
          return allocationUnitReads === 1 ? 4_096n : 1n;
        },
      },
      { expectedTotalBytes: 1_000 },
    );
    expect(admission).toMatchObject({
      requiredBytes: 8_704n,
      physicalAllocatedBytes: 2_000n,
      physicalEntries: 4,
      filesystemAvailableBytes: 10_000n,
      filesystemAllocationUnitBytes: 4_096n,
    });
    expect(allocatedByteReads).toBe(1);
    expect(entryReads).toBe(1);
    expect(availableByteReads).toBe(1);
    expect(allocationUnitReads).toBe(1);
  });

  it("charges simultaneous staging and publication space plus bounded entries", () => {
    expect(
      evaluateArtifactCapacity(
        limits,
        accounting,
        inventory,
        { availableBytes: 10_000n, allocationUnitBytes: 4_096n },
        { expectedTotalBytes: 1_000 },
      ),
    ).toEqual({
      requiredBytes: 8_704n,
      requiredEntries: 4,
      physicalAllocatedBytes: 2_000n,
      physicalEntries: 4,
      outstandingReservationBytes: 0n,
      outstandingReservationEntries: 0,
      filesystemAvailableBytes: 10_000n,
      filesystemAvailableAfterReservationsBytes: 10_000n,
      filesystemAllocationUnitBytes: 4_096n,
      projectedChargedBytes: 10_704n,
      projectedChargedEntries: 8,
    });
  });

  it("derives every durable live-upload reservation from canonical database buckets", () => {
    expect(
      deriveArtifactCapacityAccounting(
        {
          accountingCertain: true,
          liveUploadCount: 3,
          liveUploadExpectedByteSizeBuckets: [
            { expectedTotalBytes: 1_000, uploadCount: 2 },
            { expectedTotalBytes: 4_097, uploadCount: 1 },
          ],
          cleanupBacklogEntries: 1,
        },
        { availableBytes: 100_000n, allocationUnitBytes: 4_096n },
        512n,
      ),
    ).toEqual({
      accountingCertain: true,
      outstandingReservationBytes: 34_304n,
      outstandingReservationEntries: 12,
      cleanupBacklogEntries: 1,
    });
    expect(() =>
      deriveArtifactCapacityAccounting(
        {
          accountingCertain: true,
          liveUploadCount: 2,
          liveUploadExpectedByteSizeBuckets: [{ expectedTotalBytes: 1_000, uploadCount: 1 }],
          cleanupBacklogEntries: 0,
        },
        { availableBytes: 100_000n, allocationUnitBytes: 4_096n },
        512n,
      ),
    ).toThrow(/do not match/u);
  });

  it("fails closed for uncertain accounting, backlog, hard limits, and emergency reserve", () => {
    expect(() =>
      evaluateArtifactCapacity(
        limits,
        { ...accounting, accountingCertain: false },
        inventory,
        { availableBytes: 10_000n, allocationUnitBytes: 4_096n },
        { expectedTotalBytes: 1_000 },
      ),
    ).toThrow(ArtifactStorageCapacityError);
    expect(() =>
      evaluateArtifactCapacity(
        limits,
        { ...accounting, cleanupBacklogEntries: 6 },
        inventory,
        { availableBytes: 10_000n, allocationUnitBytes: 4_096n },
        { expectedTotalBytes: 1_000 },
      ),
    ).toThrow(/backlog/u);
    expect(() =>
      evaluateArtifactCapacity(
        limits,
        { ...accounting, outstandingReservationBytes: 12_000n },
        inventory,
        { availableBytes: 10_000n, allocationUnitBytes: 4_096n },
        { expectedTotalBytes: 1_000 },
      ),
    ).toThrow(/hard byte/u);
    expect(() =>
      evaluateArtifactCapacity(
        limits,
        { ...accounting, outstandingReservationEntries: 15 },
        inventory,
        { availableBytes: 10_000n, allocationUnitBytes: 4_096n },
        { expectedTotalBytes: 1_000 },
      ),
    ).toThrow(/hard entry/u);
    expect(() =>
      evaluateArtifactCapacity(
        limits,
        accounting,
        inventory,
        { availableBytes: 9_703n, allocationUnitBytes: 4_096n },
        { expectedTotalBytes: 1_000 },
      ),
    ).toThrow(/reserve/u);
  });

  it("deducts every outstanding durable reservation from filesystem availability", () => {
    expect(() =>
      evaluateArtifactCapacity(
        limits,
        {
          ...accounting,
          outstandingReservationBytes: 1_000n,
          outstandingReservationEntries: 4,
        },
        inventory,
        { availableBytes: 10_000n, allocationUnitBytes: 4_096n },
        { expectedTotalBytes: 1_000 },
      ),
    ).toThrow(/reserve/u);
  });

  it("serializes accounting, capacity probing, and durable reservation callbacks", async () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const sequence: string[] = [];
    const probeCreate = (name: string) => () => {
      sequence.push(`accounting:${name}`);
      return { disposition: "new" as const, accounting };
    };

    const first = kernel.withCapacityAdmission(
      { expectedTotalBytes: 1_000 },
      probeCreate("first"),
      async () => {
        sequence.push("admitted:first");
        firstEntered.resolve();
        await releaseFirst.promise;
        return "first";
      },
    );
    const second = kernel.withCapacityAdmission(
      { expectedTotalBytes: 1_000 },
      probeCreate("second"),
      () => {
        sequence.push("admitted:second");
        return "second";
      },
    );

    await firstEntered.promise;
    await Promise.resolve();
    expect(sequence).toEqual(["accounting:first", "admitted:first"]);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(sequence).toEqual([
      "accounting:first",
      "admitted:first",
      "accounting:second",
      "admitted:second",
    ]);
    await kernel.close();
  });

  it("returns an exact create replay before capacity rejection or reservation", async () => {
    const operations = new FakeArtifactStorageOperations();
    operations.filesystemBytes = 0n;
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    let reservationCalled = false;
    await expect(
      kernel.withCapacityAdmission(
        { expectedTotalBytes: 1_000 },
        () => ({ disposition: "exact-replay", result: "replayed" }),
        () => {
          reservationCalled = true;
          return "created";
        },
      ),
    ).resolves.toBe("replayed");
    expect(reservationCalled).toBe(false);
    expect(operations.events).not.toContain("filesystem-capacity");
    await kernel.close();
  });

  it("prevents sequential durable reservations from overselling the emergency reserve", async () => {
    const operations = new FakeArtifactStorageOperations();
    operations.filesystemBytes = 17_000n;
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    let durableReservationBytes = 0n;
    let durableReservationEntries = 0;
    let durableCreates = 0;
    const probeCreate = () => ({
      disposition: "new" as const,
      accounting: {
        accountingCertain: true,
        outstandingReservationBytes: durableReservationBytes,
        outstandingReservationEntries: durableReservationEntries,
        cleanupBacklogEntries: 0,
      },
    });
    const persistReservation = (admission: {
      readonly requiredBytes: bigint;
      readonly requiredEntries: number;
    }) => {
      durableReservationBytes += admission.requiredBytes;
      durableReservationEntries += admission.requiredEntries;
      durableCreates += 1;
      return durableCreates;
    };

    await expect(
      kernel.withCapacityAdmission({ expectedTotalBytes: 1_000 }, probeCreate, persistReservation),
    ).resolves.toBe(1);
    await expect(
      kernel.withCapacityAdmission({ expectedTotalBytes: 1_000 }, probeCreate, persistReservation),
    ).rejects.toBeInstanceOf(ArtifactStorageCapacityError);
    expect(durableCreates).toBe(1);
    await kernel.close();
  });

  it("snapshots database-shaped evaluation input before waiting in the capacity FIFO", async () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const first = kernel.withCapacityAdmission(
      { expectedTotalBytes: 1 },
      () => ({ disposition: "new", accounting }),
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
    );
    await firstEntered.promise;

    const request = { expectedTotalBytes: 1_000 };
    const bucket = { expectedTotalBytes: 1_000, uploadCount: 1 };
    const evaluationAccounting = {
      accountingCertain: true,
      liveUploadCount: 1,
      liveUploadExpectedByteSizeBuckets: [bucket],
      cleanupBacklogEntries: 0,
    };
    const evaluation = kernel.evaluateCapacity({ request, accounting: evaluationAccounting });
    request.expectedTotalBytes = 0;
    bucket.expectedTotalBytes = 0;
    bucket.uploadCount = 999;
    evaluationAccounting.liveUploadCount = 0;
    evaluationAccounting.liveUploadExpectedByteSizeBuckets.length = 0;

    releaseFirst.resolve();
    await first;
    await expect(evaluation).resolves.toMatchObject({
      requiredBytes: 6_096n,
      requiredEntries: 4,
      outstandingReservationBytes: 6_096n,
      outstandingReservationEntries: 4,
    });
    await kernel.close();
  });

  it("snapshots capacity options, queued requests, and returned accounting", async () => {
    const operations = new FakeArtifactStorageOperations();
    const options = kernelOptions();
    const kernel = new ArtifactStorageKernel(options, operations);
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const first = kernel.withCapacityAdmission(
      { expectedTotalBytes: 1 },
      () => ({
        disposition: "new",
        accounting: {
          accountingCertain: true,
          outstandingReservationBytes: 0n,
          outstandingReservationEntries: 0,
          cleanupBacklogEntries: 0,
        },
      }),
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
    );
    await firstEntered.promise;

    const request = { expectedTotalBytes: 1_000, requiredEntries: 4 };
    let accountingBytes = 0n;
    let accountingEntries = 0;
    let accountingByteReads = 0;
    const accounting = {
      accountingCertain: true,
      get outstandingReservationBytes() {
        accountingByteReads += 1;
        return accountingBytes;
      },
      get outstandingReservationEntries() {
        return accountingEntries;
      },
      cleanupBacklogEntries: 0,
    };
    let observedRequiredBytes: bigint | undefined;
    let observedRequiredEntries: number | undefined;
    let observedAccountingBytes: bigint | undefined;
    let admissionWasFrozen = false;
    const second = kernel.withCapacityAdmission(
      request,
      () => ({ disposition: "new", accounting }),
      (admission) => {
        observedRequiredBytes = admission.requiredBytes;
        observedRequiredEntries = admission.requiredEntries;
        observedAccountingBytes = admission.outstandingReservationBytes;
        admissionWasFrozen = Object.isFrozen(admission);
      },
    );
    request.expectedTotalBytes = 0;
    request.requiredEntries = 999;
    operations.onFilesystemCapacity = () => {
      options.capacity.hardBytes = 1n;
      options.capacity.perUploadMetadataHeadroomBytes = 99_999_999n;
      accountingBytes = 99_999_999n;
      accountingEntries = 999;
    };

    releaseFirst.resolve();
    await first;
    await expect(second).resolves.toBeUndefined();
    expect(observedRequiredBytes).toBe(6_096n);
    expect(observedRequiredEntries).toBe(4);
    expect(observedAccountingBytes).toBe(0n);
    expect(accountingByteReads).toBe(1);
    expect(admissionWasFrozen).toBe(true);
    await kernel.close();
  });

  it("uses the constructor snapshot after a reentrant storage initialization", async () => {
    const operations = new FakeArtifactStorageOperations();
    const options = kernelOptions();
    operations.onInitialize = () => {
      options.rootPath = "/caller-mutated-root";
      options.capacity.hardEntries = 1;
      options.capacity.hardBytes = 1n;
    };

    const kernel = new ArtifactStorageKernel(options, operations);
    expect(operations.initializedRoots).toEqual(["/artifact"]);
    expect(operations.inspectedMaximumEntries[0]).toBe(1_000);
    await kernel.close();
  });

  it("snapshots operation inventory and filesystem capacity before evaluation", async () => {
    const operations = new FakeArtifactStorageOperations();
    let allocatedBytes = 5_000n;
    let physicalEntries = 5;
    let inventoryReads = 0;
    let inventoryEntryReads = 0;
    operations.inventoryOverride = {
      get allocatedBytes() {
        inventoryReads += 1;
        return allocatedBytes;
      },
      get entries() {
        inventoryEntryReads += 1;
        return physicalEntries;
      },
      immutableObjects: 0,
      publicationTemporaries: 0,
      stagingFiles: 0,
    };
    let availableByteReads = 0;
    let allocationUnitReads = 0;
    operations.filesystemCapacityOverride = {
      get availableBytes() {
        availableByteReads += 1;
        return availableByteReads === 1 ? 1_000_000n : 0n;
      },
      get allocationUnitBytes() {
        allocationUnitReads += 1;
        return allocationUnitReads === 1 ? 4_096n : 1n;
      },
    };
    operations.onFilesystemCapacity = () => {
      allocatedBytes = 0n;
      physicalEntries = 0;
    };
    const options = kernelOptions();
    options.capacity.hardBytes = 13_000n;
    options.capacity.emergencyReserveBytes = 1_000n;
    const kernel = new ArtifactStorageKernel(options, operations);

    await expect(
      kernel.withCapacityAdmission(
        { expectedTotalBytes: 1_000 },
        () => ({
          disposition: "new",
          accounting: {
            accountingCertain: true,
            outstandingReservationBytes: 0n,
            outstandingReservationEntries: 0,
            cleanupBacklogEntries: 0,
          },
        }),
        () => undefined,
      ),
    ).rejects.toThrow(/hard byte/u);
    expect(inventoryReads).toBe(1);
    expect(inventoryEntryReads).toBe(1);
    expect(availableByteReads).toBe(1);
    expect(allocationUnitReads).toBe(1);
    await kernel.close();
  });

  it("reads the capacity probe discriminator exactly once", async () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    let dispositionReads = 0;
    let reservationCalled = false;
    const probe = {
      get disposition() {
        dispositionReads += 1;
        return dispositionReads === 1 ? "unsupported" : "new";
      },
      accounting: {
        accountingCertain: true,
        outstandingReservationBytes: 0n,
        outstandingReservationEntries: 0,
        cleanupBacklogEntries: 0,
      },
    } as unknown as {
      readonly disposition: "new";
      readonly accounting: {
        readonly accountingCertain: boolean;
        readonly outstandingReservationBytes: bigint;
        readonly outstandingReservationEntries: number;
        readonly cleanupBacklogEntries: number;
      };
    };

    await expect(
      kernel.withCapacityAdmission(
        { expectedTotalBytes: 1 },
        () => probe,
        () => {
          reservationCalled = true;
        },
      ),
    ).rejects.toThrow(/unsupported disposition/u);
    expect(dispositionReads).toBe(1);
    expect(reservationCalled).toBe(false);
    await kernel.close();
  });

  it("rejects invalid call-time capacity input before invoking the probe", async () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    let probeCalled = false;
    expect(() =>
      kernel.withCapacityAdmission(
        { expectedTotalBytes: 0 },
        () => {
          probeCalled = true;
          return {
            disposition: "new",
            accounting: {
              accountingCertain: true,
              outstandingReservationBytes: 0n,
              outstandingReservationEntries: 0,
              cleanupBacklogEntries: 0,
            },
          };
        },
        () => undefined,
      ),
    ).toThrow(TypeError);
    expect(probeCalled).toBe(false);
    await kernel.close();
  });
});

describe("ArtifactStorageKernel shutdown", () => {
  const accounting = {
    accountingCertain: true,
    outstandingReservationBytes: 0n,
    outstandingReservationEntries: 0,
    cleanupBacklogEntries: 0,
  } as const;

  it("rejects new work and waits for every already accepted operation", async () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(), operations);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operation = kernel.withCapacityAdmission(
      { expectedTotalBytes: 1 },
      () => ({ disposition: "new", accounting }),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;

    const closing = kernel.close();
    expect(() => kernel.readObject({ sha256: "0".repeat(64), totalBytes: 1 })).toThrow(
      ArtifactStorageClosedError,
    );
    release.resolve();
    await operation;
    await closing;
    await expect(kernel.close()).resolves.toBeUndefined();
  });

  it("bounds close waiting without reopening admission", async () => {
    const operations = new FakeArtifactStorageOperations();
    const kernel = new ArtifactStorageKernel(kernelOptions(5), operations);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operation = kernel.withCapacityAdmission(
      { expectedTotalBytes: 1 },
      () => ({ disposition: "new", accounting }),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    await expect(kernel.close()).rejects.toBeInstanceOf(ArtifactStorageCloseTimeoutError);
    expect(() =>
      kernel.withCapacityAdmission(
        { expectedTotalBytes: 1 },
        () => ({ disposition: "new", accounting }),
        () => undefined,
      ),
    ).toThrow(ArtifactStorageClosedError);
    release.resolve();
    await operation;
    await kernel.close();
  });
});
