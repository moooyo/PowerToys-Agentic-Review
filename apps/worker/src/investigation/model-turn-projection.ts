import {
  EntityIdSchema,
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
  type InvestigationRuntimeState,
  type InvestigationTaskV1,
  InvestigationVersionRefSchema,
  PositiveIntegerSchema,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint, investigationContentDigest } from "@agentic-review/domain";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const text = Type.String({ minLength: 1 });
const objectOptions = { additionalProperties: false } as const;

/** Status-specific wire constraints supplement, never replace, ledger reference validation. */
export const InvestigationModelCandidateSchema = Type.Union([
  Type.Object(
    {
      ...InvestigationCandidateSchema.properties,
      status: Type.Union([Type.Literal("confirmed"), Type.Literal("unresolved")]),
      findingId: EntityIdSchema,
      findingVersion: PositiveIntegerSchema,
      mergedIntoCandidateId: Type.Null(),
    },
    objectOptions,
  ),
  Type.Object(
    {
      ...InvestigationCandidateSchema.properties,
      status: Type.Union([Type.Literal("pending"), Type.Literal("withdrawn")]),
      mergedIntoCandidateId: Type.Null(),
    },
    objectOptions,
  ),
  Type.Object(
    {
      ...InvestigationCandidateSchema.properties,
      status: Type.Literal("merged"),
      mergedIntoCandidateId: EntityIdSchema,
    },
    objectOptions,
  ),
]);

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
        plans: Type.Array(InvestigationPlanDraftSchema),
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
  analysis: Omit<ModelTurnDeltaWire["analysis"], "candidates"> &
    Pick<InvestigationAnalysisV1, "candidates">;
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
    readonly budget: InvestigationTaskV1["budget"];
    readonly profileRef: InvestigationTaskV1["profileRef"];
    readonly promptRef: InvestigationTaskV1["promptRef"];
  };
  readonly attempt: { readonly id: string; readonly number: number };
  readonly inputCheckpointRef: InvestigationLoopRoundV1["inputCheckpointRef"];
  readonly round: number;
  readonly phase: Phase;
  readonly budgetState: {
    readonly consumed: InvestigationLoopCheckpointV1["consumed"];
    readonly remaining: InvestigationLoopCheckpointV1["consumed"];
  };
  readonly subjects: InvestigationTaskV1["subjects"];
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
  readonly maximumContextBytes: number;
}): ModelTurnProjection {
  const { task, attempt, checkpoint, maximumContextBytes } = input;
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
        budget: task.budget,
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
          rounds: Math.max(0, task.budget.maxRounds - initial.consumed.rounds),
          durationMs: Math.max(0, task.budget.maxDurationMs - initial.consumed.durationMs),
          tokens: Math.max(0, task.budget.maxTokens - initial.consumed.tokens),
          reportBytes: Math.max(0, task.budget.maxReportBytes - initial.consumed.reportBytes),
        },
      },
      subjects: [
        ...new Map(
          [...task.subjects, ...initial.runtime.subjects].map((subject) => [subject.id, subject]),
        ).values(),
      ].filter((subject) => subjectIds.has(subject.id)),
      counts,
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
): InvestigationLoopRoundV1 {
  if (!Value.Check(InvestigationModelTurnDeltaV1Schema, delta))
    invalid("The model response does not match the bounded delta schema.");
  const context = projection.context;
  if (
    delta.taskId !== context.task.id ||
    delta.attemptId !== context.attempt.id ||
    delta.round !== context.round ||
    delta.phase !== projection.phase ||
    !same(delta.inputCheckpointRef, context.inputCheckpointRef)
  )
    invalid(
      "The model delta does not match its projected task, attempt, checkpoint, round, and phase.",
    );
  const base = projection.baseAnalysis;
  const update = delta.analysis;
  const trustedObservationIds = new Set(
    (projectionObservations.get(projection) ?? context.observations).map((entry) => entry.id),
  );
  if (update.evidence.some((entry) => trustedObservationIds.has(entry.id)))
    invalid("Model evidence cannot replace a Worker observation identity.");
  const next = structuredClone(base);
  next.coverage.includedUnits = mergeRecords(
    base.coverage.includedUnits,
    update.coverageUnits,
    new Set(projection.selectedUnitIds),
    "coverage unit",
    (old, value) => {
      const { status: _oldStatus, evidenceRefs: _oldEvidence, ...oldDefinition } = old;
      const { status: _newStatus, evidenceRefs: _newEvidence, ...newDefinition } = value;
      if (!same(oldDefinition, newDefinition))
        invalid("A coverage update cannot change frozen required work or its subject.");
    },
  );
  for (const name of collectionNames) {
    // Each collection is assigned through the same ID-preserving operation.
    const merged = mergeRecords<{ id: string }>(
      base[name],
      update[name],
      new Set(context.analysis[name].map((entry) => entry.id)),
      name,
      (old, value) => {
        if ((name === "evidence" || name === "rechecks") && !same(old, value))
          invalid(`Accepted ${name} records are immutable.`);
        if (name === "candidates") {
          const previous = old as InvestigationAnalysisV1["candidates"][number];
          const current = value as InvestigationAnalysisV1["candidates"][number];
          if (
            previous.subjectRef !== current.subjectRef ||
            previous.discoveredRound !== current.discoveredRound
          )
            invalid("A candidate update must preserve its subject and discovery round.");
        }
        if (name === "findings" || name === "plans") {
          const previous = old as { id: string; version: number };
          const current = value as { id: string; version: number };
          if (
            current.version < previous.version ||
            (current.version === previous.version && !same(old, value))
          )
            invalid(`Changing an existing ${name} record requires a newer content version.`);
        }
      },
    );
    Object.assign(next, { [name]: merged });
  }
  const visibleFindingIds = new Set(projection.selectedFindingIds);
  const removed = new Set(update.removedFindingIds);
  for (const id of removed) {
    if (!visibleFindingIds.has(id) || !base.findings.some((finding) => finding.id === id))
      invalid("A delta cannot remove a finding outside its supplied batch.");
    if (update.findings.some((finding) => finding.id === id))
      invalid("A delta cannot both update and remove the same finding.");
    const owners = next.candidates.filter((candidate) => candidate.findingId === id);
    if (
      owners.length === 0 ||
      owners.some((candidate) => candidate.status !== "withdrawn" && candidate.status !== "merged")
    )
      invalid(
        "Removing a finding requires retained withdrawal or merge records for every owning candidate.",
      );
  }
  next.findings = next.findings.filter((finding) => !removed.has(finding.id));
  if (update.summary !== null) next.summary = update.summary;
  if (update.assessment !== null) next.assessment = structuredClone(update.assessment);
  validateReferences(projection, delta);
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
function invalid(message: string): never {
  throw new ModelTurnProjectionError("MODEL_OUTPUT_INVALID", message);
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
  const found: string[] = [];
  if (value === null || typeof value !== "object") return found;
  for (const [name, child] of Object.entries(value)) {
    if (name === key || (key === "planRef" && name.endsWith("PlanRef"))) {
      if (typeof child === "string") found.push(child);
      else if (Array.isArray(child))
        found.push(...child.filter((entry): entry is string => typeof entry === "string"));
      else if (
        child !== null &&
        typeof child === "object" &&
        "id" in child &&
        typeof child.id === "string"
      )
        found.push(child.id);
    } else if (child !== null && typeof child === "object")
      found.push(...collectReferenceIds(child, key));
  }
  return found;
}

function mergeRecords<T extends { id: string }>(
  base: readonly T[],
  updates: readonly T[],
  visible: ReadonlySet<string>,
  name: string,
  validateUpdate?: (previous: T, current: T) => void,
): T[] {
  const entries = new Map(base.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const update of updates) {
    if (seen.has(update.id)) invalid(`The model delta contains duplicate ${name} IDs.`);
    seen.add(update.id);
    const previous = entries.get(update.id);
    if (previous !== undefined) {
      if (!visible.has(update.id))
        invalid(`The model delta modifies ${name} ${update.id} outside its supplied batch.`);
      validateUpdate?.(previous, update);
    }
    entries.set(update.id, structuredClone(update));
  }
  return [...entries.values()].map((entry) => structuredClone(entry));
}

function validateReferences(
  projection: ModelTurnProjection,
  delta: InvestigationModelTurnDeltaV1,
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
  for (const draft of update.feedbackDrafts) {
    const owner = existingDrafts.get(draft.id);
    if (
      owner !== undefined &&
      (!projection.selectedFindingIds.includes(owner.id) || !same(owner.feedbackDraft, draft))
    )
      invalid("An embedded finding draft can only change through its supplied owning finding.");
  }
  for (const finding of update.findings) {
    const owner = existingDrafts.get(finding.feedbackDraft.id);
    if (owner !== undefined && owner.id !== finding.id)
      invalid("A finding cannot take over another finding's draft identity.");
  }
  const check = (
    references: readonly string[],
    allowed: ReadonlySet<string>,
    kind: string,
  ): void => {
    if (references.some((id) => !allowed.has(id)))
      invalid(`The model delta references ${kind} outside its supplied batch or new records.`);
  };
  check(collectReferenceIds(update, "evidenceRefs"), evidence, "evidence");
  check(collectReferenceIds(update, "planRef"), plans, "plans");
  check(collectReferenceIds(update, "draftRef"), drafts, "drafts");
  check(collectReferenceIds(update, "subjectRef"), subjects, "subjects");
  check(
    update.candidates.flatMap((entry) => (entry.findingId === null ? [] : [entry.findingId])),
    findings,
    "findings",
  );
  check(
    update.candidates.flatMap((entry) =>
      entry.mergedIntoCandidateId === null ? [] : [entry.mergedIntoCandidateId],
    ),
    candidates,
    "candidates",
  );
  check(
    update.rechecks.map((entry) => entry.findingId),
    findings,
    "findings",
  );
  const rechecks = ids("rechecks");
  check(
    update.findings.flatMap((entry) =>
      entry.confirmation.recheckRef === null ? [] : [entry.confirmation.recheckRef],
    ),
    rechecks,
    "rechecks",
  );
}
