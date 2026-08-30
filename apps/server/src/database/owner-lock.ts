import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const canonicalizeDatabasePath = (databasePath: string): string => {
  const resolvedPath = resolve(databasePath);
  const parentDirectory = dirname(resolvedPath);
  mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });

  if (existsSync(resolvedPath)) {
    const stats = statSync(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Database path ${resolvedPath} is not a regular file.`);
    }
    if (stats.nlink !== 1) {
      throw new Error(`Database path ${resolvedPath} must not have hard links.`);
    }
    return realpathSync.native(resolvedPath);
  }

  return join(realpathSync.native(parentDirectory), basename(resolvedPath));
};

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  (("errcode" in error && error.errcode === 5) ||
    error.message.toLowerCase().includes("database is locked"));

export class DatabaseOwnerLock {
  readonly #database: DatabaseSync;
  #closed = false;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public static async acquire(databasePath: string): Promise<DatabaseOwnerLock> {
    const canonicalDatabasePath = canonicalizeDatabasePath(databasePath);
    const lockPath = `${canonicalDatabasePath}.owner-lock.sqlite`;
    if (existsSync(lockPath) && statSync(lockPath).nlink !== 1) {
      throw new Error(`Database owner lock ${lockPath} must not have hard links.`);
    }

    let lockDatabase: DatabaseSync | undefined;
    try {
      lockDatabase = new DatabaseSync(lockPath, {
        timeout: 0,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
      });
      if (process.platform !== "win32") {
        chmodSync(lockPath, 0o600);
      }
      lockDatabase.exec("PRAGMA journal_mode = DELETE");
      lockDatabase.exec("PRAGMA synchronous = FULL");
      lockDatabase.exec("BEGIN EXCLUSIVE");
      return new DatabaseOwnerLock(lockDatabase);
    } catch (error) {
      lockDatabase?.close();
      if (isBusy(error)) {
        throw new Error(
          `Another Agentic Review Server already owns database ${canonicalDatabasePath}.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#database.isTransaction) {
      this.#database.exec("ROLLBACK");
    }
    this.#database.close();
  }
}
