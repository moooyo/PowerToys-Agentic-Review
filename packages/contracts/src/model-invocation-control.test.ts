import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  getModelInvocationBeginRequestIssues,
  getModelInvocationConsistencyIssues,
  getModelInvocationOpeningIssues,
  getModelInvocationSealIssues,
  getModelInvocationSealRequestIssues,
  getModelInvocationSubmissionIssues,
  getModelInvocationSubmitRequestIssues,
  type ModelInvocationBeginRequest,
  ModelInvocationBeginRequestSchema,
  type ModelInvocationConsistency,
  ModelInvocationConsistencyReasonSchema,
  type ModelInvocationOpeningV1,
  ModelInvocationOpeningV1Schema,
  type ModelInvocationSealRequest,
  ModelInvocationSealRequestSchema,
  type ModelInvocationSealV1,
  ModelInvocationSealV1Schema,
  type ModelInvocationSubmissionV1,
  ModelInvocationSubmissionV1Schema,
  type ModelInvocationSubmitRequest,
  ModelInvocationSubmitRequestSchema,
  maximumModelInvocationControlRequestUtf8Bytes,
  maximumModelInvocationSubmitRequestUtf8Bytes,
} from "./model-invocation-control.js";
import {
  getModelInvocationReceiptSetIssues,
  ModelInvocationReceiptSetSchema,
  type ModelInvocationReceiptSetV1,
  ModelInvocationReceiptSetV1Schema,
  type ModelInvocationScopeV1,
  maximumModelInvocationCallCount,
  maximumModelRuntimeUtf8Bytes,
} from "./model-runtime.js";
import type { LeaseIdentity } from "./worker.js";

const now = "2026-09-08T12:00:00.000Z";
// Synthetic digests validate transport consistency, never actual model or collector identity.
const digest = (value: number): string => value.toString(16).padStart(64, "0");
const runtime = (): ModelInvocationBeginRequest["runtime"] => ({
  providerId: "synthetic-provider",
  endpointSha256: digest(1),
  client: {
    kind: "codex_cli",
    version: "synthetic-client",
    executableSha256: digest(2),
    launchPolicySha256: digest(3),
  },
  relay: { implementationSha256: digest(4), policySha256: digest(5) },
});
const lease = (): LeaseIdentity => ({
  jobId: "job-1",
  runAttemptId: "attempt-1",
  workerNodeId: "worker-1",
  workerInstanceId: "instance-1",
  leaseGeneration: 1,
  leaseToken: "synthetic-lease-token-not-a-credential",
});
const scope = (): ModelInvocationScopeV1 => ({
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
  executionManifestSha256: digest(6),
  promptSha256: digest(7),
  outputSchemaSha256: digest(8),
  expectedModelIdentitySha256: digest(9),
  requestedModel: "synthetic-requested-model",
  workerNodeId: "worker-1",
  workerInstanceId: "instance-1",
  leaseGeneration: 1,
});
const begin = (): ModelInvocationBeginRequest => ({
  lease: lease(),
  invocationId: "invocation-1",
  runtime: runtime(),
});
const opening = (): ModelInvocationOpeningV1 => ({
  schemaVersion: "ModelInvocationOpeningV1",
  scope: scope(),
  scopeSha256: digest(10),
  runtime: runtime(),
  openedAt: now,
});
const sealRequest = (): ModelInvocationSealRequest => ({
  lease: lease(),
  invocationId: "invocation-1",
  scopeSha256: digest(10),
  receiptSetSha256: digest(11),
  closedAt: now,
  state: "closed",
  callCount: 1,
  lastReceiptSha256: digest(12),
  modelOutputSha256: digest(13),
  observedIdentitySha256: digest(9),
  processClosed: true,
  relayClosed: true,
});
const seal = (): ModelInvocationSealV1 => {
  const { lease: _lease, ...fields } = sealRequest();
  return { schemaVersion: "ModelInvocationSealV1", ...fields, recordedAt: now };
};
function receiptSet(count = 1): ModelInvocationReceiptSetV1 {
  return {
    schemaVersion: "ModelInvocationReceiptSetV1",
    scope: scope(),
    scopeSha256: digest(10),
    runtime: runtime(),
    calls: Array.from({ length: count }, (_, index) => ({
      receipt: {
        schemaVersion: "ModelCallReceiptV1",
        scopeSha256: digest(10),
        sequence: index + 1,
        previousReceiptSha256: index === 0 ? null : digest(100 + index - 1),
        startedAt: now,
        finishedAt: now,
        requestSha256: digest(20),
        requestBytes: 512,
        requestedModel: scope().requestedModel,
        httpStatus: 200,
        response: {
          schemaVersion: "ModelResponseObservationV1",
          bodySha256: digest(21),
          bodyBytes: 1024,
          eventCount: 3,
          transportComplete: true,
          outcome: "completed",
          responseId: `synthetic-response-${index}`,
          modelId: "synthetic-observed-model",
          outputJsonSha256: index === count - 1 ? digest(13) : null,
          reasonCode: null,
        },
        outcome: "completed",
      },
      sha256: digest(100 + index),
    })),
    closedAt: now,
    state: "closed",
    modelOutputSha256: count === 0 ? null : digest(13),
    observedIdentity:
      count === 0
        ? null
        : {
            schemaVersion: "ModelRuntimeIdentityV1",
            ...runtime(),
            modelId: "synthetic-observed-model",
          },
    observedIdentitySha256: count === 0 ? null : digest(9),
  };
}
const submit = (): ModelInvocationSubmitRequest => ({
  lease: lease(),
  invocationId: "invocation-1",
  receiptSet: receiptSet(),
});
const submission = (): ModelInvocationSubmissionV1 => ({
  schemaVersion: "ModelInvocationSubmissionV1",
  invocationId: "invocation-1",
  scopeSha256: digest(10),
  receiptSetSha256: digest(11),
  receivedAt: now,
  consistency: { state: "matched", reasons: [], observedIdentitySha256: digest(9) },
  executionAccepted: false,
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The synthetic fixture is incomplete.");
  return value;
}

describe("Model invocation array prototype boundary", () => {
  it.each(["control", "ledger"])(
    "rejects inherited toJSON before invoking it in the %s validator",
    (kind) => {
      const value = submit();
      let called = 0;
      const prototype = Object.create(Array.prototype);
      Object.defineProperty(prototype, "toJSON", {
        get() {
          called += 1;
          throw new Error("Unexpected inherited getter.");
        },
      });
      Object.setPrototypeOf(value.receiptSet.calls, prototype);
      expect(
        kind === "control"
          ? getModelInvocationSubmitRequestIssues(value)
          : getModelInvocationReceiptSetIssues(value.receiptSet),
      ).not.toEqual([]);
      expect(called).toBe(0);
    },
  );
});

const contracts = [
  {
    name: "begin",
    make: begin,
    schema: ModelInvocationBeginRequestSchema,
    check: getModelInvocationBeginRequestIssues,
  },
  {
    name: "opening",
    make: opening,
    schema: ModelInvocationOpeningV1Schema,
    check: getModelInvocationOpeningIssues,
  },
  {
    name: "seal request",
    make: sealRequest,
    schema: ModelInvocationSealRequestSchema,
    check: getModelInvocationSealRequestIssues,
  },
  {
    name: "seal",
    make: seal,
    schema: ModelInvocationSealV1Schema,
    check: getModelInvocationSealIssues,
  },
  {
    name: "submit",
    make: submit,
    schema: ModelInvocationSubmitRequestSchema,
    check: getModelInvocationSubmitRequestIssues,
  },
  {
    name: "submission",
    make: submission,
    schema: ModelInvocationSubmissionV1Schema,
    check: getModelInvocationSubmissionIssues,
  },
];

describe.each(contracts)("$name strict control contract", ({ make, schema, check }) => {
  it("accepts the complete synthetic shape without altering its original bytes", () => {
    const value = make(),
      before = JSON.stringify(value);
    expect(Value.Check(schema, value)).toBe(true);
    expect(check(value)).toEqual([]);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("rejects extra fields and missing fields", () => {
    expect(check({ ...make(), executionAuthority: true })).not.toEqual([]);
    const value: Record<string, unknown> = { ...make() };
    delete value[required(Object.keys(value)[0])];
    expect(check(value)).not.toEqual([]);
  });

  it("rejects accessors before executing their getter", () => {
    let calls = 0;
    const value = make();
    Object.defineProperty(value, required(Object.keys(value)[0]), {
      enumerable: true,
      get() {
        calls++;
        throw new Error("The getter must never execute.");
      },
    });
    expect(check(value)).not.toEqual([]);
    expect(calls).toBe(0);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => null])(
    "rejects non-JSON metadata %s",
    (entry) => {
      expect(check({ ...make(), extra: entry })).not.toEqual([]);
    },
  );

  it("rejects malformed Unicode, hidden fields, symbols, cycles and foreign prototypes", () => {
    expect(check({ ...make(), "\ud800": true })).not.toEqual([]);
    const hidden = make();
    Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
    expect(check(hidden)).not.toEqual([]);
    const symbol = { ...make(), [Symbol("hidden")]: true };
    expect(check(symbol)).not.toEqual([]);
    const cycle = { ...make(), cycle: {} };
    cycle.cycle = cycle;
    expect(check(cycle)).not.toEqual([]);
    expect(check(Object.assign(Object.create({ inherited: true }), make()))).not.toEqual([]);
  });
});

describe("lease and runtime identity consistency", () => {
  it("reuses existing runtime fields and explicitly versioned receipt schemas", () => {
    expect(ModelInvocationBeginRequestSchema.properties.runtime).toBe(
      ModelInvocationReceiptSetV1Schema.properties.runtime,
    );
    expect(ModelInvocationOpeningV1Schema.properties.runtime).toBe(
      ModelInvocationReceiptSetV1Schema.properties.runtime,
    );
    expect(ModelInvocationSubmitRequestSchema.properties.receiptSet).toBe(
      ModelInvocationReceiptSetSchema,
    );
    expect(ModelInvocationReceiptSetSchema.anyOf).toContain(ModelInvocationReceiptSetV1Schema);
  });

  it("accepts a summary reference only in an explicitly versioned opening and rejects mixed versions", () => {
    const original = scope();
    const reference = {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "input-a",
      inputSha256: digest(31),
      sourcePromptSha256: original.promptSha256,
      outputSchemaSha256: original.outputSchemaSha256,
      contextSha256: digest(32),
      actualPromptSha256: digest(33),
    } as const;
    expect(getModelInvocationBeginRequestIssues({ ...begin(), summaryInput: reference })).toEqual(
      [],
    );
    const value = {
      ...opening(),
      schemaVersion: "ModelInvocationOpeningV2",
      scope: {
        ...original,
        schemaVersion: "ModelInvocationScopeV2",
        purpose: "validation_summary",
        inputRef: reference,
      },
    };
    expect(getModelInvocationOpeningIssues(value)).toEqual([]);
    expect(
      getModelInvocationOpeningIssues({ ...value, schemaVersion: "ModelInvocationOpeningV1" })
        .length,
    ).toBeGreaterThan(0);
    expect(getModelInvocationOpeningIssues({ ...value, scope: original }).length).toBeGreaterThan(
      0,
    );
    expect(
      getModelInvocationBeginRequestIssues({
        ...begin(),
        summaryInput: { ...reference, context: {} },
      }).length,
    ).toBeGreaterThan(0);
  });

  it.each(["jobId", "runAttemptId", "workerNodeId", "workerInstanceId", "leaseToken"] as const)(
    "rejects control characters in lease %s",
    (field) => {
      const value = begin();
      value.lease[field] += "\n";
      expect(getModelInvocationBeginRequestIssues(value)).not.toEqual([]);
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe lease generation %s",
    (value) => {
      const request = begin();
      request.lease.leaseGeneration = value;
      expect(getModelInvocationBeginRequestIssues(request)).not.toEqual([]);
    },
  );

  it.each([
    "\ud800",
    "\udfff",
    "prefix\u202esuffix",
    " leading",
    "trailing ",
    "a\u2028b",
    "a\u2029b",
  ])("rejects malformed or ambiguous runtime text %s", (text) => {
    const request = begin();
    request.runtime.providerId = text;
    expect(getModelInvocationBeginRequestIssues(request)).not.toEqual([]);
    const response = opening();
    response.runtime.client.version = text;
    expect(getModelInvocationOpeningIssues(response)).not.toEqual([]);
  });

  it.each([
    "invocationId",
    "jobId",
    "attemptId",
    "workerNodeId",
    "workerInstanceId",
    "leaseGeneration",
  ] as const)("rejects a submitted %s mismatch", (field) => {
    const value = submit();
    if (field === "leaseGeneration") value.receiptSet.scope[field]++;
    else value.receiptSet.scope[field] += "-other";
    expect(getModelInvocationSubmitRequestIssues(value)).toContain(
      "The submitted invocation scope must match every invocation and lease identity.",
    );
  });

  it("preserves nested ledger checks and refuses a changed receipt chain", () => {
    const value = submit();
    required(value.receiptSet.calls[0]).receipt.scopeSha256 = digest(99);
    expect(getModelInvocationSubmitRequestIssues(value)).not.toEqual([]);
  });

  it("rejects a nested runtime getter without invoking it", () => {
    let calls = 0;
    const value = begin();
    Object.defineProperty(value.runtime.client, "version", {
      enumerable: true,
      get() {
        calls++;
        return "synthetic-client";
      },
    });
    expect(getModelInvocationBeginRequestIssues(value)).not.toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("closure metadata", () => {
  it("represents zero calls without implying an observed identity or model output", () => {
    const value = sealRequest();
    Object.assign(value, {
      callCount: 0,
      lastReceiptSha256: null,
      modelOutputSha256: null,
      observedIdentitySha256: null,
    });
    expect(getModelInvocationSealRequestIssues(value)).toEqual([]);
    expect(
      getModelInvocationSubmitRequestIssues({ ...submit(), receiptSet: receiptSet(0) }),
    ).toEqual([]);
  });

  it.each(["lastReceiptSha256", "modelOutputSha256", "observedIdentitySha256"] as const)(
    "rejects %s on a zero-call seal",
    (field) => {
      const value = seal();
      Object.assign(value, {
        callCount: 0,
        lastReceiptSha256: null,
        modelOutputSha256: null,
        observedIdentitySha256: null,
      });
      value[field] = digest(99);
      expect(getModelInvocationSealIssues(value)).not.toEqual([]);
    },
  );

  it("requires a last receipt digest for every nonempty call sequence", () => {
    expect(
      getModelInvocationSealRequestIssues({ ...sealRequest(), lastReceiptSha256: null }),
    ).not.toEqual([]);
  });

  it.each([-1, 1.5, maximumModelInvocationCallCount + 1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid call count %s",
    (callCount) => {
      expect(getModelInvocationSealRequestIssues({ ...sealRequest(), callCount })).not.toEqual([]);
    },
  );

  it.each(["cancelled", "process_open", "relay_open"] as const)(
    "requires output to be absent when %s",
    (condition) => {
      const value = sealRequest();
      if (condition === "cancelled") value.state = "cancelled";
      if (condition === "process_open") value.processClosed = false;
      if (condition === "relay_open") value.relayClosed = false;
      expect(getModelInvocationSealRequestIssues(value)).not.toEqual([]);
      value.modelOutputSha256 = null;
      expect(getModelInvocationSealRequestIssues(value)).toEqual([]);
    },
  );

  it("does not disclose lease credentials in a seal response", () => {
    expect(getModelInvocationSealIssues({ ...seal(), lease: lease() })).not.toEqual([]);
  });
});

describe("exact timestamps without cross-host clock ordering", () => {
  it.each([
    "2024-02-29T12:00:00Z",
    "2026-09-08T12:00:00.1+08:00",
    "2026-09-08T12:00:00.12-08:00",
    now,
  ])("accepts %s", (time) => {
    expect(getModelInvocationOpeningIssues({ ...opening(), openedAt: time })).toEqual([]);
    expect(getModelInvocationSealRequestIssues({ ...sealRequest(), closedAt: time })).toEqual([]);
    expect(getModelInvocationSealIssues({ ...seal(), recordedAt: time })).toEqual([]);
    expect(getModelInvocationSubmissionIssues({ ...submission(), receivedAt: time })).toEqual([]);
  });

  it.each([
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-00-10T12:00:00Z",
    "2026-01-00T12:00:00Z",
    "2026-09-08T24:00:00Z",
    "2026-09-08T12:60:00Z",
    "2026-09-08T12:00:60Z",
    "2026-09-08T12:00:00.1234Z",
    "2026-09-08T12:00:00+24:00",
    "2026-09-08T12:00:00+00:60",
    "2026-09-08T12:00:00Z\n",
    "2026-09-08",
  ])("rejects %s", (time) => {
    expect(getModelInvocationOpeningIssues({ ...opening(), openedAt: time })).not.toEqual([]);
    expect(getModelInvocationSealRequestIssues({ ...sealRequest(), closedAt: time })).not.toEqual(
      [],
    );
    expect(getModelInvocationSealIssues({ ...seal(), recordedAt: time })).not.toEqual([]);
    expect(getModelInvocationSubmissionIssues({ ...submission(), receivedAt: time })).not.toEqual(
      [],
    );
  });

  it("permits the Worker closure clock to be ahead of the Server recording clock", () => {
    expect(
      getModelInvocationSealIssues({
        ...seal(),
        closedAt: "2030-01-01T00:00:00Z",
        recordedAt: "2020-01-01T00:00:00Z",
      }),
    ).toEqual([]);
  });
});

describe("submission consistency remains separate from execution acceptance", () => {
  it("cannot claim execution acceptance even when ledger consistency matches", () => {
    expect(
      getModelInvocationSubmissionIssues({ ...submission(), executionAccepted: true }),
    ).not.toEqual([]);
  });

  it.each(ModelInvocationConsistencyReasonSchema.anyOf.map((entry) => entry.const))(
    "allows the bounded diagnostic %s",
    (reason) => {
      expect(
        getModelInvocationConsistencyIssues({
          state: "invalid",
          reasons: [reason],
          observedIdentitySha256: null,
        }),
      ).toEqual([]);
    },
  );

  it.each(["invalid", "mismatched", "unavailable"] as const)("requires reasons for %s", (state) => {
    expect(
      getModelInvocationConsistencyIssues({ state, reasons: [], observedIdentitySha256: null }),
    ).not.toEqual([]);
  });

  it.each([
    { state: "matched", reasons: [], observedIdentitySha256: null },
    { state: "matched", reasons: ["OUTPUT_MISMATCH"], observedIdentitySha256: digest(9) },
    { state: "invalid", reasons: ["INVALID_RECEIPT_SET"], observedIdentitySha256: digest(9) },
    {
      state: "unavailable",
      reasons: ["OBSERVED_IDENTITY_MISSING"],
      observedIdentitySha256: digest(9),
    },
    {
      state: "unavailable",
      reasons: ["CLEANUP_UNCONFIRMED", "CLEANUP_UNCONFIRMED"],
      observedIdentitySha256: null,
    },
    { state: "invalid", reasons: ["UNRECOGNIZED_REASON"], observedIdentitySha256: null },
  ])("rejects inconsistent metadata $state/$reasons", (consistency) => {
    expect(getModelInvocationConsistencyIssues(consistency)).not.toEqual([]);
    expect(getModelInvocationSubmissionIssues({ ...submission(), consistency })).not.toEqual([]);
  });

  it("retains a known observed digest when cleanup remains unconfirmed", () => {
    const consistency: ModelInvocationConsistency = {
      state: "unavailable",
      reasons: ["CLEANUP_UNCONFIRMED"],
      observedIdentitySha256: digest(9),
    };
    expect(getModelInvocationSubmissionIssues({ ...submission(), consistency })).toEqual([]);
  });
});

describe("nested and aggregate byte budgets", () => {
  function atLedgerLimit(): ModelInvocationSubmitRequest {
    const value = submit();
    value.receiptSet = receiptSet(maximumModelInvocationCallCount);
    const set = value.receiptSet;
    const text = "界".repeat(1024);
    set.scope.requestedModel = text;
    required(set.observedIdentity).modelId = text;
    for (const { receipt } of set.calls) {
      receipt.requestedModel = text;
      required(receipt.response).modelId = text;
    }
    let remaining =
      maximumModelRuntimeUtf8Bytes - new TextEncoder().encode(JSON.stringify(set)).byteLength;
    if (remaining < 0) throw new Error("The synthetic fixture already exceeds its budget.");
    for (const { receipt } of set.calls) {
      const response = required(receipt.response);
      const original = required(response.responseId);
      const capacity = 1024 - original.length;
      const multibyte = Math.min(capacity, Math.floor(remaining / 3));
      remaining -= multibyte * 3;
      const ascii = Math.min(capacity - multibyte, remaining);
      remaining -= ascii;
      response.responseId = `${original}${"界".repeat(multibyte)}${"x".repeat(ascii)}`;
    }
    if (remaining !== 0) throw new Error("The synthetic fixture cannot fill its byte budget.");
    return value;
  }

  it("allows a full one MiB ledger with separate authenticated request overhead", () => {
    const value = atLedgerLimit();
    expect(maximumModelInvocationControlRequestUtf8Bytes).toBe(32 * 1024);
    expect(maximumModelInvocationSubmitRequestUtf8Bytes).toBe(
      maximumModelRuntimeUtf8Bytes + 32 * 1024,
    );
    expect(new TextEncoder().encode(JSON.stringify(value.receiptSet)).byteLength).toBe(
      maximumModelRuntimeUtf8Bytes,
    );
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(
      maximumModelRuntimeUtf8Bytes,
    );
    expect(getModelInvocationSubmitRequestIssues(value)).toEqual([]);
  });

  it("does not lend request overhead to an oversized ledger", () => {
    const value = atLedgerLimit();
    const response = required(required(value.receiptSet.calls.at(-1)).receipt.response);
    response.responseId = `${required(response.responseId)}x`;
    expect(new TextEncoder().encode(JSON.stringify(value.receiptSet)).byteLength).toBe(
      maximumModelRuntimeUtf8Bytes + 1,
    );
    expect(getModelInvocationSubmitRequestIssues(value)).not.toEqual([]);
  });

  it("refuses sparse or decorated receipt arrays", () => {
    const sparse = submit();
    sparse.receiptSet.calls.length = 2;
    expect(getModelInvocationSubmitRequestIssues(sparse)).not.toEqual([]);
    const decorated = submit();
    Object.defineProperty(decorated.receiptSet.calls, "ignored", { value: true, enumerable: true });
    expect(getModelInvocationSubmitRequestIssues(decorated)).not.toEqual([]);
  });
});
