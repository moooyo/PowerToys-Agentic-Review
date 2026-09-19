import { type Static, Type } from "@sinclair/typebox";
import { DateTimeSchema, EntityIdSchema, GitObjectIdSchema } from "./common.js";
import type {
  InvestigationAnalysisV1,
  InvestigationLoopCheckpointV1,
  InvestigationTaskV1,
} from "./investigation.js";

const text = Type.String({ minLength: 1, maxLength: 16_384, pattern: "\\S" });
const ids = Type.Array(EntityIdSchema, { uniqueItems: true });
export const InvestigationE2eExecutionSchema = Type.Object(
  {
    attemptId: EntityIdSchema,
    status: Type.Union([Type.Literal("started"), Type.Literal("completed")]),
    startedAt: DateTimeSchema,
    completedAt: Type.Union([DateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export const InvestigationE2eOutcomeSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("not_run"),
]);

/** Worker-observed coverage of the exact PR revision, independent of a static report. */
export const InvestigationE2eResultSchema = Type.Object(
  {
    headSha: GitObjectIdSchema,
    buildIdentity: text,
    features: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          title: text,
          paths: Type.Array(text),
          scenario: text,
          userVisible: Type.Boolean(),
          outcome: InvestigationE2eOutcomeSchema,
          assertions: Type.Array(
            Type.Object(
              {
                id: EntityIdSchema,
                expected: text,
                observed: text,
                outcome: InvestigationE2eOutcomeSchema,
                evidenceRefs: ids,
              },
              { additionalProperties: false },
            ),
            { minItems: 1 },
          ),
          artifactRefs: ids,
          limitations: Type.Array(text),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    cleanup: Type.Object(
      {
        confirmed: Type.Boolean(),
        recordedAt: DateTimeSchema,
        summary: text,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type InvestigationE2eResult = Static<typeof InvestigationE2eResultSchema>;

/** Describe persisted execution without adopting an analysis round or changing its coverage. */
export function projectInvestigationCheckpointPresentation(
  task: Pick<InvestigationTaskV1, "id" | "kind">,
  checkpoint: Pick<InvestigationLoopCheckpointV1, "taskId" | "round" | "stopReason"> & {
    readonly analysis: Pick<InvestigationAnalysisV1, "summary" | "assessment">;
    readonly runtime: Pick<
      InvestigationLoopCheckpointV1["runtime"],
      "e2e" | "e2eExecution" | "evidence" | "artifacts"
    >;
  },
): Pick<InvestigationAnalysisV1, "summary" | "assessment"> {
  const { analysis, runtime } = checkpoint;
  const original = { summary: analysis.summary, assessment: analysis.assessment };
  if (task.kind !== "pr-e2e" || checkpoint.taskId !== task.id || checkpoint.round !== 0)
    return original;
  let activity: string;
  const e2e = runtime.e2e;
  if (e2e !== undefined) {
    const count = (outcome: InvestigationE2eResult["features"][number]["outcome"]) =>
      e2e.features.filter((feature) => feature.outcome === outcome).length;
    activity = `Recorded E2E feature results: ${count("passed")} passed, ${count("failed")} failed, ${count("blocked")} blocked, ${count("not_run")} not run.`;
  } else if (
    runtime.evidence.some(
      (entry) => entry.authority === "worker" && entry.provenance.taskId === task.id,
    ) ||
    runtime.artifacts.some((entry) => entry.taskId === task.id)
  ) {
    activity =
      "Worker observations or artifacts were recorded; final E2E feature results are unavailable.";
  } else if (runtime.e2eExecution !== undefined) {
    activity = "E2E workflow start was recorded; application execution is not established.";
  } else {
    return original;
  }
  const reason = {
    budget_exhausted: "the task budget was exhausted",
    cancelled: "the task was cancelled",
    interrupted: "the task was interrupted",
    error: "the task stopped with an error",
    blocked: "the task was blocked",
    complete: "the task stopped",
    continuing: "final analysis is pending",
  }[checkpoint.stopReason];
  const adoption =
    checkpoint.stopReason === "continuing"
      ? "Final analysis has not been adopted yet."
      : `Final analysis was not adopted because ${reason}. Results remain partial.`;
  const summary = `${activity} ${adoption}`;
  const assessment = structuredClone(analysis.assessment);
  assessment.summary = summary;
  if (assessment.kind === "pr") {
    assessment.reviewConclusion = { status: "inconclusive", rationale: adoption };
    assessment.e2eAssessment.rationale = summary;
  }
  return { summary, assessment };
}

export function validateInvestigationE2eBindings(input: {
  readonly e2e: InvestigationE2eResult;
  readonly taskId: string;
  readonly taskKind: string;
  readonly subjectRef: string;
  readonly headSha: string | null;
  readonly completed: boolean;
  readonly artifacts: readonly {
    id: string;
    taskId: string;
    attemptId: string;
    subjectRef: string;
    kind: string;
    availability: string;
  }[];
  readonly evidence: readonly {
    id: string;
    subjectRef: string;
    authority: string;
    artifactRefs: readonly string[];
    provenance: { taskId: string; attemptId: string };
  }[];
}): string[] {
  const errors: string[] = [];
  const { e2e } = input;
  const evidence = new Map(input.evidence.map((entry) => [entry.id, entry]));
  const artifacts = new Map(input.artifacts.map((entry) => [entry.id, entry]));
  if (input.taskKind !== "pr-e2e" || input.headSha !== e2e.headSha)
    errors.push("E2E results must bind the root PR task and its exact head revision.");
  if (!e2e.cleanup.confirmed)
    errors.push("E2E results require confirmed process and desktop cleanup.");
  const ids = new Set<string>();
  for (const feature of e2e.features) {
    if (ids.has(feature.id)) errors.push("E2E feature and assertion identities must be unique.");
    ids.add(feature.id);
    for (const assertion of feature.assertions) {
      if (ids.has(assertion.id))
        errors.push("E2E feature and assertion identities must be unique.");
      ids.add(assertion.id);
      if (
        (assertion.outcome === "passed" || assertion.outcome === "failed") &&
        assertion.evidenceRefs.length === 0
      )
        errors.push("Executed E2E assertions require Worker observations.");
      for (const ref of assertion.evidenceRefs) {
        const observed = evidence.get(ref);
        if (
          observed === undefined ||
          observed.authority !== "worker" ||
          observed.subjectRef !== input.subjectRef ||
          observed.provenance.taskId !== input.taskId
        )
          errors.push("E2E assertions cannot cite observations outside their task and revision.");
      }
    }
    for (const ref of feature.artifactRefs) {
      const artifact = artifacts.get(ref);
      if (
        artifact === undefined ||
        artifact.taskId !== input.taskId ||
        artifact.subjectRef !== input.subjectRef ||
        !["image", "video"].includes(artifact.kind) ||
        artifact.availability !== "available" ||
        !input.evidence.some(
          (observed) =>
            observed.authority === "worker" &&
            observed.provenance.taskId === input.taskId &&
            observed.provenance.attemptId === artifact.attemptId &&
            observed.artifactRefs.includes(ref),
        )
      )
        errors.push(
          "E2E media must be an available screenshot or video captured by the same task attempt.",
        );
    }
    if (
      feature.outcome === "passed" &&
      (feature.artifactRefs.length === 0 ||
        feature.assertions.some((assertion) => assertion.outcome !== "passed"))
    )
      errors.push(
        "A passed E2E feature needs successful assertions and runtime screenshot or video evidence.",
      );
    if (input.completed && feature.outcome !== "passed")
      errors.push("Completed E2E reports cannot contain failed, blocked, or unexecuted features.");
  }
  return errors;
}
