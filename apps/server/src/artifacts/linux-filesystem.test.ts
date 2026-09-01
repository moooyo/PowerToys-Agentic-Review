import { createHash } from "node:crypto";
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
  ArtifactStorageIntegrityError,
  ArtifactStorageKernel,
  isSupportedArtifactFilesystemType,
  synchronizeArtifactDirectoryChain,
} from "../../dist/artifacts/index.js";
import type { ArtifactStorageDirectoryBinding } from "../../dist/artifacts/types.js";

const uploadId = "11111111-1111-4111-8111-111111111111";
const prepareId = "22222222-2222-4222-8222-222222222222";
const finalizationId = "33333333-3333-4333-8333-333333333333";
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
    const kernel = new ArtifactStorageKernel(options(root));
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
    const kernel = new ArtifactStorageKernel(options(root));
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
    const kernel = new ArtifactStorageKernel(options(root));
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
    const kernel = new ArtifactStorageKernel(options(root));
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
    const kernel = new ArtifactStorageKernel(options(root));
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
    expect(() => new ArtifactStorageKernel(options(root))).toThrow(ArtifactStorageIntegrityError);
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
