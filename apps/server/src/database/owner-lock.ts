import { DatabaseSync } from "node:sqlite";
import {
  assertPrivateRegularFile,
  assertPrivateSqliteSidecars,
  assertSecureDatabaseOwnerPlatform,
  createPrivateRegularFile,
  DatabaseStorageBinding,
  type FileIdentity,
} from "./storage-security.js";

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  (("errcode" in error && error.errcode === 5) ||
    error.message.toLowerCase().includes("database is locked"));

interface OwnerLockDatabaseHandle {
  readonly isTransaction: boolean;
  close(): void;
  exec(sql: string): void;
}

export interface OwnerLockCloseAttempt {
  readonly closeSucceeded: boolean;
  readonly errors: readonly unknown[];
}

export const closeOwnerLockDatabase = (
  database: OwnerLockDatabaseHandle,
): OwnerLockCloseAttempt => {
  const errors: unknown[] = [];
  try {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
  } catch (error) {
    errors.push(error);
  }

  let closeSucceeded = false;
  try {
    database.close();
    closeSucceeded = true;
  } catch (error) {
    errors.push(error);
  }
  return { closeSucceeded, errors };
};

export const closeOwnerLockDatabaseWithRetries = (
  database: OwnerLockDatabaseHandle,
  maximumAttempts = 3,
): OwnerLockCloseAttempt => {
  const errors: unknown[] = [];
  for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
    const attempt = closeOwnerLockDatabase(database);
    errors.push(...attempt.errors);
    if (attempt.closeSucceeded) {
      return { closeSucceeded: true, errors };
    }
  }
  return { closeSucceeded: false, errors };
};

const throwCloseErrors = (errors: readonly unknown[], message: string): void => {
  if (errors.length === 0) {
    return;
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  throw new AggregateError(errors, message);
};

export class DatabaseOwnerLock {
  readonly #database: DatabaseSync;
  readonly #lockIdentity: FileIdentity;
  readonly #lockPath: string;
  readonly #storage: DatabaseStorageBinding;
  #closed = false;
  #readyValidated = false;

  public readonly databasePath: string;

  private constructor(
    database: DatabaseSync,
    storage: DatabaseStorageBinding,
    lockPath: string,
    lockIdentity: FileIdentity,
  ) {
    this.#database = database;
    this.#storage = storage;
    this.#lockPath = lockPath;
    this.#lockIdentity = lockIdentity;
    this.databasePath = storage.databasePath;
  }

  public static async acquire(databasePath: string): Promise<DatabaseOwnerLock> {
    assertSecureDatabaseOwnerPlatform();
    const storage = DatabaseStorageBinding.prepare(databasePath);
    const lockPath = `${storage.databasePath}.owner-lock.sqlite`;
    const lockIdentity = createPrivateRegularFile(lockPath, "Database owner lock");
    assertPrivateSqliteSidecars(lockPath, "Database owner lock");

    let lockDatabase: DatabaseSync | undefined;
    try {
      lockDatabase = new DatabaseSync(lockPath, {
        timeout: 0,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
      });
      assertPrivateRegularFile(lockPath, "Database owner lock", lockIdentity);
      lockDatabase.exec("PRAGMA journal_mode = DELETE");
      lockDatabase.exec("PRAGMA synchronous = FULL");
      lockDatabase.exec("BEGIN EXCLUSIVE");
      assertPrivateSqliteSidecars(lockPath, "Database owner lock");
      storage.assertDirectoryIdentity();
      return new DatabaseOwnerLock(lockDatabase, storage, lockPath, lockIdentity);
    } catch (error) {
      const primaryError = isBusy(error)
        ? new Error(
            `Another Agentic Review Server already owns database ${storage.databasePath}.`,
            { cause: error },
          )
        : error;
      const cleanup =
        lockDatabase === undefined
          ? { closeSucceeded: false, errors: [] }
          : closeOwnerLockDatabaseWithRetries(lockDatabase);
      if (cleanup.errors.length > 0) {
        throw new AggregateError(
          [primaryError, ...cleanup.errors],
          cleanup.closeSucceeded
            ? "Database owner lock acquisition failed and cleanup required retries."
            : "FATAL: database owner lock acquisition failed and its handle could not be closed.",
          { cause: primaryError },
        );
      }
      throw primaryError;
    }
  }

  public assertReady(): void {
    if (this.#closed) {
      throw new Error("Database owner lock is already closed.");
    }
    this.#storage.assertReady();
    assertPrivateRegularFile(this.#lockPath, "Database owner lock", this.#lockIdentity);
    assertPrivateSqliteSidecars(this.#lockPath, "Database owner lock");
    this.#readyValidated = true;
  }

  public close(): Promise<void> {
    return this.#close();
  }

  async #close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    const errors: unknown[] = [];
    if (this.#readyValidated) {
      try {
        this.assertReady();
      } catch (error) {
        errors.push(error);
      }
    }
    const attempt = closeOwnerLockDatabaseWithRetries(this.#database);
    if (attempt.closeSucceeded) {
      this.#closed = true;
    }
    errors.push(...attempt.errors);
    throwCloseErrors(errors, "Database owner lock validation, rollback, or close failed.");
  }
}
