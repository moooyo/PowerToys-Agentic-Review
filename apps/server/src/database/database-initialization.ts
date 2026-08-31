import type { DatabaseSync } from "node:sqlite";
import { cleanupIncompleteMigrationBackups, createMigrationBackup } from "./migration-backup.js";
import { inspectMigrationState, type MigrationState } from "./migrations.js";
import type { DatabaseStorageBinding } from "./storage-security.js";

export interface LegacyDatabaseAdoptionOperations {
  assertDatabaseIdentity(): void;
  cleanupIncompleteBackups(): void;
  consumeLegacyAdoptionAuthorization(): void;
  createBackup(state: MigrationState): Promise<void>;
  inspectKnownMigrationState(): MigrationState;
  publishInitializedMarker(): void;
  setTrustedSchemaOff(): void;
  verifyForeignKeys(): void;
  verifyIntegrity(): void;
}

export const completeLegacyDatabaseAdoption = async (
  operations: LegacyDatabaseAdoptionOperations,
): Promise<MigrationState> => {
  operations.assertDatabaseIdentity();
  operations.setTrustedSchemaOff();
  operations.verifyIntegrity();
  operations.verifyForeignKeys();
  const migrationState = operations.inspectKnownMigrationState();
  operations.assertDatabaseIdentity();
  operations.cleanupIncompleteBackups();
  if (migrationState.pendingVersions.length > 0) {
    await operations.createBackup(migrationState);
  }
  operations.assertDatabaseIdentity();
  operations.consumeLegacyAdoptionAuthorization();
  operations.publishInitializedMarker();
  return migrationState;
};

export const adoptLegacyDatabase = async (options: {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly migrationsDirectory: string;
  readonly storage: DatabaseStorageBinding;
}): Promise<MigrationState> =>
  completeLegacyDatabaseAdoption({
    setTrustedSchemaOff: () => {
      options.database.exec("PRAGMA trusted_schema = OFF");
    },
    verifyIntegrity: () => {
      const row = options.database.prepare("PRAGMA integrity_check").get() as
        | { readonly integrity_check: string }
        | undefined;
      if (row?.integrity_check !== "ok") {
        throw new Error(
          `Legacy database integrity_check returned ${row?.integrity_check ?? "no result"}.`,
        );
      }
    },
    verifyForeignKeys: () => {
      const violation = options.database.prepare("PRAGMA foreign_key_check").get();
      if (violation !== undefined) {
        throw new Error("Legacy database foreign_key_check reported a violation.");
      }
    },
    inspectKnownMigrationState: () => {
      const schemaTable = options.database
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get();
      if (schemaTable === undefined) {
        throw new Error("Legacy database does not contain the known schema_migrations table.");
      }
      return inspectMigrationState(options.database, options.migrationsDirectory);
    },
    assertDatabaseIdentity: () => options.storage.assertLegacyCandidate(),
    cleanupIncompleteBackups: () => {
      cleanupIncompleteMigrationBackups(options.databasePath);
    },
    createBackup: async (state) => {
      await createMigrationBackup({
        database: options.database,
        databasePath: options.databasePath,
        currentVersion: state.currentVersion,
        targetVersion: state.targetVersion,
      });
    },
    consumeLegacyAdoptionAuthorization: () => options.storage.consumeLegacyAdoptionAuthorization(),
    publishInitializedMarker: () => options.storage.adoptLegacyDatabase(),
  });
