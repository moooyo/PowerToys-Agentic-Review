import { createHash } from "node:crypto";
import { request as httpRequest, ServerResponse } from "node:http";
import { createCanonicalResult } from "@agentic-review/codex";
import * as C from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelResponseRelay,
  describeModelResponseRelayPolicy,
  type ModelRelayAuthorization,
  type ModelResponseRelay,
  type ModelResponseRelayOptions,
} from "./model-response-relay.js";

const endpoint = "https://provider.example.invalid/v1/responses";
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const output = { answer: "Synthetic local relay fixture." };
const outputSha256 = createCanonicalResult(output).sha256;
const relays: ModelResponseRelay[] = [];
const controllers: AbortController[] = [];
const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const release of cleanup.splice(0)) release();
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(relays.splice(0).map((relay) => relay.close()));
  vi.restoreAllMocks();
});
function responseBody(
  id = "resp_fixture",
  model = "observed-fixture-model",
  text = JSON.stringify(output),
) {
  return {
    id,
    object: "response",
    created_at: 1740855869,
    status: "completed",
    model,
    error: null,
    incomplete_details: null,
    output: [
      {
        id: "msg_fixture",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  };
}
const jsonResponse = (id?: string, model?: string) =>
  new Response(JSON.stringify(responseBody(id, model)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const terminal = (id = "resp_fixture") =>
  frame({ type: "response.completed", sequence_number: 0, response: responseBody(id) });
function settings(overrides: Partial<ModelResponseRelayOptions> = {}) {
  const controller = new AbortController();
  controllers.push(controller);
  const runtime: C.ModelInvocationReceiptSetV1["runtime"] = {
    providerId: "fixture-provider",
    endpointSha256: sha256(endpoint),
    client: {
      kind: "codex_cli",
      version: "fixture-cli",
      executableSha256: sha256("client"),
      launchPolicySha256: sha256("launch-policy"),
    },
    relay: {
      implementationSha256: sha256("relay-fixture-code"),
      policySha256: describeModelResponseRelayPolicy(overrides.limits).sha256,
    },
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
    executionManifestSha256: sha256("execution"),
    promptSha256: sha256("prompt"),
    outputSchemaSha256: sha256("schema"),
    requestedModel: "requested-fixture-model",
    expectedModelIdentitySha256: createCanonicalResult({
      schemaVersion: "ModelRuntimeIdentityV1",
      ...runtime,
      modelId: "observed-fixture-model",
    }).sha256,
    workerNodeId: "worker-a",
    workerInstanceId: "instance-a",
    leaseGeneration: 1,
  };
  const authorize = vi.fn(async () => ({
    headers: { Authorization: "Bearer synthetic-provider-secret", "X-Provider-Source": "fixture" },
    protectedValues: ["synthetic-provider-secret"],
  }));
  const transport = vi.fn(async () => jsonResponse());
  const options: ModelResponseRelayOptions = {
    scope,
    runtime,
    endpoint,
    authorize,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    transport,
    ...overrides,
  };
  return { options, scope, runtime, controller, authorize, transport };
}
function summaryScope(scope: C.ModelInvocationScopeV1): C.ModelInvocationScopeV2 {
  return {
    ...scope,
    schemaVersion: "ModelInvocationScopeV2",
    purpose: "validation_summary",
    inputRef: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "summary-input",
      inputSha256: sha256("frozen summary input"),
      sourcePromptSha256: scope.promptSha256,
      outputSchemaSha256: scope.outputSchemaSha256,
      contextSha256: sha256("summary context"),
      actualPromptSha256: sha256("composite summary prompt"),
    },
  };
}
async function fixture(overrides: Partial<ModelResponseRelayOptions> = {}) {
  const value = settings(overrides);
  const relay = await createModelResponseRelay(value.options);
  relays.push(relay);
  return { ...value, relay };
}
const body = (changes: Record<string, unknown> = {}) => ({
  model: "requested-fixture-model",
  stream: false,
  input: "Only synthetic fixture input.",
  ...changes,
});
interface IncomingResult {
  status: number;
  headers: Record<string, unknown>;
  bytes: Buffer;
}
function post(
  relay: ModelResponseRelay,
  payload: unknown = body(),
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string | string[] | undefined>;
    raw?: boolean;
  } = {},
): Promise<IncomingResult> {
  const serialized = options.raw ? (payload as string) : JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Synthetic requests require explicit content.");
  const bytes = Buffer.from(serialized);
  return new Promise((resolve, reject) => {
    const url = new URL(relay.url);
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: options.path ?? "/v1/responses",
        method: options.method ?? "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${relay.bearerToken}`,
          "content-type": "application/json",
          "content-length": String(bytes.length),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("aborted", () =>
          reject(new Error("The synthetic HTTP response was interrupted.")),
        );
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    request.setTimeout(5000, () =>
      request.destroy(new Error("The synthetic HTTP request timed out.")),
    );
    request.end(bytes);
  });
}
async function settleRequest(pending: Promise<IncomingResult>): Promise<IncomingResult | null> {
  try {
    return await pending;
  } catch {
    return null;
  }
}

describe("one-invocation loopback model Responses relay", () => {
  it("retains the exact V2 input reference in a V2 ledger across the real loopback relay", async () => {
    const settingsValue = settings();
    const scope = summaryScope(settingsValue.scope);
    const retained = structuredClone(scope);
    const f = await fixture({ scope });
    scope.inputRef.inputId = "changed-after-relay-start";
    expect((await post(f.relay)).status).toBe(200);
    const closed = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.receiptSet).toMatchObject({
      schemaVersion: "ModelInvocationReceiptSetV2",
      scope: retained,
      modelOutputSha256: outputSha256,
    });
    expect(closed.receiptSet.scopeSha256).toBe(createCanonicalResult(retained).sha256);
    expect(C.getModelInvocationReceiptSetIssues(closed.receiptSet)).toEqual([]);
    expect(closed.receiptSet.calls).toHaveLength(1);
    expect(JSON.stringify(closed)).not.toContain("synthetic-provider-secret");
  });

  it("keeps protected provider metadata out of V2 receipts", async () => {
    const scope = summaryScope(settings().scope);
    const f = await fixture({
      scope,
      transport: async () => jsonResponse("resp_synthetic-provider-secret"),
    });
    await settleRequest(post(f.relay));
    const closed = await f.relay.close();
    expect(closed.receiptSet.schemaVersion).toBe("ModelInvocationReceiptSetV2");
    expect(closed.faults).toContain("METADATA_PROTECTED");
    expect(closed.receiptSet.modelOutputSha256).toBeNull();
    expect(closed.receiptSet.calls[0]?.receipt.response?.responseId).toBeNull();
    expect(JSON.stringify(closed)).not.toContain("synthetic-provider-secret");
  });

  it("rejects a mislabeled summary scope before creating a relay", async () => {
    const f = settings();
    const scope = summaryScope(f.scope);
    Reflect.set(scope, "schemaVersion", "ModelInvocationScopeV1");
    await expect(createModelResponseRelay({ ...f.options, scope })).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("supports the observed Codex client_metadata shape while binding the original bytes and ignoring its authority claims", async () => {
    const transport = vi.fn<typeof fetch>(async () => jsonResponse());
    const f = await fixture({ transport });
    const metadata = {
      thread_id: "synthetic-thread",
      session_id: "synthetic-session",
      turn_id: "synthetic-turn",
      "x-codex-installation-id": "synthetic-installation",
      "x-codex-window-id": "{synthetic-window}",
      "x-codex-turn-metadata": JSON.stringify({
        synthetic: true,
        model: "untrusted-metadata-model",
        launchPolicySha256: "0".repeat(64),
        executionAccepted: true,
      }),
    };
    const raw = ` ${JSON.stringify(body({ client_metadata: metadata }), null, 2).replace(
      "synthetic-thread",
      String.raw`synthetic\u002dthread`,
    )}\n`;
    expect((await post(f.relay, raw, { raw: true })).status).toBe(200);
    expect(transport).toHaveBeenCalledOnce();
    expect(Buffer.from(transport.mock.calls[0]?.[1]?.body as Uint8Array).toString()).toBe(raw);
    const closed = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.faults).toEqual([]);
    expect(closed.receiptSet.calls[0]?.receipt).toMatchObject({
      requestSha256: sha256(raw),
      requestBytes: Buffer.byteLength(raw),
      outcome: "completed",
    });
    expect(closed.receiptSet.scope).toEqual(f.scope);
    expect(closed.receiptSet.runtime).toEqual(f.runtime);
    expect(closed.receiptSet.observedIdentity?.modelId).toBe("observed-fixture-model");
    expect(JSON.stringify(closed)).not.toContain("untrusted-metadata-model");
    expect(closed.receiptSet).not.toHaveProperty("executionAccepted");
  });

  it("declares client_metadata limits and its lack of authority in the hashed relay policy", () => {
    const current = describeModelResponseRelayPolicy();
    expect(current.descriptor.clientMetadata).toEqual({
      fields: [
        "session_id",
        "thread_id",
        "turn_id",
        "x-codex-installation-id",
        "x-codex-turn-metadata",
        "x-codex-window-id",
      ],
      maximumValueUtf8Bytes: 4096,
      maximumJsonUtf8Bytes: 16384,
      aggregateEncoding: "compact-json-utf8",
      values: "opaque-utf8-strings",
      authority: "untrusted-transport-only-no-policy-identity-or-acceptance",
    });
    expect(Object.isFrozen(current.descriptor.clientMetadata)).toBe(true);
    expect(Object.isFrozen(current.descriptor.clientMetadata.fields)).toBe(true);
    const { clientMetadata: _metadata, ...previous } = current.descriptor;
    const oldDescriptor = {
      ...previous,
      requestFields: previous.requestFields.filter((name) => name !== "client_metadata"),
    };
    expect(current.sha256).toBe(createCanonicalResult(current.descriptor).sha256);
    expect(current.sha256).not.toBe(createCanonicalResult(oldDescriptor).sha256);
  });

  it.each([
    ["empty object", {}],
    ["empty string", { thread_id: "" }],
    ["ASCII value at its byte limit", { thread_id: "a".repeat(4096) }],
    ["multibyte value at its byte limit", { thread_id: "\u00e9".repeat(2048) }],
  ])("accepts bounded client_metadata: %s", async (_description, clientMetadata) => {
    const f = await fixture();
    expect((await post(f.relay, body({ client_metadata: clientMetadata }))).status).toBe(200);
    expect((await f.relay.close({ modelOutputSha256: outputSha256 })).faults).toEqual([]);
  });

  it("enforces the compact JSON client_metadata budget including keys, escapes and punctuation", async () => {
    const atLimit = {
      thread_id: "a".repeat(4096),
      session_id: "b".repeat(4096),
      turn_id: "c".repeat(4096),
      "x-codex-turn-metadata": "",
    };
    atLimit["x-codex-turn-metadata"] = "d".repeat(
      16384 - Buffer.byteLength(JSON.stringify(atLimit)),
    );
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(16384);
    expect(Object.values(atLimit).every((entry) => Buffer.byteLength(entry) <= 4096)).toBe(true);
    const accepted = await fixture();
    expect((await post(accepted.relay, body({ client_metadata: atLimit }))).status).toBe(200);
    expect((await accepted.relay.close({ modelOutputSha256: outputSha256 })).faults).toEqual([]);
    const aboveLimit = {
      ...atLimit,
      "x-codex-turn-metadata": `${atLimit["x-codex-turn-metadata"]}d`,
    };
    expect(Object.values(aboveLimit).every((entry) => Buffer.byteLength(entry) <= 4096)).toBe(true);
    const rejected = await fixture();
    expect((await post(rejected.relay, body({ client_metadata: aboveLimit }))).status).toBe(400);
    expect(rejected.transport).not.toHaveBeenCalled();
    expect(rejected.authorize).not.toHaveBeenCalled();
    expect((await rejected.relay.close()).faults).toContain("REQUEST_INVALID");
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "metadata"],
    ["boolean root", true],
    ["unknown key", { untrusted_authority: "accepted" }],
    ["wrong key casing", { Thread_id: "synthetic" }],
    ["prototype key", { ["__proto__"]: "synthetic" }],
    ["numeric value", { thread_id: 1 }],
    ["boolean value", { session_id: false }],
    ["null value", { turn_id: null }],
    ["object value", { "x-codex-turn-metadata": { executionAccepted: true } }],
    ["array value", { "x-codex-window-id": ["synthetic"] }],
    ["oversized ASCII value", { thread_id: "a".repeat(4097) }],
    ["oversized multibyte value", { thread_id: "\u00e9".repeat(2049) }],
    ["ill-formed Unicode", { thread_id: "\ud800" }],
    [
      "escaped JSON aggregate overflow",
      { thread_id: "\n".repeat(4096), session_id: "\n".repeat(4096) },
    ],
  ])(
    "rejects invalid client_metadata before authorization or upstream dispatch: %s",
    async (_description, clientMetadata) => {
      const f = await fixture();
      expect((await post(f.relay, body({ client_metadata: clientMetadata }))).status).toBe(400);
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
      const closed = await f.relay.close();
      expect(closed.receiptSet.state).toBe("cancelled");
      expect(closed.receiptSet.calls).toEqual([]);
      expect(closed.faults).toContain("REQUEST_INVALID");
    },
  );

  it("rejects duplicate decoded client_metadata keys", async () => {
    const f = await fixture();
    const raw = String.raw`{"model":"requested-fixture-model","stream":false,"input":"Synthetic only.","client_metadata":{"thread_id":"first","\u0074hread_id":"second"}}`;
    expect((await post(f.relay, raw, { raw: true })).status).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
    expect((await f.relay.close()).receiptSet.calls).toEqual([]);
  });

  it("forwards original checked JSON bytes and only trusted headers, then closes a complete receipt chain", async () => {
    const transport = vi.fn<typeof fetch>(async () => jsonResponse());
    const f = await fixture({ transport });
    expect(new URL(f.relay.url).hostname).toBe("127.0.0.1");
    expect(Buffer.from(f.relay.bearerToken, "base64url")).toHaveLength(32);
    const raw =
      ' { "model": "requested-fixture-model", "input":"Only synthetic fixture input.", "stream":false }\n';
    const received = await post(f.relay, raw, {
      raw: true,
      headers: { "X-Client-Secret": "must-not-forward", "accept-encoding": "gzip" },
    });
    expect(received.status).toBe(200);
    expect(received.bytes.toString()).toBe(JSON.stringify(responseBody()));
    const [url, init] = transport.mock.calls[0] ?? [];
    expect(url).toBe(endpoint);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-provider-secret");
    expect(headers.get("x-client-secret")).toBeNull();
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(Buffer.from(init?.body as Uint8Array).toString()).toBe(raw);
    const closed = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.faults).toEqual([]);
    expect(C.getModelInvocationReceiptSetIssues(closed.receiptSet)).toEqual([]);
    expect(closed.receiptSet).toMatchObject({
      state: "closed",
      modelOutputSha256: outputSha256,
      observedIdentity: { modelId: "observed-fixture-model" },
    });
    expect(closed.receiptSet.calls).toHaveLength(1);
    expect(closed.receiptSet.calls[0]?.receipt).toMatchObject({
      requestSha256: sha256(raw),
      requestBytes: Buffer.byteLength(raw),
      outcome: "completed",
      httpStatus: 200,
      response: {
        bodySha256: sha256(received.bytes),
        bodyBytes: received.bytes.length,
        transportComplete: true,
      },
    });
    expect(JSON.stringify(closed)).not.toContain("synthetic-provider-secret");
    expect(JSON.stringify(closed)).not.toContain(f.relay.bearerToken);
    await expect(post(f.relay)).rejects.toBeDefined();
  });

  it("keeps unauthorized requests out of the invocation ledger and does not poison later authorized work", async () => {
    const f = await fixture();
    expect(
      (await post(f.relay, body(), { headers: { authorization: "Bearer incorrect" } })).status,
    ).toBe(401);
    expect(
      (
        await post(f.relay, body(), {
          headers: { authorization: "Bearer incorrect", expect: "synthetic-expectation" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post(f.relay, body(), {
          headers: {
            authorization: [`Bearer ${f.relay.bearerToken}`, `Bearer ${f.relay.bearerToken}`],
          },
        })
      ).status,
    ).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
    expect((await post(f.relay)).status).toBe(200);
    const closed = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.faults).toEqual([]);
    expect(closed.receiptSet.calls).toHaveLength(1);
  });

  it.each([
    { method: "GET" },
    { path: "/v1/responses?endpoint=https://other.example.invalid/responses" },
    { path: "/v1/chat/completions" },
    { headers: { host: "other.example.invalid" } },
    { headers: { "content-type": "text/plain" } },
    { headers: { "content-encoding": "gzip" } },
    { headers: { expect: "100-continue" } },
    { headers: { expect: "synthetic-expectation" } },
  ])("cancels authenticated HTTP protocol violations: %j", async (options) => {
    const f = await fixture();
    await settleRequest(post(f.relay, body(), options));
    expect(f.transport).not.toHaveBeenCalled();
    const closed = await f.relay.close();
    expect(closed.receiptSet.state).toBe("cancelled");
    expect(closed.faults).toContain("REQUEST_INVALID");
    expect(closed.receiptSet.modelOutputSha256).toBeNull();
  });

  it.each([
    { model: "other-model" },
    { stream: "true" },
    { background: true },
    { conversation: null },
    { prompt: { id: "stored-prompt" } },
    { previous_response_id: "another-invocation-response" },
    { tools: [{ type: "web_search_preview" }] },
    { tools: [{ type: "mcp", server_url: "https://outside.example.invalid" }] },
    { tools: [{ type: "computer_use_preview" }] },
    { tools: [{ type: "function", name: "web_search", parameters: {} }] },
    { tools: [{ type: "function", name: "safe", server_url: "https://outside.example.invalid" }] },
    { tool_choice: { type: "mcp", name: "remote" } },
    { input: [{ type: "input_image", image_url: "https://outside.example.invalid/image.png" }] },
    { input: [{ type: "input_file", file_url: "https://outside.example.invalid/file.pdf" }] },
    { input: [{ type: "input_file", file_id: "remote-stored-file" }] },
    { input: [{ type: "item_reference", id: "outside-item" }] },
    { input: [{ id: "outside-item" }] },
    {
      input: [
        { id: "outside-item", unrelated: "cannot turn a stored reference into inline input" },
      ],
    },
  ])("rejects scope escapes before any upstream call: %j", async (changes) => {
    const f = await fixture();
    expect((await post(f.relay, body(changes))).status).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    const closed = await f.relay.close();
    expect(closed.receiptSet.state).toBe("cancelled");
    expect(closed.receiptSet.calls).toEqual([]);
  });

  it.each([
    '{"model":"other","model":"requested-fixture-model","stream":false,"input":"fixture"}',
    '{"model":"requested-fixture-model","stream":false,"input":',
  ])(
    "rejects ambiguous or malformed JSON without recording a fabricated upstream request",
    async (raw) => {
      const f = await fixture();
      expect((await post(f.relay, raw, { raw: true })).status).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
      expect((await f.relay.close()).receiptSet.calls).toEqual([]);
    },
  );

  it("rejects excess raw headers before a late content encoding can bypass protocol checks", async () => {
    const f = await fixture();
    const headers = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`x-padding-${index}`, "fixture"]),
    );
    headers["content-encoding"] = "gzip";
    expect((await post(f.relay, body(), { headers })).status).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
    const closed = await f.relay.close();
    expect(closed.faults).toEqual(["REQUEST_INVALID"]);
    expect(closed.receiptSet.state).toBe("cancelled");
  });

  it("accepts bounded inline media and declared local function/custom tools", async () => {
    const f = await fixture();
    const request = body({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "https://example.invalid is plain explanatory text." },
            { type: "input_image", image_url: "data:image/png;base64,AA==" },
            {
              type: "input_file",
              file_data: "data:application/pdf;base64,AA==",
              filename: "fixture.pdf",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "inspect_fixture",
          parameters: { type: "object", properties: {} },
        },
        { type: "custom", name: "apply_patch", format: { type: "text" } },
      ],
      tool_choice: { type: "function", name: "inspect_fixture" },
      background: false,
    });
    expect((await post(f.relay, request)).status).toBe(200);
    expect((await f.relay.close({ modelOutputSha256: outputSha256 })).faults).toEqual([]);
  });

  it("allows a previous response only after this invocation observed its complete identity", async () => {
    let sequence = 0;
    const transport = vi.fn<typeof fetch>(async () => jsonResponse(`resp_${++sequence}`));
    const f = await fixture({ transport });
    await post(f.relay);
    await post(f.relay, body({ previous_response_id: "resp_1" }));
    const closed = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.receiptSet.calls).toHaveLength(2);
    expect(closed.receiptSet.calls[1]?.receipt.previousReceiptSha256).toBe(
      closed.receiptSet.calls[0]?.sha256,
    );
    const other = await fixture();
    expect((await post(other.relay, body({ previous_response_id: "resp_1" }))).status).toBe(400);
    expect(other.transport).not.toHaveBeenCalled();
  });

  it("owns observed SSE bytes across backpressure even when the upstream mutates its source chunk", async () => {
    const first = Buffer.from(": synthetic heartbeat\n\n");
    const expectedFirst = Buffer.from(first);
    const last = Buffer.from(`${terminal()}data: [DONE]\n\n`);
    let pulls = 0;
    const readable = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(first);
          else if (pulls === 2) controller.enqueue(last);
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const transport = vi.fn<typeof fetch>(
      async () => new Response(readable, { headers: { "content-type": "text/event-stream" } }),
    );
    const original = ServerResponse.prototype.write;
    const held = Promise.withResolvers<{
      response: ServerResponse;
      args: Parameters<typeof original>;
    }>();
    let paused = false;
    vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof original>
    ) {
      if (!paused) {
        paused = true;
        held.resolve({ response: this, args });
        return false;
      }
      return Reflect.apply(original, this, args) as boolean;
    });
    const f = await fixture({ transport });
    const pending = post(f.relay, body({ stream: true }));
    const { response, args } = await held.promise;
    expect(pulls).toBe(1);
    expect(Buffer.from(args[0])).toEqual(expectedFirst);
    first.fill(0x78);
    Reflect.apply(original, response, args);
    response.emit("drain");
    const received = await pending;
    expect(received.bytes).toEqual(Buffer.concat([expectedFirst, last]));
    const closed = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.faults).toEqual([]);
    expect(closed.receiptSet.calls[0]?.receipt.response).toMatchObject({
      outcome: "completed",
      bodySha256: sha256(received.bytes),
      bodyBytes: received.bytes.length,
      eventCount: 1,
    });
  });

  it("stops immediately when the observer rejects an event", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const invalid = Buffer.from('data: {"type":"unsupported.event"}\n\n');
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls++;
                controller.enqueue(invalid);
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const f = await fixture({ transport });
    await settleRequest(post(f.relay, body({ stream: true })));
    const closed = await f.relay.close();
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(closed.receiptSet.calls[0]?.receipt).toMatchObject({
      outcome: "protocol_invalid",
      response: { outcome: "invalid", bodySha256: sha256(invalid), bodyBytes: invalid.length },
    });
  });

  it("returns a fixed non-2xx error without reading or echoing the provider error body", async () => {
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                throw new Error("PRIVATE provider body must not be read.");
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
          { status: 401, headers: { "content-type": "application/json", "set-cookie": "PRIVATE" } },
        ),
    );
    const f = await fixture({ transport });
    const result = await post(f.relay);
    expect(result.status).toBe(502);
    expect(result.bytes.toString()).not.toContain("PRIVATE");
    expect(result.headers["set-cookie"]).toBeUndefined();
    const closed = await f.relay.close();
    expect(closed.receiptSet.calls[0]?.receipt).toMatchObject({
      httpStatus: 401,
      outcome: "provider_failed",
      response: null,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("freezes authorization headers and protects extracted metadata after the callback object changes", async () => {
    const headers = { Authorization: "Bearer original-provider-secret" };
    const protectedValues = ["original-provider-secret"];
    const entered = Promise.withResolvers<RequestInit>();
    const returned = Promise.withResolvers<Response>();
    cleanup.push(() => returned.resolve(jsonResponse("resp_original-provider-secret")));
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      entered.resolve(init ?? {});
      return returned.promise;
    });
    const f = await fixture({ authorize: async () => ({ headers, protectedValues }), transport });
    const pending = settleRequest(post(f.relay));
    const actual = await entered.promise;
    headers.Authorization = "Bearer changed-secret";
    protectedValues.splice(0);
    returned.resolve(jsonResponse("resp_original-provider-secret"));
    await pending;
    expect(new Headers(actual.headers).get("authorization")).toBe(
      "Bearer original-provider-secret",
    );
    const closed = await f.relay.close();
    expect(closed.faults).toContain("METADATA_PROTECTED");
    expect(closed.receiptSet.calls[0]?.receipt.response).toMatchObject({
      outcome: "invalid",
      reasonCode: "INVALID_METADATA",
      responseId: null,
      modelId: null,
      outputJsonSha256: null,
      transportComplete: true,
    });
    expect(JSON.stringify(closed)).not.toContain("original-provider-secret");
  });

  it.each([
    { name: "Authorization", value: "Bearer synthetic-credential", echoed: "synthetic-credential" },
    {
      name: "Authorization",
      value: "Basic c3ludGhldGljOmNyZWRlbnRpYWw=",
      echoed: "c3ludGhldGljOmNyZWRlbnRpYWw=",
    },
    {
      name: "Proxy-Authorization",
      value: "Bearer synthetic-proxy-credential",
      echoed: "Bearer synthetic-proxy-credential",
    },
    { name: "X-API-Key", value: "synthetic-api-key", echoed: "synthetic-api-key" },
    { name: "X-Auth-Token", value: "synthetic-auth-token", echoed: "synthetic-auth-token" },
    { name: "Cookie", value: "session=synthetic-cookie", echoed: "session=synthetic-cookie" },
  ])(
    "always protects authentication header metadata even when the callback omits the secret: $name",
    async ({ name, value, echoed }) => {
      const raw = JSON.stringify(responseBody("resp_fixture", `model_${echoed}`));
      const f = await fixture({
        authorize: async () => ({ headers: { [name]: value }, protectedValues: [] }),
        transport: async () =>
          new Response(raw, { headers: { "content-type": "application/json" } }),
      });
      await settleRequest(post(f.relay));
      const closed = await f.relay.close();
      expect(closed.faults).toContain("METADATA_PROTECTED");
      expect(closed.receiptSet.calls[0]?.receipt.response).toMatchObject({
        bodySha256: sha256(raw),
        bodyBytes: Buffer.byteLength(raw),
        transportComplete: true,
        outcome: "invalid",
        reasonCode: "INVALID_METADATA",
        responseId: null,
        modelId: null,
        outputJsonSha256: null,
      });
      expect(JSON.stringify(closed)).not.toContain(echoed);
      expect(closed.receiptSet.observedIdentity).toBeNull();
    },
  );

  it.each([
    "root_headers",
    "root_protected",
    "header_value",
    "protected_entry",
    "root_symbol",
    "header_symbol",
    "protected_symbol",
    "duplicate_header",
  ] as const)(
    "rejects ambiguous authorization snapshots without invoking accessors: %s",
    async (kind) => {
      const getter = vi.fn(() => "synthetic-secret");
      const authorization = {
        headers: { Authorization: "Bearer synthetic-secret" },
        protectedValues: ["synthetic-secret"],
      };
      if (kind === "root_headers")
        Object.defineProperty(authorization, "headers", { get: getter, enumerable: true });
      if (kind === "root_protected")
        Object.defineProperty(authorization, "protectedValues", { get: getter, enumerable: true });
      if (kind === "header_value")
        Object.defineProperty(authorization.headers, "Authorization", {
          get: getter,
          enumerable: true,
        });
      if (kind === "protected_entry")
        Object.defineProperty(authorization.protectedValues, "0", {
          get: getter,
          enumerable: true,
        });
      if (kind === "root_symbol")
        Object.defineProperty(authorization, Symbol("ambiguous"), { value: "synthetic-secret" });
      if (kind === "header_symbol")
        Object.defineProperty(authorization.headers, Symbol("ambiguous"), {
          value: "synthetic-secret",
        });
      if (kind === "protected_symbol")
        Object.defineProperty(authorization.protectedValues, Symbol("ambiguous"), {
          value: "synthetic-secret",
        });
      if (kind === "duplicate_header")
        Object.defineProperty(authorization.headers, "authorization", {
          value: "Bearer other-secret",
          enumerable: true,
        });
      const f = await fixture({ authorize: async () => authorization as ModelRelayAuthorization });
      const result = await post(f.relay);
      expect(result.status).toBe(502);
      expect(getter).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
      expect(result.bytes.toString()).not.toContain("synthetic-secret");
      const closed = await f.relay.close();
      expect(closed.faults).toEqual(["AUTHORIZATION_FAILED"]);
      expect(closed.receiptSet.calls[0]?.receipt).toMatchObject({
        outcome: "transport_failed",
        httpStatus: null,
        response: null,
      });
    },
  );

  it("permits explicitly unprotected ordinary provider metadata", async () => {
    const f = await fixture({
      authorize: async () => ({
        headers: { "X-Provider-Source": "approved-fixture" },
        protectedValues: [],
      }),
      transport: async () => jsonResponse("resp_fixture", "approved-fixture-model"),
    });
    expect((await post(f.relay)).status).toBe(200);
    const closed = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.faults).toEqual([]);
    expect(closed.receiptSet.observedIdentity?.modelId).toBe("approved-fixture-model");
  });

  it("does not scan hashes or numeric counters as protected plaintext", async () => {
    const f = await fixture({
      authorize: async () => ({ headers: { Authorization: "1" }, protectedValues: ["1"] }),
      transport: async () => jsonResponse("resp-safe", "model-safe"),
    });
    await post(f.relay);
    const closed = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.faults).toEqual([]);
    expect(closed.receiptSet.calls[0]?.receipt.response).toMatchObject({
      outcome: "completed",
      eventCount: 1,
    });
  });

  it("snapshots scope, runtime, endpoint and limits before listener setup yields", async () => {
    const f = settings();
    const expected = structuredClone(f.scope);
    const pending = createModelResponseRelay(f.options);
    f.scope.requestedModel = "changed-model";
    f.runtime.client.version = "changed-client";
    f.runtime.relay.policySha256 = "0".repeat(64);
    const relay = await pending;
    relays.push(relay);
    await post(relay);
    const closed = await relay.close({ modelOutputSha256: outputSha256 });
    expect(closed.receiptSet.scope).toEqual(expected);
    expect(closed.receiptSet.runtime.client.version).toBe("fixture-cli");
    expect(closed.faults).toEqual([]);
  });

  it("cancels the invocation when another authenticated request overlaps an active upstream call", async () => {
    const entered = Promise.withResolvers<void>();
    const transport = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          entered.resolve();
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("Synthetic transport cancelled.")),
            { once: true },
          );
        }),
    );
    const f = await fixture({ transport });
    const first = settleRequest(post(f.relay));
    await entered.promise;
    expect((await post(f.relay)).status).toBe(409);
    await first;
    const closed = await f.relay.close();
    expect(transport).toHaveBeenCalledOnce();
    expect(closed.faults).toContain("CONCURRENT_REQUEST");
    expect(closed.receiptSet).toMatchObject({ state: "cancelled", modelOutputSha256: null });
    expect(closed.receiptSet.calls[0]?.receipt.outcome).toBe("cancelled");
  });

  it.each(["lease", "deadline"] as const)(
    "aborts all work and closes on %s cancellation",
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const aborted = vi.fn();
      const transport = vi.fn<typeof fetch>(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            entered.resolve();
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted();
                reject(new Error("Synthetic cancellation."));
              },
              { once: true },
            );
          }),
      );
      const f = await fixture({
        transport,
        ...(kind === "deadline" ? { deadlineAt: new Date(Date.now() + 500).toISOString() } : {}),
      });
      const pending = settleRequest(post(f.relay));
      await entered.promise;
      if (kind === "lease") f.controller.abort();
      await pending;
      const closed = await f.relay.close();
      expect(aborted).toHaveBeenCalledOnce();
      expect(closed.receiptSet.state).toBe("cancelled");
      expect(closed.faults).toContain(kind === "lease" ? "CANCELLED" : "DEADLINE_EXCEEDED");
    },
  );

  it("fails closure explicitly when a transport ignores cancellation", async () => {
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    cleanup.push(() => late.resolve(jsonResponse()));
    const transport = vi.fn<typeof fetch>(async () => {
      entered.resolve();
      return late.promise;
    });
    const f = await fixture({ transport, limits: { closeTimeoutMs: 25 } });
    const pending = settleRequest(post(f.relay));
    await entered.promise;
    await expect(f.relay.close()).rejects.toMatchObject({ code: "CLOSE_UNCONFIRMED" });
    late.resolve(jsonResponse());
    await pending;
  });

  it("actively cancels an open response stream when the relay is closed", async () => {
    const reading = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                reading.resolve();
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const f = await fixture({ transport });
    const pending = settleRequest(post(f.relay, body({ stream: true })));
    await reading.promise;
    const closed = await f.relay.close();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(closed.receiptSet).toMatchObject({ state: "cancelled", modelOutputSha256: null });
    expect(closed.receiptSet.calls[0]?.receipt.response).toMatchObject({
      outcome: "invalid",
      reasonCode: "TRANSPORT_INCOMPLETE",
      transportComplete: false,
    });
  });

  it("bounds call count and reports a final output digest that is not bound to the last response", async () => {
    const f = await fixture({ limits: { maximumCalls: 1 } });
    await post(f.relay);
    expect((await post(f.relay)).status).toBe(429);
    expect(f.transport).toHaveBeenCalledOnce();
    const limited = await f.relay.close({ modelOutputSha256: outputSha256 });
    expect(limited.faults).toContain("CALL_LIMIT_EXCEEDED");
    expect(limited.receiptSet.modelOutputSha256).toBeNull();
    const other = await fixture();
    await post(other.relay);
    const unbound = await other.relay.close({ modelOutputSha256: sha256("wrong-output") });
    expect(unbound.faults).toEqual(["OUTPUT_UNBOUND"]);
    expect(unbound.receiptSet.modelOutputSha256).toBeNull();
  });

  it.each(["per_request", "cumulative"] as const)(
    "rejects %s request byte overflow before another upstream call",
    async (kind) => {
      const size = Buffer.byteLength(JSON.stringify(body()));
      const f = await fixture({
        limits:
          kind === "per_request"
            ? { maximumRequestBytes: size - 1 }
            : { maximumTotalRequestBytes: size + 1 },
      });
      if (kind === "cumulative") expect((await post(f.relay)).status).toBe(200);
      await settleRequest(post(f.relay));
      expect(f.transport).toHaveBeenCalledTimes(kind === "cumulative" ? 1 : 0);
      expect(f.authorize).toHaveBeenCalledTimes(kind === "cumulative" ? 1 : 0);
      const closed = await f.relay.close();
      expect(closed.faults).toContain("REQUEST_LIMIT_EXCEEDED");
      expect(closed.receiptSet.calls).toHaveLength(kind === "cumulative" ? 1 : 0);
      expect(closed.receiptSet).toMatchObject({ state: "cancelled", modelOutputSha256: null });
    },
  );

  it("reserves closure space before dispatch and retains every admitted call when Unicode metadata fills the receipt budget", async () => {
    const requestedModel = "界".repeat(1024);
    const observedModel = "測".repeat(1024);
    const transport = vi.fn<typeof fetch>(async () =>
      jsonResponse("應".repeat(1024), observedModel),
    );
    const f = settings({ transport });
    f.scope.requestedModel = requestedModel;
    f.scope.expectedModelIdentitySha256 = createCanonicalResult({
      schemaVersion: "ModelRuntimeIdentityV1",
      ...f.runtime,
      modelId: observedModel,
    }).sha256;
    const relay = await createModelResponseRelay(f.options);
    relays.push(relay);
    let accepted = 0;
    let rejectedStatus: number | undefined;
    for (let index = 0; index < C.maximumModelInvocationCallCount; index++) {
      const result = await post(relay, body({ model: requestedModel }));
      if (result.status !== 200) {
        rejectedStatus = result.status;
        break;
      }
      accepted++;
    }
    expect(rejectedStatus).toBe(413);
    expect(accepted).toBeGreaterThan(1);
    expect(accepted).toBeLessThan(C.maximumModelInvocationCallCount);
    expect(transport).toHaveBeenCalledTimes(accepted);
    expect(f.authorize).toHaveBeenCalledTimes(accepted);
    const closed = await relay.close();
    expect(closed.faults).toEqual(["RECEIPT_LIMIT_EXCEEDED"]);
    expect(closed.receiptSet.calls).toHaveLength(accepted);
    expect(closed.receiptSet.calls.every(({ receipt }) => receipt.outcome === "completed")).toBe(
      true,
    );
    expect(C.getModelInvocationReceiptSetIssues(closed.receiptSet)).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(closed.receiptSet))).toBeLessThanOrEqual(
      C.maximumModelRuntimeUtf8Bytes,
    );
    expect(closed.receiptSet).toMatchObject({ state: "cancelled", modelOutputSha256: null });
  });

  it("retains actual received bytes when the response exceeds its body budget", async () => {
    const raw = Buffer.from(JSON.stringify(responseBody()));
    const cancel = vi.fn();
    let pulls = 0;
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls++;
                controller.enqueue(raw);
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const f = await fixture({
      transport,
      limits: { maximumResponseBytes: 128, maximumEventBytes: 128, maximumOutputTextBytes: 128 },
    });
    await settleRequest(post(f.relay));
    const closed = await f.relay.close();
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(closed.faults).toContain("RESPONSE_LIMIT_EXCEEDED");
    expect(closed.receiptSet.calls[0]?.receipt).toMatchObject({
      outcome: "budget_exceeded",
      response: {
        outcome: "invalid",
        reasonCode: "BODY_LIMIT_EXCEEDED",
        bodySha256: sha256(raw),
        bodyBytes: raw.length,
        transportComplete: false,
      },
    });
  });

  it.each(["event_count", "event_bytes", "output_text"] as const)(
    "enforces %s response observation budget",
    async (kind) => {
      const raw =
        kind === "event_count"
          ? frame({
              type: "response.created",
              sequence_number: 0,
              response: { ...responseBody(), status: "in_progress" },
            }) + frame({ type: "response.completed", sequence_number: 1, response: responseBody() })
          : terminal();
      const limits =
        kind === "event_count"
          ? { maximumEvents: 1 }
          : kind === "event_bytes"
            ? { maximumEventBytes: 16 }
            : { maximumOutputTextBytes: 8 };
      const f = await fixture({
        limits,
        transport: async () =>
          new Response(raw, { headers: { "content-type": "text/event-stream" } }),
      });
      await settleRequest(post(f.relay, body({ stream: true })));
      const closed = await f.relay.close();
      expect(closed.faults).toContain("RESPONSE_LIMIT_EXCEEDED");
      expect(closed.receiptSet.calls[0]?.receipt).toMatchObject({
        outcome: "budget_exceeded",
        response: {
          outcome: "invalid",
          reasonCode: kind === "output_text" ? "OUTPUT_LIMIT_EXCEEDED" : "EVENT_LIMIT_EXCEEDED",
          responseId: null,
          modelId: null,
        },
      });
      if (kind === "event_count")
        expect(closed.receiptSet.calls[0]?.receipt.response?.eventCount).toBe(2);
    },
  );

  it.each(["bytes", "events"] as const)(
    "does not start an upstream call once the cumulative response %s budget is consumed",
    async (kind) => {
      const responseBytes = Buffer.byteLength(JSON.stringify(responseBody()));
      const f = await fixture({
        limits:
          kind === "bytes"
            ? { maximumTotalResponseBytes: responseBytes }
            : { maximumTotalEvents: 1 },
      });
      expect((await post(f.relay)).status).toBe(200);
      expect((await post(f.relay)).status).toBe(413);
      expect(f.transport).toHaveBeenCalledOnce();
      const closed = await f.relay.close();
      expect(closed.faults).toContain("RESPONSE_LIMIT_EXCEEDED");
      expect(closed.receiptSet.calls).toHaveLength(2);
      expect(closed.receiptSet.calls[1]?.receipt).toMatchObject({
        outcome: "budget_exceeded",
        httpStatus: null,
        response: null,
      });
      expect(closed.receiptSet).toMatchObject({ state: "cancelled", modelOutputSha256: null });
    },
  );

  it.each([
    "http://provider.example.invalid/responses",
    `${endpoint}?api-version=fixture`,
    `${endpoint}#fragment`,
    "https://user:secret@provider.example.invalid/responses",
    "https://provider.example.invalid/chat/completions",
  ])(
    "refuses a non-fixed HTTPS Responses endpoint %s before listening",
    async (invalidEndpoint) => {
      const f = settings({ endpoint: invalidEndpoint });
      await expect(createModelResponseRelay(f.options)).rejects.toMatchObject({
        code: "INVALID_CONFIGURATION",
      });
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
});
