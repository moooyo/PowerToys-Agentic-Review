import { createHash } from "node:crypto";
import type {
  InvestigationAnalysisV1,
  InvestigationBudget,
  InvestigationCoverage,
  InvestigationDiagnostic,
  InvestigationLoopCheckpointV1,
  InvestigationLoopRoundV1,
  InvestigationModelIdentity,
  InvestigationModelOutputRejection,
  InvestigationPrDiffManifestV1,
  InvestigationRuntimeState,
  InvestigationSourceProvenance,
  InvestigationTaskV1,
  InvestigationUnacceptedModelUsage,
  InvestigationVersionRef,
} from "@agentic-review/contracts";
import {
  isCorrectableInvestigationModelOutputIssue,
  validateInvestigationModelExecutions,
  validateInvestigationPrDiffManifest,
  validateInvestigationSourceProvenance,
} from "@agentic-review/contracts";

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
    ...(task.sourceArtifacts === undefined ? {} : { sourceArtifacts: task.sourceArtifacts }),
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

/** Project the single accounting ledger into the legacy checkpoint without charging it twice. */
export function projectInvestigationTokenConsumption(
  checkpoint: InvestigationLoopCheckpointV1,
  tokens: number,
): InvestigationLoopCheckpointV1 {
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    Number.isSafeInteger(tokens) && tokens >= 0,
    "invalid_worker_consumption",
    "The accounting ledger total must be a nonnegative safe integer.",
  );
  const next = sealCheckpoint({
    ...structuredClone(checkpoint),
    consumed: { ...checkpoint.consumed, tokens },
    stopReason:
      (checkpoint.stopReason === "continuing" && tokens >= checkpoint.budget.maxTokens) ||
      (checkpoint.stopReason === "complete" && tokens > checkpoint.budget.maxTokens)
        ? "budget_exhausted"
        : checkpoint.stopReason,
  });
  assertInvestigationCheckpointIntegrity(next);
  return next;
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
  const modelExecutions = validateInvestigationModelExecutions(
    checkpoint.runtime.modelExecutions ?? [],
    checkpoint.adoptedAttemptIds,
    checkpoint.round,
  );
  requireCondition(
    modelExecutions.valid,
    "invalid_model_execution_history",
    modelExecutions.errors.map((issue) => issue.message).join(" "),
  );
  const rejectionInvocations = new Set<string>();
  const rejectionRounds = new Set<string>();
  for (const rejection of checkpoint.runtime.modelOutputRejections ?? []) {
    const key = JSON.stringify([rejection.attemptId, rejection.round]);
    requireCondition(
      Object.keys(rejection).sort().join(",") === "attemptId,invocationId,issue,recordedAt,round" &&
        checkpoint.adoptedAttemptIds.includes(rejection.attemptId) &&
        Number.isSafeInteger(rejection.round) &&
        rejection.round > 0 &&
        rejection.round <= checkpoint.round + 1 &&
        typeof rejection.invocationId === "string" &&
        rejection.invocationId.length <= 128 &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$(?![\s\S])/.test(rejection.invocationId) &&
        isCorrectableInvestigationModelOutputIssue(rejection.issue) &&
        typeof rejection.recordedAt === "string" &&
        Number.isFinite(Date.parse(rejection.recordedAt)) &&
        !rejectionInvocations.has(rejection.invocationId) &&
        !rejectionRounds.has(key),
      "invalid_model_output_rejection_history",
      "Model output rejections must identify unique invocations and rounds in adopted attempts using only safe structural metadata.",
    );
    rejectionInvocations.add(rejection.invocationId);
    rejectionRounds.add(key);
  }
  const usageKeys = new Set<string>();
  let knownTokens = 0;
  for (const usage of checkpoint.runtime.unacceptedModelUsage ?? []) {
    const key = JSON.stringify([usage.attemptId, usage.round]);
    requireCondition(
      checkpoint.adoptedAttemptIds.includes(usage.attemptId) &&
        Number.isSafeInteger(usage.round) &&
        usage.round > 0 &&
        usage.round <= checkpoint.round + 1 &&
        (usage.tokens === null || (Number.isSafeInteger(usage.tokens) && usage.tokens >= 0)) &&
        !usageKeys.has(key),
      "invalid_unaccepted_model_usage",
      "Unaccepted model usage must identify a unique invocation in an adopted attempt.",
    );
    usageKeys.add(key);
    knownTokens += usage.tokens ?? 0;
  }
  requireCondition(
    Number.isSafeInteger(knownTokens) && knownTokens <= checkpoint.consumed.tokens,
    "invalid_unaccepted_model_usage",
    "Known unaccepted model usage must remain included in the recorded token consumption.",
  );
}

function unknownModelUsageDiagnostics(
  runtime: InvestigationRuntimeState,
): InvestigationDiagnostic[] {
  return (runtime.unacceptedModelUsage ?? [])
    .filter((usage) => usage.tokens === null)
    .map((usage) => ({
      id: `model-usage-unknown:${investigationContentDigest([usage.attemptId, usage.round])}`,
      code: "MODEL_USAGE_UNAVAILABLE",
      category: "limitation",
      message:
        `The model invocation for analysis round ${usage.round} in attempt ${usage.attemptId} did not report token usage. ` +
        "The recorded token total includes only known usage and may understate actual consumption.",
      retryable: false,
      evidenceRefs: [],
      prerequisiteRefs: [],
    }));
}

function preserveUnknownModelUsageDiagnostics(
  analysis: InvestigationAnalysisV1,
  runtime: InvestigationRuntimeState,
): void {
  for (const diagnostic of unknownModelUsageDiagnostics(runtime)) {
    const existing = analysis.diagnostics.filter((entry) => entry.id === diagnostic.id);
    requireCondition(
      existing.every((entry) => unchanged(entry, diagnostic)),
      "diagnostic_identity_conflict",
      "An unavailable model usage diagnostic cannot be replaced by conflicting content.",
    );
    if (existing.length === 0) analysis.diagnostics.push(diagnostic);
  }
}

export interface CreateInvestigationCheckpointInput {
  readonly task: InvestigationTaskV1;
  readonly attemptId: string;
  readonly checkpointId: string;
  readonly leaseVersion: number;
  readonly recordedAt: string;
}

/** New task semantics are recorded once; absent modes on existing checkpoints remain historical. */
export function initialInvestigationReviewMode(
  task: Pick<InvestigationTaskV1, "kind" | "executionPolicy">,
): InvestigationRuntimeState["reviewMode"] {
  if (task.kind !== "pr-review" && task.kind !== "issue-investigate") return undefined;
  if (task.executionPolicy.mode === "source_read") return "local_checkout";
  if (task.kind === "issue-investigate" && task.executionPolicy.mode === "snapshot_only")
    return "local_snapshot";
  return undefined;
}

export function createInvestigationCheckpoint(
  input: CreateInvestigationCheckpointInput,
): InvestigationLoopCheckpointV1 {
  const { task } = input;
  const reviewMode = initialInvestigationReviewMode(task);
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
      ...(reviewMode === undefined ? {} : { reviewMode }),
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
  autonomousReview = false,
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
    requireCondition(
      unit.status !== "completed" || next.status === "completed",
      "coverage_completion_regression",
      `Completed coverage ${unit.id} cannot be reopened to manufacture additional progress.`,
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
      autonomousReview || round.phase === "recheck" || round.phase === "finalize",
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
          candidate.findingId === recheck.findingId &&
          (candidate.discoveredRound < round.round ||
            (autonomousReview && candidate.discoveredRound === round.round)),
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

function finalVersionRecheck(
  finding: InvestigationAnalysisV1["findings"][number],
  analysis: InvestigationAnalysisV1,
  evidence: ReadonlyMap<string, { subjectRef: string }>,
): InvestigationAnalysisV1["rechecks"][number] | undefined {
  const record = analysis.rechecks.find((entry) => entry.id === finding.confirmation.recheckRef);
  if (
    record === undefined ||
    record.findingVersion !== finding.version ||
    record.findingId !== finding.id ||
    record.subjectRef !== finding.subjectRef ||
    record.evidenceRefs.length === 0 ||
    record.evidenceRefs.some((id) => evidence.get(id)?.subjectRef !== finding.subjectRef) ||
    (finding.confirmation.status === "hypothesis" &&
      (record.unresolvedQuestions.length === 0 || analysis.limitations.length === 0))
  )
    return undefined;
  return record;
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
      return (
        finalVersionRecheck(finding, analysis, evidence) === undefined ||
        finding.confirmation.evidenceRefs.length === 0 ||
        finding.confirmation.evidenceRefs.some(
          (id) => evidence.get(id)?.subjectRef !== finding.subjectRef,
        )
      );
    })
    .map((finding) => finding.id);
  if (checkpoint.runtime.reviewMode === undefined && checkpoint.lastPhase !== "finalize")
    reasonCodes.push("finalization_round_missing");
  const sourceCoverage = checkpoint.runtime.sourceCoverage;
  if (
    sourceCoverage === undefined &&
    analysis.coverage.includedUnits.some((unit) => unit.kind === "full_diff")
  )
    reasonCodes.push("source_manifest_required");
  if (sourceCoverage !== undefined && checkpoint.runtime.reviewMode !== "local_checkout") {
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

export function hasInvestigationSemanticProgress(
  previous: InvestigationLoopCheckpointV1,
  current: InvestigationLoopCheckpointV1,
): boolean {
  const before = previous.analysis;
  const after = current.analysis;
  const oldUnits = new Map(before.coverage.includedUnits.map((unit) => [unit.id, unit]));
  if (
    after.coverage.includedUnits.some(
      (unit) => unit.status === "completed" && oldUnits.get(unit.id)?.status !== "completed",
    )
  )
    return true;

  // IDs and ordering are transport details. Repeating the same evidence under a new ID is not progress.
  const evidenceKeys = (analysis: InvestigationAnalysisV1) => {
    const evidence = new Map(analysis.evidence.map((entry) => [entry.id, entry]));
    const fingerprints = new Map<string, string>();
    const key = (id: string, seen = new Set<string>()): string => {
      const fingerprint = fingerprints.get(id);
      if (fingerprint !== undefined) return fingerprint;
      const entry = evidence.get(id);
      if (entry === undefined) return id;
      if (seen.has(id)) return "cyclic-evidence-reference";
      const visited = new Set([...seen, id]);
      const digest = investigationContentDigest({
        subjectRef: entry.subjectRef,
        source: entry.source,
        summary: entry.summary,
        evidenceRefs: entry.evidenceRefs.map((ref) => key(ref, visited)).sort(),
      });
      fingerprints.set(id, digest);
      return digest;
    };
    return { key, keys: new Set(analysis.evidence.map((entry) => key(entry.id))) };
  };
  const oldEvidence = evidenceKeys(before);
  const newEvidence = evidenceKeys(after);
  if ([...newEvidence.keys].some((key) => !oldEvidence.keys.has(key))) return true;
  const references = (ids: readonly string[], key: (id: string) => string) =>
    ids.map((id) => key(id)).sort();
  const findingKeys = (analysis: InvestigationAnalysisV1, key: (id: string) => string) =>
    new Set(
      analysis.findings.map((finding) =>
        investigationContentDigest({
          subjectRef: finding.subjectRef,
          priority: finding.priority,
          trigger: finding.trigger,
          locations: finding.locations.map(investigationContentDigest).sort(),
          evidenceRefs: references(finding.evidenceRefs, key),
          rootCause: {
            status: finding.rootCause.status,
            evidenceRefs: references(finding.rootCause.evidenceRefs, key),
          },
          confirmation: {
            status: finding.confirmation.status,
            evidenceRefs: references(finding.confirmation.evidenceRefs, key),
          },
        }),
      ),
    );
  const oldFindings = findingKeys(before, oldEvidence.key);
  if ([...findingKeys(after, newEvidence.key)].some((key) => !oldFindings.has(key))) return true;

  // Rechecking a final finding and supplying its confirmation evidence are separate duties.
  // Credit a newly valid recheck even while confirmation remains incomplete; an ID, version,
  // or wording-only replacement of the same recheck must not keep the loop alive.
  const recheckedFindings = (
    checkpoint: InvestigationLoopCheckpointV1,
    key: (id: string) => string,
  ) => {
    const analysis = checkpoint.analysis;
    const evidence = new Map<string, { subjectRef: string }>([
      ...checkpoint.runtime.evidence.map((entry) => [entry.id, entry] as const),
      ...analysis.evidence.map((entry) => [entry.id, entry] as const),
    ]);
    return new Set(
      analysis.findings.flatMap((finding) => {
        const recheck = finalVersionRecheck(finding, analysis, evidence);
        if (recheck === undefined) return [];
        return [
          investigationContentDigest({
            subjectRef: finding.subjectRef,
            trigger: finding.trigger,
            locations: finding.locations.map(investigationContentDigest).sort(),
            evidenceRefs: references(recheck.evidenceRefs, key),
          }),
        ];
      }),
    );
  };
  const priorRechecked = recheckedFindings(previous, oldEvidence.key);
  if ([...recheckedFindings(current, newEvidence.key)].some((key) => !priorRechecked.has(key)))
    return true;

  const oldCandidates = new Map(before.candidates.map((candidate) => [candidate.id, candidate]));
  if (
    after.candidates.some((candidate) => {
      const old = oldCandidates.get(candidate.id);
      return (
        old !== undefined &&
        old.status !== candidate.status &&
        candidate.status !== "pending" &&
        candidate.evidenceRefs.length > 0
      );
    })
  )
    return true;

  const pendingBefore = new Set(evaluateInvestigationCompletion(previous).pendingFindingIds);
  const pendingAfter = new Set(evaluateInvestigationCompletion(current).pendingFindingIds);
  if ([...pendingBefore].some((id) => !pendingAfter.has(id))) return true;
  const deliveredBefore = new Set(previous.runtime.sourceCoverage?.brokeredUnitIds ?? []);
  return (current.runtime.sourceCoverage?.brokeredUnitIds ?? []).some(
    (id) => !deliveredBefore.has(id),
  );
}

function stoppedProgressDiagnostic(
  previous: InvestigationLoopCheckpointV1,
  current: InvestigationLoopCheckpointV1,
  completion: InvestigationCompletionDecision,
): InvestigationDiagnostic | undefined {
  if (completion.complete) return undefined;
  const analysis = current.analysis;
  const previouslyAnalyzedObservations = new Set(
    previous.analysis.evidence.flatMap((entry) => entry.evidenceRefs),
  );
  // Trusted observations may arrive while coverage is blocked. Analyze every pending batch,
  // then allow the newly interpreted observations to resolve that coverage. If a later call
  // adds nothing, the no-progress guard still stops it instead of repeating the same results.
  const observationWorkAvailable = current.runtime.evidence.some(
    (entry) => !previouslyAnalyzedObservations.has(entry.id),
  );
  // Aggregate diff completion cannot unblock the source work it depends on.
  const blockedOnly =
    analysis.coverage.includedUnits.some((unit) => unit.status === "blocked") &&
    !analysis.coverage.includedUnits.some(
      (unit) => unit.status === "pending" && unit.kind !== "full_diff",
    ) &&
    !observationWorkAvailable &&
    completion.pendingCandidateIds.length === 0 &&
    completion.pendingFindingIds.length === 0;
  const noProgress = previous.round > 0 && !hasInvestigationSemanticProgress(previous, current);
  if (!blockedOnly && !noProgress) return undefined;
  return {
    id: `loop-stopped:${investigationContentDigest([current.attemptId, current.round])}`,
    code: blockedOnly ? "INVESTIGATION_BLOCKED" : "INVESTIGATION_NO_PROGRESS",
    category: "blocker",
    message: blockedOnly
      ? "The remaining review scope is blocked and no executable investigation or recheck remains. Resume only after the missing prerequisite is available."
      : "The latest model invocation added no new source evidence, completed coverage, candidate disposition, finding facts, or required final-version recheck. Repeating the same inputs would not advance the investigation.",
    retryable: false,
    evidenceRefs: [],
    prerequisiteRefs: [],
  };
}

export interface ApplyInvestigationRoundOptions {
  readonly recordedAt: string;
  readonly checkpointId?: string;
  /** Server-owned invocation ledger total, replacing legacy additive token accounting. */
  readonly accountedTokens?: number;
  /** Actual consumption observed by the worker, excluding model-supplied claims. */
  readonly usage: {
    readonly durationMs: number;
    readonly tokens: number;
    readonly reportBytes: number;
  };
  /** Exact source chunk IDs delivered to this CLI invocation by the trusted worker. */
  readonly sourceUnitIds?: readonly string[];
  /** Explicit CLI selection observed by the trusted Worker, never model-provided text. */
  readonly modelIdentity?: InvestigationModelIdentity;
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
    checkpoint.runtime.reviewMode !== undefined ||
      checkpoint.round > 0 ||
      checkpoint.runtime.e2e !== undefined ||
      round.phase === "discovery" ||
      round.phase === "investigation",
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
  if (options.accountedTokens !== undefined)
    requireCondition(
      Number.isSafeInteger(options.accountedTokens) && options.accountedTokens >= 0,
      "invalid_worker_consumption",
      "The accounting ledger total must be a nonnegative safe integer.",
    );
  const normalizedAnalysis = normalizeInvestigationAnalysisPlanReferences(round.analysis);
  preserveUnknownModelUsageDiagnostics(normalizedAnalysis, checkpoint.runtime);
  normalizedAnalysis.coverage = normalizeCoverage(
    checkpoint.analysis.coverage,
    normalizedAnalysis.coverage,
  );
  const normalizedRound = { ...round, analysis: normalizedAnalysis };
  assertAnalysisTransition(
    checkpoint.analysis,
    normalizedRound,
    checkpoint.runtime.reviewMode !== undefined,
  );
  assertRuntimeTransition(checkpoint, checkpoint.runtime);
  const runtime = structuredClone(checkpoint.runtime);
  if (options.modelIdentity !== undefined) {
    const execution = {
      attemptId: checkpoint.attemptId,
      round: round.round,
      engine: options.modelIdentity.engine,
      model: options.modelIdentity.model,
    };
    const validation = validateInvestigationModelExecutions(
      [execution],
      checkpoint.adoptedAttemptIds,
      round.round,
    );
    requireCondition(
      validation.valid,
      "invalid_worker_model_identity",
      "The Worker must provide a valid explicit CLI model selection or mark it unknown.",
    );
    runtime.modelExecutions = [...(runtime.modelExecutions ?? []), execution];
  }
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
    for (const chunk of runtime.reviewMode === "local_checkout" ? [] : source.manifest.chunks) {
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
      runtime.reviewMode === "local_checkout" ||
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
    tokens: options.accountedTokens ?? checkpoint.consumed.tokens + options.usage.tokens,
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
  const progressDiagnostic = stoppedProgressDiagnostic(checkpoint, next, completion);
  if (progressDiagnostic !== undefined) {
    next.analysis.diagnostics.push(progressDiagnostic);
    consumed.reportBytes = Math.max(
      consumed.reportBytes,
      retainedReportBytes(next.analysis, runtime),
    );
  }
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
      completion.complete && !exceeded
        ? "complete"
        : exhausted
          ? "budget_exhausted"
          : progressDiagnostic !== undefined
            ? "blocked"
            : "continuing",
  };
  return sealCheckpoint(next);
}

export type RejectInvestigationModelOutputInput = Omit<
  InvestigationModelOutputRejection,
  "recordedAt"
> & { readonly inputCheckpointRef: InvestigationVersionRef };

/** Charge a rejected proposal without accepting its analysis or consuming an analysis round. */
export function rejectInvestigationModelOutput(
  checkpoint: InvestigationLoopCheckpointV1,
  rejection: RejectInvestigationModelOutputInput,
  options: {
    readonly recordedAt: string;
    readonly durationMs: number;
    readonly accountedTokens: number;
  },
): InvestigationLoopCheckpointV1 {
  assertInvestigationCheckpointIntegrity(checkpoint);
  requireCondition(
    checkpoint.stopReason === "continuing",
    "loop_already_stopped",
    "Model output correction requires an active investigation attempt.",
  );
  requireCondition(
    rejection.attemptId === checkpoint.attemptId,
    "model_output_rejection_attempt_mismatch",
    "A rejected proposal must belong to the active attempt.",
  );
  requireCondition(
    unchanged(rejection.inputCheckpointRef, reference(checkpoint)),
    "stale_checkpoint_reference",
    "A rejected proposal must reference the exact accepted input checkpoint.",
  );
  requireCondition(
    rejection.round === checkpoint.round + 1,
    "round_sequence_mismatch",
    "A rejected proposal must identify the next unaccepted analysis round.",
  );
  requireCondition(
    isCorrectableInvestigationModelOutputIssue(rejection.issue),
    "model_output_rejection_not_correctable",
    "Only ordinary duplicate IDs or unresolved record references at safe structural paths may be corrected.",
  );
  const previousRejections = checkpoint.runtime.modelOutputRejections ?? [];
  requireCondition(
    !previousRejections.some((entry) => entry.invocationId === rejection.invocationId),
    "model_output_rejection_invocation_reused",
    "A model invocation can be rejected only once.",
  );
  requireCondition(
    !previousRejections.some(
      (entry) => entry.attemptId === rejection.attemptId && entry.round === rejection.round,
    ),
    "model_output_correction_exhausted",
    "Only one rejected proposal may be corrected per attempt and analysis round.",
  );
  const totalDurationMs = checkpoint.consumed.durationMs + options.durationMs;
  requireCondition(
    Number.isSafeInteger(options.durationMs) &&
      options.durationMs >= 0 &&
      Number.isSafeInteger(totalDurationMs) &&
      Number.isSafeInteger(options.accountedTokens) &&
      options.accountedTokens >= checkpoint.consumed.tokens,
    "invalid_worker_consumption",
    "Elapsed time must be nonnegative and the accounting ledger total must preserve prior token consumption.",
  );
  const runtime = structuredClone(checkpoint.runtime);
  runtime.modelOutputRejections = [
    ...previousRejections.map((entry) => structuredClone(entry)),
    {
      attemptId: rejection.attemptId,
      round: rejection.round,
      invocationId: rejection.invocationId,
      issue: structuredClone(rejection.issue),
      recordedAt: options.recordedAt,
    },
  ];
  const reportBytes = Math.max(
    checkpoint.consumed.reportBytes,
    retainedReportBytes(checkpoint.analysis, runtime),
  );
  const next = sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    previousCheckpointRef: reference(checkpoint),
    recordedAt: options.recordedAt,
    runtime,
    consumed: {
      ...checkpoint.consumed,
      durationMs: totalDurationMs,
      tokens: options.accountedTokens,
      reportBytes,
    },
    stopReason:
      checkpoint.consumed.rounds >= checkpoint.budget.maxRounds ||
      totalDurationMs >= checkpoint.budget.maxDurationMs ||
      options.accountedTokens >= checkpoint.budget.maxTokens ||
      reportBytes > checkpoint.budget.maxReportBytes
        ? "budget_exhausted"
        : "continuing",
  });
  assertInvestigationCheckpointIntegrity(next);
  return next;
}

export function interruptInvestigationLoop(
  checkpoint: InvestigationLoopCheckpointV1,
  reason: "blocked" | "failed" | "error" | "cancelled" | "interrupted" | "budget_exhausted",
  recordedAt = checkpoint.recordedAt,
  diagnostics: readonly InvestigationDiagnostic[] = [],
  durationMs = 0,
  modelUsage?: Pick<InvestigationUnacceptedModelUsage, "round" | "tokens">,
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
  const runtime = structuredClone(checkpoint.runtime);
  let tokens = checkpoint.consumed.tokens;
  if (modelUsage !== undefined) {
    requireCondition(
      Number.isSafeInteger(modelUsage.round) &&
        modelUsage.round > 0 &&
        (modelUsage.tokens === null ||
          (Number.isSafeInteger(modelUsage.tokens) && modelUsage.tokens >= 0)),
      "invalid_worker_consumption",
      "Unaccepted model usage must contain a positive round and a known nonnegative token count or null.",
    );
    const previous = runtime.unacceptedModelUsage?.find(
      (usage) => usage.attemptId === checkpoint.attemptId && usage.round === modelUsage.round,
    );
    if (previous !== undefined)
      requireCondition(
        previous.tokens === modelUsage.tokens,
        "model_usage_receipt_conflict",
        "This model invocation already has a different token usage receipt.",
      );
    else {
      requireCondition(
        modelUsage.round === checkpoint.round + 1,
        "model_usage_round_mismatch",
        "Unaccepted model usage must identify the next unaccepted analysis round.",
      );
      runtime.unacceptedModelUsage = [
        ...(runtime.unacceptedModelUsage ?? []),
        { attemptId: checkpoint.attemptId, ...modelUsage },
      ];
      tokens += modelUsage.tokens ?? 0;
      requireCondition(
        Number.isSafeInteger(tokens),
        "invalid_worker_consumption",
        "The accumulated token consumption must remain a safe integer.",
      );
    }
  }
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
  preserveUnknownModelUsageDiagnostics(analysis, runtime);
  const reportBytes = Math.max(
    checkpoint.consumed.reportBytes,
    retainedReportBytes(analysis, runtime),
  );
  return sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    analysis,
    runtime,
    consumed: {
      ...checkpoint.consumed,
      durationMs: checkpoint.consumed.durationMs + durationMs,
      tokens,
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
  const previousE2e = checkpoint.runtime.e2eExecution;
  if (previousE2e !== undefined)
    requireCondition(
      runtime.e2eExecution !== undefined &&
        runtime.e2eExecution.attemptId === previousE2e.attemptId &&
        runtime.e2eExecution.startedAt === previousE2e.startedAt &&
        (previousE2e.status !== "completed" || unchanged(previousE2e, runtime.e2eExecution)),
      "e2e_execution_lifecycle_regression",
      "A durable E2E start marker cannot be removed, replaced or restarted.",
    );
  requireCondition(
    runtime.reviewMode === checkpoint.runtime.reviewMode,
    "review_mode_is_trusted",
    "Execution receipts cannot change the trusted source review mode.",
  );
  requireCondition(
    checkpoint.runtime.unacceptedModelUsage === undefined
      ? runtime.unacceptedModelUsage === undefined
      : runtime.unacceptedModelUsage !== undefined &&
          unchanged(checkpoint.runtime.unacceptedModelUsage, runtime.unacceptedModelUsage),
    "model_usage_history_is_trusted",
    "Execution receipts cannot add, replace, or remove unaccepted model usage receipts.",
  );
  requireCondition(
    checkpoint.runtime.modelExecutions === undefined
      ? runtime.modelExecutions === undefined
      : runtime.modelExecutions !== undefined &&
          unchanged(checkpoint.runtime.modelExecutions, runtime.modelExecutions),
    "model_execution_history_is_trusted",
    "Execution receipts cannot add, replace, or remove accepted analysis model identities.",
  );
  requireCondition(
    checkpoint.runtime.modelOutputRejections === undefined
      ? runtime.modelOutputRejections === undefined
      : runtime.modelOutputRejections !== undefined &&
          unchanged(checkpoint.runtime.modelOutputRejections, runtime.modelOutputRejections),
    "model_output_rejection_history_is_trusted",
    "Execution receipts cannot add, replace, or remove model output rejection history.",
  );
  const previousSource = checkpoint.runtime.sourceCoverage;
  requireCondition(
    previousSource === undefined
      ? runtime.sourceCoverage === undefined
      : runtime.sourceCoverage !== undefined && unchanged(previousSource, runtime.sourceCoverage),
    "source_coverage_is_trusted",
    "Execution receipts cannot change the trusted source manifest or claim model delivery.",
  );
  requireCondition(
    checkpoint.runtime.sourceProvenance === undefined
      ? runtime.sourceProvenance === undefined
      : runtime.sourceProvenance !== undefined &&
          unchanged(checkpoint.runtime.sourceProvenance, runtime.sourceProvenance),
    "source_provenance_is_trusted",
    "Execution receipts cannot add, replace, or remove the trusted source provenance.",
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
  options: {
    readonly recordedAt: string;
    readonly durationMs?: number;
    readonly accountedTokens?: number;
  },
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
  const totalTokens = options.accountedTokens ?? checkpoint.consumed.tokens + modelTokens;
  requireCondition(
    Number.isSafeInteger(totalTokens) && totalTokens >= 0,
    "invalid_worker_consumption",
    "The accounting ledger total must be a nonnegative safe integer.",
  );
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

/** Canonical changed-file scope shared by source registration and sealed report validation. */
export function investigationChangedFileCoverageDefinition(subjectRef: string, path: string) {
  return {
    id: `source-file:${investigationContentDigest([subjectRef, path])}`,
    subjectRef,
    kind: "source_file" as const,
    paths: [path],
    requiredWork: `Review the changed behavior in ${path}, following relevant implementations and callers in the pinned local checkout and comparing baseline source when needed.`,
  };
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
    const sourceUnits =
      runtime.reviewMode === "local_checkout"
        ? manifest.files.map((file) => ({
            ...investigationChangedFileCoverageDefinition(manifest.subjectRef, file.path),
            status: "pending" as const,
            evidenceRefs: [],
          }))
        : manifest.chunks.map((chunk) => ({
            id: chunk.id,
            subjectRef: manifest.subjectRef,
            kind: "pr_diff_chunk",
            paths: [chunk.path],
            requiredWork: `Inspect complete ${chunk.kind} source chunk ${chunk.ordinal} for ${chunk.path} (${chunk.encoding}, SHA-256 ${chunk.contentDigest}, ${chunk.byteLength} bytes).`,
            status: "pending" as const,
            evidenceRefs: [],
          }));
    requireCondition(
      sourceUnits.every((unit) => !existingIds.has(unit.id)),
      "source_unit_identity_collision",
      "Source coverage IDs must not replace existing investigation scope units.",
    );
    expanded.includedUnits.push(...sourceUnits);
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

/** Preserve exact dependency pins before any model or execution work, including delivery recovery. */
export function applyInvestigationSourceProvenanceCheckpoint(
  checkpoint: InvestigationLoopCheckpointV1,
  provenance: InvestigationSourceProvenance,
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
    "Source provenance registration requires an active investigation attempt.",
  );
  const { task } = options;
  requireCondition(
    task.id === checkpoint.taskId &&
      checkpoint.taskBindingDigest === investigationTaskBindingDigest(task),
    "checkpoint_task_binding_mismatch",
    "Source provenance must belong to the exact frozen task.",
  );
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  requireCondition(
    (task.executionPolicy.mode === "source_read" ||
      (task.executionPolicy.mode === "execute" &&
        task.executionPolicy.allowRepositoryExecution &&
        task.executionPolicy.authorizationRef !== null)) &&
      task.executionPolicy.allowedSubjectRefs.includes(task.subjectRef) &&
      subject !== undefined &&
      subject.repositoryId === task.repository.id &&
      subject.workItemId === task.workItem.id,
    "source_provenance_not_authorized",
    "Source provenance requires authorized materialization of the task's primary subject.",
  );
  const validation = validateInvestigationSourceProvenance(provenance, {
    subjectRef: task.subjectRef,
    subjects: task.subjects,
  });
  requireCondition(
    validation.valid,
    "invalid_source_provenance",
    validation.errors.map((entry) => entry.message).join(" "),
  );
  const previous = checkpoint.runtime.sourceProvenance;
  requireCondition(
    previous === undefined || unchanged(previous, provenance),
    "source_provenance_changed",
    "Resume must preserve the exact registered dependency paths and immutable pins.",
  );
  if (previous === undefined)
    requireCondition(
      checkpoint.round === 0 &&
        checkpoint.consumed.rounds === 0 &&
        checkpoint.consumed.tokens === 0 &&
        checkpoint.runtime.startedSteps.length === 0 &&
        checkpoint.runtime.completedSteps.length === 0 &&
        checkpoint.runtime.completedStepIds.length === 0 &&
        checkpoint.runtime.evidence.length === 0 &&
        checkpoint.runtime.artifacts.length === 0 &&
        checkpoint.runtime.checks.length === 0 &&
        checkpoint.runtime.subjects.length === 0 &&
        checkpoint.runtime.e2eExecution === undefined &&
        checkpoint.runtime.e2e === undefined &&
        (checkpoint.runtime.modelExecutions?.length ?? 0) === 0 &&
        (checkpoint.runtime.modelOutputRejections?.length ?? 0) === 0 &&
        (checkpoint.runtime.unacceptedModelUsage?.length ?? 0) === 0,
      "source_provenance_registration_too_late",
      "The first source provenance receipt must precede model or repository execution.",
    );
  const durationMs = options.durationMs ?? 0;
  const totalDurationMs = checkpoint.consumed.durationMs + durationMs;
  requireCondition(
    Number.isSafeInteger(durationMs) && durationMs >= 0 && Number.isSafeInteger(totalDurationMs),
    "invalid_worker_consumption",
    "Trusted elapsed duration and its accumulated total must be nonnegative safe integers.",
  );
  const runtime = {
    ...structuredClone(checkpoint.runtime),
    sourceProvenance: structuredClone(provenance),
  };
  const reportBytes = Math.max(
    checkpoint.consumed.reportBytes,
    retainedReportBytes(checkpoint.analysis, runtime),
  );
  return sealCheckpoint({
    ...structuredClone(checkpoint),
    version: checkpoint.version + 1,
    previousCheckpointRef: reference(checkpoint),
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
