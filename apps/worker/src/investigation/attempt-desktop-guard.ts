import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { type FileHandle, link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const attemptDesktopLockFileName = "machine-execution.lock";
export const attemptDesktopRecoveryLockFileName = "machine-execution.recovery.lock";
const recoveryQueues = new Map<string, Promise<void>>();

export class AttemptDesktopGuardError extends Error {
  public constructor(
    public readonly code:
      | "DESKTOP_ATTEMPT_UNAVAILABLE"
      | "DESKTOP_ATTEMPT_LOCK_UNSAFE"
      | "DESKTOP_ATTEMPT_QUARANTINED"
      | "DESKTOP_ATTEMPT_CLEANUP_UNCONFIRMED",
    message: string,
  ) {
    super(message);
    this.name = "AttemptDesktopGuardError";
  }
}

export interface AttemptDesktopGuard {
  /** Private recovery capability. Never include this value in logs or public status. */
  readonly ownerToken: string;
  readonly state: "held" | "released" | "quarantined";
  /** Called only after every owned process and local cleanup is confirmed. */
  releaseRestored(): Promise<void>;
  /** Retains ownership until trusted recovery independently proves cleanup. */
  quarantine(reasonCode: string): Promise<void>;
  /**
   * Settles only this in-memory guard and closes its existing handle, without touching markers.
   * Only trusted managed cleanup may confirm released, including after prior quarantine.
   */
  settleManagedCleanup(state: "released" | "quarantined"): Promise<void>;
}

export interface AttemptDesktopGuardOptions {
  /** One deployment-owned machine-wide directory shared by all Worker roles and data roots. */
  readonly lockDirectory: string;
  readonly ownerId: string;
  /** A trusted journal allocates a fresh token for this acquisition; never reuse an old token. */
  readonly ownerToken?: string;
}

export interface AttemptDesktopGuardRecoveryOptions {
  readonly lockDirectory: string;
  readonly ownerId: string;
  readonly ownerToken: string;
  readonly processesStopped: true;
  readonly desktopRestored: true;
  /**
   * The trusted native ProcessHost holds the journal-bound instance mutex for this entire call.
   * Its ready snapshot proves the previous generation and process tree have drained. The caller
   * has fenced all old acquisitions and execution; PID absence and elapsed time are not proof.
   */
  readonly recoveryExclusive: true;
}

export interface AttemptDesktopGuardRecoveryResult {
  readonly state: "released" | "already-absent";
}

export type AttemptDesktopGuardStatus =
  | { readonly state: "absent"; readonly recoveryBlocked: boolean }
  | {
      readonly state: "held" | "quarantined";
      readonly ownerId: string;
      readonly processId: number;
      readonly acquiredAt: string;
      readonly reasonCode: string | null;
      /** Occupied or uncertain cleanup serialization; never infer liveness from this field. */
      readonly recoveryBlocked: boolean;
    };

export interface AttemptDesktopCleanupHooks {
  readonly onAttemptCleanupConfirmed: () => Promise<void>;
  readonly onAttemptCleanupUnconfirmed: (reasonCode: string) => Promise<void>;
}

interface Owner {
  readonly ownerId: string;
  readonly ownerToken: string;
}

interface GuardRecord extends Owner {
  readonly schemaVersion: "InvestigationAttemptDesktopGuardV1";
  readonly publicationId?: string;
  readonly processId: number;
  readonly acquiredAt: string;
  state: "held" | "quarantined";
  reasonCode: string | null;
}

interface SerializationRecord extends Owner {
  readonly schemaVersion: "InvestigationDesktopCleanupSerializationV1";
  readonly publicationId: string;
}

interface OpenedFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly original: BigIntStats;
}

/** Holds a separate machine key while scenarios retain their own session-level desktop lease. */
export async function acquireAttemptDesktopGuard(
  options: AttemptDesktopGuardOptions,
): Promise<AttemptDesktopGuard> {
  assertOptions(options);
  const directory = resolve(options.lockDirectory);
  const record: GuardRecord & { readonly publicationId: string } = {
    schemaVersion: "InvestigationAttemptDesktopGuardV1",
    ownerId: options.ownerId,
    ownerToken: options.ownerToken ?? randomUUID(),
    publicationId: randomUUID(),
    processId: process.pid,
    acquiredAt: new Date().toISOString(),
    state: "held",
    reasonCode: null,
  };
  const gate = await acquireSerialization(directory, record);
  let owned: OpenedFile | undefined;
  try {
    try {
      owned = await publishRecord(directory, attemptDesktopLockFileName, record);
    } finally {
      await gate.release();
    }
  } catch (error) {
    await owned?.handle.close();
    if (hasCode(error, "EEXIST")) throw quarantined();
    if (error instanceof AttemptDesktopGuardError) throw error;
    throw unsafe("The machine execution lock could not be durably acquired.");
  }
  if (owned === undefined) throw unsafe("The machine execution lock acquisition was incomplete.");
  const file = owned;
  let state: AttemptDesktopGuard["state"] = "held";
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const closeHandle = (): Promise<void> => {
    if (closePromise === undefined) {
      // A close failure must not permit another callback to reuse or close this handle again.
      closed = true;
      closePromise = Promise.resolve().then(() => file.handle.close());
    }
    return closePromise;
  };
  let pendingMutation = Promise.resolve();
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const pending = pendingMutation.then(operation);
    pendingMutation = pending.catch(() => undefined);
    return pending;
  };
  const assertOwner = async (): Promise<void> => {
    if (closed) throw unsafe("The attempt desktop guard is already closed.");
    await assertFileIdentity(directory, file.path, file.original);
    assertMatchingOwner(await readGuardRecord(file.handle), record);
  };
  const guard = {
    get state() {
      return state;
    },
    async releaseRestored() {
      return serialize(async () => {
        if (state === "released") return;
        if (closed || state !== "held") throw quarantined();
        const mutation = await acquireSerialization(directory, record);
        try {
          await assertOwner();
          if (state !== "held") throw quarantined();
          await unlink(file.path);
          state = "released";
          await closeHandle();
        } finally {
          await mutation.release();
        }
      });
    },
    async quarantine(reasonCode) {
      return serialize(async () => {
        // Preserve the first quarantine and never recreate a released local lock after an ack failure.
        if (state === "released" || state === "quarantined") return;
        if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(reasonCode))
          throw unsafe("The attempt quarantine reason is invalid.");
        let mutation: { release(): Promise<void> } | undefined;
        try {
          mutation = await acquireSerialization(directory, record);
          await assertOwner();
          record.state = "quarantined";
          record.reasonCode = reasonCode;
          await replaceOwnedRecord(directory, file, record);
        } finally {
          state = "quarantined";
          try {
            await closeHandle();
          } finally {
            await mutation?.release();
          }
        }
      });
    },
    async settleManagedCleanup(nextState) {
      if (nextState !== "released" && nextState !== "quarantined")
        throw unsafe("The managed desktop cleanup state is invalid.");
      return serialize(async () => {
        if (state !== "released") state = nextState;
        await closeHandle();
      });
    },
  } satisfies Omit<AttemptDesktopGuard, "ownerToken">;
  return Object.defineProperty(guard, "ownerToken", {
    value: record.ownerToken,
    enumerable: false,
    writable: false,
    configurable: false,
  }) as AttemptDesktopGuard;
}

/** Trusted native fencing also permits recovery of this exact owner's abandoned mutation gate. */
export async function recoverAttemptDesktopGuard(
  options: AttemptDesktopGuardRecoveryOptions,
): Promise<AttemptDesktopGuardRecoveryResult> {
  assertOptions(options);
  if (
    !isOwnerToken(options.ownerToken) ||
    options.processesStopped !== true ||
    options.desktopRestored !== true ||
    options.recoveryExclusive !== true
  )
    throw unsafe(
      "Desktop recovery requires its private owner, cleanup proofs, and native exclusivity.",
    );
  const directory = resolve(options.lockDirectory);
  const key = process.platform === "win32" ? directory.toLowerCase() : directory;
  const previous = recoveryQueues.get(key) ?? Promise.resolve();
  const pending = previous.then(() => recoverOwnedGuard(directory, options));
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  recoveryQueues.set(key, settled);
  void settled.then(() => {
    if (recoveryQueues.get(key) === settled) recoveryQueues.delete(key);
  });
  return pending;
}

async function recoverOwnedGuard(
  directory: string,
  options: AttemptDesktopGuardRecoveryOptions,
): Promise<AttemptDesktopGuardRecoveryResult> {
  const gate = await acquireSerialization(directory, options, true);
  let file: OpenedFile | undefined;
  try {
    file = await openExistingFile(directory, attemptDesktopLockFileName);
    if (file === undefined) return { state: "already-absent" };
    const record = await readGuardRecord(file.handle);
    assertMatchingOwner(record, options);
    await assertPublishedFile(directory, file, record.publicationId, true);
    assertMatchingOwner(await readGuardRecord(file.handle), options);
    await assertFileIdentity(directory, file.path, file.original);
    await unlink(file.path);
    return { state: "released" };
  } finally {
    try {
      await file?.handle.close();
    } finally {
      await gate.release();
    }
  }
}

/** Returns an explicit metadata whitelist, without the private recovery capability. */
export async function readAttemptDesktopGuardStatus(options: {
  readonly lockDirectory: string;
}): Promise<AttemptDesktopGuardStatus> {
  if (!isAbsolute(options.lockDirectory)) throw unsafe("The desktop status directory is invalid.");
  const directory = resolve(options.lockDirectory);
  await assertDirectoryChain(directory);
  const recoveryBlocked = await markerExists(join(directory, attemptDesktopRecoveryLockFileName));
  const file = await openExistingFile(directory, attemptDesktopLockFileName);
  if (file === undefined) return { state: "absent", recoveryBlocked };
  try {
    const record = await readGuardRecord(file.handle);
    await assertPublishedFile(directory, file, record.publicationId, false);
    return {
      state: record.state,
      ownerId: record.ownerId,
      processId: record.processId,
      acquiredAt: record.acquiredAt,
      reasonCode: record.reasonCode,
      recoveryBlocked,
    };
  } finally {
    await file.handle.close();
  }
}

/** A resolved executor is not cleanup evidence; only its trusted explicit hook can release. */
export async function executeWithAttemptDesktopGuard(
  guard: AttemptDesktopGuard,
  execute: (hooks: AttemptDesktopCleanupHooks) => Promise<void>,
): Promise<void> {
  try {
    await execute({
      onAttemptCleanupConfirmed: () => guard.releaseRestored(),
      onAttemptCleanupUnconfirmed: (reasonCode) => guard.quarantine(reasonCode),
    });
    if (guard.state !== "released")
      throw new AttemptDesktopGuardError(
        "DESKTOP_ATTEMPT_CLEANUP_UNCONFIRMED",
        "The attempt ended without trusted confirmation of local cleanup.",
      );
  } finally {
    if (guard.state === "held") await guard.quarantine("ATTEMPT_CLEANUP_UNCONFIRMED");
  }
}

async function acquireSerialization(
  directory: string,
  owner: Owner,
  recover = false,
): Promise<{ release(): Promise<void> }> {
  await assertDirectoryChain(directory);
  if (recover) {
    const previous = await openExistingFile(directory, attemptDesktopRecoveryLockFileName);
    if (previous !== undefined) {
      try {
        const record = await readSerializationRecord(previous.handle);
        assertMatchingOwner(record, owner);
        // Only the caller's native instance mutex proves this matching prior invocation stopped.
        await assertPublishedFile(directory, previous, record.publicationId, true);
        assertMatchingOwner(await readSerializationRecord(previous.handle), owner);
        await assertFileIdentity(directory, previous.path, previous.original);
        await unlink(previous.path);
      } finally {
        await previous.handle.close();
      }
    }
  }
  const record: SerializationRecord = {
    schemaVersion: "InvestigationDesktopCleanupSerializationV1",
    ownerId: owner.ownerId,
    ownerToken: owner.ownerToken,
    publicationId: randomUUID(),
  };
  let file: OpenedFile;
  try {
    file = await publishRecord(directory, attemptDesktopRecoveryLockFileName, record);
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw quarantined();
    if (error instanceof AttemptDesktopGuardError) throw error;
    throw unsafe("The machine execution cleanup serialization marker could not be acquired.");
  }
  return {
    async release() {
      try {
        await assertFileIdentity(directory, file.path, file.original);
        const current = await readSerializationRecord(file.handle);
        assertMatchingOwner(current, record);
        if (current.publicationId !== record.publicationId)
          throw unsafe("The machine execution cleanup serialization invocation changed.");
        await unlink(file.path);
      } finally {
        await file.handle.close();
      }
    },
  };
}

/** Publishes complete, synced owner bytes without ever exposing a new empty fixed marker. */
async function publishRecord(
  directory: string,
  name: string,
  record: (GuardRecord | SerializationRecord) & { readonly publicationId: string },
): Promise<OpenedFile> {
  await assertDirectoryChain(directory);
  const path = join(directory, name);
  const stagedPath = publicationPath(path, record.publicationId);
  const handle = await open(stagedPath, "wx+", 0o600);
  let original: BigIntStats | undefined;
  let published = false;
  try {
    original = await handle.stat({ bigint: true });
    await handle.writeFile(Buffer.from(JSON.stringify(record), "utf8"));
    await handle.sync();
    await assertFileIdentity(directory, stagedPath, original);
    await link(stagedPath, path);
    published = true;
    const file = { path, handle, original };
    await assertPublishedFile(directory, file, record.publicationId, true);
    return file;
  } catch (error) {
    try {
      if (!published && original !== undefined) {
        await assertFileIdentity(directory, stagedPath, original);
        await unlink(stagedPath);
      }
    } finally {
      await handle.close();
    }
    throw error;
  }
}

/** A crash during quarantine leaves either complete held bytes or complete quarantined bytes. */
async function replaceOwnedRecord(
  directory: string,
  file: OpenedFile,
  record: GuardRecord,
): Promise<void> {
  const publicationId = randomUUID();
  const stagedPath = publicationPath(file.path, publicationId);
  const handle = await open(stagedPath, "wx+", 0o600);
  let original: BigIntStats | undefined;
  let published = false;
  try {
    original = await handle.stat({ bigint: true });
    await handle.writeFile(Buffer.from(JSON.stringify({ ...record, publicationId }), "utf8"));
    await handle.sync();
    await assertFileIdentity(directory, stagedPath, original);
    await assertFileIdentity(directory, file.path, file.original);
    assertMatchingOwner(await readGuardRecord(file.handle), record);
    await rename(stagedPath, file.path);
    published = true;
    await assertFileIdentity(directory, file.path, original);
  } finally {
    try {
      if (!published && original !== undefined) {
        await assertFileIdentity(directory, stagedPath, original);
        await unlink(stagedPath);
      }
    } finally {
      await handle.close();
    }
  }
}

/** Accepts two links only when the second is the record's exact publication staging name. */
async function assertPublishedFile(
  directory: string,
  file: OpenedFile,
  publicationId: string | undefined,
  normalize: boolean,
): Promise<void> {
  try {
    const current = await assertFileIdentity(directory, file.path, file.original, true);
    if (current.nlink === 2n) {
      if (!isOwnerToken(publicationId))
        throw unsafe("The lock has an unrecognized additional link.");
      const stagedPath = publicationPath(file.path, publicationId);
      const staged = await assertFileIdentity(directory, stagedPath, file.original, true);
      if (staged.nlink !== 2n) throw unsafe("The lock publication identity changed.");
      if (normalize) {
        await unlink(stagedPath);
        await assertFileIdentity(directory, file.path, file.original);
      }
    }
  } catch {
    // The publication ID came from disk. Do not expose a path built from untrusted record data.
    throw unsafe("The lock publication identity could not be confirmed.");
  }
}

async function openExistingFile(directory: string, name: string): Promise<OpenedFile | undefined> {
  await assertDirectoryChain(directory);
  const path = join(directory, name);
  let original: BigIntStats;
  try {
    original = await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  await assertFileIdentity(directory, path, original, true);
  const handle = await open(path, "r");
  try {
    const current = await handle.stat({ bigint: true });
    if (current.dev !== original.dev || current.ino !== original.ino)
      throw unsafe("The opened machine execution lock identity changed.");
    return { path, handle, original };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readGuardRecord(handle: FileHandle): Promise<GuardRecord> {
  const record = await readJsonRecord(handle);
  if (
    record.schemaVersion !== "InvestigationAttemptDesktopGuardV1" ||
    !isOwner(record) ||
    (record.publicationId !== undefined && !isOwnerToken(record.publicationId)) ||
    typeof record.processId !== "number" ||
    !Number.isSafeInteger(record.processId) ||
    record.processId < 1 ||
    typeof record.acquiredAt !== "string" ||
    record.acquiredAt.length > 64 ||
    !Number.isFinite(Date.parse(record.acquiredAt)) ||
    (record.state !== "held" && record.state !== "quarantined") ||
    (record.reasonCode !== null &&
      (typeof record.reasonCode !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(record.reasonCode)))
  )
    throw unsafe("The machine execution lock record is invalid.");
  return record as unknown as GuardRecord;
}

async function readSerializationRecord(handle: FileHandle): Promise<SerializationRecord> {
  const record = await readJsonRecord(handle);
  if (
    record.schemaVersion !== "InvestigationDesktopCleanupSerializationV1" ||
    !isOwner(record) ||
    !isOwnerToken(record.publicationId)
  )
    throw unsafe("The machine execution cleanup serialization record is invalid.");
  return record as unknown as SerializationRecord;
}

async function readJsonRecord(handle: FileHandle): Promise<Record<string, unknown>> {
  const bytes = Buffer.alloc(4_096);
  const state = await handle.stat({ bigint: true });
  if (state.size <= 0n || state.size > BigInt(bytes.byteLength))
    throw unsafe("The machine execution lock record is invalid.");
  const read = await handle.read(bytes, 0, bytes.byteLength, 0);
  let record: unknown;
  try {
    record = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
  } catch {
    // Parse errors can quote private contents; never retain their original message or cause.
    throw unsafe("The machine execution lock record is invalid.");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record))
    throw unsafe("The machine execution lock record is invalid.");
  return record as Record<string, unknown>;
}

function assertOptions(options: AttemptDesktopGuardOptions): void {
  if (
    !isAbsolute(options.lockDirectory) ||
    !isOwnerId(options.ownerId) ||
    (options.ownerToken !== undefined && !isOwnerToken(options.ownerToken))
  )
    throw unsafe("The attempt desktop guard configuration is invalid.");
}

function isOwner(value: Record<string, unknown>): boolean {
  return isOwnerId(value.ownerId) && isOwnerToken(value.ownerToken);
}

function isOwnerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isOwnerToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)
  );
}

function assertMatchingOwner(record: Owner, owner: Owner): void {
  if (record.ownerId !== owner.ownerId || record.ownerToken !== owner.ownerToken)
    throw unsafe("The machine execution lock owner does not match the trusted recovery owner.");
}

function publicationPath(path: string, publicationId: string): string {
  return path + "." + publicationId + ".pending";
}

async function markerExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function assertFileIdentity(
  directory: string,
  path: string,
  original: BigIntStats,
  allowPublicationLink = false,
): Promise<BigIntStats> {
  await assertDirectoryChain(directory);
  const current = await lstat(path, { bigint: true });
  const reparseAware = current as typeof current & { isReparsePoint?(): boolean };
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    reparseAware.isReparsePoint?.() === true ||
    (current.nlink !== 1n && !(allowPublicationLink && current.nlink === 2n)) ||
    current.dev !== original.dev ||
    current.ino !== original.ino ||
    !samePath(await realpath(path), path)
  )
    throw unsafe("The machine execution lock identity changed.");
  return current;
}

async function assertDirectoryChain(directory: string): Promise<void> {
  let current = resolve(directory);
  for (;;) {
    const state = await lstat(current);
    const reparseAware = state as typeof state & { isReparsePoint?(): boolean };
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      reparseAware.isReparsePoint?.() === true ||
      !samePath(await realpath(current), current)
    )
      throw unsafe("The shared machine execution lock directory is redirected.");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function samePath(first: string, second: string): boolean {
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function unsafe(message: string): AttemptDesktopGuardError {
  return new AttemptDesktopGuardError("DESKTOP_ATTEMPT_LOCK_UNSAFE", message);
}

function quarantined(): AttemptDesktopGuardError {
  return new AttemptDesktopGuardError(
    "DESKTOP_ATTEMPT_QUARANTINED",
    "Machine execution ownership or cleanup is occupied or uncertain; its marker is retained.",
  );
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
