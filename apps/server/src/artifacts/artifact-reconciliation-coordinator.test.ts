import { describe, expect, it } from "vitest";
import {
  type ArtifactNamespaceCleanupResult,
  type ArtifactNamespaceObservation,
  type ArtifactNamespaceScanPageInput,
  type ArtifactNamespaceScanPageResult,
  type CloseArtifactNamespaceScanInput,
  type CloseArtifactNamespaceScanResult,
  calculateArtifactNamespaceObservationSha256,
} from "../../dist/artifacts/artifact-namespace-contract.js";
import {
  ArtifactReconciliationCoordinator,
  ArtifactReconciliationCoordinatorError,
  type ArtifactReconciliationDatabaseHandle,
  type ArtifactReconciliationStorageOwner,
} from "../../dist/artifacts/artifact-reconciliation-coordinator.js";
import {
  attachArtifactReconciliationDatabaseForTest,
  type FakeArtifactReconciliationDatabaseOwner,
} from "../../dist/artifacts/artifact-reconciliation-coordinator.testing.js";
import { ArtifactStorageClientError } from "../../dist/artifacts/errors.js";
import type {
  ArtifactCleanupWorkItem,
  ArtifactNamespaceCleanupWorkItem,
  ArtifactReconciliationDatabaseOperation,
} from "../../dist/database/artifacts.js";
import type { DatabaseOperationMap } from "../../dist/database/protocol.js";

type CleanupDatabaseOperation =
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

const uploadId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-09-02T00:00:00.000Z";

const emptyHealth = () => ({
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

const cleanupItem = (
  expectedAttemptCount = 0,
  lastRetryDelaySeconds: number | null = null,
): ArtifactCleanupWorkItem => ({
  uploadId,
  terminalStatus: "abandoned",
  cleanupScope: "staging_only_v1",
  expectedAttemptCount,
  lastRetryDelaySeconds,
  publications: [],
});

const namespaceObservation = (ordinal = 1): ArtifactNamespaceObservation => {
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
    fileInode: "2",
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

class FakeDatabase implements FakeArtifactReconciliationDatabaseOwner {
  readonly events: string[] = [];
  readonly inputs: unknown[] = [];
  items: ArtifactCleanupWorkItem[] = [];
  terminalHasMore = false;
  cleanupHasMore = false;
  namespaceItems: ArtifactNamespaceCleanupWorkItem[] = [];
  namespaceAfterKey: string | null = null;
  namespaceSweepGeneration = 0;
  completeError: Error | undefined;
  namespaceCompleteError: Error | undefined;
  namespaceClassificationError: Error | undefined;
  classificationOverride: ((input: unknown, result: unknown) => unknown) | undefined;
  exposeClassifiedNamespaceCleanup = false;
  health = emptyHealth();
  onRequest: ((operation: CleanupDatabaseOperation) => void) | undefined;

  async request<TOperation extends ArtifactReconciliationDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    this.events.push(`db:${operation}`);
    this.inputs.push(input);
    this.onRequest?.(operation as CleanupDatabaseOperation);
    let result: unknown;
    switch (operation) {
      case "terminalizeInactiveArtifactUploads":
        result = { terminalized: [], hasMore: this.terminalHasMore };
        break;
      case "listDueArtifactCleanups":
        result = { items: this.items, hasMore: this.cleanupHasMore };
        break;
      case "completeArtifactCleanup": {
        if (this.completeError !== undefined) {
          throw this.completeError;
        }
        const completion = input as DatabaseOperationMap["completeArtifactCleanup"]["input"];
        result = {
          uploadId: completion.uploadId,
          status: "completed",
          attemptCount: completion.expectedAttemptCount,
          completedAt: timestamp,
          replayed: false,
        };
        this.items = [];
        break;
      }
      case "recordArtifactCleanupFailure": {
        const failure = input as DatabaseOperationMap["recordArtifactCleanupFailure"]["input"];
        const attemptCount = failure.expectedAttemptCount + 1;
        result = {
          uploadId: failure.uploadId,
          status: attemptCount === 8 ? "failed" : "retry_waiting",
          attemptCount,
          nextAttemptAt: attemptCount === 8 ? null : timestamp,
          errorCode: failure.errorCode,
          retryDelaySeconds: failure.retryDelaySeconds,
          replayed: false,
        };
        this.items = [];
        break;
      }
      case "readArtifactHealthAccounting":
        result = this.health;
        break;
      case "readArtifactReconciliationCursor":
        result = {
          name: "managed_namespace_v2",
          sweepGeneration: this.namespaceSweepGeneration,
          afterKey: this.namespaceAfterKey,
          updatedAt: timestamp,
          lastCompletedAt: this.namespaceSweepGeneration === 0 ? null : timestamp,
        };
        break;
      case "classifyArtifactNamespacePageAndAdvanceCursor": {
        if (this.namespaceClassificationError !== undefined) {
          throw this.namespaceClassificationError;
        }
        const page =
          input as DatabaseOperationMap["classifyArtifactNamespacePageAndAdvanceCursor"]["input"];
        this.namespaceSweepGeneration += page.completedSweep ? 1 : 0;
        this.namespaceAfterKey = page.completedSweep
          ? null
          : (page.observations.at(-1)?.entryKey ?? null);
        const classificationResult = {
          classifications: page.observations.map((observation) => ({
            entryKey: observation.entryKey,
            observationSha256: observation.observationSha256,
            disposition: "cleanup_intent_created",
            reason: "orphan",
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
        if (this.exposeClassifiedNamespaceCleanup && page.observations.length > 0) {
          this.namespaceItems = page.observations.map((observation) => ({
            ...observation,
            reason: "orphan" as const,
            observedSweepGeneration: page.expectedSweepGeneration,
            expectedAttemptCount: 0,
            lastRetryDelaySeconds: null,
          }));
        }
        result = this.classificationOverride?.(input, classificationResult) ?? classificationResult;
        break;
      }
      case "listDueArtifactNamespaceCleanups":
        result = { items: this.namespaceItems, hasMore: false };
        break;
      case "completeArtifactNamespaceCleanup": {
        if (this.namespaceCompleteError !== undefined) {
          throw this.namespaceCompleteError;
        }
        const completion =
          input as DatabaseOperationMap["completeArtifactNamespaceCleanup"]["input"];
        result = {
          entryKey: completion.entryKey,
          observationSha256: completion.observationSha256,
          status: "completed",
          attemptCount: completion.expectedAttemptCount,
          completedAt: timestamp,
          replayed: false,
        };
        this.namespaceItems = [];
        break;
      }
      case "recordArtifactNamespaceCleanupFailure": {
        const failure =
          input as DatabaseOperationMap["recordArtifactNamespaceCleanupFailure"]["input"];
        const attemptCount = failure.expectedAttemptCount + 1;
        result = {
          entryKey: failure.entryKey,
          observationSha256: failure.observationSha256,
          status: attemptCount === 8 ? "failed" : "retry_waiting",
          attemptCount,
          nextAttemptAt: attemptCount === 8 ? null : timestamp,
          errorCode: failure.errorCode,
          retryDelaySeconds: failure.retryDelaySeconds,
          replayed: false,
        };
        this.namespaceItems = [];
        break;
      }
      default:
        throw new Error(`Unexpected database operation ${operation}.`);
    }
    return result as DatabaseOperationMap[TOperation]["output"];
  }
}

class FakeStorage implements ArtifactReconciliationStorageOwner {
  readonly events: string[] = [];
  readonly ownerExitSignal = Promise.withResolvers<number>();
  readonly ownerExit: Promise<number>;
  readonly cleanupStarted = Promise.withResolvers<void>();
  cleanupResult: () => Promise<{
    stagingRemoved: boolean;
    publicationTemporariesRemoved: number;
  }> = () => Promise.resolve({ stagingRemoved: false, publicationTemporariesRemoved: 0 });
  namespacePages: readonly ArtifactNamespaceObservation[][] = [[]];
  namespacePageIndex = 0;
  namespaceCleanupResult: (
    input: ArtifactNamespaceObservation,
  ) => Promise<ArtifactNamespaceCleanupResult> = () =>
    Promise.reject(new Error("Namespace cleanup was not configured."));

  constructor(ownerExit?: Promise<number>) {
    this.ownerExit = ownerExit ?? this.ownerExitSignal.promise;
  }

  cleanupUpload(): Promise<{ stagingRemoved: boolean; publicationTemporariesRemoved: number }> {
    this.events.push("storage:cleanup");
    this.cleanupStarted.resolve();
    return this.cleanupResult();
  }

  scanNamespacePage(
    input: ArtifactNamespaceScanPageInput,
  ): Promise<ArtifactNamespaceScanPageResult> {
    this.events.push("storage:scan-namespace");
    const observations = this.namespacePages[this.namespacePageIndex] ?? [];
    this.namespacePageIndex += 1;
    const completedSweep = this.namespacePageIndex >= this.namespacePages.length;
    return Promise.resolve({
      scanSessionId: input.scanSessionId,
      sweepGeneration: input.sweepGeneration,
      expectedAfterKey: input.expectedAfterKey,
      observations,
      completedSweep,
      nextAfterKey: completedSweep ? null : (observations.at(-1)?.entryKey ?? null),
    });
  }

  closeNamespaceScan(
    input: CloseArtifactNamespaceScanInput,
  ): Promise<CloseArtifactNamespaceScanResult> {
    this.events.push("storage:close-namespace-scan");
    return Promise.resolve({ ...input, closed: true });
  }

  cleanupNamespaceEntry(
    input: ArtifactNamespaceObservation,
  ): Promise<ArtifactNamespaceCleanupResult> {
    this.events.push("storage:cleanup-namespace");
    return this.namespaceCleanupResult(input);
  }
}

const optionsWithHandle = (
  database: ArtifactReconciliationDatabaseHandle,
  storage: ArtifactReconciliationStorageOwner,
  onFailStop: (error: Error) => void = () => undefined,
) => ({
  database,
  storage,
  batchSize: 8,
  intervalMilliseconds: 60_000,
  passTimeoutMilliseconds: 5_000,
  closeTimeoutMilliseconds: 5_000,
  initialRetryDelaySeconds: 30,
  maximumRetryDelaySeconds: 300,
  onFailStop,
});

const options = (
  database: FakeArtifactReconciliationDatabaseOwner,
  storage: ArtifactReconciliationStorageOwner,
  onFailStop: (error: Error) => void = () => undefined,
) => optionsWithHandle(attachArtifactReconciliationDatabaseForTest(database), storage, onFailStop);

describe("ArtifactReconciliationCoordinator", () => {
  it("runs immediately, completes ENOENT-equivalent cleanup, and freezes health", async () => {
    const database = new FakeDatabase();
    database.items = [cleanupItem()];
    const storage = new FakeStorage();
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await coordinator.firstSweep;
    expect(coordinator.health).toEqual(emptyHealth());
    await coordinator.firstPass;

    expect(database.events).toEqual([
      "db:terminalizeInactiveArtifactUploads",
      "db:listDueArtifactCleanups",
      "db:completeArtifactCleanup",
      "db:readArtifactReconciliationCursor",
      "db:classifyArtifactNamespacePageAndAdvanceCursor",
      "db:listDueArtifactNamespaceCleanups",
      "db:readArtifactHealthAccounting",
    ]);
    expect(storage.events).toEqual(["storage:cleanup", "storage:scan-namespace"]);
    expect(Object.isFrozen(coordinator.health)).toBe(true);
    expect(Object.isFrozen(coordinator.health?.cleanup)).toBe(true);
    await coordinator.close();
  });

  it("consumes its opaque database handle exactly once and rejects forged handles", async () => {
    const database = new FakeDatabase();
    const storage = new FakeStorage();
    const handle = attachArtifactReconciliationDatabaseForTest(database);
    expect(Reflect.ownKeys(handle)).toEqual([]);
    const coordinator = ArtifactReconciliationCoordinator.start(optionsWithHandle(handle, storage));
    expect(() =>
      ArtifactReconciliationCoordinator.start(optionsWithHandle(handle, new FakeStorage())),
    ).toThrow(/already consumed or forged/u);
    expect(() =>
      ArtifactReconciliationCoordinator.start(
        optionsWithHandle(
          Object.freeze(Object.create(null)) as ArtifactReconciliationDatabaseHandle,
          new FakeStorage(),
        ),
      ),
    ).toThrow(/already consumed or forged/u);
    await coordinator.firstPass;
    await coordinator.firstSweep;
    await coordinator.close();
  });

  it("persists a deterministic seventh-to-eighth busy failure before continuing", async () => {
    const database = new FakeDatabase();
    database.items = [cleanupItem(7, 200)];
    const storage = new FakeStorage();
    storage.cleanupResult = () =>
      Promise.reject(
        new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CLIENT_BUSY",
          "Artifact storage client request capacity is exhausted.",
          true,
        ),
      );
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await coordinator.firstPass;

    expect(database.events).toContain("db:recordArtifactCleanupFailure");
    expect(database.events).not.toContain("db:completeArtifactCleanup");
    expect(database.inputs[2]).toEqual({
      uploadId,
      expectedAttemptCount: 7,
      errorCode: "storage_busy",
      retryDelaySeconds: 300,
    });
    await coordinator.close();
  });

  it("fail-stops when durable namespace cleanup has exhausted its retry budget", async () => {
    const database = new FakeDatabase();
    database.health = {
      ...emptyHealth(),
      namespaceCleanup: {
        ...emptyHealth().namespaceCleanup,
        failed: 1,
      },
      capacity: {
        ...emptyHealth().capacity,
        accountingCertain: false,
        cleanupBacklogEntries: 1,
      },
    };
    const failures: Error[] = [];
    const coordinator = ArtifactReconciliationCoordinator.start(
      options(database, new FakeStorage(), (error) => failures.push(error)),
    );

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_NAMESPACE_CLEANUP_FAILED",
      requiresFailStop: true,
    });
    await expect(coordinator.firstSweep).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_NAMESPACE_CLEANUP_FAILED",
    });
    expect(failures).toHaveLength(1);
  });

  it("keeps running when only bounded historical namespace counts are saturated", async () => {
    const database = new FakeDatabase();
    database.health = {
      ...emptyHealth(),
      namespaceCleanup: {
        ...emptyHealth().namespaceCleanup,
        completed: 4_096,
        historicalSaturated: true,
      },
    };
    const coordinator = ArtifactReconciliationCoordinator.start(
      options(database, new FakeStorage()),
    );

    await expect(coordinator.firstPass).resolves.toBeUndefined();
    await expect(coordinator.firstSweep).resolves.toBeUndefined();
    expect(coordinator.health?.namespaceCleanup).toMatchObject({
      completed: 4_096,
      operationalSaturated: false,
      historicalSaturated: true,
    });
    await coordinator.close();
  });

  it("fail-stops when operational namespace health accounting saturates", async () => {
    const database = new FakeDatabase();
    database.health = {
      ...emptyHealth(),
      namespaceCleanup: {
        ...emptyHealth().namespaceCleanup,
        pending: 4_096,
        operationalSaturated: true,
      },
      capacity: {
        ...emptyHealth().capacity,
        accountingCertain: false,
        cleanupBacklogEntries: 4_096,
      },
    };
    const failures: Error[] = [];
    const coordinator = ArtifactReconciliationCoordinator.start(
      options(database, new FakeStorage(), (error) => failures.push(error)),
    );

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_HEALTH_SATURATED",
      requiresFailStop: true,
    });
    await expect(coordinator.firstSweep).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_HEALTH_SATURATED",
    });
    expect(failures).toHaveLength(1);
  });

  it("rejects a tampered namespace classification before dispatching unlink", async () => {
    const database = new FakeDatabase();
    database.classificationOverride = (_input, value) => {
      const result = value as { readonly cursor: unknown };
      const observation = namespaceObservation();
      return {
        classifications: [
          {
            entryKey: observation.entryKey,
            observationSha256: observation.observationSha256,
            disposition: "forged_cleanup_authority",
            reason: "orphan",
            supersededPriorIntent: false,
          },
        ],
        cursor: result.cursor,
      };
    };
    const storage = new FakeStorage();
    storage.namespacePages = [[namespaceObservation()]];
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_PROTOCOL_FAILURE",
    });
    expect(storage.events).not.toContain("storage:cleanup-namespace");
  });

  it("does not unlink when namespace page classification loses its database CAS", async () => {
    const database = new FakeDatabase();
    database.namespaceClassificationError = new Error("injected namespace cursor CAS conflict");
    const storage = new FakeStorage();
    storage.namespacePages = [[namespaceObservation()]];
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_DATABASE_FAILURE",
    });
    expect(storage.events).not.toContain("storage:cleanup-namespace");
  });

  it("persists identity-changed namespace cleanup as retry without completing it", async () => {
    const database = new FakeDatabase();
    database.exposeClassifiedNamespaceCleanup = true;
    const observation = namespaceObservation();
    const storage = new FakeStorage();
    storage.namespacePages = [[observation]];
    storage.namespaceCleanupResult = (input) =>
      Promise.resolve({
        entryKey: input.entryKey,
        observationSha256: input.observationSha256,
        outcome: "identity_changed",
      });
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await coordinator.firstPass;
    await coordinator.firstSweep;
    expect(database.events).toContain("db:recordArtifactNamespaceCleanupFailure");
    expect(database.events).not.toContain("db:completeArtifactNamespaceCleanup");
    await coordinator.close();
  });

  it("fail-stops an unknown namespace unlink outcome without writing DB state", async () => {
    const database = new FakeDatabase();
    database.exposeClassifiedNamespaceCleanup = true;
    const storage = new FakeStorage();
    storage.namespacePages = [[namespaceObservation()]];
    storage.namespaceCleanupResult = () =>
      Promise.reject(
        new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact namespace cleanup response timed out.",
        ),
      );
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN",
    });
    expect(database.events).not.toContain("db:recordArtifactNamespaceCleanupFailure");
    expect(database.events).not.toContain("db:completeArtifactNamespaceCleanup");
  });

  it("closes an active multi-page namespace session during coordinator shutdown", async () => {
    const database = new FakeDatabase();
    const storage = new FakeStorage();
    storage.namespacePages = [
      Array.from({ length: 8 }, (_, index) => namespaceObservation(index + 1)),
      [],
    ];
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await coordinator.firstPass;
    const firstSweep = coordinator.firstSweep;
    await coordinator.close();
    await expect(firstSweep).rejects.toThrow(/closed before its first sweep/u);
    expect(storage.events).toContain("storage:close-namespace-scan");
  });

  it("replays an unlink after a lost DB completion response as already absent", async () => {
    const database = new FakeDatabase();
    database.exposeClassifiedNamespaceCleanup = true;
    database.namespaceCompleteError = new Error("injected namespace completion response loss");
    const observation = namespaceObservation();
    const firstStorage = new FakeStorage();
    firstStorage.namespacePages = [[observation]];
    firstStorage.namespaceCleanupResult = (input) =>
      Promise.resolve({
        entryKey: input.entryKey,
        observationSha256: input.observationSha256,
        outcome: "removed",
      });
    const first = ArtifactReconciliationCoordinator.start(options(database, firstStorage));
    await expect(first.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_DATABASE_FAILURE",
    });

    database.namespaceCompleteError = undefined;
    const replayStorage = new FakeStorage();
    replayStorage.namespaceCleanupResult = (input) =>
      Promise.resolve({
        entryKey: input.entryKey,
        observationSha256: input.observationSha256,
        outcome: "already_absent",
      });
    const replay = ArtifactReconciliationCoordinator.start(options(database, replayStorage));
    await replay.firstPass;
    expect(database.events).toContain("db:completeArtifactNamespaceCleanup");
    await replay.close();
  });

  it("fail-stops an already-dispatched cleanup and never writes retry state", async () => {
    const database = new FakeDatabase();
    database.items = [cleanupItem()];
    const storage = new FakeStorage();
    storage.cleanupResult = () =>
      Promise.reject(
        new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage request timed out.",
        ),
      );
    const failures: Error[] = [];
    const coordinator = ArtifactReconciliationCoordinator.start(
      options(database, storage, (error) => failures.push(error)),
    );

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN",
      requiresFailStop: true,
    });
    expect(database.events).not.toContain("db:recordArtifactCleanupFailure");
    expect(database.events).not.toContain("db:completeArtifactCleanup");
    expect(failures).toHaveLength(1);
  });

  it("replays cleanup after restart when DB completion was uncertain", async () => {
    const firstDatabase = new FakeDatabase();
    firstDatabase.items = [cleanupItem()];
    firstDatabase.completeError = new Error("injected response loss");
    const firstStorage = new FakeStorage();
    firstStorage.cleanupResult = () =>
      Promise.resolve({
        stagingRemoved: true,
        publicationTemporariesRemoved: 0,
      });
    const first = ArtifactReconciliationCoordinator.start(options(firstDatabase, firstStorage));
    await expect(first.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_DATABASE_FAILURE",
    });
    expect(firstDatabase.events).not.toContain("db:recordArtifactCleanupFailure");

    const replayDatabase = new FakeDatabase();
    replayDatabase.items = [cleanupItem()];
    const replayStorage = new FakeStorage();
    const replay = ArtifactReconciliationCoordinator.start(options(replayDatabase, replayStorage));
    await replay.firstPass;
    expect(replayDatabase.events).toContain("db:completeArtifactCleanup");
    await replay.close();
  });

  it("stops new ticks and waits for accepted cleanup before closing", async () => {
    const database = new FakeDatabase();
    database.items = [cleanupItem()];
    const storage = new FakeStorage();
    const cleanup = Promise.withResolvers<{
      stagingRemoved: boolean;
      publicationTemporariesRemoved: number;
    }>();
    storage.cleanupResult = () => cleanup.promise;
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));
    await storage.cleanupStarted.promise;

    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    cleanup.resolve({ stagingRemoved: false, publicationTemporariesRemoved: 0 });
    await closing;

    const eventCount = database.events.length + storage.events.length;
    await Promise.resolve();
    expect(database.events.length + storage.events.length).toBe(eventCount);
  });

  it("makes an accepted pass visible before a database callback can reenter close", async () => {
    const database = new FakeDatabase();
    const storage = new FakeStorage();
    const closeStarted = Promise.withResolvers<void>();
    let coordinator!: ArtifactReconciliationCoordinator;
    let closing: Promise<void> | undefined;
    database.onRequest = (operation) => {
      if (operation === "terminalizeInactiveArtifactUploads") {
        closing = coordinator.close();
        closeStarted.resolve();
      }
    };
    coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await closeStarted.promise;
    expect(closing).toBeInstanceOf(Promise);
    if (closing === undefined) {
      throw new Error("Reentrant close was not captured.");
    }
    await coordinator.firstPass;
    await closing;
    expect(database.events).toEqual([
      "db:terminalizeInactiveArtifactUploads",
      "db:listDueArtifactCleanups",
      "db:readArtifactReconciliationCursor",
      "db:classifyArtifactNamespacePageAndAdvanceCursor",
      "db:listDueArtifactNamespaceCleanups",
      "db:readArtifactHealthAccounting",
    ]);
  });

  it("interrupts in-flight cleanup on owner exit and ignores its late success", async () => {
    const database = new FakeDatabase();
    database.items = [cleanupItem()];
    const storage = new FakeStorage();
    const cleanup = Promise.withResolvers<{
      stagingRemoved: boolean;
      publicationTemporariesRemoved: number;
    }>();
    storage.cleanupResult = () => cleanup.promise;
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));
    await storage.cleanupStarted.promise;

    storage.ownerExitSignal.resolve(1);
    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_OWNER_EXIT",
    });
    cleanup.resolve({ stagingRemoved: true, publicationTemporariesRemoved: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(database.events).not.toContain("db:completeArtifactCleanup");
  });

  it("does not dispatch database or storage work when the owner is already dead", async () => {
    const database = new FakeDatabase();
    database.items = [cleanupItem()];
    const storage = new FakeStorage(Promise.resolve(1));
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_OWNER_EXIT",
    });
    expect(database.events).toEqual([]);
    expect(storage.events).toEqual([]);
  });

  it("does not let nested startup microtasks outrun owner-exit observation", async () => {
    const database = new FakeDatabase();
    const storage = new FakeStorage();
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));
    queueMicrotask(() => queueMicrotask(() => storage.ownerExitSignal.resolve(1)));

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_OWNER_EXIT",
    });
    expect(database.events).toEqual([]);
    expect(storage.events).toEqual([]);
  });

  it("does not let an externally fabricated coordinator error bypass fail-stop", async () => {
    const database = new FakeDatabase();
    database.items = [cleanupItem()];
    const storage = new FakeStorage();
    storage.cleanupResult = () =>
      Promise.reject(
        new ArtifactReconciliationCoordinatorError("ARTIFACT_RECONCILIATION_DATABASE_FAILURE"),
      );
    const failures: Error[] = [];
    const coordinator = ArtifactReconciliationCoordinator.start(
      options(database, storage, (error) => failures.push(error)),
    );

    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: "ARTIFACT_RECONCILIATION_STORAGE_OUTCOME_UNKNOWN",
    });
  });

  it("observes an exit queued against close instead of swallowing it as closed", async () => {
    const database = new FakeDatabase();
    const storage = new FakeStorage();
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));
    storage.ownerExitSignal.resolve(1);

    await expect(coordinator.close()).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_OWNER_EXIT",
    });
    expect(database.events).toEqual([]);
  });

  it("rejects close when nested microtasks settle owner exit before its next-turn boundary", async () => {
    const database = new FakeDatabase();
    const storage = new FakeStorage();
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));
    const closing = coordinator.close();
    queueMicrotask(() => queueMicrotask(() => storage.ownerExitSignal.resolve(1)));

    await expect(closing).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_OWNER_EXIT",
    });
    await expect(coordinator.firstPass).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_OWNER_EXIT",
    });
    await expect(coordinator.close()).rejects.toMatchObject({
      code: "ARTIFACT_RECONCILIATION_OWNER_EXIT",
    });
    expect(database.events).toEqual([]);
    expect(storage.events).toEqual([]);
  });

  it("reads and binds every owner and option property exactly once", async () => {
    const databaseTarget = new FakeDatabase();
    const storageTarget = new FakeStorage();
    const reads = new Map<string, number>();
    const once =
      <T>(name: string, value: T): (() => T) =>
      () => {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return value;
      };
    const database = Object.create(null) as FakeArtifactReconciliationDatabaseOwner;
    Object.defineProperty(database, "request", {
      enumerable: true,
      get: once(
        "database.request",
        (operation: CleanupDatabaseOperation, input: unknown): Promise<unknown> =>
          Reflect.apply(databaseTarget.request, databaseTarget, [
            operation,
            input,
          ]) as Promise<unknown>,
      ),
    });
    const storage = Object.create(null) as ArtifactReconciliationStorageOwner;
    Object.defineProperties(storage, {
      ownerExit: { enumerable: true, get: once("storage.ownerExit", storageTarget.ownerExit) },
      cleanupUpload: {
        enumerable: true,
        get: once("storage.cleanupUpload", () => storageTarget.cleanupUpload()),
      },
      scanNamespacePage: {
        enumerable: true,
        get: once("storage.scanNamespacePage", (input: ArtifactNamespaceScanPageInput) =>
          storageTarget.scanNamespacePage(input),
        ),
      },
      closeNamespaceScan: {
        enumerable: true,
        get: once("storage.closeNamespaceScan", (input: CloseArtifactNamespaceScanInput) =>
          storageTarget.closeNamespaceScan(input),
        ),
      },
      cleanupNamespaceEntry: {
        enumerable: true,
        get: once("storage.cleanupNamespaceEntry", (input: ArtifactNamespaceObservation) =>
          storageTarget.cleanupNamespaceEntry(input),
        ),
      },
    });
    const raw = Object.create(null) as Record<string, unknown>;
    for (const [name, value] of Object.entries(options(database, storage))) {
      Object.defineProperty(raw, name, { enumerable: true, get: once(`options.${name}`, value) });
    }

    const coordinator = ArtifactReconciliationCoordinator.start(
      raw as unknown as Parameters<typeof ArtifactReconciliationCoordinator.start>[0],
    );
    await coordinator.firstPass;
    await coordinator.close();

    expect(Object.fromEntries(reads)).toEqual({
      "options.database": 1,
      "options.storage": 1,
      "options.batchSize": 1,
      "options.intervalMilliseconds": 1,
      "options.passTimeoutMilliseconds": 1,
      "options.closeTimeoutMilliseconds": 1,
      "options.initialRetryDelaySeconds": 1,
      "options.maximumRetryDelaySeconds": 1,
      "options.onFailStop": 1,
      "database.request": 1,
      "storage.cleanupUpload": 1,
      "storage.scanNamespacePage": 1,
      "storage.closeNamespaceScan": 1,
      "storage.cleanupNamespaceEntry": 1,
      "storage.ownerExit": 1,
    });
  });
});
