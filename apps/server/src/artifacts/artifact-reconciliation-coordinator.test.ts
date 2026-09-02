import { describe, expect, it } from "vitest";
import {
  ArtifactReconciliationCoordinator,
  ArtifactReconciliationCoordinatorError,
  type ArtifactReconciliationDatabaseOwner,
  type ArtifactReconciliationStorageOwner,
} from "../../dist/artifacts/artifact-reconciliation-coordinator.js";
import { ArtifactStorageClientError } from "../../dist/artifacts/errors.js";
import type { ArtifactCleanupWorkItem } from "../../dist/database/artifacts.js";
import type { DatabaseOperationMap } from "../../dist/database/protocol.js";

type CleanupDatabaseOperation =
  | "completeArtifactCleanup"
  | "listDueArtifactCleanups"
  | "readArtifactHealthAccounting"
  | "recordArtifactCleanupFailure"
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

class FakeDatabase implements ArtifactReconciliationDatabaseOwner {
  readonly events: string[] = [];
  readonly inputs: unknown[] = [];
  items: ArtifactCleanupWorkItem[] = [];
  terminalHasMore = false;
  cleanupHasMore = false;
  completeError: Error | undefined;
  onRequest: ((operation: CleanupDatabaseOperation) => void) | undefined;

  async request<TOperation extends CleanupDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    this.events.push(`db:${operation}`);
    this.inputs.push(input);
    this.onRequest?.(operation);
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
        result = emptyHealth();
        break;
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

  constructor(ownerExit?: Promise<number>) {
    this.ownerExit = ownerExit ?? this.ownerExitSignal.promise;
  }

  cleanupUpload(): Promise<{ stagingRemoved: boolean; publicationTemporariesRemoved: number }> {
    this.events.push("storage:cleanup");
    this.cleanupStarted.resolve();
    return this.cleanupResult();
  }
}

const options = (
  database: ArtifactReconciliationDatabaseOwner,
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

describe("ArtifactReconciliationCoordinator", () => {
  it("runs immediately, completes ENOENT-equivalent cleanup, and freezes health", async () => {
    const database = new FakeDatabase();
    database.items = [cleanupItem()];
    const storage = new FakeStorage();
    const coordinator = ArtifactReconciliationCoordinator.start(options(database, storage));

    await coordinator.firstPass;

    expect(database.events).toEqual([
      "db:terminalizeInactiveArtifactUploads",
      "db:listDueArtifactCleanups",
      "db:completeArtifactCleanup",
      "db:readArtifactHealthAccounting",
    ]);
    expect(storage.events).toEqual(["storage:cleanup"]);
    expect(coordinator.health).toEqual(emptyHealth());
    expect(Object.isFrozen(coordinator.health)).toBe(true);
    expect(Object.isFrozen(coordinator.health?.cleanup)).toBe(true);
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
    const database = Object.create(null) as ArtifactReconciliationDatabaseOwner;
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
      "storage.ownerExit": 1,
    });
  });
});
