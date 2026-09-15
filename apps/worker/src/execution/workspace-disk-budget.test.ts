import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeAttemptDirectoryName } from "./workspace-directory-name.js";
import {
  type BoundedDirectoryEntries,
  isStrictAttemptDirectoryName,
  type NativeWorkspaceSecurityAdapter,
  ProductionWorkspaceDiskBudget,
  WorkspaceDiskBudgetError,
  type WorkspaceDiskClock,
  type WorkspaceDiskInterval,
  type WorkspaceDiskIoContext,
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
  public onRealpath: ((path: string) => void) | undefined;
  public onReadLink: ((path: string) => void) | undefined;
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
    this.onRealpath?.(path);
    const entry = this.#entries.get(key(path));
    if (entry === undefined) throw fileSystemError("ENOENT", `Missing path: ${path}`);
    return entry.realPath;
  }

  public async readLink(path: string): Promise<string> {
    this.onReadLink?.(path);
    return this.#entry(path).realPath;
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

  public removeEntry(path: string): void {
    this.#entries.delete(key(path));
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

function compactAttempt(fill: string): string {
  return win32.join(workspaceRoot, encodeAttemptDirectoryName(fill.repeat(64), "compact-v1"));
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
      reason: { code: "CAPACITY_UNAVAILABLE" },
    });
    expect(paths.every((path) => !fileSystem.has(path))).toBe(true);

    const first = results[0];
    if (first?.status !== "fulfilled") throw new Error("First reservation was not admitted.");
    await first.value.release();
    await expect(budget.admit(paths[2] as string)).resolves.toMatchObject({
      attemptDirectory: paths[2],
    });
  });

  it.each([
    ["legacy to legacy", attempt("a"), attempt("a")],
    ["compact-v1 to compact-v1", compactAttempt("a"), compactAttempt("a")],
    ["legacy to compact-v1", attempt("a"), compactAttempt("a")],
    ["compact-v1 to legacy", compactAttempt("a"), attempt("a")],
  ] as const)(
    "refuses an existing digest for %s without reserving or removing it",
    async (_, existingPath, requestedPath) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const marker = win32.join(existingPath, "marker.txt");
      fileSystem.addDirectory(existingPath);
      fileSystem.addFile(marker, 1n);
      const budget = createBudget(fileSystem);

      await expect(budget.admit(requestedPath)).rejects.toMatchObject({
        code: "ATTEMPT_ALREADY_EXISTS",
      });

      const unrelated = await budget.admit(attempt("b"));
      await unrelated.release();
      expect(fileSystem.removed).toEqual([]);
      expect(fileSystem.has(marker)).toBe(true);
      expect(fileSystem.has(requestedPath)).toBe(requestedPath === existingPath);
    },
  );

  it.each([
    ["legacy to compact-v1", attempt("a"), compactAttempt("a")],
    ["compact-v1 to legacy", compactAttempt("a"), attempt("a")],
  ] as const)(
    "preserves the original reservation when %s requests the same digest before directory creation",
    async (_, reservedPath, requestedPath) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const budget = createBudget(fileSystem);
      const original = await budget.admit(reservedPath);

      await expect(budget.admit(requestedPath)).rejects.toMatchObject({
        code: "ATTEMPT_ALREADY_EXISTS",
      });

      expect(original.attemptDirectory).toBe(reservedPath);
      expect(fileSystem.has(reservedPath)).toBe(false);
      expect(fileSystem.has(requestedPath)).toBe(false);
      const unrelated = await budget.admit(attempt("b"));
      await expect(budget.hasCapacity()).resolves.toBe(false);
      await unrelated.release();
      await original.release();

      const replacement = await budget.admit(requestedPath);
      expect(replacement.attemptDirectory).toBe(requestedPath);
      await replacement.release();
      expect(fileSystem.removed).toEqual([]);
    },
  );

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

  it("distinguishes a busy exclusive queue from an expired filesystem operation", async () => {
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
    await expect(queued).rejects.toMatchObject({ code: "ACCOUNTING_BUSY" });
    releaseOwnership();
    await expect(first).rejects.toMatchObject({ code: "ACCOUNTING_TIMED_OUT" });
  });

  it("gives a filesystem operation its full deadline after waiting in the exclusive queue", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock);
    let releaseOwnership!: () => void;
    fileSystem.ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const first = budget.admit(attempt("a"));
    await waitForCondition(() => fileSystem.ownershipChecks === 1);
    const second = budget.admit(attempt("b"));
    clock.advance(20_000);
    let rootReads = 0;
    fileSystem.onReadDirectory = (path) => {
      if (key(path) === key(workspaceRoot) && ++rootReads === 2) clock.advance(20_000);
    };
    releaseOwnership();

    await expect(first).resolves.toMatchObject({ attemptDirectory: attempt("a") });
    await expect(second).resolves.toMatchObject({ attemptDirectory: attempt("b") });
    expect(rootReads).toBe(2);
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

  it.each([
    ["legacy", attempt("a")],
    ["compact-v1", compactAttempt("a")],
  ] as const)(
    "removes only the fixed %s checkout identity and keeps its reservation active",
    async (_, attemptDirectory) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const clock = new FakeWorkspaceDiskClock();
      const budget = createBudget(fileSystem, clock, { maximumAccountingEntries: 2 });
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
    },
  );

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

  it.each([
    ["legacy", attempt("c")],
    ["compact-v1", compactAttempt("c")],
  ] as const)(
    "counts both directory formats when admitting a %s attempt",
    async (_, nextAttempt) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const legacy = attempt("a");
      const compact = compactAttempt("b");
      const compactOutput = win32.join(compact, "output.bin");
      fileSystem.addDirectory(legacy);
      fileSystem.addFile(win32.join(legacy, "output.bin"), 51n * mebibyte);
      fileSystem.addDirectory(compact);
      fileSystem.addFile(compactOutput, 49n * mebibyte);
      const budget = createBudget(fileSystem);

      await expect(budget.hasCapacity()).resolves.toBe(true);
      const reservation = await budget.admit(nextAttempt);
      await expect(budget.hasCapacity()).resolves.toBe(false);
      await reservation.release();

      fileSystem.setFileSize(compactOutput, 49n * mebibyte + 1n);
      await expect(budget.hasCapacity()).resolves.toBe(false);
      await expect(budget.admit(nextAttempt)).rejects.toMatchObject({
        code: "CAPACITY_UNAVAILABLE",
      });
      expect(fileSystem.removed).toEqual([]);
      expect(fileSystem.has(legacy)).toBe(true);
      expect(fileSystem.has(compact)).toBe(true);
    },
  );

  it("checks temporary capacity without reserving it and recovers after space returns", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    fileSystem.freeBytes = 149n * mebibyte;
    await expect(budget.hasCapacity()).resolves.toBe(false);
    fileSystem.freeBytes = 1_000n * mebibyte;
    await expect(budget.hasCapacity()).resolves.toBe(true);
    const first = await budget.admit(attempt("a"));
    const second = await budget.admit(attempt("b"));
    await expect(budget.hasCapacity()).resolves.toBe(false);
    await first.release();
    await expect(budget.hasCapacity()).resolves.toBe(true);
    await second.release();
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
      code: "CAPACITY_UNAVAILABLE",
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

  it("samples active creation, deletion, growth, and dangling dependency links without traversal", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock);
    const active = await budget.admit(attempt("a"));
    const activePath = active.attemptDirectory;
    const link = win32.join(activePath, "dependency");
    const target = win32.join(activePath, "pending", "package", "index.js");
    const output = win32.join(activePath, "output.bin");
    fileSystem.addDirectory(activePath);
    fileSystem.addFile(link, 1n);
    fileSystem.setReparsePoint(link);
    fileSystem.setRealPath(link, target);
    fileSystem.addFile(output, mebibyte);
    fileSystem.onRealpath = (path) => {
      if (key(path) === key(link)) throw fileSystemError("ENOENT", "Link target is not published.");
    };
    let generations = 0;
    let previousTemporary: string | undefined;
    const enumerated: string[] = [];
    fileSystem.onReadDirectory = (path) => {
      enumerated.push(path);
      if (key(path) !== key(activePath)) return;
      generations += 1;
      fileSystem.touch(activePath);
      if (previousTemporary !== undefined) fileSystem.removeEntry(previousTemporary);
      previousTemporary = win32.join(activePath, `temporary-${generations}.bin`);
      fileSystem.addFile(previousTemporary, 1n);
      fileSystem.setFileSize(output, BigInt(generations) * mebibyte);
    };

    const monitor = await active.startMonitoring(new AbortController().signal);
    for (let tick = 0; tick < 4; tick += 1) await clock.tick();
    await monitor.close();

    expect(generations).toBe(6);
    expect(monitor.signal.aborted).toBe(false);
    expect(monitor.violation).toBeUndefined();
    expect(
      enumerated.every((path) => [key(workspaceRoot), key(activePath)].includes(key(path))),
    ).toBe(true);
    expect(fileSystem.has(target)).toBe(false);
    await active.release();
  });

  it("samples repeated atomic file replacement and preserves its largest observed size", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock);
    const active = await budget.admit(attempt("a"));
    fileSystem.addDirectory(active.attemptDirectory);
    const output = win32.join(active.attemptDirectory, "output.bin");
    fileSystem.addFile(output, mebibyte);
    let replacements = 0;
    fileSystem.onRealpath = (path) => {
      if (key(path) !== key(output)) return;
      replacements += 1;
      fileSystem.changeIdentity(output);
      fileSystem.setFileSize(output, mebibyte);
      throw fileSystemError("ENOENT", "File was replaced between metadata reads.");
    };

    const monitor = await active.startMonitoring(new AbortController().signal);
    for (let tick = 0; tick < 4; tick += 1) {
      fileSystem.setFileSize(output, BigInt(tick + 2) * mebibyte);
      await clock.tick();
      expect(monitor.violation).toBeUndefined();
    }
    fileSystem.setFileSize(output, 101n * mebibyte);
    await clock.tick();

    expect(replacements).toBe(6);
    expect(monitor.signal.aborted).toBe(true);
    await expect(monitor.close()).rejects.toMatchObject({
      code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED",
    });
    await active.release();
  });

  it.each(["outside", "other-attempt", "junction-ancestor"] as const)(
    "rejects an unresolved active link with an unsafe %s target",
    async (unsafe) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const budget = createBudget(fileSystem);
      const active = await budget.admit(attempt("a"));
      const activePath = active.attemptDirectory;
      fileSystem.addDirectory(activePath);
      const link = win32.join(activePath, "dependency");
      const alias = win32.join(activePath, "alias");
      fileSystem.addFile(link, 1n);
      fileSystem.setReparsePoint(link);
      fileSystem.setRealPath(
        link,
        unsafe === "outside"
          ? "D:\\outside\\missing.js"
          : unsafe === "other-attempt"
            ? win32.join(attempt("b"), "missing.js")
            : win32.join(alias, "missing.js"),
      );
      if (unsafe === "junction-ancestor") {
        fileSystem.addDirectory(alias);
        fileSystem.setReparsePoint(alias);
        fileSystem.setRealPath(alias, "D:\\outside");
      }
      fileSystem.onRealpath = (path) => {
        if (key(path) === key(link)) throw fileSystemError("ENOENT", "Link target is missing.");
      };

      await expect(active.startMonitoring(new AbortController().signal)).rejects.toMatchObject({
        code: "WORKSPACE_PATH_UNSAFE",
      });
      expect(fileSystem.removed).toEqual([]);
      await active.release();
    },
  );

  it.each(["directory", "reparse", "parent-alias", "parent-identity"] as const)(
    "rejects an active file ENOENT race with a %s replacement",
    async (replacement) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const budget = createBudget(fileSystem);
      const active = await budget.admit(attempt("a"));
      const activePath = active.attemptDirectory;
      fileSystem.addDirectory(activePath);
      const output = win32.join(activePath, "output.bin");
      fileSystem.addFile(output, 1n);
      fileSystem.onRealpath = (path) => {
        if (key(path) !== key(output)) return;
        if (replacement === "directory") fileSystem.addDirectory(output);
        if (replacement === "reparse") fileSystem.setReparsePoint(output);
        if (replacement === "parent-alias") fileSystem.setRealPath(activePath, "D:\\outside");
        if (replacement === "parent-identity") fileSystem.changeIdentity(activePath);
        throw fileSystemError("ENOENT", "Path was replaced during sampling.");
      };

      await expect(active.startMonitoring(new AbortController().signal)).rejects.toMatchObject({
        code: "WORKSPACE_PATH_UNSAFE",
      });
      await active.release();
    },
  );

  it.each(["link", "attempt", "root"] as const)(
    "rejects a changed %s identity while sampling an unresolved active link",
    async (replacement) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const budget = createBudget(fileSystem);
      const active = await budget.admit(attempt("a"));
      const activePath = active.attemptDirectory;
      fileSystem.addDirectory(activePath);
      const link = win32.join(activePath, "dependency");
      fileSystem.addFile(link, 1n);
      fileSystem.setReparsePoint(link);
      fileSystem.setRealPath(link, win32.join(activePath, "missing.js"));
      fileSystem.onRealpath = (path) => {
        if (key(path) === key(link)) throw fileSystemError("ENOENT", "Link target is missing.");
      };
      fileSystem.onReadLink = () => {
        fileSystem.changeIdentity(
          replacement === "link" ? link : replacement === "attempt" ? activePath : workspaceRoot,
        );
      };

      await expect(active.startMonitoring(new AbortController().signal)).rejects.toMatchObject({
        code: replacement === "root" ? "WORKSPACE_ROOT_UNSAFE" : "WORKSPACE_PATH_UNSAFE",
      });
      await active.release();
    },
  );

  it("keeps dangling-link sampling bounded by the entry cap and original deadline", async () => {
    for (const violation of ["ACCOUNTING_LIMIT_EXCEEDED", "ACCOUNTING_TIMED_OUT"] as const) {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const clock = new FakeWorkspaceDiskClock();
      const budget = createBudget(fileSystem, clock, { maximumAccountingEntries: 2 });
      const active = await budget.admit(attempt("a"));
      const activePath = active.attemptDirectory;
      fileSystem.addDirectory(activePath);
      const link = win32.join(activePath, "dependency");
      fileSystem.addFile(link, 1n);
      fileSystem.setReparsePoint(link);
      fileSystem.setRealPath(link, win32.join(activePath, "missing", "package.js"));
      fileSystem.onRealpath = (path) => {
        if (key(path) === key(link)) throw fileSystemError("ENOENT", "Link target is missing.");
      };
      const monitor = await active.startMonitoring(new AbortController().signal);
      if (violation === "ACCOUNTING_LIMIT_EXCEEDED") {
        fileSystem.addFile(win32.join(activePath, "extra.bin"), 1n);
      } else {
        fileSystem.onReadLink = () => clock.advance(30_001);
      }

      await clock.tick();
      expect(monitor.signal.aborted).toBe(true);
      await expect(monitor.close()).rejects.toMatchObject({ code: violation });
      await active.release();
    }
  });

  it.each(["parent-alias", "parent-identity", "link-metadata"] as const)(
    "rejects a dangling active link after observed %s changes",
    async (replacement) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const budget = createBudget(fileSystem);
      const active = await budget.admit(attempt("a"));
      const activePath = active.attemptDirectory;
      const parent = win32.join(activePath, "packages");
      const link = win32.join(parent, "dependency");
      fileSystem.addDirectory(activePath);
      fileSystem.addDirectory(parent);
      fileSystem.addFile(link, 1n);
      fileSystem.setReparsePoint(link);
      fileSystem.setRealPath(link, win32.join(activePath, "missing.js"));
      fileSystem.onRealpath = (path) => {
        if (key(path) === key(link)) throw fileSystemError("ENOENT", "Link target is missing.");
      };
      fileSystem.onReadLink = () => {
        if (replacement === "parent-alias") fileSystem.setRealPath(parent, "D:\\outside");
        if (replacement === "parent-identity") fileSystem.changeIdentity(parent);
        if (replacement === "link-metadata") fileSystem.touch(link);
      };

      await expect(active.startMonitoring(new AbortController().signal)).rejects.toMatchObject({
        code: "WORKSPACE_PATH_UNSAFE",
      });
      await active.release();
    },
  );

  it.each(["probe-limit", "deadline"] as const)(
    "bounds missing ancestors of a single active link by the %s",
    async (limit) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const clock = new FakeWorkspaceDiskClock();
      const budget = createBudget(fileSystem, clock);
      const active = await budget.admit(attempt("a"));
      const activePath = active.attemptDirectory;
      const link = win32.join(activePath, "dependency");
      const missing = win32.join(activePath, "missing");
      fileSystem.addDirectory(activePath);
      fileSystem.addFile(link, 1n);
      fileSystem.setReparsePoint(link);
      fileSystem.setRealPath(
        link,
        limit === "probe-limit"
          ? win32.join(missing, ...Array<string>(64).fill("nested"), "package.js")
          : win32.join(missing, "package.js"),
      );
      fileSystem.onRealpath = (path) => {
        if (key(path) === key(link)) throw fileSystemError("ENOENT", "Link target is missing.");
      };
      let ancestorReads = 0;
      fileSystem.onLstat = (path) => {
        if (!key(path).startsWith(`${key(missing)}\\`) && key(path) !== key(missing)) return;
        ancestorReads += 1;
        if (limit === "deadline" && key(path) === key(missing)) clock.advance(30_001);
      };

      await expect(active.startMonitoring(new AbortController().signal)).rejects.toMatchObject({
        code: limit === "probe-limit" ? "ACCOUNTING_LIMIT_EXCEEDED" : "ACCOUNTING_TIMED_OUT",
      });
      expect(ancestorReads).toBe(limit === "probe-limit" ? 64 : 2);
      await active.release();
    },
  );

  it("keeps inactive unresolved links and adapters without readLink on strict validation", async () => {
    for (const activeSampling of [false, true]) {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const budget = createBudget(fileSystem);
      const activePath = attempt("a");
      const active = activeSampling ? await budget.admit(activePath) : undefined;
      fileSystem.addDirectory(activePath);
      const link = win32.join(activePath, "dependency");
      fileSystem.addFile(link, 1n);
      fileSystem.setReparsePoint(link);
      fileSystem.setRealPath(link, win32.join(activePath, "missing.js"));
      fileSystem.onRealpath = (path) => {
        if (key(path) === key(link)) throw fileSystemError("ENOENT", "Link target is missing.");
      };
      if (activeSampling) Object.defineProperty(fileSystem, "readLink", { value: undefined });

      await expect(
        active === undefined
          ? budget.admit(attempt("b"))
          : active.startMonitoring(new AbortController().signal),
      ).rejects.toMatchObject({ code: "SNAPSHOT_UNSTABLE" });
      expect(fileSystem.removed).toEqual([]);
      await active?.release();
    }
  });

  it("overlaps four metadata requests and drains the whole batch before starting another", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    const active = await budget.admit(attempt("a"));
    const activePath = active.attemptDirectory;
    fileSystem.addDirectory(activePath);
    const files = Array.from({ length: 8 }, (_, index) => win32.join(activePath, `file-${index}`));
    for (const file of files) fileSystem.addFile(file, 1n);
    const firstMetadata = deferredVoid();
    const lastMetadata = deferredVoid();
    const lstat = fileSystem.lstat.bind(fileSystem);
    const realpath = fileSystem.realpath.bind(fileSystem);
    let pending = 0;
    let maximumPending = 0;
    let started = 0;
    let completed = 0;
    let lastStarted = false;
    const observed = new Set<string>();
    const begin = (): void => {
      pending += 1;
      maximumPending = Math.max(maximumPending, pending);
    };
    fileSystem.lstat = async (path) => {
      if (!files.includes(path)) return lstat(path);
      begin();
      started += 1;
      observed.add(path);
      try {
        await firstMetadata.promise;
        return await lstat(path);
      } finally {
        pending -= 1;
      }
    };
    fileSystem.realpath = async (path) => {
      if (!files.includes(path)) return realpath(path);
      begin();
      try {
        if (path === files[7]) {
          lastStarted = true;
          await lastMetadata.promise;
        }
        return await realpath(path);
      } finally {
        pending -= 1;
        completed += 1;
      }
    };

    const starting = active.startMonitoring(new AbortController().signal);
    try {
      await waitForCondition(() => started === 4);
      expect(pending).toBe(4);
      firstMetadata.resolve();
      await waitForCondition(() => lastStarted && completed === 3);
      expect(started).toBe(4);
      expect(pending).toBe(1);
    } finally {
      firstMetadata.resolve();
      lastMetadata.resolve();
    }
    const monitor = await starting;
    expect(started).toBe(8);
    expect(observed.size).toBe(8);
    expect(maximumPending).toBe(4);
    expect(pending).toBe(0);
    await monitor.close();
    await active.release();
  });

  it("drains sibling I/O before releasing the queue and preserves unsafe errors over rename retries", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    const existing = attempt("a");
    fileSystem.addDirectory(existing);
    const later = win32.join(existing, "a-later");
    const transient = win32.join(existing, "b-transient");
    const unsafe = win32.join(existing, "c-unsafe");
    const held = [win32.join(existing, "d-held"), win32.join(existing, "e-held")];
    for (const file of [later, transient, unsafe, ...held]) fileSystem.addFile(file, 1n);
    fileSystem.missNextLstats(transient, 1);
    const gate = deferredVoid();
    const lstat = fileSystem.lstat.bind(fileSystem);
    const realpath = fileSystem.realpath.bind(fileSystem);
    let heldReads = 0;
    let unsafeReads = 0;
    let laterRead = false;
    fileSystem.lstat = async (path) => {
      if (path === later) laterRead = true;
      if (held.includes(path)) {
        heldReads += 1;
        await gate.promise;
      }
      return lstat(path);
    };
    fileSystem.realpath = async (path) => {
      if (path === unsafe && ++unsafeReads === 1) return "D:\\outside";
      return realpath(path);
    };
    let settled = false;
    const admission = budget.admit(attempt("b"));
    void admission.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let queued: Promise<boolean> | undefined;
    try {
      await waitForCondition(() => heldReads === 2 && unsafeReads === 1);
      const ownershipChecks = fileSystem.ownershipChecks;
      queued = budget.hasCapacity();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(fileSystem.ownershipChecks).toBe(ownershipChecks);
      expect(laterRead).toBe(false);
    } finally {
      gate.resolve();
    }
    await expect(admission).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
    await expect(queued).resolves.toBe(true);
    expect(heldReads).toBe(4);
  });

  it.each(["root", "attempt", "escape"] as const)(
    "preserves the %s safety check after concurrent metadata settles",
    async (unsafe) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const clock = new FakeWorkspaceDiskClock();
      const budget = createBudget(fileSystem, clock);
      const active = await budget.admit(attempt("a"));
      const activePath = active.attemptDirectory;
      fileSystem.addDirectory(activePath);
      const monitor = await active.startMonitoring(new AbortController().signal);
      const files = Array.from({ length: 4 }, (_, index) =>
        win32.join(activePath, `file-${index}`),
      );
      for (const file of files) fileSystem.addFile(file, 1n);
      const gate = deferredVoid();
      const lstat = fileSystem.lstat.bind(fileSystem);
      let started = 0;
      fileSystem.lstat = async (path) => {
        if (files.includes(path)) {
          started += 1;
          await gate.promise;
        }
        return lstat(path);
      };
      const checking = clock.tick();
      try {
        await waitForCondition(() => started === 4);
        if (unsafe === "root") fileSystem.changeIdentity(workspaceRoot);
        else if (unsafe === "attempt") fileSystem.changeIdentity(activePath);
        else fileSystem.setRealPath(files[0] as string, "D:\\outside");
      } finally {
        gate.resolve();
      }
      await checking;
      await expect(monitor.close()).rejects.toMatchObject({
        code: unsafe === "root" ? "WORKSPACE_ROOT_UNSAFE" : "WORKSPACE_PATH_UNSAFE",
      });
      await active.release();
    },
  );

  it.each(["deadline", "cancellation"] as const)(
    "drains started metadata after %s without changing its I/O deadline",
    async (interruption) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const clock = new FakeWorkspaceDiskClock();
      const budget = createBudget(fileSystem, clock);
      const existing = attempt("a");
      fileSystem.addDirectory(existing);
      const files = Array.from({ length: 4 }, (_, index) => win32.join(existing, `file-${index}`));
      for (const file of files) fileSystem.addFile(file, 1n);
      const gate = deferredVoid();
      const lstat = fileSystem.lstat.bind(fileSystem);
      const contexts: (WorkspaceDiskIoContext | undefined)[] = [];
      fileSystem.lstat = async (path, context?: WorkspaceDiskIoContext) => {
        if (files.includes(path)) {
          contexts.push(context);
          await gate.promise;
        }
        return lstat(path);
      };
      const controller = new AbortController();
      let settled = false;
      const admission = budget.admit(attempt("b"), controller.signal);
      void admission.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await waitForCondition(() => contexts.length === 4);
        if (interruption === "deadline") clock.advance(30_001);
        else controller.abort(new Error("The lease ended during metadata I/O."));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(contexts.map((context) => context?.deadlineEpochMilliseconds)).toEqual([
          40_000n,
          40_000n,
          40_000n,
          40_000n,
        ]);
        expect(contexts.every((context) => context?.signal === controller.signal)).toBe(true);
      } finally {
        gate.resolve();
      }
      await expect(admission).rejects.toMatchObject({
        code: interruption === "deadline" ? "ACCOUNTING_TIMED_OUT" : "ABORTED",
      });
    },
  );

  it.each(["stable", "identity", "reparse"] as const)(
    "does not expose children before their %s parent finishes validation",
    async (parentChange) => {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const budget = createBudget(fileSystem);
      const active = await budget.admit(attempt("a"));
      const activePath = active.attemptDirectory;
      const parent = win32.join(activePath, "parent");
      const child = win32.join(parent, "child.bin");
      fileSystem.addDirectory(activePath);
      fileSystem.addDirectory(parent);
      fileSystem.addFile(child, 1n);
      const gate = deferredVoid();
      const lstat = fileSystem.lstat.bind(fileSystem);
      let parentReads = 0;
      let childRead = false;
      fileSystem.lstat = async (path) => {
        if (path === parent && ++parentReads === 2) await gate.promise;
        if (path === child) childRead = true;
        return lstat(path);
      };
      const starting = active.startMonitoring(new AbortController().signal);
      try {
        await waitForCondition(() => parentReads === 2);
        expect(childRead).toBe(false);
        if (parentChange === "identity") fileSystem.changeIdentity(parent);
        if (parentChange === "reparse") fileSystem.setReparsePoint(parent);
      } finally {
        gate.resolve();
      }
      if (parentChange === "stable") {
        const monitor = await starting;
        expect(childRead).toBe(true);
        await monitor.close();
      } else {
        await expect(starting).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
        expect(childRead).toBe(false);
      }
      await active.release();
    },
  );

  it("uses the updated global entry allowance for sibling directories after parallel metadata", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem, undefined, { maximumAccountingEntries: 7 });
    const active = await budget.admit(attempt("a"));
    const activePath = active.attemptDirectory;
    fileSystem.addDirectory(activePath);
    const directories = [win32.join(activePath, "first"), win32.join(activePath, "second")];
    for (const directory of directories) {
      fileSystem.addDirectory(directory);
      for (let index = 0; index < 3; index += 1) {
        fileSystem.addFile(win32.join(directory, `file-${index}`), 1n);
      }
    }
    const listing = fileSystem.readDirectoryBounded.bind(fileSystem);
    const allowances: number[] = [];
    fileSystem.readDirectoryBounded = async (path, maximumEntries) => {
      if (directories.includes(path)) allowances.push(maximumEntries);
      return listing(path, maximumEntries);
    };

    await expect(active.startMonitoring(new AbortController().signal)).rejects.toMatchObject({
      code: "ACCOUNTING_LIMIT_EXCEEDED",
    });
    expect(allowances).toEqual([4, 1]);
    await active.release();
  });

  it("accumulates every parallel file sample at the exact byte and entry boundaries", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock, { maximumAccountingEntries: 9 });
    const active = await budget.admit(attempt("a"));
    const activePath = active.attemptDirectory;
    fileSystem.addDirectory(activePath);
    const files = Array.from({ length: 4 }, (_, index) => {
      const directory = win32.join(activePath, `directory-${index}`);
      fileSystem.addDirectory(directory);
      const file = win32.join(directory, "file.bin");
      fileSystem.addFile(file, 25n * mebibyte);
      return file;
    });
    const monitor = await active.startMonitoring(new AbortController().signal);
    expect(monitor.violation).toBeUndefined();
    fileSystem.setFileSize(files[0] as string, 25n * mebibyte + 1n);
    await clock.tick();

    await expect(monitor.close()).rejects.toMatchObject({
      code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED",
    });
    await active.release();
  });

  it("shares one bounded workspace scan across four monitor intervals", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock, { totalWorkspaceDiskBytes: 400n * mebibyte });
    const reservations = [];
    for (const name of ["a", "b", "c", "d"]) {
      const reservation = await budget.admit(attempt(name));
      fileSystem.addDirectory(reservation.attemptDirectory);
      reservations.push(reservation);
    }
    const monitors = await Promise.all(
      reservations.map((reservation) => reservation.startMonitoring(new AbortController().signal)),
    );
    let rootReads = 0;
    fileSystem.onReadDirectory = (path) => {
      if (key(path) !== key(workspaceRoot)) return;
      rootReads += 1;
      clock.advance(10_000);
    };

    await clock.tick();

    expect(rootReads).toBe(1);
    expect(monitors.every((monitor) => monitor.violation === undefined)).toBe(true);
    fileSystem.onReadDirectory = undefined;
    await Promise.all(monitors.map((monitor) => monitor.close()));
    await Promise.all(reservations.map((reservation) => reservation.release()));
  });

  it("applies each reservation's own quota verdict to the shared snapshot", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock);
    const first = await budget.admit(attempt("a"));
    const second = await budget.admit(attempt("b"));
    fileSystem.addDirectory(first.attemptDirectory);
    fileSystem.addDirectory(second.attemptDirectory);
    const monitors = await Promise.all(
      [first, second].map((reservation) =>
        reservation.startMonitoring(new AbortController().signal),
      ),
    );
    fileSystem.addFile(win32.join(first.attemptDirectory, "large.bin"), 101n * mebibyte);
    let rootReads = 0;
    fileSystem.onReadDirectory = (path) => {
      if (key(path) === key(workspaceRoot)) rootReads += 1;
    };

    await clock.tick();

    expect(rootReads).toBe(1);
    expect(monitors[0]?.violation).toMatchObject({ code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED" });
    expect(monitors[1]?.violation).toMatchObject({ code: "EXISTING_WORKSPACE_UNHEALTHY" });
    await Promise.allSettled(monitors.map((monitor) => monitor.close()));
    await first.release();
    await second.release();
  });

  it("cancels one shared-scan waiter without cancelling another reservation", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    const first = await budget.admit(attempt("a"));
    const second = await budget.admit(attempt("b"));
    fileSystem.addDirectory(first.attemptDirectory);
    fileSystem.addDirectory(second.attemptDirectory);
    const previousOwnershipChecks = fileSystem.ownershipChecks;
    let releaseOwnership!: () => void;
    fileSystem.ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    let rootReads = 0;
    fileSystem.onReadDirectory = (path) => {
      if (key(path) === key(workspaceRoot)) rootReads += 1;
    };
    const controller = new AbortController();
    const cancelled = first.startMonitoring(controller.signal);
    await waitForCondition(() => fileSystem.ownershipChecks > previousOwnershipChecks);
    const healthy = second.startMonitoring(new AbortController().signal);
    controller.abort(new Error("Only the first lease ended."));
    await expect(cancelled).rejects.toMatchObject({ code: "ABORTED" });
    releaseOwnership();

    const monitor = await healthy;
    expect(rootReads).toBe(1);
    expect(monitor.violation).toBeUndefined();
    await monitor.close();
    await first.release();
    await second.release();
  });

  it("starts a fresh final scan after an older shared scan already sampled the attempt", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const budget = createBudget(fileSystem);
    const first = await budget.admit(attempt("a"));
    const second = await budget.admit(attempt("b"));
    fileSystem.addDirectory(first.attemptDirectory);
    fileSystem.addDirectory(second.attemptDirectory);
    const output = win32.join(first.attemptDirectory, "output.bin");
    fileSystem.addFile(output, mebibyte);
    const firstMonitor = await first.startMonitoring(new AbortController().signal);
    const readDirectory = fileSystem.readDirectoryBounded.bind(fileSystem);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let paused = false;
    let rootReads = 0;
    fileSystem.readDirectoryBounded = async (path, maximumEntries) => {
      const result = await readDirectory(path, maximumEntries);
      if (key(path) === key(workspaceRoot)) rootReads += 1;
      if (!paused && key(path) === key(second.attemptDirectory)) {
        paused = true;
        await readGate;
      }
      return result;
    };
    const secondStart = second.startMonitoring(new AbortController().signal);
    await waitForCondition(() => paused);
    fileSystem.setFileSize(output, 101n * mebibyte);
    const closing = firstMonitor.close();
    const closeExpectation = expect(closing).rejects.toMatchObject({
      code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED",
    });
    releaseRead();

    const secondMonitor = await secondStart;
    await closeExpectation;
    expect(rootReads).toBe(2);
    await secondMonitor.close().catch(() => undefined);
    await first.release();
    await second.release();
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

  it("recovers mixed-format startup orphans in bounded batches before restoring full capacity", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const firstOrphan = attempt("a");
    const secondOrphan = compactAttempt("b");
    fileSystem.addDirectory(firstOrphan, clock.now - 500n);
    fileSystem.addFile(win32.join(firstOrphan, "interrupted.bin"), 1n);
    fileSystem.addDirectory(secondOrphan, clock.now - 500n);
    fileSystem.addFile(win32.join(secondOrphan, "interrupted.bin"), 2n);
    const budget = createBudget(fileSystem, clock, { orphanScanLimit: 1 });

    await expect(budget.recoverOrphans()).resolves.toEqual({
      scanned: 2,
      removed: 2,
      retained: 0,
      active: 0,
      removedBytes: 3n,
      limitReached: false,
    });
    expect(fileSystem.has(firstOrphan)).toBe(false);
    expect(fileSystem.has(secondOrphan)).toBe(false);
    const admitted = await Promise.all([
      budget.admit(attempt("c")),
      budget.admit(compactAttempt("d")),
    ]);
    expect(admitted).toHaveLength(2);
    await Promise.all(admitted.map((reservation) => reservation.release()));
  });

  it("refuses startup recovery after admission or loss of exclusive ownership", async () => {
    const activeFileSystem = new FakeWorkspaceDiskFileSystem();
    const activeBudget = createBudget(activeFileSystem);
    const active = await activeBudget.admit(attempt("a"));
    activeFileSystem.addDirectory(active.attemptDirectory);
    await expect(activeBudget.recoverOrphans()).rejects.toMatchObject({
      code: "EXCLUSIVE_WORKSPACE_OWNERSHIP_LOST",
    });
    expect(activeFileSystem.removed).toEqual([]);
    await active.release();

    const unowned = new FakeWorkspaceDiskFileSystem();
    unowned.addDirectory(attempt("b"));
    unowned.exclusiveOwnership = false;
    await expect(createBudget(unowned).recoverOrphans()).rejects.toMatchObject({
      code: "EXCLUSIVE_WORKSPACE_OWNERSHIP_LOST",
    });
    expect(unowned.removed).toEqual([]);
  });

  it("keeps startup recovery path checks strict for fresh orphans", async () => {
    for (const unsafe of ["reparse", "redirected"] as const) {
      const fileSystem = new FakeWorkspaceDiskFileSystem();
      const clock = new FakeWorkspaceDiskClock();
      const recent = attempt("a");
      fileSystem.addDirectory(recent, clock.now);
      if (unsafe === "reparse") fileSystem.setReparsePoint(recent);
      else fileSystem.setRealPath(recent, "D:\\outside");

      await expect(createBudget(fileSystem, clock).recoverOrphans()).rejects.toMatchObject({
        code: "WORKSPACE_PATH_UNSAFE",
      });
      expect(fileSystem.removed).toEqual([]);
      expect(fileSystem.has(recent)).toBe(true);
    }
  });

  it("applies the same orphan age and active reservation rules to both directory formats", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const clock = new FakeWorkspaceDiskClock();
    const budget = createBudget(fileSystem, clock);
    const active = await budget.admit(compactAttempt("c"));
    fileSystem.addDirectory(active.attemptDirectory, 0n);
    fileSystem.addFile(win32.join(active.attemptDirectory, "active.bin"), 1n);
    const staleLegacy = attempt("a");
    const staleCompact = compactAttempt("a");
    const recentLegacy = attempt("b");
    const recentCompact = compactAttempt("b");
    for (const [path, size] of [
      [staleLegacy, 11n],
      [staleCompact, 17n],
    ] as const) {
      fileSystem.addDirectory(path, 8_000n);
      fileSystem.addFile(win32.join(path, "result.bin"), size);
    }
    for (const path of [recentLegacy, recentCompact]) {
      fileSystem.addDirectory(path, 9_500n);
      fileSystem.addFile(win32.join(path, "result.bin"), 13n);
    }

    const result = await budget.sweepOrphans();

    expect(result).toEqual({
      scanned: 5,
      removed: 2,
      retained: 2,
      active: 1,
      removedBytes: 28n,
      limitReached: false,
    });
    expect(new Set(fileSystem.removed)).toEqual(new Set([staleLegacy, staleCompact]));
    expect(fileSystem.has(staleLegacy)).toBe(false);
    expect(fileSystem.has(staleCompact)).toBe(false);
    expect(fileSystem.has(recentLegacy)).toBe(true);
    expect(fileSystem.has(recentCompact)).toBe(true);
    expect(fileSystem.has(active.attemptDirectory)).toBe(true);
    expect(fileSystem.has(workspaceRoot)).toBe(true);
    await active.release();
  });

  it("refuses a replaced compact orphan identity without deleting either directory format", async () => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();
    const compact = compactAttempt("a");
    const legacy = attempt("b");
    for (const path of [compact, legacy]) {
      fileSystem.addDirectory(path, 0n);
      fileSystem.addFile(win32.join(path, "marker.txt"), 1n);
    }
    const removeAttempt = fileSystem.quarantineAndRemoveAttempt.bind(fileSystem);
    fileSystem.quarantineAndRemoveAttempt = async (request) => {
      expect(request.attemptDirectory).toBe(compact);
      fileSystem.changeIdentity(compact);
      return removeAttempt(request);
    };

    await expect(createBudget(fileSystem).sweepOrphans()).rejects.toMatchObject({
      code: "HANDLE_BOUND_DELETE_FAILED",
    });

    expect(fileSystem.removed).toEqual([]);
    for (const path of [compact, legacy]) {
      expect(fileSystem.has(win32.join(path, "marker.txt"))).toBe(true);
    }
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
    expect(isStrictAttemptDirectoryName(`a1-${"0".repeat(50)}`)).toBe(true);
    expect(isStrictAttemptDirectoryName(`a1-${"0".repeat(49)}1`)).toBe(true);
    expect(
      isStrictAttemptDirectoryName("a1-6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtof"),
    ).toBe(true);
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

  it.each([
    `a1-${"0".repeat(49)}`,
    `a1-${"0".repeat(51)}`,
    `a1-${"0".repeat(49)}A`,
    `A1-${"0".repeat(50)}`,
    `a2-${"0".repeat(50)}`,
    "a1-6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtog",
    `a1-${"z".repeat(50)}`,
    `a1-${"0".repeat(49)}_`,
    `a1-${"0".repeat(49)}-`,
    `a1-${"0".repeat(50)}-extra`,
  ])("rejects noncanonical compact names before disk admission: %s", async (name) => {
    const fileSystem = new FakeWorkspaceDiskFileSystem();

    expect(isStrictAttemptDirectoryName(name)).toBe(false);
    await expect(
      createBudget(fileSystem).admit(win32.join(workspaceRoot, name)),
    ).rejects.toMatchObject({ code: "INVALID_ATTEMPT_PATH" });
    expect(fileSystem.ownershipChecks).toBe(0);
    expect(fileSystem.removed).toEqual([]);
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
  for (const directory of ["temp", "control", "profile", "user-profile"]) {
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

function deferredVoid(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not observed before the test deadline.");
}
