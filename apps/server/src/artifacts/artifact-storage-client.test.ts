import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  attachArtifactStorageClientForTest,
  ArtifactStorageClient,
  type ArtifactStorageClientOptions,
  type ArtifactStorageWorkerTransport,
} from "../../dist/artifacts/artifact-storage-client.js";
import { ArtifactStorageClientError } from "../../dist/artifacts/errors.js";
import { artifactStorageProtocolVersion } from "../../dist/artifacts/worker-protocol.js";

const uploadId = "11111111-1111-4111-8111-111111111111";
const secondUploadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prepareId = "22222222-2222-4222-8222-222222222222";

class FakeArtifactWorker extends EventEmitter {
  readonly posted: unknown[] = [];
  terminateCalls = 0;
  throwOnPost = false;
  autoExitOnTerminate = true;
  terminateError: Error | undefined;
  onPost: ((message: unknown) => void) | undefined;

  postMessage(message: unknown): void {
    if (this.throwOnPost) {
      throw new Error("injected post failure");
    }
    this.posted.push(message);
    this.onPost?.(message);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    if (this.terminateError !== undefined) {
      return Promise.reject(this.terminateError);
    }
    if (this.autoExitOnTerminate) {
      queueMicrotask(() => this.emit("exit", 1));
    }
    return Promise.resolve(1);
  }

  ready(): void {
    this.emit("message", { type: "ready", protocolVersion: artifactStorageProtocolVersion });
  }

  message(value: unknown): void {
    this.emit("message", value);
  }
}

const clientOptions = (overrides: Partial<ArtifactStorageClientOptions> = {}) => ({
  storage: {
    rootPath: "/artifact",
    capacity: {
      hardBytes: 100_000_000n,
      hardEntries: 1_000,
      emergencyReserveBytes: 10_000n,
      perUploadMetadataHeadroomBytes: 4_096n,
      cleanupBacklogHighWaterEntries: 100,
    },
    closeTimeoutMilliseconds: 1_000,
  },
  startupTimeoutMilliseconds: 1_000,
  requestTimeoutMilliseconds: 1_000,
  shutdownTimeoutMilliseconds: 1_000,
  exitTimeoutMilliseconds: 1_000,
  ...overrides,
});

const attach = async (
  worker: FakeArtifactWorker,
  options: ArtifactStorageClientOptions = clientOptions(),
  initialRequestId = 1,
): Promise<ArtifactStorageClient> => {
  const connecting = attachArtifactStorageClientForTest(
    options,
    worker as unknown as ArtifactStorageWorkerTransport,
    initialRequestId,
  );
  worker.ready();
  return connecting;
};

const blockFor = (milliseconds: number): void => {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    // Exercise the post-synchronous-work deadline checks without relying on timer delivery.
  }
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const chunkInput = (bytes = Buffer.from("chunk")) => ({
  uploadId,
  prepareId,
  chunkIndex: 0,
  offsetBytes: 0,
  chunkSha256: sha256(bytes),
  bytes,
  receiptState: "prepared" as const,
  committedOffsetBytes: 0,
  committedPrefix: [],
});

const success = (id: number, operation: string, output: unknown) => ({
  type: "response",
  protocolVersion: artifactStorageProtocolVersion,
  id,
  operation,
  ok: true,
  output,
});

const shutdownGracefully = async (
  client: ArtifactStorageClient,
  worker: FakeArtifactWorker,
): Promise<void> => {
  const closing = client.close();
  const request = worker.posted.at(-1) as { readonly id: number };
  worker.message(success(request.id, "shutdown", { closed: true }));
  worker.emit("exit", 0);
  await closing;
};

describe("ArtifactStorageClient protocol and lifecycle", () => {
  it("rejects a response sent before the Worker becomes ready", async () => {
    const worker = new FakeArtifactWorker();
    const connecting = attachArtifactStorageClientForTest(
      clientOptions(),
      worker as unknown as ArtifactStorageWorkerTransport,
    );
    worker.message(
      success(1, "cleanupUpload", {
        stagingRemoved: false,
        publicationTemporariesRemoved: 0,
      }),
    );
    let failure: unknown;
    try {
      await connecting;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "ARTIFACT_STORAGE_CLIENT_PROTOCOL" });
    expect(worker.terminateCalls).toBe(1);
    await (failure as ArtifactStorageClientError).ownerExit;
  });

  it("snapshots chunk bytes and accepts a strictly correlated response", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const source = Buffer.from("chunk");
    const request = client.writePreparedChunk(chunkInput(source));
    const posted = worker.posted[0] as {
      readonly input: { readonly bytes: Uint8Array };
    };
    source.fill(0);
    expect(Buffer.from(posted.input.bytes).toString("utf8")).toBe("chunk");

    worker.message(
      success(1, "writePreparedChunk", {
        uploadId,
        prepareId,
        durableOffsetBytes: 5,
        replayed: false,
      }),
    );
    await expect(request).resolves.toMatchObject({ durableOffsetBytes: 5 });
    await shutdownGracefully(client, worker);
  });

  it("restores a read Uint8Array into an independent Buffer", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const source = new Uint8Array(Buffer.from("result"));
    const request = client.readObject({ sha256: sha256(source), totalBytes: source.byteLength });
    worker.message(success(1, "readObject", { bytes: source }));
    source.fill(0);
    const result = await request;
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString("utf8")).toBe("result");
    await shutdownGracefully(client, worker);
  });

  it("terminalizes same-length object bytes with the wrong digest", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const expected = Buffer.from("result");
    const read = client.readObject({
      sha256: sha256(expected),
      totalBytes: expected.byteLength,
    });
    worker.message(success(1, "readObject", { bytes: Buffer.from("resulu") }));
    await expect(read).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
  });

  it("allows out-of-order responses while requiring exact operation correlation", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const first = client.writePreparedChunk(chunkInput());
    const second = client.cleanupUpload({ uploadId });
    worker.message(
      success(2, "cleanupUpload", {
        stagingRemoved: false,
        publicationTemporariesRemoved: 0,
      }),
    );
    worker.message(
      success(1, "writePreparedChunk", {
        uploadId,
        prepareId,
        durableOffsetBytes: 5,
        replayed: false,
      }),
    );
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await shutdownGracefully(client, worker);
  });

  it("bounds pending work while preserving the dedicated shutdown request slot", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const accepted = Array.from({ length: 15 }, () => client.cleanupUpload({ uploadId }));
    await expect(client.cleanupUpload({ uploadId })).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_BUSY",
      retryable: true,
    });
    expect(worker.posted).toHaveLength(15);
    for (let id = 1; id <= 15; id += 1) {
      worker.message(
        success(id, "cleanupUpload", {
          stagingRemoved: false,
          publicationTemporariesRemoved: 0,
        }),
      );
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(15);
    await shutdownGracefully(client, worker);
    expect((worker.posted.at(-1) as { readonly id: number }).id).toBe(16);
  });

  it("terminalizes unknown correlation and rejects all pending with one cause", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const first = client.writePreparedChunk(chunkInput());
    const second = client.cleanupUpload({ uploadId });
    worker.message(
      success(99, "cleanupUpload", {
        stagingRemoved: false,
        publicationTemporariesRemoved: 0,
      }),
    );
    const settled = await Promise.allSettled([first, second]);
    expect(settled[0]?.status).toBe("rejected");
    expect(settled[1]?.status).toBe("rejected");
    expect((settled[0] as PromiseRejectedResult).reason).toBe(
      (settled[1] as PromiseRejectedResult).reason,
    );
    expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
    expect(worker.posted).toHaveLength(2);
  });

  it("terminalizes a same-operation response whose artifact identity does not match", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const chunk = client.writePreparedChunk(chunkInput());
    worker.message(
      success(1, "writePreparedChunk", {
        uploadId: secondUploadId,
        prepareId,
        durableOffsetBytes: 5,
        replayed: false,
      }),
    );
    await expect(chunk).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
    expect(worker.posted).toHaveLength(1);
  });

  it("terminalizes all pending requests on one absolute timeout without retry", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(
      worker,
      clientOptions({ requestTimeoutMilliseconds: 5, exitTimeoutMilliseconds: 100 }),
    );
    const first = client.writePreparedChunk(chunkInput());
    const second = client.cleanupUpload({ uploadId });
    const settled = await Promise.allSettled([first, second]);
    expect(settled.every((entry) => entry.status === "rejected")).toBe(true);
    expect((settled[0] as PromiseRejectedResult).reason).toBe(
      (settled[1] as PromiseRejectedResult).reason,
    );
    expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
      ownerExit: client.ownerExit,
    });
    expect(worker.terminateCalls).toBe(1);
    await client.joinExit();
    expect(worker.posted).toHaveLength(2);
  });

  it("enforces the request deadline across synchronous validation before postMessage", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker, clientOptions({ requestTimeoutMilliseconds: 1 }));
    const input = chunkInput();
    const digest = input.chunkSha256;
    Object.defineProperty(input, "chunkSha256", {
      enumerable: true,
      get() {
        blockFor(5);
        return digest;
      },
    });
    await expect(client.writePreparedChunk(input)).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
    });
    expect(worker.posted).toHaveLength(0);
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
  });

  it("rechecks client state after an input getter starts shutdown", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const input = chunkInput();
    const digest = input.chunkSha256;
    let closing: Promise<void> | undefined;
    Object.defineProperty(input, "chunkSha256", {
      enumerable: true,
      get() {
        closing ??= client.close();
        return digest;
      },
    });

    await expect(client.writePreparedChunk(input)).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLOSED",
    });
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ id: 1, operation: "shutdown" });
    worker.message(success(1, "shutdown", { closed: true }));
    worker.emit("exit", 0);
    if (closing === undefined) {
      throw new Error("The reentrant shutdown was not started.");
    }
    await expect(closing).resolves.toBeUndefined();
  });

  it("returns the terminal cause created reentrantly by an input getter", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const input = chunkInput();
    const digest = input.chunkSha256;
    Object.defineProperty(input, "chunkSha256", {
      enumerable: true,
      get() {
        worker.message({
          type: "fatal",
          protocolVersion: artifactStorageProtocolVersion,
          error: {
            code: "ARTIFACT_STORAGE_INTERNAL",
            message: "Artifact storage failed internally.",
            retryable: false,
          },
        });
        return digest;
      },
    });

    const write = client.writePreparedChunk(input);
    const settled = await Promise.allSettled([write, client.cleanupUpload({ uploadId })]);
    expect((settled[0] as PromiseRejectedResult).reason).toBe(
      (settled[1] as PromiseRejectedResult).reason,
    );
    expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "ARTIFACT_STORAGE_INTERNAL",
      retryable: false,
    });
    expect(worker.posted).toHaveLength(0);
    await client.ownerExit;
  });

  it("bounds recursive normalization with admission reservations", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const input = chunkInput();
    const digest = input.chunkSha256;
    const nested: Promise<unknown>[] = [];
    let getterCalls = 0;
    Object.defineProperty(input, "chunkSha256", {
      enumerable: true,
      get() {
        getterCalls += 1;
        nested.push(client.writePreparedChunk(input));
        return digest;
      },
    });

    const outer = client.writePreparedChunk(input);
    expect(getterCalls).toBe(15);
    expect(worker.posted).toHaveLength(15);
    for (let id = 1; id <= 15; id += 1) {
      worker.message(
        success(id, "writePreparedChunk", {
          uploadId,
          prepareId,
          durableOffsetBytes: 5,
          replayed: false,
        }),
      );
    }
    const settled = await Promise.allSettled([outer, ...nested]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(15);
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "ARTIFACT_STORAGE_CLIENT_BUSY" });
    await shutdownGracefully(client, worker);
  });

  it("releases the admission reservation when input normalization fails", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    await expect(
      client.writePreparedChunk({ ...chunkInput(), chunkSha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "ARTIFACT_STORAGE_INVALID_REQUEST" });

    const accepted = Array.from({ length: 15 }, () => client.cleanupUpload({ uploadId }));
    expect(worker.posted).toHaveLength(15);
    for (let id = 1; id <= 15; id += 1) {
      worker.message(
        success(id, "cleanupUpload", {
          stagingRemoved: false,
          publicationTemporariesRemoved: 0,
        }),
      );
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(15);
    await shutdownGracefully(client, worker);
  });

  it("rejects shutdown acknowledgement during active input normalization", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    let closing: Promise<void> | undefined;
    worker.onPost = (untrustedMessage) => {
      const message = untrustedMessage as { readonly id: number; readonly operation: string };
      if (message.operation === "shutdown") {
        worker.message(success(message.id, "shutdown", { closed: true }));
        worker.emit("exit", 0);
      }
    };
    const input = chunkInput();
    const digest = input.chunkSha256;
    Object.defineProperty(input, "chunkSha256", {
      enumerable: true,
      get() {
        closing ??= client.close();
        return digest;
      },
    });

    const write = client.writePreparedChunk(input);
    if (closing === undefined) {
      throw new Error("The reentrant shutdown was not started.");
    }
    const settled = await Promise.allSettled([write, closing]);
    expect((settled[0] as PromiseRejectedResult).reason).toBe(
      (settled[1] as PromiseRejectedResult).reason,
    );
    expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
  });

  it("preserves its admission slot while an input getter queues recursive work", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const input = chunkInput();
    const digest = input.chunkSha256;
    let recursive: Promise<unknown>[] | undefined;
    Object.defineProperty(input, "chunkSha256", {
      enumerable: true,
      get() {
        recursive = Array.from({ length: 15 }, () => client.cleanupUpload({ uploadId }));
        return digest;
      },
    });

    const outer = client.writePreparedChunk(input);
    expect(worker.posted).toHaveLength(15);
    for (let id = 1; id <= 14; id += 1) {
      worker.message(
        success(id, "cleanupUpload", {
          stagingRemoved: false,
          publicationTemporariesRemoved: 0,
        }),
      );
    }
    worker.message(
      success(15, "writePreparedChunk", {
        uploadId,
        prepareId,
        durableOffsetBytes: 5,
        replayed: false,
      }),
    );
    if (recursive === undefined) {
      throw new Error("The recursive requests were not started.");
    }
    await expect(outer).resolves.toMatchObject({ durableOffsetBytes: 5 });
    const recursiveResults = await Promise.allSettled(recursive);
    expect(recursiveResults.filter((entry) => entry.status === "fulfilled")).toHaveLength(14);
    const rejected = recursiveResults.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_BUSY",
      retryable: true,
    });
    await shutdownGracefully(client, worker);
  });

  it("rechecks the reserved shutdown ID after a reentrant request consumes one", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker, clientOptions(), 2_147_483_646);
    const input = chunkInput();
    const digest = input.chunkSha256;
    let recursive: Promise<unknown> | undefined;
    Object.defineProperty(input, "chunkSha256", {
      enumerable: true,
      get() {
        recursive ??= client.cleanupUpload({ uploadId });
        return digest;
      },
    });

    await expect(client.writePreparedChunk(input)).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_REQUEST_ID_EXHAUSTED",
    });
    expect(worker.posted).toHaveLength(1);
    worker.message(
      success(2_147_483_646, "cleanupUpload", {
        stagingRemoved: false,
        publicationTemporariesRemoved: 0,
      }),
    );
    if (recursive === undefined) {
      throw new Error("The recursive request was not started.");
    }
    await expect(recursive).resolves.toMatchObject({ stagingRemoved: false });
    const closing = client.close();
    worker.message(success(2_147_483_647, "shutdown", { closed: true }));
    worker.emit("exit", 0);
    await expect(closing).resolves.toBeUndefined();
  });

  it("checks the absolute deadline again after successful response validation", async () => {
    let validating = false;
    let validationChecks = 0;
    const now = (): number => {
      if (!validating) {
        return 0;
      }
      validationChecks += 1;
      return validationChecks === 1 ? 999 : 1_000;
    };
    const worker = new FakeArtifactWorker();
    const connecting = attachArtifactStorageClientForTest(
      clientOptions({ requestTimeoutMilliseconds: 1_000 }),
      worker as unknown as ArtifactStorageWorkerTransport,
      1,
      now,
    );
    worker.ready();
    const client = await connecting;
    const bytes = Buffer.from("result");
    const read = client.readObject({ sha256: sha256(bytes), totalBytes: bytes.byteLength });

    validating = true;
    worker.message(success(1, "readObject", { bytes }));
    await expect(read).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
    });
    expect(validationChecks).toBe(2);
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
  });

  it("terminalizes synchronous postMessage failure without leaking pending work", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    worker.throwOnPost = true;
    await expect(client.cleanupUpload({ uploadId })).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_TERMINAL",
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
    expect(worker.posted).toHaveLength(0);
  });

  it("keeps capacity rejection nonterminal and canonical", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const capacity = client.evaluateCapacity({
      request: { expectedTotalBytes: 1 },
      accounting: {
        accountingCertain: true,
        liveUploadCount: 0,
        liveUploadExpectedByteSizeBuckets: [],
        cleanupBacklogEntries: 0,
      },
    });
    worker.message({
      type: "response",
      protocolVersion: artifactStorageProtocolVersion,
      id: 1,
      operation: "evaluateCapacity",
      ok: false,
      error: {
        code: "ARTIFACT_STORAGE_CAPACITY",
        message: "Artifact storage capacity is unavailable.",
        retryable: true,
      },
    });
    await expect(capacity).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CAPACITY",
      retryable: true,
    });
    const cleanup = client.cleanupUpload({ uploadId });
    worker.message(
      success(2, "cleanupUpload", {
        stagingRemoved: false,
        publicationTemporariesRemoved: 0,
      }),
    );
    await expect(cleanup).resolves.toMatchObject({ stagingRemoved: false });
    expect(worker.terminateCalls).toBe(0);
    await shutdownGracefully(client, worker);
  });

  it("snapshots database capacity accounting before posting it", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const request = { expectedTotalBytes: 1_000 };
    const bucket = { expectedTotalBytes: 1_000, uploadCount: 1 };
    const accounting = {
      accountingCertain: true,
      liveUploadCount: 1,
      liveUploadExpectedByteSizeBuckets: [bucket],
      cleanupBacklogEntries: 0,
    };
    const capacity = client.evaluateCapacity({ request, accounting });
    request.expectedTotalBytes = 0;
    bucket.expectedTotalBytes = 0;
    bucket.uploadCount = 999;
    accounting.liveUploadCount = 0;
    accounting.liveUploadExpectedByteSizeBuckets.length = 0;

    const posted = worker.posted[0] as {
      readonly input: {
        readonly request: { readonly expectedTotalBytes: number };
        readonly accounting: {
          readonly liveUploadCount: number;
          readonly liveUploadExpectedByteSizeBuckets: readonly {
            readonly expectedTotalBytes: number;
            readonly uploadCount: number;
          }[];
        };
      };
    };
    expect(posted.input.request.expectedTotalBytes).toBe(1_000);
    expect(posted.input.accounting.liveUploadCount).toBe(1);
    expect(posted.input.accounting.liveUploadExpectedByteSizeBuckets).toEqual([
      { expectedTotalBytes: 1_000, uploadCount: 1 },
    ]);
    worker.message(
      success(1, "evaluateCapacity", {
        requiredBytes: 6_096n,
        requiredEntries: 4,
        physicalAllocatedBytes: 0n,
        physicalEntries: 0,
        outstandingReservationBytes: 6_096n,
        outstandingReservationEntries: 4,
        filesystemAvailableBytes: 1_000_000n,
        filesystemAvailableAfterReservationsBytes: 993_904n,
        filesystemAllocationUnitBytes: 1n,
        projectedChargedBytes: 12_192n,
        projectedChargedEntries: 8,
      }),
    );
    await expect(capacity).resolves.toMatchObject({
      requiredBytes: 6_096n,
      outstandingReservationBytes: 6_096n,
    });
    await shutdownGracefully(client, worker);
  });

  it("terminalizes a capacity response that is not bound to the original request", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const capacity = client.evaluateCapacity({
      request: { expectedTotalBytes: 1_000 },
      accounting: {
        accountingCertain: true,
        liveUploadCount: 0,
        liveUploadExpectedByteSizeBuckets: [],
        cleanupBacklogEntries: 0,
      },
    });
    worker.message(
      success(1, "evaluateCapacity", {
        requiredBytes: 1n,
        requiredEntries: 4,
        physicalAllocatedBytes: 0n,
        physicalEntries: 0,
        outstandingReservationBytes: 0n,
        outstandingReservationEntries: 0,
        filesystemAvailableBytes: 1_000_000n,
        filesystemAvailableAfterReservationsBytes: 1_000_000n,
        filesystemAllocationUnitBytes: 1n,
        projectedChargedBytes: 1n,
        projectedChargedEntries: 4,
      }),
    );
    await expect(capacity).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
  });

  it("keeps terminal no-space failures non-retryable for mutating operations", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const cleanup = client.cleanupUpload({ uploadId });
    worker.message({
      type: "fatal",
      protocolVersion: artifactStorageProtocolVersion,
      error: {
        code: "ARTIFACT_STORAGE_CAPACITY",
        message: "Artifact storage capacity is unavailable.",
        retryable: false,
      },
    });
    await expect(cleanup).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CAPACITY",
      retryable: false,
    });
    await expect(client.cleanupUpload({ uploadId })).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CAPACITY",
      retryable: false,
    });
    expect(worker.posted).toHaveLength(1);
    await client.ownerExit;
  });

  it("terminalizes fatal, duplicate ready, error, messageerror, and premature exit", async () => {
    for (const trigger of ["fatal", "ready", "error", "messageerror", "exit"] as const) {
      const worker = new FakeArtifactWorker();
      const client = await attach(worker);
      if (trigger === "fatal") {
        worker.message({
          type: "fatal",
          protocolVersion: artifactStorageProtocolVersion,
          error: {
            code: "ARTIFACT_STORAGE_INTEGRITY",
            message: "Artifact storage integrity validation failed.",
            retryable: false,
          },
        });
      } else if (trigger === "ready") {
        worker.ready();
      } else if (trigger === "error") {
        worker.emit("error", new Error("injected Worker error at /secret/path"));
      } else if (trigger === "messageerror") {
        worker.emit("messageerror", new Error("uncloneable"));
      } else {
        worker.emit("exit", 0);
      }
      await expect(client.cleanupUpload({ uploadId })).rejects.toBeInstanceOf(
        ArtifactStorageClientError,
      );
      if (trigger !== "exit") {
        expect(worker.terminateCalls).toBe(1);
        await client.ownerExit;
      }
    }
  });

  it("enforces startup timeout and exposes the owner exit promise on failure", async () => {
    const worker = new FakeArtifactWorker();
    let thrown: unknown;
    try {
      await attachArtifactStorageClientForTest(
        clientOptions({ startupTimeoutMilliseconds: 5, exitTimeoutMilliseconds: 100 }),
        worker as unknown as ArtifactStorageWorkerTransport,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "ARTIFACT_STORAGE_CLIENT_TIMEOUT" });
    expect(worker.terminateCalls).toBe(1);
    await (thrown as ArtifactStorageClientError).ownerExit;
  });

  it("includes synchronous configuration snapshot work in the startup deadline", async () => {
    const worker = new FakeArtifactWorker();
    const options = clientOptions({ startupTimeoutMilliseconds: 1 });
    Object.defineProperty(options.storage.capacity, "hardBytes", {
      enumerable: true,
      get() {
        blockFor(5);
        return 100_000_000n;
      },
    });
    const connecting = attachArtifactStorageClientForTest(
      options,
      worker as unknown as ArtifactStorageWorkerTransport,
    );
    worker.ready();
    await expect(connecting).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
    });
    expect(worker.terminateCalls).toBe(1);
    await (await connecting.catch((error: ArtifactStorageClientError) => error)).ownerExit;
  });

  it("does not expose a raw termination failure", async () => {
    const worker = new FakeArtifactWorker();
    worker.autoExitOnTerminate = false;
    worker.terminateError = new Error("injected terminate failure at /secret/path");
    const client = await attach(worker);
    worker.message({
      type: "fatal",
      protocolVersion: artifactStorageProtocolVersion,
      error: {
        code: "ARTIFACT_STORAGE_INTERNAL",
        message: "Artifact storage failed internally.",
        retryable: false,
      },
    });
    await expect(client.terminationAttempt).resolves.toBeUndefined();
    await expect(client.joinExit(5)).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
      message: "Artifact storage Worker exit join timed out.",
    });
  });

  it("closes once, rejects new work, and requires acknowledgement before exit", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const firstClose = client.close();
    const secondClose = client.close();
    expect(secondClose).toBe(firstClose);
    await expect(client.cleanupUpload({ uploadId })).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLOSED",
    });
    const shutdown = worker.posted[0] as { readonly id: number };
    worker.message(success(shutdown.id, "shutdown", { closed: true }));
    worker.emit("exit", 0);
    await expect(firstClose).resolves.toBeUndefined();
    expect(worker.terminateCalls).toBe(0);

    const premature = new FakeArtifactWorker();
    const secondClient = await attach(premature);
    const closing = secondClient.close();
    premature.emit("exit", 0);
    await expect(closing).rejects.toMatchObject({ code: "ARTIFACT_STORAGE_CLIENT_PROTOCOL" });
  });

  it("reserves the final bounded request ID for graceful shutdown", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker, clientOptions(), 2_147_483_647);
    await expect(client.cleanupUpload({ uploadId })).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_REQUEST_ID_EXHAUSTED",
    });
    expect(worker.posted).toHaveLength(0);
    const closing = client.close();
    expect(worker.posted[0]).toMatchObject({
      id: 2_147_483_647,
      operation: "shutdown",
    });
    worker.message(success(2_147_483_647, "shutdown", { closed: true }));
    worker.emit("exit", 0);
    await expect(closing).resolves.toBeUndefined();
  });

  it("terminalizes a shutdown that exceeds its absolute deadline", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker, clientOptions({ shutdownTimeoutMilliseconds: 5 }));
    await expect(client.close()).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_TIMEOUT",
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
    expect(worker.posted).toHaveLength(1);
  });

  it("rejects close immediately when fatal follows shutdown acknowledgement", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const closing = client.close();
    worker.message(success(1, "shutdown", { closed: true }));
    worker.message({
      type: "fatal",
      protocolVersion: artifactStorageProtocolVersion,
      error: {
        code: "ARTIFACT_STORAGE_INTERNAL",
        message: "Artifact storage failed internally.",
        retryable: false,
      },
    });
    await expect(closing).rejects.toMatchObject({
      code: "ARTIFACT_STORAGE_INTERNAL",
      retryable: false,
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
  });

  it("rejects forged early shutdown acknowledgement and exit with work pending", async () => {
    const worker = new FakeArtifactWorker();
    const client = await attach(worker);
    const work = client.cleanupUpload({ uploadId });
    const closing = client.close();
    expect(worker.posted).toHaveLength(2);

    worker.message(success(2, "shutdown", { closed: true }));
    worker.emit("exit", 0);
    const settled = await Promise.allSettled([work, closing]);
    expect(settled.every((entry) => entry.status === "rejected")).toBe(true);
    expect((settled[0] as PromiseRejectedResult).reason).toBe(
      (settled[1] as PromiseRejectedResult).reason,
    );
    expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "ARTIFACT_STORAGE_CLIENT_PROTOCOL",
    });
    expect(worker.terminateCalls).toBe(1);
    await client.ownerExit;
  });
});
