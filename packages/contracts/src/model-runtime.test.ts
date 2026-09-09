import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  getModelCallReceiptIssues,
  getModelInvocationReceiptSetIssues,
  getModelInvocationScopeIssues,
  getModelResponseObservationIssues,
  getModelRuntimeIdentityIssues,
  type ModelCallReceiptV1,
  ModelCallReceiptV1Schema,
  type ModelInvocationReceiptSetV1,
  ModelInvocationReceiptSetV1Schema,
  type ModelInvocationScopeV1,
  ModelInvocationScopeV1Schema,
  type ModelInvocationScopeV2,
  type ModelResponseObservationV1,
  ModelResponseObservationV1Schema,
  ModelResponseReasonCodeSchema,
  type ModelRuntimeIdentityV1,
  ModelRuntimeIdentityV1Schema,
  maximumModelInvocationCallCount,
  maximumModelRequestBytes,
  maximumModelResponseBytes,
  maximumModelResponseEventCount,
  maximumModelRuntimeUtf8Bytes,
} from "./model-runtime.js";

const now = "2026-09-08T12:00:00.000Z";
// These synthetic digests exercise consistency only; they do not authenticate runtime metadata.
const digest = (value: number): string => value.toString(16).padStart(64, "0");

describe("versioned validation summary invocation scope", () => {
  function summaryScope(): ModelInvocationScopeV2 {
    const original = scope();
    return {
      ...original,
      schemaVersion: "ModelInvocationScopeV2",
      purpose: "validation_summary",
      inputRef: {
        schemaVersion: "ValidationSummaryInputReferenceV1",
        inputId: "input-1",
        inputSha256: digest(50),
        sourcePromptSha256: original.promptSha256,
        outputSchemaSha256: original.outputSchemaSha256,
        contextSha256: digest(51),
        actualPromptSha256: digest(52),
      },
    };
  }
  it("keeps V1 strict and requires V2 containers to carry the explicit summary binding", () => {
    const v1 = scope();
    const before = JSON.stringify(v1);
    const v2 = summaryScope();
    expect(getModelInvocationScopeIssues(v1)).toEqual([]);
    expect(getModelInvocationScopeIssues(v2)).toEqual([]);
    expect(Value.Check(ModelInvocationScopeV1Schema, v2)).toBe(false);
    expect(
      getModelInvocationScopeIssues({ ...v2, schemaVersion: "ModelInvocationScopeV1" }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelInvocationScopeIssues({ ...v1, schemaVersion: "ModelInvocationScopeV2" }).length,
    ).toBeGreaterThan(0);
    const set = { ...receiptSet(), schemaVersion: "ModelInvocationReceiptSetV2", scope: v2 };
    expect(getModelInvocationReceiptSetIssues(set)).toEqual([]);
    expect(
      getModelInvocationReceiptSetIssues({ ...set, schemaVersion: "ModelInvocationReceiptSetV1" })
        .length,
    ).toBeGreaterThan(0);
    expect(getModelInvocationReceiptSetIssues({ ...set, scope: v1 }).length).toBeGreaterThan(0);
    expect(JSON.stringify(v1)).toBe(before);
  });
  it.each(["sourcePromptSha256", "outputSchemaSha256"] as const)(
    "rejects a reference that changes %s",
    (field) => {
      const value = summaryScope();
      value.inputRef[field] = digest(99);
      expect(getModelInvocationScopeIssues(value).length).toBeGreaterThan(0);
    },
  );
  it.each(["inputSha256", "actualPromptSha256", "contextSha256"] as const)(
    "requires bounded exact %s",
    (field) => {
      const value = summaryScope();
      value.inputRef[field] = "invalid";
      expect(getModelInvocationScopeIssues(value).length).toBeGreaterThan(0);
    },
  );
});

function identity(): ModelRuntimeIdentityV1 {
  return {
    schemaVersion: "ModelRuntimeIdentityV1",
    providerId: "fixture-provider",
    endpointSha256: digest(1),
    modelId: "fixture-observed-model",
    client: {
      kind: "codex_cli",
      version: "fixture-version",
      executableSha256: digest(2),
      launchPolicySha256: digest(14),
    },
    relay: { implementationSha256: digest(3), policySha256: digest(4) },
  };
}

function scope(): ModelInvocationScopeV1 {
  return {
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
    executionManifestSha256: digest(5),
    promptSha256: digest(6),
    outputSchemaSha256: digest(7),
    expectedModelIdentitySha256: digest(8),
    requestedModel: "fixture-requested-model",
    workerNodeId: "worker-1",
    workerInstanceId: "instance-1",
    leaseGeneration: 1,
  };
}

function observation(): ModelResponseObservationV1 {
  return {
    schemaVersion: "ModelResponseObservationV1",
    bodySha256: digest(9),
    bodyBytes: 512,
    eventCount: 3,
    transportComplete: true,
    outcome: "completed",
    responseId: "response-1",
    modelId: identity().modelId,
    outputJsonSha256: digest(10),
    reasonCode: null,
  };
}

function receipt(sequence = 1): ModelCallReceiptV1 {
  return {
    schemaVersion: "ModelCallReceiptV1",
    scopeSha256: digest(11),
    sequence,
    previousReceiptSha256: sequence === 1 ? null : digest(100 + sequence - 1),
    startedAt: now,
    finishedAt: now,
    requestSha256: digest(12),
    requestBytes: 256,
    requestedModel: scope().requestedModel,
    httpStatus: 200,
    response: observation(),
    outcome: "completed",
  };
}

function receiptSet(count = 2): ModelInvocationReceiptSetV1 {
  const { schemaVersion: _schemaVersion, modelId: _modelId, ...runtime } = identity();
  return {
    schemaVersion: "ModelInvocationReceiptSetV1",
    scope: scope(),
    scopeSha256: digest(11),
    runtime,
    calls: Array.from({ length: count }, (_, index) => {
      const call = receipt(index + 1);
      call.response = {
        ...observation(),
        outputJsonSha256: index === count - 1 ? digest(10) : null,
      };
      return { receipt: call, sha256: digest(101 + index) };
    }),
    closedAt: now,
    state: "closed",
    modelOutputSha256: count === 0 ? null : digest(10),
    observedIdentity: count === 0 ? null : identity(),
    observedIdentitySha256: count === 0 ? null : digest(13),
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("The fixture entry is absent.");
  return value;
}

function invalidObservation(): ModelResponseObservationV1 {
  return {
    ...observation(),
    transportComplete: false,
    outcome: "invalid",
    responseId: null,
    modelId: null,
    outputJsonSha256: null,
    reasonCode: "TRANSPORT_INCOMPLETE",
  };
}

function receiptSetAtByteLimit(): ModelInvocationReceiptSetV1 {
  const value = receiptSet(maximumModelInvocationCallCount);
  const longIdentifier = "界".repeat(1024);
  value.scope.requestedModel = longIdentifier;
  required(value.observedIdentity).modelId = longIdentifier;
  for (const entry of value.calls) {
    entry.receipt.requestedModel = longIdentifier;
    required(entry.receipt.response).modelId = longIdentifier;
  }
  let remaining =
    maximumModelRuntimeUtf8Bytes - new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (remaining < 0) throw new Error("The initial fixture already exceeds the metadata budget.");
  for (const entry of value.calls) {
    const response = required(entry.receipt.response);
    const original = required(response.responseId);
    const capacity = 1024 - original.length;
    const multibyte = Math.min(capacity, Math.floor(remaining / 3));
    remaining -= multibyte * 3;
    const ascii = Math.min(capacity - multibyte, remaining);
    remaining -= ascii;
    response.responseId = `${original}${"界".repeat(multibyte)}${"x".repeat(ascii)}`;
  }
  if (remaining !== 0)
    throw new Error("The fixture cannot fill the aggregate metadata byte budget.");
  return value;
}

describe("model runtime identities and invocation scope", () => {
  it("retains separately requested and observed identities without claiming digest verification", () => {
    const value = receiptSet();
    const original = structuredClone(value);
    expect(getModelRuntimeIdentityIssues(identity())).toEqual([]);
    expect(getModelInvocationScopeIssues(scope())).toEqual([]);
    expect(getModelInvocationReceiptSetIssues(value)).toEqual([]);
    expect(value.scope.requestedModel).not.toBe(value.observedIdentity?.modelId);
    expect(value.scope.expectedModelIdentitySha256).not.toBe(value.observedIdentitySha256);
    expect(Value.Check(ModelRuntimeIdentityV1Schema, identity())).toBe(true);
    expect(Value.Check(ModelInvocationScopeV1Schema, scope())).toBe(true);
    expect(value).toEqual(original);
  });

  it("requires every exact scope identity and rejects extra authority or secret-bearing fields", () => {
    const fields = [
      "repositoryId",
      "evaluationId",
      "cellId",
      "runId",
      "requestId",
      "jobId",
      "attemptId",
      "invocationId",
      "authorizationId",
      "workerNodeId",
      "workerInstanceId",
    ] as const;
    for (const field of fields) {
      const missing: Record<string, unknown> = { ...scope() };
      delete missing[field];
      expect(getModelInvocationScopeIssues(missing).length, field).toBeGreaterThan(0);
      for (const invalid of ["", "id\n", " id", "id ", "id/other", "x".repeat(129), null]) {
        const value = { ...scope(), [field]: invalid };
        expect(Value.Check(ModelInvocationScopeV1Schema, value), field).toBe(false);
        expect(getModelInvocationScopeIssues(value).length, field).toBeGreaterThan(0);
      }
    }
    for (const extra of [
      { actor: { issuer: "fixture", subject: "fixture" } },
      { token: "fixture-token" },
      { headers: { authorization: "fixture-token" } },
      { verified: true },
      { replayOnly: true },
    ])
      expect(getModelInvocationScopeIssues({ ...scope(), ...extra }).length).toBeGreaterThan(0);
  });

  it("bounds lease generations and requires each frozen SHA-256 field", () => {
    expect(
      getModelInvocationScopeIssues({ ...scope(), leaseGeneration: Number.MAX_SAFE_INTEGER }),
    ).toEqual([]);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1"])
      expect(
        getModelInvocationScopeIssues({ ...scope(), leaseGeneration: invalid }).length,
      ).toBeGreaterThan(0);
    for (const field of [
      "executionManifestSha256",
      "promptSha256",
      "outputSchemaSha256",
      "expectedModelIdentitySha256",
    ] as const)
      for (const invalid of [null, "", "a".repeat(63), "A".repeat(64), `${digest(1)}\n`])
        expect(
          getModelInvocationScopeIssues({ ...scope(), [field]: invalid }).length,
        ).toBeGreaterThan(0);
  });

  it("rejects nonexact provider, client, requested-model and observed-model text", () => {
    for (const invalid of [
      "",
      " model",
      "model ",
      "model\n",
      "model\u007f",
      "model\u0085",
      "a\u202eb",
      "\ud800",
    ])
      for (const [check, value] of [
        [getModelRuntimeIdentityIssues, { ...identity(), modelId: invalid }],
        [getModelRuntimeIdentityIssues, { ...identity(), providerId: invalid }],
        [
          getModelRuntimeIdentityIssues,
          { ...identity(), client: { ...identity().client, version: invalid } },
        ],
        [getModelInvocationScopeIssues, { ...scope(), requestedModel: invalid }],
        [getModelCallReceiptIssues, { ...receipt(), requestedModel: invalid }],
        [getModelResponseObservationIssues, { ...observation(), modelId: invalid }],
        [getModelResponseObservationIssues, { ...observation(), responseId: invalid }],
      ] as const)
        expect(check(value).length, JSON.stringify(invalid)).toBeGreaterThan(0);
    expect(getModelRuntimeIdentityIssues({ ...identity(), modelId: "界".repeat(1024) })).toEqual(
      [],
    );
    expect(
      getModelRuntimeIdentityIssues({ ...identity(), modelId: "x".repeat(1025) }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelRuntimeIdentityIssues({ ...identity(), providerId: "x".repeat(129) }).length,
    ).toBeGreaterThan(0);
  });

  it("retains executable content digests without paths, raw credentials or client attestation flags", () => {
    for (const extra of [
      { endpoint: "https://fixture.invalid/responses" },
      { model: "configured-label" },
      { verified: true },
      { headers: {} },
      { token: "fixture-token" },
    ])
      expect(getModelRuntimeIdentityIssues({ ...identity(), ...extra }).length).toBeGreaterThan(0);
    for (const field of ["path", "executablePath", "auth", "environment"])
      expect(
        getModelRuntimeIdentityIssues({
          ...identity(),
          client: { ...identity().client, [field]: "fixture-value" },
        }).length,
      ).toBeGreaterThan(0);
    expect(
      getModelRuntimeIdentityIssues({
        ...identity(),
        client: { ...identity().client, executableSha256: "C:\\fixture\\codex.exe" },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("requires a distinct stable launch-policy digest in both identity and measured runtime", () => {
    const value = receiptSet();
    expect(value.runtime.client.launchPolicySha256).not.toBe(value.runtime.relay.policySha256);
    expect(getModelInvocationReceiptSetIssues(value)).toEqual([]);
    const { launchPolicySha256: _launchPolicySha256, ...missingClient } = identity().client;
    expect(
      getModelRuntimeIdentityIssues({ ...identity(), client: missingClient }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelInvocationReceiptSetIssues({
        ...value,
        runtime: { ...value.runtime, client: missingClient },
      }).length,
    ).toBeGreaterThan(0);
    for (const invalid of [
      null,
      "",
      "a".repeat(63),
      "A".repeat(64),
      `${digest(14)}\n`,
      "C:\\attempt",
    ])
      expect(
        getModelRuntimeIdentityIssues({
          ...identity(),
          client: { ...identity().client, launchPolicySha256: invalid },
        }).length,
      ).toBeGreaterThan(0);
  });
});

describe("model response observations", () => {
  it("permits completed tool turns without claiming a final structured output", () => {
    const value = { ...observation(), outputJsonSha256: null };
    expect(getModelResponseObservationIssues(value)).toEqual([]);
    expect(Value.Check(ModelResponseObservationV1Schema, value)).toBe(true);
    expect(getModelCallReceiptIssues({ ...receipt(), response: value })).toEqual([]);
  });

  it.each([
    ["failed", "RESPONSE_FAILED"],
    ["incomplete", "RESPONSE_INCOMPLETE"],
  ] as const)("preserves valid %s terminal metadata as diagnostics", (outcome, reasonCode) => {
    const value = { ...observation(), outcome, reasonCode, outputJsonSha256: null };
    expect(getModelResponseObservationIssues(value)).toEqual([]);
    expect(
      getModelResponseObservationIssues({ ...value, transportComplete: false }).length,
    ).toBeGreaterThan(0);
    expect(getModelResponseObservationIssues({ ...value, modelId: null }).length).toBeGreaterThan(
      0,
    );
    expect(
      getModelResponseObservationIssues({ ...value, reasonCode: null }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelResponseObservationIssues({ ...value, outputJsonSha256: digest(10) }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects successful metadata without a complete transport and exact response/model identities", () => {
    for (const changed of [
      { transportComplete: false },
      { modelId: null },
      { responseId: null },
      { reasonCode: "RESPONSE_FAILED" },
      { reasonCode: "MISSING_TERMINAL" },
    ])
      expect(
        getModelResponseObservationIssues({ ...observation(), ...changed }).length,
      ).toBeGreaterThan(0);
  });

  it("clears all identity and output claims after invalid or truncated metadata", () => {
    const value = invalidObservation();
    expect(getModelResponseObservationIssues(value)).toEqual([]);
    expect(
      getModelResponseObservationIssues({
        ...value,
        transportComplete: true,
        reasonCode: "INVALID_JSON",
      }),
    ).toEqual([]);
    expect(
      getModelResponseObservationIssues({ ...value, transportComplete: true }).length,
    ).toBeGreaterThan(0);
    for (const changed of [
      { modelId: identity().modelId },
      { responseId: "response-1" },
      { outputJsonSha256: digest(10) },
      { reasonCode: null },
      { reasonCode: "RESPONSE_FAILED" },
      { reasonCode: "RESPONSE_INCOMPLETE" },
    ])
      expect(getModelResponseObservationIssues({ ...value, ...changed }).length).toBeGreaterThan(0);
  });

  it("uses a closed reason-code vocabulary and rejects raw error messages or response bodies", () => {
    expect(ModelResponseReasonCodeSchema.anyOf).toHaveLength(16);
    for (const reasonCode of [
      "UNKNOWN_REASON",
      "invalid_json",
      "INVALID_JSON\n",
      "provider failed: fixture",
    ])
      expect(
        getModelResponseObservationIssues({ ...invalidObservation(), reasonCode }).length,
      ).toBeGreaterThan(0);
    for (const extra of [
      { body: "fixture response text" },
      { response: { model: identity().modelId } },
      { headers: {} },
      { token: "fixture-token" },
      { verified: true },
    ])
      expect(
        getModelResponseObservationIssues({ ...observation(), ...extra }).length,
      ).toBeGreaterThan(0);
  });

  it("bounds observed byte and event counters without accepting unsafe or fractional numbers", () => {
    expect(
      getModelResponseObservationIssues({
        ...observation(),
        bodyBytes: maximumModelResponseBytes,
        eventCount: maximumModelResponseEventCount,
      }),
    ).toEqual([]);
    for (const field of ["bodyBytes", "eventCount"] as const)
      for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1"])
        expect(
          getModelResponseObservationIssues({ ...observation(), [field]: invalid }).length,
        ).toBeGreaterThan(0);
    expect(
      getModelResponseObservationIssues({
        ...observation(),
        bodyBytes: maximumModelResponseBytes + 1,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelResponseObservationIssues({
        ...observation(),
        eventCount: maximumModelResponseEventCount + 1,
      }).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ["completed", null],
    ["failed", "RESPONSE_FAILED"],
    ["incomplete", "RESPONSE_INCOMPLETE"],
  ] as const)("rejects an empty body for a recognized %s response", (outcome, reasonCode) => {
    const value = { ...observation(), outcome, reasonCode, outputJsonSha256: null, eventCount: 0 };
    expect(getModelResponseObservationIssues(value)).toEqual([]);
    expect(getModelResponseObservationIssues({ ...value, bodyBytes: 0 }).length).toBeGreaterThan(0);
    expect(
      getModelResponseObservationIssues({ ...invalidObservation(), bodyBytes: 0, eventCount: 0 }),
    ).toEqual([]);
  });

  it("retains actual overshoot counters only in invalid observations without identity claims", () => {
    const value = {
      ...invalidObservation(),
      bodyBytes: maximumModelResponseBytes + 1,
      eventCount: maximumModelResponseEventCount + 1,
      reasonCode: "BODY_LIMIT_EXCEEDED" as const,
    };
    expect(getModelResponseObservationIssues(value)).toEqual([]);
    expect(
      getModelResponseObservationIssues({
        ...value,
        bodyBytes: Number.MAX_SAFE_INTEGER,
        eventCount: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual([]);
    expect(
      getModelResponseObservationIssues({ ...value, bodyBytes: Number.MAX_SAFE_INTEGER + 1 })
        .length,
    ).toBeGreaterThan(0);
    expect(
      getModelResponseObservationIssues({ ...value, eventCount: Number.MAX_SAFE_INTEGER + 1 })
        .length,
    ).toBeGreaterThan(0);
    expect(
      getModelResponseObservationIssues({ ...value, modelId: identity().modelId }).length,
    ).toBeGreaterThan(0);
  });
});

describe("model call receipts", () => {
  it("retains bounded call outcomes separately from provider observations", () => {
    expect(getModelCallReceiptIssues(receipt())).toEqual([]);
    expect(Value.Check(ModelCallReceiptV1Schema, receipt())).toBe(true);
    for (const outcome of [
      "transport_failed",
      "cancelled",
      "protocol_invalid",
      "budget_exceeded",
    ] as const)
      expect(
        getModelCallReceiptIssues({
          ...receipt(),
          outcome,
          httpStatus: null,
          response: null,
        }),
      ).toEqual([]);
    expect(
      getModelCallReceiptIssues({
        ...receipt(),
        outcome: "provider_failed",
        httpStatus: 502,
        response: null,
      }),
    ).toEqual([]);
  });

  it("does not treat an HTTP success or a completed flag alone as a completed model call", () => {
    for (const changed of [
      { httpStatus: null },
      { httpStatus: 500 },
      { response: null },
      { response: invalidObservation() },
    ])
      expect(getModelCallReceiptIssues({ ...receipt(), ...changed }).length).toBeGreaterThan(0);
    expect(
      getModelCallReceiptIssues({ ...receipt(), outcome: "provider_failed" }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelCallReceiptIssues({ ...receipt(), outcome: "provider_incomplete" }).length,
    ).toBeGreaterThan(0);
  });

  it("requires exact timestamps, monotonic completion and first-call chain origin", () => {
    expect(getModelCallReceiptIssues(receipt(2))).toEqual([]);
    for (const changed of [
      { startedAt: "2026-09-08T12:00:00.001Z" },
      { finishedAt: "2026-09-08T11:59:59.999Z" },
      { startedAt: `${now}\n` },
      { finishedAt: "yesterday" },
      { previousReceiptSha256: digest(1) },
      { sequence: 2 },
    ])
      expect(getModelCallReceiptIssues({ ...receipt(), ...changed }).length).toBeGreaterThan(0);
  });

  it.each([
    "2026-02-31T12:00:00.000Z",
    "2026-02-29T12:00:00.000Z",
    "1900-02-29T12:00:00.000Z",
    "2026-04-31T12:00:00.000Z",
    "2026-00-01T12:00:00.000Z",
    "2026-13-01T12:00:00.000Z",
    "2026-01-00T12:00:00.000Z",
    "2026-01-01T24:00:00.000Z",
    "2026-01-01T12:60:00.000Z",
    "2026-01-01T12:00:60.000Z",
    "2026-01-01T12:00:00.000+24:00",
    "2026-01-01T12:00:00.000+00:60",
  ])("rejects an impossible calendar or clock value: %s", (value) => {
    expect(
      getModelCallReceiptIssues({ ...receipt(), startedAt: value, finishedAt: value }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelInvocationReceiptSetIssues({ ...receiptSet(0), closedAt: value }).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    "2000-02-29T23:59:59.123+05:30",
    "2024-02-29T00:00:00Z",
    "1900-02-28T12:00:00.000Z",
    "2026-04-30T12:00:00-04:00",
    "2026-09-08T12:00:00.1Z",
    "2026-09-08T12:00:00.12+05:30",
    "2026-09-08T12:00:00.123-04:00",
  ])("retains valid leap days, fractions and explicit offsets: %s", (value) => {
    expect(
      getModelCallReceiptIssues({ ...receipt(), startedAt: value, finishedAt: value }),
    ).toEqual([]);
    expect(getModelInvocationReceiptSetIssues({ ...receiptSet(0), closedAt: value })).toEqual([]);
  });

  it("rejects submillisecond call timestamps before their ordering can be rounded away", () => {
    const value = {
      ...receipt(),
      startedAt: "2026-09-08T12:00:00.0009Z",
      finishedAt: "2026-09-08T12:00:00.0001Z",
    };
    expect(Value.Check(ModelCallReceiptV1Schema, value)).toBe(false);
    expect(getModelCallReceiptIssues(value).length).toBeGreaterThan(0);
  });

  it("rejects submillisecond overlap across calls and overprecise closure timestamps", () => {
    const value = receiptSet();
    required(value.calls[0]).receipt.finishedAt = "2026-09-08T12:00:00.0009Z";
    required(value.calls[1]).receipt.startedAt = "2026-09-08T12:00:00.0001Z";
    required(value.calls[1]).receipt.finishedAt = "2026-09-08T12:00:00.001Z";
    value.closedAt = "2026-09-08T12:00:00.001Z";
    expect(Value.Check(ModelInvocationReceiptSetV1Schema, value)).toBe(false);
    expect(getModelInvocationReceiptSetIssues(value).length).toBeGreaterThan(0);
    for (const closedAt of ["2026-09-08T12:00:00.1234Z", "2026-09-08T12:00:00.0000001+05:30"])
      expect(
        getModelInvocationReceiptSetIssues({ ...receiptSet(0), closedAt }).length,
      ).toBeGreaterThan(0);
  });

  it("validates dates independently without registering or consulting a global format callback", () => {
    const original = FormatRegistry.Get("date-time");
    try {
      FormatRegistry.Delete("date-time");
      expect(getModelCallReceiptIssues(receipt())).toEqual([]);
      expect(FormatRegistry.Has("date-time")).toBe(false);
      const rejecting = () => false;
      FormatRegistry.Set("date-time", rejecting);
      expect(getModelInvocationReceiptSetIssues(receiptSet())).toEqual([]);
      expect(FormatRegistry.Get("date-time")).toBe(rejecting);
      const permissive = () => true;
      FormatRegistry.Set("date-time", permissive);
      expect(
        getModelInvocationReceiptSetIssues({
          ...receiptSet(0),
          closedAt: "2026-02-31T12:00:00Z",
        }).length,
      ).toBeGreaterThan(0);
      expect(FormatRegistry.Get("date-time")).toBe(permissive);
    } finally {
      if (original === undefined) FormatRegistry.Delete("date-time");
      else FormatRegistry.Set("date-time", original);
    }
  });

  it("enforces global request, HTTP-status and call-sequence bounds", () => {
    expect(
      getModelCallReceiptIssues({ ...receipt(), requestBytes: maximumModelRequestBytes }),
    ).toEqual([]);
    for (const changed of [
      { requestBytes: -1 },
      { requestBytes: maximumModelRequestBytes + 1 },
      { requestBytes: Number.MAX_SAFE_INTEGER + 1 },
      { requestBytes: 0.5 },
      { httpStatus: 99 },
      { httpStatus: 600 },
      { httpStatus: 200.5 },
      { sequence: 0 },
      { sequence: maximumModelInvocationCallCount + 1 },
    ])
      expect(getModelCallReceiptIssues({ ...receipt(), ...changed }).length).toBeGreaterThan(0);
  });
});

describe("model invocation receipt chains", () => {
  it("preserves empty closed/cancelled diagnostic sets without inventing execution", () => {
    const value = receiptSet(0);
    expect(getModelInvocationReceiptSetIssues(value)).toEqual([]);
    expect(getModelInvocationReceiptSetIssues({ ...value, state: "cancelled" })).toEqual([]);
    expect(
      getModelInvocationReceiptSetIssues({ ...value, modelOutputSha256: digest(10) }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelInvocationReceiptSetIssues({
        ...value,
        observedIdentity: identity(),
        observedIdentitySha256: digest(13),
      }).length,
    ).toBeGreaterThan(0);
  });

  it("binds every receipt to its exact sequence, predecessor, invocation scope and requested model", () => {
    for (const changed of [
      { sequence: 1 },
      { sequence: 3 },
      { previousReceiptSha256: digest(99) },
      { previousReceiptSha256: null },
      { scopeSha256: digest(99) },
      { requestedModel: "other-requested-model" },
    ]) {
      const value = receiptSet();
      const last = required(value.calls[1]);
      last.receipt = { ...last.receipt, ...changed };
      expect(getModelInvocationReceiptSetIssues(value).length).toBeGreaterThan(0);
    }
    const repeated = receiptSet();
    required(repeated.calls[1]).sha256 = required(repeated.calls[0]).sha256;
    expect(getModelInvocationReceiptSetIssues(repeated).length).toBeGreaterThan(0);
    const swapped = receiptSet();
    swapped.calls.reverse();
    expect(getModelInvocationReceiptSetIssues(swapped).length).toBeGreaterThan(0);
  });

  it("requires the measured runtime to agree with every observed identity component", () => {
    const mutations: Array<(value: ModelRuntimeIdentityV1) => void> = [
      (value) => {
        value.providerId = "other-provider";
      },
      (value) => {
        value.endpointSha256 = digest(90);
      },
      (value) => {
        value.client.version = "other-version";
      },
      (value) => {
        value.client.executableSha256 = digest(90);
      },
      (value) => {
        value.client.launchPolicySha256 = digest(90);
      },
      (value) => {
        value.relay.implementationSha256 = digest(90);
      },
      (value) => {
        value.relay.policySha256 = digest(90);
      },
      (value) => {
        value.modelId = "other-observed-model";
      },
    ];
    for (const mutate of mutations) {
      const value = receiptSet();
      mutate(required(value.observedIdentity));
      expect(getModelInvocationReceiptSetIssues(value).length).toBeGreaterThan(0);
    }
    for (const changed of [{ observedIdentity: null }, { observedIdentitySha256: null }])
      expect(
        getModelInvocationReceiptSetIssues({ ...receiptSet(), ...changed }).length,
      ).toBeGreaterThan(0);
  });

  it("cannot select a known successful subset while another call lacks valid identity metadata", () => {
    for (const changed of [
      { outcome: "transport_failed" as const, response: null },
      { outcome: "protocol_invalid" as const, response: invalidObservation() },
      { response: { ...observation(), modelId: "another-model" } },
    ]) {
      const value = receiptSet();
      const first = required(value.calls[0]);
      first.receipt = { ...first.receipt, ...changed };
      expect(getModelInvocationReceiptSetIssues(value).length).toBeGreaterThan(0);
      value.observedIdentity = null;
      value.observedIdentitySha256 = null;
      expect(getModelInvocationReceiptSetIssues(value)).toEqual([]);
    }
  });

  it.each([
    ["provider_failed", "failed", "RESPONSE_FAILED"],
    ["provider_incomplete", "incomplete", "RESPONSE_INCOMPLETE"],
  ] as const)(
    "retains consistent observed identity for %s diagnostics",
    (outcome, responseOutcome, reasonCode) => {
      const value = receiptSet();
      required(value.calls[0]).receipt = {
        ...required(value.calls[0]).receipt,
        outcome,
        response: {
          ...observation(),
          outcome: responseOutcome,
          reasonCode,
          outputJsonSha256: null,
        },
      };
      expect(getModelInvocationReceiptSetIssues(value)).toEqual([]);
    },
  );

  it("binds selected output to the final completed call and forbids output after cancellation", () => {
    const value = receiptSet();
    expect(getModelInvocationReceiptSetIssues(value)).toEqual([]);
    expect(Value.Check(ModelInvocationReceiptSetV1Schema, value)).toBe(true);
    expect(
      getModelInvocationReceiptSetIssues({ ...value, modelOutputSha256: digest(99) }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelInvocationReceiptSetIssues({ ...value, state: "cancelled" }).length,
    ).toBeGreaterThan(0);
    const unselected = receiptSet();
    required(required(unselected.calls[0]).receipt.response).outputJsonSha256 = digest(10);
    required(required(unselected.calls[1]).receipt.response).outputJsonSha256 = null;
    expect(getModelInvocationReceiptSetIssues(unselected).length).toBeGreaterThan(0);
    const lateFailure = receiptSet();
    required(lateFailure.calls[1]).receipt.outcome = "cancelled";
    expect(getModelInvocationReceiptSetIssues(lateFailure).length).toBeGreaterThan(0);
  });

  it("closes after every call and enforces the complete 128-call budget", () => {
    const value = receiptSet(maximumModelInvocationCallCount);
    expect(getModelInvocationReceiptSetIssues(value)).toEqual([]);
    expect(
      getModelInvocationReceiptSetIssues({ ...value, closedAt: "2026-09-08T11:59:59.999Z" }).length,
    ).toBeGreaterThan(0);
    expect(
      getModelInvocationReceiptSetIssues(receiptSet(maximumModelInvocationCallCount + 1)).length,
    ).toBeGreaterThan(0);
    const missing = receiptSet();
    missing.calls.shift();
    expect(getModelInvocationReceiptSetIssues(missing).length).toBeGreaterThan(0);
  });

  it("enforces an aggregate UTF-8 byte limit independently of valid per-field lengths", () => {
    const value = receiptSetAtByteLimit();
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBe(
      maximumModelRuntimeUtf8Bytes,
    );
    expect(Value.Check(ModelInvocationReceiptSetV1Schema, value)).toBe(true);
    expect(getModelInvocationReceiptSetIssues(value)).toEqual([]);
    const entry = required(
      value.calls.find(({ receipt }) => required(receipt.response?.responseId).length < 1024),
    );
    const response = required(entry.receipt.response);
    response.responseId = `${response.responseId}x`;
    expect(Value.Check(ModelInvocationReceiptSetV1Schema, value)).toBe(true);
    expect(getModelInvocationReceiptSetIssues(value)).toEqual([
      "Model runtime metadata exceeds its aggregate UTF-8 byte limit.",
    ]);
  });

  it("rejects raw payloads, secret fields and attestation flags at nested boundaries", () => {
    const changes: Array<(value: ModelInvocationReceiptSetV1) => unknown> = [
      (value) => ({ ...value, verified: true }),
      (value) => ({ ...value, runtime: { ...value.runtime, modelId: "configured-label" } }),
      (value) => ({
        ...value,
        runtime: { ...value.runtime, schemaVersion: "ModelRuntimeIdentityV1" },
      }),
      (value) => ({ ...value, runtime: { ...value.runtime, token: "fixture-token" } }),
      (value) => ({ ...value, calls: [{ ...value.calls[0], responseBody: "fixture-body" }] }),
      (value) => ({
        ...value,
        calls: [{ ...value.calls[0], receipt: { ...value.calls[0]?.receipt, headers: {} } }],
      }),
    ];
    for (const change of changes)
      expect(getModelInvocationReceiptSetIssues(change(receiptSet())).length).toBeGreaterThan(0);
  });

  it("rejects non-JSON objects without invoking accessors or mutating input", () => {
    const value = receiptSet();
    let invoked = false;
    Object.defineProperty(value, "closedAt", {
      enumerable: true,
      get: () => {
        invoked = true;
        throw new Error("Do not invoke fixture accessors.");
      },
    });
    expect(getModelInvocationReceiptSetIssues(value).length).toBeGreaterThan(0);
    expect(invoked).toBe(false);
    const cyclic: Record<string, unknown> = { ...receiptSet() };
    cyclic.self = cyclic;
    const sparse = receiptSet();
    delete sparse.calls[0];
    const symbol = receiptSet();
    Object.defineProperty(symbol, Symbol("hidden"), { value: "fixture-secret" });
    for (const invalid of [undefined, null, new Date(), cyclic, sparse, symbol])
      expect(getModelInvocationReceiptSetIssues(invalid).length).toBeGreaterThan(0);
  });
});
