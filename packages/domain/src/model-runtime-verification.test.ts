import type {
  ModelCallReceiptV1,
  ModelInvocationReceiptSetV1,
  ModelInvocationReceiptSetV2,
  ModelInvocationScopeV2,
  ModelRuntimeIdentityV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  modelCallReceiptDigest,
  modelInvocationReceiptSetDigest,
  modelInvocationScopeDigest,
  modelRuntimeIdentityDigest,
  verifyModelInvocationReceiptSet,
} from "./model-runtime-verification.js";

const sha = (character: string) => character.repeat(64);
const now = "2026-09-08T00:00:00.000Z";

describe("summary input identity in scope and receipt digests", () => {
  it("binds the entire input reference through the same receipt chain without rewriting V1", () => {
    const f = fixture();
    const legacy = JSON.stringify(f.set);
    const original = f.set.scope;
    const scope: ModelInvocationScopeV2 = {
      ...original,
      schemaVersion: "ModelInvocationScopeV2",
      purpose: "validation_summary",
      inputRef: {
        schemaVersion: "ValidationSummaryInputReferenceV1",
        inputId: "input-a",
        inputSha256: sha("a"),
        sourcePromptSha256: original.promptSha256,
        outputSchemaSha256: original.outputSchemaSha256,
        contextSha256: sha("b"),
        actualPromptSha256: sha("c"),
      },
    };
    const scopeSha256 = modelInvocationScopeDigest(scope);
    const calls: ModelInvocationReceiptSetV2["calls"] = [];
    for (const entry of f.set.calls) {
      const receipt = {
        ...structuredClone(entry.receipt),
        scopeSha256,
        previousReceiptSha256: calls.at(-1)?.sha256 ?? null,
      };
      calls.push({ receipt, sha256: modelCallReceiptDigest(receipt) });
    }
    const set: ModelInvocationReceiptSetV2 = {
      ...structuredClone(f.set),
      schemaVersion: "ModelInvocationReceiptSetV2",
      scope,
      scopeSha256,
      calls,
    };
    const expected = {
      ...f.expected,
      scope: structuredClone(scope),
      receiptSetSha256: modelInvocationReceiptSetDigest(set),
    };
    expect(verifyModelInvocationReceiptSet(set, expected).state).toBe("matched");
    expect(scopeSha256).not.toBe(modelInvocationScopeDigest(original));
    set.scope.inputRef.contextSha256 = sha("d");
    expect(verifyModelInvocationReceiptSet(set, expected).state).not.toBe("matched");
    expect(JSON.stringify(f.set)).toBe(legacy);
  });
});
function fixture() {
  const identity: ModelRuntimeIdentityV1 = {
    schemaVersion: "ModelRuntimeIdentityV1",
    providerId: "test-provider",
    endpointSha256: sha("a"),
    modelId: "provider-observed-model",
    client: {
      kind: "codex_cli",
      version: "test-client",
      executableSha256: sha("b"),
      launchPolicySha256: sha("8"),
    },
    relay: { implementationSha256: sha("c"), policySha256: sha("d") },
  };
  const { schemaVersion: _schema, modelId: _model, ...runtime } = identity;
  const scope = {
    schemaVersion: "ModelInvocationScopeV1" as const,
    repositoryId: "repository",
    evaluationId: "evaluation",
    cellId: "cell",
    runId: "run",
    requestId: "request",
    jobId: "job",
    attemptId: "attempt",
    invocationId: "invocation",
    authorizationId: "authorization",
    executionManifestSha256: sha("e"),
    promptSha256: sha("f"),
    outputSchemaSha256: sha("0"),
    expectedModelIdentitySha256: modelRuntimeIdentityDigest(identity),
    requestedModel: "requested-model-alias",
    workerNodeId: "worker",
    workerInstanceId: "instance",
    leaseGeneration: 1,
  };
  const output = sha("1");
  const scopeSha256 = modelInvocationScopeDigest(scope);
  const calls: ModelInvocationReceiptSetV1["calls"] = [];
  for (let index = 0; index < 2; index++) {
    const receipt: ModelCallReceiptV1 = {
      schemaVersion: "ModelCallReceiptV1",
      scopeSha256,
      sequence: index + 1,
      previousReceiptSha256: calls.at(-1)?.sha256 ?? null,
      startedAt: now,
      finishedAt: now,
      requestSha256: sha("2"),
      requestBytes: 100,
      requestedModel: scope.requestedModel,
      httpStatus: 200,
      outcome: "completed",
      response: {
        schemaVersion: "ModelResponseObservationV1",
        bodySha256: sha("3"),
        bodyBytes: 100,
        eventCount: 2,
        transportComplete: true,
        outcome: "completed",
        responseId: `response-${index}`,
        modelId: identity.modelId,
        outputJsonSha256: index === 1 ? output : null,
        reasonCode: null,
      },
    };
    calls.push({ receipt, sha256: modelCallReceiptDigest(receipt) });
  }
  const set: ModelInvocationReceiptSetV1 = {
    schemaVersion: "ModelInvocationReceiptSetV1",
    scope,
    scopeSha256,
    runtime,
    calls,
    closedAt: now,
    state: "closed",
    modelOutputSha256: output,
    observedIdentity: identity,
    observedIdentitySha256: modelRuntimeIdentityDigest(identity),
  };
  const expected = {
    scope: structuredClone(scope),
    identity: structuredClone(identity),
    modelOutputSha256: output,
    receiptSetSha256: modelInvocationReceiptSetDigest(set),
  };
  const reseal = () => {
    expected.receiptSetSha256 = modelInvocationReceiptSetDigest(set);
  };
  return { set, expected, reseal };
}
function first(set: ModelInvocationReceiptSetV1) {
  const call = set.calls[0];
  if (!call) throw new Error("Test call is missing.");
  return call;
}
function rehash(set: ModelInvocationReceiptSetV1) {
  for (const [index, entry] of set.calls.entries()) {
    entry.receipt.sequence = index + 1;
    entry.receipt.previousReceiptSha256 = set.calls[index - 1]?.sha256 ?? null;
    entry.sha256 = modelCallReceiptDigest(entry.receipt);
  }
}

describe("Model invocation owner consistency verification", () => {
  it("matches the complete independently sealed chain without equating requested and observed names", () => {
    const f = fixture();
    expect(f.set.scope.requestedModel).not.toBe(f.set.observedIdentity?.modelId);
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toEqual({
      state: "matched",
      reasons: [],
      observedIdentitySha256: f.set.observedIdentitySha256,
    });
  });
  it("rejects a response edit even when the supplied outer closure digest was updated", () => {
    const f = fixture();
    const response = first(f.set).receipt.response;
    if (!response) throw new Error("Missing response.");
    response.bodySha256 = sha("4");
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "invalid",
      reasons: ["RECEIPT_DIGEST_MISMATCH"],
    });
  });
  it("rejects selecting only the final call even after the attacker renumbers and rehashes it", () => {
    const f = fixture();
    f.set.calls.shift();
    rehash(f.set);
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "invalid",
      reasons: ["CLOSURE_SEAL_MISMATCH"],
    });
  });
  it("rejects a changed scope digest despite internally consistent claimed scope references", () => {
    const f = fixture();
    f.set.scopeSha256 = sha("5");
    for (const entry of f.set.calls) entry.receipt.scopeSha256 = f.set.scopeSha256;
    rehash(f.set);
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "invalid",
      reasons: ["SCOPE_DIGEST_MISMATCH"],
    });
  });
  it("rejects a claimed observed identity digest that is not its canonical content", () => {
    const f = fixture();
    f.set.observedIdentitySha256 = sha("6");
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "invalid",
      reasons: ["IDENTITY_DIGEST_MISMATCH"],
    });
  });
  it.each(["repositoryId", "cellId", "attemptId", "workerInstanceId", "authorizationId"] as const)(
    "rejects a valid closed record from another %s",
    (key) => {
      const f = fixture();
      f.expected.scope[key] = "another-scope";
      expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
        state: "mismatched",
        reasons: ["SCOPE_MISMATCH"],
      });
    },
  );
  it("does not hide an earlier failed transport behind a later successful result", () => {
    const f = fixture();
    const receipt = first(f.set).receipt;
    receipt.outcome = "transport_failed";
    receipt.response = null;
    receipt.httpStatus = null;
    f.set.observedIdentity = null;
    f.set.observedIdentitySha256 = null;
    rehash(f.set);
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "unavailable",
      reasons: ["CALL_CHAIN_INCOMPLETE", "OBSERVED_IDENTITY_MISSING"],
    });
  });
  it("keeps a real model mismatch distinct from missing identity", () => {
    const f = fixture();
    if (!f.set.observedIdentity) throw new Error("Missing identity.");
    f.set.observedIdentity.modelId = "another-observed-model";
    for (const entry of f.set.calls)
      if (entry.receipt.response) entry.receipt.response.modelId = f.set.observedIdentity.modelId;
    f.set.observedIdentitySha256 = modelRuntimeIdentityDigest(f.set.observedIdentity);
    rehash(f.set);
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "mismatched",
      reasons: ["RUNTIME_IDENTITY_MISMATCH"],
    });
  });
  it("does not accept an unrelated final result or an unbound model output", () => {
    const f = fixture();
    f.expected.modelOutputSha256 = sha("7");
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "mismatched",
      reasons: ["OUTPUT_MISMATCH"],
    });
    f.set.modelOutputSha256 = null;
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "unavailable",
      reasons: ["OUTPUT_UNBOUND"],
    });
  });
  it("does not equate the same model and executable with a different effective launch policy", () => {
    const f = fixture();
    f.set.runtime.client.launchPolicySha256 = sha("9");
    if (!f.set.observedIdentity) throw new Error("Missing identity.");
    f.set.observedIdentity.client.launchPolicySha256 = sha("9");
    f.set.observedIdentitySha256 = modelRuntimeIdentityDigest(f.set.observedIdentity);
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "mismatched",
      reasons: ["RUNTIME_IDENTITY_MISMATCH"],
    });
  });
  it("rejects overlapping recorded calls in the sequential invocation protocol", () => {
    const f = fixture();
    const a = f.set.calls[0]?.receipt;
    const b = f.set.calls[1]?.receipt;
    if (!a || !b) throw new Error("Missing calls.");
    a.finishedAt = "2026-09-08T00:00:01.000Z";
    b.startedAt = "2026-09-08T00:00:00.500Z";
    b.finishedAt = "2026-09-08T00:00:01.500Z";
    f.set.closedAt = "2026-09-08T00:00:02.000Z";
    rehash(f.set);
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "invalid",
      reasons: ["CALL_TIME_ORDER_INVALID"],
    });
  });
  it("retains cancellation as unavailable even if all recorded model calls completed", () => {
    const f = fixture();
    f.set.state = "cancelled";
    f.set.modelOutputSha256 = null;
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "unavailable",
      reasons: ["INVOCATION_CANCELLED", "OUTPUT_UNBOUND"],
    });
  });
  it("does not treat zero calls as perfect or verified coverage", () => {
    const f = fixture();
    f.set.calls = [];
    f.set.modelOutputSha256 = null;
    f.set.observedIdentity = null;
    f.set.observedIdentitySha256 = null;
    f.reseal();
    expect(verifyModelInvocationReceiptSet(f.set, f.expected)).toMatchObject({
      state: "unavailable",
      reasons: ["CALL_CHAIN_INCOMPLETE", "OBSERVED_IDENTITY_MISSING", "OUTPUT_UNBOUND"],
    });
  });
  it("returns fixed failure reasons for malformed metadata without echoing extra fields", () => {
    const f = fixture();
    const result = verifyModelInvocationReceiptSet(
      { ...f.set, token: "never-display-this" },
      f.expected,
    );
    expect(result).toMatchObject({ state: "invalid", reasons: ["INVALID_RECEIPT_SET"] });
    expect(JSON.stringify(result)).not.toContain("never-display-this");
  });
});
