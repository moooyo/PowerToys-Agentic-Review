import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireAttemptDesktopGuard, recoverAttemptDesktopGuard } from "./attempt-desktop-guard.js";
import {
  CleanupRecoveryOperationError,
  cleanupRecoveryFailureCode,
  cleanupRecoveryMaximumInputBytes,
  parseCleanupRecoveryOperation,
} from "./cleanup-recovery-operations-protocol.js";
import {
  assertInvestigationAttemptWorkspaceAbsent,
  cleanupOwnedInvestigationAttempt,
} from "./workspace.js";

export interface CleanupRecoveryEntryOperations {
  readonly acquireGuard: typeof acquireAttemptDesktopGuard;
  readonly cleanupWorkspace: typeof cleanupOwnedInvestigationAttempt;
  readonly assertWorkspaceAbsent: typeof assertInvestigationAttemptWorkspaceAbsent;
  readonly releaseGuard: typeof recoverAttemptDesktopGuard;
}

const productionOperations: CleanupRecoveryEntryOperations = {
  acquireGuard: acquireAttemptDesktopGuard,
  cleanupWorkspace: cleanupOwnedInvestigationAttempt,
  assertWorkspaceAbsent: assertInvestigationAttemptWorkspaceAbsent,
  releaseGuard: recoverAttemptDesktopGuard,
};

/** This entry is never evaluated by the Worker parent; ProcessHost owns it and all descendants. */
export async function runCleanupRecoveryOperationsEntry(
  input: AsyncIterable<Uint8Array> = process.stdin,
  writeResult: (line: string) => Promise<void> | void = writeStandardOutput,
  operations: CleanupRecoveryEntryOperations = productionOperations,
): Promise<0 | 1> {
  let response: { completed: true } | { code: string };
  let exitCode: 0 | 1 = 0;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array))
        throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_INPUT_INVALID");
      size += chunk.byteLength;
      if (size > cleanupRecoveryMaximumInputBytes)
        throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_INPUT_INVALID");
      chunks.push(Buffer.from(chunk));
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
      );
    } catch {
      throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_INPUT_INVALID");
    }
    const operation = parseCleanupRecoveryOperation(value);
    if (operation.operation === "workspace") {
      const identity = {
        workspaceRootDirectory: operation.workspaceRootDirectory,
        taskId: operation.taskId,
        attemptId: operation.attemptId,
        leaseVersion: operation.leaseVersion,
      };
      if (operation.ownership === null) await operations.assertWorkspaceAbsent(identity);
      else
        await operations.cleanupWorkspace({
          ...identity,
          ownership: operation.ownership,
          processesStopped: true,
          maximumTreeEntries: 250_000,
        });
    } else if (operation.operation === "guard-acquire") {
      const guard = await operations.acquireGuard({
        lockDirectory: operation.lockDirectory,
        ownerId: operation.ownerId,
        ownerToken: operation.ownerToken,
      });
      // Close the helper's handle while preserving the published held marker for the attempt.
      await guard.settleManagedCleanup("quarantined");
    } else {
      await operations.releaseGuard({
        lockDirectory: operation.lockDirectory,
        ownerId: operation.ownerId,
        ownerToken: operation.ownerToken,
        processesStopped: true,
        desktopRestored: true,
        recoveryExclusive: true,
      });
    }
    response = { completed: true };
  } catch (error) {
    exitCode = 1;
    response = { code: cleanupRecoveryFailureCode(error) };
  }
  try {
    await writeResult(`${JSON.stringify(response)}\n`);
  } catch {
    return 1;
  }
  return exitCode;
}

function writeStandardOutput(line: string): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(line, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runCleanupRecoveryOperationsEntry();
}
