import { win32 } from "node:path";
import type { JobExecutionEnvelope } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleJsonLogger, type Logger } from "../logging/logger.js";
import {
  JobWorkspaceError,
  type JobWorkspaceFileSystem,
  ProductionDisposableJobWorkspaceProvider,
  type WorkspacePathState,
  type WorkspacePreparationContext,
} from "./job-workspace.js";
import {
  type ManagedProcessRunContext,
  ManagedProcessRunError,
  type ManagedProcessRunFailureCode,
  type ManagedProcessRunner,
  type ManagedProcessRunResult,
} from "./managed-process-runner.js";
import type { ProcessHostClient, ProcessLaunchSpec } from "./process-host-protocol.js";
import {
  type WorkspaceDiskBudget,
  WorkspaceDiskBudgetError,
  type WorkspaceDiskMonitor,
  type WorkspaceDiskReservation,
} from "./workspace-disk-budget.js";

const workspaceRoot = "C:\\AgenticReview\\workspaces";
const gitExecutable = "C:\\Program Files\\Git\\cmd\\git.exe";
const gitWorkingDirectory = "C:\\AgenticReview\\git-cwd";
const gitSharedRootDirectory = "C:\\AgenticReview\\repositories";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const digest = "0".repeat(64);

interface FakePathEntry extends WorkspacePathState {
  readonly path: string;
  realPath: string;
}

class FakeWorkspaceFileSystem implements JobWorkspaceFileSystem {
  readonly #entries = new Map<string, FakePathEntry>();
  public readonly created: string[] = [];
  public readonly removed: string[] = [];
  public availableBytesValue = 500n * 1024n * 1024n * 1024n;
  public createFailureAt: number | undefined;
  #createCalls = 0;

  public constructor(root = workspaceRoot) {
    this.addDirectory(root);
    this.addDirectory(gitWorkingDirectory);
    this.addDirectory(gitSharedRootDirectory);
  }

  public async lstat(path: string): Promise<WorkspacePathState | null> {
    const entry = this.#entries.get(key(path));
    return entry === undefined
      ? null
      : { kind: entry.kind, reparsePoint: entry.reparsePoint, size: entry.size };
  }

  public async realpath(path: string): Promise<string> {
    const entry = this.#entries.get(key(path));
    if (entry === undefined) throw fileSystemError("ENOENT", `Missing path ${path}`);
    return entry.realPath;
  }

  public async readDirectory(path: string): Promise<readonly string[]> {
    if (!this.#entries.has(key(path))) throw fileSystemError("ENOENT", `Missing path ${path}`);
    const parent = key(path);
    return [...this.#entries.values()]
      .filter((entry) => key(win32.dirname(entry.path)) === parent && key(entry.path) !== parent)
      .map((entry) => win32.basename(entry.path));
  }

  public async createDirectory(path: string): Promise<void> {
    this.#createCalls += 1;
    if (this.createFailureAt === this.#createCalls) {
      throw fileSystemError("EIO", `Injected create failure for ${path}`);
    }
    if (this.#entries.has(key(path))) throw fileSystemError("EEXIST", `Existing path ${path}`);
    if (!this.#entries.has(key(win32.dirname(path)))) {
      throw fileSystemError("ENOENT", `Missing parent for ${path}`);
    }
    this.addDirectory(path);
    this.created.push(path);
  }

  public async availableBytes(path: string): Promise<bigint> {
    if (!this.#entries.has(key(path))) throw fileSystemError("ENOENT", `Missing path ${path}`);
    return this.availableBytesValue;
  }

  public async removeTree(path: string): Promise<void> {
    const target = key(path);
    this.removed.push(path);
    for (const [entryKey] of this.#entries) {
      const relative = win32.relative(target, entryKey);
      if (relative === "" || (!win32.isAbsolute(relative) && !relative.startsWith(".."))) {
        this.#entries.delete(entryKey);
      }
    }
  }

  public addDirectory(path: string): void {
    this.#entries.set(key(path), {
      path,
      kind: "directory",
      reparsePoint: false,
      size: 0n,
      realPath: path,
    });
  }

  public addFile(path: string, size: bigint): void {
    const parent = key(win32.dirname(path));
    if (!this.#entries.has(parent)) {
      throw new Error(`Missing parent for file ${path}`);
    }
    this.#entries.set(key(path), {
      path,
      kind: "file",
      reparsePoint: false,
      size,
      realPath: path,
    });
  }

  public removePath(path: string): void {
    this.#entries.delete(key(path));
  }

  public setReparsePoint(path: string, reparsePoint: boolean): void {
    const entry = this.#entry(path);
    this.#entries.set(key(path), { ...entry, reparsePoint });
  }

  public setRealPath(path: string, realPath: string): void {
    this.#entry(path).realPath = realPath;
  }

  public has(path: string): boolean {
    return this.#entries.has(key(path));
  }

  #entry(path: string): FakePathEntry {
    const entry = this.#entries.get(key(path));
    if (entry === undefined) throw new Error(`Missing fake path ${path}`);
    return entry;
  }
}

class FakeManagedProcessRunner implements ManagedProcessRunner {
  public readonly calls: Array<{
    readonly spec: ProcessLaunchSpec;
    readonly context: ManagedProcessRunContext;
  }> = [];
  public failAtCall: number | undefined;
  public failureCode: ManagedProcessRunFailureCode = "NON_ZERO_EXIT";
  public pullRequestBaseOutput = `${baseSha}\n`;
  public pullRequestHeadOutput = `${headSha}\n`;
  public worktreeHeadOutput = `${headSha}\n`;
  public worktreeListOutput: string | undefined;
  public mergeBaseOutput = `${baseSha}\n`;
  public onRun: ((spec: ProcessLaunchSpec, context: ManagedProcessRunContext) => void) | undefined;
  public waitForRun: Promise<void> | undefined;
  public fileSystem: FakeWorkspaceFileSystem | undefined;

  public async run(
    spec: ProcessLaunchSpec,
    context: ManagedProcessRunContext,
  ): Promise<ManagedProcessRunResult> {
    this.calls.push({ spec, context });
    this.onRun?.(spec, context);
    await this.waitForRun;
    if (context.signal.aborted) {
      throw new ManagedProcessRunError("ABORTED", "aborted", { cause: context.signal.reason });
    }
    if (this.failAtCall === this.calls.length) {
      throw new ManagedProcessRunError(this.failureCode, "injected Git failure", {
        exitCode: this.failureCode === "NON_ZERO_EXIT" ? 1 : 0,
      });
    }

    const command = commandName(spec.arguments);
    if (command === "init") {
      const repositoryDirectory = spec.arguments.at(-1);
      if (repositoryDirectory === undefined) {
        throw new Error("The fake Git init command is missing its repository directory.");
      }
      this.fileSystem?.addDirectory(repositoryDirectory);
    }
    let stdout = "";
    if (command === "cat-file") stdout = "commit\n";
    if (command === "merge-base") stdout = this.mergeBaseOutput;
    if (command === "worktree" && spec.arguments.includes("list")) {
      const repository = spec.arguments
        .find((argument) => argument.startsWith("--git-dir="))
        ?.slice("--git-dir=".length);
      stdout = this.worktreeListOutput ?? `worktree ${repository}\0bare\0\0`;
    }
    if (command === "rev-parse") {
      stdout = spec.arguments.includes("HEAD^{commit}")
        ? this.worktreeHeadOutput
        : spec.arguments.includes("refs/agentic-review/latest-base^{commit}")
          ? this.pullRequestBaseOutput
          : this.pullRequestHeadOutput;
    }
    return { exitCode: 0, stdout, stderr: "" };
  }
}

class FakeWorkspaceDiskBudget implements WorkspaceDiskBudget {
  public readonly admitted: string[] = [];
  public readonly released: string[] = [];
  public readonly monitored: string[] = [];
  public readonly checkoutRemovals: string[] = [];
  public removalError: unknown;
  public checkoutRemovalError: unknown;
  public onMonitorCheck: (() => void) | undefined;

  public constructor(private readonly fileSystem: FakeWorkspaceFileSystem) {}

  public async admit(
    attemptDirectory: string,
    _signal?: AbortSignal,
  ): Promise<WorkspaceDiskReservation> {
    if (this.fileSystem.has(attemptDirectory)) {
      throw new Error("Disk admission must happen before attempt creation.");
    }
    this.admitted.push(attemptDirectory);
    let released = false;
    return {
      attemptDirectory,
      startMonitoring: async (parentSignal): Promise<WorkspaceDiskMonitor> => {
        this.monitored.push(attemptDirectory);
        this.onMonitorCheck?.();
        return {
          signal: parentSignal,
          violation: undefined,
          close: async () => this.onMonitorCheck?.(),
        };
      },
      removeAttempt: async () => {
        if (this.removalError !== undefined) throw this.removalError;
        const state = await this.fileSystem.lstat(attemptDirectory);
        const realPath = await this.fileSystem.realpath(attemptDirectory);
        if (
          state === null ||
          state.kind !== "directory" ||
          state.reparsePoint ||
          key(realPath) !== key(attemptDirectory)
        ) {
          throw new WorkspaceDiskBudgetError(
            "WORKSPACE_PATH_UNSAFE",
            "Fake native adapter rejected an unsafe attempt.",
          );
        }
        await this.fileSystem.removeTree(attemptDirectory);
      },
      removeCheckout: async () => {
        if (released) throw new WorkspaceDiskBudgetError("RESERVATION_RELEASED", "released");
        if (this.checkoutRemovalError !== undefined) throw this.checkoutRemovalError;
        const checkout = win32.join(attemptDirectory, "checkout");
        const state = await this.fileSystem.lstat(checkout);
        if (state === null) return;
        if (
          state.kind !== "directory" ||
          state.reparsePoint ||
          key(await this.fileSystem.realpath(checkout)) !== key(checkout)
        ) {
          throw new WorkspaceDiskBudgetError("WORKSPACE_PATH_UNSAFE", "Unsafe checkout.");
        }
        this.checkoutRemovals.push(checkout);
        await this.fileSystem.removeTree(checkout);
      },
      abandon: () => {
        released = true;
        this.released.push(attemptDirectory);
      },
      release: async () => {
        if (released) return;
        released = true;
        this.released.push(attemptDirectory);
      },
    };
  }
}

const unusedProcessHost: ProcessHostClient = {
  start: async () => {
    throw new Error("Injected workspace tests do not start ProcessHost directly.");
  },
  terminateAll: async () => undefined,
  close: async () => undefined,
};

function key(path: string): string {
  return win32.normalize(path).toLowerCase();
}

function fileSystemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function commandName(argumentsList: readonly string[]): string | undefined {
  const commands = new Set([
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
  return argumentsList.find((argument) => commands.has(argument));
}

function validGitEnvironment(): Record<string, string> {
  return {
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATH: "C:\\Windows\\System32;C:\\Windows",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
}

function envelope(
  kind: "issue" | "pull_request",
  options: {
    readonly runAttemptId?: string;
    readonly repository?: string;
    readonly repositoryId?: number;
    readonly baseSha?: string;
    readonly headSha?: string;
  } = {},
): JobExecutionEnvelope {
  const commonResource = {
    githubNodeId: "WI_node",
    number: 42,
    title: "Untrusted title --upload-pack=evil",
    author: { githubUserId: 7, login: "contributor", accountType: "user" as const },
    canonicalSnapshot: { body: "PROMPT-MUST-NOT-BECOME-ARGV" },
  };
  const resource =
    kind === "issue"
      ? {
          ...commonResource,
          kind: "issue" as const,
          revisionDigest: "1".repeat(64),
        }
      : {
          ...commonResource,
          kind: "pull_request" as const,
          baseSha: options.baseSha ?? baseSha,
          headSha: options.headSha ?? headSha,
          isDraft: false,
        };
  return {
    protocolVersion: "1.0",
    envelopeVersion: 1,
    assignedAt: "2026-08-31T00:00:00.000Z",
    leaseExpiresAt: "2026-08-31T00:02:00.000Z",
    executionDeadlineAt: "2026-08-31T00:20:00.000Z",
    lease: {
      jobId: "job-42",
      runAttemptId: options.runAttemptId ?? "run-42",
      workerNodeId: "worker-1",
      workerInstanceId: "instance-1",
      leaseToken: "lease-token-".padEnd(40, "x"),
      leaseGeneration: 1,
    },
    job: {
      jobId: "job-42",
      kind: kind === "issue" ? "issue_triage" : "pull_request_review",
      priority: 10,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "semantic-42",
    },
    repository: {
      githubRepositoryId: options.repositoryId ?? 1844564,
      fullName: options.repository ?? "microsoft/PowerToys",
    },
    resource,
    prompt: {
      name: kind === "issue" ? "issue-triage" : "pull-request-review",
      version: "1",
      renderedPrompt: "PROMPT-MUST-NOT-BECOME-ARGV",
      promptSha256: digest,
      outputSchema: { type: "object" },
      outputSchemaSha256: digest,
    },
    executionPolicy: {
      hardTimeoutMs: 1_200_000,
      noProgressTimeoutMs: 300_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}

function provider(
  fileSystem: FakeWorkspaceFileSystem,
  processRunner: FakeManagedProcessRunner,
  options: {
    readonly gitEnvironment?: Readonly<Record<string, string>>;
    readonly gitWorkingDirectory?: string;
    readonly diskBudget?: WorkspaceDiskBudget;
    readonly gitSharedCacheMaxBytes?: bigint;
    readonly gitSharedMinimumFreeBytes?: bigint;
    readonly gitSharedScanEntryLimit?: number;
    readonly gitSharedScanTimeoutMs?: number;
    readonly gitSharedGcMinimumIntervalMs?: number;
    readonly gitSharedGcPruneAgeHours?: number;
    readonly logger?: Logger;
  } = {},
): ProductionDisposableJobWorkspaceProvider {
  processRunner.fileSystem = fileSystem;
  return new ProductionDisposableJobWorkspaceProvider({
    workspaceRootDirectory: workspaceRoot,
    gitSharedRootDirectory,
    gitExecutable,
    gitWorkingDirectory: options.gitWorkingDirectory ?? gitWorkingDirectory,
    gitEnvironment: options.gitEnvironment ?? validGitEnvironment(),
    gitLimits: {
      hardTimeoutMs: 60_000,
      maximumProcessCount: 4,
      maximumMemoryBytes: 536_870_912,
      maximumOutputBytes: 1_048_576,
    },
    gitSharedCachePolicy: {
      maximumTotalBytes: options.gitSharedCacheMaxBytes ?? 64n * 1024n * 1024n * 1024n,
      minimumFreeBytes: options.gitSharedMinimumFreeBytes ?? 10n * 1024n * 1024n * 1024n,
      maximumScanEntries: options.gitSharedScanEntryLimit ?? 250_000,
      maximumScanDurationMs: options.gitSharedScanTimeoutMs ?? 30_000,
      gcMinimumIntervalMs: options.gitSharedGcMinimumIntervalMs ?? 60_000,
      gcPruneAgeHours: options.gitSharedGcPruneAgeHours ?? 168,
    },
    diskBudget: options.diskBudget ?? new FakeWorkspaceDiskBudget(fileSystem),
    fileSystem,
    processRunner,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

function preparationContext(
  controller = new AbortController(),
  reporter?: (error: JobWorkspaceError) => void,
): {
  readonly context: WorkspacePreparationContext;
  readonly processCounts: number[];
  readonly healthFaults: JobWorkspaceError[];
  readonly controller: AbortController;
} {
  const processCounts: number[] = [];
  const healthFaults: JobWorkspaceError[] = [];
  return {
    controller,
    processCounts,
    healthFaults,
    context: {
      signal: controller.signal,
      processHost: unusedProcessHost,
      reportProcessCount: (count) => processCounts.push(count),
      reportNodeHealthFault: (error) => {
        healthFaults.push(error);
        reporter?.(error);
      },
    },
  };
}

describe("ProductionDisposableJobWorkspaceProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an isolated non-repository workspace for issue triage", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
    const progress = preparationContext();

    const workspace = await provider(fileSystem, processRunner, { diskBudget }).prepare(
      envelope("issue"),
      progress.context,
    );

    expect(processRunner.calls).toEqual([]);
    expect(win32.dirname(workspace.checkoutDirectory)).toBe(workspace.attemptDirectory);
    expect(win32.dirname(workspace.controlDirectory)).toBe(workspace.attemptDirectory);
    expect(win32.dirname(workspace.codexHomeDirectory)).toBe(workspace.attemptDirectory);
    expect(win32.dirname(workspace.tempDirectory)).toBe(workspace.attemptDirectory);
    expect(win32.dirname(workspace.userProfileDirectory)).toBe(workspace.attemptDirectory);
    expect(
      new Set([
        workspace.checkoutDirectory,
        workspace.controlDirectory,
        workspace.codexHomeDirectory,
        workspace.tempDirectory,
        workspace.userProfileDirectory,
      ]).size,
    ).toBe(5);
    expect(progress.processCounts).toEqual([0]);
    expect(diskBudget.admitted).toEqual([workspace.attemptDirectory]);
    expect(diskBudget.monitored).toEqual([]);

    await workspace.cleanup();
    expect(fileSystem.removed).toEqual([workspace.attemptDirectory]);
    expect(fileSystem.has(workspaceRoot)).toBe(true);
    expect(diskBudget.released).toEqual([workspace.attemptDirectory]);
  });

  it("fetches and verifies an immutable pull request comparison without shell input", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
    const progress = preparationContext();

    const workspace = await provider(fileSystem, processRunner, { diskBudget }).prepare(
      envelope("pull_request"),
      progress.context,
    );

    expect(processRunner.calls.map((call) => commandName(call.spec.arguments))).toEqual([
      "init",
      "config",
      "worktree",
      "fetch",
      "rev-parse",
      "rev-parse",
      "cat-file",
      "cat-file",
      "merge-base",
      "worktree",
      "rev-parse",
      "cat-file",
    ]);
    const fetches = processRunner.calls.filter(
      (call) => commandName(call.spec.arguments) === "fetch",
    );
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.spec.arguments).toContain(`+${baseSha}:refs/agentic-review/latest-base`);
    expect(fetches[0]?.spec.arguments).toContain(
      "+refs/pull/42/head:refs/agentic-review/latest-head",
    );
    expect(
      fetches.some((call) =>
        call.spec.arguments.some((argument) => argument.includes("refs/heads/")),
      ),
    ).toBe(false);
    expect(
      fetches.some((call) =>
        call.spec.arguments.some((argument) =>
          /^--(?:depth|deepen|shallow|filter)(?:=|-|$)/u.test(argument),
        ),
      ),
    ).toBe(false);
    expect(
      processRunner.calls.some((call) =>
        call.spec.arguments.includes("refs/agentic-review/latest-base^{commit}"),
      ),
    ).toBe(true);
    const mergeBaseCall = processRunner.calls.find(
      (call) => commandName(call.spec.arguments) === "merge-base",
    );
    expect(mergeBaseCall?.spec.arguments.slice(-4)).toEqual([
      "merge-base",
      "--all",
      baseSha,
      headSha,
    ]);
    const worktreeCall = processRunner.calls.find(
      (call) =>
        commandName(call.spec.arguments) === "worktree" && call.spec.arguments.includes("add"),
    );
    expect(worktreeCall?.spec.arguments.slice(-6)).toEqual([
      "worktree",
      "add",
      "--detach",
      "--force",
      workspace.checkoutDirectory,
      headSha,
    ]);
    expect(fetches.every((call) => call.spec.arguments.includes("--quiet"))).toBe(true);
    expect(fetches.every((call) => call.spec.arguments.includes("--no-auto-maintenance"))).toBe(
      true,
    );
    expect(
      processRunner.calls.some((call) => call.spec.arguments.includes("--no-recurse-submodules")),
    ).toBe(true);
    expect(
      processRunner.calls.some((call) => call.spec.arguments.includes("core.hooksPath=NUL")),
    ).toBe(true);
    for (const call of processRunner.calls) {
      expect(call.spec.executable).toBe(gitExecutable);
      expect(call.spec.arguments).toContain("core.longpaths=true");
      expect(call.spec.workingDirectory).toBe(gitWorkingDirectory);
      const changeDirectoryIndex = call.spec.arguments.indexOf("-C");
      if (changeDirectoryIndex !== -1) {
        expect(call.spec.arguments[changeDirectoryIndex + 1]).toBe(workspace.checkoutDirectory);
      }
      expect(call.spec.environmentMode).toBe("replace");
      expect(call.spec.environment).toMatchObject({
        SYSTEMROOT: "C:\\Windows",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32;C:\\Windows",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        TEMP: workspace.tempDirectory,
        TMP: workspace.tempDirectory,
        USERPROFILE: workspace.userProfileDirectory,
      });
      expect(JSON.stringify(call.spec.arguments)).not.toContain("PROMPT-MUST-NOT-BECOME-ARGV");
      expect(call.spec.arguments).not.toContain("cmd.exe");
      expect(call.spec.arguments).not.toContain("powershell.exe");
    }
    expect(progress.processCounts).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
    ]);
    expect(diskBudget.monitored).toHaveLength(processRunner.calls.length);

    await workspace.cleanup();
  });

  it("serializes shared-repository mutation for two attempts of the same repository", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    let releaseFirstCommand!: () => void;
    processRunner.waitForRun = new Promise<void>((resolve) => {
      releaseFirstCommand = resolve;
    });
    const workspaceProvider = provider(fileSystem, processRunner);

    const firstPreparation = workspaceProvider.prepare(
      envelope("pull_request", { runAttemptId: "run-1" }),
      preparationContext().context,
    );
    await vi.waitFor(() => expect(processRunner.calls).toHaveLength(1));
    const secondPreparation = workspaceProvider.prepare(
      envelope("pull_request", { runAttemptId: "run-2" }),
      preparationContext().context,
    );
    await Promise.resolve();
    expect(processRunner.calls).toHaveLength(1);

    releaseFirstCommand();
    const [first, second] = await Promise.all([firstPreparation, secondPreparation]);
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it("serializes shared-cache mutation for different repositories", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    let releaseCommands!: () => void;
    processRunner.waitForRun = new Promise<void>((resolve) => {
      releaseCommands = resolve;
    });
    const workspaceProvider = provider(fileSystem, processRunner);

    const firstPreparation = workspaceProvider.prepare(
      envelope("pull_request", { runAttemptId: "run-1" }),
      preparationContext().context,
    );
    const secondPreparation = workspaceProvider.prepare(
      envelope("pull_request", {
        runAttemptId: "run-2",
        repository: "microsoft/terminal",
        repositoryId: 2,
      }),
      preparationContext().context,
    );
    await vi.waitFor(() => expect(processRunner.calls).toHaveLength(1));
    expect(commandName(processRunner.calls[0]?.spec.arguments ?? [])).toBe("init");

    releaseCommands();
    const [first, second] = await Promise.all([firstPreparation, secondPreparation]);
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it("cancels an attempt while it waits for the repository lock", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    let releaseFirstCommand!: () => void;
    processRunner.waitForRun = new Promise<void>((resolve) => {
      releaseFirstCommand = resolve;
    });
    const workspaceProvider = provider(fileSystem, processRunner);
    const firstPreparation = workspaceProvider.prepare(
      envelope("pull_request", { runAttemptId: "run-1" }),
      preparationContext().context,
    );
    await vi.waitFor(() => expect(processRunner.calls).toHaveLength(1));

    const waiting = preparationContext();
    const secondPreparation = workspaceProvider.prepare(
      envelope("pull_request", { runAttemptId: "run-2" }),
      waiting.context,
    );
    await Promise.resolve();
    waiting.controller.abort(new Error("lease lost"));
    await expect(secondPreparation).rejects.toMatchObject({ code: "ABORTED" });
    expect(processRunner.calls).toHaveLength(1);

    releaseFirstCommand();
    const first = await firstPreparation;
    await first.cleanup();
  });

  it("fails closed when shared cache exceeds limits while a same-repo worktree is active", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const workspaceProvider = provider(fileSystem, processRunner, {
      gitSharedCacheMaxBytes: 1_024n,
      gitSharedMinimumFreeBytes: 0n,
      gitSharedGcMinimumIntervalMs: 0,
    });

    const first = await workspaceProvider.prepare(
      envelope("pull_request", { runAttemptId: "run-1" }),
      preparationContext().context,
    );
    const repositoryDirectory = `${gitSharedRootDirectory}\\repository-1844564.git`;
    const objectsDirectory = `${repositoryDirectory}\\objects`;
    const packDirectory = `${objectsDirectory}\\pack`;
    fileSystem.addDirectory(objectsDirectory);
    fileSystem.addDirectory(packDirectory);
    fileSystem.addFile(`${packDirectory}\\oversized.pack`, 4_096n);

    const progress = preparationContext();
    await expect(
      workspaceProvider.prepare(
        envelope("pull_request", { runAttemptId: "run-2" }),
        progress.context,
      ),
    ).rejects.toMatchObject({ code: "GIT_SHARED_CACHE_LIMIT_EXCEEDED" });
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "GIT_SHARED_CACHE_LIMIT_EXCEEDED" });
    expect(processRunner.calls.some((call) => commandName(call.spec.arguments) === "gc")).toBe(
      false,
    );

    fileSystem.removePath(`${packDirectory}\\oversized.pack`);
    await first.cleanup();
  });

  it("runs bounded same-repo gc and proceeds when cache returns within limits", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const repositoryDirectory = `${gitSharedRootDirectory}\\repository-1844564.git`;
    const objectsDirectory = `${repositoryDirectory}\\objects`;
    const packDirectory = `${objectsDirectory}\\pack`;
    const oversizedPack = `${packDirectory}\\stale.pack`;
    processRunner.onRun = (spec) => {
      const command = commandName(spec.arguments);
      if (command === "worktree" && spec.arguments.includes("prune")) {
        fileSystem.addDirectory(objectsDirectory);
        fileSystem.addDirectory(packDirectory);
        fileSystem.addFile(oversizedPack, 8_192n);
      }
      if (command === "gc") {
        fileSystem.removePath(oversizedPack);
      }
    };

    const workspace = await provider(fileSystem, processRunner, {
      gitSharedCacheMaxBytes: 1_024n,
      gitSharedMinimumFreeBytes: 0n,
      gitSharedGcMinimumIntervalMs: 0,
      gitSharedGcPruneAgeHours: 336,
    }).prepare(envelope("pull_request"), preparationContext().context);

    const gcCall = processRunner.calls.find((call) => commandName(call.spec.arguments) === "gc");
    const reflogCall = processRunner.calls.find(
      (call) => commandName(call.spec.arguments) === "reflog",
    );
    const pruneCallIndices = processRunner.calls
      .map((call, index) => ({ call, index }))
      .filter(
        ({ call }) =>
          commandName(call.spec.arguments) === "worktree" && call.spec.arguments.includes("prune"),
      )
      .map(({ index }) => index);
    const gcIndex = processRunner.calls.findIndex(
      (call) => commandName(call.spec.arguments) === "gc",
    );

    expect(gcCall).toBeDefined();
    expect(reflogCall).toBeDefined();
    expect(reflogCall?.spec.arguments).toContain("expire");
    expect(reflogCall?.spec.arguments).toContain("--all");
    expect(reflogCall?.spec.arguments).toContain("--expire=336.hours.ago");
    expect(reflogCall?.spec.arguments).toContain("--expire-unreachable=336.hours.ago");
    expect(gcCall?.spec.arguments).toContain("--prune=336.hours.ago");
    expect(pruneCallIndices.length).toBeGreaterThanOrEqual(2);
    expect(gcIndex).toBeGreaterThan(0);
    expect(pruneCallIndices[pruneCallIndices.length - 1]).toBeLessThan(gcIndex);

    await workspace.cleanup();
  });

  it("skips same-repo gc when bare-repo worktree metadata is still non-empty", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const repositoryDirectory = `${gitSharedRootDirectory}\\repository-1844564.git`;
    const objectsDirectory = `${repositoryDirectory}\\objects`;
    const packDirectory = `${objectsDirectory}\\pack`;
    const metadataDirectory = `${repositoryDirectory}\\worktrees`;
    const metadataEntry = `${metadataDirectory}\\active-checkout`;
    fileSystem.addDirectory(repositoryDirectory);
    fileSystem.addDirectory(objectsDirectory);
    fileSystem.addDirectory(packDirectory);
    fileSystem.addFile(`${packDirectory}\\oversized.pack`, 16_384n);
    fileSystem.addDirectory(metadataDirectory);
    fileSystem.addDirectory(metadataEntry);
    const progress = preparationContext();

    await expect(
      provider(fileSystem, processRunner, {
        gitSharedCacheMaxBytes: 1_024n,
        gitSharedMinimumFreeBytes: 0n,
        gitSharedGcMinimumIntervalMs: 0,
      }).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "GIT_SHARED_CACHE_LIMIT_EXCEEDED" });
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "GIT_SHARED_CACHE_LIMIT_EXCEEDED" });
    expect(processRunner.calls.some((call) => commandName(call.spec.arguments) === "gc")).toBe(
      false,
    );
  });

  it("falls back to prune and still runs post-cleanup gc when checkout was removed", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
    const progress = preparationContext();
    const repositoryDirectory = `${gitSharedRootDirectory}\\repository-1844564.git`;
    const objectsDirectory = `${repositoryDirectory}\\objects`;
    const packDirectory = `${objectsDirectory}\\pack`;
    const oversizedPack = `${packDirectory}\\cleanup-oversized.pack`;
    processRunner.onRun = (spec) => {
      const command = commandName(spec.arguments);
      if (
        command === "worktree" &&
        spec.arguments.includes("remove") &&
        !fileSystem.has(spec.arguments[spec.arguments.length - 1] ?? "")
      ) {
        throw new ManagedProcessRunError("NON_ZERO_EXIT", "missing checkout during cleanup", {
          exitCode: 1,
        });
      }
      if (command === "gc") {
        fileSystem.removePath(oversizedPack);
      }
    };

    const workspace = await provider(fileSystem, processRunner, {
      diskBudget,
      gitSharedCacheMaxBytes: 1_024n,
      gitSharedMinimumFreeBytes: 0n,
      gitSharedGcMinimumIntervalMs: 0,
    }).prepare(envelope("pull_request"), progress.context);

    fileSystem.addDirectory(objectsDirectory);
    fileSystem.addDirectory(packDirectory);
    fileSystem.addFile(oversizedPack, 8_192n);
    fileSystem.removePath(workspace.checkoutDirectory);
    diskBudget.onMonitorCheck = () => {
      throw new WorkspaceDiskBudgetError(
        "SNAPSHOT_UNSTABLE",
        "The retained package-store link points to the removed checkout.",
      );
    };

    const callsBeforeCleanup = processRunner.calls.length;
    const monitorsBeforeCleanup = diskBudget.monitored.length;
    progress.controller.abort(new Error("cancelled by server"));
    await workspace.cleanup();
    const cleanupCalls = processRunner.calls.slice(callsBeforeCleanup);
    expect(
      cleanupCalls.some(
        (call) =>
          commandName(call.spec.arguments) === "worktree" && call.spec.arguments.includes("remove"),
      ),
    ).toBe(true);
    expect(
      cleanupCalls.some(
        (call) =>
          commandName(call.spec.arguments) === "worktree" && call.spec.arguments.includes("prune"),
      ),
    ).toBe(true);
    expect(cleanupCalls.some((call) => commandName(call.spec.arguments) === "gc")).toBe(true);
    expect(diskBudget.monitored).toHaveLength(monitorsBeforeCleanup);
    expect(cleanupCalls.every((call) => !call.context.signal.aborted)).toBe(true);
    expect(fileSystem.has(workspace.attemptDirectory)).toBe(false);
    expect(diskBudget.released).toEqual([workspace.attemptDirectory]);
    expect(progress.healthFaults).toEqual([]);
  });

  it("recovers a nonzero Git removal through the reservation and confirms only this registration is absent", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
    const warn = vi.fn();
    const progress = preparationContext();
    const workspaceProvider = provider(fileSystem, processRunner, {
      diskBudget,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    const first = await workspaceProvider.prepare(envelope("pull_request"), progress.context);
    const second = await workspaceProvider.prepare(
      envelope("pull_request", { runAttemptId: "other-active-attempt" }),
      preparationContext().context,
    );
    const repository = `${gitSharedRootDirectory}\\repository-1844564.git`;
    processRunner.worktreeListOutput =
      `worktree ${repository}\0bare\0\0` +
      `worktree ${second.checkoutDirectory}\0HEAD ${headSha}\0detached\0\0`;
    processRunner.onRun = (spec) => {
      if (spec.arguments.includes("remove") && spec.arguments.at(-1) === first.checkoutDirectory) {
        throw new ManagedProcessRunError("NON_ZERO_EXIT", "Managed process exited with code 255.", {
          exitCode: 255,
          stderr: "error: failed to delete checkout: Result too large",
        });
      }
    };
    const callsBeforeCleanup = processRunner.calls.length;

    await expect(first.cleanup()).resolves.toBeUndefined();

    expect(diskBudget.checkoutRemovals).toEqual([first.checkoutDirectory]);
    expect(diskBudget.released).toEqual([first.attemptDirectory]);
    expect(fileSystem.has(first.attemptDirectory)).toBe(false);
    expect(fileSystem.has(second.checkoutDirectory)).toBe(true);
    expect(
      processRunner.calls
        .slice(callsBeforeCleanup)
        .map((call) =>
          call.spec.arguments.filter((arg) => ["remove", "prune", "list"].includes(arg)),
        ),
    ).toEqual([["remove"], ["prune"], ["list"]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Git worktree removal recovered through reserved checkout cleanup.",
      { exitCode: 255, stderrSummary: "error: failed to delete checkout: Result too large" },
    );
    expect(progress.healthFaults).toEqual([]);
    await second.cleanup();
  });

  it.each([
    "checkout_removal",
    "prune",
    "list",
    "retained_registration",
    "missing_bare",
    "embedded_worktree",
  ] as const)(
    "fails cleanup closed when Git removal recovery cannot verify %s",
    async (failureStage) => {
      const fileSystem = new FakeWorkspaceFileSystem();
      const processRunner = new FakeManagedProcessRunner();
      const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
      const progress = preparationContext();
      const workspace = await provider(fileSystem, processRunner, { diskBudget }).prepare(
        envelope("pull_request"),
        progress.context,
      );
      const repository = `${gitSharedRootDirectory}\\repository-1844564.git`;
      if (failureStage === "checkout_removal") {
        diskBudget.checkoutRemovalError = new WorkspaceDiskBudgetError(
          "HANDLE_BOUND_DELETE_FAILED",
          "Checkout deletion failed.",
        );
      } else if (failureStage === "retained_registration") {
        processRunner.worktreeListOutput = `worktree ${repository}\0bare\0\0worktree ${workspace.checkoutDirectory}\0HEAD ${headSha}\0detached\0\0`;
      } else if (failureStage === "missing_bare") {
        processRunner.worktreeListOutput = `worktree ${repository}\0\0`;
      } else if (failureStage === "embedded_worktree") {
        processRunner.worktreeListOutput = `worktree ${repository}\0bare\0worktree ${workspace.checkoutDirectory}\0\0`;
      }
      processRunner.onRun = (spec) => {
        if (spec.arguments.includes("remove") || spec.arguments.includes(failureStage)) {
          throw new ManagedProcessRunError("NON_ZERO_EXIT", "Managed Git failed.", {
            exitCode: 255,
            stderr: "Result too large",
          });
        }
      };

      await expect(workspace.cleanup()).rejects.toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
      expect(progress.healthFaults).toHaveLength(1);
      expect(fileSystem.has(workspace.attemptDirectory)).toBe(false);
    },
  );

  it.each(["PROCESS_FAILED", "PROCESS_TERMINATED", "OUTPUT_TRUNCATED", "ABORTED"] as const)(
    "does not attempt reserved checkout recovery for %s",
    async (failureCode) => {
      const fileSystem = new FakeWorkspaceFileSystem();
      const processRunner = new FakeManagedProcessRunner();
      const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
      const progress = preparationContext();
      const workspace = await provider(fileSystem, processRunner, { diskBudget }).prepare(
        envelope("pull_request"),
        progress.context,
      );
      processRunner.onRun = (spec) => {
        if (spec.arguments.includes("remove"))
          throw new ManagedProcessRunError(failureCode, "Injected managed process failure.");
      };

      await expect(workspace.cleanup()).rejects.toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
      expect(diskBudget.checkoutRemovals).toEqual([]);
      expect(progress.healthFaults).toHaveLength(1);
    },
  );

  it("logs bounded redacted stderr for a failed fixed Git cleanup command", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
    diskBudget.checkoutRemovalError = new WorkspaceDiskBudgetError(
      "HANDLE_BOUND_DELETE_FAILED",
      "Injected reserved checkout removal failure.",
    );
    const progress = preparationContext();
    const workspace = await provider(fileSystem, processRunner, { diskBudget }).prepare(
      envelope("pull_request"),
      progress.context,
    );
    const secret = "SYNTHETIC_GIT_CREDENTIAL_MUST_NOT_BE_LOGGED";
    const stdout = "SYNTHETIC_STDOUT_MUST_NOT_BE_LOGGED";
    const stderr = [
      "\u001b[31merror: failed to delete 'checkout/node_modules/package': Permission denied\u001b[0m",
      `Authorization: Bearer ${secret}`,
      `Cookie: session=${secret}`,
      `fatal: https://reviewer:${secret}@github.com/example/repository?token=${secret}&safe=ok`,
      `password="${secret}"; api_key=${secret}`,
      `\u202e${"remaining diagnostic text ".repeat(300)}`,
    ].join("\r\n");
    processRunner.onRun = (spec) => {
      if (commandName(spec.arguments) === "worktree" && spec.arguments.includes("remove")) {
        throw new ManagedProcessRunError("NON_ZERO_EXIT", "Managed process exited with code 255.", {
          exitCode: 255,
          stdout,
          stderr,
        });
      }
    };

    const failure: unknown = await workspace.cleanup().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobWorkspaceError);
    if (!(failure instanceof JobWorkspaceError) || !(failure.cause instanceof JobWorkspaceError)) {
      throw new Error("The cleanup failure did not retain its Git-specific cause.");
    }
    expect(failure.code).toBe("WORKSPACE_CLEANUP_FAILED");
    expect(failure.cause.code).toBe("WORKSPACE_CLEANUP_FAILED");
    expect(failure.cause.message).toContain("Git worktree remove exited with code 255; stderr:");
    expect(failure.cause.message).toContain("Permission denied");
    expect(failure.cause.message).toContain("[REDACTED]");
    expect(failure.cause.message).toContain("...[truncated]");
    expect(failure.cause.message.length).toBeLessThan(2_300);
    for (const control of ["\u001b", "\r", "\n", "\u202e"]) {
      expect(failure.cause.message).not.toContain(control);
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      new ConsoleJsonLogger("error").error("Cleanup diagnostic fixture.", { error: failure });
      const serialized = String(log.mock.calls[0]?.[0]);
      expect(serialized).toContain("Permission denied");
      expect(serialized).toContain("Git worktree remove exited with code 255");
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(stdout);
    } finally {
      log.mockRestore();
    }
    expect(progress.healthFaults).toHaveLength(1);
    expect(fileSystem.has(workspace.attemptDirectory)).toBe(false);
  });

  it("does not add process output to non-cleanup Git failure messages", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const output = "SYNTHETIC_OUTPUT_MUST_NOT_BE_LOGGED";
    processRunner.onRun = (spec) => {
      if (commandName(spec.arguments) === "fetch") {
        throw new ManagedProcessRunError("NON_ZERO_EXIT", "Managed process exited with code 1.", {
          exitCode: 1,
          stdout: output,
          stderr: output,
        });
      }
    };
    const failure: unknown = await provider(fileSystem, processRunner)
      .prepare(envelope("pull_request"), preparationContext().context)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JobWorkspaceError);
    if (!(failure instanceof JobWorkspaceError)) throw new Error("Expected a Git failure.");
    expect(failure.code).toBe("GIT_COMMAND_FAILED");
    expect(failure.message).not.toContain(output);
    expect(failure.message).not.toContain("stderr:");
  });

  it("attempts post-cleanup gc for low free space without blocking attempt removal", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const workspace = await provider(fileSystem, processRunner, {
      gitSharedMinimumFreeBytes: 1n,
      gitSharedGcMinimumIntervalMs: 0,
    }).prepare(envelope("pull_request"), preparationContext().context);

    fileSystem.availableBytesValue = 0n;
    const callsBeforeCleanup = processRunner.calls.length;

    await expect(workspace.cleanup()).resolves.toBeUndefined();
    const cleanupCalls = processRunner.calls.slice(callsBeforeCleanup);
    expect(cleanupCalls.some((call) => commandName(call.spec.arguments) === "gc")).toBe(true);
    expect(fileSystem.removed).toContain(workspace.attemptDirectory);
  });

  it("best-effort removes attempt when cleanup maintenance fails", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const progress = preparationContext();
    const repositoryDirectory = `${gitSharedRootDirectory}\\repository-1844564.git`;
    const objectsDirectory = `${repositoryDirectory}\\objects`;
    const packDirectory = `${objectsDirectory}\\pack`;
    const oversizedPack = `${packDirectory}\\cleanup-failure.pack`;
    processRunner.onRun = (spec) => {
      if (commandName(spec.arguments) === "gc") {
        throw new ManagedProcessRunError("NON_ZERO_EXIT", "injected cleanup gc failure", {
          exitCode: 1,
        });
      }
    };

    const workspace = await provider(fileSystem, processRunner, {
      gitSharedCacheMaxBytes: 1_024n,
      gitSharedMinimumFreeBytes: 0n,
      gitSharedGcMinimumIntervalMs: 0,
    }).prepare(envelope("pull_request"), progress.context);

    fileSystem.addDirectory(objectsDirectory);
    fileSystem.addDirectory(packDirectory);
    fileSystem.addFile(oversizedPack, 8_192n);

    await expect(workspace.cleanup()).rejects.toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
    expect(fileSystem.removed).toContain(workspace.attemptDirectory);
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
  });

  it("surfaces a classifiable shared-cache limit error and reports node drain intent", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const repositoryDirectory = `${gitSharedRootDirectory}\\repository-1844564.git`;
    const objectsDirectory = `${repositoryDirectory}\\objects`;
    const packDirectory = `${objectsDirectory}\\pack`;
    fileSystem.addDirectory(repositoryDirectory);
    fileSystem.addDirectory(objectsDirectory);
    fileSystem.addDirectory(packDirectory);
    fileSystem.addFile(`${packDirectory}\\oversized.pack`, 16_384n);
    const progress = preparationContext();

    await expect(
      provider(fileSystem, processRunner, {
        gitSharedCacheMaxBytes: 1_024n,
        gitSharedMinimumFreeBytes: 0n,
        gitSharedGcMinimumIntervalMs: 0,
      }).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "GIT_SHARED_CACHE_LIMIT_EXCEEDED" });
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "GIT_SHARED_CACHE_LIMIT_EXCEEDED" });
  });

  it("fails closed when shared-cache scan sees reparse points outside the target repository", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const untrustedRepositoryDirectory = `${gitSharedRootDirectory}\\repository-999.git`;
    fileSystem.addDirectory(untrustedRepositoryDirectory);
    fileSystem.setReparsePoint(untrustedRepositoryDirectory, true);

    await expect(
      provider(fileSystem, processRunner).prepare(
        envelope("pull_request", { runAttemptId: "reparse-scan" }),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
  });

  it("fails closed when shared-cache scan exceeds its entry boundary", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    fileSystem.addDirectory(`${gitSharedRootDirectory}\\repository-2.git`);

    await expect(
      provider(fileSystem, processRunner, {
        gitSharedScanEntryLimit: 1,
      }).prepare(
        envelope("pull_request", { runAttemptId: "entry-boundary" }),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "GIT_INFRASTRUCTURE_FAILED" });
  });

  it("rejects revision mismatches and removes only the failed attempt", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    processRunner.pullRequestHeadOutput = `${"c".repeat(40)}\n`;

    await expect(
      provider(fileSystem, processRunner).prepare(
        envelope("pull_request"),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "GIT_REVISION_MISMATCH" });
    expect(fileSystem.removed).toHaveLength(1);
    expect(fileSystem.removed[0]).toMatch(/\\attempt-[a-f0-9]{64}$/u);
    expect(fileSystem.has(workspaceRoot)).toBe(true);
  });

  it("rejects a fetched base that differs from the immutable comparison base", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const progress = preparationContext();
    processRunner.pullRequestBaseOutput = `${"c".repeat(40)}\n`;

    await expect(
      provider(fileSystem, processRunner).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "GIT_REVISION_MISMATCH" });
    expect(
      processRunner.calls.some(
        (call) =>
          commandName(call.spec.arguments) === "worktree" && call.spec.arguments.includes("add"),
      ),
    ).toBe(false);
    expect(fileSystem.removed).toHaveLength(1);
    expect(progress.healthFaults).toEqual([]);
  });

  it.each([
    "--upload-pack=evil",
    "main",
    "dev",
    "release/2026.09",
    `+${baseSha}:refs/heads/injected`,
    `${baseSha}:refs/heads/injected`,
    `${baseSha}^`,
    `${baseSha}\n`,
    "a".repeat(39),
    "a".repeat(41),
    "A".repeat(40),
  ])("rejects a non-canonical immutable revision %j before invoking Git", async (revision) => {
    for (const target of ["baseSha", "headSha"] as const) {
      const fileSystem = new FakeWorkspaceFileSystem();
      const processRunner = new FakeManagedProcessRunner();
      const progress = preparationContext();

      await expect(
        provider(fileSystem, processRunner).prepare(
          envelope("pull_request", { [target]: revision }),
          progress.context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
      expect(processRunner.calls).toHaveLength(0);
      expect(fileSystem.removed).toHaveLength(1);
      expect(progress.healthFaults).toEqual([]);
    }
  });

  it("rejects a prepared worktree whose HEAD differs from the admitted revision", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    processRunner.worktreeHeadOutput = `${"c".repeat(40)}\n`;

    await expect(
      provider(fileSystem, processRunner).prepare(
        envelope("pull_request"),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "GIT_REVISION_MISMATCH" });
    expect(
      processRunner.calls.some(
        (call) =>
          commandName(call.spec.arguments) === "worktree" && call.spec.arguments.includes("remove"),
      ),
    ).toBe(true);
    expect(fileSystem.removed).toHaveLength(1);
  });

  it("best-effort removes attempt when preparation cleanup maintenance fails", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const progress = preparationContext();
    const repositoryDirectory = `${gitSharedRootDirectory}\\repository-1844564.git`;
    const objectsDirectory = `${repositoryDirectory}\\objects`;
    const packDirectory = `${objectsDirectory}\\pack`;
    const oversizedPack = `${packDirectory}\\prepare-failure.pack`;
    processRunner.worktreeHeadOutput = `${"c".repeat(40)}\n`;
    processRunner.onRun = (spec) => {
      const command = commandName(spec.arguments);
      if (command === "worktree" && spec.arguments.includes("add")) {
        fileSystem.addDirectory(objectsDirectory);
        fileSystem.addDirectory(packDirectory);
        fileSystem.addFile(oversizedPack, 8_192n);
      }
      if (command === "gc") {
        throw new ManagedProcessRunError("NON_ZERO_EXIT", "injected prepare cleanup gc failure", {
          exitCode: 1,
        });
      }
    };

    await expect(
      provider(fileSystem, processRunner, {
        gitSharedCacheMaxBytes: 1_024n,
        gitSharedMinimumFreeBytes: 0n,
        gitSharedGcMinimumIntervalMs: 0,
      }).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
    expect(fileSystem.removed).toHaveLength(1);
    expect(fileSystem.removed[0]).toMatch(/\\attempt-[a-f0-9]{64}$/u);
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
  });

  it("rejects an existing shared repository that is a reparse point", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const repositoryDirectory = `${gitSharedRootDirectory}\\repository-1844564.git`;
    fileSystem.addDirectory(repositoryDirectory);
    fileSystem.setReparsePoint(repositoryDirectory, true);

    await expect(
      provider(fileSystem, processRunner).prepare(
        envelope("pull_request"),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
    expect(processRunner.calls).toHaveLength(0);
    expect(fileSystem.removed).toHaveLength(1);
  });

  it("rejects a pull request without a shared merge base", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    processRunner.mergeBaseOutput = "";

    await expect(
      provider(fileSystem, processRunner).prepare(
        envelope("pull_request"),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "GIT_LOCAL_OR_REVISION_FAILED" });
    expect(fileSystem.removed).toHaveLength(1);
  });

  it.each([
    ["NON_ZERO_EXIT", "GIT_COMMAND_FAILED"],
    ["OUTPUT_TRUNCATED", "GIT_POLICY_LIMIT_EXCEEDED"],
  ] as const)(
    "classifies %s as %s and cleans the partial workspace",
    async (failureCode, expectedCode) => {
      const fileSystem = new FakeWorkspaceFileSystem();
      const processRunner = new FakeManagedProcessRunner();
      processRunner.failAtCall = 4;
      processRunner.failureCode = failureCode;

      await expect(
        provider(fileSystem, processRunner).prepare(
          envelope("pull_request"),
          preparationContext().context,
        ),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(fileSystem.removed).toHaveLength(1);
    },
  );

  it("treats a post-fetch local Git failure as deterministic without draining the node", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const progress = preparationContext();
    processRunner.failAtCall = 7;
    processRunner.failureCode = "NON_ZERO_EXIT";

    await expect(
      provider(fileSystem, processRunner).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "GIT_LOCAL_OR_REVISION_FAILED" });
    expect(progress.healthFaults).toEqual([]);
  });

  it("treats shared repository initialization failure as node infrastructure", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const progress = preparationContext();
    processRunner.failAtCall = 1;
    processRunner.failureCode = "NON_ZERO_EXIT";

    await expect(
      provider(fileSystem, processRunner).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "GIT_INFRASTRUCTURE_FAILED" });
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "GIT_INFRASTRUCTURE_FAILED" });
  });

  it("reports a managed Git infrastructure failure exactly once before retrying elsewhere", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const progress = preparationContext();
    processRunner.failAtCall = 2;
    processRunner.failureCode = "PROCESS_START_FAILED";

    await expect(
      provider(fileSystem, processRunner).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "GIT_INFRASTRUCTURE_FAILED" });
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "GIT_INFRASTRUCTURE_FAILED" });
  });

  it.each([
    ["ACCOUNTING_LIMIT_EXCEEDED", "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE", 1],
    ["CURRENT_ATTEMPT_LIMIT_EXCEEDED", "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED", 0],
  ] as const)(
    "maps disk admission %s to %s with %i node health report",
    async (diskCode, expectedCode, expectedReports) => {
      const fileSystem = new FakeWorkspaceFileSystem();
      const progress = preparationContext();
      const diskBudget: WorkspaceDiskBudget = {
        admit: async () => {
          throw new WorkspaceDiskBudgetError(diskCode, "injected admission failure");
        },
      };

      await expect(
        provider(fileSystem, new FakeManagedProcessRunner(), {
          diskBudget,
        }).prepare(envelope("issue"), progress.context),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(progress.healthFaults).toHaveLength(expectedReports);
    },
  );

  it("deduplicates the node report when execution and partial cleanup both fail", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
    const progress = preparationContext();
    processRunner.failAtCall = 2;
    processRunner.failureCode = "PROCESS_START_FAILED";
    diskBudget.removalError = new Error("native quarantine failed");

    await expect(
      provider(fileSystem, processRunner, {
        diskBudget,
      }).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
    expect(progress.healthFaults).toHaveLength(1);
  });

  it("reports a workspace creation failure once and releases its reservation", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
    const progress = preparationContext();
    fileSystem.createFailureAt = 1;

    await expect(
      provider(fileSystem, new FakeManagedProcessRunner(), {
        diskBudget,
      }).prepare(envelope("issue"), progress.context),
    ).rejects.toMatchObject({ code: "WORKSPACE_CREATE_FAILED" });
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "WORKSPACE_CREATE_FAILED" });
    expect(diskBudget.released).toHaveLength(1);
  });

  it("passes AbortSignal to Git and reports process count transitions", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const progress = preparationContext();
    processRunner.onRun = (_spec, context) => {
      expect(context.signal).toBe(progress.controller.signal);
      progress.controller.abort(new Error("lease lost"));
    };

    await expect(
      provider(fileSystem, processRunner).prepare(envelope("pull_request"), progress.context),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(progress.processCounts).toEqual([0, 1, 0, 0]);
    expect(fileSystem.removed).toHaveLength(1);
    expect(progress.healthFaults).toEqual([]);
  });

  it.each([
    {
      diskCode: "CURRENT_ATTEMPT_LIMIT_EXCEEDED" as const,
      workspaceCode: "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED",
    },
    {
      diskCode: "EXISTING_WORKSPACE_UNHEALTHY" as const,
      workspaceCode: "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE",
    },
  ])(
    "terminates Git and classifies disk failure $diskCode as $workspaceCode",
    async ({ diskCode, workspaceCode }) => {
      const fileSystem = new FakeWorkspaceFileSystem();
      const processRunner = new FakeManagedProcessRunner();
      const violation = new WorkspaceDiskBudgetError(diskCode, "injected quota violation");
      let released = false;
      const diskBudget: WorkspaceDiskBudget = {
        admit: async (attemptDirectory) => ({
          attemptDirectory,
          startMonitoring: async () => {
            const controller = new AbortController();
            controller.abort(violation);
            return {
              signal: controller.signal,
              violation,
              close: async () => {
                throw violation;
              },
            };
          },
          removeAttempt: async () => {
            await fileSystem.removeTree(attemptDirectory);
          },
          removeCheckout: async () => {
            await fileSystem.removeTree(win32.join(attemptDirectory, "checkout"));
          },
          abandon: () => {
            released = true;
          },
          release: async () => {
            released = true;
          },
        }),
      };

      await expect(
        provider(fileSystem, processRunner, { diskBudget }).prepare(
          envelope("pull_request"),
          preparationContext().context,
        ),
      ).rejects.toMatchObject({ code: workspaceCode });
      expect(processRunner.calls).toHaveLength(1);
      expect(processRunner.calls[0]?.context.signal.aborted).toBe(true);
      expect(fileSystem.removed).toHaveLength(1);
      expect(released).toBe(true);
    },
  );

  it("does not emit synthetic progress while a managed Git operation is silent", async () => {
    vi.useFakeTimers();
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    let releaseRun!: () => void;
    processRunner.waitForRun = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const progress = preparationContext();

    const preparation = provider(fileSystem, processRunner).prepare(
      envelope("pull_request"),
      progress.context,
    );
    await vi.waitFor(() => expect(processRunner.calls).toHaveLength(1));
    expect(progress.processCounts).toEqual([0, 1]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(progress.processCounts).toEqual([0, 1]);
    releaseRun();
    await preparation;
    expect(progress.processCounts.at(-1)).toBe(0);
  });

  it("rejects attempt reuse, unsafe identities, and redirected roots", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    const workspaceProvider = provider(fileSystem, processRunner);
    const firstContext = preparationContext();
    const first = await workspaceProvider.prepare(envelope("issue"), firstContext.context);
    const collisionContext = preparationContext();
    await expect(
      workspaceProvider.prepare(envelope("issue"), collisionContext.context),
    ).rejects.toMatchObject({ code: "ATTEMPT_ALREADY_EXISTS" });
    expect(collisionContext.healthFaults).toHaveLength(1);
    await first.cleanup();

    const invalidContext = preparationContext();
    await expect(
      workspaceProvider.prepare(
        envelope("issue", { runAttemptId: "../escape" }),
        invalidContext.context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
    expect(invalidContext.healthFaults).toEqual([]);

    const redirected = new FakeWorkspaceFileSystem();
    const redirectedContext = preparationContext();
    redirected.setRealPath(workspaceRoot, "D:\\redirected");
    await expect(
      provider(redirected, new FakeManagedProcessRunner()).prepare(
        envelope("issue", { runAttemptId: "redirected" }),
        redirectedContext.context,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_ROOT_UNSAFE" });
    expect(redirectedContext.healthFaults).toHaveLength(1);
  });

  it("tombstones unsafe cleanup and reports a node health fault for draining", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const diskBudget = new FakeWorkspaceDiskBudget(fileSystem);
    const progress = preparationContext();
    const workspace = await provider(fileSystem, new FakeManagedProcessRunner(), {
      diskBudget,
    }).prepare(envelope("issue"), progress.context);
    const outside = "C:\\AgenticReview\\outside";
    fileSystem.addDirectory(outside);
    fileSystem.setReparsePoint(workspace.attemptDirectory, true);
    await expect(workspace.cleanup()).rejects.toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
    expect(fileSystem.removed).toEqual([]);
    expect(fileSystem.has(outside)).toBe(true);
    expect(diskBudget.released).toEqual([workspace.attemptDirectory]);
    expect(progress.healthFaults).toHaveLength(1);
    expect(progress.healthFaults[0]).toMatchObject({ code: "WORKSPACE_CLEANUP_FAILED" });
  });

  it("rejects filesystem roots, unsafe repositories, and non-allowlisted Git environment", async () => {
    const fileSystem = new FakeWorkspaceFileSystem();
    const processRunner = new FakeManagedProcessRunner();
    expect(
      () =>
        new ProductionDisposableJobWorkspaceProvider({
          workspaceRootDirectory: "C:\\",
          gitSharedRootDirectory,
          gitExecutable,
          gitWorkingDirectory,
          gitEnvironment: validGitEnvironment(),
          gitLimits: {
            hardTimeoutMs: 60_000,
            maximumProcessCount: 4,
            maximumMemoryBytes: 536_870_912,
            maximumOutputBytes: 1_048_576,
          },
          gitSharedCachePolicy: {
            maximumTotalBytes: 64n * 1024n * 1024n * 1024n,
            minimumFreeBytes: 10n * 1024n * 1024n * 1024n,
            maximumScanEntries: 250_000,
            maximumScanDurationMs: 30_000,
            gcMinimumIntervalMs: 60_000,
            gcPruneAgeHours: 168,
          },
          diskBudget: new FakeWorkspaceDiskBudget(fileSystem),
          fileSystem,
          processRunner,
        }),
    ).toThrow(JobWorkspaceError);
    expect(
      () =>
        new ProductionDisposableJobWorkspaceProvider({
          workspaceRootDirectory: workspaceRoot,
          gitSharedRootDirectory,
          gitExecutable,
          gitWorkingDirectory,
          gitEnvironment: { API_TOKEN: "secret" },
          gitLimits: {
            hardTimeoutMs: 60_000,
            maximumProcessCount: 4,
            maximumMemoryBytes: 536_870_912,
            maximumOutputBytes: 1_048_576,
          },
          gitSharedCachePolicy: {
            maximumTotalBytes: 64n * 1024n * 1024n * 1024n,
            minimumFreeBytes: 10n * 1024n * 1024n * 1024n,
            maximumScanEntries: 250_000,
            maximumScanDurationMs: 30_000,
            gcMinimumIntervalMs: 60_000,
            gcPruneAgeHours: 168,
          },
          diskBudget: new FakeWorkspaceDiskBudget(fileSystem),
          fileSystem,
          processRunner,
        }),
    ).toThrow(JobWorkspaceError);
    await expect(
      provider(new FakeWorkspaceFileSystem(), processRunner).prepare(
        envelope("pull_request", { repository: "owner/repo?upload-pack=evil" }),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
  });

  it.each([
    ["SYSTEMROOT", "SystemRoot"],
    ["COMSPEC", "ComSpec"],
    ["PATH", "PATH"],
    ["PATHEXT", "PATHEXT"],
  ] as const)("requires the %s replacement environment entry", (_name, configuredName) => {
    const environment = validGitEnvironment();
    delete environment[configuredName];

    expect(() =>
      provider(new FakeWorkspaceFileSystem(), new FakeManagedProcessRunner(), {
        gitEnvironment: environment,
      }),
    ).toThrow(JobWorkspaceError);
  });

  it.each([
    {
      name: "ill-formed Unicode",
      override: { PATHEXT: `.EXE${String.fromCharCode(0xd800)}` },
    },
    { name: "relative TEMP", override: { TEMP: "relative\\temp" } },
    { name: "relative path component", override: { USERPROFILE: "C:\\safe\\..\\profile" } },
    { name: "workspace TEMP", override: { TEMP: `${workspaceRoot}\\temp` } },
    {
      name: "Git installation COMSPEC",
      override: { ComSpec: `${win32.dirname(gitExecutable)}\\cmd.exe` },
    },
    {
      name: "workspace PATH entry",
      override: { PATH: `C:\\Windows\\System32;${workspaceRoot}` },
    },
    {
      name: "Git installation PATH entry",
      override: { PATH: `C:\\Windows\\System32;${win32.dirname(gitExecutable)}` },
    },
    { name: "empty PATH entry", override: { PATH: "C:\\Windows;;C:\\Tools" } },
    {
      name: "duplicate PATH entry",
      override: { PATH: "C:\\Windows\\System32;c:\\windows\\system32" },
    },
  ])("rejects $name in the replacement environment", ({ override }) => {
    expect(() =>
      provider(new FakeWorkspaceFileSystem(), new FakeManagedProcessRunner(), {
        gitEnvironment: { ...validGitEnvironment(), ...override },
      }),
    ).toThrow(JobWorkspaceError);
  });

  it("requires a disjoint, stable, empty trusted Git working directory", async () => {
    expect(() =>
      provider(new FakeWorkspaceFileSystem(), new FakeManagedProcessRunner(), {
        gitWorkingDirectory: `${workspaceRoot}\\git-cwd`,
      }),
    ).toThrow(JobWorkspaceError);

    const redirected = new FakeWorkspaceFileSystem();
    redirected.setRealPath(gitWorkingDirectory, "D:\\redirected-git-cwd");
    await expect(
      provider(redirected, new FakeManagedProcessRunner()).prepare(
        envelope("issue"),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });

    const occupied = new FakeWorkspaceFileSystem();
    occupied.addDirectory(`${gitWorkingDirectory}\\unexpected`);
    await expect(
      provider(occupied, new FakeManagedProcessRunner()).prepare(
        envelope("issue"),
        preparationContext().context,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
  });
});
