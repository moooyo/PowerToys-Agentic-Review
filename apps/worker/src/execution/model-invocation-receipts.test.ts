import { createCanonicalResult } from "@agentic-review/codex";
import {
  getModelInvocationReceiptSetIssues,
  type ModelInvocationScopeV1,
  type ModelInvocationScopeV2,
  type ModelResponseObservationV1,
  type ModelRuntimeIdentityV1,
  maximumModelInvocationCallCount,
  maximumModelRuntimeUtf8Bytes,
} from "@agentic-review/contracts";
import { verifyModelInvocationReceiptSet } from "@agentic-review/domain";
import { describe, expect, it } from "vitest";
import { type ModelCallFinish, ModelInvocationRecorder } from "./model-invocation-receipts.js";

const hash = (value: unknown) => createCanonicalResult(value).sha256;
function summaryScope(scope: ModelInvocationScopeV1): ModelInvocationScopeV2 {
  return {
    ...scope,
    schemaVersion: "ModelInvocationScopeV2",
    purpose: "validation_summary",
    inputRef: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "summary-input",
      inputSha256: hash("frozen summary input"),
      sourcePromptSha256: scope.promptSha256,
      outputSchemaSha256: scope.outputSchemaSha256,
      contextSha256: hash("summary context"),
      actualPromptSha256: hash("composite prompt"),
    },
  };
}
function fixture() {
  const identity: ModelRuntimeIdentityV1 = {
    schemaVersion: "ModelRuntimeIdentityV1",
    providerId: "fixture-provider",
    endpointSha256: hash("fixture-endpoint"),
    modelId: "observed-model",
    client: {
      kind: "codex_cli",
      version: "fixture-runtime",
      executableSha256: hash("runtime"),
      launchPolicySha256: hash("client-policy"),
    },
    relay: { implementationSha256: hash("relay"), policySha256: hash("policy") },
  };
  const scope: ModelInvocationScopeV1 = {
    schemaVersion: "ModelInvocationScopeV1",
    repositoryId: "repo",
    evaluationId: "evaluation",
    cellId: "cell",
    runId: "run",
    requestId: "request",
    jobId: "job",
    attemptId: "attempt",
    invocationId: "invocation",
    authorizationId: "authorization",
    executionManifestSha256: hash("execution"),
    promptSha256: hash("prompt"),
    outputSchemaSha256: hash("schema"),
    expectedModelIdentitySha256: hash(identity),
    requestedModel: "requested-model",
    workerNodeId: "worker",
    workerInstanceId: "instance",
    leaseGeneration: 1,
  };
  const { schemaVersion: _schema, modelId: _model, ...runtime } = identity;
  let time = Date.parse("2026-09-08T00:00:00.000Z");
  const recorder = new ModelInvocationRecorder({ scope, runtime, now: () => new Date(time++) });
  const output = hash({ summary: "Synthetic result" });
  const response = (
    overrides: Partial<ModelResponseObservationV1> = {},
  ): ModelResponseObservationV1 => ({
    schemaVersion: "ModelResponseObservationV1",
    bodySha256: hash("synthetic-body"),
    bodyBytes: 120,
    eventCount: 2,
    transportComplete: true,
    outcome: "completed",
    responseId: "response",
    modelId: "observed-model",
    outputJsonSha256: output,
    reasonCode: null,
    ...overrides,
  });
  const start = () => ({
    requestSha256: hash("request-bytes"),
    requestBytes: 80,
    requestedModel: "requested-model",
  });
  const finish = (changes: Partial<ModelCallFinish> = {}): ModelCallFinish => ({
    httpStatus: 200,
    response: response(),
    outcome: "completed",
    ...changes,
  });
  return {
    recorder,
    scope,
    runtime,
    identity,
    output,
    response,
    start,
    finish,
    setTime: (value: number) => {
      time = value;
    },
  };
}

describe("Model invocation receipts", () => {
  it("retains a V2 summary scope in the matching receipt container and linked call chain", () => {
    const f = fixture();
    const scope = summaryScope(f.scope);
    const retained = structuredClone(scope);
    const recorder = new ModelInvocationRecorder({ scope, runtime: f.runtime });
    scope.inputRef.contextSha256 = hash("changed after capture");
    recorder
      .begin(f.start())
      .finish(f.finish({ response: f.response({ outputJsonSha256: null }) }));
    recorder.begin(f.start()).finish(f.finish());
    const result = recorder.close({ state: "closed", modelOutputSha256: f.output });
    expect(result).toMatchObject({
      schemaVersion: "ModelInvocationReceiptSetV2",
      scope: retained,
      modelOutputSha256: f.output,
    });
    expect(result.scopeSha256).toBe(hash(retained));
    expect(result.calls[1]?.receipt.previousReceiptSha256).toBe(result.calls[0]?.sha256);
    expect(
      result.calls.every(({ receipt }) => receipt.schemaVersion === "ModelCallReceiptV1"),
    ).toBe(true);
    expect(getModelInvocationReceiptSetIssues(result)).toEqual([]);
    expect(
      verifyModelInvocationReceiptSet(result, {
        scope: retained,
        identity: f.identity,
        modelOutputSha256: f.output,
        receiptSetSha256: hash(result),
      }),
    ).toMatchObject({ state: "matched", reasons: [] });
    expect(Object.isFrozen(result.scope)).toBe(true);
  });

  it.each(["source", "schema", "version", "purpose"])(
    "rejects invalid summary scope %s before retaining calls",
    (field) => {
      const f = fixture();
      const scope = summaryScope(f.scope);
      if (field === "source") scope.inputRef.sourcePromptSha256 = hash("foreign source");
      if (field === "schema") scope.inputRef.outputSchemaSha256 = hash("foreign schema");
      if (field === "version") Reflect.set(scope, "schemaVersion", "ModelInvocationScopeV1");
      if (field === "purpose") Reflect.set(scope, "purpose", "pr_review");
      expect(() => new ModelInvocationRecorder({ scope, runtime: f.runtime })).toThrowError(
        expect.objectContaining({ code: "INVALID_METADATA" }),
      );
    },
  );

  it("records a tool round and final JSON with actual canonical scope and linked receipt digests", () => {
    const f = fixture();
    f.recorder
      .begin(f.start())
      .finish(f.finish({ response: f.response({ outputJsonSha256: null }) }));
    f.recorder.begin(f.start()).finish(f.finish());
    const result = f.recorder.close({ state: "closed", modelOutputSha256: f.output });
    expect(getModelInvocationReceiptSetIssues(result)).toEqual([]);
    expect(result.scopeSha256).toBe(hash(f.scope));
    expect(result.calls[0]?.receipt.previousReceiptSha256).toBeNull();
    for (const [index, call] of result.calls.entries()) {
      expect(call.sha256).toBe(hash(call.receipt));
      expect(call.receipt.sequence).toBe(index + 1);
      if (index) expect(call.receipt.previousReceiptSha256).toBe(result.calls[index - 1]?.sha256);
    }
    expect(result.observedIdentity).toEqual(f.identity);
    expect(result.observedIdentitySha256).toBe(hash(f.identity));
    expect(result.modelOutputSha256).toBe(f.output);
    expect(Object.isFrozen(result.calls[0]?.receipt.response)).toBe(true);
    expect(
      verifyModelInvocationReceiptSet(result, {
        scope: f.scope,
        identity: f.identity,
        modelOutputSha256: f.output,
        receiptSetSha256: hash(result),
      }),
    ).toMatchObject({ state: "matched", reasons: [] });
  });
  it("snapshots scope, measured runtime and completed observations independently of caller edits", () => {
    const f = fixture();
    const scope = structuredClone(f.scope);
    f.scope.requestedModel = "changed-model";
    f.runtime.client.version = "changed-runtime";
    const completion = f.finish();
    f.recorder.begin(f.start()).finish(completion);
    if (completion.response) completion.response.modelId = "changed-response-model";
    const result = f.recorder.close({ state: "closed", modelOutputSha256: f.output });
    expect(result.scope).toEqual(scope);
    expect(result.observedIdentity?.client.version).toBe("fixture-runtime");
    expect(result.observedIdentity?.modelId).toBe("observed-model");
  });
  it("does not close or begin a second call while a response is still unrecorded", () => {
    const f = fixture();
    const call = f.recorder.begin(f.start());
    expect(f.recorder.active).toBe(true);
    expect(() => f.recorder.begin(f.start())).toThrowError(
      expect.objectContaining({ code: "CALL_ACTIVE" }),
    );
    expect(() => f.recorder.close({ state: "cancelled", modelOutputSha256: null })).toThrowError(
      expect.objectContaining({ code: "CALL_ACTIVE" }),
    );
    call.finish(f.finish());
    expect(f.recorder.active).toBe(false);
    expect(() => call.finish(f.finish())).toThrowError(
      expect.objectContaining({ code: "CALL_FINISHED" }),
    );
  });
  it("rejects completion field overrides rather than losing the authoritative request identity", () => {
    const f = fixture();
    const call = f.recorder.begin(f.start());
    expect(() =>
      call.finish({ ...f.finish(), requestSha256: hash("forged") } as ModelCallFinish),
    ).toThrowError(expect.objectContaining({ code: "INVALID_METADATA" }));
    expect(f.recorder.callCount).toBe(0);
    call.finish(f.finish());
    expect(
      f.recorder.close({ state: "closed", modelOutputSha256: f.output }).calls[0]?.receipt
        .requestSha256,
    ).toBe(f.start().requestSha256);
  });
  it("rejects metadata accessors without invoking their getters", () => {
    const f = fixture();
    let touched = false;
    const request = f.start();
    Object.defineProperty(request, "requestSha256", {
      enumerable: true,
      get: () => {
        touched = true;
        return hash("forged");
      },
    });
    expect(() => f.recorder.begin(request)).toThrow();
    expect(touched).toBe(false);
    expect(f.recorder.active).toBe(false);
  });
  it("retains startup cancellation with zero calls and no invented identity or output", () => {
    const f = fixture();
    expect(f.recorder.close({ state: "cancelled", modelOutputSha256: null })).toMatchObject({
      calls: [],
      observedIdentity: null,
      observedIdentitySha256: null,
      modelOutputSha256: null,
      state: "cancelled",
    });
  });
  it.each(["transport_failed", "cancelled", "protocol_invalid"] as const)(
    "keeps the complete history and omits identity after %s",
    (outcome) => {
      const f = fixture();
      f.recorder.begin(f.start()).finish({ httpStatus: null, response: null, outcome });
      f.recorder.begin(f.start()).finish(f.finish());
      const result = f.recorder.close({ state: "closed", modelOutputSha256: f.output });
      expect(result.calls).toHaveLength(2);
      expect(result.observedIdentity).toBeNull();
      expect(result.modelOutputSha256).toBe(f.output);
    },
  );
  it("keeps actual mismatching identity rather than substituting the requested or expected model", () => {
    const f = fixture();
    f.recorder
      .begin(f.start())
      .finish(f.finish({ response: f.response({ modelId: "other-observed-model" }) }));
    const result = f.recorder.close({ state: "closed", modelOutputSha256: f.output });
    expect(result.observedIdentity?.modelId).toBe("other-observed-model");
    expect(result.observedIdentitySha256).not.toBe(f.scope.expectedModelIdentitySha256);
    expect(result.scope.requestedModel).toBe("requested-model");
  });
  it("does not select a uniform subset when responses contain mixed model identities", () => {
    const f = fixture();
    f.recorder
      .begin(f.start())
      .finish(f.finish({ response: f.response({ modelId: "other-model" }) }));
    f.recorder.begin(f.start()).finish(f.finish());
    expect(
      f.recorder.close({ state: "closed", modelOutputSha256: f.output }).observedIdentity,
    ).toBeNull();
  });
  it("does not link unrelated final output or an earlier result before the last tool response", () => {
    const f = fixture();
    f.recorder.begin(f.start()).finish(f.finish());
    f.recorder
      .begin(f.start())
      .finish(f.finish({ response: f.response({ outputJsonSha256: null }) }));
    expect(
      f.recorder.close({ state: "closed", modelOutputSha256: f.output }).modelOutputSha256,
    ).toBeNull();
  });
  it("permits identical close replay but rejects new calls and different closure intents", () => {
    const f = fixture();
    f.recorder.begin(f.start()).finish(f.finish());
    const intent = { state: "closed" as const, modelOutputSha256: f.output };
    const result = f.recorder.close(intent);
    expect(f.recorder.close(intent)).toBe(result);
    expect(() => f.recorder.close({ state: "cancelled", modelOutputSha256: null })).toThrow();
    expect(() => f.recorder.begin(f.start())).toThrow();
  });
  it("keeps all 128 calls and refuses another without truncating the chain", () => {
    const f = fixture();
    for (let index = 0; index < 128; index++) f.recorder.begin(f.start()).finish(f.finish());
    expect(() => f.recorder.begin(f.start())).toThrowError(
      expect.objectContaining({ code: "CALL_LIMIT_EXCEEDED" }),
    );
    expect(f.recorder.close({ state: "closed", modelOutputSha256: f.output }).calls).toHaveLength(
      128,
    );
  });
  it("does not invent timestamps after the clock moves backwards", () => {
    const f = fixture();
    const call = f.recorder.begin(f.start());
    f.setTime(0);
    expect(() => call.finish(f.finish())).toThrow();
    expect(f.recorder.callCount).toBe(0);
  });
  it.each(["closed", "cancelled"] as const)(
    "reserves closure space before another maximum-width call and retains every call when %s",
    (state) => {
      const f = fixture();
      const model = "\u754c".repeat(1024);
      const scope = { ...f.scope, requestedModel: model };
      const recorder = new ModelInvocationRecorder({ scope, runtime: f.runtime });
      const request = { ...f.start(), requestedModel: model };
      const completion = f.finish({ response: f.response({ modelId: model, responseId: model }) });
      let count = 0;
      for (;;) {
        try {
          const call = recorder.begin(request);
          call.finish(completion);
          count++;
        } catch (error) {
          expect(error).toMatchObject({ code: "RECEIPT_BUDGET_EXCEEDED" });
          break;
        }
      }
      expect(count).toBeGreaterThan(1);
      expect(count).toBeLessThan(maximumModelInvocationCallCount);
      expect(recorder.active).toBe(false);
      const result = recorder.close({
        state,
        modelOutputSha256: state === "closed" ? f.output : null,
      });
      expect(result.calls).toHaveLength(count);
      expect(result.calls.at(-1)?.receipt.sequence).toBe(count);
      expect(result.observedIdentity?.modelId).toBe(model);
      expect(getModelInvocationReceiptSetIssues(result)).toEqual([]);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        maximumModelRuntimeUtf8Bytes,
      );
    },
  );
});
