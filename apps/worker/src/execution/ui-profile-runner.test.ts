import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  type IssueReproductionBindingV1,
  type JobExecutionEnvelopeV2,
  type ValidationCommandStep,
  type ValidationProfileVersion,
  ValidationReportV1Schema,
  type WebUiConfiguration,
  type WindowsUiConfiguration,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { DesktopLease } from "../ui/desktop-lease.js";
import type { WebDriverRequest, WebDriverResult } from "../ui/web-driver.js";
import type { WindowsDriverRequest, WindowsDriverResult } from "../ui/windows-driver.js";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import { StdioProcessHostClient } from "./process-host-client.js";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessLaunchSpec,
} from "./process-host-protocol.js";
import {
  runUiObservationProbe,
  runWindowsSessionProbe,
  type UiCommandStepInput,
  type UiDriverRuntime,
  type UiProfileCommands,
  type UiProfileInput,
  type UiProfileProgress,
  UiProfileRunner,
  type UiProfileRunnerOptions,
} from "./ui-profile-runner.js";
import { createUiCommandBridge } from "./validation-check-runner.js";

// This coordinator runs on Windows. Model its native absolute-path predicate in portable
// unit fixtures; standalone Web driver tests retain the actual host predicate and path guards.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual, isAbsolute: actual.win32.isAbsolute };
});

const paths = {
  attempt: "C:\\Fixture\\attempt",
  checkout: "C:\\Fixture\\attempt\\checkout",
  control: "C:\\Fixture\\attempt\\control",
  temp: "C:\\Fixture\\attempt\\temp",
  user: "C:\\Fixture\\attempt\\user",
  codex: "C:\\Fixture\\attempt\\codex",
};
const limits = {
  hardTimeoutMs: 60_000,
  maximumMemoryBytes: 512 * 1_024 * 1_024,
  maximumProcessCount: 8,
  maximumOutputBytes: 1_024 * 1_024,
};
const drivers: UiDriverRuntime = {
  windowsPowerShellExecutable: "C:\\Windows\\powershell.exe",
  windowsDriverEntry: "C:\\Worker\\windows-driver-entry.ps1",
  nodeExecutable: "C:\\Tools\\node.exe",
  webDriverEntry: "C:\\Worker\\web-driver-entry.mjs",
  browserExecutable: "C:\\Tools\\chrome.exe",
  workingDirectory: "C:\\Worker",
  environment: { SYSTEMROOT: "C:\\Windows" },
};
function command(id: string): ValidationCommandStep {
  return {
    id,
    name: id,
    command: { executable: "fixture", args: [], workingDirectory: ".", environment: [] },
    timeoutMs: 2_000,
    required: true,
  };
}
function profile(count = 1): ValidationProfileVersion {
  const ui: WindowsUiConfiguration = {
    schemaVersion: "UiScenariosV1",
    target: "windows_desktop",
    desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
    launch: {
      stepId: "launch",
      mode: "persistent",
      readiness: { kind: "window", window: { title: "Fixture" }, timeoutMs: 1_000 },
    },
    reset: { strategy: "restart_process" },
    evidence: { screenshots: "every_assertion", screenshotScope: "owned_window", required: true },
    scenarios: Array.from({ length: count }, (_, index) => ({
      id: `scenario-${index}`,
      name: `Scenario ${index}`,
      required: true,
      timeoutMs: 2_000,
      steps: [
        {
          id: `assert-${index}`,
          name: "Check fixture",
          action: "assertText",
          locator: { by: "automationId", automationId: "ResultLabel" },
          expected: "Ready",
          match: "exact",
          timeoutMs: 1_000,
        },
      ],
    })),
  };
  const config = {
    schemaVersion: "ValidationProfileV1" as const,
    setup: [command("setup")],
    build: [command("build")],
    test: [command("test")],
    cleanup: [command("cleanup")],
    launch: [command("launch")],
    requiredCapabilities: ["ui:windows_desktop"],
    hardTimeoutMs: 30_000,
    noProgressTimeoutMs: 20_000,
    ui,
  };
  return {
    id: "profile-version",
    profileId: "profile",
    repositoryId: "repo",
    name: "UI validation",
    workflowKind: "pr_ui",
    target: "windows_desktop",
    version: 1,
    config,
    configSha256: createCanonicalResult(config).sha256,
    required: true,
    outputSchemaVersion: "ValidationReportV1",
    createdAt: "2026-09-08T00:00:00Z",
    publishedAt: "2026-09-08T00:00:00Z",
    createdBy: "operator",
  };
}
function webProfile(): ValidationProfileVersion {
  const selected = profile();
  const ui: WebUiConfiguration = {
    schemaVersion: "UiScenariosV1",
    target: "web",
    service: {
      origin: "managed_loopback",
      portEnvironmentVariable: "FIXTURE_PORT",
      navigation: "same_origin",
    },
    browser: { engine: "chromium", headless: true, viewport: { width: 800, height: 600 } },
    launch: {
      stepId: "launch",
      mode: "persistent",
      readiness: { kind: "http", path: "/", expectedStatus: 200, timeoutMs: 1_000 },
    },
    reset: { strategy: "restart_process" },
    evidence: {
      screenshots: "on_failure",
      screenshotScope: "viewport",
      trace: "on_failure",
      required: true,
    },
    scenarios: [
      {
        id: "scenario-0",
        name: "Web scenario",
        required: true,
        path: "/",
        timeoutMs: 2_000,
        steps: [
          {
            id: "assert-0",
            name: "Check Web fixture",
            action: "assertText",
            locator: { by: "testId", testId: "result" },
            expected: "Ready",
            match: "exact",
            timeoutMs: 1_000,
          },
        ],
      },
    ],
  };
  const config = { ...selected.config, requiredCapabilities: ["ui:web"], ui };
  return { ...selected, target: "web", config, configSha256: createCanonicalResult(config).sha256 };
}
function envelope(selected: ValidationProfileVersion): JobExecutionEnvelopeV2 {
  const now = new Date().toISOString();
  return {
    protocolVersion: "1.0",
    envelopeVersion: 2,
    assignedAt: now,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    executionDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    lease: {
      jobId: "job",
      runAttemptId: "attempt",
      workerNodeId: "node",
      workerInstanceId: "instance",
      leaseToken: "t".repeat(64),
      leaseGeneration: 1,
    },
    job: {
      jobId: "job",
      kind: "pull_request_review",
      priority: 100,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "run:ui:1",
    },
    repository: { githubRepositoryId: 1, fullName: "org/repo" },
    resource: {
      kind: "pull_request",
      githubNodeId: "PR_1",
      number: 1,
      title: "Fixture change",
      author: { githubUserId: 1, login: "author" },
      canonicalSnapshot: {},
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isDraft: false,
    },
    prompt: {
      name: "UI summary",
      version: "1",
      renderedPrompt: "Summarize evidence.",
      promptSha256: "a".repeat(64),
      outputSchema: {},
      outputSchemaSha256: "b".repeat(64),
    },
    executionPolicy: {
      hardTimeoutMs: 60_000,
      noProgressTimeoutMs: 30_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
    validation: {
      schemaVersion: "ValidationJobContextV1",
      runId: "run",
      planDigest: "a".repeat(64),
      activationId: "activation",
      requestId: "ui",
      jobActivation: 1,
      repositoryId: "repo",
      workItemId: "work-item",
      revisionKey: createHash("sha256")
        .update(`${"a".repeat(40)}\0${"b".repeat(40)}`)
        .digest("hex"),
      requestEpochId: "epoch",
      workflowKind: selected.workflowKind,
      target: selected.target,
      required: true,
      profileVersion: selected,
      promptVersion: {
        id: "prompt-version",
        templateId: "prompt",
        version: 1,
        contentSha256: "c".repeat(64),
      },
      requiredCheckIds: [],
      testedSourceRevision: {
        kind: "pull_request",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      testedSourceAuthorization: null,
    },
  };
}
function driverResult(request: WindowsDriverRequest): WindowsDriverResult {
  const imageId = randomUUID();
  const stepsId = randomUUID();
  const directory = `windows-${randomUUID()}`;
  const first = request.scenario.steps[0];
  if (first === undefined || first.action !== "assertText")
    throw new Error("Fixture requires a text assertion.");
  const result: WindowsDriverResult = {
    schemaVersion: "WindowsDriverResultV1",
    scenarioId: request.scenario.id,
    outcome: "passed",
    reasonCode: "completed",
    summary: "Fixture assertion passed.",
    evidenceComplete: true,
    execution: {
      schemaVersion: "UiScenarioExecutionEvidenceV1",
      source: "ui_driver",
      scenarioId: request.scenario.id,
      target: "windows_desktop",
      steps: [
        {
          stepId: first.id,
          name: first.name,
          action: "assertText",
          expected: first.expected,
          actual: first.expected,
          outcome: "passed",
          summary: "Expected text observed.",
          evidenceIds: [imageId],
          ...(request.observationProtocol === undefined
            ? {}
            : {
                capture: {
                  schemaVersion: "UiAssertionCaptureV1" as const,
                  state: "complete" as const,
                },
              }),
        },
      ],
    },
    evidenceFiles: [
      {
        id: imageId,
        relativePath: `${directory}/${imageId}.png`,
        kind: "screenshot",
        mediaType: "image/png",
        sizeBytes: 123,
        sha256: "a".repeat(64),
      },
      {
        id: stepsId,
        relativePath: `${directory}/${stepsId}.json`,
        kind: "ui_steps",
        mediaType: "application/json",
        sizeBytes: 123,
        sha256: "b".repeat(64),
      },
    ],
  };
  const steps = result.evidenceFiles.find((file) => file.kind === "ui_steps");
  if (steps === undefined) throw new Error("Missing fixture steps.");
  const bytes = Buffer.from(JSON.stringify(result.execution), "utf8");
  steps.sizeBytes = bytes.byteLength;
  steps.sha256 = createHash("sha256").update(bytes).digest("hex");
  return result;
}
function webResult(request: WebDriverRequest): WebDriverResult {
  const first = request.scenario.steps[0];
  if (first?.action !== "assertText") throw new Error("Web fixture requires a text assertion.");
  const execution: WebDriverResult["execution"] = {
    schemaVersion: "UiScenarioExecutionEvidenceV1",
    source: "ui_driver",
    target: "web",
    scenarioId: request.scenario.id,
    steps: [
      {
        stepId: first.id,
        name: first.name,
        action: "assertText",
        expected: first.expected,
        actual: first.expected,
        outcome: "passed",
        summary: "Expected Web text observed.",
        evidenceIds: [],
        ...(request.observationProtocol === undefined
          ? {}
          : {
              capture: {
                schemaVersion: "UiAssertionCaptureV1" as const,
                state: "complete" as const,
              },
            }),
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(execution));
  const id = randomUUID();
  return {
    schemaVersion: "WebDriverResultV1",
    scenarioId: request.scenario.id,
    outcome: "passed",
    reasonCode: "completed",
    summary: "Web fixture assertion passed.",
    browserVersion: "fixture-1",
    evidenceComplete: true,
    execution,
    evidenceFiles: [
      {
        id,
        relativePath: `web-${randomUUID()}/${id}.json`,
        kind: "ui_steps",
        mediaType: "application/json",
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
}

class FixtureProcess implements ManagedProcess {
  readonly requestId = randomUUID();
  readonly processId = 1234;
  processCreationTimeFileTime?: string = "133999999999999999";
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly completed: Promise<ProcessExitedEvent>;
  readonly terminate = vi.fn(async () => {
    this.finish(null, "cancelled");
  });
  #resolve!: (value: ProcessExitedEvent) => void;
  #finished = false;
  constructor(
    private readonly closed: () => void,
    private readonly drainDelay = 0,
  ) {
    this.completed = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }
  finish(code: number | null = 0, signal: string | null = null): void {
    if (this.#finished) return;
    this.#finished = true;
    this.closed();
    this.#resolve({
      protocolVersion: "1.0",
      type: "exited",
      requestId: this.requestId,
      exitCode: code,
      signal,
      outputTruncated: false,
    });
    if (this.drainDelay === 0) {
      this.stdout.end();
      this.stderr.end();
    } else
      setTimeout(() => {
        this.stdout.end();
        this.stderr.end();
      }, this.drainDelay);
  }
}
function harness(selected = profile(), overrides: Partial<UiProfileRunnerOptions> = {}) {
  const events: string[] = [];
  const applications: FixtureProcess[] = [];
  const driverProcesses: FixtureProcess[] = [];
  const controller = new AbortController();
  let active = 0;
  let maximumActive = 0;
  let delay = 0;
  let driverHook: ((process: FixtureProcess, spec: ProcessLaunchSpec) => boolean) | undefined;
  const commands: UiProfileCommands = {
    runStep: vi.fn<UiProfileCommands["runStep"]>(async (input: UiCommandStepInput) => {
      events.push(`command:${input.phase}:${input.step.id}`);
      return {
        check: {
          id: input.checkId,
          name: input.step.name,
          kind: input.phase === "build" ? "build" : input.phase === "test" ? "test" : "static",
          required: input.step.required,
          outcome: "passed",
          summary: "Command passed.",
          expected: "Process exit code: 0.",
          actual: "Process exit code: 0.",
          evidenceIds: [],
          source: "runner",
        },
        diagnostic: {
          stepId: input.checkId,
          phase: input.phase,
          outcome: "passed",
          summary: "Command passed.",
          exitCode: 0,
        },
        category: "validation",
      };
    }),
    prepareLaunch: vi.fn<UiProfileCommands["prepareLaunch"]>(async (input) => {
      events.push("prepare-launch");
      return {
        executable: "C:\\Tools\\fixture.exe",
        arguments: [],
        workingDirectory: paths.checkout,
        environmentMode: "replace",
        environment: { SYSTEMROOT: "C:\\Windows", ...input.environmentOverrides },
        limits,
      };
    }),
    captureSource: vi.fn<UiProfileCommands["captureSource"]>(async () => "clean"),
    redactOutput: (output) => output.replaceAll("fixture-secret", "[REDACTED]"),
  };
  const workspace: PreparedJobWorkspace = {
    attemptDirectory: paths.attempt,
    checkoutDirectory: paths.checkout,
    controlDirectory: paths.control,
    tempDirectory: paths.temp,
    userProfileDirectory: paths.user,
    cleanup: vi.fn(async () => undefined),
    startDiskMonitoring: vi.fn(async (signal) => ({
      signal,
      violation: undefined,
      close: vi.fn(async () => {
        events.push("monitor-closed");
      }),
    })),
  };
  const desktop: DesktopLease = {
    sessionId: 1,
    releaseRestored: vi.fn(async () => {
      events.push("released");
      expect(
        applications.every(
          (process) => process.stdout.readableEnded && process.stderr.readableEnded,
        ),
      ).toBe(true);
      expect(
        driverProcesses.every(
          (process) => process.stdout.readableEnded && process.stderr.readableEnded,
        ),
      ).toBe(true);
    }),
    quarantine: vi.fn(async () => {
      events.push("quarantined");
    }),
  };
  const host: ProcessHostClient = {
    start: vi.fn<ProcessHostClient["start"]>(async (spec, signal) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active > 2) throw new Error("ProcessHost capacity exceeded.");
      const process = new FixtureProcess(() => {
        active -= 1;
        events.push(spec.standardInput === undefined ? "app-exited" : "driver-exited");
      }, delay);
      signal.addEventListener(
        "abort",
        () => {
          void process.terminate();
        },
        { once: true },
      );
      if (spec.standardInput === undefined) {
        events.push("app-started");
        applications.push(process);
        process.stdout.write("fixture-secret application output\n");
      } else {
        events.push("driver-started");
        driverProcesses.push(process);
        if (driverHook?.(process, spec) !== true) {
          const request = JSON.parse(spec.standardInput) as WindowsDriverRequest | WebDriverRequest;
          process.stdout.write(
            JSON.stringify(
              request.schemaVersion === "WindowsDriverRequestV1"
                ? driverResult(request)
                : webResult(request),
            ),
          );
          queueMicrotask(() => process.finish());
        }
      }
      return process;
    }),
    terminateAll: vi.fn(async () => {
      for (const process of [...applications, ...driverProcesses]) await process.terminate();
    }),
    close: vi.fn(async () => undefined),
  };
  const input: UiProfileInput = {
    envelope: envelope(selected),
    profile: selected,
    workspace,
    processHost: host,
    signal: controller.signal,
    reportNodeHealthFault: vi.fn(),
  };
  const options: UiProfileRunnerOptions = {
    commands,
    limits,
    drivers,
    cleanupTimeoutMs: 1_000,
    desktopLockDirectory: "C:\\SharedDesktopLocks",
    evidenceDirectory: vi.fn(async () => "C:\\Evidence"),
    acquireDesktop: vi.fn(async () => {
      events.push("leased");
      return desktop;
    }),
    sessionProbe: vi.fn<NonNullable<UiProfileRunnerOptions["sessionProbe"]>>(async () => ({
      schemaVersion: "WindowsSessionProbeResultV1",
      available: true,
      sessionId: 1,
      reasonCode: "ready",
    })),
    ...overrides,
  };
  const runner = new UiProfileRunner(options);
  return {
    input,
    runner,
    options,
    commands,
    workspace,
    desktop,
    events,
    applications,
    driverProcesses,
    host,
    controller,
    maximumActive: () => maximumActive,
    delayDrain: (milliseconds: number) => {
      delay = milliseconds;
    },
    driverHook: (hook: typeof driverHook) => {
      driverHook = hook;
    },
  };
}

function bindIssue(input: UiProfileInput): void {
  const selected = input.profile;
  selected.workflowKind = "issue_validation";
  const frozen = input.envelope;
  const revision = "d".repeat(64);
  frozen.resource = {
    kind: "issue",
    githubNodeId: "I_1",
    number: 1,
    title: "Fixture duplicate status",
    author: { githubUserId: 1, login: "author" },
    canonicalSnapshot: {},
    revisionDigest: revision,
  };
  frozen.job.kind = "issue_triage";
  frozen.validation.workflowKind = "issue_validation";
  frozen.validation.revisionKey = revision;
  frozen.validation.testedSourceRevision = { kind: "commit", headSha: "b".repeat(40) };
  const authorizedBy = {
    issuer: "fixture",
    subject: "operator",
    authorizedAt: new Date().toISOString(),
  };
  frozen.validation.testedSourceAuthorization = {
    kind: "operator",
    activationId: frozen.validation.activationId,
    ...authorizedBy,
    githubRepositoryId: frozen.repository.githubRepositoryId,
    githubWorkItemId: 1,
    issueRevisionKey: revision,
    headSha: "b".repeat(40),
  };
  const observation = {
    kind: "ui_assertion" as const,
    scenarioId: "scenario-0",
    stepId: "assert-0",
  };
  const binding: IssueReproductionBindingV1 = {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: frozen.validation.activationId,
    repositoryId: frozen.validation.repositoryId,
    githubRepositoryId: frozen.repository.githubRepositoryId,
    workItemId: frozen.validation.workItemId,
    githubWorkItemId: 1,
    issueRevisionKey: revision,
    testedSourceCommit: "b".repeat(40),
    authorizedBy,
    claim: "Status is duplicated",
    cases: [
      {
        id: "status-case",
        context: "Public fixture",
        requestId: frozen.validation.requestId,
        profileVersionId: selected.id,
        profileConfigSha256: selected.configSha256,
        target: selected.target,
        preconditions: [],
        presentWhen: { allOf: [{ observation, equals: { type: "string", value: "Duplicate" } }] },
        absentWhen: { allOf: [{ observation, equals: { type: "string", value: "Ready" } }] },
      },
    ],
  };
  frozen.validation.reproduction = {
    binding,
    bindingDigest: createCanonicalResult(binding).sha256,
  };
}

function longLifecycleHarness(overrides: Partial<UiProfileRunnerOptions> = {}) {
  const selected = profile();
  selected.config.hardTimeoutMs = 900_000;
  selected.config.noProgressTimeoutMs = 180_000;
  selected.config.cleanup = [];
  selected.configSha256 = createCanonicalResult(selected.config).sha256;
  const test = harness(selected, {
    limits: { ...limits, hardTimeoutMs: 900_000 },
    cleanupTimeoutMs: 210_000,
    ...overrides,
  });
  test.input.envelope.executionPolicy.hardTimeoutMs = 900_000;
  test.input.envelope.executionPolicy.noProgressTimeoutMs = 180_000;
  test.input.envelope.executionDeadlineAt = new Date(Date.now() + 900_000).toISOString();
  return test;
}

describe("UI source lifecycle progress", () => {
  it("keeps a progressing lifecycle authoritative across several long source captures", async () => {
    vi.useFakeTimers();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const progress: { at: number; value: UiProfileProgress }[] = [];
      const noProgress = new Error("No source or UI lifecycle progress was observed.");
      const test = longLifecycleHarness({
        onProgress: (value) => {
          progress.push({ at: Date.now(), value });
          clearTimeout(watchdog);
          watchdog = setTimeout(() => test.controller.abort(noProgress), 180_000);
        },
      });
      let captures = 0;
      vi.mocked(test.commands.captureSource).mockImplementation(async () => {
        captures += 1;
        if (captures >= 3) await new Promise((resolve) => setTimeout(resolve, 75_000));
        return "clean";
      });
      const close = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 38_000));
      });
      vi.mocked(test.workspace.startDiskMonitoring).mockImplementation(async (signal) => ({
        signal,
        violation: undefined,
        close,
      }));
      const startedAt = Date.now();
      const pending = test.runner.run(test.input);
      await vi.advanceTimersByTimeAsync(263_000);
      const result = await pending;
      clearTimeout(watchdog);
      expect(Date.now() - startedAt).toBe(263_000);
      expect(test.controller.signal.aborted).toBe(false);
      expect(test.commands.captureSource).toHaveBeenCalledTimes(5);
      expect(test.workspace.startDiskMonitoring).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(result.blockers).toEqual([]);
      expect(result.report.sourceState).toBe("original");
      expect(result.report.checks.every((check) => check.outcome === "passed")).toBe(true);
      expect(result.cleanupState).toBe("completed");
      const source = progress.filter(({ value }) => value.phase === "source");
      expect(source.map(({ value }) => [value.kind, value.stepId])).toEqual(
        [
          "initial",
          "prerequisites",
          "after_scenario:scenario-0",
          "before_cleanup",
          "after_cleanup",
        ].flatMap((stage) => [
          ["source_capture_started", `profile-version:source:${stage}`],
          ["source_capture_completed", `profile-version:source:${stage}`],
        ]),
      );
      for (let index = 1; index < progress.length; index += 1)
        expect((progress[index]?.at ?? 0) - (progress[index - 1]?.at ?? 0)).toBeLessThan(180_000);
      expect(source.every(({ value }) => value.processCount === 0)).toBe(true);
      expect(test.desktop.releaseRestored).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(watchdog);
      vi.useRealTimers();
    }
  });

  it("times out a stalled source capture despite disk checks and continues independent cleanup", async () => {
    vi.useFakeTimers();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let diskTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const progress: UiProfileProgress[] = [];
      const noProgress = new Error("No source or UI lifecycle progress was observed.");
      const test = longLifecycleHarness({
        onProgress: (value) => {
          progress.push(value);
          clearTimeout(watchdog);
          watchdog = setTimeout(() => test.controller.abort(noProgress), 180_000);
        },
      });
      let captures = 0;
      const cleanupSignals: AbortSignal[] = [];
      vi.mocked(test.commands.captureSource).mockImplementation(async (_workspace, signal) => {
        captures += 1;
        if (captures === 3)
          return new Promise<"unknown">((resolve) => {
            signal.addEventListener("abort", () => resolve("unknown"), { once: true });
          });
        if (captures > 3) cleanupSignals.push(signal);
        return "clean";
      });
      const diskCheck = vi.fn();
      const close = vi.fn(async () => {
        clearInterval(diskTimer);
      });
      vi.mocked(test.workspace.startDiskMonitoring).mockImplementation(async (signal) => {
        diskTimer = setInterval(() => {
          diskCheck();
        }, 1_000);
        return { signal, violation: undefined, close };
      });
      const pending = test.runner.run(test.input);
      await vi.advanceTimersByTimeAsync(179_999);
      expect(test.controller.signal.aborted).toBe(false);
      expect(test.commands.captureSource).toHaveBeenCalledTimes(3);
      expect(diskCheck).toHaveBeenCalledTimes(179);
      expect(progress.at(-1)).toMatchObject({
        kind: "source_capture_started",
        stepId: "profile-version:source:after_scenario:scenario-0",
      });
      const countBeforeCancellation = progress.length;
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      clearTimeout(watchdog);
      expect(test.controller.signal.reason).toBe(noProgress);
      expect(progress).toHaveLength(countBeforeCancellation);
      expect(progress.filter((value) => value.kind === "source_capture_completed")).toHaveLength(2);
      expect(test.commands.captureSource).toHaveBeenCalledTimes(5);
      expect(cleanupSignals).toHaveLength(2);
      expect(cleanupSignals.every((signal) => !signal.aborted)).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      expect(test.applications.every((process) => process.stdout.readableEnded)).toBe(true);
      expect(test.driverProcesses.every((process) => process.stdout.readableEnded)).toBe(true);
      expect(result.report.sourceState).toBe("unknown");
      expect(result.blockers).toContainEqual(
        expect.objectContaining({ code: "SOURCE_STATE_UNKNOWN" }),
      );
      expect(result.cleanupState).toBe("completed");
      expect(test.desktop.releaseRestored).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(watchdog);
      clearInterval(diskTimer);
      vi.useRealTimers();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "reports source completion only after the operation settles successfully: %s",
    async (settlement) => {
      vi.useFakeTimers();
      try {
        const progress: UiProfileProgress[] = [];
        const test = longLifecycleHarness({ onProgress: (value) => progress.push(value) });
        let resolveCapture: ((state: "clean") => void) | undefined;
        let rejectCapture: ((error: Error) => void) | undefined;
        vi.mocked(test.commands.captureSource).mockImplementationOnce(
          async () =>
            new Promise<"clean">((resolve, reject) => {
              resolveCapture = resolve;
              rejectCapture = reject;
            }),
        );
        const pending = test.runner.run(test.input);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(progress).toEqual([
          {
            kind: "source_capture_started",
            phase: "source",
            stepId: "profile-version:source:initial",
            profileVersionId: "profile-version",
            processCount: 0,
          },
        ]);
        if (resolveCapture === undefined || rejectCapture === undefined)
          throw new Error("The initial source capture did not start.");
        if (settlement === "resolve") resolveCapture("clean");
        else rejectCapture(new Error("C:\\private-source\\must-not-forward-source-output"));
        await vi.advanceTimersByTimeAsync(0);
        await pending;
        const completed = progress.filter(
          (value) => value.kind === "source_capture_completed" && value.stepId.endsWith(":initial"),
        );
        expect(completed).toHaveLength(settlement === "resolve" ? 1 : 0);
        for (const value of progress.filter((item) => item.phase === "source")) {
          expect(Object.keys(value).sort()).toEqual(
            [
              "kind",
              "phase",
              "stepId",
              "profileVersionId",
              "processCount",
              ...(value.scenarioId === undefined ? [] : ["scenarioId"]),
            ].sort(),
          );
        }
        expect(JSON.stringify(progress)).not.toContain("private-source");
        expect(JSON.stringify(progress)).not.toContain("must-not-forward-source-output");
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("mapped UI observation coordination", () => {
  it.each(["windows_desktop", "web"] as const)(
    "opts in explicitly for mapped %s only",
    async (target) => {
      const selected = target === "web" ? webProfile() : profile();
      if (selected.config.ui?.target === "web") selected.config.ui.evidence.trace = "off";
      selected.configSha256 = createCanonicalResult(selected.config).sha256;
      const fixture = harness(selected, {
        tcpOwnerProbe: async () => true,
        httpReadiness: async () => true,
      });
      bindIssue(fixture.input);
      const result = await fixture.runner.run(fixture.input);
      expect(result.blockers).toEqual([]);
      expect(result.scenarioEvidence[0]?.execution.steps[0]).toMatchObject({
        capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
      });
      expect(fixture.host.start).toHaveBeenCalledWith(
        expect.objectContaining({
          standardInput: expect.stringContaining('"observationProtocol":"UiAssertionCaptureV1"'),
        }),
        expect.any(AbortSignal),
      );
      expect("probeCaptures" in result).toBe(false);
    },
  );

  it.each(["setup", "build", "test", "launch", "cleanup"] as const)(
    "blocks a mapped secret in %s before any source/session/process capture",
    async (phase) => {
      const selected = profile();
      const step = selected.config[phase][0];
      if (step === undefined) throw new Error("Missing fixture command.");
      step.command.environment = [
        { name: "FIXTURE_SECRET", secretRef: "fixture-secret-reference" },
      ];
      selected.configSha256 = createCanonicalResult(selected.config).sha256;
      const fixture = harness(selected);
      bindIssue(fixture.input);
      const result = await fixture.runner.run(fixture.input);
      expect(result.blockers).toContainEqual(
        expect.objectContaining({ code: "UI_REPRODUCTION_SECRET_CAPTURE_UNSUPPORTED" }),
      );
      expect(fixture.host.start).not.toHaveBeenCalled();
      expect(fixture.commands.captureSource).not.toHaveBeenCalled();
      expect(fixture.options.sessionProbe).not.toHaveBeenCalled();
      expect(result.scenarioEvidence).toEqual([]);
    },
  );

  it("blocks mapped Web tracing before creating the owned application", async () => {
    const fixture = harness(webProfile());
    bindIssue(fixture.input);
    const result = await fixture.runner.run(fixture.input);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "UI_REPRODUCTION_TRACE_CAPTURE_UNSUPPORTED" }),
    );
    expect(fixture.host.start).not.toHaveBeenCalled();
    expect(fixture.commands.captureSource).not.toHaveBeenCalled();
  });

  it("preserves the omitted protocol and result shape for legacy UI jobs", async () => {
    const fixture = harness();
    const result = await fixture.runner.run(fixture.input);
    expect(result.blockers).toEqual([]);
    expect(JSON.stringify(result.scenarioEvidence)).not.toContain('"capture"');
    const specs = vi.mocked(fixture.host.start).mock.calls.map(([spec]) => spec);
    expect(specs.every((spec) => !spec.standardInput?.includes("observationProtocol"))).toBe(true);
    expect("probeCaptures" in result).toBe(false);
  });

  it.each(["windows_desktop", "web"] as const)(
    "retains finalized command probe captures for %s",
    async (target) => {
      const selected = target === "web" ? webProfile() : profile();
      const test = selected.config.test[0];
      if (test === undefined) throw new Error("Missing fixture test.");
      test.probeOutput = {
        schemaVersion: "TestProbeOutputDeclarationV1",
        fields: [{ id: "status", description: "Fixture status", type: "string" }],
      };
      selected.configSha256 = createCanonicalResult(selected.config).sha256;
      const fixture = harness(selected, {
        tcpOwnerProbe: async () => true,
        httpReadiness: async () => true,
      });
      const capture = {
        checkId: `${selected.id}:${test.id}`,
        output: {
          schemaVersion: "ProbeObservationsV1" as const,
          observations: [{ id: "status", state: "unavailable" as const }],
        },
        outputSha256: "f".repeat(64),
      };
      fixture.commands.getProbeCaptures = vi.fn(() => {
        expect(fixture.events).toContain("command:cleanup:cleanup");
        return [capture];
      });
      const result = await fixture.runner.run(fixture.input);
      expect(result.blockers).toEqual([]);
      expect(result.probeCaptures).toEqual([capture]);
      expect(result.probeCaptures?.[0]).not.toBe(capture);
      expect(fixture.commands.getProbeCaptures).toHaveBeenCalledOnce();
    },
  );

  it("blocks declared probes when the command bridge lacks its final capture API", async () => {
    const selected = profile();
    const test = selected.config.test[0];
    if (test === undefined) throw new Error("Missing fixture test.");
    test.probeOutput = {
      schemaVersion: "TestProbeOutputDeclarationV1",
      fields: [{ id: "count", description: "Fixture count", type: "number" }],
    };
    selected.configSha256 = createCanonicalResult(selected.config).sha256;
    const fixture = harness(selected);
    const result = await fixture.runner.run(fixture.input);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "UI_PROBE_CAPTURE_UNAVAILABLE" }),
    );
    expect(fixture.host.start).not.toHaveBeenCalled();
    expect(result.probeCaptures).toEqual([]);
  });

  it.each(["windows_desktop", "web"] as const)(
    "probes the deployed %s entry without launching UI",
    async (target) => {
      const fixture = harness();
      fixture.driverHook((process, spec) => {
        const prefix = target === "web" ? "Web" : "Windows";
        expect(JSON.parse(spec.standardInput ?? "{}")).toEqual({
          schemaVersion: `${prefix}UiObservationProbeRequestV1`,
        });
        process.stdout.write(
          JSON.stringify({
            schemaVersion: `${prefix}UiObservationProbeResultV1`,
            features: ["uiAssertionObservation1"],
          }),
        );
        queueMicrotask(() => process.finish());
        return true;
      });
      await expect(
        runUiObservationProbe(drivers, limits, fixture.host, fixture.controller.signal, target),
      ).resolves.toBe(true);
      expect(fixture.applications).toEqual([]);
    },
  );
});

describe("UI profile lifecycle coordinator", () => {
  it("rejects a cleanup budget above the explicit five-minute bound", () => {
    expect(() => harness(profile(), { cleanupTimeoutMs: 300_001 })).toThrow(
      "UI cleanup timeout must be an integer between 1000 and 300000 milliseconds.",
    );
  });

  it.each([180_000, 300_000])(
    "completes the controlled UI lifecycle with an explicit %i millisecond cleanup budget",
    async (cleanupTimeoutMs) => {
      const test = harness(profile(), { cleanupTimeoutMs });
      const result = await test.runner.run(test.input);

      expect(result.report.sourceState).toBe("original");
      expect(result.cleanupState).toBe("completed");
      expect(result.blockers).toEqual([]);
      expect(test.desktop.releaseRestored).toHaveBeenCalledOnce();
      expect(test.desktop.quarantine).not.toHaveBeenCalled();
      expect(test.input.reportNodeHealthFault).not.toHaveBeenCalled();
    },
  );

  it("runs a Windows-only deployment without unused Web or browser paths", async () => {
    const test = harness(profile(), {
      drivers: {
        windowsPowerShellExecutable: "C:\\Windows\\powershell.exe",
        windowsDriverEntry: "C:\\Worker\\windows-driver-entry.ps1",
        workingDirectory: drivers.workingDirectory,
        environment: drivers.environment,
      },
    });
    const result = await test.runner.run(test.input);
    expect(result.blockers).toStrictEqual([]);
    expect(result.report.checks.every((check) => check.outcome === "passed")).toBe(true);
  });

  it("fails a missing Windows driver path while still draining the owned application", async () => {
    const test = harness(profile(), {
      drivers: {
        windowsPowerShellExecutable: "C:\\Windows\\powershell.exe",
        workingDirectory: drivers.workingDirectory,
        environment: drivers.environment,
      },
    });
    const result = await test.runner.run(test.input);
    expect(result.report.checks.find((check) => check.kind === "ui")?.outcome).not.toBe("passed");
    expect(test.driverProcesses).toHaveLength(0);
    expect(test.applications[0]?.terminate).toHaveBeenCalled();
    expect(result.cleanupState).toBe("completed");
  });

  it("does not start a session probe without an explicitly deployed PowerShell driver", async () => {
    const test = harness();
    await expect(
      runWindowsSessionProbe(
        { workingDirectory: drivers.workingDirectory, environment: drivers.environment },
        limits,
        test.host,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "UI_DRIVER_UNAVAILABLE" });
    expect(test.host.start).not.toHaveBeenCalled();
  });

  it("reports only bounded, ordered, assigned UI step progress without forwarding values", async () => {
    const onProgress = vi.fn<NonNullable<UiProfileRunnerOptions["onProgress"]>>();
    const test = harness(profile(), { onProgress });
    test.driverHook((process, spec) => {
      const request = JSON.parse(spec.standardInput ?? "") as WindowsDriverRequest;
      const step = request.scenario.steps[0];
      if (step === undefined) throw new Error("Fixture step missing.");
      const progress = {
        type: "ui_step_completed",
        scenarioId: request.scenario.id,
        stepId: step.id,
        outcome: "passed",
      };
      process.stderr.write(`${"x".repeat(2_000)}\n`);
      process.stderr.write(`${JSON.stringify({ ...progress, scenarioId: "another-scenario" })}\n`);
      process.stderr.write(
        `${JSON.stringify({ ...progress, actual: "must-never-be-forwarded" })}\n`,
      );
      const encoded = `${JSON.stringify(progress)}\n`;
      process.stderr.write(encoded.slice(0, 17));
      process.stderr.write(encoded.slice(17));
      process.stderr.write(encoded);
      process.stdout.write(JSON.stringify(driverResult(request)));
      queueMicrotask(() => process.finish());
      return true;
    });
    await test.runner.run(test.input);
    const steps = onProgress.mock.calls
      .map(([progress]) => progress)
      .filter((progress) => progress.kind === "ui_step_completed");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      profileVersionId: "profile-version",
      scenarioId: "scenario-0",
      stepId: "profile-version:assert-0",
      outcome: "passed",
      phase: "ui",
    });
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain("must-never-be-forwarded");
    expect(onProgress.mock.calls.some(([progress]) => progress.kind === "scenario_completed")).toBe(
      true,
    );
  });
  it("checks owned TCP identity before and after HTTP readiness and after Web execution", async () => {
    const owner = vi.fn<NonNullable<UiProfileRunnerOptions["tcpOwnerProbe"]>>(async () => true);
    const healthy = vi.fn<NonNullable<UiProfileRunnerOptions["httpReadiness"]>>(async () => true);
    const test = harness(webProfile(), {
      allocatePort: async () => 32123,
      tcpOwnerProbe: owner,
      httpReadiness: healthy,
    });
    const result = await test.runner.run(test.input);
    expect(result.blockers).toEqual([]);
    expect(owner).toHaveBeenCalledTimes(3);
    expect(healthy).toHaveBeenCalledOnce();
    expect(owner.mock.invocationCallOrder[0]).toBeLessThan(
      healthy.mock.invocationCallOrder[0] ?? 0,
    );
    expect(owner.mock.invocationCallOrder[1]).toBeGreaterThan(
      healthy.mock.invocationCallOrder[0] ?? 0,
    );
    expect(test.commands.prepareLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ environmentOverrides: { FIXTURE_PORT: "32123" } }),
    );
    expect(test.options.acquireDesktop).not.toHaveBeenCalled();
    expect(test.maximumActive()).toBe(2);
  });
  it("never sends HTTP to a listener whose process identity is not owned", async () => {
    const healthy = vi.fn<NonNullable<UiProfileRunnerOptions["httpReadiness"]>>(async () => true);
    const test = harness(webProfile(), {
      allocatePort: async () => 32123,
      tcpOwnerProbe: async () => false,
      httpReadiness: healthy,
    });
    const result = await test.runner.run(test.input);
    expect(healthy).not.toHaveBeenCalled();
    expect(test.driverProcesses).toHaveLength(0);
    expect(result.report.checks.find((check) => check.kind === "ui")?.outcome).not.toBe("passed");
  });
  it("rejects a passing Web driver result when final listener ownership is lost", async () => {
    const owner = vi
      .fn<NonNullable<UiProfileRunnerOptions["tcpOwnerProbe"]>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const test = harness(webProfile(), {
      allocatePort: async () => 32123,
      tcpOwnerProbe: owner,
      httpReadiness: async () => true,
    });
    const result = await test.runner.run(test.input);
    expect(result.blockers.some((blocker) => blocker.code === "UI_SERVICE_OWNERSHIP_LOST")).toBe(
      true,
    );
    expect(result.report.checks.find((check) => check.kind === "ui")?.outcome).toBe("blocked");
  });
  it("runs command phases, isolated scenarios, confirmed drains, and cleanup before releasing the desktop", async () => {
    const test = harness(profile(2));
    test.delayDrain(15);
    const result = await test.runner.run(test.input);
    expect(result.blockers).toEqual([]);
    expect(Value.Check(ValidationReportV1Schema, result.report)).toBe(true);
    expect(result.report.sourceState).toBe("original");
    expect(result.report.checks.map((check) => check.outcome)).toEqual(Array(6).fill("passed"));
    expect(test.maximumActive()).toBe(2);
    expect(test.applications).toHaveLength(2);
    expect(test.events.indexOf("leased")).toBeLessThan(test.events.indexOf("command:setup:setup"));
    expect(test.events.lastIndexOf("app-exited")).toBeLessThan(
      test.events.indexOf("command:cleanup:cleanup"),
    );
    expect(test.events.at(-1)).toBe("released");
    expect(result.evidenceFiles).toHaveLength(4);
    expect(result.scenarioEvidence).toHaveLength(2);
    expect(JSON.stringify(result.diagnostics)).not.toContain("fixture-secret");
    expect(test.workspace.cleanup).not.toHaveBeenCalled();
  });
  it("requires a real interactive session before running any command", async () => {
    const test = harness(profile(), {
      sessionProbe: async () => ({
        schemaVersion: "WindowsSessionProbeResultV1",
        available: false,
        sessionId: null,
        reasonCode: "interactive_session_unavailable",
      }),
    });
    const result = await test.runner.run(test.input);
    expect(
      result.blockers.some((blocker) => blocker.code === "INTERACTIVE_SESSION_UNAVAILABLE"),
    ).toBe(true);
    expect(test.commands.runStep).not.toHaveBeenCalled();
    expect(test.host.start).not.toHaveBeenCalled();
  });
  it("does not execute a modified or unknown initial source revision", async () => {
    const test = harness();
    vi.mocked(test.commands.captureSource).mockResolvedValue("modified");
    const result = await test.runner.run(test.input);
    expect(result.report.sourceState).toBe("modified");
    expect(test.commands.runStep).not.toHaveBeenCalled();
    expect(test.host.start).not.toHaveBeenCalled();
  });
  it("stops all processes after cancellation and cleans up using an independent signal", async () => {
    const test = harness();
    test.delayDrain(20);
    test.driverHook(() => {
      test.controller.abort(new Error("Lease lost."));
      return true;
    });
    const result = await test.runner.run(test.input);
    expect(result.report.checks.find((check) => check.kind === "ui")?.outcome).toBe("inconclusive");
    const cleanupCall = vi
      .mocked(test.commands.runStep)
      .mock.calls.find(([input]) => input.phase === "cleanup");
    expect(cleanupCall?.[0].signal.aborted).toBe(false);
    expect(result.cleanupState).toBe("completed");
    expect(test.desktop.releaseRestored).toHaveBeenCalledOnce();
  });
  it("aborts the driver when the persistent application exits, including a clean early exit", async () => {
    const test = harness();
    test.driverHook(() => {
      test.applications[0]?.finish(0);
      return true;
    });
    const result = await test.runner.run(test.input);
    expect(result.report.checks.find((check) => check.kind === "ui")?.outcome).not.toBe("passed");
    expect(test.driverProcesses[0]?.terminate).toHaveBeenCalled();
    expect(test.desktop.releaseRestored).toHaveBeenCalledOnce();
  });
  it("does not approve an otherwise passing scenario after cleanup fails", async () => {
    const test = harness();
    const original = test.commands.runStep;
    test.commands.runStep = vi.fn<UiProfileCommands["runStep"]>(async (input) => {
      const result = await original(input);
      return input.phase === "cleanup"
        ? {
            ...result,
            check: { ...result.check, outcome: "failed" },
            diagnostic: { ...result.diagnostic, outcome: "failed" },
            failureCode: "NON_ZERO_EXIT",
          }
        : result;
    });
    const result = await test.runner.run(test.input);
    expect(result.cleanupState).toBe("failed");
    expect(result.report.checks.find((check) => check.kind === "ui")?.outcome).toBe("blocked");
    expect(test.input.reportNodeHealthFault).toHaveBeenCalled();
    expect(test.desktop.quarantine).toHaveBeenCalledOnce();
    expect(test.desktop.releaseRestored).not.toHaveBeenCalled();
  });
  it("merges repeated reset command identities and preserves failure across later cleanup", async () => {
    const selected = profile(2);
    if (selected.config.ui === undefined) throw new Error("Fixture UI is missing.");
    selected.config.ui.reset = { strategy: "commands", stepIds: ["setup", "cleanup"] };
    selected.configSha256 = createCanonicalResult(selected.config).sha256;
    const test = harness(selected);
    const result = await test.runner.run(test.input);
    expect(result.blockers).toEqual([]);
    expect(new Set(result.report.checks.map((check) => check.id)).size).toBe(
      result.report.checks.length,
    );
    expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.stepId)).size).toBe(
      result.diagnostics.length,
    );
    expect(test.events.filter((event) => event === "command:setup:setup")).toHaveLength(2);
    expect(test.events.filter((event) => event === "command:cleanup:cleanup")).toHaveLength(2);
  });
  it("retains quarantine and reports health failure when process output cannot finish draining", async () => {
    const test = harness();
    test.delayDrain(1_200);
    test.driverHook((process, spec) => {
      const request = JSON.parse(spec.standardInput ?? "") as WindowsDriverRequest;
      process.stdout.write(JSON.stringify(driverResult(request)));
      process.finish();
      return true;
    });
    // Teardown of the still-running app receives a one-second independent cleanup budget.
    const result = await test.runner.run(test.input);
    expect(test.input.reportNodeHealthFault).toHaveBeenCalled();
    expect(test.desktop.releaseRestored).not.toHaveBeenCalled();
    expect(test.desktop.quarantine).toHaveBeenCalledOnce();
    expect(result.report.checks.find((check) => check.kind === "ui")?.outcome).toBe("blocked");
  }, 10_000);
  it("still terminates the application when the driver output stream fails", async () => {
    const test = harness();
    test.driverHook((process) => {
      setTimeout(() => {
        process.stdout.destroy(new Error("Broken driver stream."));
        process.finish();
      }, 0);
      return true;
    });
    const result = await test.runner.run(test.input);
    expect(test.applications[0]?.terminate).toHaveBeenCalled();
    expect(test.applications[0]?.stdout.readableEnded).toBe(true);
    expect(test.desktop.quarantine).toHaveBeenCalledOnce();
    expect(test.desktop.releaseRestored).not.toHaveBeenCalled();
    expect(result.cleanupState).toBe("failed");
  });
  it("blocks an envelope that does not contain the exact published profile", async () => {
    const test = harness();
    test.input.envelope.validation.profileVersion = {
      ...test.input.profile,
      name: "Different profile",
    };
    const result = await test.runner.run(test.input);
    expect(result.blockers.some((blocker) => blocker.code === "UI_PROFILE_INVALID")).toBe(true);
    expect(test.commands.runStep).not.toHaveBeenCalled();
    expect(test.host.start).not.toHaveBeenCalled();
  });
});

const nativeHostPath = process.env.AGENTIC_REVIEW_UI_PROCESS_HOST;
const nativeWebEntry = process.env.AGENTIC_REVIEW_UI_WEB_ENTRY;
const nativeBrowser = process.env.AGENTIC_REVIEW_UI_BROWSER;
describe.skipIf(
  process.platform !== "win32" ||
    process.env.AGENTIC_REVIEW_WINDOWS_UI_TESTS !== "1" ||
    nativeHostPath === undefined,
)("Windows UI profile native lifecycle", () => {
  it.each(
    nativeWebEntry !== undefined && nativeBrowser !== undefined
      ? (["windows_desktop", "windows_cancelled", "web"] as const)
      : (["windows_desktop", "windows_cancelled"] as const),
  )(
    "runs the actual ProcessHost, command bridge, UI driver, and cleanup for %s",
    async (target) => {
      if (nativeHostPath === undefined) throw new Error("Native fixture ProcessHost is missing.");
      const root = await mkdtemp(join(tmpdir(), "ui-profile-native-"));
      let host: StdioProcessHostClient | undefined;
      try {
        const directory = (name: string): string => join(root, name);
        await Promise.all(
          ["checkout", "control", "temp", "user", "codex", "evidence", "locks"].map((name) =>
            mkdir(directory(name)),
          ),
        );
        const workspace: PreparedJobWorkspace = {
          attemptDirectory: root,
          checkoutDirectory: directory("checkout"),
          controlDirectory: directory("control"),
          tempDirectory: directory("temp"),
          userProfileDirectory: directory("user"),
          startDiskMonitoring: async (signal) => ({
            signal,
            violation: undefined,
            close: async () => undefined,
          }),
          captureWorktreeState: async () => "clean",
          cleanup: async () => undefined,
        };
        const selected = target === "web" ? webProfile() : profile();
        const ui = selected.config.ui;
        if (ui === undefined) throw new Error("UI fixture profile is missing.");
        selected.config.hardTimeoutMs = 60_000;
        ui.launch.readiness.timeoutMs = 10_000;
        const title = `Owned coordinator fixture ${randomUUID()}`;
        if (ui.target === "windows_desktop") ui.launch.readiness.window = { title };
        ui.evidence.screenshots = "every_assertion";
        const scenario = ui.scenarios[0];
        const assertion = scenario?.steps[0];
        if (scenario === undefined || assertion?.action !== "assertText")
          throw new Error("Fixture assertion is missing.");
        scenario.timeoutMs = 10_000;
        assertion.timeoutMs = 5_000;
        assertion.expected = target === "web" ? "Ready" : "Waiting";
        for (const phase of ["setup", "build", "test", "cleanup"] as const) {
          for (const step of selected.config[phase])
            step.command = {
              executable: "powershell",
              args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
              workingDirectory: ".",
              environment: [],
            };
        }
        const launch = selected.config.launch[0];
        if (launch === undefined) throw new Error("Fixture launch is missing.");
        launch.timeoutMs = 10_000;
        launch.command = {
          executable: target === "web" ? "node" : "powershell",
          args:
            target === "web"
              ? [
                  "-e",
                  "require('node:http').createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<div data-testid=\"result\">Ready</div>');}).listen(Number(process.env.FIXTURE_PORT),'127.0.0.1');",
                ]
              : [
                  "-NoLogo",
                  "-NoProfile",
                  "-NonInteractive",
                  "-File",
                  fileURLToPath(new URL("../ui/testdata/windows-fixture.ps1", import.meta.url)),
                  "-Title",
                  title,
                  "-SkipIdentity",
                ],
          workingDirectory: ".",
          environment: [],
        };
        selected.configSha256 = createCanonicalResult(selected.config).sha256;
        const systemRoot = process.env.SYSTEMROOT ?? "C:\\Windows";
        const powershell = join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const baseEnvironment = {
          SYSTEMROOT: systemRoot,
          COMSPEC: join(systemRoot, "System32", "cmd.exe"),
          PATH: process.env.PATH ?? join(systemRoot, "System32"),
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          TEMP: workspace.tempDirectory,
          TMP: workspace.tempDirectory,
          USERPROFILE: workspace.userProfileDirectory,
        };
        host = await StdioProcessHostClient.create({
          processHostPath: nativeHostPath,
          instanceKey: createHash("sha256").update(root).digest("hex"),
          maximumConcurrentRequests: 2,
        });
        const runtime: UiDriverRuntime = {
          windowsPowerShellExecutable: powershell,
          windowsDriverEntry: fileURLToPath(
            new URL("../ui/windows-driver-entry.ps1", import.meta.url),
          ),
          nodeExecutable: process.execPath,
          webDriverEntry:
            nativeWebEntry ?? fileURLToPath(new URL("../ui/web-driver-entry.ts", import.meta.url)),
          browserExecutable: nativeBrowser ?? process.execPath,
          workingDirectory: workspace.controlDirectory,
          environment: baseEnvironment,
        };
        const nativeLimits = {
          ...limits,
          maximumProcessCount: 32,
          maximumMemoryBytes: 2 * 1_024 * 1_024 * 1_024,
        };
        const commands = createUiCommandBridge(selected, {
          limits: nativeLimits,
          baseEnvironment,
          resolveExecutable: async (name) => {
            if (name === "node") return process.execPath;
            if (name !== "powershell") throw new Error("Unsupported fixture executable.");
            return powershell;
          },
        });
        const cancellation = new AbortController();
        const onProgress = vi.fn<NonNullable<UiProfileRunnerOptions["onProgress"]>>((progress) => {
          if (
            target === "windows_cancelled" &&
            progress.kind === "process_started" &&
            progress.phase === "ui"
          )
            cancellation.abort(new Error("The native fixture lease was cancelled."));
        });
        const observedHost = host;
        const activeRequests = new Set<string>();
        const scopedHost: ProcessHostClient = {
          start: async (spec, signal) => {
            const managed = await observedHost.start(spec, signal);
            activeRequests.add(managed.requestId);
            void managed.completed.then(
              () => activeRequests.delete(managed.requestId),
              () => activeRequests.delete(managed.requestId),
            );
            return managed;
          },
          terminateAll: (reason) => observedHost.terminateAll(reason),
          close: () => observedHost.close(),
        };
        const runner = new UiProfileRunner({
          commands,
          limits: nativeLimits,
          drivers: runtime,
          desktopLockDirectory: directory("locks"),
          evidenceDirectory: async () => directory("evidence"),
          onProgress,
        });
        const input: UiProfileInput = {
          envelope: envelope(selected),
          profile: selected,
          workspace,
          processHost: scopedHost,
          signal: cancellation.signal,
          reportNodeHealthFault: vi.fn(),
        };
        const result = await runner.run(input);
        expect(activeRequests.size).toBe(0);
        expect(result.cleanupState).toBe("completed");
        expect(input.reportNodeHealthFault).not.toHaveBeenCalled();
        if (target === "windows_cancelled") {
          expect(result.report.checks.find((check) => check.kind === "ui")?.outcome).toBe(
            "inconclusive",
          );
          expect(result.blockers.some((blocker) => blocker.code === "UI_CANCELLED")).toBe(true);
        } else {
          expect(result.blockers, JSON.stringify(result.diagnostics)).toEqual([]);
          expect(result.report.checks.every((check) => check.outcome === "passed")).toBe(true);
          expect(
            onProgress.mock.calls.some(([progress]) => progress.kind === "ui_step_completed"),
          ).toBe(true);
          const snapshot = result.evidenceFiles.find((asset) => asset.kind === "screenshot");
          if (snapshot === undefined) throw new Error("Native window screenshot is missing.");
          const bytes = await readFile(join(snapshot.evidenceDirectory, snapshot.relativePath));
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(snapshot.sha256);
          expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        }
      } finally {
        await host?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
