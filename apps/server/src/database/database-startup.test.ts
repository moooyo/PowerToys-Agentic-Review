import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { runMigrations } from "../../dist/database/migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DatabaseClient startup", () => {
  it("creates a verified backup before applying pending migrations", async () => {
    const directory = await createTemporaryDirectory();
    const versionOneDirectory = join(directory, "migrations-v1");
    await mkdir(versionOneDirectory);
    await copyFile(
      join(migrationsDirectory, "0001_initial.sql"),
      join(versionOneDirectory, "0001_initial.sql"),
    );
    const databasePath = join(directory, "state.sqlite");
    const seedDatabase = new DatabaseSync(databasePath);
    try {
      expect(runMigrations(seedDatabase, versionOneDirectory)).toBe(1);
    } finally {
      seedDatabase.close();
    }
    const backupDirectory = join(directory, "backups");
    await mkdir(backupDirectory);
    await Promise.all([
      writeFile(join(backupDirectory, "state.sqlite.v1-to-v6.stale.sqlite.partial"), "partial"),
      writeFile(join(backupDirectory, "state.sqlite.v1-to-v6.stale.sqlite.partial-wal"), "partial"),
    ]);

    const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
    await client.close();

    const backupFiles = await readdir(backupDirectory);
    expect(backupFiles).toHaveLength(1);
    expect(backupFiles[0]).toMatch(/\.sqlite$/u);
    const backupDatabase = new DatabaseSync(join(backupDirectory, backupFiles[0] as string), {
      readOnly: true,
    });
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readSchemaVersion(backupDatabase)).toBe(1);
      expect(readSchemaVersion(migratedDatabase)).toBe(6);
    } finally {
      backupDatabase.close();
      migratedDatabase.close();
    }
  });

  it("terminates a database Worker that fails before readiness", async () => {
    const directory = await createTemporaryDirectory();
    const invalidMigrationsDirectory = join(directory, "invalid-migrations");
    await mkdir(invalidMigrationsDirectory);
    const migrationPath = join(invalidMigrationsDirectory, "0001_initial.sql");
    await writeFile(migrationPath, "THIS IS NOT SQL", "utf8");
    const databasePath = join(directory, "state.sqlite");

    await expect(
      DatabaseClient.create({ databasePath, migrationsDirectory: invalidMigrationsDirectory }),
    ).rejects.toThrow();

    await writeFile(
      migrationPath,
      await readFile(join(migrationsDirectory, "0001_initial.sql"), "utf8"),
      "utf8",
    );
    const replacement = await DatabaseClient.create({
      databasePath,
      migrationsDirectory: invalidMigrationsDirectory,
    });
    await replacement.close();
  });
});

const readSchemaVersion = (database: DatabaseSync): number => {
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
    readonly version: number | null;
  };
  return row.version ?? 0;
};

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-database-startup-"));
  temporaryDirectories.push(directory);
  return directory;
};
