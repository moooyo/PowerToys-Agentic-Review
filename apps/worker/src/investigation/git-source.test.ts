import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { Readable } from "node:stream";
import {
  createInvestigationPreview as createInvestigationFixture,
  investigationCanonicalJson,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessLaunchSpec,
} from "../execution/process-host-protocol.js";
import {
  type InvestigationGitCommandRunner,
  ProductionInvestigationGitCommandRunner,
  ProductionInvestigationGitSourceMaterializer,
} from "./git-source.js";
import type {
  InvestigationWorkspaceFileSystem,
  InvestigationWorkspacePathState,
} from "./workspace.js";

const source = "D:\\attempt\\source";
const sha = "b".repeat(40);
const baseSha = "d".repeat(40);
const gitDirectory = win32.join(source, ".git");
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class MemoryFileSystem implements InvestigationWorkspaceFileSystem {
  readonly reads: string[] = [];
  readonly entries = new Map<
    string,
    { state: InvestigationWorkspacePathState; bytes: Uint8Array }
  >();
  #sequence = 0;
  constructor() {
    for (const path of ["D:\\", "D:\\attempt", source]) this.put(path, "directory");
  }
  put(path: string, kind: "directory" | "file", content = "") {
    const previous = this.entries.get(path);
    this.entries.set(path, {
      state: {
        kind,
        identity: previous?.state.identity ?? String(++this.#sequence),
        reparsePoint: false,
        linkCount: 1,
      },
      bytes: Buffer.from(content),
    });
  }
  async lstat(path: string) {
    return this.entries.get(path)?.state ?? null;
  }
  async realpath(path: string) {
    return path;
  }
  async readDirectory(path: string) {
    return [...this.entries.keys()]
      .filter((entry) => entry !== path && win32.dirname(entry) === path)
      .map((entry) => win32.basename(entry));
  }
  async createDirectory(path: string) {
    this.put(path, "directory");
  }
  async writeExclusive(path: string, bytes: Uint8Array) {
    if (this.entries.has(path)) throw new Error("File exists.");
    this.put(path, "file");
    this.entries.get(path)!.bytes = Uint8Array.from(bytes);
  }
  async readFile(path: string) {
    this.reads.push(path);
    const entry = this.entries.get(path);
    if (!entry) throw new Error("Missing file.");
    return Uint8Array.from(entry.bytes);
  }
  async replaceFile(path: string, bytes: Uint8Array, expectedIdentity: string) {
    const entry = this.entries.get(path);
    if (!entry || entry.state.identity !== expectedIdentity)
      throw new Error("File identity changed.");
    entry.bytes = Uint8Array.from(bytes);
  }
  async setReadOnly() {
    /* The in-memory fixture has no ambient filesystem. */
  }
  async removeFile(path: string) {
    this.entries.delete(path);
  }
  async removeEmptyDirectory(path: string) {
    this.entries.delete(path);
  }
}

function fixture() {
  const { task, attempt } = createInvestigationFixture("pr");
  task.executionPolicy.mode = "source_read";
  const subject = task.subjects[0]!;
  if (subject.kind !== "original_pr") throw new Error("A PR fixture is required.");
  subject.revisionKey = hash(`${baseSha}\0${sha}`);
  const fs = new MemoryFileSystem();
  const calls: ProcessLaunchSpec[] = [];
  let patch = "";
  let diffListing = "M\0src/value.ts\0";
  const blobs = new Map<string, string>([
    [`${baseSha}:src/value.ts`, "export const value = 0;\n"],
    [`${sha}:src/value.ts`, "export const value = 1;\n"],
  ]);
  const rawBlobs = new Map<string, Uint8Array>();
  const grepResults: Array<{ exitCode: number; stdout: string }> = [];
  let listing = `100644 blob ${"f".repeat(40)}\tsrc/value.ts\0`;
  const revisionListings = new Map<string, string>();
  const diffContents = new Map<string, string>();
  const runner: InvestigationGitCommandRunner = {
    async run(spec) {
      calls.push(structuredClone(spec));
      const argumentsList = [...spec.arguments];
      while (argumentsList[0] === "-c") argumentsList.splice(0, 2);
      const command = argumentsList[0];
      let stdout = "";
      if (command === "init") {
        fs.put(gitDirectory, "directory");
        fs.put(win32.join(gitDirectory, "config"), "file", "[core]\nrepositoryformatversion = 0\n");
        fs.put(win32.join(gitDirectory, "HEAD"), "file", "ref: refs/heads/investigation\n");
      } else if (command === "rev-parse") {
        stdout =
          argumentsList[2] === "HEAD^{commit}" ? `${sha}\n` : `${argumentsList[2]!.slice(0, 40)}\n`;
      } else if (command === "ls-tree")
        stdout = revisionListings.get(argumentsList.at(-1)!) ?? listing;
      else if (command === "merge-base") stdout = `${baseSha}\n`;
      else if (command === "checkout") {
        fs.put(win32.join(gitDirectory, "HEAD"), "file", `${sha}\n`);
        fs.put(win32.join(gitDirectory, "index"), "file", "frozen-index");
        fs.put(win32.join(source, "src"), "directory");
        fs.put(win32.join(source, "src", "value.ts"), "file", "export const value = 1;\n");
        for (const record of (revisionListings.get(sha) ?? listing).split("\0")) {
          const match = /^120000 blob [a-f0-9]{40}\t(.+)$/u.exec(record);
          if (match === null) continue;
          const path = match[1]!;
          const segments = path.split("/");
          for (let length = 1; length < segments.length; length++)
            fs.put(win32.join(source, ...segments.slice(0, length)), "directory");
          const content = blobs.get(`${sha}:${path}`);
          if (content === undefined) throw new Error("Missing synthetic symlink blob.");
          fs.put(win32.join(source, ...segments), "file", content);
        }
      } else if (command === "read-tree")
        fs.put(spec.environment.GIT_INDEX_FILE!, "file", "private-index");
      else if (command === "diff")
        stdout = argumentsList.includes("--name-status")
          ? diffListing
          : argumentsList.includes(baseSha)
            ? (diffContents.get(argumentsList.at(-1)!) ??
              `diff --git a/${argumentsList.at(-1)} b/${argumentsList.at(-1)}\ncommitted source diff\n`)
            : patch;
      else if (command === "cat-file") {
        const raw = rawBlobs.get(argumentsList.at(-1)!);
        const content = blobs.get(argumentsList.at(-1)!);
        if (raw === undefined && content === undefined)
          throw new Error("Missing synthetic Git blob.");
        if (argumentsList[1] === "-s")
          stdout = `${raw?.byteLength ?? Buffer.byteLength(content!, "utf8")}\n`;
        else if (raw !== undefined) return { exitCode: 0, stdout: Uint8Array.from(raw) };
        else stdout = content!;
      } else if (command === "grep") {
        const result = grepResults.shift();
        if (result === undefined) throw new Error("Missing synthetic Git grep response.");
        return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout) };
      } else if (command === "apply" && !argumentsList.includes("--check"))
        patch = Buffer.from(await fs.readFile(argumentsList.at(-1)!)).toString("utf8");
      return { exitCode: 0, stdout: Buffer.from(stdout) };
    },
  };
  const options = {
    gitExecutablePath: "C:\\tools\\git.exe",
    allowedRepositories: ["moooyo/PowerToys"],
    environment: { SYSTEMROOT: "C:\\Windows", PATH: "C:\\tools;C:\\Windows\\System32" },
    limits: {
      hardTimeoutMs: 30_000,
      maximumProcessCount: 8,
      maximumMemoryBytes: 512 * 1024 * 1024,
      maximumOutputBytes: 4 * 1024 * 1024,
    },
    fileSystem: fs,
    runner,
  };
  const context = {
    signal: new AbortController().signal,
    processHost: {
      start: async () => {
        throw new Error("The fixture never launches a process.");
      },
      terminateAll: async () => undefined,
      close: async () => undefined,
    },
  };
  const input = { task, attempt, inputSnapshot: null, destinationDirectory: source };
  return {
    input,
    context,
    fs,
    calls,
    options,
    blobs,
    rawBlobs,
    grepResults,
    diffContents,
    setPatch: (value: string) => {
      patch = value;
    },
    setListing: (value: string, revisionSha?: string) => {
      if (revisionSha === undefined) listing = value;
      else revisionListings.set(revisionSha, value);
    },
    setDiffListing: (value: string) => {
      diffListing = value;
    },
  };
}

describe("managed native Git source materialization", () => {
  it("fetches exact public SHAs without credentials, hooks, or ambient configuration", async () => {
    const f = fixture();
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    expect(result.binding.sourceSha).toBe(sha);
    const fetches = f.calls.filter((call) => call.arguments.includes("fetch"));
    expect(fetches.map((call) => call.arguments.slice(-2))).toEqual([
      ["https://github.com/moooyo/PowerToys.git", sha],
      ["https://github.com/moooyo/PowerToys.git", baseSha],
    ]);
    for (const call of f.calls) {
      expect(call.environmentMode).toBe("replace");
      expect(call.environment).toMatchObject({
        GIT_CONFIG_GLOBAL: "NUL",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      });
      expect(call.arguments).toContain("credential.helper=");
      expect(call.arguments).toContain("core.hooksPath=NUL");
      expect(call.arguments).not.toContain("push");
    }
  });

  it("rejects a repository outside the allowlist before any Git process", async () => {
    const f = fixture();
    f.input.task.repository.fullName = "another/repository";
    await expect(
      new ProductionInvestigationGitSourceMaterializer(f.options).materialize(f.input, f.context),
    ).rejects.toMatchObject({ code: "SOURCE_REPOSITORY_NOT_ALLOWED" });
    expect(f.calls).toEqual([]);
  });

  it("rejects unsafe source tree entries before checkout", async () => {
    for (const listing of [
      `160000 commit ${sha}\tsubmodule\0`,
      `100644 blob ${sha}\t../outside\0`,
      `100644 blob ${sha}\tFile.ts\0` + `100644 blob ${sha}\tfile.ts\0`,
    ]) {
      const f = fixture();
      f.setListing(listing);
      await expect(
        new ProductionInvestigationGitSourceMaterializer(f.options).materialize(f.input, f.context),
      ).rejects.toThrow();
      expect(f.calls.some((call) => call.arguments.includes("checkout"))).toBe(false);
    }
  });

  it("retains repository symlinks as exact inert text without reading their targets", async () => {
    const f = fixture();
    const links = new Map([
      [".claude/CLAUDE.md", "../AGENTS.md"],
      [".claude/agents", "../../outside"],
      [".claude/commands", "C:\\private\\credentials.txt"],
      [".claude/rules", "\\\\server\\private"],
      [".claude/skills", "../.claude/skills"],
    ]);
    f.setListing(
      `100644 blob ${sha}\tsrc/value.ts\0` +
        [...links.keys()].map((path) => `120000 blob ${sha}\t${path}\0`).join(""),
    );
    for (const [path, target] of links) f.blobs.set(`${sha}:${path}`, target);
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    expect(result.binding.inertSymlinks).toEqual(
      [sha, baseSha].flatMap((revisionSha) =>
        [...links.keys()].map((path) => ({ path, revisionSha })),
      ),
    );
    for (const [path, target] of links) {
      const absolutePath = win32.join(source, ...path.split("/"));
      expect(f.fs.entries.get(absolutePath)).toMatchObject({
        state: { kind: "file", reparsePoint: false, linkCount: 1 },
        bytes: Buffer.from(target),
      });
    }
    expect(f.fs.reads.every((path) => path.startsWith(`${source}\\`))).toBe(true);
    expect(f.calls.every((call) => call.arguments.includes("core.symlinks=false"))).toBe(true);
    const manifest = await result.readPrDiffManifest!();
    expect(manifest.files.map((file) => file.path)).toEqual(["src/value.ts"]);
    expect(manifest.chunks.map((chunk) => chunk.kind)).toEqual(["diff", "base", "head"]);
  });

  it("keeps added, deleted, modified, and type-changed symlink bytes in complete PR coverage", async () => {
    const f = fixture();
    f.setListing(
      `120000 blob ${sha}\tmodified-link\0` +
        `120000 blob ${sha}\tdeleted-link\0` +
        `120000 blob ${sha}\ttype-change\0`,
      baseSha,
    );
    f.setListing(
      `120000 blob ${sha}\tadded-link\0` +
        `120000 blob ${sha}\tmodified-link\0` +
        `100644 blob ${sha}\ttype-change\0`,
      sha,
    );
    f.setDiffListing("A\0added-link\0D\0deleted-link\0M\0modified-link\0T\0type-change\0");
    for (const [object, content] of [
      [`${sha}:added-link`, "../../external-added"],
      [`${baseSha}:deleted-link`, "../../external-deleted"],
      [`${baseSha}:modified-link`, "old-target"],
      [`${sha}:modified-link`, "\uFEFFnew-target"],
      [`${baseSha}:type-change`, "old-link-target"],
      [`${sha}:type-change`, "ordinary file content\n"],
    ])
      f.blobs.set(object!, content!);
    f.diffContents.set(
      "type-change",
      "diff --git a/type-change b/type-change\nold mode 120000\nnew mode 100644\ncomplete mode and content diff\n",
    );
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const manifest = await result.readPrDiffManifest!();
    expect(manifest.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "added-link", status: "added" },
      { path: "deleted-link", status: "deleted" },
      { path: "modified-link", status: "modified" },
      { path: "type-change", status: "modified" },
    ]);
    const chunks = await Promise.all(
      manifest.chunks.map((chunk) => result.readPrDiffChunk!(chunk.id)),
    );
    expect(chunks.filter((chunk) => chunk.kind !== "diff").map((chunk) => chunk.content)).toEqual([
      "../../external-added",
      "../../external-deleted",
      "old-target",
      "\uFEFFnew-target",
      "old-link-target",
      "ordinary file content\n",
    ]);
    expect(
      chunks.find((chunk) => chunk.path === "type-change" && chunk.kind === "diff")?.content,
    ).toContain("old mode 120000\nnew mode 100644");
    expect(result.binding.inertSymlinks).toContainEqual({
      path: "type-change",
      revisionSha: baseSha,
    });
    expect(result.binding.inertSymlinks).not.toContainEqual({
      path: "type-change",
      revisionSha: sha,
    });
    const { digest, ...content } = manifest;
    expect(digest).toBe(hash(investigationCanonicalJson(content)));
  });

  it("still rejects symlinks for repository execution before checkout", async () => {
    const f = fixture();
    f.input.task.executionPolicy.mode = "execute";
    f.input.task.executionPolicy.allowRepositoryExecution = true;
    f.input.task.executionPolicy.authorizationRef = "synthetic-execution-authorization";
    f.setListing(`120000 blob ${sha}\tlink\0`);
    await expect(
      new ProductionInvestigationGitSourceMaterializer(f.options).materialize(f.input, f.context),
    ).rejects.toMatchObject({ code: "SOURCE_TREE_UNSUPPORTED" });
    expect(f.calls.some((call) => call.arguments.includes("checkout"))).toBe(false);
  });

  it("does not reuse immutable symlink metadata for a saved local patch", async () => {
    const f = fixture();
    const original = f.input.task.subjects[0]!;
    const subject = {
      id: "saved-patch-with-symlink",
      kind: "local_patch" as const,
      repositoryId: original.repositoryId,
      workItemId: original.workItemId,
      revisionKey: hash("saved symlink patch revision"),
      baseSubjectRef: original.id,
      baseSha: sha,
      patchDigest: hash("saved symlink patch"),
      artifactRef: "saved-symlink-patch-artifact",
    };
    f.input.task.subjects.push(subject);
    f.input.task.subjectRef = subject.id;
    f.input.task.executionPolicy.allowedSubjectRefs.push(subject.id);
    f.setListing(`120000 blob ${sha}\tlink\0`);
    await expect(
      new ProductionInvestigationGitSourceMaterializer(f.options).materialize(f.input, f.context),
    ).rejects.toMatchObject({ code: "SOURCE_TREE_UNSUPPORTED" });
    expect(f.calls.some((call) => call.arguments.includes("checkout"))).toBe(false);
  });

  it("rejects a checkout that creates a real link or replaces inert target text", async () => {
    for (const corruption of ["reparse", "hard-link", "target-content"] as const) {
      const f = fixture();
      f.setListing(`120000 blob ${sha}\tlink\0`);
      f.blobs.set(`${sha}:link`, "../../outside");
      const runner = f.options.runner;
      f.options.runner = {
        async run(spec, context) {
          const result = await runner.run(spec, context);
          if (spec.arguments.includes("checkout")) {
            const entry = f.fs.entries.get(win32.join(source, "link"))!;
            if (corruption === "reparse") entry.state = { ...entry.state, reparsePoint: true };
            else if (corruption === "hard-link") entry.state = { ...entry.state, linkCount: 2 };
            else entry.bytes = Buffer.from("unexpected resolved target contents");
          }
          return result;
        },
      };
      await expect(
        new ProductionInvestigationGitSourceMaterializer(f.options).materialize(f.input, f.context),
      ).rejects.toMatchObject({
        code: corruption === "target-content" ? "SOURCE_BINDING_MISMATCH" : "SOURCE_PATH_UNSAFE",
      });
    }
  });

  it("rejects reparse points and original-source modifications", async () => {
    const f = fixture();
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    f.setPatch("an actual tracked source change");
    await expect(result.assertBinding()).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
    f.setPatch("");
    f.fs.entries.get(win32.join(source, "src"))!.state = {
      kind: "directory",
      identity: "new-link",
      reparsePoint: true,
      linkCount: 1,
    };
    await expect(result.assertBinding()).rejects.toMatchObject({ code: "SOURCE_PATH_UNSAFE" });
  });

  it("captures implementation changes using a private index without replacing frozen Git metadata", async () => {
    const f = fixture();
    f.input.task.kind = "issue-fix";
    f.input.task.executionPolicy.mode = "execute";
    f.input.task.executionPolicy.allowRepositoryExecution = true;
    f.input.task.executionPolicy.authorizationRef = "synthetic-authorization";
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    f.setPatch("diff --git a/src/value.ts b/src/value.ts\ncomplete patch\n");
    await result.assertBinding();
    expect(Buffer.from(await result.capturePatch!(f.context.signal)).toString("utf8")).toContain(
      "complete patch",
    );
    const adds = f.calls.filter((call) => call.arguments.includes("add"));
    expect(adds[0]?.environment.GIT_INDEX_FILE).toContain("investigation-index-");
    expect(
      Buffer.from(await f.fs.readFile(win32.join(gitDirectory, "index"))).toString("utf8"),
    ).toBe("frozen-index");
  });

  it("materializes an exact saved local patch and rejects later changes to the validated subject", async () => {
    const f = fixture();
    const original = f.input.task.subjects[0]!;
    const patch = Buffer.from("diff --git a/src/value.ts b/src/value.ts\nsaved patch\n");
    const subject = {
      id: "saved-local-patch",
      kind: "local_patch" as const,
      repositoryId: original.repositoryId,
      workItemId: original.workItemId,
      revisionKey: hash("saved patch revision"),
      baseSubjectRef: original.id,
      baseSha: sha,
      patchDigest: hash(patch),
      artifactRef: "saved-patch-artifact",
    };
    f.input.task.subjects.push(subject);
    f.input.task.subjectRef = subject.id;
    f.input.task.executionPolicy.allowedSubjectRefs.push(subject.id);
    const materializer = new ProductionInvestigationGitSourceMaterializer({
      ...f.options,
      readPatchArtifact: async (_input, id) => {
        expect(id).toBe(subject.artifactRef);
        return patch;
      },
    });
    const result = await materializer.materialize(f.input, f.context);
    expect(result.binding).toMatchObject({
      subjectRef: subject.id,
      sourceSha: sha,
      patchDigest: hash(patch),
    });
    f.setPatch("different patch");
    await expect(result.assertBinding()).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
  });

  it("restores a completed mutation checkpoint without changing the original source binding", async () => {
    const f = fixture();
    f.input.task.kind = "issue-fix";
    f.input.task.executionPolicy.mode = "execute";
    f.input.task.executionPolicy.allowRepositoryExecution = true;
    f.input.task.executionPolicy.authorizationRef = "synthetic-authorization";
    const original = f.input.task.subjects[0]!;
    const patch = Buffer.from("diff --git a/src/value.ts b/src/value.ts\ncheckpoint patch\n");
    const result = await new ProductionInvestigationGitSourceMaterializer({
      ...f.options,
      restorePatchSubject: {
        id: "resumed-patch",
        kind: "local_patch",
        repositoryId: original.repositoryId,
        workItemId: original.workItemId,
        revisionKey: hash("checkpoint revision"),
        baseSubjectRef: original.id,
        baseSha: sha,
        patchDigest: hash(patch),
        artifactRef: "checkpoint-artifact",
      },
      readPatchArtifact: async () => patch,
    }).materialize(f.input, f.context);
    expect(result.binding).toMatchObject({
      subjectRef: original.id,
      sourceSha: sha,
      patchDigest: null,
    });
    expect(Buffer.from(await result.capturePatch!(f.context.signal))).toEqual(patch);
  });

  it("does not materialize source for snapshot-only tasks", async () => {
    const f = fixture();
    f.input.task.executionPolicy.mode = "snapshot_only";
    await expect(
      new ProductionInvestigationGitSourceMaterializer(f.options).materialize(f.input, f.context),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(f.calls).toHaveLength(0);
  });

  it("brokers every chunk of a large source file with a complete deterministic manifest", async () => {
    const f = fixture();
    const completeContent = "界🌍\n".repeat(40_000);
    f.blobs.set(`${sha}:src/value.ts`, completeContent);
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const manifest = await result.readPrDiffManifest!();
    const { digest, ...content } = manifest;
    expect(digest).toBe(hash(investigationCanonicalJson(content)));
    const heads = manifest.chunks.filter((chunk) => chunk.kind === "head");
    expect(heads.length).toBeGreaterThan(1);
    const delivered: string[] = [];
    for (const descriptor of heads) {
      const chunk = await result.readPrDiffChunk!(descriptor.id);
      expect(Buffer.byteLength(JSON.stringify(chunk), "utf8")).toBeLessThanOrEqual(65_536);
      expect(chunk.contentDigest).toBe(hash(chunk.content));
      expect(chunk.byteLength).toBe(Buffer.byteLength(chunk.content, "utf8"));
      delivered.push(chunk.content);
    }
    expect(delivered.join("")).toBe(completeContent);
    await expect(result.readPrDiffChunk!("unknown-chunk")).rejects.toMatchObject({
      code: "SOURCE_DIFF_UNAVAILABLE",
    });
  });

  it("retains deleted and added sides, including an empty file, without requiring files to exist at HEAD", async () => {
    const f = fixture();
    f.setDiffListing("D\0src/deleted.ts\0A\0src/empty.ts\0");
    f.blobs.set(`${baseSha}:src/deleted.ts`, "export const deleted = true;\n");
    f.blobs.set(`${sha}:src/empty.ts`, "");
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const manifest = await result.readPrDiffManifest!();
    expect(manifest.files.map((file) => ({ path: file.path, status: file.status }))).toEqual([
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/empty.ts", status: "added" },
    ]);
    expect(
      manifest.chunks.filter((chunk) => chunk.path === "src/deleted.ts").map((chunk) => chunk.kind),
    ).toEqual(["diff", "base"]);
    const emptyHead = manifest.chunks.find(
      (chunk) => chunk.path === "src/empty.ts" && chunk.kind === "head",
    )!;
    expect(await result.readPrDiffChunk!(emptyHead.id)).toMatchObject({
      byteLength: 0,
      content: "",
      ordinal: 0,
    });
  });

  it("reads every requested cached chunk with two binding checks for the whole batch", async () => {
    const f = fixture();
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const manifest = await result.readPrDiffManifest!();
    f.calls.length = 0;
    const ids = manifest.chunks.map((chunk) => chunk.id);
    const chunks = await result.readPrDiffChunks!(ids);
    expect(chunks.map((chunk) => chunk.id)).toEqual(ids);
    expect(chunks.every((chunk) => hash(chunk.content) === chunk.contentDigest)).toBe(true);
    expect(f.calls.filter((call) => call.arguments.includes("rev-parse"))).toHaveLength(2);
    expect(f.calls.filter((call) => call.arguments.includes("cat-file"))).toHaveLength(0);
    expect(f.calls.filter((call) => call.arguments.includes("merge-base"))).toHaveLength(2);
  });

  it("rejects tracked source drift observed after the batch was read", async () => {
    const f = fixture();
    let driftAfterFirstCheck = false;
    const runner = f.options.runner;
    f.options.runner = {
      async run(spec, context) {
        const result = await runner.run(spec, context);
        if (driftAfterFirstCheck && spec.arguments.includes("diff")) {
          driftAfterFirstCheck = false;
          f.setPatch("A tracked source change after the initial batch binding check");
        }
        return result;
      },
    };
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const manifest = await result.readPrDiffManifest!();
    driftAfterFirstCheck = true;
    await expect(
      result.readPrDiffChunks!(manifest.chunks.map((chunk) => chunk.id)),
    ).rejects.toMatchObject({ code: "SOURCE_BINDING_MISMATCH" });
  });

  it("rejects duplicate or unavailable batch IDs without exposing partial chunks", async () => {
    const f = fixture();
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const manifest = await result.readPrDiffManifest!();
    const id = manifest.chunks[0]!.id;
    for (const ids of [
      [id, id],
      [id, "unknown-chunk"],
    ])
      await expect(result.readPrDiffChunks!(ids)).rejects.toMatchObject({
        code: "SOURCE_DIFF_UNAVAILABLE",
      });
  });

  it("fails visibly when the full PR diff cannot fit the materialization budget", async () => {
    const f = fixture();
    const result = await new ProductionInvestigationGitSourceMaterializer({
      ...f.options,
      maximumDiffBytes: 1,
    }).materialize(f.input, f.context);
    await expect(result.readPrDiffManifest!()).rejects.toMatchObject({
      code: "SOURCE_DIFF_TOO_LARGE",
    });
  });
});

describe("managed Git immutable source dependency discovery", () => {
  const tree = (paths: readonly string[]) =>
    paths.map((path) => `100644 blob ${sha}\t${path}\0`).join("");
  const matches = (paths: readonly string[], revision = sha) =>
    paths.map((path) => `${revision}:${path}\0`).join("");

  it("reports non-lexical head seeds as unsearched without losing their complete PR chunks", async () => {
    const f = fixture();
    const document = "doc/acceptance.md";
    const content = "# Documentation-only change\n\nA complete ordinary text file.\n";
    f.setListing(tree([document]));
    f.setDiffListing(`A\0${document}\0`);
    f.blobs.set(`${sha}:${document}`, content);
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    f.calls.length = 0;
    expect(await result.readSourceDependencies!([document])).toEqual({
      sourceSha: sha,
      seedPaths: [document],
      unsupportedSeedPaths: [document],
      symbols: [],
      searchDepth: 0,
      identityScanBytes: 0,
      queries: [],
      files: [],
    });
    expect(
      f.calls.some(
        (call) => call.arguments.includes("cat-file") || call.arguments.includes("grep"),
      ),
    ).toBe(false);
    const manifest = await result.readPrDiffManifest!();
    expect(manifest.files).toEqual([
      { path: document, previousPath: null, status: "added", chunkIds: expect.any(Array) },
    ]);
    const chunks = await result.readPrDiffChunks!(manifest.files[0]!.chunkIds);
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["diff", "head"]);
    expect(chunks.find((chunk) => chunk.kind === "head")?.content).toBe(content);
  });

  it("keeps lexical dependency discovery for supported seeds mixed with unsearched documents", async () => {
    const f = fixture();
    const document = "README.md";
    const seed = "src/value.ts";
    const reference = "src/reference.ts";
    f.setListing(tree([document, seed, reference]));
    f.blobs.set(`${sha}:${seed}`, "class SourceValue {};\n");
    f.blobs.set(`${sha}:${reference}`, "class SourceValue {};\n");
    f.grepResults.push({ exitCode: 0, stdout: matches([reference]) });
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    f.calls.length = 0;
    const dependencies = await result.readSourceDependencies!([seed, document]);
    expect(dependencies.seedPaths).toEqual([document, seed]);
    expect(dependencies.unsupportedSeedPaths).toEqual([document]);
    expect(dependencies.symbols).toEqual(["SourceValue"]);
    expect(dependencies.searchDepth).toBe(1);
    expect(dependencies.files).toEqual([
      {
        path: reference,
        content: "class SourceValue {};\n",
        digest: hash("class SourceValue {};\n"),
      },
    ]);
    expect(f.calls.some((call) => call.arguments.at(-1) === `${sha}:${document}`)).toBe(false);
  });

  it.each(["missing", "symlink"])(
    "still rejects a %s non-lexical seed instead of treating it as unsearched source",
    async (kind) => {
      const f = fixture();
      const document = "README.md";
      f.setListing(
        kind === "missing"
          ? tree(["src/value.ts"])
          : `${tree(["src/value.ts"])}120000 blob ${sha}\t${document}\0`,
      );
      if (kind === "symlink") f.blobs.set(`${sha}:${document}`, "../private/notes.md");
      const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
        f.input,
        f.context,
      );
      f.calls.length = 0;
      await expect(result.readSourceDependencies!([document])).rejects.toMatchObject({
        code: "SOURCE_DEPENDENCY_UNAVAILABLE",
      });
      expect(
        f.calls.some(
          (call) => call.arguments.includes("cat-file") || call.arguments.includes("grep"),
        ),
      ).toBe(false);
    },
  );

  it("finds qualified owners, delegates, and their tests in two exact-head lexical hops", async () => {
    const f = fixture();
    const seed = "engine/NimbusEngine.cpp";
    const header = "public/NimbusEngine.h";
    const delegate = "dispatch/DispatchAgent.cs";
    const test = "tests/DispatchAgentTests.cs";
    const contents = new Map([
      [
        seed,
        'void NimbusEngine::Start() { auto moved = std::move(value); }\n// class CommentOnly {};\nconst char* example = "class LiteralOnly {};";\n',
      ],
      [header, "class NimbusEngine { void Start(); };\n"],
      [delegate, "public sealed class DispatchAgent { private NimbusEngine engine; }\n"],
      [test, "\uFEFFclass DispatchAgentTests { DispatchAgent agent; }\n"],
    ]);
    f.setListing(tree([...contents.keys()]));
    for (const [path, content] of contents) f.blobs.set(`${sha}:${path}`, content);
    f.blobs.set(`${baseSha}:${seed}`, "class PreviousRevisionOnly {};\n");
    f.grepResults.push(
      { exitCode: 0, stdout: matches([seed, header, delegate]) },
      { exitCode: 0, stdout: matches([delegate, test]) },
    );
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    f.calls.length = 0;
    const dependencies = await result.readSourceDependencies!([seed]);
    expect(dependencies).toEqual({
      sourceSha: sha,
      seedPaths: [seed],
      symbols: ["DispatchAgent", "NimbusEngine"],
      searchDepth: 2,
      identityScanBytes: [...contents.values()].reduce(
        (sum, content) => sum + Buffer.byteLength(content, "utf8"),
        0,
      ),
      queries: [
        {
          revisionSha: sha,
          symbols: ["NimbusEngine"],
          paths: [delegate, seed, header].sort(),
          depth: 1,
          anchorIdentities: [{ name: "NimbusEngine", namespace: "" }],
          excludedMatches: [],
          provenReferencePaths: [delegate, seed, header].sort(),
          unpropagatedMatches: [],
        },
        {
          revisionSha: sha,
          symbols: ["DispatchAgent"],
          paths: [delegate, test],
          depth: 2,
          anchorIdentities: [{ name: "DispatchAgent", namespace: "" }],
          excludedMatches: [],
          provenReferencePaths: [delegate, test],
          unpropagatedMatches: [],
        },
      ],
      files: [delegate, header, test].sort().map((path) => ({
        path,
        content: contents.get(path)!,
        digest: hash(contents.get(path)!),
      })),
    });
    const searches = f.calls.filter((call) => call.arguments.includes("grep"));
    expect(searches).toHaveLength(2);
    for (const call of searches) {
      expect(call.arguments).toEqual(
        expect.arrayContaining(["-F", "-w", "-l", "-z", "--no-textconv", sha]),
      );
      expect(call.arguments).toContain(":(glob,icase)**/*.cpp");
      expect(call.arguments).not.toContain(baseSha);
    }
    expect(
      f.calls
        .filter((call) => call.arguments.includes("cat-file"))
        .map((call) => call.arguments.at(-1)),
    ).toEqual([seed, delegate, header, test].map((path) => `${sha}:${path}`));
    expect(f.calls.filter((call) => call.arguments.includes("rev-parse"))).toHaveLength(2);
    expect(
      f.calls.every(
        (call) =>
          !call.arguments.some((argument) =>
            ["fetch", "checkout", "add", "apply", "push"].includes(argument),
          ),
      ),
    ).toBe(true);
  });

  it("uses owned definitions and templated C++ owners without alias, forward, call, or literal anchors", async () => {
    const f = fixture();
    const seed = "src/declarations.cpp";
    f.setListing(tree([seed]));
    f.blobs.set(
      `${sha}:${seed}`,
      [
        "class DeclaredType {}; struct DataRow {}; interface ServicePort {};",
        "record class RecordValue(int Value) {} record struct RecordRow(int Value) {} enum class ColorCode {};",
        "type TypeAlias = DeclaredType; using NativeAlias = DataRow;",
        "class ForwardOnly; enum ForwardEnum;",
        "template<class T, class U> void Holder<T>::Run() const noexcept { std::move(value); }",
        "Holder<Item>::~Holder() {}",
        "const value = Factory::Create() + Item{};",
        "class PrivateOwner { #value = 0; } class FollowingPrivateOwner {}",
        "const mask = 0xAB'CD; class FollowingHexLiteral {};",
        'const auto raw = R"marker(class RawLiteralOnly {};)marker";',
        'const auto verbatim = @"class VerbatimOnly {}";',
        'const auto triple = """class TripleLiteralOnly {}""";',
        "/* class CommentOnly {}; */",
      ].join("\n"),
    );
    f.grepResults.push({ exitCode: 1, stdout: "" });
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const dependencies = await result.readSourceDependencies!([seed]);
    expect(dependencies.symbols).toEqual([
      "ColorCode",
      "DataRow",
      "DeclaredType",
      "FollowingHexLiteral",
      "FollowingPrivateOwner",
      "Holder",
      "PrivateOwner",
      "RecordRow",
      "RecordValue",
      "ServicePort",
    ]);
    expect(dependencies.queries).toEqual([
      {
        revisionSha: sha,
        symbols: dependencies.symbols,
        paths: [],
        depth: 1,
        anchorIdentities: dependencies.symbols.map((name) => ({ name, namespace: "" })),
        excludedMatches: [],
        provenReferencePaths: [],
        unpropagatedMatches: [],
      },
    ]);
    expect(dependencies.files).toEqual([]);
  });

  it("delivers unresolved callers completely without propagating their generic owner names", async () => {
    const f = fixture();
    const seed = "native/Widget.h";
    const unresolved = "native/MainWindow.cpp";
    const content = "namespace Other { class MainWindow { Widget* value; }; }\n";
    f.setListing(tree([seed, unresolved]));
    f.blobs.set(`${sha}:${seed}`, "namespace Acme { struct Widget {}; }\n");
    f.blobs.set(`${sha}:${unresolved}`, content);
    f.grepResults.push({ exitCode: 0, stdout: matches([seed, unresolved]) });
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const dependencies = await result.readSourceDependencies!([seed]);
    expect(dependencies.searchDepth).toBe(1);
    expect(dependencies.symbols).toEqual(["Widget"]);
    expect(dependencies.files).toEqual([{ path: unresolved, content, digest: hash(content) }]);
    expect(dependencies.queries[0]!.provenReferencePaths).toEqual([seed]);
    expect(dependencies.queries[0]!.unpropagatedMatches).toEqual([
      { path: unresolved, reason: "unresolved_reference_identity" },
    ]);
    expect(dependencies.queries[0]!.excludedMatches).toEqual([]);
    expect(f.calls.filter((call) => call.arguments.includes("grep"))).toHaveLength(1);
  });

  it("propagates a proven namespace caller while retaining the full second-hop source", async () => {
    const f = fixture();
    const seed = "native/Widget.h";
    const caller = "native/Owner.h";
    const test = "tests/Owner.cpp";
    const contents = new Map([
      [seed, "namespace Acme { struct Widget {}; }\n"],
      [caller, "namespace Acme { struct Owner { Widget value; }; }\n"],
      [test, "namespace Checks { Acme::Owner owner; }\n"],
    ]);
    f.setListing(tree([...contents.keys()]));
    for (const [path, content] of contents) f.blobs.set(`${sha}:${path}`, content);
    f.grepResults.push(
      { exitCode: 0, stdout: matches([seed, caller]) },
      { exitCode: 0, stdout: matches([caller, test]) },
    );
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const dependencies = await result.readSourceDependencies!([seed]);
    expect(dependencies.searchDepth).toBe(2);
    expect(dependencies.queries.map((query) => query.symbols)).toEqual([["Widget"], ["Owner"]]);
    expect(dependencies.queries[0]!.provenReferencePaths).toEqual([caller, seed].sort());
    expect(dependencies.queries[1]!.provenReferencePaths).toEqual([caller, test]);
    expect(dependencies.queries.every((query) => query.unpropagatedMatches!.length === 0)).toBe(
      true,
    );
    expect(dependencies.files).toEqual(
      [caller, test].map((path) => ({
        path,
        content: contents.get(path)!,
        digest: hash(contents.get(path)!),
      })),
    );
  });

  it("records proved foreign types and import-only hits while retaining a projected WinRT caller", async () => {
    const f = fixture();
    const seed = "native/Listener.h";
    const foreign = "other/Listener.h";
    const importOnly = "managed/Import.cs";
    const caller = "managed/Caller.cs";
    const unknown = "native/Unknown.cpp";
    const content = new Map([
      [
        seed,
        "namespace winrt::Acme::Feature::implementation { using InputKind = winrt::Acme::Feature::InputKind; struct Listener : ListenerT<Listener> {}; }\n",
      ],
      [foreign, `namespace Other { class Listener {}; }\n${" ".repeat(300 * 1024)}`],
      [importOnly, "using Acme.Feature.Listener;\n"],
      [
        caller,
        "namespace Other { class Listener {} class Caller { global::Acme.Feature.Listener target; } }\n",
      ],
      [unknown, "Listener* ObtainListener();\n"],
    ]);
    f.setListing(tree([...content.keys()]));
    for (const [path, text] of content) f.blobs.set(`${sha}:${path}`, text);
    f.grepResults.push(
      { exitCode: 0, stdout: matches([seed, foreign, importOnly, caller, unknown]) },
      { exitCode: 1, stdout: "" },
    );
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const dependencies = await result.readSourceDependencies!([seed]);
    expect(dependencies.queries[0]!.symbols).toEqual(["Listener"]);
    expect(dependencies.queries[0]!.anchorIdentities).toEqual(
      expect.arrayContaining([
        { name: "Listener", namespace: "winrt::Acme::Feature::implementation" },
        { name: "Listener", namespace: "winrt::Acme::Feature" },
        { name: "Listener", namespace: "Acme::Feature" },
      ]),
    );
    expect(dependencies.queries[0]!.excludedMatches).toEqual([
      { path: importOnly, reason: "namespace_or_import_only", matchedSymbols: ["Listener"] },
      { path: foreign, reason: "different_type_identity", matchedSymbols: ["Listener"] },
    ]);
    expect(dependencies.files.map((file) => file.path)).toEqual([caller, unknown].sort());
    expect(dependencies.files.every((file) => file.digest === hash(content.get(file.path)!))).toBe(
      true,
    );
    expect(dependencies.identityScanBytes).toBe(
      [...content.values()].reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0),
    );
    expect(dependencies.identityScanBytes).toBeGreaterThan(256 * 1024);
  });

  it("does not infer a public namespace bridge from an arbitrary implementation namespace", async () => {
    for (const [namespace, declaration] of [
      ["winrt::Acme::Feature::implementation", "class Listener {}"],
      ["Acme::Feature::implementation", "struct Listener : ListenerT<Listener> {}"],
      ["winrt::Acme::Feature::implementation", "struct Listener : Wrapper<ListenerT<Listener>> {}"],
    ]) {
      const f = fixture();
      const seed = "src/definition.h";
      f.setListing(tree([seed]));
      f.blobs.set(`${sha}:${seed}`, `namespace ${namespace} { ${declaration}; }\n`);
      f.grepResults.push({ exitCode: 1, stdout: "" });
      const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
        f.input,
        f.context,
      );
      const dependencies = await result.readSourceDependencies!([seed]);
      expect(dependencies.queries[0]!.anchorIdentities).toEqual([{ name: "Listener", namespace }]);
    }
  });

  it.each([false, true])(
    "retains inherited type-alias callers with out-of-line definition %s",
    async (outOfLine) => {
      const f = fixture();
      const seed = "native/Widget.h";
      const caller = "native/Derived.cpp";
      const use = outOfLine
        ? "struct Derived : Base { void f(); }; void Derived::f() { Widget value; }"
        : "struct Derived : Base { void f() { Widget value; } };";
      const callerContent = `namespace Foreign { struct Widget {}; } struct Base { using Widget = A::Widget; }; using namespace Foreign; ${use}\n`;
      f.setListing(tree([seed, caller]));
      f.blobs.set(`${sha}:${seed}`, "namespace A { struct Widget {}; }\n");
      f.blobs.set(`${sha}:${caller}`, callerContent);
      f.grepResults.push({ exitCode: 0, stdout: matches([caller]) }, { exitCode: 1, stdout: "" });
      const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
        f.input,
        f.context,
      );
      const dependencies = await result.readSourceDependencies!([seed]);
      expect(dependencies.queries[0]!.excludedMatches).toEqual([]);
      expect(dependencies.files).toContainEqual({
        path: caller,
        content: callerContent,
        digest: hash(callerContent),
      });
    },
  );

  it("fails visibly when even an excluded candidate exceeds the independent identity scan budget", async () => {
    const f = fixture();
    f.setListing(tree(["src/value.ts", "src/foreign.cs"]));
    f.blobs.set(`${sha}:src/value.ts`, "namespace Acme { class Listener {}; }\n");
    f.blobs.set(
      `${sha}:src/foreign.cs`,
      `namespace Other { class Listener {}; }\n${" ".repeat(1024 * 1024)}`,
    );
    f.grepResults.push({ exitCode: 0, stdout: matches(["src/foreign.cs"]) });
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
      code: "SOURCE_DEPENDENCY_LIMIT_EXCEEDED",
    });
  });

  it("refuses seeds without a supported symbol instead of returning catalog-only evidence", async () => {
    const f = fixture();
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
      code: "SOURCE_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.calls.some((call) => call.arguments.includes("grep"))).toBe(false);
  });

  it("caches the sorted immutable seed set while retaining both binding checks and independent result copies", async () => {
    const f = fixture();
    const paths = ["src/alpha.cs", "src/beta.cs"];
    f.setListing(tree(paths));
    f.blobs.set(`${sha}:${paths[0]}`, "class Alpha {};\n");
    f.blobs.set(`${sha}:${paths[1]}`, "class Beta {};\n");
    f.grepResults.push({ exitCode: 1, stdout: "" });
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    const initial = await result.readSourceDependencies!([...paths].reverse());
    (initial.seedPaths as string[])[0] = "changed-by-caller.cs";
    f.calls.length = 0;
    const cached = await result.readSourceDependencies!(paths);
    expect(cached.seedPaths).toEqual(paths);
    expect(cached.symbols).toEqual(["Alpha", "Beta"]);
    expect(f.calls.filter((call) => call.arguments.includes("rev-parse"))).toHaveLength(2);
    expect(
      f.calls.filter(
        (call) => call.arguments.includes("grep") || call.arguments.includes("cat-file"),
      ),
    ).toHaveLength(0);
    f.setPatch("A tracked source change before a cached read.");
    await expect(result.readSourceDependencies!(paths)).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
  });

  it("rejects source drift after the query before exposing its complete result", async () => {
    const f = fixture();
    f.blobs.set(`${sha}:src/value.ts`, "class SourceValue {};\n");
    f.grepResults.push({ exitCode: 1, stdout: "" });
    const runner = f.options.runner;
    f.options.runner = {
      async run(spec, context) {
        const result = await runner.run(spec, context);
        if (spec.arguments.includes("grep"))
          f.setPatch("A tracked source change during discovery.");
        return result;
      },
    };
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
  });

  it("freezes the caller's seed paths before awaiting a binding check", async () => {
    const f = fixture();
    const seeds = ["src/value.ts"];
    f.blobs.set(`${sha}:src/value.ts`, "class SourceValue {};\n");
    f.grepResults.push({ exitCode: 1, stdout: "" });
    const runner = f.options.runner;
    let changeSeeds = false;
    f.options.runner = {
      async run(spec, context) {
        if (changeSeeds && spec.arguments.includes("rev-parse")) seeds[0] = "src/unavailable.cs";
        return runner.run(spec, context);
      },
    };
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    changeSeeds = true;
    expect((await result.readSourceDependencies!(seeds)).seedPaths).toEqual(["src/value.ts"]);
  });

  it("fails the whole discovery when symbols, paths, or complete blob bytes exceed the budget", async () => {
    for (const budget of ["symbols", "matches", "bytes", "seeds", "files"] as const) {
      const f = fixture();
      const seed = "src/value.ts";
      f.blobs.set(
        `${sha}:${seed}`,
        budget === "symbols"
          ? Array.from({ length: 129 }, (_, index) => `class Declared${index} {};`).join("\n")
          : budget === "bytes"
            ? `class SourceValue {};${" ".repeat(256 * 1024)}`
            : "class SourceValue {};\n",
      );
      const added = Array.from(
        { length: budget === "matches" ? 65 : 64 },
        (_, index) => `src/Reference${index}.cs`,
      );
      if (budget === "matches" || budget === "files") {
        f.setListing(tree([seed, ...added]));
        for (const path of added) f.blobs.set(`${sha}:${path}`, "SourceValue value;\n");
        f.grepResults.push({ exitCode: 0, stdout: matches(added) });
      }
      const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
        f.input,
        f.context,
      );
      const seeds =
        budget === "seeds"
          ? Array.from({ length: 65 }, (_, index) => `src/Seed${index}.cs`)
          : [seed];
      await expect(result.readSourceDependencies!(seeds)).rejects.toMatchObject({
        code: "SOURCE_DEPENDENCY_LIMIT_EXCEEDED",
      });
    }
  });

  it("requires complete UTF-8 text for every matched ordinary source blob", async () => {
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from("SourceValue\0binary")]) {
      const f = fixture();
      f.setListing(tree(["src/value.ts", "src/reference.cs"]));
      f.blobs.set(`${sha}:src/value.ts`, "class SourceValue {};\n");
      f.rawBlobs.set(`${sha}:src/reference.cs`, bytes);
      f.grepResults.push({ exitCode: 0, stdout: matches(["src/reference.cs"]) });
      const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
        f.input,
        f.context,
      );
      await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
        code: "SOURCE_DEPENDENCY_UNREADABLE",
      });
    }
  });

  it("rejects malformed, unsafe, non-source, unknown, or non-head match records", async () => {
    for (const [stdout, code] of [
      [matches(["src/value.ts"], baseSha), "SOURCE_BINDING_MISMATCH"],
      [`${sha}:src/value.ts`, "SOURCE_DEPENDENCY_UNAVAILABLE"],
      [matches(["../outside.cs"]), "SOURCE_PATH_UNSAFE"],
      [matches(["src/missing.cs"]), "SOURCE_DEPENDENCY_UNAVAILABLE"],
      [matches(["README.md"]), "SOURCE_DEPENDENCY_UNAVAILABLE"],
      [matches(["src/value.ts", "src/value.ts"]), "SOURCE_DEPENDENCY_UNAVAILABLE"],
      [`${matches(["src/value.ts"])}\0`, "SOURCE_BINDING_MISMATCH"],
    ]) {
      const f = fixture();
      f.setListing(tree(["src/value.ts", "README.md"]));
      f.blobs.set(`${sha}:src/value.ts`, "class SourceValue {};\n");
      f.grepResults.push({ exitCode: 0, stdout: stdout! });
      const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
        f.input,
        f.context,
      );
      await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
        code,
      });
    }
  });

  it("rejects inert symlink matches without reading or following their target during discovery", async () => {
    const f = fixture();
    f.setListing(`${tree(["src/value.ts"])}120000 blob ${sha}\tsrc/linked.cs\0`);
    f.blobs.set(`${sha}:src/value.ts`, "class SourceValue {};\n");
    f.blobs.set(`${sha}:src/linked.cs`, "../../private/target.cs");
    f.grepResults.push({ exitCode: 0, stdout: matches(["src/linked.cs"]) });
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    f.calls.length = 0;
    await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
      code: "SOURCE_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.calls.some((call) => call.arguments.at(-1) === `${sha}:src/linked.cs`)).toBe(false);
    expect(f.fs.reads.every((path) => path.startsWith(`${source}\\`))).toBe(true);
  });

  it("does not substitute base content for a deleted or unavailable head seed", async () => {
    const f = fixture();
    f.setListing(tree(["src/value.ts"]), sha);
    f.setListing(tree(["src/deleted.cs"]), baseSha);
    f.blobs.set(`${baseSha}:src/deleted.cs`, "class DeletedAtHead {};\n");
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    f.calls.length = 0;
    await expect(result.readSourceDependencies!(["src/deleted.cs"])).rejects.toMatchObject({
      code: "SOURCE_DEPENDENCY_UNAVAILABLE",
    });
    expect(
      f.calls.some(
        (call) => call.arguments.includes("cat-file") || call.arguments.includes("grep"),
      ),
    ).toBe(false);
  });

  it("accepts exit one only for an empty grep response and keeps all other command failures fatal", async () => {
    for (const [exitCode, stdout] of [
      [1, matches(["src/value.ts"])],
      [2, ""],
    ] as const) {
      const f = fixture();
      f.blobs.set(`${sha}:src/value.ts`, "class SourceValue {};\n");
      f.grepResults.push({ exitCode, stdout });
      const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
        f.input,
        f.context,
      );
      await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
        code: "SOURCE_GIT_FAILED",
      });
    }
    const f = fixture();
    const runner = f.options.runner;
    f.options.runner = {
      async run(spec, context) {
        const result = await runner.run(spec, context);
        return spec.arguments.includes("cat-file")
          ? { exitCode: 1, stdout: Buffer.alloc(0) }
          : result;
      },
    };
    const result = await new ProductionInvestigationGitSourceMaterializer(f.options).materialize(
      f.input,
      f.context,
    );
    await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
      code: "SOURCE_GIT_FAILED",
    });
  });

  it("rejects dependency access for execution mode or a materialized local patch", async () => {
    for (const kind of ["execute", "local_patch"] as const) {
      const f = fixture();
      const patch = Buffer.from("diff --git a/src/value.ts b/src/value.ts\nsaved patch\n");
      if (kind === "execute") {
        f.input.task.executionPolicy.mode = "execute";
        f.input.task.executionPolicy.allowRepositoryExecution = true;
        f.input.task.executionPolicy.authorizationRef = "synthetic-execution-authorization";
      } else {
        const original = f.input.task.subjects[0]!;
        const subject = {
          id: "dependency-local-patch",
          kind: "local_patch" as const,
          repositoryId: original.repositoryId,
          workItemId: original.workItemId,
          revisionKey: hash("dependency patch revision"),
          baseSubjectRef: original.id,
          baseSha: sha,
          patchDigest: hash(patch),
          artifactRef: "dependency-patch-artifact",
        };
        f.input.task.subjects.push(subject);
        f.input.task.subjectRef = subject.id;
        f.input.task.executionPolicy.allowedSubjectRefs.push(subject.id);
      }
      const result = await new ProductionInvestigationGitSourceMaterializer({
        ...f.options,
        readPatchArtifact: async () => patch,
      }).materialize(f.input, f.context);
      f.calls.length = 0;
      await expect(result.readSourceDependencies!(["src/value.ts"])).rejects.toMatchObject({
        code: "SOURCE_DEPENDENCY_UNAVAILABLE",
      });
      expect(f.calls).toEqual([]);
    }
  });
});

describe("managed Git bounded immutable source context", () => {
  const tree = (paths: readonly string[]) =>
    paths.map((path) => `100644 blob ${sha}\t${path}\0`).join("");
  const matches = (paths: readonly string[], revision = sha) =>
    paths.map((path) => `${revision}:${path}\0`).join("");

  function contextFixture(
    contents: ReadonlyMap<string, string>,
    definitions: ReadonlyMap<string, readonly string[]> = new Map(),
    references: ReadonlyMap<string, readonly string[]> = new Map(),
  ) {
    const f = fixture();
    f.setListing(tree([...contents.keys()]));
    for (const [path, content] of contents) f.blobs.set(`${sha}:${path}`, content);
    const runner = f.options.runner;
    f.options.runner = {
      async run(spec, context) {
        if (!spec.arguments.includes("grep")) return runner.run(spec, context);
        f.calls.push(structuredClone(spec));
        const patterns = spec.arguments.flatMap((argument, index) =>
          argument === "-e" ? [spec.arguments[index + 1]!] : [],
        );
        const declarationQuery = spec.arguments.includes("-E");
        const responses = declarationQuery ? definitions : references;
        const paths = [
          ...new Set(
            [...responses].flatMap(([symbol, paths]) =>
              patterns.some((pattern) =>
                declarationQuery ? pattern.includes(`+${symbol}(`) : pattern === symbol,
              )
                ? [...paths]
                : [],
            ),
          ),
        ].sort();
        return { exitCode: paths.length === 0 ? 1 : 0, stdout: Buffer.from(matches(paths)) };
      },
    };
    return f;
  }

  describe("XAML forward definition context", () => {
    const seed = "views/MainView.xaml";
    const definition = "controls/TransientSurface.cs";
    const definitionContent = "namespace Atlas.Controls { public class TransientSurface {} }\n";

    async function readXamlContext(
      content: string,
      additionalContents: ReadonlyMap<string, string> = new Map([[definition, definitionContent]]),
      definitions: ReadonlyMap<string, readonly string[]> = new Map([
        ["TransientSurface", [definition]],
      ]),
      references: ReadonlyMap<string, readonly string[]> = new Map(),
    ) {
      const contents = new Map([[seed, content], ...additionalContents]);
      const f = contextFixture(contents, definitions, references);
      const materialized = await new ProductionInvestigationGitSourceMaterializer(
        f.options,
      ).materialize(f.input, f.context);
      f.calls.length = 0;
      return { f, contents, context: await materialized.readSourceContext!([seed]) };
    }

    it.each(["'", '"'])(
      "resolves a same-tag using namespace with %s quotes and rejects a homonymous declaration",
      async (quote) => {
        const decoy = "other/TransientSurface.cs";
        const content = `<ui:TransientSurface xmlns:ui=${quote}using:Atlas.Controls${quote} />\n`;
        const { f, context } = await readXamlContext(
          content,
          new Map([
            [definition, definitionContent],
            [decoy, "namespace Other.Controls { public class TransientSurface {} }\n"],
          ]),
          new Map([["TransientSurface", [definition, decoy]]]),
        );
        expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
        expect(context.contextFiles).toEqual([
          {
            path: definition,
            content: definitionContent,
            digest: hash(definitionContent),
            role: "definition_candidate",
            relation: "unresolved_reference_identity",
            lexicalDeclaration: { name: "TransientSurface", namespace: "Atlas::Controls" },
          },
        ]);
        expect(context.deferred).toContainEqual({
          path: decoy,
          reason: "definition_identity_unresolved",
        });
        expect(context.queries).toContainEqual(
          expect.objectContaining({
            kind: "definition",
            revisionSha: sha,
            symbols: ["TransientSurface"],
            paths: [definition, decoy],
          }),
        );
        expect(f.calls.filter((call) => call.arguments.includes("-E"))).toHaveLength(1);
        expect(
          f.calls
            .filter((call) => call.arguments.includes("grep"))
            .every((call) => call.arguments.includes(sha)),
        ).toBe(true);
      },
    );

    it("resolves a default clr-namespace without an assembly after a BOM and XML declaration", async () => {
      const content =
        '\uFEFF<?xml version="1.0" encoding="utf-8"?>\n<TransientSurface xmlns="clr-namespace:Atlas.Controls" />\n';
      const { context } = await readXamlContext(content);
      expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
      expect(context.contextFiles).toContainEqual(
        expect.objectContaining({
          path: definition,
          content: definitionContent,
          digest: hash(definitionContent),
          lexicalDeclaration: { name: "TransientSurface", namespace: "Atlas::Controls" },
          relation: "unresolved_reference_identity",
        }),
      );
    });

    it("ignores attribute, text, comment, CDATA, and processing-instruction decoys while accepting entities", async () => {
      const content = `<?sample value="<ui:ProcessingDecoy />"?>
<Root xmlns="http://example.invalid/presentation" xmlns:ui="using:Atlas.Controls"
      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Class="Atlas.Controls.ClassDecoy"
      Tag="&lt;ui:AttributeDecoy /&gt;" Text="A &amp; B &#x41; &#65; &quot; &apos; &lt; &gt;">
  <!-- <ui:CommentDecoy /> -->
  <![CDATA[<ui:CDataDecoy />]]>
  Escaped text: A &amp; B &#x41; &lt;ui:TextDecoy /&gt;
  namespace Atlas.Controls { class LexerDecoy {} }
  <ui:TransientSurface />
</Root>\n`;
      const { context } = await readXamlContext(content);
      expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
      expect(context.contextFiles.map((file) => file.path)).toEqual([definition]);
      expect(context.queries.filter((query) => query.kind === "definition")).toEqual([
        expect.objectContaining({ symbols: ["TransientSurface"], paths: [definition] }),
      ]);
      expect(
        context.queries.every((query) =>
          query.symbols.every((name) => name === "TransientSurface"),
        ),
      ).toBe(true);
    });

    it("restores prefix and default mappings after local shadows and self-closing elements", async () => {
      const names = [
        ["OuterBefore", "Outer.Controls"],
        ["InnerControl", "Inner.Controls"],
        ["DefaultInner", "Inner.Controls"],
        ["OuterAfter", "Outer.Controls"],
        ["DefaultAfter", "Outer.Controls"],
        ["BlockedUnknown", "Outer.Controls"],
        ["BlockedDescendant", "Outer.Controls"],
        ["BlockedEmpty", "Outer.Controls"],
        ["BlockedEntity", "Outer.Controls"],
        ["BlockedAssembly", "Outer.Controls"],
        ["BlockedDefault", "Outer.Controls"],
        ["BlockedDefaultEmpty", "Outer.Controls"],
        ["BlockedDefaultEntity", "Outer.Controls"],
      ] as const;
      const expectedNames = names
        .slice(0, 5)
        .map(([name]) => name)
        .sort();
      const content = `<p:Root xmlns:p="http://example.invalid/presentation"
        xmlns="using:Outer.Controls" xmlns:ui="using:Outer.Controls">
  <ui:OuterBefore />
  <p:Scope xmlns="using:Inner.Controls" xmlns:ui="using:Inner.Controls">
    <ui:InnerControl />
    <DefaultInner />
  </p:Scope>
  <ui:BlockedUnknown xmlns:ui="http://example.invalid/unknown">
    <ui:BlockedDescendant />
  </ui:BlockedUnknown>
  <ui:BlockedEmpty xmlns:ui="" />
  <ui:BlockedEntity xmlns:ui="using:Outer&#46;Controls" />
  <ui:BlockedAssembly xmlns:ui="clr-namespace:Outer.Controls;assembly=External" />
  <p:Scope xmlns="http://example.invalid/unknown"><BlockedDefault /></p:Scope>
  <BlockedDefaultEmpty xmlns="" />
  <BlockedDefaultEntity xmlns="using:Outer&#46;Controls" />
  <ui:OuterAfter />
  <DefaultAfter />
</p:Root>\n`;
      const { context } = await readXamlContext(
        content,
        new Map(
          names.map(([name, namespace]) => [
            `controls/${name}.cs`,
            `namespace ${namespace} { public class ${name} {} }\n`,
          ]),
        ),
        new Map(names.map(([name]) => [name, [`controls/${name}.cs`]])),
      );
      expect(context.contextFiles.map((file) => file.lexicalDeclaration?.name).sort()).toEqual(
        expectedNames,
      );
      expect(
        context.queries
          .filter((query) => query.kind === "definition")
          .flatMap((query) => query.symbols)
          .sort(),
      ).toEqual(expectedNames);
      expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
    });

    it("looks up a property element owner using the namespace declared on that element", async () => {
      const content = `<p:Root xmlns:p="http://example.invalid/presentation" xmlns:ui="using:Other.Controls">
  <ui:TransientSurface.Content xmlns:ui="using:Atlas.Controls"><p:Child /></ui:TransientSurface.Content>
</p:Root>\n`;
      const { context } = await readXamlContext(content);
      expect(context.contextFiles).toContainEqual(
        expect.objectContaining({
          path: definition,
          lexicalDeclaration: { name: "TransientSurface", namespace: "Atlas::Controls" },
          relation: "unresolved_reference_identity",
        }),
      );
      expect(context.queries.filter((query) => query.kind === "definition")).toEqual([
        expect.objectContaining({ symbols: ["TransientSurface"] }),
      ]);
    });

    it.each([
      [
        "mismatched end tag",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /></Other>',
      ],
      [
        "unterminated attribute",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><Other Value="unfinished',
      ],
      [
        "unknown markup",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><!UNKNOWN ignored></Root>',
      ],
      [
        "DTD",
        '<!DOCTYPE Root SYSTEM "file:///never-load.dtd"><Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /></Root>',
      ],
      [
        "unterminated comment",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><!-- unfinished',
      ],
      [
        "unterminated CDATA",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><![CDATA[unfinished',
      ],
      [
        "unterminated processing instruction",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><?sample unfinished',
      ],
      [
        "duplicate namespace attributes",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><Other xmlns:ui="using:Atlas.Controls" xmlns:ui="using:Other.Controls" /></Root>',
      ],
      [
        "an unsupported property element chain",
        '<ui:TransientSurface.Content.More xmlns:ui="using:Atlas.Controls" />',
      ],
      [
        "an invalid processing-instruction target separator",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><?pi!?></Root>',
      ],
      [
        "an undeclared element prefix",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><missing:Other /></Root>',
      ],
      [
        "an undeclared attribute prefix",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><Other missing:Value="text" /></Root>',
      ],
      [
        "a late XML declaration",
        '<Root xmlns:ui="using:Atlas.Controls"><ui:TransientSurface /><?xml version="1.0"?></Root>',
      ],
    ])("does not infer definitions from a document with %s", async (_name, content) => {
      const { f, context } = await readXamlContext(content);
      expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
      expect(context.contextFiles).toEqual([]);
      expect(context.queries).toEqual([]);
      expect(f.calls.filter((call) => call.arguments.includes("grep"))).toHaveLength(0);
      expect(
        f.calls.filter(
          (call) =>
            call.arguments.includes("cat-file") && call.arguments.at(-1) !== `${sha}:${seed}`,
        ),
      ).toHaveLength(0);
    });

    it("preserves required XAML without querying identities beyond existing namespace and name bounds", async () => {
      const namespace = `Atlas.${"Segment".repeat(300)}`;
      const tags = Array.from({ length: 16 }, (_, index) => `  <deep:Control${index} />`);
      const name = "T".repeat(129);
      const content = `<Root xmlns:deep="using:${namespace}" xmlns:ui="using:Atlas.Controls">\n${tags.join("\n")}\n  <ui:${name} />\n</Root>\n`;
      const { f, context } = await readXamlContext(content);
      expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
      expect(context.contextFiles).toEqual([]);
      expect(context.queries).toEqual([]);
      expect(f.calls.filter((call) => call.arguments.includes("grep"))).toHaveLength(0);
    });

    it.each([
      [1024 * 1024, "candidate_scan_bytes_budget"],
      [256 * 1024, "prompt_input_budget"],
    ] as const)(
      "retains the full XAML seed when a discovered definition exceeds %s bytes",
      async (padding, reason) => {
        const content = '<ui:TransientSurface xmlns:ui="using:Atlas.Controls" />\n';
        const largeDefinition = `${definitionContent}${" ".repeat(padding)}`;
        const { f, context } = await readXamlContext(
          content,
          new Map([[definition, largeDefinition]]),
        );
        expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
        expect(context.contextFiles).toEqual([]);
        expect(context.deferred).toContainEqual({ path: definition, reason });
        expect(context.identityScanBytes).toBeLessThanOrEqual(1024 * 1024);
        expect(context.queries).toContainEqual(
          expect.objectContaining({ kind: "definition", symbols: ["TransientSurface"] }),
        );
        if (reason === "candidate_scan_bytes_budget") {
          expect(
            f.calls.some(
              (call) =>
                call.arguments.includes("blob") && call.arguments.at(-1) === `${sha}:${definition}`,
            ),
          ).toBe(false);
        }
      },
    );

    it("bounds discovered references, scans, and optional delivery with visible deferred paths", async () => {
      const content = '<ui:TransientSurface xmlns:ui="using:Atlas.Controls" />\n';
      const candidates = Array.from(
        { length: 260 },
        (_, index) => `tests/TransientSurfaceConsumer${String(index).padStart(3, "0")}.cs`,
      );
      const { context, contents } = await readXamlContext(
        content,
        new Map([
          [definition, definitionContent],
          ...candidates.map(
            (path, index) =>
              [
                path,
                `namespace Atlas.Controls { class Consumer${index} { TransientSurface target; } }\n`,
              ] as const,
          ),
        ]),
        new Map([["TransientSurface", [definition]]]),
        new Map([["TransientSurface", [definition, ...candidates]]]),
      );
      expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
      expect(
        context.contextFiles.filter((file) => file.role === "definition_candidate"),
      ).toHaveLength(1);
      expect(context.contextFiles.filter((file) => file.role === "related_context")).toHaveLength(
        4,
      );
      for (const file of context.contextFiles) {
        expect(file.content).toBe(contents.get(file.path));
        expect(file.digest).toBe(hash(contents.get(file.path)!));
        expect(file.relation).toBe("unresolved_reference_identity");
      }
      const referenceQuery = context.queries.find((query) => query.kind === "reference")!;
      expect(referenceQuery.paths).toHaveLength(256);
      expect(referenceQuery.matchedPathCount).toBe(261);
      expect(referenceQuery.omittedPathCount).toBe(5);
      expect(context.catalogComplete).toBe(false);
      expect(context.omittedCandidateCount).toBe(5);
      expect(context.identityScanFiles).toBeLessThanOrEqual(64);
      expect(context.identityScanBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(context.deferred.some((entry) => entry.reason === "candidate_scan_files_budget")).toBe(
        true,
      );
      expect(context.deferred.some((entry) => entry.reason === "optional_context_budget")).toBe(
        true,
      );
      expect(context.queries.every((query) => query.symbols.length <= 128)).toBe(true);
    });

    it("deduplicates repeated tags and respects the existing query cap without truncating the seed", async () => {
      const tags = Array.from({ length: 260 }, (_, index) => `  <ui:Control${index} />`);
      const content = `<Root xmlns:ui="using:Atlas.Controls">\n${tags.join("\n")}\n  <ui:Control0 />\n</Root>\n`;
      const { f, context } = await readXamlContext(content, new Map(), new Map());
      expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
      expect(context.contextFiles).toEqual([]);
      expect(context.queries).toHaveLength(256);
      expect(context.queries.filter((query) => query.symbols.includes("Control0"))).toHaveLength(1);
      expect(context.queries.every((query) => query.symbols.length <= 128)).toBe(true);
      expect(context.queryBudgetExhausted).toBe(true);
      expect(f.calls.filter((call) => call.arguments.includes("grep"))).toHaveLength(256);
    });

    it("reads explicit XAML definitions before broad C# candidates consume the scan budget", async () => {
      const owner = "src/AOwner.cs";
      const view = "src/ZView.xaml";
      const widget = "controls/Widget.cs";
      const widgetContent = "namespace Atlas.Controls { public class Widget {} }\n";
      const busyPaths = Array.from(
        { length: 70 },
        (_, index) => `engine/BusyNode${String(index).padStart(3, "0")}.cs`,
      );
      const contents = new Map([
        [owner, "namespace Atlas { class AOwner { BusyNode node; } }\n"],
        [view, '<controls:Widget xmlns:controls="using:Atlas.Controls" />\n'],
        [widget, widgetContent],
        ...busyPaths.map(
          (path) => [path, "namespace Atlas { public partial class BusyNode {} }\n"] as const,
        ),
      ]);
      const f = contextFixture(
        contents,
        new Map([
          ["Widget", [widget]],
          ["BusyNode", busyPaths],
        ]),
      );
      const materialized = await new ProductionInvestigationGitSourceMaterializer(
        f.options,
      ).materialize(f.input, f.context);
      f.calls.length = 0;
      const context = await materialized.readSourceContext!([owner, view]);
      expect(context.requiredFiles).toEqual(
        [owner, view].map((path) => ({
          path,
          content: contents.get(path),
          digest: hash(contents.get(path)!),
        })),
      );
      expect(context.contextFiles).toContainEqual({
        path: widget,
        content: widgetContent,
        digest: hash(widgetContent),
        role: "definition_candidate",
        relation: "unresolved_reference_identity",
        lexicalDeclaration: { name: "Widget", namespace: "Atlas::Controls" },
      });
      expect(
        context.queries
          .filter((query) => query.kind === "definition")
          .map((query) => query.symbols),
      ).toEqual([["Widget"], ["BusyNode"]]);
      const blobReads = f.calls
        .filter((call) => call.arguments.includes("cat-file") && call.arguments.includes("blob"))
        .map((call) => call.arguments.at(-1));
      expect(blobReads.slice(0, 3)).toEqual([
        `${sha}:${owner}`,
        `${sha}:${view}`,
        `${sha}:${widget}`,
      ]);
      expect(context.identityScanFiles).toBe(64);
      expect(context.identityScanBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(context.requiredFiles.length + context.contextFiles.length).toBe(64);
      const busyDefinitions = context.contextFiles.filter(
        (file) => file.lexicalDeclaration?.name === "BusyNode",
      );
      expect(busyDefinitions.map((file) => file.path)).toEqual(busyPaths.slice(0, 61));
      for (const file of busyDefinitions) {
        expect(file.content).toBe(contents.get(file.path));
        expect(file.digest).toBe(hash(contents.get(file.path)!));
        expect(file.role).toBe("definition_candidate");
        expect(file.relation).toBe("unresolved_reference_identity");
      }
      expect(
        context.deferred.filter((entry) => entry.reason === "candidate_scan_files_budget"),
      ).toHaveLength(9);
      expect(context.deferred.every((entry) => busyPaths.includes(entry.path))).toBe(true);
      expect(context.queries.every((query) => query.paths.length <= 256)).toBe(true);
      expect(context.queries.every((query) => query.symbols.length <= 128)).toBe(true);
      expect(context.queries.length).toBeLessThanOrEqual(256);
      expect(
        [...context.requiredFiles, ...context.contextFiles].reduce(
          (bytes, file) => bytes + Buffer.byteLength(file.content, "utf8"),
          0,
        ),
      ).toBeLessThanOrEqual(256 * 1024);
    });
  });

  it("returns complete typed seeds, declaration candidates, callers, and tests from exact source objects", async () => {
    const seed = "engine/Coordinator.cs";
    const definition = "engine/DispatchNode.cs";
    const caller = "engine/CoordinatorCaller.cs";
    const test = "tests/DispatchNodeTests.cs";
    const contents = new Map([
      [
        seed,
        "namespace Atlas { class Coordinator { private DispatchNode dispatcher; void Start() { dispatcher.Run(); } } }\n",
      ],
      [definition, "namespace Atlas { class DispatchNode { public void Run() {} } }\n"],
      [caller, "namespace Atlas { class CoordinatorCaller { Coordinator target; } }\n"],
      [
        test,
        "\uFEFFnamespace Atlas { class DispatchNodeTests { void Check() { var node = new DispatchNode(); node.Run(); } } }\n",
      ],
    ]);
    const f = contextFixture(
      contents,
      new Map([["DispatchNode", [definition]]]),
      new Map([
        ["DispatchNode", [seed, definition, test]],
        ["Coordinator", [seed, caller]],
      ]),
    );
    const materialized = await new ProductionInvestigationGitSourceMaterializer(
      f.options,
    ).materialize(f.input, f.context);
    f.calls.length = 0;
    const context = await materialized.readSourceContext!([seed]);
    expect(context.sourceSha).toBe(sha);
    expect(context.seedPaths).toEqual([seed]);
    expect(context.requiredFiles).toEqual([
      { path: seed, content: contents.get(seed), digest: hash(contents.get(seed)!) },
    ]);
    expect(context.contextFiles.map((file) => file.path).sort()).toEqual(
      [definition, caller, test].sort(),
    );
    expect(context.contextFiles.find((file) => file.path === definition)).toMatchObject({
      role: "definition_candidate",
      lexicalDeclaration: { name: "DispatchNode", namespace: "Atlas" },
    });
    for (const file of context.contextFiles) {
      expect(file.relation).toBe("unresolved_reference_identity");
      expect(file.content).toBe(contents.get(file.path));
      expect(file.digest).toBe(hash(contents.get(file.path)!));
    }
    expect(context.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "definition",
          revisionSha: sha,
          symbols: ["DispatchNode"],
          paths: [definition],
          matchedPathCount: 1,
          omittedPathCount: 0,
        }),
        expect.objectContaining({ kind: "reference", revisionSha: sha, symbols: ["Coordinator"] }),
      ]),
    );
    expect(context.catalogComplete).toBe(true);
    expect(context.omittedCandidateCount).toBe(0);
    expect(
      f.calls
        .filter((call) => call.arguments.includes("grep"))
        .every((call) => call.arguments.includes(sha)),
    ).toBe(true);
    expect(
      f.calls
        .filter((call) => call.arguments.includes("cat-file"))
        .every((call) => call.arguments.at(-1)?.startsWith(`${sha}:`)),
    ).toBe(true);
  });

  it.each([
    [1024 * 1024, "candidate_scan_bytes_budget"],
    [256 * 1024, "prompt_input_budget"],
  ] as const)(
    "preserves the complete typed seed when an optional declaration exceeds %s bytes",
    async (padding, reason) => {
      const seed = "engine/Coordinator.cs";
      const definition = "engine/DispatchNode.cs";
      const seedContent =
        "namespace Atlas { class Coordinator { private DispatchNode dispatcher; } }\n";
      const definitionContent = `namespace Atlas { class DispatchNode {} }\n${" ".repeat(padding)}`;
      const f = contextFixture(
        new Map([
          [seed, seedContent],
          [definition, definitionContent],
        ]),
        new Map([["DispatchNode", [definition]]]),
      );
      const materialized = await new ProductionInvestigationGitSourceMaterializer(
        f.options,
      ).materialize(f.input, f.context);
      f.calls.length = 0;
      const context = await materialized.readSourceContext!([seed]);
      expect(context.requiredFiles).toEqual([
        { path: seed, content: seedContent, digest: hash(seedContent) },
      ]);
      expect(context.contextFiles).toEqual([]);
      expect(context.deferred).toContainEqual({ path: definition, reason });
      expect(context.identityScanBytes).toBeLessThanOrEqual(1024 * 1024);
      if (reason === "candidate_scan_bytes_budget") {
        expect(
          f.calls.some(
            (call) =>
              call.arguments.includes("-s") && call.arguments.at(-1) === `${sha}:${definition}`,
          ),
        ).toBe(true);
        expect(
          f.calls.some(
            (call) =>
              call.arguments.includes("blob") && call.arguments.at(-1) === `${sha}:${definition}`,
          ),
        ).toBe(false);
      }
    },
  );

  it("does not promote inherited uncertainty or a same-named field into a proven type relationship", async () => {
    const seed = "engine/Coordinator.cs";
    const definition = "engine/DispatchNode.cs";
    const field = "engine/CoordinatorFields.cs";
    const f = contextFixture(
      new Map([
        [
          seed,
          "namespace Atlas { class Coordinator : Base { private DispatchNode dispatcher; private int DispatchNode; } }\n",
        ],
        [definition, "namespace Atlas { class DispatchNode {} }\n"],
        [field, "namespace Atlas { class CoordinatorFields { private int Coordinator; } }\n"],
      ]),
      new Map([["DispatchNode", [definition]]]),
      new Map([["Coordinator", [seed, field]]]),
    );
    const materialized = await new ProductionInvestigationGitSourceMaterializer(
      f.options,
    ).materialize(f.input, f.context);
    const context = await materialized.readSourceContext!([seed]);
    expect(context.requiredFiles.map((file) => file.path)).toEqual([seed]);
    expect(context.contextFiles.find((file) => file.path === definition)).toMatchObject({
      role: "definition_candidate",
      relation: "unresolved_reference_identity",
      lexicalDeclaration: { name: "DispatchNode", namespace: "Atlas" },
    });
    expect(
      context.contextFiles.every((file) => file.relation === "unresolved_reference_identity"),
    ).toBe(true);
    expect(context.contextFiles.find((file) => file.path === field)?.role).not.toBe(
      "definition_candidate",
    );
    expect(context.queries.every((query) => !Object.hasOwn(query, "provenReferencePaths"))).toBe(
      true,
    );
  });

  it("keeps invalid UTF-8, unsafe paths, and non-head query records fatal", async () => {
    for (const [caseName, code] of [
      ["utf8", "SOURCE_DEPENDENCY_UNREADABLE"],
      ["binary", "SOURCE_DEPENDENCY_UNREADABLE"],
      ["path", "SOURCE_PATH_UNSAFE"],
      ["revision", "SOURCE_BINDING_MISMATCH"],
    ] as const) {
      const f = fixture();
      const seed = "src/Coordinator.cs";
      const definition = "src/DispatchNode.cs";
      f.setListing(tree([seed, definition]));
      f.blobs.set(
        `${sha}:${seed}`,
        "namespace Atlas { class Coordinator { DispatchNode dispatcher; } }\n",
      );
      f.blobs.set(`${sha}:${definition}`, "namespace Atlas { class DispatchNode {} }\n");
      if (caseName === "utf8") f.rawBlobs.set(`${sha}:${seed}`, Buffer.from([0xc3, 0x28]));
      else if (caseName === "binary")
        f.rawBlobs.set(`${sha}:${seed}`, Buffer.from("class Coordinator {}\0"));
      else
        f.grepResults.push({
          exitCode: 0,
          stdout: caseName === "path" ? matches(["../outside.cs"]) : matches([definition], baseSha),
        });
      const materialized = await new ProductionInvestigationGitSourceMaterializer(
        f.options,
      ).materialize(f.input, f.context);
      await expect(materialized.readSourceContext!([seed])).rejects.toMatchObject({ code });
    }
  });

  it("caches independent context copies with both binding checks and refuses later source drift", async () => {
    const seed = "src/Coordinator.cs";
    const content = "namespace Atlas { class Coordinator {} }\n";
    const f = contextFixture(new Map([[seed, content]]));
    const materialized = await new ProductionInvestigationGitSourceMaterializer(
      f.options,
    ).materialize(f.input, f.context);
    const initial = await materialized.readSourceContext!([seed]);
    (initial.seedPaths as string[])[0] = "caller-mutated.cs";
    (
      initial.requiredFiles as Array<{ path: string; content: string; digest: string }>
    )[0]!.content = "caller-mutated content";
    f.calls.length = 0;
    const cached = await materialized.readSourceContext!([seed]);
    expect(cached.seedPaths).toEqual([seed]);
    expect(cached.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
    expect(f.calls.filter((call) => call.arguments.includes("rev-parse"))).toHaveLength(2);
    expect(
      f.calls.filter(
        (call) => call.arguments.includes("grep") || call.arguments.includes("cat-file"),
      ),
    ).toHaveLength(0);
    f.setPatch("A tracked change before the cached context read.");
    await expect(materialized.readSourceContext!([seed])).rejects.toMatchObject({
      code: "SOURCE_BINDING_MISMATCH",
    });
  });

  it("reports catalog overflow counts while retaining required source and bounded query paths", async () => {
    const seed = "src/Coordinator.cs";
    const content = "namespace Atlas { class Coordinator {} }\n";
    const candidates = Array.from(
      { length: 260 },
      (_, index) => `src/Candidate${String(index).padStart(3, "0")}.cs`,
    );
    const contents = new Map([
      [seed, content],
      ...candidates.map(
        (path, index) =>
          [path, `namespace Atlas { class Candidate${index} { Coordinator target; } }\n`] as const,
      ),
    ]);
    const f = contextFixture(contents, new Map(), new Map([["Coordinator", candidates]]));
    const materialized = await new ProductionInvestigationGitSourceMaterializer(
      f.options,
    ).materialize(f.input, f.context);
    const context = await materialized.readSourceContext!([seed]);
    expect(context.requiredFiles).toEqual([{ path: seed, content, digest: hash(content) }]);
    expect(context.catalogComplete).toBe(false);
    expect(context.omittedCandidateCount).toBe(4);
    expect(context.queries).toContainEqual(
      expect.objectContaining({
        kind: "reference",
        symbols: ["Coordinator"],
        matchedPathCount: 260,
        omittedPathCount: 4,
        paths: candidates.slice(0, 256),
      }),
    );
    expect(context.identityScanFiles).toBeLessThanOrEqual(64);
    expect(context.contextFiles.length).toBeLessThanOrEqual(8);
    expect(context.deferred.some((entry) => entry.reason === "candidate_scan_files_budget")).toBe(
      true,
    );
  });
});

describe("managed Git complete-output capture", () => {
  const spec: ProcessLaunchSpec = {
    executable: "C:\\Tools\\git.exe",
    arguments: ["diff"],
    workingDirectory: source,
    environmentMode: "replace",
    environment: {},
    limits: {
      hardTimeoutMs: 10_000,
      maximumProcessCount: 4,
      maximumMemoryBytes: 128 * 1024 * 1024,
      maximumOutputBytes: 4 * 1024 * 1024,
    },
  };
  function managed(
    bytes: Uint8Array,
    completed = Promise.resolve({
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    } as ProcessExitedEvent),
  ): ManagedProcess {
    return {
      requestId: "synthetic-git-request",
      processId: 7,
      stdout: Readable.from([bytes]),
      stderr: Readable.from([]),
      completed,
      terminate: async () => undefined,
    };
  }

  it("retains complete multi-megabyte patch bytes instead of a one-megabyte diagnostic preview", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 65);
    const process = managed(bytes);
    const result = await new ProductionInvestigationGitCommandRunner().run(spec, {
      signal: new AbortController().signal,
      processHost: {
        start: async () => process,
        terminateAll: async () => undefined,
        close: async () => undefined,
      },
    });
    expect(Buffer.from(result.stdout).equals(bytes)).toBe(true);
  });

  it("rejects complete-output budget exhaustion instead of accepting truncated patch data", async () => {
    const process = managed(Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(
      new ProductionInvestigationGitCommandRunner().run(spec, {
        signal: new AbortController().signal,
        processHost: {
          start: async () => process,
          terminateAll: async () => undefined,
          close: async () => undefined,
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_OUTPUT_TOO_LARGE" });
  });

  it("preserves an unconfirmed process settlement fault even when cancellation also arrives", async () => {
    const controller = new AbortController();
    await expect(
      new ProductionInvestigationGitCommandRunner().run(spec, {
        signal: controller.signal,
        processHost: {
          start: async () => {
            controller.abort(new Error("Synthetic cancellation."));
            return managed(
              Buffer.alloc(0),
              Promise.reject(new Error("Synthetic process settlement failure.")),
            );
          },
          terminateAll: async () => undefined,
          close: async () => undefined,
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_PROCESS_CLEANUP_UNCONFIRMED" });
  });
});
