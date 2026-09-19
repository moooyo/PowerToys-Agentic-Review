import { type Static, Type } from "@sinclair/typebox";
import { DateTimeSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from "./common.js";
import { InvestigationWorkerLeaseSchema } from "./investigation.js";

export const InvestigationProgressStageSchema = Type.Union([
  Type.Literal("prepare_source"),
  Type.Literal("model"),
  Type.Literal("validate_result"),
  Type.Literal("save_checkpoint"),
  Type.Literal("build_report"),
  Type.Literal("upload_evidence"),
  Type.Literal("cleanup"),
]);
export type InvestigationProgressStage = Static<typeof InvestigationProgressStageSchema>;

/** Only observed, closed stage intervals are present; omitted stages have unknown duration. */
export const InvestigationStageDurationsSchema = Type.Partial(
  Type.Object(
    {
      prepare_source: NonNegativeIntegerSchema,
      model: NonNegativeIntegerSchema,
      validate_result: NonNegativeIntegerSchema,
      save_checkpoint: NonNegativeIntegerSchema,
      build_report: NonNegativeIntegerSchema,
      upload_evidence: NonNegativeIntegerSchema,
      cleanup: NonNegativeIntegerSchema,
    },
    { additionalProperties: false },
  ),
);

const timestamp = Type.Union([DateTimeSchema, Type.Null()]);
export const InvestigationTaskProgressSchema = Type.Object(
  {
    stage: Type.Union([InvestigationProgressStageSchema, Type.Null()]),
    stageStartedAt: timestamp,
    lastActivityAt: timestamp,
    lastMeaningfulProgressAt: timestamp,
    lastHeartbeatAt: timestamp,
    stageDurationsMs: Type.Optional(InvestigationStageDurationsSchema),
  },
  { additionalProperties: false },
);
export type InvestigationTaskProgress = Static<typeof InvestigationTaskProgressSchema>;

/** Workers report observed activity. Only accepted Server state can establish meaningful progress. */
export const InvestigationProgressRequestSchema = Type.Object(
  {
    lease: InvestigationWorkerLeaseSchema,
    sequence: PositiveIntegerSchema,
    kind: Type.Union([Type.Literal("stage"), Type.Literal("activity")]),
    stage: InvestigationProgressStageSchema,
  },
  { additionalProperties: false },
);
export type InvestigationProgressRequest = Static<typeof InvestigationProgressRequestSchema>;
export const InvestigationProgressResponseSchema = Type.Object(
  {
    progress: InvestigationTaskProgressSchema,
  },
  { additionalProperties: false },
);
export type InvestigationProgressResponse = Static<typeof InvestigationProgressResponseSchema>;

export function emptyInvestigationTaskProgress(): InvestigationTaskProgress {
  return {
    stage: null,
    stageStartedAt: null,
    lastActivityAt: null,
    lastMeaningfulProgressAt: null,
    lastHeartbeatAt: null,
  };
}
