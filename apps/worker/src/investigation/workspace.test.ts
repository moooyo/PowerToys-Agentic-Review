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
import {
  assertInvestigationSourceContext,
  type InvestigationPrDiffChunk,
  type InvestigationPrDiffManifest,
  type InvestigationSourceBinding,
  type InvestigationSourceContext,
  type InvestigationSourceDependencies,
  type InvestigationSourceMaterializer,
  InvestigationWorkspaceError,
  type InvestigationWorkspaceFileSystem,
  type InvestigationWorkspaceInput,
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
    if (this.entry(path).readOnly) throw fileError("EPERM");
    this.entries.delete(key(path));
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
    "maximumInputBytes" | "maximumArtifactBytes"
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
) {
  let fs: MemoryFileSystem;
  const assertBinding = vi.fn(async () => undefined);
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
        return { binding: sourceBinding(value), assertBinding };
      },
    },
    options,
  );
  fs = fixture.fs;
  const workspace = await fixture.provider.prepare(value, fixture.context);
  return { ...fixture, workspace, value, assertBinding };
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
  const fixture = setup({
    materialize: async () => ({
      binding: sourceBinding(value),
      assertBinding,
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
