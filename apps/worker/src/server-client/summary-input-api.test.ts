import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { SecureContext } from "node:tls";
import { inspect } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import type {
  FreezeValidationSummaryInputRequest,
  FreezeValidationSummaryInputResponse,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { ProtocolError, WorkerApiError } from "./errors.js";
import { HttpWorkerApi } from "./http-worker-api.js";
import {
  parseFreezeValidationSummaryInputResponse,
  snapshotFreezeValidationSummaryInputRequest,
} from "./summary-input-api.js";

const workerToken = `arw1_${"W".repeat(43)}`;
const leaseToken = "L".repeat(32);

function summaryInputRequest(): FreezeValidationSummaryInputRequest {
  const lease = {
    jobId: "job-1",
    runAttemptId: "attempt-1",
    workerNodeId: "worker-node-1",
    workerInstanceId: "worker-instance-1",
    leaseToken,
    leaseGeneration: 2,
  };
  return {
    lease,
    inputId: "input-a",
    context: {
      schemaVersion: "ValidationSummaryContextV1",
      runId: "run-a",
      requestId: "request-a",
      jobId: lease.jobId,
      runAttemptId: lease.runAttemptId,
      githubRepositoryId: 123,
      profileVersionId: "profile-a",
      revisionKey: "a".repeat(64),
      planDigest: "b".repeat(64),
      testedSourceRevision: { kind: "commit", headSha: "c".repeat(40) },
      report: {
        schemaVersion: "ValidationReportV1",
        workItemKind: "issue",
        source: "worker",
        summary: "The recorded check failed.",
        sourceState: "original",
        reproductionConclusion: "inconclusive",
        checks: [],
      },
      execution: { blockers: [], diagnostics: [], cleanupState: "completed" },
      evidence: { assets: [], scenarios: [] },
    },
  };
}
function summaryInputResponse(
  request = summaryInputRequest(),
): FreezeValidationSummaryInputResponse {
  return {
    schemaVersion: "FreezeValidationSummaryInputResponseV1",
    frozenAt: "2026-09-08T00:00:00.000Z",
    reference: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: request.inputId,
      inputSha256: "d".repeat(64),
      sourcePromptSha256: "e".repeat(64),
      outputSchemaSha256: "f".repeat(64),
      contextSha256: createCanonicalResult(request.context).sha256,
      actualPromptSha256: "a".repeat(64),
    },
  };
}

describe("summary input freezing transport", () => {
  it("sends the frozen context snapshot to the dedicated authenticated endpoint", async () => {
    const input = summaryInputRequest();
    const before = structuredClone(input);
    const response = summaryInputResponse(input);
    const test = setup(response, {
      onCreate: () => {
        input.context.report.summary = "Changed after dispatch";
        input.lease.jobId = "other-job";
      },
    });
    await expect(test.api.freezeValidationSummaryInput(input)).resolves.toEqual(response);
    expect(test.requests).toHaveLength(1);
    const sent = test.requests[0];
    if (!sent) throw new Error("Missing synthetic request.");
    expect(sent.url.pathname).toBe("/api/v1/worker/model-summary-inputs");
    expect(sent.options.headers).toMatchObject({ authorization: `Bearer ${workerToken}` });
    expect(JSON.parse(Buffer.concat(sent.transport.writes).toString("utf8"))).toEqual(before);
    expect(JSON.stringify(test.logs)).not.toContain(leaseToken);
    expect(JSON.stringify(test.logs)).not.toContain(workerToken);
  });
  it("uses the bounded context request allowance while retaining the small response limit", async () => {
    const input = summaryInputRequest();
    input.context.execution.diagnostics = Array.from({ length: 20 }, (_, index) => ({
      stepId: `profile-a:test-${index}`,
      phase: "test",
      outcome: "failed",
      exitCode: 1,
      summary: "s".repeat(2048),
    }));
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(32768);
    const test = setup(summaryInputResponse(input));
    await expect(test.api.freezeValidationSummaryInput(input)).resolves.toEqual(
      summaryInputResponse(input),
    );
    expect(test.requests).toHaveLength(1);
    const large = setup(Buffer.from(" ".repeat(32769)));
    await expect(
      large.api.freezeValidationSummaryInput(summaryInputRequest()),
    ).rejects.toBeInstanceOf(ProtocolError);
    expect(large.requests).toHaveLength(1);
  });
  it.each(["inputId", "contextSha256"])(
    "rejects a receipt with mismatched %s without retry",
    async (field) => {
      const response = summaryInputResponse();
      if (field === "inputId") response.reference.inputId = "other-input";
      else response.reference.contextSha256 = "0".repeat(64);
      const test = setup(response);
      await expect(
        test.api.freezeValidationSummaryInput(summaryInputRequest()),
      ).rejects.toBeInstanceOf(ProtocolError);
      expect(test.requests).toHaveLength(1);
    },
  );
  it.each([leaseToken, workerToken])(
    "refuses a credential in input before network activity",
    async (credential) => {
      const input = summaryInputRequest();
      input.context.report.summary = `Unexpected echo ${credential}`;
      const test = setup(summaryInputResponse(input));
      await expect(test.api.freezeValidationSummaryInput(input)).rejects.toBeInstanceOf(
        ProtocolError,
      );
      expect(test.requests).toHaveLength(0);
      expect(JSON.stringify(test.logs)).not.toContain(credential);
    },
  );
  it("preserves cancellation and uncertain-response behavior without dispatching a second write", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const early = setup(summaryInputResponse());
    await expect(
      early.api.freezeValidationSummaryInput(summaryInputRequest(), aborted.signal),
    ).rejects.toThrow();
    expect(early.requests).toHaveLength(0);
    const uncertain = setup(summaryInputResponse(), { outcome: "aborted" });
    await expect(
      uncertain.api.freezeValidationSummaryInput(summaryInputRequest()),
    ).rejects.toThrow();
    expect(uncertain.requests).toHaveLength(1);
  });
});
function config(): WorkerConfig {
  return {
    serverUrl: new URL("https://worker-api.internal"),
    protocolVersion: "1.0",
    workerNodeId: "worker-node-1",
    workerToken,
    displayName: "Synthetic Worker",
    workerVersion: "synthetic-1",
    maxSlots: 1,
    dataDirectory: ".",
    executionEnabled: false,
    claimWaitSeconds: 1,
    registrationRetrySeconds: 1,
    idleDelayMilliseconds: 1_000,
    heartbeatIntervalSeconds: 5,
    heartbeatSafetyMarginSeconds: 0,
    shutdownGraceSeconds: 1,
    requestTimeoutSeconds: 1,
    logLevel: "error",
    capabilities: {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      cliEngine: "codex",
      cliVersion: "not-configured",
      recipeIds: [],
      labels: { execution: "disabled", processHost: "unavailable" },
    },
    allowInsecureHttp: false,
    tls: {
      ca: Buffer.from("synthetic-ca"),
      serverName: "worker-api.internal",
      rejectUnauthorized: true,
    },
  };
}

class StubRequest extends EventEmitter {
  readonly writes: Buffer[] = [];
  destroyed = false;
  incomingDestroyed = false;

  constructor(
    private readonly receive: (response: IncomingMessage) => void,
    private readonly payload: unknown,
    private readonly status = 200,
    private readonly outcome: "complete" | "aborted" | "error" | "closed" | "pending" = "complete",
  ) {
    super();
  }

  setTimeout(): this {
    return this;
  }

  write(body: Buffer): boolean {
    this.writes.push(Buffer.from(body));
    return true;
  }

  end(): this {
    if (this.outcome === "pending") return this;
    const incoming = Object.assign(new EventEmitter(), {
      statusCode: this.status,
    }) as IncomingMessage;
    incoming.destroy = () => {
      this.incomingDestroyed = true;
      return incoming;
    };
    this.receive(incoming);
    queueMicrotask(() => {
      incoming.emit(
        "data",
        Buffer.isBuffer(this.payload)
          ? this.payload
          : Buffer.from(JSON.stringify(this.payload), "utf8"),
      );
      if (this.outcome === "complete") incoming.emit("end");
      else if (this.outcome === "error") incoming.emit("error", new Error(`private ${leaseToken}`));
      else incoming.emit(this.outcome === "closed" ? "close" : "aborted");
      this.emit("close");
    });
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

interface CapturedRequest {
  readonly url: URL;
  readonly options: RequestOptions;
  readonly transport: StubRequest;
}

function setup(
  payload: unknown | ((url: URL) => unknown) = summaryInputResponse(),
  settings: {
    config?: WorkerConfig;
    status?: number;
    outcome?: "complete" | "aborted" | "error" | "closed" | "pending";
    onCreate?: () => void;
  } = {},
) {
  const requests: CapturedRequest[] = [];
  const logs: unknown[] = [];
  const logger: Logger = {
    debug: (message, fields) => logs.push({ message, fields }),
    info: (message, fields) => logs.push({ message, fields }),
    warn: (message, fields) => logs.push({ message, fields }),
    error: (message, fields) => logs.push({ message, fields }),
  };
  const secureContext = {} as SecureContext;
  const createSecureContext = vi.fn(() => secureContext);
  const request = vi.fn(
    (url: URL, options: RequestOptions, receive: (value: IncomingMessage) => void) => {
      const transport = new StubRequest(
        receive,
        typeof payload === "function" ? payload(url) : payload,
        settings.status,
        settings.outcome,
      );
      requests.push({ url, options, transport });
      settings.onCreate?.();
      return transport as unknown as ClientRequest;
    },
  );
  const api = new HttpWorkerApi(settings.config ?? config(), logger, {
    createSecureContext,
    httpRequest: request,
    httpsRequest: request,
  });
  return { api, requests, logs, createSecureContext, secureContext };
}

afterEach(() => vi.useRealTimers());

describe("Summary input transport boundaries", () => {
  it.each(["factory", "write", "end", "event"] as const)(
    "redacts %s transport failures and preserves permanent TLS classification",
    async (phase) => {
      const failure = Object.assign(new Error(`private ${workerToken} ${leaseToken}`), {
        code: "CERT_UNTRUSTED",
      });
      const test = setup(summaryInputResponse(), {
        outcome: "pending",
        onCreate: () => {
          if (phase === "factory") throw failure;
          const request = test.requests[0]?.transport;
          if (request === undefined) throw new Error("The request fixture is missing.");
          if (phase === "write")
            request.write = () => {
              throw failure;
            };
          else if (phase === "end")
            request.end = () => {
              throw failure;
            };
          else queueMicrotask(() => request.emit("error", failure));
        },
      });
      const error = await test.api
        .freezeValidationSummaryInput(summaryInputRequest())
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ name: "WorkerApiError", isRetryable: false });
      expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(workerToken);
      expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(leaseToken);
      expect(test.requests).toHaveLength(1);
      if (phase !== "factory") expect(test.requests[0]?.transport.destroyed).toBe(true);
    },
  );

  it.each(["body", "escaped", "key", "http-error"])(
    "redacts reflected lease authentication in %s",
    async (kind) => {
      const reflected =
        kind === "key" ? { [leaseToken]: "private" } : { error: { reflected: leaseToken } };
      const body =
        kind === "escaped"
          ? Buffer.from(JSON.stringify(reflected).replaceAll("L", "\\u004c"))
          : reflected;
      const test = setup(body, { status: kind === "http-error" ? 500 : 200 });
      const error = await test.api
        .freezeValidationSummaryInput(summaryInputRequest())
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ProtocolError);
      expect(inspect({ error, logs: test.logs }, { depth: 20, showHidden: true })).not.toContain(
        leaseToken,
      );
      expect(inspect({ error, logs: test.logs }, { depth: 20, showHidden: true })).not.toContain(
        workerToken,
      );
    },
  );

  it.each(["invalid-utf8", "malformed", "trailing", "oversized", "surrogate"])(
    "rejects a %s response before interpreting its success",
    async (kind) => {
      let raw = Buffer.from(JSON.stringify(summaryInputResponse()));
      if (kind === "invalid-utf8")
        raw = Buffer.concat([
          Buffer.from('{"bad":"'),
          Buffer.from([0xc3, 0x28]),
          Buffer.from('"}'),
        ]);
      else if (kind === "malformed") raw = Buffer.from("{");
      else if (kind === "trailing") raw = Buffer.concat([raw, Buffer.from("true")]);
      else if (kind === "oversized") raw = Buffer.from(`"${"x".repeat(32 * 1024)}"`);
      else raw = Buffer.from('{"bad":"\\ud800"}');
      const test = setup(raw);
      await expect(
        test.api.freezeValidationSummaryInput(summaryInputRequest()),
      ).rejects.toBeInstanceOf(ProtocolError);
      if (kind === "oversized") expect(test.requests[0]?.transport.destroyed).toBe(true);
    },
  );

  it.each(["aborted", "error", "closed"] as const)(
    "rejects a response that was %s without leaking transport details",
    async (outcome) => {
      const test = setup(summaryInputResponse(), { outcome });
      const error = await test.api
        .freezeValidationSummaryInput(summaryInputRequest())
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(WorkerApiError);
      expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(leaseToken);
      expect(test.requests[0]?.transport.destroyed).toBe(true);
      expect(test.requests).toHaveLength(1);
    },
  );

  it("preserves lease conflict semantics while omitting response messages", async () => {
    const test = setup(
      { error: { code: "lease_lost", message: "private server detail", retryable: false } },
      { status: 409 },
    );
    const error = await test.api
      .freezeValidationSummaryInput(summaryInputRequest())
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(WorkerApiError);
    expect(error).toMatchObject({
      statusCode: 409,
      errorCode: "lease_lost",
      isLeaseLost: true,
      isRetryable: false,
    });
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain("private server detail");
  });

  it.each(["before", "during-factory", "pending"] as const)(
    "handles cancellation %s without copying its private reason",
    async (phase) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error(`private ${leaseToken} ${workerToken}`));
      if (phase === "before") cancel();
      const test = setup(summaryInputResponse(), {
        outcome: "pending",
        ...(phase === "during-factory" ? { onCreate: cancel } : {}),
      });
      const pending = test.api.freezeValidationSummaryInput(
        summaryInputRequest(),
        controller.signal,
      );
      if (phase === "pending") cancel();
      const error = await pending.catch((value: unknown) => value);
      expect(error).toMatchObject({
        name: "WorkerApiError",
        errorCode: "request_aborted",
        isRetryable: false,
      });
      expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(leaseToken);
      if (phase === "before") expect(test.requests).toHaveLength(0);
      else expect(test.requests[0]?.transport.destroyed).toBe(true);
    },
  );

  it("enforces an absolute deadline without retrying the mutation", async () => {
    vi.useFakeTimers();
    const test = setup(summaryInputResponse(), { outcome: "pending" });
    const pending = test.api
      .freezeValidationSummaryInput(summaryInputRequest())
      .catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ name: "WorkerApiError", statusCode: 408 });
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]?.transport.destroyed).toBe(true);
  });

  it.each(["http", "credentials", "timeout"])(
    "rejects invalid %s transport configuration",
    async (kind) => {
      const changed: WorkerConfig = {
        ...config(),
        ...(kind === "http"
          ? { serverUrl: new URL("http://127.0.0.1:8000") }
          : kind === "credentials"
            ? { serverUrl: new URL("https://user:private@worker-api.internal") }
            : { requestTimeoutSeconds: Infinity }),
      };
      const test = setup(summaryInputResponse(), { config: changed });
      await expect(
        test.api.freezeValidationSummaryInput(summaryInputRequest()),
      ).rejects.toBeInstanceOf(ProtocolError);
      expect(test.requests).toHaveLength(0);
    },
  );

  it("allows explicitly configured development HTTP with the same authentication", async () => {
    const changed = {
      ...config(),
      serverUrl: new URL("http://127.0.0.1:8000"),
      allowInsecureHttp: true,
    };
    const test = setup(summaryInputResponse(), { config: changed });
    await expect(test.api.freezeValidationSummaryInput(summaryInputRequest())).resolves.toEqual(
      summaryInputResponse(),
    );
    expect(test.requests[0]?.options.headers).toMatchObject({
      authorization: `Bearer ${workerToken}`,
    });
  });
});

describe("summary input snapshots", () => {
  it("copies response receipts before returning them to callers", () => {
    const request = summaryInputRequest();
    const response = summaryInputResponse(request);
    const copy = parseFreezeValidationSummaryInputResponse(response, request);
    response.reference.inputId = "changed-input";
    expect(copy.reference.inputId).toBe(request.inputId);
  });

  it("rejects request accessors without evaluating them", () => {
    const request = summaryInputRequest();
    const getter = vi.fn(() => "input-a");
    Object.defineProperty(request, "inputId", { enumerable: true, get: getter });
    expect(() => snapshotFreezeValidationSummaryInputRequest(request)).toThrow(ProtocolError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects nested request proxies without invoking their traps", () => {
    const request = summaryInputRequest();
    const getPrototypeOf = vi.fn(() => Object.prototype);
    const ownKeys = vi.fn(() => []);
    request.context = new Proxy(request.context, { getPrototypeOf, ownKeys });
    expect(() => snapshotFreezeValidationSummaryInputRequest(request)).toThrow(ProtocolError);
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("rejects inherited array serializers without evaluating them", () => {
    const request = summaryInputRequest();
    const getter = vi.fn(() => () => []);
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, "toJSON", { get: getter });
    Object.setPrototypeOf(request.context.execution.diagnostics, prototype);
    expect(() => snapshotFreezeValidationSummaryInputRequest(request)).toThrow(ProtocolError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["toJSON", "undefined", "symbol", "cycle", "surrogate", "non-enumerable", "worker"])(
    "rejects invalid %s input before sending a request",
    async (kind) => {
      const request = summaryInputRequest();
      const record = request as unknown as Record<string, unknown>;
      const toJSON = vi.fn(() => summaryInputRequest());
      if (kind === "toJSON") record.toJSON = toJSON;
      else if (kind === "undefined") record.extra = undefined;
      else if (kind === "symbol") Object.defineProperty(request, Symbol("extra"), { value: true });
      else if (kind === "cycle") record.extra = request;
      else if (kind === "surrogate") request.context.report.summary = "\ud800";
      else if (kind === "non-enumerable") Object.defineProperty(request, "extra", { value: true });
      else request.lease.workerNodeId = "another-worker";
      const test = setup();
      await expect(test.api.freezeValidationSummaryInput(request)).rejects.toBeInstanceOf(
        ProtocolError,
      );
      expect(toJSON).not.toHaveBeenCalled();
      expect(test.requests).toHaveLength(0);
    },
  );

  it("rejects response accessors without evaluating them", () => {
    const request = summaryInputRequest();
    const response = summaryInputResponse(request);
    const getter = vi.fn(() => "input-a");
    Object.defineProperty(response.reference, "inputId", { enumerable: true, get: getter });
    expect(() => parseFreezeValidationSummaryInputResponse(response, request)).toThrow(
      ProtocolError,
    );
    expect(getter).not.toHaveBeenCalled();
  });
});
