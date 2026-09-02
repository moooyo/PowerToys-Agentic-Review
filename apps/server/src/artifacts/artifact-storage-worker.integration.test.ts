import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ArtifactStorageWorkerTransport,
  createArtifactStorageClientWithFactoryForTest,
} from "../../dist/artifacts/artifact-storage-client.js";
import * as publicArtifacts from "../../dist/artifacts/index.js";
import { ArtifactStorageClient } from "../../dist/artifacts/index.js";
import { artifactStorageProtocolVersion } from "../../dist/artifacts/worker-protocol.js";

const temporaryDirectories: string[] = [];
const clients: ArtifactStorageClient[] = [];
const uploadId = "11111111-1111-4111-8111-111111111111";
const prepareId = "22222222-2222-4222-8222-222222222222";
const finalizationId = "33333333-3333-4333-8333-333333333333";

const readOpenFileDescriptorTargets = async (): Promise<readonly string[]> => {
  const entries = await readdir("/proc/self/fd");
  const targets = await Promise.all(
    entries.map(async (entry): Promise<string | undefined> => {
      try {
        return await readlink(join("/proc/self/fd", entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }),
  );
  return targets.filter((target): target is string => target !== undefined);
};

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  const clientResults = await Promise.allSettled(
    clients.splice(0).map(async (client) => {
      try {
        await client.close();
      } catch {
        await client.terminationAttempt;
      }
      await client.joinExit(2_000);
    }),
  );
  cleanupErrors.push(
    ...clientResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason),
  );
  if (cleanupErrors.length === 0) {
    const directoryResults = await Promise.allSettled(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
    cleanupErrors.push(
      ...directoryResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Artifact storage Worker integration cleanup failed.");
  }
});

describe("artifact storage public boundary", () => {
  it("exports only the asynchronous client surface", () => {
    expect(publicArtifacts).toHaveProperty("ArtifactStorageClient");
    expect(ArtifactStorageClient).not.toHaveProperty("attachForTesting");
    for (const internalName of [
      "ArtifactStorageKernel",
      "LinuxArtifactStorageOperations",
      "evaluateArtifactCapacity",
      "runArtifactStorageWorker",
      "runArtifactStorageProcess",
    ]) {
      expect(publicArtifacts).not.toHaveProperty(internalName);
    }
  });
});

describe.skipIf(process.platform !== "linux")("ArtifactStorageClient Worker integration", () => {
  it("scans and identity-cleans a staging entry through the Worker", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentic-review-artifact-namespace-worker-"));
    await chmod(parent, 0o700);
    temporaryDirectories.push(parent);
    const client = await ArtifactStorageClient.create({
      storage: {
        rootPath: join(parent, "storage"),
        capacity: {
          hardBytes: 100_000_000n,
          hardEntries: 1_000,
          emergencyReserveBytes: 10_000n,
          perUploadMetadataHeadroomBytes: 4_096n,
          cleanupBacklogHighWaterEntries: 100,
        },
        closeTimeoutMilliseconds: 5_000,
      },
      startupTimeoutMilliseconds: 5_000,
      requestTimeoutMilliseconds: 5_000,
      shutdownTimeoutMilliseconds: 5_000,
      exitTimeoutMilliseconds: 5_000,
    });
    clients.push(client);
    const bytes = Buffer.from("namespace-worker-owned");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await client.writePreparedChunk({
      uploadId,
      prepareId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkSha256: digest,
      bytes,
      receiptState: "prepared",
      committedOffsetBytes: 0,
      committedPrefix: [],
    });
    const page = await client.scanNamespacePage({
      scanSessionId: "80000000-0000-4000-8000-000000000001",
      sweepGeneration: 0,
      expectedAfterKey: null,
      maximumEntries: 8,
    });
    expect(page).toMatchObject({ completedSweep: true });
    expect(page.observations).toHaveLength(1);
    const observation = page.observations[0];
    if (observation === undefined) {
      throw new Error("Expected one namespace observation.");
    }
    await expect(client.cleanupNamespaceEntry(observation)).resolves.toMatchObject({
      outcome: "removed",
    });
    await expect(client.cleanupNamespaceEntry(observation)).resolves.toMatchObject({
      outcome: "already_absent",
    });
    await client.close();
    expect(await client.ownerExit).toBe(0);
  });

  it("owns the kernel for write, finalize, read, capacity, cleanup, and shutdown", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentic-review-artifact-worker-"));
    await chmod(parent, 0o700);
    temporaryDirectories.push(parent);

    const client = await ArtifactStorageClient.create({
      storage: {
        rootPath: join(parent, "storage"),
        capacity: {
          hardBytes: 100_000_000n,
          hardEntries: 1_000,
          emergencyReserveBytes: 10_000n,
          perUploadMetadataHeadroomBytes: 4_096n,
          cleanupBacklogHighWaterEntries: 100,
        },
        closeTimeoutMilliseconds: 5_000,
      },
      startupTimeoutMilliseconds: 5_000,
      requestTimeoutMilliseconds: 5_000,
      shutdownTimeoutMilliseconds: 5_000,
      exitTimeoutMilliseconds: 5_000,
    });
    clients.push(client);

    const bytes = Buffer.from('{"result":"worker-owned"}');
    const digest = createHash("sha256").update(bytes).digest("hex");
    await expect(
      client.evaluateCapacity({
        request: { expectedTotalBytes: bytes.byteLength },
        accounting: {
          accountingCertain: true,
          liveUploadCount: 0,
          liveUploadExpectedByteSizeBuckets: [],
          cleanupBacklogEntries: 0,
        },
      }),
    ).resolves.toMatchObject({ requiredEntries: 4 });

    await expect(
      client.writePreparedChunk({
        uploadId,
        prepareId,
        chunkIndex: 0,
        offsetBytes: 0,
        chunkSha256: digest,
        bytes,
        receiptState: "prepared",
        committedOffsetBytes: 0,
        committedPrefix: [],
      }),
    ).resolves.toMatchObject({ durableOffsetBytes: bytes.byteLength, replayed: false });
    const published = await client.finalizeArtifact({
      uploadId,
      finalizationId,
      totalBytes: bytes.byteLength,
      sha256: digest,
    });
    expect(published).toMatchObject({ sha256: digest, reused: false });
    await expect(
      client.readObject({ sha256: digest, totalBytes: bytes.byteLength }),
    ).resolves.toEqual(bytes);

    await expect(
      client.cleanupUpload({
        uploadId,
        publications: [{ finalizationId, totalBytes: bytes.byteLength, sha256: digest }],
      }),
    ).resolves.toMatchObject({ stagingRemoved: true });
    await expect(
      client.readObject({ sha256: digest, totalBytes: bytes.byteLength }),
    ).resolves.toEqual(bytes);

    await client.close();
    expect(await client.ownerExit).toBe(0);
  });

  it("terminates an Atomics.wait-stalled Worker without claiming D-state coverage", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentic-review-artifact-worker-timeout-"));
    await chmod(parent, 0o700);
    temporaryDirectories.push(parent);
    const workerOwnedPath = join(parent, "worker-owned-descriptor");

    let actualWorkerExitObserved = false;
    const client = await createArtifactStorageClientWithFactoryForTest(
      {
        storage: {
          rootPath: join(parent, "storage"),
          capacity: {
            hardBytes: 100_000_000n,
            hardEntries: 1_000,
            emergencyReserveBytes: 10_000n,
            perUploadMetadataHeadroomBytes: 4_096n,
            cleanupBacklogHighWaterEntries: 100,
          },
          closeTimeoutMilliseconds: 5_000,
        },
        startupTimeoutMilliseconds: 2_000,
        requestTimeoutMilliseconds: 50,
        shutdownTimeoutMilliseconds: 500,
        exitTimeoutMilliseconds: 2_000,
      },
      (_filename, options) => {
        const worker = new Worker(
          `
            const { openSync } = require("node:fs");
            const { parentPort, workerData } = require("node:worker_threads");
            const workerOwnedDescriptor = openSync(workerData.workerOwnedPath, "w", 0o600);
            parentPort.postMessage({
              type: "ready",
              protocolVersion: ${artifactStorageProtocolVersion},
            });
            parentPort.on("message", () => {
              void workerOwnedDescriptor;
              const stall = new Int32Array(new SharedArrayBuffer(4));
              Atomics.wait(stall, 0, 0);
            });
          `,
          {
            eval: true,
            trackUnmanagedFds: options.trackUnmanagedFds,
            workerData: { ...options.workerData, workerOwnedPath },
          },
        );
        worker.on("exit", () => {
          actualWorkerExitObserved = true;
        });
        return worker as unknown as ArtifactStorageWorkerTransport;
      },
    );
    clients.push(client);
    expect(await readOpenFileDescriptorTargets()).toContain(workerOwnedPath);

    await expect(
      client.evaluateCapacity({
        request: { expectedTotalBytes: 1 },
        accounting: {
          accountingCertain: true,
          liveUploadCount: 0,
          liveUploadExpectedByteSizeBuckets: [],
          cleanupBacklogEntries: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_STORAGE_CLIENT_TIMEOUT" });
    await expect(client.terminationAttempt).resolves.toBeUndefined();
    await expect(client.joinExit(2_000)).resolves.toBe(1);
    expect(actualWorkerExitObserved).toBe(true);
    expect(await readOpenFileDescriptorTargets()).not.toContain(workerOwnedPath);
  });
});
