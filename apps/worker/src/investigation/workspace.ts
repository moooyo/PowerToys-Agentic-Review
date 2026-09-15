import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { win32 } from "node:path";
import {
  type InvestigationArtifactV1,
  type InvestigationAttemptV1,
  type InvestigationInputSnapshotV1,
  InvestigationInputSnapshotV1Schema,
  type InvestigationSourceEdit,
  type InvestigationTaskV1,
  investigationCanonicalJson,
  investigationSourceDigestPayload,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  assertWindowsLocalAbsolutePath,
  type ProcessHostClient,
} from "../execution/process-host-protocol.js";

export interface InvestigationSourceBinding {
  readonly subjectRef: string;
  readonly revisionKey: string;
  readonly sourceSha: string;
  readonly patchDigest: string | null;
  readonly artifactRef: string | null;
}

export interface InvestigationArtifactInput {
  readonly name: string;
  readonly mediaType: string;
  readonly kind: InvestigationArtifactV1["kind"];
  readonly subjectRef: string;
  readonly bytes: Uint8Array;
}

export type { InvestigationSourceEdit } from "@agentic-review/contracts";

export interface InvestigationSourceFile {
  readonly path: string;
  readonly content: string | null;
  readonly digest: string | null;
}

export interface InvestigationPrDiffChunkDescriptor {
  readonly id: string;
  readonly path: string;
  readonly kind: "diff" | "base" | "head";
  readonly ordinal: number;
  readonly encoding: "utf8" | "base64";
  readonly contentDigest: string;
  readonly byteLength: number;
}

export interface InvestigationPrDiffChunk extends InvestigationPrDiffChunkDescriptor {
  readonly content: string;
}

export interface InvestigationPrDiffManifest {
  readonly schemaVersion: "InvestigationPrDiffManifestV1";
  readonly subjectRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly files: readonly {
    readonly path: string;
    readonly previousPath: null;
    readonly status: "added" | "modified" | "deleted";
    readonly chunkIds: readonly string[];
  }[];
  readonly chunks: readonly InvestigationPrDiffChunkDescriptor[];
  readonly digest: string;
}

export interface PreparedInvestigationWorkspace {
  readonly attemptDirectory: string;
  readonly modelInputDirectory: string;
  readonly modelInputPath: string;
  readonly modelInputDigest: string;
  readonly controlDirectory: string;
  readonly tempDirectory: string;
  readonly sourceDirectory: string | null;
  readonly sourceBinding: InvestigationSourceBinding | null;
  writeArtifact(input: InvestigationArtifactInput): Promise<InvestigationArtifactV1>;
  readArtifact(artifactId: string): Promise<Uint8Array>;
  writePatchArtifact(input: {
    readonly subjectRef: string;
    readonly baseSubjectRef: string;
    readonly baseSha: string;
    readonly bytes: Uint8Array;
  }): Promise<InvestigationArtifactV1>;
  resolveSourcePath(relativePath: string): Promise<string>;
  readSourceFile(path: string): Promise<InvestigationSourceFile>;
  readPrDiffManifest(): Promise<InvestigationPrDiffManifest>;
  readPrDiffChunk(id: string): Promise<InvestigationPrDiffChunk>;
  applyEdits(input: {
    readonly edits: readonly InvestigationSourceEdit[];
    readonly allowedPaths: readonly string[];
  }): Promise<void>;
  assertIntegrity(): Promise<void>;
  assertSourceBinding(): Promise<void>;
  capturePatch(
    signal?: AbortSignal,
  ): Promise<{ readonly baseSha: string; readonly bytes: Uint8Array }>;
  cleanup(): Promise<void>;
}

export interface InvestigationWorkspaceInput {
  readonly task: InvestigationTaskV1;
  readonly attempt: InvestigationAttemptV1;
  readonly inputSnapshot: unknown;
}

export interface InvestigationWorkspaceContext {
  readonly signal: AbortSignal;
  readonly processHost: ProcessHostClient;
}

export interface InvestigationWorkspaceProvider {
  prepare(
    input: InvestigationWorkspaceInput,
    context: InvestigationWorkspaceContext,
  ): Promise<PreparedInvestigationWorkspace>;
}

export interface InvestigationWorkspacePathState {
  readonly kind: "directory" | "file" | "other";
  readonly reparsePoint: boolean;
  readonly identity: string;
  readonly linkCount: number;
}

export interface InvestigationWorkspaceFileSystem {
  lstat(path: string): Promise<InvestigationWorkspacePathState | null>;
  realpath(path: string): Promise<string>;
  readDirectory(path: string): Promise<readonly string[]>;
  createDirectory(path: string): Promise<void>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  replaceFile(path: string, bytes: Uint8Array, expectedIdentity: string): Promise<void>;
  readFile(path: string, expectedIdentity?: string, maximumBytes?: number): Promise<Uint8Array>;
  setReadOnly(path: string, readOnly: boolean): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
}

/** Only a trusted worker adapter may materialize and verify repository sources. */
export interface InvestigationSourceMaterializer {
  materialize(
    input: InvestigationWorkspaceInput & { readonly destinationDirectory: string },
    context: InvestigationWorkspaceContext,
  ): Promise<{
    readonly binding: InvestigationSourceBinding;
    /** Re-read the materialized source identity instead of trusting declared metadata. */
    assertBinding(): Promise<void>;
    /** Capture the actual worktree diff through a trusted managed process. */
    capturePatch?(signal: AbortSignal): Promise<Uint8Array>;
    readPrDiffManifest?(): Promise<InvestigationPrDiffManifest>;
    readPrDiffChunk?(id: string): Promise<InvestigationPrDiffChunk>;
  }>;
}

export interface ProductionInvestigationWorkspaceProviderOptions {
  readonly workspaceRootDirectory: string;
  readonly fileSystem?: InvestigationWorkspaceFileSystem;
  readonly sourceMaterializer?: InvestigationSourceMaterializer;
  readonly createId?: () => string;
  readonly maximumInputBytes?: number;
  readonly maximumArtifactBytes?: number;
  readonly maximumTreeEntries?: number;
}

export type InvestigationWorkspaceFailureCode =
  | "INVALID_INPUT"
  | "WORKSPACE_PATH_UNSAFE"
  | "WORKSPACE_ALREADY_EXISTS"
  | "WORKSPACE_NOT_OWNED"
  | "WORKSPACE_CLOSED"
  | "INPUT_TAMPERED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_BINDING_MISMATCH"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "WORKSPACE_TREE_LIMIT_EXCEEDED"
  | "ARTIFACT_UNAVAILABLE"
  | "ARTIFACT_TAMPERED"
  | "SOURCE_EDIT_NOT_AUTHORIZED"
  | "SOURCE_EDIT_CONFLICT"
  | "SOURCE_NOT_TEXT"
  | "SOURCE_EDIT_LIMIT_EXCEEDED";

export class InvestigationWorkspaceError extends Error {
  public constructor(
    public readonly code: InvestigationWorkspaceFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InvestigationWorkspaceError";
  }
}

export class ProductionInvestigationWorkspaceFileSystem
  implements InvestigationWorkspaceFileSystem
{
  public async lstat(path: string): Promise<InvestigationWorkspacePathState | null> {
    try {
      const state = await lstat(path, { bigint: true });
      const reparseAwareState = state as typeof state & { isReparsePoint?(): boolean };
      return {
        kind: state.isDirectory() ? "directory" : state.isFile() ? "file" : "other",
        reparsePoint: state.isSymbolicLink() || reparseAwareState.isReparsePoint?.() === true,
        identity: `${state.dev}:${state.ino}`,
        linkCount: Number(state.nlink),
      };
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  public realpath(path: string): Promise<string> {
    return realpath(path);
  }
  public readDirectory(path: string): Promise<readonly string[]> {
    return readdir(path);
  }
  public async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: false });
  }
  public async writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
  public async replaceFile(
    path: string,
    bytes: Uint8Array,
    expectedIdentity: string,
  ): Promise<void> {
    const handle = await open(path, "r+");
    try {
      assertOpenFileIdentity(await handle.stat({ bigint: true }), expectedIdentity);
      await handle.truncate(0);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
        if (written.bytesWritten === 0)
          throw failure("SOURCE_EDIT_CONFLICT", "The source file write made no progress.");
        offset += written.bytesWritten;
      }
      await handle.sync();
      const finalState = await handle.stat({ bigint: true });
      assertOpenFileIdentity(finalState, expectedIdentity);
      if (finalState.size !== BigInt(bytes.byteLength)) {
        throw failure(
          "SOURCE_EDIT_CONFLICT",
          "The source file size changed while its replacement was written.",
        );
      }
    } finally {
      await handle.close();
    }
  }
  public async readFile(
    path: string,
    expectedIdentity?: string,
    maximumBytes?: number,
  ): Promise<Uint8Array> {
    const handle = await open(path, "r");
    try {
      const before = await handle.stat({ bigint: true });
      assertOpenFileIdentity(before, expectedIdentity);
      if (maximumBytes !== undefined && before.size > BigInt(maximumBytes)) {
        throw failure("SOURCE_EDIT_LIMIT_EXCEEDED", "The source file exceeds its read byte limit.");
      }
      let bytes: Buffer;
      if (maximumBytes === undefined) bytes = await handle.readFile();
      else {
        const chunks: Buffer[] = [];
        let byteLength = 0;
        for (;;) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, maximumBytes - byteLength + 1));
          const read = await handle.read(chunk, 0, chunk.byteLength, byteLength);
          if (read.bytesRead === 0) break;
          byteLength += read.bytesRead;
          if (byteLength > maximumBytes) {
            throw failure(
              "SOURCE_EDIT_LIMIT_EXCEEDED",
              "The source file exceeds its read byte limit.",
            );
          }
          chunks.push(chunk.subarray(0, read.bytesRead));
        }
        bytes = Buffer.concat(chunks, byteLength);
      }
      const after = await handle.stat({ bigint: true });
      assertOpenFileIdentity(after, expectedIdentity);
      if (
        before.size !== after.size ||
        after.size !== BigInt(bytes.byteLength) ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw failure("SOURCE_EDIT_CONFLICT", "The file changed while its bytes were being read.");
      }
      if (maximumBytes !== undefined && bytes.byteLength > maximumBytes) {
        throw failure("SOURCE_EDIT_LIMIT_EXCEEDED", "The source file exceeds its read byte limit.");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }
  public async setReadOnly(path: string, readOnly: boolean): Promise<void> {
    await chmod(path, readOnly ? 0o400 : 0o600);
  }
  public async removeFile(path: string): Promise<void> {
    await unlink(path);
  }
  public async removeEmptyDirectory(path: string): Promise<void> {
    await rmdir(path);
  }
}

interface OwnedLayout {
  readonly root: string;
  readonly attempt: string;
  readonly owner: string;
  readonly modelInput: string;
  readonly snapshot: string;
  readonly control: string;
  readonly temp: string;
  readonly artifacts: string;
  readonly source: string;
}

type MaterializedSource = Awaited<ReturnType<InvestigationSourceMaterializer["materialize"]>>;

interface SourceFileObservation extends InvestigationSourceFile {
  readonly absolutePath: string;
  readonly identity: string | null;
  readonly bytes: Uint8Array | null;
}

export class ProductionInvestigationWorkspaceProvider implements InvestigationWorkspaceProvider {
  readonly #root: string;
  readonly #fs: InvestigationWorkspaceFileSystem;
  readonly #sourceMaterializer: InvestigationSourceMaterializer | undefined;
  readonly #createId: () => string;
  readonly #maximumInputBytes: number;
  readonly #maximumArtifactBytes: number;
  readonly #maximumTreeEntries: number;

  public constructor(options: ProductionInvestigationWorkspaceProviderOptions) {
    assertPath(options.workspaceRootDirectory);
    this.#root = win32.normalize(options.workspaceRootDirectory);
    if (samePath(this.#root, win32.parse(this.#root).root)) {
      throw failure(
        "WORKSPACE_PATH_UNSAFE",
        "A drive root cannot be an investigation workspace root.",
      );
    }
    this.#fs = options.fileSystem ?? new ProductionInvestigationWorkspaceFileSystem();
    this.#sourceMaterializer = options.sourceMaterializer;
    this.#createId = options.createId ?? randomUUID;
    this.#maximumInputBytes = positiveLimit(options.maximumInputBytes ?? 8 * 1_024 * 1_024);
    this.#maximumArtifactBytes = positiveLimit(options.maximumArtifactBytes ?? 32 * 1_024 * 1_024);
    this.#maximumTreeEntries = positiveLimit(options.maximumTreeEntries ?? 100_000);
  }

  public async prepare(
    input: InvestigationWorkspaceInput,
    context: InvestigationWorkspaceContext,
  ): Promise<PreparedInvestigationWorkspace> {
    context.signal.throwIfAborted();
    validateTaskAttempt(input);
    const snapshot = validateSnapshot(input);
    const snapshotBytes = serializeSnapshot(snapshot, this.#maximumInputBytes);
    const snapshotDigest = digest(snapshotBytes);
    const attemptName = `task-${digest(Buffer.from(input.task.id)).slice(0, 24)}-attempt-${digest(Buffer.from(input.attempt.id)).slice(0, 24)}-lease-${input.attempt.leaseVersion}`;
    const attemptDirectory = childPath(this.#root, attemptName);
    const layout: OwnedLayout = {
      root: this.#root,
      attempt: attemptDirectory,
      owner: childPath(attemptDirectory, ".owner.json"),
      modelInput: childPath(attemptDirectory, "model-input"),
      snapshot: childPath(attemptDirectory, "model-input", "snapshot.json"),
      control: childPath(attemptDirectory, "control"),
      temp: childPath(attemptDirectory, "temp"),
      artifacts: childPath(attemptDirectory, "artifacts"),
      source: childPath(attemptDirectory, "source"),
    };
    const identities = new Map<string, string>();
    const guard = new WorkspaceGuard(this.#fs, layout, identities, this.#maximumTreeEntries);
    await guard.assertPath(layout.root, "directory");
    identities.set(
      pathKey(layout.root),
      (await guard.assertPath(layout.root, "directory")).identity,
    );
    if ((await this.#fs.lstat(layout.attempt)) !== null) {
      throw failure(
        "WORKSPACE_ALREADY_EXISTS",
        "The investigation attempt workspace already exists.",
      );
    }
    await guard.assertPath(layout.root, "directory");
    try {
      await this.#fs.createDirectory(layout.attempt);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw failure(
          "WORKSPACE_ALREADY_EXISTS",
          "The investigation attempt workspace already exists.",
        );
      }
      throw error;
    }
    identities.set(
      pathKey(layout.attempt),
      (await guard.assertPath(layout.attempt, "directory")).identity,
    );
    const ownerBytes = Buffer.from(
      JSON.stringify({
        taskId: input.task.id,
        attemptId: input.attempt.id,
        leaseVersion: input.attempt.leaseVersion,
        nonce: randomUUID(),
      }),
      "utf8",
    );
    let ownerWritten = false;
    let cleaned = false;
    let cleaning = false;
    let materializedSource: MaterializedSource | null = null;
    let binding: InvestigationSourceBinding | null = null;
    const artifacts = new Map<
      string,
      { readonly path: string; readonly digest: string; readonly byteLength: number }
    >();
    const derivedSubjects = new Map<
      string,
      { readonly baseSha: string; readonly patchDigest: string }
    >();
    let frozenPrDiffManifest: InvestigationPrDiffManifest | null = null;
    const prDiffChunks = new Map<string, InvestigationPrDiffChunkDescriptor>();
    const assertOpen = () => {
      if (cleaned || cleaning)
        throw failure("WORKSPACE_CLOSED", "The investigation workspace is closed.");
    };
    const assertOwned = async () => {
      await guard.assertPath(layout.attempt, "directory");
      if (!ownerWritten)
        throw failure("WORKSPACE_NOT_OWNED", "The workspace has no ownership marker.");
      await guard.assertPath(layout.owner, "file");
      if (!equalBytes(await this.#fs.readFile(layout.owner), ownerBytes)) {
        throw failure(
          "WORKSPACE_NOT_OWNED",
          "The investigation workspace ownership marker changed.",
        );
      }
    };
    const cleanup = async () => {
      if (cleaned) return;
      if (cleaning) throw failure("WORKSPACE_CLOSED", "Workspace cleanup is already running.");
      cleaning = true;
      try {
        await assertOwned();
        await guard.removeOwnedTree(assertOwned);
        cleaned = true;
      } finally {
        cleaning = false;
      }
    };
    try {
      await this.#fs.writeExclusive(layout.owner, ownerBytes);
      ownerWritten = true;
      identities.set(
        pathKey(layout.owner),
        (await guard.assertPath(layout.owner, "file")).identity,
      );
      await this.#fs.setReadOnly(layout.owner, true);
      for (const directory of [layout.modelInput, layout.control, layout.temp, layout.artifacts]) {
        context.signal.throwIfAborted();
        await assertOwned();
        await this.#fs.createDirectory(directory);
        identities.set(
          pathKey(directory),
          (await guard.assertPath(directory, "directory")).identity,
        );
      }
      await this.#fs.writeExclusive(layout.snapshot, snapshotBytes);
      identities.set(
        pathKey(layout.snapshot),
        (await guard.assertPath(layout.snapshot, "file")).identity,
      );
      await this.#fs.setReadOnly(layout.snapshot, true);
      if (input.task.executionPolicy.mode !== "snapshot_only") {
        if (this.#sourceMaterializer === undefined) {
          throw failure(
            "SOURCE_UNAVAILABLE",
            "A trusted source materializer is required by this task policy.",
          );
        }
        await assertOwned();
        await this.#fs.createDirectory(layout.source);
        identities.set(
          pathKey(layout.source),
          (await guard.assertPath(layout.source, "directory")).identity,
        );
        materializedSource = await this.#sourceMaterializer.materialize(
          {
            ...input,
            destinationDirectory: layout.source,
          },
          context,
        );
        binding = Object.freeze({ ...materializedSource.binding });
        validateBinding(input.task, binding);
        if (snapshot.source !== null && binding.artifactRef !== snapshot.source.artifactRef) {
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The materialized source is bound to a different input artifact.",
          );
        }
        await guard.assertTree(layout.source);
        await materializedSource.assertBinding();
      }
      const assertIntegrity = async () => {
        assertOpen();
        await assertOwned();
        await guard.assertPath(layout.modelInput, "directory");
        const entries = await this.#fs.readDirectory(layout.modelInput);
        if (entries.length !== 1 || entries[0] !== "snapshot.json") {
          throw failure("INPUT_TAMPERED", "The frozen model input directory changed.");
        }
        await guard.assertPath(layout.snapshot, "file");
        if (digest(await this.#fs.readFile(layout.snapshot)) !== snapshotDigest) {
          throw failure("INPUT_TAMPERED", "The frozen model input bytes changed.");
        }
      };
      const assertSourceBinding = async () => {
        await assertIntegrity();
        if (materializedSource === null || binding === null) {
          throw failure("SOURCE_UNAVAILABLE", "This workspace has no verified repository source.");
        }
        validateBinding(input.task, binding);
        await guard.assertTree(layout.source);
        await materializedSource.assertBinding();
        await assertIntegrity();
      };
      const readPrDiffManifest = async (): Promise<InvestigationPrDiffManifest> => {
        await assertSourceBinding();
        if (
          materializedSource?.readPrDiffManifest === undefined ||
          materializedSource.readPrDiffChunk === undefined ||
          binding === null
        ) {
          throw failure(
            "SOURCE_UNAVAILABLE",
            "The trusted source materializer cannot provide the complete PR diff manifest and chunks.",
          );
        }
        const manifest = structuredClone(await materializedSource.readPrDiffManifest());
        validatePrDiffManifest(
          input.task,
          binding,
          manifest,
          this.#maximumTreeEntries,
          this.#maximumInputBytes,
        );
        if (frozenPrDiffManifest !== null && manifest.digest !== frozenPrDiffManifest.digest) {
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The PR diff manifest changed after it was frozen for this workspace.",
          );
        }
        await assertSourceBinding();
        if (frozenPrDiffManifest === null) {
          frozenPrDiffManifest = manifest;
          for (const descriptor of manifest.chunks) prDiffChunks.set(descriptor.id, descriptor);
        }
        return structuredClone(frozenPrDiffManifest);
      };
      const readPrDiffChunk = async (id: string): Promise<InvestigationPrDiffChunk> => {
        await readPrDiffManifest();
        const expected = prDiffChunks.get(id);
        if (expected === undefined) {
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The requested PR diff chunk does not belong to the frozen manifest.",
          );
        }
        if (materializedSource?.readPrDiffChunk === undefined) {
          throw failure(
            "SOURCE_UNAVAILABLE",
            "The trusted source materializer cannot read complete PR diff chunks.",
          );
        }
        const chunk = structuredClone(await materializedSource.readPrDiffChunk(id));
        validatePrDiffChunk(chunk, expected);
        await assertSourceBinding();
        return chunk;
      };
      const inspectSourceFile = async (relativePath: string): Promise<SourceFileObservation> => {
        const absolutePath = resolveEditableSourcePath(layout.source, relativePath);
        const path = win32.relative(layout.source, absolutePath).replace(/\\/gu, "/");
        const before = await guard.assertOptionalSourceFile(absolutePath);
        if (before === null) {
          if ((await guard.assertOptionalSourceFile(absolutePath)) !== null) {
            throw failure(
              "SOURCE_EDIT_CONFLICT",
              "The source file appeared while its absence was being checked.",
            );
          }
          return { path, absolutePath, identity: null, bytes: null, content: null, digest: null };
        }
        const bytes = await this.#fs.readFile(
          absolutePath,
          before.identity,
          this.#maximumArtifactBytes,
        );
        assertSourceByteLimit(bytes.byteLength, this.#maximumArtifactBytes);
        const content = decodeSourceText(bytes);
        const fileDigest = digest(bytes);
        const after = await guard.assertPath(absolutePath, "file");
        if (after.identity !== before.identity) {
          throw failure(
            "SOURCE_EDIT_CONFLICT",
            "The source file identity changed while it was being read.",
          );
        }
        const verifiedBytes = await this.#fs.readFile(
          absolutePath,
          before.identity,
          this.#maximumArtifactBytes,
        );
        if (
          verifiedBytes.byteLength !== bytes.byteLength ||
          digest(verifiedBytes) !== fileDigest ||
          (await guard.assertPath(absolutePath, "file")).identity !== before.identity
        ) {
          throw failure(
            "SOURCE_EDIT_CONFLICT",
            "The source file bytes changed while they were being read.",
          );
        }
        return {
          path,
          absolutePath,
          identity: before.identity,
          bytes,
          content,
          digest: fileDigest,
        };
      };
      const assertSourceEditAuthorization = () => {
        const policy = input.task.executionPolicy;
        if (
          (input.task.kind !== "issue-fix" && input.task.kind !== "feature-implement") ||
          policy.mode !== "execute" ||
          !policy.allowRepositoryExecution ||
          policy.authorizationRef === null ||
          binding === null ||
          binding.subjectRef !== input.task.subjectRef ||
          !policy.allowedSubjectRefs.includes(input.task.subjectRef)
        ) {
          throw failure(
            "SOURCE_EDIT_NOT_AUTHORIZED",
            "Source edits require an authorized execution task bound to its primary subject.",
          );
        }
      };
      const applyEdits = async (requested: {
        readonly edits: readonly InvestigationSourceEdit[];
        readonly allowedPaths: readonly string[];
      }): Promise<void> => {
        assertOpen();
        assertSourceEditAuthorization();
        context.signal.throwIfAborted();
        await assertSourceBinding();
        const edits = requested.edits.map((edit) => ({ ...edit }));
        const allowedPaths = [...requested.allowedPaths];
        if (
          edits.length > this.#maximumTreeEntries ||
          allowedPaths.length > this.#maximumTreeEntries
        ) {
          throw failure(
            "SOURCE_EDIT_LIMIT_EXCEEDED",
            "The requested source edit set exceeds its entry limit.",
          );
        }
        const allowed = new Set<string>();
        for (const relativePath of allowedPaths) {
          const path = pathKey(resolveEditableSourcePath(layout.source, relativePath));
          if (allowed.has(path)) {
            throw failure(
              "SOURCE_EDIT_NOT_AUTHORIZED",
              "The source edit allowlist must contain unique exact file paths.",
            );
          }
          allowed.add(path);
        }
        const targets = new Set<string>();
        const prepared: Array<{
          edit: InvestigationSourceEdit;
          bytes: Uint8Array | null;
          original: SourceFileObservation;
        }> = [];
        let totalReadBytes = 0;
        let totalWriteBytes = 0;
        for (const edit of edits) {
          context.signal.throwIfAborted();
          const target = pathKey(resolveEditableSourcePath(layout.source, edit.path));
          if (!allowed.has(target) || targets.has(target)) {
            throw failure(
              "SOURCE_EDIT_NOT_AUTHORIZED",
              "Every source edit must identify one unique allowlisted file path.",
            );
          }
          targets.add(target);
          if (edit.expectedDigest !== null && !/^[a-f0-9]{64}$/u.test(edit.expectedDigest)) {
            throw failure(
              "SOURCE_EDIT_CONFLICT",
              "Source edits require a complete SHA-256 digest of the expected file bytes.",
            );
          }
          if (edit.content === null && edit.expectedDigest === null) {
            throw failure(
              "SOURCE_EDIT_CONFLICT",
              "A file deletion must identify an existing file and its expected digest.",
            );
          }
          const bytes = edit.content === null ? null : encodeSourceText(edit.content);
          if (bytes !== null) assertSourceByteLimit(bytes.byteLength, this.#maximumArtifactBytes);
          const original = await inspectSourceFile(edit.path);
          if (original.digest !== edit.expectedDigest) {
            throw failure(
              "SOURCE_EDIT_CONFLICT",
              "The source file does not match the edit's expected digest or absence.",
            );
          }
          totalReadBytes += original.bytes?.byteLength ?? 0;
          totalWriteBytes += bytes?.byteLength ?? 0;
          assertSourceByteLimit(totalReadBytes, this.#maximumInputBytes);
          assertSourceByteLimit(totalWriteBytes, this.#maximumInputBytes);
          prepared.push({ edit, bytes, original });
        }
        for (const target of targets) {
          let parent = win32.dirname(target);
          while (!samePath(parent, layout.source)) {
            if (targets.has(pathKey(parent))) {
              throw failure(
                "SOURCE_EDIT_NOT_AUTHORIZED",
                "A source edit cannot also target the parent path of another edited file.",
              );
            }
            parent = win32.dirname(parent);
          }
        }
        // All requested digests and paths are checked before the first mutation. Later failures remain explicit.
        await assertSourceBinding();
        for (const { edit, bytes, original } of prepared) {
          context.signal.throwIfAborted();
          const current = await inspectSourceFile(edit.path);
          if (current.identity !== original.identity || current.digest !== original.digest) {
            throw failure(
              "SOURCE_EDIT_CONFLICT",
              "The source file changed after the edit batch was checked.",
            );
          }
          await assertIntegrity();
          if (bytes === null) {
            if (
              (await guard.assertPath(original.absolutePath, "file")).identity !== original.identity
            ) {
              throw failure(
                "SOURCE_EDIT_CONFLICT",
                "The source file identity changed before its deletion.",
              );
            }
            await this.#fs.removeFile(original.absolutePath);
          } else if (original.identity === null) {
            await guard.createSourceParentDirectories(original.absolutePath);
            if ((await guard.assertOptionalSourceFile(original.absolutePath)) !== null) {
              throw failure(
                "SOURCE_EDIT_CONFLICT",
                "The source file appeared before its exclusive creation.",
              );
            }
            await this.#fs.writeExclusive(original.absolutePath, bytes);
          } else {
            await guard.assertPath(original.absolutePath, "file");
            await this.#fs.replaceFile(original.absolutePath, bytes, original.identity);
          }
          const written = await inspectSourceFile(edit.path);
          if (written.digest !== (bytes === null ? null : digest(bytes))) {
            throw failure(
              "SOURCE_EDIT_CONFLICT",
              "The source edit did not produce the expected file bytes.",
            );
          }
        }
        await assertSourceBinding();
        await assertIntegrity();
      };
      const storeArtifact = async (
        artifact: InvestigationArtifactInput,
        allowDerivedSubject = false,
      ): Promise<InvestigationArtifactV1> => {
        await assertIntegrity();
        context.signal.throwIfAborted();
        validateArtifactInput(
          input.task,
          artifact,
          this.#maximumArtifactBytes,
          allowDerivedSubject,
        );
        const artifactId = `artifact-${this.#createId()}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(artifactId)) {
          throw failure("INVALID_INPUT", "Artifact identifiers must be safe entity identifiers.");
        }
        const bytes = Uint8Array.from(artifact.bytes);
        const artifactPath = childPath(layout.artifacts, `${artifactId}.bin`);
        await guard.assertPath(layout.artifacts, "directory");
        await this.#fs.writeExclusive(artifactPath, bytes);
        identities.set(
          pathKey(artifactPath),
          (await guard.assertPath(artifactPath, "file")).identity,
        );
        await this.#fs.setReadOnly(artifactPath, true);
        await assertIntegrity();
        const artifactDigest = digest(bytes);
        const writtenBytes = await this.#fs.readFile(artifactPath);
        if (
          writtenBytes.byteLength !== bytes.byteLength ||
          digest(writtenBytes) !== artifactDigest
        ) {
          throw failure("ARTIFACT_TAMPERED", "The artifact bytes changed while being written.");
        }
        artifacts.set(artifactId, {
          path: artifactPath,
          digest: artifactDigest,
          byteLength: bytes.byteLength,
        });
        return {
          id: artifactId,
          taskId: input.task.id,
          attemptId: input.attempt.id,
          subjectRef: artifact.subjectRef,
          kind: artifact.kind,
          name: artifact.name,
          mediaType: artifact.mediaType,
          digest: artifactDigest,
          byteLength: bytes.byteLength,
          availability: "available",
        };
      };
      const workspace: PreparedInvestigationWorkspace = {
        attemptDirectory: layout.attempt,
        modelInputDirectory: layout.modelInput,
        modelInputPath: layout.snapshot,
        modelInputDigest: snapshotDigest,
        controlDirectory: layout.control,
        tempDirectory: layout.temp,
        sourceDirectory: binding === null ? null : layout.source,
        sourceBinding: binding,
        assertIntegrity,
        assertSourceBinding,
        writeArtifact: async (artifact) => {
          if (input.task.subjects.some((subject) => subject.id === artifact.subjectRef)) {
            return storeArtifact(artifact);
          }
          const derived = derivedSubjects.get(artifact.subjectRef);
          if (derived === undefined) {
            throw failure(
              "INVALID_INPUT",
              "Artifact metadata must identify a task subject or a registered derived subject.",
            );
          }
          const actual = await workspace.capturePatch();
          if (actual.baseSha !== derived.baseSha || digest(actual.bytes) !== derived.patchDigest) {
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "The current source no longer matches the registered derived subject.",
            );
          }
          return storeArtifact(artifact, true);
        },
        readArtifact: async (artifactId) => {
          await assertIntegrity();
          const artifact = artifacts.get(artifactId);
          if (artifact === undefined) {
            throw failure(
              "ARTIFACT_UNAVAILABLE",
              "The artifact does not belong to this prepared workspace.",
            );
          }
          await guard.assertPath(artifact.path, "file");
          const bytes = await this.#fs.readFile(artifact.path);
          if (bytes.byteLength !== artifact.byteLength || digest(bytes) !== artifact.digest) {
            throw failure(
              "ARTIFACT_TAMPERED",
              "The artifact bytes no longer match their recorded digest and size.",
            );
          }
          await assertIntegrity();
          return Uint8Array.from(bytes);
        },
        writePatchArtifact: async (patch) => {
          const bytes = Uint8Array.from(patch.bytes);
          await assertSourceBinding();
          if (
            (input.task.kind !== "issue-fix" && input.task.kind !== "feature-implement") ||
            patch.baseSubjectRef !== input.task.subjectRef ||
            binding === null ||
            patch.baseSha !== binding.sourceSha ||
            bytes.byteLength === 0 ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(patch.subjectRef) ||
            input.task.subjects.some((subject) => subject.id === patch.subjectRef) ||
            derivedSubjects.has(patch.subjectRef)
          ) {
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "Patch artifacts must identify a new subject derived from this task's verified source.",
            );
          }
          const actual = await workspace.capturePatch();
          if (actual.baseSha !== patch.baseSha || !equalBytes(actual.bytes, bytes)) {
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "Patch artifact bytes do not match the captured worktree changes.",
            );
          }
          const artifact = await storeArtifact(
            {
              subjectRef: patch.subjectRef,
              bytes,
              kind: "patch",
              name: "changes.patch",
              mediaType: "text/x-diff",
            },
            true,
          );
          derivedSubjects.set(patch.subjectRef, {
            baseSha: patch.baseSha,
            patchDigest: artifact.digest,
          });
          return artifact;
        },
        resolveSourcePath: async (relativePath) => {
          await assertSourceBinding();
          const path = resolveRelativeSourcePath(layout.source, relativePath);
          await guard.assertPath(path);
          return path;
        },
        readSourceFile: async (relativePath) => {
          await assertSourceBinding();
          const observed = await inspectSourceFile(relativePath);
          await assertSourceBinding();
          return { path: observed.path, content: observed.content, digest: observed.digest };
        },
        readPrDiffManifest,
        readPrDiffChunk,
        applyEdits,
        capturePatch: async (signal = context.signal) => {
          signal.throwIfAborted();
          await assertSourceBinding();
          if (materializedSource?.capturePatch === undefined || binding === null) {
            throw failure(
              "SOURCE_UNAVAILABLE",
              "The source materializer cannot capture a verified patch.",
            );
          }
          const bytes = Uint8Array.from(await materializedSource.capturePatch(signal));
          signal.throwIfAborted();
          if (bytes.byteLength > this.#maximumArtifactBytes) {
            throw failure(
              "ARTIFACT_LIMIT_EXCEEDED",
              "The captured patch exceeds the artifact byte limit.",
            );
          }
          await assertSourceBinding();
          return { baseSha: binding.sourceSha, bytes };
        },
        cleanup,
      };
      await assertIntegrity();
      context.signal.throwIfAborted();
      return workspace;
    } catch (error) {
      const unconfirmedSourceProcess = findSourceCleanupUnconfirmed(error);
      if (unconfirmedSourceProcess !== undefined) {
        // A live managed process may still use this directory. Preserve its owner and propagate the fault.
        throw unconfirmedSourceProcess;
      }
      try {
        if (ownerWritten) await cleanup();
        else {
          await guard.assertPath(layout.attempt, "directory");
          await this.#fs.removeEmptyDirectory(layout.attempt);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Workspace preparation and owned cleanup failed.",
        );
      }
      throw error;
    }
  }
}

class WorkspaceGuard {
  public constructor(
    private readonly fs: InvestigationWorkspaceFileSystem,
    private readonly layout: OwnedLayout,
    private readonly identities: ReadonlyMap<string, string>,
    private readonly maximumTreeEntries: number,
  ) {}

  public async assertPath(
    path: string,
    expectedKind?: InvestigationWorkspacePathState["kind"],
  ): Promise<InvestigationWorkspacePathState> {
    assertPath(path);
    if (!samePath(path, this.layout.root)) assertDescendant(this.layout.root, path);
    const relative = win32.relative(this.layout.root, path);
    const components = relative === "" ? [] : relative.split("\\");
    const paths = [this.layout.root];
    for (const component of components)
      paths.push(childPath(paths.at(-1) ?? this.layout.root, component));
    let finalState: InvestigationWorkspacePathState | null = null;
    for (const [index, current] of paths.entries()) {
      const state = await this.fs.lstat(current);
      if (
        state === null ||
        state.reparsePoint ||
        state.kind === "other" ||
        (index < paths.length - 1 && state.kind !== "directory") ||
        (state.kind === "file" && state.linkCount !== 1)
      ) {
        throw failure(
          "WORKSPACE_PATH_UNSAFE",
          "A workspace path is missing, linked, or has an unsafe type.",
        );
      }
      const expectedIdentity = this.identities.get(pathKey(current));
      if (expectedIdentity !== undefined && state.identity !== expectedIdentity) {
        throw failure(
          "WORKSPACE_NOT_OWNED",
          "A workspace path was replaced after ownership was established.",
        );
      }
      if (!samePath(await this.fs.realpath(current), current)) {
        throw failure(
          "WORKSPACE_PATH_UNSAFE",
          "A workspace path resolves outside its expected location.",
        );
      }
      finalState = state;
    }
    if (finalState === null || (expectedKind !== undefined && finalState.kind !== expectedKind)) {
      throw failure("WORKSPACE_PATH_UNSAFE", "The workspace path does not have the expected type.");
    }
    return finalState;
  }

  public async assertTree(directory: string): Promise<void> {
    await this.scanTree(directory);
  }

  public async assertOptionalSourceFile(
    path: string,
  ): Promise<InvestigationWorkspacePathState | null> {
    assertDescendant(this.layout.source, path);
    await this.assertPath(this.layout.source, "directory");
    const components = win32.relative(this.layout.source, path).split("\\");
    let parent = this.layout.source;
    for (const [index, component] of components.entries()) {
      const current = childPath(parent, component);
      const state = await this.fs.lstat(current);
      if (state === null) {
        await this.assertPath(parent, "directory");
        return null;
      }
      await this.assertPath(current, index === components.length - 1 ? "file" : "directory");
      if (index === components.length - 1) return state;
      parent = current;
    }
    throw failure(
      "WORKSPACE_PATH_UNSAFE",
      "A source file path must identify a file below the source root.",
    );
  }

  public async createSourceParentDirectories(path: string): Promise<void> {
    assertDescendant(this.layout.source, path);
    const relative = win32.relative(this.layout.source, win32.dirname(path));
    let current = this.layout.source;
    await this.assertPath(current, "directory");
    for (const component of relative === "" ? [] : relative.split("\\")) {
      const parent = current;
      current = childPath(parent, component);
      if ((await this.fs.lstat(current)) === null) {
        await this.assertPath(parent, "directory");
        await this.fs.createDirectory(current);
      }
      await this.assertPath(current, "directory");
    }
  }

  private async scanTree(
    directory: string,
  ): Promise<Array<{ path: string; state: InvestigationWorkspacePathState }>> {
    const entries: Array<{ path: string; state: InvestigationWorkspacePathState }> = [];
    const pending = [directory];
    while (pending.length > 0) {
      const path = pending.pop();
      if (path === undefined) break;
      const state = await this.assertPath(path);
      entries.push({ path, state });
      if (entries.length > this.maximumTreeEntries) {
        throw failure(
          "WORKSPACE_TREE_LIMIT_EXCEEDED",
          "The workspace tree exceeds the entry limit.",
        );
      }
      if (state.kind === "directory") {
        const names = await this.fs.readDirectory(path);
        if (entries.length + pending.length + names.length > this.maximumTreeEntries) {
          throw failure(
            "WORKSPACE_TREE_LIMIT_EXCEEDED",
            "The workspace tree exceeds the entry limit.",
          );
        }
        for (const name of names) {
          assertSimpleName(name);
          pending.push(childPath(path, name));
        }
      }
    }
    return entries;
  }

  public async removeOwnedTree(assertOwned: () => Promise<void>): Promise<void> {
    const entries = await this.scanTree(this.layout.attempt);
    const ownerEntry = entries.find((entry) => samePath(entry.path, this.layout.owner));
    if (ownerEntry === undefined)
      throw failure("WORKSPACE_NOT_OWNED", "The workspace ownership marker is missing.");
    // The caller must stop all managed processes before cleanup. Only checked, individual entries are removed.
    for (const entry of entries.reverse()) {
      if (samePath(entry.path, this.layout.owner) || samePath(entry.path, this.layout.attempt))
        continue;
      await assertOwned();
      const state = await this.assertPath(entry.path, entry.state.kind);
      if (state.identity !== entry.state.identity) {
        throw failure("WORKSPACE_NOT_OWNED", "A workspace entry changed during cleanup.");
      }
      if (state.kind === "directory") await this.fs.removeEmptyDirectory(entry.path);
      else {
        await this.fs.setReadOnly(entry.path, false);
        await this.fs.removeFile(entry.path);
      }
    }
    await assertOwned();
    const remaining = await this.fs.readDirectory(this.layout.attempt);
    if (remaining.length !== 1 || remaining[0] !== ".owner.json") {
      throw failure("WORKSPACE_NOT_OWNED", "The workspace changed during cleanup.");
    }
    await this.fs.setReadOnly(this.layout.owner, false);
    await this.fs.removeFile(this.layout.owner);
    await this.assertPath(this.layout.attempt, "directory");
    await this.fs.removeEmptyDirectory(this.layout.attempt);
  }
}

function validateTaskAttempt(input: InvestigationWorkspaceInput): void {
  const subjectIds = new Set(input.task.subjects.map((subject) => subject.id));
  if (
    input.task.schemaVersion !== "InvestigationTaskV1" ||
    input.attempt.schemaVersion !== "InvestigationAttemptV1" ||
    input.attempt.taskId !== input.task.id ||
    !Number.isSafeInteger(input.attempt.leaseVersion) ||
    input.attempt.leaseVersion < 0 ||
    !subjectIds.has(input.task.subjectRef) ||
    subjectIds.size !== input.task.subjects.length ||
    input.task.subjects.some(
      (subject) =>
        subject.repositoryId !== input.task.repository.id ||
        subject.workItemId !== input.task.workItem.id,
    ) ||
    !input.task.executionPolicy.allowedSubjectRefs.includes(input.task.subjectRef) ||
    input.task.executionPolicy.allowedSubjectRefs.some((subjectRef) => !subjectIds.has(subjectRef))
  ) {
    throw failure("INVALID_INPUT", "The task, attempt, subject, and execution policy must agree.");
  }
}

function validateSnapshot(input: InvestigationWorkspaceInput): InvestigationInputSnapshotV1 {
  const snapshot = input.inputSnapshot;
  const subject = input.task.subjects.find((candidate) => candidate.id === input.task.subjectRef);
  if (
    !Value.Check(InvestigationInputSnapshotV1Schema, snapshot) ||
    subject === undefined ||
    snapshot.repositoryId !== input.task.repository.id ||
    snapshot.workItemId !== input.task.workItem.id ||
    snapshot.subjectRef !== subject.id ||
    snapshot.subjectRevisionKey !== subject.revisionKey
  ) {
    throw failure(
      "INVALID_INPUT",
      "The native input snapshot must match the task repository, work item, subject, and revision.",
    );
  }
  if (snapshot.source !== null) {
    const artifactBytes = Buffer.from(
      investigationCanonicalJson(investigationSourceDigestPayload(snapshot.source)),
      "utf8",
    );
    if (digest(artifactBytes) !== snapshot.source.artifactDigest) {
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "The source snapshot does not match its canonical artifact digest.",
      );
    }
    validateBinding(input.task, {
      subjectRef: snapshot.subjectRef,
      revisionKey: snapshot.subjectRevisionKey,
      sourceSha: snapshot.source.sourceSha,
      patchDigest: subject.kind === "local_patch" ? subject.patchDigest : null,
      artifactRef: snapshot.source.artifactRef,
    });
    const paths = new Set<string>();
    for (const file of snapshot.source.files) {
      const path = resolveRelativeSourcePath("C:\\snapshot-source", file.path);
      if (paths.has(pathKey(path)) || digest(Buffer.from(file.content, "utf8")) !== file.digest) {
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "Source snapshot files must have unique safe paths and matching content digests.",
        );
      }
      paths.add(pathKey(path));
    }
  }
  return snapshot;
}

function validateBinding(task: InvestigationTaskV1, binding: InvestigationSourceBinding): void {
  const subject = task.subjects.find((candidate) => candidate.id === binding.subjectRef);
  if (
    subject === undefined ||
    subject.id !== task.subjectRef ||
    subject.revisionKey !== binding.revisionKey ||
    !task.executionPolicy.allowedSubjectRefs.includes(binding.subjectRef)
  ) {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The materialized source is not bound to the task subject and revision.",
    );
  }
  const expectedSha =
    subject.kind === "source_commit"
      ? subject.commitSha
      : subject.kind === "original_pr" || subject.kind === "remote_branch"
        ? subject.headSha
        : subject.kind === "local_patch"
          ? subject.baseSha
          : null;
  if (
    expectedSha === null ||
    binding.sourceSha !== expectedSha ||
    binding.patchDigest !== (subject.kind === "local_patch" ? subject.patchDigest : null) ||
    (subject.kind === "local_patch" && binding.artifactRef !== subject.artifactRef)
  ) {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The materialized source SHA or patch digest does not match the task subject.",
    );
  }
}

function validatePrDiffManifest(
  task: InvestigationTaskV1,
  binding: InvestigationSourceBinding,
  manifest: InvestigationPrDiffManifest,
  maximumEntries: number,
  maximumBytes: number,
): void {
  const subject = task.subjects.find((candidate) => candidate.id === task.subjectRef);
  if (
    !hasExactKeys(manifest, [
      "schemaVersion",
      "subjectRef",
      "baseSha",
      "headSha",
      "mergeBaseSha",
      "files",
      "chunks",
      "digest",
    ]) ||
    manifest.schemaVersion !== "InvestigationPrDiffManifestV1" ||
    subject?.kind !== "original_pr" ||
    manifest.subjectRef !== subject.id ||
    manifest.baseSha !== subject.baseSha ||
    manifest.headSha !== subject.headSha ||
    manifest.headSha !== binding.sourceSha ||
    binding.subjectRef !== subject.id ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(manifest.mergeBaseSha) ||
    !/^[a-f0-9]{64}$/u.test(manifest.digest) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.chunks)
  ) {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The PR diff manifest does not match the frozen primary PR source.",
    );
  }
  if (manifest.files.length > maximumEntries || manifest.chunks.length > maximumEntries) {
    throw failure(
      "SOURCE_UNAVAILABLE",
      "The complete PR diff manifest exceeds its entry budget; no entries were truncated.",
    );
  }
  const files = new Map<string, InvestigationPrDiffManifest["files"][number]>();
  const referencedIds = new Set<string>();
  for (const file of manifest.files) {
    if (
      !hasExactKeys(file, ["path", "previousPath", "status", "chunkIds"]) ||
      file.previousPath !== null ||
      !["added", "modified", "deleted"].includes(file.status) ||
      !Array.isArray(file.chunkIds) ||
      file.chunkIds.length === 0 ||
      file.chunkIds.length > maximumEntries
    ) {
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "Every PR diff file must identify its complete registered content chunks.",
      );
    }
    const path = pathKey(resolveEditableSourcePath("C:\\pr-diff", file.path));
    if (files.has(path))
      throw failure("SOURCE_BINDING_MISMATCH", "PR diff paths must be unique on Windows.");
    files.set(path, file);
    for (const id of file.chunkIds) {
      if (!isEntityIdentifier(id) || referencedIds.has(id)) {
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "PR diff file chunk references must be unique entity identifiers.",
        );
      }
      referencedIds.add(id);
    }
  }
  const descriptors = new Map<string, InvestigationPrDiffChunkDescriptor>();
  const streams = new Map<string, Set<number>>();
  const kindsByPath = new Map<string, Set<InvestigationPrDiffChunkDescriptor["kind"]>>();
  for (const descriptor of manifest.chunks) {
    if (!isPrDiffDescriptor(descriptor) || descriptor.byteLength > 65_536) {
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "A PR diff chunk descriptor is invalid or exceeds the complete-chunk limit.",
      );
    }
    const path = pathKey(resolveEditableSourcePath("C:\\pr-diff", descriptor.path));
    const file = files.get(path);
    if (
      file === undefined ||
      descriptor.path !== file.path ||
      !file.chunkIds.includes(descriptor.id) ||
      descriptors.has(descriptor.id)
    ) {
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "A PR diff chunk is not registered exactly once under its file.",
      );
    }
    descriptors.set(descriptor.id, descriptor);
    const streamId = `${path}\0${descriptor.kind}`;
    const ordinals = streams.get(streamId) ?? new Set<number>();
    if (ordinals.has(descriptor.ordinal)) {
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "PR diff chunk ordinals must uniquely identify complete content order.",
      );
    }
    ordinals.add(descriptor.ordinal);
    streams.set(streamId, ordinals);
    const kinds = kindsByPath.get(path) ?? new Set<InvestigationPrDiffChunkDescriptor["kind"]>();
    kinds.add(descriptor.kind);
    kindsByPath.set(path, kinds);
  }
  if (referencedIds.size !== descriptors.size) {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The PR diff manifest contains missing or unreferenced content chunks.",
    );
  }
  for (const ordinals of streams.values()) {
    for (let ordinal = 0; ordinal < ordinals.size; ordinal += 1) {
      if (!ordinals.has(ordinal))
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "PR diff chunk order must be contiguous without missing content.",
        );
    }
  }
  for (const [path, file] of files) {
    const kinds = kindsByPath.get(path) ?? new Set<InvestigationPrDiffChunkDescriptor["kind"]>();
    const expectedKinds: readonly InvestigationPrDiffChunkDescriptor["kind"][] =
      file.status === "added"
        ? ["diff", "head"]
        : file.status === "deleted"
          ? ["diff", "base"]
          : ["diff", "base", "head"];
    if (kinds.size !== expectedKinds.length || expectedKinds.some((kind) => !kinds.has(kind))) {
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "The PR diff file is missing complete diff, base, or head content for its status.",
      );
    }
  }
  const { digest: expectedDigest, ...payload } = manifest;
  if (digest(Buffer.from(investigationCanonicalJson(payload), "utf8")) !== expectedDigest) {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The PR diff manifest does not match its canonical content digest.",
    );
  }
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > maximumBytes) {
    throw failure(
      "SOURCE_UNAVAILABLE",
      "The complete PR diff manifest exceeds its byte budget; no entries were truncated.",
    );
  }
}

function validatePrDiffChunk(
  chunk: InvestigationPrDiffChunk,
  expected: InvestigationPrDiffChunkDescriptor,
): void {
  if (
    !hasExactKeys(chunk, [
      "id",
      "path",
      "kind",
      "ordinal",
      "encoding",
      "contentDigest",
      "byteLength",
      "content",
    ]) ||
    typeof chunk.content !== "string"
  ) {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The PR diff chunk must contain exactly its registered descriptor and complete content.",
    );
  }
  const { content, ...descriptor } = chunk;
  if (investigationCanonicalJson(descriptor) !== investigationCanonicalJson(expected)) {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The PR diff chunk descriptor differs from the frozen manifest.",
    );
  }
  const bytes = Buffer.from(content, "utf8");
  if (
    bytes.byteLength !== expected.byteLength ||
    digest(bytes) !== expected.contentDigest ||
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== content ||
    (chunk.encoding === "base64" && Buffer.from(content, "base64").toString("base64") !== content)
  ) {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The PR diff chunk content does not match its frozen digest, size, or encoding.",
    );
  }
  if (Buffer.byteLength(JSON.stringify(chunk), "utf8") > 65_536) {
    throw failure(
      "SOURCE_UNAVAILABLE",
      "The complete PR diff chunk exceeds its serialized byte budget; no content was truncated.",
    );
  }
}

function isPrDiffDescriptor(value: InvestigationPrDiffChunkDescriptor): boolean {
  return (
    hasExactKeys(value, [
      "id",
      "path",
      "kind",
      "ordinal",
      "encoding",
      "contentDigest",
      "byteLength",
    ]) &&
    isEntityIdentifier(value.id) &&
    typeof value.path === "string" &&
    ["diff", "base", "head"].includes(value.kind) &&
    ["utf8", "base64"].includes(value.encoding) &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal >= 0 &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    /^[a-f0-9]{64}$/u.test(value.contentDigest)
  );
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isEntityIdentifier(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function validateArtifactInput(
  task: InvestigationTaskV1,
  input: InvestigationArtifactInput,
  maximumBytes: number,
  allowDerivedSubject = false,
): void {
  if (
    (!allowDerivedSubject && !task.subjects.some((subject) => subject.id === input.subjectRef)) ||
    input.name.length === 0 ||
    input.mediaType.length === 0 ||
    Array.from(input.name + input.mediaType).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw failure(
      "INVALID_INPUT",
      "Artifact metadata must identify a task subject and contain valid text.",
    );
  }
  if (input.bytes.byteLength > maximumBytes) {
    throw failure("ARTIFACT_LIMIT_EXCEEDED", "The artifact exceeds the configured byte limit.");
  }
}

function serializeSnapshot(snapshot: unknown, maximumBytes: number): Uint8Array {
  let text: string | undefined;
  try {
    text = JSON.stringify(snapshot, null, 2);
  } catch (error) {
    throw failure("INVALID_INPUT", "The model input snapshot must be JSON serializable.", error);
  }
  if (text === undefined) throw failure("INVALID_INPUT", "The model input snapshot is missing.");
  const bytes = Buffer.from(`${text}\n`, "utf8");
  if (bytes.byteLength > maximumBytes)
    throw failure("INVALID_INPUT", "The model input snapshot exceeds its byte limit.");
  return bytes;
}

function resolveRelativeSourcePath(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath)
  ) {
    throw failure(
      "WORKSPACE_PATH_UNSAFE",
      "Source paths must be relative paths within the source directory.",
    );
  }
  const segments = relativePath.split(/[\\/]/u);
  for (const segment of segments) assertSimpleName(segment);
  return childPath(root, ...segments);
}

function resolveEditableSourcePath(root: string, relativePath: string): string {
  if (
    typeof relativePath !== "string" ||
    relativePath.length > 4_096 ||
    relativePath.split(/[\\/]/u).some((component) => component.toLowerCase() === ".git")
  ) {
    throw failure(
      "WORKSPACE_PATH_UNSAFE",
      "Source edits and reads must use ordinary repository file paths outside Git control metadata.",
    );
  }
  return resolveRelativeSourcePath(root, relativePath);
}

function decodeSourceText(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("NUL bytes are not source text.");
    return text;
  } catch (error) {
    throw failure(
      "SOURCE_NOT_TEXT",
      "Source editing accepts complete UTF-8 text files without NUL bytes.",
      error,
    );
  }
}

function encodeSourceText(text: string): Uint8Array {
  if (typeof text !== "string")
    throw failure("SOURCE_NOT_TEXT", "Source edit content must be UTF-8 text.");
  const bytes = Buffer.from(text, "utf8");
  if (decodeSourceText(bytes) !== text) {
    throw failure("SOURCE_NOT_TEXT", "Source edit content must contain well-formed Unicode.");
  }
  return bytes;
}

function assertSourceByteLimit(byteLength: number, maximumBytes: number): void {
  if (byteLength > maximumBytes) {
    throw failure(
      "SOURCE_EDIT_LIMIT_EXCEEDED",
      "The source edit or read exceeds its configured byte limit.",
    );
  }
}

function assertSimpleName(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || /[\\/:]/u.test(name)) {
    throw failure(
      "WORKSPACE_PATH_UNSAFE",
      "Workspace path components must be ordinary file names.",
    );
  }
  assertPath(`C:\\workspace\\${name}`);
}

function assertPath(path: string): void {
  try {
    assertWindowsLocalAbsolutePath(path, "investigation workspace path", false);
  } catch (error) {
    throw failure("WORKSPACE_PATH_UNSAFE", "The investigation workspace path is unsafe.", error);
  }
}

function childPath(root: string, ...segments: string[]): string {
  for (const segment of segments) assertSimpleName(segment);
  const path = win32.join(root, ...segments);
  assertDescendant(root, path);
  return path;
}

function assertDescendant(root: string, path: string): void {
  const relative = win32.relative(root, path);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith("..\\") ||
    win32.isAbsolute(relative)
  ) {
    throw failure(
      "WORKSPACE_PATH_UNSAFE",
      "The workspace path must remain strictly inside its owner directory.",
    );
  }
}

function pathKey(path: string): string {
  return win32
    .normalize(path)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}
function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw failure("INVALID_INPUT", "Workspace limits must be positive safe integers.");
  return value;
}
function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function assertOpenFileIdentity(state: BigIntStats, expectedIdentity?: string): void {
  if (
    !state.isFile() ||
    state.nlink !== 1n ||
    (expectedIdentity !== undefined && `${state.dev}:${state.ino}` !== expectedIdentity)
  ) {
    throw failure(
      "SOURCE_EDIT_CONFLICT",
      "The opened source file is linked, replaced, or has an unsafe type.",
    );
  }
}
function findSourceCleanupUnconfirmed(error: unknown): Error | undefined {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) continue;
    visited.add(current);
    if (hasErrorCode(current, "SOURCE_PROCESS_CLEANUP_UNCONFIRMED")) return current;
    if (current instanceof AggregateError && Array.isArray(current.errors))
      pending.push(...current.errors);
    if (current.cause !== undefined) pending.push(current.cause);
  }
  return undefined;
}
function failure(
  code: InvestigationWorkspaceFailureCode,
  message: string,
  cause?: unknown,
): InvestigationWorkspaceError {
  return cause === undefined
    ? new InvestigationWorkspaceError(code, message)
    : new InvestigationWorkspaceError(code, message, { cause });
}
