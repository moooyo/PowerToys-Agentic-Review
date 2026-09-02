import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { maximumResultArtifactBytes } from "@agentic-review/contracts";
import {
  type ArtifactNamespaceCleanupResult,
  type ArtifactNamespaceObservation,
  calculateArtifactNamespaceObservationSha256,
  parseArtifactNamespaceEntryKey,
} from "./artifact-namespace-contract.js";
import { ArtifactEntryBudget, visitBoundedArtifactEntries } from "./bounded-scan.js";
import { ArtifactStorageIntegrityError } from "./errors.js";
import {
  artifactPublicationTemporaryFilename,
  artifactStagingFilename,
  joinContainedArtifactPath,
  requireArtifactSha256,
} from "./names.js";
import type {
  ArtifactFilesystemCapacity,
  ArtifactStorageDirectoryBinding,
  ArtifactStorageFileHandle,
  ArtifactStorageFileIdentity,
  ArtifactStorageFileKind,
  ArtifactStorageInventory,
  ArtifactStorageLayout,
  ArtifactStorageOpenedFile,
  ArtifactStorageOperations,
  ArtifactStorageShardDirectory,
} from "./types.js";

const privateDirectoryMode = 0o700n;
const privateFileMode = 0o600n;
const permissionBits = 0o7777n;
const groupOrOtherWriteBits = 0o022n;
const stickyBit = 0o1000n;
const otherWriteBit = 0o002n;
const digestEntryPattern = /^[0-9a-f]{64}$/u;
const shardEntryPattern = /^[0-9a-f]{2}$/u;
const supportedLocalFilesystemTypes = new Set([0x0000_ef53n, 0x5846_5342n]);
const procSelfFileDescriptorRoot = "/proc/self/fd";

const identityOf = (stats: BigIntStats): ArtifactStorageFileIdentity => ({
  device: stats.dev,
  inode: stats.ino,
});

const identitiesMatch = (
  left: ArtifactStorageFileIdentity,
  right: ArtifactStorageFileIdentity,
): boolean => left.device === right.device && left.inode === right.inode;

const canonicalStatNumber = (value: bigint): string => value.toString(10);

const ctimeNanoseconds = (stats: BigIntStats): bigint => stats.ctimeNs;

const fileStatsMatchObservation = (
  stats: BigIntStats,
  observation: ArtifactNamespaceObservation,
  expectedLinkCount = observation.expectedLinkCount,
): boolean =>
  stats.isFile() &&
  !stats.isSymbolicLink() &&
  canonicalStatNumber(stats.dev) === observation.fileDevice &&
  canonicalStatNumber(stats.ino) === observation.fileInode &&
  canonicalStatNumber(ctimeNanoseconds(stats)) === observation.fileCtimeNs &&
  canonicalStatNumber(stats.mode & permissionBits) === observation.fileMode &&
  canonicalStatNumber(stats.uid) === observation.fileUid &&
  stats.size === BigInt(observation.observedBytes) &&
  stats.nlink === BigInt(expectedLinkCount);

const parentStatsMatchObservation = (
  stats: BigIntStats,
  observation: ArtifactNamespaceObservation,
): boolean =>
  stats.isDirectory() &&
  !stats.isSymbolicLink() &&
  canonicalStatNumber(stats.dev) === observation.parentDevice &&
  canonicalStatNumber(stats.ino) === observation.parentInode &&
  canonicalStatNumber(stats.mode & permissionBits) === observation.parentMode &&
  canonicalStatNumber(stats.uid) === observation.parentUid;

const readDescriptorSha256 = (descriptor: number, expectedBytes: number): string => {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < expectedBytes) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, expectedBytes - offset),
      offset,
    );
    if (bytesRead < 1) {
      throw integrity("Artifact namespace file ended during digest verification.");
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
};

const isManagedNamespaceKey = (
  entryKey: string,
  kind: "staging" | "publication-temporary",
): boolean => {
  try {
    parseArtifactNamespaceEntryKey(entryKey, kind);
    return true;
  } catch {
    return false;
  }
};

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const readEntry = (path: string): BigIntStats | undefined => {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
};

const currentEffectiveUserId = (): bigint => {
  if (process.platform !== "linux" || typeof process.geteuid !== "function") {
    throw new Error("Artifact storage requires a supported Linux POSIX filesystem.");
  }
  return BigInt(process.geteuid());
};

const integrity = (message: string, cause?: unknown): ArtifactStorageIntegrityError =>
  new ArtifactStorageIntegrityError(message, cause === undefined ? undefined : { cause });

const lexicalDirectoryPaths = (directoryPath: string): readonly string[] => {
  const filesystemRoot = parse(directoryPath).root;
  const paths = [filesystemRoot];
  let current = filesystemRoot;
  for (const segment of relative(filesystemRoot, directoryPath).split(sep).filter(Boolean)) {
    current = join(current, segment);
    paths.push(current);
  }
  return paths;
};

const assertContained = (rootPath: string, path: string, allowRoot = false): void => {
  const relativePath = relative(resolve(rootPath), resolve(path));
  if (
    (!allowRoot && relativePath === "") ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.includes(":")
  ) {
    throw integrity(`Artifact storage path ${path} escaped its bound root.`);
  }
};

const assertSecureAncestorStats = (path: string, stats: BigIntStats): void => {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw integrity(`Artifact storage ancestor ${path} must be a real directory.`);
  }
  const userId = currentEffectiveUserId();
  if (stats.uid !== 0n && stats.uid !== userId) {
    throw integrity(`Artifact storage ancestor ${path} must be owned by root or the Server user.`);
  }
  const mode = stats.mode & permissionBits;
  const rootOwnedStickyWorldWritable =
    stats.uid === 0n && (mode & stickyBit) !== 0n && (mode & otherWriteBit) !== 0n;
  if ((mode & groupOrOtherWriteBits) !== 0n && !rootOwnedStickyWorldWritable) {
    throw integrity(`Artifact storage ancestor ${path} is writable by group or other users.`);
  }
};

const assertPrivateDirectoryStats = (
  path: string,
  stats: BigIntStats,
  expectedDevice?: bigint,
): void => {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw integrity(`Artifact storage directory ${path} must be a real directory.`);
  }
  if (stats.uid !== currentEffectiveUserId()) {
    throw integrity(`Artifact storage directory ${path} must be owned by the Server user.`);
  }
  const mode = stats.mode & permissionBits;
  if (mode !== privateDirectoryMode) {
    throw integrity(`Artifact storage directory ${path} must have mode 0700.`);
  }
  if (expectedDevice !== undefined && stats.dev !== expectedDevice) {
    throw integrity(`Artifact storage directory ${path} crossed a filesystem device boundary.`);
  }
};

const bindDirectory = (
  path: string,
  stats: BigIntStats,
  privateDirectory: boolean,
): ArtifactStorageDirectoryBinding => ({
  path,
  identity: identityOf(stats),
  device: stats.dev,
  mode: stats.mode & permissionBits,
  userId: stats.uid,
  privateDirectory,
});

const assertBoundDirectory = (binding: ArtifactStorageDirectoryBinding): BigIntStats => {
  const stats = readEntry(binding.path);
  if (stats === undefined) {
    throw integrity(`Artifact storage directory ${binding.path} disappeared after binding.`);
  }
  if (binding.privateDirectory) {
    assertPrivateDirectoryStats(binding.path, stats, binding.device);
  } else {
    assertSecureAncestorStats(binding.path, stats);
  }
  if (
    !identitiesMatch(identityOf(stats), binding.identity) ||
    stats.uid !== binding.userId ||
    (stats.mode & permissionBits) !== binding.mode
  ) {
    throw integrity(
      `Artifact storage directory ${binding.path} changed identity, owner, or mode after binding.`,
    );
  }
  return stats;
};

const closeAfterOperation = (
  descriptor: number,
  operationError: unknown | undefined,
  message: string,
): void => {
  let closeError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError([operationError, closeError], message, { cause: operationError });
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
};

const syncBoundDirectory = (binding: ArtifactStorageDirectoryBinding): void => {
  assertBoundDirectory(binding);
  const descriptor = openSync(
    binding.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let operationError: unknown;
  try {
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    if (
      !descriptorStats.isDirectory() ||
      !identitiesMatch(identityOf(descriptorStats), binding.identity) ||
      descriptorStats.dev !== binding.device ||
      descriptorStats.uid !== binding.userId ||
      (descriptorStats.mode & permissionBits) !== binding.mode
    ) {
      throw integrity(`Artifact storage directory ${binding.path} changed before synchronization.`);
    }
    fsyncSync(descriptor);
    assertBoundDirectory(binding);
  } catch (error) {
    operationError = error;
  }
  closeAfterOperation(
    descriptor,
    operationError,
    `Unable to synchronize and close artifact directory ${binding.path}.`,
  );
};

const createPrivateDirectory = (
  path: string,
  expectedDevice?: bigint,
): ArtifactStorageDirectoryBinding => {
  mkdirSync(path, { mode: Number(privateDirectoryMode) });
  chmodSync(path, Number(privateDirectoryMode));
  const stats = readEntry(path);
  if (stats === undefined) {
    throw integrity(`Artifact storage directory ${path} was not created.`);
  }
  assertPrivateDirectoryStats(path, stats, expectedDevice);
  return bindDirectory(path, stats, true);
};

const ensurePrivateChildDirectory = (
  rootPath: string,
  parent: ArtifactStorageDirectoryBinding,
  name: string,
  expectedDevice: bigint,
): ArtifactStorageShardDirectory => {
  assertBoundDirectory(parent);
  const path = joinContainedArtifactPath(rootPath, parent.path, name);
  const existing = readEntry(path);
  let created = false;
  let binding: ArtifactStorageDirectoryBinding;
  if (existing === undefined) {
    try {
      binding = createPrivateDirectory(path, expectedDevice);
      created = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
      const raced = readEntry(path);
      if (raced === undefined) {
        throw integrity(`Artifact storage directory ${path} disappeared during creation.`, error);
      }
      assertPrivateDirectoryStats(path, raced, expectedDevice);
      binding = bindDirectory(path, raced, true);
    }
  } else {
    assertPrivateDirectoryStats(path, existing, expectedDevice);
    binding = bindDirectory(path, existing, true);
  }
  assertBoundDirectory(parent);
  return { directory: binding, created };
};

const assertPrivateFileStats = (
  path: string,
  stats: BigIntStats,
  expectedDevice: bigint,
  allowedLinkCounts: readonly bigint[],
): void => {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw integrity(`Artifact storage file ${path} must be a regular file without symlinks.`);
  }
  if (stats.uid !== currentEffectiveUserId()) {
    throw integrity(`Artifact storage file ${path} must be owned by the Server user.`);
  }
  if ((stats.mode & permissionBits) !== privateFileMode) {
    throw integrity(`Artifact storage file ${path} must have mode 0600.`);
  }
  if (stats.dev !== expectedDevice) {
    throw integrity(`Artifact storage file ${path} crossed a filesystem device boundary.`);
  }
  if (!allowedLinkCounts.includes(stats.nlink)) {
    throw integrity(`Artifact storage file ${path} has an unrecognized hard-link count.`);
  }
};

export const isSupportedArtifactFilesystemType = (type: bigint): boolean =>
  supportedLocalFilesystemTypes.has(type & 0xffff_ffffn);

export const synchronizeArtifactDirectoryChain = (
  bindings: readonly ArtifactStorageDirectoryBinding[],
  synchronize: (binding: ArtifactStorageDirectoryBinding) => void,
): void => {
  for (const binding of bindings.toReversed()) {
    synchronize(binding);
  }
};

const assertLocalFilesystem = (path: string): void => {
  const stats = statfsSync(path, { bigint: true });
  if (!isSupportedArtifactFilesystemType(stats.type)) {
    throw integrity(
      `Artifact storage filesystem type 0x${(stats.type & 0xffff_ffffn).toString(16)} is unsupported.`,
    );
  }
};

const visitBoundDirectoryEntries = (
  binding: ArtifactStorageDirectoryBinding,
  budget: ArtifactEntryBudget,
  visit: (name: string) => void,
): void => {
  assertBoundDirectory(binding);
  const directory = opendirSync(binding.path);
  visitBoundedArtifactEntries(
    {
      read: () => directory.readSync()?.name ?? null,
      close: () => directory.closeSync(),
    },
    budget,
    visit,
  );
  assertBoundDirectory(binding);
};

export interface LinuxArtifactNamespaceMutationOverrides {
  readonly unlink?: (path: string) => void;
  readonly syncDirectoryDescriptor?: (descriptor: number) => void;
}

export class LinuxArtifactStorageOperations implements ArtifactStorageOperations {
  readonly #unlinkNamespaceEntry: (path: string) => void;
  readonly #syncNamespaceDirectoryDescriptor: (descriptor: number) => void;

  constructor(overrides: LinuxArtifactNamespaceMutationOverrides = {}) {
    const unlink = overrides.unlink ?? unlinkSync;
    const syncDirectoryDescriptor = overrides.syncDirectoryDescriptor ?? fsyncSync;
    if (typeof unlink !== "function" || typeof syncDirectoryDescriptor !== "function") {
      throw new TypeError("Artifact namespace mutation overrides must be functions.");
    }
    this.#unlinkNamespaceEntry = unlink;
    this.#syncNamespaceDirectoryDescriptor = syncDirectoryDescriptor;
  }

  initialize(rootPath: string): ArtifactStorageLayout {
    currentEffectiveUserId();
    if (!isAbsolute(rootPath)) {
      throw new TypeError("Artifact storage root must be an absolute path.");
    }
    const resolvedRoot = resolve(rootPath);
    const paths = lexicalDirectoryPaths(resolvedRoot);
    const filesystemProbePath = paths.toReversed().find((path) => readEntry(path) !== undefined);
    if (filesystemProbePath === undefined) {
      throw integrity("Artifact storage has no existing filesystem ancestor.");
    }
    assertLocalFilesystem(filesystemProbePath);
    const ancestors: ArtifactStorageDirectoryBinding[] = [];
    let root: ArtifactStorageDirectoryBinding | undefined;

    for (const [index, path] of paths.entries()) {
      const isRoot = index === paths.length - 1;
      let stats = readEntry(path);
      let created = false;
      if (stats === undefined) {
        const parent = ancestors.at(-1);
        if (parent === undefined) {
          throw integrity(`Artifact storage filesystem root ${path} does not exist.`);
        }
        const binding = createPrivateDirectory(path, parent.device);
        stats = assertBoundDirectory(binding);
        created = true;
      }

      if (isRoot || created) {
        assertPrivateDirectoryStats(path, stats);
      } else {
        assertSecureAncestorStats(path, stats);
      }
      const binding = bindDirectory(path, stats, isRoot || created);
      if (created) {
        syncBoundDirectory(binding);
        const parent = ancestors.at(-1);
        if (parent !== undefined) {
          syncBoundDirectory(parent);
        }
      }
      if (isRoot) {
        root = binding;
      } else {
        ancestors.push(binding);
      }
    }

    if (root === undefined) {
      throw integrity(`Artifact storage root ${resolvedRoot} could not be bound.`);
    }
    const staging = ensurePrivateChildDirectory(resolvedRoot, root, "staging", root.device);
    if (staging.created) {
      syncBoundDirectory(staging.directory);
      syncBoundDirectory(root);
    }
    const objects = ensurePrivateChildDirectory(resolvedRoot, root, "objects", root.device);
    if (objects.created) {
      syncBoundDirectory(objects.directory);
      syncBoundDirectory(root);
    }
    const sha256 = ensurePrivateChildDirectory(
      resolvedRoot,
      objects.directory,
      "sha256",
      root.device,
    );
    if (sha256.created) {
      syncBoundDirectory(sha256.directory);
      syncBoundDirectory(objects.directory);
    }

    assertLocalFilesystem(resolvedRoot);
    const lexicalBindings = [...ancestors, root];
    synchronizeArtifactDirectoryChain(lexicalBindings, syncBoundDirectory);
    syncBoundDirectory(staging.directory);
    syncBoundDirectory(root);
    syncBoundDirectory(objects.directory);
    syncBoundDirectory(root);
    syncBoundDirectory(sha256.directory);
    syncBoundDirectory(objects.directory);

    return Object.freeze({
      rootPath: resolvedRoot,
      root,
      staging: staging.directory,
      objects: objects.directory,
      sha256: sha256.directory,
      ancestors: Object.freeze([...ancestors]),
    });
  }

  inspectManagedLayout(
    layout: ArtifactStorageLayout,
    maximumEntries: number,
  ): ArtifactStorageInventory {
    const budget = new ArtifactEntryBudget(maximumEntries);
    this.#assertLayout(layout);
    assertLocalFilesystem(layout.rootPath);
    let allocatedBytes = assertBoundDirectory(layout.root).blocks * 512n;
    let immutableObjects = 0;
    let publicationTemporaries = 0;
    let stagingFiles = 0;
    const chargedIdentities = new Set<string>();
    const charge = (stats: BigIntStats): void => {
      const key = `${stats.dev}:${stats.ino}`;
      if (!chargedIdentities.has(key)) {
        chargedIdentities.add(key);
        allocatedBytes += stats.blocks * 512n;
      }
    };

    let sawStaging = false;
    let sawObjects = false;
    visitBoundDirectoryEntries(layout.root, budget, (name) => {
      if (name === "staging") {
        sawStaging = true;
        charge(assertBoundDirectory(layout.staging));
      } else if (name === "objects") {
        sawObjects = true;
        charge(assertBoundDirectory(layout.objects));
      } else {
        throw integrity("Artifact storage root contains an unrecognized directory entry.");
      }
    });
    if (!sawStaging || !sawObjects) {
      throw integrity("Artifact storage root contains an unrecognized directory entry.");
    }

    let sawSha256 = false;
    visitBoundDirectoryEntries(layout.objects, budget, (name) => {
      if (name !== "sha256") {
        throw integrity("Artifact object namespace contains an unrecognized directory entry.");
      }
      sawSha256 = true;
      charge(assertBoundDirectory(layout.sha256));
    });
    if (!sawSha256) {
      throw integrity("Artifact object namespace contains an unrecognized directory entry.");
    }

    visitBoundDirectoryEntries(layout.staging, budget, (name) => {
      if (!isManagedNamespaceKey(`staging/${name}`, "staging")) {
        throw integrity("Artifact staging namespace contains an unrecognized entry.");
      }
      const path = joinContainedArtifactPath(layout.rootPath, layout.staging.path, name);
      const stats = this.#assertPathFile(path, layout.staging, undefined, [1n]);
      charge(stats);
      stagingFiles += 1;
    });

    visitBoundDirectoryEntries(layout.sha256, budget, (shardName) => {
      if (!shardEntryPattern.test(shardName)) {
        throw integrity("Artifact digest namespace contains an unrecognized shard entry.");
      }
      const shardPath = joinContainedArtifactPath(layout.rootPath, layout.sha256.path, shardName);
      const shardStats = readEntry(shardPath);
      if (shardStats === undefined) {
        throw integrity(`Artifact object shard ${shardPath} disappeared during inspection.`);
      }
      assertPrivateDirectoryStats(shardPath, shardStats, layout.root.device);
      const shard = bindDirectory(shardPath, shardStats, true);
      charge(shardStats);

      const linkedEntries = new Map<
        string,
        { readonly kind: "object" | "temporary"; readonly linkCount: bigint }[]
      >();
      visitBoundDirectoryEntries(shard, budget, (name) => {
        let kind: "object" | "temporary";
        if (digestEntryPattern.test(name) && name.startsWith(shardName)) {
          kind = "object";
          immutableObjects += 1;
        } else if (
          isManagedNamespaceKey(`objects/sha256/${shardName}/${name}`, "publication-temporary")
        ) {
          kind = "temporary";
          publicationTemporaries += 1;
        } else {
          throw integrity(`Artifact object shard ${shardPath} contains an unrecognized entry.`);
        }
        const path = joinContainedArtifactPath(layout.rootPath, shard.path, name);
        const stats = this.#assertPathFile(path, shard, undefined, [1n, 2n]);
        charge(stats);
        const identityKey = `${stats.dev}:${stats.ino}`;
        const group = linkedEntries.get(identityKey) ?? [];
        group.push({ kind, linkCount: stats.nlink });
        linkedEntries.set(identityKey, group);
      });
      for (const group of linkedEntries.values()) {
        if (group.some((entry) => entry.linkCount === 2n)) {
          const kinds = new Set(group.map((entry) => entry.kind));
          if (
            group.length !== 2 ||
            kinds.size !== 2 ||
            !kinds.has("object") ||
            !kinds.has("temporary") ||
            group.some((entry) => entry.linkCount !== 2n)
          ) {
            throw integrity(
              `Artifact object shard ${shardPath} contains an external or malformed hard link.`,
            );
          }
        }
      }
    });
    this.#assertLayout(layout);
    return {
      allocatedBytes,
      entries: budget.consumedEntries,
      immutableObjects,
      publicationTemporaries,
      stagingFiles,
    };
  }

  scanArtifactNamespace(
    layout: ArtifactStorageLayout,
    maximumManifestEntries: number,
    maximumTraversalEntries: number,
  ): readonly ArtifactNamespaceObservation[] {
    const budget = new ArtifactEntryBudget(maximumTraversalEntries);
    this.#assertLayout(layout);
    const observations: ArtifactNamespaceObservation[] = [];
    const observationFromStats = (
      entryKey: string,
      stats: BigIntStats,
      parent: ArtifactStorageDirectoryBinding,
      linkedObjectSha256: string | null,
    ): ArtifactNamespaceObservation => {
      if (stats.size > BigInt(maximumResultArtifactBytes)) {
        throw integrity("Artifact namespace file exceeds the result artifact byte limit.");
      }
      const parsed = parseArtifactNamespaceEntryKey(entryKey);
      const linked = linkedObjectSha256 === null ? null : canonicalStatNumber(stats.dev);
      const identity = {
        entryKey: parsed.entryKey,
        kind: parsed.kind,
        uploadId: parsed.uploadId,
        finalizationId: parsed.finalizationId,
        linkedObjectSha256,
        observedBytes: Number(stats.size),
        expectedLinkCount: Number(stats.nlink) as 1 | 2,
        fileDevice: canonicalStatNumber(stats.dev),
        fileInode: canonicalStatNumber(stats.ino),
        fileCtimeNs: canonicalStatNumber(ctimeNanoseconds(stats)),
        fileMode: canonicalStatNumber(stats.mode & permissionBits),
        fileUid: canonicalStatNumber(stats.uid),
        parentDevice: canonicalStatNumber(parent.device),
        parentInode: canonicalStatNumber(parent.identity.inode),
        parentMode: canonicalStatNumber(parent.mode),
        parentUid: canonicalStatNumber(parent.userId),
        linkedObjectDevice: linked,
        linkedObjectInode: linked === null ? null : canonicalStatNumber(stats.ino),
        linkedObjectCtimeNs: linked === null ? null : canonicalStatNumber(ctimeNanoseconds(stats)),
      };
      return Object.freeze({
        ...identity,
        observationSha256: calculateArtifactNamespaceObservationSha256(identity),
      });
    };
    const recordObservation = (observation: ArtifactNamespaceObservation): void => {
      if (observations.length >= maximumManifestEntries) {
        throw integrity("Artifact namespace manifest exceeds its bounded entry limit.");
      }
      observations.push(observation);
    };

    let sawStaging = false;
    let sawObjects = false;
    visitBoundDirectoryEntries(layout.root, budget, (name) => {
      if (name === "staging") {
        sawStaging = true;
      } else if (name === "objects") {
        sawObjects = true;
      } else {
        throw integrity("Artifact storage root contains an unrecognized namespace entry.");
      }
    });
    if (!sawStaging || !sawObjects) {
      throw integrity("Artifact storage root is missing a managed namespace.");
    }
    let sawSha256 = false;
    visitBoundDirectoryEntries(layout.objects, budget, (name) => {
      if (name !== "sha256") {
        throw integrity("Artifact object namespace contains an unrecognized entry.");
      }
      sawSha256 = true;
    });
    if (!sawSha256) {
      throw integrity("Artifact object namespace is missing its digest directory.");
    }

    visitBoundDirectoryEntries(layout.staging, budget, (name) => {
      if (!isManagedNamespaceKey(`staging/${name}`, "staging")) {
        throw integrity("Artifact staging namespace contains an unrecognized entry.");
      }
      const path = joinContainedArtifactPath(layout.rootPath, layout.staging.path, name);
      const stats = this.#assertPathFile(path, layout.staging, undefined, [1n]);
      recordObservation(observationFromStats(`staging/${name}`, stats, layout.staging, null));
    });

    visitBoundDirectoryEntries(layout.sha256, budget, (shardName) => {
      if (!shardEntryPattern.test(shardName)) {
        throw integrity("Artifact digest namespace contains an unrecognized shard entry.");
      }
      const shardPath = joinContainedArtifactPath(layout.rootPath, layout.sha256.path, shardName);
      const shardStats = readEntry(shardPath);
      if (shardStats === undefined) {
        throw integrity("Artifact object shard disappeared during namespace scan.");
      }
      assertPrivateDirectoryStats(shardPath, shardStats, layout.root.device);
      const shard = bindDirectory(shardPath, shardStats, true);
      const linkedEntries = new Map<
        string,
        {
          readonly name: string;
          readonly kind: "object" | "temporary";
          readonly stats: BigIntStats;
        }[]
      >();
      visitBoundDirectoryEntries(shard, budget, (name) => {
        const kind =
          digestEntryPattern.test(name) && name.startsWith(shardName)
            ? "object"
            : isManagedNamespaceKey(`objects/sha256/${shardName}/${name}`, "publication-temporary")
              ? "temporary"
              : undefined;
        if (kind === undefined) {
          throw integrity("Artifact object shard contains an unrecognized namespace entry.");
        }
        const path = joinContainedArtifactPath(layout.rootPath, shard.path, name);
        const stats = this.#assertPathFile(path, shard, undefined, [1n, 2n]);
        const key = `${stats.dev}:${stats.ino}`;
        const group = linkedEntries.get(key) ?? [];
        group.push({ name, kind, stats });
        linkedEntries.set(key, group);
      });

      for (const group of linkedEntries.values()) {
        const temporary = group.find((entry) => entry.kind === "temporary");
        const object = group.find((entry) => entry.kind === "object");
        if (group.some((entry) => entry.stats.nlink === 2n)) {
          if (
            group.length !== 2 ||
            temporary === undefined ||
            object === undefined ||
            group.some((entry) => entry.stats.nlink !== 2n)
          ) {
            throw integrity("Artifact namespace scan found a malformed hard-link pair.");
          }
          if (object.stats.size > BigInt(maximumResultArtifactBytes)) {
            throw integrity("Artifact linked object exceeds the result artifact byte limit.");
          }
        }
        if (temporary !== undefined) {
          const entryKey = `objects/sha256/${shardName}/${temporary.name}`;
          recordObservation(
            observationFromStats(entryKey, temporary.stats, shard, object?.name ?? null),
          );
        }
      }
    });
    observations.sort((left, right) =>
      left.entryKey < right.entryKey ? -1 : left.entryKey > right.entryKey ? 1 : 0,
    );
    for (let index = 1; index < observations.length; index += 1) {
      if (observations[index - 1]?.entryKey === observations[index]?.entryKey) {
        throw integrity("Artifact namespace scan produced a duplicate managed key.");
      }
    }
    this.#assertLayout(layout);
    return Object.freeze(observations);
  }

  cleanupArtifactNamespaceEntry(
    layout: ArtifactStorageLayout,
    observation: ArtifactNamespaceObservation,
  ): ArtifactNamespaceCleanupResult {
    const parsed = parseArtifactNamespaceEntryKey(observation.entryKey, observation.kind);
    for (const ancestor of layout.ancestors) {
      assertBoundDirectory(ancestor);
    }
    assertBoundDirectory(layout.root);
    if (parsed.kind === "publication-temporary") {
      assertBoundDirectory(layout.objects);
      assertBoundDirectory(layout.sha256);
    }
    const parentPath =
      parsed.kind === "staging"
        ? layout.staging.path
        : joinContainedArtifactPath(layout.rootPath, layout.sha256.path, parsed.shard as string);
    let parentDescriptor: number;
    try {
      parentDescriptor = openSync(
        parentPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP") || hasCode(error, "ENOTDIR")) {
        return Object.freeze({
          entryKey: observation.entryKey,
          observationSha256: observation.observationSha256,
          outcome: "identity_changed",
        });
      }
      throw error;
    }

    let targetDescriptor: number | undefined;
    let peerDescriptor: number | undefined;
    try {
      const parentStats = fstatSync(parentDescriptor, { bigint: true });
      const currentUserId = canonicalStatNumber(currentEffectiveUserId());
      if (
        observation.fileMode !== canonicalStatNumber(privateFileMode) ||
        observation.parentMode !== canonicalStatNumber(privateDirectoryMode) ||
        observation.fileUid !== currentUserId ||
        observation.parentUid !== currentUserId ||
        !parentStatsMatchObservation(parentStats, observation)
      ) {
        return Object.freeze({
          entryKey: observation.entryKey,
          observationSha256: observation.observationSha256,
          outcome: "identity_changed",
        });
      }
      const durableAbsent = (): ArtifactNamespaceCleanupResult => {
        this.#syncNamespaceDirectoryDescriptor(parentDescriptor);
        if (
          !parentStatsMatchObservation(fstatSync(parentDescriptor, { bigint: true }), observation)
        ) {
          return Object.freeze({
            entryKey: observation.entryKey,
            observationSha256: observation.observationSha256,
            outcome: "identity_changed",
          });
        }
        return Object.freeze({
          entryKey: observation.entryKey,
          observationSha256: observation.observationSha256,
          outcome: "already_absent",
        });
      };
      const targetName =
        parsed.kind === "staging"
          ? artifactStagingFilename(parsed.uploadId)
          : artifactPublicationTemporaryFilename(parsed.uploadId, parsed.finalizationId as string);
      const descriptorParentPath = join(procSelfFileDescriptorRoot, String(parentDescriptor));
      const targetPath = joinContainedArtifactPath(
        descriptorParentPath,
        descriptorParentPath,
        targetName,
      );
      const initialTargetStats = readEntry(targetPath);
      if (initialTargetStats === undefined) {
        return durableAbsent();
      }
      if (!fileStatsMatchObservation(initialTargetStats, observation)) {
        return Object.freeze({
          entryKey: observation.entryKey,
          observationSha256: observation.observationSha256,
          outcome: "identity_changed",
        });
      }
      try {
        targetDescriptor = openSync(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP")) {
          return Object.freeze({
            entryKey: observation.entryKey,
            observationSha256: observation.observationSha256,
            outcome: "identity_changed",
          });
        }
        throw error;
      }
      if (!fileStatsMatchObservation(fstatSync(targetDescriptor, { bigint: true }), observation)) {
        return Object.freeze({
          entryKey: observation.entryKey,
          observationSha256: observation.observationSha256,
          outcome: "identity_changed",
        });
      }

      let peerPath: string | undefined;
      if (observation.expectedLinkCount === 2) {
        if (observation.linkedObjectSha256 === null) {
          throw integrity("Artifact linked namespace cleanup lacks an immutable object key.");
        }
        peerPath = joinContainedArtifactPath(
          descriptorParentPath,
          descriptorParentPath,
          observation.linkedObjectSha256,
        );
        try {
          peerDescriptor = openSync(peerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP")) {
            return Object.freeze({
              entryKey: observation.entryKey,
              observationSha256: observation.observationSha256,
              outcome: "identity_changed",
            });
          }
          throw error;
        }
        const peerStats = fstatSync(peerDescriptor, { bigint: true });
        if (
          !fileStatsMatchObservation(peerStats, observation) ||
          canonicalStatNumber(peerStats.dev) !== observation.linkedObjectDevice ||
          canonicalStatNumber(peerStats.ino) !== observation.linkedObjectInode ||
          canonicalStatNumber(ctimeNanoseconds(peerStats)) !== observation.linkedObjectCtimeNs ||
          readDescriptorSha256(peerDescriptor, observation.observedBytes) !==
            observation.linkedObjectSha256
        ) {
          return Object.freeze({
            entryKey: observation.entryKey,
            observationSha256: observation.observationSha256,
            outcome: "identity_changed",
          });
        }
      }

      const finalTargetStats = readEntry(targetPath);
      const finalPeerStats = peerPath === undefined ? undefined : readEntry(peerPath);
      if (
        finalTargetStats === undefined ||
        !fileStatsMatchObservation(finalTargetStats, observation) ||
        !fileStatsMatchObservation(fstatSync(targetDescriptor, { bigint: true }), observation) ||
        (peerPath !== undefined &&
          (finalPeerStats === undefined ||
            !fileStatsMatchObservation(finalPeerStats, observation))) ||
        !parentStatsMatchObservation(fstatSync(parentDescriptor, { bigint: true }), observation)
      ) {
        return Object.freeze({
          entryKey: observation.entryKey,
          observationSha256: observation.observationSha256,
          outcome: "identity_changed",
        });
      }
      try {
        this.#unlinkNamespaceEntry(targetPath);
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          return durableAbsent();
        }
        throw error;
      }
      if (readEntry(targetPath) !== undefined) {
        throw integrity("Artifact namespace target survived unlink.");
      }
      if (peerDescriptor !== undefined) {
        const peerStats = fstatSync(peerDescriptor, { bigint: true });
        if (
          !peerStats.isFile() ||
          peerStats.isSymbolicLink() ||
          canonicalStatNumber(peerStats.dev) !== observation.linkedObjectDevice ||
          canonicalStatNumber(peerStats.ino) !== observation.linkedObjectInode ||
          canonicalStatNumber(peerStats.mode & permissionBits) !== observation.fileMode ||
          canonicalStatNumber(peerStats.uid) !== observation.fileUid ||
          peerStats.size !== BigInt(observation.observedBytes) ||
          peerStats.nlink !== 1n ||
          readDescriptorSha256(peerDescriptor, observation.observedBytes) !==
            observation.linkedObjectSha256
        ) {
          throw integrity("Artifact immutable object changed after temporary unlink.");
        }
      }
      this.#syncNamespaceDirectoryDescriptor(parentDescriptor);
      return Object.freeze({
        entryKey: observation.entryKey,
        observationSha256: observation.observationSha256,
        outcome: "removed",
      });
    } finally {
      if (peerDescriptor !== undefined) {
        closeSync(peerDescriptor);
      }
      if (targetDescriptor !== undefined) {
        closeSync(targetDescriptor);
      }
      closeSync(parentDescriptor);
    }
  }

  filesystemCapacity(layout: ArtifactStorageLayout): ArtifactFilesystemCapacity {
    this.#assertLayout(layout);
    const stats = statfsSync(layout.rootPath, { bigint: true });
    if (!isSupportedArtifactFilesystemType(stats.type)) {
      throw integrity("Artifact storage filesystem changed to an unsupported type.");
    }
    this.#assertLayout(layout);
    return {
      availableBytes: stats.bavail * stats.bsize,
      allocationUnitBytes: stats.bsize,
    };
  }

  getObjectShardDirectory(
    layout: ArtifactStorageLayout,
    sha256: string,
    createIfMissing: boolean,
  ): ArtifactStorageShardDirectory | undefined {
    this.#assertLayout(layout);
    const digest = requireArtifactSha256(sha256);
    const name = digest.slice(0, 2);
    const path = joinContainedArtifactPath(layout.rootPath, layout.sha256.path, name);
    const existing = readEntry(path);
    if (existing === undefined && !createIfMissing) {
      return undefined;
    }
    if (existing !== undefined) {
      assertPrivateDirectoryStats(path, existing, layout.root.device);
      return { directory: bindDirectory(path, existing, true), created: false };
    }
    return ensurePrivateChildDirectory(layout.rootPath, layout.sha256, name, layout.root.device);
  }

  openStagingFile(
    layout: ArtifactStorageLayout,
    uploadId: string,
    writable: boolean,
    createIfMissing: boolean,
  ): ArtifactStorageOpenedFile | undefined {
    this.#assertLayout(layout);
    const path = joinContainedArtifactPath(
      layout.rootPath,
      layout.staging.path,
      artifactStagingFilename(uploadId),
    );
    return this.#openPrivateFile(
      layout,
      layout.staging,
      path,
      "staging",
      writable,
      createIfMissing,
      [1n],
    );
  }

  openPublicationTemporaryFile(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    uploadId: string,
    finalizationId: string,
    sha256: string,
    createIfMissing: boolean,
  ): ArtifactStorageOpenedFile | undefined {
    this.#assertLayoutAndShard(layout, shard, sha256);
    const temporaryPath = this.#publicationTemporaryPath(layout, shard, uploadId, finalizationId);
    const objectPath = this.#objectPath(layout, shard, sha256);
    const temporaryStats = readEntry(temporaryPath);
    let allowedLinkCounts: readonly bigint[] = [1n];
    if (temporaryStats?.nlink === 2n) {
      const objectStats = readEntry(objectPath);
      if (
        objectStats === undefined ||
        !identitiesMatch(identityOf(temporaryStats), identityOf(objectStats))
      ) {
        throw integrity(
          `Artifact publication temporary ${temporaryPath} has an external hard link.`,
        );
      }
      assertPrivateFileStats(objectPath, objectStats, layout.root.device, [2n]);
      allowedLinkCounts = [2n];
    }
    return this.#openPrivateFile(
      layout,
      shard,
      temporaryPath,
      "publication-temporary",
      allowedLinkCounts.includes(1n),
      createIfMissing,
      allowedLinkCounts,
    );
  }

  openObjectFile(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    sha256: string,
    publicationTemporaryIdentity?: ArtifactStorageFileIdentity,
  ): ArtifactStorageFileHandle | undefined {
    this.#assertLayoutAndShard(layout, shard, sha256);
    const objectPath = this.#objectPath(layout, shard, sha256);
    const objectStats = readEntry(objectPath);
    if (objectStats === undefined) {
      return undefined;
    }
    const allowedLinkCounts: readonly bigint[] =
      objectStats.nlink === 2n &&
      publicationTemporaryIdentity !== undefined &&
      identitiesMatch(identityOf(objectStats), publicationTemporaryIdentity)
        ? [2n]
        : [1n];
    return this.#openPrivateFile(
      layout,
      shard,
      objectPath,
      "object",
      false,
      false,
      allowedLinkCounts,
    )?.file;
  }

  fileSize(file: ArtifactStorageFileHandle): number {
    const stats = this.#assertOpenFile(file);
    if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw integrity(`Artifact storage file ${file.path} exceeds the supported size range.`);
    }
    return Number(stats.size);
  }

  read(
    file: ArtifactStorageFileHandle,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    fileOffset: number,
  ): number {
    this.#assertIoRange(buffer, bufferOffset, length, fileOffset);
    this.#assertOpenFile(file);
    const bytesRead = readSync(file.descriptor, buffer, bufferOffset, length, fileOffset);
    this.#assertOpenFile(file);
    return bytesRead;
  }

  write(
    file: ArtifactStorageFileHandle,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    fileOffset: number,
  ): number {
    if (!file.writable || file.kind === "object") {
      throw integrity(`Artifact storage file ${file.path} is not writable.`);
    }
    this.#assertIoRange(buffer, bufferOffset, length, fileOffset);
    this.#assertOpenFile(file);
    const bytesWritten = writeSync(file.descriptor, buffer, bufferOffset, length, fileOffset);
    this.#assertOpenFile(file);
    return bytesWritten;
  }

  syncFile(file: ArtifactStorageFileHandle): void {
    this.#assertOpenFile(file);
    fsyncSync(file.descriptor);
    this.#assertOpenFile(file);
  }

  syncDirectory(directory: ArtifactStorageDirectoryBinding): void {
    syncBoundDirectory(directory);
  }

  closeFile(file: ArtifactStorageFileHandle): void {
    closeSync(file.descriptor);
  }

  publishTemporaryWithoutReplacement(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    uploadId: string,
    finalizationId: string,
    sha256: string,
    expectedTemporaryIdentity: ArtifactStorageFileIdentity,
  ): "published" | "exists" {
    this.#assertLayoutAndShard(layout, shard, sha256);
    const temporaryPath = this.#publicationTemporaryPath(layout, shard, uploadId, finalizationId);
    const objectPath = this.#objectPath(layout, shard, sha256);
    const temporaryStats = this.#assertPathFile(temporaryPath, shard, expectedTemporaryIdentity, [
      1n,
    ]);
    try {
      linkSync(temporaryPath, objectPath);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
      this.#assertPathFile(temporaryPath, shard, expectedTemporaryIdentity, [1n]);
      this.#assertPathFile(objectPath, shard, undefined, [1n]);
      return "exists";
    }

    const linkedTemporary = this.#assertPathFile(temporaryPath, shard, expectedTemporaryIdentity, [
      2n,
    ]);
    const linkedObject = this.#assertPathFile(objectPath, shard, expectedTemporaryIdentity, [2n]);
    if (
      !identitiesMatch(identityOf(temporaryStats), identityOf(linkedTemporary)) ||
      !identitiesMatch(identityOf(linkedTemporary), identityOf(linkedObject))
    ) {
      throw integrity("Artifact CAS publication changed inode identity during link creation.");
    }
    return "published";
  }

  unlinkPublicationTemporary(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    uploadId: string,
    finalizationId: string,
    sha256: string,
    expectedIdentity: ArtifactStorageFileIdentity,
  ): boolean {
    this.#assertLayoutAndShard(layout, shard, sha256);
    const temporaryPath = this.#publicationTemporaryPath(layout, shard, uploadId, finalizationId);
    const temporaryStats = readEntry(temporaryPath);
    if (temporaryStats === undefined) {
      return false;
    }
    const linkCount = temporaryStats.nlink;
    if (linkCount !== 1n && linkCount !== 2n) {
      throw integrity(
        `Artifact publication temporary ${temporaryPath} has an unrecognized hard link.`,
      );
    }
    this.#assertPathFile(temporaryPath, shard, expectedIdentity, [linkCount]);
    const objectPath = this.#objectPath(layout, shard, sha256);
    if (linkCount === 2n) {
      this.#assertPathFile(objectPath, shard, expectedIdentity, [2n]);
    }
    unlinkSync(temporaryPath);
    if (readEntry(temporaryPath) !== undefined) {
      throw integrity(`Artifact publication temporary ${temporaryPath} survived unlink.`);
    }
    if (linkCount === 2n) {
      this.#assertPathFile(objectPath, shard, expectedIdentity, [1n]);
    }
    return true;
  }

  unlinkStaging(
    layout: ArtifactStorageLayout,
    uploadId: string,
    expectedIdentity: ArtifactStorageFileIdentity,
  ): boolean {
    this.#assertLayout(layout);
    const path = joinContainedArtifactPath(
      layout.rootPath,
      layout.staging.path,
      artifactStagingFilename(uploadId),
    );
    if (readEntry(path) === undefined) {
      return false;
    }
    this.#assertPathFile(path, layout.staging, expectedIdentity, [1n]);
    unlinkSync(path);
    if (readEntry(path) !== undefined) {
      throw integrity(`Artifact staging file ${path} survived unlink.`);
    }
    return true;
  }

  #assertLayout(layout: ArtifactStorageLayout): void {
    if (!isAbsolute(layout.rootPath) || resolve(layout.rootPath) !== layout.root.path) {
      throw integrity("Artifact storage layout root path does not match its bound root.");
    }
    for (const ancestor of layout.ancestors) {
      assertBoundDirectory(ancestor);
    }
    for (const directory of [layout.root, layout.staging, layout.objects, layout.sha256]) {
      assertBoundDirectory(directory);
      if (directory.device !== layout.root.device) {
        throw integrity(
          `Artifact managed directory ${directory.path} crossed a filesystem device boundary.`,
        );
      }
    }
    if (
      layout.staging.path !==
        joinContainedArtifactPath(layout.rootPath, layout.root.path, "staging") ||
      layout.objects.path !==
        joinContainedArtifactPath(layout.rootPath, layout.root.path, "objects") ||
      layout.sha256.path !==
        joinContainedArtifactPath(layout.rootPath, layout.objects.path, "sha256")
    ) {
      throw integrity("Artifact storage layout contains an unexpected managed directory path.");
    }
  }

  #assertLayoutAndShard(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    sha256: string,
  ): void {
    this.#assertLayout(layout);
    const digest = requireArtifactSha256(sha256);
    const expectedPath = joinContainedArtifactPath(
      layout.rootPath,
      layout.sha256.path,
      digest.slice(0, 2),
    );
    if (shard.path !== expectedPath || shard.device !== layout.root.device) {
      throw integrity("Artifact object shard does not match the requested digest.");
    }
    assertBoundDirectory(shard);
  }

  #publicationTemporaryPath(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    uploadId: string,
    finalizationId: string,
  ): string {
    return joinContainedArtifactPath(
      layout.rootPath,
      shard.path,
      artifactPublicationTemporaryFilename(uploadId, finalizationId),
    );
  }

  #objectPath(
    layout: ArtifactStorageLayout,
    shard: ArtifactStorageDirectoryBinding,
    sha256: string,
  ): string {
    return joinContainedArtifactPath(layout.rootPath, shard.path, requireArtifactSha256(sha256));
  }

  #openPrivateFile(
    layout: ArtifactStorageLayout,
    parent: ArtifactStorageDirectoryBinding,
    path: string,
    kind: ArtifactStorageFileKind,
    writable: boolean,
    createIfMissing: boolean,
    allowedLinkCounts: readonly bigint[],
  ): ArtifactStorageOpenedFile | undefined {
    this.#assertLayout(layout);
    assertBoundDirectory(parent);
    assertContained(layout.rootPath, path);
    if (createIfMissing && !writable) {
      throw new TypeError("New artifact storage files must be opened writable.");
    }

    const accessFlags = writable ? constants.O_RDWR : constants.O_RDONLY;
    let descriptor: number;
    let created = false;
    try {
      descriptor = openSync(path, accessFlags | constants.O_NOFOLLOW);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        if (hasCode(error, "ELOOP") || hasCode(error, "EISDIR") || hasCode(error, "ENOTDIR")) {
          throw integrity(`Artifact storage path ${path} is not a safe regular file.`, error);
        }
        throw error;
      }
      if (!createIfMissing) {
        return undefined;
      }
      try {
        descriptor = openSync(
          path,
          accessFlags | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          Number(privateFileMode),
        );
        created = true;
      } catch (createError) {
        if (hasCode(createError, "EEXIST")) {
          return this.#openPrivateFile(
            layout,
            parent,
            path,
            kind,
            writable,
            false,
            allowedLinkCounts,
          );
        }
        throw createError;
      }
    }

    let operationError: unknown;
    let opened: ArtifactStorageOpenedFile | undefined;
    try {
      if (created) {
        fchmodSync(descriptor, Number(privateFileMode));
      }
      const descriptorStats = fstatSync(descriptor, { bigint: true });
      assertPrivateFileStats(path, descriptorStats, parent.device, allowedLinkCounts);
      const pathStats = this.#assertPathFile(
        path,
        parent,
        identityOf(descriptorStats),
        allowedLinkCounts,
      );
      if (!identitiesMatch(identityOf(descriptorStats), identityOf(pathStats))) {
        throw integrity(`Artifact storage path ${path} changed while it was opened.`);
      }
      opened = {
        file: {
          descriptor,
          path,
          parent,
          identity: identityOf(descriptorStats),
          device: descriptorStats.dev,
          kind,
          allowedLinkCounts: Object.freeze([...allowedLinkCounts]),
          writable,
        },
        created,
      };
    } catch (error) {
      operationError = error;
    }

    if (opened === undefined) {
      closeAfterOperation(
        descriptor,
        operationError,
        `Unable to validate and close artifact storage file ${path}.`,
      );
      throw integrity(`Artifact storage file ${path} could not be opened.`);
    }
    return opened;
  }

  #assertPathFile(
    path: string,
    parent: ArtifactStorageDirectoryBinding,
    expectedIdentity: ArtifactStorageFileIdentity | undefined,
    allowedLinkCounts: readonly bigint[],
  ): BigIntStats {
    assertBoundDirectory(parent);
    const stats = readEntry(path);
    if (stats === undefined) {
      throw integrity(`Artifact storage file ${path} disappeared after binding.`);
    }
    assertPrivateFileStats(path, stats, parent.device, allowedLinkCounts);
    if (expectedIdentity !== undefined && !identitiesMatch(identityOf(stats), expectedIdentity)) {
      throw integrity(`Artifact storage file ${path} changed inode identity after binding.`);
    }
    assertBoundDirectory(parent);
    return stats;
  }

  #assertOpenFile(file: ArtifactStorageFileHandle): BigIntStats {
    assertBoundDirectory(file.parent);
    const stats = fstatSync(file.descriptor, { bigint: true });
    assertPrivateFileStats(file.path, stats, file.device, file.allowedLinkCounts);
    if (!identitiesMatch(identityOf(stats), file.identity)) {
      throw integrity(`Artifact storage file ${file.path} changed descriptor identity.`);
    }
    this.#assertPathFile(file.path, file.parent, file.identity, file.allowedLinkCounts);
    return stats;
  }

  #assertIoRange(buffer: Buffer, bufferOffset: number, length: number, fileOffset: number): void {
    if (
      !Number.isSafeInteger(bufferOffset) ||
      !Number.isSafeInteger(length) ||
      !Number.isSafeInteger(fileOffset) ||
      bufferOffset < 0 ||
      length < 0 ||
      fileOffset < 0 ||
      bufferOffset + length > buffer.byteLength
    ) {
      throw new TypeError("Artifact file I/O requires a bounded safe-integer range.");
    }
  }
}
