import { parentPort, workerData } from "node:worker_threads";
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
  try {
    data = normalizeArtifactStorageWorkerData(untrustedWorkerData);
    kernel = createKernel(data.storage);
    if (kernel === undefined) {
      throw new TypeError("Artifact storage kernel factory returned no owner.");
    }
    port.postMessage({ type: "ready", protocolVersion: artifactStorageProtocolVersion });
  } catch (error) {
    try {
      port.postMessage({
        type: "fatal",
        protocolVersion: artifactStorageProtocolVersion,
        error: serializeArtifactStorageFatalError(error),
      });
    } catch {
      // The channel may be the initialization failure; closure still releases the kernel owner.
    }
    if (kernel === undefined) {
      port.close();
    } else {
      void Promise.resolve()
        .then(() => kernel?.close())
        .then(
          () => port.close(),
          () => port.close(),
        );
    }
    return;
  }

  const activeKernel = kernel;
  const capacity = data.storage.capacity;

  let accepting = true;
  let fatal = false;
  let lastRequestId = 0;

  const failFatal = (error: unknown): void => {
    if (fatal) {
      return;
    }
    fatal = true;
    accepting = false;
    try {
      port.postMessage({
        type: "fatal",
        protocolVersion: artifactStorageProtocolVersion,
        error: serializeArtifactStorageFatalError(error),
      });
    } catch {
      // The owner still closes even when its protocol channel is already unusable.
    }
    void activeKernel.close().then(
      () => port.close(),
      () => port.close(),
    );
  };

  port.on("messageerror", () => {
    failFatal(new TypeError("Artifact storage request could not be cloned."));
  });
  port.on("message", (untrustedRequest) => {
    if (!accepting) {
      failFatal(new TypeError("Artifact storage received a request after shutdown."));
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
      accepting = false;
      void activeKernel
        .close()
        .then(() => {
          if (fatal) {
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
          port.close();
        })
        .catch(failFatal);
      return;
    }

    let result: Promise<unknown>;
    try {
      result = dispatchOperation(
        activeKernel,
        request as Exclude<ArtifactStorageWorkerRequest, { readonly operation: "shutdown" }>,
      );
    } catch (error) {
      failFatal(error);
      return;
    }
    void result
      .then((untrustedOutput) => {
        if (fatal) {
          return;
        }
        const operation = request.operation as Exclude<ArtifactStorageWorkerOperation, "shutdown">;
        const output = normalizeArtifactStorageOperationOutput(operation, untrustedOutput);
        assertArtifactStorageResponseMatchesExpectation(expectation, operation, output, capacity);
        port.postMessage({
          type: "response",
          protocolVersion: artifactStorageProtocolVersion,
          id: request.id,
          operation,
          ok: true,
          output,
        });
      })
      .catch((error: unknown) => {
        if (fatal) {
          return;
        }
        const serialized = serializeArtifactStorageError(error);
        if (isFatalArtifactStorageOperationError(request.operation, serialized)) {
          failFatal(error);
          return;
        }
        try {
          port.postMessage({
            type: "response",
            protocolVersion: artifactStorageProtocolVersion,
            id: request.id,
            operation: request.operation,
            ok: false,
            error: serialized,
          });
        } catch (postError) {
          failFatal(postError);
        }
      });
  });
};

if (parentPort !== null) {
  runArtifactStorageWorker(parentPort, workerData);
}
