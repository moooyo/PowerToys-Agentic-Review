import { win32 } from "node:path";
import type { JobExecutionEnvelopeV2 } from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig, WorkerExecutionConfig } from "./config.js";
import type { JobExecutionContext } from "./execution/job-executor.js";
import type { PreparedJobWorkspace } from "./execution/job-workspace.js";
import type { PreparedCliOutputRunnerOptions } from "./execution/prepared-cli-output-runner.js";
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
  versionProbe: vi.fn(),
  verifyBinaries: vi.fn(),
  prepare: vi.fn(),
  sweep: vi.fn(async () => ({ removedBytes: 0n })),
  capacity: vi.fn(async () => true),
  session: vi.fn(),
  observations: vi.fn(),
  validation: undefined as ValidationRuntimeConfig | undefined,
  defaults: undefined as ValidationRuntimeTrustedDefaults | undefined,
  profileOptions: undefined as ProfileJobExecutorOptions | undefined,
  headlessOptions: [] as HeadlessValidationCheckRunnerOptions[],
  uiCommandOptions: [] as HeadlessValidationCheckRunnerOptions[],
  uiOptions: [] as UiProfileRunnerOptions[],
  reviewOptions: [] as unknown[],
  summaryOptions: [] as ValidationSummaryExecutorOptions[],
  preparedOptions: [] as PreparedCliOutputRunnerOptions[],
  workspaceRoots: [] as string[],
}));

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(async () => undefined),
  realpath: vi.fn(async (path: string) => path),
  lstat: vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false })),
  readFile: vi.fn(async () => {
    throw new Error("Startup must not read account CLI files.");
  }),
}));
vi.mock("./execution/trusted-binary.js", () => ({
  verifyTrustedExecutionBinaries: state.verifyBinaries,
}));
vi.mock("./execution/process-host-client.js", () => ({
  deriveWorkerProcessHostInstanceKey: () => "fixture-host",
  StdioProcessHostClient: { create: state.createHost },
}));
vi.mock("./execution/managed-process-runner.js", () => ({
  ProductionManagedProcessRunner: class {
    run = state.versionProbe;
  },
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
vi.mock("./execution/prepared-cli-output-runner.js", () => ({
  PreparedCliOutputRunner: class {
    constructor(options: PreparedCliOutputRunnerOptions) {
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

describe("preconfigured CLI production composition", () => {
  function evaluation(workflowKind: "pr_static_build" | "issue_validation", required = true) {
    return {
      validation: {
        schemaVersion: "ValidationJobContextV2",
        purpose: { kind: "evaluation" },
        workflowKind,
        modelRequirements: { required },
      },
    } as JobExecutionEnvelopeV2;
  }

  it("observes the installed CLI version through a bounded ProcessHost command", async () => {
    state.versionProbe.mockResolvedValue({
      exitCode: 0,
      stdout: "copilot 1.2.3\nAdditional information\n",
      stderr: "",
    });
    vi.stubEnv("WORKER_TOKEN", "fixture-worker-token");
    vi.stubEnv("GITHUB_TOKEN", "fixture-account-token");
    vi.stubEnv("SERVER_SESSION_SECRET", "fixture-server-secret");
    vi.stubEnv("Agentic_Review_Oidc_Client_Secret", "fixture-control-secret");
    vi.stubEnv("custom_endpoint", "https://fixture.invalid/model");
    vi.stubEnv("CUSTOM_TOKEN", "fixture-custom-token");
    vi.stubEnv("CLI_TOKEN_ALIAS", config().workerToken);
    const runtime = await createExecutionRuntime(config(), logger);
    expect(runtime.capabilities.cliVersion).toBe("copilot 1.2.3");
    expect(state.reviewOptions[0]).toHaveProperty("cliVersion", "copilot 1.2.3");
    expect(state.versionProbe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        executable: "C:\\Trusted\\codex.exe",
        arguments: ["--version"],
        workingDirectory: "C:\\WorkerData\\GitRuntime",
        environmentMode: "replace",
        standardInput: "",
        limits: {
          hardTimeoutMs: 20_000,
          maximumProcessCount: 8,
          maximumMemoryBytes: 512 * 1024 * 1024,
          maximumOutputBytes: 64 * 1024,
        },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const environment = state.versionProbe.mock.calls[0]?.[0].environment;
    expect(environment).not.toHaveProperty("WORKER_TOKEN");
    expect(environment).not.toHaveProperty("CLI_TOKEN_ALIAS");
    expect(environment).not.toHaveProperty("SERVER_SESSION_SECRET");
    expect(environment).not.toHaveProperty("AGENTIC_REVIEW_OIDC_CLIENT_SECRET");
    expect(environment).toMatchObject({
      USERPROFILE: "C:\\Users\\Worker",
      CODEX_HOME: "C:\\WorkerData\\Profile",
      GITHUB_TOKEN: "fixture-account-token",
      CUSTOM_ENDPOINT: "https://fixture.invalid/model",
      CUSTOM_TOKEN: "fixture-custom-token",
      HOME: "C:\\Users\\Worker",
      USERNAME: "Worker",
    });
    expect((state.reviewOptions[0] as PreparedCliOutputRunnerOptions).cliEnvironment).toBe(
      environment,
    );
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("snapshots the CLI account environment before asynchronous startup", async () => {
    vi.stubEnv("CUSTOM_TOKEN", "fixture-initial-token");
    const { realpath } = await import("node:fs/promises");
    vi.mocked(realpath).mockImplementationOnce(async (path) => {
      vi.stubEnv("CUSTOM_TOKEN", "fixture-mutated-token");
      return String(path);
    });
    await createExecutionRuntime(config(), logger);
    expect(state.versionProbe.mock.calls[0]?.[0].environment.CUSTOM_TOKEN).toBe(
      "fixture-initial-token",
    );
    expect(
      (state.reviewOptions[0] as PreparedCliOutputRunnerOptions).cliEnvironment?.CUSTOM_TOKEN,
    ).toBe("fixture-initial-token");
  });

  it.each(["", "x".repeat(129), "bad\0version"])(
    "closes the ProcessHost after unusable version output %j",
    async (stdout) => {
      state.versionProbe.mockResolvedValue({ exitCode: 0, stdout, stderr: "" });
      await expect(createExecutionRuntime(config(), logger)).rejects.toThrow(
        "did not return a usable version",
      );
      expect(state.close).toHaveBeenCalledOnce();
      expect(state.reviewOptions).toHaveLength(0);
    },
  );

  it("sanitizes failed version probes and closes their ProcessHost", async () => {
    state.versionProbe.mockRejectedValue(new Error("fixture-sensitive-output"));
    await expect(createExecutionRuntime(config(), logger)).rejects.toThrow(
      "did not return a usable version",
    );
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.profileOptions).toBeUndefined();
  });

  it.each(["codex", "copilot"] as const)(
    "uses the configured %s account for ordinary and evaluation reviews",
    async (engine) => {
      const settings = config();
      if (settings.execution === undefined || settings.execution.modelExecutionEnabled === false)
        throw new Error("Missing model fixture.");
      const runtime = await createExecutionRuntime(
        {
          ...settings,
          execution: { ...settings.execution, engine },
        },
        logger,
      );
      const provider = {} as ProfileJobExecutorOptions["workspaceProvider"];
      state.profileOptions?.createModelExecutor?.(
        provider,
        {} as JobExecutionEnvelopeV2,
        context(),
      );
      state.profileOptions?.createModelExecutor?.(
        provider,
        evaluation("pr_static_build"),
        context(),
      );
      expect(state.reviewOptions.at(-1)).toEqual(state.reviewOptions.at(-2));
      expect(state.reviewOptions.at(-1)).toMatchObject({
        engine,
        cliExecutablePath: "C:\\Trusted\\codex.exe",
        cliVersion: "codex-pinned",
        cliHomeDirectory: "C:\\WorkerData\\Profile",
        userProfileDirectory: "C:\\Users\\Worker",
        appDataDirectory: "C:\\Users\\Worker\\AppData\\Roaming",
        localAppDataDirectory: "C:\\Users\\Worker\\AppData\\Local",
      });
      expect(runtime.capabilities.labels.validationEvaluationReviewModel).toBe("1");
      expect(state.createHost.mock.calls[0]?.[0]).not.toHaveProperty("interactiveStdin");
      const { mkdir, readFile } = await import("node:fs/promises");
      expect(readFile).not.toHaveBeenCalled();
      expect(vi.mocked(mkdir).mock.calls.some(([path]) => String(path).includes("Profile"))).toBe(
        false,
      );
    },
  );

  it("leaves the CLI home unset when the installed CLI uses its own defaults", async () => {
    const settings = config();
    if (settings.execution === undefined || settings.execution.modelExecutionEnabled === false)
      throw new Error("Missing model fixture.");
    const { cliHomeDirectory: _home, ...execution } = settings.execution;
    await createExecutionRuntime({ ...settings, execution }, logger);
    expect(state.reviewOptions[0]).not.toHaveProperty("cliHomeDirectory");
    expect(state.reviewOptions[0]).toHaveProperty("userProfileDirectory", "C:\\Users\\Worker");
  });

  it.each([true, false])(
    "freezes evaluation summary inputs with ordinary summaries enabled=%s",
    async (enabled) => {
      state.validation = {
        ...validation(),
        ...(enabled ? { summary: { maximumTimeoutMs: 45_000 } } : {}),
      };
      const summaryInputApi = {
        freezeValidationSummaryInput: vi.fn(async () => {
          throw new Error("Not invoked at startup.");
        }),
      };
      const runtime = await createExecutionRuntime(config(), logger, summaryInputApi);
      state.profileOptions?.createSummaryExecutor?.(evaluation("issue_validation"), context());
      expect(state.summaryOptions.at(-1)).toMatchObject({ summaryInputApi });
      expect(state.preparedOptions.at(-1)).toMatchObject({
        engine: "codex",
        cliVersion: "codex-pinned",
      });
      expect(summaryInputApi.freezeValidationSummaryInput).not.toHaveBeenCalled();
      expect(runtime.capabilities.labels.validationEvaluationSummaryModel).toBe("1");
      expect(state.profileOptions?.optionalSummariesEnabled).toBe(enabled);
    },
  );

  it("does not advertise evaluation summaries without the input persistence API", async () => {
    const runtime = await createExecutionRuntime(config(), logger);
    expect(runtime.capabilities.labels.validationEvaluationSummaryModel).toBeUndefined();
    expect(() =>
      state.profileOptions?.createSummaryExecutor?.(evaluation("issue_validation"), context()),
    ).toThrow("summary input API");
  });

  it("does not create a model executor for profile-only evaluations", async () => {
    await createExecutionRuntime(config(), logger);
    const reviewCount = state.reviewOptions.length;
    expect(() =>
      state.profileOptions?.createModelExecutor?.(
        {} as ProfileJobExecutorOptions["workspaceProvider"],
        evaluation("pr_static_build", false),
        context(),
      ),
    ).toThrow("does not request a model review");
    expect(() =>
      state.profileOptions?.createSummaryExecutor?.(
        evaluation("issue_validation", false),
        context(),
      ),
    ).toThrow("does not request a model summary");
    expect(state.reviewOptions).toHaveLength(reviewCount);
    expect(state.summaryOptions).toHaveLength(0);
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
    engine: "codex",
    trustedExecutableRoot: "C:\\Trusted",
    processHostPath: "C:\\Trusted\\host.exe",
    processHostSha256: "a".repeat(64),
    cliExecutablePath: "C:\\Trusted\\codex.exe",
    cliSha256: "b".repeat(64),
    gitExecutablePath: "C:\\Trusted\\git.exe",
    gitSha256: "c".repeat(64),
    gitSharedRootDirectory: "C:\\WorkerData\\Repositories",
    workspaceRootDirectory: "C:\\WorkerData\\Workspaces",
    tempDirectory: "C:\\WorkerData\\Temp",
    cliHomeDirectory: "C:\\WorkerData\\Profile",
    processHostRequestTimeoutMs: 15_000,
    processHostStartTimeoutMs: 30_000,
    processHostShutdownTimeoutMs: 15_000,
    modelMaximumHardTimeoutMs: 60_000,
    gitHardTimeoutMs: 60_000,
    modelResourceLimits: {
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
      cliEngine: "codex",
      cliVersion: null,
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
  for (const name of Object.keys(process.env)) vi.stubEnv(name, undefined);
  vi.stubEnv("SYSTEMROOT", "C:\\Windows");
  vi.stubEnv("COMSPEC", "C:\\Untrusted\\cmd.exe");
  vi.stubEnv("PATH", "C:\\Windows\\System32;C:\\Tools");
  vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
  vi.stubEnv("USERPROFILE", "C:\\Users\\Worker");
  vi.stubEnv("APPDATA", "C:\\Users\\Worker\\AppData\\Roaming");
  vi.stubEnv("LOCALAPPDATA", "C:\\Users\\Worker\\AppData\\Local");
  vi.stubEnv("HOME", "C:\\Users\\Worker");
  vi.stubEnv("USERNAME", "Worker");
  state.validation = validation();
  state.defaults = undefined;
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
  state.versionProbe
    .mockReset()
    .mockResolvedValue({ exitCode: 0, stdout: "codex-pinned\n", stderr: "" });
  state.verifyBinaries.mockReset().mockImplementation(async (options) => ({
    processHostPath: "C:\\Trusted\\host.exe",
    gitPath: "C:\\Trusted\\git.exe",
    ...(options.cli === undefined
      ? { measurements: {} }
      : {
          cliPath: "C:\\Trusted\\codex.exe",
          measurements: { cli: { sha256: "b".repeat(64) } },
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
      engine: _engine,
      cliExecutablePath: _path,
      cliSha256: _sha,
      cliHomeDirectory: _profile,
      model: _model,
      modelResourceLimits,
      modelMaximumHardTimeoutMs,
      ...common
    } = settings;
    return {
      ...current,
      modelExecutionEnabled: false,
      execution: {
        ...common,
        modelExecutionEnabled: false,
        validationResourceLimits: modelResourceLimits,
        validationMaximumHardTimeoutMs: modelMaximumHardTimeoutMs,
      },
    };
  }
  it.each(["headless", "web", "windows"] as const)(
    "prepares %s without persistent model files, binaries, or factories",
    async (target) => {
      state.validation = validation(target === "headless" ? undefined : target);
      const runtime = await createExecutionRuntime(validationOnly(), logger);
      expect(state.verifyBinaries.mock.calls[0]?.[0]).not.toHaveProperty("cli");
      expect(state.versionProbe).not.toHaveBeenCalled();
      expect(state.defaults?.executables.some((entry) => entry.name === "codex")).toBe(false);
      expect(state.reviewOptions).toEqual([]);
      expect(state.summaryOptions).toEqual([]);
      expect(state.preparedOptions).toEqual([]);
      expect(state.profileOptions?.createModelExecutor).toBeUndefined();
      expect(state.profileOptions?.createSummaryExecutor).toBeUndefined();
      expect(state.profileOptions?.modelExecutionEnabled).toBe(false);
      expect(runtime.capabilities.cliEngine).toBeNull();
      expect(runtime.capabilities.cliVersion).toBeNull();
      expect(runtime.capabilities.labels.modelExecution).toBe("disabled");
      expect(runtime.capabilities.labels.validationEvaluation).toBe("1");
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
  it.each(["WORKER_VALIDATION_SUMMARY_ENABLED"])(
    "rejects %s before filesystem or native startup",
    async (name) => {
      vi.stubEnv(name, "true");
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
  });
  it("retains the disabled mode across asynchronous startup even if the caller mutates its settings", async () => {
    const settings = validationOnly();
    const { realpath } = await import("node:fs/promises");
    vi.mocked(realpath).mockImplementationOnce(async () => {
      if (settings.execution === undefined) throw new Error("Missing fixture settings.");
      Reflect.set(settings.execution, "modelExecutionEnabled", true);
      Reflect.set(settings.execution, "cliHomeDirectory", "C:\\DoNotRead\\Profile");
      return settings.dataDirectory;
    });
    await createExecutionRuntime(settings, logger);
    expect(state.profileOptions?.modelExecutionEnabled).toBe(false);
    expect(state.verifyBinaries.mock.calls[0]?.[0]).not.toHaveProperty("cli");
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
    expect(runtime.capabilities.labels.validationEvaluation).toBe("1");
    expect(runtime.capabilities.labels.validationWindowsDesktop).toBeUndefined();
    expect(state.profileOptions?.legacyExecutor).toBeDefined();
    expect(state.profileOptions?.evidenceUploader).toBeDefined();
    expect(state.profileOptions?.createSummaryExecutor).toBeTypeOf("function");
    expect(
      state.profileOptions?.createSummaryExecutor?.({} as JobExecutionEnvelopeV2, context()),
    ).toBeUndefined();
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
    });
    expect(state.preparedOptions[0]).toMatchObject({
      cliExecutablePath: "C:\\Trusted\\codex.exe",
      cliHomeDirectory: "C:\\WorkerData\\Profile",
      userProfileDirectory: "C:\\Users\\Worker",
    });
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
      cliHomeDirectory: "C:\\WorkerData\\Profile",
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
      vi.stubEnv("GITHUB_TOKEN", "fixture-ambient-cli-secret");
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
        expect(Object.values(environment)).not.toContain("fixture-ambient-cli-secret");
      }
      expect(state.reviewOptions[0]).toMatchObject({
        userProfileDirectory: "C:\\WorkerAmbient\\User",
      });
    },
  );

  it.each(["web", "windows"] as const)(
    "confines %s PowerShell module caches to owned startup and attempt temporary directories",
    async (target) => {
      state.validation = validation(target);
      vi.stubEnv("PSModuleAnalysisCachePath", "C:\\WorkerBundle\\dist\\ModuleAnalysisCache");
      await createExecutionRuntime(config(), logger);
      const startupCalls = [...state.observations.mock.calls, ...state.session.mock.calls];
      expect(startupCalls.length).toBeGreaterThan(0);
      for (const call of startupCalls) {
        expect(call[0].environment).toMatchObject({
          PSMODULEANALYSISCACHEPATH: "C:\\WorkerData\\Temp\\PowerShell-ModuleAnalysisCache",
        });
      }
      const workspaces = [workspace("first"), workspace("second")];
      for (const selectedWorkspace of workspaces) {
        state.profileOptions?.createUiRunner?.(
          {
            validation: {
              target: target === "web" ? "web" : "windows_desktop",
              profileVersion: {},
            },
          } as JobExecutionEnvelopeV2,
          context(),
          selectedWorkspace,
        );
      }
      expect(state.uiOptions.map((options) => options.drivers.environment)).toEqual(
        workspaces.map((selectedWorkspace) =>
          expect.objectContaining({
            TEMP: selectedWorkspace.tempDirectory,
            PSMODULEANALYSISCACHEPATH: win32.join(
              selectedWorkspace.tempDirectory,
              "PowerShell-ModuleAnalysisCache",
            ),
          }),
        ),
      );
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
