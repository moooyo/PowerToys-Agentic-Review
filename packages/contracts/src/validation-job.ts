import { type Static, Type } from "@sinclair/typebox";

import { EntityIdSchema, PositiveIntegerSchema, Sha256Schema } from "./common.js";
import { FrozenIssueReproductionBindingSchema } from "./issue-reproduction.js";
import {
  ValidationProfileVersionSchema,
  ValidationTargetSchema,
  WorkflowKindSchema,
} from "./platform-configuration.js";
import {
  ReviewRunTestedSourceAuthorizationSchema,
  ReviewRunTestedSourceRevisionSchema,
} from "./review-run.js";
import { QualifiedValidationCheckIdSchema } from "./validation-report.js";

// These labels describe deployed code, not configurable profile requirements. The Server must
// add them at admission and check them again before granting an envelope to an older Worker.
export const validationExecutorCapabilityLabels = Object.freeze({
  envelope: "executionEnvelope",
  headless: "validationHeadless",
  windows_desktop: "validationWindowsDesktop",
  web: "validationWeb",
  reproduction: "issueReproduction",
  probes: "structuredProbeOutput",
  uiObservations: "uiAssertionObservation",
});

// A lease contains the selected profile and, when mapped, the complete frozen reproduction binding.
export const ValidationJobContextSchema = Type.Object(
  {
    schemaVersion: Type.Literal("ValidationJobContextV1"),
    runId: EntityIdSchema,
    planDigest: Sha256Schema,
    activationId: EntityIdSchema,
    requestId: EntityIdSchema,
    jobActivation: PositiveIntegerSchema,
    repositoryId: EntityIdSchema,
    workItemId: EntityIdSchema,
    revisionKey: Sha256Schema,
    requestEpochId: EntityIdSchema,
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
    required: Type.Boolean(),
    profileVersion: ValidationProfileVersionSchema,
    promptVersion: Type.Object(
      {
        id: EntityIdSchema,
        templateId: EntityIdSchema,
        version: PositiveIntegerSchema,
        contentSha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
    requiredCheckIds: Type.Array(QualifiedValidationCheckIdSchema, {
      maxItems: 96,
      uniqueItems: true,
    }),
    testedSourceRevision: Type.Union([ReviewRunTestedSourceRevisionSchema, Type.Null()]),
    testedSourceAuthorization: Type.Union([ReviewRunTestedSourceAuthorizationSchema, Type.Null()]),
    reproduction: Type.Optional(FrozenIssueReproductionBindingSchema),
  },
  { additionalProperties: false },
);
export type ValidationJobContext = Static<typeof ValidationJobContextSchema>;
