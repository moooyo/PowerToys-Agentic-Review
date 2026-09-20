import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { createInvestigationPreview } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import type { ProcessLaunchSpec } from "../execution/process-host-protocol.js";
import {
  type InvestigationGitCommandRunner,
  ProductionInvestigationGitSourceMaterializer,
} from "./git-source.js";
import type {
  InvestigationWorkspaceFileSystem,
  InvestigationWorkspacePathState,
} from "./workspace.js";

const source = "D:\\attempt\\source";
const headSha = "b".repeat(40);
const baseSha = "d".repeat(40);
const expectedSha = "a".repeat(40);
const spdlogSha = "c".repeat(40);
const nestedSha = "e".repeat(40);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const blobHash = (value: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(value)}\0`)
    .update(value)
    .digest("hex");

class GraphFileSystem implements InvestigationWorkspaceFileSystem {
  readonly entries = new Map<
    string,
    { state: InvestigationWorkspacePathState; bytes: Uint8Array }
  >();
  #sequence = 0;
  removeError: Error | undefined;

  constructor() {
    for (const path of ["D:\\", "D:\\attempt", source]) this.put(path, "directory");
  }
  put(path: string, kind: "directory" | "file", content = "") {
    this.entries.set(path, {
      state: {
        kind,
        identity: this.entries.get(path)?.state.identity ?? String(++this.#sequence),
        reparsePoint: false,
        linkCount: 1,
      },
      bytes: Buffer.from(content),
    });
  }
  putFile(root: string, relative: string, content: string) {
    const parts = relative.split("/");
    for (let index = 1; index < parts.length; index++)
      this.put(win32.join(root, ...parts.slice(0, index)), "directory");
    this.put(win32.join(root, ...parts), "file", content);
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
    if (this.entries.has(path)) throw new Error("File already exists.");
    this.put(path, "file");
    this.entries.get(path)!.bytes = Uint8Array.from(bytes);
  }
  async readFile(path: string) {
    const entry = this.entries.get(path);
    if (entry === undefined) throw new Error("Missing synthetic file.");
    return Uint8Array.from(entry.bytes);
  }
  async replaceFile(path: string, bytes: Uint8Array, identity: string) {
    if (this.entries.get(path)?.state.identity !== identity)
      throw new Error("File identity changed.");
    this.entries.get(path)!.bytes = Uint8Array.from(bytes);
  }
  async setReadOnly() {
    /* No ambient filesystem exists in this fixture. */
  }
  async removeFile(path: string) {
    if (this.removeError !== undefined) throw this.removeError;
    this.entries.delete(path);
  }
  async removeEmptyDirectory(path: string) {
    this.entries.delete(path);
  }
}

interface GraphNode {
  readonly mount: string;
  readonly repository: string;
  readonly sha: string;
  readonly files: Map<string, string>;
  readonly links: Map<string, { repository: string; sha: string }>;
  configOutput?: string;
  grepPaths: string[];
  stagedListing?: string;
}

function fixture() {
  const { task, attempt } = createInvestigationPreview("pr");
  task.executionPolicy.mode = "source_read";
  const subject = task.subjects[0]!;
  if (subject.kind !== "original_pr") throw new Error("A PR fixture is required.");
  subject.headSha = headSha;
  subject.baseSha = baseSha;
  subject.revisionKey = hash(`${baseSha}\0${headSha}`);
  const fs = new GraphFileSystem();
  const nodes = new Map<string, GraphNode>();
  const calls: ProcessLaunchSpec[] = [];
  const controller = new AbortController();
  let commandHook: ((node: GraphNode, args: readonly string[]) => void | number) | undefined;
  let diffListing = "";
  let basePointer = expectedSha;
  const addNode = (
    mount: string,
    repository: string,
    sha: string,
    files: Record<string, string>,
  ) => {
    const node: GraphNode = {
      mount,
      repository,
      sha,
      files: new Map(Object.entries(files)),
      links: new Map(),
      grepPaths: [],
    };
    nodes.set(win32.join(source, ...mount.split("/")), node);
    return node;
  };
  const root = addNode("", "moooyo/PowerToys", headSha, {
    "src/value.ts": "class SharedValue {}\n",
  });
  const expected = addNode("deps/expected-lite", "martinmoene/expected-lite", expectedSha, {
    "include/expected.hpp": "class SharedValue {}\n",
  });
  const spdlog = addNode("deps/spdlog", "gabime/spdlog", spdlogSha, {
    "include/logger.hpp": "class Logger {}\n",
  });
  const link = (parent: GraphNode, path: string, child: GraphNode) => {
    parent.links.set(path, { repository: child.repository, sha: child.sha });
    parent.files.set(
      ".gitmodules",
      [...parent.links]
        .map(
          ([name, value]) =>
            `[submodule "${name}"]\n\tpath = ${name}\n\turl = https://github.com/${value.repository}.git\n`,
        )
        .join(""),
    );
  };
  link(root, "deps/expected-lite", expected);
  link(root, "deps/spdlog", spdlog);
  const tree = (node: GraphNode, revision = node.sha) =>
    [
      ...[...node.files].map(([path, content]) => `100644 blob ${blobHash(content)}\t${path}\0`),
      ...[...node.links].map(
        ([path, value]) =>
          `160000 commit ${node === root && revision === baseSha && path === "deps/expected-lite" ? basePointer : value.sha}\t${path}\0`,
      ),
    ].join("");
  const config = (node: GraphNode) =>
    node.configOutput ??
    [...node.links]
      .map(
        ([path, value]) =>
          `submodule.${path}.path\n${path}\0submodule.${path}.url\nhttps://github.com/${value.repository}.git\0`,
      )
      .join("");
  const relative = (rootDirectory: string, path: string) =>
    win32.relative(rootDirectory, path).replaceAll("\\", "/");
  const runner: InvestigationGitCommandRunner = {
    async run(spec) {
      calls.push(structuredClone(spec));
      const args = [...spec.arguments];
      while (args[0] === "-c") args.splice(0, 2);
      const node = nodes.get(spec.workingDirectory);
      if (node === undefined) throw new Error("Unexpected synthetic repository CWD.");
      const code = commandHook?.(node, args);
      if (code !== undefined)
        return { exitCode: code, stdout: Buffer.from("synthetic-private-server-detail") };
      const rootDirectory = spec.workingDirectory;
      const git = win32.join(rootDirectory, ".git");
      let stdout = "";
      switch (args[0]) {
        case "init":
          fs.put(git, "directory");
          fs.put(win32.join(git, "config"), "file", "[core]\nrepositoryformatversion = 0\n");
          fs.put(win32.join(git, "HEAD"), "file", "ref: refs/heads/investigation\n");
          break;
        case "fetch":
          if (
            args.at(-2) !== `https://github.com/${node.repository}.git` ||
            ![node.sha, ...(node === root ? [baseSha] : [])].includes(args.at(-1)!)
          )
            throw new Error("A fetch escaped its pinned synthetic repository.");
          break;
        case "rev-parse":
          stdout =
            args[2] === "HEAD^{commit}"
              ? Buffer.from(await fs.readFile(win32.join(git, "HEAD"))).toString("utf8")
              : `${args[2]!.slice(0, 40)}\n`;
          break;
        case "ls-tree":
          stdout = tree(node, args.at(-1)!);
          break;
        case "merge-base":
          stdout = `${baseSha}\n`;
          break;
        case "checkout":
          if (args.at(-1) !== node.sha) throw new Error("A checkout escaped its exact commit.");
          fs.put(win32.join(git, "HEAD"), "file", `${node.sha}\n`);
          fs.put(win32.join(git, "index"), "file", "frozen-index");
          for (const [path, content] of node.files) fs.putFile(rootDirectory, path, content);
          break;
        case "config":
          if (
            args.join(" ") !== `config --no-includes --null --blob=${node.sha}:.gitmodules --list`
          )
            throw new Error("Submodule metadata must come from the pinned non-including blob.");
          stdout = config(node);
          break;
        case "cat-file": {
          const reference = args.at(-1)!;
          const prefix = `${node.sha}:`;
          if (!reference.startsWith(prefix))
            throw new Error("Blob read escaped its repository revision.");
          const content = node.files.get(reference.slice(prefix.length));
          if (content === undefined) throw new Error("Cannot read a gitlink as a blob.");
          stdout = args[1] === "-s" ? `${Buffer.byteLength(content)}\n` : content;
          break;
        }
        case "grep":
          if (args[args.indexOf("--") - 1] !== node.sha)
            throw new Error("Search escaped its repository revision.");
          stdout = node.grepPaths.map((path) => `${node.sha}:${path}\0`).join("");
          return { exitCode: stdout === "" ? 1 : 0, stdout: Buffer.from(stdout) };
        case "diff":
          if (args.includes("--name-status")) stdout = diffListing;
          else if (args.includes(baseSha))
            stdout =
              "diff --git a/deps/expected-lite b/deps/expected-lite\nSubproject commit changed\n";
          else {
            const path = args.at(-1);
            stdout = [...node.files].some(
              ([name, value]) =>
                (path !== ".gitmodules" || name === path) &&
                Buffer.from(
                  fs.entries.get(win32.join(rootDirectory, ...name.split("/")))?.bytes ?? [],
                ).toString("utf8") !== value,
            )
              ? "tracked source changed\n"
              : "";
          }
          break;
        case "ls-files":
          stdout = args.includes("--stage")
            ? (node.stagedListing ??
              tree(node)
                .replaceAll(" blob ", " ")
                .replaceAll(" commit ", " ")
                .replaceAll("\t", " 0\t"))
            : [...fs.entries]
                .filter(([path, entry]) => {
                  if (entry.state.kind !== "file" || !path.startsWith(`${rootDirectory}\\`))
                    return false;
                  const name = relative(rootDirectory, path);
                  return (
                    !name.startsWith(".git/") &&
                    !node.files.has(name) &&
                    ![...node.links.keys()].some((mount) => name.startsWith(`${mount}/`))
                  );
                })
                .map(([path]) => `${relative(rootDirectory, path)}\0`)
                .join("");
          break;
        case "read-tree":
          fs.put(spec.environment.GIT_INDEX_FILE!, "file", "private-index");
          break;
        case "add":
          break;
        default:
          throw new Error(`Unexpected synthetic Git command: ${args[0]}`);
      }
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
    signal: controller.signal,
    processHost: {
      start: async () => {
        throw new Error("Synthetic source tests never launch processes.");
      },
      terminateAll: async () => undefined,
      close: async () => undefined,
    },
  };
  const input = { task, attempt, inputSnapshot: null, destinationDirectory: source };
  return {
    input,
    context,
    options,
    fs,
    nodes,
    calls,
    root,
    expected,
    spdlog,
    addNode,
    link,
    controller,
    setCommandHook: (hook: typeof commandHook) => {
      commandHook = hook;
    },
    setPointerDiff: (oldSha: string) => {
      basePointer = oldSha;
      diffListing = "M\0deps/expected-lite\0";
    },
    materialize: () =>
      new ProductionInvestigationGitSourceMaterializer(options).materialize(input, context),
  };
}

describe("pinned Git submodule source graphs", () => {
  it("materializes both public dependencies at exact commits without inherited configuration or recursive Git helpers", async () => {
    const f = fixture();
    const result = await f.materialize();
    expect(result.binding.submodules).toEqual([
      {
        path: "deps/expected-lite",
        repository: f.expected.repository,
        commitSha: expectedSha,
        parentPath: null,
        parentCommitSha: headSha,
      },
      {
        path: "deps/spdlog",
        repository: f.spdlog.repository,
        commitSha: spdlogSha,
        parentPath: null,
        parentCommitSha: headSha,
      },
    ]);
    const childCalls = f.calls.filter((call) => call.workingDirectory !== source);
    expect(
      childCalls
        .filter((call) => call.arguments.includes("fetch"))
        .map((call) => call.arguments.slice(-2)),
    ).toEqual([
      [`https://github.com/${f.expected.repository}.git`, expectedSha],
      [`https://github.com/${f.spdlog.repository}.git`, spdlogSha],
    ]);
    for (const call of childCalls) {
      expect(call.environmentMode).toBe("replace");
      expect(call.environment).toMatchObject({
        GIT_CONFIG_GLOBAL: "NUL",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(call.arguments).toContain("credential.helper=");
      expect(call.arguments).toContain("protocol.allow=never");
      expect(call.arguments).not.toContain("submodule");
      expect(call.arguments).not.toContain("update");
      expect(call.arguments).not.toContain("--branch");
      if (call.arguments.includes("fetch")) expect(call.arguments).toContain("--depth=1");
      if (call.arguments.includes("checkout")) expect(call.arguments).toContain("--detach");
    }
  });

  it("preserves nested mount identities and reads files through each child's own immutable revision", async () => {
    const f = fixture();
    const nested = f.addNode("deps/expected-lite/vendor/core", "example/core", nestedSha, {
      "src/Core.hpp": "class Core {}\n",
    });
    f.link(f.expected, "vendor/core", nested);
    const result = await f.materialize();
    expect(result.binding.submodules).toContainEqual({
      path: nested.mount,
      repository: nested.repository,
      commitSha: nestedSha,
      parentPath: "deps/expected-lite",
      parentCommitSha: expectedSha,
    });
    const path = `${nested.mount}/src/Core.hpp`;
    const context = await result.readSourceContext!([path]);
    expect(context.requiredFiles).toContainEqual({
      path,
      content: "class Core {}\n",
      digest: hash("class Core {}\n"),
    });
    await expect(
      result.assertReadBinding!({
        path,
        content: "class Core {}\n",
        digest: hash("class Core {}\n"),
      }),
    ).resolves.toBeUndefined();
    expect(
      f.calls.some(
        (call) =>
          call.workingDirectory === win32.join(source, ...nested.mount.split("/")) &&
          call.arguments.at(-1) === `${nestedSha}:src/Core.hpp`,
      ),
    ).toBe(true);
    expect(
      f.calls.some(
        (call) =>
          call.workingDirectory === source && call.arguments.at(-1) === `${headSha}:${path}`,
      ),
    ).toBe(false);
  });

  it("mounts child dependency matches without attributing the child's bytes to the parent SHA", async () => {
    const f = fixture();
    f.expected.grepPaths = ["include/expected.hpp"];
    const result = await f.materialize();
    const dependencies = await result.readSourceDependencies!(["src/value.ts"]);
    expect(dependencies.files).toContainEqual({
      path: "deps/expected-lite/include/expected.hpp",
      content: "class SharedValue {}\n",
      digest: hash("class SharedValue {}\n"),
    });
    expect(dependencies.queries[0]?.paths).toContain("deps/expected-lite/include/expected.hpp");
    const search = f.calls.find(
      (call) => call.workingDirectory.endsWith("expected-lite") && call.arguments.includes("grep"),
    );
    expect(search?.arguments[search.arguments.indexOf("--") - 1]).toBe(expectedSha);
  });

  it("exposes changed gitlinks as complete pointer chunks and marks mount seeds unsearched", async () => {
    const f = fixture();
    const oldSha = "f".repeat(40);
    f.setPointerDiff(oldSha);
    const result = await f.materialize();
    expect(result.binding.gitlinks).toContainEqual({
      path: "deps/expected-lite",
      revisionSha: baseSha,
      commitSha: oldSha,
    });
    const manifest = await result.readPrDiffManifest!();
    const chunks = await result.readPrDiffChunks!(manifest.files[0]!.chunkIds);
    expect(chunks.find((chunk) => chunk.kind === "base")?.content).toBe(
      `Subproject commit ${oldSha}\n`,
    );
    expect(chunks.find((chunk) => chunk.kind === "head")?.content).toBe(
      `Subproject commit ${expectedSha}\n`,
    );
    expect(await result.readSourceDependencies!(["deps/expected-lite"])).toMatchObject({
      unsupportedSeedPaths: ["deps/expected-lite"],
      files: [],
      symbols: [],
      queries: [],
    });
    expect(
      f.calls.some(
        (call) =>
          call.arguments.includes("cat-file") &&
          call.arguments.at(-1)?.endsWith(":deps/expected-lite"),
      ),
    ).toBe(false);
    const pointer = `Subproject commit ${expectedSha}\n`;
    await expect(
      result.assertReadBinding!({
        path: "deps/expected-lite",
        content: pointer,
        digest: hash(pointer),
      }),
    ).resolves.toBeUndefined();
    await expect(
      result.assertReadBinding!({
        path: "deps/expected-lite",
        content: "wrong",
        digest: hash("wrong"),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_SUBMODULE_BINDING_MISMATCH" });
  });

  it.each(["HEAD", "config", "index"])("rejects changed child %s metadata", async (name) => {
    const f = fixture();
    const result = await f.materialize();
    f.fs.put(win32.join(source, "deps", "expected-lite", ".git", name), "file", "tampered");
    await expect(result.assertBinding()).rejects.toMatchObject({
      code: "SOURCE_SUBMODULE_BINDING_MISMATCH",
    });
  });

  it("rejects a replacement child directory even when its recorded file bytes are unchanged", async () => {
    const f = fixture();
    const result = await f.materialize();
    const directory = f.fs.entries.get(win32.join(source, "deps", "expected-lite"))!;
    directory.state = { ...directory.state, identity: "replacement-directory" };
    await expect(result.assertReadBinding!()).rejects.toMatchObject({
      code: "SOURCE_SUBMODULE_BINDING_MISMATCH",
    });
  });

  it("rejects changed child tracked bytes both during full verification and a specific file observation", async () => {
    const f = fixture();
    const result = await f.materialize();
    const path = "deps/expected-lite/include/expected.hpp";
    f.fs.putFile(source, path, "class DifferentValue {}\n");
    await expect(result.assertBinding()).rejects.toMatchObject({
      code: "SOURCE_SUBMODULE_BINDING_MISMATCH",
    });
    await expect(
      result.assertReadBinding!({
        path,
        content: "class DifferentValue {}\n",
        digest: hash("class DifferentValue {}\n"),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_SUBMODULE_BINDING_MISMATCH" });
  });

  it.each(["source_read", "execute"] as const)(
    "applies the %s policy to child untracked build outputs",
    async (mode) => {
      const f = fixture();
      f.input.task.executionPolicy.mode = mode;
      if (mode === "execute") {
        f.input.task.kind = "pr-e2e";
        f.input.task.executionPolicy.allowRepositoryExecution = true;
        f.input.task.executionPolicy.authorizationRef = "synthetic-e2e-source";
      }
      const result = await f.materialize();
      f.fs.putFile(source, "deps/expected-lite/build/generated.obj", "output");
      if (mode === "source_read")
        await expect(result.assertBinding()).rejects.toMatchObject({
          code: "SOURCE_SUBMODULE_BINDING_MISMATCH",
        });
      else await expect(result.assertBinding()).resolves.toBeUndefined();
    },
  );

  it.each(["missing", "undeclared", "unsafe-url"])(
    "rejects %s frozen declarations before fetching any child",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") f.root.files.delete(".gitmodules");
      else if (kind === "undeclared") f.root.configOutput = "";
      else
        f.root.configOutput =
          "submodule.x.path\ndeps/expected-lite\0submodule.x.url\nfile:///secret\0";
      await expect(f.materialize()).rejects.toMatchObject({ code: "SOURCE_SUBMODULE_UNSUPPORTED" });
      expect(f.calls.some((call) => call.workingDirectory !== source)).toBe(false);
    },
  );

  it("rejects a repository-and-commit ancestry cycle before fetching the repeated node", async () => {
    const f = fixture();
    f.link(f.expected, "vendor/root", f.root);
    await expect(f.materialize()).rejects.toMatchObject({ code: "SOURCE_SUBMODULE_UNSUPPORTED" });
    expect(f.calls.some((call) => call.workingDirectory.includes("vendor\\root"))).toBe(false);
  });

  it.each(["count", "depth", "aggregate"])("enforces the graph-wide %s limit", async (kind) => {
    const f = fixture();
    const options = { ...f.options };
    const bounds =
      kind === "count"
        ? { maximumSubmodules: 1 }
        : kind === "depth"
          ? { maximumSubmoduleDepth: 1 }
          : { maximumTreeEntries: 10 };
    if (kind === "depth") {
      const nested = f.addNode("deps/expected-lite/vendor/core", "example/core", nestedSha, {
        "file.txt": "core",
      });
      f.link(f.expected, "vendor/core", nested);
    }
    if (kind === "aggregate") {
      for (const name of ["a.txt", "b.txt"]) f.root.files.set(name, "content");
      for (const name of ["a.txt", "b.txt", "c.txt"]) f.expected.files.set(name, "content");
    }
    await expect(
      new ProductionInvestigationGitSourceMaterializer({ ...options, ...bounds }).materialize(
        f.input,
        f.context,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_SUBMODULE_LIMIT_EXCEEDED" });
  });

  it("reports an unavailable child commit without exposing transport output", async () => {
    const f = fixture();
    f.setCommandHook((node, args) =>
      node === f.expected && args[0] === "fetch" ? 128 : undefined,
    );
    await expect(f.materialize()).rejects.toMatchObject({
      code: "SOURCE_SUBMODULE_UNAVAILABLE",
      message: "A public pinned submodule commit could not be acquired.",
    });
  });

  it.each(["cancel", "process-cleanup"])(
    "does not reclassify a child %s failure as a missing dependency",
    async (kind) => {
      const f = fixture();
      const failure = new Error("Synthetic owned process termination failure.");
      f.setCommandHook((node, args) => {
        if (node !== f.expected || args[0] !== "fetch") return;
        if (kind === "cancel") {
          f.controller.abort(failure);
          return;
        }
        throw failure;
      });
      await expect(f.materialize()).rejects.toBe(failure);
    },
  );

  it("does not capture a patch that changes frozen gitlink topology", async () => {
    const f = fixture();
    const result = await f.materialize();
    f.root.stagedListing = "";
    await expect(result.capturePatch!(f.context.signal)).rejects.toMatchObject({
      code: "SOURCE_SUBMODULE_UNSUPPORTED",
    });
  });

  it("does not capture child source edits as an incomplete parent patch", async () => {
    const f = fixture();
    f.input.task.kind = "issue-fix";
    f.input.task.executionPolicy = {
      ...f.input.task.executionPolicy,
      mode: "execute",
      allowRepositoryExecution: true,
      authorizationRef: "synthetic-source-mutation",
    };
    const result = await f.materialize();
    f.fs.putFile(source, "deps/spdlog/include/logger.hpp", "class EditedLogger {}\n");
    await expect(result.capturePatch!(f.context.signal)).rejects.toMatchObject({
      code: "SOURCE_SUBMODULE_BINDING_MISMATCH",
    });
  });

  it("preserves a private-index cleanup failure instead of reporting successful capture", async () => {
    const f = fixture();
    const result = await f.materialize();
    const failure = new Error("Synthetic index cleanup failure.");
    f.fs.removeError = failure;
    await expect(result.capturePatch!(f.context.signal)).rejects.toBe(failure);
  });
});
