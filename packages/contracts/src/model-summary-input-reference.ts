import { type Static, Type } from "@sinclair/typebox";
import { Sha256Schema } from "./common.js";

// Keep this reference a leaf so CLI execution metadata does not import the context/envelope graph.
export const ValidationSummaryInputReferenceV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ValidationSummaryInputReferenceV1"),
    inputId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
    }),
    inputSha256: Sha256Schema,
    sourcePromptSha256: Sha256Schema,
    outputSchemaSha256: Sha256Schema,
    contextSha256: Sha256Schema,
    actualPromptSha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type ValidationSummaryInputReferenceV1 = Static<
  typeof ValidationSummaryInputReferenceV1Schema
>;
