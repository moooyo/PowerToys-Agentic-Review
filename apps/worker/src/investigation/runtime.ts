import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { win32 } from "node:path";
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
  type InvestigationModelEditAdapter,
  type InvestigationPlanExecutor,
  type InvestigationUiPlanAdapter,
  ProductionInvestigationPlanExecutor,
  type ProductionInvestigationPlanExecutorOptions,
} from "./plan-executor.js";
import type { InvestigationWorkerRuntimeConfig } from "./runtime-config.js";
import {
  type InvestigationClaimExecutor,
  InvestigationTaskService,
  type InvestigationTaskServiceOptions,
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
  readonly prepareDirectories?: (config: InvestigationWorkerRuntimeConfig) => Promise<void>;
  readonly verifyDeployment?: (
    config: InvestigationWorkerRuntimeConfig,
  ) => Promise<InvestigationVerifiedDeployment>;
  readonly createProcessHost?: (
    options: StdioProcessHostClientOptions,
  ) => Promise<ProcessHostClient>;
  readonly createClient?: (options: InvestigationHttpClientOptions) => InvestigationWorkerClient;
  readonly createModelTurnRunner?: (options: ModelTurnRunnerOptions) => ModelTurnRunner;
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
  readonly createTaskService?: (
    options: InvestigationTaskServiceOptions,
  ) => InvestigationRuntimeService;
}

export interface InvestigationExecutionRuntime {
  readonly processHost: ProcessHostClient;
  readonly service: InvestigationRuntimeService;
  run(): Promise<void>;
  stop(): Promise<void>;
}

/** Constructs the production Task runtime without any Task-to-Job envelope conversion. */
export async function createInvestigationExecutionRuntime(
  suppliedConfig: InvestigationWorkerRuntimeConfig,
  logger: Logger,
  dependencies: InvestigationRuntimeDependencies = {},
): Promise<InvestigationExecutionRuntime> {
  const config = structuredClone(suppliedConfig);
  if (!config.modelStaticConfiguration.verified)
    throw new Error(
      "The deployment must verify its isolated static CLI configuration before starting the investigation Worker.",
    );
  await (dependencies.prepareDirectories ?? prepareInvestigationDirectories)(config);
  const binaries = await (dependencies.verifyDeployment ?? verifyInvestigationDeployment)(config);
  const client = (dependencies.createClient ?? createInvestigationHttpClient)({
    serverUrl: config.serverUrl,
    workerToken: config.workerToken,
    allowInsecureHttp: config.allowInsecureHttp,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const hostEnvironment = {
    ...config.operatingSystemEnvironment,
    TEMP: win32.join(config.dataDirectory, "host-temp"),
    TMP: win32.join(config.dataDirectory, "host-temp"),
  };
  forbidWorkerCredential(hostEnvironment, config.workerToken);
  const processHost = await (dependencies.createProcessHost ?? StdioProcessHostClient.create)({
    processHostPath: binaries.processHostPath,
    instanceKey: deriveWorkerProcessHostInstanceKey({ dataDirectory: config.dataDirectory }),
    maximumConcurrentRequests: config.maximumConcurrentTasks * 2,
    hostEnvironment,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    interactiveStdin: true,
    captureResourceUsage: true,
  });
  let service: InvestigationRuntimeService | undefined;
  let closePromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const closeHost = (): Promise<void> => {
    closePromise ??= processHost.close();
    return closePromise;
  };
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      const stopped = service?.stop() ?? Promise.resolve();
      try {
        await withShutdownDeadline(stopped, config.shutdownTimeoutMs);
      } catch {
        // A broken child stream must not prevent the native host from closing its owned trees.
        await closeHost();
        await withShutdownDeadline(stopped, config.shutdownTimeoutMs);
        return;
      }
      await closeHost();
    })();
    return stopPromise;
  };
  try {
    const modelEnvironment = { ...config.operatingSystemEnvironment, ...config.modelEnvironment };
    const planEnvironment = { ...config.operatingSystemEnvironment, ...config.planEnvironment };
    forbidWorkerCredential(modelEnvironment, config.workerToken);
    forbidWorkerCredential(planEnvironment, config.workerToken);
    const modelOptions: ModelTurnRunnerOptions = {
      engine: config.cli.engine,
      cliExecutablePath: binaries.cliPath,
      ...(config.cli.model === undefined ? {} : { model: config.cli.model }),
      processHost,
      environment: modelEnvironment,
      limits: config.processLimits,
      staticConfiguration: config.modelStaticConfiguration,
      protectedValues: [config.workerToken],
    };
    const modelTurnRunner = (dependencies.createModelTurnRunner ?? createModelTurnRunner)(
      modelOptions,
    );
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
    });
    const executor: InvestigationClaimExecutor = {
      async execute(claim, signal) {
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
        // The artifact reader closes over this exact claim lease, never a mutable global current-task map.
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
              throw new Error("The source artifact request does not belong to this frozen claim.");
            const response = await client.readArtifact(
              claim.task.id,
              { lease: claim.lease, artifactId },
              artifactSignal,
            );
            const primary = input.task.subjects.find((item) => item.id === input.task.subjectRef);
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
        });
        const coordinator = (
          dependencies.createCoordinator ?? ((options) => new InvestigationLoopCoordinator(options))
        )({
          client,
          processHost,
          modelTurnRunner,
          workspaceProvider,
          planExecutor,
          logger,
          terminalTimeoutMs: config.shutdownTimeoutMs,
          onNodeFault: (code) => {
            logger.error(
              "The investigation Worker is draining after an execution lifecycle fault.",
              { code },
            );
            service?.requestDrain();
            void stop().catch(() => {
              logger.error(
                "Investigation Worker shutdown could not confirm complete process closure.",
              );
            });
          },
        });
        await coordinator.execute(claim, signal);
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
      claimPollMs: config.claimPollMs,
    });
    return {
      processHost,
      service,
      async run() {
        try {
          await service!.run();
        } finally {
          await stop();
        }
      },
      stop,
    };
  } catch (error) {
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
      await mkdir(current, { recursive: false });
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
