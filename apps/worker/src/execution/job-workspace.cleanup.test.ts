import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { JobExecutionEnvelope } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type JobWorkspaceError,
  ProductionDisposableJobWorkspaceProvider,
} from "./job-workspace.js";
import {
  type ManagedProcessRunContext,
  ManagedProcessRunError,
  type ManagedProcessRunner,
  type ManagedProcessRunResult,
} from "./managed-process-runner.js";
import type { ProcessHostClient, ProcessLaunchSpec } from "./process-host-protocol.js";
import { ProductionWorkspaceDiskBudget } from "./workspace-disk-budget.js";

const fixturePrefix = "agentic-review-workspace-cleanup-";
const temporaryRoots = new Map<string, string>();
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const bareHeadContents = "ref: refs/heads/test-base\n";
const gitCommands = new Set([
  "init",
  "config",
  "fetch",
  "reflog",
  "gc",
  "cat-file",
  "merge-base",
  "worktree",
  "rev-parse",
]);

class FileSystemGitRunner implements ManagedProcessRunner {
  public readonly removalSignals: AbortSignal[] = [];
  public afterWorktreeRemoval: (() => Promise<void>) | undefined;
  public latestSpec: ProcessLaunchSpec | undefined;
  public removeImplementation:
    | ((
        spec: ProcessLaunchSpec,
        context: ManagedProcessRunContext,
      ) => Promise<ManagedProcessRunResult>)
    | undefined;

  public constructor(private readonly fixtureRoot: string) {}

  public async run(
    spec: ProcessLaunchSpec,
    context: ManagedProcessRunContext,
  ): Promise<ManagedProcessRunResult> {
    context.signal.throwIfAborted();
    this.latestSpec = spec;
    const command = spec.arguments.find((argument) => gitCommands.has(argument));
    if (command === undefined) throw new Error("Unexpected fake Git command.");
    if (command === "init") {
      const repository = requiredArgument(spec.arguments.at(-1));
      await mkdir(assertOwnedPath(this.fixtureRoot, repository));
      await writeFile(join(repository, "HEAD"), bareHeadContents);
    }
    if (command === "worktree" && spec.arguments.includes("add")) {
      const checkout = requiredArgument(spec.arguments.at(-2));
      await writeFile(join(assertOwnedPath(this.fixtureRoot, checkout), "README.md"), "Fixture\n");
    }
    if (command === "worktree" && spec.arguments.includes("remove")) {
      const checkout = requiredArgument(spec.arguments.at(-1));
      this.removalSignals.push(context.signal);
      if (this.removeImplementation !== undefined) {
        const result = await this.removeImplementation(spec, context);
        if (result.exitCode !== 0) {
          throw new ManagedProcessRunError(
            "NON_ZERO_EXIT",
            "Real Git worktree removal failed.",
            result,
          );
        }
        await this.afterWorktreeRemoval?.();
        return result;
      }
      await rm(assertOwnedPath(this.fixtureRoot, checkout), { recursive: true, force: false });
      await this.afterWorktreeRemoval?.();
    }
    let stdout = "";
    if (command === "cat-file") stdout = "commit\n";
    if (command === "merge-base") stdout = `${baseSha}\n`;
    if (command === "rev-parse") {
      stdout = spec.arguments.includes("refs/agentic-review/latest-base^{commit}")
        ? `${baseSha}\n`
        : `${headSha}\n`;
    }
    return { exitCode: 0, stdout, stderr: "" };
  }
}

const unusedProcessHost: ProcessHostClient = {
  start: async () => {
    throw new Error("The filesystem cleanup regression must not start a real process.");
  },
  terminateAll: async () => undefined,
  close: async () => undefined,
};

async function createFixture(gitExecutable?: string) {
  const parent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(parent, fixturePrefix)));
  temporaryRoots.set(root, parent);
  const workspaceRoot = join(root, "workspaces");
  const sharedRoot = join(root, "repositories");
  const gitWorkingDirectory = join(root, "git-cwd");
  await mkdir(workspaceRoot);
  await mkdir(sharedRoot);
  await mkdir(gitWorkingDirectory);
  const runner = new FileSystemGitRunner(root);
  const diskBudget = new ProductionWorkspaceDiskBudget({
    workspaceRootDirectory: workspaceRoot,
    perAttemptDiskBytes: 1024n * 1024n,
    totalWorkspaceDiskBytes: 4n * 1024n * 1024n,
    minimumFreeDiskBytes: 0n,
    orphanRetentionMilliseconds: 1_000n,
    orphanScanLimit: 100,
    maximumAccountingEntries: 1_000,
    maximumSnapshotGenerations: 1,
  });
  const provider = new ProductionDisposableJobWorkspaceProvider({
    workspaceRootDirectory: workspaceRoot,
    gitSharedRootDirectory: sharedRoot,
    gitExecutable: gitExecutable ?? join(root, "trusted", "git.exe"),
    gitWorkingDirectory,
    gitEnvironment: {
      SYSTEMROOT: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32;C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
    gitLimits: {
      hardTimeoutMs: 60_000,
      maximumProcessCount: 4,
      maximumMemoryBytes: 536_870_912,
      maximumOutputBytes: 1_048_576,
    },
    gitSharedCachePolicy: {
      maximumTotalBytes: 1024n * 1024n,
      minimumFreeBytes: 0n,
      maximumScanEntries: 1_000,
      maximumScanDurationMs: 30_000,
      gcMinimumIntervalMs: 60_000,
      gcPruneAgeHours: 168,
    },
    diskBudget,
    processRunner: runner,
  });
  return { root, sharedRoot, runner, diskBudget, provider };
}

afterEach(async () => {
  for (const [root, parent] of temporaryRoots) {
    if (
      win32.normalize(dirname(root)).toLowerCase() !== win32.normalize(parent).toLowerCase() ||
      !basename(root).startsWith(fixturePrefix)
    ) {
      throw new Error("Refusing to remove an unrecognized temporary fixture.");
    }
    await rm(assertOwnedPath(root, root), { recursive: true, force: true });
    temporaryRoots.delete(root);
  }
});

describe.skipIf(process.platform !== "win32")(
  "real filesystem workspace cancellation cleanup",
  () => {
    it.each([false, true])(
      "removes a cancelled attempt with pnpm junctions and preserves external targets: %s",
      async (includeExternalJunction) => {
        const fixture = await createFixture();
        const controller = new AbortController();
        const healthFaults: JobWorkspaceError[] = [];
        const workspace = await fixture.provider.prepare(envelope(), {
          signal: controller.signal,
          processHost: unusedProcessHost,
          reportProcessCount: () => undefined,
          reportNodeHealthFault: (error) => healthFaults.push(error),
        });
        const projects = join(workspace.tempDirectory, "pnpm-store", "v11", "projects");
        await mkdir(projects, { recursive: true });
        const projectLink = join(projects, "reviewed-project");
        await symlink(workspace.checkoutDirectory, projectLink, "junction");
        const outsideDirectory = join(fixture.root, "outside-attempt");
        await mkdir(outsideDirectory);
        const outsideMarker = join(outsideDirectory, "marker.txt");
        const markerContents = "External target must survive cancelled attempt cleanup.";
        await writeFile(outsideMarker, markerContents);
        if (includeExternalJunction) {
          await symlink(outsideDirectory, join(projects, "external-project"), "junction");
        }
        let observedDanglingProject = false;
        fixture.runner.afterWorktreeRemoval = async () => {
          expect((await lstat(projectLink)).isSymbolicLink()).toBe(true);
          await expect(realpath(projectLink)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await readFile(outsideMarker, "utf8")).toBe(markerContents);
          observedDanglingProject = true;
        };

        controller.abort(new Error("Synthetic lease cancellation."));
        assertOwnedPath(fixture.root, workspace.attemptDirectory);
        await expect(workspace.cleanup()).resolves.toBeUndefined();

        expect(observedDanglingProject).toBe(true);
        expect(fixture.runner.removalSignals).toHaveLength(1);
        expect(fixture.runner.removalSignals[0]).not.toBe(controller.signal);
        expect(fixture.runner.removalSignals[0]?.aborted).toBe(false);
        expect(healthFaults).toEqual([]);
        await expect(lstat(workspace.attemptDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(outsideMarker, "utf8")).toBe(markerContents);
        const sharedRepository = join(fixture.sharedRoot, "repository-1844564.git");
        expect((await lstat(sharedRepository)).isDirectory()).toBe(true);
        expect(await readFile(join(sharedRepository, "HEAD"), "utf8")).toBe(bareHeadContents);
        const readmitted = await fixture.diskBudget.admit(workspace.attemptDirectory);
        await readmitted.release();
      },
    );

    it("runs production Git cleanup arguments against a real worktree with long pnpm paths", async () => {
      const executable = await findGitExecutable();
      const fixture = await createFixture(executable);
      const healthFaults: JobWorkspaceError[] = [];
      const workspace = await fixture.provider.prepare(envelope(), {
        signal: new AbortController().signal,
        processHost: unusedProcessHost,
        reportProcessCount: () => undefined,
        reportNodeHealthFault: (error) => healthFaults.push(error),
      });
      const preparationSpec = fixture.runner.latestSpec;
      if (preparationSpec === undefined)
        throw new Error("Preparation did not produce a Git launch.");
      const localGit = async (argumentsList: readonly string[]): Promise<void> => {
        const result = await runRealGit({ ...preparationSpec, arguments: argumentsList });
        expect(result, result.stderr).toMatchObject({ exitCode: 0 });
      };
      const seed = join(fixture.root, "seed");
      const sharedRepository = join(fixture.sharedRoot, "repository-1844564.git");
      await localGit(["init", "--quiet", seed]);
      await writeFile(join(seed, "README.md"), "Local seed commit.\n");
      await localGit(["-C", seed, "add", "README.md"]);
      await localGit([
        "-C",
        seed,
        "-c",
        "user.name=Cleanup fixture",
        "-c",
        "user.email=cleanup-fixture@example.invalid",
        "-c",
        "core.hooksPath=NUL",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Local cleanup fixture",
      ]);
      await localGit(["init", "--bare", "--quiet", sharedRepository]);
      await localGit([
        `--git-dir=${sharedRepository}`,
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--quiet",
        "--no-tags",
        seed,
        "HEAD:refs/heads/fixture",
      ]);
      await rm(assertOwnedPath(fixture.root, workspace.checkoutDirectory), {
        recursive: true,
        force: false,
      });
      await localGit([
        `--git-dir=${sharedRepository}`,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        "--force",
        workspace.checkoutDirectory,
        "refs/heads/fixture",
      ]);
      const deepDirectory = join(
        workspace.checkoutDirectory,
        "node_modules",
        ".pnpm",
        `@fixture+package@1.0.0_${"dependency".repeat(8)}`,
        "node_modules",
        "@fixture",
        "package",
        "dist",
        `generated-${"nested".repeat(12)}`,
      );
      await mkdir(deepDirectory, { recursive: true });
      const deepFile = join(deepDirectory, "types.d.ts");
      await writeFile(deepFile, "export type Fixture = string;\n");
      expect(deepFile.length).toBeGreaterThan(260);
      const outsideDirectory = join(fixture.root, "external-target");
      await mkdir(outsideDirectory);
      const marker = join(outsideDirectory, "marker.txt");
      await writeFile(marker, "Preserve the external target.");
      await symlink(outsideDirectory, join(workspace.tempDirectory, "external-link"), "junction");
      let removalResult: ManagedProcessRunResult | undefined;
      fixture.runner.removeImplementation = async (spec, context) => {
        removalResult = await runRealGit(spec, context.signal);
        return removalResult;
      };

      assertOwnedPath(fixture.root, workspace.attemptDirectory);
      await expect(workspace.cleanup()).resolves.toBeUndefined();

      expect(removalResult, removalResult?.stderr).toMatchObject({ exitCode: 0 });
      expect(healthFaults).toEqual([]);
      await expect(lstat(workspace.checkoutDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(workspace.attemptDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(marker, "utf8")).toBe("Preserve the external target.");
      expect((await lstat(sharedRepository)).isDirectory()).toBe(true);
    }, 120_000);
  },
);

async function findGitExecutable(): Promise<string> {
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(";")) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "git.exe");
    try {
      if ((await lstat(candidate)).isFile()) return await realpath(candidate);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  throw new Error("Git for Windows was not found on PATH.");
}

function runRealGit(
  spec: ProcessLaunchSpec,
  signal?: AbortSignal,
): Promise<ManagedProcessRunResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      spec.executable,
      [...spec.arguments],
      {
        cwd: spec.workingDirectory,
        env: { ...spec.environment },
        windowsHide: true,
        timeout: spec.limits.hardTimeoutMs,
        maxBuffer: spec.limits.maximumOutputBytes,
        encoding: "utf8",
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : error.code;
        if (typeof exitCode !== "number") {
          reject(error);
          return;
        }
        resolveResult({ exitCode, stdout, stderr });
      },
    );
  });
}

function assertOwnedPath(root: string, target: string): string {
  const absoluteTarget = resolve(target);
  const pathFromRoot = relative(resolve(root), absoluteTarget);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${win32.sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Refusing to mutate a path outside the test fixture.");
  }
  return absoluteTarget;
}

function requiredArgument(argument: string | undefined): string {
  if (argument === undefined) throw new Error("The fake Git command is missing its target.");
  return argument;
}

function envelope(): JobExecutionEnvelope {
  return {
    protocolVersion: "1.0",
    envelopeVersion: 1,
    assignedAt: "2026-09-05T00:00:00.000Z",
    leaseExpiresAt: "2026-09-05T00:02:00.000Z",
    executionDeadlineAt: "2026-09-05T00:20:00.000Z",
    lease: {
      jobId: "cleanup-job",
      runAttemptId: "cleanup-attempt",
      workerNodeId: "worker-1",
      workerInstanceId: "instance-1",
      leaseToken: "synthetic-lease-token-".padEnd(40, "x"),
      leaseGeneration: 1,
    },
    job: {
      jobId: "cleanup-job",
      kind: "pull_request_review",
      priority: 10,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "cleanup-fixture",
    },
    repository: { githubRepositoryId: 1844564, fullName: "microsoft/PowerToys" },
    resource: {
      kind: "pull_request",
      githubNodeId: "PR_cleanup_fixture",
      number: 42,
      title: "Cleanup fixture",
      author: { githubUserId: 7, login: "contributor", accountType: "user" },
      canonicalSnapshot: { body: "Synthetic cleanup regression." },
      baseSha,
      headSha,
      isDraft: false,
    },
    prompt: {
      name: "pull-request-review",
      version: "1",
      renderedPrompt: "Synthetic cleanup regression.",
      promptSha256: "0".repeat(64),
      outputSchema: { type: "object" },
      outputSchemaSha256: "0".repeat(64),
    },
    executionPolicy: {
      hardTimeoutMs: 1_200_000,
      noProgressTimeoutMs: 300_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}
