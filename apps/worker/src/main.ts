import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JobExecutionEnvelopeV2, WorkerCapabilities } from "@agentic-review/contracts";
import {
  assertWorkerModelExecutionConfiguration,
  loadWorkerConfig,
  type WorkerExecutionConfig,
  type WorkerModelExecutionConfig,
} from "./config.js";
import { EvidenceUploader } from "./execution/evidence-uploader.js";
import {
  type JobExecutionContext,
  type JobExecutor,
  PlaceholderJobExecutor,
  ReviewJobExecutor,
} from "./execution/job-executor.js";
import {
  type JobWorkspaceProvider,
  type PreparedJobWorkspace,
  ProductionDisposableJobWorkspaceProvider,
} from "./execution/job-workspace.js";
import { ProductionManagedProcessRunner } from "./execution/managed-process-runner.js";
import { PreparedCliOutputRunner } from "./execution/prepared-cli-output-runner.js";
import {
  deriveWorkerProcessHostInstanceKey,
  type ProcessHostExitObservation,
  StdioProcessHostClient,
} from "./execution/process-host-client.js";
import {
  type ProcessHostClient,
  type ProcessResourceLimits,
  UnavailableProcessHostClient,
} from "./execution/process-host-protocol.js";
import { isEvaluationContext } from "./execution/profile-envelope.js";
import { ProfileJobExecutor } from "./execution/profile-job-executor.js";
import { resolveProfileModelPolicy } from "./execution/profile-model-policy.js";
import {
  createRuntimeCapabilities,
  validationProcessLimits,
} from "./execution/runtime-capabilities.js";
import {
  type VerifiedTrustedExecutionBinaries,
  type VerifiedTrustedValidationBinaries,
  verifyTrustedExecutionBinaries,
} from "./execution/trusted-binary.js";
import {
  runUiObservationProbe,
  runWindowsSessionProbe,
  type UiDriverRuntime,
  UiProfileRunner,
} from "./execution/ui-profile-runner.js";
import {
  createUiCommandBridge,
  HeadlessValidationCheckRunner,
  type HeadlessValidationCheckRunnerOptions,
} from "./execution/validation-check-runner.js";
import {
  createValidationWorkspaceResolvers,
  loadValidationRuntimeConfig,
  prepareValidationRuntime,
  type ValidationRuntimeConfig,
} from "./execution/validation-runtime-config.js";
import { ValidationSummaryExecutor } from "./execution/validation-summary-executor.js";
import { ProductionWorkspaceDiskBudget } from "./execution/workspace-disk-budget.js";
import { createInvestigationExecutionRuntime } from "./investigation/runtime.js";
import { loadInvestigationWorkerRuntimeConfig } from "./investigation/runtime-config.js";
import { ConsoleJsonLogger } from "./logging/logger.js";
import { HttpWorkerEvidenceApi } from "./server-client/evidence-api.js";
import type { ModelSummaryInputApi } from "./server-client/summary-input-api.js";

export async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Agentic Review Worker can run only on Windows.");
  }

  const config = loadInvestigationWorkerRuntimeConfig();
  const logger = new ConsoleJsonLogger(config.logLevel, {
    component: "investigation-worker",
  });
  const runtime = await createInvestigationExecutionRuntime(config, logger);
  let shutdownRequested = false;

  const requestShutdown = (signal: string): void => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    logger.info("Operating system requested worker shutdown.", { signal });
    void runtime.stop().catch(() => {
      logger.error("Investigation Worker shutdown did not confirm complete process closure.");
      process.exitCode = 1;
    });
  };

  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    const handler = () => requestShutdown(signal);
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    await runtime.run();
  } catch {
    logger.error("The investigation Worker stopped because of an unrecoverable error.");
    process.exitCode = 1;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    await runtime.stop();
  }
}

export async function createExecutionRuntime(
  config: ReturnType<typeof loadWorkerConfig>,
  logger: ConsoleJsonLogger,
  summaryInputApi?: ModelSummaryInputApi,
): Promise<{
  readonly processHost: ProcessHostClient;
  readonly executor: JobExecutor;
  readonly capabilities: WorkerCapabilities;
  readonly canAcceptWork?: (signal: AbortSignal) => Promise<boolean>;
}> {
  // Retain the selected mode and its paths before any asynchronous startup work.
  const execution = config.execution === undefined ? undefined : structuredClone(config.execution);
  const modelExecutionEnabled =
    config.modelExecutionEnabled !== false && execution?.modelExecutionEnabled !== false;
  const accountEnvironment =
    config.executionEnabled && modelExecutionEnabled
      ? snapshotCliEnvironment(process.env, config.workerToken)
      : undefined;
  assertWorkerModelExecutionConfiguration(process.env, modelExecutionEnabled);
  if (
    !modelExecutionEnabled &&
    execution !== undefined &&
    execution.modelExecutionEnabled !== false
  )
    throw new Error("Disabled model execution requires a validation-only execution configuration.");
  if (!config.executionEnabled) {
    return {
      processHost: new UnavailableProcessHostClient(),
      executor: new PlaceholderJobExecutor(),
      capabilities: createRuntimeCapabilities(config.capabilities, {
        execution: false,
        envelopeV2: false,
        headless: false,
        web: false,
        windowsDesktop: false,
        evidenceDelivery: false,
        ...(modelExecutionEnabled ? {} : { modelExecution: false }),
      }),
    };
  }
  if (execution === undefined) {
    throw new Error("Execution is enabled without an execution configuration.");
  }
  const dataDirectoryIdentity = await realpath(config.dataDirectory);

  const gitWorkingDirectory = win32.join(config.dataDirectory, "GitRuntime");
  await Promise.all([
    mkdir(execution.gitSharedRootDirectory, { recursive: true }),
    mkdir(execution.workspaceRootDirectory, { recursive: true }),
    mkdir(execution.tempDirectory, { recursive: true }),
    mkdir(gitWorkingDirectory, { recursive: true }),
  ]);
  const { binaries, model } = await prepareExecutionTools(execution);
  const systemRoot = requiredEnvironment("SYSTEMROOT", accountEnvironment);
  const comSpec = win32.join(systemRoot, "System32", "cmd.exe");
  const path = requiredEnvironment("PATH", accountEnvironment);
  const pathExt = requiredEnvironment("PATHEXT", accountEnvironment);
  const validation = await prepareValidationRuntime(
    loadValidationRuntimeConfig(process.env, {
      executionEnabled: config.executionEnabled,
      maxSlots: config.maxSlots,
      bundleDirectory: fileURLToPath(new URL(".", import.meta.url)),
      executables: [
        { name: "git", path: binaries.gitPath, sha256: execution.gitSha256 },
        ...(model === undefined
          ? []
          : [
              {
                name: model.execution.engine,
                path: model.binaries.cliPath,
                ...(model.execution.cliSha256 === undefined
                  ? {}
                  : { sha256: model.execution.cliSha256 }),
              },
            ]),
        { name: "node", path: process.execPath },
        {
          name: "powershell",
          path: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        },
        { name: "cmd", path: comSpec },
      ],
      untrustedDirectories: [
        execution.workspaceRootDirectory,
        execution.tempDirectory,
        execution.gitSharedRootDirectory,
        gitWorkingDirectory,
      ],
    }),
  );
  if (!modelExecutionEnabled && validation.summary !== undefined)
    throw new Error("Model execution is disabled; validation summaries are not allowed.");
  const headlessLimits = validationProcessLimits(execution, config.maxSlots, 1);
  const hasUiRuntime = validation.web !== undefined || validation.windows !== undefined;
  const uiLimits = hasUiRuntime
    ? validationProcessLimits(execution, config.maxSlots, 2)
    : undefined;
  // Source-state Git observations may run while the owned UI application is still alive.
  const gitLimits = validationProcessLimits(execution, config.maxSlots, hasUiRuntime ? 2 : 1, {
    hardTimeoutMs: execution.gitHardTimeoutMs,
    ...execution.gitResourceLimits,
  });
  const baseEnvironment = Object.freeze({
    SYSTEMROOT: systemRoot,
    COMSPEC: comSpec,
    PATH: path,
    PATHEXT: pathExt,
  });
  const processHost = await StdioProcessHostClient.create({
    processHostPath: binaries.processHostPath,
    instanceKey: deriveWorkerProcessHostInstanceKey({
      dataDirectory: dataDirectoryIdentity,
    }),
    maximumConcurrentRequests: config.maxSlots * (hasUiRuntime ? 2 : 1),
    requestTimeoutMs: execution.processHostRequestTimeoutMs,
    startTimeoutMs: execution.processHostStartTimeoutMs,
    shutdownTimeoutMs: execution.processHostShutdownTimeoutMs,
    ...(execution.processHostResourceDiagnostics
      ? {
          captureResourceUsage: true as const,
          onExitObservation: (observation: ProcessHostExitObservation) =>
            logger.info("Managed process exit observed.", {
              processRequestId: observation.requestId,
              exitCode: observation.exitCode,
              outputTruncated: observation.outputTruncated,
              limits: observation.limits,
              resourceUsage: observation.resourceUsage ?? null,
            }),
        }
      : {}),
  });
  try {
    const cliEnvironment =
      model === undefined
        ? undefined
        : Object.freeze({
            ...accountEnvironment,
            ...baseEnvironment,
            USERPROFILE: requiredEnvironment("USERPROFILE", accountEnvironment),
            ...(model.execution.cliHomeDirectory === undefined
              ? {}
              : {
                  [model.execution.engine === "codex" ? "CODEX_HOME" : "COPILOT_HOME"]:
                    model.execution.cliHomeDirectory,
                }),
            TEMP: execution.tempDirectory,
            TMP: execution.tempDirectory,
            NO_COLOR: "1",
          });
    const cliVersion =
      model === undefined || cliEnvironment === undefined
        ? undefined
        : await readInstalledCliVersion(
            model.binaries.cliPath,
            gitWorkingDirectory,
            cliEnvironment,
            processHost,
          );
    const diskBudget = new ProductionWorkspaceDiskBudget({
      workspaceRootDirectory: execution.workspaceRootDirectory,
      perAttemptDiskBytes: BigInt(execution.perAttemptDiskBytes),
      totalWorkspaceDiskBytes: BigInt(execution.totalWorkspaceDiskBytes),
      minimumFreeDiskBytes: BigInt(execution.minimumFreeDiskBytes),
      maximumAccountingEntries: execution.diskScanEntryLimit,
      maximumScanDurationMilliseconds: execution.diskScanTimeoutMs,
      orphanScanLimit: execution.orphanScanLimit,
    });
    const orphanSweep = await diskBudget.recoverOrphans();
    logger.info("Worker workspace startup sweep completed.", {
      ...orphanSweep,
      removedBytes: orphanSweep.removedBytes?.toString() ?? null,
    });
    const workspaceProvider = new ProductionDisposableJobWorkspaceProvider({
      workspaceRootDirectory: execution.workspaceRootDirectory,
      workspaceDirectoryNameFormat: execution.workspaceDirectoryNameFormat ?? "legacy",
      gitSharedRootDirectory: execution.gitSharedRootDirectory,
      gitExecutable: binaries.gitPath,
      gitWorkingDirectory,
      gitEnvironment: {
        SYSTEMROOT: systemRoot,
        COMSPEC: comSpec,
        PATH: win32.join(systemRoot, "System32"),
        PATHEXT: pathExt,
      },
      gitLimits,
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
    const modelProcessOptions =
      model === undefined || cliVersion === undefined || cliEnvironment === undefined
        ? undefined
        : {
            engine: model.execution.engine,
            cliExecutablePath: model.binaries.cliPath,
            cliVersion,
            cliEnvironment,
            ...(model.execution.cliHomeDirectory === undefined
              ? {}
              : { cliHomeDirectory: model.execution.cliHomeDirectory }),
            ...(model.execution.model === undefined ? {} : { model: model.execution.model }),
            userProfileDirectory: cliEnvironment.USERPROFILE,
            ...(accountEnvironment?.APPDATA === undefined
              ? {}
              : { appDataDirectory: accountEnvironment.APPDATA }),
            ...(accountEnvironment?.LOCALAPPDATA === undefined
              ? {}
              : { localAppDataDirectory: accountEnvironment.LOCALAPPDATA }),
            systemRoot,
            comSpec,
            path,
            pathExt,
            maximumHardTimeoutMs: model.execution.modelMaximumHardTimeoutMs,
            maximumProcessCount: model.execution.modelResourceLimits.maximumProcessCount,
            maximumMemoryBytes: model.execution.modelResourceLimits.maximumMemoryBytes,
            maximumOutputBytes: model.execution.modelResourceLimits.maximumOutputBytes,
            logger,
          };
    const reviewOptions = modelProcessOptions;
    const startupDrivers = uiDrivers(
      validation,
      baseEnvironment,
      execution.tempDirectory,
      execution.tempDirectory,
    );
    let windowsDesktopReady = false;
    if (validation.windows !== undefined && uiLimits !== undefined) {
      const session = await runWindowsSessionProbe(
        startupDrivers,
        uiLimits,
        processHost,
        AbortSignal.timeout(15_000),
      );
      windowsDesktopReady = session.available;
      if (!session.available)
        logger.warn(
          "Windows validation is unavailable because the interactive session is not active and unlocked.",
        );
    }
    const evidenceUploader = new EvidenceUploader({
      api: new HttpWorkerEvidenceApi(config, logger),
    });
    // A configured executable path does not prove that the deployed driver speaks this protocol.
    const preparedTargets = [
      ...(validation.web === undefined ? [] : ["web" as const]),
      ...(validation.windows === undefined ? [] : ["windows_desktop" as const]),
    ];
    let uiObservationsReady = uiLimits !== undefined && preparedTargets.length > 0;
    if (uiLimits !== undefined) {
      for (const target of preparedTargets) {
        try {
          if (
            !(await runUiObservationProbe(
              startupDrivers,
              uiLimits,
              processHost,
              AbortSignal.timeout(15_000),
              target,
            ))
          )
            uiObservationsReady = false;
        } catch {
          uiObservationsReady = false;
        }
      }
    }
    const commandOptions = (
      workspace: PreparedJobWorkspace,
      context: JobExecutionContext,
      limits: ProcessResourceLimits,
    ): HeadlessValidationCheckRunnerOptions => ({
      baseEnvironment: {
        ...baseEnvironment,
        TEMP: workspace.tempDirectory,
        TMP: workspace.tempDirectory,
        USERPROFILE: workspace.userProfileDirectory,
      },
      ...createValidationWorkspaceResolvers(validation, workspace.checkoutDirectory),
      limits,
      cleanupTimeoutMs: validation.cleanupTimeoutMs,
      onProcessProgress: (progress) =>
        context.reportProgress({ phase: "validation", processCount: progress.processCount }),
    });
    const summaryConfiguration = validation.summary;
    const executor = new ProfileJobExecutor({
      legacyExecutor:
        reviewOptions === undefined
          ? new PlaceholderJobExecutor()
          : new ReviewJobExecutor({ ...reviewOptions, workspaceProvider }),
      workspaceProvider,
      ...(modelExecutionEnabled ? {} : { modelExecutionEnabled: false }),
      optionalSummariesEnabled: summaryConfiguration !== undefined,
      ...(reviewOptions === undefined || modelProcessOptions === undefined
        ? {}
        : {
            createModelExecutor: (
              provider: JobWorkspaceProvider,
              envelope: JobExecutionEnvelopeV2,
            ) => {
              if (!isEvaluationContext(envelope.validation))
                return new ReviewJobExecutor({ ...reviewOptions, workspaceProvider: provider });
              if (resolveProfileModelPolicy(envelope.validation).kind !== "review")
                throw new Error("The frozen evaluation does not request a model review.");
              return new ReviewJobExecutor({
                ...reviewOptions,
                workspaceProvider: provider,
              });
            },
          }),
      ...(modelProcessOptions === undefined
        ? {}
        : {
            createSummaryExecutor: (envelope: JobExecutionEnvelopeV2) => {
              if (
                model === undefined ||
                modelProcessOptions === undefined ||
                reviewOptions === undefined
              )
                throw new Error("Model execution is disabled on this Worker.");
              if (isEvaluationContext(envelope.validation)) {
                if (resolveProfileModelPolicy(envelope.validation).kind !== "summary")
                  throw new Error("The frozen evaluation does not request a model summary.");
                if (summaryInputApi === undefined)
                  throw new Error("Evaluation summaries require the summary input API.");
                return new ValidationSummaryExecutor({
                  logger,
                  workspaceProvider,
                  outputRunner: new PreparedCliOutputRunner(modelProcessOptions),
                  summaryInputApi,
                  ...(summaryConfiguration === undefined
                    ? {}
                    : { maximumSummaryTimeoutMs: summaryConfiguration.maximumTimeoutMs }),
                });
              }
              if (summaryConfiguration === undefined) return undefined;
              return new ValidationSummaryExecutor({
                logger,
                workspaceProvider,
                outputRunner: new PreparedCliOutputRunner(reviewOptions),
                maximumSummaryTimeoutMs: summaryConfiguration.maximumTimeoutMs,
              });
            },
          }),
      createHeadlessRunner: (_envelope, context, workspace) => {
        if (!validation.headlessEnabled)
          throw new Error("Headless validation is not enabled on this Worker.");
        return new HeadlessValidationCheckRunner(
          commandOptions(workspace, context, headlessLimits),
        );
      },
      createUiRunner: (envelope, context, workspace) => {
        const target = envelope.validation.target;
        if (
          uiLimits === undefined ||
          (target === "web" && validation.web === undefined) ||
          (target === "windows_desktop" && !windowsDesktopReady) ||
          target === "headless"
        )
          throw new Error("The requested UI validation target is not ready on this Worker.");
        return new UiProfileRunner({
          commands: createUiCommandBridge(
            envelope.validation.profileVersion,
            commandOptions(workspace, context, uiLimits),
          ),
          limits: uiLimits,
          drivers: uiDrivers(
            validation,
            baseEnvironment,
            workspace.tempDirectory,
            workspace.userProfileDirectory,
          ),
          cleanupTimeoutMs: validation.cleanupTimeoutMs,
          ...(validation.windows === undefined
            ? {}
            : { desktopLockDirectory: validation.windows.desktopLockDirectory }),
          evidenceDirectory: (input, signal) => createUiEvidenceDirectory(input.workspace, signal),
          onProgress: (progress) =>
            context.reportProgress({ phase: "validation", processCount: progress.processCount }),
        });
      },
      evidenceUploader,
    });
    return {
      processHost,
      canAcceptWork: (signal) => diskBudget.hasCapacity(signal),
      executor,
      capabilities: createRuntimeCapabilities(
        {
          ...config.capabilities,
          cliEngine: model?.execution.engine ?? null,
          cliVersion: cliVersion ?? null,
        },
        {
          execution: true,
          envelopeV2: true,
          headless: validation.headlessEnabled,
          web: validation.web !== undefined,
          windowsDesktop: windowsDesktopReady,
          evidenceDelivery: true,
          reproduction: true,
          structuredProbes: true,
          uiObservations: uiObservationsReady,
          evaluationModelReview: modelProcessOptions !== undefined,
          evaluationModelSummary:
            modelProcessOptions !== undefined && summaryInputApi !== undefined,
          ...(modelExecutionEnabled ? {} : { modelExecution: false }),
        },
      ),
    };
  } catch (error) {
    await closeAfterStartupFailure(processHost, logger);
    throw error;
  }
}

interface PreparedExecutionModel {
  readonly execution: WorkerModelExecutionConfig;
  readonly binaries: VerifiedTrustedExecutionBinaries;
}

/** CLI authentication and user configuration remain owned by the installed CLI. */
async function prepareExecutionTools(execution: WorkerExecutionConfig): Promise<{
  readonly binaries: VerifiedTrustedValidationBinaries;
  readonly model?: PreparedExecutionModel;
}> {
  const shared = {
    trustedExecutableRoot: execution.trustedExecutableRoot,
    processHost: { path: execution.processHostPath, expectedSha256: execution.processHostSha256 },
    git: { path: execution.gitExecutablePath, expectedSha256: execution.gitSha256 },
  };
  if (execution.modelExecutionEnabled === false)
    return { binaries: await verifyTrustedExecutionBinaries(shared) };
  const binaries = await verifyTrustedExecutionBinaries({
    ...shared,
    cli: {
      path: execution.cliExecutablePath,
      ...(execution.cliSha256 === undefined ? {} : { expectedSha256: execution.cliSha256 }),
    },
  });
  return { binaries, model: { execution, binaries } };
}

async function readInstalledCliVersion(
  executable: string,
  workingDirectory: string,
  environment: Readonly<Record<string, string>>,
  processHost: ProcessHostClient,
): Promise<string> {
  try {
    const output = await new ProductionManagedProcessRunner({
      maximumCapturedOutputBytes: 64 * 1024,
      maximumErrorPreviewBytes: 0,
    }).run(
      {
        executable,
        arguments: ["--version"],
        workingDirectory,
        environmentMode: "replace",
        environment,
        standardInput: "",
        limits: {
          hardTimeoutMs: 20_000,
          maximumProcessCount: 8,
          maximumMemoryBytes: 512 * 1024 * 1024,
          maximumOutputBytes: 64 * 1024,
        },
      },
      { processHost, signal: AbortSignal.timeout(25_000) },
    );
    const version = output.stdout.trim().split(/\r?\n/u)[0] ?? "";
    if (
      version.length === 0 ||
      version.length > 128 ||
      [...version].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Invalid CLI version output.");
    return version;
  } catch {
    throw new Error("The configured CLI did not return a usable version from --version.");
  }
}
async function closeAfterStartupFailure(
  processHost: ProcessHostClient,
  logger: ConsoleJsonLogger,
): Promise<void> {
  try {
    await processHost.close();
  } catch (cleanupError) {
    try {
      logger.error("Worker ProcessHost cleanup failed after a startup error.", {
        errorName: cleanupError instanceof Error ? cleanupError.name.slice(0, 128) : "UnknownError",
      });
    } catch {
      // Preserve the original startup error even when diagnostic logging fails.
    }
  }
}

function uiDrivers(
  config: ValidationRuntimeConfig,
  environment: Readonly<Record<string, string>>,
  tempDirectory: string,
  userProfileDirectory: string,
): UiDriverRuntime {
  return {
    ...(config.web === undefined
      ? {}
      : {
          nodeExecutable: config.web.nodeExecutablePath,
          browserExecutable: config.web.browserExecutablePath,
          webDriverEntry: config.web.driverEntryPath,
          windowsPowerShellExecutable: config.web.powerShellExecutablePath,
          windowsDriverEntry: config.web.windowsProbeEntryPath,
        }),
    ...(config.windows === undefined
      ? {}
      : {
          windowsPowerShellExecutable: config.windows.powerShellExecutablePath,
          windowsDriverEntry: config.windows.driverEntryPath,
        }),
    workingDirectory: config.bundleDirectory,
    environment: {
      ...environment,
      TEMP: tempDirectory,
      TMP: tempDirectory,
      USERPROFILE: userProfileDirectory,
      PSMODULEANALYSISCACHEPATH: win32.join(tempDirectory, "PowerShell-ModuleAnalysisCache"),
    },
  };
}

async function createUiEvidenceDirectory(
  workspace: PreparedJobWorkspace,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const parent = workspace.controlDirectory;
  const state = await lstat(parent);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (await realpath(parent)).toLowerCase() !== win32.normalize(parent).toLowerCase()
  )
    throw new Error("The validation evidence parent is unsafe.");
  const directory = win32.join(parent, "validation-evidence");
  await mkdir(directory, { mode: 0o700 });
  const created = await lstat(directory);
  if (
    !created.isDirectory() ||
    created.isSymbolicLink() ||
    (await realpath(directory)).toLowerCase() !== win32.normalize(directory).toLowerCase()
  )
    throw new Error("The validation evidence directory is unsafe.");
  signal.throwIfAborted();
  return directory;
}

function snapshotCliEnvironment(
  environment: NodeJS.ProcessEnv,
  workerToken: string,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment)
        .filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            (workerToken.length === 0 || !entry[1].includes(workerToken)) &&
            !/^(?:WORKER_|SERVER_|AGENTIC_REVIEW_)/u.test(entry[0].toUpperCase()),
        )
        .map(([name, value]) => [name.toUpperCase(), value]),
    ),
  );
}

function requiredEnvironment(
  name: "SYSTEMROOT" | "PATH" | "PATHEXT" | "USERPROFILE",
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Worker execution requires the ${name} environment variable.`);
  }
  return value;
}

const entryPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (
  entryPath !== undefined &&
  (process.platform === "win32"
    ? win32.normalize(fileURLToPath(import.meta.url)).toLowerCase() ===
      win32.normalize(entryPath).toLowerCase()
    : import.meta.url === pathToFileURL(entryPath).href)
)
  await main().catch((error: unknown) => {
    const fallback = new ConsoleJsonLogger("error", { component: "worker" });
    fallback.error("Worker failed during startup.", { error });
    process.exitCode = 1;
  });
