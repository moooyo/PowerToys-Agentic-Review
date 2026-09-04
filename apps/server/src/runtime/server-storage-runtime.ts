import { DatabaseClient } from "../database/database-client.js";
import { DatabaseOwnerLock } from "../database/owner-lock.js";

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
}

export interface CreateRecoveryMaintenanceStorageRuntimeOptions {
  readonly databasePath: string;
  readonly migrationsDirectory: string;
}

const snapshotOptions = <T extends CreateServerStorageRuntimeOptions>(options: T): T => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Server storage runtime options must be an object.");
  }
  return Object.freeze({
    databasePath: options.databasePath,
    migrationsDirectory: options.migrationsDirectory,
  }) as T;
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
): Promise<ServerStorageRuntime> => createDatabaseOnlyRuntime(options);

export const createServerStorageRuntime = (
  options: CreateServerStorageRuntimeOptions,
): Promise<ServerStorageRuntime> => createDatabaseOnlyRuntime(options);
