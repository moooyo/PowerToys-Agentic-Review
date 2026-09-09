import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
import {
  EvaluationModelRequirementsV1Schema,
  getEvaluationModelRuntimeRegistrationIssues,
} from "./evaluation-execution.js";
import {
  EvaluationReproductionMappingSelectionV1Schema,
  EvaluationReproductionStateSchema,
  getEvaluationReproductionMappingSelectionIssues,
} from "./evaluation-reproduction.js";
import {
  EvaluationArmSchema,
  maximumEvaluationCaseCount,
  maximumEvaluationCriterionCount,
} from "./evaluation-scoring.js";
import { ModelRuntimeRegistrationV1Schema } from "./model-runtime-registry.js";
import { OperatorPrincipalSchema } from "./operator-access.js";
import {
  ValidationProfileVersionSchema,
  ValidationTargetSchema,
  WorkflowKindSchema,
} from "./platform-configuration.js";
import { ReviewRunPromptSnapshotSchema } from "./review-run.js";
import { QualifiedValidationCheckIdSchema } from "./validation-report.js";

export const maximumEvaluationBatchRequestUtf8Bytes = 2 * 1024 * 1024;
export const maximumEvaluationBatchPlanUtf8Bytes = 64 * 1024 * 1024;
const strict = { additionalProperties: false } as const;
const nullableCheckId = Type.Union([QualifiedValidationCheckIdSchema, Type.Null()]);
export const EvaluationBatchModeSchema = Type.Union([
  Type.Literal("prompt_and_profile"),
  Type.Literal("profile_only"),
]);
export type EvaluationBatchMode = Static<typeof EvaluationBatchModeSchema>;
export const EvaluationConfigurationSelectionSchema = Type.Object(
  {
    profileVersionId: EntityIdSchema,
    promptVersionId: EntityIdSchema,
    modelRuntimeRegistrationId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
      }),
    ),
  },
  strict,
);
export type EvaluationConfigurationSelection = Static<
  typeof EvaluationConfigurationSelectionSchema
>;
export const EvaluationCriterionMappingSchema = Type.Object(
  {
    caseId: EntityIdSchema,
    criterionId: EntityIdSchema,
    baselineCheckId: nullableCheckId,
    candidateCheckId: nullableCheckId,
  },
  strict,
);
export type EvaluationCriterionMapping = Static<typeof EvaluationCriterionMappingSchema>;

// Clients select published identities and explicit assessment mappings. They cannot provide
// captured snapshots, runtime attestations, execution authority, cell IDs, or claimed results.
export const EvaluationBatchCreateRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    suiteId: EntityIdSchema,
    suiteVersionId: EntityIdSchema,
    baseline: EvaluationConfigurationSelectionSchema,
    candidate: EvaluationConfigurationSelectionSchema,
    mode: EvaluationBatchModeSchema,
    checkMappings: Type.Array(EvaluationCriterionMappingSchema, {
      maxItems: maximumEvaluationCaseCount * maximumEvaluationCriterionCount,
    }),
    reproductionMappings: Type.Optional(
      Type.Array(EvaluationReproductionMappingSelectionV1Schema, {
        maxItems: maximumEvaluationCaseCount,
      }),
    ),
  },
  strict,
);
export type EvaluationBatchCreateRequest = Static<typeof EvaluationBatchCreateRequestSchema>;

export const EvaluationBatchSummaryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationBatchSummaryV1"),
    id: EntityIdSchema,
    repositoryId: EntityIdSchema,
    suiteId: EntityIdSchema,
    suiteVersionId: EntityIdSchema,
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
    mode: EvaluationBatchModeSchema,
    baseline: EvaluationConfigurationSelectionSchema,
    candidate: EvaluationConfigurationSelectionSchema,
    caseCount: Type.Integer({ minimum: 1, maximum: maximumEvaluationCaseCount }),
    cellCount: Type.Integer({ minimum: 2, maximum: maximumEvaluationCaseCount * 2 }),
    createdAt: DateTimeSchema,
    createdBy: OperatorPrincipalSchema,
  },
  strict,
);
export type EvaluationBatchSummaryV1 = Static<typeof EvaluationBatchSummaryV1Schema>;

export const EvaluationBatchCancelRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    expectedVersion: Type.Literal(1),
    reason: Type.String({
      minLength: 1,
      maxLength: 2048,
      pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]+$",
    }),
  },
  strict,
);
export type EvaluationBatchCancelRequest = Static<typeof EvaluationBatchCancelRequestSchema>;
export const EvaluationBatchCancellationV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationBatchCancellationV1"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    status: Type.Literal("cancelled"),
    version: Type.Literal(2),
    reason: EvaluationBatchCancelRequestSchema.properties.reason,
    cancelledAt: DateTimeSchema,
    cancelledBy: OperatorPrincipalSchema,
    cancelledJobCount: Type.Integer({ minimum: 0, maximum: maximumEvaluationCaseCount * 2 }),
    cancellationRequestedJobCount: Type.Integer({
      minimum: 0,
      maximum: maximumEvaluationCaseCount * 2,
    }),
  },
  strict,
);
export type EvaluationBatchCancellationV1 = Static<typeof EvaluationBatchCancellationV1Schema>;

export const EvaluationFrozenConfigurationSchema = Type.Object(
  {
    profileVersion: ValidationProfileVersionSchema,
    prompt: ReviewRunPromptSnapshotSchema,
    modelRequirements: EvaluationModelRequirementsV1Schema,
    modelRuntimeRegistration: Type.Optional(ModelRuntimeRegistrationV1Schema),
  },
  strict,
);
export type EvaluationFrozenConfiguration = Static<typeof EvaluationFrozenConfigurationSchema>;
export function getEvaluationFrozenConfigurationIssues(value: unknown): string[] {
  if (!wellFormed(value) || typeof value !== "object" || value === null || Array.isArray(value))
    return ["The evaluation frozen configuration must match its strict JSON contract."];
  const candidate = value as Record<string, unknown>;
  const issues = getEvaluationModelRuntimeRegistrationIssues(
    candidate.modelRequirements,
    candidate.modelRuntimeRegistration,
  );
  if (!Value.Check(EvaluationFrozenConfigurationSchema, value))
    return ["The evaluation frozen configuration must match its strict JSON contract."];
  return issues;
}
export const EvaluationConfigurationManifestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationConfigurationManifestV1"),
    repositoryId: EntityIdSchema,
    mode: EvaluationBatchModeSchema,
    baseline: EvaluationFrozenConfigurationSchema,
    candidate: EvaluationFrozenConfigurationSchema,
  },
  strict,
);
export type EvaluationConfigurationManifestV1 = Static<
  typeof EvaluationConfigurationManifestV1Schema
>;
export const EvaluationCellManifestEntryV1Schema = Type.Object(
  {
    cellId: EntityIdSchema,
    caseId: EntityIdSchema,
    arm: EvaluationArmSchema,
    trial: Type.Literal(1),
    sourceId: EntityIdSchema,
    sourceDigest: Sha256Schema,
    runId: EntityIdSchema,
    requestId: EntityIdSchema,
    activationId: EntityIdSchema,
    profileVersionId: EntityIdSchema,
    promptVersionId: EntityIdSchema,
    renderedPromptDigest: Sha256Schema,
    outputSchemaDigest: Sha256Schema,
    modelRequirements: EvaluationModelRequirementsV1Schema,
  },
  strict,
);
export type EvaluationCellManifestEntryV1 = Static<typeof EvaluationCellManifestEntryV1Schema>;
export const EvaluationCellManifestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationCellManifestV1"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    cells: Type.Array(EvaluationCellManifestEntryV1Schema, {
      minItems: 2,
      maxItems: maximumEvaluationCaseCount * 2,
    }),
  },
  strict,
);
export type EvaluationCellManifestV1 = Static<typeof EvaluationCellManifestV1Schema>;
export const EvaluationCellManifestEntryV2Schema = Type.Object(
  {
    ...EvaluationCellManifestEntryV1Schema.properties,
    reproduction: Type.Object(
      {
        state: EvaluationReproductionStateSchema,
        bindingDigest: Type.Union([Sha256Schema, Type.Null()]),
        cellRecordSha256: Sha256Schema,
      },
      strict,
    ),
  },
  strict,
);
export type EvaluationCellManifestEntryV2 = Static<typeof EvaluationCellManifestEntryV2Schema>;
export const EvaluationCellManifestV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationCellManifestV2"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    reproductionManifestSha256: Sha256Schema,
    cells: Type.Array(EvaluationCellManifestEntryV2Schema, {
      minItems: 2,
      maxItems: maximumEvaluationCaseCount * 2,
    }),
  },
  strict,
);
export type EvaluationCellManifestV2 = Static<typeof EvaluationCellManifestV2Schema>;
export const EvaluationCellManifestSchema = Type.Union([
  EvaluationCellManifestV1Schema,
  EvaluationCellManifestV2Schema,
]);
export type EvaluationCellManifest = Static<typeof EvaluationCellManifestSchema>;
export const EvaluationCellManifestEntrySchema = Type.Union([
  EvaluationCellManifestEntryV1Schema,
  EvaluationCellManifestEntryV2Schema,
]);
export type EvaluationCellManifestEntry = Static<typeof EvaluationCellManifestEntrySchema>;
export const EvaluationExecutionManifestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationExecutionManifestV1"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    sampleSetVersionId: EntityIdSchema,
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
    sourceManifestSha256: Sha256Schema,
    configurationManifestSha256: Sha256Schema,
    cellManifestSha256: Sha256Schema,
    trial: Type.Literal(1),
    upstreamMutationPolicy: Type.Literal("forbidden"),
  },
  strict,
);
export type EvaluationExecutionManifestV1 = Static<typeof EvaluationExecutionManifestV1Schema>;

function wellFormed(value: unknown, ancestors = new Set<object>()): boolean {
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
  if (Object.getOwnPropertySymbols(value).length) return false;
  ancestors.add(value);
  const result = Array.isArray(value)
    ? [...value].every((entry) => wellFormed(entry, ancestors))
    : Object.entries(value).every(
        ([key, entry]) => key.isWellFormed() && wellFormed(entry, ancestors),
      );
  ancestors.delete(value);
  return result;
}

export function getEvaluationBatchCreateRequestIssues(value: unknown): string[] {
  if (!wellFormed(value) || !Value.Check(EvaluationBatchCreateRequestSchema, value))
    return ["The evaluation batch request must match its strict JSON contract."];
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    maximumEvaluationBatchRequestUtf8Bytes
  )
    return ["The evaluation batch request exceeds its aggregate UTF-8 byte limit."];
  const keys = value.checkMappings.map((entry) =>
    JSON.stringify([entry.caseId, entry.criterionId]),
  );
  const issues =
    new Set(keys).size === keys.length
      ? []
      : ["Each case criterion requires exactly one explicit mapping."];
  const cases = new Map<string, Set<string>>();
  for (const mapping of value.checkMappings) {
    const criteria = cases.get(mapping.caseId) ?? new Set<string>();
    criteria.add(mapping.criterionId);
    cases.set(mapping.caseId, criteria);
    for (const arm of ["baseline", "candidate"] as const) {
      const checkId = mapping[`${arm}CheckId`];
      const prefix = `${value[arm].profileVersionId}:`;
      // Both profile and local check identities may contain colons. Resolve using the complete
      // selected profile prefix; only the owner can verify membership in its published checks.
      if (
        checkId !== null &&
        (!checkId.startsWith(prefix) || !Value.Check(EntityIdSchema, checkId.slice(prefix.length)))
      ) {
        issues.push(`The ${arm} mapping must qualify a check from its selected profile version.`);
      }
    }
  }
  if (cases.size > maximumEvaluationCaseCount)
    issues.push("The evaluation mappings exceed the case limit.");
  if ([...cases.values()].some((criteria) => criteria.size > maximumEvaluationCriterionCount))
    issues.push("The evaluation mappings exceed the per-case criterion limit.");
  const reproduction = value.reproductionMappings ?? [];
  if (new Set(reproduction.map((entry) => entry.caseId)).size !== reproduction.length)
    issues.push("Each evaluation case requires at most one reproduction mapping selection.");
  for (const selection of reproduction)
    issues.push(...getEvaluationReproductionMappingSelectionIssues(selection));
  return issues;
}

export function getEvaluationCellManifestIssues(value: unknown): string[] {
  if (!wellFormed(value) || !Value.Check(EvaluationCellManifestSchema, value))
    return ["The evaluation cell manifest must match its strict versioned schema."];
  const issues: string[] = [];
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024)
    issues.push("The evaluation cell manifest exceeds its aggregate UTF-8 byte limit.");
  if (
    new Set(value.cells.map((entry) => entry.cellId)).size !== value.cells.length ||
    new Set(value.cells.map((entry) => JSON.stringify([entry.caseId, entry.arm]))).size !==
      value.cells.length ||
    new Set(value.cells.map((entry) => entry.caseId)).size * 2 !== value.cells.length
  )
    issues.push("The evaluation cell manifest must contain unique paired arms.");
  if (
    value.schemaVersion === "EvaluationCellManifestV2" &&
    value.cells.some(
      (entry) =>
        (entry.reproduction.state === "ready") !== (entry.reproduction.bindingDigest !== null),
    )
  )
    issues.push("Only ready cell mappings may reference a reproduction binding.");
  return issues;
}

export function assertEvaluationBatchCreateRequest(
  value: unknown,
): asserts value is EvaluationBatchCreateRequest {
  const issues = getEvaluationBatchCreateRequestIssues(value);
  if (issues.length) throw new TypeError(issues.join(" "));
}
