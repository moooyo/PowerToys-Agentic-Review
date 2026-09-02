import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ArtifactNamespaceObservation,
  calculateArtifactNamespaceObservationSha256,
} from "../../dist/artifacts/artifact-namespace-contract.js";
import { ArtifactStorageKernel } from "../../dist/artifacts/artifact-storage.js";
import { ArtifactStorageIntegrityError } from "../../dist/artifacts/errors.js";
import {
  isSupportedArtifactFilesystemType,
  LinuxArtifactStorageOperations,
  synchronizeArtifactDirectoryChain,
} from "../../dist/artifacts/linux-filesystem.js";
import type { ArtifactStorageDirectoryBinding } from "../../dist/artifacts/types.js";

const uploadId = "11111111-1111-4111-8111-111111111111";
const secondUploadId = "44444444-4444-4444-8444-444444444444";
const prepareId = "22222222-2222-4222-8222-222222222222";
const finalizationId = "33333333-3333-4333-8333-333333333333";
const secondFinalizationId = "55555555-5555-4555-8555-555555555555";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("artifact filesystem policy", () => {
  it("allows only the explicitly supported local persistent filesystem types", () => {
    expect(isSupportedArtifactFilesystemType(0x0000_ef53n)).toBe(true);
    expect(isSupportedArtifactFilesystemType(0x5846_5342n)).toBe(true);
    for (const unsupported of [
      0x0102_1994n,
      0x6573_5546n,
      0x0000_517bn,
      0xff53_4d42n,
      0x9123_683en,
    ]) {
      expect(isSupportedArtifactFilesystemType(unsupported)).toBe(false);
    }
  });

  it("retries the complete ancestor durability chain after any synchronization failure", () => {
    const bindings = ["filesystem", "parent", "artifact"].map(
      (path, index): ArtifactStorageDirectoryBinding => ({
        path,
        identity: { device: 1n, inode: BigInt(index + 1) },
        device: 1n,
        mode: 0o700n,
        userId: 1n,
        privateDirectory: true,
      }),
    );
    const firstAttempt: string[] = [];
    expect(() =>
      synchronizeArtifactDirectoryChain(bindings, (binding) => {
        firstAttempt.push(binding.path);
        if (binding.path === "parent") {
          throw new Error("injected parent fsync failure");
        }
      }),
    ).toThrow(/parent fsync/u);
    expect(firstAttempt).toEqual(["artifact", "parent"]);

    const retry: string[] = [];
    synchronizeArtifactDirectoryChain(bindings, (binding) => retry.push(binding.path));
    expect(retry).toEqual(["artifact", "parent", "filesystem"]);
  });
});

describe.skipIf(process.platform !== "linux")("LinuxArtifactStorageOperations", () => {
  it("creates private bound namespaces and immutable content-addressed objects", async () => {
    const root = await createArtifactRootPath();
    const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
    const bytes = Buffer.from('{"result":"ok"}');
    const digest = sha256(bytes);

    for (const path of [
      root,
      join(root, "staging"),
      join(root, "objects"),
      join(root, "objects", "sha256"),
    ]) {
      const stats = await lstat(path);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o7777).toBe(0o700);
    }

    await kernel.writePreparedChunk({
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
    const stagingPath = join(root, "staging", `${uploadId}.upload`);
    const stagingStats = await lstat(stagingPath);
    expect(stagingStats.isFile()).toBe(true);
    expect(stagingStats.mode & 0o7777).toBe(0o600);
    expect(stagingStats.nlink).toBe(1);

    await expect(
      kernel.finalizeArtifact({
        uploadId,
        finalizationId,
        totalBytes: bytes.byteLength,
        sha256: digest,
      }),
    ).resolves.toMatchObject({
      storageObjectKey: `sha256/${digest.slice(0, 2)}/${digest}`,
      reused: false,
    });
    const objectPath = join(root, "objects", "sha256", digest.slice(0, 2), digest);
    const objectStats = await lstat(objectPath);
    expect(objectStats.isFile()).toBe(true);
    expect(objectStats.mode & 0o7777).toBe(0o600);
    expect(objectStats.nlink).toBe(1);
    await expect(readFile(objectPath)).resolves.toEqual(bytes);
    await expect(
      kernel.readObject({ sha256: digest, totalBytes: bytes.byteLength }),
    ).resolves.toEqual(bytes);
    await kernel.close();
  });

  it("rejects symlink, hard-linked, and permissive staging files", async () => {
    const root = await createArtifactRootPath();
    const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
    const bytes = Buffer.from("chunk");
    const target = join(dirname(root), "outside-target");
    const stagingPath = join(root, "staging", `${uploadId}.upload`);
    await writeFile(target, bytes, { mode: 0o600 });
    await symlink(target, stagingPath, "file");
    await expect(kernel.writePreparedChunk(chunk(bytes))).rejects.toBeInstanceOf(
      ArtifactStorageIntegrityError,
    );

    await rm(stagingPath);
    await link(target, stagingPath);
    await expect(kernel.writePreparedChunk(chunk(bytes))).rejects.toBeInstanceOf(
      ArtifactStorageIntegrityError,
    );

    await rm(stagingPath);
    await rm(target);
    await writeFile(stagingPath, bytes, { mode: 0o644 });
    await chmod(stagingPath, 0o644);
    await expect(kernel.writePreparedChunk(chunk(bytes))).rejects.toBeInstanceOf(
      ArtifactStorageIntegrityError,
    );
    await kernel.close();
  });

  it("detects managed-directory inode replacement after initialization", async () => {
    const root = await createArtifactRootPath();
    const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
    const staging = join(root, "staging");
    await rename(staging, join(dirname(root), "staging-displaced"));
    await mkdir(staging, { mode: 0o700 });

    await expect(kernel.writePreparedChunk(chunk(Buffer.from("chunk")))).rejects.toBeInstanceOf(
      ArtifactStorageIntegrityError,
    );
    await kernel.close();
  });

  it("resumes a matching partial staging range and rejects a changed prefix", async () => {
    const root = await createArtifactRootPath();
    const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
    const stagingPath = join(root, "staging", `${uploadId}.upload`);
    const bytes = Buffer.from("chunk");
    await writeFile(stagingPath, bytes.subarray(0, 2), { mode: 0o600 });
    await chmod(stagingPath, 0o600);
    await kernel.writePreparedChunk(chunk(bytes));
    await expect(readFile(stagingPath)).resolves.toEqual(bytes);

    await writeFile(stagingPath, Buffer.from("chunx"), { mode: 0o600 });
    await chmod(stagingPath, 0o600);
    await expect(
      kernel.writePreparedChunk({
        ...chunk(bytes),
        receiptState: "committed",
        committedOffsetBytes: bytes.byteLength,
        committedPrefix: [
          {
            chunkIndex: 0,
            offsetBytes: 0,
            chunkBytes: bytes.byteLength,
            chunkSha256: sha256(bytes),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await kernel.close();
  });

  it("never overwrites or trusts an existing corrupt CAS path or external hard link", async () => {
    const root = await createArtifactRootPath();
    const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
    const bytes = Buffer.from('{"good":1}');
    const corrupt = Buffer.from('{"evil":1}');
    const digest = sha256(bytes);
    await kernel.writePreparedChunk(chunk(bytes));

    const shard = join(root, "objects", "sha256", digest.slice(0, 2));
    await mkdir(shard, { mode: 0o700 });
    await chmod(shard, 0o700);
    const objectPath = join(shard, digest);
    await writeFile(objectPath, corrupt, { mode: 0o600 });
    await chmod(objectPath, 0o600);
    await expect(
      kernel.finalizeArtifact({
        uploadId,
        finalizationId,
        totalBytes: bytes.byteLength,
        sha256: digest,
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await expect(readFile(objectPath)).resolves.toEqual(corrupt);

    await rm(objectPath);
    await writeFile(objectPath, bytes, { mode: 0o600 });
    await chmod(objectPath, 0o600);
    await link(objectPath, join(dirname(root), "external-object-link"));
    await expect(
      kernel.readObject({ sha256: digest, totalBytes: bytes.byteLength }),
    ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
    await kernel.close();
  });

  it("rejects a symlinked managed namespace during initialization", async () => {
    const root = await createArtifactRootPath();
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o700);
    const target = join(dirname(root), "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(root, "staging"), "dir");
    expect(
      () => new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations()),
    ).toThrow(ArtifactStorageIntegrityError);
  });

  it("scans and identity-binds staging cleanup without deleting replacements", async () => {
    const root = await createArtifactRootPath();
    const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
    const stagingPath = join(root, "staging", `${uploadId}.upload`);
    await writeFile(stagingPath, Buffer.from("first"), { mode: 0o600 });
    await chmod(stagingPath, 0o600);
    const scanned = await kernel.scanNamespacePage({
      scanSessionId: "90000000-0000-4000-8000-000000000001",
      sweepGeneration: 0,
      expectedAfterKey: null,
      maximumEntries: 8,
    });
    expect(scanned).toMatchObject({ completedSweep: true, nextAfterKey: null });
    expect(scanned.observations).toHaveLength(1);
    const observation = scanned.observations[0] as ArtifactNamespaceObservation;

    await writeFile(stagingPath, Buffer.from("replacement"), { mode: 0o600 });
    await expect(kernel.cleanupNamespaceEntry(observation)).resolves.toMatchObject({
      outcome: "identity_changed",
    });
    await expect(readFile(stagingPath)).resolves.toEqual(Buffer.from("replacement"));

    const replacementScan = await kernel.scanNamespacePage({
      scanSessionId: "90000000-0000-4000-8000-000000000002",
      sweepGeneration: 1,
      expectedAfterKey: null,
      maximumEntries: 8,
    });
    const replacement = replacementScan.observations[0] as ArtifactNamespaceObservation;
    await expect(kernel.cleanupNamespaceEntry(replacement)).resolves.toMatchObject({
      outcome: "removed",
    });
    await expect(lstat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(kernel.cleanupNamespaceEntry(replacement)).resolves.toMatchObject({
      outcome: "already_absent",
    });
    await kernel.close();
  });

  it("revalidates root, objects, and sha256 namespace closure for every new scan", async () => {
    for (const location of ["root", "objects", "sha256"] as const) {
      const root = await createArtifactRootPath();
      const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
      const parent =
        location === "root"
          ? root
          : location === "objects"
            ? join(root, "objects")
            : join(root, "objects", "sha256");
      await writeFile(join(parent, "unexpected"), Buffer.from("unexpected"), { mode: 0o600 });
      await expect(
        kernel.scanNamespacePage({
          scanSessionId:
            location === "root"
              ? "90000000-0000-4000-8000-000000000004"
              : location === "objects"
                ? "90000000-0000-4000-8000-000000000005"
                : "90000000-0000-4000-8000-000000000006",
          sweepGeneration: 0,
          expectedAfterKey: null,
          maximumEntries: 8,
        }),
      ).rejects.toBeInstanceOf(ArtifactStorageIntegrityError);
      await kernel.close();
    }
  });

  it("refuses symlink, mode, link-count, and parent identity changes during cleanup", async () => {
    for (const mutation of ["symlink", "mode", "nlink", "parent"] as const) {
      const root = await createArtifactRootPath();
      const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
      const staging = join(root, "staging");
      const stagingPath = join(staging, `${uploadId}.upload`);
      await writeFile(stagingPath, Buffer.from("stable"), { mode: 0o600 });
      await chmod(stagingPath, 0o600);
      const page = await kernel.scanNamespacePage({
        scanSessionId:
          mutation === "symlink"
            ? "90000000-0000-4000-8000-000000000010"
            : mutation === "mode"
              ? "90000000-0000-4000-8000-000000000011"
              : mutation === "nlink"
                ? "90000000-0000-4000-8000-000000000012"
                : "90000000-0000-4000-8000-000000000013",
        sweepGeneration: 0,
        expectedAfterKey: null,
        maximumEntries: 8,
      });
      const observation = page.observations[0] as ArtifactNamespaceObservation;
      if (mutation === "symlink") {
        const outside = join(dirname(root), "namespace-outside");
        await writeFile(outside, Buffer.from("outside"), { mode: 0o600 });
        await rm(stagingPath);
        await symlink(outside, stagingPath, "file");
      } else if (mutation === "mode") {
        await chmod(stagingPath, 0o640);
      } else if (mutation === "nlink") {
        await link(stagingPath, join(dirname(root), "namespace-external-link"));
      } else {
        const displaced = join(dirname(root), "namespace-staging-displaced");
        await rename(staging, displaced);
        await mkdir(staging, { mode: 0o700 });
        await chmod(staging, 0o700);
        await writeFile(stagingPath, Buffer.from("replacement"), { mode: 0o600 });
      }
      await expect(kernel.cleanupNamespaceEntry(observation)).resolves.toMatchObject({
        outcome: "identity_changed",
      });
      await expect(lstat(stagingPath)).resolves.toBeDefined();
      await kernel.close();
    }
  });

  it("removes only publication temporaries and preserves a linked immutable object", async () => {
    const root = await createArtifactRootPath();
    const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
    const bytes = Buffer.from("linked-object");
    const digest = sha256(bytes);
    const shard = join(root, "objects", "sha256", digest.slice(0, 2));
    await mkdir(shard, { mode: 0o700 });
    await chmod(shard, 0o700);
    const objectPath = join(shard, digest);
    const temporaryPath = join(shard, `.publish-${uploadId}-${finalizationId}.tmp`);
    const unlinkedTemporaryPath = join(
      shard,
      `.publish-${secondUploadId}-${secondFinalizationId}.tmp`,
    );
    await writeFile(objectPath, bytes, { mode: 0o600 });
    await chmod(objectPath, 0o600);
    await link(objectPath, temporaryPath);
    await writeFile(unlinkedTemporaryPath, Buffer.from("partial"), { mode: 0o600 });
    await chmod(unlinkedTemporaryPath, 0o600);

    const page = await kernel.scanNamespacePage({
      scanSessionId: "90000000-0000-4000-8000-000000000020",
      sweepGeneration: 0,
      expectedAfterKey: null,
      maximumEntries: 8,
    });
    expect(page.observations).toHaveLength(2);
    const unlinkedObservation = page.observations.find(
      (entry) => entry.expectedLinkCount === 1,
    ) as ArtifactNamespaceObservation;
    await expect(kernel.cleanupNamespaceEntry(unlinkedObservation)).resolves.toMatchObject({
      outcome: "removed",
    });
    await expect(lstat(unlinkedTemporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    const observation = page.observations.find(
      (entry) => entry.expectedLinkCount === 2,
    ) as ArtifactNamespaceObservation;
    expect(observation).toMatchObject({
      kind: "publication-temporary",
      linkedObjectSha256: digest,
      expectedLinkCount: 2,
    });
    await expect(kernel.cleanupNamespaceEntry(observation)).resolves.toMatchObject({
      outcome: "removed",
    });
    await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(objectPath)).nlink).toBe(1);
    await expect(readFile(objectPath)).resolves.toEqual(bytes);
    await kernel.close();
  });

  it("does not delete when persisted file identity fields are changed", async () => {
    const root = await createArtifactRootPath();
    const kernel = new ArtifactStorageKernel(options(root), new LinuxArtifactStorageOperations());
    const stagingPath = join(root, "staging", `${uploadId}.upload`);
    await writeFile(stagingPath, Buffer.from("uid"), { mode: 0o600 });
    const page = await kernel.scanNamespacePage({
      scanSessionId: "90000000-0000-4000-8000-000000000030",
      sweepGeneration: 0,
      expectedAfterKey: null,
      maximumEntries: 8,
    });
    const observation = page.observations[0] as ArtifactNamespaceObservation;
    const { observationSha256: _observationSha256, ...identity } = observation;
    const changedIdentities = [
      { ...identity, fileUid: String(Number(identity.fileUid) + 1) },
      { ...identity, fileInode: String(BigInt(identity.fileInode) + 1n) },
      { ...identity, fileCtimeNs: String(BigInt(identity.fileCtimeNs) + 1n) },
      { ...identity, observedBytes: identity.observedBytes + 1 },
    ];
    for (const changedIdentity of changedIdentities) {
      await expect(
        kernel.cleanupNamespaceEntry({
          ...changedIdentity,
          observationSha256: calculateArtifactNamespaceObservationSha256(changedIdentity),
        }),
      ).resolves.toMatchObject({ outcome: "identity_changed" });
    }
    await expect(readFile(stagingPath)).resolves.toEqual(Buffer.from("uid"));
    await kernel.close();
  });

  it("surfaces unknown namespace unlink and fsync outcomes as fatal operation errors", async () => {
    for (const failurePoint of ["unlink", "fsync"] as const) {
      const root = await createArtifactRootPath();
      const failure = Object.assign(new Error(`injected namespace ${failurePoint} failure`), {
        code: "EIO",
      });
      const operations = new LinuxArtifactStorageOperations(
        failurePoint === "unlink"
          ? {
              unlink: () => {
                throw failure;
              },
            }
          : {
              syncDirectoryDescriptor: () => {
                throw failure;
              },
            },
      );
      const kernel = new ArtifactStorageKernel(options(root), operations);
      const stagingPath = join(root, "staging", `${uploadId}.upload`);
      await writeFile(stagingPath, Buffer.from("fatal-outcome"), { mode: 0o600 });
      const page = await kernel.scanNamespacePage({
        scanSessionId:
          failurePoint === "unlink"
            ? "90000000-0000-4000-8000-000000000040"
            : "90000000-0000-4000-8000-000000000041",
        sweepGeneration: 0,
        expectedAfterKey: null,
        maximumEntries: 8,
      });
      const observation = page.observations[0];
      if (observation === undefined) {
        throw new Error("Expected a namespace observation for failure injection.");
      }
      await expect(kernel.cleanupNamespaceEntry(observation)).rejects.toBe(failure);
      if (failurePoint === "unlink") {
        await expect(readFile(stagingPath)).resolves.toEqual(Buffer.from("fatal-outcome"));
      } else {
        await expect(lstat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await kernel.close();
    }
  });

  it("fsyncs descriptor-bound parents for both forms of already-absent cleanup", async () => {
    const absentRoot = await createArtifactRootPath();
    const absentFsyncFailure = Object.assign(new Error("injected absent fsync failure"), {
      code: "EIO",
    });
    const absentKernel = new ArtifactStorageKernel(
      options(absentRoot),
      new LinuxArtifactStorageOperations({
        syncDirectoryDescriptor: () => {
          throw absentFsyncFailure;
        },
      }),
    );
    const absentPath = join(absentRoot, "staging", `${uploadId}.upload`);
    await writeFile(absentPath, Buffer.from("absent"), { mode: 0o600 });
    const absentPage = await absentKernel.scanNamespacePage({
      scanSessionId: "90000000-0000-4000-8000-000000000050",
      sweepGeneration: 0,
      expectedAfterKey: null,
      maximumEntries: 8,
    });
    await rm(absentPath);
    await expect(
      absentKernel.cleanupNamespaceEntry(
        absentPage.observations[0] as ArtifactNamespaceObservation,
      ),
    ).rejects.toBe(absentFsyncFailure);
    await absentKernel.close();

    const racedRoot = await createArtifactRootPath();
    const racedKernel = new ArtifactStorageKernel(
      options(racedRoot),
      new LinuxArtifactStorageOperations({
        unlink: (path) => {
          unlinkSync(path);
          throw Object.assign(new Error("injected post-unlink ENOENT"), { code: "ENOENT" });
        },
      }),
    );
    const racedPath = join(racedRoot, "staging", `${uploadId}.upload`);
    await writeFile(racedPath, Buffer.from("raced"), { mode: 0o600 });
    const racedPage = await racedKernel.scanNamespacePage({
      scanSessionId: "90000000-0000-4000-8000-000000000051",
      sweepGeneration: 0,
      expectedAfterKey: null,
      maximumEntries: 8,
    });
    await expect(
      racedKernel.cleanupNamespaceEntry(racedPage.observations[0] as ArtifactNamespaceObservation),
    ).resolves.toMatchObject({ outcome: "already_absent" });
    await expect(lstat(racedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await racedKernel.close();
  });
});

const options = (rootPath: string) => ({
  rootPath,
  capacity: {
    hardBytes: 1_000_000_000n,
    hardEntries: 10_000,
    emergencyReserveBytes: 100_000_000n,
    perUploadMetadataHeadroomBytes: 65_536n,
    cleanupBacklogHighWaterEntries: 1_000,
  },
});

const chunk = (bytes: Buffer) => ({
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

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const createArtifactRootPath = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), "agentic-review-artifacts-"));
  await chmod(parent, 0o700);
  temporaryDirectories.push(parent);
  return join(parent, "storage");
};
