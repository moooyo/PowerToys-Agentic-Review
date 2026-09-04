import { createHash } from "node:crypto";
import {
  lstat as nodeLstat,
  open as nodeOpen,
  realpath as nodeRealpath,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { win32 } from "node:path";
import type { Readable } from "node:stream";
import {
  buildCodexExecLaunchSpec,
  type CodexExecutionFailureCode,
  CodexJsonlParser,
  type CodexJsonlRecord,
  type CodexProcessLaunchSpec,
  codexProcessResourceLimitBounds,
  createCanonicalResult,
  determineCodexExecutionResult,
  IssueTriageV1ModelOutputSchema,
  IssueTriageV1Schema,
  type PrReviewPlanV1,
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV1Schema,
  type ReviewResultV1,
} from "@agentic-review/codex";
import type { JobExecutionEnvelope } from "@agentic-review/contracts";
import type { Logger } from "../logging/logger.js";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "./job-executor.js";
import {
  JobWorkspaceError,
  type JobWorkspaceProvider,
  type PreparedJobWorkspace,
} from "./job-workspace.js";
import { ProcessHostRequestError } from "./process-host-client.js";
import type { ManagedProcess } from "./process-host-protocol.js";
import { WorkspaceDiskBudgetError, type WorkspaceDiskMonitor } from "./workspace-disk-budget.js";

const maximumRetainedRecordCount = 4_096;
const maximumRetainedRecordCharacters = 8 * 1024 * 1024;
const maximumJsonlLineCharacters = 1_048_576;
const maximumResultFileBytes = 2 * 1024 * 1024;
const configFileName = "config.toml";
const schemaFileName = "schema.json";
const resultFileName = "result.json";

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

export interface ReviewJobExecutorOptions {
  readonly workspaceProvider: JobWorkspaceProvider;
  readonly codexExecutablePath: string;
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

interface AuthoritativeReviewSchema {
  readonly resultSchema: typeof PrReviewPlanV1Schema | typeof IssueTriageV1Schema;
  readonly json: string;
  readonly digest: string;
}

interface CollectedCodexRecords {
  readonly records: readonly CodexJsonlRecord[];
  readonly limitExceeded: boolean;
}

type FailedJobExecution = Extract<JobExecutionResult, { readonly outcome: "failed" }>;

class ReviewExecutionError extends Error {
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

const noOpLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

const authoritativePrSchema = createAuthoritativeSchema(
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV1Schema,
);
const authoritativeIssueSchema = createAuthoritativeSchema(
  IssueTriageV1ModelOutputSchema,
  IssueTriageV1Schema,
);

export class ReviewJobExecutor implements JobExecutor {
  readonly #fileIO: ReviewFileIO;
  readonly #logger: Logger;

  public constructor(private readonly options: ReviewJobExecutorOptions) {
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
    this.#logger = options.logger ?? noOpLogger;
  }

  public async execute(
    envelope: JobExecutionEnvelope,
    context: JobExecutionContext,
  ): Promise<JobExecutionResult> {
    context.reportProgress({ phase: "preparing", processCount: 0 });
    let nodeHealthFaultReported = false;
    const reportNodeHealthFaultOnce = (error: Error): void => {
      if (nodeHealthFaultReported) return;
      nodeHealthFaultReported = true;
      context.reportNodeHealthFault(error);
    };
    try {
      context.signal.throwIfAborted();
      const authority = validateEnvelope(envelope);
      if (context.deferCleanup === undefined) {
        return failure(
          "CLEANUP_REGISTRATION_UNAVAILABLE",
          "The Worker cannot retain deferred workspace cleanup for this review.",
          false,
        );
      }

      let workspace: PreparedJobWorkspace | undefined;
      context.deferCleanup(
        createIdempotentCleanup(async () => {
          await workspace?.cleanup();
        }),
      );
      try {
        workspace = await this.options.workspaceProvider.prepare(envelope, {
          signal: context.signal,
          processHost: context.processHost,
          reportProcessCount: (processCount) => {
            context.reportProgress({ phase: "preparing", processCount });
          },
          reportNodeHealthFault: reportNodeHealthFaultOnce,
        });
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof JobWorkspaceError) {
          throw workspacePreparationError(error);
        }
        throw new ReviewExecutionError(
          "WORKSPACE_PREPARATION_FAILED",
          "The isolated review workspace could not be prepared.",
          true,
          { cause: error },
        );
      }
      context.signal.throwIfAborted();
      return await this.#executePrepared(
        envelope,
        authority,
        workspace,
        context,
        reportNodeHealthFaultOnce,
      );
    } catch (error) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? error;
      }
      return this.#toFailure(error, envelope);
    }
  }

  async #executePrepared(
    envelope: JobExecutionEnvelope,
    authority: AuthoritativeReviewSchema,
    workspace: PreparedJobWorkspace,
    context: JobExecutionContext,
    reportNodeHealthFault: (error: Error) => void,
  ): Promise<JobExecutionResult> {
    const schemaPath = win32.join(workspace.controlDirectory, schemaFileName);
    const resultPath = win32.join(workspace.controlDirectory, resultFileName);
    const configPath = win32.join(workspace.codexHomeDirectory, configFileName);
    const config = buildReviewCodexConfig(workspace.checkoutDirectory);

    try {
      await assertPathMissing(this.#fileIO, resultPath);
      await this.#fileIO.writeExclusiveUtf8(schemaPath, authority.json);
      await this.#fileIO.writeExclusiveUtf8(configPath, config);
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
    const hardTimeoutMs = Math.min(
      envelope.executionPolicy.hardTimeoutMs,
      this.options.maximumHardTimeoutMs,
    );
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

    let launchSpec: CodexProcessLaunchSpec;
    try {
      launchSpec = buildCodexExecLaunchSpec({
        executable: this.options.codexExecutablePath,
        workingDirectory: workspace.checkoutDirectory,
        processWorkingDirectory: workspace.controlDirectory,
        controlRootDirectory: workspace.controlDirectory,
        prompt: envelope.prompt.renderedPrompt,
        outputSchemaPath: schemaPath,
        outputLastMessagePath: resultPath,
        environment: {
          CODEX_HOME: workspace.codexHomeDirectory,
          COMSPEC: this.options.comSpec,
          PATH: this.options.path,
          PATHEXT: this.options.pathExt,
          SYSTEMROOT: this.options.systemRoot,
          TEMP: workspace.tempDirectory,
          TMP: workspace.tempDirectory,
          USERPROFILE: workspace.userProfileDirectory,
        },
        limits: {
          hardTimeoutMs,
          maximumProcessCount: this.options.maximumProcessCount,
          maximumMemoryBytes: this.options.maximumMemoryBytes,
          maximumOutputBytes: this.options.maximumOutputBytes,
        },
      });
    } catch (error) {
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

    let managed: ManagedProcess | undefined;
    let processStartError: unknown;
    try {
      managed = await context.processHost.start(launchSpec, diskMonitor.signal);
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

    context.reportProgress({ phase: "codex_review", processCount: 1 });
    const progressPulse = new CodexProgressPulse(
      context,
      envelope.executionPolicy.noProgressTimeoutMs,
    );
    let settled: Awaited<ReturnType<typeof settleCodexProcess>>;
    try {
      settled = await settleCodexProcess(managed, () => progressPulse.observeActivity());
    } finally {
      progressPulse.stop();
      context.reportProgress({ phase: "codex_review", processCount: 0 });
    }
    const diskError = await closeWorkspaceDiskMonitor(diskMonitor);
    context.signal.throwIfAborted();
    if (diskError !== undefined) {
      const failure = workspaceDiskExecutionError(diskError);
      if (isNodeDiskFailure(diskError)) reportNodeHealthFault(failure);
      throw failure;
    }

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
          return failure(error.code, error.message, error.retryable);
        }
        return failure(
          "RESULT_FILE_READ_FAILED",
          "The Codex result file could not be read because of a filesystem error.",
          true,
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
      return failure(
        `CODEX_${execution.code.toUpperCase()}`,
        codexFailureMessage(execution.code),
        execution.retryable,
      );
    }

    const businessError = validateBusinessResult(envelope, execution.result);
    if (businessError !== null) {
      return failure("RESULT_BUSINESS_VALIDATION_FAILED", businessError, false);
    }
    return {
      outcome: "succeeded",
      resultDigest: execution.resultDigest,
      result: execution.result,
    };
  }

  #toFailure(error: unknown, envelope: JobExecutionEnvelope): FailedJobExecution {
    if (error instanceof ReviewExecutionError) {
      return failure(error.code, error.message, error.retryable);
    }
    this.#logger.error("Review job failed unexpectedly.", {
      jobId: envelope.job.jobId,
      runAttemptId: envelope.lease.runAttemptId,
      errorName: errorName(error),
    });
    return failure(
      "REVIEW_EXECUTION_FAILED",
      "The review job failed because of an unexpected Worker error.",
      true,
    );
  }
}

export function buildReviewCodexConfig(checkoutDirectory: string): string {
  const projectPath = normalizeSafeProjectPath(checkoutDirectory);
  return [
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    "allow_login_shell = false",
    "check_for_update_on_startup = false",
    'web_search = "disabled"',
    "project_doc_max_bytes = 32768",
    'project_doc_fallback_filenames = ["AGENTS.md"]',
    'file_opener = "none"',
    'cli_auth_credentials_store = "keyring"',
    'mcp_oauth_credentials_store = "keyring"',
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    "[windows]",
    'sandbox = "elevated"',
    "",
    "[history]",
    'persistence = "none"',
    "",
    `[projects.${tomlBasicString(projectPath)}]`,
    'trust_level = "trusted"',
    "",
    "[features]",
    "apps = false",
    "hooks = false",
    "memories = false",
    "multi_agent = false",
    "remote_plugin = false",
    "skill_mcp_dependency_install = false",
    "",
    "[agents]",
    "enabled = false",
    "",
    "[apps._default]",
    "enabled = false",
    "destructive_enabled = false",
    "open_world_enabled = false",
    "",
    "[tools]",
    "web_search = false",
    "view_image = false",
    "",
  ].join("\n");
}

function createAuthoritativeSchema(
  modelOutputSchema: typeof PrReviewPlanV1ModelOutputSchema | typeof IssueTriageV1ModelOutputSchema,
  resultSchema: typeof PrReviewPlanV1Schema | typeof IssueTriageV1Schema,
): AuthoritativeReviewSchema {
  const serialized = JSON.stringify(modelOutputSchema);
  if (serialized === undefined) {
    throw new Error("The authoritative review schema could not be serialized.");
  }
  const snapshot = JSON.parse(serialized) as unknown;
  const canonical = createCanonicalResult(snapshot);
  return Object.freeze({ resultSchema, json: canonical.json, digest: canonical.sha256 });
}

function validateEnvelope(envelope: JobExecutionEnvelope): AuthoritativeReviewSchema {
  let authority: AuthoritativeReviewSchema;
  if (envelope.job.kind === "pull_request_review") {
    if (envelope.resource.kind !== "pull_request") {
      throw contractError("The PR review job does not target a pull request.");
    }
    authority = authoritativePrSchema;
  } else if (envelope.job.kind === "issue_triage") {
    if (envelope.resource.kind !== "issue") {
      throw contractError("The issue triage job does not target an issue.");
    }
    authority = authoritativeIssueSchema;
  } else {
    throw contractError("The job kind is not supported by the review executor.");
  }

  const promptDigest = createHash("sha256")
    .update(envelope.prompt.renderedPrompt, "utf8")
    .digest("hex");
  if (promptDigest !== envelope.prompt.promptSha256) {
    throw contractError("The rendered prompt digest does not match the job envelope.");
  }

  let suppliedSchema: ReturnType<typeof createCanonicalResult>;
  try {
    suppliedSchema = createCanonicalResult(envelope.prompt.outputSchema);
  } catch (error) {
    throw new ReviewExecutionError(
      "JOB_CONTRACT_INVALID",
      "The job output schema is not valid canonical JSON.",
      false,
      { cause: error },
    );
  }
  if (
    suppliedSchema.sha256 !== envelope.prompt.outputSchemaSha256 ||
    suppliedSchema.sha256 !== authority.digest ||
    suppliedSchema.json !== authority.json
  ) {
    throw contractError("The job output schema is not the authoritative schema for its job kind.");
  }
  return authority;
}

function contractError(message: string): ReviewExecutionError {
  return new ReviewExecutionError("JOB_CONTRACT_INVALID", message, false);
}

function workspacePreparationError(error: JobWorkspaceError): ReviewExecutionError {
  const permanentCodes = new Set([
    "INVALID_ENVELOPE",
    "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED",
    "GIT_LOCAL_OR_REVISION_FAILED",
    "GIT_REVISION_MISMATCH",
    "GIT_POLICY_LIMIT_EXCEEDED",
  ]);
  return new ReviewExecutionError(
    `WORKSPACE_${error.code}`,
    "The isolated review workspace could not be prepared.",
    !permanentCodes.has(error.code),
    { cause: error },
  );
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
    (error.code === "ABORTED" || error.code === "CURRENT_ATTEMPT_LIMIT_EXCEEDED")
  );
}

function isProcessHardTimeout(error: unknown): boolean {
  return error instanceof ProcessHostRequestError && error.code === "PROCESS_HARD_TIMEOUT";
}

/**
 * Keeps the lease alive while the Worker drains Codex. Timer pulses prove Worker liveness, not
 * model or child progress; the ProcessHost hard timeout remains the hang boundary.
 */
class CodexProgressPulse {
  readonly #intervalMs: number;
  readonly #activityThrottleMs: number;
  readonly #timer: NodeJS.Timeout;
  #lastReportAt = Date.now();
  #stopped = false;

  public constructor(
    private readonly context: JobExecutionContext,
    noProgressTimeoutMs: number,
  ) {
    this.#intervalMs = Math.min(30_000, Math.max(5_000, Math.floor(noProgressTimeoutMs / 3)));
    this.#activityThrottleMs = Math.min(5_000, this.#intervalMs);
    this.#timer = setInterval(() => this.#report(), this.#intervalMs);
    this.#timer.unref();
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
    clearInterval(this.#timer);
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
    drainStream(managed.stderr),
  ] as const);
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
      const parsed = parser.push(chunk);
      retain(parsed);
      if (parsed.length > 0) {
        reportActivity();
      }
    } else {
      throw new TypeError("Codex stdout emitted an unsupported chunk type.");
    }
  }
  const finalRecords = parser.finish();
  retain(finalRecords);
  if (finalRecords.length > 0) {
    reportActivity();
  }
  return { records, limitExceeded };
}

async function drainStream(stream: Readable): Promise<void> {
  for await (const _chunk of stream) {
    // Deliberately discard stderr while draining it to avoid backpressure and data disclosure.
  }
}

async function assertPathMissing(fileIO: ReviewFileIO, path: string): Promise<void> {
  try {
    await fileIO.lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new ReviewExecutionError(
    "RESULT_FILE_PREEXISTS",
    "The Codex result path existed before process launch.",
    false,
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

function validateBusinessResult(
  envelope: JobExecutionEnvelope,
  result: ReviewResultV1,
): string | null {
  const allowedRecipes = new Set(envelope.executionPolicy.allowedRecipeIds);
  if (result.requestedRecipeIds.some((recipeId) => !allowedRecipes.has(recipeId))) {
    return "The review requested a validation recipe outside the job allowlist.";
  }

  if (envelope.job.kind !== "pull_request_review") {
    return null;
  }
  const review = result as PrReviewPlanV1;
  const findingIds = new Set<string>();
  for (const finding of review.findings) {
    if (findingIds.has(finding.findingId)) {
      return "The PR review contains duplicate finding identifiers.";
    }
    findingIds.add(finding.findingId);
    if (finding.endLine !== null && finding.endLine < finding.line) {
      return "The PR review contains a finding whose end line precedes its start line.";
    }
    if (!isNormalizedRepositoryRelativePath(finding.path)) {
      return "The PR review contains a finding path that is not a normalized repository-relative path.";
    }
    // TODO: Revalidate each finding location against the immutable PR diff before publication.
  }
  return null;
}

function isNormalizedRepositoryRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes(":") ||
    path.startsWith("/") ||
    win32.isAbsolute(path)
  ) {
    return false;
  }
  const normalized = win32.normalize(path).replaceAll("\\", "/");
  return (
    normalized === path &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
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

function normalizeSafeProjectPath(value: string): string {
  assertWellFormedUnicode(value, "checkoutDirectory");
  if (!/^[A-Za-z]:[\\/]/u.test(value) || value.slice(2).includes(":")) {
    throw new TypeError("checkoutDirectory must be an absolute local Windows path");
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
      throw new TypeError("checkoutDirectory contains an unsafe Windows path component");
    }
  }
  const normalized = win32.normalize(value.replaceAll("/", "\\"));
  return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`.replace(/[\\]+$/u, "");
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

function createIdempotentCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined;
  return () => {
    cleanupPromise ??= Promise.resolve().then(cleanup);
    return cleanupPromise;
  };
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
