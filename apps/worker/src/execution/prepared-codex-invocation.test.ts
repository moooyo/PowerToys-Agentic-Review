import { createHash } from "node:crypto";
import { request } from "node:http";
import { win32 } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createCanonicalResult } from "@agentic-review/codex";
import type * as C from "@agentic-review/contracts";
import {
  modelInvocationReceiptSetDigest,
  modelInvocationScopeDigest,
  verifyModelInvocationSubmission,
} from "@agentic-review/domain";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { ModelInvocationApi } from "../server-client/model-invocation-api.js";
import type { JobExecutionContext } from "./job-executor.js";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import {
  createModelInvocationSession,
  ModelInvocationCoordinatorError,
  type ModelInvocationSession,
  type ModelInvocationSessionResult,
} from "./model-invocation-coordinator.js";
import { describeModelResponseRelayPolicy } from "./model-response-relay.js";
import {
  type PreparedCodexOutputInput,
  PreparedCodexOutputRunner,
  type PreparedCodexOutputRunnerOptions,
  type ReviewFileIO,
  type ReviewFileStat,
} from "./prepared-codex-output-runner.js";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessLaunchSpec,
} from "./process-host-protocol.js";

// The only real network endpoint used by these tests is an owned loopback relay. All process,
// file, Server API and upstream provider behavior below is explicitly synthetic.
const endpoint = "https://provider.example.invalid/v1/responses";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const rawResult = { message: "Synthetic typed result." };
const rawDigest = createCanonicalResult(rawResult).sha256;
const events = [
  { type: "thread.started", thread_id: "synthetic-thread" },
  { type: "turn.started" },
  {
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  },
];
const eventText = events.map((event) => `${JSON.stringify(event)}\n`).join("");

function exitEvent(requestId = "synthetic-process"): ProcessExitedEvent {
  return {
    protocolVersion: "1.0",
    type: "exited",
    requestId,
    exitCode: 0,
    signal: null,
    outputTruncated: false,
  };
}

function finishedProcess(): ManagedProcess {
  return {
    requestId: "synthetic-process",
    processId: 31,
    stdout: Readable.from([eventText]),
    stderr: Readable.from([]),
    completed: Promise.resolve(exitEvent()),
    terminate: vi.fn(async () => undefined),
  };
}

function heldProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const completion = Promise.withResolvers<ProcessExitedEvent>();
  const managed: ManagedProcess = {
    requestId: "synthetic-process",
    processId: 32,
    stdout,
    stderr,
    completed: completion.promise,
    terminate: vi.fn(async () => {
      stdout.end();
      stderr.end();
      completion.resolve({ ...exitEvent(), signal: "SIGTERM" });
    }),
  };
  return { managed, stdout, stderr, completion };
}

function fixture() {
  const schema = Type.Object(
    { message: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  );
  const schemaBytes = createCanonicalResult(JSON.parse(JSON.stringify(schema)));
  const controller = new AbortController();
  const files = new Map<string, Buffer>();
  const stat = (path: string): ReviewFileStat => {
    const bytes = files.get(path);
    if (bytes === undefined)
      throw Object.assign(new Error("Missing synthetic file."), { code: "ENOENT" });
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
      if (files.has(path)) throw new Error("A synthetic file already exists.");
      files.set(path, Buffer.from(value));
    }),
    lstat: vi.fn(async (path) => stat(path)),
    realpath: async (path) => path,
    openRead: async (path) => ({
      stat: async () => stat(path),
      read: async (buffer, offset, length, position) => {
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error("Missing synthetic result.");
        const bytesRead = Math.max(0, Math.min(length, bytes.length - position));
        bytes.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      close: async () => undefined,
    }),
  };
  const diskClose = vi.fn(async () => undefined);
  const workspace: PreparedJobWorkspace = {
    attemptDirectory: "C:\\Worker\\synthetic-attempt",
    checkoutDirectory: "C:\\Worker\\synthetic-attempt\\checkout",
    controlDirectory: "C:\\Worker\\synthetic-attempt\\control",
    codexHomeDirectory: "C:\\Worker\\synthetic-attempt\\codex",
    tempDirectory: "C:\\Worker\\synthetic-attempt\\temp",
    userProfileDirectory: "C:\\Worker\\synthetic-attempt\\user",
    startDiskMonitoring: vi.fn(async (signal) => ({
      signal,
      violation: undefined,
      close: diskClose,
    })),
    cleanup: vi.fn(async () => undefined),
  };
  const process = finishedProcess();
  const start = vi.fn(async (_spec: ProcessLaunchSpec, _signal?: AbortSignal) => {
    files.set(win32.join(workspace.controlDirectory, "result.json"), Buffer.from(resultText));
    return process;
  });
  let resultText = JSON.stringify(rawResult);
  const context = {
    signal: controller.signal,
    processHost: { start },
    reportProgress: vi.fn(),
    reportNodeHealthFault: vi.fn(),
  } as unknown as JobExecutionContext;
  const settings: PreparedCodexOutputRunnerOptions = {
    codexExecutablePath: "C:\\Trusted\\codex.exe",
    codexHomeDirectory: "C:\\PersistentProviderProfile",
    codexConfigurationOverrides: [
      'model_provider="legacy_provider"',
      'model_providers.legacy_provider.base_url="https://legacy.example.invalid/v1"',
    ],
    codexProviderEnvironment: { CODEX_PROVIDER_HEADER_0: "synthetic-legacy-provider-secret" },
    systemRoot: "C:\\Windows",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    path: "C:\\Windows\\System32",
    pathExt: ".EXE;.CMD",
    maximumHardTimeoutMs: 60_000,
    maximumProcessCount: 8,
    maximumMemoryBytes: 512 * 1024 ** 2,
    maximumOutputBytes: 4 * 1024 ** 2,
    fileIO,
  };
  const prompt = "Produce a synthetic typed result.";
  const runtime: C.ModelInvocationReceiptSetV1["runtime"] = {
    providerId: "synthetic-provider",
    endpointSha256: sha256(endpoint),
    client: {
      kind: "codex_cli",
      version: "synthetic-cli",
      executableSha256: sha256("synthetic executable"),
      launchPolicySha256: sha256("synthetic declared fixture policy"),
    },
    relay: {
      implementationSha256: sha256("synthetic relay implementation"),
      policySha256: describeModelResponseRelayPolicy({ closeTimeoutMs: 100 }).sha256,
    },
  };
  const expectedIdentity: C.ModelRuntimeIdentityV1 = {
    schemaVersion: "ModelRuntimeIdentityV1",
    ...runtime,
    modelId: "observed-fixture-model",
  };
  const scope: C.ModelInvocationScopeV1 = {
    schemaVersion: "ModelInvocationScopeV1",
    repositoryId: "repository-a",
    evaluationId: "evaluation-a",
    cellId: "cell-a",
    runId: "run-a",
    requestId: "request-a",
    jobId: "job-a",
    attemptId: "attempt-a",
    invocationId: "invocation-a",
    authorizationId: "authorization-a",
    executionManifestSha256: sha256("synthetic manifest"),
    promptSha256: sha256(prompt),
    outputSchemaSha256: schemaBytes.sha256,
    requestedModel: "requested-fixture-model",
    expectedModelIdentitySha256: createCanonicalResult(expectedIdentity).sha256,
    workerNodeId: "worker-a",
    workerInstanceId: "instance-a",
    leaseGeneration: 1,
  };
  const opening: C.ModelInvocationOpeningV1 = {
    schemaVersion: "ModelInvocationOpeningV1",
    scope: structuredClone(scope),
    scopeSha256: modelInvocationScopeDigest(scope),
    runtime: structuredClone(runtime),
    openedAt: new Date().toISOString(),
  };
  const attached = Promise.withResolvers<void>();
  const attachProcess = vi.fn<ModelInvocationSession["attachProcess"]>(() => {
    attached.resolve();
  });
  const recording = (digest: string | null): ModelInvocationSessionResult => ({
    modelOutputBound: digest !== null,
    executionAccepted: false,
    submission: {
      schemaVersion: "ModelInvocationSubmissionV1",
      invocationId: opening.scope.invocationId,
      scopeSha256: opening.scopeSha256,
      receiptSetSha256: sha256("synthetic fake-session ledger"),
      receivedAt: new Date().toISOString(),
      executionAccepted: false,
      consistency:
        digest === null
          ? { state: "unavailable", reasons: ["OUTPUT_UNBOUND"], observedIdentitySha256: null }
          : {
              state: "matched",
              reasons: [],
              observedIdentitySha256: scope.expectedModelIdentitySha256,
            },
    },
  });
  const close = vi.fn<ModelInvocationSession["close"]>(async ({ modelOutputSha256 }) =>
    recording(modelOutputSha256),
  );
  const session: ModelInvocationSession = {
    opening,
    relay: {
      url: "http://127.0.0.1:39999/v1",
      bearerToken: Buffer.alloc(32, 7).toString("base64url"),
    },
    attachProcess,
    close,
  };
  const open = vi.fn(async () => session);
  const input: PreparedCodexOutputInput<typeof schema> = {
    workspace,
    context,
    authoritativeSchema: {
      json: schemaBytes.json,
      digest: schemaBytes.sha256,
      resultSchema: schema,
    },
    prompt,
    hardTimeoutMs: 60_000,
    noProgressTimeoutMs: 30_000,
    teardownTimeoutMs: 100,
    correlationId: "synthetic-log-correlation",
    launchPolicy: "summary_read_only",
    sensitiveValues: ["synthetic-lease-secret"],
    modelInvocation: { expectedScope: scope, open },
  };
  return {
    runner: new PreparedCodexOutputRunner(settings),
    input,
    settings,
    schema,
    scope,
    runtime,
    expectedIdentity,
    opening,
    open,
    close,
    recording,
    session,
    attachProcess,
    attached: attached.promise,
    controller,
    context,
    workspace,
    process,
    start,
    diskClose,
    fileIO,
    files,
    setResult: (text: string) => {
      resultText = text;
    },
  };
}

describe("PreparedCodexOutputRunner parent invocation lifecycle", () => {
  it("opens before dispatch, attaches the exact process, and binds only the raw canonical result", async () => {
    const f = fixture();
    f.open.mockImplementation(async () => {
      expect(f.start).not.toHaveBeenCalled();
      expect(f.fileIO.writeExclusiveUtf8).not.toHaveBeenCalled();
      return f.session;
    });
    f.close.mockImplementation(async ({ modelOutputSha256 }) => {
      await expect(f.attachProcess.mock.calls[0]?.[1]).resolves.toBeUndefined();
      expect(f.diskClose).toHaveBeenCalledOnce();
      return f.recording(modelOutputSha256);
    });
    const result = await f.runner.run(f.input);
    expect(result).toMatchObject({
      outcome: "succeeded",
      result: rawResult,
      resultDigest: rawDigest,
      canonicalResultJson: createCanonicalResult(rawResult).json,
      modelInvocation: { executionAccepted: false, modelOutputBound: true },
    });
    expect(f.attachProcess).toHaveBeenCalledExactlyOnceWith(f.process, expect.any(Promise));
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
    expect(rawDigest).not.toBe(
      createCanonicalResult({ ...rawResult, executionEvidence: { commands: [] } }).sha256,
    );
  });

  it("replaces legacy provider arguments and credentials and uses a fresh per-attempt CODEX_HOME", async () => {
    const f = fixture();
    await f.runner.run(f.input);
    const launch = f.start.mock.calls[0]?.[0];
    expect(launch?.environmentMode).toBe("replace");
    expect(launch?.environment.CODEX_HOME).toBe(f.workspace.codexHomeDirectory);
    expect(launch?.environment.CODEX_HOME).not.toBe(f.workspace.controlDirectory);
    expect(launch?.environment.CODEX_HOME).not.toBe(f.settings.codexHomeDirectory);
    expect(launch?.environment.CODEX_PROVIDER_HEADER_0).toBe(
      `Bearer ${f.session.relay.bearerToken}`,
    );
    expect(launch?.arguments).toContain('model_provider="agentic_review_parent_relay"');
    expect(launch?.arguments.join(" ")).toContain(f.session.relay.url);
    expect(launch?.arguments.join(" ")).not.toContain(f.session.relay.bearerToken);
    expect(JSON.stringify(launch)).not.toContain("synthetic-legacy-provider-secret");
    expect(JSON.stringify(launch)).not.toContain("legacy_provider");
    expect(JSON.stringify(launch)).not.toContain(f.settings.codexHomeDirectory);
    expect(launch?.arguments).toContain("sandbox_workspace_write.network_access=false");
    expect(launch?.arguments).toContain('sandbox_mode="read-only"');
    const reads = vi.mocked(f.fileIO.lstat).mock.calls.map(([path]) => path);
    expect(reads).toContain(win32.join(f.workspace.codexHomeDirectory, "config.toml"));
    expect(reads).toContain(win32.join(f.workspace.codexHomeDirectory, "auth.json"));
    expect(reads.every((path) => !path.startsWith(f.settings.codexHomeDirectory))).toBe(true);
  });

  it.each(["config.toml", "auth.json"])(
    "refuses an existing %s before launching and closes the opened session",
    async (name) => {
      const f = fixture();
      f.files.set(
        win32.join(f.workspace.codexHomeDirectory, name),
        Buffer.from("Synthetic preexisting content."),
      );
      await expect(f.runner.run(f.input)).rejects.toMatchObject({
        code: "MODEL_INVOCATION_HOME_NOT_FRESH",
      });
      expect(f.open).toHaveBeenCalledOnce();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.fileIO.writeExclusiveUtf8).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    },
  );

  it.each([
    ["outside the attempt", "C:\\Worker\\synthetic-attempt-extra\\codex"],
    ["inside the checkout", "C:\\Worker\\synthetic-attempt\\CHECKOUT\\codex"],
    ["equal to the control directory", "C:\\Worker\\synthetic-attempt\\control"],
  ])(
    "refuses a relay home %s before accessing files or launching",
    async (_label, codexHomeDirectory) => {
      const f = fixture();
      await expect(
        f.runner.run({
          ...f.input,
          workspace: { ...f.workspace, codexHomeDirectory: codexHomeDirectory as string },
        }),
      ).rejects.toMatchObject({ code: "MODEL_INVOCATION_HOME_INVALID" });
      expect(f.open).toHaveBeenCalledOnce();
      expect(f.fileIO.lstat).not.toHaveBeenCalled();
      expect(f.fileIO.writeExclusiveUtf8).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    },
  );

  it("does not start or close a nonexistent session after opening fails and does not redispatch that attempt", async () => {
    const f = fixture();
    f.open.mockRejectedValue(new Error("Synthetic private upstream failure."));
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      code: "MODEL_INVOCATION_OPEN_UNCONFIRMED",
    });
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      code: "MODEL_INVOCATION_ATTEMPT_ALREADY_STARTED",
    });
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it.each(["prompt", "schema"])("rejects an unbound actual %s before opening", async (kind) => {
    const f = fixture();
    const input =
      kind === "prompt"
        ? { ...f.input, prompt: "A different synthetic prompt." }
        : {
            ...f.input,
            authoritativeSchema: {
              ...f.input.authoritativeSchema,
              json: `${f.input.authoritativeSchema.json} `,
            },
          };
    await expect(f.runner.run(input)).rejects.toMatchObject({
      code: "MODEL_INVOCATION_CONFIGURATION_INVALID",
    });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each(["attemptId", "cellId", "promptSha256", "outputSchemaSha256"] as const)(
    "closes an opening for the wrong %s without launching",
    async (key) => {
      const f = fixture();
      const wrongScope = {
        ...f.opening.scope,
        [key]: key.endsWith("Sha256") ? sha256("wrong") : "foreign-scope",
      };
      f.open.mockResolvedValue({
        ...f.session,
        opening: {
          ...f.opening,
          scope: wrongScope,
          scopeSha256: modelInvocationScopeDigest(wrongScope),
        },
      });
      await expect(f.runner.run(f.input)).rejects.toMatchObject({
        code: "MODEL_RELAY_LAUNCH_INVALID",
      });
      expect(f.start).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    },
  );

  it("snapshots the scope, stdin and TypeBox schema before asynchronous opening", async () => {
    const f = fixture();
    const opening = Promise.withResolvers<ModelInvocationSession>();
    f.open.mockReturnValue(opening.promise);
    const running = f.runner.run(f.input);
    Object.assign(f.input, { prompt: "Changed after opening began." });
    Object.assign(f.input.authoritativeSchema, { json: "{}", digest: sha256("{}") });
    f.schema.properties.message.maxLength = 1;
    f.scope.attemptId = "changed-attempt";
    Object.assign(f.context, {
      signal: AbortSignal.abort(new Error("Replaced synthetic signal.")),
    });
    opening.resolve(f.session);
    await expect(running).resolves.toMatchObject({ outcome: "succeeded", resultDigest: rawDigest });
    expect(f.start.mock.calls[0]?.[0].standardInput).toBe("Produce a synthetic typed result.");
    expect(
      f.files.get(win32.join(f.workspace.controlDirectory, "schema.json"))?.toString(),
    ).not.toBe("{}");
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
  });

  it("retains supplied protected values across opening and never binds unsafe raw output", async () => {
    const f = fixture();
    const values = ["synthetic-lease-secret"];
    const opening = Promise.withResolvers<ModelInvocationSession>();
    f.open.mockReturnValue(opening.promise);
    f.setResult(JSON.stringify({ message: values[0] }));
    const running = f.runner.run({ ...f.input, sensitiveValues: values });
    values.splice(0);
    opening.resolve(f.session);
    await expect(running).resolves.toMatchObject({
      outcome: "failed",
      code: "CODEX_RESULT_UNSAFE",
    });
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it("keeps previously protected provider values out of retained output after replacing the provider", async () => {
    const f = fixture();
    f.setResult(JSON.stringify({ message: "synthetic-legacy-provider-secret" }));
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "failed",
      code: "CODEX_RESULT_UNSAFE",
    });
    expect(JSON.stringify(f.start.mock.calls[0]?.[0])).not.toContain(
      "synthetic-legacy-provider-secret",
    );
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it("closes without an output if process creation fails", async () => {
    const f = fixture();
    f.start.mockRejectedValue(new Error("Synthetic process failure."));
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      code: "CODEX_PROCESS_START_FAILED",
    });
    expect(f.attachProcess).not.toHaveBeenCalled();
    expect(f.diskClose).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it.each(["stdout", "stderr"] as const)(
    "passes a rejecting drain when %s fails, even though allSettled itself fulfills",
    async (channel) => {
      const f = fixture();
      const failing = Readable.from(
        (async function* () {
          yield "";
          throw new Error("Synthetic stream failure.");
        })(),
      );
      f.start.mockResolvedValue({ ...finishedProcess(), [channel]: failing });
      await expect(f.runner.run(f.input)).rejects.toMatchObject({ code: "CODEX_STREAM_FAILED" });
      await expect(f.attachProcess.mock.calls[0]?.[1]).rejects.toMatchObject({
        code: "CODEX_STREAM_FAILED",
      });
      expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    },
  );

  it("waits for both streams after the process completion event before reading or closing", async () => {
    const f = fixture();
    const held = heldProcess();
    f.start.mockImplementation(async () => {
      f.files.set(
        win32.join(f.workspace.controlDirectory, "result.json"),
        Buffer.from(JSON.stringify(rawResult)),
      );
      return held.managed;
    });
    const running = f.runner.run(f.input);
    await f.attached;
    held.completion.resolve(exitEvent());
    held.stdout.end(eventText);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.close).not.toHaveBeenCalled();
    held.stderr.end();
    await expect(running).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(f.attachProcess.mock.calls[0]?.[1]).resolves.toBeUndefined();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
  });

  it("terminates and drains an unattached process before closing with no output", async () => {
    const f = fixture();
    const held = heldProcess();
    f.start.mockResolvedValue(held.managed);
    f.attachProcess.mockImplementation(() => {
      throw new Error("Synthetic attach failure.");
    });
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      code: "MODEL_INVOCATION_PROCESS_ATTACH_FAILED",
    });
    expect(held.managed.terminate).toHaveBeenCalledExactlyOnceWith("cancelled");
    expect(held.stdout.readableEnded).toBe(true);
    expect(held.stderr.readableEnded).toBe(true);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it("cancels the actual process and closes without binding a partially drained result", async () => {
    const f = fixture();
    const owner = new AbortController();
    const held = heldProcess();
    f.start.mockResolvedValue(held.managed);
    const reason = new Error("Synthetic attempt cancelled.");
    const running = f.runner.run({
      ...f.input,
      context: { ...f.context, attemptSignal: owner.signal },
    });
    const rejected = expect(running).rejects.toBe(reason);
    await f.attached;
    f.controller.abort(reason);
    await rejected;
    expect(held.managed.terminate).toHaveBeenCalledExactlyOnceWith("cancelled");
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expect(owner.signal.aborted).toBe(false);
  });

  it("closes a session returned after cancellation without starting its process", async () => {
    const f = fixture();
    const opening = Promise.withResolvers<ModelInvocationSession>();
    f.open.mockReturnValue(opening.promise);
    const reason = new Error("Synthetic cancellation during opening.");
    const running = f.runner.run(f.input);
    const rejected = expect(running).rejects.toBe(reason);
    f.controller.abort(reason);
    opening.resolve(f.session);
    await rejected;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it("still terminates, drains and closes the disk monitor when the first running progress callback throws", async () => {
    const f = fixture();
    const held = heldProcess();
    f.start.mockResolvedValue(held.managed);
    vi.mocked(f.context.reportProgress).mockImplementation((progress) => {
      if (progress.processCount === 1) throw new Error("Synthetic progress observer failure.");
    });
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      code: "CODEX_PROGRESS_REPORT_FAILED",
    });
    expect(f.start).toHaveBeenCalledOnce();
    expect(held.managed.terminate).toHaveBeenCalledExactlyOnceWith("cancelled");
    expect(held.stdout.readableEnded).toBe(true);
    expect(held.stderr.readableEnded).toBe(true);
    expect(f.diskClose).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it("closes the disk monitor and does not retain output when the final zero-process progress callback throws", async () => {
    const f = fixture();
    vi.mocked(f.context.reportProgress).mockImplementation((progress) => {
      if (progress.processCount === 0 && f.start.mock.calls.length > 0)
        throw new Error("Synthetic final progress observer failure.");
    });
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      code: "CODEX_PROGRESS_REPORT_FAILED",
    });
    await expect(f.attachProcess.mock.calls[0]?.[1]).resolves.toBeUndefined();
    expect(f.diskClose).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it("confirms actual exit and late stream drainage after cancellation even when terminate reports an already exited process", async () => {
    const f = fixture();
    const held = heldProcess();
    const terminationRequested = Promise.withResolvers<void>();
    vi.mocked(held.managed.terminate).mockImplementation(async () => {
      terminationRequested.resolve();
      throw new Error("The synthetic process is no longer active.");
    });
    f.start.mockResolvedValue(held.managed);
    const reason = new Error("Synthetic cancellation after process exit.");
    const running = f.runner.run(f.input);
    const rejected = expect(running).rejects.toBe(reason);
    await f.attached;
    held.completion.resolve(exitEvent());
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.controller.abort(reason);
    await terminationRequested.promise;
    expect(f.close).not.toHaveBeenCalled();
    held.stdout.end(eventText);
    held.stderr.end();
    await rejected;
    expect(held.stdout.readableEnded).toBe(true);
    expect(held.stderr.readableEnded).toBe(true);
    expect(f.diskClose).toHaveBeenCalledOnce();
    expect(f.context.reportNodeHealthFault).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it.each([
    ["not json", "CODEX_INVALID_RESULT_JSON"],
    ['{"message":31}', "CODEX_INVALID_RESULT_SCHEMA"],
  ])("does not bind invalid output %s", async (text, code) => {
    const f = fixture();
    f.setResult(text as string);
    await expect(f.runner.run(f.input)).resolves.toMatchObject({ outcome: "failed", code });
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
  });

  it.each(["SEAL_UNCONFIRMED", "SUBMISSION_UNCONFIRMED"] as const)(
    "replays only the same close intent after %s, without redispatch",
    async (code) => {
      const f = fixture();
      f.close.mockRejectedValueOnce(new ModelInvocationCoordinatorError(code));
      await expect(f.runner.run(f.input)).resolves.toMatchObject({ outcome: "succeeded" });
      expect(f.close).toHaveBeenCalledTimes(2);
      expect(f.close.mock.calls[0]?.[0]).toBe(f.close.mock.calls[1]?.[0]);
      expect(f.close.mock.calls.map(([value]) => value)).toEqual([
        { modelOutputSha256: rawDigest },
        { modelOutputSha256: rawDigest },
      ]);
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.open).toHaveBeenCalledOnce();
    },
  );

  it("does not claim success or reopen an attempt after recording recovery remains uncertain", async () => {
    const f = fixture();
    f.close.mockRejectedValue(new ModelInvocationCoordinatorError("SUBMISSION_UNCONFIRMED"));
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "failed",
      code: "MODEL_INVOCATION_RECORDING_UNCONFIRMED",
    });
    await expect(
      new PreparedCodexOutputRunner(f.settings).run({
        ...f.input,
        modelInvocation: {
          expectedScope: { ...f.scope, invocationId: "new-invocation" },
          open: f.open,
        },
      }),
    ).rejects.toMatchObject({ code: "MODEL_INVOCATION_ATTEMPT_ALREADY_STARTED" });
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.close.mock.calls.every(([value]) => value.modelOutputSha256 === rawDigest)).toBe(true);
  });

  it("does not retry a nontransport closure error or return its otherwise valid output", async () => {
    const f = fixture();
    f.close.mockRejectedValue(new ModelInvocationCoordinatorError("RELAY_CLOSE_UNCONFIRMED"));
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "failed",
      code: "MODEL_INVOCATION_RECORDING_UNCONFIRMED",
    });
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
    expect(f.start).toHaveBeenCalledOnce();
  });

  it("does not retry recording after child execution cancellation while its attempt owner remains active", async () => {
    const f = fixture();
    const owner = new AbortController();
    const reason = new Error("Synthetic child budget cancelled during recording.");
    f.close.mockImplementationOnce(async () => {
      f.controller.abort(reason);
      throw new ModelInvocationCoordinatorError("SUBMISSION_UNCONFIRMED");
    });
    await expect(
      f.runner.run({ ...f.input, context: { ...f.context, attemptSignal: owner.signal } }),
    ).rejects.toBe(reason);
    expect(owner.signal.aborted).toBe(false);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
    expect(f.start).toHaveBeenCalledOnce();
  });

  it.each(["unbound", "mismatched"] as const)(
    "refuses a confirmed but %s recording",
    async (kind) => {
      const f = fixture();
      const recording = f.recording(rawDigest);
      f.close.mockResolvedValue(
        kind === "unbound"
          ? { ...recording, modelOutputBound: false }
          : {
              ...recording,
              submission: {
                ...recording.submission,
                consistency: {
                  state: "mismatched",
                  reasons: ["RUNTIME_IDENTITY_MISMATCH"],
                  observedIdentitySha256: sha256("different identity"),
                },
              },
            },
      );
      await expect(f.runner.run(f.input)).resolves.toMatchObject({
        outcome: "failed",
        code: "MODEL_INVOCATION_OUTPUT_UNBOUND",
      });
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects concurrent and subsequent runs of the same attempt owner with fresh child signals and runner wrappers", async () => {
    const f = fixture();
    const owner = new AbortController();
    const opening = Promise.withResolvers<ModelInvocationSession>();
    f.open.mockReturnValue(opening.promise);
    const running = f.runner.run({
      ...f.input,
      context: { ...f.context, attemptSignal: owner.signal },
    });
    await expect(
      new PreparedCodexOutputRunner(f.settings).run({
        ...f.input,
        context: {
          ...f.context,
          signal: new AbortController().signal,
          attemptSignal: owner.signal,
        },
        modelInvocation: { expectedScope: { ...f.scope }, open: f.open },
      }),
    ).rejects.toMatchObject({ code: "MODEL_INVOCATION_ATTEMPT_ALREADY_STARTED" });
    opening.resolve(f.session);
    await expect(running).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(
      f.runner.run({
        ...f.input,
        context: {
          ...f.context,
          signal: new AbortController().signal,
          attemptSignal: owner.signal,
        },
      }),
    ).rejects.toMatchObject({ code: "MODEL_INVOCATION_ATTEMPT_ALREADY_STARTED" });
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledOnce();
  });

  it("retains the attempt claim across an unconfirmed opening and a replacement child signal", async () => {
    const f = fixture();
    const owner = new AbortController();
    f.open.mockRejectedValueOnce(new Error("Synthetic opening uncertainty."));
    await expect(
      f.runner.run({ ...f.input, context: { ...f.context, attemptSignal: owner.signal } }),
    ).rejects.toMatchObject({ code: "MODEL_INVOCATION_OPEN_UNCONFIRMED" });
    await expect(
      new PreparedCodexOutputRunner(f.settings).run({
        ...f.input,
        context: {
          ...f.context,
          signal: new AbortController().signal,
          attemptSignal: owner.signal,
        },
      }),
    ).rejects.toMatchObject({ code: "MODEL_INVOCATION_ATTEMPT_ALREADY_STARTED" });
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("allows independent root attempt owners even when they share an execution signal", async () => {
    const first = fixture();
    const next = fixture();
    const execution = new AbortController();
    for (const current of [first, next]) {
      await expect(
        current.runner.run({
          ...current.input,
          context: {
            ...current.context,
            signal: execution.signal,
            attemptSignal: current.controller.signal,
          },
        }),
      ).resolves.toMatchObject({ outcome: "succeeded" });
      expect(current.open).toHaveBeenCalledOnce();
      expect(current.start).toHaveBeenCalledOnce();
    }
  });

  it.each(["workerInstanceId", "leaseGeneration"] as const)(
    "does not reopen the same owned job and attempt by replacing %s",
    async (field) => {
      const f = fixture();
      const owner = new AbortController();
      f.open.mockRejectedValueOnce(new Error("Synthetic uncertain opening."));
      await expect(
        f.runner.run({ ...f.input, context: { ...f.context, attemptSignal: owner.signal } }),
      ).rejects.toMatchObject({ code: "MODEL_INVOCATION_OPEN_UNCONFIRMED" });
      await expect(
        new PreparedCodexOutputRunner(f.settings).run({
          ...f.input,
          context: {
            ...f.context,
            signal: new AbortController().signal,
            attemptSignal: owner.signal,
          },
          modelInvocation: {
            expectedScope: {
              ...f.scope,
              ...(field === "workerInstanceId"
                ? { workerInstanceId: "replacement-instance" }
                : { leaseGeneration: 2 }),
            },
            open: f.open,
          },
        }),
      ).rejects.toMatchObject({ code: "MODEL_INVOCATION_ATTEMPT_ALREADY_STARTED" });
      expect(f.open).toHaveBeenCalledOnce();
      expect(f.start).not.toHaveBeenCalled();
    },
  );

  it("allows a genuinely different attempt owned by the same stable signal", async () => {
    const first = fixture();
    const next = fixture();
    next.scope.attemptId = "attempt-b";
    next.opening.scope.attemptId = "attempt-b";
    next.opening.scopeSha256 = modelInvocationScopeDigest(next.opening.scope);
    await expect(first.runner.run(first.input)).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(
      next.runner.run({
        ...next.input,
        context: { ...next.context, signal: first.controller.signal },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded" });
    expect(first.start).toHaveBeenCalledOnce();
    expect(next.start).toHaveBeenCalledOnce();
  });
});

function postSyntheticResponse(
  relay: ModelInvocationSession["relay"],
  model: string,
  prompt: string,
): Promise<string> {
  const body = JSON.stringify({ model, stream: false, input: prompt });
  return new Promise((resolve, reject) => {
    const outgoing = request(
      `${relay.url}/responses`,
      {
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${relay.bearerToken}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("aborted", () => reject(new Error("Synthetic relay response aborted.")));
        incoming.once("end", () =>
          incoming.statusCode === 200
            ? resolve(Buffer.concat(chunks).toString("utf8"))
            : reject(new Error("Synthetic relay rejected the request.")),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.setTimeout(2_000, () =>
      outgoing.destroy(new Error("Synthetic loopback request timed out.")),
    );
    outgoing.end(body);
  });
}

it("runs the real coordinator and loopback relay, drains synthetic process output, and seals the observed raw JSON before submission", async () => {
  const f = fixture();
  const order: string[] = [];
  let recordedOpening: C.ModelInvocationOpeningV1 | undefined;
  let recordedSeal: C.ModelInvocationSealV1 | undefined;
  let session: ModelInvocationSession | undefined;
  const api = {
    beginModelInvocation: vi.fn<ModelInvocationApi["beginModelInvocation"]>(async () => {
      order.push("opening");
      recordedOpening = { ...structuredClone(f.opening), openedAt: new Date().toISOString() };
      return recordedOpening;
    }),
    sealModelInvocation: vi.fn<ModelInvocationApi["sealModelInvocation"]>(async (value) => {
      order.push("seal");
      const { lease: _lease, ...closure } = value;
      recordedSeal = {
        schemaVersion: "ModelInvocationSealV1",
        ...closure,
        recordedAt: new Date().toISOString(),
      };
      return recordedSeal;
    }),
    submitModelInvocationReceipts: vi.fn<ModelInvocationApi["submitModelInvocationReceipts"]>(
      async (value) => {
        order.push("submit");
        if (recordedOpening === undefined || recordedSeal === undefined)
          throw new Error("Missing synthetic opening or independent seal.");
        return {
          schemaVersion: "ModelInvocationSubmissionV1",
          invocationId: value.invocationId,
          scopeSha256: recordedOpening.scopeSha256,
          receiptSetSha256: modelInvocationReceiptSetDigest(value.receiptSet),
          receivedAt: new Date().toISOString(),
          executionAccepted: false,
          consistency: verifyModelInvocationSubmission({
            opening: recordedOpening,
            seal: recordedSeal,
            receiptSet: value.receiptSet,
            expectedIdentity: f.expectedIdentity,
          }),
        };
      },
    ),
  };
  const transport = vi.fn<typeof fetch>(async () => {
    order.push("synthetic-provider-response");
    return new Response(
      JSON.stringify({
        id: "resp_synthetic",
        object: "response",
        created_at: 1740855869,
        status: "completed",
        model: "observed-fixture-model",
        error: null,
        incomplete_details: null,
        output: [
          {
            id: "msg_synthetic",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(rawResult), annotations: [] }],
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const open = vi.fn(async () => {
    session = await createModelInvocationSession({
      api,
      lease: {
        jobId: f.scope.jobId,
        runAttemptId: f.scope.attemptId,
        workerNodeId: f.scope.workerNodeId,
        workerInstanceId: f.scope.workerInstanceId,
        leaseGeneration: 1,
        leaseToken: "synthetic-lease-token-01234567890123456789",
      },
      expectedScope: f.scope,
      runtime: f.runtime,
      operationTimeoutMs: 1_000,
      processTimeoutMs: 1_000,
      relayOptions: {
        endpoint,
        signal: f.controller.signal,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        limits: { closeTimeoutMs: 100 },
        transport,
        authorize: async () => ({
          headers: { Authorization: "Bearer synthetic-parent-only-provider-secret" },
          protectedValues: [],
        }),
      },
    });
    return session;
  });
  const held = heldProcess();
  let syntheticProcessTask: Promise<void> | undefined;
  f.start.mockImplementation(async (launch) => {
    order.push("process-start");
    const opened = session;
    if (opened === undefined) throw new Error("Dispatch occurred before the synthetic opening.");
    expect(launch.environment.CODEX_HOME).toBe(f.workspace.codexHomeDirectory);
    expect(launch.environment.CODEX_PROVIDER_HEADER_0).toBe(`Bearer ${opened.relay.bearerToken}`);
    expect(JSON.stringify(launch)).not.toContain("synthetic-parent-only-provider-secret");
    syntheticProcessTask = (async () => {
      await postSyntheticResponse(opened.relay, f.scope.requestedModel, f.input.prompt);
      f.files.set(
        win32.join(f.workspace.controlDirectory, "result.json"),
        Buffer.from(JSON.stringify(rawResult)),
      );
      held.completion.resolve(exitEvent());
      order.push("process-exited");
      held.stdout.end(eventText);
      held.stderr.end();
    })().catch((error: unknown) => {
      held.stdout.destroy();
      held.stderr.destroy();
      held.completion.reject(error);
    });
    return held.managed;
  });
  try {
    const result = await f.runner.run({
      ...f.input,
      modelInvocation: { expectedScope: f.scope, open },
    });
    await syntheticProcessTask;
    expect(result).toMatchObject({
      outcome: "succeeded",
      resultDigest: rawDigest,
      modelInvocation: {
        modelOutputBound: true,
        executionAccepted: false,
        submission: { executionAccepted: false, consistency: { state: "matched", reasons: [] } },
      },
    });
    expect(order).toEqual([
      "opening",
      "process-start",
      "synthetic-provider-response",
      "process-exited",
      "seal",
      "submit",
    ]);
    expect(f.start).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(api.sealModelInvocation).toHaveBeenCalledOnce();
    expect(api.submitModelInvocationReceipts).toHaveBeenCalledOnce();
    const sealed = api.sealModelInvocation.mock.calls[0]?.[0];
    const submitted = api.submitModelInvocationReceipts.mock.calls[0]?.[0];
    expect(sealed).toMatchObject({
      modelOutputSha256: rawDigest,
      processClosed: true,
      relayClosed: true,
      callCount: 1,
    });
    expect(submitted?.receiptSet.calls[0]?.receipt.response).toMatchObject({
      outputJsonSha256: rawDigest,
      outcome: "completed",
    });
    expect(sealed?.receiptSetSha256).toBe(
      modelInvocationReceiptSetDigest(submitted?.receiptSet as C.ModelInvocationReceiptSetV1),
    );
    expect(held.stdout.readableEnded).toBe(true);
    expect(held.stderr.readableEnded).toBe(true);
    if (session === undefined) throw new Error("The synthetic session did not open.");
    await expect(
      postSyntheticResponse(session.relay, f.scope.requestedModel, f.input.prompt),
    ).rejects.toBeDefined();
  } finally {
    f.controller.abort();
    await held.managed.terminate("cancelled");
    // Reuse the selected intent if the runner already closed; never use a fresh close(null).
    await session?.close({ modelOutputSha256: rawDigest }).catch(() => undefined);
    await syntheticProcessTask;
  }
});
