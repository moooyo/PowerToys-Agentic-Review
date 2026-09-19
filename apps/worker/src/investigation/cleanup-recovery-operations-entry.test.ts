import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  type CleanupRecoveryEntryOperations,
  runCleanupRecoveryOperationsEntry,
} from "./cleanup-recovery-operations-entry.js";
import {
  type CleanupRecoveryOperation,
  cleanupRecoveryMaximumInputBytes,
} from "./cleanup-recovery-operations-protocol.js";

const workspace: CleanupRecoveryOperation = {
  operation: "workspace",
  workspaceRootDirectory: "C:\\WorkerData\\attempts",
  taskId: "task-1",
  attemptId: "attempt-1",
  leaseVersion: 3,
  ownership: {
    schemaVersion: "InvestigationWorkspaceOwnershipReceiptV1",
    workspaceRootDirectory: "C:\\WorkerData\\attempts",
    taskId: "task-1",
    attemptId: "attempt-1",
    leaseVersion: 3,
    nonce: "1b51c23f-c25f-4527-bbf2-a568375b9249",
    rootIdentity: "volume:root",
    attemptIdentity: "volume:attempt",
    ownerIdentity: "volume:owner",
    ownerDigest: "d".repeat(64),
  },
  processesStopped: true,
};
const guard: Extract<CleanupRecoveryOperation, { operation: "guard" }> = {
  operation: "guard",
  lockDirectory: "C:\\ProgramData\\AgenticReview\\desktop",
  ownerId: "attempt-1:3",
  ownerToken: "2b51c23f-c25f-4527-bbf2-a568375b9249",
  processesStopped: true,
  desktopRestored: true,
  recoveryExclusive: true,
};

function fixture() {
  const heldGuard = {
    state: "held" as const,
    ownerToken: guard.ownerToken,
    releaseRestored: vi.fn(async () => undefined),
    quarantine: vi.fn(async () => undefined),
    settleManagedCleanup: vi.fn(async () => undefined),
  };
  const operations = {
    acquireGuard: vi
      .fn<CleanupRecoveryEntryOperations["acquireGuard"]>()
      .mockResolvedValue(heldGuard),
    cleanupWorkspace: vi
      .fn<CleanupRecoveryEntryOperations["cleanupWorkspace"]>()
      .mockResolvedValue({ state: "removed" }),
    assertWorkspaceAbsent: vi
      .fn<CleanupRecoveryEntryOperations["assertWorkspaceAbsent"]>()
      .mockResolvedValue(undefined),
    releaseGuard: vi
      .fn<CleanupRecoveryEntryOperations["releaseGuard"]>()
      .mockResolvedValue({ state: "released" }),
  };
  const writeResult = vi.fn<(line: string) => void>();
  const run = (input: unknown) =>
    runCleanupRecoveryOperationsEntry(
      Readable.from([Buffer.from(JSON.stringify(input))]),
      writeResult,
      operations,
    );
  return { heldGuard, operations, writeResult, run };
}

describe("managed cleanup recovery entry", () => {
  it("acquires the exact private guard and only closes its handle before returning", async () => {
    const f = fixture();
    const request = {
      operation: "guard-acquire",
      lockDirectory: guard.lockDirectory,
      ownerId: guard.ownerId,
      ownerToken: guard.ownerToken,
    };
    expect(await f.run(request)).toBe(0);
    const { operation: _operation, ...owner } = request;
    expect(f.operations.acquireGuard).toHaveBeenCalledWith(owner);
    expect(f.heldGuard.settleManagedCleanup).toHaveBeenCalledWith("quarantined");
    expect(f.heldGuard.quarantine).not.toHaveBeenCalled();
    expect(f.heldGuard.releaseRestored).not.toHaveBeenCalled();
    expect(f.operations.releaseGuard).not.toHaveBeenCalled();
    expect(f.writeResult).toHaveBeenCalledExactlyOnceWith('{"completed":true}\n');
  });

  it("keeps acquisition failure private and does not confirm a published marker when handle settlement fails", async () => {
    const f = fixture();
    f.heldGuard.settleManagedCleanup.mockRejectedValue(
      new Error(`Private owner ${guard.ownerToken}`),
    );
    expect(
      await f.run({
        operation: "guard-acquire",
        lockDirectory: guard.lockDirectory,
        ownerId: guard.ownerId,
        ownerToken: guard.ownerToken,
      }),
    ).toBe(1);
    expect(f.operations.acquireGuard).toHaveBeenCalledTimes(1);
    expect(f.operations.releaseGuard).not.toHaveBeenCalled();
    expect(f.writeResult).toHaveBeenCalledExactlyOnceWith('{"code":"CLEANUP_RECOVERY_FAILED"}\n');
  });

  it("removes only the supplied workspace owner using the fixed tree limit", async () => {
    const f = fixture();
    expect(await f.run(workspace)).toBe(0);
    const { operation: _operation, ...request } = workspace;
    expect(f.operations.cleanupWorkspace).toHaveBeenCalledWith({
      ...request,
      maximumTreeEntries: 250_000,
    });
    expect(f.operations.assertWorkspaceAbsent).not.toHaveBeenCalled();
    expect(f.operations.releaseGuard).not.toHaveBeenCalled();
    expect(f.writeResult).toHaveBeenCalledExactlyOnceWith('{"completed":true}\n');
  });

  it("checks absence without deleting when the journal has no workspace ownership receipt", async () => {
    const f = fixture();
    expect(await f.run({ ...workspace, ownership: null })).toBe(0);
    expect(f.operations.assertWorkspaceAbsent).toHaveBeenCalledWith({
      workspaceRootDirectory: workspace.workspaceRootDirectory,
      taskId: workspace.taskId,
      attemptId: workspace.attemptId,
      leaseVersion: workspace.leaseVersion,
    });
    expect(f.operations.cleanupWorkspace).not.toHaveBeenCalled();
    expect(f.operations.releaseGuard).not.toHaveBeenCalled();
  });

  it("releases only the supplied guard with all required cleanup proofs", async () => {
    const f = fixture();
    expect(await f.run(guard)).toBe(0);
    const { operation: _operation, ...request } = guard;
    expect(f.operations.releaseGuard).toHaveBeenCalledWith(request);
    expect(f.operations.cleanupWorkspace).not.toHaveBeenCalled();
    expect(f.operations.assertWorkspaceAbsent).not.toHaveBeenCalled();
    expect(f.writeResult).toHaveBeenCalledExactlyOnceWith('{"completed":true}\n');
    expect(JSON.stringify(f.writeResult.mock.calls)).not.toContain(guard.ownerToken);
  });

  it.each([
    { ...workspace, processesStopped: false },
    { ...workspace, command: "Remove unrelated files" },
    { ...workspace, lease: { leaseToken: "private-server-lease" } },
    { ...workspace, workspaceRootDirectory: "C:\\" },
    { ...workspace, workspaceRootDirectory: "..\\attempts" },
    { ...workspace, ownership: { ...workspace.ownership, attemptId: "different-attempt" } },
    { ...workspace, ownership: { ...workspace.ownership, extra: true } },
    { ...guard, recoveryExclusive: false },
    { ...guard, desktopRestored: false },
    { ...guard, processesStopped: false },
    { ...guard, ownerToken: `${guard.ownerToken}\n` },
    { ...guard, module: "arbitrary-module" },
    { operation: "guard-acquire", lockDirectory: guard.lockDirectory, ownerId: guard.ownerId },
    { ...guard, operation: "guard-acquire" },
    { operation: "command", command: "arbitrary-command" },
  ])(
    "rejects incomplete proofs, unbound ownership, and extra fields before any cleanup",
    async (request) => {
      const f = fixture();
      expect(await f.run(request)).toBe(1);
      expect(f.operations.cleanupWorkspace).not.toHaveBeenCalled();
      expect(f.operations.assertWorkspaceAbsent).not.toHaveBeenCalled();
      expect(f.operations.releaseGuard).not.toHaveBeenCalled();
      expect(f.operations.acquireGuard).not.toHaveBeenCalled();
      expect(f.writeResult).toHaveBeenCalledExactlyOnceWith(
        '{"code":"CLEANUP_RECOVERY_INPUT_INVALID"}\n',
      );
    },
  );

  it("rejects input exceeding 64 KiB before parsing or touching any workspace", async () => {
    const f = fixture();
    const input = Readable.from([
      Buffer.alloc(cleanupRecoveryMaximumInputBytes, 0x20),
      Buffer.from(JSON.stringify(workspace)),
    ]);
    expect(await runCleanupRecoveryOperationsEntry(input, f.writeResult, f.operations)).toBe(1);
    expect(f.operations.cleanupWorkspace).not.toHaveBeenCalled();
    expect(f.operations.assertWorkspaceAbsent).not.toHaveBeenCalled();
    expect(f.operations.releaseGuard).not.toHaveBeenCalled();
    expect(f.operations.acquireGuard).not.toHaveBeenCalled();
    expect(f.writeResult).toHaveBeenCalledExactlyOnceWith(
      '{"code":"CLEANUP_RECOVERY_INPUT_INVALID"}\n',
    );
  });

  it.each([Buffer.from("malformed private JSON"), Buffer.from([0xff])])(
    "rejects malformed JSON and UTF-8 with no raw input in its response",
    async (input) => {
      const f = fixture();
      expect(
        await runCleanupRecoveryOperationsEntry(
          Readable.from([input]),
          f.writeResult,
          f.operations,
        ),
      ).toBe(1);
      expect(f.writeResult).toHaveBeenCalledExactlyOnceWith(
        '{"code":"CLEANUP_RECOVERY_INPUT_INVALID"}\n',
      );
      expect(f.operations.cleanupWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    { code: "DESKTOP_ATTEMPT_LOCK_UNSAFE", expected: "DESKTOP_ATTEMPT_LOCK_UNSAFE" },
    { code: "PRIVATE_ORIGINAL_LEASE", expected: "CLEANUP_RECOVERY_FAILED" },
  ])("returns only an allowlisted failure code and exit status 1", async ({ code, expected }) => {
    const f = fixture();
    f.operations.releaseGuard.mockRejectedValue(
      Object.assign(new Error(`Private owner ${guard.ownerToken}`), { code }),
    );
    expect(await f.run(guard)).toBe(1);
    expect(f.writeResult).toHaveBeenCalledExactlyOnceWith(
      `${JSON.stringify({ code: expected })}\n`,
    );
    expect(JSON.stringify(f.writeResult.mock.calls)).not.toContain(guard.ownerToken);
  });
});
