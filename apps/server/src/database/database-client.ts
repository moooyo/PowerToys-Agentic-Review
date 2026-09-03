import { Worker } from "node:worker_threads";
import {
  type ArtifactTransactionDatabaseHandle,
  type ArtifactTransactionDatabaseOperation,
  isArtifactTransactionDatabaseOperation,
  registerArtifactTransactionDatabaseHandle,
  revokeArtifactTransactionDatabaseHandle,
} from "../artifacts/artifact-transaction-coordinator.js";
import {
  isServerBindingPersistenceDatabaseOperation,
  registerServerBindingPersistenceDatabaseHandle,
  revokeServerBindingPersistenceDatabaseHandle,
  type ServerBindingPersistenceDatabaseHandle,
  type ServerBindingPersistenceDatabaseOperation,
} from "../enrollment/server-binding-coordinator-v1.js";
import {
  isArtifactReconciliationDatabaseOperation,
  snapshotArtifactReconciliationDatabaseInput,
} from "./artifacts.js";
import { DatabaseRequestError } from "./errors.js";
import type {
  DatabaseOperation,
  DatabaseOperationMap,
  DatabaseRequest,
  DatabaseWorkerMessage,
  DatabaseWorkerOptions,
} from "./protocol.js";

interface PendingRequest {
  readonly operation: DatabaseOperation;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

type ArtifactTransactionDatabaseDispatchers = {
  readonly [TOperation in ArtifactTransactionDatabaseOperation]: (
    input: DatabaseOperationMap[TOperation]["input"],
  ) => Promise<DatabaseOperationMap[TOperation]["output"]>;
};

type ServerBindingPersistenceDatabaseDispatchers = {
  readonly [TOperation in ServerBindingPersistenceDatabaseOperation]: (
    input: DatabaseOperationMap[TOperation]["input"],
  ) => Promise<DatabaseOperationMap[TOperation]["output"]>;
};

export interface DatabaseWorkerTransport {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  on(event: "message", listener: (value: DatabaseWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
}

const testTransportAttachment = Symbol("database-client-test-transport-attachment");
const databaseWorkerLifecycleTimeoutMilliseconds = 30_000;
const defaultDatabaseWorkerStartupTimeoutMilliseconds = 30 * 60 * 1_000;
const maximumDatabaseWorkerStartupTimeoutMilliseconds = 24 * 60 * 60 * 1_000;

const createShutdownExitError = (): DatabaseRequestError =>
  new DatabaseRequestError(
    "Database Worker exited before completing graceful shutdown.",
    "DATABASE_WORKER_SHUTDOWN_INCOMPLETE",
  );

const withDatabaseWorkerLifecycleTimeout = async <T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const terminateWorkerAndWaitForExit = async (
  worker: Pick<DatabaseWorkerTransport, "terminate">,
  exited: Promise<number>,
  timeoutMilliseconds = databaseWorkerLifecycleTimeoutMilliseconds,
): Promise<unknown | undefined> => {
  let terminationError: unknown;
  try {
    await withDatabaseWorkerLifecycleTimeout(
      Promise.resolve(worker.terminate()),
      timeoutMilliseconds,
      "Database Worker forced termination timed out.",
    );
  } catch (error) {
    terminationError = error;
  }
  let exitError: unknown;
  try {
    await withDatabaseWorkerLifecycleTimeout(
      exited,
      timeoutMilliseconds,
      "Database Worker exit was not observed after forced termination.",
    );
  } catch (error) {
    exitError = error;
  }
  if (terminationError !== undefined && exitError !== undefined) {
    return new AggregateError(
      [terminationError, exitError],
      "Database Worker termination and exit proof both failed.",
      { cause: terminationError },
    );
  }
  return terminationError ?? exitError;
};

export class DatabaseClient {
  readonly #worker: DatabaseWorkerTransport;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #ready: Promise<void>;
  readonly #exited: Promise<number>;
  readonly #terminalFailure = Promise.withResolvers<Error>();
  #resolveReady!: () => void;
  #rejectReady!: (reason: Error) => void;
  #resolveExited!: (exitCode: number) => void;
  #nextRequestId = 1;
  #isReady = false;
  #isClosing = false;
  #exitObserved = false;
  #artifactTransactionHandleIssued = false;
  #artifactTransactionHandle: ArtifactTransactionDatabaseHandle | undefined;
  #serverBindingPersistenceHandleIssued = false;
  #serverBindingPersistenceHandle: ServerBindingPersistenceDatabaseHandle | undefined;
  #shutdownRequested = false;
  #shutdownResponseReceived = false;
  #shutdownAcknowledged = false;
  #terminalError: Error | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #artifactTransactionDispatchers: ArtifactTransactionDatabaseDispatchers = Object.freeze({
    probeArtifactUploadCreate: (input) => this.#send("probeArtifactUploadCreate", input),
    createArtifactUpload: (input) => this.#send("createArtifactUpload", input),
    prepareArtifactChunk: (input) => this.#send("prepareArtifactChunk", input),
    commitArtifactChunk: (input) => this.#send("commitArtifactChunk", input),
    prepareArtifactFinalize: (input) => this.#send("prepareArtifactFinalize", input),
    commitArtifactFinalize: (input) => this.#send("commitArtifactFinalize", input),
    terminateArtifactUpload: (input) => this.#send("terminateArtifactUpload", input),
    terminalizeInactiveArtifactUploads: (input) =>
      this.#send(
        "terminalizeInactiveArtifactUploads",
        snapshotArtifactReconciliationDatabaseInput("terminalizeInactiveArtifactUploads", input),
      ),
    listDueArtifactCleanups: (input) =>
      this.#send(
        "listDueArtifactCleanups",
        snapshotArtifactReconciliationDatabaseInput("listDueArtifactCleanups", input),
      ),
    completeArtifactCleanup: (input) =>
      this.#send(
        "completeArtifactCleanup",
        snapshotArtifactReconciliationDatabaseInput("completeArtifactCleanup", input),
      ),
    recordArtifactCleanupFailure: (input) =>
      this.#send(
        "recordArtifactCleanupFailure",
        snapshotArtifactReconciliationDatabaseInput("recordArtifactCleanupFailure", input),
      ),
    classifyArtifactNamespacePageAndAdvanceCursor: (input) =>
      this.#send(
        "classifyArtifactNamespacePageAndAdvanceCursor",
        snapshotArtifactReconciliationDatabaseInput(
          "classifyArtifactNamespacePageAndAdvanceCursor",
          input,
        ),
      ),
    listDueArtifactNamespaceCleanups: (input) =>
      this.#send(
        "listDueArtifactNamespaceCleanups",
        snapshotArtifactReconciliationDatabaseInput("listDueArtifactNamespaceCleanups", input),
      ),
    completeArtifactNamespaceCleanup: (input) =>
      this.#send(
        "completeArtifactNamespaceCleanup",
        snapshotArtifactReconciliationDatabaseInput("completeArtifactNamespaceCleanup", input),
      ),
    recordArtifactNamespaceCleanupFailure: (input) =>
      this.#send(
        "recordArtifactNamespaceCleanupFailure",
        snapshotArtifactReconciliationDatabaseInput("recordArtifactNamespaceCleanupFailure", input),
      ),
    readArtifactHealthAccounting: (input) =>
      this.#send(
        "readArtifactHealthAccounting",
        snapshotArtifactReconciliationDatabaseInput("readArtifactHealthAccounting", input),
      ),
    readArtifactReconciliationCursor: (input) =>
      this.#send(
        "readArtifactReconciliationCursor",
        snapshotArtifactReconciliationDatabaseInput("readArtifactReconciliationCursor", input),
      ),
    prepareArtifactCompletion: (input) => this.#send("prepareArtifactCompletion", input),
    commitArtifactCompletion: (input) => this.#send("commitArtifactCompletion", input),
  } satisfies ArtifactTransactionDatabaseDispatchers);
  readonly #serverBindingPersistenceDispatchers: ServerBindingPersistenceDatabaseDispatchers =
    Object.freeze({
      initializeServerBindingIssuerV1: (input) =>
        this.#send("initializeServerBindingIssuerV1", input),
      createServerBindingAuthorizationV1: (input) =>
        this.#send("createServerBindingAuthorizationV1", input),
      claimServerBindingAuthorizationV1: (input) =>
        this.#send("claimServerBindingAuthorizationV1", input),
      commitServerBindingReceiptV1: (input) => this.#send("commitServerBindingReceiptV1", input),
      confirmServerBindingRecordV1: (input) => this.#send("confirmServerBindingRecordV1", input),
      readServerBindingRecoveryReceiptV1: (input) =>
        this.#send("readServerBindingRecoveryReceiptV1", input),
      readServerBindingActiveSnapshotV1: (input) =>
        this.#send("readServerBindingActiveSnapshotV1", input),
      recheckServerBindingActiveSnapshotV1: (input) =>
        this.#send("recheckServerBindingActiveSnapshotV1", input),
      revokeServerBindingV1: (input) => this.#send("revokeServerBindingV1", input),
    } satisfies ServerBindingPersistenceDatabaseDispatchers);

  private constructor(
    options: DatabaseWorkerOptions | undefined,
    injectedWorker?: DatabaseWorkerTransport,
  ) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#exited = new Promise<number>((resolve) => {
      this.#resolveExited = resolve;
    });

    if (injectedWorker === undefined) {
      if (options === undefined) {
        throw new TypeError("Database Worker options are required.");
      }
      const workerUrl = import.meta.url.endsWith(".ts")
        ? new URL("./database-worker.ts", import.meta.url)
        : new URL("./database-worker.js", import.meta.url);
      this.#worker = new Worker(workerUrl, { workerData: options }) as DatabaseWorkerTransport;
    } else {
      this.#worker = injectedWorker;
    }
    this.#worker.on("message", (message: DatabaseWorkerMessage) => {
      this.#handleMessage(message);
    });
    this.#worker.on("error", (error) => {
      this.#fail(error);
    });
    this.#worker.on("exit", (exitCode) => {
      this.#exitObserved = true;
      if (
        this.#isClosing &&
        this.#terminalError === undefined &&
        this.#shutdownRequested &&
        (this.#pending.size > 0 ||
          !this.#shutdownResponseReceived ||
          (this.#shutdownAcknowledged && exitCode !== 0))
      ) {
        this.#fail(createShutdownExitError());
      } else if (!this.#isClosing && this.#isReady) {
        this.#fail(new Error(`Database worker exited unexpectedly with code ${exitCode}.`));
      } else if (!this.#isClosing && !this.#isReady) {
        this.#fail(new Error("Database worker exited before becoming ready."));
      }
      this.#resolveExited(exitCode);
    });
  }

  public static async create(options: DatabaseWorkerOptions): Promise<DatabaseClient> {
    const startupTimeoutMilliseconds =
      options.startupTimeoutMilliseconds ?? defaultDatabaseWorkerStartupTimeoutMilliseconds;
    if (
      !Number.isSafeInteger(startupTimeoutMilliseconds) ||
      startupTimeoutMilliseconds < 1 ||
      startupTimeoutMilliseconds > maximumDatabaseWorkerStartupTimeoutMilliseconds
    ) {
      throw new TypeError("Database Worker startup timeout is invalid.");
    }
    const client = new DatabaseClient(options);
    try {
      await withDatabaseWorkerLifecycleTimeout(
        client.#ready,
        startupTimeoutMilliseconds,
        "Database Worker startup timed out.",
      );
      return client;
    } catch (error) {
      const terminationError = await client.#terminateAfterFailedStartup();
      if (!client.#exitObserved) {
        const failure = new AggregateError(
          terminationError === undefined ? [error] : [error, terminationError],
          "Database Worker startup failed without exit proof.",
          { cause: error },
        );
        Object.defineProperty(failure, "ownerExit", {
          configurable: false,
          enumerable: false,
          value: client.#exited,
          writable: false,
        });
        throw failure;
      }
      if (terminationError !== undefined) {
        throw new AggregateError(
          [error, terminationError],
          "Database Worker startup and termination both failed.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** Resolves only when the dedicated database Worker has exited. */
  public get ownerExit(): Promise<number> {
    return this.#exited;
  }

  /** @internal Test-only transport attachment. */
  static async [testTransportAttachment](worker: DatabaseWorkerTransport): Promise<DatabaseClient> {
    const client = new DatabaseClient(undefined, worker);
    await client.#ready;
    return client;
  }

  public request<
    TOperation extends Exclude<
      DatabaseOperation,
      ArtifactTransactionDatabaseOperation | ServerBindingPersistenceDatabaseOperation | "shutdown"
    >,
  >(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    if ((operation as DatabaseOperation) === "shutdown") {
      return Promise.reject(
        new DatabaseRequestError(
          "Database shutdown requires lifecycle-owner authority.",
          "DATABASE_SHUTDOWN_AUTHORITY_REQUIRED",
        ),
      ) as Promise<DatabaseOperationMap[TOperation]["output"]>;
    }
    if (isArtifactTransactionDatabaseOperation(operation)) {
      return Promise.reject(
        new DatabaseRequestError(
          "Artifact database operations require transaction coordinator authority.",
          "ARTIFACT_TRANSACTION_AUTHORITY_REQUIRED",
        ),
      ) as Promise<DatabaseOperationMap[TOperation]["output"]>;
    }
    if (isServerBindingPersistenceDatabaseOperation(operation)) {
      return Promise.reject(
        new DatabaseRequestError(
          "Server binding database operations require persistence coordinator authority.",
          "SERVER_BINDING_PERSISTENCE_AUTHORITY_REQUIRED",
        ),
      ) as Promise<DatabaseOperationMap[TOperation]["output"]>;
    }
    if (this.#isClosing) {
      return Promise.reject(new Error("Database client is closing."));
    }
    return this.#send(operation, input);
  }

  /** Returns one opaque handle that only ArtifactTransactionCoordinator can consume. */
  public createArtifactTransactionDatabaseHandle(): ArtifactTransactionDatabaseHandle {
    if (this.#isClosing || this.#terminalError !== undefined) {
      throw new Error("Database client is not available for artifact transaction adoption.");
    }
    if (this.#artifactTransactionHandleIssued) {
      throw new Error("Database client artifact transaction handle was already issued.");
    }
    const handle = registerArtifactTransactionDatabaseHandle(this, {
      terminalFailure: this.#terminalFailure.promise,
      request: (<TOperation extends ArtifactTransactionDatabaseOperation>(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) => this.#requestArtifactTransaction(operation, input)) as <
        TOperation extends ArtifactTransactionDatabaseOperation,
      >(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) => Promise<DatabaseOperationMap[TOperation]["output"]>,
      close: () => this.#startClose(),
    });
    this.#artifactTransactionHandleIssued = true;
    this.#artifactTransactionHandle = handle;
    return handle;
  }

  /** Returns one opaque handle that only ServerBindingCoordinatorV1 can consume. */
  public createServerBindingPersistenceDatabaseHandle(): ServerBindingPersistenceDatabaseHandle {
    if (this.#isClosing || this.#terminalError !== undefined) {
      throw new Error("Database client is not available for Server binding persistence adoption.");
    }
    if (this.#serverBindingPersistenceHandleIssued) {
      throw new Error("Database client Server binding persistence handle was already issued.");
    }
    const handle = registerServerBindingPersistenceDatabaseHandle(this, {
      terminalFailure: this.#terminalFailure.promise,
      request: (<TOperation extends ServerBindingPersistenceDatabaseOperation>(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) => this.#requestServerBindingPersistence(operation, input)) as <
        TOperation extends ServerBindingPersistenceDatabaseOperation,
      >(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) => Promise<DatabaseOperationMap[TOperation]["output"]>,
    });
    this.#serverBindingPersistenceHandleIssued = true;
    this.#serverBindingPersistenceHandle = handle;
    return handle;
  }

  public close(): Promise<void> {
    const serverBindingHandle = this.#serverBindingPersistenceHandle;
    if (
      serverBindingHandle !== undefined &&
      revokeServerBindingPersistenceDatabaseHandle(serverBindingHandle)
    ) {
      this.#serverBindingPersistenceHandle = undefined;
    }
    if (this.#artifactTransactionHandleIssued && this.#closePromise === undefined) {
      const handle = this.#artifactTransactionHandle;
      if (handle !== undefined && revokeArtifactTransactionDatabaseHandle(handle)) {
        this.#artifactTransactionHandle = undefined;
        return this.#startClose();
      }
      return Promise.reject(
        new DatabaseRequestError(
          "Database close requires artifact transaction coordinator authority.",
          "ARTIFACT_TRANSACTION_AUTHORITY_REQUIRED",
        ),
      );
    }
    return this.#startClose();
  }

  #startClose(): Promise<void> {
    this.#closePromise ??= this.#closeDatabaseOwner();
    return this.#closePromise;
  }

  async #closeDatabaseOwner(): Promise<void> {
    if (this.#isClosing) {
      await withDatabaseWorkerLifecycleTimeout(
        this.#exited,
        databaseWorkerLifecycleTimeoutMilliseconds,
        "Database Worker exit was not observed while closing.",
      );
      return;
    }

    this.#isClosing = true;
    if (this.#terminalError !== undefined) {
      const terminalError = this.#terminalError;
      let exitObserved = false;
      try {
        await withDatabaseWorkerLifecycleTimeout(
          this.#exited,
          databaseWorkerLifecycleTimeoutMilliseconds,
          "Database Worker exit was not observed after terminal failure.",
        );
        exitObserved = true;
      } catch {
        // A terminal message or error is not exit proof; force termination below.
      }
      if (!exitObserved) {
        const terminationError = await terminateWorkerAndWaitForExit(this.#worker, this.#exited);
        if (terminationError !== undefined) {
          throw new AggregateError(
            [terminalError, terminationError],
            "Database terminal failure and Worker termination both failed.",
            { cause: terminalError },
          );
        }
      }
      throw terminalError;
    }

    this.#shutdownRequested = true;
    try {
      await withDatabaseWorkerLifecycleTimeout(
        this.#send("shutdown", {}),
        databaseWorkerLifecycleTimeoutMilliseconds,
        "Database Worker graceful shutdown timed out.",
      );
    } catch (error) {
      const terminationError = await terminateWorkerAndWaitForExit(this.#worker, this.#exited);
      if (terminationError !== undefined) {
        throw new AggregateError(
          [error, terminationError],
          "Database shutdown and Worker termination both failed.",
          { cause: error },
        );
      }
      throw this.#terminalError ?? error;
    }
    try {
      await withDatabaseWorkerLifecycleTimeout(
        this.#exited,
        databaseWorkerLifecycleTimeoutMilliseconds,
        "Database Worker exit was not observed after graceful shutdown.",
      );
    } catch (error) {
      const terminationError = await terminateWorkerAndWaitForExit(this.#worker, this.#exited);
      if (terminationError !== undefined) {
        throw new AggregateError(
          [error, terminationError],
          "Database Worker exit and forced termination both failed.",
          { cause: error },
        );
      }
      throw this.#terminalError ?? error;
    }
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
  }

  async #send<TOperation extends DatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    await this.#ready;
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }

    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const request: DatabaseRequest<TOperation> = {
      type: "request",
      id,
      operation,
      input,
    };
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { operation, resolve, reject });
    });
    try {
      this.#worker.postMessage(request);
    } catch {
      this.#pending.delete(id);
      throw new DatabaseRequestError(
        "Database request could not be sent to the Worker.",
        "DATABASE_REQUEST_NOT_SENT",
      );
    }
    return (await response) as DatabaseOperationMap[TOperation]["output"];
  }

  #requestArtifactTransaction<TOperation extends ArtifactTransactionDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    if (this.#isClosing || this.#terminalError !== undefined) {
      return Promise.reject(
        new Error("Database client is not available for artifact transactions."),
      );
    }
    try {
      return this.#artifactTransactionDispatchers[operation](input);
    } catch (error) {
      if (!isArtifactReconciliationDatabaseOperation(operation)) {
        return Promise.reject(error);
      }
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "ARTIFACT_RECONCILIATION_INVALID_REQUEST";
      return Promise.reject(
        new DatabaseRequestError("The artifact reconciliation request is invalid.", code),
      );
    }
  }

  #requestServerBindingPersistence<TOperation extends ServerBindingPersistenceDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    if (this.#isClosing || this.#terminalError !== undefined) {
      return Promise.reject(
        new Error("Database client is not available for Server binding persistence."),
      );
    }
    return this.#serverBindingPersistenceDispatchers[operation](input);
  }

  #handleMessage(message: DatabaseWorkerMessage): void {
    if (message.type === "ready") {
      this.#isReady = true;
      this.#resolveReady();
      return;
    }
    if (message.type === "fatal") {
      this.#fail(
        new DatabaseRequestError(
          `${message.error.name}: ${message.error.message}`,
          message.error.code,
        ),
      );
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);
    if (pending.operation === "shutdown") {
      this.#shutdownResponseReceived = true;
      this.#shutdownAcknowledged = message.ok;
    }
    if (message.ok) {
      pending.resolve(message.output);
      return;
    }
    pending.reject(new DatabaseRequestError(message.error.message, message.error.code));
  }

  #fail(error: Error): void {
    if (this.#terminalError !== undefined) {
      return;
    }
    this.#terminalError = error;
    const serverBindingHandle = this.#serverBindingPersistenceHandle;
    if (
      serverBindingHandle !== undefined &&
      revokeServerBindingPersistenceDatabaseHandle(serverBindingHandle)
    ) {
      this.#serverBindingPersistenceHandle = undefined;
    }
    this.#terminalFailure.resolve(error);
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #terminateAfterFailedStartup(): Promise<unknown | undefined> {
    this.#isClosing = true;
    return terminateWorkerAndWaitForExit(this.#worker, this.#exited);
  }
}

/** @internal Test-only helper; intentionally absent from public barrels. */
export const attachDatabaseClientForTest = (
  worker: DatabaseWorkerTransport,
): Promise<DatabaseClient> => DatabaseClient[testTransportAttachment](worker);
