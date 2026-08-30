import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backup, type DatabaseSync as Database, DatabaseSync } from "node:sqlite";

export interface CreateMigrationBackupOptions {
  readonly database: Database;
  readonly databasePath: string;
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly backupDirectory?: string;
}

const safeFilename = (value: string): string => value.replaceAll(/[^A-Za-z0-9._-]/gu, "_");

const backupDirectoryFor = (databasePath: string, backupDirectory?: string): string =>
  backupDirectory ?? join(dirname(databasePath), "backups");

export const cleanupIncompleteMigrationBackups = (
  databasePath: string,
  backupDirectory?: string,
): number => {
  const directory = backupDirectoryFor(databasePath, backupDirectory);
  if (!existsSync(directory)) {
    return 0;
  }

  const prefix = `${safeFilename(basename(databasePath))}.v`;
  let removed = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.includes(".sqlite.partial")) {
      rmSync(join(directory, entry.name), { force: true });
      removed += 1;
    }
  }
  return removed;
};

export const createMigrationBackup = async (
  options: CreateMigrationBackupOptions,
): Promise<string> => {
  const backupDirectory = backupDirectoryFor(options.databasePath, options.backupDirectory);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(backupDirectory, 0o700);
  }

  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const databaseName = safeFilename(basename(options.databasePath));
  const backupPath = join(
    backupDirectory,
    `${databaseName}.v${options.currentVersion}-to-v${options.targetVersion}.${timestamp}.${randomUUID()}.sqlite`,
  );
  const partialPath = `${backupPath}.partial`;

  try {
    await backup(options.database, partialPath, { rate: 256 });
    if (process.platform !== "win32") {
      chmodSync(partialPath, 0o600);
    }
    verifyBackup(partialPath, options.currentVersion);
    removeBackupSidecars(partialPath);
    renameSync(partialPath, backupPath);
    return backupPath;
  } catch (error) {
    rmSync(partialPath, { force: true });
    removeBackupSidecars(partialPath);
    throw new Error(`Unable to create a verified pre-migration backup at ${backupPath}.`, {
      cause: error,
    });
  }
};

const removeBackupSidecars = (backupPath: string): void => {
  rmSync(`${backupPath}-shm`, { force: true });
  rmSync(`${backupPath}-wal`, { force: true });
};

const verifyBackup = (backupPath: string, expectedSchemaVersion: number): void => {
  const backupDatabase = new DatabaseSync(backupPath, {
    readOnly: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    const row = backupDatabase.prepare("PRAGMA integrity_check").get() as
      | { readonly integrity_check: string }
      | undefined;
    if (row?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity_check returned ${row?.integrity_check ?? "no result"}.`);
    }
    const schemaTable = backupDatabase
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    const schemaVersion =
      schemaTable === undefined
        ? 0
        : ((
            backupDatabase
              .prepare("SELECT MAX(version) AS version FROM schema_migrations")
              .get() as { readonly version: number | null }
          ).version ?? 0);
    if (schemaVersion !== expectedSchemaVersion) {
      throw new Error(
        `Backup schema version ${schemaVersion} does not match expected version ${expectedSchemaVersion}.`,
      );
    }
  } finally {
    backupDatabase.close();
  }
};
