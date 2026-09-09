import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate as yieldIo } from "node:timers/promises";
import { maximumEvidenceChunkBytes } from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  type AssetAttestation,
  type AssetVerificationSnapshot,
  checkAssetSnapshot,
  checkSnapshotRoot,
  checkVerificationSchema,
  createEvidenceClockMonitor,
  type EvidenceFileIdentity,
  type EvidenceIdentityProbeItem,
  EvidenceVerificationError,
  type EvidenceVerificationRoot,
  EvidenceVerificationRootSchema,
  evidenceSnapshotDigest,
  type IdentityAttestation,
  type IdentityProbeSnapshot,
  IdentityProbeSnapshotSchema,
  maximumVerificationStepsBytes,
  reusableEvidenceVerification,
  sameEvidenceIdentity,
  verificationFailure,
} from "./evidence-verification-protocol.js";

const verificationClock = createEvidenceClockMonitor();

export function evidenceFileIdentity(info: BigIntStats): EvidenceFileIdentity {
  if (
    !info.isFile() ||
    info.nlink !== 1n ||
    (info.mode & 0o777n) !== 0o600n ||
    info.uid !== BigInt(process.geteuid?.() ?? -1) ||
    info.size < 0n ||
    info.size > 64n * 1024n * 1024n
  )
    verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
  return {
    device: String(info.dev),
    inode: String(info.ino),
    sizeBytes: Number(info.size),
    ctimeNs: String(info.ctimeNs),
    mtimeNs: String(info.mtimeNs),
    mode: 0o600,
    uid: Number(info.uid),
    nlink: 1,
  };
}
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) verificationFailure("EVIDENCE_VERIFIER_CANCELLED");
}
interface OpenAsset {
  handle: FileHandle;
  path: string;
  before: EvidenceFileIdentity;
}

export async function inspectEvidenceRoot(
  directory: string,
  storageKey: string,
): Promise<EvidenceVerificationRoot> {
  try {
    if (
      process.platform !== "linux" ||
      resolve(directory) !== directory ||
      !/^[a-f0-9]{32}$/u.test(storageKey)
    )
      verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
    const info = await lstat(directory, { bigint: true });
    const root = { directory, storageKey, device: String(info.dev), inode: String(info.ino) };
    const opened = await ReadonlyEvidenceDirectory.open(root);
    await opened.close();
    return root;
  } catch (error) {
    if (error instanceof EvidenceVerificationError) throw error;
    return verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
  }
}

export async function inspectEvidenceFile(
  root: EvidenceVerificationRoot,
  input: {
    readonly assetId: string;
    readonly state: "uploading" | "finalized";
    readonly device: string;
    readonly inode: string;
    readonly sizeBytes: number;
  },
): Promise<EvidenceFileIdentity> {
  let directory: ReadonlyEvidenceDirectory | undefined;
  let asset: OpenAsset | undefined;
  try {
    directory = await ReadonlyEvidenceDirectory.open(root);
    asset = await directory.openAsset(
      {
        assetId: input.assetId,
        state: input.state,
        expectedFile: {
          device: input.device,
          inode: input.inode,
          sizeBytes: input.sizeBytes,
          ctimeNs: "0",
          mtimeNs: "0",
          mode: 0o600,
          uid: process.geteuid?.() ?? -1,
          nlink: 1,
        },
      },
      false,
    );
    return await directory.after(asset);
  } catch (error) {
    if (error instanceof EvidenceVerificationError) throw error;
    return verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
  } finally {
    await asset?.handle.close();
    await directory?.close();
  }
}

/** This read-only path never creates files, changes permissions, renames, or performs fsync. */
export class ReadonlyEvidenceDirectory {
  private constructor(
    readonly root: EvidenceVerificationRoot,
    private readonly handle: FileHandle,
  ) {}
  static async open(value: EvidenceVerificationRoot): Promise<ReadonlyEvidenceDirectory> {
    const root = structuredClone(checkVerificationSchema(EvidenceVerificationRootSchema, value));
    if (
      process.platform !== "linux" ||
      resolve(root.directory) !== root.directory ||
      root.directory === "/"
    )
      verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
    let handle: FileHandle | undefined;
    try {
      const named = await lstat(root.directory, { bigint: true });
      if (
        !named.isDirectory() ||
        named.isSymbolicLink() ||
        (named.mode & 0o777n) !== 0o700n ||
        named.uid !== BigInt(process.geteuid?.() ?? -1) ||
        String(named.dev) !== root.device ||
        String(named.ino) !== root.inode ||
        (await realpath(root.directory)) !== root.directory
      )
        verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
      handle = await open(
        root.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const actual = await handle.stat({ bigint: true });
      if (actual.dev !== named.dev || actual.ino !== named.ino)
        verificationFailure("EVIDENCE_FILE_CHANGED");
      const directory = new ReadonlyEvidenceDirectory(root, handle);
      const marker = await open(
        `/proc/self/fd/${handle.fd}/.owner-${root.storageKey}`,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = evidenceFileIdentity(await marker.stat({ bigint: true }));
        if (info.sizeBytes !== 0) verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
      } finally {
        await marker.close();
      }
      await directory.checkRoot();
      return directory;
    } catch (error) {
      await handle?.close();
      if (error instanceof EvidenceVerificationError) throw error;
      return verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
    }
  }
  async close(): Promise<void> {
    await this.handle.close();
  }
  async filesystemType(): Promise<number> {
    return Number(
      BigInt.asUintN(32, (await statfs(`/proc/self/fd/${this.handle.fd}`, { bigint: true })).type),
    );
  }
  async checkRoot(): Promise<void> {
    const named = await lstat(this.root.directory, { bigint: true });
    const opened = await this.handle.stat({ bigint: true });
    if (
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      String(named.dev) !== this.root.device ||
      String(named.ino) !== this.root.inode ||
      (named.mode & 0o777n) !== 0o700n ||
      named.uid !== BigInt(process.geteuid?.() ?? -1) ||
      (await realpath(this.root.directory)) !== this.root.directory
    )
      verificationFailure("EVIDENCE_FILE_CHANGED");
  }
  async openAsset(
    item: EvidenceIdentityProbeItem,
    requireExactIdentity = true,
  ): Promise<OpenAsset> {
    await this.checkRoot();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.assetId))
      verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    let path = `/proc/self/fd/${this.handle.fd}/${item.assetId}.${item.state === "uploading" ? "upload" : "asset"}`;
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (item.state !== "uploading" || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      // A completed rename may precede the SQLite finalized commit after a crash.
      path = `/proc/self/fd/${this.handle.fd}/${item.assetId}.asset`;
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    try {
      const before = evidenceFileIdentity(await handle.stat({ bigint: true }));
      if (
        before.device !== item.expectedFile.device ||
        before.inode !== item.expectedFile.inode ||
        before.sizeBytes !== item.expectedFile.sizeBytes ||
        before.uid !== item.expectedFile.uid ||
        (requireExactIdentity && !sameEvidenceIdentity(before, item.expectedFile))
      )
        verificationFailure("EVIDENCE_FILE_CHANGED");
      const named = await lstat(path, { bigint: true });
      if (named.isSymbolicLink() || !sameEvidenceIdentity(before, evidenceFileIdentity(named)))
        verificationFailure("EVIDENCE_FILE_CHANGED");
      return { handle, path, before };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async after(asset: OpenAsset): Promise<EvidenceFileIdentity> {
    const after = evidenceFileIdentity(await asset.handle.stat({ bigint: true }));
    const named = await lstat(asset.path, { bigint: true });
    if (
      named.isSymbolicLink() ||
      !sameEvidenceIdentity(after, asset.before) ||
      !sameEvidenceIdentity(after, evidenceFileIdentity(named))
    )
      verificationFailure("EVIDENCE_FILE_CHANGED");
    await this.checkRoot();
    return after;
  }
}

export async function verifyEvidenceAsset(
  root: EvidenceVerificationRoot,
  snapshot: AssetVerificationSnapshot,
  signal: AbortSignal,
  collectSteps = false,
): Promise<{ attestation: AssetAttestation; bytes?: Buffer }> {
  checkAssetSnapshot(snapshot);
  checkSnapshotRoot(root, snapshot.storage);
  throwIfCancelled(signal);
  const captureJson = collectSteps || snapshot.expectedJsonSha256 !== undefined;
  if (
    captureJson &&
    (snapshot.asset.metadata.kind !== "steps" ||
      snapshot.asset.metadata.mediaType !== "application/json" ||
      snapshot.expectedFile.sizeBytes > maximumVerificationStepsBytes)
  )
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  let directory: ReadonlyEvidenceDirectory | undefined;
  let asset: OpenAsset | undefined;
  try {
    directory = await ReadonlyEvidenceDirectory.open(root);
    asset = await directory.openAsset({
      assetId: snapshot.asset.id,
      state: snapshot.asset.state,
      expectedFile: snapshot.expectedFile,
    });
    const filesystemType = await directory.filesystemType();
    const started = verificationClock();
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(maximumEvidenceChunkBytes);
    const collected: Buffer[] = [];
    for (const chunk of snapshot.chunks) {
      throwIfCancelled(signal);
      let received = 0;
      while (received < chunk.sizeBytes) {
        const part = await asset.handle.read(
          buffer,
          received,
          chunk.sizeBytes - received,
          chunk.offset + received,
        );
        if (part.bytesRead < 1) verificationFailure("EVIDENCE_INTEGRITY_FAILED");
        received += part.bytesRead;
      }
      const bytes = buffer.subarray(0, chunk.sizeBytes);
      if (createHash("sha256").update(bytes).digest("hex") !== chunk.sha256)
        verificationFailure("EVIDENCE_INTEGRITY_FAILED");
      digest.update(bytes);
      if (captureJson) collected.push(Buffer.from(bytes));
      await yieldIo();
    }
    throwIfCancelled(signal);
    if (digest.digest("hex") !== snapshot.asset.metadata.sha256)
      verificationFailure("EVIDENCE_INTEGRITY_FAILED");
    if (snapshot.expectedJsonSha256 !== undefined) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(collected));
        if (sha256(canonicalJson(JSON.parse(text))) !== snapshot.expectedJsonSha256)
          verificationFailure("EVIDENCE_INTEGRITY_FAILED");
      } catch {
        verificationFailure("EVIDENCE_INTEGRITY_FAILED");
      }
    }
    const after = await directory.after(asset);
    const finished = verificationClock();
    const timing = {
      filesystemType,
      startedAtUnixMs: started.wallMs,
      finishedAtUnixMs: finished.wallMs,
      elapsedMonotonicMs: Math.max(0, finished.monotonicMs - started.monotonicMs),
      clockStable: started.stable && finished.stable,
    };
    throwIfCancelled(signal);
    return {
      attestation: {
        kind: "asset_verified",
        verification: {
          ...timing,
          reusable: reusableEvidenceVerification(timing, [asset.before, after]),
        },
        snapshotDigest: evidenceSnapshotDigest(snapshot),
        manifestDigest: snapshot.manifestDigest,
        assetId: snapshot.asset.id,
        storage: snapshot.storage,
        sha256: snapshot.asset.metadata.sha256,
        sizeBytes: snapshot.asset.metadata.sizeBytes,
        before: asset.before,
        after,
      },
      ...(collectSteps
        ? { bytes: Buffer.concat(collected, snapshot.asset.metadata.sizeBytes) }
        : {}),
    };
  } catch (error) {
    if (error instanceof EvidenceVerificationError) throw error;
    return verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
  } finally {
    await asset?.handle.close();
    await directory?.close();
  }
}

export async function probeEvidenceIdentities(
  root: EvidenceVerificationRoot,
  snapshot: IdentityProbeSnapshot,
  signal: AbortSignal,
): Promise<IdentityAttestation> {
  checkVerificationSchema(IdentityProbeSnapshotSchema, snapshot);
  checkSnapshotRoot(root, snapshot.storage);
  if (new Set(snapshot.assets.map((item) => item.assetId)).size !== snapshot.assets.length)
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  const assets: IdentityAttestation["assets"] = [];
  let matches = true;
  let directory: ReadonlyEvidenceDirectory | undefined;
  try {
    directory = await ReadonlyEvidenceDirectory.open(root);
    for (const item of snapshot.assets) {
      throwIfCancelled(signal);
      const asset = await directory.openAsset(item, false);
      try {
        const after = await directory.after(asset);
        if (!sameEvidenceIdentity(after, item.expectedFile)) matches = false;
        assets.push({ assetId: item.assetId, state: item.state, before: asset.before, after });
      } finally {
        await asset.handle.close();
      }
      await yieldIo();
    }
    throwIfCancelled(signal);
    return {
      kind: "identities_probed",
      snapshotDigest: evidenceSnapshotDigest(snapshot),
      storage: snapshot.storage,
      matches,
      assets,
    };
  } catch (error) {
    if (error instanceof EvidenceVerificationError) throw error;
    return verificationFailure("EVIDENCE_FILE_UNAVAILABLE");
  } finally {
    await directory?.close();
  }
}
