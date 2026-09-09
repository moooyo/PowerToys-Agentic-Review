import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
import { DashboardValidationModelReviewSchema } from "./dashboard-runs.js";
import { EvaluationModelRequirementsV1Schema } from "./evaluation-execution.js";
import { EvaluationArmSchema } from "./evaluation-scoring.js";
import {
  FindingOccurrenceRefSchema,
  maximumFindingResultOccurrenceCount,
} from "./finding-dispositions.js";
import { ValidationTargetSchema, WorkflowKindSchema } from "./platform-configuration.js";
import { ValidationExecutionDetailsSchema, ValidationReportV1Schema } from "./validation-report.js";

export const maximumEvaluationCellResultUtf8Bytes = 2 * 1024 * 1024;
const strict = { additionalProperties: false } as const;
const readScope = {
  repositoryId: EntityIdSchema,
  evaluationId: EntityIdSchema,
  cellId: EntityIdSchema,
  resultId: EntityIdSchema,
};
export const EvaluationCellResultReadQuerySchema = Type.Object(readScope, strict);
export type EvaluationCellResultReadQuery = Static<typeof EvaluationCellResultReadQuerySchema>;

const resultIdentities = {
  ...readScope,
  caseId: EntityIdSchema,
  runId: EntityIdSchema,
  requestId: EntityIdSchema,
  jobId: EntityIdSchema,
  runAttemptId: EntityIdSchema,
  workItemId: EntityIdSchema,
  sourceId: EntityIdSchema,
  profileVersionId: EntityIdSchema,
  promptVersionId: EntityIdSchema,
};
export const EvaluationCellResultV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationCellResultV1"),
    ...resultIdentities,
    arm: EvaluationArmSchema,
    trial: Type.Literal(1),
    resultDigest: Sha256Schema,
    sourceDigest: Sha256Schema,
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    executionDigest: Sha256Schema,
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
    createdAt: DateTimeSchema,
    modelRequirements: EvaluationModelRequirementsV1Schema,
    evidenceComplete: Type.Boolean(),
    evidenceVerificationPending: Type.Optional(Type.Literal(true)),
    report: ValidationReportV1Schema,
    execution: ValidationExecutionDetailsSchema,
    modelReview: DashboardValidationModelReviewSchema,
    occurrences: Type.Array(FindingOccurrenceRefSchema, {
      maxItems: maximumFindingResultOccurrenceCount,
    }),
  },
  strict,
);
export type EvaluationCellResultV1 = Static<typeof EvaluationCellResultV1Schema>;

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

function shapeIssues(schema: TSchema, value: unknown): string[] {
  const invalid = "The evaluation cell result must match its strict JSON contract.";
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
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      maximumEvaluationCellResultUtf8Bytes
    )
      return ["The evaluation cell result exceeds its aggregate UTF-8 byte limit."];
    return [];
  } catch {
    return [invalid];
  }
}

function exactIdentities(values: readonly string[]): string[] {
  return values.every((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/u.test(value))
    ? []
    : ["Evaluation cell result scope identifiers must retain their exact stored identity."];
}

export function getEvaluationCellResultReadQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationCellResultReadQuerySchema, value);
  if (issues.length > 0) return issues;
  const query = value as EvaluationCellResultReadQuery;
  return exactIdentities(Object.values(query));
}

/** Structural and projection consistency only; the owner must verify immutable content digests. */
export function getEvaluationCellResultIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationCellResultV1Schema, value);
  if (issues.length > 0) return issues;
  const result = value as EvaluationCellResultV1;
  issues.push(
    ...exactIdentities(
      (Object.keys(resultIdentities) as (keyof typeof resultIdentities)[]).map(
        (key) => result[key],
      ),
    ),
  );
  if (
    (result.workflowKind !== "issue_validation" &&
      (result.workflowKind === "pr_ui"
        ? result.target === "headless"
        : result.target !== "headless")) ||
    result.report.workItemKind !==
      (result.workflowKind.startsWith("pr_") ? "pull_request" : "issue")
  )
    issues.push("The evaluation cell result report must match its workflow and target scope.");
  if (result.report.modelSummary !== undefined)
    issues.push("The normalized evaluation model review must not be duplicated in the report.");
  if (result.evidenceComplete && result.evidenceVerificationPending === true)
    issues.push("Evaluation evidence cannot be complete while verification is pending.");
  const modelExecution = result.modelReview.execution;
  if (
    modelExecution !== null &&
    (modelExecution.jobId !== result.jobId || modelExecution.runAttemptId !== result.runAttemptId)
  )
    issues.push("CLI execution must belong to the evaluation result's exact job and run attempt.");

  const expected = [
    ...result.modelReview.findings.map((finding, ordinal) => ({
      kind: "pr_finding" as const,
      ordinal,
      originalOrdinal: finding.ordinal,
    })),
    ...result.modelReview.observations.map((_observation, ordinal) => ({
      kind: "validation_observation" as const,
      ordinal,
      originalOrdinal: ordinal,
    })),
  ];
  if (
    result.occurrences.length !== expected.length ||
    new Set(result.occurrences.map((entry) => entry.key)).size !== result.occurrences.length ||
    result.occurrences.some((entry, index) => {
      const original = expected[index];
      return (
        original === undefined ||
        entry.resultId !== result.resultId ||
        entry.resultDigest !== result.resultDigest ||
        entry.kind !== original.kind ||
        entry.ordinal !== original.ordinal ||
        original.originalOrdinal !== original.ordinal
      );
    })
  )
    issues.push(
      "Evaluation finding references must preserve every original model array occurrence and result identity.",
    );
  return issues;
}
