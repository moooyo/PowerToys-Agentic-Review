import { parentPort, workerData } from "node:worker_threads";
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
  type ArtifactStorageWorkerData,
  type ArtifactStorageWorkerOperation,
  type ArtifactStorageWorkerOperationMap,
  type ArtifactStorageWorkerRequest,
  artifactStorageProtocolVersion,
  assertArtifactStorageResponseMatchesExpectation,
  createArtifactStorageResponseExpectation,
  isFatalArtifactStorageOperationError,
  normalizeArtifactStorageOperationOutput,
  normalizeArtifactStorageWorkerData,
  parseArtifactStorageWorkerRequest,
  serializeArtifactStorageError,
  serializeArtifactStorageFatalError,
} from "./worker-protocol.js";

interface ArtifactStorageWorkerPort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "messageerror", listener: (error: Error) => void): this;
  close(): void;
}

interface ArtifactStorageWorkerKernel {
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
) => ArtifactStorageWorkerKernel;

const dispatchOperation = (
  kernel: ArtifactStorageWorkerKernel,
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

export const runArtifactStorageWorker = (
  port: ArtifactStorageWorkerPort,
  untrustedWorkerData: unknown,
  createKernel: ArtifactStorageKernelFactory = (options) =>
    new ArtifactStorageKernel(options, new LinuxArtifactStorageOperations()),
): void => {
  let data: ArtifactStorageWorkerData;
  let kernel: ArtifactStorageWorkerKernel | undefined;
  let state: "initializing" | "open" | "closing" | "fatal" = "initializing";
  let lastRequestId = 0;
  let closePromise: Promise<void> | undefined;
  let portClosed = false;
  const activeRequests = new Set<Promise<void>>();

  const closePort = (): void => {
    if (portClosed) {
      return;
    }
    portClosed = true;
    try {
      port.close();
    } catch {
      // The Worker exit event remains the parent-side proof even if channel closure throws.
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
    if (!portClosed) {
      try {
        port.postMessage({
          type: "fatal",
          protocolVersion: artifactStorageProtocolVersion,
          error: serializeArtifactStorageFatalError(error),
        });
      } catch {
        // The owner still closes when its protocol channel is already unusable.
      }
    }
    void closeKernel().then(closePort, closePort);
  };

  try {
    data = normalizeArtifactStorageWorkerData(untrustedWorkerData);
    kernel = createKernel(data.storage);
    if (kernel === undefined) {
      throw new TypeError("Artifact storage kernel factory returned no owner.");
    }
    port.postMessage({ type: "ready", protocolVersion: artifactStorageProtocolVersion });
    state = "open";
  } catch (error) {
    failFatal(error);
    return;
  }

  const activeKernel = kernel;
  const capacity = data.storage.capacity;

  port.on("messageerror", () => {
    failFatal(new TypeError("Artifact storage request could not be cloned."));
  });
  port.on("message", (untrustedRequest) => {
    if (state !== "open") {
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
          port.postMessage({
            type: "response",
            protocolVersion: artifactStorageProtocolVersion,
            id: request.id,
            operation: "shutdown",
            ok: true,
            output,
          });
          closePort();
        })
        .catch(failFatal);
      return;
    }

    let operation: Promise<void>;
    try {
      const result = dispatchOperation(
        activeKernel,
        request as Exclude<ArtifactStorageWorkerRequest, { readonly operation: "shutdown" }>,
      );
      operation = result
        .then((untrustedOutput) => {
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
          port.postMessage({
            type: "response",
            protocolVersion: artifactStorageProtocolVersion,
            id: request.id,
            operation: operationName,
            ok: true,
            output,
          });
        })
        .catch((error: unknown) => {
          if (state === "fatal") {
            return;
          }
          const serialized = serializeArtifactStorageError(error);
          if (isFatalArtifactStorageOperationError(request.operation, serialized)) {
            throw error;
          }
          port.postMessage({
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
  });
};

if (parentPort !== null) {
  runArtifactStorageWorker(parentPort, workerData);
}
