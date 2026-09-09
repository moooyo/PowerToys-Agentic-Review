import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  getValidationProfileConfigIssues,
  type JobExecutionEnvelopeV2,
  JobExecutionEnvelopeV2Schema,
  resolveManagedWebUiUrl,
  type UiScenarioConfiguration,
  type UiScenarioExecutionEvidenceV1,
  type ValidationCheckResult,
  type ValidationCommandStep,
  type ValidationExecutionDetails,
  type ValidationLifecycleBlocker,
  type ValidationProfileVersion,
  type ValidationReportV1,
  type ValidationStepDiagnostic,
  type WebUiScenario,
  type WindowsUiScenario,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { acquireDesktopLease, type DesktopLease } from "../ui/desktop-lease.js";
import {
  parseWebDriverRequest,
  parseWebDriverResult,
  parseWebUiObservationProbeResult,
  type WebDriverResult,
} from "../ui/web-driver.js";
import {
  parseWindowsDriverRequest,
  parseWindowsDriverResult,
  parseWindowsSessionProbeResult,
  parseWindowsTcpOwnerProbeResult,
  parseWindowsUiObservationProbeResult,
  type WindowsDriverRequest,
  type WindowsDriverResult,
  type WindowsSessionProbeResult,
} from "../ui/windows-driver.js";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import { ProductionManagedProcessRunner } from "./managed-process-runner.js";
import {
  assertValidProcessLaunchSpec,
  assertWindowsLocalAbsolutePath,
  type ManagedProcess,
  type ProcessExitedEvent,
  type ProcessHostClient,
  type ProcessLaunchSpec,
  type ProcessResourceLimits,
} from "./process-host-protocol.js";
import type { CapturedTestProbeOutput } from "./test-probe-capture.js";
import type { ValidationCommandPhase } from "./validation-check-runner.js";
import type { WorkspaceDiskMonitor } from "./workspace-disk-budget.js";

export interface UiCommandStepInput {
  readonly workspace: PreparedJobWorkspace;
  readonly processHost: ProcessHostClient;
  readonly signal: AbortSignal;
  readonly step: ValidationCommandStep;
  readonly checkId: string;
  readonly phase: ValidationCommandPhase;
  readonly timeoutMs: number;
}
export interface UiCommandStepResult {
  readonly check: ValidationCheckResult;
  readonly diagnostic: ValidationStepDiagnostic;
  readonly failureCode?: string | undefined;
  readonly category: "validation" | "infrastructure" | "lifecycle" | "source" | "unsupported";
}
export interface UiProfileCommands {
  // These operations reuse the same path, executable, environment, secret, and process-draining
  // checks as the headless runner. Command completion must include confirmed process teardown.
  runStep(input: UiCommandStepInput): Promise<UiCommandStepResult>;
  prepareLaunch(input: {
    readonly workspace: PreparedJobWorkspace;
    readonly signal: AbortSignal;
    readonly step: ValidationCommandStep;
    readonly timeoutMs: number;
    readonly environmentOverrides?: Readonly<Record<string, string>>;
  }): Promise<ProcessLaunchSpec>;
  captureSource(
    workspace: PreparedJobWorkspace,
    signal: AbortSignal,
  ): Promise<"clean" | "modified" | "unknown">;
  redactOutput(output: string): string;
  /** Rechecks all command measurements against every secret resolved during this profile. */
  getProbeCaptures?(): readonly CapturedTestProbeOutput[];
}
export interface UiDriverRuntime {
  readonly windowsPowerShellExecutable?: string;
  readonly windowsDriverEntry?: string;
  readonly nodeExecutable?: string;
  readonly webDriverEntry?: string;
  readonly browserExecutable?: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
}
export type UiLocalEvidenceFile = (
  | WindowsDriverResult["evidenceFiles"][number]
  | WebDriverResult["evidenceFiles"][number]
) & {
  readonly evidenceDirectory: string;
  readonly scenarioCheckId: string;
};
export interface UiProfileResult extends ValidationExecutionDetails {
  readonly report: ValidationReportV1;
  readonly probeCaptures?: readonly CapturedTestProbeOutput[];
  readonly evidenceFiles: readonly UiLocalEvidenceFile[];
  readonly scenarioEvidence: readonly {
    readonly scenarioCheckId: string;
    readonly evidenceDirectory: string;
    readonly execution: UiScenarioExecutionEvidenceV1;
    readonly evidenceFiles: readonly (
      | WindowsDriverResult["evidenceFiles"][number]
      | WebDriverResult["evidenceFiles"][number]
    )[];
  }[];
}
export interface UiProfileInput {
  readonly envelope: JobExecutionEnvelopeV2;
  readonly profile: ValidationProfileVersion;
  readonly workspace: PreparedJobWorkspace;
  readonly processHost: ProcessHostClient;
  readonly signal: AbortSignal;
  reportNodeHealthFault(error: Error): void;
}
export interface UiProfileProgress {
  readonly kind:
    | "process_started"
    | "process_stopped"
    | "command_completed"
    | "source_capture_started"
    | "source_capture_completed"
    | "ui_step_completed"
    | "scenario_completed";
  readonly profileVersionId: string;
  readonly phase: "setup" | "build" | "test" | "cleanup" | "launch" | "ui" | "source";
  readonly stepId: string;
  readonly scenarioId?: string;
  readonly outcome?: ValidationCheckResult["outcome"];
  readonly processCount: number;
}
export interface UiProfileRunnerOptions {
  readonly commands: UiProfileCommands;
  readonly limits: ProcessResourceLimits;
  readonly drivers: UiDriverRuntime;
  readonly cleanupTimeoutMs?: number;
  readonly desktopLockDirectory?: string;
  readonly evidenceDirectory: (input: UiProfileInput, signal: AbortSignal) => Promise<string>;
  readonly sessionProbe?: (
    input: UiProfileInput,
    signal: AbortSignal,
  ) => Promise<WindowsSessionProbeResult>;
  readonly tcpOwnerProbe?: (
    input: UiProfileInput,
    root: WindowsDriverRequest["rootProcess"],
    port: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly allocatePort?: (signal: AbortSignal) => Promise<number>;
  readonly httpReadiness?: (
    url: string,
    expectedStatus: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly acquireDesktop?: typeof acquireDesktopLease;
  readonly onProgress?: (progress: UiProfileProgress) => void;
}
interface Deadline {
  readonly signal: AbortSignal;
  remaining(): number;
  close(): void;
  abort(error: Error): void;
}
interface TrackedProcess {
  readonly managed: ManagedProcess;
  readonly settled: Promise<{ exit: ProcessExitedEvent; stdout: string; stderr: string }>;
  readonly drained: Promise<void>;
  exited: boolean;
  stopping: boolean;
  stopped: boolean;
}
class UiLifecycleError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UiLifecycleError";
  }
}

export class UiProfileRunner {
  readonly #cleanupTimeout: number;
  public constructor(private readonly options: UiProfileRunnerOptions) {
    this.#cleanupTimeout = options.cleanupTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#cleanupTimeout) ||
      this.#cleanupTimeout < 1_000 ||
      this.#cleanupTimeout > 300_000
    )
      throw new TypeError(
        "UI cleanup timeout must be an integer between 1000 and 300000 milliseconds.",
      );
    for (const [name, path] of Object.entries(options.drivers)) {
      if (typeof path === "string")
        assertWindowsLocalAbsolutePath(path, `UI driver ${name}`, name.endsWith("Executable"));
    }
  }

  public async run(input: UiProfileInput): Promise<UiProfileResult> {
    const capturesRequested = input.profile.config.test.some(
      (step) => step.probeOutput !== undefined,
    );
    const observationProtocol =
      input.envelope.validation.reproduction === undefined ? undefined : "UiAssertionCaptureV1";
    const checks = new Map<string, ValidationCheckResult>();
    const diagnostics = new Map<string, ValidationStepDiagnostic>();
    const blockers = new Map<string, ValidationLifecycleBlocker>();
    const evidenceFiles: UiLocalEvidenceFile[] = [];
    const scenarioEvidence: UiProfileResult["scenarioEvidence"][number][] = [];
    const sourceStates: ("clean" | "modified" | "unknown")[] = [];
    let cleanupState: UiProfileResult["cleanupState"] = "not_needed";
    let desktop: DesktopLease | undefined;
    let touched = false;
    let restored = true;
    let app: TrackedProcess | undefined;
    let driver: TrackedProcess | undefined;
    let monitor: WorkspaceDiskMonitor | undefined;
    let main: Deadline | undefined;
    const block = (
      code: string,
      phase: ValidationLifecycleBlocker["phase"],
      stepId: string | null,
      message: string,
    ): void => {
      blockers.set(`${phase}:${stepId}:${code}`, { code, phase, stepId, message });
    };
    const healthFault = (code: string): void => {
      restored = false;
      input.reportNodeHealthFault(
        new UiLifecycleError(code, "The owned UI environment could not be confirmed restored."),
      );
    };
    const finish = (): UiProfileResult => {
      if (!restored) cleanupState = "failed";
      const sourceState: ValidationReportV1["sourceState"] = sourceStates.includes("modified")
        ? "modified"
        : sourceStates.length > 0 && sourceStates.every((state) => state === "clean")
          ? "original"
          : "unknown";
      if (!restored || cleanupState === "failed") {
        for (const [id, check] of checks) {
          if (check.kind === "ui" && check.outcome === "passed")
            checks.set(id, {
              ...check,
              outcome: "blocked",
              summary:
                "UI assertions passed, but the environment lifecycle could not be confirmed restored.",
              actual: "UI assertions passed; lifecycle restoration is blocked.",
            });
        }
      }
      if (sourceState !== "original")
        block(
          sourceState === "modified" ? "SOURCE_STATE_MODIFIED" : "SOURCE_STATE_UNKNOWN",
          "source",
          null,
          "The complete UI lifecycle did not preserve a verified original revision.",
        );
      const report = {
        schemaVersion: "ValidationReportV1" as const,
        source: "worker" as const,
        sourceState,
        summary:
          blockers.size > 0
            ? "UI validation completed with lifecycle blockers; inspect the observed checks and evidence."
            : "Configured UI scenarios completed against the original source; review approval and issue reproduction require the complete run policy.",
        checks: [...checks.values()],
      };
      return {
        report:
          input.envelope.resource.kind === "issue"
            ? { ...report, workItemKind: "issue", reproductionConclusion: "inconclusive" }
            : { ...report, workItemKind: "pull_request" },
        blockers: [...blockers.values()],
        diagnostics: [...diagnostics.values()],
        cleanupState,
        evidenceFiles,
        scenarioEvidence,
        ...(capturesRequested
          ? { probeCaptures: structuredClone(this.options.commands.getProbeCaptures?.() ?? []) }
          : {}),
      };
    };
    registerWorkerContractFormats();
    if (
      !Value.Check(JobExecutionEnvelopeV2Schema, input.envelope) ||
      !validTestedSource(input.envelope) ||
      input.envelope.lease.jobId !== input.envelope.job.jobId ||
      input.envelope.job.kind !==
        (input.envelope.resource.kind === "pull_request"
          ? "pull_request_review"
          : "issue_triage") ||
      createCanonicalResult(input.profile).sha256 !==
        createCanonicalResult(input.envelope.validation.profileVersion).sha256 ||
      createCanonicalResult(input.profile.config).sha256 !== input.profile.configSha256 ||
      getValidationProfileConfigIssues(
        input.profile.config,
        input.profile.workflowKind,
        input.profile.target,
      ).length > 0 ||
      input.profile.config.ui === undefined ||
      input.profile.config.ui.target !== input.profile.target ||
      (observationProtocol !== undefined &&
        (input.envelope.resource.kind !== "issue" ||
          input.profile.workflowKind !== "issue_validation")) ||
      input.envelope.validation.target !== input.profile.target ||
      input.envelope.validation.workflowKind !== input.profile.workflowKind ||
      input.envelope.validation.repositoryId !== input.profile.repositoryId ||
      (input.envelope.resource.kind === "pull_request"
        ? input.profile.workflowKind !== "pr_ui"
        : input.profile.workflowKind !== "issue_validation")
    ) {
      block(
        "UI_PROFILE_INVALID",
        "profile",
        null,
        "The assigned UI profile, frozen envelope, or configuration digest is invalid.",
      );
      return finish();
    }
    const profile = structuredClone(input.profile);
    if (
      observationProtocol !== undefined &&
      ["setup", "build", "test", "launch", "cleanup"].some((phase) =>
        profile.config[phase as "setup" | "build" | "test" | "launch" | "cleanup"].some((step) =>
          step.command.environment.some((variable) => "secretRef" in variable),
        ),
      )
    ) {
      block(
        "UI_REPRODUCTION_SECRET_CAPTURE_UNSUPPORTED",
        "profile",
        null,
        "Mapped UI observation capture supports public fixtures without secret references only.",
      );
      return finish();
    }
    if (capturesRequested && this.options.commands.getProbeCaptures === undefined) {
      block(
        "UI_PROBE_CAPTURE_UNAVAILABLE",
        "profile",
        null,
        "The UI command bridge cannot collect the declared structured test measurements.",
      );
      return finish();
    }
    if (
      observationProtocol !== undefined &&
      profile.config.ui?.target === "web" &&
      profile.config.ui.evidence.trace !== "off"
    ) {
      block(
        "UI_REPRODUCTION_TRACE_CAPTURE_UNSUPPORTED",
        "profile",
        null,
        "Mapped Web observation capture requires a published profile with trace capture disabled.",
      );
      return finish();
    }
    const emit = (event: Omit<UiProfileProgress, "profileVersionId" | "processCount">): void => {
      if (input.signal.aborted) return;
      try {
        this.options.onProgress?.({
          ...event,
          profileVersionId: profile.id,
          processCount: [app, driver].filter((process) => process !== undefined && !process.exited)
            .length,
        });
      } catch {
        // An observer cannot interrupt cleanup or change execution authority.
      }
    };
    const captureSource = async (
      signal: AbortSignal,
      stage: "initial" | "prerequisites" | "after_scenario" | "before_cleanup" | "after_cleanup",
      scenarioId?: string,
    ): Promise<"clean" | "modified" | "unknown"> => {
      const identity = {
        phase: "source" as const,
        stepId: `${profile.id}:source:${stage}${scenarioId === undefined ? "" : `:${scenarioId}`}`,
        ...(scenarioId === undefined ? {} : { scenarioId }),
      };
      // Only finite lifecycle boundaries renew progress. Disk monitor ticks and a pending source
      // capture cannot keep a stalled validation alive, and cleanup cannot renew a lost lease.
      if (!signal.aborted) emit({ kind: "source_capture_started", ...identity });
      const state = await this.options.commands.captureSource(input.workspace, signal);
      if (!signal.aborted) emit({ kind: "source_capture_completed", ...identity });
      return state;
    };
    const ui = profile.config.ui;
    if (ui === undefined) throw new Error("Validated UI configuration is missing.");
    const launch = profile.config.launch[0];
    if (launch === undefined) throw new Error("Validated UI launch is missing.");
    for (const phase of ["setup", "build", "test", "cleanup"] as const) {
      for (const step of profile.config[phase])
        checks.set(`${profile.id}:${step.id}`, commandNotRun(profile.id, step, phase));
    }
    for (const scenario of ui.scenarios)
      checks.set(
        `${profile.id}:${scenario.id}`,
        scenarioCheck(profile.id, scenario, "not_run", "The UI scenario was not reached.", []),
      );
    const duration = Math.min(
      profile.config.hardTimeoutMs,
      input.envelope.executionPolicy.hardTimeoutMs,
      this.options.limits.hardTimeoutMs,
      Date.parse(input.envelope.executionDeadlineAt) - Date.now(),
    );
    main = deadline(input.signal, duration);
    const command = async (
      step: ValidationCommandStep,
      phase: ValidationCommandPhase,
      budget: Deadline,
    ): Promise<UiCommandStepResult> => {
      touched = true;
      const checkId = `${profile.id}:${step.id}`;
      const result = await this.options.commands.runStep({
        workspace: input.workspace,
        processHost: input.processHost,
        signal: budget.signal,
        step,
        checkId,
        phase,
        timeoutMs: Math.min(step.timeoutMs, budget.remaining()),
      });
      const previous = checks.get(checkId);
      // Reset commands reuse the same published check identity. A later success cannot erase an
      // earlier failure; diagnostics retain the first unsuccessful execution of that command.
      if (previous === undefined || previous.outcome === "not_run" || previous.outcome === "passed")
        checks.set(checkId, result.check);
      const earlier = diagnostics.get(checkId);
      if (earlier === undefined || earlier.outcome === "passed")
        diagnostics.set(checkId, result.diagnostic);
      if (
        result.category === "infrastructure" ||
        (phase === "setup" && step.required && result.check.outcome !== "passed")
      )
        block(result.failureCode ?? "UI_COMMAND_BLOCKED", phase, checkId, result.check.summary);
      emit({ kind: "command_completed", phase, stepId: checkId, outcome: result.check.outcome });
      return result;
    };
    try {
      main.signal.throwIfAborted();
      if (ui.target === "windows_desktop") {
        const session = await this.#session(input, main.signal);
        if (!session.available || this.options.desktopLockDirectory === undefined)
          throw new UiLifecycleError(
            "INTERACTIVE_SESSION_UNAVAILABLE",
            "A configured exclusive interactive session is required.",
          );
        desktop = await (this.options.acquireDesktop ?? acquireDesktopLease)({
          lockDirectory: this.options.desktopLockDirectory,
          sessionId: session.sessionId,
          ownerId: `${input.envelope.job.jobId}:${input.envelope.job.attempt}`,
        });
      }
      sourceStates.push(await captureSource(main.signal, "initial"));
      if (sourceStates[0] !== "clean")
        throw new UiLifecycleError(
          "SOURCE_STATE_UNVERIFIED",
          "UI execution requires the original unmodified source revision.",
        );
      monitor = await input.workspace.startDiskMonitoring(main.signal);
      const execution = deadline(monitor.signal, main.remaining());
      try {
        let prerequisite = false;
        for (const phase of ["setup", "build", "test"] as const) {
          for (const step of profile.config[phase]) {
            if (prerequisite || execution.signal.aborted) continue;
            const result = await command(step, phase, execution);
            if (
              result.category === "infrastructure" ||
              ((phase === "setup" || phase === "build") &&
                step.required &&
                result.check.outcome !== "passed")
            )
              prerequisite = true;
          }
        }
        sourceStates.push(await captureSource(execution.signal, "prerequisites"));
        if (sourceStates.some((state) => state !== "clean")) prerequisite = true;
        const evidenceDirectory = await this.options.evidenceDirectory(input, execution.signal);
        for (const [index, scenario] of ui.scenarios.entries()) {
          if (prerequisite || execution.signal.aborted || !restored) break;
          const checkId = `${profile.id}:${scenario.id}`;
          const launchId = `${profile.id}:${launch.id}`;
          let scenarioMonitor: Deadline | undefined;
          let lostApp = false;
          try {
            if (desktop !== undefined) {
              const session = await this.#session(input, execution.signal);
              if (!session.available || session.sessionId !== desktop.sessionId)
                throw new UiLifecycleError(
                  "INTERACTIVE_SESSION_CHANGED",
                  "The owned interactive session changed before launch.",
                );
            }
            if (index > 0 && ui.reset.strategy === "commands") {
              for (const resetId of ui.reset.stepIds) {
                const resetSetup = profile.config.setup.find((step) => step.id === resetId);
                const resetStep =
                  resetSetup ?? profile.config.cleanup.find((step) => step.id === resetId);
                if (resetStep === undefined)
                  throw new UiLifecycleError(
                    "RESET_INVALID",
                    "The reset command is missing from the frozen profile.",
                  );
                const resetResult = await command(
                  resetStep,
                  resetSetup === undefined ? "cleanup" : "setup",
                  execution,
                );
                if (resetResult.check.outcome !== "passed") {
                  healthFault("RESET_FAILED");
                  throw new UiLifecycleError(
                    "RESET_FAILED",
                    "A declared reset command failed; the desktop is quarantined.",
                  );
                }
              }
            }
            const port =
              ui.target === "web"
                ? await (this.options.allocatePort ?? allocateLoopbackPort)(execution.signal)
                : undefined;
            scenarioMonitor = deadline(
              execution.signal,
              Math.min(
                execution.remaining(),
                ui.launch.readiness.timeoutMs + scenario.timeoutMs + 15_000,
              ),
            );
            const launchSpec = await this.options.commands.prepareLaunch({
              workspace: input.workspace,
              signal: scenarioMonitor.signal,
              step: launch,
              timeoutMs: scenarioMonitor.remaining(),
              ...(ui.target === "web"
                ? { environmentOverrides: { [ui.service.portEnvironmentVariable]: String(port) } }
                : {}),
            });
            touched = true;
            let launched: ManagedProcess;
            try {
              launched = await startControlled(
                input.processHost,
                {
                  ...launchSpec,
                  captureProcessIdentity: true,
                  limits: {
                    ...launchSpec.limits,
                    hardTimeoutMs: Math.max(
                      10_000,
                      Math.min(
                        launchSpec.limits.hardTimeoutMs,
                        Math.ceil(scenarioMonitor.remaining()),
                      ),
                    ),
                  },
                },
                scenarioMonitor.signal,
              );
            } catch (error) {
              healthFault("UI_LAUNCH_UNCONFIRMED");
              throw error;
            }
            app = track(launched, 64 * 1_024, scenarioMonitor.signal);
            emit({
              kind: "process_started",
              phase: "launch",
              stepId: launchId,
              scenarioId: scenario.id,
            });
            const currentApp = app;
            const scenarioDeadline = scenarioMonitor;
            const lost = (): void => {
              if (!currentApp.stopping) {
                lostApp = true;
                scenarioDeadline.abort(
                  new UiLifecycleError(
                    "UI_APPLICATION_EXITED",
                    "The owned application exited before its scenario completed.",
                  ),
                );
              }
            };
            void launched.completed.then(lost, lost);
            const identity = processIdentity(launched);
            if (ui.target === "web") {
              if (port === undefined) throw new Error("Managed port is missing.");
              await this.#waitWeb(input, identity, port, ui, scenarioMonitor.signal);
            }
            if (app.exited)
              throw new UiLifecycleError(
                "UI_APPLICATION_EXITED",
                "The owned application exited before its UI scenario.",
              );
            diagnostics.set(launchId, {
              stepId: launchId,
              phase: "launch",
              outcome: "passed",
              exitCode: null,
              summary:
                "The owned persistent application started; launch is not a validation check.",
            });
            const driverSpec = this.#driverSpec(
              ui,
              scenario,
              identity,
              port,
              evidenceDirectory,
              scenarioMonitor.remaining(),
              observationProtocol,
            );
            try {
              driver = track(
                await startControlled(input.processHost, driverSpec.spec, scenarioMonitor.signal),
                512 * 1_024,
                scenarioMonitor.signal,
                true,
                uiProgressReader(scenario, (stepId, outcome) =>
                  emit({
                    kind: "ui_step_completed",
                    phase: "ui",
                    stepId: `${profile.id}:${stepId}`,
                    scenarioId: scenario.id,
                    outcome,
                  }),
                ),
              );
              emit({
                kind: "process_started",
                phase: "ui",
                stepId: checkId,
                scenarioId: scenario.id,
              });
            } catch (error) {
              healthFault("UI_DRIVER_START_UNCONFIRMED");
              throw error;
            }
            const completed = await waitSignal(driver.settled, scenarioMonitor.signal);
            emit({
              kind: "process_stopped",
              phase: "ui",
              stepId: checkId,
              scenarioId: scenario.id,
            });
            if (lostApp || app.exited)
              throw new UiLifecycleError(
                "UI_APPLICATION_EXITED",
                "The owned application exited during UI validation.",
              );
            if (
              completed.exit.exitCode !== 0 ||
              completed.exit.signal !== null ||
              completed.exit.outputTruncated
            )
              throw new UiLifecycleError(
                "UI_DRIVER_INCOMPLETE",
                "The UI driver exited without a complete bounded result.",
              );
            const result = driverSpec.parse(completed.stdout);
            if (
              ui.target === "web" &&
              port !== undefined &&
              !(await this.#tcp(input, identity, port, scenarioMonitor.signal))
            )
              throw new UiLifecycleError(
                "UI_SERVICE_OWNERSHIP_LOST",
                "The managed service lost its verified listener ownership.",
              );
            const summaryIds = result.evidenceFiles
              .filter((file) => file.kind === "ui_steps" || file.kind === "trace")
              .map((file) => file.id);
            const outcome = result.evidenceComplete ? result.outcome : "blocked";
            checks.set(
              checkId,
              scenarioCheck(profile.id, scenario, outcome, result.summary, summaryIds),
            );
            diagnostics.set(checkId, {
              stepId: checkId,
              phase: "ui",
              outcome,
              exitCode: completed.exit.exitCode,
              summary: result.summary,
            });
            for (const asset of result.evidenceFiles) {
              if (evidenceFiles.some((existing) => existing.id === asset.id))
                throw new UiLifecycleError(
                  "UI_EVIDENCE_INVALID",
                  "Driver evidence identifiers collided across scenarios.",
                );
              evidenceFiles.push({ ...asset, evidenceDirectory, scenarioCheckId: checkId });
            }
            scenarioEvidence.push({
              scenarioCheckId: checkId,
              evidenceDirectory,
              execution: result.execution,
              evidenceFiles: result.evidenceFiles,
            });
            emit({
              kind: "scenario_completed",
              phase: "ui",
              stepId: checkId,
              scenarioId: scenario.id,
              outcome,
            });
            if (!result.evidenceComplete)
              block(
                "UI_EVIDENCE_INCOMPLETE",
                "evidence",
                checkId,
                "The driver could not finalize every required evidence asset.",
              );
          } catch (error) {
            const code = errorCode(error, scenarioMonitor?.signal ?? execution.signal);
            const outcome =
              code === "UI_CANCELLED" || code === "UI_TIMEOUT" ? "inconclusive" : "blocked";
            block(
              code,
              "ui",
              checkId,
              "The UI scenario could not complete its owned execution lifecycle.",
            );
            checks.set(
              checkId,
              scenarioCheck(
                profile.id,
                scenario,
                outcome,
                "The UI scenario could not complete its owned execution lifecycle.",
                [],
              ),
            );
            diagnostics.set(checkId, {
              stepId: checkId,
              phase: "ui",
              outcome,
              exitCode: null,
              summary: "The driver or owned application did not complete safely.",
            });
            prerequisite = true;
          } finally {
            scenarioMonitor?.close();
            const stopping = deadline(undefined, Math.min(this.#cleanupTimeout, 10_000));
            try {
              await stopAll([driver, app], stopping.signal);
              if (app !== undefined) {
                emit({
                  kind: "process_stopped",
                  phase: "launch",
                  stepId: launchId,
                  scenarioId: scenario.id,
                });
                const logs = await app.settled;
                const old = diagnostics.get(launchId);
                diagnostics.set(launchId, {
                  stepId: launchId,
                  phase: "launch",
                  outcome: old?.outcome ?? "blocked",
                  exitCode: logs.exit.exitCode,
                  summary:
                    old?.summary ?? "The owned application was stopped after a launch failure.",
                  stdout: this.options.commands.redactOutput(logs.stdout).slice(0, 4_096),
                  stderr: this.options.commands.redactOutput(logs.stderr).slice(0, 4_096),
                });
              }
            } catch {
              healthFault("UI_PROCESS_TEARDOWN_FAILED");
              block(
                "UI_PROCESS_TEARDOWN_FAILED",
                "cleanup",
                null,
                "Owned processes or output streams did not confirm termination.",
              );
            } finally {
              stopping.close();
            }
            if (driver?.stopped) driver = undefined;
            if (app?.stopped) app = undefined;
          }
          sourceStates.push(await captureSource(execution.signal, "after_scenario", scenario.id));
          if (sourceStates.some((state) => state !== "clean")) prerequisite = true;
        }
      } finally {
        execution.close();
      }
    } catch (error) {
      block(
        errorCode(error, main.signal),
        "profile",
        null,
        "The UI profile could not complete its controlled execution lifecycle.",
      );
    } finally {
      main.close();
      const cleanup = deadline(undefined, this.#cleanupTimeout);
      try {
        await stopAll([driver, app], cleanup.signal);
        if (monitor !== undefined) {
          try {
            await waitSignal(monitor.close(), cleanup.signal);
          } catch {
            healthFault("UI_DISK_MONITOR_UNCONFIRMED");
            block(
              "UI_DISK_MONITOR_UNCONFIRMED",
              "cleanup",
              null,
              "Workspace monitoring could not finish safely.",
            );
          }
          if (monitor.violation !== undefined) {
            healthFault("UI_DISK_BUDGET_VIOLATION");
            block(
              "UI_DISK_BUDGET_VIOLATION",
              "cleanup",
              null,
              "Workspace monitoring observed a disk safety violation.",
            );
          }
        }
        sourceStates.push(await captureSource(cleanup.signal, "before_cleanup"));
        if (touched) {
          cleanupState = "completed";
          for (const step of profile.config.cleanup) {
            const result = await command(step, "cleanup", cleanup);
            if (result.check.outcome !== "passed") {
              cleanupState = "failed";
              healthFault("CLEANUP_FAILED");
              block(
                "CLEANUP_FAILED",
                "cleanup",
                `${profile.id}:${step.id}`,
                "A cleanup command failed; the environment remains quarantined.",
              );
            }
          }
          sourceStates.push(await captureSource(cleanup.signal, "after_cleanup"));
        }
        if (desktop !== undefined) {
          const session = await this.#session(input, cleanup.signal);
          if (!session.available || session.sessionId !== desktop.sessionId) {
            healthFault("INTERACTIVE_SESSION_CHANGED");
            block(
              "INTERACTIVE_SESSION_CHANGED",
              "cleanup",
              null,
              "The desktop session could not be confirmed restored.",
            );
          }
        }
      } catch {
        cleanupState = "failed";
        healthFault("UI_CLEANUP_UNCONFIRMED");
        block(
          "UI_CLEANUP_UNCONFIRMED",
          "cleanup",
          null,
          "The owned UI environment could not be confirmed stopped, drained, and restored.",
        );
      } finally {
        cleanup.close();
        if (desktop !== undefined) {
          try {
            if (restored) await desktop.releaseRestored();
            else await desktop.quarantine("UI_CLEANUP_UNCONFIRMED");
          } catch {
            cleanupState = "failed";
            healthFault("DESKTOP_LEASE_UNCONFIRMED");
            block(
              "DESKTOP_LEASE_UNCONFIRMED",
              "cleanup",
              null,
              "The shared desktop lease could not be safely released.",
            );
          }
        }
      }
    }
    return finish();
  }

  #session(input: UiProfileInput, signal: AbortSignal): Promise<WindowsSessionProbeResult> {
    return (
      this.options.sessionProbe?.(input, signal) ??
      runWindowsSessionProbe(this.options.drivers, this.options.limits, input.processHost, signal)
    );
  }
  async #tcp(
    input: UiProfileInput,
    root: WindowsDriverRequest["rootProcess"],
    port: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.options.tcpOwnerProbe !== undefined)
      return this.options.tcpOwnerProbe(input, root, port, signal);
    const output = await runProbe(
      this.options.drivers,
      this.options.limits,
      input.processHost,
      signal,
      { schemaVersion: "WindowsTcpOwnerProbeRequestV1", rootProcess: root, port },
    );
    return parseWindowsTcpOwnerProbeResult(output, root, port).owned;
  }
  async #waitWeb(
    input: UiProfileInput,
    root: WindowsDriverRequest["rootProcess"],
    port: number,
    ui: Extract<UiScenarioConfiguration, { target: "web" }>,
    signal: AbortSignal,
  ): Promise<void> {
    const startup = deadline(signal, ui.launch.readiness.timeoutMs);
    try {
      for (;;) {
        startup.signal.throwIfAborted();
        if (await this.#tcp(input, root, port, startup.signal)) {
          const healthy = await (this.options.httpReadiness ?? httpReadiness)(
            resolveManagedWebUiUrl(port, ui.launch.readiness.path),
            ui.launch.readiness.expectedStatus,
            startup.signal,
          );
          if (healthy && (await this.#tcp(input, root, port, startup.signal))) return;
        }
        await waitSignal(new Promise<void>((resolve) => setTimeout(resolve, 100)), startup.signal);
      }
    } finally {
      startup.close();
    }
  }
  #driverSpec(
    ui: UiScenarioConfiguration,
    scenario: WindowsUiScenario | WebUiScenario,
    root: WindowsDriverRequest["rootProcess"],
    port: number | undefined,
    evidenceDirectory: string,
    timeoutMs: number,
    observationProtocol: "UiAssertionCaptureV1" | undefined,
  ): { spec: ProcessLaunchSpec; parse(output: string): WindowsDriverResult | WebDriverResult } {
    if (ui.target === "windows_desktop") {
      const request = parseWindowsDriverRequest({
        schemaVersion: "WindowsDriverRequestV1",
        rootProcess: root,
        scenario,
        readiness: ui.launch.readiness,
        evidence: ui.evidence,
        evidenceDirectory,
        ...(observationProtocol === undefined ? {} : { observationProtocol }),
      });
      return {
        spec: driverLaunchSpec(
          this.options.drivers,
          this.options.limits,
          request,
          timeoutMs,
          "windows",
        ),
        parse: (output) => parseWindowsDriverResult(output, request),
      };
    }
    const request = parseWebDriverRequest({
      schemaVersion: "WebDriverRequestV1",
      servicePort: port,
      scenario,
      browser: ui.browser,
      evidence: ui.evidence,
      browserExecutablePath: requiredDriverPath(
        this.options.drivers.browserExecutable,
        "browserExecutable",
        true,
      ),
      evidenceDirectory,
      ...(observationProtocol === undefined ? {} : { observationProtocol }),
    });
    return {
      spec: driverLaunchSpec(this.options.drivers, this.options.limits, request, timeoutMs, "web"),
      parse: (output) => parseWebDriverResult(output, request),
    };
  }
}

function processIdentity(managed: ManagedProcess): WindowsDriverRequest["rootProcess"] {
  if (managed.processCreationTimeFileTime === undefined)
    throw new UiLifecycleError(
      "PROCESS_IDENTITY_UNAVAILABLE",
      "The managed launch did not supply an exact creation identity.",
    );
  return { pid: managed.processId, creationTimeFileTime: managed.processCreationTimeFileTime };
}
function validTestedSource(envelope: JobExecutionEnvelopeV2): boolean {
  const tested = envelope.validation.testedSourceRevision;
  if (envelope.resource.kind === "pull_request") {
    return (
      tested?.kind === "pull_request" &&
      tested.baseSha === envelope.resource.baseSha &&
      tested.headSha === envelope.resource.headSha &&
      envelope.validation.revisionKey ===
        createHash("sha256").update(`${tested.baseSha}\0${tested.headSha}`).digest("hex")
    );
  }
  const authorization = envelope.validation.testedSourceAuthorization;
  return (
    tested?.kind === "commit" &&
    authorization !== null &&
    authorization.headSha === tested.headSha &&
    authorization.activationId === envelope.validation.activationId &&
    authorization.githubRepositoryId === envelope.repository.githubRepositoryId &&
    authorization.issueRevisionKey === envelope.validation.revisionKey &&
    authorization.issueRevisionKey === envelope.resource.revisionDigest
  );
}
function commandNotRun(
  profileId: string,
  step: ValidationCommandStep,
  phase: ValidationCommandPhase,
): ValidationCheckResult {
  return {
    id: `${profileId}:${step.id}`,
    name: step.name,
    kind: phase === "build" ? "build" : phase === "test" ? "test" : "static",
    required: step.required,
    outcome: "not_run",
    summary: "The command was not reached.",
    expected: "Process exit code: 0.",
    actual: null,
    evidenceIds: [],
    source: "runner",
  };
}
function scenarioCheck(
  profileId: string,
  scenario: WindowsUiScenario | WebUiScenario,
  outcome: ValidationCheckResult["outcome"],
  summary: string,
  evidenceIds: string[],
): ValidationCheckResult {
  return {
    id: `${profileId}:${scenario.id}`,
    name: scenario.name,
    kind: "ui",
    required: scenario.required,
    outcome,
    summary,
    expected:
      "Every configured UI assertion passes with complete evidence and confirmed lifecycle restoration.",
    actual: outcome === "not_run" ? null : `UI scenario outcome: ${outcome}.`,
    evidenceIds,
    source: "runner",
  };
}
function errorCode(error: unknown, signal: AbortSignal): string {
  if (signal.aborted)
    return signal.reason instanceof UiLifecycleError ? signal.reason.code : "UI_CANCELLED";
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
  )
    return error.code;
  return "UI_LIFECYCLE_FAILED";
}
function deadline(parent: AbortSignal | undefined, milliseconds: number): Deadline {
  const controller = new AbortController();
  const end = performance.now() + Math.max(0, milliseconds);
  const abort = (): void =>
    controller.abort(parent?.reason ?? new Error("UI execution cancelled."));
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted || milliseconds <= 0) abort();
  const timer = setTimeout(
    () => controller.abort(new UiLifecycleError("UI_TIMEOUT", "UI execution deadline exceeded.")),
    Math.max(0, milliseconds),
  );
  timer.unref();
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, end - performance.now()),
    abort: (error) => controller.abort(error),
    close: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}
async function waitSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  void operation.catch(() => undefined);
  signal.throwIfAborted();
  let reject!: (error: unknown) => void;
  const aborted = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const abort = (): void => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const value = await Promise.race([operation, aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function startControlled(
  host: ProcessHostClient,
  spec: ProcessLaunchSpec,
  signal: AbortSignal,
): Promise<ManagedProcess> {
  // Cancel pending startup through ProcessHost. Once it is acknowledged, this coordinator owns
  // cancellation explicitly: terminate + exited event + drained streams form the restoration
  // proof, while an aborted ProcessHost start signal intentionally rejects its completed promise.
  const startup = new AbortController();
  const abort = (): void => startup.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await host.start(spec, startup.signal);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function track(
  managed: ManagedProcess,
  limit: number,
  signal: AbortSignal,
  requireCompleteCapture = false,
  stderrChunk?: (chunk: Buffer) => void,
): TrackedProcess {
  let remaining = limit;
  let truncated = false;
  const drain = async (stream: Readable, observer?: (chunk: Buffer) => void): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      observer?.(chunk);
      const accepted = Math.min(remaining, chunk.byteLength);
      if (accepted < chunk.byteLength) truncated = true;
      if (accepted > 0) chunks.push(Buffer.from(chunk.subarray(0, accepted)));
      remaining -= accepted;
    }
    return Buffer.concat(chunks);
  };
  let tracked: TrackedProcess;
  const physical = Promise.allSettled([
    managed.completed.then(
      (exit) => {
        tracked.exited = true;
        return exit;
      },
      (error) => {
        tracked.exited = true;
        throw error;
      },
    ),
    drain(managed.stdout),
    drain(managed.stderr, stderrChunk),
  ] as const).then(([exit, stdout, stderr]) => {
    if (exit.status === "rejected" || stdout.status === "rejected" || stderr.status === "rejected")
      throw new UiLifecycleError(
        "UI_PROCESS_OUTPUT_INCOMPLETE",
        "The owned process or its output streams did not settle successfully.",
      );
    return { exit: exit.value, stdout: stdout.value, stderr: stderr.value };
  });
  const drained = physical.then(() => undefined);
  const settled = physical.then(({ exit, stdout, stderr }) => {
    if (requireCompleteCapture && truncated)
      throw new UiLifecycleError(
        "UI_DRIVER_OUTPUT_TRUNCATED",
        "The complete driver result exceeded its capture budget.",
      );
    const decode = (bytes: Buffer): string =>
      requireCompleteCapture
        ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        : bytes.toString("utf8").toWellFormed();
    return { exit, stdout: decode(stdout), stderr: decode(stderr) };
  });
  tracked = { managed, exited: false, stopping: false, stopped: false, settled, drained };
  const abort = (): void => {
    if (tracked.exited) return;
    tracked.stopping = true;
    void managed.terminate("cancelled").catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  void settled.finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  void settled.catch(() => undefined);
  void drained.catch(() => undefined);
  return tracked;
}
function uiProgressReader(
  scenario: WindowsUiScenario | WebUiScenario,
  report: (stepId: string, outcome: ValidationCheckResult["outcome"]) => void,
): (chunk: Buffer) => void {
  let pending = "";
  let discarding = false;
  let nextStep = 0;
  const line = (text: string): void => {
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (
      typeof event !== "object" ||
      event === null ||
      Object.keys(event).length !== 4 ||
      !("type" in event) ||
      event.type !== "ui_step_completed" ||
      !("scenarioId" in event) ||
      event.scenarioId !== scenario.id ||
      !("stepId" in event) ||
      typeof event.stepId !== "string" ||
      event.stepId !== scenario.steps[nextStep]?.id ||
      !("outcome" in event) ||
      (event.outcome !== "passed" &&
        event.outcome !== "failed" &&
        event.outcome !== "blocked" &&
        event.outcome !== "inconclusive")
    )
      return;
    nextStep += 1;
    report(event.stepId, event.outcome);
  };
  return (chunk) => {
    for (const character of chunk.toString("utf8")) {
      if (character === "\n") {
        if (!discarding) line(pending);
        pending = "";
        discarding = false;
      } else if (!discarding) {
        pending += character;
        if (pending.length > 1_024) {
          pending = "";
          discarding = true;
        }
      }
    }
  };
}
async function stop(process: TrackedProcess, signal: AbortSignal): Promise<void> {
  if (process.stopped) return;
  process.stopping = true;
  if (!process.exited) await waitSignal(process.managed.terminate("cancelled"), signal);
  await waitSignal(process.drained, signal);
  process.stopped = true;
}
async function stopAll(
  processes: readonly (TrackedProcess | undefined)[],
  signal: AbortSignal,
): Promise<void> {
  // Attempt every owned tree even if one stream or termination acknowledgement fails. A broken
  // driver must never prevent the application from receiving its own termination request.
  const results = await Promise.allSettled(
    processes
      .filter((process): process is TrackedProcess => process !== undefined)
      .map((process) => stop(process, signal)),
  );
  if (results.some((result) => result.status === "rejected"))
    throw new UiLifecycleError(
      "UI_PROCESS_TEARDOWN_FAILED",
      "At least one owned process tree could not confirm termination and complete output draining.",
    );
}
function driverLaunchSpec(
  runtime: UiDriverRuntime,
  limits: ProcessResourceLimits,
  request: unknown,
  timeoutMs: number,
  target: "windows" | "web",
): ProcessLaunchSpec {
  const executable = requiredDriverPath(
    target === "windows" ? runtime.windowsPowerShellExecutable : runtime.nodeExecutable,
    target === "windows" ? "windowsPowerShellExecutable" : "nodeExecutable",
    true,
  );
  const entry = requiredDriverPath(
    target === "windows" ? runtime.windowsDriverEntry : runtime.webDriverEntry,
    target === "windows" ? "windowsDriverEntry" : "webDriverEntry",
    false,
  );
  const spec: ProcessLaunchSpec = {
    executable,
    arguments:
      target === "windows" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", entry] : [entry],
    workingDirectory: runtime.workingDirectory,
    environmentMode: "replace",
    environment: { ...runtime.environment },
    standardInput: JSON.stringify(request),
    limits: {
      ...limits,
      hardTimeoutMs: Math.max(10_000, Math.min(limits.hardTimeoutMs, Math.ceil(timeoutMs))),
    },
  };
  assertValidProcessLaunchSpec(spec);
  return spec;
}
function requiredDriverPath(value: string | undefined, name: string, executable: boolean): string {
  if (value === undefined)
    throw new UiLifecycleError("UI_DRIVER_UNAVAILABLE", "The requested UI driver is not deployed.");
  assertWindowsLocalAbsolutePath(value, `UI driver ${name}`, executable);
  return value;
}
async function runProbe(
  runtime: UiDriverRuntime,
  limits: ProcessResourceLimits,
  processHost: ProcessHostClient,
  signal: AbortSignal,
  request: unknown,
): Promise<string> {
  const result = await new ProductionManagedProcessRunner({
    maximumCapturedOutputBytes: 4_096,
  }).run(driverLaunchSpec(runtime, limits, request, 10_000, "windows"), { processHost, signal });
  return result.stdout;
}
export async function runWindowsSessionProbe(
  runtime: UiDriverRuntime,
  limits: ProcessResourceLimits,
  processHost: ProcessHostClient,
  signal: AbortSignal,
): Promise<WindowsSessionProbeResult> {
  return parseWindowsSessionProbeResult(
    await runProbe(runtime, limits, processHost, signal, {
      schemaVersion: "WindowsSessionProbeRequestV1",
    }),
  );
}
/** Reads the deployed driver's explicit protocol feature without launching an application. */
export async function runUiObservationProbe(
  runtime: UiDriverRuntime,
  limits: ProcessResourceLimits,
  processHost: ProcessHostClient,
  signal: AbortSignal,
  target: "web" | "windows_desktop",
): Promise<boolean> {
  const output = await new ProductionManagedProcessRunner({
    maximumCapturedOutputBytes: 4_096,
  }).run(
    driverLaunchSpec(
      runtime,
      limits,
      {
        schemaVersion:
          target === "web"
            ? "WebUiObservationProbeRequestV1"
            : "WindowsUiObservationProbeRequestV1",
      },
      10_000,
      target === "web" ? "web" : "windows",
    ),
    { processHost, signal },
  );
  const result =
    target === "web"
      ? parseWebUiObservationProbeResult(output.stdout)
      : parseWindowsUiObservationProbeResult(output.stdout);
  return result.features.includes("uiAssertionObservation1");
}
async function allocateLoopbackPort(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Loopback port allocation failed.");
    signal.throwIfAborted();
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}
async function httpReadiness(
  url: string,
  expectedStatus: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(url, { signal, redirect: "manual", cache: "no-store" });
    await response.body?.cancel();
    return response.status === expectedStatus;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}
