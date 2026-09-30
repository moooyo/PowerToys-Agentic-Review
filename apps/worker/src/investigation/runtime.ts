import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveWorkerProcessHostInstanceKey,
  StdioProcessHostClient,
  type StdioProcessHostClientOptions,
} from "../execution/process-host-client.js";
import {
  assertWindowsLocalAbsolutePath,
  type ProcessHostClient,
} from "../execution/process-host-protocol.js";
import { verifyTrustedExecutionBinaries } from "../execution/trusted-binary.js";
import type { Logger } from "../logging/logger.js";
import {
  type AgentVerificationPlanAdapter,
  type AgentVerificationPlanAdapterOptions,
  createAgentVerificationPlanAdapter,
} from "./agent-verification-plan-adapter.js";
import {
  type AttemptCleanupIdentity,
  type AttemptCleanupJournal,
  type AttemptCleanupJournalOptions,
  type AttemptCleanupRecoveryActions,
  type AttemptCleanupStatus,
  InvestigationAttemptCleanupJournal,
} from "./attempt-cleanup-journal.js";
import {
  type AttemptDesktopCleanupHooks,
  type AttemptDesktopGuard,
  type AttemptDesktopGuardOptions,
  executeWithAttemptDesktopGuard,
} from "./attempt-desktop-guard.js";
import { createCleanupRecoveryOperations } from "./cleanup-recovery-operations.js";
import {
  createE2eAgentRunner,
  type E2eAgentRunner,
  type E2eAgentRunnerOptions,
} from "./e2e-agent-runner.js";
import {
  type InvestigationGitSourceOptions,
  ProductionInvestigationGitSourceMaterializer,
} from "./git-source.js";
import {
  createInvestigationHttpClient,
  type InvestigationHttpClientOptions,
  type InvestigationWorkerClient,
} from "./http-client.js";
import {
  InvestigationLoopCoordinator,
  type InvestigationLoopCoordinatorOptions,
} from "./loop-coordinator.js";
import { createModelEditAdapter, type ModelEditRunnerOptions } from "./model-edit-runner.js";
import {
  createModelTurnRunner,
  type ModelTurnRunner,
  type ModelTurnRunnerOptions,
} from "./model-turn-runner.js";
import {
  InvestigationModelUsageJournal,
  type ModelUsageJournalOptions,
} from "./model-usage-journal.js";
import {
  DurableInvestigationOutputJournal,
  type InvestigationOutputJournal,
  type InvestigationOutputJournalOptions,
} from "./output-journal.js";
import { createInvestigationOutputReporter } from "./output-reporter.js";
import {
  type InvestigationModelEditAdapter,
  type InvestigationPlanExecutor,
  type InvestigationUiPlanAdapter,
  ProductionInvestigationPlanExecutor,
  type ProductionInvestigationPlanExecutorOptions,
} from "./plan-executor.js";
import {
  createRecipePlanAdapter,
  type InvestigationRecipePlanAdapter,
  type RecipePlanAdapterOptions,
} from "./recipe-plan-adapter.js";
import {
  defaultInvestigationDesktopLockDirectory,
  type InvestigationWorkerRuntimeConfig,
} from "./runtime-config.js";
import {
  assertInvestigationClaimPool,
  type InvestigationClaimExecutor,
  InvestigationTaskService,
  type InvestigationTaskServiceOptions,
  investigationTaskPool,
} from "./task-service.js";
import {
  ProductionInvestigationUiPlanAdapter,
  type ProductionInvestigationUiPlanAdapterOptions,
} from "./ui-plan-adapter.js";
import {
  type InvestigationSourceMaterializer,
  type InvestigationWorkspaceProvider,
  ProductionInvestigationWorkspaceProvider,
  type ProductionInvestigationWorkspaceProviderOptions,
} from "./workspace.js";

export interface InvestigationRuntimeService {
  run(): Promise<void>;
  requestDrain(): void;
  stop(): Promise<void>;
}

export interface InvestigationVerifiedDeployment {
  readonly processHostPath: string;
  readonly gitPath: string;
  readonly cliPath: string;
  readonly executables: Readonly<Record<string, string>>;
}

export interface InvestigationRuntimeDependencies {
  readonly outputInitializationTimeoutMs?: number;
  readonly createOutputJournal?: (
    options: InvestigationOutputJournalOptions,
  ) => InvestigationOutputJournal;
  readonly prepareDirectories?: (config: InvestigationWorkerRuntimeConfig) => Promise<void>;
  readonly verifyDeployment?: (
    config: InvestigationWorkerRuntimeConfig,
  ) => Promise<InvestigationVerifiedDeployment>;
  readonly createProcessHost?: (
    options: StdioProcessHostClientOptions,
  ) => Promise<ProcessHostClient>;
  readonly createClient?: (options: InvestigationHttpClientOptions) => InvestigationWorkerClient;
  readonly createCleanupJournal?: (options: AttemptCleanupJournalOptions) => AttemptCleanupJournal;
  readonly createCleanupRecoveryOperations?: typeof createCleanupRecoveryOperations;
  readonly createUsageJournal?: (
    options: ModelUsageJournalOptions,
  ) => InvestigationModelUsageJournal;
  readonly createModelTurnRunner?: (options: ModelTurnRunnerOptions) => ModelTurnRunner;
  readonly createE2eAgentRunner?: (options: E2eAgentRunnerOptions) => E2eAgentRunner;
  readonly createRecipePlanAdapter?: (
    options: RecipePlanAdapterOptions,
  ) => InvestigationRecipePlanAdapter;
  readonly createAgentVerificationPlanAdapter?: (
    options: AgentVerificationPlanAdapterOptions,
  ) => AgentVerificationPlanAdapter;
  readonly createModelEditAdapter?: (
    options: ModelEditRunnerOptions,
  ) => InvestigationModelEditAdapter;
  readonly createUiAdapter?: (
    options: ProductionInvestigationUiPlanAdapterOptions,
  ) => InvestigationUiPlanAdapter;
  readonly createPlanExecutor?: (
    options: ProductionInvestigationPlanExecutorOptions,
  ) => InvestigationPlanExecutor;
  readonly createSourceMaterializer?: (
    options: InvestigationGitSourceOptions,
  ) => InvestigationSourceMaterializer;
  readonly createWorkspaceProvider?: (
    options: ProductionInvestigationWorkspaceProviderOptions,
  ) => InvestigationWorkspaceProvider;
  readonly createCoordinator?: (
    options: InvestigationLoopCoordinatorOptions,
  ) => InvestigationClaimExecutor;
  readonly acquireDesktopGuard?: (
    options: AttemptDesktopGuardOptions,
  ) => Promise<AttemptDesktopGuard>;
  readonly createTaskService?: (
    options: InvestigationTaskServiceOptions,
  ) => InvestigationRuntimeService;
}

export interface InvestigationExecutionRuntime {
  readonly processHost: ProcessHostClient;
  readonly service: InvestigationRuntimeService;
  run(): Promise<void>;
  stop(): Promise<void>;
  cleanupStatus(): Promise<AttemptCleanupStatus[]>;
  confirmCleanupRecovery(
    attemptId: string,
    confirmation: {
      operator: string;
      reason: string;
      desktopRestored: true;
      ownedProcessTreeStopped: boolean;
    },
  ): Promise<AttemptCleanupStatus[]>;
}

/** Constructs the production Task runtime without any Task-to-Job envelope conversion. */
export async function createInvestigationExecutionRuntime(
  suppliedConfig: InvestigationWorkerRuntimeConfig,
  logger: Logger,
  dependencies: InvestigationRuntimeDependencies = {},
): Promise<InvestigationExecutionRuntime> {
  const config = {
    ...structuredClone(suppliedConfig),
    desktopLockDirectory:
      suppliedConfig.desktopLockDirectory ?? defaultInvestigationDesktopLockDirectory(),
  };
  if (!config.modelStaticConfiguration.verified)
    throw new Error(
      "The deployment must verify its isolated static CLI configuration before starting the investigation Worker.",
    );
  const usageJournalDirectory = win32.join(config.dataDirectory, "model-usage");
  const outputJournalDirectory = win32.join(config.dataDirectory, "visible-output");
  const cleanupJournalDirectory = win32.join(config.dataDirectory, "attempt-cleanup");
  if (
    key(outputJournalDirectory) === key(config.workspaceRootDirectory) ||
    key(outputJournalDirectory).startsWith(`${key(config.workspaceRootDirectory)}\\`)
  )
    throw new Error("The visible output journal must remain outside disposable workspaces.");
  if (
    key(usageJournalDirectory) === key(config.workspaceRootDirectory) ||
    key(usageJournalDirectory).startsWith(`${key(config.workspaceRootDirectory)}\\`)
  )
    throw new Error("The model usage journal must remain outside disposable workspaces.");
  await (dependencies.prepareDirectories ?? prepareInvestigationDirectories)(config);
  if (
    key(cleanupJournalDirectory) === key(config.workspaceRootDirectory) ||
    key(cleanupJournalDirectory).startsWith(`${key(config.workspaceRootDirectory)}\\`)
  )
    throw new Error("The attempt cleanup journal must remain outside disposable workspaces.");
  const cleanupJournal = (
    dependencies.createCleanupJournal ??
    ((options) => new InvestigationAttemptCleanupJournal(options))
  )({ directory: cleanupJournalDirectory });
  const activeCleanupAttempts = new Set<string>();
  let replayCleanup = async (): Promise<AttemptCleanupStatus[]> => [];
  const binaries = await (dependencies.verifyDeployment ?? verifyInvestigationDeployment)(config);
  const transportClient = (dependencies.createClient ?? createInvestigationHttpClient)({
    serverUrl: config.serverUrl,
    workerToken: config.workerToken,
    allowInsecureHttp: config.allowInsecureHttp,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const usageDeliveryLifetime = new AbortController();
  const outputJournal = (
    dependencies.createOutputJournal ??
    ((options) => new DurableInvestigationOutputJournal(options))
  )({
    directory: outputJournalDirectory,
    protectedValues: [config.workerToken],
    requestTimeoutMs: Math.min(5_000, config.requestTimeoutMs),
    onFailure: () =>
      logger.warn(
        "Visible output delivery is unavailable; bounded sanitized records remain retained.",
      ),
    onTerminalFailure: (diagnostic) =>
      logger.error("Visible output delivery permanently stopped for this attempt.", {
        ...diagnostic,
      }),
    deliver: async (taskId, request, signal) => {
      if (transportClient.outputEvents === undefined)
        throw new Error("The Worker visible output transport is unavailable.");
      return transportClient.outputEvents(taskId, request, signal);
    },
  });
  let outputReplay: Promise<void> | undefined;
  const replayOutput = (): void => {
    if (usageDeliveryLifetime.signal.aborted || outputReplay !== undefined) return;
    // Avoid attaching another rejection/finally observer to a permanently stalled shared replay.
    outputReplay = outputJournal
      .replay()
      .catch(() => logger.warn("Retained visible output could not be replayed."))
      .finally(() => {
        outputReplay = undefined;
      });
  };
  const outputReporters = new Map<string, ReturnType<typeof createInvestigationOutputReporter>>();
  const cancellationObserved = new Set<string>();
  const usageJournal = (
    dependencies.createUsageJournal ?? ((options) => new InvestigationModelUsageJournal(options))
  )({
    directory: usageJournalDirectory,
    deliver: async (receipt, lease) => {
      if (lease === undefined || transportClient.modelUsage === undefined)
        throw new Error("The model usage receipt has no authenticated delivery context.");
      return await transportClient.modelUsage(
        receipt.taskId,
        { lease, receipt },
        usageDeliveryLifetime.signal,
      );
    },
  });
  let usageReplay: Promise<void> | undefined;
  const replayUsage = (): Promise<void> => {
    if (usageDeliveryLifetime.signal.aborted) return Promise.resolve();
    usageReplay ??= usageJournal
      .replay()
      .catch(() => {
        // The durable journal owns retries. Never log private lease or transport payloads.
        logger.warn("Pending model usage receipts could not be delivered and remain retained.");
      })
      .finally(() => {
        usageReplay = undefined;
      });
    return usageReplay;
  };
  const client: InvestigationWorkerClient = {
    ...transportClient,
    ...(transportClient.workerPolicy === undefined
      ? {}
      : ({
          async workerPolicy(request, signal) {
            try {
              return await transportClient.workerPolicy!(request, signal);
            } finally {
              // A disabled execution-only Worker still needs to deliver retained receipts.
              void replayUsage();
              replayOutput();
              void replayCleanup().catch(() =>
                logger.warn("Pending execution cleanup remains retained for recovery."),
              );
            }
          },
        } satisfies Pick<InvestigationWorkerClient, "workerPolicy">)),
    async claim(request, signal) {
      const response = await transportClient.claim(request, signal);
      // Idle polling also retries terminal receipts after the last attempt ends.
      void replayUsage();
      replayOutput();
      void replayCleanup().catch(() =>
        logger.warn("Pending execution cleanup remains retained for recovery."),
      );
      return response;
    },
    async heartbeat(taskId, request, signal) {
      const response = await transportClient.heartbeat(taskId, request, signal);
      // Accounting retries must not delay lease renewal or change execution authority.
      void replayUsage();
      replayOutput();
      if (response.cancelRequested && !cancellationObserved.has(request.lease.attemptId)) {
        cancellationObserved.add(request.lease.attemptId);
        outputReporters
          .get(request.lease.attemptId)
          ?.system(
            "The Server requested task cancellation. Owned process cleanup has not yet been confirmed.",
          );
      }
      // Server admission is checked in this same renewal response before execution proceeds.
      return response;
    },
    async checkpoint(taskId, request, signal) {
      const response = await transportClient.checkpoint(taskId, request, signal);
      outputReporters
        .get(request.lease.attemptId)
        ?.system("The Server accepted a checkpoint for this attempt.");
      return response;
    },
    ...(transportClient.progress === undefined
      ? {}
      : ({
          async progress(taskId, request, signal) {
            if (request.kind === "stage")
              outputReporters
                .get(request.lease.attemptId)
                ?.system(`Worker stage: ${request.stage}.`);
            return transportClient.progress!(taskId, request, signal);
          },
        } satisfies Pick<InvestigationWorkerClient, "progress">)),
    ...(transportClient.cleanup === undefined
      ? {}
      : ({
          async cleanup(taskId, request, signal) {
            const response = await transportClient.cleanup!(taskId, request, signal);
            outputReporters
              .get(request.lease.attemptId)
              ?.system("The Server acknowledged owned process cleanup and desktop restoration.");
            if (activeCleanupAttempts.has(request.lease.attemptId))
              await cleanupJournal.acknowledged(request.lease.attemptId);
            return response;
          },
        } satisfies Pick<InvestigationWorkerClient, "cleanup">)),
  };
  await replayUsage();
  const hostEnvironment = {
    ...config.operatingSystemEnvironment,
    TEMP: win32.join(config.dataDirectory, "host-temp"),
    TMP: win32.join(config.dataDirectory, "host-temp"),
  };
  forbidWorkerCredential(hostEnvironment, config.workerToken);
  const staticCapacity =
    config.role === "e2e"
      ? 0
      : (config.maximumConcurrentStaticTasks ?? config.maximumConcurrentTasks);
  const e2eCapacity = config.role === "static" ? 0 : 1;
  const processHost = await (dependencies.createProcessHost ?? StdioProcessHostClient.create)({
    processHostPath: binaries.processHostPath,
    instanceKey: deriveWorkerProcessHostInstanceKey({ dataDirectory: config.dataDirectory }),
    maximumConcurrentRequests: staticCapacity * 2 + e2eCapacity * 6,
    hostEnvironment,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    interactiveStdin: true,
    captureResourceUsage: true,
    namedJobRecovery: true,
    onExitObservation: (observation) => {
      logger.info("Investigation native process exit observed.", { ...observation });
    },
  });
  let service: InvestigationRuntimeService | undefined;
  let closePromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let nodeFault: Error | undefined;
  let claimsStarted = false;
  let cleanupRecoveryStopping = false;
  let cleanupReplay: Promise<AttemptCleanupStatus[]> | undefined;
  let cleanupOperations: ReturnType<typeof createCleanupRecoveryOperations>;
  const recoveryActions = (): AttemptCleanupRecoveryActions => ({
    processHostRecovery: processHost.recovery?.(),
    activeAttemptIds: activeCleanupAttempts,
    async cleanupWorkspace(identity, ownership) {
      if (
        key(identity.workspaceRootDirectory) !== key(config.workspaceRootDirectory) ||
        key(identity.desktopLockDirectory) !== key(config.desktopLockDirectory)
      )
        throw new Error("The retained cleanup identity belongs to another deployment.");
      await cleanupOperations.cleanupWorkspace(identity, ownership);
    },
    async releaseGuard(identity) {
      if (key(identity.desktopLockDirectory) !== key(config.desktopLockDirectory))
        throw new Error("The retained desktop guard belongs to another deployment.");
      const recovery = processHost.recovery?.();
      if (recovery === undefined || recovery.instanceKey !== identity.processHostInstanceKey)
        throw new Error(
          "Exclusive ProcessHost ownership is required for retained desktop cleanup.",
        );
      await cleanupOperations.releaseGuard(identity);
    },
    async acknowledge(identity) {
      if (identity.serverOrigin !== config.serverUrl)
        throw new Error("The retained cleanup identity belongs to another Server origin.");
      if (transportClient.cleanup === undefined)
        throw new Error("The Worker cleanup transport is unavailable.");
      await transportClient.cleanup(
        identity.taskId,
        {
          lease: identity.lease,
          ownedProcessesStopped: true,
          desktopRestored: true,
        },
        AbortSignal.timeout(config.requestTimeoutMs),
      );
    },
  });
  replayCleanup = () => {
    if (cleanupRecoveryStopping) return Promise.resolve([]);
    cleanupReplay ??= cleanupJournal.recover(recoveryActions()).finally(() => {
      cleanupReplay = undefined;
    });
    return cleanupReplay;
  };
  const closeHost = (): Promise<void> => {
    closePromise ??= (async () => {
      cleanupRecoveryStopping = true;
      await cleanupReplay?.catch(() => undefined);
      await processHost.close();
    })();
    return closePromise;
  };
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      cleanupRecoveryStopping = true;
      const stopped = service?.stop() ?? Promise.resolve();
      try {
        await withShutdownDeadline(stopped, config.shutdownTimeoutMs);
      } catch {
        await outputJournal.stop(1_000).catch(() => false);
        usageDeliveryLifetime.abort();
        // A broken child stream must not prevent the native host from closing its owned trees.
        await closeHost();
        await withShutdownDeadline(stopped, config.shutdownTimeoutMs);
        return;
      }
      await outputJournal.stop(2_000).catch(() => false);
      usageDeliveryLifetime.abort();
      await usageReplay;
      await closeHost();
    })();
    return stopPromise;
  };
  try {
    replayOutput();
    const recoveredOwnership = processHost.recovery?.();
    if (recoveredOwnership !== undefined) {
      await usageJournal.closeInterruptedInvocations(recoveredOwnership);
      await replayUsage();
    }
    cleanupOperations = (
      dependencies.createCleanupRecoveryOperations ?? createCleanupRecoveryOperations
    )({
      processHost,
      nodeExecutablePath: process.execPath,
      entryPath: fileURLToPath(new URL("./cleanup-recovery-operations.mjs", import.meta.url)),
      workingDirectory: config.dataDirectory,
      environment: hostEnvironment,
      limits: config.processLimits,
    });
    const pendingCleanup = await replayCleanup();
    if (pendingCleanup.some((entry) => entry.state !== "acknowledged"))
      logger.warn(
        "Execution cleanup is pending. Use cleanup-recovery list to inspect required recovery actions.",
      );
    const modelEnvironment = { ...config.operatingSystemEnvironment, ...config.modelEnvironment };
    const planEnvironment = { ...config.operatingSystemEnvironment, ...config.planEnvironment };
    forbidWorkerCredential(modelEnvironment, config.workerToken);
    forbidWorkerCredential(planEnvironment, config.workerToken);
    const modelOptions: ModelTurnRunnerOptions = {
      engine: config.cli.engine,
      cliExecutablePath: binaries.cliPath,
      ...(config.cli.model === undefined ? {} : { model: config.cli.model }),
      ...(config.cli.codexTransport === undefined
        ? {}
        : { codexTransport: config.cli.codexTransport }),
      processHost,
      environment: modelEnvironment,
      limits: config.processLimits,
      staticConfiguration: config.modelStaticConfiguration,
      protectedValues: [config.workerToken],
      usageJournal,
      outputJournal,
      ...(dependencies.outputInitializationTimeoutMs === undefined
        ? {}
        : { outputInitializationTimeoutMs: dependencies.outputInitializationTimeoutMs }),
      onProcessDiagnostic: (observation) => {
        logger.info("Investigation model process lifecycle observed.", { ...observation });
      },
    };
    const modelTurnRunner = (dependencies.createModelTurnRunner ?? createModelTurnRunner)(
      modelOptions,
    );
    const e2eToolOptions: Omit<RecipePlanAdapterOptions, "createTools"> = {
      ...(config.msbuildToolchain === undefined
        ? {}
        : { msbuildToolchain: config.msbuildToolchain }),
      buildToolDigests: {
        ...(config.executables.msbuild === undefined
          ? {}
          : { msbuild: config.executables.msbuild.sha256 }),
        ...(config.executables.dotnet === undefined
          ? {}
          : { dotnet: config.executables.dotnet.sha256 }),
      },
      gitExecutablePath: binaries.gitPath,
      environment: planEnvironment,
      processLimits: config.processLimits,
      powershellExecutablePath:
        binaries.executables.powershell ??
        win32.join(
          config.operatingSystemEnvironment.SYSTEMROOT ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
      buildTools: {
        ...(binaries.executables.msbuild === undefined
          ? {}
          : { msbuild: binaries.executables.msbuild }),
        ...(binaries.executables.dotnet === undefined
          ? {}
          : { dotnet: binaries.executables.dotnet }),
      },
      ...(binaries.executables.ffmpeg === undefined
        ? {}
        : { ffmpegExecutablePath: binaries.executables.ffmpeg }),
    };
    const e2eAgentRunner = (dependencies.createE2eAgentRunner ?? createE2eAgentRunner)({
      ...e2eToolOptions,
      modelOptions,
      processHost,
    });
    const recipeAdapter = (dependencies.createRecipePlanAdapter ?? createRecipePlanAdapter)(
      e2eToolOptions,
    );
    const agentVerificationAdapter = (
      dependencies.createAgentVerificationPlanAdapter ?? createAgentVerificationPlanAdapter
    )({ ...e2eToolOptions, modelOptions });
    const modelEditAdapter = (dependencies.createModelEditAdapter ?? createModelEditAdapter)(
      modelOptions,
    );
    const uiAdapters: Record<string, InvestigationUiPlanAdapter> = {};
    for (const [id, configuration] of Object.entries(config.uiAdapters)) {
      uiAdapters[id] = (
        dependencies.createUiAdapter ??
        ((options) => new ProductionInvestigationUiPlanAdapter(options))
      )({
        configuration,
        environment: planEnvironment,
        processLimits: config.processLimits,
        executables: binaries.executables,
      });
    }
    const planExecutor = (
      dependencies.createPlanExecutor ??
      ((options) => new ProductionInvestigationPlanExecutor(options))
    )({
      executables: binaries.executables,
      environment: planEnvironment,
      processLimits: config.processLimits,
      modelEditAdapter,
      uiAdapters,
      recipeAdapter,
      agentVerificationAdapter,
    });
    const executor: InvestigationClaimExecutor = {
      async execute(claim, signal) {
        assertInvestigationClaimPool(claim);
        const pool = investigationTaskPool(claim.task.kind);
        if (
          !config.supportedKinds.includes(claim.task.kind) ||
          (config.role !== undefined && config.role !== "all" && config.role !== pool)
        )
          throw new Error("The investigation claim is outside this Worker's configured task role.");
        const outputReporter = createInvestigationOutputReporter({
          journal: outputJournal,
          taskId: claim.task.id,
          lease: claim.lease,
          initializationTimeoutMs: Math.min(
            dependencies.outputInitializationTimeoutMs ?? 1_000,
            Math.max(
              1,
              claim.task.budget.maxDurationMs - (claim.checkpoint?.consumed.durationMs ?? 0),
            ),
          ),
          onFailure: () =>
            logger.warn("Visible output collection could not initialize for this attempt."),
        });
        outputReporters.set(claim.attempt.id, outputReporter);
        try {
          await outputReporter.start(signal);
          signal.throwIfAborted();
          let cleanupIdentity: AttemptCleanupIdentity | undefined;
          const executeAttempt = async (
            cleanupHooks: Partial<AttemptDesktopCleanupHooks> = {},
          ): Promise<void> => {
            const completedSteps = claim.checkpoint?.runtime.completedSteps ?? [];
            const uncertainStep =
              claim.checkpoint?.runtime.startedSteps.some(
                (step) => !completedSteps.some((completed) => completed.stepId === step.stepId),
              ) === true;
            const previousSubject = completedSteps.at(-1)?.subjects.at(-1);
            const restorePatchSubject =
              !uncertainStep &&
              (claim.task.kind === "issue-fix" || claim.task.kind === "feature-implement") &&
              previousSubject?.kind === "local_patch"
                ? previousSubject
                : undefined;
            // The artifact reader closes over this exact claim lease, never a mutable current-task map.
            const materializer = (
              dependencies.createSourceMaterializer ??
              ((options) => new ProductionInvestigationGitSourceMaterializer(options))
            )({
              gitExecutablePath: binaries.gitPath,
              allowedRepositories: config.allowedRepositories,
              environment: config.operatingSystemEnvironment,
              limits: config.gitLimits,
              ...(restorePatchSubject === undefined ? {} : { restorePatchSubject }),
              readPatchArtifact: async (input, artifactId, artifactSignal) => {
                if (
                  input.task.id !== claim.task.id ||
                  input.attempt.id !== claim.attempt.id ||
                  input.attempt.leaseVersion !== claim.lease.fence
                )
                  throw new Error(
                    "The source artifact request does not belong to this frozen claim.",
                  );
                const response = await client.readArtifact(
                  claim.task.id,
                  { lease: claim.lease, artifactId },
                  artifactSignal,
                );
                const primary = input.task.subjects.find(
                  (item) => item.id === input.task.subjectRef,
                );
                const subject = primary?.kind === "local_patch" ? primary : restorePatchSubject;
                const bytes = Buffer.from(response.contentBase64, "base64");
                if (
                  subject?.kind !== "local_patch" ||
                  subject.artifactRef !== artifactId ||
                  response.artifact.id !== artifactId ||
                  response.artifact.subjectRef !== subject.id ||
                  response.artifact.kind !== "patch" ||
                  response.artifact.availability !== "available" ||
                  response.artifact.digest !== subject.patchDigest ||
                  response.artifact.byteLength !== bytes.byteLength ||
                  bytes.toString("base64") !== response.contentBase64 ||
                  hash(bytes) !== subject.patchDigest
                )
                  throw new Error(
                    "The trusted patch response does not match its exact frozen source subject.",
                  );
                return bytes;
              },
            });
            const workspaceProvider = (
              dependencies.createWorkspaceProvider ??
              ((options) => new ProductionInvestigationWorkspaceProvider(options))
            )({
              workspaceRootDirectory: config.workspaceRootDirectory,
              sourceMaterializer: materializer,
              maximumTreeEntries: 250_000,
              ...(investigationTaskPool(claim.task.kind) === "static"
                ? {}
                : ({
                    onOwnershipEstablished: (receipt) =>
                      cleanupJournal.workspaceOwned(claim.attempt.id, receipt),
                    cleanupOwned: async (receipt) => {
                      if (cleanupIdentity === undefined)
                        throw new Error("Execution cleanup has no durable owner.");
                      await cleanupOperations.cleanupWorkspace(cleanupIdentity, receipt);
                    },
                  } satisfies Pick<
                    ProductionInvestigationWorkspaceProviderOptions,
                    "onOwnershipEstablished" | "cleanupOwned"
                  >)),
            });
            const coordinator = (
              dependencies.createCoordinator ??
              ((options) => new InvestigationLoopCoordinator(options))
            )({
              client,
              processHost,
              modelTurnRunner,
              e2eAgentRunner,
              workspaceProvider,
              planExecutor,
              logger,
              terminalTimeoutMs: config.shutdownTimeoutMs,
              ...cleanupHooks,
              onNodeFault: (code) => {
                nodeFault ??= new Error(
                  `The investigation Worker encountered an execution lifecycle fault (${code}).`,
                );
                logger.error(
                  "The investigation Worker is draining after an execution lifecycle fault.",
                  { code },
                );
                service?.requestDrain();
              },
            });
            await coordinator.execute(claim, signal);
          };
          if (investigationTaskPool(claim.task.kind) === "static") {
            await executeAttempt();
            return;
          }
          activeCleanupAttempts.add(claim.attempt.id);
          try {
            const identity = await cleanupJournal.register({
              taskId: claim.task.id,
              attemptId: claim.attempt.id,
              workerId: claim.attempt.workerId ?? "unidentified-worker",
              serverOrigin: config.serverUrl,
              lease: claim.lease,
              guardOwnerId: `${claim.attempt.id}:${claim.lease.fence}`,
              workspaceRootDirectory: config.workspaceRootDirectory,
              desktopLockDirectory: config.desktopLockDirectory,
              processHostInstanceKey: deriveWorkerProcessHostInstanceKey({
                dataDirectory: config.dataDirectory,
              }),
              processHostRecovery: processHost.recovery?.() ?? null,
            });
            cleanupIdentity = identity;
            let physicalGuard: AttemptDesktopGuard;
            if (dependencies.acquireDesktopGuard !== undefined) {
              physicalGuard = await dependencies.acquireDesktopGuard({
                lockDirectory: config.desktopLockDirectory,
                ownerId: identity.guardOwnerId,
                ownerToken: identity.guardOwnerToken,
              });
            } else {
              await cleanupOperations.acquireGuard(identity);
              // The helper closed its handle while retaining the durable marker. This parent-side
              // object contains only logical state and cannot create, replace, or delete any file.
              let state: AttemptDesktopGuard["state"] = "held";
              physicalGuard = {
                ownerToken: identity.guardOwnerToken,
                get state() {
                  return state;
                },
                async releaseRestored() {
                  throw new Error("A managed guard requires managed release.");
                },
                async quarantine() {
                  if (state === "held") state = "quarantined";
                },
                async settleManagedCleanup(next) {
                  if (state !== "released") state = next;
                },
              };
            }
            // Filesystem release runs inside a managed helper in the native named Job. The parent
            // only closes its retained handle, so Host failure cannot leave it unlinking a new owner.
            const guard: AttemptDesktopGuard = {
              ownerToken: physicalGuard.ownerToken,
              get state() {
                return physicalGuard.state;
              },
              async releaseRestored() {
                await cleanupOperations.releaseGuard(identity);
                await physicalGuard.settleManagedCleanup("released");
              },
              async quarantine() {
                await physicalGuard.settleManagedCleanup("quarantined");
              },
              settleManagedCleanup: (state) => physicalGuard.settleManagedCleanup(state),
            };
            await executeWithAttemptDesktopGuard(guard, async (hooks) => {
              await cleanupJournal.executionStarted(claim.attempt.id);
              await executeAttempt({
                onAttemptCleanupConfirmed: async () => {
                  await cleanupJournal.localCleanupConfirmed(claim.attempt.id);
                  await hooks.onAttemptCleanupConfirmed();
                  await cleanupJournal.guardReleased(claim.attempt.id);
                },
                onAttemptCleanupUnconfirmed: async (code) => {
                  await cleanupJournal.failed(claim.attempt.id, code);
                  await hooks.onAttemptCleanupUnconfirmed(code);
                },
              });
            });
          } finally {
            activeCleanupAttempts.delete(claim.attempt.id);
          }
        } finally {
          await outputReporter.close();
          outputReporters.delete(claim.attempt.id);
          cancellationObserved.delete(claim.attempt.id);
        }
      },
    };
    service = (
      dependencies.createTaskService ?? ((options) => new InvestigationTaskService(options))
    )({
      client,
      executor,
      supportedKinds: config.supportedKinds,
      logger,
      maximumConcurrentTasks: config.maximumConcurrentTasks,
      ...(config.maximumConcurrentStaticTasks === undefined
        ? {}
        : { maximumConcurrentStaticTasks: config.maximumConcurrentStaticTasks }),
      ...(config.role === undefined ? {} : { role: config.role }),
      claimPollMs: config.claimPollMs,
    });
    return {
      processHost,
      service,
      async run() {
        claimsStarted = true;
        try {
          await service!.run();
        } finally {
          await stop();
        }
        if (nodeFault !== undefined) throw nodeFault;
      },
      stop,
      cleanupStatus: () => cleanupJournal.statuses(processHost.recovery?.()),
      async confirmCleanupRecovery(attemptId, confirmation) {
        if (
          claimsStarted ||
          cleanupRecoveryStopping ||
          activeCleanupAttempts.size !== 0 ||
          cleanupReplay !== undefined
        )
          throw new Error(
            "Operator cleanup recovery requires a dedicated runtime that has not started claiming tasks.",
          );
        cleanupReplay = (async () => {
          await cleanupJournal.confirmRecovery(attemptId, confirmation);
          return cleanupJournal.recover({ ...recoveryActions(), attemptId });
        })().finally(() => {
          cleanupReplay = undefined;
        });
        return cleanupReplay;
      },
    };
  } catch (error) {
    await outputJournal.stop(1_000).catch(() => false);
    usageDeliveryLifetime.abort();
    await closeHost();
    throw error;
  }
}

async function verifyInvestigationDeployment(
  config: InvestigationWorkerRuntimeConfig,
): Promise<InvestigationVerifiedDeployment> {
  const base = {
    trustedExecutableRoot: config.trustedExecutableRoot,
    processHost: { path: config.processHost.path, expectedSha256: config.processHost.sha256 },
    git: { path: config.git.path, expectedSha256: config.git.sha256 },
  };
  const binaries = await verifyTrustedExecutionBinaries({
    ...base,
    cli: { path: config.cli.path, expectedSha256: config.cli.sha256 },
  });
  const executables: Record<string, string> = {};
  for (const [id, spec] of Object.entries(config.executables)) {
    // The shared verifier supports deployment-managed executables outside the ProcessHost/Git root.
    const checked = await verifyTrustedExecutionBinaries({
      ...base,
      cli: { path: spec.path, expectedSha256: spec.sha256 },
    });
    executables[id] = checked.cliPath;
  }
  for (const value of Object.values(config.modelEnvironment)) {
    if (/^[A-Za-z]:[\\/]/u.test(value)) await requireOrdinaryDirectory(value, false);
  }
  return {
    processHostPath: binaries.processHostPath,
    gitPath: binaries.gitPath,
    cliPath: binaries.cliPath,
    executables,
  };
}

async function prepareInvestigationDirectories(
  config: InvestigationWorkerRuntimeConfig,
): Promise<void> {
  await requireOrdinaryDirectory(config.dataDirectory, true);
  await requireOrdinaryDirectory(config.workspaceRootDirectory, true);
  await requireOrdinaryDirectory(win32.join(config.dataDirectory, "host-temp"), true);
  await requireOrdinaryDirectory(win32.join(config.dataDirectory, "model-usage"), true);
  await requireOrdinaryDirectory(win32.join(config.dataDirectory, "visible-output"), true);
  await requireOrdinaryDirectory(win32.join(config.dataDirectory, "attempt-cleanup"), true);
  if (
    config.role !== "static" &&
    config.supportedKinds.some((kind) => investigationTaskPool(kind) === "e2e")
  ) {
    const lockDirectory = config.desktopLockDirectory ?? defaultInvestigationDesktopLockDirectory();
    for (const root of [config.dataDirectory, config.trustedExecutableRoot]) {
      if (
        key(lockDirectory) === key(root) ||
        key(lockDirectory).startsWith(`${key(root)}\\`) ||
        key(root).startsWith(`${key(lockDirectory)}\\`)
      )
        throw new Error(
          "The machine execution lock directory must be separate from Worker data and trusted binaries.",
        );
    }
    await requireOrdinaryDirectory(lockDirectory, true);
  }
  for (const configuration of Object.values(config.uiAdapters)) {
    if (configuration.desktopLockDirectory !== undefined) {
      if (
        key(configuration.desktopLockDirectory).startsWith(
          `${key(config.workspaceRootDirectory)}\\`,
        ) ||
        key(configuration.desktopLockDirectory) === key(config.workspaceRootDirectory)
      )
        throw new Error("The desktop lease directory must remain outside attempt workspaces.");
      await requireOrdinaryDirectory(configuration.desktopLockDirectory, true);
    }
  }
}

/** Walk each ancestor before creation. Never traverse reparse points or create recursively. */
async function requireOrdinaryDirectory(path: string, create: boolean): Promise<void> {
  assertWindowsLocalAbsolutePath(path, "investigation runtime directory", false);
  const normalized = win32.normalize(path);
  const root = win32.parse(normalized).root;
  const parts = win32.relative(root, normalized).split("\\").filter(Boolean);
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = win32.join(current, parts[index]!);
    let state: Stats;
    try {
      state = await lstat(current);
    } catch (error) {
      if (!create || !hasCode(error, "ENOENT") || index < 0) throw error;
      try {
        await mkdir(current, { recursive: false });
      } catch (creationError) {
        // Multiple role processes can initialize the shared machine lock root concurrently.
        if (!hasCode(creationError, "EEXIST")) throw creationError;
      }
      state = await lstat(current);
    }
    const reparseAware = state as typeof state & { isReparsePoint?(): boolean };
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      reparseAware.isReparsePoint?.() === true ||
      key(await realpath(current)) !== key(current)
    )
      throw new Error(
        "An investigation runtime directory is not an ordinary canonical local directory.",
      );
  }
}

function forbidWorkerCredential(
  environment: Readonly<Record<string, string>>,
  token: string,
): void {
  if (
    Object.entries(environment).some(
      ([name, value]) => name.toUpperCase().startsWith("INVESTIGATION_") || value.includes(token),
    )
  )
    throw new Error(
      "A Worker child environment cannot contain its service credential or configuration variables.",
    );
}
function key(path: string): string {
  return win32
    .normalize(path)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
async function withShutdownDeadline(operation: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Investigation Worker shutdown did not settle within its configured deadline.",
              ),
            ),
          milliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
