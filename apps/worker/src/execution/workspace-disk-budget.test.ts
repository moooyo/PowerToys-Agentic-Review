import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BoundedDirectoryEntries,
  isStrictAttemptDirectoryName,
  type NativeWorkspaceSecurityAdapter,
  ProductionWorkspaceDiskBudget,
  WorkspaceDiskBudgetError,
  type WorkspaceDiskClock,
  type WorkspaceDiskInterval,
  type WorkspaceDiskPathState,
} from "./workspace-disk-budget.js";

const workspaceRoot = "C:\\AgenticReview\\workspaces";
const mebibyte = 1024n * 1024n;

interface FakeDiskEntry {
  readonly path: string;
  realPath: string;
  kind: WorkspaceDiskPathState["kind"];
  reparsePoint: boolean;
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedAtMs: bigint;
  changedAtMs: bigint;
}

type CheckoutRemovalRequest = Parameters<
  NonNullable<NativeWorkspaceSecurityAdapter["quarantineAndRemoveCheckout"]>
>[0];

class FakeWorkspaceDiskFileSystem implements NativeWorkspaceSecurityAdapter {
  readonly #entries = new Map<string, FakeDiskEntry>();
  public readonly removed: string[] = [];
  public readonly checkoutRemovalRequests: CheckoutRemovalRequest[] = [];
  public freeBytes = 1_000n * mebibyte;
  public exclusiveOwnership = true;
  public reportUnknownRemovedBytes = false;
  public ownershipGate: Promise<void> | undefined;
  public ownershipChecks = 0;
  public onLstat: ((path: string) => void) | undefined;
  public onReadDirectory: ((path: string) => void) | undefined;
  readonly #transientMissing = new Map<string, number>();

  public constructor() {
    this.addDirectory(workspaceRoot, 0n);
  }

  public async lstat(path: string): Promise<WorkspaceDiskPathState | null> {
    this.onLstat?.(path);
    const missingCount = this.#transientMissing.get(key(path)) ?? 0;
    if (missingCount > 0) {
      this.#transientMissing.set(key(path), missingCount - 1);
      return null;
    }
    const entry = this.#entries.get(key(path));
    if (entry === undefined) return null;
    return {
      kind: entry.kind,
      reparsePoint: entry.reparsePoint,
      device: entry.device,
      inode: entry.inode,
      size: entry.size,
      modifiedAtMs: entry.modifiedAtMs,
      changedAtMs: entry.changedAtMs,
    };
  }

  public async realpath(path: string): Promise<string> {
    const entry = this.#entries.get(key(path));
    if (entry === undefined) throw fileSystemError("ENOENT", `Missing path: ${path}`);
    return entry.realPath;
  }

  public async readDirectoryBounded(
    path: string,
    maximumEntries: number,
  ): Promise<BoundedDirectoryEntries> {
    if (!this.#entries.has(key(path))) {
      throw fileSystemError("ENOENT", `Missing path: ${path}`);
    }
    const parent = key(path);
    const entries = [...this.#entries.values()]
      .filter((entry) => key(win32.dirname(entry.path)) === parent && key(entry.path) !== parent)
      .map((entry) => win32.basename(entry.path))
      .sort();
    this.onReadDirectory?.(path);
    return {
      entries: entries.slice(0, maximumEntries),
      truncated: entries.length > maximumEntries,
    };
  }

  public async availableBytes(_path: string): Promise<bigint> {
    return this.freeBytes;
  }

  public async assertExclusiveOwnership(): Promise<void> {
    this.ownershipChecks += 1;
    await this.ownershipGate;
    if (!this.exclusiveOwnership) {
      throw new WorkspaceDiskBudgetError(
        "EXCLUSIVE_WORKSPACE_OWNERSHIP_LOST",
        "exclusive workspace ownership lost",
      );
    }
  }

  public async quarantineAndRemoveAttempt(request: {
    readonly workspaceRootDirectory: string;
    readonly workspaceRootDevice: bigint;
    readonly workspaceRootInode: bigint;
    readonly attemptDirectory: string;
    readonly attemptDevice: bigint;
    readonly attemptInode: bigint;
  }): Promise<{ readonly removedBytes: bigint | null }> {
    if (key(request.workspaceRootDirectory) !== key(workspaceRoot)) {
      throw new Error("unexpected workspace root");
    }
    const root = this.#entry(workspaceRoot);
    const attemptEntry = this.#entry(request.attemptDirectory);
    if (
      root.device !== request.workspaceRootDevice ||
      root.inode !== request.workspaceRootInode ||
      attemptEntry.device !== request.attemptDevice ||
      attemptEntry.inode !== request.attemptInode
    ) {
      throw new Error("workspace identity changed");
    }
    const target = key(request.attemptDirectory);
    let removedBytes = 0n;
    for (const [entryKey, entry] of this.#entries) {
      const relative = win32.relative(target, entryKey);
      if (
        (relative === "" ||
          (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"))) &&
        entry.kind === "file"
      ) {
        removedBytes += entry.size;
      }
    }
    await this.removeTree(request.attemptDirectory);
    return { removedBytes: this.reportUnknownRemovedBytes ? null : removedBytes };
  }

  public async quarantineAndRemoveCheckout(
    request: CheckoutRemovalRequest,
  ): Promise<{ readonly removedBytes: bigint | null }> {
    this.checkoutRemovalRequests.push(request);
    if (
      key(request.workspaceRootDirectory) !== key(workspaceRoot) ||
      key(win32.dirname(request.attemptDirectory)) !== key(workspaceRoot) ||
      !isStrictAttemptDirectoryName(win32.basename(request.attemptDirectory)) ||
      key(request.checkoutDirectory) !== key(win32.join(request.attemptDirectory, "checkout"))
    ) {
      throw new Error("unexpected checkout removal path");
    }
    for (const [path, device, inode] of [
      [request.workspaceRootDirectory, request.workspaceRootDevice, request.workspaceRootInode],
      [request.attemptDirectory, request.attemptDevice, request.attemptInode],
      [request.checkoutDirectory, request.checkoutDevice, request.checkoutInode],
    ] as const) {
      const entry = this.#entry(path);
      if (
        entry.kind !== "directory" ||
        entry.reparsePoint ||
        key(entry.realPath) !== key(path) ||
        entry.device !== device ||
        entry.inode !== inode
      ) {
        throw new Error("workspace identity changed");
      }
    }
    await this.removeTree(request.checkoutDirectory);
    return { removedBytes: null };
  }

  public async close(): Promise<void> {}

  public async removeTree(path: string): Promise<void> {
    this.removed.push(path);
    const target = key(path);
    for (const entryKey of [...this.#entries.keys()]) {
      const relative = win32.relative(target, entryKey);
      if (
        relative === "" ||
        (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"))
      ) {
        this.#entries.delete(entryKey);
      }
    }
  }

  public addDirectory(path: string, modifiedAtMs = 0n): void {
    this.#entries.set(key(path), {
      path,
      realPath: path,
      kind: "directory",
      reparsePoint: false,
      device: 1n,
      inode: BigInt(this.#entries.size + 1),
      size: 0n,
      modifiedAtMs,
      changedAtMs: modifiedAtMs,
    });
  }

  public addFile(path: string, size: bigint, modifiedAtMs = 0n): void {
    this.#entries.set(key(path), {
      path,
      realPath: path,
      kind: "file",
      reparsePoint: false,
      device: 1n,
      inode: BigInt(this.#entries.size + 1),
      size,
      modifiedAtMs,
      changedAtMs: modifiedAtMs,
    });
  }

  public setFileSize(path: string, size: bigint): void {
    this.#entry(path).size = size;
  }

  public changeIdentity(path: string): void {
    this.#entry(path).inode += 1n;
  }

  public touch(path: string): void {
    const entry = this.#entry(path);
    entry.modifiedAtMs += 1n;
    entry.changedAtMs += 1n;
  }

  public setReparsePoint(path: string): void {
    this.#entry(path).reparsePoint = true;
  }

  public setRealPath(path: string, realPath: string): void {
    this.#entry(path).realPath = realPath;
  }

  public missNextLstats(path: string, count: number): void {
    this.#transientMissing.set(key(path), count);
  }

  public has(path: string): boolean {
    return this.#entries.has(key(path));
  }

  #entry(path: string): FakeDiskEntry {
    const entry = this.#entries.get(key(path));
    if (entry === undefined) throw new Error(`Missing fake entry: ${path}`);
    return entry;
  }
}

class FakeWorkspaceDiskClock implements WorkspaceDiskClock {
  readonly #callbacks = new Set<() => void | Promise<void>>();
  readonly #timeouts = new Set<{ readonly due: bigint; readonly callback: () => void }>();
  public now = 10_000n;

  public nowEpochMilliseconds(): bigint {
    return this.now;
  }

  public scheduleInterval(
    callback: () => void | Promise<void>,
    _intervalMilliseconds: number,
  ): WorkspaceDiskInterval {
    this.#callbacks.add(callback);
    return { cancel: () => this.#callbacks.delete(callback) };
  }

  public scheduleTimeout(callback: () => void, delayMilliseconds: number): WorkspaceDiskInterval {
    const timeout = { due: this.now + BigInt(delayMilliseconds), callback };
    this.#timeouts.add(timeout);
    return { cancel: () => this.#timeouts.delete(timeout) };
  }

  public async tick(): Promise<void> {
    await Promise.all([...this.#callbacks].map(async (callback) => callback()));
  }

  public advance(milliseconds: number): void {
    this.now += BigInt(milliseconds);
    for (const timeout of [...this.#timeouts]) {
      if (timeout.due <= this.now) {
        this.#timeouts.delete(timeout);
        timeout.callback();
      }
    }
  }
}

function attempt(fill: string): string {
  return win32.join(workspaceRoot, `attempt-${fill.repeat(64)}`);
}

function createBudget(
  fileSystem: FakeWorkspaceDiskFileSystem,
  clock = new FakeWorkspaceDiskClock(),
  overrides: Partial<{
    perAttemptDiskBytes: bigint;
    totalWorkspaceDiskBytes: bigint;
    minimumFreeDiskBytes: bigint;
    orphanRetentionMilliseconds: bigint;
    orphanScanLimit: number;
    maximumAccountingEntries: number;
    maximumScanDurationMilliseconds: number;
  }> = {},
): ProductionWorkspaceDiskBudget {
  return new ProductionWorkspaceDiskBudget({
    workspaceRootDirectory: workspaceRoot,
    perAttemptDiskBytes: overrides.perAttemptDiskBytes ?? 100n * mebibyte,
    totalWorkspaceDiskBytes: overrides.totalWorkspaceDiskBytes ?? 200n * mebibyte,
    minimumFreeDiskBytes: overrides.minimumFreeDiskBytes ?? 50n * mebibyte,
    orphanRetentionMilliseconds: overrides.orphanRetentionMilliseconds ?? 1_000n,
    orphanScanLimit: overrides.orphanScanLimit ?? 100,
    monitorIntervalMilliseconds: 100,
    maximumAccountingEntries: overrides.maximumAccountingEntries ?? 1_000,
    maximumScanDurationMilliseconds: overrides.maximumScanDurationMilliseconds ?? 30_000,
    securityAdapter: fileSystem,
    clock,
  });
}

describe("ProductionWorkspaceDiskBudget", () => {
  it("supports trusted-code workspace accounting without a native security adapter", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = new ProductionWorkspaceDiskBudget({
      workspaceRootDirectory: workspaceRoot,
      perAttemptDiskBytes: 100n * mebibyte,
      totalWorkspaceDiskBytes: 200n * mebibyte,
      minimumFreeDiskBytes: 50n * mebibyte,
      orphanRetentionMilliseconds: 1_000n,
      orphanScanLimit: 100,
      fileSystem,
      clock: new FakeWorkspaceDiskClock(),
    });

    const reservation = await budget.admit(attempt("a"));
    expect(reservation.attemptDirectory).toBe(attempt("a"));
    await reservation.release();
    await expect(budget.sweepOrphans()).resolves.toMatchObject({ scanned: 0, removed: 0 });
  });

  it("drains when the native adapter loses its process-lifetime exclusive lock", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    fileSystem.exclusiveOwnership = false;

    await expect(createBudget(fileSystem).admit(attempt("a"))).rejects.toMatchObject({
      code: "EXCLUSIVE_WORKSPACE_OWNERSHIP_LOST",
    });
  });

  it("serializes full-capacity reservations before any attempt directory is created", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    const paths = [attempt("a"), attempt("b"), attempt("c")];

    const results = await Promise.allSettled(paths.map(async (path) => budget.admit(path)));

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect(results[2]).toMatchObject({
      reason: { code: "EXISTING_WORKSPACE_UNHEALTHY" },
    });
    expect(paths.every((path) => !fileSystem.has(path))).toBe(true);

    const first = results[0];
    if (first?.status !== "fulfilled") throw new Error("First reservation was not admitted.");
    await first.value.release();
    await expect(budget.admit(paths[2] as string)).resolves.toMatchObject({
      attemptDirectory: paths[2],
    });
  });

  it("cancels an exclusive-queue waiter without waiting for the current native I/O", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    let releaseOwnership!: () => void;
    fileSystem.ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const budget = createBudget(fileSystem, clock);
    const first = budget.admit(attempt("a"));
    await waitForCondition(() => fileSystem.ownershipChecks === 1);

    const controller = new AbortController();
    const queued = budget.admit(attempt("b"), controller.signal);
    controller.abort(new Error("lease cancelled in queue"));
    await expect(queued).rejects.toMatchObject({ code: "ABORTED" });

    releaseOwnership();
    await expect(first).resolves.toMatchObject({ attemptDirectory: attempt("a") });
  });

  it("starts the operation deadline when a request enters the exclusive queue", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    let releaseOwnership!: () => void;
    fileSystem.ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const budget = createBudget(fileSystem, clock, {
      maximumScanDurationMilliseconds: 30_000,
    });
    const first = budget.admit(attempt("a"));
    await waitForCondition(() => fileSystem.ownershipChecks === 1);
    const queued = budget.admit(attempt("b"));

    clock.advance(30_001);
    await expect(queued).rejects.toMatchObject({ code: "ACCOUNTING_TIMED_OUT" });
    releaseOwnership();
    await expect(first).rejects.toMatchObject({ code: "ACCOUNTING_TIMED_OUT" });
  });

  it("uses native handle-bound removal for a reserved attempt", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem, undefined, { maximumAccountingEntries: 2 });
    const attemptDirectory = attempt("a");
    const reservation = await budget.admit(attemptDirectory);
    fileSystem.addDirectory(attemptDirectory);
    fileSystem.addDirectory(win32.join(attemptDirectory, "checkout"));
    fileSystem.addFile(win32.join(attemptDirectory, "checkout", "file.bin"), 10n);
    fileSystem.addFile(win32.join(attemptDirectory, "checkout", "second.bin"), 20n);

    await reservation.removeAttempt();

    expect(fileSystem.removed).toEqual([attemptDirectory]);
    expect(fileSystem.has(attemptDirectory)).toBe(false);
    await reservation.release();
  });

  it("removes only its fixed checkout identity and keeps the reservation active", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock, { maximumAccountingEntries: 2 });
    const attemptDirectory = attempt("a");
    const reservation = await budget.admit(attemptDirectory);
    const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
      fileSystem,
      attemptDirectory,
    );
    const otherAttempt = attempt("b");
    const otherAttemptMarker = win32.join(otherAttempt, "marker.txt");
    fileSystem.addDirectory(otherAttempt, clock.now);
    fileSystem.addFile(otherAttemptMarker, 5n, clock.now);
    const rootState = await fileSystem.lstat(workspaceRoot);
    const attemptState = await fileSystem.lstat(attemptDirectory);
    const checkoutState = await fileSystem.lstat(checkoutDirectory);

    expect(reservation.removeCheckout).toHaveLength(0);
    await Reflect.apply(reservation.removeCheckout, reservation, ["D:\\outside"]);

    expect(fileSystem.checkoutRemovalRequests).toEqual([
      {
        workspaceRootDirectory: workspaceRoot,
        workspaceRootDevice: rootState?.device,
        workspaceRootInode: rootState?.inode,
        attemptDirectory,
        attemptDevice: attemptState?.device,
        attemptInode: attemptState?.inode,
        checkoutDirectory,
        checkoutDevice: checkoutState?.device,
        checkoutInode: checkoutState?.inode,
        deadlineEpochMilliseconds: 40_000n,
      },
    ]);
    expect(fileSystem.removed).toEqual([checkoutDirectory]);
    expect(fileSystem.has(checkoutDirectory)).toBe(false);
    for (const path of preservedPaths) expect(fileSystem.has(path)).toBe(true);
    expect(fileSystem.has(otherAttemptMarker)).toBe(true);
    await expect(budget.sweepOrphans()).resolves.toMatchObject({ active: 1, removed: 0 });

    await reservation.removeCheckout();
    expect(fileSystem.checkoutRemovalRequests).toHaveLength(1);
    await reservation.removeAttempt();
    expect(fileSystem.removed).toEqual([checkoutDirectory, attemptDirectory]);
    expect(fileSystem.has("D:\\outside\\marker.txt")).toBe(true);
    expect(fileSystem.has(otherAttemptMarker)).toBe(true);
    await reservation.release();
  });

  it.each(["release", "abandon"] as const)(
    "refuses checkout removal after reservation %s",
    async (lifecycle) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const reservation = await createBudget(fileSystem).admit(attempt("a"));
      const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
        fileSystem,
        reservation.attemptDirectory,
      );
      await reservation[lifecycle]();

      await expect(reservation.removeCheckout()).rejects.toMatchObject({
        code: "RESERVATION_RELEASED",
      });
      expect(fileSystem.checkoutRemovalRequests).toEqual([]);
      expect(fileSystem.removed).toEqual([]);
      for (const path of [checkoutDirectory, ...preservedPaths]) {
        expect(fileSystem.has(path)).toBe(true);
      }
    },
  );

  it("rejects checkout removal when its active record is abandoned before queue entry", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const reservation = await createBudget(fileSystem).admit(attempt("a"));
    const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
      fileSystem,
      reservation.attemptDirectory,
    );

    const removal = reservation.removeCheckout();
    reservation.abandon();

    await expect(removal).rejects.toMatchObject({ code: "RESERVATION_RELEASED" });
    expect(fileSystem.checkoutRemovalRequests).toEqual([]);
    expect(fileSystem.removed).toEqual([]);
    for (const path of [checkoutDirectory, ...preservedPaths]) {
      expect(fileSystem.has(path)).toBe(true);
    }
  });

  it("makes checkout removal idempotent when checkout is already missing", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const reservation = await createBudget(fileSystem).admit(attempt("a"));
    fileSystem.addDirectory(reservation.attemptDirectory);

    await reservation.removeCheckout();
    await reservation.removeCheckout();

    expect(fileSystem.checkoutRemovalRequests).toEqual([]);
    expect(fileSystem.removed).toEqual([]);
    expect(fileSystem.has(workspaceRoot)).toBe(true);
    expect(fileSystem.has(reservation.attemptDirectory)).toBe(true);
    await reservation.release();
  });

  it("rejects a missing checkout result that arrives after its removal deadline", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const reservation = await createBudget(fileSystem, clock).admit(attempt("a"));
    fileSystem.addDirectory(reservation.attemptDirectory);
    const checkoutDirectory = win32.join(reservation.attemptDirectory, "checkout");
    fileSystem.onLstat = (path) => {
      if (key(path) === key(checkoutDirectory)) clock.advance(30_001);
    };

    await expect(reservation.removeCheckout()).rejects.toMatchObject({
      code: "ACCOUNTING_TIMED_OUT",
    });
    expect(fileSystem.checkoutRemovalRequests).toEqual([]);
    expect(fileSystem.removed).toEqual([]);
    expect(fileSystem.has(reservation.attemptDirectory)).toBe(true);
    await reservation.release();
  });

  it("rejects a final missing checkout result that arrives after native removal expires", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const reservation = await createBudget(fileSystem, clock).admit(attempt("a"));
    const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
      fileSystem,
      reservation.attemptDirectory,
    );
    fileSystem.onLstat = (path) => {
      if (key(path) === key(checkoutDirectory) && fileSystem.removed.includes(checkoutDirectory)) {
        clock.advance(30_001);
      }
    };

    await expect(reservation.removeCheckout()).rejects.toMatchObject({
      code: "ACCOUNTING_TIMED_OUT",
    });
    expect(fileSystem.checkoutRemovalRequests).toHaveLength(1);
    expect(fileSystem.removed).toEqual([checkoutDirectory]);
    expect(fileSystem.has(checkoutDirectory)).toBe(false);
    for (const path of preservedPaths) expect(fileSystem.has(path)).toBe(true);
    await reservation.release();
  });

  it("rejects checkout removal when the reserved attempt is missing", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const reservation = await createBudget(fileSystem).admit(attempt("a"));

    await expect(reservation.removeCheckout()).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    expect(fileSystem.checkoutRemovalRequests).toEqual([]);
    expect(fileSystem.removed).toEqual([]);
    expect(fileSystem.has(workspaceRoot)).toBe(true);
    await reservation.release();
  });

  it.each(["root", "attempt", "checkout"] as const)(
    "rejects checkout removal through an unsafe %s directory",
    async (unsafeDirectory) => {
      for (const unsafeKind of ["reparse", "alias", "file"] as const) {
        const fileSystem = new FakeWorkspaceDiskFileSystem();
        const reservation = await createBudget(fileSystem).admit(attempt("a"));
        const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
          fileSystem,
          reservation.attemptDirectory,
        );
        const path =
          unsafeDirectory === "root"
            ? workspaceRoot
            : unsafeDirectory === "attempt"
              ? reservation.attemptDirectory
              : checkoutDirectory;
        if (unsafeKind === "reparse") fileSystem.setReparsePoint(path);
        else if (unsafeKind === "alias") fileSystem.setRealPath(path, "D:\\outside");
        else fileSystem.addFile(path, 1n);

        await expect(reservation.removeCheckout()).rejects.toMatchObject({
          code: unsafeDirectory === "root" ? "WORKSPACE_ROOT_UNSAFE" : "WORKSPACE_PATH_UNSAFE",
        });
        expect(fileSystem.checkoutRemovalRequests).toEqual([]);
        expect(fileSystem.removed).toEqual([]);
        for (const preservedPath of [checkoutDirectory, ...preservedPaths]) {
          expect(fileSystem.has(preservedPath)).toBe(true);
        }
        await reservation.release();
      }
    },
  );

  it.each(["root", "attempt", "checkout"] as const)(
    "fails closed when the %s identity changes during checkout validation",
    async (changedDirectory) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const reservation = await createBudget(fileSystem).admit(attempt("a"));
      const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
        fileSystem,
        reservation.attemptDirectory,
      );
      const path =
        changedDirectory === "root"
          ? workspaceRoot
          : changedDirectory === "attempt"
            ? reservation.attemptDirectory
            : checkoutDirectory;
      let reads = 0;
      fileSystem.onLstat = (candidate) => {
        if (key(candidate) === key(path) && ++reads === 2) fileSystem.changeIdentity(path);
      };

      await expect(reservation.removeCheckout()).rejects.toMatchObject({
        code: changedDirectory === "root" ? "WORKSPACE_ROOT_UNSAFE" : "SNAPSHOT_UNSTABLE",
      });
      expect(fileSystem.checkoutRemovalRequests).toEqual([]);
      expect(fileSystem.removed).toEqual([]);
      for (const preservedPath of [checkoutDirectory, ...preservedPaths]) {
        expect(fileSystem.has(preservedPath)).toBe(true);
      }
      await reservation.release();
    },
  );

  it.each(["root", "attempt", "checkout"] as const)(
    "binds checkout removal to the %s identity passed to the native adapter",
    async (changedDirectory) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const reservation = await createBudget(fileSystem).admit(attempt("a"));
      const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
        fileSystem,
        reservation.attemptDirectory,
      );
      const removeCheckout = fileSystem.quarantineAndRemoveCheckout.bind(fileSystem);
      fileSystem.quarantineAndRemoveCheckout = async (request) => {
        const path =
          changedDirectory === "root"
            ? request.workspaceRootDirectory
            : changedDirectory === "attempt"
              ? request.attemptDirectory
              : request.checkoutDirectory;
        fileSystem.changeIdentity(path);
        return removeCheckout(request);
      };

      await expect(reservation.removeCheckout()).rejects.toMatchObject({
        code: "HANDLE_BOUND_DELETE_FAILED",
      });
      expect(fileSystem.checkoutRemovalRequests).toHaveLength(1);
      expect(fileSystem.removed).toEqual([]);
      for (const path of [checkoutDirectory, ...preservedPaths]) {
        expect(fileSystem.has(path)).toBe(true);
      }
      await reservation.release();
    },
  );

  it.each(["root", "attempt"] as const)(
    "rejects a changed %s identity after native checkout removal",
    async (changedDirectory) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const reservation = await createBudget(fileSystem).admit(attempt("a"));
      const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
        fileSystem,
        reservation.attemptDirectory,
      );
      const removeCheckout = fileSystem.quarantineAndRemoveCheckout.bind(fileSystem);
      fileSystem.quarantineAndRemoveCheckout = async (request) => {
        const result = await removeCheckout(request);
        fileSystem.changeIdentity(
          changedDirectory === "root" ? request.workspaceRootDirectory : request.attemptDirectory,
        );
        return result;
      };

      await expect(reservation.removeCheckout()).rejects.toMatchObject({
        code: changedDirectory === "root" ? "WORKSPACE_ROOT_UNSAFE" : "WORKSPACE_PATH_UNSAFE",
      });
      expect(fileSystem.removed).toEqual([checkoutDirectory]);
      for (const path of preservedPaths) expect(fileSystem.has(path)).toBe(true);
      await reservation.release();
    },
  );

  it("requires checkout capability from a configured native adapter", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const reservation = await createBudget(fileSystem).admit(attempt("a"));
    const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
      fileSystem,
      reservation.attemptDirectory,
    );
    Object.defineProperty(fileSystem, "quarantineAndRemoveCheckout", { value: undefined });

    await expect(reservation.removeCheckout()).rejects.toMatchObject({
      code: "NATIVE_SECURITY_ADAPTER_REQUIRED",
    });
    expect(fileSystem.removed).toEqual([]);
    for (const path of [checkoutDirectory, ...preservedPaths]) {
      expect(fileSystem.has(path)).toBe(true);
    }
    await reservation.release();
  });

  it.each(["throws", "leaves checkout"] as const)(
    "fails closed when native checkout removal %s",
    async (failure) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const reservation = await createBudget(fileSystem).admit(attempt("a"));
      const { checkoutDirectory, preservedPaths } = addCheckoutWithPreservedMarkers(
        fileSystem,
        reservation.attemptDirectory,
      );
      fileSystem.quarantineAndRemoveCheckout = async (request) => {
        fileSystem.checkoutRemovalRequests.push(request);
        if (failure === "throws") throw new Error("native checkout removal failed");
        return { removedBytes: null };
      };

      await expect(reservation.removeCheckout()).rejects.toMatchObject({
        code: "HANDLE_BOUND_DELETE_FAILED",
      });
      expect(fileSystem.checkoutRemovalRequests).toHaveLength(1);
      expect(fileSystem.removed).toEqual([]);
      for (const path of [checkoutDirectory, ...preservedPaths]) {
        expect(fileSystem.has(path)).toBe(true);
      }
      await reservation.release();
    },
  );

  it("makes an abandoned failed-cleanup reservation available to the janitor", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    const attemptDirectory = attempt("a");
    const reservation = await budget.admit(attemptDirectory);
    fileSystem.addDirectory(attemptDirectory, 0n);
    fileSystem.addFile(win32.join(attemptDirectory, "orphan.bin"), 9n);

    reservation.abandon();

    await expect(budget.sweepOrphans()).resolves.toMatchObject({
      active: 0,
      removed: 1,
      removedBytes: 9n,
    });
  });

  it("preserves minimum free space and accounts for pre-existing orphan bytes", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    fileSystem.freeBytes = 149n * mebibyte;
    await expect(createBudget(fileSystem).admit(attempt("a"))).rejects.toMatchObject({
      code: "INSUFFICIENT_FREE_SPACE",
    });

    const orphan = attempt("b");
    fileSystem.freeBytes = 1_000n * mebibyte;
    fileSystem.addDirectory(orphan);
    fileSystem.addFile(win32.join(orphan, "large.bin"), 101n * mebibyte);
    await expect(createBudget(fileSystem).admit(attempt("c"))).rejects.toMatchObject({
      code: "EXISTING_WORKSPACE_UNHEALTHY",
    });
  });

  it("fails accounting closed on reparse points and bounded-scan exhaustion", async () => {
    const reparseFileSystem = new FakeWorkspaceDiskFileSystem();
    const existing = attempt("a");
    reparseFileSystem.addDirectory(existing);
    reparseFileSystem.addDirectory(win32.join(existing, "redirected"));
    reparseFileSystem.setReparsePoint(win32.join(existing, "redirected"));
    reparseFileSystem.setRealPath(win32.join(existing, "redirected"), "D:\\outside");
    await expect(createBudget(reparseFileSystem).admit(attempt("b"))).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });

    const crowdedFileSystem = new FakeWorkspaceDiskFileSystem();
    const crowded = attempt("c");
    crowdedFileSystem.addDirectory(crowded);
    crowdedFileSystem.addFile(win32.join(crowded, "one"), 1n);
    crowdedFileSystem.addFile(win32.join(crowded, "two"), 1n);
    await expect(
      createBudget(crowdedFileSystem, undefined, { maximumAccountingEntries: 2 }).admit(
        attempt("d"),
      ),
    ).rejects.toMatchObject({ code: "ACCOUNTING_LIMIT_EXCEEDED" });
  });

  it("retries a bounded snapshot generation when a Git rename causes transient ENOENT", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const existing = attempt("a");
    const transientFile = win32.join(existing, "transient.pack");
    fileSystem.addDirectory(existing);
    fileSystem.addFile(transientFile, 1n);
    fileSystem.missNextLstats(transientFile, 1);

    await expect(createBudget(fileSystem).admit(attempt("b"))).resolves.toMatchObject({
      attemptDirectory: attempt("b"),
    });
  });

  it("classifies a continuously changing snapshot as retryable workspace health", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const existing = attempt("a");
    const transientFile = win32.join(existing, "transient.pack");
    fileSystem.addDirectory(existing);
    fileSystem.addFile(transientFile, 1n);
    fileSystem.missNextLstats(transientFile, 3);

    await expect(createBudget(fileSystem).admit(attempt("b"))).rejects.toMatchObject({
      code: "SNAPSHOT_UNSTABLE",
    });
  });

  it("reserves full active capacity when admission samples a concurrently growing attempt", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    const activePath = attempt("a");
    const active = await budget.admit(activePath);
    fileSystem.addDirectory(activePath);
    fileSystem.addFile(win32.join(activePath, "existing.bin"), mebibyte);
    fileSystem.onReadDirectory = (path) => {
      if (key(path) !== key(activePath)) return;
      fileSystem.touch(activePath);
      if (!fileSystem.has(win32.join(activePath, "new.bin"))) {
        fileSystem.addFile(win32.join(activePath, "new.bin"), 90n * mebibyte);
      }
    };

    const second = await budget.admit(attempt("b"));
    await expect(budget.admit(attempt("c"))).rejects.toMatchObject({
      code: "EXISTING_WORKSPACE_UNHEALTHY",
    });
    await second.release();
    await active.release();
  });

  it("keeps unreserved attempt metadata and cleanup checks strict", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const existing = attempt("a");
    fileSystem.addDirectory(existing);
    fileSystem.onReadDirectory = (path) => {
      if (key(path) === key(existing)) fileSystem.touch(existing);
    };
    await expect(createBudget(fileSystem).admit(attempt("b"))).rejects.toMatchObject({
      code: "SNAPSHOT_UNSTABLE",
    });

    fileSystem.onReadDirectory = undefined;
    const budget = createBudget(fileSystem);
    const activePath = attempt("c");
    const active = await budget.admit(activePath);
    fileSystem.addDirectory(activePath);
    fileSystem.onLstat = (path) => {
      if (key(path) === key(activePath)) fileSystem.touch(activePath);
    };
    await expect(active.removeAttempt()).rejects.toMatchObject({ code: "SNAPSHOT_UNSTABLE" });
    expect(fileSystem.has(activePath)).toBe(true);
    await active.release();
  });

  it("retains the entry cap while an active attempt changes directory timestamps", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock, { maximumAccountingEntries: 2 });
    const activePath = attempt("a");
    const active = await budget.admit(activePath);
    fileSystem.addDirectory(activePath);
    fileSystem.addFile(win32.join(activePath, "first.bin"), 1n);
    fileSystem.onReadDirectory = (path) => {
      if (key(path) === key(activePath)) fileSystem.touch(activePath);
    };
    const monitor = await active.startMonitoring(new AbortController().signal);
    fileSystem.addFile(win32.join(activePath, "second.bin"), 1n);

    await clock.tick();
    expect(monitor.violation).toMatchObject({ code: "ACCOUNTING_LIMIT_EXCEEDED" });
    await expect(monitor.close()).rejects.toMatchObject({ code: "ACCOUNTING_LIMIT_EXCEEDED" });
    await active.release();
  });

  it("retains the deadline and free-space floor during active churn", async () => {
    for (const expectedCode of ["ACCOUNTING_TIMED_OUT", "INSUFFICIENT_FREE_SPACE"] as const) {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const clock = new FakeWorkspaceDiskClock();
      const budget = createBudget(fileSystem, clock);
      const activePath = attempt("a");
      const active = await budget.admit(activePath);
      fileSystem.addDirectory(activePath);
      const monitor = await active.startMonitoring(new AbortController().signal);
      fileSystem.onReadDirectory = (path) => {
        if (key(path) !== key(activePath)) return;
        fileSystem.touch(activePath);
        if (expectedCode === "ACCOUNTING_TIMED_OUT") clock.advance(30_001);
        else fileSystem.freeBytes = 49n * mebibyte;
      };

      await clock.tick();
      expect(monitor.violation).toMatchObject({ code: expectedCode });
      await expect(monitor.close()).rejects.toMatchObject({ code: expectedCode });
      await active.release();
    }
  });

  it("stops a bounded admission scan when its lease signal is cancelled", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const existing = attempt("a");
    fileSystem.addDirectory(existing);
    fileSystem.addFile(win32.join(existing, "first.bin"), 1n);
    const controller = new AbortController();
    fileSystem.onLstat = (path) => {
      if (key(path) === key(existing)) controller.abort(new Error("lease cancelled"));
    };

    await expect(
      createBudget(fileSystem).admit(attempt("b"), controller.signal),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(fileSystem.removed).toEqual([]);
  });

  it("fails a filesystem scan closed when its wall-clock accounting deadline expires", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const existing = attempt("a");
    fileSystem.addDirectory(existing);
    fileSystem.addFile(win32.join(existing, "first.bin"), 1n);
    fileSystem.onLstat = (path) => {
      if (key(path) === key(existing)) clock.now = 40_001n;
    };

    await expect(
      createBudget(fileSystem, clock, { maximumScanDurationMilliseconds: 30_000 }).admit(
        attempt("b"),
      ),
    ).rejects.toMatchObject({ code: "ACCOUNTING_TIMED_OUT" });
  });

  it("aborts a linked operation signal when attempt growth crosses its bigint quota", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock);
    const attemptDirectory = attempt("a");
    const reservation = await budget.admit(attemptDirectory);
    fileSystem.addDirectory(attemptDirectory);
    const output = win32.join(attemptDirectory, "pack.bin");
    fileSystem.addFile(output, 10n * mebibyte);
    const monitor = await reservation.startMonitoring(new AbortController().signal);

    fileSystem.setFileSize(output, 101n * mebibyte);
    await clock.tick();

    expect(monitor.signal.aborted).toBe(true);
    expect(monitor.violation).toMatchObject({ code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED" });
    const firstClose = monitor.close();
    const secondClose = monitor.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED",
    });
    await expect(secondClose).rejects.toMatchObject({
      code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED",
    });
    await reservation.release();
  });

  it("checks reserved headroom in total capacity and the free-space floor", async () => {
    const totalFileSystem = new FakeWorkspaceDiskFileSystem();
    const totalBudget = createBudget(totalFileSystem);
    const currentPath = attempt("a");
    const current = await totalBudget.admit(currentPath);
    totalFileSystem.addDirectory(currentPath);
    totalFileSystem.addFile(win32.join(currentPath, "current.bin"), 10n * mebibyte);
    const firstOrphan = attempt("b");
    totalFileSystem.addDirectory(firstOrphan);
    totalFileSystem.addFile(win32.join(firstOrphan, "orphan.bin"), 91n * mebibyte);
    const secondOrphan = attempt("c");
    totalFileSystem.addDirectory(secondOrphan);
    totalFileSystem.addFile(win32.join(secondOrphan, "orphan.bin"), 10n * mebibyte);

    await expect(current.startMonitoring(new AbortController().signal)).rejects.toMatchObject({
      code: "EXISTING_WORKSPACE_UNHEALTHY",
    });
    await current.release();

    const freeFileSystem = new FakeWorkspaceDiskFileSystem();
    const freeBudget = createBudget(freeFileSystem);
    const freePath = attempt("d");
    const freeReservation = await freeBudget.admit(freePath);
    freeFileSystem.addDirectory(freePath);
    freeFileSystem.addFile(win32.join(freePath, "current.bin"), 10n * mebibyte);
    freeFileSystem.freeBytes = 139n * mebibyte;
    await expect(
      freeReservation.startMonitoring(new AbortController().signal),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FREE_SPACE" });
    await freeReservation.release();
  });

  it("performs a final quota check for short operations and links caller cancellation", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    const attemptDirectory = attempt("a");
    const reservation = await budget.admit(attemptDirectory);
    fileSystem.addDirectory(attemptDirectory);
    const output = win32.join(attemptDirectory, "pack.bin");
    fileSystem.addFile(output, 1n);

    const monitor = await reservation.startMonitoring(new AbortController().signal);
    fileSystem.freeBytes = 49n * mebibyte;
    await expect(monitor.close()).rejects.toMatchObject({ code: "INSUFFICIENT_FREE_SPACE" });

    fileSystem.freeBytes = 1_000n * mebibyte;
    const parent = new AbortController();
    const cancelled = await reservation.startMonitoring(parent.signal);
    parent.abort(new Error("lease lost"));
    expect(cancelled.signal.aborted).toBe(true);
    expect(cancelled.signal.reason).toMatchObject({ message: "lease lost" });
    await cancelled.close();
    await reservation.release();
  });

  it("removes only retained-age orphan attempts and reports bigint reclaimed bytes", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const stale = attempt("a");
    const recent = attempt("b");
    fileSystem.addDirectory(stale, 8_000n);
    fileSystem.addFile(win32.join(stale, "result.bin"), 11n);
    fileSystem.addDirectory(recent, 9_500n);
    fileSystem.addFile(win32.join(recent, "result.bin"), 13n);

    const result = await createBudget(fileSystem, clock).sweepOrphans();

    expect(result).toEqual({
      scanned: 2,
      removed: 1,
      retained: 1,
      active: 0,
      removedBytes: 11n,
      limitReached: false,
    });
    expect(fileSystem.removed).toEqual([stale]);
    expect(fileSystem.has(stale)).toBe(false);
    expect(fileSystem.has(recent)).toBe(true);
    expect(fileSystem.has(workspaceRoot)).toBe(true);
  });

  it("bounds orphan startup scans and never removes an active reservation", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const activePath = attempt("a");
    const budget = createBudget(fileSystem, clock, { orphanScanLimit: 1 });
    const reservation = await budget.admit(activePath);
    fileSystem.addDirectory(activePath, 0n);
    fileSystem.addFile(win32.join(activePath, "active.bin"), 1n);
    const unscanned = attempt("b");
    fileSystem.addDirectory(unscanned, 0n);

    const result = await budget.sweepOrphans();

    expect(result).toMatchObject({ scanned: 1, active: 1, removed: 0, limitReached: true });
    expect(fileSystem.removed).toEqual([]);
    expect(fileSystem.has(activePath)).toBe(true);
    expect(fileSystem.has(unscanned)).toBe(true);
    await reservation.release();
  });

  it("deletes an orphan through the native adapter even when it exceeds the TS entry cap", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const crowded = attempt("a");
    fileSystem.addDirectory(crowded, 0n);
    fileSystem.addFile(win32.join(crowded, "one.bin"), 1n);
    fileSystem.addFile(win32.join(crowded, "two.bin"), 1n);

    await expect(
      createBudget(fileSystem, undefined, { maximumAccountingEntries: 2 }).sweepOrphans(),
    ).resolves.toMatchObject({ removed: 1, removedBytes: 2n });
    expect(fileSystem.removed).toEqual([crowded]);
    expect(fileSystem.has(crowded)).toBe(false);
  });

  it("saturates orphan removed-byte statistics when the native adapter cannot attribute them", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const orphan = attempt("a");
    fileSystem.addDirectory(orphan, 0n);
    fileSystem.addFile(win32.join(orphan, "unknown.bin"), 17n);
    fileSystem.reportUnknownRemovedBytes = true;

    await expect(createBudget(fileSystem).sweepOrphans()).resolves.toMatchObject({
      removed: 1,
      removedBytes: null,
    });
  });

  it("refuses unrecognized, redirected, or reparse orphan targets", async () => {
    const unexpectedFileSystem = new FakeWorkspaceDiskFileSystem();
    unexpectedFileSystem.addDirectory(win32.join(workspaceRoot, "manual-folder"), 0n);
    await expect(createBudget(unexpectedFileSystem).sweepOrphans()).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    expect(unexpectedFileSystem.removed).toEqual([]);

    const redirectedFileSystem = new FakeWorkspaceDiskFileSystem();
    const redirected = attempt("a");
    redirectedFileSystem.addDirectory(redirected, 0n);
    redirectedFileSystem.setRealPath(redirected, "D:\\outside");
    await expect(createBudget(redirectedFileSystem).sweepOrphans()).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    expect(redirectedFileSystem.removed).toEqual([]);

    const reparseFileSystem = new FakeWorkspaceDiskFileSystem();
    const reparse = attempt("b");
    reparseFileSystem.addDirectory(reparse, 0n);
    reparseFileSystem.setReparsePoint(reparse);
    await expect(createBudget(reparseFileSystem).sweepOrphans()).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    expect(reparseFileSystem.removed).toEqual([]);
  });

  it("accepts only canonical lowercase attempt hash directory names", () => {
    expect(isStrictAttemptDirectoryName(`attempt-${"a".repeat(64)}`)).toBe(true);
    expect(isStrictAttemptDirectoryName(`attempt-${"A".repeat(64)}`)).toBe(false);
    expect(isStrictAttemptDirectoryName(`attempt-${"a".repeat(63)}`)).toBe(false);
    expect(isStrictAttemptDirectoryName(`attempt-${"a".repeat(64)}-extra`)).toBe(false);
    expect(isStrictAttemptDirectoryName("attempt-../outside")).toBe(false);
    expect(
      () =>
        new ProductionWorkspaceDiskBudget({
          workspaceRootDirectory: "C:\\CON\\workspaces",
          perAttemptDiskBytes: 1n,
          totalWorkspaceDiskBytes: 1n,
          minimumFreeDiskBytes: 0n,
          orphanRetentionMilliseconds: 1n,
          orphanScanLimit: 1,
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });
});

function addCheckoutWithPreservedMarkers(
  fileSystem: FakeWorkspaceDiskFileSystem,
  attemptDirectory: string,
): { readonly checkoutDirectory: string; readonly preservedPaths: readonly string[] } {
  const checkoutDirectory = win32.join(attemptDirectory, "checkout");
  const preservedPaths = [
    workspaceRoot,
    attemptDirectory,
    "D:\\outside",
    "D:\\outside\\marker.txt",
  ];
  fileSystem.addDirectory(attemptDirectory);
  fileSystem.addDirectory(checkoutDirectory);
  fileSystem.addFile(win32.join(checkoutDirectory, "first.bin"), 1n);
  fileSystem.addFile(win32.join(checkoutDirectory, "second.bin"), 2n);
  fileSystem.addDirectory("D:\\outside");
  fileSystem.addFile("D:\\outside\\marker.txt", 3n);
  for (const directory of ["temp", "control", "profile"]) {
    const siblingDirectory = win32.join(attemptDirectory, directory);
    const marker = win32.join(siblingDirectory, "marker.txt");
    fileSystem.addDirectory(siblingDirectory);
    fileSystem.addFile(marker, 4n);
    preservedPaths.push(siblingDirectory, marker);
  }
  return { checkoutDirectory, preservedPaths };
}

function key(path: string): string {
  return win32.normalize(path).toLowerCase();
}

function fileSystemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not observed before the test deadline.");
}
