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
  let listing = `100644 blob ${"f".repeat(40)}\tsrc/value.ts\0`;
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
      } else if (command === "ls-tree") stdout = listing;
      else if (command === "merge-base") stdout = `${baseSha}\n`;
      else if (command === "checkout") {
        fs.put(win32.join(gitDirectory, "HEAD"), "file", `${sha}\n`);
        fs.put(win32.join(gitDirectory, "index"), "file", "frozen-index");
        fs.put(win32.join(source, "src"), "directory");
        fs.put(win32.join(source, "src", "value.ts"), "file", "export const value = 1;\n");
      } else if (command === "read-tree")
        fs.put(spec.environment.GIT_INDEX_FILE!, "file", "private-index");
      else if (command === "diff")
        stdout = argumentsList.includes("--name-status")
          ? diffListing
          : argumentsList.includes(baseSha)
            ? `diff --git a/${argumentsList.at(-1)} b/${argumentsList.at(-1)}\ncommitted source diff\n`
            : patch;
      else if (command === "cat-file") {
        const content = blobs.get(argumentsList.at(-1)!);
        if (content === undefined) throw new Error("Missing synthetic Git blob.");
        stdout = content;
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
    setPatch: (value: string) => {
      patch = value;
    },
    setListing: (value: string) => {
      listing = value;
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
      `120000 blob ${sha}\tlink\0`,
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
