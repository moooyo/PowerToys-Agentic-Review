import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { EntityIdSchema, Sha256Schema } from "./common.js";
import {
  EvaluationApplicabilitySchema,
  maximumEvaluationCaseCount,
  maximumEvaluationCriterionCount,
  maximumEvaluationExpectedFindingCount,
} from "./evaluation-scoring.js";
import {
  EvaluationSourceSummaryV1Schema,
  getEvaluationSourceSummaryIssues,
  maximumEvaluationSourceSummaryUtf8Bytes,
} from "./evaluation-source.js";
import {
  EvaluationSuiteDraftCaseSchema,
  maximumEvaluationSuiteUtf8Bytes,
} from "./evaluation-suites.js";

export const maximumEvaluationSuiteCaseSummaryUtf8Bytes = 64 * 1024;
export const maximumEvaluationSuiteCaseListUtf8Bytes = maximumEvaluationSuiteUtf8Bytes;
export const maximumEvaluationSuiteCaseExpectationUtf8Bytes = maximumEvaluationSuiteUtf8Bytes;
export const maximumEvaluationSuiteCaseDetailUtf8Bytes =
  maximumEvaluationSuiteCaseExpectationUtf8Bytes + maximumEvaluationSourceSummaryUtf8Bytes;

const versionScopeProperties = {
  repositoryId: EntityIdSchema,
  suiteId: EntityIdSchema,
  versionId: EntityIdSchema,
};
const manifestProperties = {
  ...versionScopeProperties,
  sourceVersionId: EntityIdSchema,
  expectationVersionId: EntityIdSchema,
  sourceManifestSha256: Sha256Schema,
  expectationManifestSha256: Sha256Schema,
};

// Operator read models only. Assessment labels must never enter Worker execution manifests.
export const EvaluationSuiteCaseSummaryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationSuiteCaseSummaryV1"),
    ...versionScopeProperties,
    caseId: EntityIdSchema,
    title: EvaluationSuiteDraftCaseSchema.properties.title,
    sourceId: EntityIdSchema,
    sourceDigest: Sha256Schema,
    applicability: EvaluationApplicabilitySchema,
    criterionCount: Type.Integer({ minimum: 0, maximum: maximumEvaluationCriterionCount }),
    annotation: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("unlabeled"),
    ]),
    expectedFindingCount: Type.Integer({
      minimum: 0,
      maximum: maximumEvaluationExpectedFindingCount,
    }),
  },
  { additionalProperties: false },
);
export type EvaluationSuiteCaseSummaryV1 = Static<typeof EvaluationSuiteCaseSummaryV1Schema>;

export const EvaluationSuiteCaseListV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationSuiteCaseListV1"),
    ...manifestProperties,
    items: Type.Array(EvaluationSuiteCaseSummaryV1Schema, {
      minItems: 1,
      maxItems: maximumEvaluationCaseCount,
    }),
    total: Type.Integer({ minimum: 1, maximum: maximumEvaluationCaseCount }),
  },
  { additionalProperties: false },
);
export type EvaluationSuiteCaseListV1 = Static<typeof EvaluationSuiteCaseListV1Schema>;

const frozenExpectationSchema = Type.Omit(EvaluationSuiteDraftCaseSchema, ["sourceId"], {
  additionalProperties: false,
});
type FrozenExpectation = Static<typeof frozenExpectationSchema>;

export const EvaluationSuiteCaseDetailV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationSuiteCaseDetailV1"),
    ...manifestProperties,
    caseId: EntityIdSchema,
    source: EvaluationSourceSummaryV1Schema,
    expectation: frozenExpectationSchema,
  },
  { additionalProperties: false },
);
export type EvaluationSuiteCaseDetailV1 = Static<typeof EvaluationSuiteCaseDetailV1Schema>;

function wellFormedJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value) || ancestors.size > 64) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? [...value].every((entry) => wellFormedJson(entry, ancestors))
    : Object.entries(value).every(
        ([key, entry]) => key.isWellFormed() && wellFormedJson(entry, ancestors),
      );
  ancestors.delete(value);
  return valid;
}

function shapeIssues(
  schema: TSchema,
  value: unknown,
  label: string,
  maximumBytes: number,
): string[] {
  if (!wellFormedJson(value)) return [`${label} must contain well-formed JSON data.`];
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes)
    return [`${label} exceeds its aggregate UTF-8 byte limit of ${maximumBytes} bytes.`];
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set(
      "date-time",
      (entry) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(entry) &&
        Number.isFinite(Date.parse(entry)),
    );
  if (!Value.Check(schema, value))
    return [`${label} is invalid at ${Value.Errors(schema, value).First()?.path || "/"}.`];
  return [];
}

function uniqueIssues(ids: readonly string[], label: string): string[] {
  return new Set(ids).size === ids.length ? [] : [`${label} must be unique within their scope.`];
}

function expectationIssues(value: FrozenExpectation): string[] {
  const issues = shapeIssues(
    frozenExpectationSchema,
    value,
    "Evaluation suite case expectation",
    maximumEvaluationSuiteCaseExpectationUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  return [
    ...uniqueIssues(
      value.criteria.map((entry) => entry.criterionId),
      "Criterion identifiers",
    ),
    ...uniqueIssues(
      value.findings.expected.map((entry) => entry.expectedFindingId),
      "Expected finding identifiers",
    ),
  ];
}

export function getEvaluationSuiteCaseSummaryIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSuiteCaseSummaryV1Schema,
    value,
    "Evaluation suite case summary",
    maximumEvaluationSuiteCaseSummaryUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const summary = value as EvaluationSuiteCaseSummaryV1;
  if (summary.annotation === "unlabeled" && summary.expectedFindingCount !== 0)
    issues.push("An unlabeled evaluation case cannot claim expected findings.");
  return issues;
}

export function getEvaluationSuiteCaseListIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSuiteCaseListV1Schema,
    value,
    "Evaluation suite case list",
    maximumEvaluationSuiteCaseListUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const list = value as EvaluationSuiteCaseListV1;
  if (list.total !== list.items.length)
    issues.push("The immutable evaluation case list must contain every case in its total.");
  if (
    list.items.some(
      (entry) =>
        entry.repositoryId !== list.repositoryId ||
        entry.suiteId !== list.suiteId ||
        entry.versionId !== list.versionId,
    )
  )
    issues.push(
      "Evaluation case summaries must belong to the requested repository, suite, and version.",
    );
  return [
    ...issues,
    ...uniqueIssues(
      list.items.map((entry) => entry.caseId),
      "Case identifiers",
    ),
    ...list.items.flatMap(getEvaluationSuiteCaseSummaryIssues),
  ];
}

/** The owner verifies the immutable manifest digests and publication; this only checks consistency. */
export function getEvaluationSuiteCaseDetailIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSuiteCaseDetailV1Schema,
    value,
    "Evaluation suite case detail",
    maximumEvaluationSuiteCaseDetailUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const detail = value as EvaluationSuiteCaseDetailV1;
  if (detail.caseId !== detail.expectation.caseId)
    issues.push("The frozen evaluation expectation must belong to the requested case.");
  if (detail.repositoryId !== detail.source.repositoryId)
    issues.push("The frozen evaluation source must belong to the requested repository.");
  return [
    ...issues,
    ...getEvaluationSourceSummaryIssues(detail.source),
    ...expectationIssues(detail.expectation),
  ];
}

function assertNoIssues(issues: readonly string[]): void {
  if (issues.length > 0) throw new TypeError(issues.join(" "));
}

export function assertEvaluationSuiteCaseSummary(
  value: unknown,
): asserts value is EvaluationSuiteCaseSummaryV1 {
  assertNoIssues(getEvaluationSuiteCaseSummaryIssues(value));
}
export function assertEvaluationSuiteCaseList(
  value: unknown,
): asserts value is EvaluationSuiteCaseListV1 {
  assertNoIssues(getEvaluationSuiteCaseListIssues(value));
}
export function assertEvaluationSuiteCaseDetail(
  value: unknown,
): asserts value is EvaluationSuiteCaseDetailV1 {
  assertNoIssues(getEvaluationSuiteCaseDetailIssues(value));
}
