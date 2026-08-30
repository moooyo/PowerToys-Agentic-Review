import {
  lstat as nodeLstat,
  opendir as nodeOpenDirectory,
  realpath as nodeRealpath,
  statfs as nodeStatFileSystem,
} from "node:fs/promises";
import { win32 } from "node:path";

const strictAttemptNamePattern = /^attempt-[a-f0-9]{64}$/u;
const defaultMonitorIntervalMs = 5_000;
const defaultMaximumAccountingEntries = 100_000;
const defaultMaximumScanDurationMs = 30_000;
const defaultMaximumSnapshotGenerations = 3;

export interface WorkspaceDiskPathState {
  readonly kind: "directory" | "file" | "other";
  readonly reparsePoint: boolean;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtMs: bigint;
  readonly changedAtMs: bigint;
}

export interface BoundedDirectoryEntries {
  readonly entries: readonly string[];
  readonly truncated: boolean;
}

export interface WorkspaceDiskIoContext {
  readonly signal?: AbortSignal;
  readonly deadlineEpochMilliseconds?: bigint;
}

export interface WorkspaceDiskFileSystem {
  lstat(path: string, context?: WorkspaceDiskIoContext): Promise<WorkspaceDiskPathState | null>;
  realpath(path: string, context?: WorkspaceDiskIoContext): Promise<string>;
  readDirectoryBounded(
    path: string,
    maximumEntries: number,
    context?: WorkspaceDiskIoContext,
  ): Promise<BoundedDirectoryEntries>;
  availableBytes(path: string, context?: WorkspaceDiskIoContext): Promise<bigint>;
}

export interface NativeWorkspaceSecurityAdapter extends WorkspaceDiskFileSystem {
  /**
   * Verifies that this adapter still owns the OS-enforced, process-lifetime exclusive lock for
   * the workspace root. Native filesystem operations must honor the supplied signal and deadline.
   */
  assertExclusiveOwnership(request: {
    readonly workspaceRootDirectory: string;
    readonly signal?: AbortSignal;
    readonly deadlineEpochMilliseconds: bigint;
  }): Promise<void>;
  /**
   * Quarantines the exact directory identity by handle and removes it without following reparse
   * points. Returning means both the quarantine name and original path are gone.
   */
  quarantineAndRemoveAttempt(request: {
    readonly workspaceRootDirectory: string;
    readonly workspaceRootDevice: bigint;
    readonly workspaceRootInode: bigint;
    readonly attemptDirectory: string;
    readonly attemptDevice: bigint;
    readonly attemptInode: bigint;
    readonly deadlineEpochMilliseconds: bigint;
  }): Promise<{ readonly removedBytes: bigint | null }>;
  /** Releases the process-lifetime exclusive lock during orderly Worker shutdown. */
  close(): Promise<void>;
}

export interface WorkspaceDiskInterval {
  cancel(): void;
}

export interface WorkspaceDiskClock {
  nowEpochMilliseconds(): bigint;
  scheduleInterval(
    callback: () => void | Promise<void>,
    intervalMilliseconds: number,
  ): WorkspaceDiskInterval;
  scheduleTimeout(callback: () => void, delayMilliseconds: number): WorkspaceDiskInterval;
}

export interface WorkspaceDiskMonitor {
  readonly signal: AbortSignal;
  readonly violation: WorkspaceDiskBudgetError | undefined;
  close(): Promise<void>;
}

export interface WorkspaceDiskReservation {
  readonly attemptDirectory: string;
  startMonitoring(parentSignal: AbortSignal): Promise<WorkspaceDiskMonitor>;
  removeAttempt(): Promise<void>;
  abandon(): void;
  release(): Promise<void>;
}

export interface WorkspaceDiskBudget {
  admit(attemptDirectory: string, signal?: AbortSignal): Promise<WorkspaceDiskReservation>;
}

export interface WorkspaceOrphanSweepResult {
  readonly scanned: number;
  readonly removed: number;
  readonly retained: number;
  readonly active: number;
  readonly removedBytes: bigint | null;
  readonly limitReached: boolean;
}

export interface ProductionWorkspaceDiskBudgetOptions {
  readonly workspaceRootDirectory: string;
  readonly perAttemptDiskBytes: bigint;
  readonly totalWorkspaceDiskBytes: bigint;
  readonly minimumFreeDiskBytes: bigint;
  readonly orphanRetentionMilliseconds: bigint;
  readonly orphanScanLimit: number;
  readonly monitorIntervalMilliseconds?: number;
  readonly maximumAccountingEntries?: number;
  readonly maximumScanDurationMilliseconds?: number;
  readonly maximumSnapshotGenerations?: number;
  readonly fileSystem?: WorkspaceDiskFileSystem;
  readonly clock?: WorkspaceDiskClock;
  readonly securityAdapter?: NativeWorkspaceSecurityAdapter;
}

export type WorkspaceDiskBudgetFailureCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_ATTEMPT_PATH"
  | "WORKSPACE_ROOT_UNSAFE"
  | "WORKSPACE_PATH_UNSAFE"
  | "ATTEMPT_ALREADY_EXISTS"
  | "ACCOUNTING_LIMIT_EXCEEDED"
  | "ACCOUNTING_TIMED_OUT"
  | "ACCOUNTING_FAILED"
  | "CURRENT_ATTEMPT_LIMIT_EXCEEDED"
  | "EXISTING_WORKSPACE_UNHEALTHY"
  | "SNAPSHOT_UNSTABLE"
  | "INSUFFICIENT_FREE_SPACE"
  | "RESERVATION_RELEASED"
  | "ORPHAN_DELETE_FAILED"
  | "NATIVE_SECURITY_ADAPTER_REQUIRED"
  | "NATIVE_SECURITY_ADAPTER_FAILED"
  | "EXCLUSIVE_WORKSPACE_OWNERSHIP_LOST"
  | "HANDLE_BOUND_DELETE_FAILED"
  | "ABORTED";

export class WorkspaceDiskBudgetError extends Error {
  public constructor(
    public readonly code: WorkspaceDiskBudgetFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceDiskBudgetError";
  }
}

/**
 * Non-production fallback for diagnostics and deterministic adapters. Node filesystem promises
 * cannot guarantee cancellation of a blocked Windows I/O request.
 */
export class NodeWorkspaceDiskFileSystem implements WorkspaceDiskFileSystem {
  public async lstat(
    path: string,
    _context?: WorkspaceDiskIoContext,
  ): Promise<WorkspaceDiskPathState | null> {
    try {
      const stats = await nodeLstat(path, { bigint: true });
      const reparseAwareStats = stats as typeof stats & {
        isReparsePoint?(): boolean;
      };
      return {
        kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        reparsePoint: stats.isSymbolicLink() || reparseAwareStats.isReparsePoint?.() === true,
        device: stats.dev,
        inode: stats.ino,
        size: stats.size,
        modifiedAtMs: stats.mtimeMs,
        changedAtMs: stats.ctimeMs,
      };
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  public realpath(path: string, _context?: WorkspaceDiskIoContext): Promise<string> {
    return nodeRealpath(path);
  }

  public async readDirectoryBounded(
    path: string,
    maximumEntries: number,
    _context?: WorkspaceDiskIoContext,
  ): Promise<BoundedDirectoryEntries> {
    assertPositiveSafeInteger(maximumEntries, "maximumEntries");
    const directory = await nodeOpenDirectory(path);
    const entries: string[] = [];
    let truncated = false;
    let primaryError: unknown;
    try {
      while (entries.length <= maximumEntries) {
        const entry = await directory.read();
        if (entry === null) break;
        if (entries.length === maximumEntries) {
          truncated = true;
          break;
        }
        entries.push(entry.name);
      }
    } catch (error) {
      primaryError = error;
    }
    try {
      await directory.close();
    } catch (error) {
      if (!hasErrorCode(error, "ERR_DIR_CLOSED")) primaryError ??= error;
    }
    if (primaryError !== undefined) throw primaryError;
    return { entries, truncated };
  }

  public async availableBytes(path: string, _context?: WorkspaceDiskIoContext): Promise<bigint> {
    const stats = await nodeStatFileSystem(path, { bigint: true });
    return stats.bavail * stats.bsize;
  }
}

export class ProductionWorkspaceDiskClock implements WorkspaceDiskClock {
  public nowEpochMilliseconds(): bigint {
    return BigInt(Date.now());
  }

  public scheduleInterval(
    callback: () => void | Promise<void>,
    intervalMilliseconds: number,
  ): WorkspaceDiskInterval {
    const timer = setInterval(() => void callback(), intervalMilliseconds);
    timer.unref();
    return { cancel: () => clearInterval(timer) };
  }

  public scheduleTimeout(callback: () => void, delayMilliseconds: number): WorkspaceDiskInterval {
    const timer = setTimeout(callback, delayMilliseconds);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  }
}

interface WorkspaceSnapshot {
  readonly totalBytes: bigint;
  readonly attemptBytes: ReadonlyMap<string, bigint>;
}

interface ReservationRecord {
  readonly identity: symbol;
  readonly attemptName: string;
  readonly attemptDirectory: string;
}

interface EntryCounter {
  value: number;
}

/**
 * This guard limits accidental and authorized workload growth inside one Worker process. It does
 * not replace a dedicated volume, an NTFS quota, or an operating-system storage boundary. Logical
 * file sizes cannot attribute NTFS alternate streams, allocation slack, or filesystem metadata to
 * one attempt; the free-space floor is only a secondary backstop for those cases.
 */
export class ProductionWorkspaceDiskBudget implements WorkspaceDiskBudget {
  readonly #workspaceRootDirectory: string;
  readonly #perAttemptDiskBytes: bigint;
  readonly #totalWorkspaceDiskBytes: bigint;
  readonly #minimumFreeDiskBytes: bigint;
  readonly #orphanRetentionMilliseconds: bigint;
  readonly #orphanScanLimit: number;
  readonly #monitorIntervalMilliseconds: number;
  readonly #maximumAccountingEntries: number;
  readonly #maximumScanDurationMilliseconds: number;
  readonly #maximumSnapshotGenerations: number;
  readonly #fileSystem: WorkspaceDiskFileSystem;
  readonly #securityAdapter: NativeWorkspaceSecurityAdapter | undefined;
  readonly #clock: WorkspaceDiskClock;
  readonly #reservations = new Map<string, ReservationRecord>();
  #exclusiveTail: Promise<void> = Promise.resolve();

  public constructor(options: ProductionWorkspaceDiskBudgetOptions) {
    try {
      this.#workspaceRootDirectory = normalizeWorkspaceRoot(options.workspaceRootDirectory);
      this.#perAttemptDiskBytes = assertPositiveBigInt(
        options.perAttemptDiskBytes,
        "perAttemptDiskBytes",
      );
      this.#totalWorkspaceDiskBytes = assertPositiveBigInt(
        options.totalWorkspaceDiskBytes,
        "totalWorkspaceDiskBytes",
      );
      this.#minimumFreeDiskBytes = assertNonNegativeBigInt(
        options.minimumFreeDiskBytes,
        "minimumFreeDiskBytes",
      );
      this.#orphanRetentionMilliseconds = assertPositiveBigInt(
        options.orphanRetentionMilliseconds,
        "orphanRetentionMilliseconds",
      );
      this.#orphanScanLimit = assertBoundedSafeInteger(
        options.orphanScanLimit,
        "orphanScanLimit",
        1,
        10_000,
      );
      this.#monitorIntervalMilliseconds = assertBoundedSafeInteger(
        options.monitorIntervalMilliseconds ?? defaultMonitorIntervalMs,
        "monitorIntervalMilliseconds",
        100,
        60_000,
      );
      this.#maximumAccountingEntries = assertBoundedSafeInteger(
        options.maximumAccountingEntries ?? defaultMaximumAccountingEntries,
        "maximumAccountingEntries",
        1,
        1_000_000,
      );
      this.#maximumScanDurationMilliseconds = assertBoundedSafeInteger(
        options.maximumScanDurationMilliseconds ?? defaultMaximumScanDurationMs,
        "maximumScanDurationMilliseconds",
        100,
        300_000,
      );
      this.#maximumSnapshotGenerations = assertBoundedSafeInteger(
        options.maximumSnapshotGenerations ?? defaultMaximumSnapshotGenerations,
        "maximumSnapshotGenerations",
        1,
        5,
      );
      if (this.#perAttemptDiskBytes > this.#totalWorkspaceDiskBytes) {
        throw new RangeError("perAttemptDiskBytes must not exceed totalWorkspaceDiskBytes.");
      }
    } catch (error) {
      throw new WorkspaceDiskBudgetError(
        "INVALID_CONFIGURATION",
        "Workspace disk budget configuration is invalid.",
        { cause: error },
      );
    }
    if (options.securityAdapter !== undefined && options.fileSystem !== undefined) {
      throw new WorkspaceDiskBudgetError(
        "INVALID_CONFIGURATION",
        "Configure either a native workspace security adapter or a test filesystem, not both.",
      );
    }
    this.#securityAdapter = options.securityAdapter;
    this.#fileSystem =
      options.securityAdapter ?? options.fileSystem ?? new NodeWorkspaceDiskFileSystem();
    this.#clock = options.clock ?? new ProductionWorkspaceDiskClock();
  }

  public async admit(
    attemptDirectory: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiskReservation> {
    const attempt = this.#parseAttemptDirectory(attemptDirectory);
    const deadline = this.#newScanDeadline();
    return this.#runExclusive(
      async () => {
        throwIfAborted(signal);
        await this.#assertNativeSecurityReady(signal, deadline);
        if (this.#reservations.has(attempt.name)) {
          throw new WorkspaceDiskBudgetError(
            "ATTEMPT_ALREADY_EXISTS",
            "The attempt already has an active disk reservation.",
          );
        }

        const snapshot = await this.#readSnapshot("admission", signal, deadline);
        throwIfAborted(signal);
        if (snapshot.attemptBytes.has(attempt.name)) {
          throw new WorkspaceDiskBudgetError(
            "ATTEMPT_ALREADY_EXISTS",
            "The attempt directory already exists on disk.",
          );
        }
        this.#assertExistingAttemptsWithinLimit(snapshot);

        const reservedHeadroom = this.#reservedHeadroom(snapshot);
        const projectedTotal = snapshot.totalBytes + reservedHeadroom + this.#perAttemptDiskBytes;
        if (projectedTotal > this.#totalWorkspaceDiskBytes) {
          throw new WorkspaceDiskBudgetError(
            "EXISTING_WORKSPACE_UNHEALTHY",
            "The workspace does not have enough unreserved budget for another attempt.",
          );
        }

        const availableBytes = await this.#readAvailableBytes(signal, deadline);
        const requiredAvailable =
          this.#minimumFreeDiskBytes + reservedHeadroom + this.#perAttemptDiskBytes;
        if (availableBytes < requiredAvailable) {
          throw new WorkspaceDiskBudgetError(
            "INSUFFICIENT_FREE_SPACE",
            "The workspace volume cannot preserve its minimum free-space reserve.",
          );
        }
        throwIfAborted(signal);

        const record: ReservationRecord = {
          identity: Symbol(attempt.name),
          attemptName: attempt.name,
          attemptDirectory: attempt.path,
        };
        this.#reservations.set(record.attemptName, record);
        return new ProductionWorkspaceDiskReservation(this, record);
      },
      signal,
      deadline,
    );
  }

  /**
   * Run during startup before job claims begin. Node path deletion is not a substitute for
   * service-owned ACLs or native handle-bound deletion against a concurrent same-token writer.
   */
  public async sweepOrphans(): Promise<WorkspaceOrphanSweepResult> {
    const sweepDeadline = this.#newScanDeadline();
    return this.#runExclusive(
      async () => {
        try {
          await this.#assertNativeSecurityReady(undefined, sweepDeadline);
          let rootState = await this.#validateRoot(undefined, undefined, sweepDeadline);
          const listing = await this.#fileSystem.readDirectoryBounded(
            this.#workspaceRootDirectory,
            this.#orphanScanLimit,
            ioContext(undefined, sweepDeadline),
          );
          this.#assertScanActive(undefined, sweepDeadline);
          assertUniqueSafeEntryNames(listing.entries);

          let removed = 0;
          let retained = 0;
          let active = 0;
          let removedBytes: bigint | null = 0n;
          const now = this.#clock.nowEpochMilliseconds();
          if (now < 0n) {
            throw new WorkspaceDiskBudgetError(
              "ACCOUNTING_FAILED",
              "The workspace cleanup clock returned a negative timestamp.",
            );
          }

          for (const name of listing.entries) {
            this.#assertScanActive(undefined, sweepDeadline);
            if (!isStrictAttemptDirectoryName(name)) {
              throw new WorkspaceDiskBudgetError(
                "WORKSPACE_PATH_UNSAFE",
                "Workspace root contains an entry that is not a recognized attempt directory.",
              );
            }
            const candidate = win32.join(this.#workspaceRootDirectory, name);
            this.#assertAttemptPath(candidate, name);
            if (this.#reservations.has(name)) {
              active += 1;
              continue;
            }

            const state = await this.#validatedPathState(
              candidate,
              "directory",
              undefined,
              sweepDeadline,
            );
            if (state === null) continue;
            const age = now - state.modifiedAtMs;
            if (age < this.#orphanRetentionMilliseconds) {
              retained += 1;
              continue;
            }

            await this.#validateRoot(rootState, undefined, sweepDeadline);
            const finalState = await this.#validatedPathState(
              candidate,
              "directory",
              undefined,
              sweepDeadline,
            );
            if (finalState === null || !sameStablePathState(state, finalState)) {
              throw new WorkspaceDiskBudgetError(
                "WORKSPACE_PATH_UNSAFE",
                "An orphan attempt changed identity or timestamps before deletion.",
              );
            }
            const removal = await this.#quarantineAndRemoveAttempt(
              candidate,
              rootState,
              finalState,
              sweepDeadline,
            );
            if (
              (await this.#fileSystem.lstat(candidate, ioContext(undefined, sweepDeadline))) !==
              null
            ) {
              throw new WorkspaceDiskBudgetError(
                "ORPHAN_DELETE_FAILED",
                "An orphan attempt directory still exists after removal.",
              );
            }
            rootState = await this.#validateRoot(undefined, undefined, sweepDeadline);
            removed += 1;
            removedBytes =
              removedBytes === null || removal.removedBytes === null
                ? null
                : removedBytes + removal.removedBytes;
          }

          return {
            scanned: listing.entries.length,
            removed,
            retained,
            active,
            removedBytes,
            limitReached: listing.truncated,
          };
        } catch (error) {
          if (error instanceof WorkspaceDiskBudgetError) throw error;
          throw new WorkspaceDiskBudgetError(
            "ACCOUNTING_FAILED",
            "Workspace orphan cleanup failed closed.",
            { cause: error },
          );
        }
      },
      undefined,
      sweepDeadline,
    );
  }

  public async startMonitoring(
    record: ReservationRecord,
    parentSignal: AbortSignal,
  ): Promise<WorkspaceDiskMonitor> {
    const monitor = new ProductionWorkspaceDiskMonitor(
      this,
      record,
      parentSignal,
      this.#clock,
      this.#monitorIntervalMilliseconds,
    );
    await monitor.start();
    return monitor;
  }

  public async release(record: ReservationRecord): Promise<void> {
    const deadline = this.#newScanDeadline();
    await this.#runExclusive(
      async () => {
        const current = this.#reservations.get(record.attemptName);
        if (current?.identity === record.identity) {
          this.#reservations.delete(record.attemptName);
        }
      },
      undefined,
      deadline,
    );
  }

  public async removeAttempt(record: ReservationRecord): Promise<void> {
    const deadline = this.#newScanDeadline();
    await this.#runExclusive(
      async () => {
        const current = this.#reservations.get(record.attemptName);
        if (current?.identity !== record.identity) {
          throw new WorkspaceDiskBudgetError(
            "RESERVATION_RELEASED",
            "Cannot remove an attempt after its disk reservation was released.",
          );
        }
        await this.#assertNativeSecurityReady(undefined, deadline);
        const rootState = await this.#validateRoot(undefined, undefined, deadline);
        const attemptState = await this.#validatedPathState(
          record.attemptDirectory,
          "directory",
          undefined,
          deadline,
        );
        if (attemptState === null) return;

        const finalState = await this.#validatedPathState(
          record.attemptDirectory,
          "directory",
          undefined,
          deadline,
        );
        if (finalState === null || !sameStablePathState(attemptState, finalState)) {
          throw snapshotUnstableError();
        }
        await this.#quarantineAndRemoveAttempt(
          record.attemptDirectory,
          rootState,
          finalState,
          deadline,
        );
        if (
          (await this.#fileSystem.lstat(
            record.attemptDirectory,
            ioContext(undefined, deadline),
          )) !== null
        ) {
          throw new WorkspaceDiskBudgetError(
            "HANDLE_BOUND_DELETE_FAILED",
            "The attempt path still exists after native quarantine removal.",
          );
        }
      },
      undefined,
      deadline,
    );
  }

  public abandon(record: ReservationRecord): void {
    const current = this.#reservations.get(record.attemptName);
    if (current?.identity === record.identity) {
      this.#reservations.delete(record.attemptName);
    }
  }

  public async assertHealthy(record: ReservationRecord, signal?: AbortSignal): Promise<void> {
    await this.#assertReservationHealthy(record, signal);
  }

  async #assertReservationHealthy(record: ReservationRecord, signal?: AbortSignal): Promise<void> {
    const deadline = this.#newScanDeadline();
    await this.#runExclusive(
      async () => {
        throwIfAborted(signal);
        await this.#assertNativeSecurityReady(signal, deadline);
        const current = this.#reservations.get(record.attemptName);
        if (current?.identity !== record.identity) {
          throw new WorkspaceDiskBudgetError(
            "RESERVATION_RELEASED",
            "The workspace disk reservation is no longer active.",
          );
        }
        const snapshot = await this.#readSnapshot("monitoring", signal, deadline);
        const attemptBytes = snapshot.attemptBytes.get(record.attemptName);
        if (attemptBytes === undefined) {
          throw new WorkspaceDiskBudgetError(
            "WORKSPACE_PATH_UNSAFE",
            "The monitored attempt directory is missing.",
          );
        }
        if (attemptBytes > this.#perAttemptDiskBytes) {
          throw new WorkspaceDiskBudgetError(
            "CURRENT_ATTEMPT_LIMIT_EXCEEDED",
            "The attempt exceeded its workspace disk budget.",
          );
        }
        this.#assertExistingAttemptsWithinLimit(snapshot, record.attemptName);
        const reservedHeadroom = this.#reservedHeadroom(snapshot, record.attemptName);
        if (snapshot.totalBytes + reservedHeadroom > this.#totalWorkspaceDiskBytes) {
          throw new WorkspaceDiskBudgetError(
            "EXISTING_WORKSPACE_UNHEALTHY",
            "The Worker workspace can no longer honor its active disk reservations.",
          );
        }
        if (
          (await this.#readAvailableBytes(signal, deadline)) <
          this.#minimumFreeDiskBytes + reservedHeadroom
        ) {
          throw new WorkspaceDiskBudgetError(
            "INSUFFICIENT_FREE_SPACE",
            "The workspace volume fell below its minimum free-space reserve.",
          );
        }
      },
      signal,
      deadline,
    );
  }

  async #readSnapshot(
    operation: string,
    signal: AbortSignal | undefined,
    deadline: bigint,
  ): Promise<WorkspaceSnapshot> {
    let lastUnstableError: WorkspaceDiskBudgetError | undefined;
    for (let generation = 1; generation <= this.#maximumSnapshotGenerations; generation += 1) {
      try {
        return await this.#readSnapshotGeneration(operation, signal, deadline);
      } catch (error) {
        if (
          error instanceof WorkspaceDiskBudgetError &&
          error.code === "SNAPSHOT_UNSTABLE" &&
          generation < this.#maximumSnapshotGenerations
        ) {
          lastUnstableError = error;
          this.#assertScanActive(signal, deadline);
          await yieldToEventLoop();
          continue;
        }
        throw error;
      }
    }
    throw (
      lastUnstableError ??
      new WorkspaceDiskBudgetError(
        "SNAPSHOT_UNSTABLE",
        `Workspace disk ${operation} snapshot did not stabilize.`,
      )
    );
  }

  async #readSnapshotGeneration(
    operation: string,
    signal: AbortSignal | undefined,
    deadline: bigint,
  ): Promise<WorkspaceSnapshot> {
    try {
      this.#assertScanActive(signal, deadline);
      const rootState = await this.#validateRoot(undefined, signal, deadline);
      const counter: EntryCounter = { value: 0 };
      const listing = await this.#fileSystem.readDirectoryBounded(
        this.#workspaceRootDirectory,
        this.#maximumAccountingEntries,
        ioContext(signal, deadline),
      );
      if (listing.truncated) {
        throw accountingLimitError();
      }
      assertUniqueSafeEntryNames(listing.entries);

      let totalBytes = 0n;
      const attemptBytes = new Map<string, bigint>();
      for (const name of listing.entries) {
        this.#assertScanActive(signal, deadline);
        if (!isStrictAttemptDirectoryName(name)) {
          throw new WorkspaceDiskBudgetError(
            "WORKSPACE_PATH_UNSAFE",
            "Workspace root contains an entry that is not a recognized attempt directory.",
          );
        }
        const attemptDirectory = win32.join(this.#workspaceRootDirectory, name);
        this.#assertAttemptPath(attemptDirectory, name);
        const bytes = await this.#scanAttempt(attemptDirectory, counter, signal, deadline);
        attemptBytes.set(name, bytes);
        totalBytes += bytes;
      }
      await this.#validateRoot(rootState, signal, deadline);
      return { totalBytes, attemptBytes };
    } catch (error) {
      if (error instanceof WorkspaceDiskBudgetError) throw error;
      throw new WorkspaceDiskBudgetError(
        "ACCOUNTING_FAILED",
        `Workspace disk ${operation} accounting failed closed.`,
        { cause: error },
      );
    }
  }

  async #scanAttempt(
    attemptDirectory: string,
    counter: EntryCounter,
    signal?: AbortSignal,
    deadline = this.#newScanDeadline(),
  ): Promise<bigint> {
    const stack = [attemptDirectory];
    counter.value += 1;
    if (counter.value > this.#maximumAccountingEntries) throw accountingLimitError();
    let bytes = 0n;
    let attemptRootState: WorkspaceDiskPathState | undefined;
    while (stack.length > 0) {
      this.#assertScanActive(signal, deadline);
      const candidate = stack.pop();
      if (candidate === undefined) break;
      this.#assertContained(candidate);
      const state = await this.#validatedPathState(candidate, undefined, signal, deadline);
      if (state === null) {
        throw snapshotUnstableError();
      }
      if (state.kind === "file") {
        if (state.size < 0n) {
          throw new WorkspaceDiskBudgetError(
            "ACCOUNTING_FAILED",
            "A workspace file reported a negative size.",
          );
        }
        bytes += state.size;
        continue;
      }
      if (state.kind !== "directory") {
        throw new WorkspaceDiskBudgetError(
          "WORKSPACE_PATH_UNSAFE",
          "Workspace accounting encountered a non-file, non-directory entry.",
        );
      }
      if (sameWindowsPath(candidate, attemptDirectory)) attemptRootState = state;

      const remaining = this.#maximumAccountingEntries - counter.value;
      let listing: BoundedDirectoryEntries;
      try {
        listing = await this.#fileSystem.readDirectoryBounded(
          candidate,
          Math.max(1, remaining),
          ioContext(signal, deadline),
        );
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) throw snapshotUnstableError(error);
        throw error;
      }
      this.#assertScanActive(signal, deadline);
      if (listing.truncated || (remaining === 0 && listing.entries.length > 0)) {
        throw accountingLimitError();
      }
      assertUniqueSafeEntryNames(listing.entries);
      if (counter.value + listing.entries.length > this.#maximumAccountingEntries) {
        throw accountingLimitError();
      }
      counter.value += listing.entries.length;
      for (const name of listing.entries) {
        stack.push(win32.join(candidate, name));
      }
      const directoryAfterListing = await this.#validatedPathState(
        candidate,
        "directory",
        signal,
        deadline,
      );
      if (directoryAfterListing === null || !sameStablePathState(state, directoryAfterListing)) {
        throw snapshotUnstableError();
      }
    }
    const attemptRootAfterScan = await this.#validatedPathState(
      attemptDirectory,
      "directory",
      signal,
      deadline,
    );
    if (
      attemptRootState === undefined ||
      attemptRootAfterScan === null ||
      !sameStablePathState(attemptRootState, attemptRootAfterScan)
    ) {
      throw snapshotUnstableError();
    }
    return bytes;
  }

  async #validateRoot(
    expected?: WorkspaceDiskPathState,
    signal?: AbortSignal,
    deadline?: bigint,
  ): Promise<WorkspaceDiskPathState> {
    this.#assertScanActive(signal, deadline);
    const state = await this.#fileSystem.lstat(
      this.#workspaceRootDirectory,
      ioContext(signal, deadline),
    );
    if (state === null || state.kind !== "directory" || state.reparsePoint) {
      throw new WorkspaceDiskBudgetError(
        "WORKSPACE_ROOT_UNSAFE",
        "Workspace root must be an existing non-reparse directory.",
      );
    }
    const realPath = normalizeDirectory(
      await this.#fileSystem.realpath(this.#workspaceRootDirectory, ioContext(signal, deadline)),
    );
    this.#assertScanActive(signal, deadline);
    if (!sameWindowsPath(realPath, this.#workspaceRootDirectory)) {
      throw new WorkspaceDiskBudgetError(
        "WORKSPACE_ROOT_UNSAFE",
        "Workspace root realpath differs from its configured path.",
      );
    }
    assertValidPathState(state);
    if (expected !== undefined && !samePathIdentity(expected, state)) {
      throw new WorkspaceDiskBudgetError(
        "WORKSPACE_ROOT_UNSAFE",
        "Workspace root identity changed during disk accounting.",
      );
    }
    return state;
  }

  async #validatedPathState(
    path: string,
    requiredKind?: "directory" | "file",
    signal?: AbortSignal,
    deadline?: bigint,
  ): Promise<WorkspaceDiskPathState | null> {
    this.#assertScanActive(signal, deadline);
    this.#assertContained(path);
    const state = await this.#fileSystem.lstat(path, ioContext(signal, deadline));
    if (state === null) return null;
    if (state.reparsePoint || (requiredKind !== undefined && state.kind !== requiredKind)) {
      throw new WorkspaceDiskBudgetError(
        "WORKSPACE_PATH_UNSAFE",
        "Workspace path is a reparse point or has an unexpected type.",
      );
    }
    assertValidPathState(state);
    let realPath: string;
    try {
      realPath = normalizeDirectory(
        await this.#fileSystem.realpath(path, ioContext(signal, deadline)),
      );
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) throw snapshotUnstableError(error);
      throw error;
    }
    this.#assertScanActive(signal, deadline);
    if (!sameWindowsPath(realPath, path)) {
      throw new WorkspaceDiskBudgetError(
        "WORKSPACE_PATH_UNSAFE",
        "Workspace path resolves through a reparse point or outside its expected location.",
      );
    }
    this.#assertContained(realPath);
    return state;
  }

  async #readAvailableBytes(
    signal?: AbortSignal,
    deadline = this.#newScanDeadline(),
  ): Promise<bigint> {
    try {
      this.#assertScanActive(signal, deadline);
      const available = await this.#fileSystem.availableBytes(
        this.#workspaceRootDirectory,
        ioContext(signal, deadline),
      );
      this.#assertScanActive(signal, deadline);
      if (available < 0n) throw new RangeError("Available disk bytes cannot be negative.");
      return available;
    } catch (error) {
      if (error instanceof WorkspaceDiskBudgetError) throw error;
      throw new WorkspaceDiskBudgetError(
        "ACCOUNTING_FAILED",
        "The workspace volume free space could not be measured.",
        { cause: error },
      );
    }
  }

  #assertExistingAttemptsWithinLimit(
    snapshot: WorkspaceSnapshot,
    currentAttemptName?: string,
  ): void {
    for (const [name, bytes] of snapshot.attemptBytes) {
      if (name === currentAttemptName) continue;
      if (bytes > this.#perAttemptDiskBytes) {
        throw new WorkspaceDiskBudgetError(
          "EXISTING_WORKSPACE_UNHEALTHY",
          "An existing attempt exceeds the configured per-attempt disk budget.",
        );
      }
    }
  }

  #reservedHeadroom(snapshot: WorkspaceSnapshot, currentAttemptName?: string): bigint {
    let headroom = 0n;
    for (const name of this.#reservations.keys()) {
      const existingBytes = snapshot.attemptBytes.get(name) ?? 0n;
      if (existingBytes > this.#perAttemptDiskBytes) {
        throw new WorkspaceDiskBudgetError(
          name === currentAttemptName
            ? "CURRENT_ATTEMPT_LIMIT_EXCEEDED"
            : "EXISTING_WORKSPACE_UNHEALTHY",
          name === currentAttemptName
            ? "The current attempt exceeds the configured per-attempt disk budget."
            : "Another active attempt exceeds the configured per-attempt disk budget.",
        );
      }
      headroom += this.#perAttemptDiskBytes - existingBytes;
    }
    return headroom;
  }

  #parseAttemptDirectory(attemptDirectory: string): {
    readonly name: string;
    readonly path: string;
  } {
    try {
      const normalized = normalizeLocalWindowsPath(attemptDirectory, "attemptDirectory");
      const name = win32.basename(normalized);
      if (!isStrictAttemptDirectoryName(name)) {
        throw new TypeError("attemptDirectory must use the strict attempt hash name.");
      }
      this.#assertAttemptPath(normalized, name);
      return { name, path: normalized };
    } catch (error) {
      throw new WorkspaceDiskBudgetError(
        "INVALID_ATTEMPT_PATH",
        "Workspace disk admission received an invalid attempt path.",
        { cause: error },
      );
    }
  }

  #assertAttemptPath(path: string, expectedName: string): void {
    this.#assertContained(path);
    if (
      !sameWindowsPath(win32.dirname(path), this.#workspaceRootDirectory) ||
      win32.basename(path) !== expectedName
    ) {
      throw new WorkspaceDiskBudgetError(
        "INVALID_ATTEMPT_PATH",
        "Attempt path must be a direct child of the workspace root.",
      );
    }
  }

  #assertContained(path: string): void {
    const relative = win32.relative(this.#workspaceRootDirectory, normalizeDirectory(path));
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${win32.sep}`) ||
      win32.isAbsolute(relative)
    ) {
      throw new WorkspaceDiskBudgetError(
        "WORKSPACE_PATH_UNSAFE",
        "Workspace path escapes the configured workspace root.",
      );
    }
  }

  async #assertNativeSecurityReady(
    signal?: AbortSignal,
    deadline = this.#newScanDeadline(),
  ): Promise<NativeWorkspaceSecurityAdapter> {
    const adapter = this.#securityAdapter;
    if (adapter === undefined) {
      throw new WorkspaceDiskBudgetError(
        "NATIVE_SECURITY_ADAPTER_REQUIRED",
        "Production workspace operations require the native workspace security adapter.",
      );
    }
    this.#assertScanActive(signal, deadline);
    try {
      await adapter.assertExclusiveOwnership({
        workspaceRootDirectory: this.#workspaceRootDirectory,
        ...(signal === undefined ? {} : { signal }),
        deadlineEpochMilliseconds: deadline,
      });
    } catch (error) {
      if (error instanceof WorkspaceDiskBudgetError) throw error;
      throw new WorkspaceDiskBudgetError(
        "NATIVE_SECURITY_ADAPTER_FAILED",
        "The native workspace security adapter could not verify exclusive ownership.",
        { cause: error },
      );
    }
    this.#assertScanActive(signal, deadline);
    return adapter;
  }

  async #quarantineAndRemoveAttempt(
    attemptDirectory: string,
    rootState: WorkspaceDiskPathState,
    attemptState: WorkspaceDiskPathState,
    deadline: bigint,
  ): Promise<{ readonly removedBytes: bigint | null }> {
    const adapter = await this.#assertNativeSecurityReady(undefined, deadline);
    try {
      const result = await adapter.quarantineAndRemoveAttempt({
        workspaceRootDirectory: this.#workspaceRootDirectory,
        workspaceRootDevice: rootState.device,
        workspaceRootInode: rootState.inode,
        attemptDirectory,
        attemptDevice: attemptState.device,
        attemptInode: attemptState.inode,
        deadlineEpochMilliseconds: deadline,
      });
      if (result.removedBytes !== null && result.removedBytes < 0n) {
        throw new WorkspaceDiskBudgetError(
          "HANDLE_BOUND_DELETE_FAILED",
          "The native adapter returned an invalid removed-byte count.",
        );
      }
      this.#assertScanActive(undefined, deadline);
      return result;
    } catch (error) {
      if (error instanceof WorkspaceDiskBudgetError) throw error;
      throw new WorkspaceDiskBudgetError(
        "HANDLE_BOUND_DELETE_FAILED",
        "The native adapter could not quarantine and remove the exact attempt identity.",
        { cause: error },
      );
    }
  }

  #newScanDeadline(): bigint {
    const now = this.#clock.nowEpochMilliseconds();
    if (now < 0n) {
      throw new WorkspaceDiskBudgetError(
        "ACCOUNTING_FAILED",
        "The workspace accounting clock returned a negative timestamp.",
      );
    }
    return now + BigInt(this.#maximumScanDurationMilliseconds);
  }

  #assertScanActive(signal: AbortSignal | undefined, deadline: bigint | undefined): void {
    throwIfAborted(signal);
    if (deadline === undefined) return;
    const now = this.#clock.nowEpochMilliseconds();
    if (now < 0n) {
      throw new WorkspaceDiskBudgetError(
        "ACCOUNTING_FAILED",
        "The workspace accounting clock returned a negative timestamp.",
      );
    }
    if (now >= deadline) {
      throw new WorkspaceDiskBudgetError(
        "ACCOUNTING_TIMED_OUT",
        "Workspace disk accounting exceeded its wall-clock deadline.",
      );
    }
  }

  async #runExclusive<T>(
    operation: () => Promise<T>,
    signal: AbortSignal | undefined,
    deadline: bigint,
  ): Promise<T> {
    const previous = this.#exclusiveTail;
    let release!: () => void;
    this.#exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await this.#waitForExclusiveTurn(previous, signal, deadline);
    } catch (error) {
      void previous.then(release, release);
      throw error;
    }
    try {
      this.#assertScanActive(signal, deadline);
      return await operation();
    } finally {
      release();
    }
  }

  async #waitForExclusiveTurn(
    previous: Promise<void>,
    signal: AbortSignal | undefined,
    deadline: bigint,
  ): Promise<void> {
    this.#assertScanActive(signal, deadline);
    let rejectInterruption!: (error: unknown) => void;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const abortListener = () => rejectInterruption(abortedBudgetError(signal?.reason));
    signal?.addEventListener("abort", abortListener, { once: true });

    const remaining = deadline - this.#clock.nowEpochMilliseconds();
    const timeout = this.#clock.scheduleTimeout(
      () =>
        rejectInterruption(
          new WorkspaceDiskBudgetError(
            "ACCOUNTING_TIMED_OUT",
            "Workspace disk operation expired while waiting for the exclusive queue.",
          ),
        ),
      Number(remaining > 0n ? remaining : 0n),
    );
    try {
      await Promise.race([previous, interruption]);
      this.#assertScanActive(signal, deadline);
    } finally {
      timeout.cancel();
      signal?.removeEventListener("abort", abortListener);
    }
  }
}

class ProductionWorkspaceDiskReservation implements WorkspaceDiskReservation {
  #released = false;

  public constructor(
    private readonly owner: ProductionWorkspaceDiskBudget,
    private readonly record: ReservationRecord,
  ) {}

  public get attemptDirectory(): string {
    return this.record.attemptDirectory;
  }

  public async startMonitoring(parentSignal: AbortSignal): Promise<WorkspaceDiskMonitor> {
    if (this.#released) {
      throw new WorkspaceDiskBudgetError(
        "RESERVATION_RELEASED",
        "Cannot monitor a released workspace disk reservation.",
      );
    }
    return this.owner.startMonitoring(this.record, parentSignal);
  }

  public async release(): Promise<void> {
    if (this.#released) return;
    await this.owner.release(this.record);
    this.#released = true;
  }

  public async removeAttempt(): Promise<void> {
    if (this.#released) {
      throw new WorkspaceDiskBudgetError(
        "RESERVATION_RELEASED",
        "Cannot remove a workspace after its disk reservation was released.",
      );
    }
    await this.owner.removeAttempt(this.record);
  }

  public abandon(): void {
    if (this.#released) return;
    this.#released = true;
    this.owner.abandon(this.record);
  }
}

class ProductionWorkspaceDiskMonitor implements WorkspaceDiskMonitor {
  readonly #controller = new AbortController();
  readonly #parentAbortListener: () => void;
  #timer: WorkspaceDiskInterval | undefined;
  #checkInFlight: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #violation: WorkspaceDiskBudgetError | undefined;

  public constructor(
    private readonly owner: ProductionWorkspaceDiskBudget,
    private readonly record: ReservationRecord,
    private readonly parentSignal: AbortSignal,
    private readonly clock: WorkspaceDiskClock,
    private readonly intervalMilliseconds: number,
  ) {
    this.#parentAbortListener = () => {
      if (!this.#controller.signal.aborted) {
        this.#controller.abort(this.parentSignal.reason);
      }
    };
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  public get violation(): WorkspaceDiskBudgetError | undefined {
    return this.#violation;
  }

  public async start(): Promise<void> {
    if (this.parentSignal.aborted) {
      this.#parentAbortListener();
      throw abortedBudgetError(this.parentSignal.reason);
    }
    this.parentSignal.addEventListener("abort", this.#parentAbortListener, { once: true });
    try {
      await this.owner.assertHealthy(this.record, this.parentSignal);
    } catch (error) {
      if (this.parentSignal.aborted && isAbortedBudgetError(error)) {
        this.#parentAbortListener();
        this.#detach();
        throw error;
      }
      this.#recordViolation(error);
      this.#detach();
      throw this.#violation;
    }
    try {
      this.#timer = this.clock.scheduleInterval(
        () => this.#scheduleCheck(),
        this.intervalMilliseconds,
      );
    } catch (error) {
      this.#recordViolation(error);
      this.#detach();
      throw this.#violation;
    }
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    this.#timer?.cancel();
    this.#timer = undefined;
    await this.#checkInFlight;
    if (this.#violation === undefined && !this.parentSignal.aborted) {
      try {
        await this.owner.assertHealthy(this.record, this.parentSignal);
      } catch (error) {
        this.#recordViolation(error);
      }
    }
    this.#detach();
    if (this.#violation !== undefined) throw this.#violation;
  }

  #scheduleCheck(): Promise<void> {
    if (this.#closePromise !== undefined) return Promise.resolve();
    if (this.#checkInFlight !== undefined) return this.#checkInFlight;
    const check = this.owner
      .assertHealthy(this.record, this.parentSignal)
      .catch((error: unknown) => {
        if (!this.parentSignal.aborted || !isAbortedBudgetError(error)) {
          this.#recordViolation(error);
        }
      })
      .finally(() => {
        if (this.#checkInFlight === check) {
          this.#checkInFlight = undefined;
        }
      });
    this.#checkInFlight = check;
    return check;
  }

  #recordViolation(error: unknown): void {
    const violation =
      error instanceof WorkspaceDiskBudgetError
        ? error
        : new WorkspaceDiskBudgetError(
            "ACCOUNTING_FAILED",
            "Workspace disk monitoring failed closed.",
            { cause: error },
          );
    this.#violation ??= violation;
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(this.#violation);
    }
  }

  #detach(): void {
    this.parentSignal.removeEventListener("abort", this.#parentAbortListener);
  }
}

export function isStrictAttemptDirectoryName(name: string): boolean {
  return strictAttemptNamePattern.test(name);
}

function normalizeWorkspaceRoot(path: string): string {
  const normalized = normalizeLocalWindowsPath(path, "workspaceRootDirectory");
  if (sameWindowsPath(normalized, win32.parse(normalized).root)) {
    throw new TypeError("workspaceRootDirectory must not be a filesystem root.");
  }
  return normalized;
}

function normalizeLocalWindowsPath(path: string, name: string): string {
  assertWellFormedUnicode(path, name);
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 32_767 ||
    path.startsWith("\\\\") ||
    path.startsWith("//") ||
    path.startsWith("\\??\\") ||
    !/^[A-Za-z]:[\\/]/u.test(path) ||
    !win32.isAbsolute(path) ||
    path.slice(2).includes(":")
  ) {
    throw new TypeError(`${name} must be an absolute local Windows drive path.`);
  }
  for (const component of path.slice(3).split(/[\\/]/u)) {
    if (component.length > 0) assertSafeWindowsPathComponent(component, name);
  }
  return normalizeDirectory(path.replaceAll("/", "\\"));
}

function assertSafeWindowsPathComponent(component: string, name: string): void {
  if (
    component === "." ||
    component === ".." ||
    component.endsWith(".") ||
    component.endsWith(" ") ||
    /[<>:"|?*]/u.test(component) ||
    [...component].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) {
    throw new TypeError(`${name} contains an unsafe Windows path component.`);
  }
  const baseName = component.split(".", 1)[0]?.toUpperCase() ?? "";
  if (
    baseName === "CON" ||
    baseName === "PRN" ||
    baseName === "AUX" ||
    baseName === "NUL" ||
    baseName === "CONIN$" ||
    baseName === "CONOUT$" ||
    baseName === "CLOCK$" ||
    /^COM[1-9]$/u.test(baseName) ||
    /^LPT[1-9]$/u.test(baseName) ||
    /^(?:COM|LPT)[\u00b9\u00b2\u00b3]$/u.test(baseName)
  ) {
    throw new TypeError(`${name} contains a reserved Windows device name.`);
  }
}

function assertWellFormedUnicode(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${name} must contain well-formed Unicode.`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${name} must contain well-formed Unicode.`);
    }
  }
}

function normalizeDirectory(path: string): string {
  const normalized = win32.normalize(path);
  const parsed = win32.parse(normalized);
  return normalized.toLowerCase() === parsed.root.toLowerCase()
    ? parsed.root
    : normalized.replace(/[\\/]+$/u, "");
}

function sameWindowsPath(left: string, right: string): boolean {
  return normalizeDirectory(left).toLowerCase() === normalizeDirectory(right).toLowerCase();
}

function assertUniqueSafeEntryNames(entries: readonly string[]): void {
  const foldedNames = new Set<string>();
  for (const name of entries) {
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      win32.basename(name) !== name
    ) {
      throw new WorkspaceDiskBudgetError(
        "WORKSPACE_PATH_UNSAFE",
        "Workspace directory enumeration returned an unsafe entry name.",
      );
    }
    const folded = name.toLowerCase();
    if (foldedNames.has(folded)) {
      throw new WorkspaceDiskBudgetError(
        "WORKSPACE_PATH_UNSAFE",
        "Workspace directory enumeration returned duplicate entry names.",
      );
    }
    foldedNames.add(folded);
  }
}

function ioContext(
  signal?: AbortSignal,
  deadlineEpochMilliseconds?: bigint,
): WorkspaceDiskIoContext {
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(deadlineEpochMilliseconds === undefined ? {} : { deadlineEpochMilliseconds }),
  };
}

function assertValidPathState(state: WorkspaceDiskPathState): void {
  if (
    state.device < 0n ||
    state.inode < 0n ||
    state.size < 0n ||
    state.modifiedAtMs < 0n ||
    state.changedAtMs < 0n
  ) {
    throw new WorkspaceDiskBudgetError(
      "ACCOUNTING_FAILED",
      "A workspace path reported invalid bigint metadata.",
    );
  }
}

function sameStablePathState(
  first: WorkspaceDiskPathState,
  second: WorkspaceDiskPathState,
): boolean {
  return (
    first.device === second.device &&
    first.inode === second.inode &&
    first.kind === second.kind &&
    first.modifiedAtMs === second.modifiedAtMs &&
    first.changedAtMs === second.changedAtMs
  );
}

function samePathIdentity(first: WorkspaceDiskPathState, second: WorkspaceDiskPathState): boolean {
  return (
    first.device === second.device && first.inode === second.inode && first.kind === second.kind
  );
}

function assertPositiveBigInt(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new RangeError(`${name} must be a positive bigint.`);
  }
  return value;
}

function assertNonNegativeBigInt(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError(`${name} must be a non-negative bigint.`);
  }
  return value;
}

function assertPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function assertBoundedSafeInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function accountingLimitError(): WorkspaceDiskBudgetError {
  return new WorkspaceDiskBudgetError(
    "ACCOUNTING_LIMIT_EXCEEDED",
    "Workspace disk accounting exceeded its bounded entry limit.",
  );
}

function snapshotUnstableError(cause?: unknown): WorkspaceDiskBudgetError {
  return new WorkspaceDiskBudgetError(
    "SNAPSHOT_UNSTABLE",
    "Workspace entries changed while a bounded disk snapshot was being measured.",
    cause === undefined ? undefined : { cause },
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortedBudgetError(signal.reason);
}

function abortedBudgetError(cause: unknown): WorkspaceDiskBudgetError {
  return new WorkspaceDiskBudgetError("ABORTED", "Workspace disk operation was aborted.", {
    cause,
  });
}

function isAbortedBudgetError(error: unknown): boolean {
  return error instanceof WorkspaceDiskBudgetError && error.code === "ABORTED";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}
