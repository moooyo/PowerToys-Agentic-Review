import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupIncompleteMigrationBackups,
  completeMigrationBackupPublication,
  createMigrationBackup,
  maximumMigrationBackupEntries,
} from "../../dist/database/migration-backup.js";
import { inspectMigrationState, runMigrations } from "../../dist/database/migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const versionSevenMigrationFilenames = [
  "0001_initial.sql",
  "0002_github_ingestion.sql",
  "0003_operator_auth.sql",
  "0004_github_polling_state.sql",
  "0005_operator_browser_flows.sql",
  "0006_immutable_review_results.sql",
  "0007_operator_login_claim.sql",
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database migrations and backups", () => {
  it("rejects unsafe database basenames instead of normalizing them into backup collisions", async () => {
    const directory = await createTemporaryDirectory();
    for (const filename of ["state name.sqlite", "state?name.sqlite"]) {
      expect(() => cleanupIncompleteMigrationBackups(join(directory, filename))).toThrow(
        /database filename.*must match/iu,
      );
    }
  });

  it("orders durable backup publication and always closes the backup descriptor", () => {
    const events: string[] = [];
    completeMigrationBackupPublication({
      syncBackupFile: () => events.push("sync-file"),
      renameBackup: () => events.push("rename"),
      validatePublishedBackup: () => events.push("validate-final"),
      syncBackupDirectory: () => events.push("sync-backup-directory"),
      syncParentDirectory: () => events.push("sync-parent-directory"),
      closeBackupFile: () => events.push("close"),
    });
    expect(events).toEqual([
      "sync-file",
      "rename",
      "validate-final",
      "sync-backup-directory",
      "sync-parent-directory",
      "close",
    ]);

    const syncError = new Error("backup directory fsync failed");
    const closeError = new Error("backup descriptor close failed");
    events.length = 0;
    let thrown: unknown;
    try {
      completeMigrationBackupPublication({
        syncBackupFile: () => events.push("sync-file"),
        renameBackup: () => events.push("rename"),
        validatePublishedBackup: () => events.push("validate-final"),
        syncBackupDirectory: () => {
          events.push("sync-backup-directory");
          throw syncError;
        },
        syncParentDirectory: () => events.push("sync-parent-directory"),
        closeBackupFile: () => {
          events.push("close");
          throw closeError;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(events).toEqual([
      "sync-file",
      "rename",
      "validate-final",
      "sync-backup-directory",
      "close",
    ]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([syncError, closeError]);
  });

  it("reports pending migrations and reaches the inspected target", async () => {
    const directory = await createTemporaryDirectory();
    const database = new DatabaseSync(join(directory, "state.sqlite"));
    try {
      expect(inspectMigrationState(database, migrationsDirectory)).toEqual({
        currentVersion: 0,
        targetVersion: 8,
        pendingVersions: [1, 2, 3, 4, 5, 6, 7, 8],
      });

      expect(runMigrations(database, migrationsDirectory)).toBe(8);
      expect(inspectMigrationState(database, migrationsDirectory)).toEqual({
        currentVersion: 8,
        targetVersion: 8,
        pendingVersions: [],
      });
    } finally {
      database.close();
    }
  });

  it("creates a private verified backup before an upgrade", async () => {
    const directory = await createTemporaryDirectory();
    const versionSevenDirectory = join(directory, "migrations-v7");
    await mkdir(versionSevenDirectory);
    await Promise.all(
      versionSevenMigrationFilenames.map((filename) =>
        copyFile(join(migrationsDirectory, filename), join(versionSevenDirectory, filename)),
      ),
    );
    const databasePath = join(directory, "state.sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      expect(runMigrations(database, versionSevenDirectory)).toBe(7);
      database.exec("CREATE TABLE backup_marker (value TEXT NOT NULL) STRICT");
      database.prepare("INSERT INTO backup_marker (value) VALUES (?)").run("present");

      const backupPath = await createMigrationBackup({
        database,
        databasePath,
        currentVersion: 7,
        targetVersion: 8,
      });
      const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
      try {
        expect(backupDatabase.prepare("SELECT value FROM backup_marker").get()).toEqual({
          value: "present",
        });
      } finally {
        backupDatabase.close();
      }

      expect(await readdir(join(directory, "backups"))).toHaveLength(1);
      const backupStats = await lstat(backupPath);
      expect(backupStats.isFile()).toBe(true);
      expect(backupStats.nlink).toBe(1);
      expect(backupStats.mode & 0o7777).toBe(0o600);
    } finally {
      database.close();
    }
  });

  it("validates the backup directory as a closed set before removing incomplete files", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    const backupDirectory = join(directory, "backups");
    await mkdir(backupDirectory, { mode: 0o700 });
    const stem =
      "state.sqlite.v1-to-v6.2026-08-31T00-00-00-000Z.00000000-0000-4000-8000-000000000000.sqlite";
    const partialPath = join(backupDirectory, `${stem}.partial`);
    const partialWalPath = `${partialPath}-wal`;
    const finalPath = join(backupDirectory, stem);
    const otherStem =
      "other.sqlite.v2-to-v3.2026-08-31T00-00-00-000Z.00000000-0000-4000-8000-000000000010.sqlite";
    const otherPartialPath = join(backupDirectory, `${otherStem}.partial`);
    const otherPartialWalPath = `${otherPartialPath}-wal`;
    await Promise.all([
      writeFile(partialPath, "partial", { mode: 0o600 }),
      writeFile(partialWalPath, "partial wal", { mode: 0o600 }),
      writeFile(finalPath, "final", { mode: 0o600 }),
      writeFile(otherPartialPath, "other partial", { mode: 0o600 }),
      writeFile(otherPartialWalPath, "other partial wal", { mode: 0o600 }),
      writeFile(join(backupDirectory, "unknown-entry"), "unknown", { mode: 0o600 }),
    ]);

    expect(() => cleanupIncompleteMigrationBackups(databasePath)).toThrow(/unknown entry/u);
    expect((await lstat(partialPath)).isFile()).toBe(true);
    await rm(join(backupDirectory, "unknown-entry"));
    expect(cleanupIncompleteMigrationBackups(databasePath)).toBe(2);
    expect((await readdir(backupDirectory)).sort()).toEqual(
      [stem, `${otherStem}.partial`, `${otherStem}.partial-wal`].sort(),
    );
  });

  it("rejects unsafe backup entries and a symlinked backup directory", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    const backupDirectory = join(directory, "backups");
    await mkdir(backupDirectory, { mode: 0o700 });
    const stem =
      "state.sqlite.v1-to-v6.2026-08-31T00-00-00-000Z.00000000-0000-4000-8000-000000000001.sqlite";
    const unsafePath = join(backupDirectory, stem);
    await writeFile(unsafePath, "unsafe", { mode: 0o600 });
    await chmod(unsafePath, 0o644);
    expect(() => cleanupIncompleteMigrationBackups(databasePath)).toThrow(/mode 0600/u);

    await rm(unsafePath);
    const hardLinkTarget = join(directory, "hard-link-target");
    await writeFile(hardLinkTarget, "hard link", { mode: 0o600 });
    await link(hardLinkTarget, unsafePath);
    expect(() => cleanupIncompleteMigrationBackups(databasePath)).toThrow(/hard links/u);

    await rm(unsafePath);
    await symlink(hardLinkTarget, unsafePath, "file");
    expect(() => cleanupIncompleteMigrationBackups(databasePath)).toThrow(/symbolic link/u);

    await rm(unsafePath);
    await rm(backupDirectory, { recursive: true });
    const redirectedDirectory = join(directory, "redirected-backups");
    await mkdir(redirectedDirectory, { mode: 0o700 });
    await symlink(redirectedDirectory, backupDirectory, "dir");
    expect(() => cleanupIncompleteMigrationBackups(databasePath)).toThrow(/symbolic link/u);

    await rm(backupDirectory);
    const customRoot = join(directory, "custom-root");
    const customAlias = join(directory, "custom-alias");
    await mkdir(customRoot, { mode: 0o700 });
    await symlink(customRoot, customAlias, "dir");
    expect(() =>
      cleanupIncompleteMigrationBackups(databasePath, join(customAlias, "nested-backups")),
    ).toThrow(/lexical path component.*symbolic link/u);
  });

  it("rejects a backup directory above the bounded entry limit", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    const backupDirectory = join(directory, "backups");
    await mkdir(backupDirectory, { mode: 0o700 });

    for (let start = 0; start <= maximumMigrationBackupEntries; start += 256) {
      const end = Math.min(start + 256, maximumMigrationBackupEntries + 1);
      await Promise.all(
        Array.from({ length: end - start }, (_, offset) => {
          const sequence = (start + offset).toString(16).padStart(12, "0");
          const filename =
            `other.sqlite.v1-to-v2.2026-08-31T00-00-00-000Z.` +
            `00000000-0000-4000-8000-${sequence}.sqlite`;
          return writeFile(join(backupDirectory, filename), "backup", { mode: 0o600 });
        }),
      );
    }

    expect(() => cleanupIncompleteMigrationBackups(databasePath)).toThrow(
      new RegExp(`more than ${maximumMigrationBackupEntries} entries`, "u"),
    );
  });
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-migrations-"));
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
  temporaryDirectories.push(directory);
  return directory;
};
