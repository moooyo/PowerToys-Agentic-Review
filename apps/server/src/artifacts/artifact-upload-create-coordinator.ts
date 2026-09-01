import { performance } from "node:perf_hooks";
import {
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunks,
} from "@agentic-review/contracts";
import type {
  CreateArtifactUploadInput,
  CreateArtifactUploadResult,
  ProbeArtifactUploadCreateResult,
} from "../database/artifacts.js";
import { DatabaseRequestError } from "../database/errors.js";
import { snapshotArtifactCapacityLimits } from "./capacity.js";
import { ArtifactStorageClientError } from "./errors.js";
import { SerialFifo } from "./fifo.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactCapacityEvaluationInput,
  ArtifactCapacityLimits,
} from "./types.js";
import {
  assertArtifactStorageResponseMatchesExpectation,
  createArtifactStorageResponseExpectation,
  normalizeArtifactStorageOperationInput,
  normalizeArtifactStorageOperationOutput,
} from "./worker-protocol.js";

const maximumCoordinatorTimeoutMilliseconds = 600_000;
const maximumCoordinatorPendingCreates = 1_024;
const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const artifactNamePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const terminalReasonPattern = /^[a-z][a-z0-9_]{0,127}$/u;
const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;
const adoptedOwnerIdentities = new WeakSet<object>();
const artifactUploadCreateDatabaseHandleBrand: unique symbol = Symbol(
  "artifact-upload-create-database-handle",
);

const isCanonicalDateTime = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

export type ArtifactUploadCreateCoordinatorErrorCode =
  | "ARTIFACT_CREATE_BUSY"
  | "ARTIFACT_CREATE_CANCELLED"
  | "ARTIFACT_CREATE_CAPACITY"
  | "ARTIFACT_CREATE_CLOSED"
  | "ARTIFACT_CREATE_COMPLETION_MODE_MISMATCH"
  | "ARTIFACT_CREATE_CONFLICT"
  | "ARTIFACT_CREATE_DATABASE_FAILURE"
  | "ARTIFACT_CREATE_INVALID_REQUEST"
  | "ARTIFACT_CREATE_LEASE_LOST"
  | "ARTIFACT_CREATE_OUTCOME_UNKNOWN"
  | "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE"
  | "ARTIFACT_CREATE_PROTOCOL_FAILURE"
  | "ARTIFACT_CREATE_QUOTA_EXCEEDED"
  | "ARTIFACT_CREATE_STORAGE_FAILURE"
  | "ARTIFACT_CREATE_TIMEOUT";

interface CoordinatorErrorDefinition {
  readonly message: string;
  readonly retryable: boolean;
  readonly requiresFailStop: boolean;
}

const coordinatorErrorCatalog: Readonly<
  Record<ArtifactUploadCreateCoordinatorErrorCode, CoordinatorErrorDefinition>
> = Object.freeze({
  ARTIFACT_CREATE_BUSY: {
    message: "Artifact upload create capacity is busy.",
    retryable: true,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_CANCELLED: {
    message: "Artifact upload create was cancelled before durable creation.",
    retryable: true,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_CAPACITY: {
    message: "Artifact upload storage capacity is unavailable.",
    retryable: true,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_CLOSED: {
    message: "Artifact upload create coordinator is closed.",
    retryable: false,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_COMPLETION_MODE_MISMATCH: {
    message: "Artifact completion mode does not permit upload creation.",
    retryable: false,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_CONFLICT: {
    message: "Artifact upload create conflicts with durable state.",
    retryable: false,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_DATABASE_FAILURE: {
    message: "Artifact upload database owner failed.",
    retryable: false,
    requiresFailStop: true,
  },
  ARTIFACT_CREATE_INVALID_REQUEST: {
    message: "Artifact upload create request is invalid.",
    retryable: false,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_LEASE_LOST: {
    message: "Artifact upload lease is no longer active.",
    retryable: false,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_OUTCOME_UNKNOWN: {
    message: "Artifact upload durable create outcome is unknown.",
    retryable: false,
    requiresFailStop: true,
  },
  ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE: {
    message: "Artifact upload owner shutdown could not be proven safe.",
    retryable: false,
    requiresFailStop: true,
  },
  ARTIFACT_CREATE_PROTOCOL_FAILURE: {
    message: "Artifact upload owner returned invalid protocol data.",
    retryable: false,
    requiresFailStop: true,
  },
  ARTIFACT_CREATE_QUOTA_EXCEEDED: {
    message: "Artifact upload quota is exhausted.",
    retryable: false,
    requiresFailStop: false,
  },
  ARTIFACT_CREATE_STORAGE_FAILURE: {
    message: "Artifact upload storage owner failed.",
    retryable: false,
    requiresFailStop: true,
  },
  ARTIFACT_CREATE_TIMEOUT: {
    message: "Artifact upload create exceeded its deadline before durable creation.",
    retryable: true,
    requiresFailStop: false,
  },
});

export class ArtifactUploadCreateCoordinatorError extends Error {
  readonly code: ArtifactUploadCreateCoordinatorErrorCode;
  readonly retryable: boolean;
  readonly requiresFailStop: boolean;

  constructor(code: ArtifactUploadCreateCoordinatorErrorCode) {
    const definition = coordinatorErrorCatalog[code];
    super(definition.message);
    this.name = "ArtifactUploadCreateCoordinatorError";
    this.code = code;
    this.retryable = definition.retryable;
    this.requiresFailStop = definition.requiresFailStop;
  }
}

interface ArtifactUploadCreateDatabaseOwner {
  probeArtifactUploadCreate(
    input: CreateArtifactUploadInput,
  ): Promise<ProbeArtifactUploadCreateResult>;
  createArtifactUpload(input: CreateArtifactUploadInput): Promise<CreateArtifactUploadResult>;
  close(): Promise<void>;
}

export interface ArtifactUploadCreateDatabaseHandle {
  readonly [artifactUploadCreateDatabaseHandleBrand]: true;
}

interface ArtifactUploadCreateDatabaseHandleRecord {
  readonly identity: object;
  readonly owner: ArtifactUploadCreateDatabaseOwner;
}

const databaseHandleRecords = new WeakMap<object, ArtifactUploadCreateDatabaseHandleRecord>();

export interface ArtifactUploadCreateStorageOwner {
  readonly ownerExit: Promise<number>;
  evaluateCapacity(input: ArtifactCapacityEvaluationInput): Promise<ArtifactCapacityAdmission>;
  close(): Promise<void>;
}

export interface ArtifactUploadCreateOwnerLock {
  close(): Promise<void>;
}

export interface ArtifactUploadCreateCoordinatorOptions {
  /** All owners MUST be ready. Successful start transfers their shutdown ownership here. */
  /** Opaque one-shot handle minted by DatabaseClient; it exposes no database operations. */
  readonly database: ArtifactUploadCreateDatabaseHandle;
  readonly storage: ArtifactUploadCreateStorageOwner;
  /** MUST equal the immutable capacity snapshot used to start the storage owner. */
  readonly storageCapacity: ArtifactCapacityLimits;
  readonly databaseOwnerLock: ArtifactUploadCreateOwnerLock;
  readonly requestTimeoutMilliseconds: number;
  readonly closeTimeoutMilliseconds: number;
  readonly storageJoinTimeoutMilliseconds: number;
  readonly maximumPendingCreates: number;
  /**
   * The supervisor MUST fail-stop and use coordinator.close(), never close adopted owners itself.
   */
  readonly onFailStop: (error: ArtifactUploadCreateCoordinatorError) => void | Promise<void>;
}

const createDatabaseHandle = (
  identity: object,
  owner: ArtifactUploadCreateDatabaseOwner,
): ArtifactUploadCreateDatabaseHandle => {
  const handle = Object.freeze(Object.create(null)) as ArtifactUploadCreateDatabaseHandle;
  databaseHandleRecords.set(handle, { identity, owner: Object.freeze(owner) });
  return handle;
};

/** @internal Imported only by DatabaseClient and the isolated fake-owner testing adapter. */
export const registerArtifactUploadCreateDatabaseHandle = (
  identity: object,
  owner: ArtifactUploadCreateDatabaseOwner,
): ArtifactUploadCreateDatabaseHandle => {
  const probeArtifactUploadCreate = owner.probeArtifactUploadCreate;
  const createArtifactUpload = owner.createArtifactUpload;
  const close = owner.close;
  if (
    typeof probeArtifactUploadCreate !== "function" ||
    typeof createArtifactUpload !== "function" ||
    typeof close !== "function"
  ) {
    throw new TypeError("Artifact create database owner binding is invalid.");
  }
  return createDatabaseHandle(identity, {
    probeArtifactUploadCreate: (input) =>
      Reflect.apply(probeArtifactUploadCreate, owner, [
        input,
      ]) as Promise<ProbeArtifactUploadCreateResult>,
    createArtifactUpload: (input) =>
      Reflect.apply(createArtifactUpload, owner, [input]) as Promise<CreateArtifactUploadResult>,
    close: () => Reflect.apply(close, owner, []) as Promise<void>,
  });
};

const consumeDatabaseHandle = (
  handle: ArtifactUploadCreateDatabaseHandle,
): {
  readonly record: ArtifactUploadCreateDatabaseHandleRecord;
  readonly restore: () => void;
} => {
  if (typeof handle !== "object" || handle === null) {
    throw new TypeError("Artifact create database handle is invalid.");
  }
  const record = databaseHandleRecords.get(handle);
  if (record === undefined) {
    throw new TypeError("Artifact create database handle was already consumed.");
  }
  databaseHandleRecords.delete(handle);
  return {
    record,
    restore: () => {
      if (!databaseHandleRecords.has(handle)) {
        databaseHandleRecords.set(handle, record);
      }
    },
  };
};

type CreateTaskPhase = "queued" | "probe" | "capacity" | "create" | "done";

interface CreateTask {
  readonly input: CreateArtifactUploadInput;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  readonly result: Promise<CreateArtifactUploadResult>;
  readonly resolve: (value: CreateArtifactUploadResult) => void;
  readonly reject: (error: ArtifactUploadCreateCoordinatorError) => void;
  timer: NodeJS.Timeout | undefined;
  abortListener: (() => void) | undefined;
  phase: CreateTaskPhase;
  settled: boolean;
}

const requirePositiveBoundedInteger = (value: unknown, maximum: number, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${name} must be a positive bounded integer.`);
  }
  return value as number;
};

const requireOwnerIdentity = (value: unknown): object => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("Artifact create coordinator owners are invalid.");
  }
  return value;
};

const claimOwnerIdentities = (
  databaseIdentity: object,
  storage: ArtifactUploadCreateStorageOwner,
  databaseOwnerLock: ArtifactUploadCreateOwnerLock,
): (() => void) => {
  const identities = [
    requireOwnerIdentity(databaseIdentity),
    requireOwnerIdentity(storage),
    requireOwnerIdentity(databaseOwnerLock),
  ];
  const uniqueIdentities = new Set(identities);
  if (
    uniqueIdentities.size !== identities.length ||
    identities.some((identity) => adoptedOwnerIdentities.has(identity))
  ) {
    throw new TypeError("Artifact create coordinator owners were already adopted.");
  }
  for (const identity of identities) {
    adoptedOwnerIdentities.add(identity);
  }
  return () => {
    for (const identity of identities) {
      adoptedOwnerIdentities.delete(identity);
    }
  };
};

const bindOwnerExit = (value: unknown): Promise<number> => {
  if (!(value instanceof Promise)) {
    throw new TypeError("Artifact storage owner exit signal is invalid.");
  }
  return new Promise<number>((resolve, reject) => {
    Reflect.apply(Promise.prototype.then, value, [resolve, reject]);
  });
};

const requireRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value as Record<string, unknown>;
};

const requireExactKeys = (
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new TypeError("Artifact upload create data has unsupported or missing fields.");
  }
};

const createCoordinatorError = (
  code: ArtifactUploadCreateCoordinatorErrorCode,
): ArtifactUploadCreateCoordinatorError => new ArtifactUploadCreateCoordinatorError(code);

const snapshotAbortSignal = (value: unknown): AbortSignal | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("Artifact upload create cancellation signal is invalid.");
  }
  isAbortSignalAborted(value);
  return value;
};

const isAbortSignalAborted = (signal: AbortSignal): boolean => {
  if (abortSignalAbortedGetter === undefined) {
    throw new TypeError("Artifact upload create cancellation signal is unavailable.");
  }
  return Reflect.apply(abortSignalAbortedGetter, signal, []) as boolean;
};

const addAbortSignalListener = (signal: AbortSignal, listener: () => void): void => {
  Reflect.apply(addEventListener, signal, ["abort", listener, { once: true }]);
};

const removeAbortSignalListener = (signal: AbortSignal, listener: () => void): void => {
  Reflect.apply(removeEventListener, signal, ["abort", listener]);
};

const snapshotCreateInput = (value: unknown): CreateArtifactUploadInput => {
  const record = requireRecord(value, "Artifact upload create request");
  requireExactKeys(record, [
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
  ]);
  const snapshot = Object.freeze({
    jobId: record.jobId,
    runAttemptId: record.runAttemptId,
    workerNodeId: record.workerNodeId,
    workerInstanceId: record.workerInstanceId,
    leaseToken: record.leaseToken,
    leaseGeneration: record.leaseGeneration,
    clientArtifactId: record.clientArtifactId,
    purpose: record.purpose,
    name: record.name,
    mediaType: record.mediaType,
    totalBytes: record.totalBytes,
    sha256: record.sha256,
  });
  if (
    typeof snapshot.jobId !== "string" ||
    !entityIdPattern.test(snapshot.jobId) ||
    typeof snapshot.runAttemptId !== "string" ||
    !entityIdPattern.test(snapshot.runAttemptId) ||
    typeof snapshot.workerNodeId !== "string" ||
    !entityIdPattern.test(snapshot.workerNodeId) ||
    typeof snapshot.workerInstanceId !== "string" ||
    !entityIdPattern.test(snapshot.workerInstanceId) ||
    typeof snapshot.leaseToken !== "string" ||
    snapshot.leaseToken.length < 32 ||
    snapshot.leaseToken.length > 1_024 ||
    !Number.isSafeInteger(snapshot.leaseGeneration) ||
    (snapshot.leaseGeneration as number) < 1 ||
    typeof snapshot.clientArtifactId !== "string" ||
    !uuidV4Pattern.test(snapshot.clientArtifactId) ||
    snapshot.purpose !== "result" ||
    typeof snapshot.name !== "string" ||
    !artifactNamePattern.test(snapshot.name) ||
    snapshot.mediaType !== "application/json" ||
    !Number.isSafeInteger(snapshot.totalBytes) ||
    (snapshot.totalBytes as number) < 1 ||
    (snapshot.totalBytes as number) > maximumResultArtifactBytes ||
    typeof snapshot.sha256 !== "string" ||
    !sha256Pattern.test(snapshot.sha256)
  ) {
    throw new TypeError("Artifact upload create request is invalid.");
  }
  return snapshot as CreateArtifactUploadInput;
};

const snapshotCreateResult = (value: unknown): CreateArtifactUploadResult => {
  const record = requireRecord(value, "Artifact upload create result");
  const state = record.state;
  const terminal = state === "abandoned" || state === "corrupt";
  requireExactKeys(record, [
    "uploadId",
    "maximumChunkBytes",
    "maximumChunkCount",
    "state",
    "replayed",
    "nextChunkIndex",
    "nextOffsetBytes",
    ...(terminal ? ["reason", "terminatedAt"] : []),
  ]);
  const snapshot = Object.freeze({
    uploadId: record.uploadId,
    maximumChunkBytes: record.maximumChunkBytes,
    maximumChunkCount: record.maximumChunkCount,
    state,
    replayed: record.replayed,
    nextChunkIndex: record.nextChunkIndex,
    nextOffsetBytes: record.nextOffsetBytes,
    ...(terminal ? { reason: record.reason, terminatedAt: record.terminatedAt } : {}),
  });
  const validState =
    snapshot.state === "receiving" ||
    snapshot.state === "finalizing" ||
    snapshot.state === "committed" ||
    snapshot.state === "abandoned" ||
    snapshot.state === "corrupt";
  if (
    typeof snapshot.uploadId !== "string" ||
    !entityIdPattern.test(snapshot.uploadId) ||
    snapshot.maximumChunkBytes !== maximumResultArtifactChunkBytes ||
    snapshot.maximumChunkCount !== maximumResultArtifactChunks ||
    !validState ||
    typeof snapshot.replayed !== "boolean" ||
    !Number.isSafeInteger(snapshot.nextChunkIndex) ||
    (snapshot.nextChunkIndex as number) < 0 ||
    (snapshot.nextChunkIndex as number) > maximumResultArtifactChunks ||
    !Number.isSafeInteger(snapshot.nextOffsetBytes) ||
    (snapshot.nextOffsetBytes as number) < 0 ||
    (snapshot.nextOffsetBytes as number) > maximumResultArtifactBytes ||
    (!snapshot.replayed &&
      (snapshot.state !== "receiving" ||
        snapshot.nextChunkIndex !== 0 ||
        snapshot.nextOffsetBytes !== 0)) ||
    (terminal &&
      (!snapshot.replayed ||
        typeof snapshot.reason !== "string" ||
        !terminalReasonPattern.test(snapshot.reason) ||
        !isCanonicalDateTime(snapshot.terminatedAt)))
  ) {
    throw new TypeError("Artifact upload create result is invalid.");
  }
  return snapshot as CreateArtifactUploadResult;
};

/**
 * Owns the single-Server create gate and the shutdown order for ready database and storage owners.
 * Every Server artifact-create caller MUST share this instance and must not call the DB create
 * operation or close adopted owners directly after start succeeds.
 */
export class ArtifactUploadCreateCoordinator {
  readonly #database: ArtifactUploadCreateDatabaseOwner;
  readonly #storage: ArtifactUploadCreateStorageOwner;
  readonly #storageOwnerExit: Promise<number>;
  readonly #storageCapacity: ArtifactCapacityLimits;
  readonly #databaseOwnerLock: ArtifactUploadCreateOwnerLock;
  readonly #requestTimeoutMilliseconds: number;
  readonly #closeTimeoutMilliseconds: number;
  readonly #storageJoinTimeoutMilliseconds: number;
  readonly #maximumPendingCreates: number;
  readonly #onFailStop: (error: ArtifactUploadCreateCoordinatorError) => void | Promise<void>;
  readonly #fifo = new SerialFifo();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #tasks = new Set<CreateTask>();
  readonly #fatalSignal = Promise.withResolvers<ArtifactUploadCreateCoordinatorError>();
  readonly #quiescenceWaiters = new Set<() => void>();
  #admissionReservations = 0;
  #storageShutdownStarted = false;
  #state: "open" | "closing" | "closed" | "fatal" = "open";
  #fatalError: ArtifactUploadCreateCoordinatorError | undefined;
  #failStopCallbackCompletion: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    options: ArtifactUploadCreateCoordinatorOptions,
    database: ArtifactUploadCreateDatabaseOwner,
    storage: ArtifactUploadCreateStorageOwner,
    databaseOwnerLock: ArtifactUploadCreateOwnerLock,
  ) {
    const probeArtifactUploadCreate = database?.probeArtifactUploadCreate;
    const createArtifactUpload = database?.createArtifactUpload;
    const closeDatabase = database?.close;
    const rawStorageOwnerExit = storage?.ownerExit;
    const evaluateCapacity = storage?.evaluateCapacity;
    const closeStorage = storage?.close;
    const closeDatabaseOwnerLock = databaseOwnerLock?.close;
    const onFailStop = options.onFailStop;
    if (
      typeof probeArtifactUploadCreate !== "function" ||
      typeof createArtifactUpload !== "function" ||
      typeof closeDatabase !== "function" ||
      !(rawStorageOwnerExit instanceof Promise) ||
      typeof evaluateCapacity !== "function" ||
      typeof closeStorage !== "function" ||
      typeof closeDatabaseOwnerLock !== "function" ||
      typeof onFailStop !== "function"
    ) {
      throw new TypeError("Artifact create coordinator owners are invalid.");
    }
    const storageCapacity = snapshotArtifactCapacityLimits(options.storageCapacity);
    const requestTimeoutMilliseconds = requirePositiveBoundedInteger(
      options.requestTimeoutMilliseconds,
      maximumCoordinatorTimeoutMilliseconds,
      "Artifact create request timeout",
    );
    const closeTimeoutMilliseconds = requirePositiveBoundedInteger(
      options.closeTimeoutMilliseconds,
      maximumCoordinatorTimeoutMilliseconds,
      "Artifact create close timeout",
    );
    const storageJoinTimeoutMilliseconds = requirePositiveBoundedInteger(
      options.storageJoinTimeoutMilliseconds,
      maximumCoordinatorTimeoutMilliseconds,
      "Artifact storage owner join timeout",
    );
    const maximumPendingCreates = requirePositiveBoundedInteger(
      options.maximumPendingCreates,
      maximumCoordinatorPendingCreates,
      "Artifact create pending limit",
    );
    const storageOwnerExit = bindOwnerExit(rawStorageOwnerExit);
    this.#database = Object.freeze({
      probeArtifactUploadCreate: (input: CreateArtifactUploadInput) =>
        Reflect.apply(probeArtifactUploadCreate, database, [
          input,
        ]) as Promise<ProbeArtifactUploadCreateResult>,
      createArtifactUpload: (input: CreateArtifactUploadInput) =>
        Reflect.apply(createArtifactUpload, database, [
          input,
        ]) as Promise<CreateArtifactUploadResult>,
      close: () => Reflect.apply(closeDatabase, database, []) as Promise<void>,
    });
    this.#storage = Object.freeze({
      ownerExit: storageOwnerExit,
      evaluateCapacity: (input: ArtifactCapacityEvaluationInput) =>
        Reflect.apply(evaluateCapacity, storage, [input]) as Promise<ArtifactCapacityAdmission>,
      close: () => Reflect.apply(closeStorage, storage, []) as Promise<void>,
    });
    this.#databaseOwnerLock = Object.freeze({
      close: () => Reflect.apply(closeDatabaseOwnerLock, databaseOwnerLock, []) as Promise<void>,
    });
    this.#storageOwnerExit = storageOwnerExit;
    this.#storageCapacity = storageCapacity;
    this.#requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.#closeTimeoutMilliseconds = closeTimeoutMilliseconds;
    this.#storageJoinTimeoutMilliseconds = storageJoinTimeoutMilliseconds;
    this.#maximumPendingCreates = maximumPendingCreates;
    this.#onFailStop = (error) =>
      Reflect.apply(onFailStop, undefined, [error]) as void | Promise<void>;
    void this.#storageOwnerExit.then(
      (exitCode) => this.#observeStorageOwnerExit(exitCode),
      () => this.#observeStorageOwnerExit(undefined),
    );
  }

  static start(options: ArtifactUploadCreateCoordinatorOptions): ArtifactUploadCreateCoordinator {
    const databaseHandle = options.database;
    const storage = options.storage;
    const databaseOwnerLock = options.databaseOwnerLock;
    const consumedDatabase = consumeDatabaseHandle(databaseHandle);
    let releaseOwners: (() => void) | undefined;
    try {
      releaseOwners = claimOwnerIdentities(
        consumedDatabase.record.identity,
        storage,
        databaseOwnerLock,
      );
      return new ArtifactUploadCreateCoordinator(
        options,
        consumedDatabase.record.owner,
        storage,
        databaseOwnerLock,
      );
    } catch (error) {
      releaseOwners?.();
      consumedDatabase.restore();
      throw error;
    }
  }

  /** Every value delivered here already required the Server supervisor to enter fail-stop. */
  get fatal(): Promise<ArtifactUploadCreateCoordinatorError> {
    return this.#fatalSignal.promise;
  }

  /** A rejection is observed internally and remains available to the Server supervisor. */
  get failStopCallbackCompletion(): Promise<void> | undefined {
    return this.#failStopCallbackCompletion;
  }

  createArtifactUpload(
    input: CreateArtifactUploadInput,
    signal?: AbortSignal,
  ): Promise<CreateArtifactUploadResult> {
    const startedAt = performance.now();
    const deadline = startedAt + this.#requestTimeoutMilliseconds;
    const initialError = this.#admissionError();
    if (initialError !== undefined) {
      return Promise.reject(initialError);
    }

    this.#admissionReservations += 1;
    let signalSnapshot: AbortSignal | undefined;
    try {
      signalSnapshot = snapshotAbortSignal(signal);
    } catch {
      this.#releaseAdmission();
      const reentrantError = this.#admissionError();
      if (reentrantError !== undefined) {
        return Promise.reject(reentrantError);
      }
      if (performance.now() >= deadline) {
        return Promise.reject(createCoordinatorError("ARTIFACT_CREATE_TIMEOUT"));
      }
      return Promise.reject(createCoordinatorError("ARTIFACT_CREATE_INVALID_REQUEST"));
    }
    if (signalSnapshot !== undefined && isAbortSignalAborted(signalSnapshot)) {
      this.#releaseAdmission();
      const reentrantError = this.#admissionError();
      return Promise.reject(reentrantError ?? createCoordinatorError("ARTIFACT_CREATE_CANCELLED"));
    }
    let inputSnapshot: CreateArtifactUploadInput;
    try {
      inputSnapshot = snapshotCreateInput(input);
    } catch {
      this.#releaseAdmission();
      const reentrantError = this.#admissionError();
      if (reentrantError !== undefined) {
        return Promise.reject(reentrantError);
      }
      if (performance.now() >= deadline) {
        return Promise.reject(createCoordinatorError("ARTIFACT_CREATE_TIMEOUT"));
      }
      return Promise.reject(createCoordinatorError("ARTIFACT_CREATE_INVALID_REQUEST"));
    }
    const reentrantError = this.#admissionError(true);
    if (reentrantError !== undefined) {
      this.#releaseAdmission();
      return Promise.reject(reentrantError);
    }
    if (signalSnapshot !== undefined && isAbortSignalAborted(signalSnapshot)) {
      this.#releaseAdmission();
      return Promise.reject(createCoordinatorError("ARTIFACT_CREATE_CANCELLED"));
    }
    if (performance.now() >= deadline) {
      this.#releaseAdmission();
      return Promise.reject(createCoordinatorError("ARTIFACT_CREATE_TIMEOUT"));
    }

    const deferred = Promise.withResolvers<CreateArtifactUploadResult>();
    const task: CreateTask = {
      input: inputSnapshot,
      deadline,
      signal: signalSnapshot,
      result: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer: undefined,
      abortListener: undefined,
      phase: "queued",
      settled: false,
    };
    this.#tasks.add(task);
    task.timer = setTimeout(
      () => this.#interruptTask(task, "timeout"),
      Math.max(1, Math.ceil(deadline - performance.now())),
    );
    task.timer.unref();
    if (signalSnapshot !== undefined) {
      task.abortListener = () => this.#interruptTask(task, "cancelled");
      addAbortSignalListener(signalSnapshot, task.abortListener);
    }
    const internal = this.#fifo.run(async () => {
      try {
        await this.#runTask(task);
      } catch {
        this.#enterFatal("ARTIFACT_CREATE_PROTOCOL_FAILURE");
      }
    });
    this.#track(internal);
    this.#releaseAdmission();
    if (signalSnapshot !== undefined && isAbortSignalAborted(signalSnapshot)) {
      this.#interruptTask(task, "cancelled");
    } else if (performance.now() >= deadline) {
      this.#interruptTask(task, "timeout");
    }
    return task.result;
  }

  /**
   * Stops admission immediately, drains accepted work, then closes storage, DB, and lock in order.
   */
  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      if (this.#state === "open") {
        this.#state = "closing";
      }
      const deadline = performance.now() + this.#closeTimeoutMilliseconds;
      this.#closePromise = this.#closeOwners(deadline);
    }
    return this.#closePromise;
  }

  #admissionError(holdsOwnReservation = false): ArtifactUploadCreateCoordinatorError | undefined {
    if (this.#fatalError !== undefined) {
      return this.#fatalError;
    }
    if (this.#state !== "open") {
      return createCoordinatorError("ARTIFACT_CREATE_CLOSED");
    }
    const ownReservation = holdsOwnReservation ? 1 : 0;
    if (
      this.#inFlight.size + this.#admissionReservations - ownReservation >=
      this.#maximumPendingCreates
    ) {
      return createCoordinatorError("ARTIFACT_CREATE_BUSY");
    }
    return undefined;
  }

  #releaseAdmission(): void {
    this.#admissionReservations -= 1;
    this.#notifyQuiescence();
  }

  #track(operation: Promise<void>): void {
    this.#inFlight.add(operation);
    void operation.then(
      () => {
        this.#inFlight.delete(operation);
        this.#notifyQuiescence();
      },
      () => {
        this.#inFlight.delete(operation);
        this.#notifyQuiescence();
      },
    );
  }

  async #runTask(task: CreateTask): Promise<void> {
    if (!this.#mayContinueTask(task, "queued")) {
      return;
    }
    task.phase = "probe";
    let rawProbe: ProbeArtifactUploadCreateResult;
    try {
      rawProbe = await this.#database.probeArtifactUploadCreate(task.input);
    } catch (error) {
      if (!task.settled) {
        this.#mayContinueTask(task, "probe");
      }
      this.#handleDatabaseError(task, error, "probe");
      return;
    }
    let probe: ProbeArtifactUploadCreateResult;
    try {
      probe = this.#snapshotProbe(rawProbe, task.input.totalBytes);
    } catch {
      this.#enterFatal("ARTIFACT_CREATE_PROTOCOL_FAILURE");
      return;
    }
    if (!this.#mayContinueTask(task, "probe")) {
      return;
    }
    if (probe.disposition === "exact-replay") {
      this.#resolveTask(task, probe.result);
      return;
    }

    task.phase = "capacity";
    const capacityInput = normalizeArtifactStorageOperationInput("evaluateCapacity", {
      request: { expectedTotalBytes: task.input.totalBytes },
      accounting: probe.accounting,
    });
    const capacityExpectation = createArtifactStorageResponseExpectation(
      "evaluateCapacity",
      capacityInput,
    );
    let rawAdmission: ArtifactCapacityAdmission;
    try {
      rawAdmission = await this.#storage.evaluateCapacity(capacityInput);
    } catch (error) {
      if (!task.settled) {
        this.#mayContinueTask(task, "capacity");
      }
      this.#handleStorageError(task, error);
      return;
    }
    try {
      const admission = normalizeArtifactStorageOperationOutput("evaluateCapacity", rawAdmission);
      assertArtifactStorageResponseMatchesExpectation(
        capacityExpectation,
        "evaluateCapacity",
        admission,
        this.#storageCapacity,
      );
    } catch {
      this.#enterFatal("ARTIFACT_CREATE_PROTOCOL_FAILURE");
      return;
    }
    if (!this.#mayContinueTask(task, "capacity")) {
      return;
    }

    task.phase = "create";
    let rawResult: CreateArtifactUploadResult;
    try {
      rawResult = await this.#database.createArtifactUpload(task.input);
    } catch (error) {
      if (!task.settled) {
        this.#mayContinueTask(task, "create");
      }
      this.#handleDatabaseError(task, error, "create");
      return;
    }
    if (!this.#mayContinueTask(task, "create")) {
      return;
    }
    let result: CreateArtifactUploadResult;
    try {
      result = snapshotCreateResult(rawResult);
    } catch {
      this.#enterFatal("ARTIFACT_CREATE_PROTOCOL_FAILURE");
      return;
    }
    if (!this.#mayContinueTask(task, "create")) {
      return;
    }
    this.#resolveTask(task, result);
  }

  #snapshotProbe(value: unknown, expectedTotalBytes: number): ProbeArtifactUploadCreateResult {
    const record = requireRecord(value, "Artifact upload create probe");
    const disposition = record.disposition;
    if (disposition === "exact-replay") {
      requireExactKeys(record, ["disposition", "result"]);
      const result = snapshotCreateResult(record.result);
      if (!result.replayed) {
        throw new TypeError("Exact artifact create replay must be marked replayed.");
      }
      return Object.freeze({ disposition, result });
    }
    if (disposition !== "new") {
      throw new TypeError("Artifact upload create probe disposition is invalid.");
    }
    requireExactKeys(record, ["disposition", "accounting"]);
    const capacityInput = normalizeArtifactStorageOperationInput("evaluateCapacity", {
      request: { expectedTotalBytes },
      accounting: record.accounting,
    });
    return Object.freeze({ disposition, accounting: capacityInput.accounting });
  }

  #mayContinueTask(task: CreateTask, phase: CreateTaskPhase): boolean {
    if (task.settled) {
      return false;
    }
    if (this.#fatalError !== undefined) {
      this.#rejectTask(task, this.#fatalError);
      return false;
    }
    if (task.signal !== undefined && isAbortSignalAborted(task.signal)) {
      this.#interruptTask(task, "cancelled");
      return false;
    }
    if (performance.now() >= task.deadline) {
      task.phase = phase;
      this.#interruptTask(task, "timeout");
      return false;
    }
    return true;
  }

  #interruptTask(task: CreateTask, reason: "cancelled" | "timeout"): void {
    if (task.settled) {
      return;
    }
    if (task.phase === "create") {
      this.#enterFatal("ARTIFACT_CREATE_OUTCOME_UNKNOWN");
      return;
    }
    this.#rejectTask(
      task,
      createCoordinatorError(
        reason === "cancelled" ? "ARTIFACT_CREATE_CANCELLED" : "ARTIFACT_CREATE_TIMEOUT",
      ),
    );
  }

  #handleDatabaseError(task: CreateTask, error: unknown, phase: "probe" | "create"): void {
    if (error instanceof DatabaseRequestError) {
      const code = error.code;
      if (code === "LEASE_LOST") {
        if (!task.settled) {
          this.#rejectTask(task, createCoordinatorError("ARTIFACT_CREATE_LEASE_LOST"));
        }
        return;
      }
      if (code === "ARTIFACT_UPLOAD_CONFLICT") {
        if (!task.settled) {
          this.#rejectTask(task, createCoordinatorError("ARTIFACT_CREATE_CONFLICT"));
        }
        return;
      }
      if (code === "ARTIFACT_COMPLETION_MODE_MISMATCH") {
        if (!task.settled) {
          this.#rejectTask(
            task,
            createCoordinatorError("ARTIFACT_CREATE_COMPLETION_MODE_MISMATCH"),
          );
        }
        return;
      }
      if (code === "ARTIFACT_UPLOAD_QUOTA_EXCEEDED") {
        if (!task.settled) {
          this.#rejectTask(task, createCoordinatorError("ARTIFACT_CREATE_QUOTA_EXCEEDED"));
        }
        return;
      }
      this.#enterFatal("ARTIFACT_CREATE_DATABASE_FAILURE");
      return;
    }
    this.#enterFatal(
      phase === "create" ? "ARTIFACT_CREATE_OUTCOME_UNKNOWN" : "ARTIFACT_CREATE_DATABASE_FAILURE",
    );
  }

  #handleStorageError(task: CreateTask, error: unknown): void {
    if (
      error instanceof ArtifactStorageClientError &&
      error.code === "ARTIFACT_STORAGE_CLIENT_BUSY" &&
      error.retryable
    ) {
      if (!task.settled) {
        this.#rejectTask(task, createCoordinatorError("ARTIFACT_CREATE_BUSY"));
      }
      return;
    }
    if (
      error instanceof ArtifactStorageClientError &&
      error.code === "ARTIFACT_STORAGE_CAPACITY" &&
      error.retryable
    ) {
      if (!task.settled) {
        this.#rejectTask(task, createCoordinatorError("ARTIFACT_CREATE_CAPACITY"));
      }
      return;
    }
    if (
      error instanceof ArtifactStorageClientError &&
      error.code === "ARTIFACT_STORAGE_INVALID_REQUEST"
    ) {
      this.#enterFatal("ARTIFACT_CREATE_PROTOCOL_FAILURE");
      return;
    }
    this.#enterFatal("ARTIFACT_CREATE_STORAGE_FAILURE");
  }

  #resolveTask(task: CreateTask, result: CreateArtifactUploadResult): void {
    if (!this.#settleTask(task)) {
      return;
    }
    task.resolve(result);
  }

  #rejectTask(task: CreateTask, error: ArtifactUploadCreateCoordinatorError): void {
    if (!this.#settleTask(task)) {
      return;
    }
    task.reject(error);
  }

  #settleTask(task: CreateTask): boolean {
    if (task.settled) {
      return false;
    }
    task.settled = true;
    task.phase = "done";
    if (task.timer !== undefined) {
      clearTimeout(task.timer);
      task.timer = undefined;
    }
    if (task.signal !== undefined && task.abortListener !== undefined) {
      removeAbortSignalListener(task.signal, task.abortListener);
      task.abortListener = undefined;
    }
    this.#tasks.delete(task);
    this.#notifyQuiescence();
    return true;
  }

  #enterFatal(
    code: ArtifactUploadCreateCoordinatorErrorCode,
  ): ArtifactUploadCreateCoordinatorError {
    if (this.#fatalError !== undefined) {
      return this.#fatalError;
    }
    const error = createCoordinatorError(code);
    if (!error.requiresFailStop) {
      throw new TypeError("Artifact create fatal transition requires a fatal error code.");
    }
    this.#fatalError = error;
    this.#state = "fatal";
    this.#fatalSignal.resolve(error);
    for (const task of [...this.#tasks]) {
      this.#rejectTask(task, error);
    }
    let callbackCompletion: Promise<void>;
    try {
      callbackCompletion = Promise.resolve(this.#onFailStop(error));
    } catch (callbackError) {
      callbackCompletion = Promise.reject(callbackError);
    }
    void callbackCompletion.catch(() => undefined);
    this.#failStopCallbackCompletion = callbackCompletion;
    return error;
  }

  #observeStorageOwnerExit(_exitCode: number | undefined): void {
    if (this.#storageShutdownStarted || this.#state === "closed") {
      return;
    }
    this.#enterFatal("ARTIFACT_CREATE_STORAGE_FAILURE");
  }

  async #closeOwners(deadline: number): Promise<void> {
    await this.#awaitQuiescence(deadline);
    let priorFatal = this.#fatalError;
    this.#storageShutdownStarted = true;

    try {
      await this.#awaitOwnerStage(
        () => this.#storage.close(),
        deadline,
        "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      );
    } catch (error) {
      priorFatal = this.#asCoordinatorFatal(error, "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE");
    }

    const joinDeadline = Math.min(
      deadline,
      performance.now() + this.#storageJoinTimeoutMilliseconds,
    );
    let storageExitCode: number;
    try {
      storageExitCode = await this.#awaitOwnerStage(
        () => this.#storageOwnerExit,
        joinDeadline,
        "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      );
    } catch (error) {
      throw this.#asCoordinatorFatal(error, "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE");
    }
    if (!Number.isSafeInteger(storageExitCode) || storageExitCode < 0) {
      throw this.#enterFatal("ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE");
    }
    if (storageExitCode !== 0) {
      priorFatal ??= this.#enterFatal("ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE");
    }

    try {
      await this.#awaitOwnerStage(
        () => this.#database.close(),
        deadline,
        "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      );
    } catch (error) {
      throw this.#asCoordinatorFatal(error, "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE");
    }
    try {
      await this.#awaitOwnerStage(
        () => this.#databaseOwnerLock.close(),
        deadline,
        "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      );
    } catch (error) {
      throw this.#asCoordinatorFatal(error, "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE");
    }

    if (priorFatal !== undefined) {
      throw priorFatal;
    }
    this.#state = "closed";
  }

  async #awaitQuiescence(deadline: number): Promise<void> {
    if (this.#isQuiescent()) {
      return;
    }
    const deferred = Promise.withResolvers<void>();
    const notify = (): void => deferred.resolve();
    this.#quiescenceWaiters.add(notify);
    try {
      await this.#awaitBeforeDeadline(
        deferred.promise,
        deadline,
        "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      );
    } finally {
      this.#quiescenceWaiters.delete(notify);
    }
  }

  #isQuiescent(): boolean {
    return this.#inFlight.size === 0 && this.#tasks.size === 0 && this.#admissionReservations === 0;
  }

  #notifyQuiescence(): void {
    if (!this.#isQuiescent()) {
      return;
    }
    for (const notify of [...this.#quiescenceWaiters]) {
      notify();
    }
    this.#quiescenceWaiters.clear();
  }

  async #awaitOwnerStage<T>(
    action: () => Promise<T>,
    deadline: number,
    fatalCode: ArtifactUploadCreateCoordinatorErrorCode,
  ): Promise<T> {
    let operation: Promise<T>;
    try {
      operation = action();
    } catch {
      throw this.#enterFatal(fatalCode);
    }
    try {
      return await this.#awaitBeforeDeadline(operation, deadline, fatalCode);
    } catch (error) {
      throw this.#asCoordinatorFatal(error, fatalCode);
    }
  }

  async #awaitBeforeDeadline<T>(
    operation: Promise<T>,
    deadline: number,
    fatalCode: ArtifactUploadCreateCoordinatorErrorCode,
  ): Promise<T> {
    if (performance.now() >= deadline) {
      throw this.#enterFatal(fatalCode);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              reject(this.#enterFatal(fatalCode));
            },
            Math.max(1, Math.ceil(deadline - performance.now())),
          );
          timer.unref();
        }),
      ]);
      if (performance.now() >= deadline) {
        throw this.#enterFatal(fatalCode);
      }
      return result;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  #asCoordinatorFatal(
    error: unknown,
    fallbackCode: ArtifactUploadCreateCoordinatorErrorCode,
  ): ArtifactUploadCreateCoordinatorError {
    const localFatal = this.#fatalError;
    return localFatal !== undefined && error === localFatal
      ? localFatal
      : this.#enterFatal(fallbackCode);
  }
}
