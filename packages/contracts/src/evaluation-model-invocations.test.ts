import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  type EvaluationCellInvocationCallOutcomes,
  type EvaluationCellInvocationItem,
  EvaluationCellInvocationListQuerySchema,
  type EvaluationCellInvocationListV1,
  EvaluationCellInvocationListV1Schema,
  getEvaluationCellInvocationListIssues,
  getEvaluationCellInvocationListQueryIssues,
  maximumEvaluationCellInvocationListUtf8Bytes,
  maximumEvaluationCellInvocationPageSize,
} from "./evaluation-model-invocations.js";
import type { ModelRuntimeRegistrationV1 } from "./model-runtime-registry.js";

// These synthetic digests exercise consistency without claiming authenticated execution.
const digest = (value: number) => value.toString(16).padStart(64, "0");
const openedAt = "2026-09-08T12:00:00.000Z";
const recordedAt = "2026-09-08T12:00:01.000Z";
const receivedAt = "2026-09-08T12:00:02.000Z";
const sampledAt = "2026-09-08T12:00:03.000Z";
function registration(): ModelRuntimeRegistrationV1 {
  return {
    schemaVersion: "ModelRuntimeRegistrationV1",
    id: "registration-1",
    name: "Synthetic expected runtime",
    requestedModel: "synthetic-requested-model",
    identitySha256: digest(1),
    createdAt: "2026-09-08T11:00:00.000Z",
    createdBy: { issuer: "https://synthetic.example.test", subject: "synthetic-administrator" },
    identity: {
      schemaVersion: "ModelRuntimeIdentityV1",
      providerId: "synthetic-provider",
      endpointSha256: digest(2),
      modelId: "synthetic-observed-model",
      client: {
        kind: "codex_cli",
        version: "synthetic-version",
        executableSha256: digest(3),
        launchPolicySha256: digest(4),
      },
      relay: { implementationSha256: digest(5), policySha256: digest(6) },
    },
  };
}
const outcomes = (): EvaluationCellInvocationCallOutcomes => ({
  completed: 1,
  provider_failed: 0,
  provider_incomplete: 0,
  transport_failed: 0,
  cancelled: 0,
  protocol_invalid: 0,
  budget_exceeded: 0,
});
function item(id = "invocation-1"): EvaluationCellInvocationItem {
  const expected = registration();
  const { schemaVersion: _schema, modelId: _model, ...runtime } = expected.identity;
  return {
    opening: {
      schemaVersion: "ModelInvocationOpeningV1",
      scope: {
        schemaVersion: "ModelInvocationScopeV1",
        repositoryId: "repository-1",
        evaluationId: "evaluation-1",
        cellId: "cell-1",
        runId: "run-1",
        requestId: "request-1",
        jobId: "job-1",
        attemptId: `attempt-${id}`,
        invocationId: id,
        authorizationId: "authorization-1",
        executionManifestSha256: digest(7),
        promptSha256: digest(8),
        outputSchemaSha256: digest(9),
        expectedModelIdentitySha256: expected.identitySha256,
        requestedModel: expected.requestedModel,
        workerNodeId: "worker-1",
        workerInstanceId: "instance-1",
        leaseGeneration: 1,
      },
      scopeSha256: digest(10),
      runtime,
      openedAt,
    },
    seal: {
      schemaVersion: "ModelInvocationSealV1",
      invocationId: id,
      scopeSha256: digest(10),
      receiptSetSha256: digest(11),
      closedAt: "2030-01-01T00:00:00.000Z",
      state: "closed",
      callCount: 1,
      lastReceiptSha256: digest(12),
      modelOutputSha256: digest(13),
      observedIdentitySha256: expected.identitySha256,
      processClosed: true,
      relayClosed: true,
      recordedAt,
    },
    submission: {
      schemaVersion: "ModelInvocationSubmissionV1",
      invocationId: id,
      scopeSha256: digest(10),
      receiptSetSha256: digest(11),
      receivedAt,
      consistency: {
        state: "matched",
        reasons: [],
        observedIdentitySha256: expected.identitySha256,
      },
      executionAccepted: false,
    },
    observedIdentity: structuredClone(expected.identity),
    callOutcomes: outcomes(),
  };
}
function list(items: EvaluationCellInvocationItem[] = [item()]): EvaluationCellInvocationListV1 {
  return {
    schemaVersion: "EvaluationCellInvocationListV1",
    repositoryId: "repository-1",
    evaluationId: "evaluation-1",
    cellId: "cell-1",
    expectedRuntimeRegistration: registration(),
    page: 1,
    pageSize: 10,
    total: items.length,
    sampledAt,
    items,
  };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The synthetic fixture entry is absent.");
  return value;
}

describe("bounded invocation diagnostics query", () => {
  it.each([{}, { page: 1 }, { pageSize: 10 }, { page: 2, pageSize: 3 }])(
    "accepts %j without adding server defaults",
    (value) => {
      const before = JSON.stringify(value);
      expect(Value.Check(EvaluationCellInvocationListQuerySchema, value)).toBe(true);
      expect(getEvaluationCellInvocationListQueryIssues(value)).toEqual([]);
      expect(JSON.stringify(value)).toBe(before);
    },
  );
  it.each([
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { page: Number.MAX_SAFE_INTEGER },
    { pageSize: 0 },
    { pageSize: 11 },
    { pageSize: 1.5 },
    { page: "1" },
    { page: undefined },
    { sort: "oldest" },
  ])("rejects %j", (value) => {
    expect(getEvaluationCellInvocationListQueryIssues(value)).not.toEqual([]);
  });
  it("rejects query accessors without evaluating them", () => {
    let accessed = 0;
    const value = Object.defineProperty({}, "page", {
      enumerable: true,
      get() {
        accessed++;
        return 1;
      },
    });
    expect(getEvaluationCellInvocationListQueryIssues(value)).not.toEqual([]);
    expect(accessed).toBe(0);
  });
});

describe("honest collection stages", () => {
  it.each(["opening", "sealed", "submitted"] as const)(
    "accepts the %s stage without changing source objects",
    (stage) => {
      const value = list();
      const entry = required(value.items[0]);
      if (stage !== "submitted") {
        entry.submission = null;
        entry.callOutcomes = null;
        entry.observedIdentity = null;
      }
      if (stage === "opening") entry.seal = null;
      const before = JSON.stringify(value);
      expect(Value.Check(EvaluationCellInvocationListV1Schema, value)).toBe(true);
      expect(getEvaluationCellInvocationListIssues(value)).toEqual([]);
      expect(JSON.stringify(value)).toBe(before);
      expect(value.items[0]?.submission?.executionAccepted ?? false).toBe(false);
    },
  );
  it("allows an empty list without a model registration", () => {
    expect(
      getEvaluationCellInvocationListIssues({ ...list([]), expectedRuntimeRegistration: null }),
    ).toEqual([]);
  });
  it("represents a genuinely empty submitted collection as unavailable", () => {
    const value = list(),
      entry = required(value.items[0]),
      seal = required(entry.seal);
    Object.assign(seal, {
      callCount: 0,
      lastReceiptSha256: null,
      modelOutputSha256: null,
      observedIdentitySha256: null,
    });
    required(entry.callOutcomes).completed = 0;
    entry.observedIdentity = null;
    required(entry.submission).consistency = {
      state: "unavailable",
      reasons: ["CALL_CHAIN_INCOMPLETE", "OBSERVED_IDENTITY_MISSING", "OUTPUT_UNBOUND"],
      observedIdentitySha256: null,
    };
    expect(getEvaluationCellInvocationListIssues(value)).toEqual([]);
  });
  it.each(["cancelled", "process_open", "relay_open", "failed_call"] as const)(
    "preserves %s as unavailable",
    (condition) => {
      const value = list(),
        entry = required(value.items[0]),
        seal = required(entry.seal);
      seal.modelOutputSha256 = null;
      const consistency = required(entry.submission).consistency;
      consistency.state = "unavailable";
      consistency.reasons = ["OUTPUT_UNBOUND"];
      if (condition === "cancelled") {
        seal.state = "cancelled";
        consistency.reasons.push("INVOCATION_CANCELLED");
      }
      if (condition === "process_open") {
        seal.processClosed = false;
        consistency.reasons.push("CLEANUP_UNCONFIRMED");
      }
      if (condition === "relay_open") {
        seal.relayClosed = false;
        consistency.reasons.push("CLEANUP_UNCONFIRMED");
      }
      if (condition === "failed_call") {
        required(entry.callOutcomes).completed = 0;
        required(entry.callOutcomes).provider_failed = 1;
        consistency.reasons.push("CALL_CHAIN_INCOMPLETE");
      }
      expect(getEvaluationCellInvocationListIssues(value)).toEqual([]);
    },
  );
  it("preserves invalid diagnostics even when declared seal metadata has an observed digest", () => {
    const value = list();
    required(required(value.items[0]).submission).consistency = {
      state: "invalid",
      reasons: ["RECEIPT_DIGEST_MISMATCH"],
      observedIdentitySha256: null,
    };
    required(value.items[0]).observedIdentity = null;
    expect(getEvaluationCellInvocationListIssues(value)).toEqual([]);
  });
  it("retains a reported runtime mismatch instead of hiding the diagnostic record", () => {
    const value = list(),
      entry = required(value.items[0]);
    entry.opening.runtime.providerId = "different-observed-provider";
    required(entry.observedIdentity).providerId = "different-observed-provider";
    required(entry.seal).observedIdentitySha256 = digest(99);
    required(entry.submission).consistency = {
      state: "mismatched",
      reasons: ["RUNTIME_IDENTITY_MISMATCH"],
      observedIdentitySha256: digest(99),
    };
    expect(getEvaluationCellInvocationListIssues(value)).toEqual([]);
  });
});

describe("scope, expected registration and independently recorded references", () => {
  it.each(["repositoryId", "evaluationId", "cellId"] as const)(
    "rejects opening from another %s",
    (field) => {
      const value = list();
      required(value.items[0]).opening.scope[field] = "another-scope";
      expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
    },
  );
  it.each(["missing", "expected_digest", "requested_model"] as const)(
    "rejects %s registration binding",
    (condition) => {
      const value = list();
      if (condition === "missing") value.expectedRuntimeRegistration = null;
      if (condition === "expected_digest")
        required(value.items[0]).opening.scope.expectedModelIdentitySha256 = digest(99);
      if (condition === "requested_model")
        required(value.items[0]).opening.scope.requestedModel = "another-model";
      expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
    },
  );
  it.each([
    "seal_identity",
    "seal_scope",
    "submission_identity",
    "submission_scope",
    "submission_ledger",
    "submission_observed",
  ] as const)("rejects a mismatched %s", (field) => {
    const value = list(),
      entry = required(value.items[0]);
    if (field === "seal_identity") required(entry.seal).invocationId = "another-invocation";
    if (field === "seal_scope") required(entry.seal).scopeSha256 = digest(99);
    if (field === "submission_identity")
      required(entry.submission).invocationId = "another-invocation";
    if (field === "submission_scope") required(entry.submission).scopeSha256 = digest(99);
    if (field === "submission_ledger") required(entry.submission).receiptSetSha256 = digest(99);
    if (field === "submission_observed")
      required(entry.submission).consistency.observedIdentitySha256 = digest(99);
    expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
  });
  it.each(["no_seal", "no_submission", "no_counts"] as const)(
    "rejects %s with dependent metadata",
    (condition) => {
      const value = list(),
        entry = required(value.items[0]);
      if (condition === "no_seal") entry.seal = null;
      if (condition === "no_submission") entry.submission = null;
      if (condition === "no_counts") entry.callOutcomes = null;
      expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
    },
  );
  it.each([
    "missing",
    "invalid_submission",
    "runtime_mismatch",
    "model_mismatch",
    "missing_digest",
  ] as const)("rejects observed identity %s", (condition) => {
    const value = list(),
      entry = required(value.items[0]);
    if (condition === "missing") entry.observedIdentity = null;
    if (condition === "invalid_submission")
      required(entry.submission).consistency = {
        state: "invalid",
        reasons: ["INVALID_RECEIPT_SET"],
        observedIdentitySha256: null,
      };
    if (condition === "runtime_mismatch")
      required(entry.observedIdentity).client.version = "another-client";
    if (condition === "model_mismatch") required(entry.observedIdentity).modelId = "another-model";
    if (condition === "missing_digest") {
      required(entry.seal).observedIdentitySha256 = null;
      required(entry.submission).consistency = {
        state: "unavailable",
        reasons: ["OBSERVED_IDENTITY_MISSING"],
        observedIdentitySha256: null,
      };
    }
    expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
  });
});

describe("sealed counts and matching collection claims", () => {
  it.each(Object.keys(outcomes()) as (keyof EvaluationCellInvocationCallOutcomes)[])(
    "rejects impossible %s counters",
    (key) => {
      for (const count of [-1, 1.5, 129, Number.MAX_SAFE_INTEGER + 1]) {
        const value = list();
        required(required(value.items[0]).callOutcomes)[key] = count;
        expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
      }
    },
  );
  it("requires counts to sum to the independent seal", () => {
    const value = list();
    required(required(value.items[0]).callOutcomes).completed = 2;
    expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
  });
  it.each([
    "cancelled",
    "process_open",
    "relay_open",
    "no_output",
    "failure",
    "different_identity",
    "different_runtime",
  ] as const)("never accepts matched with %s", (condition) => {
    const value = list(),
      entry = required(value.items[0]),
      seal = required(entry.seal);
    if (condition === "cancelled") {
      seal.state = "cancelled";
      seal.modelOutputSha256 = null;
    }
    if (condition === "process_open") {
      seal.processClosed = false;
      seal.modelOutputSha256 = null;
    }
    if (condition === "relay_open") {
      seal.relayClosed = false;
      seal.modelOutputSha256 = null;
    }
    if (condition === "no_output") seal.modelOutputSha256 = null;
    if (condition === "failure") {
      required(entry.callOutcomes).completed = 0;
      required(entry.callOutcomes).transport_failed = 1;
    }
    if (condition === "different_identity") {
      seal.observedIdentitySha256 = digest(99);
      required(entry.submission).consistency.observedIdentitySha256 = digest(99);
    }
    if (condition === "different_runtime") entry.opening.runtime.client.version = "another-client";
    expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
  });
  it("cannot claim execution acceptance or expose a raw ledger/lease", () => {
    const value = list();
    expect(
      getEvaluationCellInvocationListIssues({ ...value, leaseToken: "not-permitted" }),
    ).not.toEqual([]);
    expect(
      getEvaluationCellInvocationListIssues({ ...value, items: [{ ...item(), receiptSet: {} }] }),
    ).not.toEqual([]);
    Object.assign(required(required(value.items[0]).submission), { executionAccepted: true });
    expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
  });
});

describe("ordered complete bounded pages", () => {
  it("allows descending equal-time identities and an exact later page", () => {
    const value = list([item("invocation-b"), item("invocation-a")]);
    expect(getEvaluationCellInvocationListIssues(value)).toEqual([]);
    expect(
      getEvaluationCellInvocationListIssues({ ...value, page: 2, pageSize: 2, total: 4 }),
    ).toEqual([]);
    expect(
      getEvaluationCellInvocationListIssues({ ...list([]), page: 3, pageSize: 2, total: 4 }),
    ).toEqual([]);
  });
  it("sorts equivalent offset timestamps by invocation identity", () => {
    const value = list([item("invocation-b"), item("invocation-a")]);
    required(value.items[1]).opening.openedAt = "2026-09-08T20:00:00+08:00";
    expect(getEvaluationCellInvocationListIssues(value)).toEqual([]);
  });
  it.each(["wrong_time", "wrong_identity", "duplicate_invocation", "duplicate_attempt"] as const)(
    "rejects %s ordering",
    (condition) => {
      const value = list([item("invocation-b"), item("invocation-a")]);
      const second = required(value.items[1]);
      if (condition === "wrong_time") second.opening.openedAt = recordedAt;
      if (condition === "wrong_identity") value.items.reverse();
      if (condition === "duplicate_invocation")
        value.items[1] = structuredClone(required(value.items[0]));
      if (condition === "duplicate_attempt")
        second.opening.scope.attemptId = required(value.items[0]).opening.scope.attemptId;
      expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
    },
  );
  it.each([
    { total: 0 },
    { total: 2 },
    { total: -1 },
    { page: 0 },
    { pageSize: 11 },
    { page: Number.MAX_SAFE_INTEGER },
    { total: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects inconsistent pagination %j", (change) => {
    expect(getEvaluationCellInvocationListIssues({ ...list(), ...change })).not.toEqual([]);
  });
  it("rejects more than ten items and retains the two MiB aggregate limit", () => {
    expect(maximumEvaluationCellInvocationPageSize).toBe(10);
    expect(maximumEvaluationCellInvocationListUtf8Bytes).toBe(2 * 1024 * 1024);
    expect(
      getEvaluationCellInvocationListIssues(
        list(Array.from({ length: 11 }, (_, index) => item(`invocation-${index}`))),
      ),
    ).not.toEqual([]);
    const value = list();
    required(value.items[0]).opening.runtime.providerId = "x".repeat(
      maximumEvaluationCellInvocationListUtf8Bytes + 1,
    );
    expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
  });
});

describe("Server timestamps and strict JSON", () => {
  it.each([
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-09-08T12:00:03.1234Z",
    "2026-09-08T12:00:03Z\n",
  ])("rejects invalid sampledAt %s", (time) => {
    expect(getEvaluationCellInvocationListIssues({ ...list(), sampledAt: time })).not.toEqual([]);
  });
  it.each([
    "future_opening",
    "early_seal",
    "future_seal",
    "early_submission",
    "future_submission",
  ] as const)("rejects %s", (condition) => {
    const value = list(),
      entry = required(value.items[0]);
    const future = "2026-09-08T12:00:04.000Z";
    if (condition === "future_opening") entry.opening.openedAt = future;
    if (condition === "early_seal") required(entry.seal).recordedAt = "2026-09-08T11:59:59.000Z";
    if (condition === "future_seal") required(entry.seal).recordedAt = future;
    if (condition === "early_submission") required(entry.submission).receivedAt = openedAt;
    if (condition === "future_submission") required(entry.submission).receivedAt = future;
    expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
  });
  it("never compares the independent Worker closure clock with Server timestamps", () => {
    const value = list();
    required(required(value.items[0]).seal).closedAt = "2020-01-01T00:00:00Z";
    expect(getEvaluationCellInvocationListIssues(value)).toEqual([]);
  });
  it.each(["runtime", "array_index", "array_prototype"] as const)(
    "refuses %s getters without invoking them",
    (location) => {
      const value = list();
      let accessed = 0;
      const get = () => {
        accessed++;
        throw new Error("The getter must never execute.");
      };
      if (location === "runtime")
        Object.defineProperty(required(value.items[0]).opening.runtime, "providerId", {
          enumerable: true,
          get,
        });
      if (location === "array_index")
        Object.defineProperty(value.items, "0", { enumerable: true, get });
      if (location === "array_prototype") {
        const prototype = Object.create(Array.prototype);
        Object.defineProperty(prototype, "toJSON", { get });
        Object.setPrototypeOf(value.items, prototype);
      }
      expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
      expect(accessed).toBe(0);
    },
  );
  it.each(["\ud800", "text\u202ehidden", "leading ", "a\u2028b"])(
    "rejects malformed or ambiguous text %s",
    (text) => {
      const value = list();
      required(value.items[0]).opening.runtime.providerId = text;
      expect(getEvaluationCellInvocationListIssues(value)).not.toEqual([]);
    },
  );
  it("rejects sparse/decorated arrays, symbols, hidden fields and cycles", () => {
    const sparse = list();
    sparse.items.length = 2;
    expect(getEvaluationCellInvocationListIssues(sparse)).not.toEqual([]);
    const decorated = list();
    Object.assign(decorated.items, { extra: true });
    expect(getEvaluationCellInvocationListIssues(decorated)).not.toEqual([]);
    expect(
      getEvaluationCellInvocationListIssues({ ...list(), [Symbol("hidden")]: true }),
    ).not.toEqual([]);
    const hidden = list();
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(getEvaluationCellInvocationListIssues(hidden)).not.toEqual([]);
    const cycle = { ...list(), extra: {} };
    cycle.extra = cycle;
    expect(getEvaluationCellInvocationListIssues(cycle)).not.toEqual([]);
  });
});
