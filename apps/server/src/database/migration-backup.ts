import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, opendirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, type DatabaseSync as Database, DatabaseSync } from "node:sqlite";
import {
  assertPrivateRegularFile,
  createPrivateRegularFile,
  type FileIdentity,
  openPrivateRegularFile,
  PrivateDirectoryBinding,
  secureDatabaseBasename,
} from "./storage-security.js";

export interface CreateMigrationBackupOptions {
  readonly database: Database;
  readonly databasePath: string;
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly backupDirectory?: string;
}

const sqliteSidecarSuffixes = ["-journal", "-wal", "-shm"] as const;

export const maximumMigrationBackupEntries = 4_096;

interface BackupEntry {
  readonly databaseName: string;
  readonly identity: FileIdentity;
  readonly kind: "final" | "partial" | "partial_sidecar";
  readonly path: string;
}

export interface MigrationBackupPublicationOperations {
  closeBackupFile(): void;
  renameBackup(): void;
  syncBackupDirectory(): void;
  syncBackupFile(): void;
  syncParentDirectory(): void;
  validatePublishedBackup(): void;
}

const backupDirectoryFor = (databasePath: string, backupDirectory?: string): string =>
  backupDirectory ?? join(dirname(databasePath), "backups");

const backupEntryPattern = new RegExp(
  "^(?<databaseName>[A-Za-z0-9._-]+)\\.v[0-9]+-to-v[0-9]+" +
    "\\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z" +
    "\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" +
    "\\.sqlite(?:\\.partial(?<sidecar>-(?:journal|wal|shm))?)?$",
  "u",
);

const throwPublicationErrors = (
  publicationError: unknown | undefined,
  closeError: unknown | undefined,
): void => {
  if (publicationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [publicationError, closeError],
      "Migration backup publication and descriptor close both failed.",
      { cause: publicationError },
    );
  }
  if (publicationError !== undefined) {
    throw publicationError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
};

export const completeMigrationBackupPublication = (
  operations: MigrationBackupPublicationOperations,
): void => {
  let publicationError: unknown;
  try {
    operations.syncBackupFile();
    operations.renameBackup();
    operations.validatePublishedBackup();
    operations.syncBackupDirectory();
    operations.syncParentDirectory();
  } catch (error) {
    publicationError = error;
  }

  let closeError: unknown;
  try {
    operations.closeBackupFile();
  } catch (error) {
    closeError = error;
  }
  throwPublicationErrors(publicationError, closeError);
};

const readBackupEntries = (directory: PrivateDirectoryBinding): readonly BackupEntry[] => {
  directory.assertReady();
  const handle = opendirSync(directory.directoryPath);
  const entries: BackupEntry[] = [];
  let scanError: unknown;
  try {
    let count = 0;
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      count += 1;
      if (count > maximumMigrationBackupEntries) {
        throw new Error(
          `Backup directory ${directory.directoryPath} contains more than ${maximumMigrationBackupEntries} entries.`,
        );
      }
      const match = backupEntryPattern.exec(entry.name);
      if (match === null) {
        throw new Error(
          `Backup directory ${directory.directoryPath} contains unknown entry ${entry.name}.`,
        );
      }
      const path = join(directory.directoryPath, entry.name);
      const identity = assertPrivateRegularFile(path, "Migration backup entry");
      if (identity === undefined) {
        throw new Error(`Migration backup entry ${path} disappeared during validation.`);
      }
      const entryDatabaseName = match.groups?.databaseName;
      if (entryDatabaseName === undefined) {
        throw new Error(`Migration backup entry ${path} has no database name.`);
      }
      secureDatabaseBasename(entryDatabaseName);
      const partialMarker = entry.name.includes(".sqlite.partial");
      entries.push({
        databaseName: entryDatabaseName,
        identity,
        kind:
          match.groups?.sidecar !== undefined
            ? "partial_sidecar"
            : partialMarker
              ? "partial"
              : "final",
        path,
      });
    }
  } catch (error) {
    scanError = error;
  }

  let closeError: unknown;
  try {
    handle.closeSync();
  } catch (error) {
    closeError = error;
  }
  if (scanError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [scanError, closeError],
      `Backup directory ${directory.directoryPath} scan and close both failed.`,
      { cause: scanError },
    );
  }
  if (scanError !== undefined) {
    throw scanError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
  directory.assertReady();
  return entries;
};

const cleanupIncompleteEntries = (
  directory: PrivateDirectoryBinding,
  databaseName: string,
): number => {
  const incomplete = readBackupEntries(directory).filter(
    (entry) => entry.databaseName === databaseName && entry.kind !== "final",
  );
  for (const entry of incomplete) {
    directory.assertReady();
    assertPrivateRegularFile(entry.path, "Incomplete migration backup", entry.identity);
    rmSync(entry.path);
  }
  readBackupEntries(directory);
  return incomplete.length;
};

export const cleanupIncompleteMigrationBackups = (
  databasePath: string,
  backupDirectory?: string,
): number => {
  const databaseName = secureDatabaseBasename(databasePath);
  const directory = backupDirectoryFor(databasePath, backupDirectory);
  const binding = PrivateDirectoryBinding.prepareIfExists(directory, "Migration backup directory");
  if (binding === undefined) {
    return 0;
  }
  return cleanupIncompleteEntries(binding, databaseName);
};

export const createMigrationBackup = async (
  options: CreateMigrationBackupOptions,
): Promise<string> => {
  const databaseName = secureDatabaseBasename(options.databasePath);
  const backupDirectory = backupDirectoryFor(options.databasePath, options.backupDirectory);
  const directory = PrivateDirectoryBinding.prepare(
    backupDirectory,
    "Migration backup directory",
    true,
  );

  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  cleanupIncompleteEntries(directory, databaseName);
  const backupPath = join(
    directory.directoryPath,
    `${databaseName}.v${options.currentVersion}-to-v${options.targetVersion}.${timestamp}.${randomUUID()}.sqlite`,
  );
  const partialPath = `${backupPath}.partial`;
  const partialIdentity = createPrivateRegularFile(partialPath, "Partial migration backup", true);
  let published = false;

  try {
    // node:sqlite backup accepts only a pathname. The bound 0700 directory makes replacement an
    // explicit root/same-euid trust-boundary event while post-open identity checks fail closed.
    await backup(options.database, partialPath, { rate: 256 });
    directory.assertReady();
    const opened = openPrivateRegularFile(
      partialPath,
      "Partial migration backup",
      partialIdentity,
      true,
    );
    completeMigrationBackupPublication({
      syncBackupFile: () => {
        verifyBackup(partialPath, options.currentVersion);
        assertPrivateRegularFile(partialPath, "Partial migration backup", opened.identity);
        removeBackupSidecars(partialPath, directory);
        directory.assertReady();
        assertPrivateRegularFile(partialPath, "Partial migration backup", opened.identity);
        fsyncSync(opened.descriptor);
        assertPrivateRegularFile(partialPath, "Partial migration backup", opened.identity);
      },
      renameBackup: () => {
        directory.assertReady();
        if (assertPrivateRegularFile(backupPath, "Migration backup") !== undefined) {
          throw new Error(`Migration backup destination ${backupPath} already exists.`);
        }
        renameSync(partialPath, backupPath);
        published = true;
      },
      validatePublishedBackup: () => {
        assertPrivateRegularFile(backupPath, "Migration backup", opened.identity);
      },
      syncBackupDirectory: () => directory.sync(),
      syncParentDirectory: () => directory.syncParent(),
      closeBackupFile: () => closeSync(opened.descriptor),
    });
    readBackupEntries(directory);
    return backupPath;
  } catch (error) {
    rmSync(partialPath, { force: true });
    removeBackupArtifacts(partialPath);
    if (published) {
      rmSync(backupPath, { force: true });
    }
    throw new Error(`Unable to create a verified pre-migration backup at ${backupPath}.`, {
      cause: error,
    });
  }
};

const removeBackupSidecars = (backupPath: string, directory: PrivateDirectoryBinding): void => {
  for (const suffix of sqliteSidecarSuffixes) {
    const path = `${backupPath}${suffix}`;
    const identity = assertPrivateRegularFile(path, "Migration backup sidecar");
    if (identity === undefined) {
      continue;
    }
    directory.assertReady();
    assertPrivateRegularFile(path, "Migration backup sidecar", identity);
    rmSync(path);
  }
};

const removeBackupArtifacts = (backupPath: string): void => {
  for (const suffix of sqliteSidecarSuffixes) {
    rmSync(`${backupPath}${suffix}`, { force: true });
  }
};

const verifyBackup = (backupPath: string, expectedSchemaVersion: number): void => {
  const backupDatabase = new DatabaseSync(backupPath, {
    readOnly: true,
    enableDoubleQuotedStringLiterals: false,
  });
  let verificationError: unknown;
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
  } catch (error) {
    verificationError = error;
  }

  let closeError: unknown;
  try {
    backupDatabase.close();
  } catch (error) {
    closeError = error;
  }
  if (verificationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [verificationError, closeError],
      `Migration backup ${backupPath} verification and close both failed.`,
      { cause: verificationError },
    );
  }
  if (verificationError !== undefined) {
    throw verificationError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
};
