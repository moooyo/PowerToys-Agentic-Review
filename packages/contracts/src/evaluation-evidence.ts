import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { EntityIdSchema } from "./common.js";
import {
  EvaluationCellResultReadQuerySchema,
  EvaluationCellResultV1Schema,
  getEvaluationCellResultReadQueryIssues,
} from "./evaluation-results.js";
import {
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  maximumAttemptEvidenceAssets,
} from "./evidence-assets.js";
import { QualifiedValidationCheckIdSchema } from "./validation-report.js";

export const maximumEvaluationResultEvidenceUtf8Bytes = 2 * 1024 * 1024;
export const maximumEvaluationResultEvidenceAssetCount = maximumAttemptEvidenceAssets;
// A Worker report contains at most 160 checks across its command and UI phases.
export const maximumEvaluationResultEvidenceCheckCount = 160;
const strict = { additionalProperties: false } as const;
const bindingIdentities = [
  "repositoryId",
  "evaluationId",
  "cellId",
  "resultId",
  "runId",
  "requestId",
  "jobId",
  "runAttemptId",
  "profileVersionId",
] as const;

export const EvaluationEvidenceBindingSchema = Type.Pick(
  EvaluationCellResultV1Schema,
  [...bindingIdentities, "resultDigest", "revisionKey", "planDigest"],
  strict,
);
export type EvaluationEvidenceBinding = Static<typeof EvaluationEvidenceBindingSchema>;

const referenceProperties = {
  assetId: EntityIdSchema,
  checkIds: Type.Array(QualifiedValidationCheckIdSchema, {
    minItems: 1,
    maxItems: maximumEvaluationResultEvidenceCheckCount,
    uniqueItems: true,
  }),
};
const evidenceReference = Type.Object(
  {
    ...referenceProperties,
    manifest: Type.Union([EvidenceAssetManifestSchema, Type.Null()]),
  },
  strict,
);
export const EvaluationResultEvidenceListV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationResultEvidenceListV1"),
    binding: EvaluationEvidenceBindingSchema,
    items: Type.Array(evidenceReference, { maxItems: maximumEvaluationResultEvidenceAssetCount }),
  },
  strict,
);
export type EvaluationResultEvidenceListV1 = Static<typeof EvaluationResultEvidenceListV1Schema>;

export const EvaluationResultEvidenceAssetV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationResultEvidenceAssetV1"),
    binding: EvaluationEvidenceBindingSchema,
    ...referenceProperties,
    manifest: EvidenceAssetManifestSchema,
  },
  strict,
);
export type EvaluationResultEvidenceAssetV1 = Static<typeof EvaluationResultEvidenceAssetV1Schema>;

export const EvaluationResultEvidenceAssetQuerySchema = Type.Object(
  { ...EvaluationCellResultReadQuerySchema.properties, assetId: EntityIdSchema },
  strict,
);
export type EvaluationResultEvidenceAssetQuery = Static<
  typeof EvaluationResultEvidenceAssetQuerySchema
>;

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
  const invalid = "Evaluation evidence must match its strict JSON contract.";
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
      maximumEvaluationResultEvidenceUtf8Bytes
    )
      return ["Evaluation evidence exceeds its aggregate UTF-8 byte limit."];
    return [];
  } catch {
    return [invalid];
  }
}

function exactIdentity(value: string): boolean {
  return value.length <= 128 && exactIdentifierText(value);
}

function exactIdentifierText(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/u.test(value);
}

function bindingIssues(binding: EvaluationEvidenceBinding): string[] {
  return bindingIdentities.every((key) => exactIdentity(binding[key]))
    ? []
    : ["Evaluation evidence binding identifiers must retain their exact stored identity."];
}

function referenceIssues(
  binding: EvaluationEvidenceBinding,
  entry: {
    assetId: string;
    checkIds: string[];
    manifest: EvidenceAssetManifest | null;
  },
): string[] {
  const issues: string[] = [];
  const prefix = `${binding.profileVersionId}:`;
  if (
    !exactIdentity(entry.assetId) ||
    entry.checkIds.some(
      (checkId) =>
        !checkId.startsWith(prefix) || !exactIdentifierText(checkId.slice(prefix.length)),
    )
  )
    issues.push("Evaluation evidence references must retain the selected profile and asset scope.");
  const manifest = entry.manifest;
  if (manifest === null) return issues;
  const fields = [
    "repositoryId",
    "runId",
    "requestId",
    "jobId",
    "runAttemptId",
    "profileVersionId",
    "revisionKey",
    "planDigest",
  ] as const;
  if (
    manifest.id !== entry.assetId ||
    fields.some((field) => manifest[field] !== binding[field]) ||
    manifest.metadata.checkId === undefined ||
    entry.checkIds.some((checkId) => checkId !== manifest.metadata.checkId)
  )
    issues.push(
      "The evidence manifest must match the selected result binding and every check reference.",
    );
  if ((manifest.state === "retired") !== (manifest.retiredAt !== null))
    issues.push("Evidence retirement state must agree with its retirement timestamp.");
  return issues;
}

export function getEvaluationResultEvidenceAssetQueryIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationResultEvidenceAssetQuerySchema, value);
  if (issues.length > 0) return issues;
  const { assetId, ...query } = value as EvaluationResultEvidenceAssetQuery;
  issues.push(...getEvaluationCellResultReadQueryIssues(query));
  if (!exactIdentity(assetId))
    issues.push("The evaluation evidence asset selector must retain its exact stored identity.");
  return issues;
}

/** The owner verifies report membership and content bytes; this validates their display projection. */
export function getEvaluationResultEvidenceListIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationResultEvidenceListV1Schema, value);
  if (issues.length > 0) return issues;
  const result = value as EvaluationResultEvidenceListV1;
  issues.push(...bindingIssues(result.binding));
  if (new Set(result.items.map((entry) => entry.assetId)).size !== result.items.length)
    issues.push("Evaluation evidence asset identities must be unique within the selected result.");
  for (const entry of result.items) issues.push(...referenceIssues(result.binding, entry));
  return issues;
}

/** Manifest consistency does not attest that the referenced file still exists or matches its hash. */
export function getEvaluationResultEvidenceAssetIssues(value: unknown): string[] {
  const issues = shapeIssues(EvaluationResultEvidenceAssetV1Schema, value);
  if (issues.length > 0) return issues;
  const result = value as EvaluationResultEvidenceAssetV1;
  return [...bindingIssues(result.binding), ...referenceIssues(result.binding, result)];
}
