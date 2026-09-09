import { win32 } from "node:path";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  type TestProbeOutputDeclarationV1,
  type ValidationCommandStep,
  type ValidationProfileConfig,
  type ValidationProfileVersion,
  ValidationReportV1Schema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import {
  ManagedProcessRunError,
  type ManagedProcessRunner,
  type ManagedProcessRunResult,
} from "./managed-process-runner.js";
import type { ProcessHostClient, ProcessResourceLimits } from "./process-host-protocol.js";
import {
  createUiCommandBridge,
  HeadlessValidationCheckRunner,
  type UiCommandStepInput,
  type ValidationCheckFileSystem,
} from "./validation-check-runner.js";

const probeDeclaration: TestProbeOutputDeclarationV1 = {
  schemaVersion: "TestProbeOutputDeclarationV1",
  fields: [{ id: "status", description: "Observed status.", type: "string" }],
};
function probeStdout(value = "Ready"): string {
  return JSON.stringify({
    schemaVersion: "ProbeObservationsV1",
    observations: [{ id: "status", state: "observed", value: { type: "string", value } }],
  });
}

const paths = {
  attempt: "C:\\AgenticReview\\attempt-1",
  checkout: "C:\\AgenticReview\\attempt-1\\checkout",
  control: "C:\\AgenticReview\\attempt-1\\control",
  codexHome: "C:\\AgenticReview\\attempt-1\\codex-home",
  temp: "C:\\AgenticReview\\attempt-1\\temp",
  userProfile: "C:\\AgenticReview\\attempt-1\\user-profile",
} as const;

const baseEnvironment = {
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  PATH: "C:\\Windows\\System32;C:\\Tools",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  SYSTEMROOT: "C:\\Windows",
  TEMP: paths.temp,
  TMP: paths.temp,
  USERPROFILE: paths.userProfile,
} as const;

const limits: ProcessResourceLimits = {
  hardTimeoutMs: 120_000,
  maximumProcessCount: 8,
  maximumMemoryBytes: 512 * 1_024 * 1_024,
  maximumOutputBytes: 64 * 1_024,
};

function step(id: string, overrides: Partial<ValidationCommandStep> = {}): ValidationCommandStep {
  return {
    id,
    name: `Check ${id}`,
    command: {
      executable: "dotnet",
      args: [id],
      workingDirectory: ".",
      environment: [],
    },
    timeoutMs: 30_000,
    required: true,
    ...overrides,
  };
}

function profile(overrides: Partial<ValidationProfileConfig> = {}): ValidationProfileVersion {
  const config: ValidationProfileConfig = {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: [],
    test: [step("unit")],
    launch: [],
    cleanup: [],
    requiredCapabilities: ["os.windows", "tool.dotnet"],
    hardTimeoutMs: 120_000,
    noProgressTimeoutMs: 60_000,
    ...overrides,
  };
  return {
    id: "profile-version-7",
    profileId: "profile-1",
    repositoryId: "repository-1",
    version: 7,
    name: "Headless validation",
    workflowKind: "pr_static_build",
    target: "headless",
    outputSchemaVersion: "PrReviewPlanV2",
    required: true,
    config,
    configSha256: createCanonicalResult(config).sha256,
    createdAt: "2026-09-07T00:00:00.000Z",
    publishedAt: "2026-09-07T00:00:00.000Z",
    createdBy: "operator-1",
  };
}

function uiProfile(
  overrides: Partial<ValidationProfileConfig> = {},
  target: "web" | "windows_desktop" = "web",
): ValidationProfileVersion {
  const ui: NonNullable<ValidationProfileConfig["ui"]> =
    target === "web"
      ? {
          schemaVersion: "UiScenariosV1",
          target,
          service: {
            origin: "managed_loopback",
            portEnvironmentVariable: "UI_TEST_PORT",
            navigation: "same_origin",
          },
          browser: { engine: "chromium", headless: true, viewport: { width: 1280, height: 720 } },
          launch: {
            stepId: "launch-app",
            mode: "persistent",
            readiness: { kind: "http", path: "/health", expectedStatus: 200, timeoutMs: 1000 },
          },
          reset: { strategy: "restart_process" },
          scenarios: [
            {
              id: "scenario-one",
              name: "Observe the application",
              required: true,
              timeoutMs: 10000,
              path: "/",
              steps: [
                {
                  id: "assert-ready",
                  name: "Ready is visible",
                  action: "assertVisible",
                  expected: true,
                  locator: { by: "testId", testId: "ready" },
                  timeoutMs: 1000,
                },
              ],
            },
          ],
          evidence: {
            screenshots: "on_failure",
            screenshotScope: "viewport",
            trace: "on_failure",
            required: true,
          },
        }
      : {
          schemaVersion: "UiScenariosV1",
          target,
          desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
          launch: {
            stepId: "launch-app",
            mode: "persistent",
            readiness: { kind: "window", window: { title: "Fixture" }, timeoutMs: 1000 },
          },
          reset: { strategy: "restart_process" },
          scenarios: [
            {
              id: "scenario-one",
              name: "Observe the application",
              required: true,
              timeoutMs: 10000,
              steps: [
                {
                  id: "assert-ready",
                  name: "Ready is visible",
                  action: "assertVisible",
                  expected: true,
                  locator: { by: "automationId", automationId: "ready" },
                  timeoutMs: 1000,
                },
              ],
            },
          ],
          evidence: { screenshots: "on_failure", screenshotScope: "owned_window", required: true },
        };
  const config: ValidationProfileConfig = {
    ...profile().config,
    setup: [step("prepare")],
    build: [step("compile")],
    cleanup: [step("teardown")],
    launch: [step("launch-app", { timeoutMs: 1000 })],
    ui,
    ...overrides,
  };
  return {
    ...profile(),
    workflowKind: "pr_ui",
    target,
    outputSchemaVersion: "ValidationReportV1",
    config,
    configSha256: createCanonicalResult(config).sha256,
  };
}

type RunnerOptions = ConstructorParameters<typeof HeadlessValidationCheckRunner>[0];
type WorktreeState = "clean" | "modified" | "unknown";

function harness(options: Partial<RunnerOptions> = {}) {
  const processRunner = {
    run: vi.fn<ManagedProcessRunner["run"]>().mockResolvedValue({
      exitCode: 0,
      stdout: "check output\n",
      stderr: "",
    }),
  };
  const processHost: ProcessHostClient = {
    start: vi.fn(async () => {
      throw new Error("Validation must use the injected managed process runner.");
    }),
    terminateAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const captureWorktreeState = vi
    .fn<(signal: AbortSignal) => Promise<WorktreeState>>()
    .mockResolvedValue("clean");
  const cleanup = vi.fn(async () => undefined);
  const closeMonitoring = vi.fn(async () => undefined);
  const startDiskMonitoring = vi.fn(async (signal: AbortSignal) => ({
    signal,
    violation: undefined,
    close: closeMonitoring,
  }));
  const workspace: PreparedJobWorkspace = {
    attemptDirectory: paths.attempt,
    checkoutDirectory: paths.checkout,
    controlDirectory: paths.control,
    tempDirectory: paths.temp,
    userProfileDirectory: paths.userProfile,
    startDiskMonitoring,
    captureWorktreeState,
    cleanup,
  };
  const resolveExecutable = vi.fn(
    async (_name: string, _signal: AbortSignal) => "C:\\Tools\\dotnet.exe",
  );
  const fileSystem = {
    lstat: vi.fn(
      async (_path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }> => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
    ),
    realpath: vi.fn(async (path: string) => win32.normalize(path)),
  };
  const runner = new HeadlessValidationCheckRunner({
    baseEnvironment,
    resolveExecutable,
    limits,
    processRunner,
    fileSystem,
    ...options,
  });
  const controller = new AbortController();
  const run = (
    selectedProfile = profile(),
    workItemKind: "issue" | "pull_request" = "pull_request",
  ) =>
    runner.run({
      profile: selectedProfile,
      workspace,
      workItemKind,
      processHost,
      signal: controller.signal,
    });
  return {
    runner,
    run,
    controller,
    workspace,
    processRunner,
    processHost,
    resolveExecutable,
    fileSystem,
    captureWorktreeState,
    cleanup,
    startDiskMonitoring,
    closeMonitoring,
  };
}

function waitForCancellation(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAborted = () =>
      reject(new ManagedProcessRunError("ABORTED", "The check was cancelled."));
    if (signal.aborted) {
      rejectAborted();
      return;
    }
    signal.addEventListener("abort", rejectAborted, { once: true });
  });
}

function checkOutcomes(result: Awaited<ReturnType<HeadlessValidationCheckRunner["run"]>>) {
  return result.report.checks.map(({ id, outcome }) => ({ id, outcome }));
}

function requireStep(steps: readonly ValidationCommandStep[]): ValidationCommandStep {
  const first = steps[0];
  if (first === undefined) throw new Error("The fixture requires a configured command step.");
  return first;
}

function bridgeStepInput(
  fixture: ReturnType<typeof harness>,
  selectedProfile: ValidationProfileVersion,
  phase: UiCommandStepInput["phase"] = "test",
): UiCommandStepInput {
  const command = requireStep(selectedProfile.config[phase]);
  return {
    workspace: fixture.workspace,
    processHost: fixture.processHost,
    signal: fixture.controller.signal,
    step: command,
    checkId: `${selectedProfile.id}:${command.id}`,
    phase,
    timeoutMs: 30000,
  };
}

describe("declared test probe execution", () => {
  it("captures complete stdout after monitoring settles while retaining legacy output shape", async () => {
    const fixture = harness();
    const value = "x".repeat(2_048);
    fixture.processRunner.run.mockResolvedValue({
      exitCode: 0,
      stdout: probeStdout(value),
      stderr: "progress",
    });
    const result = await fixture.run(
      profile({ test: [step("measure", { probeOutput: probeDeclaration })] }),
    );
    expect(fixture.closeMonitoring).toHaveBeenCalledOnce();
    expect(result.probeCaptures).toEqual([
      {
        checkId: "profile-version-7:measure",
        output: JSON.parse(probeStdout(value)),
        outputSha256: createCanonicalResult(JSON.parse(probeStdout(value))).sha256,
      },
    ]);
    expect(result.report.checks[0]?.outcome).toBe("passed");
    expect(result.diagnostics[0]?.stdout).toBe("");
    expect(result.diagnostics[0]?.stderr).toBe("progress");
    const legacy = await fixture.run();
    expect(legacy).not.toHaveProperty("probeCaptures");
    expect(legacy.diagnostics[0]?.stdout).not.toBe("");
  });

  it.each([
    "NON_ZERO_EXIT",
    "OUTPUT_TRUNCATED",
    "OUTPUT_READ_FAILED",
    "INVALID_UTF8_OUTPUT",
    "PROCESS_FAILED",
    "PROCESS_TERMINATED",
    "PROGRESS_OBSERVER_FAILED",
  ] as const)("never parses stdout attached to %s", async (code) => {
    const fixture = harness();
    fixture.processRunner.run.mockRejectedValueOnce(
      new ManagedProcessRunError(code, "Synthetic failed capture.", {
        exitCode: code === "NON_ZERO_EXIT" ? 1 : 0,
        stdout: probeStdout("private\\u0020observation"),
        stderr: "bounded diagnostic",
      }),
    );
    const result = await fixture.run(
      profile({ test: [step("measure", { probeOutput: probeDeclaration })] }),
    );
    expect(result.probeCaptures).toEqual([]);
    expect(result.report.checks[0]?.outcome).not.toBe("passed");
    expect(result.diagnostics[0]?.stdout).toBe("");
  });

  it.each(["monitor", "progress", "cancel"] as const)(
    "discards successful stdout when final %s settlement fails",
    async (failure) => {
      const fixture = harness({
        ...(failure === "progress"
          ? {
              onProcessProgress: (progress) => {
                if (progress.processCount === 0) throw new Error("Observer failed.");
              },
            }
          : {}),
      });
      fixture.processRunner.run.mockResolvedValueOnce({
        exitCode: 0,
        stdout: probeStdout(),
        stderr: "",
      });
      if (failure === "monitor")
        fixture.closeMonitoring.mockRejectedValueOnce(new Error("Final monitoring failed."));
      if (failure === "cancel")
        fixture.closeMonitoring.mockImplementationOnce(async () => {
          fixture.controller.abort();
        });
      const result = await fixture.run(
        profile({ test: [step("measure", { probeOutput: probeDeclaration })] }),
      );
      expect(result.probeCaptures).toEqual([]);
      expect(result.report.checks[0]?.outcome).not.toBe("passed");
    },
  );

  it("blocks malformed successful probes with fixed diagnostics and still runs other tests", async () => {
    const fixture = harness();
    fixture.processRunner.run
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"private":"escaped\\u0020secret"}',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ordinary check completed", stderr: "" });
    const result = await fixture.run(
      profile({
        test: [step("measure", { probeOutput: probeDeclaration }), step("ordinary")],
      }),
    );
    expect(result.probeCaptures).toEqual([]);
    expect(checkOutcomes(result)).toEqual([
      { id: "profile-version-7:measure", outcome: "blocked" },
      { id: "profile-version-7:ordinary", outcome: "passed" },
    ]);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "TEST_PROBE_OUTPUT_INVALID" }),
    );
    expect(JSON.stringify(result)).not.toContain("escaped");
  });

  it.each(["setup", "build", "launch", "cleanup"] as const)(
    "rejects a probe declaration in the %s phase before commands start",
    async (phase) => {
      const fixture = harness();
      const result = await fixture.run(
        profile({ [phase]: [step("wrong-phase", { probeOutput: probeDeclaration })] }),
      );
      expect(fixture.processRunner.run).not.toHaveBeenCalled();
      expect(result.blockers).toContainEqual(expect.objectContaining({ code: "PROFILE_INVALID" }));
    },
  );

  it("withholds earlier values using secrets first resolved during final cleanup", async () => {
    const secret = "resolvedDuringCleanup987";
    const fixture = harness({ resolveSecret: async () => secret });
    fixture.processRunner.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: probeStdout(secret),
      stderr: "",
    });
    const result = await fixture.run(
      profile({
        test: [step("measure", { probeOutput: probeDeclaration })],
        cleanup: [
          step("cleanup-secret", {
            command: {
              executable: "dotnet",
              args: [],
              workingDirectory: ".",
              environment: [{ name: "SERVICE_TOKEN", secretRef: "cleanup-credential" }],
            },
          }),
        ],
      }),
    );
    const capture = result.probeCaptures?.[0];
    expect(capture?.output.observations).toEqual([{ id: "status", state: "unavailable" }]);
    expect(capture?.outputSha256).toBe(createCanonicalResult(capture?.output).sha256);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["web", "windows_desktop"] as const)(
    "exposes final rechecked captures through the shared %s command bridge",
    async (target) => {
      const secret = "laterLaunchCredential987";
      const fixture = harness({ resolveSecret: async () => secret });
      const selected = uiProfile(
        {
          test: [step("measure", { probeOutput: probeDeclaration })],
          launch: [
            step("launch-app", {
              command: {
                executable: "dotnet",
                args: [],
                workingDirectory: ".",
                environment: [{ name: "SERVICE_TOKEN", secretRef: "launch-credential" }],
              },
            }),
          ],
        },
        target,
      );
      fixture.processRunner.run.mockResolvedValueOnce({
        exitCode: 0,
        stdout: probeStdout(secret),
        stderr: "",
      });
      const bridge = fixture.runner.createUiCommandBridge(selected);
      const result = await bridge.runStep(bridgeStepInput(fixture, selected));
      expect(result.probeCapture?.output.observations[0]?.state).toBe("observed");
      const earlier = result.probeCapture?.output.observations[0];
      if (earlier?.state === "observed" && earlier.value.type === "string")
        earlier.value.value = "caller-mutated-value";
      await bridge.prepareLaunch({
        workspace: fixture.workspace,
        signal: fixture.controller.signal,
        step: requireStep(selected.config.launch),
        timeoutMs: 30_000,
      });
      const captures = bridge.getProbeCaptures();
      expect(captures[0]?.output.observations).toEqual([{ id: "status", state: "unavailable" }]);
      expect(captures[0]?.outputSha256).not.toBe(result.probeCapture?.outputSha256);
      expect(JSON.stringify(captures)).not.toContain(secret);
      fixture.processRunner.run.mockRejectedValueOnce(
        new ManagedProcessRunError("NON_ZERO_EXIT", "Synthetic failure.", { exitCode: 1 }),
      );
      await bridge.runStep(bridgeStepInput(fixture, selected));
      expect(bridge.getProbeCaptures()).toEqual([]);
    },
  );
});

describe("UiCommandBridge", () => {
  it("accepts the real published UI profile while headless run still refuses its lifecycle", async () => {
    const fixture = harness();
    const selected = uiProfile();
    const bridge = createUiCommandBridge(selected, {
      baseEnvironment,
      limits,
      resolveExecutable: fixture.resolveExecutable,
      processRunner: fixture.processRunner,
      fileSystem: fixture.fileSystem,
    });

    const result = await bridge.runStep(bridgeStepInput(fixture, selected));
    expect(result.check).toMatchObject({
      id: `${selected.id}:unit`,
      kind: "test",
      outcome: "passed",
      source: "runner",
    });
    expect(result.diagnostic.stepId).toBe(`${selected.id}:unit`);
    const unsupported = await fixture.run(selected);
    expect(unsupported.blockers).toContainEqual(
      expect.objectContaining({ code: "UI_DRIVER_REQUIRED" }),
    );
    expect(fixture.processRunner.run).toHaveBeenCalledTimes(1);
    expect(fixture.cleanup).not.toHaveBeenCalled();
  });

  it.each(["digest", "target", "headless"] as const)(
    "rejects an invalid bridge profile %s",
    (invalid) => {
      const fixture = harness();
      const selected = invalid === "headless" ? profile() : uiProfile();
      if (invalid === "digest") selected.configSha256 = "0".repeat(64);
      if (invalid === "target") selected.target = "windows_desktop";
      expect(() => fixture.runner.createUiCommandBridge(selected)).toThrow();
      expect(fixture.processRunner.run).not.toHaveBeenCalled();
    },
  );

  it.each(["foreign", "phase", "arguments", "required", "identity", "launch"] as const)(
    "rejects a step not matching the frozen phase and command bytes: %s",
    async (change) => {
      const fixture = harness();
      const selected = uiProfile();
      const bridge = fixture.runner.createUiCommandBridge(selected);
      let input = bridgeStepInput(fixture, selected);
      if (change === "foreign") input = { ...input, step: step("foreign") };
      if (change === "phase") input = { ...input, phase: "build" };
      if (change === "arguments")
        input = {
          ...input,
          step: { ...input.step, command: { ...input.step.command, args: ["--changed"] } },
        };
      if (change === "required") input = { ...input, step: { ...input.step, required: false } };
      if (change === "identity")
        input = { ...input, checkId: `${selected.profileId}:${input.step.id}` };
      if (change === "launch")
        input = { ...input, phase: "launch" } as unknown as UiCommandStepInput;
      await expect(bridge.runStep(input)).rejects.toMatchObject({ code: "STEP_NOT_IN_PROFILE" });
      expect(fixture.processRunner.run).not.toHaveBeenCalled();
    },
  );

  it("freezes profile authority before any caller mutates its source object", async () => {
    const fixture = harness();
    const selected = uiProfile();
    const original = structuredClone(selected);
    const bridge = fixture.runner.createUiCommandBridge(selected);
    requireStep(selected.config.test).command.args.push("--changed");
    await expect(bridge.runStep(bridgeStepInput(fixture, selected))).rejects.toMatchObject({
      code: "STEP_NOT_IN_PROFILE",
    });
    await expect(bridge.runStep(bridgeStepInput(fixture, original))).resolves.toMatchObject({
      check: { outcome: "passed" },
    });
  });

  it("prepares a persistent launch with remaining profile lifetime without starting or monitoring it", async () => {
    vi.useFakeTimers();
    const fixture = harness();
    fixture.resolveExecutable.mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      return "C:\\Tools\\dotnet.exe";
    });
    const selected = uiProfile();
    const bridge = fixture.runner.createUiCommandBridge(selected);
    const pending = bridge.prepareLaunch({
      workspace: fixture.workspace,
      signal: fixture.controller.signal,
      step: requireStep(selected.config.launch),
      timeoutMs: 60000,
      environmentOverrides: { UI_TEST_PORT: "32123" },
      captureProcessIdentity: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    const spec = await pending;
    expect(spec).toMatchObject({
      environmentMode: "replace",
      environment: { UI_TEST_PORT: "32123" },
      captureProcessIdentity: true,
    });
    expect(spec.limits.hardTimeoutMs).toBe(59500);
    expect(spec.limits.hardTimeoutMs).toBeGreaterThan(
      requireStep(selected.config.launch).timeoutMs,
    );
    expect(fixture.processRunner.run).not.toHaveBeenCalled();
    expect(fixture.processHost.start).not.toHaveBeenCalled();
    expect(fixture.startDiskMonitoring).not.toHaveBeenCalled();
  });

  it("rejects a launch borrowed from a bounded setup stage", async () => {
    const fixture = harness();
    const selected = uiProfile();
    await expect(
      fixture.runner.createUiCommandBridge(selected).prepareLaunch({
        workspace: fixture.workspace,
        signal: fixture.controller.signal,
        step: requireStep(selected.config.setup),
        timeoutMs: 30000,
      }),
    ).rejects.toMatchObject({ code: "STEP_NOT_IN_PROFILE" });
  });

  it("bounds launch preparation by the startup step while reserving the longer process lifetime", async () => {
    vi.useFakeTimers();
    const fixture = harness();
    fixture.resolveExecutable.mockImplementation(async () => new Promise<string>(() => undefined));
    const selected = uiProfile();
    const pending = fixture.runner.createUiCommandBridge(selected).prepareLaunch({
      workspace: fixture.workspace,
      signal: fixture.controller.signal,
      step: requireStep(selected.config.launch),
      timeoutMs: 60000,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "STEP_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(fixture.processRunner.run).not.toHaveBeenCalled();
    expect(fixture.processHost.start).not.toHaveBeenCalled();
  });

  it.each([0, -1, 120001, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects a command budget outside its bound profile: %s",
    async (timeoutMs) => {
      const fixture = harness();
      const selected = uiProfile();
      const bridge = fixture.runner.createUiCommandBridge(selected);
      await expect(
        bridge.runStep({ ...bridgeStepInput(fixture, selected), timeoutMs }),
      ).rejects.toMatchObject({ code: "PROFILE_LIMIT_UNSUPPORTED" });
      expect(fixture.processRunner.run).not.toHaveBeenCalled();
    },
  );

  it("allows an independent cleanup session budget longer than each process limit", async () => {
    const fixture = harness({ limits: { ...limits, hardTimeoutMs: 10000 } });
    const selected = uiProfile({
      hardTimeoutMs: 10000,
      noProgressTimeoutMs: 10000,
      setup: [step("prepare", { timeoutMs: 1000 })],
      build: [step("compile", { timeoutMs: 1000 })],
      test: [step("unit", { timeoutMs: 1000 })],
      cleanup: [step("teardown", { timeoutMs: 1000 })],
    });
    const result = await fixture.runner
      .createUiCommandBridge(selected)
      .runStep(bridgeStepInput(fixture, selected, "cleanup"));
    expect(result.check.outcome).toBe("passed");
    expect(fixture.processRunner.run.mock.calls[0]?.[0].limits.hardTimeoutMs).toBe(10000);
  });

  it("accepts a referenced reset cleanup step inside the main profile lifetime", async () => {
    const fixture = harness();
    const selected = uiProfile({ cleanup: [step("teardown", { timeoutMs: 60000 })] });
    if (selected.config.ui === undefined) throw new Error("Expected typed UI scenarios.");
    selected.config.ui.reset = { strategy: "commands", stepIds: ["teardown"] };
    selected.configSha256 = createCanonicalResult(selected.config).sha256;
    const result = await fixture.runner.createUiCommandBridge(selected).runStep({
      ...bridgeStepInput(fixture, selected, "cleanup"),
      timeoutMs: 45000,
    });
    expect(result.check.outcome).toBe("passed");
    const timeout = fixture.processRunner.run.mock.calls[0]?.[0].limits.hardTimeoutMs;
    expect(timeout).toBeGreaterThan(30000);
    expect(timeout).toBeLessThanOrEqual(45000);
  });

  it.each([
    { CI: "32123" },
    { PATH: "32123" },
    { UI_TEST_PORT: "0" },
    { UI_TEST_PORT: "65536" },
    { UI_TEST_PORT: "01" },
    { UI_TEST_PORT: "32123\n" },
    { UI_TEST_PORT: "+32123" },
    { UI_TEST_PORT: "32123", EXTRA: "1" },
  ])(
    "rejects unowned or malformed launch environment overrides %j",
    async (environmentOverrides) => {
      const fixture = harness();
      const selected = uiProfile();
      await expect(
        fixture.runner.createUiCommandBridge(selected).prepareLaunch({
          workspace: fixture.workspace,
          signal: fixture.controller.signal,
          step: requireStep(selected.config.launch),
          timeoutMs: 30000,
          environmentOverrides,
        }),
      ).rejects.toMatchObject({ code: "ENVIRONMENT_INVALID" });
    },
  );

  it.each(["pAtH", "PSModuleAnalysisCachePath"])(
    "never overrides reserved %s even when configured as the managed port variable",
    async (name) => {
      const fixture = harness();
      const selected = uiProfile();
      if (selected.config.ui?.target !== "web") throw new Error("Expected a Web fixture.");
      selected.config.ui.service.portEnvironmentVariable = name;
      selected.configSha256 = createCanonicalResult(selected.config).sha256;
      await expect(
        fixture.runner.createUiCommandBridge(selected).prepareLaunch({
          workspace: fixture.workspace,
          signal: fixture.controller.signal,
          step: requireStep(selected.config.launch),
          timeoutMs: 30000,
          environmentOverrides: { [name]: "32123" },
        }),
      ).rejects.toMatchObject({ code: "ENVIRONMENT_INVALID" });
    },
  );

  it("rejects a profile that preconfigures its assigned port and rejects overrides for Windows", async () => {
    const fixture = harness();
    const selected = uiProfile({
      launch: [
        step("launch-app", {
          command: {
            executable: "dotnet",
            args: [],
            workingDirectory: ".",
            environment: [{ name: "ui_test_port", value: "3000" }],
          },
        }),
      ],
    });
    expect(() => fixture.runner.createUiCommandBridge(selected)).toThrow();
    const windows = uiProfile({}, "windows_desktop");
    await expect(
      fixture.runner.createUiCommandBridge(windows).prepareLaunch({
        workspace: fixture.workspace,
        signal: fixture.controller.signal,
        step: requireStep(windows.config.launch),
        timeoutMs: 30000,
        environmentOverrides: { UI_TEST_PORT: "32123" },
      }),
    ).rejects.toMatchObject({ code: "ENVIRONMENT_INVALID" });
  });

  it("retains launch secrets for later output redaction without injecting them into unrelated steps", async () => {
    const secret = "bridgeCredentialAbC987";
    const fixture = harness({ resolveSecret: async () => secret });
    const selected = uiProfile({
      launch: [
        step("launch-app", {
          command: {
            executable: "dotnet",
            args: [],
            workingDirectory: ".",
            environment: [{ name: "SERVICE_ACCESS_TOKEN", secretRef: "service-secret" }],
          },
        }),
      ],
    });
    const bridge = fixture.runner.createUiCommandBridge(selected);
    const spec = await bridge.prepareLaunch({
      workspace: fixture.workspace,
      signal: fixture.controller.signal,
      step: requireStep(selected.config.launch),
      timeoutMs: 30000,
    });
    expect(spec.environment.SERVICE_ACCESS_TOKEN).toBe(secret);
    expect(bridge.redactOutput(`server output ${secret}`)).not.toContain(secret);
    fixture.processRunner.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: `later output ${secret}`,
      stderr: "",
    });
    const result = await bridge.runStep(bridgeStepInput(fixture, selected));
    expect(result.diagnostic.stdout).not.toContain(secret);
    expect(fixture.processRunner.run.mock.calls[0]?.[0].environment).not.toHaveProperty(
      "SERVICE_ACCESS_TOKEN",
    );
    expect(
      fixture.runner.createUiCommandBridge(selected).redactOutput(`server output ${secret}`),
    ).toContain(secret);
  });

  it("does not permit a command bridge to switch attempt workspaces", async () => {
    const fixture = harness();
    const selected = uiProfile();
    const bridge = fixture.runner.createUiCommandBridge(selected);
    await expect(bridge.captureSource(fixture.workspace, fixture.controller.signal)).resolves.toBe(
      "clean",
    );
    await expect(
      bridge.runStep({
        ...bridgeStepInput(fixture, selected),
        workspace: { ...fixture.workspace },
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_SCOPE_MISMATCH" });
  });

  it("reports process progress only for actual bounded command execution", async () => {
    const progress = vi.fn();
    const fixture = harness({ onProcessProgress: progress });
    const selected = uiProfile();
    const bridge = fixture.runner.createUiCommandBridge(selected);
    await bridge.prepareLaunch({
      workspace: fixture.workspace,
      signal: fixture.controller.signal,
      step: requireStep(selected.config.launch),
      timeoutMs: 30000,
    });
    expect(progress).not.toHaveBeenCalled();
    await bridge.runStep(bridgeStepInput(fixture, selected));
    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { phase: "test", stepId: `${selected.id}:unit`, processCount: 1 },
      { phase: "test", stepId: `${selected.id}:unit`, processCount: 0 },
    ]);
  });

  it.each(["headless", "bridge"] as const)(
    "forwards managed output observations as metadata-only %s progress",
    async (mode) => {
      const progress = vi.fn();
      const fixture = harness({ onProcessProgress: progress });
      fixture.processRunner.run.mockImplementation(async (_spec, context) => {
        context.onProgress?.();
        context.onProgress?.();
        return { exitCode: 0, stdout: "private command output", stderr: "" };
      });
      if (mode === "headless") await fixture.run();
      else {
        const selected = uiProfile();
        await fixture.runner
          .createUiCommandBridge(selected)
          .runStep(bridgeStepInput(fixture, selected));
      }
      expect(progress.mock.calls.map(([event]) => event)).toEqual([
        { phase: "test", stepId: "profile-version-7:unit", processCount: 1 },
        { phase: "test", stepId: "profile-version-7:unit", processCount: 1 },
        { phase: "test", stepId: "profile-version-7:unit", processCount: 1 },
        { phase: "test", stepId: "profile-version-7:unit", processCount: 0 },
      ]);
      expect(JSON.stringify(progress.mock.calls)).not.toContain("private command output");
    },
  );

  it.each(["start", "output", "end"] as const)(
    "returns typed diagnostics for a failing %s progress observer and still closes monitoring",
    async (when) => {
      let observations = 0;
      const fixture = harness({
        onProcessProgress: ({ processCount }) => {
          if (processCount === 1) observations += 1;
          if (
            (when === "start" && observations === 1) ||
            (when === "output" && observations === 2) ||
            (when === "end" && processCount === 0)
          )
            throw new Error("Private observer credential detail.");
        },
      });
      fixture.processRunner.run.mockImplementation(async (_spec, context) => {
        context.onProgress?.();
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const result = await fixture.run();

      expect(result.report.checks[0]?.outcome).toBe("inconclusive");
      expect(result.blockers).toContainEqual(
        expect.objectContaining({ code: "PROGRESS_OBSERVER_FAILED" }),
      );
      expect(result.diagnostics[0]?.summary).toContain("progress observer failed");
      expect(fixture.closeMonitoring).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("Private observer credential detail.");
      expect(fixture.processRunner.run).toHaveBeenCalledTimes(when === "start" ? 0 : 1);
      expect(fixture.cleanup).not.toHaveBeenCalled();
    },
  );

  it.each(["valid", "outside", "link", "directory"] as const)(
    "resolves generated checkout executables without PATH guessing: %s",
    async (mode) => {
      const executable = win32.join(paths.checkout, "out", "Fixture.exe");
      const fileSystem: ValidationCheckFileSystem = {
        lstat: async (path) => ({
          isDirectory: () => path !== executable || mode === "directory",
          isFile: () => path === executable && mode !== "directory",
          isSymbolicLink: () => path === executable && mode === "link",
        }),
        realpath: async (path) => path,
      };
      const fixture = harness({
        fileSystem,
        resolveExecutable: async () => (mode === "outside" ? "C:\\Other\\Fixture.exe" : executable),
      });
      const selected = uiProfile({
        launch: [
          step("launch-app", {
            command: {
              executable: "out/Fixture.exe",
              args: [],
              workingDirectory: ".",
              environment: [],
            },
          }),
        ],
      });
      const pending = fixture.runner.createUiCommandBridge(selected).prepareLaunch({
        workspace: fixture.workspace,
        signal: fixture.controller.signal,
        step: requireStep(selected.config.launch),
        timeoutMs: 30000,
      });
      if (mode === "valid") await expect(pending).resolves.toMatchObject({ executable });
      else await expect(pending).rejects.toMatchObject({ code: "EXECUTABLE_UNAVAILABLE" });
      expect(fixture.processHost.start).not.toHaveBeenCalled();
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("HeadlessValidationCheckRunner", () => {
  it("rejects a cleanup budget above the explicit five-minute bound", () => {
    expect(() => harness({ cleanupTimeoutMs: 300_001 })).toThrow(
      "Validation cleanup timeout must be an integer between 1000 and 300000 milliseconds.",
    );
  });

  it.each([
    { label: "the default budget", options: {}, sourceState: "unknown" },
    {
      label: "an explicit three-minute budget",
      options: { cleanupTimeoutMs: 180_000 },
      sourceState: "original",
    },
    {
      label: "the explicit five-minute maximum",
      options: { cleanupTimeoutMs: 300_000 },
      sourceState: "original",
    },
  ] as const)(
    "bounds a slow final source observation with $label",
    async ({ options, sourceState }) => {
      vi.useFakeTimers();
      const fixture = harness(options);
      fixture.captureWorktreeState.mockResolvedValueOnce("clean").mockImplementation(
        (signal) =>
          new Promise<WorktreeState>((resolve, reject) => {
            const timer = setTimeout(() => resolve("clean"), 75_000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      );

      const running = fixture.run(profile({ cleanup: [] }));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fixture.captureWorktreeState).toHaveBeenCalledTimes(2);
      const finalSignal = fixture.captureWorktreeState.mock.calls[1]?.[0];
      expect(finalSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(finalSignal?.aborted).toBe(sourceState === "unknown");
      await vi.runAllTimersAsync();
      const result = await running;

      expect(result.report.sourceState).toBe(sourceState);
      expect(result.cleanupState).toBe("not_needed");
      expect(result.report.checks.every((check) => check.outcome === "passed")).toBe(true);
      if (sourceState === "original") expect(result.blockers).toEqual([]);
      else
        expect(result.blockers).toContainEqual(
          expect.objectContaining({ code: "SOURCE_STATE_UNKNOWN" }),
        );
    },
  );

  it("executes the frozen plan with a replacement environment and version-qualified evidence", async () => {
    vi.stubEnv("NODE_OPTIONS", "--require C:\\Host\\private-bootstrap.js");
    vi.stubEnv("HOST_ACCESS_TOKEN", "host-token-must-not-be-inherited");
    const fixture = harness();
    const build = step("compile", {
      command: {
        executable: "dotnet",
        args: ["build", "Project With Spaces.csproj", "--no-restore"],
        workingDirectory: "src/Project",
        environment: [{ name: "CI", value: "true" }],
      },
    });
    const selectedProfile = profile({
      setup: [step("prepare")],
      build: [build],
      cleanup: [step("teardown")],
    });
    const originalProfile = structuredClone(selectedProfile);

    const result = await fixture.run(selectedProfile);

    expect(result.blockers).toEqual([]);
    expect(result.cleanupState).toBe("completed");
    expect(result.report).toMatchObject({
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "pull_request",
      sourceState: "original",
    });
    expect(Value.Check(ValidationReportV1Schema, result.report)).toBe(true);
    expect(
      result.report.checks.map(({ id, kind, required, outcome, source }) => ({
        id,
        kind,
        required,
        outcome,
        source,
      })),
    ).toEqual([
      {
        id: "profile-version-7:prepare",
        kind: "static",
        required: true,
        outcome: "passed",
        source: "runner",
      },
      {
        id: "profile-version-7:compile",
        kind: "build",
        required: true,
        outcome: "passed",
        source: "runner",
      },
      {
        id: "profile-version-7:unit",
        kind: "test",
        required: true,
        outcome: "passed",
        source: "runner",
      },
      {
        id: "profile-version-7:teardown",
        kind: "static",
        required: true,
        outcome: "passed",
        source: "runner",
      },
    ]);
    expect(fixture.processRunner.run.mock.calls[1]?.[0]).toMatchObject({
      executable: "C:\\Tools\\dotnet.exe",
      arguments: build.command.args,
      workingDirectory: win32.join(paths.checkout, "src", "Project"),
      environmentMode: "replace",
      environment: { ...baseEnvironment, CI: "true" },
      limits: {
        maximumProcessCount: limits.maximumProcessCount,
        maximumMemoryBytes: limits.maximumMemoryBytes,
        maximumOutputBytes: limits.maximumOutputBytes,
      },
    });
    expect(fixture.processRunner.run.mock.calls[1]?.[0].environment).toEqual({
      ...baseEnvironment,
      PSMODULEANALYSISCACHEPATH: win32.join(paths.temp, "PowerShell-ModuleAnalysisCache"),
      CI: "true",
    });
    expect(
      fixture.processRunner.run.mock.calls.every(
        ([, context]) => context.processHost === fixture.processHost,
      ),
    ).toBe(true);
    expect(fixture.resolveExecutable).toHaveBeenCalledWith("dotnet", expect.any(AbortSignal));
    expect(fixture.captureWorktreeState.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.startDiskMonitoring).toHaveBeenCalledTimes(4);
    expect(fixture.closeMonitoring).toHaveBeenCalledTimes(4);
    expect(fixture.processHost.start).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(selectedProfile).toEqual(originalProfile);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "profile-version-7:compile",
          phase: "build",
          outcome: "passed",
          exitCode: 0,
          stdout: "check output\n",
          stderr: "",
        }),
      ]),
    );
  });

  it("blocks a changed configuration whose published digest no longer matches", async () => {
    const fixture = harness();
    const selectedProfile = profile();
    const configuredStep = selectedProfile.config.test[0];
    if (configuredStep === undefined) throw new Error("The fixture test step is missing.");
    configuredStep.command.args.push("--unexpected");

    const result = await fixture.run(selectedProfile);

    expect(result.blockers.length).toBeGreaterThan(0);
    expect(fixture.processRunner.run).not.toHaveBeenCalled();
    expect(result.report.checks.every((check) => check.outcome !== "passed")).toBe(true);
  });

  it("replaces host temporary and user-profile locations with the current attempt directories", async () => {
    vi.stubEnv("PSModuleAnalysisCachePath", "C:\\Host\\ModuleAnalysisCache");
    const fixture = harness({
      baseEnvironment: {
        ...baseEnvironment,
        TEMP: "C:\\Host\\Temp",
        TMP: "C:\\Host\\Tmp",
        USERPROFILE: "C:\\Host\\Profile",
      },
    });

    await fixture.run();

    expect(fixture.processRunner.run.mock.calls[0]?.[0].environment).toMatchObject({
      TEMP: paths.temp,
      TMP: paths.temp,
      USERPROFILE: paths.userProfile,
      PSMODULEANALYSISCACHEPATH: win32.join(paths.temp, "PowerShell-ModuleAnalysisCache"),
    });
  });

  it.each(["setup", "build"] as const)(
    "stops dependent stages after a required %s failure while still running cleanup",
    async (phase) => {
      const fixture = harness();
      fixture.processRunner.run.mockRejectedValueOnce(
        new ManagedProcessRunError("NON_ZERO_EXIT", "Command exited with code 2.", {
          exitCode: 2,
          stderr: "compiler error",
        }),
      );
      const selectedProfile = profile({
        [phase]: [step("first"), step("dependent")],
        cleanup: [step("teardown")],
      });

      const result = await fixture.run(selectedProfile);

      expect(checkOutcomes(result)).toEqual([
        { id: "profile-version-7:first", outcome: "failed" },
        { id: "profile-version-7:dependent", outcome: "not_run" },
        { id: "profile-version-7:unit", outcome: "not_run" },
        { id: "profile-version-7:teardown", outcome: "passed" },
      ]);
      expect(fixture.processRunner.run).toHaveBeenCalledTimes(2);
      expect(result.cleanupState).toBe("completed");
      if (phase === "setup") {
        expect(result.blockers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ phase: "setup", stepId: "profile-version-7:first" }),
          ]),
        );
      }
    },
  );

  it.each(["setup", "build", "test"] as const)(
    "preserves an optional %s failure and continues later checks",
    async (phase) => {
      const fixture = harness();
      fixture.processRunner.run.mockRejectedValueOnce(
        new ManagedProcessRunError("NON_ZERO_EXIT", "Optional command failed.", { exitCode: 1 }),
      );
      const selectedProfile = profile({
        [phase]: [step("optional", { required: false }), step("later")],
      });

      const result = await fixture.run(selectedProfile);

      expect(result.report.checks[0]).toMatchObject({ required: false, outcome: "failed" });
      expect(result.report.checks.slice(1).every((check) => check.outcome === "passed")).toBe(true);
      expect(result.blockers).toEqual([]);
      expect(result.cleanupState).toBe("not_needed");
    },
  );

  it("records nonzero test exits as validation failures and still gathers other test evidence", async () => {
    const fixture = harness();
    fixture.processRunner.run.mockRejectedValueOnce(
      new ManagedProcessRunError("NON_ZERO_EXIT", "Assertions failed.", {
        exitCode: 3,
        stdout: "1 test failed",
        stderr: "assertion",
      }),
    );

    const result = await fixture.run(profile({ test: [step("failing"), step("independent")] }));

    expect(checkOutcomes(result)).toEqual([
      { id: "profile-version-7:failing", outcome: "failed" },
      { id: "profile-version-7:independent", outcome: "passed" },
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      stepId: "profile-version-7:failing",
      outcome: "failed",
      exitCode: 3,
      stdout: "1 test failed",
      stderr: "assertion",
    });
  });

  it("keeps issue reproduction inconclusive when generic checks pass", async () => {
    const fixture = harness();
    const selectedProfile: ValidationProfileVersion = {
      ...profile(),
      workflowKind: "issue_validation",
      target: "headless",
      outputSchemaVersion: "ValidationReportV1",
    };

    const result = await fixture.run(selectedProfile, "issue");

    expect(result.report).toMatchObject({
      workItemKind: "issue",
      reproductionConclusion: "inconclusive",
      sourceState: "original",
    });
    expect(result.report.checks[0]?.outcome).toBe("passed");
    expect(Value.Check(ValidationReportV1Schema, result.report)).toBe(true);
  });

  it.each([
    ["PROCESS_START_FAILED", "blocked"],
    ["OUTPUT_TRUNCATED", "inconclusive"],
    ["OUTPUT_READ_FAILED", "inconclusive"],
    ["INVALID_UTF8_OUTPUT", "inconclusive"],
    ["PROCESS_TERMINATED", "inconclusive"],
    ["ABORTED", "inconclusive"],
  ] as const)("classifies %s as %s without fabricating a test failure", async (code, outcome) => {
    const fixture = harness();
    fixture.processRunner.run.mockRejectedValueOnce(
      new ManagedProcessRunError(code, "Execution unavailable."),
    );

    const result = await fixture.run();

    expect(result.report.checks[0]?.outcome).toBe(outcome);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toMatchObject({ outcome, exitCode: null });
  });

  it("enforces a one-second step deadline without violating the native timeout minimum", async () => {
    vi.useFakeTimers();
    const fixture = harness();
    fixture.processRunner.run.mockImplementationOnce((_spec, context) =>
      waitForCancellation(context.signal),
    );
    const running = fixture.run(profile({ test: [step("short", { timeoutMs: 1_000 })] }));

    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.processRunner.run).toHaveBeenCalledTimes(1);
    const firstCall = fixture.processRunner.run.mock.calls[0];
    if (firstCall === undefined) throw new Error("The first process did not start.");
    const [spec, context] = firstCall;
    expect(spec.limits.hardTimeoutMs).toBeGreaterThanOrEqual(10_000);
    expect(context.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(context.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const result = await running;

    expect(context.signal.aborted).toBe(true);
    expect(result.report.checks[0]?.outcome).toBe("inconclusive");
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("blocks a step above the native maximum instead of silently shortening its timeout", async () => {
    const fixture = harness();

    const result = await fixture.run(
      profile({
        hardTimeoutMs: 8_000_000,
        test: [step("too-long", { timeoutMs: 7_200_001 })],
      }),
    );

    expect(fixture.processRunner.run).not.toHaveBeenCalled();
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PROFILE_LIMIT_UNSUPPORTED" })]),
    );
  });

  it("applies the profile deadline across successive steps", async () => {
    vi.useFakeTimers();
    const fixture = harness();
    fixture.processRunner.run
      .mockImplementationOnce(
        async () =>
          await new Promise<ManagedProcessRunResult>((resolve) => {
            setTimeout(() => resolve({ exitCode: 0, stdout: "first complete", stderr: "" }), 1_200);
          }),
      )
      .mockImplementationOnce((_spec, context) => waitForCancellation(context.signal));
    const running = fixture.run(
      profile({
        hardTimeoutMs: 2_000,
        noProgressTimeoutMs: 2_000,
        test: [step("first", { timeoutMs: 1_500 }), step("second", { timeoutMs: 1_500 })],
      }),
    );

    await vi.advanceTimersByTimeAsync(1_201);
    expect(fixture.processRunner.run).toHaveBeenCalledTimes(2);
    const secondSignal = fixture.processRunner.run.mock.calls[1]?.[1].signal;
    if (secondSignal === undefined) throw new Error("The second process did not start.");
    expect(secondSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(798);
    expect(secondSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const result = await running;

    expect(checkOutcomes(result)).toEqual([
      { id: "profile-version-7:first", outcome: "passed" },
      { id: "profile-version-7:second", outcome: "inconclusive" },
    ]);
  });

  it("waits for the cancelled managed process to settle before starting cleanup", async () => {
    vi.useFakeTimers();
    const fixture = harness();
    let announceStart!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    let rejectCheck!: (reason: unknown) => void;
    fixture.processRunner.run.mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectCheck = reject;
          announceStart();
        }),
    );
    const running = fixture.run(profile({ cleanup: [step("teardown")] }));
    await started;

    fixture.controller.abort(new Error("Lease was revoked."));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.processRunner.run).toHaveBeenCalledTimes(1);
    rejectCheck(new ManagedProcessRunError("ABORTED", "Process termination has completed."));
    const result = await running;

    expect(fixture.processRunner.run).toHaveBeenCalledTimes(2);
    expect(result.report.checks[0]?.outcome).toBe("inconclusive");
    expect(result.cleanupState).toBe("completed");
  });

  it("runs cleanup after cancellation with a fresh signal and preserves the cancelled outcome", async () => {
    const fixture = harness();
    fixture.processRunner.run.mockImplementationOnce(async (_spec, context) => {
      fixture.controller.abort(new Error("Lease was revoked."));
      return await waitForCancellation(context.signal);
    });

    const result = await fixture.run(profile({ cleanup: [step("teardown")] }));

    expect(checkOutcomes(result)).toEqual([
      { id: "profile-version-7:unit", outcome: "inconclusive" },
      { id: "profile-version-7:teardown", outcome: "passed" },
    ]);
    const cleanupContext = fixture.processRunner.run.mock.calls[1]?.[1];
    expect(cleanupContext?.signal).not.toBe(fixture.controller.signal);
    expect(cleanupContext?.signal.aborted).toBe(false);
    expect(result.cleanupState).toBe("completed");
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("observes a rejected monitor close after cancellation before running cleanup", async () => {
    const fixture = harness();
    fixture.closeMonitoring.mockRejectedValueOnce(new Error("Cancelled disk observation."));
    fixture.processRunner.run.mockImplementationOnce(async () => {
      fixture.controller.abort(new Error("The parent run was cancelled."));
      throw new ManagedProcessRunError("ABORTED", "The managed process was cancelled.");
    });

    const result = await fixture.run(profile({ cleanup: [step("teardown")] }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(checkOutcomes(result)).toEqual([
      { id: "profile-version-7:unit", outcome: "inconclusive" },
      { id: "profile-version-7:teardown", outcome: "passed" },
    ]);
    expect(fixture.closeMonitoring).toHaveBeenCalledTimes(2);
    expect(result.cleanupState).toBe("completed");
  });

  it("uses an independent cleanup deadline after the main step has timed out", async () => {
    vi.useFakeTimers();
    const fixture = harness({ cleanupTimeoutMs: 2_000 });
    fixture.processRunner.run.mockImplementation((_spec, context) =>
      waitForCancellation(context.signal),
    );
    const running = fixture.run(
      profile({
        test: [step("short", { timeoutMs: 1_000 })],
        cleanup: [step("teardown")],
      }),
    );

    await vi.advanceTimersByTimeAsync(1_001);
    expect(fixture.processRunner.run).toHaveBeenCalledTimes(2);
    const cleanupSignal = fixture.processRunner.run.mock.calls[1]?.[1].signal;
    if (cleanupSignal === undefined) throw new Error("The cleanup process did not start.");
    expect(cleanupSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_998);
    expect(cleanupSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const result = await running;

    expect(cleanupSignal.aborted).toBe(true);
    expect(result.cleanupState).toBe("failed");
    expect(result.report.checks[1]?.outcome).toBe("inconclusive");
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "cleanup", stepId: "profile-version-7:teardown" }),
      ]),
    );
  });

  it("retains a required cleanup failure as a blocker while attempting remaining cleanup", async () => {
    const fixture = harness();
    fixture.processRunner.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: "tests passed", stderr: "" })
      .mockRejectedValueOnce(
        new ManagedProcessRunError("NON_ZERO_EXIT", "Cleanup failed.", { exitCode: 5 }),
      );

    const result = await fixture.run(
      profile({ cleanup: [step("failed-cleanup"), step("remaining-cleanup")] }),
    );

    expect(checkOutcomes(result)).toEqual([
      { id: "profile-version-7:unit", outcome: "passed" },
      { id: "profile-version-7:failed-cleanup", outcome: "failed" },
      { id: "profile-version-7:remaining-cleanup", outcome: "passed" },
    ]);
    expect(result.cleanupState).toBe("failed");
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "cleanup", stepId: "profile-version-7:failed-cleanup" }),
      ]),
    );
  });

  it("resolves secrets only for execution and redacts them from all returned evidence", async () => {
    const secret = "unique-secret-value-654321";
    const resolveSecret = vi.fn(async (_ref: string, _signal: AbortSignal) => secret);
    const fixture = harness({ resolveSecret });
    fixture.processRunner.run.mockRejectedValueOnce(
      new ManagedProcessRunError("NON_ZERO_EXIT", `Failed while using ${secret}.`, {
        exitCode: 1,
        stdout: `request=${secret}\n`,
        stderr: `token ${secret} rejected`,
      }),
    );
    const selectedProfile = profile({
      test: [
        step("authenticated", {
          command: {
            executable: "dotnet",
            args: ["test"],
            workingDirectory: ".",
            environment: [{ name: "TEST_ACCESS_TOKEN", secretRef: "secret-reference-1" }],
          },
        }),
      ],
    });

    const result = await fixture.run(selectedProfile);

    expect(resolveSecret).toHaveBeenCalledWith("secret-reference-1", expect.any(AbortSignal));
    expect(fixture.processRunner.run.mock.calls[0]?.[0].environment.TEST_ACCESS_TOKEN).toBe(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(selectedProfile)).not.toContain(secret);
    expect(result.diagnostics[0]?.stdout).toContain("request=");
    expect(result.report.checks[0]?.outcome).toBe("failed");
  });

  it.each(["missing", "rejected"] as const)(
    "blocks an unresolved secret when the resolver is %s",
    async (mode) => {
      const fixture = harness(
        mode === "missing"
          ? {}
          : {
              resolveSecret: async () => {
                throw new Error("Secret store unavailable.");
              },
            },
      );

      const result = await fixture.run(
        profile({
          test: [
            step("authenticated", {
              command: {
                executable: "dotnet",
                args: ["test"],
                workingDirectory: ".",
                environment: [{ name: "TEST_ACCESS_TOKEN", secretRef: "secret-reference-1" }],
              },
            }),
          ],
        }),
      );

      expect(fixture.processRunner.run).not.toHaveBeenCalled();
      expect(result.report.checks[0]?.outcome).toBe("blocked");
      expect(result.blockers.length).toBeGreaterThan(0);
    },
  );

  it.each(["", "\ufffd"])(
    "redacts a secret prefix left at the end of native error preview truncation %j",
    async (partialCodePoint) => {
      const secret = "s3cr3tQ9-entire-sensitive-value-123456";
      const truncatedSecret = secret.slice(0, 8);
      const fixture = harness({ resolveSecret: async () => secret });
      fixture.processRunner.run.mockRejectedValueOnce(
        new ManagedProcessRunError("NON_ZERO_EXIT", "The native error preview was truncated.", {
          exitCode: 1,
          stdout: `prefix ${truncatedSecret}${partialCodePoint}`,
          stderr: `error ${truncatedSecret}${partialCodePoint}`,
        }),
      );

      const result = await fixture.run(
        profile({
          test: [
            step("authenticated", {
              command: {
                executable: "dotnet",
                args: ["test"],
                workingDirectory: ".",
                environment: [{ name: "TEST_ACCESS_TOKEN", secretRef: "secret-reference-1" }],
              },
            }),
          ],
        }),
      );

      expect(fixture.processRunner.run.mock.calls[0]?.[0].environment.TEST_ACCESS_TOKEN).toBe(
        secret,
      );
      expect(JSON.stringify(result)).not.toContain(truncatedSecret);
      expect(result.report.checks[0]?.outcome).toBe("failed");
      expect(result.diagnostics[0]?.stdout).toContain("prefix ");
      expect(result.diagnostics[0]?.stderr).toContain("error ");
    },
  );

  it("redacts successful output before truncation and keeps secrets scoped to their configured step", async () => {
    const secret = "unique-sensitive-boundary-value-123456";
    const fixture = harness({ resolveSecret: async () => secret });
    fixture.processRunner.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: `${"x".repeat(2_040)}${secret}`,
      stderr: `diagnostic ${secret}`,
    });
    const selectedProfile = profile({
      test: [
        step("authenticated", {
          command: {
            executable: "dotnet",
            args: ["test"],
            workingDirectory: ".",
            environment: [{ name: "TEST_ACCESS_TOKEN", secretRef: "secret-reference-1" }],
          },
        }),
        step("unprivileged"),
      ],
      cleanup: [step("teardown")],
    });

    const result = await fixture.run(selectedProfile);

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret.slice(0, 8));
    expect(result.report.checks.every((check) => check.outcome === "passed")).toBe(true);
    expect(fixture.processRunner.run.mock.calls[0]?.[0].environment.TEST_ACCESS_TOKEN).toBe(secret);
    expect(fixture.processRunner.run.mock.calls[1]?.[0].environment).not.toHaveProperty(
      "TEST_ACCESS_TOKEN",
    );
    expect(fixture.processRunner.run.mock.calls[2]?.[0].environment).not.toHaveProperty(
      "TEST_ACCESS_TOKEN",
    );
    expect(baseEnvironment).not.toHaveProperty("TEST_ACCESS_TOKEN");
  });

  it.each(["Path", "PSModuleAnalysisCachePath", "psmoduleanalysiscachepath"])(
    "blocks profile attempts to override reserved %s with different Windows casing",
    async (name) => {
      const fixture = harness();

      const result = await fixture.run(
        profile({
          test: [
            step("custom-path", {
              command: {
                executable: "dotnet",
                args: ["test"],
                workingDirectory: ".",
                environment: [{ name, value: "C:\\CustomTools" }],
              },
            }),
          ],
        }),
      );

      expect(fixture.processRunner.run).not.toHaveBeenCalled();
      expect(baseEnvironment.PATH).toBe("C:\\Windows\\System32;C:\\Tools");
      expect(result.report.checks[0]?.outcome).toBe("blocked");
      expect(result.blockers.length).toBeGreaterThan(0);
    },
  );

  it("blocks executable resolution errors before invoking ProcessHost", async () => {
    const fixture = harness({
      resolveExecutable: async () => {
        throw new Error("The configured tool is not installed.");
      },
    });

    const result = await fixture.run();

    expect(fixture.processRunner.run).not.toHaveBeenCalled();
    expect(result.report.checks[0]?.outcome).toBe("blocked");
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("does not execute a check when disk monitoring cannot start and still attempts cleanup", async () => {
    const fixture = harness();
    fixture.startDiskMonitoring.mockRejectedValueOnce(new Error("Disk accounting is unavailable."));

    const result = await fixture.run(profile({ cleanup: [step("teardown")] }));

    expect(fixture.processRunner.run).toHaveBeenCalledTimes(1);
    expect(fixture.processRunner.run.mock.calls[0]?.[0].arguments).toEqual(["teardown"]);
    expect(checkOutcomes(result)).toEqual([
      { id: "profile-version-7:unit", outcome: "blocked" },
      { id: "profile-version-7:teardown", outcome: "passed" },
    ]);
    expect(result.cleanupState).toBe("completed");
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("does not report a successful check when its final disk accounting fails", async () => {
    const fixture = harness();
    fixture.closeMonitoring.mockRejectedValueOnce(new Error("Final workspace accounting failed."));

    const result = await fixture.run();

    expect(fixture.processRunner.run).toHaveBeenCalledTimes(1);
    expect(result.report.checks[0]?.outcome).toBe("blocked");
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it.each([
    "../outside",
    "src/../../outside",
    "C:\\outside",
    "\\\\server\\share",
    "src:stream",
    "src/.. ",
    "src/name.",
    "NUL",
    "CON.txt",
  ])("rejects the unsafe working directory %s before execution", async (workingDirectory) => {
    const fixture = harness();

    const result = await fixture.run(
      profile({
        test: [
          step("unsafe-path", {
            command: { executable: "dotnet", args: ["test"], workingDirectory, environment: [] },
          }),
        ],
      }),
    );

    expect(fixture.processRunner.run).not.toHaveBeenCalled();
    expect(result.report.checks.every((check) => check.outcome !== "passed")).toBe(true);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("rechecks directory links after setup changes the workspace", async () => {
    const fixture = harness();
    let setupFinished = false;
    fixture.processRunner.run.mockImplementationOnce(async () => {
      setupFinished = true;
      return { exitCode: 0, stdout: "prepared", stderr: "" };
    });
    fixture.fileSystem.lstat.mockImplementation(async (path) => ({
      isDirectory: () => true,
      isSymbolicLink: () =>
        setupFinished && path.toLowerCase() === win32.join(paths.checkout, "src").toLowerCase(),
    }));

    const result = await fixture.run(
      profile({
        setup: [
          step("prepare", {
            command: {
              executable: "dotnet",
              args: ["prepare"],
              workingDirectory: "src",
              environment: [],
            },
          }),
        ],
        test: [
          step("after-setup", {
            command: {
              executable: "dotnet",
              args: ["test"],
              workingDirectory: "src",
              environment: [],
            },
          }),
        ],
      }),
    );

    expect(fixture.processRunner.run).toHaveBeenCalledTimes(1);
    expect(checkOutcomes(result)).toEqual([
      { id: "profile-version-7:prepare", outcome: "passed" },
      { id: "profile-version-7:after-setup", outcome: "blocked" },
    ]);
  });

  it("accepts a canonical workspace path with different Windows casing", async () => {
    const fixture = harness();
    fixture.fileSystem.realpath.mockImplementation(async (path) =>
      win32.normalize(path).toLowerCase(),
    );

    const result = await fixture.run();

    expect(fixture.processRunner.run).toHaveBeenCalledTimes(1);
    expect(result.blockers).toEqual([]);
    expect(result.report.checks[0]?.outcome).toBe("passed");
  });

  it.each(["ancestor-link", "canonical-escape", "sibling-prefix", "regular-file"] as const)(
    "blocks a directory with %s even when its configured relative path appears safe",
    async (failure) => {
      const fixture = harness();
      const sourceDirectory = win32.join(paths.checkout, "src");
      if (failure === "ancestor-link") {
        fixture.fileSystem.lstat.mockImplementation(async (path) => ({
          isDirectory: () => true,
          isSymbolicLink: () => path.toLowerCase() === sourceDirectory.toLowerCase(),
        }));
      } else if (failure === "regular-file") {
        fixture.fileSystem.lstat.mockImplementation(async (path) => ({
          isDirectory: () =>
            path.toLowerCase() !== win32.join(paths.checkout, "src", "Project").toLowerCase(),
          isSymbolicLink: () => false,
        }));
      } else {
        fixture.fileSystem.realpath.mockImplementation(async (path) =>
          path.toLowerCase() === paths.checkout.toLowerCase()
            ? paths.checkout
            : failure === "sibling-prefix"
              ? `${paths.checkout}-untrusted\\src\\Project`
              : "C:\\Outside\\Project",
        );
      }

      const result = await fixture.run(
        profile({
          test: [
            step("unsafe-path", {
              command: {
                executable: "dotnet",
                args: ["test"],
                workingDirectory: "src/Project",
                environment: [],
              },
            }),
          ],
        }),
      );

      expect(fixture.processRunner.run).not.toHaveBeenCalled();
      expect(result.report.checks[0]?.outcome).toBe("blocked");
      expect(result.blockers.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ["clean", "clean", "original"],
    ["modified", "clean", "modified"],
    ["clean", "modified", "modified"],
    ["unknown", "clean", "unknown"],
    ["clean", "unknown", "unknown"],
  ] as const)("reports source state %s then %s as %s", async (initial, final, expected) => {
    const fixture = harness();
    fixture.captureWorktreeState.mockResolvedValueOnce(initial).mockResolvedValueOnce(final);

    const result = await fixture.run();

    expect(result.report.sourceState).toBe(expected);
    expect(fixture.captureWorktreeState.mock.calls.length).toBeGreaterThanOrEqual(2);
    if (expected === "original") {
      expect(result.blockers).toEqual([]);
    } else {
      expect(result.blockers.length).toBeGreaterThan(0);
    }
  });

  it("preserves an unknown initial source state when the final inspection succeeds", async () => {
    const fixture = harness();
    fixture.captureWorktreeState.mockRejectedValueOnce(new Error("Git status was unavailable."));

    const result = await fixture.run();

    expect(result.report.sourceState).toBe("unknown");
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("reports unknown source state when the workspace cannot inspect its worktree", async () => {
    const fixture = harness();
    delete fixture.workspace.captureWorktreeState;

    const result = await fixture.run();

    expect(result.report.sourceState).toBe("unknown");
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SOURCE_STATE_UNKNOWN" })]),
    );
  });

  it("finishes one final source observation within the budget when cleanup has no commands", async () => {
    vi.useFakeTimers();
    const fixture = harness({ cleanupTimeoutMs: 1000 });
    fixture.captureWorktreeState
      .mockResolvedValueOnce("clean")
      .mockImplementation(
        async () =>
          new Promise<WorktreeState>((resolve) => setTimeout(() => resolve("clean"), 600)),
      );
    const running = fixture.run(profile({ cleanup: [] }));
    await vi.runAllTimersAsync();
    const result = await running;
    expect(fixture.captureWorktreeState).toHaveBeenCalledTimes(2);
    expect(result.report.sourceState).toBe("original");
    expect(result.cleanupState).toBe("not_needed");
    expect(result.blockers).toEqual([]);
  });

  it("retains modified source evidence even when cleanup restores a clean worktree", async () => {
    const fixture = harness();
    let state: WorktreeState = "clean";
    const events: string[] = [];
    fixture.captureWorktreeState.mockImplementation(async () => {
      events.push(`capture:${state}`);
      return state;
    });
    fixture.processRunner.run.mockImplementation(async (spec) => {
      const cleanup = spec.arguments[0] === "restore-checkout";
      events.push(cleanup ? "cleanup" : "test");
      state = cleanup ? "clean" : "modified";
      return { exitCode: 0, stdout: "completed", stderr: "" };
    });

    const result = await fixture.run(profile({ cleanup: [step("restore-checkout")] }));

    expect(fixture.captureWorktreeState).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      "capture:clean",
      "test",
      "capture:modified",
      "cleanup",
      "capture:clean",
    ]);
    expect(result.cleanupState).toBe("completed");
    expect(result.report.sourceState).toBe("modified");
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SOURCE_STATE_MODIFIED" })]),
    );
  });

  it.each(["pr-ui", "issue-desktop", "headless-launch"] as const)(
    "requires the appropriate driver for %s without executing any configured command",
    async (kind) => {
      const fixture = harness();
      const headlessProfile = profile({ setup: [step("prepare")], cleanup: [step("teardown")] });
      const selectedProfile: ValidationProfileVersion =
        kind === "pr-ui"
          ? {
              ...headlessProfile,
              workflowKind: "pr_ui",
              target: "web",
              outputSchemaVersion: "ValidationReportV1",
            }
          : kind === "issue-desktop"
            ? {
                ...headlessProfile,
                workflowKind: "issue_validation",
                target: "windows_desktop",
                outputSchemaVersion: "ValidationReportV1",
              }
            : profile({ ...headlessProfile.config, launch: [step("launch-ui")] });

      const result = await fixture.run(
        selectedProfile,
        kind === "issue-desktop" ? "issue" : "pull_request",
      );

      expect(fixture.processRunner.run).not.toHaveBeenCalled();
      expect(fixture.resolveExecutable).not.toHaveBeenCalled();
      expect(result.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: kind === "headless-launch" ? "UNSUPPORTED_LAUNCH_STAGE" : "UI_DRIVER_REQUIRED",
          }),
        ]),
      );
      expect(result.report.checks.every((check) => check.outcome !== "passed")).toBe(true);
    },
  );
});
