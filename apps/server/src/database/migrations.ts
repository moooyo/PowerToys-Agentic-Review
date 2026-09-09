import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runEvaluationReproductionRebuild } from "./evaluation-reproduction-rebuild.js";
import { backfillJobAdmissions } from "./job-admission.js";
import { runPromptProfileEvaluationRebuild } from "./migration-rebuild.js";
import { runValidationResultRebuild } from "./validation-result-rebuild.js";

interface AppliedMigration {
  readonly version: number;
  readonly filename: string;
  readonly checksum: string;
}

interface MigrationFile extends AppliedMigration {
  readonly sql: string;
}

export interface MigrationState {
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly pendingVersions: readonly number[];
}

const migrationPattern = /^(\d+)_.*\.sql$/u;
const migrationTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;
`;

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

const readAppliedMigrations = (database: DatabaseSync): readonly AppliedMigration[] => {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get() as { readonly present: number } | undefined;
  if (table === undefined) {
    return [];
  }

  return database
    .prepare("SELECT version, filename, checksum FROM schema_migrations ORDER BY version")
    .all() as unknown as AppliedMigration[];
};

const validateAppliedMigrations = (
  appliedRows: readonly AppliedMigration[],
  migrations: readonly MigrationFile[],
): void => {
  const available = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const [index, applied] of appliedRows.entries()) {
    const expectedVersion = index + 1;
    if (applied.version !== expectedVersion) {
      throw new Error(
        `Applied migration sequence has a gap: expected version ${expectedVersion}, found ${applied.version}.`,
      );
    }

    const migration = available.get(applied.version);
    if (migration === undefined) {
      throw new Error(
        `Applied migration ${applied.version} (${applied.filename}) is missing from the deployment.`,
      );
    }
    if (applied.filename !== migration.filename || applied.checksum !== migration.checksum) {
      throw new Error(`Applied migration ${applied.version} does not match ${migration.filename}.`);
    }
  }
};

export const inspectMigrationState = (
  database: DatabaseSync,
  directory: string,
): MigrationState => {
  const migrations = readMigrations(directory);
  const appliedRows = readAppliedMigrations(database);
  validateAppliedMigrations(appliedRows, migrations);
  const appliedVersions = new Set(appliedRows.map((migration) => migration.version));

  return {
    currentVersion: appliedRows.at(-1)?.version ?? 0,
    targetVersion: migrations.at(-1)?.version ?? 0,
    pendingVersions: migrations
      .filter((migration) => !appliedVersions.has(migration.version))
      .map((migration) => migration.version),
  };
};

export const runMigrations = (database: DatabaseSync, directory: string): number => {
  const migrations = readMigrations(directory);
  const initiallyApplied = readAppliedMigrations(database);
  validateAppliedMigrations(initiallyApplied, migrations);
  const initiallyAppliedVersions = new Set(initiallyApplied.map((migration) => migration.version));

  for (const migration of migrations) {
    const rebuild =
      migration.version === 28 && migration.filename === "0028_prompt_profile_evaluations.sql"
        ? runPromptProfileEvaluationRebuild
        : migration.version === 29 && migration.filename === "0029_validation_model_outputs.sql"
          ? runValidationResultRebuild
          : migration.version === 31 && migration.filename === "0031_evaluation_reproduction.sql"
            ? runEvaluationReproductionRebuild
            : undefined;
    if (rebuild !== undefined && !initiallyAppliedVersions.has(migration.version)) {
      rebuild(database, {
        isPending: () => {
          const existing = database
            .prepare("SELECT version, filename, checksum FROM schema_migrations WHERE version = ?")
            .get(migration.version) as AppliedMigration | undefined;
          if (existing === undefined) return true;
          if (
            existing.filename !== migration.filename ||
            existing.checksum !== migration.checksum
          ) {
            throw new Error(
              `Applied migration ${migration.version} does not match ${migration.filename}.`,
            );
          }
          return false;
        },
        apply: () => {
          database.exec(migration.sql);
          database
            .prepare(`
            INSERT INTO schema_migrations (version, filename, checksum, applied_at)
            VALUES (?, ?, ?, ?)
          `)
            .run(
              migration.version,
              migration.filename,
              migration.checksum,
              new Date().toISOString(),
            );
        },
      });
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migrationTableSql);
      const existing = database
        .prepare("SELECT version, filename, checksum FROM schema_migrations WHERE version = ?")
        .get(migration.version) as AppliedMigration | undefined;

      if (existing === undefined) {
        database.exec(migration.sql);
        const appliedAt = new Date().toISOString();
        if (migration.version === 24 && migration.filename === "0024_job_admission.sql")
          backfillJobAdmissions(database, appliedAt);
        database
          .prepare(`
            INSERT INTO schema_migrations (version, filename, checksum, applied_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(migration.version, migration.filename, migration.checksum, appliedAt);
      } else if (
        existing.filename !== migration.filename ||
        existing.checksum !== migration.checksum
      ) {
        throw new Error(
          `Applied migration ${migration.version} does not match ${migration.filename}.`,
        );
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const finalState = inspectMigrationState(database, directory);
  if (finalState.pendingVersions.length !== 0) {
    throw new Error(`Database migration did not reach target version ${finalState.targetVersion}.`);
  }
  return finalState.currentVersion;
};
