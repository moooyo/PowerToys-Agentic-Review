import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDesktopLease } from "../ui/desktop-lease.js";
import {
  type AttemptDesktopGuard,
  type AttemptDesktopGuardRecoveryOptions,
  acquireAttemptDesktopGuard,
  attemptDesktopLockFileName,
  attemptDesktopRecoveryLockFileName,
  executeWithAttemptDesktopGuard,
  readAttemptDesktopGuardStatus,
  recoverAttemptDesktopGuard,
} from "./attempt-desktop-guard.js";

const execFileAsync = promisify(execFile);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), "attempt-desktop-guard-"));
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});
const acquire = (ownerId = "attempt-1:1") =>
  acquireAttemptDesktopGuard({ lockDirectory: directory, ownerId });
const readRecord = async () =>
  JSON.parse(await readFile(join(directory, attemptDesktopLockFileName), "utf8"));

describe("machine-wide attempt desktop guard", () => {
  it("excludes unrelated attempts until trusted local cleanup releases the lock", async () => {
    const first = await acquire();
    await expect(acquire("other-server-attempt:7")).rejects.toMatchObject({
      code: "DESKTOP_ATTEMPT_QUARANTINED",
    });
    await first.releaseRestored();
    expect(first.state).toBe("released");
    await (await acquire("other-server-attempt:7")).releaseRestored();
  });

  it("uses a different key from the scenario's interactive-session lease", async () => {
    const attempt = await acquire();
    const scenario = await acquireDesktopLease({
      lockDirectory: directory,
      sessionId: 3,
      ownerId: "scenario-1",
    });
    await scenario.releaseRestored();
    await expect(acquire("another-attempt")).rejects.toMatchObject({
      code: "DESKTOP_ATTEMPT_QUARANTINED",
    });
    await attempt.releaseRestored();
  });

  it("prevents a separate process from acquiring the same execution lock", async () => {
    const guard = await acquire();
    const child = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'import { open } from "node:fs/promises";',
        "try {",
        '  const handle = await open(process.argv[1], "wx", 0o600);',
        "  await handle.close();",
        '  process.stdout.write("acquired");',
        "} catch (error) {",
        '  if (error.code !== "EEXIST") throw error;',
        '  process.stdout.write("occupied");',
        "}",
      ].join("\n"),
      join(directory, attemptDesktopLockFileName),
    ]);
    expect(child.stdout).toBe("occupied");
    await guard.releaseRestored();
  });

  it("keeps failed cleanup quarantined across future acquisitions", async () => {
    const first = await acquire();
    await first.quarantine("CLEANUP_FAILED");
    expect(first.state).toBe("quarantined");
    expect(await readRecord()).toMatchObject({
      state: "quarantined",
      ownerId: "attempt-1:1",
      reasonCode: "CLEANUP_FAILED",
    });
    await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_QUARANTINED" });
    await expect(first.releaseRestored()).rejects.toThrow();
  });

  it("does not reclaim an old lock after its owning process exits", async () => {
    const path = join(directory, attemptDesktopLockFileName);
    await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'import { open, writeFile } from "node:fs/promises";',
        'const handle = await open(process.argv[1], "wx", 0o600);',
        "await writeFile(handle, JSON.stringify({",
        '  schemaVersion: "InvestigationAttemptDesktopGuardV1",',
        '  ownerId: "exited-owner", ownerToken: "unknown", processId: process.pid,',
        '  acquiredAt: "1970-01-01T00:00:00.000Z", state: "held", reasonCode: null',
        "}));",
        "await handle.sync();",
        "await handle.close();",
      ].join("\n"),
      path,
    ]);
    const previous = await readFile(path, "utf8");
    await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_QUARANTINED" });
    expect(await readFile(path, "utf8")).toBe(previous);
  });

  it.each(["", "{broken"])("preserves an empty or malformed crash marker: %s", async (marker) => {
    const path = join(directory, attemptDesktopLockFileName);
    await writeFile(path, marker);
    await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_QUARANTINED" });
    expect(await readFile(path, "utf8")).toBe(marker);
  });

  it("never removes a replacement lock belonging to another owner", async () => {
    const guard = await acquire();
    const path = join(directory, attemptDesktopLockFileName);
    await rename(path, `${path}.original`);
    const replacement = '{"ownerToken":"replacement"}';
    await writeFile(path, replacement);
    await expect(guard.releaseRestored()).rejects.toMatchObject({
      code: "DESKTOP_ATTEMPT_LOCK_UNSAFE",
    });
    await expect(guard.quarantine("OWNER_CHANGED")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(replacement);
  });

  it("rejects redirected shared lock directories", async () => {
    const actual = join(directory, "actual");
    const redirected = join(directory, "redirected");
    await mkdir(actual);
    await symlink(actual, redirected, "junction");
    await expect(
      acquireAttemptDesktopGuard({ lockDirectory: redirected, ownerId: "attempt-1" }),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
  });

  it("has exactly one winner for simultaneous owners", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => acquire(`attempt-${index}`)),
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    for (const winner of winners) await winner.value.releaseRestored();
  });

  it.skipIf(process.platform !== "win32")("shares Windows path casing aliases", async () => {
    const guard = await acquireAttemptDesktopGuard({
      lockDirectory: directory.toUpperCase(),
      ownerId: "uppercase-path-owner",
    });
    await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_QUARANTINED" });
    await guard.releaseRestored();
  });
});

describe("attempt desktop cleanup boundary", () => {
  it("holds through prepare, build, UI, and cleanup, then releases before the Server acknowledgement", async () => {
    const guard = await acquire();
    const stages: string[] = [];
    await executeWithAttemptDesktopGuard(guard, async (hooks) => {
      for (const stage of ["prepare", "build", "ui", "cleanup"]) {
        stages.push(stage);
        await expect(acquire("contender")).rejects.toMatchObject({
          code: "DESKTOP_ATTEMPT_QUARANTINED",
        });
      }
      await hooks.onAttemptCleanupConfirmed();
      expect(guard.state).toBe("released");
      stages.push("server-cleanup-acknowledgement");
    });
    expect(stages).toEqual(["prepare", "build", "ui", "cleanup", "server-cleanup-acknowledgement"]);
  });

  it("does not treat an executor resolving as cleanup confirmation", async () => {
    const guard = await acquire();
    await expect(executeWithAttemptDesktopGuard(guard, async () => {})).rejects.toMatchObject({
      code: "DESKTOP_ATTEMPT_CLEANUP_UNCONFIRMED",
    });
    expect(await readRecord()).toMatchObject({
      state: "quarantined",
      reasonCode: "ATTEMPT_CLEANUP_UNCONFIRMED",
    });
  });

  it("quarantines execution or preparation errors without confirmed cleanup", async () => {
    const guard = await acquire();
    const failure = new Error("Synthetic preparation failure.");
    await expect(
      executeWithAttemptDesktopGuard(guard, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(guard.state).toBe("quarantined");
    await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_QUARANTINED" });
  });

  it.each(["CLEANUP_FAILED", "LEASE_LOST"])("retains an explicit %s quarantine", async (reason) => {
    const guard = await acquire();
    await expect(
      executeWithAttemptDesktopGuard(guard, async (hooks) => {
        await hooks.onAttemptCleanupUnconfirmed(reason);
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_CLEANUP_UNCONFIRMED" });
    expect(await readRecord()).toMatchObject({ state: "quarantined", reasonCode: reason });
  });

  it("allows a failed model attempt to release after trusted cleanup", async () => {
    const guard = await acquire();
    const failure = new Error("Synthetic model failure.");
    await expect(
      executeWithAttemptDesktopGuard(guard, async (hooks) => {
        try {
          throw failure;
        } finally {
          await hooks.onAttemptCleanupConfirmed();
        }
      }),
    ).rejects.toBe(failure);
    expect(guard.state).toBe("released");
    await (await acquire()).releaseRestored();
  });

  it("does not recreate a local quarantine when the later Server acknowledgement fails", async () => {
    const guard = await acquire();
    await expect(
      executeWithAttemptDesktopGuard(guard, async (hooks) => {
        await hooks.onAttemptCleanupConfirmed();
        await hooks.onAttemptCleanupUnconfirmed("SERVER_ACK_FAILED");
        throw new Error("Synthetic Server cleanup acknowledgement failure.");
      }),
    ).rejects.toThrow("Server cleanup acknowledgement failure");
    expect(guard.state).toBe("released");
    await (await acquire()).releaseRestored();
  });
});

describe("journal-owned attempt desktop recovery", () => {
  const recovery = (ownerId: string, ownerToken: string): AttemptDesktopGuardRecoveryOptions => ({
    lockDirectory: directory,
    ownerId,
    ownerToken,
    processesStopped: true,
    desktopRestored: true,
    recoveryExclusive: true,
  });
  const marker = (ownerId: string, ownerToken: string, publicationId = randomUUID()) => ({
    schemaVersion: "InvestigationAttemptDesktopGuardV1",
    ownerId,
    ownerToken,
    publicationId,
    processId: 1,
    acquiredAt: "1970-01-01T00:00:00.000Z",
    state: "held",
    reasonCode: null,
  });
  const gateMarker = (ownerId: string, ownerToken: string, publicationId = randomUUID()) => ({
    schemaVersion: "InvestigationDesktopCleanupSerializationV1",
    ownerId,
    ownerToken,
    publicationId,
  });

  it("retains a journal-allocated private token without serializing it", async () => {
    const ownerToken = randomUUID();
    const guard = await acquireAttemptDesktopGuard({
      lockDirectory: directory,
      ownerId: "journal-attempt:1",
      ownerToken,
    });
    expect(guard.ownerToken).toBe(ownerToken);
    expect(JSON.stringify(guard)).not.toContain(ownerToken);
    expect({ ...guard }).not.toHaveProperty("ownerToken");
    expect(await readRecord()).toMatchObject({ ownerToken });
    await guard.releaseRestored();
  });

  it("rejects an invalid journal token before creating any marker", async () => {
    await expect(
      acquireAttemptDesktopGuard({
        lockDirectory: directory,
        ownerId: "journal-attempt:1",
        ownerToken: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
    expect(await readAttemptDesktopGuardStatus({ lockDirectory: directory })).toEqual({
      state: "absent",
      recoveryBlocked: false,
    });
  });

  it("recovers the exact marker written by an exited process", async () => {
    const ownerId = "exited-journal-owner:1";
    const ownerToken = randomUUID();
    await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'import { open } from "node:fs/promises";',
        'const handle = await open(process.argv[1], "wx", 0o600);',
        "await handle.writeFile(process.argv[2]);",
        "await handle.sync();",
        "await handle.close();",
      ].join("\n"),
      join(directory, attemptDesktopLockFileName),
      JSON.stringify(marker(ownerId, ownerToken)),
    ]);
    await expect(recoverAttemptDesktopGuard(recovery(ownerId, ownerToken))).resolves.toEqual({
      state: "released",
    });
    await (await acquire("next-attempt:1")).releaseRestored();
  });

  it("recovers a quarantined owner after cleanup and exclusive native fencing", async () => {
    const guard = await acquire();
    await guard.quarantine("CLEANUP_FAILED");
    await expect(
      recoverAttemptDesktopGuard(recovery("attempt-1:1", guard.ownerToken)),
    ).resolves.toEqual({ state: "released" });
    expect(await readAttemptDesktopGuardStatus({ lockDirectory: directory })).toEqual({
      state: "absent",
      recoveryBlocked: false,
    });
  });

  it("retains its first quarantine reason when cleanup reports the failure again", async () => {
    const guard = await acquire();
    await guard.quarantine("CLEANUP_FAILED");
    const previous = await readFile(join(directory, attemptDesktopLockFileName), "utf8");
    await guard.quarantine("REPEATED_CLEANUP_FAILURE");
    expect(await readFile(join(directory, attemptDesktopLockFileName), "utf8")).toBe(previous);
  });

  it.each(["ownerId", "ownerToken"] as const)("does not alter a different %s", async (field) => {
    const guard = await acquire();
    await guard.quarantine("CLEANUP_FAILED");
    const previous = await readFile(join(directory, attemptDesktopLockFileName), "utf8");
    await expect(
      recoverAttemptDesktopGuard({
        ...recovery("attempt-1:1", guard.ownerToken),
        [field]: field === "ownerToken" ? randomUUID() : "another-owner:1",
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
    expect(await readFile(join(directory, attemptDesktopLockFileName), "utf8")).toBe(previous);
  });

  it.each([
    { processesStopped: false },
    { desktopRestored: false },
    { recoveryExclusive: false },
    { processesStopped: "true" },
    { desktopRestored: 1 },
    { recoveryExclusive: "true" },
    { processesStopped: undefined },
    { recoveryExclusive: undefined },
  ])("requires exact true proofs: %j", async (proofs) => {
    const guard = await acquire();
    await guard.quarantine("CLEANUP_FAILED");
    const previous = await readFile(join(directory, attemptDesktopLockFileName), "utf8");
    await expect(
      recoverAttemptDesktopGuard({
        ...recovery("attempt-1:1", guard.ownerToken),
        ...proofs,
      } as unknown as AttemptDesktopGuardRecoveryOptions),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
    expect(await readFile(join(directory, attemptDesktopLockFileName), "utf8")).toBe(previous);
  });

  it("is idempotent when its main marker is already absent", async () => {
    const options = recovery("finished-owner:1", randomUUID());
    await expect(recoverAttemptDesktopGuard(options)).resolves.toEqual({ state: "already-absent" });
    await expect(recoverAttemptDesktopGuard(options)).resolves.toEqual({ state: "already-absent" });
  });

  it("serializes concurrent recoveries within the current native generation", async () => {
    const guard = await acquire();
    await guard.quarantine("CLEANUP_FAILED");
    const options = recovery("attempt-1:1", guard.ownerToken);
    await writeFile(
      join(directory, attemptDesktopRecoveryLockFileName),
      JSON.stringify(gateMarker(options.ownerId, options.ownerToken)),
    );
    await expect(
      Promise.all([recoverAttemptDesktopGuard(options), recoverAttemptDesktopGuard(options)]),
    ).resolves.toEqual([{ state: "released" }, { state: "already-absent" }]);
    await (await acquire("next-owner:1")).releaseRestored();
  });

  it("never releases a replacement owner after the journal's old lock was moved", async () => {
    const previousOwner = await acquire();
    await previousOwner.quarantine("CLEANUP_FAILED");
    const path = join(directory, attemptDesktopLockFileName);
    await rename(path, path + ".previous");
    const replacement = await acquire("replacement-owner:2");
    const contents = await readFile(path, "utf8");
    await expect(
      recoverAttemptDesktopGuard(recovery("attempt-1:1", previousOwner.ownerToken)),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
    expect(await readFile(path, "utf8")).toBe(contents);
    await replacement.releaseRestored();
  });

  it("rejects an unknown hard link without deleting either name", async () => {
    const guard = await acquire();
    await guard.quarantine("CLEANUP_FAILED");
    const path = join(directory, attemptDesktopLockFileName);
    const alias = path + ".unknown-alias";
    await link(path, alias);
    const contents = await readFile(path, "utf8");
    await expect(
      recoverAttemptDesktopGuard(recovery("attempt-1:1", guard.ownerToken)),
    ).rejects.toThrow();
    expect(await readFile(alias, "utf8")).toBe(contents);
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("rejects a redirected directory without altering its matching marker", async () => {
    const actual = join(directory, "actual");
    const redirected = join(directory, "redirected");
    await mkdir(actual);
    const guard = await acquireAttemptDesktopGuard({ lockDirectory: actual, ownerId: "owner:1" });
    await guard.quarantine("CLEANUP_FAILED");
    await symlink(actual, redirected, "junction");
    const path = join(actual, attemptDesktopLockFileName);
    const contents = await readFile(path, "utf8");
    await expect(
      recoverAttemptDesktopGuard({
        ...recovery("owner:1", guard.ownerToken),
        lockDirectory: redirected,
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("rejects a reparse point in place of the main marker", async () => {
    const actual = join(directory, "redirect-target");
    await mkdir(actual);
    await symlink(actual, join(directory, attemptDesktopLockFileName), "junction");
    await expect(
      recoverAttemptDesktopGuard(recovery("owner:1", randomUUID())),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
  });

  it("returns sanitized status and fixed malformed-record errors", async () => {
    const guard = await acquire();
    await guard.quarantine("CLEANUP_FAILED");
    const status = await readAttemptDesktopGuardStatus({ lockDirectory: directory });
    expect(status).toMatchObject({ state: "quarantined", ownerId: "attempt-1:1" });
    expect(JSON.stringify(status)).not.toContain(guard.ownerToken);
    expect(status).not.toHaveProperty("ownerToken");
    await writeFile(
      join(directory, attemptDesktopLockFileName),
      '{"ownerToken":"' + guard.ownerToken + '"',
    );
    for (const operation of [
      () => readAttemptDesktopGuardStatus({ lockDirectory: directory }),
      () => recoverAttemptDesktopGuard(recovery("attempt-1:1", guard.ownerToken)),
    ]) {
      const error = await operation().catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
      expect(String(error)).not.toContain(guard.ownerToken);
    }
  });

  it("reports an unknown serialization marker without guessing its owner", async () => {
    const path = join(directory, attemptDesktopRecoveryLockFileName);
    await writeFile(path, "uncertain");
    expect(await readAttemptDesktopGuardStatus({ lockDirectory: directory })).toEqual({
      state: "absent",
      recoveryBlocked: true,
    });
    await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_QUARANTINED" });
    await expect(
      recoverAttemptDesktopGuard(recovery("owner:1", randomUUID())),
    ).rejects.toMatchObject({
      code: "DESKTOP_ATTEMPT_LOCK_UNSAFE",
    });
    expect(await readFile(path, "utf8")).toBe("uncertain");
  });

  it.each([true, false])(
    "recovers its exact stale serialization owner with a remaining main marker: %s",
    async (hasMain) => {
      const ownerId = "recovery-owner:1";
      const ownerToken = randomUUID();
      if (hasMain)
        await writeFile(
          join(directory, attemptDesktopLockFileName),
          JSON.stringify(marker(ownerId, ownerToken)),
        );
      await writeFile(
        join(directory, attemptDesktopRecoveryLockFileName),
        JSON.stringify(gateMarker(ownerId, ownerToken)),
      );
      await expect(recoverAttemptDesktopGuard(recovery(ownerId, ownerToken))).resolves.toEqual({
        state: hasMain ? "released" : "already-absent",
      });
      expect(await readAttemptDesktopGuardStatus({ lockDirectory: directory })).toEqual({
        state: "absent",
        recoveryBlocked: false,
      });
    },
  );

  it("never reclaims a serialization marker from a different journal owner", async () => {
    const path = join(directory, attemptDesktopRecoveryLockFileName);
    const previous = JSON.stringify(gateMarker("other-owner:1", randomUUID()));
    await writeFile(path, previous);
    await expect(
      recoverAttemptDesktopGuard(recovery("recovery-owner:1", randomUUID())),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
    expect(await readFile(path, "utf8")).toBe(previous);
  });

  it.each(["main", "serialization"] as const)(
    "finishes only its recognized interrupted %s publication",
    async (kind) => {
      const ownerId = "publication-owner:1";
      const ownerToken = randomUUID();
      const publicationId = randomUUID();
      const name =
        kind === "main" ? attemptDesktopLockFileName : attemptDesktopRecoveryLockFileName;
      const path = join(directory, name);
      const stagedPath = path + "." + publicationId + ".pending";
      const record =
        kind === "main"
          ? marker(ownerId, ownerToken, publicationId)
          : gateMarker(ownerId, ownerToken, publicationId);
      await writeFile(stagedPath, JSON.stringify(record));
      await link(stagedPath, path);
      await expect(recoverAttemptDesktopGuard(recovery(ownerId, ownerToken))).resolves.toEqual({
        state: kind === "main" ? "released" : "already-absent",
      });
      await expect(readFile(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("serializes a guard's release and later quarantine without touching a new owner", async () => {
    const guard = await acquire();
    await Promise.all([guard.releaseRestored(), guard.quarantine("SERVER_ACK_FAILED")]);
    const next = await acquire("next-owner:1");
    await guard.quarantine("LATE_ACK_FAILURE");
    expect(await readRecord()).toMatchObject({
      ownerId: "next-owner:1",
      ownerToken: next.ownerToken,
    });
    await next.releaseRestored();
  });
});

describe("managed desktop cleanup settlement", () => {
  const proof = (ownerToken: string): AttemptDesktopGuardRecoveryOptions => ({
    lockDirectory: directory,
    ownerId: "attempt-1:1",
    ownerToken,
    processesStopped: true,
    desktopRestored: true,
    recoveryExclusive: true,
  });

  it.each(["released", "quarantined"] as const)(
    "settles %s without changing any marker or creating a serialization gate",
    async (state) => {
      const guard = await acquire();
      const path = join(directory, attemptDesktopLockFileName);
      const contents = await readFile(path, "utf8");
      const entries = await readdir(directory);
      const identity = await lstat(path, { bigint: true });
      await guard.settleManagedCleanup(state);
      expect(guard.state).toBe(state);
      expect(await readFile(path, "utf8")).toBe(contents);
      expect(await readdir(directory)).toEqual(entries);
      expect(await lstat(path, { bigint: true })).toMatchObject({
        dev: identity.dev,
        ino: identity.ino,
        nlink: identity.nlink,
        size: identity.size,
      });
      expect(await readRecord()).toMatchObject({ state: "held", reasonCode: null });
      await guard.settleManagedCleanup(state);
      expect(await readFile(path, "utf8")).toBe(contents);
      expect(await readdir(directory)).toEqual(entries);
    },
  );

  it("retains held bytes after managed failure and permits subsequent trusted recovery", async () => {
    const guard = await acquire();
    const contents = await readFile(join(directory, attemptDesktopLockFileName), "utf8");
    await guard.settleManagedCleanup("quarantined");
    expect(await readRecord()).toMatchObject({ state: "held", reasonCode: null });
    await expect(guard.releaseRestored()).rejects.toMatchObject({
      code: "DESKTOP_ATTEMPT_QUARANTINED",
    });
    expect(await readFile(join(directory, attemptDesktopLockFileName), "utf8")).toBe(contents);
    await expect(recoverAttemptDesktopGuard(proof(guard.ownerToken))).resolves.toEqual({
      state: "released",
    });
    await guard.settleManagedCleanup("released");
    expect(guard.state).toBe("released");
    await guard.settleManagedCleanup("quarantined");
    expect(guard.state).toBe("released");
    expect(await readdir(directory)).toEqual([]);
  });

  it("cannot touch a subsequent owner when managed settlement is repeated", async () => {
    const guard = await acquire();
    await recoverAttemptDesktopGuard(proof(guard.ownerToken));
    await guard.settleManagedCleanup("released");
    const next = await acquire("next-managed-owner:1");
    const path = join(directory, attemptDesktopLockFileName);
    const contents = await readFile(path, "utf8");
    const entries = await readdir(directory);
    await Promise.all([
      guard.settleManagedCleanup("released"),
      guard.settleManagedCleanup("quarantined"),
      guard.releaseRestored(),
      guard.quarantine("LATE_FAILURE"),
    ]);
    expect(guard.state).toBe("released");
    expect(await readFile(path, "utf8")).toBe(contents);
    expect(await readdir(directory)).toEqual(entries);
    await next.releaseRestored();
  });

  it.each(["held", "", null, undefined, 1, true])(
    "rejects an invalid managed state without changing held ownership: %s",
    async (state) => {
      const guard = await acquire();
      const path = join(directory, attemptDesktopLockFileName);
      const contents = await readFile(path, "utf8");
      const entries = await readdir(directory);
      await expect(
        guard.settleManagedCleanup(
          state as unknown as Parameters<AttemptDesktopGuard["settleManagedCleanup"]>[0],
        ),
      ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
      expect(guard.state).toBe("held");
      expect(await readFile(path, "utf8")).toBe(contents);
      expect(await readdir(directory)).toEqual(entries);
      await guard.releaseRestored();
    },
  );

  it("validates managed state even after release is terminal", async () => {
    const guard = await acquire();
    await guard.releaseRestored();
    await expect(
      guard.settleManagedCleanup(
        "held" as Parameters<AttemptDesktopGuard["settleManagedCleanup"]>[0],
      ),
    ).rejects.toMatchObject({ code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
    expect(guard.state).toBe("released");
    expect(await readdir(directory)).toEqual([]);
  });

  it("queues settlement behind an active direct quarantine before confirming managed release", async () => {
    const guard = await acquire();
    await Promise.all([
      guard.quarantine("DIRECT_CLEANUP_FAILED"),
      guard.settleManagedCleanup("quarantined"),
    ]);
    expect(guard.state).toBe("quarantined");
    expect(await readRecord()).toMatchObject({ state: "quarantined" });
    await recoverAttemptDesktopGuard(proof(guard.ownerToken));
    await guard.settleManagedCleanup("released");
    expect(guard.state).toBe("released");
    expect(await readdir(directory)).toEqual([]);
  });
});
