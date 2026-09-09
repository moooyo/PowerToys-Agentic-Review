import type {
  ModelCallReceiptV1,
  ModelInvocationOpeningV1,
  ModelInvocationReceiptSetV1,
  ModelInvocationSealV1,
  ModelRuntimeIdentityV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { verifyModelInvocationSubmission } from "./model-invocation-submission.js";
import {
  modelCallReceiptDigest,
  modelInvocationReceiptSetDigest,
  modelInvocationScopeDigest,
  modelRuntimeIdentityDigest,
} from "./model-runtime-verification.js";

const digest = (character: string) => character.repeat(64);
const now = "2026-09-08T00:00:00.000Z";
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The synthetic test fixture is incomplete.");
  return value;
}
function fixture() {
  const expectedIdentity: ModelRuntimeIdentityV1 = {
    schemaVersion: "ModelRuntimeIdentityV1",
    providerId: "synthetic-provider",
    endpointSha256: digest("a"),
    modelId: "observed-model",
    client: {
      kind: "codex_cli",
      version: "synthetic-cli",
      executableSha256: digest("b"),
      launchPolicySha256: digest("c"),
    },
    relay: { implementationSha256: digest("d"), policySha256: digest("e") },
  };
  const { schemaVersion: _schema, modelId: _model, ...runtime } = expectedIdentity;
  const opening: ModelInvocationOpeningV1 = {
    schemaVersion: "ModelInvocationOpeningV1",
    runtime,
    openedAt: now,
    scope: {
      schemaVersion: "ModelInvocationScopeV1",
      repositoryId: "repository",
      evaluationId: "evaluation",
      cellId: "cell",
      runId: "run",
      requestId: "request",
      jobId: "job",
      attemptId: "attempt",
      invocationId: "invocation",
      authorizationId: "authorization",
      executionManifestSha256: digest("f"),
      promptSha256: digest("0"),
      outputSchemaSha256: digest("1"),
      expectedModelIdentitySha256: modelRuntimeIdentityDigest(expectedIdentity),
      requestedModel: "requested-alias",
      workerNodeId: "node",
      workerInstanceId: "instance",
      leaseGeneration: 1,
    },
    scopeSha256: "",
  };
  opening.scopeSha256 = modelInvocationScopeDigest(opening.scope);
  const calls: ModelInvocationReceiptSetV1["calls"] = [];
  for (let index = 0; index < 2; index++) {
    const receipt: ModelCallReceiptV1 = {
      schemaVersion: "ModelCallReceiptV1",
      scopeSha256: opening.scopeSha256,
      sequence: index + 1,
      previousReceiptSha256: calls.at(-1)?.sha256 ?? null,
      startedAt: now,
      finishedAt: now,
      requestSha256: digest("2"),
      requestBytes: 100,
      requestedModel: opening.scope.requestedModel,
      httpStatus: 200,
      outcome: "completed",
      response: {
        schemaVersion: "ModelResponseObservationV1",
        bodySha256: digest("3"),
        bodyBytes: 100,
        eventCount: 0,
        transportComplete: true,
        outcome: "completed",
        responseId: `response-${index}`,
        modelId: expectedIdentity.modelId,
        outputJsonSha256: index === 1 ? digest("4") : null,
        reasonCode: null,
      },
    };
    calls.push({ receipt, sha256: modelCallReceiptDigest(receipt) });
  }
  const receiptSet: ModelInvocationReceiptSetV1 = {
    schemaVersion: "ModelInvocationReceiptSetV1",
    scope: structuredClone(opening.scope),
    scopeSha256: opening.scopeSha256,
    runtime: structuredClone(runtime),
    calls,
    closedAt: now,
    state: "closed",
    modelOutputSha256: digest("4"),
    observedIdentity: structuredClone(expectedIdentity),
    observedIdentitySha256: modelRuntimeIdentityDigest(expectedIdentity),
  };
  const seal: ModelInvocationSealV1 = {
    schemaVersion: "ModelInvocationSealV1",
    invocationId: opening.scope.invocationId,
    scopeSha256: opening.scopeSha256,
    receiptSetSha256: modelInvocationReceiptSetDigest(receiptSet),
    closedAt: receiptSet.closedAt,
    state: receiptSet.state,
    callCount: calls.length,
    lastReceiptSha256: calls.at(-1)?.sha256 ?? null,
    modelOutputSha256: receiptSet.modelOutputSha256,
    observedIdentitySha256: receiptSet.observedIdentitySha256,
    processClosed: true,
    relayClosed: true,
    recordedAt: now,
  };
  const reseal = () => {
    for (const [index, entry] of calls.entries()) {
      entry.receipt.sequence = index + 1;
      entry.receipt.previousReceiptSha256 = calls[index - 1]?.sha256 ?? null;
      entry.sha256 = modelCallReceiptDigest(entry.receipt);
    }
    Object.assign(seal, {
      receiptSetSha256: modelInvocationReceiptSetDigest(receiptSet),
      closedAt: receiptSet.closedAt,
      state: receiptSet.state,
      callCount: calls.length,
      lastReceiptSha256: calls.at(-1)?.sha256 ?? null,
      modelOutputSha256: receiptSet.modelOutputSha256,
      observedIdentitySha256: receiptSet.observedIdentitySha256,
    });
  };
  return { opening, seal, receiptSet, expectedIdentity, reseal };
}

describe("Independently retained invocation submission", () => {
  it("matches the complete frozen scope, measurements and independent closure without accepting execution", () => {
    const f = fixture();
    const actual = verifyModelInvocationSubmission(f);
    expect(actual).toEqual({
      state: "matched",
      reasons: [],
      observedIdentitySha256: f.receiptSet.observedIdentitySha256,
    });
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.reasons)).toBe(true);
    expect(actual).not.toHaveProperty("executionAccepted");
  });
  it("does not derive the expected seal from a shortened and rehashed ledger", () => {
    const f = fixture();
    f.receiptSet.calls.shift();
    const retained = present(f.receiptSet.calls[0]);
    retained.receipt.sequence = 1;
    retained.receipt.previousReceiptSha256 = null;
    retained.sha256 = modelCallReceiptDigest(retained.receipt);
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "invalid",
      reasons: ["CLOSURE_METADATA_MISMATCH"],
    });
  });
  it("rejects bytes changed behind an unchanged independently retained seal", () => {
    const f = fixture();
    present(f.receiptSet.calls[0]).receipt.requestSha256 = digest("9");
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "invalid",
      reasons: ["CLOSURE_SEAL_MISMATCH", "RECEIPT_DIGEST_MISMATCH"],
    });
  });
  it.each(["repositoryId", "attemptId", "cellId", "workerInstanceId", "authorizationId"] as const)(
    "rejects a ledger from another %s even if that ledger was sealed separately",
    (key) => {
      const f = fixture();
      f.receiptSet.scope[key] = "other";
      f.receiptSet.scopeSha256 = modelInvocationScopeDigest(f.receiptSet.scope);
      for (const call of f.receiptSet.calls) call.receipt.scopeSha256 = f.receiptSet.scopeSha256;
      f.reseal();
      expect(verifyModelInvocationSubmission(f)).toMatchObject({
        state: "mismatched",
        reasons: ["SCOPE_MISMATCH"],
      });
    },
  );
  it("does not silently replace runtime measured before invocation", () => {
    const f = fixture();
    f.opening.runtime.client.version = "another-client";
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "invalid",
      reasons: ["RUNTIME_MEASUREMENT_MISMATCH"],
    });
  });
  it.each([
    "closedAt",
    "lastReceiptSha256",
    "modelOutputSha256",
    "observedIdentitySha256",
  ] as const)("compares independent closure %s rather than only its outer digest", (field) => {
    const f = fixture();
    f.seal[field] = field === "closedAt" ? "2026-09-08T00:00:01.000Z" : digest("9");
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "invalid",
      reasons: ["CLOSURE_METADATA_MISMATCH"],
    });
  });
  it("preserves a cancelled closed collection without inventing a model output", () => {
    const f = fixture();
    f.receiptSet.state = "cancelled";
    f.receiptSet.modelOutputSha256 = null;
    f.reseal();
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "unavailable",
      reasons: ["INVOCATION_CANCELLED", "OUTPUT_UNBOUND"],
    });
  });
  it.each(["processClosed", "relayClosed"] as const)("keeps %s uncertainty unavailable", (key) => {
    const f = fixture();
    f.receiptSet.modelOutputSha256 = null;
    f.reseal();
    f.seal[key] = false;
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "unavailable",
      reasons: ["OUTPUT_UNBOUND", "CLEANUP_UNCONFIRMED"],
    });
  });
  it("treats an empty invocation as unavailable", () => {
    const f = fixture();
    f.receiptSet.calls.splice(0);
    f.receiptSet.observedIdentity = null;
    f.receiptSet.observedIdentitySha256 = null;
    f.receiptSet.modelOutputSha256 = null;
    f.reseal();
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "unavailable",
      reasons: ["CALL_CHAIN_INCOMPLETE", "OBSERVED_IDENTITY_MISSING", "OUTPUT_UNBOUND"],
    });
  });
  it("retains earlier failure instead of promoting a later successful output", () => {
    const f = fixture();
    present(f.receiptSet.calls[0]).receipt.outcome = "transport_failed";
    present(f.receiptSet.calls[0]).receipt.response = null;
    f.receiptSet.observedIdentity = null;
    f.receiptSet.observedIdentitySha256 = null;
    f.reseal();
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "unavailable",
      reasons: ["CALL_CHAIN_INCOMPLETE", "OBSERVED_IDENTITY_MISSING"],
    });
  });
  it("reports a different observed provider model as a mismatch", () => {
    const f = fixture();
    present(f.receiptSet.observedIdentity).modelId = "other-model";
    for (const call of f.receiptSet.calls) present(call.receipt.response).modelId = "other-model";
    f.receiptSet.observedIdentitySha256 = modelRuntimeIdentityDigest(
      present(f.receiptSet.observedIdentity),
    );
    f.reseal();
    expect(verifyModelInvocationSubmission(f)).toMatchObject({
      state: "mismatched",
      reasons: ["RUNTIME_IDENTITY_MISMATCH"],
    });
  });
  it("does not compare Worker timestamps against the unrelated Server clock", () => {
    const f = fixture();
    for (const call of f.receiptSet.calls) {
      call.receipt.startedAt = "2026-09-07T23:59:00.000Z";
      call.receipt.finishedAt = "2026-09-07T23:59:00.000Z";
    }
    f.receiptSet.closedAt = "2026-09-07T23:59:01.000Z";
    f.reseal();
    expect(verifyModelInvocationSubmission(f).state).toBe("matched");
  });
  it("rejects a seal whose Server timestamp predates the opening", () => {
    const f = fixture();
    f.seal.recordedAt = "2026-09-07T23:59:00.000Z";
    expect(verifyModelInvocationSubmission(f)).toEqual({
      state: "invalid",
      reasons: ["INVALID_EXPECTATION"],
      observedIdentitySha256: null,
    });
  });
});
