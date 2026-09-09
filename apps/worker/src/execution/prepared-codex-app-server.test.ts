import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { composeSummaryPrompt, createCanonicalResult } from "@agentic-review/codex";
import type * as C from "@agentic-review/contracts";
import { modelInvocationScopeDigest } from "@agentic-review/domain";
import { Type } from "@sinclair/typebox";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerSessionConfiguration,
  type CodexAppServerModelParameters,
} from "./codex-app-server-session-policy.js";
import type { JobExecutionContext } from "./job-executor.js";
import type { PreparedJobWorkspace } from "./job-workspace.js";
import {
  ModelInvocationCoordinatorError,
  type ModelInvocationSession,
  type ModelInvocationSessionResult,
} from "./model-invocation-coordinator.js";
import {
  type PreparedCodexOutputInput,
  PreparedCodexOutputRunner,
  type PreparedCodexOutputRunnerOptions,
  type ReviewFileIO,
} from "./prepared-codex-output-runner.js";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessLaunchSpec,
  ProcessTerminationReason,
} from "./process-host-protocol.js";
import { WorkspaceDiskBudgetError } from "./workspace-disk-budget.js";

// Every process, RPC response, file observation and invocation receipt in this file is synthetic.
// The production launch builder, session policy, transport, output collector and turn driver run
// unchanged; no CLI, listener, provider, Server or filesystem operation is started by this fixture.
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const binarySha256 = sha256("synthetic app-server executable");
const relayUrl = "http://127.0.0.1:39998/v1";
const relayToken = Buffer.alloc(32, 9).toString("base64url");
const requestedModel = "synthetic-prepared-model";
const threadId = "thread-prepared-synthetic";
const turnId = "turn-prepared-synthetic";
const rawResult = { message: "Synthetic app-server result." };
const rawDigest = createCanonicalResult(rawResult).sha256;
const explicitModelParameters = {
  modelReasoningEffort: "xhigh",
  modelContextWindow: 200000,
  modelAutoCompactTokenLimit: 150000,
} as const;
const modelParameterKeys = [
  "model_reasoning_effort",
  "model_context_window",
  "model_auto_compact_token_limit",
] as const;
const workspaceLayout = {
  attemptDirectory: "C:\\Worker\\synthetic-app-attempt",
  checkoutDirectory: "C:\\Worker\\synthetic-app-attempt\\checkout",
  controlDirectory: "C:\\Worker\\synthetic-app-attempt\\control",
  codexHomeDirectory: "C:\\Worker\\synthetic-app-attempt\\codex",
  tempDirectory: "C:\\Worker\\synthetic-app-attempt\\temp",
  userProfileDirectory: "C:\\Worker\\synthetic-app-attempt\\user",
};

interface RpcRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}
interface SyntheticPolicyFixture {
  readonly responses: Readonly<Record<string, unknown>>;
  readonly launchPolicySha256: string;
}

function policyFixture(parameters: CodexAppServerModelParameters = {}): SyntheticPolicyFixture {
  const configuration = buildCodexAppServerSessionConfiguration({
    purpose: "summary_read_only",
    requestedModel,
    relayUrl,
    codexHomeDirectory: workspaceLayout.codexHomeDirectory,
    checkoutDirectory: workspaceLayout.checkoutDirectory,
    controlDirectory: workspaceLayout.controlDirectory,
    tempDirectory: workspaceLayout.tempDirectory,
    userProfileDirectory: workspaceLayout.userProfileDirectory,
    shellEnvironment: {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
      SYSTEMROOT: "C:\\Windows",
      TEMP: workspaceLayout.tempDirectory,
      TMP: workspaceLayout.tempDirectory,
      USERPROFILE: workspaceLayout.userProfileDirectory,
    },
    commandNetworkDomains: [],
    ...parameters,
  });
  const config = parse(configuration.overrides.join("\n")) as Record<string, unknown>;
  config.model_reasoning_effort = configuration.expected.modelReasoningEffort;
  config.model_context_window = configuration.expected.modelContextWindow;
  config.model_auto_compact_token_limit = configuration.expected.modelAutoCompactTokenLimit;
  for (const key of [
    "sandbox_mode",
    "sandbox_workspace_write",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
    "instructions",
    "developer_instructions",
    "model_instructions_file",
    "experimental_compact_prompt_file",
    "profile",
    "projects",
    "skills",
    "hooks",
    "agents",
  ])
    config[key] = null;
  config.tools = null;
  const permission = (
    config.permissions as Record<
      string,
      {
        filesystem: Record<string, unknown>;
        network: Record<string, unknown>;
      }
    >
  )[configuration.permissionProfile];
  if (permission === undefined) throw new Error("The synthetic permission profile is missing.");
  permission.filesystem.glob_scan_max_depth = null;
  permission.network.socks_url = null;
  const provider = (config.model_providers as Record<string, Record<string, unknown>>)
    .agentic_review_parent_relay;
  if (provider === undefined) throw new Error("The synthetic relay provider is missing.");
  for (const key of [
    "env_key",
    "env_key_instructions",
    "experimental_bearer_token",
    "auth",
    "aws",
    "query_params",
    "http_headers",
    "websocket_connect_timeout_ms",
  ])
    provider[key] = null;
  const initialization = {
    codexHome: workspaceLayout.codexHomeDirectory,
    platformFamily: "windows",
    platformOs: "windows",
  };
  const configRead = { config };
  const requirements = { requirements: null };
  const permissionProfiles = {
    data: [
      { id: ":read-only", description: null, allowed: true },
      { id: configuration.permissionProfile, description: null, allowed: true },
    ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    nextCursor: null,
  };
  const readiness = { status: "ready" };
  const threadFields = {
    cwd: workspaceLayout.checkoutDirectory,
    cliVersion: "0.145.0",
    ephemeral: true,
    modelProvider: "agentic_review_parent_relay",
  };
  const thread = {
    thread: threadFields,
    cwd: workspaceLayout.checkoutDirectory,
    model: requestedModel,
    modelProvider: "agentic_review_parent_relay",
    runtimeWorkspaceRoots: [workspaceLayout.checkoutDirectory],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    activePermissionProfile: { id: configuration.permissionProfile, extends: null },
    sandbox: { type: "readOnly", networkAccess: true },
    reasoningEffort: configuration.expected.modelReasoningEffort,
    multiAgentMode: "explicitRequestOnly",
  };
  const features = {
    data: Object.entries(config.features as Record<string, boolean>)
      .map(([name, enabled]) => ({
        name,
        enabled,
        defaultEnabled: false,
        stage: "stable",
        displayName: null,
        description: null,
        announcement: null,
      }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    nextCursor: null,
  };
  // This is the documented stable projection of the synthetic responses, not a claim about an
  // actual binary or sandbox. Process-local IDs and literal owned paths are excluded from it.
  const replacements = new Map([
    [relayUrl, "$PARENT_RELAY_URL"],
    [workspaceLayout.codexHomeDirectory, "$CODEX_HOME"],
    [workspaceLayout.checkoutDirectory, "$CHECKOUT"],
    [workspaceLayout.controlDirectory, "$CONTROL"],
    [workspaceLayout.tempDirectory, "$TEMP"],
    [workspaceLayout.userProfileDirectory, "$USERPROFILE"],
  ]);
  const stable = (value: unknown): unknown => {
    if (typeof value === "string") return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [replacements.get(key) ?? key, stable(child)]),
      );
    return value;
  };
  const projection = {
    schemaVersion: "CodexAppServerConfigurationProjectionV1",
    initialization,
    configRead,
    requirements,
    permissionProfiles,
    readiness,
    thread,
    features,
  };
  const normalized = stable(projection) as typeof projection;
  const modelConfig = normalized.configRead.config as Record<string, unknown>;
  if (typeof config.model_reasoning_effort === "string")
    modelConfig.model_reasoning_effort = config.model_reasoning_effort;
  if (typeof thread.reasoningEffort === "string")
    normalized.thread.reasoningEffort = thread.reasoningEffort;
  const launchPolicySha256 = createCanonicalResult(normalized).sha256;
  return {
    launchPolicySha256,
    responses: {
      initialize: {
        ...initialization,
        userAgent: "agentic_review_worker/0.145.0 (Windows synthetic fixture)",
      },
      "config/read": { ...configRead, origins: {}, layers: [] },
      "configRequirements/read": requirements,
      "permissionProfile/list": permissionProfiles,
      "windowsSandbox/readiness": readiness,
      "thread/start": {
        ...thread,
        thread: {
          id: threadId,
          sessionId: threadId,
          createdAt: 1,
          updatedAt: 2,
          recencyAt: 2,
          preview: "",
          status: { type: "idle" },
          turns: [],
          ...threadFields,
        },
      },
      "experimentalFeature/list": features,
    },
  };
}

const turn = (status = "inProgress") => ({
  id: turnId,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 10,
  completedAt: status === "inProgress" ? null : 11,
  durationMs: null,
});

class SyntheticProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited = Promise.withResolvers<ProcessExitedEvent>();
  readonly turnRequested = Promise.withResolvers<RpcRequest>();
  readonly messages: Array<{ id?: string; method: string; params?: unknown }> = [];
  readonly requests: RpcRequest[] = [];
  readonly responses: Record<string, unknown>;
  autoCompleteTurn = true;
  resultText: string | undefined;
  complete = false;
  private bufferedInput = Buffer.alloc(0);

  constructor(responses: Readonly<Record<string, unknown>>) {
    this.responses = structuredClone(responses);
  }

  readonly write = vi.fn(async (bytes: Uint8Array, _signal?: AbortSignal) => {
    this.bufferedInput = Buffer.concat([this.bufferedInput, Buffer.from(bytes)]);
    for (;;) {
      const newline = this.bufferedInput.indexOf(10);
      if (newline < 0) return;
      const message = JSON.parse(this.bufferedInput.subarray(0, newline).toString("utf8")) as {
        id?: string;
        method: string;
        params?: unknown;
      };
      this.bufferedInput = this.bufferedInput.subarray(newline + 1);
      this.messages.push(message);
      if (typeof message.id !== "string") continue;
      const request: RpcRequest = { ...message, id: message.id };
      this.requests.push(request);
      if (request.method === "turn/start") {
        this.turnRequested.resolve(request);
        this.reply(request.id, { turn: turn() });
        if (this.autoCompleteTurn) this.finishTurn();
      } else {
        if (!Object.hasOwn(this.responses, request.method))
          throw new Error("The synthetic policy has no response for this RPC method.");
        this.reply(request.id, this.responses[request.method]);
      }
    }
  });
  readonly closeInput = vi.fn(async (_signal?: AbortSignal) => this.finish());
  readonly terminate = vi.fn(async (_reason: ProcessTerminationReason) => this.finish());
  readonly managed: ManagedProcess = {
    requestId: "process:synthetic-prepared-app-server",
    processId: 89,
    processCreationTimeFileTime: "133801632001234567",
    stdin: {
      streamId: "c".repeat(64),
      write: this.write,
      close: this.closeInput,
    },
    stdout: this.stdout,
    stderr: this.stderr,
    completed: this.exited.promise,
    terminate: this.terminate,
  };

  reply(id: string, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }
  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
  finishTurn(): void {
    this.notify("turn/started", { threadId, turn: turn() });
    this.notify("item/started", {
      threadId,
      turnId,
      item: { id: "final", type: "agentMessage", text: "", phase: "final_answer" },
      startedAtMs: 100,
    });
    this.notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: "final",
        type: "agentMessage",
        text: this.resultText ?? JSON.stringify(rawResult),
        phase: "final_answer",
      },
      completedAtMs: 101,
    });
    this.notify("turn/completed", { threadId, turn: turn("completed") });
  }
  finish(): void {
    this.stdout.end();
    this.stderr.end();
    if (this.complete) return;
    this.complete = true;
    this.exited.resolve({
      protocolVersion: "1.0",
      type: "exited",
      requestId: this.managed.requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });
  }
}

const processes: SyntheticProcess[] = [];

function fixture(policy: SyntheticPolicyFixture, parameters: CodexAppServerModelParameters = {}) {
  const schema = Type.Object(
    { message: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  );
  const authority = createCanonicalResult(JSON.parse(JSON.stringify(schema)));
  const controller = new AbortController();
  const owner = new AbortController();
  const diskController = new AbortController();
  let diskViolation: WorkspaceDiskBudgetError | undefined;
  const fileIO: ReviewFileIO = {
    writeExclusiveUtf8: vi.fn(async () => {
      throw new Error("The app-server branch must not write a schema or result file.");
    }),
    lstat: vi.fn(async (path) => {
      if (
        path !== win32.join(workspaceLayout.codexHomeDirectory, "config.toml") &&
        path !== win32.join(workspaceLayout.codexHomeDirectory, "auth.json")
      )
        throw new Error("The app-server branch may only inspect fresh-home config and auth paths.");
      throw Object.assign(new Error("The synthetic fresh-home file is absent."), {
        code: "ENOENT",
      });
    }),
    realpath: vi.fn(async () => {
      throw new Error("The app-server branch must not resolve model output files.");
    }),
    openRead: vi.fn(async () => {
      throw new Error("The app-server branch must not read a model output file.");
    }),
  };
  const diskClose = vi.fn(async () => undefined);
  const workspace: PreparedJobWorkspace = {
    ...workspaceLayout,
    startDiskMonitoring: vi.fn(async (signal) => ({
      signal: AbortSignal.any([signal, diskController.signal]),
      get violation() {
        return diskViolation;
      },
      close: diskClose,
    })),
    cleanup: vi.fn(async () => undefined),
  };
  const process = new SyntheticProcess(policy.responses);
  processes.push(process);
  const start = vi.fn(async (_spec: ProcessLaunchSpec, _signal?: AbortSignal) => process.managed);
  const context: JobExecutionContext = {
    signal: controller.signal,
    attemptSignal: owner.signal,
    processHost: {
      start,
      terminateAll: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    reportProgress: vi.fn(),
    reportNodeHealthFault: vi.fn(),
    deferCleanup: vi.fn(),
  };
  const backend = {
    kind: "app_server" as const,
    codexExecutableSha256: binarySha256,
    commandNetworkDomains: [] as string[],
    ...parameters,
  };
  const settings: PreparedCodexOutputRunnerOptions = {
    codexExecutablePath: "C:\\Trusted\\codex.exe",
    codexHomeDirectory: "C:\\PersistentProviderProfile",
    codexConfigurationOverrides: ['model_provider="legacy_provider"'],
    codexProviderEnvironment: { CODEX_PROVIDER_HEADER_0: "synthetic-legacy-secret" },
    systemRoot: "C:\\Windows",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    path: "C:\\Windows\\System32",
    pathExt: ".EXE;.CMD",
    maximumHardTimeoutMs: 60_000,
    maximumProcessCount: 8,
    maximumMemoryBytes: 512 * 1024 ** 2,
    maximumOutputBytes: 4 * 1024 ** 2,
    modelInvocationBackend: backend,
    fileIO,
  };
  const prompt = "Return the synthetic app-server result.";
  const runtime: C.ModelInvocationReceiptSetV1["runtime"] = {
    providerId: "synthetic-upstream-provider",
    endpointSha256: sha256("https://synthetic-provider.example.invalid/v1/responses"),
    client: {
      kind: "codex_cli",
      version: "0.145.0",
      executableSha256: binarySha256,
      launchPolicySha256: policy.launchPolicySha256,
    },
    relay: {
      implementationSha256: sha256("synthetic parent relay implementation"),
      policySha256: sha256("synthetic parent relay policy"),
    },
  };
  const identity = {
    schemaVersion: "ModelRuntimeIdentityV1" as const,
    ...runtime,
    modelId: "synthetic-observed-model",
  };
  const scope: C.ModelInvocationScopeV1 = {
    schemaVersion: "ModelInvocationScopeV1",
    repositoryId: "repository-synthetic",
    evaluationId: "evaluation-synthetic",
    cellId: "cell-synthetic",
    runId: "run-synthetic",
    requestId: "request-synthetic",
    jobId: "job-synthetic",
    attemptId: "attempt-synthetic",
    invocationId: "invocation-synthetic",
    authorizationId: "authorization-synthetic",
    executionManifestSha256: sha256("synthetic execution manifest"),
    promptSha256: sha256(prompt),
    outputSchemaSha256: authority.sha256,
    requestedModel,
    expectedModelIdentitySha256: createCanonicalResult(identity).sha256,
    workerNodeId: "worker-synthetic",
    workerInstanceId: "instance-synthetic",
    leaseGeneration: 1,
  };
  const opening: C.ModelInvocationOpeningV1 = {
    schemaVersion: "ModelInvocationOpeningV1",
    scope: structuredClone(scope),
    scopeSha256: modelInvocationScopeDigest(scope),
    runtime: structuredClone(runtime),
    openedAt: "2026-09-08T00:00:00.000Z",
  };
  const attached = Promise.withResolvers<void>();
  const attachProcess = vi.fn<ModelInvocationSession["attachProcess"]>(() => attached.resolve());
  const recording = (modelOutputSha256: string | null): ModelInvocationSessionResult => ({
    modelOutputBound: modelOutputSha256 !== null,
    executionAccepted: false,
    submission: {
      schemaVersion: "ModelInvocationSubmissionV1",
      invocationId: opening.scope.invocationId,
      scopeSha256: opening.scopeSha256,
      receiptSetSha256: sha256("synthetic fake-session receipt ledger"),
      receivedAt: "2026-09-08T00:00:01.000Z",
      executionAccepted: false,
      consistency:
        modelOutputSha256 === null
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
    relay: { url: relayUrl, bearerToken: relayToken },
    attachProcess,
    close,
  };
  const open = vi.fn(async () => session);
  const input: PreparedCodexOutputInput<typeof schema> = {
    workspace,
    context,
    authoritativeSchema: { json: authority.json, digest: authority.sha256, resultSchema: schema },
    prompt,
    hardTimeoutMs: 60_000,
    noProgressTimeoutMs: 30_000,
    teardownTimeoutMs: 100,
    correlationId: "synthetic-app-server-correlation",
    launchPolicy: "summary_read_only",
    sensitiveValues: ["synthetic-parent-lease-secret"],
    modelInvocation: { expectedScope: scope, open },
  };
  return {
    runner: new PreparedCodexOutputRunner(settings),
    input,
    settings,
    backend,
    workspace,
    context,
    controller,
    owner,
    process,
    start,
    opening,
    session,
    scope,
    attachProcess,
    attached: attached.promise,
    open,
    close,
    recording,
    diskClose,
    fileIO,
    violateDisk: () => {
      diskViolation = new WorkspaceDiskBudgetError(
        "CURRENT_ATTEMPT_LIMIT_EXCEEDED",
        "The synthetic attempt exceeded its disk allowance.",
      );
      diskController.abort(diskViolation);
    },
  };
}

function summaryInput(f: ReturnType<typeof fixture>) {
  const context = '{"synthetic":"frozen summary context"}';
  const prompt = composeSummaryPrompt(f.input.prompt, context);
  const scope: C.ModelInvocationScopeV2 = {
    ...f.scope,
    schemaVersion: "ModelInvocationScopeV2",
    purpose: "validation_summary",
    inputRef: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "summary-input",
      inputSha256: sha256("synthetic frozen summary record"),
      sourcePromptSha256: f.scope.promptSha256,
      outputSchemaSha256: f.scope.outputSchemaSha256,
      contextSha256: sha256(context),
      actualPromptSha256: sha256(prompt),
    },
  };
  Object.assign(f.opening, {
    schemaVersion: "ModelInvocationOpeningV2",
    scope: structuredClone(scope),
    scopeSha256: modelInvocationScopeDigest(scope),
  });
  return { ...f.input, prompt, modelInvocation: { expectedScope: scope, open: f.open } };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(async () => {
  for (const process of processes.splice(0)) process.finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.useRealTimers();
});

async function nonSuccess(promise: ReturnType<PreparedCodexOutputRunner["run"]>) {
  const settled = await promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  if ("result" in settled) {
    expect(settled.result.outcome).toBe("failed");
    return settled.result;
  }
  expect(settled.error).toBeInstanceOf(Error);
  expect(settled.error).toMatchObject({ code: expect.any(String) });
  return settled.error;
}

async function turnRequest(
  f: ReturnType<typeof fixture>,
  running: ReturnType<PreparedCodexOutputRunner["run"]>,
): Promise<RpcRequest> {
  return Promise.race([
    f.process.turnRequested.promise,
    running.then(() => {
      throw new Error("The synthetic backend finished without dispatching the expected turn.");
    }),
  ]);
}

function expectNoOutputFiles(f: ReturnType<typeof fixture>): void {
  expect(f.fileIO.writeExclusiveUtf8).not.toHaveBeenCalled();
  expect(f.fileIO.openRead).not.toHaveBeenCalled();
  expect(f.fileIO.realpath).not.toHaveBeenCalled();
  for (const [path] of vi.mocked(f.fileIO.lstat).mock.calls)
    expect(["config.toml", "auth.json"]).toContain(win32.basename(path));
}

function expectDrained(f: ReturnType<typeof fixture>): void {
  expect(f.process.complete).toBe(true);
  expect(f.process.stdout.readableEnded).toBe(true);
  expect(f.process.stderr.readableEnded).toBe(true);
  expect(f.diskClose).toHaveBeenCalledOnce();
}

function modelParameterOverrides(f: ReturnType<typeof fixture>): string[] {
  const args = f.start.mock.calls[0]?.[0].arguments;
  if (args === undefined) throw new Error("The synthetic app-server process was not started.");
  return args
    .flatMap((argument, index) => {
      const value = args[index + 1];
      return argument === "--config" &&
        value !== undefined &&
        modelParameterKeys.some((key) => value.startsWith(`${key}=`))
        ? [value]
        : [];
    })
    .sort();
}

const explicitModelOverrides = [
  'model_reasoning_effort="xhigh"',
  "model_context_window=200000",
  "model_auto_compact_token_limit=150000",
].sort();

describe("PreparedCodexOutputRunner opt-in app-server backend", () => {
  it("dispatches a V2 summary's actual composite prompt and replays only its recorded close intent", async () => {
    const f = fixture(policyFixture());
    const input = summaryInput(f);
    f.close.mockRejectedValueOnce(new ModelInvocationCoordinatorError("SUBMISSION_UNCONFIRMED"));
    await expect(f.runner.run(input)).resolves.toMatchObject({
      outcome: "succeeded",
      resultDigest: rawDigest,
      modelInvocation: { executionAccepted: false, modelOutputBound: true },
    });
    expect(input.modelInvocation.expectedScope.promptSha256).toBe(sha256(f.input.prompt));
    expect(input.modelInvocation.expectedScope.inputRef.actualPromptSha256).toBe(
      sha256(input.prompt),
    );
    const turn = f.process.requests.find((request) => request.method === "turn/start");
    expect(turn?.params).toMatchObject({ input: [{ type: "text", text: input.prompt }] });
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.close.mock.calls[0]?.[0]).toBe(f.close.mock.calls[1]?.[0]);
    expect(f.close.mock.calls[0]?.[0]).toEqual({ modelOutputSha256: rawDigest });
    await expect(
      new PreparedCodexOutputRunner(f.settings).run({
        ...input,
        modelInvocation: {
          expectedScope: {
            ...input.modelInvocation.expectedScope,
            inputRef: {
              ...input.modelInvocation.expectedScope.inputRef,
              inputId: "replacement-input",
            },
          },
          open: f.open,
        },
      }),
    ).rejects.toMatchObject({ code: "MODEL_INVOCATION_ATTEMPT_ALREADY_STARTED" });
    expect(f.open).toHaveBeenCalledOnce();
    expectDrained(f);
  });

  it.each(["template", "actual", "source", "schema", "scope_version", "launch_policy"])(
    "rejects invalid V2 summary %s before opening or dispatch",
    async (field) => {
      const f = fixture(policyFixture());
      const input = summaryInput(f);
      if (field === "template") input.prompt = f.input.prompt;
      if (field === "actual")
        input.modelInvocation.expectedScope.inputRef.actualPromptSha256 =
          sha256("different actual prompt");
      if (field === "source")
        input.modelInvocation.expectedScope.inputRef.sourcePromptSha256 =
          sha256("different source prompt");
      if (field === "schema")
        input.modelInvocation.expectedScope.inputRef.outputSchemaSha256 =
          sha256("different output schema");
      if (field === "scope_version")
        Reflect.set(input.modelInvocation.expectedScope, "schemaVersion", "ModelInvocationScopeV1");
      if (field === "launch_policy") Reflect.set(input, "launchPolicy", "review");
      await expect(f.runner.run(input)).rejects.toMatchObject({
        code: "MODEL_INVOCATION_CONFIGURATION_INVALID",
      });
      expect(f.open).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
    },
  );

  it("still refuses to bind a composite summary prompt to an unchanged V1 scope", async () => {
    const f = fixture(policyFixture());
    const prompt = composeSummaryPrompt(f.input.prompt, '{"synthetic":"context"}');
    await expect(f.runner.run({ ...f.input, prompt })).rejects.toMatchObject({
      code: "MODEL_INVOCATION_CONFIGURATION_INVALID",
    });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("rejects protected typed output on the V2 summary path and closes without an output binding", async () => {
    const f = fixture(policyFixture());
    const secret = "synthetic-summary-private-token";
    f.process.resultText = JSON.stringify({ message: secret });
    const runner = new PreparedCodexOutputRunner({
      ...f.settings,
      codexProviderProtectedValues: [secret],
    });
    const result = await nonSuccess(runner.run(summaryInput(f)));
    expect(result).toMatchObject({ code: "CODEX_APP_SERVER_OUTPUT_INVALID" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
  });

  it.each([false, true])(
    "honors parent-classified body protection while retaining an explicit public marker (public=%s)",
    async (isPublic) => {
      const f = fixture(policyFixture());
      const privateToken = "synthetic-upstream-bare-auth-token";
      const publicMarker = "synthetic-explicit-public-provider-marker";
      const result = { message: isPublic ? publicMarker : privateToken };
      f.process.resultText = JSON.stringify(result);
      const runner = new PreparedCodexOutputRunner({
        ...f.settings,
        codexProviderProtectedValues: [privateToken],
      });
      if (isPublic) {
        const canonical = createCanonicalResult(result);
        await expect(runner.run(f.input)).resolves.toMatchObject({
          outcome: "succeeded",
          result,
          resultDigest: canonical.sha256,
          canonicalResultJson: canonical.json,
        });
        expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: canonical.sha256 });
      } else {
        const rejected = await nonSuccess(runner.run(f.input));
        expect(rejected).toMatchObject({ code: "CODEX_APP_SERVER_OUTPUT_INVALID" });
        expect(JSON.stringify(rejected)).not.toContain(privateToken);
        expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
      }
      expect(f.process.requests.filter((request) => request.method === "turn/start")).toHaveLength(
        1,
      );
      expect(JSON.stringify(f.start.mock.calls[0]?.[0])).not.toContain(privateToken);
      expectDrained(f);
      expectNoOutputFiles(f);
    },
  );

  it("preserves explicit model parameters through actual launch, session checks and raw recording", async () => {
    const f = fixture(policyFixture(explicitModelParameters), explicitModelParameters);
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "succeeded",
      result: rawResult,
      resultDigest: rawDigest,
      canonicalResultJson: createCanonicalResult(rawResult).json,
      modelInvocation: { executionAccepted: false, modelOutputBound: true },
    });
    expect(modelParameterOverrides(f)).toEqual(explicitModelOverrides);
    expect(f.process.responses["config/read"]).toMatchObject({
      config: {
        model_reasoning_effort: "xhigh",
        model_context_window: 200000,
        model_auto_compact_token_limit: 150000,
      },
    });
    expect(f.process.responses["thread/start"]).toMatchObject({ reasoningEffort: "xhigh" });
    const turns = f.process.requests.filter((request) => request.method === "turn/start");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.params).toEqual({
      threadId,
      input: [{ type: "text", text: f.input.prompt }],
      outputSchema: JSON.parse(f.input.authoritativeSchema.json),
    });
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("retains the original three model parameters after constructor options mutate", async () => {
    const f = fixture(policyFixture(explicitModelParameters), explicitModelParameters);
    f.backend.modelReasoningEffort = "low";
    f.backend.modelContextWindow = 300000;
    f.backend.modelAutoCompactTokenLimit = 250000;
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "succeeded",
      resultDigest: rawDigest,
    });
    expect(modelParameterOverrides(f)).toEqual(explicitModelOverrides);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it.each(
    modelParameterKeys.flatMap((key) => ["missing", "changed"].map((mode) => ({ key, mode }))),
  )("refuses $mode merged configuration for $key before turn/start", async ({ key, mode }) => {
    const f = fixture(policyFixture(explicitModelParameters), explicitModelParameters);
    const configRead = f.process.responses["config/read"] as { config: Record<string, unknown> };
    if (mode === "missing") expect(Reflect.deleteProperty(configRead.config, key)).toBe(true);
    else configRead.config[key] = key === "model_reasoning_effort" ? "low" : 200001;
    await nonSuccess(f.runner.run(f.input));
    expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("refuses changed thread reasoning even when all merged configuration values match", async () => {
    const f = fixture(policyFixture(explicitModelParameters), explicitModelParameters);
    const thread = f.process.responses["thread/start"] as Record<string, unknown>;
    thread.reasoningEffort = "low";
    await nonSuccess(f.runner.run(f.input));
    expect(f.process.requests.some((request) => request.method === "thread/start")).toBe(true);
    expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("leaves explicitly null model parameters unconfigured while retaining the default result", async () => {
    const parameters: CodexAppServerModelParameters = {
      modelReasoningEffort: null,
      modelContextWindow: null,
      modelAutoCompactTokenLimit: null,
    };
    const policy = policyFixture(parameters);
    expect(policy.launchPolicySha256).toBe(policyFixture().launchPolicySha256);
    const f = fixture(policy, parameters);
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "succeeded",
      resultDigest: rawDigest,
    });
    expect(modelParameterOverrides(f)).toEqual([]);
    expect(f.process.responses["config/read"]).toMatchObject({
      config: {
        model_reasoning_effort: null,
        model_context_window: null,
        model_auto_compact_token_limit: null,
      },
    });
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("retains 258 unique protected values merged from the runner, legacy provider and relay", async () => {
    const f = fixture(policyFixture());
    const sensitiveValues = Array.from(
      { length: 255 },
      (_, index) => `synthetic-runner-protected-${String(index).padStart(3, "0")}`,
    );
    expect(
      new Set([...sensitiveValues, "synthetic-legacy-secret", relayToken, `Bearer ${relayToken}`])
        .size,
    ).toBe(258);
    await expect(f.runner.run({ ...f.input, sensitiveValues })).resolves.toMatchObject({
      outcome: "succeeded",
      result: rawResult,
      resultDigest: rawDigest,
      modelInvocation: { executionAccepted: false, modelOutputBound: true },
    });
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
    expect(f.start).toHaveBeenCalledOnce();
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("rejects a raw result containing the last merged protected value without truncating the list", async () => {
    const f = fixture(policyFixture());
    const sensitiveValues = Array.from(
      { length: 255 },
      (_, index) => `synthetic-runner-protected-${String(index).padStart(3, "0")}`,
    );
    const merged = [
      ...sensitiveValues,
      "synthetic-legacy-secret",
      relayToken,
      `Bearer ${relayToken}`,
    ];
    const lastSecret = merged.at(-1);
    if (lastSecret === undefined) throw new Error("The synthetic merged secret list is empty.");
    expect(new Set(merged).size).toBe(258);
    f.process.resultText = JSON.stringify({ message: lastSecret });
    const result = await nonSuccess(f.runner.run({ ...f.input, sensitiveValues }));
    expect(result).toMatchObject({ code: "CODEX_APP_SERVER_OUTPUT_INVALID" });
    expect(result).not.toHaveProperty("result");
    expect(f.process.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("bounds cleanup after failed attachment when termination never produces exit or stream ends", async () => {
    const f = fixture(policyFixture());
    const terminationRequested = Promise.withResolvers<void>();
    f.attachProcess.mockImplementation(() => {
      throw new Error("Synthetic attachment failure requiring confirmed process cleanup.");
    });
    f.process.terminate.mockImplementation(async () => {
      terminationRequested.resolve();
    });
    const running = f.runner.run(f.input);
    const outcome = nonSuccess(running);
    try {
      await Promise.race([
        terminationRequested.promise,
        running.then(() => {
          throw new Error("The synthetic process was not terminated after attachment failed.");
        }),
      ]);
      expect(f.process.complete).toBe(false);
      await vi.advanceTimersByTimeAsync(f.input.teardownTimeoutMs ?? 100);
      expect(await outcome).toMatchObject({ code: "CODEX_PROCESS_DRAIN_UNCONFIRMED" });
      expect(f.context.reportNodeHealthFault).toHaveBeenCalledWith(
        expect.objectContaining({ code: "CODEX_PROCESS_DRAIN_UNCONFIRMED" }),
      );
      expect(f.process.terminate).toHaveBeenCalledOnce();
      expect(f.process.complete).toBe(false);
      expect(f.process.stdout.readableEnded).toBe(false);
      expect(f.process.stderr.readableEnded).toBe(false);
      expect(f.diskClose).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
      expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
      expectNoOutputFiles(f);
    } finally {
      f.process.finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it("uses real policy and turn processing while preserving the raw model digest and recording", async () => {
    const f = fixture(policyFixture());
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
    const output = await f.runner.run(f.input);
    expect(output).toMatchObject({
      outcome: "succeeded",
      result: rawResult,
      resultDigest: rawDigest,
      canonicalResultJson: createCanonicalResult(rawResult).json,
      commandEvidence: { commands: [], commandCapture: "complete" },
      observedFileChange: false,
      modelInvocation: { executionAccepted: false, modelOutputBound: true },
    });
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.attachProcess).toHaveBeenCalledExactlyOnceWith(f.process.managed, expect.any(Promise));
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: rawDigest });
    const launch = f.start.mock.calls[0]?.[0];
    expect(launch).toMatchObject({
      interactiveStdin: true,
      captureProcessIdentity: true,
      environmentMode: "replace",
    });
    expect(launch).not.toHaveProperty("standardInput");
    expect(launch?.arguments).toContain("app-server");
    expect(launch?.arguments).not.toContain("exec");
    expect(launch?.arguments).not.toContain("--output-schema");
    expect(launch?.arguments).not.toContain("--output-last-message");
    expect(modelParameterOverrides(f)).toEqual([]);
    expect(launch?.environment.CODEX_HOME).toBe(workspaceLayout.codexHomeDirectory);
    expect(launch?.environment.CODEX_PROVIDER_HEADER_0).toBe(`Bearer ${relayToken}`);
    expect(JSON.stringify(launch)).not.toContain("synthetic-legacy-secret");
    expect(JSON.stringify(launch)).not.toContain("legacy_provider");
    const turns = f.process.requests.filter((request) => request.method === "turn/start");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.params).toEqual({
      threadId,
      input: [{ type: "text", text: f.input.prompt }],
      outputSchema: JSON.parse(f.input.authoritativeSchema.json),
    });
    expect(
      f.process.requests.findIndex((request) => request.method === "thread/start"),
    ).toBeLessThan(f.process.requests.findIndex((request) => request.method === "turn/start"));
    expectNoOutputFiles(f);
    expectDrained(f);
  });

  it("requires the parent invocation before dispatching any process", async () => {
    const f = fixture(policyFixture());
    const { modelInvocation: _invocation, ...withoutInvocation } = f.input;
    await nonSuccess(f.runner.run(withoutInvocation));
    expect(f.start).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.process.requests).toEqual([]);
    expectNoOutputFiles(f);
  });

  it("snapshots constructor backend identity and command-domain policy", async () => {
    const f = fixture(policyFixture());
    f.backend.codexExecutableSha256 = sha256("changed after runner construction");
    f.backend.commandNetworkDomains.push("unexpected-after-construction.example.invalid");
    await expect(f.runner.run(f.input)).resolves.toMatchObject({
      outcome: "succeeded",
      resultDigest: rawDigest,
    });
    expect(f.start).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.start.mock.calls[0]?.[0])).not.toContain(
      "unexpected-after-construction.example.invalid",
    );
    expectNoOutputFiles(f);
  });

  it("refuses a binary measurement that differs from the parent invocation before turn/start", async () => {
    const f = fixture(policyFixture());
    const runner = new PreparedCodexOutputRunner({
      ...f.settings,
      modelInvocationBackend: {
        ...f.backend,
        codexExecutableSha256: sha256("different synthetic executable"),
      },
    });
    await nonSuccess(runner.run(f.input));
    expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(f.start.mock.calls.length).toBeLessThanOrEqual(1);
    expectNoOutputFiles(f);
  });

  it("refuses a frozen CLI version different from the pinned session implementation", async () => {
    const f = fixture(policyFixture());
    f.opening.runtime.client.version = "0.144.0";
    await nonSuccess(f.runner.run(f.input));
    expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(f.start.mock.calls.length).toBeLessThanOrEqual(1);
    expectNoOutputFiles(f);
  });

  it("refuses actual session policy metadata that changes the requested approval policy", async () => {
    const f = fixture(policyFixture());
    const configRead = f.process.responses["config/read"] as { config: Record<string, unknown> };
    configRead.config.approval_policy = "on-request";
    await nonSuccess(f.runner.run(f.input));
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(f.process.requests.some((request) => request.method === "config/value/write")).toBe(
      false,
    );
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it.each(["notConfigured", "updateRequired"])(
    "does not start a turn or install a sandbox for readiness %s",
    async (status) => {
      const f = fixture(policyFixture());
      f.process.responses["windowsSandbox/readiness"] = { status };
      await nonSuccess(f.runner.run(f.input));
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
      expect(f.process.requests.some((request) => request.method.includes("setup"))).toBe(false);
      expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
      expectDrained(f);
      expectNoOutputFiles(f);
    },
  );

  it("refuses a different CLI version reported by the actual initialize response", async () => {
    const f = fixture(policyFixture());
    const initialized = f.process.responses.initialize as Record<string, unknown>;
    initialized.userAgent = "agentic_review_worker/0.144.0 (synthetic fixture)";
    await nonSuccess(f.runner.run(f.input));
    expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("compares the observed policy digest with the frozen parent runtime before turn/start", async () => {
    const f = fixture(policyFixture());
    f.opening.runtime.client.launchPolicySha256 = sha256("different frozen synthetic policy");
    await nonSuccess(f.runner.run(f.input));
    expect(f.process.requests.some((request) => request.method === "thread/start")).toBe(true);
    expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("terminates and drains the process when the invocation cannot attach it", async () => {
    const f = fixture(policyFixture());
    f.attachProcess.mockImplementation(() => {
      throw new Error("Synthetic invocation attach failure.");
    });
    await nonSuccess(f.runner.run(f.input));
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.process.terminate).toHaveBeenCalledOnce();
    expect(f.process.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("retains process and disk cleanup when the progress observer throws", async () => {
    const f = fixture(policyFixture());
    vi.mocked(f.context.reportProgress).mockImplementation((progress) => {
      if (progress.processCount === 1) throw new Error("Synthetic observer failure.");
    });
    await nonSuccess(f.runner.run(f.input));
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.process.terminate).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("cancels the in-flight turn on disk violation without binding a model result", async () => {
    const f = fixture(policyFixture());
    f.process.autoCompleteTurn = false;
    const running = f.runner.run(f.input);
    await turnRequest(f, running);
    f.violateDisk();
    await nonSuccess(running);
    expect(f.process.terminate).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expect(f.controller.signal.aborted).toBe(false);
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it("honors the current child cancellation while retaining the stable attempt owner", async () => {
    const f = fixture(policyFixture());
    f.process.autoCompleteTurn = false;
    const reason = new Error("Synthetic child execution cancellation.");
    const running = f.runner.run(f.input);
    await turnRequest(f, running);
    f.controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(f.owner.signal.aborted).toBe(false);
    expect(f.process.terminate).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ modelOutputSha256: null });
    expectDrained(f);
    expectNoOutputFiles(f);
  });

  it.each(["SEAL_UNCONFIRMED", "SUBMISSION_UNCONFIRMED"] as const)(
    "replays only the identical close intent after %s without another process or turn",
    async (code) => {
      const f = fixture(policyFixture());
      f.close.mockRejectedValueOnce(new ModelInvocationCoordinatorError(code));
      await expect(f.runner.run(f.input)).resolves.toMatchObject({
        outcome: "succeeded",
        resultDigest: rawDigest,
      });
      expect(f.close).toHaveBeenCalledTimes(2);
      expect(f.close.mock.calls[0]?.[0]).toBe(f.close.mock.calls[1]?.[0]);
      expect(f.close.mock.calls.map(([value]) => value)).toEqual([
        { modelOutputSha256: rawDigest },
        { modelOutputSha256: rawDigest },
      ]);
      expect(f.open).toHaveBeenCalledOnce();
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.process.requests.filter((request) => request.method === "turn/start")).toHaveLength(
        1,
      );
      expectDrained(f);
      expectNoOutputFiles(f);
    },
  );
});
