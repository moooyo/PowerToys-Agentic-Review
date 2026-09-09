import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import {
  EvaluationApplicabilitySchema,
  EvaluationCriterionSchema,
  EvaluationFindingExpectationsSchema,
  maximumEvaluationCaseCount,
  maximumEvaluationCriterionCount,
} from "./evaluation-scoring.js";
import { type OperatorPrincipal, OperatorPrincipalSchema } from "./operator-access.js";
import {
  type ValidationTarget,
  ValidationTargetSchema,
  type WorkflowKind,
  WorkflowKindSchema,
} from "./platform-configuration.js";

export const maximumEvaluationSuiteUtf8Bytes = 2 * 1024 * 1024;
export const maximumEvaluationSourceManifestUtf8Bytes = 64 * 1024;
export const maximumEvaluationSuitePageSize = 50;

const nameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000-\\u001F\\u007F]+(?![\\s\\S])",
});
const descriptionSchema = Type.String({ maxLength: 2_048, pattern: "^[^\\u0000]*$" });
const scopeProperties = {
  repositoryId: EntityIdSchema,
  workflowKind: WorkflowKindSchema,
  target: ValidationTargetSchema,
};

// Assessment labels are Server-only. Arm-specific check mappings belong to a later evaluation.
export const EvaluationSuiteDraftCaseSchema = Type.Object(
  {
    caseId: EntityIdSchema,
    title: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]+$",
    }),
    sourceId: EntityIdSchema,
    applicability: EvaluationApplicabilitySchema,
    criteria: Type.Array(
      Type.Omit(EvaluationCriterionSchema, ["baselineCheckId", "candidateCheckId"], {
        additionalProperties: false,
      }),
      { maxItems: maximumEvaluationCriterionCount },
    ),
    findings: EvaluationFindingExpectationsSchema,
  },
  { additionalProperties: false },
);
export type EvaluationSuiteDraftCase = Static<typeof EvaluationSuiteDraftCaseSchema>;

export const EvaluationSuiteDraftSchema = Type.Object(
  {
    name: nameSchema,
    description: descriptionSchema,
    cases: Type.Array(EvaluationSuiteDraftCaseSchema, { maxItems: maximumEvaluationCaseCount }),
  },
  { additionalProperties: false },
);
export type EvaluationSuiteDraft = Static<typeof EvaluationSuiteDraftSchema>;

export const EvaluationSuiteCreateRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    name: nameSchema,
    description: descriptionSchema,
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
  },
  { additionalProperties: false },
);
export type EvaluationSuiteCreateRequest = Static<typeof EvaluationSuiteCreateRequestSchema>;

// Repository, workflow and target are immutable suite identity, never draft fields.
export const EvaluationSuiteSaveRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    expectedRevision: PositiveIntegerSchema,
    draft: EvaluationSuiteDraftSchema,
  },
  { additionalProperties: false },
);
export type EvaluationSuiteSaveRequest = Static<typeof EvaluationSuiteSaveRequestSchema>;

export const EvaluationSuitePublishRequestSchema = Type.Object(
  { changeId: EntityIdSchema, expectedRevision: PositiveIntegerSchema },
  { additionalProperties: false },
);
export type EvaluationSuitePublishRequest = Static<typeof EvaluationSuitePublishRequestSchema>;

export const EvaluationSuiteSummaryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationSuiteSummaryV1"),
    id: EntityIdSchema,
    ...scopeProperties,
    name: nameSchema,
    description: descriptionSchema,
    draftRevision: PositiveIntegerSchema,
    caseCount: Type.Integer({ minimum: 0, maximum: maximumEvaluationCaseCount }),
    latestVersionId: Type.Union([EntityIdSchema, Type.Null()]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    createdBy: OperatorPrincipalSchema,
    updatedBy: OperatorPrincipalSchema,
  },
  { additionalProperties: false },
);
export type EvaluationSuiteSummaryV1 = Static<typeof EvaluationSuiteSummaryV1Schema>;

export const EvaluationSuiteDetailV1Schema = Type.Object(
  { ...EvaluationSuiteSummaryV1Schema.properties, draft: EvaluationSuiteDraftSchema },
  { additionalProperties: false },
);
export type EvaluationSuiteDetailV1 = Static<typeof EvaluationSuiteDetailV1Schema>;

export const EvaluationSuiteVersionV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationSuiteVersionV1"),
    id: EntityIdSchema,
    suiteId: EntityIdSchema,
    ...scopeProperties,
    version: PositiveIntegerSchema,
    sourceDraftRevision: PositiveIntegerSchema,
    name: nameSchema,
    description: descriptionSchema,
    sourceVersionId: EntityIdSchema,
    expectationVersionId: EntityIdSchema,
    sourceManifestSha256: Sha256Schema,
    expectationManifestSha256: Sha256Schema,
    caseCount: Type.Integer({ minimum: 1, maximum: maximumEvaluationCaseCount }),
    createdAt: DateTimeSchema,
    createdBy: OperatorPrincipalSchema,
  },
  { additionalProperties: false },
);
export type EvaluationSuiteVersionV1 = Static<typeof EvaluationSuiteVersionV1Schema>;

// Source capture owns full snapshots. This manifest only binds their Server-created references.
export const EvaluationSourceManifestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationSourceManifestV1"),
    ...scopeProperties,
    cases: Type.Array(
      Type.Object(
        { caseId: EntityIdSchema, sourceId: EntityIdSchema, sourceDigest: Sha256Schema },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: maximumEvaluationCaseCount },
    ),
  },
  { additionalProperties: false },
);
export type EvaluationSourceManifestV1 = Static<typeof EvaluationSourceManifestV1Schema>;

export const EvaluationExpectationManifestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationExpectationManifestV1"),
    ...scopeProperties,
    cases: Type.Array(
      Type.Omit(EvaluationSuiteDraftCaseSchema, ["sourceId"], { additionalProperties: false }),
      { minItems: 1, maxItems: maximumEvaluationCaseCount },
    ),
  },
  { additionalProperties: false },
);
export type EvaluationExpectationManifestV1 = Static<typeof EvaluationExpectationManifestV1Schema>;

const pageSizeSchema = Type.Integer({ minimum: 1, maximum: maximumEvaluationSuitePageSize });
export const EvaluationSuiteListQuerySchema = Type.Object(
  { page: Type.Optional(PositiveIntegerSchema), pageSize: Type.Optional(pageSizeSchema) },
  { additionalProperties: false },
);
export type EvaluationSuiteListQuery = Static<typeof EvaluationSuiteListQuerySchema>;

const pageProperties = {
  repositoryId: EntityIdSchema,
  total: NonNegativeIntegerSchema,
  page: PositiveIntegerSchema,
  pageSize: pageSizeSchema,
};
export const EvaluationSuiteListResponseSchema = Type.Object(
  {
    ...pageProperties,
    items: Type.Array(EvaluationSuiteSummaryV1Schema, { maxItems: maximumEvaluationSuitePageSize }),
  },
  { additionalProperties: false },
);
export type EvaluationSuiteListResponse = Static<typeof EvaluationSuiteListResponseSchema>;

export const EvaluationSuiteVersionListResponseSchema = Type.Object(
  {
    ...pageProperties,
    suiteId: EntityIdSchema,
    items: Type.Array(EvaluationSuiteVersionV1Schema, { maxItems: maximumEvaluationSuitePageSize }),
  },
  { additionalProperties: false },
);
export type EvaluationSuiteVersionListResponse = Static<
  typeof EvaluationSuiteVersionListResponseSchema
>;

function wellFormedJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
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
  maximumBytes = maximumEvaluationSuiteUtf8Bytes,
): string[] {
  if (!wellFormedJson(value)) return [`${label} must contain well-formed JSON data.`];
  if (!FormatRegistry.Has("date-time")) {
    FormatRegistry.Set(
      "date-time",
      (entry) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(entry) &&
        Number.isFinite(Date.parse(entry)),
    );
  }
  if (!Value.Check(schema, value)) {
    return [`${label} is invalid at ${Value.Errors(schema, value).First()?.path || "/"}.`];
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes) {
    return [`${label} exceeds its aggregate UTF-8 byte limit of ${maximumBytes} bytes.`];
  }
  return [];
}

function scopeIssues(value: { workflowKind: WorkflowKind; target: ValidationTarget }): string[] {
  const valid =
    value.workflowKind === "issue_validation" ||
    (value.workflowKind === "pr_ui" ? value.target !== "headless" : value.target === "headless");
  return valid ? [] : ["The evaluation workflow and target are incompatible."];
}

function uniqueIssues(ids: readonly string[], label: string): string[] {
  return new Set(ids).size === ids.length ? [] : [`${label} must be unique within their scope.`];
}

function caseIssues(cases: readonly Omit<EvaluationSuiteDraftCase, "sourceId">[]): string[] {
  const issues = uniqueIssues(
    cases.map((entry) => entry.caseId),
    "Case identifiers",
  );
  for (const entry of cases) {
    issues.push(
      ...uniqueIssues(
        entry.criteria.map((criterion) => criterion.criterionId),
        `Criterion identifiers for case ${entry.caseId}`,
      ),
    );
    issues.push(
      ...uniqueIssues(
        entry.findings.expected.map((finding) => finding.expectedFindingId),
        `Expected finding identifiers for case ${entry.caseId}`,
      ),
    );
  }
  return issues;
}

function actorIssues(actor: OperatorPrincipal): string[] {
  return [actor.issuer, actor.subject].some(
    (value) => value.trim() !== value || value.includes("\0"),
  )
    ? ["An evaluation operator must have an exact nonempty identity."]
    : [];
}

export function getEvaluationSuiteDraftIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationSuiteDraftSchema, value, "Evaluation suite draft");
  return issues.length > 0 ? issues : caseIssues((value as EvaluationSuiteDraft).cases);
}

/** Publication validates the frozen draft; it never removes inapplicable or unlabeled cases. */
export function getEvaluationSuitePublicationIssues(value: unknown): string[] {
  const issues = getEvaluationSuiteDraftIssues(value);
  if (issues.length > 0) return issues;
  return (value as EvaluationSuiteDraft).cases.some(
    (entry) => entry.applicability.state === "applicable",
  )
    ? []
    : ["Publishing a suite requires at least one applicable case."];
}

export function getEvaluationSuiteCreateRequestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSuiteCreateRequestSchema,
    value,
    "Evaluation suite create request",
  );
  return issues.length > 0 ? issues : scopeIssues(value as EvaluationSuiteCreateRequest);
}

export function getEvaluationSuiteSaveRequestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSuiteSaveRequestSchema,
    value,
    "Evaluation suite save request",
  );
  return issues.length > 0
    ? issues
    : getEvaluationSuiteDraftIssues((value as EvaluationSuiteSaveRequest).draft);
}

export function getEvaluationSuitePublishRequestIssues(value: unknown): string[] {
  return shapeIssues(
    EvaluationSuitePublishRequestSchema,
    value,
    "Evaluation suite publish request",
  );
}

function summaryIssues(value: EvaluationSuiteSummaryV1): string[] {
  const issues = [
    ...scopeIssues(value),
    ...actorIssues(value.createdBy),
    ...actorIssues(value.updatedBy),
  ];
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    issues.push("The evaluation suite update cannot precede its creation.");
  }
  return issues;
}

export function getEvaluationSuiteSummaryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationSuiteSummaryV1Schema, value, "Evaluation suite summary");
  return issues.length > 0 ? issues : summaryIssues(value as EvaluationSuiteSummaryV1);
}

export function getEvaluationSuiteDetailIssues(value: unknown): string[] {
  // A maximum-sized valid draft remains readable after adding bounded Server-owned metadata.
  const issues = shapeIssues(
    EvaluationSuiteDetailV1Schema,
    value,
    "Evaluation suite detail",
    maximumEvaluationSuiteUtf8Bytes + 64 * 1024,
  );
  if (issues.length > 0) return issues;
  const detail = value as EvaluationSuiteDetailV1;
  issues.push(...summaryIssues(detail), ...getEvaluationSuiteDraftIssues(detail.draft));
  if (
    detail.name !== detail.draft.name ||
    detail.description !== detail.draft.description ||
    detail.caseCount !== detail.draft.cases.length
  ) {
    issues.push("The evaluation suite summary must match its draft.");
  }
  return issues;
}

export function getEvaluationSuiteVersionIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationSuiteVersionV1Schema, value, "Evaluation suite version");
  if (issues.length > 0) return issues;
  const version = value as EvaluationSuiteVersionV1;
  return [...scopeIssues(version), ...actorIssues(version.createdBy)];
}

export function getEvaluationSourceManifestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSourceManifestV1Schema,
    value,
    "Evaluation source manifest",
    maximumEvaluationSourceManifestUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const manifest = value as EvaluationSourceManifestV1;
  return [
    ...scopeIssues(manifest),
    ...uniqueIssues(
      manifest.cases.map((entry) => entry.caseId),
      "Case identifiers",
    ),
  ];
}

export function getEvaluationExpectationManifestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationExpectationManifestV1Schema,
    value,
    "Evaluation expectation manifest",
  );
  if (issues.length > 0) return issues;
  const manifest = value as EvaluationExpectationManifestV1;
  return [...scopeIssues(manifest), ...caseIssues(manifest.cases)];
}

export function getEvaluationSuiteListQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationSuiteListQuerySchema, value, "Evaluation suite list query");
  if (issues.length > 0) return issues;
  const query = value as EvaluationSuiteListQuery;
  if (!Number.isSafeInteger(((query.page ?? 1) - 1) * (query.pageSize ?? 20)))
    issues.push("The evaluation page offset must be a safe integer.");
  return issues;
}

function pageIssues(
  value: EvaluationSuiteListResponse | EvaluationSuiteVersionListResponse,
): string[] {
  const issues = uniqueIssues(
    value.items.map((entry) => entry.id),
    "Page item identifiers",
  );
  const offset = (value.page - 1) * value.pageSize;
  if (
    !Number.isSafeInteger(offset) ||
    value.items.length !== Math.min(value.pageSize, Math.max(0, value.total - offset)) ||
    value.items.some((entry) => entry.repositoryId !== value.repositoryId)
  ) {
    issues.push("The evaluation page items must match their bounds and repository.");
  }
  return issues;
}

export function getEvaluationSuiteListResponseIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSuiteListResponseSchema,
    value,
    "Evaluation suite list response",
  );
  if (issues.length > 0) return issues;
  const response = value as EvaluationSuiteListResponse;
  return [...pageIssues(response), ...response.items.flatMap(getEvaluationSuiteSummaryIssues)];
}

export function getEvaluationSuiteVersionListResponseIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSuiteVersionListResponseSchema,
    value,
    "Evaluation suite version list response",
  );
  if (issues.length > 0) return issues;
  const response = value as EvaluationSuiteVersionListResponse;
  if (response.items.some((entry) => entry.suiteId !== response.suiteId)) {
    issues.push("The evaluation version page items must belong to their suite.");
  }
  return [
    ...issues,
    ...pageIssues(response),
    ...response.items.flatMap(getEvaluationSuiteVersionIssues),
  ];
}

function assertNoIssues(issues: readonly string[]): void {
  if (issues.length > 0) throw new TypeError(issues.join(" "));
}

export function assertEvaluationSuiteDraft(value: unknown): asserts value is EvaluationSuiteDraft {
  assertNoIssues(getEvaluationSuiteDraftIssues(value));
}
export function assertEvaluationSuitePublication(
  value: unknown,
): asserts value is EvaluationSuiteDraft {
  assertNoIssues(getEvaluationSuitePublicationIssues(value));
}
export function assertEvaluationSuiteCreateRequest(
  value: unknown,
): asserts value is EvaluationSuiteCreateRequest {
  assertNoIssues(getEvaluationSuiteCreateRequestIssues(value));
}
export function assertEvaluationSuiteSaveRequest(
  value: unknown,
): asserts value is EvaluationSuiteSaveRequest {
  assertNoIssues(getEvaluationSuiteSaveRequestIssues(value));
}
export function assertEvaluationSuitePublishRequest(
  value: unknown,
): asserts value is EvaluationSuitePublishRequest {
  assertNoIssues(getEvaluationSuitePublishRequestIssues(value));
}
export function assertEvaluationSuiteSummary(
  value: unknown,
): asserts value is EvaluationSuiteSummaryV1 {
  assertNoIssues(getEvaluationSuiteSummaryIssues(value));
}
export function assertEvaluationSuiteDetail(
  value: unknown,
): asserts value is EvaluationSuiteDetailV1 {
  assertNoIssues(getEvaluationSuiteDetailIssues(value));
}
export function assertEvaluationSuiteVersion(
  value: unknown,
): asserts value is EvaluationSuiteVersionV1 {
  assertNoIssues(getEvaluationSuiteVersionIssues(value));
}
export function assertEvaluationSourceManifest(
  value: unknown,
): asserts value is EvaluationSourceManifestV1 {
  assertNoIssues(getEvaluationSourceManifestIssues(value));
}
export function assertEvaluationExpectationManifest(
  value: unknown,
): asserts value is EvaluationExpectationManifestV1 {
  assertNoIssues(getEvaluationExpectationManifestIssues(value));
}
export function assertEvaluationSuiteListQuery(
  value: unknown,
): asserts value is EvaluationSuiteListQuery {
  assertNoIssues(getEvaluationSuiteListQueryIssues(value));
}
export function assertEvaluationSuiteListResponse(
  value: unknown,
): asserts value is EvaluationSuiteListResponse {
  assertNoIssues(getEvaluationSuiteListResponseIssues(value));
}
export function assertEvaluationSuiteVersionListResponse(
  value: unknown,
): asserts value is EvaluationSuiteVersionListResponse {
  assertNoIssues(getEvaluationSuiteVersionListResponseIssues(value));
}
