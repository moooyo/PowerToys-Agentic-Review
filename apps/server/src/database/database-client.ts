import { Worker } from "node:worker_threads";
import {
  type ArtifactUploadCreateDatabaseHandle,
  registerArtifactUploadCreateDatabaseHandle,
} from "../artifacts/artifact-upload-create-coordinator.js";
import { DatabaseRequestError } from "./errors.js";
import type {
  DatabaseOperation,
  DatabaseOperationMap,
  DatabaseRequest,
  DatabaseWorkerMessage,
  DatabaseWorkerOptions,
} from "./protocol.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

export const terminateWorkerAndWaitForExit = async (
  worker: Pick<Worker, "terminate">,
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
  readonly #worker: Worker;
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
  #terminalError: Error | undefined;

  private constructor(options: DatabaseWorkerOptions) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#exited = new Promise<number>((resolve) => {
      this.#resolveExited = resolve;
    });

    const workerUrl = import.meta.url.endsWith(".ts")
      ? new URL("./database-worker.ts", import.meta.url)
      : new URL("./database-worker.js", import.meta.url);
    this.#worker = new Worker(workerUrl, { workerData: options });
    this.#worker.on("message", (message: DatabaseWorkerMessage) => {
      this.#handleMessage(message);
    });
    this.#worker.on("error", (error) => {
      this.#fail(error);
    });
    this.#worker.on("exit", (exitCode) => {
      if (!this.#isClosing && this.#isReady) {
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

  public request<TOperation extends Exclude<DatabaseOperation, "createArtifactUpload">>(
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
      close: () => this.#closeDatabaseOwner(),
    });
    this.#artifactUploadCreateHandleIssued = true;
    return handle;
  }

  public close(): Promise<void> {
    return this.#closeDatabaseOwner();
  }

  async #closeDatabaseOwner(): Promise<void> {
    if (this.#isClosing) {
      await this.#exited;
      return;
    }

    this.#isClosing = true;
    if (this.#terminalError === undefined) {
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
      this.#pending.set(id, { resolve, reject });
    });
    this.#worker.postMessage(request);
    return (await response) as DatabaseOperationMap[TOperation]["output"];
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
