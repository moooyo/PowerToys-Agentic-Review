import { Value } from "@sinclair/typebox/value";
import {
  ManagedProcessRunError,
  ProductionManagedProcessRunner,
} from "../execution/managed-process-runner.js";
import {
  assertValidProcessLaunchSpec,
  assertWindowsLocalAbsolutePath,
  type ProcessHostClient,
  type ProcessHostRecoverySnapshot,
  ProcessHostRecoverySnapshotSchema,
  type ProcessResourceLimits,
} from "../execution/process-host-protocol.js";
import type { AttemptCleanupIdentity } from "./attempt-cleanup-journal.js";
import {
  type CleanupRecoveryOperation,
  CleanupRecoveryOperationError,
  cleanupRecoveryFailureCode,
  serializeCleanupRecoveryOperation,
} from "./cleanup-recovery-operations-protocol.js";
import type { InvestigationWorkspaceOwnershipReceipt } from "./workspace.js";

export interface CleanupRecoveryOperationsOptions {
  readonly processHost: ProcessHostClient;
  readonly nodeExecutablePath: string;
  readonly entryPath: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly limits: ProcessResourceLimits;
}

export interface CleanupRecoveryOperations {
  acquireGuard(identity: AttemptCleanupIdentity, signal?: AbortSignal): Promise<void>;
  cleanupWorkspace(
    identity: AttemptCleanupIdentity,
    ownership: InvestigationWorkspaceOwnershipReceipt | null,
  ): Promise<void>;
  releaseGuard(identity: AttemptCleanupIdentity): Promise<void>;
}

/** Every destructive recovery operation executes inside the native named recovery Job. */
export function createCleanupRecoveryOperations(
  options: CleanupRecoveryOperationsOptions,
): CleanupRecoveryOperations {
  const { processHost, nodeExecutablePath, entryPath, workingDirectory } = options;
  const runner = new ProductionManagedProcessRunner({
    maximumCapturedOutputBytes: 4_096,
    maximumErrorPreviewBytes: 4_096,
  });
  const environment = { ...options.environment };
  const limits = { ...options.limits };
  try {
    assertWindowsLocalAbsolutePath(nodeExecutablePath, "cleanup Node executable", true);
    assertWindowsLocalAbsolutePath(entryPath, "cleanup helper entry", false);
    if (!entryPath.toLowerCase().endsWith(".mjs")) throw new Error();
    assertWindowsLocalAbsolutePath(workingDirectory, "cleanup working directory", false);
    if (
      Object.keys(environment).some((name) =>
        ["NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase()),
      )
    )
      throw new Error();
  } catch {
    throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_INPUT_INVALID");
  }

  const recovery = (
    expectedInstanceKey: string,
    expectedGeneration?: string,
  ): ProcessHostRecoverySnapshot => {
    const current = processHost.recovery?.();
    if (
      !Value.Check(ProcessHostRecoverySnapshotSchema, current) ||
      current.instanceKey !== expectedInstanceKey ||
      (expectedGeneration !== undefined && current.generation !== expectedGeneration)
    )
      throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_HOST_UNAVAILABLE");
    return current;
  };

  const execute = async (
    identity: AttemptCleanupIdentity,
    operation: CleanupRecoveryOperation,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    try {
      const instanceKey = identity.processHostInstanceKey;
      const generation = recovery(instanceKey).generation;
      const spec = {
        executable: nodeExecutablePath,
        arguments: [entryPath],
        workingDirectory,
        environmentMode: "replace" as const,
        environment,
        standardInput: serializeCleanupRecoveryOperation(operation),
        limits:
          operation.operation === "guard-acquire"
            ? limits
            : { ...limits, hardTimeoutMs: Math.min(limits.hardTimeoutMs, 60_000) },
      };
      assertValidProcessLaunchSpec(spec);
      const fencedHost: ProcessHostClient = {
        start: (launch, signal, onDispatch) => {
          recovery(instanceKey, generation);
          return processHost.start(launch, signal, () => {
            recovery(instanceKey, generation);
            onDispatch?.();
          });
        },
        terminateAll: (reason) => processHost.terminateAll(reason),
        close: () => processHost.close(),
      };
      const result = await runner.run(spec, {
        processHost: fencedHost,
        signal,
      });
      recovery(instanceKey, generation);
      const response: unknown = JSON.parse(result.stdout);
      if (
        result.stderr !== "" ||
        typeof response !== "object" ||
        response === null ||
        Object.keys(response).length !== 1 ||
        !("completed" in response) ||
        response.completed !== true
      )
        throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_PROTOCOL_FAILED");
    } catch (error) {
      if (error instanceof CleanupRecoveryOperationError) throw error;
      if (
        error instanceof ManagedProcessRunError &&
        error.cause instanceof CleanupRecoveryOperationError
      )
        throw error.cause;
      // Never let cancellation hide a separate process completion or output drain failure.
      if (
        signal.aborted &&
        error instanceof ManagedProcessRunError &&
        error.code === "ABORTED" &&
        error.cause === signal.reason &&
        !error.outputTruncated
      )
        throw signal.reason;
      if (
        error instanceof ManagedProcessRunError &&
        error.code === "NON_ZERO_EXIT" &&
        error.stderr === ""
      ) {
        try {
          const response: unknown = JSON.parse(error.stdout);
          if (
            typeof response === "object" &&
            response !== null &&
            Object.keys(response).length === 1 &&
            "code" in response
          )
            throw new CleanupRecoveryOperationError(cleanupRecoveryFailureCode(response));
        } catch (responseError) {
          if (responseError instanceof CleanupRecoveryOperationError) throw responseError;
        }
      }
      // Raw exceptions, child output, ownership nonces, and Server leases never escape this boundary.
      throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_FAILED");
    }
  };

  return {
    acquireGuard: (identity, signal) =>
      execute(
        identity,
        {
          operation: "guard-acquire",
          lockDirectory: identity.desktopLockDirectory,
          ownerId: identity.guardOwnerId,
          ownerToken: identity.guardOwnerToken,
        },
        signal,
      ),
    cleanupWorkspace: (identity, ownership) =>
      execute(identity, {
        operation: "workspace",
        workspaceRootDirectory: identity.workspaceRootDirectory,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        leaseVersion: identity.lease.fence,
        ownership,
        processesStopped: true,
      }),
    releaseGuard: (identity) =>
      execute(identity, {
        operation: "guard",
        lockDirectory: identity.desktopLockDirectory,
        ownerId: identity.guardOwnerId,
        ownerToken: identity.guardOwnerToken,
        processesStopped: true,
        desktopRestored: true,
        recoveryExclusive: true,
      }),
  };
}
