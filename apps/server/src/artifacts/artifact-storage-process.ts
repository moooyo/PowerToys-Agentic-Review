import type {
  ArtifactNamespaceCleanupResult,
  ArtifactNamespaceScanPageResult,
  CloseArtifactNamespaceScanResult,
} from "./artifact-namespace-contract.js";
import { ArtifactStorageKernel } from "./artifact-storage.js";
import { LinuxArtifactStorageOperations } from "./linux-filesystem.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactStorageKernelOptions,
  ArtifactUploadCleanupResult,
  DurableArtifactChunk,
  PublishedArtifactObject,
} from "./types.js";
import {
  type ArtifactStorageResponseExpectation,
  type ArtifactStorageWorkerOperation,
  type ArtifactStorageWorkerOperationMap,
  type ArtifactStorageWorkerRequest,
  artifactStorageProcessEntryArgument,
  artifactStorageProtocolVersion,
  assertArtifactStorageResponseMatchesExpectation,
  createArtifactStorageResponseExpectation,
  isFatalArtifactStorageOperationError,
  normalizeArtifactStorageOperationOutput,
  parseArtifactStorageProcessInitialize,
  parseArtifactStorageWorkerRequest,
  serializeArtifactStorageError,
  serializeArtifactStorageFatalError,
} from "./worker-protocol.js";

interface ArtifactStorageProcessPort {
  readonly connected: boolean;
  send(value: unknown, callback: (error: Error | null) => void): boolean;
  disconnect(): void;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "disconnect", listener: () => void): this;
}

interface ArtifactStorageProcessKernel {
  writePreparedChunk(
    input: ArtifactStorageWorkerOperationMap["writePreparedChunk"]["input"],
  ): Promise<DurableArtifactChunk>;
  finalizeArtifact(
    input: ArtifactStorageWorkerOperationMap["finalizeArtifact"]["input"],
  ): Promise<PublishedArtifactObject>;
  readObject(input: ArtifactStorageWorkerOperationMap["readObject"]["input"]): Promise<Buffer>;
  cleanupUpload(
    input: ArtifactStorageWorkerOperationMap["cleanupUpload"]["input"],
  ): Promise<ArtifactUploadCleanupResult>;
  scanNamespacePage(
    input: ArtifactStorageWorkerOperationMap["scanNamespacePage"]["input"],
  ): Promise<ArtifactNamespaceScanPageResult>;
  closeNamespaceScan(
    input: ArtifactStorageWorkerOperationMap["closeNamespaceScan"]["input"],
  ): Promise<CloseArtifactNamespaceScanResult>;
  cleanupNamespaceEntry(
    input: ArtifactStorageWorkerOperationMap["cleanupNamespaceEntry"]["input"],
  ): Promise<ArtifactNamespaceCleanupResult>;
  evaluateCapacity(
    input: ArtifactStorageWorkerOperationMap["evaluateCapacity"]["input"],
  ): Promise<ArtifactCapacityAdmission>;
  close(): Promise<void>;
}

type ArtifactStorageKernelFactory = (
  options: ArtifactStorageKernelOptions,
) => ArtifactStorageProcessKernel;

const dispatchOperation = (
  kernel: ArtifactStorageProcessKernel,
  request: Exclude<ArtifactStorageWorkerRequest, { readonly operation: "shutdown" }>,
): Promise<unknown> => {
  switch (request.operation) {
    case "writePreparedChunk":
      return kernel.writePreparedChunk(request.input);
    case "finalizeArtifact":
      return kernel.finalizeArtifact(request.input);
    case "readObject":
      return kernel.readObject(request.input).then((bytes) => ({ bytes: new Uint8Array(bytes) }));
    case "cleanupUpload":
      return kernel.cleanupUpload(request.input);
    case "scanNamespacePage":
      return kernel.scanNamespacePage(request.input);
    case "closeNamespaceScan":
      return kernel.closeNamespaceScan(request.input);
    case "cleanupNamespaceEntry":
      return kernel.cleanupNamespaceEntry(request.input);
    case "evaluateCapacity":
      return kernel.evaluateCapacity(request.input);
    default:
      throw new TypeError("Artifact storage operation is unsupported.");
  }
};

const sendMessage = (port: ArtifactStorageProcessPort, value: unknown): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let callbackCalled = false;
    const callback = (error: Error | null): void => {
      if (callbackCalled) {
        return;
      }
      callbackCalled = true;
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    try {
      port.send(value, callback);
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Artifact storage IPC send failed."));
    }
  });

export const runArtifactStorageProcess = (
  port: ArtifactStorageProcessPort,
  createKernel: ArtifactStorageKernelFactory = (options) =>
    new ArtifactStorageKernel(options, new LinuxArtifactStorageOperations()),
  setExitCode: (exitCode: number) => void = (exitCode) => {
    process.exitCode = exitCode;
  },
): void => {
  let state: "uninitialized" | "initializing" | "open" | "closing" | "fatal" = "uninitialized";
  let kernel: ArtifactStorageProcessKernel | undefined;
  let capacity: ArtifactStorageKernelOptions["capacity"] | undefined;
  let lastRequestId = 0;
  let closePromise: Promise<void> | undefined;
  let portClosed = false;
  const activeRequests = new Set<Promise<void>>();

  const closePort = (exitCode: number): void => {
    if (portClosed) {
      return;
    }
    portClosed = true;
    setExitCode(exitCode);
    if (port.connected) {
      try {
        port.disconnect();
      } catch {
        // OS process exit remains the parent-side proof even if IPC teardown throws.
      }
    }
  };

  const closeKernel = (): Promise<void> => {
    closePromise ??= Promise.resolve().then(() => kernel?.close());
    return closePromise;
  };

  const failFatal = (error: unknown): void => {
    if (state === "fatal") {
      return;
    }
    state = "fatal";
    const fatalSend = port.connected
      ? sendMessage(port, {
          type: "fatal",
          protocolVersion: artifactStorageProtocolVersion,
          error: serializeArtifactStorageFatalError(error),
        }).catch(() => undefined)
      : Promise.resolve();
    void Promise.allSettled([fatalSend, closeKernel()]).then(() => closePort(1));
  };

  const handleRequest = (untrustedRequest: unknown): void => {
    if (state !== "open" || kernel === undefined || capacity === undefined) {
      failFatal(new TypeError("Artifact storage received a request outside its open state."));
      return;
    }

    let request: ArtifactStorageWorkerRequest;
    let expectation: ArtifactStorageResponseExpectation;
    try {
      request = parseArtifactStorageWorkerRequest(untrustedRequest);
      if (request.id !== lastRequestId + 1) {
        throw new TypeError("Artifact storage request IDs must be strictly consecutive.");
      }
      lastRequestId = request.id;
      expectation = createArtifactStorageResponseExpectation(request.operation, request.input);
    } catch (error) {
      failFatal(error);
      return;
    }

    if (request.operation === "shutdown") {
      state = "closing";
      void Promise.allSettled([...activeRequests])
        .then(() => closeKernel())
        .then(() => {
          if (state !== "closing") {
            return;
          }
          const output = normalizeArtifactStorageOperationOutput("shutdown", { closed: true });
          assertArtifactStorageResponseMatchesExpectation(
            expectation,
            "shutdown",
            output,
            capacity,
          );
          return sendMessage(port, {
            type: "response",
            protocolVersion: artifactStorageProtocolVersion,
            id: request.id,
            operation: "shutdown",
            ok: true,
            output,
          });
        })
        .then(() => {
          if (state === "closing") {
            closePort(0);
          }
        })
        .catch(failFatal);
      return;
    }

    let operation: Promise<void>;
    try {
      const result = dispatchOperation(
        kernel,
        request as Exclude<ArtifactStorageWorkerRequest, { readonly operation: "shutdown" }>,
      );
      operation = result
        .then(async (untrustedOutput) => {
          if (state === "fatal") {
            return;
          }
          const operationName = request.operation as Exclude<
            ArtifactStorageWorkerOperation,
            "shutdown"
          >;
          const output = normalizeArtifactStorageOperationOutput(operationName, untrustedOutput);
          assertArtifactStorageResponseMatchesExpectation(
            expectation,
            operationName,
            output,
            capacity,
          );
          await sendMessage(port, {
            type: "response",
            protocolVersion: artifactStorageProtocolVersion,
            id: request.id,
            operation: operationName,
            ok: true,
            output,
          });
        })
        .catch(async (error: unknown) => {
          if (state === "fatal") {
            return;
          }
          const serialized = serializeArtifactStorageError(error);
          if (isFatalArtifactStorageOperationError(request.operation, serialized)) {
            throw error;
          }
          await sendMessage(port, {
            type: "response",
            protocolVersion: artifactStorageProtocolVersion,
            id: request.id,
            operation: request.operation,
            ok: false,
            error: serialized,
          });
        });
    } catch (error) {
      failFatal(error);
      return;
    }
    activeRequests.add(operation);
    void operation.then(
      () => activeRequests.delete(operation),
      (error) => {
        activeRequests.delete(operation);
        failFatal(error);
      },
    );
  };

  port.on("message", (untrustedMessage) => {
    if (state !== "uninitialized") {
      handleRequest(untrustedMessage);
      return;
    }
    state = "initializing";
    try {
      const initialization = parseArtifactStorageProcessInitialize(untrustedMessage);
      kernel = createKernel(initialization.storage);
      if (kernel === undefined) {
        throw new TypeError("Artifact storage kernel factory returned no owner.");
      }
      capacity = initialization.storage.capacity;
      state = "open";
      void sendMessage(port, {
        type: "ready",
        protocolVersion: artifactStorageProtocolVersion,
      }).catch(failFatal);
    } catch (error) {
      failFatal(error);
    }
  });
  port.on("disconnect", () => {
    if (!portClosed) {
      failFatal(new TypeError("Artifact storage parent IPC disconnected."));
    }
  });
};

class CurrentProcessPort implements ArtifactStorageProcessPort {
  get connected(): boolean {
    return process.connected;
  }

  send(value: unknown, callback: (error: Error | null) => void): boolean {
    const send = process.send;
    if (send === undefined) {
      throw new Error("Artifact storage parent IPC is unavailable.");
    }
    return Reflect.apply(send, process, [value, callback]) as boolean;
  }

  disconnect(): void {
    process.disconnect();
  }

  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "disconnect", listener: () => void): this;
  on(event: "message" | "disconnect", listener: ((value: unknown) => void) | (() => void)): this {
    Reflect.apply(process.on, process, [event, listener]);
    return this;
  }
}

const processPort: ArtifactStorageProcessPort | undefined =
  typeof process.send === "function" ? new CurrentProcessPort() : undefined;

if (process.argv[2] === artifactStorageProcessEntryArgument && processPort !== undefined) {
  runArtifactStorageProcess(processPort);
}
