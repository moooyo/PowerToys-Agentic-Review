import { createHash, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  type CreateResultArtifactUploadRequest,
  CreateResultArtifactUploadRequestSchema,
  type CreateResultArtifactUploadResponse,
  type FinalizeResultArtifactUploadRequest,
  FinalizeResultArtifactUploadRequestSchema,
  type FinalizeResultArtifactUploadResponse,
  FinalizeResultArtifactUploadResponseSchema,
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunks,
  type ResultArtifactChunkRequest,
  type ResultArtifactChunkResponse,
  ResultArtifactChunkResponseSchema,
  type TerminateResultArtifactUploadRequest,
  TerminateResultArtifactUploadRequestSchema,
  type TerminateResultArtifactUploadResponse,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type {
  ArtifactHealthAccounting,
  ArtifactReconciliationDatabaseOperation,
  CommitArtifactChunkResult,
  CommitArtifactFinalizeResult,
  PrepareArtifactChunkInput,
  PrepareArtifactChunkResult,
  PrepareArtifactFinalizeResult,
  TerminateArtifactUploadResult,
} from "../database/artifacts.js";
import {
  maximumArtifactCleanupRetryDelaySeconds,
  maximumArtifactReconciliationBatchSize,
  toFinalizeResultArtifactUploadResponse,
  toResultArtifactChunkResponse,
  toTerminateResultArtifactUploadResponse,
} from "../database/artifacts.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { DatabaseOperationMap } from "../database/protocol.js";
import {
  snapshotResultArtifactChunkTransport,
  type ValidatedResultArtifactChunkTransport,
} from "./artifact-chunk-transport.js";
import { ArtifactMutationGate, ArtifactMutationGateError } from "./artifact-mutation-gate.js";
import {
  maximumArtifactNamespaceManifestEntries,
  maximumArtifactNamespacePageSize,
} from "./artifact-namespace-contract.js";
import {
  ArtifactReconciliationCoordinator,
  type ArtifactReconciliationStorageOwner,
  registerArtifactReconciliationDatabaseHandle,
} from "./artifact-reconciliation-coordinator.js";
import {
  ArtifactUploadCreateCoordinator,
  ArtifactUploadCreateCoordinatorError,
  registerArtifactUploadCreateDatabaseHandle,
} from "./artifact-upload-create-coordinator.js";
import { snapshotArtifactCapacityLimits } from "./capacity.js";
import { ArtifactStorageClientError } from "./errors.js";
import {
  requireArtifactOperationId,
  requireArtifactSha256,
  requireArtifactUploadId,
} from "./names.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactCapacityEvaluationInput,
  ArtifactStorageKernelOptions,
  DurableArtifactChunk,
  PreparedArtifactChunk,
  PreparedArtifactFinalization,
  PublishedArtifactObject,
} from "./types.js";
import type { ArtifactObjectReadInput } from "./worker-protocol.js";
import {
  assertArtifactStorageResponseMatchesExpectation,
  createArtifactStorageResponseExpectation,
  normalizeArtifactStorageOperationInput,
  normalizeArtifactStorageOperationOutput,
} from "./worker-protocol.js";

const artifactTransactionDatabaseHandleBrand: unique symbol = Symbol(
  "artifact-transaction-database-handle",
);
const artifactTransactionStorageHandleBrand: unique symbol = Symbol(
  "artifact-transaction-storage-handle",
);
const artifactTransactionOwnerLockHandleBrand: unique symbol = Symbol(
  "artifact-transaction-owner-lock-handle",
);
const maximumCoordinatorMilliseconds = 600_000;

export type ArtifactTransactionDatabaseOperation =
  | ArtifactReconciliationDatabaseOperation
  | "commitArtifactChunk"
  | "commitArtifactFinalize"
  | "createArtifactUpload"
  | "prepareArtifactChunk"
  | "prepareArtifactFinalize"
  | "probeArtifactUploadCreate"
  | "terminateArtifactUpload";

export const isArtifactTransactionDatabaseOperation = (
  operation: string,
): operation is ArtifactTransactionDatabaseOperation => {
  switch (operation) {
    case "commitArtifactChunk":
    case "commitArtifactFinalize":
    case "createArtifactUpload":
    case "prepareArtifactChunk":
    case "prepareArtifactFinalize":
    case "probeArtifactUploadCreate":
    case "terminateArtifactUpload":
    case "terminalizeInactiveArtifactUploads":
    case "listDueArtifactCleanups":
    case "completeArtifactCleanup":
    case "recordArtifactCleanupFailure":
    case "classifyArtifactNamespacePageAndAdvanceCursor":
    case "listDueArtifactNamespaceCleanups":
    case "completeArtifactNamespaceCleanup":
    case "recordArtifactNamespaceCleanupFailure":
    case "readArtifactHealthAccounting":
    case "readArtifactReconciliationCursor":
      return true;
    default:
      return false;
  }
};

type ArtifactTransactionDatabaseRequest = <TOperation extends ArtifactTransactionDatabaseOperation>(
  operation: TOperation,
  input: DatabaseOperationMap[TOperation]["input"],
) => Promise<DatabaseOperationMap[TOperation]["output"]>;

interface ArtifactTransactionDatabaseOwner {
  readonly identity: object;
  readonly terminalFailure: Promise<Error>;
  readonly request: ArtifactTransactionDatabaseRequest;
  close(): Promise<void>;
}

export interface ArtifactTransactionDatabaseHandle {
  readonly [artifactTransactionDatabaseHandleBrand]: true;
}

interface ArtifactTransactionDatabaseHandleRecord {
  readonly owner: ArtifactTransactionDatabaseOwner;
}

const databaseHandleRecords = new WeakMap<object, ArtifactTransactionDatabaseHandleRecord>();
const adoptedOwnerIdentities = new WeakSet<object>();

const claimOwnerIdentities = (identities: readonly object[]): void => {
  if (
    new Set(identities).size !== identities.length ||
    identities.some((identity) => adoptedOwnerIdentities.has(identity))
  ) {
    throw new TypeError("Artifact transaction owners were already adopted.");
  }
  for (const identity of identities) adoptedOwnerIdentities.add(identity);
};

/** @internal Imported only by DatabaseClient and source-excluded unit tests. */
export const registerArtifactTransactionDatabaseHandle = (
  identity: object,
  owner: Omit<ArtifactTransactionDatabaseOwner, "identity">,
): ArtifactTransactionDatabaseHandle => {
  const request = owner.request;
  const close = owner.close;
  const terminalFailure = owner.terminalFailure;
  if (
    (typeof identity !== "object" && typeof identity !== "function") ||
    identity === null ||
    !(terminalFailure instanceof Promise) ||
    typeof request !== "function" ||
    typeof close !== "function"
  ) {
    throw new TypeError("Artifact transaction database owner binding is invalid.");
  }
  const handle = Object.freeze(Object.create(null)) as ArtifactTransactionDatabaseHandle;
  databaseHandleRecords.set(handle, {
    owner: Object.freeze({
      identity,
      terminalFailure,
      request: (<TOperation extends ArtifactTransactionDatabaseOperation>(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ): Promise<DatabaseOperationMap[TOperation]["output"]> =>
        Reflect.apply(request, owner, [operation, input]) as Promise<
          DatabaseOperationMap[TOperation]["output"]
        >) as ArtifactTransactionDatabaseRequest,
      close: () => Reflect.apply(close, owner, []) as Promise<void>,
    }),
  });
  return handle;
};

/** @internal Allows the issuing DatabaseClient to abandon an unconsumed handle before shutdown. */
export const revokeArtifactTransactionDatabaseHandle = (
  handle: ArtifactTransactionDatabaseHandle,
): boolean => databaseHandleRecords.delete(handle);

const consumeDatabaseHandle = (
  handle: ArtifactTransactionDatabaseHandle,
): {
  readonly record: ArtifactTransactionDatabaseHandleRecord;
  readonly restore: () => void;
} => {
  if (typeof handle !== "object" || handle === null) {
    throw new TypeError("Artifact transaction database handle is invalid.");
  }
  const record = databaseHandleRecords.get(handle);
  if (record === undefined) {
    throw new TypeError("Artifact transaction database handle was already consumed or forged.");
  }
  databaseHandleRecords.delete(handle);
  return {
    record,
    restore: () => {
      if (!databaseHandleRecords.has(handle)) databaseHandleRecords.set(handle, record);
    },
  };
};

interface ArtifactTransactionStorageOwner extends ArtifactReconciliationStorageOwner {
  readonly terminalFailure: Promise<Error>;
  evaluateCapacity(input: ArtifactCapacityEvaluationInput): Promise<ArtifactCapacityAdmission>;
  writePreparedChunk(input: PreparedArtifactChunk): Promise<DurableArtifactChunk>;
  finalizeArtifact(input: PreparedArtifactFinalization): Promise<PublishedArtifactObject>;
  readObject(input: ArtifactObjectReadInput): Promise<Buffer>;
  close(): Promise<void>;
}

export interface ArtifactTransactionStorageHandle {
  readonly [artifactTransactionStorageHandleBrand]: true;
}

interface ArtifactTransactionStorageHandleRecord {
  readonly identity: object;
  readonly owner: ArtifactTransactionStorageOwner;
}

const storageHandleRecords = new WeakMap<object, ArtifactTransactionStorageHandleRecord>();

/** @internal Imported only by ArtifactStorageClient and source-excluded unit tests. */
export const registerArtifactTransactionStorageHandle = (
  identity: object,
  owner: ArtifactTransactionStorageOwner,
): ArtifactTransactionStorageHandle => {
  const ownerExit = owner?.ownerExit;
  const terminalFailure = owner?.terminalFailure;
  const evaluateCapacity = owner?.evaluateCapacity;
  const writePreparedChunk = owner?.writePreparedChunk;
  const finalizeArtifact = owner?.finalizeArtifact;
  const readObject = owner?.readObject;
  const cleanupUpload = owner?.cleanupUpload;
  const scanNamespacePage = owner?.scanNamespacePage;
  const closeNamespaceScan = owner?.closeNamespaceScan;
  const cleanupNamespaceEntry = owner?.cleanupNamespaceEntry;
  const close = owner?.close;
  if (
    (typeof identity !== "object" && typeof identity !== "function") ||
    identity === null ||
    (typeof owner !== "object" && typeof owner !== "function") ||
    owner === null ||
    !(ownerExit instanceof Promise) ||
    !(terminalFailure instanceof Promise) ||
    typeof evaluateCapacity !== "function" ||
    typeof writePreparedChunk !== "function" ||
    typeof finalizeArtifact !== "function" ||
    typeof readObject !== "function" ||
    typeof cleanupUpload !== "function" ||
    typeof scanNamespacePage !== "function" ||
    typeof closeNamespaceScan !== "function" ||
    typeof cleanupNamespaceEntry !== "function" ||
    typeof close !== "function"
  ) {
    throw new TypeError("Artifact transaction storage owner binding is invalid.");
  }
  const handle = Object.freeze(Object.create(null)) as ArtifactTransactionStorageHandle;
  storageHandleRecords.set(handle, {
    identity,
    owner: Object.freeze({
      ownerExit,
      terminalFailure,
      evaluateCapacity: (
        input: Parameters<ArtifactTransactionStorageOwner["evaluateCapacity"]>[0],
      ) => Reflect.apply(evaluateCapacity, owner, [input]),
      writePreparedChunk: (
        input: Parameters<ArtifactTransactionStorageOwner["writePreparedChunk"]>[0],
      ) => Reflect.apply(writePreparedChunk, owner, [input]),
      finalizeArtifact: (
        input: Parameters<ArtifactTransactionStorageOwner["finalizeArtifact"]>[0],
      ) => Reflect.apply(finalizeArtifact, owner, [input]),
      readObject: (input: Parameters<ArtifactTransactionStorageOwner["readObject"]>[0]) =>
        Reflect.apply(readObject, owner, [input]),
      cleanupUpload: (input: Parameters<ArtifactTransactionStorageOwner["cleanupUpload"]>[0]) =>
        Reflect.apply(cleanupUpload, owner, [input]),
      scanNamespacePage: (
        input: Parameters<ArtifactTransactionStorageOwner["scanNamespacePage"]>[0],
      ) => Reflect.apply(scanNamespacePage, owner, [input]),
      closeNamespaceScan: (
        input: Parameters<ArtifactTransactionStorageOwner["closeNamespaceScan"]>[0],
      ) => Reflect.apply(closeNamespaceScan, owner, [input]),
      cleanupNamespaceEntry: (
        input: Parameters<ArtifactTransactionStorageOwner["cleanupNamespaceEntry"]>[0],
      ) => Reflect.apply(cleanupNamespaceEntry, owner, [input]),
      close: () => Reflect.apply(close, owner, []),
    }),
  });
  return handle;
};

/** @internal Allows the issuing storage client to abandon an unconsumed handle before shutdown. */
export const revokeArtifactTransactionStorageHandle = (
  handle: ArtifactTransactionStorageHandle,
): boolean => storageHandleRecords.delete(handle);

const consumeStorageHandle = (
  handle: ArtifactTransactionStorageHandle,
): {
  readonly record: ArtifactTransactionStorageHandleRecord;
  readonly restore: () => void;
} => {
  if (typeof handle !== "object" || handle === null) {
    throw new TypeError("Artifact transaction storage handle is invalid.");
  }
  const record = storageHandleRecords.get(handle);
  if (record === undefined) {
    throw new TypeError("Artifact transaction storage handle was already consumed or forged.");
  }
  storageHandleRecords.delete(handle);
  return {
    record,
    restore: () => {
      if (!storageHandleRecords.has(handle)) storageHandleRecords.set(handle, record);
    },
  };
};

interface ArtifactTransactionOwnerLockOwner {
  close(): Promise<void>;
}

export interface ArtifactTransactionOwnerLockHandle {
  readonly [artifactTransactionOwnerLockHandleBrand]: true;
}

interface ArtifactTransactionOwnerLockRecord {
  readonly identity: object;
  readonly owner: ArtifactTransactionOwnerLockOwner;
}

const ownerLockHandleRecords = new WeakMap<object, ArtifactTransactionOwnerLockRecord>();

/** @internal Imported only by DatabaseOwnerLock and source-excluded unit tests. */
export const registerArtifactTransactionOwnerLockHandle = (
  identity: object,
  owner: ArtifactTransactionOwnerLockOwner,
): ArtifactTransactionOwnerLockHandle => {
  const close = owner?.close;
  if (
    (typeof identity !== "object" && typeof identity !== "function") ||
    identity === null ||
    typeof close !== "function"
  ) {
    throw new TypeError("Artifact transaction owner-lock binding is invalid.");
  }
  const handle = Object.freeze(Object.create(null)) as ArtifactTransactionOwnerLockHandle;
  ownerLockHandleRecords.set(
    handle,
    Object.freeze({
      identity,
      owner: Object.freeze({ close: () => Reflect.apply(close, owner, []) as Promise<void> }),
    }),
  );
  return handle;
};

/** @internal Allows the issuing owner lock to abandon an unconsumed handle before shutdown. */
export const revokeArtifactTransactionOwnerLockHandle = (
  handle: ArtifactTransactionOwnerLockHandle,
): boolean => ownerLockHandleRecords.delete(handle);

const consumeOwnerLockHandle = (
  handle: ArtifactTransactionOwnerLockHandle,
): { readonly record: ArtifactTransactionOwnerLockRecord; readonly restore: () => void } => {
  if (typeof handle !== "object" || handle === null) {
    throw new TypeError("Artifact transaction owner-lock handle is invalid.");
  }
  const record = ownerLockHandleRecords.get(handle);
  if (record === undefined) {
    throw new TypeError("Artifact transaction owner-lock handle was already consumed or forged.");
  }
  ownerLockHandleRecords.delete(handle);
  return {
    record,
    restore: () => {
      if (!ownerLockHandleRecords.has(handle)) ownerLockHandleRecords.set(handle, record);
    },
  };
};

export interface ArtifactTransactionCoordinatorOptions {
  readonly database: ArtifactTransactionDatabaseHandle;
  readonly storage: ArtifactTransactionStorageHandle;
  readonly databaseOwnerLock: ArtifactTransactionOwnerLockHandle;
  readonly storageCapacity: ArtifactStorageKernelOptions["capacity"];
  readonly requestTimeoutMilliseconds: number;
  readonly closeTimeoutMilliseconds: number;
  readonly storageJoinTimeoutMilliseconds: number;
  readonly maximumPendingTransactions: number;
  readonly reconciliationBatchSize: number;
  readonly reconciliationMaximumNamespacePagesPerSession: number;
  readonly reconciliationIntervalMilliseconds: number;
  readonly reconciliationPassTimeoutMilliseconds: number;
  readonly reconciliationInitialRetryDelaySeconds: number;
  readonly reconciliationMaximumRetryDelaySeconds: number;
  readonly onFailStop: (error: ArtifactTransactionCoordinatorError) => void | Promise<void>;
}

interface ArtifactTransactionCoordinatorSnapshot
  extends Omit<ArtifactTransactionCoordinatorOptions, "storageCapacity" | "onFailStop"> {
  readonly storageCapacity: ArtifactStorageKernelOptions["capacity"];
  readonly onFailStop: (error: ArtifactTransactionCoordinatorError) => void | Promise<void>;
}

export type ArtifactTransactionCoordinatorErrorCode =
  | "ARTIFACT_TRANSACTION_BUSY"
  | "ARTIFACT_TRANSACTION_CANCELLED"
  | "ARTIFACT_TRANSACTION_CAPACITY"
  | "ARTIFACT_TRANSACTION_CLOSED"
  | "ARTIFACT_TRANSACTION_COMPLETION_MODE_MISMATCH"
  | "ARTIFACT_TRANSACTION_CONFLICT"
  | "ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN"
  | "ARTIFACT_TRANSACTION_INVALID_REQUEST"
  | "ARTIFACT_TRANSACTION_LEASE_LOST"
  | "ARTIFACT_TRANSACTION_NOT_READY"
  | "ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE"
  | "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE"
  | "ARTIFACT_TRANSACTION_QUOTA_EXCEEDED"
  | "ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE"
  | "ARTIFACT_TRANSACTION_STORAGE_INTEGRITY"
  | "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN"
  | "ARTIFACT_TRANSACTION_TIMEOUT";

interface ErrorDefinition {
  readonly message: string;
  readonly retryable: boolean;
  readonly requiresFailStop: boolean;
}

const errorDefinitions: Readonly<Record<ArtifactTransactionCoordinatorErrorCode, ErrorDefinition>> =
  Object.freeze({
    ARTIFACT_TRANSACTION_BUSY: {
      message: "Artifact transaction admission is busy.",
      retryable: true,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_CANCELLED: {
      message: "Artifact transaction was cancelled before execution.",
      retryable: true,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_CAPACITY: {
      message: "Artifact storage capacity is unavailable.",
      retryable: true,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_CLOSED: {
      message: "Artifact transaction coordinator is closed.",
      retryable: false,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_COMPLETION_MODE_MISMATCH: {
      message: "The run attempt does not permit result artifact operations.",
      retryable: false,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_CONFLICT: {
      message: "Artifact transaction conflicts with durable state.",
      retryable: false,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN: {
      message: "Artifact database outcome is unknown.",
      retryable: false,
      requiresFailStop: true,
    },
    ARTIFACT_TRANSACTION_INVALID_REQUEST: {
      message: "Artifact transaction input is invalid.",
      retryable: false,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_LEASE_LOST: {
      message: "Artifact transaction lease is no longer active.",
      retryable: false,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_NOT_READY: {
      message: "Artifact transaction startup reconciliation is not complete.",
      retryable: true,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE: {
      message: "Artifact owner shutdown could not be proven safe.",
      retryable: false,
      requiresFailStop: true,
    },
    ARTIFACT_TRANSACTION_PROTOCOL_FAILURE: {
      message: "Artifact transaction owner returned invalid protocol data.",
      retryable: false,
      requiresFailStop: true,
    },
    ARTIFACT_TRANSACTION_QUOTA_EXCEEDED: {
      message: "Artifact upload quota is exhausted.",
      retryable: false,
      requiresFailStop: false,
    },
    ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE: {
      message: "Artifact reconciliation failed.",
      retryable: false,
      requiresFailStop: true,
    },
    ARTIFACT_TRANSACTION_STORAGE_INTEGRITY: {
      message: "Artifact storage integrity validation failed.",
      retryable: false,
      requiresFailStop: true,
    },
    ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN: {
      message: "Artifact filesystem outcome is unknown.",
      retryable: false,
      requiresFailStop: true,
    },
    ARTIFACT_TRANSACTION_TIMEOUT: {
      message: "Artifact transaction expired before execution.",
      retryable: true,
      requiresFailStop: false,
    },
  });

export class ArtifactTransactionCoordinatorError extends Error {
  readonly code: ArtifactTransactionCoordinatorErrorCode;
  readonly retryable: boolean;
  readonly requiresFailStop: boolean;

  constructor(code: ArtifactTransactionCoordinatorErrorCode, options?: ErrorOptions) {
    const definition = errorDefinitions[code];
    super(definition.message, options);
    this.name = "ArtifactTransactionCoordinatorError";
    this.code = code;
    this.retryable = definition.retryable;
    this.requiresFailStop = definition.requiresFailStop;
  }
}

type CoordinatorState = "starting" | "open" | "closing" | "closed" | "fatal";
type FatalWaiter = (error: ArtifactTransactionCoordinatorError) => void;

interface ArtifactTransactionConstructionState {
  readonly database: ArtifactTransactionDatabaseOwner;
  readonly storage: ArtifactTransactionStorageOwner;
  ownerLock: ArtifactTransactionOwnerLockOwner;
  gate: ArtifactMutationGate | undefined;
  create: ArtifactUploadCreateCoordinator | undefined;
  reconciliation: ArtifactReconciliationCoordinator | undefined;
}

export interface ArtifactTransactionReadiness {
  readonly ready: boolean;
  readonly state: CoordinatorState;
  readonly health: ArtifactHealthAccounting | null;
}

const coordinatorError = (
  code: ArtifactTransactionCoordinatorErrorCode,
  cause?: unknown,
): ArtifactTransactionCoordinatorError =>
  new ArtifactTransactionCoordinatorError(code, cause === undefined ? undefined : { cause });

const requirePositiveInteger = (
  value: unknown,
  name: string,
  maximum = maximumCoordinatorMilliseconds,
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${name} must be a positive bounded integer.`);
  }
  return value as number;
};

const snapshotCoordinatorOptions = (
  options: ArtifactTransactionCoordinatorOptions,
): ArtifactTransactionCoordinatorSnapshot => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Artifact transaction coordinator options are invalid.");
  }
  const database = options.database;
  const storage = options.storage;
  const databaseOwnerLock = options.databaseOwnerLock;
  const storageCapacity = snapshotArtifactCapacityLimits(options.storageCapacity);
  const requestTimeoutMilliseconds = requirePositiveInteger(
    options.requestTimeoutMilliseconds,
    "Artifact transaction request timeout",
  );
  const closeTimeoutMilliseconds = requirePositiveInteger(
    options.closeTimeoutMilliseconds,
    "Artifact transaction close timeout",
  );
  const storageJoinTimeoutMilliseconds = requirePositiveInteger(
    options.storageJoinTimeoutMilliseconds,
    "Artifact storage join timeout",
  );
  const maximumPendingTransactions = requirePositiveInteger(
    options.maximumPendingTransactions,
    "Artifact transaction pending limit",
    1_024,
  );
  const reconciliationBatchSize = requirePositiveInteger(
    options.reconciliationBatchSize,
    "Artifact reconciliation batch size",
    maximumArtifactReconciliationBatchSize,
  );
  const reconciliationMaximumNamespacePagesPerSession = requirePositiveInteger(
    options.reconciliationMaximumNamespacePagesPerSession,
    "Artifact reconciliation namespace session page limit",
    maximumArtifactNamespaceManifestEntries / maximumArtifactNamespacePageSize,
  );
  const reconciliationIntervalMilliseconds = requirePositiveInteger(
    options.reconciliationIntervalMilliseconds,
    "Artifact reconciliation interval",
  );
  const reconciliationPassTimeoutMilliseconds = requirePositiveInteger(
    options.reconciliationPassTimeoutMilliseconds,
    "Artifact reconciliation pass timeout",
  );
  const reconciliationInitialRetryDelaySeconds = requirePositiveInteger(
    options.reconciliationInitialRetryDelaySeconds,
    "Artifact reconciliation initial retry delay",
    maximumArtifactCleanupRetryDelaySeconds,
  );
  const reconciliationMaximumRetryDelaySeconds = requirePositiveInteger(
    options.reconciliationMaximumRetryDelaySeconds,
    "Artifact reconciliation maximum retry delay",
    maximumArtifactCleanupRetryDelaySeconds,
  );
  const onFailStop = options.onFailStop;
  if (
    reconciliationMaximumRetryDelaySeconds < reconciliationInitialRetryDelaySeconds ||
    typeof onFailStop !== "function"
  ) {
    throw new TypeError("Artifact transaction coordinator options are inconsistent.");
  }
  return Object.freeze({
    database,
    storage,
    databaseOwnerLock,
    storageCapacity,
    requestTimeoutMilliseconds,
    closeTimeoutMilliseconds,
    storageJoinTimeoutMilliseconds,
    maximumPendingTransactions,
    reconciliationBatchSize,
    reconciliationMaximumNamespacePagesPerSession,
    reconciliationIntervalMilliseconds,
    reconciliationPassTimeoutMilliseconds,
    reconciliationInitialRetryDelaySeconds,
    reconciliationMaximumRetryDelaySeconds,
    onFailStop,
  });
};

const snapshotPlainObject = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Artifact transaction input must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new TypeError("Artifact transaction input contains unsupported fields.");
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Artifact transaction input fields must be enumerable data properties.");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
};

const requireCanonicalDateTime = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new TypeError(`${name} must be a canonical timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical timestamp.`);
  }
  return value;
};

const finalizeRequestKeys = [
  "jobId",
  "runAttemptId",
  "workerNodeId",
  "workerInstanceId",
  "leaseToken",
  "leaseGeneration",
  "chunkCount",
  "totalBytes",
  "sha256",
] as const;

const createRequestKeys = [
  "jobId",
  "runAttemptId",
  "workerNodeId",
  "workerInstanceId",
  "leaseToken",
  "leaseGeneration",
  "clientArtifactId",
  "purpose",
  "name",
  "mediaType",
  "totalBytes",
  "sha256",
] as const;

const terminateRequestKeys = [
  "jobId",
  "runAttemptId",
  "workerNodeId",
  "workerInstanceId",
  "leaseToken",
  "leaseGeneration",
  "state",
  "reason",
] as const;

const preparedChunkKeys = [
  "uploadId",
  "prepareId",
  "receiptState",
  "replayed",
  "committedNextChunkIndex",
  "committedOffsetBytes",
  "committedPrefix",
  "preparedNextChunkIndex",
  "preparedNextOffsetBytes",
  "chunkIndex",
  "offsetBytes",
  "chunkBytes",
  "chunkSha256",
  "uploadState",
  "committedArtifact",
] as const;

const preparedFinalizationKeys = [
  "uploadId",
  "finalizationId",
  "artifactId",
  "storageObjectKey",
  "state",
  "replayed",
  "chunkCount",
  "totalBytes",
  "sha256",
] as const;

const committedChunkKeys = [
  "uploadId",
  "prepareId",
  "state",
  "chunkIndex",
  "outcome",
  "nextChunkIndex",
  "nextOffsetBytes",
] as const;
const committedPrefixEntryKeys = [
  "chunkIndex",
  "offsetBytes",
  "chunkBytes",
  "chunkSha256",
] as const;

const committedFinalizeKeys = ["state", "replayed", "artifact"] as const;
const internalArtifactKeys = [
  "artifactId",
  "uploadId",
  "clientArtifactId",
  "jobId",
  "runAttemptId",
  "purpose",
  "name",
  "mediaType",
  "totalBytes",
  "sha256",
  "storageObjectKey",
] as const;
const terminationResultKeys = ["uploadId", "state", "reason", "terminatedAt", "replayed"] as const;

const snapshotCommittedPrefix = (
  value: unknown,
  committedNextChunkIndex: number,
  committedOffsetBytes: number,
): PrepareArtifactChunkResult["committedPrefix"] => {
  if (!Array.isArray(value) || value.length !== committedNextChunkIndex) {
    throw new TypeError("Artifact committed chunk prefix length is inconsistent.");
  }
  const entries: readonly unknown[] = value;
  let expectedOffsetBytes = 0;
  const prefix = entries.map((entry, chunkIndex) => {
    const record = snapshotPlainObject(entry, committedPrefixEntryKeys);
    if (
      record.chunkIndex !== chunkIndex ||
      record.offsetBytes !== expectedOffsetBytes ||
      !Number.isSafeInteger(record.chunkBytes) ||
      (record.chunkBytes as number) < 1 ||
      (record.chunkBytes as number) > maximumResultArtifactChunkBytes ||
      typeof record.chunkSha256 !== "string"
    ) {
      throw new TypeError("Artifact committed chunk prefix is invalid.");
    }
    const chunkBytes = record.chunkBytes as number;
    const chunkSha256 = requireArtifactSha256(record.chunkSha256);
    expectedOffsetBytes += chunkBytes;
    if (
      !Number.isSafeInteger(expectedOffsetBytes) ||
      expectedOffsetBytes > maximumResultArtifactBytes
    ) {
      throw new TypeError("Artifact committed chunk prefix exceeds its byte limit.");
    }
    return Object.freeze({
      chunkIndex,
      offsetBytes: record.offsetBytes as number,
      chunkBytes,
      chunkSha256,
    });
  });
  if (expectedOffsetBytes !== committedOffsetBytes) {
    throw new TypeError("Artifact committed chunk prefix byte cursor is inconsistent.");
  }
  return Object.freeze(prefix);
};

const snapshotFinalizeRequest = (value: unknown): FinalizeResultArtifactUploadRequest => {
  const snapshot = snapshotPlainObject(value, finalizeRequestKeys);
  if (!Value.Check(FinalizeResultArtifactUploadRequestSchema, snapshot)) {
    throw new TypeError("Artifact finalization request is invalid.");
  }
  return Object.freeze({ ...snapshot }) as unknown as FinalizeResultArtifactUploadRequest;
};

const snapshotCreateRequest = (value: unknown): CreateResultArtifactUploadRequest => {
  const snapshot = snapshotPlainObject(value, createRequestKeys);
  if (!Value.Check(CreateResultArtifactUploadRequestSchema, snapshot)) {
    throw new TypeError("Artifact upload create request is invalid.");
  }
  return Object.freeze({ ...snapshot }) as unknown as CreateResultArtifactUploadRequest;
};

const snapshotTerminateRequest = (value: unknown): TerminateResultArtifactUploadRequest => {
  const snapshot = snapshotPlainObject(value, terminateRequestKeys);
  if (!Value.Check(TerminateResultArtifactUploadRequestSchema, snapshot)) {
    throw new TypeError("Artifact termination request is invalid.");
  }
  return Object.freeze({ ...snapshot }) as unknown as TerminateResultArtifactUploadRequest;
};

const healthyForAdmission = (health: ArtifactHealthAccounting | undefined): boolean =>
  health?.capacity.accountingCertain === true &&
  health.cleanup.failed === 0 &&
  health.cleanup.invalidRetryIdentity === 0 &&
  health.namespaceCleanup.failed === 0 &&
  !health.namespaceCleanup.operationalSaturated;

const constructionRollbackTimeoutMilliseconds = 30_000;

const boundedConstructionRollback = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Artifact transaction construction rollback timed out.")),
          constructionRollbackTimeoutMilliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const closeFailedConstruction = async (
  construction: ArtifactTransactionConstructionState,
): Promise<unknown[]> => {
  const errors: unknown[] = [];
  if (construction.reconciliation !== undefined) {
    try {
      await boundedConstructionRollback(construction.reconciliation.close());
    } catch (error) {
      errors.push(error);
    }
  }
  if (construction.gate !== undefined) {
    try {
      await boundedConstructionRollback(construction.gate.close());
    } catch (error) {
      errors.push(error);
    }
  }
  if (construction.create !== undefined) {
    try {
      await boundedConstructionRollback(construction.create.close());
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  try {
    await boundedConstructionRollback(construction.storage.close());
  } catch (error) {
    errors.push(error);
  }
  let storageAbsent = false;
  try {
    const exitCode = await boundedConstructionRollback(construction.storage.ownerExit);
    storageAbsent = Number.isSafeInteger(exitCode) && exitCode >= 0;
    if (!storageAbsent || exitCode !== 0) {
      errors.push(new Error("Artifact storage owner did not exit cleanly during rollback."));
    }
  } catch (error) {
    errors.push(error);
  }
  if (!storageAbsent) return errors;

  try {
    await boundedConstructionRollback(construction.database.close());
  } catch (error) {
    errors.push(error);
    return errors;
  }
  try {
    await boundedConstructionRollback(construction.ownerLock.close());
  } catch (error) {
    errors.push(error);
  }
  return errors;
};

/**
 * Owns every artifact database/filesystem transaction and the shared mutation gate. Production
 * composition is intentionally absent until the Worker HTTP surface is separately reviewed.
 */
export class ArtifactTransactionCoordinator {
  readonly #database: ArtifactTransactionDatabaseOwner;
  readonly #storage: ArtifactTransactionStorageOwner;
  readonly #gate: ArtifactMutationGate;
  readonly #create: ArtifactUploadCreateCoordinator;
  readonly #reconciliation: ArtifactReconciliationCoordinator;
  readonly #requestTimeoutMilliseconds: number;
  readonly #closeTimeoutMilliseconds: number;
  readonly #onFailStop: (error: ArtifactTransactionCoordinatorError) => void | Promise<void>;
  readonly #ready = Promise.withResolvers<void>();
  readonly #fatal = Promise.withResolvers<ArtifactTransactionCoordinatorError>();
  readonly #fatalWaiters = new Set<FatalWaiter>();
  #state: CoordinatorState = "starting";
  #readySettled = false;
  #fatalError: ArtifactTransactionCoordinatorError | undefined;
  #failStopCallbackCompletion: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    options: ArtifactTransactionCoordinatorSnapshot,
    database: ArtifactTransactionDatabaseOwner,
    storageOwner: ArtifactTransactionStorageOwner,
    ownerLock: ArtifactTransactionOwnerLockOwner,
    construction: ArtifactTransactionConstructionState,
  ) {
    const storageCapacity = options.storageCapacity;
    const onFailStop = options.onFailStop;
    const maximumPendingTransactions = options.maximumPendingTransactions;
    const reconciliationBatchSize = options.reconciliationBatchSize;
    const reconciliationMaximumNamespacePagesPerSession =
      options.reconciliationMaximumNamespacePagesPerSession;
    const reconciliationIntervalMilliseconds = options.reconciliationIntervalMilliseconds;
    const reconciliationPassTimeoutMilliseconds = options.reconciliationPassTimeoutMilliseconds;
    const reconciliationInitialRetryDelaySeconds = options.reconciliationInitialRetryDelaySeconds;
    const reconciliationMaximumRetryDelaySeconds = options.reconciliationMaximumRetryDelaySeconds;
    const requestTimeoutMilliseconds = options.requestTimeoutMilliseconds;
    const closeTimeoutMilliseconds = options.closeTimeoutMilliseconds;
    const storageJoinTimeoutMilliseconds = options.storageJoinTimeoutMilliseconds;
    this.#database = database;
    this.#storage = storageOwner;
    this.#requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.#closeTimeoutMilliseconds = closeTimeoutMilliseconds;
    this.#onFailStop = (error) =>
      Reflect.apply(onFailStop, undefined, [error]) as void | Promise<void>;
    this.#gate = new ArtifactMutationGate({
      maximumPendingOperations: maximumPendingTransactions,
    });
    construction.gate = this.#gate;
    void Reflect.apply(Promise.prototype.then, database.terminalFailure, [
      (error: Error) => this.#observeOwnerFailure("database", error),
      (error: unknown) => this.#observeOwnerFailure("database", error),
    ]);
    void Reflect.apply(Promise.prototype.then, storageOwner.terminalFailure, [
      (error: Error) => this.#observeOwnerFailure("storage", error),
      (error: unknown) => this.#observeOwnerFailure("storage", error),
    ]);

    const createHandle = registerArtifactUploadCreateDatabaseHandle(database.identity, {
      probeArtifactUploadCreate: (input) =>
        this.#database.request("probeArtifactUploadCreate", input),
      createArtifactUpload: (input) => this.#database.request("createArtifactUpload", input),
      close: () => this.#database.close(),
    });
    this.#create = ArtifactUploadCreateCoordinator.start({
      database: createHandle,
      storage: this.#storage,
      storageCapacity,
      databaseOwnerLock: ownerLock,
      requestTimeoutMilliseconds,
      closeTimeoutMilliseconds,
      storageJoinTimeoutMilliseconds,
      maximumPendingCreates: maximumPendingTransactions,
      onFailStop: (error) => {
        this.#mapCreateError(error);
      },
    });
    construction.create = this.#create;
    const reconciliationHandle = registerArtifactReconciliationDatabaseHandle({
      request: (<TOperation extends ArtifactReconciliationDatabaseOperation>(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) => this.#database.request(operation, input)) as <
        TOperation extends ArtifactReconciliationDatabaseOperation,
      >(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) => Promise<DatabaseOperationMap[TOperation]["output"]>,
    });
    this.#reconciliation = ArtifactReconciliationCoordinator.start({
      database: reconciliationHandle,
      storage: this.#storage,
      mutationGate: this.#gate,
      batchSize: reconciliationBatchSize,
      maximumNamespacePagesPerSession: reconciliationMaximumNamespacePagesPerSession,
      intervalMilliseconds: reconciliationIntervalMilliseconds,
      passTimeoutMilliseconds: reconciliationPassTimeoutMilliseconds,
      closeTimeoutMilliseconds,
      initialRetryDelaySeconds: reconciliationInitialRetryDelaySeconds,
      maximumRetryDelaySeconds: reconciliationMaximumRetryDelaySeconds,
      onFailStop: (error) => {
        this.#enterFatal("ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE", error);
      },
    });
    construction.reconciliation = this.#reconciliation;
    void this.#ready.promise.catch(() => undefined);
    void this.#reconciliation.firstSweep.then(
      () => this.#completeStartup(),
      (error: unknown) => {
        if (this.#state !== "closing" && this.#state !== "closed") {
          this.#enterFatal("ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE", error);
        }
      },
    );
  }

  static async create(
    options: ArtifactTransactionCoordinatorOptions,
  ): Promise<ArtifactTransactionCoordinator> {
    const snapshot = snapshotCoordinatorOptions(options);
    const databaseHandle = snapshot.database;
    const storageHandle = snapshot.storage;
    const ownerLockHandle = snapshot.databaseOwnerLock;
    const consumedDatabase = consumeDatabaseHandle(databaseHandle);
    let consumedStorage: ReturnType<typeof consumeStorageHandle>;
    try {
      consumedStorage = consumeStorageHandle(storageHandle);
    } catch (error) {
      consumedDatabase.restore();
      throw error;
    }
    let consumedOwnerLock: ReturnType<typeof consumeOwnerLockHandle>;
    try {
      consumedOwnerLock = consumeOwnerLockHandle(ownerLockHandle);
    } catch (error) {
      consumedStorage.restore();
      consumedDatabase.restore();
      throw error;
    }
    try {
      claimOwnerIdentities([
        consumedDatabase.record.owner.identity,
        consumedStorage.record.identity,
        consumedOwnerLock.record.identity,
      ]);
    } catch (error) {
      consumedOwnerLock.restore();
      consumedStorage.restore();
      consumedDatabase.restore();
      throw error;
    }
    const construction: ArtifactTransactionConstructionState = {
      database: consumedDatabase.record.owner,
      storage: consumedStorage.record.owner,
      ownerLock: consumedOwnerLock.record.owner,
      gate: undefined,
      create: undefined,
      reconciliation: undefined,
    };
    try {
      return new ArtifactTransactionCoordinator(
        snapshot,
        consumedDatabase.record.owner,
        consumedStorage.record.owner,
        consumedOwnerLock.record.owner,
        construction,
      );
    } catch (error) {
      const rollbackErrors = await closeFailedConstruction(construction);
      throw rollbackErrors.length === 0
        ? error
        : new AggregateError(
            [error, ...rollbackErrors],
            "Artifact transaction construction and owner rollback both failed.",
            { cause: error },
          );
    }
  }

  get ready(): Promise<void> {
    return this.#ready.promise;
  }

  get fatal(): Promise<ArtifactTransactionCoordinatorError> {
    return this.#fatal.promise;
  }

  get failStopCallbackCompletion(): Promise<void> | undefined {
    return this.#failStopCallbackCompletion;
  }

  get readiness(): ArtifactTransactionReadiness {
    const health = this.#reconciliation.health;
    return Object.freeze({
      ready: this.#state === "open" && healthyForAdmission(health),
      state: this.#state,
      health: health ?? null,
    });
  }

  createArtifactUpload(
    inputValue: CreateResultArtifactUploadRequest,
    signal?: AbortSignal,
  ): Promise<CreateResultArtifactUploadResponse> {
    let input: CreateResultArtifactUploadRequest;
    try {
      input = snapshotCreateRequest(inputValue);
    } catch (error) {
      return Promise.reject(coordinatorError("ARTIFACT_TRANSACTION_INVALID_REQUEST", error));
    }
    return this.#runTransaction(signal, async (deadline) => {
      try {
        return await this.#create.createArtifactUpload(input, signal, deadline);
      } catch (error) {
        throw this.#mapCreateError(error);
      }
    });
  }

  putArtifactChunk(
    uploadIdValue: string,
    request: ResultArtifactChunkRequest,
    signal?: AbortSignal,
  ): Promise<ResultArtifactChunkResponse> {
    let uploadId: string;
    let chunk: ValidatedResultArtifactChunkTransport;
    try {
      uploadId = requireArtifactUploadId(uploadIdValue);
      chunk = snapshotResultArtifactChunkTransport(request);
    } catch (error) {
      return Promise.reject(coordinatorError("ARTIFACT_TRANSACTION_INVALID_REQUEST", error));
    }
    return this.#runTransaction(signal, (deadline) =>
      this.#putArtifactChunk(uploadId, chunk, deadline),
    );
  }

  finalizeArtifactUpload(
    uploadIdValue: string,
    requestValue: FinalizeResultArtifactUploadRequest,
    signal?: AbortSignal,
  ): Promise<FinalizeResultArtifactUploadResponse> {
    let uploadId: string;
    let request: FinalizeResultArtifactUploadRequest;
    try {
      uploadId = requireArtifactUploadId(uploadIdValue);
      request = snapshotFinalizeRequest(requestValue);
    } catch (error) {
      return Promise.reject(coordinatorError("ARTIFACT_TRANSACTION_INVALID_REQUEST", error));
    }
    return this.#runTransaction(signal, (deadline) =>
      this.#finalizeArtifactUpload(uploadId, request, deadline),
    );
  }

  terminateArtifactUpload(
    uploadIdValue: string,
    requestValue: TerminateResultArtifactUploadRequest,
    signal?: AbortSignal,
  ): Promise<TerminateResultArtifactUploadResponse> {
    let uploadId: string;
    let request: TerminateResultArtifactUploadRequest;
    try {
      uploadId = requireArtifactUploadId(uploadIdValue);
      request = snapshotTerminateRequest(requestValue);
    } catch (error) {
      return Promise.reject(coordinatorError("ARTIFACT_TRANSACTION_INVALID_REQUEST", error));
    }
    return this.#runTransaction(signal, (deadline) =>
      this.#terminateArtifactUpload(uploadId, request, deadline),
    );
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      if (this.#state === "starting" || this.#state === "open") this.#state = "closing";
      this.#rejectReady(coordinatorError("ARTIFACT_TRANSACTION_CLOSED"));
      this.#closePromise = this.#close(performance.now() + this.#closeTimeoutMilliseconds);
    }
    return this.#closePromise;
  }

  async #putArtifactChunk(
    uploadId: string,
    chunk: ValidatedResultArtifactChunkTransport,
    deadline: number,
  ): Promise<ResultArtifactChunkResponse> {
    const prepareInput: PrepareArtifactChunkInput = { ...chunk.metadata, uploadId };
    const prepared = this.#snapshotPreparedChunk(
      await this.#databaseStage("prepareArtifactChunk", prepareInput, deadline),
      prepareInput,
    );
    const storageInput = normalizeArtifactStorageOperationInput("writePreparedChunk", {
      uploadId,
      prepareId: prepared.prepareId,
      chunkIndex: prepared.chunkIndex,
      offsetBytes: prepared.offsetBytes,
      chunkSha256: prepared.chunkSha256,
      bytes: chunk.bytes,
      receiptState: prepared.receiptState,
      committedOffsetBytes: prepared.committedOffsetBytes,
      committedPrefix: prepared.committedPrefix,
    });
    if (prepared.uploadState === "committed") {
      const object = await this.#readVerifiedObject(prepared.committedArtifact, deadline);
      const end = chunk.metadata.offsetBytes + chunk.bytes.byteLength;
      const actual = object.subarray(chunk.metadata.offsetBytes, end);
      if (actual.byteLength !== chunk.bytes.byteLength || !timingSafeEqual(actual, chunk.bytes)) {
        throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
      }
    } else {
      const expectation = createArtifactStorageResponseExpectation(
        "writePreparedChunk",
        storageInput,
      );
      const durable = await this.#storageStage(
        () => this.#storage.writePreparedChunk(storageInput),
        deadline,
      );
      try {
        const normalized = normalizeArtifactStorageOperationOutput("writePreparedChunk", durable);
        assertArtifactStorageResponseMatchesExpectation(
          expectation,
          "writePreparedChunk",
          normalized,
        );
      } catch (error) {
        throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
      }
    }
    const committed = await this.#databaseStage(
      "commitArtifactChunk",
      { ...prepareInput, prepareId: prepared.prepareId },
      deadline,
    );
    return this.#snapshotChunkResponse(committed, prepared);
  }

  async #finalizeArtifactUpload(
    uploadId: string,
    request: FinalizeResultArtifactUploadRequest,
    deadline: number,
  ): Promise<FinalizeResultArtifactUploadResponse> {
    const input = { ...request, uploadId };
    const prepared = this.#snapshotPreparedFinalization(
      await this.#databaseStage("prepareArtifactFinalize", input, deadline),
      input,
    );
    let storageObjectKey = prepared.storageObjectKey;
    if (prepared.state === "committed") {
      await this.#readVerifiedObject(
        { totalBytes: prepared.totalBytes, sha256: prepared.sha256 },
        deadline,
      );
    } else {
      const storageInput = normalizeArtifactStorageOperationInput("finalizeArtifact", {
        uploadId,
        finalizationId: prepared.finalizationId,
        totalBytes: prepared.totalBytes,
        sha256: prepared.sha256,
      });
      const expectation = createArtifactStorageResponseExpectation(
        "finalizeArtifact",
        storageInput,
      );
      const published = await this.#storageStage(
        () => this.#storage.finalizeArtifact(storageInput),
        deadline,
      );
      try {
        const normalized = normalizeArtifactStorageOperationOutput("finalizeArtifact", published);
        assertArtifactStorageResponseMatchesExpectation(
          expectation,
          "finalizeArtifact",
          normalized,
        );
        storageObjectKey = normalized.storageObjectKey;
      } catch (error) {
        throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
      }
    }
    const committed = await this.#databaseStage(
      "commitArtifactFinalize",
      { ...input, finalizationId: prepared.finalizationId, storageObjectKey },
      deadline,
    );
    return this.#snapshotFinalizeResponse(committed, input, prepared);
  }

  async #terminateArtifactUpload(
    uploadId: string,
    request: TerminateResultArtifactUploadRequest,
    deadline: number,
  ): Promise<TerminateResultArtifactUploadResponse> {
    const result = await this.#databaseStage(
      "terminateArtifactUpload",
      { ...request, uploadId },
      deadline,
    );
    return this.#snapshotTerminationResponse(result, uploadId);
  }

  #snapshotPreparedChunk(
    value: unknown,
    input: PrepareArtifactChunkInput,
  ): PrepareArtifactChunkResult {
    let prepared: PrepareArtifactChunkResult;
    try {
      prepared = snapshotPlainObject(
        value,
        preparedChunkKeys,
      ) as unknown as PrepareArtifactChunkResult;
    } catch (error) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
    if (
      prepared.uploadId !== input.uploadId ||
      prepared.chunkIndex !== input.chunkIndex ||
      prepared.offsetBytes !== input.offsetBytes ||
      prepared.chunkBytes !== input.chunkBytes ||
      prepared.chunkSha256 !== input.chunkSha256 ||
      typeof prepared.replayed !== "boolean" ||
      (prepared.receiptState !== "prepared" && prepared.receiptState !== "committed") ||
      (prepared.uploadState !== "receiving" &&
        prepared.uploadState !== "finalizing" &&
        prepared.uploadState !== "committed")
    ) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
    }
    try {
      requireArtifactOperationId(prepared.prepareId, "Artifact chunk prepare ID");
    } catch (error) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
    if (
      (prepared.uploadState === "committed" && prepared.committedArtifact === null) ||
      (prepared.uploadState !== "committed" && prepared.committedArtifact !== null) ||
      !Number.isSafeInteger(prepared.committedNextChunkIndex) ||
      prepared.committedNextChunkIndex < 0 ||
      prepared.committedNextChunkIndex > maximumResultArtifactChunks ||
      !Number.isSafeInteger(prepared.committedOffsetBytes) ||
      prepared.committedOffsetBytes < 0 ||
      prepared.committedOffsetBytes > maximumResultArtifactBytes ||
      !Number.isSafeInteger(prepared.preparedNextChunkIndex) ||
      !Number.isSafeInteger(prepared.preparedNextOffsetBytes) ||
      (prepared.receiptState === "prepared" && prepared.uploadState !== "receiving") ||
      (prepared.receiptState === "prepared" &&
        (prepared.committedNextChunkIndex !== prepared.chunkIndex ||
          prepared.committedOffsetBytes !== prepared.offsetBytes)) ||
      (prepared.receiptState === "committed" &&
        (!prepared.replayed ||
          prepared.committedNextChunkIndex < prepared.chunkIndex + 1 ||
          prepared.committedOffsetBytes < prepared.offsetBytes + prepared.chunkBytes)) ||
      prepared.preparedNextChunkIndex !== prepared.chunkIndex + 1 ||
      prepared.preparedNextOffsetBytes !== prepared.offsetBytes + prepared.chunkBytes
    ) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
    }
    let committedPrefix: PrepareArtifactChunkResult["committedPrefix"];
    try {
      committedPrefix = snapshotCommittedPrefix(
        prepared.committedPrefix,
        prepared.committedNextChunkIndex,
        prepared.committedOffsetBytes,
      );
    } catch (error) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
    if (prepared.uploadState === "committed") {
      const artifact = prepared.committedArtifact;
      let artifactRecord: Record<string, unknown>;
      try {
        artifactRecord = snapshotPlainObject(artifact, ["totalBytes", "sha256"]);
      } catch (error) {
        throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
      }
      if (
        !Number.isSafeInteger(artifactRecord.totalBytes) ||
        (artifactRecord.totalBytes as number) < 1 ||
        (artifactRecord.totalBytes as number) < input.offsetBytes + input.chunkBytes
      ) {
        throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
      }
      try {
        requireArtifactSha256(artifactRecord.sha256 as string);
      } catch (error) {
        throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
      }
      return Object.freeze({
        ...prepared,
        committedPrefix,
        committedArtifact: Object.freeze({
          totalBytes: artifactRecord.totalBytes as number,
          sha256: artifactRecord.sha256 as string,
        }),
      });
    }
    return Object.freeze({ ...prepared, committedPrefix, committedArtifact: null });
  }

  #snapshotPreparedFinalization(
    value: unknown,
    input: FinalizeResultArtifactUploadRequest & { readonly uploadId: string },
  ): PrepareArtifactFinalizeResult {
    try {
      const prepared = snapshotPlainObject(
        value,
        preparedFinalizationKeys,
      ) as unknown as PrepareArtifactFinalizeResult;
      if (
        prepared.uploadId !== input.uploadId ||
        prepared.chunkCount !== input.chunkCount ||
        prepared.totalBytes !== input.totalBytes ||
        prepared.sha256 !== input.sha256 ||
        typeof prepared.replayed !== "boolean" ||
        (prepared.state !== "finalizing" && prepared.state !== "committed") ||
        (prepared.state === "committed" && !prepared.replayed) ||
        prepared.artifactId !== prepared.finalizationId
      ) {
        throw new TypeError("Prepared artifact finalization does not match its request.");
      }
      requireArtifactOperationId(prepared.finalizationId, "Artifact finalization ID");
      requireArtifactSha256(prepared.sha256);
      if (
        prepared.storageObjectKey !== `sha256/${prepared.sha256.slice(0, 2)}/${prepared.sha256}`
      ) {
        throw new TypeError("Prepared artifact finalization object key is invalid.");
      }
      return Object.freeze({ ...prepared });
    } catch (error) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
  }

  #snapshotChunkResponse(
    value: unknown,
    prepared: PrepareArtifactChunkResult,
  ): ResultArtifactChunkResponse {
    let response: ResultArtifactChunkResponse;
    try {
      const result = snapshotPlainObject(
        value,
        committedChunkKeys,
      ) as unknown as CommitArtifactChunkResult;
      const accepted =
        result.outcome === "accepted" &&
        result.state === "receiving" &&
        prepared.receiptState === "prepared" &&
        prepared.uploadState === "receiving" &&
        result.nextChunkIndex === prepared.preparedNextChunkIndex &&
        result.nextOffsetBytes === prepared.preparedNextOffsetBytes;
      const replayed =
        result.outcome === "replayed" &&
        prepared.receiptState === "committed" &&
        prepared.replayed &&
        result.state === prepared.uploadState &&
        result.nextChunkIndex === prepared.committedNextChunkIndex &&
        result.nextOffsetBytes === prepared.committedOffsetBytes;
      if (
        result.uploadId !== prepared.uploadId ||
        result.prepareId !== prepared.prepareId ||
        result.chunkIndex !== prepared.chunkIndex ||
        (!accepted && !replayed)
      ) {
        throw new TypeError("Artifact chunk commit receipt changed identity.");
      }
      response = toResultArtifactChunkResponse(result);
    } catch (error) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
    if (
      !Value.Check(ResultArtifactChunkResponseSchema, response) ||
      response.uploadId !== prepared.uploadId ||
      response.chunkIndex !== prepared.chunkIndex
    ) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
    }
    return Object.freeze({ ...response });
  }

  #snapshotFinalizeResponse(
    value: unknown,
    input: FinalizeResultArtifactUploadRequest & { readonly uploadId: string },
    prepared: PrepareArtifactFinalizeResult,
  ): FinalizeResultArtifactUploadResponse {
    let response: FinalizeResultArtifactUploadResponse;
    try {
      const record = snapshotPlainObject(value, committedFinalizeKeys);
      const artifact = snapshotPlainObject(record.artifact, internalArtifactKeys);
      const result = {
        state: record.state,
        replayed: record.replayed,
        artifact,
      } as unknown as CommitArtifactFinalizeResult;
      if (
        result.state !== "committed" ||
        typeof result.replayed !== "boolean" ||
        result.replayed !== (prepared.state === "committed") ||
        artifact.storageObjectKey !== prepared.storageObjectKey
      ) {
        throw new TypeError("Artifact finalization commit receipt is inconsistent.");
      }
      response = toFinalizeResultArtifactUploadResponse(result);
    } catch (error) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
    if (
      !Value.Check(FinalizeResultArtifactUploadResponseSchema, response) ||
      response.artifact.uploadId !== input.uploadId ||
      response.artifact.artifactId !== prepared.finalizationId ||
      response.artifact.jobId !== input.jobId ||
      response.artifact.runAttemptId !== input.runAttemptId ||
      response.artifact.totalBytes !== input.totalBytes ||
      response.artifact.sha256 !== input.sha256
    ) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
    }
    return Object.freeze({ ...response, artifact: Object.freeze({ ...response.artifact }) });
  }

  #snapshotTerminationResponse(
    value: unknown,
    uploadId: string,
  ): TerminateResultArtifactUploadResponse {
    let response: TerminateResultArtifactUploadResponse;
    try {
      const result = snapshotPlainObject(
        value,
        terminationResultKeys,
      ) as unknown as TerminateArtifactUploadResult;
      response = toTerminateResultArtifactUploadResponse(result);
      requireCanonicalDateTime(response.terminatedAt, "Artifact termination time");
    } catch (error) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
    if (
      response.uploadId !== uploadId ||
      response.state !== "abandoned" ||
      response.reason !== "client_abandoned" ||
      typeof response.replayed !== "boolean"
    ) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
    }
    return Object.freeze({ ...response });
  }

  async #readVerifiedObject(
    identity: { readonly totalBytes: number; readonly sha256: string },
    deadline: number,
  ): Promise<Buffer> {
    const input = normalizeArtifactStorageOperationInput("readObject", identity);
    const bytes = await this.#storageStage(() => this.#storage.readObject(input), deadline);
    if (!Buffer.isBuffer(bytes)) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
    }
    const copy = Buffer.from(bytes);
    const digest = createHash("sha256").update(copy).digest();
    const expected = Buffer.from(identity.sha256, "hex");
    if (
      copy.byteLength !== identity.totalBytes ||
      digest.byteLength !== expected.byteLength ||
      !timingSafeEqual(digest, expected)
    ) {
      throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE");
    }
    return copy;
  }

  #runTransaction<T>(
    signal: AbortSignal | undefined,
    action: (deadline: number) => Promise<T>,
  ): Promise<T> {
    const admission = this.#admissionError();
    if (admission !== undefined) return Promise.reject(admission);
    const deadline = performance.now() + this.#requestTimeoutMilliseconds;
    return this.#gate
      .run({ deadline, ...(signal === undefined ? {} : { signal }) }, () => {
        const entered = this.#admissionError();
        if (entered !== undefined) throw entered;
        return action(deadline);
      })
      .catch((error: unknown) => {
        if (error instanceof ArtifactTransactionCoordinatorError) throw error;
        if (error instanceof ArtifactMutationGateError && !error.callbackStarted) {
          switch (error.code) {
            case "ARTIFACT_MUTATION_GATE_BUSY":
              throw coordinatorError("ARTIFACT_TRANSACTION_BUSY", error);
            case "ARTIFACT_MUTATION_GATE_CANCELLED":
              throw coordinatorError("ARTIFACT_TRANSACTION_CANCELLED", error);
            case "ARTIFACT_MUTATION_GATE_TIMEOUT":
              throw coordinatorError("ARTIFACT_TRANSACTION_TIMEOUT", error);
            case "ARTIFACT_MUTATION_GATE_INVALID_REQUEST":
              throw coordinatorError("ARTIFACT_TRANSACTION_INVALID_REQUEST", error);
            case "ARTIFACT_MUTATION_GATE_CLOSED":
              throw coordinatorError("ARTIFACT_TRANSACTION_CLOSED", error);
            default:
              throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
          }
        }
        throw this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
      });
  }

  #admissionError(): ArtifactTransactionCoordinatorError | undefined {
    if (this.#fatalError !== undefined) return this.#fatalError;
    if (this.#state === "starting") return coordinatorError("ARTIFACT_TRANSACTION_NOT_READY");
    if (this.#state !== "open") return coordinatorError("ARTIFACT_TRANSACTION_CLOSED");
    if (!healthyForAdmission(this.#reconciliation.health)) {
      return coordinatorError("ARTIFACT_TRANSACTION_NOT_READY");
    }
    return undefined;
  }

  async #databaseStage<TOperation extends ArtifactTransactionDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
    deadline: number,
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    return this.#ownerStage(() => this.#database.request(operation, input), deadline, "database");
  }

  async #storageStage<T>(action: () => Promise<T>, deadline: number): Promise<T> {
    return this.#ownerStage(action, deadline, "storage");
  }

  async #ownerStage<T>(
    action: () => Promise<T>,
    deadline: number,
    owner: "database" | "storage",
  ): Promise<T> {
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (performance.now() >= deadline) {
      throw coordinatorError("ARTIFACT_TRANSACTION_TIMEOUT");
    }
    try {
      return await this.#awaitBeforeDeadline(action, deadline, owner);
    } catch (error) {
      if (error instanceof ArtifactTransactionCoordinatorError) throw error;
      if (owner === "database" && error instanceof DatabaseRequestError) {
        throw this.#mapDatabaseError(error);
      }
      if (
        owner === "storage" &&
        error instanceof ArtifactStorageClientError &&
        error.code === "ARTIFACT_STORAGE_INTEGRITY"
      ) {
        throw this.#enterFatal("ARTIFACT_TRANSACTION_STORAGE_INTEGRITY");
      }
      if (
        owner === "storage" &&
        error instanceof ArtifactStorageClientError &&
        error.code === "ARTIFACT_STORAGE_CLIENT_BUSY" &&
        error.retryable
      ) {
        throw coordinatorError("ARTIFACT_TRANSACTION_BUSY", error);
      }
      throw this.#enterFatal(
        owner === "database"
          ? "ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN"
          : "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN",
        error,
      );
    }
  }

  async #awaitBeforeDeadline<T>(
    action: () => Promise<T>,
    deadline: number,
    owner: "database" | "storage",
  ): Promise<T> {
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (performance.now() >= deadline) {
      throw coordinatorError("ARTIFACT_TRANSACTION_TIMEOUT");
    }
    let timer: NodeJS.Timeout | undefined;
    const interrupted = Promise.withResolvers<never>();
    // A synchronous fatal transition can reject this before Promise.race observes it.
    void interrupted.promise.catch(() => undefined);
    const rejectFatal: FatalWaiter = interrupted.reject;
    this.#fatalWaiters.add(rejectFatal);
    try {
      if (this.#fatalError !== undefined) {
        throw this.#fatalError;
      }
      if (performance.now() >= deadline) {
        throw coordinatorError("ARTIFACT_TRANSACTION_TIMEOUT");
      }
      let operation: Promise<T>;
      try {
        operation = action();
      } catch (error) {
        if (
          owner === "storage" &&
          error instanceof ArtifactStorageClientError &&
          error.code === "ARTIFACT_STORAGE_INTEGRITY"
        ) {
          throw this.#enterFatal("ARTIFACT_TRANSACTION_STORAGE_INTEGRITY");
        }
        throw this.#enterFatal(
          owner === "database"
            ? "ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN"
            : "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN",
          error,
        );
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              this.#enterFatal(
                owner === "database"
                  ? "ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN"
                  : "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN",
              ),
            ),
          Math.max(1, Math.ceil(deadline - performance.now())),
        );
        timer.unref();
      });
      const result = await Promise.race([operation, interrupted.promise, timeout]);
      if (performance.now() >= deadline) {
        throw this.#enterFatal(
          owner === "database"
            ? "ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN"
            : "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN",
        );
      }
      if (this.#fatalError !== undefined) throw this.#fatalError;
      return result;
    } finally {
      this.#fatalWaiters.delete(rejectFatal);
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #mapDatabaseError(error: DatabaseRequestError): ArtifactTransactionCoordinatorError {
    switch (error.code) {
      case "LEASE_LOST":
        return coordinatorError("ARTIFACT_TRANSACTION_LEASE_LOST", error);
      case "ARTIFACT_UPLOAD_CONFLICT":
        return coordinatorError("ARTIFACT_TRANSACTION_CONFLICT", error);
      case "ARTIFACT_COMPLETION_MODE_MISMATCH":
        return coordinatorError("ARTIFACT_TRANSACTION_COMPLETION_MODE_MISMATCH", error);
      case "ARTIFACT_UPLOAD_QUOTA_EXCEEDED":
        return coordinatorError("ARTIFACT_TRANSACTION_QUOTA_EXCEEDED", error);
      default:
        return this.#enterFatal("ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN", error);
    }
  }

  #mapCreateError(error: unknown): ArtifactTransactionCoordinatorError {
    if (!(error instanceof ArtifactUploadCreateCoordinatorError)) {
      return this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
    switch (error.code) {
      case "ARTIFACT_CREATE_BUSY":
        return coordinatorError("ARTIFACT_TRANSACTION_BUSY", error);
      case "ARTIFACT_CREATE_CANCELLED":
        return coordinatorError("ARTIFACT_TRANSACTION_CANCELLED", error);
      case "ARTIFACT_CREATE_CAPACITY":
        return coordinatorError("ARTIFACT_TRANSACTION_CAPACITY", error);
      case "ARTIFACT_CREATE_CLOSED":
        return coordinatorError("ARTIFACT_TRANSACTION_CLOSED", error);
      case "ARTIFACT_CREATE_COMPLETION_MODE_MISMATCH":
        return coordinatorError("ARTIFACT_TRANSACTION_COMPLETION_MODE_MISMATCH", error);
      case "ARTIFACT_CREATE_CONFLICT":
        return coordinatorError("ARTIFACT_TRANSACTION_CONFLICT", error);
      case "ARTIFACT_CREATE_INVALID_REQUEST":
        return coordinatorError("ARTIFACT_TRANSACTION_INVALID_REQUEST", error);
      case "ARTIFACT_CREATE_LEASE_LOST":
        return coordinatorError("ARTIFACT_TRANSACTION_LEASE_LOST", error);
      case "ARTIFACT_CREATE_QUOTA_EXCEEDED":
        return coordinatorError("ARTIFACT_TRANSACTION_QUOTA_EXCEEDED", error);
      case "ARTIFACT_CREATE_TIMEOUT":
        return coordinatorError("ARTIFACT_TRANSACTION_TIMEOUT", error);
      case "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE":
        return this.#enterFatal("ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE", error);
      case "ARTIFACT_CREATE_DATABASE_FAILURE":
      case "ARTIFACT_CREATE_OUTCOME_UNKNOWN":
        return this.#enterFatal("ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN", error);
      case "ARTIFACT_CREATE_STORAGE_FAILURE":
        return this.#enterFatal("ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN", error);
      case "ARTIFACT_CREATE_STORAGE_INTEGRITY":
        return this.#enterFatal("ARTIFACT_TRANSACTION_STORAGE_INTEGRITY");
      case "ARTIFACT_CREATE_PROTOCOL_FAILURE":
        return this.#enterFatal("ARTIFACT_TRANSACTION_PROTOCOL_FAILURE", error);
    }
  }

  #completeStartup(): void {
    if (this.#state !== "starting" || this.#fatalError !== undefined) return;
    if (!healthyForAdmission(this.#reconciliation.health)) {
      this.#enterFatal("ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE");
      return;
    }
    this.#state = "open";
    this.#readySettled = true;
    this.#ready.resolve();
  }

  #observeOwnerFailure(owner: "database" | "storage", error: unknown): void {
    if (this.#state === "closing" || this.#state === "closed") {
      return;
    }
    if (
      owner === "storage" &&
      error instanceof ArtifactStorageClientError &&
      error.code === "ARTIFACT_STORAGE_INTEGRITY"
    ) {
      this.#enterFatal("ARTIFACT_TRANSACTION_STORAGE_INTEGRITY");
      return;
    }
    this.#enterFatal(
      error instanceof Error
        ? owner === "database"
          ? "ARTIFACT_TRANSACTION_DATABASE_OUTCOME_UNKNOWN"
          : "ARTIFACT_TRANSACTION_STORAGE_OUTCOME_UNKNOWN"
        : "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
      error,
    );
  }

  #enterFatal(
    code: ArtifactTransactionCoordinatorErrorCode,
    cause?: unknown,
  ): ArtifactTransactionCoordinatorError {
    if (this.#fatalError !== undefined) return this.#fatalError;
    const error = coordinatorError(code, cause);
    if (!error.requiresFailStop) {
      throw new TypeError("Artifact transaction fatal transition requires a fatal error.");
    }
    this.#fatalError = error;
    this.#state = "fatal";
    this.#gate.poison(error);
    this.#rejectReady(error);
    this.#fatal.resolve(error);
    for (const reject of [...this.#fatalWaiters]) reject(error);
    let completion: Promise<void>;
    try {
      completion = Promise.resolve(this.#onFailStop(error));
    } catch (callbackError) {
      completion = Promise.reject(callbackError);
    }
    void completion.catch(() => undefined);
    this.#failStopCallbackCompletion = completion;
    return error;
  }

  #rejectReady(error: unknown): void {
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#ready.reject(error);
    }
  }

  async #close(deadline: number): Promise<void> {
    let priorFatal = this.#fatalError;
    try {
      await this.#boundedClose(() => this.#reconciliation.close(), deadline);
    } catch (error) {
      priorFatal ??= this.#enterFatal("ARTIFACT_TRANSACTION_RECONCILIATION_FAILURE", error);
    }
    try {
      await this.#boundedClose(() => this.#gate.close(), deadline);
    } catch (error) {
      priorFatal ??= this.#enterFatal("ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE", error);
    }
    try {
      await this.#boundedClose(() => this.#create.close(), deadline);
    } catch (error) {
      priorFatal ??= this.#enterFatal("ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE", error);
    }
    priorFatal ??= this.#fatalError;
    if (priorFatal !== undefined) throw priorFatal;
    this.#state = "closed";
  }

  async #boundedClose(action: () => Promise<void>, deadline: number): Promise<void> {
    // Teardown must always be dispatched once, even when an earlier close stage consumed the
    // absolute deadline. The caller still receives the deadline failure while owner shutdown
    // continues under each owner's own bounded process semantics.
    const operation = action();
    if (performance.now() >= deadline) {
      void operation.catch(() => undefined);
      throw coordinatorError("ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE");
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(coordinatorError("ARTIFACT_TRANSACTION_OWNER_SHUTDOWN_FAILURE")),
            Math.max(1, Math.ceil(deadline - performance.now())),
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
