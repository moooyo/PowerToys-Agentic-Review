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
  type InvestigationPrDiffChunk,
  type InvestigationPrDiffChunkDescriptor,
  type InvestigationPrDiffManifest,
  type InvestigationSourceMaterializer,
  type InvestigationWorkspaceContext,
  type InvestigationWorkspaceFileSystem,
  type InvestigationWorkspaceInput,
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
      if (result.exitCode !== 0)
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
      this.#assertGitTree(await run(["ls-tree", "-r", "-z", "--full-tree", sha]));
    }
    let mergeBase: string | null = null;
    if (baseSha !== null) {
      mergeBase = decode(await run(["merge-base", "--all", baseSha, sourceSha])).trim();
      assertSha(mergeBase);
      this.#assertGitTree(await run(["ls-tree", "-r", "-z", "--full-tree", mergeBase]));
    }
    await run(["checkout", "--quiet", "--detach", "--force", sourceSha]);
    await this.#assertTree(root);
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
      await this.#assertTree(root);
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
    const assertBinding = async () => {
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
        } else if (hash(await capture(context.signal)) !== hash(originalPatch)) {
          throw failure(
            "SOURCE_BINDING_MISMATCH",
            "The verified local patch changed during validation.",
          );
        }
      }
      await assertMetadata();
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
      await assertBinding();
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
              : statusCode === "M"
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
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
      await assertBinding();
      return { manifest, chunks };
    };
    const getPrDiff = () => {
      prDiff ??= preparePrDiff();
      return prDiff;
    };
    await assertBinding();
    return {
      binding: {
        subjectRef: subject.id,
        revisionKey: subject.revisionKey,
        sourceSha,
        patchDigest: subject.kind === "local_patch" ? subject.patchDigest : null,
        artifactRef: subject.kind === "local_patch" ? subject.artifactRef : null,
      },
      assertBinding,
      capturePatch: capture,
      async readPrDiffManifest() {
        await assertBinding();
        return structuredClone((await getPrDiff()).manifest);
      },
      async readPrDiffChunk(id) {
        await assertBinding();
        const chunk = (await getPrDiff()).chunks.get(id);
        if (chunk === undefined)
          throw failure(
            "SOURCE_DIFF_UNAVAILABLE",
            "The requested chunk is absent from the complete frozen PR diff manifest.",
          );
        return structuredClone(chunk);
      },
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

  async #assertTree(root: string): Promise<void> {
    await this.#assertPath(root, "directory");
    const pending = [root];
    let entries = 0;
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
          (state.kind === "file" && state.linkCount !== 1) ||
          key(await this.#fs.realpath(path)) !== key(path)
        )
          throw failure(
            "SOURCE_PATH_UNSAFE",
            "A source tree entry is not a regular file or directory.",
          );
        if (state.kind === "directory") pending.push(path);
      }
    }
    await this.#assertPath(root, "directory");
  }

  #assertGitTree(bytes: Uint8Array): void {
    const text = decode(bytes);
    if (text.length > 0 && !text.endsWith("\0"))
      throw failure("SOURCE_TREE_INVALID", "The Git tree listing is incomplete.");
    const paths = new Map<string, string>();
    const records = text.split("\0").filter(Boolean);
    if (records.length > (this.#options.maximumTreeEntries ?? 250_000))
      throw failure(
        "SOURCE_TREE_TOO_LARGE",
        "The complete Git tree exceeds its explicit entry budget.",
      );
    for (const record of records) {
      const match = /^(100644|100755) blob [a-f0-9]{40}\t([^\0]+)$/u.exec(record);
      if (match === null)
        throw failure(
          "SOURCE_TREE_UNSUPPORTED",
          "Symlinks, submodules, and non-regular Git tree entries are not supported.",
        );
      const path = match[2]!;
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
