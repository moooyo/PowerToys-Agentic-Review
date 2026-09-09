import { createHash } from "node:crypto";
import { request } from "node:http";
import { Readable } from "node:stream";
import { createCanonicalResult } from "@agentic-review/codex";
import type * as C from "@agentic-review/contracts";
import {
  modelInvocationReceiptSetDigest,
  modelInvocationScopeDigest,
} from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInvocationApi } from "../server-client/model-invocation-api.js";
import {
  createModelInvocationSession,
  type ModelInvocationSession,
  type ModelInvocationSessionOptions,
} from "./model-invocation-coordinator.js";
import * as relayModule from "./model-response-relay.js";
import type { ManagedProcess, ProcessExitedEvent } from "./process-host-protocol.js";

const endpoint = "https://provider.example.invalid/v1/responses";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const modelOutput = { answer: "Synthetic coordinator fixture." };
const outputSha256 = createCanonicalResult(modelOutput).sha256;
const controllers: AbortController[] = [];
const sessions: ModelInvocationSession[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(
    sessions.splice(0).map((session) => session.close({ modelOutputSha256: null })),
  );
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeOwnedProcess() {
  const completed = deferred<ProcessExitedEvent>();
  const drained = deferred<unknown>();
  const managed: ManagedProcess = {
    requestId: "process-fixture",
    processId: 321,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    completed: completed.promise,
    terminate: vi.fn(async () => undefined),
  };
  const exit = (overrides: Partial<ProcessExitedEvent> = {}) =>
    completed.resolve({
      protocolVersion: "1.0",
      type: "exited",
      requestId: managed.requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
      ...overrides,
    });
  return { managed, completed, drained, exit };
}

function fixtureOptions(overrides: Partial<ModelInvocationSessionOptions> = {}) {
  const controller = new AbortController();
  controllers.push(controller);
  const runtime: C.ModelInvocationReceiptSetV1["runtime"] = {
    providerId: "synthetic-provider",
    endpointSha256: sha256(endpoint),
    client: {
      kind: "codex_cli",
      version: "synthetic-cli",
      executableSha256: sha256("client"),
      launchPolicySha256: sha256("launch"),
    },
    relay: {
      implementationSha256: sha256("relay"),
      policySha256: relayModule.describeModelResponseRelayPolicy({ closeTimeoutMs: 100 }).sha256,
    },
  };
  const expectedScope: C.ModelInvocationScopeV1 = {
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
    executionManifestSha256: sha256("manifest"),
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
  const lease: C.LeaseIdentity = {
    jobId: expectedScope.jobId,
    runAttemptId: expectedScope.attemptId,
    workerNodeId: expectedScope.workerNodeId,
    workerInstanceId: expectedScope.workerInstanceId,
    leaseGeneration: 1,
    leaseToken: "synthetic-lease-token-01234567890123456789",
  };
  const opening = (): C.ModelInvocationOpeningV1 => ({
    schemaVersion: "ModelInvocationOpeningV1",
    scope: structuredClone(expectedScope),
    scopeSha256: modelInvocationScopeDigest(expectedScope),
    runtime: structuredClone(runtime),
    openedAt: new Date().toISOString(),
  });
  const sealResponse = (value: C.ModelInvocationSealRequest): C.ModelInvocationSealV1 => {
    const { lease: _lease, ...closure } = value;
    return {
      schemaVersion: "ModelInvocationSealV1",
      ...closure,
      recordedAt: new Date().toISOString(),
    };
  };
  const submissionResponse = (
    value: C.ModelInvocationSubmitRequest,
  ): C.ModelInvocationSubmissionV1 => ({
    schemaVersion: "ModelInvocationSubmissionV1",
    invocationId: value.invocationId,
    scopeSha256: value.receiptSet.scopeSha256,
    receiptSetSha256: modelInvocationReceiptSetDigest(value.receiptSet),
    receivedAt: new Date().toISOString(),
    executionAccepted: false,
    consistency:
      value.receiptSet.observedIdentitySha256 === null
        ? {
            state: "unavailable",
            reasons: ["OBSERVED_IDENTITY_MISSING"],
            observedIdentitySha256: null,
          }
        : {
            state: "matched",
            reasons: [],
            observedIdentitySha256: value.receiptSet.observedIdentitySha256,
          },
  });
  const api = {
    beginModelInvocation: vi.fn<ModelInvocationApi["beginModelInvocation"]>(async () => opening()),
    sealModelInvocation: vi.fn<ModelInvocationApi["sealModelInvocation"]>(async (value) =>
      sealResponse(value),
    ),
    submitModelInvocationReceipts: vi.fn<ModelInvocationApi["submitModelInvocationReceipts"]>(
      async (value) => submissionResponse(value),
    ),
  };
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          id: "resp_fixture",
          object: "response",
          created_at: 1740855869,
          status: "completed",
          model: "observed-fixture-model",
          error: null,
          incomplete_details: null,
          output: [
            {
              id: "msg_fixture",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                { type: "output_text", text: JSON.stringify(modelOutput), annotations: [] },
              ],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const options: ModelInvocationSessionOptions = {
    api,
    lease,
    expectedScope,
    runtime,
    operationTimeoutMs: 500,
    processTimeoutMs: 500,
    relayOptions: {
      endpoint,
      signal: controller.signal,
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      limits: { closeTimeoutMs: 100 },
      transport,
      authorize: async () => ({
        headers: { Authorization: "Bearer synthetic-provider-only" },
        protectedValues: [],
      }),
    },
    ...overrides,
  };
  return {
    options,
    controller,
    api,
    transport,
    expectedScope,
    runtime,
    lease,
    opening,
    sealResponse,
    submissionResponse,
  };
}

async function fixture(overrides: Partial<ModelInvocationSessionOptions> = {}) {
  const value = fixtureOptions(overrides);
  const session = await createModelInvocationSession(value.options);
  sessions.push(session);
  return { ...value, session };
}
function summaryScope(scope: C.ModelInvocationScopeV1): C.ModelInvocationScopeV2 {
  return {
    ...scope,
    schemaVersion: "ModelInvocationScopeV2",
    purpose: "validation_summary",
    inputRef: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "summary-input",
      inputSha256: sha256("frozen input"),
      sourcePromptSha256: scope.promptSha256,
      outputSchemaSha256: scope.outputSchemaSha256,
      contextSha256: sha256("summary context"),
      actualPromptSha256: sha256("actual summary prompt"),
    },
  };
}
function openingV2(
  f: ReturnType<typeof fixtureOptions>,
  scope: C.ModelInvocationScopeV2,
): C.ModelInvocationOpeningV2 {
  return {
    ...f.opening(),
    schemaVersion: "ModelInvocationOpeningV2",
    scope: structuredClone(scope),
    scopeSha256: modelInvocationScopeDigest(scope),
  };
}

function post(relay: ModelInvocationSession["relay"]): Promise<string> {
  const body = JSON.stringify({
    model: "requested-fixture-model",
    stream: false,
    input: "Synthetic input only.",
  });
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
        incoming.once("end", () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    outgoing.once("error", reject);
    outgoing.setTimeout(1000, () => outgoing.destroy(new Error("Synthetic request timed out.")));
    outgoing.end(body);
  });
}

function attachFinished(session: ModelInvocationSession) {
  const process = fakeOwnedProcess();
  session.attachProcess(process.managed, process.drained.promise);
  process.exit();
  process.drained.resolve(undefined);
  return process;
}

describe("parent-owned model invocation coordinator", () => {
  it("copies the V2 summary reference into begin and seals the corresponding V2 receipt chain", async () => {
    const f = fixtureOptions();
    const scope = summaryScope(f.expectedScope);
    const retained = structuredClone(scope);
    f.api.beginModelInvocation.mockImplementation(async (request) => {
      expect(request.summaryInput).toEqual(retained.inputRef);
      expect(request.summaryInput).not.toBe(scope.inputRef);
      return openingV2(f, retained);
    });
    const creating = createModelInvocationSession({ ...f.options, expectedScope: scope });
    scope.inputRef.contextSha256 = sha256("modified after snapshot");
    const session = await creating;
    sessions.push(session);
    const process = fakeOwnedProcess();
    session.attachProcess(process.managed, process.drained.promise);
    await post(session.relay);
    const closing = session.close({ modelOutputSha256: outputSha256 });
    process.exit();
    process.drained.resolve(undefined);
    const recorded = await closing;
    expect(recorded).toMatchObject({
      executionAccepted: false,
      modelOutputBound: true,
      submission: { consistency: { state: "matched" } },
    });
    const submitted = f.api.submitModelInvocationReceipts.mock.calls[0]?.[0];
    if (submitted === undefined) throw new Error("The V2 fixture did not submit its receipts.");
    expect(submitted?.receiptSet).toMatchObject({
      schemaVersion: "ModelInvocationReceiptSetV2",
      scope: retained,
    });
    const sealed = f.api.sealModelInvocation.mock.calls[0]?.[0];
    expect(sealed?.receiptSetSha256).toBe(modelInvocationReceiptSetDigest(submitted.receiptSet));
    expect(sealed?.scopeSha256).toBe(modelInvocationScopeDigest(retained));
    expect(JSON.stringify(submitted)).not.toContain("synthetic-provider-only");
    expect(f.api.beginModelInvocation).toHaveBeenCalledOnce();
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it.each(["opening_version", "scope_version", "reference"])(
    "rejects an inconsistent V2 opening: %s",
    async (field) => {
      const f = fixtureOptions();
      const scope = summaryScope(f.expectedScope);
      f.api.beginModelInvocation.mockImplementation(async () => {
        const opening = openingV2(f, scope);
        if (field === "opening_version")
          Reflect.set(opening, "schemaVersion", "ModelInvocationOpeningV1");
        if (field === "scope_version")
          Reflect.set(opening.scope, "schemaVersion", "ModelInvocationScopeV1");
        if (field === "reference") opening.scope.inputRef.inputId = "foreign-input";
        opening.scopeSha256 = createCanonicalResult(opening.scope).sha256;
        return opening;
      });
      await expect(
        createModelInvocationSession({ ...f.options, expectedScope: scope }),
      ).rejects.toMatchObject({ code: "OPENING_INVALID" });
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
      expect(f.api.submitModelInvocationReceipts).not.toHaveBeenCalled();
    },
  );

  it("waits for actual completion and stream drainage, closes the real relay, then seals and submits its own ledger", async () => {
    const f = await fixture();
    const process = fakeOwnedProcess();
    f.session.attachProcess(process.managed, process.drained.promise);
    expect(JSON.parse(await post(f.session.relay)).model).toBe("observed-fixture-model");
    const order: string[] = [];
    f.api.sealModelInvocation.mockImplementation(async (value) => {
      await expect(post(f.session.relay)).rejects.toBeDefined();
      order.push("seal");
      return f.sealResponse(value);
    });
    f.api.submitModelInvocationReceipts.mockImplementation(async (value) => {
      order.push("submit");
      return f.submissionResponse(value);
    });
    const closing = f.session.close({ modelOutputSha256: outputSha256 });
    await process.managed.terminate("cancelled");
    await Promise.resolve();
    expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
    process.exit();
    await Promise.resolve();
    expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
    process.drained.resolve(undefined);
    const recorded = await closing;
    expect(order).toEqual(["seal", "submit"]);
    expect(recorded).toMatchObject({
      executionAccepted: false,
      modelOutputBound: true,
      submission: { executionAccepted: false, consistency: { state: "matched" } },
    });
    const sealed = f.api.sealModelInvocation.mock.calls[0]![0];
    const uploaded = f.api.submitModelInvocationReceipts.mock.calls[0]![0];
    expect(sealed).toMatchObject({
      callCount: 1,
      processClosed: true,
      relayClosed: true,
      modelOutputSha256: outputSha256,
    });
    expect(sealed.receiptSetSha256).toBe(modelInvocationReceiptSetDigest(uploaded.receiptSet));
    expect(sealed.lastReceiptSha256).toBe(uploaded.receiptSet.calls[0]!.sha256);
    expect(uploaded.receiptSet.calls[0]!.receipt.response?.outputJsonSha256).toBe(outputSha256);
    expect(JSON.stringify(uploaded)).not.toContain("synthetic-provider-only");
    expect(Object.keys(f.session).sort()).toEqual(["attachProcess", "close", "opening", "relay"]);
    expect(Object.keys(f.session.relay).sort()).toEqual(["bearerToken", "url"]);
    expect(Object.isFrozen(f.session)).toBe(true);
  });

  it.each([
    "repositoryId",
    "promptSha256",
    "outputSchemaSha256",
    "authorizationId",
    "expectedModelIdentitySha256",
  ] as const)(
    "rejects an owner opening with a different complete scope field: %s",
    async (field) => {
      const f = fixtureOptions();
      f.api.beginModelInvocation.mockImplementation(async () => {
        const changed = f.opening();
        changed.scope[field] = field.endsWith("Sha256") ? sha256("wrong") : "wrong-owner";
        changed.scopeSha256 = modelInvocationScopeDigest(changed.scope);
        return changed;
      });
      await expect(createModelInvocationSession(f.options)).rejects.toMatchObject({
        code: "OPENING_INVALID",
      });
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
    },
  );

  it.each(["runtime", "digest"])("rejects an opening with invalid %s echo", async (changed) => {
    const f = fixtureOptions();
    f.api.beginModelInvocation.mockImplementation(async () => {
      const value = f.opening();
      if (changed === "runtime") value.runtime.client.executableSha256 = sha256("other-client");
      else value.scopeSha256 = sha256("other-scope");
      return value;
    });
    await expect(createModelInvocationSession(f.options)).rejects.toMatchObject({
      code: "OPENING_INVALID",
    });
  });

  it("rejects lease-scope mismatch before sending an opening request", async () => {
    const f = fixtureOptions();
    f.expectedScope.workerInstanceId = "wrong-worker";
    await expect(createModelInvocationSession(f.options)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    expect(f.api.beginModelInvocation).not.toHaveBeenCalled();
  });

  it("takes private immutable inputs before awaiting the owner", async () => {
    const f = fixtureOptions();
    const opening = f.opening();
    const pending = deferred<C.ModelInvocationOpeningV1>();
    f.api.beginModelInvocation.mockReturnValue(pending.promise);
    const creating = createModelInvocationSession(f.options);
    f.expectedScope.repositoryId = "changed-after-create";
    f.runtime.client.executableSha256 = sha256("changed-after-create");
    f.lease.leaseToken = "changed-after-create-01234567890123456789";
    pending.resolve(opening);
    const session = await creating;
    sessions.push(session);
    attachFinished(session);
    await session.close({ modelOutputSha256: null });
    expect(f.api.beginModelInvocation.mock.calls[0]![0].lease.leaseToken).toBe(
      "synthetic-lease-token-01234567890123456789",
    );
    expect(
      f.api.submitModelInvocationReceipts.mock.calls[0]![0].receiptSet.scope.repositoryId,
    ).toBe("repository-a");
  });

  it("attaches only one actual process and never exposes closure authority", async () => {
    const f = await fixture();
    const original = attachFinished(f.session);
    expect(() => f.session.attachProcess(original.managed, original.drained.promise)).toThrowError(
      expect.objectContaining({ code: "PROCESS_ALREADY_ATTACHED" }),
    );
    await f.session.close({ modelOutputSha256: null });
    expect(() => f.session.attachProcess(original.managed, original.drained.promise)).toThrow();
    expect((f.session.relay as unknown as Record<string, unknown>).close).toBeUndefined();
  });

  it("rejects executor-supplied seal, ledger and cleanup fields without freezing an invalid close intent", async () => {
    const f = await fixture();
    attachFinished(f.session);
    for (const field of ["seal", "receiptSet", "processClosed", "relayClosed"]) {
      await expect(
        f.session.close({ modelOutputSha256: null, [field]: true }),
      ).rejects.toMatchObject({ code: "CLOSE_INPUT_INVALID" });
    }
    await f.session.close({ modelOutputSha256: null });
    expect(f.api.submitModelInvocationReceipts).toHaveBeenCalledTimes(1);
  });

  it.each(["seal", "submit"])(
    "retries the original %s payload without reopening or rerunning the process",
    async (stage) => {
      const f = await fixture();
      attachFinished(f.session);
      if (stage === "seal")
        f.api.sealModelInvocation.mockRejectedValueOnce(new Error("Synthetic transient failure."));
      else
        f.api.submitModelInvocationReceipts.mockRejectedValueOnce(
          new Error("Synthetic transient failure."),
        );
      await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
        submissionConfirmed: false,
      });
      await expect(
        f.session.close({ modelOutputSha256: sha256("replacement") }),
      ).rejects.toMatchObject({ code: "CLOSE_INPUT_CONFLICT" });
      await f.session.close({ modelOutputSha256: null });
      await f.session.close({ modelOutputSha256: null });
      const calls =
        stage === "seal"
          ? f.api.sealModelInvocation.mock.calls
          : f.api.submitModelInvocationReceipts.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toBe(calls[1]![0]);
      expect(Object.isFrozen(calls[0]![0])).toBe(true);
      expect(f.api.beginModelInvocation).toHaveBeenCalledTimes(1);
      expect(f.transport).not.toHaveBeenCalled();
      if (stage === "submit") expect(f.api.sealModelInvocation).toHaveBeenCalledTimes(1);
    },
  );

  it("does not overwrite or duplicate a pending seal on concurrent close", async () => {
    const f = await fixture();
    attachFinished(f.session);
    const received = deferred<C.ModelInvocationSealRequest>();
    const response = deferred<C.ModelInvocationSealV1>();
    f.api.sealModelInvocation.mockImplementation((value) => {
      received.resolve(value);
      return response.promise;
    });
    const first = f.session.close({ modelOutputSha256: null });
    const original = await received.promise;
    expect(f.session.close({ modelOutputSha256: null })).toBe(first);
    await expect(f.session.close({ modelOutputSha256: outputSha256 })).rejects.toMatchObject({
      code: "CLOSE_INPUT_CONFLICT",
    });
    expect(f.api.sealModelInvocation).toHaveBeenCalledTimes(1);
    response.resolve(f.sealResponse(original));
    await first;
  });

  it.each(["seal", "submit"])(
    "rejects a forged %s response rather than reporting recording success",
    async (stage) => {
      const f = await fixture();
      attachFinished(f.session);
      if (stage === "seal")
        f.api.sealModelInvocation.mockImplementation(async (value) => ({
          ...f.sealResponse(value),
          processClosed: false,
        }));
      else
        f.api.submitModelInvocationReceipts.mockImplementation(async (value) => ({
          ...f.submissionResponse(value),
          receiptSetSha256: sha256("forged"),
        }));
      await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
        code: stage === "seal" ? "SEAL_INVALID" : "SUBMISSION_INVALID",
      });
      if (stage === "seal") expect(f.api.submitModelInvocationReceipts).not.toHaveBeenCalled();
    },
  );

  it("does not accept a submission that changes executionAccepted", async () => {
    const f = await fixture();
    attachFinished(f.session);
    f.api.submitModelInvocationReceipts.mockImplementation(
      async (value) =>
        ({
          ...f.submissionResponse(value),
          executionAccepted: true,
        }) as unknown as C.ModelInvocationSubmissionV1,
    );
    await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
      code: "SUBMISSION_INVALID",
    });
  });

  it.each(["completion", "drain"])(
    "cannot replace a missing %s with a terminate acknowledgement",
    async (missing) => {
      const f = await fixture({ processTimeoutMs: 20 });
      const process = fakeOwnedProcess();
      f.session.attachProcess(process.managed, process.drained.promise);
      if (missing === "completion") process.drained.resolve(undefined);
      else process.exit();
      await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
        code: "PROCESS_DRAIN_UNCONFIRMED",
      });
      expect(process.managed.terminate).toHaveBeenCalled();
      expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
      expect(f.api.submitModelInvocationReceipts).not.toHaveBeenCalled();
    },
  );

  it.each(["completion", "drain", "wrong_identity"])(
    "rejects failed process settlement: %s",
    async (failure) => {
      const f = await fixture();
      const process = fakeOwnedProcess();
      f.session.attachProcess(process.managed, process.drained.promise);
      if (failure === "completion") process.completed.reject(new Error("Synthetic host failure."));
      else process.exit(failure === "wrong_identity" ? { requestId: "wrong-process" } : {});
      if (failure === "drain") process.drained.reject(new Error("Synthetic drain failure."));
      else process.drained.resolve(undefined);
      await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
        code: "PROCESS_DRAIN_UNCONFIRMED",
      });
      expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
    },
  );

  it("closes the relay but does not fabricate process evidence when no process was attached", async () => {
    const f = await fixture();
    await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
      code: "PROCESS_NOT_ATTACHED",
    });
    await expect(post(f.session.relay)).rejects.toBeDefined();
    expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
  });

  it("records an unbound ledger for a failed process or unobserved provider response", async () => {
    const failed = await fixture();
    const process = fakeOwnedProcess();
    failed.session.attachProcess(process.managed, process.drained.promise);
    process.exit({ exitCode: 1 });
    process.drained.resolve(undefined);
    await expect(failed.session.close({ modelOutputSha256: outputSha256 })).resolves.toMatchObject({
      modelOutputBound: false,
      executionAccepted: false,
    });
    expect(failed.api.sealModelInvocation.mock.calls[0]![0]).toMatchObject({
      modelOutputSha256: null,
      processClosed: true,
    });
    const absent = await fixture();
    attachFinished(absent.session);
    await expect(absent.session.close({ modelOutputSha256: outputSha256 })).resolves.toMatchObject({
      modelOutputBound: false,
      executionAccepted: false,
    });
    expect(
      absent.api.submitModelInvocationReceipts.mock.calls[0]![0].receiptSet.modelOutputSha256,
    ).toBeNull();
  });

  it("retains and independently seals a real relay provider-failure ledger while the lease remains active", async () => {
    const f = await fixture();
    f.transport.mockResolvedValueOnce(new Response("Synthetic provider failure.", { status: 503 }));
    const process = fakeOwnedProcess();
    f.session.attachProcess(process.managed, process.drained.promise);
    expect(JSON.parse(await post(f.session.relay)).error.code).toBe("model_relay_rejected");
    process.exit({ exitCode: 1 });
    process.drained.resolve(undefined);
    await expect(f.session.close({ modelOutputSha256: null })).resolves.toMatchObject({
      modelOutputBound: false,
      executionAccepted: false,
      submission: { consistency: { state: "unavailable" } },
    });
    expect(f.api.sealModelInvocation.mock.calls[0]![0]).toMatchObject({
      state: "cancelled",
      callCount: 1,
      modelOutputSha256: null,
      processClosed: true,
      relayClosed: true,
    });
    expect(
      f.api.submitModelInvocationReceipts.mock.calls[0]![0].receiptSet.calls[0]!.receipt,
    ).toMatchObject({
      outcome: "provider_failed",
      httpStatus: 503,
    });
  });

  it("retains an explicit unconfirmed error when cancellation occurs while submission is pending", async () => {
    const f = await fixture();
    attachFinished(f.session);
    const started = deferred<void>();
    const response = deferred<C.ModelInvocationSubmissionV1>();
    f.api.submitModelInvocationReceipts.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const closing = f.session.close({ modelOutputSha256: null });
    const assertion = expect(closing).rejects.toMatchObject({
      code: "CANCELLED_NOT_SUBMITTED",
      submissionConfirmed: false,
    });
    await started.promise;
    f.controller.abort(new Error("Protected cancellation reason must not escape."));
    await assertion;
    await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
      code: "CANCELLED_NOT_SUBMITTED",
    });
    expect(f.api.submitModelInvocationReceipts).toHaveBeenCalledTimes(1);
  });

  it("bounds an unavailable owner without automatically repeating begin", async () => {
    const f = fixtureOptions({ operationTimeoutMs: 20 });
    f.api.beginModelInvocation.mockReturnValue(new Promise(() => undefined));
    await expect(createModelInvocationSession(f.options)).rejects.toMatchObject({
      code: "BEGIN_UNCONFIRMED",
    });
    expect(f.api.beginModelInvocation).toHaveBeenCalledTimes(1);
  });

  it.each(["seal", "submit"])(
    "bounds a stalled %s and retries only its original frozen request",
    async (stage) => {
      const f = await fixture({ operationTimeoutMs: 20 });
      attachFinished(f.session);
      if (stage === "seal")
        f.api.sealModelInvocation.mockReturnValueOnce(new Promise(() => undefined));
      else f.api.submitModelInvocationReceipts.mockReturnValueOnce(new Promise(() => undefined));
      await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
        code: stage === "seal" ? "SEAL_UNCONFIRMED" : "SUBMISSION_UNCONFIRMED",
        submissionConfirmed: false,
      });
      await f.session.close({ modelOutputSha256: null });
      const calls =
        stage === "seal"
          ? f.api.sealModelInvocation.mock.calls
          : f.api.submitModelInvocationReceipts.mock.calls;
      expect(calls[0]![0]).toBe(calls[1]![0]);
      expect(calls[0]![1]?.aborted).toBe(true);
      expect(f.api.beginModelInvocation).toHaveBeenCalledTimes(1);
    },
  );

  it("cannot seal on parent cancellation even when terminate returns an acknowledgement", async () => {
    const f = await fixture();
    const process = fakeOwnedProcess();
    f.session.attachProcess(process.managed, process.drained.promise);
    const closing = f.session.close({ modelOutputSha256: null });
    const assertion = expect(closing).rejects.toMatchObject({ code: "CANCELLED_NOT_SUBMITTED" });
    f.controller.abort(new Error("Protected cancellation reason."));
    await assertion;
    expect(process.managed.terminate).toHaveBeenCalled();
    expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
    expect(f.api.submitModelInvocationReceipts).not.toHaveBeenCalled();
  });

  it("does not send begin for an already cancelled attempt", async () => {
    const f = fixtureOptions();
    f.controller.abort();
    await expect(createModelInvocationSession(f.options)).rejects.toMatchObject({
      code: "CANCELLED_NOT_SUBMITTED",
    });
    expect(f.api.beginModelInvocation).not.toHaveBeenCalled();
  });

  it("does not report a new close success after its parent has cancelled", async () => {
    const f = await fixture();
    attachFinished(f.session);
    await f.session.close({ modelOutputSha256: null });
    f.controller.abort();
    await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
      code: "CANCELLED_NOT_SUBMITTED",
    });
    expect(f.api.submitModelInvocationReceipts).toHaveBeenCalledTimes(1);
  });

  it("validates relay ledger hashes before making an independent seal", async () => {
    const original = relayModule.createModelResponseRelay;
    vi.spyOn(relayModule, "createModelResponseRelay").mockImplementation(async (options) => {
      const real = await original(options);
      return {
        url: real.url,
        bearerToken: real.bearerToken,
        close: async (input) => {
          const closed = await real.close(input);
          return {
            ...closed,
            receiptSet: { ...closed.receiptSet, scopeSha256: sha256("tampered-ledger") },
          };
        },
      };
    });
    const f = await fixture();
    attachFinished(f.session);
    await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
      code: "RECEIPTS_INVALID",
    });
    expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
  });

  it("does not fabricate a receipt ledger when real relay close fails", async () => {
    const original = relayModule.createModelResponseRelay;
    vi.spyOn(relayModule, "createModelResponseRelay").mockImplementation(async (options) => {
      const real = await original(options);
      return {
        url: real.url,
        bearerToken: real.bearerToken,
        close: async (input) => {
          await real.close(input);
          throw new Error("Synthetic close confirmation failure.");
        },
      };
    });
    const f = await fixture();
    attachFinished(f.session);
    await expect(f.session.close({ modelOutputSha256: null })).rejects.toMatchObject({
      code: "RELAY_CLOSE_UNCONFIRMED",
    });
    expect(f.api.sealModelInvocation).not.toHaveBeenCalled();
    expect(f.api.submitModelInvocationReceipts).not.toHaveBeenCalled();
  });
});
