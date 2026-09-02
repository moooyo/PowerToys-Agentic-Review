import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOwnerLockDatabase,
  closeOwnerLockDatabaseWithRetries,
  DatabaseOwnerLock,
} from "../../dist/database/owner-lock.js";
import {
  createDurableFreshDatabaseEntries,
  DatabaseStorageBinding,
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
  secureDatabaseBasename,
  synchronizeCreatedDirectoryChain,
} from "../../dist/database/storage-security.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DatabaseOwnerLock", () => {
  it("orders durable directory and fresh database entry synchronization", () => {
    const directoryEvents: string[] = [];
    synchronizeCreatedDirectoryChain(["/data/one", "/data/one/two"], (path) => {
      directoryEvents.push(path);
    });
    expect(directoryEvents).toEqual(["/data/one/two", "/data/one", "/data/one", "/data"]);

    const creationEvents: string[] = [];
    expect(
      createDurableFreshDatabaseEntries({
        createInitializingMarker: () => {
          creationEvents.push("create-initializing");
          return "marker";
        },
        syncDataDirectory: () => creationEvents.push("sync-data-directory"),
        createDatabase: () => {
          creationEvents.push("create-database");
          return "database";
        },
      }),
    ).toEqual({ marker: "marker", database: "database" });
    expect(creationEvents).toEqual([
      "create-initializing",
      "sync-data-directory",
      "create-database",
      "sync-data-directory",
    ]);
  });

  it("stops durable creation immediately when a synchronization barrier fails", () => {
    const syncError = new Error("directory fsync failed");
    const directoryEvents: string[] = [];
    expect(() =>
      synchronizeCreatedDirectoryChain(["/data/one", "/data/one/two"], (path) => {
        directoryEvents.push(path);
        if (path === "/data/one") {
          throw syncError;
        }
      }),
    ).toThrow(syncError);
    expect(directoryEvents).toEqual(["/data/one/two", "/data/one"]);

    const creationEvents: string[] = [];
    expect(() =>
      createDurableFreshDatabaseEntries({
        createInitializingMarker: () => {
          creationEvents.push("create-initializing");
          return "marker";
        },
        syncDataDirectory: () => {
          creationEvents.push("sync-data-directory");
          throw syncError;
        },
        createDatabase: () => {
          creationEvents.push("create-database");
          return "database";
        },
      }),
    ).toThrow(syncError);
    expect(creationEvents).toEqual(["create-initializing", "sync-data-directory"]);

    const databaseEntryEvents: string[] = [];
    let syncCount = 0;
    expect(() =>
      createDurableFreshDatabaseEntries({
        createInitializingMarker: () => {
          databaseEntryEvents.push("create-initializing");
          return "marker";
        },
        syncDataDirectory: () => {
          syncCount += 1;
          databaseEntryEvents.push(`sync-data-directory-${syncCount}`);
          if (syncCount === 2) {
            throw syncError;
          }
        },
        createDatabase: () => {
          databaseEntryEvents.push("create-database");
          return "database";
        },
      }),
    ).toThrow(syncError);
    expect(databaseEntryEvents).toEqual([
      "create-initializing",
      "sync-data-directory-1",
      "create-database",
      "sync-data-directory-2",
    ]);
  });

  it("rejects unsafe and reserved database basenames without normalization", () => {
    expect(secureDatabaseBasename("state.sqlite")).toBe("state.sqlite");
    for (const path of [
      "unsafe name.sqlite",
      "state?.sqlite",
      ".",
      "..",
      "backups",
      ".agentic-review-allow-legacy-adoption",
      ".agentic-review-database-initializing",
      ".agentic-review-database-initialized",
    ]) {
      expect(() => secureDatabaseBasename(path)).toThrow(/must match.*must not be reserved/u);
    }
  });

  it("always attempts close and reports rollback and close failures", () => {
    const rollbackError = new Error("rollback failed");
    const closeError = new Error("close failed");
    const calls: string[] = [];
    const attempt = closeOwnerLockDatabase({
      isTransaction: true,
      exec: () => {
        calls.push("rollback");
        throw rollbackError;
      },
      close: () => {
        calls.push("close");
        throw closeError;
      },
    });

    expect(calls).toEqual(["rollback", "close"]);
    expect(attempt).toEqual({ closeSucceeded: false, errors: [rollbackError, closeError] });
  });

  it("allows a failed close attempt to retry the same handle", () => {
    let closeAttempts = 0;
    const database = {
      isTransaction: false,
      exec: () => undefined,
      close: () => {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          throw new Error("transient close failure");
        }
      },
    };

    expect(closeOwnerLockDatabase(database).closeSucceeded).toBe(false);
    expect(closeOwnerLockDatabase(database)).toEqual({ closeSucceeded: true, errors: [] });
  });

  it("bounds acquisition cleanup retries without losing close errors", () => {
    let closeAttempts = 0;
    const transientError = new Error("transient close failure");
    const recovered = closeOwnerLockDatabaseWithRetries({
      isTransaction: false,
      exec: () => undefined,
      close: () => {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          throw transientError;
        }
      },
    });
    expect(recovered).toEqual({ closeSucceeded: true, errors: [transientError] });
    expect(closeAttempts).toBe(2);

    closeAttempts = 0;
    const failed = closeOwnerLockDatabaseWithRetries({
      isTransaction: false,
      exec: () => undefined,
      close: () => {
        closeAttempts += 1;
        throw new Error(`close failure ${closeAttempts}`);
      },
    });
    expect(failed.closeSucceeded).toBe(false);
    expect(failed.errors).toHaveLength(3);
    expect(closeAttempts).toBe(3);
  });

  it.skipIf(process.platform === "win32")(
    "revokes an unconsumed artifact transaction handle before normal close",
    async () => {
      const directory = await createTemporaryDirectory();
      const lock = await DatabaseOwnerLock.acquire(join(directory, "state.sqlite"));
      await writeFile(lock.databasePath, "initialized", { mode: 0o600 });
      await writeInitializationMarker(lock.databasePath);
      const handle = lock.createArtifactTransactionOwnerLockHandle();

      expect(Reflect.ownKeys(handle)).toEqual([]);
      expect(() => lock.createArtifactTransactionOwnerLockHandle()).toThrow(/already issued/u);
      await expect(lock.close()).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a normal owner close retriable until its bounded close retries succeed",
    async () => {
      const directory = await createTemporaryDirectory();
      const lock = await DatabaseOwnerLock.acquire(join(directory, "state.sqlite"));
      const originalClose = DatabaseSync.prototype.close;
      let closeAttempts = 0;
      const closeErrors = [1, 2, 3].map((attempt) => new Error(`close failure ${attempt}`));
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementation(function closeWithInjectedFailures() {
          closeAttempts += 1;
          const error = closeErrors[closeAttempts - 1];
          if (error !== undefined) {
            throw error;
          }
          return originalClose.call(this);
        });

      try {
        let thrown: unknown;
        try {
          await lock.close();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(AggregateError);
        expect((thrown as AggregateError).errors).toEqual(closeErrors);
        expect(closeAttempts).toBe(3);

        await expect(lock.close()).resolves.toBeUndefined();
        expect(closeAttempts).toBe(4);
        await expect(lock.close()).resolves.toBeUndefined();
        expect(closeAttempts).toBe(4);
      } finally {
        closeSpy.mockRestore();
        await lock.close().catch(() => undefined);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects database files that appear, disappear, or change after prepare",
    async () => {
      const directory = await createTemporaryDirectory();
      const appearedPath = join(directory, "appeared.sqlite");
      const missingBinding = DatabaseStorageBinding.prepare(appearedPath);
      await writeFile(appearedPath, "appeared", { mode: 0o600 });
      expect(() => missingBinding.createDatabaseFile()).toThrow(
        /appeared after storage preparation/u,
      );
      await rm(appearedPath);

      const disappearedPath = join(directory, "disappeared.sqlite");
      await writeFile(disappearedPath, "original", { mode: 0o600 });
      await writeInitializationMarker(disappearedPath);
      const existingBinding = DatabaseStorageBinding.prepare(disappearedPath);
      await rm(disappearedPath);
      expect(() => existingBinding.createDatabaseFile()).toThrow(/disappeared/u);
      await expect(lstat(disappearedPath)).rejects.toMatchObject({ code: "ENOENT" });

      const replacedDirectory = join(directory, "replaced-case");
      const replacedPath = join(replacedDirectory, "replaced.sqlite");
      await mkdir(replacedDirectory, { mode: 0o700 });
      await writeFile(replacedPath, "original", { mode: 0o600 });
      await writeInitializationMarker(replacedPath);
      const replacedBinding = DatabaseStorageBinding.prepare(replacedPath);
      await rename(replacedPath, join(directory, "replaced-old.sqlite"));
      await writeFile(replacedPath, "replacement", { mode: 0o600 });
      expect(() => replacedBinding.createDatabaseFile()).toThrow(/changed identity/u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "allows only one owner for a normalized database path",
    async () => {
      const directory = await createTemporaryDirectory();
      const databasePath = join(directory, "state.sqlite");
      const first = await DatabaseOwnerLock.acquire(databasePath);
      try {
        const lockStats = await lstat(`${first.databasePath}.owner-lock.sqlite`);
        expect(lockStats.mode & 0o7777).toBe(0o600);
        await writeFile(first.databasePath, "initialized");
        await chmod(first.databasePath, 0o600);
        await writeInitializationMarker(first.databasePath);
        expect(() => first.assertReady()).not.toThrow();
        await expect(
          DatabaseOwnerLock.acquire(join(directory, ".", "state.sqlite")),
        ).rejects.toThrow(/already owns database/u);
      } finally {
        await first.close();
      }

      const replacement = await DatabaseOwnerLock.acquire(databasePath);
      await replacement.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects database paths through a symlinked parent",
    async () => {
      const directory = await createTemporaryDirectory();
      const dataDirectory = join(directory, "data");
      const aliasDirectory = join(directory, "alias");
      await mkdir(dataDirectory, { mode: 0o700 });
      await symlink(dataDirectory, aliasDirectory, "dir");
      await expect(DatabaseOwnerLock.acquire(join(aliasDirectory, "state.sqlite"))).rejects.toThrow(
        /lexical path component.*symbolic link/u,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects non-regular and hard-linked database paths",
    async () => {
      const directory = await createTemporaryDirectory();
      const nonRegularDirectory = join(directory, "non-regular-case");
      const nonRegularPath = join(nonRegularDirectory, "state.sqlite");
      await mkdir(nonRegularDirectory, { mode: 0o700 });
      await mkdir(nonRegularPath, { mode: 0o700 });
      await expect(DatabaseOwnerLock.acquire(nonRegularPath)).rejects.toThrow(/regular file/u);

      const hardLinkDirectory = join(directory, "hard-link-case");
      const hardLinkTarget = join(directory, "state-alias.sqlite");
      const databasePath = join(hardLinkDirectory, "state.sqlite");
      await mkdir(hardLinkDirectory, { mode: 0o700 });
      await writeFile(databasePath, "");
      await chmod(databasePath, 0o600);
      await link(databasePath, hardLinkTarget);

      await expect(DatabaseOwnerLock.acquire(databasePath)).rejects.toThrow(
        /must not have hard links/u,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects existing and dangling final database symlinks",
    async () => {
      const directory = await createTemporaryDirectory();
      const dataDirectory = join(directory, "data");
      const targetPath = join(directory, "target.sqlite");
      const existingAlias = join(dataDirectory, "existing-alias.sqlite");
      const danglingAlias = join(dataDirectory, "dangling-alias.sqlite");
      await mkdir(dataDirectory, { mode: 0o700 });
      await writeFile(targetPath, "");
      await chmod(targetPath, 0o600);
      await symlink(targetPath, existingAlias, "file");

      await expect(DatabaseOwnerLock.acquire(existingAlias)).rejects.toThrow(/symbolic link/u);
      await rm(existingAlias);
      await symlink(join(directory, "missing.sqlite"), danglingAlias, "file");
      await expect(DatabaseOwnerLock.acquire(danglingAlias)).rejects.toThrow(/symbolic link/u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects permissive database directories and files",
    async () => {
      const directory = await createTemporaryDirectory();
      const permissiveDirectory = join(directory, "permissive");
      await mkdir(permissiveDirectory, { mode: 0o700 });
      await chmod(permissiveDirectory, 0o755);
      await expect(
        DatabaseOwnerLock.acquire(join(permissiveDirectory, "state.sqlite")),
      ).rejects.toThrow(/mode 0700/u);

      const fileModeDirectory = join(directory, "file-mode");
      const fileModeDatabasePath = join(fileModeDirectory, "state.sqlite");
      await mkdir(fileModeDirectory, { mode: 0o700 });
      await writeFile(fileModeDatabasePath, "");
      await chmod(fileModeDatabasePath, 0o644);
      await expect(DatabaseOwnerLock.acquire(fileModeDatabasePath)).rejects.toThrow(/mode 0600/u);

      const writableAncestor = join(directory, "writable-ancestor");
      const protectedChild = join(writableAncestor, "protected-child");
      await mkdir(protectedChild, { recursive: true, mode: 0o700 });
      await chmod(writableAncestor, 0o777);
      await expect(DatabaseOwnerLock.acquire(join(protectedChild, "state.sqlite"))).rejects.toThrow(
        /ancestor.*writable by group or other/u,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "allows the root-owned sticky temporary directory ancestor",
    async () => {
      const temporaryStats = await lstat(tmpdir());
      if (temporaryStats.uid !== 0 || (temporaryStats.mode & 0o1002) !== 0o1002) {
        return;
      }
      const directory = await createTemporaryDirectory();
      const lock = await DatabaseOwnerLock.acquire(join(directory, "state.sqlite"));
      await lock.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "validates existing ancestors before creating a missing directory chain",
    async () => {
      const directory = await createTemporaryDirectory();
      const safeDatabasePath = join(directory, "safe", "nested", "state.sqlite");
      const lock = await DatabaseOwnerLock.acquire(safeDatabasePath);
      try {
        for (const path of [join(directory, "safe"), join(directory, "safe", "nested")]) {
          expect((await lstat(path)).mode & 0o7777).toBe(0o700);
        }
      } finally {
        await lock.close();
      }

      const writableAncestor = join(directory, "unsafe");
      const missingDirectory = join(writableAncestor, "missing", "nested");
      await mkdir(writableAncestor, { mode: 0o700 });
      await chmod(writableAncestor, 0o777);
      await expect(
        DatabaseOwnerLock.acquire(join(missingDirectory, "state.sqlite")),
      ).rejects.toThrow(/ancestor.*writable by group or other/u);
      await expect(lstat(missingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a permissive pre-existing owner lock file",
    async () => {
      const directory = await createTemporaryDirectory();
      const dataDirectory = join(directory, "data");
      const databasePath = join(dataDirectory, "state.sqlite");
      const lockPath = `${databasePath}.owner-lock.sqlite`;
      await mkdir(dataDirectory, { mode: 0o700 });
      await writeFile(lockPath, "");
      await chmod(lockPath, 0o644);

      await expect(DatabaseOwnerLock.acquire(databasePath)).rejects.toThrow(/mode 0600/u);

      await chmod(lockPath, 0o600);
      const sidecarTarget = join(directory, "lock-sidecar-target");
      await writeFile(sidecarTarget, "");
      await chmod(sidecarTarget, 0o600);
      await symlink(sidecarTarget, `${lockPath}-journal`, "file");
      await expect(DatabaseOwnerLock.acquire(databasePath)).rejects.toThrow(
        /owner-lock.*symbolic link/u,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "detects directory and database replacement after acquisition",
    async () => {
      const directory = await createTemporaryDirectory();
      const dataDirectory = join(directory, "data");
      const displacedDirectory = join(directory, "data-displaced");
      const databasePath = join(dataDirectory, "state.sqlite");
      await mkdir(dataDirectory, { mode: 0o700 });
      await writeFile(databasePath, "first");
      await chmod(databasePath, 0o600);
      await writeInitializationMarker(databasePath);
      const first = await DatabaseOwnerLock.acquire(databasePath);
      try {
        first.assertReady();
        await rename(dataDirectory, displacedDirectory);
        await mkdir(dataDirectory, { mode: 0o700 });
        await writeFile(databasePath, "second");
        await chmod(databasePath, 0o600);
        await writeInitializationMarker(databasePath);
        expect(() => first.assertReady()).toThrow(/directory.*changed identity/u);
      } finally {
        await first.close().catch(() => undefined);
      }

      const stableDirectory = join(directory, "stable");
      const stableDatabasePath = join(stableDirectory, "state.sqlite");
      await mkdir(stableDirectory, { mode: 0o700 });
      await writeFile(stableDatabasePath, "first");
      await chmod(stableDatabasePath, 0o600);
      await writeInitializationMarker(stableDatabasePath);
      const second = await DatabaseOwnerLock.acquire(stableDatabasePath);
      try {
        second.assertReady();
        await rename(stableDatabasePath, join(directory, "stable-old.sqlite"));
        await writeFile(stableDatabasePath, "second");
        await chmod(stableDatabasePath, 0o600);
        expect(() => second.assertReady()).toThrow(/Database.*changed identity/u);
      } finally {
        await second.close().catch(() => undefined);
      }

      const ancestorRoot = join(directory, "ancestor-root");
      const displacedAncestor = join(directory, "ancestor-displaced");
      const nestedDirectory = join(ancestorRoot, "database");
      const nestedDatabasePath = join(nestedDirectory, "state.sqlite");
      await mkdir(nestedDirectory, { recursive: true, mode: 0o700 });
      await chmod(ancestorRoot, 0o700);
      await writeFile(nestedDatabasePath, "first");
      await chmod(nestedDatabasePath, 0o600);
      await writeInitializationMarker(nestedDatabasePath);
      const third = await DatabaseOwnerLock.acquire(nestedDatabasePath);
      try {
        third.assertReady();
        await rename(ancestorRoot, displacedAncestor);
        await mkdir(nestedDirectory, { recursive: true, mode: 0o700 });
        await chmod(ancestorRoot, 0o700);
        await writeFile(nestedDatabasePath, "second");
        await chmod(nestedDatabasePath, 0o600);
        await writeInitializationMarker(nestedDatabasePath);
        expect(() => third.assertReady()).toThrow(/ancestor.*changed identity/u);
      } finally {
        await third.close().catch(() => undefined);
      }
    },
  );

  if (process.platform === "win32") {
    it("fails closed when POSIX ownership and mode checks are unavailable", async () => {
      const directory = await createTemporaryDirectory();
      await expect(DatabaseOwnerLock.acquire(join(directory, "state.sqlite"))).rejects.toThrow(
        /supported POSIX platform/u,
      );
    });
  }
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-owner-lock-"));
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
  temporaryDirectories.push(directory);
  return directory;
};

const writeInitializationMarker = async (databasePath: string): Promise<void> => {
  await writeFile(
    databaseInitializationMarkerPath(databasePath),
    databaseInitializationMarkerContent,
    { mode: 0o600 },
  );
};
