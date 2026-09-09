import { createHash } from "node:crypto";
import {
  type EvaluationModelRequirementsV1,
  getEvaluationModelRuntimeRegistrationIssues,
  getModelCallReceiptIssues,
  getModelInvocationReceiptSetIssues,
  getModelInvocationScopeIssues,
  getModelRuntimeIdentityIssues,
  getModelRuntimeRegistrationIssues,
  type ModelCallReceiptV1,
  type ModelInvocationConsistencyReason,
  type ModelInvocationReceiptSet,
  type ModelInvocationScope,
  type ModelRuntimeIdentityV1,
  type ModelRuntimeRegistrationV1,
} from "@agentic-review/contracts";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("Model metadata is not canonical JSON.");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/u;

export function modelRuntimeIdentityDigest(value: ModelRuntimeIdentityV1): string {
  if (getModelRuntimeIdentityIssues(value).length > 0)
    throw new TypeError("Model runtime identity is invalid.");
  return digest(value);
}
export function modelRuntimeRegistrationDigest(value: ModelRuntimeRegistrationV1): string {
  if (
    getModelRuntimeRegistrationIssues(value).length > 0 ||
    modelRuntimeIdentityDigest(value.identity) !== value.identitySha256
  )
    throw new TypeError("Model runtime registration is inconsistent.");
  return digest(value);
}

/** Checks frozen registration content, not current enablement, collector trust or execution. */
export function assertEvaluationModelRuntimeRegistrationIntegrity(
  requirements: EvaluationModelRequirementsV1,
  registration?: ModelRuntimeRegistrationV1,
): void {
  if (
    getEvaluationModelRuntimeRegistrationIssues(requirements, registration).length > 0 ||
    (registration !== undefined &&
      modelRuntimeRegistrationDigest(registration) !==
        requirements.runtimeRegistration?.registrationSha256)
  )
    throw new TypeError("The frozen model runtime registration is inconsistent.");
}
export function modelInvocationScopeDigest(value: ModelInvocationScope): string {
  if (getModelInvocationScopeIssues(value).length > 0)
    throw new TypeError("Model invocation scope is invalid.");
  return digest(value);
}
export function modelCallReceiptDigest(value: ModelCallReceiptV1): string {
  if (getModelCallReceiptIssues(value).length > 0)
    throw new TypeError("Model call receipt is invalid.");
  return digest(value);
}
export function modelInvocationReceiptSetDigest(value: ModelInvocationReceiptSet): string {
  if (getModelInvocationReceiptSetIssues(value).length > 0)
    throw new TypeError("Model invocation receipt set is invalid.");
  return digest(value);
}

export type ModelInvocationVerificationReason = ModelInvocationConsistencyReason;
export interface ModelInvocationExpectation {
  readonly scope: ModelInvocationScope;
  readonly identity: ModelRuntimeIdentityV1;
  readonly modelOutputSha256: string;
  /** Digest from an independently authenticated/fenced closure record, not the supplied blob. */
  readonly receiptSetSha256: string;
}
export interface ModelInvocationVerification {
  readonly state: "matched" | "unavailable" | "mismatched" | "invalid";
  readonly reasons: readonly ModelInvocationVerificationReason[];
  readonly observedIdentitySha256: string | null;
}

/**
 * Verifies hashes and frozen expectations only. Callers must independently authenticate the
 * collector, fence the attempt, validate runtime measurements and enforce the execution boundary.
 */
export function verifyModelInvocationReceiptSet(
  supplied: unknown,
  expected: ModelInvocationExpectation,
): ModelInvocationVerification {
  const result = (
    state: ModelInvocationVerification["state"],
    reasons: ModelInvocationVerificationReason[],
    observedIdentitySha256: string | null = null,
  ): ModelInvocationVerification =>
    Object.freeze({ state, reasons: Object.freeze(reasons), observedIdentitySha256 });
  if (
    getModelInvocationScopeIssues(expected.scope).length > 0 ||
    getModelRuntimeIdentityIssues(expected.identity).length > 0 ||
    !digestPattern.test(expected.modelOutputSha256) ||
    !digestPattern.test(expected.receiptSetSha256) ||
    expected.scope.expectedModelIdentitySha256 !== digest(expected.identity)
  )
    return result("invalid", ["INVALID_EXPECTATION"]);
  if (getModelInvocationReceiptSetIssues(supplied).length > 0)
    return result("invalid", ["INVALID_RECEIPT_SET"]);
  const set = supplied as ModelInvocationReceiptSet;
  const integrity: ModelInvocationVerificationReason[] = [];
  if (digest(set) !== expected.receiptSetSha256) integrity.push("CLOSURE_SEAL_MISMATCH");
  if (digest(set.scope) !== set.scopeSha256) integrity.push("SCOPE_DIGEST_MISMATCH");
  if (set.calls.some(({ receipt, sha256 }) => digest(receipt) !== sha256))
    integrity.push("RECEIPT_DIGEST_MISMATCH");
  if (set.observedIdentity !== null && digest(set.observedIdentity) !== set.observedIdentitySha256)
    integrity.push("IDENTITY_DIGEST_MISMATCH");
  if (
    set.calls.some(({ receipt }, index) => {
      const previous = set.calls[index - 1]?.receipt;
      return (
        previous !== undefined && Date.parse(receipt.startedAt) < Date.parse(previous.finishedAt)
      );
    })
  )
    integrity.push("CALL_TIME_ORDER_INVALID");
  if (integrity.length > 0) return result("invalid", integrity);
  if (canonical(set.scope) !== canonical(expected.scope))
    return result("mismatched", ["SCOPE_MISMATCH"]);

  const unavailable: ModelInvocationVerificationReason[] = [];
  if (set.state !== "closed") unavailable.push("INVOCATION_CANCELLED");
  if (
    set.calls.length === 0 ||
    set.calls.some(
      ({ receipt }) =>
        receipt.outcome !== "completed" ||
        receipt.response?.outcome !== "completed" ||
        !receipt.response.transportComplete,
    )
  )
    unavailable.push("CALL_CHAIN_INCOMPLETE");
  if (set.observedIdentity === null) unavailable.push("OBSERVED_IDENTITY_MISSING");
  if (set.modelOutputSha256 === null) unavailable.push("OUTPUT_UNBOUND");
  if (unavailable.length > 0) return result("unavailable", unavailable, set.observedIdentitySha256);

  const mismatches: ModelInvocationVerificationReason[] = [];
  if (set.observedIdentitySha256 !== expected.scope.expectedModelIdentitySha256)
    mismatches.push("RUNTIME_IDENTITY_MISMATCH");
  if (set.modelOutputSha256 !== expected.modelOutputSha256) mismatches.push("OUTPUT_MISMATCH");
  if (mismatches.length > 0) return result("mismatched", mismatches, set.observedIdentitySha256);
  return result("matched", [], set.observedIdentitySha256);
}
