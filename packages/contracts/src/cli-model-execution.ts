import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { EntityIdSchema, Sha256Schema } from "./common.js";
import { ValidationSummaryInputReferenceV1Schema } from "./model-summary-input-reference.js";

const strict = { additionalProperties: false } as const;
const exactText = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern:
    "^[^\\s\\u0000-\\u001f\\u007f](?:[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f])?(?![\\s\\S])",
});

export const CliEngineSchema = Type.Union([Type.Literal("codex"), Type.Literal("copilot")]);
export type CliEngine = Static<typeof CliEngineSchema>;

// This records CLI configuration. A null model uses the CLI default, whose actual model is unknown.
export const CliModelConfigurationSchema = Type.Object(
  {
    kind: CliEngineSchema,
    version: exactText,
    requestedModel: Type.Union([exactText, Type.Null()]),
  },
  strict,
);
export type CliModelConfiguration = Static<typeof CliModelConfigurationSchema>;

export const CliModelExecutionV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("CliModelExecutionV1"),
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    cli: CliModelConfigurationSchema,
    promptSha256: Sha256Schema,
    outputSchemaSha256: Sha256Schema,
    outputSha256: Sha256Schema,
    exitCode: Type.Literal(0),
    summaryInputRef: Type.Optional(ValidationSummaryInputReferenceV1Schema),
  },
  strict,
);
export type CliModelExecutionV1 = Static<typeof CliModelExecutionV1Schema>;

/** Checks result metadata, without claiming to observe the CLI's underlying model requests. */
export function getCliModelExecutionIssues(value: unknown): string[] {
  try {
    if (!Value.Check(CliModelExecutionV1Schema, value))
      return ["CLI model execution must match its strict contract."];
    const strings = [value.jobId, value.runAttemptId, value.cli.version, value.cli.requestedModel];
    if (
      strings.some((entry) => entry !== null && (!entry.isWellFormed() || entry.trim() !== entry))
    )
      return ["CLI model execution must contain well-formed text."];
    const summary = value.summaryInputRef;
    if (
      summary !== undefined &&
      (value.promptSha256 !== summary.actualPromptSha256 ||
        value.outputSchemaSha256 !== summary.outputSchemaSha256)
    )
      return ["Summary execution must retain its frozen actual prompt and output schema."];
    return [];
  } catch {
    return ["CLI model execution must match its strict contract."];
  }
}
