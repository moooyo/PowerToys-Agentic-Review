import { createHash } from "node:crypto";
import type {
  InvestigationAnalysisV1,
  InvestigationBudget,
  InvestigationCoverage,
  InvestigationDiagnostic,
  InvestigationLoopCheckpointV1,
  InvestigationLoopRoundV1,
  InvestigationPrDiffManifestV1,
  InvestigationRuntimeState,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { validateInvestigationPrDiffManifest } from "@agentic-review/contracts";

export class InvestigationLoopError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationLoopError";
  }
}

function requireCondition(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new InvestigationLoopError(code, message);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function investigationContentDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function checkpointDigest(checkpoint: InvestigationLoopCheckpointV1): string {
  const { digest: _digest, ...content } = checkpoint;
  return investigationContentDigest(content);
}

export function investigationTaskBindingDigest(task: InvestigationTaskV1): string {
  return investigationContentDigest({
    id: task.id,
    kind: task.kind,
    repository: task.repository,
    workItem: task.workItem,
    parentTaskId: task.parentTaskId,
    parentReportRef: task.parentReportRef,
    planRef: task.planRef,
    subjectRef: task.subjectRef,
    subjects: task.subjects,
    scope: task.scope,
    executionPolicy: task.executionPolicy,
    budget: task.budget,
    profileRef: task.profileRef,
    promptRef: task.promptRef,
  });
}

function reference(checkpoint: InvestigationLoopCheckpointV1) {
  return { id: checkpoint.id, version: checkpoint.version, digest: checkpoint.digest };
}

function sealCheckpoint(checkpoint: InvestigationLoopCheckpointV1): InvestigationLoopCheckpointV1 {
  return { ...checkpoint, digest: checkpointDigest(checkpoint) };
}

function retainedReportBytes(
  analysis: InvestigationAnalysisV1,
  runtime: InvestigationRuntimeState,
): number {
  return Buffer.byteLength(JSON.stringify({ analysis, runtime }), "utf8");
}

function scopeDefinition(coverage: InvestigationCoverage): unknown {
  return {
    includedUnits: coverage.includedUnits
      .map(({ status: _status, evidenceRefs: _evidence, ...unit }) => unit)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    exclusions: [...coverage.exclusions].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  };
}

function normalizeCoverage(
  previous: InvestigationCoverage,
  proposed: InvestigationCoverage,
): InvestigationCoverage {
  requireCondition(
    previous.scopeManifest.id === proposed.scopeManifest.id,
    "scope_manifest_identity_changed",
    "The frozen scope manifest identity cannot be replaced.",
  );
  const definition = scopeDefinition(proposed);
  return {
    ...proposed,
    scopeManifest: {
      id: previous.scopeManifest.id,
      version:
        previous.scopeManifest.version + (unchanged(scopeDefinition(previous), definition) ? 0 : 1),
      digest: investigationContentDigest(definition),
    },
  };
}

export function assertInvestigationCheckpointIntegrity(
  checkpoint: InvestigationLoopCheckpointV1,
): void {
  requireCondition(
    checkpoint.digest === checkpointDigest(checkpoint),
    "checkpoint_digest_mismatch",
    "The checkpoint content does not match its digest.",
  );
}

export interface CreateInvestigationCheckpointInput {
  readonly task: InvestigationTaskV1;
  readonly attemptId: string;
  readonly checkpointId: string;
  readonly leaseVersion: number;
  readonly recordedAt: string;
}

export function createInvestigationCheckpoint(
  input: CreateInvestigationCheckpointInput,
): InvestigationLoopCheckpointV1 {
  const { task } = input;
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  requireCondition(
    subject !== undefined,
    "unknown_task_subject",
    "The task subject must be present in the frozen subject collection.",
  );
  const analysis: InvestigationAnalysisV1 = {
    schemaVersion: "InvestigationAnalysisV1",
    summary: "Investigation has not started.",
    coverage: structuredClone(task.scope),
    findings: [],
    candidates: [],
    rechecks: [],
    evidence: [],
    plans: [],
    nextActions: [],
    feedbackDrafts: [],
    diagnostics: [],
    limitations: [],
    assessment:
      task.workItem.kind === "pull_request"
        ? {
            kind: "pr",
            subjectRef: task.subjectRef,
            summary: "Investigation has not started.",
            evidenceRefs: [],
            reviewConclusion: {
              status: "inconclusive",
              rationale: "The first investigation round has not run.",
            },
            e2eAssessment: {
              level: "recommended",
              rationale: "E2E requirements have not been assessed.",
              planRef: null,
              scenarioIds: [],
              prerequisiteRefs: [],
              linkedValidationReportRefs: [],
            },
          }
        : {
            kind: "other_issue",
            subjectRef: task.subjectRef,
            summary: "Investigation has not started.",
            evidenceRefs: [],
            classification: "pending",
            explanation: "The first investigation round will establish the assessment.",
          },
  };
  analysis.coverage = normalizeCoverage(task.scope, analysis.coverage);
  return sealCheckpoint({
    schemaVersion: "InvestigationLoopCheckpointV1",
    id: input.checkpointId,
    version: 1,
    digest: "0".repeat(64),
    taskId: task.id,
    attemptId: input.attemptId,
    leaseVersion: input.leaseVersion,
    subjectRevisionKey: subject.revisionKey,
    profileRef: structuredClone(task.profileRef),
    promptRef: structuredClone(task.promptRef),
    taskBindingDigest: investigationTaskBindingDigest(task),
    previousCheckpointRef: null,
    round: 0,
    analysis,
    adoptedAttemptIds: [input.attemptId],
    recordedAt: input.recordedAt,
    budget: structuredClone(task.budget),
    consumed: { rounds: 0, durationMs: 0, tokens: 0, reportBytes: 0 },
    stopReason: "continuing",
    lastPhase: null,
    runtime: {
      completedStepIds: [],
      checks: [],
      evidence: [],
      artifacts: [],
      subjects: [],
      startedSteps: [],
      completedSteps: [],
    },
  });
}

function uniqueIds(entries: readonly { id: string }[], kind: string): void {
  requireCondition(
    new Set(entries.map((entry) => entry.id)).size === entries.length,
    `duplicate_${kind}_id`,
    `${kind} IDs must be unique across the complete collection.`,
  );
}

function unchanged(left: unknown, right: unknown): boolean {
  return investigationContentDigest(left) === investigationContentDigest(right);
}

function assertPreserved<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  kind: string,
  immutable: boolean,
): void {
  const afterMap = new Map(after.map((entry) => [entry.id, entry]));
  for (const previous of before) {
    const next = afterMap.get(previous.id);
    requireCondition(
      next !== undefined,
      `discarded_${kind}`,
      `The complete ${kind} ledger cannot discard ${previous.id}.`,
    );
    if (immutable)
      requireCondition(
        unchanged(previous, next),
        `mutated_${kind}`,
        `The accepted ${kind} record ${previous.id} is immutable.`,
      );
  }
}

function assertAnalysisTransition(
  previous: InvestigationAnalysisV1,
  round: InvestigationLoopRoundV1,
): void {
  const analysis = round.analysis;
  for (const [kind, entries] of Object.entries({
    finding: analysis.findings,
    candidate: analysis.candidates,
    recheck: analysis.rechecks,
    evidence: analysis.evidence,
    plan: analysis.plans,
    action: analysis.nextActions,
    draft: analysis.feedbackDrafts,
    coverage: analysis.coverage.includedUnits,
    exclusion: analysis.coverage.exclusions,
  }))
    uniqueIds(entries, kind);
  const coverage = new Map(analysis.coverage.includedUnits.map((unit) => [unit.id, unit]));
  requireCondition(
    analysis.coverage.scopeManifest.id === previous.coverage.scopeManifest.id &&
      analysis.coverage.scopeManifest.version >= previous.coverage.scopeManifest.version,
    "scope_manifest_regression",
    "The scope manifest identity and version cannot regress.",
  );
  for (const unit of previous.coverage.includedUnits) {
    const next = coverage.get(unit.id);
    requireCondition(
      next !== undefined,
      "discarded_coverage",
      `The frozen coverage unit ${unit.id} cannot be removed.`,
    );
    const { status: _oldStatus, evidenceRefs: _oldEvidence, ...oldDefinition } = unit;
    const { status: _newStatus, evidenceRefs: _newEvidence, ...newDefinition } = next;
    requireCondition(
      unchanged(oldDefinition, newDefinition),
      "changed_scope_definition",
      `The required work for ${unit.id} cannot be narrowed or reassigned.`,
    );
  }
  assertPreserved(previous.coverage.exclusions, analysis.coverage.exclusions, "exclusion", true);
  requireCondition(
    analysis.coverage.exclusions.length === previous.coverage.exclusions.length,
    "new_scope_exclusion",
    "A model round cannot exclude additional scope to make an incomplete investigation complete.",
  );
  assertPreserved(previous.candidates, analysis.candidates, "candidate", false);
  assertPreserved(previous.rechecks, analysis.rechecks, "recheck", true);
  assertPreserved(previous.evidence, analysis.evidence, "evidence", true);
  const priorCandidates = new Map(previous.candidates.map((entry) => [entry.id, entry]));
  const candidates = new Map(analysis.candidates.map((entry) => [entry.id, entry]));
  const findings = new Map(analysis.findings.map((entry) => [entry.id, entry]));
  const priorFindings = new Map(previous.findings.map((entry) => [entry.id, entry]));
  const priorPlans = new Map(previous.plans.map((entry) => [entry.id, entry]));
  for (const plan of analysis.plans) {
    const old = priorPlans.get(plan.id);
    if (old === undefined) continue;
    requireCondition(
      plan.version >= old.version,
      "plan_version_regression",
      `Plan ${plan.id} cannot move to an earlier version.`,
    );
    if (plan.version === old.version)
      requireCondition(
        unchanged(old, plan),
        "plan_changed_without_version",
        `Changing plan ${plan.id} requires a new content version.`,
      );
  }
  for (const candidate of analysis.candidates) {
    const old = priorCandidates.get(candidate.id);
    requireCondition(
      old === undefined
        ? candidate.discoveredRound === round.round
        : candidate.discoveredRound === old.discoveredRound &&
            candidate.subjectRef === old.subjectRef,
      "candidate_identity_changed",
      `Candidate ${candidate.id} must preserve its discovery round and subject.`,
    );
    if (candidate.status === "merged") {
      requireCondition(
        candidate.mergedIntoCandidateId !== null &&
          candidate.mergedIntoCandidateId !== candidate.id,
        "invalid_candidate_merge",
        `Candidate ${candidate.id} must merge into another existing candidate.`,
      );
      const seen = new Set([candidate.id]);
      let nextId: string | null = candidate.mergedIntoCandidateId;
      while (nextId !== null) {
        requireCondition(
          !seen.has(nextId),
          "candidate_merge_cycle",
          "Candidate merge relationships cannot contain a cycle.",
        );
        seen.add(nextId);
        const target = candidates.get(nextId);
        requireCondition(
          target !== undefined && target.subjectRef === candidate.subjectRef,
          "invalid_candidate_merge",
          "Merged candidates must have an existing target on the same subject.",
        );
        nextId = target.status === "merged" ? target.mergedIntoCandidateId : null;
      }
    } else
      requireCondition(
        candidate.mergedIntoCandidateId === null,
        "unexpected_candidate_merge",
        "Only merged candidates may refer to a merge target.",
      );
    if (candidate.status === "confirmed" || candidate.status === "unresolved") {
      const finding = candidate.findingId === null ? undefined : findings.get(candidate.findingId);
      requireCondition(
        finding !== undefined &&
          finding.version === candidate.findingVersion &&
          finding.subjectRef === candidate.subjectRef,
        "candidate_finding_mismatch",
        `Retained candidate ${candidate.id} must reference its current finding version.`,
      );
      requireCondition(
        candidate.status === "confirmed"
          ? finding.confirmation.status === "confirmed"
          : finding.confirmation.status === "hypothesis",
        "candidate_confirmation_mismatch",
        "Candidate disposition must match the finding confirmation status.",
      );
    }
  }
  for (const finding of previous.findings) {
    if (!findings.has(finding.id)) {
      const owners = analysis.candidates.filter((entry) => entry.findingId === finding.id);
      requireCondition(
        owners.length > 0 &&
          owners.every((entry) => entry.status === "withdrawn" || entry.status === "merged"),
        "discarded_finding",
        `Finding ${finding.id} cannot disappear without a retained withdrawal or merge record.`,
      );
    }
  }
  for (const finding of analysis.findings) {
    const old = priorFindings.get(finding.id);
    if (old !== undefined) {
      requireCondition(
        finding.version >= old.version,
        "finding_version_regression",
        `Finding ${finding.id} cannot move to an earlier version.`,
      );
      if (finding.version === old.version)
        requireCondition(
          unchanged(old, finding),
          "finding_changed_without_version",
          `Changing finding ${finding.id} requires a new content version.`,
        );
    }
    requireCondition(
      analysis.candidates.some(
        (candidate) =>
          candidate.findingId === finding.id &&
          candidate.findingVersion === finding.version &&
          ["confirmed", "unresolved", "pending"].includes(candidate.status),
      ),
      "untracked_finding",
      `Finding ${finding.id} must remain represented in the candidate ledger.`,
    );
  }
  const priorRechecks = new Set(previous.rechecks.map((record) => record.id));
  for (const recheck of analysis.rechecks) {
    if (priorRechecks.has(recheck.id)) continue;
    const finding = findings.get(recheck.findingId);
    requireCondition(
      round.phase === "recheck" || round.phase === "finalize",
      "recheck_in_discovery",
      "Final-version rechecks must come from a distinct recheck or finalize phase.",
    );
    requireCondition(
      recheck.round === round.round &&
        finding !== undefined &&
        recheck.findingVersion === finding.version &&
        recheck.subjectRef === finding.subjectRef,
      "invalid_final_version_recheck",
      "A new recheck must bind to this round and the current finding version.",
    );
    requireCondition(
      analysis.candidates.some(
        (candidate) =>
          candidate.findingId === recheck.findingId && candidate.discoveredRound < round.round,
      ),
      "discovery_is_not_recheck",
      "A candidate must be investigated before a later round can recheck it.",
    );
  }
}

export interface InvestigationCompletionDecision {
  readonly complete: boolean;
  readonly reasonCodes: readonly string[];
  readonly pendingUnitIds: readonly string[];
  readonly pendingCandidateIds: readonly string[];
  readonly pendingFindingIds: readonly string[];
}

/** Completion is derived from all records, never a model claim or a preferred finding count. */
export function evaluateInvestigationCompletion(
  checkpoint: InvestigationLoopCheckpointV1,
): InvestigationCompletionDecision {
  const { analysis } = checkpoint;
  const reasonCodes: string[] = [];
  const pendingUnitIds = analysis.coverage.includedUnits
    .filter((unit) => unit.status !== "completed")
    .map((unit) => unit.id);
  const evidence = new Map<string, { subjectRef: string }>([
    ...checkpoint.runtime.evidence.map((entry) => [entry.id, entry] as const),
    ...analysis.evidence.map((entry) => [entry.id, entry] as const),
  ]);
  const pendingCandidateIds = analysis.candidates
    .filter(
      (candidate) =>
        candidate.status === "pending" ||
        ((candidate.status === "withdrawn" || candidate.status === "merged") &&
          (candidate.evidenceRefs.length === 0 ||
            candidate.evidenceRefs.some(
              (id) => evidence.get(id)?.subjectRef !== candidate.subjectRef,
            ))),
    )
    .map((candidate) => candidate.id);
  const pendingFindingIds = analysis.findings
    .filter((finding) => {
      const record = analysis.rechecks.find(
        (entry) => entry.id === finding.confirmation.recheckRef,
      );
      return (
        record === undefined ||
        record.findingVersion !== finding.version ||
        record.findingId !== finding.id ||
        record.subjectRef !== finding.subjectRef ||
        record.evidenceRefs.length === 0 ||
        record.evidenceRefs.some((id) => evidence.get(id)?.subjectRef !== finding.subjectRef) ||
        finding.confirmation.evidenceRefs.length === 0 ||
        finding.confirmation.evidenceRefs.some(
          (id) => evidence.get(id)?.subjectRef !== finding.subjectRef,
        ) ||
        (finding.confirmation.status === "hypothesis" &&
          (record.unresolvedQuestions.length === 0 || analysis.limitations.length === 0))
      );
    })
    .map((finding) => finding.id);
  if (checkpoint.lastPhase !== "finalize") reasonCodes.push("finalization_round_missing");
  const sourceCoverage = checkpoint.runtime.sourceCoverage;
  if (
    sourceCoverage === undefined &&
    analysis.coverage.includedUnits.some((unit) => unit.kind === "full_diff")
  )
    reasonCodes.push("source_manifest_required");
  if (sourceCoverage !== undefined) {
    const brokered = new Set(sourceCoverage.brokeredUnitIds);
    const units = new Map(analysis.coverage.includedUnits.map((unit) => [unit.id, unit]));
    if (sourceCoverage.manifest.chunks.some((chunk) => !brokered.has(chunk.id)))
      reasonCodes.push("source_chunks_not_delivered");
    if (sourceCoverage.manifest.chunks.some((chunk) => units.get(chunk.id)?.status !== "completed"))
      reasonCodes.push("source_chunks_not_investigated");
  }
  if (analysis.coverage.includedUnits.length === 0) reasonCodes.push("empty_investigation_scope");
  if (pendingUnitIds.length > 0) reasonCodes.push("coverage_incomplete");
  const completedIds = analysis.coverage.includedUnits
    .filter((unit) => unit.status === "completed")
    .map((unit) => unit.id)
    .sort();
  if (
    !unchanged(completedIds, [...analysis.coverage.completedUnitRefs].sort()) ||
    !unchanged([...pendingUnitIds].sort(), [...analysis.coverage.unresolvedUnitRefs].sort())
  )
    reasonCodes.push("coverage_summary_mismatch");
  if (pendingCandidateIds.length > 0) reasonCodes.push("candidate_dispositions_pending");
  if (pendingFindingIds.length > 0) reasonCodes.push("final_version_rechecks_pending");
  if (checkpoint.round === 0) reasonCodes.push("investigation_not_started");
  return {
    complete: reasonCodes.length === 0,
    reasonCodes,
    pendingUnitIds,
    pendingCandidateIds,
    pendingFindingIds,
  };
}

export interface ApplyInvestigationRoundOptions {
  readonly recordedAt: string;
  readonly checkpointId?: string;
  /** Actual consumption observed by the worker, excluding model-supplied claims. */
  readonly usage: {
    readonly durationMs: number;
    readonly tokens: number;
    readonly reportBytes: number;
  };
  /** Exact source chunk IDs delivered to this CLI invocation by the trusted worker. */
  readonly sourceUnitIds?: readonly string[];
}

/** Digests of newly proposed plan content are computed by trusted code, not requested from a model. */
export function normalizeInvestigationAnalysisPlanReferences(
  analysis: InvestigationAnalysisV1,
): InvestigationAnalysisV1 {
  const normalized = structuredClone(analysis);
  uniqueIds(normalized.plans, "plan");
  const plans = new Map(normalized.plans.map((plan) => [plan.id, plan]));
  const normalizeRef = (ref: { id: string; version: number; digest: string } | null) => {
    if (ref === null) return null;
    const plan = plans.get(ref.id);
    return plan === undefined || plan.version !== ref.version
      ? ref
      : { id: ref.id, version: ref.version, digest: investigationContentDigest(plan) };
  };
  for (const finding of normalized.findings)
    finding.fixRecommendation.planRef = normalizeRef(finding.fixRecommendation.planRef);
  for (const action of normalized.nextActions) action.planRef = normalizeRef(action.planRef);
  if (normalized.assessment.kind === "pr")
    normalized.assessment.e2eAssessment.planRef = normalizeRef(
      normalized.assessment.e2eAssessment.planRef,
    );
  else if (normalized.assessment.kind === "bug")
    normalized.assessment.reproduction.planRef = normalizeRef(
      normalized.assessment.reproduction.planRef,
    );
  else if (normalized.assessment.kind === "feature")
    normalized.assessment.featureAssessment.implementationPlanRef = normalizeRef(
      normalized.assessment.featureAssessment.implementationPlanRef,
    );
  return normalized;
}

export function applyInvestigationLoopRound(
  checkpoint: InvestigationLoopCheckpointV1,
  round: InvestigationLoopRoundV1,
  options: ApplyInvestigationRoundOptions,
): InvestigationLoopCheckpointV1 {
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    checkpoint.stopReason === "continuing",
    "loop_already_stopped",
    "A stopped loop requires an explicitly restored attempt.",
  );
  requireCondition(
    round.taskId === checkpoint.taskId && round.attemptId === checkpoint.attemptId,
    "round_identity_mismatch",
    "The round must belong to the active task and attempt.",
  );
  requireCondition(
    round.round === checkpoint.round + 1,
    "round_sequence_mismatch",
    "Every round must extend the latest accepted checkpoint exactly once.",
  );
  requireCondition(
    checkpoint.round > 0 || round.phase === "discovery" || round.phase === "investigation",
    "initial_investigation_phase_missing",
    "The initial round must investigate the full scope before a later round can finalize it.",
  );
  requireCondition(
    round.inputCheckpointRef === null
      ? checkpoint.round === 0
      : unchanged(round.inputCheckpointRef, reference(checkpoint)),
    "stale_checkpoint_reference",
    "The round must reference the precise accepted input checkpoint.",
  );
  for (const value of Object.values(options.usage))
    requireCondition(
      Number.isSafeInteger(value) && value >= 0,
      "invalid_worker_consumption",
      "Worker consumption must be a nonnegative safe integer.",
    );
  const normalizedAnalysis = normalizeInvestigationAnalysisPlanReferences(round.analysis);
  normalizedAnalysis.coverage = normalizeCoverage(
    checkpoint.analysis.coverage,
    normalizedAnalysis.coverage,
  );
  const normalizedRound = { ...round, analysis: normalizedAnalysis };
  assertAnalysisTransition(checkpoint.analysis, normalizedRound);
  assertRuntimeTransition(checkpoint, checkpoint.runtime);
  const runtime = structuredClone(checkpoint.runtime);
  const sourceUnitIds = options.sourceUnitIds ?? [];
  requireCondition(
    new Set(sourceUnitIds).size === sourceUnitIds.length,
    "duplicate_source_delivery",
    "Source delivery receipts must contain unique chunk IDs.",
  );
  if (runtime.sourceCoverage === undefined) {
    requireCondition(
      sourceUnitIds.length === 0,
      "source_manifest_required",
      "Source delivery requires a previously registered complete manifest.",
    );
    requireCondition(
      !normalizedAnalysis.coverage.includedUnits.some((unit) => unit.kind === "pr_diff_chunk"),
      "source_manifest_required",
      "A model cannot invent source chunk coverage without a trusted manifest.",
    );
    requireCondition(
      !normalizedAnalysis.coverage.includedUnits.some(
        (unit) => unit.kind === "full_diff" && unit.status === "completed",
      ),
      "source_manifest_required",
      "The full diff cannot be completed without a trusted complete source manifest.",
    );
  } else {
    const source = runtime.sourceCoverage;
    const known = new Set(source.manifest.chunks.map((chunk) => chunk.id));
    requireCondition(
      sourceUnitIds.every((id) => known.has(id)),
      "unknown_source_delivery",
      "Only chunk IDs from the frozen complete manifest can be delivered.",
    );
    requireCondition(
      normalizedAnalysis.coverage.includedUnits.every(
        (unit) => unit.kind !== "pr_diff_chunk" || known.has(unit.id),
      ),
      "unregistered_source_unit",
      "Source chunk coverage units must come from the complete trusted manifest.",
    );
    const brokered = new Set([...source.brokeredUnitIds, ...sourceUnitIds]);
    source.brokeredUnitIds = source.manifest.chunks
      .filter((chunk) => brokered.has(chunk.id))
      .map((chunk) => chunk.id);
    const units = new Map(normalizedAnalysis.coverage.includedUnits.map((unit) => [unit.id, unit]));
    for (const chunk of source.manifest.chunks) {
      const unit = units.get(chunk.id);
      requireCondition(
        unit !== undefined &&
          unit.kind === "pr_diff_chunk" &&
          unit.subjectRef === source.manifest.subjectRef,
        "source_coverage_unit_missing",
        "Every registered source chunk must remain in the complete coverage ledger.",
      );
      requireCondition(
        unit.status !== "completed" || brokered.has(chunk.id),
        "source_chunk_not_delivered",
        `Source chunk ${chunk.id} cannot be marked completed before it was delivered to the model.`,
      );
    }
    const allChunksComplete = source.manifest.chunks.every(
      (chunk) => brokered.has(chunk.id) && units.get(chunk.id)?.status === "completed",
    );
    requireCondition(
      allChunksComplete ||
        !normalizedAnalysis.coverage.includedUnits.some(
          (unit) => unit.kind === "full_diff" && unit.status === "completed",
        ),
      "full_diff_coverage_incomplete",
      "The full diff cannot be completed before every registered chunk was delivered and investigated.",
    );
  }
  const runtimeEvidenceIds = new Set(runtime.evidence.map((entry) => entry.id));
  requireCondition(
    !normalizedRound.analysis.evidence.some((entry) => runtimeEvidenceIds.has(entry.id)),
    "model_evidence_identity_collision",
    "Model evidence cannot replace a trusted observation record.",
  );
  const consumed = {
    rounds: checkpoint.consumed.rounds + 1,
    durationMs: checkpoint.consumed.durationMs + options.usage.durationMs,
    tokens: checkpoint.consumed.tokens + options.usage.tokens,
    reportBytes: Math.max(
      checkpoint.consumed.reportBytes,
      options.usage.reportBytes,
      retainedReportBytes(normalizedRound.analysis, runtime),
    ),
  };
  let next: InvestigationLoopCheckpointV1 = {
    ...structuredClone(checkpoint),
    id: options.checkpointId ?? checkpoint.id,
    version: checkpoint.version + 1,
    previousCheckpointRef: reference(checkpoint),
    round: round.round,
    analysis: normalizedRound.analysis,
    recordedAt: options.recordedAt,
    lastPhase: round.phase,
    consumed,
    runtime: structuredClone(runtime),
  };
  const completion = evaluateInvestigationCompletion(next);
  const exhausted =
    consumed.rounds >= checkpoint.budget.maxRounds ||
    consumed.durationMs >= checkpoint.budget.maxDurationMs ||
    consumed.tokens >= checkpoint.budget.maxTokens ||
    consumed.reportBytes > checkpoint.budget.maxReportBytes;
  const exceeded =
    consumed.rounds > checkpoint.budget.maxRounds ||
    consumed.durationMs > checkpoint.budget.maxDurationMs ||
    consumed.tokens > checkpoint.budget.maxTokens ||
    consumed.reportBytes > checkpoint.budget.maxReportBytes;
  // A successfully completed final round is allowed to consume the final unit of its budget.
  next = {
    ...next,
    stopReason:
      completion.complete && !round.continue && !exceeded
        ? "complete"
        : exhausted
          ? "budget_exhausted"
          : "continuing",
  };
  return sealCheckpoint(next);
}

export function interruptInvestigationLoop(
  checkpoint: InvestigationLoopCheckpointV1,
  reason: "blocked" | "failed" | "error" | "cancelled" | "interrupted" | "budget_exhausted",
  recordedAt = checkpoint.recordedAt,
  diagnostics: readonly InvestigationDiagnostic[] = [],
  durationMs = 0,
): InvestigationLoopCheckpointV1 {
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    checkpoint.stopReason !== "complete",
    "completed_loop_is_immutable",
    "A completed loop cannot be interrupted.",
  );
  requireCondition(
    Number.isSafeInteger(durationMs) && durationMs >= 0,
    "invalid_worker_consumption",
    "Trusted elapsed duration must be a nonnegative safe integer.",
  );
  const acceptedDiagnostics = new Map(
    checkpoint.analysis.diagnostics.map((entry) => [entry.id, entry]),
  );
  for (const diagnostic of diagnostics) {
    const previous = acceptedDiagnostics.get(diagnostic.id);
    requireCondition(
      previous === undefined || unchanged(previous, diagnostic),
      "diagnostic_identity_conflict",
      "An accepted diagnostic cannot be replaced by a conflicting record.",
    );
    acceptedDiagnostics.set(diagnostic.id, structuredClone(diagnostic));
  }
  const analysis = {
    ...structuredClone(checkpoint.analysis),
    diagnostics: [...acceptedDiagnostics.values()],
  };
  const reportBytes = Math.max(
    checkpoint.consumed.reportBytes,
    retainedReportBytes(analysis, checkpoint.runtime),
  );
  return sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    analysis,
    consumed: {
      ...checkpoint.consumed,
      durationMs: checkpoint.consumed.durationMs + durationMs,
      reportBytes,
    },
    previousCheckpointRef: reference(checkpoint),
    stopReason:
      reportBytes > checkpoint.budget.maxReportBytes && reason !== "cancelled"
        ? "budget_exhausted"
        : reason === "failed"
          ? "error"
          : reason,
    recordedAt,
  });
}

export interface RestoreInvestigationCheckpointInput {
  readonly checkpoint: InvestigationLoopCheckpointV1;
  readonly task: InvestigationTaskV1;
  readonly attemptId: string;
  readonly leaseVersion: number;
  readonly recordedAt: string;
}

export function restoreInvestigationCheckpoint(
  input: RestoreInvestigationCheckpointInput,
): InvestigationLoopCheckpointV1 {
  const { checkpoint, task } = input;
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    checkpoint.taskId === task.id &&
      checkpoint.taskBindingDigest ===
        investigationTaskBindingDigest({ ...task, budget: checkpoint.budget }),
    "checkpoint_task_binding_mismatch",
    "Resume requires the identical frozen scope, subjects, configuration, and execution policy.",
  );
  assertNondecreasingBudget(checkpoint.budget, task.budget);
  requireCondition(
    checkpoint.stopReason !== "complete",
    "completed_loop_is_immutable",
    "A completed investigation cannot be resumed.",
  );
  requireCondition(
    input.attemptId !== checkpoint.attemptId &&
      !checkpoint.adoptedAttemptIds.includes(input.attemptId),
    "attempt_already_adopted",
    "Resume requires a new execution attempt.",
  );
  const reportBytes = Math.max(
    checkpoint.consumed.reportBytes,
    retainedReportBytes(checkpoint.analysis, checkpoint.runtime),
  );
  requireCondition(
    checkpoint.consumed.rounds < task.budget.maxRounds &&
      checkpoint.consumed.durationMs < task.budget.maxDurationMs &&
      checkpoint.consumed.tokens < task.budget.maxTokens &&
      reportBytes <= task.budget.maxReportBytes,
    "resume_budget_exhausted",
    "The task budget is exhausted; an operator must explicitly increase the required limits before resuming.",
  );
  return sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    previousCheckpointRef: reference(checkpoint),
    attemptId: input.attemptId,
    leaseVersion: input.leaseVersion,
    adoptedAttemptIds: [...checkpoint.adoptedAttemptIds, input.attemptId],
    recordedAt: input.recordedAt,
    stopReason: "continuing",
    budget: structuredClone(task.budget),
    taskBindingDigest: investigationTaskBindingDigest(task),
    consumed: { ...checkpoint.consumed, reportBytes },
  });
}

/** Resume only delivery of an accepted complete analysis after its producer lost the lease. */
export function restoreCompletedInvestigationForDelivery(
  input: RestoreInvestigationCheckpointInput,
): InvestigationLoopCheckpointV1 {
  const { checkpoint, task } = input;
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    checkpoint.taskId === task.id &&
      checkpoint.taskBindingDigest === investigationTaskBindingDigest(task),
    "checkpoint_task_binding_mismatch",
    "Delivery recovery requires the identical frozen task binding.",
  );
  requireCondition(
    checkpoint.stopReason === "complete" && evaluateInvestigationCompletion(checkpoint).complete,
    "complete_checkpoint_required",
    "Delivery recovery requires an accepted complete investigation checkpoint.",
  );
  requireCondition(
    input.attemptId !== checkpoint.attemptId &&
      !checkpoint.adoptedAttemptIds.includes(input.attemptId),
    "attempt_already_adopted",
    "Delivery recovery requires a new execution attempt.",
  );
  // The caller must verify that this report has not already been sealed. No model or
  // repository execution may be resumed from this checkpoint; only report delivery.
  return sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    previousCheckpointRef: reference(checkpoint),
    attemptId: input.attemptId,
    leaseVersion: input.leaseVersion,
    adoptedAttemptIds: [...checkpoint.adoptedAttemptIds, input.attemptId],
    recordedAt: input.recordedAt,
  });
}

function assertRuntimeTransition(
  checkpoint: InvestigationLoopCheckpointV1,
  runtime: InvestigationRuntimeState,
): void {
  const previousSource = checkpoint.runtime.sourceCoverage;
  requireCondition(
    previousSource === undefined
      ? runtime.sourceCoverage === undefined
      : runtime.sourceCoverage !== undefined && unchanged(previousSource, runtime.sourceCoverage),
    "source_coverage_is_trusted",
    "Execution receipts cannot change the trusted source manifest or claim model delivery.",
  );
  for (const [kind, entries] of Object.entries({
    runtime_evidence: runtime.evidence,
    runtime_artifact: runtime.artifacts,
    runtime_subject: runtime.subjects,
    runtime_check: runtime.checks,
  }))
    uniqueIds(entries, kind);
  assertPreserved(checkpoint.runtime.evidence, runtime.evidence, "runtime_evidence", true);
  assertPreserved(checkpoint.runtime.artifacts, runtime.artifacts, "runtime_artifact", true);
  assertPreserved(checkpoint.runtime.subjects, runtime.subjects, "runtime_subject", true);
  assertPreserved(checkpoint.runtime.checks, runtime.checks, "runtime_check", true);
  const stepEntries = (entries: InvestigationRuntimeState["startedSteps"]) =>
    entries.map((entry) => ({ id: entry.stepId, ...entry }));
  const started = stepEntries(runtime.startedSteps);
  const completed = runtime.completedSteps.map((entry) => ({ id: entry.stepId, ...entry }));
  uniqueIds(started, "started_step");
  uniqueIds(completed, "completed_step");
  assertPreserved(stepEntries(checkpoint.runtime.startedSteps), started, "started_step", true);
  assertPreserved(
    checkpoint.runtime.completedSteps.map((entry) => ({ id: entry.stepId, ...entry })),
    completed,
    "completed_step",
    true,
  );
  requireCondition(
    checkpoint.runtime.completedStepIds.every((id) => runtime.completedStepIds.includes(id)),
    "discarded_execution_receipt",
    "Completed execution steps cannot be forgotten during checkpoint advancement.",
  );
  requireCondition(
    unchanged([...runtime.completedStepIds].sort(), completed.map((entry) => entry.id).sort()),
    "completion_receipt_mismatch",
    "Every completed step ID must have exactly one accepted completion receipt.",
  );
  for (const step of runtime.startedSteps)
    requireCondition(
      step.taskId === checkpoint.taskId && checkpoint.adoptedAttemptIds.includes(step.attemptId),
      "execution_attempt_mismatch",
      "Execution receipts must belong to this task and an adopted attempt.",
    );
  for (const step of runtime.completedSteps) {
    const {
      outcome: _outcome,
      validation: _validation,
      verificationEvidence: _evidence,
      artifacts: _artifacts,
      diagnostics: _diagnostics,
      subjects: _subjects,
      modelUsage: _modelUsage,
      ...binding
    } = step;
    requireCondition(
      runtime.startedSteps.some((startedStep) => unchanged(startedStep, binding)),
      "execution_was_not_started",
      "Completion requires the exact accepted start receipt before any execution.",
    );
  }
}

/** Accept trusted execution receipts independently from a model round and preserve replay fencing. */
export function applyInvestigationRuntimeCheckpoint(
  checkpoint: InvestigationLoopCheckpointV1,
  runtime: InvestigationRuntimeState,
  options: { readonly recordedAt: string; readonly durationMs?: number },
): InvestigationLoopCheckpointV1 {
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    checkpoint.stopReason === "continuing",
    "loop_already_stopped",
    "Execution receipts require an active investigation attempt.",
  );
  const priorCompleted = new Set(checkpoint.runtime.completedSteps.map((step) => step.stepId));
  const newModelUsage = runtime.completedSteps
    .filter((step) => !priorCompleted.has(step.stepId))
    .flatMap((step) => (step.modelUsage === undefined ? [] : [step.modelUsage]));
  for (const usage of newModelUsage)
    requireCondition(
      Number.isSafeInteger(usage.tokens) &&
        usage.tokens >= 0 &&
        Number.isSafeInteger(usage.durationMs) &&
        usage.durationMs >= 0,
      "invalid_worker_consumption",
      "Trusted model usage must contain nonnegative safe integer counts.",
    );
  const modelTokens = newModelUsage.reduce((sum, usage) => sum + usage.tokens, 0);
  const modelDurationMs = newModelUsage.reduce((sum, usage) => sum + usage.durationMs, 0);
  const durationMs = options.durationMs ?? modelDurationMs;
  requireCondition(
    Number.isSafeInteger(durationMs) && durationMs >= 0,
    "invalid_worker_consumption",
    "Trusted elapsed duration must be a nonnegative safe integer.",
  );
  assertRuntimeTransition(checkpoint, runtime);
  const runtimeIds = new Set(runtime.evidence.map((entry) => entry.id));
  requireCondition(
    !checkpoint.analysis.evidence.some((entry) => runtimeIds.has(entry.id)),
    "model_evidence_identity_collision",
    "A trusted observation cannot reuse a model evidence ID.",
  );
  const reportBytes = Math.max(
    checkpoint.consumed.reportBytes,
    retainedReportBytes(checkpoint.analysis, runtime),
  );
  const totalDurationMs = checkpoint.consumed.durationMs + durationMs;
  const totalTokens = checkpoint.consumed.tokens + modelTokens;
  return sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    previousCheckpointRef: reference(checkpoint),
    runtime: structuredClone(runtime),
    recordedAt: options.recordedAt,
    consumed: {
      ...checkpoint.consumed,
      reportBytes,
      durationMs: totalDurationMs,
      tokens: totalTokens,
    },
    stopReason:
      reportBytes > checkpoint.budget.maxReportBytes ||
      totalDurationMs >= checkpoint.budget.maxDurationMs ||
      totalTokens >= checkpoint.budget.maxTokens
        ? "budget_exhausted"
        : "continuing",
  });
}

/** Register the full trusted Git materialization before accepting any source completion claim. */
export function applyInvestigationSourceCoverage(
  checkpoint: InvestigationLoopCheckpointV1,
  manifest: InvestigationPrDiffManifestV1,
  options: {
    readonly task: InvestigationTaskV1;
    readonly recordedAt: string;
    readonly durationMs?: number;
  },
): InvestigationLoopCheckpointV1 {
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    checkpoint.stopReason === "continuing",
    "loop_already_stopped",
    "Source registration requires an active investigation attempt.",
  );
  const { task } = options;
  requireCondition(
    task.id === checkpoint.taskId &&
      checkpoint.taskBindingDigest === investigationTaskBindingDigest(task),
    "checkpoint_task_binding_mismatch",
    "The materialized source must belong to the exact frozen task.",
  );
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  requireCondition(
    task.kind === "pr-review" && subject?.kind === "original_pr",
    "source_manifest_task_mismatch",
    "Complete PR diff registration belongs to an original PR review task.",
  );
  const validation = validateInvestigationPrDiffManifest(manifest, subject);
  requireCondition(
    validation.valid,
    "invalid_source_manifest",
    validation.errors.map((entry) => entry.message).join(" "),
  );
  const { digest: _digest, ...manifestContent } = manifest;
  requireCondition(
    manifest.digest === investigationContentDigest(manifestContent),
    "source_manifest_digest_mismatch",
    "The complete source manifest does not match its canonical digest.",
  );
  const durationMs = options.durationMs ?? 0;
  requireCondition(
    Number.isSafeInteger(durationMs) && durationMs >= 0,
    "invalid_worker_consumption",
    "Trusted elapsed duration must be a nonnegative safe integer.",
  );
  const analysis = structuredClone(checkpoint.analysis);
  const runtime = structuredClone(checkpoint.runtime);
  const previous = runtime.sourceCoverage;
  if (previous !== undefined) {
    requireCondition(
      unchanged(previous.manifest, manifest),
      "source_manifest_changed",
      "Resume must preserve the complete manifest and previously delivered source chunks.",
    );
  } else {
    const existingIds = new Set(analysis.coverage.includedUnits.map((unit) => unit.id));
    requireCondition(
      manifest.chunks.every((chunk) => !existingIds.has(chunk.id)),
      "source_unit_identity_collision",
      "Source chunk IDs must not replace existing investigation scope units.",
    );
    const expanded = structuredClone(analysis.coverage);
    for (const unit of expanded.includedUnits) {
      if (unit.kind === "full_diff") {
        unit.status = "pending";
        unit.evidenceRefs = [];
      }
    }
    expanded.includedUnits.push(
      ...manifest.chunks.map((chunk) => ({
        id: chunk.id,
        subjectRef: manifest.subjectRef,
        kind: "pr_diff_chunk",
        paths: [chunk.path],
        requiredWork: `Inspect complete ${chunk.kind} source chunk ${chunk.ordinal} for ${chunk.path} (${chunk.encoding}, SHA-256 ${chunk.contentDigest}, ${chunk.byteLength} bytes).`,
        status: "pending" as const,
        evidenceRefs: [],
      })),
    );
    expanded.completedUnitRefs = expanded.includedUnits
      .filter((unit) => unit.status === "completed")
      .map((unit) => unit.id);
    expanded.unresolvedUnitRefs = expanded.includedUnits
      .filter((unit) => unit.status !== "completed")
      .map((unit) => unit.id);
    analysis.coverage = normalizeCoverage(checkpoint.analysis.coverage, expanded);
    runtime.sourceCoverage = { manifest: structuredClone(manifest), brokeredUnitIds: [] };
  }
  const totalDurationMs = checkpoint.consumed.durationMs + durationMs;
  const reportBytes = Math.max(
    checkpoint.consumed.reportBytes,
    retainedReportBytes(analysis, runtime),
  );
  return sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    previousCheckpointRef: reference(checkpoint),
    analysis,
    runtime,
    recordedAt: options.recordedAt,
    consumed: { ...checkpoint.consumed, durationMs: totalDurationMs, reportBytes },
    stopReason:
      reportBytes > checkpoint.budget.maxReportBytes ||
      totalDurationMs >= checkpoint.budget.maxDurationMs
        ? "budget_exhausted"
        : "continuing",
  });
}

export const applyInvestigationSourceCheckpoint = applyInvestigationSourceCoverage;

function assertNondecreasingBudget(previous: InvestigationBudget, next: InvestigationBudget): void {
  for (const field of ["maxRounds", "maxDurationMs", "maxTokens", "maxReportBytes"] as const) {
    requireCondition(
      Number.isSafeInteger(next[field]) && next[field] > 0,
      "invalid_investigation_budget",
      "Budget limits must be positive safe integers.",
    );
    requireCondition(
      next[field] >= previous[field],
      "budget_decreased",
      `The explicitly revised budget cannot decrease ${field}.`,
    );
  }
}

/** The server must authorize and audit the operator's exact revised limits before calling this. */
export function increaseInvestigationBudget(
  checkpoint: InvestigationLoopCheckpointV1,
  task: InvestigationTaskV1,
  budget: InvestigationBudget,
  options: { readonly recordedAt: string },
): { task: InvestigationTaskV1; checkpoint: InvestigationLoopCheckpointV1 } {
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    task.id === checkpoint.taskId &&
      checkpoint.taskBindingDigest === investigationTaskBindingDigest(task),
    "checkpoint_task_binding_mismatch",
    "A budget revision cannot change any other frozen task binding.",
  );
  assertNondecreasingBudget(checkpoint.budget, budget);
  const revisedTask = {
    ...structuredClone(task),
    budget: structuredClone(budget),
    updatedAt: options.recordedAt,
  };
  const revisedCheckpoint = sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    previousCheckpointRef: reference(checkpoint),
    recordedAt: options.recordedAt,
    budget: structuredClone(budget),
    taskBindingDigest: investigationTaskBindingDigest(revisedTask),
    consumed: {
      ...checkpoint.consumed,
      reportBytes: Math.max(
        checkpoint.consumed.reportBytes,
        retainedReportBytes(checkpoint.analysis, checkpoint.runtime),
      ),
    },
  });
  return { task: revisedTask, checkpoint: revisedCheckpoint };
}
