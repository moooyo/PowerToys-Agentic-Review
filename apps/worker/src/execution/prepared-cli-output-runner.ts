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
  buildCliLaunchSpec,
  type CliProcessLaunchSpec,
  CodexJsonlParser,
  type CodexJsonlRecord,
  cliProcessResourceLimitBounds,
  collectCommandEvidence,
  createCanonicalResult,
  determineCodexExecutionResult,
  redactExecutionText,
} from "@agentic-review/codex";
import type { ReviewExecutionEvidence, RunFailureDiagnostics } from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Logger } from "../logging/logger.js";
import type { JobExecutionContext, JobExecutionResult } from "./job-executor.js";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import { ProcessHostRequestError } from "./process-host-client.js";
import { type ManagedProcess, ProcessExitedEventSchema } from "./process-host-protocol.js";
import { WorkspaceDiskBudgetError, type WorkspaceDiskMonitor } from "./workspace-disk-budget.js";

const maximumRetainedRecordCount = 4_096;
const maximumRetainedRecordCharacters = 8 * 1024 * 1024;
const maximumJsonlLineCharacters = 1_048_576;
const maximumResultFileBytes = 2 * 1024 * 1024;
const maximumCopilotEvents = 32_768;
const maximumCopilotEventCharacters = 6 * maximumResultFileBytes + 65_536;

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
export interface PreparedCliOutputRunnerOptions {
  readonly engine: "codex" | "copilot";
  readonly cliExecutablePath: string;
  readonly cliVersion: string;
  readonly cliEnvironment?: Readonly<Record<string, string>>;
  readonly cliHomeDirectory?: string;
  readonly model?: string;
  readonly userProfileDirectory: string;
  readonly appDataDirectory?: string;
  readonly localAppDataDirectory?: string;
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
type FailedJobExecution = Extract<JobExecutionResult, { readonly outcome: "failed" }>;
interface CollectedCliRecords {
  readonly records: readonly CodexJsonlRecord[];
  readonly limitExceeded: boolean;
}
export class ReviewExecutionError extends Error {
  constructor(
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
  writeExclusiveUtf8: async (path, content) =>
    nodeWriteFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  lstat: async (path) => nodeLstat(path, { bigint: true }),
  realpath: nodeRealpath,
  openRead: async (path) => {
    const handle = await nodeOpen(path, "r");
    return {
      stat: async () => handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) => ({
        bytesRead: (await handle.read(buffer, offset, length, position)).bytesRead,
      }),
      close: async () => handle.close(),
    };
  },
};
export interface PreparedCliOutputInput<TOutputSchema extends TSchema> {
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
}
export interface CliExecutionObservation {
  readonly engine: "codex" | "copilot";
  readonly cliVersion: string;
  readonly requestedModel: string | null;
  readonly processRequestId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly promptSha256: string;
  readonly actualPromptSha256: string;
  readonly outputSchemaSha256: string;
  readonly modelOutputSha256: string;
}
export type PreparedCliOutputResult<TResult> =
  | FailedJobExecution
  | {
      readonly outcome: "succeeded";
      readonly result: TResult;
      readonly resultDigest: string;
      readonly canonicalResultJson: string;
      readonly commandEvidence: Pick<ReviewExecutionEvidence, "commands" | "commandCapture">;
      readonly observedFileChange: boolean;
      readonly cliExecution: CliExecutionObservation;
    };

/** Runs an installed CLI using its own account and configuration inside the Worker VM. */
export class PreparedCliOutputRunner {
  readonly #fileIO: ReviewFileIO;
  constructor(private readonly options: PreparedCliOutputRunnerOptions) {
    this.options = Object.freeze({
      ...options,
      ...(options.cliEnvironment === undefined
        ? {}
        : { cliEnvironment: Object.freeze({ ...options.cliEnvironment }) }),
    });
    for (const [name, bounds] of Object.entries(cliProcessResourceLimitBounds)) {
      const key = name === "hardTimeoutMs" ? "maximumHardTimeoutMs" : name;
      assertConfiguredLimit(options[key as "maximumHardTimeoutMs"], key, bounds);
    }
    if (options.engine !== "codex" && options.engine !== "copilot")
      throw new TypeError("Unsupported CLI engine.");
    if (!options.cliVersion || options.cliVersion.length > 128)
      throw new TypeError("The CLI version is invalid.");
    this.#fileIO = options.fileIO ?? defaultFileIO;
  }
  async run<TOutputSchema extends TSchema>(
    suppliedInput: PreparedCliOutputInput<TOutputSchema>,
  ): Promise<PreparedCliOutputResult<Static<TOutputSchema>>> {
    const input = {
      ...suppliedInput,
      authoritativeSchema: {
        ...suppliedInput.authoritativeSchema,
        resultSchema: Value.Clone(suppliedInput.authoritativeSchema.resultSchema),
      },
      sensitiveValues: [...(suppliedInput.sensitiveValues ?? [])],
    };
    const { workspace, context, authoritativeSchema: authority } = input;
    context.signal.throwIfAborted();
    if (
      (input.launchPolicy !== "review" && input.launchPolicy !== "summary_read_only") ||
      createHash("sha256").update(authority.json, "utf8").digest("hex") !== authority.digest
    )
      throw new ReviewExecutionError(
        "CLI_LAUNCH_SPEC_INVALID",
        "The prepared CLI policy or schema digest is invalid.",
        false,
      );
    const reportNodeHealthFault =
      input.reportNodeHealthFault ?? ((error: Error) => context.reportNodeHealthFault(error));
    const protectedValues = [
      ...new Set(
        [
          ...(input.sensitiveValues ?? []),
          ...Object.entries(this.options.cliEnvironment ?? {})
            .filter(([name]) =>
              /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL)/iu.test(
                name,
              ),
            )
            .map(([, value]) => value),
        ].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
      ),
    ];
    const redact = (text: string) => redactExecutionText(text, protectedValues);
    const schemaPath = win32.join(workspace.controlDirectory, "schema.json");
    const resultPath = win32.join(workspace.controlDirectory, "result.json");
    try {
      await assertPathMissing(this.#fileIO, resultPath);
      await this.#fileIO.writeExclusiveUtf8(schemaPath, authority.json);
    } catch (error) {
      if (error instanceof ReviewExecutionError) throw error;
      const fault = new ReviewExecutionError(
        "CONTROL_FILE_WRITE_FAILED",
        "The CLI control files could not be created.",
        true,
        { cause: error },
      );
      reportNodeHealthFault(fault);
      throw fault;
    }
    const hardTimeoutMs = Math.min(input.hardTimeoutMs, this.options.maximumHardTimeoutMs);
    let launchSpec: CliProcessLaunchSpec;
    try {
      launchSpec = buildCliLaunchSpec({
        engine: this.options.engine,
        executable: this.options.cliExecutablePath,
        workingDirectory: workspace.checkoutDirectory,
        controlRootDirectory: workspace.controlDirectory,
        prompt: input.prompt,
        outputSchemaPath: schemaPath,
        outputSchemaJson: authority.json,
        outputLastMessagePath: resultPath,
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        environment: {
          ...this.options.cliEnvironment,
          COMSPEC: this.options.comSpec,
          PATH: this.options.path,
          PATHEXT: this.options.pathExt,
          SYSTEMROOT: this.options.systemRoot,
          TEMP: workspace.tempDirectory,
          TMP: workspace.tempDirectory,
          USERPROFILE: this.options.userProfileDirectory,
          ...(this.options.appDataDirectory === undefined
            ? {}
            : { APPDATA: this.options.appDataDirectory }),
          ...(this.options.localAppDataDirectory === undefined
            ? {}
            : { LOCALAPPDATA: this.options.localAppDataDirectory }),
          ...(this.options.cliHomeDirectory === undefined
            ? {}
            : {
                [this.options.engine === "codex" ? "CODEX_HOME" : "COPILOT_HOME"]:
                  this.options.cliHomeDirectory,
              }),
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
        "CLI_LAUNCH_SPEC_INVALID",
        "The CLI launch specification is invalid.",
        false,
        { cause: error },
      );
    }
    context.reportProgress({ phase: "cli_review", processCount: 0 });
    let diskMonitor: WorkspaceDiskMonitor;
    try {
      diskMonitor = await workspace.startDiskMonitoring(context.signal);
    } catch (error) {
      context.signal.throwIfAborted();
      const fault = workspaceDiskExecutionError(error);
      if (isNodeDiskFailure(error)) reportNodeHealthFault(fault);
      throw fault;
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
            "CLI_PROGRESS_REPORT_FAILED",
            "The CLI progress observer failed; process cleanup was requested.",
            true,
          );
          observerFailure.abort();
        }
      },
    };
    let managed: ManagedProcess | undefined;
    const startedAt = new Date().toISOString();
    let startError: unknown;
    try {
      processSignal.throwIfAborted();
      // The runner owns cancellation after dispatch. Aborting the client's lifetime signal
      // replaces its observed exit with a rejection, even after the process has drained.
      // Start acknowledgement remains bounded by ProcessHost; an in-flight cancellation
      // terminates the owned handle as soon as it arrives below.
      managed = await context.processHost.start(launchSpec, new AbortController().signal);
    } catch (error) {
      startError = error;
    }
    if (managed === undefined) {
      const diskError = await closeWorkspaceDiskMonitor(diskMonitor);
      context.signal.throwIfAborted();
      if (diskError !== undefined) {
        const fault = workspaceDiskExecutionError(diskError);
        if (isNodeDiskFailure(diskError)) reportNodeHealthFault(fault);
        throw fault;
      }
      const fault = new ReviewExecutionError(
        "CLI_PROCESS_START_FAILED",
        "The configured CLI process could not be started.",
        true,
        { cause: startError },
      );
      reportNodeHealthFault(fault);
      throw fault;
    }
    const progressPulse = new CliProgressPulse(progressContext, input.noProgressTimeoutMs);
    const output: CopilotOutput = { text: "", exceeded: false, failure: null };
    const settlement = Promise.allSettled([
      managed.completed,
      this.options.engine === "codex"
        ? collectCliRecords(managed.stdout, () => progressPulse.observeActivity())
        : collectCopilotOutput(
            managed.stdout,
            output,
            () => progressPulse.observeActivity(),
            this.options.maximumOutputBytes,
            (diagnostic) =>
              this.options.logger?.warn("Copilot JSONL parser rejected an event.", {
                correlationId: input.correlationId,
                ...diagnostic,
              }),
          ),
      drainStream(managed.stderr, () => progressPulse.observeActivity()),
    ] as const);
    let settled: Awaited<typeof settlement> | undefined;
    let settlementError: unknown;
    let diskError: unknown;
    try {
      progressContext.reportProgress({ phase: "cli_review", processCount: 1 });
      settled = await settleSummaryProcess(
        managed,
        settlement,
        processSignal,
        input.teardownTimeoutMs ?? 5_000,
      );
    } catch (error) {
      settlementError = error;
    } finally {
      progressPulse.stop();
      progressContext.reportProgress({ phase: "cli_review", processCount: 0 });
      diskError = await closeWorkspaceDiskMonitor(diskMonitor);
    }
    if (settlementError !== undefined) {
      reportNodeHealthFault(
        settlementError instanceof Error ? settlementError : new Error("CLI cleanup failed."),
      );
      throw settlementError;
    }
    if (progressError !== undefined) throw progressError;
    context.signal.throwIfAborted();
    if (diskError !== undefined) {
      const fault = workspaceDiskExecutionError(diskError);
      if (isNodeDiskFailure(diskError)) reportNodeHealthFault(fault);
      throw fault;
    }
    if (settled === undefined)
      throw new ReviewExecutionError(
        "CLI_PROCESS_DRAIN_UNCONFIRMED",
        "CLI process settlement could not be observed.",
        true,
      );
    const [completed, stdout, stderr] = settled;
    if (completed.status === "rejected") {
      const fault = new ReviewExecutionError(
        "CLI_PROCESS_FAILED",
        "The managed CLI did not produce a completion event.",
        true,
        { cause: completed.reason },
      );
      if (!isProcessHardTimeout(completed.reason)) reportNodeHealthFault(fault);
      throw fault;
    }
    if (stdout.status === "rejected" || stderr.status === "rejected") {
      const fault = new ReviewExecutionError(
        "CLI_STREAM_FAILED",
        "A CLI output stream ended unexpectedly.",
        true,
      );
      reportNodeHealthFault(fault);
      throw fault;
    }
    if (stdout.value.limitExceeded || output.exceeded)
      return failure(
        "CLI_OUTPUT_LIMIT_EXCEEDED",
        "CLI output exceeded the configured capture limit.",
        false,
      );
    const exit = completed.value;
    if (!Value.Check(ProcessExitedEventSchema, exit) || exit.requestId !== managed.requestId)
      throw new ReviewExecutionError(
        "CLI_PROCESS_FAILED",
        "The CLI completion event does not match its owned process.",
        true,
      );
    let lastMessage: string | null = null;
    if (exit.exitCode === 0 && exit.signal === null && !exit.outputTruncated) {
      if (this.options.engine === "copilot") lastMessage = output.text;
      else
        try {
          lastMessage = await readStableResultFile(
            this.#fileIO,
            workspace.controlDirectory,
            resultPath,
            Math.min(maximumResultFileBytes, this.options.maximumOutputBytes),
          );
        } catch (error) {
          if (error instanceof ReviewExecutionError) throw error;
          throw new ReviewExecutionError(
            "RESULT_FILE_READ_FAILED",
            "The CLI result file could not be read.",
            true,
            { cause: error },
          );
        }
    }
    const execution =
      this.options.engine === "codex"
        ? determineCodexExecutionResult(
            { processExit: exit, records: stdout.value.records, lastMessage },
            authority.resultSchema,
          )
        : determineCopilotExecutionResult(exit, output, authority.resultSchema);
    if (!execution.ok) {
      const failed = failure(
        `CLI_${execution.code.toUpperCase()}`,
        redact(execution.message),
        execution.retryable,
      );
      return {
        ...failed,
        diagnostics: {
          category: failureCategory(failed.code),
          exitCode: exit.exitCode,
          summary: redact(
            `${execution.message}${stderr.value.length === 0 ? "" : `; stderr: ${stderr.value}`}`,
          ),
          correlationId: input.correlationId,
        },
      };
    }
    if (containsProtectedValue(execution.result, protectedValues))
      return failure("CLI_RESULT_UNSAFE", "The model result contains protected values.", false);
    return {
      outcome: "succeeded",
      result: execution.result,
      resultDigest: execution.resultDigest,
      canonicalResultJson: execution.canonicalResultJson,
      commandEvidence:
        this.options.engine === "codex"
          ? collectCommandEvidence(stdout.value.records, redact)
          : { commands: [], commandCapture: "incomplete" },
      observedFileChange: stdout.value.records.some(
        (record) =>
          record.kind === "event" &&
          typeof record.value.item === "object" &&
          record.value.item !== null &&
          (record.value.item as Record<string, unknown>).type === "file_change",
      ),
      cliExecution: {
        engine: this.options.engine,
        cliVersion: this.options.cliVersion,
        requestedModel: this.options.model ?? null,
        processRequestId: managed.requestId,
        startedAt,
        completedAt: new Date().toISOString(),
        promptSha256: createHash("sha256").update(input.prompt, "utf8").digest("hex"),
        actualPromptSha256: createHash("sha256")
          .update(launchSpec.standardInput, "utf8")
          .digest("hex"),
        outputSchemaSha256: authority.digest,
        modelOutputSha256: execution.resultDigest,
      },
    };
  }
}

type CopilotOutputFailure =
  | "invalid_event_stream"
  | "incomplete_event_stream"
  | "multiple_results"
  | "copilot_reported_error";
interface CopilotOutput {
  text: string;
  exceeded: boolean;
  failure: CopilotOutputFailure | null;
}

type CopilotDiagnosticReason =
  | "json_syntax"
  | "event_shape"
  | "type_shape"
  | "after_result"
  | "duplicate_result"
  | "exit_code_shape"
  | "terminal_error"
  | "missing_root_message"
  | "pending_tool_request"
  | "data_shape"
  | "attribution_shape"
  | "content_shape"
  | "tool_requests_shape"
  | "utf8"
  | "missing_result_marker";
const copilotDiagnosticEventTypes = [
  "result",
  "assistant.message",
  "assistant.turn_start",
  "assistant.message_start",
  "abort",
  "assistant.message_delta",
  "assistant.reasoning",
  "assistant.reasoning_delta",
  "assistant.turn_end",
  "assistant.idle",
  "tool.execution_start",
  "tool.execution_complete",
  "session.error",
  "session.warning",
  "session.start",
  "session.resume",
  "session.title_changed",
  "session.shutdown",
] as const;
interface CopilotParserDiagnostic {
  readonly reason: CopilotDiagnosticReason;
  readonly eventIndex: number;
  readonly eventType: (typeof copilotDiagnosticEventTypes)[number] | "other" | "unparsed";
}
/** Copilot's separate result marker closes the root response, not the session event stream. */
async function collectCopilotOutput(
  stream: Readable,
  output: CopilotOutput,
  activity: () => void,
  maximumBytes: number,
  diagnose: (diagnostic: CopilotParserDiagnostic) => void,
): Promise<CollectedCliRecords> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    totalBytes = 0,
    eventCount = 0,
    resultCount = 0;
  let hasRootMessage = false,
    pendingToolRequest = false;
  let diagnosticEventType: CopilotParserDiagnostic["eventType"] = "unparsed";
  const fail = (
    code: CopilotOutputFailure,
    reason: CopilotDiagnosticReason,
    eventIndex = Math.max(1, eventCount),
  ): void => {
    if (output.failure !== null) return;
    output.failure = code;
    try {
      diagnose({ reason, eventIndex, eventType: diagnosticEventType });
    } catch {
      /* Diagnostics do not change the output decision. */
    }
  };
  const accept = (line: string): void => {
    if (!line.trim()) return;
    if (++eventCount > maximumCopilotEvents) {
      output.exceeded = true;
      return;
    }
    diagnosticEventType = "unparsed";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail("invalid_event_stream", "json_syntax");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("invalid_event_stream", "event_shape");
      return;
    }
    const event = parsed as Record<string, unknown>;
    if (typeof event.type !== "string" || event.type.length === 0) {
      fail("invalid_event_stream", "type_shape");
      return;
    }
    diagnosticEventType =
      copilotDiagnosticEventTypes.find((type) => type === event.type) ?? "other";
    if (event.type === "result") {
      if (resultCount !== 0) {
        fail("multiple_results", "duplicate_result");
        return;
      }
      resultCount++;
      if (typeof event.exitCode !== "number" || !Number.isInteger(event.exitCode)) {
        fail("invalid_event_stream", "exit_code_shape");
        return;
      }
      if (event.exitCode !== 0) fail("copilot_reported_error", "terminal_error");
      else if (!hasRootMessage) fail("incomplete_event_stream", "missing_root_message");
      else if (pendingToolRequest) fail("incomplete_event_stream", "pending_tool_request");
      return;
    }
    if (
      !["assistant.message", "assistant.turn_start", "assistant.message_start", "abort"].includes(
        event.type,
      )
    )
      return;
    if (event.data === null || typeof event.data !== "object" || Array.isArray(event.data)) {
      fail("invalid_event_stream", "data_shape");
      return;
    }
    const data = event.data as Record<string, unknown>;
    // Subagent messages cannot replace the root assistant's final response. The second
    // identifier is the CLI's deprecated subagent attribution field.
    const agent = event.agentId ?? data.parentToolCallId;
    if (agent !== undefined && agent !== null) {
      if (typeof agent !== "string" || agent.length === 0)
        fail("invalid_event_stream", "attribution_shape");
      return;
    }
    if (resultCount !== 0) {
      // Late metadata, usage, tool, and subagent events cannot replace the closed
      // response. A new root response or turn contradicts the terminal marker.
      fail("invalid_event_stream", "after_result");
      return;
    }
    if (event.type !== "assistant.message") {
      hasRootMessage = false;
      pendingToolRequest = false;
      output.text = "";
      return;
    }
    if (typeof data.content !== "string") {
      fail("invalid_event_stream", "content_shape");
      return;
    }
    if (data.toolRequests !== undefined && !Array.isArray(data.toolRequests)) {
      fail("invalid_event_stream", "tool_requests_shape");
      return;
    }
    if (Buffer.byteLength(data.content, "utf8") > maximumResultFileBytes) {
      output.exceeded = true;
      return;
    }
    hasRootMessage = true;
    pendingToolRequest = Array.isArray(data.toolRequests) && data.toolRequests.length > 0;
    // Full root messages may contain intermediate commentary. Keep the last one, and
    // never fall back to an earlier JSON-looking response if the final one is invalid.
    output.text = data.content;
  };
  const consume = (text: string): void => {
    buffer += text;
    let newline = buffer.indexOf("\n");
    while (newline !== -1 && !output.exceeded && output.failure === null) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > maximumCopilotEventCharacters) {
        output.exceeded = true;
        break;
      }
      accept(line);
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > maximumCopilotEventCharacters) output.exceeded = true;
    if (output.exceeded || output.failure !== null) buffer = "";
  };
  for await (const value of stream) {
    const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    if (chunk.length > 0) activity();
    totalBytes += chunk.byteLength;
    if (totalBytes > maximumBytes) output.exceeded = true;
    if (output.exceeded || output.failure !== null) continue;
    try {
      consume(decoder.decode(chunk, { stream: true }));
    } catch {
      diagnosticEventType = "unparsed";
      fail("invalid_event_stream", "utf8", eventCount + 1);
      buffer = "";
    }
  }
  if (!output.exceeded && output.failure === null) {
    try {
      consume(decoder.decode());
    } catch {
      diagnosticEventType = "unparsed";
      fail("invalid_event_stream", "utf8", eventCount + 1);
    }
    if (buffer.length > 0 && output.failure === null) accept(buffer);
    if (resultCount === 0) {
      diagnosticEventType = "unparsed";
      fail("incomplete_event_stream", "missing_result_marker", eventCount + 1);
    }
  }
  return { records: [], limitExceeded: output.exceeded };
}
function determineCopilotExecutionResult<T extends TSchema>(
  exit: { exitCode: number | null; signal: string | null; outputTruncated: boolean },
  output: CopilotOutput,
  schema: T,
) {
  const failed = (code: string, message: string, retryable = false) => ({
    ok: false as const,
    code,
    message,
    retryable,
  });
  if (exit.outputTruncated) return failed("output_truncated", "CLI output was truncated.");
  if (exit.signal !== null || exit.exitCode === null)
    return failed("process_terminated", "The CLI process was terminated.", true);
  if (exit.exitCode !== 0)
    return failed("non_zero_exit", `The CLI exited with code ${exit.exitCode}.`, true);
  if (output.failure !== null) {
    const messages: Record<CopilotOutputFailure, string> = {
      invalid_event_stream: "Copilot emitted an invalid JSONL event stream.",
      incomplete_event_stream: "Copilot did not close a complete root assistant response.",
      multiple_results: "Copilot emitted more than one terminal result marker.",
      copilot_reported_error: "Copilot reported an unsuccessful terminal result.",
    };
    return failed(output.failure, messages[output.failure]);
  }
  if (!output.text.trim())
    return failed("missing_result", "The CLI did not emit a final result.", true);
  let result: unknown;
  try {
    result = JSON.parse(output.text);
  } catch {
    return failed("invalid_result_json", "The CLI final response is not JSON.");
  }
  if (!Value.Check(schema, result))
    return failed("invalid_result_schema", "The CLI result does not match the output schema.");
  try {
    const canonical = createCanonicalResult(result);
    return {
      ok: true as const,
      result,
      resultDigest: canonical.sha256,
      canonicalResultJson: canonical.json,
    };
  } catch {
    return failed("invalid_result_json", "The CLI final response is not valid canonical JSON.");
  }
}
function containsProtectedValue(value: unknown, secrets: readonly string[]): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) pending.push(key, child);
    } else if (secrets.some((secret) => secret.length > 0 && String(current).includes(secret)))
      return true;
  }
  return false;
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
      "Workspace disk monitoring failed unexpectedly during Cli execution.",
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
    "Workspace disk or node infrastructure became unavailable during Cli execution.",
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
 * Reports throttled progress only when Cli emits stdout or stderr activity.
 * Silent runs must age out under the Server no-progress deadline.
 */
class CliProgressPulse {
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
    this.context.reportProgress({ phase: "cli_review", processCount: 1 });
    this.#lastReportAt = Date.now();
  }
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
    throw new TypeError("Invalid Cli teardown budget.");
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
                  "CLI_PROCESS_DRAIN_UNCONFIRMED",
                  "Cli termination and output draining could not be confirmed.",
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
          "CLI_PROCESS_DRAIN_UNCONFIRMED",
          "Cli termination and output draining could not be confirmed.",
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

async function collectCliRecords(
  stdout: Readable,
  reportActivity: () => void,
): Promise<CollectedCliRecords> {
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
      throw new TypeError("Cli stdout emitted an unsupported chunk type.");
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
      "The Cli result path existed before process launch.",
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
    throw resultFileError("The Cli result path resolves through a reparse point.");
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
      throw resultFileError("The Cli result file exceeds its size limit.");
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
      throw resultFileError("The Cli result file changed while it was being read.");
    }
    const realResultAfter = normalizeWindowsPath(await fileIO.realpath(resultPath));
    if (!windowsPathsEqual(realResult, realResultAfter)) {
      throw resultFileError("The Cli result path changed while it was being read.");
    }

    try {
      decodedResult = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, totalBytes),
      );
    } catch (error) {
      throw new ReviewExecutionError(
        "RESULT_FILE_INVALID",
        "The Cli result file is not valid UTF-8.",
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
    throw resultFileError("The Cli result file did not produce readable content.");
  }
  return decodedResult;
}

function assertRegularStableFile(stat: ReviewFileStat, maximumBytes: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw resultFileError("The Cli result path is not a regular file.");
  }
  if (stat.dev < 0n || stat.ino < 0n || stat.size < 0n || stat.size > BigInt(maximumBytes)) {
    throw resultFileError("The Cli result file exceeds its size limit.");
  }
}

function assertSameFile(first: ReviewFileStat, second: ReviewFileStat): void {
  if (first.dev !== second.dev || first.ino !== second.ino) {
    throw resultFileError("The Cli result file changed identity while it was being read.");
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
    throw resultFileError("The Cli result path is outside its control directory.");
  }
}

function normalizeWindowsPath(path: string): string {
  return win32.normalize(path).replace(/[\\/]+$/u, "");
}

function windowsPathsEqual(first: string, second: string): boolean {
  return normalizeWindowsPath(first).toLowerCase() === normalizeWindowsPath(second).toLowerCase();
}

export function failureCategory(code: string): RunFailureDiagnostics["category"] {
  if (code.startsWith("WORKSPACE_") || code.startsWith("CONTROL_FILE_")) return "workspace";
  if (code.includes("LAUNCH") || code.includes("PROCESS_START")) return "launch";
  if (code.includes("RESULT") || code === "JOB_CONTRACT_INVALID") return "result";
  if (code.includes("EVENT") || code.includes("STREAM")) return "event_stream";
  if (code.startsWith("CLI_")) return "process";
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
