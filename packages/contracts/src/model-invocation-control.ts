import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Sha256Schema } from "./common.js";
import {
  getModelInvocationReceiptSetIssues,
  getModelInvocationScopeIssues,
  ModelInvocationReceiptSetSchema,
  ModelInvocationReceiptSetV1Schema,
  ModelInvocationScopeV1Schema,
  ModelInvocationScopeV2Schema,
  maximumModelInvocationCallCount,
  maximumModelRuntimeUtf8Bytes,
} from "./model-runtime.js";
import { ValidationSummaryInputReferenceV1Schema } from "./model-summary-input-reference.js";
import { LeaseIdentitySchema } from "./worker.js";

export const maximumModelInvocationControlRequestUtf8Bytes = 32 * 1024;
export const maximumModelInvocationSubmitRequestUtf8Bytes =
  maximumModelRuntimeUtf8Bytes + maximumModelInvocationControlRequestUtf8Bytes;

const strict = { additionalProperties: false } as const;
const invocationId = ModelInvocationScopeV1Schema.properties.invocationId;
const runtime = ModelInvocationReceiptSetV1Schema.properties.runtime;
const nullableDigest = Type.Union([Sha256Schema, Type.Null()]);
const dateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))(?![\s\S])/u;
const timestamp = Type.String({ pattern: dateTimePattern.source, minLength: 20, maxLength: 64 });

export const ModelInvocationBeginRequestSchema = Type.Object(
  {
    lease: LeaseIdentitySchema,
    invocationId,
    runtime,
    summaryInput: Type.Optional(ValidationSummaryInputReferenceV1Schema),
  },
  strict,
);
export type ModelInvocationBeginRequest = Static<typeof ModelInvocationBeginRequestSchema>;

export const ModelInvocationOpeningV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelInvocationOpeningV1"),
    scope: ModelInvocationScopeV1Schema,
    scopeSha256: Sha256Schema,
    runtime,
    openedAt: timestamp,
  },
  strict,
);
export type ModelInvocationOpeningV1 = Static<typeof ModelInvocationOpeningV1Schema>;

export const ModelInvocationOpeningV2Schema = Type.Object(
  {
    ...ModelInvocationOpeningV1Schema.properties,
    schemaVersion: Type.Literal("ModelInvocationOpeningV2"),
    scope: ModelInvocationScopeV2Schema,
  },
  strict,
);
export type ModelInvocationOpeningV2 = Static<typeof ModelInvocationOpeningV2Schema>;
export const ModelInvocationOpeningSchema = Type.Union([
  ModelInvocationOpeningV1Schema,
  ModelInvocationOpeningV2Schema,
]);
export type ModelInvocationOpening = Static<typeof ModelInvocationOpeningSchema>;

const closureProperties = {
  invocationId,
  scopeSha256: Sha256Schema,
  receiptSetSha256: Sha256Schema,
  closedAt: timestamp,
  state: Type.Union([Type.Literal("closed"), Type.Literal("cancelled")]),
  callCount: Type.Integer({ minimum: 0, maximum: maximumModelInvocationCallCount }),
  lastReceiptSha256: nullableDigest,
  modelOutputSha256: nullableDigest,
  observedIdentitySha256: nullableDigest,
  processClosed: Type.Boolean(),
  relayClosed: Type.Boolean(),
};
export const ModelInvocationSealRequestSchema = Type.Object(
  { lease: LeaseIdentitySchema, ...closureProperties },
  strict,
);
export type ModelInvocationSealRequest = Static<typeof ModelInvocationSealRequestSchema>;

export const ModelInvocationSealV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelInvocationSealV1"),
    ...closureProperties,
    recordedAt: timestamp,
  },
  strict,
);
export type ModelInvocationSealV1 = Static<typeof ModelInvocationSealV1Schema>;

export const ModelInvocationSubmitRequestSchema = Type.Object(
  { lease: LeaseIdentitySchema, invocationId, receiptSet: ModelInvocationReceiptSetSchema },
  strict,
);
export type ModelInvocationSubmitRequest = Static<typeof ModelInvocationSubmitRequestSchema>;

export const ModelInvocationConsistencyReasonSchema = Type.Union([
  Type.Literal("INVALID_EXPECTATION"),
  Type.Literal("INVALID_RECEIPT_SET"),
  Type.Literal("SCOPE_DIGEST_MISMATCH"),
  Type.Literal("RECEIPT_DIGEST_MISMATCH"),
  Type.Literal("IDENTITY_DIGEST_MISMATCH"),
  Type.Literal("SCOPE_MISMATCH"),
  Type.Literal("CLOSURE_SEAL_MISMATCH"),
  Type.Literal("CLOSURE_METADATA_MISMATCH"),
  Type.Literal("RUNTIME_MEASUREMENT_MISMATCH"),
  Type.Literal("CALL_TIME_ORDER_INVALID"),
  Type.Literal("INVOCATION_CANCELLED"),
  Type.Literal("CALL_CHAIN_INCOMPLETE"),
  Type.Literal("OBSERVED_IDENTITY_MISSING"),
  Type.Literal("RUNTIME_IDENTITY_MISMATCH"),
  Type.Literal("OUTPUT_UNBOUND"),
  Type.Literal("OUTPUT_MISMATCH"),
  Type.Literal("CLEANUP_UNCONFIRMED"),
]);
export type ModelInvocationConsistencyReason = Static<
  typeof ModelInvocationConsistencyReasonSchema
>;

export const ModelInvocationConsistencySchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("matched"),
      Type.Literal("unavailable"),
      Type.Literal("mismatched"),
      Type.Literal("invalid"),
    ]),
    reasons: Type.Array(ModelInvocationConsistencyReasonSchema, {
      maxItems: ModelInvocationConsistencyReasonSchema.anyOf.length,
      uniqueItems: true,
    }),
    observedIdentitySha256: nullableDigest,
  },
  strict,
);
export type ModelInvocationConsistency = Static<typeof ModelInvocationConsistencySchema>;

export const ModelInvocationSubmissionV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelInvocationSubmissionV1"),
    invocationId,
    scopeSha256: Sha256Schema,
    receiptSetSha256: Sha256Schema,
    receivedAt: timestamp,
    consistency: ModelInvocationConsistencySchema,
    // Matching a submitted ledger does not establish collector trust or authorize execution.
    executionAccepted: Type.Literal(false),
  },
  strict,
);
export type ModelInvocationSubmissionV1 = Static<typeof ModelInvocationSubmissionV1Schema>;

function wellFormed(value: unknown, parents = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || parents.has(value) || parents.size > 64) return false;
  if (
    (Array.isArray(value)
      ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    return false;
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
    ([key]) => !Array.isArray(value) || key !== "length",
  );
  if (
    Array.isArray(value) &&
    (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))
  )
    return false;
  parents.add(value);
  const valid = entries.every(
    ([key, descriptor]) =>
      key.isWellFormed() &&
      descriptor.enumerable &&
      "value" in descriptor &&
      wellFormed(descriptor.value, parents),
  );
  parents.delete(value);
  return valid;
}

function shapeIssues(schema: TSchema, value: unknown, maximumBytes: number): string[] {
  const invalid = "Model invocation control metadata must match its strict JSON contract.";
  try {
    if (!wellFormed(value) || !Value.Check(schema, value)) return [invalid];
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes)
      return ["Model invocation control metadata exceeds its aggregate UTF-8 byte limit."];
    return [];
  } catch {
    return [invalid];
  }
}

function exactText(value: string): boolean {
  return value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function dateTime(value: string): boolean {
  const match = dateTimePattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    Number(match[7] ?? 0) <= 23 &&
    Number(match[8] ?? 0) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function leaseIssues(lease: ModelInvocationBeginRequest["lease"]): string[] {
  return [
    lease.jobId,
    lease.runAttemptId,
    lease.workerNodeId,
    lease.workerInstanceId,
    lease.leaseToken,
  ].every(exactText)
    ? []
    : ["Lease identifiers must retain exact text without control characters."];
}

function runtimeIssues(value: ModelInvocationBeginRequest["runtime"]): string[] {
  return [value.providerId, value.client.version].every(exactText)
    ? []
    : ["Runtime identifiers must retain exact text without control characters."];
}

function closureIssues(value: Omit<ModelInvocationSealRequest, "lease">): string[] {
  const issues: string[] = [];
  if (!dateTime(value.closedAt)) issues.push("Invocation closure requires an exact timestamp.");
  if ((value.callCount === 0) !== (value.lastReceiptSha256 === null))
    issues.push("Only a closure without calls may omit its last receipt digest.");
  if (
    value.callCount === 0 &&
    (value.modelOutputSha256 !== null || value.observedIdentitySha256 !== null)
  )
    issues.push("A closure without calls cannot identify model output or an observed identity.");
  if (
    value.modelOutputSha256 !== null &&
    (value.state !== "closed" || !value.processClosed || !value.relayClosed)
  )
    issues.push(
      "Model output requires a closed invocation and confirmed process and relay cleanup.",
    );
  return issues;
}

function consistencyIssues(value: ModelInvocationConsistency): string[] {
  const issues: string[] = [];
  if (value.state === "matched") {
    if (value.reasons.length !== 0 || value.observedIdentitySha256 === null)
      issues.push("Matching consistency requires an observed identity and no diagnostic reasons.");
  } else if (value.reasons.length === 0)
    issues.push("Nonmatching consistency requires a diagnostic reason.");
  if (value.state === "invalid" && value.observedIdentitySha256 !== null)
    issues.push("Invalid consistency cannot retain an observed identity digest.");
  if (value.reasons.includes("OBSERVED_IDENTITY_MISSING") && value.observedIdentitySha256 !== null)
    issues.push("A missing observed identity cannot retain its digest.");
  return issues;
}

/** Shape and consistency only. The owner authenticates and fences the lease before dispatch. */
export function getModelInvocationBeginRequestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ModelInvocationBeginRequestSchema,
    value,
    maximumModelInvocationControlRequestUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const request = value as ModelInvocationBeginRequest;
  return [...leaseIssues(request.lease), ...runtimeIssues(request.runtime)];
}

/** The client must also compare every returned scope identity and runtime field with its request. */
export function getModelInvocationOpeningIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ModelInvocationOpeningSchema,
    value,
    maximumModelInvocationControlRequestUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const opening = value as ModelInvocationOpening;
  issues.push(...getModelInvocationScopeIssues(opening.scope), ...runtimeIssues(opening.runtime));
  if (!dateTime(opening.openedAt)) issues.push("Invocation opening requires an exact timestamp.");
  return issues;
}

export function getModelInvocationSealRequestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ModelInvocationSealRequestSchema,
    value,
    maximumModelInvocationControlRequestUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const request = value as ModelInvocationSealRequest;
  return [...leaseIssues(request.lease), ...closureIssues(request)];
}

export function getModelInvocationSealIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ModelInvocationSealV1Schema,
    value,
    maximumModelInvocationControlRequestUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const seal = value as ModelInvocationSealV1;
  issues.push(...closureIssues(seal));
  // Server recording and Worker closure use independent clocks.
  if (!dateTime(seal.recordedAt)) issues.push("Seal recording requires an exact timestamp.");
  return issues;
}

export function getModelInvocationSubmitRequestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ModelInvocationSubmitRequestSchema,
    value,
    maximumModelInvocationSubmitRequestUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const request = value as ModelInvocationSubmitRequest;
  issues.push(
    ...leaseIssues(request.lease),
    ...getModelInvocationReceiptSetIssues(request.receiptSet),
  );
  const scope = request.receiptSet.scope;
  if (
    scope.invocationId !== request.invocationId ||
    scope.jobId !== request.lease.jobId ||
    scope.attemptId !== request.lease.runAttemptId ||
    scope.workerNodeId !== request.lease.workerNodeId ||
    scope.workerInstanceId !== request.lease.workerInstanceId ||
    scope.leaseGeneration !== request.lease.leaseGeneration
  )
    issues.push("The submitted invocation scope must match every invocation and lease identity.");
  return issues;
}

export function getModelInvocationConsistencyIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ModelInvocationConsistencySchema,
    value,
    maximumModelInvocationControlRequestUtf8Bytes,
  );
  return issues.length > 0 ? issues : consistencyIssues(value as ModelInvocationConsistency);
}

/** Receipt acceptance records consistency only and always leaves execution unaccepted. */
export function getModelInvocationSubmissionIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ModelInvocationSubmissionV1Schema,
    value,
    maximumModelInvocationControlRequestUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const submission = value as ModelInvocationSubmissionV1;
  issues.push(...consistencyIssues(submission.consistency));
  if (!dateTime(submission.receivedAt))
    issues.push("Submission receipt requires an exact timestamp.");
  return issues;
}
