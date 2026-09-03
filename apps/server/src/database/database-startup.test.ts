import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
  DatabaseClient,
  terminateWorkerAndWaitForExit,
} from "../../dist/database/database-client.js";
import { runMigrations } from "../../dist/database/migrations.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
  databaseInitializingMarkerPath,
  databaseLegacyAdoptionAuthorizationContent,
  databaseLegacyAdoptionAuthorizationPath,
  maximumDatabaseStorageEntries,
} from "../../dist/database/storage-security.js";

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
  it("waits for Worker exit after a termination failure", async () => {
    const terminationError = new Error("terminate failed");
    const exited = Promise.withResolvers<number>();
    let completed = false;
    const termination = terminateWorkerAndWaitForExit(
      {
        terminate: async () => {
          throw terminationError;
        },
      },
      exited.promise,
    ).then((result) => {
      completed = true;
      return result;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    exited.resolve(1);
    await expect(termination).resolves.toBe(terminationError);
    expect(completed).toBe(true);
  });

  it("adopts a valid legacy database after a verified backup and before pending migrations", async () => {
    const directory = await createTemporaryDirectory();
    const versionOneDirectory = join(directory, "migrations-v1");
    await mkdir(versionOneDirectory);
    await copyFile(
      join(migrationsDirectory, "0001_initial.sql"),
      join(versionOneDirectory, "0001_initial.sql"),
    );
    const dataDirectory = join(directory, "data");
    const databasePath = join(dataDirectory, "state.sqlite");
    await mkdir(dataDirectory, { mode: 0o700 });
    const seedDatabase = new DatabaseSync(databasePath);
    try {
      expect(runMigrations(seedDatabase, versionOneDirectory)).toBe(1);
    } finally {
      seedDatabase.close();
    }
    if (process.platform !== "win32") {
      await chmod(databasePath, 0o600);
    }
    await writeLegacyAdoptionAuthorization(databasePath);
    const backupDirectory = join(dataDirectory, "backups");
    await mkdir(backupDirectory, { mode: 0o700 });
    const staleBackupStem =
      "state.sqlite.v1-to-v7.2026-08-31T00-00-00-000Z.00000000-0000-4000-8000-000000000000.sqlite.partial";
    await Promise.all([
      writeFile(join(backupDirectory, staleBackupStem), "partial", { mode: 0o600 }),
      writeFile(join(backupDirectory, `${staleBackupStem}-wal`), "partial", { mode: 0o600 }),
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
      expect(readSchemaVersion(migratedDatabase)).toBe(13);
      expect(await readFile(databaseInitializationMarkerPath(databasePath), "utf8")).toBe(
        databaseInitializationMarkerContent,
      );
      await expect(
        lstat(databaseLegacyAdoptionAuthorizationPath(databasePath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      backupDatabase.close();
      migratedDatabase.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "starts Token-only from schema v12 and v13 while preserving dormant Server binding rows",
    async () => {
      for (const startingSchemaVersion of [12, 13] as const) {
        const directory = await createTemporaryDirectory();
        const migrationPrefixDirectory = await createMigrationPrefixDirectory(
          directory,
          startingSchemaVersion,
        );
        const dataDirectory = join(directory, `data-v${startingSchemaVersion}`);
        const databasePath = join(dataDirectory, "state.sqlite");
        await mkdir(dataDirectory, { mode: 0o700 });
        const expectedLegacyRows = (() => {
          const seedDatabase = new DatabaseSync(databasePath);
          try {
            expect(runMigrations(seedDatabase, migrationPrefixDirectory)).toBe(
              startingSchemaVersion,
            );
            return seedLegacyServerBindingRows(seedDatabase);
          } finally {
            seedDatabase.close();
          }
        })();
        await chmod(databasePath, 0o600);
        await writeInitializationMarker(databasePath);

        const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
        await expect(client.request("ping", {})).resolves.toMatchObject({ schemaVersion: 13 });
        await client.close();

        const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(readSchemaVersion(migratedDatabase)).toBe(13);
          expect(readLegacyServerBindingRows(migratedDatabase)).toEqual(expectedLegacyRows);
          expect(
            migratedDatabase.prepare("SELECT COUNT(*) AS count FROM worker_node_credentials").get(),
          ).toEqual({ count: 0 });
        } finally {
          migratedDatabase.close();
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "backs up an initialized v7 database before applying migrations through v13",
    async () => {
      const directory = await createTemporaryDirectory();
      const versionSevenDirectory = await createMigrationPrefixDirectory(directory, 7);
      const databasePath = join(directory, "data", "state.sqlite");

      await mkdir(join(directory, "data"), { mode: 0o700 });
      const versionSevenDatabase = new DatabaseSync(databasePath);
      try {
        expect(runMigrations(versionSevenDatabase, versionSevenDirectory)).toBe(7);
      } finally {
        versionSevenDatabase.close();
      }
      await chmod(databasePath, 0o600);
      await writeInitializationMarker(databasePath);
      expect(await readFile(databaseInitializationMarkerPath(databasePath), "utf8")).toBe(
        databaseInitializationMarkerContent,
      );

      const upgradedClient = await DatabaseClient.create({ databasePath, migrationsDirectory });
      await upgradedClient.close();

      const backupDirectory = join(directory, "data", "backups");
      const backupFiles = await readdir(backupDirectory);
      expect(backupFiles).toHaveLength(1);
      const backupFilename = backupFiles[0] as string;
      expect(backupFilename).toContain(".v7-to-v13.");

      const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
      const backupDatabase = new DatabaseSync(join(backupDirectory, backupFilename), {
        readOnly: true,
      });
      try {
        expect(readSchemaVersion(migratedDatabase)).toBe(13);
        expect(readSchemaVersion(backupDatabase)).toBe(7);
      } finally {
        migratedDatabase.close();
        backupDatabase.close();
      }
    },
  );

  it("leaves a failed fresh migration in an explicit recovery-required state", async () => {
    const directory = await createTemporaryDirectory();
    const invalidMigrationsDirectory = join(directory, "invalid-migrations");
    await mkdir(invalidMigrationsDirectory);
    const migrationPath = join(invalidMigrationsDirectory, "0001_initial.sql");
    await writeFile(migrationPath, "THIS IS NOT SQL", "utf8");
    const databasePath = join(directory, "data", "state.sqlite");

    await expect(
      DatabaseClient.create({ databasePath, migrationsDirectory: invalidMigrationsDirectory }),
    ).rejects.toThrow();
    expect(await readFile(databaseInitializingMarkerPath(databasePath), "utf8")).toBe(
      databaseInitializationMarkerContent,
    );
    await expect(lstat(databaseInitializationMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(
      migrationPath,
      await readFile(join(migrationsDirectory, "0001_initial.sql"), "utf8"),
      "utf8",
    );
    await expect(
      DatabaseClient.create({ databasePath, migrationsDirectory: invalidMigrationsDirectory }),
    ).rejects.toThrow(/incomplete initialization marker.*recovery is required/u);

    const replacement = await DatabaseClient.create({
      databasePath: join(directory, "replacement-data", "state.sqlite"),
      migrationsDirectory,
    });
    await replacement.close();
  });

  it.skipIf(process.platform === "win32")(
    "creates private database and WAL files before readiness",
    async () => {
      const directory = await createTemporaryDirectory();
      const databasePath = join(directory, "state.sqlite");
      const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
      try {
        for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
          const stats = await lstat(path);
          expect(stats.isFile()).toBe(true);
          expect(stats.nlink).toBe(1);
          expect(stats.mode & 0o7777).toBe(0o600);
        }
        const markerPath = databaseInitializationMarkerPath(databasePath);
        expect(await readFile(markerPath, "utf8")).toBe(databaseInitializationMarkerContent);
        const markerStats = await lstat(markerPath);
        expect(markerStats.isFile()).toBe(true);
        expect(markerStats.nlink).toBe(1);
        expect(markerStats.mode & 0o7777).toBe(0o600);
        await expect(lstat(databaseInitializingMarkerPath(databasePath))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await client.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects permissive storage and sidecar symlinks before opening SQLite",
    async () => {
      const directory = await createTemporaryDirectory();
      const permissiveDirectory = join(directory, "permissive");
      await mkdir(permissiveDirectory, { mode: 0o700 });
      await chmod(permissiveDirectory, 0o755);
      await expect(
        DatabaseClient.create({
          databasePath: join(permissiveDirectory, "state.sqlite"),
          migrationsDirectory,
        }),
      ).rejects.toThrow(/mode 0700/u);

      const fileModeDirectory = join(directory, "file-mode");
      const fileModeDatabasePath = join(fileModeDirectory, "state.sqlite");
      await mkdir(fileModeDirectory, { mode: 0o700 });
      await writeFile(fileModeDatabasePath, "");
      await chmod(fileModeDatabasePath, 0o644);
      await expect(
        DatabaseClient.create({ databasePath: fileModeDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/mode 0600/u);

      const sidecarDirectory = join(directory, "sidecar");
      const databasePath = join(sidecarDirectory, "state.sqlite");
      const sidecarTarget = join(directory, "sidecar-target");
      await mkdir(sidecarDirectory, { mode: 0o700 });
      await writeFile(databasePath, "initialized");
      await chmod(databasePath, 0o600);
      await writeInitializationMarker(databasePath);
      await writeFile(sidecarTarget, "");
      await chmod(sidecarTarget, 0o600);
      await symlink(sidecarTarget, `${databasePath}-wal`, "file");
      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /sidecar.*symbolic link/u,
      );

      await rm(`${databasePath}-wal`);
      await symlink(sidecarTarget, `${databasePath}-journal`, "file");
      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /sidecar.*symbolic link/u,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects unexpected entries and database initialization history without the database",
    async () => {
      const directory = await createTemporaryDirectory();

      const wrongBasenameDirectory = join(directory, "wrong-basename");
      await mkdir(wrongBasenameDirectory, { mode: 0o700 });
      await writeFile(join(wrongBasenameDirectory, "other.sqlite"), "other", { mode: 0o600 });
      await expect(
        DatabaseClient.create({
          databasePath: join(wrongBasenameDirectory, "state.sqlite"),
          migrationsDirectory,
        }),
      ).rejects.toThrow(/unexpected entry other\.sqlite/u);

      const extraEntryDirectory = join(directory, "extra-entry");
      await mkdir(extraEntryDirectory, { mode: 0o700 });
      await writeFile(join(extraEntryDirectory, "unexpected.txt"), "unexpected", { mode: 0o600 });
      await expect(
        DatabaseClient.create({
          databasePath: join(extraEntryDirectory, "state.sqlite"),
          migrationsDirectory,
        }),
      ).rejects.toThrow(/unexpected entry unexpected\.txt/u);

      const overLimitDirectory = join(directory, "over-limit");
      const overLimitDatabasePath = join(overLimitDirectory, "state.sqlite");
      await mkdir(overLimitDirectory, { mode: 0o700 });
      for (const filename of [
        "state.sqlite",
        "state.sqlite-journal",
        "state.sqlite-wal",
        "state.sqlite-shm",
        "state.sqlite.owner-lock.sqlite",
        "state.sqlite.owner-lock.sqlite-journal",
        "state.sqlite.owner-lock.sqlite-wal",
        "state.sqlite.owner-lock.sqlite-shm",
      ]) {
        await writeFile(join(overLimitDirectory, filename), "entry", { mode: 0o600 });
      }
      await writeFile(
        databaseInitializingMarkerPath(overLimitDatabasePath),
        databaseInitializationMarkerContent,
        { mode: 0o600 },
      );
      await writeInitializationMarker(overLimitDatabasePath);
      await writeLegacyAdoptionAuthorization(overLimitDatabasePath);
      await mkdir(join(overLimitDirectory, "backups"), { mode: 0o700 });
      await writeFile(join(overLimitDirectory, "thirteenth-entry"), "extra", { mode: 0o600 });
      expect(maximumDatabaseStorageEntries).toBe(12);
      await expect(
        DatabaseClient.create({ databasePath: overLimitDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/(?:exceeds its 12-entry allowlist|unexpected entry thirteenth-entry)/u);

      const emptyLegacyDirectory = join(directory, "empty-legacy");
      const emptyLegacyDatabasePath = join(emptyLegacyDirectory, "state.sqlite");
      await mkdir(emptyLegacyDirectory, { mode: 0o700 });
      await writeFile(emptyLegacyDatabasePath, "", { mode: 0o600 });
      await expect(
        DatabaseClient.create({ databasePath: emptyLegacyDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/uninitialized database.*empty.*recovery is required/iu);

      const wrongMarkerDirectory = join(directory, "wrong-marker");
      const wrongMarkerDatabasePath = join(wrongMarkerDirectory, "state.sqlite");
      await mkdir(wrongMarkerDirectory, { mode: 0o700 });
      await writeFile(wrongMarkerDatabasePath, "existing", { mode: 0o600 });
      await writeFile(
        databaseInitializationMarkerPath(wrongMarkerDatabasePath),
        "x".repeat(databaseInitializationMarkerContent.length),
        { mode: 0o600 },
      );
      await expect(
        DatabaseClient.create({ databasePath: wrongMarkerDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/initialization marker.*unsupported content/u);

      for (const [name, databaseContent] of [
        ["initializing-missing", undefined],
        ["initializing-empty", ""],
        ["initializing-nonempty", "database"],
      ] as const) {
        const initializingDirectory = join(directory, name);
        const initializingDatabasePath = join(initializingDirectory, "state.sqlite");
        await mkdir(initializingDirectory, { mode: 0o700 });
        if (databaseContent !== undefined) {
          await writeFile(initializingDatabasePath, databaseContent, { mode: 0o600 });
        }
        await writeFile(
          databaseInitializingMarkerPath(initializingDatabasePath),
          databaseInitializationMarkerContent,
          { mode: 0o600 },
        );
        await expect(
          DatabaseClient.create({ databasePath: initializingDatabasePath, migrationsDirectory }),
        ).rejects.toThrow(/incomplete initialization marker.*recovery is required/u);
      }

      for (const [name, databaseContent] of [
        ["initialized-missing", undefined],
        ["initialized-empty", ""],
      ] as const) {
        const initializedDirectory = join(directory, name);
        const initializedDatabasePath = join(initializedDirectory, "state.sqlite");
        await mkdir(initializedDirectory, { mode: 0o700 });
        if (databaseContent !== undefined) {
          await writeFile(initializedDatabasePath, databaseContent, { mode: 0o600 });
        }
        await writeInitializationMarker(initializedDatabasePath);
        await expect(
          DatabaseClient.create({ databasePath: initializedDatabasePath, migrationsDirectory }),
        ).rejects.toThrow(/initialized database.*missing or empty.*recovery is required/iu);
      }

      for (const [name, markerContent] of [
        ["truncated-marker", databaseInitializationMarkerContent.slice(0, -1)],
        ["huge-marker", "x".repeat(1_000_000)],
      ] as const) {
        const markerDirectory = join(directory, name);
        const markerDatabasePath = join(markerDirectory, "state.sqlite");
        await mkdir(markerDirectory, { mode: 0o700 });
        await writeFile(markerDatabasePath, "database", { mode: 0o600 });
        await writeFile(databaseInitializationMarkerPath(markerDatabasePath), markerContent, {
          mode: 0o600,
        });
        await expect(
          DatabaseClient.create({ databasePath: markerDatabasePath, migrationsDirectory }),
        ).rejects.toThrow(/must contain exactly.*bytes/u);
      }

      const sidecarHistoryDirectory = join(directory, "sidecar-history");
      const sidecarHistoryDatabasePath = join(sidecarHistoryDirectory, "state.sqlite");
      await mkdir(sidecarHistoryDirectory, { mode: 0o700 });
      await writeFile(`${sidecarHistoryDatabasePath}-wal`, "history", { mode: 0o600 });
      await expect(
        DatabaseClient.create({ databasePath: sidecarHistoryDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/missing.*recovery is required/u);

      const backupHistoryDirectory = join(directory, "backup-history");
      const backupHistoryDatabasePath = join(backupHistoryDirectory, "state.sqlite");
      const backups = join(backupHistoryDirectory, "backups");
      await mkdir(backups, { recursive: true, mode: 0o700 });
      const backupStem =
        "state.sqlite.v1-to-v2.2026-08-31T00-00-00-000Z.00000000-0000-4000-8000-000000000000.sqlite";
      await Promise.all([
        writeFile(join(backups, backupStem), "final", { mode: 0o600 }),
        writeFile(join(backups, `${backupStem}.partial`), "partial", { mode: 0o600 }),
      ]);
      await expect(
        DatabaseClient.create({ databasePath: backupHistoryDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/missing.*recovery is required/u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a legacy database whose schema is not a known migration state",
    async () => {
      const directory = await createTemporaryDirectory();
      const dataDirectory = join(directory, "data");
      const databasePath = join(dataDirectory, "state.sqlite");
      await mkdir(dataDirectory, { mode: 0o700 });
      const legacyDatabase = new DatabaseSync(databasePath);
      try {
        legacyDatabase.exec("CREATE TABLE unknown_legacy_table (value TEXT NOT NULL) STRICT");
      } finally {
        legacyDatabase.close();
      }
      await chmod(databasePath, 0o600);
      await writeLegacyAdoptionAuthorization(databasePath);

      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /does not contain the known schema_migrations table/u,
      );
      await expect(lstat(databaseInitializationMarkerPath(databasePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "requires and consumes a one-time legacy adoption authorization",
    async () => {
      const directory = await createTemporaryDirectory();
      const dataDirectory = join(directory, "data");
      const databasePath = join(dataDirectory, "state.sqlite");
      await mkdir(dataDirectory, { mode: 0o700 });
      const legacyDatabase = new DatabaseSync(databasePath);
      try {
        runMigrations(legacyDatabase, migrationsDirectory);
      } finally {
        legacyDatabase.close();
      }
      await chmod(databasePath, 0o600);

      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /requires an explicit legacy adoption authorization.*recovery is required/u,
      );

      const authorizationPath = databaseLegacyAdoptionAuthorizationPath(databasePath);
      await writeFile(
        authorizationPath,
        "x".repeat(databaseLegacyAdoptionAuthorizationContent.length),
        { mode: 0o600 },
      );
      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /legacy adoption authorization.*unsupported content/iu,
      );
      await rm(authorizationPath);

      await writeLegacyAdoptionAuthorization(databasePath);
      const adopted = await DatabaseClient.create({ databasePath, migrationsDirectory });
      await adopted.close();
      await expect(lstat(authorizationPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(databaseInitializationMarkerPath(databasePath), "utf8")).toBe(
        databaseInitializationMarkerContent,
      );

      await writeLegacyAdoptionAuthorization(databasePath);
      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /contradictory legacy adoption authorization.*recovery is required/u,
      );
      await rm(authorizationPath);
      await rm(databaseInitializationMarkerPath(databasePath));
      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /requires an explicit legacy adoption authorization.*recovery is required/u,
      );

      const freshDirectory = join(directory, "fresh-with-authorization");
      const freshDatabasePath = join(freshDirectory, "state.sqlite");
      await mkdir(freshDirectory, { mode: 0o700 });
      await writeLegacyAdoptionAuthorization(freshDatabasePath);
      await expect(
        DatabaseClient.create({ databasePath: freshDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/contradictory legacy adoption authorization.*recovery is required/u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects legacy foreign-key violations before backup or authorization consumption",
    async () => {
      const directory = await createTemporaryDirectory();
      const versionOneDirectory = join(directory, "migrations-v1");
      await mkdir(versionOneDirectory);
      await copyFile(
        join(migrationsDirectory, "0001_initial.sql"),
        join(versionOneDirectory, "0001_initial.sql"),
      );
      const dataDirectory = join(directory, "data");
      const databasePath = join(dataDirectory, "state.sqlite");
      await mkdir(dataDirectory, { mode: 0o700 });
      const legacyDatabase = new DatabaseSync(databasePath);
      try {
        runMigrations(legacyDatabase, versionOneDirectory);
        legacyDatabase.exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE orphan_parent (id INTEGER PRIMARY KEY) STRICT;
          CREATE TABLE orphan_child (
            parent_id INTEGER NOT NULL REFERENCES orphan_parent (id)
          ) STRICT;
          INSERT INTO orphan_child (parent_id) VALUES (1);
        `);
      } finally {
        legacyDatabase.close();
      }
      await chmod(databasePath, 0o600);
      await writeLegacyAdoptionAuthorization(databasePath);

      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /foreign_key_check reported a violation/u,
      );
      expect(await readFile(databaseLegacyAdoptionAuthorizationPath(databasePath), "utf8")).toBe(
        databaseLegacyAdoptionAuthorizationContent,
      );
      await expect(lstat(databaseInitializationMarkerPath(databasePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(join(dataDirectory, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

const readSchemaVersion = (database: DatabaseSync): number => {
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
    readonly version: number | null;
  };
  return row.version ?? 0;
};

interface LegacyServerBindingRows {
  readonly authorization: unknown;
  readonly binding: unknown;
  readonly issuer: unknown;
  readonly revocation: unknown;
}

const readLegacyServerBindingRows = (database: DatabaseSync): LegacyServerBindingRows => ({
  authorization: database.prepare("SELECT * FROM server_binding_authorizations").get(),
  binding: database.prepare("SELECT * FROM server_bindings").get(),
  issuer: database.prepare("SELECT * FROM server_binding_receipt_issuer").get(),
  revocation: database.prepare("SELECT * FROM server_binding_revocations").get(),
});

const seedLegacyServerBindingRows = (database: DatabaseSync): LegacyServerBindingRows => {
  const authorizationId = "10000000-0000-4000-8000-000000000001";
  const requestId = "10000000-0000-4000-8000-000000000002";
  const bindingId = "10000000-0000-4000-8000-000000000003";
  const revocationId = "10000000-0000-4000-8000-000000000004";
  const issuerKeyId = "a".repeat(64);
  const tokenSha256 = "b".repeat(64);
  const issuanceRequestSha256 = "c".repeat(64);
  const certificateDerSha256 = "d".repeat(64);
  const statementDocumentSha256 = "e".repeat(64);
  const revocationRequestSha256 = "f".repeat(64);
  const createdAt = "2026-09-03T00:00:00.000Z";
  const consumedAt = "2026-09-03T00:00:01.000Z";
  const revokedAt = "2026-09-03T00:00:02.000Z";
  const expiresAt = "2026-09-03T00:10:00.000Z";
  const workerNodeId = "legacy-worker";
  const installationId = "legacy-installation";
  const statementJson = JSON.stringify({
    bindingId,
    bindingRevision: 1,
    boundAt: consumedAt,
    certificateDerSha256,
    enrollmentGeneration: 1,
    installationId,
    statementType: "durable-binding-created",
    workerNodeId,
  });

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`
        INSERT INTO server_binding_receipt_issuer (
          singleton_id,
          authority_schema_version,
          issuer,
          receipt_profile_id,
          active_status_profile_id,
          signature_algorithm,
          issuer_key_id,
          initialized_at
        ) VALUES (1, 1, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "agentic-review-server-enrollment-binding-authority-v1",
        "agentic-review-server-binding-receipt-v1",
        "agentic-review-server-binding-active-status-v1",
        "ecdsa-p256-sha256-p1363-low-s",
        issuerKeyId,
        createdAt,
      );
    database
      .prepare(`
        INSERT INTO server_binding_authorizations (
          authorization_id,
          request_id,
          token_sha256,
          operator_issuer,
          operator_subject,
          worker_node_id,
          installation_id,
          enrollment_generation,
          expected_certificate_der_sha256,
          issuer_key_id,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `)
      .run(
        authorizationId,
        requestId,
        tokenSha256,
        "legacy-operator-issuer",
        "legacy-operator-subject",
        workerNodeId,
        installationId,
        certificateDerSha256,
        issuerKeyId,
        createdAt,
        expiresAt,
      );
    database
      .prepare(`
        UPDATE server_binding_authorizations
        SET
          consumed_binding_id = ?,
          consumed_issuance_request_sha256 = ?,
          consumed_at = ?
        WHERE authorization_id = ?
      `)
      .run(bindingId, issuanceRequestSha256, consumedAt, authorizationId);
    database
      .prepare(`
        INSERT INTO server_bindings (
          binding_id,
          binding_revision,
          authorization_id,
          request_id,
          issuance_request_sha256,
          worker_node_id,
          installation_id,
          enrollment_generation,
          certificate_der_sha256,
          issuer_key_id,
          phase,
          bound_at,
          statement_json,
          statement_document_sha256
        ) VALUES (?, 1, ?, ?, ?, ?, ?, 1, ?, ?, 'signing_pending', ?, ?, ?)
      `)
      .run(
        bindingId,
        authorizationId,
        requestId,
        issuanceRequestSha256,
        workerNodeId,
        installationId,
        certificateDerSha256,
        issuerKeyId,
        consumedAt,
        statementJson,
        statementDocumentSha256,
      );
    database
      .prepare(`
        INSERT INTO server_binding_revocations (
          revocation_id,
          revocation_request_sha256,
          binding_id,
          prior_phase,
          reason_code,
          revoked_at
        ) VALUES (?, ?, ?, 'signing_pending', 'operator_requested', ?)
      `)
      .run(revocationId, revocationRequestSha256, bindingId, revokedAt);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
  return readLegacyServerBindingRows(database);
};

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-database-startup-"));
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
  temporaryDirectories.push(directory);
  return directory;
};

const createMigrationPrefixDirectory = async (
  parentDirectory: string,
  targetVersion: number,
): Promise<string> => {
  const directory = join(parentDirectory, `migrations-v${targetVersion}`);
  await mkdir(directory);
  const filenames = (await readdir(migrationsDirectory)).filter((filename) => {
    const versionText = /^(\d+)_.*\.sql$/u.exec(filename)?.[1];
    return versionText !== undefined && Number.parseInt(versionText, 10) <= targetVersion;
  });
  await Promise.all(
    filenames.map((filename) =>
      copyFile(join(migrationsDirectory, filename), join(directory, filename)),
    ),
  );
  return directory;
};

const writeInitializationMarker = async (databasePath: string): Promise<void> => {
  await writeFile(
    databaseInitializationMarkerPath(databasePath),
    databaseInitializationMarkerContent,
    { mode: 0o600 },
  );
};

const writeLegacyAdoptionAuthorization = async (databasePath: string): Promise<void> => {
  await writeFile(
    databaseLegacyAdoptionAuthorizationPath(databasePath),
    databaseLegacyAdoptionAuthorizationContent,
    { mode: 0o600 },
  );
};
