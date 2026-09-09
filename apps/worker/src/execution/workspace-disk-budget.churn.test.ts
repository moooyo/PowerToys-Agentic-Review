import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BoundedDirectoryEntries,
  NodeWorkspaceDiskFileSystem,
  ProductionWorkspaceDiskBudget,
  type WorkspaceDiskClock,
  type WorkspaceDiskInterval,
  type WorkspaceDiskIoContext,
  type WorkspaceDiskMonitor,
  type WorkspaceDiskReservation,
} from "./workspace-disk-budget.js";

const fixturePrefix = "agentic-review-disk-churn-";
const kibibyte = 1024;
const fixtures: Fixture[] = [];

class ManualWorkspaceDiskClock implements WorkspaceDiskClock {
  readonly #callbacks = new Set<() => void | Promise<void>>();

  public nowEpochMilliseconds(): bigint {
    return 10_000n;
  }

  public scheduleInterval(
    callback: () => void | Promise<void>,
    _intervalMilliseconds: number,
  ): WorkspaceDiskInterval {
    this.#callbacks.add(callback);
    return { cancel: () => this.#callbacks.delete(callback) };
  }

  public scheduleTimeout(_callback: () => void, _delayMilliseconds: number): WorkspaceDiskInterval {
    return { cancel: () => {} };
  }

  public async tick(): Promise<void> {
    await Promise.all([...this.#callbacks].map(async (callback) => callback()));
  }
}

class HookedWorkspaceDiskFileSystem extends NodeWorkspaceDiskFileSystem {
  public beforeRealpath: ((path: string) => Promise<void>) | undefined;
  public beforeReadDirectory: ((path: string) => Promise<void>) | undefined;
  public afterReadDirectory: ((path: string) => Promise<void>) | undefined;

  public override async realpath(path: string, context?: WorkspaceDiskIoContext): Promise<string> {
    await this.beforeRealpath?.(path);
    return super.realpath(path, context);
  }

  public override async readDirectoryBounded(
    path: string,
    maximumEntries: number,
    context?: WorkspaceDiskIoContext,
  ): Promise<BoundedDirectoryEntries> {
    await this.beforeReadDirectory?.(path);
    const listing = await super.readDirectoryBounded(path, maximumEntries, context);
    await this.afterReadDirectory?.(path);
    return listing;
  }
}

interface Fixture {
  readonly root: string;
  readonly parent: string;
  readonly workspaceRoot: string;
  readonly attemptDirectory: string;
  readonly packagesDirectory: string;
  readonly fileSystem: HookedWorkspaceDiskFileSystem;
  readonly clock: ManualWorkspaceDiskClock;
  readonly reservation: WorkspaceDiskReservation;
  monitor?: WorkspaceDiskMonitor;
}

async function createFixture(): Promise<Fixture> {
  const parent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(parent, fixturePrefix)));
  const workspaceRoot = join(root, "workspaces");
  const attemptDirectory = join(workspaceRoot, `attempt-${"a".repeat(64)}`);
  const packagesDirectory = join(attemptDirectory, "node_modules", ".pnpm");
  const fileSystem = new HookedWorkspaceDiskFileSystem();
  const clock = new ManualWorkspaceDiskClock();
  await mkdir(workspaceRoot);
  const budget = new ProductionWorkspaceDiskBudget({
    workspaceRootDirectory: workspaceRoot,
    perAttemptDiskBytes: BigInt(64 * kibibyte),
    totalWorkspaceDiskBytes: BigInt(256 * kibibyte),
    minimumFreeDiskBytes: 0n,
    orphanRetentionMilliseconds: 1_000n,
    orphanScanLimit: 100,
    monitorIntervalMilliseconds: 100,
    maximumAccountingEntries: 1_000,
    maximumSnapshotGenerations: 1,
    fileSystem,
    clock,
  });
  const reservation = await budget.admit(attemptDirectory);
  const fixture: Fixture = {
    root,
    parent,
    workspaceRoot,
    attemptDirectory,
    packagesDirectory,
    fileSystem,
    clock,
    reservation,
  };
  fixtures.push(fixture);
  await mkdir(packagesDirectory, { recursive: true });
  return fixture;
}

function assertOwnedPath(root: string, target: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const pathFromRoot = relative(absoluteRoot, absoluteTarget);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${win32.sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Refusing to mutate a path outside the test fixture.");
  }
  return absoluteTarget;
}

async function removeOwnedPath(fixture: Fixture, target: string): Promise<void> {
  await rm(assertOwnedPath(fixture.root, target), { recursive: true, force: true });
}

async function startMonitoring(fixture: Fixture): Promise<WorkspaceDiskMonitor> {
  const monitor = await fixture.reservation.startMonitoring(new AbortController().signal);
  fixture.monitor = monitor;
  return monitor;
}

async function installDirectoryChurn(
  fixture: Fixture,
  residentFile: string,
): Promise<() => number> {
  let mutations = 0;
  await writeFile(join(fixture.packagesDirectory, "inflight-0.tmp"), "pending package");
  await utimes(fixture.packagesDirectory, 1_000, 1_000);
  fixture.fileSystem.afterReadDirectory = async (path) => {
    if (!samePath(path, fixture.packagesDirectory)) return;
    await removeOwnedPath(fixture, join(path, `inflight-${mutations}.tmp`));
    mutations += 1;
    await writeFile(join(path, `inflight-${mutations}.tmp`), "next package");
    const stagingDirectory = join(path, `staging-${mutations}`);
    await mkdir(stagingDirectory);
    await writeFile(join(stagingDirectory, "package.json"), "{}");
    await removeOwnedPath(fixture, stagingDirectory);
    await appendFile(residentFile, Buffer.alloc(128));
    await utimes(path, 1_000 + mutations, 1_000 + mutations);
  };
  return () => mutations;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.fileSystem.beforeRealpath = undefined;
    fixture.fileSystem.beforeReadDirectory = undefined;
    fixture.fileSystem.afterReadDirectory = undefined;
    await fixture.monitor?.close().catch(() => {});
    await fixture.reservation.release();
    if (
      !samePath(dirname(fixture.root), fixture.parent) ||
      !basename(fixture.root).startsWith(fixturePrefix)
    ) {
      throw new Error("Refusing to remove an unrecognized temporary fixture.");
    }
    await removeOwnedPath(fixture, fixture.root);
  }
});

describe.skipIf(process.platform !== "win32")(
  "workspace disk accounting during real filesystem churn",
  () => {
    it("monitors installation creates, deletes, timestamp changes, and file growth through close", async () => {
      const fixture = await createFixture();
      const residentFile = join(fixture.packagesDirectory, "retained-package.bin");
      await writeFile(residentFile, Buffer.alloc(kibibyte));
      const mutationCount = await installDirectoryChurn(fixture, residentFile);

      const monitor = await startMonitoring(fixture);
      await fixture.clock.tick();
      await expect(monitor.close()).resolves.toBeUndefined();

      expect(mutationCount()).toBeGreaterThanOrEqual(3);
      expect(monitor.signal.aborted).toBe(false);
      expect(monitor.violation).toBeUndefined();
    });

    it.each(["realpath", "readDirectoryBounded"] as const)(
      "tolerates a descendant removed immediately before %s on every monitoring check",
      async (operation) => {
        const fixture = await createFixture();
        const disappearingDirectory = join(fixture.packagesDirectory, "unpacked-package");
        let removals = 0;
        const removeBeforeRead = async (path: string): Promise<void> => {
          if (!samePath(path, disappearingDirectory)) return;
          await removeOwnedPath(fixture, path);
          removals += 1;
        };
        if (operation === "realpath") {
          fixture.fileSystem.beforeRealpath = removeBeforeRead;
        } else {
          fixture.fileSystem.beforeReadDirectory = removeBeforeRead;
        }
        const createPackage = async (): Promise<void> => {
          await mkdir(disappearingDirectory);
          await writeFile(join(disappearingDirectory, "package.json"), "{}");
        };

        await createPackage();
        const monitor = await startMonitoring(fixture);
        await createPackage();
        await fixture.clock.tick();
        await createPackage();
        await expect(monitor.close()).resolves.toBeUndefined();

        expect(removals).toBe(3);
        expect(monitor.signal.aborted).toBe(false);
        expect(monitor.violation).toBeUndefined();
      },
    );

    it("aborts persistent file growth beyond quota even while package entries keep changing", async () => {
      const fixture = await createFixture();
      const residentFile = join(fixture.packagesDirectory, "retained-package.bin");
      await writeFile(residentFile, Buffer.alloc(kibibyte));
      const mutationCount = await installDirectoryChurn(fixture, residentFile);
      const monitor = await startMonitoring(fixture);

      await writeFile(residentFile, Buffer.alloc(64 * kibibyte + 1));
      await fixture.clock.tick();

      expect(mutationCount()).toBeGreaterThanOrEqual(2);
      expect(monitor.signal.aborted).toBe(true);
      expect(monitor.violation).toMatchObject({ code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED" });
      await expect(monitor.close()).rejects.toMatchObject({
        code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED",
      });
    });

    it("rejects a directory replaced after enumeration despite an active reservation", async () => {
      const fixture = await createFixture();
      await writeFile(join(fixture.packagesDirectory, "package.json"), "{}");
      const monitor = await startMonitoring(fixture);
      let replacements = 0;
      fixture.fileSystem.afterReadDirectory = async (path) => {
        if (!samePath(path, fixture.packagesDirectory) || replacements !== 0) return;
        replacements += 1;
        const original = assertOwnedPath(fixture.root, path);
        const retainedDirectory = assertOwnedPath(
          fixture.root,
          join(fixture.root, "retained-original"),
        );
        await rename(original, retainedDirectory);
        await mkdir(original);
        await writeFile(join(original, "package.json"), "{}");
      };

      await fixture.clock.tick();

      expect(replacements).toBe(1);
      expect(monitor.signal.aborted).toBe(true);
      expect(monitor.violation).toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
      await expect(monitor.close()).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
    });

    it("counts internal junctions without traversing their shared package target again", async () => {
      const fixture = await createFixture();
      const target = join(fixture.packagesDirectory, "actual-package");
      const outsideMarker = join(fixture.root, "outside-marker.txt");
      await mkdir(target);
      await writeFile(join(target, "package.bin"), Buffer.alloc(40 * kibibyte));
      await writeFile(outsideMarker, "must survive attempt cleanup");
      await symlink(target, join(fixture.packagesDirectory, "first-alias"), "junction");
      await symlink(target, join(fixture.packagesDirectory, "second-alias"), "junction");

      const monitor = await startMonitoring(fixture);
      await fixture.clock.tick();
      await expect(monitor.close()).resolves.toBeUndefined();

      expect(monitor.signal.aborted).toBe(false);
      expect(monitor.violation).toBeUndefined();
      assertOwnedPath(fixture.root, fixture.attemptDirectory);
      await fixture.reservation.removeAttempt();
      expect(await fixture.fileSystem.lstat(fixture.attemptDirectory)).toBeNull();
      expect(await readFile(outsideMarker, "utf8")).toBe("must survive attempt cleanup");
    });

    it("tolerates an internal junction unlinked after lstat during every check", async () => {
      const fixture = await createFixture();
      const target = join(fixture.packagesDirectory, "retained-package");
      const alias = join(fixture.packagesDirectory, "transient-alias");
      const targetFile = join(target, "package.json");
      const contents = '{"name":"retained-package"}';
      await mkdir(target);
      await writeFile(targetFile, contents);
      let removals = 0;
      fixture.fileSystem.beforeRealpath = async (path) => {
        if (!samePath(path, alias)) return;
        await removeOwnedPath(fixture, alias);
        removals += 1;
      };

      await symlink(target, alias, "junction");
      const monitor = await startMonitoring(fixture);
      expect(removals).toBe(1);
      await symlink(target, alias, "junction");
      await fixture.clock.tick();
      expect(removals).toBe(2);
      await symlink(target, alias, "junction");
      await expect(monitor.close()).resolves.toBeUndefined();

      expect(removals).toBe(3);
      expect(monitor.signal.aborted).toBe(false);
      expect(monitor.violation).toBeUndefined();
      expect(await fixture.fileSystem.lstat(alias)).toBeNull();
      expect(await readFile(targetFile, "utf8")).toBe(contents);
    });

    it("rejects an external junction and leaves its target intact after attempt cleanup", async () => {
      const fixture = await createFixture();
      const monitor = await startMonitoring(fixture);
      const target = join(fixture.root, "junction-target");
      await mkdir(target);
      const outsideMarker = join(target, "outside-marker.txt");
      await writeFile(outsideMarker, "must survive attempt cleanup");
      await symlink(target, join(fixture.packagesDirectory, "redirected-package"), "junction");

      await fixture.clock.tick();

      expect(monitor.signal.aborted).toBe(true);
      expect(monitor.violation).toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
      await expect(monitor.close()).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
      assertOwnedPath(fixture.root, fixture.attemptDirectory);
      await fixture.reservation.removeAttempt();
      expect(await fixture.fileSystem.lstat(fixture.attemptDirectory)).toBeNull();
      expect(await readFile(outsideMarker, "utf8")).toBe("must survive attempt cleanup");
    });

    it("does not treat an unresolved external junction as an ordinary disappearing entry", async () => {
      const fixture = await createFixture();
      const monitor = await startMonitoring(fixture);
      const absentTarget = join(fixture.root, "missing-external-target");
      await symlink(absentTarget, join(fixture.packagesDirectory, "dangling-package"), "junction");

      await fixture.clock.tick();

      expect(monitor.signal.aborted).toBe(true);
      expect(monitor.violation).toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
      await expect(monitor.close()).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
      assertOwnedPath(fixture.root, fixture.attemptDirectory);
      await fixture.reservation.removeAttempt();
      expect(await fixture.fileSystem.lstat(fixture.attemptDirectory)).toBeNull();
      expect(await fixture.fileSystem.lstat(absentTarget)).toBeNull();
    });
  },
);

function samePath(first: string, second: string): boolean {
  return win32.normalize(first).toLowerCase() === win32.normalize(second).toLowerCase();
}
