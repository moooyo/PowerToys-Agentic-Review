import { type SpawnOptions, spawn } from "node:child_process";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type {
  ArtifactNamespaceCleanupResult,
  ArtifactNamespaceObservation,
  ArtifactNamespaceScanPageInput,
  ArtifactNamespaceScanPageResult,
  CloseArtifactNamespaceScanInput,
  CloseArtifactNamespaceScanResult,
} from "./artifact-namespace-contract.js";
import {
  type ArtifactTransactionStorageHandle,
  registerArtifactTransactionStorageHandle,
  revokeArtifactTransactionStorageHandle,
} from "./artifact-transaction-coordinator.js";
import { ArtifactStorageClientError, type ArtifactStorageClientErrorCode } from "./errors.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactCapacityEvaluationInput,
  ArtifactStorageKernelOptions,
  ArtifactUploadCleanupRequest,
  ArtifactUploadCleanupResult,
  DurableArtifactChunk,
  PreparedArtifactChunk,
  PreparedArtifactFinalization,
  PublishedArtifactObject,
} from "./types.js";
import {
  type ArtifactObjectReadInput,
  type ArtifactStorageResponseExpectation,
  type ArtifactStorageWorkerMessage,
  type ArtifactStorageWorkerOperation,
  type ArtifactStorageWorkerOperationMap,
  artifactStorageProcessEntryArgument,
  artifactStorageProtocolVersion,
  assertArtifactStorageResponseMatchesExpectation,
  createArtifactStorageResponseExpectation,
  isFatalArtifactStorageOperationError,
  maximumArtifactStorageRequestId,
  normalizeArtifactStorageOperationInput,
  normalizeArtifactStorageWorkerData,
  parseArtifactStorageWorkerMessage,
} from "./worker-protocol.js";

const maximumPendingOperations = 15;
const maximumClientTimeoutMilliseconds = 600_000;
const testTransportAttachment = Symbol("artifact-storage-test-transport-attachment");
const testSpawnerAttachment = Symbol("artifact-storage-test-spawner-attachment");
const systemMonotonicNow = (): number => performance.now();

const defaultProcessSpawner: ArtifactStorageProcessSpawner = (executable, args, options) =>
  spawn(executable, [...args], options) as unknown as ArtifactStorageProcessTransport;

const artifactStorageProcessEntryPath = (): string =>
  fileURLToPath(
    import.meta.url.endsWith(".ts")
      ? new URL("./artifact-storage-process.ts", import.meta.url)
      : new URL("./artifact-storage-process.js", import.meta.url),
  );

const createArtifactStorageProcess = (
  spawner: ArtifactStorageProcessSpawner,
): ArtifactStorageProcessTransport => {
  const environment = Object.freeze(Object.create(null)) as NodeJS.ProcessEnv;
  const entryPath = artifactStorageProcessEntryPath();
  return spawner(
    process.execPath,
    Object.freeze([entryPath, artifactStorageProcessEntryArgument]),
    {
      cwd: dirname(entryPath),
      shell: false,
      detached: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      env: environment,
    },
  );
};

export interface ArtifactStorageClientOptions {
  readonly storage: ArtifactStorageKernelOptions;
  readonly startupTimeoutMilliseconds: number;
  readonly requestTimeoutMilliseconds: number;
  readonly shutdownTimeoutMilliseconds: number;
  readonly exitTimeoutMilliseconds: number;
}

export interface ArtifactStorageProcessTransport {
  send(value: unknown, callback: (error: Error | null) => void): boolean;
  kill(signal: "SIGKILL"): boolean;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "exit" | "close",
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "disconnect", listener: () => void): this;
}

type ArtifactStorageProcessSpawner = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ArtifactStorageProcessTransport;

interface PendingRequest {
  readonly operation: ArtifactStorageWorkerOperation;
  readonly expectation: ArtifactStorageResponseExpectation;
  readonly deadline: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ArtifactStorageClientSnapshot {
  readonly storage: ArtifactStorageKernelOptions;
  readonly startupTimeoutMilliseconds: number;
  readonly requestTimeoutMilliseconds: number;
  readonly shutdownTimeoutMilliseconds: number;
  readonly exitTimeoutMilliseconds: number;
}

const requireTimeout = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumClientTimeoutMilliseconds) {
    throw new TypeError(`${name} must be a positive bounded integer.`);
  }
  return value;
};

const snapshotClientOptions = (
  options: ArtifactStorageClientOptions,
  startupTimeoutMilliseconds: number,
): ArtifactStorageClientSnapshot => {
  const data = normalizeArtifactStorageWorkerData({
    protocolVersion: artifactStorageProtocolVersion,
    storage: options.storage,
  });
  return Object.freeze({
    storage: data.storage,
    startupTimeoutMilliseconds,
    requestTimeoutMilliseconds: requireTimeout(
      options.requestTimeoutMilliseconds,
      "Artifact storage request timeout",
    ),
    shutdownTimeoutMilliseconds: requireTimeout(
      options.shutdownTimeoutMilliseconds,
      "Artifact storage shutdown timeout",
    ),
    exitTimeoutMilliseconds: requireTimeout(
      options.exitTimeoutMilliseconds,
      "Artifact storage exit timeout",
    ),
  });
};

const remainingMilliseconds = (deadline: number, now: number): number =>
  Math.max(1, Math.ceil(deadline - now));

export class ArtifactStorageClient {
  readonly #owner: ArtifactStorageProcessTransport;
  readonly #options: ArtifactStorageClientSnapshot;
  readonly #now: () => number;
  readonly #startupDeadline: number;
  readonly #ready = Promise.withResolvers<void>();
  readonly #exited = Promise.withResolvers<number>();
  readonly #closed = Promise.withResolvers<number>();
  readonly #terminalSignal = Promise.withResolvers<ArtifactStorageClientError>();
  readonly #pending = new Map<number, PendingRequest>();
  // Caller getters can reenter while an input is normalized, so those slots count toward the cap.
  #admissionReservations = 0;
  #startupTimer: NodeJS.Timeout | undefined;
  #nextRequestId = 1;
  #state: "starting" | "open" | "closing" | "closed" | "terminal" = "starting";
  #terminalError: ArtifactStorageClientError | undefined;
  #shutdownAcknowledged = false;
  #shutdownDeadline: number | undefined;
  #closePromise: Promise<void> | undefined;
  #terminationPromise: Promise<void> | undefined;
  #ownerExitObserved = false;
  #ownerCloseObserved = false;
  #ownerExitCode: number | undefined;
  #killAttempted = false;
  #artifactTransactionHandleIssued = false;
  #artifactTransactionHandle: ArtifactTransactionStorageHandle | undefined;

  private constructor(
    options: ArtifactStorageClientSnapshot,
    owner: ArtifactStorageProcessTransport,
    startupDeadline: number,
    now: () => number,
  ) {
    this.#options = options;
    this.#owner = owner;
    this.#now = now;
    this.#startupDeadline = startupDeadline;
    owner.on("message", (message) => this.#handleMessage(message));
    owner.on("error", () => {
      this.#enterTerminal("ARTIFACT_STORAGE_CLIENT_TERMINAL", "Artifact storage owner failed.");
    });
    owner.on("exit", (exitCode, signal) => this.#handleOwnerExit(exitCode, signal, false));
    owner.on("close", (exitCode, signal) => this.#handleOwnerExit(exitCode, signal, true));
    owner.on("disconnect", () => this.#handleDisconnect());

    this.#startupTimer = setTimeout(
      () => {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage owner startup timed out.",
        );
      },
      remainingMilliseconds(startupDeadline, this.#now()),
    );
    this.#startupTimer.unref();
    if (this.#now() >= startupDeadline) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage owner startup timed out.",
      );
    }
    this.#sendMessage({
      type: "initialize",
      protocolVersion: artifactStorageProtocolVersion,
      storage: this.#options.storage,
    });
  }

  static async create(options: ArtifactStorageClientOptions): Promise<ArtifactStorageClient> {
    return ArtifactStorageClient.#createWithSpawner(options, defaultProcessSpawner);
  }

  static async #createWithSpawner(
    options: ArtifactStorageClientOptions,
    spawner: ArtifactStorageProcessSpawner,
  ): Promise<ArtifactStorageClient> {
    const startedAt = systemMonotonicNow();
    let startupTimeoutMilliseconds: number;
    try {
      startupTimeoutMilliseconds = requireTimeout(
        options.startupTimeoutMilliseconds,
        "Artifact storage startup timeout",
      );
    } catch {
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_INVALID_REQUEST",
        "Artifact storage client configuration is invalid.",
      );
    }
    const startupDeadline = startedAt + startupTimeoutMilliseconds;
    if (systemMonotonicNow() >= startupDeadline) {
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage owner startup timed out during timeout validation.",
      );
    }
    let snapshot: ArtifactStorageClientSnapshot;
    try {
      snapshot = snapshotClientOptions(options, startupTimeoutMilliseconds);
    } catch {
      if (systemMonotonicNow() >= startupDeadline) {
        throw new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage owner startup timed out during configuration validation.",
        );
      }
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_INVALID_REQUEST",
        "Artifact storage client configuration is invalid.",
      );
    }
    if (systemMonotonicNow() >= startupDeadline) {
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage owner startup timed out before owner creation.",
      );
    }
    let owner: ArtifactStorageProcessTransport;
    try {
      owner = createArtifactStorageProcess(spawner);
    } catch {
      if (systemMonotonicNow() >= startupDeadline) {
        throw new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage owner startup timed out during process creation.",
        );
      }
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_CLIENT_TERMINAL",
        "Artifact storage owner process could not be started.",
      );
    }
    return ArtifactStorageClient.#attach(snapshot, owner, startupDeadline);
  }

  /** @internal Accessible only through the deep-module test helper below. */
  static async [testSpawnerAttachment](
    options: ArtifactStorageClientOptions,
    spawner: ArtifactStorageProcessSpawner,
  ): Promise<ArtifactStorageClient> {
    return ArtifactStorageClient.#createWithSpawner(options, spawner);
  }

  /** @internal Accessible only through the deep-module test helper below. */
  static async [testTransportAttachment](
    options: ArtifactStorageClientOptions,
    owner: ArtifactStorageProcessTransport,
    initialRequestId: number,
    now: () => number,
  ): Promise<ArtifactStorageClient> {
    const startedAt = now();
    const startupTimeoutMilliseconds = requireTimeout(
      options.startupTimeoutMilliseconds,
      "Artifact storage startup timeout",
    );
    const snapshot = snapshotClientOptions(options, startupTimeoutMilliseconds);
    return ArtifactStorageClient.#attach(
      snapshot,
      owner,
      startedAt + startupTimeoutMilliseconds,
      initialRequestId,
      now,
    );
  }

  static async #attach(
    options: ArtifactStorageClientSnapshot,
    owner: ArtifactStorageProcessTransport,
    startupDeadline: number,
    initialRequestId = 1,
    now: () => number = systemMonotonicNow,
  ): Promise<ArtifactStorageClient> {
    const client = new ArtifactStorageClient(options, owner, startupDeadline, now);
    if (
      !Number.isSafeInteger(initialRequestId) ||
      initialRequestId < 1 ||
      initialRequestId > maximumArtifactStorageRequestId
    ) {
      client.#enterTerminal(
        "ARTIFACT_STORAGE_INVALID_REQUEST",
        "Artifact storage initial request ID is invalid.",
      );
    } else {
      client.#nextRequestId = initialRequestId;
    }
    await client.#ready.promise;
    return client;
  }

  get ownerExit(): Promise<number> {
    return this.#exited.promise;
  }

  get terminationAttempt(): Promise<void> | undefined {
    return this.#terminationPromise;
  }

  writePreparedChunk(input: PreparedArtifactChunk): Promise<DurableArtifactChunk> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined) return Promise.reject(adopted);
    return this.#request("writePreparedChunk", input);
  }

  finalizeArtifact(input: PreparedArtifactFinalization): Promise<PublishedArtifactObject> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined) return Promise.reject(adopted);
    return this.#request("finalizeArtifact", input);
  }

  async readObject(input: ArtifactObjectReadInput): Promise<Buffer> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined) throw adopted;
    const output = await this.#request("readObject", input);
    return Buffer.from(output.bytes);
  }

  cleanupUpload(input: ArtifactUploadCleanupRequest): Promise<ArtifactUploadCleanupResult> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined) return Promise.reject(adopted);
    return this.#request("cleanupUpload", input);
  }

  scanNamespacePage(
    input: ArtifactNamespaceScanPageInput,
  ): Promise<ArtifactNamespaceScanPageResult> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined) return Promise.reject(adopted);
    return this.#request("scanNamespacePage", input);
  }

  closeNamespaceScan(
    input: CloseArtifactNamespaceScanInput,
  ): Promise<CloseArtifactNamespaceScanResult> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined) return Promise.reject(adopted);
    return this.#request("closeNamespaceScan", input);
  }

  cleanupNamespaceEntry(
    input: ArtifactNamespaceObservation,
  ): Promise<ArtifactNamespaceCleanupResult> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined) return Promise.reject(adopted);
    return this.#request("cleanupNamespaceEntry", input);
  }

  evaluateCapacity(input: ArtifactCapacityEvaluationInput): Promise<ArtifactCapacityAdmission> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined) return Promise.reject(adopted);
    return this.#request("evaluateCapacity", input);
  }

  /** Transfers every mutation and shutdown capability to one ArtifactTransactionCoordinator. */
  createArtifactTransactionStorageHandle(): ArtifactTransactionStorageHandle {
    if (this.#artifactTransactionHandleIssued) {
      throw new Error("Artifact storage transaction handle was already issued.");
    }
    const admissionError = this.#requestAdmissionError("evaluateCapacity", false);
    if (admissionError !== undefined) throw admissionError;
    if (this.#pending.size !== 0 || this.#admissionReservations !== 0) {
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_CLIENT_BUSY",
        "Artifact storage cannot transfer authority while operations are pending.",
        true,
      );
    }
    const handle = registerArtifactTransactionStorageHandle(this, {
      ownerExit: this.#exited.promise,
      terminalFailure: this.#terminalSignal.promise,
      writePreparedChunk: (input) => this.#request("writePreparedChunk", input),
      finalizeArtifact: (input) => this.#request("finalizeArtifact", input),
      readObject: async (input) => {
        const output = await this.#request("readObject", input);
        return Buffer.from(output.bytes);
      },
      cleanupUpload: (input) => this.#request("cleanupUpload", input),
      scanNamespacePage: (input) => this.#request("scanNamespacePage", input),
      closeNamespaceScan: (input) => this.#request("closeNamespaceScan", input),
      cleanupNamespaceEntry: (input) => this.#request("cleanupNamespaceEntry", input),
      evaluateCapacity: (input) => this.#request("evaluateCapacity", input),
      close: () => this.#startClose(),
    });
    this.#artifactTransactionHandleIssued = true;
    this.#artifactTransactionHandle = handle;
    return handle;
  }

  close(): Promise<void> {
    const adopted = this.#adoptedOperationError();
    if (adopted !== undefined && this.#closePromise === undefined) {
      const handle = this.#artifactTransactionHandle;
      if (handle === undefined || !revokeArtifactTransactionStorageHandle(handle)) {
        return Promise.reject(adopted);
      }
      this.#artifactTransactionHandle = undefined;
    }
    return this.#startClose();
  }

  #startClose(): Promise<void> {
    if (this.#closePromise === undefined) {
      const deadline = this.#now() + this.#options.shutdownTimeoutMilliseconds;
      this.#shutdownDeadline = deadline;
      this.#closePromise = this.#closeInternal(deadline);
    }
    return this.#closePromise;
  }

  #adoptedOperationError(): ArtifactStorageClientError | undefined {
    return this.#artifactTransactionHandleIssued
      ? new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_AUTHORITY_REQUIRED",
          "Artifact storage operations require transaction coordinator authority.",
        )
      : undefined;
  }

  async joinExit(timeoutMilliseconds = this.#options.exitTimeoutMilliseconds): Promise<number> {
    let timeout: number;
    try {
      timeout = requireTimeout(timeoutMilliseconds, "Artifact storage exit join timeout");
    } catch {
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_INVALID_REQUEST",
        "Artifact storage exit join timeout is invalid.",
      );
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#exited.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new ArtifactStorageClientError(
                "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
                "Artifact storage owner exit join timed out.",
                false,
                this.#exited.promise,
              ),
            );
          }, timeout);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  #request<TOperation extends Exclude<ArtifactStorageWorkerOperation, "shutdown">>(
    operation: TOperation,
    input: ArtifactStorageWorkerOperationMap[TOperation]["input"],
  ): Promise<ArtifactStorageWorkerOperationMap[TOperation]["output"]> {
    return this.#send(
      operation,
      input,
      this.#now() + this.#options.requestTimeoutMilliseconds,
      false,
    );
  }

  #send<TOperation extends ArtifactStorageWorkerOperation>(
    operation: TOperation,
    input: ArtifactStorageWorkerOperationMap[TOperation]["input"],
    deadline: number,
    allowClosing: boolean,
  ): Promise<ArtifactStorageWorkerOperationMap[TOperation]["output"]> {
    const initialAdmissionError = this.#requestAdmissionError(operation, allowClosing);
    if (initialAdmissionError !== undefined) {
      return Promise.reject(initialAdmissionError);
    }

    const reservesAdmission = !allowClosing;
    if (reservesAdmission) {
      this.#admissionReservations += 1;
    }
    const releaseAdmission = (): void => {
      if (reservesAdmission) {
        this.#admissionReservations -= 1;
      }
    };
    let normalizedInput: ArtifactStorageWorkerOperationMap[TOperation]["input"];
    let expectation: ArtifactStorageResponseExpectation;
    try {
      normalizedInput = normalizeArtifactStorageOperationInput(operation, input);
      expectation = createArtifactStorageResponseExpectation(operation, normalizedInput);
    } catch {
      releaseAdmission();
      const reentrantAdmissionError = this.#requestAdmissionError(operation, allowClosing);
      if (reentrantAdmissionError !== undefined) {
        return Promise.reject(reentrantAdmissionError);
      }
      if (this.#now() >= deadline) {
        const error = this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage request timed out during validation.",
        );
        return Promise.reject(error);
      }
      return Promise.reject(
        new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_INVALID_REQUEST",
          "Artifact storage request is invalid.",
        ),
      );
    }
    releaseAdmission();
    const reentrantAdmissionError = this.#requestAdmissionError(operation, allowClosing);
    if (reentrantAdmissionError !== undefined) {
      return Promise.reject(reentrantAdmissionError);
    }
    if (this.#now() >= deadline) {
      const error = this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage request timed out during validation.",
      );
      return Promise.reject(error);
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (this.#pending.has(id)) {
            this.#enterTerminal(
              "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
              "Artifact storage request timed out.",
            );
          }
        },
        remainingMilliseconds(deadline, this.#now()),
      );
      timer.unref();
      this.#pending.set(id, { operation, expectation, deadline, resolve, reject, timer });
    });
    if (this.#now() >= deadline) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage request timed out before it could be sent.",
      );
      return response as Promise<ArtifactStorageWorkerOperationMap[TOperation]["output"]>;
    }
    this.#sendMessage({
      type: "request",
      protocolVersion: artifactStorageProtocolVersion,
      id,
      operation,
      input: normalizedInput,
    });
    if (this.#now() >= deadline && this.#pending.has(id)) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage request timed out while being sent.",
      );
    }
    return response as Promise<ArtifactStorageWorkerOperationMap[TOperation]["output"]>;
  }

  #sendMessage(value: unknown): void {
    if (this.#state === "terminal" || this.#state === "closed") {
      return;
    }
    try {
      this.#owner.send(value, (error) => {
        if (error !== null && !this.#ownerExitObserved && this.#state !== "closed") {
          this.#enterTerminal(
            "ARTIFACT_STORAGE_CLIENT_TERMINAL",
            "Artifact storage IPC message could not be sent.",
          );
        }
      });
    } catch {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TERMINAL",
        "Artifact storage IPC message could not be sent.",
      );
    }
  }

  #requestAdmissionError(
    operation: ArtifactStorageWorkerOperation,
    allowClosing: boolean,
  ): ArtifactStorageClientError | undefined {
    if (this.#terminalError !== undefined) {
      return this.#terminalError;
    }
    if (this.#state !== "open" && !(allowClosing && this.#state === "closing")) {
      return new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_CLOSED",
        "Artifact storage client is not accepting requests.",
        false,
        this.#exited.promise,
      );
    }
    if (
      !allowClosing &&
      this.#pending.size + this.#admissionReservations >= maximumPendingOperations
    ) {
      return new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_CLIENT_BUSY",
        "Artifact storage client request capacity is exhausted.",
        true,
      );
    }
    if (operation !== "shutdown" && this.#nextRequestId >= maximumArtifactStorageRequestId) {
      return new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_REQUEST_ID_EXHAUSTED",
        "Artifact storage request ID capacity is exhausted; close the owner.",
        false,
        this.#exited.promise,
      );
    }
    if (this.#nextRequestId > maximumArtifactStorageRequestId) {
      return this.#enterTerminal(
        "ARTIFACT_STORAGE_REQUEST_ID_EXHAUSTED",
        "Artifact storage request ID capacity is exhausted.",
      );
    }
    return undefined;
  }

  async #closeInternal(deadline: number): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
    if (this.#state !== "open") {
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_CLOSED",
        "Artifact storage client cannot close from its current state.",
        false,
        this.#exited.promise,
      );
    }

    this.#state = "closing";
    await this.#send("shutdown", {}, deadline, true);
    if (this.#now() >= deadline) {
      throw this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage owner shutdown timed out after acknowledgement.",
      );
    }
    const exitCode = await this.#waitForOwnerClose(deadline);
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
    if (
      exitCode === 0 &&
      (!this.#shutdownAcknowledged || this.#pending.size !== 0 || this.#admissionReservations !== 0)
    ) {
      throw this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage owner did not drain accepted work before shutdown.",
        false,
        false,
      );
    }
    if (exitCode !== 0) {
      throw this.#enterTerminal(
        "ARTIFACT_STORAGE_WORKER_EXIT",
        "Artifact storage owner did not complete graceful shutdown.",
        false,
      );
    }
    this.#state = "closed";
  }

  async #waitForOwnerClose(deadline: number): Promise<number> {
    if (this.#now() >= deadline) {
      throw this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage owner shutdown timed out before exit.",
      );
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#closed.promise,
        this.#terminalSignal.promise.then((error): never => {
          throw error;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              const error = this.#enterTerminal(
                "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
                "Artifact storage owner shutdown timed out.",
              );
              reject(error);
            },
            remainingMilliseconds(deadline, this.#now()),
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  #handleMessage(untrustedMessage: unknown): void {
    if (this.#state === "terminal" || this.#state === "closed") {
      return;
    }
    let message: ArtifactStorageWorkerMessage;
    try {
      message = parseArtifactStorageWorkerMessage(untrustedMessage);
    } catch {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage owner violated its message protocol.",
      );
      return;
    }

    if (message.type === "ready") {
      if (this.#state !== "starting") {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
          "Artifact storage owner sent an unexpected ready message.",
        );
        return;
      }
      if (this.#now() >= this.#startupDeadline) {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage owner startup timed out.",
        );
        return;
      }
      this.#state = "open";
      this.#clearStartupTimer();
      this.#ready.resolve();
      return;
    }
    if (message.type === "fatal") {
      this.#enterTerminal(
        message.error.code as ArtifactStorageClientErrorCode,
        message.error.message,
        message.error.retryable,
      );
      return;
    }
    if (this.#state === "starting") {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage owner responded before becoming ready.",
      );
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined || pending.operation !== message.operation) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage owner returned an unknown response correlation.",
      );
      return;
    }
    if (this.#now() >= pending.deadline) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage request response arrived after its deadline.",
      );
      return;
    }
    if (!message.ok) {
      if (isFatalArtifactStorageOperationError(message.operation, message.error)) {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
          "Artifact storage owner returned a fatal error as a normal response.",
        );
        return;
      }
      this.#removePending(message.id, pending);
      pending.reject(
        new ArtifactStorageClientError(
          message.error.code as ArtifactStorageClientErrorCode,
          message.error.message,
          message.error.retryable,
        ),
      );
      return;
    }
    if (
      message.operation === "shutdown" &&
      (this.#pending.size !== 1 || this.#admissionReservations !== 0)
    ) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage owner acknowledged shutdown before all accepted work completed.",
      );
      return;
    }
    try {
      assertArtifactStorageResponseMatchesExpectation(
        pending.expectation,
        message.operation,
        message.output,
        this.#options.storage.capacity,
      );
    } catch {
      if (this.#now() >= pending.deadline) {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage response validation exceeded its deadline.",
        );
        return;
      }
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage owner returned a result that does not match its request.",
      );
      return;
    }
    if (this.#now() >= pending.deadline) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage response validation exceeded its deadline.",
      );
      return;
    }
    this.#removePending(message.id, pending);
    if (message.operation === "shutdown") {
      this.#shutdownAcknowledged = true;
    }
    pending.resolve(message.output);
  }

  #handleOwnerExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    channelClosed: boolean,
  ): void {
    const normalizedExitCode =
      signal === null && exitCode !== null && Number.isSafeInteger(exitCode) && exitCode >= 0
        ? exitCode
        : 1;
    if (!this.#ownerExitObserved) {
      this.#ownerExitObserved = true;
      this.#ownerExitCode = normalizedExitCode;
      this.#exited.resolve(normalizedExitCode);
    }
    if (!channelClosed) {
      return;
    }
    if (this.#ownerCloseObserved) {
      return;
    }
    this.#ownerCloseObserved = true;
    this.#closed.resolve(normalizedExitCode);
    if (this.#state === "terminal" || this.#state === "closed") {
      return;
    }
    if (this.#ownerExitCode !== normalizedExitCode) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage owner reported inconsistent exit status.",
        false,
        false,
      );
      return;
    }
    if (this.#state === "closing" && normalizedExitCode === 0) {
      if (
        !this.#shutdownAcknowledged ||
        this.#pending.size !== 0 ||
        this.#admissionReservations !== 0
      ) {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
          "Artifact storage owner exited before completing its shutdown protocol.",
          false,
          false,
        );
        return;
      }
      if (this.#shutdownDeadline !== undefined && this.#now() < this.#shutdownDeadline) {
        this.#state = "closed";
        return;
      }
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage owner exited after its shutdown deadline.",
        false,
        false,
      );
      return;
    }
    this.#enterTerminal(
      "ARTIFACT_STORAGE_WORKER_EXIT",
      "Artifact storage owner exited without a graceful shutdown acknowledgement.",
      false,
      false,
    );
  }

  #handleDisconnect(): void {
    if (
      this.#ownerExitObserved ||
      this.#state === "terminal" ||
      this.#state === "closed" ||
      this.#state === "closing"
    ) {
      return;
    }
    this.#enterTerminal(
      "ARTIFACT_STORAGE_CLIENT_TERMINAL",
      "Artifact storage owner IPC disconnected before shutdown completed.",
    );
  }

  #removePending(id: number, pending: PendingRequest): void {
    if (this.#pending.get(id) === pending) {
      this.#pending.delete(id);
    }
    clearTimeout(pending.timer);
  }

  #enterTerminal(
    code: ArtifactStorageClientErrorCode,
    message: string,
    retryable = false,
    kill = true,
  ): ArtifactStorageClientError {
    if (this.#terminalError !== undefined) {
      return this.#terminalError;
    }
    const error = new ArtifactStorageClientError(code, message, retryable, this.#exited.promise);
    this.#terminalError = error;
    this.#state = "terminal";
    this.#terminalSignal.resolve(error);
    this.#clearStartupTimer();
    this.#ready.reject(error);
    for (const [id, pending] of this.#pending) {
      this.#removePending(id, pending);
      pending.reject(error);
    }
    if (kill) {
      this.#attemptTerminate();
    }
    return error;
  }

  #attemptTerminate(): void {
    if (this.#killAttempted || this.#ownerExitObserved) {
      return;
    }
    this.#killAttempted = true;
    this.#terminationPromise = new Promise<void>((resolve) => {
      try {
        this.#owner.kill("SIGKILL");
      } catch {
        // joinExit() provides the bounded, canonical result when termination itself fails.
      } finally {
        resolve();
      }
    });
  }

  #clearStartupTimer(): void {
    if (this.#startupTimer !== undefined) {
      clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
    }
  }
}

/** @internal Test-only helper; intentionally absent from the public artifact barrel. */
export const attachArtifactStorageClientForTest = (
  options: ArtifactStorageClientOptions,
  owner: ArtifactStorageProcessTransport,
  initialRequestId = 1,
  now: () => number = systemMonotonicNow,
): Promise<ArtifactStorageClient> =>
  ArtifactStorageClient[testTransportAttachment](options, owner, initialRequestId, now);

/** @internal Test-only helper; intentionally absent from the public artifact barrel. */
export const createArtifactStorageClientWithSpawnerForTest = (
  options: ArtifactStorageClientOptions,
  spawner: ArtifactStorageProcessSpawner,
): Promise<ArtifactStorageClient> => ArtifactStorageClient[testSpawnerAttachment](options, spawner);
