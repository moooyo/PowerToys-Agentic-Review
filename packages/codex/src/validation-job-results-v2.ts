import { types } from "node:util";
import {
  IssueReproductionRequestAssessmentV1Schema,
  IssueValidationReportV1Schema,
  IssueValidationSummaryV1Schema,
  ModelInvocationScopeV1Schema,
  maximumRunCompletionResultUtf8Bytes,
  PullRequestValidationReportV1Schema,
  PullRequestValidationSummaryV1Schema,
  ReviewExecutionEvidenceSchema,
  Sha256Schema,
  TestProbeReceiptV1Schema,
  ValidationExecutionDetailsSchema,
  type ValidationSummaryV1,
  ValidationSummaryV1Schema,
} from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createCanonicalResult } from "./canonical-result.js";
import {
  type IssueTriageV2,
  IssueTriageV2ModelResultSchema,
  type PrReviewPlanV2,
  PrReviewPlanV2ModelResultSchema,
} from "./review-results.js";
import {
  type ValidationJobResultV1,
  ValidationJobResultV1Schema,
} from "./validation-job-results.js";

const strict = { additionalProperties: false } as const;
export const ValidationModelInvocationReferenceV1Schema = Type.Object(
  {
    invocationId: ModelInvocationScopeV1Schema.properties.invocationId,
    scopeSha256: Sha256Schema,
    receiptSetSha256: Sha256Schema,
    modelOutputSha256: Sha256Schema,
  },
  strict,
);
export type ValidationModelInvocationReferenceV1 = Static<
  typeof ValidationModelInvocationReferenceV1Schema
>;

export const ValidationJobResultV2ModelResultSchema = Type.Union([
  PrReviewPlanV2ModelResultSchema,
  IssueTriageV2ModelResultSchema,
  ValidationSummaryV1Schema,
]);
export type ValidationJobResultV2ModelResult = Static<
  typeof ValidationJobResultV2ModelResultSchema
>;

const pullRequestReport = Type.Omit(PullRequestValidationReportV1Schema, ["modelSummary"], strict);
const issueReport = Type.Omit(IssueValidationReportV1Schema, ["modelSummary"], strict);
export const ValidationJobResultV2RunnerReportSchema = Type.Union([pullRequestReport, issueReport]);
export type ValidationJobResultV2RunnerReport = Static<
  typeof ValidationJobResultV2RunnerReportSchema
>;

const unavailable = Type.Union([
  Type.Object({ state: Type.Literal("not_requested") }, strict),
  Type.Object(
    {
      state: Type.Literal("failed"),
      code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Z][A-Z0-9_]*(?![\\s\\S])" }),
      message: Type.String({ minLength: 1, maxLength: 2048 }),
    },
    strict,
  ),
]);
const common = {
  schemaVersion: Type.Literal("ValidationJobResultV2"),
  execution: ValidationExecutionDetailsSchema,
  probeReceipts: Type.Optional(Type.Array(TestProbeReceiptV1Schema, { maxItems: 32 })),
};
const completed = {
  state: Type.Literal("completed"),
  invocation: ValidationModelInvocationReferenceV1Schema,
  executionEvidence: ReviewExecutionEvidenceSchema,
};

// The model payload remains exactly as validated before Worker observations are attached.
// A matching reference is consistency only; the owner independently authorizes result acceptance.
export const ValidationJobResultV2Schema = Type.Union([
  Type.Object(
    {
      ...common,
      report: pullRequestReport,
      modelReview: Type.Union([
        unavailable,
        Type.Object(
          {
            ...completed,
            result: Type.Union([
              PrReviewPlanV2ModelResultSchema,
              PullRequestValidationSummaryV1Schema,
            ]),
          },
          strict,
        ),
      ]),
    },
    strict,
  ),
  Type.Object(
    {
      ...common,
      report: issueReport,
      reproductionAssessment: Type.Optional(IssueReproductionRequestAssessmentV1Schema),
      modelReview: Type.Union([
        unavailable,
        Type.Object(
          {
            ...completed,
            result: Type.Union([IssueTriageV2ModelResultSchema, IssueValidationSummaryV1Schema]),
          },
          strict,
        ),
      ]),
    },
    strict,
  ),
]);
export type ValidationJobResultV2 = Static<typeof ValidationJobResultV2Schema>;
export const ValidationJobResultSchema = Type.Union([
  ValidationJobResultV1Schema,
  ValidationJobResultV2Schema,
]);
export type ValidationJobResult = ValidationJobResultV1 | ValidationJobResultV2;

function strictJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (
    typeof value !== "object" ||
    types.isProxy(value) ||
    ancestors.has(value) ||
    ancestors.size > 64
  )
    return false;
  if (
    (Array.isArray(value)
      ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    return false;
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
      strictJson(descriptor.value, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

/** Does not authenticate invocation references, verify Worker evidence or grant execution acceptance. */
export function getValidationJobResultV2Issues(value: unknown): string[] {
  const invalid = "ValidationJobResultV2 must match its strict JSON contract.";
  try {
    if (!strictJson(value) || !Value.Check(ValidationJobResultV2Schema, value)) return [invalid];
    if (
      Buffer.byteLength(createCanonicalResult(value).json, "utf8") >
      maximumRunCompletionResultUtf8Bytes
    )
      return ["The complete ValidationJobResultV2 exceeds the terminal result UTF-8 byte limit."];
    const result = value as ValidationJobResultV2;
    const issues: string[] = [];
    if (result.report.checks.some((check) => check.source !== "runner"))
      issues.push("ValidationJobResultV2 report checks must contain only runner observations.");
    if (
      result.modelReview.state === "completed" &&
      createCanonicalResult(result.modelReview.result).sha256 !==
        result.modelReview.invocation.modelOutputSha256
    )
      issues.push("The raw model result must match the referenced canonical model output digest.");
    return issues;
  } catch {
    return [invalid];
  }
}

/** Historical V1 data retains its existing Value.Check rules, without new V2 byte or semantic rules. */
export function getValidationJobResultIssues(value: unknown): string[] {
  const invalid = "The validation result must match its declared supported schema.";
  if (value === null || typeof value !== "object" || types.isProxy(value)) return [invalid];
  const descriptor = Object.getOwnPropertyDescriptor(value, "schemaVersion");
  if (!descriptor || !("value" in descriptor)) return [invalid];
  if (descriptor.value === "ValidationJobResultV2") return getValidationJobResultV2Issues(value);
  try {
    return descriptor.value === "ValidationJobResultV1" &&
      Value.Check(ValidationJobResultV1Schema, value)
      ? []
      : [invalid];
  } catch {
    return [invalid];
  }
}

/** Returns the original summary reference; V2 never duplicates it inside the runner report. */
export function getValidationModelSummary(result: ValidationJobResult): ValidationSummaryV1 | null {
  if (result.schemaVersion === "ValidationJobResultV1") return result.report.modelSummary ?? null;
  return result.modelReview.state === "completed" &&
    result.modelReview.result.schemaVersion === "ValidationSummaryV1"
    ? result.modelReview.result
    : null;
}

export type ValidationReviewModel =
  | PrReviewPlanV2
  | IssueTriageV2
  | Extract<
      ValidationJobResultV2ModelResult,
      { schemaVersion: "PrReviewPlanV2" | "IssueTriageV2" }
    >;

/** V1 stays enriched as stored; V2 stays raw. This selector never strips, enriches or rehashes either. */
export function getValidationReviewModel(
  result: ValidationJobResult,
): ValidationReviewModel | null {
  if (result.modelReview.state !== "completed") return null;
  if (result.schemaVersion === "ValidationJobResultV1") return result.modelReview.result;
  return result.modelReview.result.schemaVersion === "ValidationSummaryV1"
    ? null
    : result.modelReview.result;
}
