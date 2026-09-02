import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runArtifactStorageWorker } from "../../dist/artifacts/artifact-storage-worker.js";
import {
  ArtifactStorageCapacityError,
  ArtifactStorageIntegrityError,
} from "../../dist/artifacts/errors.js";
import type { PreparedArtifactChunk } from "../../dist/artifacts/types.js";
import {
  artifactStorageProtocolVersion,
  normalizeArtifactStorageOperationInput,
  parseArtifactStorageWorkerRequest,
  serializeArtifactStorageError,
} from "../../dist/artifacts/worker-protocol.js";

const uploadId = "11111111-1111-4111-8111-111111111111";
const secondUploadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prepareId = "22222222-2222-4222-8222-222222222222";

class FakeWorkerPort {
  readonly posted: unknown[] = [];
  readonly listeners = new Map<string, (value: unknown) => void>();
  readonly closed = Promise.withResolvers<void>();
  readonly postedWaiters = new Set<{ readonly count: number; readonly resolve: () => void }>();
  closeCalls = 0;
  postError: Error | undefined;

  postMessage(value: unknown): void {
    if (this.postError !== undefined) {
      throw this.postError;
    }
    this.posted.push(value);
    for (const waiter of [...this.postedWaiters]) {
      if (this.posted.length >= waiter.count) {
        this.postedWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "messageerror", listener: (error: Error) => void): this;
  on(
    event: "message" | "messageerror",
    listener: ((value: unknown) => void) | ((error: Error) => void),
  ): this {
    this.listeners.set(event, listener as (value: unknown) => void);
    return this;
  }

  close(): void {
    if (this.closeCalls > 0) {
      return;
    }
    this.closeCalls += 1;
    this.closed.resolve();
  }

  message(value: unknown): void {
    this.listeners.get("message")?.(value);
  }

  messageError(error: Error): void {
    this.listeners.get("messageerror")?.(error);
  }

  waitForPostedCount(count: number): Promise<void> {
    if (this.posted.length >= count) {
      return Promise.resolve();
    }
    const waiter = Promise.withResolvers<void>();
    this.postedWaiters.add({ count, resolve: waiter.resolve });
    return waiter.promise;
  }
}

class FakeWorkerKernel {
  readonly calls: { readonly operation: string; readonly input: unknown }[] = [];
  readonly active = new Set<Promise<unknown>>();
  chunkResult: Promise<unknown> | undefined;
  capacityResult: Promise<unknown> | undefined;
  capacityError: Error | undefined;
  cleanupError: Error | undefined;
  closeCalls = 0;

  writePreparedChunk(input: unknown): Promise<unknown> {
    this.calls.push({ operation: "writePreparedChunk", input });
    return this.#track(
      this.chunkResult ??
        Promise.resolve({
          uploadId,
          prepareId,
          durableOffsetBytes: 5,
          replayed: false,
        }),
    );
  }

  finalizeArtifact(input: unknown): Promise<never> {
    this.calls.push({ operation: "finalizeArtifact", input });
    return Promise.reject(new Error("not configured"));
  }

  readObject(input: unknown): Promise<Buffer> {
    this.calls.push({ operation: "readObject", input });
    return Promise.resolve(Buffer.from("result"));
  }

  cleanupUpload(input: unknown): Promise<unknown> {
    this.calls.push({ operation: "cleanupUpload", input });
    return this.cleanupError === undefined
      ? Promise.resolve({ stagingRemoved: false, publicationTemporariesRemoved: 0 })
      : Promise.reject(this.cleanupError);
  }

  scanNamespacePage(input: unknown): Promise<unknown> {
    this.calls.push({ operation: "scanNamespacePage", input });
    const scan = input as {
      readonly scanSessionId: string;
      readonly sweepGeneration: number;
      readonly expectedAfterKey: string | null;
    };
    return Promise.resolve({
      scanSessionId: scan.scanSessionId,
      sweepGeneration: scan.sweepGeneration,
      expectedAfterKey: scan.expectedAfterKey,
      observations: [],
      completedSweep: true,
      nextAfterKey: null,
    });
  }

  closeNamespaceScan(input: unknown): Promise<unknown> {
    this.calls.push({ operation: "closeNamespaceScan", input });
    return Promise.resolve({ ...(input as object), closed: true });
  }

  cleanupNamespaceEntry(input: unknown): Promise<unknown> {
    this.calls.push({ operation: "cleanupNamespaceEntry", input });
    const observation = input as { readonly entryKey: string; readonly observationSha256: string };
    return Promise.resolve({
      entryKey: observation.entryKey,
      observationSha256: observation.observationSha256,
      outcome: "identity_changed",
    });
  }

  evaluateCapacity(input: unknown): Promise<unknown> {
    this.calls.push({ operation: "evaluateCapacity", input });
    if (this.capacityResult !== undefined) {
      return this.capacityResult;
    }
    return Promise.reject(this.capacityError ?? new Error("capacity result not configured"));
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    await Promise.allSettled([...this.active]);
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise.then(
      () => this.active.delete(promise),
      () => this.active.delete(promise),
    );
    return promise;
  }
}

const workerData = {
  protocolVersion: artifactStorageProtocolVersion,
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
};

const startWorker = (port: FakeWorkerPort, kernel: FakeWorkerKernel): void => {
  runArtifactStorageWorker(port, workerData, () => kernel as never);
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const chunkInput = (bytes = Buffer.from("chunk")): PreparedArtifactChunk => ({
  uploadId,
  prepareId,
  chunkIndex: 0,
  offsetBytes: 0,
  chunkSha256: sha256(bytes),
  bytes,
  receiptState: "prepared",
  committedOffsetBytes: 0,
  committedPrefix: [],
});

const request = (id: number, operation: string, input: unknown, extra = {}) => ({
  type: "request",
  protocolVersion: artifactStorageProtocolVersion,
  id,
  operation,
  input,
  ...extra,
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

describe("artifact storage Worker protocol", () => {
  it("copies chunk views at both normalization boundaries", () => {
    const source = Buffer.from("chunk");
    const first = normalizeArtifactStorageOperationInput("writePreparedChunk", chunkInput(source));
    source.fill(0);
    expect(Buffer.from(first.bytes).toString("utf8")).toBe("chunk");
    const second = normalizeArtifactStorageOperationInput("writePreparedChunk", first);
    first.bytes.fill(0);
    expect(Buffer.from(second.bytes).toString("utf8")).toBe("chunk");
  });

  it("rejects forged envelopes and unknown properties", () => {
    expect(() =>
      parseArtifactStorageWorkerRequest(
        request(1, "cleanupUpload", { uploadId }, { forged: true }),
      ),
    ).toThrow(/unsupported or missing fields/u);
    expect(() =>
      parseArtifactStorageWorkerRequest({
        ...request(1, "cleanupUpload", { uploadId }),
        protocolVersion: 99,
      }),
    ).toThrow(/envelope/u);
    expect(() =>
      parseArtifactStorageWorkerRequest(request(2_147_483_648, "cleanupUpload", { uploadId })),
    ).toThrow(/bounded safe integer/u);
    expect(() =>
      parseArtifactStorageWorkerRequest(request(2_147_483_647, "cleanupUpload", { uploadId })),
    ).toThrow(/reserved for shutdown/u);
    expect(parseArtifactStorageWorkerRequest(request(2_147_483_647, "shutdown", {}))).toMatchObject(
      { id: 2_147_483_647, operation: "shutdown" },
    );
  });

  it("serializes only canonical allowlisted errors without paths", () => {
    const integrity = serializeArtifactStorageError(
      new ArtifactStorageIntegrityError("failed at /secret/artifacts/object"),
    );
    expect(integrity).toEqual({
      code: "ARTIFACT_STORAGE_INTEGRITY",
      message: "Artifact storage integrity validation failed.",
      retryable: false,
    });
    expect(JSON.stringify(integrity)).not.toContain("/secret");
    expect(serializeArtifactStorageError(new Error("token=secret /root"))).toMatchObject({
      code: "ARTIFACT_STORAGE_INTERNAL",
      message: "Artifact storage failed internally.",
    });
  });
});

describe("runArtifactStorageWorker", () => {
  it("accepts initialization only through Worker data", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    startWorker(port, kernel);
    expect(port.posted).toEqual([
      { type: "ready", protocolVersion: artifactStorageProtocolVersion },
    ]);

    port.message(workerData);
    await flush();
    expect(port.posted[1]).toMatchObject({
      type: "fatal",
      error: { code: "ARTIFACT_STORAGE_INVALID_REQUEST" },
    });
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it("dispatches a bounded namespace scan without accepting caller paths", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    startWorker(port, kernel);
    const scanSessionId = "80000000-0000-4000-8000-000000000001";
    port.message(
      request(1, "scanNamespacePage", {
        scanSessionId,
        sweepGeneration: 0,
        expectedAfterKey: null,
        maximumEntries: 8,
      }),
    );
    await flush();
    expect(kernel.calls).toContainEqual({
      operation: "scanNamespacePage",
      input: { scanSessionId, sweepGeneration: 0, expectedAfterKey: null, maximumEntries: 8 },
    });
    expect(port.posted).toContainEqual(
      expect.objectContaining({
        type: "response",
        operation: "scanNamespacePage",
        ok: true,
        output: expect.objectContaining({ completedSweep: true, observations: [] }),
      }),
    );

    port.message(
      request(2, "closeNamespaceScan", {
        scanSessionId,
        sweepGeneration: 0,
        expectedAfterKey: null,
      }),
    );
    await flush();
    expect(kernel.calls).toContainEqual({
      operation: "closeNamespaceScan",
      input: { scanSessionId, sweepGeneration: 0, expectedAfterKey: null },
    });

    port.message(
      request(3, "scanNamespacePage", {
        scanSessionId: "80000000-0000-4000-8000-000000000002",
        sweepGeneration: 0,
        expectedAfterKey: null,
        maximumEntries: 8,
        path: "/tmp/forged",
      }),
    );
    await port.closed.promise;
    expect(port.posted.at(-1)).toMatchObject({ type: "fatal" });
    expect(kernel.closeCalls).toBe(1);
  });

  it("fails closed when a request cannot be cloned", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    startWorker(port, kernel);
    port.messageError(new Error("injected clone failure"));
    await port.closed.promise;
    expect(port.posted.at(-1)).toMatchObject({
      type: "fatal",
      error: { code: "ARTIFACT_STORAGE_INVALID_REQUEST" },
    });
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it("fails closed when the shutdown acknowledgement cannot be posted", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    startWorker(port, kernel);
    port.postError = new Error("injected shutdown post failure");
    port.message(request(1, "shutdown", {}));
    await port.closed.promise;
    expect(port.posted).toEqual([
      { type: "ready", protocolVersion: artifactStorageProtocolVersion },
    ]);
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it("becomes ready only after creating the kernel and revalidates copied bytes", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    startWorker(port, kernel);
    expect(port.posted[0]).toEqual({
      type: "ready",
      protocolVersion: artifactStorageProtocolVersion,
    });
    const source = Buffer.from("chunk");
    port.message(request(1, "writePreparedChunk", chunkInput(source)));
    source.fill(0);
    const accepted = kernel.calls[0]?.input as PreparedArtifactChunk;
    expect(Buffer.from(accepted.bytes).toString("utf8")).toBe("chunk");
    await flush();
    expect(port.posted).toContainEqual(
      expect.objectContaining({ type: "response", id: 1, ok: true }),
    );
  });

  it("rejects a kernel result whose identity does not match the request", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    kernel.chunkResult = Promise.resolve({
      uploadId: secondUploadId,
      prepareId,
      durableOffsetBytes: 5,
      replayed: false,
    });
    startWorker(port, kernel);
    port.message(request(1, "writePreparedChunk", chunkInput()));
    await port.closed.promise;
    expect(port.posted[1]).toMatchObject({
      type: "fatal",
      error: { code: "ARTIFACT_STORAGE_INVALID_REQUEST" },
    });
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it("treats forged or nonconsecutive requests as fatal", async () => {
    for (const forged of [
      request(2, "cleanupUpload", { uploadId }),
      request(1, "cleanupUpload", { uploadId }, { forged: true }),
    ]) {
      const port = new FakeWorkerPort();
      const kernel = new FakeWorkerKernel();
      startWorker(port, kernel);
      port.message(forged);
      await flush();
      expect(port.posted[1]).toMatchObject({
        type: "fatal",
        error: { code: "ARTIFACT_STORAGE_INVALID_REQUEST" },
      });
      expect(kernel.closeCalls).toBe(1);
      expect(port.closeCalls).toBe(1);
    }
  });

  it("drains accepted work before acknowledging shutdown", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    const deferred = Promise.withResolvers<unknown>();
    kernel.chunkResult = deferred.promise;
    startWorker(port, kernel);

    port.message(request(1, "writePreparedChunk", chunkInput()));
    port.message(request(2, "shutdown", {}));
    await flush();
    expect(port.posted).toHaveLength(1);
    expect(port.closeCalls).toBe(0);

    deferred.resolve({
      uploadId,
      prepareId,
      durableOffsetBytes: 5,
      replayed: false,
    });
    await port.closed.promise;
    expect(port.posted.slice(1)).toEqual([
      expect.objectContaining({
        type: "response",
        id: 1,
        operation: "writePreparedChunk",
        ok: true,
      }),
      expect.objectContaining({
        type: "response",
        id: 2,
        operation: "shutdown",
        ok: true,
      }),
    ]);
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it("returns capacity rejection without terminating the Worker", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    kernel.capacityError = new ArtifactStorageCapacityError("injected /secret capacity");
    startWorker(port, kernel);

    port.message(
      request(1, "evaluateCapacity", {
        request: { expectedTotalBytes: 5 },
        accounting: {
          accountingCertain: true,
          liveUploadCount: 0,
          liveUploadExpectedByteSizeBuckets: [],
          cleanupBacklogEntries: 0,
        },
      }),
    );
    await port.waitForPostedCount(2);
    expect(port.posted[1]).toEqual({
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
    expect(port.closeCalls).toBe(0);

    port.message(request(2, "cleanupUpload", { uploadId }));
    await port.waitForPostedCount(3);
    expect(port.posted[2]).toMatchObject({
      type: "response",
      id: 2,
      operation: "cleanupUpload",
      ok: true,
    });
    expect(port.closeCalls).toBe(0);
  });

  it("rejects internally consistent capacity output for a different request", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    kernel.capacityResult = Promise.resolve({
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
    });
    startWorker(port, kernel);
    port.message(
      request(1, "evaluateCapacity", {
        request: { expectedTotalBytes: 1_000 },
        accounting: {
          accountingCertain: true,
          liveUploadCount: 0,
          liveUploadExpectedByteSizeBuckets: [],
          cleanupBacklogEntries: 0,
        },
      }),
    );
    await port.closed.promise;
    expect(port.posted[1]).toMatchObject({
      type: "fatal",
      error: { code: "ARTIFACT_STORAGE_INVALID_REQUEST", retryable: false },
    });
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it("terminalizes integrity failures with a path-free canonical fatal error", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    kernel.cleanupError = new ArtifactStorageIntegrityError(
      "injected failure at /secret/artifacts/staging",
    );
    startWorker(port, kernel);

    port.message(request(1, "cleanupUpload", { uploadId }));
    await port.closed.promise;
    expect(port.posted[1]).toEqual({
      type: "fatal",
      protocolVersion: artifactStorageProtocolVersion,
      error: {
        code: "ARTIFACT_STORAGE_INTEGRITY",
        message: "Artifact storage integrity validation failed.",
        retryable: false,
      },
    });
    expect(JSON.stringify(port.posted[1])).not.toContain("/secret");
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it("marks no-space failure during a mutating operation as non-retryable", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    kernel.cleanupError = Object.assign(new Error("ENOSPC at /secret/path"), {
      code: "ENOSPC",
    });
    startWorker(port, kernel);
    port.message(request(1, "cleanupUpload", { uploadId }));
    await flush();
    expect(port.posted[1]).toEqual({
      type: "fatal",
      protocolVersion: artifactStorageProtocolVersion,
      error: {
        code: "ARTIFACT_STORAGE_CAPACITY",
        message: "Artifact storage capacity is unavailable.",
        retryable: false,
      },
    });
    expect(JSON.stringify(port.posted[1])).not.toContain("/secret");
  });

  it("rejects invalid startup data before constructing a kernel", async () => {
    const port = new FakeWorkerPort();
    let factoryCalls = 0;
    runArtifactStorageWorker(port, { ...workerData, protocolVersion: 99 }, () => {
      factoryCalls += 1;
      return new FakeWorkerKernel() as never;
    });
    await flush();
    expect(factoryCalls).toBe(0);
    expect(port.posted).toEqual([
      {
        type: "fatal",
        protocolVersion: artifactStorageProtocolVersion,
        error: {
          code: "ARTIFACT_STORAGE_INVALID_REQUEST",
          message: "Artifact storage request is invalid.",
          retryable: false,
        },
      },
    ]);
    expect(port.closeCalls).toBe(1);
  });

  it("closes a constructed kernel when the ready message cannot be posted", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    port.postError = new Error("injected ready post failure at /secret/path");
    startWorker(port, kernel);
    await flush();
    expect(port.posted).toHaveLength(0);
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });

  it("treats a non-data request as fatal", async () => {
    const port = new FakeWorkerPort();
    const kernel = new FakeWorkerKernel();
    startWorker(port, kernel);
    port.message(new Date());
    await flush();
    expect(port.posted[1]).toMatchObject({
      type: "fatal",
      error: { code: "ARTIFACT_STORAGE_INVALID_REQUEST" },
    });
    expect(kernel.closeCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
  });
});
