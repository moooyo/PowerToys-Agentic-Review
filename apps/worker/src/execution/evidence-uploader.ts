import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  DateTimeSchema,
  EntityIdSchema,
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  type EvidenceAssetMetadata,
  EvidenceAssetMetadataSchema,
  EvidenceUploadResponseSchema,
  type LeaseIdentity,
  LeaseIdentitySchema,
  maximumAttemptEvidenceAssets,
  maximumAttemptEvidenceBytes,
  maximumEvidenceChunkBytes,
  Sha256Schema,
  type UiScenarioExecutionEvidenceV1,
  UiScenarioExecutionEvidenceV1Schema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { ProtocolError, WorkerApiError } from "../server-client/errors.js";
import type { EvidenceApi } from "../server-client/evidence-api.js";

registerWorkerContractFormats();

const EvidenceUploadScopeSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    runId: EntityIdSchema,
    requestId: EntityIdSchema,
    profileVersionId: EntityIdSchema,
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
  },
  { additionalProperties: false },
);

export interface LocalEvidenceFile {
  readonly id: string;
  readonly relativePath: string;
  readonly kind: EvidenceAssetMetadata["kind"] | "ui_steps";
  readonly mediaType: EvidenceAssetMetadata["mediaType"];
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly checkId?: string;
  readonly capturedAt?: string;
}
export interface EvidenceUploadScope {
  readonly repositoryId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly profileVersionId: string;
  readonly revisionKey: string;
  readonly planDigest: string;
}
export interface EvidenceUploadProgress {
  readonly localAssetId: string;
  readonly assetId: string;
  readonly uploadedBytes: number;
  readonly totalBytes: number;
}
export interface EvidenceUploadInput {
  readonly lease: LeaseIdentity;
  readonly scope: EvidenceUploadScope;
  readonly evidenceDirectory: string;
  readonly capturedAt: string;
  readonly files: readonly LocalEvidenceFile[];
  readonly signal: AbortSignal;
  readonly onChunkProgress?: (progress: EvidenceUploadProgress) => void | Promise<void>;
}
export interface EvidenceUploadResult {
  readonly assetIds: Readonly<Record<string, string>>;
  readonly assets: readonly EvidenceAssetManifest[];
}
export interface UiScenarioEvidenceUploadInput extends EvidenceUploadInput {
  readonly execution: UiScenarioExecutionEvidenceV1;
}
export const maximumNormalizedUiEvidenceBytes = 512 * 1024;
export type EvidenceUploadErrorCode =
  | "INVALID_INPUT"
  | "INVALID_PATH"
  | "FILE_CHANGED"
  | "DIGEST_MISMATCH"
  | "FILE_READ_FAILED"
  | "PROTOCOL_ERROR"
  | "UPLOAD_FAILED"
  | "ABORTED"
  | "PROGRESS_FAILED";
export class EvidenceUploadError extends Error {
  public constructor(
    public readonly code: EvidenceUploadErrorCode,
    public readonly partial: EvidenceUploadResult,
    public readonly localAssetId: string | null,
    public readonly isRetryable = false,
    public readonly isLeaseLost = false,
  ) {
    super(`Evidence upload could not complete: ${code}.`);
    this.name = "EvidenceUploadError";
  }
}
class UploadFailure extends Error {
  public constructor(public readonly code: EvidenceUploadErrorCode) {
    super(code);
  }
}
interface OwnedFile {
  readonly handle: FileHandle;
  readonly root: string;
  readonly path: string;
  readonly initial: BigIntStats;
  readonly directories: readonly { path: string; initial: BigIntStats }[];
}
export interface EvidenceUploaderOptions {
  readonly api: EvidenceApi;
  readonly retryBaseDelayMs?: number;
}

export class EvidenceUploader {
  readonly #retryBaseDelayMs: number;
  public constructor(private readonly options: EvidenceUploaderOptions) {
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    if (
      !Number.isInteger(this.#retryBaseDelayMs) ||
      this.#retryBaseDelayMs < 0 ||
      this.#retryBaseDelayMs > 1_000
    )
      throw new TypeError("Evidence retry delay is invalid.");
  }

  public async uploadUiScenarioEvidence(
    input: UiScenarioEvidenceUploadInput,
  ): Promise<EvidenceUploadResult> {
    let completed: EvidenceUploadResult = { assetIds: {}, assets: [] };
    let stepsId: string | null = null;
    try {
      validateInput(input);
      if (!Value.Check(UiScenarioExecutionEvidenceV1Schema, input.execution))
        throw new UploadFailure("INVALID_INPUT");
      const execution = structuredClone(input.execution);
      const stepsFiles = input.files.filter(
        (file) => file.kind === "ui_steps" || file.kind === "steps",
      );
      const stepsFile = stepsFiles[0];
      if (
        stepsFiles.length !== 1 ||
        stepsFile === undefined ||
        stepsFile.sizeBytes > maximumNormalizedUiEvidenceBytes
      )
        throw new UploadFailure("INVALID_INPUT");
      stepsId = stepsFile.id;
      const checkId = `${input.scope.profileVersionId}:${execution.scenarioId}`;
      const scoped: EvidenceUploadInput = {
        ...input,
        files: input.files.map((file) => {
          if (file.checkId !== undefined && file.checkId !== checkId)
            throw new UploadFailure("INVALID_INPUT");
          return { ...file, checkId };
        }),
      };
      validateInput(scoped);
      const localFiles = new Map(scoped.files.map((file) => [file.id, file]));
      for (const step of execution.steps) {
        for (const id of step.evidenceIds) {
          if (localFiles.get(id)?.kind !== "screenshot") throw new UploadFailure("PROTOCOL_ERROR");
        }
      }
      throwIfAborted(input.signal);
      const root = await validateOwnedDirectory(input.evidenceDirectory);
      const original = await openOwnedFile(root, stepsFile);
      try {
        await verifyStream(original, stepsFile, input.signal);
        const bytes = await readChunk(
          original.handle,
          Buffer.allocUnsafe(stepsFile.sizeBytes),
          0,
          stepsFile.sizeBytes,
        );
        let captured: unknown;
        try {
          captured = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new UploadFailure("PROTOCOL_ERROR");
        }
        if (
          !Value.Check(UiScenarioExecutionEvidenceV1Schema, captured) ||
          !isDeepStrictEqual(captured, execution)
        )
          throw new UploadFailure("PROTOCOL_ERROR");
        await verifyOwnedFile(original);
      } finally {
        await original.handle.close();
      }
      completed = await this.upload({
        ...scoped,
        files: scoped.files.filter((file) => file.id !== stepsFile.id),
      });
      for (const step of execution.steps) {
        step.evidenceIds = step.evidenceIds.map((id) => {
          const finalizedId = completed.assetIds[id];
          if (
            finalizedId === undefined ||
            !completed.assets.some(
              (asset) =>
                asset.id === finalizedId &&
                asset.state === "finalized" &&
                asset.metadata.kind === "screenshot",
            )
          )
            throw new UploadFailure("PROTOCOL_ERROR");
          return finalizedId;
        });
      }
      if (!Value.Check(UiScenarioExecutionEvidenceV1Schema, execution))
        throw new UploadFailure("PROTOCOL_ERROR");
      const normalizedBytes = Buffer.from(JSON.stringify(execution), "utf8");
      if (normalizedBytes.byteLength > maximumNormalizedUiEvidenceBytes)
        throw new UploadFailure("INVALID_INPUT");
      throwIfAborted(input.signal);
      const normalizedPath = await writeNormalizedEvidence(root, normalizedBytes);
      const normalized: LocalEvidenceFile = {
        ...stepsFile,
        kind: "steps",
        relativePath: normalizedPath,
        sizeBytes: normalizedBytes.byteLength,
        sha256: createHash("sha256").update(normalizedBytes).digest("hex"),
        checkId,
      };
      const uploadedSteps = await this.upload({ ...scoped, files: [normalized] });
      return mergeCompletedEvidence(completed, uploadedSteps);
    } catch (error) {
      if (error instanceof EvidenceUploadError) {
        let partial: EvidenceUploadResult;
        try {
          partial = mergeCompletedEvidence(completed, error.partial);
        } catch {
          throw new EvidenceUploadError("PROTOCOL_ERROR", completed, stepsId);
        }
        throw new EvidenceUploadError(
          error.code,
          partial,
          error.localAssetId,
          error.isRetryable,
          error.isLeaseLost,
        );
      }
      const code = input.signal.aborted
        ? "ABORTED"
        : error instanceof UploadFailure
          ? error.code
          : "FILE_READ_FAILED";
      throw new EvidenceUploadError(code, completed, stepsId);
    }
  }

  public async upload(input: EvidenceUploadInput): Promise<EvidenceUploadResult> {
    const mappings = new Map<string, string>();
    const assets: EvidenceAssetManifest[] = [];
    const snapshot = (): EvidenceUploadResult => ({
      assetIds: Object.fromEntries(mappings),
      assets: structuredClone(assets),
    });
    let activeId: string | null = null;
    try {
      validateInput(input);
      throwIfAborted(input.signal);
      const root = await validateOwnedDirectory(input.evidenceDirectory);
      for (const file of input.files) {
        activeId = file.id;
        throwIfAborted(input.signal);
        const owned = await openOwnedFile(root, file);
        try {
          // Authenticate the entire captured file before starting an upload. The handle remains
          // open through the second streaming pass and finalization; no trace is buffered whole.
          await verifyStream(owned, file, input.signal);
          const metadata = metadataFor(file, input.capturedAt);
          const begun = await this.#retry(
            () =>
              this.options.api.beginUpload(
                { lease: input.lease, clientAssetId: file.id, metadata },
                input.signal,
              ),
            input.signal,
          );
          if (
            !Value.Check(EvidenceUploadResponseSchema, begun) ||
            begun.offset > file.sizeBytes ||
            (begun.state === "finalized" && begun.offset !== file.sizeBytes) ||
            begun.assetId.includes(input.lease.leaseToken) ||
            assets.some((asset) => asset.id === begun.assetId)
          )
            throw new UploadFailure("PROTOCOL_ERROR");
          let uploaded = begun.offset;
          if (uploaded > 0) await reportProgress(input, file, begun.assetId, uploaded);
          const digest = createHash("sha256");
          const buffer = Buffer.allocUnsafe(maximumEvidenceChunkBytes);
          let position = 0;
          while (position < file.sizeBytes) {
            throwIfAborted(input.signal);
            const length = Math.min(buffer.byteLength, file.sizeBytes - position);
            const chunk = await readChunk(owned.handle, buffer, position, length);
            digest.update(chunk);
            const end = position + chunk.byteLength;
            if (end > uploaded) {
              const bytes = chunk.subarray(Math.max(0, uploaded - position));
              const request = {
                lease: input.lease,
                assetId: begun.assetId,
                offset: uploaded,
                base64: bytes.toString("base64"),
                chunkSha256: createHash("sha256").update(bytes).digest("hex"),
              };
              const acknowledgement = await this.#retry(
                () => this.options.api.appendChunk(request, input.signal),
                input.signal,
              );
              if (
                !Value.Check(EvidenceUploadResponseSchema, acknowledgement) ||
                acknowledgement.assetId !== begun.assetId ||
                acknowledgement.offset !== end ||
                acknowledgement.state !== "uploading"
              )
                throw new UploadFailure("PROTOCOL_ERROR");
              uploaded = acknowledgement.offset;
              await reportProgress(input, file, begun.assetId, uploaded);
            }
            position = end;
          }
          if (digest.digest("hex") !== file.sha256) throw new UploadFailure("DIGEST_MISMATCH");
          // Rehash after every chunk acknowledgement. Same-size rewrites can retain identical
          // filesystem timestamps, so identity checks alone cannot verify the current bytes.
          await verifyStream(owned, file, input.signal, "FILE_CHANGED");
          throwIfAborted(input.signal);
          const manifest = await this.#retry(
            () =>
              this.options.api.finalizeUpload(
                { lease: input.lease, assetId: begun.assetId },
                input.signal,
              ),
            input.signal,
          );
          validateManifest(manifest, begun.assetId, input, metadata);
          await verifyOwnedFile(owned);
          throwIfAborted(input.signal);
          // Nothing enters the result mapping until the Server's immutable finalized manifest
          // and the original open file have both passed identity and integrity checks.
          mappings.set(file.id, manifest.id);
          assets.push(structuredClone(manifest));
        } finally {
          await owned.handle.close();
        }
      }
      return snapshot();
    } catch (error) {
      const aborted = input.signal?.aborted === true;
      const code = aborted
        ? "ABORTED"
        : error instanceof UploadFailure
          ? error.code
          : error instanceof ProtocolError
            ? "PROTOCOL_ERROR"
            : error instanceof WorkerApiError
              ? "UPLOAD_FAILED"
              : "FILE_READ_FAILED";
      const safeId =
        activeId !== null && !activeId.includes(input.lease?.leaseToken ?? "") ? activeId : null;
      throw new EvidenceUploadError(
        code,
        snapshot(),
        safeId,
        !aborted && error instanceof WorkerApiError && retryableNetworkFailure(error),
        !aborted && error instanceof WorkerApiError && error.isLeaseLost,
      );
    }
  }

  async #retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfAborted(signal);
      try {
        const value = await operation();
        throwIfAborted(signal);
        return value;
      } catch (error) {
        throwIfAborted(signal);
        if (!(error instanceof WorkerApiError) || !retryableNetworkFailure(error) || attempt === 2)
          throw error;
        try {
          await delay(this.#retryBaseDelayMs * 2 ** attempt, undefined, { signal });
        } catch {
          throw new UploadFailure("ABORTED");
        }
      }
    }
    throw new UploadFailure("UPLOAD_FAILED");
  }
}

function mergeCompletedEvidence(
  first: EvidenceUploadResult,
  second: EvidenceUploadResult,
): EvidenceUploadResult {
  const localIds = new Set(Object.keys(first.assetIds));
  const serverIds = new Set(first.assets.map((asset) => asset.id));
  for (const id of Object.keys(second.assetIds))
    if (localIds.has(id)) throw new UploadFailure("PROTOCOL_ERROR");
  for (const asset of second.assets)
    if (serverIds.has(asset.id)) throw new UploadFailure("PROTOCOL_ERROR");
  return {
    assetIds: { ...first.assetIds, ...second.assetIds },
    assets: structuredClone([...first.assets, ...second.assets]),
  };
}

async function writeNormalizedEvidence(root: string, bytes: Buffer): Promise<string> {
  await validateOwnedDirectory(root);
  const parent = await lstat(root, { bigint: true });
  const relativePath = `normalized-${randomUUID()}.json`;
  const path = join(root, relativePath);
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const current = await lstat(root, { bigint: true });
    const opened = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      parent.dev !== current.dev ||
      parent.ino !== current.ino ||
      (await realpath(root)) !== root ||
      !opened.isFile() ||
      opened.nlink !== 1n ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    )
      throw new UploadFailure("INVALID_PATH");
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return relativePath;
}

function validateInput(input: EvidenceUploadInput): void {
  if (
    !Value.Check(LeaseIdentitySchema, input.lease) ||
    !Value.Check(EvidenceUploadScopeSchema, input.scope) ||
    !Value.Check(DateTimeSchema, input.capturedAt) ||
    !Array.isArray(input.files) ||
    input.files.length > maximumAttemptEvidenceAssets ||
    !(input.signal instanceof AbortSignal)
  )
    throw new UploadFailure("INVALID_INPUT");
  const ids = new Set<string>();
  const paths = new Set<string>();
  let total = 0;
  for (const file of input.files) {
    if (
      typeof file.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(file.id) ||
      file.id.includes(input.lease.leaseToken) ||
      ids.has(file.id)
    )
      throw new UploadFailure("INVALID_INPUT");
    ids.add(file.id);
    validateRelativePath(file.relativePath);
    const pathKey =
      process.platform === "win32" ? file.relativePath.toLowerCase() : file.relativePath;
    if (paths.has(pathKey)) throw new UploadFailure("INVALID_INPUT");
    paths.add(pathKey);
    metadataFor(file, input.capturedAt);
    total += file.sizeBytes;
    if (total > maximumAttemptEvidenceBytes) throw new UploadFailure("INVALID_INPUT");
  }
}

function metadataFor(file: LocalEvidenceFile, capturedAt: string): EvidenceAssetMetadata {
  const value: unknown = {
    kind: file.kind === "ui_steps" ? "steps" : file.kind,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    capturedAt: file.capturedAt ?? capturedAt,
    ...(file.checkId === undefined ? {} : { checkId: file.checkId }),
  };
  if (!Value.Check(EvidenceAssetMetadataSchema, value)) throw new UploadFailure("INVALID_INPUT");
  return value;
}
function validateManifest(
  value: unknown,
  id: string,
  input: EvidenceUploadInput,
  metadata: EvidenceAssetMetadata,
): asserts value is EvidenceAssetManifest {
  if (
    !Value.Check(EvidenceAssetManifestSchema, value) ||
    value.id !== id ||
    value.jobId !== input.lease.jobId ||
    value.runAttemptId !== input.lease.runAttemptId ||
    value.state !== "finalized" ||
    value.retiredAt !== null
  )
    throw new UploadFailure("PROTOCOL_ERROR");
  for (const [key, expected] of Object.entries(input.scope)) {
    if (value[key as keyof EvidenceUploadScope] !== expected)
      throw new UploadFailure("PROTOCOL_ERROR");
  }
  const actual = value.metadata;
  if (
    actual.kind !== metadata.kind ||
    actual.mediaType !== metadata.mediaType ||
    actual.sizeBytes !== metadata.sizeBytes ||
    actual.sha256 !== metadata.sha256 ||
    actual.capturedAt !== metadata.capturedAt ||
    actual.checkId !== metadata.checkId
  )
    throw new UploadFailure("PROTOCOL_ERROR");
}

function validateRelativePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length > 2_048 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?![\s\S])/u.test(path) ||
    isAbsolute(path) ||
    win32.isAbsolute(path)
  )
    throw new UploadFailure("INVALID_PATH");
  for (const component of path.split("/")) {
    if (
      component === "" ||
      component === "." ||
      component === ".." ||
      component.endsWith(".") ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(component)
    )
      throw new UploadFailure("INVALID_PATH");
  }
}
async function validateOwnedDirectory(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new UploadFailure("INVALID_PATH");
  const root = resolve(path);
  const stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root)
    throw new UploadFailure("INVALID_PATH");
  return root;
}
async function openOwnedFile(root: string, file: LocalEvidenceFile): Promise<OwnedFile> {
  const path = resolve(root, ...file.relativePath.split("/"));
  const fromRoot = relative(root, path);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new UploadFailure("INVALID_PATH");
  const directories: { path: string; initial: BigIntStats }[] = [];
  let current = root;
  for (const part of ["", ...file.relativePath.split("/").slice(0, -1)]) {
    current = part === "" ? current : join(current, part);
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)) !== current)
      throw new UploadFailure("INVALID_PATH");
    directories.push({ path: current, initial: stat });
  }
  const initial = await lstat(path, { bigint: true });
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1n ||
    initial.size !== BigInt(file.sizeBytes) ||
    (await realpath(path)) !== path
  )
    throw new UploadFailure("INVALID_PATH");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const owned = { handle, root, path, initial, directories };
  try {
    await verifyOwnedFile(owned);
    return owned;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function verifyOwnedFile(file: OwnedFile): Promise<void> {
  const current = await file.handle.stat({ bigint: true });
  const named = await lstat(file.path, { bigint: true });
  if (
    !sameFile(file.initial, current) ||
    !sameFile(file.initial, named) ||
    named.isSymbolicLink() ||
    (await realpath(file.path)) !== file.path
  )
    throw new UploadFailure("FILE_CHANGED");
  for (const directory of file.directories) {
    const stat = await lstat(directory.path, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== directory.initial.dev ||
      stat.ino !== directory.initial.ino ||
      (await realpath(directory.path)) !== directory.path
    )
      throw new UploadFailure("FILE_CHANGED");
  }
}
function sameFile(expected: BigIntStats, current: BigIntStats): boolean {
  return (
    current.isFile() &&
    current.nlink === 1n &&
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.mode === current.mode &&
    expected.size === current.size &&
    expected.mtimeNs === current.mtimeNs &&
    expected.ctimeNs === current.ctimeNs
  );
}
async function readChunk(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  length: number,
): Promise<Buffer> {
  let read = 0;
  while (read < length) {
    const chunk = await handle.read(buffer, read, length - read, position + read);
    if (chunk.bytesRead === 0) throw new UploadFailure("FILE_CHANGED");
    read += chunk.bytesRead;
  }
  return buffer.subarray(0, read);
}
async function verifyStream(
  owned: OwnedFile,
  file: LocalEvidenceFile,
  signal: AbortSignal,
  digestMismatchCode: "DIGEST_MISMATCH" | "FILE_CHANGED" = "DIGEST_MISMATCH",
): Promise<void> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(maximumEvidenceChunkBytes);
  let offset = 0;
  while (offset < file.sizeBytes) {
    throwIfAborted(signal);
    const chunk = await readChunk(
      owned.handle,
      buffer,
      offset,
      Math.min(buffer.byteLength, file.sizeBytes - offset),
    );
    digest.update(chunk);
    offset += chunk.byteLength;
  }
  await verifyOwnedFile(owned);
  if (digest.digest("hex") !== file.sha256) throw new UploadFailure(digestMismatchCode);
}
async function reportProgress(
  input: EvidenceUploadInput,
  file: LocalEvidenceFile,
  assetId: string,
  uploadedBytes: number,
): Promise<void> {
  throwIfAborted(input.signal);
  try {
    await input.onChunkProgress?.({
      localAssetId: file.id,
      assetId,
      uploadedBytes,
      totalBytes: file.sizeBytes,
    });
  } catch {
    throw new UploadFailure("PROGRESS_FAILED");
  }
  throwIfAborted(input.signal);
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new UploadFailure("ABORTED");
}
function retryableNetworkFailure(error: WorkerApiError): boolean {
  return (
    error.isRetryable &&
    (error.statusCode === undefined ||
      error.statusCode === 408 ||
      error.statusCode === 429 ||
      error.statusCode >= 500)
  );
}
