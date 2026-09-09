import type { JobExecutionEnvelopeV2 } from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig, WorkerExecutionConfig } from "./config.js";
import type { PreparedEvaluationModelRuntime } from "./execution/evaluation-model-runtime.js";
import type { JobExecutionContext } from "./execution/job-executor.js";
import type { PreparedJobWorkspace } from "./execution/job-workspace.js";
import { modelArtifactEvaluationFixture } from "./execution/model-output-artifact.testing.js";
import type { PreparedCodexOutputRunnerOptions } from "./execution/prepared-codex-output-runner.js";
import type { ProfileJobExecutorOptions } from "./execution/profile-job-executor.js";
import type { UiProfileRunnerOptions } from "./execution/ui-profile-runner.js";
import type { HeadlessValidationCheckRunnerOptions } from "./execution/validation-check-runner.js";
import type {
  ValidationRuntimeConfig,
  ValidationRuntimeTrustedDefaults,
} from "./execution/validation-runtime-config.js";
import type { ValidationSummaryExecutorOptions } from "./execution/validation-summary-executor.js";
import type { ConsoleJsonLogger } from "./logging/logger.js";

const state = vi.hoisted(() => ({
  close: vi.fn(async (): Promise<void> => undefined),
  createHost: vi.fn(),
  prepareModel: vi.fn(),
  loadRelayProfile: vi.fn(),
  loadProvider: vi.fn(),
  verifyHome: vi.fn(),
  verifyBinaries: vi.fn(),
  prepare: vi.fn(),
  sweep: vi.fn(async () => ({ removedBytes: 0n })),
  capacity: vi.fn(async () => true),
  session: vi.fn(),
  observations: vi.fn(),
  validation: undefined as ValidationRuntimeConfig | undefined,
  defaults: undefined as ValidationRuntimeTrustedDefaults | undefined,
  providerEnvironment: {} as Record<string, string>,
  providerProtectedValues: undefined as readonly string[] | undefined,
  profileOptions: undefined as ProfileJobExecutorOptions | undefined,
  headlessOptions: [] as HeadlessValidationCheckRunnerOptions[],
  uiCommandOptions: [] as HeadlessValidationCheckRunnerOptions[],
  uiOptions: [] as UiProfileRunnerOptions[],
  reviewOptions: [] as unknown[],
  summaryOptions: [] as ValidationSummaryExecutorOptions[],
  preparedOptions: [] as PreparedCodexOutputRunnerOptions[],
  workspaceRoots: [] as string[],
}));

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(async () => undefined),
  realpath: vi.fn(async (path: string) => path),
  lstat: vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false })),
}));
vi.mock("./execution/codex-provider-profile.js", () => ({
  loadCodexRelayProviderProfile: state.loadRelayProfile,
  loadCodexProviderProfile: state.loadProvider,
}));
vi.mock("./execution/evaluation-model-runtime.js", () => ({
  prepareEvaluationModelRuntime: state.prepareModel,
}));
vi.mock("./execution/persistent-codex-home.js", () => ({
  verifyPersistentCodexHome: state.verifyHome,
}));
vi.mock("./execution/trusted-binary.js", () => ({
  verifyTrustedExecutionBinaries: state.verifyBinaries,
}));
vi.mock("./execution/process-host-client.js", () => ({
  deriveWorkerProcessHostInstanceKey: () => "fixture-host",
  StdioProcessHostClient: { create: state.createHost },
}));
vi.mock("./execution/workspace-disk-budget.js", () => ({
  ProductionWorkspaceDiskBudget: class {
    recoverOrphans = state.sweep;
    hasCapacity = state.capacity;
  },
}));
vi.mock("./execution/job-workspace.js", () => ({
  ProductionDisposableJobWorkspaceProvider: class {},
}));
vi.mock("./execution/job-executor.js", () => ({
  PlaceholderJobExecutor: class {},
  ReviewJobExecutor: class {
    constructor(options: unknown) {
      state.reviewOptions.push(options);
    }
  },
}));
vi.mock("./execution/profile-job-executor.js", () => ({
  ProfileJobExecutor: class {
    constructor(options: ProfileJobExecutorOptions) {
      state.profileOptions = options;
    }
  },
}));
vi.mock("./execution/prepared-codex-output-runner.js", () => ({
  PreparedCodexOutputRunner: class {
    constructor(options: PreparedCodexOutputRunnerOptions) {
      state.preparedOptions.push(options);
    }
  },
}));
vi.mock("./execution/validation-summary-executor.js", () => ({
  ValidationSummaryExecutor: class {
    constructor(options: ValidationSummaryExecutorOptions) {
      state.summaryOptions.push(options);
    }
  },
}));
vi.mock("./execution/validation-runtime-config.js", () => ({
  loadValidationRuntimeConfig: (
    _environment: unknown,
    defaults: ValidationRuntimeTrustedDefaults,
  ) => {
    state.defaults = defaults;
    return state.validation;
  },
  prepareValidationRuntime: state.prepare,
  createValidationWorkspaceResolvers: (_config: unknown, checkout: string) => {
    state.workspaceRoots.push(checkout);
    return {
      resolveExecutable: vi.fn(async () => `${checkout}\\resolved.exe`),
      resolveSecret: vi.fn(async () => "fixture secret"),
    };
  },
}));
vi.mock("./execution/validation-check-runner.js", () => ({
  HeadlessValidationCheckRunner: class {
    constructor(options: HeadlessValidationCheckRunnerOptions) {
      state.headlessOptions.push(options);
    }
  },
  createUiCommandBridge: (_profile: unknown, options: HeadlessValidationCheckRunnerOptions) => {
    state.uiCommandOptions.push(options);
    return {};
  },
}));
vi.mock("./execution/ui-profile-runner.js", () => ({
  runWindowsSessionProbe: state.session,
  runUiObservationProbe: state.observations,
  UiProfileRunner: class {
    constructor(options: UiProfileRunnerOptions) {
      state.uiOptions.push(options);
    }
  },
}));
vi.mock("./execution/evidence-uploader.js", () => ({ EvidenceUploader: class {} }));
vi.mock("./server-client/evidence-api.js", () => ({ HttpWorkerEvidenceApi: class {} }));

import { createExecutionRuntime } from "./main.js";

describe("evaluation model production composition", () => {
  function enabledModelConfig(summary = false): WorkerConfig {
    const current = config();
    if (current.execution === undefined || current.execution.modelExecutionEnabled === false)
      throw new Error("Missing fixture execution settings.");
    return {
      ...current,
      execution: {
        ...current.execution,
        codexVersion: "0.145.0",
        evaluationModel: {
          backend: "app_server",
          workerBundleSha256: "d".repeat(64),
          nodeExecutableSha256: "e".repeat(64),
          reviewLaunchPolicySha256: "f".repeat(64),
          ...(summary ? { summaryLaunchPolicySha256: "2".repeat(64) } : {}),
        },
      },
    };
  }
  it("leaves the parent relay loader and interactive stdin absent by default", async () => {
    await createExecutionRuntime(config(), logger);
    expect(state.prepareModel).not.toHaveBeenCalled();
    expect(state.loadRelayProfile).not.toHaveBeenCalled();
    expect(state.createHost.mock.calls[0]?.[0]).not.toHaveProperty("interactiveStdin");
  });
  it("passes actual startup inputs to the composer and selects the binding only for evaluation", async () => {
    const api = {
      beginModelInvocation: vi.fn(),
      sealModelInvocation: vi.fn(),
      submitModelInvocationReceipts: vi.fn(),
    };
    const binding: PreparedEvaluationModelRuntime = {
      implementationSha256: "1".repeat(64),
      review: {
        modelInvocationBackend: { kind: "app_server", codexExecutableSha256: "b".repeat(64) },
        createModelInvocation: vi.fn(),
        codexProviderProtectedValues: ["synthetic-upstream-secret"],
      },
    };
    const provider = { state: "supported", declared: { providerId: "synthetic-provider" } };
    state.loadRelayProfile.mockResolvedValue(provider);
    state.prepareModel.mockResolvedValue(binding);
    state.providerEnvironment = { CODEX_PROVIDER_HEADER_0: "synthetic-upstream-secret" };
    const runtime = await createExecutionRuntime(enabledModelConfig(), logger, api);
    expect(state.prepareModel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        api,
        provider,
        nodeExecutablePath: process.execPath,
        nodeVersion: process.versions.node,
        processEntryPath: process.argv[1],
        codexMeasurement: { sha256: "b".repeat(64) },
      }),
    );
    expect(state.createHost.mock.calls[0]?.[0]).toMatchObject({ interactiveStdin: true });
    expect(runtime.capabilities.labels.validationEvaluation).toBeUndefined();
    const workspaceProvider = {} as ProfileJobExecutorOptions["workspaceProvider"];
    state.profileOptions?.createModelExecutor?.(
      workspaceProvider,
      {} as JobExecutionEnvelopeV2,
      context(),
    );
    expect(state.reviewOptions.at(-1)).toMatchObject({
      codexProviderEnvironment: state.providerEnvironment,
    });
    expect(state.reviewOptions.at(-1)).not.toHaveProperty("createModelInvocation");
    state.profileOptions?.createModelExecutor?.(
      workspaceProvider,
      modelArtifactEvaluationFixture().envelope,
      context(),
    );
    expect(state.reviewOptions.at(-1)).toMatchObject({ ...binding.review, workspaceProvider });
    expect(state.reviewOptions.at(-1)).not.toHaveProperty("codexProviderEnvironment");
    expect(state.reviewOptions.at(-1)).not.toHaveProperty("codexConfigurationOverrides");
    expect(binding.review.createModelInvocation).not.toHaveBeenCalled();
    expect(api.beginModelInvocation).not.toHaveBeenCalled();
  });
  it("refuses composition failure before starting the ProcessHost", async () => {
    state.loadRelayProfile.mockResolvedValue({ state: "unsupported", reason: "PROFILE_MISSING" });
    state.prepareModel.mockRejectedValue(new Error("Synthetic startup rejection."));
    await expect(createExecutionRuntime(enabledModelConfig(), logger)).rejects.toThrow(
      "Synthetic startup rejection",
    );
    expect(state.createHost).not.toHaveBeenCalled();
  });
  it("does not fall back for unconfigured evaluation review or summary", async () => {
    state.validation = { ...validation(), summary: { maximumTimeoutMs: 45_000 } };
    await createExecutionRuntime(config(), logger);
    const evaluation = modelArtifactEvaluationFixture().envelope;
    const count = state.reviewOptions.length;
    expect(() =>
      state.profileOptions?.createModelExecutor?.(
        {} as ProfileJobExecutorOptions["workspaceProvider"],
        evaluation,
        context(),
      ),
    ).toThrow("not configured");
    expect(state.reviewOptions).toHaveLength(count);
    expect(() =>
      state.profileOptions?.createSummaryExecutor?.(
        modelArtifactEvaluationFixture("issue").envelope,
        context(),
      ),
    ).toThrow("not configured");
    expect(state.summaryOptions).toHaveLength(0);
  });
  it.each([true, false])(
    "connects the pinned evaluation summary with ordinary summaries enabled=%s",
    async (ordinarySummaryEnabled) => {
      state.validation = {
        ...validation(),
        ...(ordinarySummaryEnabled ? { summary: { maximumTimeoutMs: 45000 } } : {}),
      };
      const createSummaryModelInvocation = vi.fn();
      const binding: PreparedEvaluationModelRuntime = {
        implementationSha256: "1".repeat(64),
        review: {
          modelInvocationBackend: { kind: "app_server", codexExecutableSha256: "b".repeat(64) },
          createModelInvocation: vi.fn(),
          codexProviderProtectedValues: ["synthetic-secret"],
        },
        summary: {
          modelInvocationBackend: { kind: "app_server", codexExecutableSha256: "b".repeat(64) },
          createSummaryModelInvocation,
          codexProviderProtectedValues: ["synthetic-secret"],
        },
      };
      state.prepareModel.mockResolvedValue(binding);
      state.loadRelayProfile.mockResolvedValue({ state: "supported" });
      const freezeValidationSummaryInput = vi.fn();
      const api = {
        beginModelInvocation: vi.fn(),
        sealModelInvocation: vi.fn(),
        submitModelInvocationReceipts: vi.fn(),
        freezeValidationSummaryInput,
      };
      const runtime = await createExecutionRuntime(enabledModelConfig(true), logger, api);
      expect(
        state.prepareModel.mock.calls[0]?.[0].summaryInputApi.freezeValidationSummaryInput,
      ).toBeTypeOf("function");
      state.profileOptions?.createSummaryExecutor?.(
        modelArtifactEvaluationFixture("issue").envelope,
        context(),
      );
      expect(state.summaryOptions.at(-1)).toMatchObject({
        createSummaryModelInvocation,
        sensitiveValues: ["synthetic-secret"],
        ...(ordinarySummaryEnabled ? { maximumSummaryTimeoutMs: 45000 } : {}),
      });
      expect(state.preparedOptions.at(-1)).toMatchObject({
        modelInvocationBackend: binding.summary?.modelInvocationBackend,
        codexProviderProtectedValues: ["synthetic-secret"],
      });
      expect(state.preparedOptions.at(-1)).not.toHaveProperty("codexProviderEnvironment");
      expect(state.preparedOptions.at(-1)).not.toHaveProperty("codexConfigurationOverrides");
      expect(runtime.capabilities.labels.validationEvaluation).toBeUndefined();
      expect(createSummaryModelInvocation).not.toHaveBeenCalled();
      expect(freezeValidationSummaryInput).not.toHaveBeenCalled();
      if (!ordinarySummaryEnabled) {
        expect(state.summaryOptions.at(-1)).not.toHaveProperty("maximumSummaryTimeoutMs");
        const count = state.summaryOptions.length;
        expect(state.profileOptions?.optionalSummariesEnabled).toBe(false);
        expect(
          state.profileOptions?.createSummaryExecutor?.({} as JobExecutionEnvelopeV2, context()),
        ).toBeUndefined();
        expect(state.summaryOptions).toHaveLength(count);
      }
    },
  );
  it("rejects direct model factory selection for every profile-only evaluation", async () => {
    state.validation = { ...validation(), summary: { maximumTimeoutMs: 45000 } };
    await createExecutionRuntime(config(), logger);
    const reviewCount = state.reviewOptions.length;
    for (const workflowKind of [
      "pr_static_build",
      "issue_triage",
      "pr_ui",
      "issue_validation",
    ] as const) {
      const input = modelArtifactEvaluationFixture().envelope;
      input.validation.workflowKind = workflowKind;
      input.validation.modelRequirements = { required: false, expectedModelIdentityDigest: null };
      delete input.validation.modelRuntimeRegistration;
      expect(() =>
        state.profileOptions?.createModelExecutor?.(
          {} as ProfileJobExecutorOptions["workspaceProvider"],
          input,
          context(),
        ),
      ).toThrow("does not request a model review");
      expect(() => state.profileOptions?.createSummaryExecutor?.(input, context())).toThrow(
        "does not request a model summary",
      );
    }
    expect(state.reviewOptions).toHaveLength(reviewCount);
    expect(state.summaryOptions).toHaveLength(0);
    expect(state.preparedOptions).toHaveLength(0);
  });
});

describe("deployed UI observation protocol admission", () => {
  it("requires every configured driver to pass its actual protocol handshake", async () => {
    state.validation = {
      ...validation("web"),
      ...validation("windows"),
      web: validation("web").web,
    } as ValidationRuntimeConfig;
    state.observations.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const runtime = await createExecutionRuntime(config(), logger);
    expect(state.observations.mock.calls.map((call) => call[4])).toEqual([
      "web",
      "windows_desktop",
    ]);
    expect(runtime.capabilities.labels.uiAssertionObservation).toBeUndefined();
    expect(runtime.capabilities.labels.validationWeb).toBe("1");
    expect(runtime.capabilities.labels.validationWindowsDesktop).toBe("1");
  });

  it("withholds only the new protocol when an old driver rejects its feature probe", async () => {
    state.validation = validation("web");
    state.observations.mockRejectedValueOnce(new Error("Unsupported request schema."));
    const runtime = await createExecutionRuntime(config(), logger);
    expect(runtime.capabilities.labels.uiAssertionObservation).toBeUndefined();
    expect(runtime.capabilities.labels.validationWeb).toBe("1");
    expect(runtime.capabilities.labels.structuredProbeOutput).toBe("1");
  });
});

function config(): WorkerConfig {
  const execution = {
    trustedExecutableRoot: "C:\\Trusted",
    processHostPath: "C:\\Trusted\\host.exe",
    processHostSha256: "a".repeat(64),
    codexExecutablePath: "C:\\Trusted\\codex.exe",
    codexSha256: "b".repeat(64),
    codexVersion: "codex-pinned",
    gitExecutablePath: "C:\\Trusted\\git.exe",
    gitSha256: "c".repeat(64),
    gitSharedRootDirectory: "C:\\WorkerData\\Repositories",
    workspaceRootDirectory: "C:\\WorkerData\\Workspaces",
    tempDirectory: "C:\\WorkerData\\Temp",
    profileDirectory: "C:\\WorkerData\\Profile",
    processHostRequestTimeoutMs: 15_000,
    processHostStartTimeoutMs: 30_000,
    processHostShutdownTimeoutMs: 15_000,
    codexMaximumHardTimeoutMs: 60_000,
    gitHardTimeoutMs: 60_000,
    codexResourceLimits: {
      maximumProcessCount: 32,
      maximumMemoryBytes: 8 * 1_024 ** 3,
      maximumOutputBytes: 8 * 1_024 ** 2,
    },
    gitResourceLimits: {
      maximumProcessCount: 8,
      maximumMemoryBytes: 1_024 ** 3,
      maximumOutputBytes: 1_024 ** 2,
    },
    totalResourceBudget: {
      maximumProcessCount: 64,
      maximumMemoryBytes: 16 * 1_024 ** 3,
      maximumOutputBytes: 64 * 1_024 ** 2,
    },
    perAttemptDiskBytes: 1_024 ** 3,
    totalWorkspaceDiskBytes: 2 * 1_024 ** 3,
    minimumFreeDiskBytes: 1_024 ** 2,
    diskScanEntryLimit: 1000,
    diskScanTimeoutMs: 30000,
    orphanScanLimit: 10,
    gitSharedCacheMaxBytes: 1_024 ** 3,
    gitSharedMinimumFreeDiskBytes: 1_024 ** 2,
    gitSharedScanEntryLimit: 1000,
    gitSharedScanTimeoutMs: 30000,
    gitSharedGcMinimumIntervalMinutes: 60,
    gitSharedGcPruneAgeHours: 168,
  } satisfies WorkerExecutionConfig;
  return {
    serverUrl: new URL("http://127.0.0.1:8080"),
    protocolVersion: "1.0",
    workerNodeId: "fixture-node",
    workerToken: `arw1_${"a".repeat(42)}A`,
    displayName: "Fixture Worker",
    workerVersion: "0.1.0",
    claimWaitSeconds: 30,
    registrationRetrySeconds: 10,
    idleDelayMilliseconds: 1000,
    heartbeatIntervalSeconds: 20,
    heartbeatSafetyMarginSeconds: 20,
    shutdownGraceSeconds: 90,
    requestTimeoutSeconds: 30,
    logLevel: "info",
    allowInsecureHttp: true,
    executionEnabled: true,
    execution,
    dataDirectory: "C:\\WorkerData",
    maxSlots: 1,
    capabilities: {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      codexVersion: "codex-pinned",
      recipeIds: [],
      labels: { site: "fixture", validationWindowsDesktop: "1", "ui:windows_desktop": "1" },
    },
  };
}
function validation(ui?: "web" | "windows"): ValidationRuntimeConfig {
  return {
    headlessEnabled: true,
    cleanupTimeoutMs: 30_000,
    bundleDirectory: "C:\\WorkerBundle\\dist",
    untrustedDirectories: [],
    executables: [],
    secretFiles: {},
    ...(ui === "web"
      ? {
          web: {
            browserExecutablePath: "C:\\Browser\\browser.exe",
            nodeExecutablePath: "C:\\Tools\\node.exe",
            driverEntryPath: "C:\\WorkerBundle\\dist\\web-driver.mjs",
            powerShellExecutablePath:
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            windowsProbeEntryPath: "C:\\WorkerBundle\\dist\\windows-driver-entry.ps1",
          },
        }
      : {}),
    ...(ui === "windows"
      ? {
          windows: {
            powerShellExecutablePath:
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            driverEntryPath: "C:\\WorkerBundle\\dist\\windows-driver-entry.ps1",
            desktopLockDirectory: "C:\\SharedDesktopLock",
          },
        }
      : {}),
  };
}
function workspace(id: string): PreparedJobWorkspace {
  return {
    checkoutDirectory: `C:\\Workspaces\\${id}\\checkout`,
    controlDirectory: `C:\\Workspaces\\${id}\\control`,
    tempDirectory: `C:\\Workspaces\\${id}\\temp`,
    userProfileDirectory: `C:\\Workspaces\\${id}\\user`,
  } as PreparedJobWorkspace;
}
function context(): JobExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: vi.fn(),
    reportNodeHealthFault: vi.fn(),
  } as unknown as JobExecutionContext;
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ConsoleJsonLogger;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SYSTEMROOT", "C:\\Windows");
  vi.stubEnv("COMSPEC", "C:\\Untrusted\\cmd.exe");
  vi.stubEnv("PATH", "C:\\Windows\\System32;C:\\Tools");
  vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
  state.validation = validation();
  state.defaults = undefined;
  state.providerEnvironment = {};
  state.providerProtectedValues = undefined;
  state.profileOptions = undefined;
  state.headlessOptions.length = 0;
  state.uiCommandOptions.length = 0;
  state.uiOptions.length = 0;
  state.reviewOptions.length = 0;
  state.summaryOptions.length = 0;
  state.preparedOptions.length = 0;
  state.workspaceRoots.length = 0;
  state.close.mockResolvedValue(undefined);
  state.createHost.mockResolvedValue({ close: state.close });
  state.prepareModel.mockReset();
  state.loadRelayProfile.mockReset();
  state.loadProvider.mockReset().mockImplementation(async () => ({
    configurationOverrides: [],
    providerEnvironment: state.providerEnvironment,
    protectedValues: state.providerProtectedValues ?? Object.values(state.providerEnvironment),
  }));
  state.verifyHome.mockReset().mockResolvedValue("C:\\WorkerData\\Profile");
  state.verifyBinaries.mockReset().mockImplementation(async (options) => ({
    processHostPath: "C:\\Trusted\\host.exe",
    gitPath: "C:\\Trusted\\git.exe",
    ...(options.codex === undefined
      ? { measurements: {} }
      : {
          codexPath: "C:\\Trusted\\codex.exe",
          measurements: { codex: { sha256: "b".repeat(64) } },
        }),
  }));
  state.prepare.mockImplementation(async (value) => value);
  state.sweep.mockResolvedValue({ removedBytes: 0n });
  state.capacity.mockResolvedValue(true);
  state.observations.mockReset().mockResolvedValue(true);
  state.session.mockResolvedValue({
    schemaVersion: "WindowsSessionProbeResultV1",
    available: true,
    sessionId: 2,
    reasonCode: "ready",
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("validation-only production startup", () => {
  function validationOnly(): WorkerConfig {
    const current = config(),
      settings = current.execution;
    if (settings === undefined || settings.modelExecutionEnabled === false)
      throw new Error("Missing model fixture.");
    const {
      codexExecutablePath: _path,
      codexSha256: _sha,
      codexVersion: _version,
      profileDirectory: _profile,
      evaluationModel: _evaluation,
      codexResourceLimits,
      codexMaximumHardTimeoutMs,
      ...common
    } = settings;
    return {
      ...current,
      modelExecutionEnabled: false,
      execution: {
        ...common,
        modelExecutionEnabled: false,
        validationResourceLimits: codexResourceLimits,
        validationMaximumHardTimeoutMs: codexMaximumHardTimeoutMs,
      },
    };
  }
  it.each(["headless", "web", "windows"] as const)(
    "prepares %s without persistent model files, binaries, or factories",
    async (target) => {
      state.validation = validation(target === "headless" ? undefined : target);
      state.verifyHome.mockRejectedValue(new Error("Model HOME must not be touched."));
      state.loadProvider.mockRejectedValue(new Error("Provider must not be read."));
      const runtime = await createExecutionRuntime(validationOnly(), logger);
      expect(state.verifyHome).not.toHaveBeenCalled();
      expect(state.loadProvider).not.toHaveBeenCalled();
      expect(state.loadRelayProfile).not.toHaveBeenCalled();
      expect(state.prepareModel).not.toHaveBeenCalled();
      expect(state.verifyBinaries.mock.calls[0]?.[0]).not.toHaveProperty("codex");
      expect(state.defaults?.executables.some((entry) => entry.name === "codex")).toBe(false);
      expect(state.reviewOptions).toEqual([]);
      expect(state.summaryOptions).toEqual([]);
      expect(state.preparedOptions).toEqual([]);
      expect(state.profileOptions?.createModelExecutor).toBeUndefined();
      expect(state.profileOptions?.createSummaryExecutor).toBeUndefined();
      expect(state.profileOptions?.modelExecutionEnabled).toBe(false);
      expect(runtime.capabilities.codexVersion).toBe("not-configured");
      expect(runtime.capabilities.labels.modelExecution).toBe("disabled");
      expect(runtime.capabilities.labels.validationEvaluation).toBeUndefined();
      expect(state.createHost.mock.calls[0]?.[0]).not.toHaveProperty("interactiveStdin");
      if (target === "windows") {
        expect(state.session).toHaveBeenCalledOnce();
        expect(runtime.capabilities.interactiveDesktop).toBe(true);
        expect(runtime.capabilities.labels.validationWindowsDesktop).toBe("1");
      }
      if (target === "web") expect(runtime.capabilities.labels.validationWeb).toBe("1");
      const { mkdir } = await import("node:fs/promises");
      expect(vi.mocked(mkdir).mock.calls.some(([path]) => String(path).includes("Profile"))).toBe(
        false,
      );
      expect(await runtime.canAcceptWork?.(new AbortController().signal)).toBe(true);
      await runtime.processHost.close();
      expect(state.close).toHaveBeenCalledOnce();
    },
  );
  it.each(["WORKER_VALIDATION_SUMMARY_ENABLED", "WORKER_EVALUATION_MODEL_BACKEND"])(
    "rejects %s before filesystem or native startup",
    async (name) => {
      vi.stubEnv(name, name.endsWith("ENABLED") ? "true" : "app_server");
      await expect(createExecutionRuntime(validationOnly(), logger)).rejects.toThrow(
        /Model execution is disabled/u,
      );
      const { mkdir, realpath } = await import("node:fs/promises");
      expect(mkdir).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
      expect(state.verifyBinaries).not.toHaveBeenCalled();
      expect(state.createHost).not.toHaveBeenCalled();
    },
  );
  it("closes the shared ProcessHost after validation-only startup fails", async () => {
    state.sweep.mockRejectedValue(new Error("Synthetic sweep failure."));
    await expect(createExecutionRuntime(validationOnly(), logger)).rejects.toThrow(
      "Synthetic sweep failure",
    );
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.verifyHome).not.toHaveBeenCalled();
  });
  it("retains the disabled mode across asynchronous startup even if the caller mutates its settings", async () => {
    const settings = validationOnly();
    const { realpath } = await import("node:fs/promises");
    vi.mocked(realpath).mockImplementationOnce(async () => {
      if (settings.execution === undefined) throw new Error("Missing fixture settings.");
      Reflect.set(settings.execution, "modelExecutionEnabled", true);
      Reflect.set(settings.execution, "profileDirectory", "C:\\DoNotRead\\Profile");
      return settings.dataDirectory;
    });
    await createExecutionRuntime(settings, logger);
    expect(state.verifyHome).not.toHaveBeenCalled();
    expect(state.loadProvider).not.toHaveBeenCalled();
    expect(state.profileOptions?.modelExecutionEnabled).toBe(false);
    expect(state.verifyBinaries.mock.calls[0]?.[0]).not.toHaveProperty("codex");
  });
});

describe("Worker production execution composition", () => {
  it("clears forged execution claims and does no preparation when execution is disabled", async () => {
    const runtime = await createExecutionRuntime({ ...config(), executionEnabled: false }, logger);
    expect(runtime.capabilities.labels).toStrictEqual({
      site: "fixture",
      execution: "disabled",
      processHost: "unavailable",
    });
    expect(runtime.capabilities.interactiveDesktop).toBe(false);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.createHost).not.toHaveBeenCalled();
  });

  it("uses caller-known executable defaults, deployed assets, and the existing disk-capacity gate", async () => {
    const runtime = await createExecutionRuntime(config(), logger);
    expect(state.defaults?.executables).toContainEqual({ name: "node", path: process.execPath });
    expect(state.defaults?.executables).toContainEqual({
      name: "cmd",
      path: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(state.defaults?.executables).toContainEqual({
      name: "git",
      path: "C:\\Trusted\\git.exe",
      sha256: "c".repeat(64),
    });
    expect(state.defaults?.untrustedDirectories).toContain("C:\\WorkerData\\Workspaces");
    expect(state.defaults?.bundleDirectory).not.toContain("checkout");
    expect(runtime.capabilities.labels.validationHeadless).toBe("1");
    expect(runtime.capabilities.labels.executionEnvelope).toBe("2");
    expect(runtime.capabilities.labels.validationWindowsDesktop).toBeUndefined();
    expect(state.profileOptions?.legacyExecutor).toBeDefined();
    expect(state.profileOptions?.evidenceUploader).toBeDefined();
    expect(state.profileOptions?.createSummaryExecutor).toBeUndefined();
    expect(state.summaryOptions).toEqual([]);
    const checkSignal = new AbortController().signal;
    state.capacity.mockResolvedValue(false);
    await expect(runtime.canAcceptWork?.(checkSignal)).resolves.toBe(false);
    expect(state.capacity).toHaveBeenCalledWith(checkSignal);
  });

  it("connects optional summaries only after explicit runtime opt-in with trusted model settings", async () => {
    state.validation = { ...validation("web"), summary: { maximumTimeoutMs: 45_000 } };
    await createExecutionRuntime(config(), logger);
    expect(state.summaryOptions).toEqual([]);
    state.profileOptions?.createSummaryExecutor?.({} as JobExecutionEnvelopeV2, context());
    expect(state.summaryOptions).toHaveLength(1);
    expect(state.summaryOptions[0]).toMatchObject({
      workspaceProvider: state.profileOptions?.workspaceProvider,
      maximumSummaryTimeoutMs: 45_000,
      sensitiveValues: [],
    });
    expect(state.preparedOptions[0]).toMatchObject({
      codexExecutablePath: "C:\\Trusted\\codex.exe",
      codexHomeDirectory: "C:\\WorkerData\\Profile",
      codexProviderEnvironment: {},
    });
  });

  it("shares loader-classified protection with review, summary and prepared runners only", async () => {
    state.validation = { ...validation("web"), summary: { maximumTimeoutMs: 45_000 } };
    state.providerEnvironment = {
      CODEX_PROVIDER_HEADER_0: "worker",
      CODEX_PROVIDER_HEADER_1: "fixture-authentication-credential",
    };
    state.providerProtectedValues = ["fixture-authentication-credential"];
    await createExecutionRuntime(config(), logger);
    state.profileOptions?.createSummaryExecutor?.({} as JobExecutionEnvelopeV2, context());
    expect(state.reviewOptions[0]).toMatchObject({
      codexProviderEnvironment: state.providerEnvironment,
      codexProviderProtectedValues: state.providerProtectedValues,
    });
    expect(state.preparedOptions[0]).toMatchObject({
      codexProviderEnvironment: state.providerEnvironment,
      codexProviderProtectedValues: state.providerProtectedValues,
    });
    expect(state.summaryOptions[0]?.sensitiveValues).toEqual(state.providerProtectedValues);
    expect(state.summaryOptions[0]?.sensitiveValues).not.toContain("worker");
    expect(state.defaults).not.toHaveProperty("providerMetadataPolicy");
    expect(state.validation).not.toHaveProperty("providerMetadataPolicy");
  });

  it("keeps each headless runner's workspace and progress callback independent", async () => {
    await createExecutionRuntime(config(), logger);
    const first = context();
    const second = context();
    state.profileOptions?.createHeadlessRunner?.(
      {} as JobExecutionEnvelopeV2,
      first,
      workspace("first"),
    );
    state.profileOptions?.createHeadlessRunner?.(
      {} as JobExecutionEnvelopeV2,
      second,
      workspace("second"),
    );
    expect(state.workspaceRoots).toStrictEqual([
      workspace("first").checkoutDirectory,
      workspace("second").checkoutDirectory,
    ]);
    state.headlessOptions[0]?.onProcessProgress?.({
      phase: "build",
      stepId: "compile",
      processCount: 1,
    });
    expect(first.reportProgress).toHaveBeenCalledExactlyOnceWith({
      phase: "validation",
      processCount: 1,
    });
    expect(second.reportProgress).not.toHaveBeenCalled();
    const modelProvider = {} as ProfileJobExecutorOptions["workspaceProvider"];
    state.profileOptions?.createModelExecutor?.(
      modelProvider,
      {} as JobExecutionEnvelopeV2,
      context(),
    );
    expect(state.reviewOptions.at(-1)).toMatchObject({
      workspaceProvider: modelProvider,
      codexHomeDirectory: "C:\\WorkerData\\Profile",
    });
  });

  it.each(["headless", "web", "windows_desktop"] as const)(
    "supplies complete workspace environments to the %s command factory",
    async (target) => {
      const { HeadlessValidationCheckRunner } = await vi.importActual<
        typeof import("./execution/validation-check-runner.js")
      >("./execution/validation-check-runner.js");
      state.validation = validation(
        target === "headless" ? undefined : target === "web" ? "web" : "windows",
      );
      const settings = config();
      state.providerEnvironment = { CODEX_PROVIDER_HEADER_0: "fixture-provider-secret" };
      vi.stubEnv("CODEX_PROVIDER_HEADER_0", "fixture-ambient-provider-secret");
      vi.stubEnv("WORKER_TOKEN", settings.workerToken);
      vi.stubEnv("TEMP", "C:\\WorkerAmbient\\Temp");
      vi.stubEnv("TMP", "C:\\WorkerAmbient\\Tmp");
      vi.stubEnv("USERPROFILE", "C:\\WorkerAmbient\\User");
      await createExecutionRuntime(settings, logger);
      const workspaces = [workspace("first"), workspace("second")];
      for (const selectedWorkspace of workspaces) {
        if (target === "headless") {
          state.profileOptions?.createHeadlessRunner?.(
            {} as JobExecutionEnvelopeV2,
            context(),
            selectedWorkspace,
          );
        } else {
          state.profileOptions?.createUiRunner?.(
            { validation: { target, profileVersion: {} } } as JobExecutionEnvelopeV2,
            context(),
            selectedWorkspace,
          );
        }
      }
      const commandOptions = target === "headless" ? state.headlessOptions : state.uiCommandOptions;
      expect(commandOptions).toHaveLength(2);
      for (const options of commandOptions) {
        expect(() => new HeadlessValidationCheckRunner(options)).not.toThrow();
      }
      const environments = commandOptions.map((options) => options.baseEnvironment);
      expect(environments).toStrictEqual(
        workspaces.map((selectedWorkspace) => ({
          SYSTEMROOT: "C:\\Windows",
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32;C:\\Tools",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          TEMP: selectedWorkspace.tempDirectory,
          TMP: selectedWorkspace.tempDirectory,
          USERPROFILE: selectedWorkspace.userProfileDirectory,
        })),
      );
      expect(environments[0]).not.toBe(environments[1]);
      for (const environment of environments) {
        expect(Object.values(environment)).not.toContain(settings.workerToken);
        expect(Object.values(environment)).not.toContain(
          state.providerEnvironment.CODEX_PROVIDER_HEADER_0,
        );
      }
      expect(state.reviewOptions[0]).toMatchObject({
        codexProviderEnvironment: state.providerEnvironment,
      });
    },
  );

  it("prepares Web with the PS ownership driver but no interactive-session claim", async () => {
    state.validation = validation("web");
    const runtime = await createExecutionRuntime(config(), logger);
    expect(state.session).not.toHaveBeenCalled();
    expect(runtime.capabilities.labels.validationWeb).toBe("1");
    expect(runtime.capabilities.interactiveDesktop).toBe(false);
    expect(state.createHost).toHaveBeenCalledWith(
      expect.objectContaining({ maximumConcurrentRequests: 2 }),
    );
    state.profileOptions?.createUiRunner?.(
      { validation: { target: "web", profileVersion: {} } } as JobExecutionEnvelopeV2,
      context(),
      workspace("web"),
    );
    const options = state.uiOptions[0];
    expect(options?.drivers).toMatchObject({
      browserExecutable: "C:\\Browser\\browser.exe",
      windowsDriverEntry: "C:\\WorkerBundle\\dist\\windows-driver-entry.ps1",
      environment: {
        TEMP: workspace("web").tempDirectory,
        TMP: workspace("web").tempDirectory,
        USERPROFILE: workspace("web").userProfileDirectory,
      },
    });
    expect(options?.desktopLockDirectory).toBeUndefined();
  });

  it("creates Windows-only runtime without a fictitious browser and retains the shared desktop lock", async () => {
    state.validation = validation("windows");
    const runtime = await createExecutionRuntime(config(), logger);
    expect(state.session).toHaveBeenCalledOnce();
    expect(runtime.capabilities.interactiveDesktop).toBe(true);
    expect(runtime.capabilities.labels.validationWindowsDesktop).toBe("1");
    state.profileOptions?.createUiRunner?.(
      { validation: { target: "windows_desktop", profileVersion: {} } } as JobExecutionEnvelopeV2,
      context(),
      workspace("desktop"),
    );
    expect(state.uiOptions[0]?.drivers.browserExecutable).toBeUndefined();
    expect(state.uiOptions[0]?.drivers.webDriverEntry).toBeUndefined();
    expect(state.uiOptions[0]?.desktopLockDirectory).toBe("C:\\SharedDesktopLock");
  });

  it("withholds Windows labels and refuses its factory when the startup session is locked", async () => {
    state.validation = validation("windows");
    state.session.mockResolvedValue({
      schemaVersion: "WindowsSessionProbeResultV1",
      available: false,
      sessionId: null,
      reasonCode: "interactive_session_unavailable",
    });
    const runtime = await createExecutionRuntime(config(), logger);
    expect(runtime.capabilities.interactiveDesktop).toBe(false);
    expect(runtime.capabilities.labels.validationWindowsDesktop).toBeUndefined();
    expect(runtime.capabilities.labels.validationHeadless).toBe("1");
    expect(() =>
      state.profileOptions?.createUiRunner?.(
        { validation: { target: "windows_desktop" } } as JobExecutionEnvelopeV2,
        context(),
        workspace("desktop"),
      ),
    ).toThrow(/not ready/u);
  });

  it("refuses a disabled headless factory without removing the legacy executor", async () => {
    state.validation = { ...validation(), headlessEnabled: false };
    const runtime = await createExecutionRuntime(config(), logger);
    expect(runtime.capabilities.labels.validationHeadless).toBeUndefined();
    expect(state.profileOptions?.legacyExecutor).toBeDefined();
    expect(() =>
      state.profileOptions?.createHeadlessRunner?.(
        {} as JobExecutionEnvelopeV2,
        context(),
        workspace("first"),
      ),
    ).toThrow(/not enabled/u);
  });

  it("fails file preparation before creating a ProcessHost", async () => {
    state.prepare.mockRejectedValue(new Error("Missing deployed driver"));
    await expect(createExecutionRuntime(config(), logger)).rejects.toThrow(
      "Missing deployed driver",
    );
    expect(state.createHost).not.toHaveBeenCalled();
  });

  it.each(["orphan sweep", "session probe", "capability limits"])(
    "closes ProcessHost after a startup failure in %s",
    async (failure) => {
      const settings = config();
      if (failure === "orphan sweep")
        state.sweep.mockRejectedValue(new Error("Fixture startup failed"));
      if (failure === "session probe") {
        state.validation = validation("windows");
        state.session.mockRejectedValue(new Error("Fixture startup failed"));
      }
      if (failure === "capability limits")
        settings.capabilities.labels = Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [`label${index}`, "value"]),
        );
      await expect(createExecutionRuntime(settings, logger)).rejects.toThrow();
      expect(state.close).toHaveBeenCalledOnce();
    },
  );

  it("awaits failed-startup teardown and preserves the original error even if closing fails", async () => {
    const closed = Promise.withResolvers<void>();
    state.close.mockReturnValue(closed.promise);
    state.sweep.mockRejectedValue(new Error("Original startup failure"));
    const starting = createExecutionRuntime(config(), logger);
    let settled = false;
    void starting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    closed.reject(new Error("Cleanup failure"));
    await expect(starting).rejects.toThrow("Original startup failure");
  });
});
