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
        targetVersion: 13,
        pendingVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      });

      expect(runMigrations(database, migrationsDirectory)).toBe(13);
      expect(inspectMigrationState(database, migrationsDirectory)).toEqual({
        currentVersion: 13,
        targetVersion: 13,
        pendingVersions: [],
      });
    } finally {
      database.close();
    }
  });

  it("creates a constrained Worker credential schema with independently unique identities", async () => {
    const directory = await createTemporaryDirectory();
    const database = new DatabaseSync(join(directory, "worker-credentials.sqlite"));
    const createdAt = "2026-09-03T00:00:00.000Z";
    try {
      runMigrations(database, migrationsDirectory);
      const insertCredential = database.prepare(`
        INSERT INTO worker_node_credentials (
          worker_node_id,
          display_name,
          token_sha256,
          auth_state,
          created_by_issuer,
          created_by_subject,
          updated_by_issuer,
          updated_by_subject,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `);
      insertCredential.run(
        "worker-migration-a",
        "Worker migration A",
        "a".repeat(64),
        "https://issuer.example.test",
        "migration-test",
        "https://issuer.example.test",
        "migration-test",
        createdAt,
        createdAt,
      );
      expect(() =>
        insertCredential.run(
          "worker-migration-a",
          "Duplicate Worker node",
          "b".repeat(64),
          "https://issuer.example.test",
          "migration-test",
          "https://issuer.example.test",
          "migration-test",
          createdAt,
          createdAt,
        ),
      ).toThrow(/UNIQUE constraint failed/u);
      expect(() =>
        insertCredential.run(
          "worker-migration-b",
          "Duplicate Token",
          "a".repeat(64),
          "https://issuer.example.test",
          "migration-test",
          "https://issuer.example.test",
          "migration-test",
          createdAt,
          createdAt,
        ),
      ).toThrow(/UNIQUE constraint failed/u);
      expect(() =>
        insertCredential.run(
          "worker-migration-c",
          "Uppercase Token Digest",
          "A".repeat(64),
          "https://issuer.example.test",
          "migration-test",
          "https://issuer.example.test",
          "migration-test",
          createdAt,
          createdAt,
        ),
      ).toThrow(/CHECK constraint failed/u);
      expect(
        database
          .prepare("SELECT name FROM pragma_table_info('worker_node_credentials') ORDER BY cid")
          .all(),
      ).toEqual([
        { name: "worker_node_id" },
        { name: "display_name" },
        { name: "token_sha256" },
        { name: "auth_state" },
        { name: "created_by_issuer" },
        { name: "created_by_subject" },
        { name: "updated_by_issuer" },
        { name: "updated_by_subject" },
        { name: "created_at" },
        { name: "updated_at" },
        { name: "activated_at" },
        { name: "rotated_at" },
        { name: "revoked_at" },
      ]);
    } finally {
      database.close();
    }
  });

  it("upgrades v12 Worker instances without granting implicit Token credentials", async () => {
    const directory = await createTemporaryDirectory();
    const versionTwelveDirectory = join(directory, "migrations-v12");
    await mkdir(versionTwelveDirectory);
    const migrationFilenames = (await readdir(migrationsDirectory)).sort().slice(0, 12);
    await Promise.all(
      migrationFilenames.map((filename) =>
        copyFile(join(migrationsDirectory, filename), join(versionTwelveDirectory, filename)),
      ),
    );
    const database = new DatabaseSync(join(directory, "upgrade-v12.sqlite"));
    const now = "2026-09-03T00:00:00.000Z";
    try {
      expect(runMigrations(database, versionTwelveDirectory)).toBe(12);
      database
        .prepare(`
          INSERT INTO workers (
            id,
            node_id,
            instance_id,
            display_name,
            version,
            protocol_version,
            max_slots,
            capabilities_json,
            capabilities_digest,
            status,
            registered_at,
            last_seen_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?, ?)
        `)
        .run(
          "legacy-worker-id",
          "legacy-worker-node",
          "legacy-worker-instance",
          "Legacy Worker",
          "1.0.0",
          "1.0",
          1,
          "{}",
          "a".repeat(64),
          now,
          now,
          now,
        );

      expect(runMigrations(database, migrationsDirectory)).toBe(13);
      expect(database.prepare("SELECT COUNT(*) AS count FROM workers").get()).toEqual({ count: 1 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM worker_node_credentials").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("accepts restoration of a backup that revives the Token state captured in that backup", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "rollback-state.sqlite");
    const backupPath = join(directory, "rollback-backup.sqlite");
    const oldTokenSha256 = "a".repeat(64);
    const newTokenSha256 = "b".repeat(64);
    const createdAt = "2026-09-03T00:00:00.000Z";
    const rotatedAt = "2026-09-03T00:00:01.000Z";
    const seedDatabase = new DatabaseSync(databasePath);
    try {
      runMigrations(seedDatabase, migrationsDirectory);
      seedDatabase
        .prepare(`
          INSERT INTO worker_node_credentials (
            worker_node_id,
            display_name,
            token_sha256,
            auth_state,
            created_by_issuer,
            created_by_subject,
            updated_by_issuer,
            updated_by_subject,
            created_at,
            updated_at,
            activated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          "worker-backup-rollback",
          "Worker backup rollback",
          oldTokenSha256,
          "https://issuer.example.test",
          "credential-creator",
          "https://issuer.example.test",
          "credential-creator",
          createdAt,
          createdAt,
          createdAt,
        );
    } finally {
      seedDatabase.close();
    }
    await copyFile(databasePath, backupPath);

    const rotatedDatabase = new DatabaseSync(databasePath);
    try {
      rotatedDatabase
        .prepare(`
          UPDATE worker_node_credentials
          SET token_sha256 = ?,
              updated_by_issuer = ?,
              updated_by_subject = ?,
              rotated_at = ?,
              updated_at = ?
          WHERE worker_node_id = ? AND auth_state = 'active'
        `)
        .run(
          newTokenSha256,
          "https://issuer.example.test",
          "credential-rotator",
          rotatedAt,
          rotatedAt,
          "worker-backup-rollback",
        );
      expect(
        rotatedDatabase
          .prepare("SELECT worker_node_id FROM worker_node_credentials WHERE token_sha256 = ?")
          .get(newTokenSha256),
      ).toEqual({ worker_node_id: "worker-backup-rollback" });
    } finally {
      rotatedDatabase.close();
    }

    await copyFile(backupPath, databasePath);
    const restoredDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        restoredDatabase
          .prepare(
            "SELECT worker_node_id, auth_state FROM worker_node_credentials WHERE token_sha256 = ?",
          )
          .get(oldTokenSha256),
      ).toEqual({ worker_node_id: "worker-backup-rollback", auth_state: "active" });
      expect(
        restoredDatabase
          .prepare("SELECT worker_node_id FROM worker_node_credentials WHERE token_sha256 = ?")
          .get(newTokenSha256),
      ).toBeUndefined();
    } finally {
      restoredDatabase.close();
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
        targetVersion: 13,
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
