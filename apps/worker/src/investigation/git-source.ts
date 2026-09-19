import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import type { Readable } from "node:stream";
import { createCanonicalResult } from "@agentic-review/codex";
import type { InvestigationSubjectV1 } from "@agentic-review/contracts";
import {
  assertValidProcessLaunchSpec,
  assertWindowsLocalAbsolutePath,
  type ProcessLaunchSpec,
  type ProcessResourceLimits,
} from "../execution/process-host-protocol.js";
import {
  type OwnedHardlinkEntry,
  OwnedHardlinkError,
  validateOwnedHardlinkGroups,
} from "./owned-hardlinks.js";
import {
  type InvestigationPrDiffChunk,
  type InvestigationPrDiffChunkDescriptor,
  type InvestigationPrDiffManifest,
  type InvestigationSourceContext,
  type InvestigationSourceDependencies,
  type InvestigationSourceFile,
  type InvestigationSourceMaterializer,
  type InvestigationWorkspaceContext,
  type InvestigationWorkspaceFileSystem,
  type InvestigationWorkspaceInput,
  investigationSourceContextLimits,
  investigationSourceDependencyLimits,
  ProductionInvestigationWorkspaceFileSystem,
} from "./workspace.js";

export interface InvestigationGitCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
}

export interface InvestigationGitCommandRunner {
  run(
    spec: ProcessLaunchSpec,
    context: InvestigationWorkspaceContext,
  ): Promise<InvestigationGitCommandResult>;
}

export interface InvestigationGitSourceOptions {
  readonly gitExecutablePath: string;
  readonly allowedRepositories: readonly string[];
  /** Deployment-owned OS values only. Git credentials and user configuration are never inherited. */
  readonly environment: Readonly<Record<string, string>>;
  readonly limits: ProcessResourceLimits;
  readonly runner?: InvestigationGitCommandRunner;
  readonly fileSystem?: InvestigationWorkspaceFileSystem;
  readonly maximumTreeEntries?: number;
  readonly maximumPatchBytes?: number;
  readonly maximumDiffBytes?: number;
  /** A prior completed step's server-persisted patch; never an uncertain in-flight mutation. */
  readonly restorePatchSubject?: Extract<InvestigationSubjectV1, { kind: "local_patch" }>;
  readonly readPatchArtifact?: (
    input: InvestigationWorkspaceInput,
    artifactId: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
}

export class InvestigationGitSourceError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationGitSourceError";
  }
}

const gitConfiguration = [
  "credential.helper=",
  "credential.interactive=false",
  "core.askPass=",
  "core.hooksPath=NUL",
  "core.fsmonitor=false",
  "core.autocrlf=false",
  "core.safecrlf=false",
  "core.symlinks=false",
  "core.protectNTFS=true",
  "core.protectHFS=true",
  "core.longpaths=true",
  "core.quotePath=false",
  "core.untrackedCache=false",
  "core.attributesFile=NUL",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "http.followRedirects=false",
  "http.proxy=",
  "http.sslVerify=true",
  "http.extraHeader=",
  "fetch.recurseSubmodules=false",
  "submodule.recurse=false",
  "gc.auto=0",
  "maintenance.auto=false",
];
const allowedOsEnvironment = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT"]);
const dependencySourceExtensions = new Set([
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "hxx",
  "inl",
  "ipp",
  "tpp",
  "ixx",
  "cppm",
  "cu",
  "cuh",
  "cs",
  "csx",
  "fs",
  "fsx",
  "vb",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "java",
  "kt",
  "kts",
  "go",
  "rs",
  "swift",
  "m",
  "mm",
  "py",
  "pyi",
  "rb",
  "php",
  "scala",
  "sc",
  "dart",
  "lua",
  "vue",
  "svelte",
  "razor",
  "xaml",
  "ps1",
  "psm1",
]);
interface GitSourceTreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000";
  readonly blobId: string;
}

/** Public exact-SHA source acquisition; every Git process belongs to the attempt's ProcessHost. */
export class ProductionInvestigationGitSourceMaterializer
  implements InvestigationSourceMaterializer
{
  readonly #options: InvestigationGitSourceOptions;
  readonly #fs: InvestigationWorkspaceFileSystem;
  readonly #runner: InvestigationGitCommandRunner;
  readonly #repositories: Map<string, string>;

  public constructor(options: InvestigationGitSourceOptions) {
    assertWindowsLocalAbsolutePath(options.gitExecutablePath, "investigation Git executable", true);
    this.#options = {
      ...options,
      environment: { ...options.environment },
      limits: { ...options.limits },
    };
    this.#fs = options.fileSystem ?? new ProductionInvestigationWorkspaceFileSystem();
    this.#runner = options.runner ?? new ProductionInvestigationGitCommandRunner();
    for (const [name, value, maximum] of [
      ["maximumTreeEntries", options.maximumTreeEntries ?? 250_000, 1_000_000],
      ["maximumPatchBytes", options.maximumPatchBytes ?? 32 * 1024 * 1024, 32 * 1024 * 1024],
      ["maximumDiffBytes", options.maximumDiffBytes ?? 64 * 1024 * 1024, 256 * 1024 * 1024],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw failure(
          "SOURCE_CONFIGURATION_INVALID",
          `${name} must be a positive safe integer within its supported bound.`,
        );
    }
    this.#repositories = new Map();
    for (const repository of options.allowedRepositories) {
      assertCanonicalRepository(repository);
      if (this.#repositories.has(repository.toLowerCase()))
        throw failure(
          "SOURCE_CONFIGURATION_INVALID",
          "The public repository allowlist contains a duplicate.",
        );
      this.#repositories.set(repository.toLowerCase(), repository);
    }
    for (const [name, value] of Object.entries(options.environment)) {
      if (!allowedOsEnvironment.has(name.toUpperCase()) || /[\0\r\n]/u.test(value))
        throw failure(
          "SOURCE_CONFIGURATION_INVALID",
          "Git accepts only explicit operating-system environment values.",
        );
    }
  }

  public async materialize(
    input: InvestigationWorkspaceInput & { readonly destinationDirectory: string },
    context: InvestigationWorkspaceContext,
  ): Promise<Awaited<ReturnType<InvestigationSourceMaterializer["materialize"]>>> {
    context.signal.throwIfAborted();
    const task = structuredClone(input.task);
    if (task.executionPolicy.mode === "snapshot_only")
      throw failure(
        "SOURCE_UNAVAILABLE",
        "Snapshot-only tasks must not materialize repository source.",
      );
    assertCanonicalRepository(task.repository.fullName);
    const repository = this.#repositories.get(task.repository.fullName.toLowerCase());
    if (repository === undefined)
      throw failure(
        "SOURCE_REPOSITORY_NOT_ALLOWED",
        "The repository is outside the public source allowlist.",
      );
    const subject = task.subjects.find((candidate) => candidate.id === task.subjectRef);
    if (
      subject === undefined ||
      subject.kind === "issue_snapshot" ||
      subject.repositoryId !== task.repository.id ||
      subject.workItemId !== task.workItem.id ||
      !task.executionPolicy.allowedSubjectRefs.includes(subject.id)
    )
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "The task does not identify an authorized immutable source subject.",
      );
    const sourceSha =
      subject.kind === "source_commit"
        ? subject.commitSha
        : subject.kind === "local_patch"
          ? subject.baseSha
          : subject.headSha;
    const baseSha =
      subject.kind === "original_pr" || subject.kind === "remote_branch" ? subject.baseSha : null;
    assertSha(sourceSha);
    if (baseSha !== null) assertSha(baseSha);
    if (
      subject.kind === "original_pr" &&
      hash(Buffer.from(`${subject.baseSha}\0${subject.headSha}`, "utf8")) !== subject.revisionKey
    )
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "The original PR revision must identify its exact base and head pair.",
      );
    if (subject.kind === "local_patch") {
      const base = task.subjects.find((candidate) => candidate.id === subject.baseSubjectRef);
      const expected =
        base?.kind === "source_commit"
          ? base.commitSha
          : base?.kind === "original_pr" || base?.kind === "remote_branch"
            ? base.headSha
            : null;
      if (expected !== sourceSha || base?.repositoryId !== task.repository.id)
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "The patch base does not identify this repository's immutable source.",
        );
    }
    const root = win32.normalize(input.destinationDirectory);
    await this.#assertPath(root, "directory");
    const rootIdentity = (await this.#fs.lstat(root))!.identity;
    if ((await this.#fs.readDirectory(root)).length !== 0)
      throw failure(
        "SOURCE_DIRECTORY_NOT_EMPTY",
        "Source materialization requires a new empty attempt directory.",
      );
    const gitDirectory = win32.join(root, ".git");
    const environment = Object.freeze({
      ...Object.fromEntries(
        Object.entries(this.#options.environment).map(([name, value]) => [
          name.toUpperCase(),
          value,
        ]),
      ),
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "NUL",
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_PAGER: "",
      GIT_EDITOR: "",
      LC_ALL: "C",
      LANG: "C",
      TEMP: root,
      TMP: root,
    });
    const run = async (
      argumentsList: readonly string[],
      signal = context.signal,
      extra: Readonly<Record<string, string>> = {},
      allowGrepNoMatch = false,
    ) => {
      signal.throwIfAborted();
      await this.#assertPath(root, "directory");
      if ((await this.#fs.lstat(root))!.identity !== rootIdentity)
        throw failure("SOURCE_BINDING_MISMATCH", "The owned source directory identity changed.");
      const spec: ProcessLaunchSpec = {
        executable: this.#options.gitExecutablePath,
        arguments: [...gitConfiguration.flatMap((setting) => ["-c", setting]), ...argumentsList],
        workingDirectory: root,
        environmentMode: "replace",
        environment: { ...environment, ...extra },
        limits: { ...this.#options.limits },
      };
      assertValidProcessLaunchSpec(spec);
      const result = await this.#runner.run(spec, { ...context, signal });
      signal.throwIfAborted();
      if (
        result.exitCode !== 0 &&
        !(
          allowGrepNoMatch &&
          argumentsList[0] === "grep" &&
          result.exitCode === 1 &&
          result.stdout.byteLength === 0
        )
      )
        throw failure(
          "SOURCE_GIT_FAILED",
          "A managed Git source operation did not exit successfully.",
        );
      return Uint8Array.from(result.stdout);
    };
    await run(["init", "--quiet", "--template=", "--initial-branch=investigation", "."]);
    await this.#assertPath(gitDirectory, "directory");
    const gitIdentity = (await this.#fs.lstat(gitDirectory))!.identity;
    const url = `https://github.com/${repository}.git`;
    // Git link objects are safe to retain as verified target text in any original checkout.
    // This never authorizes a filesystem link or supplies the referenced target's semantics.
    const allowInertSymlinks =
      subject.kind !== "local_patch" && this.#options.restorePatchSubject === undefined;
    const allowImmutableSourceDiscovery =
      task.executionPolicy.mode === "source_read" && allowInertSymlinks;
    const inertSymlinks = new Map<
      string,
      { readonly path: string; readonly revisionSha: string }
    >();
    let sourceTree: ReadonlyMap<string, GitSourceTreeEntry> = new Map();
    const assertGitRevisionTree = async (revisionSha: string) => {
      const entries = this.#assertGitTree(
        await run(["ls-tree", "-r", "-z", "--full-tree", revisionSha]),
        allowInertSymlinks,
      );
      if (revisionSha === sourceSha)
        sourceTree = new Map(entries.map((entry) => [entry.path, entry]));
      for (const { path, mode } of entries)
        if (mode === "120000") inertSymlinks.set(`${revisionSha}\0${path}`, { path, revisionSha });
    };
    for (const sha of [...new Set([sourceSha, ...(baseSha === null ? [] : [baseSha])])]) {
      await run([
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--",
        url,
        sha,
      ]);
      const observed = decode(await run(["rev-parse", "--verify", `${sha}^{commit}`])).trim();
      if (observed !== sha)
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "The fetched Git object is not the exact requested commit.",
        );
      await assertGitRevisionTree(sha);
    }
    let mergeBase: string | null = null;
    if (baseSha !== null) {
      mergeBase = decode(await run(["merge-base", "--all", baseSha, sourceSha])).trim();
      assertSha(mergeBase);
      await assertGitRevisionTree(mergeBase);
    }
    await run(["checkout", "--quiet", "--detach", "--force", sourceSha]);
    // core.symlinks=false must preserve link blobs as ordinary target-text files, never targets.
    for (const entry of inertSymlinks.values()) {
      if (entry.revisionSha !== sourceSha) continue;
      const path = win32.join(root, ...entry.path.split("/"));
      await this.#assertPath(path, "file");
      const identity = (await this.#fs.lstat(path))!.identity;
      const bytes = await this.#fs.readFile(
        path,
        identity,
        this.#options.limits.maximumOutputBytes,
      );
      if (hash(bytes) !== hash(await run(["cat-file", "blob", `${sourceSha}:${entry.path}`])))
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "A materialized symlink does not contain its exact inert Git target text.",
        );
    }
    const metadataPaths = ["config", "HEAD", "index"].map((name) => win32.join(gitDirectory, name));
    const metadata = await Promise.all(
      metadataPaths.map(async (path) => {
        await this.#assertPath(path, "file");
        const identity = (await this.#fs.lstat(path))!.identity;
        return {
          path,
          identity,
          digest: hash(await this.#fs.readFile(path, identity, 64 * 1024 * 1024)),
        };
      }),
    );
    const optionalMetadata = await Promise.all(
      ["info/attributes", "info/exclude", "shallow"].map(async (name) => {
        const path = win32.join(gitDirectory, name);
        const state = await this.#fs.lstat(path);
        if (state === null) return { path, identity: null, digest: null };
        await this.#assertPath(path, "file");
        return {
          path,
          identity: state.identity,
          digest: hash(await this.#fs.readFile(path, state.identity, 1_024 * 1_024)),
        };
      }),
    );
    const assertMetadata = async () => {
      await this.#assertPath(root, "directory");
      await this.#assertPath(gitDirectory, "directory");
      if (
        (await this.#fs.lstat(root))!.identity !== rootIdentity ||
        (await this.#fs.lstat(gitDirectory))?.identity !== gitIdentity
      )
        throw failure("SOURCE_BINDING_MISMATCH", "The source repository identity changed.");
      for (const entry of metadata) {
        await this.#assertPath(entry.path, "file");
        if (
          (await this.#fs.lstat(entry.path))!.identity !== entry.identity ||
          hash(await this.#fs.readFile(entry.path, entry.identity, 64 * 1024 * 1024)) !==
            entry.digest
        )
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "Git control metadata changed after the source was frozen.",
          );
      }
      for (const entry of optionalMetadata) {
        const state = await this.#fs.lstat(entry.path);
        if ((state?.identity ?? null) !== entry.identity)
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "Git source filtering or shallow-history metadata changed.",
          );
        if (state !== null) {
          await this.#assertPath(entry.path, "file");
          if (
            hash(await this.#fs.readFile(entry.path, state.identity, 1_024 * 1_024)) !==
            entry.digest
          )
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "Git source filtering or shallow-history metadata changed.",
            );
        }
      }
      for (const relative of [
        "commondir",
        "objects/info/alternates",
        "objects/info/http-alternates",
        "info/grafts",
      ]) {
        if ((await this.#fs.lstat(win32.join(gitDirectory, relative))) !== null)
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The source repository contains an external object or history override.",
          );
      }
    };
    const capture = async (signal: AbortSignal) => {
      await assertMetadata();
      const indexPath = win32.join(gitDirectory, `investigation-index-${randomUUID()}`);
      const extra = { GIT_INDEX_FILE: indexPath };
      await run(["read-tree", sourceSha], signal, extra);
      await run(["add", "--all", "--", "."], signal, extra);
      const bytes = await run(
        [
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          sourceSha,
          "--",
        ],
        signal,
        extra,
      );
      if (bytes.byteLength > (this.#options.maximumPatchBytes ?? 32 * 1_024 * 1_024))
        throw failure(
          "SOURCE_PATCH_TOO_LARGE",
          "The full source patch exceeds its explicit artifact budget; no bytes were truncated.",
        );
      await this.#assertPath(indexPath, "file");
      await this.#fs.removeFile(indexPath);
      await assertMetadata();
      return bytes;
    };
    const mutable =
      task.executionPolicy.mode === "execute" &&
      task.executionPolicy.allowRepositoryExecution &&
      task.executionPolicy.authorizationRef !== null &&
      (task.kind === "issue-fix" || task.kind === "feature-implement");
    const patchSubject =
      subject.kind === "local_patch" ? subject : this.#options.restorePatchSubject;
    if (
      patchSubject !== undefined &&
      patchSubject !== subject &&
      (!mutable ||
        patchSubject.baseSubjectRef !== subject.id ||
        patchSubject.baseSha !== sourceSha ||
        patchSubject.repositoryId !== task.repository.id ||
        patchSubject.workItemId !== task.workItem.id)
    )
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "A resumed patch must belong to this exact task source and a completed mutation step.",
      );
    let originalPatch: Uint8Array | null = null;
    if (patchSubject !== undefined) {
      if (this.#options.readPatchArtifact === undefined)
        throw failure(
          "SOURCE_UNAVAILABLE",
          "The worker has no trusted reader for the persisted patch artifact.",
        );
      originalPatch = Uint8Array.from(
        await this.#options.readPatchArtifact(input, patchSubject.artifactRef, context.signal),
      );
      if (
        originalPatch.byteLength === 0 ||
        originalPatch.byteLength > (this.#options.maximumPatchBytes ?? 32 * 1_024 * 1_024) ||
        hash(originalPatch) !== patchSubject.patchDigest
      )
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "The persisted patch bytes do not match their frozen digest and size policy.",
        );
      const patchPath = win32.join(gitDirectory, `investigation-patch-${randomUUID()}`);
      await this.#fs.writeExclusive(patchPath, originalPatch);
      await this.#assertPath(patchPath, "file");
      await run(["apply", "--check", "--binary", "--whitespace=nowarn", "--", patchPath]);
      await run(["apply", "--binary", "--whitespace=nowarn", "--", patchPath]);
      await this.#fs.removeFile(patchPath);
      if (hash(await capture(context.signal)) !== patchSubject.patchDigest)
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "The materialized patch differs from its canonical saved worktree patch.",
        );
    }
    const assertCurrentTree = () =>
      this.#assertTree(
        root,
        task.executionPolicy.mode === "execute"
          ? new Set([...sourceTree.keys()].map((path) => key(win32.join(root, ...path.split("/")))))
          : undefined,
      );
    const assertBinding = async () => {
      await assertCurrentTree();
      await assertMetadata();
      if (decode(await run(["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== sourceSha)
        throw failure("SOURCE_BINDING_MISMATCH", "The checked-out source HEAD changed.");
      if (
        baseSha !== null &&
        decode(await run(["merge-base", "--all", baseSha, sourceSha])).trim() !== mergeBase
      )
        throw failure("SOURCE_BINDING_MISMATCH", "The frozen PR merge base changed.");
      if (!mutable) {
        if (originalPatch === null) {
          const changes = await run([
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            sourceSha,
            "--",
          ]);
          if (changes.byteLength !== 0)
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "The original tracked source changed during a non-mutation task.",
            );
          if (
            task.executionPolicy.mode === "source_read" &&
            (await run(["ls-files", "--others", "--directory", "--no-empty-directory", "-z"]))
              .byteLength !== 0
          )
            throw failure(
              "SOURCE_BINDING_MISMATCH",
              "The immutable source checkout contains files outside its original Git tree.",
            );
        } else if (hash(await capture(context.signal)) !== hash(originalPatch)) {
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The verified local patch changed during validation.",
          );
        }
      }
      await assertMetadata();
    };
    const checkoutRepresentations = new Map<string, { digest: string; byteLength: number }>();
    const assertReadBinding = async (file?: InvestigationSourceFile) => {
      await assertMetadata();
      if (file === undefined || mutable) return;
      if (originalPatch !== null) {
        await assertBinding();
        return;
      }
      this.#assertGitTree(Buffer.from(`100644 blob ${sourceSha}\t${file.path}\0`, "utf8"));
      const expected = sourceTree.get(file.path);
      if (file.content === null) {
        if (expected !== undefined || file.digest !== null)
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The source file is missing from its original checkout location.",
          );
        return;
      }
      const bytes = Buffer.from(file.content, "utf8");
      const blobId = createHash("sha1")
        .update(`blob ${bytes.byteLength}\0`, "utf8")
        .update(bytes)
        .digest("hex");
      if (expected === undefined || file.digest !== hash(bytes))
        throw failure(
          "SOURCE_BINDING_MISMATCH",
          "The source file bytes do not match the original Git blob.",
        );
      if (expected.blobId === blobId) return;
      // A Windows checkout can legitimately contain CRLF although its Git blob uses LF.
      // Ask Git for the pinned blob's checkout representation rather than stripping bytes:
      // -text/binary files, literal CR bytes and real edits must retain exact identities.
      if (expected.mode !== "120000" && file.content.includes("\r\n")) {
        const representationKey = `${sourceSha}\0${file.path}`;
        let representation = checkoutRepresentations.get(representationKey);
        if (representation === undefined) {
          const checkoutBytes = await run(
            ["cat-file", "--filters", `${sourceSha}:${file.path}`],
            context.signal,
            { GIT_ATTR_SOURCE: sourceSha },
          );
          await assertMetadata();
          representation = { digest: hash(checkoutBytes), byteLength: checkoutBytes.byteLength };
          checkoutRepresentations.set(representationKey, representation);
        }
        if (representation.byteLength === bytes.byteLength && representation.digest === file.digest)
          return;
      }
      throw failure(
        "SOURCE_BINDING_MISMATCH",
        "The source file bytes do not match the original Git blob or its pinned checkout representation.",
      );
    };
    let prDiff:
      | Promise<{
          manifest: InvestigationPrDiffManifest;
          chunks: ReadonlyMap<string, InvestigationPrDiffChunk>;
        }>
      | undefined;
    const preparePrDiff = async () => {
      if (subject.kind !== "original_pr" || baseSha === null || mergeBase === null)
        throw failure(
          "SOURCE_DIFF_UNAVAILABLE",
          "Only an exact original PR source provides a complete PR diff manifest.",
        );
      await assertReadBinding();
      const comparisonBase = mergeBase;
      const listing = decode(
        await run(["diff", "--name-status", "-z", "--no-renames", comparisonBase, sourceSha, "--"]),
      );
      if (listing !== "" && !listing.endsWith("\0"))
        throw failure(
          "SOURCE_DIFF_INVALID",
          "The complete changed-file listing is missing its terminal record delimiter.",
        );
      const records = listing === "" ? [] : listing.slice(0, -1).split("\0");
      if (
        records.length % 2 !== 0 ||
        records.length / 2 > (this.#options.maximumTreeEntries ?? 250_000)
      )
        throw failure(
          "SOURCE_DIFF_INVALID",
          "The complete changed-file listing is invalid or exceeds its explicit entry budget.",
        );
      const files: Array<InvestigationPrDiffManifest["files"][number]> = [];
      const descriptors: InvestigationPrDiffChunkDescriptor[] = [];
      const chunks = new Map<string, InvestigationPrDiffChunk>();
      const paths = new Set<string>();
      let totalBytes = 0;
      const maximumBytes = this.#options.maximumDiffBytes ?? 64 * 1024 * 1024;
      for (let index = 0; index < records.length; index += 2) {
        context.signal.throwIfAborted();
        const statusCode = records[index];
        const path = records[index + 1]!;
        const status =
          statusCode === "A"
            ? "added"
            : statusCode === "D"
              ? "deleted"
              : statusCode === "M" || statusCode === "T"
                ? "modified"
                : null;
        if (status === null || !path || paths.has(path.toLowerCase()))
          throw failure(
            "SOURCE_DIFF_INVALID",
            "The changed-file listing contains an unsupported or duplicate entry.",
          );
        paths.add(path.toLowerCase());
        this.#assertGitTree(Buffer.from(`100644 blob ${sourceSha}\t${path}\0`, "utf8"));
        const chunkIds: string[] = [];
        const append = (kind: InvestigationPrDiffChunkDescriptor["kind"], bytes: Uint8Array) => {
          totalBytes += bytes.byteLength;
          if (totalBytes > maximumBytes)
            throw failure(
              "SOURCE_DIFF_TOO_LARGE",
              "The complete PR source and diff exceed their explicit materialization budget; nothing was silently omitted.",
            );
          let encoding: InvestigationPrDiffChunkDescriptor["encoding"] = "utf8";
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            if (content.includes("\0")) throw new Error("Binary source.");
          } catch {
            encoding = "base64";
            content = Buffer.from(bytes).toString("base64");
          }
          let offset = 0;
          let ordinal = 0;
          do {
            let length = Math.min(8_192, content.length - offset);
            if (encoding === "base64" && length < content.length - offset) length -= length % 4;
            let chunk: InvestigationPrDiffChunk;
            for (;;) {
              if (
                length > 0 &&
                encoding === "utf8" &&
                /[\uD800-\uDBFF]/u.test(content.charAt(offset + length - 1))
              )
                length--;
              const value = content.slice(offset, offset + length);
              const contentDigest = hash(Buffer.from(value, "utf8"));
              const identity = createCanonicalResult({
                subjectRef: subject.id,
                baseSha,
                headSha: sourceSha,
                mergeBaseSha: comparisonBase,
                path,
                kind,
                ordinal,
                encoding,
                contentDigest,
              }).sha256;
              chunk = {
                id: `git-chunk-${identity}`,
                path,
                kind,
                ordinal,
                encoding,
                contentDigest,
                byteLength: Buffer.byteLength(value, "utf8"),
                content: value,
              };
              if (Buffer.byteLength(JSON.stringify(chunk), "utf8") <= 65_536) break;
              if (length === 0)
                throw failure(
                  "SOURCE_DIFF_TOO_LARGE",
                  "A PR chunk descriptor exceeds the transport budget.",
                );
              length = Math.floor(length / 2);
              if (encoding === "base64") length -= length % 4;
            }
            if (length === 0 && offset < content.length)
              throw failure(
                "SOURCE_DIFF_TOO_LARGE",
                "A PR source chunk cannot fit its bounded transport without omission.",
              );
            const { content: _content, ...descriptor } = chunk;
            descriptors.push(descriptor);
            chunks.set(chunk.id, chunk);
            chunkIds.push(chunk.id);
            offset += length;
            ordinal++;
          } while (offset < content.length);
        };
        append(
          "diff",
          await run([
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            comparisonBase,
            sourceSha,
            "--",
            path,
          ]),
        );
        if (status !== "added")
          append("base", await run(["cat-file", "blob", `${comparisonBase}:${path}`]));
        if (status !== "deleted")
          append("head", await run(["cat-file", "blob", `${sourceSha}:${path}`]));
        files.push({ path, previousPath: null, status, chunkIds });
      }
      const document = {
        schemaVersion: "InvestigationPrDiffManifestV1" as const,
        subjectRef: subject.id,
        baseSha,
        headSha: sourceSha,
        mergeBaseSha: comparisonBase,
        files,
        chunks: descriptors,
      };
      if (Buffer.byteLength(JSON.stringify(document), "utf8") > maximumBytes)
        throw failure(
          "SOURCE_DIFF_TOO_LARGE",
          "The complete PR diff manifest exceeds its explicit materialization budget.",
        );
      const manifest: InvestigationPrDiffManifest = {
        ...document,
        digest: createCanonicalResult(document).sha256,
      };
      await assertReadBinding();
      return { manifest, chunks };
    };
    const getPrDiff = () => {
      prDiff ??= preparePrDiff();
      return prDiff;
    };
    const readPrDiffChunks = async (
      ids: readonly string[],
    ): Promise<readonly InvestigationPrDiffChunk[]> => {
      if (
        !Array.isArray(ids) ||
        ids.length > (this.#options.maximumTreeEntries ?? 250_000) ||
        ids.some((id) => typeof id !== "string") ||
        new Set(ids).size !== ids.length
      )
        throw failure(
          "SOURCE_DIFF_UNAVAILABLE",
          "A PR source batch must contain bounded, unique chunk IDs.",
        );
      const requestedIds = [...ids];
      await assertReadBinding();
      const frozen = await getPrDiff();
      const chunks = requestedIds.map((id) => {
        const chunk = frozen.chunks.get(id);
        if (chunk === undefined)
          throw failure(
            "SOURCE_DIFF_UNAVAILABLE",
            "The requested chunk is absent from the complete frozen PR diff manifest.",
          );
        return structuredClone(chunk);
      });
      await assertReadBinding();
      return chunks;
    };
    const dependencyCache = new Map<string, InvestigationSourceDependencies>();
    const readSourceDependencies = async (
      paths: readonly string[],
    ): Promise<InvestigationSourceDependencies> => {
      if (!allowImmutableSourceDiscovery)
        throw failure(
          "SOURCE_DEPENDENCY_UNAVAILABLE",
          "Source dependency discovery requires immutable source-read access without a local patch.",
        );
      const limits = investigationSourceDependencyLimits;
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
        throw failure(
          "SOURCE_DEPENDENCY_UNAVAILABLE",
          "Source dependency seeds must be an array of exact frozen source paths.",
        );
      if (paths.length > limits.maximumSeedPaths)
        throw dependencyLimit("The source dependency seed path budget was exceeded.");
      if (new Set(paths).size !== paths.length)
        throw failure("SOURCE_DEPENDENCY_UNAVAILABLE", "Source dependency seeds must be unique.");
      const seedPaths = [...paths].sort();
      const cacheKey = JSON.stringify(seedPaths);
      await assertBinding();
      let result: InvestigationSourceDependencies;
      try {
        const cached = dependencyCache.get(cacheKey);
        if (cached !== undefined) result = cached;
        else {
          const assertOrdinarySourcePath = (path: string) => {
            this.#assertGitTree(Buffer.from(`100644 blob ${sourceSha}\t${path}\0`, "utf8"));
            const entry = sourceTree.get(path);
            if (entry === undefined || entry.mode === "120000")
              throw failure(
                "SOURCE_DEPENDENCY_UNAVAILABLE",
                "A dependency path is not an ordinary source file in the exact frozen source tree.",
              );
          };
          const assertSourcePath = (path: string) => {
            assertOrdinarySourcePath(path);
            if (!isDependencySourcePath(path))
              throw failure(
                "SOURCE_DEPENDENCY_UNAVAILABLE",
                "A dependency path is not an eligible ordinary source file in the exact frozen source tree.",
              );
          };
          const unsupportedSeedPaths = seedPaths.filter((path) => {
            assertOrdinarySourcePath(path);
            return !isDependencySourcePath(path);
          });
          const supportedSeedPaths = seedPaths.filter((path) => isDependencySourcePath(path));
          const files = new Map<string, InvestigationSourceDependencies["files"][number]>();
          const scanned = new Map<
            string,
            {
              file: InvestigationSourceDependencies["files"][number];
              byteLength: number;
              identity: SourceIdentityInfo;
            }
          >();
          let totalBytes = 0;
          let identityScanBytes = 0;
          const scan = async (path: string) => {
            assertSourcePath(path);
            const existing = scanned.get(path);
            if (existing !== undefined) return existing;
            if (scanned.size >= limits.maximumFiles)
              throw dependencyLimit("The complete source identity scan file budget was exceeded.");
            const bytes = await run(["cat-file", "blob", `${sourceSha}:${path}`]);
            identityScanBytes += bytes.byteLength;
            if (identityScanBytes > limits.maximumIdentityScanBytes)
              throw dependencyLimit("The complete source identity scan byte budget was exceeded.");
            let content: string;
            try {
              content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
              if (content.includes("\0")) throw new Error("Binary source.");
            } catch {
              throw failure(
                "SOURCE_DEPENDENCY_UNREADABLE",
                "A required source dependency blob is binary or is not complete valid UTF-8.",
              );
            }
            const file = { path, content, digest: hash(bytes) };
            const entry = {
              file,
              byteLength: bytes.byteLength,
              identity: sourceIdentityInfo(content, path),
            };
            scanned.set(path, entry);
            return entry;
          };
          const include = (entry: Awaited<ReturnType<typeof scan>>) => {
            const { file, byteLength } = entry;
            if (files.has(file.path)) return file;
            if (files.size >= limits.maximumFiles)
              throw dependencyLimit("The complete source dependency file budget was exceeded.");
            totalBytes += byteLength;
            if (totalBytes > limits.maximumBytes)
              throw dependencyLimit("The complete source dependency byte budget was exceeded.");
            files.set(file.path, file);
            return file;
          };
          const symbols = new Set<string>();
          const anchorIdentities = new Map<string, SourceAnchorIdentity>();
          const appendAnchors = (
            entry: Awaited<ReturnType<typeof scan>>,
            priorSymbols?: ReadonlySet<string>,
          ) => {
            const added: SourceAnchorIdentity[] = [];
            for (const anchor of entry.identity.anchors) {
              if (priorSymbols?.has(anchor.name)) continue;
              const key = `${anchor.name}\0${anchor.namespace}`;
              if (anchorIdentities.has(key)) continue;
              if (anchorIdentities.size >= limits.maximumSymbols)
                throw dependencyLimit("The source dependency anchor identity budget was exceeded.");
              if (!symbols.has(anchor.name) && symbols.size >= limits.maximumSymbols)
                throw dependencyLimit("The source dependency symbol budget was exceeded.");
              symbols.add(anchor.name);
              anchorIdentities.set(key, anchor);
              added.push(anchor);
            }
            return added;
          };
          for (const path of supportedSeedPaths) {
            const entry = await scan(path);
            include(entry);
            appendAnchors(entry);
          }
          if (symbols.size === 0 && (seedPaths.length === 0 || supportedSeedPaths.length > 0))
            throw failure(
              "SOURCE_DEPENDENCY_UNAVAILABLE",
              "The seed source contains no supported lexical type declaration or qualified owner definition to search.",
            );
          let frontierAnchors = [...anchorIdentities.values()];
          const queries: Array<InvestigationSourceDependencies["queries"][number]> = [];
          for (let depth = 1; depth <= limits.maximumDepth && frontierAnchors.length > 0; depth++) {
            frontierAnchors.sort((left, right) => {
              const leftKey = `${left.name}\0${left.namespace}`;
              const rightKey = `${right.name}\0${right.namespace}`;
              return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
            });
            const frontier = [...new Set(frontierAnchors.map((anchor) => anchor.name))].sort();
            const output = decode(
              await run(
                [
                  "grep",
                  "-a",
                  "-F",
                  "-w",
                  "-l",
                  "-z",
                  "--no-color",
                  "--no-textconv",
                  "--full-name",
                  ...frontier.flatMap((symbol) => ["-e", symbol]),
                  sourceSha,
                  "--",
                  ...[...dependencySourceExtensions].map(
                    (extension) => `:(glob,icase)**/*.${extension}`,
                  ),
                ],
                context.signal,
                {},
                true,
              ),
            );
            if (output !== "" && !output.endsWith("\0"))
              throw failure(
                "SOURCE_DEPENDENCY_UNAVAILABLE",
                "The source dependency match listing is missing its terminal delimiter.",
              );
            const records = output === "" ? [] : output.slice(0, -1).split("\0");
            if (records.length > limits.maximumFiles)
              throw dependencyLimit(
                "The complete source dependency match path budget was exceeded.",
              );
            const matched = new Set<string>();
            for (const record of records) {
              const prefix = `${sourceSha}:`;
              if (!record.startsWith(prefix))
                throw failure(
                  "SOURCE_BINDING_MISMATCH",
                  "A dependency match does not identify the exact frozen source commit.",
                );
              const path = record.slice(prefix.length);
              assertSourcePath(path);
              if (matched.has(path))
                throw failure(
                  "SOURCE_DEPENDENCY_UNAVAILABLE",
                  "The dependency match listing contains a duplicate path.",
                );
              matched.add(path);
            }
            const matchedPaths = [...matched].sort();
            const newlyRead: Array<Awaited<ReturnType<typeof scan>>> = [];
            const provenReferencePaths: string[] = [];
            const unpropagatedMatches: Array<{
              path: string;
              reason: "unresolved_reference_identity";
            }> = [];
            const excludedMatches: NonNullable<
              InvestigationSourceDependencies["queries"][number]["excludedMatches"]
            >[number][] = [];
            for (const path of matchedPaths) {
              const isNew = !files.has(path);
              const entry = await scan(path);
              const classification = classifySourceIdentityMatches(entry.identity, frontierAnchors);
              if (isNew && !classification.retain) {
                if (
                  classification.reason === undefined ||
                  classification.matchedSymbols.length === 0
                )
                  throw failure(
                    "SOURCE_DEPENDENCY_UNAVAILABLE",
                    "A source identity exclusion lacks its complete reason and matched symbols.",
                  );
                excludedMatches.push({
                  path,
                  reason: classification.reason,
                  matchedSymbols: classification.matchedSymbols,
                });
                continue;
              }
              include(entry);
              if (classification.proven) provenReferencePaths.push(path);
              if (isNew) {
                if (classification.proven) newlyRead.push(entry);
                else unpropagatedMatches.push({ path, reason: "unresolved_reference_identity" });
              }
            }
            queries.push({
              revisionSha: sourceSha,
              symbols: frontier,
              paths: matchedPaths,
              depth,
              anchorIdentities: frontierAnchors,
              excludedMatches,
              provenReferencePaths,
              unpropagatedMatches,
            });
            const priorSymbols = new Set(symbols);
            frontierAnchors =
              depth < limits.maximumDepth
                ? newlyRead.flatMap((entry) => appendAnchors(entry, priorSymbols))
                : [];
          }
          const seeds = new Set(seedPaths);
          result = {
            sourceSha,
            seedPaths,
            ...(unsupportedSeedPaths.length === 0 ? {} : { unsupportedSeedPaths }),
            symbols: [...symbols].sort(),
            searchDepth: queries.length,
            identityScanBytes,
            queries,
            files: [...files.values()]
              .filter((file) => !seeds.has(file.path))
              .sort((left, right) =>
                left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
              ),
          };
          if (Buffer.byteLength(JSON.stringify(result), "utf8") > limits.maximumBytes * 4)
            throw dependencyLimit(
              "The complete source dependency result metadata budget was exceeded.",
            );
        }
      } finally {
        await assertBinding();
      }
      dependencyCache.set(cacheKey, result);
      return structuredClone(result);
    };
    const sourceContextCache = new Map<string, InvestigationSourceContext>();
    const readSourceContext = async (
      paths: readonly string[],
    ): Promise<InvestigationSourceContext> => {
      const limits = investigationSourceContextLimits;
      if (!allowImmutableSourceDiscovery)
        throw failure(
          "SOURCE_DEPENDENCY_UNAVAILABLE",
          "Source context requires immutable source-read access without a local patch.",
        );
      if (
        !Array.isArray(paths) ||
        paths.some((path) => typeof path !== "string") ||
        new Set(paths).size !== paths.length
      )
        throw failure(
          "SOURCE_DEPENDENCY_UNAVAILABLE",
          "Source context seeds must be unique exact frozen paths.",
        );
      if (paths.length === 0 || paths.length > limits.maximumSeedPaths)
        throw dependencyLimit("The required source context seed budget was exceeded.");
      const seedPaths = [...paths].sort();
      const cacheKey = JSON.stringify(seedPaths);
      await assertBinding();
      let result: InvestigationSourceContext;
      try {
        const cached = sourceContextCache.get(cacheKey);
        if (cached !== undefined) result = cached;
        else {
          type File = InvestigationSourceContext["requiredFiles"][number];
          type Scanned = { file: File; byteLength: number; identity: SourceIdentityInfo };
          type DeferredReason = InvestigationSourceContext["deferred"][number]["reason"];
          type RawQuery = {
            kind: "definition" | "reference";
            symbols: string[];
            paths: string[];
            forward: boolean;
            anchors: readonly SourceAnchorIdentity[];
          };
          const required = new Map<string, File>();
          const selected = new Map<string, InvestigationSourceContext["contextFiles"][number]>();
          const scanned = new Map<string, Scanned>();
          const catalog = new Set<string>();
          const allCandidates = new Set<string>();
          const deferred = new Map<string, DeferredReason>();
          const queries: RawQuery[] = [];
          const ownerNames = new Set<string>();
          const forwardNames = new Set<string>();
          const ownerAnchors: SourceAnchorIdentity[] = [];
          const forwardAnchors = new Map<string, SourceAnchorIdentity>();
          const memberNames = new Set<string>();
          let identityScanBytes = 0;
          let deliveryBytes = 0;
          let queryBudgetExhausted = false;
          const assertSource = (path: string) => {
            this.#assertGitTree(Buffer.from(`100644 blob ${sourceSha}\t${path}\0`, "utf8"));
            const entry = sourceTree.get(path);
            if (entry === undefined || entry.mode === "120000" || !isDependencySourcePath(path))
              throw failure(
                "SOURCE_DEPENDENCY_UNAVAILABLE",
                "A source context path is not an ordinary eligible file in the frozen tree.",
              );
          };
          const retainCatalog = (path: string, reason: DeferredReason): boolean => {
            if (!catalog.has(path) && catalog.size >= limits.maximumCatalogPaths) return false;
            catalog.add(path);
            if (!required.has(path) && !selected.has(path)) deferred.set(path, reason);
            return true;
          };
          const rankPath = (path: string, names: readonly string[]) => {
            const parts = path.split("/");
            const fileName = parts.pop()!.replace(/\.[^.]+$/u, "");
            let common = 0;
            for (const seed of seedPaths) {
              const directories = seed.split("/").slice(0, -1);
              let length = 0;
              while (
                length < Math.min(parts.length, directories.length) &&
                parts[length] === directories[length]
              )
                length++;
              common = Math.max(common, length);
            }
            return (
              common * 100 +
              names.filter((name) => fileName.includes(name)).length * 200 +
              [...memberNames].filter((name) => name.length > 3 && fileName.includes(name)).length *
                20
            );
          };
          const scan = async (path: string, mandatory: boolean): Promise<Scanned | null> => {
            assertSource(path);
            const existing = scanned.get(path);
            if (existing) return existing;
            if (scanned.size >= limits.maximumFiles) {
              if (mandatory)
                throw dependencyLimit(
                  "The required source identity scan file budget was exceeded.",
                );
              deferred.set(path, "candidate_scan_files_budget");
              return null;
            }
            if (!mandatory) {
              const sizeText = decode(await run(["cat-file", "-s", `${sourceSha}:${path}`])).trim();
              if (!/^[0-9]+$/u.test(sizeText) || !Number.isSafeInteger(Number(sizeText)))
                throw failure(
                  "SOURCE_DEPENDENCY_UNAVAILABLE",
                  "A source context blob size is invalid.",
                );
              if (identityScanBytes + Number(sizeText) > limits.maximumIdentityScanBytes) {
                deferred.set(path, "candidate_scan_bytes_budget");
                return null;
              }
            }
            const bytes = await run(["cat-file", "blob", `${sourceSha}:${path}`]);
            identityScanBytes += bytes.byteLength;
            if (identityScanBytes > limits.maximumIdentityScanBytes)
              throw dependencyLimit("The complete source identity scan byte budget was exceeded.");
            let content: string;
            try {
              content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
              if (content.includes("\0")) throw new Error("Binary source.");
            } catch {
              throw failure(
                "SOURCE_DEPENDENCY_UNREADABLE",
                "A source context blob is binary or is not complete valid UTF-8.",
              );
            }
            const entry = {
              file: { path, content, digest: hash(bytes) },
              byteLength: bytes.byteLength,
              identity: sourceIdentityInfo(content, path),
            };
            scanned.set(path, entry);
            return entry;
          };
          const include = (entry: Scanned, declaration?: SourceAnchorIdentity): boolean => {
            const path = entry.file.path;
            if (required.has(path) || selected.has(path)) return true;
            if (
              required.size + selected.size >= limits.maximumFiles ||
              deliveryBytes + entry.byteLength > limits.maximumBytes
            ) {
              deferred.set(
                path,
                deliveryBytes + entry.byteLength > limits.maximumBytes
                  ? "prompt_input_budget"
                  : "optional_context_budget",
              );
              return false;
            }
            deliveryBytes += entry.byteLength;
            selected.set(path, {
              ...entry.file,
              role: declaration ? "definition_candidate" : "related_context",
              relation: "unresolved_reference_identity",
              ...(declaration ? { lexicalDeclaration: { ...declaration } } : {}),
            });
            deferred.delete(path);
            return true;
          };
          const query = async (
            kind: RawQuery["kind"],
            names: readonly string[],
            forward = false,
            anchors: readonly SourceAnchorIdentity[] = [],
          ): Promise<string[]> => {
            const symbols = [...new Set(names)].sort();
            if (symbols.length > limits.maximumSymbols) {
              const matches = new Set<string>();
              let batch: string[] = [];
              for (const symbol of symbols) {
                batch.push(symbol);
                if (batch.length === limits.maximumSymbols) {
                  for (const path of await query(
                    kind,
                    batch,
                    forward,
                    anchors.filter((anchor) => batch.includes(anchor.name)),
                  ))
                    matches.add(path);
                  batch = [];
                }
              }
              if (batch.length > 0)
                for (const path of await query(
                  kind,
                  batch,
                  forward,
                  anchors.filter((anchor) => batch.includes(anchor.name)),
                ))
                  matches.add(path);
              return [...matches].sort();
            }
            if (symbols.length === 0) return [];
            if (queries.length >= limits.maximumQueries) {
              queryBudgetExhausted = true;
              return [];
            }
            const patterns =
              kind === "definition"
                ? symbols.map(
                    (name) =>
                      `(^|[^[:alnum:]_])(class|struct|enum|interface|record)([[:space:]]+(class|struct))?[[:space:]]+${name}([^[:alnum:]_]|$)`,
                  )
                : symbols;
            const text = decode(
              await run(
                [
                  "grep",
                  "-a",
                  ...(kind === "definition" ? ["-E"] : ["-F", "-w"]),
                  "-l",
                  "-z",
                  "--no-color",
                  "--no-textconv",
                  "--full-name",
                  ...patterns.flatMap((pattern) => ["-e", pattern]),
                  sourceSha,
                  "--",
                  ...[...dependencySourceExtensions].map(
                    (extension) => `:(glob,icase)**/*.${extension}`,
                  ),
                ],
                context.signal,
                {},
                true,
              ),
            );
            if (text !== "" && !text.endsWith("\0"))
              throw failure(
                "SOURCE_DEPENDENCY_UNAVAILABLE",
                "A source context match listing is incomplete.",
              );
            const paths =
              text === ""
                ? []
                : text
                    .slice(0, -1)
                    .split("\0")
                    .map((record) => {
                      if (!record.startsWith(`${sourceSha}:`))
                        throw failure(
                          "SOURCE_BINDING_MISMATCH",
                          "A source context match names another revision.",
                        );
                      const path = record.slice(sourceSha.length + 1);
                      assertSource(path);
                      return path;
                    });
            if (new Set(paths).size !== paths.length)
              throw failure(
                "SOURCE_DEPENDENCY_UNAVAILABLE",
                "A source context match listing contains duplicate paths.",
              );
            paths.sort();
            for (const path of paths) allCandidates.add(path);
            queries.push({ kind, symbols, paths, forward, anchors });
            return paths;
          };
          for (const path of seedPaths) {
            const entry = (await scan(path, true))!;
            deliveryBytes += entry.byteLength;
            if (deliveryBytes > limits.maximumBytes)
              throw dependencyLimit("The required source context byte budget was exceeded.");
            required.set(path, entry.file);
            for (const anchor of entry.identity.anchors) {
              ownerNames.add(anchor.name);
              ownerAnchors.push(anchor);
            }
          }
          const definitionCache = new Map<string, string[]>();
          const join = (left: string, right: string) =>
            left && right ? `${left}::${right}` : left || right;
          const parents = (namespace: string) => {
            const parts = namespace ? namespace.split("::") : [];
            return Array.from({ length: parts.length + 1 }, (_, index) =>
              parts.slice(0, parts.length - index).join("::"),
            );
          };
          const spellings = (name: string, namespace: string, absolute = false) =>
            absolute
              ? [name]
              : [...new Set([name, ...parents(namespace).map((parent) => join(parent, name))])];
          const discoverDefinition = async (
            name: string,
            expected: readonly string[],
            exactNamespace?: string,
          ) => {
            const matches = definitionCache.get(name) ?? (await query("definition", [name]));
            definitionCache.set(name, matches);
            const matching: Array<{ entry: Scanned; declaration: SourceAnchorIdentity }> = [];
            const ordered = [...matches].sort(
              (a, b) => rankPath(b, [name]) - rankPath(a, [name]) || (a < b ? -1 : a > b ? 1 : 0),
            );
            for (const path of ordered) {
              if (!retainCatalog(path, "definition_identity_unresolved")) continue;
              const definition = await scan(path, false);
              if (!definition || definition.identity.language === "other") continue;
              for (const declaration of definition.identity.anchors)
                if (
                  declaration.name === name &&
                  (exactNamespace === undefined
                    ? expected.includes(join(declaration.namespace, declaration.name))
                    : declaration.namespace === exactNamespace)
                )
                  matching.push({ entry: definition, declaration });
            }
            if (
              new Set(
                matching.map((match) => join(match.declaration.namespace, match.declaration.name)),
              ).size !== 1
            )
              return;
            for (const match of matching) {
              include(match.entry, match.declaration);
              forwardNames.add(match.declaration.name);
              forwardAnchors.set(
                join(match.declaration.namespace, match.declaration.name),
                match.declaration,
              );
            }
          };
          // All required bodies are already retained. Resolve explicit XAML type identities
          // before broader code candidates compete for the same bounded scan capacity.
          const xamlReferences: SourceAnchorIdentity[] = [];
          const xamlNames = new Map<string, Set<string>>();
          for (const seed of seedPaths) {
            if (!isXamlSourcePath(seed)) continue;
            const references = xamlSourceTypeReferences(scanned.get(seed)!.file.content);
            for (const reference of references ?? []) {
              const names = xamlNames.get(reference.namespace) ?? new Set<string>();
              if (!names.has(reference.name)) {
                names.add(reference.name);
                xamlNames.set(reference.namespace, names);
                xamlReferences.push(reference);
              }
            }
          }
          for (const reference of xamlReferences)
            await discoverDefinition(reference.name, [], reference.namespace);
          for (const seed of seedPaths) {
            if (isXamlSourcePath(seed)) continue;
            const entry = scanned.get(seed)!;
            const typed = sourceContextTypePositions(entry.file.content, seed);
            for (const member of typed.members) memberNames.add(member);
            for (const candidate of typed.candidates) {
              const reference = entry.identity.references.find(
                (reference) => reference.index === candidate.index,
              );
              if (!reference) continue;
              const active = (scope: number) => {
                let current: number | null = reference.scope;
                while (current !== null) {
                  if (current === scope) return true;
                  current = entry.identity.scopes[current]?.parent ?? null;
                }
                return false;
              };
              const aliases = entry.identity.aliases.filter(
                (alias) => alias.name === candidate.name && active(alias.scope),
              );
              if (aliases.some((alias) => alias.uncertain) || aliases.length > 1) continue;
              let name = candidate.name;
              let expected: string[];
              if (aliases.length === 1) {
                const alias = aliases[0]!;
                name = alias.targetName;
                expected = spellings(
                  join(alias.targetNamespace, alias.targetName),
                  alias.namespace,
                );
              } else if (reference.qualifier !== null)
                expected = spellings(
                  join(reference.qualifier, reference.name),
                  reference.namespace,
                  reference.absolute,
                );
              else
                expected = [
                  ...new Set([
                    ...spellings(reference.name, reference.namespace),
                    ...entry.identity.imports
                      .filter((imported) => active(imported.scope))
                      .flatMap((imported) =>
                        spellings(imported.namespace, imported.context).map((namespace) =>
                          join(namespace, reference.name),
                        ),
                      ),
                  ]),
                ];
              await discoverDefinition(name, expected);
            }
          }
          for (const anchor of forwardAnchors.values())
            if (
              !ownerAnchors.some(
                (owner) => owner.name === anchor.name && owner.namespace === anchor.namespace,
              )
            )
              await query("reference", [anchor.name], true, [anchor]);
          await query("reference", [...ownerNames], false, ownerAnchors);
          const referencePaths = new Map<string, boolean>();
          for (const query of queries.filter((query) => query.kind === "reference"))
            for (const path of query.paths)
              referencePaths.set(path, (referencePaths.get(path) ?? false) || query.forward);
          const allNames = [...new Set([...ownerNames, ...forwardNames])];
          const ranked = [...referencePaths.keys()].sort(
            (a, b) => rankPath(b, allNames) - rankPath(a, allNames) || (a < b ? -1 : a > b ? 1 : 0),
          );
          const optional: Array<{ entry: Scanned; forward: boolean; score: number }> = [];
          for (const path of ranked) {
            if (
              !retainCatalog(path, "optional_candidate_unselected") ||
              required.has(path) ||
              selected.has(path)
            )
              continue;
            const entry = await scan(path, false);
            if (!entry) continue;
            const code: string[] =
              sourceLexicalCode(entry.file.content, path).match(
                /[A-Za-z_][A-Za-z0-9_]*|::|[^\s]/gu,
              ) ?? [];
            let retained = false;
            let forwardRetained = false;
            for (const candidateQuery of queries.filter(
              (query) => query.kind === "reference" && query.paths.includes(path),
            )) {
              const classification = classifySourceIdentityMatches(
                entry.identity,
                candidateQuery.anchors,
              );
              if (classification.retain) {
                retained = true;
                forwardRetained ||= candidateQuery.forward;
              } else if (classification.reason) deferred.set(path, classification.reason);
            }
            if (!retained) continue;
            let constructors = 0;
            let ownerConstructors = 0;
            const members = new Set<string>();
            for (let index = 0; index < code.length; index++) {
              if (code[index] === "new") {
                let end = index + 1;
                while ([".", "::"].includes(code[end + 1] ?? "")) end += 2;
                if (code[end + 1] === "(" && allNames.includes(code[end]!)) constructors++;
                if (code[end + 1] === "(" && ownerNames.has(code[end]!)) ownerConstructors++;
              }
              if (code[index - 1] === "." && memberNames.has(code[index]!))
                members.add(code[index]!);
            }
            const parts = path.split("/");
            const name = parts.pop()!.replace(/\.[^.]+$/u, "");
            let common = 0;
            for (const seed of seedPaths) {
              const directories = seed.split("/").slice(0, -1);
              let length = 0;
              while (
                length < Math.min(parts.length, directories.length) &&
                parts[length] === directories[length]
              )
                length++;
              common = Math.max(common, length);
            }
            optional.push({
              entry,
              forward: forwardRetained && ownerConstructors === 0,
              score:
                (forwardRetained ? 10000 : 0) +
                common * 1000 +
                allNames.filter((symbol) => name.includes(symbol)).length * 1000 +
                Math.min(constructors, 3) * 100 +
                Math.min(members.size, 8) * 20,
            });
          }
          optional.sort(
            (a, b) =>
              b.score - a.score ||
              (a.entry.file.path < b.entry.file.path
                ? -1
                : a.entry.file.path > b.entry.file.path
                  ? 1
                  : 0),
          );
          let optionalBytes = 0;
          let optionalCount = 0;
          let forwardCount = 0;
          let ownerCount = 0;
          for (const candidate of optional) {
            const entry = candidate.entry;
            if (
              optionalCount >= limits.maximumOptionalFiles ||
              optionalBytes + entry.byteLength > limits.maximumOptionalBytes ||
              (candidate.forward
                ? forwardCount >= limits.maximumForwardOptionalFiles
                : ownerCount >= limits.maximumOwnerOptionalFiles)
            ) {
              deferred.set(entry.file.path, "optional_context_budget");
              continue;
            }
            if (include(entry)) {
              optionalCount++;
              optionalBytes += entry.byteLength;
              if (candidate.forward) forwardCount++;
              else ownerCount++;
            }
          }
          const omittedCandidateCount = [...allCandidates].filter(
            (path) => !catalog.has(path),
          ).length;
          result = {
            sourceSha,
            seedPaths,
            requiredFiles: seedPaths.map((path) => required.get(path)!),
            contextFiles: [...selected.values()].sort((a, b) =>
              a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
            ),
            queries: queries.map((query) => {
              const paths = query.paths.filter((path) => catalog.has(path));
              return {
                kind: query.kind,
                revisionSha: sourceSha,
                symbols: query.symbols,
                paths,
                matchedPathCount: query.paths.length,
                omittedPathCount: query.paths.length - paths.length,
              };
            }),
            deferred: [...deferred.entries()]
              .filter(([path]) => catalog.has(path) && !required.has(path) && !selected.has(path))
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([path, reason]) => ({ path, reason })),
            identityScanFiles: scanned.size,
            identityScanBytes,
            catalogComplete: omittedCandidateCount === 0,
            omittedCandidateCount,
            ...(queryBudgetExhausted ? { queryBudgetExhausted: true as const } : {}),
          };
          if (Buffer.byteLength(JSON.stringify(result), "utf8") > limits.maximumIdentityScanBytes)
            throw dependencyLimit(
              "The complete source context metadata exceeds its explicit output budget.",
            );
        }
      } finally {
        await assertBinding();
      }
      sourceContextCache.set(cacheKey, result);
      return structuredClone(result);
    };

    await assertBinding();
    return {
      binding: {
        subjectRef: subject.id,
        revisionKey: subject.revisionKey,
        sourceSha,
        patchDigest: subject.kind === "local_patch" ? subject.patchDigest : null,
        artifactRef: subject.kind === "local_patch" ? subject.artifactRef : null,
        ...(inertSymlinks.size === 0
          ? {}
          : {
              inertSymlinks: Object.freeze(
                [...inertSymlinks.values()]
                  .sort((left, right) => {
                    const leftKey = `${left.revisionSha}\0${left.path}`;
                    const rightKey = `${right.revisionSha}\0${right.path}`;
                    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
                  })
                  .map((entry) => Object.freeze(entry)),
              ),
            }),
      },
      assertBinding,
      ...(originalPatch === null ? { assertReadBinding } : {}),
      capturePatch: async (signal) => {
        await assertCurrentTree();
        return capture(signal);
      },
      async readPrDiffManifest() {
        await assertReadBinding();
        const manifest = structuredClone((await getPrDiff()).manifest);
        await assertReadBinding();
        return manifest;
      },
      async readPrDiffChunk(id) {
        const chunks = await readPrDiffChunks([id]);
        return chunks[0]!;
      },
      readPrDiffChunks,
      readSourceDependencies,
      readSourceContext,
    };
  }

  async #assertPath(path: string, kind: "file" | "directory"): Promise<void> {
    assertWindowsLocalAbsolutePath(path, "investigation source path", false);
    const root = win32.parse(path).root;
    let current = root;
    const parts = win32.relative(root, path).split("\\").filter(Boolean);
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = win32.join(current, parts[index]!);
      const state = await this.#fs.lstat(current);
      const expected = index === parts.length - 1 ? kind : "directory";
      if (
        state === null ||
        state.kind !== expected ||
        state.reparsePoint ||
        (state.kind === "file" && state.linkCount !== 1) ||
        key(await this.#fs.realpath(current)) !== key(current)
      )
        throw failure(
          "SOURCE_PATH_UNSAFE",
          "A source path is not an ordinary owned filesystem entry.",
        );
    }
  }

  async #assertTree(root: string, trackedPaths?: ReadonlySet<string>): Promise<void> {
    await this.#assertPath(root, "directory");
    const pending = [root];
    let entries = 0;
    const files: OwnedHardlinkEntry[] = [];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const name of await this.#fs.readDirectory(directory)) {
        if (++entries > (this.#options.maximumTreeEntries ?? 250_000))
          throw failure(
            "SOURCE_TREE_TOO_LARGE",
            "The complete source tree exceeds its explicit entry budget.",
          );
        if (!name || name === "." || name === ".." || /[\\/:]/u.test(name))
          throw failure("SOURCE_PATH_UNSAFE", "A source tree entry has an unsafe path component.");
        const path = win32.join(directory, name);
        assertWindowsLocalAbsolutePath(path, "investigation source tree path", false);
        const state = await this.#fs.lstat(path);
        if (
          (state?.kind !== "file" && state?.kind !== "directory") ||
          state.reparsePoint ||
          (state.kind === "file" && state.linkCount !== 1 && trackedPaths === undefined) ||
          key(await this.#fs.realpath(path)) !== key(path)
        )
          throw failure(
            "SOURCE_PATH_UNSAFE",
            "A source tree entry is not a regular file or directory.",
          );
        if (state.kind === "directory") pending.push(path);
        else files.push({ path, state });
      }
    }
    try {
      validateOwnedHardlinkGroups(
        files,
        (path) =>
          trackedPaths !== undefined &&
          !trackedPaths.has(key(path)) &&
          !win32
            .relative(root, path)
            .split("\\")
            .some((part) => part.toLowerCase() === ".git"),
      );
    } catch (error) {
      if (error instanceof OwnedHardlinkError) throw failure("SOURCE_PATH_UNSAFE", error.message);
      throw error;
    }
    await this.#assertPath(root, "directory");
  }

  #assertGitTree(bytes: Uint8Array, allowInertSymlinks = false): readonly GitSourceTreeEntry[] {
    const text = decode(bytes);
    if (text.length > 0 && !text.endsWith("\0"))
      throw failure("SOURCE_TREE_INVALID", "The Git tree listing is incomplete.");
    const paths = new Map<string, string>();
    const entries: GitSourceTreeEntry[] = [];
    const records = text.split("\0").filter(Boolean);
    if (records.length > (this.#options.maximumTreeEntries ?? 250_000))
      throw failure(
        "SOURCE_TREE_TOO_LARGE",
        "The complete Git tree exceeds its explicit entry budget.",
      );
    for (const record of records) {
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([^\0]+)$/u.exec(record);
      if (match === null || (match[1] === "120000" && !allowInertSymlinks))
        throw failure(
          "SOURCE_TREE_UNSUPPORTED",
          "Git symlinks require an original checkout with verified inert target-text representation; patched link representations, submodules, and other non-regular entries are unsupported.",
        );
      const path = match[3]!;
      entries.push({ path, mode: match[1] as GitSourceTreeEntry["mode"], blobId: match[2]! });
      const segments = path.split("/");
      for (let length = 1; length <= segments.length; length++) {
        const segment = segments[length - 1]!;
        if (
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.toLowerCase() === ".git" ||
          /[\\:]/u.test(segment)
        )
          throw failure("SOURCE_PATH_UNSAFE", "The Git tree contains an unsafe Windows path.");
        const prefix = segments.slice(0, length).join("/");
        assertWindowsLocalAbsolutePath(
          `C:\\source\\${prefix.replaceAll("/", "\\")}`,
          "Git tree path",
          false,
        );
        const previous = paths.get(prefix.toLowerCase());
        if (previous !== undefined && previous !== prefix)
          throw failure("SOURCE_PATH_UNSAFE", "The Git tree has paths that collide on Windows.");
        paths.set(prefix.toLowerCase(), prefix);
      }
    }
    return entries;
  }
}

export class ProductionInvestigationGitCommandRunner implements InvestigationGitCommandRunner {
  public async run(
    spec: ProcessLaunchSpec,
    context: InvestigationWorkspaceContext,
  ): Promise<InvestigationGitCommandResult> {
    context.signal.throwIfAborted();
    let process: Awaited<ReturnType<InvestigationWorkspaceContext["processHost"]["start"]>>;
    try {
      process = await context.processHost.start(spec, context.signal);
    } catch {
      throw failure(
        "SOURCE_PROCESS_CLEANUP_UNCONFIRMED",
        "Source startup did not establish a managed process identity and confirmed closure.",
      );
    }
    let remaining = spec.limits.maximumOutputBytes;
    let exceeded = false;
    const drain = async (stream: Readable, retain: boolean): Promise<Uint8Array> => {
      const chunks: Buffer[] = [];
      for await (const raw of stream) {
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        const count = Math.min(remaining, bytes.byteLength);
        if (count < bytes.byteLength) exceeded = true;
        remaining -= count;
        if (retain && count > 0) chunks.push(Buffer.from(bytes.subarray(0, count)));
      }
      return Buffer.concat(chunks);
    };
    const [exit, stdout, stderr] = await Promise.allSettled([
      process.completed,
      drain(process.stdout, true),
      drain(process.stderr, false),
    ]);
    if (
      exit.status !== "fulfilled" ||
      stdout.status !== "fulfilled" ||
      stderr.status !== "fulfilled"
    )
      throw failure(
        "SOURCE_PROCESS_CLEANUP_UNCONFIRMED",
        "The source process and its output streams did not confirm complete settlement.",
      );
    context.signal.throwIfAborted();
    if (exceeded || exit.value.outputTruncated)
      throw failure(
        "SOURCE_OUTPUT_TOO_LARGE",
        "The source operation exceeded its complete-output budget; no truncated source was accepted.",
      );
    if (exit.value.signal !== null || exit.value.exitCode === null)
      throw failure(
        "SOURCE_GIT_FAILED",
        "The managed source operation terminated without a normal exit.",
      );
    return { exitCode: exit.value.exitCode, stdout: stdout.value };
  }
}

export function assertCanonicalRepository(value: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) ||
    value.length > 256 ||
    value.split("/").some((part) => part.endsWith(".") || part.toLowerCase().endsWith(".git"))
  )
    throw failure(
      "SOURCE_REPOSITORY_NOT_ALLOWED",
      "Public GitHub sources require an allowlisted canonical owner/repository name.",
    );
}
function assertSha(value: string): void {
  if (!/^[a-f0-9]{40}$/u.test(value))
    throw failure("SOURCE_BINDING_MISMATCH", "Source identity must be one exact Git commit SHA.");
}
function isDependencySourcePath(path: string): boolean {
  return dependencySourceExtensions.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());
}
function dependencyLimit(message: string): InvestigationGitSourceError {
  return failure("SOURCE_DEPENDENCY_LIMIT_EXCEEDED", `${message} No source was silently omitted.`);
}

function isXamlSourcePath(path: string): boolean {
  return path.toLowerCase().endsWith(".xaml");
}

/** Read only explicit managed XML namespace/type spellings, without XML resource loading. */
function xamlSourceTypeReferences(content: string): readonly SourceAnchorIdentity[] | null {
  type BindingChange = { prefix: string; previous: string | null | undefined; existed: boolean };
  type Frame = { name: string; changes: BindingChange[] };
  const frames: Frame[] = [];
  const bindings = new Map<string, string | null>([["xml", null]]);
  const references: SourceAnchorIdentity[] = [];
  const seenNames = new Map<string, Set<string>>();
  let cursor = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  const prologueStart = cursor;
  let rootSeen = false;
  let rootClosed = false;
  const namePattern = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
  const qnamePattern = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/u;
  const skipSpace = () => {
    while (cursor < content.length && /[\t\n\r ]/u.test(content[cursor]!)) cursor++;
  };
  const readName = (): string | null => {
    namePattern.lastIndex = cursor;
    const match = namePattern.exec(content);
    if (match === null || !qnamePattern.test(match[0])) return null;
    cursor = namePattern.lastIndex;
    return match[0];
  };
  const managedNamespace = (value: string): string | null => {
    // Entity-dependent namespace identities and assembly-qualified mappings remain unknown.
    // Ordinary attribute/text entities are never interpreted and do not invalidate a mapping.
    const match =
      /^(?:using:|clr-namespace:)([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/u.exec(
        value,
      );
    if (match === null) return null;
    const namespace = match[1]!.replaceAll(".", "::");
    // Match the existing bounded source identity metadata rather than emitting invalid keys.
    return namespace.length <= 2048 ? namespace : null;
  };
  const restore = (changes: readonly BindingChange[]) => {
    for (let index = changes.length - 1; index >= 0; index--) {
      const change = changes[index]!;
      if (change.existed) bindings.set(change.prefix, change.previous ?? null);
      else bindings.delete(change.prefix);
    }
  };
  while (cursor < content.length) {
    if (content[cursor] !== "<") {
      const next = content.indexOf("<", cursor);
      const end = next < 0 ? content.length : next;
      if (frames.length === 0 && !/^[\t\n\r ]*$/u.test(content.slice(cursor, end))) return null;
      cursor = end;
      continue;
    }
    if (content.startsWith("<!--", cursor)) {
      const end = content.indexOf("-->", cursor + 4);
      const text = content.slice(cursor + 4, end);
      if (end < 0 || text.includes("--") || text.endsWith("-")) return null;
      cursor = end + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", cursor)) {
      if (frames.length === 0) return null;
      const end = content.indexOf("]]>", cursor + 9);
      if (end < 0) return null;
      cursor = end + 3;
      continue;
    }
    if (content.startsWith("<?", cursor)) {
      const instructionStart = cursor;
      cursor += 2;
      const target = readName();
      if (
        target === null ||
        (!/[\t\n\r ]/u.test(content[cursor] ?? "") && !content.startsWith("?>", cursor))
      )
        return null;
      if (
        target.toLowerCase() === "xml" &&
        (target !== "xml" || instructionStart !== prologueStart)
      )
        return null;
      const end = content.indexOf("?>", cursor);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }
    // Never parse a DTD, resolve entities, or infer types from unknown declarations.
    if (content.startsWith("<!", cursor)) return null;
    cursor++;
    if (content[cursor] === "/") {
      cursor++;
      const name = readName();
      skipSpace();
      const frame = frames.pop();
      if (name === null || frame === undefined || frame.name !== name || content[cursor] !== ">")
        return null;
      cursor++;
      restore(frame.changes);
      if (frames.length === 0) rootClosed = true;
      continue;
    }
    if (rootClosed) return null;
    const name = readName();
    if (name === null) return null;
    const attributes = new Set<string>();
    const declarations: Array<{ prefix: string; value: string }> = [];
    let selfClosing = false;
    let terminated = false;
    while (cursor < content.length) {
      const beforeSpace = cursor;
      skipSpace();
      if (content[cursor] === ">") {
        cursor++;
        terminated = true;
        break;
      }
      if (content.startsWith("/>", cursor)) {
        cursor += 2;
        selfClosing = true;
        terminated = true;
        break;
      }
      if (cursor === beforeSpace) return null;
      const attribute = readName();
      if (attribute === null || attributes.has(attribute)) return null;
      attributes.add(attribute);
      skipSpace();
      if (content[cursor] !== "=") return null;
      cursor++;
      skipSpace();
      const quote = content[cursor];
      if (quote !== "'" && quote !== '"') return null;
      const end = content.indexOf(quote, ++cursor);
      if (end < 0) return null;
      const value = content.slice(cursor, end);
      if (value.includes("<")) return null;
      cursor = end + 1;
      if (attribute === "xmlns" || attribute.startsWith("xmlns:")) {
        const prefix = attribute === "xmlns" ? "" : attribute.slice(6);
        if (
          prefix === "xmlns" ||
          (prefix === "xml" && value !== "http://www.w3.org/XML/1998/namespace")
        )
          return null;
        declarations.push({ prefix, value });
      }
    }
    if (!terminated) return null;
    const changes: BindingChange[] = [];
    for (const declaration of declarations) {
      changes.push({
        prefix: declaration.prefix,
        previous: bindings.get(declaration.prefix),
        existed: bindings.has(declaration.prefix),
      });
      bindings.set(declaration.prefix, managedNamespace(declaration.value));
    }
    for (const attribute of attributes) {
      if (attribute === "xmlns" || attribute.startsWith("xmlns:")) continue;
      const separator = attribute.indexOf(":");
      if (separator >= 0 && !bindings.has(attribute.slice(0, separator))) return null;
    }
    if (frames.length === 0) {
      if (rootSeen) return null;
      rootSeen = true;
    }
    const colon = name.indexOf(":");
    const prefix = colon < 0 ? "" : name.slice(0, colon);
    const localName = colon < 0 ? name : name.slice(colon + 1);
    const namespace = bindings.get(prefix);
    if (colon >= 0 && !bindings.has(prefix)) return null;
    // A property element names its owner type, not a type named after the property.
    const typeName = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u.exec(
      localName,
    )?.[1];
    if (
      namespace !== undefined &&
      namespace !== null &&
      typeName !== undefined &&
      typeName.length <= 128
    ) {
      const names = seenNames.get(namespace) ?? new Set<string>();
      if (!names.has(typeName)) {
        names.add(typeName);
        seenNames.set(namespace, names);
        references.push({ name: typeName, namespace });
      }
    }
    if (selfClosing) {
      restore(changes);
      if (frames.length === 0) rootClosed = true;
    } else frames.push({ name, changes });
  }
  // No partial discovery survives a malformed suffix or an unterminated element.
  return rootSeen && rootClosed && frames.length === 0 ? references : null;
}

/** Extract lexical type positions without interpreting prose or claiming compiler resolution. */
function sourceContextTypePositions(
  content: string,
  path: string,
): {
  candidates: readonly { name: string; index: number }[];
  members: readonly string[];
} {
  const tokens: string[] =
    sourceLexicalCode(content, path).match(/[A-Za-z_][A-Za-z0-9_]*|::|[^\s]/gu) ?? [];
  const identifier = (token: string | undefined): token is string =>
    token !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(token);
  const candidates = new Map<number, { name: string; index: number }>();
  const members = new Set<string>();
  const add = (index: number) => {
    const name = tokens[index];
    if (name && /^[A-Z][A-Za-z0-9_]+$/u.test(name)) candidates.set(index, { name, index });
  };
  for (let start = 0; start < tokens.length; start++) {
    if (
      !identifier(tokens[start]) ||
      [".", "::"].includes(tokens[start - 1] ?? "") ||
      ["class", "struct", "enum", "interface", "record", "namespace", "using"].includes(
        tokens[start - 1] ?? "",
      )
    )
      continue;
    let end = start + 1;
    let nameIndex = start;
    while ([".", "::"].includes(tokens[end] ?? "") && identifier(tokens[end + 1])) {
      nameIndex = end + 1;
      end += 2;
    }
    const generic: number[] = [];
    if (tokens[end] === "<") {
      let depth = 1;
      end++;
      while (end < tokens.length && depth > 0 && ![";", "{", "}"].includes(tokens[end]!)) {
        if (tokens[end] === "<") depth++;
        else if (tokens[end] === ">") depth--;
        else if (identifier(tokens[end]) && ![".", "::"].includes(tokens[end + 1] ?? ""))
          generic.push(end);
        end++;
      }
      if (depth !== 0) continue;
    }
    if (tokens[end] === "?") end++;
    while (tokens[end] === "[" && tokens[end + 1] === "]") end += 2;
    let typed = tokens[start - 1] === "new" && ["(", "[", "{"].includes(tokens[end] ?? "");
    typed ||=
      tokens[start - 1] === "(" &&
      ["typeof", "default", "sizeof"].includes(tokens[start - 2] ?? "") &&
      tokens[end] === ")";
    if (identifier(tokens[end]) && ["=", ";", ",", ")", "{", "("].includes(tokens[end + 1] ?? "")) {
      typed = true;
      members.add(tokens[end]!);
    } else if (
      [":", ","].includes(tokens[start - 1] ?? "") &&
      ["{", ","].includes(tokens[end] ?? "")
    ) {
      const before = tokens.slice(Math.max(0, start - 128), start);
      const boundary = Math.max(
        before.lastIndexOf("{"),
        before.lastIndexOf("}"),
        before.lastIndexOf(";"),
      );
      typed ||= before
        .slice(boundary + 1)
        .some((token) => ["class", "struct", "interface", "record"].includes(token));
    }
    if (typed) {
      add(nameIndex);
      for (const index of generic) add(index);
    }
  }
  return { candidates: [...candidates.values()], members: [...members].sort() };
}

type SourceAnchorIdentity = { name: string; namespace: string };

interface SourceIdentityAlias {
  name: string;
  targetNamespace: string;
  targetName: string;
  namespace: string;
  scope: number;
  index: number;
  kind: "alias" | "namespace" | "import";
  uncertain: boolean;
}

interface SourceIdentityReference {
  name: string;
  namespace: string;
  qualifier: string | null;
  absolute: boolean;
  scope: number;
  index: number;
  declaration: boolean;
  uncertain: boolean;
}

interface SourceIdentityInfo {
  anchors: readonly SourceAnchorIdentity[];
  aliases: readonly SourceIdentityAlias[];
  declarations: readonly SourceAnchorIdentity[];
  references: readonly SourceIdentityReference[];
  imports: readonly { namespace: string; context: string; scope: number; index: number }[];
  scopes: readonly { parent: number | null; end: number }[];
  rawSymbols: readonly string[];
  lexicalSymbols: readonly string[];
  metadataSymbols: readonly string[];
  uncertain: boolean;
  language: "cpp" | "csharp" | "other";
}

/** This metadata is a conservative lexical identity approximation, not compiler resolution. */
function sourceIdentityInfo(content: string, path: string): SourceIdentityInfo {
  if (isXamlSourcePath(path))
    return {
      anchors: [],
      aliases: [],
      declarations: [],
      references: [],
      imports: [],
      scopes: [{ parent: null, end: 0 }],
      rawSymbols: [...new Set(content.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [])].sort(),
      lexicalSymbols: [],
      metadataSymbols: [],
      uncertain: true,
      language: "other",
    };
  const tokens: string[] =
    sourceLexicalCode(content, path).match(/[A-Za-z_][A-Za-z0-9_]*|::|[^\s]/gu) ?? [];
  const identifier = (value: string | undefined): value is string =>
    value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const language: SourceIdentityInfo["language"] = ["cs", "csx"].includes(extension)
    ? "csharp"
    : [
          "c",
          "cc",
          "cpp",
          "cxx",
          "h",
          "hh",
          "hpp",
          "hxx",
          "inl",
          "ipp",
          "tpp",
          "ixx",
          "cppm",
          "cu",
          "cuh",
          "m",
          "mm",
        ].includes(extension)
      ? "cpp"
      : "other";
  const pairs = new Map<number, number>();
  const openings: Array<{ token: string; index: number }> = [];
  let uncertain =
    language === "other" || (language === "csharp" && /\$(?:@)?"|@\$"/u.test(content));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (["(", "[", "{"].includes(token)) openings.push({ token, index });
    else if ([")", "]", "}"].includes(token)) {
      const opening = openings.pop();
      const expected: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      if (opening === undefined || opening.token !== expected[token]) uncertain = true;
      else pairs.set(opening.index, index);
    }
  }
  if (openings.length > 0) uncertain = true;
  const metadata = new Set<number>();
  const declarationTokens = new Set<number>();
  const anchors: SourceAnchorIdentity[] = [];
  const declarations: SourceAnchorIdentity[] = [];
  const unresolvedTypeInheritance = new Map<string, boolean>();
  const aliases: SourceIdentityAlias[] = [];
  const imports: Array<{ namespace: string; context: string; scope: number; index: number }> = [];
  type Context = { namespace: string; scope: number; uncertain: boolean };
  const contexts: Context[] = [];
  const scopes: Array<{ parent: number | null; end: number }> = [
    { parent: null, end: tokens.length },
  ];
  const stack: Context[] = [{ namespace: "", scope: 0, uncertain: false }];
  const pending = new Map<number, { namespace: string; uncertain: boolean }>();
  const join = (left: string, right: string): string =>
    left && right ? `${left}::${right}` : left || right;
  const qualified = (start: number, end: number): { name: string; absolute: boolean } | null => {
    let absolute = false;
    if (tokens[start] === "global" && tokens[start + 1] === "::") {
      start += 2;
      absolute = true;
    } else if (tokens[start] === "::") {
      start++;
      absolute = true;
    }
    const parts: string[] = [];
    for (let index = start; index < end; index++) {
      if ((index - start) % 2 === 0) {
        if (!identifier(tokens[index])) return null;
        parts.push(tokens[index]!);
      } else if (tokens[index] !== "::" && tokens[index] !== ".") return null;
    }
    return parts.length > 0 && (end - start) % 2 === 1
      ? { name: parts.join("::"), absolute }
      : null;
  };
  const splitIdentity = (name: string): SourceAnchorIdentity => {
    const parts = name.split("::");
    return { name: parts.pop()!, namespace: parts.join("::") };
  };
  const resolveDefinition = (name: string, context: string, absolute: boolean): string =>
    absolute || !context || name === context || name.startsWith(`${context.split("::")[0]}::`)
      ? name
      : join(context, name);
  const mask = (start: number, end: number): void => {
    for (let index = start; index <= end; index++) metadata.add(index);
  };
  const statementEnd = (start: number): number => {
    for (let index = start; index < tokens.length; index++) {
      if (tokens[index] === ";") return index;
      if (tokens[index] === "{" || tokens[index] === "}") return -1;
    }
    return -1;
  };
  const addAlias = (
    name: string,
    target: ReturnType<typeof qualified>,
    context: Context,
    index: number,
    kind: SourceIdentityAlias["kind"],
  ): void => {
    const identity = splitIdentity(target?.name ?? "");
    aliases.push({
      name,
      targetNamespace: identity.namespace,
      targetName: identity.name,
      namespace: target?.absolute ? "" : context.namespace,
      scope: context.scope,
      index,
      kind,
      uncertain: target === null || context.uncertain,
    });
  };
  for (let index = 0; index < tokens.length; index++) {
    const current = stack[stack.length - 1]!;
    contexts[index] = { ...current };
    const token = tokens[index]!;
    if (token === "namespace" && tokens[index - 1] !== "using") {
      let end = index + 1;
      while (end < tokens.length && !["{", ";", "=", "}"].includes(tokens[end]!)) end++;
      const name = qualified(index + 1, end);
      if (tokens[end] === "=" && identifier(tokens[index + 1]) && end === index + 2) {
        const finish = statementEnd(end + 1);
        if (finish >= 0) {
          addAlias(tokens[index + 1]!, qualified(end + 1, finish), current, index, "namespace");
          mask(index, finish);
        }
      } else if (tokens[end] === "{" && (name !== null || end === index + 1)) {
        pending.set(end, {
          namespace: name === null ? current.namespace : join(current.namespace, name.name),
          uncertain: current.uncertain || name === null,
        });
        mask(index, end - 1);
      } else if (tokens[end] === ";" && name !== null && language === "csharp") {
        mask(index, end);
        current.namespace = join(current.namespace, name.name);
      } else uncertain = true;
    }
    if (token === "using" && tokens[index + 1] !== "(" && tokens[index + 1] !== "var") {
      if (language === "csharp" && tokens[index + 1] === "static") uncertain = true;
      const end = statementEnd(index + 1);
      if (end >= 0) {
        let start = index + 1;
        if (tokens[start] === "namespace" || tokens[start] === "static") start++;
        if (identifier(tokens[start]) && tokens[start + 1] === "=") {
          addAlias(tokens[start]!, qualified(start + 2, end), current, index, "alias");
          mask(tokens[index - 1] === "global" ? index - 1 : index, end);
        } else {
          const target = qualified(start, end);
          if (target !== null) {
            if (language === "cpp" && tokens[index + 1] !== "namespace") {
              addAlias(splitIdentity(target.name).name, target, current, index, "import");
            } else
              imports.push({
                namespace: target.name,
                context: target.absolute ? "" : current.namespace,
                scope: current.scope,
                index,
              });
            mask(tokens[index - 1] === "global" ? index - 1 : index, end);
          }
        }
      }
    }
    if (token === "typedef") {
      const end = statementEnd(index + 1);
      if (end >= 0 && identifier(tokens[end - 1])) {
        const target = qualified(index + 1, end - 1);
        if (target !== null) {
          addAlias(tokens[end - 1]!, target, current, index, "alias");
          mask(index, end);
        }
      }
    }
    if (
      ["class", "struct", "interface", "record", "enum"].includes(token) &&
      !metadata.has(index) &&
      !(["class", "struct"].includes(token) && ["record", "enum"].includes(tokens[index - 1] ?? ""))
    ) {
      let nameIndex = index + 1;
      if (
        ["record", "enum"].includes(token) &&
        ["class", "struct"].includes(tokens[nameIndex] ?? "")
      )
        nameIndex++;
      const name = tokens[nameIndex];
      const next = tokens[nameIndex + 1];
      if (
        identifier(name) &&
        [
          "{",
          ":",
          ";",
          "<",
          "where",
          "final",
          "sealed",
          ...(token === "record" ? ["("] : []),
        ].includes(next ?? "")
      ) {
        let boundary = nameIndex + 1;
        while (boundary < tokens.length && !["{", ";", "}"].includes(tokens[boundary]!)) {
          if (tokens[boundary] === "(" || tokens[boundary] === "[") {
            const end = pairs.get(boundary);
            if (end === undefined) break;
            boundary = end;
          }
          boundary++;
        }
        if (tokens[boundary] === "{" || tokens[boundary] === ";") {
          const identity = { name, namespace: current.namespace };
          declarations.push(identity);
          declarationTokens.add(nameIndex);
          if (tokens[boundary] === "{") {
            anchors.push(identity);
            // Base-class aliases and members require compiler lookup; do not resolve them as foreign imports.
            const inheritedContext =
              token !== "enum" && tokens.slice(nameIndex + 1, boundary).includes(":");
            unresolvedTypeInheritance.set(join(current.namespace, name), inheritedContext);
            pending.set(boundary, {
              namespace: join(current.namespace, name),
              uncertain: current.uncertain || inheritedContext,
            });
            const namespaceParts = current.namespace.split("::");
            if (
              language === "cpp" &&
              namespaceParts[0] === "winrt" &&
              namespaceParts.length > 2 &&
              ["implementation", "factory_implementation"].includes(namespaceParts.at(-1) ?? "")
            ) {
              const colon = tokens.indexOf(":", nameIndex + 1);
              if (colon > nameIndex && colon < boundary) {
                let baseDepth = 0;
                for (let base = colon + 1; base + 3 < boundary; base++) {
                  if (tokens[base] === "(") {
                    const end = pairs.get(base);
                    if (end === undefined) break;
                    base = end;
                    continue;
                  }
                  if (tokens[base] === "<") baseDepth++;
                  else if (tokens[base] === ">") baseDepth--;
                  if (
                    baseDepth === 0 &&
                    tokens[base] === `${name}T` &&
                    tokens[base + 1] === "<" &&
                    tokens[base + 2] === name &&
                    [",", ">"].includes(tokens[base + 3]!)
                  ) {
                    const projected = namespaceParts.slice(0, -1);
                    anchors.push({ name, namespace: projected.join("::") });
                    if (projected[0] === "winrt" && projected.length > 1)
                      anchors.push({ name, namespace: projected.slice(1).join("::") });
                    break;
                  }
                }
              }
            }
          }
        } else uncertain = true;
      }
    }
    if (language === "cpp" && token === "::" && !metadata.has(index)) {
      let method = index + 1;
      if (tokens[method] === "~") method++;
      const close = pairs.get(method + 1);
      if (
        identifier(tokens[method]) &&
        tokens[method + 1] === "(" &&
        close !== undefined &&
        [
          "{",
          ":",
          "const",
          "volatile",
          "noexcept",
          "override",
          "final",
          "&",
          "-",
          "requires",
        ].includes(tokens[close + 1] ?? "")
      ) {
        let body = -1;
        const initializer = tokens[close + 1] === ":";
        for (let suffix = close + 1; suffix < tokens.length; suffix++) {
          if (tokens[suffix] === "{") {
            body = suffix;
            break;
          }
          if (
            [";", "=", "}", ")", "]"].includes(tokens[suffix]!) ||
            (tokens[suffix] === "," && !initializer)
          )
            break;
          if (tokens[suffix] === "(") {
            const end = pairs.get(suffix);
            if (end === undefined) break;
            suffix = end;
          }
        }
        let owner = index - 1;
        if (tokens[owner] === ">") {
          let depth = 1;
          while (--owner >= 0 && depth > 0) {
            if (tokens[owner] === ">") depth++;
            else if (tokens[owner] === "<") depth--;
          }
        }
        if (body >= 0 && identifier(tokens[owner])) {
          let start = owner;
          while (tokens[start - 1] === "::" && identifier(tokens[start - 2])) start -= 2;
          if (tokens[start - 1] === "::") start--;
          const ownerName = qualified(start, owner + 1);
          if (ownerName !== null) {
            const identity = splitIdentity(
              resolveDefinition(ownerName.name, current.namespace, ownerName.absolute),
            );
            anchors.push(identity);
            declarations.push(identity);
            declarationTokens.add(owner);
            const ownerScope = join(identity.namespace, identity.name);
            pending.set(body, {
              namespace: ownerScope,
              uncertain: current.uncertain || unresolvedTypeInheritance.get(ownerScope) !== false,
            });
          }
        }
      }
    }
    if (token === "{") {
      const nextScope = scopes.length;
      scopes.push({ parent: current.scope, end: pairs.get(index) ?? tokens.length });
      stack.push({ ...(pending.get(index) ?? current), scope: nextScope });
    } else if (token === "}") {
      if (stack.length > 1) stack.pop();
      else uncertain = true;
    }
  }
  const references: SourceIdentityReference[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const name = tokens[index];
    if (!identifier(name) || metadata.has(index)) continue;
    let start = index;
    while (["::", "."].includes(tokens[start - 1] ?? "") && identifier(tokens[start - 2]))
      start -= 2;
    if (tokens[start - 1] === "::") start--;
    const qualification = start < index ? qualified(start, index + 1) : null;
    const context = contexts[index]!;
    const identity = qualification === null ? null : splitIdentity(qualification.name);
    references.push({
      name,
      namespace: context.namespace,
      qualifier: identity?.namespace ?? null,
      absolute: qualification?.absolute ?? false,
      scope: context.scope,
      index,
      declaration: declarationTokens.has(index),
      uncertain: context.uncertain,
    });
  }
  const identities = (values: readonly SourceAnchorIdentity[]): SourceAnchorIdentity[] => {
    const unique = new Map(values.map((value) => [`${value.namespace}\0${value.name}`, value]));
    return [...unique.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, value]) => value);
  };
  return {
    anchors: identities(anchors),
    aliases,
    declarations: identities(declarations),
    references,
    imports,
    scopes,
    rawSymbols: [...new Set(content.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [])].sort(),
    lexicalSymbols: [...new Set(tokens.filter(identifier))].sort(),
    metadataSymbols: [
      ...new Set([...metadata].map((index) => tokens[index]).filter(identifier)),
    ].sort(),
    uncertain,
    language,
  };
}

function classifySourceIdentityMatches(
  info: SourceIdentityInfo,
  anchors: readonly SourceAnchorIdentity[],
): {
  retain: boolean;
  proven: boolean;
  reason?: "namespace_or_import_only" | "different_type_identity";
  matchedSymbols: string[];
} {
  const names = new Set(anchors.map((anchor) => anchor.name));
  const matchedSymbols = info.rawSymbols.filter((name) => names.has(name)).sort();
  const retain = { retain: true, proven: false, matchedSymbols };
  if (info.uncertain || matchedSymbols.length === 0) return retain;
  const active = (scope: number, index: number, reference: SourceIdentityReference): boolean => {
    if (info.language === "cpp" && index > reference.index) return false;
    let current: number | null = reference.scope;
    while (current !== null) {
      if (current === scope) return true;
      current = info.scopes[current]?.parent ?? null;
    }
    return false;
  };
  const join = (left: string, right: string): string =>
    left && right ? `${left}::${right}` : left || right;
  const ancestorNamespaces = (namespace: string): string[] => {
    const parts = namespace ? namespace.split("::") : [];
    return Array.from({ length: parts.length + 1 }, (_, index) =>
      parts.slice(0, parts.length - index).join("::"),
    );
  };
  const targetSpelling = (anchor: SourceAnchorIdentity): string =>
    join(anchor.namespace, anchor.name);
  const anchorSpellings = new Set(anchors.map(targetSpelling));
  const candidates = (name: string, context: string, absolute = false): string[] =>
    absolute
      ? [name]
      : [...new Set([name, ...ancestorNamespaces(context).map((parent) => join(parent, name))])];
  let actualUse = false;
  let unresolvedUse = false;
  for (const reference of info.references) {
    const direct = names.has(reference.name);
    const usedAliases = info.aliases.filter(
      (alias) => alias.name === reference.name && active(alias.scope, alias.index, reference),
    );
    const qualifierHead = reference.qualifier?.split("::")[0];
    const qualifierAliases =
      qualifierHead === undefined
        ? []
        : info.aliases.filter(
            (alias) => alias.name === qualifierHead && active(alias.scope, alias.index, reference),
          );
    if (usedAliases.some((alias) => alias.uncertain)) return retain;
    if (
      usedAliases.some((alias) =>
        info.aliases.some(
          (target) =>
            target.name === alias.targetName && active(target.scope, target.index, reference),
        ),
      )
    )
      return retain;
    const aliasTargetHit = usedAliases.some((alias) => names.has(alias.targetName));
    if (!direct && !aliasTargetHit && qualifierAliases.length === 0) continue;
    actualUse = true;
    if (reference.uncertain) return retain;
    for (const alias of [...usedAliases, ...qualifierAliases]) {
      if (alias.uncertain) return retain;
      const spelling = join(alias.targetNamespace, alias.targetName);
      const expanded = qualifierAliases.includes(alias)
        ? join(join(spelling, reference.qualifier!.split("::").slice(1).join("::")), reference.name)
        : spelling;
      if (candidates(expanded, alias.namespace).some((candidate) => anchorSpellings.has(candidate)))
        return { ...retain, proven: true };
    }
    if (!direct) continue;
    const sameNameAnchors = anchors.filter((anchor) => anchor.name === reference.name);
    if (reference.qualifier !== null) {
      const spellings = candidates(
        join(reference.qualifier, reference.name),
        reference.namespace,
        reference.absolute,
      );
      if (spellings.some((spelling) => anchorSpellings.has(spelling)))
        return { ...retain, proven: true };
      const foreign = info.declarations.filter(
        (declaration) => declaration.name === reference.name,
      );
      if (!foreign.some((declaration) => spellings.includes(targetSpelling(declaration))))
        unresolvedUse = true;
      continue;
    }
    if (
      sameNameAnchors.some((anchor) =>
        ancestorNamespaces(reference.namespace).includes(anchor.namespace),
      )
    )
      return { ...retain, proven: true };
    for (const imported of info.imports) {
      if (
        active(imported.scope, imported.index, reference) &&
        candidates(imported.namespace, imported.context).some((namespace) =>
          sameNameAnchors.some((anchor) => anchor.namespace === namespace),
        )
      )
        return { ...retain, proven: true };
    }
    const foreign = info.declarations.filter((declaration) => declaration.name === reference.name);
    const foreignContext = foreign.some((declaration) =>
      ancestorNamespaces(reference.namespace).includes(declaration.namespace),
    );
    const foreignImport = info.imports.some(
      (imported) =>
        active(imported.scope, imported.index, reference) &&
        candidates(imported.namespace, imported.context).some((namespace) =>
          foreign.some((declaration) => declaration.namespace === namespace),
        ),
    );
    const foreignAlias = usedAliases.some(
      (alias) =>
        !alias.uncertain &&
        candidates(join(alias.targetNamespace, alias.targetName), alias.namespace).some(
          (spelling) => foreign.some((declaration) => targetSpelling(declaration) === spelling),
        ),
    );
    if (!foreignContext && !foreignImport && !foreignAlias) unresolvedUse = true;
  }
  const lexicalHits = matchedSymbols.filter((name) => info.lexicalSymbols.includes(name));
  if (lexicalHits.length !== matchedSymbols.length) return retain;
  if (!actualUse && lexicalHits.every((name) => info.metadataSymbols.includes(name)))
    return { retain: false, proven: false, reason: "namespace_or_import_only", matchedSymbols };
  if (unresolvedUse) return retain;
  const relevant = info.declarations.filter((declaration) => names.has(declaration.name));
  if (
    relevant.length > 0 &&
    matchedSymbols.every((name) => relevant.some((declaration) => declaration.name === name)) &&
    relevant.every((declaration) => !anchorSpellings.has(targetSpelling(declaration)))
  )
    return { retain: false, proven: false, reason: "different_type_identity", matchedSymbols };
  return retain;
}

/** Remove comments and literal bodies before inspecting declarations; preserve token boundaries. */
function sourceLexicalCode(source: string, path: string): string {
  const parts: string[] = [];
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const hashComments = ["py", "pyi", "rb", "php", "ps1", "psm1"].includes(extension);
  const preprocessor = [
    "c",
    "cc",
    "cpp",
    "cxx",
    "h",
    "hh",
    "hpp",
    "hxx",
    "inl",
    "ipp",
    "tpp",
    "ixx",
    "cppm",
    "cu",
    "cuh",
    "cs",
    "csx",
    "m",
    "mm",
  ].includes(extension);
  let index = 0;
  let start = 0;
  const omit = (end: number) => {
    parts.push(source.slice(start, index), " ");
    index = end;
    start = end;
  };
  while (index < source.length) {
    if (
      source.startsWith("//", index) ||
      (source[index] === "#" &&
        (hashComments ||
          (preprocessor &&
            /^[\t ]*$/u.test(source.slice(source.lastIndexOf("\n", index - 1) + 1, index)))))
    ) {
      const end = source.indexOf("\n", index + 1);
      omit(end === -1 ? source.length : end);
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      omit(end === -1 ? source.length : end + 2);
    } else if (source.startsWith('R"', index)) {
      const opening = /^R"([^\s\\()]{0,16})\(/u.exec(source.slice(index, index + 20));
      if (opening === null) index++;
      else {
        const closing = `)${opening[1]}"`;
        const end = source.indexOf(closing, index + opening[0].length);
        omit(end === -1 ? source.length : end + closing.length);
      }
    } else if (source[index] === '"' || source[index] === "'" || source[index] === "`") {
      const quote = source[index]!;
      if (
        quote === "'" &&
        index > 0 &&
        /[0-9a-fA-F]/u.test(source[index + 1] ?? "") &&
        /\b(?:0[xX][0-9a-fA-F'.]+(?:[pP][+-]?[0-9']*)?|[0-9][0-9'.]*(?:[eE][+-]?[0-9']*)?)$/u.test(
          source.slice(Math.max(0, index - 128), index),
        )
      ) {
        index++;
        continue;
      }
      let count = 1;
      while (source[index + count] === quote) count++;
      if (quote !== "`" && count >= 3) {
        const closing = quote.repeat(count);
        const end = source.indexOf(closing, index + count);
        omit(end === -1 ? source.length : end + count);
        continue;
      }
      const verbatim = quote === '"' && source[index - 1] === "@";
      let end = index + 1;
      while (end < source.length) {
        if (!verbatim && source[end] === "\\") end += 2;
        else if (source[end] === quote) {
          if (verbatim && source[end + 1] === quote) end += 2;
          else {
            end++;
            break;
          }
        } else end++;
      }
      omit(Math.min(end, source.length));
    } else index++;
  }
  parts.push(source.slice(start));
  return parts.join("");
}
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure("SOURCE_TREE_INVALID", "The source metadata is not complete valid UTF-8.");
  }
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function key(path: string): string {
  return win32
    .normalize(path)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}
function failure(code: string, message: string): InvestigationGitSourceError {
  return new InvestigationGitSourceError(code, message);
}
