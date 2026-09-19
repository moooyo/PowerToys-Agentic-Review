import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessHostRecoverySnapshot } from "../execution/process-host-protocol.js";
import {
  type AttemptCleanupIdentity,
  type AttemptCleanupRecoveryActions,
  InvestigationAttemptCleanupJournal,
} from "./attempt-cleanup-journal.js";

let directory: string;
const previous: ProcessHostRecoverySnapshot = {
  capability: "named-job-tree-v1",
  instanceKey: "a".repeat(64),
  generation: "b".repeat(64),
  previousTreeDrained: true,
};
const current: ProcessHostRecoverySnapshot = { ...previous, generation: "c".repeat(64) };
beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), "cleanup-journal-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const journal = () => new InvestigationAttemptCleanupJournal({ directory });
const registration = () => ({
  taskId: "task-1",
  attemptId: "attempt-1",
  workerId: "worker-1",
  serverOrigin: "https://synthetic-worker.example",
  lease: { attemptId: "attempt-1", fence: 3, leaseToken: "private-original-lease" },
  guardOwnerId: "attempt-1:3",
  workspaceRootDirectory: join(directory, "workspaces"),
  desktopLockDirectory: join(directory, "desktop"),
  processHostInstanceKey: previous.instanceKey,
  processHostRecovery: previous,
});
function actions(): AttemptCleanupRecoveryActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    processHostRecovery: current,
    cleanupWorkspace: vi.fn(async () => {
      calls.push("workspace");
    }),
    releaseGuard: vi.fn(async () => {
      calls.push("guard");
    }),
    acknowledge: vi.fn(async () => {
      calls.push("ack");
    }),
  };
}

describe("durable attempt cleanup journal", () => {
  it("retains original fenced credentials before any side effect can start and exposes only sanitized status", async () => {
    const first = journal();
    const identity = await first.register(registration());
    const files = await readdir(directory);
    const persisted = JSON.parse(
      await readFile(
        join(directory, files.find((name) => name.endsWith(".identity.json"))!),
        "utf8",
      ),
    );
    expect(persisted.lease).toEqual(registration().lease);
    expect(persisted.guardOwnerToken).toBe(identity.guardOwnerToken);
    const restarted = journal();
    expect(await restarted.statuses()).toMatchObject([
      { executionStarted: false, state: "awaiting_cleanup", missingProofs: [] },
    ]);
    expect(JSON.stringify(await restarted.statuses())).not.toContain(identity.lease.leaseToken);
    expect(JSON.stringify(await restarted.statuses())).not.toContain(identity.guardOwnerToken);
  });

  it("restarts into cleanup only, preserves the original lease, and waits for desktop restoration", async () => {
    const first = journal();
    const identity = await first.register(registration());
    await first.executionStarted(identity.attemptId);
    const resumed = journal();
    const recovery = actions();
    expect(await resumed.recover(recovery)).toMatchObject([
      { missingProofs: ["desktop_restored"] },
    ]);
    expect(recovery.calls).toEqual([]);
    await resumed.confirmRecovery(identity.attemptId, {
      operator: "test-operator",
      reason: "Restored the dedicated desktop after native process-tree recovery.",
      desktopRestored: true,
      ownedProcessTreeStopped: false,
    });
    expect(await resumed.recover(recovery)).toMatchObject([{ state: "acknowledged" }]);
    expect(recovery.calls).toEqual(["workspace", "guard", "ack"]);
    expect(recovery.acknowledge).toHaveBeenCalledWith(identity);
    // Recovery has no model, task executor, or source preparation callback.
    expect(Object.keys(recovery).sort()).toEqual([
      "acknowledge",
      "calls",
      "cleanupWorkspace",
      "processHostRecovery",
      "releaseGuard",
    ]);
  });

  it("never turns PID absence, the same host generation, or legacy ownership into automatic process proof", async () => {
    const first = journal();
    await first.register({ ...registration(), processHostRecovery: null });
    await first.executionStarted("attempt-1");
    await first.confirmRecovery("attempt-1", {
      operator: "test-operator",
      reason: "The desktop has been restored; process ownership is still unknown.",
      desktopRestored: true,
      ownedProcessTreeStopped: false,
    });
    const recovery = actions();
    expect(await journal().recover(recovery)).toMatchObject([
      { missingProofs: ["owned_process_tree_stopped"] },
    ]);
    expect(recovery.calls).toEqual([]);
    await first.confirmRecovery("attempt-1", {
      operator: "test-operator",
      reason: "Independently verified the original host and complete owned process tree stopped.",
      desktopRestored: true,
      ownedProcessTreeStopped: true,
    });
    expect(await journal().recover(recovery)).toMatchObject([{ state: "acknowledged" }]);
  });

  it("retries an unknown acknowledgement with the same private lease without repeating local cleanup", async () => {
    const first = journal();
    const identity = await first.register(registration());
    await first.executionStarted(identity.attemptId);
    await first.localCleanupConfirmed(identity.attemptId);
    await first.guardReleased(identity.attemptId);
    const recovery = actions();
    const acknowledge = vi.fn(async (_identity: AttemptCleanupIdentity) => {
      if (acknowledge.mock.calls.length === 1)
        throw new Error(`Lost acknowledgement: ${identity.lease.leaseToken}`);
      recovery.calls.push("ack");
    });
    const firstRetry = await journal().recover({ ...recovery, acknowledge });
    expect(firstRetry).toMatchObject([
      { state: "awaiting_acknowledgement", lastFailure: "CLEANUP_RECOVERY_INCOMPLETE" },
    ]);
    expect(JSON.stringify(firstRetry)).not.toContain(identity.lease.leaseToken);
    expect(await journal().recover({ ...recovery, acknowledge })).toMatchObject([
      { state: "acknowledged" },
    ]);
    expect(acknowledge.mock.calls.map(([owner]) => owner.lease)).toEqual([
      identity.lease,
      identity.lease,
    ]);
    expect(recovery.cleanupWorkspace).not.toHaveBeenCalled();
    expect(recovery.releaseGuard).not.toHaveBeenCalled();
  });

  it("retains quarantine and never acknowledges a lock belonging to another owner", async () => {
    const first = journal();
    await first.register(registration());
    const recovery = actions();
    const releaseGuard = vi.fn(async () => {
      throw Object.assign(new Error("Unrelated owner"), { code: "DESKTOP_ATTEMPT_LOCK_UNSAFE" });
    });
    expect(await first.recover({ ...recovery, releaseGuard })).toMatchObject([
      {
        state: "awaiting_cleanup",
        localCleanupConfirmed: true,
        guardReleased: false,
        lastFailure: "DESKTOP_ATTEMPT_LOCK_UNSAFE",
      },
    ]);
    expect(recovery.acknowledge).not.toHaveBeenCalled();
  });

  it("skips active attempts even when registration has not reached execution dispatch", async () => {
    const first = journal();
    await first.register(registration());
    const recovery = actions();
    await first.recover({ ...recovery, activeAttemptIds: new Set(["attempt-1"]) });
    expect(recovery.calls).toEqual([]);
  });

  it("rejects a copied private journal belonging to another data directory", async () => {
    await journal().register(registration());
    const other = join(directory, "copy");
    await mkdir(other);
    for (const name of await readdir(directory))
      if (name.endsWith(".json")) await copyFile(join(directory, name), join(other, name));
    await expect(
      new InvestigationAttemptCleanupJournal({ directory: other }).statuses(),
    ).rejects.toThrow("another Worker directory");
  });

  it("forbids acknowledging cleanup before local cleanup and guard release", async () => {
    const first = journal();
    await first.register(registration());
    await expect(first.acknowledged("attempt-1")).rejects.toThrow("locally cleaned");
    await expect(first.guardReleased("attempt-1")).rejects.toThrow("Local cleanup");
  });

  it("returns successful recovery idempotently when startup replay already acknowledged it", async () => {
    const first = journal();
    await first.register(registration());
    await first.localCleanupConfirmed("attempt-1");
    await first.guardReleased("attempt-1");
    const resumed = journal();
    expect(await resumed.recover(actions())).toMatchObject([{ state: "acknowledged" }]);
    const before = await readdir(directory);
    await resumed.confirmRecovery("attempt-1", {
      operator: "test-operator",
      reason: "Repeated confirmation after the pending acknowledgement was recovered.",
      desktopRestored: true,
      ownedProcessTreeStopped: false,
    });
    expect(await resumed.recover(actions())).toMatchObject([{ state: "acknowledged" }]);
    expect(await readdir(directory)).toEqual(before);
  });
});
