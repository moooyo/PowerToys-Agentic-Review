import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationBackup } from "../../dist/database/migration-backup.js";
import { inspectMigrationState, runMigrations } from "../../dist/database/migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database migrations and backups", () => {
  it("reports pending migrations and reaches the inspected target", async () => {
    const directory = await createTemporaryDirectory();
    const database = new DatabaseSync(join(directory, "state.sqlite"));
    try {
      expect(inspectMigrationState(database, migrationsDirectory)).toEqual({
        currentVersion: 0,
        targetVersion: 6,
        pendingVersions: [1, 2, 3, 4, 5, 6],
      });

      expect(runMigrations(database, migrationsDirectory)).toBe(6);
      expect(inspectMigrationState(database, migrationsDirectory)).toEqual({
        currentVersion: 6,
        targetVersion: 6,
        pendingVersions: [],
      });
    } finally {
      database.close();
    }
  });

  it("creates a private verified backup before an upgrade", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      runMigrations(database, migrationsDirectory);
      database.exec("CREATE TABLE backup_marker (value TEXT NOT NULL) STRICT");
      database.prepare("INSERT INTO backup_marker (value) VALUES (?)").run("present");

      const backupPath = await createMigrationBackup({
        database,
        databasePath,
        currentVersion: 6,
        targetVersion: 7,
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
    } finally {
      database.close();
    }
  });
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
};
