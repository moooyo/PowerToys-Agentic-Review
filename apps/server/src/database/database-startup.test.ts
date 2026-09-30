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

  it("builds the current schema without retired pre-release tables", async () => {
    const directory = await createTemporaryDirectory();
    const database = new DatabaseSync(join(directory, "schema.sqlite"));
    try {
      expect(runMigrations(database, migrationsDirectory)).toBe(31);
      expect(
        database.prepare("SELECT filename FROM schema_migrations WHERE version = 11").get(),
      ).toEqual({ filename: "0011_job_activation.sql" });
      expect(
        database.prepare("SELECT filename FROM schema_migrations WHERE version = 13").get(),
      ).toEqual({
        filename: "0013_prompt_profiles.sql",
      });
      expect(
        database
          .prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (
                'server_binding_receipt_issuer',
                'server_binding_authorizations',
                'server_bindings',
                'server_binding_revocations',
                'artifact_uploads',
                'artifact_upload_chunks',
                'run_artifacts',
                'artifact_completion_bindings'
              )
            ORDER BY name
          `)
          .all(),
      ).toEqual([]);
      expect(
        database
          .prepare(
            "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'worker_node_credentials'",
          )
          .get(),
      ).toEqual({ present: 1 });
    } finally {
      database.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects an initialized v7 database instead of migrating it during startup",
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

      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /unsupported pre-release schema version 7; version 8 or newer is required.*Rebuild the database/u,
      );
      await expect(lstat(join(directory, "data", "backups"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const unchangedDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(readSchemaVersion(unchangedDatabase)).toBe(7);
      } finally {
        unchangedDatabase.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "upgrades an initialized single-Worker database and preserves its credentials",
    async () => {
      const directory = await createTemporaryDirectory();
      const versionEightDirectory = await createMigrationPrefixDirectory(directory, 8);
      const databasePath = join(directory, "data", "state.sqlite");
      await mkdir(join(directory, "data"), { mode: 0o700 });
      const previous = new DatabaseSync(databasePath);
      try {
        runMigrations(previous, versionEightDirectory);
        previous
          .prepare(`
          INSERT INTO worker_node_credentials (
            worker_node_id, display_name, token_sha256, auth_state,
            created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject,
            created_at, updated_at
          ) VALUES ('existing-worker', 'Existing Worker', ?, 'pending',
            'loopback', 'operator', 'loopback', 'operator', ?, ?)
        `)
          .run("a".repeat(64), "2026-09-06T00:00:00.000Z", "2026-09-06T00:00:00.000Z");
      } finally {
        previous.close();
      }
      await chmod(databasePath, 0o600);
      await writeInitializationMarker(databasePath);
      const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
      try {
        await expect(client.request("ping", {})).resolves.toMatchObject({ schemaVersion: 31 });
        await expect(
          client.request("authenticateWorkerToken", {
            workerTokenSha256: "a".repeat(64),
          }),
        ).resolves.toMatchObject({ outcome: "authenticated", workerNodeId: "existing-worker" });
      } finally {
        await client.close();
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

  describe.skipIf(process.platform === "win32")("invalid database storage", () => {
    it.each([
      ["wrong-basename", "other.sqlite", "other", /unexpected entry other\.sqlite/u],
      ["extra-entry", "unexpected.txt", "unexpected", /unexpected entry unexpected\.txt/u],
    ] as const)(
      "rejects unexpected storage entries: %s",
      async (name, filename, content, error) => {
        const directory = await createTemporaryDirectory();
        const storageDirectory = join(directory, name);
        await mkdir(storageDirectory, { mode: 0o700 });
        await writeFile(join(storageDirectory, filename), content, { mode: 0o600 });
        await expect(
          DatabaseClient.create({
            databasePath: join(storageDirectory, "state.sqlite"),
            migrationsDirectory,
          }),
        ).rejects.toThrow(error);
      },
    );

    it("rejects storage exceeding the entry limit", async () => {
      const directory = await createTemporaryDirectory();
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
      await writeFile(join(overLimitDirectory, "eleventh-entry"), "extra", { mode: 0o600 });
      expect(maximumDatabaseStorageEntries).toBe(10);
      await expect(
        DatabaseClient.create({ databasePath: overLimitDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/(?:exceeds its 10-entry allowlist|unexpected entry eleventh-entry)/u);
    });

    it("rejects an empty uninitialized database", async () => {
      const directory = await createTemporaryDirectory();
      const emptyUninitializedDirectory = join(directory, "empty-uninitialized");
      const emptyUninitializedDatabasePath = join(emptyUninitializedDirectory, "state.sqlite");
      await mkdir(emptyUninitializedDirectory, { mode: 0o700 });
      await writeFile(emptyUninitializedDatabasePath, "", { mode: 0o600 });
      await expect(
        DatabaseClient.create({
          databasePath: emptyUninitializedDatabasePath,
          migrationsDirectory,
        }),
      ).rejects.toThrow(/uninitialized database.*empty.*recovery is required/iu);
    });

    it("rejects an unsupported initialization marker", async () => {
      const directory = await createTemporaryDirectory();
      const wrongMarkerDirectory = join(directory, "wrong-marker");
      const wrongMarkerDatabasePath = join(wrongMarkerDirectory, "state.sqlite");
      await mkdir(wrongMarkerDirectory, { mode: 0o700 });
      await writeFile(wrongMarkerDatabasePath, "existing", { mode: 0o600 });
      await writeFile(
        databaseInitializationMarkerPath(wrongMarkerDatabasePath),
        "agentic-review-database-initialization-v1\n",
        { mode: 0o600 },
      );
      await expect(
        DatabaseClient.create({ databasePath: wrongMarkerDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/initialization marker.*unsupported content/u);
    });

    it.each([
      ["initializing-missing", undefined],
      ["initializing-empty", ""],
      ["initializing-nonempty", "database"],
    ] as const)("rejects incomplete initialization history: %s", async (name, databaseContent) => {
      const directory = await createTemporaryDirectory();
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
    });

    it.each([
      ["initialized-missing", undefined],
      ["initialized-empty", ""],
    ] as const)(
      "rejects initialized database history without usable data: %s",
      async (name, databaseContent) => {
        const directory = await createTemporaryDirectory();
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
      },
    );

    it.each([
      ["truncated-marker", databaseInitializationMarkerContent.slice(0, -1)],
      ["huge-marker", "x".repeat(1_000_000)],
    ] as const)(
      "rejects initialization markers with an invalid size: %s",
      async (name, markerContent) => {
        const directory = await createTemporaryDirectory();
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
      },
    );

    it("rejects sidecar history without the database", async () => {
      const directory = await createTemporaryDirectory();
      const sidecarHistoryDirectory = join(directory, "sidecar-history");
      const sidecarHistoryDatabasePath = join(sidecarHistoryDirectory, "state.sqlite");
      await mkdir(sidecarHistoryDirectory, { mode: 0o700 });
      await writeFile(`${sidecarHistoryDatabasePath}-wal`, "history", { mode: 0o600 });
      await expect(
        DatabaseClient.create({ databasePath: sidecarHistoryDatabasePath, migrationsDirectory }),
      ).rejects.toThrow(/missing.*recovery is required/u);
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects every existing database without this version's initialization marker",
    async () => {
      const directory = await createTemporaryDirectory();
      const dataDirectory = join(directory, "data");
      const databasePath = join(dataDirectory, "state.sqlite");
      await mkdir(dataDirectory, { mode: 0o700 });
      const unmarkedDatabase = new DatabaseSync(databasePath);
      try {
        expect(runMigrations(unmarkedDatabase, migrationsDirectory)).toBe(31);
      } finally {
        unmarkedDatabase.close();
      }
      await chmod(databasePath, 0o600);

      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /not initialized by this Server version.*rebuild is required/u,
      );
      await expect(lstat(databaseInitializationMarkerPath(databasePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an initialized database with any applied migration beyond the current deployment",
    async () => {
      const directory = await createTemporaryDirectory();
      const databasePath = join(directory, "data", "state.sqlite");
      await mkdir(join(directory, "data"), { mode: 0o700 });
      const newerDatabase = new DatabaseSync(databasePath);
      try {
        const latestVersion = runMigrations(newerDatabase, migrationsDirectory);
        expect(latestVersion).toBe(31);
        const futureVersion = latestVersion + 1;
        newerDatabase
          .prepare(`
            INSERT INTO schema_migrations (version, filename, checksum, applied_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(
            futureVersion,
            `${futureVersion}_unknown.sql`,
            "0".repeat(64),
            "2026-09-04T00:00:00.000Z",
          );
      } finally {
        newerDatabase.close();
      }
      await chmod(databasePath, 0o600);
      await writeInitializationMarker(databasePath);

      await expect(DatabaseClient.create({ databasePath, migrationsDirectory })).rejects.toThrow(
        /Applied migration \d+ .* is missing from the deployment/u,
      );
    },
  );
});

const readSchemaVersion = (database: DatabaseSync): number => {
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
    readonly version: number | null;
  };
  return row.version ?? 0;
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
