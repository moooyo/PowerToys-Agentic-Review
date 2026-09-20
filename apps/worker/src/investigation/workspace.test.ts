import { createHash } from "node:crypto";
import { win32 } from "node:path";
import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationInputSnapshotV1,
  investigationCanonicalJson,
  investigationSourceDigestPayload,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import { ProductionInvestigationGitSourceMaterializer } from "./git-source.js";
import {
  assertInvestigationAttemptWorkspaceAbsent,
  assertInvestigationSourceContext,
  type CleanupOwnedInvestigationAttemptOptions,
  cleanupOwnedInvestigationAttempt,
  type InvestigationPrDiffChunk,
  type InvestigationPrDiffManifest,
  type InvestigationSourceBinding,
  type InvestigationSourceContext,
  type InvestigationSourceDependencies,
  type InvestigationSourceFile,
  type InvestigationSourceMaterializer,
  InvestigationWorkspaceError,
  type InvestigationWorkspaceFileSystem,
  type InvestigationWorkspaceInput,
  type InvestigationWorkspaceOwnershipReceipt,
  type InvestigationWorkspacePathState,
  ProductionInvestigationWorkspaceProvider,
  type ProductionInvestigationWorkspaceProviderOptions,
} from "./workspace.js";

const root = "C:\\investigation-workspaces";

interface FakeEntry extends InvestigationWorkspacePathState {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly readOnly: boolean;
  readonly resolvedPath: string;
}

/** This fixture never touches the filesystem, launches a process, or contacts an upstream service. */
class MemoryFileSystem implements InvestigationWorkspaceFileSystem {
  public readonly entries = new Map<string, FakeEntry>();
  public readonly removed: string[] = [];
  #nextIdentity = 0;

  public constructor() {
    this.add(root, "directory");
  }

  public add(path: string, kind: "file" | "directory", text = ""): void {
    this.entries.set(key(path), {
      path,
      kind,
      bytes: Buffer.from(text),
      reparsePoint: false,
      readOnly: false,
      identity: `identity-${++this.#nextIdentity}`,
      linkCount: 1,
      resolvedPath: path,
    });
  }

  public entry(path: string): FakeEntry {
    const entry = this.entries.get(key(path));
    if (entry === undefined) throw fileError("ENOENT");
    return entry;
  }

  public change(path: string, changes: Partial<FakeEntry>): void {
    this.entries.set(key(path), { ...this.entry(path), ...changes });
  }

  public async lstat(path: string): Promise<InvestigationWorkspacePathState | null> {
    return this.entries.get(key(path)) ?? null;
  }

  public async realpath(path: string): Promise<string> {
    return this.entry(path).resolvedPath;
  }

  public async readDirectory(path: string): Promise<readonly string[]> {
    if (this.entry(path).kind !== "directory") throw fileError("ENOTDIR");
    return [...this.entries.values()]
      .filter(
        (entry) => key(win32.dirname(entry.path)) === key(path) && key(entry.path) !== key(path),
      )
      .map((entry) => win32.basename(entry.path));
  }

  public async createDirectory(path: string): Promise<void> {
    if (this.entries.has(key(path))) throw fileError("EEXIST");
    if (this.entry(win32.dirname(path)).kind !== "directory") throw fileError("ENOTDIR");
    this.add(path, "directory");
  }

  public async writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
    if (this.entries.has(key(path))) throw fileError("EEXIST");
    if (this.entry(win32.dirname(path)).kind !== "directory") throw fileError("ENOTDIR");
    this.add(path, "file");
    this.change(path, { bytes: Uint8Array.from(bytes) });
  }

  public async replaceFile(
    path: string,
    bytes: Uint8Array,
    expectedIdentity: string,
  ): Promise<void> {
    const entry = this.entry(path);
    if (entry.kind !== "file" || entry.reparsePoint || entry.linkCount !== 1) {
      throw new InvestigationWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "The replacement target is unsafe.",
      );
    }
    if (entry.identity !== expectedIdentity) {
      throw new InvestigationWorkspaceError(
        "SOURCE_EDIT_CONFLICT",
        "The replacement target changed.",
      );
    }
    if (entry.readOnly) throw fileError("EPERM");
    this.change(path, { bytes: Uint8Array.from(bytes) });
  }

  public async readFile(
    path: string,
    expectedIdentity?: string,
    maximumBytes?: number,
  ): Promise<Uint8Array> {
    const entry = this.entry(path);
    if (entry.kind !== "file") throw fileError("EISDIR");
    if (expectedIdentity !== undefined && entry.identity !== expectedIdentity) {
      throw new InvestigationWorkspaceError(
        "SOURCE_EDIT_CONFLICT",
        "The source file changed before reading.",
      );
    }
    if (maximumBytes !== undefined && entry.bytes.byteLength > maximumBytes) {
      throw new InvestigationWorkspaceError(
        "SOURCE_EDIT_LIMIT_EXCEEDED",
        "The source file exceeds its read limit.",
      );
    }
    return Uint8Array.from(entry.bytes);
  }

  public async setReadOnly(path: string, readOnly: boolean): Promise<void> {
    this.change(path, { readOnly });
  }

  public async removeFile(path: string): Promise<void> {
    const current = this.entry(path);
    if (current.readOnly) throw fileError("EPERM");
    this.entries.delete(key(path));
    for (const entry of this.entries.values())
      if (entry.kind === "file" && entry.identity === current.identity)
        this.change(entry.path, { linkCount: entry.linkCount - 1 });
    this.removed.push(path);
  }

  public async removeEmptyDirectory(path: string): Promise<void> {
    if ((await this.readDirectory(path)).length > 0) throw fileError("ENOTEMPTY");
    this.entries.delete(key(path));
    this.removed.push(path);
  }
}

function key(path: string): string {
  return win32.normalize(path).toLowerCase();
}
function fileError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function input(): InvestigationWorkspaceInput {
  const fixture = createInvestigationFixture("pr");
  const subject = fixture.task.subjects.find(
    (candidate) => candidate.id === fixture.task.subjectRef,
  );
  if (subject === undefined) throw new Error("The fixture must contain the current subject.");
  return {
    task: {
      ...fixture.task,
      executionPolicy: { ...fixture.task.executionPolicy, mode: "snapshot_only" },
    },
    attempt: { ...fixture.attempt, state: "running" },
    inputSnapshot: {
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId: fixture.task.repository.id,
      workItemId: fixture.task.workItem.id,
      subjectRef: fixture.task.subjectRef,
      subjectRevisionKey: subject.revisionKey,
      title: fixture.task.workItem.title,
      body: "Frozen issue content",
      comments: [{ id: "comment-1", body: "Reporter statement" }],
      source: null,
    } satisfies InvestigationInputSnapshotV1,
  };
}

function setup(
  materializer?: InvestigationSourceMaterializer,
  options: Pick<
    ProductionInvestigationWorkspaceProviderOptions,
    "maximumInputBytes" | "maximumArtifactBytes" | "onOwnershipEstablished" | "cleanupOwned"
  > = {},
) {
  const fs = new MemoryFileSystem();
  const start = vi.fn(async () => {
    throw new Error("No test may launch a process.");
  });
  const processHost: ProcessHostClient = {
    start,
    terminateAll: async () => undefined,
    close: async () => undefined,
  };
  const controller = new AbortController();
  let artifactNumber = 0;
  const provider = new ProductionInvestigationWorkspaceProvider({
    workspaceRootDirectory: root,
    fileSystem: fs,
    createId: () => `test-artifact-${++artifactNumber}`,
    ...options,
    ...(materializer === undefined ? {} : { sourceMaterializer: materializer }),
  });
  return { fs, start, provider, controller, context: { signal: controller.signal, processHost } };
}

async function prepareRecoveryWorkspace() {
  let ownership: InvestigationWorkspaceOwnershipReceipt | undefined;
  const fixture = setup(undefined, {
    onOwnershipEstablished: async (receipt) => {
      ownership = structuredClone(receipt);
    },
  });
  fixture.fs.add("C:\\", "directory");
  const value = input();
  const workspace = await fixture.provider.prepare(value, fixture.context);
  if (ownership === undefined)
    throw new Error("The fixture did not receive its ownership receipt.");
  const recovery: CleanupOwnedInvestigationAttemptOptions = {
    workspaceRootDirectory: root,
    taskId: value.task.id,
    attemptId: value.attempt.id,
    leaseVersion: value.attempt.leaseVersion,
    ownership,
    processesStopped: true,
    fileSystem: fixture.fs,
  };
  return { ...fixture, value, workspace, ownership, recovery };
}

function sourceBinding(value: InvestigationWorkspaceInput): InvestigationSourceBinding {
  const subject = value.task.subjects.find((candidate) => candidate.id === value.task.subjectRef);
  if (subject?.kind !== "original_pr")
    throw new Error("This fixture requires an original PR subject.");
  return {
    subjectRef: subject.id,
    revisionKey: subject.revisionKey,
    sourceSha: subject.headSha,
    patchDigest: null,
    artifactRef: "verified-source-artifact",
  };
}

function addGeneratedHardlinks(fs: MemoryFileSystem, directory: string, readOnly = false) {
  if (!fs.entries.has(key(directory))) fs.add(directory, "directory");
  const paths = [win32.join(directory, "one.dat"), win32.join(directory, "two.dat")];
  for (const path of paths) fs.add(path, "file", "Generated dependency bytes.");
  const identity = fs.entry(paths[0]!).identity;
  for (const path of paths) fs.change(path, { identity, linkCount: 2, readOnly });
  return paths;
}

function withSource(value: InvestigationWorkspaceInput): InvestigationWorkspaceInput {
  return {
    ...value,
    task: {
      ...value.task,
      executionPolicy: { ...value.task.executionPolicy, mode: "source_read" },
    },
  };
}

function editableInput(): InvestigationWorkspaceInput {
  const value = input();
  return {
    ...value,
    task: {
      ...value.task,
      kind: "issue-fix",
      executionPolicy: {
        ...value.task.executionPolicy,
        mode: "execute",
        allowRepositoryExecution: true,
        authorizationRef: "source-edit-authorization",
      },
    },
  };
}

function textDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function prepareSource(
  value: InvestigationWorkspaceInput = editableInput(),
  files: Readonly<Record<string, string>> = { "src/file.txt": "Original source\n" },
  options: Pick<
    ProductionInvestigationWorkspaceProviderOptions,
    "maximumInputBytes" | "maximumArtifactBytes"
  > = {},
  useFastReads = false,
  bindingDetails: Partial<InvestigationSourceBinding> = {},
) {
  let fs: MemoryFileSystem;
  const assertBinding = vi.fn(async () => undefined);
  const assertReadBinding = vi.fn(async (_file?: InvestigationSourceFile) => undefined);
  const fixture = setup(
    {
      materialize: async ({ destinationDirectory }) => {
        for (const [relativePath, content] of Object.entries(files)) {
          const components = relativePath.split("/");
          let directory = destinationDirectory;
          for (const component of components.slice(0, -1)) {
            directory = win32.join(directory, component);
            if ((await fs.lstat(directory)) === null) fs.add(directory, "directory");
          }
          fs.add(win32.join(destinationDirectory, ...components), "file", content);
        }
        return {
          binding: { ...sourceBinding(value), ...bindingDetails },
          assertBinding,
          ...(useFastReads ? { assertReadBinding } : {}),
        };
      },
    },
    options,
  );
  fs = fixture.fs;
  const workspace = await fixture.provider.prepare(value, fixture.context);
  return { ...fixture, workspace, value, assertBinding, assertReadBinding };
}

function sourceSnapshot(
  value: InvestigationWorkspaceInput,
  files: NonNullable<InvestigationInputSnapshotV1["source"]>["files"],
): NonNullable<InvestigationInputSnapshotV1["source"]> {
  const source = {
    artifactRef: "source-artifact",
    artifactDigest: "0".repeat(64),
    sourceSha: sourceBinding(value).sourceSha,
    files,
  };
  source.artifactDigest = createHash("sha256")
    .update(investigationCanonicalJson(investigationSourceDigestPayload(source)))
    .digest("hex");
  return source;
}

function withManifestDigest(
  payload: Omit<InvestigationPrDiffManifest, "digest">,
): InvestigationPrDiffManifest {
  return { ...payload, digest: textDigest(investigationCanonicalJson(payload)) };
}

async function preparePrDiff(
  contents = {
    diff: "diff --git a/file.txt b/file.txt\n-old\n+new\n",
    base: "old\n",
    head: "new\n",
  },
  useBatch = false,
  useFastReads = false,
) {
  const value = withSource(input());
  const subject = value.task.subjects.find((candidate) => candidate.id === value.task.subjectRef);
  if (subject?.kind !== "original_pr")
    throw new Error("The PR diff fixture requires an original PR subject.");
  const chunks: InvestigationPrDiffChunk[] = (["diff", "base", "head"] as const).map((kind) => ({
    id: `pr-diff-${kind}`,
    path: "file.txt",
    kind,
    ordinal: 0,
    encoding: "utf8",
    content: contents[kind],
    contentDigest: textDigest(contents[kind]),
    byteLength: Buffer.byteLength(contents[kind], "utf8"),
  }));
  const manifest = withManifestDigest({
    schemaVersion: "InvestigationPrDiffManifestV1",
    subjectRef: subject.id,
    baseSha: subject.baseSha,
    headSha: subject.headSha,
    mergeBaseSha: "c".repeat(40),
    files: [
      {
        path: "file.txt",
        previousPath: null,
        status: "modified",
        chunkIds: chunks.map((chunk) => chunk.id),
      },
    ],
    chunks: chunks.map(({ content: _content, ...descriptor }) => descriptor),
  });
  const state = { manifest, chunks: new Map(chunks.map((chunk) => [chunk.id, chunk])) };
  const readPrDiffManifest = vi.fn(async () => state.manifest);
  const readPrDiffChunk = vi.fn(async (id: string) => {
    const chunk = state.chunks.get(id);
    if (chunk === undefined) throw new Error("The fixture has no unregistered chunks.");
    return chunk;
  });
  const readPrDiffChunks = vi.fn(async (ids: readonly string[]) =>
    ids.map((id) => {
      const chunk = state.chunks.get(id);
      if (chunk === undefined) throw new Error("The fixture has no unregistered chunks.");
      return chunk;
    }),
  );
  const assertBinding = vi.fn(async () => undefined);
  const assertReadBinding = vi.fn(async (_file?: InvestigationSourceFile) => undefined);
  const fixture = setup({
    materialize: async () => ({
      binding: sourceBinding(value),
      assertBinding,
      ...(useFastReads ? { assertReadBinding } : {}),
      readPrDiffManifest,
      readPrDiffChunk,
      ...(useBatch ? { readPrDiffChunks } : {}),
    }),
  });
  const workspace = await fixture.provider.prepare(value, fixture.context);
  return {
    ...fixture,
    state,
    workspace,
    readPrDiffManifest,
    readPrDiffChunk,
    readPrDiffChunks,
    assertBinding,
    assertReadBinding,
  };
}

describe("native investigation attempt workspaces", () => {
  const focusedContext = (sourceSha: string): InvestigationSourceContext => {
    const content = "class Owner : IDisposable { public void Dispose() {} }\n";
    return {
      sourceSha,
      seedPaths: ["src/Owner.cs"],
      requiredFiles: [{ path: "src/Owner.cs", content, digest: textDigest(content) }],
      contextFiles: [],
      queries: [
        {
          kind: "reference",
          revisionSha: sourceSha,
          symbols: ["Owner"],
          paths: ["src/Owner.cs", "tests/OwnerTests.cs"],
          matchedPathCount: 2,
          omittedPathCount: 0,
        },
      ],
      deferred: [{ path: "tests/OwnerTests.cs", reason: "candidate_scan_files_budget" }],
      identityScanFiles: 1,
      identityScanBytes: Buffer.byteLength(content, "utf8"),
      catalogComplete: true,
      omittedCandidateCount: 0,
    };
  };

  it("retains complete required source when optional candidates are deferred and brackets the read", async () => {
    const value = withSource(input());
    const source = sourceBinding(value);
    const events: string[] = [];
    const context = { ...focusedContext(source.sourceSha), queryBudgetExhausted: true as const };
    const readSourceContext = vi.fn(async () => {
      events.push("context");
      return context;
    });
    const f = setup({
      materialize: async () => ({
        binding: source,
        assertBinding: async () => {
          events.push("binding");
        },
        readSourceContext,
      }),
    });
    const workspace = await f.provider.prepare(value, f.context);
    events.length = 0;
    const result = await workspace.readSourceContext!(["src/Owner.cs"]);
    expect(events).toEqual(["binding", "context", "binding"]);
    expect(readSourceContext).toHaveBeenCalledExactlyOnceWith(["src/Owner.cs"]);
    expect(result).toEqual(context);
    expect(result).not.toBe(context);
    expect(result.requiredFiles[0]!.content).toBe(context.requiredFiles[0]!.content);
    expect(result.contextFiles).toEqual([]);
    expect(result.deferred).toEqual([
      { path: "tests/OwnerTests.cs", reason: "candidate_scan_files_budget" },
    ]);
  });

  it("rejects focused context with missing required files, false provenance, changed digests, or false completeness", () => {
    const original = focusedContext("a".repeat(40));
    const corruptions: unknown[] = [
      { ...original, requiredFiles: [] },
      { ...original, requiredFiles: [{ ...original.requiredFiles[0]!, digest: "0".repeat(64) }] },
      { ...original, requiredFiles: [{ ...original.requiredFiles[0]!, path: "../outside.cs" }] },
      { ...original, deferred: [] },
      { ...original, deferred: [{ path: "src/Owner.cs", reason: "candidate_scan_files_budget" }] },
      { ...original, queries: [{ ...original.queries[0]!, revisionSha: "b".repeat(40) }] },
      { ...original, queries: [{ ...original.queries[0]!, omittedPathCount: 1 }] },
      { ...original, omittedCandidateCount: 1 },
      {
        ...original,
        catalogComplete: false,
        omittedCandidateCount: 1,
        queries: [{ ...original.queries[0]!, matchedPathCount: 102, omittedPathCount: 100 }],
      },
      { ...original, identityScanFiles: 65 },
      { ...original, queryBudgetExhausted: "true" },
      {
        ...original,
        contextFiles: [
          {
            ...original.requiredFiles[0]!,
            path: "tests/OwnerTests.cs",
            role: "related_context",
            relation: "proven",
          },
        ],
        deferred: [],
        identityScanFiles: 2,
        identityScanBytes: original.identityScanBytes * 2,
      },
    ];
    for (const changed of corruptions)
      expect(() =>
        assertInvestigationSourceContext(changed, original.sourceSha, original.seedPaths),
      ).toThrow();
  });

  it("rejects a frozen source replacement after a focused context read", async () => {
    const value = withSource(input());
    const source = sourceBinding(value);
    let changed = false;
    const f = setup({
      materialize: async () => ({
        binding: source,
        assertBinding: async () => {
          if (changed) throw new Error("Focused source changed.");
        },
        readSourceContext: async () => {
          changed = true;
          return focusedContext(source.sourceSha);
        },
      }),
    });
    const workspace = await f.provider.prepare(value, f.context);
    await expect(workspace.readSourceContext!(["src/Owner.cs"])).rejects.toThrow(
      "Focused source changed",
    );
  });

  it("enforces optional related-context limits separately from the total source budget", () => {
    const original = focusedContext("a".repeat(40));
    for (const contents of [
      Array<string>(9).fill("class Example {}\n"),
      ["x".repeat(128 * 1024 + 1)],
    ]) {
      const contextFiles = contents.map((content, index) => ({
        path: `src/Context${index}.cs`,
        content,
        digest: textDigest(content),
        role: "related_context" as const,
        relation: "unresolved_reference_identity" as const,
      }));
      const changed: InvestigationSourceContext = {
        ...original,
        contextFiles,
        queries: [
          {
            ...original.queries[0]!,
            paths: ["src/Owner.cs", ...contextFiles.map((file) => file.path)],
            matchedPathCount: contextFiles.length + 1,
          },
        ],
        deferred: [],
        identityScanFiles: contextFiles.length + 1,
        identityScanBytes:
          original.identityScanBytes +
          contents.reduce((total, content) => total + Buffer.byteLength(content), 0),
      };
      expect(() =>
        assertInvestigationSourceContext(changed, original.sourceSha, original.seedPaths),
      ).toThrow();
    }
  });

  it("does not read focused source context under execution policy", async () => {
    const value = editableInput();
    const readSourceContext = vi.fn();
    const f = setup({
      materialize: async () => ({
        binding: sourceBinding(value),
        assertBinding: async () => undefined,
        readSourceContext,
      }),
    });
    const workspace = await f.provider.prepare(value, f.context);
    await expect(workspace.readSourceContext!(["src/Owner.cs"])).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(readSourceContext).not.toHaveBeenCalled();
  });
  it("retains exact search matches and validates explicit namespace exclusions with separate scan accounting", async () => {
    for (const invalid of [false, true]) {
      const value = withSource(input());
      const source = sourceBinding(value);
      const content = "class Owner { Listener value; }\n";
      const dependencies: InvestigationSourceDependencies = {
        sourceSha: source.sourceSha,
        seedPaths: ["src/Listener.cpp"],
        symbols: ["Listener"],
        searchDepth: 1,
        identityScanBytes: 200,
        files: [{ path: "src/Owner.cs", content, digest: textDigest(content) }],
        queries: [
          {
            revisionSha: source.sourceSha,
            symbols: ["Listener"],
            paths: ["src/OtherListener.cs", "src/Owner.cs"],
            depth: 1,
            anchorIdentities: [{ name: "Listener", namespace: "Example" }],
            provenReferencePaths: [],
            unpropagatedMatches: [
              { path: "src/Owner.cs", reason: "unresolved_reference_identity" },
            ],
            excludedMatches: [
              {
                path: invalid ? "src/Unmatched.cs" : "src/OtherListener.cs",
                reason: "different_type_identity",
                matchedSymbols: ["Listener"],
              },
            ],
          },
        ],
      };
      const f = setup({
        materialize: async () => ({
          binding: source,
          assertBinding: async () => undefined,
          readSourceDependencies: async () => dependencies,
        }),
      });
      const workspace = await f.provider.prepare(value, f.context);
      if (invalid) {
        await expect(workspace.readSourceDependencies!(["src/Listener.cpp"])).rejects.toMatchObject(
          { code: "SOURCE_BINDING_MISMATCH" },
        );
      } else {
        const result = await workspace.readSourceDependencies!(["src/Listener.cpp"]);
        expect(result.queries[0]!.paths).toContain("src/OtherListener.cs");
        expect(result.files.map((file) => file.path)).toEqual(["src/Owner.cs"]);
        expect(result.identityScanBytes).toBe(200);
        expect(result.queries[0]!.unpropagatedMatches).toEqual([
          { path: "src/Owner.cs", reason: "unresolved_reference_identity" },
        ]);
      }
    }
  });
  it("brackets complete frozen source dependency reads with binding checks and retains query provenance", async () => {
    const value = withSource(input());
    const events: string[] = [];
    const source = sourceBinding(value);
    const content = "class ListenerOwner { private Listener listener; }\n";
    const dependencies: InvestigationSourceDependencies = {
      sourceSha: source.sourceSha,
      seedPaths: ["src/Listener.cpp"],
      symbols: ["Listener"],
      searchDepth: 1,
      files: [{ path: "src/ListenerOwner.cs", content, digest: textDigest(content) }],
      queries: [
        {
          revisionSha: source.sourceSha,
          symbols: ["Listener"],
          paths: ["src/Listener.cpp", "src/ListenerOwner.cs"],
          depth: 1,
        },
      ],
    };
    const readSourceDependencies = vi.fn(async () => {
      events.push("dependencies");
      return dependencies;
    });
    const f = setup({
      materialize: async () => ({
        binding: source,
        assertBinding: async () => {
          events.push("binding");
        },
        readSourceDependencies,
      }),
    });
    const workspace = await f.provider.prepare(value, f.context);
    events.length = 0;
    const result = await workspace.readSourceDependencies!(["src/Listener.cpp"]);
    expect(events).toEqual(["binding", "dependencies", "binding"]);
    expect(result).toEqual(dependencies);
    expect(result).not.toBe(dependencies);
    expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith(["src/Listener.cpp"]);
  });

  it.each(["documentation only", "mixed"] as const)(
    "retains explicit unsupported dependency seeds for %s requests",
    async (mode) => {
      const value = withSource(input());
      const source = sourceBinding(value);
      const seedPaths =
        mode === "mixed" ? ["doc/Review.md", "src/Listener.cpp"] : ["doc/Review.md"];
      const content = "class Owner { Listener value; }\n";
      const dependencies: InvestigationSourceDependencies = {
        sourceSha: source.sourceSha,
        seedPaths,
        unsupportedSeedPaths: ["doc/Review.md"],
        symbols: mode === "mixed" ? ["Listener"] : [],
        searchDepth: mode === "mixed" ? 1 : 0,
        files:
          mode === "mixed" ? [{ path: "src/Owner.cs", content, digest: textDigest(content) }] : [],
        queries:
          mode === "mixed"
            ? [
                {
                  revisionSha: source.sourceSha,
                  symbols: ["Listener"],
                  paths: ["src/Listener.cpp", "src/Owner.cs"],
                  depth: 1,
                },
              ]
            : [],
      };
      const readSourceDependencies = vi.fn(async () => dependencies);
      const f = setup({
        materialize: async () => ({
          binding: source,
          assertBinding: async () => undefined,
          readSourceDependencies,
        }),
      });
      const workspace = await f.provider.prepare(value, f.context);
      const result = await workspace.readSourceDependencies!(seedPaths);
      expect(result).toEqual(dependencies);
      expect(result.unsupportedSeedPaths).toEqual(["doc/Review.md"]);
      expect(result.unsupportedSeedPaths).not.toBe(dependencies.unsupportedSeedPaths);
      expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith(seedPaths);
      expect(f.start).not.toHaveBeenCalled();
    },
  );

  it.each([
    "extra",
    "duplicate",
    "case alias",
    "noncanonical",
    "query match",
    "all unsupported searched",
  ] as const)("rejects %s unsupported dependency seed metadata", async (corruption) => {
    const value = withSource(input());
    const source = sourceBinding(value);
    const seedPaths = ["doc/Review.md", "src/Listener.cpp"];
    const unsupportedSeedPaths =
      corruption === "extra"
        ? ["doc/Other.md"]
        : corruption === "duplicate"
          ? ["doc/Review.md", "doc/Review.md"]
          : corruption === "case alias"
            ? ["doc/Review.md", "DOC/REVIEW.MD"]
            : corruption === "noncanonical"
              ? ["doc\\Review.md"]
              : corruption === "all unsupported searched"
                ? seedPaths
                : ["doc/Review.md"];
    const dependencies: InvestigationSourceDependencies = {
      sourceSha: source.sourceSha,
      seedPaths,
      unsupportedSeedPaths,
      symbols: ["Listener"],
      searchDepth: 1,
      files:
        corruption === "all unsupported searched"
          ? [
              {
                path: "src/Other.cs",
                content: "class Other {};",
                digest: textDigest("class Other {};"),
              },
            ]
          : [],
      queries: [
        {
          revisionSha: source.sourceSha,
          symbols: ["Listener"],
          paths:
            corruption === "query match"
              ? ["doc/Review.md", "src/Listener.cpp"]
              : corruption === "all unsupported searched"
                ? ["src/Other.cs"]
                : ["src/Listener.cpp"],
          depth: 1,
        },
      ],
    };
    const f = setup({
      materialize: async () => ({
        binding: source,
        assertBinding: async () => undefined,
        readSourceDependencies: async () => dependencies,
      }),
    });
    const workspace = await f.provider.prepare(value, f.context);
    await expect(workspace.readSourceDependencies!(seedPaths)).rejects.toMatchObject({
      code: corruption === "noncanonical" ? "WORKSPACE_PATH_UNSAFE" : "SOURCE_BINDING_MISMATCH",
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("rejects changed dependency identities, omitted matches, unsafe paths, and inconsistent query revisions", async () => {
    for (const corruption of [
      "sha",
      "seed",
      "digest",
      "missing",
      "path",
      "query",
      "unproved",
      "bytes",
      "depth",
    ] as const) {
      const value = withSource(input());
      const source = sourceBinding(value);
      const content = "class Owner { Listener value; }\n";
      const dependencies: InvestigationSourceDependencies = {
        sourceSha: source.sourceSha,
        seedPaths: ["src/Listener.cpp"],
        symbols: ["Listener"],
        searchDepth: 1,
        files: [{ path: "src/Owner.cs", content, digest: textDigest(content) }],
        queries: [
          {
            revisionSha: source.sourceSha,
            symbols: ["Listener"],
            paths: ["src/Owner.cs"],
            depth: 1,
          },
        ],
      };
      const changed =
        corruption === "sha"
          ? { ...dependencies, sourceSha: "f".repeat(40) }
          : corruption === "seed"
            ? { ...dependencies, seedPaths: ["src/Other.cpp"] }
            : corruption === "digest"
              ? { ...dependencies, files: [{ ...dependencies.files[0]!, digest: "0".repeat(64) }] }
              : corruption === "missing"
                ? { ...dependencies, files: [] }
                : corruption === "path"
                  ? {
                      ...dependencies,
                      files: [{ ...dependencies.files[0]!, path: "../outside.cs" }],
                    }
                  : corruption === "unproved"
                    ? {
                        ...dependencies,
                        queries: [{ ...dependencies.queries[0]!, paths: ["src/Listener.cpp"] }],
                      }
                    : corruption === "bytes"
                      ? {
                          ...dependencies,
                          files: [
                            {
                              ...dependencies.files[0]!,
                              content: "x".repeat(256 * 1024 + 1),
                              digest: textDigest("x".repeat(256 * 1024 + 1)),
                            },
                          ],
                        }
                      : corruption === "depth"
                        ? { ...dependencies, searchDepth: 3 }
                        : {
                            ...dependencies,
                            queries: [{ ...dependencies.queries[0]!, revisionSha: "e".repeat(40) }],
                          };
      const f = setup({
        materialize: async () => ({
          binding: source,
          assertBinding: async () => undefined,
          readSourceDependencies: async () => changed,
        }),
      });
      const workspace = await f.provider.prepare(value, f.context);
      await expect(workspace.readSourceDependencies!(["src/Listener.cpp"])).rejects.toThrow();
    }
  });

  it("rejects source replacement observed after dependency content was read", async () => {
    const value = withSource(input());
    const source = sourceBinding(value);
    let altered = false;
    const f = setup({
      materialize: async () => ({
        binding: source,
        assertBinding: async () => {
          if (altered) throw new Error("Frozen source changed.");
        },
        readSourceDependencies: async () => {
          altered = true;
          return {
            sourceSha: source.sourceSha,
            seedPaths: ["src/Listener.cpp"],
            symbols: [],
            searchDepth: 0,
            files: [],
            queries: [],
          };
        },
      }),
    });
    const workspace = await f.provider.prepare(value, f.context);
    await expect(workspace.readSourceDependencies!(["src/Listener.cpp"])).rejects.toThrow(
      "Frozen source changed",
    );
  });

  it("does not discover repository dependencies under execution policy", async () => {
    const value = editableInput();
    const readSourceDependencies = vi.fn();
    const f = setup({
      materialize: async () => ({
        binding: sourceBinding(value),
        assertBinding: async () => undefined,
        readSourceDependencies,
      }),
    });
    const workspace = await f.provider.prepare(value, f.context);
    await expect(workspace.readSourceDependencies!(["src/Listener.cpp"])).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(readSourceDependencies).not.toHaveBeenCalled();
  });

  it("freezes snapshot bytes, isolates control files, and stores artifacts with actual digests", async () => {
    const { fs, provider, context, start } = setup();
    const value = input();
    const snapshot = value.inputSnapshot as { body: string };
    const workspace = await provider.prepare(value, context);
    snapshot.body = "Changed after preparation";
    const bytes = await fs.readFile(workspace.modelInputPath);
    expect(Buffer.from(bytes).toString()).toContain("Frozen issue content");
    expect(fs.entry(workspace.modelInputPath).readOnly).toBe(true);
    expect(workspace.modelInputDigest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(workspace.controlDirectory).not.toBe(workspace.modelInputDirectory);
    expect(workspace.sourceDirectory).toBeNull();
    expect(workspace.sourceBinding).toBeNull();
    const artifactBytes = Buffer.from("Observed output\n");
    const artifact = await workspace.writeArtifact({
      name: "output.log",
      mediaType: "text/plain",
      kind: "log",
      subjectRef: value.task.subjectRef,
      bytes: artifactBytes,
    });
    expect(artifact).toMatchObject({
      taskId: value.task.id,
      attemptId: value.attempt.id,
      subjectRef: value.task.subjectRef,
      digest: createHash("sha256").update(artifactBytes).digest("hex"),
      byteLength: artifactBytes.byteLength,
      availability: "available",
    });
    expect(await workspace.readArtifact(artifact.id)).toEqual(Uint8Array.from(artifactBytes));
    await expect(workspace.readArtifact("..\\outside")).rejects.toMatchObject({
      code: "ARTIFACT_UNAVAILABLE",
    });
    await workspace.assertIntegrity();
    await expect(workspace.assertSourceBinding()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(start).not.toHaveBeenCalled();
    await workspace.cleanup();
    await workspace.cleanup();
    expect(await fs.readDirectory(root)).toEqual([]);
    await expect(workspace.assertIntegrity()).rejects.toMatchObject({ code: "WORKSPACE_CLOSED" });
  });

  it("refuses artifact uploads when stored bytes differ from the recorded digest", async () => {
    const { fs, provider, context } = setup();
    const value = input();
    const workspace = await provider.prepare(value, context);
    const artifact = await workspace.writeArtifact({
      name: "result.txt",
      mediaType: "text/plain",
      kind: "log",
      subjectRef: value.task.subjectRef,
      bytes: Buffer.from("Original bytes"),
    });
    const artifactPath = win32.join(workspace.attemptDirectory, "artifacts", `${artifact.id}.bin`);
    fs.change(artifactPath, { bytes: Buffer.from("Tampered bytes") });
    await expect(workspace.readArtifact(artifact.id)).rejects.toMatchObject({
      code: "ARTIFACT_TAMPERED",
    });
  });

  it("does not adopt or delete another attempt at the same lease", async () => {
    const { fs, provider, context } = setup();
    const value = input();
    const workspace = await provider.prepare(value, context);
    await expect(provider.prepare(value, context)).rejects.toMatchObject({
      code: "WORKSPACE_ALREADY_EXISTS",
    });
    expect(fs.removed).toEqual([]);
    await workspace.assertIntegrity();
  });

  it("isolates lease generations and only cleans the current owner", async () => {
    const { fs, provider, context } = setup();
    const value = input();
    const first = await provider.prepare(value, context);
    const second = await provider.prepare(
      {
        ...value,
        attempt: { ...value.attempt, leaseVersion: value.attempt.leaseVersion + 1 },
      },
      context,
    );
    expect(first.attemptDirectory).not.toBe(second.attemptDirectory);
    await first.cleanup();
    await second.assertIntegrity();
    expect(await fs.lstat(second.attemptDirectory)).not.toBeNull();
  });

  it("rejects a task and attempt identity mismatch before making a directory", async () => {
    const { fs, provider, context } = setup();
    const value = input();
    await expect(
      provider.prepare({ ...value, attempt: { ...value.attempt, taskId: "other-task" } }, context),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await fs.readDirectory(root)).toEqual([]);
  });

  it("rejects a task subject belonging to a different repository", async () => {
    const { fs, provider, context } = setup();
    const value = input();
    await expect(
      provider.prepare(
        {
          ...value,
          task: {
            ...value.task,
            subjects: value.task.subjects.map((subject) => ({
              ...subject,
              repositoryId: "other-repository",
            })),
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await fs.readDirectory(root)).toEqual([]);
  });

  it.each(["repositoryId", "workItemId", "subjectRef", "subjectRevisionKey"] as const)(
    "rejects a snapshot bound to a different %s",
    async (field) => {
      const { fs, provider, context } = setup();
      const value = input();
      const snapshot = value.inputSnapshot as InvestigationInputSnapshotV1;
      await expect(
        provider.prepare(
          {
            ...value,
            inputSnapshot: {
              ...snapshot,
              [field]: field === "subjectRevisionKey" ? "0".repeat(64) : "other-id",
            },
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await fs.readDirectory(root)).toEqual([]);
    },
  );

  it("rejects unverified frozen source content even in snapshot-only mode", async () => {
    const { fs, provider, context } = setup();
    const value = input();
    const snapshot = value.inputSnapshot as InvestigationInputSnapshotV1;
    await expect(
      provider.prepare(
        {
          ...value,
          inputSnapshot: {
            ...snapshot,
            source: sourceSnapshot(value, [
              { path: "source.txt", content: "tampered content", digest: "1".repeat(64) },
            ]),
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
    expect(await fs.readDirectory(root)).toEqual([]);
  });

  it("checks source artifact digests without treating a source excerpt as a checkout", async () => {
    const { fs, provider, context } = setup();
    const value = input();
    const snapshot = value.inputSnapshot as InvestigationInputSnapshotV1;
    const content = "Verified excerpt";
    const source = sourceSnapshot(value, [
      {
        path: "source.txt",
        content,
        digest: createHash("sha256").update(content).digest("hex"),
      },
    ]);
    await expect(
      provider.prepare(
        {
          ...value,
          inputSnapshot: { ...snapshot, source: { ...source, artifactDigest: "0".repeat(64) } },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
    const workspace = await provider.prepare(
      { ...value, inputSnapshot: { ...snapshot, source } },
      context,
    );
    expect(Buffer.from(await fs.readFile(workspace.modelInputPath)).toString()).toContain(content);
    expect(workspace.sourceDirectory).toBeNull();
    await expect(workspace.capturePatch()).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it.each([
    "C:\\",
    "C:\\workspaces:stream",
    "C:\\workspaces\\..\\outside",
    "\\\\server\\share",
    "C:\\workspaces.\\attempts",
    "C:\\CON\\attempts",
  ])("rejects an unsafe configured root %s", (workspaceRootDirectory) => {
    expect(() => new ProductionInvestigationWorkspaceProvider({ workspaceRootDirectory })).toThrow(
      /workspace|drive root/iu,
    );
  });

  it.each(["reparse", "resolved outside"])("rejects a root that is %s", async (caseName) => {
    const { fs, provider, context } = setup();
    fs.change(
      root,
      caseName === "reparse" ? { reparsePoint: true } : { resolvedPath: "C:\\outside" },
    );
    await expect(provider.prepare(input(), context)).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    expect(fs.entries.size).toBe(1);
  });

  it("blocks missing source capability and removes its partial owned workspace", async () => {
    const { fs, provider, context, start } = setup();
    fs.add(win32.join(root, "unrelated"), "directory");
    await expect(provider.prepare(withSource(input()), context)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(await fs.readDirectory(root)).toEqual(["unrelated"]);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["direct", "aggregate", "cause"])(
    "retains the owned workspace when a %s source error cannot confirm process settlement",
    async (wrapper) => {
      const unconfirmed = Object.assign(new Error("Source process settlement was not confirmed."), {
        code: "SOURCE_PROCESS_CLEANUP_UNCONFIRMED",
      });
      const error =
        wrapper === "aggregate"
          ? new AggregateError(
              [new Error("Other failure"), unconfirmed],
              "Source preparation failed.",
            )
          : wrapper === "cause"
            ? new Error("Source preparation failed.", { cause: unconfirmed })
            : unconfirmed;
      let sourceDirectory = "";
      const { fs, provider, context } = setup({
        materialize: async ({ destinationDirectory }) => {
          sourceDirectory = destinationDirectory;
          throw error;
        },
      });
      const value = withSource(input());
      await expect(provider.prepare(value, context)).rejects.toBe(unconfirmed);
      const attemptDirectory = win32.dirname(sourceDirectory);
      const ownerPath = win32.join(attemptDirectory, ".owner.json");
      expect(fs.removed).toEqual([]);
      expect(await fs.lstat(sourceDirectory)).toMatchObject({ kind: "directory" });
      expect(fs.entry(ownerPath).readOnly).toBe(true);
      expect(JSON.parse(Buffer.from(await fs.readFile(ownerPath)).toString())).toMatchObject({
        taskId: value.task.id,
        attemptId: value.attempt.id,
        leaseVersion: value.attempt.leaseVersion,
      });
      expect(
        await fs.lstat(win32.join(attemptDirectory, "model-input", "snapshot.json")),
      ).toMatchObject({ kind: "file" });
    },
  );

  it("still cleans a failed source workspace when only a non-Error value contains the special code", async () => {
    const error = { code: "SOURCE_PROCESS_CLEANUP_UNCONFIRMED" };
    const { fs, provider, context } = setup({
      materialize: async () => {
        throw error;
      },
    });
    await expect(provider.prepare(withSource(input()), context)).rejects.toBe(error);
    expect(await fs.readDirectory(root)).toEqual([]);
    expect(fs.removed.length).toBeGreaterThan(0);
  });

  it.each(["bytes", "extra input"])(
    "detects frozen model input tampering: %s",
    async (caseName) => {
      const { fs, provider, context } = setup();
      const workspace = await provider.prepare(input(), context);
      if (caseName === "bytes")
        fs.change(workspace.modelInputPath, { bytes: Buffer.from("tampered") });
      else
        fs.add(
          win32.join(workspace.modelInputDirectory, "injected.md"),
          "file",
          "Extra instructions",
        );
      await expect(workspace.assertIntegrity()).rejects.toMatchObject({ code: "INPUT_TAMPERED" });
    },
  );

  it("refuses cleanup when the ownership marker changed", async () => {
    const { fs, provider, context } = setup();
    const workspace = await provider.prepare(input(), context);
    fs.change(win32.join(workspace.attemptDirectory, ".owner.json"), {
      bytes: Buffer.from("another owner"),
    });
    await expect(workspace.cleanup()).rejects.toMatchObject({ code: "WORKSPACE_NOT_OWNED" });
    expect(fs.removed).toEqual([]);
    expect(await fs.lstat(workspace.modelInputPath)).not.toBeNull();
  });

  it("refuses a replaced attempt directory even if its ownership marker was copied", async () => {
    const { fs, provider, context } = setup();
    const workspace = await provider.prepare(input(), context);
    fs.change(workspace.attemptDirectory, { identity: "replacement-directory" });
    await expect(workspace.cleanup()).rejects.toMatchObject({ code: "WORKSPACE_NOT_OWNED" });
    expect(fs.removed).toEqual([]);
  });

  it("rejects nested junctions before deleting any owned entries", async () => {
    const { fs, provider, context } = setup();
    const workspace = await provider.prepare(input(), context);
    const junction = win32.join(workspace.tempDirectory, "escape");
    fs.add(junction, "directory");
    fs.change(junction, { reparsePoint: true, resolvedPath: "C:\\outside" });
    await expect(workspace.cleanup()).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
    expect(fs.removed).toEqual([]);
  });

  it("cleans the owned workspace after cancellation without reusing the cancelled signal", async () => {
    const { fs, provider, context, controller } = setup();
    const workspace = await provider.prepare(input(), context);
    controller.abort(new Error("Lease lost"));
    await workspace.cleanup();
    expect(await fs.readDirectory(root)).toEqual([]);
  });

  it("checks the materializer's observed binding and captures only its actual patch bytes", async () => {
    const value = withSource(input());
    const assertBinding = vi.fn(async () => undefined);
    const capturePatch = vi.fn(async () => Buffer.from("diff --git a/file.txt b/file.txt\n"));
    let fs: MemoryFileSystem;
    const materialize = vi.fn(
      async ({ destinationDirectory }: { destinationDirectory: string }) => {
        fs.add(win32.join(destinationDirectory, "src"), "directory");
        fs.add(win32.join(destinationDirectory, "src", "file.txt"), "file", "Source file");
        return { binding: sourceBinding(value), assertBinding, capturePatch };
      },
    );
    const fixture = setup({ materialize });
    fs = fixture.fs;
    const workspace = await fixture.provider.prepare(value, fixture.context);
    expect(await workspace.resolveSourcePath("src/file.txt")).toBe(
      win32.join(workspace.sourceDirectory ?? "", "src", "file.txt"),
    );
    expect(await workspace.resolveSourcePath("src")).toBe(
      win32.join(workspace.sourceDirectory ?? "", "src"),
    );
    const patch = await workspace.capturePatch(fixture.context.signal);
    expect(patch.baseSha).toBe(sourceBinding(value).sourceSha);
    expect(Buffer.from(patch.bytes).toString()).toBe("diff --git a/file.txt b/file.txt\n");
    expect(capturePatch).toHaveBeenCalledWith(fixture.context.signal);
    expect(assertBinding.mock.calls.length).toBeGreaterThanOrEqual(4);
    assertBinding.mockRejectedValueOnce(new Error("Observed HEAD changed"));
    await expect(workspace.assertSourceBinding()).rejects.toThrow("Observed HEAD changed");
  });

  it("rejects declared source bindings with the wrong SHA before exposing source", async () => {
    const value = withSource(input());
    const assertBinding = vi.fn(async () => undefined);
    const { fs, provider, context } = setup({
      materialize: async () => ({
        binding: { ...sourceBinding(value), sourceSha: "f".repeat(40) },
        assertBinding,
      }),
    });
    await expect(provider.prepare(value, context)).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
    expect(assertBinding).not.toHaveBeenCalled();
    expect(await fs.readDirectory(root)).toEqual([]);
  });

  it("copies and deeply freezes pinned dependency provenance before exposing the workspace", async () => {
    const value = withSource(input());
    const binding = {
      ...sourceBinding(value),
      submodules: [
        {
          path: "deps/library",
          repository: "vendor/library",
          commitSha: "a".repeat(40),
          parentPath: null,
          parentCommitSha: sourceBinding(value).sourceSha,
        },
        {
          path: "deps/library/nested/helper",
          repository: "vendor/helper",
          commitSha: "b".repeat(40),
          parentPath: "deps/library",
          parentCommitSha: "a".repeat(40),
        },
      ],
      gitlinks: [
        {
          path: "deps/library",
          revisionSha: sourceBinding(value).sourceSha,
          commitSha: "a".repeat(40),
        },
      ],
      inertSymlinks: [{ path: "deps/library/link", revisionSha: "a".repeat(40) }],
    };
    const { provider, context } = setup({
      materialize: async () => ({ binding, assertBinding: async () => undefined }),
    });
    const workspace = await provider.prepare(value, context);
    const frozen = workspace.sourceBinding!;
    expect(frozen).toEqual(binding);
    expect(Object.isFrozen(frozen)).toBe(true);
    for (const entries of [frozen.submodules, frozen.gitlinks, frozen.inertSymlinks]) {
      expect(Object.isFrozen(entries)).toBe(true);
      for (const entry of entries!) expect(Object.isFrozen(entry)).toBe(true);
    }
    binding.submodules[0]!.commitSha = "c".repeat(40);
    binding.gitlinks[0]!.path = "elsewhere";
    binding.inertSymlinks[0]!.path = "elsewhere";
    expect(frozen.submodules![0]!.commitSha).toBe("a".repeat(40));
    expect(frozen.gitlinks![0]!.path).toBe("deps/library");
    expect(frozen.inertSymlinks![0]!.path).toBe("deps/library/link");
    await workspace.assertSourceBinding();
  });

  it.each([
    "unsafe path",
    "duplicate mount",
    "URL instead of repository",
    "wrong root commit",
    "missing parent",
    "wrong nested commit",
    "case-aliased parent",
    "duplicate gitlink",
    "conflicting head gitlink",
  ])("rejects %s in pinned dependency provenance before exposing source", async (corruption) => {
    const value = withSource(input());
    const binding = {
      ...sourceBinding(value),
      submodules: [
        {
          path: "deps/library",
          repository: "vendor/library",
          commitSha: "a".repeat(40),
          parentPath: null as string | null,
          parentCommitSha: sourceBinding(value).sourceSha,
        },
        {
          path: "deps/library/nested",
          repository: "vendor/helper",
          commitSha: "b".repeat(40),
          parentPath: "deps/library" as string | null,
          parentCommitSha: "a".repeat(40),
        },
      ],
      gitlinks: [
        {
          path: "deps/library",
          revisionSha: sourceBinding(value).sourceSha,
          commitSha: "a".repeat(40),
        },
      ],
    };
    if (corruption === "unsafe path") binding.submodules[0]!.path = "deps/../escape";
    if (corruption === "duplicate mount")
      binding.submodules.push({ ...binding.submodules[0]!, path: "DEPS/library" });
    if (corruption === "URL instead of repository")
      binding.submodules[0]!.repository = "https://github.com/vendor/library.git";
    if (corruption === "wrong root commit") binding.submodules[0]!.parentCommitSha = "f".repeat(40);
    if (corruption === "missing parent") binding.submodules[1]!.parentPath = "deps/missing";
    if (corruption === "wrong nested commit")
      binding.submodules[1]!.parentCommitSha = "f".repeat(40);
    if (corruption === "case-aliased parent") binding.submodules[1]!.path = "DEPS/library/nested";
    if (corruption === "duplicate gitlink")
      binding.gitlinks.push({ ...binding.gitlinks[0]!, path: "DEPS/library" });
    if (corruption === "conflicting head gitlink") binding.gitlinks[0]!.commitSha = "f".repeat(40);
    const assertBinding = vi.fn(async () => undefined);
    const { fs, provider, context } = setup({
      materialize: async () => ({ binding, assertBinding }),
    });
    await expect(provider.prepare(value, context)).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
    expect(assertBinding).not.toHaveBeenCalled();
    expect(await fs.readDirectory(root)).toEqual([]);
  });

  it.each([
    "deps/library",
    "deps/library/file.txt",
    "DEPS/LIBRARY/new.txt",
    ".gitmodules",
    "config/.gitmodules",
  ])(
    "rejects parent patch writes to protected dependency path %s before any edit",
    async (path) => {
      const value = editableInput();
      const f = await prepareSource(value, { "src/file.txt": "Original source\n" }, {}, false, {
        submodules: [
          {
            path: "deps/library",
            repository: "vendor/library",
            commitSha: "a".repeat(40),
            parentPath: null,
            parentCommitSha: sourceBinding(value).sourceSha,
          },
        ],
      });
      await expect(
        f.workspace.applyEdits({
          allowedPaths: ["src/file.txt", path],
          edits: [
            {
              path: "src/file.txt",
              expectedDigest: textDigest("Original source\n"),
              content: "Changed source\n",
            },
            { path, expectedDigest: null, content: "Uncapturable dependency mutation\n" },
          ],
        }),
      ).rejects.toMatchObject({ code: "SOURCE_EDIT_NOT_AUTHORIZED" });
      expect(await f.workspace.readSourceFile("src/file.txt")).toMatchObject({
        content: "Original source\n",
      });
    },
  );

  it("retains parent-source edit authorization when pinned dependencies are present", async () => {
    const value = editableInput();
    const f = await prepareSource(value, { "src/file.txt": "Original source\n" }, {}, false, {
      submodules: [
        {
          path: "deps/library",
          repository: "vendor/library",
          commitSha: "a".repeat(40),
          parentPath: null,
          parentCommitSha: sourceBinding(value).sourceSha,
        },
      ],
    });
    await f.workspace.applyEdits({
      allowedPaths: ["src/file.txt"],
      edits: [
        {
          path: "src/file.txt",
          expectedDigest: textDigest("Original source\n"),
          content: "Changed source\n",
        },
      ],
    });
    expect(await f.workspace.readSourceFile("src/file.txt")).toMatchObject({
      content: "Changed source\n",
    });
  });

  it("reads an exact nested submodule mount as verified Git pointer text while rejecting ordinary directories", async () => {
    const value = withSource(input());
    const f = await prepareSource(
      value,
      { "deps/library/nested/file.txt": "Child source\n", "src/file.txt": "Parent source\n" },
      {},
      true,
      {
        submodules: [
          {
            path: "deps/library",
            repository: "vendor/library",
            commitSha: "a".repeat(40),
            parentPath: null,
            parentCommitSha: sourceBinding(value).sourceSha,
          },
          {
            path: "deps/library/nested",
            repository: "vendor/helper",
            commitSha: "b".repeat(40),
            parentPath: "deps/library",
            parentCommitSha: "a".repeat(40),
          },
        ],
      },
    );
    f.assertReadBinding.mockClear();
    const content = `Subproject commit ${"b".repeat(40)}\n`;
    const pointer = { path: "deps/library/nested", content, digest: textDigest(content) };
    expect(await f.workspace.readSourceFile("deps/library/nested")).toEqual(pointer);
    expect(f.assertReadBinding.mock.calls).toEqual([[undefined], [pointer]]);
    await expect(f.workspace.readSourceFile("src")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    await expect(f.workspace.readSourceFile("deps")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
  });

  it.each(["identity replacement", "reparse point", "ordinary file"])(
    "does not return a submodule pointer after its directory changes to %s during the binding check",
    async (mutation) => {
      const value = withSource(input());
      const f = await prepareSource(
        value,
        { "deps/library/file.txt": "Child source\n" },
        {},
        true,
        {
          submodules: [
            {
              path: "deps/library",
              repository: "vendor/library",
              commitSha: "a".repeat(40),
              parentPath: null,
              parentCommitSha: sourceBinding(value).sourceSha,
            },
          ],
        },
      );
      const mount = win32.join(f.workspace.sourceDirectory!, "deps", "library");
      f.assertReadBinding.mockImplementation(async (file) => {
        if (file?.path !== "deps/library") return;
        if (mutation === "identity replacement")
          f.fs.change(mount, { identity: "replaced-directory" });
        if (mutation === "reparse point") f.fs.change(mount, { reparsePoint: true });
        if (mutation === "ordinary file") f.fs.change(mount, { kind: "file" });
      });
      await expect(f.workspace.readSourceFile("deps/library")).rejects.toMatchObject({
        code:
          mutation === "identity replacement" ? "SOURCE_BINDING_MISMATCH" : "WORKSPACE_PATH_UNSAFE",
      });
    },
  );

  it("propagates a materializer rejection of a submodule pointer instead of returning its declared pin", async () => {
    const value = withSource(input());
    const f = await prepareSource(value, { "deps/library/file.txt": "Child source\n" }, {}, true, {
      submodules: [
        {
          path: "deps/library",
          repository: "vendor/library",
          commitSha: "a".repeat(40),
          parentPath: null,
          parentCommitSha: sourceBinding(value).sourceSha,
        },
      ],
    });
    f.assertReadBinding.mockImplementation(async (file) => {
      if (file !== undefined)
        throw new InvestigationWorkspaceError(
          "SOURCE_BINDING_MISMATCH",
          "The exact Git pointer changed.",
        );
    });
    await expect(f.workspace.readSourceFile("deps/library")).rejects.toThrow(
      "The exact Git pointer changed.",
    );
  });

  it("binds a derived patch artifact only to nonempty recaptured worktree bytes", async () => {
    const original = withSource(input());
    const value = { ...original, task: { ...original.task, kind: "issue-fix" as const } };
    const bytes = Buffer.from("diff --git a/file.txt b/file.txt\n");
    const capturePatch = vi.fn(async () => Uint8Array.from(bytes));
    const { provider, context } = setup({
      materialize: async () => ({
        binding: sourceBinding(value),
        assertBinding: async () => undefined,
        capturePatch,
      }),
    });
    const workspace = await provider.prepare(value, context);
    const patch = {
      subjectRef: "derived-patch-subject",
      baseSubjectRef: value.task.subjectRef,
      baseSha: sourceBinding(value).sourceSha,
      bytes,
    };
    await expect(
      workspace.writeArtifact({
        subjectRef: patch.subjectRef,
        bytes,
        kind: "patch",
        name: "forged.patch",
        mediaType: "text/x-diff",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      workspace.writePatchArtifact({ ...patch, bytes: Buffer.from("declared changes") }),
    ).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
    await expect(
      workspace.writePatchArtifact({ ...patch, bytes: new Uint8Array() }),
    ).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
    const artifact = await workspace.writePatchArtifact(patch);
    expect(artifact.subjectRef).toBe(patch.subjectRef);
    expect(artifact.kind).toBe("patch");
    expect(artifact.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(capturePatch).toHaveBeenCalledTimes(2);
  });

  it("does not create derived patch artifacts for review tasks", async () => {
    const value = withSource(input());
    const capturePatch = vi.fn(async () => Buffer.from("diff --git a/a b/a\n"));
    const { provider, context } = setup({
      materialize: async () => ({
        binding: sourceBinding(value),
        assertBinding: async () => undefined,
        capturePatch,
      }),
    });
    const workspace = await provider.prepare(value, context);
    await expect(
      workspace.writePatchArtifact({
        subjectRef: "derived",
        baseSubjectRef: value.task.subjectRef,
        baseSha: sourceBinding(value).sourceSha,
        bytes: Buffer.from("diff --git a/a b/a\n"),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
    expect(capturePatch).not.toHaveBeenCalled();
  });

  it("allows derived-subject logs only after registration and while the captured patch still matches", async () => {
    const original = withSource(input());
    const value = { ...original, task: { ...original.task, kind: "issue-fix" as const } };
    let observedPatch = Buffer.from("diff --git a/file.txt b/file.txt\n");
    const capturePatch = vi.fn(async () => Uint8Array.from(observedPatch));
    const { provider, context } = setup({
      materialize: async () => ({
        binding: sourceBinding(value),
        assertBinding: async () => undefined,
        capturePatch,
      }),
    });
    const workspace = await provider.prepare(value, context);
    const log = {
      subjectRef: "derived-patch-subject",
      bytes: Buffer.from("Observed patch validation output"),
      kind: "log" as const,
      name: "validation.log",
      mediaType: "text/plain",
    };
    await expect(workspace.writeArtifact(log)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(capturePatch).not.toHaveBeenCalled();
    const patch = {
      subjectRef: log.subjectRef,
      baseSubjectRef: value.task.subjectRef,
      baseSha: sourceBinding(value).sourceSha,
      bytes: observedPatch,
    };
    await workspace.writePatchArtifact(patch);
    const artifact = await workspace.writeArtifact(log);
    expect(artifact.subjectRef).toBe(log.subjectRef);
    expect(await workspace.readArtifact(artifact.id)).toEqual(Uint8Array.from(log.bytes));
    expect(capturePatch).toHaveBeenCalledTimes(2);
    observedPatch = Buffer.from("diff --git a/different.txt b/different.txt\n");
    await expect(workspace.writeArtifact(log)).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
    await expect(
      workspace.writePatchArtifact({ ...patch, bytes: observedPatch }),
    ).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
    expect(capturePatch).toHaveBeenCalledTimes(3);
  });

  it.each([
    "../outside",
    "src/../../outside",
    "C:\\outside",
    "\\\\server\\share",
    "src/file:stream",
    "src/file.",
    "src/file ",
    "src/NUL",
    "src//file.txt",
    "src/./file.txt",
  ])("rejects source path escape or Windows aliases: %s", async (path) => {
    const value = withSource(input());
    const { provider, context } = setup({
      materialize: async () => ({
        binding: sourceBinding(value),
        assertBinding: async () => undefined,
      }),
    });
    const workspace = await provider.prepare(value, context);
    await expect(workspace.resolveSourcePath(path)).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
  });

  it("rejects hardlinked source files after preparation", async () => {
    const value = withSource(input());
    const { fs, provider, context } = setup({
      materialize: async () => ({
        binding: sourceBinding(value),
        assertBinding: async () => undefined,
      }),
    });
    const workspace = await provider.prepare(value, context);
    const linked = win32.join(workspace.sourceDirectory ?? "", "linked.txt");
    fs.add(linked, "file", "External hard link");
    fs.change(linked, { linkCount: 2 });
    await expect(workspace.resolveSourcePath("linked.txt")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
  });
});

describe("native investigation source reads and model edits", () => {
  it("reads UTF-8 source text with the digest of the exact bytes", async () => {
    const content = "A source file with caf\u00e9 and an emoji \ud83d\udd0e\r\n";
    const { workspace, start } = await prepareSource(withSource(input()), {
      "src/file.txt": content,
    });
    expect(await workspace.readSourceFile("src/file.txt")).toEqual({
      path: "src/file.txt",
      content,
      digest: textDigest(content),
    });
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["", "\ufeffSource with a UTF-8 BOM\n"])(
    "preserves empty text and UTF-8 BOM bytes: %j",
    async (content) => {
      const { workspace } = await prepareSource(withSource(input()), { "src/file.txt": content });
      expect(await workspace.readSourceFile("src\\file.txt")).toEqual({
        path: "src/file.txt",
        content,
        digest: textDigest(content),
      });
    },
  );

  it.each(["src/missing.txt", "missing/nested/file.txt"])(
    "returns an absent source file without creating parents: %s",
    async (path) => {
      const { fs, workspace } = await prepareSource();
      const entries = fs.entries.size;
      expect(await workspace.readSourceFile(path)).toEqual({ path, content: null, digest: null });
      expect(fs.entries.size).toBe(entries);
    },
  );

  it("rejects invalid UTF-8 bytes instead of returning replacement characters", async () => {
    const { fs, workspace } = await prepareSource();
    fs.change(win32.join(workspace.sourceDirectory ?? "", "src", "file.txt"), {
      bytes: Uint8Array.from([0xc3, 0x28]),
    });
    await expect(workspace.readSourceFile("src/file.txt")).rejects.toMatchObject({
      code: "SOURCE_NOT_TEXT",
    });
  });

  it("rejects NUL-containing source bytes as binary content", async () => {
    const { workspace } = await prepareSource(withSource(input()), { "file.bin": "Header\0Body" });
    await expect(workspace.readSourceFile("file.bin")).rejects.toMatchObject({
      code: "SOURCE_NOT_TEXT",
    });
  });

  it("requires materialized source for reading", async () => {
    const { provider, context } = setup();
    const workspace = await provider.prepare(input(), context);
    await expect(workspace.readSourceFile("file.txt")).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it.each(["issue-fix", "feature-implement"] as const)(
    "creates, replaces, and deletes authorized source files for %s",
    async (kind) => {
      const original = editableInput();
      const value = { ...original, task: { ...original.task, kind } };
      const oldContent = "Original source\n";
      const deletedContent = "Remove this source\n";
      const { fs, workspace, start } = await prepareSource(value, {
        "src/file.txt": oldContent,
        "delete.txt": deletedContent,
      });
      const existingPath = win32.join(workspace.sourceDirectory ?? "", "src", "file.txt");
      const originalIdentity = fs.entry(existingPath).identity;
      const replaceFile = vi.spyOn(fs, "replaceFile");
      const updatedContent = "Updated source with caf\u00e9\n";
      await workspace.applyEdits({
        allowedPaths: ["SRC/FILE.TXT", "new/nested/created.txt", "delete.txt"],
        edits: [
          { path: "src/file.txt", expectedDigest: textDigest(oldContent), content: updatedContent },
          { path: "new/nested/created.txt", expectedDigest: null, content: "Created source\n" },
          { path: "delete.txt", expectedDigest: textDigest(deletedContent), content: null },
        ],
      });
      expect(replaceFile).toHaveBeenCalledWith(
        existingPath,
        expect.any(Uint8Array),
        originalIdentity,
      );
      expect(await workspace.readSourceFile("src/file.txt")).toEqual({
        path: "src/file.txt",
        content: updatedContent,
        digest: textDigest(updatedContent),
      });
      expect(await workspace.readSourceFile("new/nested/created.txt")).toEqual({
        path: "new/nested/created.txt",
        content: "Created source\n",
        digest: textDigest("Created source\n"),
      });
      expect(await workspace.readSourceFile("delete.txt")).toEqual({
        path: "delete.txt",
        content: null,
        digest: null,
      });
      expect(fs.entry(win32.join(workspace.sourceDirectory ?? "", "new", "nested")).kind).toBe(
        "directory",
      );
      await workspace.assertIntegrity();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each([
    "pr-review",
    "issue-investigate",
    "pr-verify",
    "issue-verify",
    "reproduction-setup",
  ] as const)("refuses model edits for %s tasks", async (kind) => {
    const original = editableInput();
    const { fs, workspace } = await prepareSource({
      ...original,
      task: { ...original.task, kind },
    });
    const replaceFile = vi.spyOn(fs, "replaceFile");
    await expect(
      workspace.applyEdits({
        allowedPaths: ["src/file.txt"],
        edits: [
          {
            path: "src/file.txt",
            expectedDigest: textDigest("Original source\n"),
            content: "Changed",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_NOT_AUTHORIZED" });
    expect(replaceFile).not.toHaveBeenCalled();
    expect(fs.removed).toEqual([]);
  });

  it.each([
    {
      name: "source-read mode",
      mode: "source_read" as const,
      allowRepositoryExecution: false,
      authorizationRef: null,
    },
    {
      name: "missing execution permission",
      mode: "execute" as const,
      allowRepositoryExecution: false,
      authorizationRef: "authorization",
    },
    {
      name: "missing authorization reference",
      mode: "execute" as const,
      allowRepositoryExecution: true,
      authorizationRef: null,
    },
  ])("refuses edits with $name", async ({ name: _name, ...policy }) => {
    const original = editableInput();
    const { fs, workspace } = await prepareSource({
      ...original,
      task: { ...original.task, executionPolicy: { ...original.task.executionPolicy, ...policy } },
    });
    const writeExclusive = vi.spyOn(fs, "writeExclusive");
    await expect(
      workspace.applyEdits({
        allowedPaths: ["created.txt"],
        edits: [{ path: "created.txt", expectedDigest: null, content: "Changed" }],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_NOT_AUTHORIZED" });
    expect(writeExclusive).not.toHaveBeenCalled();
  });

  it("rechecks the primary subject authorization before editing", async () => {
    const { fs, workspace, value } = await prepareSource();
    value.task.executionPolicy.allowedSubjectRefs = [];
    const replaceFile = vi.spyOn(fs, "replaceFile");
    await expect(
      workspace.applyEdits({
        allowedPaths: ["src/file.txt"],
        edits: [
          {
            path: "src/file.txt",
            expectedDigest: textDigest("Original source\n"),
            content: "Changed",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_NOT_AUTHORIZED" });
    expect(replaceFile).not.toHaveBeenCalled();
    expect(fs.removed).toEqual([]);
  });

  it("refuses a materialized binding to a non-primary task subject", async () => {
    const original = editableInput();
    const primary = original.task.subjects.find(
      (subject) => subject.id === original.task.subjectRef,
    );
    if (primary === undefined) throw new Error("The primary subject must exist.");
    const secondary = { ...primary, id: "secondary-source-subject" };
    const value = {
      ...original,
      task: {
        ...original.task,
        subjects: [...original.task.subjects, secondary],
        executionPolicy: {
          ...original.task.executionPolicy,
          allowedSubjectRefs: [...original.task.executionPolicy.allowedSubjectRefs, secondary.id],
        },
      },
    };
    const { provider, context } = setup({
      materialize: async () => ({
        binding: { ...sourceBinding(value), subjectRef: secondary.id },
        assertBinding: async () => undefined,
      }),
    });
    await expect(provider.prepare(value, context)).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
  });

  it("does not write any file or create parents when a later digest conflicts", async () => {
    const { fs, workspace } = await prepareSource();
    const createDirectory = vi.spyOn(fs, "createDirectory");
    const writeExclusive = vi.spyOn(fs, "writeExclusive");
    const replaceFile = vi.spyOn(fs, "replaceFile");
    await expect(
      workspace.applyEdits({
        allowedPaths: ["new/nested/file.txt", "src/file.txt"],
        edits: [
          { path: "new/nested/file.txt", expectedDigest: null, content: "New content" },
          { path: "src/file.txt", expectedDigest: "f".repeat(64), content: "Changed" },
        ],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_CONFLICT" });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(writeExclusive).not.toHaveBeenCalled();
    expect(replaceFile).not.toHaveBeenCalled();
    expect(fs.removed).toEqual([]);
    expect(fs.entry(win32.join(workspace.sourceDirectory ?? "", "src", "file.txt")).bytes).toEqual(
      Buffer.from("Original source\n"),
    );
  });

  it.each([
    { path: "src/file.txt", expectedDigest: null, content: "Unexpected overwrite" },
    {
      path: "missing.txt",
      expectedDigest: textDigest("Expected bytes"),
      content: "Unexpected create",
    },
    { path: "missing.txt", expectedDigest: null, content: null },
  ])("rejects conflicting file existence for $path", async (edit) => {
    const { fs, workspace } = await prepareSource();
    const writeExclusive = vi.spyOn(fs, "writeExclusive");
    const replaceFile = vi.spyOn(fs, "replaceFile");
    await expect(
      workspace.applyEdits({ allowedPaths: [edit.path], edits: [edit] }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_CONFLICT" });
    expect(writeExclusive).not.toHaveBeenCalled();
    expect(replaceFile).not.toHaveBeenCalled();
    expect(fs.removed).toEqual([]);
  });

  it.each([
    { name: "a missing allowlist entry", allowedPaths: [], paths: ["src/file.txt"] },
    {
      name: "a directory instead of an exact file",
      allowedPaths: ["src"],
      paths: ["src/file.txt"],
    },
    {
      name: "duplicate allowlist paths after case folding",
      allowedPaths: ["src/file.txt", "SRC/FILE.TXT"],
      paths: ["src/file.txt"],
    },
    {
      name: "duplicate edit paths after case folding",
      allowedPaths: ["src/file.txt"],
      paths: ["src/file.txt", "SRC/FILE.TXT"],
    },
  ])("rejects $name before changing source", async ({ allowedPaths, paths }) => {
    const { fs, workspace } = await prepareSource();
    const replaceFile = vi.spyOn(fs, "replaceFile");
    await expect(
      workspace.applyEdits({
        allowedPaths,
        edits: paths.map((path) => ({
          path,
          expectedDigest: textDigest("Original source\n"),
          content: "Changed",
        })),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_NOT_AUTHORIZED" });
    expect(replaceFile).not.toHaveBeenCalled();
    expect(fs.removed).toEqual([]);
  });

  it("rejects an edit targeting another edit's parent even with an intervening sibling name", async () => {
    const { fs, workspace } = await prepareSource();
    const paths = ["new", "new.txt", "new/nested.txt"];
    const createDirectory = vi.spyOn(fs, "createDirectory");
    const writeExclusive = vi.spyOn(fs, "writeExclusive");
    await expect(
      workspace.applyEdits({
        allowedPaths: paths,
        edits: paths.map((path) => ({ path, expectedDigest: null, content: "New content" })),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_NOT_AUTHORIZED" });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(writeExclusive).not.toHaveBeenCalled();
  });

  it.each([
    "../outside.txt",
    "src/../../outside.txt",
    "C:\\outside.txt",
    "src/file.txt:stream",
    "src/*.txt",
    "src/**/file.txt",
    ".git/config",
    "src/.GiT/config",
  ])("rejects unsafe source read and edit paths: %s", async (path) => {
    const { fs, workspace } = await prepareSource();
    const writeExclusive = vi.spyOn(fs, "writeExclusive");
    await expect(workspace.readSourceFile(path)).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    await expect(
      workspace.applyEdits({
        allowedPaths: [path],
        edits: [{ path, expectedDigest: null, content: "Changed" }],
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
    expect(writeExclusive).not.toHaveBeenCalled();
  });

  it.each(["file", "parent"])(
    "rejects a symlink or junction at the %s before editing",
    async (location) => {
      const { fs, workspace } = await prepareSource();
      const relativePath = location === "file" ? "src/file.txt" : "src";
      fs.change(win32.join(workspace.sourceDirectory ?? "", relativePath), { reparsePoint: true });
      const replaceFile = vi.spyOn(fs, "replaceFile");
      await expect(
        workspace.applyEdits({
          allowedPaths: ["src/file.txt"],
          edits: [
            {
              path: "src/file.txt",
              expectedDigest: textDigest("Original source\n"),
              content: "Changed",
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
      expect(replaceFile).not.toHaveBeenCalled();
    },
  );

  it("does not treat a missing file beneath an existing file as a safe absent path", async () => {
    const { fs, workspace } = await prepareSource();
    const writeExclusive = vi.spyOn(fs, "writeExclusive");
    await expect(workspace.readSourceFile("src/file.txt/nested.txt")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    await expect(
      workspace.applyEdits({
        allowedPaths: ["src/file.txt/nested.txt"],
        edits: [
          { path: "src/file.txt/nested.txt", expectedDigest: null, content: "Unexpected child" },
        ],
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
    expect(writeExclusive).not.toHaveBeenCalled();
  });

  it("rejects a source identity replacement during the bounded read", async () => {
    const { fs, workspace } = await prepareSource();
    const path = win32.join(workspace.sourceDirectory ?? "", "src", "file.txt");
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(
      async (candidate, expectedIdentity, maximumBytes) => {
        if (key(candidate) === key(path)) fs.change(path, { identity: "replacement-file" });
        return readFile(candidate, expectedIdentity, maximumBytes);
      },
    );
    await expect(workspace.readSourceFile("src/file.txt")).rejects.toMatchObject({
      code: "SOURCE_EDIT_CONFLICT",
    });
  });

  it("refuses to overwrite a file replaced after edit preflight", async () => {
    const { fs, workspace } = await prepareSource();
    const path = win32.join(workspace.sourceDirectory ?? "", "src", "file.txt");
    const replaceFile = fs.replaceFile.bind(fs);
    vi.spyOn(fs, "replaceFile").mockImplementationOnce(
      async (candidate, bytes, expectedIdentity) => {
        fs.change(path, {
          identity: "replacement-file",
          bytes: Buffer.from("Replacement owner bytes"),
        });
        await replaceFile(candidate, bytes, expectedIdentity);
      },
    );
    await expect(
      workspace.applyEdits({
        allowedPaths: ["src/file.txt"],
        edits: [
          {
            path: "src/file.txt",
            expectedDigest: textDigest("Original source\n"),
            content: "Changed",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_CONFLICT" });
    expect(fs.entry(path).bytes).toEqual(Buffer.from("Replacement owner bytes"));
  });

  it("accepts an empty authorized edit batch without filesystem mutations", async () => {
    const { fs, workspace } = await prepareSource();
    const createDirectory = vi.spyOn(fs, "createDirectory");
    const writeExclusive = vi.spyOn(fs, "writeExclusive");
    const replaceFile = vi.spyOn(fs, "replaceFile");
    await workspace.applyEdits({ allowedPaths: [], edits: [] });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(writeExclusive).not.toHaveBeenCalled();
    expect(replaceFile).not.toHaveBeenCalled();
    expect(fs.removed).toEqual([]);
  });

  it("limits source reads by UTF-8 byte count", async () => {
    const { workspace } = await prepareSource(
      editableInput(),
      { "file.txt": "\u00e9".repeat(5) },
      { maximumArtifactBytes: 8 },
    );
    await expect(workspace.readSourceFile("file.txt")).rejects.toMatchObject({
      code: "SOURCE_EDIT_LIMIT_EXCEEDED",
    });
  });

  it("rejects an oversized UTF-8 edit before writing", async () => {
    const { fs, workspace } = await prepareSource(editableInput(), {}, { maximumArtifactBytes: 8 });
    const writeExclusive = vi.spyOn(fs, "writeExclusive");
    await expect(
      workspace.applyEdits({
        allowedPaths: ["file.txt"],
        edits: [{ path: "file.txt", expectedDigest: null, content: "\u00e9".repeat(5) }],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_EDIT_LIMIT_EXCEEDED" });
    expect(writeExclusive).not.toHaveBeenCalled();
  });

  it.each(["Binary\0content", "Unpaired surrogate: \ud800"])(
    "rejects edit content that cannot round-trip as source text: %j",
    async (content) => {
      const { fs, workspace } = await prepareSource();
      const writeExclusive = vi.spyOn(fs, "writeExclusive");
      await expect(
        workspace.applyEdits({
          allowedPaths: ["file.txt"],
          edits: [{ path: "file.txt", expectedDigest: null, content }],
        }),
      ).rejects.toMatchObject({ code: "SOURCE_NOT_TEXT" });
      expect(writeExclusive).not.toHaveBeenCalled();
    },
  );

  it.each(["read", "write"])(
    "limits the total %s bytes of an edit batch before mutations",
    async (operation) => {
      const oldContent = operation === "read" ? "a".repeat(2_500) : "a";
      const newContent = operation === "write" ? "b".repeat(2_500) : "b";
      const { fs, workspace } = await prepareSource(
        editableInput(),
        {
          "first.txt": oldContent,
          "second.txt": oldContent,
        },
        { maximumInputBytes: 4_096, maximumArtifactBytes: 3_072 },
      );
      const replaceFile = vi.spyOn(fs, "replaceFile");
      await expect(
        workspace.applyEdits({
          allowedPaths: ["first.txt", "second.txt"],
          edits: ["first.txt", "second.txt"].map((path) => ({
            path,
            expectedDigest: textDigest(oldContent),
            content: newContent,
          })),
        }),
      ).rejects.toMatchObject({ code: "SOURCE_EDIT_LIMIT_EXCEEDED" });
      expect(replaceFile).not.toHaveBeenCalled();
      expect(fs.removed).toEqual([]);
    },
  );

  it("accounts for the read and write batch budgets separately", async () => {
    const oldContent = "a".repeat(3_000);
    const newContent = "b".repeat(3_000);
    const { workspace } = await prepareSource(
      editableInput(),
      { "file.txt": oldContent },
      {
        maximumInputBytes: 4_096,
        maximumArtifactBytes: 4_096,
      },
    );
    await workspace.applyEdits({
      allowedPaths: ["file.txt"],
      edits: [{ path: "file.txt", expectedDigest: textDigest(oldContent), content: newContent }],
    });
    expect((await workspace.readSourceFile("file.txt")).content).toBe(newContent);
  });
});

describe("native investigation PR diff manifests and chunks", () => {
  it("caches validated immutable manifests and chunks behind lightweight binding checks", async () => {
    const {
      fs,
      workspace,
      state,
      readPrDiffManifest,
      readPrDiffChunks,
      assertBinding,
      assertReadBinding,
    } = await preparePrDiff(undefined, true, true);
    const directoryReads = vi.spyOn(fs, "readDirectory");
    assertBinding.mockClear();
    const manifest = await workspace.readPrDiffManifest();
    const ids = manifest.chunks.map((chunk) => chunk.id);
    const first = await workspace.readPrDiffChunks!(ids);
    Object.assign(manifest, { baseSha: "f".repeat(40) });
    Object.assign(first[0]!, { content: "caller mutation" });
    expect(await workspace.readPrDiffManifest()).toEqual(state.manifest);
    expect(await workspace.readPrDiffChunks!(ids)).toEqual(ids.map((id) => state.chunks.get(id)));
    expect(readPrDiffManifest).toHaveBeenCalledTimes(1);
    expect(readPrDiffChunks).toHaveBeenCalledTimes(1);
    expect(assertBinding).not.toHaveBeenCalled();
    expect(assertReadBinding).toHaveBeenCalled();
    expect(
      directoryReads.mock.calls.some(([path]) => path.startsWith(workspace.sourceDirectory!)),
    ).toBe(false);
    await workspace.assertSourceBinding();
    expect(assertBinding).toHaveBeenCalledTimes(1);
    assertReadBinding.mockRejectedValueOnce(new Error("The source metadata changed."));
    await expect(workspace.readPrDiffChunks!(ids)).rejects.toThrow("The source metadata changed.");
  });

  it("reads only missing chunks when later requests overlap the immutable cache", async () => {
    const { workspace, readPrDiffChunks } = await preparePrDiff(undefined, true, true);
    await workspace.readPrDiffChunks!(["pr-diff-diff", "pr-diff-head"]);
    const reordered = await workspace.readPrDiffChunks!([
      "pr-diff-head",
      "pr-diff-base",
      "pr-diff-diff",
    ]);
    expect(reordered.map((chunk) => chunk.id)).toEqual([
      "pr-diff-head",
      "pr-diff-base",
      "pr-diff-diff",
    ]);
    expect(readPrDiffChunks.mock.calls.map(([ids]) => ids)).toEqual([
      ["pr-diff-diff", "pr-diff-head"],
      ["pr-diff-base"],
    ]);
  });

  it("passes bounded file observations to the lightweight blob guard without rescanning unrelated source", async () => {
    const { fs, workspace, assertBinding, assertReadBinding } = await prepareSource(
      undefined,
      undefined,
      undefined,
      true,
    );
    const directoryReads = vi.spyOn(fs, "readDirectory");
    assertBinding.mockClear();
    const file = await workspace.readSourceFile("src/file.txt");
    expect(assertReadBinding).toHaveBeenLastCalledWith(expect.objectContaining(file));
    expect(assertBinding).not.toHaveBeenCalled();
    expect(
      directoryReads.mock.calls.some(([path]) => path.startsWith(workspace.sourceDirectory!)),
    ).toBe(false);
    fs.change(win32.join(workspace.sourceDirectory!, "src"), { reparsePoint: true });
    await expect(workspace.readSourceFile("src/file.txt")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
  });

  it("returns complete frozen PR content and isolates the registered manifest from caller mutation", async () => {
    const { workspace, state, readPrDiffChunk } = await preparePrDiff();
    const manifest = await workspace.readPrDiffManifest();
    expect(manifest).toEqual(state.manifest);
    Object.assign(manifest, { baseSha: "f".repeat(40) });
    expect(await workspace.readPrDiffManifest()).toEqual(state.manifest);
    for (const descriptor of state.manifest.chunks) {
      expect(await workspace.readPrDiffChunk(descriptor.id)).toEqual(
        state.chunks.get(descriptor.id),
      );
    }
    expect(readPrDiffChunk).toHaveBeenCalledTimes(3);
  });

  it("rejects a chunk identifier outside the frozen manifest before reading upstream content", async () => {
    const { workspace, readPrDiffChunk } = await preparePrDiff();
    await expect(workspace.readPrDiffChunk("unregistered-chunk")).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
    expect(readPrDiffChunk).not.toHaveBeenCalled();
  });

  it.each(["subjectRef", "baseSha", "headSha"] as const)(
    "rejects a PR manifest bound to another %s",
    async (field) => {
      const { workspace, state } = await preparePrDiff();
      const { digest: _digest, ...payload } = state.manifest;
      state.manifest = withManifestDigest({
        ...payload,
        [field]: field === "subjectRef" ? "another-subject" : "f".repeat(40),
      });
      await expect(workspace.readPrDiffManifest()).rejects.toMatchObject({
        code: "SOURCE_BINDING_MISMATCH",
      });
    },
  );

  it("rejects manifest digest tampering and changes after the first frozen read", async () => {
    const { workspace, state } = await preparePrDiff();
    await workspace.readPrDiffManifest();
    const { digest: _digest, ...payload } = state.manifest;
    state.manifest = { ...state.manifest, digest: "0".repeat(64) };
    await expect(workspace.readPrDiffManifest()).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
    state.manifest = withManifestDigest({ ...payload, mergeBaseSha: "e".repeat(40) });
    await expect(workspace.readPrDiffManifest()).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
  });

  it.each(["content", "descriptor"])(
    "rejects tampered chunk %s against the registered manifest",
    async (tampering) => {
      const { workspace, state } = await preparePrDiff();
      await workspace.readPrDiffManifest();
      const original = state.chunks.get("pr-diff-diff");
      if (original === undefined) throw new Error("The complete diff chunk must exist.");
      state.chunks.set(
        original.id,
        tampering === "content"
          ? { ...original, content: "Truncated or changed bytes" }
          : { ...original, path: "different.txt" },
      );
      await expect(workspace.readPrDiffChunk(original.id)).rejects.toMatchObject({
        code: "SOURCE_BINDING_MISMATCH",
      });
    },
  );

  it("rejects a missing base stream even when the remaining manifest digest is internally consistent", async () => {
    const { workspace, state } = await preparePrDiff();
    const { digest: _digest, ...payload } = state.manifest;
    state.manifest = withManifestDigest({
      ...payload,
      files: payload.files.map((file) => ({
        ...file,
        chunkIds: file.chunkIds.filter((id) => id !== "pr-diff-base"),
      })),
      chunks: payload.chunks.filter((chunk) => chunk.id !== "pr-diff-base"),
    });
    await expect(workspace.readPrDiffManifest()).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
  });

  it("requires contiguous chunk ordinals for every complete content stream", async () => {
    const { workspace, state } = await preparePrDiff();
    const { digest: _digest, ...payload } = state.manifest;
    state.manifest = withManifestDigest({
      ...payload,
      chunks: payload.chunks.map((chunk) =>
        chunk.kind === "head" ? { ...chunk, ordinal: 1 } : chunk,
      ),
    });
    await expect(workspace.readPrDiffManifest()).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
  });

  it("rejects a complete chunk over the serialized byte budget without truncating it", async () => {
    const { workspace, state } = await preparePrDiff({
      diff: "\n".repeat(33_000),
      base: "old\n",
      head: "new\n",
    });
    await expect(workspace.readPrDiffChunk("pr-diff-diff")).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(state.chunks.get("pr-diff-diff")?.content).toHaveLength(33_000);
  });

  it("validates one complete source batch between two binding checks", async () => {
    const { workspace, state, readPrDiffChunk, readPrDiffChunks, assertBinding } =
      await preparePrDiff(undefined, true);
    const events: string[] = [];
    assertBinding.mockImplementation(async () => {
      events.push("binding");
    });
    readPrDiffChunks.mockImplementation(async (ids) => {
      events.push("batch");
      return ids.map((id) => state.chunks.get(id)!);
    });
    const ids = ["pr-diff-diff", "pr-diff-base", "pr-diff-head"];
    const chunks = await workspace.readPrDiffChunks!(ids);
    expect(chunks.map((chunk) => chunk.id)).toEqual(ids);
    expect(events).toEqual(["binding", "batch", "binding"]);
    expect(readPrDiffChunks).toHaveBeenCalledExactlyOnceWith(ids);
    expect(readPrDiffChunk).not.toHaveBeenCalled();
  });

  it("rejects missing, reordered, duplicated, or altered batch chunks without returning partial data", async () => {
    for (const corruption of ["missing", "reordered", "duplicated", "content"] as const) {
      const { workspace, state, readPrDiffChunks } = await preparePrDiff(undefined, true);
      const first = state.chunks.get("pr-diff-diff")!;
      const second = state.chunks.get("pr-diff-head")!;
      readPrDiffChunks.mockResolvedValueOnce(
        corruption === "missing"
          ? [first]
          : corruption === "reordered"
            ? [second, first]
            : corruption === "duplicated"
              ? [first, first]
              : [first, { ...second, content: "Changed after the manifest was frozen" }],
      );
      await expect(workspace.readPrDiffChunks!([first.id, second.id])).rejects.toMatchObject({
        code: "SOURCE_BINDING_MISMATCH",
      });
    }
  });

  it("rejects a reparse point introduced during a source batch at the final tree check", async () => {
    const { fs, workspace, state, readPrDiffChunks } = await preparePrDiff(undefined, true);
    readPrDiffChunks.mockImplementation(async (ids) => {
      const path = win32.join(workspace.sourceDirectory!, "injected-link");
      fs.add(path, "file", "Outside target");
      fs.change(path, { reparsePoint: true });
      return ids.map((id) => state.chunks.get(id)!);
    });
    await expect(workspace.readPrDiffChunks!(["pr-diff-diff"])).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
  });

  it("freezes caller batch IDs before awaiting the first binding check", async () => {
    const { workspace, readPrDiffChunks, assertBinding } = await preparePrDiff(undefined, true);
    const ids = ["pr-diff-diff", "pr-diff-head"];
    assertBinding.mockImplementationOnce(async () => {
      ids.splice(0, ids.length, "pr-diff-base");
    });
    expect((await workspace.readPrDiffChunks!(ids)).map((chunk) => chunk.id)).toEqual([
      "pr-diff-diff",
      "pr-diff-head",
    ]);
    expect(readPrDiffChunks).toHaveBeenCalledExactlyOnceWith(["pr-diff-diff", "pr-diff-head"]);
  });

  it("rejects duplicate and unknown batch IDs before reading any source chunk", async () => {
    for (const ids of [["pr-diff-diff", "pr-diff-diff"], ["unregistered-chunk"]]) {
      const { workspace, readPrDiffChunk, readPrDiffChunks } = await preparePrDiff(undefined, true);
      await expect(workspace.readPrDiffChunks!(ids)).rejects.toMatchObject({
        code: "SOURCE_BINDING_MISMATCH",
      });
      expect(readPrDiffChunk).not.toHaveBeenCalled();
      expect(readPrDiffChunks).not.toHaveBeenCalled();
    }
  });

  it("preserves validated batch reads for a materializer that only provides single chunks", async () => {
    const { workspace, readPrDiffChunk, readPrDiffChunks } = await preparePrDiff();
    const ids = ["pr-diff-diff", "pr-diff-head"];
    expect((await workspace.readPrDiffChunks!(ids)).map((chunk) => chunk.id)).toEqual(ids);
    expect(readPrDiffChunk.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(readPrDiffChunks).not.toHaveBeenCalled();
  });

  it("blocks PR diff reads when the trusted materializer does not supply both required APIs", async () => {
    const { workspace } = await prepareSource(withSource(input()));
    await expect(workspace.readPrDiffManifest()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    await expect(workspace.readPrDiffChunk("pr-diff-diff")).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
});

describe("managed investigation workspace cleanup", () => {
  it("delegates cleanup with its retained receipt without deleting parent-process paths", async () => {
    const cleanupOwned = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {});
    const ownershipRecorded = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {});
    const fixture = setup(undefined, { cleanupOwned, onOwnershipEstablished: ownershipRecorded });
    const workspace = await fixture.provider.prepare(input(), fixture.context);
    await workspace.cleanup();
    await workspace.cleanup();
    expect(cleanupOwned).toHaveBeenCalledTimes(1);
    expect(cleanupOwned).toHaveBeenCalledWith(ownershipRecorded.mock.calls[0]![0]);
    expect(fixture.fs.removed).toEqual([]);
  });

  it("waits for managed cleanup and retains the workspace if that cleanup fails", async () => {
    const completeCleanup = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanupOwned = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {
      cleanupStarted.resolve();
      await completeCleanup.promise;
    });
    const fixture = setup(undefined, { cleanupOwned });
    const workspace = await fixture.provider.prepare(input(), fixture.context);
    const cleaning = workspace.cleanup();
    await cleanupStarted.promise;
    await expect(workspace.cleanup()).rejects.toMatchObject({ code: "WORKSPACE_CLOSED" });
    expect(fixture.fs.removed).toEqual([]);
    completeCleanup.reject(new Error("Synthetic managed cleanup failure."));
    await expect(cleaning).rejects.toThrow("managed cleanup failure");
    expect(await fixture.fs.lstat(workspace.attemptDirectory)).not.toBeNull();
    expect(fixture.fs.removed).toEqual([]);
  });

  it("uses managed cleanup when source preparation fails after establishing ownership", async () => {
    const cleanupOwned = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {});
    const fixture = setup(
      {
        materialize: async () => {
          throw new Error("Synthetic source preparation failure.");
        },
      },
      { cleanupOwned },
    );
    const value = withSource(input());
    await expect(fixture.provider.prepare(value, fixture.context)).rejects.toThrow(
      "source preparation failure",
    );
    expect(cleanupOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: value.task.id,
        attemptId: value.attempt.id,
        leaseVersion: value.attempt.leaseVersion,
      }),
    );
    expect(fixture.fs.removed).toEqual([]);
  });

  it("retains source ownership when its process cleanup is unconfirmed", async () => {
    const cleanupOwned = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {});
    const fault = Object.assign(new Error("Synthetic source cleanup was not confirmed."), {
      code: "SOURCE_PROCESS_CLEANUP_UNCONFIRMED",
    });
    const fixture = setup(
      {
        materialize: async () => {
          throw fault;
        },
      },
      { cleanupOwned },
    );
    await expect(fixture.provider.prepare(withSource(input()), fixture.context)).rejects.toBe(
      fault,
    );
    expect(cleanupOwned).not.toHaveBeenCalled();
    expect(fixture.fs.removed).toEqual([]);
    expect(await fixture.fs.readDirectory(root)).toHaveLength(1);
  });

  it("retains an unrecorded directory when its owner marker cannot be written", async () => {
    const cleanupOwned = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {});
    const fixture = setup(undefined, { cleanupOwned });
    vi.spyOn(fixture.fs, "writeExclusive").mockRejectedValueOnce(
      new Error("Synthetic owner marker write failure."),
    );
    await expect(fixture.provider.prepare(input(), fixture.context)).rejects.toMatchObject({
      code: "WORKSPACE_CLEANUP_UNCONFIRMED",
      errors: [
        expect.any(Error),
        expect.objectContaining({ code: "WORKSPACE_RECOVERY_OWNERSHIP_MISSING" }),
      ],
    });
    expect(cleanupOwned).not.toHaveBeenCalled();
    expect(fixture.fs.removed).toEqual([]);
    const names = await fixture.fs.readDirectory(root);
    expect(names).toHaveLength(1);
    expect(await fixture.fs.readDirectory(win32.join(root, names[0]!))).toEqual([]);
  });

  it("can delegate early owned cleanup before its journal callback runs", async () => {
    const cleanupOwned = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {});
    const ownershipRecorded = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {});
    const fixture = setup(undefined, { cleanupOwned, onOwnershipEstablished: ownershipRecorded });
    vi.spyOn(fixture.fs, "setReadOnly").mockRejectedValueOnce(
      new Error("Synthetic owner permissions failure."),
    );
    await expect(fixture.provider.prepare(input(), fixture.context)).rejects.toThrow(
      "owner permissions failure",
    );
    expect(ownershipRecorded).not.toHaveBeenCalled();
    expect(cleanupOwned).toHaveBeenCalledTimes(1);
    expect(fixture.fs.removed).toEqual([]);
  });

  it("keeps the private cleanup receipt independent of the emitted journal copy", async () => {
    const cleanupOwned = vi.fn(async (_receipt: InvestigationWorkspaceOwnershipReceipt) => {});
    const fixture = setup(undefined, {
      cleanupOwned,
      onOwnershipEstablished: async (receipt) => {
        (receipt as { nonce: string }).nonce = "mutated-callback-copy";
      },
    });
    const workspace = await fixture.provider.prepare(input(), fixture.context);
    const original = JSON.parse(
      Buffer.from(
        await fixture.fs.readFile(win32.join(workspace.attemptDirectory, ".owner.json")),
      ).toString("utf8"),
    );
    await workspace.cleanup();
    expect(cleanupOwned.mock.calls[0]![0].nonce).toBe(original.nonce);
    expect(fixture.fs.removed).toEqual([]);
  });
});

describe("owned investigation workspace recovery", () => {
  it("keeps full production workspace source binding valid after an execution build creates internal generated hardlinks", async () => {
    const f = setup();
    f.fs.add("C:\\", "directory");
    const value = input();
    value.task.kind = "pr-e2e";
    value.task.executionPolicy = {
      ...value.task.executionPolicy,
      mode: "execute",
      allowRepositoryExecution: true,
      authorizationRef: "execution",
    };
    const subject = value.task.subjects[0]!;
    if (subject.kind !== "original_pr") throw new Error("Expected a PR source subject.");
    subject.revisionKey = textDigest(`${subject.baseSha}\0${subject.headSha}`);
    (value.inputSnapshot as InvestigationInputSnapshotV1).subjectRevisionKey = subject.revisionKey;
    const materializer = new ProductionInvestigationGitSourceMaterializer({
      gitExecutablePath: "C:\\Tools\\git.exe",
      allowedRepositories: [value.task.repository.fullName],
      fileSystem: f.fs,
      environment: { SYSTEMROOT: "C:\\Windows", PATH: "C:\\Tools;C:\\Windows\\System32" },
      limits: {
        hardTimeoutMs: 30_000,
        maximumProcessCount: 8,
        maximumMemoryBytes: 512 * 1024 * 1024,
        maximumOutputBytes: 4 * 1024 * 1024,
      },
      runner: {
        async run(spec) {
          const args = [...spec.arguments];
          while (args[0] === "-c") args.splice(0, 2);
          const source = spec.workingDirectory,
            git = win32.join(source, ".git");
          let stdout = "";
          if (args[0] === "init") {
            f.fs.add(git, "directory");
            f.fs.add(win32.join(git, "config"), "file", "[core]\n");
            f.fs.add(win32.join(git, "HEAD"), "file", "initial");
          } else if (args[0] === "rev-parse")
            stdout = args[2] === "HEAD^{commit}" ? subject.headSha : args[2]!.slice(0, 40);
          else if (args[0] === "merge-base") stdout = subject.baseSha;
          else if (args[0] === "ls-tree") stdout = `100644 blob ${"a".repeat(40)}\tproduct.cs\0`;
          else if (args[0] === "checkout") {
            f.fs.change(win32.join(git, "HEAD"), { bytes: Buffer.from(subject.headSha) });
            f.fs.add(win32.join(git, "index"), "file", "index");
            f.fs.add(win32.join(source, "product.cs"), "file", "class Product {}\n");
          }
          return { exitCode: 0, stdout: Buffer.from(stdout) };
        },
      },
    });
    const provider = new ProductionInvestigationWorkspaceProvider({
      workspaceRootDirectory: root,
      fileSystem: f.fs,
      sourceMaterializer: materializer,
    });
    const workspace = await provider.prepare(value, f.context);
    const paths = addGeneratedHardlinks(f.fs, win32.join(workspace.sourceDirectory!, "generated"));
    await expect(workspace.assertSourceBinding()).resolves.toBeUndefined();
    await expect(workspace.readSourceFile("generated/one.dat")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    const chmod = vi.spyOn(f.fs, "setReadOnly");
    await expect(workspace.cleanup()).resolves.toBeUndefined();
    expect(chmod.mock.calls.some(([path]) => paths.includes(path))).toBe(false);
  });

  it("unlinks closed generated hardlink groups without chmod and without needing Git metadata", async () => {
    const fixture = await prepareRecoveryWorkspace();
    const paths = addGeneratedHardlinks(
      fixture.fs,
      win32.join(fixture.workspace.attemptDirectory, "source"),
    );
    const chmod = vi.spyOn(fixture.fs, "setReadOnly");
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).resolves.toEqual({
      state: "removed",
    });
    expect(fixture.fs.removed.filter((path) => paths.includes(path))).toHaveLength(2);
    expect(chmod.mock.calls.some(([path]) => paths.includes(path))).toBe(false);
  });

  it("does not chmod readonly generated hardlinks when the filesystem refuses unlink", async () => {
    const fixture = await prepareRecoveryWorkspace();
    const paths = addGeneratedHardlinks(
      fixture.fs,
      win32.join(fixture.workspace.attemptDirectory, "source"),
      true,
    );
    const chmod = vi.spyOn(fixture.fs, "setReadOnly");
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(chmod.mock.calls.some(([path]) => paths.includes(path))).toBe(false);
    for (const path of paths) expect(fixture.fs.entry(path).readOnly).toBe(true);
    expect(
      await fixture.fs.lstat(win32.join(fixture.workspace.attemptDirectory, ".owner.json")),
    ).not.toBeNull();
  });

  it.each(["outside", "control", "artifacts", "model-input", ".git"] as const)(
    "rejects generated groups with an unaccounted or protected %s alias before changing any entry",
    async (location) => {
      const fixture = await prepareRecoveryWorkspace();
      const paths = addGeneratedHardlinks(
        fixture.fs,
        win32.join(fixture.workspace.attemptDirectory, "source"),
      );
      if (location === "outside") {
        fixture.fs.entries.delete(key(paths[1]!));
        const sentinel = win32.join(root, "sentinel.dat");
        fixture.fs.add(sentinel, "file", "Outside sentinel");
        fixture.fs.change(sentinel, {
          identity: fixture.fs.entry(paths[0]!).identity,
          linkCount: 2,
          readOnly: true,
        });
      } else {
        const parent =
          location === ".git"
            ? win32.join(fixture.workspace.attemptDirectory, "source", ".git")
            : win32.join(fixture.workspace.attemptDirectory, location);
        if (!fixture.fs.entries.has(key(parent))) fixture.fs.add(parent, "directory");
        const replacement = win32.join(parent, "protected.dat");
        const prior = fixture.fs.entry(paths[1]!);
        fixture.fs.entries.delete(key(paths[1]!));
        fixture.fs.add(replacement, "file", "Protected bytes");
        fixture.fs.change(replacement, { identity: prior.identity, linkCount: 2 });
      }
      const chmod = vi.spyOn(fixture.fs, "setReadOnly");
      await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
        code: "WORKSPACE_PATH_UNSAFE",
      });
      expect(fixture.fs.removed).toEqual([]);
      expect(chmod).not.toHaveBeenCalled();
    },
  );

  it.each(["external-link", "replacement", "parent"] as const)(
    "rechecks remaining hardlink identities after the first unlink: %s",
    async (change) => {
      const fixture = await prepareRecoveryWorkspace();
      const directory = win32.join(fixture.workspace.attemptDirectory, "source");
      const paths = addGeneratedHardlinks(fixture.fs, directory);
      const originalRemove = fixture.fs.removeFile.bind(fixture.fs);
      let mutated = false;
      vi.spyOn(fixture.fs, "removeFile").mockImplementation(async (path) => {
        await originalRemove(path);
        if (!mutated && paths.includes(path)) {
          mutated = true;
          const remaining = paths.find((entry) => entry !== path)!;
          if (change === "external-link") fixture.fs.change(remaining, { linkCount: 2 });
          if (change === "replacement") fixture.fs.change(remaining, { identity: "replaced-file" });
          if (change === "parent") fixture.fs.change(directory, { identity: "replaced-parent" });
        }
      });
      const chmod = vi.spyOn(fixture.fs, "setReadOnly");
      await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
        code: change === "external-link" ? "WORKSPACE_PATH_UNSAFE" : "WORKSPACE_NOT_OWNED",
      });
      expect(fixture.fs.removed.filter((path) => paths.includes(path))).toHaveLength(1);
      expect(chmod.mock.calls.some(([path]) => paths.includes(path))).toBe(false);
    },
  );

  it("awaits durable ownership recording before preparing any child directories", async () => {
    const ownershipStarted = Promise.withResolvers<InvestigationWorkspaceOwnershipReceipt>();
    const ownershipDurable = Promise.withResolvers<void>();
    const fixture = setup(undefined, {
      onOwnershipEstablished: async (receipt) => {
        ownershipStarted.resolve(receipt);
        await ownershipDurable.promise;
      },
    });
    const preparing = fixture.provider.prepare(input(), fixture.context);
    const receipt = await ownershipStarted.promise;
    const [attemptName] = await fixture.fs.readDirectory(root);
    expect(attemptName).toBeDefined();
    const attemptDirectory = win32.join(root, attemptName!);
    expect(await fixture.fs.readDirectory(attemptDirectory)).toEqual([".owner.json"]);
    const marker = fixture.fs.entry(win32.join(attemptDirectory, ".owner.json"));
    expect(marker.readOnly).toBe(true);
    expect(JSON.parse(Buffer.from(marker.bytes).toString("utf8"))).toEqual({
      taskId: receipt.taskId,
      attemptId: receipt.attemptId,
      leaseVersion: receipt.leaseVersion,
      nonce: receipt.nonce,
    });
    expect(receipt.ownerDigest).toBe(createHash("sha256").update(marker.bytes).digest("hex"));
    ownershipDurable.resolve();
    const workspace = await preparing;
    await workspace.cleanup();
  });

  it("cleans a preparation that cannot durably record its ownership", async () => {
    const fixture = setup(undefined, {
      onOwnershipEstablished: async () => {
        throw new Error("Synthetic durable journal failure.");
      },
    });
    await expect(fixture.provider.prepare(input(), fixture.context)).rejects.toThrow(
      "durable journal failure",
    );
    expect(await fixture.fs.readDirectory(root)).toEqual([]);
  });

  it("removes only the exact recorded attempt and is idempotent after removal", async () => {
    const fixture = await prepareRecoveryWorkspace();
    const unrelated = win32.join(root, "unrelated-attempt");
    fixture.fs.add(unrelated, "directory");
    fixture.fs.add(win32.join(unrelated, "keep.txt"), "file", "Keep this unrelated content.");
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).resolves.toEqual({
      state: "removed",
    });
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).resolves.toEqual({
      state: "already-absent",
    });
    expect(await fixture.fs.lstat(root)).not.toBeNull();
    expect(await fixture.fs.readDirectory(unrelated)).toEqual(["keep.txt"]);
  });

  it.each([
    { taskId: "another-task" },
    { attemptId: "another-attempt" },
    { leaseVersion: 9001 },
    { workspaceRootDirectory: "C:\\another-root" },
    { nonce: "00000000-0000-4000-8000-000000000000" },
    { rootIdentity: "another-root-identity" },
    { attemptIdentity: "another-attempt-identity" },
    { ownerIdentity: "another-owner-identity" },
    { ownerDigest: "0".repeat(64) },
  ] satisfies Partial<InvestigationWorkspaceOwnershipReceipt>[])(
    "rejects a mismatched ownership receipt without deleting entries: %j",
    async (changes) => {
      const fixture = await prepareRecoveryWorkspace();
      await expect(
        cleanupOwnedInvestigationAttempt({
          ...fixture.recovery,
          ownership: { ...fixture.ownership, ...changes },
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_OWNED" });
      expect(fixture.fs.removed).toEqual([]);
    },
  );

  it("requires explicit trusted process cleanup evidence", async () => {
    const fixture = await prepareRecoveryWorkspace();
    await expect(
      cleanupOwnedInvestigationAttempt({
        ...fixture.recovery,
        processesStopped: false,
      } as unknown as CleanupOwnedInvestigationAttemptOptions),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_OWNED" });
    expect(fixture.fs.removed).toEqual([]);
  });

  it("rejects a self-consistent receipt nonce that does not match the original owner marker", async () => {
    const fixture = await prepareRecoveryWorkspace();
    const nonce = "00000000-0000-4000-8000-000000000000";
    const ownerDigest = textDigest(
      JSON.stringify({
        taskId: fixture.ownership.taskId,
        attemptId: fixture.ownership.attemptId,
        leaseVersion: fixture.ownership.leaseVersion,
        nonce,
      }),
    );
    await expect(
      cleanupOwnedInvestigationAttempt({
        ...fixture.recovery,
        ownership: { ...fixture.ownership, nonce, ownerDigest },
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_OWNED" });
    expect(fixture.fs.removed).toEqual([]);
  });

  it("rejects a copied ownership marker after the attempt directory is replaced", async () => {
    const fixture = await prepareRecoveryWorkspace();
    fixture.fs.change(fixture.workspace.attemptDirectory, { identity: "replaced-directory" });
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_OWNED",
    });
    expect(fixture.fs.removed).toEqual([]);
  });

  it("rejects a changed ownership marker even when its file identity is unchanged", async () => {
    const fixture = await prepareRecoveryWorkspace();
    fixture.fs.change(win32.join(fixture.workspace.attemptDirectory, ".owner.json"), {
      bytes: Buffer.from('{"owner":"different"}'),
    });
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_OWNED",
    });
    expect(fixture.fs.removed).toEqual([]);
  });

  it.each(["ancestor", "root", "attempt", "child"] as const)(
    "refuses a redirected %s before removing any entry",
    async (location) => {
      const fixture = await prepareRecoveryWorkspace();
      const path = {
        ancestor: "C:\\",
        root,
        attempt: fixture.workspace.attemptDirectory,
        child: fixture.workspace.tempDirectory,
      }[location];
      fixture.fs.change(path, { reparsePoint: true });
      await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
        code: "WORKSPACE_PATH_UNSAFE",
      });
      expect(fixture.fs.removed).toEqual([]);
    },
  );

  it("refuses linked files anywhere in the recorded tree", async () => {
    const fixture = await prepareRecoveryWorkspace();
    const unsafe = win32.join(fixture.workspace.tempDirectory, "linked.txt");
    fixture.fs.add(unsafe, "file", "Linked content must remain untouched.");
    fixture.fs.change(unsafe, { linkCount: 2 });
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNSAFE",
    });
    expect(fixture.fs.removed).toEqual([]);
  });

  it("retains a non-empty attempt whose marker disappeared", async () => {
    const fixture = await prepareRecoveryWorkspace();
    fixture.fs.entries.delete(key(win32.join(fixture.workspace.attemptDirectory, ".owner.json")));
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_OWNED",
    });
    expect(fixture.fs.removed).toEqual([]);
  });

  it("finishes the last directory removal after a crash removed its owner marker", async () => {
    const fixture = await prepareRecoveryWorkspace();
    for (const path of fixture.fs.entries.keys()) {
      if (path.startsWith(`${key(fixture.workspace.attemptDirectory)}\\`))
        fixture.fs.entries.delete(path);
    }
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).resolves.toEqual({
      state: "removed",
    });
    expect(fixture.fs.removed).toEqual([fixture.workspace.attemptDirectory]);
  });

  it("does not delete an unrecorded empty directory at the same attempt path", async () => {
    const fixture = await prepareRecoveryWorkspace();
    for (const path of fixture.fs.entries.keys()) {
      if (path.startsWith(`${key(fixture.workspace.attemptDirectory)}\\`))
        fixture.fs.entries.delete(path);
    }
    fixture.fs.change(fixture.workspace.attemptDirectory, {
      identity: "unrecorded-empty-directory",
    });
    await expect(cleanupOwnedInvestigationAttempt(fixture.recovery)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_OWNED",
    });
    expect(fixture.fs.removed).toEqual([]);
  });

  it("checks the complete recovery tree budget before deleting entries", async () => {
    const fixture = await prepareRecoveryWorkspace();
    await expect(
      cleanupOwnedInvestigationAttempt({ ...fixture.recovery, maximumTreeEntries: 2 }),
    ).rejects.toMatchObject({ code: "WORKSPACE_TREE_LIMIT_EXCEEDED" });
    expect(fixture.fs.removed).toEqual([]);
  });

  it("allows recovery without a receipt only after checking the exact attempt is absent", async () => {
    const fixture = await prepareRecoveryWorkspace();
    await fixture.workspace.cleanup();
    await expect(
      assertInvestigationAttemptWorkspaceAbsent(fixture.recovery),
    ).resolves.toBeUndefined();
    fixture.fs.add(fixture.workspace.attemptDirectory, "directory");
    await expect(assertInvestigationAttemptWorkspaceAbsent(fixture.recovery)).rejects.toMatchObject(
      {
        code: "WORKSPACE_RECOVERY_OWNERSHIP_MISSING",
      },
    );
    expect(await fixture.fs.lstat(fixture.workspace.attemptDirectory)).not.toBeNull();
  });

  it("does not infer ownership from an existing marker when its receipt was never persisted", async () => {
    const fixture = await prepareRecoveryWorkspace();
    await expect(assertInvestigationAttemptWorkspaceAbsent(fixture.recovery)).rejects.toMatchObject(
      {
        code: "WORKSPACE_RECOVERY_OWNERSHIP_MISSING",
      },
    );
    expect(fixture.fs.removed).toEqual([]);
  });
});
