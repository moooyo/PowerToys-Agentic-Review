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

function fixture(
  options: {
    engine?: "codex" | "copilot";
    result?: string;
    stderr?: string;
    stdout?: readonly (string | Buffer)[];
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
          (engine === "codex" ? events.map((event) => `${JSON.stringify(event)}\n`) : [result]),
      ),
      stderr: Readable.from([options.stderr ?? ""]),
      completed: Promise.resolve({
        protocolVersion: processHostProtocolVersion,
        type: "exited",
        requestId: "request",
        exitCode: 0,
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

  it("reads Copilot final JSON from stdout without claiming a complete command transcript", async () => {
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
    const f = fixture({ engine: "copilot" });
    const stdoutEnded = vi.fn();
    const stderrEnded = vi.fn();
    f.start.mockImplementation(async () => {
      const stdout = Readable.from(["Incomplete output"]).once("end", stdoutEnded);
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
  });

  it("bounds cancellation teardown and reports streams that cannot be confirmed drained", async () => {
    vi.useFakeTimers();
    const f = fixture();
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
    const rejected = expect(running).rejects.toMatchObject({
      code: "CLI_PROCESS_DRAIN_UNCONFIRMED",
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("Optional summary timeout"));
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(terminate).toHaveBeenCalledOnce();
    expect(f.context.reportNodeHealthFault).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLI_PROCESS_DRAIN_UNCONFIRMED" }),
    );
    expect(f.monitorClose).toHaveBeenCalledOnce();
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
