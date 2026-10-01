import {
  EntityIdSchema,
  getInvestigationExecutionDurationLimitMs,
  InvestigationAnalysisEvidenceSchema,
  type InvestigationAnalysisV1,
  InvestigationAssessmentSchema,
  type InvestigationAttemptV1,
  InvestigationCandidateSchema,
  InvestigationCoverageUnitSchema,
  InvestigationDiagnosticSchema,
  type InvestigationEvidenceV1,
  InvestigationFeedbackDraftSchema,
  InvestigationFindingV1Schema,
  InvestigationLimitationSchema,
  type InvestigationLoopCheckpointV1,
  InvestigationLoopPhaseSchema,
  type InvestigationLoopRoundV1,
  InvestigationNextActionDraftSchema,
  InvestigationPlanDraftSchema,
  InvestigationRecheckSchema,
  InvestigationRecipeRequestSchema,
  InvestigationRecipeStepSchema,
  InvestigationReviewBaselineFindingRefSchema,
  type InvestigationReviewBaselineSnapshot,
  InvestigationReviewDispositionSchema,
  type InvestigationRuntimeState,
  type InvestigationTaskV1,
  InvestigationVersionRefSchema,
  isCorrectableInvestigationModelOutputIssue,
  PositiveIntegerSchema,
  validateInvestigationAnalysisForTask,
  validateInvestigationReviewBaselineSnapshot,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint, investigationContentDigest } from "@agentic-review/domain";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ModelOutputValidationError,
  type ModelOutputValidationPath,
  type ModelOutputValidationRule,
  modelOutputSchemaError,
  safeModelOutputValidationIssue,
} from "./model-output-diagnostics.js";

const text = Type.String({ minLength: 1 });
const objectOptions = { additionalProperties: false } as const;

// Model objects are strict. Keep absence as an explicit union of closed object shapes,
// while the storage contract retains its optional recipe field for existing plans.
const queryRecipe = InvestigationRecipeRequestSchema.anyOf[1];
const recipeScenario = queryRecipe.properties.scenarios.items;
const recipeAssertion = recipeScenario.properties.feature.properties.assertions.items;
const modelRecipeAssertion = Type.Object(
  {
    ...recipeAssertion.properties,
    selector: Type.Union([
      Type.Object({ name: text }, objectOptions),
      Type.Object({ name: text, controlType: text }, objectOptions),
      Type.Object({ automationId: text }, objectOptions),
      Type.Object({ automationId: text, name: text }, objectOptions),
    ]),
    assertion: Type.Union([
      Type.Object({ property: Type.Literal("exists"), expected: Type.Boolean() }, objectOptions),
      Type.Object(
        {
          property: Type.Union([Type.Literal("text"), Type.Literal("value")]),
          expected: text,
          match: Type.Union([Type.Literal("equals"), Type.Literal("contains")]),
        },
        objectOptions,
      ),
    ]),
  },
  objectOptions,
);
const modelRecipeScenarioProperties = {
  query: recipeScenario.properties.query,
  feature: Type.Object(
    {
      ...recipeScenario.properties.feature.properties,
      assertions: Type.Array(modelRecipeAssertion, { minItems: 1, maxItems: 64 }),
    },
    objectOptions,
  ),
};
const modelRecipe = Type.Object(
  {
    ...InvestigationRecipeStepSchema.properties,
    request: Type.Union([
      InvestigationRecipeRequestSchema.anyOf[0],
      Type.Object(
        {
          ...queryRecipe.properties,
          scenarios: Type.Array(
            Type.Union([
              Type.Object(modelRecipeScenarioProperties, objectOptions),
              Type.Object({ ...modelRecipeScenarioProperties, requires: text }, objectOptions),
            ]),
            { minItems: 1, maxItems: 8 },
          ),
        },
        objectOptions,
      ),
    ]),
  },
  objectOptions,
);
const { recipe: _recipe, ...plainPlanStepProperties } =
  InvestigationPlanDraftSchema.properties.steps.items.properties;
const modelPlanDraft = Type.Object(
  {
    ...InvestigationPlanDraftSchema.properties,
    steps: Type.Array(
      Type.Union([
        Type.Object(plainPlanStepProperties, objectOptions),
        Type.Object({ ...plainPlanStepProperties, recipe: modelRecipe }, objectOptions),
      ]),
      { minItems: 1 },
    ),
  },
  objectOptions,
);

/** Status-specific wire constraints supplement, never replace, ledger reference validation. */
const {
  reviewBaselineFindingRef: _reviewBaselineFindingRef,
  reviewDisposition: _reviewDisposition,
  ...ordinaryCandidateProperties
} = InvestigationCandidateSchema.properties;
const candidateStatusProperties = [
  {
    status: Type.Union([Type.Literal("confirmed"), Type.Literal("unresolved")]),
    findingId: EntityIdSchema,
    findingVersion: PositiveIntegerSchema,
    mergedIntoCandidateId: Type.Null(),
  },
  {
    status: Type.Union([Type.Literal("pending"), Type.Literal("withdrawn")]),
    findingId: InvestigationCandidateSchema.properties.findingId,
    findingVersion: InvestigationCandidateSchema.properties.findingVersion,
    mergedIntoCandidateId: Type.Null(),
  },
  {
    status: Type.Literal("merged"),
    findingId: InvestigationCandidateSchema.properties.findingId,
    findingVersion: InvestigationCandidateSchema.properties.findingVersion,
    mergedIntoCandidateId: EntityIdSchema,
  },
] as const;
export const InvestigationModelCandidateSchema = Type.Union(
  candidateStatusProperties.flatMap((statusProperties) => [
    Type.Object(
      {
        ...ordinaryCandidateProperties,
        ...statusProperties,
        discoveredRound: PositiveIntegerSchema,
      },
      objectOptions,
    ),
    Type.Object(
      {
        ...ordinaryCandidateProperties,
        ...statusProperties,
        discoveredRound: Type.Literal(0),
        reviewBaselineFindingRef: InvestigationReviewBaselineFindingRefSchema,
        reviewDisposition: InvestigationReviewDispositionSchema,
      },
      objectOptions,
    ),
  ]),
);

/** Model updates are bounded independently of the complete Worker-owned ledger. */
export const InvestigationModelTurnDeltaV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("InvestigationModelTurnDeltaV1"),
    taskId: EntityIdSchema,
    attemptId: EntityIdSchema,
    inputCheckpointRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
    round: PositiveIntegerSchema,
    phase: InvestigationLoopPhaseSchema,
    analysis: Type.Object(
      {
        summary: Type.Union([text, Type.Null()]),
        assessment: Type.Union([InvestigationAssessmentSchema, Type.Null()]),
        coverageUnits: Type.Array(InvestigationCoverageUnitSchema),
        findings: Type.Array(InvestigationFindingV1Schema),
        candidates: Type.Array(InvestigationModelCandidateSchema),
        rechecks: Type.Array(InvestigationRecheckSchema),
        evidence: Type.Array(InvestigationAnalysisEvidenceSchema),
        plans: Type.Array(modelPlanDraft),
        nextActions: Type.Array(InvestigationNextActionDraftSchema),
        feedbackDrafts: Type.Array(InvestigationFeedbackDraftSchema),
        diagnostics: Type.Array(InvestigationDiagnosticSchema),
        limitations: Type.Array(InvestigationLimitationSchema),
        removedFindingIds: Type.Array(EntityIdSchema, { uniqueItems: true }),
      },
      objectOptions,
    ),
    continue: Type.Boolean(),
    continuationReason: text,
  },
  objectOptions,
);
type ModelTurnDeltaWire = Static<typeof InvestigationModelTurnDeltaV1Schema>;
/** Callers reuse ledger records; runtime wire validation enforces their status-specific shape. */
export type InvestigationModelTurnDeltaV1 = Omit<ModelTurnDeltaWire, "analysis"> & {
  analysis: Omit<ModelTurnDeltaWire["analysis"], "candidates" | "plans"> &
    Pick<InvestigationAnalysisV1, "candidates" | "plans">;
};

const collectionNames = [
  "findings",
  "candidates",
  "rechecks",
  "evidence",
  "plans",
  "nextActions",
  "feedbackDrafts",
  "diagnostics",
  "limitations",
] as const;
type CollectionName = (typeof collectionNames)[number];
type AnalysisCollections = Pick<InvestigationAnalysisV1, CollectionName>;
type Phase = InvestigationLoopRoundV1["phase"];
type Preview = { readonly text: string; readonly truncated: boolean };

export interface ModelTurnSourceCoverageUnit {
  readonly id: string;
  readonly subjectRef: string;
  readonly kind: InvestigationAnalysisV1["coverage"]["includedUnits"][number]["kind"];
  readonly paths: readonly string[];
  readonly status: InvestigationAnalysisV1["coverage"]["includedUnits"][number]["status"];
  readonly evidenceRefs: readonly string[];
}

export interface ModelTurnProjectionContext {
  readonly schemaVersion: "InvestigationModelTurnContextV1";
  readonly task: {
    readonly id: string;
    readonly kind: InvestigationTaskV1["kind"];
    readonly repository: InvestigationTaskV1["repository"];
    readonly workItem: Omit<InvestigationTaskV1["workItem"], "title"> & { readonly title: Preview };
    readonly subjectRef: string;
    readonly primarySubject: InvestigationTaskV1["subjects"][number];
    readonly executionPolicy: Omit<InvestigationTaskV1["executionPolicy"], "allowedSubjectRefs">;
    readonly budget: Pick<InvestigationTaskV1["budget"], "maxDurationMs" | "maxReportBytes">;
    readonly profileRef: InvestigationTaskV1["profileRef"];
    readonly promptRef: InvestigationTaskV1["promptRef"];
  };
  readonly attempt: { readonly id: string; readonly number: number };
  readonly inputCheckpointRef: InvestigationLoopRoundV1["inputCheckpointRef"];
  readonly round: number;
  readonly phase: Phase;
  readonly budgetState: {
    readonly consumed: InvestigationLoopCheckpointV1["consumed"];
    readonly remaining: Pick<
      InvestigationLoopCheckpointV1["consumed"],
      "durationMs" | "reportBytes"
    >;
  };
  readonly subjects: InvestigationTaskV1["subjects"];
  /** Historical findings are context only; their references are never current evidence. */
  readonly reviewBaseline?: {
    readonly reportRef: InvestigationReviewBaselineSnapshot["descriptor"]["reportRef"];
    readonly sourceTaskId: string;
    readonly subject: InvestigationReviewBaselineSnapshot["descriptor"]["subject"];
    readonly totalFindingCount: number;
    readonly findings: InvestigationReviewBaselineSnapshot["findings"];
  };
  readonly counts: Readonly<Record<string, number>>;
  /** Source dependencies are readable context, not editable coverage selections. */
  readonly sourceCoverage: {
    readonly digest: string;
    readonly units: readonly ModelTurnSourceCoverageUnit[];
  };
  readonly analysis: AnalysisCollections & {
    readonly summary: Preview;
    readonly assessment: {
      readonly kind: InvestigationAnalysisV1["assessment"]["kind"];
      readonly subjectRef: string;
      readonly summary: Preview;
      readonly facts: Readonly<Record<string, unknown>>;
    };
    readonly coverageUnits: InvestigationAnalysisV1["coverage"]["includedUnits"];
  };
  readonly observations: InvestigationEvidenceV1[];
  readonly runtime: {
    readonly checks: InvestigationRuntimeState["checks"];
    readonly startedSteps: InvestigationRuntimeState["startedSteps"];
    readonly completedSteps: Array<{
      readonly stepId: string;
      readonly attemptId: string;
      readonly subjectRef: string;
      readonly subjectRevisionKey: string;
      readonly planRef: InvestigationTaskV1["planRef"];
      readonly outcome: InvestigationRuntimeState["completedSteps"][number]["outcome"];
      readonly validationSummary: Preview;
      readonly checkIds: string[];
      readonly observationCount: number;
      readonly providedEvidenceRefs: string[];
      readonly diagnosticCount: number;
    }>;
  };
}

export interface ModelTurnProjection {
  readonly context: ModelTurnProjectionContext;
  readonly selectedUnitIds: readonly string[];
  readonly selectedCandidateIds: readonly string[];
  readonly selectedFindingIds: readonly string[];
  readonly phase: Phase;
  /** Local checkout source selection differs from snapshot-only data access. */
  readonly localSourceReview: boolean;
  /** Both versioned static modes can finish without a separate finalize invocation. */
  readonly autonomousReview: boolean;
  /** This complete ledger stays in Worker memory and must never be included in the prompt. */
  readonly baseAnalysis: InvestigationAnalysisV1;
}

export class ModelTurnProjectionError extends Error {
  public constructor(
    readonly code: "MODEL_INPUT_LIMIT_EXCEEDED" | "MODEL_INPUT_INVALID" | "MODEL_OUTPUT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ModelTurnProjectionError";
  }
}

type Selections = {
  units: Set<string>;
  sourceUnits: Set<string>;
  observations: Set<string>;
} & Record<CollectionName, Set<string>>;
const projectionObservations = new WeakMap<
  ModelTurnProjection,
  readonly InvestigationEvidenceV1[]
>();

export function prepareModelTurnProjection(input: {
  readonly task: InvestigationTaskV1;
  readonly attempt: InvestigationAttemptV1;
  readonly checkpoint: InvestigationLoopCheckpointV1 | null;
  readonly reviewBaseline?: InvestigationReviewBaselineSnapshot;
  readonly maximumContextBytes: number;
}): ModelTurnProjection {
  const { task, attempt, checkpoint, maximumContextBytes } = input;
  if (
    (task.reviewBaseline === undefined) !== (input.reviewBaseline === undefined) ||
    (input.reviewBaseline !== undefined &&
      (!validateInvestigationReviewBaselineSnapshot(input.reviewBaseline).valid ||
        !same(task.reviewBaseline, input.reviewBaseline.descriptor)))
  )
    throw new ModelTurnProjectionError(
      "MODEL_INPUT_INVALID",
      "The complete review baseline must match the task's frozen report and finding references.",
    );
  if (!Number.isSafeInteger(maximumContextBytes) || maximumContextBytes < 1)
    throw new ModelTurnProjectionError(
      "MODEL_INPUT_INVALID",
      "The model context byte budget must be a positive safe integer.",
    );
  if (
    attempt.taskId !== task.id ||
    (checkpoint !== null && (checkpoint.taskId !== task.id || checkpoint.attemptId !== attempt.id))
  )
    throw new ModelTurnProjectionError(
      "MODEL_INPUT_INVALID",
      "The projection must belong to the active task and attempt.",
    );
  const primarySubject = task.subjects.find((subject) => subject.id === task.subjectRef);
  if (primarySubject === undefined)
    throw new ModelTurnProjectionError(
      "MODEL_INPUT_INVALID",
      "The frozen primary subject is missing.",
    );
  const initial =
    checkpoint ??
    createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "model-projection-initial",
      leaseVersion: attempt.leaseVersion,
      recordedAt: task.updatedAt,
    });
  const baseAnalysis = structuredClone(initial.analysis);
  const localSourceReview = initial.runtime.reviewMode === "local_checkout";
  const autonomousReview = initial.runtime.reviewMode !== undefined;
  const observations = initial.runtime.evidence;
  const pending = pendingRecords(baseAnalysis, observations);
  // Real diff chunks are a prerequisite for the metadata-level full-diff summary.
  // Domain acceptance independently verifies that completed chunks were brokered.
  const pendingDiffChunks = baseAnalysis.coverage.includedUnits
    .filter((unit) => unit.kind === "pr_diff_chunk" && unit.status !== "completed")
    .map((unit) => unit.id);
  const unblockedUnitIds = baseAnalysis.coverage.includedUnits
    .filter((unit) => unit.status !== "completed" && unit.status !== "blocked")
    .map((unit) => unit.id);
  const blockedUnitIds = baseAnalysis.coverage.includedUnits
    .filter((unit) => unit.status === "blocked")
    .map((unit) => unit.id);
  const queuedUnitIds = pendingDiffChunks.length > 0 ? pendingDiffChunks : pending.units;
  const queuedUnitIdSet = new Set(queuedUnitIds);
  const pendingCandidateIds = new Set(pending.candidates);
  const round = initial.round + 1;
  const phase: Phase =
    initial.round === 0
      ? "discovery"
      : pending.units.length > 0 || pending.observations.length > 0
        ? "investigation"
        : pending.candidates.length > 0
          ? "investigation"
          : pending.findings.length > 0
            ? "recheck"
            : "finalize";
  const indexes = makeIndexes(baseAnalysis, observations);
  const summarizeRuntimeFirst = task.kind !== "pr-review" && task.kind !== "issue-investigate";
  const restoreCompletedTypedContext =
    !summarizeRuntimeFirst && task.executionPolicy.mode === "source_read";
  // Keep typed source work separate from seeds that can restore the full diff.
  // New pending source work precedes a complete batch of interdependent blocked source work.
  const typedSourceUnits =
    !localSourceReview && !summarizeRuntimeFirst && task.executionPolicy.mode === "source_read"
      ? baseAnalysis.coverage.includedUnits.filter(
          (unit) => unit.kind === "source_file" && unit.paths.length > 0,
        )
      : [];
  const blockedSourceUnits = typedSourceUnits.filter((unit) => unit.status === "blocked");
  const pendingSourceUnit = typedSourceUnits.find((unit) => unit.status === "pending");
  const focusedSourceUnits =
    pendingSourceUnit === undefined ? blockedSourceUnits : [pendingSourceUnit];
  const atomicSourceBatch = pendingDiffChunks.length === 0 && focusedSourceUnits.length > 0;
  const summarizedRuntimeEvidence = baseAnalysis.evidence.filter((entry) =>
    entry.evidenceRefs.some((id) => indexes.observations.has(id)),
  );
  let selected = emptySelections();
  const { allowedSubjectRefs: _allowedSubjectRefs, ...executionPolicy } = task.executionPolicy;
  const counts = {
    coverageUnits: baseAnalysis.coverage.includedUnits.length,
    pendingCoverageUnits: pending.units.length,
    pendingDiffChunks: pendingDiffChunks.length,
    candidates: baseAnalysis.candidates.length,
    pendingCandidates: pending.candidates.length,
    ...(input.reviewBaseline === undefined
      ? {}
      : {
          baselineFindings: input.reviewBaseline.findings.length,
          pendingBaselineFindings: baseAnalysis.candidates.filter(
            (candidate) => candidate.reviewDisposition === "pending",
          ).length,
        }),
    findings: baseAnalysis.findings.length,
    pendingFindings: pending.findings.length,
    rechecks: baseAnalysis.rechecks.length,
    evidence: baseAnalysis.evidence.length,
    observations: observations.length,
    pendingObservations: pending.observations.length,
    runtimeChecks: initial.runtime.checks.length,
    startedSteps: initial.runtime.startedSteps.length,
    completedSteps: initial.runtime.completedSteps.length,
    plans: baseAnalysis.plans.length,
    passedRuntimeChecks: initial.runtime.checks.filter((check) => check.status === "passed").length,
    failedRuntimeChecks: initial.runtime.checks.filter((check) => check.status === "failed").length,
    blockedRuntimeChecks: initial.runtime.checks.filter((check) => check.status === "blocked")
      .length,
    unrunRuntimeChecks: initial.runtime.checks.filter((check) => check.status === "not_run").length,
    nextActions: baseAnalysis.nextActions.length,
    feedbackDrafts: baseAnalysis.feedbackDrafts.length,
    diagnostics: baseAnalysis.diagnostics.length,
    limitations: baseAnalysis.limitations.length,
    ...Object.fromEntries(
      ["P0", "P1", "P2", "P3"].map((priority) => [
        `findings${priority}`,
        baseAnalysis.findings.filter((finding) => finding.priority === priority).length,
      ]),
    ),
  };
  const buildContext = (selection: Selections): ModelTurnProjectionContext => {
    const collections = pickCollections(baseAnalysis, selection);
    const coverageUnits = baseAnalysis.coverage.includedUnits.filter((unit) =>
      selection.units.has(unit.id),
    );
    const selectedObservations = observations.filter((entry) =>
      selection.observations.has(entry.id),
    );
    const sourceUnits = baseAnalysis.coverage.includedUnits
      .filter((unit) => selection.sourceUnits.has(unit.id))
      .map(({ id, subjectRef, kind, paths, status, evidenceRefs }) => ({
        id,
        subjectRef,
        kind,
        paths,
        status,
        evidenceRefs,
      }));
    const subjectIds = new Set([task.subjectRef]);
    for (const entry of [
      ...coverageUnits,
      ...sourceUnits,
      ...collections.findings,
      ...collections.candidates,
      ...collections.evidence,
      ...selectedObservations,
    ])
      subjectIds.add(entry.subjectRef);
    return {
      schemaVersion: "InvestigationModelTurnContextV1",
      task: {
        id: task.id,
        kind: task.kind,
        repository: structuredClone(task.repository),
        workItem: { ...task.workItem, title: preview(task.workItem.title) },
        subjectRef: task.subjectRef,
        primarySubject: structuredClone(primarySubject),
        executionPolicy,
        budget: {
          maxDurationMs: getInvestigationExecutionDurationLimitMs(task.budget),
          maxReportBytes: task.budget.maxReportBytes,
        },
        profileRef: task.profileRef,
        promptRef: task.promptRef,
      },
      attempt: { id: attempt.id, number: attempt.number },
      inputCheckpointRef:
        checkpoint === null
          ? null
          : { id: checkpoint.id, version: checkpoint.version, digest: checkpoint.digest },
      round,
      phase,
      budgetState: {
        consumed: initial.consumed,
        remaining: {
          durationMs: Math.max(
            0,
            getInvestigationExecutionDurationLimitMs(task.budget) - initial.consumed.durationMs,
          ),
          reportBytes: Math.max(0, task.budget.maxReportBytes - initial.consumed.reportBytes),
        },
      },
      subjects: [
        ...new Map(
          [...task.subjects, ...initial.runtime.subjects].map((subject) => [subject.id, subject]),
        ).values(),
      ].filter((subject) => subjectIds.has(subject.id)),
      counts,
      ...(input.reviewBaseline === undefined
        ? {}
        : {
            reviewBaseline: {
              reportRef: structuredClone(input.reviewBaseline.descriptor.reportRef),
              sourceTaskId: input.reviewBaseline.descriptor.sourceTaskId,
              subject: structuredClone(input.reviewBaseline.descriptor.subject),
              totalFindingCount: input.reviewBaseline.findings.length,
              findings: input.reviewBaseline.findings.filter((finding) =>
                collections.candidates.some(
                  (candidate) =>
                    candidate.reviewBaselineFindingRef?.id === finding.id &&
                    candidate.reviewBaselineFindingRef.version === finding.version,
                ),
              ),
            },
          }),
      sourceCoverage: { digest: investigationContentDigest(sourceUnits), units: sourceUnits },
      analysis: {
        ...collections,
        coverageUnits,
        summary: preview(baseAnalysis.summary),
        assessment: {
          kind: baseAnalysis.assessment.kind,
          subjectRef: baseAnalysis.assessment.subjectRef,
          summary: preview(baseAnalysis.assessment.summary),
          facts: assessmentFacts(baseAnalysis.assessment),
        },
      },
      observations: selectedObservations,
      runtime: projectRuntime(initial.runtime, selection.observations, subjectIds),
    };
  };
  if (byteLength(buildContext(selected)) > maximumContextBytes)
    throw new ModelTurnProjectionError(
      "MODEL_INPUT_LIMIT_EXCEEDED",
      "The frozen model context header exceeds its byte budget.",
    );
  const seeds: readonly {
    readonly collection: "units" | "observations" | "candidates" | "findings";
    readonly id: string;
  }[] = summarizeRuntimeFirst
    ? pending.observations.length > 0
      ? pending.observations.map((id) => ({ collection: "observations", id }))
      : queuedUnitIds.length > 0
        ? queuedUnitIds.map((id) => ({ collection: "units", id }))
        : pending.candidates.length > 0
          ? pending.candidates.map((id) => ({ collection: "candidates", id }))
          : phase === "recheck"
            ? pending.findings.map((id) => ({ collection: "findings", id }))
            : []
    : pendingDiffChunks.length > 0
      ? pendingDiffChunks.map((id) => ({ collection: "units", id }))
      : focusedSourceUnits.length > 0
        ? focusedSourceUnits.map((unit) => ({ collection: "units", id: unit.id }))
        : [
            ...unblockedUnitIds.map((id) => ({ collection: "units" as const, id })),
            ...pending.observations.map((id) => ({ collection: "observations" as const, id })),
            ...pending.candidates.map((id) => ({ collection: "candidates" as const, id })),
            ...blockedUnitIds.map((id) => ({ collection: "units" as const, id })),
            ...(phase === "recheck"
              ? pending.findings.map((id) => ({ collection: "findings" as const, id }))
              : []),
          ];
  for (const seed of seeds) {
    if (selected[seed.collection].has(seed.id)) continue;
    const expanded = cloneSelections(selected);
    expanded[seed.collection].add(seed.id);
    if (summarizeRuntimeFirst && seed.collection === "units" && pending.observations.length === 0) {
      // An initially empty coverage unit must still see a complete, previously summarized
      // observation chain when the authorized execution has already finished.
      const unit = indexes.units.get(seed.id)!;
      const related = summarizedRuntimeEvidence.find(
        (entry) => entry.subjectRef === unit.subjectRef,
      );
      if (related !== undefined) expanded.evidence.add(related.id);
    }
    expandSelection(
      expanded,
      baseAnalysis,
      indexes,
      pendingCandidateIds,
      restoreCompletedTypedContext,
    );
    if (byteLength(buildContext(expanded)) > maximumContextBytes) {
      if (atomicSourceBatch)
        throw new ModelTurnProjectionError(
          "MODEL_INPUT_LIMIT_EXCEEDED",
          "The complete focused source batch exceeds the per-turn context budget; its units cannot be silently separated.",
        );
      if (
        selected.units.size +
          selected.observations.size +
          selected.candidates.size +
          selected.findings.size ===
        0
      )
        throw new ModelTurnProjectionError(
          "MODEL_INPUT_LIMIT_EXCEEDED",
          `The complete context for ${seed.collection} ${seed.id} exceeds the per-turn byte budget.`,
        );
      break;
    }
    if (summarizeRuntimeFirst && seed.collection === "observations") {
      const observation = indexes.observations.get(seed.id)!;
      const unit = baseAnalysis.coverage.includedUnits.find(
        (entry) => queuedUnitIdSet.has(entry.id) && entry.subjectRef === observation.subjectRef,
      );
      if (unit !== undefined && !expanded.units.has(unit.id)) {
        const withUnit = cloneSelections(expanded);
        withUnit.units.add(unit.id);
        expandSelection(
          withUnit,
          baseAnalysis,
          indexes,
          pendingCandidateIds,
          restoreCompletedTypedContext,
        );
        if (byteLength(buildContext(withUnit)) <= maximumContextBytes) {
          selected = withUnit;
          continue;
        }
      }
    }
    selected = expanded;
  }
  if (summarizeRuntimeFirst && pending.observations.length === 0 && selected.units.size > 0) {
    const subjects = new Set(
      baseAnalysis.coverage.includedUnits
        .filter((unit) => selected.units.has(unit.id))
        .map((unit) => unit.subjectRef),
    );
    for (const evidence of summarizedRuntimeEvidence) {
      if (!subjects.has(evidence.subjectRef) || selected.evidence.has(evidence.id)) continue;
      const expanded = cloneSelections(selected);
      expanded.evidence.add(evidence.id);
      expandSelection(
        expanded,
        baseAnalysis,
        indexes,
        pendingCandidateIds,
        restoreCompletedTypedContext,
      );
      if (byteLength(buildContext(expanded)) > maximumContextBytes) break;
      selected = expanded;
    }
  }
  const context = structuredClone(buildContext(selected));
  const projection: ModelTurnProjection = {
    context,
    selectedUnitIds: context.analysis.coverageUnits.map((entry) => entry.id),
    selectedCandidateIds: context.analysis.candidates.map((entry) => entry.id),
    selectedFindingIds: context.analysis.findings.map((entry) => entry.id),
    phase,
    localSourceReview,
    autonomousReview,
    baseAnalysis,
  };
  projectionObservations.set(projection, structuredClone(observations));
  return projection;
}

/** Omission is preservation. Only supplied records can be changed by this round. */
export function mergeModelTurnDelta(
  projection: ModelTurnProjection,
  delta: InvestigationModelTurnDeltaV1,
  trustedContext?: {
    readonly task: InvestigationTaskV1;
    readonly runtime?: InvestigationRuntimeState;
  },
): InvestigationLoopRoundV1 {
  if (!Value.Check(InvestigationModelTurnDeltaV1Schema, delta))
    throw modelOutputSchemaError(InvestigationModelTurnDeltaV1Schema, delta, "delta");
  const context = projection.context;
  for (const [field, matches] of [
    ["taskId", delta.taskId === context.task.id],
    ["attemptId", delta.attemptId === context.attempt.id],
    ["round", delta.round === context.round],
    ["phase", delta.phase === projection.phase],
    ["inputCheckpointRef", same(delta.inputCheckpointRef, context.inputCheckpointRef)],
  ] as const)
    if (!matches) invalid("delta_binding", [field]);
  const base = projection.baseAnalysis;
  const update = delta.analysis;
  const issues = outputValidationCollector();
  const trustedObservationIds = new Set(
    (projectionObservations.get(projection) ?? context.observations).map((entry) => entry.id),
  );
  const collidingEvidenceIndex = update.evidence.findIndex((entry) =>
    trustedObservationIds.has(entry.id),
  );
  if (collidingEvidenceIndex !== -1)
    issues.add("trusted_evidence_collision", [
      "analysis",
      "evidence",
      collidingEvidenceIndex,
      "id",
    ]);
  const next = structuredClone(base);
  next.coverage.includedUnits = mergeRecords(
    base.coverage.includedUnits,
    update.coverageUnits,
    new Set(projection.selectedUnitIds),
    "coverageUnits",
    issues.add,
    (old, value, path) => {
      const { status: _oldStatus, evidenceRefs: _oldEvidence, ...oldDefinition } = old;
      const { status: _newStatus, evidenceRefs: _newEvidence, ...newDefinition } = value;
      if (!same(oldDefinition, newDefinition)) issues.add("coverage_definition_changed", path);
    },
  );
  for (const name of collectionNames) {
    // Each collection is assigned through the same ID-preserving operation.
    const merged = mergeRecords<{ id: string }>(
      base[name],
      update[name],
      new Set(context.analysis[name].map((entry) => entry.id)),
      name,
      issues.add,
      (old, value, path) => {
        if ((name === "evidence" || name === "rechecks") && !same(old, value))
          issues.add("immutable_record_changed", path);
        if (name === "candidates") {
          const previous = old as InvestigationAnalysisV1["candidates"][number];
          const current = value as InvestigationAnalysisV1["candidates"][number];
          if (
            previous.subjectRef !== current.subjectRef ||
            previous.discoveredRound !== current.discoveredRound ||
            !same(
              previous.reviewBaselineFindingRef ?? null,
              current.reviewBaselineFindingRef ?? null,
            )
          )
            issues.add("candidate_identity_changed", path);
        }
        if (name === "findings" || name === "plans") {
          const previous = old as { id: string; version: number };
          const current = value as { id: string; version: number };
          if (
            current.version < previous.version ||
            (current.version === previous.version && !same(old, value))
          )
            issues.add("record_version_invalid", [...path, "version"]);
        }
      },
    );
    Object.assign(next, { [name]: merged });
  }
  const visibleFindingIds = new Set(projection.selectedFindingIds);
  const removed = new Set(update.removedFindingIds);
  for (const [index, id] of update.removedFindingIds.entries()) {
    const path = ["analysis", "removedFindingIds", index] as const;
    if (!visibleFindingIds.has(id) || !base.findings.some((finding) => finding.id === id))
      issues.add("finding_removal_outside_batch", path);
    if (update.findings.some((finding) => finding.id === id))
      issues.add("finding_update_removed", path);
    const owners = next.candidates.filter((candidate) => candidate.findingId === id);
    if (
      owners.length === 0 ||
      owners.some((candidate) => candidate.status !== "withdrawn" && candidate.status !== "merged")
    )
      issues.add("finding_owner_required", path);
  }
  next.findings = next.findings.filter((finding) => !removed.has(finding.id));
  const submittedCandidateIds = new Set(update.candidates.map((candidate) => candidate.id));
  const visibleCandidateIds = new Set(projection.selectedCandidateIds);
  const previousFindings = new Map(base.findings.map((finding) => [finding.id, finding]));
  const updatedFindings = new Map(update.findings.map((finding) => [finding.id, finding]));
  // An omitted visible owner keeps its substantive disposition while its version pointer
  // follows an explicitly upgraded finding. Explicit model links remain authoritative input.
  next.candidates = next.candidates.map((candidate) => {
    if (
      submittedCandidateIds.has(candidate.id) ||
      !visibleCandidateIds.has(candidate.id) ||
      candidate.findingId === null ||
      !visibleFindingIds.has(candidate.findingId) ||
      removed.has(candidate.findingId) ||
      (candidate.status !== "confirmed" && candidate.status !== "unresolved")
    )
      return candidate;
    const previous = previousFindings.get(candidate.findingId);
    const updated = updatedFindings.get(candidate.findingId);
    if (
      previous === undefined ||
      updated === undefined ||
      candidate.findingVersion !== previous.version ||
      updated.version <= previous.version ||
      previous.subjectRef !== candidate.subjectRef ||
      updated.subjectRef !== candidate.subjectRef ||
      updated.confirmation.status !==
        (candidate.status === "confirmed" ? "confirmed" : "hypothesis")
    )
      return candidate;
    return { ...candidate, findingVersion: updated.version };
  });
  if (update.summary !== null) next.summary = update.summary;
  if (update.assessment !== null) next.assessment = structuredClone(update.assessment);
  validateReferences(projection, delta, issues.add);
  if (trustedContext !== undefined) {
    const validateScope = (analysis: InvestigationAnalysisV1) =>
      validateInvestigationAnalysisForTask(trustedContext.task, analysis, trustedContext.runtime);
    for (const issue of validateScope(next).errors)
      issues.add(
        "task_scope_violation",
        nativeScopeIssuePath(issue.path, next, trustedContext.runtime),
      );
    if (issues.hasDuplicateRecords()) {
      // Last-wins assembly cannot hide an unauthorized earlier copy of a duplicate proposal.
      const audit = structuredClone(next);
      const auditedCollections = [
        "findings",
        "candidates",
        "rechecks",
        "evidence",
        "plans",
        "nextActions",
      ] as const;
      for (const name of auditedCollections)
        Object.assign(audit, { [name]: [...audit[name], ...update[name]] });
      for (const issue of validateScope(audit).errors) {
        const path = nativeScopeIssuePath(issue.path, audit, trustedContext.runtime);
        const collection = path[1];
        if (
          path[0] === "analysis" &&
          typeof collection === "string" &&
          auditedCollections.some((name) => name === collection) &&
          typeof path[2] === "number"
        ) {
          const count = next[collection as (typeof auditedCollections)[number]].length;
          if (path[2] >= count) path[2] -= count;
        }
        issues.add("task_scope_violation", path);
      }
    }
  }
  issues.throwIfAny();
  next.coverage.completedUnitRefs = next.coverage.includedUnits
    .filter((unit) => unit.status === "completed")
    .map((unit) => unit.id);
  next.coverage.unresolvedUnitRefs = next.coverage.includedUnits
    .filter((unit) => unit.status !== "completed")
    .map((unit) => unit.id);
  const pending = pendingRecords(
    next,
    projectionObservations.get(projection) ?? context.observations,
  );
  // Completion and terminal blockers are decided from the full ledger by the coordinator.
  // A versioned static agent may finish in its first invocation or stop honestly when blocked.
  const mustContinue =
    !projection.autonomousReview &&
    (projection.phase !== "finalize" ||
      pending.units.length > 0 ||
      pending.observations.length > 0 ||
      pending.candidates.length > 0 ||
      pending.findings.length > 0);
  return {
    schemaVersion: "InvestigationLoopRoundV1",
    taskId: delta.taskId,
    attemptId: delta.attemptId,
    inputCheckpointRef: structuredClone(delta.inputCheckpointRef),
    round: delta.round,
    phase: delta.phase,
    analysis: next,
    continue: delta.continue || mustContinue,
    continuationReason:
      !delta.continue && mustContinue
        ? "The complete ledger still requires investigation, rechecks, or a separate finalization round."
        : delta.continuationReason,
  };
}

function preview(value: string): Preview {
  const maximumCharacters = 1_024;
  return { text: value.slice(0, maximumCharacters), truncated: value.length > maximumCharacters };
}

function assessmentFacts(
  assessment: InvestigationAnalysisV1["assessment"],
): Readonly<Record<string, unknown>> {
  if (assessment.kind === "pr")
    return {
      reviewConclusion: assessment.reviewConclusion.status,
      e2eLevel: assessment.e2eAssessment.level,
      e2ePlanRef: assessment.e2eAssessment.planRef,
      e2eRationale: preview(assessment.e2eAssessment.rationale),
      scenarioCount: assessment.e2eAssessment.scenarioIds.length,
      prerequisiteCount: assessment.e2eAssessment.prerequisiteRefs.length,
      linkedValidationReportCount: assessment.e2eAssessment.linkedValidationReportRefs.length,
    };
  if (assessment.kind === "bug")
    return {
      status: assessment.bugAssessment.status,
      reproductionStatus: assessment.reproduction.status,
      reproductionPlanRef: assessment.reproduction.planRef,
      missingInformationCount: assessment.bugAssessment.missingInformation.length,
      hypothesisCount: assessment.bugAssessment.hypotheses.length,
      upstreamFix:
        assessment.bugAssessment.upstreamFix === null
          ? null
          : preview(assessment.bugAssessment.upstreamFix.identifier),
      duplicateOf:
        assessment.bugAssessment.duplicateOf === null
          ? null
          : preview(assessment.bugAssessment.duplicateOf.identifier),
    };
  if (assessment.kind === "feature")
    return {
      status: assessment.featureAssessment.status,
      implementationPlanRef: assessment.featureAssessment.implementationPlanRef,
      requirementCount: assessment.featureAssessment.requirements.length,
      missingInformationCount: assessment.featureAssessment.missingInformation.length,
      decisionCount: assessment.featureAssessment.decisions.length,
      acceptanceCriterionCount: assessment.featureAssessment.acceptanceCriteria.length,
      prerequisiteCount: assessment.featureAssessment.prerequisiteRefs.length,
    };
  return { classification: preview(assessment.classification) };
}

function projectRuntime(
  runtime: InvestigationRuntimeState,
  selected: ReadonlySet<string>,
  subjects: ReadonlySet<string>,
): ModelTurnProjectionContext["runtime"] {
  const checks = runtime.checks.filter((check) =>
    check.evidenceRefs.some((id) => selected.has(id)),
  );
  const checkIds = new Set(checks.map((check) => check.id));
  const completedIds = new Set(runtime.completedSteps.map((step) => step.stepId));
  const completed = runtime.completedSteps.filter((step) =>
    step.verificationEvidence.some((entry) => selected.has(entry.id)),
  );
  const selectedStepIds = new Set(completed.map((step) => step.stepId));
  return {
    checks,
    startedSteps: runtime.startedSteps.filter(
      (step) =>
        selectedStepIds.has(step.stepId) ||
        (!completedIds.has(step.stepId) && subjects.has(step.subjectRef)),
    ),
    completedSteps: completed.map((step) => ({
      stepId: step.stepId,
      attemptId: step.attemptId,
      subjectRef: step.subjectRef,
      subjectRevisionKey: step.subjectRevisionKey,
      planRef: step.planRef,
      outcome: step.outcome,
      validationSummary: preview(step.validation.summary),
      checkIds: step.validation.checks
        .filter((check) => checkIds.has(check.id))
        .map((check) => check.id),
      observationCount: step.verificationEvidence.length,
      providedEvidenceRefs: step.verificationEvidence
        .filter((entry) => selected.has(entry.id))
        .map((entry) => entry.id),
      diagnosticCount: step.diagnostics.length,
    })),
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function same(left: unknown, right: unknown): boolean {
  return investigationContentDigest(left) === investigationContentDigest(right);
}
function invalid(rule: ModelOutputValidationRule, path: ModelOutputValidationPath): never {
  throw new ModelOutputValidationError(rule, path);
}

type RecordOutputIssue = (rule: ModelOutputValidationRule, path: ModelOutputValidationPath) => void;

/** Inspect every schema-valid record before deciding whether its failure permits correction. */
function outputValidationCollector(): {
  readonly add: RecordOutputIssue;
  readonly throwIfAny: () => void;
  readonly hasDuplicateRecords: () => boolean;
} {
  let duplicateRecords = false;
  let selected:
    | {
        readonly rule: ModelOutputValidationRule;
        readonly correctable: boolean;
        readonly path: ModelOutputValidationPath;
        readonly relatedPaths: ModelOutputValidationPath[];
      }
    | undefined;
  return {
    add(rule, path) {
      const error = new ModelOutputValidationError(rule, path);
      const issue = safeModelOutputValidationIssue(error)!;
      if (issue.rule === "duplicate_record_id") duplicateRecords = true;
      const correctable = isCorrectableInvestigationModelOutputIssue(issue);
      if (selected === undefined || (selected.correctable && !correctable)) {
        selected = { rule: issue.rule, correctable, path, relatedPaths: [] };
      } else if (selected.rule === issue.rule && selected.relatedPaths.length < 7) {
        selected.relatedPaths.push(path);
      }
    },
    throwIfAny() {
      if (selected !== undefined)
        throw new ModelOutputValidationError(selected.rule, selected.path, selected.relatedPaths);
    },
    hasDuplicateRecords: () => duplicateRecords,
  };
}

/** Native validation paths are structural metadata; preserve only actual numeric array indexes. */
function nativeScopeIssuePath(
  path: string,
  analysis: InvestigationAnalysisV1,
  runtime: InvestigationRuntimeState | undefined,
): (string | number)[] {
  const fromRuntime = path === "/runtime" || path.startsWith("/runtime/");
  const segments: (string | number)[] = fromRuntime ? [] : ["analysis"];
  let parent: unknown = fromRuntime ? { runtime } : analysis;
  for (const encoded of path.split("/").slice(1)) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    segments.push(Array.isArray(parent) && /^(0|[1-9][0-9]{0,5})$/u.test(key) ? Number(key) : key);
    parent =
      typeof parent === "object" && parent !== null && Object.hasOwn(parent, key)
        ? (parent as Record<string, unknown>)[key]
        : undefined;
  }
  return segments;
}

function pendingRecords(
  analysis: InvestigationAnalysisV1,
  observations: readonly InvestigationEvidenceV1[],
) {
  const evidence = new Map(
    [...analysis.evidence, ...observations].map((entry) => [entry.id, entry]),
  );
  const rechecks = new Map(analysis.rechecks.map((entry) => [entry.id, entry]));
  const summarizedObservations = new Set(analysis.evidence.flatMap((entry) => entry.evidenceRefs));
  return {
    units: analysis.coverage.includedUnits
      .filter((unit) => unit.status !== "completed")
      .map((unit) => unit.id),
    observations: observations
      .filter((entry) => !summarizedObservations.has(entry.id))
      .map((entry) => entry.id),
    candidates: analysis.candidates
      .filter(
        (candidate) =>
          candidate.status === "pending" ||
          candidate.reviewDisposition === "pending" ||
          ((candidate.status === "withdrawn" || candidate.status === "merged") &&
            (candidate.evidenceRefs.length === 0 ||
              candidate.evidenceRefs.some(
                (id) => evidence.get(id)?.subjectRef !== candidate.subjectRef,
              ))),
      )
      .map((candidate) => candidate.id),
    findings: analysis.findings
      .filter((finding) => {
        const recheck =
          finding.confirmation.recheckRef === null
            ? undefined
            : rechecks.get(finding.confirmation.recheckRef);
        return (
          recheck === undefined ||
          recheck.findingId !== finding.id ||
          recheck.findingVersion !== finding.version ||
          recheck.subjectRef !== finding.subjectRef ||
          recheck.evidenceRefs.length === 0 ||
          recheck.evidenceRefs.some((id) => evidence.get(id)?.subjectRef !== finding.subjectRef) ||
          (finding.confirmation.status === "hypothesis" &&
            (recheck.unresolvedQuestions.length === 0 || analysis.limitations.length === 0))
        );
      })
      .map((finding) => finding.id),
  };
}

function emptySelections(): Selections {
  return {
    units: new Set(),
    sourceUnits: new Set(),
    observations: new Set(),
    findings: new Set(),
    candidates: new Set(),
    rechecks: new Set(),
    evidence: new Set(),
    plans: new Set(),
    nextActions: new Set(),
    feedbackDrafts: new Set(),
    diagnostics: new Set(),
    limitations: new Set(),
  };
}
function cloneSelections(selection: Selections): Selections {
  const cloned = emptySelections();
  for (const name of ["units", "sourceUnits", "observations", ...collectionNames] as const)
    cloned[name] = new Set(selection[name]);
  return cloned;
}
function pickCollections(
  analysis: InvestigationAnalysisV1,
  selected: Selections,
): AnalysisCollections {
  return {
    findings: analysis.findings.filter((entry) => selected.findings.has(entry.id)),
    candidates: analysis.candidates.filter((entry) => selected.candidates.has(entry.id)),
    rechecks: analysis.rechecks.filter((entry) => selected.rechecks.has(entry.id)),
    evidence: analysis.evidence.filter((entry) => selected.evidence.has(entry.id)),
    plans: analysis.plans.filter((entry) => selected.plans.has(entry.id)),
    nextActions: analysis.nextActions.filter((entry) => selected.nextActions.has(entry.id)),
    feedbackDrafts: analysis.feedbackDrafts.filter((entry) =>
      selected.feedbackDrafts.has(entry.id),
    ),
    diagnostics: analysis.diagnostics.filter((entry) => selected.diagnostics.has(entry.id)),
    limitations: analysis.limitations.filter((entry) => selected.limitations.has(entry.id)),
  };
}
function makeIndexes(
  analysis: InvestigationAnalysisV1,
  observations: readonly InvestigationEvidenceV1[],
) {
  return {
    units: new Map(analysis.coverage.includedUnits.map((entry) => [entry.id, entry])),
    sourceUnits: new Map(analysis.coverage.includedUnits.map((entry) => [entry.id, entry])),
    findings: new Map(analysis.findings.map((entry) => [entry.id, entry])),
    candidates: new Map(analysis.candidates.map((entry) => [entry.id, entry])),
    rechecks: new Map(analysis.rechecks.map((entry) => [entry.id, entry])),
    evidence: new Map(analysis.evidence.map((entry) => [entry.id, entry])),
    observations: new Map(observations.map((entry) => [entry.id, entry])),
    plans: new Map(analysis.plans.map((entry) => [entry.id, entry])),
    nextActions: new Map(analysis.nextActions.map((entry) => [entry.id, entry])),
    feedbackDrafts: new Map(analysis.feedbackDrafts.map((entry) => [entry.id, entry])),
    diagnostics: new Map(analysis.diagnostics.map((entry) => [entry.id, entry])),
    limitations: new Map(analysis.limitations.map((entry) => [entry.id, entry])),
  };
}

function expandSelection(
  selected: Selections,
  analysis: InvestigationAnalysisV1,
  indexes: ReturnType<typeof makeIndexes>,
  pendingCandidateIds: ReadonlySet<string>,
  restoreCompletedTypedContext: boolean,
): void {
  const queue: Array<{ collection: keyof Selections; id: string }> = [];
  const visited = emptySelections();
  const add = (collection: keyof Selections, id: string | null | undefined): void => {
    if (
      id === null ||
      id === undefined ||
      !indexes[collection].has(id) ||
      visited[collection].has(id)
    )
      return;
    selected[collection].add(id);
    visited[collection].add(id);
    queue.push({ collection, id });
  };
  for (const collection of ["units", "sourceUnits", "observations", ...collectionNames] as const)
    for (const id of selected[collection]) add(collection, id);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const record = indexes[current.collection].get(current.id)!;
    collectReferenceIds(record, "evidenceRefs").forEach((id) => {
      add("evidence", id);
      add("observations", id);
    });
    collectReferenceIds(record, "planRef").forEach((id) => {
      add("plans", id);
    });
    collectReferenceIds(record, "draftRef").forEach((id) => {
      add("feedbackDrafts", id);
    });
    if (current.collection === "units") {
      const unit = indexes.units.get(current.id)!;
      if (unit.kind === "full_diff")
        for (const dependency of analysis.coverage.includedUnits)
          if (
            dependency.subjectRef === unit.subjectRef &&
            dependency.status === "completed" &&
            (dependency.kind === "pr_diff_chunk" ||
              (dependency.kind === "source_file" && dependency.paths.length > 0))
          )
            add("sourceUnits", dependency.id);
      if (
        restoreCompletedTypedContext &&
        unit.kind === "source_file" &&
        unit.paths.length > 0 &&
        (unit.status === "pending" || unit.status === "blocked")
      )
        for (const dependency of analysis.coverage.includedUnits)
          if (
            dependency.subjectRef === unit.subjectRef &&
            dependency.status === "completed" &&
            dependency.kind === "source_file" &&
            dependency.paths.length > 0
          )
            add("sourceUnits", dependency.id);
    }
    if (current.collection === "candidates") {
      const candidate = indexes.candidates.get(current.id)!;
      add("findings", candidate.findingId);
      add("candidates", candidate.mergedIntoCandidateId);
      if (pendingCandidateIds.has(candidate.id)) {
        const evidenceIds = evidenceDependencyIds(
          candidate.evidenceRefs,
          candidate.subjectRef,
          indexes,
        );
        const sourceUnits = analysis.coverage.includedUnits.filter(
          (unit) =>
            unit.subjectRef === candidate.subjectRef &&
            (unit.kind === "pr_diff_chunk" || unit.paths.length > 0) &&
            [...evidenceDependencyIds(unit.evidenceRefs, unit.subjectRef, indexes)].some((id) =>
              evidenceIds.has(id),
            ),
        );
        // Empty metadata paths cannot recover source. The frozen completed diff is the
        // explicit fallback when the candidate has no typed source association.
        const dependencies =
          sourceUnits.length > 0
            ? sourceUnits
            : analysis.coverage.includedUnits.filter(
                (unit) =>
                  unit.subjectRef === candidate.subjectRef &&
                  unit.kind === "pr_diff_chunk" &&
                  unit.status === "completed",
              );
        for (const unit of dependencies) add("sourceUnits", unit.id);
      }
    }
    if (current.collection === "findings") {
      const finding = indexes.findings.get(current.id)!;
      add("rechecks", finding.confirmation.recheckRef);
      add("feedbackDrafts", finding.feedbackDraft.id);
      for (const candidate of analysis.candidates)
        if (candidate.findingId === finding.id) add("candidates", candidate.id);
    }
    if (current.collection === "plans" || current.collection === "feedbackDrafts")
      for (const action of analysis.nextActions)
        if (action.planRef?.id === current.id || action.draftRef === current.id)
          add("nextActions", action.id);
  }
}

function evidenceDependencyIds(
  references: readonly string[],
  subjectRef: string,
  indexes: ReturnType<typeof makeIndexes>,
): ReadonlySet<string> {
  const found = new Set<string>();
  const queue = [...references];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    if (found.has(id)) continue;
    const entry = indexes.evidence.get(id) ?? indexes.observations.get(id);
    if (entry === undefined || entry.subjectRef !== subjectRef) continue;
    found.add(id);
    queue.push(...entry.evidenceRefs);
  }
  return found;
}

function collectReferenceIds(value: unknown, key: string): string[] {
  return collectReferences(value, key).map((reference) => reference.id);
}

interface ModelReference {
  readonly id: string;
  readonly path: readonly (string | number)[];
}

function collectReferences(
  value: unknown,
  key: string,
  path: readonly (string | number)[] = [],
): ModelReference[] {
  const found: ModelReference[] = [];
  if (value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      found.push(...collectReferences(entry, key, [...path, index]));
    return found;
  }
  for (const [name, child] of Object.entries(value)) {
    const childPath = [...path, name];
    if (name === key || (key === "planRef" && name.endsWith("PlanRef"))) {
      if (typeof child === "string") found.push({ id: child, path: childPath });
      else if (Array.isArray(child))
        for (const [index, entry] of child.entries()) {
          if (typeof entry === "string") found.push({ id: entry, path: [...childPath, index] });
        }
      else if (
        child !== null &&
        typeof child === "object" &&
        "id" in child &&
        typeof child.id === "string"
      )
        found.push({ id: child.id, path: [...childPath, "id"] });
    } else if (child !== null && typeof child === "object")
      found.push(...collectReferences(child, key, childPath));
  }
  return found;
}

function mergeRecords<T extends { id: string }>(
  base: readonly T[],
  updates: readonly T[],
  visible: ReadonlySet<string>,
  name: CollectionName | "coverageUnits",
  recordIssue: RecordOutputIssue,
  validateUpdate?: (previous: T, current: T, path: readonly (string | number)[]) => void,
): T[] {
  const accepted = new Map(base.map((entry) => [entry.id, entry]));
  const entries = new Map(accepted);
  const seen = new Set<string>();
  for (const [index, update] of updates.entries()) {
    const path = ["analysis", name, index] as const;
    if (seen.has(update.id)) recordIssue("duplicate_record_id", [...path, "id"]);
    seen.add(update.id);
    // A duplicate proposed ID is not an accepted record. Validate each copy against the ledger.
    const previous = accepted.get(update.id);
    if (previous !== undefined) {
      if (!visible.has(update.id)) recordIssue("record_outside_batch", [...path, "id"]);
      validateUpdate?.(previous, update, path);
    }
    entries.set(update.id, structuredClone(update));
  }
  return [...entries.values()].map((entry) => structuredClone(entry));
}

function validateReferences(
  projection: ModelTurnProjection,
  delta: InvestigationModelTurnDeltaV1,
  recordIssue: RecordOutputIssue,
): void {
  const context = projection.context;
  const update = delta.analysis;
  const ids = (name: CollectionName): Set<string> =>
    new Set([...context.analysis[name], ...update[name]].map((entry) => entry.id));
  const evidence = ids("evidence");
  for (const entry of context.observations) evidence.add(entry.id);
  const plans = ids("plans");
  for (const id of collectReferenceIds(context.analysis.assessment.facts, "planRef")) plans.add(id);
  const drafts = ids("feedbackDrafts");
  const findings = ids("findings");
  const candidates = ids("candidates");
  for (const finding of [...context.analysis.findings, ...update.findings])
    drafts.add(finding.feedbackDraft.id);
  const subjects = new Set(context.subjects.map((subject) => subject.id));
  const existingDrafts = new Map(
    projection.baseAnalysis.findings.map((finding) => [finding.feedbackDraft.id, finding]),
  );
  for (const [index, draft] of update.feedbackDrafts.entries()) {
    const owner = existingDrafts.get(draft.id);
    if (
      owner !== undefined &&
      (!projection.selectedFindingIds.includes(owner.id) || !same(owner.feedbackDraft, draft))
    )
      recordIssue("embedded_draft_update", ["analysis", "feedbackDrafts", index]);
  }
  for (const [index, finding] of update.findings.entries()) {
    const owner = existingDrafts.get(finding.feedbackDraft.id);
    if (owner !== undefined && owner.id !== finding.id)
      recordIssue("draft_identity_collision", [
        "analysis",
        "findings",
        index,
        "feedbackDraft",
        "id",
      ]);
  }
  const check = (references: readonly ModelReference[], allowed: ReadonlySet<string>): void => {
    for (const reference of references)
      if (!allowed.has(reference.id)) recordIssue("reference_outside_batch", reference.path);
  };
  check(collectReferences(update, "evidenceRefs", ["analysis"]), evidence);
  check(collectReferences(update, "planRef", ["analysis"]), plans);
  check(collectReferences(update, "draftRef", ["analysis"]), drafts);
  check(collectReferences(update, "subjectRef", ["analysis"]), subjects);
  check(
    update.candidates.flatMap((entry, index) =>
      entry.findingId === null
        ? []
        : [{ id: entry.findingId, path: ["analysis", "candidates", index, "findingId"] }],
    ),
    findings,
  );
  check(
    update.candidates.flatMap((entry, index) =>
      entry.mergedIntoCandidateId === null
        ? []
        : [
            {
              id: entry.mergedIntoCandidateId,
              path: ["analysis", "candidates", index, "mergedIntoCandidateId"],
            },
          ],
    ),
    candidates,
  );
  check(
    update.rechecks.map((entry, index) => ({
      id: entry.findingId,
      path: ["analysis", "rechecks", index, "findingId"],
    })),
    findings,
  );
  const rechecks = ids("rechecks");
  check(
    update.findings.flatMap((entry, index) =>
      entry.confirmation.recheckRef === null
        ? []
        : [
            {
              id: entry.confirmation.recheckRef,
              path: ["analysis", "findings", index, "confirmation", "recheckRef"],
            },
          ],
    ),
    rechecks,
  );
}
