import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createCanonicalResult } from "@agentic-review/codex";
import * as C from "@agentic-review/contracts";
import {
  ModelInvocationReceiptError,
  ModelInvocationRecorder,
} from "./model-invocation-receipts.js";
import {
  createModelResponseObserver,
  type ModelResponseObserver,
  parseModelProtocolJson,
} from "./model-response-observer.js";

export interface ModelResponseRelayLimits {
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly maximumEventBytes: number;
  readonly maximumEvents: number;
  readonly maximumOutputTextBytes: number;
  readonly maximumCalls: number;
  readonly maximumTotalRequestBytes: number;
  readonly maximumTotalResponseBytes: number;
  readonly maximumTotalEvents: number;
  readonly closeTimeoutMs: number;
}
export interface ModelRelayAuthorization {
  readonly headers: Readonly<Record<string, string>>;
  readonly protectedValues: readonly string[];
}
export interface ModelResponseRelayOptions {
  readonly scope: C.ModelInvocationScope;
  readonly runtime: C.ModelInvocationReceiptSet["runtime"];
  /** The complete canonical HTTPS Responses endpoint, including its final /responses path. */
  readonly endpoint: string;
  readonly authorize: (signal: AbortSignal) => Promise<ModelRelayAuthorization>;
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
  readonly limits?: Partial<ModelResponseRelayLimits>;
  /** Tests replace only the upstream transport; incoming HTTP remains real and loopback-only. */
  readonly transport?: typeof fetch;
}
export type ModelResponseRelayFault =
  | "REQUEST_INVALID"
  | "REQUEST_LIMIT_EXCEEDED"
  | "CALL_LIMIT_EXCEEDED"
  | "RECEIPT_LIMIT_EXCEEDED"
  | "CONCURRENT_REQUEST"
  | "AUTHORIZATION_FAILED"
  | "UPSTREAM_HTTP_FAILED"
  | "UPSTREAM_TRANSPORT_FAILED"
  | "RESPONSE_INVALID"
  | "RESPONSE_LIMIT_EXCEEDED"
  | "METADATA_PROTECTED"
  | "CLIENT_DISCONNECTED"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "OUTPUT_UNBOUND";
export interface ModelResponseRelayCloseResult {
  readonly receiptSet: C.ModelInvocationReceiptSet;
  readonly faults: readonly ModelResponseRelayFault[];
}
export interface ModelResponseRelay {
  /** Provider base URL. The only accepted operation appends /responses. */
  readonly url: string;
  readonly bearerToken: string;
  close(input?: {
    readonly modelOutputSha256?: string | null;
  }): Promise<ModelResponseRelayCloseResult>;
}
export class ModelResponseRelayError extends Error {
  constructor(readonly code: "INVALID_CONFIGURATION" | "START_FAILED" | "CLOSE_UNCONFIRMED") {
    super("The model response relay could not establish or confirm its bounded lifecycle.");
    this.name = "ModelResponseRelayError";
  }
}

const defaults: ModelResponseRelayLimits = Object.freeze({
  maximumRequestBytes: C.maximumModelRequestBytes,
  maximumResponseBytes: C.maximumModelResponseBytes,
  maximumEventBytes: 4 * 1024 * 1024,
  maximumEvents: 100_000,
  maximumOutputTextBytes: 2 * 1024 * 1024,
  maximumCalls: C.maximumModelInvocationCallCount,
  maximumTotalRequestBytes: 128 * 1024 * 1024,
  maximumTotalResponseBytes: 256 * 1024 * 1024,
  maximumTotalEvents: C.maximumModelResponseEventCount,
  closeTimeoutMs: 5000,
});
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/u;
const headerPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const fixedRequestHeaders = new Set([
  "host",
  "content-type",
  "accept",
  "accept-encoding",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "expect",
  "trailer",
  "te",
]);
const authenticationHeader =
  /(?:authorization|authentication|api[_-]?key|token|bearer|password|secret|cookie|credential)/iu;
const clientMetadataFields = new Set([
  "thread_id",
  "session_id",
  "turn_id",
  "x-codex-installation-id",
  "x-codex-window-id",
  "x-codex-turn-metadata",
]);
const maximumClientMetadataValueUtf8Bytes = 4096;
const maximumClientMetadataJsonUtf8Bytes = 16 * 1024;
const requestFields = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "background",
  "previous_response_id",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "include",
  "max_output_tokens",
  "temperature",
  "top_p",
  "truncation",
  "store",
  "metadata",
  "client_metadata",
  "service_tier",
  "prompt_cache_key",
  "prompt_cache_retention",
  "safety_identifier",
  "user",
  "max_tool_calls",
  "stream_options",
]);
const forbiddenInputTypes = new Set([
  "item_reference",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "web_search_call",
  "computer_call",
  "computer_call_output",
  "image_generation_call",
  "code_interpreter_call",
  "file_search_call",
]);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

class RelayFailure extends Error {
  constructor(
    readonly fault: ModelResponseRelayFault,
    readonly status = 400,
  ) {
    super("The model relay request could not be completed.");
  }
}
function policy(condition: boolean): asserts condition {
  if (!condition) throw new RelayFailure("REQUEST_INVALID");
}
function configuredLimits(
  input: Partial<ModelResponseRelayLimits> | undefined,
): ModelResponseRelayLimits {
  const value = { ...defaults, ...input };
  if (
    Object.keys(value).some((key) => !Object.hasOwn(defaults, key)) ||
    Object.values(value).some((entry) => !Number.isSafeInteger(entry) || entry < 1) ||
    value.maximumRequestBytes > C.maximumModelRequestBytes ||
    value.maximumResponseBytes > C.maximumModelResponseBytes ||
    value.maximumEventBytes > value.maximumResponseBytes ||
    value.maximumOutputTextBytes > value.maximumResponseBytes ||
    value.maximumEvents > C.maximumModelResponseEventCount ||
    value.maximumCalls > C.maximumModelInvocationCallCount ||
    value.maximumTotalRequestBytes >
      C.maximumModelRequestBytes * C.maximumModelInvocationCallCount ||
    value.maximumTotalResponseBytes >
      C.maximumModelResponseBytes * C.maximumModelInvocationCallCount ||
    value.maximumTotalEvents >
      C.maximumModelResponseEventCount * C.maximumModelInvocationCallCount ||
    value.closeTimeoutMs > 10_000
  )
    throw new ModelResponseRelayError("INVALID_CONFIGURATION");
  return Object.freeze(value);
}
export function describeModelResponseRelayPolicy(limits?: Partial<ModelResponseRelayLimits>) {
  const descriptor = Object.freeze({
    schemaVersion: "ModelResponseRelayPolicyV1" as const,
    listener: "127.0.0.1",
    method: "POST",
    path: "/v1/responses",
    upstream: "canonical-https-responses-no-query-fragment-userinfo-or-redirect",
    authorization: "one-invocation-256-bit-bearer-no-client-header-forwarding",
    maximumLifetimeMs: 2 * 60 * 60 * 1000,
    contentEncoding: "identity-json-utf8",
    requestFields: Object.freeze([...requestFields].sort()),
    clientMetadata: Object.freeze({
      fields: Object.freeze([...clientMetadataFields].sort()),
      maximumValueUtf8Bytes: maximumClientMetadataValueUtf8Bytes,
      maximumJsonUtf8Bytes: maximumClientMetadataJsonUtf8Bytes,
      aggregateEncoding: "compact-json-utf8",
      values: "opaque-utf8-strings",
      authority: "untrusted-transport-only-no-policy-identity-or-acceptance",
    }),
    toolTypes: Object.freeze(["function", "custom"]),
    forbiddenInputTypes: Object.freeze([...forbiddenInputTypes].sort()),
    inputFiles: "inline-pdf-json-octet-stream-plain-base64-only",
    inputImages: "inline-png-jpeg-webp-gif-base64-only",
    previousResponse: "same-invocation-observed-valid-identity-only",
    observation: "strict-model-response-observer-v1",
    metadataProtection: "known-protected-id-model-substring-v1",
    authenticationProtection: "full-authentication-header-and-bearer-basic-credential-v1",
    limits: configuredLimits(limits),
  });
  return Object.freeze({ descriptor, sha256: createCanonicalResult(descriptor).sha256 });
}
function uniqueHeader(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === name)
      values.push(request.rawHeaders[index + 1] ?? "");
  return values.length === 1 ? values[0] : undefined;
}
function hasHeader(request: IncomingMessage, name: string): boolean {
  return request.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === name);
}
function authenticated(request: IncomingMessage, token: Buffer): boolean {
  const value = uniqueHeader(request, "authorization");
  if (value === undefined) return false;
  const bytes = Buffer.from(value);
  return bytes.length === token.length && timingSafeEqual(bytes, token);
}
function safeError(response: ServerResponse, status: number): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(
    '{"error":{"code":"model_relay_rejected","message":"The model relay request could not be completed."}}',
  );
}
function isJsonContentType(value: string | undefined | null): boolean {
  return (
    typeof value === "string" &&
    /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(value)
  );
}
function inlineData(value: unknown, image: boolean): boolean {
  if (typeof value !== "string") return false;
  const mime = image
    ? "image/(?:png|jpeg|webp|gif)"
    : "(?:application/(?:pdf|json|octet-stream)|text/plain)";
  return new RegExp(
    `^data:${mime};base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`,
    "u",
  ).test(value);
}
function validateRequestBody(
  value: unknown,
  requestedModel: string,
  responseIds: ReadonlySet<string>,
): { stream: boolean } {
  policy(object(value));
  policy(Object.keys(value).every((key) => requestFields.has(key)));
  policy(value.model === requestedModel && typeof value.stream === "boolean");
  policy(typeof value.input === "string" || Array.isArray(value.input));
  policy(value.background === undefined || value.background === false);
  if (value.client_metadata !== undefined) {
    const metadata = value.client_metadata;
    policy(object(metadata));
    policy(
      Object.entries(metadata).every(
        ([key, entry]) =>
          clientMetadataFields.has(key) &&
          typeof entry === "string" &&
          entry.isWellFormed() &&
          Buffer.byteLength(entry, "utf8") <= maximumClientMetadataValueUtf8Bytes,
      ),
    );
    policy(
      Buffer.byteLength(JSON.stringify(metadata), "utf8") <= maximumClientMetadataJsonUtf8Bytes,
    );
    // These client strings are forwarded as opaque data. Even embedded JSON is never used to
    // derive an effective launch policy, invocation scope, observed identity or acceptance.
  }
  if (value.previous_response_id !== undefined && value.previous_response_id !== null)
    policy(
      typeof value.previous_response_id === "string" && responseIds.has(value.previous_response_id),
    );
  const names = new Set<string>();
  if (value.tools !== undefined) {
    policy(Array.isArray(value.tools) && value.tools.length <= 128);
    for (const tool of value.tools) {
      policy(object(tool) && (tool.type === "function" || tool.type === "custom"));
      const fields =
        tool.type === "function"
          ? ["type", "name", "description", "parameters", "strict"]
          : ["type", "name", "description", "format"];
      policy(Object.keys(tool).every((key) => fields.includes(key)));
      policy(typeof tool.name === "string" && tool.name.length > 0 && tool.name.length <= 128);
      policy(
        !/(?:^|[.:/])(?:mcp(?:__|[._-])|web_search(?:[._-]|$)|computer(?:_use)?(?:[._-]|$))/iu.test(
          tool.name,
        ),
      );
      policy(!names.has(tool.name));
      names.add(tool.name);
    }
  }
  if (value.tool_choice !== undefined)
    policy(
      (typeof value.tool_choice === "string" &&
        ["auto", "none", "required"].includes(value.tool_choice)) ||
        (object(value.tool_choice) &&
          (value.tool_choice.type === "function" || value.tool_choice.type === "custom") &&
          Object.keys(value.tool_choice).every((key) => key === "type" || key === "name") &&
          typeof value.tool_choice.name === "string" &&
          names.has(value.tool_choice.name)),
    );
  if (Array.isArray(value.input))
    for (const item of value.input)
      if (object(item) && Object.hasOwn(item, "id") && item.type === undefined)
        policy(
          typeof item.role === "string" &&
            ["system", "developer", "user", "assistant"].includes(item.role) &&
            Object.hasOwn(item, "content"),
        );
  const pending: unknown[] = [value.input];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (!object(current)) continue;
    policy(current.type === undefined || typeof current.type === "string");
    policy(!forbiddenInputTypes.has(current.type as string));
    policy(
      !Object.hasOwn(current, "file_url") &&
        !Object.hasOwn(current, "file_id") &&
        !Object.hasOwn(current, "image_id"),
    );
    if (current.type === "input_image") {
      policy(Object.keys(current).every((key) => ["type", "image_url", "detail"].includes(key)));
      policy(inlineData(current.image_url, true));
    } else if (Object.hasOwn(current, "image_url")) policy(false);
    if (current.type === "input_file") {
      policy(Object.keys(current).every((key) => ["type", "file_data", "filename"].includes(key)));
      policy(inlineData(current.file_data, false));
    } else if (Object.hasOwn(current, "file_data")) policy(false);
    for (const child of Object.values(current)) pending.push(child);
  }
  return { stream: value.stream };
}
function authorizationSnapshot(
  value: ModelRelayAuthorization,
  stream: boolean,
): { headers: Headers; protectedValues: readonly string[] } {
  try {
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error();
    const root = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(value).length !== 2 ||
      !["headers", "protectedValues"].every((key) => {
        const descriptor = root[key];
        return descriptor?.enumerable && "value" in descriptor;
      })
    )
      throw new Error();
    const sourceHeaders: unknown = root.headers?.value;
    const sourceProtected: unknown = root.protectedValues?.value;
    if (
      !object(sourceHeaders) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(sourceHeaders)) ||
      !Array.isArray(sourceProtected)
    )
      throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(sourceHeaders);
    const keys = Reflect.ownKeys(sourceHeaders);
    if (
      keys.length > 64 ||
      sourceProtected.length > 128 ||
      Reflect.ownKeys(sourceProtected).length !== sourceProtected.length + 1
    )
      throw new Error();
    const headers = new Headers();
    const seen = new Set<string>();
    const protectedValues = new Set<string>();
    for (let index = 0; index < sourceProtected.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(sourceProtected, index);
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        !descriptor.value.isWellFormed()
      )
        throw new Error();
      if (descriptor.value.length > 0) protectedValues.add(descriptor.value);
    }
    let bytes = 0;
    for (const name of keys) {
      const descriptor = typeof name === "string" ? descriptors[name] : undefined;
      if (
        typeof name !== "string" ||
        !headerPattern.test(name) ||
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        /[\r\n\0]/u.test(descriptor.value)
      )
        throw new Error();
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) throw new Error();
      seen.add(normalized);
      bytes += Buffer.byteLength(name) + Buffer.byteLength(descriptor.value);
      if (bytes > 64 * 1024) throw new Error();
      if (!fixedRequestHeaders.has(normalized)) headers.set(name, descriptor.value);
      if (authenticationHeader.test(normalized)) {
        if (descriptor.value.length > 0) protectedValues.add(descriptor.value);
        const trimmed = descriptor.value.trim();
        if (trimmed.length > 0) protectedValues.add(trimmed);
        const credential = /^(?:Bearer|Basic)[ \t]+([^ \t]+)$/iu.exec(trimmed)?.[1];
        if (credential) protectedValues.add(credential);
      }
    }
    headers.set("content-type", "application/json");
    headers.set("accept", stream ? "text/event-stream" : "application/json");
    headers.set("accept-encoding", "identity");
    return { headers, protectedValues: Object.freeze([...protectedValues]) };
  } catch {
    throw new RelayFailure("AUTHORIZATION_FAILED", 502);
  }
}
async function readBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const abort = () => request.destroy();
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let count = 0;
  try {
    for await (const raw of request) {
      if (signal.aborted) throw new RelayFailure("CANCELLED", 503);
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      count += chunk.length;
      if (count > maximumBytes) throw new RelayFailure("REQUEST_LIMIT_EXCEEDED", 413);
      chunks.push(chunk);
    }
    if (!request.complete || signal.aborted) throw new RelayFailure("CLIENT_DISCONNECTED", 503);
    return Buffer.concat(chunks, count);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function writeChunk(
  response: ServerResponse,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) throw new RelayFailure("CLIENT_DISCONNECTED", 503);
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const clean = () => {
      response.off("drain", drain);
      response.off("close", close);
      signal.removeEventListener("abort", close);
    };
    const drain = () => {
      clean();
      resolve();
    };
    const close = () => {
      clean();
      reject(new RelayFailure("CLIENT_DISCONNECTED", 503));
    };
    response.once("drain", drain);
    response.once("close", close);
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted || response.destroyed) close();
  });
}
function redactMetadata(
  observation: C.ModelResponseObservationV1,
  protectedValues: readonly string[],
): C.ModelResponseObservationV1 {
  if (
    ![observation.responseId, observation.modelId].some(
      (value) => value !== null && protectedValues.some((secret) => value.includes(secret)),
    )
  )
    return observation;
  return {
    ...observation,
    outcome: "invalid",
    reasonCode: "INVALID_METADATA",
    responseId: null,
    modelId: null,
    outputJsonSha256: null,
  };
}

/** Owns one loopback relay lifecycle. Receipts are observations, not model attestation. */
export async function createModelResponseRelay(
  options: ModelResponseRelayOptions,
): Promise<ModelResponseRelay> {
  let scope: C.ModelInvocationScope,
    runtime: C.ModelInvocationReceiptSet["runtime"],
    endpoint: string,
    limits: ModelResponseRelayLimits,
    deadline: number;
  const authorize = options.authorize,
    transport = options.transport ?? fetch,
    parentSignal = options.signal;
  try {
    scope = structuredClone(options.scope);
    runtime = structuredClone(options.runtime);
    endpoint = options.endpoint;
    limits = configuredLimits(structuredClone(options.limits));
    deadline = Date.parse(options.deadlineAt);
    const target = new URL(endpoint);
    if (
      target.protocol !== "https:" ||
      target.href !== endpoint ||
      !target.pathname.endsWith("/responses") ||
      target.search ||
      target.hash ||
      target.username ||
      target.password ||
      runtime.endpointSha256 !== sha256(endpoint) ||
      runtime.relay.policySha256 !== describeModelResponseRelayPolicy(limits).sha256 ||
      C.getModelInvocationScopeIssues(scope).length ||
      typeof authorize !== "function" ||
      !Number.isFinite(deadline) ||
      deadline <= Date.now() ||
      deadline - Date.now() > 2 * 60 * 60 * 1000 ||
      parentSignal.aborted
    )
      throw new Error();
  } catch {
    throw new ModelResponseRelayError("INVALID_CONFIGURATION");
  }
  const recorder = new ModelInvocationRecorder({ scope, runtime });
  const bearerToken = randomBytes(32).toString("base64url");
  const authentication = Buffer.from(`Bearer ${bearerToken}`);
  const invocation = new AbortController();
  const faults = new Set<ModelResponseRelayFault>();
  const responseIds = new Set<string>();
  const sockets = new Set<Socket>();
  const socketClosures = new Map<Socket, Promise<void>>();
  const cancelReaders = new Set<() => void>();
  const tasks = new Set<Promise<void>>();
  let active = false,
    closing = false,
    expectedHost = "",
    totalRequestBytes = 0,
    totalResponseBytes = 0,
    totalEvents = 0;
  let stopped: Promise<void> | undefined;
  let closePromise: Promise<ModelResponseRelayCloseResult> | undefined;
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    route,
  );
  server.maxConnections = 16;
  // Keep raw and normalized headers complete; enforce the count explicitly after authentication.
  server.maxHeadersCount = 0;
  const stop = () => {
    stopped ??= new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error ? reject(new ModelResponseRelayError("CLOSE_UNCONFIRMED")) : resolve(),
      ),
    );
    void stopped.catch(() => undefined);
    return stopped;
  };
  const cancel = (fault: ModelResponseRelayFault, destroySockets = false) => {
    faults.add(fault);
    if (!invocation.signal.aborted) invocation.abort(new RelayFailure(fault, 503));
    for (const cancelReader of cancelReaders) cancelReader();
    void stop();
    if (destroySockets) for (const socket of sockets) socket.destroy();
  };
  const parentAbort = () => cancel("CANCELLED", true);
  let timer: NodeJS.Timeout | undefined;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socketClosures.set(
      socket,
      new Promise<void>((resolve) =>
        socket.once("close", () => {
          sockets.delete(socket);
          socketClosures.delete(socket);
          resolve();
        }),
      ),
    );
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("checkContinue", route);
  server.on("checkExpectation", route);
  for (const event of ["upgrade", "connect"] as const)
    server.on(event, (request, socket) => {
      if (authenticated(request, authentication)) cancel("REQUEST_INVALID");
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });

  function route(request: IncomingMessage, response: ServerResponse): void {
    if (!authenticated(request, authentication)) {
      safeError(response, 401);
      return;
    }
    if (closing || invocation.signal.aborted) {
      safeError(response, 503);
      return;
    }
    if (active) {
      safeError(response, 409);
      cancel("CONCURRENT_REQUEST");
      return;
    }
    active = true;
    const disconnected = () => {
      if (!response.writableFinished && !invocation.signal.aborted && !closing)
        cancel("CLIENT_DISCONNECTED");
    };
    response.once("close", disconnected);
    const task = handle(request, response).finally(() => {
      response.off("close", disconnected);
      active = false;
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => undefined);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let call: ReturnType<ModelInvocationRecorder["begin"]> | undefined;
    let finished = false,
      status: number | null = null,
      observer: ModelResponseObserver | undefined,
      observation: C.ModelResponseObservationV1 | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let readerComplete = false;
    let readerCancellation: Promise<void> | undefined;
    const cancelReader = () => {
      if (reader && !readerCancellation) {
        const owned = reader;
        readerCancellation = owned.cancel().catch(async () => {
          await owned.closed.catch(() => undefined);
        });
        void readerCancellation.catch(() => undefined);
      }
    };
    let protectedValues: readonly string[] = [bearerToken];
    const observe = (complete: boolean) => {
      if (observation !== null || observer === undefined) return observation;
      const raw = observer.finish({ complete });
      observation = redactMetadata(raw, protectedValues);
      totalResponseBytes += observation.bodyBytes;
      totalEvents += observation.eventCount;
      if (observation !== raw) faults.add("METADATA_PROTECTED");
      return observation;
    };
    const finish = (outcome: C.ModelCallReceiptV1["outcome"]) => {
      if (call && !finished) {
        call.finish({ httpStatus: status, response: observation, outcome });
        finished = true;
      }
    };
    try {
      policy(request.rawHeaders.length <= 128);
      policy(request.method === "POST" && request.url === "/v1/responses");
      policy(
        uniqueHeader(request, "host") === expectedHost &&
          request.socket.remoteAddress === "127.0.0.1",
      );
      policy(isJsonContentType(uniqueHeader(request, "content-type")));
      policy(
        !hasHeader(request, "content-encoding") ||
          uniqueHeader(request, "content-encoding")?.toLowerCase() === "identity",
      );
      policy(!hasHeader(request, "expect") && !hasHeader(request, "upgrade"));
      if (recorder.callCount >= limits.maximumCalls)
        throw new RelayFailure("CALL_LIMIT_EXCEEDED", 429);
      const remaining = limits.maximumTotalRequestBytes - totalRequestBytes;
      if (remaining < 1) throw new RelayFailure("REQUEST_LIMIT_EXCEEDED", 413);
      const body = await readBody(
        request,
        Math.min(limits.maximumRequestBytes, remaining),
        invocation.signal,
      );
      let parsed: unknown;
      try {
        parsed = parseModelProtocolJson(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
        );
      } catch {
        throw new RelayFailure("REQUEST_INVALID");
      }
      const { stream } = validateRequestBody(parsed, scope.requestedModel, responseIds);
      totalRequestBytes += body.length;
      try {
        call = recorder.begin({
          requestSha256: sha256(body),
          requestBytes: body.length,
          requestedModel: scope.requestedModel,
        });
      } catch (error) {
        if (
          error instanceof ModelInvocationReceiptError &&
          error.code === "RECEIPT_BUDGET_EXCEEDED"
        )
          throw new RelayFailure("RECEIPT_LIMIT_EXCEEDED", 413);
        throw error;
      }
      const authorized = await authorize(invocation.signal);
      if (invocation.signal.aborted) throw new RelayFailure("CANCELLED", 503);
      const credentials = authorizationSnapshot(authorized, stream);
      protectedValues = [...credentials.protectedValues, bearerToken];
      const responseBudget = Math.min(
        limits.maximumResponseBytes,
        limits.maximumTotalResponseBytes - totalResponseBytes,
      );
      const eventBudget = Math.min(limits.maximumEvents, limits.maximumTotalEvents - totalEvents);
      if (responseBudget < 1 || eventBudget < 1)
        throw new RelayFailure("RESPONSE_LIMIT_EXCEEDED", 413);
      const upstream = await transport(endpoint, {
        method: "POST",
        headers: credentials.headers,
        body: Uint8Array.from(body),
        redirect: "error",
        signal: invocation.signal,
      });
      if (!Number.isInteger(upstream.status) || upstream.status < 100 || upstream.status > 599)
        throw new RelayFailure("RESPONSE_INVALID", 502);
      status = upstream.status;
      if (upstream.body) {
        reader = upstream.body.getReader();
        cancelReaders.add(cancelReader);
        if (invocation.signal.aborted) cancelReader();
      }
      if (invocation.signal.aborted) throw new RelayFailure("CANCELLED", 503);
      if (status < 200 || status >= 300) {
        finish("provider_failed");
        safeError(response, 502);
        cancel("UPSTREAM_HTTP_FAILED");
        return;
      }
      const encoding = upstream.headers.get("content-encoding");
      const contentType = upstream.headers.get("content-type");
      if (
        upstream.redirected ||
        (upstream.url !== "" && upstream.url !== endpoint) ||
        (encoding !== null && encoding.toLowerCase() !== "identity") ||
        (stream
          ? !/^text\/event-stream(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType ?? "")
          : !isJsonContentType(contentType))
      )
        throw new RelayFailure("RESPONSE_INVALID", 502);
      observer = createModelResponseObserver({
        format: stream ? "sse" : "json",
        maximumBodyBytes: responseBudget,
        maximumEventBytes: Math.min(limits.maximumEventBytes, responseBudget),
        maximumEvents: eventBudget,
        maximumOutputTextBytes: Math.min(limits.maximumOutputTextBytes, responseBudget),
      });
      response.writeHead(status, {
        "content-type": stream ? "text/event-stream; charset=utf-8" : "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        connection: "close",
      });
      let complete = false;
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (invocation.signal.aborted) throw new RelayFailure("CANCELLED", 503);
          if (chunk.done) {
            complete = true;
            readerComplete = true;
            break;
          }
          const ownedBytes = Uint8Array.from(chunk.value);
          if (!observer.push(ownedBytes)) break;
          await writeChunk(response, ownedBytes, invocation.signal);
        }
      const result = observe(complete);
      if (!result) throw new RelayFailure("RESPONSE_INVALID", 502);
      if (result.outcome === "invalid") {
        const exceeded = [
          "BODY_LIMIT_EXCEEDED",
          "EVENT_LIMIT_EXCEEDED",
          "OUTPUT_LIMIT_EXCEEDED",
        ].includes(result.reasonCode ?? "");
        finish(exceeded ? "budget_exceeded" : "protocol_invalid");
        cancel(exceeded ? "RESPONSE_LIMIT_EXCEEDED" : "RESPONSE_INVALID");
        response.destroy();
        return;
      }
      if (result.responseId !== null) responseIds.add(result.responseId);
      finish(
        result.outcome === "completed"
          ? "completed"
          : result.outcome === "failed"
            ? "provider_failed"
            : "provider_incomplete",
      );
      response.end();
    } catch (error) {
      observe(false);
      const reason = invocation.signal.aborted
        ? "CANCELLED"
        : error instanceof RelayFailure
          ? error.fault
          : call
            ? "UPSTREAM_TRANSPORT_FAILED"
            : "REQUEST_INVALID";
      finish(
        reason === "CANCELLED"
          ? "cancelled"
          : reason.endsWith("LIMIT_EXCEEDED")
            ? "budget_exceeded"
            : reason === "REQUEST_INVALID" || reason === "RESPONSE_INVALID"
              ? "protocol_invalid"
              : "transport_failed",
      );
      safeError(response, error instanceof RelayFailure ? error.status : 502);
      if (!invocation.signal.aborted) cancel(reason);
    } finally {
      if (reader) {
        try {
          if (!readerComplete) cancelReader();
          if (readerCancellation) await readerCancellation;
        } finally {
          cancelReaders.delete(cancelReader);
          reader.releaseLock();
        }
      }
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const error = () => {
        server.off("listening", listening);
        reject(new ModelResponseRelayError("START_FAILED"));
      };
      const listening = () => {
        server.off("error", error);
        resolve();
      };
      server.once("error", error);
      server.once("listening", listening);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
  } catch {
    if (timer) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    throw new ModelResponseRelayError("START_FAILED");
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    void stop();
    for (const socket of sockets) socket.destroy();
    throw new ModelResponseRelayError("START_FAILED");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  server.on("error", () => cancel("CANCELLED", true));
  timer = setTimeout(() => cancel("DEADLINE_EXCEEDED", true), Math.max(1, deadline - Date.now()));
  timer.unref();
  parentSignal.addEventListener("abort", parentAbort, { once: true });
  if (parentSignal.aborted) parentAbort();
  if (Date.now() >= deadline) cancel("DEADLINE_EXCEEDED", true);
  const close = (input: { readonly modelOutputSha256?: string | null } = {}) => {
    if (closePromise) return closePromise;
    const requestedOutput = input.modelOutputSha256 ?? null;
    closing = true;
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener("abort", parentAbort);
    if (active) cancel("CANCELLED");
    void stop();
    for (const socket of sockets) socket.destroy();
    closePromise = (async () => {
      let closeTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all([stopped, ...tasks, ...socketClosures.values()]),
          new Promise<never>((_resolve, reject) => {
            closeTimer = setTimeout(
              () => reject(new ModelResponseRelayError("CLOSE_UNCONFIRMED")),
              limits.closeTimeoutMs,
            );
          }),
        ]);
        if (recorder.active || active || sockets.size > 0)
          throw new ModelResponseRelayError("CLOSE_UNCONFIRMED");
        const validOutput =
          requestedOutput === null ||
          (typeof requestedOutput === "string" && digestPattern.test(requestedOutput));
        if (!validOutput) faults.add("OUTPUT_UNBOUND");
        const receiptSet = recorder.close({
          state: invocation.signal.aborted ? "cancelled" : "closed",
          modelOutputSha256: invocation.signal.aborted || !validOutput ? null : requestedOutput,
        });
        if (requestedOutput !== null && receiptSet.modelOutputSha256 !== requestedOutput)
          faults.add("OUTPUT_UNBOUND");
        return Object.freeze({ receiptSet, faults: Object.freeze([...faults]) });
      } catch {
        throw new ModelResponseRelayError("CLOSE_UNCONFIRMED");
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
      }
    })();
    return closePromise;
  };
  return Object.freeze({ url: `http://${expectedHost}/v1`, bearerToken, close });
}
