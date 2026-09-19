import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessHostRecoverySnapshot,
} from "../execution/process-host-protocol.js";
import type { AttemptCleanupIdentity } from "./attempt-cleanup-journal.js";
import { createCleanupRecoveryOperations } from "./cleanup-recovery-operations.js";
import type { InvestigationWorkspaceOwnershipReceipt } from "./workspace.js";

const previous: ProcessHostRecoverySnapshot = {
  capability: "named-job-tree-v1",
  instanceKey: "a".repeat(64),
  generation: "b".repeat(64),
  previousTreeDrained: true,
};
const current: ProcessHostRecoverySnapshot = { ...previous, generation: "c".repeat(64) };
const identity: AttemptCleanupIdentity = {
  schemaVersion: "InvestigationAttemptCleanupIdentityV1",
  taskId: "task-1",
  attemptId: "attempt-1",
  workerId: "worker-1",
  serverOrigin: "https://synthetic-worker.example",
  lease: { attemptId: "attempt-1", fence: 3, leaseToken: "private-original-server-lease" },
  guardOwnerId: "attempt-1:3",
  guardOwnerToken: "2b51c23f-c25f-4527-bbf2-a568375b9249",
  journalDirectory: "C:\\WorkerData\\cleanup-journal",
  workspaceRootDirectory: "C:\\WorkerData\\attempts",
  desktopLockDirectory: "C:\\ProgramData\\AgenticReview\\desktop",
  processHostInstanceKey: previous.instanceKey,
  processHostRecovery: previous,
  registeredAt: "2026-09-19T00:00:00.000Z",
};
const ownership: InvestigationWorkspaceOwnershipReceipt = {
  schemaVersion: "InvestigationWorkspaceOwnershipReceiptV1",
  workspaceRootDirectory: identity.workspaceRootDirectory,
  taskId: identity.taskId,
  attemptId: identity.attemptId,
  leaseVersion: identity.lease.fence,
  nonce: "1b51c23f-c25f-4527-bbf2-a568375b9249",
  rootIdentity: "volume:root",
  attemptIdentity: "volume:attempt",
  ownerIdentity: "volume:owner",
  ownerDigest: "d".repeat(64),
};

function managedProcess(
  stdout = '{"completed":true}\n',
  stderr = "",
  exitCode = 0,
): ManagedProcess {
  const exit: ProcessExitedEvent = {
    protocolVersion: "1.0",
    type: "exited",
    requestId: "cleanup:one",
    exitCode,
    signal: null,
    outputTruncated: false,
  };
  return {
    requestId: exit.requestId,
    processId: 42,
    stdout: Readable.from([Buffer.from(stdout)]),
    stderr: Readable.from([Buffer.from(stderr)]),
    completed: Promise.resolve(exit),
    terminate: async () => undefined,
  };
}

function fixture() {
  const recovery = vi.fn<() => ProcessHostRecoverySnapshot | undefined>(() => current);
  const start = vi.fn<ProcessHostClient["start"]>(async (_spec, _signal, onDispatch) => {
    onDispatch?.();
    return managedProcess();
  });
  const processHost: ProcessHostClient = {
    recovery,
    start,
    terminateAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const options = {
    processHost,
    nodeExecutablePath: "C:\\TrustedTools\\node.exe",
    entryPath: "C:\\TrustedTools\\cleanup-recovery-operations.mjs",
    workingDirectory: "C:\\WorkerData",
    environment: { SYSTEMROOT: "C:\\Windows" },
    limits: {
      hardTimeoutMs: 30_000,
      maximumProcessCount: 1,
      maximumMemoryBytes: 128 * 1024 * 1024,
      maximumOutputBytes: 4_096,
    },
  };
  return { recovery, start, options, operations: createCleanupRecoveryOperations(options) };
}

describe("native managed cleanup recovery operations", () => {
  it("acquires the initial guard inside the native Job without parent-owned filesystem mutation", async () => {
    const f = fixture();
    await f.operations.acquireGuard(identity);
    const spec = f.start.mock.calls[0]![0];
    expect(JSON.parse(spec.standardInput!)).toEqual({
      operation: "guard-acquire",
      lockDirectory: identity.desktopLockDirectory,
      ownerId: identity.guardOwnerId,
      ownerToken: identity.guardOwnerToken,
    });
    expect(spec.arguments).toEqual([f.options.entryPath]);
    expect(JSON.stringify(spec.arguments)).not.toContain(identity.guardOwnerToken);
    expect(JSON.stringify(spec.environment)).not.toContain(identity.guardOwnerToken);
    expect(JSON.stringify(spec)).not.toContain(identity.lease.leaseToken);
  });

  it("sends only the exact workspace owner through native stdin, without Server or guard credentials", async () => {
    const f = fixture();
    await f.operations.cleanupWorkspace(identity, ownership);
    expect(f.start).toHaveBeenCalledTimes(1);
    const spec = f.start.mock.calls[0]![0];
    expect(spec.executable).toBe(f.options.nodeExecutablePath);
    expect(spec.arguments).toEqual([f.options.entryPath]);
    expect(spec.environmentMode).toBe("replace");
    expect(spec.interactiveStdin).toBeUndefined();
    expect(JSON.parse(spec.standardInput!)).toEqual({
      operation: "workspace",
      workspaceRootDirectory: identity.workspaceRootDirectory,
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      leaseVersion: identity.lease.fence,
      ownership,
      processesStopped: true,
    });
    expect(JSON.stringify(spec)).not.toContain(identity.lease.leaseToken);
    expect(JSON.stringify(spec)).not.toContain(identity.guardOwnerToken);
    expect(f.options.processHost.close).not.toHaveBeenCalled();
    expect(f.options.processHost.terminateAll).not.toHaveBeenCalled();
  });

  it("sends the guard credential only through stdin after native recovery is available", async () => {
    const f = fixture();
    await f.operations.releaseGuard(identity);
    const spec = f.start.mock.calls[0]![0];
    expect(JSON.parse(spec.standardInput!)).toEqual({
      operation: "guard",
      lockDirectory: identity.desktopLockDirectory,
      ownerId: identity.guardOwnerId,
      ownerToken: identity.guardOwnerToken,
      processesStopped: true,
      desktopRestored: true,
      recoveryExclusive: true,
    });
    expect(JSON.stringify(spec.arguments)).not.toContain(identity.guardOwnerToken);
    expect(JSON.stringify(spec.environment)).not.toContain(identity.guardOwnerToken);
    expect(JSON.stringify(spec)).not.toContain(identity.lease.leaseToken);
  });

  it("preserves the absence-only operation when no workspace receipt exists", async () => {
    const f = fixture();
    await f.operations.cleanupWorkspace(identity, null);
    expect(JSON.parse(f.start.mock.calls[0]![0].standardInput!)).toMatchObject({ ownership: null });
  });

  it.each([
    undefined,
    { ...current, instanceKey: "e".repeat(64) },
    { ...current, previousTreeDrained: false } as unknown as ProcessHostRecoverySnapshot,
    { ...current, capability: "legacy" } as unknown as ProcessHostRecoverySnapshot,
  ])(
    "rejects missing, foreign, or invalid live native proof before launching a child",
    async (proof) => {
      const f = fixture();
      f.recovery.mockReturnValue(proof);
      await expect(f.operations.releaseGuard(identity)).rejects.toMatchObject({
        code: "CLEANUP_RECOVERY_HOST_UNAVAILABLE",
      });
      expect(f.start).not.toHaveBeenCalled();
    },
  );

  it("rejects a Host without the native recovery capability", async () => {
    const f = fixture();
    const { recovery: _recovery, ...legacyHost } = f.options.processHost;
    const operations = createCleanupRecoveryOperations({ ...f.options, processHost: legacyHost });
    await expect(operations.cleanupWorkspace(identity, ownership)).rejects.toMatchObject({
      code: "CLEANUP_RECOVERY_HOST_UNAVAILABLE",
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("checks native ownership again immediately before the start call", async () => {
    const f = fixture();
    f.recovery.mockReturnValueOnce(current).mockReturnValue(undefined);
    await expect(f.operations.releaseGuard(identity)).rejects.toMatchObject({
      code: "CLEANUP_RECOVERY_HOST_UNAVAILABLE",
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("checks native ownership at dispatch rather than relying on a cached snapshot", async () => {
    const f = fixture();
    let dispatched = false;
    f.start.mockImplementation(async (_spec, _signal, onDispatch) => {
      f.recovery.mockReturnValue(undefined);
      onDispatch?.();
      dispatched = true;
      return managedProcess();
    });
    await expect(f.operations.releaseGuard(identity)).rejects.toMatchObject({
      code: "CLEANUP_RECOVERY_HOST_UNAVAILABLE",
    });
    expect(dispatched).toBe(false);
  });

  it("does not confirm completion after the native Host loses its generation", async () => {
    const f = fixture();
    f.start.mockImplementation(async (_spec, _signal, onDispatch) => {
      onDispatch?.();
      f.recovery.mockReturnValue({ ...current, generation: "f".repeat(64) });
      return managedProcess();
    });
    await expect(f.operations.cleanupWorkspace(identity, ownership)).rejects.toMatchObject({
      code: "CLEANUP_RECOVERY_HOST_UNAVAILABLE",
    });
  });

  it("retains a known cleanup failure code without exposing the request", async () => {
    const f = fixture();
    f.start.mockResolvedValue(managedProcess('{"code":"WORKSPACE_NOT_OWNED"}\n', "", 1));
    const error: unknown = await f.operations
      .cleanupWorkspace(identity, ownership)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "WORKSPACE_NOT_OWNED" });
    expect(JSON.stringify(error)).not.toContain(ownership.nonce);
    expect(JSON.stringify(error)).not.toContain(identity.lease.leaseToken);
  });

  it.each([
    { stdout: '{"completed":false}', stderr: "", exitCode: 0 },
    { stdout: '{"completed":true,"secret":"private"}', stderr: "", exitCode: 0 },
    { stdout: "private-output", stderr: "private-error", exitCode: 1 },
    { stdout: "x".repeat(8_192), stderr: "", exitCode: 0 },
  ])(
    "rejects an invalid or failed helper receipt without exposing child output",
    async (result) => {
      const f = fixture();
      f.start.mockResolvedValue(managedProcess(result.stdout, result.stderr, result.exitCode));
      const error: unknown = await f.operations
        .releaseGuard(identity)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe(
        "CleanupRecoveryOperationError: Managed cleanup recovery did not complete.",
      );
      expect(JSON.stringify(error)).not.toMatch(/private|2b51c23f|original-server-lease/);
      expect(error).not.toHaveProperty("cause");
    },
  );

  it("rejects ownership mismatches and Node module injection before launch", async () => {
    const f = fixture();
    await expect(
      f.operations.cleanupWorkspace(identity, { ...ownership, attemptId: "other-attempt" }),
    ).rejects.toMatchObject({
      code: "CLEANUP_RECOVERY_INPUT_INVALID",
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(() =>
      createCleanupRecoveryOperations({
        ...f.options,
        environment: { NODE_OPTIONS: "--import=private-module" },
      }),
    ).toThrow("Managed cleanup recovery did not complete.");
  });

  it("requires an executable Node path and a separate ESM helper entry", () => {
    const f = fixture();
    expect(() =>
      createCleanupRecoveryOperations({
        ...f.options,
        nodeExecutablePath: "C:\\TrustedTools\\node.mjs",
      }),
    ).toThrow("Managed cleanup recovery did not complete.");
    expect(() =>
      createCleanupRecoveryOperations({
        ...f.options,
        entryPath: "C:\\TrustedTools\\other.exe",
      }),
    ).toThrow("Managed cleanup recovery did not complete.");
    expect(f.start).not.toHaveBeenCalled();
  });
});
