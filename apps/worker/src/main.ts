import { mkdir, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import process from "node:process";
import { loadWorkerConfig } from "./config.js";
import { loadCodexProviderProfile } from "./execution/codex-provider-profile.js";
import {
  type JobExecutor,
  PlaceholderJobExecutor,
  ReviewJobExecutor,
} from "./execution/job-executor.js";
import { ProductionDisposableJobWorkspaceProvider } from "./execution/job-workspace.js";
import { verifyPersistentCodexHome } from "./execution/persistent-codex-home.js";
import {
  deriveWorkerProcessHostInstanceKey,
  StdioProcessHostClient,
} from "./execution/process-host-client.js";
import {
  type ProcessHostClient,
  UnavailableProcessHostClient,
} from "./execution/process-host-protocol.js";
import { verifyTrustedExecutionBinaries } from "./execution/trusted-binary.js";
import { ProductionWorkspaceDiskBudget } from "./execution/workspace-disk-budget.js";
import { ConsoleJsonLogger } from "./logging/logger.js";
import { WorkerApiError } from "./server-client/errors.js";
import { HttpWorkerApi } from "./server-client/http-worker-api.js";
import { WorkerService } from "./worker-service.js";

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Agentic Review Worker can run only on Windows.");
  }

  const config = loadWorkerConfig();
  await mkdir(config.dataDirectory, { recursive: true });
  const logger = new ConsoleJsonLogger(config.logLevel, {
    component: "worker",
    workerNodeId: config.workerNodeId,
  });
  const api = new HttpWorkerApi(config, logger);
  const runtime = await createExecutionRuntime(config, logger);
  const { processHost, executor } = runtime;
  const service = new WorkerService(config, api, executor, processHost, logger);
  let shutdownRequested = false;

  const requestShutdown = (signal: string): void => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    logger.info("Operating system requested worker shutdown.", { signal });
    void service.stop(`signal:${signal}`).catch((error: unknown) => {
      logger.error("Worker shutdown failed.", { error });
      process.exitCode = 1;
    });
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.once(signal, () => requestShutdown(signal));
  }

  try {
    await service.run();
  } catch (error) {
    if (shutdownRequested) {
      await service.stop("operating_system_shutdown");
      return;
    }
    if (error instanceof WorkerApiError && error.isWorkerInstanceSuperseded) {
      logger.warn("Worker stopped because a newer process instance owns this node.");
      await service.stop("instance_superseded");
      return;
    }
    logger.error("Worker stopped because of an unrecoverable error.", { error });
    process.exitCode = 1;
    await service.stop("fatal_error").catch((shutdownError: unknown) => {
      logger.error("Cleanup after fatal error failed.", { error: shutdownError });
    });
  }
}

async function createExecutionRuntime(
  config: ReturnType<typeof loadWorkerConfig>,
  logger: ConsoleJsonLogger,
): Promise<{ readonly processHost: ProcessHostClient; readonly executor: JobExecutor }> {
  if (!config.executionEnabled) {
    return {
      processHost: new UnavailableProcessHostClient(),
      executor: new PlaceholderJobExecutor(),
    };
  }
  const execution = config.execution;
  if (execution === undefined) {
    throw new Error("Execution is enabled without an execution configuration.");
  }
  const dataDirectoryIdentity = await realpath(config.dataDirectory);

  const gitWorkingDirectory = win32.join(config.dataDirectory, "GitRuntime");
  await Promise.all([
    mkdir(execution.gitSharedRootDirectory, { recursive: true }),
    mkdir(execution.workspaceRootDirectory, { recursive: true }),
    mkdir(execution.tempDirectory, { recursive: true }),
    mkdir(execution.profileDirectory, { recursive: true }),
    mkdir(gitWorkingDirectory, { recursive: true }),
  ]);
  const codexHomeDirectory = await verifyPersistentCodexHome({
    profileDirectory: execution.profileDirectory,
    workspaceRootDirectory: execution.workspaceRootDirectory,
    tempDirectory: execution.tempDirectory,
    gitSharedRootDirectory: execution.gitSharedRootDirectory,
    gitWorkingDirectory,
    trustedExecutableRoot: execution.trustedExecutableRoot,
  });
  const codexProfile = await loadCodexProviderProfile(codexHomeDirectory);

  const binaries = await verifyTrustedExecutionBinaries({
    trustedExecutableRoot: execution.trustedExecutableRoot,
    processHost: {
      path: execution.processHostPath,
      expectedSha256: execution.processHostSha256,
    },
    codex: { path: execution.codexExecutablePath, expectedSha256: execution.codexSha256 },
    git: { path: execution.gitExecutablePath, expectedSha256: execution.gitSha256 },
  });
  const systemRoot = requiredEnvironment("SYSTEMROOT");
  const comSpec = requiredEnvironment("COMSPEC");
  const path = requiredEnvironment("PATH");
  const pathExt = requiredEnvironment("PATHEXT");
  const processHost = await StdioProcessHostClient.create({
    processHostPath: binaries.processHostPath,
    instanceKey: deriveWorkerProcessHostInstanceKey({
      dataDirectory: dataDirectoryIdentity,
    }),
    maximumConcurrentRequests: Math.max(1, config.maxSlots * 2),
    requestTimeoutMs: execution.processHostRequestTimeoutMs,
    startTimeoutMs: execution.processHostStartTimeoutMs,
    shutdownTimeoutMs: execution.processHostShutdownTimeoutMs,
  });
  try {
    const diskBudget = new ProductionWorkspaceDiskBudget({
      workspaceRootDirectory: execution.workspaceRootDirectory,
      perAttemptDiskBytes: BigInt(execution.perAttemptDiskBytes),
      totalWorkspaceDiskBytes: BigInt(execution.totalWorkspaceDiskBytes),
      minimumFreeDiskBytes: BigInt(execution.minimumFreeDiskBytes),
      maximumAccountingEntries: execution.diskScanEntryLimit,
      maximumScanDurationMilliseconds: execution.diskScanTimeoutMs,
      orphanRetentionMilliseconds: BigInt(execution.orphanRetentionHours) * 60n * 60n * 1_000n,
      orphanScanLimit: execution.orphanScanLimit,
    });
    const orphanSweep = await diskBudget.sweepOrphans();
    logger.info("Worker workspace startup sweep completed.", {
      ...orphanSweep,
      removedBytes: orphanSweep.removedBytes?.toString() ?? null,
    });
    const workspaceProvider = new ProductionDisposableJobWorkspaceProvider({
      workspaceRootDirectory: execution.workspaceRootDirectory,
      gitSharedRootDirectory: execution.gitSharedRootDirectory,
      gitExecutable: binaries.gitPath,
      gitWorkingDirectory,
      gitEnvironment: { SYSTEMROOT: systemRoot, COMSPEC: comSpec, PATH: path, PATHEXT: pathExt },
      gitLimits: {
        hardTimeoutMs: execution.gitHardTimeoutMs,
        maximumProcessCount: execution.gitResourceLimits.maximumProcessCount,
        maximumMemoryBytes: execution.gitResourceLimits.maximumMemoryBytes,
        maximumOutputBytes: execution.gitResourceLimits.maximumOutputBytes,
      },
      gitSharedCachePolicy: {
        maximumTotalBytes: BigInt(execution.gitSharedCacheMaxBytes),
        minimumFreeBytes: BigInt(execution.gitSharedMinimumFreeDiskBytes),
        maximumScanEntries: execution.gitSharedScanEntryLimit,
        maximumScanDurationMs: execution.gitSharedScanTimeoutMs,
        gcMinimumIntervalMs: execution.gitSharedGcMinimumIntervalMinutes * 60_000,
        gcPruneAgeHours: execution.gitSharedGcPruneAgeHours,
      },
      diskBudget,
      logger,
    });
    return {
      processHost,
      executor: new ReviewJobExecutor({
        workspaceProvider,
        codexExecutablePath: binaries.codexPath,
        codexHomeDirectory,
        codexConfigurationOverrides: codexProfile.configurationOverrides,
        codexProviderEnvironment: codexProfile.providerEnvironment,
        systemRoot,
        comSpec,
        path,
        pathExt,
        maximumHardTimeoutMs: execution.codexMaximumHardTimeoutMs,
        maximumProcessCount: execution.codexResourceLimits.maximumProcessCount,
        maximumMemoryBytes: execution.codexResourceLimits.maximumMemoryBytes,
        maximumOutputBytes: execution.codexResourceLimits.maximumOutputBytes,
        logger,
      }),
    };
  } catch (error) {
    try {
      await processHost.close();
    } catch (cleanupError) {
      try {
        logger.error("Worker ProcessHost cleanup failed after a startup error.", {
          errorName:
            cleanupError instanceof Error ? cleanupError.name.slice(0, 128) : "UnknownError",
        });
      } catch {
        // Preserve the original startup error even when diagnostic logging fails.
      }
    }
    throw error;
  }
}

function requiredEnvironment(name: "SYSTEMROOT" | "COMSPEC" | "PATH" | "PATHEXT"): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Worker execution requires the ${name} environment variable.`);
  }
  return value;
}

await main().catch((error: unknown) => {
  const fallback = new ConsoleJsonLogger("error", { component: "worker" });
  fallback.error("Worker failed during startup.", { error });
  process.exitCode = 1;
});
