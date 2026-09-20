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
import { OwnedHardlinkError, validateOwnedHardlinkGroups } from "./owned-hardlinks.js";

export interface InvestigationSourceBinding {
  readonly subjectRef: string;
  readonly revisionKey: string;
  readonly sourceSha: string;
  readonly patchDigest: string | null;
  readonly artifactRef: string | null;
  /** Exact Git symlink blobs represented as ordinary target text; their targets are never followed. */
  readonly inertSymlinks?: readonly {
    readonly path: string;
    readonly revisionSha: string;
  }[];
  /** Independently pinned dependency repositories mounted beneath this task's source root. */
  readonly submodules?: readonly {
    readonly path: string;
    readonly repository: string;
    readonly commitSha: string;
    readonly parentPath: string | null;
    readonly parentCommitSha: string;
  }[];
  /** Root-repository gitlink pointers; these records do not claim child-source coverage. */
  readonly gitlinks?: readonly {
    readonly path: string;
    readonly revisionSha: string;
    readonly commitSha: string;
  }[];
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

export const investigationSourceDependencyLimits = Object.freeze({
  maximumSeedPaths: 64,
  maximumFiles: 64,
  maximumSymbols: 128,
  maximumBytes: 256 * 1024,
  maximumIdentityScanBytes: 1024 * 1024,
  maximumDepth: 2,
});

export interface InvestigationSourceDependencies {
  readonly sourceSha: string;
  readonly seedPaths: readonly string[];
  /** Exact-head ordinary seeds whose file kinds have no supported lexical dependency search. */
  readonly unsupportedSeedPaths?: readonly string[];
  readonly symbols: readonly string[];
  readonly searchDepth: number;
  readonly identityScanBytes?: number;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
    readonly digest: string;
  }[];
  readonly queries: readonly {
    readonly revisionSha: string;
    readonly symbols: readonly string[];
    readonly paths: readonly string[];
    readonly depth: number;
    readonly anchorIdentities?: readonly { readonly name: string; readonly namespace: string }[];
    readonly excludedMatches?: readonly {
      readonly path: string;
      readonly reason: "namespace_or_import_only" | "different_type_identity";
      readonly matchedSymbols: readonly string[];
    }[];
    readonly provenReferencePaths?: readonly string[];
    readonly unpropagatedMatches?: readonly {
      readonly path: string;
      readonly reason: "unresolved_reference_identity";
    }[];
  }[];
}

export const investigationSourceContextLimits = Object.freeze({
  ...investigationSourceDependencyLimits,
  maximumCatalogPaths: 256,
  maximumQueries: 256,
  maximumOptionalFiles: 8,
  maximumForwardOptionalFiles: 4,
  maximumOwnerOptionalFiles: 4,
  maximumOptionalBytes: 128 * 1024,
});

export interface InvestigationSourceContext {
  readonly sourceSha: string;
  readonly seedPaths: readonly string[];
  readonly requiredFiles: readonly {
    readonly path: string;
    readonly content: string;
    readonly digest: string;
  }[];
  readonly contextFiles: readonly {
    readonly path: string;
    readonly content: string;
    readonly digest: string;
    readonly role: "definition_candidate" | "related_context";
    readonly relation: "unresolved_reference_identity";
    readonly lexicalDeclaration?: { readonly name: string; readonly namespace: string };
  }[];
  readonly queries: readonly {
    readonly kind: "definition" | "reference";
    readonly revisionSha: string;
    readonly symbols: readonly string[];
    readonly paths: readonly string[];
    readonly matchedPathCount: number;
    readonly omittedPathCount: number;
  }[];
  readonly deferred: readonly {
    readonly path: string;
    readonly reason:
      | "definition_identity_unresolved"
      | "namespace_or_import_only"
      | "different_type_identity"
      | "candidate_scan_files_budget"
      | "candidate_scan_bytes_budget"
      | "optional_context_budget"
      | "prompt_input_budget"
      | "optional_candidate_unselected";
  }[];
  readonly identityScanFiles: number;
  readonly identityScanBytes: number;
  readonly catalogComplete: boolean;
  readonly omittedCandidateCount: number;
  readonly queryBudgetExhausted?: true;
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
  readPrDiffChunks?(ids: readonly string[]): Promise<readonly InvestigationPrDiffChunk[]>;
  readSourceDependencies?(paths: readonly string[]): Promise<InvestigationSourceDependencies>;
  readSourceContext?(paths: readonly string[]): Promise<InvestigationSourceContext>;
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
    /**
     * Check ownership and immutable control metadata without scanning the source tree.
     * When provided, bind a source file observation to its original blob identity.
     * Adapters exposing this fast path must validate the complete tree before materialize
     * returns and on every assertBinding call.
     */
    assertReadBinding?(file?: InvestigationSourceFile): Promise<void>;
    /** Capture the actual worktree diff through a trusted managed process. */
    capturePatch?(signal: AbortSignal): Promise<Uint8Array>;
    readPrDiffManifest?(): Promise<InvestigationPrDiffManifest>;
    readPrDiffChunk?(id: string): Promise<InvestigationPrDiffChunk>;
    readPrDiffChunks?(ids: readonly string[]): Promise<readonly InvestigationPrDiffChunk[]>;
    readSourceDependencies?(paths: readonly string[]): Promise<InvestigationSourceDependencies>;
    readSourceContext?(paths: readonly string[]): Promise<InvestigationSourceContext>;
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
  /** Persist this private receipt before any source, model, or execution work is started. */
  readonly onOwnershipEstablished?: (
    receipt: InvestigationWorkspaceOwnershipReceipt,
  ) => Promise<void>;
  /** A trusted managed cleanup helper must confirm removal before this callback resolves. */
  readonly cleanupOwned?: (receipt: InvestigationWorkspaceOwnershipReceipt) => Promise<void>;
}

/** Private recovery evidence. Never include the nonce in logs, reports, or public artifacts. */
export interface InvestigationWorkspaceOwnershipReceipt {
  readonly schemaVersion: "InvestigationWorkspaceOwnershipReceiptV1";
  readonly workspaceRootDirectory: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly leaseVersion: number;
  readonly nonce: string;
  readonly rootIdentity: string;
  readonly attemptIdentity: string;
  readonly ownerIdentity: string;
  readonly ownerDigest: string;
}

export interface CleanupOwnedInvestigationAttemptOptions {
  readonly workspaceRootDirectory: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly leaseVersion: number;
  readonly ownership: InvestigationWorkspaceOwnershipReceipt;
  /** A trusted process owner must establish this; a missing PID is not sufficient evidence. */
  readonly processesStopped: true;
  readonly fileSystem?: InvestigationWorkspaceFileSystem;
  readonly maximumTreeEntries?: number;
}

export interface AssertInvestigationAttemptWorkspaceAbsentOptions {
  readonly workspaceRootDirectory: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly leaseVersion: number;
  readonly fileSystem?: InvestigationWorkspaceFileSystem;
}

export type InvestigationWorkspaceFailureCode =
  | "INVALID_INPUT"
  | "WORKSPACE_PATH_UNSAFE"
  | "WORKSPACE_ALREADY_EXISTS"
  | "WORKSPACE_NOT_OWNED"
  | "WORKSPACE_RECOVERY_OWNERSHIP_MISSING"
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
  readonly #onOwnershipEstablished: ProductionInvestigationWorkspaceProviderOptions["onOwnershipEstablished"];
  readonly #cleanupOwned: ProductionInvestigationWorkspaceProviderOptions["cleanupOwned"];

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
    this.#onOwnershipEstablished = options.onOwnershipEstablished;
    this.#cleanupOwned = options.cleanupOwned;
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
    const layout = ownedWorkspaceLayout(
      this.#root,
      input.task.id,
      input.attempt.id,
      input.attempt.leaseVersion,
    );
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
    const ownerNonce = randomUUID();
    const ownerBytes = Buffer.from(
      JSON.stringify({
        taskId: input.task.id,
        attemptId: input.attempt.id,
        leaseVersion: input.attempt.leaseVersion,
        nonce: ownerNonce,
      }),
      "utf8",
    );
    let ownerWritten = false;
    let ownership: InvestigationWorkspaceOwnershipReceipt | undefined;
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
    const frozenPrDiffChunks = new Map<string, InvestigationPrDiffChunk>();
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
        if (this.#cleanupOwned === undefined) {
          await guard.removeOwnedTree(assertOwned);
        } else {
          if (ownership === undefined)
            throw failure(
              "WORKSPACE_RECOVERY_OWNERSHIP_MISSING",
              "Managed cleanup requires the established workspace ownership receipt.",
            );
          await this.#cleanupOwned(structuredClone(ownership));
        }
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
      ownership = {
        schemaVersion: "InvestigationWorkspaceOwnershipReceiptV1",
        workspaceRootDirectory: this.#root,
        taskId: input.task.id,
        attemptId: input.attempt.id,
        leaseVersion: input.attempt.leaseVersion,
        nonce: ownerNonce,
        rootIdentity: identities.get(pathKey(layout.root))!,
        attemptIdentity: identities.get(pathKey(layout.attempt))!,
        ownerIdentity: identities.get(pathKey(layout.owner))!,
        ownerDigest: digest(ownerBytes),
      };
      await this.#fs.setReadOnly(layout.owner, true);
      await this.#onOwnershipEstablished?.(structuredClone(ownership));
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
        validateBinding(input.task, materializedSource.binding);
        binding = freezeSourceBinding(materializedSource.binding);
        if (snapshot.source !== null && binding.artifactRef !== snapshot.source.artifactRef) {
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The materialized source is bound to a different input artifact.",
          );
        }
        if (materializedSource.assertReadBinding === undefined) {
          await guard.assertTree(layout.source);
          await materializedSource.assertBinding();
        } else await materializedSource.assertReadBinding();
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
        if (materializedSource.assertReadBinding === undefined)
          await guard.assertTree(layout.source);
        await materializedSource.assertBinding();
        await assertIntegrity();
      };
      const assertSourceReadBinding = async (file?: InvestigationSourceFile) => {
        if (materializedSource?.assertReadBinding === undefined) {
          await assertSourceBinding();
          return;
        }
        await assertIntegrity();
        if (binding === null)
          throw failure("SOURCE_UNAVAILABLE", "This workspace has no verified repository source.");
        validateBinding(input.task, binding);
        await guard.assertPath(layout.source, "directory");
        await materializedSource.assertReadBinding(file);
        await assertIntegrity();
      };
      const readAndValidatePrDiffManifest = async (): Promise<InvestigationPrDiffManifest> => {
        if (
          materializedSource?.readPrDiffManifest === undefined ||
          (materializedSource.readPrDiffChunk === undefined &&
            materializedSource.readPrDiffChunks === undefined) ||
          binding === null
        ) {
          throw failure(
            "SOURCE_UNAVAILABLE",
            "The trusted source materializer cannot provide the complete PR diff manifest and chunks.",
          );
        }
        if (materializedSource.assertReadBinding !== undefined && frozenPrDiffManifest !== null)
          return frozenPrDiffManifest;
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
        return manifest;
      };
      const freezePrDiffManifest = (manifest: InvestigationPrDiffManifest): void => {
        if (frozenPrDiffManifest !== null && manifest.digest !== frozenPrDiffManifest.digest)
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The PR diff manifest changed while its source batch was being validated.",
          );
        frozenPrDiffManifest ??= manifest;
      };
      const readPrDiffManifest = async (): Promise<InvestigationPrDiffManifest> => {
        await assertSourceReadBinding();
        const manifest = await readAndValidatePrDiffManifest();
        await assertSourceReadBinding();
        freezePrDiffManifest(manifest);
        return structuredClone(manifest);
      };
      const readPrDiffChunks = async (
        ids: readonly string[],
      ): Promise<readonly InvestigationPrDiffChunk[]> => {
        if (
          !Array.isArray(ids) ||
          ids.length > this.#maximumTreeEntries ||
          ids.some((id) => typeof id !== "string") ||
          new Set(ids).size !== ids.length
        ) {
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "A PR source batch must contain bounded, unique chunk IDs.",
          );
        }
        const requestedIds = [...ids];
        await assertSourceReadBinding();
        const manifest = await readAndValidatePrDiffManifest();
        const descriptors = new Map(manifest.chunks.map((chunk) => [chunk.id, chunk]));
        const expected = requestedIds.map((id) => {
          const descriptor = descriptors.get(id);
          if (descriptor === undefined)
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "The requested PR diff chunk does not belong to the frozen manifest.",
            );
          return descriptor;
        });
        const cacheEnabled = materializedSource?.assertReadBinding !== undefined;
        const missing = cacheEnabled
          ? expected.filter((descriptor) => !frozenPrDiffChunks.has(descriptor.id))
          : expected;
        const missingIds = missing.map((descriptor) => descriptor.id);
        let chunks: readonly InvestigationPrDiffChunk[];
        if (missing.length === 0) {
          chunks = [];
        } else if (materializedSource?.readPrDiffChunks !== undefined) {
          chunks = structuredClone(await materializedSource.readPrDiffChunks(missingIds));
        } else if (materializedSource?.readPrDiffChunk !== undefined) {
          const collected: InvestigationPrDiffChunk[] = [];
          for (const id of missingIds)
            collected.push(structuredClone(await materializedSource.readPrDiffChunk(id)));
          chunks = collected;
        } else {
          throw failure(
            "SOURCE_UNAVAILABLE",
            "The trusted source materializer cannot read complete PR diff chunks.",
          );
        }
        if (!Array.isArray(chunks) || chunks.length !== missing.length)
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The PR source batch does not contain every requested chunk exactly once.",
          );
        for (let index = 0; index < missing.length; index++)
          validatePrDiffChunk(chunks[index]!, missing[index]!);
        await assertSourceReadBinding();
        freezePrDiffManifest(manifest);
        if (!cacheEnabled) return chunks;
        for (const chunk of chunks) frozenPrDiffChunks.set(chunk.id, chunk);
        return expected.map((descriptor) =>
          structuredClone(frozenPrDiffChunks.get(descriptor.id)!),
        );
      };
      const readPrDiffChunk = async (id: string): Promise<InvestigationPrDiffChunk> => {
        const chunks = await readPrDiffChunks([id]);
        return chunks[0]!;
      };
      const readSourceContext = async (
        paths: readonly string[],
      ): Promise<InvestigationSourceContext> => {
        if (
          input.task.executionPolicy.mode !== "source_read" ||
          materializedSource?.readSourceContext === undefined ||
          binding === null ||
          binding.patchDigest !== null
        )
          throw failure(
            "SOURCE_UNAVAILABLE",
            "This workspace cannot prepare focused immutable source context.",
          );
        if (
          !Array.isArray(paths) ||
          paths.length === 0 ||
          paths.length > investigationSourceContextLimits.maximumSeedPaths
        )
          throw failure(
            "SOURCE_UNAVAILABLE",
            "Focused context requires a bounded set of explicit source paths.",
          );
        const requested = paths
          .map((path) => {
            const absolute = resolveEditableSourcePath(layout.source, path);
            if (win32.relative(layout.source, absolute).replaceAll("\\", "/") !== path)
              throw failure(
                "WORKSPACE_PATH_UNSAFE",
                "Focused source paths must be exact repository paths.",
              );
            return path;
          })
          .toSorted();
        if (new Set(requested.map((path) => path.toLowerCase())).size !== requested.length)
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "Focused source paths must be unique on Windows.",
          );
        await assertSourceBinding();
        const result: unknown = structuredClone(
          await materializedSource.readSourceContext(requested),
        );
        assertInvestigationSourceContext(result, binding.sourceSha, requested);
        await assertSourceBinding();
        return result;
      };
      const readSourceDependencies = async (
        paths: readonly string[],
      ): Promise<InvestigationSourceDependencies> => {
        if (
          input.task.executionPolicy.mode !== "source_read" ||
          materializedSource?.readSourceDependencies === undefined ||
          binding === null
        )
          throw failure(
            "SOURCE_UNAVAILABLE",
            "This workspace cannot discover frozen source dependencies.",
          );
        const canonicalPaths = (values: readonly string[], maximum: number): string[] => {
          if (!Array.isArray(values) || values.length > maximum)
            throw failure(
              "SOURCE_UNAVAILABLE",
              "The complete dependency path set exceeds its limit.",
            );
          const result = values.map((path) => {
            const absolute = resolveEditableSourcePath(layout.source, path);
            const canonical = win32.relative(layout.source, absolute).replaceAll("\\", "/");
            if (path !== canonical)
              throw failure(
                "WORKSPACE_PATH_UNSAFE",
                "Dependency paths must be exact repository paths.",
              );
            return canonical;
          });
          if (new Set(result.map((path) => path.toLowerCase())).size !== result.length)
            throw failure("SOURCE_BINDING_MISMATCH", "Dependency paths must be unique on Windows.");
          return result.toSorted();
        };
        if (!Array.isArray(paths))
          throw failure("SOURCE_UNAVAILABLE", "Dependency seeds must be a concrete path array.");
        const requested = canonicalPaths(
          [...paths],
          investigationSourceDependencyLimits.maximumSeedPaths,
        );
        if (requested.length === 0)
          throw failure(
            "SOURCE_UNAVAILABLE",
            "Dependency discovery requires explicit source seed paths.",
          );
        await assertSourceBinding();
        const result = structuredClone(await materializedSource.readSourceDependencies(requested));
        const { unsupportedSeedPaths, ...discovery } = result;
        if (
          (!hasExactKeys(discovery, [
            "sourceSha",
            "seedPaths",
            "symbols",
            "searchDepth",
            "files",
            "queries",
          ]) &&
            !hasExactKeys(discovery, [
              "sourceSha",
              "seedPaths",
              "symbols",
              "searchDepth",
              "files",
              "queries",
              "identityScanBytes",
            ])) ||
          result.sourceSha !== binding.sourceSha ||
          JSON.stringify(
            canonicalPaths(result.seedPaths, investigationSourceDependencyLimits.maximumSeedPaths),
          ) !== JSON.stringify(requested) ||
          !Number.isSafeInteger(result.searchDepth) ||
          result.searchDepth < 0 ||
          result.searchDepth > investigationSourceDependencyLimits.maximumDepth ||
          (result.identityScanBytes !== undefined &&
            (!Number.isSafeInteger(result.identityScanBytes) ||
              result.identityScanBytes < 0 ||
              result.identityScanBytes >
                investigationSourceDependencyLimits.maximumIdentityScanBytes)) ||
          !Array.isArray(result.symbols) ||
          result.symbols.length > investigationSourceDependencyLimits.maximumSymbols ||
          new Set(result.symbols).size !== result.symbols.length ||
          result.symbols.some(
            (symbol) =>
              typeof symbol !== "string" ||
              symbol.length > 128 ||
              !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/u.test(symbol),
          ) ||
          !Array.isArray(result.files) ||
          !Array.isArray(result.queries) ||
          result.queries.length !== result.searchDepth
        )
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The source dependency result does not match its frozen request.",
          );
        if (
          unsupportedSeedPaths !== undefined &&
          (!Array.isArray(unsupportedSeedPaths) ||
            unsupportedSeedPaths.length === 0 ||
            JSON.stringify(
              canonicalPaths(
                unsupportedSeedPaths,
                investigationSourceDependencyLimits.maximumSeedPaths,
              ),
            ) !== JSON.stringify(unsupportedSeedPaths) ||
            unsupportedSeedPaths.some((path) => !requested.includes(path)))
        )
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "Unsupported dependency seeds must be a unique exact subset of the frozen request.",
          );
        if (
          unsupportedSeedPaths?.length === requested.length &&
          (result.symbols.length > 0 ||
            result.searchDepth !== 0 ||
            result.files.length > 0 ||
            (result.identityScanBytes ?? 0) !== 0)
        )
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "An entirely unsupported seed set cannot claim lexical search or dependency results.",
          );
        const dependencyPaths = canonicalPaths(
          result.files.map((file) => file.path),
          investigationSourceDependencyLimits.maximumFiles,
        );
        let bytes = 0;
        for (const file of result.files) {
          if (
            requested.includes(file.path) ||
            typeof file.content !== "string" ||
            file.content.includes("\0") ||
            !/^[a-f0-9]{64}$/u.test(file.digest) ||
            digest(Buffer.from(file.content, "utf8")) !== file.digest
          )
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "A complete source dependency has changed or has invalid text.",
            );
          bytes += Buffer.byteLength(file.content, "utf8");
          if (bytes > investigationSourceDependencyLimits.maximumBytes)
            throw failure(
              "SOURCE_UNAVAILABLE",
              "The complete dependency content exceeds its byte limit.",
            );
        }
        const matchedPaths = new Set<string>();
        const queriedSymbols = new Set<string>();
        for (const [index, query] of result.queries.entries()) {
          if (
            query.revisionSha !== result.sourceSha ||
            query.depth !== index + 1 ||
            !Array.isArray(query.symbols) ||
            query.symbols.length === 0 ||
            new Set(query.symbols).size !== query.symbols.length ||
            query.symbols.some(
              (symbol: unknown) => typeof symbol !== "string" || !result.symbols.includes(symbol),
            )
          )
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "A dependency query is bound to a different source or symbol set.",
            );
          if (query.anchorIdentities !== undefined) {
            if (
              !Array.isArray(query.anchorIdentities) ||
              query.anchorIdentities.length > investigationSourceDependencyLimits.maximumSymbols ||
              query.anchorIdentities.some((identity: unknown) => {
                if (!hasExactKeys(identity, ["name", "namespace"])) return true;
                const entry = identity as { name: unknown; namespace: unknown };
                return (
                  typeof entry.name !== "string" ||
                  !query.symbols.includes(entry.name) ||
                  typeof entry.namespace !== "string" ||
                  entry.namespace.length > 2048 ||
                  !/^[A-Za-z0-9_:.$]*$/u.test(entry.namespace)
                );
              })
            )
              throw failure(
                "SOURCE_BINDING_MISMATCH",
                "Dependency anchor identities do not match the queried symbols.",
              );
          }
          const excluded = query.excludedMatches ?? [];
          if (
            !Array.isArray(excluded) ||
            excluded.length > investigationSourceDependencyLimits.maximumFiles ||
            excluded.some((entry: unknown) => {
              if (!hasExactKeys(entry, ["path", "reason", "matchedSymbols"])) return true;
              const exclusion = entry as {
                path: unknown;
                reason: unknown;
                matchedSymbols: unknown;
              };
              return (
                typeof exclusion.path !== "string" ||
                typeof exclusion.reason !== "string" ||
                !["namespace_or_import_only", "different_type_identity"].includes(
                  exclusion.reason,
                ) ||
                !Array.isArray(exclusion.matchedSymbols) ||
                exclusion.matchedSymbols.length === 0 ||
                exclusion.matchedSymbols.some(
                  (symbol: unknown) =>
                    typeof symbol !== "string" || !query.symbols.includes(symbol),
                )
              );
            })
          )
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "A dependency exclusion lacks bounded symbol and identity evidence.",
            );
          const excludedPaths = new Set(
            canonicalPaths(
              excluded.map((entry: { path: string }) => entry.path),
              investigationSourceDependencyLimits.maximumFiles,
            ),
          );
          if (
            excludedPaths.size > 0 &&
            (query.anchorIdentities === undefined || result.identityScanBytes === undefined)
          )
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "Filtered matches require explicit identities and scan accounting.",
            );
          for (const symbol of query.symbols) queriedSymbols.add(symbol);
          const queryPaths = canonicalPaths(
            query.paths,
            investigationSourceDependencyLimits.maximumFiles +
              investigationSourceDependencyLimits.maximumSeedPaths,
          );
          if (queryPaths.some((path) => unsupportedSeedPaths?.includes(path)))
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "An unsupported dependency seed cannot also be reported as lexically searched.",
            );
          if ([...excludedPaths].some((path) => !queryPaths.includes(path)))
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "A dependency exclusion is absent from the original exact-revision matches.",
            );
          const hasPropagation =
            query.provenReferencePaths !== undefined || query.unpropagatedMatches !== undefined;
          const proven = new Set(
            canonicalPaths(
              query.provenReferencePaths ?? [],
              investigationSourceDependencyLimits.maximumFiles,
            ),
          );
          const unresolved = query.unpropagatedMatches ?? [];
          if (
            !Array.isArray(unresolved) ||
            unresolved.length > investigationSourceDependencyLimits.maximumFiles ||
            unresolved.some(
              (entry: unknown) =>
                !hasExactKeys(entry, ["path", "reason"]) ||
                (entry as { reason: unknown }).reason !== "unresolved_reference_identity",
            )
          )
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "Unpropagated dependency metadata is invalid.",
            );
          const unpropagated = new Set(
            canonicalPaths(
              unresolved.map((entry: { path: string }) => entry.path),
              investigationSourceDependencyLimits.maximumFiles,
            ),
          );
          if (
            [...proven, ...unpropagated].some(
              (path) => !queryPaths.includes(path) || excludedPaths.has(path),
            ) ||
            [...unpropagated].some(
              (path) =>
                proven.has(path) || requested.includes(path) || !dependencyPaths.includes(path),
            )
          )
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "Dependency propagation metadata differs from the retained query matches.",
            );
          for (const path of queryPaths) {
            if (excludedPaths.has(path)) continue;
            if (!requested.includes(path) && !dependencyPaths.includes(path))
              throw failure(
                "SOURCE_BINDING_MISMATCH",
                "A matched dependency file was omitted from the complete result.",
              );
            if (
              hasPropagation &&
              !requested.includes(path) &&
              !matchedPaths.has(path) &&
              !proven.has(path) &&
              !unpropagated.has(path)
            )
              throw failure(
                "SOURCE_BINDING_MISMATCH",
                "A retained dependency lacks explicit propagation or unresolved identity evidence.",
              );
            matchedPaths.add(path);
          }
        }
        if (
          (result.identityScanBytes !== undefined && result.identityScanBytes < bytes) ||
          dependencyPaths.some((path) => !matchedPaths.has(path)) ||
          result.symbols.some((symbol) => !queriedSymbols.has(symbol))
        )
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "Dependency files or symbols lack exact-revision query evidence.",
          );
        await assertSourceBinding();
        return result;
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
          assertEditableDependencyPath(binding!, relativePath);
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
          assertEditableDependencyPath(binding!, edit.path);
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
          await assertSourceReadBinding();
          const path = resolveRelativeSourcePath(layout.source, relativePath);
          await guard.assertPath(path);
          return path;
        },
        readSourceFile: async (relativePath) => {
          await assertSourceReadBinding();
          const absolutePath = resolveEditableSourcePath(layout.source, relativePath);
          const path = win32.relative(layout.source, absolutePath).replaceAll("\\", "/");
          const submodule = binding?.submodules?.find((entry) => entry.path === path);
          if (submodule !== undefined) {
            const before = await guard.assertPath(absolutePath, "directory");
            const content = `Subproject commit ${submodule.commitSha}\n`;
            const observed = { path, content, digest: digest(Buffer.from(content, "utf8")) };
            await assertSourceReadBinding(observed);
            if ((await guard.assertPath(absolutePath, "directory")).identity !== before.identity)
              throw failure(
                "SOURCE_BINDING_MISMATCH",
                "The pinned dependency directory changed while its Git pointer was being inspected.",
              );
            return observed;
          }
          const observed = await inspectSourceFile(relativePath);
          await assertSourceReadBinding(observed);
          return { path: observed.path, content: observed.content, digest: observed.digest };
        },
        readPrDiffManifest,
        readPrDiffChunk,
        readPrDiffChunks,
        ...(materializedSource?.readSourceDependencies === undefined
          ? {}
          : { readSourceDependencies }),
        ...(materializedSource?.readSourceContext === undefined ? {} : { readSourceContext }),
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
          if (this.#cleanupOwned !== undefined)
            throw failure(
              "WORKSPACE_RECOVERY_OWNERSHIP_MISSING",
              "An unrecorded attempt directory must be retained for trusted recovery.",
            );
          await guard.assertPath(layout.attempt, "directory");
          await this.#fs.removeEmptyDirectory(layout.attempt);
        }
      } catch (cleanupError) {
        throw Object.assign(
          new AggregateError(
            [error, cleanupError],
            "Workspace preparation and owned cleanup failed.",
          ),
          { code: "WORKSPACE_CLEANUP_UNCONFIRMED" },
        );
      }
      throw error;
    }
  }
}

/** Removes only the exact workspace identities recorded by its original trusted owner. */
export async function cleanupOwnedInvestigationAttempt(
  options: CleanupOwnedInvestigationAttemptOptions,
): Promise<{ readonly state: "removed" | "already-absent" }> {
  const ownership = options.ownership;
  if (
    options.processesStopped !== true ||
    !hasExactKeys(ownership, [
      "schemaVersion",
      "workspaceRootDirectory",
      "taskId",
      "attemptId",
      "leaseVersion",
      "nonce",
      "rootIdentity",
      "attemptIdentity",
      "ownerIdentity",
      "ownerDigest",
    ]) ||
    ownership.schemaVersion !== "InvestigationWorkspaceOwnershipReceiptV1" ||
    !isOwnershipText(options.taskId) ||
    !isOwnershipText(options.attemptId) ||
    ownership.taskId !== options.taskId ||
    ownership.attemptId !== options.attemptId ||
    !Number.isSafeInteger(options.leaseVersion) ||
    options.leaseVersion < 0 ||
    ownership.leaseVersion !== options.leaseVersion ||
    typeof ownership.workspaceRootDirectory !== "string" ||
    !samePath(ownership.workspaceRootDirectory, options.workspaceRootDirectory) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      ownership.nonce,
    ) ||
    !isOwnershipText(ownership.rootIdentity) ||
    !isOwnershipText(ownership.attemptIdentity) ||
    !isOwnershipText(ownership.ownerIdentity) ||
    !/^[a-f0-9]{64}$/u.test(ownership.ownerDigest)
  )
    throw failure(
      "WORKSPACE_NOT_OWNED",
      "Workspace recovery requires matching private ownership and confirmed process cleanup.",
    );
  assertPath(options.workspaceRootDirectory);
  const root = win32.normalize(options.workspaceRootDirectory);
  if (samePath(root, win32.parse(root).root))
    throw failure("WORKSPACE_PATH_UNSAFE", "A drive root cannot be a recovery workspace root.");
  const expectedOwnerBytes = Buffer.from(
    JSON.stringify({
      taskId: options.taskId,
      attemptId: options.attemptId,
      leaseVersion: options.leaseVersion,
      nonce: ownership.nonce,
    }),
    "utf8",
  );
  if (digest(expectedOwnerBytes) !== ownership.ownerDigest)
    throw failure("WORKSPACE_NOT_OWNED", "The recovery ownership receipt is inconsistent.");
  const fs = options.fileSystem ?? new ProductionInvestigationWorkspaceFileSystem();
  const layout = ownedWorkspaceLayout(
    root,
    options.taskId,
    options.attemptId,
    options.leaseVersion,
  );
  const identities = new Map([
    [pathKey(layout.root), ownership.rootIdentity],
    [pathKey(layout.attempt), ownership.attemptIdentity],
    [pathKey(layout.owner), ownership.ownerIdentity],
  ]);
  const guard = new WorkspaceGuard(
    fs,
    layout,
    identities,
    positiveLimit(options.maximumTreeEntries ?? 100_000),
  );
  await assertRecoveryRoot(fs, root, ownership.rootIdentity);
  if ((await fs.lstat(layout.attempt)) === null) {
    await assertRecoveryRoot(fs, root, ownership.rootIdentity);
    return { state: "already-absent" };
  }
  await guard.assertPath(layout.attempt, "directory");
  if ((await fs.lstat(layout.owner)) === null) {
    // A crash can occur after deleting the last owner marker and before removing its empty parent.
    // The journal's retained directory identity permits only this exact, already-empty directory.
    if ((await fs.readDirectory(layout.attempt)).length !== 0)
      throw failure("WORKSPACE_NOT_OWNED", "A non-empty recovery workspace has no owner marker.");
    await assertRecoveryRoot(fs, root, ownership.rootIdentity);
    await guard.assertPath(layout.attempt, "directory");
    await fs.removeEmptyDirectory(layout.attempt);
    return { state: "removed" };
  }
  const assertOwned = async (): Promise<void> => {
    await assertRecoveryRoot(fs, root, ownership.rootIdentity);
    await guard.assertPath(layout.attempt, "directory");
    await guard.assertPath(layout.owner, "file");
    const bytes = await fs.readFile(layout.owner, ownership.ownerIdentity, 4_096);
    if (!equalBytes(bytes, expectedOwnerBytes))
      throw failure("WORKSPACE_NOT_OWNED", "The recovery workspace ownership marker changed.");
  };
  await assertOwned();
  await guard.removeOwnedTree(assertOwned);
  return { state: "removed" };
}

/** Absence is the only automatic recovery result available without a durable ownership receipt. */
export async function assertInvestigationAttemptWorkspaceAbsent(
  options: AssertInvestigationAttemptWorkspaceAbsentOptions,
): Promise<void> {
  if (
    !isOwnershipText(options.taskId) ||
    !isOwnershipText(options.attemptId) ||
    !Number.isSafeInteger(options.leaseVersion) ||
    options.leaseVersion < 0
  )
    throw failure(
      "INVALID_INPUT",
      "Workspace absence checks require an exact task and lease identity.",
    );
  assertPath(options.workspaceRootDirectory);
  const root = win32.normalize(options.workspaceRootDirectory);
  if (samePath(root, win32.parse(root).root))
    throw failure("WORKSPACE_PATH_UNSAFE", "A drive root cannot be a recovery workspace root.");
  const fs = options.fileSystem ?? new ProductionInvestigationWorkspaceFileSystem();
  const layout = ownedWorkspaceLayout(
    root,
    options.taskId,
    options.attemptId,
    options.leaseVersion,
  );
  await assertRecoveryRoot(fs, root);
  if ((await fs.lstat(layout.attempt)) !== null)
    throw failure(
      "WORKSPACE_RECOVERY_OWNERSHIP_MISSING",
      "The attempt workspace exists without its durable ownership receipt and cannot be automatically removed.",
    );
  await assertRecoveryRoot(fs, root);
}

function ownedWorkspaceLayout(
  root: string,
  taskId: string,
  attemptId: string,
  leaseVersion: number,
): OwnedLayout {
  const attemptName = `task-${digest(Buffer.from(taskId)).slice(0, 24)}-attempt-${digest(Buffer.from(attemptId)).slice(0, 24)}-lease-${leaseVersion}`;
  const attempt = childPath(root, attemptName);
  return {
    root,
    attempt,
    owner: childPath(attempt, ".owner.json"),
    modelInput: childPath(attempt, "model-input"),
    snapshot: childPath(attempt, "model-input", "snapshot.json"),
    control: childPath(attempt, "control"),
    temp: childPath(attempt, "temp"),
    artifacts: childPath(attempt, "artifacts"),
    source: childPath(attempt, "source"),
  };
}

async function assertRecoveryRoot(
  fs: InvestigationWorkspaceFileSystem,
  root: string,
  expectedIdentity?: string,
): Promise<void> {
  let current = root;
  for (;;) {
    const state = await fs.lstat(current);
    if (
      state === null ||
      state.kind !== "directory" ||
      state.reparsePoint ||
      !samePath(await fs.realpath(current), current)
    )
      throw failure(
        "WORKSPACE_PATH_UNSAFE",
        "A recovery workspace ancestor is missing or redirected.",
      );
    if (
      expectedIdentity !== undefined &&
      samePath(current, root) &&
      state.identity !== expectedIdentity
    )
      throw failure("WORKSPACE_NOT_OWNED", "The recovery workspace root was replaced.");
    const parent = win32.dirname(current);
    if (samePath(parent, current)) return;
    current = parent;
  }
}

function isOwnershipText(value: unknown): value is string {
  return typeof value === "string" && /^[^\0\r\n]{1,512}$/u.test(value) && value === value.trim();
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
    allowTerminalHardlinks = false,
    cleanupIdentities?: ReadonlyMap<string, string>,
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
        (state.kind === "file" && state.linkCount !== 1 && !allowTerminalHardlinks)
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
      const cleanupIdentity = cleanupIdentities?.get(pathKey(current));
      if (cleanupIdentity !== undefined && state.identity !== cleanupIdentity)
        throw failure("WORKSPACE_NOT_OWNED", "A workspace parent or entry changed during cleanup.");
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
    allowTerminalHardlinks = false,
  ): Promise<Array<{ path: string; state: InvestigationWorkspacePathState }>> {
    const entries: Array<{ path: string; state: InvestigationWorkspacePathState }> = [];
    const pending = [directory];
    while (pending.length > 0) {
      const path = pending.pop();
      if (path === undefined) break;
      const state = await this.assertPath(path, undefined, allowTerminalHardlinks);
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
    const entries = await this.scanTree(this.layout.attempt, true);
    let groups: ReadonlyMap<string, readonly string[]>;
    try {
      groups = validateOwnedHardlinkGroups(entries, (path) => {
        const relative = win32.relative(this.layout.attempt, path).split("\\");
        return (
          (relative[0] === "source" || relative[0] === "temp") &&
          !relative.some((part) => part.toLowerCase() === ".git") &&
          !this.identities.has(pathKey(path))
        );
      });
    } catch (error) {
      if (error instanceof OwnedHardlinkError)
        throw failure("WORKSPACE_PATH_UNSAFE", error.message);
      throw error;
    }
    const remainingGroups = new Map(
      [...groups].map(([identity, paths]) => [identity, new Set(paths)]),
    );
    const cleanupIdentities = new Map(
      entries.map((entry) => [pathKey(entry.path), entry.state.identity]),
    );
    const ownerEntry = entries.find((entry) => samePath(entry.path, this.layout.owner));
    if (ownerEntry === undefined)
      throw failure("WORKSPACE_NOT_OWNED", "The workspace ownership marker is missing.");
    // The caller must stop all managed processes before cleanup. Only checked, individual entries are removed.
    for (const entry of entries.reverse()) {
      if (samePath(entry.path, this.layout.owner) || samePath(entry.path, this.layout.attempt))
        continue;
      await assertOwned();
      const remaining = remainingGroups.get(entry.state.identity);
      if (remaining !== undefined) {
        for (const path of remaining) {
          const member = await this.assertPath(path, "file", true, cleanupIdentities);
          if (member.identity !== entry.state.identity || member.linkCount !== remaining.size)
            throw failure(
              "WORKSPACE_PATH_UNSAFE",
              "A generated hardlink group changed before unlinking an owned entry.",
            );
        }
      }
      const state = await this.assertPath(
        entry.path,
        entry.state.kind,
        remaining !== undefined,
        cleanupIdentities,
      );
      if (state.identity !== entry.state.identity) {
        throw failure("WORKSPACE_NOT_OWNED", "A workspace entry changed during cleanup.");
      }
      if (state.kind === "directory") await this.fs.removeEmptyDirectory(entry.path);
      else {
        // Never change a shared inode's attributes. Removing its checked owned name is sufficient.
        if (remaining === undefined) await this.fs.setReadOnly(entry.path, false);
        await this.fs.removeFile(entry.path);
        remaining?.delete(entry.path);
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

function freezeSourceBinding(binding: InvestigationSourceBinding): InvestigationSourceBinding {
  const frozen = structuredClone(binding);
  for (const values of [frozen.inertSymlinks, frozen.submodules, frozen.gitlinks]) {
    if (values === undefined) continue;
    for (const value of values) Object.freeze(value);
    Object.freeze(values);
  }
  return Object.freeze(frozen);
}

function assertEditableDependencyPath(binding: InvestigationSourceBinding, path: string): void {
  if ((binding.submodules?.length ?? 0) === 0) return;
  const canonical = path.replaceAll("\\", "/").toLowerCase();
  if (
    canonical.split("/").some((component) => component === ".gitmodules") ||
    binding.submodules!.some((entry) => {
      const mount = entry.path.toLowerCase();
      return canonical === mount || canonical.startsWith(`${mount}/`);
    })
  )
    throw failure(
      "SOURCE_EDIT_NOT_AUTHORIZED",
      "Pinned dependency repositories and their Git module definitions cannot be changed by a parent-repository patch.",
    );
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
  const invalid: () => never = () => {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "Pinned dependency provenance must preserve unique canonical paths and its exact parent commit chain.",
    );
  };
  const canonicalPath = (value: unknown): value is string => {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return false;
    try {
      const root = "C:\\source-binding";
      const resolved = resolveEditableSourcePath(root, value);
      return win32.relative(root, resolved).replaceAll("\\", "/") === value;
    } catch {
      return false;
    }
  };
  const commit = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
  if (binding.submodules !== undefined) {
    if (!Array.isArray(binding.submodules) || binding.submodules.length > 128) invalid();
    const modules = new Map<
      string,
      NonNullable<InvestigationSourceBinding["submodules"]>[number]
    >();
    const pathPrefixes = new Map<string, string>();
    for (const entry of binding.submodules) {
      if (
        !hasExactKeys(entry, [
          "path",
          "repository",
          "commitSha",
          "parentPath",
          "parentCommitSha",
        ]) ||
        !canonicalPath(entry.path) ||
        typeof entry.repository !== "string" ||
        entry.repository.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.repository) ||
        entry.repository
          .split("/")
          .some((part: string) => part.endsWith(".") || part.toLowerCase().endsWith(".git")) ||
        !commit(entry.commitSha) ||
        !commit(entry.parentCommitSha) ||
        (entry.parentPath !== null && !canonicalPath(entry.parentPath)) ||
        modules.has(entry.path.toLowerCase())
      )
        invalid();
      const components = entry.path.split("/");
      for (let length = 1; length <= components.length; length++) {
        const prefix = components.slice(0, length).join("/");
        const prior = pathPrefixes.get(prefix.toLowerCase());
        if (prior !== undefined && prior !== prefix) invalid();
        pathPrefixes.set(prefix.toLowerCase(), prefix);
      }
      modules.set(entry.path.toLowerCase(), entry);
    }
    for (const entry of modules.values()) {
      const parents = [...modules.values()]
        .filter((candidate) =>
          entry.path.toLowerCase().startsWith(`${candidate.path.toLowerCase()}/`),
        )
        .sort((left, right) => right.path.length - left.path.length);
      const parent = parents[0];
      if (
        entry.parentPath !== (parent?.path ?? null) ||
        entry.parentCommitSha !== (parent?.commitSha ?? binding.sourceSha) ||
        (parent !== undefined && !entry.path.startsWith(`${parent.path}/`))
      )
        invalid();
    }
  }
  if (binding.gitlinks !== undefined) {
    if (!Array.isArray(binding.gitlinks) || binding.gitlinks.length > 384) invalid();
    const pointers = new Set<string>();
    for (const entry of binding.gitlinks) {
      if (
        !hasExactKeys(entry, ["path", "revisionSha", "commitSha"]) ||
        !canonicalPath(entry.path) ||
        !commit(entry.revisionSha) ||
        !commit(entry.commitSha)
      )
        invalid();
      const identity = `${entry.revisionSha}\0${entry.path.toLowerCase()}`;
      if (pointers.has(identity)) invalid();
      pointers.add(identity);
      if (entry.revisionSha === binding.sourceSha && binding.submodules !== undefined) {
        const mounted = binding.submodules.find((candidate) => candidate.path === entry.path);
        if (
          mounted === undefined ||
          mounted.parentPath !== null ||
          mounted.commitSha !== entry.commitSha
        )
          invalid();
      }
    }
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

/** Validate complete delivered files separately from the bounded, unread candidate catalog. */
export function assertInvestigationSourceContext(
  value: unknown,
  sourceSha: string,
  seedPaths: readonly string[],
): asserts value is InvestigationSourceContext {
  const invalid: () => never = () => {
    throw failure(
      "SOURCE_BINDING_MISMATCH",
      "The focused source context does not match its frozen request.",
    );
  };
  const record = (entry: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!hasExactKeys(entry, keys)) return invalid();
    return entry as Record<string, unknown>;
  };
  const integer = (entry: unknown, maximum: number): entry is number =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 && entry <= maximum;
  const paths = (entry: unknown, maximum: number): string[] => {
    if (!Array.isArray(entry) || entry.length > maximum) return invalid();
    const result = entry.map((path: unknown) => {
      if (typeof path !== "string") return invalid();
      const root = "C:\\source-context";
      const resolved = resolveEditableSourcePath(root, path);
      if (win32.relative(root, resolved).replaceAll("\\", "/") !== path) return invalid();
      return path;
    });
    if (new Set(result.map((path) => path.toLowerCase())).size !== result.length) return invalid();
    return result.toSorted();
  };
  const limits = investigationSourceContextLimits;
  const resultKeys = [
    "sourceSha",
    "seedPaths",
    "requiredFiles",
    "contextFiles",
    "queries",
    "deferred",
    "identityScanFiles",
    "identityScanBytes",
    "catalogComplete",
    "omittedCandidateCount",
  ];
  const result = hasExactKeys(value, [...resultKeys, "queryBudgetExhausted"])
    ? record(value, [...resultKeys, "queryBudgetExhausted"])
    : record(value, resultKeys);
  const requested = paths(seedPaths, limits.maximumSeedPaths);
  if (
    requested.length === 0 ||
    result.sourceSha !== sourceSha ||
    (result.queryBudgetExhausted !== undefined && result.queryBudgetExhausted !== true) ||
    JSON.stringify(paths(result.seedPaths, limits.maximumSeedPaths)) !==
      JSON.stringify(requested) ||
    !integer(result.identityScanFiles, limits.maximumFiles) ||
    !integer(result.identityScanBytes, limits.maximumIdentityScanBytes) ||
    !integer(result.omittedCandidateCount, Number.MAX_SAFE_INTEGER) ||
    typeof result.catalogComplete !== "boolean" ||
    result.catalogComplete !== (result.omittedCandidateCount === 0) ||
    !Array.isArray(result.requiredFiles) ||
    !Array.isArray(result.contextFiles) ||
    !Array.isArray(result.queries) ||
    result.queries.length > limits.maximumQueries ||
    !Array.isArray(result.deferred) ||
    result.deferred.length > limits.maximumCatalogPaths
  )
    return invalid();
  const delivered = new Map<string, string>();
  const required: string[] = [];
  const context: string[] = [];
  let deliveredBytes = 0;
  let relatedFiles = 0;
  let relatedBytes = 0;
  const readFile = (entry: unknown, optional: boolean): void => {
    const keys = optional
      ? ["path", "content", "digest", "role", "relation"]
      : ["path", "content", "digest"];
    const file =
      optional && hasExactKeys(entry, [...keys, "lexicalDeclaration"])
        ? record(entry, [...keys, "lexicalDeclaration"])
        : record(entry, keys);
    const path = paths([file.path], 1)[0]!;
    if (
      typeof file.content !== "string" ||
      typeof file.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.digest)
    )
      invalid();
    const bytes = encodeSourceText(file.content);
    if (digest(bytes) !== file.digest || delivered.has(path.toLowerCase())) invalid();
    if (optional) {
      if (
        file.relation !== "unresolved_reference_identity" ||
        typeof file.role !== "string" ||
        !["definition_candidate", "related_context"].includes(file.role)
      )
        invalid();
      if (file.role === "related_context") {
        relatedFiles++;
        relatedBytes += bytes.byteLength;
      } else if (file.lexicalDeclaration === undefined) invalid();
      if (file.lexicalDeclaration !== undefined) {
        const declaration = record(file.lexicalDeclaration, ["name", "namespace"]);
        if (
          file.role !== "definition_candidate" ||
          typeof declaration.name !== "string" ||
          declaration.name.length > 128 ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(declaration.name) ||
          typeof declaration.namespace !== "string" ||
          declaration.namespace.length > 2048 ||
          !/^[A-Za-z0-9_:.$]*$/u.test(declaration.namespace)
        )
          invalid();
      }
      context.push(path);
    } else required.push(path);
    delivered.set(path.toLowerCase(), path);
    deliveredBytes += bytes.byteLength;
  };
  for (const entry of result.requiredFiles) readFile(entry, false);
  for (const entry of result.contextFiles) readFile(entry, true);
  if (
    JSON.stringify(required.toSorted()) !== JSON.stringify(requested) ||
    delivered.size > limits.maximumFiles ||
    deliveredBytes > limits.maximumBytes ||
    relatedFiles > limits.maximumOptionalFiles ||
    relatedBytes > limits.maximumOptionalBytes ||
    result.identityScanFiles < delivered.size ||
    result.identityScanBytes < deliveredBytes
  )
    return invalid();
  const deferredPaths = new Set<string>();
  const deferredKeys = new Set<string>();
  const reasons = [
    "definition_identity_unresolved",
    "namespace_or_import_only",
    "different_type_identity",
    "candidate_scan_files_budget",
    "candidate_scan_bytes_budget",
    "optional_context_budget",
    "prompt_input_budget",
    "optional_candidate_unselected",
  ];
  for (const entry of result.deferred) {
    const deferred = record(entry, ["path", "reason"]);
    const path = paths([deferred.path], 1)[0]!;
    const key = path.toLowerCase();
    if (
      typeof deferred.reason !== "string" ||
      !reasons.includes(deferred.reason) ||
      delivered.has(key) ||
      deferredKeys.has(key)
    )
      return invalid();
    deferredKeys.add(key);
    deferredPaths.add(path);
  }
  const queriedPaths = new Set<string>();
  const queryKeys = new Map<string, string>();
  let maximumQueryOmitted = 0;
  let totalQueryOmitted = 0;
  for (const entry of result.queries) {
    const query = record(entry, [
      "kind",
      "revisionSha",
      "symbols",
      "paths",
      "matchedPathCount",
      "omittedPathCount",
    ]);
    if (
      typeof query.kind !== "string" ||
      !["definition", "reference"].includes(query.kind) ||
      query.revisionSha !== sourceSha ||
      !Array.isArray(query.symbols) ||
      query.symbols.length === 0 ||
      query.symbols.length > limits.maximumSymbols ||
      new Set(query.symbols).size !== query.symbols.length ||
      query.symbols.some(
        (symbol: unknown) =>
          typeof symbol !== "string" ||
          symbol.length > 128 ||
          !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/u.test(symbol),
      ) ||
      !integer(query.matchedPathCount, Number.MAX_SAFE_INTEGER) ||
      !integer(query.omittedPathCount, Number.MAX_SAFE_INTEGER)
    )
      return invalid();
    const matched = paths(query.paths, limits.maximumCatalogPaths);
    maximumQueryOmitted = Math.max(maximumQueryOmitted, query.omittedPathCount);
    totalQueryOmitted += query.omittedPathCount;
    if (!Number.isSafeInteger(totalQueryOmitted)) return invalid();
    if (
      query.matchedPathCount !== matched.length + query.omittedPathCount ||
      (query.omittedPathCount > 0 && result.catalogComplete)
    )
      return invalid();
    for (const path of matched) {
      const key = path.toLowerCase();
      if (queryKeys.has(key) && queryKeys.get(key) !== path) return invalid();
      queryKeys.set(key, path);
      queriedPaths.add(path);
      if (!delivered.has(key) && !deferredPaths.has(path)) return invalid();
    }
  }
  if (
    queriedPaths.size > limits.maximumCatalogPaths ||
    result.omittedCandidateCount < maximumQueryOmitted ||
    result.omittedCandidateCount > totalQueryOmitted ||
    [...context, ...deferredPaths].some((path) => !queriedPaths.has(path)) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > limits.maximumIdentityScanBytes
  )
    return invalid();
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
