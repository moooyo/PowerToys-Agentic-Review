import { type Static, Type } from "@sinclair/typebox";

export const VerificationStatusSchema = Type.Union([
  Type.Literal("not_run"),
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);

export const VerificationReportSchema = Type.Object(
  {
    status: VerificationStatusSchema,
    summary: Type.String({ minLength: 1, maxLength: 2_048 }),
    commands: Type.Array(
      Type.Object(
        {
          command: Type.String({ minLength: 1, maxLength: 2_048 }),
          status: VerificationStatusSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);
export type VerificationReport = Static<typeof VerificationReportSchema>;

const ExitCodeSchema = Type.Union([
  Type.Integer({ minimum: -2_147_483_648, maximum: 4_294_967_295 }),
  Type.Null(),
]);

export const ReviewExecutionEvidenceSchema = Type.Object(
  {
    schemaVersion: Type.Literal("ReviewExecutionEvidenceV1"),
    source: Type.Literal("worker"),
    commandCapture: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
    commands: Type.Array(
      Type.Object(
        {
          itemId: Type.String({ minLength: 1, maxLength: 128 }),
          command: Type.String({ minLength: 1, maxLength: 2_048 }),
          status: Type.Union([
            Type.Literal("completed"),
            Type.Literal("failed"),
            Type.Literal("unknown"),
          ]),
          exitCode: ExitCodeSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
    worktree: Type.Object(
      {
        status: Type.Union([
          Type.Literal("clean"),
          Type.Literal("modified"),
          Type.Literal("unknown"),
        ]),
        source: Type.Union([Type.Literal("git_status"), Type.Literal("not_observed")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ReviewExecutionEvidence = Static<typeof ReviewExecutionEvidenceSchema>;

export const RunFailureDiagnosticsSchema = Type.Object(
  {
    category: Type.Union([
      Type.Literal("workspace"),
      Type.Literal("launch"),
      Type.Literal("process"),
      Type.Literal("event_stream"),
      Type.Literal("result"),
      Type.Literal("internal"),
    ]),
    exitCode: ExitCodeSchema,
    summary: Type.String({ minLength: 1, maxLength: 2_048 }),
    correlationId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type RunFailureDiagnostics = Static<typeof RunFailureDiagnosticsSchema>;
