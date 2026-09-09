import { createHash } from "node:crypto";
import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  readdir as nodeReadDirectory,
  realpath as nodeRealpath,
  statfs as nodeStatFileSystem,
} from "node:fs/promises";
import { win32 } from "node:path";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  evaluationExecutionCapabilityLabel,
  GitHubIssueSchema,
  getEvaluationValidationJobContextIssues,
  type JobExecutionEnvelope,
  JobExecutionEnvelopeV2Schema,
  maximumRenderedPromptUtf8Bytes,
  ReviewRunTestedSourceAuthorizationSchema,
  validationExecutorCapabilityLabels,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import type { Logger } from "../logging/logger.js";
import type { ManagedProcessRunner, ManagedProcessRunResult } from "./managed-process-runner.js";
import {
  ManagedProcessRunError,
  ProductionManagedProcessRunner,
} from "./managed-process-runner.js";
import {
  assertWindowsLocalAbsolutePath,
  type ProcessHostClient,
  type ProcessResourceLimits,
  processHostResourceBounds,
} from "./process-host-protocol.js";
import {
  type WorkspaceDiskBudget,
  WorkspaceDiskBudgetError,
  type WorkspaceDiskMonitor,
  type WorkspaceDiskReservation,
} from "./workspace-disk-budget.js";

registerWorkerContractFormats();

export interface PreparedJobWorkspace {
  readonly attemptDirectory: string;
  readonly checkoutDirectory: string;
  readonly controlDirectory: string;
  readonly codexHomeDirectory: string;
  readonly tempDirectory: string;
  readonly userProfileDirectory: string;
  startDiskMonitoring(parentSignal: AbortSignal): Promise<WorkspaceDiskMonitor>;
  captureWorktreeState?(signal: AbortSignal): Promise<"clean" | "modified" | "unknown">;
  cleanup(): Promise<void>;
}

export interface WorkspacePreparationContext {
  readonly signal: AbortSignal;
  readonly processHost: ProcessHostClient;
  reportProcessCount(count: number): void;
  reportNodeHealthFault(error: JobWorkspaceError): void;
}

export interface JobWorkspaceProvider {
  prepare(
    envelope: JobExecutionEnvelope,
    context: WorkspacePreparationContext,
    purpose?: "validation" | "model",
  ): Promise<PreparedJobWorkspace>;
}

export interface WorkspacePathState {
  readonly kind: "directory" | "file" | "other";
  readonly reparsePoint: boolean;
  readonly size: bigint;
}

export interface JobWorkspaceFileSystem {
  lstat(path: string): Promise<WorkspacePathState | null>;
  realpath(path: string): Promise<string>;
  readDirectory(path: string): Promise<readonly string[]>;
  availableBytes(path: string): Promise<bigint>;
  createDirectory(path: string): Promise<void>;
}

export interface GitSharedCachePolicy {
  readonly maximumTotalBytes: bigint;
  readonly minimumFreeBytes: bigint;
  readonly maximumScanEntries: number;
  readonly maximumScanDurationMs: number;
  readonly gcMinimumIntervalMs: number;
  readonly gcPruneAgeHours: number;
}

export interface ProductionDisposableJobWorkspaceProviderOptions {
  readonly workspaceRootDirectory: string;
  readonly gitSharedRootDirectory: string;
  readonly gitExecutable: string;
  readonly gitWorkingDirectory: string;
  readonly gitEnvironment: Readonly<Record<string, string>>;
  readonly gitLimits: ProcessResourceLimits;
  readonly gitSharedCachePolicy: GitSharedCachePolicy;
  readonly diskBudget: WorkspaceDiskBudget;
  readonly fileSystem?: JobWorkspaceFileSystem;
  readonly processRunner?: ManagedProcessRunner;
  readonly logger?: Logger;
}

export type JobWorkspaceFailureCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_ENVELOPE"
  | "WORKSPACE_ROOT_UNSAFE"
  | "ATTEMPT_ALREADY_EXISTS"
  | "WORKSPACE_PATH_UNSAFE"
  | "WORKSPACE_CREATE_FAILED"
  | "WORKSPACE_CLEANUP_FAILED"
  | "WORKSPACE_DISK_ADMISSION_FAILED"
  | "WORKSPACE_DISK_CAPACITY_UNAVAILABLE"
  | "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED"
  | "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE"
  | "GIT_COMMAND_FAILED"
  | "GIT_INFRASTRUCTURE_FAILED"
  | "GIT_SHARED_CACHE_LIMIT_EXCEEDED"
  | "GIT_LOCAL_OR_REVISION_FAILED"
  | "GIT_POLICY_LIMIT_EXCEEDED"
  | "GIT_REVISION_MISMATCH"
  | "ABORTED";

export class JobWorkspaceError extends Error {
  public constructor(
    public readonly code: JobWorkspaceFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JobWorkspaceError";
  }
}

export class ProductionJobWorkspaceFileSystem implements JobWorkspaceFileSystem {
  public async lstat(path: string): Promise<WorkspacePathState | null> {
    try {
      const stats = await nodeLstat(path, { bigint: true });
      const reparseAwareStats = stats as typeof stats & {
        isReparsePoint?(): boolean;
      };
      return {
        kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        reparsePoint: stats.isSymbolicLink() || reparseAwareStats.isReparsePoint?.() === true,
        size: stats.size,
      };
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    }
  }

  public realpath(path: string): Promise<string> {
    return nodeRealpath(path);
  }

  public readDirectory(path: string): Promise<readonly string[]> {
    return nodeReadDirectory(path);
  }

  public async availableBytes(path: string): Promise<bigint> {
    const stats = await nodeStatFileSystem(path, { bigint: true });
    return stats.bavail * stats.bsize;
  }

  public async createDirectory(path: string): Promise<void> {
    await nodeMkdir(path, { recursive: false });
  }
}

interface WorkspaceLayout {
  readonly rootDirectory: string;
  readonly attemptDirectory: string;
  readonly checkoutDirectory: string;
  readonly controlDirectory: string;
  readonly codexHomeDirectory: string;
  readonly tempDirectory: string;
  readonly userProfileDirectory: string;
}

interface SharedRepositoryLayout {
  readonly key: string;
  readonly gitDirectory: string;
}

const enforcedGitEnvironment = Object.freeze({
  GIT_CONFIG_GLOBAL: "NUL",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "",
  GIT_LFS_SKIP_SMUDGE: "1",
  SSH_ASKPASS: "",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
});

// These private, immutable argument identities share the enclosing source-capture disk monitor.
// Ordinary argument arrays, including identical argv, retain their per-command disk monitor.
const sourceObservationGitArguments = Object.freeze({
  status: Object.freeze(["status", "--porcelain=v1", "--untracked-files=all"]),
  head: Object.freeze(["rev-parse", "--verify", "HEAD^{commit}"]),
});

const gitConfigurationArguments = Object.freeze([
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "core.askPass=",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=NUL",
  "-c",
  "core.protectNTFS=true",
  "-c",
  "core.symlinks=false",
  "-c",
  "credential.helper=",
  "-c",
  "fetch.fsckObjects=true",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "http.followRedirects=false",
  "-c",
  "init.templateDir=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "submodule.recurse=false",
  "-c",
  "transfer.fsckObjects=true",
]);

const forbiddenGitEnvironmentName =
  /^(?:GIT_CONFIG(?:_|$)|GIT_DIR$|GIT_WORK_TREE$|GIT_COMMON_DIR$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_INDEX_FILE$|GIT_NAMESPACE$|GIT_EXEC_PATH$|GIT_TEMPLATE_DIR$|GIT_SSH(?:_COMMAND)?$|GIT_PROXY_COMMAND$)$/iu;
const allowedGitEnvironmentNames = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT"]);
const requiredGitEnvironmentNames = Object.freeze([
  "SYSTEMROOT",
  "COMSPEC",
  "PATH",
  "PATHEXT",
] as const);
const directoryGitEnvironmentNames = new Set(["SYSTEMROOT", "WINDIR"]);
const maximumSharedGitScanEntries = 1_000_000;
const maximumSharedGitScanDurationMs = 300_000;
const maximumSharedGitGcPruneAgeHours = 24 * 365;
const maximumGitCleanupStderrCharacters = 2_048;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Remove terminal escape sequences from diagnostic output.
const gitCleanupAnsiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Control and direction characters must not reach diagnostic log messages.
const gitLogControlPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

interface SharedCacheScanSummary {
  readonly totalBytes: bigint;
  readonly availableBytes: bigint;
  readonly scannedEntries: number;
}

interface SharedCacheBudgetStatus {
  readonly totalWithinLimit: boolean;
  readonly freeSpaceWithinLimit: boolean;
  readonly scan: SharedCacheScanSummary;
}

type SharedCacheGcSkipReason = "active_worktree" | "minimum_interval";

interface SharedCacheGcOutcome {
  readonly ran: boolean;
  readonly skipReason?: SharedCacheGcSkipReason;
}

type GitWorkspaceValidationMode = "strict" | "cleanup_safe";

export class ProductionDisposableJobWorkspaceProvider implements JobWorkspaceProvider {
  readonly #workspaceRootDirectory: string;
  readonly #gitSharedRootDirectory: string;
  readonly #gitExecutable: string;
  readonly #gitWorkingDirectory: string;
  readonly #gitEnvironment: Readonly<Record<string, string>>;
  readonly #gitLimits: ProcessResourceLimits;
  readonly #gitSharedCachePolicy: GitSharedCachePolicy;
  readonly #diskBudget: WorkspaceDiskBudget;
  readonly #fileSystem: JobWorkspaceFileSystem;
  readonly #processRunner: ManagedProcessRunner;
  #sharedCacheMutationTail: Promise<void> = Promise.resolve();
  readonly #repositoryTails = new Map<string, Promise<void>>();
  readonly #activeWorktreeCounts = new Map<string, number>();
  readonly #lastRepositoryGcAt = new Map<string, number>();
  readonly #logger: Logger | undefined;

  public constructor(options: ProductionDisposableJobWorkspaceProviderOptions) {
    try {
      assertWindowsLocalAbsolutePath(
        options.workspaceRootDirectory,
        "workspaceRootDirectory",
        false,
      );
      assertWindowsLocalAbsolutePath(options.gitExecutable, "gitExecutable", true);
      if (win32.basename(options.gitExecutable).toLowerCase() !== "git.exe") {
        throw new Error("gitExecutable must identify git.exe.");
      }
      this.#workspaceRootDirectory = normalizeDirectory(options.workspaceRootDirectory);
      if (
        sameWindowsPath(
          this.#workspaceRootDirectory,
          win32.parse(this.#workspaceRootDirectory).root,
        )
      ) {
        throw new Error("workspaceRootDirectory must not be a filesystem root.");
      }
      this.#gitExecutable = win32.normalize(options.gitExecutable);
      const gitInstallationDirectory = normalizeDirectory(win32.dirname(this.#gitExecutable));
      if (windowsPathsOverlap(this.#workspaceRootDirectory, gitInstallationDirectory)) {
        throw new Error("workspaceRootDirectory must not overlap the trusted Git installation.");
      }
      assertWindowsLocalAbsolutePath(
        options.gitSharedRootDirectory,
        "gitSharedRootDirectory",
        false,
      );
      this.#gitSharedRootDirectory = normalizeDirectory(options.gitSharedRootDirectory);
      if (
        sameWindowsPath(
          this.#gitSharedRootDirectory,
          win32.parse(this.#gitSharedRootDirectory).root,
        )
      ) {
        throw new Error("gitSharedRootDirectory must not be a filesystem root.");
      }
      if (
        windowsPathsOverlap(this.#gitSharedRootDirectory, this.#workspaceRootDirectory) ||
        windowsPathsOverlap(this.#gitSharedRootDirectory, gitInstallationDirectory)
      ) {
        throw new Error(
          "gitSharedRootDirectory must not overlap workspaceRootDirectory or the Git installation.",
        );
      }
      assertWindowsLocalAbsolutePath(options.gitWorkingDirectory, "gitWorkingDirectory", false);
      this.#gitWorkingDirectory = normalizeDirectory(options.gitWorkingDirectory);
      if (sameWindowsPath(this.#gitWorkingDirectory, win32.parse(this.#gitWorkingDirectory).root)) {
        throw new Error("gitWorkingDirectory must not be a filesystem root.");
      }
      if (
        windowsPathsOverlap(this.#gitWorkingDirectory, this.#workspaceRootDirectory) ||
        windowsPathsOverlap(this.#gitWorkingDirectory, this.#gitSharedRootDirectory) ||
        windowsPathsOverlap(this.#gitWorkingDirectory, gitInstallationDirectory)
      ) {
        throw new Error(
          "gitWorkingDirectory must not overlap workspaceRootDirectory, gitSharedRootDirectory, or the Git installation.",
        );
      }
      this.#gitEnvironment = buildGitEnvironment(
        options.gitEnvironment,
        this.#workspaceRootDirectory,
        gitInstallationDirectory,
      );
      this.#gitLimits = copyAndValidateLimits(options.gitLimits);
      this.#gitSharedCachePolicy = copyAndValidateGitSharedCachePolicy(
        options.gitSharedCachePolicy,
      );
    } catch (error) {
      throw new JobWorkspaceError(
        "INVALID_CONFIGURATION",
        "Disposable workspace configuration is invalid.",
        { cause: error },
      );
    }
    this.#diskBudget = options.diskBudget;
    this.#fileSystem = options.fileSystem ?? new ProductionJobWorkspaceFileSystem();
    this.#processRunner = options.processRunner ?? new ProductionManagedProcessRunner();
    this.#logger = options.logger;
  }

  public async prepare(
    envelope: JobExecutionEnvelope,
    context: WorkspacePreparationContext,
    purpose: "validation" | "model" = "validation",
  ): Promise<PreparedJobWorkspace> {
    context.reportProcessCount(0);
    throwIfAborted(context.signal);
    let nodeHealthFaultReported = false;
    const reportNodeHealthFaultOnce = (fault: JobWorkspaceError): JobWorkspaceError => {
      if (nodeHealthFaultReported) return fault;
      nodeHealthFaultReported = true;
      return reportHealthFaultSafely(context.reportNodeHealthFault, fault);
    };

    let layout: WorkspaceLayout;
    let repository: SharedRepositoryLayout | undefined;
    let source: WorkspaceSource | null;
    try {
      source = workspaceSource(envelope);
      layout = deriveWorkspaceLayout(
        this.#workspaceRootDirectory,
        envelope.lease.runAttemptId,
        purpose,
      );
      repository =
        source !== null
          ? deriveSharedRepositoryLayout(
              this.#gitSharedRootDirectory,
              envelope.repository.githubRepositoryId,
            )
          : undefined;
    } catch (error) {
      throw new JobWorkspaceError("INVALID_ENVELOPE", "Job workspace identity is invalid.", {
        cause: error,
      });
    }

    const guard = new WorkspaceGuard(this.#fileSystem, layout);
    let attemptCreated = false;
    let worktreeRegistered = false;
    let diskReservation: WorkspaceDiskReservation | undefined;
    try {
      await this.#validateGitWorkingDirectory();
      await this.#validateGitSharedRootDirectory();
      throwIfAborted(context.signal);
      await guard.validateRoot();
      throwIfAborted(context.signal);
      if ((await this.#fileSystem.lstat(layout.attemptDirectory)) !== null) {
        throw new JobWorkspaceError(
          "ATTEMPT_ALREADY_EXISTS",
          "The disposable attempt directory already exists.",
        );
      }

      try {
        diskReservation = await this.#diskBudget.admit(layout.attemptDirectory, context.signal);
      } catch (error) {
        if (error instanceof WorkspaceDiskBudgetError) {
          throw workspaceDiskAdmissionError(error);
        }
        throw new JobWorkspaceError(
          "WORKSPACE_DISK_ADMISSION_FAILED",
          "Workspace disk admission failed closed.",
          { cause: error },
        );
      }
      throwIfAborted(context.signal);
      const admittedDiskReservation = diskReservation;
      if (admittedDiskReservation === undefined) {
        throw new JobWorkspaceError(
          "WORKSPACE_DISK_ADMISSION_FAILED",
          "Workspace disk admission completed without a reservation.",
        );
      }

      try {
        await this.#fileSystem.createDirectory(layout.attemptDirectory);
      } catch (error) {
        if (isFileSystemError(error, "EEXIST")) {
          throw new JobWorkspaceError(
            "ATTEMPT_ALREADY_EXISTS",
            "The disposable attempt directory was created concurrently.",
            { cause: error },
          );
        }
        throw error;
      }
      attemptCreated = true;
      await this.#fileSystem.createDirectory(layout.checkoutDirectory);
      await this.#fileSystem.createDirectory(layout.controlDirectory);
      await this.#fileSystem.createDirectory(layout.codexHomeDirectory);
      await this.#fileSystem.createDirectory(layout.tempDirectory);
      await this.#fileSystem.createDirectory(layout.userProfileDirectory);
      await guard.validateAll();
      throwIfAborted(context.signal);

      await this.#initializeRepository(
        layout,
        guard,
        admittedDiskReservation,
        repository,
        envelope,
        context,
        () => {
          worktreeRegistered = true;
        },
      );
      await guard.validateAll();
      if (repository !== undefined && source !== null) {
        await this.#verifyPreparedWorktree(
          layout,
          guard,
          admittedDiskReservation,
          source.baseSha,
          source.headSha,
          context,
        );
      }
      let cleaned = false;
      return Object.freeze({
        attemptDirectory: layout.attemptDirectory,
        checkoutDirectory: layout.checkoutDirectory,
        controlDirectory: layout.controlDirectory,
        codexHomeDirectory: layout.codexHomeDirectory,
        tempDirectory: layout.tempDirectory,
        userProfileDirectory: layout.userProfileDirectory,
        startDiskMonitoring: (parentSignal: AbortSignal) =>
          admittedDiskReservation.startMonitoring(parentSignal),
        captureWorktreeState: async (
          signal: AbortSignal,
        ): Promise<"clean" | "modified" | "unknown"> => {
          if (repository === undefined || source === null) {
            return "unknown";
          }
          let monitor: WorkspaceDiskMonitor | undefined;
          let state: "clean" | "modified" | "unknown" = "unknown";
          try {
            monitor = await admittedDiskReservation.startMonitoring(signal);
            const observationContext = {
              ...context,
              signal: monitor.signal,
              reportProcessCount: () => undefined,
            };
            const status = await this.#runGit(
              layout,
              guard,
              admittedDiskReservation,
              sourceObservationGitArguments.status,
              "deterministic_local",
              observationContext,
            );
            if (status.stdout.trim().length > 0) state = "modified";
            else {
              const head = await this.#runGit(
                layout,
                guard,
                admittedDiskReservation,
                sourceObservationGitArguments.head,
                "deterministic_local",
                observationContext,
              );
              state = head.stdout.trim() === source.headSha ? "clean" : "modified";
            }
          } catch {
            state = "unknown";
          } finally {
            try {
              await monitor?.close();
              if (monitor?.violation !== undefined || monitor?.signal.aborted || signal.aborted)
                state = "unknown";
            } catch {
              state = "unknown";
            }
          }
          return state;
        },
        cleanup: async () => {
          if (cleaned) return;
          let cleanupError: unknown;
          const cleanupFailures: unknown[] = [];
          if (repository !== undefined && worktreeRegistered) {
            try {
              await this.#removeRegisteredWorktree(
                layout,
                guard,
                admittedDiskReservation,
                repository,
                context.processHost,
              );
              worktreeRegistered = false;
            } catch (error) {
              cleanupFailures.push(error);
            }
          }
          try {
            await removeReservedAttempt(admittedDiskReservation);
          } catch (error) {
            cleanupFailures.push(error);
          }
          if (cleanupFailures.length > 0) {
            admittedDiskReservation.abandon();
            cleanupError = this.#nodeHealthFault(
              "Native workspace cleanup failed; the Worker must drain.",
              collapseCleanupErrors(cleanupFailures),
              reportNodeHealthFaultOnce,
            );
          }
          if (cleanupError === undefined) {
            try {
              await admittedDiskReservation.release();
            } catch (error) {
              admittedDiskReservation.abandon();
              cleanupError = this.#nodeHealthFault(
                "Workspace reservation release failed; the Worker must drain.",
                error,
                reportNodeHealthFaultOnce,
              );
            }
          }
          if (cleanupError !== undefined) throw cleanupError;
          cleaned = true;
        },
      });
    } catch (error) {
      context.reportProcessCount(0);
      let failure = error;
      let reservationAbandoned = false;
      if (attemptCreated) {
        const cleanupFailures: unknown[] = [];
        if (diskReservation === undefined) {
          cleanupFailures.push(new Error("Attempt creation lost its disk reservation."));
        } else {
          if (repository !== undefined && worktreeRegistered) {
            try {
              await this.#removeRegisteredWorktree(
                layout,
                guard,
                diskReservation,
                repository,
                context.processHost,
              );
              worktreeRegistered = false;
            } catch (cleanupError) {
              cleanupFailures.push(cleanupError);
            }
          }
          try {
            await removeReservedAttempt(diskReservation);
          } catch (cleanupError) {
            cleanupFailures.push(cleanupError);
          }
        }
        if (cleanupFailures.length > 0) {
          if (diskReservation !== undefined) {
            diskReservation.abandon();
            reservationAbandoned = true;
          }
          const healthFault = this.#nodeHealthFault(
            "Partial workspace cleanup failed; the Worker must drain.",
            collapseCleanupErrors(cleanupFailures),
            reportNodeHealthFaultOnce,
          );
          failure = new JobWorkspaceError(
            "WORKSPACE_CLEANUP_FAILED",
            "Workspace preparation failed and its disposable directory could not be removed.",
            { cause: new AggregateError([failure, healthFault]) },
          );
        }
      }
      if (diskReservation !== undefined && !reservationAbandoned) {
        try {
          await diskReservation.release();
        } catch (releaseError) {
          diskReservation.abandon();
          const healthFault = this.#nodeHealthFault(
            "Workspace reservation release failed; the Worker must drain.",
            releaseError,
            reportNodeHealthFaultOnce,
          );
          failure = new JobWorkspaceError(
            "WORKSPACE_CLEANUP_FAILED",
            "Workspace preparation failed and its disk reservation could not be released.",
            { cause: new AggregateError([failure, healthFault]) },
          );
        }
      }
      let finalError: JobWorkspaceError;
      if (failure instanceof JobWorkspaceError) {
        finalError = failure;
      } else if (context.signal.aborted) {
        finalError = new JobWorkspaceError("ABORTED", "Workspace preparation was aborted.", {
          cause: failure,
        });
      } else {
        finalError = new JobWorkspaceError(
          "WORKSPACE_CREATE_FAILED",
          "Workspace preparation failed.",
          { cause: failure },
        );
      }
      if (isNodeInfrastructureFailure(finalError.code)) {
        finalError = reportNodeHealthFaultOnce(finalError);
      }
      throw finalError;
    }
  }

  async #initializeRepository(
    layout: WorkspaceLayout,
    guard: WorkspaceGuard,
    diskReservation: WorkspaceDiskReservation,
    repository: SharedRepositoryLayout | undefined,
    envelope: JobExecutionEnvelope,
    context: WorkspacePreparationContext,
    onWorktreeRegistered: () => void,
  ): Promise<void> {
    const source = workspaceSource(envelope);
    if (source === null) return;
    if (repository === undefined) {
      throw new JobWorkspaceError(
        "INVALID_ENVELOPE",
        "Executable validation workspaces require a shared repository identity.",
      );
    }

    const repositoryUrl = buildAnonymousGitHubUrl(envelope.repository.fullName);
    const baseSha = validateGitObjectId(source.baseSha, "baseSha");
    const headSha = validateGitObjectId(source.headSha, "headSha");
    const headReference =
      source.fetchHead === "exact_commit" ? headSha : `refs/pull/${source.pullRequestNumber}/head`;
    await this.#withSharedCacheMutationLock(context.signal, async () => {
      await this.#withRepositoryLock(repository.key, context.signal, async () => {
        await this.#validateSharedRepositoryDirectory(repository, false);
        await this.#runGit(
          layout,
          guard,
          diskReservation,
          ["init", "--bare", "--quiet", repository.gitDirectory],
          "node_infrastructure",
          context,
          null,
        );
        await this.#validateSharedRepositoryDirectory(repository, true);
        await this.#runGit(
          layout,
          guard,
          diskReservation,
          [
            `--git-dir=${repository.gitDirectory}`,
            "config",
            "--local",
            "remote.origin.url",
            repositoryUrl,
          ],
          "deterministic_local",
          context,
          null,
        );
        await this.#enforceSharedCacheBudget(
          layout,
          guard,
          diskReservation,
          repository,
          context,
          "before_fetch",
        );
        await this.#runGit(
          layout,
          guard,
          diskReservation,
          [`--git-dir=${repository.gitDirectory}`, "worktree", "prune", "--expire", "now"],
          "deterministic_local",
          context,
          null,
        );
        // The immutable base can belong to any branch, including one that has since advanced.
        await this.#runGit(
          layout,
          guard,
          diskReservation,
          [
            `--git-dir=${repository.gitDirectory}`,
            "fetch",
            "--quiet",
            "--force",
            "--no-tags",
            "--no-auto-maintenance",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "origin",
            `+${baseSha}:refs/agentic-review/latest-base`,
            `+${headReference}:refs/agentic-review/latest-head`,
          ],
          "ambiguous_remote",
          context,
          null,
        );
        await this.#enforceSharedCacheBudget(
          layout,
          guard,
          diskReservation,
          repository,
          context,
          "after_fetch",
        );
        const currentHead = await this.#runGit(
          layout,
          guard,
          diskReservation,
          [
            `--git-dir=${repository.gitDirectory}`,
            "rev-parse",
            "--verify",
            "refs/agentic-review/latest-head^{commit}",
          ],
          "deterministic_local",
          context,
          null,
        );
        assertExactGitObjectId(currentHead.stdout, headSha, "pull request head");
        const currentBase = await this.#runGit(
          layout,
          guard,
          diskReservation,
          [
            `--git-dir=${repository.gitDirectory}`,
            "rev-parse",
            "--verify",
            "refs/agentic-review/latest-base^{commit}",
          ],
          "deterministic_local",
          context,
          null,
        );
        assertExactGitObjectId(currentBase.stdout, baseSha, "pull request base");
        const baseType = await this.#runGit(
          layout,
          guard,
          diskReservation,
          [`--git-dir=${repository.gitDirectory}`, "cat-file", "-t", baseSha],
          "deterministic_local",
          context,
          null,
        );
        assertExactGitOutput(baseType.stdout, "commit", "base object type");
        const headType = await this.#runGit(
          layout,
          guard,
          diskReservation,
          [`--git-dir=${repository.gitDirectory}`, "cat-file", "-t", headSha],
          "deterministic_local",
          context,
          null,
        );
        assertExactGitOutput(headType.stdout, "commit", "head object type");
        const mergeBase = await this.#runGit(
          layout,
          guard,
          diskReservation,
          [`--git-dir=${repository.gitDirectory}`, "merge-base", "--all", baseSha, headSha],
          "deterministic_local",
          context,
          null,
        );
        assertGitObjectIdList(mergeBase.stdout, "pull request merge base");
        await this.#runGit(
          layout,
          guard,
          diskReservation,
          [
            `--git-dir=${repository.gitDirectory}`,
            "worktree",
            "add",
            "--detach",
            "--force",
            layout.checkoutDirectory,
            headSha,
          ],
          "deterministic_local",
          context,
          null,
          true,
          () => {
            this.#markWorktreeRegistered(repository.key);
            onWorktreeRegistered();
          },
        );
      });
    });
  }

  async #verifyPreparedWorktree(
    layout: WorkspaceLayout,
    guard: WorkspaceGuard,
    diskReservation: WorkspaceDiskReservation,
    baseSha: string,
    headSha: string,
    context: WorkspacePreparationContext,
  ): Promise<void> {
    const actualHead = await this.#runGit(
      layout,
      guard,
      diskReservation,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "deterministic_local",
      context,
    );
    assertExactGitObjectId(actualHead.stdout, headSha, "HEAD");
    const baseType = await this.#runGit(
      layout,
      guard,
      diskReservation,
      ["cat-file", "-t", baseSha],
      "deterministic_local",
      context,
    );
    assertExactGitOutput(baseType.stdout, "commit", "base object type");
  }

  async #removeRegisteredWorktree(
    layout: WorkspaceLayout,
    guard: WorkspaceGuard,
    diskReservation: WorkspaceDiskReservation,
    repository: SharedRepositoryLayout,
    processHost: ProcessHostClient,
  ): Promise<void> {
    const cleanupContext: WorkspacePreparationContext = {
      signal: AbortSignal.timeout(this.#gitLimits.hardTimeoutMs),
      processHost,
      reportProcessCount: () => undefined,
      reportNodeHealthFault: () => undefined,
    };
    await this.#withSharedCacheMutationLock(cleanupContext.signal, async () => {
      await this.#withRepositoryLock(repository.key, cleanupContext.signal, async () => {
        let worktreeRemoved = false;
        let recoveredFailure: ManagedProcessRunError | undefined;
        try {
          await this.#runGit(
            layout,
            guard,
            diskReservation,
            [
              `--git-dir=${repository.gitDirectory}`,
              "worktree",
              "remove",
              "--force",
              layout.checkoutDirectory,
            ],
            "deterministic_local",
            cleanupContext,
            null,
            false,
            () => {
              this.#markWorktreeRemoved(repository.key);
              worktreeRemoved = true;
            },
            "cleanup_safe",
          );
        } catch (error) {
          if (
            error instanceof JobWorkspaceError &&
            error.code === "GIT_LOCAL_OR_REVISION_FAILED" &&
            error.cause instanceof ManagedProcessRunError &&
            error.cause.code === "NON_ZERO_EXIT"
          ) {
            try {
              await guard.validateForCleanup();
              await diskReservation.removeCheckout();
              if (!(await guard.hasMissingCheckoutDirectory())) {
                throw new JobWorkspaceError(
                  "WORKSPACE_PATH_UNSAFE",
                  "Reserved checkout removal left the checkout path present.",
                );
              }
              await this.#runGit(
                layout,
                guard,
                diskReservation,
                [`--git-dir=${repository.gitDirectory}`, "worktree", "prune", "--expire", "now"],
                "deterministic_local",
                cleanupContext,
                null,
                false,
                undefined,
                "cleanup_safe",
              );
              const registration = await this.#runGit(
                layout,
                guard,
                diskReservation,
                [`--git-dir=${repository.gitDirectory}`, "worktree", "list", "--porcelain", "-z"],
                "deterministic_local",
                cleanupContext,
                null,
                false,
                undefined,
                "cleanup_safe",
              );
              assertWorktreeRegistrationMissing(
                registration.stdout,
                repository.gitDirectory,
                layout.checkoutDirectory,
              );
              this.#markWorktreeRemoved(repository.key);
              worktreeRemoved = true;
              recoveredFailure = error.cause;
            } catch (recoveryError) {
              throw new JobWorkspaceError(
                "WORKSPACE_CLEANUP_FAILED",
                `Reserved checkout recovery failed after ${error.message}`,
                { cause: recoveryError },
              );
            }
          } else {
            throw error;
          }
        }
        if (!worktreeRemoved) {
          this.#markWorktreeRemoved(repository.key);
        }
        await this.#enforceSharedCacheBudget(
          layout,
          guard,
          diskReservation,
          repository,
          cleanupContext,
          "post_cleanup",
        );
        if (recoveredFailure !== undefined) {
          try {
            this.#logger?.warn(
              "Git worktree removal recovered through reserved checkout cleanup.",
              {
                exitCode: recoveredFailure.exitCode,
                stderrSummary: summarizeGitCleanupStderr(recoveredFailure.stderr),
              },
            );
          } catch {
            // Diagnostic logging must not reverse a verified cleanup recovery.
          }
        }
      });
    });
  }

  #markWorktreeRegistered(repositoryKey: string): void {
    this.#activeWorktreeCounts.set(
      repositoryKey,
      (this.#activeWorktreeCounts.get(repositoryKey) ?? 0) + 1,
    );
  }

  #markWorktreeRemoved(repositoryKey: string): void {
    const current = this.#activeWorktreeCounts.get(repositoryKey) ?? 0;
    if (current <= 1) {
      this.#activeWorktreeCounts.delete(repositoryKey);
      return;
    }
    this.#activeWorktreeCounts.set(repositoryKey, current - 1);
  }

  async #enforceSharedCacheBudget(
    layout: WorkspaceLayout,
    guard: WorkspaceGuard,
    diskReservation: WorkspaceDiskReservation,
    repository: SharedRepositoryLayout,
    context: WorkspacePreparationContext,
    phase: "before_fetch" | "after_fetch" | "post_cleanup",
  ): Promise<void> {
    const initial = await this.#readSharedCacheBudgetStatus(context.signal);
    if (initial.totalWithinLimit && initial.freeSpaceWithinLimit) {
      return;
    }

    const gcOutcome = await this.#runRepositoryMaintenanceIfEligible(
      layout,
      guard,
      diskReservation,
      repository,
      context,
      phase,
    );
    const finalStatus = await this.#readSharedCacheBudgetStatus(context.signal);
    if (isSharedCacheBudgetSatisfied(finalStatus, phase)) {
      return;
    }

    throw createSharedCacheLimitError(this.#gitSharedCachePolicy, finalStatus.scan, {
      phase,
      gcOutcome,
      includeFreeSpaceReason: phase !== "post_cleanup",
    });
  }

  async #runRepositoryMaintenanceIfEligible(
    layout: WorkspaceLayout,
    guard: WorkspaceGuard,
    diskReservation: WorkspaceDiskReservation,
    repository: SharedRepositoryLayout,
    context: WorkspacePreparationContext,
    phase: "before_fetch" | "after_fetch" | "post_cleanup",
  ): Promise<SharedCacheGcOutcome> {
    const validationMode: GitWorkspaceValidationMode =
      phase === "post_cleanup" ? "cleanup_safe" : "strict";
    await this.#runGit(
      layout,
      guard,
      diskReservation,
      [`--git-dir=${repository.gitDirectory}`, "worktree", "prune", "--expire", "now"],
      "deterministic_local",
      context,
      null,
      false,
      undefined,
      validationMode,
    );

    if ((this.#activeWorktreeCounts.get(repository.key) ?? 0) > 0) {
      return { ran: false, skipReason: "active_worktree" };
    }

    const worktreeMetadataEntries = await this.#countRepositoryWorktreeMetadataEntries(
      repository,
      context.signal,
    );
    if (worktreeMetadataEntries > 0) {
      return { ran: false, skipReason: "active_worktree" };
    }

    const now = Date.now();
    const lastGc = this.#lastRepositoryGcAt.get(repository.key);
    if (lastGc !== undefined && now - lastGc < this.#gitSharedCachePolicy.gcMinimumIntervalMs) {
      return { ran: false, skipReason: "minimum_interval" };
    }

    const gcPruneAge = `${this.#gitSharedCachePolicy.gcPruneAgeHours}.hours.ago`;
    await this.#runGit(
      layout,
      guard,
      diskReservation,
      [
        `--git-dir=${repository.gitDirectory}`,
        "reflog",
        "expire",
        "--all",
        `--expire=${gcPruneAge}`,
        `--expire-unreachable=${gcPruneAge}`,
      ],
      "node_infrastructure",
      context,
      null,
      false,
      undefined,
      validationMode,
    );

    await this.#runGit(
      layout,
      guard,
      diskReservation,
      [`--git-dir=${repository.gitDirectory}`, "gc", "--quiet", `--prune=${gcPruneAge}`],
      "node_infrastructure",
      context,
      null,
      phase !== "post_cleanup",
      undefined,
      validationMode,
    );
    this.#lastRepositoryGcAt.set(repository.key, now);
    return { ran: true };
  }

  async #countRepositoryWorktreeMetadataEntries(
    repository: SharedRepositoryLayout,
    signal: AbortSignal,
  ): Promise<number> {
    throwIfAborted(signal);
    await this.#validateSharedRepositoryDirectory(repository, true);
    const worktreesDirectory = win32.join(repository.gitDirectory, "worktrees");
    assertStrictDescendant(
      repository.gitDirectory,
      worktreesDirectory,
      "shared repository worktree metadata",
    );
    const state = await this.#fileSystem.lstat(worktreesDirectory);
    throwIfAborted(signal);
    if (state === null) {
      return 0;
    }
    if (state.kind !== "directory" || state.reparsePoint) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "Shared repository worktree metadata path must be a non-reparse directory.",
      );
    }
    const realPath = await this.#fileSystem.realpath(worktreesDirectory);
    throwIfAborted(signal);
    if (!sameWindowsPath(realPath, worktreesDirectory)) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "Shared repository worktree metadata resolves outside its configured location.",
      );
    }

    const entries = await this.#fileSystem.readDirectory(worktreesDirectory);
    assertUniqueSafeDirectoryEntries(entries, "shared repository worktree metadata");
    for (const entryName of entries) {
      throwIfAborted(signal);
      const entryPath = win32.join(worktreesDirectory, entryName);
      assertStrictDescendant(worktreesDirectory, entryPath, "shared repository worktree metadata");
      const entryState = await this.#fileSystem.lstat(entryPath);
      if (entryState === null) {
        throw new JobWorkspaceError(
          "GIT_INFRASTRUCTURE_FAILED",
          "Shared repository worktree metadata changed during inspection.",
        );
      }
      if (entryState.kind !== "directory" || entryState.reparsePoint) {
        throw new JobWorkspaceError(
          "WORKSPACE_PATH_UNSAFE",
          "Shared repository worktree metadata entry must be a non-reparse directory.",
        );
      }
      const entryRealPath = await this.#fileSystem.realpath(entryPath);
      if (!sameWindowsPath(entryRealPath, entryPath)) {
        throw new JobWorkspaceError(
          "WORKSPACE_PATH_UNSAFE",
          "Shared repository worktree metadata entry resolves outside its configured location.",
        );
      }
    }
    return entries.length;
  }

  async #readSharedCacheBudgetStatus(signal: AbortSignal): Promise<SharedCacheBudgetStatus> {
    const scan = await this.#scanSharedRepositoryCache(signal);
    return {
      totalWithinLimit: scan.totalBytes <= this.#gitSharedCachePolicy.maximumTotalBytes,
      freeSpaceWithinLimit: scan.availableBytes >= this.#gitSharedCachePolicy.minimumFreeBytes,
      scan,
    };
  }

  async #scanSharedRepositoryCache(signal: AbortSignal): Promise<SharedCacheScanSummary> {
    const deadlineEpochMilliseconds = Date.now() + this.#gitSharedCachePolicy.maximumScanDurationMs;
    try {
      const rootState = await this.#validatedSharedCachePathState(
        this.#gitSharedRootDirectory,
        "directory",
        signal,
        deadlineEpochMilliseconds,
      );
      if (rootState === null) {
        throw new JobWorkspaceError(
          "WORKSPACE_PATH_UNSAFE",
          "The shared Git repository root is missing or unsafe.",
        );
      }

      let scannedEntries = 0;
      let totalBytes = 0n;
      const pendingDirectories: string[] = [this.#gitSharedRootDirectory];
      while (pendingDirectories.length > 0) {
        this.#assertSharedCacheScanActive(signal, deadlineEpochMilliseconds);
        const currentDirectory = pendingDirectories.shift();
        if (currentDirectory === undefined) {
          break;
        }
        const entries = await this.#fileSystem.readDirectory(currentDirectory);
        if (entries.length > this.#gitSharedCachePolicy.maximumScanEntries - scannedEntries) {
          throw new JobWorkspaceError(
            "GIT_INFRASTRUCTURE_FAILED",
            "Shared Git cache scan exceeded the configured entry limit.",
          );
        }
        assertUniqueSafeDirectoryEntries(entries, "shared Git repository cache");
        for (const entryName of entries) {
          this.#assertSharedCacheScanActive(signal, deadlineEpochMilliseconds);
          scannedEntries += 1;
          if (scannedEntries > this.#gitSharedCachePolicy.maximumScanEntries) {
            throw new JobWorkspaceError(
              "GIT_INFRASTRUCTURE_FAILED",
              "Shared Git cache scan exceeded the configured entry limit.",
            );
          }

          const candidate = win32.join(currentDirectory, entryName);
          assertStrictDescendant(
            this.#gitSharedRootDirectory,
            candidate,
            "shared repository cache",
          );
          const state = await this.#validatedSharedCachePathState(
            candidate,
            undefined,
            signal,
            deadlineEpochMilliseconds,
          );
          if (state === null) {
            throw new JobWorkspaceError(
              "GIT_INFRASTRUCTURE_FAILED",
              "Shared Git cache changed during bounded accounting.",
            );
          }
          if (state.kind === "directory") {
            pendingDirectories.push(candidate);
            continue;
          }
          if (state.kind === "file") {
            totalBytes += state.size;
            continue;
          }
          throw new JobWorkspaceError(
            "WORKSPACE_PATH_UNSAFE",
            "Shared Git cache contains an unsupported non-file entry.",
          );
        }
      }

      await this.#validatedSharedCachePathState(
        this.#gitSharedRootDirectory,
        "directory",
        signal,
        deadlineEpochMilliseconds,
        rootState,
      );
      const availableBytes = await this.#fileSystem.availableBytes(this.#gitSharedRootDirectory);
      this.#assertSharedCacheScanActive(signal, deadlineEpochMilliseconds);
      if (availableBytes < 0n) {
        throw new JobWorkspaceError(
          "GIT_INFRASTRUCTURE_FAILED",
          "Shared Git cache filesystem reported invalid free-space metadata.",
        );
      }

      return { totalBytes, availableBytes, scannedEntries };
    } catch (error) {
      if (error instanceof JobWorkspaceError) {
        throw error;
      }
      throw new JobWorkspaceError(
        "GIT_INFRASTRUCTURE_FAILED",
        "Shared Git cache accounting failed closed.",
        { cause: error },
      );
    }
  }

  async #validatedSharedCachePathState(
    path: string,
    requiredKind: WorkspacePathState["kind"] | undefined,
    signal: AbortSignal,
    deadlineEpochMilliseconds: number,
    previousState?: WorkspacePathState,
  ): Promise<WorkspacePathState | null> {
    this.#assertSharedCacheScanActive(signal, deadlineEpochMilliseconds);
    const state = await this.#fileSystem.lstat(path);
    this.#assertSharedCacheScanActive(signal, deadlineEpochMilliseconds);
    if (state === null) return null;
    if (state.reparsePoint || (requiredKind !== undefined && state.kind !== requiredKind)) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "Shared Git cache path is unsafe or has an unexpected type.",
      );
    }
    if (state.size < 0n) {
      throw new JobWorkspaceError(
        "GIT_INFRASTRUCTURE_FAILED",
        "Shared Git cache reported a negative path size.",
      );
    }
    const realPath = normalizeDirectory(await this.#fileSystem.realpath(path));
    this.#assertSharedCacheScanActive(signal, deadlineEpochMilliseconds);
    if (!sameWindowsPath(realPath, path)) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "Shared Git cache path resolves through a reparse point or outside its expected location.",
      );
    }
    if (!sameWindowsPath(path, this.#gitSharedRootDirectory)) {
      assertStrictDescendant(this.#gitSharedRootDirectory, path, "shared repository cache");
    }
    if (
      previousState !== undefined &&
      (previousState.kind !== state.kind ||
        previousState.reparsePoint !== state.reparsePoint ||
        (state.kind === "file" && previousState.size !== state.size))
    ) {
      throw new JobWorkspaceError(
        "GIT_INFRASTRUCTURE_FAILED",
        "Shared Git cache path changed during bounded accounting.",
      );
    }
    return state;
  }

  #assertSharedCacheScanActive(signal: AbortSignal, deadlineEpochMilliseconds: number): void {
    throwIfAborted(signal);
    if (Date.now() <= deadlineEpochMilliseconds) {
      return;
    }
    throw new JobWorkspaceError(
      "GIT_INFRASTRUCTURE_FAILED",
      "Shared Git cache accounting exceeded its wall-clock deadline.",
    );
  }

  async #withRepositoryLock<T>(
    key: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#repositoryTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    this.#repositoryTails.set(key, tail);
    try {
      await waitForRepositoryTurn(previous, signal);
      throwIfAborted(signal);
      return await operation();
    } finally {
      release();
      void tail.then(() => {
        if (this.#repositoryTails.get(key) === tail) {
          this.#repositoryTails.delete(key);
        }
      });
    }
  }

  async #withSharedCacheMutationLock<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#sharedCacheMutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    this.#sharedCacheMutationTail = tail;
    try {
      await waitForRepositoryTurn(previous, signal);
      throwIfAborted(signal);
      return await operation();
    } finally {
      release();
      void tail.then(() => {
        if (this.#sharedCacheMutationTail === tail) {
          this.#sharedCacheMutationTail = Promise.resolve();
        }
      });
    }
  }

  async #runGit(
    layout: WorkspaceLayout,
    guard: WorkspaceGuard,
    diskReservation: WorkspaceDiskReservation,
    commandArguments: readonly string[],
    failurePolicy: "ambiguous_remote" | "deterministic_local" | "node_infrastructure",
    context: WorkspacePreparationContext,
    commandDirectory: string | null = layout.checkoutDirectory,
    validateWorkspaceAfter = true,
    onProcessSuccess?: () => void,
    validationMode: GitWorkspaceValidationMode = "strict",
  ): Promise<ManagedProcessRunResult> {
    throwIfAborted(context.signal);
    await this.#validateGitWorkingDirectory();
    await this.#validateWorkspaceForGit(guard, validationMode);
    throwIfAborted(context.signal);
    context.reportProcessCount(1);
    try {
      // Teardown deliberately removes link targets before the remaining attempt is deleted.
      // Its fixed Git commands retain cleanup guards, managed limits, and shared-cache accounting,
      // but must not require the dismantled attempt tree to remain a valid execution snapshot.
      // The two private source-observation argv identities share their enclosing capture monitor.
      // Workspace guards, managed process limits, and the monitor signal still apply to each Git
      // command, including any repository-configured filter invoked during status observation.
      const observesSource =
        commandArguments === sourceObservationGitArguments.status ||
        commandArguments === sourceObservationGitArguments.head;
      const monitor =
        validationMode === "cleanup_safe" || observesSource
          ? undefined
          : await diskReservation.startMonitoring(context.signal);
      let result: ManagedProcessRunResult | undefined;
      let processError: unknown;
      try {
        result = await this.#processRunner.run(
          {
            executable: this.#gitExecutable,
            arguments: [
              ...gitConfigurationArguments,
              ...(commandDirectory === null ? [] : ["-C", commandDirectory]),
              ...commandArguments,
            ],
            workingDirectory: this.#gitWorkingDirectory,
            environmentMode: "replace",
            environment: {
              ...this.#gitEnvironment,
              TEMP: layout.tempDirectory,
              TMP: layout.tempDirectory,
              USERPROFILE: layout.userProfileDirectory,
            },
            limits: this.#gitLimits,
          },
          { processHost: context.processHost, signal: monitor?.signal ?? context.signal },
        );
        onProcessSuccess?.();
      } catch (error) {
        processError = error;
      }
      try {
        await monitor?.close();
      } catch (error) {
        processError = error;
      }
      if (monitor?.violation !== undefined) {
        throw workspaceDiskLimitError(monitor.violation);
      }
      if (processError !== undefined) throw processError;
      if (result === undefined) {
        throw new Error("Managed Git execution completed without a result.");
      }
      await this.#validateGitWorkingDirectory();
      if (validateWorkspaceAfter) {
        await this.#validateWorkspaceForGit(guard, validationMode);
      }
      throwIfAborted(context.signal);
      return result;
    } catch (error) {
      if (context.signal.aborted) {
        throw new JobWorkspaceError("ABORTED", "Workspace preparation was aborted.", {
          cause: error,
        });
      }
      if (error instanceof WorkspaceDiskBudgetError) {
        throw workspaceDiskLimitError(error);
      }
      if (error instanceof JobWorkspaceError) throw error;
      if (error instanceof ManagedProcessRunError) {
        throw classifyManagedGitFailure(
          error,
          failurePolicy,
          validationMode === "cleanup_safe" ? cleanupGitOperation(commandArguments) : undefined,
        );
      }
      throw new JobWorkspaceError("GIT_COMMAND_FAILED", "A trusted Git command failed.", {
        cause: error,
      });
    } finally {
      context.reportProcessCount(0);
    }
  }

  async #validateWorkspaceForGit(
    guard: WorkspaceGuard,
    validationMode: GitWorkspaceValidationMode,
  ): Promise<void> {
    if (validationMode === "cleanup_safe") {
      await guard.validateForCleanup();
      return;
    }
    await guard.validateAll();
  }

  async #validateGitWorkingDirectory(): Promise<void> {
    const state = await this.#fileSystem.lstat(this.#gitWorkingDirectory);
    if (state === null || state.kind !== "directory" || state.reparsePoint) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "The trusted Git working directory is missing or unsafe.",
      );
    }
    const realPath = await this.#fileSystem.realpath(this.#gitWorkingDirectory);
    if (!sameWindowsPath(realPath, this.#gitWorkingDirectory)) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "The trusted Git working directory resolves through a reparse point.",
      );
    }
    const entries = await this.#fileSystem.readDirectory(this.#gitWorkingDirectory);
    if (entries.length !== 0) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "The trusted Git working directory must remain empty.",
      );
    }
  }

  async #validateGitSharedRootDirectory(): Promise<void> {
    const state = await this.#fileSystem.lstat(this.#gitSharedRootDirectory);
    if (state === null || state.kind !== "directory" || state.reparsePoint) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "The shared Git repository root is missing or unsafe.",
      );
    }
    const realPath = await this.#fileSystem.realpath(this.#gitSharedRootDirectory);
    if (!sameWindowsPath(realPath, this.#gitSharedRootDirectory)) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "The shared Git repository root resolves through a reparse point.",
      );
    }
  }

  async #validateSharedRepositoryDirectory(
    repository: SharedRepositoryLayout,
    required: boolean,
  ): Promise<void> {
    await this.#validateGitSharedRootDirectory();
    const state = await this.#fileSystem.lstat(repository.gitDirectory);
    if (state === null) {
      if (required) {
        throw new JobWorkspaceError(
          "WORKSPACE_PATH_UNSAFE",
          "The shared Git repository directory is missing.",
        );
      }
      return;
    }
    if (state.kind !== "directory" || state.reparsePoint) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "The shared Git repository path must be a non-reparse directory.",
      );
    }
    const realPath = await this.#fileSystem.realpath(repository.gitDirectory);
    if (!sameWindowsPath(realPath, repository.gitDirectory)) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        "The shared Git repository path resolves outside its configured location.",
      );
    }
  }

  #nodeHealthFault(
    message: string,
    cause: unknown,
    reportOnce: (fault: JobWorkspaceError) => JobWorkspaceError,
  ): JobWorkspaceError {
    const fault = new JobWorkspaceError("WORKSPACE_CLEANUP_FAILED", message, { cause });
    return reportOnce(fault);
  }
}

class WorkspaceGuard {
  #rootRealPath: string | undefined;

  public constructor(
    private readonly fileSystem: JobWorkspaceFileSystem,
    private readonly layout: WorkspaceLayout,
  ) {}

  public async validateRoot(): Promise<void> {
    const state = await this.fileSystem.lstat(this.layout.rootDirectory);
    if (state === null || state.kind !== "directory" || state.reparsePoint) {
      throw new JobWorkspaceError(
        "WORKSPACE_ROOT_UNSAFE",
        "Workspace root must be an existing non-reparse directory.",
      );
    }
    const realPath = await this.fileSystem.realpath(this.layout.rootDirectory);
    if (!sameWindowsPath(realPath, this.layout.rootDirectory)) {
      throw new JobWorkspaceError(
        "WORKSPACE_ROOT_UNSAFE",
        "Workspace root realpath differs from its configured path.",
      );
    }
    if (this.#rootRealPath !== undefined && !sameWindowsPath(realPath, this.#rootRealPath)) {
      throw new JobWorkspaceError(
        "WORKSPACE_ROOT_UNSAFE",
        "Workspace root realpath changed during preparation.",
      );
    }
    this.#rootRealPath = realPath;
  }

  public async validateAll(): Promise<void> {
    await this.validateRoot();
    await this.#validateDirectory(this.layout.attemptDirectory, "attempt");
    await this.#validateDirectory(this.layout.checkoutDirectory, "checkout");
    await this.#validateDirectory(this.layout.controlDirectory, "control");
    await this.#validateDirectory(this.layout.codexHomeDirectory, "codex-home");
    await this.#validateDirectory(this.layout.tempDirectory, "temp");
    await this.#validateDirectory(this.layout.userProfileDirectory, "user-profile");
  }

  public async validateForCleanup(): Promise<void> {
    await this.validateRoot();
    await this.#validateDirectory(this.layout.attemptDirectory, "attempt");
    await this.#validateDirectory(this.layout.checkoutDirectory, "checkout", false);
    await this.#validateDirectory(this.layout.controlDirectory, "control");
    await this.#validateDirectory(this.layout.codexHomeDirectory, "codex-home");
    await this.#validateDirectory(this.layout.tempDirectory, "temp");
    await this.#validateDirectory(this.layout.userProfileDirectory, "user-profile");
  }

  public async hasMissingCheckoutDirectory(): Promise<boolean> {
    await this.validateRoot();
    await this.#validateDirectory(this.layout.attemptDirectory, "attempt");
    const exists = await this.#validateDirectory(this.layout.checkoutDirectory, "checkout", false);
    return !exists;
  }

  async #validateDirectory(path: string, label: string, required = true): Promise<boolean> {
    assertStrictDescendant(this.layout.rootDirectory, path, label);
    const state = await this.fileSystem.lstat(path);
    if (state === null) {
      if (!required) {
        return false;
      }
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        `Workspace ${label} path must be a non-reparse directory.`,
      );
    }
    if (state.kind !== "directory" || state.reparsePoint) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        `Workspace ${label} path must be a non-reparse directory.`,
      );
    }
    const realPath = await this.fileSystem.realpath(path);
    if (!sameWindowsPath(realPath, path)) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        `Workspace ${label} realpath changed or escapes its expected location.`,
      );
    }
    return true;
  }
}

async function removeReservedAttempt(reservation: WorkspaceDiskReservation): Promise<void> {
  await reservation.removeAttempt();
}

function deriveSharedRepositoryLayout(
  rootDirectory: string,
  githubRepositoryId: number,
): SharedRepositoryLayout {
  if (!Number.isSafeInteger(githubRepositoryId) || githubRepositoryId < 1) {
    throw new JobWorkspaceError(
      "INVALID_ENVELOPE",
      "GitHub repository identity must be a positive integer.",
    );
  }
  const key = `repository-${githubRepositoryId}`;
  const gitDirectory = win32.join(rootDirectory, `${key}.git`);
  assertStrictDescendant(rootDirectory, gitDirectory, "shared repository");
  return Object.freeze({ key, gitDirectory });
}

interface WorkspaceSource {
  readonly baseSha: string;
  readonly headSha: string;
  readonly pullRequestNumber: number | null;
  readonly fetchHead: "pull_request_ref" | "exact_commit";
}

function workspaceSource(envelope: JobExecutionEnvelope): WorkspaceSource | null {
  if ("validation" in envelope && hasEvaluationWorkspaceMarker(envelope.validation))
    return evaluationWorkspaceSource(envelope);
  if (envelope.resource.kind === "pull_request") {
    const resource = envelope.resource;
    if (!Number.isSafeInteger(resource.number) || resource.number < 1)
      throw new TypeError("The PR number is invalid.");
    if (envelope.envelopeVersion === 2) {
      const source = envelope.validation.testedSourceRevision;
      if (
        source?.kind !== "pull_request" ||
        source.baseSha !== resource.baseSha ||
        source.headSha !== resource.headSha ||
        envelope.validation.testedSourceAuthorization !== null ||
        envelope.validation.revisionKey !==
          createHash("sha256").update(`${resource.baseSha}\0${resource.headSha}`).digest("hex")
      ) {
        throw new TypeError("The validation plan does not authorize this exact PR source.");
      }
    }
    return {
      baseSha: resource.baseSha,
      headSha: resource.headSha,
      pullRequestNumber: resource.number,
      fetchHead: "pull_request_ref",
    };
  }
  if (envelope.envelopeVersion === 1 || envelope.validation.workflowKind === "issue_triage")
    return null;
  const validation = envelope.validation;
  const source = validation.testedSourceRevision;
  const authorization = validation.testedSourceAuthorization;
  const snapshot = envelope.resource.canonicalSnapshot;
  if (
    validation.workflowKind !== "issue_validation" ||
    source?.kind !== "commit" ||
    !authorization ||
    !Value.Check(ReviewRunTestedSourceAuthorizationSchema, authorization) ||
    !Value.Check(GitHubIssueSchema, snapshot) ||
    authorization.kind !== "operator" ||
    authorization.activationId !== validation.activationId ||
    authorization.headSha !== source.headSha ||
    authorization.githubRepositoryId !== envelope.repository.githubRepositoryId ||
    authorization.githubWorkItemId !== snapshot.githubWorkItemId ||
    snapshot.githubRepositoryId !== envelope.repository.githubRepositoryId ||
    snapshot.number !== envelope.resource.number ||
    snapshot.githubNodeId !== envelope.resource.githubNodeId ||
    authorization.issueRevisionKey !== envelope.resource.revisionDigest ||
    validation.revisionKey !== envelope.resource.revisionDigest
  ) {
    throw new TypeError(
      "Issue reproduction requires explicit authorization for this exact source commit.",
    );
  }
  const headSha = validateGitObjectId(source.headSha, "headSha");
  return { baseSha: headSha, headSha, pullRequestNumber: null, fetchHead: "exact_commit" };
}

function hasEvaluationWorkspaceMarker(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return (
    context.schemaVersion === "ValidationJobContextV2" ||
    (context.purpose !== null &&
      typeof context.purpose === "object" &&
      !Array.isArray(context.purpose) &&
      (context.purpose as Record<string, unknown>).kind === "evaluation")
  );
}

/** Validates frozen-source preparation; executor readiness and model authority remain separate. */
function evaluationWorkspaceSource(envelope: JobExecutionEnvelope): WorkspaceSource | null {
  if (
    !Value.Check(JobExecutionEnvelopeV2Schema, envelope) ||
    envelope.envelopeVersion !== 2 ||
    envelope.validation.schemaVersion !== "ValidationJobContextV2" ||
    getEvaluationValidationJobContextIssues(envelope.validation).length > 0
  )
    throw new TypeError(
      "The evaluation workspace requires its complete frozen source and operator authority.",
    );
  const context = envelope.validation;
  const frozenCommit = (value: string, label: string): string => {
    if (value.length !== 40 && value.length !== 64)
      throw new TypeError("The frozen evaluation commit must be an exact Git object ID.");
    return validateGitObjectId(value, label);
  };
  const source = context.source;
  const item = source.workItem;
  const revision = source.revision;
  const sourceDigest = createCanonicalResult({
    repository: source.repository,
    workItemId: source.workItemId,
    workItem: item,
    revision,
    testedSourceRevision: source.testedSourceRevision,
    revisionId: source.revisionId,
  }).sha256;
  const revisionKey = createHash("sha256")
    .update(
      revision.kind === "pull_request"
        ? `${revision.baseSha}\0${revision.headSha}`
        : JSON.stringify([item.title, item.body, item.state, item.updatedAt]),
    )
    .digest("hex");
  const commonResource = {
    githubNodeId: item.githubNodeId,
    number: item.number,
    title: item.title,
    author: item.author,
    canonicalSnapshot: item,
  };
  const resource =
    item.kind === "pull_request" && revision.kind === "pull_request"
      ? {
          ...commonResource,
          kind: "pull_request",
          baseSha: revision.baseSha,
          headSha: revision.headSha,
          isDraft: item.isDraft,
        }
      : { ...commonResource, kind: "issue", revisionDigest: revision.revisionKey };
  const labels = envelope.executionPolicy.requiredCapabilityLabels;
  if (
    sourceDigest !== source.sourceDigest ||
    revisionKey !== revision.revisionKey ||
    (revision.kind === "issue" && revision.contentDigest !== revisionKey) ||
    createCanonicalResult(envelope.repository).json !==
      createCanonicalResult({
        githubRepositoryId: source.repository.githubRepositoryId,
        fullName: source.repository.fullName,
      }).json ||
    createCanonicalResult(envelope.resource).json !== createCanonicalResult(resource).json ||
    envelope.job.jobId !== envelope.lease.jobId ||
    envelope.job.kind !== (item.kind === "pull_request" ? "pull_request_review" : "issue_triage") ||
    createCanonicalResult(context.profileVersion.config).sha256 !==
      context.profileVersion.configSha256 ||
    envelope.executionPolicy.hardTimeoutMs !== context.profileVersion.config.hardTimeoutMs ||
    envelope.executionPolicy.noProgressTimeoutMs !==
      context.profileVersion.config.noProgressTimeoutMs ||
    envelope.executionPolicy.allowedRecipeIds.length !== 0 ||
    labels[evaluationExecutionCapabilityLabel] !== "1" ||
    labels[validationExecutorCapabilityLabels.envelope] !== "2" ||
    labels[validationExecutorCapabilityLabels[context.target]] !== "1" ||
    envelope.prompt.name !== context.promptVersion.templateId ||
    envelope.prompt.version !== String(context.promptVersion.version) ||
    !envelope.prompt.renderedPrompt.isWellFormed() ||
    Buffer.byteLength(envelope.prompt.renderedPrompt, "utf8") > maximumRenderedPromptUtf8Bytes ||
    createHash("sha256").update(envelope.prompt.renderedPrompt, "utf8").digest("hex") !==
      envelope.prompt.promptSha256 ||
    createCanonicalResult(envelope.prompt.outputSchema).sha256 !==
      envelope.prompt.outputSchemaSha256
  )
    throw new TypeError(
      "The evaluation workspace identity differs from its frozen source or request.",
    );
  if (revision.kind === "pull_request")
    return {
      baseSha: frozenCommit(revision.baseSha, "baseSha"),
      headSha: frozenCommit(revision.headSha, "headSha"),
      pullRequestNumber: item.number,
      fetchHead: "exact_commit",
    };
  if (context.workflowKind === "issue_triage") return null;
  const tested = context.testedSourceRevision;
  if (tested?.kind !== "commit")
    throw new TypeError("The evaluation workspace requires its explicitly selected Issue commit.");
  const headSha = frozenCommit(tested.headSha, "headSha");
  return { baseSha: headSha, headSha, pullRequestNumber: null, fetchHead: "exact_commit" };
}

function deriveWorkspaceLayout(
  rootDirectory: string,
  runAttemptId: string,
  purpose: "validation" | "model" = "validation",
): WorkspaceLayout {
  if (
    typeof runAttemptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runAttemptId)
  ) {
    throw new TypeError("runAttemptId is invalid.");
  }
  if (purpose !== "validation" && purpose !== "model")
    throw new TypeError("Workspace purpose is invalid.");
  const identity = purpose === "model" ? `${runAttemptId}\0model` : runAttemptId;
  const attemptName = `attempt-${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  const attemptDirectory = win32.join(rootDirectory, attemptName);
  const checkoutDirectory = win32.join(attemptDirectory, "checkout");
  const controlDirectory = win32.join(attemptDirectory, "control");
  const codexHomeDirectory = win32.join(attemptDirectory, "codex-home");
  const tempDirectory = win32.join(attemptDirectory, "temp");
  const userProfileDirectory = win32.join(attemptDirectory, "user-profile");
  const layout = {
    rootDirectory,
    attemptDirectory,
    checkoutDirectory,
    controlDirectory,
    codexHomeDirectory,
    tempDirectory,
    userProfileDirectory,
  };

  assertStrictDescendant(rootDirectory, attemptDirectory, "attempt");
  const siblings = [
    checkoutDirectory,
    controlDirectory,
    codexHomeDirectory,
    tempDirectory,
    userProfileDirectory,
  ];
  if (new Set(siblings.map(comparableWindowsPath)).size !== siblings.length) {
    throw new Error("Workspace sibling directories overlap.");
  }
  for (const path of siblings) {
    assertWindowsLocalAbsolutePath(path, "workspace child path", false);
    if (!sameWindowsPath(win32.dirname(path), attemptDirectory)) {
      throw new Error("Workspace child path is not a direct child of the attempt directory.");
    }
  }
  return Object.freeze(layout);
}

function buildGitEnvironment(
  configured: Readonly<Record<string, string>>,
  workspaceRootDirectory: string,
  gitInstallationDirectory: string,
): Readonly<Record<string, string>> {
  const entries = Object.entries(configured);
  if (entries.length > 8) {
    throw new RangeError("gitEnvironment must contain at most eight allowlisted entries.");
  }
  const names = new Set<string>();
  const enforcedNames = new Set(
    Object.keys(enforcedGitEnvironment).map((name) => name.toUpperCase()),
  );
  const result: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)) {
      throw new TypeError(`gitEnvironment contains invalid name ${JSON.stringify(name)}.`);
    }
    const folded = name.toUpperCase();
    if (names.has(folded)) {
      throw new TypeError("gitEnvironment contains case-insensitive duplicate names.");
    }
    names.add(folded);
    if (!allowedGitEnvironmentNames.has(folded)) {
      throw new TypeError(`gitEnvironment name ${name} is not allowlisted.`);
    }
    if (forbiddenGitEnvironmentName.test(name)) {
      throw new TypeError(`gitEnvironment may not configure ${name}.`);
    }
    if (typeof value !== "string" || value.includes("\0") || value.length > 32_767) {
      throw new TypeError(`gitEnvironment value ${name} is invalid.`);
    }
    assertWellFormedUnicode(value, `gitEnvironment value ${name}`);
    if (!enforcedNames.has(folded)) {
      result[folded] = normalizeGitEnvironmentValue(
        folded,
        value,
        workspaceRootDirectory,
        gitInstallationDirectory,
      );
    }
  }
  for (const name of requiredGitEnvironmentNames) {
    if (!names.has(name)) {
      throw new TypeError(`gitEnvironment must define ${name}.`);
    }
  }
  Object.assign(result, enforcedGitEnvironment);
  return Object.freeze(result);
}

function normalizeGitEnvironmentValue(
  name: string,
  value: string,
  workspaceRootDirectory: string,
  gitInstallationDirectory: string,
): string {
  if (name === "PATH") {
    const entries = value.split(";");
    if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
      throw new TypeError("gitEnvironment PATH must contain non-empty path entries.");
    }
    const normalizedEntries = entries.map((entry, index) =>
      normalizeSafeEnvironmentPath(
        entry,
        `gitEnvironment PATH[${index}]`,
        false,
        workspaceRootDirectory,
        gitInstallationDirectory,
      ),
    );
    if (new Set(normalizedEntries.map(comparableWindowsPath)).size !== normalizedEntries.length) {
      throw new TypeError("gitEnvironment PATH must not contain duplicate entries.");
    }
    return normalizedEntries.join(";");
  }
  if (name === "PATHEXT") {
    const extensions = value.split(";");
    if (
      extensions.length === 0 ||
      extensions.some((extension) => !/^\.[A-Za-z0-9]+$/u.test(extension)) ||
      new Set(extensions.map((extension) => extension.toUpperCase())).size !== extensions.length
    ) {
      throw new TypeError("gitEnvironment PATHEXT must contain unique file extensions.");
    }
    return extensions.map((extension) => extension.toUpperCase()).join(";");
  }
  if (name === "COMSPEC") {
    return normalizeSafeEnvironmentPath(
      value,
      "gitEnvironment COMSPEC",
      true,
      workspaceRootDirectory,
      gitInstallationDirectory,
    );
  }
  if (directoryGitEnvironmentNames.has(name)) {
    return normalizeSafeEnvironmentPath(
      value,
      `gitEnvironment ${name}`,
      false,
      workspaceRootDirectory,
      gitInstallationDirectory,
    );
  }
  throw new TypeError(`gitEnvironment value ${name} has no validation policy.`);
}

function normalizeSafeEnvironmentPath(
  value: string,
  name: string,
  requireExecutable: boolean,
  workspaceRootDirectory: string,
  gitInstallationDirectory: string,
): string {
  assertWindowsLocalAbsolutePath(value, name, requireExecutable);
  const normalized = requireExecutable ? win32.normalize(value) : normalizeDirectory(value);
  if (
    windowsPathsOverlap(normalized, workspaceRootDirectory) ||
    windowsPathsOverlap(normalized, gitInstallationDirectory)
  ) {
    throw new TypeError(`${name} must not overlap workspaceRootDirectory or the Git installation.`);
  }
  return normalized;
}

function copyAndValidateLimits(limits: ProcessResourceLimits): ProcessResourceLimits {
  const fields = Object.keys(processHostResourceBounds) as Array<keyof ProcessResourceLimits>;
  for (const field of fields) {
    const value = limits[field];
    const bounds = processHostResourceBounds[field];
    if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
      throw new RangeError(
        `gitLimits.${field} must be an integer from ${bounds.minimum} through ${bounds.maximum}.`,
      );
    }
  }
  return Object.freeze({
    hardTimeoutMs: limits.hardTimeoutMs,
    maximumProcessCount: limits.maximumProcessCount,
    maximumMemoryBytes: limits.maximumMemoryBytes,
    maximumOutputBytes: limits.maximumOutputBytes,
  });
}

function copyAndValidateGitSharedCachePolicy(policy: GitSharedCachePolicy): GitSharedCachePolicy {
  const maximumTotalBytes = assertPositiveBigInt(policy.maximumTotalBytes, "maximumTotalBytes");
  const minimumFreeBytes = assertNonNegativeBigInt(policy.minimumFreeBytes, "minimumFreeBytes");
  const maximumScanEntries = assertBoundedSafeInteger(
    policy.maximumScanEntries,
    "maximumScanEntries",
    1,
    maximumSharedGitScanEntries,
  );
  const maximumScanDurationMs = assertBoundedSafeInteger(
    policy.maximumScanDurationMs,
    "maximumScanDurationMs",
    100,
    maximumSharedGitScanDurationMs,
  );
  const gcMinimumIntervalMs = assertBoundedSafeInteger(
    policy.gcMinimumIntervalMs,
    "gcMinimumIntervalMs",
    0,
    7 * 24 * 60 * 60 * 1_000,
  );
  const gcPruneAgeHours = assertBoundedSafeInteger(
    policy.gcPruneAgeHours,
    "gcPruneAgeHours",
    1,
    maximumSharedGitGcPruneAgeHours,
  );
  return Object.freeze({
    maximumTotalBytes,
    minimumFreeBytes,
    maximumScanEntries,
    maximumScanDurationMs,
    gcMinimumIntervalMs,
    gcPruneAgeHours,
  });
}

function assertPositiveBigInt(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new RangeError(`${name} must be a positive bigint.`);
  }
  return value;
}

function assertNonNegativeBigInt(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError(`${name} must be a non-negative bigint.`);
  }
  return value;
}

function assertBoundedSafeInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function createSharedCacheLimitError(
  policy: GitSharedCachePolicy,
  scan: SharedCacheScanSummary,
  options: {
    readonly phase: "before_fetch" | "after_fetch" | "post_cleanup";
    readonly gcOutcome: SharedCacheGcOutcome;
    readonly includeFreeSpaceReason: boolean;
  },
): JobWorkspaceError {
  const reasons: string[] = [];
  if (scan.totalBytes > policy.maximumTotalBytes) {
    reasons.push(
      `shared cache size ${formatBytes(scan.totalBytes)} exceeds hard limit ${formatBytes(policy.maximumTotalBytes)}`,
    );
  }
  if (options.includeFreeSpaceReason && scan.availableBytes < policy.minimumFreeBytes) {
    reasons.push(
      `free disk ${formatBytes(scan.availableBytes)} is below guard ${formatBytes(policy.minimumFreeBytes)}`,
    );
  }
  const gcStatus = options.gcOutcome.ran
    ? "gc_ran"
    : options.gcOutcome.skipReason === "active_worktree"
      ? "gc_skipped_active_worktree"
      : options.gcOutcome.skipReason === "minimum_interval"
        ? "gc_skipped_minimum_interval"
        : "gc_not_run";
  const reasonText = reasons.length === 0 ? "shared cache policy violation" : reasons.join("; ");
  return new JobWorkspaceError(
    "GIT_SHARED_CACHE_LIMIT_EXCEEDED",
    `Shared Git cache budget check failed (${options.phase}, ${gcStatus}): ${reasonText}.`,
  );
}

function formatBytes(value: bigint): string {
  return `${value.toString()}B`;
}

function isSharedCacheBudgetSatisfied(
  status: SharedCacheBudgetStatus,
  phase: "before_fetch" | "after_fetch" | "post_cleanup",
): boolean {
  if (!status.totalWithinLimit) {
    return false;
  }
  if (phase === "post_cleanup") {
    return true;
  }
  return status.freeSpaceWithinLimit;
}

function collapseCleanupErrors(errors: readonly unknown[]): unknown {
  if (errors.length === 0) {
    return new Error("cleanup failure without captured cause");
  }
  if (errors.length === 1) {
    return errors[0];
  }
  return new AggregateError(errors, "multiple cleanup operations failed");
}

function assertUniqueSafeDirectoryEntries(entries: readonly string[], owner: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      entry.length === 0 ||
      entry === "." ||
      entry === ".." ||
      entry.includes("\\") ||
      entry.includes("/") ||
      entry.includes("\0")
    ) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        `${owner} enumeration returned an unsafe directory entry name.`,
      );
    }
    const folded = entry.toLowerCase();
    if (seen.has(folded)) {
      throw new JobWorkspaceError(
        "WORKSPACE_PATH_UNSAFE",
        `${owner} enumeration returned duplicate directory entry names.`,
      );
    }
    seen.add(folded);
  }
}

function buildAnonymousGitHubUrl(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2) {
    throw new JobWorkspaceError("INVALID_ENVELOPE", "Repository name must be owner/repository.");
  }
  const [owner, repository] = parts;
  if (
    owner === undefined ||
    repository === undefined ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(repository) ||
    repository === "." ||
    repository === ".." ||
    repository.toLowerCase().endsWith(".git")
  ) {
    throw new JobWorkspaceError("INVALID_ENVELOPE", "Repository owner/name is unsafe.");
  }
  return `https://github.com/${owner}/${repository}.git`;
}

function validateGitObjectId(value: string, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) {
    throw new JobWorkspaceError("INVALID_ENVELOPE", `${name} is not a canonical Git object ID.`);
  }
  return value;
}

function assertExactGitObjectId(output: string, expected: string, name: string): void {
  assertExactGitOutput(output, expected, `${name} revision`);
}

function assertGitObjectIdList(output: string, name: string): void {
  const objectIds = output.trim().split(/\r?\n/u).filter(Boolean);
  if (
    objectIds.length === 0 ||
    objectIds.some((objectId) => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(objectId))
  ) {
    throw new JobWorkspaceError(
      "GIT_LOCAL_OR_REVISION_FAILED",
      `Git ${name} is missing or invalid for the requested revision.`,
    );
  }
}

function assertExactGitOutput(output: string, expected: string, name: string): void {
  if (output === `${expected}\n` || output === `${expected}\r\n`) return;
  throw new JobWorkspaceError(
    "GIT_REVISION_MISMATCH",
    `Git ${name} did not match the immutable job envelope.`,
  );
}

function normalizeDirectory(path: string): string {
  const normalized = win32.normalize(path);
  const parsed = win32.parse(normalized);
  return normalized.toLowerCase() === parsed.root.toLowerCase()
    ? parsed.root
    : normalized.replace(/[\\/]+$/u, "");
}

function comparableWindowsPath(path: string): string {
  return normalizeDirectory(path).toLowerCase();
}

function sameWindowsPath(left: string, right: string): boolean {
  return comparableWindowsPath(left) === comparableWindowsPath(right);
}

function assertStrictDescendant(parent: string, candidate: string, name: string): void {
  const relative = win32.relative(parent, candidate);
  if (
    relative.length === 0 ||
    win32.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${win32.sep}`)
  ) {
    throw new JobWorkspaceError(
      "WORKSPACE_PATH_UNSAFE",
      `Workspace ${name} path escapes its root.`,
    );
  }
}

function windowsPathsOverlap(left: string, right: string): boolean {
  if (sameWindowsPath(left, right)) return true;
  return isStrictWindowsDescendant(left, right) || isStrictWindowsDescendant(right, left);
}

function assertWellFormedUnicode(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${name} must contain well-formed Unicode.`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${name} must contain well-formed Unicode.`);
    }
  }
}

function isStrictWindowsDescendant(parent: string, candidate: string): boolean {
  const relative = win32.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !win32.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${win32.sep}`)
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new JobWorkspaceError("ABORTED", "Workspace preparation was aborted.", {
    cause: signal.reason,
  });
}

async function waitForRepositoryTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(
        new JobWorkspaceError("ABORTED", "Workspace preparation was aborted.", {
          cause: signal.reason,
        }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
    );
  });
}

function reportHealthFaultSafely(
  reporter: (error: JobWorkspaceError) => void,
  fault: JobWorkspaceError,
): JobWorkspaceError {
  try {
    reporter(fault);
    return fault;
  } catch (reportError) {
    return new JobWorkspaceError(fault.code, fault.message, {
      cause: new AggregateError([fault, reportError]),
    });
  }
}

function isNodeInfrastructureFailure(code: JobWorkspaceFailureCode): boolean {
  return !(
    code === "ABORTED" ||
    code === "INVALID_ENVELOPE" ||
    code === "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED" ||
    code === "WORKSPACE_DISK_CAPACITY_UNAVAILABLE" ||
    code === "GIT_COMMAND_FAILED" ||
    code === "GIT_LOCAL_OR_REVISION_FAILED" ||
    code === "GIT_POLICY_LIMIT_EXCEEDED" ||
    code === "GIT_REVISION_MISMATCH"
  );
}

function workspaceDiskAdmissionError(error: WorkspaceDiskBudgetError): JobWorkspaceError {
  if (error.code === "ABORTED") {
    return new JobWorkspaceError("ABORTED", "Workspace disk admission was aborted.", {
      cause: error,
    });
  }
  if (error.code === "ATTEMPT_ALREADY_EXISTS") {
    return new JobWorkspaceError(
      "ATTEMPT_ALREADY_EXISTS",
      "The disposable attempt already exists in the workspace disk ledger.",
      { cause: error },
    );
  }
  if (error.code === "WORKSPACE_ROOT_UNSAFE") {
    return new JobWorkspaceError("WORKSPACE_ROOT_UNSAFE", error.message, { cause: error });
  }
  if (error.code === "WORKSPACE_PATH_UNSAFE") {
    return new JobWorkspaceError("WORKSPACE_PATH_UNSAFE", error.message, { cause: error });
  }
  if (error.code === "INVALID_CONFIGURATION" || error.code === "INVALID_ATTEMPT_PATH") {
    return new JobWorkspaceError("INVALID_CONFIGURATION", error.message, { cause: error });
  }
  return workspaceDiskLimitError(error);
}

function classifyManagedGitFailure(
  error: ManagedProcessRunError,
  failurePolicy: "ambiguous_remote" | "deterministic_local" | "node_infrastructure",
  cleanupOperation?: string,
): JobWorkspaceError {
  if (error.code === "OUTPUT_TRUNCATED" || error.code === "INVALID_UTF8_OUTPUT") {
    return new JobWorkspaceError(
      "GIT_POLICY_LIMIT_EXCEEDED",
      "Git output violated a deterministic Worker policy limit.",
      { cause: error },
    );
  }
  if (error.code === "NON_ZERO_EXIT") {
    const diagnostic =
      cleanupOperation === undefined
        ? ""
        : ` Git ${cleanupOperation} exited with code ${error.exitCode ?? "unknown"}; stderr: ${summarizeGitCleanupStderr(error.stderr)}`;
    if (failurePolicy === "node_infrastructure") {
      return new JobWorkspaceError(
        "GIT_INFRASTRUCTURE_FAILED",
        `Git could not initialize the trusted local workspace.${diagnostic}`,
        { cause: error },
      );
    }
    if (failurePolicy === "deterministic_local") {
      return new JobWorkspaceError(
        "GIT_LOCAL_OR_REVISION_FAILED",
        `A deterministic local Git or fetched-revision operation failed.${diagnostic}`,
        { cause: error },
      );
    }
    // Git combines remote, network, and ref failures behind one exit code. Retry remains bounded by
    // the trusted job max-attempt policy, after which the Server dead-letters the job for review.
    return new JobWorkspaceError(
      "GIT_COMMAND_FAILED",
      `Git returned a non-zero exit whose source cannot be classified safely.${diagnostic}`,
      { cause: error },
    );
  }
  return new JobWorkspaceError(
    "GIT_INFRASTRUCTURE_FAILED",
    "The managed Git process failed because Worker infrastructure was unavailable.",
    { cause: error },
  );
}

function cleanupGitOperation(argumentsList: readonly string[]): string {
  if (argumentsList.includes("worktree")) {
    if (argumentsList.includes("remove")) return "worktree remove";
    return argumentsList.includes("list") ? "worktree list" : "worktree prune";
  }
  if (argumentsList.includes("reflog")) return "reflog expire";
  if (argumentsList.includes("gc")) return "gc";
  return "cleanup";
}

function assertWorktreeRegistrationMissing(
  output: string,
  repositoryDirectory: string,
  checkoutDirectory: string,
): void {
  const fail = (): never => {
    throw new JobWorkspaceError(
      "GIT_LOCAL_OR_REVISION_FAILED",
      "Git did not confirm that the removed checkout registration is absent.",
    );
  };
  if (!output.endsWith("\0\0")) fail();
  let repositoryPresent = false;
  const seen = new Set<string>();
  for (const record of output.slice(0, -2).split("\0\0")) {
    const fields = record.split("\0");
    const firstField = fields[0] ?? "";
    if (!firstField.startsWith("worktree ")) fail();
    if (
      fields
        .slice(1)
        .some(
          (field) =>
            !/^(?:bare|HEAD [a-f0-9]{40}(?:[a-f0-9]{24})?|branch refs\/[^\r\n]+|detached|locked(?: [^\r\n]*)?|prunable(?: [^\r\n]*)?)$/u.test(
              field,
            ),
        )
    ) {
      fail();
    }
    const path = firstField.slice("worktree ".length);
    try {
      assertWindowsLocalAbsolutePath(path, "Git worktree registration", false);
    } catch {
      fail();
    }
    const identity = comparableWindowsPath(path);
    if (seen.has(identity) || sameWindowsPath(path, checkoutDirectory)) fail();
    seen.add(identity);
    if (sameWindowsPath(path, repositoryDirectory)) {
      if (fields.filter((field) => field === "bare").length !== 1) fail();
      repositoryPresent = true;
    }
  }
  if (!repositoryPresent) fail();
}

function summarizeGitCleanupStderr(stderr: string): string {
  // The managed runner already bounds its capture. Redact before truncation so a credential
  // spanning the output boundary cannot leave a partial secret in the operator-visible message.
  const summary = stderr
    .replace(gitCleanupAnsiPattern, "")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/giu,
      "[REDACTED]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/giu, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/"'<>]*@/giu, "$1[REDACTED]@")
    .replace(
      /([?&][^\s&=]*(?:token|key|secret|password|credential|signature)[^\s&=]*=)[^\s&"'<>]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/gu,
      "[REDACTED]",
    )
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      "[REDACTED]",
    )
    .replace(gitLogControlPattern, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (summary.length === 0) return "[empty]";
  return summary.length <= maximumGitCleanupStderrCharacters
    ? summary
    : `${summary.slice(0, maximumGitCleanupStderrCharacters - 14).toWellFormed()}...[truncated]`;
}

function workspaceDiskLimitError(error: WorkspaceDiskBudgetError): JobWorkspaceError {
  if (error.code === "ABORTED") {
    return new JobWorkspaceError("ABORTED", "Workspace disk monitoring was aborted.", {
      cause: error,
    });
  }
  if (error.code === "CURRENT_ATTEMPT_LIMIT_EXCEEDED") {
    return new JobWorkspaceError(
      "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED",
      "The attempt exceeded its configured workspace disk budget.",
      { cause: error },
    );
  }
  if (
    error.code === "CAPACITY_UNAVAILABLE" ||
    error.code === "ACCOUNTING_BUSY" ||
    error.code === "INSUFFICIENT_FREE_SPACE"
  ) {
    return new JobWorkspaceError(
      "WORKSPACE_DISK_CAPACITY_UNAVAILABLE",
      "Workspace disk capacity is temporarily unavailable.",
      { cause: error },
    );
  }
  if (
    error.code === "EXISTING_WORKSPACE_UNHEALTHY" ||
    error.code === "SNAPSHOT_UNSTABLE" ||
    error.code === "ACCOUNTING_FAILED" ||
    error.code === "ACCOUNTING_TIMED_OUT" ||
    error.code === "EXCLUSIVE_WORKSPACE_OWNERSHIP_LOST" ||
    error.code === "NATIVE_SECURITY_ADAPTER_FAILED"
  ) {
    return new JobWorkspaceError(
      "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE",
      "Workspace disk infrastructure became unavailable during workspace execution.",
      { cause: error },
    );
  }
  return new JobWorkspaceError(
    "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE",
    "Workspace disk safety or node infrastructure checks stopped workspace execution.",
    { cause: error },
  );
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === code
  );
}
