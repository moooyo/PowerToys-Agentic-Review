import { createHash } from "node:crypto";
import {
  lstat as nodeLstat,
  open as nodeOpen,
  realpath as nodeRealpath,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { win32 } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { types } from "node:util";
import {
  buildCodexAppServerLaunchSpec,
  buildCodexExecLaunchSpec,
  type CodexAppServerProcessLaunchSpec,
  type CodexExecutionFailureCode,
  CodexJsonlParser,
  type CodexJsonlRecord,
  type CodexProcessLaunchSpec,
  codexProcessResourceLimitBounds,
  collectCommandEvidence,
  determineCodexExecutionResult,
  redactExecutionText,
} from "@agentic-review/codex";
import {
  getModelInvocationScopeIssues,
  getModelInvocationSubmissionIssues,
  type ModelInvocationScope,
  type ReviewExecutionEvidence,
  type RunFailureDiagnostics,
} from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Logger } from "../logging/logger.js";
import {
  buildCodexAppServerSessionConfiguration,
  type CodexAppServerModelParameters,
  CodexAppServerSessionPolicyError,
  openCodexAppServerSession,
  snapshotCodexAppServerModelParameters,
} from "./codex-app-server-session-policy.js";
import { codexAppServerTransportLimits } from "./codex-app-server-transport.js";
import {
  type CodexAppServerTurnDriver,
  CodexAppServerTurnDriverError,
  createCodexAppServerTurnDriver,
} from "./codex-app-server-turn-driver.js";
import type { JobExecutionContext, JobExecutionResult } from "./job-executor.js";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import {
  ModelInvocationCoordinatorError,
  type ModelInvocationSession,
  type ModelInvocationSessionResult,
} from "./model-invocation-coordinator.js";
import { createModelRelayLaunchProfile } from "./model-relay-launch.js";
import { ProcessHostRequestError } from "./process-host-client.js";
import { type ManagedProcess, ProcessExitedEventSchema } from "./process-host-protocol.js";
import { WorkspaceDiskBudgetError, type WorkspaceDiskMonitor } from "./workspace-disk-budget.js";

const maximumRetainedRecordCount = 4_096;
const maximumRetainedRecordCharacters = 8 * 1024 * 1024;
const maximumJsonlLineCharacters = 1_048_576;
const maximumResultFileBytes = 2 * 1024 * 1024;
const schemaFileName = "schema.json";
const resultFileName = "result.json";
// The attempt owner supplies one stable signal. Entries survive a failed opening or upload;
// a fresh wrapper, invocation nonce or runner instance cannot redispatch that same live attempt.
const startedModelAttempts = new WeakMap<AbortSignal, Set<string>>();
const codexShellEnvironmentNames = [
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

type CodexShellEnvironment = Readonly<Record<(typeof codexShellEnvironmentNames)[number], string>>;

export interface ReviewFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeMs: bigint;
  readonly ctimeMs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ReviewFileHandle {
  stat(): Promise<ReviewFileStat>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface ReviewFileIO {
  writeExclusiveUtf8(path: string, content: string): Promise<void>;
  lstat(path: string): Promise<ReviewFileStat>;
  realpath(path: string): Promise<string>;
  openRead(path: string): Promise<ReviewFileHandle>;
}

export interface PreparedCodexOutputRunnerOptions {
  readonly codexExecutablePath: string;
  readonly codexHomeDirectory: string;
  readonly codexConfigurationOverrides?: readonly string[];
  readonly codexProviderEnvironment?: Readonly<Record<string, string>>;
  /** Loader-classified protected header values. Omission preserves protection for every header. */
  readonly codexProviderProtectedValues?: readonly string[];
  readonly modelInvocationBackend?: CodexAppServerModelParameters & {
    readonly kind: "app_server";
    /** SHA-256 of the executable already verified by the parent startup owner. */
    readonly codexExecutableSha256: string;
    readonly commandNetworkDomains?: readonly string[];
  };
  readonly systemRoot: string;
  readonly comSpec: string;
  readonly path: string;
  readonly pathExt: string;
  readonly maximumHardTimeoutMs: number;
  readonly maximumProcessCount: number;
  readonly maximumMemoryBytes: number;
  readonly maximumOutputBytes: number;
  readonly fileIO?: ReviewFileIO;
  readonly logger?: Logger;
}

interface CollectedCodexRecords {
  readonly records: readonly CodexJsonlRecord[];
  readonly limitExceeded: boolean;
}

type FailedJobExecution = Extract<JobExecutionResult, { readonly outcome: "failed" }>;

export class ReviewExecutionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReviewExecutionError";
  }
}

const defaultFileIO: ReviewFileIO = {
  writeExclusiveUtf8: async (path, content) => {
    await nodeWriteFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  lstat: async (path) => nodeLstat(path, { bigint: true }),
  realpath: async (path) => nodeRealpath(path),
  openRead: async (path) => {
    const handle = await nodeOpen(path, "r");
    return {
      stat: async () => handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) => {
        const result = await handle.read(buffer, offset, length, position);
        return { bytesRead: result.bytesRead };
      },
      close: async () => handle.close(),
    };
  },
};

export interface PreparedCodexOutputInput<TOutputSchema extends TSchema> {
  readonly workspace: PreparedJobWorkspace;
  readonly context: JobExecutionContext;
  readonly authoritativeSchema: {
    readonly json: string;
    readonly digest: string;
    readonly resultSchema: TOutputSchema;
  };
  readonly prompt: string;
  readonly hardTimeoutMs: number;
  readonly noProgressTimeoutMs: number;
  readonly correlationId: string;
  readonly launchPolicy: "review" | "summary_read_only";
  readonly teardownTimeoutMs?: number;
  readonly sensitiveValues?: readonly string[];
  readonly reportNodeHealthFault?: (error: Error) => void;
  readonly modelInvocation?: PreparedModelInvocation;
}

/** Supplied by the parent attempt owner, never by a model result or workspace file. */
export interface PreparedModelInvocation {
  readonly expectedScope: ModelInvocationScope;
  open(): Promise<ModelInvocationSession>;
}

interface PreparedInvocationSession {
  readonly session: ModelInvocationSession;
  readonly profile: ReturnType<typeof createModelRelayLaunchProfile>;
}
export type PreparedCodexOutputResult<TResult> =
  | FailedJobExecution
  | {
      readonly outcome: "succeeded";
      readonly result: TResult;
      readonly resultDigest: string;
      readonly canonicalResultJson: string;
      readonly commandEvidence: Pick<ReviewExecutionEvidence, "commands" | "commandCapture">;
      readonly observedFileChange: boolean;
      /** Collection consistency only; this never accepts the execution boundary. */
      readonly modelInvocation?: ModelInvocationSessionResult;
    };

/** Runs Codex in a workspace already bound to an authoritative workflow adapter. */
export class PreparedCodexOutputRunner {
  readonly #fileIO: ReviewFileIO;
  readonly #codexHomeDirectory: string;
  readonly #modelInvocationBackend: PreparedCodexOutputRunnerOptions["modelInvocationBackend"];
  readonly #appServerExecutablePath: string;
  public constructor(private readonly options: PreparedCodexOutputRunnerOptions) {
    this.#modelInvocationBackend = snapshotModelInvocationBackend(options.modelInvocationBackend);
    this.#appServerExecutablePath = options.codexExecutablePath;
    this.#codexHomeDirectory = normalizeSafeWindowsDirectory(
      options.codexHomeDirectory,
      "codexHomeDirectory",
    );
    assertConfiguredLimit(
      options.maximumHardTimeoutMs,
      "maximumHardTimeoutMs",
      codexProcessResourceLimitBounds.hardTimeoutMs,
    );
    assertConfiguredLimit(
      options.maximumProcessCount,
      "maximumProcessCount",
      codexProcessResourceLimitBounds.maximumProcessCount,
    );
    assertConfiguredLimit(
      options.maximumMemoryBytes,
      "maximumMemoryBytes",
      codexProcessResourceLimitBounds.maximumMemoryBytes,
    );
    assertConfiguredLimit(
      options.maximumOutputBytes,
      "maximumOutputBytes",
      codexProcessResourceLimitBounds.maximumOutputBytes,
    );
    this.#fileIO = options.fileIO ?? defaultFileIO;
  }

  public async run<TOutputSchema extends TSchema>(
    input: PreparedCodexOutputInput<TOutputSchema>,
  ): Promise<PreparedCodexOutputResult<Static<TOutputSchema>>> {
    if (this.#modelInvocationBackend !== undefined && input.modelInvocation === undefined)
      throw new ReviewExecutionError(
        "MODEL_INVOCATION_REQUIRED",
        "The app-server backend requires an owned parent model invocation.",
        false,
      );
    if (input.modelInvocation === undefined) return this.runOutput(input);
    input.context.signal.throwIfAborted();
    let expectedScope: ModelInvocationScope;
    let actualPromptSha256: string;
    let preparedInput: PreparedCodexOutputInput<TOutputSchema>;
    let open: () => Promise<ModelInvocationSession>;
    try {
      if (getModelInvocationScopeIssues(input.modelInvocation.expectedScope).length > 0)
        throw new Error();
      expectedScope = structuredClone(input.modelInvocation.expectedScope);
      actualPromptSha256 =
        expectedScope.schemaVersion === "ModelInvocationScopeV2"
          ? expectedScope.inputRef.actualPromptSha256
          : expectedScope.promptSha256;
      open = input.modelInvocation.open.bind(input.modelInvocation);
      // Preserve the exact stdin and validation schema before opening an asynchronous session.
      // TypeBox cloning retains schema symbols, which structuredClone would discard.
      preparedInput = {
        ...input,
        context: {
          signal: input.context.signal,
          attemptSignal: input.context.attemptSignal ?? input.context.signal,
          processHost: input.context.processHost,
          reportProgress: input.context.reportProgress.bind(input.context),
          reportNodeHealthFault: input.context.reportNodeHealthFault.bind(input.context),
          ...(input.context.deferCleanup === undefined
            ? {}
            : { deferCleanup: input.context.deferCleanup.bind(input.context) }),
        },
        authoritativeSchema: {
          ...input.authoritativeSchema,
          resultSchema: Value.Clone(input.authoritativeSchema.resultSchema),
        },
        // Replacing a provider's launch inputs does not declassify values the parent already
        // knows are protected. Keep them for output rejection, never in relay argv/environment.
        sensitiveValues: Object.freeze([
          ...snapshotProtectedValues(input.sensitiveValues ?? []),
          ...snapshotProtectedValues(
            this.options.codexProviderProtectedValues ??
              Object.values(snapshotProviderEnvironment(this.options.codexProviderEnvironment)),
          ),
        ]),
      };
      if (
        (expectedScope.schemaVersion === "ModelInvocationScopeV2" &&
          preparedInput.launchPolicy !== "summary_read_only") ||
        createHash("sha256").update(preparedInput.prompt, "utf8").digest("hex") !==
          actualPromptSha256 ||
        preparedInput.authoritativeSchema.digest !== expectedScope.outputSchemaSha256 ||
        createHash("sha256")
          .update(preparedInput.authoritativeSchema.json, "utf8")
          .digest("hex") !== expectedScope.outputSchemaSha256
      )
        throw new Error();
    } catch {
      throw new ReviewExecutionError(
        "MODEL_INVOCATION_CONFIGURATION_INVALID",
        "The parent invocation scope does not match the prepared model input.",
        false,
      );
    }
    const executionSignal = preparedInput.context.signal;
    const attemptSignal = preparedInput.context.attemptSignal ?? executionSignal;
    // The full scope still binds lease authority; changing that authority cannot redispatch
    // the same job and attempt under an existing parent owner.
    const attemptKey = JSON.stringify([expectedScope.jobId, expectedScope.attemptId]);
    const ownedAttempts = startedModelAttempts.get(attemptSignal) ?? new Set<string>();
    if (ownedAttempts.has(attemptKey))
      throw new ReviewExecutionError(
        "MODEL_INVOCATION_ATTEMPT_ALREADY_STARTED",
        "This attempt already owns a model invocation; recording recovery cannot redispatch it.",
        false,
      );
    ownedAttempts.add(attemptKey);
    startedModelAttempts.set(attemptSignal, ownedAttempts);
    let session: ModelInvocationSession;
    try {
      session = await open();
    } catch {
      executionSignal.throwIfAborted();
      throw new ReviewExecutionError(
        "MODEL_INVOCATION_OPEN_UNCONFIRMED",
        "The parent model invocation could not be opened.",
        true,
      );
    }

    let output: PreparedCodexOutputResult<Static<TOutputSchema>> | undefined;
    let executionError: unknown;
    let executionFailed = false;
    let modelOutputSha256: string | null = null;
    try {
      const profile = createModelRelayLaunchProfile({
        session,
        expectedScope,
        promptSha256: actualPromptSha256,
        outputSchemaSha256: preparedInput.authoritativeSchema.digest,
      });
      output = await this.runOutput(preparedInput, { session, profile });
      if (output.outcome === "succeeded") modelOutputSha256 = output.resultDigest;
    } catch (error) {
      executionFailed = true;
      executionError = error;
    }

    let recording: ModelInvocationSessionResult | undefined;
    try {
      // Select one immutable close intent. An uncertain upload must never retry as close(null)
      // after a valid raw output digest was selected, or dispatch another model process.
      const closeIntent = Object.freeze({ modelOutputSha256 });
      try {
        recording = await session.close(closeIntent);
      } catch (error) {
        if (
          executionSignal.aborted ||
          !(error instanceof ModelInvocationCoordinatorError) ||
          !["SEAL_UNCONFIRMED", "SUBMISSION_UNCONFIRMED"].includes(error.code)
        )
          throw error;
        // One bounded transport replay reuses the retained parent session and exact intent.
        // The coordinator retains its ledger and seal request; no process is launched here.
        recording = await session.close(closeIntent);
      }
    } catch (error) {
      if (
        error instanceof ModelInvocationCoordinatorError &&
        ["PROCESS_DRAIN_UNCONFIRMED", "RELAY_CLOSE_UNCONFIRMED"].includes(error.code)
      )
        (preparedInput.reportNodeHealthFault ?? preparedInput.context.reportNodeHealthFault)(
          new ReviewExecutionError(
            "MODEL_INVOCATION_CLEANUP_UNCONFIRMED",
            "The model invocation could not confirm process and relay cleanup.",
            true,
          ),
        );
      if (!executionFailed && output?.outcome !== "failed")
        output = failure(
          "MODEL_INVOCATION_RECORDING_UNCONFIRMED",
          "The model output was not retained because invocation recording was not confirmed.",
          true,
        );
    }
    executionSignal.throwIfAborted();
    if (executionFailed) throw executionError;
    if (output === undefined)
      throw new ReviewExecutionError(
        "MODEL_INVOCATION_RECORDING_UNCONFIRMED",
        "The model invocation did not produce a confirmed output.",
        true,
      );
    if (output.outcome === "failed") return output;
    if (
      recording === undefined ||
      recording.executionAccepted !== false ||
      !recording.modelOutputBound ||
      getModelInvocationSubmissionIssues(recording.submission).length > 0 ||
      recording.submission.invocationId !== expectedScope.invocationId ||
      recording.submission.scopeSha256 !== session.opening.scopeSha256 ||
      recording.submission.consistency.state !== "matched"
    )
      return failure(
        "MODEL_INVOCATION_OUTPUT_UNBOUND",
        "The model output does not have a complete matching invocation collection.",
        false,
      );
    return { ...output, modelInvocation: recording };
  }

  private async runOutput<TOutputSchema extends TSchema>(
    input: PreparedCodexOutputInput<TOutputSchema>,
    invocation?: PreparedInvocationSession,
  ): Promise<PreparedCodexOutputResult<Static<TOutputSchema>>> {
    const { workspace, context, authoritativeSchema: authority } = input;
    context.signal.throwIfAborted();
    if (
      (input.launchPolicy !== "review" && input.launchPolicy !== "summary_read_only") ||
      (input.teardownTimeoutMs !== undefined &&
        (!Number.isSafeInteger(input.teardownTimeoutMs) ||
          input.teardownTimeoutMs < 1 ||
          input.teardownTimeoutMs > 60_000)) ||
      createHash("sha256").update(authority.json, "utf8").digest("hex") !== authority.digest
    ) {
      throw new ReviewExecutionError(
        "CODEX_LAUNCH_SPEC_INVALID",
        "The prepared Codex policy or schema digest is invalid.",
        false,
      );
    }
    const reportNodeHealthFault =
      input.reportNodeHealthFault ?? ((error: Error) => context.reportNodeHealthFault(error));
    const providerEnvironment = snapshotProviderEnvironment(
      invocation === undefined
        ? this.options.codexProviderEnvironment
        : invocation.profile.providerEnvironment,
    );
    const protectedValues = Object.freeze([
      ...new Set([
        ...snapshotProtectedValues(input.sensitiveValues ?? []),
        ...snapshotProtectedValues(
          invocation === undefined
            ? (this.options.codexProviderProtectedValues ?? Object.values(providerEnvironment))
            : invocation.profile.protectedValues,
        ),
      ]),
    ]);
    const redact = (text: string) => redactExecutionText(text, protectedValues);
    const codexHomeDirectory =
      invocation === undefined ? this.#codexHomeDirectory : invocationCodexHomeDirectory(workspace);
    if (invocation === undefined)
      assertPersistentCodexHomeOutsideAttempt(codexHomeDirectory, workspace.attemptDirectory);
    const schemaPath = win32.join(workspace.controlDirectory, schemaFileName);
    const resultPath = win32.join(workspace.controlDirectory, resultFileName);

    try {
      if (invocation !== undefined) {
        // A relay must not point Codex at the persistent upstream-provider profile. The parent
        // workspace provider owns this fresh attempt home directory; it contains no auth.
        for (const name of ["config.toml", "auth.json"])
          await assertPathMissing(
            this.#fileIO,
            win32.join(codexHomeDirectory, name),
            new ReviewExecutionError(
              "MODEL_INVOCATION_HOME_NOT_FRESH",
              "The relay home directory contains an existing provider or credential file.",
              false,
            ),
          );
      }
      if (this.#modelInvocationBackend === undefined) {
        await assertPathMissing(this.#fileIO, resultPath);
        await this.#fileIO.writeExclusiveUtf8(schemaPath, authority.json);
      }
    } catch (error) {
      if (error instanceof ReviewExecutionError) {
        throw error;
      }
      const failure = new ReviewExecutionError(
        "CONTROL_FILE_WRITE_FAILED",
        "The trusted Codex control files could not be created.",
        true,
        { cause: error },
      );
      reportNodeHealthFault(failure);
      throw failure;
    }

    context.signal.throwIfAborted();
    const hardTimeoutMs = Math.min(input.hardTimeoutMs, this.options.maximumHardTimeoutMs);
    if (
      hardTimeoutMs < codexProcessResourceLimitBounds.hardTimeoutMs.minimum ||
      hardTimeoutMs > codexProcessResourceLimitBounds.hardTimeoutMs.maximum
    ) {
      throw new ReviewExecutionError(
        "EXECUTION_POLICY_INVALID",
        "The job hard timeout is outside the supported Codex execution range.",
        false,
      );
    }

    let launchSpec: CodexProcessLaunchSpec | CodexAppServerProcessLaunchSpec;
    let appServerConfiguration:
      | ReturnType<typeof buildCodexAppServerSessionConfiguration>
      | undefined;
    try {
      const shellEnvironment: CodexShellEnvironment = {
        COMSPEC: this.options.comSpec,
        PATH: this.options.path,
        PATHEXT: this.options.pathExt,
        SYSTEMROOT: this.options.systemRoot,
        TEMP: workspace.tempDirectory,
        TMP: workspace.tempDirectory,
        USERPROFILE: workspace.userProfileDirectory,
      };
      const commonLaunch = {
        workingDirectory: workspace.checkoutDirectory,
        processWorkingDirectory: workspace.controlDirectory,
        controlRootDirectory: workspace.controlDirectory,
        providerEnvironment,
        environment: {
          CODEX_HOME: codexHomeDirectory,
          ...shellEnvironment,
        },
        limits: {
          hardTimeoutMs,
          maximumProcessCount: this.options.maximumProcessCount,
          maximumMemoryBytes: this.options.maximumMemoryBytes,
          maximumOutputBytes: this.options.maximumOutputBytes,
        },
      };
      if (this.#modelInvocationBackend === undefined) {
        launchSpec = buildCodexExecLaunchSpec({
          ...commonLaunch,
          executable: this.options.codexExecutablePath,
          prompt: input.prompt,
          sandboxMode: input.launchPolicy === "summary_read_only" ? "read-only" : "workspace-write",
          outputSchemaPath: schemaPath,
          outputLastMessagePath: resultPath,
          configurationOverrides: [
            ...(invocation === undefined
              ? (this.options.codexConfigurationOverrides ?? [])
              : invocation.profile.configurationOverrides),
            ...buildReviewCodexConfigurationOverrides(
              workspace.checkoutDirectory,
              shellEnvironment,
              input.launchPolicy,
            ),
          ],
        });
      } else {
        if (invocation === undefined) throw new Error();
        if (
          invocation.session.opening.runtime.client.executableSha256 !==
          this.#modelInvocationBackend.codexExecutableSha256
        )
          throw appServerRuntimeMismatch();
        appServerConfiguration = buildCodexAppServerSessionConfiguration({
          purpose: input.launchPolicy,
          requestedModel: invocation.session.opening.scope.requestedModel,
          relayUrl: invocation.session.relay.url,
          codexHomeDirectory,
          checkoutDirectory: workspace.checkoutDirectory,
          controlDirectory: workspace.controlDirectory,
          tempDirectory: workspace.tempDirectory,
          userProfileDirectory: workspace.userProfileDirectory,
          shellEnvironment,
          modelReasoningEffort: this.#modelInvocationBackend.modelReasoningEffort ?? null,
          modelContextWindow: this.#modelInvocationBackend.modelContextWindow ?? null,
          modelAutoCompactTokenLimit:
            this.#modelInvocationBackend.modelAutoCompactTokenLimit ?? null,
          ...(this.#modelInvocationBackend.commandNetworkDomains === undefined
            ? {}
            : {
                commandNetworkDomains: this.#modelInvocationBackend.commandNetworkDomains,
              }),
        });
        launchSpec = buildCodexAppServerLaunchSpec({
          ...commonLaunch,
          executable: this.#appServerExecutablePath,
          permissionProfile: appServerConfiguration.permissionProfile,
          configurationOverrides: [
            ...invocation.profile.configurationOverrides,
            ...appServerConfiguration.overrides,
          ],
        });
      }
    } catch (error) {
      if (error instanceof ReviewExecutionError) throw error;
      throw new ReviewExecutionError(
        "CODEX_LAUNCH_SPEC_INVALID",
        "The trusted Codex launch specification is invalid.",
        false,
        { cause: error },
      );
    }

    context.reportProgress({ phase: "codex_review", processCount: 0 });
    let diskMonitor: WorkspaceDiskMonitor;
    try {
      diskMonitor = await workspace.startDiskMonitoring(context.signal);
    } catch (error) {
      context.signal.throwIfAborted();
      const failure = workspaceDiskExecutionError(error);
      if (isNodeDiskFailure(error)) reportNodeHealthFault(failure);
      throw failure;
    }

    const observerFailure = new AbortController();
    const processSignal = AbortSignal.any([diskMonitor.signal, observerFailure.signal]);
    let progressError: ReviewExecutionError | undefined;
    const progressContext: JobExecutionContext = {
      ...context,
      reportProgress: (progress) => {
        if (progressError !== undefined) return;
        try {
          context.reportProgress(progress);
        } catch {
          progressError = new ReviewExecutionError(
            "CODEX_PROGRESS_REPORT_FAILED",
            "The Codex progress observer failed; process cleanup was requested.",
            true,
          );
          observerFailure.abort();
        }
      },
    };
    let managed: ManagedProcess | undefined;
    let processStartError: unknown;
    try {
      managed = await context.processHost.start(launchSpec, processSignal);
    } catch (error) {
      processStartError = error;
    }
    if (managed === undefined) {
      const diskError = await closeWorkspaceDiskMonitor(diskMonitor);
      context.signal.throwIfAborted();
      if (diskError !== undefined) {
        const failure = workspaceDiskExecutionError(diskError);
        if (isNodeDiskFailure(diskError)) reportNodeHealthFault(failure);
        throw failure;
      }
      const failure = new ReviewExecutionError(
        "CODEX_PROCESS_START_FAILED",
        "The Codex process could not be started.",
        true,
        { cause: processStartError },
      );
      reportNodeHealthFault(failure);
      throw failure;
    }

    const progressPulse = new CodexProgressPulse(progressContext, input.noProgressTimeoutMs);
    let settled: Awaited<ReturnType<typeof settleCodexProcess>> | undefined;
    let appServerOutput: PreparedCodexOutputResult<Static<TOutputSchema>> | undefined;
    let settlementError: unknown;
    let diskError: unknown;
    try {
      if (appServerConfiguration !== undefined && invocation !== undefined) {
        appServerOutput = await this.runAppServerOutput(
          input,
          invocation,
          managed,
          appServerConfiguration,
          protectedValues,
          processSignal,
          progressContext,
          progressPulse,
        );
      } else {
        const settlement = settleCodexProcess(managed, () => progressPulse.observeActivity());
        if (invocation !== undefined) {
          const drained = settlement.then((results) => {
            if (results[1].status !== "fulfilled" || results[2].status !== "fulfilled")
              throw new ReviewExecutionError(
                "CODEX_STREAM_FAILED",
                "A managed Codex output stream could not be drained.",
                true,
              );
          });
          // Install a rejection handler before handing ownership to the coordinator, including
          // the case where attachment itself rejects. Both observers share the same consumers.
          void drained.catch(() => undefined);
          try {
            invocation.session.attachProcess(managed, drained);
          } catch {
            // A cancelled or invalid session may reject attachment after process creation.
            // The runner still owns that process and must confirm its termination and draining.
            const cleanup = await settleSummaryProcess(
              managed,
              settlement,
              AbortSignal.abort(),
              input.teardownTimeoutMs ?? 5_000,
            );
            if (cleanup.some((part) => part.status !== "fulfilled"))
              throw new ReviewExecutionError(
                "CODEX_PROCESS_DRAIN_UNCONFIRMED",
                "The unattached Codex process could not be confirmed closed.",
                true,
              );
            throw new ReviewExecutionError(
              "MODEL_INVOCATION_PROCESS_ATTACH_FAILED",
              "The parent model invocation could not retain the process handle.",
              false,
            );
          }
        }
        progressContext.reportProgress({ phase: "codex_review", processCount: 1 });
        settled = await settleSummaryProcess(
          managed,
          settlement,
          processSignal,
          input.teardownTimeoutMs ?? 5_000,
        );
      }
    } catch (error) {
      settlementError = error;
    } finally {
      progressPulse.stop();
      progressContext.reportProgress({ phase: "codex_review", processCount: 0 });
      diskError = await closeWorkspaceDiskMonitor(diskMonitor);
    }
    if (settlementError !== undefined) {
      const cleanupUnconfirmed =
        settlementError instanceof ReviewExecutionError &&
        settlementError.code === "CODEX_PROCESS_DRAIN_UNCONFIRMED";
      if (cleanupUnconfirmed && settlementError instanceof ReviewExecutionError)
        reportNodeHealthFault(settlementError);
      if (appServerConfiguration === undefined || cleanupUnconfirmed) throw settlementError;
    }
    if (progressError !== undefined) throw progressError;
    if (settled === undefined && appServerOutput === undefined && settlementError === undefined)
      throw new ReviewExecutionError(
        "CODEX_PROCESS_DRAIN_UNCONFIRMED",
        "Codex process settlement could not be observed.",
        true,
      );
    context.signal.throwIfAborted();
    if (diskError !== undefined) {
      const failure = workspaceDiskExecutionError(diskError);
      if (isNodeDiskFailure(diskError)) reportNodeHealthFault(failure);
      throw failure;
    }
    if (settlementError !== undefined) throw settlementError;

    if (appServerOutput !== undefined) return appServerOutput;
    if (settled === undefined) throw new Error("The selected Codex backend did not settle.");

    const completed = settled[0];
    const stdout = settled[1];
    const stderr = settled[2];
    if (completed.status === "rejected") {
      const failure = new ReviewExecutionError(
        "CODEX_PROCESS_FAILED",
        "The managed Codex process did not produce a completion event.",
        true,
        { cause: completed.reason },
      );
      if (!isProcessHardTimeout(completed.reason)) reportNodeHealthFault(failure);
      throw failure;
    }
    if (stdout.status === "rejected" || stderr.status === "rejected") {
      const streamError =
        stdout.status === "rejected"
          ? stdout.reason
          : stderr.status === "rejected"
            ? stderr.reason
            : undefined;
      const failure = new ReviewExecutionError(
        "CODEX_STREAM_FAILED",
        "A managed Codex output stream ended unexpectedly.",
        true,
        { cause: streamError },
      );
      reportNodeHealthFault(failure);
      throw failure;
    }
    if (stdout.value.limitExceeded) {
      return failure(
        "CODEX_EVENT_LIMIT_EXCEEDED",
        "Codex emitted more structured events than the Worker can retain safely.",
        false,
      );
    }

    const processExit = completed.value;
    let lastMessage: string | null = null;
    if (processExit.exitCode === 0 && processExit.signal === null && !processExit.outputTruncated) {
      try {
        lastMessage = await readStableResultFile(
          this.#fileIO,
          workspace.controlDirectory,
          resultPath,
          Math.min(maximumResultFileBytes, this.options.maximumOutputBytes),
        );
      } catch (error) {
        if (error instanceof ReviewExecutionError) {
          throw error;
        }
        throw new ReviewExecutionError(
          "RESULT_FILE_READ_FAILED",
          "The Codex result file could not be read because of a filesystem error.",
          true,
          { cause: error },
        );
      }
    }

    const execution = determineCodexExecutionResult(
      {
        processExit: {
          exitCode: processExit.exitCode,
          signal: processExit.signal,
          outputTruncated: processExit.outputTruncated,
        },
        records: stdout.value.records,
        lastMessage,
      },
      authority.resultSchema,
    );
    if (!execution.ok) {
      const failed = failure(
        `CODEX_${execution.code.toUpperCase()}`,
        codexFailureMessage(execution.code),
        execution.retryable,
      );
      return {
        ...failed,
        diagnostics: {
          category: failureCategory(failed.code),
          exitCode: processExit.exitCode,
          summary: redact(
            `${execution.message}${stderr.value.length === 0 ? "" : `; stderr: ${stderr.value}`}`,
          ),
          correlationId: input.correlationId,
        },
      };
    }

    if (resultContainsProtectedValue(execution.result, protectedValues))
      return failure(
        "CODEX_RESULT_UNSAFE",
        "The model result could not be retained safely.",
        false,
      );
    return {
      outcome: "succeeded",
      result: execution.result,
      resultDigest: execution.resultDigest,
      canonicalResultJson: execution.canonicalResultJson,
      commandEvidence: collectCommandEvidence(stdout.value.records, redact),
      observedFileChange: stdout.value.records.some(
        (record) =>
          record.kind === "event" &&
          typeof record.value.item === "object" &&
          record.value.item !== null &&
          !Array.isArray(record.value.item) &&
          (record.value.item as Record<string, unknown>).type === "file_change",
      ),
    };
  }

  private async runAppServerOutput<TOutputSchema extends TSchema>(
    input: PreparedCodexOutputInput<TOutputSchema>,
    invocation: PreparedInvocationSession,
    managed: ManagedProcess,
    configuration: ReturnType<typeof buildCodexAppServerSessionConfiguration>,
    protectedValues: readonly string[],
    signal: AbortSignal,
    progressContext: JobExecutionContext,
    progressPulse: CodexProgressPulse,
  ): Promise<PreparedCodexOutputResult<Static<TOutputSchema>>> {
    const teardownTimeoutMs = input.teardownTimeoutMs ?? 5_000;
    let driver: CodexAppServerTurnDriver;
    try {
      driver = createCodexAppServerTurnDriver({
        process: managed,
        signal,
        onActivity: () => progressPulse.observeActivity(),
        transportLimits: {
          maximumStdoutBytes: Math.min(
            this.options.maximumOutputBytes,
            codexAppServerTransportLimits.maximumStdoutBytes,
          ),
          maximumStderrBytes: Math.min(
            this.options.maximumOutputBytes,
            codexAppServerTransportLimits.maximumStderrBytes,
          ),
          pipeTimeoutMs: Math.min(teardownTimeoutMs, codexAppServerTransportLimits.pipeTimeoutMs),
          closeGraceMs: Math.min(teardownTimeoutMs, codexAppServerTransportLimits.closeGraceMs),
          forceDrainTimeoutMs: Math.min(
            teardownTimeoutMs,
            codexAppServerTransportLimits.forceDrainTimeoutMs,
          ),
        },
      });
    } catch {
      // A rejected adapter has not established output ownership. Drain raw streams without
      // interpreting app-server bytes as exec events, including partially attached listeners.
      try {
        const settlement = Promise.allSettled([
          managed.completed,
          finished(managed.stdout, { cleanup: true }),
          finished(managed.stderr, { cleanup: true }),
        ] as const);
        managed.stdout.resume();
        managed.stderr.resume();
        const closed = await settleSummaryProcess(
          managed,
          settlement,
          AbortSignal.abort(),
          teardownTimeoutMs,
        );
        if (
          closed[0].status !== "fulfilled" ||
          closed[1].status !== "fulfilled" ||
          closed[2].status !== "fulfilled" ||
          !Value.Check(ProcessExitedEventSchema, closed[0].value) ||
          closed[0].value.requestId !== managed.requestId
        )
          throw new Error();
      } catch {
        throw appServerCleanupUnconfirmed();
      }
      throw new ReviewExecutionError(
        "CODEX_APP_SERVER_CONFIGURATION_INVALID",
        "The owned app-server process could not attach its bounded transport.",
        false,
      );
    }
    try {
      try {
        invocation.session.attachProcess(managed, driver.drained);
      } catch {
        throw new ReviewExecutionError(
          "MODEL_INVOCATION_PROCESS_ATTACH_FAILED",
          "The parent model invocation could not retain the process handle.",
          false,
        );
      }
      progressContext.reportProgress({ phase: "codex_review", processCount: 1 });
      const opened = await openCodexAppServerSession({
        transport: driver.transport,
        expected: configuration.expected,
      });
      const runtime = invocation.session.opening.runtime.client;
      if (
        opened.observation.executionAccepted !== false ||
        opened.observation.cliVersion !== runtime.version ||
        this.#modelInvocationBackend?.codexExecutableSha256 !== runtime.executableSha256 ||
        opened.launchPolicySha256 !== runtime.launchPolicySha256
      )
        throw appServerRuntimeMismatch();
      const output = await driver.runTurn({
        threadId: opened.threadId,
        prompt: input.prompt,
        authoritativeSchema: input.authoritativeSchema,
        protectedValues,
        outputLimits: {
          maximumResultBytes: Math.min(maximumResultFileBytes, this.options.maximumOutputBytes),
        },
      });
      return {
        outcome: "succeeded",
        result: output.result,
        resultDigest: output.resultDigest,
        canonicalResultJson: output.canonicalResultJson,
        commandEvidence: output.commandEvidence,
        observedFileChange: output.observedFileChange,
      };
    } catch (error) {
      try {
        await driver.abort();
      } catch {
        throw appServerCleanupUnconfirmed();
      }
      if (error instanceof ReviewExecutionError) throw error;
      if (error instanceof CodexAppServerSessionPolicyError)
        throw new ReviewExecutionError(
          `CODEX_APP_SERVER_${error.code}`,
          "The app-server session did not establish the required execution policy.",
          false,
        );
      if (error instanceof CodexAppServerTurnDriverError)
        throw new ReviewExecutionError(
          `CODEX_APP_SERVER_${error.code}`,
          "The app-server did not produce a validated and closed model turn.",
          !["INVALID_CONFIGURATION", "OUTPUT_INVALID", "ALREADY_STARTED"].includes(error.code),
        );
      throw new ReviewExecutionError(
        "CODEX_APP_SERVER_SESSION_FAILED",
        "The app-server session could not complete its bounded operation.",
        true,
      );
    }
  }
}

function appServerCleanupUnconfirmed(): ReviewExecutionError {
  return new ReviewExecutionError(
    "CODEX_PROCESS_DRAIN_UNCONFIRMED",
    "The app-server process and output streams could not be confirmed closed.",
    true,
  );
}

function appServerRuntimeMismatch(): ReviewExecutionError {
  return new ReviewExecutionError(
    "MODEL_INVOCATION_RUNTIME_MISMATCH",
    "The observed app-server runtime does not match the frozen invocation identity.",
    false,
  );
}

function snapshotModelInvocationBackend(
  input: PreparedCodexOutputRunnerOptions["modelInvocationBackend"],
): PreparedCodexOutputRunnerOptions["modelInvocationBackend"] {
  if (input === undefined) return undefined;
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw new Error();
    const values: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        typeof key !== "string" ||
        ![
          "kind",
          "codexExecutableSha256",
          "commandNetworkDomains",
          "modelReasoningEffort",
          "modelContextWindow",
          "modelAutoCompactTokenLimit",
        ].includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      )
        throw new Error();
      values[key] = descriptor.value;
    }
    if (
      values.kind !== "app_server" ||
      typeof values.codexExecutableSha256 !== "string" ||
      !/^[a-f0-9]{64}(?![\s\S])/u.test(values.codexExecutableSha256)
    )
      throw new Error();
    let domains: readonly string[] | undefined;
    if (values.commandNetworkDomains !== undefined) {
      const value = values.commandNetworkDomains;
      if (
        !Array.isArray(value) ||
        types.isProxy(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 256 ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        throw new Error();
      const snapshot: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (
          !descriptor?.enumerable ||
          !("value" in descriptor) ||
          typeof descriptor.value !== "string" ||
          descriptor.value.length > 32768
        )
          throw new Error();
        snapshot.push(descriptor.value);
      }
      domains = Object.freeze(snapshot);
    }
    return Object.freeze({
      kind: "app_server",
      codexExecutableSha256: values.codexExecutableSha256,
      ...snapshotCodexAppServerModelParameters({
        modelReasoningEffort: (values.modelReasoningEffort as string | null) ?? null,
        modelContextWindow: (values.modelContextWindow as number | null) ?? null,
        modelAutoCompactTokenLimit: (values.modelAutoCompactTokenLimit as number | null) ?? null,
      }),
      ...(domains === undefined ? {} : { commandNetworkDomains: domains }),
    });
  } catch {
    throw new ReviewExecutionError(
      "MODEL_INVOCATION_CONFIGURATION_INVALID",
      "The app-server backend configuration could not be captured safely.",
      false,
    );
  }
}

function snapshotProviderEnvironment(
  input: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (input === undefined) return Object.freeze({});
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw new Error();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 64) throw new Error();
    const snapshot: Record<string, string> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      )
        throw new Error();
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw new ReviewExecutionError(
      "CODEX_LAUNCH_SPEC_INVALID",
      "The provider environment could not be captured safely.",
      false,
    );
  }
}

function snapshotProtectedValues(input: readonly string[]): readonly string[] {
  try {
    if (!Array.isArray(input) || input.length > 256) throw new Error();
    const values: string[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, index);
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      )
        throw new Error();
      if (descriptor.value.length > 0) values.push(descriptor.value);
    }
    return Object.freeze(values);
  } catch {
    throw new ReviewExecutionError(
      "CODEX_LAUNCH_SPEC_INVALID",
      "The protected values could not be captured safely.",
      false,
    );
  }
}

/** Traverse decoded JSON iteratively; the existing result byte cap also bounds node work. */
function resultContainsProtectedValue(value: unknown, protectedValues: readonly string[]): boolean {
  if (protectedValues.length === 0) return false;
  const contains = (text: string) => protectedValues.some((secret) => text.includes(secret));
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > maximumResultFileBytes) return true;
    const current = pending.pop();
    if (current !== null && typeof current === "object") {
      if (Array.isArray(current)) for (const child of current) pending.push(child);
      else
        for (const [key, child] of Object.entries(current)) {
          if (contains(key)) return true;
          pending.push(child);
        }
    } else {
      const text = typeof current === "string" ? current : JSON.stringify(current);
      if (text !== undefined && contains(text)) return true;
    }
  }
  return false;
}

export function buildReviewCodexConfigurationOverrides(
  checkoutDirectory: string,
  environment: CodexShellEnvironment,
  policy: "review" | "summary_read_only" = "review",
): readonly string[] {
  const projectPath = normalizeSafeWindowsDirectory(checkoutDirectory, "checkoutDirectory");
  const tempPath = normalizeSafeWindowsDirectory(environment.TEMP, "tempDirectory");
  const shellEnvironment = codexShellEnvironmentNames
    .map((name) => `${name}=${tomlBasicString(environment[name])}`)
    .join(",");
  return Object.freeze([
    'approval_policy="never"',
    policy === "summary_read_only" ? 'sandbox_mode="read-only"' : 'sandbox_mode="workspace-write"',
    "allow_login_shell=false",
    "notify=[]",
    "check_for_update_on_startup=false",
    'web_search="disabled"',
    "project_doc_max_bytes=32768",
    'project_doc_fallback_filenames=["AGENTS.md"]',
    'file_opener="none"',
    'mcp_oauth_credentials_store="keyring"',
    "mcp_servers={}",
    'shell_environment_policy.inherit="none"',
    "shell_environment_policy.ignore_default_excludes=false",
    `shell_environment_policy.set={${shellEnvironment}}`,
    policy === "summary_read_only"
      ? "sandbox_workspace_write.network_access=false"
      : "sandbox_workspace_write.network_access=true",
    policy === "summary_read_only"
      ? "sandbox_workspace_write.writable_roots=[]"
      : `sandbox_workspace_write.writable_roots=[${tomlBasicString(tempPath)}]`,
    'windows.sandbox="elevated"',
    'history.persistence="none"',
    `projects={${tomlBasicString(projectPath)}={trust_level="untrusted"}}`,
    "features.apps=false",
    "features.hooks=false",
    "features.memories=false",
    "features.multi_agent=false",
    "features.plugins=false",
    "features.remote_plugin=false",
    "features.skill_mcp_dependency_install=false",
    "agents.enabled=false",
    "apps._default.enabled=false",
    "apps._default.destructive_enabled=false",
    "apps._default.open_world_enabled=false",
    "tools.web_search=false",
    "tools.view_image=false",
    ...(policy === "summary_read_only"
      ? [
          "features.browser_use=false",
          "features.browser_use_external=false",
          "features.browser_use_full_cdp_access=false",
          "features.computer_use=false",
          "features.in_app_browser=false",
          "features.enable_mcp_apps=false",
          "features.multi_agent_v2=false",
        ]
      : []),
  ]);
}

async function closeWorkspaceDiskMonitor(
  monitor: WorkspaceDiskMonitor,
): Promise<unknown | undefined> {
  try {
    await monitor.close();
  } catch (error) {
    return monitor.violation ?? error;
  }
  return monitor.violation;
}

function workspaceDiskExecutionError(error: unknown): ReviewExecutionError {
  if (!(error instanceof WorkspaceDiskBudgetError)) {
    return new ReviewExecutionError(
      "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE",
      "Workspace disk monitoring failed unexpectedly during Codex execution.",
      true,
      { cause: error },
    );
  }
  if (error.code === "CURRENT_ATTEMPT_LIMIT_EXCEEDED") {
    return new ReviewExecutionError(
      "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED",
      "The review attempt exceeded its configured workspace disk budget.",
      false,
      { cause: error },
    );
  }
  if (isTemporaryDiskCapacityFailure(error)) {
    return new ReviewExecutionError(
      "WORKSPACE_DISK_CAPACITY_UNAVAILABLE",
      "Workspace capacity is temporarily unavailable.",
      true,
      { cause: error },
    );
  }
  return new ReviewExecutionError(
    "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE",
    "Workspace disk or node infrastructure became unavailable during Codex execution.",
    true,
    { cause: error },
  );
}

function isNodeDiskFailure(error: unknown): boolean {
  return !(
    error instanceof WorkspaceDiskBudgetError &&
    (error.code === "ABORTED" ||
      error.code === "CURRENT_ATTEMPT_LIMIT_EXCEEDED" ||
      isTemporaryDiskCapacityFailure(error))
  );
}

function isTemporaryDiskCapacityFailure(error: WorkspaceDiskBudgetError): boolean {
  return ["ACCOUNTING_BUSY", "CAPACITY_UNAVAILABLE", "INSUFFICIENT_FREE_SPACE"].includes(
    error.code,
  );
}

function isProcessHardTimeout(error: unknown): boolean {
  return error instanceof ProcessHostRequestError && error.code === "PROCESS_HARD_TIMEOUT";
}

/**
 * Reports throttled progress only when Codex emits stdout or stderr activity.
 * Silent runs must age out under the Server no-progress deadline.
 */
class CodexProgressPulse {
  readonly #activityThrottleMs: number;
  #lastReportAt = 0;
  #stopped = false;

  public constructor(
    private readonly context: JobExecutionContext,
    noProgressTimeoutMs: number,
  ) {
    this.#activityThrottleMs = Math.min(5_000, Math.max(250, Math.floor(noProgressTimeoutMs / 4)));
  }

  public observeActivity(): void {
    if (!this.#stopped && Date.now() - this.#lastReportAt >= this.#activityThrottleMs) {
      this.#report();
    }
  }

  public stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
  }

  #report(): void {
    if (this.#stopped) {
      return;
    }
    this.context.reportProgress({ phase: "codex_review", processCount: 1 });
    this.#lastReportAt = Date.now();
  }
}

async function settleCodexProcess(managed: ManagedProcess, reportActivity: () => void) {
  return Promise.allSettled([
    managed.completed,
    collectCodexRecords(managed.stdout, reportActivity),
    drainStream(managed.stderr, reportActivity),
  ] as const);
}

async function settleSummaryProcess<
  T extends readonly [
    PromiseSettledResult<Awaited<ManagedProcess["completed"]>>,
    PromiseSettledResult<unknown>,
    PromiseSettledResult<unknown>,
  ],
>(
  managed: ManagedProcess,
  settlement: Promise<T>,
  signal: AbortSignal,
  teardownTimeoutMs: number,
): Promise<T> {
  if (
    !Number.isSafeInteger(teardownTimeoutMs) ||
    teardownTimeoutMs < 1 ||
    teardownTimeoutMs > 60_000
  )
    throw new TypeError("Invalid Codex teardown budget.");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const completed = await Promise.race([settlement, aborted]);
    if (completed !== null) return completed;
    let timer: NodeJS.Timeout | undefined;
    try {
      // The process may already have exited while its streams are still draining. Its
      // termination request can then reject because the ProcessHost removed the active entry.
      // Observe actual exit and streams independently of that acknowledgement.
      void Promise.resolve()
        .then(() => managed.terminate("cancelled"))
        .catch(() => undefined);
      const results = await Promise.race([
        settlement,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ReviewExecutionError(
                  "CODEX_PROCESS_DRAIN_UNCONFIRMED",
                  "Codex termination and output draining could not be confirmed.",
                  true,
                ),
              ),
            teardownTimeoutMs,
          );
          timer.unref();
        }),
      ]);
      if (
        results[0].status !== "fulfilled" ||
        results[1].status !== "fulfilled" ||
        results[2].status !== "fulfilled" ||
        !Value.Check(ProcessExitedEventSchema, results[0].value) ||
        results[0].value.requestId !== managed.requestId
      )
        throw new ReviewExecutionError(
          "CODEX_PROCESS_DRAIN_UNCONFIRMED",
          "Codex termination and output draining could not be confirmed.",
          true,
        );
      return results;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function collectCodexRecords(
  stdout: Readable,
  reportActivity: () => void,
): Promise<CollectedCodexRecords> {
  const parser = new CodexJsonlParser({ maximumLineCharacters: maximumJsonlLineCharacters });
  const records: CodexJsonlRecord[] = [];
  let retainedCharacters = 0;
  let limitExceeded = false;

  const retain = (incoming: readonly CodexJsonlRecord[]): void => {
    for (const record of incoming) {
      const characters = JSON.stringify(record).length;
      if (
        records.length >= maximumRetainedRecordCount ||
        retainedCharacters + characters > maximumRetainedRecordCharacters
      ) {
        limitExceeded = true;
        continue;
      }
      retainedCharacters += characters;
      records.push(record);
    }
  };

  for await (const chunk of stdout) {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) {
      if (chunk.length > 0) {
        reportActivity();
      }
      const parsed = parser.push(chunk);
      retain(parsed);
    } else {
      throw new TypeError("Codex stdout emitted an unsupported chunk type.");
    }
  }
  const finalRecords = parser.finish();
  retain(finalRecords);
  return { records, limitExceeded };
}

async function drainStream(stream: Readable, reportActivity: () => void): Promise<string> {
  const decoder = new TextDecoder();
  let retained = "";
  let truncated = false;
  for await (const chunk of stream) {
    if (
      (typeof chunk === "string" && chunk.length > 0) ||
      (chunk instanceof Uint8Array && chunk.byteLength > 0)
    ) {
      reportActivity();
    }
    if (!truncated) {
      retained += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      if (retained.length > 8_192) {
        retained = "[stderr exceeded the diagnostic capture limit]";
        truncated = true;
      }
    }
  }
  return retained;
}

async function assertPathMissing(
  fileIO: ReviewFileIO,
  path: string,
  preexistingError?: ReviewExecutionError,
): Promise<void> {
  try {
    await fileIO.lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw (
    preexistingError ??
    new ReviewExecutionError(
      "RESULT_FILE_PREEXISTS",
      "The Codex result path existed before process launch.",
      false,
    )
  );
}

async function readStableResultFile(
  fileIO: ReviewFileIO,
  controlDirectory: string,
  resultPath: string,
  maximumBytes: number,
): Promise<string | null> {
  assertContainedWindowsPath(controlDirectory, resultPath);
  let pathStat: ReviewFileStat;
  try {
    pathStat = await fileIO.lstat(resultPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  assertRegularStableFile(pathStat, maximumBytes);

  const normalizedControl = normalizeWindowsPath(controlDirectory);
  const normalizedResult = normalizeWindowsPath(resultPath);
  const realControl = normalizeWindowsPath(await fileIO.realpath(controlDirectory));
  const realResult = normalizeWindowsPath(await fileIO.realpath(resultPath));
  if (
    !windowsPathsEqual(normalizedControl, realControl) ||
    !windowsPathsEqual(normalizedResult, realResult)
  ) {
    throw resultFileError("The Codex result path resolves through a reparse point.");
  }
  assertContainedWindowsPath(realControl, realResult);

  const handle = await fileIO.openRead(resultPath);
  let primaryError: unknown;
  let decodedResult: string | undefined;
  try {
    const handleStatBefore = await handle.stat();
    assertRegularStableFile(handleStatBefore, maximumBytes);
    assertSameFile(pathStat, handleStatBefore);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let position = 0;
    while (totalBytes <= maximumBytes) {
      const capacity = Math.min(64 * 1024, maximumBytes + 1 - totalBytes);
      const buffer = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(buffer, 0, capacity, position);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      position += bytesRead;
    }
    if (totalBytes > maximumBytes) {
      throw resultFileError("The Codex result file exceeds its size limit.");
    }

    const handleStatAfter = await handle.stat();
    const pathStatAfter = await fileIO.lstat(resultPath);
    assertSameFile(handleStatBefore, handleStatAfter);
    assertSameFile(handleStatAfter, pathStatAfter);
    if (
      handleStatBefore.size !== handleStatAfter.size ||
      handleStatBefore.mtimeMs !== handleStatAfter.mtimeMs ||
      handleStatBefore.ctimeMs !== handleStatAfter.ctimeMs
    ) {
      throw resultFileError("The Codex result file changed while it was being read.");
    }
    const realResultAfter = normalizeWindowsPath(await fileIO.realpath(resultPath));
    if (!windowsPathsEqual(realResult, realResultAfter)) {
      throw resultFileError("The Codex result path changed while it was being read.");
    }

    try {
      decodedResult = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, totalBytes),
      );
    } catch (error) {
      throw new ReviewExecutionError(
        "RESULT_FILE_INVALID",
        "The Codex result file is not valid UTF-8.",
        false,
        { cause: error },
      );
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    primaryError ??= error;
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (decodedResult === undefined) {
    throw resultFileError("The Codex result file did not produce readable content.");
  }
  return decodedResult;
}

function assertRegularStableFile(stat: ReviewFileStat, maximumBytes: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw resultFileError("The Codex result path is not a regular file.");
  }
  if (stat.dev < 0n || stat.ino < 0n || stat.size < 0n || stat.size > BigInt(maximumBytes)) {
    throw resultFileError("The Codex result file exceeds its size limit.");
  }
}

function assertSameFile(first: ReviewFileStat, second: ReviewFileStat): void {
  if (first.dev !== second.dev || first.ino !== second.ino) {
    throw resultFileError("The Codex result file changed identity while it was being read.");
  }
}

function resultFileError(message: string): ReviewExecutionError {
  return new ReviewExecutionError("RESULT_FILE_INVALID", message, false);
}

function assertContainedWindowsPath(root: string, candidate: string): void {
  const relative = win32.relative(normalizeWindowsPath(root), normalizeWindowsPath(candidate));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${win32.sep}`) ||
    win32.isAbsolute(relative)
  ) {
    throw resultFileError("The Codex result path is outside its control directory.");
  }
}

function normalizeWindowsPath(path: string): string {
  return win32.normalize(path).replace(/[\\/]+$/u, "");
}

function windowsPathsEqual(first: string, second: string): boolean {
  return normalizeWindowsPath(first).toLowerCase() === normalizeWindowsPath(second).toLowerCase();
}

function codexFailureMessage(code: CodexExecutionFailureCode): string {
  const messages: Record<CodexExecutionFailureCode, string> = {
    output_truncated: "Codex output exceeded the configured managed-process limit.",
    process_terminated: "The managed Codex process was terminated before completion.",
    invalid_event_stream: "Codex emitted an invalid structured event stream.",
    codex_reported_error: "Codex reported an execution error.",
    codex_turn_failed: "The Codex review turn failed.",
    non_zero_exit: "Codex exited with a non-zero status.",
    incomplete_event_stream: "Codex did not emit a complete review event sequence.",
    missing_result: "Codex did not create a final structured result.",
    invalid_result_json: "The Codex final result is not valid JSON.",
    invalid_result_schema: "The Codex final result does not match the authoritative schema.",
  };
  return messages[code];
}

export function failureCategory(code: string): RunFailureDiagnostics["category"] {
  if (code.startsWith("WORKSPACE_") || code.startsWith("CONTROL_FILE_")) return "workspace";
  if (code.includes("LAUNCH") || code.includes("PROCESS_START")) return "launch";
  if (code.includes("RESULT") || code === "JOB_CONTRACT_INVALID") return "result";
  if (code.includes("EVENT") || code.includes("STREAM")) return "event_stream";
  if (code.startsWith("CODEX_")) return "process";
  return "internal";
}

export function errorSummary(error: Error): string {
  const identities: string[] = [];
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const name = current.name.length <= 128 ? current.name : "Error";
    const errorCode = (current as Error & { readonly code?: unknown }).code;
    const code =
      (typeof errorCode === "string" || typeof errorCode === "number") &&
      String(errorCode).length <= 128
        ? ` [${errorCode}]`
        : "";
    const message =
      current.message.length <= 2_048
        ? current.message
        : "Diagnostic message exceeded the capture limit.";
    identities.push(`${name}${code}`);
    messages.push(message);
    const stderr = (current as Error & { readonly stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.length > 0) {
      messages.push(
        stderr.length <= 2_048
          ? `stderr: ${stderr}`
          : "Stderr exceeded the diagnostic capture limit.",
      );
    }
    current = current.cause;
  }
  // Keep bounded error identities ahead of free text so later redaction and truncation
  // cannot hide the filesystem or process classification behind a long wrapper message.
  return `${identities.join(" <- ")}: ${messages.join("; caused by: ")}`;
}

export function extractExitCode(error: Error): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const candidate = current as Error & {
      readonly exitCode?: unknown;
      readonly result?: { readonly exitCode?: unknown };
    };
    const code = candidate.exitCode ?? candidate.result?.exitCode;
    if (
      typeof code === "number" &&
      Number.isInteger(code) &&
      code >= -2_147_483_648 &&
      code <= 4_294_967_295
    )
      return code;
    current = current.cause;
  }
  return null;
}

function normalizeSafeWindowsDirectory(value: string, name: string): string {
  assertWellFormedUnicode(value, name);
  if (!/^[A-Za-z]:[\\/]/u.test(value) || value.slice(2).includes(":")) {
    throw new TypeError(`${name} must be an absolute local Windows path`);
  }
  for (const component of value.slice(3).split(/[\\/]/u)) {
    if (
      component === "." ||
      component === ".." ||
      component.endsWith(".") ||
      component.endsWith(" ") ||
      /[<>:"|?*]/u.test(component) ||
      [...component].some((character) => character.charCodeAt(0) <= 0x1f)
    ) {
      throw new TypeError(`${name} contains an unsafe Windows path component`);
    }
  }
  const normalized = win32.normalize(value.replaceAll("/", "\\"));
  if (normalized === win32.parse(normalized).root) {
    throw new TypeError(`${name} must not be a filesystem root`);
  }
  return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`.replace(/[\\]+$/u, "");
}

function assertPersistentCodexHomeOutsideAttempt(
  codexHome: string,
  attemptDirectory: string,
): void {
  const attempt = normalizeSafeWindowsDirectory(attemptDirectory, "attemptDirectory");
  const profile = codexHome.toLowerCase();
  const workspace = attempt.toLowerCase();
  if (
    profile === workspace ||
    profile.startsWith(`${workspace}\\`) ||
    workspace.startsWith(`${profile}\\`)
  ) {
    throw new ReviewExecutionError(
      "CODEX_LAUNCH_SPEC_INVALID",
      "The persistent Codex home must be disjoint from the task attempt directory.",
      false,
    );
  }
}

function invocationCodexHomeDirectory(workspace: PreparedJobWorkspace): string {
  try {
    const home = normalizeSafeWindowsDirectory(workspace.codexHomeDirectory, "codexHomeDirectory");
    const folded = home.toLowerCase();
    const attempt = normalizeSafeWindowsDirectory(
      workspace.attemptDirectory,
      "attemptDirectory",
    ).toLowerCase();
    if (!folded.startsWith(`${attempt}\\`)) throw new Error();
    for (const directory of [workspace.checkoutDirectory, workspace.controlDirectory]) {
      const sibling = normalizeSafeWindowsDirectory(directory, "workspaceDirectory").toLowerCase();
      if (
        folded === sibling ||
        folded.startsWith(`${sibling}\\`) ||
        sibling.startsWith(`${folded}\\`)
      )
        throw new Error();
    }
    return home;
  } catch {
    throw new ReviewExecutionError(
      "MODEL_INVOCATION_HOME_INVALID",
      "The relay home must be a separate directory inside the prepared attempt.",
      false,
    );
  }
}

function tomlBasicString(value: string): string {
  assertWellFormedUnicode(value, "TOML string");
  return JSON.stringify(value);
}

function assertWellFormedUnicode(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${name} must contain well-formed Unicode`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${name} must contain well-formed Unicode`);
    }
  }
}

function assertConfiguredLimit(
  value: number,
  name: string,
  bounds: { readonly minimum: number; readonly maximum: number },
): void {
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new RangeError(`${name} is outside the supported ProcessHost range`);
  }
}

function failure(code: string, message: string, retryable: boolean): FailedJobExecution {
  return {
    outcome: "failed",
    code: code.slice(0, 128),
    message: message.slice(0, 2_048),
    retryable,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}
