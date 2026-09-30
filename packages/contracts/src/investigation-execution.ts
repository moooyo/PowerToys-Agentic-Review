import { type Static, type TProperties, Type } from "@sinclair/typebox";
import {
  EntityIdSchema,
  GitObjectIdSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import { InvestigationRecipeStepSchema } from "./investigation-recipes.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const versionRef = object({
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  digest: Sha256Schema,
});
const relativePath = Type.String({ minLength: 1, maxLength: 4_096 });

export const InvestigationExecutablePlanStepSchema = object({
  stepId: EntityIdSchema,
  digest: Sha256Schema,
  operation: Type.Union([
    object({
      kind: Type.Literal("command"),
      executableId: EntityIdSchema,
      arguments: Type.Array(Type.String({ maxLength: 32_767 }), { maxItems: 128 }),
      workingDirectory: relativePath,
      expectedExitCode: Type.Integer({ minimum: 0, maximum: 255 }),
    }),
    object({ kind: Type.Literal("ui"), adapterId: EntityIdSchema, scenarioId: EntityIdSchema }),
    object({ kind: Type.Literal("recipe"), recipe: InvestigationRecipeStepSchema }),
    object({
      kind: Type.Literal("model-edit"),
      allowedPaths: Type.Array(relativePath, { minItems: 1, maxItems: 512, uniqueItems: true }),
    }),
  ]),
});
export type InvestigationExecutablePlanStep = Static<typeof InvestigationExecutablePlanStepSchema>;

/** Trusted server execution state. Model-authored plan drafts never contain this binding. */
export const InvestigationPlanExecutionBindingSchema = object({
  planRef: versionRef,
  subjectRef: EntityIdSchema,
  subjectRevisionKey: Sha256Schema,
  executionPolicyDigest: Sha256Schema,
  authorizationRef: EntityIdSchema,
  satisfiedPrerequisiteRefs: Type.Array(EntityIdSchema, { uniqueItems: true }),
  steps: Type.Array(InvestigationExecutablePlanStepSchema, { minItems: 1, maxItems: 128 }),
});
export type InvestigationPlanExecutionBinding = Static<
  typeof InvestigationPlanExecutionBindingSchema
>;

export const InvestigationPlanStepStartedSchema = object({
  taskId: EntityIdSchema,
  attemptId: EntityIdSchema,
  planRef: versionRef,
  subjectRef: EntityIdSchema,
  subjectRevisionKey: Sha256Schema,
  stepId: EntityIdSchema,
  stepDigest: Sha256Schema,
});
export type InvestigationPlanStepStarted = Static<typeof InvestigationPlanStepStartedSchema>;

export const InvestigationSourceEditSchema = object({
  path: relativePath,
  expectedDigest: Type.Union([Sha256Schema, Type.Null()]),
  content: Type.Union([Type.String({ maxLength: 4_194_304 }), Type.Null()]),
});
export type InvestigationSourceEdit = Static<typeof InvestigationSourceEditSchema>;

/** The model proposes file content; only the worker applies these edits to owned source files. */
export const InvestigationModelEditsV1Schema = object({
  schemaVersion: Type.Literal("InvestigationModelEditsV1"),
  summary: text,
  edits: Type.Array(InvestigationSourceEditSchema, { maxItems: 512 }),
});
export type InvestigationModelEditsV1 = Static<typeof InvestigationModelEditsV1Schema>;

export const InvestigationInputSnapshotV1Schema = object({
  schemaVersion: Type.Literal("InvestigationInputSnapshotV1"),
  repositoryId: EntityIdSchema,
  workItemId: EntityIdSchema,
  subjectRef: EntityIdSchema,
  subjectRevisionKey: Sha256Schema,
  title: text,
  body: Type.String(),
  comments: Type.Array(
    object({
      id: EntityIdSchema,
      body: Type.String(),
      provenance: Type.Optional(
        object({
          kind: Type.Literal("agentic_review_progress"),
          publicationId: EntityIdSchema,
        }),
      ),
    }),
  ),
  source: Type.Union([
    object({
      artifactRef: EntityIdSchema,
      artifactDigest: Sha256Schema,
      sourceSha: GitObjectIdSchema,
      files: Type.Array(
        object({ path: relativePath, content: Type.String(), digest: Sha256Schema }),
      ),
    }),
    Type.Null(),
  ]),
});
export type InvestigationInputSnapshotV1 = Static<typeof InvestigationInputSnapshotV1Schema>;
