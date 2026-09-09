import {
  getModelInvocationOpeningIssues,
  getModelInvocationReceiptSetIssues,
  getModelInvocationSealIssues,
  getModelRuntimeIdentityIssues,
  type ModelInvocationConsistency,
  type ModelInvocationConsistencyReason,
  type ModelInvocationOpening,
  type ModelInvocationReceiptSet,
  type ModelInvocationSealV1,
  type ModelRuntimeIdentityV1,
} from "@agentic-review/contracts";
import {
  modelInvocationScopeDigest,
  verifyModelInvocationReceiptSet,
} from "./model-runtime-verification.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function result(
  state: ModelInvocationConsistency["state"],
  reasons: readonly ModelInvocationConsistencyReason[],
  observedIdentitySha256: string | null = null,
): ModelInvocationConsistency {
  const value: ModelInvocationConsistency = {
    state,
    reasons: [...reasons],
    observedIdentitySha256,
  };
  Object.freeze(value.reasons);
  return Object.freeze(value);
}

export interface ModelInvocationSubmissionExpectation {
  /** Both records must have been authenticated, fenced and stored independently of this ledger. */
  readonly opening: ModelInvocationOpening;
  readonly seal: ModelInvocationSealV1;
  readonly receiptSet: unknown;
  readonly expectedIdentity: ModelRuntimeIdentityV1;
}

/**
 * Checks a ledger against an independently retained opening and seal. This function cannot
 * authenticate those inputs, prove process confinement, or accept a model-backed result.
 */
export function verifyModelInvocationSubmission(
  input: ModelInvocationSubmissionExpectation,
): ModelInvocationConsistency {
  const { opening, seal, receiptSet: supplied, expectedIdentity } = input;
  if (
    getModelInvocationOpeningIssues(opening).length > 0 ||
    getModelInvocationSealIssues(seal).length > 0 ||
    getModelRuntimeIdentityIssues(expectedIdentity).length > 0
  )
    return result("invalid", ["INVALID_EXPECTATION"]);
  if (
    modelInvocationScopeDigest(opening.scope) !== opening.scopeSha256 ||
    seal.invocationId !== opening.scope.invocationId ||
    seal.scopeSha256 !== opening.scopeSha256 ||
    Date.parse(seal.recordedAt) < Date.parse(opening.openedAt)
  )
    return result("invalid", ["INVALID_EXPECTATION"]);
  if (getModelInvocationReceiptSetIssues(supplied).length > 0)
    return result("invalid", ["INVALID_RECEIPT_SET"]);
  const set = supplied as ModelInvocationReceiptSet;
  if (canonical(set.scope) !== canonical(opening.scope))
    return result("mismatched", ["SCOPE_MISMATCH"]);
  if (canonical(set.runtime) !== canonical(opening.runtime))
    return result("invalid", ["RUNTIME_MEASUREMENT_MISMATCH"]);
  if (
    set.closedAt !== seal.closedAt ||
    set.state !== seal.state ||
    set.calls.length !== seal.callCount ||
    (set.calls.at(-1)?.sha256 ?? null) !== seal.lastReceiptSha256 ||
    set.modelOutputSha256 !== seal.modelOutputSha256 ||
    set.observedIdentitySha256 !== seal.observedIdentitySha256
  )
    return result("invalid", ["CLOSURE_METADATA_MISMATCH"]);

  const verified = verifyModelInvocationReceiptSet(set, {
    scope: opening.scope,
    identity: expectedIdentity,
    // A null sealed output has already required set.modelOutputSha256 to be null above.
    // The legacy verifier consequently returns OUTPUT_UNBOUND before comparing this sentinel.
    modelOutputSha256: seal.modelOutputSha256 ?? "0".repeat(64),
    receiptSetSha256: seal.receiptSetSha256,
  });
  if (verified.state === "invalid") return result(verified.state, verified.reasons);
  if (!seal.processClosed || !seal.relayClosed)
    return result(
      "unavailable",
      [...verified.reasons, "CLEANUP_UNCONFIRMED"],
      verified.observedIdentitySha256,
    );
  return result(verified.state, verified.reasons, verified.observedIdentitySha256);
}
