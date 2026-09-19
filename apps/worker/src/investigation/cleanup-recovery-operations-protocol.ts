import { win32 } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { assertWindowsLocalAbsolutePath } from "../execution/process-host-protocol.js";

export const cleanupRecoveryMaximumInputBytes = 64 * 1024;

const text = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000\\r\\n]+(?![\\s\\S])",
});
const path = Type.String({
  minLength: 1,
  maxLength: 32_767,
  pattern: "^[^\\u0000\\r\\n]+(?![\\s\\S])",
});
const fence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const guardOwner = {
  lockDirectory: path,
  ownerId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\\s\\S])" }),
  ownerToken: Type.String({
    pattern:
      "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}(?![\\s\\S])",
  }),
};
const ownership = Type.Object(
  {
    schemaVersion: Type.Literal("InvestigationWorkspaceOwnershipReceiptV1"),
    workspaceRootDirectory: path,
    taskId: text,
    attemptId: text,
    leaseVersion: fence,
    nonce: Type.String({
      pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\\s\\S])",
    }),
    rootIdentity: text,
    attemptIdentity: text,
    ownerIdentity: text,
    ownerDigest: Type.String({ pattern: "^[a-f0-9]{64}(?![\\s\\S])" }),
  },
  { additionalProperties: false },
);

export const CleanupRecoveryOperationSchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("workspace"),
      workspaceRootDirectory: path,
      taskId: text,
      attemptId: text,
      leaseVersion: fence,
      ownership: Type.Union([ownership, Type.Null()]),
      processesStopped: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("guard"),
      ...guardOwner,
      processesStopped: Type.Literal(true),
      desktopRestored: Type.Literal(true),
      recoveryExclusive: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("guard-acquire"),
      ...guardOwner,
    },
    { additionalProperties: false },
  ),
]);
export type CleanupRecoveryOperation = Static<typeof CleanupRecoveryOperationSchema>;

const failureCodes = [
  "CLEANUP_RECOVERY_INPUT_INVALID",
  "CLEANUP_RECOVERY_HOST_UNAVAILABLE",
  "CLEANUP_RECOVERY_FAILED",
  "CLEANUP_RECOVERY_PROTOCOL_FAILED",
  "WORKSPACE_NOT_OWNED",
  "WORKSPACE_PATH_UNSAFE",
  "WORKSPACE_RECOVERY_OWNERSHIP_MISSING",
  "WORKSPACE_TREE_LIMIT_EXCEEDED",
  "DESKTOP_ATTEMPT_UNAVAILABLE",
  "DESKTOP_ATTEMPT_LOCK_UNSAFE",
  "DESKTOP_ATTEMPT_QUARANTINED",
  "DESKTOP_ATTEMPT_CLEANUP_UNCONFIRMED",
] as const;
export type CleanupRecoveryFailureCode = (typeof failureCodes)[number];

export class CleanupRecoveryOperationError extends Error {
  public constructor(public readonly code: CleanupRecoveryFailureCode) {
    super("Managed cleanup recovery did not complete.");
    this.name = "CleanupRecoveryOperationError";
  }
}

export function cleanupRecoveryFailureCode(error: unknown): CleanupRecoveryFailureCode {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return failureCodes.includes(code as CleanupRecoveryFailureCode)
    ? (code as CleanupRecoveryFailureCode)
    : "CLEANUP_RECOVERY_FAILED";
}

/** The helper accepts fixed ownership operations, never executable names, modules, or commands. */
export function parseCleanupRecoveryOperation(value: unknown): CleanupRecoveryOperation {
  try {
    if (!Value.Check(CleanupRecoveryOperationSchema, value)) throw new Error();
    const directory =
      value.operation === "workspace" ? value.workspaceRootDirectory : value.lockDirectory;
    assertWindowsLocalAbsolutePath(directory, "cleanup directory", false);
    if (
      directory.trim() !== directory ||
      win32.normalize(directory) === win32.parse(directory).root
    )
      throw new Error();
    if (value.operation === "workspace") {
      if (value.taskId.trim() !== value.taskId || value.attemptId.trim() !== value.attemptId)
        throw new Error();
      const receipt = value.ownership;
      if (
        receipt !== null &&
        (receipt.taskId !== value.taskId ||
          receipt.attemptId !== value.attemptId ||
          receipt.leaseVersion !== value.leaseVersion ||
          win32.normalize(receipt.workspaceRootDirectory).toLowerCase() !==
            win32.normalize(directory).toLowerCase())
      )
        throw new Error();
    }
    return value;
  } catch {
    throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_INPUT_INVALID");
  }
}

export function serializeCleanupRecoveryOperation(value: CleanupRecoveryOperation): string {
  const serialized = JSON.stringify(parseCleanupRecoveryOperation(value));
  if (Buffer.byteLength(serialized, "utf8") > cleanupRecoveryMaximumInputBytes)
    throw new CleanupRecoveryOperationError("CLEANUP_RECOVERY_INPUT_INVALID");
  return serialized;
}
