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
import {
  loadCodexProviderProfile,
  loadCodexRelayProviderProfile,
} from "./execution/codex-provider-profile.js";
import {
  type PreparedEvaluationModelRuntime,
  prepareEvaluationModelRuntime,
} from "./execution/evaluation-model-runtime.js";
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
import { verifyPersistentCodexHome } from "./execution/persistent-codex-home.js";
import { PreparedCodexOutputRunner } from "./execution/prepared-codex-output-runner.js";
import {
  deriveWorkerProcessHostInstanceKey,
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
import { ConsoleJsonLogger } from "./logging/logger.js";
import { WorkerApiError } from "./server-client/errors.js";
import { HttpWorkerEvidenceApi } from "./server-client/evidence-api.js";
import { HttpWorkerApi } from "./server-client/http-worker-api.js";
import type {
  ModelInvocationApi,
  ModelSummaryInputApi,
} from "./server-client/model-invocation-api.js";
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
  const runtime = await createExecutionRuntime(config, logger, api);
  const { processHost, executor } = runtime;
  let service: WorkerService;
  try {
    service = new WorkerService(
      { ...config, capabilities: runtime.capabilities },
      api,
      executor,
      processHost,
      logger,
      runtime.canAcceptWork,
    );
  } catch (error) {
    await closeAfterStartupFailure(processHost, logger);
    throw error;
  }
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

export async function createExecutionRuntime(
  config: ReturnType<typeof loadWorkerConfig>,
  logger: ConsoleJsonLogger,
  modelInvocationApi?: ModelInvocationApi & Partial<ModelSummaryInputApi>,
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
  assertWorkerModelExecutionConfiguration(process.env, modelExecutionEnabled);
  if (
    !modelExecutionEnabled &&
    execution !== undefined &&
    (execution.modelExecutionEnabled !== false || execution.evaluationModel !== undefined)
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
    ...(execution.modelExecutionEnabled === false
      ? []
      : [mkdir(execution.profileDirectory, { recursive: true })]),
    mkdir(gitWorkingDirectory, { recursive: true }),
  ]);
  const { binaries, model } = await prepareExecutionTools(
    execution,
    gitWorkingDirectory,
    modelInvocationApi,
  );
  const evaluationModel = model?.evaluation;
  if (evaluationModel !== undefined)
    logger.info(
      "Evaluation model session composition is prepared; evaluation execution remains unavailable.",
      {
        implementationSha256: evaluationModel.implementationSha256,
      },
    );
  const systemRoot = requiredEnvironment("SYSTEMROOT");
  const comSpec = win32.join(systemRoot, "System32", "cmd.exe");
  const path = requiredEnvironment("PATH");
  const pathExt = requiredEnvironment("PATHEXT");
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
                name: "codex",
                path: model.binaries.codexPath,
                sha256: model.execution.codexSha256,
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
    ...(evaluationModel === undefined ? {} : { interactiveStdin: true as const }),
  });
  try {
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
      gitSharedRootDirectory: execution.gitSharedRootDirectory,
      gitExecutable: binaries.gitPath,
      gitWorkingDirectory,
      gitEnvironment: { SYSTEMROOT: systemRoot, COMSPEC: comSpec, PATH: path, PATHEXT: pathExt },
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
      model === undefined
        ? undefined
        : {
            codexExecutablePath: model.binaries.codexPath,
            codexHomeDirectory: model.codexHomeDirectory,
            systemRoot,
            comSpec,
            path,
            pathExt,
            maximumHardTimeoutMs: model.execution.codexMaximumHardTimeoutMs,
            maximumProcessCount: model.execution.codexResourceLimits.maximumProcessCount,
            maximumMemoryBytes: model.execution.codexResourceLimits.maximumMemoryBytes,
            maximumOutputBytes: model.execution.codexResourceLimits.maximumOutputBytes,
            logger,
          };
    const reviewOptions =
      model === undefined || modelProcessOptions === undefined
        ? undefined
        : {
            ...modelProcessOptions,
            codexConfigurationOverrides: model.profile.configurationOverrides,
            codexProviderEnvironment: model.profile.providerEnvironment,
            codexProviderProtectedValues: model.profile.protectedValues,
          };
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
              if (evaluationModel === undefined)
                throw new Error("Evaluation model session composition is not configured.");
              return new ReviewJobExecutor({
                ...modelProcessOptions,
                ...evaluationModel.review,
                workspaceProvider: provider,
              });
            },
          }),
      ...(summaryConfiguration === undefined && evaluationModel?.summary === undefined
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
                const summary = evaluationModel?.summary;
                if (summary === undefined)
                  throw new Error("Evaluation summary composition is not configured.");
                return new ValidationSummaryExecutor({
                  workspaceProvider,
                  outputRunner: new PreparedCodexOutputRunner({
                    ...modelProcessOptions,
                    modelInvocationBackend: summary.modelInvocationBackend,
                    codexProviderProtectedValues: summary.codexProviderProtectedValues,
                  }),
                  createSummaryModelInvocation: summary.createSummaryModelInvocation,
                  ...(summaryConfiguration === undefined
                    ? {}
                    : { maximumSummaryTimeoutMs: summaryConfiguration.maximumTimeoutMs }),
                  sensitiveValues: summary.codexProviderProtectedValues,
                });
              }
              if (summaryConfiguration === undefined) return undefined;
              return new ValidationSummaryExecutor({
                workspaceProvider,
                outputRunner: new PreparedCodexOutputRunner(reviewOptions),
                maximumSummaryTimeoutMs: summaryConfiguration.maximumTimeoutMs,
                sensitiveValues: model.profile.protectedValues,
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
      capabilities: createRuntimeCapabilities(config.capabilities, {
        execution: true,
        envelopeV2: true,
        headless: validation.headlessEnabled,
        web: validation.web !== undefined,
        windowsDesktop: windowsDesktopReady,
        evidenceDelivery: true,
        reproduction: true,
        structuredProbes: true,
        uiObservations: uiObservationsReady,
        ...(modelExecutionEnabled ? {} : { modelExecution: false }),
      }),
    };
  } catch (error) {
    await closeAfterStartupFailure(processHost, logger);
    throw error;
  }
}

interface PreparedExecutionModel {
  readonly execution: WorkerModelExecutionConfig;
  readonly binaries: VerifiedTrustedExecutionBinaries;
  readonly codexHomeDirectory: string;
  readonly profile: Awaited<ReturnType<typeof loadCodexProviderProfile>>;
  readonly evaluation?: PreparedEvaluationModelRuntime;
}

/** Validation-only startup never opens a model profile or measures a Codex executable. */
async function prepareExecutionTools(
  execution: WorkerExecutionConfig,
  gitWorkingDirectory: string,
  modelInvocationApi?: ModelInvocationApi & Partial<ModelSummaryInputApi>,
): Promise<{
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
  const codexHomeDirectory = await verifyPersistentCodexHome({
    profileDirectory: execution.profileDirectory,
    workspaceRootDirectory: execution.workspaceRootDirectory,
    tempDirectory: execution.tempDirectory,
    gitSharedRootDirectory: execution.gitSharedRootDirectory,
    gitWorkingDirectory,
    trustedExecutableRoot: execution.trustedExecutableRoot,
  });
  const profile = await loadCodexProviderProfile(codexHomeDirectory);
  const binaries = await verifyTrustedExecutionBinaries({
    ...shared,
    codex: { path: execution.codexExecutablePath, expectedSha256: execution.codexSha256 },
  });
  const evaluation =
    execution.evaluationModel === undefined
      ? undefined
      : await prepareEvaluationModelRuntime({
          configuration: execution.evaluationModel,
          trustedExecutableRoot: execution.trustedExecutableRoot,
          workerEntryPath: fileURLToPath(import.meta.url),
          processEntryPath: process.argv[1],
          nodeExecutablePath: process.execPath,
          nodeVersion: process.versions.node,
          nodeExecArguments: process.execArgv,
          nodeOptions: process.env.NODE_OPTIONS,
          codexVersion: execution.codexVersion,
          codexMeasurement: binaries.measurements.codex,
          provider: await loadCodexRelayProviderProfile(codexHomeDirectory),
          api: modelInvocationApi,
          ...(modelInvocationApi?.freezeValidationSummaryInput === undefined
            ? {}
            : {
                summaryInputApi: {
                  freezeValidationSummaryInput:
                    modelInvocationApi.freezeValidationSummaryInput.bind(modelInvocationApi),
                },
              }),
        });
  return {
    binaries,
    model: {
      execution,
      binaries,
      codexHomeDirectory,
      profile,
      ...(evaluation === undefined ? {} : { evaluation }),
    },
  };
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

function requiredEnvironment(name: "SYSTEMROOT" | "PATH" | "PATHEXT"): string {
  const value = process.env[name]?.trim();
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
