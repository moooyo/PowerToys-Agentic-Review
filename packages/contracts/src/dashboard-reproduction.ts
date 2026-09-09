import { type Static, Type } from "@sinclair/typebox";

import { EntityIdSchema, Sha256Schema } from "./common.js";
import {
  FrozenIssueReproductionCaseSchema,
  IssueReproductionAssessmentV1Schema,
  IssueReproductionBindingHeaderSchema,
  IssueReproductionCaseAssessmentSchema,
  IssueReproductionRequestAssessmentV1Schema,
  maximumIssueReproductionCaseCount,
  ReproductionObservationFactSchema,
} from "./issue-reproduction.js";

export const maximumDashboardReproductionCaseResponseUtf8Bytes = 2 * 1024 * 1024;
export const maximumDashboardReproductionCaseObservationCount = 48;

export const DashboardReviewRunReproductionSummarySchema = Type.Object(
  {
    bindingDigest: Sha256Schema,
    claim: IssueReproductionBindingHeaderSchema.properties.claim,
    caseCount: Type.Integer({ minimum: 1, maximum: maximumIssueReproductionCaseCount }),
    cases: Type.Array(
      Type.Object(
        {
          caseId: EntityIdSchema,
          requestId: EntityIdSchema,
          profileVersionId: EntityIdSchema,
          target: FrozenIssueReproductionCaseSchema.properties.target,
          context: FrozenIssueReproductionCaseSchema.properties.context,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: maximumIssueReproductionCaseCount, uniqueItems: true },
    ),
    assessment: IssueReproductionAssessmentV1Schema,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunReproductionSummary = Static<
  typeof DashboardReviewRunReproductionSummarySchema
>;

export const DashboardReviewRunResultReproductionSchema = Type.Object(
  {
    recordedAssessment: IssueReproductionRequestAssessmentV1Schema,
    currentAssessment: IssueReproductionRequestAssessmentV1Schema,
  },
  { additionalProperties: false },
);
export type DashboardReviewRunResultReproduction = Static<
  typeof DashboardReviewRunResultReproductionSchema
>;

const caseScopeProperties = {
  repositoryId: EntityIdSchema,
  reviewRunId: EntityIdSchema,
  requestId: EntityIdSchema,
  caseId: EntityIdSchema,
};
export const DashboardReviewRunReproductionCaseQuerySchema = Type.Object(
  { ...caseScopeProperties, jobId: Type.Optional(EntityIdSchema) },
  { additionalProperties: false },
);
export type DashboardReviewRunReproductionCaseQuery = Static<
  typeof DashboardReviewRunReproductionCaseQuerySchema
>;

export const DashboardReviewRunReproductionCaseResponseSchema = Type.Object(
  {
    ...caseScopeProperties,
    jobId: Type.Union([EntityIdSchema, Type.Null()]),
    resultId: Type.Union([EntityIdSchema, Type.Null()]),
    binding: IssueReproductionBindingHeaderSchema,
    case: FrozenIssueReproductionCaseSchema,
    bindingDigest: Sha256Schema,
    planDigest: Sha256Schema,
    recorded: Type.Union([IssueReproductionCaseAssessmentSchema, Type.Null()]),
    current: IssueReproductionCaseAssessmentSchema,
    observations: Type.Array(ReproductionObservationFactSchema, {
      maxItems: maximumDashboardReproductionCaseObservationCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type DashboardReviewRunReproductionCaseResponse = Static<
  typeof DashboardReviewRunReproductionCaseResponseSchema
>;
