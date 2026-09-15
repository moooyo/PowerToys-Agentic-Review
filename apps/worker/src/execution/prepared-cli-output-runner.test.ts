import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { createCanonicalResult } from "@agentic-review/codex";
import { type TSchema, Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionContext } from "./job-executor.js";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import {
  type PreparedCliOutputInput,
  PreparedCliOutputRunner,
  type PreparedCliOutputRunnerOptions,
  type ReviewFileIO,
  type ReviewFileStat,
} from "./prepared-cli-output-runner.js";
import { ProcessHostRequestError, StdioProcessHostClient } from "./process-host-client.js";
import {
  type ManagedProcess,
  type ProcessHostRequest,
  type ProcessLaunchSpec,
  processHostMaximumFrameBytes,
  processHostProtocolVersion,
} from "./process-host-protocol.js";

const schema = Type.Object(
  { message: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function copilotLines(...events: unknown[]): string[] {
  return events.map((event) => `${JSON.stringify(event)}\n`);
}
const copilotFinal = (content: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant.message",
  data: { messageId: "root-message", content, ...extra },
});
const copilotResult = (exitCode = 0) => ({
  type: "result",
  timestamp: "2026-09-10T00:00:00.000Z",
  sessionId: "fixture-session",
  exitCode,
  usage: {},
});
const diagnosticLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
function fixture(
  options: {
    engine?: "codex" | "copilot";
    result?: string;
    stderr?: string;
    stdout?: readonly (string | Buffer)[];
    exitCode?: number;
    fileChange?: boolean;
    sensitiveValues?: readonly string[];
    outputSchema?: TSchema;
    settings?: Partial<PreparedCliOutputRunnerOptions>;
  } = {},
) {
  const root = "C:\\Worker\\model-attempt";
  const files = new Map<string, Buffer>();
  const outputSchema = options.outputSchema ?? schema;
  const canonicalSchema = createCanonicalResult(JSON.parse(JSON.stringify(outputSchema)));
  const close = vi.fn(async () => undefined);
  const stat = (path: string): ReviewFileStat => {
    const bytes = files.get(path);
    if (bytes === undefined)
      throw Object.assign(new Error("Missing fixture file"), { code: "ENOENT" });
    return {
      dev: 1n,
      ino: 2n,
      size: BigInt(bytes.length),
      mtimeMs: 1n,
      ctimeMs: 1n,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
  };
  const fileIO: ReviewFileIO = {
    writeExclusiveUtf8: vi.fn(async (path, value) => {
      if (files.has(path)) throw new Error("Preexisting fixture file");
      files.set(path, Buffer.from(value));
    }),
    lstat: vi.fn(async (path) => stat(path)),
    realpath: vi.fn(async (path) => path),
    openRead: vi.fn(async (path) => ({
      stat: async () => stat(path),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytes = files.get(path) as Buffer;
        const bytesRead = Math.max(0, Math.min(length, bytes.length - position));
        bytes.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      close,
    })),
  };
  const monitorClose = vi.fn(async () => undefined);
  const workspace: PreparedJobWorkspace = {
    attemptDirectory: root,
    checkoutDirectory: `${root}\\checkout`,
    controlDirectory: `${root}\\control`,
    tempDirectory: `${root}\\temp`,
    userProfileDirectory: `${root}\\user`,
    startDiskMonitoring: async (signal) => ({
      signal,
      violation: undefined,
      close: monitorClose,
    }),
    cleanup: vi.fn(async () => undefined),
  };
  const engine = options.engine ?? "codex";
  const start = vi.fn(async (_spec: ProcessLaunchSpec) => {
    const result = options.result ?? '{"message":"Typed summary"}';
    if (engine === "codex")
      files.set(win32.join(workspace.controlDirectory, "result.json"), Buffer.from(result));
    const events = [
      { type: "thread.started", thread_id: "fixture-thread" },
      { type: "turn.started" },
      ...(options.fileChange
        ? [
            {
              type: "item.completed",
              item: {
                id: "file-change",
                type: "file_change",
                status: "completed",
                changes: [{ path: "file.ts", kind: "update" }],
              },
            },
          ]
        : []),
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];
    return {
      requestId: "request",
      processId: 1,
      stdout: Readable.from(
        options.stdout ??
          (engine === "codex"
            ? events.map((event) => `${JSON.stringify(event)}\n`)
            : copilotLines(copilotFinal(result), copilotResult())),
      ),
      stderr: Readable.from([options.stderr ?? ""]),
      completed: Promise.resolve({
        protocolVersion: processHostProtocolVersion,
        type: "exited",
        requestId: "request",
        exitCode: options.exitCode ?? 0,
        signal: null,
        outputTruncated: false,
      }),
      terminate: vi.fn(async () => undefined),
    } as unknown as ManagedProcess;
  });
  const context = {
    signal: new AbortController().signal,
    processHost: { start, close: vi.fn(), terminateAll: vi.fn() },
    reportProgress: vi.fn(),
    reportNodeHealthFault: vi.fn(),
  } as unknown as JobExecutionContext;
  const settings: PreparedCliOutputRunnerOptions = {
    engine,
    cliExecutablePath: `C:\\Trusted\\${engine}.exe`,
    cliVersion: "1.2.3",
    userProfileDirectory: "C:\\Users\\WorkerAccount",
    appDataDirectory: "C:\\Users\\WorkerAccount\\AppData\\Roaming",
    localAppDataDirectory: "C:\\Users\\WorkerAccount\\AppData\\Local",
    systemRoot: "C:\\Windows",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    path: "C:\\Windows\\System32",
    pathExt: ".EXE;.CMD",
    maximumHardTimeoutMs: 60_000,
    maximumProcessCount: 8,
    maximumMemoryBytes: 512 * 1_024 ** 2,
    maximumOutputBytes: 4 * 1_024 ** 2,
    fileIO,
    ...options.settings,
  };
  const runner = new PreparedCliOutputRunner(settings);
  const input: PreparedCliOutputInput<TSchema> = {
    workspace,
    context,
    authoritativeSchema: {
      json: canonicalSchema.json,
      digest: canonicalSchema.sha256,
      resultSchema: outputSchema,
    },
    prompt: "Produce a typed summary.",
    hardTimeoutMs: 60_000,
    noProgressTimeoutMs: 30_000,
    correlationId: "attempt",
    launchPolicy: "summary_read_only",
    sensitiveValues: options.sensitiveValues ?? ["secret-lease-token"],
  };
  return { runner, input, context, start, files, close, fileIO, monitorClose, settings };
}

describe("PreparedCliOutputRunner", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["codex", "copilot"] as const)(
    "uses the installed %s account and configuration without a project provider",
    async (engine) => {
      const f = fixture({ engine });
      const result = await f.runner.run(f.input);
      expect(result).toMatchObject({
        outcome: "succeeded",
        result: { message: "Typed summary" },
        cliExecution: { engine, cliVersion: "1.2.3", requestedModel: null },
      });
      const launch = f.start.mock.calls[0]?.[0];
      expect(launch?.environment).toEqual({
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32",
        PATHEXT: ".EXE;.CMD",
        SYSTEMROOT: "C:\\Windows",
        TEMP: f.input.workspace.tempDirectory,
        TMP: f.input.workspace.tempDirectory,
        USERPROFILE: "C:\\Users\\WorkerAccount",
        APPDATA: "C:\\Users\\WorkerAccount\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\WorkerAccount\\AppData\\Local",
      });
      expect(launch?.executable).toBe(`C:\\Trusted\\${engine}.exe`);
      expect(launch?.workingDirectory).toBe(f.input.workspace.controlDirectory);
      const directoryArgument = engine === "codex" ? "--cd" : "-C";
      expect(launch?.arguments[launch.arguments.indexOf(directoryArgument) + 1]).toBe(
        f.input.workspace.checkoutDirectory,
      );
      expect(launch?.arguments).not.toContain("--model");
      expect(f.monitorClose).toHaveBeenCalledOnce();
    },
  );

  it.each(["codex", "copilot"] as const)(
    "records observed %s lifecycle metadata and effective limits without CLI content",
    async (engine) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
      const logger = diagnosticLogger();
      const f = fixture({
        engine,
        ...(engine === "copilot"
          ? {
              stdout: copilotLines(copilotFinal('{"message":"Typed summary"}'), copilotResult(), {
                type: "session.shutdown",
                data: { content: "private-stream-content" },
              }),
            }
          : {}),
        settings: {
          logger,
          maximumHardTimeoutMs: 40_000,
          cliEnvironment: { API_KEY: "private-environment-secret" },
        },
      });
      const start = f.start.getMockImplementation();
      if (start === undefined) throw new Error("Missing fixture start implementation.");
      const resourceUsage = {
        peakJobMemoryBytes: 123_456,
        peakProcessMemoryBytes: 98_765,
        activeProcesses: { sampledPeak: 3, sampleCount: 2, sampleIntervalMs: 250 as const },
      };
      f.start.mockImplementation(async (spec) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        const managed = await start(spec);
        return {
          ...managed,
          processCreationTimeFileTime: "134022816000000000",
          completed: managed.completed.then(
            (exit) =>
              new Promise((resolve) => setTimeout(() => resolve({ ...exit, resourceUsage }), 20)),
          ),
        } as ManagedProcess;
      });
      const running = f.runner.run({ ...f.input, prompt: "private-prompt-content" });
      await vi.advanceTimersByTimeAsync(30);
      expect(await running).toMatchObject({ outcome: "succeeded" });
      expect(logger.info).toHaveBeenCalledWith(
        "CLI process started.",
        expect.objectContaining({
          correlationId: "attempt",
          engine,
          cliVersion: "1.2.3",
          processRequestId: "request",
          processCreationTimeFileTime: "134022816000000000",
          launchRequestedAt: "2026-09-14T00:00:00.000Z",
          startedAt: "2026-09-14T00:00:00.010Z",
          processEndedAt: null,
          completionObserved: false,
          hardTimeoutMs: 40_000,
          maximumProcessCount: 8,
          maximumMemoryBytes: 512 * 1_024 ** 2,
          maximumOutputBytes: 4 * 1_024 ** 2,
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        "CLI process execution finished.",
        expect.objectContaining({
          outcome: "succeeded",
          processRequestId: "request",
          startedAt: "2026-09-14T00:00:00.010Z",
          processEndedAt: "2026-09-14T00:00:00.030Z",
          completedAt: "2026-09-14T00:00:00.030Z",
          elapsedMs: 20,
          totalElapsedMs: 30,
          exitCode: 0,
          exitSignal: null,
          outputTruncated: false,
          resourceUsage,
          completionObserved: true,
          terminationRequested: false,
          parentSignalAborted: false,
          primaryFailureCode: null,
          copilot:
            engine === "copilot"
              ? expect.objectContaining({
                  lastObservedEventIndex: 3,
                  lastObservedEventType: "session.shutdown",
                  resultMarkerSeen: true,
                  parserFailure: null,
                  commandCapture: "incomplete",
                })
              : null,
        }),
      );
      const logged = JSON.stringify(logger.info.mock.calls);
      for (const privateText of [
        "private-environment-secret",
        "private-prompt-content",
        "private-stream-content",
        "Typed summary",
      ])
        expect(logged).not.toContain(privateText);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("redacts and bounds lifecycle identifiers while retaining only known Copilot event types", async () => {
    const logger = diagnosticLogger();
    const f = fixture({
      engine: "copilot",
      stdout: copilotLines(copilotFinal('{"message":"Typed summary"}'), copilotResult(), {
        type: "secret-lease-token",
        data: { content: "untrusted-tail" },
      }),
      settings: { logger, cliVersion: "version-secret-lease-token" },
    });
    expect(
      await f.runner.run({
        ...f.input,
        correlationId: `attempt-secret-lease-token\n${"x".repeat(3000)}`,
      }),
    ).toMatchObject({ outcome: "succeeded" });
    const finished = logger.info.mock.calls.find(
      ([message]) => message === "CLI process execution finished.",
    )?.[1] as { correlationId: string };
    expect(finished).toMatchObject({
      cliVersion: "version-[REDACTED]",
      copilot: {
        lastObservedEventIndex: 3,
        lastObservedEventType: "other",
        resultMarkerSeen: true,
      },
    });
    expect(finished.correlationId).toHaveLength(128);
    expect(finished.correlationId).not.toContain("\n");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("secret-lease-token");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("untrusted-tail");
  });

  it("keeps ordinary Copilot EOF without a result marker as a failed output", async () => {
    const logger = diagnosticLogger();
    const f = fixture({
      engine: "copilot",
      stdout: copilotLines(copilotFinal('{"message":"not closed"}')),
      settings: { logger },
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CLI_INCOMPLETE_EVENT_STREAM",
    });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Copilot JSONL parser rejected an event.", {
      correlationId: "attempt",
      reason: "missing_result_marker",
      eventIndex: 2,
      eventType: "unparsed",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "CLI process execution finished.",
      expect.objectContaining({
        outcome: "failed",
        primaryFailureCode: "CLI_INCOMPLETE_EVENT_STREAM",
        copilot: expect.objectContaining({
          lastObservedEventType: "assistant.message",
          lastObservedEventIndex: 1,
          resultMarkerSeen: false,
          parserIsPrimary: true,
        }),
      }),
    );
  });

  it("does not replace successful output when lifecycle logging throws", async () => {
    const f = fixture({
      settings: {
        logger: {
          ...diagnosticLogger(),
          info: () => {
            throw new Error("Diagnostic sink failed");
          },
        },
      },
    });
    expect(await f.runner.run(f.input)).toMatchObject({ outcome: "succeeded" });
    expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
  });

  it("passes an optional Codex home and model without overriding provider configuration", async () => {
    const f = fixture({
      settings: { cliHomeDirectory: "C:\\Account\\Codex", model: "worker-model" },
    });
    const result = await f.runner.run(f.input);
    const launch = f.start.mock.calls[0]?.[0];
    expect(launch?.environment.CODEX_HOME).toBe("C:\\Account\\Codex");
    expect(launch?.arguments[launch.arguments.indexOf("--model") + 1]).toBe("worker-model");
    expect(launch?.arguments.join(" ")).not.toMatch(
      /model_provider|model_providers|base_url|relay/iu,
    );
    expect(result).toMatchObject({ cliExecution: { requestedModel: "worker-model" } });
    expect(f.files.has(win32.join(f.input.workspace.controlDirectory, "config.toml"))).toBe(false);
  });

  it("binds observation metadata to the owned process, requested prompt, and validated output", async () => {
    const f = fixture();
    const before = Date.now();
    const result = await f.runner.run(f.input);
    const after = Date.now();
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") throw new Error("Expected a successful fixture run.");
    const expected = createCanonicalResult({ message: "Typed summary" });
    expect(result.cliExecution).toMatchObject({
      engine: "codex",
      cliVersion: "1.2.3",
      requestedModel: null,
      processRequestId: "request",
      promptSha256: digest(f.input.prompt),
      actualPromptSha256: digest(f.start.mock.calls[0]?.[0].standardInput ?? ""),
      outputSchemaSha256: f.input.authoritativeSchema.digest,
      modelOutputSha256: expected.sha256,
    });
    expect(result.canonicalResultJson).toBe(expected.json);
    expect(result.resultDigest).toBe(expected.sha256);
    expect(Date.parse(result.cliExecution.startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.cliExecution.completedAt)).toBeLessThanOrEqual(after);
    expect(Date.parse(result.cliExecution.completedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.cliExecution.startedAt),
    );
  });

  it("collects Codex JSONL observations and reads its final result file", async () => {
    const f = fixture({ fileChange: true });
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "succeeded",
      observedFileChange: true,
      result: { message: "Typed summary" },
      commandEvidence: { commandCapture: "complete" },
    });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("reads the last root Copilot response before its terminal marker without claiming a complete command transcript", async () => {
    const f = fixture({ engine: "copilot", result: ' { "message": "Copilot summary" }\n' });
    const result = await f.runner.run(f.input);
    expect(result).toMatchObject({
      outcome: "succeeded",
      observedFileChange: false,
      result: { message: "Copilot summary" },
      commandEvidence: { commands: [], commandCapture: "incomplete" },
    });
    expect(f.fileIO.openRead).not.toHaveBeenCalled();
    expect(f.files.has(win32.join(f.input.workspace.controlDirectory, "result.json"))).toBe(false);
    const actualPrompt = f.start.mock.calls[0]?.[0].standardInput ?? "";
    expect(actualPrompt).toContain(f.input.prompt);
    expect(actualPrompt).toContain(f.input.authoritativeSchema.json);
    expect(result).toMatchObject({ cliExecution: { actualPromptSha256: digest(actualPrompt) } });
  });

  it("selects full root messages while ignoring tool output, deltas, reasoning, and subagents", async () => {
    const output = copilotLines(
      { type: "user.message", data: { content: "Task input" } },
      copilotFinal("", { toolRequests: [{ toolCallId: "view-1", name: "view" }] }),
      { type: "tool.execution_start", data: { toolCallId: "view-1" } },
      {
        type: "tool.execution_complete",
        data: { toolCallId: "view-1", result: { content: '{"message":"tool output"}' } },
      },
      { type: "assistant.message_delta", data: { deltaContent: '{"message":"partial"}' } },
      copilotFinal('{"message":"actual root result"}'),
      { ...copilotFinal('{"message":"subagent result"}'), agentId: "subagent-1" },
      copilotFinal('{"message":"legacy subagent result"}', { parentToolCallId: "task-1" }),
      { type: "assistant.reasoning", data: { content: '{"message":"reasoning"}' } },
      { type: "assistant.turn_end", data: { turnId: "1" } },
      { type: "assistant.idle", data: {} },
      copilotResult(),
    );
    const f = fixture({ engine: "copilot", stdout: output });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: "actual root result" },
    });
    expect(f.context.reportProgress).toHaveBeenCalledWith({ phase: "cli_review", processCount: 1 });
    expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
  });

  it("accepts a recovered model_call error when the CLI terminal and process both succeed", async () => {
    const f = fixture({
      engine: "copilot",
      stdout: copilotLines(
        {
          type: "session.error",
          data: { errorType: "model_call", message: "Transient response error" },
        },
        copilotFinal('{"message":"Recovered result"}'),
        copilotResult(),
      ),
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: "Recovered result" },
    });
  });

  it.each(["abort", "assistant.turn_start", "assistant.message_start"])(
    "requires a fresh full root message after %s",
    async (type) => {
      const f = fixture({
        engine: "copilot",
        stdout: copilotLines(
          copilotFinal('{"message":"older response"}'),
          { type, data: {} },
          copilotResult(),
        ),
      });
      expect(await f.runner.run(f.input)).toMatchObject({
        outcome: "failed",
        code: "CLI_INCOMPLETE_EVENT_STREAM",
      });
    },
  );

  it.each(["abort", "assistant.turn_start", "assistant.message_start"])(
    "keeps the main response when a subagent emits %s",
    async (type) => {
      const f = fixture({
        engine: "copilot",
        stdout: copilotLines(
          copilotFinal('{"message":"main response"}'),
          { type, agentId: "child", data: {} },
          { type, data: { parentToolCallId: "legacy-child" } },
          copilotResult(),
        ),
      });
      expect(await f.runner.run(f.input)).toMatchObject({
        outcome: "succeeded",
        result: { message: "main response" },
      });
    },
  );

  it("accepts a new complete root response after an interrupted turn", async () => {
    const f = fixture({
      engine: "copilot",
      stdout: copilotLines(
        copilotFinal('{"message":"old response"}'),
        { type: "abort", data: {} },
        { type: "assistant.turn_start", data: { turnId: "new-turn" } },
        { type: "assistant.message_start", data: { messageId: "new-message" } },
        copilotFinal('{"message":"new response"}'),
        copilotResult(),
      ),
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: "new response" },
    });
  });

  it.each([
    { type: "assistant.reasoning", data: { content: "late reasoning" } },
    { type: "assistant.message_delta", data: { deltaContent: "late text" } },
    { type: "assistant.usage", data: { model: "fixture-model", outputTokens: 10 } },
    { type: "session.usage_info", data: { currentTokens: 100 } },
    { type: "session.usage_checkpoint", data: { totalNanoAiu: 1 } },
    { type: "session.title_changed", data: { title: "Late title" } },
    { type: "session.error", data: { errorType: "model_call", message: "Late diagnostic" } },
    { type: "session.warning", data: { warningType: "mcp", message: "Late warning" } },
    { type: "tool.execution_complete", data: { result: { content: '{"message":"tool"}' } } },
    { type: "future.informational_event", data: { content: '{"message":"metadata"}' } },
    { ...copilotFinal('{"message":"late subagent"}'), agentId: "child" },
    copilotFinal('{"message":"late legacy subagent"}', { parentToolCallId: "child" }),
    { type: "assistant.turn_start", agentId: "child", data: {} },
    { type: "assistant.message_start", data: { parentToolCallId: "child" } },
    { type: "abort", agentId: "child", data: {} },
  ])("keeps the closed response when a trailing event arrives: $type", async (event) => {
    const f = fixture({
      engine: "copilot",
      stdout: copilotLines(copilotFinal('{"message":"finished"}'), copilotResult(), event),
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: "finished" },
    });
  });

  it.each(["assistant.message", "assistant.turn_start", "assistant.message_start", "abort"])(
    "rejects a root %s after the terminal marker and trailing metadata",
    async (type) => {
      const f = fixture({
        engine: "copilot",
        stdout: copilotLines(
          copilotFinal('{"message":"finished"}'),
          copilotResult(),
          { type: "assistant.usage", data: { model: "fixture-model" } },
          { type, data: { content: '{"message":"later"}' } },
        ),
      });
      expect(await f.runner.run(f.input)).toMatchObject({
        outcome: "failed",
        code: "CLI_INVALID_EVENT_STREAM",
      });
    },
  );

  it("rejects a duplicate terminal marker separated by informational events", async () => {
    const f = fixture({
      engine: "copilot",
      stdout: copilotLines(
        copilotFinal('{"message":"finished"}'),
        copilotResult(),
        { type: "assistant.usage", data: { model: "fixture-model" } },
        copilotResult(),
      ),
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CLI_MULTIPLE_RESULTS",
    });
  });

  it("allows trailing JSONL whitespace after the unique result marker", async () => {
    const f = fixture({
      engine: "copilot",
      stdout: [...copilotLines(copilotFinal('{"message":"finished"}'), copilotResult()), " \r\n\n"],
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: "finished" },
    });
  });

  it.each(["not JSON\n", "[]\n", Buffer.from([0xff]), Buffer.from([0xe7, 0x95])])(
    "still validates the complete trailing JSONL stream: %j",
    async (trailing) => {
      const f = fixture({
        engine: "copilot",
        stdout: [
          ...copilotLines(copilotFinal('{"message":"finished"}'), copilotResult()),
          trailing,
        ],
      });
      expect(await f.runner.run(f.input)).toMatchObject({
        outcome: "failed",
        code: "CLI_INVALID_EVENT_STREAM",
      });
    },
  );

  it("continues enforcing the event limit after the terminal marker", async () => {
    const metadata = `${JSON.stringify({ type: "assistant.usage", data: {} })}\n`;
    const f = fixture({
      engine: "copilot",
      stdout: [
        ...copilotLines(copilotFinal('{"message":"finished"}'), copilotResult()),
        metadata.repeat(32_767),
      ],
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CLI_OUTPUT_LIMIT_EXCEEDED",
    });
  });

  it("continues enforcing the byte limit after the terminal marker", async () => {
    const f = fixture({
      engine: "copilot",
      stdout: copilotLines(copilotFinal('{"message":"finished"}'), copilotResult(), {
        type: "future.informational_event",
        data: { content: "x".repeat(4_096) },
      }),
      settings: { maximumOutputBytes: 4_096 },
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CLI_OUTPUT_LIMIT_EXCEEDED",
    });
  });

  it.each([
    {
      stdout: ["secret-lease-token is not JSON\n"],
      reason: "json_syntax",
      eventIndex: 1,
      eventType: "unparsed",
    },
    {
      stdout: copilotLines({ type: "assistant.message", data: null }),
      reason: "data_shape",
      eventIndex: 1,
      eventType: "assistant.message",
    },
    {
      stdout: copilotLines({ ...copilotFinal("secret-lease-token"), agentId: 4 }),
      reason: "attribution_shape",
      eventIndex: 1,
      eventType: "assistant.message",
    },
    {
      stdout: copilotLines({
        type: "assistant.message",
        data: { content: ["secret-lease-token"] },
      }),
      reason: "content_shape",
      eventIndex: 1,
      eventType: "assistant.message",
    },
    {
      stdout: copilotLines(copilotFinal("secret-lease-token", { toolRequests: {} })),
      reason: "tool_requests_shape",
      eventIndex: 1,
      eventType: "assistant.message",
    },
    {
      stdout: copilotLines(copilotFinal('{"message":"finished"}'), copilotResult(), {
        type: "assistant.message",
        data: { content: "secret-lease-token" },
      }),
      reason: "after_result",
      eventIndex: 3,
      eventType: "assistant.message",
    },
    {
      stdout: copilotLines(copilotFinal('{"message":"finished"}'), copilotResult(), {
        type: { secret: "secret-lease-token" },
        data: {},
      }),
      reason: "type_shape",
      eventIndex: 3,
      eventType: "unparsed",
    },
    { stdout: [Buffer.from([0xff])], reason: "utf8", eventIndex: 1, eventType: "unparsed" },
  ])(
    "logs only the first safe parser classification: $reason/$eventType",
    async ({ stdout, reason, eventIndex, eventType }) => {
      const warn = vi.fn();
      const f = fixture({
        engine: "copilot",
        stdout,
        settings: { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } },
      });
      expect(await f.runner.run(f.input)).toMatchObject({
        outcome: "failed",
        code: "CLI_INVALID_EVENT_STREAM",
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith("Copilot JSONL parser rejected an event.", {
        correlationId: "attempt",
        reason,
        eventIndex,
        eventType,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-lease-token");
      expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
    },
  );

  it("does not change a failed output decision when the diagnostic logger throws", async () => {
    const f = fixture({
      engine: "copilot",
      stdout: ["malformed\n"],
      settings: {
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: () => {
            throw new Error("Logger unavailable");
          },
          error: vi.fn(),
        },
      },
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CLI_INVALID_EVENT_STREAM",
    });
  });

  it.each([
    {
      name: "missing terminal",
      events: [copilotFinal('{"message":"not closed"}')],
      code: "CLI_INCOMPLETE_EVENT_STREAM",
    },
    {
      name: "duplicate terminal",
      events: [copilotFinal('{"message":"closed"}'), copilotResult(), copilotResult()],
      code: "CLI_MULTIPLE_RESULTS",
    },
    {
      name: "missing root message",
      events: [copilotResult()],
      code: "CLI_INCOMPLETE_EVENT_STREAM",
    },
    {
      name: "delta only",
      events: [
        { type: "assistant.message_delta", data: { deltaContent: '{"message":"partial"}' } },
        copilotResult(),
      ],
      code: "CLI_INCOMPLETE_EVENT_STREAM",
    },
    {
      name: "tool output only",
      events: [
        {
          type: "tool.execution_complete",
          data: { result: { content: '{"message":"tool result"}' } },
        },
        copilotResult(),
      ],
      code: "CLI_INCOMPLETE_EVENT_STREAM",
    },
    {
      name: "pending final tool request",
      events: [
        copilotFinal('{"message":"tool requested"}', { toolRequests: [{ toolCallId: "pending" }] }),
        copilotResult(),
      ],
      code: "CLI_INCOMPLETE_EVENT_STREAM",
    },
    {
      name: "unsuccessful terminal",
      events: [copilotFinal('{"message":"not successful"}'), copilotResult(1)],
      code: "CLI_COPILOT_REPORTED_ERROR",
    },
    {
      name: "terminal missing exit code",
      events: [copilotFinal('{"message":"invalid terminal"}'), { type: "result" }],
      code: "CLI_INVALID_EVENT_STREAM",
    },
    {
      name: "non-string root content",
      events: [
        { type: "assistant.message", data: { content: { message: "object" } } },
        copilotResult(),
      ],
      code: "CLI_INVALID_EVENT_STREAM",
    },
    {
      name: "invalid toolRequests",
      events: [copilotFinal('{"message":"invalid tools"}', { toolRequests: {} }), copilotResult()],
      code: "CLI_INVALID_EVENT_STREAM",
    },
    {
      name: "root message after terminal",
      events: [
        copilotFinal('{"message":"first"}'),
        copilotResult(),
        copilotFinal('{"message":"later"}'),
      ],
      code: "CLI_INVALID_EVENT_STREAM",
    },
    {
      name: "no fallback to earlier JSON",
      events: [
        copilotFinal('{"message":"earlier"}'),
        copilotFinal("The last answer is not JSON."),
        copilotResult(),
      ],
      code: "CLI_INVALID_RESULT_JSON",
    },
  ])("rejects Copilot $name", async ({ events, code }) => {
    const f = fixture({ engine: "copilot", stdout: copilotLines(...events) });
    expect(await f.runner.run(f.input)).toMatchObject({ outcome: "failed", code });
    expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
  });

  it.each(["plain text", "{malformed", "[]", '{"message":"unframed object"}'])(
    "rejects non-event Copilot stdout without extracting arbitrary braces: %j",
    async (text) => {
      const f = fixture({
        engine: "copilot",
        stdout: [
          `${text}\n`,
          ...copilotLines(copilotFinal('{"message":"later"}'), copilotResult()),
        ],
      });
      expect(await f.runner.run(f.input)).toMatchObject({
        outcome: "failed",
        code: "CLI_INVALID_EVENT_STREAM",
      });
    },
  );

  it("decodes split UTF-8 event bytes and accepts a final record without a newline", async () => {
    const bytes = Buffer.from(
      copilotLines(copilotFinal('{"message":"Résumé 界"}'), copilotResult()).join("").trimEnd(),
    );
    const f = fixture({
      engine: "copilot",
      stdout: [...bytes].map((value) => Buffer.from([value])),
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: "Résumé 界" },
    });
  });

  it.each([Buffer.from([0xff]), Buffer.from([0xe7, 0x95])])(
    "rejects invalid or truncated UTF-8 while draining the stream",
    async (bytes) => {
      const f = fixture({ engine: "copilot", stdout: [bytes] });
      const ended = vi.fn();
      const start = f.start.getMockImplementation();
      if (start === undefined) throw new Error("The fixture process implementation is missing.");
      f.start.mockImplementation(async (spec) => {
        const managed = await start(spec);
        managed.stdout.once("end", ended);
        return managed;
      });
      expect(await f.runner.run(f.input)).toMatchObject({
        outcome: "failed",
        code: "CLI_INVALID_EVENT_STREAM",
      });
      expect(ended).toHaveBeenCalledOnce();
      expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
    },
  );

  it("bounds the number of Copilot events without retaining a full tool transcript", async () => {
    const metadata = `${JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "." } })}\n`;
    const f = fixture({ engine: "copilot", stdout: [metadata.repeat(32_769)] });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CLI_OUTPUT_LIMIT_EXCEEDED",
    });
  });
  it.each([
    { result: "", code: "CLI_MISSING_RESULT" },
    { result: '```json\n{"message":"summary"}\n```', code: "CLI_INVALID_RESULT_JSON" },
    { result: '{"message":"summary","extra":true}', code: "CLI_INVALID_RESULT_SCHEMA" },
  ])("rejects malformed Copilot output: $code", async ({ result, code }) => {
    const f = fixture({ engine: "copilot", result });
    expect(await f.runner.run(f.input)).toMatchObject({ outcome: "failed", code });
  });

  it("drains oversized Copilot stdout and rejects it without reading a result file", async () => {
    const f = fixture({ engine: "copilot", result: "x".repeat(2 * 1_024 ** 2 + 1) });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CLI_OUTPUT_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(f.fileIO.openRead).not.toHaveBeenCalled();
    expect(f.monitorClose).toHaveBeenCalledOnce();
  });

  it("reports oversized Copilot output even when the retained prefix ends inside a UTF-8 character", async () => {
    const bytes = Buffer.from(`\u754c${"x".repeat(4_096)}`);
    const f = fixture({
      engine: "copilot",
      stdout: [bytes.subarray(0, 1), bytes.subarray(1)],
      settings: { maximumOutputBytes: 4_096 },
    });
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "failed",
      code: "CLI_OUTPUT_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
    expect(f.monitorClose).toHaveBeenCalledOnce();
  });

  it("rejects a completion event belonging to another process", async () => {
    const f = fixture({ engine: "copilot" });
    f.start.mockResolvedValue({
      requestId: "owned-process",
      processId: 2,
      stdout: Readable.from(['{"message":"Typed summary"}']),
      stderr: Readable.from([]),
      completed: Promise.resolve({
        protocolVersion: processHostProtocolVersion,
        type: "exited",
        requestId: "other-process",
        exitCode: 0,
        signal: null,
        outputTruncated: false,
      }),
      terminate: vi.fn(async () => undefined),
    } as unknown as ManagedProcess);
    await expect(f.runner.run(f.input)).rejects.toMatchObject({ code: "CLI_PROCESS_FAILED" });
    expect(f.monitorClose).toHaveBeenCalledOnce();
  });

  it("drains a managed hard timeout without declaring a Worker health fault", async () => {
    const logger = diagnosticLogger();
    const f = fixture({ engine: "copilot", settings: { logger } });
    const stdoutEnded = vi.fn();
    const stderrEnded = vi.fn();
    f.start.mockImplementation(async () => {
      const stdout = Readable.from(copilotLines(copilotFinal('{"message":"not closed"}'))).once(
        "end",
        stdoutEnded,
      );
      const stderr = Readable.from(["Process timed out"]).once("end", stderrEnded);
      return {
        requestId: "timed-out",
        processId: 2,
        stdout,
        stderr,
        completed: Promise.reject(
          new ProcessHostRequestError("PROCESS_HARD_TIMEOUT", "Synthetic hard timeout."),
        ),
        terminate: vi.fn(async () => undefined),
      } as unknown as ManagedProcess;
    });
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      code: "CLI_PROCESS_FAILED",
      retryable: true,
    });
    expect(stdoutEnded).toHaveBeenCalledOnce();
    expect(stderrEnded).toHaveBeenCalledOnce();
    expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
    expect(f.monitorClose).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "CLI process execution finished.",
      expect.objectContaining({
        outcome: "failed",
        primaryFailureCode: "PROCESS_HARD_TIMEOUT",
        completionFailureCode: "PROCESS_HARD_TIMEOUT",
        completionObserved: false,
        processEndedAt: null,
        copilot: expect.objectContaining({
          resultMarkerSeen: false,
          parserIsPrimary: false,
          parserDiagnostic: expect.objectContaining({ reason: "missing_result_marker" }),
        }),
      }),
    );
  });

  it.each(["before_eof", "after_eof"])(
    "preserves parent timeout %s and records missing Copilot closure only as secondary evidence",
    async (stage) => {
      const logger = diagnosticLogger();
      const f = fixture({ engine: "copilot", settings: { logger } });
      const controller = new AbortController();
      const reason = Object.assign(new Error("secret-lease-token timeout details"), {
        code: "EXECUTION_TIMEOUT",
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutEnded = Promise.withResolvers<void>();
      stdout.once("end", () => stdoutEnded.resolve());
      const exited = Promise.withResolvers<Awaited<ManagedProcess["completed"]>>();
      const started = Promise.withResolvers<void>();
      const terminate = vi.fn(async () => {
        stdout.end();
        stderr.end();
        exited.resolve({
          protocolVersion: processHostProtocolVersion,
          type: "exited",
          requestId: "parent-timeout",
          exitCode: null,
          signal: "SIGTERM",
          outputTruncated: false,
        });
      });
      f.start.mockImplementation(async () => {
        started.resolve();
        return {
          requestId: "parent-timeout",
          processId: 2,
          stdout,
          stderr,
          completed: exited.promise,
          terminate,
        } as ManagedProcess;
      });
      const running = f.runner.run({
        ...f.input,
        context: { ...f.context, signal: controller.signal },
      });
      const rejected = expect(running).rejects.toBe(reason);
      await started.promise;
      stdout.write(copilotLines(copilotFinal('{"message":"not closed"}'))[0]);
      if (stage === "after_eof") {
        stdout.end();
        await stdoutEnded.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(logger.warn).not.toHaveBeenCalled();
      }
      controller.abort(reason);
      await rejected;
      expect(terminate).toHaveBeenCalledOnce();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "CLI process execution finished.",
        expect.objectContaining({
          outcome: "aborted",
          primaryFailureCode: "EXECUTION_TIMEOUT",
          parentSignalAborted: true,
          processRequestId: "parent-timeout",
          exitCode: null,
          exitSignal: "SIGTERM",
          completionObserved: true,
          terminationRequested: true,
          terminationReason: "cancelled",
          copilot: expect.objectContaining({
            lastObservedEventIndex: 1,
            lastObservedEventType: "assistant.message",
            resultMarkerSeen: false,
            parserIsPrimary: false,
            parserDiagnostic: expect.objectContaining({ reason: "missing_result_marker" }),
          }),
        }),
      );
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain("secret-lease-token");
      expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
      expect(f.monitorClose).toHaveBeenCalledOnce();
    },
  );

  it("logs a failed process launch without inventing a start or an exit", async () => {
    const logger = diagnosticLogger();
    const f = fixture({ settings: { logger } });
    f.start.mockRejectedValueOnce(new Error("private process-start detail"));
    await expect(f.runner.run(f.input)).rejects.toMatchObject({ code: "CLI_PROCESS_START_FAILED" });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      "CLI process execution finished.",
      expect.objectContaining({
        outcome: "failed",
        primaryFailureCode: "CLI_PROCESS_START_FAILED",
        processRequestId: null,
        startedAt: null,
        processEndedAt: null,
        elapsedMs: null,
        completionObserved: false,
      }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private process-start detail");
  });

  it("preserves cancellation while reporting bounded unconfirmed teardown as a health fault", async () => {
    vi.useFakeTimers();
    const logger = diagnosticLogger();
    const f = fixture({ settings: { logger } });
    const controller = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exited = Promise.withResolvers<Awaited<ManagedProcess["completed"]>>();
    const terminate = vi.fn(async () => undefined);
    f.start.mockResolvedValue({
      requestId: "stalled",
      processId: 2,
      stdout,
      stderr,
      completed: exited.promise,
      terminate,
    } as unknown as ManagedProcess);
    const running = f.runner.run({
      ...f.input,
      context: { ...f.context, signal: controller.signal },
      teardownTimeoutMs: 20,
    });
    const reason = Object.assign(new Error("Optional summary timeout"), {
      code: "SUMMARY_TIMEOUT",
    });
    const rejected = expect(running).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(terminate).toHaveBeenCalledOnce();
    expect(f.context.reportNodeHealthFault).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLI_PROCESS_DRAIN_UNCONFIRMED" }),
    );
    expect(f.monitorClose).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      "CLI process execution finished.",
      expect.objectContaining({
        outcome: "aborted",
        primaryFailureCode: "SUMMARY_TIMEOUT",
        completionObserved: false,
        processEndedAt: null,
        terminationRequested: true,
      }),
    );
    stdout.end();
    stderr.end();
    exited.resolve({
      protocolVersion: processHostProtocolVersion,
      type: "exited",
      requestId: "stalled",
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    } as Awaited<ManagedProcess["completed"]>);
  });

  it("preserves the caller cancellation after confirming the owned process has drained", async () => {
    const f = fixture({ engine: "copilot" });
    const controller = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exited = Promise.withResolvers<Awaited<ManagedProcess["completed"]>>();
    const started = Promise.withResolvers<void>();
    const reason = new Error("Lease authority was lost");
    const terminate = vi.fn(async () => {
      stdout.end();
      stderr.end();
      exited.resolve({
        protocolVersion: processHostProtocolVersion,
        type: "exited",
        requestId: "cancelled",
        exitCode: null,
        signal: "SIGTERM",
        outputTruncated: false,
      } as Awaited<ManagedProcess["completed"]>);
    });
    f.start.mockImplementation(async () => {
      started.resolve();
      return {
        requestId: "cancelled",
        processId: 2,
        stdout,
        stderr,
        completed: exited.promise,
        terminate,
      } as unknown as ManagedProcess;
    });
    const running = f.runner.run({
      ...f.input,
      context: { ...f.context, signal: controller.signal },
    });
    const rejected = expect(running).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await rejected;
    expect(terminate).toHaveBeenCalledOnce();
    expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
    expect(f.monitorClose).toHaveBeenCalledOnce();
  });

  it.each(["before_start_acknowledgement", "after_start_acknowledgement"])(
    "preserves cancellation through the real Stdio client: %s",
    async (stage) => {
      const f = fixture({ engine: "copilot" });
      const controller = new AbortController();
      const reason = new Error("Synthetic lease cancellation");
      const startRequest = Promise.withResolvers<Extract<ProcessHostRequest, { type: "start" }>>();
      const runningProgress = Promise.withResolvers<void>();
      const requests: ProcessHostRequest[] = [];
      const emitter = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const send = (event: Record<string, unknown>): void => {
        stdout.write(
          `${JSON.stringify({ protocolVersion: processHostProtocolVersion, ...event })}\n`,
        );
      };
      let closed = false;
      const close = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (closed) return;
        closed = true;
        stdout.end();
        stderr.end();
        emitter.emit("close", code, signal);
      };
      const stdin = new Writable({
        write: (chunk, _encoding, callback) => {
          const request = JSON.parse(String(chunk).trim()) as ProcessHostRequest;
          requests.push(request);
          if (request.type === "start") startRequest.resolve(request);
          else if (request.type === "terminate") {
            queueMicrotask(() => {
              send({ type: "terminated", requestId: request.requestId, reason: "cancelled" });
              send({
                type: "exited",
                requestId: request.requestId,
                exitCode: null,
                signal: "cancelled",
                outputTruncated: false,
              });
            });
          } else if (request.type === "shutdown") {
            queueMicrotask(() => send({ type: "shutdown_complete", requestId: request.requestId }));
          }
          callback();
        },
        final: (callback) => {
          callback();
          queueMicrotask(() => close(0, null));
        },
      });
      const child = Object.assign(emitter, {
        pid: 4200,
        stdout,
        stderr,
        stdin,
        killed: false,
        kill: () => {
          queueMicrotask(() => close(null, "SIGTERM"));
          return true;
        },
      });
      const clientPromise = StdioProcessHostClient.create({
        processHostPath: "C:\\Trusted\\ProcessHost.exe",
        instanceKey: "a".repeat(64),
        maximumConcurrentRequests: 1,
        hostEnvironment: { SYSTEMROOT: "C:\\Windows" },
        spawnProcess: () => {
          queueMicrotask(() =>
            send({
              type: "ready",
              processHostPid: 4200,
              capabilities: {
                concurrentRequests: true,
                maximumConcurrentRequests: 1,
                maximumFrameBytes: processHostMaximumFrameBytes,
              },
            }),
          );
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      });
      const client = await clientPromise;
      try {
        const running = f.runner.run({
          ...f.input,
          context: {
            ...f.context,
            signal: controller.signal,
            processHost: client,
            reportProgress: (progress) => {
              if (progress.processCount === 1) runningProgress.resolve();
            },
          },
        });
        const rejected = expect(running).rejects.toBe(reason);
        const request = await startRequest.promise;
        if (stage === "before_start_acknowledgement") controller.abort(reason);
        send({ type: "started", requestId: request.requestId, processId: 4201 });
        if (stage === "after_start_acknowledgement") {
          await runningProgress.promise;
          controller.abort(reason);
        }
        await rejected;
        expect(requests.filter((item) => item.type === "terminate")).toHaveLength(1);
        expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
        expect(f.monitorClose).toHaveBeenCalledOnce();
      } finally {
        await client.close();
      }
      expect(closed).toBe(true);
    },
  );

  it.each(["codex", "copilot"] as const)(
    "redacts protected values and generic credentials from %s failure diagnostics",
    async (engine) => {
      const f = fixture({
        engine,
        result: '{"message":"Typed summary","checks":[]}',
        stderr: "worker secret-lease-token Bearer opaque-token token=hidden-value",
      });
      const result = await f.runner.run(f.input);
      expect(result).toMatchObject({ outcome: "failed", code: "CLI_INVALID_RESULT_SCHEMA" });
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("worker");
      for (const secret of ["secret-lease-token", "opaque-token", "hidden-value"])
        expect(serialized).not.toContain(secret);
    },
  );

  it("redacts Codex error events from both the failure message and diagnostics", async () => {
    const f = fixture({
      stdout: [
        `${JSON.stringify({ type: "error", message: "secret-lease-token Bearer opaque-token" })}\n`,
      ],
    });
    const result = await f.runner.run(f.input);
    expect(result).toMatchObject({ outcome: "failed", code: "CLI_CODEX_REPORTED_ERROR" });
    expect(JSON.stringify(result)).not.toContain("secret-lease-token");
    expect(JSON.stringify(result)).not.toContain("opaque-token");
  });

  it.each(["codex", "copilot"] as const)(
    "redacts literal and JSON-escaped environment credentials from %s failure diagnostics",
    async (engine) => {
      const secret = 'private\n"quoted"\\environment-value';
      const escaped = JSON.stringify(secret).slice(1, -1);
      const f = fixture({
        engine,
        exitCode: 1,
        sensitiveValues: [],
        settings: { cliEnvironment: { CONFIGURED_API_TOKEN: secret } },
        stderr: `ordinary error details: ${secret}; encoded detail: ${escaped}; schema rejected`,
      });
      const result = await f.runner.run(f.input);
      expect(result).toMatchObject({ outcome: "failed", code: "CLI_NON_ZERO_EXIT" });
      if (result.outcome !== "failed") throw new Error("Expected CLI failure.");
      expect(result.diagnostics?.summary).toContain(
        "ordinary error details: [REDACTED]; encoded detail: [REDACTED]; schema rejected",
      );
      expect(result.diagnostics?.summary).not.toContain(secret);
      expect(result.diagnostics?.summary).not.toContain(escaped);
      expect(f.start.mock.calls[0]?.[0].environment.CONFIGURED_API_TOKEN).toBe(secret);
      expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
    },
  );

  it.each(["codex", "copilot"] as const)(
    "redacts JSON-escaped environment credentials before %s truncates the diagnostic",
    async (engine) => {
      const secret = 'private\n"quoted"\\environment-value';
      const prefix =
        engine === "codex"
          ? "The Codex process exited with code 1; stderr: "
          : "The CLI exited with code 1.; stderr: ";
      const padding = "x".repeat(2_047 - prefix.length);
      const f = fixture({
        engine,
        exitCode: 1,
        sensitiveValues: [],
        settings: { cliEnvironment: { CONFIGURED_API_TOKEN: secret } },
        stderr: `${padding}${JSON.stringify(secret).slice(1, -1)}`,
      });
      const result = await f.runner.run(f.input);
      expect(result).toMatchObject({ outcome: "failed", code: "CLI_NON_ZERO_EXIT" });
      if (result.outcome !== "failed") throw new Error("Expected CLI failure.");
      expect(result.diagnostics?.summary).toBe(`${prefix}${padding}[`);
      expect(result.diagnostics?.summary).toHaveLength(2_048);
    },
  );

  it.each(["line\nsecret", "path\\secret", 'quoted"secret'])(
    "rejects protected decoded strings that require JSON escaping: %j",
    async (secret) => {
      const f = fixture({ result: JSON.stringify({ message: secret }), sensitiveValues: [secret] });
      await expect(f.runner.run(f.input)).resolves.toMatchObject({
        outcome: "failed",
        code: "CLI_RESULT_UNSAFE",
        retryable: false,
      });
    },
  );

  it.each([
    { name: "plain text", result: '{"message":"prefix secret-lease-token suffix"}' },
    { name: "nested text", result: '{"message":{"items":[{"note":"secret-lease-token"}]}}' },
    { name: "decoded string escape", result: '{"message":"secret\\u002dlease\\u002dtoken"}' },
    {
      name: "decoded dictionary key",
      result: '{"message":{"secret\\u002dlease\\u002dtoken":"ordinary"}}',
    },
  ])("rejects protected $name without rewriting the model result", async ({ result }) => {
    const f = fixture({
      result,
      outputSchema: Type.Object({ message: Type.Unknown() }, { additionalProperties: false }),
    });
    const outcome = await f.runner.run(f.input);
    expect(outcome).toMatchObject({
      outcome: "failed",
      code: "CLI_RESULT_UNSAFE",
      retryable: false,
    });
    expect(outcome).not.toHaveProperty("result");
    expect(outcome).not.toHaveProperty("resultDigest");
    expect(outcome).not.toHaveProperty("canonicalResultJson");
    expect(
      f.files.get(win32.join(f.input.workspace.controlDirectory, "result.json"))?.toString(),
    ).toBe(result);
    expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
  });

  it.each([
    { value: 42, secret: "42" },
    { value: 142, secret: "42" },
    { value: true, secret: "true" },
    { value: false, secret: "false" },
    { value: null, secret: "null" },
  ])("conservatively matches supplied protected primitive text: %j", async ({ value, secret }) => {
    const f = fixture({
      result: JSON.stringify({ message: value }),
      outputSchema: Type.Object({ message: Type.Unknown() }, { additionalProperties: false }),
      sensitiveValues: [secret],
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CLI_RESULT_UNSAFE",
      retryable: false,
    });
  });

  it("retains public model text and its original canonical result digest", async () => {
    const text = "Explain token=illustrative-value as example syntax.";
    const f = fixture({ result: JSON.stringify({ message: text }) });
    const expected = createCanonicalResult({ message: text });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: text },
      canonicalResultJson: expected.json,
      resultDigest: expected.sha256,
    });
  });

  it("captures supplied protected values before its first await", async () => {
    const sensitiveValues = ["supplied-original-secret"];
    const f = fixture({ result: '{"message":"supplied-original-secret"}', sensitiveValues });
    const pending = f.runner.run(f.input);
    sensitiveValues.splice(0);
    const result = await pending;
    expect(result).toMatchObject({
      outcome: "failed",
      code: "CLI_RESULT_UNSAFE",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain("supplied-original-secret");
  });

  it("rejects a preexisting Codex result before launching another task", async () => {
    const f = fixture();
    f.files.set(
      win32.join(f.input.workspace.controlDirectory, "result.json"),
      Buffer.from("stale"),
    );
    await expect(f.runner.run(f.input)).rejects.toMatchObject({ code: "RESULT_FILE_PREEXISTS" });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.fileIO.writeExclusiveUtf8).not.toHaveBeenCalled();
  });

  it("rejects mismatched schema digests before writing control files or starting processes", async () => {
    const f = fixture();
    await expect(
      f.runner.run({
        ...f.input,
        authoritativeSchema: { ...f.input.authoritativeSchema, digest: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "CLI_LAUNCH_SPEC_INVALID" });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.files.size).toBe(0);
  });

  it("preserves caller cancellation before touching the prepared workspace", async () => {
    const f = fixture();
    const reason = new Error("Lease authority was lost");
    await expect(
      f.runner.run({ ...f.input, context: { ...f.context, signal: AbortSignal.abort(reason) } }),
    ).rejects.toBe(reason);
    expect(f.files.size).toBe(0);
    expect(f.start).not.toHaveBeenCalled();
  });
});
