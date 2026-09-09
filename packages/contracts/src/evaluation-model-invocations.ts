import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  getModelInvocationOpeningIssues,
  getModelInvocationSealIssues,
  getModelInvocationSubmissionIssues,
  ModelInvocationOpeningSchema,
  ModelInvocationSealV1Schema,
  ModelInvocationSubmissionV1Schema,
} from "./model-invocation-control.js";
import {
  getModelRuntimeIdentityIssues,
  ModelInvocationScopeV1Schema,
  ModelRuntimeIdentityV1Schema,
  maximumModelInvocationCallCount,
} from "./model-runtime.js";
import {
  getModelRuntimeRegistrationIssues,
  ModelRuntimeRegistrationV1Schema,
} from "./model-runtime-registry.js";

export const maximumEvaluationCellInvocationPageSize = 10;
export const maximumEvaluationCellInvocationListUtf8Bytes = 2 * 1024 * 1024;
const strict = { additionalProperties: false } as const;
const page = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const pageSize = Type.Integer({ minimum: 1, maximum: maximumEvaluationCellInvocationPageSize });
const count = Type.Integer({ minimum: 0, maximum: maximumModelInvocationCallCount });
const dateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))(?![\s\S])/u;
const timestamp = Type.String({ pattern: dateTimePattern.source, minLength: 20, maxLength: 64 });

export const EvaluationCellInvocationListQuerySchema = Type.Object(
  { page: Type.Optional(page), pageSize: Type.Optional(pageSize) },
  strict,
);
export type EvaluationCellInvocationListQuery = Static<
  typeof EvaluationCellInvocationListQuerySchema
>;

export const EvaluationCellInvocationCallOutcomesSchema = Type.Object(
  {
    completed: count,
    provider_failed: count,
    provider_incomplete: count,
    transport_failed: count,
    cancelled: count,
    protocol_invalid: count,
    budget_exceeded: count,
  },
  strict,
);
export type EvaluationCellInvocationCallOutcomes = Static<
  typeof EvaluationCellInvocationCallOutcomesSchema
>;

export const EvaluationCellInvocationItemSchema = Type.Object(
  {
    opening: ModelInvocationOpeningSchema,
    seal: Type.Union([ModelInvocationSealV1Schema, Type.Null()]),
    submission: Type.Union([ModelInvocationSubmissionV1Schema, Type.Null()]),
    observedIdentity: Type.Union([ModelRuntimeIdentityV1Schema, Type.Null()]),
    callOutcomes: Type.Union([EvaluationCellInvocationCallOutcomesSchema, Type.Null()]),
  },
  strict,
);
export type EvaluationCellInvocationItem = Static<typeof EvaluationCellInvocationItemSchema>;

export const EvaluationCellInvocationListV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationCellInvocationListV1"),
    repositoryId: ModelInvocationScopeV1Schema.properties.repositoryId,
    evaluationId: ModelInvocationScopeV1Schema.properties.evaluationId,
    cellId: ModelInvocationScopeV1Schema.properties.cellId,
    expectedRuntimeRegistration: Type.Union([ModelRuntimeRegistrationV1Schema, Type.Null()]),
    page,
    pageSize,
    total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    sampledAt: timestamp,
    items: Type.Array(EvaluationCellInvocationItemSchema, {
      maxItems: maximumEvaluationCellInvocationPageSize,
    }),
  },
  strict,
);
export type EvaluationCellInvocationListV1 = Static<typeof EvaluationCellInvocationListV1Schema>;

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

function shapeIssues(schema: TSchema, value: unknown): string[] {
  const invalid = "Evaluation model invocation diagnostics must match their strict JSON contract.";
  try {
    if (!wellFormed(value) || !Value.Check(schema, value)) return [invalid];
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      maximumEvaluationCellInvocationListUtf8Bytes
    )
      return ["Evaluation model invocation diagnostics exceed their aggregate UTF-8 byte limit."];
    return [];
  } catch {
    return [invalid];
  }
}

function dateTime(value: string): boolean {
  const match = dateTimePattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    Number(match[7] ?? 0) <= 23 &&
    Number(match[8] ?? 0) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function paginationIssues(value: EvaluationCellInvocationListQuery): string[] {
  return Number.isSafeInteger(
    ((value.page ?? 1) - 1) * (value.pageSize ?? maximumEvaluationCellInvocationPageSize),
  )
    ? []
    : ["The invocation diagnostics page offset must be a safe integer."];
}

function runtimeMatches(
  left: EvaluationCellInvocationItem["opening"]["runtime"],
  right: EvaluationCellInvocationItem["opening"]["runtime"],
): boolean {
  return (
    left.providerId === right.providerId &&
    left.endpointSha256 === right.endpointSha256 &&
    left.client.kind === right.client.kind &&
    left.client.version === right.client.version &&
    left.client.executableSha256 === right.client.executableSha256 &&
    left.client.launchPolicySha256 === right.client.launchPolicySha256 &&
    left.relay.implementationSha256 === right.relay.implementationSha256 &&
    left.relay.policySha256 === right.relay.policySha256
  );
}

function itemIssues(
  item: EvaluationCellInvocationItem,
  list: EvaluationCellInvocationListV1,
): string[] {
  const { opening, seal, submission, observedIdentity, callOutcomes } = item;
  const issues = getModelInvocationOpeningIssues(opening);
  const expected = list.expectedRuntimeRegistration;
  if (
    opening.scope.repositoryId !== list.repositoryId ||
    opening.scope.evaluationId !== list.evaluationId ||
    opening.scope.cellId !== list.cellId
  )
    issues.push(
      "Every invocation opening must retain the requested repository, evaluation and cell.",
    );
  if (
    expected === null ||
    opening.scope.expectedModelIdentitySha256 !== expected.identitySha256 ||
    opening.scope.requestedModel !== expected.requestedModel
  )
    issues.push("Every invocation must retain its frozen expected runtime registration.");
  if (Date.parse(opening.openedAt) > Date.parse(list.sampledAt))
    issues.push("An invocation opening cannot follow the diagnostics sampling time.");
  if ((submission === null) !== (callOutcomes === null))
    issues.push("Call outcome counts must be present exactly when a submission is present.");
  if (observedIdentity !== null) {
    issues.push(...getModelRuntimeIdentityIssues(observedIdentity));
    if (submission === null || submission.consistency.state === "invalid")
      issues.push("Observed identity is available only with a noninvalid submission.");
    if (!runtimeMatches(observedIdentity, opening.runtime))
      issues.push(
        "Observed identity must retain the provider, client and relay runtime from opening.",
      );
  }
  if (seal === null) {
    if (submission !== null || callOutcomes !== null)
      issues.push("A submission and its call counts require an independently recorded seal.");
    return issues;
  }
  issues.push(...getModelInvocationSealIssues(seal));
  if (seal.invocationId !== opening.scope.invocationId || seal.scopeSha256 !== opening.scopeSha256)
    issues.push("The invocation seal must retain its opening identity and scope digest.");
  // Only Server timestamps are ordered here; closedAt belongs to the Worker clock.
  if (
    Date.parse(seal.recordedAt) < Date.parse(opening.openedAt) ||
    Date.parse(seal.recordedAt) > Date.parse(list.sampledAt)
  )
    issues.push("The seal recording must fall between opening and diagnostics sampling.");
  if (submission === null) return issues;
  issues.push(...getModelInvocationSubmissionIssues(submission));
  if (
    submission.invocationId !== opening.scope.invocationId ||
    submission.scopeSha256 !== opening.scopeSha256 ||
    submission.receiptSetSha256 !== seal.receiptSetSha256
  )
    issues.push("The submission must retain its opening and independently sealed ledger digests.");
  if (
    Date.parse(submission.receivedAt) < Date.parse(seal.recordedAt) ||
    Date.parse(submission.receivedAt) > Date.parse(list.sampledAt)
  )
    issues.push("Submission receipt must fall between seal recording and diagnostics sampling.");
  if (
    callOutcomes !== null &&
    Object.values(callOutcomes).reduce((sum, value) => sum + value, 0) !== seal.callCount
  )
    issues.push("Submitted call outcome counts must sum to the independently sealed call count.");
  if (
    submission.consistency.state !== "invalid" &&
    submission.consistency.observedIdentitySha256 !== seal.observedIdentitySha256
  )
    issues.push(
      "Noninvalid submission consistency must retain the sealed observed identity digest.",
    );
  if (
    submission.consistency.state !== "invalid" &&
    (observedIdentity === null) !== (submission.consistency.observedIdentitySha256 === null)
  )
    issues.push(
      "Observed identity and its sealed submission digest must be present or absent together.",
    );
  if (
    submission.consistency.state === "matched" &&
    (seal.state !== "closed" ||
      !seal.processClosed ||
      !seal.relayClosed ||
      seal.callCount === 0 ||
      callOutcomes?.completed !== seal.callCount ||
      seal.modelOutputSha256 === null ||
      seal.observedIdentitySha256 === null ||
      seal.observedIdentitySha256 !== expected?.identitySha256 ||
      observedIdentity === null)
  )
    issues.push(
      "Matching consistency requires a complete closed collection matching the frozen expected identity.",
    );
  if (
    submission.consistency.state === "matched" &&
    expected !== null &&
    observedIdentity !== null &&
    (!runtimeMatches(observedIdentity, expected.identity) ||
      observedIdentity.modelId !== expected.identity.modelId)
  )
    issues.push("Matching consistency must retain the complete frozen expected runtime identity.");
  return issues;
}

export function getEvaluationCellInvocationListQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationCellInvocationListQuerySchema, value);
  return issues.length ? issues : paginationIssues(value as EvaluationCellInvocationListQuery);
}

/** Read-only diagnostic consistency. The owner authenticates scope and recomputes stored digests. */
export function getEvaluationCellInvocationListIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationCellInvocationListV1Schema, value);
  if (issues.length > 0) return issues;
  const list = value as EvaluationCellInvocationListV1;
  issues.push(...paginationIssues(list));
  if (!dateTime(list.sampledAt))
    issues.push("Invocation diagnostics require an exact sampling timestamp.");
  if (list.expectedRuntimeRegistration !== null)
    issues.push(...getModelRuntimeRegistrationIssues(list.expectedRuntimeRegistration));
  const offset = (list.page - 1) * list.pageSize;
  if (
    Number.isSafeInteger(offset) &&
    list.items.length !== Math.min(list.pageSize, Math.max(0, list.total - offset))
  )
    issues.push("Invocation diagnostics must contain the complete requested page for their total.");
  const invocations = new Set<string>(),
    attempts = new Set<string>();
  for (const [index, item] of list.items.entries()) {
    issues.push(...itemIssues(item, list));
    const id = item.opening.scope.invocationId;
    if (invocations.has(id) || attempts.has(item.opening.scope.attemptId))
      issues.push("Invocation diagnostics must not repeat an invocation or attempt.");
    const previous = list.items[index - 1]?.opening;
    if (
      previous !== undefined &&
      (Date.parse(previous.openedAt) < Date.parse(item.opening.openedAt) ||
        (Date.parse(previous.openedAt) === Date.parse(item.opening.openedAt) &&
          previous.scope.invocationId < id))
    )
      issues.push(
        "Invocation diagnostics must be ordered by descending opening time and invocation identity.",
      );
    invocations.add(id);
    attempts.add(item.opening.scope.attemptId);
  }
  return issues;
}
