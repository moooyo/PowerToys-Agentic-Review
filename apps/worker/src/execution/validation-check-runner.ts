import { lstat, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { createCanonicalResult, redactExecutionText } from "@agentic-review/codex";
import {
  getValidationProfileConfigIssues,
  type ValidationCheckResult,
  type ValidationCommandStep,
  type ValidationExecutionDetails,
  type ValidationLifecycleBlocker,
  type ValidationOutcome,
  type ValidationProfileVersion,
  ValidationProfileVersionSchema,
  type ValidationReportV1,
  type ValidationStepDiagnostic,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import {
  ManagedProcessRunError,
  type ManagedProcessRunner,
  ProductionManagedProcessRunner,
} from "./managed-process-runner.js";
import {
  assertValidProcessLaunchSpec,
  assertWindowsLocalAbsolutePath,
  type ProcessHostClient,
  type ProcessLaunchSpec,
  type ProcessResourceLimits,
  ProcessResourceLimitsSchema,
  processHostResourceBounds,
} from "./process-host-protocol.js";
import {
  type CapturedTestProbeOutput,
  captureTestProbeOutput,
  sanitizeTestProbeCapture,
  TestProbeCaptureError,
} from "./test-probe-capture.js";
import type { WorkspaceDiskMonitor } from "./workspace-disk-budget.js";

const baseEnvironmentNames = [
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;
const baseEnvironmentNameSet = new Set<string>(baseEnvironmentNames);
const reservedEnvironmentNameSet = new Set<string>([
  ...baseEnvironmentNames,
  "CODEX_HOME",
  "PSMODULEANALYSISCACHEPATH",
]);
const maximumCapturedOutputBytes = 1_024 * 1_024;
const maximumResolvedSecretBytes = 1_024 * 1_024;
const phases = ["setup", "build", "test", "cleanup"] as const;
export type ValidationCommandPhase = (typeof phases)[number];
type WorktreeState = "clean" | "modified" | "unknown";
export type ValidationFailureCategory =
  | "validation"
  | "infrastructure"
  | "lifecycle"
  | "source"
  | "unsupported";
type FailureCategory = ValidationFailureCategory;

export interface HeadlessValidationCheckResult extends ValidationExecutionDetails {
  readonly report: ValidationReportV1;
  readonly probeCaptures?: readonly CapturedTestProbeOutput[];
}

interface ResolvedSecrets {
  readonly values: string[];
  bytes: number;
}

export interface ValidationCheckFileSystem {
  lstat(path: string): Promise<{
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isReparsePoint?(): boolean;
    isFile?(): boolean;
  }>;
  realpath(path: string): Promise<string>;
}

export interface HeadlessValidationCheckRunnerOptions {
  readonly baseEnvironment: Readonly<Record<string, string>>;
  /** Resolves only operator-approved executables, including their installation trust checks. */
  readonly resolveExecutable: (name: string, signal: AbortSignal) => Promise<string>;
  readonly resolveSecret?: (reference: string, signal: AbortSignal) => Promise<string>;
  readonly limits: ProcessResourceLimits;
  readonly cleanupTimeoutMs?: number;
  readonly processRunner?: ManagedProcessRunner;
  readonly fileSystem?: ValidationCheckFileSystem;
  readonly onProcessProgress?: (progress: {
    readonly phase: ValidationCommandPhase;
    readonly stepId: string;
    readonly processCount: 0 | 1;
  }) => void;
}

export interface HeadlessValidationCheckInput {
  readonly profile: ValidationProfileVersion;
  readonly workspace: PreparedJobWorkspace;
  readonly workItemKind: "pull_request" | "issue";
  readonly processHost: ProcessHostClient;
  readonly signal: AbortSignal;
}

interface Deadline {
  readonly signal: AbortSignal;
  remaining(): number;
  close(): void;
}

export interface ValidationCommandStepResult {
  readonly check: ValidationCheckResult;
  readonly diagnostic: ValidationStepDiagnostic;
  readonly failureCode: string | undefined;
  readonly category: FailureCategory;
  readonly probeCapture?: CapturedTestProbeOutput;
}
type StepResult = ValidationCommandStepResult;

export interface UiCommandStepInput {
  readonly workspace: PreparedJobWorkspace;
  readonly processHost: ProcessHostClient;
  readonly signal: AbortSignal;
  readonly step: ValidationCommandStep;
  readonly checkId: string;
  readonly phase: ValidationCommandPhase;
  readonly timeoutMs: number;
}

export interface UiLaunchPreparationInput {
  readonly workspace: PreparedJobWorkspace;
  readonly signal: AbortSignal;
  readonly step: ValidationCommandStep;
  /** Remaining persistent-process lifetime, not the startup/readiness timeout. */
  readonly timeoutMs: number;
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  readonly captureProcessIdentity?: true;
}

export interface UiCommandBridge {
  runStep(input: UiCommandStepInput): Promise<ValidationCommandStepResult>;
  prepareLaunch(input: UiLaunchPreparationInput): Promise<ProcessLaunchSpec>;
  captureSource(workspace: PreparedJobWorkspace, signal: AbortSignal): Promise<WorktreeState>;
  redactOutput(output: string): string;
  /** Rechecks all successful test captures against the session's final resolved secrets. */
  getProbeCaptures(): readonly CapturedTestProbeOutput[];
}

export function createUiCommandBridge(
  profile: ValidationProfileVersion,
  options: HeadlessValidationCheckRunnerOptions,
): UiCommandBridge {
  return new HeadlessValidationCheckRunner(options).createUiCommandBridge(profile);
}

class ValidationRunnerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationRunnerError";
  }
}

/** Runs trusted headless validation commands without owning workspace disposal or lease reporting. */
export class HeadlessValidationCheckRunner {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #limits: ProcessResourceLimits;
  readonly #cleanupTimeoutMs: number;
  readonly #runner: ManagedProcessRunner;
  readonly #fileSystem: ValidationCheckFileSystem;

  public constructor(private readonly options: HeadlessValidationCheckRunnerOptions) {
    if (!Value.Check(ProcessResourceLimitsSchema, options.limits)) {
      throw new TypeError("Validation runner resource limits are invalid.");
    }
    this.#limits = Object.freeze({ ...options.limits });
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#cleanupTimeoutMs) ||
      this.#cleanupTimeoutMs < 1_000 ||
      this.#cleanupTimeoutMs > 300_000
    ) {
      throw new RangeError(
        "Validation cleanup timeout must be an integer between 1000 and 300000 milliseconds.",
      );
    }
    this.#environment = copyBaseEnvironment(options.baseEnvironment);
    this.#runner =
      options.processRunner ??
      new ProductionManagedProcessRunner({
        maximumCapturedOutputBytes: Math.min(
          this.#limits.maximumOutputBytes,
          maximumCapturedOutputBytes,
        ),
      });
    this.#fileSystem = options.fileSystem ?? { lstat, realpath };
  }

  public createUiCommandBridge(inputProfile: ValidationProfileVersion): UiCommandBridge {
    const profile = validatePublishedProfile(inputProfile);
    const ui = profile.config.ui;
    if (
      ui === undefined ||
      profile.target === "headless" ||
      (profile.workflowKind !== "pr_ui" && profile.workflowKind !== "issue_validation")
    ) {
      throw new ValidationRunnerError(
        "UI_PROFILE_REQUIRED",
        "The command bridge requires a published UI profile with typed scenarios.",
      );
    }
    this.#assertProfileLimits(profile);
    const secrets: ResolvedSecrets = { values: [], bytes: 0 };
    const probeCaptures = new Map<string, CapturedTestProbeOutput>();
    let boundWorkspace: PreparedJobWorkspace | undefined;
    const bindWorkspace = (workspace: PreparedJobWorkspace): void => {
      if (boundWorkspace !== undefined && boundWorkspace !== workspace) {
        throw new ValidationRunnerError(
          "WORKSPACE_SCOPE_MISMATCH",
          "A UI command bridge cannot cross attempt workspaces.",
        );
      }
      boundWorkspace = workspace;
    };
    const member = (
      phase: ValidationCommandPhase | "launch",
      step: ValidationCommandStep,
    ): ValidationCommandStep => {
      if (![...phases, "launch"].includes(phase)) {
        throw new ValidationRunnerError(
          "STEP_NOT_IN_PROFILE",
          "The requested command phase is not supported.",
        );
      }
      const frozen = profile.config[phase].find((candidate) => candidate.id === step.id);
      if (
        frozen === undefined ||
        createCanonicalResult(frozen).json !== createCanonicalResult(step).json
      ) {
        throw new ValidationRunnerError(
          "STEP_NOT_IN_PROFILE",
          "The command does not match its phase and frozen published profile bytes.",
        );
      }
      return frozen;
    };
    const assertBudget = (timeoutMs: number, cleanup = false): void => {
      // Reset policies can reference cleanup commands inside the main profile lifetime. The UI
      // coordinator owns the separate final-cleanup deadline; every call still honors its signal.
      const limit = cleanup
        ? Math.max(this.#cleanupTimeoutMs, profile.config.hardTimeoutMs)
        : profile.config.hardTimeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > limit) {
        throw new ValidationRunnerError(
          "PROFILE_LIMIT_UNSUPPORTED",
          "The requested command budget exceeds this validation session's limit.",
        );
      }
    };
    return Object.freeze({
      runStep: async (input: UiCommandStepInput) => {
        if (!phases.includes(input.phase))
          throw new ValidationRunnerError(
            "STEP_NOT_IN_PROFILE",
            "Persistent launches cannot run as bounded validation checks.",
          );
        const step = member(input.phase, input.step);
        if (input.checkId !== `${profile.id}:${step.id}`) {
          throw new ValidationRunnerError(
            "STEP_NOT_IN_PROFILE",
            "The check identity does not match its published profile version.",
          );
        }
        bindWorkspace(input.workspace);
        assertBudget(input.timeoutMs, input.phase === "cleanup");
        const deadline = createDeadline(input.signal, input.timeoutMs);
        try {
          // A later execution cannot retain a successful capture from an earlier command call.
          probeCaptures.delete(input.checkId);
          const result = await this.#runStep(
            input,
            step,
            input.checkId,
            input.phase,
            deadline,
            secrets,
          );
          if (result.probeCapture !== undefined)
            probeCaptures.set(input.checkId, structuredClone(result.probeCapture));
          return result;
        } finally {
          deadline.close();
        }
      },
      prepareLaunch: async (input: UiLaunchPreparationInput) => {
        const step = member("launch", input.step);
        if (step.id !== ui.launch.stepId)
          throw new ValidationRunnerError(
            "STEP_NOT_IN_PROFILE",
            "The launch does not match the UI scenario lifecycle.",
          );
        bindWorkspace(input.workspace);
        assertBudget(input.timeoutMs);
        const lifetime = createDeadline(input.signal, input.timeoutMs);
        const preparation = createDeadline(
          lifetime.signal,
          Math.min(step.timeoutMs, lifetime.remaining()),
        );
        try {
          let spec = await this.#prepareSpec(
            input.workspace,
            step,
            preparation.signal,
            secrets,
            () => lifetime.remaining(),
          );
          if (input.environmentOverrides !== undefined) {
            const entries = Object.entries(input.environmentOverrides);
            if (ui.target !== "web" || entries.length !== 1)
              throw new ValidationRunnerError(
                "ENVIRONMENT_INVALID",
                "Only the configured managed Web port can be injected.",
              );
            const [name, value] = entries[0] ?? ["", ""];
            const folded = name.toUpperCase();
            if (
              folded !== ui.service.portEnvironmentVariable.toUpperCase() ||
              reservedEnvironmentNameSet.has(folded) ||
              folded.startsWith("WORKER_") ||
              Object.keys(spec.environment).some((existing) => existing.toUpperCase() === folded) ||
              typeof value !== "string" ||
              !/^[1-9][0-9]{0,4}(?![\s\S])/u.test(value) ||
              Number(value) > 65_535
            ) {
              throw new ValidationRunnerError(
                "ENVIRONMENT_INVALID",
                "The managed Web port cannot replace profile or reserved environment variables.",
              );
            }
            spec = { ...spec, environment: { ...spec.environment, [folded]: value } };
          }
          if (input.captureProcessIdentity === true)
            spec = { ...spec, captureProcessIdentity: true };
          preparation.signal.throwIfAborted();
          assertValidProcessLaunchSpec(spec);
          return spec;
        } finally {
          preparation.close();
          lifetime.close();
        }
      },
      captureSource: async (workspace: PreparedJobWorkspace, signal: AbortSignal) => {
        bindWorkspace(workspace);
        return this.#captureSource(workspace, signal);
      },
      redactOutput: (output: string) => redactOutput(output, secrets.values),
      getProbeCaptures: () =>
        [...probeCaptures.values()].map((capture) =>
          sanitizeTestProbeCapture(capture, secrets.values),
        ),
    });
  }

  public async run(input: HeadlessValidationCheckInput): Promise<HeadlessValidationCheckResult> {
    if (input.workItemKind !== "issue" && input.workItemKind !== "pull_request") {
      throw new TypeError("Validation requires a supported work item kind.");
    }
    const checks: ValidationCheckResult[] = [];
    const blockers: ValidationLifecycleBlocker[] = [];
    const diagnostics: ValidationStepDiagnostic[] = [];
    const sourceStates: WorktreeState[] = [];
    const secrets: ResolvedSecrets = { values: [], bytes: 0 };
    const probeCaptures: CapturedTestProbeOutput[] = [];
    const hasProbeDeclarations =
      Array.isArray(input.profile.config?.test) &&
      input.profile.config.test.some((step) => step?.probeOutput !== undefined);
    let cleanupState: HeadlessValidationCheckResult["cleanupState"] = "not_needed";
    const finish = (): HeadlessValidationCheckResult => {
      const sourceState: ValidationReportV1["sourceState"] = sourceStates.includes("modified")
        ? "modified"
        : sourceStates.length > 0 && sourceStates.every((state) => state === "clean")
          ? "original"
          : "unknown";
      if (sourceState !== "original" && !blockers.some((blocker) => blocker.phase === "source")) {
        blockers.push({
          code: sourceState === "modified" ? "SOURCE_STATE_MODIFIED" : "SOURCE_STATE_UNKNOWN",
          phase: "source",
          stepId: null,
          message:
            sourceState === "modified"
              ? "Validation observed changes to the original revision."
              : "The original revision could not be verified for the complete validation lifecycle.",
        });
      }
      const report = {
        schemaVersion: "ValidationReportV1" as const,
        source: "worker" as const,
        sourceState,
        summary:
          blockers.length > 0
            ? "Validation completed with blockers; inspect the observed checks and lifecycle diagnostics."
            : "Configured headless commands completed. Their exit status does not establish review approval or issue reproduction.",
        checks,
      };
      return {
        report:
          input.workItemKind === "issue"
            ? { ...report, workItemKind: "issue", reproductionConclusion: "inconclusive" }
            : { ...report, workItemKind: "pull_request" },
        blockers,
        diagnostics,
        cleanupState,
        ...(hasProbeDeclarations
          ? {
              probeCaptures: probeCaptures.map((capture) =>
                sanitizeTestProbeCapture(capture, secrets.values),
              ),
            }
          : {}),
      };
    };
    const blockProfile = (code: string, message: string): HeadlessValidationCheckResult => {
      blockers.push({ code, message, phase: "profile", stepId: null });
      return finish();
    };

    // UI execution belongs to a separately supervised driver, including issue validation with UI targets.
    if (input.profile.workflowKind === "pr_ui" || input.profile.target !== "headless") {
      return blockProfile(
        "UI_DRIVER_REQUIRED",
        "This profile requires a UI driver and was not executed by the headless runner.",
      );
    }
    let profile: ValidationProfileVersion;
    try {
      profile = validatePublishedProfile(input.profile);
    } catch {
      return blockProfile(
        "PROFILE_INVALID",
        "The published validation profile or its configuration digest is invalid.",
      );
    }
    if ((profile.workflowKind === "pr_static_build") !== (input.workItemKind === "pull_request")) {
      return blockProfile(
        "WORKFLOW_MISMATCH",
        "The validation workflow does not match the selected work item.",
      );
    }
    if (profile.config.launch.length > 0) {
      return blockProfile(
        "UNSUPPORTED_LAUNCH_STAGE",
        "Launch steps require a dedicated lifecycle driver and were not executed.",
      );
    }
    try {
      this.#assertProfileLimits(profile);
    } catch {
      return blockProfile(
        "PROFILE_LIMIT_UNSUPPORTED",
        "The requested profile or step timeout exceeds this runner's supported limit.",
      );
    }

    const mainDeadline = createDeadline(input.signal, profile.config.hardTimeoutMs);
    let prerequisite: string | undefined;
    try {
      sourceStates.push(await this.#captureSource(input.workspace, mainDeadline.signal));
      for (const phase of ["setup", "build", "test"] as const) {
        for (const step of profile.config[phase]) {
          const checkId = `${profile.id}:${step.id}`;
          if (prerequisite !== undefined || mainDeadline.signal.aborted) {
            const reason =
              prerequisite === undefined
                ? "The validation execution budget ended or the run was cancelled."
                : `The required prerequisite ${prerequisite} did not pass.`;
            checks.push(checkResult(step, checkId, phase, "not_run", reason, null));
            diagnostics.push({
              stepId: checkId,
              phase,
              outcome: "not_run",
              exitCode: null,
              summary: reason,
              stdout: "",
              stderr: "",
            });
            if (step.required)
              blockers.push({
                code: "REQUIRED_STEP_NOT_RUN",
                phase,
                stepId: checkId,
                message: reason,
              });
            continue;
          }
          const result = await this.#runStep(input, step, checkId, phase, mainDeadline, secrets);
          checks.push(result.check);
          diagnostics.push(result.diagnostic);
          if (result.probeCapture !== undefined) probeCaptures.push(result.probeCapture);
          if (
            result.check.outcome !== "passed" &&
            ((phase === "setup" && step.required) || result.category === "infrastructure")
          ) {
            blockers.push({
              code: result.failureCode ?? "REQUIRED_STEP_FAILED",
              phase,
              stepId: checkId,
              message: result.check.summary,
            });
          }
          if (
            step.required &&
            result.check.outcome !== "passed" &&
            (phase === "setup" || phase === "build")
          ) {
            prerequisite = checkId;
          }
        }
      }
    } finally {
      mainDeadline.close();
    }

    // Cleanup has a separate bounded lifetime and never inherits an expired lease's AbortSignal.
    const cleanupDeadline = createDeadline(undefined, this.#cleanupTimeoutMs);
    try {
      sourceStates.push(await this.#captureSource(input.workspace, cleanupDeadline.signal));
      if (profile.config.cleanup.length > 0) cleanupState = "completed";
      for (const step of profile.config.cleanup) {
        const checkId = `${profile.id}:${step.id}`;
        const result = cleanupDeadline.signal.aborted
          ? skippedCleanup(step, checkId)
          : await this.#runStep(input, step, checkId, "cleanup", cleanupDeadline, secrets);
        checks.push(result.check);
        diagnostics.push(result.diagnostic);
        if (result.check.outcome !== "passed") {
          cleanupState = "failed";
          blockers.push({
            code: "CLEANUP_FAILED",
            phase: "cleanup",
            stepId: checkId,
            message:
              "A cleanup command did not complete successfully; the environment must not be treated as restored.",
          });
        }
      }
      // No command can change the source between these observations when cleanup is empty.
      // Reuse the final observation instead of spending the cleanup budget on an identical scan.
      if (profile.config.cleanup.length > 0)
        sourceStates.push(await this.#captureSource(input.workspace, cleanupDeadline.signal));
    } finally {
      cleanupDeadline.close();
    }
    return finish();
  }

  async #runStep(
    input: Pick<HeadlessValidationCheckInput, "workspace" | "processHost">,
    step: ValidationCommandStep,
    checkId: string,
    phase: ValidationCommandPhase,
    parentDeadline: Deadline,
    secrets: ResolvedSecrets,
  ): Promise<StepResult> {
    const deadline = createDeadline(
      parentDeadline.signal,
      Math.min(step.timeoutMs, parentDeadline.remaining()),
    );
    let monitor: WorkspaceDiskMonitor | undefined;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let error: unknown;
    let probeCapture: CapturedTestProbeOutput | undefined;
    let processReported = false;
    try {
      const spec = await this.#prepareSpec(input.workspace, step, deadline.signal, secrets, () =>
        deadline.remaining(),
      );
      monitor = await observeSignal(
        input.workspace.startDiskMonitoring(deadline.signal),
        deadline.signal,
      );
      deadline.signal.throwIfAborted();
      const runSpec = { ...spec, limits: this.#processLimits(deadline.remaining()) };
      processReported = true;
      this.#reportProgress(phase, checkId, 1);
      const result = await this.#runner.run(runSpec, {
        processHost: input.processHost,
        signal: monitor.signal,
        onProgress: () => this.#reportProgress(phase, checkId, 1),
      });
      // ManagedProcessRunner settles only after the supervised process and output streams settle.
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      if (result.exitCode !== 0) {
        throw new ManagedProcessRunError(
          "NON_ZERO_EXIT",
          "Validation returned a nonzero exit code.",
          result,
        );
      }
      deadline.signal.throwIfAborted();
    } catch (failure) {
      error = failure;
      if (failure instanceof ManagedProcessRunError) {
        stdout = failure.stdout;
        stderr = failure.stderr;
        exitCode = failure.exitCode;
      }
    } finally {
      if (processReported) {
        try {
          this.#reportProgress(phase, checkId, 0);
        } catch (failure) {
          error ??= failure;
        }
      }
      if (monitor !== undefined) {
        try {
          await observeSignal(monitor.close(), deadline.signal);
          if (monitor.violation !== undefined) error = monitor.violation;
        } catch (failure) {
          error ??= failure;
        }
      }
      deadline.close();
    }
    // Only successful, fully settled execution may become a measurement. In particular, monitor
    // close and progress failures in finally cannot leave behind an earlier successful capture.
    if (error === undefined && !deadline.signal.aborted && step.probeOutput !== undefined) {
      try {
        if (phase !== "test") throw new TestProbeCaptureError();
        probeCapture = captureTestProbeOutput(checkId, stdout, step.probeOutput, secrets.values);
      } catch {
        error = new ValidationRunnerError(
          "TEST_PROBE_OUTPUT_INVALID",
          "The test probe did not provide a complete valid observation document.",
        );
      }
    }
    const classification = classifyFailure(error, deadline.signal);
    // Protocol stdout is never a diagnostic channel, including malformed or secret-bearing JSON.
    const cleanStdout =
      step.probeOutput !== undefined || stdout === "" ? "" : redactOutput(stdout, secrets.values);
    const cleanStderr = stderr === "" ? "" : redactOutput(stderr, secrets.values);
    const actual = exitCode === null ? null : `Process exit code: ${exitCode}.`;
    return {
      check: checkResult(
        step,
        checkId,
        phase,
        classification.outcome,
        classification.summary,
        actual,
      ),
      diagnostic: {
        stepId: checkId,
        phase,
        outcome: classification.outcome,
        exitCode,
        summary: classification.summary,
        stdout: cleanStdout,
        stderr: cleanStderr,
      },
      failureCode: classification.code,
      category: classification.category,
      ...(probeCapture === undefined ? {} : { probeCapture }),
    };
  }

  #assertProfileLimits(profile: ValidationProfileVersion): void {
    if (
      profile.config.hardTimeoutMs > this.#limits.hardTimeoutMs ||
      [...phases, "launch" as const].some((phase) =>
        profile.config[phase].some(
          (step) => step.timeoutMs > processHostResourceBounds.hardTimeoutMs.maximum,
        ),
      )
    ) {
      throw new ValidationRunnerError(
        "PROFILE_LIMIT_UNSUPPORTED",
        "The requested profile or step timeout exceeds this runner's supported limit.",
      );
    }
  }

  #processLimits(remainingMilliseconds: number): ProcessResourceLimits {
    if (remainingMilliseconds <= 0)
      throw new ValidationRunnerError(
        "STEP_TIMEOUT",
        "The validation deadline expired before process launch.",
      );
    return {
      ...this.#limits,
      maximumOutputBytes: Math.min(this.#limits.maximumOutputBytes, maximumCapturedOutputBytes),
      hardTimeoutMs: Math.max(
        processHostResourceBounds.hardTimeoutMs.minimum,
        Math.ceil(remainingMilliseconds),
      ),
    };
  }

  #reportProgress(phase: ValidationCommandPhase, stepId: string, processCount: 0 | 1): void {
    try {
      this.options.onProcessProgress?.({ phase, stepId, processCount });
    } catch (cause) {
      throw new ManagedProcessRunError(
        "PROGRESS_OBSERVER_FAILED",
        "Validation process progress observation failed.",
        { cause },
      );
    }
  }

  async #prepareSpec(
    workspace: PreparedJobWorkspace,
    step: ValidationCommandStep,
    signal: AbortSignal,
    secrets: ResolvedSecrets,
    remaining: () => number,
  ): Promise<ProcessLaunchSpec> {
    const workingDirectory = await this.#workingDirectory(
      workspace.checkoutDirectory,
      step.command.workingDirectory,
      signal,
    );
    const environment = await this.#stepEnvironment(workspace, step, signal, secrets);
    const executable = await observeSignal(
      this.options.resolveExecutable(step.command.executable, signal),
      signal,
    );
    try {
      assertWindowsLocalAbsolutePath(executable, "validation executable", true);
      if (!win32.isAbsolute(step.command.executable) && /[\\/]/u.test(step.command.executable)) {
        const expected = win32.resolve(workspace.checkoutDirectory, step.command.executable);
        if (win32.normalize(executable).toLowerCase() !== expected.toLowerCase())
          throw new Error("Executable resolution changed the configured relative path.");
        await this.#workingDirectory(
          workspace.checkoutDirectory,
          win32
            .relative(workspace.checkoutDirectory, win32.dirname(executable))
            .replaceAll("\\", "/"),
          signal,
        );
        const state = await observeSignal(this.#fileSystem.lstat(executable), signal);
        if (state.isFile?.() !== true || state.isSymbolicLink() || state.isReparsePoint?.())
          throw new Error("Unsafe generated executable.");
        const canonical = await observeSignal(this.#fileSystem.realpath(executable), signal);
        if (win32.normalize(canonical).toLowerCase() !== win32.normalize(executable).toLowerCase())
          throw new Error("Redirected generated executable.");
      }
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new ValidationRunnerError(
        "EXECUTABLE_UNAVAILABLE",
        "The configured executable could not be resolved safely.",
      );
    }
    signal.throwIfAborted();
    const spec: ProcessLaunchSpec = {
      executable,
      arguments: [...step.command.args],
      workingDirectory,
      environmentMode: "replace",
      environment,
      limits: this.#processLimits(remaining()),
    };
    assertValidProcessLaunchSpec(spec);
    return spec;
  }

  async #captureSource(
    workspace: PreparedJobWorkspace,
    signal: AbortSignal,
  ): Promise<WorktreeState> {
    try {
      await this.#workingDirectory(workspace.checkoutDirectory, ".", signal);
      const state = await observeSignal(
        workspace.captureWorktreeState?.(signal) ?? Promise.resolve("unknown"),
        signal,
      );
      return state === "clean" || state === "modified" ? state : "unknown";
    } catch {
      return "unknown";
    }
  }

  async #workingDirectory(root: string, relative: string, signal: AbortSignal): Promise<string> {
    try {
      assertWindowsLocalAbsolutePath(root, "validation checkout", false);
      if (
        win32.isAbsolute(relative) ||
        relative.includes(":") ||
        relative.includes("\\") ||
        relative.split("/").includes("..")
      ) {
        throw new Error("Invalid relative directory.");
      }
      const normalizedRoot = win32.normalize(root);
      const target = win32.resolve(normalizedRoot, relative);
      const suffix = win32.relative(normalizedRoot, target);
      if (suffix === ".." || suffix.startsWith("..\\") || win32.isAbsolute(suffix))
        throw new Error("Directory escapes checkout.");
      let current = normalizedRoot;
      await this.#assertDirectory(current, signal);
      for (const part of suffix === "" ? [] : suffix.split("\\")) {
        current = win32.join(current, part);
        assertWindowsLocalAbsolutePath(current, "validation directory", false);
        await this.#assertDirectory(current, signal);
      }
      return target;
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new ValidationRunnerError(
        "WORKSPACE_PATH_UNSAFE",
        "The command working directory is missing, redirected, or outside the current checkout.",
      );
    }
  }

  async #assertDirectory(path: string, signal: AbortSignal): Promise<void> {
    const state = await observeSignal(this.#fileSystem.lstat(path), signal);
    if (!state.isDirectory() || state.isSymbolicLink() || state.isReparsePoint?.())
      throw new Error("Unsafe directory.");
    const resolved = await observeSignal(this.#fileSystem.realpath(path), signal);
    if (win32.normalize(resolved).toLowerCase() !== win32.normalize(path).toLowerCase())
      throw new Error("Redirected directory.");
  }

  async #stepEnvironment(
    workspace: PreparedJobWorkspace,
    step: ValidationCommandStep,
    signal: AbortSignal,
    secrets: ResolvedSecrets,
  ): Promise<Record<string, string>> {
    const environment: Record<string, string> = {
      ...this.#environment,
      TEMP: workspace.tempDirectory,
      TMP: workspace.tempDirectory,
      USERPROFILE: workspace.userProfileDirectory,
      PSMODULEANALYSISCACHEPATH: win32.join(
        workspace.tempDirectory,
        "PowerShell-ModuleAnalysisCache",
      ),
    };
    for (const path of [workspace.tempDirectory, workspace.userProfileDirectory]) {
      assertWindowsLocalAbsolutePath(path, "validation task environment", false);
      const suffix = win32.relative(workspace.attemptDirectory, path);
      if (
        suffix === "" ||
        suffix === ".." ||
        suffix.startsWith("..\\") ||
        win32.isAbsolute(suffix)
      ) {
        throw new ValidationRunnerError(
          "WORKSPACE_PATH_UNSAFE",
          "Task environment directories must remain inside the current attempt.",
        );
      }
      await this.#assertDirectory(path, signal);
    }
    for (const variable of step.command.environment) {
      const name = variable.name.toUpperCase();
      if (reservedEnvironmentNameSet.has(name) || name.startsWith("WORKER_")) {
        throw new ValidationRunnerError(
          "ENVIRONMENT_INVALID",
          "The profile cannot replace a reserved execution environment variable.",
        );
      }
      let value: string;
      if ("secretRef" in variable) {
        if (this.options.resolveSecret === undefined)
          throw new ValidationRunnerError(
            "SECRET_UNAVAILABLE",
            "The profile requires a secret resolver.",
          );
        try {
          value = await observeSignal(
            this.options.resolveSecret(variable.secretRef, signal),
            signal,
          );
        } catch {
          if (signal.aborted) throw signal.reason;
          throw new ValidationRunnerError(
            "SECRET_UNAVAILABLE",
            "A required validation secret could not be resolved.",
          );
        }
      } else {
        value = variable.value;
      }
      if (
        typeof value !== "string" ||
        value.includes("\0") ||
        !value.isWellFormed() ||
        value.length > 32_767 ||
        ("secretRef" in variable && value.length === 0)
      ) {
        throw new ValidationRunnerError(
          "ENVIRONMENT_INVALID",
          "The validation environment contains an unsupported value.",
        );
      }
      if ("secretRef" in variable && !secrets.values.includes(value)) {
        const byteLength = Buffer.byteLength(value, "utf8");
        if (secrets.bytes + byteLength > maximumResolvedSecretBytes) {
          throw new ValidationRunnerError(
            "SECRET_UNAVAILABLE",
            "Resolved validation secrets exceed the bounded execution credential budget.",
          );
        }
        secrets.values.push(value);
        secrets.bytes += byteLength;
      }
      environment[name] = value;
    }
    return environment;
  }
}

function redactOutput(output: string, secrets: readonly string[]): string {
  let safe = output;
  // The managed runner can truncate an error preview before returning it. Remove a trailing
  // prefix of a known secret as well as complete values before applying the diagnostic limit.
  for (const secret of secrets) {
    const incompleteCodePoint = safe.endsWith("\ufffd") ? 1 : 0;
    const overlap = trailingSecretPrefix(incompleteCodePoint ? safe.slice(0, -1) : safe, secret);
    if (overlap > 0) safe = `${safe.slice(0, -overlap - incompleteCodePoint)}[REDACTED]`;
  }
  return redactExecutionText(safe, secrets).toWellFormed();
}

function trailingSecretPrefix(text: string, secret: string): number {
  if (secret.length === 0) return 0;
  const fallback: number[] = [0];
  for (let index = 1, matched = 0; index < secret.length; index += 1) {
    while (matched > 0 && secret[index] !== secret[matched]) matched = fallback[matched - 1] ?? 0;
    if (secret[index] === secret[matched]) matched += 1;
    fallback.push(matched);
  }
  let matched = 0;
  for (let index = Math.max(0, text.length - secret.length); index < text.length; index += 1) {
    while (matched > 0 && (matched === secret.length || text[index] !== secret[matched])) {
      matched = fallback[matched - 1] ?? 0;
    }
    if (text[index] === secret[matched]) matched += 1;
  }
  return matched;
}

function copyBaseEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    const key = name.toUpperCase();
    if (
      !baseEnvironmentNameSet.has(key) ||
      Object.hasOwn(result, key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 32_767 ||
      value.includes("\0") ||
      !value.isWellFormed()
    ) {
      throw new TypeError(
        "The validation base environment is invalid or contains unsupported variables.",
      );
    }
    result[key] = value;
  }
  if (baseEnvironmentNames.some((name) => !Object.hasOwn(result, name)))
    throw new TypeError("The validation base environment is incomplete.");
  return Object.freeze(result);
}

function validatePublishedProfile(profile: ValidationProfileVersion): ValidationProfileVersion {
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  if (
    !Value.Check(ValidationProfileVersionSchema, profile) ||
    getValidationProfileConfigIssues(profile.config, profile.workflowKind, profile.target).length >
      0 ||
    createCanonicalResult(profile.config).sha256 !== profile.configSha256
  ) {
    throw new ValidationRunnerError(
      "PROFILE_INVALID",
      "The published validation profile or its configuration digest is invalid.",
    );
  }
  return structuredClone(profile);
}

function createDeadline(parent: AbortSignal | undefined, milliseconds: number): Deadline {
  const controller = new AbortController();
  const deadline = performance.now() + Math.max(0, milliseconds);
  const abort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  if (milliseconds <= 0) {
    controller.abort(new ValidationRunnerError("STEP_TIMEOUT", "The validation deadline expired."));
  }
  const timeout = setTimeout(
    () =>
      controller.abort(
        new ValidationRunnerError("STEP_TIMEOUT", "The validation deadline expired."),
      ),
    Math.max(0, milliseconds),
  );
  timeout.unref();
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, deadline - performance.now()),
    close: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

async function observeSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation can already have started before this helper receives its promise.
    // Observe its eventual rejection even though this caller has lost authority to await it.
    void operation.catch(() => undefined);
    throw signal.reason;
  }
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const listener = (): void => rejectAbort(signal.reason);
  signal.addEventListener("abort", listener, { once: true });
  try {
    const result = await Promise.race([operation, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

function checkResult(
  step: ValidationCommandStep,
  id: string,
  phase: ValidationCommandPhase,
  outcome: ValidationOutcome,
  summary: string,
  actual: string | null,
): ValidationCheckResult {
  return {
    id,
    name: step.name,
    kind: phase === "build" || phase === "test" ? phase : "static",
    required: step.required,
    outcome,
    summary,
    expected: "The configured process exits with code 0 within its execution budget.",
    actual,
    evidenceIds: [],
    source: "runner",
  };
}

function skippedCleanup(step: ValidationCommandStep, checkId: string): StepResult {
  return {
    check: checkResult(
      step,
      checkId,
      "cleanup",
      "not_run",
      "The independent cleanup budget was exhausted.",
      null,
    ),
    diagnostic: {
      stepId: checkId,
      phase: "cleanup",
      outcome: "not_run",
      exitCode: null,
      summary: "The independent cleanup budget was exhausted.",
      stdout: "",
      stderr: "",
    },
    failureCode: "CLEANUP_FAILED",
    category: "lifecycle",
  };
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal,
): {
  outcome: ValidationOutcome;
  summary: string;
  code: string | undefined;
  category: FailureCategory;
} {
  if (signal.aborted)
    return {
      outcome: "inconclusive",
      summary:
        signal.reason instanceof ValidationRunnerError && signal.reason.code === "STEP_TIMEOUT"
          ? "The validation step exceeded its execution and verification deadline."
          : "The command was cancelled before its result could be accepted.",
      code: signal.reason instanceof ValidationRunnerError ? signal.reason.code : "CANCELLED",
      category: "infrastructure",
    };
  if (error === undefined)
    return {
      outcome: "passed",
      summary: "The configured command completed with exit code 0.",
      code: undefined,
      category: "validation",
    };
  if (error instanceof ValidationRunnerError)
    return {
      outcome: "blocked",
      summary: error.message,
      code: error.code,
      category: "infrastructure",
    };
  if (error instanceof ManagedProcessRunError && error.code === "NON_ZERO_EXIT")
    return {
      outcome: "failed",
      summary: "The configured command completed with a nonzero exit code.",
      code: "REQUIRED_STEP_FAILED",
      category: "validation",
    };
  if (error instanceof ManagedProcessRunError && error.code === "PROGRESS_OBSERVER_FAILED")
    return {
      outcome: "inconclusive",
      summary:
        "The command's progress observer failed, so its validation result cannot be accepted.",
      code: error.code,
      category: "infrastructure",
    };
  if (error instanceof ManagedProcessRunError && error.code !== "PROCESS_START_FAILED")
    return {
      outcome: "inconclusive",
      summary:
        "The supervised process or its bounded output did not produce a complete validation result.",
      code: error.code,
      category: "infrastructure",
    };
  return {
    outcome: "blocked",
    summary:
      "The validation process could not be started or its execution infrastructure was unavailable.",
    code: error instanceof ManagedProcessRunError ? error.code : "INFRASTRUCTURE_UNAVAILABLE",
    category: "infrastructure",
  };
}
