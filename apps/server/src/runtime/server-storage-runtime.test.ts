import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseOwnerLock } from "../../dist/database/owner-lock.js";
import {
  createRecoveryMaintenanceStorageRuntime,
  createServerStorageRuntime,
  type ServerStorageRuntime,
} from "../../dist/runtime/server-storage-runtime.js";

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
    });
    runtimes.push(runtime);

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.ownKeys(runtime)).toEqual(["database", "close"]);
    await expect(runtime.database.request("ping", {})).resolves.toMatchObject({
      schemaVersion: 8,
    });

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
    });
    runtimes.push(runtime);

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.ownKeys(runtime)).toEqual(["database", "close"]);
    await expect(runtime.database.request("ping", {})).resolves.toMatchObject({
      schemaVersion: 8,
    });

    await runtime.close();
    const nextOwner = await DatabaseOwnerLock.acquire(databasePath);
    await nextOwner.close();
  });
});
