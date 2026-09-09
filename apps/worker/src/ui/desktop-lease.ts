import { randomUUID } from "node:crypto";
import { type FileHandle, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export class DesktopLeaseError extends Error {
  public constructor(
    public readonly code: "DESKTOP_UNAVAILABLE" | "DESKTOP_LOCK_UNSAFE" | "DESKTOP_QUARANTINED",
    message: string,
  ) {
    super(message);
    this.name = "DesktopLeaseError";
  }
}

export interface DesktopLease {
  readonly sessionId: number;
  /** Called only after all owned processes drained and every reset/cleanup operation succeeded. */
  releaseRestored(): Promise<void>;
  /** Retains a durable marker. Recovery of this environment is an explicit operator action. */
  quarantine(reasonCode: string): Promise<void>;
}

export interface DesktopLeaseOptions {
  // Deployment supplies one shared, private directory per Windows account, across Worker nodes
  // and servers. Repository/profile/concurrency-key configuration must never choose this path.
  readonly lockDirectory: string;
  readonly sessionId: number;
  readonly ownerId: string;
}

async function assertDirectoryChain(directory: string): Promise<void> {
  let current = resolve(directory);
  for (;;) {
    const state = await lstat(current);
    const canonical = await realpath(current);
    const samePath =
      process.platform === "win32"
        ? canonical.toLowerCase() === current.toLowerCase()
        : canonical === current;
    if (!state.isDirectory() || state.isSymbolicLink() || !samePath) {
      throw new DesktopLeaseError(
        "DESKTOP_LOCK_UNSAFE",
        "The shared desktop lock directory is redirected.",
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function acquireDesktopLease(options: DesktopLeaseOptions): Promise<DesktopLease> {
  if (
    !isAbsolute(options.lockDirectory) ||
    !Number.isSafeInteger(options.sessionId) ||
    options.sessionId < 1 ||
    options.sessionId > 4_294_967_295 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(options.ownerId)
  ) {
    throw new DesktopLeaseError("DESKTOP_LOCK_UNSAFE", "Desktop lease configuration is invalid.");
  }
  const directory = resolve(options.lockDirectory);
  await assertDirectoryChain(directory);
  const path = join(directory, `session-${options.sessionId}.lock`);
  let handle: FileHandle;
  try {
    handle = await open(path, "wx+", 0o600);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new DesktopLeaseError(
        "DESKTOP_QUARANTINED",
        "The interactive session is occupied or quarantined; its existing owner must not be replaced.",
      );
    }
    throw new DesktopLeaseError(
      "DESKTOP_UNAVAILABLE",
      "The shared desktop lease could not be acquired.",
    );
  }
  const record = {
    schemaVersion: "DesktopLeaseV1",
    sessionId: options.sessionId,
    ownerId: options.ownerId,
    ownerToken: randomUUID(),
    processId: process.pid,
    acquiredAt: new Date().toISOString(),
    state: "held",
    reasonCode: null as string | null,
  };
  let closed = false;
  const original = await handle.stat({ bigint: true });
  const write = async (): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.byteLength, 0);
    await handle.sync();
  };
  const assertOwner = async (): Promise<void> => {
    if (closed)
      throw new DesktopLeaseError("DESKTOP_LOCK_UNSAFE", "The desktop lease is already closed.");
    await assertDirectoryChain(directory);
    const current = await lstat(path, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      current.dev !== original.dev ||
      current.ino !== original.ino
    ) {
      throw new DesktopLeaseError("DESKTOP_LOCK_UNSAFE", "The desktop lease identity changed.");
    }
    const bytes = Buffer.alloc(4_096);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    const currentRecord: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
    if (
      current.size > BigInt(bytes.byteLength) ||
      typeof currentRecord !== "object" ||
      currentRecord === null ||
      !("ownerToken" in currentRecord) ||
      currentRecord.ownerToken !== record.ownerToken
    ) {
      throw new DesktopLeaseError("DESKTOP_LOCK_UNSAFE", "The desktop lease owner changed.");
    }
  };
  try {
    await write();
    await assertOwner();
  } catch {
    await handle.close();
    // Even a partial acquisition retains its marker: startup must not silently clear uncertainty.
    throw new DesktopLeaseError(
      "DESKTOP_LOCK_UNSAFE",
      "The desktop lease could not be durably recorded.",
    );
  }
  return {
    sessionId: options.sessionId,
    async releaseRestored() {
      await assertOwner();
      if (record.state !== "held") {
        throw new DesktopLeaseError(
          "DESKTOP_QUARANTINED",
          "A quarantined desktop lease cannot be automatically released.",
        );
      }
      // The configured directory is private to the Worker account. Verify the retained inode and
      // token before unlinking; never unlink a lock discovered from an unknown or expired owner.
      await unlink(path);
      await handle.close();
      closed = true;
    },
    async quarantine(reasonCode) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(reasonCode)) {
        throw new DesktopLeaseError(
          "DESKTOP_LOCK_UNSAFE",
          "The desktop quarantine reason is invalid.",
        );
      }
      try {
        await assertOwner();
        record.state = "quarantined";
        record.reasonCode = reasonCode;
        await write();
      } finally {
        if (!closed) await handle.close();
        closed = true;
      }
    },
  };
}
