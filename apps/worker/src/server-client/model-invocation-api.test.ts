import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { SecureContext } from "node:tls";
import { inspect } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import type {
  FreezeValidationSummaryInputRequest,
  FreezeValidationSummaryInputResponse,
  ModelCallReceiptV1,
  ModelInvocationBeginRequest,
  ModelInvocationOpeningV1,
  ModelInvocationSealRequest,
  ModelInvocationSealV1,
  ModelInvocationSubmissionV1,
  ModelInvocationSubmitRequest,
  ModelRuntimeIdentityV1,
} from "@agentic-review/contracts";
import {
  modelCallReceiptDigest,
  modelInvocationReceiptSetDigest,
  modelInvocationScopeDigest,
  modelRuntimeIdentityDigest,
} from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { ProtocolError, WorkerApiError } from "./errors.js";
import { HttpWorkerApi } from "./http-worker-api.js";
import { type ModelInvocationApi, parseModelInvocationSubmission } from "./model-invocation-api.js";

const workerToken = `arw1_${"W".repeat(43)}`;
const leaseToken = "L".repeat(32);

function summaryInputRequest(): FreezeValidationSummaryInputRequest {
  const lease = beginRequest().lease;
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
const openedAt = "2026-09-08T00:00:00.000Z";
const closedAt = "2026-09-08T00:00:03.000Z";
const serverTime = "2026-09-08T00:00:04.000Z";
const digest = (character: string) => character.repeat(64);

function beginRequest(): ModelInvocationBeginRequest {
  return {
    lease: {
      jobId: "job-1",
      runAttemptId: "attempt-1",
      workerNodeId: "worker-node-1",
      workerInstanceId: "worker-instance-1",
      leaseToken,
      leaseGeneration: 2,
    },
    invocationId: "invocation-1",
    runtime: {
      providerId: "synthetic-provider",
      endpointSha256: digest("a"),
      client: {
        kind: "codex_cli",
        version: "synthetic-client-1",
        executableSha256: digest("b"),
        launchPolicySha256: digest("c"),
      },
      relay: { implementationSha256: digest("d"), policySha256: digest("e") },
    },
  };
}

function observedIdentity(): ModelRuntimeIdentityV1 {
  return {
    schemaVersion: "ModelRuntimeIdentityV1",
    ...beginRequest().runtime,
    modelId: "synthetic-model-1",
  };
}

function openingResponse(): ModelInvocationOpeningV1 {
  const scope: ModelInvocationOpeningV1["scope"] = {
    schemaVersion: "ModelInvocationScopeV1",
    repositoryId: "repository-1",
    evaluationId: "evaluation-1",
    cellId: "cell-1",
    runId: "run-1",
    requestId: "request-1",
    jobId: "job-1",
    attemptId: "attempt-1",
    invocationId: "invocation-1",
    authorizationId: "authorization-1",
    executionManifestSha256: digest("1"),
    promptSha256: digest("2"),
    outputSchemaSha256: digest("3"),
    expectedModelIdentitySha256: modelRuntimeIdentityDigest(observedIdentity()),
    requestedModel: "synthetic-model-1",
    workerNodeId: "worker-node-1",
    workerInstanceId: "worker-instance-1",
    leaseGeneration: 2,
  };
  return {
    schemaVersion: "ModelInvocationOpeningV1",
    scope,
    scopeSha256: modelInvocationScopeDigest(scope),
    runtime: beginRequest().runtime,
    openedAt,
  };
}

function submitRequest(): ModelInvocationSubmitRequest {
  const opening = openingResponse();
  const receipt: ModelCallReceiptV1 = {
    schemaVersion: "ModelCallReceiptV1",
    scopeSha256: opening.scopeSha256,
    sequence: 1,
    previousReceiptSha256: null,
    startedAt: "2026-09-08T00:00:01.000Z",
    finishedAt: "2026-09-08T00:00:02.000Z",
    requestSha256: digest("4"),
    requestBytes: 100,
    requestedModel: opening.scope.requestedModel,
    httpStatus: 200,
    response: {
      schemaVersion: "ModelResponseObservationV1",
      bodySha256: digest("5"),
      bodyBytes: 200,
      eventCount: 1,
      transportComplete: true,
      outcome: "completed",
      responseId: "response-1",
      modelId: observedIdentity().modelId,
      outputJsonSha256: digest("6"),
      reasonCode: null,
    },
    outcome: "completed",
  };
  return {
    lease: beginRequest().lease,
    invocationId: opening.scope.invocationId,
    receiptSet: {
      schemaVersion: "ModelInvocationReceiptSetV1",
      scope: opening.scope,
      scopeSha256: opening.scopeSha256,
      runtime: opening.runtime,
      calls: [{ receipt, sha256: modelCallReceiptDigest(receipt) }],
      closedAt,
      state: "closed",
      modelOutputSha256: digest("6"),
      observedIdentity: observedIdentity(),
      observedIdentitySha256: modelRuntimeIdentityDigest(observedIdentity()),
    },
  };
}

function sealRequest(): ModelInvocationSealRequest {
  const submission = submitRequest();
  const set = submission.receiptSet;
  return {
    lease: submission.lease,
    invocationId: submission.invocationId,
    scopeSha256: set.scopeSha256,
    receiptSetSha256: modelInvocationReceiptSetDigest(set),
    closedAt: set.closedAt,
    state: set.state,
    callCount: set.calls.length,
    lastReceiptSha256: set.calls.at(-1)?.sha256 ?? null,
    modelOutputSha256: set.modelOutputSha256,
    observedIdentitySha256: set.observedIdentitySha256,
    processClosed: true,
    relayClosed: true,
  };
}

function sealResponse(): ModelInvocationSealV1 {
  const { lease: _lease, ...closure } = sealRequest();
  return { schemaVersion: "ModelInvocationSealV1", ...closure, recordedAt: serverTime };
}

function submissionResponse(): ModelInvocationSubmissionV1 {
  const request = submitRequest();
  return {
    schemaVersion: "ModelInvocationSubmissionV1",
    invocationId: request.invocationId,
    scopeSha256: request.receiptSet.scopeSha256,
    receiptSetSha256: modelInvocationReceiptSetDigest(request.receiptSet),
    receivedAt: serverTime,
    consistency: {
      state: "matched",
      reasons: [],
      observedIdentitySha256: request.receiptSet.observedIdentitySha256,
    },
    executionAccepted: false,
  };
}

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
      codexVersion: "not-configured",
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
  payload: unknown | ((url: URL) => unknown) = openingResponse(),
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

describe("Worker model invocation protocol", () => {
  it("sends three scoped requests with shared trusted TLS and records consistency only", async () => {
    const test = setup((url: URL) =>
      url.pathname.endsWith("/open")
        ? openingResponse()
        : url.pathname.endsWith("/seal")
          ? sealResponse()
          : submissionResponse(),
    );
    const api: ModelInvocationApi = test.api;
    expect(await api.beginModelInvocation(beginRequest())).toEqual(openingResponse());
    expect(await api.sealModelInvocation(sealRequest())).toEqual(sealResponse());
    expect(await api.submitModelInvocationReceipts(submitRequest())).toEqual(submissionResponse());
    expect(test.createSecureContext).toHaveBeenCalledExactlyOnceWith({ ca: config().tls?.ca });
    expect(test.requests.map((entry) => entry.url.pathname)).toEqual([
      "/api/v1/worker/runs/attempt-1/model-invocations/open",
      "/api/v1/worker/runs/attempt-1/model-invocations/invocation-1/seal",
      "/api/v1/worker/runs/attempt-1/model-invocations/invocation-1/receipts",
    ]);
    const bodies = [beginRequest(), sealRequest(), submitRequest()];
    for (const [index, entry] of test.requests.entries()) {
      expect(entry.options).toMatchObject({
        method: "POST",
        secureContext: test.secureContext,
        rejectUnauthorized: true,
        servername: "worker-api.internal",
        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
      });
      expect(entry.transport.writes).toHaveLength(1);
      const serialized = entry.transport.writes[0] as Buffer;
      expect(serialized.toString("utf8")).toBe(JSON.stringify(bodies[index]));
      expect(entry.options.headers).toHaveProperty("content-length", serialized.byteLength);
    }
    expect(test.logs.map((entry) => (entry as { fields: unknown }).fields)).toEqual([
      { operation: "open" },
      { operation: "seal" },
      { operation: "receipts" },
    ]);
    expect(inspect(test.logs)).not.toContain(workerToken);
    expect(inspect(test.logs)).not.toContain(leaseToken);
  });

  it("keeps the original route, serialized payload and expected echo after caller mutation", async () => {
    const request = beginRequest();
    const original = structuredClone(request);
    const test = setup(openingResponse(), {
      onCreate: () => {
        request.invocationId = "changed-invocation";
        request.lease.runAttemptId = "changed-attempt";
        request.runtime.client.version = "changed-version";
      },
    });
    const result = await test.api.beginModelInvocation(request);
    expect(result).toEqual(openingResponse());
    expect(test.requests[0]?.url.pathname).toContain("/attempt-1/");
    expect(test.requests[0]?.transport.writes[0]?.toString("utf8")).toBe(JSON.stringify(original));
  });

  it.each(["seal", "submit"] as const)(
    "keeps the original %s payload and response expectation after caller mutation",
    async (operation) => {
      const request = operation === "seal" ? sealRequest() : submitRequest();
      const original = structuredClone(request);
      const response = operation === "seal" ? sealResponse() : submissionResponse();
      const test = setup(response, {
        onCreate: () => {
          request.invocationId = "changed-invocation";
          request.lease.runAttemptId = "changed-attempt";
          if ("receiptSet" in request)
            request.receiptSet.runtime.client.version = "changed-version";
          else request.modelOutputSha256 = null;
        },
      });
      const pending =
        operation === "seal"
          ? test.api.sealModelInvocation(request as ModelInvocationSealRequest)
          : test.api.submitModelInvocationReceipts(request as ModelInvocationSubmitRequest);
      expect(await pending).toEqual(response);
      expect(test.requests[0]?.transport.writes[0]?.toString("utf8")).toBe(
        JSON.stringify(original),
      );
      expect(test.requests[0]?.url.pathname).toContain(
        "/attempt-1/model-invocations/invocation-1/",
      );
    },
  );

  it.each([
    "jobId",
    "attemptId",
    "invocationId",
    "workerNodeId",
    "workerInstanceId",
    "leaseGeneration",
  ] as const)(
    "rejects an opening for another %s even when its digest is correct",
    async (field) => {
      const response = openingResponse();
      if (field === "leaseGeneration") response.scope[field]++;
      else response.scope[field] = "another-identity";
      response.scopeSha256 = modelInvocationScopeDigest(response.scope);
      await expect(setup(response).api.beginModelInvocation(beginRequest())).rejects.toBeInstanceOf(
        ProtocolError,
      );
    },
  );

  it.each([
    "providerId",
    "endpointSha256",
    "client.version",
    "client.executableSha256",
    "client.launchPolicySha256",
    "relay.implementationSha256",
    "relay.policySha256",
  ])("rejects a changed opening runtime %s", async (field) => {
    const response = openingResponse();
    const parts = field.split(".");
    const object =
      parts.length === 1
        ? (response.runtime as unknown as Record<string, string>)
        : (response.runtime[parts[0] as "client" | "relay"] as unknown as Record<string, string>);
    object[parts.at(-1) as string] = field.endsWith("Sha256") ? digest("9") : "another-runtime";
    await expect(setup(response).api.beginModelInvocation(beginRequest())).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it("recomputes the whole opening scope digest, including Server-owned fields", async () => {
    const response = openingResponse();
    response.scope.repositoryId = "another-repository";
    await expect(setup(response).api.beginModelInvocation(beginRequest())).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it.each([
    ["invocationId", "another-invocation"],
    ["scopeSha256", digest("9")],
    ["receiptSetSha256", digest("9")],
    ["closedAt", "2026-09-08T00:00:05.000Z"],
    ["state", "cancelled"],
    ["callCount", 2],
    ["lastReceiptSha256", digest("9")],
    ["modelOutputSha256", null],
    ["observedIdentitySha256", null],
    ["processClosed", false],
    ["relayClosed", false],
  ])("rejects a seal that changes %s", async (field, changed) => {
    const response = { ...sealResponse(), [String(field)]: changed };
    await expect(setup(response).api.sealModelInvocation(sealRequest())).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it.each(["invocationId", "scopeSha256", "receiptSetSha256"] as const)(
    "rejects a receipt acknowledgement for another %s",
    async (field) => {
      const response = submissionResponse();
      response[field] = field === "invocationId" ? "another-invocation" : digest("9");
      await expect(
        setup(response).api.submitModelInvocationReceipts(submitRequest()),
      ).rejects.toBeInstanceOf(ProtocolError);
    },
  );

  it("rejects a promoted execution flag and a foreign observed identity", async () => {
    const response = submissionResponse();
    await expect(
      setup({ ...response, executionAccepted: true }).api.submitModelInvocationReceipts(
        submitRequest(),
      ),
    ).rejects.toBeInstanceOf(ProtocolError);
    response.consistency.observedIdentitySha256 = digest("9");
    await expect(
      setup(response).api.submitModelInvocationReceipts(submitRequest()),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it("allows invalid consistency to discard an untrusted observed identity", async () => {
    const response = submissionResponse();
    response.consistency = {
      state: "invalid",
      reasons: ["RECEIPT_DIGEST_MISMATCH"],
      observedIdentitySha256: null,
    };
    expect(await setup(response).api.submitModelInvocationReceipts(submitRequest())).toEqual(
      response,
    );
  });

  it.each(["scope", "receipt", "identity"])(
    "rejects a locally corrupted %s digest before transport",
    async (field) => {
      const request = submitRequest();
      if (field === "scope") {
        request.receiptSet.scopeSha256 = digest("9");
        (
          request.receiptSet.calls[0] as NonNullable<(typeof request.receiptSet.calls)[0]>
        ).receipt.scopeSha256 = digest("9");
      } else if (field === "receipt") {
        (request.receiptSet.calls[0] as NonNullable<(typeof request.receiptSet.calls)[0]>).sha256 =
          digest("9");
      } else request.receiptSet.observedIdentitySha256 = digest("9");
      const test = setup(submissionResponse());
      await expect(test.api.submitModelInvocationReceipts(request)).rejects.toBeInstanceOf(
        ProtocolError,
      );
      expect(test.requests).toHaveLength(0);
    },
  );

  it.each(["begin", "seal", "submit"] as const)(
    "rejects getters without invoking them in a %s request",
    async (operation) => {
      const request =
        operation === "begin"
          ? beginRequest()
          : operation === "seal"
            ? sealRequest()
            : submitRequest();
      const getter = vi.fn(() => "invocation-1");
      Object.defineProperty(request, "invocationId", { enumerable: true, get: getter });
      const test = setup();
      const response =
        operation === "begin"
          ? test.api.beginModelInvocation(request as ModelInvocationBeginRequest)
          : operation === "seal"
            ? test.api.sealModelInvocation(request as ModelInvocationSealRequest)
            : test.api.submitModelInvocationReceipts(request as ModelInvocationSubmitRequest);
      await expect(response).rejects.toBeInstanceOf(ProtocolError);
      expect(getter).not.toHaveBeenCalled();
      expect(test.requests).toHaveLength(0);
    },
  );

  it("enforces the aggregate receipt byte budget across individually bounded calls", async () => {
    const request = submitRequest();
    const set = request.receiptSet;
    const longModel = "\u754c".repeat(1024);
    set.scope.requestedModel = longModel;
    if (set.observedIdentity === null) throw new Error("The fixture requires an identity.");
    set.observedIdentity.modelId = longModel;
    set.observedIdentitySha256 = modelRuntimeIdentityDigest(set.observedIdentity);
    set.scope.expectedModelIdentitySha256 = set.observedIdentitySha256;
    set.scopeSha256 = modelInvocationScopeDigest(set.scope);
    const first = structuredClone(set.calls[0]?.receipt) as ModelCallReceiptV1;
    set.calls = [];
    for (let index = 0; index < 128; index++) {
      const receipt = structuredClone(first);
      receipt.scopeSha256 = set.scopeSha256;
      receipt.sequence = index + 1;
      receipt.previousReceiptSha256 = set.calls.at(-1)?.sha256 ?? null;
      receipt.requestedModel = longModel;
      if (receipt.response === null) throw new Error("The fixture requires an observation.");
      receipt.response.modelId = longModel;
      receipt.response.responseId = "\u8bc1".repeat(1024);
      set.calls.push({ receipt, sha256: modelCallReceiptDigest(receipt) });
    }
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeGreaterThan(1024 * 1024);
    const test = setup(submissionResponse());
    await expect(test.api.submitModelInvocationReceipts(request)).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(test.requests).toHaveLength(0);
  });

  it("rejects an inherited array toJSON getter without invoking it", async () => {
    const request = submitRequest();
    const getter = vi.fn(() => () => []);
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, "toJSON", { get: getter });
    Object.setPrototypeOf(request.receiptSet.calls, prototype);
    const test = setup(submissionResponse());
    await expect(test.api.submitModelInvocationReceipts(request)).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(test.requests).toHaveLength(0);
  });

  it("rejects a nested Proxy without invoking its traps", async () => {
    const request = beginRequest();
    const getPrototypeOf = vi.fn(() => Object.prototype);
    const ownKeys = vi.fn(() => []);
    request.runtime = new Proxy(request.runtime, { getPrototypeOf, ownKeys });
    const test = setup();
    await expect(test.api.beginModelInvocation(request)).rejects.toBeInstanceOf(ProtocolError);
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
    expect(test.requests).toHaveLength(0);
  });

  it("rejects inherited getters in an in-process submission response", () => {
    const response = submissionResponse();
    const getter = vi.fn(() => () => []);
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, "toJSON", { get: getter });
    Object.setPrototypeOf(response.consistency.reasons, prototype);
    expect(() => parseModelInvocationSubmission(response, submitRequest())).toThrow(ProtocolError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    "toJSON",
    "undefined",
    "symbol",
    "cycle",
    "surrogate",
    "non-enumerable",
    "oversized",
    "worker",
  ])("rejects an invalid %s request before transport", async (kind) => {
    const request = beginRequest();
    const record = request as unknown as Record<string, unknown>;
    const toJSON = vi.fn(() => beginRequest());
    if (kind === "toJSON") record.toJSON = toJSON;
    else if (kind === "undefined") record.extra = undefined;
    else if (kind === "symbol") Object.defineProperty(request, Symbol("extra"), { value: true });
    else if (kind === "cycle") record.extra = request;
    else if (kind === "surrogate") request.runtime.providerId = "\ud800";
    else if (kind === "non-enumerable") Object.defineProperty(request, "extra", { value: true });
    else if (kind === "oversized") request.runtime.providerId = "x".repeat(32 * 1024 + 1);
    else request.lease.workerNodeId = "another-worker";
    const test = setup();
    await expect(test.api.beginModelInvocation(request)).rejects.toBeInstanceOf(ProtocolError);
    expect(toJSON).not.toHaveBeenCalled();
    expect(test.requests).toHaveLength(0);
  });
});

describe("Worker model invocation transport boundaries", () => {
  it.each(["factory", "write", "end", "event"] as const)(
    "redacts %s transport failures and preserves permanent TLS classification",
    async (phase) => {
      const failure = Object.assign(new Error(`private ${workerToken} ${leaseToken}`), {
        code: "CERT_UNTRUSTED",
      });
      const test = setup(openingResponse(), {
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
        .beginModelInvocation(beginRequest())
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
        .beginModelInvocation(beginRequest())
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

  it.each(["duplicate", "invalid-utf8", "malformed", "trailing", "oversized", "surrogate"])(
    "rejects a %s response before interpreting its success",
    async (kind) => {
      let raw = Buffer.from(JSON.stringify(openingResponse()));
      if (kind === "duplicate")
        raw = Buffer.from(
          raw
            .toString()
            .replace(
              '"schemaVersion":',
              '"schemaVersion":"ModelInvocationOpeningV1","schemaVersion":',
            ),
        );
      else if (kind === "invalid-utf8")
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
      await expect(test.api.beginModelInvocation(beginRequest())).rejects.toBeInstanceOf(
        ProtocolError,
      );
      if (kind === "oversized") expect(test.requests[0]?.transport.destroyed).toBe(true);
    },
  );

  it.each(["aborted", "error", "closed"] as const)(
    "rejects a response that was %s without leaking transport details",
    async (outcome) => {
      const test = setup(openingResponse(), { outcome });
      const error = await test.api
        .beginModelInvocation(beginRequest())
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
      .beginModelInvocation(beginRequest())
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
      const test = setup(openingResponse(), {
        outcome: "pending",
        ...(phase === "during-factory" ? { onCreate: cancel } : {}),
      });
      const pending = test.api.beginModelInvocation(beginRequest(), controller.signal);
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
    const test = setup(openingResponse(), { outcome: "pending" });
    const pending = test.api.beginModelInvocation(beginRequest()).catch((value: unknown) => value);
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
      const test = setup(openingResponse(), { config: changed });
      await expect(test.api.beginModelInvocation(beginRequest())).rejects.toBeInstanceOf(
        ProtocolError,
      );
      expect(test.requests).toHaveLength(0);
    },
  );

  it("allows explicitly configured development HTTP with the same authentication", async () => {
    const changed = {
      ...config(),
      serverUrl: new URL("http://127.0.0.1:8000"),
      allowInsecureHttp: true,
    };
    const test = setup(openingResponse(), { config: changed });
    await expect(test.api.beginModelInvocation(beginRequest())).resolves.toEqual(openingResponse());
    expect(test.requests[0]?.options.headers).toMatchObject({
      authorization: `Bearer ${workerToken}`,
    });
  });
});
