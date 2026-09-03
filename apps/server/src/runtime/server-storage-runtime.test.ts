import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { artifactCapacityFixedLayoutEntries } from "../../dist/artifacts/capacity.js";
import { DatabaseOwnerLock } from "../../dist/database/owner-lock.js";
import {
  createRecoveryMaintenanceStorageRuntime,
  createServerStorageRuntime,
  type ServerStorageRuntime,
} from "../../dist/runtime/server-storage-runtime.js";
import { createServerStorageRuntimeWithInitialSweepTimeout } from "./server-storage-runtime.testing.js";

const migrationsDirectory = resolve(import.meta.dirname, "../../../..", "migrations");
const temporaryDirectories: string[] = [];
const runtimes: ServerStorageRuntime[] = [];

const artifactStorage = (rootPath: string) => ({
  rootPath,
  capacity: {
    hardBytes: 100_000_000n,
    hardEntries: 1_000,
    emergencyReserveBytes: 10_000n,
    perUploadMetadataHeadroomBytes: 4_096n,
    cleanupBacklogHighWaterEntries: 100,
  },
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-server-storage-runtime-"));
  await chmod(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
};

const databasePathFor = async (directory: string): Promise<string> => {
  const databaseDirectory = join(directory, "database");
  await mkdir(databaseDirectory, { mode: 0o700 });
  return join(databaseDirectory, "server.sqlite");
};

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) {
    await runtime.close().catch(() => undefined);
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "linux")("ServerStorageRuntime", () => {
  it("keeps recovery maintenance database-only and releases its owner lock", async () => {
    const directory = await temporaryDirectory();
    const databasePath = await databasePathFor(directory);
    const artifactRoot = join(directory, "artifact-sentinel");
    const sentinelPath = join(artifactRoot, "must-not-be-touched.txt");
    await mkdir(artifactRoot, { mode: 0o700 });
    await writeFile(sentinelPath, "preserve recovery evidence", { mode: 0o600 });
    const entriesBefore = await readdir(artifactRoot);
    const sentinelBefore = await readFile(sentinelPath, "utf8");

    const runtime = await createRecoveryMaintenanceStorageRuntime({
      databasePath,
      migrationsDirectory,
    });
    runtimes.push(runtime);

    expect(runtime.artifactReadiness.read()).toEqual({ ready: false });
    await expect(runtime.database.request("ping", {})).resolves.toMatchObject({
      schemaVersion: 13,
    });
    await expect(
      runtime.artifactTransactions.createArtifactUpload({} as never),
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_NOT_READY" });
    await expect(
      runtime.artifactTransactions.putArtifactChunk("unused", {} as never),
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_NOT_READY" });
    await expect(
      runtime.artifactTransactions.finalizeArtifactUpload("unused", {} as never),
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_NOT_READY" });
    await expect(
      runtime.artifactTransactions.terminateArtifactUpload("unused", {} as never),
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_NOT_READY" });
    await expect(runtime.artifactCompletion.completeArtifactRun({} as never)).rejects.toMatchObject(
      { code: "ARTIFACT_TRANSACTION_NOT_READY" },
    );
    expect(await readdir(artifactRoot)).toEqual(entriesBefore);
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinelBefore);

    await runtime.close();
    await runtime.close();
    expect(runtime.artifactReadiness.read()).toEqual({ ready: false });
    expect(await readdir(artifactRoot)).toEqual(entriesBefore);
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinelBefore);
    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });

  it("returns only after the first sweep and owns the complete close order", async () => {
    const directory = await temporaryDirectory();
    const databasePath = await databasePathFor(directory);
    const rootPath = join(directory, "artifacts");
    const stagingPath = join(rootPath, "staging");
    const orphanPath = join(stagingPath, "80000000-0000-4000-8000-000000000001.upload");
    await mkdir(stagingPath, { recursive: true, mode: 0o700 });
    await mkdir(join(rootPath, "objects", "sha256"), { recursive: true, mode: 0o700 });
    await writeFile(orphanPath, "orphan", { mode: 0o600 });
    const failStops: Error[] = [];

    const runtime = await createServerStorageRuntime({
      databasePath,
      migrationsDirectory,
      artifactStorage: artifactStorage(rootPath),
      onFailStop: (error) => {
        failStops.push(error);
      },
    });
    runtimes.push(runtime);

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.ownKeys(runtime)).toEqual([
      "database",
      "artifactReadiness",
      "artifactTransactions",
      "artifactCompletion",
      "close",
    ]);
    expect(Object.isFrozen(runtime.artifactTransactions)).toBe(true);
    expect(Reflect.ownKeys(runtime.artifactTransactions)).toEqual([
      "createArtifactUpload",
      "putArtifactChunk",
      "finalizeArtifactUpload",
      "terminateArtifactUpload",
    ]);
    expect(runtime.artifactTransactions).not.toHaveProperty("close");
    expect(runtime.artifactTransactions).not.toHaveProperty("ready");
    expect(runtime.artifactTransactions).not.toHaveProperty("readiness");
    expect(runtime.artifactTransactions).not.toHaveProperty("fatal");
    expect(Object.isFrozen(runtime.artifactCompletion)).toBe(true);
    expect(Reflect.ownKeys(runtime.artifactCompletion)).toEqual(["completeArtifactRun"]);
    expect(runtime.artifactCompletion).not.toHaveProperty("readObject");
    expect(runtime.artifactCompletion).not.toHaveProperty("close");
    expect(runtime.artifactCompletion).not.toHaveProperty("readiness");
    expect(runtime.artifactCompletion).not.toHaveProperty("fatal");
    expect(runtime.artifactReadiness.read()).toEqual({ ready: true });
    await expect(stat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
    const layoutEntries = await readdir(rootPath, { recursive: true, withFileTypes: true });
    expect(layoutEntries).toHaveLength(artifactCapacityFixedLayoutEntries);
    expect(layoutEntries.every((entry) => entry.isDirectory())).toBe(true);
    await expect(runtime.database.request("ping", {})).resolves.toMatchObject({
      schemaVersion: 13,
    });
    await expect(runtime.database.close()).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_AUTHORITY_REQUIRED",
    });
    expect(runtime.artifactReadiness.read()).toEqual({ ready: true });
    expect(failStops).toEqual([]);

    await runtime.close();
    expect(runtime.artifactReadiness.read()).toEqual({ ready: false });
    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });

  it("proves failed storage-owner exit before closing the database and owner lock", async () => {
    const directory = await temporaryDirectory();
    const databasePath = await databasePathFor(directory);
    const rootPath = join(directory, "artifact-root-is-a-file");
    await writeFile(rootPath, "not-a-directory", { mode: 0o600 });

    await expect(
      createServerStorageRuntime({
        databasePath,
        migrationsDirectory,
        artifactStorage: artifactStorage(rootPath),
        onFailStop: () => undefined,
      }),
    ).rejects.toThrow();

    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });

  it("snapshots hostile option getters once before creating any owner", async () => {
    const directory = await temporaryDirectory();
    const databasePath = await databasePathFor(directory);
    const rootPath = join(directory, "artifacts");
    const reads = new Map<string, number>();
    const once = <T>(name: string, value: T): T => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      if (count !== 1) throw new Error(`${name} was read more than once.`);
      return value;
    };
    const capacity = {
      get hardBytes() {
        return once("hardBytes", 100_000_000n);
      },
      get hardEntries() {
        return once("hardEntries", 1_000);
      },
      get emergencyReserveBytes() {
        return once("emergencyReserveBytes", 10_000n);
      },
      get perUploadMetadataHeadroomBytes() {
        return once("perUploadMetadataHeadroomBytes", 4_096n);
      },
      get cleanupBacklogHighWaterEntries() {
        return once("cleanupBacklogHighWaterEntries", 100);
      },
    };
    const configuredArtifactStorage = {
      get rootPath() {
        return once("rootPath", rootPath);
      },
      get capacity() {
        return once("capacity", capacity);
      },
    };
    const runtime = await createServerStorageRuntime({
      get databasePath() {
        return once("databasePath", databasePath);
      },
      get migrationsDirectory() {
        return once("migrationsDirectory", migrationsDirectory);
      },
      get artifactStorage() {
        return once("artifactStorage", configuredArtifactStorage);
      },
      get onFailStop() {
        return once("onFailStop", () => undefined);
      },
    });
    runtimes.push(runtime);

    expect(Object.fromEntries(reads)).toEqual({
      databasePath: 1,
      migrationsDirectory: 1,
      artifactStorage: 1,
      onFailStop: 1,
      rootPath: 1,
      capacity: 1,
      hardBytes: 1,
      hardEntries: 1,
      emergencyReserveBytes: 1,
      perUploadMetadataHeadroomBytes: 1,
      cleanupBacklogHighWaterEntries: 1,
    });
    await runtime.close();
    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });

  it("fails the first sweep closed and releases ownership after durable cleanup failure", async () => {
    const directory = await temporaryDirectory();
    const databasePath = await databasePathFor(directory);
    const rootPath = join(directory, "artifacts");
    const seed = await createServerStorageRuntime({
      databasePath,
      migrationsDirectory,
      artifactStorage: artifactStorage(rootPath),
      onFailStop: () => undefined,
    });
    runtimes.push(seed);
    await seed.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA journal_mode = DELETE");
      const timestamp = "2026-09-02T00:00:00.000Z";
      database
        .prepare(`
          INSERT INTO artifact_namespace_cleanup_journal (
            entry_key,
            observation_sha256,
            kind,
            observed_bytes,
            expected_link_count,
            file_device,
            file_inode,
            file_ctime_ns,
            file_mode,
            file_uid,
            parent_device,
            parent_inode,
            parent_mode,
            parent_uid,
            reason,
            observed_sweep_generation,
            created_at,
            updated_at
          ) VALUES (?, ?, 'staging', 0, 1, '1', '2', '3', '384', '0', '1', '4', '448', '0',
            'orphan', 0, ?, ?)
        `)
        .run(
          "staging/80000000-0000-4000-8000-000000000002.upload",
          "a".repeat(64),
          timestamp,
          timestamp,
        );
      const retry = database.prepare(`
        UPDATE artifact_namespace_cleanup_journal
        SET status = ?,
            attempt_count = ?,
            next_attempt_at = ?,
            last_error_code = 'storage_unavailable',
            last_error_message = 'Artifact namespace cleanup owner is unavailable.',
            last_retry_delay_seconds = 1,
            updated_at = ?
        WHERE entry_key = 'staging/80000000-0000-4000-8000-000000000002.upload'
      `);
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        retry.run(
          attempt === 8 ? "failed" : "retry_waiting",
          attempt,
          attempt === 8 ? null : timestamp,
          timestamp,
        );
      }
    } finally {
      database.close();
    }

    const failStops: Error[] = [];
    await expect(
      createServerStorageRuntime({
        databasePath,
        migrationsDirectory,
        artifactStorage: artifactStorage(rootPath),
        onFailStop: (error) => {
          failStops.push(error);
        },
      }),
    ).rejects.toThrow();
    expect(failStops).toHaveLength(1);

    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });

  it("times out an incomplete first sweep and releases every owner", async () => {
    const directory = await temporaryDirectory();
    const databasePath = await databasePathFor(directory);
    const rootPath = join(directory, "artifacts");
    const stagingPath = join(rootPath, "staging");
    await mkdir(stagingPath, { recursive: true, mode: 0o700 });
    await mkdir(join(rootPath, "objects", "sha256"), { recursive: true, mode: 0o700 });
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        writeFile(
          join(
            stagingPath,
            `80000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}.upload`,
          ),
          "",
          { mode: 0o600 },
        ),
      ),
    );

    await expect(
      createServerStorageRuntimeWithInitialSweepTimeout(
        {
          databasePath,
          migrationsDirectory,
          artifactStorage: artifactStorage(rootPath),
          onFailStop: () => undefined,
        },
        1,
      ),
    ).rejects.toThrow(/initial reconciliation sweep timed out/u);

    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });
});
