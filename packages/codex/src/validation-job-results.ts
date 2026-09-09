import {
  IssueReproductionRequestAssessmentV1Schema,
  IssueValidationReportV1Schema,
  PullRequestValidationReportV1Schema,
  TestProbeReceiptV1Schema,
  ValidationExecutionDetailsSchema,
} from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";
import { IssueTriageV2Schema, PrReviewPlanV2Schema } from "./review-results.js";

const UnavailableModelReviewSchema = Type.Union([
  Type.Object({ state: Type.Literal("not_requested") }, { additionalProperties: false }),
  Type.Object(
    {
      state: Type.Literal("failed"),
      code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Z][A-Z0-9_]*$" }),
      message: Type.String({ minLength: 1, maxLength: 2_048 }),
    },
    { additionalProperties: false },
  ),
]);

const CommonProperties = {
  schemaVersion: Type.Literal("ValidationJobResultV1"),
  execution: ValidationExecutionDetailsSchema,
  probeReceipts: Type.Optional(Type.Array(TestProbeReceiptV1Schema, { maxItems: 32 })),
};

// Model review results remain separate from runner assertions and lifecycle evidence.
export const ValidationJobResultV1Schema = Type.Union([
  Type.Object(
    {
      ...CommonProperties,
      report: PullRequestValidationReportV1Schema,
      modelReview: Type.Union([
        UnavailableModelReviewSchema,
        Type.Object(
          { state: Type.Literal("completed"), result: PrReviewPlanV2Schema },
          { additionalProperties: false },
        ),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommonProperties,
      report: IssueValidationReportV1Schema,
      reproductionAssessment: Type.Optional(IssueReproductionRequestAssessmentV1Schema),
      modelReview: Type.Union([
        UnavailableModelReviewSchema,
        Type.Object(
          { state: Type.Literal("completed"), result: IssueTriageV2Schema },
          { additionalProperties: false },
        ),
      ]),
    },
    { additionalProperties: false },
  ),
]);
export type ValidationJobResultV1 = Static<typeof ValidationJobResultV1Schema>;
