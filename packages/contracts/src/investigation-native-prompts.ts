import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const InvestigationNativePromptKindSchema = Type.Union([
  Type.Literal("pr-review"),
  Type.Literal("issue-investigate"),
]);
export type InvestigationNativePromptKind = Static<typeof InvestigationNativePromptKindSchema>;

export const maximumNativePromptContentBytes = 64 * 1024;
export const InvestigationNativePromptContentSchema = object({
  localCheckout: Type.String({ minLength: 1, maxLength: maximumNativePromptContentBytes }),
  snapshot: Type.String({ minLength: 1, maxLength: maximumNativePromptContentBytes }),
});
export type InvestigationNativePromptContent = Static<
  typeof InvestigationNativePromptContentSchema
>;

export const InvestigationNativePromptRefSchema = object({
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  digest: Sha256Schema,
});
export const InvestigationNativePromptSnapshotSchema = object({
  kind: InvestigationNativePromptKindSchema,
  ref: InvestigationNativePromptRefSchema,
  content: InvestigationNativePromptContentSchema,
});
export type InvestigationNativePromptSnapshot = Static<
  typeof InvestigationNativePromptSnapshotSchema
>;

export const InvestigationNativePromptVersionSchema = object({
  repositoryId: EntityIdSchema,
  kind: InvestigationNativePromptKindSchema,
  ...InvestigationNativePromptRefSchema.properties,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  content: InvestigationNativePromptContentSchema,
  createdAt: DateTimeSchema,
  createdBy: Type.Union([EntityIdSchema, Type.Null()]),
});
export type InvestigationNativePromptVersion = Static<
  typeof InvestigationNativePromptVersionSchema
>;

export const InvestigationNativePromptBindingSchema = object({
  version: NonNegativeIntegerSchema,
  promptRef: InvestigationNativePromptRefSchema,
  updatedAt: Type.Union([DateTimeSchema, Type.Null()]),
  updatedBy: Type.Union([EntityIdSchema, Type.Null()]),
});
export type InvestigationNativePromptBinding = Static<
  typeof InvestigationNativePromptBindingSchema
>;

export const InvestigationNativePromptCatalogSchema = object({
  repositoryId: EntityIdSchema,
  items: Type.Array(
    object({
      kind: InvestigationNativePromptKindSchema,
      binding: InvestigationNativePromptBindingSchema,
      versions: Type.Array(InvestigationNativePromptVersionSchema, { minItems: 1, maxItems: 250 }),
      runtimeConstraints: InvestigationNativePromptContentSchema,
    }),
    { minItems: 2, maxItems: 2 },
  ),
});
export type InvestigationNativePromptCatalog = Static<
  typeof InvestigationNativePromptCatalogSchema
>;

export const InvestigationNativePromptPublishRequestSchema = object({
  expectedVersion: PositiveIntegerSchema,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  content: InvestigationNativePromptContentSchema,
});
export type InvestigationNativePromptPublishRequest = Static<
  typeof InvestigationNativePromptPublishRequestSchema
>;
export const InvestigationNativePromptBindRequestSchema = object({
  expectedVersion: NonNegativeIntegerSchema,
  promptRef: InvestigationNativePromptRefSchema,
});
export type InvestigationNativePromptBindRequest = Static<
  typeof InvestigationNativePromptBindRequestSchema
>;
