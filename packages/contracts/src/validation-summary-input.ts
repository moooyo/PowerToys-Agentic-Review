import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { GitHubNumericIdSchema, Sha256Schema } from "./common.js";
import { EvidenceAssetManifestSchema } from "./evidence-assets.js";
import {
  FrozenIssueReproductionBindingSchema,
  IssueReproductionRequestAssessmentV1Schema,
  TestProbeReceiptV1Schema,
} from "./issue-reproduction.js";
import { ValidationSummaryInputReferenceV1Schema } from "./model-summary-input-reference.js";
import { ReviewRunTestedSourceRevisionSchema } from "./review-run.js";
import { UiScenarioExecutionEvidenceV1Schema } from "./ui-scenarios.js";
import {
  QualifiedValidationCheckIdSchema,
  ValidationExecutionDetailsSchema,
  ValidationReportV1Schema,
} from "./validation-report.js";
import { LeaseIdentitySchema } from "./worker.js";

export {
  type ValidationSummaryInputReferenceV1,
  ValidationSummaryInputReferenceV1Schema,
} from "./model-summary-input-reference.js";

export const maximumValidationSummaryContextUtf8Bytes = 256 * 1024;
export const maximumFrozenValidationSummaryInputUtf8Bytes =
  maximumValidationSummaryContextUtf8Bytes + 32 * 1024;
export const maximumFreezeValidationSummaryInputRequestUtf8Bytes =
  maximumFrozenValidationSummaryInputUtf8Bytes;
export const maximumValidationSummaryInputReceiptUtf8Bytes = 32 * 1024;
const strict = { additionalProperties: false } as const;
const identifier = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
});
const timestamp = Type.String({
  minLength: 24,
  maxLength: 24,
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z(?![\\s\\S])",
});

export const ValidationSummaryContextV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ValidationSummaryContextV1"),
    runId: identifier,
    requestId: identifier,
    jobId: identifier,
    runAttemptId: identifier,
    githubRepositoryId: GitHubNumericIdSchema,
    profileVersionId: identifier,
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    testedSourceRevision: Type.Union([ReviewRunTestedSourceRevisionSchema, Type.Null()]),
    report: ValidationReportV1Schema,
    execution: ValidationExecutionDetailsSchema,
    evidence: Type.Object(
      {
        assets: Type.Array(EvidenceAssetManifestSchema, { maxItems: 256 }),
        scenarios: Type.Array(
          Type.Object(
            {
              checkId: QualifiedValidationCheckIdSchema,
              execution: UiScenarioExecutionEvidenceV1Schema,
            },
            strict,
          ),
          { maxItems: 32 },
        ),
      },
      strict,
    ),
    reproduction: Type.Optional(FrozenIssueReproductionBindingSchema),
    observationResults: Type.Optional(
      Type.Object(
        {
          probeReceipts: Type.Optional(Type.Array(TestProbeReceiptV1Schema, { maxItems: 256 })),
          reproductionAssessment: Type.Optional(IssueReproductionRequestAssessmentV1Schema),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type ValidationSummaryContextV1 = Static<typeof ValidationSummaryContextV1Schema>;

export const FrozenValidationSummaryInputV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("FrozenValidationSummaryInputV1"),
    inputId: identifier,
    repositoryId: identifier,
    evaluationId: identifier,
    cellId: identifier,
    authorizationId: identifier,
    executionManifestSha256: Sha256Schema,
    workerNodeId: identifier,
    workerInstanceId: identifier,
    leaseGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    sourcePromptSha256: Sha256Schema,
    outputSchemaSha256: Sha256Schema,
    contextSha256: Sha256Schema,
    actualPromptSha256: Sha256Schema,
    context: ValidationSummaryContextV1Schema,
    frozenAt: timestamp,
  },
  strict,
);
export type FrozenValidationSummaryInputV1 = Static<typeof FrozenValidationSummaryInputV1Schema>;

export const FreezeValidationSummaryInputRequestSchema = Type.Object(
  {
    lease: LeaseIdentitySchema,
    inputId: identifier,
    context: ValidationSummaryContextV1Schema,
  },
  strict,
);
export type FreezeValidationSummaryInputRequest = Static<
  typeof FreezeValidationSummaryInputRequestSchema
>;
export const FreezeValidationSummaryInputResponseSchema = Type.Object(
  {
    schemaVersion: Type.Literal("FreezeValidationSummaryInputResponseV1"),
    reference: ValidationSummaryInputReferenceV1Schema,
    frozenAt: timestamp,
  },
  strict,
);
export type FreezeValidationSummaryInputResponse = Static<
  typeof FreezeValidationSummaryInputResponseSchema
>;

function passiveJson(
  value: unknown,
  ancestors = new Set<object>(),
  budget = { nodes: 0, bytes: 0 },
): boolean {
  if (++budget.nodes > 100000 || ancestors.size > 64) return false;
  if (typeof value === "string") {
    if (!value.isWellFormed()) return false;
    budget.bytes += new TextEncoder().encode(value).length;
    return budget.bytes <= maximumFrozenValidationSummaryInputUtf8Bytes;
  }
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    return false;
  if (
    Array.isArray(value)
      ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
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
  ancestors.add(value);
  const valid = entries.every(
    ([key, descriptor]) =>
      descriptor.enumerable &&
      "value" in descriptor &&
      passiveJson(key, ancestors, budget) &&
      passiveJson(descriptor.value, ancestors, budget),
  );
  ancestors.delete(value);
  return valid;
}
function shapeIssues(schema: TSchema, value: unknown, maximum: number): string[] {
  try {
    if (
      !passiveJson(value) ||
      !Value.Check(schema, value) ||
      new TextEncoder().encode(JSON.stringify(value)).length > maximum
    )
      return ["Validation summary input must be bounded, passive JSON matching its exact schema."];
    return [];
  } catch {
    return ["Validation summary input must be bounded, passive JSON matching its exact schema."];
  }
}
function exactTime(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Structural consistency only. The database owner checks frozen intent, authority, and evidence. */
export function getValidationSummaryContextIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ValidationSummaryContextV1Schema,
    value,
    maximumValidationSummaryContextUtf8Bytes,
  );
  if (issues.length) return issues;
  const context = value as ValidationSummaryContextV1;
  if (
    context.report.modelSummary !== undefined ||
    context.report.checks.some((check) => check.source !== "runner")
  )
    issues.push("Summary input must contain runner facts without prior model advice.");
  if (
    context.execution.blockers.some((item) => item.phase === "model_review") ||
    context.execution.diagnostics.some((item) => item.phase === "model_review")
  )
    issues.push("Summary input must precede model-stage lifecycle observations.");
  for (const identifiers of [
    context.report.checks.map((item) => item.id),
    context.evidence.assets.map((item) => item.id),
    context.evidence.scenarios.map((item) => item.checkId),
  ])
    if (new Set(identifiers).size !== identifiers.length)
      issues.push("Summary input contains duplicate check or evidence identities.");
  for (const asset of context.evidence.assets) {
    if (
      asset.jobId !== context.jobId ||
      asset.runAttemptId !== context.runAttemptId ||
      asset.runId !== context.runId ||
      asset.requestId !== context.requestId ||
      asset.profileVersionId !== context.profileVersionId ||
      asset.planDigest !== context.planDigest ||
      asset.revisionKey !== context.revisionKey
    )
      issues.push("Summary evidence must belong to the same frozen attempt and profile.");
  }
  return issues;
}
export function getFreezeValidationSummaryInputRequestIssues(value: unknown): string[] {
  const issues = shapeIssues(
    FreezeValidationSummaryInputRequestSchema,
    value,
    maximumFreezeValidationSummaryInputRequestUtf8Bytes,
  );
  if (issues.length) return issues;
  const request = value as FreezeValidationSummaryInputRequest;
  issues.push(...getValidationSummaryContextIssues(request.context));
  if (
    request.context.jobId !== request.lease.jobId ||
    request.context.runAttemptId !== request.lease.runAttemptId
  )
    issues.push("Summary input must match its authenticated lease attempt.");
  if (JSON.stringify(request.context).includes(request.lease.leaseToken))
    issues.push("Summary context cannot contain the lease credential.");
  return issues;
}
export function getFrozenValidationSummaryInputIssues(value: unknown): string[] {
  const issues = shapeIssues(
    FrozenValidationSummaryInputV1Schema,
    value,
    maximumFrozenValidationSummaryInputUtf8Bytes,
  );
  if (issues.length) return issues;
  const document = value as FrozenValidationSummaryInputV1;
  issues.push(...getValidationSummaryContextIssues(document.context));
  if (!exactTime(document.frozenAt))
    issues.push("Frozen summary input must retain an exact timestamp.");
  return issues;
}
export function getFreezeValidationSummaryInputResponseIssues(value: unknown): string[] {
  const issues = shapeIssues(
    FreezeValidationSummaryInputResponseSchema,
    value,
    maximumValidationSummaryInputReceiptUtf8Bytes,
  );
  if (issues.length) return issues;
  if (!exactTime((value as FreezeValidationSummaryInputResponse).frozenAt))
    issues.push("Summary input receipt must retain an exact timestamp.");
  return issues;
}
