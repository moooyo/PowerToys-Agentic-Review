import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as publicArtifacts from "../../dist/artifacts/index.js";
import { ArtifactStorageClient } from "../../dist/artifacts/index.js";

const temporaryDirectories: string[] = [];
const clients: ArtifactStorageClient[] = [];
const uploadId = "11111111-1111-4111-8111-111111111111";
const prepareId = "22222222-2222-4222-8222-222222222222";
const finalizationId = "33333333-3333-4333-8333-333333333333";

afterEach(async () => {
  await Promise.allSettled(
    clients.splice(0).map(async (client) => {
      try {
        await client.close();
      } catch {
        await client.terminationAttempt;
      }
      try {
        await client.joinExit(1_000);
      } catch {
        // The assertion that failed owns the more useful diagnostic.
      }
    }),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
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
    ]) {
      expect(publicArtifacts).not.toHaveProperty(internalName);
    }
  });
});

describe.skipIf(process.platform !== "linux")("ArtifactStorageClient Worker integration", () => {
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
});
