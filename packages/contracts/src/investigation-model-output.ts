import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DateTimeSchema, EntityIdSchema, PositiveIntegerSchema } from "./common.js";

const index = "(?:0|[1-9][0-9]{0,5})";
const collections =
  "(?:coverageUnits|findings|candidates|rechecks|evidence|plans|nextActions|feedbackDrafts|diagnostics|limitations)";
const duplicatePath = `^/analysis/${collections}/${index}/id$(?![\\s\\S])`;
const referencePaths = [
  `(?:coverageUnits|candidates|rechecks|evidence|diagnostics|limitations)/${index}/evidenceRefs(?:/${index})?`,
  `findings/${index}/(?:(?:rootCause|confirmation)/)?evidenceRefs(?:/${index})?`,
  `assessment/(?:reproduction/|bugAssessment/(?:upstreamFix|duplicateOf)/|featureAssessment/duplicateOf/)?evidenceRefs(?:/${index})?`,
  "assessment/(?:reproduction|e2eAssessment)/planRef/id",
  "assessment/featureAssessment/implementationPlanRef/id",
  `findings/${index}/fixRecommendation/planRef/id`,
  `nextActions/${index}/(?:planRef/id|draftRef)`,
  `candidates/${index}/(?:findingId|mergedIntoCandidateId)`,
  `rechecks/${index}/findingId`,
  `findings/${index}/confirmation/recheckRef`,
];
const paths = (pattern: string) =>
  Type.Array(Type.String({ maxLength: 256, pattern }), {
    minItems: 1,
    maxItems: 8,
    uniqueItems: true,
  });

/** Only structural positions in ordinary model records are eligible for one correction. */
export const InvestigationModelOutputRejectionIssueSchema = Type.Union([
  Type.Object(
    { rule: Type.Literal("duplicate_record_id"), paths: paths(duplicatePath) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      rule: Type.Literal("reference_outside_batch"),
      paths: paths(`^/analysis/(?:${referencePaths.join("|")})$(?![\\s\\S])`),
    },
    { additionalProperties: false },
  ),
]);
export type InvestigationModelOutputRejectionIssue = Static<
  typeof InvestigationModelOutputRejectionIssueSchema
>;

/** Values and unknown property names never enter the durable correction receipt. */
export function isCorrectableInvestigationModelOutputIssue(
  value: unknown,
): value is InvestigationModelOutputRejectionIssue {
  return Value.Check(InvestigationModelOutputRejectionIssueSchema, value);
}

export const InvestigationModelOutputRejectionSchema = Type.Object(
  {
    attemptId: EntityIdSchema,
    round: PositiveIntegerSchema,
    invocationId: EntityIdSchema,
    issue: InvestigationModelOutputRejectionIssueSchema,
    recordedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type InvestigationModelOutputRejection = Static<
  typeof InvestigationModelOutputRejectionSchema
>;
