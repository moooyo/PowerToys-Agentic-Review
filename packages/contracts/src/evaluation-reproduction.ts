import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
import { EvaluationArmSchema, maximumEvaluationCaseCount } from "./evaluation-scoring.js";
import {
  FrozenIssueReproductionBindingSchema,
  IssueReproductionBindingV1Schema,
  maximumIssueReproductionCaseCount,
  ReproductionObservationRefSchema,
} from "./issue-reproduction.js";
import { OperatorPrincipalSchema } from "./operator-access.js";
import { ValidationProfileVersionSchema } from "./platform-configuration.js";
import { QualifiedValidationCheckIdSchema } from "./validation-report.js";

export const maximumEvaluationReproductionRequestUtf8Bytes = 2 * 1024 * 1024;
export const maximumEvaluationReproductionDocumentUtf8Bytes = 2 * 1024 * 1024 + 32 * 1024;
export const maximumEvaluationReproductionReadUtf8Bytes =
  maximumEvaluationReproductionDocumentUtf8Bytes + 8 * 1024;
export const maximumEvaluationReproductionManifestUtf8Bytes = 256 * 1024;
export const maximumEvaluationReproductionMappingCount = 1536;
const strict = { additionalProperties: false } as const;
const nullableDigest = Type.Union([Sha256Schema, Type.Null()]);
const selectedIds = Type.Array(EntityIdSchema, {
  maxItems: maximumIssueReproductionCaseCount,
  uniqueItems: true,
});
export const EvaluationReproductionObservationMappingV1Schema = Type.Object(
  {
    from: ReproductionObservationRefSchema,
    to: Type.Union([ReproductionObservationRefSchema, Type.Null()]),
  },
  strict,
);
export type EvaluationReproductionObservationMappingV1 = Static<
  typeof EvaluationReproductionObservationMappingV1Schema
>;
export const EvaluationReproductionCheckMappingV1Schema = Type.Object(
  {
    fromCheckId: QualifiedValidationCheckIdSchema,
    toCheckId: Type.Union([QualifiedValidationCheckIdSchema, Type.Null()]),
  },
  strict,
);
export type EvaluationReproductionCheckMappingV1 = Static<
  typeof EvaluationReproductionCheckMappingV1Schema
>;
export const EvaluationReproductionArmMappingsV1Schema = Type.Object(
  {
    observationMappings: Type.Array(EvaluationReproductionObservationMappingV1Schema, {
      maxItems: maximumEvaluationReproductionMappingCount,
    }),
    checkMappings: Type.Array(EvaluationReproductionCheckMappingV1Schema, {
      maxItems: maximumEvaluationReproductionMappingCount,
    }),
  },
  strict,
);
export type EvaluationReproductionArmMappingsV1 = Static<
  typeof EvaluationReproductionArmMappingsV1Schema
>;
export const EvaluationReproductionMappingSelectionV1Schema = Type.Object(
  {
    caseId: EntityIdSchema,
    selectedCaseIds: Type.Array(EntityIdSchema, {
      minItems: 1,
      maxItems: maximumIssueReproductionCaseCount,
      uniqueItems: true,
    }),
    expectedSource: Type.Object(
      { reviewRunId: EntityIdSchema, planDigest: Sha256Schema, bindingDigest: Sha256Schema },
      strict,
    ),
    baseline: EvaluationReproductionArmMappingsV1Schema,
    candidate: EvaluationReproductionArmMappingsV1Schema,
  },
  strict,
);
export type EvaluationReproductionMappingSelectionV1 = Static<
  typeof EvaluationReproductionMappingSelectionV1Schema
>;
export const EvaluationReproductionSourceDefinitionV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationReproductionSourceDefinitionV1"),
    repositoryId: EntityIdSchema,
    sourceId: EntityIdSchema,
    sourceDigest: Sha256Schema,
    reviewRunId: EntityIdSchema,
    planDigest: Sha256Schema,
    bindingDigest: Sha256Schema,
    binding: IssueReproductionBindingV1Schema,
  },
  strict,
);
export type EvaluationReproductionSourceDefinitionV1 = Static<
  typeof EvaluationReproductionSourceDefinitionV1Schema
>;
export const EvaluationReproductionStateSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("blocked"),
  Type.Literal("not_applicable"),
]);
export type EvaluationReproductionState = Static<typeof EvaluationReproductionStateSchema>;
export const EvaluationReproductionBlockerV1Schema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("mapping_missing"),
      Type.Literal("mapping_unmapped"),
      Type.Literal("mapping_invalid"),
      Type.Literal("profile_incompatible"),
      Type.Literal("result_too_large"),
    ]),
    message: Type.String({ minLength: 1, maxLength: 2048 }),
  },
  strict,
);
export type EvaluationReproductionBlockerV1 = Static<typeof EvaluationReproductionBlockerV1Schema>;
export const EvaluationReproductionCellRecordV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationReproductionCellRecordV1"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    caseId: EntityIdSchema,
    cellId: EntityIdSchema,
    arm: EvaluationArmSchema,
    sourceId: EntityIdSchema,
    sourceDefinitionSha256: nullableDigest,
    selectedCaseIds: selectedIds,
    mappings: Type.Union([EvaluationReproductionArmMappingsV1Schema, Type.Null()]),
    state: EvaluationReproductionStateSchema,
    blockers: Type.Array(EvaluationReproductionBlockerV1Schema, { maxItems: 16 }),
    reproduction: Type.Union([FrozenIssueReproductionBindingSchema, Type.Null()]),
  },
  strict,
);
export type EvaluationReproductionCellRecordV1 = Static<
  typeof EvaluationReproductionCellRecordV1Schema
>;
export const EvaluationReproductionManifestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationReproductionManifestV1"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    sources: Type.Array(
      Type.Object(
        { caseId: EntityIdSchema, sourceId: EntityIdSchema, sourceDefinitionSha256: Sha256Schema },
        strict,
      ),
      { maxItems: maximumEvaluationCaseCount },
    ),
    cells: Type.Array(
      Type.Object(
        {
          cellId: EntityIdSchema,
          caseId: EntityIdSchema,
          arm: EvaluationArmSchema,
          cellRecordSha256: Sha256Schema,
        },
        strict,
      ),
      { minItems: 2, maxItems: maximumEvaluationCaseCount * 2 },
    ),
  },
  strict,
);
export type EvaluationReproductionManifestV1 = Static<
  typeof EvaluationReproductionManifestV1Schema
>;
export const EvaluationReproductionSourceDefinitionReadV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationReproductionSourceDefinitionReadV1"),
    repositoryId: EntityIdSchema,
    sourceId: EntityIdSchema,
    sourceDefinition: Type.Union([EvaluationReproductionSourceDefinitionV1Schema, Type.Null()]),
    sourceDefinitionSha256: nullableDigest,
  },
  strict,
);
export type EvaluationReproductionSourceDefinitionReadV1 = Static<
  typeof EvaluationReproductionSourceDefinitionReadV1Schema
>;
export const EvaluationReproductionCellDetailV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationReproductionCellDetailV1"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    cellId: EntityIdSchema,
    record: EvaluationReproductionCellRecordV1Schema,
    cellRecordSha256: Sha256Schema,
  },
  strict,
);
export type EvaluationReproductionCellDetailV1 = Static<
  typeof EvaluationReproductionCellDetailV1Schema
>;
export const EvaluationReproductionPlanV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationReproductionPlanV1"),
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    manifest: Type.Union([EvaluationReproductionManifestV1Schema, Type.Null()]),
  },
  strict,
);
export type EvaluationReproductionPlanV1 = Static<typeof EvaluationReproductionPlanV1Schema>;
export const EvaluationReproductionPreviewRequestSchema = Type.Object(
  {
    sourceId: EntityIdSchema,
    selection: EvaluationReproductionMappingSelectionV1Schema,
    baselineProfileVersionId: EntityIdSchema,
    candidateProfileVersionId: EntityIdSchema,
  },
  strict,
);
export type EvaluationReproductionPreviewRequest = Static<
  typeof EvaluationReproductionPreviewRequestSchema
>;
const previewArmSchema = Type.Object(
  {
    profileVersionId: EntityIdSchema,
    profileConfigSha256: Sha256Schema,
    state: EvaluationReproductionStateSchema,
    blockers: Type.Array(EvaluationReproductionBlockerV1Schema, { maxItems: 16 }),
  },
  strict,
);
export const EvaluationReproductionPreviewV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationReproductionPreviewV1"),
    repositoryId: EntityIdSchema,
    sourceId: EntityIdSchema,
    sourceDefinitionSha256: Sha256Schema,
    baseline: previewArmSchema,
    candidate: previewArmSchema,
  },
  strict,
);
export type EvaluationReproductionPreviewV1 = Static<typeof EvaluationReproductionPreviewV1Schema>;

function data(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value) || ancestors.size > 64) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors).filter(
    ([key]) => !Array.isArray(value) || key !== "length",
  );
  if (
    Array.isArray(value) &&
    (entries.length !== descriptors.length?.value ||
      entries.some(([key], index) => key !== String(index)))
  )
    return false;
  ancestors.add(value);
  const valid = entries.every(
    ([key, descriptor]) =>
      key.isWellFormed() &&
      descriptor.enumerable &&
      "value" in descriptor &&
      data(descriptor.value, ancestors),
  );
  ancestors.delete(value);
  return valid;
}
function shape(
  schema: TSchema,
  value: unknown,
  maximumBytes = maximumEvaluationReproductionDocumentUtf8Bytes,
): string[] {
  if (!data(value)) return ["Evaluation reproduction must contain passive well-formed JSON data."];
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set(
      "date-time",
      (text) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text) &&
        Number.isFinite(Date.parse(text)),
    );
  if (!Value.Check(schema, value))
    return ["Evaluation reproduction does not match its strict schema."];
  return new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes
    ? ["Evaluation reproduction exceeds its aggregate UTF-8 byte limit."]
    : [];
}
const key = (value: unknown): string => JSON.stringify(value);
const unique = (values: string[]): boolean => new Set(values).size === values.length;
export const getEvaluationReproductionObservationMappingIssues = (value: unknown) =>
  shape(EvaluationReproductionObservationMappingV1Schema, value);
export const getEvaluationReproductionCheckMappingIssues = (value: unknown) =>
  shape(EvaluationReproductionCheckMappingV1Schema, value);
export function getEvaluationReproductionArmMappingsIssues(value: unknown): string[] {
  const issues = shape(
    EvaluationReproductionArmMappingsV1Schema,
    value,
    maximumEvaluationReproductionRequestUtf8Bytes,
  );
  if (issues.length) return issues;
  const mappings = value as EvaluationReproductionArmMappingsV1;
  return unique(mappings.observationMappings.map((entry) => observationKey(entry.from))) &&
    unique(mappings.checkMappings.map((entry) => entry.fromCheckId))
    ? []
    : ["Reproduction mappings must name each source reference at most once."];
}
function observationKey(value: EvaluationReproductionObservationMappingV1["from"]): string {
  return value.kind === "probe_value"
    ? key([value.kind, value.testStepId, value.observationId])
    : key([value.kind, value.scenarioId, value.stepId]);
}
export function getEvaluationReproductionMappingSelectionIssues(value: unknown): string[] {
  const issues = shape(
    EvaluationReproductionMappingSelectionV1Schema,
    value,
    maximumEvaluationReproductionRequestUtf8Bytes,
  );
  if (issues.length) return issues;
  const selection = value as EvaluationReproductionMappingSelectionV1;
  return [
    ...getEvaluationReproductionArmMappingsIssues(selection.baseline),
    ...getEvaluationReproductionArmMappingsIssues(selection.candidate),
  ];
}
export function getEvaluationReproductionSourceDefinitionIssues(value: unknown): string[] {
  const issues = shape(EvaluationReproductionSourceDefinitionV1Schema, value);
  if (issues.length) return issues;
  const definition = value as EvaluationReproductionSourceDefinitionV1;
  return definition.repositoryId === definition.binding.repositoryId
    ? []
    : ["The reproduction definition must belong to its source repository."];
}
export function getEvaluationReproductionCellRecordIssues(value: unknown): string[] {
  const issues = shape(EvaluationReproductionCellRecordV1Schema, value);
  if (issues.length) return issues;
  const record = value as EvaluationReproductionCellRecordV1;
  if ((record.mappings === null) !== (record.selectedCaseIds.length === 0))
    issues.push("A reproduction selection and its arm mappings must be retained together.");
  if (record.mappings !== null)
    issues.push(...getEvaluationReproductionArmMappingsIssues(record.mappings));
  if (record.state === "ready") {
    if (
      record.sourceDefinitionSha256 === null ||
      record.mappings === null ||
      record.selectedCaseIds.length === 0 ||
      record.reproduction === null ||
      record.blockers.length > 0
    )
      issues.push("Ready reproduction records require complete mappings and a frozen binding.");
    if (
      record.reproduction !== null &&
      (record.reproduction.binding.repositoryId !== record.repositoryId ||
        !unique(record.reproduction.binding.cases.map((entry) => entry.id)) ||
        key([...record.selectedCaseIds].sort()) !==
          key(record.reproduction.binding.cases.map((entry) => entry.id).sort()))
    )
      issues.push(
        "The reproduction binding must retain exactly the selected cases and repository.",
      );
  } else if (
    record.reproduction !== null ||
    (record.state === "blocked"
      ? record.blockers.length === 0 || record.sourceDefinitionSha256 === null
      : record.blockers.length > 0)
  )
    issues.push("Blocked or inapplicable reproduction records cannot contain a completed binding.");
  if (
    record.sourceDefinitionSha256 === null &&
    (record.state !== "not_applicable" ||
      record.mappings !== null ||
      record.selectedCaseIds.length > 0)
  )
    issues.push("A source without reproduction cannot contain mappings or selected cases.");
  return issues;
}
export function getEvaluationReproductionManifestIssues(value: unknown): string[] {
  const issues = shape(
    EvaluationReproductionManifestV1Schema,
    value,
    maximumEvaluationReproductionManifestUtf8Bytes,
  );
  if (issues.length) return issues;
  const manifest = value as EvaluationReproductionManifestV1;
  if (
    !unique(manifest.sources.map((entry) => entry.caseId)) ||
    !unique(manifest.cells.map((entry) => entry.cellId)) ||
    !unique(manifest.cells.map((entry) => key([entry.caseId, entry.arm])))
  )
    issues.push("Reproduction manifest identities must be unique.");
  const cases = new Set(manifest.cells.map((entry) => entry.caseId));
  if (
    manifest.sources.some((entry) => !cases.has(entry.caseId)) ||
    manifest.cells.length !== cases.size * 2
  )
    issues.push("A reproduction manifest must retain both arms for each case.");
  return issues;
}
export function getEvaluationReproductionSourceDefinitionReadIssues(value: unknown): string[] {
  const issues = shape(
    EvaluationReproductionSourceDefinitionReadV1Schema,
    value,
    maximumEvaluationReproductionReadUtf8Bytes,
  );
  if (issues.length) return issues;
  const read = value as EvaluationReproductionSourceDefinitionReadV1;
  if ((read.sourceDefinition === null) !== (read.sourceDefinitionSha256 === null))
    issues.push("Source definition and digest must be present together.");
  if (read.sourceDefinition !== null) {
    issues.push(...getEvaluationReproductionSourceDefinitionIssues(read.sourceDefinition));
    if (
      read.repositoryId !== read.sourceDefinition.repositoryId ||
      read.sourceId !== read.sourceDefinition.sourceId
    )
      issues.push("Source definition read scope differs from the retained record.");
  }
  return issues;
}
export function getEvaluationReproductionCellDetailIssues(value: unknown): string[] {
  const issues = shape(
    EvaluationReproductionCellDetailV1Schema,
    value,
    maximumEvaluationReproductionReadUtf8Bytes,
  );
  if (issues.length) return issues;
  const detail = value as EvaluationReproductionCellDetailV1;
  issues.push(...getEvaluationReproductionCellRecordIssues(detail.record));
  if (
    detail.evaluationId !== detail.record.evaluationId ||
    detail.repositoryId !== detail.record.repositoryId ||
    detail.cellId !== detail.record.cellId
  )
    issues.push("Reproduction detail scope differs from its cell record.");
  return issues;
}
export function getEvaluationReproductionPlanIssues(value: unknown): string[] {
  const issues = shape(
    EvaluationReproductionPlanV1Schema,
    value,
    maximumEvaluationReproductionManifestUtf8Bytes + 8 * 1024,
  );
  if (issues.length) return issues;
  const plan = value as EvaluationReproductionPlanV1;
  if (plan.manifest !== null) {
    issues.push(...getEvaluationReproductionManifestIssues(plan.manifest));
    if (
      plan.repositoryId !== plan.manifest.repositoryId ||
      plan.evaluationId !== plan.manifest.evaluationId
    )
      issues.push("Reproduction plan scope differs from its manifest.");
  }
  return issues;
}
export function getEvaluationReproductionPreviewRequestIssues(value: unknown): string[] {
  const issues = shape(
    EvaluationReproductionPreviewRequestSchema,
    value,
    maximumEvaluationReproductionRequestUtf8Bytes,
  );
  return issues.length
    ? issues
    : getEvaluationReproductionMappingSelectionIssues(
        (value as EvaluationReproductionPreviewRequest).selection,
      );
}
export function getEvaluationReproductionPreviewIssues(value: unknown): string[] {
  const issues = shape(
    EvaluationReproductionPreviewV1Schema,
    value,
    maximumEvaluationReproductionReadUtf8Bytes,
  );
  if (issues.length) return issues;
  const preview = value as EvaluationReproductionPreviewV1;
  for (const arm of [preview.baseline, preview.candidate]) {
    if ((arm.state === "blocked") !== arm.blockers.length > 0)
      issues.push("Only blocked preview arms must contain blockers.");
  }
  return issues;
}
/** Pure construction metadata; this shape is not an execution authorization or HTTP request. */
export function getEvaluationReproductionBindingContextIssues(value: unknown): string[] {
  return shape(
    Type.Object(
      {
        activationId: EntityIdSchema,
        requestId: EntityIdSchema,
        profileVersion: ValidationProfileVersionSchema,
        actor: OperatorPrincipalSchema,
        authorizedAt: DateTimeSchema,
      },
      strict,
    ),
    value,
  );
}
