import { DatabaseClient } from "../database/database-client.js";
import type { EvidenceStorageOptions } from "../database/evidence-assets.js";
import { DatabaseOwnerLock } from "../database/owner-lock.js";
import type { DatabaseWorkerOptions } from "../database/protocol.js";

const policy = Object.freeze({
  constructionOwnerExitTimeoutMilliseconds: 30_000,
});

export interface ServerStorageRuntime {
  readonly database: DatabaseClient;
  close(): Promise<void>;
}

export interface CreateServerStorageRuntimeOptions {
  readonly databasePath: string;
  readonly migrationsDirectory: string;
  readonly evidenceStorage?: EvidenceStorageOptions;
  readonly operatorAccess?: DatabaseWorkerOptions["operatorAccess"];
  readonly publicationPublisher?: DatabaseWorkerOptions["publicationPublisher"];
}

export interface CreateRecoveryMaintenanceStorageRuntimeOptions
  extends CreateServerStorageRuntimeOptions {}

const snapshotOptions = (
  options: CreateServerStorageRuntimeOptions,
): CreateServerStorageRuntimeOptions => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Server storage runtime options must be an object.");
  }
  const evidenceStorage = options.evidenceStorage;
  const operatorAccess = options.operatorAccess;
  const publisher = options.publicationPublisher;
  if (
    publisher !== undefined &&
    (!Number.isSafeInteger(publisher.githubUserId) || publisher.githubUserId <= 0)
  )
    throw new TypeError(
      "The configured publication publisher must have a positive safe numeric identity.",
    );
  return Object.freeze({
    databasePath: options.databasePath,
    migrationsDirectory: options.migrationsDirectory,
    ...(publisher === undefined
      ? {}
      : { publicationPublisher: Object.freeze({ githubUserId: publisher.githubUserId }) }),
    ...(operatorAccess === undefined
      ? {}
      : {
          operatorAccess: Object.freeze({
            administrators: Object.freeze(
              operatorAccess.administrators.map(({ issuer, subject }) =>
                Object.freeze({ issuer, subject }),
              ),
            ),
          }),
        }),
    ...(evidenceStorage === undefined
      ? {}
      : {
          evidenceStorage: Object.freeze({
            evidenceDirectory: evidenceStorage.evidenceDirectory,
            globalQuotaBytes: evidenceStorage.globalQuotaBytes,
            globalAssetLimit: evidenceStorage.globalAssetLimit,
            retentionMs: evidenceStorage.retentionMs,
            incompleteUploadTtlMs: evidenceStorage.incompleteUploadTtlMs,
          }),
        }),
  });
};

const waitForOwnerExit = async (ownerExit: Promise<number>): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const exitCode = await Promise.race([
      ownerExit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Database owner exit was not observed during startup rollback.")),
          policy.constructionOwnerExitTimeoutMilliseconds,
        );
        timer.unref();
      }),
    ]);
    if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
      throw new Error("Database owner returned an invalid exit status during startup rollback.");
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const closeRawOwners = async (
  database: DatabaseClient | undefined,
  failedDatabaseOwnerExit: Promise<number> | undefined,
  ownerLock: DatabaseOwnerLock | undefined,
): Promise<unknown[]> => {
  const errors: unknown[] = [];
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

const throwStartupFailure = (error: unknown, cleanupErrors: readonly unknown[]): never => {
  if (cleanupErrors.length === 0) {
    throw error;
  }
  throw new AggregateError(
    [error, ...cleanupErrors],
    "Server database startup and ownership cleanup both failed.",
    { cause: error },
  );
};

const createDatabaseOnlyRuntime = async (
  options: CreateServerStorageRuntimeOptions,
  recoveryMaintenance: boolean,
): Promise<ServerStorageRuntime> => {
  const snapshot = snapshotOptions(options);
  let ownerLock: DatabaseOwnerLock | undefined;
  let database: DatabaseClient | undefined;
  let failedDatabaseOwnerExit: Promise<number> | undefined;

  try {
    ownerLock = await DatabaseOwnerLock.acquire(snapshot.databasePath);
    database = await DatabaseClient.create({
      databasePath: ownerLock.databasePath,
      migrationsDirectory: snapshot.migrationsDirectory,
      ...(recoveryMaintenance ? { recoveryMaintenance: true } : {}),
      ...(snapshot.operatorAccess === undefined ? {} : { operatorAccess: snapshot.operatorAccess }),
      ...(snapshot.publicationPublisher === undefined
        ? {}
        : { publicationPublisher: snapshot.publicationPublisher }),
      ...(snapshot.evidenceStorage === undefined
        ? {}
        : { evidenceStorage: snapshot.evidenceStorage }),
    });
    ownerLock.assertReady();

    const activeDatabase = database;
    const activeOwnerLock = ownerLock;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        const cleanupErrors = await closeRawOwners(activeDatabase, undefined, activeOwnerLock);
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "Server database storage shutdown failed.");
        }
      })();
      return closePromise;
    };

    return Object.freeze({
      database: activeDatabase,
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
    const cleanupErrors = await closeRawOwners(database, failedDatabaseOwnerExit, ownerLock);
    return throwStartupFailure(error, cleanupErrors);
  }
};

export const createRecoveryMaintenanceStorageRuntime = (
  options: CreateRecoveryMaintenanceStorageRuntimeOptions,
): Promise<ServerStorageRuntime> => createDatabaseOnlyRuntime(options, true);

export const createServerStorageRuntime = (
  options: CreateServerStorageRuntimeOptions,
): Promise<ServerStorageRuntime> => createDatabaseOnlyRuntime(options, false);
