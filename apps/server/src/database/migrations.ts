import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

interface AppliedMigration {
  readonly version: number;
  readonly filename: string;
  readonly checksum: string;
}

interface MigrationFile extends AppliedMigration {
  readonly sql: string;
}

const migrationPattern = /^(\d+)_.*\.sql$/u;

const readMigrations = (directory: string): readonly MigrationFile[] => {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && migrationPattern.test(entry.name))
    .map((entry) => {
      const match = migrationPattern.exec(entry.name);
      if (match === null) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }

      const versionText = match[1];
      if (versionText === undefined) {
        throw new Error(`Migration version is missing: ${entry.name}`);
      }
      const version = Number.parseInt(versionText, 10);
      const sql = readFileSync(join(directory, entry.name), "utf8");

      return {
        version,
        filename: entry.name,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    })
    .sort((left, right) => left.version - right.version);

  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous !== undefined && current !== undefined && previous.version === current.version) {
      throw new Error(`Duplicate migration version: ${current.version}`);
    }
  }

  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration sequence has a gap: expected version ${expectedVersion}, found ${migration.version}.`,
      );
    }
  }

  return migrations;
};

export const runMigrations = (database: DatabaseSync, directory: string): number => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database
    .prepare("SELECT version, filename, checksum FROM schema_migrations ORDER BY version")
    .all() as unknown as AppliedMigration[];
  const applied = new Map(appliedRows.map((row) => [row.version, row]));
  const migrations = readMigrations(directory);
  const availableVersions = new Set(migrations.map((migration) => migration.version));
  for (const migration of appliedRows) {
    if (!availableVersions.has(migration.version)) {
      throw new Error(
        `Applied migration ${migration.version} (${migration.filename}) is missing from the deployment.`,
      );
    }
  }
  const insertMigration = database.prepare(`
    INSERT INTO schema_migrations (version, filename, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing !== undefined) {
      if (existing.filename !== migration.filename || existing.checksum !== migration.checksum) {
        throw new Error(
          `Applied migration ${migration.version} does not match ${migration.filename}.`,
        );
      }
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insertMigration.run(
        migration.version,
        migration.filename,
        migration.checksum,
        new Date().toISOString(),
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return migrations.at(-1)?.version ?? 0;
};
