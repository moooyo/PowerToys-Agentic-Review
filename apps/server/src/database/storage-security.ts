import type { BigIntStats } from "node:fs";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

const privateDirectoryMode = 0o700n;
const privateFileMode = 0o600n;
const permissionBits = 0o7777n;
const stickyBit = 0o1000n;
const groupOrOtherWriteBits = 0o022n;
const otherWriteBit = 0o002n;
const sqliteSidecarSuffixes = ["-journal", "-wal", "-shm"] as const;

export const maximumDatabaseStorageEntries = 10;
export const databaseInitializingMarkerFilename = ".agentic-review-database-initializing";
export const databaseInitializationMarkerFilename = ".agentic-review-database-initialized";
export const databaseInitializationMarkerContent = "agentic-review-database-initialization-v2\n";
const safeDatabaseBasenamePattern = /^[A-Za-z0-9._-]+$/u;

export interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface DatabaseStorageSnapshot {
  readonly databaseExisted: boolean;
  readonly databaseSize: bigint;
  readonly initializationState: "fresh" | "initialized";
}

interface DirectorySnapshot {
  readonly identity: FileIdentity;
  readonly mode: bigint;
  readonly path: string;
  readonly userId: bigint;
}

interface PreparedPrivateDirectory {
  readonly ancestors: readonly DirectorySnapshot[];
  readonly path: string;
  readonly stats: BigIntStats;
}

interface DataDirectoryState {
  readonly databaseSidecarExists: boolean;
  readonly databaseStats: BigIntStats | undefined;
  readonly initializedMarkerIdentity: FileIdentity | undefined;
  readonly initializingMarkerIdentity: FileIdentity | undefined;
}

export interface OpenPrivateRegularFile {
  readonly descriptor: number;
  readonly identity: FileIdentity;
}

export interface FreshDatabaseCreationOperations<TMarker, TDatabase> {
  createDatabase(): TDatabase;
  createInitializingMarker(): TMarker;
  syncDataDirectory(): void;
}

export const createDurableFreshDatabaseEntries = <TMarker, TDatabase>(
  operations: FreshDatabaseCreationOperations<TMarker, TDatabase>,
): { readonly database: TDatabase; readonly marker: TMarker } => {
  const marker = operations.createInitializingMarker();
  operations.syncDataDirectory();
  const database = operations.createDatabase();
  operations.syncDataDirectory();
  return { database, marker };
};

export const synchronizeCreatedDirectoryChain = (
  createdDirectories: readonly string[],
  syncDirectory: (path: string) => void,
): void => {
  for (const path of createdDirectories.toReversed()) {
    syncDirectory(path);
    syncDirectory(dirname(path));
  }
};

const readEntry = (path: string): BigIntStats | undefined => {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const identityOf = (stats: BigIntStats): FileIdentity => ({
  device: stats.dev,
  inode: stats.ino,
});

const identitiesMatch = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device && left.inode === right.inode;

const currentEffectiveUserId = (): bigint => {
  if (process.platform === "win32" || typeof process.geteuid !== "function") {
    throw new Error(
      "Secure Agentic Review Server database ownership checks require a supported POSIX platform.",
    );
  }
  return BigInt(process.geteuid());
};

const assertPrivateModeAndOwner = (
  path: string,
  stats: BigIntStats,
  expectedMode: bigint,
): void => {
  if (process.platform === "win32") {
    return;
  }
  if (stats.uid !== currentEffectiveUserId()) {
    throw new Error(`Database storage path ${path} must be owned by the Server process user.`);
  }
  const actualMode = stats.mode & permissionBits;
  if (actualMode !== expectedMode) {
    throw new Error(
      `Database storage path ${path} must have mode 0${expectedMode.toString(8)}; found 0${actualMode.toString(8)}.`,
    );
  }
};

const assertSecureAncestorModeAndOwner = (path: string, stats: BigIntStats): void => {
  const effectiveUserId = currentEffectiveUserId();
  if (stats.uid !== 0n && stats.uid !== effectiveUserId) {
    throw new Error(
      `Database storage ancestor ${path} must be owned by root or the Server process user.`,
    );
  }
  const mode = stats.mode & permissionBits;
  const rootOwnedStickyWorldWritable =
    stats.uid === 0n && (mode & stickyBit) !== 0n && (mode & otherWriteBit) !== 0n;
  if ((mode & groupOrOtherWriteBits) !== 0n && !rootOwnedStickyWorldWritable) {
    throw new Error(
      `Database storage ancestor ${path} must not be writable by group or other users.`,
    );
  }
};

const assertPrivateDirectory = (path: string): BigIntStats => {
  const stats = readEntry(path);
  if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Database storage directory ${path} must be a real directory.`);
  }
  assertPrivateModeAndOwner(path, stats, privateDirectoryMode);
  return stats;
};

const assertSecureAncestorDirectory = (path: string): BigIntStats => {
  const stats = readEntry(path);
  if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Database storage ancestor ${path} must be a real directory.`);
  }

  assertSecureAncestorModeAndOwner(path, stats);
  return stats;
};

const snapshotDirectory = (path: string, stats: BigIntStats): DirectorySnapshot => ({
  identity: identityOf(stats),
  mode: stats.mode & permissionBits,
  path,
  userId: stats.uid,
});

const lexicalDirectoryPaths = (directoryPath: string): readonly string[] => {
  const root = parse(directoryPath).root;
  const paths = [root];
  let current = root;
  for (const segment of relative(root, directoryPath).split(sep).filter(Boolean)) {
    current = join(current, segment);
    paths.push(current);
  }
  return paths;
};

const preparePrivateDirectory = (directoryPath: string, name: string): PreparedPrivateDirectory => {
  const resolvedPath = resolve(directoryPath);
  const paths = lexicalDirectoryPaths(resolvedPath);
  const missingPaths: string[] = [];
  let missing = false;
  for (const [index, path] of paths.entries()) {
    const stats = readEntry(path);
    if (stats === undefined) {
      missing = true;
      missingPaths.push(path);
      continue;
    }
    if (missing) {
      throw new Error(`${name} ${resolvedPath} has an inconsistent lexical path.`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${name} lexical path component ${path} must not be a symbolic link.`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${name} lexical path component ${path} must be a directory.`);
    }
    if (index === paths.length - 1) {
      assertPrivateDirectory(path);
    } else {
      assertSecureAncestorDirectory(path);
    }
  }

  if (missing) {
    mkdirSync(resolvedPath, { recursive: true, mode: Number(privateDirectoryMode) });
  }

  const ancestors: DirectorySnapshot[] = [];
  const directorySnapshots = new Map<string, DirectorySnapshot>();
  const missingPathSet = new Set(missingPaths);
  let directoryStats: BigIntStats | undefined;
  for (const [index, path] of paths.entries()) {
    const stats = readEntry(path);
    if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${name} lexical path component ${path} must be a real directory.`);
    }
    if (index === paths.length - 1) {
      directoryStats = assertPrivateDirectory(path);
      directorySnapshots.set(path, snapshotDirectory(path, directoryStats));
    } else {
      const validatedStats = missingPathSet.has(path)
        ? assertPrivateDirectory(path)
        : assertSecureAncestorDirectory(path);
      const snapshot = snapshotDirectory(path, validatedStats);
      ancestors.push(snapshot);
      directorySnapshots.set(path, snapshot);
    }
  }
  if (directoryStats === undefined) {
    throw new Error(`${name} ${resolvedPath} could not be prepared.`);
  }
  synchronizeCreatedDirectoryChain(missingPaths, (path) => {
    const snapshot = directorySnapshots.get(path);
    if (snapshot === undefined) {
      throw new Error(`${name} ${resolvedPath} has no durability binding for ${path}.`);
    }
    syncBoundDirectory(
      path,
      `${name} durability component`,
      snapshot.identity,
      missingPathSet.has(path),
    );
  });
  return { ancestors, path: resolvedPath, stats: directoryStats };
};

const assertAncestorChain = (ancestors: readonly DirectorySnapshot[]): void => {
  for (const expected of ancestors) {
    const stats = assertSecureAncestorDirectory(expected.path);
    const mode = stats.mode & permissionBits;
    if (
      !identitiesMatch(identityOf(stats), expected.identity) ||
      stats.uid !== expected.userId ||
      mode !== expected.mode
    ) {
      throw new Error(
        `Database storage ancestor ${expected.path} changed identity, owner, or mode after it was bound.`,
      );
    }
  }
};

const throwOperationAndCloseErrors = (
  operationError: unknown | undefined,
  closeError: unknown | undefined,
  message: string,
): void => {
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

const syncBoundDirectory = (
  path: string,
  name: string,
  expectedIdentity: FileIdentity,
  privateDirectory: boolean,
): void => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let operationError: unknown;
  try {
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    if (!descriptorStats.isDirectory()) {
      throw new Error(`${name} ${path} must remain a directory while it is synchronized.`);
    }
    if (privateDirectory) {
      assertPrivateModeAndOwner(path, descriptorStats, privateDirectoryMode);
    } else {
      assertSecureAncestorModeAndOwner(path, descriptorStats);
    }
    if (!identitiesMatch(identityOf(descriptorStats), expectedIdentity)) {
      throw new Error(`${name} ${path} changed identity before it was synchronized.`);
    }
    const pathStats = privateDirectory
      ? assertPrivateDirectory(path)
      : assertSecureAncestorDirectory(path);
    if (!identitiesMatch(identityOf(pathStats), expectedIdentity)) {
      throw new Error(`${name} ${path} changed identity before it was synchronized.`);
    }
    fsyncSync(descriptor);
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  throwOperationAndCloseErrors(
    operationError,
    closeError,
    `Unable to synchronize and close ${name} ${path}.`,
  );
};

export const assertPrivateRegularFile = (
  path: string,
  name: string,
  expectedIdentity?: FileIdentity,
): FileIdentity | undefined => {
  const stats = readEntry(path);
  if (stats === undefined) {
    if (expectedIdentity !== undefined) {
      throw new Error(`${name} ${path} disappeared after its identity was bound.`);
    }
    return undefined;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${name} ${path} must be a regular file and must not be a symbolic link.`);
  }
  if (stats.nlink !== 1n) {
    throw new Error(`${name} ${path} must not have hard links.`);
  }
  assertPrivateModeAndOwner(path, stats, privateFileMode);
  const identity = identityOf(stats);
  if (expectedIdentity !== undefined && !identitiesMatch(identity, expectedIdentity)) {
    throw new Error(`${name} ${path} changed identity after it was bound.`);
  }
  return identity;
};

export const createPrivateRegularFile = (
  path: string,
  name: string,
  requireNew = false,
): FileIdentity => {
  const existing = assertPrivateRegularFile(path, name);
  if (existing !== undefined) {
    if (requireNew) {
      throw new Error(`${name} ${path} already exists.`);
    }
    return existing;
  }

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let descriptor: number | undefined;
  let createdIdentity: FileIdentity | undefined;
  let operationError: unknown;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      Number(privateFileMode),
    );
    if (process.platform !== "win32") {
      fchmodSync(descriptor, Number(privateFileMode));
    }
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    if (!descriptorStats.isFile() || descriptorStats.nlink !== 1n) {
      throw new Error(`${name} ${path} was not created as a private regular file.`);
    }
    assertPrivateModeAndOwner(path, descriptorStats, privateFileMode);
    createdIdentity = identityOf(descriptorStats);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      if (requireNew) {
        operationError = new Error(`${name} ${path} already exists.`, { cause: error });
      }
    } else {
      operationError = error;
    }
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  throwOperationAndCloseErrors(
    operationError,
    closeError,
    `Unable to create and close ${name} ${path}.`,
  );

  const created = assertPrivateRegularFile(path, name, createdIdentity);
  if (created === undefined) {
    throw new Error(`${name} ${path} could not be created.`);
  }
  return created;
};

export const assertPrivateSqliteSidecars = (databasePath: string, name: string): void => {
  for (const suffix of sqliteSidecarSuffixes) {
    assertPrivateRegularFile(`${databasePath}${suffix}`, `${name} ${suffix} sidecar`);
  }
};

export const openPrivateRegularFile = (
  path: string,
  name: string,
  expectedIdentity?: FileIdentity,
  writable = false,
): OpenPrivateRegularFile => {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const descriptor = openSync(path, (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollow);
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n) {
      throw new Error(`${name} ${path} must be an open private regular file.`);
    }
    assertPrivateModeAndOwner(path, stats, privateFileMode);
    const identity = identityOf(stats);
    if (expectedIdentity !== undefined && !identitiesMatch(identity, expectedIdentity)) {
      throw new Error(`${name} ${path} changed identity before it was opened.`);
    }
    assertPrivateRegularFile(path, name, identity);
    return { descriptor, identity };
  } catch (error) {
    let closeError: unknown;
    try {
      closeSync(descriptor);
    } catch (caughtCloseError) {
      closeError = caughtCloseError;
    }
    throwOperationAndCloseErrors(
      error,
      closeError,
      `Unable to validate and close ${name} ${path}.`,
    );
    throw error;
  }
};

export const databaseInitializationMarkerPath = (databasePath: string): string =>
  join(dirname(resolve(databasePath)), databaseInitializationMarkerFilename);

export const databaseInitializingMarkerPath = (databasePath: string): string =>
  join(dirname(resolve(databasePath)), databaseInitializingMarkerFilename);

export const secureDatabaseBasename = (databasePath: string): string => {
  const databaseName = basename(databasePath);
  if (
    !safeDatabaseBasenamePattern.test(databaseName) ||
    databaseName === "." ||
    databaseName === ".." ||
    databaseName === databaseInitializingMarkerFilename ||
    databaseName === databaseInitializationMarkerFilename
  ) {
    throw new Error(
      `Database filename ${databaseName || "<empty>"} must match [A-Za-z0-9._-]+ and must not be reserved.`,
    );
  }
  return databaseName;
};

const assertPrivateFixedContentFile = (
  path: string,
  name: string,
  expectedContent: string,
  expectedIdentity?: FileIdentity,
): FileIdentity | undefined => {
  const identity = assertPrivateRegularFile(path, name, expectedIdentity);
  if (identity === undefined) {
    return undefined;
  }

  const expectedSize = BigInt(Buffer.byteLength(expectedContent, "utf8"));
  const opened = openPrivateRegularFile(path, name, identity);
  let operationError: unknown;
  try {
    const stats = fstatSync(opened.descriptor, { bigint: true });
    if (stats.size !== expectedSize) {
      throw new Error(`${name} ${path} must contain exactly ${expectedSize} bytes.`);
    }
    const contentBytes = Buffer.alloc(Number(expectedSize));
    let offset = 0;
    while (offset < contentBytes.byteLength) {
      const bytesRead = readSync(
        opened.descriptor,
        contentBytes,
        offset,
        contentBytes.byteLength - offset,
        null,
      );
      if (bytesRead === 0) {
        throw new Error(`${name} ${path} was truncated while read.`);
      }
      offset += bytesRead;
    }
    const extraByte = Buffer.alloc(1);
    if (readSync(opened.descriptor, extraByte, 0, 1, null) !== 0) {
      throw new Error(`${name} ${path} grew while read.`);
    }
    const content = contentBytes.toString("utf8");
    if (content !== expectedContent) {
      throw new Error(`${name} ${path} has unsupported content.`);
    }
    const finalStats = fstatSync(opened.descriptor, { bigint: true });
    if (
      finalStats.size !== expectedSize ||
      !identitiesMatch(identityOf(finalStats), opened.identity)
    ) {
      throw new Error(`${name} ${path} changed while read.`);
    }
    assertPrivateRegularFile(path, name, opened.identity);
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    closeSync(opened.descriptor);
  } catch (error) {
    closeError = error;
  }
  throwOperationAndCloseErrors(
    operationError,
    closeError,
    `Unable to validate and close ${name} ${path}.`,
  );
  return opened.identity;
};

const assertDatabaseInitializationMarker = (
  markerPath: string,
  expectedIdentity?: FileIdentity,
): FileIdentity | undefined =>
  assertPrivateFixedContentFile(
    markerPath,
    "Database initialization marker",
    databaseInitializationMarkerContent,
    expectedIdentity,
  );

const createDatabaseInitializationMarker = (markerPath: string): FileIdentity => {
  let descriptor: number | undefined;
  let identity: FileIdentity | undefined;
  let operationError: unknown;
  try {
    descriptor = openSync(
      markerPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      Number(privateFileMode),
    );
    fchmodSync(descriptor, Number(privateFileMode));
    const content = Buffer.from(databaseInitializationMarkerContent, "utf8");
    const expectedSize = BigInt(content.byteLength);
    let offset = 0;
    while (offset < content.byteLength) {
      const written = writeSync(descriptor, content, offset, content.byteLength - offset);
      if (written === 0) {
        throw new Error(`Database initialization marker ${markerPath} could not be fully written.`);
      }
      offset += written;
    }
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n || stats.size !== expectedSize) {
      throw new Error(
        `Database initialization marker ${markerPath} was not created as a private regular file.`,
      );
    }
    assertPrivateModeAndOwner(markerPath, stats, privateFileMode);
    identity = identityOf(stats);
    assertPrivateRegularFile(markerPath, "Database initialization marker", identity);
    fsyncSync(descriptor);
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  throwOperationAndCloseErrors(
    operationError,
    closeError,
    `Unable to create and close database initialization marker ${markerPath}.`,
  );
  if (identity === undefined) {
    throw new Error(`Database initialization marker ${markerPath} could not be created.`);
  }
  return identity;
};

const inspectDataDirectory = (databasePath: string): DataDirectoryState => {
  const directoryPath = dirname(databasePath);
  const databaseName = secureDatabaseBasename(databasePath);

  const initializedMarkerPath = databaseInitializationMarkerPath(databasePath);
  const initializingMarkerPath = databaseInitializingMarkerPath(databasePath);
  const ownerLockName = `${databaseName}.owner-lock.sqlite`;
  const databaseSidecarNames = sqliteSidecarSuffixes.map((suffix) => `${databaseName}${suffix}`);
  const ownerLockSidecarNames = sqliteSidecarSuffixes.map((suffix) => `${ownerLockName}${suffix}`);
  const allowedNames = new Set([
    databaseName,
    ...databaseSidecarNames,
    ownerLockName,
    ...ownerLockSidecarNames,
    databaseInitializingMarkerFilename,
    databaseInitializationMarkerFilename,
  ]);
  if (allowedNames.size !== maximumDatabaseStorageEntries) {
    throw new Error("Database storage allowlist cardinality is invalid.");
  }
  const handle = opendirSync(directoryPath);
  let databaseIdentity: FileIdentity | undefined;
  let databaseSidecarExists = false;
  let initializedMarkerIdentity: FileIdentity | undefined;
  let initializingMarkerIdentity: FileIdentity | undefined;
  let scanError: unknown;
  try {
    let entryCount = 0;
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      entryCount += 1;
      if (entryCount > maximumDatabaseStorageEntries) {
        throw new Error(
          `Database storage directory ${directoryPath} exceeds its ${maximumDatabaseStorageEntries}-entry allowlist.`,
        );
      }
      const entryName = entry.name;
      if (!allowedNames.has(entryName)) {
        throw new Error(
          `Database storage directory ${directoryPath} contains unexpected entry ${entryName}.`,
        );
      }
      const entryPath = join(directoryPath, entryName);
      if (entryName === databaseInitializationMarkerFilename) {
        initializedMarkerIdentity = assertDatabaseInitializationMarker(initializedMarkerPath);
        continue;
      }
      if (entryName === databaseInitializingMarkerFilename) {
        initializingMarkerIdentity = assertDatabaseInitializationMarker(initializingMarkerPath);
        continue;
      }
      const identity = assertPrivateRegularFile(entryPath, "Database storage entry");
      if (entryName === databaseName) {
        databaseIdentity = identity;
      } else if (databaseSidecarNames.includes(entryName)) {
        databaseSidecarExists = true;
      }
    }
  } catch (error) {
    scanError = error;
  }

  let closeError: unknown;
  try {
    handle.closeSync();
  } catch (error) {
    closeError = error;
  }
  throwOperationAndCloseErrors(
    scanError,
    closeError,
    `Unable to inspect and close database storage directory ${directoryPath}.`,
  );

  const databaseStats = readEntry(databasePath);
  if (
    databaseStats !== undefined &&
    (databaseIdentity === undefined ||
      !identitiesMatch(identityOf(databaseStats), databaseIdentity))
  ) {
    throw new Error(`Database ${databasePath} changed identity during storage validation.`);
  }
  return {
    databaseSidecarExists,
    databaseStats,
    initializedMarkerIdentity,
    initializingMarkerIdentity,
  };
};

const classifyDatabaseState = (
  databasePath: string,
  state: DataDirectoryState,
): DatabaseStorageSnapshot["initializationState"] => {
  if (state.initializingMarkerIdentity !== undefined) {
    throw new Error(
      `Database ${databasePath} has an incomplete initialization marker; recovery is required.`,
    );
  }
  if (state.initializedMarkerIdentity !== undefined) {
    if (state.databaseStats === undefined || state.databaseStats.size === 0n) {
      throw new Error(
        `Initialized database ${databasePath} is missing or empty; recovery is required.`,
      );
    }
    return "initialized";
  }
  if (state.databaseStats === undefined) {
    if (state.databaseSidecarExists) {
      throw new Error(
        `Database ${databasePath} is missing while SQLite sidecar history exists; recovery is required.`,
      );
    }
    return "fresh";
  }
  if (state.databaseStats.size === 0n) {
    throw new Error(`Uninitialized database ${databasePath} is empty; recovery is required.`);
  }
  throw new Error(
    `Database ${databasePath} was not initialized by this Server version; rebuild is required.`,
  );
};

export const assertSecureDatabaseOwnerPlatform = (): void => {
  currentEffectiveUserId();
};

/**
 * The storage boundary trusts root and same-euid processes. Lexical ancestor validation and the
 * private 0700 leaf directory prevent other users from replacing path entries. node:sqlite does
 * not expose its opened file descriptor or VFS flags, so the Server revalidates identities during
 * startup and shutdown instead of adding filesystem work to every database request.
 */
export class DatabaseStorageBinding {
  readonly #ancestors: readonly DirectorySnapshot[];
  readonly #directoryIdentity: FileIdentity;
  #databaseIdentity: FileIdentity | undefined;
  #markerIdentity: FileIdentity | undefined;
  #markerState: "initialized" | "initializing" | undefined;

  public readonly databasePath: string;
  public readonly directoryPath: string;
  public readonly snapshot: DatabaseStorageSnapshot;

  private constructor(
    databasePath: string,
    directoryPath: string,
    directoryStats: BigIntStats,
    ancestors: readonly DirectorySnapshot[],
    databaseStats: BigIntStats | undefined,
    markerIdentity: FileIdentity | undefined,
    initializationState: DatabaseStorageSnapshot["initializationState"],
  ) {
    this.databasePath = databasePath;
    this.directoryPath = directoryPath;
    this.#ancestors = ancestors;
    this.#directoryIdentity = identityOf(directoryStats);
    this.#databaseIdentity = databaseStats === undefined ? undefined : identityOf(databaseStats);
    this.#markerIdentity = markerIdentity;
    this.#markerState = initializationState === "initialized" ? "initialized" : undefined;
    this.snapshot = {
      databaseExisted: databaseStats !== undefined,
      databaseSize: databaseStats?.size ?? 0n,
      initializationState,
    };
  }

  public static prepare(databasePath: string): DatabaseStorageBinding {
    assertSecureDatabaseOwnerPlatform();
    const databaseName = secureDatabaseBasename(databasePath);
    const resolvedPath = resolve(databasePath);
    const requestedDirectory = dirname(resolvedPath);
    const preparedDirectory = preparePrivateDirectory(
      requestedDirectory,
      "Database storage directory",
    );
    const canonicalDatabasePath = join(preparedDirectory.path, databaseName);
    const state = inspectDataDirectory(canonicalDatabasePath);
    const initializationState = classifyDatabaseState(canonicalDatabasePath, state);

    return new DatabaseStorageBinding(
      canonicalDatabasePath,
      preparedDirectory.path,
      preparedDirectory.stats,
      preparedDirectory.ancestors,
      state.databaseStats,
      state.initializedMarkerIdentity,
      initializationState,
    );
  }

  public createDatabaseFile(): void {
    this.assertDirectoryIdentity();
    const state = inspectDataDirectory(this.databasePath);
    if (this.snapshot.initializationState === "initialized") {
      if (classifyDatabaseState(this.databasePath, state) !== "initialized") {
        throw new Error(`Database ${this.databasePath} changed initialization state.`);
      }
      const identity = this.assertPreparedDatabaseIdentity();
      const markerIdentity = assertDatabaseInitializationMarker(
        databaseInitializationMarkerPath(this.databasePath),
        this.#markerIdentity,
      );
      if (markerIdentity === undefined || state.initializedMarkerIdentity === undefined) {
        throw new Error(
          `Database ${this.databasePath} lost its initialization marker; recovery is required.`,
        );
      }
      this.#databaseIdentity = identity;
      this.#markerIdentity = markerIdentity;
      return;
    }
    if (state.databaseStats !== undefined) {
      throw new Error(`Database ${this.databasePath} appeared after storage preparation.`);
    }
    if (classifyDatabaseState(this.databasePath, state) !== "fresh") {
      throw new Error(`Database ${this.databasePath} changed initialization state.`);
    }
    const created = createDurableFreshDatabaseEntries({
      createInitializingMarker: () =>
        createDatabaseInitializationMarker(databaseInitializingMarkerPath(this.databasePath)),
      syncDataDirectory: () => this.syncDirectory(),
      createDatabase: () => createPrivateRegularFile(this.databasePath, "Database", true),
    });
    this.#markerIdentity = created.marker;
    this.#markerState = "initializing";
    this.#databaseIdentity = created.database;
  }

  public assertDatabaseOpened(): void {
    this.assertDirectoryIdentity();
    const state = inspectDataDirectory(this.databasePath);
    const identity = this.assertPreparedDatabaseIdentity();
    if (this.#markerState === "initializing") {
      const markerIdentity = assertDatabaseInitializationMarker(
        databaseInitializingMarkerPath(this.databasePath),
        this.#markerIdentity,
      );
      if (
        markerIdentity === undefined ||
        state.initializingMarkerIdentity === undefined ||
        state.initializedMarkerIdentity !== undefined
      ) {
        throw new Error(`Database ${this.databasePath} changed its initialization marker state.`);
      }
      this.#databaseIdentity = identity;
      this.#markerIdentity = markerIdentity;
      return;
    }
    if (classifyDatabaseState(this.databasePath, state) !== "initialized") {
      throw new Error(`Database ${this.databasePath} is not durably initialized.`);
    }
    const markerIdentity = assertDatabaseInitializationMarker(
      databaseInitializationMarkerPath(this.databasePath),
      this.#markerIdentity,
    );
    if (markerIdentity === undefined) {
      throw new Error(`Database ${this.databasePath} has no initialization marker.`);
    }
    this.#databaseIdentity = identity;
    this.#markerIdentity = markerIdentity;
    this.#markerState = "initialized";
  }

  public finalizeDatabaseInitialization(): void {
    if (this.#markerState !== "initializing" || this.#markerIdentity === undefined) {
      throw new Error(`Database ${this.databasePath} has no active fresh initialization.`);
    }
    this.assertDirectoryIdentity();
    const state = inspectDataDirectory(this.databasePath);
    const identity = this.assertPreparedDatabaseIdentity();
    if (state.databaseStats?.size === 0n) {
      throw new Error(`Database ${this.databasePath} is empty after initialization.`);
    }
    const initializingIdentity = assertDatabaseInitializationMarker(
      databaseInitializingMarkerPath(this.databasePath),
      this.#markerIdentity,
    );
    if (
      initializingIdentity === undefined ||
      state.initializingMarkerIdentity === undefined ||
      state.initializedMarkerIdentity !== undefined
    ) {
      throw new Error(`Database ${this.databasePath} changed its initialization marker state.`);
    }
    renameSync(
      databaseInitializingMarkerPath(this.databasePath),
      databaseInitializationMarkerPath(this.databasePath),
    );
    const markerIdentity = assertDatabaseInitializationMarker(
      databaseInitializationMarkerPath(this.databasePath),
      initializingIdentity,
    );
    if (markerIdentity === undefined) {
      throw new Error(`Database ${this.databasePath} could not publish its initialization marker.`);
    }
    this.#databaseIdentity = identity;
    this.#markerIdentity = markerIdentity;
    this.#markerState = "initialized";
    this.syncDirectory();
  }

  public assertReady(): void {
    this.assertDirectoryIdentity();
    const state = inspectDataDirectory(this.databasePath);
    if (classifyDatabaseState(this.databasePath, state) !== "initialized") {
      throw new Error(`Database ${this.databasePath} is not durably initialized.`);
    }
    const identity = assertPrivateRegularFile(
      this.databasePath,
      "Database",
      this.#databaseIdentity,
    );
    if (identity === undefined || state.databaseStats?.size === 0n) {
      throw new Error(`Database ${this.databasePath} does not contain initialized data.`);
    }
    const markerIdentity = assertDatabaseInitializationMarker(
      databaseInitializationMarkerPath(this.databasePath),
      this.#markerIdentity,
    );
    if (markerIdentity === undefined || state.initializedMarkerIdentity === undefined) {
      throw new Error(`Database ${this.databasePath} has no initialization marker.`);
    }
    this.#databaseIdentity = identity;
    this.#markerIdentity = markerIdentity;
    this.#markerState = "initialized";
  }

  public assertDirectoryIdentity(): void {
    assertAncestorChain(this.#ancestors);
    const directoryStats = assertPrivateDirectory(this.directoryPath);
    if (!identitiesMatch(identityOf(directoryStats), this.#directoryIdentity)) {
      throw new Error(
        `Database storage directory ${this.directoryPath} changed identity after it was bound.`,
      );
    }
  }

  private assertPreparedDatabaseIdentity(): FileIdentity {
    const expectedIdentity = this.#databaseIdentity;
    if (expectedIdentity === undefined) {
      throw new Error(`Database ${this.databasePath} has no prepared identity.`);
    }
    const identity = assertPrivateRegularFile(this.databasePath, "Database", expectedIdentity);
    if (identity === undefined) {
      throw new Error(`Database ${this.databasePath} disappeared before it was opened.`);
    }
    return identity;
  }

  private syncDirectory(): void {
    syncBoundDirectory(
      this.directoryPath,
      "Database storage directory",
      this.#directoryIdentity,
      true,
    );
  }
}
