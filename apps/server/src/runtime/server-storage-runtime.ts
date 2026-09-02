import {
  ArtifactStorageClient,
  ArtifactTransactionCoordinator,
  type ArtifactTransactionCoordinatorError,
} from "../artifacts/index.js";
import type { ArtifactRuntimeConfig } from "../config.js";
import { DatabaseClient } from "../database/database-client.js";
import { DatabaseOwnerLock } from "../database/owner-lock.js";

const policy = Object.freeze({
  storageCloseTimeoutMilliseconds: 30_000,
  storageStartupTimeoutMilliseconds: 30_000,
  storageRequestTimeoutMilliseconds: 30_000,
  storageShutdownTimeoutMilliseconds: 30_000,
  storageExitTimeoutMilliseconds: 10_000,
  transactionRequestTimeoutMilliseconds: 40_000,
  transactionCloseTimeoutMilliseconds: 60_000,
  maximumPendingTransactions: 64,
  reconciliationBatchSize: 64,
  reconciliationMaximumNamespacePagesPerSession: 4,
  reconciliationIntervalMilliseconds: 15_000,
  reconciliationPassTimeoutMilliseconds: 60_000,
  reconciliationInitialRetryDelaySeconds: 30,
  reconciliationMaximumRetryDelaySeconds: 300,
  initialSweepTimeoutMilliseconds: 120_000,
  constructionOwnerExitTimeoutMilliseconds: 30_000,
});

export interface ServerStorageRuntime {
  readonly database: DatabaseClient;
  readonly artifactReadiness: {
    read(): Readonly<{ readonly ready: boolean }>;
  };
  close(): Promise<void>;
}

export interface CreateServerStorageRuntimeOptions {
  readonly databasePath: string;
  readonly migrationsDirectory: string;
  readonly artifactStorage: ArtifactRuntimeConfig;
  readonly onFailStop: (error: ArtifactTransactionCoordinatorError) => void | Promise<void>;
}

type ServerStorageRuntimeSnapshot = CreateServerStorageRuntimeOptions;

const snapshotOptions = (
  options: CreateServerStorageRuntimeOptions,
): ServerStorageRuntimeSnapshot => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Server storage runtime options must be an object.");
  }
  const databasePath = options.databasePath;
  const migrationsDirectory = options.migrationsDirectory;
  const artifactStorage = options.artifactStorage;
  const onFailStop = options.onFailStop;
  if (typeof artifactStorage !== "object" || artifactStorage === null) {
    throw new TypeError("Server artifact storage options must be an object.");
  }
  const rootPath = artifactStorage.rootPath;
  const capacity = artifactStorage.capacity;
  if (typeof capacity !== "object" || capacity === null) {
    throw new TypeError("Server artifact capacity options must be an object.");
  }
  const capacitySnapshot = Object.freeze({
    hardBytes: capacity.hardBytes,
    hardEntries: capacity.hardEntries,
    emergencyReserveBytes: capacity.emergencyReserveBytes,
    perUploadMetadataHeadroomBytes: capacity.perUploadMetadataHeadroomBytes,
    cleanupBacklogHighWaterEntries: capacity.cleanupBacklogHighWaterEntries,
  });
  if (typeof onFailStop !== "function") {
    throw new TypeError("Server storage fail-stop observer must be a function.");
  }
  return Object.freeze({
    databasePath,
    migrationsDirectory,
    artifactStorage: Object.freeze({ rootPath, capacity: capacitySnapshot }),
    onFailStop,
  });
};

const waitForOwnerExit = async (ownerExit: Promise<number>): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const exitCode = await Promise.race([
      ownerExit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Artifact storage owner exit was not observed during startup rollback."),
            ),
          policy.constructionOwnerExitTimeoutMilliseconds,
        );
        timer.unref();
      }),
    ]);
    if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
      throw new Error(
        "Artifact storage owner returned an invalid exit status during startup rollback.",
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const closeRawOwners = async (
  storage: ArtifactStorageClient | undefined,
  failedStorageOwnerExit: Promise<number> | undefined,
  database: DatabaseClient | undefined,
  ownerLock: DatabaseOwnerLock | undefined,
): Promise<unknown[]> => {
  const errors: unknown[] = [];
  let storageExitProven = storage === undefined && failedStorageOwnerExit === undefined;

  if (storage !== undefined) {
    try {
      await storage.close();
      storageExitProven = true;
    } catch (error) {
      errors.push(error);
      try {
        await waitForOwnerExit(storage.ownerExit);
        storageExitProven = true;
      } catch (exitError) {
        errors.push(exitError);
      }
    }
  } else if (failedStorageOwnerExit !== undefined) {
    try {
      await waitForOwnerExit(failedStorageOwnerExit);
      storageExitProven = true;
    } catch (error) {
      errors.push(error);
    }
  }

  if (!storageExitProven) return errors;

  if (database !== undefined) {
    try {
      await database.close();
    } catch (error) {
      errors.push(error);
      return errors;
    }
  }
  if (ownerLock !== undefined) {
    try {
      await ownerLock.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

const awaitInitialSweep = async (
  ready: Promise<void>,
  timeoutMilliseconds: number,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Artifact storage initial reconciliation sweep timed out.")),
          timeoutMilliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const throwStartupFailure = (error: unknown, cleanupErrors: readonly unknown[]): never => {
  if (cleanupErrors.length === 0) throw error;
  throw new AggregateError(
    [error, ...cleanupErrors],
    "Server storage startup and ownership cleanup both failed.",
    { cause: error },
  );
};

const createServerStorageRuntimeFromSnapshot = async (
  snapshot: ServerStorageRuntimeSnapshot,
  initialSweepTimeoutMilliseconds: number,
): Promise<ServerStorageRuntime> => {
  let ownerLock: DatabaseOwnerLock | undefined;
  let database: DatabaseClient | undefined;
  let storage: ArtifactStorageClient | undefined;
  let failedStorageOwnerExit: Promise<number> | undefined;
  let coordinator: ArtifactTransactionCoordinator | undefined;
  let ownership: "untransferred" | "transferring" | "coordinator" = "untransferred";

  try {
    ownerLock = await DatabaseOwnerLock.acquire(snapshot.databasePath);
    database = await DatabaseClient.create({
      databasePath: ownerLock.databasePath,
      migrationsDirectory: snapshot.migrationsDirectory,
    });
    ownerLock.assertReady();
    try {
      storage = await ArtifactStorageClient.create({
        storage: {
          rootPath: snapshot.artifactStorage.rootPath,
          capacity: snapshot.artifactStorage.capacity,
          closeTimeoutMilliseconds: policy.storageCloseTimeoutMilliseconds,
        },
        startupTimeoutMilliseconds: policy.storageStartupTimeoutMilliseconds,
        requestTimeoutMilliseconds: policy.storageRequestTimeoutMilliseconds,
        shutdownTimeoutMilliseconds: policy.storageShutdownTimeoutMilliseconds,
        exitTimeoutMilliseconds: policy.storageExitTimeoutMilliseconds,
      });
    } catch (error) {
      if (error instanceof Error && "ownerExit" in error && error.ownerExit instanceof Promise) {
        failedStorageOwnerExit = error.ownerExit as Promise<number>;
      }
      throw error;
    }

    const databaseHandle = database.createArtifactTransactionDatabaseHandle();
    const storageHandle = storage.createArtifactTransactionStorageHandle();
    const ownerLockHandle = ownerLock.createArtifactTransactionOwnerLockHandle();
    ownership = "transferring";
    coordinator = await ArtifactTransactionCoordinator.create({
      database: databaseHandle,
      storage: storageHandle,
      databaseOwnerLock: ownerLockHandle,
      storageCapacity: snapshot.artifactStorage.capacity,
      requestTimeoutMilliseconds: policy.transactionRequestTimeoutMilliseconds,
      closeTimeoutMilliseconds: policy.transactionCloseTimeoutMilliseconds,
      storageJoinTimeoutMilliseconds: policy.storageExitTimeoutMilliseconds,
      maximumPendingTransactions: policy.maximumPendingTransactions,
      reconciliationBatchSize: policy.reconciliationBatchSize,
      reconciliationMaximumNamespacePagesPerSession:
        policy.reconciliationMaximumNamespacePagesPerSession,
      reconciliationIntervalMilliseconds: policy.reconciliationIntervalMilliseconds,
      reconciliationPassTimeoutMilliseconds: policy.reconciliationPassTimeoutMilliseconds,
      reconciliationInitialRetryDelaySeconds: policy.reconciliationInitialRetryDelaySeconds,
      reconciliationMaximumRetryDelaySeconds: policy.reconciliationMaximumRetryDelaySeconds,
      onFailStop: snapshot.onFailStop,
    });
    ownership = "coordinator";
    await awaitInitialSweep(coordinator.ready, initialSweepTimeoutMilliseconds);

    const activeCoordinator = coordinator;
    const activeDatabase = database;
    return Object.freeze({
      database: activeDatabase,
      artifactReadiness: Object.freeze({
        read: () => Object.freeze({ ready: activeCoordinator.readiness.ready }),
      }),
      close: () => activeCoordinator.close(),
    });
  } catch (error) {
    if (ownership === "coordinator" && coordinator !== undefined) {
      try {
        await coordinator.close();
      } catch (cleanupError) {
        throwStartupFailure(error, [cleanupError]);
      }
      throw error;
    }
    const cleanupErrors = await closeRawOwners(
      storage,
      failedStorageOwnerExit,
      database,
      ownerLock,
    );
    return throwStartupFailure(error, cleanupErrors);
  }
};

export const createServerStorageRuntime = (
  options: CreateServerStorageRuntimeOptions,
): Promise<ServerStorageRuntime> =>
  createServerStorageRuntimeFromSnapshot(
    snapshotOptions(options),
    policy.initialSweepTimeoutMilliseconds,
  );

/** @internal Imported only by the source-excluded testing adapter. */
export const createServerStorageRuntimeWithInitialSweepTimeoutForTest = (
  options: CreateServerStorageRuntimeOptions,
  initialSweepTimeoutMilliseconds: number,
): Promise<ServerStorageRuntime> => {
  if (
    !Number.isSafeInteger(initialSweepTimeoutMilliseconds) ||
    initialSweepTimeoutMilliseconds < 1 ||
    initialSweepTimeoutMilliseconds > policy.initialSweepTimeoutMilliseconds
  ) {
    throw new TypeError("Server storage initial sweep test timeout is invalid.");
  }
  return createServerStorageRuntimeFromSnapshot(
    snapshotOptions(options),
    initialSweepTimeoutMilliseconds,
  );
};
