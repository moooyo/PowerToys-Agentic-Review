import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CreateResultArtifactUploadRequest,
  FinalizeResultArtifactUploadRequest,
  ResultArtifactChunkRequest,
  TerminateResultArtifactUploadRequest,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactNamespaceObservation,
  type ArtifactNamespaceScanPageInput,
  calculateArtifactNamespaceObservationSha256,
} from "../../dist/artifacts/artifact-namespace-contract.js";
import {
  ArtifactTransactionCoordinator,
  type ArtifactTransactionCoordinatorOptions,
  type ArtifactTransactionDatabaseHandle,
  type ArtifactTransactionDatabaseOperation,
  type ArtifactTransactionOwnerLockHandle,
  type ArtifactTransactionStorageHandle,
  registerArtifactTransactionDatabaseHandle,
  registerArtifactTransactionOwnerLockHandle,
  registerArtifactTransactionStorageHandle,
} from "../../dist/artifacts/artifact-transaction-coordinator.js";
import {
  ArtifactUploadCreateCoordinator,
  registerArtifactUploadCreateDatabaseHandle,
} from "../../dist/artifacts/artifact-upload-create-coordinator.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactCapacityEvaluationInput,
  ArtifactCapacityLimits,
  ArtifactUploadCleanupRequest,
  DurableArtifactChunk,
  PreparedArtifactChunk,
  PreparedArtifactFinalization,
  PublishedArtifactObject,
} from "../../dist/artifacts/types.js";
import type {
  ArtifactHealthAccounting,
  CommitArtifactChunkResult,
  CommitArtifactFinalizeResult,
  CreateArtifactUploadInput,
  CreateArtifactUploadResult,
  PrepareArtifactChunkInput,
  PrepareArtifactChunkResult,
  PrepareArtifactFinalizeInput,
  PrepareArtifactFinalizeResult,
  ProbeArtifactUploadCreateResult,
  TerminateArtifactUploadInput,
  TerminateArtifactUploadResult,
} from "../../dist/database/artifacts.js";
import type { DatabaseOperationMap } from "../../dist/database/protocol.js";

type FakeArtifactTransactionDatabaseOwner = Parameters<
  typeof registerArtifactTransactionDatabaseHandle
>[1];
type FakeArtifactTransactionStorageOwner = Parameters<
  typeof registerArtifactTransactionStorageHandle
>[1];
type FakeArtifactTransactionOwnerLock = Parameters<
  typeof registerArtifactTransactionOwnerLockHandle
>[1];
type FakeArtifactUploadCreateDatabaseOwner = Parameters<
  typeof registerArtifactUploadCreateDatabaseHandle
>[1];

const attachArtifactTransactionDatabaseForTest = (
  owner: FakeArtifactTransactionDatabaseOwner,
): ArtifactTransactionDatabaseHandle => registerArtifactTransactionDatabaseHandle(owner, owner);

const attachArtifactTransactionStorageForTest = (
  owner: FakeArtifactTransactionStorageOwner,
): ArtifactTransactionStorageHandle => registerArtifactTransactionStorageHandle(owner, owner);

const attachArtifactTransactionOwnerLockForTest = (
  owner: FakeArtifactTransactionOwnerLock,
): ArtifactTransactionOwnerLockHandle => registerArtifactTransactionOwnerLockHandle(owner, owner);

const attachArtifactUploadCreateDatabaseForTest = (owner: FakeArtifactUploadCreateDatabaseOwner) =>
  registerArtifactUploadCreateDatabaseHandle(owner, owner);

const timestamp = "2026-09-02T00:00:00.000Z";
const leaseToken = "artifact-transaction-test-token".padEnd(32, "x");
const uploadId = "11111111-1111-4111-8111-111111111111";
const prepareId = "22222222-2222-4222-8222-222222222222";
const finalizationId = "33333333-3333-4333-8333-333333333333";
const clientArtifactId = "44444444-4444-4444-8444-444444444444";
const artifactBytes = Buffer.from("{}", "utf8");
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");

const leaseIdentity = {
  jobId: "job-artifact-transaction",
  runAttemptId: "run-artifact-transaction",
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  leaseToken,
  leaseGeneration: 1,
} as const;

const createRequest: CreateResultArtifactUploadRequest = {
  ...leaseIdentity,
  clientArtifactId,
  purpose: "result",
  name: "result.json",
  mediaType: "application/json",
  totalBytes: artifactBytes.byteLength,
  sha256: artifactSha256,
};

const chunkRequest: ResultArtifactChunkRequest = {
  ...leaseIdentity,
  chunkIndex: 0,
  offsetBytes: 0,
  chunkBytes: artifactBytes.byteLength,
  chunkSha256: artifactSha256,
  data: artifactBytes.toString("base64url"),
};

const finalizeRequest: FinalizeResultArtifactUploadRequest = {
  ...leaseIdentity,
  chunkCount: 1,
  totalBytes: artifactBytes.byteLength,
  sha256: artifactSha256,
};

const terminateRequest: TerminateResultArtifactUploadRequest = {
  ...leaseIdentity,
  state: "abandoned",
  reason: "client_abandoned",
};

const preparedChunkRecord = (
  input: PrepareArtifactChunkInput,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  uploadId: input.uploadId,
  prepareId,
  receiptState: "prepared",
  uploadState: "receiving",
  committedArtifact: null,
  replayed: false,
  chunkIndex: input.chunkIndex,
  offsetBytes: input.offsetBytes,
  chunkBytes: input.chunkBytes,
  chunkSha256: input.chunkSha256,
  committedNextChunkIndex: input.chunkIndex,
  committedOffsetBytes: input.offsetBytes,
  committedPrefix: [],
  preparedNextChunkIndex: input.chunkIndex + 1,
  preparedNextOffsetBytes: input.offsetBytes + input.chunkBytes,
  ...overrides,
});

const storageCapacity: ArtifactCapacityLimits = {
  hardBytes: 1_000_000_000n,
  hardEntries: 100_000,
  emergencyReserveBytes: 1_000n,
  perUploadMetadataHeadroomBytes: 0n,
  cleanupBacklogHighWaterEntries: 4_096,
};

const healthyAccounting = (): ArtifactHealthAccounting => ({
  activeUploads: { receiving: 0, finalizing: 0 },
  cleanup: {
    pending: 0,
    retryWaiting: 0,
    due: 0,
    completed: 0,
    failed: 0,
    invalidRetryIdentity: 0,
    oldestOutstandingAt: null,
  },
  namespaceCleanup: {
    pending: 0,
    retryWaiting: 0,
    due: 0,
    completed: 0,
    failed: 0,
    superseded: 0,
    oldestOutstandingAt: null,
    operationalSaturated: false,
    historicalSaturated: false,
  },
  capacity: {
    accountingCertain: true,
    liveUploadCount: 0,
    liveUploadExpectedByteSizeBuckets: [],
    cleanupBacklogEntries: 0,
  },
});

const capacityAdmission = (input: ArtifactCapacityEvaluationInput): ArtifactCapacityAdmission => {
  const requiredBytes = BigInt(input.request.expectedTotalBytes) * 2n;
  const outstandingReservationBytes = input.accounting.liveUploadExpectedByteSizeBuckets.reduce(
    (total, bucket) => total + BigInt(bucket.expectedTotalBytes) * 2n * BigInt(bucket.uploadCount),
    0n,
  );
  const outstandingReservationEntries = input.accounting.liveUploadCount * 4;
  const filesystemAvailableBytes = 1_000_000_000n;
  return {
    requiredBytes,
    requiredEntries: 4,
    physicalAllocatedBytes: 0n,
    physicalEntries: 0,
    outstandingReservationBytes,
    outstandingReservationEntries,
    filesystemAvailableBytes,
    filesystemAvailableAfterReservationsBytes:
      filesystemAvailableBytes - outstandingReservationBytes,
    filesystemAllocationUnitBytes: 1n,
    projectedChargedBytes: outstandingReservationBytes + requiredBytes,
    projectedChargedEntries: outstandingReservationEntries + 4,
  };
};

const namespaceObservation = (ordinal: number): ArtifactNamespaceObservation => {
  const namespaceUploadId = `70000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;
  const identity = {
    entryKey: `staging/${namespaceUploadId}.upload`,
    kind: "staging" as const,
    uploadId: namespaceUploadId,
    finalizationId: null,
    linkedObjectSha256: null,
    observedBytes: 1,
    expectedLinkCount: 1 as const,
    fileDevice: "1",
    fileInode: String(ordinal + 1),
    fileCtimeNs: "3",
    fileMode: "384",
    fileUid: "1000",
    parentDevice: "1",
    parentInode: "4",
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

type DatabaseHandler = (input: unknown) => unknown | Promise<unknown>;

class FakeDatabase implements FakeArtifactTransactionDatabaseOwner {
  readonly terminal = Promise.withResolvers<Error>();
  readonly terminalFailure = this.terminal.promise;
  readonly handlers = new Map<ArtifactTransactionDatabaseOperation, DatabaseHandler>();
  readonly inputs: Array<{
    readonly operation: ArtifactTransactionDatabaseOperation;
    readonly input: unknown;
  }> = [];
  health = healthyAccounting();
  namespaceSweepGeneration = 0;
  namespaceAfterKey: string | null = null;
  chunkReplayCommitted = false;
  finalizeReplayCommitted = false;
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async request<TOperation extends ArtifactTransactionDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    this.events.push(`db:${operation}`);
    this.inputs.push({ operation, input });
    const handler = this.handlers.get(operation);
    if (handler !== undefined) {
      return (await handler(input)) as DatabaseOperationMap[TOperation]["output"];
    }

    let output: unknown;
    switch (operation) {
      case "terminalizeInactiveArtifactUploads":
        output = { terminalized: [], hasMore: false };
        break;
      case "listDueArtifactCleanups":
      case "listDueArtifactNamespaceCleanups":
        output = { items: [], hasMore: false };
        break;
      case "readArtifactHealthAccounting":
        output = this.health;
        break;
      case "readArtifactReconciliationCursor":
        output = {
          name: "managed_namespace_v2",
          sweepGeneration: this.namespaceSweepGeneration,
          afterKey: this.namespaceAfterKey,
          updatedAt: timestamp,
          lastCompletedAt: this.namespaceSweepGeneration === 0 ? null : timestamp,
        };
        break;
      case "classifyArtifactNamespacePageAndAdvanceCursor": {
        const page =
          input as DatabaseOperationMap["classifyArtifactNamespacePageAndAdvanceCursor"]["input"];
        this.namespaceSweepGeneration += page.completedSweep ? 1 : 0;
        this.namespaceAfterKey = page.completedSweep
          ? null
          : (page.observations.at(-1)?.entryKey ?? null);
        output = {
          classifications: page.observations.map((observation) => ({
            entryKey: observation.entryKey,
            observationSha256: observation.observationSha256,
            disposition: "active_reference",
            reason: null,
            supersededPriorIntent: false,
          })),
          cursor: {
            name: "managed_namespace_v2",
            sweepGeneration: this.namespaceSweepGeneration,
            afterKey: this.namespaceAfterKey,
            updatedAt: timestamp,
            lastCompletedAt: page.completedSweep ? timestamp : null,
          },
        };
        break;
      }
      case "probeArtifactUploadCreate":
        output = {
          disposition: "new",
          accounting: {
            accountingCertain: true,
            liveUploadCount: 0,
            liveUploadExpectedByteSizeBuckets: [],
            cleanupBacklogEntries: 0,
          },
        };
        break;
      case "createArtifactUpload":
        output = {
          uploadId,
          state: "receiving",
          replayed: false,
          nextChunkIndex: 0,
          nextOffsetBytes: 0,
          maximumChunkBytes: 262_144,
          maximumChunkCount: 8,
        };
        break;
      case "prepareArtifactChunk":
        output = this.prepareChunk(input as DatabaseOperationMap["prepareArtifactChunk"]["input"]);
        break;
      case "commitArtifactChunk":
        output = this.commitChunk(input as DatabaseOperationMap["commitArtifactChunk"]["input"]);
        break;
      case "prepareArtifactFinalize":
        output = this.prepareFinalize(
          input as DatabaseOperationMap["prepareArtifactFinalize"]["input"],
        );
        break;
      case "commitArtifactFinalize":
        output = this.commitFinalize(
          input as DatabaseOperationMap["commitArtifactFinalize"]["input"],
        );
        break;
      case "terminateArtifactUpload": {
        const termination = input as TerminateArtifactUploadInput;
        output = {
          uploadId: termination.uploadId,
          state: termination.state,
          reason: termination.reason,
          terminatedAt: timestamp,
          replayed: false,
        } satisfies TerminateArtifactUploadResult;
        break;
      }
      default:
        throw new Error(`Unexpected artifact transaction database operation ${operation}.`);
    }
    return output as DatabaseOperationMap[TOperation]["output"];
  }

  close(): Promise<void> {
    this.events.push("database:close");
    return Promise.resolve();
  }

  probeArtifactUploadCreate(
    input: CreateArtifactUploadInput,
  ): Promise<ProbeArtifactUploadCreateResult> {
    return this.request("probeArtifactUploadCreate", input);
  }

  createArtifactUpload(input: CreateArtifactUploadInput): Promise<CreateArtifactUploadResult> {
    return this.request("createArtifactUpload", input);
  }

  private prepareChunk(input: PrepareArtifactChunkInput): PrepareArtifactChunkResult {
    const receipt = {
      chunkIndex: input.chunkIndex,
      offsetBytes: input.offsetBytes,
      chunkBytes: input.chunkBytes,
      chunkSha256: input.chunkSha256,
    };
    if (this.chunkReplayCommitted) {
      return {
        uploadId: input.uploadId,
        prepareId,
        receiptState: "committed",
        uploadState: "committed",
        committedArtifact: {
          totalBytes: artifactBytes.byteLength,
          sha256: artifactSha256,
        },
        replayed: true,
        ...receipt,
        committedNextChunkIndex: input.chunkIndex + 1,
        committedOffsetBytes: input.offsetBytes + input.chunkBytes,
        committedPrefix: [receipt],
        preparedNextChunkIndex: input.chunkIndex + 1,
        preparedNextOffsetBytes: input.offsetBytes + input.chunkBytes,
      };
    }
    return {
      uploadId: input.uploadId,
      prepareId,
      receiptState: "prepared",
      uploadState: "receiving",
      committedArtifact: null,
      replayed: false,
      ...receipt,
      committedNextChunkIndex: input.chunkIndex,
      committedOffsetBytes: input.offsetBytes,
      committedPrefix: [],
      preparedNextChunkIndex: input.chunkIndex + 1,
      preparedNextOffsetBytes: input.offsetBytes + input.chunkBytes,
    };
  }

  private commitChunk(
    input: DatabaseOperationMap["commitArtifactChunk"]["input"],
  ): CommitArtifactChunkResult {
    return {
      uploadId: input.uploadId,
      prepareId: input.prepareId,
      state: this.chunkReplayCommitted ? "committed" : "receiving",
      chunkIndex: input.chunkIndex,
      outcome: this.chunkReplayCommitted ? "replayed" : "accepted",
      nextChunkIndex: input.chunkIndex + 1,
      nextOffsetBytes: input.offsetBytes + input.chunkBytes,
    } as CommitArtifactChunkResult;
  }

  private prepareFinalize(input: PrepareArtifactFinalizeInput): PrepareArtifactFinalizeResult {
    return {
      uploadId: input.uploadId,
      finalizationId,
      artifactId: finalizationId,
      storageObjectKey: `sha256/${input.sha256.slice(0, 2)}/${input.sha256}`,
      state: this.finalizeReplayCommitted ? "committed" : "finalizing",
      replayed: this.finalizeReplayCommitted,
      chunkCount: input.chunkCount,
      totalBytes: input.totalBytes,
      sha256: input.sha256,
    };
  }

  private commitFinalize(
    input: DatabaseOperationMap["commitArtifactFinalize"]["input"],
  ): CommitArtifactFinalizeResult {
    return {
      state: "committed",
      replayed: this.finalizeReplayCommitted,
      artifact: {
        artifactId: input.finalizationId,
        uploadId: input.uploadId,
        clientArtifactId,
        jobId: input.jobId,
        runAttemptId: input.runAttemptId,
        purpose: "result",
        name: "result.json",
        mediaType: "application/json",
        totalBytes: input.totalBytes,
        sha256: input.sha256,
        storageObjectKey: input.storageObjectKey,
      },
    };
  }
}

type ScanHandler = (
  input: ArtifactNamespaceScanPageInput,
) => ReturnType<FakeArtifactTransactionStorageOwner["scanNamespacePage"]>;

class FakeStorage implements FakeArtifactTransactionStorageOwner {
  readonly exit = Promise.withResolvers<number>();
  readonly ownerExit = this.exit.promise;
  readonly terminal = Promise.withResolvers<Error>();
  readonly terminalFailure = this.terminal.promise;
  readonly events: string[];
  objectBytes = Buffer.from(artifactBytes);
  scanHandler: ScanHandler | undefined;
  writeHandler: ((input: PreparedArtifactChunk) => Promise<DurableArtifactChunk>) | undefined;
  scanCount = 0;

  constructor(events: string[] = []) {
    this.events = events;
  }

  evaluateCapacity(input: ArtifactCapacityEvaluationInput): Promise<ArtifactCapacityAdmission> {
    this.events.push("storage:evaluateCapacity");
    return Promise.resolve(capacityAdmission(input));
  }

  writePreparedChunk(input: PreparedArtifactChunk): Promise<DurableArtifactChunk> {
    this.events.push("storage:writePreparedChunk");
    if (this.writeHandler !== undefined) {
      return this.writeHandler(input);
    }
    return Promise.resolve({
      uploadId: input.uploadId,
      prepareId: input.prepareId,
      durableOffsetBytes: input.offsetBytes + input.bytes.byteLength,
      replayed: input.receiptState === "committed",
    });
  }

  finalizeArtifact(input: PreparedArtifactFinalization): Promise<PublishedArtifactObject> {
    this.events.push("storage:finalizeArtifact");
    return Promise.resolve({
      ...input,
      storageObjectKey: `sha256/${input.sha256.slice(0, 2)}/${input.sha256}`,
      reused: false,
    });
  }

  readObject(): Promise<Buffer> {
    this.events.push("storage:readObject");
    return Promise.resolve(Buffer.from(this.objectBytes));
  }

  cleanupUpload(_input: ArtifactUploadCleanupRequest) {
    this.events.push("storage:cleanupUpload");
    return Promise.resolve({ stagingRemoved: false, publicationTemporariesRemoved: 0 });
  }

  scanNamespacePage(input: ArtifactNamespaceScanPageInput) {
    this.events.push("storage:scanNamespacePage");
    this.scanCount += 1;
    if (this.scanHandler !== undefined) {
      return this.scanHandler(input);
    }
    return Promise.resolve({
      scanSessionId: input.scanSessionId,
      sweepGeneration: input.sweepGeneration,
      expectedAfterKey: input.expectedAfterKey,
      observations: [],
      completedSweep: true,
      nextAfterKey: null,
    });
  }

  closeNamespaceScan(
    input: Parameters<FakeArtifactTransactionStorageOwner["closeNamespaceScan"]>[0],
  ) {
    this.events.push("reconciliation:closeNamespaceScan");
    return Promise.resolve({ ...input, closed: true as const });
  }

  cleanupNamespaceEntry(
    input: Parameters<FakeArtifactTransactionStorageOwner["cleanupNamespaceEntry"]>[0],
  ) {
    this.events.push("storage:cleanupNamespaceEntry");
    return Promise.resolve({
      entryKey: input.entryKey,
      observationSha256: input.observationSha256,
      outcome: "identity_changed" as const,
    });
  }

  async close(): Promise<void> {
    this.events.push("storage:close");
    this.events.push("storage:exit");
    this.exit.resolve(0);
  }
}

class FakeOwnerLock {
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  close(): Promise<void> {
    this.events.push("owner-lock:close");
    return Promise.resolve();
  }
}

interface Harness {
  readonly events: string[];
  readonly database: FakeDatabase;
  readonly storage: FakeStorage;
  readonly ownerLock: FakeOwnerLock;
  readonly databaseHandle: ArtifactTransactionDatabaseHandle;
  readonly ownerLockHandle: ArtifactTransactionOwnerLockHandle;
  readonly storageHandle: ArtifactTransactionStorageHandle;
}

const createHarness = (events: string[] = []): Harness => {
  const database = new FakeDatabase(events);
  const storage = new FakeStorage(events);
  const ownerLock = new FakeOwnerLock(events);
  return {
    events,
    database,
    storage,
    ownerLock,
    databaseHandle: attachArtifactTransactionDatabaseForTest(database),
    ownerLockHandle: attachArtifactTransactionOwnerLockForTest(ownerLock),
    storageHandle: attachArtifactTransactionStorageForTest(storage),
  };
};

const coordinatorOptions = (
  harness: Harness,
  overrides: Partial<ArtifactTransactionCoordinatorOptions> = {},
): ArtifactTransactionCoordinatorOptions => ({
  database: harness.databaseHandle,
  storage: harness.storageHandle,
  databaseOwnerLock: harness.ownerLockHandle,
  storageCapacity,
  requestTimeoutMilliseconds: 5_000,
  closeTimeoutMilliseconds: 5_000,
  storageJoinTimeoutMilliseconds: 5_000,
  maximumPendingTransactions: 16,
  reconciliationBatchSize: 2,
  reconciliationMaximumNamespacePagesPerSession: 2,
  reconciliationIntervalMilliseconds: 60_000,
  reconciliationPassTimeoutMilliseconds: 5_000,
  reconciliationInitialRetryDelaySeconds: 30,
  reconciliationMaximumRetryDelaySeconds: 300,
  onFailStop: () => undefined,
  ...overrides,
});

const startReadyCoordinator = async (
  harness: Harness,
  overrides: Partial<ArtifactTransactionCoordinatorOptions> = {},
): Promise<ArtifactTransactionCoordinator> => {
  const coordinator = await ArtifactTransactionCoordinator.create(
    coordinatorOptions(harness, overrides),
  );
  await coordinator.ready;
  harness.events.length = 0;
  harness.database.inputs.length = 0;
  return coordinator;
};

const transactionEvents = (events: readonly string[]): string[] =>
  events.filter(
    (event) =>
      event === "storage:evaluateCapacity" ||
      event === "storage:writePreparedChunk" ||
      event === "storage:finalizeArtifact" ||
      event === "storage:readObject" ||
      event === "storage:cleanupUpload" ||
      event === "db:probeArtifactUploadCreate" ||
      event === "db:createArtifactUpload" ||
      event === "db:prepareArtifactChunk" ||
      event === "db:commitArtifactChunk" ||
      event === "db:prepareArtifactFinalize" ||
      event === "db:commitArtifactFinalize" ||
      event === "db:terminateArtifactUpload",
  );

describe("ArtifactTransactionCoordinator", () => {
  it("consumes opaque owner handles once and rejects forged handles", async () => {
    const harness = createHarness();
    expect(Reflect.ownKeys(harness.databaseHandle)).toEqual([]);
    expect(Reflect.ownKeys(harness.storageHandle)).toEqual([]);
    expect(Reflect.ownKeys(harness.ownerLockHandle)).toEqual([]);
    const coordinator = await startReadyCoordinator(harness);

    await expect(
      ArtifactTransactionCoordinator.create(coordinatorOptions(harness)),
    ).rejects.toThrow(/already consumed or forged/u);

    const storageRetryDatabase = createHarness();
    await expect(
      ArtifactTransactionCoordinator.create({
        ...coordinatorOptions(storageRetryDatabase),
        storage: harness.storageHandle,
      }),
    ).rejects.toThrow(/already consumed or forged/u);
    const afterConsumedStorage = await startReadyCoordinator(storageRetryDatabase);
    await afterConsumedStorage.close();

    const ownerLockRetry = createHarness();
    await expect(
      ArtifactTransactionCoordinator.create({
        ...coordinatorOptions(ownerLockRetry),
        databaseOwnerLock: harness.ownerLockHandle,
      }),
    ).rejects.toThrow(/already consumed or forged/u);
    const afterConsumedOwnerLock = await startReadyCoordinator(ownerLockRetry);
    await afterConsumedOwnerLock.close();

    const forgedDatabaseHarness = createHarness();
    await expect(
      ArtifactTransactionCoordinator.create({
        ...coordinatorOptions(forgedDatabaseHarness),
        database: Object.freeze(Object.create(null)) as ArtifactTransactionDatabaseHandle,
      }),
    ).rejects.toThrow(/already consumed or forged/u);
    const afterForgedDatabase = await startReadyCoordinator(forgedDatabaseHarness);
    await afterForgedDatabase.close();

    const forgedStorageHarness = createHarness();
    await expect(
      ArtifactTransactionCoordinator.create({
        ...coordinatorOptions(forgedStorageHarness),
        storage: Object.freeze(Object.create(null)) as ArtifactTransactionStorageHandle,
      }),
    ).rejects.toThrow(/already consumed or forged/u);
    const afterForgedStorage = await startReadyCoordinator(forgedStorageHarness);
    await afterForgedStorage.close();

    const forgedOwnerLockHarness = createHarness();
    await expect(
      ArtifactTransactionCoordinator.create({
        ...coordinatorOptions(forgedOwnerLockHarness),
        databaseOwnerLock: Object.freeze(Object.create(null)) as ArtifactTransactionOwnerLockHandle,
      }),
    ).rejects.toThrow(/already consumed or forged/u);
    const afterForgedOwnerLock = await startReadyCoordinator(forgedOwnerLockHarness);
    await afterForgedOwnerLock.close();

    await coordinator.close();
  });

  it("tears down claimed owners when derived create coordinator construction fails", async () => {
    const candidate = createHarness();
    const legacyStorage = new FakeStorage();
    const legacyOwnerLock = new FakeOwnerLock();
    const legacy = ArtifactUploadCreateCoordinator.start({
      database: attachArtifactUploadCreateDatabaseForTest(candidate.database),
      storage: legacyStorage,
      storageCapacity,
      databaseOwnerLock: legacyOwnerLock,
      requestTimeoutMilliseconds: 5_000,
      closeTimeoutMilliseconds: 5_000,
      storageJoinTimeoutMilliseconds: 5_000,
      maximumPendingCreates: 16,
      onFailStop: () => undefined,
    });

    await expect(
      ArtifactTransactionCoordinator.create(coordinatorOptions(candidate)),
    ).rejects.toThrow(/already adopted/u);
    expect(candidate.events.indexOf("storage:close")).toBeLessThan(
      candidate.events.indexOf("storage:exit"),
    );
    expect(candidate.events.indexOf("storage:exit")).toBeLessThan(
      candidate.events.indexOf("database:close"),
    );
    expect(candidate.events.indexOf("database:close")).toBeLessThan(
      candidate.events.indexOf("owner-lock:close"),
    );
    await legacy.close();
  });

  it("rejects mutations until the first healthy namespace sweep completes", async () => {
    const harness = createHarness();
    const reconciliationEntered = Promise.withResolvers<void>();
    const releaseReconciliation = Promise.withResolvers<void>();
    harness.database.handlers.set("terminalizeInactiveArtifactUploads", async () => {
      reconciliationEntered.resolve();
      await releaseReconciliation.promise;
      return { terminalized: [], hasMore: false };
    });
    const coordinator = await ArtifactTransactionCoordinator.create(coordinatorOptions(harness));

    expect(coordinator.readiness).toEqual({ ready: false, state: "starting", health: null });
    await expect(coordinator.createArtifactUpload(createRequest)).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_NOT_READY",
      retryable: true,
    });
    expect(
      harness.database.inputs.some(({ operation }) => operation === "createArtifactUpload"),
    ).toBe(false);

    await reconciliationEntered.promise;
    releaseReconciliation.resolve();
    await coordinator.ready;
    expect(coordinator.readiness).toMatchObject({
      ready: true,
      state: "open",
      health: { capacity: { accountingCertain: true } },
    });
    await coordinator.close();
  });

  it.each(["database", "storage"] as const)(
    "poisons startup before first-sweep dispatch when $owner failure is already settled",
    async (owner) => {
      const harness = createHarness();
      const failure = new Error(`${owner} failed before startup`);
      harness[owner].terminal.resolve(failure);
      const coordinator = await ArtifactTransactionCoordinator.create(coordinatorOptions(harness));

      await expect(coordinator.ready).rejects.toMatchObject({
        code:
          owner === "database"
            ? "ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN"
            : "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN",
        requiresFailStop: true,
      });
      expect(coordinator.readiness).toMatchObject({ ready: false, state: "fatal" });
      expect(harness.events).not.toContain("db:terminalizeInactiveArtifactUploads");
      await coordinator.close().catch(() => undefined);
    },
  );

  it.each(["database", "storage"] as const)(
    "poisons open readiness immediately after idle $owner failure",
    async (owner) => {
      const harness = createHarness();
      const coordinator = await startReadyCoordinator(harness);
      harness[owner].terminal.resolve(new Error(`${owner} failed while idle`));

      await expect(coordinator.fatal).resolves.toMatchObject({
        code:
          owner === "database"
            ? "ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN"
            : "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN",
      });
      expect(coordinator.readiness).toMatchObject({ ready: false, state: "fatal" });
      await expect(
        coordinator.terminateArtifactUpload(uploadId, terminateRequest),
      ).rejects.toMatchObject({ requiresFailStop: true });
      expect(harness.events).not.toContain("db:terminateArtifactUpload");
      await coordinator.close().catch(() => undefined);
    },
  );

  it("fail-stops malformed fulfillment and rejection of owner failure signals", async () => {
    const malformedHarness = createHarness();
    malformedHarness.database.terminal.resolve("invalid terminal value" as unknown as Error);
    const malformed = await ArtifactTransactionCoordinator.create(
      coordinatorOptions(malformedHarness),
    );
    await expect(malformed.ready).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
    });
    await malformed.close().catch(() => undefined);

    const rejectedHarness = createHarness();
    rejectedHarness.storage.terminal.reject(new Error("terminal signal rejected"));
    const rejected = await ArtifactTransactionCoordinator.create(
      coordinatorOptions(rejectedHarness),
    );
    await expect(rejected.ready).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN",
    });
    await rejected.close().catch(() => undefined);
  });

  it("does not settle owner failure signals during normal close", async () => {
    const harness = createHarness();
    const coordinator = await startReadyCoordinator(harness);
    let databaseFailed = false;
    let storageFailed = false;
    void harness.database.terminalFailure.then(() => {
      databaseFailed = true;
    });
    void harness.storage.terminalFailure.then(() => {
      storageFailed = true;
    });

    await coordinator.close();
    await Promise.resolve();
    expect(databaseFailed).toBe(false);
    expect(storageFailed).toBe(false);
    expect(coordinator.readiness).toMatchObject({ ready: false, state: "closed" });
  });

  it("orders create admission and chunk durability around their database phases", async () => {
    const harness = createHarness();
    const coordinator = await startReadyCoordinator(harness);

    await expect(coordinator.createArtifactUpload(createRequest)).resolves.toMatchObject({
      uploadId,
      state: "receiving",
    });
    expect(transactionEvents(harness.events)).toEqual([
      "db:probeArtifactUploadCreate",
      "storage:evaluateCapacity",
      "db:createArtifactUpload",
    ]);

    harness.events.length = 0;
    await expect(coordinator.putArtifactChunk(uploadId, chunkRequest)).resolves.toMatchObject({
      uploadId,
      state: "receiving",
      outcome: "accepted",
    });
    expect(transactionEvents(harness.events)).toEqual([
      "db:prepareArtifactChunk",
      "storage:writePreparedChunk",
      "db:commitArtifactChunk",
    ]);
    await coordinator.close();
  });

  it.each([
    { name: "prepared receipt on a finalizing upload", overrides: { uploadState: "finalizing" } },
    {
      name: "prepared receipt ahead of its committed byte cursor",
      overrides: { committedOffsetBytes: 1 },
    },
    {
      name: "committed receipt without replay identity",
      overrides: {
        receiptState: "committed",
        replayed: false,
        committedNextChunkIndex: 1,
        committedOffsetBytes: artifactBytes.byteLength,
        committedPrefix: [
          {
            chunkIndex: 0,
            offsetBytes: 0,
            chunkBytes: artifactBytes.byteLength,
            chunkSha256: artifactSha256,
          },
        ],
      },
    },
    {
      name: "committed receipt cursor beyond its validated prefix",
      overrides: {
        receiptState: "committed",
        replayed: true,
        committedNextChunkIndex: 2,
        committedOffsetBytes: artifactBytes.byteLength + 1,
        committedPrefix: [
          {
            chunkIndex: 0,
            offsetBytes: 0,
            chunkBytes: artifactBytes.byteLength,
            chunkSha256: artifactSha256,
          },
        ],
      },
    },
    {
      name: "prepared receipt with a mismatched endpoint",
      overrides: { preparedNextOffsetBytes: artifactBytes.byteLength + 1 },
    },
  ])(
    "fail-stops malformed prepare protocol before filesystem mutation: $name",
    async ({ overrides }) => {
      const harness = createHarness();
      harness.database.handlers.set("prepareArtifactChunk", (inputValue) =>
        preparedChunkRecord(inputValue as PrepareArtifactChunkInput, overrides),
      );
      const coordinator = await startReadyCoordinator(harness);

      await expect(coordinator.putArtifactChunk(uploadId, chunkRequest)).rejects.toMatchObject({
        code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
        requiresFailStop: true,
      });
      expect(harness.events).not.toContain("storage:writePreparedChunk");
      expect(harness.events).not.toContain("storage:readObject");
      await coordinator.close().catch(() => undefined);
    },
  );

  it.each([
    { name: "accepted cursor", committedPrepare: false },
    { name: "replayed cursor", committedPrepare: true },
  ])("fail-stops a commit receipt with a mismatched $name", async ({ committedPrepare }) => {
    const harness = createHarness();
    harness.database.chunkReplayCommitted = committedPrepare;
    harness.database.handlers.set("commitArtifactChunk", (inputValue) => {
      const input = inputValue as DatabaseOperationMap["commitArtifactChunk"]["input"];
      return {
        uploadId: input.uploadId,
        prepareId: input.prepareId,
        state: committedPrepare ? "committed" : "receiving",
        chunkIndex: input.chunkIndex,
        outcome: committedPrepare ? "replayed" : "accepted",
        nextChunkIndex: input.chunkIndex + 2,
        nextOffsetBytes: input.offsetBytes + input.chunkBytes,
      };
    });
    const coordinator = await startReadyCoordinator(harness);

    await expect(coordinator.putArtifactChunk(uploadId, chunkRequest)).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
      requiresFailStop: true,
    });
    await coordinator.close().catch(() => undefined);
  });

  it("verifies committed chunk and finalize replays only through the immutable object", async () => {
    const harness = createHarness();
    harness.database.chunkReplayCommitted = true;
    harness.database.finalizeReplayCommitted = true;
    const coordinator = await startReadyCoordinator(harness);

    await expect(coordinator.putArtifactChunk(uploadId, chunkRequest)).resolves.toMatchObject({
      state: "committed",
      outcome: "replayed",
    });
    expect(transactionEvents(harness.events)).toEqual([
      "db:prepareArtifactChunk",
      "storage:readObject",
      "db:commitArtifactChunk",
    ]);

    harness.events.length = 0;
    const finalized = await coordinator.finalizeArtifactUpload(uploadId, finalizeRequest);
    expect(finalized).toMatchObject({
      state: "committed",
      replayed: true,
      artifact: { artifactId: finalizationId, uploadId },
    });
    expect(finalized.artifact).not.toHaveProperty("storageObjectKey");
    expect(transactionEvents(harness.events)).toEqual([
      "db:prepareArtifactFinalize",
      "storage:readObject",
      "db:commitArtifactFinalize",
    ]);
    expect(harness.events).not.toContain("storage:writePreparedChunk");
    expect(harness.events).not.toContain("storage:finalizeArtifact");
    await coordinator.close();
  });

  it("fail-stops before public mapping can normalize invalid database commit receipts", async () => {
    const chunkHarness = createHarness();
    chunkHarness.database.handlers.set("commitArtifactChunk", (inputValue) => {
      const input = inputValue as DatabaseOperationMap["commitArtifactChunk"]["input"];
      return {
        uploadId: input.uploadId,
        prepareId: input.prepareId,
        state: "committed",
        chunkIndex: input.chunkIndex,
        outcome: "accepted",
        nextChunkIndex: input.chunkIndex + 1,
        nextOffsetBytes: input.offsetBytes + input.chunkBytes,
      };
    });
    const chunkCoordinator = await startReadyCoordinator(chunkHarness);
    await expect(chunkCoordinator.putArtifactChunk(uploadId, chunkRequest)).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
      requiresFailStop: true,
    });
    await chunkCoordinator.close().catch(() => undefined);

    const finalizeHarness = createHarness();
    finalizeHarness.database.handlers.set("commitArtifactFinalize", (inputValue) => {
      const input = inputValue as DatabaseOperationMap["commitArtifactFinalize"]["input"];
      return {
        state: "committed",
        replayed: false,
        artifact: {
          artifactId: input.finalizationId,
          uploadId: input.uploadId,
          clientArtifactId,
          jobId: input.jobId,
          runAttemptId: input.runAttemptId,
          purpose: "result",
          name: "result.json",
          mediaType: "application/json",
          totalBytes: input.totalBytes,
          sha256: input.sha256,
          storageObjectKey: `sha256/00/${input.sha256}`,
        },
      };
    });
    const finalizeCoordinator = await startReadyCoordinator(finalizeHarness);
    await expect(
      finalizeCoordinator.finalizeArtifactUpload(uploadId, finalizeRequest),
    ).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
      requiresFailStop: true,
    });
    await finalizeCoordinator.close().catch(() => undefined);
  });

  it.each([
    { name: "new finalization reported as replay", committedPrepare: false },
    { name: "committed finalization reported as new", committedPrepare: true },
  ])(
    "fail-stops a finalize commit with inconsistent replay state: $name",
    async ({ committedPrepare }) => {
      const harness = createHarness();
      harness.database.finalizeReplayCommitted = committedPrepare;
      harness.database.handlers.set("commitArtifactFinalize", (inputValue) => {
        const input = inputValue as DatabaseOperationMap["commitArtifactFinalize"]["input"];
        return {
          state: "committed",
          replayed: !committedPrepare,
          artifact: {
            artifactId: input.finalizationId,
            uploadId: input.uploadId,
            clientArtifactId,
            jobId: input.jobId,
            runAttemptId: input.runAttemptId,
            purpose: "result",
            name: "result.json",
            mediaType: "application/json",
            totalBytes: input.totalBytes,
            sha256: input.sha256,
            storageObjectKey: input.storageObjectKey,
          },
        };
      });
      const coordinator = await startReadyCoordinator(harness);

      await expect(
        coordinator.finalizeArtifactUpload(uploadId, finalizeRequest),
      ).rejects.toMatchObject({
        code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
        requiresFailStop: true,
      });
      await coordinator.close().catch(() => undefined);
    },
  );

  it("records Worker termination in the database without dispatching filesystem cleanup", async () => {
    const harness = createHarness();
    const coordinator = await startReadyCoordinator(harness);

    await expect(
      coordinator.terminateArtifactUpload(uploadId, terminateRequest),
    ).resolves.toMatchObject({
      uploadId,
      state: "abandoned",
      reason: "client_abandoned",
    });
    expect(transactionEvents(harness.events)).toEqual(["db:terminateArtifactUpload"]);
    expect(harness.events).not.toContain("storage:cleanupUpload");
    await coordinator.close();
  });

  it("rejects a noncanonical termination time without relying on a global format registry", async () => {
    const harness = createHarness();
    harness.database.handlers.set("terminateArtifactUpload", async (input) => ({
      uploadId: (input as TerminateArtifactUploadInput).uploadId,
      state: "abandoned",
      reason: "client_abandoned",
      terminatedAt: "2026-09-02T00:00:00Z",
      replayed: false,
    }));
    const coordinator = await startReadyCoordinator(harness);

    await expect(
      coordinator.terminateArtifactUpload(uploadId, terminateRequest),
    ).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
      requiresFailStop: true,
    });
    expect(harness.events).not.toContain("storage:cleanupUpload");
    await coordinator.close().catch(() => undefined);
  });

  it("prevents reconciliation from crossing an active writer transaction", async () => {
    const harness = createHarness();
    const writeEntered = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    harness.storage.writeHandler = async (input) => {
      harness.events.push("storage:write-active");
      writeEntered.resolve();
      await releaseWrite.promise;
      harness.events.push("storage:write-released");
      return {
        uploadId: input.uploadId,
        prepareId: input.prepareId,
        durableOffsetBytes: input.offsetBytes + input.bytes.byteLength,
        replayed: false,
      };
    };
    const coordinator = await startReadyCoordinator(harness, {
      reconciliationIntervalMilliseconds: 10,
    });
    const writing = coordinator.putArtifactChunk(uploadId, chunkRequest);
    await writeEntered.promise;

    await delay(30);
    expect(harness.events).not.toContain("db:terminalizeInactiveArtifactUploads");
    releaseWrite.resolve();
    await writing;
    await vi.waitFor(() => {
      expect(harness.events).toContain("db:terminalizeInactiveArtifactUploads");
    });
    expect(harness.events.indexOf("storage:write-released")).toBeLessThan(
      harness.events.indexOf("db:terminalizeInactiveArtifactUploads"),
    );
    await coordinator.close();
  });

  it("withdraws readiness after a saturated maintenance admission and recovers after drain", async () => {
    const harness = createHarness();
    const writeEntered = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    harness.storage.writeHandler = async (input) => {
      writeEntered.resolve();
      await releaseWrite.promise;
      return {
        uploadId: input.uploadId,
        prepareId: input.prepareId,
        durableOffsetBytes: input.offsetBytes + input.bytes.byteLength,
        replayed: false,
      };
    };
    const coordinator = await startReadyCoordinator(harness, {
      maximumPendingTransactions: 2,
      reconciliationIntervalMilliseconds: 50,
    });
    const active = coordinator.putArtifactChunk(uploadId, chunkRequest);
    await writeEntered.promise;
    const queued = coordinator.terminateArtifactUpload(uploadId, terminateRequest);

    await vi.waitFor(() => {
      expect(coordinator.readiness).toMatchObject({
        ready: false,
        state: "open",
        health: { capacity: { accountingCertain: false } },
      });
    });
    expect(harness.events).not.toContain("db:terminateArtifactUpload");
    await expect(
      coordinator.createArtifactUpload({ ...createRequest, clientArtifactId }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_NOT_READY" });

    releaseWrite.resolve();
    await active;
    await expect(queued).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_NOT_READY" });
    expect(harness.events).not.toContain("db:terminateArtifactUpload");
    await vi.waitFor(() => {
      expect(coordinator.readiness.ready).toBe(true);
    });
    await coordinator.close();
  });

  it("does not dispatch a database commit after storage owner exit wins the stage continuation", async () => {
    const harness = createHarness();
    harness.storage.writeHandler = (input) => {
      const write = Promise.withResolvers<DurableArtifactChunk>();
      queueMicrotask(() => {
        write.resolve({
          uploadId: input.uploadId,
          prepareId: input.prepareId,
          durableOffsetBytes: input.offsetBytes + input.bytes.byteLength,
          replayed: false,
        });
        harness.storage.exit.resolve(1);
      });
      return write.promise;
    };
    const coordinator = await startReadyCoordinator(harness);

    await expect(coordinator.putArtifactChunk(uploadId, chunkRequest)).rejects.toMatchObject({
      requiresFailStop: true,
    });
    expect(harness.events).not.toContain("db:commitArtifactChunk");
    expect(coordinator.readiness).toMatchObject({ ready: false, state: "fatal" });
    await coordinator.close().catch(() => undefined);
  });

  it("does not dispatch queued callbacks cancelled by abort or coordinator close", async () => {
    const harness = createHarness();
    const writeEntered = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    harness.storage.writeHandler = async (input) => {
      writeEntered.resolve();
      await releaseWrite.promise;
      return {
        uploadId: input.uploadId,
        prepareId: input.prepareId,
        durableOffsetBytes: input.offsetBytes + input.bytes.byteLength,
        replayed: false,
      };
    };
    const coordinator = await startReadyCoordinator(harness);
    const active = coordinator.putArtifactChunk(uploadId, chunkRequest);
    await writeEntered.promise;

    const abortController = new AbortController();
    const aborted = coordinator.putArtifactChunk(
      uploadId,
      { ...chunkRequest, chunkIndex: 1, offsetBytes: 2 },
      abortController.signal,
    );
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_CANCELLED",
    });

    const closedBeforeDispatch = coordinator.putArtifactChunk(uploadId, {
      ...chunkRequest,
      chunkIndex: 2,
      offsetBytes: 4,
    });
    const closing = coordinator.close();
    await expect(closedBeforeDispatch).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_CLOSED",
    });
    expect(
      harness.database.inputs.filter(({ operation }) => operation === "prepareArtifactChunk"),
    ).toHaveLength(1);
    expect(harness.events).not.toContain("storage:close");

    releaseWrite.resolve();
    await active;
    await closing;
    expect(harness.events.indexOf("db:commitArtifactChunk")).toBeLessThan(
      harness.events.indexOf("storage:close"),
    );
    expect(harness.events.indexOf("storage:close")).toBeLessThan(
      harness.events.indexOf("storage:exit"),
    );
    expect(harness.events.indexOf("storage:exit")).toBeLessThan(
      harness.events.indexOf("database:close"),
    );
    expect(harness.events.indexOf("database:close")).toBeLessThan(
      harness.events.indexOf("owner-lock:close"),
    );
  });

  it("dispatches owner teardown after an earlier close stage consumes the absolute deadline", async () => {
    const harness = createHarness();
    const coordinator = await startReadyCoordinator(harness, {
      closeTimeoutMilliseconds: 10,
      reconciliationIntervalMilliseconds: 10,
    });
    const reconciliationEntered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<never>();
    harness.database.handlers.set("terminalizeInactiveArtifactUploads", async () => {
      reconciliationEntered.resolve();
      return blocked.promise;
    });

    await reconciliationEntered.promise;
    await coordinator.close().catch(() => undefined);

    await vi.waitFor(() => {
      expect(harness.events).toContain("owner-lock:close");
    });
    expect(harness.events.indexOf("storage:close")).toBeLessThan(
      harness.events.indexOf("storage:exit"),
    );
    expect(harness.events.indexOf("storage:exit")).toBeLessThan(
      harness.events.indexOf("database:close"),
    );
    expect(harness.events.indexOf("database:close")).toBeLessThan(
      harness.events.indexOf("owner-lock:close"),
    );
  });

  it("closes an active reconciliation namespace session before owner shutdown", async () => {
    const harness = createHarness();
    const scanEntered = Promise.withResolvers<void>();
    const releaseScan = Promise.withResolvers<void>();
    const coordinator = await startReadyCoordinator(harness, {
      reconciliationIntervalMilliseconds: 10,
    });
    harness.storage.scanHandler = async (input) => {
      scanEntered.resolve();
      await releaseScan.promise;
      const observations = Array.from({ length: input.maximumEntries }, (_, index) =>
        namespaceObservation(index + 1),
      );
      return {
        scanSessionId: input.scanSessionId,
        sweepGeneration: input.sweepGeneration,
        expectedAfterKey: input.expectedAfterKey,
        observations,
        completedSweep: false,
        nextAfterKey: observations.at(-1)?.entryKey ?? null,
      };
    };

    await scanEntered.promise;
    const closing = coordinator.close();
    releaseScan.resolve();
    await closing;

    expect(harness.events).toContain("reconciliation:closeNamespaceScan");
    expect(harness.events.indexOf("reconciliation:closeNamespaceScan")).toBeLessThan(
      harness.events.indexOf("storage:close"),
    );
    expect(harness.events.indexOf("storage:exit")).toBeLessThan(
      harness.events.indexOf("database:close"),
    );
    expect(harness.events.indexOf("database:close")).toBeLessThan(
      harness.events.indexOf("owner-lock:close"),
    );
  });

  it("updates readiness from each successful reconciliation health snapshot", async () => {
    const harness = createHarness();
    const coordinator = await startReadyCoordinator(harness, {
      reconciliationIntervalMilliseconds: 10,
    });
    harness.database.health = {
      ...healthyAccounting(),
      capacity: {
        ...healthyAccounting().capacity,
        accountingCertain: false,
      },
    };

    await vi.waitFor(() => {
      expect(coordinator.readiness).toMatchObject({
        ready: false,
        state: "open",
        health: { capacity: { accountingCertain: false } },
      });
    });
    await expect(coordinator.createArtifactUpload(createRequest)).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_NOT_READY",
      retryable: true,
    });
    await coordinator.close();
  });

  it("publishes unhealthy reconciliation accounting before admitting a queued mutation", async () => {
    const harness = createHarness();
    const coordinator = await startReadyCoordinator(harness, {
      reconciliationIntervalMilliseconds: 10,
    });
    const healthReadEntered = Promise.withResolvers<void>();
    const releaseHealthRead = Promise.withResolvers<void>();
    harness.database.health = {
      ...healthyAccounting(),
      capacity: {
        ...healthyAccounting().capacity,
        accountingCertain: false,
      },
    };
    harness.database.handlers.set("readArtifactHealthAccounting", async () => {
      healthReadEntered.resolve();
      await releaseHealthRead.promise;
      return harness.database.health;
    });

    await healthReadEntered.promise;
    const mutation = coordinator.terminateArtifactUpload(uploadId, terminateRequest);
    expect(harness.events).not.toContain("db:terminateArtifactUpload");
    releaseHealthRead.resolve();

    await expect(mutation).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_NOT_READY",
      retryable: true,
    });
    expect(harness.events).not.toContain("db:terminateArtifactUpload");
    expect(coordinator.readiness).toMatchObject({
      ready: false,
      state: "open",
      health: { capacity: { accountingCertain: false } },
    });
    await coordinator.close();
  });

  it("propagates fatal reconciliation health changes after becoming ready", async () => {
    const harness = createHarness();
    const failures: Error[] = [];
    const coordinator = await startReadyCoordinator(harness, {
      reconciliationIntervalMilliseconds: 10,
      onFailStop: (error) => {
        failures.push(error);
      },
    });
    harness.database.health = {
      ...healthyAccounting(),
      cleanup: {
        ...healthyAccounting().cleanup,
        failed: 1,
      },
      capacity: {
        ...healthyAccounting().capacity,
        accountingCertain: false,
        cleanupBacklogEntries: 1,
      },
    };

    await expect(coordinator.fatal).resolves.toMatchObject({
      code: "ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE",
      requiresFailStop: true,
    });
    expect(coordinator.readiness).toMatchObject({ ready: false, state: "fatal" });
    expect(failures).toHaveLength(1);
    await expect(coordinator.createArtifactUpload(createRequest)).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE",
    });
    await coordinator.close().catch(() => undefined);
  });

  it("snapshots create input before gate admission and treats invalid signals as caller faults", async () => {
    const harness = createHarness();
    const coordinator = await startReadyCoordinator(harness);
    const mutable = { ...createRequest };
    const creation = coordinator.createArtifactUpload(mutable);
    mutable.name = "changed-after-admission.json";
    await creation;
    expect(
      harness.database.inputs.find(({ operation }) => operation === "createArtifactUpload")?.input,
    ).toMatchObject({ name: "result.json" });

    let reads = 0;
    const accessor = { ...createRequest } as Record<string, unknown>;
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get() {
        reads += 1;
        return "accessor.json";
      },
    });
    await expect(
      coordinator.createArtifactUpload(accessor as unknown as CreateResultArtifactUploadRequest),
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_INVALID_REQUEST" });
    expect(reads).toBe(0);

    await expect(
      Reflect.apply(coordinator.putArtifactChunk, coordinator, [uploadId, chunkRequest, {}]),
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_INVALID_REQUEST" });
    expect(coordinator.readiness.ready).toBe(true);
    await coordinator.close();
  });

  it("validates pure options before consuming owner handles", async () => {
    const harness = createHarness();
    await expect(
      ArtifactTransactionCoordinator.create({
        ...coordinatorOptions(harness),
        maximumPendingTransactions: 0,
      }),
    ).rejects.toThrow(/pending limit/u);

    const recovered = await startReadyCoordinator(harness);
    await recovered.close();
  });

  it("restores handles without closing owners when the top-level identity claim conflicts", async () => {
    const owner = createHarness();
    const active = await startReadyCoordinator(owner);
    const candidate = createHarness();
    const sharedIdentityDatabase = attachArtifactTransactionDatabaseForTest(owner.database);
    const conflictingOptions = {
      ...coordinatorOptions(candidate),
      database: sharedIdentityDatabase,
    };

    await expect(ArtifactTransactionCoordinator.create(conflictingOptions)).rejects.toThrow(
      /already adopted/u,
    );
    await expect(ArtifactTransactionCoordinator.create(conflictingOptions)).rejects.toThrow(
      /already adopted/u,
    );
    expect(candidate.events).not.toContain("storage:close");
    expect(candidate.events).not.toContain("storage:exit");
    expect(candidate.events).not.toContain("owner-lock:close");
    expect(owner.events).not.toContain("database:close");

    const recovered = await startReadyCoordinator(candidate);
    await recovered.close();
    expect(candidate.events.indexOf("storage:close")).toBeLessThan(
      candidate.events.indexOf("storage:exit"),
    );
    expect(candidate.events.indexOf("storage:exit")).toBeLessThan(
      candidate.events.indexOf("database:close"),
    );
    expect(candidate.events.indexOf("database:close")).toBeLessThan(
      candidate.events.indexOf("owner-lock:close"),
    );
    await active.close();
  });
});
