import { Worker } from "node:worker_threads";
import {
  type ArtifactReconciliationDatabaseHandle,
  registerArtifactReconciliationDatabaseHandle,
} from "../artifacts/artifact-reconciliation-coordinator.js";
import {
  type ArtifactUploadCreateDatabaseHandle,
  registerArtifactUploadCreateDatabaseHandle,
} from "../artifacts/artifact-upload-create-coordinator.js";
import {
  type ArtifactReconciliationDatabaseOperation,
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

export interface DatabaseWorkerTransport {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  on(event: "message", listener: (value: DatabaseWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
}

const testTransportAttachment = Symbol("database-client-test-transport-attachment");

const createShutdownExitError = (): DatabaseRequestError =>
  new DatabaseRequestError(
    "Database Worker exited before completing graceful shutdown.",
    "DATABASE_WORKER_SHUTDOWN_INCOMPLETE",
  );

export const terminateWorkerAndWaitForExit = async (
  worker: Pick<DatabaseWorkerTransport, "terminate">,
  exited: Promise<number>,
): Promise<unknown | undefined> => {
  let terminationError: unknown;
  try {
    await worker.terminate();
  } catch (error) {
    terminationError = error;
  }
  await exited;
  return terminationError;
};

export class DatabaseClient {
  readonly #worker: DatabaseWorkerTransport;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #ready: Promise<void>;
  readonly #exited: Promise<number>;
  #resolveReady!: () => void;
  #rejectReady!: (reason: Error) => void;
  #resolveExited!: (exitCode: number) => void;
  #nextRequestId = 1;
  #isReady = false;
  #isClosing = false;
  #artifactUploadCreateHandleIssued = false;
  #artifactReconciliationHandleIssued = false;
  #shutdownRequested = false;
  #shutdownResponseReceived = false;
  #shutdownAcknowledged = false;
  #terminalError: Error | undefined;
  #closePromise: Promise<void> | undefined;

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
    const client = new DatabaseClient(options);
    try {
      await client.#ready;
      return client;
    } catch (error) {
      await client.#terminateAfterFailedStartup();
      throw error;
    }
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
      "createArtifactUpload" | ArtifactReconciliationDatabaseOperation
    >,
  >(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    if ((operation as DatabaseOperation) === "createArtifactUpload") {
      return Promise.reject(
        new DatabaseRequestError(
          "Artifact upload creation requires capacity admission authority.",
          "ARTIFACT_CREATE_ADMISSION_REQUIRED",
        ),
      ) as Promise<DatabaseOperationMap[TOperation]["output"]>;
    }
    if (isArtifactReconciliationDatabaseOperation(operation)) {
      return Promise.reject(
        new DatabaseRequestError(
          "Artifact reconciliation requires coordinator authority.",
          "ARTIFACT_RECONCILIATION_AUTHORITY_REQUIRED",
        ),
      ) as Promise<DatabaseOperationMap[TOperation]["output"]>;
    }
    if (this.#isClosing) {
      return Promise.reject(new Error("Database client is closing."));
    }
    return this.#send(operation, input);
  }

  /** Returns an opaque one-shot handle that only ArtifactUploadCreateCoordinator can consume. */
  public createArtifactUploadCreateDatabaseHandle(): ArtifactUploadCreateDatabaseHandle {
    if (this.#isClosing || this.#terminalError !== undefined) {
      throw new Error("Database client is not available for artifact create adoption.");
    }
    if (this.#artifactUploadCreateHandleIssued) {
      throw new Error("Database client artifact create handle was already issued.");
    }
    const handle = registerArtifactUploadCreateDatabaseHandle(this, {
      probeArtifactUploadCreate: (input) => this.#send("probeArtifactUploadCreate", input),
      createArtifactUpload: (input) => this.#send("createArtifactUpload", input),
      close: () => this.#startClose(),
    });
    this.#artifactUploadCreateHandleIssued = true;
    return handle;
  }

  /** Returns an opaque one-shot handle that only ArtifactReconciliationCoordinator can consume. */
  public createArtifactReconciliationDatabaseHandle(): ArtifactReconciliationDatabaseHandle {
    if (this.#isClosing || this.#terminalError !== undefined) {
      throw new Error("Database client is not available for artifact reconciliation adoption.");
    }
    if (this.#artifactReconciliationHandleIssued) {
      throw new Error("Database client artifact reconciliation handle was already issued.");
    }
    const handle = registerArtifactReconciliationDatabaseHandle({
      request: (<TOperation extends ArtifactReconciliationDatabaseOperation>(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) => this.#requestArtifactReconciliation(operation, input)) as <
        TOperation extends ArtifactReconciliationDatabaseOperation,
      >(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) => Promise<DatabaseOperationMap[TOperation]["output"]>,
    });
    this.#artifactReconciliationHandleIssued = true;
    return handle;
  }

  public close(): Promise<void> {
    return this.#startClose();
  }

  #startClose(): Promise<void> {
    this.#closePromise ??= this.#closeDatabaseOwner();
    return this.#closePromise;
  }

  async #closeDatabaseOwner(): Promise<void> {
    if (this.#isClosing) {
      await this.#exited;
      return;
    }

    this.#isClosing = true;
    if (this.#terminalError === undefined) {
      this.#shutdownRequested = true;
      try {
        await this.#send("shutdown", {});
      } catch (error) {
        const terminationError = await terminateWorkerAndWaitForExit(this.#worker, this.#exited);
        if (terminationError !== undefined) {
          throw new AggregateError(
            [error, terminationError],
            "Database shutdown and Worker termination both failed.",
            { cause: error },
          );
        }
        throw error;
      }
    }
    await this.#exited;
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
    this.#worker.postMessage(request);
    return (await response) as DatabaseOperationMap[TOperation]["output"];
  }

  #requestArtifactReconciliation<TOperation extends ArtifactReconciliationDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    if (this.#isClosing || this.#terminalError !== undefined) {
      return Promise.reject(new Error("Database client is not available for reconciliation."));
    }
    let inputSnapshot: Readonly<Record<string, unknown>>;
    try {
      inputSnapshot = snapshotArtifactReconciliationDatabaseInput(operation, input);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "ARTIFACT_RECONCILIATION_INVALID_REQUEST";
      return Promise.reject(
        new DatabaseRequestError("The artifact reconciliation request is invalid.", code),
      );
    }
    return this.#send(
      operation,
      inputSnapshot as unknown as DatabaseOperationMap[TOperation]["input"],
    );
  }

  #handleMessage(message: DatabaseWorkerMessage): void {
    if (message.type === "ready") {
      this.#isReady = true;
      this.#resolveReady();
      return;
    }
    if (message.type === "fatal") {
      this.#fail(new Error(`${message.error.name}: ${message.error.message}`));
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
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #terminateAfterFailedStartup(): Promise<void> {
    this.#isClosing = true;
    await this.#worker.terminate().catch(() => undefined);
    await this.#exited;
  }
}

/** @internal Test-only helper; intentionally absent from public barrels. */
export const attachDatabaseClientForTest = (
  worker: DatabaseWorkerTransport,
): Promise<DatabaseClient> => DatabaseClient[testTransportAttachment](worker);
