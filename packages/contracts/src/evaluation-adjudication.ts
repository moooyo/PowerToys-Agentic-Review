import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { EntityIdSchema, Sha256Schema } from "./common.js";
import { DashboardValidationModelReviewSchema } from "./dashboard-runs.js";
import {
  EvaluationCellResultReadQuerySchema,
  getEvaluationCellResultReadQueryIssues,
} from "./evaluation-results.js";
import {
  EvaluationArmSchema,
  type EvaluationFindingAdjudication,
  EvaluationFindingAdjudicationSchema,
  EvaluationFindingExpectationsSchema,
} from "./evaluation-scoring.js";
import {
  FindingOccurrenceRefSchema,
  maximumFindingResultOccurrenceCount,
} from "./finding-dispositions.js";

export const maximumEvaluationAdjudicationReadUtf8Bytes = 2 * 1024 * 1024;
export const maximumEvaluationAdjudicationChangeUtf8Bytes = 256 * 1024;
export const maximumEvaluationAdjudicationPageSize = 50;
export type EvaluationFindingExpectations = Static<typeof EvaluationFindingExpectationsSchema>;
const strict = { additionalProperties: false } as const;
const previousVersion = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 });
const currentVersion = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const eventVersion = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const page = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const pageSize = Type.Integer({ minimum: 1, maximum: maximumEvaluationAdjudicationPageSize });
const reason = EvaluationFindingAdjudicationSchema.anyOf[0].properties.reason;

export const EvaluationAdjudicationScopeSchema = Type.Object(
  { ...EvaluationCellResultReadQuerySchema.properties, occurrenceKey: Sha256Schema },
  strict,
);
export type EvaluationAdjudicationScope = Static<typeof EvaluationAdjudicationScopeSchema>;

export const EvaluationAdjudicationContextV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationAdjudicationContextV1"),
    scope: EvaluationCellResultReadQuerySchema,
    resultDigest: Sha256Schema,
    caseId: EntityIdSchema,
    arm: EvaluationArmSchema,
    modelRequired: Type.Boolean(),
    modelState: DashboardValidationModelReviewSchema.properties.state,
    expectations: EvaluationFindingExpectationsSchema,
    items: Type.Array(
      Type.Object(
        {
          occurrence: FindingOccurrenceRefSchema,
          version: currentVersion,
          adjudication: Type.Union([EvaluationFindingAdjudicationSchema, Type.Null()]),
        },
        strict,
      ),
      { maxItems: maximumFindingResultOccurrenceCount },
    ),
  },
  strict,
);
export type EvaluationAdjudicationContextV1 = Static<typeof EvaluationAdjudicationContextV1Schema>;

const judgment = Type.Union([
  Type.Object({ kind: Type.Literal("match"), expectedFindingId: EntityIdSchema, reason }, strict),
  Type.Object(
    { kind: Type.Literal("duplicate"), primaryOccurrenceKey: Sha256Schema, reason },
    strict,
  ),
  Type.Object({ kind: Type.Literal("false_positive"), reason }, strict),
  Type.Object({ kind: Type.Literal("unjudged"), reason }, strict),
]);
export const EvaluationAdjudicationChangeRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    expectedVersion: previousVersion,
    resultDigest: Sha256Schema,
    judgment,
  },
  strict,
);
export type EvaluationAdjudicationChangeRequest = Static<
  typeof EvaluationAdjudicationChangeRequestSchema
>;

export const EvaluationAdjudicationChangeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationAdjudicationChangeV1"),
    scope: EvaluationAdjudicationScopeSchema,
    previousVersion,
    version: eventVersion,
    adjudication: EvaluationFindingAdjudicationSchema,
  },
  strict,
);
export type EvaluationAdjudicationChangeV1 = Static<typeof EvaluationAdjudicationChangeV1Schema>;

export const EvaluationAdjudicationHistoryQuerySchema = Type.Object(
  { page: Type.Optional(page), pageSize: Type.Optional(pageSize) },
  strict,
);
export type EvaluationAdjudicationHistoryQuery = Static<
  typeof EvaluationAdjudicationHistoryQuerySchema
>;

export const EvaluationAdjudicationHistoryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationAdjudicationHistoryV1"),
    scope: EvaluationAdjudicationScopeSchema,
    resultDigest: Sha256Schema,
    page,
    pageSize,
    total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    items: Type.Array(
      Type.Object(
        {
          version: eventVersion,
          previousEventId: Type.Union([EntityIdSchema, Type.Null()]),
          adjudication: EvaluationFindingAdjudicationSchema,
        },
        strict,
      ),
      { maxItems: maximumEvaluationAdjudicationPageSize },
    ),
  },
  strict,
);
export type EvaluationAdjudicationHistoryV1 = Static<typeof EvaluationAdjudicationHistoryV1Schema>;

function wellFormed(value: unknown, parents = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || parents.has(value) || parents.size > 64) return false;
  if (
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ||
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
  const result = entries.every(
    ([key, descriptor]) =>
      key.isWellFormed() &&
      descriptor.enumerable &&
      "value" in descriptor &&
      wellFormed(descriptor.value, parents),
  );
  parents.delete(value);
  return result;
}

function shapeIssues(
  schema: TSchema,
  value: unknown,
  maximumBytes = maximumEvaluationAdjudicationReadUtf8Bytes,
): string[] {
  const invalid = "Evaluation adjudication must match its strict JSON contract.";
  try {
    if (!FormatRegistry.Has("date-time"))
      FormatRegistry.Set(
        "date-time",
        (entry) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})(?![\s\S])/u.test(
            entry,
          ) && Number.isFinite(Date.parse(entry)),
      );
    if (!wellFormed(value) || !Value.Check(schema, value)) return [invalid];
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes)
      return ["Evaluation adjudication exceeds its aggregate UTF-8 byte limit."];
    return [];
  } catch {
    return [invalid];
  }
}

function exactIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(value);
}
function adjudicationIssues(value: EvaluationFindingAdjudication): string[] {
  const identities = [value.adjudicationId, value.caseId, value.resultId];
  if (value.kind === "match") identities.push(value.expectedFindingId);
  const exactActor = [value.actor.issuer, value.actor.subject].every(
    (part) =>
      part.trim() === part &&
      [...part].every(
        (character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f,
      ),
  );
  return identities.every(exactIdentity) && exactActor
    ? []
    : ["Evaluation adjudication identities must retain their exact stored values."];
}
function paginationIssues(value: { page?: number; pageSize?: number }): string[] {
  return Number.isSafeInteger(((value.page ?? 1) - 1) * (value.pageSize ?? 20))
    ? []
    : ["The evaluation adjudication page offset must be a safe integer."];
}

export function getEvaluationAdjudicationScopeIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAdjudicationScopeSchema, value, 8192);
  if (issues.length > 0) return issues;
  const { occurrenceKey: _occurrenceKey, ...scope } = value as EvaluationAdjudicationScope;
  return getEvaluationCellResultReadQueryIssues(scope);
}

/** Array membership and current-set judgment consistency remain the persistence owner's responsibility. */
export function getEvaluationAdjudicationContextIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAdjudicationContextV1Schema, value);
  if (issues.length > 0) return issues;
  const result = value as EvaluationAdjudicationContextV1;
  issues.push(...getEvaluationCellResultReadQueryIssues(result.scope));
  if (
    !exactIdentity(result.caseId) ||
    result.expectations.expected.some((entry) => !exactIdentity(entry.expectedFindingId))
  )
    issues.push("The evaluation adjudication case and expectation identities must be exact.");
  if (
    new Set(result.expectations.expected.map((entry) => entry.expectedFindingId)).size !==
    result.expectations.expected.length
  )
    issues.push("Expected finding identities must be unique within the selected case.");
  const occurrenceKeys = new Set<string>(),
    ordinalKeys = new Set<string>(),
    eventIds = new Set<string>();
  for (const item of result.items) {
    const occurrence = item.occurrence;
    const ordinalKey = JSON.stringify([occurrence.kind, occurrence.ordinal]);
    if (
      occurrence.resultId !== result.scope.resultId ||
      occurrence.resultDigest !== result.resultDigest ||
      occurrenceKeys.has(occurrence.key) ||
      ordinalKeys.has(ordinalKey) ||
      (item.adjudication === null) !== (item.version === 0)
    )
      issues.push(
        "Evaluation adjudication items must retain unique occurrence identities and their current versions.",
      );
    occurrenceKeys.add(occurrence.key);
    ordinalKeys.add(ordinalKey);
    const adjudication = item.adjudication;
    if (adjudication === null) continue;
    issues.push(...adjudicationIssues(adjudication));
    if (
      adjudication.caseId !== result.caseId ||
      adjudication.arm !== result.arm ||
      adjudication.resultId !== result.scope.resultId ||
      adjudication.resultDigest !== result.resultDigest ||
      adjudication.occurrenceKey !== occurrence.key ||
      eventIds.has(adjudication.adjudicationId)
    )
      issues.push("The current adjudication must match its case, arm, result and occurrence.");
    eventIds.add(adjudication.adjudicationId);
  }
  return issues;
}

export function getEvaluationAdjudicationChangeRequestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationAdjudicationChangeRequestSchema,
    value,
    maximumEvaluationAdjudicationChangeUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const request = value as EvaluationAdjudicationChangeRequest;
  if (
    !exactIdentity(request.changeId) ||
    (request.judgment.kind === "match" && !exactIdentity(request.judgment.expectedFindingId))
  )
    issues.push("Evaluation adjudication request identifiers must be exact.");
  return issues;
}

export function getEvaluationAdjudicationChangeIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationAdjudicationChangeV1Schema,
    value,
    maximumEvaluationAdjudicationChangeUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const result = value as EvaluationAdjudicationChangeV1;
  issues.push(
    ...getEvaluationAdjudicationScopeIssues(result.scope),
    ...adjudicationIssues(result.adjudication),
  );
  if (
    result.version !== result.previousVersion + 1 ||
    result.adjudication.resultId !== result.scope.resultId ||
    result.adjudication.occurrenceKey !== result.scope.occurrenceKey
  )
    issues.push(
      "The accepted adjudication must advance one version within its selected result occurrence.",
    );
  return issues;
}

export function getEvaluationAdjudicationHistoryQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAdjudicationHistoryQuerySchema, value, 8192);
  return issues.length > 0 ? issues : paginationIssues(value as EvaluationAdjudicationHistoryQuery);
}

export function getEvaluationAdjudicationHistoryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAdjudicationHistoryV1Schema, value);
  if (issues.length > 0) return issues;
  const result = value as EvaluationAdjudicationHistoryV1;
  issues.push(...getEvaluationAdjudicationScopeIssues(result.scope), ...paginationIssues(result));
  const offset = (result.page - 1) * result.pageSize;
  if (result.items.length !== Math.min(result.pageSize, Math.max(0, result.total - offset)))
    issues.push(
      "The adjudication history page must include every available event in its requested window.",
    );
  const first = result.items[0],
    eventIds = new Set<string>();
  for (const [index, item] of result.items.entries()) {
    const adjudication = item.adjudication;
    const newer = result.items[index - 1];
    issues.push(...adjudicationIssues(adjudication));
    if (
      adjudication.resultId !== result.scope.resultId ||
      adjudication.resultDigest !== result.resultDigest ||
      adjudication.occurrenceKey !== result.scope.occurrenceKey ||
      adjudication.caseId !== first?.adjudication.caseId ||
      adjudication.arm !== first?.adjudication.arm ||
      eventIds.has(adjudication.adjudicationId) ||
      item.version !== result.total - offset - index ||
      (item.previousEventId === null) !== (item.version === 1) ||
      (item.previousEventId !== null && !exactIdentity(item.previousEventId)) ||
      item.previousEventId === adjudication.adjudicationId ||
      (item.previousEventId !== null && eventIds.has(item.previousEventId)) ||
      (newer !== undefined &&
        (newer.version <= item.version || newer.previousEventId !== adjudication.adjudicationId))
    )
      issues.push(
        "Adjudication history must preserve one result occurrence and its descending event chain.",
      );
    eventIds.add(adjudication.adjudicationId);
  }
  return issues;
}
