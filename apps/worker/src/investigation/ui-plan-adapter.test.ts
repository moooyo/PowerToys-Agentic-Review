import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { InvestigationTaskV1, UiScenarioExecutionEvidenceV1 } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ManagedProcessRunContext } from "../execution/managed-process-runner.js";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessLaunchSpec,
} from "../execution/process-host-protocol.js";
import {
  parseWebDriverRequest,
  type WebDriverRequest,
  type WebDriverResult,
} from "../ui/web-driver.js";
import type { WindowsDriverRequest, WindowsDriverResult } from "../ui/windows-driver.js";
import type { InvestigationUiPlanAdapter } from "./plan-executor.js";
import {
  type InvestigationUiPlanAdapterConfiguration,
  InvestigationUiPlanAdapterError,
  ProductionInvestigationUiPlanAdapter,
  parseInvestigationUiPlanAdapterConfiguration,
} from "./ui-plan-adapter.js";

type Input = Parameters<InvestigationUiPlanAdapter["execute"]>[0];
type Result = WebDriverResult | WindowsDriverResult;
const now = "2026-09-15T12:00:00.000Z";
const screenshotId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const stepsId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const screenshot = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const limits = {
  hardTimeoutMs: 60_000,
  maximumProcessCount: 16,
  maximumMemoryBytes: 536_870_912,
  maximumOutputBytes: 1_048_576,
};
const pinned = (path: string) => ({ path, sha256: "1".repeat(64) });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function configuration(
  target: "web" | "windows_desktop" = "web",
): InvestigationUiPlanAdapterConfiguration {
  const common = {
    schemaVersion: "InvestigationUiPlanAdapterConfigurationV1" as const,
    application: {
      kind: "registered" as const,
      executableId: "application",
      arguments: ["app.js"],
      workingDirectory: ".",
    },
    windowsDriver: {
      executable: pinned("C:\\trusted\\powershell.exe"),
      entry: pinned("C:\\trusted\\windows-driver.ps1"),
    },
  };
  const step = {
    id: "assert-saved",
    name: "Check saved text",
    action: "assertText" as const,
    expected: "Saved",
    match: "exact" as const,
    timeoutMs: 1_000,
  };
  if (target === "windows_desktop")
    return {
      ...common,
      desktopLockDirectory: "C:\\worker\\desktop-locks",
      profile: {
        schemaVersion: "UiScenariosV1",
        target,
        desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
        launch: {
          stepId: "launch",
          mode: "persistent",
          readiness: { kind: "window", window: { title: "Owned application" }, timeoutMs: 10_000 },
        },
        reset: { strategy: "restart_process" },
        evidence: {
          screenshots: "every_assertion",
          screenshotScope: "owned_window",
          required: true,
        },
        scenarios: [
          {
            id: "scenario",
            name: "Save settings",
            required: true,
            timeoutMs: 10_000,
            steps: [{ ...step, locator: { by: "automationId", automationId: "result" } }],
          },
        ],
      },
    };
  return {
    ...common,
    webDriver: {
      executable: pinned("C:\\trusted\\node.exe"),
      entry: pinned("C:\\trusted\\web-driver.mjs"),
      browser: pinned("C:\\trusted\\chromium.exe"),
    },
    profile: {
      schemaVersion: "UiScenariosV1",
      target,
      service: {
        origin: "managed_loopback",
        portEnvironmentVariable: "APP_PORT",
        navigation: "same_origin",
      },
      browser: { engine: "chromium", headless: true, viewport: { width: 800, height: 600 } },
      launch: {
        stepId: "launch",
        mode: "persistent",
        readiness: { kind: "http", path: "/health", expectedStatus: 200, timeoutMs: 10_000 },
      },
      reset: { strategy: "restart_process" },
      evidence: {
        screenshots: "every_assertion",
        screenshotScope: "viewport",
        trace: "off",
        required: true,
      },
      scenarios: [
        {
          id: "scenario",
          name: "Save settings",
          path: "/",
          required: true,
          timeoutMs: 10_000,
          steps: [{ ...step, locator: { by: "testId", testId: "result" } }],
        },
      ],
    },
  };
}

function task(): InvestigationTaskV1 {
  return {
    schemaVersion: "InvestigationTaskV1",
    id: "task",
    kind: "pr-verify",
    repository: { id: "repository", githubRepositoryId: 1, fullName: "synthetic/fixture" },
    workItem: { id: "work-item", kind: "pull_request", number: 1, title: "Synthetic UI fixture" },
    parentTaskId: "parent-task",
    parentReportRef: { id: "parent-report", version: 1, digest: "a".repeat(64) },
    planRef: { id: "plan", version: 1, digest: "b".repeat(64) },
    subjectRef: "subject",
    subjects: [
      {
        id: "subject",
        kind: "original_pr",
        repositoryId: "repository",
        workItemId: "work-item",
        revisionKey: "c".repeat(64),
        baseSha: "d".repeat(40),
        headSha: "e".repeat(40),
      },
    ],
    scope: {
      scopeManifest: { id: "scope", version: 1, digest: "f".repeat(64) },
      includedUnits: [],
      exclusions: [],
      completedUnitRefs: [],
      unresolvedUnitRefs: [],
    },
    executionPolicy: {
      mode: "execute",
      allowRepositoryExecution: true,
      authorizationRef: "authorization",
      allowedSubjectRefs: ["subject"],
    },
    budget: { maxRounds: 8, maxDurationMs: 300_000, maxTokens: 100_000, maxReportBytes: 8_388_608 },
    profileRef: { id: "profile", version: 1, digest: "a".repeat(64) },
    promptRef: { id: "prompt", version: 1, digest: "b".repeat(64) },
    state: "running",
    latestReportRef: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Process, filesystem, network, and desktop dependencies are isolated mocks. */
function fixture(target: "web" | "windows_desktop" = "web") {
  const configured = configuration(target);
  const frozenTask = task();
  const workspace = {
    attemptDirectory: "C:\\worker\\attempt",
    controlDirectory: "C:\\worker\\attempt\\control",
    tempDirectory: "C:\\worker\\attempt\\temp",
    sourceDirectory: "C:\\worker\\attempt\\source",
    sourceBinding: {
      subjectRef: "subject",
      revisionKey: "c".repeat(64),
      sourceSha: "e".repeat(40),
      patchDigest: null,
      artifactRef: null,
    },
    assertIntegrity: vi.fn(async () => undefined),
    assertSourceBinding: vi.fn(async () => undefined),
    resolveSourcePath: vi.fn(
      async (path: string) => `C:\\worker\\attempt\\source\\${path.replaceAll("/", "\\")}`,
    ),
  } as unknown as Input["workspace"];
  const input: Input = {
    scenarioId: "scenario",
    task: frozenTask,
    attempt: {
      schemaVersion: "InvestigationAttemptV1",
      id: "attempt",
      taskId: frozenTask.id,
      number: 1,
      workerId: "worker",
      leaseVersion: 1,
      state: "running",
      startedAt: now,
      finishedAt: null,
      terminationReason: null,
    },
    workspace,
  };
  let complete!: (event: ProcessExitedEvent) => void;
  const completed = new Promise<ProcessExitedEvent>((resolve) => {
    complete = resolve;
  });
  const exited: ProcessExitedEvent = {
    protocolVersion: "1.0",
    type: "exited",
    requestId: "app-request",
    exitCode: 0,
    signal: null,
    outputTruncated: false,
  };
  const managed: ManagedProcess = {
    requestId: "app-request",
    processId: 1_234,
    processCreationTimeFileTime: "133900000000000001",
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    completed,
    terminate: vi.fn(async () => {
      complete(exited);
    }),
  };
  const processHost = {
    start: vi.fn(async () => managed),
    terminateAll: vi.fn(),
    close: vi.fn(),
  } as unknown as ProcessHostClient;
  const files = new Map<string, Uint8Array>();
  const fileSystem = {
    verifyPinnedFile: vi.fn(async () => undefined),
    createEvidenceDirectory: vi.fn(async () => undefined),
    readEvidenceFile: vi.fn(async (_directory: string, path: string, _maximum: number) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error("Synthetic evidence file missing.");
      return bytes;
    }),
  };
  const desktop = {
    sessionId: 2,
    releaseRestored: vi.fn(async () => undefined),
    quarantine: vi.fn(async () => undefined),
  };
  const controls = {
    resultMutator: (_result: Result): void => undefined,
    fileMutator: (_files: Map<string, Uint8Array>): void => undefined,
    sessionAvailable: true,
    rejectOutput: false,
  };
  const runner = {
    run: vi.fn(async (spec: ProcessLaunchSpec, context: ManagedProcessRunContext) => {
      context.signal.throwIfAborted();
      const request = JSON.parse(spec.standardInput!) as {
        schemaVersion: string;
        rootProcess?: unknown;
        port?: number;
      };
      if (request.schemaVersion === "WindowsSessionProbeRequestV1")
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schemaVersion: "WindowsSessionProbeResultV1",
            available: controls.sessionAvailable,
            sessionId: controls.sessionAvailable ? 2 : null,
            reasonCode: controls.sessionAvailable ? "ready" : "interactive_session_unavailable",
          }),
        };
      if (request.schemaVersion === "WindowsTcpOwnerProbeRequestV1")
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schemaVersion: "WindowsTcpOwnerProbeResultV1",
            rootProcess: request.rootProcess,
            port: request.port,
            owned: true,
            reasonCode: "owned",
          }),
        };
      const result = createResult(request as WebDriverRequest | WindowsDriverRequest, files);
      controls.resultMutator(result);
      controls.fileMutator(files);
      return {
        exitCode: 0,
        stdout: controls.rejectOutput ? "Unstructured driver output" : JSON.stringify(result),
        stderr: "",
      };
    }),
  };
  const options = {
    configuration: configured,
    environment: { SYSTEMROOT: "C:\\Windows" },
    processLimits: limits,
    executables: { application: "C:\\trusted\\app-host.exe" },
    processRunner: runner,
    fileSystem,
    acquireDesktop: vi.fn(async () => desktop),
    allocatePort: vi.fn(async () => 31_234),
    httpReadiness: vi.fn(async () => true),
    createId: () => "11111111-1111-1111-1111-111111111111",
  };
  return {
    input,
    options,
    controls,
    files,
    runner,
    fileSystem,
    managed,
    processHost,
    desktop,
    context: { signal: new AbortController().signal, processHost },
    complete,
    exited,
  };
}

function createResult(
  request: WebDriverRequest | WindowsDriverRequest,
  files: Map<string, Uint8Array>,
): Result {
  const target = request.schemaVersion === "WebDriverRequestV1" ? "web" : "windows_desktop";
  const execution: UiScenarioExecutionEvidenceV1 = {
    schemaVersion: "UiScenarioExecutionEvidenceV1",
    source: "ui_driver",
    target,
    scenarioId: request.scenario.id,
    steps: [
      {
        stepId: "assert-saved",
        name: "Check saved text",
        action: "assertText",
        expected: "Saved",
        actual: "Saved",
        outcome: "passed",
        summary: "The synthetic observation matched the planned text.",
        evidenceIds: [screenshotId],
      },
    ],
  };
  const directory = `${target === "web" ? "web" : "windows"}-cccccccc-cccc-cccc-cccc-cccccccccccc`;
  const stepBytes = Buffer.from(JSON.stringify(execution), "utf8");
  const evidenceFiles = [
    {
      id: screenshotId,
      relativePath: `${directory}/${screenshotId}.png`,
      kind: "screenshot" as const,
      mediaType: "image/png" as const,
      sizeBytes: screenshot.byteLength,
      sha256: hash(screenshot),
    },
    {
      id: stepsId,
      relativePath: `${directory}/${stepsId}.json`,
      kind: "ui_steps" as const,
      mediaType: "application/json" as const,
      sizeBytes: stepBytes.byteLength,
      sha256: hash(stepBytes),
    },
  ];
  files.set(evidenceFiles[0]!.relativePath, screenshot);
  files.set(evidenceFiles[1]!.relativePath, stepBytes);
  const result = {
    scenarioId: request.scenario.id,
    outcome: "passed" as const,
    reasonCode: "completed" as const,
    summary: "The configured synthetic scenario passed.",
    evidenceComplete: true,
    execution,
    evidenceFiles,
  };
  return target === "web"
    ? { ...result, schemaVersion: "WebDriverResultV1", browserVersion: "Synthetic Chromium 1" }
    : { ...result, schemaVersion: "WindowsDriverResultV1" };
}

describe("standalone investigation UI plan adapter", () => {
  it("validates Windows wire paths independently of the host running protocol validation", () => {
    const configured = configuration();
    const profile = configured.profile;
    if (profile.target !== "web") throw new Error("Synthetic Web profile missing.");
    const request: WebDriverRequest = {
      schemaVersion: "WebDriverRequestV1",
      servicePort: 31_234,
      scenario: profile.scenarios[0]!,
      browser: profile.browser,
      evidence: profile.evidence,
      browserExecutablePath: configured.webDriver!.browser.path,
      evidenceDirectory: "C:\\worker\\attempt\\control\\ui-owned",
    };
    expect(parseWebDriverRequest(request, { pathPlatform: "windows" })).toEqual(request);
    expect(() =>
      parseWebDriverRequest({ ...request, pathPlatform: "native" }, { pathPlatform: "windows" }),
    ).toThrow();
  });

  it.each([
    "browser.exe",
    "C:browser.exe",
    "/tmp/browser.exe",
    "\\\\server\\share\\browser.exe",
    "C:\\trusted\\..\\browser.exe",
    "C:\\trusted\\browser.exe:stream",
    "C:\\trusted\\NUL.exe",
    "C:\\trusted\\browser.exe.",
  ])("rejects an unsafe Windows browser wire path: %s", (browserExecutablePath) => {
    const profile = configuration().profile;
    if (profile.target !== "web") throw new Error("Synthetic Web profile missing.");
    expect(() =>
      parseWebDriverRequest(
        {
          schemaVersion: "WebDriverRequestV1",
          servicePort: 31_234,
          scenario: profile.scenarios[0]!,
          browser: profile.browser,
          evidence: profile.evidence,
          browserExecutablePath,
          evidenceDirectory: "C:\\worker\\attempt\\control\\ui-owned",
        },
        { pathPlatform: "windows" },
      ),
    ).toThrow();
  });

  it.each(["web", "windows_desktop"] as const)(
    "runs a trusted %s scenario and returns the exact verified evidence bytes",
    async (target) => {
      const f = fixture(target);
      const result = await new ProductionInvestigationUiPlanAdapter(f.options).execute(
        f.input,
        f.context,
      );
      expect(result.status).toBe("passed");
      expect(result.artifacts?.map((artifact) => artifact.kind)).toEqual(["image", "log"]);
      expect(result.artifacts?.[0]?.bytes).toEqual(Uint8Array.from(screenshot));
      expect(result.observation).toMatchObject({
        schemaVersion: "InvestigationUiObservationV1",
        scenarioId: "scenario",
        driver: { outcome: "passed" },
      });
      expect(f.fileSystem.verifyPinnedFile).toHaveBeenCalledTimes(target === "web" ? 5 : 2);
      expect(f.fileSystem.createEvidenceDirectory).toHaveBeenCalledWith(
        "C:\\worker\\attempt\\control\\ui-11111111-1111-1111-1111-111111111111",
      );
      expect(f.managed.terminate).toHaveBeenCalledWith("cancelled");
      expect(f.processHost.terminateAll).not.toHaveBeenCalled();
      const launch = vi.mocked(f.processHost.start).mock.calls[0]![0];
      expect(launch).toMatchObject({
        captureProcessIdentity: true,
        executable: "C:\\trusted\\app-host.exe",
        environmentMode: "replace",
        environment: {
          SYSTEMROOT: "C:\\Windows",
          TEMP: "C:\\worker\\attempt\\temp",
          TMP: "C:\\worker\\attempt\\temp",
        },
      });
      if (target === "web") {
        expect(launch.environment.APP_PORT).toBe("31234");
        const probes = f.runner.run.mock.calls
          .map(([spec]) => JSON.parse(spec.standardInput!))
          .filter((request) => request.schemaVersion === "WindowsTcpOwnerProbeRequestV1");
        expect(probes).toHaveLength(2);
        expect(probes[0]).toMatchObject({
          rootProcess: { pid: 1_234, creationTimeFileTime: "133900000000000001" },
          port: 31_234,
        });
        expect(f.options.acquireDesktop).not.toHaveBeenCalled();
      } else {
        expect(f.options.acquireDesktop).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 2, lockDirectory: "C:\\worker\\desktop-locks" }),
        );
        expect(f.desktop.releaseRestored).toHaveBeenCalledOnce();
        expect(f.desktop.quarantine).not.toHaveBeenCalled();
      }
    },
  );

  it("launches a source-relative application only through the workspace resolver", async () => {
    const f = fixture("windows_desktop");
    f.options.configuration.application = {
      kind: "source",
      path: "bin/app.exe",
      arguments: [],
      workingDirectory: "bin",
    };
    await new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context);
    expect(f.input.workspace.resolveSourcePath).toHaveBeenCalledWith("bin/app.exe");
    expect(f.input.workspace.resolveSourcePath).toHaveBeenCalledWith("bin");
    expect(vi.mocked(f.processHost.start).mock.calls[0]![0]).toMatchObject({
      executable: "C:\\worker\\attempt\\source\\bin\\app.exe",
      workingDirectory: "C:\\worker\\attempt\\source\\bin",
    });
  });

  it("preserves actual assertion failure instead of promoting it to a passing result", async () => {
    const f = fixture();
    f.controls.resultMutator = (result) => {
      result.outcome = "failed";
      result.reasonCode = "assertion_failed";
      const step = result.execution.steps[0]!;
      step.outcome = "failed";
      step.actual = "Not saved";
      const bytes = Buffer.from(JSON.stringify(result.execution));
      const asset = result.evidenceFiles.find((file) => file.kind === "ui_steps")!;
      asset.sizeBytes = bytes.byteLength;
      asset.sha256 = hash(bytes);
      f.files.set(asset.relativePath, bytes);
    };
    const result = await new ProductionInvestigationUiPlanAdapter(f.options).execute(
      f.input,
      f.context,
    );
    expect(result.status).toBe("failed");
    expect(result.artifacts).toHaveLength(2);
  });

  it.each(["unknown-scenario", "read-only", "subject", "attempt"] as const)(
    "rejects %s before starting any UI process",
    async (failure) => {
      const f = fixture();
      if (failure === "unknown-scenario") Object.assign(f.input, { scenarioId: "model-invented" });
      else if (failure === "read-only") f.input.task.executionPolicy.mode = "source_read";
      else if (failure === "subject") f.input.task.executionPolicy.allowedSubjectRefs = [];
      else f.input.attempt.taskId = "unrelated";
      await expect(
        new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
      ).rejects.toBeInstanceOf(InvestigationUiPlanAdapterError);
      expect(f.processHost.start).not.toHaveBeenCalled();
      expect(f.runner.run).not.toHaveBeenCalled();
    },
  );

  it("requires every driver and browser file to match its trusted digest before execution", async () => {
    const f = fixture();
    f.fileSystem.verifyPinnedFile.mockRejectedValueOnce(new Error("Synthetic digest mismatch."));
    await expect(
      new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
    ).rejects.toMatchObject({ code: "UI_TRUSTED_FILE_INVALID" });
    expect(f.processHost.start).not.toHaveBeenCalled();
  });

  it("rejects a driver executable placed inside the mutable task workspace", async () => {
    const f = fixture();
    f.options.configuration.webDriver!.executable.path = "C:\\worker\\attempt\\source\\driver.exe";
    await expect(
      new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
    ).rejects.toMatchObject({ code: "UI_TRUSTED_FILE_INVALID" });
    expect(f.processHost.start).not.toHaveBeenCalled();
  });

  it.each(["malformed", "scenario", "extra-authority", "escaping-path", "false-success"] as const)(
    "rejects %s driver output and still stops its owned application",
    async (failure) => {
      const f = fixture();
      if (failure === "malformed") f.controls.rejectOutput = true;
      else
        f.controls.resultMutator = (result) => {
          if (failure === "scenario") result.scenarioId = "different";
          else if (failure === "extra-authority") Object.assign(result, { authority: "worker" });
          else if (failure === "escaping-path")
            result.evidenceFiles[0]!.relativePath = "../../secret.png";
          else result.evidenceComplete = false;
        };
      await expect(
        new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
      ).rejects.toMatchObject({ code: "UI_DRIVER_RESULT_INVALID" });
      expect(f.managed.terminate).toHaveBeenCalledOnce();
    },
  );

  it.each(["missing", "digest", "size", "png-signature"] as const)(
    "rejects evidence with an invalid %s receipt",
    async (failure) => {
      const f = fixture();
      f.controls.fileMutator = (files) => {
        const entry = [...files.keys()].find((path) => path.endsWith(".png"))!;
        if (failure === "missing") files.delete(entry);
        else if (failure === "size")
          files.set(entry, screenshot.subarray(0, screenshot.byteLength - 1));
        else {
          const corrupt = Buffer.from(screenshot);
          corrupt[0] = 0;
          files.set(entry, corrupt);
        }
      };
      if (failure === "png-signature")
        f.controls.resultMutator = (result) => {
          const corrupt = Buffer.from(screenshot);
          corrupt[0] = 0;
          result.evidenceFiles[0]!.sha256 = hash(corrupt);
        };
      await expect(
        new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
      ).rejects.toMatchObject({ code: "UI_EVIDENCE_INVALID" });
      expect(f.managed.terminate).toHaveBeenCalledOnce();
    },
  );

  it("does not claim ownership from a PID without its exact ProcessHost creation identity", async () => {
    const f = fixture("windows_desktop");
    delete (f.managed as { processCreationTimeFileTime?: string }).processCreationTimeFileTime;
    await expect(
      new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
    ).rejects.toMatchObject({ code: "UI_APPLICATION_IDENTITY_UNAVAILABLE" });
    expect(f.managed.terminate).toHaveBeenCalledOnce();
    expect(f.desktop.releaseRestored).toHaveBeenCalledOnce();
  });

  it("does not launch a desktop application without an available exclusive interactive session", async () => {
    const f = fixture("windows_desktop");
    f.controls.sessionAvailable = false;
    await expect(
      new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
    ).rejects.toMatchObject({ code: "UI_DESKTOP_UNAVAILABLE" });
    expect(f.processHost.start).not.toHaveBeenCalled();
    expect(f.options.acquireDesktop).not.toHaveBeenCalled();
  });

  it("quarantines the desktop and propagates unconfirmed process cleanup", async () => {
    const f = fixture("windows_desktop");
    vi.mocked(f.managed.terminate).mockRejectedValueOnce(
      new Error("Synthetic termination failure."),
    );
    await expect(
      new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
    ).rejects.toMatchObject({ code: "UI_PROCESS_CLEANUP_UNCONFIRMED" });
    expect(f.desktop.quarantine).toHaveBeenCalledWith("UI_PROCESS_CLEANUP_UNCONFIRMED");
    expect(f.desktop.releaseRestored).not.toHaveBeenCalled();
  });

  it("preserves the cleanup fault over a driver failure and a quarantine recording failure", async () => {
    const f = fixture("windows_desktop");
    f.controls.rejectOutput = true;
    vi.mocked(f.managed.terminate).mockRejectedValueOnce(
      new Error("Synthetic termination failure."),
    );
    f.desktop.quarantine.mockRejectedValueOnce(
      new Error("Synthetic quarantine recording failure."),
    );
    await expect(
      new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
    ).rejects.toMatchObject({ code: "UI_PROCESS_CLEANUP_UNCONFIRMED" });
    expect(f.desktop.quarantine).toHaveBeenCalledWith("UI_PROCESS_CLEANUP_UNCONFIRMED");
    expect(f.desktop.releaseRestored).not.toHaveBeenCalled();
  });

  it("does not return a passing result when the exclusive desktop release fails", async () => {
    const f = fixture("windows_desktop");
    f.desktop.releaseRestored.mockRejectedValueOnce(
      new Error("Synthetic desktop release failure."),
    );
    await expect(
      new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, f.context),
    ).rejects.toMatchObject({ code: "UI_PROCESS_CLEANUP_UNCONFIRMED" });
    expect(f.desktop.quarantine).toHaveBeenCalledWith("UI_DESKTOP_RELEASE_UNCONFIRMED");
  });

  it("honors cancellation before touching any runtime dependency", async () => {
    const f = fixture();
    const cancellation = new Error("Synthetic task cancellation.");
    await expect(
      new ProductionInvestigationUiPlanAdapter(f.options).execute(f.input, {
        ...f.context,
        signal: AbortSignal.abort(cancellation),
      }),
    ).rejects.toBe(cancellation);
    expect(f.fileSystem.verifyPinnedFile).not.toHaveBeenCalled();
    expect(f.processHost.start).not.toHaveBeenCalled();
  });

  it.each([
    "traversal",
    "control-character",
    "unpinned-driver",
    "unknown-field",
    "command-reset",
  ] as const)("rejects invalid trusted configuration: %s", (failure) => {
    const value = configuration();
    if (failure === "traversal") value.application.workingDirectory = "../outside";
    else if (failure === "control-character")
      value.application.workingDirectory = "bin\u0001directory";
    else if (failure === "unpinned-driver") value.windowsDriver.entry.sha256 = "not-a-digest";
    else if (failure === "unknown-field")
      Object.assign(value, { modelExecutable: "powershell.exe" });
    else value.profile.reset = { strategy: "commands", stepIds: ["unregistered-reset"] };
    expect(() => parseInvestigationUiPlanAdapterConfiguration(value)).toThrow(
      InvestigationUiPlanAdapterError,
    );
  });
});
