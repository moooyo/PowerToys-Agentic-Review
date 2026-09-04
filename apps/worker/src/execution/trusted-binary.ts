import { createHash } from "node:crypto";
import {
  lstat as nodeLstat,
  open as nodeOpen,
  realpath as nodeRealpath,
  stat as nodeStat,
} from "node:fs/promises";
import { win32 } from "node:path";

const maximumBinaryBytes = 1024 * 1024 * 1024;
const maximumWindowsPathLength = 32_767;
const hashChunkBytes = 64 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export type TrustedBinaryVerificationErrorCode =
  | "INVALID_TRUSTED_ROOT"
  | "BINARY_PATH_UNSAFE"
  | "BINARY_NOT_REGULAR"
  | "BINARY_IDENTITY_CHANGED"
  | "BINARY_DIGEST_MISMATCH"
  | "BINARY_READ_FAILED";

export class TrustedBinaryVerificationError extends Error {
  public constructor(
    public readonly code: TrustedBinaryVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TrustedBinaryVerificationError";
  }
}

export interface TrustedBinarySpec {
  readonly path: string;
  readonly expectedSha256: string;
}

export type TrustedBinaryStatValue = number | bigint;

export interface TrustedBinaryFileStat {
  readonly dev: TrustedBinaryStatValue;
  readonly ino: TrustedBinaryStatValue;
  readonly size: TrustedBinaryStatValue;
  readonly mtimeMs: TrustedBinaryStatValue;
  readonly ctimeMs: TrustedBinaryStatValue;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface TrustedBinaryFileHandle {
  stat(): Promise<TrustedBinaryFileStat>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface TrustedBinaryFileIO {
  lstat(path: string): Promise<TrustedBinaryFileStat>;
  stat(path: string): Promise<TrustedBinaryFileStat>;
  realpath(path: string): Promise<string>;
  open(path: string): Promise<TrustedBinaryFileHandle>;
}

export interface VerifyTrustedExecutionBinariesOptions {
  readonly trustedExecutableRoot: string;
  readonly processHost: TrustedBinarySpec;
  readonly codex: TrustedBinarySpec;
  readonly git: TrustedBinarySpec;
  readonly fileIO?: TrustedBinaryFileIO;
}

export interface VerifiedTrustedExecutionBinaries {
  readonly trustedExecutableRoot: string;
  readonly processHostPath: string;
  readonly codexPath: string;
  readonly gitPath: string;
}

interface FileMetadata {
  readonly dev: TrustedBinaryStatValue;
  readonly ino: TrustedBinaryStatValue;
  readonly size: TrustedBinaryStatValue;
  readonly mtimeMs: TrustedBinaryStatValue;
  readonly ctimeMs: TrustedBinaryStatValue;
}

interface VerifiedRoot {
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly metadata: FileMetadata;
}

interface VerifiedBinary {
  readonly canonicalPath: string;
  readonly identityKey: string;
}

const defaultFileIO: TrustedBinaryFileIO = {
  lstat: async (path) => nodeLstat(path, { bigint: true }),
  stat: async (path) => nodeStat(path, { bigint: true }),
  realpath: async (path) => nodeRealpath(path),
  open: async (path) => {
    const handle = await nodeOpen(path, "r");
    return {
      stat: async () => handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) => {
        const result = await handle.read(buffer, offset, length, position);
        return { bytesRead: result.bytesRead };
      },
      close: async () => handle.close(),
    };
  },
};

// Deployment must make the trusted executable root read-only to the Worker identity. This verifier
// relies on that property to close the remaining name-to-open TOCTOU window.
export async function verifyTrustedExecutionBinaries(
  options: VerifyTrustedExecutionBinariesOptions,
): Promise<Readonly<VerifiedTrustedExecutionBinaries>> {
  const fileIO = options.fileIO ?? defaultFileIO;
  const configuredRoot = normalizeSafeWindowsPath(
    options.trustedExecutableRoot,
    "INVALID_TRUSTED_ROOT",
    false,
  );
  if (windowsPathsEqual(configuredRoot, win32.parse(configuredRoot).root)) {
    throw verificationError(
      "INVALID_TRUSTED_ROOT",
      "Trusted executable root cannot be a filesystem root.",
    );
  }

  const binaryEntries = [
    ["processHost", options.processHost] as const,
    ["codex", options.codex] as const,
    ["git", options.git] as const,
  ];
  const configuredBinaries = binaryEntries.map(([name, spec]) => ({
    name,
    expectedSha256: validateExpectedDigest(spec.expectedSha256, name),
    path: normalizeSafeWindowsPath(spec.path, "BINARY_PATH_UNSAFE", true),
  }));
  assertDistinctPaths(configuredBinaries);

  const root = await verifyRoot(fileIO, configuredRoot);
  const verifiedPaths = new Map<string, string>();
  const verifiedPathKeys = new Set<string>();
  const verifiedIdentityKeys = new Set<string>();
  for (const binary of configuredBinaries) {
    if (!isStrictDescendant(root.canonicalPath, binary.path)) {
      throw verificationError(
        "BINARY_PATH_UNSAFE",
        `Trusted binary ${binary.name} must be strictly contained by the trusted root.`,
      );
    }
    const verifiedBinary = await verifyBinary(
      fileIO,
      root.canonicalPath,
      binary.name,
      binary.path,
      binary.expectedSha256,
    );
    const verifiedPathKey = windowsPathKey(verifiedBinary.canonicalPath);
    if (verifiedPathKeys.has(verifiedPathKey)) {
      throw verificationError(
        "BINARY_PATH_UNSAFE",
        "Trusted binary roles must resolve to distinct canonical Windows paths.",
      );
    }
    if (verifiedIdentityKeys.has(verifiedBinary.identityKey)) {
      throw verificationError(
        "BINARY_PATH_UNSAFE",
        "Trusted binary roles must identify distinct filesystem objects.",
      );
    }
    verifiedPathKeys.add(verifiedPathKey);
    verifiedIdentityKeys.add(verifiedBinary.identityKey);
    verifiedPaths.set(binary.name, verifiedBinary.canonicalPath);
  }
  await reverifyRoot(fileIO, root);

  return Object.freeze({
    trustedExecutableRoot: root.canonicalPath,
    processHostPath: requiredVerifiedPath(verifiedPaths, "processHost"),
    codexPath: requiredVerifiedPath(verifiedPaths, "codex"),
    gitPath: requiredVerifiedPath(verifiedPaths, "git"),
  });
}

async function verifyRoot(
  fileIO: TrustedBinaryFileIO,
  configuredPath: string,
): Promise<VerifiedRoot> {
  const rootStat = await rootIO(() => fileIO.lstat(configuredPath));
  if (!rootStat.isDirectory() || isLinkOrReparsePoint(rootStat)) {
    throw verificationError(
      "INVALID_TRUSTED_ROOT",
      "Trusted executable root must be a real directory and not a link or reparse point.",
    );
  }
  const canonicalPath = normalizeSafeWindowsPath(
    await rootIO(() => fileIO.realpath(configuredPath)),
    "INVALID_TRUSTED_ROOT",
    false,
  );
  if (!windowsPathsEqual(canonicalPath, configuredPath)) {
    throw verificationError(
      "INVALID_TRUSTED_ROOT",
      "Trusted executable root does not resolve to its configured Windows path.",
    );
  }
  return {
    configuredPath,
    canonicalPath,
    metadata: metadataOf(rootStat, "INVALID_TRUSTED_ROOT", "trusted root"),
  };
}

async function reverifyRoot(fileIO: TrustedBinaryFileIO, root: VerifiedRoot): Promise<void> {
  const finalStat = await rootIO(() => fileIO.lstat(root.configuredPath));
  const finalRealpath = normalizeSafeWindowsPath(
    await rootIO(() => fileIO.realpath(root.configuredPath)),
    "INVALID_TRUSTED_ROOT",
    false,
  );
  if (
    !finalStat.isDirectory() ||
    isLinkOrReparsePoint(finalStat) ||
    !windowsPathsEqual(finalRealpath, root.canonicalPath) ||
    !metadataEqual(metadataOf(finalStat, "INVALID_TRUSTED_ROOT", "trusted root"), root.metadata)
  ) {
    throw verificationError(
      "INVALID_TRUSTED_ROOT",
      "Trusted executable root identity changed during verification.",
    );
  }
}

async function verifyBinary(
  fileIO: TrustedBinaryFileIO,
  trustedRoot: string,
  name: string,
  configuredPath: string,
  expectedSha256: string,
): Promise<VerifiedBinary> {
  const initialLstat = await binaryIO(() => fileIO.lstat(configuredPath), name);
  assertRegularBinary(initialLstat, name);
  const initialRealpath = normalizeSafeWindowsPath(
    await binaryIO(() => fileIO.realpath(configuredPath), name),
    "BINARY_PATH_UNSAFE",
    true,
  );
  assertContainedRealpath(trustedRoot, initialRealpath, name);
  assertConfiguredRealpath(configuredPath, initialRealpath, name);

  let handle: TrustedBinaryFileHandle;
  try {
    handle = await fileIO.open(configuredPath);
  } catch {
    throw verificationError("BINARY_READ_FAILED", `Trusted binary ${name} could not be opened.`);
  }

  let primaryError: unknown;
  let verifiedBinary: VerifiedBinary | undefined;
  try {
    const openedFstat = await binaryIO(() => handle.stat(), name);
    const openedLstat = await binaryIO(() => fileIO.lstat(configuredPath), name);
    const openedPathStat = await binaryIO(() => fileIO.stat(configuredPath), name);
    const openedRealpath = normalizeSafeWindowsPath(
      await binaryIO(() => fileIO.realpath(configuredPath), name),
      "BINARY_PATH_UNSAFE",
      true,
    );
    assertContainedRealpath(trustedRoot, openedRealpath, name);
    assertConfiguredRealpath(configuredPath, openedRealpath, name);
    assertRegularBinary(openedFstat, name);
    assertRegularBinary(openedLstat, name);
    assertRegularBinary(openedPathStat, name);

    const initialMetadata = metadataOf(initialLstat, "BINARY_IDENTITY_CHANGED", name);
    const openedMetadata = metadataOf(openedFstat, "BINARY_IDENTITY_CHANGED", name);
    assertStableMetadata(name, initialMetadata, openedMetadata);
    assertStableMetadata(
      name,
      openedMetadata,
      metadataOf(openedLstat, "BINARY_IDENTITY_CHANGED", name),
    );
    assertStableMetadata(
      name,
      openedMetadata,
      metadataOf(openedPathStat, "BINARY_IDENTITY_CHANGED", name),
    );
    if (!windowsPathsEqual(initialRealpath, openedRealpath)) {
      throw identityChanged(name);
    }
    const binarySize = validateBinarySize(openedMetadata.size, name);

    const actualSha256 = await hashOpenFile(handle, binarySize, name);
    const finalFstat = await binaryIO(() => handle.stat(), name);
    const finalLstat = await binaryIO(() => fileIO.lstat(configuredPath), name);
    const finalPathStat = await binaryIO(() => fileIO.stat(configuredPath), name);
    const finalRealpath = normalizeSafeWindowsPath(
      await binaryIO(() => fileIO.realpath(configuredPath), name),
      "BINARY_PATH_UNSAFE",
      true,
    );
    assertRegularBinary(finalFstat, name);
    assertRegularBinary(finalLstat, name);
    assertRegularBinary(finalPathStat, name);
    assertContainedRealpath(trustedRoot, finalRealpath, name);
    assertConfiguredRealpath(configuredPath, finalRealpath, name);
    assertStableMetadata(
      name,
      openedMetadata,
      metadataOf(finalFstat, "BINARY_IDENTITY_CHANGED", name),
    );
    assertStableMetadata(
      name,
      openedMetadata,
      metadataOf(finalLstat, "BINARY_IDENTITY_CHANGED", name),
    );
    assertStableMetadata(
      name,
      openedMetadata,
      metadataOf(finalPathStat, "BINARY_IDENTITY_CHANGED", name),
    );
    if (!windowsPathsEqual(openedRealpath, finalRealpath)) {
      throw identityChanged(name);
    }
    if (actualSha256 !== expectedSha256) {
      throw verificationError(
        "BINARY_DIGEST_MISMATCH",
        `Trusted binary ${name} did not match its configured SHA-256 digest.`,
      );
    }
    verifiedBinary = {
      canonicalPath: finalRealpath,
      identityKey: fileIdentityKey(openedMetadata),
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    await handle.close();
  } catch {
    if (primaryError === undefined) {
      primaryError = verificationError(
        "BINARY_READ_FAILED",
        `Trusted binary ${name} could not be closed.`,
      );
    }
  }
  if (primaryError !== undefined) {
    throw normalizeBinaryError(primaryError, name);
  }
  if (verifiedBinary === undefined) {
    throw verificationError("BINARY_READ_FAILED", `Trusted binary ${name} could not be verified.`);
  }
  return verifiedBinary;
}

async function hashOpenFile(
  handle: TrustedBinaryFileHandle,
  expectedSize: number,
  name: string,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(hashChunkBytes);
  let position = 0;
  while (position < expectedSize) {
    const requested = Math.min(buffer.byteLength, expectedSize - position);
    const bytesRead = await readChunk(handle, buffer, requested, position, name);
    if (bytesRead === 0) {
      throw identityChanged(name);
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await readChunk(handle, extra, 1, position, name)) !== 0) {
    throw identityChanged(name);
  }
  return hash.digest("hex");
}

async function readChunk(
  handle: TrustedBinaryFileHandle,
  buffer: Uint8Array,
  length: number,
  position: number,
  name: string,
): Promise<number> {
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
      throw new Error("invalid byte count");
    }
    return bytesRead;
  } catch (error) {
    if (error instanceof TrustedBinaryVerificationError) throw error;
    throw verificationError("BINARY_READ_FAILED", `Trusted binary ${name} could not be read.`);
  }
}

function assertRegularBinary(stat: TrustedBinaryFileStat, name: string): void {
  if (!stat.isFile() || isLinkOrReparsePoint(stat)) {
    throw verificationError(
      "BINARY_NOT_REGULAR",
      `Trusted binary ${name} must be a regular file and not a link or reparse point.`,
    );
  }
}

function validateBinarySize(size: TrustedBinaryStatValue, name: string): number {
  const sizeIsValid =
    typeof size === "bigint"
      ? size > 0n && size <= BigInt(maximumBinaryBytes)
      : Number.isSafeInteger(size) && size > 0 && size <= maximumBinaryBytes;
  if (!sizeIsValid) {
    throw verificationError(
      "BINARY_NOT_REGULAR",
      `Trusted binary ${name} has an invalid or unsupported file size.`,
    );
  }
  return Number(size);
}

function metadataOf(
  stat: TrustedBinaryFileStat,
  code: "INVALID_TRUSTED_ROOT" | "BINARY_IDENTITY_CHANGED",
  name: string,
): FileMetadata {
  const identityValues = [stat.dev, stat.ino, stat.size];
  const timestampValues = [stat.mtimeMs, stat.ctimeMs];
  if (
    identityValues.some((value) => !isExactInteger(value) || value < 0) ||
    timestampValues.some((value) => !isFiniteStatValue(value))
  ) {
    throw verificationError(code, `Filesystem identity metadata for ${name} is invalid.`);
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function isExactInteger(value: TrustedBinaryStatValue): boolean {
  return typeof value === "bigint" || Number.isSafeInteger(value);
}

function isFiniteStatValue(value: TrustedBinaryStatValue): boolean {
  return typeof value === "bigint" || Number.isFinite(value);
}

function assertStableMetadata(name: string, expected: FileMetadata, actual: FileMetadata): void {
  if (!metadataEqual(expected, actual)) {
    throw identityChanged(name);
  }
}

function metadataEqual(left: FileMetadata, right: FileMetadata): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertContainedRealpath(root: string, candidate: string, name: string): void {
  if (!isStrictDescendant(root, candidate)) {
    throw verificationError(
      "BINARY_PATH_UNSAFE",
      `Trusted binary ${name} resolved outside the trusted executable root.`,
    );
  }
}

function assertConfiguredRealpath(configuredPath: string, candidate: string, name: string): void {
  if (!windowsPathsEqual(configuredPath, candidate)) {
    throw verificationError(
      "BINARY_PATH_UNSAFE",
      `Trusted binary ${name} must resolve to its configured Windows path.`,
    );
  }
}

function fileIdentityKey(metadata: FileMetadata): string {
  return `${metadata.dev.toString()}:${metadata.ino.toString()}`;
}

function assertDistinctPaths(
  binaries: readonly { readonly name: string; readonly path: string }[],
): void {
  const paths = new Set<string>();
  for (const binary of binaries) {
    const key = windowsPathKey(binary.path);
    if (paths.has(key)) {
      throw verificationError(
        "BINARY_PATH_UNSAFE",
        "Trusted binary roles must use distinct canonical Windows paths.",
      );
    }
    paths.add(key);
  }
}

function validateExpectedDigest(value: string, name: string): string {
  if (!sha256Pattern.test(value)) {
    throw verificationError(
      "BINARY_DIGEST_MISMATCH",
      `Trusted binary ${name} has an invalid expected SHA-256 digest.`,
    );
  }
  return value;
}

function normalizeSafeWindowsPath(
  value: string,
  code: "INVALID_TRUSTED_ROOT" | "BINARY_PATH_UNSAFE",
  requireExecutable: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumWindowsPathLength ||
    value.includes("\0") ||
    !isWellFormedUnicode(value) ||
    !/^[A-Za-z]:[\\/]/u.test(value) ||
    !win32.isAbsolute(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    value.slice(2).includes(":")
  ) {
    throw verificationError(code, "Configured Windows path is not a safe local absolute path.");
  }
  for (const component of value.slice(3).split(/[\\/]/u)) {
    if (component.length === 0) continue;
    if (
      component === "." ||
      component === ".." ||
      component.endsWith(".") ||
      component.endsWith(" ") ||
      /[<>"|?*]/u.test(component) ||
      [...component].some((character) => (character.codePointAt(0) ?? 0) < 32) ||
      isReservedWindowsDeviceName(component)
    ) {
      throw verificationError(code, "Configured Windows path contains an unsafe component.");
    }
  }
  let normalized = win32.normalize(value.replaceAll("/", "\\"));
  normalized = `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
  const canonical =
    normalized.length > 3 && normalized.endsWith("\\") ? normalized.slice(0, -1) : normalized;
  if (requireExecutable && win32.extname(canonical).toLowerCase() !== ".exe") {
    throw verificationError(code, "Configured trusted binary path must end in .exe.");
  }
  return canonical;
}

function isReservedWindowsDeviceName(component: string): boolean {
  const baseName = component.split(".", 1)[0]?.toUpperCase() ?? "";
  return (
    baseName === "CON" ||
    baseName === "PRN" ||
    baseName === "AUX" ||
    baseName === "NUL" ||
    baseName === "CONIN$" ||
    baseName === "CONOUT$" ||
    baseName === "CLOCK$" ||
    /^COM[1-9]$/u.test(baseName) ||
    /^LPT[1-9]$/u.test(baseName) ||
    /^(?:COM|LPT)[\u00b9\u00b2\u00b3]$/u.test(baseName)
  );
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isLinkOrReparsePoint(stat: TrustedBinaryFileStat): boolean {
  return stat.isSymbolicLink() || stat.isReparsePoint?.() === true;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const rootKey = windowsPathKey(root);
  const candidateKey = windowsPathKey(candidate);
  return candidateKey.startsWith(`${rootKey}\\`) && candidateKey.length > rootKey.length + 1;
}

function windowsPathsEqual(left: string, right: string): boolean {
  return windowsPathKey(left) === windowsPathKey(right);
}

function windowsPathKey(value: string): string {
  const normalized = win32.normalize(value.replaceAll("/", "\\"));
  return normalized.endsWith("\\")
    ? normalized.slice(0, -1).toLowerCase()
    : normalized.toLowerCase();
}

function identityChanged(name: string): TrustedBinaryVerificationError {
  return verificationError(
    "BINARY_IDENTITY_CHANGED",
    `Trusted binary ${name} identity changed during verification.`,
  );
}

function normalizeBinaryError(error: unknown, name: string): TrustedBinaryVerificationError {
  if (error instanceof TrustedBinaryVerificationError) return error;
  return verificationError("BINARY_READ_FAILED", `Trusted binary ${name} could not be verified.`);
}

async function binaryIO<T>(operation: () => Promise<T>, name: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TrustedBinaryVerificationError) throw error;
    throw verificationError("BINARY_READ_FAILED", `Trusted binary ${name} could not be inspected.`);
  }
}

async function rootIO<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TrustedBinaryVerificationError) throw error;
    throw verificationError(
      "INVALID_TRUSTED_ROOT",
      "Trusted executable root could not be inspected.",
    );
  }
}

function requiredVerifiedPath(paths: ReadonlyMap<string, string>, name: string): string {
  const path = paths.get(name);
  if (path === undefined) {
    throw verificationError(
      "BINARY_READ_FAILED",
      "Trusted binary verification result is incomplete.",
    );
  }
  return path;
}

function verificationError(
  code: TrustedBinaryVerificationErrorCode,
  message: string,
): TrustedBinaryVerificationError {
  return new TrustedBinaryVerificationError(code, message);
}
