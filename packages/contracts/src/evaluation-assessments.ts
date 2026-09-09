import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
import {
  EvaluationCaseExpectationSchema,
  EvaluationCaseScoreSchema,
  EvaluationScoringReportV1Schema,
  maximumEvaluationCaseCount,
} from "./evaluation-scoring.js";
import { EvaluationSuiteDraftCaseSchema } from "./evaluation-suites.js";
import { OperatorPrincipalSchema } from "./operator-access.js";

export const maximumEvaluationAssessmentReadUtf8Bytes = 2 * 1024 * 1024;
export const maximumEvaluationAssessmentReceiptUtf8Bytes = 256 * 1024;
export const maximumEvaluationAssessmentPageSize = 50;
const strict = { additionalProperties: false } as const;
const currentVersion = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const publishedVersion = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const expectedVersion = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 });
const pageSize = Type.Integer({ minimum: 1, maximum: maximumEvaluationAssessmentPageSize });
const caseIds = Type.Array(EntityIdSchema, {
  minItems: 1,
  maxItems: maximumEvaluationCaseCount,
  uniqueItems: true,
});

export const EvaluationAssessmentScopeSchema = Type.Object(
  { repositoryId: EntityIdSchema, evaluationId: EntityIdSchema },
  strict,
);
export type EvaluationAssessmentScope = Static<typeof EvaluationAssessmentScopeSchema>;

// Both historical rule versions remain readable. Scorer implementation and input verification
// belong to the owner; this projection never accepts a client-provided scoring snapshot.
export const EvaluationScoringSummaryV1Schema = Type.Omit(
  EvaluationScoringReportV1Schema,
  ["schemaVersion", "cases"],
  strict,
);
export type EvaluationScoringSummaryV1 = Static<typeof EvaluationScoringSummaryV1Schema>;

export const EvaluationScorePreviewV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationScorePreviewV1"),
    ...EvaluationAssessmentScopeSchema.properties,
    generatedAt: DateTimeSchema,
    assessmentVersion: currentVersion,
    selectionDigest: Sha256Schema,
    scoringPlanDigest: Sha256Schema,
    observationDigest: Sha256Schema,
    adjudicationDigest: Sha256Schema,
    inputDigest: Sha256Schema,
    summary: EvaluationScoringSummaryV1Schema,
    caseIds,
  },
  strict,
);
export type EvaluationScorePreviewV1 = Static<typeof EvaluationScorePreviewV1Schema>;

export const EvaluationAssessmentPublishRequestSchema = Type.Object(
  { changeId: EntityIdSchema, expectedVersion, expectedInputDigest: Sha256Schema },
  strict,
);
export type EvaluationAssessmentPublishRequest = Static<
  typeof EvaluationAssessmentPublishRequestSchema
>;

export const EvaluationAssessmentSummaryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationAssessmentSummaryV1"),
    ...EvaluationAssessmentScopeSchema.properties,
    assessmentId: EntityIdSchema,
    version: publishedVersion,
    scorerVersion: EvaluationScoringReportV1Schema.properties.rulesVersion,
    scoringPlanDigest: Sha256Schema,
    observationDigest: Sha256Schema,
    adjudicationDigest: Sha256Schema,
    reportDigest: Sha256Schema,
    createdAt: DateTimeSchema,
    createdBy: OperatorPrincipalSchema,
    summary: EvaluationScoringSummaryV1Schema,
    caseIds,
  },
  strict,
);
export type EvaluationAssessmentSummaryV1 = Static<typeof EvaluationAssessmentSummaryV1Schema>;

export const EvaluationAssessmentListQuerySchema = Type.Object(
  { page: Type.Optional(publishedVersion), pageSize: Type.Optional(pageSize) },
  strict,
);
export type EvaluationAssessmentListQuery = Static<typeof EvaluationAssessmentListQuerySchema>;

export const EvaluationAssessmentListV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationAssessmentListV1"),
    ...EvaluationAssessmentScopeSchema.properties,
    page: publishedVersion,
    pageSize,
    total: currentVersion,
    items: Type.Array(EvaluationAssessmentSummaryV1Schema, {
      maxItems: maximumEvaluationAssessmentPageSize,
    }),
  },
  strict,
);
export type EvaluationAssessmentListV1 = Static<typeof EvaluationAssessmentListV1Schema>;

export const EvaluationAssessmentReadQuerySchema = Type.Object(
  { ...EvaluationAssessmentScopeSchema.properties, assessmentId: EntityIdSchema },
  strict,
);
export type EvaluationAssessmentReadQuery = Static<typeof EvaluationAssessmentReadQuerySchema>;

export const EvaluationAssessmentCaseReadQuerySchema = Type.Object(
  { ...EvaluationAssessmentReadQuerySchema.properties, caseId: EntityIdSchema },
  strict,
);
export type EvaluationAssessmentCaseReadQuery = Static<
  typeof EvaluationAssessmentCaseReadQuerySchema
>;

export const EvaluationAssessmentCaseV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationAssessmentCaseV1"),
    scope: EvaluationAssessmentCaseReadQuerySchema,
    reportDigest: Sha256Schema,
    scoringPlanDigest: Sha256Schema,
    caseTitle: EvaluationSuiteDraftCaseSchema.properties.title,
    expectation: EvaluationCaseExpectationSchema,
    case: EvaluationCaseScoreSchema,
  },
  strict,
);
export type EvaluationAssessmentCaseV1 = Static<typeof EvaluationAssessmentCaseV1Schema>;

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
  maximumBytes = maximumEvaluationAssessmentReadUtf8Bytes,
): string[] {
  const invalid = "Evaluation assessment must match its strict JSON contract.";
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
      return ["Evaluation assessment exceeds its aggregate UTF-8 byte limit."];
    return [];
  } catch {
    return [invalid];
  }
}
const exactIdentity = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(value);
function identityIssues(values: readonly string[]): string[] {
  return values.every(exactIdentity)
    ? []
    : ["Evaluation assessment identifiers must retain their exact stored values."];
}
function scopeIssues(scope: EvaluationAssessmentScope): string[] {
  return identityIssues([scope.repositoryId, scope.evaluationId]);
}
function paginationIssues(query: EvaluationAssessmentListQuery): string[] {
  return Number.isSafeInteger(((query.page ?? 1) - 1) * (query.pageSize ?? 20))
    ? []
    : ["The evaluation assessment page offset must be a safe integer."];
}

export function getEvaluationAssessmentScopeIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAssessmentScopeSchema, value, 8192);
  return issues.length > 0 ? issues : scopeIssues(value as EvaluationAssessmentScope);
}
export function getEvaluationScoringSummaryIssues(value: unknown): string[] {
  return shapeIssues(EvaluationScoringSummaryV1Schema, value);
}
export function getEvaluationScorePreviewIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationScorePreviewV1Schema, value);
  if (issues.length > 0) return issues;
  const preview = value as EvaluationScorePreviewV1;
  issues.push(...scopeIssues(preview), ...identityIssues(preview.caseIds));
  if (preview.summary.planDigest !== preview.scoringPlanDigest)
    issues.push("The evaluation score preview must retain its scoring plan digest.");
  return issues;
}
export function getEvaluationAssessmentPublishRequestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationAssessmentPublishRequestSchema,
    value,
    maximumEvaluationAssessmentReceiptUtf8Bytes,
  );
  return issues.length > 0
    ? issues
    : identityIssues([(value as EvaluationAssessmentPublishRequest).changeId]);
}

function summaryIssues(value: EvaluationAssessmentSummaryV1): string[] {
  const issues = [...scopeIssues(value), ...identityIssues([value.assessmentId, ...value.caseIds])];
  if (
    value.summary.planDigest !== value.scoringPlanDigest ||
    value.summary.rulesVersion !== value.scorerVersion
  )
    issues.push("The assessment summary must match its persisted scoring plan and scorer version.");
  if (
    [value.createdBy.issuer, value.createdBy.subject].some(
      (part) =>
        part.trim() !== part ||
        [...part].some(
          (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
        ),
    )
  )
    issues.push("The assessment author must retain an exact operator identity.");
  return issues;
}
export function getEvaluationAssessmentSummaryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAssessmentSummaryV1Schema, value);
  return issues.length > 0 ? issues : summaryIssues(value as EvaluationAssessmentSummaryV1);
}
/** The publication receipt uses the same immutable summary with its smaller persistence budget. */
export function getEvaluationAssessmentPublishResponseIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationAssessmentSummaryV1Schema,
    value,
    maximumEvaluationAssessmentReceiptUtf8Bytes,
  );
  return issues.length > 0 ? issues : summaryIssues(value as EvaluationAssessmentSummaryV1);
}
export function getEvaluationAssessmentListQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAssessmentListQuerySchema, value, 8192);
  return issues.length > 0 ? issues : paginationIssues(value as EvaluationAssessmentListQuery);
}
export function getEvaluationAssessmentListIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAssessmentListV1Schema, value);
  if (issues.length > 0) return issues;
  const result = value as EvaluationAssessmentListV1;
  issues.push(...scopeIssues(result), ...paginationIssues(result));
  const offset = (result.page - 1) * result.pageSize;
  if (result.items.length !== Math.min(result.pageSize, Math.max(0, result.total - offset)))
    issues.push(
      "The assessment page must include every available published version in its requested window.",
    );
  const identities = new Set<string>();
  for (const [index, item] of result.items.entries()) {
    issues.push(...summaryIssues(item));
    if (
      item.repositoryId !== result.repositoryId ||
      item.evaluationId !== result.evaluationId ||
      item.version !== result.total - offset - index ||
      identities.has(item.assessmentId)
    )
      issues.push(
        "Assessment history must preserve unique identities and consecutive latest-first versions within its evaluation.",
      );
    identities.add(item.assessmentId);
  }
  return issues;
}
export function getEvaluationAssessmentReadQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAssessmentReadQuerySchema, value, 8192);
  if (issues.length > 0) return issues;
  const query = value as EvaluationAssessmentReadQuery;
  return [...scopeIssues(query), ...identityIssues([query.assessmentId])];
}
export function getEvaluationAssessmentCaseReadQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAssessmentCaseReadQuerySchema, value, 8192);
  if (issues.length > 0) return issues;
  const query = value as EvaluationAssessmentCaseReadQuery;
  return [...scopeIssues(query), ...identityIssues([query.assessmentId, query.caseId])];
}
export function getEvaluationAssessmentCaseIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationAssessmentCaseV1Schema, value);
  if (issues.length > 0) return issues;
  const result = value as EvaluationAssessmentCaseV1;
  issues.push(...getEvaluationAssessmentCaseReadQueryIssues(result.scope));
  if (
    result.case.caseId !== result.scope.caseId ||
    result.expectation.caseId !== result.scope.caseId ||
    result.case.applicable !== (result.expectation.applicability.state === "applicable")
  )
    issues.push("The assessment case must match its exact published case selector.");
  const criterionIds = result.expectation.criteria.map((entry) => entry.criterionId);
  const expectedFindingIds = result.expectation.findings.expected.map(
    (entry) => entry.expectedFindingId,
  );
  const sameIdentities = (expected: readonly string[], actual: readonly string[]): boolean => {
    const expectedSet = new Set(expected);
    return (
      expectedSet.size === expected.length &&
      new Set(actual).size === actual.length &&
      actual.length === expected.length &&
      actual.every((identity) => expectedSet.has(identity))
    );
  };
  for (const arm of ["baseline", "candidate"] as const) {
    const expected = result.expectation[`${arm}Binding`];
    const scored = result.case[arm];
    if (
      expected.cellId !== scored.cellId ||
      expected.runId !== scored.runId ||
      expected.requestId !== scored.requestId ||
      !sameIdentities(
        criterionIds,
        scored.criteria.map((entry) => entry.criterionId),
      ) ||
      !sameIdentities(
        expectedFindingIds,
        scored.findings.expected.map((entry) => entry.expectedFindingId),
      )
    )
      issues.push(
        "Each assessment arm must retain its frozen execution binding and complete expectation identities.",
      );
  }
  if (
    !sameIdentities(
      criterionIds,
      result.case.paired.criteria.map((entry) => entry.criterionId),
    ) ||
    !sameIdentities(
      expectedFindingIds,
      result.case.paired.findings.map((entry) => entry.expectedFindingId),
    )
  )
    issues.push(
      "The paired assessment must cover the complete frozen criterion and finding identity sets.",
    );
  return issues;
}
