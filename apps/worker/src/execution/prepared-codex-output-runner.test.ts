import { win32 } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createCanonicalResult } from "@agentic-review/codex";
import { type TSchema, Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionContext } from "./job-executor.js";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import {
  type PreparedCodexOutputInput,
  PreparedCodexOutputRunner,
  type ReviewFileIO,
  type ReviewFileStat,
} from "./prepared-codex-output-runner.js";
import type { ManagedProcess, ProcessLaunchSpec } from "./process-host-protocol.js";

const schema = Type.Object(
  { message: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
function fixture(
  options: {
    result?: string;
    stderr?: string;
    fileChange?: boolean;
    providerEnvironment?: Readonly<Record<string, string>>;
    providerProtectedValues?: readonly string[];
    sensitiveValues?: readonly string[];
    outputSchema?: TSchema;
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
    writeExclusiveUtf8: async (path, value) => {
      if (files.has(path)) throw new Error("Preexisting fixture file");
      files.set(path, Buffer.from(value));
    },
    lstat: async (path) => stat(path),
    realpath: async (path) => path,
    openRead: async (path) => ({
      stat: async () => stat(path),
      read: async (buffer, offset, length, position) => {
        const bytes = files.get(path) as Buffer;
        const bytesRead = Math.max(0, Math.min(length, bytes.length - position));
        bytes.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      close,
    }),
  };
  const workspace: PreparedJobWorkspace = {
    attemptDirectory: root,
    checkoutDirectory: `${root}\\checkout`,
    controlDirectory: `${root}\\control`,
    codexHomeDirectory: `${root}\\codex`,
    tempDirectory: `${root}\\temp`,
    userProfileDirectory: `${root}\\user`,
    startDiskMonitoring: async (signal) => ({
      signal,
      violation: undefined,
      close: vi.fn(async () => undefined),
    }),
    cleanup: vi.fn(async () => undefined),
  };
  const start = vi.fn(async (_spec: ProcessLaunchSpec) => {
    files.set(
      win32.join(workspace.controlDirectory, "result.json"),
      Buffer.from(options.result ?? '{"message":"Typed summary"}'),
    );
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
      stdout: Readable.from(events.map((event) => `${JSON.stringify(event)}\n`)),
      stderr: Readable.from([options.stderr ?? ""]),
      completed: Promise.resolve({
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
  const settings = {
    codexExecutablePath: "C:\\Trusted\\codex.exe",
    codexHomeDirectory: "C:\\WorkerProfile",
    systemRoot: "C:\\Windows",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    path: "C:\\Windows\\System32",
    pathExt: ".EXE;.CMD",
    maximumHardTimeoutMs: 60_000,
    maximumProcessCount: 8,
    maximumMemoryBytes: 512 * 1_024 ** 2,
    maximumOutputBytes: 4 * 1_024 ** 2,
    codexProviderEnvironment: options.providerEnvironment ?? {
      CODEX_PROVIDER_HEADER_0: "secret-provider-header",
    },
    ...(options.providerProtectedValues === undefined
      ? {}
      : { codexProviderProtectedValues: options.providerProtectedValues }),
    fileIO,
  };
  const runner = new PreparedCodexOutputRunner(settings);
  const input: PreparedCodexOutputInput<TSchema> = {
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
  return { runner, input, context, start, files, close, settings };
}

describe("PreparedCodexOutputRunner", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds cancellation teardown and reports when streams cannot be confirmed drained", async () => {
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
      code: "CODEX_PROCESS_DRAIN_UNCONFIRMED",
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("Optional summary timeout"));
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(terminate).toHaveBeenCalledOnce();
    expect(f.context.reportNodeHealthFault).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CODEX_PROCESS_DRAIN_UNCONFIRMED" }),
    );
    stdout.end();
    stderr.end();
    exited.resolve({
      type: "exited",
      requestId: "stalled",
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    } as Awaited<ManagedProcess["completed"]>);
  });

  it("runs generic structured output with a fixed read-only, offline tool policy", async () => {
    const f = fixture();
    const result = await f.runner.run(f.input);
    expect(result).toMatchObject({
      outcome: "succeeded",
      result: { message: "Typed summary" },
      observedFileChange: false,
      commandEvidence: { commandCapture: "complete" },
    });
    const launch = f.start.mock.calls[0]?.[0];
    expect(launch?.arguments[launch.arguments.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(launch?.arguments).toContain('sandbox_mode="read-only"');
    expect(launch?.arguments).toContain("sandbox_workspace_write.network_access=false");
    expect(launch?.arguments).toContain("sandbox_workspace_write.writable_roots=[]");
    expect(launch?.arguments).toContain('web_search="disabled"');
    expect(launch?.arguments).toContain("mcp_servers={}");
    expect(launch?.arguments).toContain("--ignore-rules");
    expect(launch?.arguments).toContain("features.browser_use=false");
    expect(launch?.arguments).toContain("features.computer_use=false");
    expect(launch?.arguments).toContain("features.multi_agent_v2=false");
    expect(launch?.standardInput).toBe(f.input.prompt);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("preserves the legacy workspace-write configuration when review policy is selected", async () => {
    const f = fixture();
    await f.runner.run({ ...f.input, launchPolicy: "review" });
    const launch = f.start.mock.calls[0]?.[0];
    expect(launch?.arguments[launch.arguments.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(launch?.arguments).toContain("sandbox_workspace_write.network_access=true");
  });

  it("records file-change observations separately from parsed model data", async () => {
    const f = fixture({ fileChange: true });
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "succeeded",
      observedFileChange: true,
      result: { message: "Typed summary" },
    });
  });

  it("rejects authority fields outside the selected output schema and redacts failure diagnostics", async () => {
    const f = fixture({
      result: '{"message":"Typed summary","checks":[]}',
      stderr: "secret-provider-header secret-lease-token",
    });
    const result = await f.runner.run(f.input);
    expect(result).toMatchObject({ outcome: "failed", code: "CODEX_INVALID_RESULT_SCHEMA" });
    expect(JSON.stringify(result)).not.toContain("secret-provider-header");
    expect(JSON.stringify(result)).not.toContain("secret-lease-token");
  });

  it("preserves approved public metadata while redacting declared and generic credentials", async () => {
    const f = fixture({
      result: '{"message":"Typed summary","checks":[]}',
      stderr:
        "worker secret-provider-header secret-lease-token Bearer opaque-token token=hidden-value",
      providerEnvironment: {
        CODEX_PROVIDER_HEADER_0: "worker",
        CODEX_PROVIDER_HEADER_1: "secret-provider-header",
      },
      providerProtectedValues: ["secret-provider-header"],
    });
    const result = await f.runner.run(f.input);
    expect(result.outcome).toBe("failed");
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("worker");
    for (const secret of [
      "secret-provider-header",
      "secret-lease-token",
      "opaque-token",
      "hidden-value",
    ])
      expect(serialized).not.toContain(secret);
    expect(f.start.mock.calls[0]?.[0].environment.CODEX_PROVIDER_HEADER_0).toBe("worker");
  });

  it("protects every provider value for direct callers that omit classification", async () => {
    const f = fixture({
      result: '{"message":"Typed summary","checks":[]}',
      stderr: "worker 7",
      providerEnvironment: { CODEX_PROVIDER_HEADER_0: "worker", CODEX_PROVIDER_HEADER_1: "7" },
    });
    const result = await f.runner.run(f.input);
    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({
      diagnostics: { summary: expect.not.stringContaining("worker") },
    });
    expect(result).toMatchObject({ diagnostics: { summary: expect.not.stringContaining("7") } });
  });

  it.each([
    { name: "provider text", result: '{"message":"prefix secret-provider-header suffix"}' },
    {
      name: "nested supplied text",
      result: '{"message":{"items":[{"note":"secret-lease-token"}]}}',
    },
    { name: "decoded string escape", result: '{"message":"secret\\u002dprovider\\u002dheader"}' },
    {
      name: "decoded dictionary key",
      result: '{"message":{"secret\\u002dlease\\u002dtoken":"ordinary value"}}',
    },
  ])("rejects $name in a schema-valid result without rewriting its body", async ({ result }) => {
    const f = fixture({
      result,
      outputSchema: Type.Object({ message: Type.Unknown() }, { additionalProperties: false }),
    });
    const outcome = await f.runner.run(f.input);
    expect(outcome).toEqual({
      outcome: "failed",
      code: "CODEX_RESULT_UNSAFE",
      message: "The model result could not be retained safely.",
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
  ])("conservatively matches known protected primitive text: %j", async ({ value, secret }) => {
    const f = fixture({
      result: JSON.stringify({ message: value }),
      outputSchema: Type.Object({ message: Type.Unknown() }, { additionalProperties: false }),
      providerEnvironment: {},
      sensitiveValues: [secret],
    });
    expect(await f.runner.run(f.input)).toEqual({
      outcome: "failed",
      code: "CODEX_RESULT_UNSAFE",
      message: "The model result could not be retained safely.",
      retryable: false,
    });
  });

  it("retains approved public literals and the original canonical result digest", async () => {
    const f = fixture({
      result: '{"message":"worker"}',
      providerEnvironment: { CODEX_PROVIDER_HEADER_0: "worker" },
      providerProtectedValues: [],
      sensitiveValues: [""],
    });
    const expected = createCanonicalResult({ message: "worker" });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: "worker" },
      canonicalResultJson: expected.json,
      resultDigest: expected.sha256,
    });
  });

  it("rejects an approved literal when another protected value has the same text", async () => {
    const f = fixture({
      result: '{"message":"worker"}',
      providerEnvironment: { CODEX_PROVIDER_HEADER_0: "worker", CODEX_PROVIDER_HEADER_1: "worker" },
      providerProtectedValues: ["worker"],
    });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "failed",
      code: "CODEX_RESULT_UNSAFE",
      retryable: false,
    });
  });

  it("does not infer unknown secrets from unrelated model credential-shaped prose", async () => {
    const text =
      "Explain the syntax token=illustrative-value without treating it as a known credential.";
    const f = fixture({ result: JSON.stringify({ message: text }) });
    expect(await f.runner.run(f.input)).toMatchObject({
      outcome: "succeeded",
      result: { message: text },
    });
  });

  it.each(["provider-original-secret", "supplied-original-secret"])(
    "binds the first-await transport and protection snapshots for %s",
    async (returnedSecret) => {
      const environment = { CODEX_PROVIDER_HEADER_0: "provider-original-secret" };
      const protectedValues = ["provider-original-secret"];
      const sensitiveValues = ["supplied-original-secret"];
      const f = fixture({
        result: JSON.stringify({ message: returnedSecret }),
        providerEnvironment: environment,
        providerProtectedValues: protectedValues,
        sensitiveValues,
      });
      const pending = f.runner.run(f.input);
      environment.CODEX_PROVIDER_HEADER_0 = "provider-replacement-secret";
      protectedValues.splice(0);
      sensitiveValues.splice(0);
      f.settings.codexProviderEnvironment = { CODEX_PROVIDER_HEADER_0: "later-replacement" };
      f.settings.codexProviderProtectedValues = [];
      const result = await pending;
      expect(f.start.mock.calls[0]?.[0].environment.CODEX_PROVIDER_HEADER_0).toBe(
        "provider-original-secret",
      );
      expect(result).toMatchObject({
        outcome: "failed",
        code: "CODEX_RESULT_UNSAFE",
        retryable: false,
      });
      expect(JSON.stringify(result)).not.toContain(returnedSecret);
    },
  );

  it("uses the same frozen protection for failure diagnostics after options change", async () => {
    const environment = { CODEX_PROVIDER_HEADER_0: "provider-original-secret" };
    const protectedValues = ["provider-original-secret"];
    const f = fixture({
      result: '{"message":"Typed summary","checks":[]}',
      stderr: "provider-original-secret",
      providerEnvironment: environment,
      providerProtectedValues: protectedValues,
    });
    const pending = f.runner.run(f.input);
    environment.CODEX_PROVIDER_HEADER_0 = "provider-replacement-secret";
    protectedValues.splice(0);
    const result = await pending;
    expect(f.start.mock.calls[0]?.[0].environment.CODEX_PROVIDER_HEADER_0).toBe(
      "provider-original-secret",
    );
    expect(result).toMatchObject({ outcome: "failed", code: "CODEX_INVALID_RESULT_SCHEMA" });
    expect(JSON.stringify(result)).not.toContain("provider-original-secret");
  });

  it("does not invoke provider environment getters while capturing the launch snapshot", async () => {
    const getter = vi.fn(() => "provider-getter-secret");
    const environment = Object.defineProperty({}, "CODEX_PROVIDER_HEADER_0", {
      enumerable: true,
      get: getter,
    });
    const f = fixture({ providerEnvironment: environment });
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      code: "CODEX_LAUNCH_SPEC_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.files.size).toBe(0);
  });

  it("rejects mismatched schema digests before writing control files or starting processes", async () => {
    const f = fixture();
    await expect(
      f.runner.run({
        ...f.input,
        authoritativeSchema: { ...f.input.authoritativeSchema, digest: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "CODEX_LAUNCH_SPEC_INVALID" });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.files.size).toBe(0);
  });

  it("preserves caller cancellation before touching the prepared workspace", async () => {
    const f = fixture();
    const reason = new Error("Lease authority was lost");
    const signal = AbortSignal.abort(reason);
    await expect(f.runner.run({ ...f.input, context: { ...f.context, signal } })).rejects.toBe(
      reason,
    );
    expect(f.files.size).toBe(0);
  });
});
