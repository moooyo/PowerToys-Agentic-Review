import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { TextDecoder } from "node:util";

const manifestSchemaVersion = 1 as const;
const publisherPolicy = "authenticode-required-at-install" as const;
const maximumManifestBytes = 4 * 1024 * 1024;
const maximumManifestFiles = 8_192;
const maximumFileBytes = 8n * 1024n * 1024n * 1024n;
const maximumTotalFileBytes = 32n * 1024n * 1024n * 1024n;
const maximumScannedPaths = 32_768;
const maximumRelativePathLength = 4_096;
const maximumWindowsPathLength = 32_767;
const hashChunkBytes = 64 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const decimalSizePattern = /^(?:0|[1-9][0-9]{0,19})$/u;
const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

export const TRUSTED_INSTALLATION_MANIFEST_SCHEMA_VERSION = manifestSchemaVersion;
export const TRUSTED_INSTALLATION_PUBLISHER_POLICY = publisherPolicy;

export const trustedInstallationFileRoles = [
  "service-wrapper",
  "node-runtime",
  "worker-bundle",
  "process-host",
  "codex-cli",
  "git-cli",
  "git-helper",
  "codex-runtime",
  "native-library",
  "ca-bundle",
  "runtime-data",
  "license",
] as const;

export type TrustedInstallationFileRole = (typeof trustedInstallationFileRoles)[number];

const allowedRoles = new Set<string>(trustedInstallationFileRoles);
const requiredSingletonRoles = [
  "service-wrapper",
  "node-runtime",
  "worker-bundle",
  "process-host",
  "codex-cli",
  "git-cli",
] as const satisfies readonly TrustedInstallationFileRole[];
const executableRoles = new Set<TrustedInstallationFileRole>([
  "service-wrapper",
  "node-runtime",
  "process-host",
  "codex-cli",
  "git-cli",
]);

export interface TrustedInstallationManifestFile {
  readonly path: string;
  readonly role: TrustedInstallationFileRole;
  readonly sha256: string;
  readonly size: string;
}

export interface TrustedInstallationManifest {
  readonly files: readonly TrustedInstallationManifestFile[];
  readonly publisherPolicy: typeof publisherPolicy;
  readonly releaseId: string;
  readonly schemaVersion: typeof manifestSchemaVersion;
}

export interface TrustedInstallationFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint(): boolean;
}

export interface TrustedInstallationFileHandle {
  stat(): Promise<TrustedInstallationFileStat>;
  // Must use handle-based Win32 final-path resolution, not a second name-based realpath lookup.
  finalPath(): Promise<string>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface TrustedInstallationDirectoryEntry {
  readonly name: string;
}

export interface TrustedInstallationDirectoryHandle {
  stat(): Promise<TrustedInstallationFileStat>;
  // Must use handle-based Win32 final-path resolution and remain valid through enumeration.
  finalPath(): Promise<string>;
  read(): Promise<TrustedInstallationDirectoryEntry | null>;
  close(): Promise<void>;
}

export interface TrustedInstallationSecurityBoundary {
  readonly adapterProtocolVersion: 1;
  readonly implementation: "native-win32";
  readonly filesystem: "NTFS";
  readonly volume: "fixed-local";
  readonly rootAndAncestorsReparseFree: true;
  readonly genericReparsePointInspection: true;
  readonly directoryHandleIdentity: true;
  readonly installationTreeDaclWriteProtected: true;
  readonly workerTokenWriteDenied: true;
  readonly unprivilegedWriteDenied: true;
}

// Implementations must be backed by native Windows filesystem and security APIs. A pure Node.js
// adapter is intentionally non-conforming because Node cannot prove generic reparse attributes,
// fixed-volume NTFS semantics, DACL immutability, or directory-handle identity.
export interface TrustedInstallationFileIO {
  inspectSecurityBoundary(path: string): Promise<TrustedInstallationSecurityBoundary>;
  lstat(path: string): Promise<TrustedInstallationFileStat>;
  stat(path: string): Promise<TrustedInstallationFileStat>;
  realpath(path: string): Promise<string>;
  open(path: string): Promise<TrustedInstallationFileHandle>;
  openDirectory(path: string): Promise<TrustedInstallationDirectoryHandle>;
}

export type TrustedInstallationVerificationErrorCode =
  | "INSTALLATION_SECURITY_BOUNDARY_INVALID"
  | "INSTALLATION_ROOT_INVALID"
  | "MANIFEST_PATH_UNSAFE"
  | "MANIFEST_READ_FAILED"
  | "MANIFEST_DIGEST_MISMATCH"
  | "MANIFEST_FORMAT_INVALID"
  | "MANIFEST_NOT_CANONICAL"
  | "MANIFEST_LIMIT_EXCEEDED"
  | "INSTALLATION_FILE_UNSAFE"
  | "INSTALLATION_FILE_NOT_REGULAR"
  | "INSTALLATION_FILE_READ_FAILED"
  | "INSTALLATION_FILE_IDENTITY_CHANGED"
  | "INSTALLATION_FILE_SIZE_MISMATCH"
  | "INSTALLATION_FILE_DIGEST_MISMATCH"
  | "INSTALLATION_CONTENT_MISMATCH"
  | "INSTALLATION_SCAN_FAILED"
  | "INSTALLATION_LIMIT_EXCEEDED";

export class TrustedInstallationVerificationError extends Error {
  public constructor(
    public readonly code: TrustedInstallationVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TrustedInstallationVerificationError";
  }
}

export interface VerifyTrustedInstallationOptions {
  readonly installationRoot: string;
  readonly manifestPath: string;
  readonly expectedManifestSha256: string;
  readonly fileIO: TrustedInstallationFileIO;
}

export interface VerifiedTrustedInstallationFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly role: TrustedInstallationFileRole;
  readonly sha256: string;
  readonly size: bigint;
}

export interface VerifiedTrustedInstallation {
  readonly installationRoot: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly releaseId: string;
  readonly schemaVersion: typeof manifestSchemaVersion;
  readonly files: readonly VerifiedTrustedInstallationFile[];
  readonly securityBoundary: TrustedInstallationSecurityBoundary;
  readonly publisherVerification: {
    readonly authenticodeRequired: true;
    readonly performedByThisVerifier: false;
    readonly responsibility: "installer-and-release-pipeline";
  };
}

interface FileMetadata {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface VerifiedRoot {
  readonly path: string;
  readonly metadata: FileMetadata;
}

interface VerifiedFileSnapshot {
  readonly absolutePath: string;
  readonly metadata: FileMetadata;
  readonly identityKey: string;
  readonly digest: string;
  readonly bytes?: Buffer;
}

interface ExpectedScannedFile {
  readonly snapshot: VerifiedFileSnapshot;
  readonly relativePath: string;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly metadata: FileMetadata;
}

interface ParsedManifestFile extends TrustedInstallationManifestFile {
  readonly exactSize: bigint;
}

interface ParsedManifest extends TrustedInstallationManifest {
  readonly files: readonly ParsedManifestFile[];
}

// This verifier establishes integrity from a separately pinned manifest digest. Publisher identity
// must still be established by Authenticode in the installer or signed release pipeline, and the
// installation root must be read-only to the Worker identity after installation.
export async function verifyTrustedInstallation(
  options: VerifyTrustedInstallationOptions,
): Promise<Readonly<VerifiedTrustedInstallation>> {
  const fileIO = requireNativeSecurityAdapter(options.fileIO);
  const expectedManifestSha256 = validateSha256(
    options.expectedManifestSha256,
    "MANIFEST_DIGEST_MISMATCH",
    "Pinned manifest",
  );
  const rootPath = normalizeAbsoluteWindowsPath(
    options.installationRoot,
    "INSTALLATION_ROOT_INVALID",
  );
  if (windowsPathsEqual(rootPath, win32.parse(rootPath).root)) {
    throw verificationError(
      "INSTALLATION_ROOT_INVALID",
      "Installation root cannot be a filesystem root.",
    );
  }
  const manifestPath = normalizeAbsoluteWindowsPath(options.manifestPath, "MANIFEST_PATH_UNSAFE");
  if (!isStrictDescendant(rootPath, manifestPath)) {
    throw verificationError(
      "MANIFEST_PATH_UNSAFE",
      "Manifest must be strictly contained by the installation root.",
    );
  }
  const manifestRelativePath = validateRelativeWindowsPath(
    win32.relative(rootPath, manifestPath),
    "MANIFEST_PATH_UNSAFE",
  );
  const securityBoundary = await verifySecurityBoundary(fileIO, rootPath);
  const root = await verifyRoot(fileIO, rootPath);

  const manifestSnapshot = await verifyStableFile({
    fileIO,
    rootPath: root.path,
    absolutePath: manifestPath,
    label: "release manifest",
    maximumBytes: BigInt(maximumManifestBytes),
    expectedDigest: expectedManifestSha256,
    collectBytes: true,
    readFailureCode: "MANIFEST_READ_FAILED",
    digestFailureCode: "MANIFEST_DIGEST_MISMATCH",
  });
  if (manifestSnapshot.bytes === undefined) {
    throw verificationError("MANIFEST_READ_FAILED", "Release manifest bytes are unavailable.");
  }
  const manifest = parseCanonicalManifest(manifestSnapshot.bytes);
  assertManifestDoesNotListItself(manifest, manifestRelativePath);

  const expectedFiles = new Map<string, ExpectedScannedFile>();
  const identities = new Set<string>([manifestSnapshot.identityKey]);
  expectedFiles.set(windowsPathKey(manifestPath), {
    snapshot: manifestSnapshot,
    relativePath: manifestRelativePath,
  });

  const verifiedFiles: VerifiedTrustedInstallationFile[] = [];
  for (const file of manifest.files) {
    const absolutePath = normalizeAbsoluteWindowsPath(
      win32.join(root.path, file.path),
      "INSTALLATION_FILE_UNSAFE",
    );
    if (!isStrictDescendant(root.path, absolutePath)) {
      throw verificationError(
        "INSTALLATION_FILE_UNSAFE",
        "Manifest file path escapes the installation root.",
      );
    }
    const snapshot = await verifyStableFile({
      fileIO,
      rootPath: root.path,
      absolutePath,
      label: file.path,
      maximumBytes: maximumFileBytes,
      expectedSize: file.exactSize,
      expectedDigest: file.sha256,
      collectBytes: false,
      readFailureCode: "INSTALLATION_FILE_READ_FAILED",
      digestFailureCode: "INSTALLATION_FILE_DIGEST_MISMATCH",
    });
    assertUniqueFileIdentity(identities, snapshot.identityKey);
    expectedFiles.set(windowsPathKey(absolutePath), { snapshot, relativePath: file.path });
    verifiedFiles.push(
      Object.freeze({
        path: file.path,
        absolutePath,
        role: file.role,
        sha256: file.sha256,
        size: file.exactSize,
      }),
    );
  }

  await verifyInstallationContents(fileIO, root, expectedFiles);

  return Object.freeze({
    installationRoot: root.path,
    manifestPath,
    manifestSha256: expectedManifestSha256,
    releaseId: manifest.releaseId,
    schemaVersion: manifest.schemaVersion,
    files: Object.freeze(verifiedFiles),
    securityBoundary,
    publisherVerification: Object.freeze({
      authenticodeRequired: true as const,
      performedByThisVerifier: false as const,
      responsibility: "installer-and-release-pipeline" as const,
    }),
  });
}

export function serializeTrustedInstallationManifest(value: unknown): string {
  const manifest = validateManifestValue(value);
  return serializeValidatedManifest(manifest);
}

function serializeValidatedManifest(manifest: ParsedManifest): string {
  return JSON.stringify({
    files: manifest.files.map((file) => ({
      path: file.path,
      role: file.role,
      sha256: file.sha256,
      size: file.size,
    })),
    publisherPolicy: manifest.publisherPolicy,
    releaseId: manifest.releaseId,
    schemaVersion: manifest.schemaVersion,
  });
}

function parseCanonicalManifest(bytes: Buffer): ParsedManifest {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumManifestBytes ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    throw verificationError(
      "MANIFEST_FORMAT_INVALID",
      "Release manifest must be non-empty UTF-8 without a byte-order mark.",
    );
  }

  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw verificationError("MANIFEST_FORMAT_INVALID", "Release manifest is not valid UTF-8 JSON.");
  }

  const manifest = validateManifestValue(value);
  const canonical = serializeValidatedManifest(manifest);
  if (text !== canonical) {
    throw verificationError(
      "MANIFEST_NOT_CANONICAL",
      "Release manifest does not use the required canonical JSON representation.",
    );
  }
  return manifest;
}

function validateManifestValue(value: unknown): ParsedManifest {
  if (!isRecordWithExactKeys(value, ["files", "publisherPolicy", "releaseId", "schemaVersion"])) {
    throw manifestFormatError("Release manifest has unexpected or missing fields.");
  }
  if (value.schemaVersion !== manifestSchemaVersion) {
    throw manifestFormatError("Release manifest schemaVersion is unsupported.");
  }
  if (value.publisherPolicy !== publisherPolicy) {
    throw manifestFormatError("Release manifest publisherPolicy is unsupported.");
  }
  if (typeof value.releaseId !== "string" || !releaseIdPattern.test(value.releaseId)) {
    throw manifestFormatError("Release manifest releaseId is invalid.");
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw manifestFormatError("Release manifest files must be a non-empty array.");
  }
  if (value.files.length > maximumManifestFiles) {
    throw verificationError("MANIFEST_LIMIT_EXCEEDED", "Release manifest contains too many files.");
  }

  const parsedFiles: ParsedManifestFile[] = [];
  const paths = new Set<string>();
  const roleCounts = new Map<TrustedInstallationFileRole, number>();
  let totalBytes = 0n;
  for (const rawFile of value.files) {
    if (!isRecordWithExactKeys(rawFile, ["path", "role", "sha256", "size"])) {
      throw manifestFormatError("Release manifest file entry has unexpected or missing fields.");
    }
    const path = validateRelativeWindowsPath(rawFile.path, "INSTALLATION_FILE_UNSAFE");
    const pathKey = relativePathKey(path);
    if (paths.has(pathKey)) {
      throw manifestFormatError("Release manifest file paths must be case-insensitively unique.");
    }
    paths.add(pathKey);

    if (typeof rawFile.role !== "string" || !allowedRoles.has(rawFile.role)) {
      throw manifestFormatError("Release manifest file role is unsupported.");
    }
    const role = rawFile.role as TrustedInstallationFileRole;
    validateRolePath(role, path);
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const sha256 = validateSha256(rawFile.sha256, "MANIFEST_FORMAT_INVALID", "Manifest file entry");
    if (typeof rawFile.size !== "string" || !decimalSizePattern.test(rawFile.size)) {
      throw manifestFormatError("Release manifest file size must be a canonical decimal string.");
    }
    const exactSize = BigInt(rawFile.size);
    if ((executableRoles.has(role) || role === "worker-bundle") && exactSize === 0n) {
      throw manifestFormatError(`Release manifest role ${role} must not be empty.`);
    }
    if (exactSize > maximumFileBytes) {
      throw verificationError(
        "MANIFEST_LIMIT_EXCEEDED",
        "Release manifest file size exceeds the per-file limit.",
      );
    }
    totalBytes += exactSize;
    if (totalBytes > maximumTotalFileBytes) {
      throw verificationError(
        "MANIFEST_LIMIT_EXCEEDED",
        "Release manifest total file size exceeds the installation limit.",
      );
    }
    parsedFiles.push(Object.freeze({ path, role, sha256, size: rawFile.size, exactSize }));
  }

  for (const role of requiredSingletonRoles) {
    if (roleCounts.get(role) !== 1) {
      throw manifestFormatError(`Release manifest must contain exactly one ${role} file.`);
    }
  }

  parsedFiles.sort((left, right) => compareRelativePaths(left.path, right.path));
  return Object.freeze({
    files: Object.freeze(parsedFiles),
    publisherPolicy,
    releaseId: value.releaseId,
    schemaVersion: manifestSchemaVersion,
  });
}

function validateRolePath(role: TrustedInstallationFileRole, path: string): void {
  const extension = win32.extname(path).toLowerCase();
  if (executableRoles.has(role) && extension !== ".exe") {
    throw manifestFormatError(`Release manifest role ${role} must identify an .exe file.`);
  }
  if (role === "worker-bundle" && extension !== ".mjs") {
    throw manifestFormatError("Release manifest role worker-bundle must identify an .mjs file.");
  }
  if (role === "native-library" && extension !== ".dll" && extension !== ".node") {
    throw manifestFormatError(
      "Release manifest role native-library must identify a .dll or .node file.",
    );
  }
  if (role === "ca-bundle" && ![".pem", ".crt", ".cer"].includes(extension)) {
    throw manifestFormatError(
      "Release manifest role ca-bundle must identify a .pem, .crt, or .cer file.",
    );
  }
}

function assertManifestDoesNotListItself(
  manifest: ParsedManifest,
  manifestRelativePath: string,
): void {
  const immutablePaths = new Set(manifest.files.map((file) => relativePathKey(file.path)));
  if (immutablePaths.has(relativePathKey(manifestRelativePath))) {
    throw manifestFormatError("Release manifest must not list itself as an installation file.");
  }
}

function requireNativeSecurityAdapter(value: unknown): TrustedInstallationFileIO {
  if (value === null || typeof value !== "object") {
    throw verificationError(
      "INSTALLATION_SECURITY_BOUNDARY_INVALID",
      "A native Windows installation-security adapter is required.",
    );
  }
  const candidate = value as Partial<Record<keyof TrustedInstallationFileIO, unknown>>;
  for (const method of [
    "inspectSecurityBoundary",
    "lstat",
    "stat",
    "realpath",
    "open",
    "openDirectory",
  ] as const) {
    if (typeof candidate[method] !== "function") {
      throw verificationError(
        "INSTALLATION_SECURITY_BOUNDARY_INVALID",
        "The native Windows installation-security adapter is incomplete.",
      );
    }
  }
  return value as TrustedInstallationFileIO;
}

async function verifySecurityBoundary(
  fileIO: TrustedInstallationFileIO,
  rootPath: string,
): Promise<Readonly<TrustedInstallationSecurityBoundary>> {
  let value: unknown;
  try {
    value = await fileIO.inspectSecurityBoundary(rootPath);
  } catch {
    throw verificationError(
      "INSTALLATION_SECURITY_BOUNDARY_INVALID",
      "Native Windows installation-security inspection failed.",
    );
  }
  if (
    !isRecordWithExactKeys(value, [
      "adapterProtocolVersion",
      "directoryHandleIdentity",
      "filesystem",
      "genericReparsePointInspection",
      "implementation",
      "installationTreeDaclWriteProtected",
      "rootAndAncestorsReparseFree",
      "unprivilegedWriteDenied",
      "volume",
      "workerTokenWriteDenied",
    ]) ||
    value.adapterProtocolVersion !== 1 ||
    value.implementation !== "native-win32" ||
    value.filesystem !== "NTFS" ||
    value.volume !== "fixed-local" ||
    value.rootAndAncestorsReparseFree !== true ||
    value.genericReparsePointInspection !== true ||
    value.directoryHandleIdentity !== true ||
    value.installationTreeDaclWriteProtected !== true ||
    value.workerTokenWriteDenied !== true ||
    value.unprivilegedWriteDenied !== true
  ) {
    throw verificationError(
      "INSTALLATION_SECURITY_BOUNDARY_INVALID",
      "Native Windows installation-security guarantees are incomplete.",
    );
  }
  return Object.freeze({
    adapterProtocolVersion: 1 as const,
    implementation: "native-win32" as const,
    filesystem: "NTFS" as const,
    volume: "fixed-local" as const,
    rootAndAncestorsReparseFree: true as const,
    genericReparsePointInspection: true as const,
    directoryHandleIdentity: true as const,
    installationTreeDaclWriteProtected: true as const,
    workerTokenWriteDenied: true as const,
    unprivilegedWriteDenied: true as const,
  });
}

async function verifyRoot(
  fileIO: TrustedInstallationFileIO,
  rootPath: string,
): Promise<VerifiedRoot> {
  let stat: TrustedInstallationFileStat;
  let realPath: string;
  try {
    stat = await fileIO.lstat(rootPath);
    realPath = normalizeAbsoluteWindowsPath(
      await fileIO.realpath(rootPath),
      "INSTALLATION_ROOT_INVALID",
    );
  } catch (error) {
    if (error instanceof TrustedInstallationVerificationError) throw error;
    throw verificationError(
      "INSTALLATION_ROOT_INVALID",
      "Installation root could not be inspected.",
    );
  }
  assertDirectory(stat, "INSTALLATION_ROOT_INVALID", "Installation root");
  if (!windowsPathsEqual(rootPath, realPath)) {
    throw verificationError(
      "INSTALLATION_ROOT_INVALID",
      "Installation root must resolve to its configured Windows path.",
    );
  }
  return { path: rootPath, metadata: metadataOf(stat, "INSTALLATION_ROOT_INVALID") };
}

interface VerifyStableFileOptions {
  readonly fileIO: TrustedInstallationFileIO;
  readonly rootPath: string;
  readonly absolutePath: string;
  readonly label: string;
  readonly maximumBytes: bigint;
  readonly expectedSize?: bigint;
  readonly expectedDigest?: string;
  readonly collectBytes: boolean;
  readonly readFailureCode: "MANIFEST_READ_FAILED" | "INSTALLATION_FILE_READ_FAILED";
  readonly digestFailureCode: "MANIFEST_DIGEST_MISMATCH" | "INSTALLATION_FILE_DIGEST_MISMATCH";
}

async function verifyStableFile(options: VerifyStableFileOptions): Promise<VerifiedFileSnapshot> {
  const initialStat = await fileIO(
    options,
    () => options.fileIO.lstat(options.absolutePath),
    "inspect",
  );
  assertRegularFile(initialStat, options.label);
  const initialMetadata = metadataOf(initialStat, "INSTALLATION_FILE_IDENTITY_CHANGED");
  validateObservedSize(initialMetadata.size, options);
  const initialRealPath = normalizeAbsoluteWindowsPath(
    await fileIO(options, () => options.fileIO.realpath(options.absolutePath), "resolve"),
    "INSTALLATION_FILE_UNSAFE",
  );
  assertExpectedRealPath(options.rootPath, options.absolutePath, initialRealPath);

  let handle: TrustedInstallationFileHandle;
  try {
    handle = await options.fileIO.open(options.absolutePath);
  } catch {
    throw verificationError(options.readFailureCode, `${options.label} could not be opened.`);
  }

  let primaryError: unknown;
  let snapshot: VerifiedFileSnapshot | undefined;
  try {
    const openedFstat = await fileIO(options, () => handle.stat(), "inspect");
    const openedHandlePath = normalizeAbsoluteWindowsPath(
      await fileIO(options, () => handle.finalPath(), "resolve"),
      "INSTALLATION_FILE_UNSAFE",
    );
    const openedLstat = await fileIO(
      options,
      () => options.fileIO.lstat(options.absolutePath),
      "inspect",
    );
    const openedStat = await fileIO(
      options,
      () => options.fileIO.stat(options.absolutePath),
      "inspect",
    );
    const openedRealPath = normalizeAbsoluteWindowsPath(
      await fileIO(options, () => options.fileIO.realpath(options.absolutePath), "resolve"),
      "INSTALLATION_FILE_UNSAFE",
    );
    for (const stat of [openedFstat, openedLstat, openedStat])
      assertRegularFile(stat, options.label);
    const openedMetadata = metadataOf(openedFstat, "INSTALLATION_FILE_IDENTITY_CHANGED");
    assertStableMetadata(initialMetadata, openedMetadata, options.label);
    assertStableMetadata(
      openedMetadata,
      metadataOf(openedLstat, "INSTALLATION_FILE_IDENTITY_CHANGED"),
      options.label,
    );
    assertStableMetadata(
      openedMetadata,
      metadataOf(openedStat, "INSTALLATION_FILE_IDENTITY_CHANGED"),
      options.label,
    );
    assertExpectedRealPath(options.rootPath, options.absolutePath, openedRealPath);
    assertExpectedRealPath(options.rootPath, options.absolutePath, openedHandlePath);
    if (
      !windowsPathsEqual(initialRealPath, openedRealPath) ||
      !windowsPathsEqual(openedRealPath, openedHandlePath)
    ) {
      throw identityChanged(options.label);
    }
    validateObservedSize(openedMetadata.size, options);

    const readResult = await hashOpenFile(
      handle,
      openedMetadata.size,
      options.collectBytes,
      options.label,
      options.readFailureCode,
    );
    const finalFstat = await fileIO(options, () => handle.stat(), "inspect");
    const finalHandlePath = normalizeAbsoluteWindowsPath(
      await fileIO(options, () => handle.finalPath(), "resolve"),
      "INSTALLATION_FILE_UNSAFE",
    );
    const finalLstat = await fileIO(
      options,
      () => options.fileIO.lstat(options.absolutePath),
      "inspect",
    );
    const finalStat = await fileIO(
      options,
      () => options.fileIO.stat(options.absolutePath),
      "inspect",
    );
    const finalRealPath = normalizeAbsoluteWindowsPath(
      await fileIO(options, () => options.fileIO.realpath(options.absolutePath), "resolve"),
      "INSTALLATION_FILE_UNSAFE",
    );
    for (const stat of [finalFstat, finalLstat, finalStat]) assertRegularFile(stat, options.label);
    for (const stat of [finalFstat, finalLstat, finalStat]) {
      assertStableMetadata(
        openedMetadata,
        metadataOf(stat, "INSTALLATION_FILE_IDENTITY_CHANGED"),
        options.label,
      );
    }
    assertExpectedRealPath(options.rootPath, options.absolutePath, finalRealPath);
    assertExpectedRealPath(options.rootPath, options.absolutePath, finalHandlePath);
    if (
      !windowsPathsEqual(openedRealPath, finalRealPath) ||
      !windowsPathsEqual(openedHandlePath, finalHandlePath)
    ) {
      throw identityChanged(options.label);
    }
    if (options.expectedDigest !== undefined && readResult.digest !== options.expectedDigest) {
      throw verificationError(
        options.digestFailureCode,
        `${options.label} did not match its expected SHA-256 digest.`,
      );
    }
    snapshot = {
      absolutePath: options.absolutePath,
      metadata: openedMetadata,
      identityKey: identityKey(openedMetadata),
      digest: readResult.digest,
      ...(readResult.bytes === undefined ? {} : { bytes: readResult.bytes }),
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    await handle.close();
  } catch {
    if (primaryError === undefined) {
      primaryError = verificationError(
        options.readFailureCode,
        `${options.label} could not be closed.`,
      );
    }
  }
  if (primaryError !== undefined) throw normalizeFileError(primaryError, options);
  if (snapshot === undefined) {
    throw verificationError(options.readFailureCode, `${options.label} could not be verified.`);
  }
  return snapshot;
}

async function hashOpenFile(
  handle: TrustedInstallationFileHandle,
  exactSize: bigint,
  collectBytes: boolean,
  label: string,
  readFailureCode: "MANIFEST_READ_FAILED" | "INSTALLATION_FILE_READ_FAILED",
): Promise<{ readonly digest: string; readonly bytes?: Buffer }> {
  const size = Number(exactSize);
  const hash = createHash("sha256");
  const collected: Buffer[] | undefined = collectBytes ? [] : undefined;
  const buffer = Buffer.allocUnsafe(hashChunkBytes);
  let position = 0;
  while (position < size) {
    const requested = Math.min(buffer.byteLength, size - position);
    const bytesRead = await readChunk(handle, buffer, requested, position, label, readFailureCode);
    if (bytesRead === 0) throw identityChanged(label);
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    collected?.push(Buffer.from(chunk));
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await readChunk(handle, extra, 1, position, label, readFailureCode)) !== 0) {
    throw identityChanged(label);
  }
  return {
    digest: hash.digest("hex"),
    ...(collected === undefined ? {} : { bytes: Buffer.concat(collected, size) }),
  };
}

async function readChunk(
  handle: TrustedInstallationFileHandle,
  buffer: Uint8Array,
  length: number,
  position: number,
  label: string,
  readFailureCode: "MANIFEST_READ_FAILED" | "INSTALLATION_FILE_READ_FAILED",
): Promise<number> {
  try {
    const result = await handle.read(buffer, 0, length, position);
    if (
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > length
    ) {
      throw new Error("invalid byte count");
    }
    return result.bytesRead;
  } catch (error) {
    if (error instanceof TrustedInstallationVerificationError) throw error;
    throw verificationError(readFailureCode, `${label} could not be read.`);
  }
}

function validateObservedSize(size: bigint, options: VerifyStableFileOptions): void {
  if (size > options.maximumBytes) {
    const code =
      options.readFailureCode === "MANIFEST_READ_FAILED"
        ? "MANIFEST_LIMIT_EXCEEDED"
        : "INSTALLATION_LIMIT_EXCEEDED";
    throw verificationError(code, `${options.label} exceeds its file-size limit.`);
  }
  if (options.expectedSize !== undefined && size !== options.expectedSize) {
    throw verificationError(
      "INSTALLATION_FILE_SIZE_MISMATCH",
      `${options.label} did not match its manifest file size.`,
    );
  }
}

async function verifyInstallationContents(
  fileIO: TrustedInstallationFileIO,
  root: VerifiedRoot,
  expectedFiles: ReadonlyMap<string, ExpectedScannedFile>,
): Promise<void> {
  const expectedDirectories = buildExpectedDirectories(root.path, expectedFiles.values());
  const seenFiles = new Set<string>();
  const directorySnapshots: DirectorySnapshot[] = [];
  const scanState = { pathCount: 0 };
  await scanDirectory({
    fileIO,
    root,
    directoryPath: root.path,
    expectedDirectories,
    expectedFiles,
    seenFiles,
    directorySnapshots,
    scanState,
  });
  if (seenFiles.size !== expectedFiles.size) {
    throw verificationError(
      "INSTALLATION_CONTENT_MISMATCH",
      "Installation is missing one or more manifest files.",
    );
  }
  for (const key of expectedFiles.keys()) {
    if (!seenFiles.has(key)) {
      throw verificationError(
        "INSTALLATION_CONTENT_MISMATCH",
        "Installation is missing one or more manifest files.",
      );
    }
  }
  for (const snapshot of directorySnapshots) {
    await reverifyDirectory(fileIO, snapshot);
  }
  for (const file of expectedFiles.values()) {
    await reverifyFile(fileIO, root.path, file);
  }
  await reverifyRoot(fileIO, root);
}

interface ScanDirectoryOptions {
  readonly fileIO: TrustedInstallationFileIO;
  readonly root: VerifiedRoot;
  readonly directoryPath: string;
  readonly expectedDirectories: ReadonlySet<string>;
  readonly expectedFiles: ReadonlyMap<string, ExpectedScannedFile>;
  readonly seenFiles: Set<string>;
  readonly directorySnapshots: DirectorySnapshot[];
  readonly scanState: { pathCount: number };
}

async function scanDirectory(options: ScanDirectoryOptions): Promise<void> {
  const initialStat = await scanIO(() => options.fileIO.lstat(options.directoryPath));
  assertDirectory(initialStat, "INSTALLATION_CONTENT_MISMATCH", "Installation directory");
  const initialMetadata = metadataOf(initialStat, "INSTALLATION_FILE_IDENTITY_CHANGED");
  const initialRealPath = normalizeAbsoluteWindowsPath(
    await scanIO(() => options.fileIO.realpath(options.directoryPath)),
    "INSTALLATION_FILE_UNSAFE",
  );
  if (!windowsPathsEqual(initialRealPath, options.directoryPath)) {
    throw verificationError(
      "INSTALLATION_FILE_UNSAFE",
      "Installation directory resolves through an alias or reparse point.",
    );
  }
  if (
    windowsPathsEqual(options.directoryPath, options.root.path) &&
    !metadataEqual(initialMetadata, options.root.metadata)
  ) {
    throw identityChanged("installation root");
  }

  const childNames = await readBoundedDirectoryNames(
    options.fileIO,
    options.directoryPath,
    initialMetadata,
    options.scanState,
  );
  for (const childName of childNames) {
    const safeName = validateSingleWindowsPathComponent(childName);
    const childPath = normalizeAbsoluteWindowsPath(
      win32.join(options.directoryPath, safeName),
      "INSTALLATION_FILE_UNSAFE",
    );
    if (!isStrictDescendant(options.root.path, childPath)) {
      throw verificationError(
        "INSTALLATION_FILE_UNSAFE",
        "Installation path escapes the configured root.",
      );
    }
    const childStat = await scanIO(() => options.fileIO.lstat(childPath));
    const childKey = windowsPathKey(childPath);
    if (childStat.isDirectory() && !isLinkOrReparsePoint(childStat)) {
      if (!options.expectedDirectories.has(childKey)) {
        throw verificationError(
          "INSTALLATION_CONTENT_MISMATCH",
          "Installation contains an unexpected directory.",
        );
      }
      await scanDirectory({ ...options, directoryPath: childPath });
      continue;
    }
    if (!childStat.isFile() || isLinkOrReparsePoint(childStat)) {
      throw verificationError(
        "INSTALLATION_FILE_UNSAFE",
        "Installation contains a link, reparse point, or special filesystem object.",
      );
    }
    const expected = options.expectedFiles.get(childKey);
    if (expected === undefined) {
      throw verificationError(
        "INSTALLATION_CONTENT_MISMATCH",
        "Installation contains an unexpected file.",
      );
    }
    if (options.seenFiles.has(childKey)) {
      throw verificationError(
        "INSTALLATION_CONTENT_MISMATCH",
        "Installation scan encountered a duplicate file path.",
      );
    }
    const scannedMetadata = metadataOf(childStat, "INSTALLATION_FILE_IDENTITY_CHANGED");
    if (!metadataEqual(scannedMetadata, expected.snapshot.metadata)) {
      throw identityChanged(expected.relativePath);
    }
    const realPath = normalizeAbsoluteWindowsPath(
      await scanIO(() => options.fileIO.realpath(childPath)),
      "INSTALLATION_FILE_UNSAFE",
    );
    if (!windowsPathsEqual(realPath, expected.snapshot.absolutePath)) {
      throw verificationError(
        "INSTALLATION_FILE_UNSAFE",
        "Installation file resolves through an alias or reparse point.",
      );
    }
    options.seenFiles.add(childKey);
  }

  const finalStat = await scanIO(() => options.fileIO.lstat(options.directoryPath));
  assertDirectory(finalStat, "INSTALLATION_CONTENT_MISMATCH", "Installation directory");
  const finalMetadata = metadataOf(finalStat, "INSTALLATION_FILE_IDENTITY_CHANGED");
  const finalRealPath = normalizeAbsoluteWindowsPath(
    await scanIO(() => options.fileIO.realpath(options.directoryPath)),
    "INSTALLATION_FILE_UNSAFE",
  );
  if (
    !metadataEqual(initialMetadata, finalMetadata) ||
    !windowsPathsEqual(initialRealPath, finalRealPath)
  ) {
    throw identityChanged("installation directory");
  }
  options.directorySnapshots.push({ path: options.directoryPath, metadata: finalMetadata });
}

async function readBoundedDirectoryNames(
  fileIO: TrustedInstallationFileIO,
  directoryPath: string,
  expectedMetadata: FileMetadata,
  scanState: { pathCount: number },
): Promise<readonly string[]> {
  let handle: TrustedInstallationDirectoryHandle;
  try {
    handle = await fileIO.openDirectory(directoryPath);
  } catch {
    throw verificationError(
      "INSTALLATION_SCAN_FAILED",
      "Installation directory could not be opened for enumeration.",
    );
  }
  const names: string[] = [];
  const keys = new Set<string>();
  let primaryError: unknown;
  try {
    const openedStat = await scanIO(() => handle.stat());
    assertDirectory(openedStat, "INSTALLATION_CONTENT_MISMATCH", "Installation directory handle");
    const openedMetadata = metadataOf(openedStat, "INSTALLATION_FILE_IDENTITY_CHANGED");
    const openedHandlePath = normalizeAbsoluteWindowsPath(
      await scanIO(() => handle.finalPath()),
      "INSTALLATION_FILE_UNSAFE",
    );
    if (
      !metadataEqual(openedMetadata, expectedMetadata) ||
      !windowsPathsEqual(openedHandlePath, directoryPath)
    ) {
      throw identityChanged("installation directory handle");
    }
    while (true) {
      const entry = await handle.read();
      if (entry === null) break;
      scanState.pathCount += 1;
      if (scanState.pathCount > maximumScannedPaths) {
        throw verificationError(
          "INSTALLATION_LIMIT_EXCEEDED",
          "Installation contains too many filesystem entries.",
        );
      }
      const safeName = validateSingleWindowsPathComponent(entry.name);
      const key = safeName.toLowerCase();
      if (keys.has(key)) {
        throw verificationError(
          "INSTALLATION_CONTENT_MISMATCH",
          "Installation directory contains case-insensitively duplicate names.",
        );
      }
      keys.add(key);
      names.push(safeName);
    }
    const finalStat = await scanIO(() => handle.stat());
    assertDirectory(finalStat, "INSTALLATION_CONTENT_MISMATCH", "Installation directory handle");
    const finalHandlePath = normalizeAbsoluteWindowsPath(
      await scanIO(() => handle.finalPath()),
      "INSTALLATION_FILE_UNSAFE",
    );
    if (
      !metadataEqual(metadataOf(finalStat, "INSTALLATION_FILE_IDENTITY_CHANGED"), openedMetadata) ||
      !windowsPathsEqual(finalHandlePath, openedHandlePath)
    ) {
      throw identityChanged("installation directory handle");
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch {
    if (primaryError === undefined) {
      primaryError = verificationError(
        "INSTALLATION_SCAN_FAILED",
        "Installation directory enumeration could not be closed.",
      );
    }
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof TrustedInstallationVerificationError) throw primaryError;
    throw verificationError(
      "INSTALLATION_SCAN_FAILED",
      "Installation directory could not be enumerated.",
    );
  }
  names.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase(), "en"));
  return names;
}

function buildExpectedDirectories(
  rootPath: string,
  files: Iterable<ExpectedScannedFile>,
): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const file of files) {
    let current = win32.dirname(file.snapshot.absolutePath);
    while (!windowsPathsEqual(current, rootPath)) {
      if (!isStrictDescendant(rootPath, current)) {
        throw verificationError(
          "INSTALLATION_FILE_UNSAFE",
          "Expected installation directory escapes the configured root.",
        );
      }
      directories.add(windowsPathKey(current));
      current = win32.dirname(current);
    }
  }
  return directories;
}

async function reverifyDirectory(
  fileIO: TrustedInstallationFileIO,
  snapshot: DirectorySnapshot,
): Promise<void> {
  const stat = await scanIO(() => fileIO.lstat(snapshot.path));
  assertDirectory(stat, "INSTALLATION_CONTENT_MISMATCH", "Installation directory");
  const realPath = normalizeAbsoluteWindowsPath(
    await scanIO(() => fileIO.realpath(snapshot.path)),
    "INSTALLATION_FILE_UNSAFE",
  );
  if (
    !windowsPathsEqual(realPath, snapshot.path) ||
    !metadataEqual(metadataOf(stat, "INSTALLATION_FILE_IDENTITY_CHANGED"), snapshot.metadata)
  ) {
    throw identityChanged("installation directory");
  }
}

async function reverifyFile(
  fileIO: TrustedInstallationFileIO,
  rootPath: string,
  file: ExpectedScannedFile,
): Promise<void> {
  const lstat = await scanIO(() => fileIO.lstat(file.snapshot.absolutePath));
  const stat = await scanIO(() => fileIO.stat(file.snapshot.absolutePath));
  assertRegularFile(lstat, file.relativePath);
  assertRegularFile(stat, file.relativePath);
  const realPath = normalizeAbsoluteWindowsPath(
    await scanIO(() => fileIO.realpath(file.snapshot.absolutePath)),
    "INSTALLATION_FILE_UNSAFE",
  );
  assertExpectedRealPath(rootPath, file.snapshot.absolutePath, realPath);
  if (
    !metadataEqual(
      metadataOf(lstat, "INSTALLATION_FILE_IDENTITY_CHANGED"),
      file.snapshot.metadata,
    ) ||
    !metadataEqual(metadataOf(stat, "INSTALLATION_FILE_IDENTITY_CHANGED"), file.snapshot.metadata)
  ) {
    throw identityChanged(file.relativePath);
  }
}

async function reverifyRoot(fileIO: TrustedInstallationFileIO, root: VerifiedRoot): Promise<void> {
  const stat = await scanIO(() => fileIO.lstat(root.path));
  assertDirectory(stat, "INSTALLATION_ROOT_INVALID", "Installation root");
  const realPath = normalizeAbsoluteWindowsPath(
    await scanIO(() => fileIO.realpath(root.path)),
    "INSTALLATION_ROOT_INVALID",
  );
  if (
    !windowsPathsEqual(realPath, root.path) ||
    !metadataEqual(metadataOf(stat, "INSTALLATION_ROOT_INVALID"), root.metadata)
  ) {
    throw verificationError(
      "INSTALLATION_ROOT_INVALID",
      "Installation root identity changed during verification.",
    );
  }
}

function metadataOf(
  stat: TrustedInstallationFileStat,
  code: "INSTALLATION_ROOT_INVALID" | "INSTALLATION_FILE_IDENTITY_CHANGED",
): FileMetadata {
  if (
    typeof stat.dev !== "bigint" ||
    typeof stat.ino !== "bigint" ||
    typeof stat.nlink !== "bigint" ||
    typeof stat.size !== "bigint" ||
    typeof stat.mtimeNs !== "bigint" ||
    typeof stat.ctimeNs !== "bigint" ||
    stat.dev < 0n ||
    stat.ino <= 0n ||
    stat.nlink <= 0n ||
    stat.size < 0n ||
    stat.mtimeNs < 0n ||
    stat.ctimeNs < 0n
  ) {
    throw verificationError(code, "Filesystem identity metadata is unavailable or invalid.");
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function metadataEqual(left: FileMetadata, right: FileMetadata): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertStableMetadata(expected: FileMetadata, actual: FileMetadata, label: string): void {
  if (!metadataEqual(expected, actual)) throw identityChanged(label);
}

function identityKey(metadata: FileMetadata): string {
  return `${metadata.dev.toString()}:${metadata.ino.toString()}`;
}

function assertUniqueFileIdentity(identities: Set<string>, key: string): void {
  if (identities.has(key)) {
    throw verificationError(
      "INSTALLATION_FILE_UNSAFE",
      "Installation files must identify distinct filesystem objects; hardlink aliases are forbidden.",
    );
  }
  identities.add(key);
}

function assertRegularFile(stat: TrustedInstallationFileStat, label: string): void {
  assertNativeStatMethods(stat);
  if (!stat.isFile() || isLinkOrReparsePoint(stat)) {
    throw verificationError(
      "INSTALLATION_FILE_NOT_REGULAR",
      `${label} must be a regular file and not a link or reparse point.`,
    );
  }
  if (stat.nlink !== 1n) {
    throw verificationError(
      "INSTALLATION_FILE_UNSAFE",
      `${label} must not have hardlink aliases inside or outside the installation root.`,
    );
  }
}

function assertDirectory(
  stat: TrustedInstallationFileStat,
  code: "INSTALLATION_ROOT_INVALID" | "INSTALLATION_CONTENT_MISMATCH",
  label: string,
): void {
  assertNativeStatMethods(stat);
  if (!stat.isDirectory() || isLinkOrReparsePoint(stat)) {
    throw verificationError(
      code,
      `${label} must be a real directory, not a link or reparse point.`,
    );
  }
}

function assertNativeStatMethods(stat: TrustedInstallationFileStat): void {
  if (
    typeof stat.isDirectory !== "function" ||
    typeof stat.isFile !== "function" ||
    typeof stat.isSymbolicLink !== "function" ||
    typeof stat.isReparsePoint !== "function"
  ) {
    throw verificationError(
      "INSTALLATION_SECURITY_BOUNDARY_INVALID",
      "The native Windows adapter did not provide complete reparse-aware stat data.",
    );
  }
}

function assertExpectedRealPath(rootPath: string, configuredPath: string, realPath: string): void {
  if (!isStrictDescendant(rootPath, realPath) || !windowsPathsEqual(configuredPath, realPath)) {
    throw verificationError(
      "INSTALLATION_FILE_UNSAFE",
      "Installation file resolves outside its configured path or through an alias.",
    );
  }
}

function isLinkOrReparsePoint(stat: TrustedInstallationFileStat): boolean {
  return stat.isSymbolicLink() || stat.isReparsePoint();
}

function normalizeAbsoluteWindowsPath(
  value: unknown,
  code: "INSTALLATION_ROOT_INVALID" | "MANIFEST_PATH_UNSAFE" | "INSTALLATION_FILE_UNSAFE",
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
    throw verificationError(code, "Windows path is not a safe local absolute path.");
  }
  for (const component of value.slice(3).split(/[\\/]/u)) {
    if (component.length === 0) continue;
    validateWindowsPathComponent(component, code);
  }
  let normalized = win32.normalize(value.replaceAll("/", "\\"));
  normalized = `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
  return normalized.length > 3 && normalized.endsWith("\\") ? normalized.slice(0, -1) : normalized;
}

function validateRelativeWindowsPath(
  value: unknown,
  code: "MANIFEST_PATH_UNSAFE" | "INSTALLATION_FILE_UNSAFE",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumRelativePathLength ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes(":") ||
    value.startsWith("\\") ||
    win32.isAbsolute(value) ||
    !isWellFormedUnicode(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint > 0x7e;
    })
  ) {
    throw verificationError(code, "Manifest path is not a safe relative Windows path.");
  }
  const components = value.split("\\");
  if (components.some((component) => component.length === 0)) {
    throw verificationError(code, "Manifest path contains an empty component.");
  }
  for (const component of components) validateWindowsPathComponent(component, code);
  const normalized = win32.normalize(value);
  if (normalized !== value || normalized === "." || normalized === "..") {
    throw verificationError(code, "Manifest path is not in normalized relative form.");
  }
  return value;
}

function validateSingleWindowsPathComponent(value: unknown): string {
  if (typeof value !== "string" || value.includes("\\") || value.includes("/")) {
    throw verificationError(
      "INSTALLATION_FILE_UNSAFE",
      "Installation directory contains an unsafe entry name.",
    );
  }
  const path = validateRelativeWindowsPath(value, "INSTALLATION_FILE_UNSAFE");
  if (path.includes("\\")) {
    throw verificationError(
      "INSTALLATION_FILE_UNSAFE",
      "Installation directory entry must contain one path component.",
    );
  }
  return path;
}

function validateWindowsPathComponent(
  component: string,
  code: "INSTALLATION_ROOT_INVALID" | "MANIFEST_PATH_UNSAFE" | "INSTALLATION_FILE_UNSAFE",
): void {
  if (
    component === "." ||
    component === ".." ||
    component.endsWith(".") ||
    component.endsWith(" ") ||
    /[<>"|?*]/u.test(component) ||
    [...component].some((character) => (character.codePointAt(0) ?? 0) < 32) ||
    isReservedWindowsDeviceName(component)
  ) {
    throw verificationError(code, "Windows path contains an unsafe component.");
  }
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

function validateSha256(
  value: unknown,
  code: "MANIFEST_DIGEST_MISMATCH" | "MANIFEST_FORMAT_INVALID",
  label: string,
): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw verificationError(code, `${label} SHA-256 digest must be 64 lowercase hex characters.`);
  }
  return value;
}

function isRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is {
  readonly [key: string]: unknown;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  );
}

function compareRelativePaths(left: string, right: string): number {
  const leftKey = relativePathKey(left);
  const rightKey = relativePathKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function relativePathKey(value: string): string {
  return value.toLowerCase();
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

function isStrictDescendant(root: string, candidate: string): boolean {
  const rootKey = windowsPathKey(root);
  const candidateKey = windowsPathKey(candidate);
  return candidateKey.startsWith(`${rootKey}\\`) && candidateKey.length > rootKey.length + 1;
}

function identityChanged(label: string): TrustedInstallationVerificationError {
  return verificationError(
    "INSTALLATION_FILE_IDENTITY_CHANGED",
    `${label} identity changed during installation verification.`,
  );
}

function normalizeFileError(
  error: unknown,
  options: VerifyStableFileOptions,
): TrustedInstallationVerificationError {
  if (error instanceof TrustedInstallationVerificationError) return error;
  return verificationError(options.readFailureCode, `${options.label} could not be verified.`);
}

async function fileIO<T>(
  options: VerifyStableFileOptions,
  operation: () => Promise<T>,
  action: "inspect" | "resolve",
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TrustedInstallationVerificationError) throw error;
    throw verificationError(
      options.readFailureCode,
      `${options.label} could not be ${action === "inspect" ? "inspected" : "resolved"}.`,
    );
  }
}

async function scanIO<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TrustedInstallationVerificationError) throw error;
    throw verificationError(
      "INSTALLATION_SCAN_FAILED",
      "Installation filesystem contents could not be inspected.",
    );
  }
}

function manifestFormatError(message: string): TrustedInstallationVerificationError {
  return verificationError("MANIFEST_FORMAT_INVALID", message);
}

function verificationError(
  code: TrustedInstallationVerificationErrorCode,
  message: string,
): TrustedInstallationVerificationError {
  return new TrustedInstallationVerificationError(code, message);
}
