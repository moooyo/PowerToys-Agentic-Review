import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
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
const systemMonotonicNow = (): number => performance.now();

export interface ArtifactStorageClientOptions {
  readonly storage: ArtifactStorageKernelOptions;
  readonly startupTimeoutMilliseconds: number;
  readonly requestTimeoutMilliseconds: number;
  readonly shutdownTimeoutMilliseconds: number;
  readonly exitTimeoutMilliseconds: number;
}

export interface ArtifactStorageWorkerTransport {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "messageerror", listener: (error: Error) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
}

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
  readonly #worker: ArtifactStorageWorkerTransport;
  readonly #options: ArtifactStorageClientSnapshot;
  readonly #now: () => number;
  readonly #startupDeadline: number;
  readonly #ready = Promise.withResolvers<void>();
  readonly #exited = Promise.withResolvers<number>();
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

  private constructor(
    options: ArtifactStorageClientSnapshot,
    worker: ArtifactStorageWorkerTransport,
    startupDeadline: number,
    now: () => number,
  ) {
    this.#options = options;
    this.#worker = worker;
    this.#now = now;
    this.#startupDeadline = startupDeadline;
    worker.on("message", (message) => this.#handleMessage(message));
    worker.on("messageerror", () => {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage Worker emitted an unreadable message.",
      );
    });
    worker.on("error", () => {
      this.#enterTerminal("ARTIFACT_STORAGE_CLIENT_TERMINAL", "Artifact storage Worker failed.");
    });
    worker.on("exit", (exitCode) => this.#handleExit(exitCode));

    this.#startupTimer = setTimeout(
      () => {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage Worker startup timed out.",
        );
      },
      remainingMilliseconds(startupDeadline, this.#now()),
    );
    this.#startupTimer.unref();
    if (this.#now() >= startupDeadline) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage Worker startup timed out.",
      );
    }
  }

  static async create(options: ArtifactStorageClientOptions): Promise<ArtifactStorageClient> {
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
        "Artifact storage Worker startup timed out during timeout validation.",
      );
    }
    let snapshot: ArtifactStorageClientSnapshot;
    try {
      snapshot = snapshotClientOptions(options, startupTimeoutMilliseconds);
    } catch {
      if (systemMonotonicNow() >= startupDeadline) {
        throw new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage Worker startup timed out during configuration validation.",
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
        "Artifact storage Worker startup timed out before owner creation.",
      );
    }
    const workerUrl = import.meta.url.endsWith(".ts")
      ? new URL("./artifact-storage-worker.ts", import.meta.url)
      : new URL("./artifact-storage-worker.js", import.meta.url);
    let worker: ArtifactStorageWorkerTransport;
    try {
      worker = new Worker(workerUrl, {
        workerData: {
          protocolVersion: artifactStorageProtocolVersion,
          storage: snapshot.storage,
        },
      }) as ArtifactStorageWorkerTransport;
    } catch {
      if (systemMonotonicNow() >= startupDeadline) {
        throw new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage Worker startup timed out during owner creation.",
        );
      }
      throw new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_CLIENT_TERMINAL",
        "Artifact storage Worker could not be started.",
      );
    }
    return ArtifactStorageClient.#attach(snapshot, worker, startupDeadline);
  }

  /** @internal Accessible only through the deep-module test helper below. */
  static async [testTransportAttachment](
    options: ArtifactStorageClientOptions,
    worker: ArtifactStorageWorkerTransport,
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
      worker,
      startedAt + startupTimeoutMilliseconds,
      initialRequestId,
      now,
    );
  }

  static async #attach(
    options: ArtifactStorageClientSnapshot,
    worker: ArtifactStorageWorkerTransport,
    startupDeadline: number,
    initialRequestId = 1,
    now: () => number = systemMonotonicNow,
  ): Promise<ArtifactStorageClient> {
    const client = new ArtifactStorageClient(options, worker, startupDeadline, now);
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
    return this.#request("writePreparedChunk", input);
  }

  finalizeArtifact(input: PreparedArtifactFinalization): Promise<PublishedArtifactObject> {
    return this.#request("finalizeArtifact", input);
  }

  async readObject(input: ArtifactObjectReadInput): Promise<Buffer> {
    const output = await this.#request("readObject", input);
    return Buffer.from(output.bytes);
  }

  cleanupUpload(input: ArtifactUploadCleanupRequest): Promise<ArtifactUploadCleanupResult> {
    return this.#request("cleanupUpload", input);
  }

  evaluateCapacity(input: ArtifactCapacityEvaluationInput): Promise<ArtifactCapacityAdmission> {
    return this.#request("evaluateCapacity", input);
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      const deadline = this.#now() + this.#options.shutdownTimeoutMilliseconds;
      this.#shutdownDeadline = deadline;
      this.#closePromise = this.#closeInternal(deadline);
    }
    return this.#closePromise;
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
                "Artifact storage Worker exit join timed out.",
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
    try {
      this.#worker.postMessage({
        type: "request",
        protocolVersion: artifactStorageProtocolVersion,
        id,
        operation,
        input: normalizedInput,
      });
    } catch {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TERMINAL",
        "Artifact storage request could not be sent.",
      );
    }
    if (this.#now() >= deadline && this.#pending.has(id)) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage request timed out while being sent.",
      );
    }
    return response as Promise<ArtifactStorageWorkerOperationMap[TOperation]["output"]>;
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
        "Artifact storage Worker shutdown timed out after acknowledgement.",
      );
    }
    const exitCode = await this.#waitForExit(deadline);
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
    if (
      exitCode === 0 &&
      (!this.#shutdownAcknowledged || this.#pending.size !== 0 || this.#admissionReservations !== 0)
    ) {
      throw this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage Worker did not drain accepted work before shutdown.",
        false,
        false,
      );
    }
    if (exitCode !== 0) {
      throw this.#enterTerminal(
        "ARTIFACT_STORAGE_WORKER_EXIT",
        "Artifact storage Worker did not complete graceful shutdown.",
        false,
      );
    }
    this.#state = "closed";
  }

  async #waitForExit(deadline: number): Promise<number> {
    if (this.#now() >= deadline) {
      throw this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
        "Artifact storage Worker shutdown timed out before exit.",
      );
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#exited.promise,
        this.#terminalSignal.promise.then((error): never => {
          throw error;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              const error = this.#enterTerminal(
                "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
                "Artifact storage Worker shutdown timed out.",
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
        "Artifact storage Worker violated its message protocol.",
      );
      return;
    }

    if (message.type === "ready") {
      if (this.#state !== "starting") {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
          "Artifact storage Worker sent an unexpected ready message.",
        );
        return;
      }
      if (this.#now() >= this.#startupDeadline) {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
          "Artifact storage Worker startup timed out.",
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
        "Artifact storage Worker responded before becoming ready.",
      );
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined || pending.operation !== message.operation) {
      this.#enterTerminal(
        "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
        "Artifact storage Worker returned an unknown response correlation.",
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
          "Artifact storage Worker returned a fatal error as a normal response.",
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
        "Artifact storage Worker acknowledged shutdown before all accepted work completed.",
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
        "Artifact storage Worker returned a result that does not match its request.",
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

  #handleExit(exitCode: number): void {
    this.#exited.resolve(exitCode);
    if (this.#state === "terminal" || this.#state === "closed") {
      return;
    }
    if (this.#state === "closing" && exitCode === 0) {
      if (
        !this.#shutdownAcknowledged ||
        this.#pending.size !== 0 ||
        this.#admissionReservations !== 0
      ) {
        this.#enterTerminal(
          "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
          "Artifact storage Worker exited before completing its shutdown protocol.",
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
        "Artifact storage Worker exited after its shutdown deadline.",
        false,
        false,
      );
      return;
    }
    this.#enterTerminal(
      "ARTIFACT_STORAGE_WORKER_EXIT",
      "Artifact storage Worker exited without a graceful shutdown acknowledgement.",
      false,
      false,
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
    terminate = true,
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
    if (terminate) {
      this.#attemptTerminate();
    }
    return error;
  }

  #attemptTerminate(): void {
    this.#terminationPromise ??= (async () => {
      try {
        await this.#worker.terminate();
      } catch {
        // joinExit() provides the bounded, canonical result when termination itself fails.
      }
    })();
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
  worker: ArtifactStorageWorkerTransport,
  initialRequestId = 1,
  now: () => number = systemMonotonicNow,
): Promise<ArtifactStorageClient> =>
  ArtifactStorageClient[testTransportAttachment](options, worker, initialRequestId, now);
