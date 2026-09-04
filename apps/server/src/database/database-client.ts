import { Worker } from "node:worker_threads";
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
  #resolveReady!: () => void;
  #rejectReady!: (reason: Error) => void;
  #resolveExited!: (exitCode: number) => void;
  #nextRequestId = 1;
  #isReady = false;
  #isClosing = false;
  #exitObserved = false;
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

  public request<TOperation extends Exclude<DatabaseOperation, "shutdown">>(
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
    if (this.#isClosing) {
      return Promise.reject(new Error("Database client is closing."));
    }
    return this.#send(operation, input);
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
