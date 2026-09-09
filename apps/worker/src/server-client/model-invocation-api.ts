import { types } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  type FreezeValidationSummaryInputRequest,
  type FreezeValidationSummaryInputResponse,
  getFreezeValidationSummaryInputRequestIssues,
  getFreezeValidationSummaryInputResponseIssues,
  getModelInvocationBeginRequestIssues,
  getModelInvocationOpeningIssues,
  getModelInvocationSealIssues,
  getModelInvocationSealRequestIssues,
  getModelInvocationSubmissionIssues,
  getModelInvocationSubmitRequestIssues,
  type ModelInvocationBeginRequest,
  type ModelInvocationOpening,
  type ModelInvocationSealRequest,
  type ModelInvocationSealV1,
  type ModelInvocationSubmissionV1,
  type ModelInvocationSubmitRequest,
  maximumFreezeValidationSummaryInputRequestUtf8Bytes,
  maximumModelInvocationControlRequestUtf8Bytes,
  maximumModelInvocationSubmitRequestUtf8Bytes,
} from "@agentic-review/contracts";
import {
  modelCallReceiptDigest,
  modelInvocationReceiptSetDigest,
  modelInvocationScopeDigest,
  modelRuntimeIdentityDigest,
} from "@agentic-review/domain";
import { ProtocolError } from "./errors.js";

/** Independent from lease polling so callers opt into receipt collection explicitly. */
export interface ModelInvocationApi {
  beginModelInvocation(
    request: ModelInvocationBeginRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationOpening>;
  sealModelInvocation(
    request: ModelInvocationSealRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationSealV1>;
  submitModelInvocationReceipts(
    request: ModelInvocationSubmitRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationSubmissionV1>;
}

/** Input freezing is separate from opening a model invocation and cannot authorize execution. */
export interface ModelSummaryInputApi {
  freezeValidationSummaryInput(
    request: FreezeValidationSummaryInputRequest,
    signal?: AbortSignal,
  ): Promise<FreezeValidationSummaryInputResponse>;
}

export interface ModelInvocationRequestSnapshot<T> {
  readonly value: T;
  readonly serialized: Buffer;
}

function assertPassiveJson(value: unknown, parents = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (types.isProxy(value) || parents.has(value) || parents.size > 64) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== null &&
    prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype)
  )
    throw new Error();
  parents.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new Error();
    assertPassiveJson(descriptor.value, parents);
  }
  parents.delete(value);
}

function snapshot<T>(
  request: T,
  issues: (value: unknown) => string[],
  maximumBytes: number,
): ModelInvocationRequestSnapshot<T> {
  // Contract validation rejects getters, cycles, exotic objects and lossy JSON values before
  // serialization. Both the route and all later comparisons use this synchronous private copy.
  try {
    // Reject custom array prototypes before contract validation can stringify inherited toJSON.
    assertPassiveJson(request);
    if (issues(request).length > 0) throw new Error();
    const serialized = Buffer.from(JSON.stringify(request), "utf8");
    if (serialized.byteLength > maximumBytes) throw new Error();
    const value = JSON.parse(serialized.toString("utf8")) as T;
    if (issues(value).length > 0) throw new Error();
    return { value, serialized };
  } catch {
    throw new ProtocolError("Model invocation request is invalid.");
  }
}

export function snapshotModelInvocationBeginRequest(
  request: ModelInvocationBeginRequest,
): ModelInvocationRequestSnapshot<ModelInvocationBeginRequest> {
  return snapshot(
    request,
    getModelInvocationBeginRequestIssues,
    maximumModelInvocationControlRequestUtf8Bytes,
  );
}

export function snapshotFreezeValidationSummaryInputRequest(
  request: FreezeValidationSummaryInputRequest,
): ModelInvocationRequestSnapshot<FreezeValidationSummaryInputRequest> {
  return snapshot(
    request,
    getFreezeValidationSummaryInputRequestIssues,
    maximumFreezeValidationSummaryInputRequestUtf8Bytes,
  );
}

export function parseFreezeValidationSummaryInputResponse(
  value: unknown,
  request: FreezeValidationSummaryInputRequest,
): FreezeValidationSummaryInputResponse {
  assertResponse(
    value,
    getFreezeValidationSummaryInputResponseIssues,
    "Worker API returned an invalid summary input receipt.",
  );
  const receipt = value as FreezeValidationSummaryInputResponse;
  if (
    receipt.reference.inputId !== request.inputId ||
    receipt.reference.contextSha256 !== createCanonicalResult(request.context).sha256
  )
    throw new ProtocolError("Worker API returned a summary input receipt for different input.");
  // The parent additionally reconstructs the document from its frozen envelope and this timestamp.
  // The receipt alone neither verifies those Server-owned fields nor accepts a model execution.
  return structuredClone(receipt);
}

export function snapshotModelInvocationSealRequest(
  request: ModelInvocationSealRequest,
): ModelInvocationRequestSnapshot<ModelInvocationSealRequest> {
  return snapshot(
    request,
    getModelInvocationSealRequestIssues,
    maximumModelInvocationControlRequestUtf8Bytes,
  );
}

export function snapshotModelInvocationSubmitRequest(
  request: ModelInvocationSubmitRequest,
): ModelInvocationRequestSnapshot<ModelInvocationSubmitRequest> {
  const copy = snapshot(
    request,
    getModelInvocationSubmitRequestIssues,
    maximumModelInvocationSubmitRequestUtf8Bytes,
  );
  const set = copy.value.receiptSet;
  if (
    modelInvocationScopeDigest(set.scope) !== set.scopeSha256 ||
    set.calls.some(({ receipt, sha256 }) => modelCallReceiptDigest(receipt) !== sha256) ||
    (set.observedIdentity !== null &&
      modelRuntimeIdentityDigest(set.observedIdentity) !== set.observedIdentitySha256)
  )
    throw new ProtocolError("Model invocation receipt digests are inconsistent.");
  return copy;
}

function equalJson(left: unknown, right: unknown): boolean {
  return createCanonicalResult(left).json === createCanonicalResult(right).json;
}

function assertResponse(
  value: unknown,
  issues: (value: unknown) => string[],
  message: string,
): void {
  try {
    assertPassiveJson(value);
    if (issues(value).length > 0) throw new Error();
  } catch {
    throw new ProtocolError(message);
  }
}

export function parseModelInvocationOpening(
  value: unknown,
  request: ModelInvocationBeginRequest,
): ModelInvocationOpening {
  assertResponse(
    value,
    getModelInvocationOpeningIssues,
    "Worker API returned an invalid model invocation opening.",
  );
  const opening = value as ModelInvocationOpening;
  const scope = opening.scope;
  if (
    (request.summaryInput === undefined
      ? opening.schemaVersion !== "ModelInvocationOpeningV1"
      : opening.schemaVersion !== "ModelInvocationOpeningV2" ||
        !equalJson(opening.scope.inputRef, request.summaryInput)) ||
    scope.invocationId !== request.invocationId ||
    scope.jobId !== request.lease.jobId ||
    scope.attemptId !== request.lease.runAttemptId ||
    scope.workerNodeId !== request.lease.workerNodeId ||
    scope.workerInstanceId !== request.lease.workerInstanceId ||
    scope.leaseGeneration !== request.lease.leaseGeneration ||
    opening.scopeSha256 !== modelInvocationScopeDigest(scope) ||
    !equalJson(opening.runtime, request.runtime)
  )
    throw new ProtocolError("Worker API returned an inconsistent model invocation opening.");
  // The coordinator additionally compares Server-owned scope fields with the frozen execution
  // plan. Those fields are deliberately absent from the Worker opening request.
  return opening;
}

export function parseModelInvocationSeal(
  value: unknown,
  request: ModelInvocationSealRequest,
): ModelInvocationSealV1 {
  assertResponse(
    value,
    getModelInvocationSealIssues,
    "Worker API returned an invalid model invocation seal.",
  );
  const seal = value as ModelInvocationSealV1;
  const { lease: _lease, ...expected } = request;
  const { schemaVersion: _schemaVersion, recordedAt: _recordedAt, ...actual } = seal;
  if (!equalJson(actual, expected))
    throw new ProtocolError("Worker API returned an inconsistent model invocation seal.");
  return seal;
}

export function parseModelInvocationSubmission(
  value: unknown,
  request: ModelInvocationSubmitRequest,
): ModelInvocationSubmissionV1 {
  assertResponse(
    value,
    getModelInvocationSubmissionIssues,
    "Worker API returned an invalid model invocation submission.",
  );
  const submission = value as ModelInvocationSubmissionV1;
  if (
    submission.invocationId !== request.invocationId ||
    submission.scopeSha256 !== modelInvocationScopeDigest(request.receiptSet.scope) ||
    submission.receiptSetSha256 !== modelInvocationReceiptSetDigest(request.receiptSet) ||
    (submission.consistency.observedIdentitySha256 !== null &&
      submission.consistency.observedIdentitySha256 !== request.receiptSet.observedIdentitySha256)
  )
    throw new ProtocolError("Worker API returned an inconsistent model invocation submission.");
  return submission;
}
