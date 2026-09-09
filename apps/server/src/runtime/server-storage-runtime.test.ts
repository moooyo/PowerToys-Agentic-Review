import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseOwnerLock } from "../../dist/database/owner-lock.js";
import {
  createRecoveryMaintenanceStorageRuntime,
  createServerStorageRuntime,
  type ServerStorageRuntime,
} from "../../dist/runtime/server-storage-runtime.js";
import { DatabaseClient as SourceDatabaseClient } from "../database/database-client.js";
import type { EvidenceStorageOptions } from "../database/evidence-assets.js";
import { DatabaseOwnerLock as SourceDatabaseOwnerLock } from "../database/owner-lock.js";
import {
  type CreateServerStorageRuntimeOptions,
  createRecoveryMaintenanceStorageRuntime as createRecoveryRuntimeFromSource,
  createServerStorageRuntime as createServerRuntimeFromSource,
  type ServerStorageRuntime as SourceServerStorageRuntime,
} from "./server-storage-runtime.js";

const migrationsDirectory = resolve(import.meta.dirname, "../../../..", "migrations");
const temporaryDirectories: string[] = [];
const runtimes: ServerStorageRuntime[] = [];

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

const expectedSchemaVersion = async (): Promise<number> => {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /^\d+_.*\.sql$/u.test(entry.name)).length;
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
  it("starts in recovery maintenance with database ownership only", async () => {
    const directory = await temporaryDirectory();
    const databasePath = await databasePathFor(directory);

    const runtime = await createRecoveryMaintenanceStorageRuntime({
      databasePath,
      migrationsDirectory,
      operatorAccess: { administrators: [{ issuer: "urn:fixture", subject: "recovery-admin" }] },
    });
    runtimes.push(runtime);

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.ownKeys(runtime)).toEqual(["database", "close"]);
    await expect(runtime.database.request("ping", {})).resolves.toMatchObject({
      schemaVersion: await expectedSchemaVersion(),
    });
    await expect(
      runtime.database.request("getOperatorAccessContext", {
        actor: { issuer: "urn:fixture", subject: "recovery-admin" },
      }),
    ).resolves.toMatchObject({ platformAdministrator: true });
    await expect(
      runtime.database.request("getOperatorAccessContext", {
        actor: { issuer: "urn:fixture", subject: "Recovery-admin" },
      }),
    ).resolves.toMatchObject({ platformAdministrator: false });

    await runtime.close();
    await runtime.close();
    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });

  it("starts in production mode with the same database-only ownership model", async () => {
    const directory = await temporaryDirectory();
    const databasePath = await databasePathFor(directory);

    const runtime = await createServerStorageRuntime({
      databasePath,
      migrationsDirectory,
      operatorAccess: { administrators: [{ issuer: "urn:fixture", subject: "production-admin" }] },
    });
    runtimes.push(runtime);

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.ownKeys(runtime)).toEqual(["database", "close"]);
    await expect(runtime.database.request("ping", {})).resolves.toMatchObject({
      schemaVersion: await expectedSchemaVersion(),
    });
    await expect(
      runtime.database.request("getOperatorAccessContext", {
        actor: { issuer: "urn:fixture", subject: "production-admin" },
      }),
    ).resolves.toMatchObject({ platformAdministrator: true });
    await expect(
      runtime.database.request("getOperatorAccessContext", {
        actor: { issuer: "urn:different", subject: "production-admin" },
      }),
    ).resolves.toMatchObject({ platformAdministrator: false });

    await runtime.close();
    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });
});

const evidenceStorageOptions = () =>
  ({
    evidenceDirectory: resolve("storage-runtime-fixture", "evidence"),
    globalQuotaBytes: 1_073_741_824,
    globalAssetLimit: 1_024,
    retentionMs: 86_400_000,
    incompleteUploadTtlMs: 60_000,
  }) satisfies EvidenceStorageOptions;

const storageDoubles = () => {
  const ownerLock = {
    databasePath: resolve("storage-runtime-fixture", "canonical.sqlite"),
    assertReady: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const database = {
    close: vi.fn(async () => undefined),
    ownerExit: Promise.resolve(0),
  };
  const acquire = vi
    .spyOn(SourceDatabaseOwnerLock, "acquire")
    .mockResolvedValue(ownerLock as unknown as SourceDatabaseOwnerLock);
  const createDatabase = vi
    .spyOn(SourceDatabaseClient, "create")
    .mockResolvedValue(database as unknown as SourceDatabaseClient);
  return { ownerLock, database, acquire, createDatabase };
};

describe.each([
  { mode: "production", createRuntime: createServerRuntimeFromSource },
  { mode: "recovery maintenance", createRuntime: createRecoveryRuntimeFromSource },
])("ServerStorageRuntime $mode configuration snapshot", ({ createRuntime, mode }) => {
  const mockedRuntimes: SourceServerStorageRuntime[] = [];

  afterEach(async () => {
    try {
      for (const runtime of mockedRuntimes.splice(0).reverse()) {
        await runtime.close();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("captures a separate frozen administrator list and every principal before awaiting ownership", async () => {
    const doubles = storageDoubles();
    const ownership = Promise.withResolvers<SourceDatabaseOwnerLock>();
    doubles.acquire.mockReturnValue(ownership.promise);
    const first = { issuer: "https://Issuer.example.com/tenant/", subject: "Admin" };
    const second = { issuer: "https://Issuer.example.com/tenant/", subject: "admin" };
    const originalAccess = { administrators: [first, second] };
    const expectedAccess = structuredClone(originalAccess);
    const options = {
      databasePath: resolve("storage-runtime-fixture", "requested.sqlite"),
      migrationsDirectory: resolve("storage-runtime-fixture", "migrations"),
      operatorAccess: originalAccess,
    };
    const starting = createRuntime(options);
    expect(doubles.createDatabase).not.toHaveBeenCalled();
    first.issuer = "urn:mutated";
    second.subject = "changed";
    originalAccess.administrators.push({ issuer: "urn:new", subject: "new" });
    options.operatorAccess = {
      administrators: [{ issuer: "urn:replacement", subject: "replacement" }],
    };
    ownership.resolve(doubles.ownerLock as unknown as SourceDatabaseOwnerLock);
    mockedRuntimes.push(await starting);
    expect(doubles.createDatabase.mock.calls[0]?.[0].recoveryMaintenance).toBe(
      mode === "recovery maintenance" ? true : undefined,
    );
    const passed = doubles.createDatabase.mock.calls[0]?.[0].operatorAccess;
    expect(passed).toStrictEqual(expectedAccess);
    expect(passed).not.toBe(originalAccess);
    expect(passed?.administrators).not.toBe(originalAccess.administrators);
    expect(passed?.administrators[0]).not.toBe(first);
    expect(Object.isFrozen(passed)).toBe(true);
    expect(Object.isFrozen(passed?.administrators)).toBe(true);
    expect(passed?.administrators.every((principal) => Object.isFrozen(principal))).toBe(true);
    expect(Object.isFrozen(originalAccess)).toBe(false);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Reflect.set(passed?.administrators[0] as object, "subject", "mutated-again")).toBe(
      false,
    );
  });

  it.each(["omitted", "undefined"] as const)(
    "keeps trusted administration absent when %s at construction",
    async (configuration) => {
      const doubles = storageDoubles();
      const ownership = Promise.withResolvers<SourceDatabaseOwnerLock>();
      doubles.acquire.mockReturnValue(ownership.promise);
      const options = {
        databasePath: resolve("storage-runtime-fixture", "requested.sqlite"),
        migrationsDirectory: resolve("storage-runtime-fixture", "migrations"),
        ...(configuration === "undefined" ? { operatorAccess: undefined } : {}),
      } as CreateServerStorageRuntimeOptions;
      const starting = createRuntime(options);
      Reflect.set(options, "operatorAccess", {
        administrators: [{ issuer: "urn:late", subject: "late" }],
      });
      ownership.resolve(doubles.ownerLock as unknown as SourceDatabaseOwnerLock);
      mockedRuntimes.push(await starting);
      expect(doubles.createDatabase).toHaveBeenCalledOnce();
      expect(doubles.createDatabase.mock.calls[0]?.[0]).not.toHaveProperty("operatorAccess");
    },
  );

  it("forwards a separate frozen evidence storage snapshot to the database owner", async () => {
    const doubles = storageDoubles();
    const evidenceStorage = evidenceStorageOptions();
    const options = {
      databasePath: resolve("storage-runtime-fixture", "requested.sqlite"),
      migrationsDirectory: resolve("storage-runtime-fixture", "migrations"),
      evidenceStorage,
    };

    const runtime = await createRuntime(options);
    mockedRuntimes.push(runtime);

    expect(doubles.acquire).toHaveBeenCalledExactlyOnceWith(options.databasePath);
    expect(doubles.createDatabase).toHaveBeenCalledExactlyOnceWith({
      databasePath: doubles.ownerLock.databasePath,
      migrationsDirectory: options.migrationsDirectory,
      ...(mode === "recovery maintenance" ? { recoveryMaintenance: true } : {}),
      evidenceStorage,
    });
    const passed = doubles.createDatabase.mock.calls[0]?.[0];
    expect(passed?.evidenceStorage).not.toBe(evidenceStorage);
    expect(Object.isFrozen(passed?.evidenceStorage)).toBe(true);
    expect(Object.isFrozen(options)).toBe(false);
    expect(Object.isFrozen(evidenceStorage)).toBe(false);
    expect(runtime.database).toBe(doubles.database);
    expect(doubles.ownerLock.assertReady).toHaveBeenCalledOnce();
  });

  it("captures outer options and all evidence scalars before awaiting ownership", async () => {
    const doubles = storageDoubles();
    const ownership = Promise.withResolvers<SourceDatabaseOwnerLock>();
    doubles.acquire.mockReturnValue(ownership.promise);
    const originalEvidence = evidenceStorageOptions();
    const expectedEvidence = { ...originalEvidence };
    const options = {
      databasePath: resolve("storage-runtime-fixture", "requested.sqlite"),
      migrationsDirectory: resolve("storage-runtime-fixture", "migrations"),
      evidenceStorage: originalEvidence,
    };
    const expectedDatabasePath = options.databasePath;
    const expectedMigrationsDirectory = options.migrationsDirectory;

    const starting = createRuntime(options);
    expect(doubles.acquire).toHaveBeenCalledExactlyOnceWith(expectedDatabasePath);
    expect(doubles.createDatabase).not.toHaveBeenCalled();

    options.databasePath = resolve("changed-runtime-fixture", "database.sqlite");
    options.migrationsDirectory = resolve("changed-runtime-fixture", "migrations");
    originalEvidence.evidenceDirectory = resolve("changed-runtime-fixture", "evidence");
    originalEvidence.globalQuotaBytes = 1;
    originalEvidence.globalAssetLimit = 2;
    originalEvidence.retentionMs = 3;
    originalEvidence.incompleteUploadTtlMs = 4;
    options.evidenceStorage = {
      evidenceDirectory: resolve("replacement-runtime-fixture", "evidence"),
      globalQuotaBytes: 5,
      globalAssetLimit: 6,
      retentionMs: 7,
      incompleteUploadTtlMs: 8,
    };
    ownership.resolve(doubles.ownerLock as unknown as SourceDatabaseOwnerLock);
    const runtime = await starting;
    mockedRuntimes.push(runtime);

    expect(doubles.createDatabase).toHaveBeenCalledExactlyOnceWith({
      databasePath: doubles.ownerLock.databasePath,
      migrationsDirectory: expectedMigrationsDirectory,
      ...(mode === "recovery maintenance" ? { recoveryMaintenance: true } : {}),
      evidenceStorage: expectedEvidence,
    });
    const passed = doubles.createDatabase.mock.calls[0]?.[0];
    expect(passed?.evidenceStorage).not.toBe(originalEvidence);
    expect(passed?.evidenceStorage).not.toBe(options.evidenceStorage);
    expect(Object.isFrozen(passed?.evidenceStorage)).toBe(true);
  });

  it.each(["omitted", "undefined"] as const)(
    "preserves database-only startup when evidence storage is %s",
    async (configuration) => {
      const doubles = storageDoubles();
      const ownership = Promise.withResolvers<SourceDatabaseOwnerLock>();
      doubles.acquire.mockReturnValue(ownership.promise);
      const options = {
        databasePath: resolve("storage-runtime-fixture", "requested.sqlite"),
        migrationsDirectory: resolve("storage-runtime-fixture", "migrations"),
        ...(configuration === "undefined" ? { evidenceStorage: undefined } : {}),
      } as CreateServerStorageRuntimeOptions;

      const starting = createRuntime(options);
      Reflect.set(options, "evidenceStorage", evidenceStorageOptions());
      ownership.resolve(doubles.ownerLock as unknown as SourceDatabaseOwnerLock);
      const runtime = await starting;
      mockedRuntimes.push(runtime);

      expect(doubles.acquire).toHaveBeenCalledExactlyOnceWith(options.databasePath);
      expect(doubles.createDatabase).toHaveBeenCalledOnce();
      expect(doubles.createDatabase.mock.calls[0]?.[0]).toMatchObject({
        databasePath: doubles.ownerLock.databasePath,
        migrationsDirectory: options.migrationsDirectory,
      });
      expect(doubles.createDatabase.mock.calls[0]?.[0].evidenceStorage).toBeUndefined();
    },
  );
});
