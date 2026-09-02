import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ArtifactStorageProcessTransport,
  createArtifactStorageClientWithSpawnerForTest,
} from "../../dist/artifacts/artifact-storage-client.js";
import * as publicArtifacts from "../../dist/artifacts/index.js";
import { ArtifactStorageClient } from "../../dist/artifacts/index.js";

const temporaryDirectories: string[] = [];
const clients: ArtifactStorageClient[] = [];
const spawnedProcesses: ReturnType<typeof spawn>[] = [];
const uploadId = "11111111-1111-4111-8111-111111111111";
const prepareId = "22222222-2222-4222-8222-222222222222";
const finalizationId = "33333333-3333-4333-8333-333333333333";

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
  const processResults = await Promise.allSettled(
    spawnedProcesses.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      try {
        child.kill("SIGKILL");
      } catch {
        // The bounded wait below is the only cleanup proof available to this test process.
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Artifact storage test child did not exit after SIGKILL.")),
              2_000,
            );
            timer.unref();
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }),
  );
  cleanupErrors.push(
    ...processResults
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
    throw new AggregateError(cleanupErrors, "Artifact storage process integration cleanup failed.");
  }
});

const waitForStoppedProcess = async (processId: number): Promise<void> => {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const status = await readFile(`/proc/${processId}/status`, "utf8");
    if (/^State:\s+[Tt]\s/mu.test(status)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Artifact storage child process did not enter a stopped state.");
};

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

describe.skipIf(process.platform !== "linux")("ArtifactStorageClient process integration", () => {
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

    const bytes = Buffer.from('{"result":"process-owned"}');
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

  it("SIGKILLs a stopped owner once and waits for real process-exit proof", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentic-review-artifact-process-hang-"));
    await chmod(parent, 0o700);
    temporaryDirectories.push(parent);
    let child: ReturnType<typeof spawn> | undefined;
    let killCalls = 0;

    const client = await createArtifactStorageClientWithSpawnerForTest(
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
        startupTimeoutMilliseconds: 5_000,
        requestTimeoutMilliseconds: 250,
        shutdownTimeoutMilliseconds: 500,
        exitTimeoutMilliseconds: 2_000,
      },
      (executable, args, options) => {
        const spawned = spawn(executable, [...args], options);
        child = spawned;
        spawnedProcesses.push(spawned);
        const originalKill = spawned.kill.bind(spawned);
        spawned.kill = (signal) => {
          killCalls += 1;
          return originalKill(signal);
        };
        return spawned as unknown as ArtifactStorageProcessTransport;
      },
    );
    clients.push(client);
    if (child?.pid === undefined) {
      throw new Error("Artifact storage child process has no PID.");
    }
    expect(child.pid).not.toBe(process.pid);

    process.kill(child.pid, "SIGSTOP");
    await waitForStoppedProcess(child.pid);
    const startedAt = performance.now();
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
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(200);
    await expect(client.terminationAttempt).resolves.toBeUndefined();
    expect(killCalls).toBe(1);
    await expect(client.joinExit(2_000)).resolves.toBe(1);
    expect(child.signalCode).toBe("SIGKILL");
    expect(killCalls).toBe(1);
  });
});
