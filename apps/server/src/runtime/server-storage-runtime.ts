import {
  type ArtifactCompletionPort,
  ArtifactStorageClient,
  ArtifactTransactionCoordinator,
  type ArtifactTransactionCoordinatorError,
  type ArtifactTransactionPort,
} from "../artifacts/index.js";
import type { ArtifactRuntimeConfig } from "../config.js";
import { DatabaseClient } from "../database/database-client.js";
import { DatabaseOwnerLock } from "../database/owner-lock.js";
import {
  createServerBindingTrustedIssuerDescriptorFromSignerV1,
  ServerBindingCoordinatorV1,
} from "../enrollment/server-binding-coordinator-v1.js";
import {
  closeUnadoptedServerBindingSignerV1,
  type ServerBindingSignerContextV1,
} from "../enrollment/server-binding-signer-v1.js";

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
  bindingSignerCleanupTimeoutMilliseconds: 30_000,
});
const quarantinedDatabaseOwnerLocks = new Set<DatabaseOwnerLock>();

const quarantineDatabaseOwnerLockUntilExit = (
  ownerLock: DatabaseOwnerLock,
  ownerExit: Promise<number>,
): void => {
  quarantinedDatabaseOwnerLocks.add(ownerLock);
  void ownerExit.then(
    async (exitCode) => {
      if (!Number.isSafeInteger(exitCode) || exitCode < 0) return;
      try {
        await ownerLock.close();
        quarantinedDatabaseOwnerLocks.delete(ownerLock);
      } catch {
        // Retain the lock until process termination if explicit release cannot be proven.
      }
    },
    () => {
      // Retain the lock until process termination when owner exit cannot be proven.
    },
  );
};

const quarantineRawOwnersUntilStorageExit = (
  ownerLock: DatabaseOwnerLock,
  storageOwnerExit: Promise<number>,
  database: DatabaseClient | undefined,
  failedDatabaseOwnerExit: Promise<number> | undefined,
): void => {
  quarantinedDatabaseOwnerLocks.add(ownerLock);
  void storageOwnerExit.then(
    async (exitCode) => {
      if (!Number.isSafeInteger(exitCode) || exitCode < 0) return;
      if (database !== undefined) {
        try {
          await database.close();
        } catch {
          quarantineDatabaseOwnerLockUntilExit(ownerLock, database.ownerExit);
          return;
        }
      } else if (failedDatabaseOwnerExit !== undefined) {
        quarantineDatabaseOwnerLockUntilExit(ownerLock, failedDatabaseOwnerExit);
        return;
      }
      try {
        await ownerLock.close();
        quarantinedDatabaseOwnerLocks.delete(ownerLock);
      } catch {
        // Retain the lock until process termination if explicit release cannot be proven.
      }
    },
    () => {
      // Retain the lock until process termination when storage exit cannot be proven.
    },
  );
};

export interface ServerStorageRuntime {
  readonly database: DatabaseClient;
  readonly artifactReadiness: {
    read(): Readonly<{ readonly ready: boolean }>;
  };
  readonly artifactTransactions: ArtifactTransactionPort;
  readonly artifactCompletion: ArtifactCompletionPort;
  close(): Promise<void>;
}

export interface CreateServerStorageRuntimeOptions {
  readonly databasePath: string;
  readonly migrationsDirectory: string;
  readonly artifactStorage: ArtifactRuntimeConfig;
  readonly serverBindingSigner?: Readonly<ServerBindingSignerContextV1>;
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
  const serverBindingSigner = options.serverBindingSigner;
  return Object.freeze({
    databasePath,
    migrationsDirectory,
    artifactStorage: Object.freeze({ rootPath, capacity: capacitySnapshot }),
    ...(serverBindingSigner === undefined ? {} : { serverBindingSigner }),
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
  failedDatabaseOwnerExit: Promise<number> | undefined,
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

  if (!storageExitProven) {
    const unresolvedStorageExit = storage?.ownerExit ?? failedStorageOwnerExit;
    if (ownerLock !== undefined && unresolvedStorageExit !== undefined) {
      quarantineRawOwnersUntilStorageExit(
        ownerLock,
        unresolvedStorageExit,
        database,
        failedDatabaseOwnerExit,
      );
    }
    return errors;
  }

  let databaseExitProven = database === undefined && failedDatabaseOwnerExit === undefined;
  if (database !== undefined) {
    try {
      await database.close();
      databaseExitProven = true;
    } catch (error) {
      errors.push(error);
      try {
        await waitForOwnerExit(database.ownerExit);
        databaseExitProven = true;
      } catch (exitError) {
        errors.push(exitError);
      }
    }
  } else if (failedDatabaseOwnerExit !== undefined) {
    try {
      await waitForOwnerExit(failedDatabaseOwnerExit);
      databaseExitProven = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (!databaseExitProven) {
    const unresolvedOwnerExit = database?.ownerExit ?? failedDatabaseOwnerExit;
    if (ownerLock !== undefined && unresolvedOwnerExit !== undefined) {
      quarantineDatabaseOwnerLockUntilExit(ownerLock, unresolvedOwnerExit);
    }
    return errors;
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

const closeUnadoptedSignerDuringStartup = async (
  signer: Readonly<ServerBindingSignerContextV1>,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closeUnadoptedServerBindingSignerV1(signer),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Server binding signer startup cleanup timed out.")),
          policy.bindingSignerCleanupTimeoutMilliseconds,
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
  let failedDatabaseOwnerExit: Promise<number> | undefined;
  let storage: ArtifactStorageClient | undefined;
  let failedStorageOwnerExit: Promise<number> | undefined;
  let serverBindingCoordinator: ServerBindingCoordinatorV1 | undefined;
  let coordinator: ArtifactTransactionCoordinator | undefined;
  let ownership: "untransferred" | "transferring" | "coordinator" = "untransferred";

  try {
    ownerLock = await DatabaseOwnerLock.acquire(snapshot.databasePath);
    database = await DatabaseClient.create({
      databasePath: ownerLock.databasePath,
      migrationsDirectory: snapshot.migrationsDirectory,
      ...(snapshot.serverBindingSigner === undefined
        ? {}
        : {
            serverBindingTrustedIssuer: createServerBindingTrustedIssuerDescriptorFromSignerV1(
              snapshot.serverBindingSigner,
            ),
          }),
    });
    ownerLock.assertReady();
    serverBindingCoordinator = new ServerBindingCoordinatorV1({
      database: database.createServerBindingPersistenceDatabaseHandle(),
      ...(snapshot.serverBindingSigner === undefined
        ? {}
        : { signer: snapshot.serverBindingSigner }),
    });
    await serverBindingCoordinator.open();
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
    const activeServerBindingCoordinator = serverBindingCoordinator;
    const activeDatabase = database;
    const artifactTransactions = Object.freeze({
      createArtifactUpload: (input, signal) =>
        activeCoordinator.createArtifactUpload(input, signal),
      putArtifactChunk: (uploadId, input, signal) =>
        activeCoordinator.putArtifactChunk(uploadId, input, signal),
      finalizeArtifactUpload: (uploadId, input, signal) =>
        activeCoordinator.finalizeArtifactUpload(uploadId, input, signal),
      terminateArtifactUpload: (uploadId, input, signal) =>
        activeCoordinator.terminateArtifactUpload(uploadId, input, signal),
    } satisfies ArtifactTransactionPort);
    const artifactCompletion = Object.freeze({
      completeArtifactRun: (input, signal) => activeCoordinator.completeArtifactRun(input, signal),
    } satisfies ArtifactCompletionPort);
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        const bindingClose = activeServerBindingCoordinator.close();
        const artifactClose = bindingClose.then(
          () => activeCoordinator.close(),
          () => activeCoordinator.close(),
        );
        const settled = await Promise.allSettled([bindingClose, artifactClose]);
        const errors = settled.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Server storage owners failed to close.");
        }
      })();
      return closePromise;
    };
    return Object.freeze({
      database: activeDatabase,
      artifactReadiness: Object.freeze({
        read: () => Object.freeze({ ready: activeCoordinator.readiness.ready }),
      }),
      artifactTransactions,
      artifactCompletion,
      close,
    });
  } catch (error) {
    if (
      database === undefined &&
      error instanceof Error &&
      "ownerExit" in error &&
      error.ownerExit instanceof Promise
    ) {
      failedDatabaseOwnerExit = error.ownerExit as Promise<number>;
    }
    if (ownership === "coordinator" && coordinator !== undefined) {
      const cleanupCoordinator = coordinator;
      const bindingClose = serverBindingCoordinator?.close() ?? Promise.resolve();
      const artifactClose = bindingClose.then(
        () => cleanupCoordinator.close(),
        () => cleanupCoordinator.close(),
      );
      const settled = await Promise.allSettled([bindingClose, artifactClose]);
      const cleanupErrors = settled.flatMap((result) => {
        if (result.status !== "rejected") return [];
        if (result.reason === error) return [];
        return [result.reason];
      });
      if (cleanupErrors.length !== 0) throwStartupFailure(error, cleanupErrors);
      throw error;
    }
    const coordinatorCleanupErrors: unknown[] = [];
    if (serverBindingCoordinator !== undefined) {
      try {
        await serverBindingCoordinator.close();
      } catch (cleanupError) {
        if (cleanupError !== error) {
          coordinatorCleanupErrors.push(cleanupError);
        }
      }
    } else if (snapshot.serverBindingSigner !== undefined) {
      try {
        await closeUnadoptedSignerDuringStartup(snapshot.serverBindingSigner);
      } catch (cleanupError) {
        if (cleanupError !== error) {
          coordinatorCleanupErrors.push(cleanupError);
        }
      }
    }
    const cleanupErrors = await closeRawOwners(
      storage,
      failedStorageOwnerExit,
      database,
      failedDatabaseOwnerExit,
      ownerLock,
    );
    return throwStartupFailure(error, [...coordinatorCleanupErrors, ...cleanupErrors]);
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
