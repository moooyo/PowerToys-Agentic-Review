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
  EvaluationSourceSnapshotV1Schema,
  getEvaluationSourceSnapshotIssues,
  maximumEvaluationSourceSnapshotUtf8Bytes,
} from "./evaluation-execution.js";
import { GitHubWorkItemKindSchema, GitHubWorkItemSchema } from "./github.js";
import { type OperatorPrincipal, OperatorPrincipalSchema } from "./operator-access.js";

export const maximumEvaluationSourceCaptureRequestUtf8Bytes = 16 * 1024;
export const maximumEvaluationSourceSummaryUtf8Bytes = 64 * 1024;
export const maximumEvaluationSourceDetailUtf8Bytes =
  maximumEvaluationSourceSnapshotUtf8Bytes + maximumEvaluationSourceSummaryUtf8Bytes;
export const maximumEvaluationSourcePageSize = 50;

const ExactCommitSchema = Type.String({
  minLength: 40,
  maxLength: 64,
  pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
});

/** References identify persisted sources; clients cannot supply a claimed source snapshot. */
export const EvaluationSourceReferenceV1Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("current_work_item"),
      workItemId: EntityIdSchema,
      expectedRevisionKey: Sha256Schema,
      testedIssueCommit: Type.Union([ExactCommitSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("review_run"),
      reviewRunId: EntityIdSchema,
      expectedPlanDigest: Sha256Schema,
    },
    { additionalProperties: false },
  ),
]);
export type EvaluationSourceReferenceV1 = Static<typeof EvaluationSourceReferenceV1Schema>;

export const EvaluationSourceCaptureRequestSchema = Type.Object(
  { changeId: EntityIdSchema, source: EvaluationSourceReferenceV1Schema },
  { additionalProperties: false },
);
export type EvaluationSourceCaptureRequest = Static<typeof EvaluationSourceCaptureRequestSchema>;

// Read models describe frozen sources. They do not grant authorization to execute another run.
export const EvaluationSourceSummaryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationSourceSummaryV1"),
    id: EntityIdSchema,
    repositoryId: EntityIdSchema,
    workItemId: EntityIdSchema,
    revisionId: EntityIdSchema,
    revisionKey: Sha256Schema,
    sourceDigest: Sha256Schema,
    workItemKind: GitHubWorkItemKindSchema,
    number: PositiveIntegerSchema,
    title: GitHubWorkItemSchema.anyOf[0].properties.title,
    createdAt: DateTimeSchema,
    createdBy: OperatorPrincipalSchema,
  },
  { additionalProperties: false },
);
export type EvaluationSourceSummaryV1 = Static<typeof EvaluationSourceSummaryV1Schema>;

export const EvaluationSourceDetailV1Schema = Type.Object(
  {
    ...EvaluationSourceSummaryV1Schema.properties,
    snapshot: EvaluationSourceSnapshotV1Schema,
  },
  { additionalProperties: false },
);
export type EvaluationSourceDetailV1 = Static<typeof EvaluationSourceDetailV1Schema>;

const pageSizeSchema = Type.Integer({ minimum: 1, maximum: maximumEvaluationSourcePageSize });
export const EvaluationSourceListQuerySchema = Type.Object(
  { page: Type.Optional(PositiveIntegerSchema), pageSize: Type.Optional(pageSizeSchema) },
  { additionalProperties: false },
);
export type EvaluationSourceListQuery = Static<typeof EvaluationSourceListQuerySchema>;

export const EvaluationSourceListResponseSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    total: NonNegativeIntegerSchema,
    page: PositiveIntegerSchema,
    pageSize: pageSizeSchema,
    items: Type.Array(EvaluationSourceSummaryV1Schema, {
      maxItems: maximumEvaluationSourcePageSize,
    }),
  },
  { additionalProperties: false },
);
export type EvaluationSourceListResponse = Static<typeof EvaluationSourceListResponseSchema>;

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
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (entry) => URL.canParse(entry));
  if (!Value.Check(schema, value))
    return [`${label} is invalid at ${Value.Errors(schema, value).First()?.path || "/"}.`];
  return [];
}

function actorIssues(actor: OperatorPrincipal): string[] {
  return [actor.issuer, actor.subject].some(
    (entry) =>
      entry.trim() !== entry ||
      [...entry].some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      ),
  )
    ? ["An evaluation source operator must have an exact nonempty identity."]
    : [];
}

export function getEvaluationSourceReferenceIssues(value: unknown): string[] {
  return shapeIssues(
    EvaluationSourceReferenceV1Schema,
    value,
    "Evaluation source reference",
    maximumEvaluationSourceCaptureRequestUtf8Bytes,
  );
}

export function getEvaluationSourceCaptureRequestIssues(value: unknown): string[] {
  return shapeIssues(
    EvaluationSourceCaptureRequestSchema,
    value,
    "Evaluation source capture request",
    maximumEvaluationSourceCaptureRequestUtf8Bytes,
  );
}

export function getEvaluationSourceSummaryIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSourceSummaryV1Schema,
    value,
    "Evaluation source summary",
    maximumEvaluationSourceSummaryUtf8Bytes,
  );
  return issues.length > 0 ? issues : actorIssues((value as EvaluationSourceSummaryV1).createdBy);
}

/** Structural and identity consistency only; the owner must recompute the source content digest. */
export function getEvaluationSourceDetailIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSourceDetailV1Schema,
    value,
    "Evaluation source detail",
    maximumEvaluationSourceDetailUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const detail = value as EvaluationSourceDetailV1;
  const { snapshot, ...summary } = detail;
  issues.push(
    ...getEvaluationSourceSummaryIssues(summary),
    ...getEvaluationSourceSnapshotIssues(snapshot),
  );
  if (
    detail.repositoryId !== snapshot.repository.id ||
    detail.workItemId !== snapshot.workItemId ||
    detail.revisionId !== snapshot.revisionId ||
    detail.revisionKey !== snapshot.revision.revisionKey ||
    detail.sourceDigest !== snapshot.sourceDigest ||
    detail.workItemKind !== snapshot.workItem.kind ||
    detail.number !== snapshot.workItem.number ||
    detail.title !== snapshot.workItem.title ||
    detail.createdAt !== snapshot.provenance.capturedAt
  )
    issues.push("The evaluation source summary must match its frozen snapshot and capture time.");
  return issues;
}

export function getEvaluationSourceListQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSourceListQuerySchema,
    value,
    "Evaluation source list query",
    maximumEvaluationSourceCaptureRequestUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const query = value as EvaluationSourceListQuery;
  if (!Number.isSafeInteger(((query.page ?? 1) - 1) * (query.pageSize ?? 20)))
    issues.push("The evaluation source page offset must be a safe integer.");
  return issues;
}

export function getEvaluationSourceListResponseIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSourceListResponseSchema,
    value,
    "Evaluation source list response",
    maximumEvaluationSourceSnapshotUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const response = value as EvaluationSourceListResponse;
  const offset = (response.page - 1) * response.pageSize;
  if (
    !Number.isSafeInteger(offset) ||
    response.items.length !== Math.min(response.pageSize, Math.max(0, response.total - offset)) ||
    response.items.some((entry) => entry.repositoryId !== response.repositoryId)
  )
    issues.push("The evaluation source page items must match their bounds and repository.");
  if (new Set(response.items.map((entry) => entry.id)).size !== response.items.length)
    issues.push("Evaluation source page item identifiers must be unique.");
  return [...issues, ...response.items.flatMap(getEvaluationSourceSummaryIssues)];
}

function assertNoIssues(issues: readonly string[]): void {
  if (issues.length > 0) throw new TypeError(issues.join(" "));
}

export function assertEvaluationSourceReference(
  value: unknown,
): asserts value is EvaluationSourceReferenceV1 {
  assertNoIssues(getEvaluationSourceReferenceIssues(value));
}
export function assertEvaluationSourceCaptureRequest(
  value: unknown,
): asserts value is EvaluationSourceCaptureRequest {
  assertNoIssues(getEvaluationSourceCaptureRequestIssues(value));
}
export function assertEvaluationSourceSummary(
  value: unknown,
): asserts value is EvaluationSourceSummaryV1 {
  assertNoIssues(getEvaluationSourceSummaryIssues(value));
}
export function assertEvaluationSourceDetail(
  value: unknown,
): asserts value is EvaluationSourceDetailV1 {
  assertNoIssues(getEvaluationSourceDetailIssues(value));
}
export function assertEvaluationSourceListQuery(
  value: unknown,
): asserts value is EvaluationSourceListQuery {
  assertNoIssues(getEvaluationSourceListQueryIssues(value));
}
export function assertEvaluationSourceListResponse(
  value: unknown,
): asserts value is EvaluationSourceListResponse {
  assertNoIssues(getEvaluationSourceListResponseIssues(value));
}
