import {
  EntityIdSchema,
  type InvestigationArtifactV1,
  InvestigationArtifactV1Schema,
  type InvestigationAttemptV1,
  InvestigationAttemptV1Schema,
  type InvestigationDiagnostic,
  InvestigationDiagnosticSchema,
  type InvestigationEvidenceV1,
  InvestigationEvidenceV1Schema,
  type InvestigationLoopCheckpointV1,
  InvestigationLoopCheckpointV1Schema,
  type InvestigationOutcome,
  InvestigationOutcomeSchema,
  type InvestigationPlanDraft,
  type InvestigationPlanV1,
  InvestigationPlanV1Schema,
  type InvestigationReportCollection,
  type InvestigationReportHeaderV1,
  type InvestigationReportManifestV1,
  type InvestigationReportPartV1,
  type InvestigationResultV1,
  InvestigationResultV1Schema,
  type InvestigationSubjectV1,
  type InvestigationTaskV1,
  InvestigationTaskV1Schema,
  type InvestigationUsageSummary,
  InvestigationUsageSummarySchema,
  type InvestigationValidation,
  InvestigationValidationSchema,
  PositiveIntegerSchema,
  projectInvestigationCheckpointPresentation,
  validateInvestigationModelExecutions,
  validateInvestigationSourceProvenance,
  validateInvestigationTask,
  validateInvestigationTokenUsage,
} from "@agentic-review/contracts";
import {
  evaluateInvestigationCompletion,
  investigationContentDigest,
  investigationTaskBindingDigest,
  projectInvestigationNextActions,
  projectInvestigationReportAssessment,
  projectInvestigationReportFindings,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";

const defaultMaximumPartBytes = 256 * 1_024;
const defaultMaximumPartItems = 100;
const emptyDigest = "0".repeat(64);

export type InvestigationReportBuildFailureCode =
  | "INVALID_INPUT"
  | "COMPLETION_NOT_READY"
  | "INVALID_RUNTIME_EVIDENCE"
  | "INVALID_RUNTIME_ARTIFACT"
  | "INVALID_RUNTIME_VALIDATION"
  | "REPORT_ITEM_TOO_LARGE"
  | "REPORT_BUDGET_EXCEEDED";

export class InvestigationReportBuildError extends Error {
  public constructor(
    public readonly code: InvestigationReportBuildFailureCode,
    message: string,
    public readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "InvestigationReportBuildError";
  }
}

/** This input is supplied by the worker executor, never by model output. */
export interface InvestigationReportRuntime {
  readonly evidence?: readonly InvestigationEvidenceV1[];
  readonly artifacts?: readonly InvestigationArtifactV1[];
  readonly validation?: InvestigationValidation;
}

export interface BuildInvestigationReportSubmissionInput {
  readonly task: InvestigationTaskV1;
  readonly attempt: InvestigationAttemptV1;
  readonly checkpoint: InvestigationLoopCheckpointV1;
  readonly reportId: string;
  readonly outcome: InvestigationOutcome;
  /** Immutable Server accounting snapshot frozen for this report attempt. */
  readonly usage?: InvestigationUsageSummary;
  readonly reportVersion?: number;
  /** The server-persisted plan claimed for a follow-up task retains its original report source. */
  readonly parentPlan?: InvestigationPlanV1 | null;
  /** Omitted runtime fields use the server-accepted checkpoint records. */
  readonly runtime?: InvestigationReportRuntime;
  /** Terminal diagnostics must be checkpointed before submitting the report. */
  readonly diagnostics?: readonly InvestigationDiagnostic[];
  readonly maximumPartBytes?: number;
  readonly maximumPartItems?: number;
}

export interface InvestigationReportSubmission {
  readonly header: InvestigationReportHeaderV1;
  readonly parts: InvestigationReportPartV1[];
  readonly manifest: InvestigationReportManifestV1;
}

registerWorkerContractFormats();

/** Preserve the complete accepted ledger while bounding each transport part. */
export function buildInvestigationReportSubmission(
  input: BuildInvestigationReportSubmissionInput,
): InvestigationReportSubmission {
  validateInput(input);
  const { task, attempt, checkpoint, outcome, reportId } = input;
  const version = input.reportVersion ?? 1;
  const maximumPartBytes = input.maximumPartBytes ?? defaultMaximumPartBytes;
  const maximumPartItems = input.maximumPartItems ?? defaultMaximumPartItems;
  const completion = evaluateInvestigationCompletion(checkpoint);
  if (outcome === "completed" && (!completion.complete || checkpoint.stopReason !== "complete")) {
    throw new InvestigationReportBuildError(
      "COMPLETION_NOT_READY",
      "A completed report requires the domain completion gate and a completed checkpoint.",
    );
  }
  const expectedOutcome =
    checkpoint.stopReason === "complete"
      ? "completed"
      : checkpoint.stopReason === "error"
        ? "failed"
        : checkpoint.stopReason === "blocked"
          ? "blocked"
          : checkpoint.stopReason === "cancelled"
            ? "cancelled"
            : "interrupted";
  if (checkpoint.stopReason === "continuing" || outcome !== expectedOutcome) {
    throw new InvestigationReportBuildError(
      "INVALID_INPUT",
      "The report outcome must match the accepted stopped checkpoint.",
    );
  }

  const runtime = validatedRuntime(input);
  const analysis = structuredClone({
    ...checkpoint.analysis,
    ...projectInvestigationCheckpointPresentation(task, checkpoint),
  });
  const sourceReportRef = { id: reportId, version };
  const verificationEvidence: InvestigationEvidenceV1[] = [
    ...analysis.evidence.map(
      (evidence): InvestigationEvidenceV1 => ({
        ...evidence,
        authority: "model",
        artifactRefs: [],
        provenance: {
          taskId: task.id,
          attemptId: attempt.id,
          producer: "investigation-model",
          recordedAt: checkpoint.recordedAt,
        },
      }),
    ),
    ...runtime.evidence,
  ];
  requireUniqueIds(
    verificationEvidence,
    "INVALID_RUNTIME_EVIDENCE",
    "Evidence IDs must be unique across model and worker records.",
  );
  const plans = reportPlans(input, analysis.plans, sourceReportRef);
  const context: InvestigationResultV1["context"] = {
    ...(checkpoint.runtime.sourceProvenance === undefined
      ? {}
      : { sourceProvenance: structuredClone(checkpoint.runtime.sourceProvenance) }),
    ...(checkpoint.runtime.e2e === undefined
      ? {}
      : { e2e: structuredClone(checkpoint.runtime.e2e) }),
    repository: structuredClone(task.repository),
    workItem: structuredClone(task.workItem),
    task: {
      id: task.id,
      kind: task.kind,
      parentTaskId: task.parentTaskId,
      subjectRef: task.subjectRef,
    },
    attempt: { id: attempt.id, number: attempt.number },
    adoptedAttemptIds: [...checkpoint.adoptedAttemptIds],
    ...(checkpoint.runtime.modelExecutions === undefined
      ? {}
      : { modelExecutions: structuredClone(checkpoint.runtime.modelExecutions) }),
    subjects: runtime.subjects,
    ...(task.sourceArtifacts === undefined
      ? {}
      : { sourceArtifacts: structuredClone(task.sourceArtifacts) }),
    profileRef: structuredClone(task.profileRef),
    promptRef: structuredClone(task.promptRef),
    parentReportRef: structuredClone(task.parentReportRef),
  };
  const projectedFindings = projectInvestigationReportFindings(
    analysis.findings,
    sourceReportRef,
    mergeDiagnostics(analysis.diagnostics, input.diagnostics ?? []),
  );
  analysis.assessment = projectInvestigationReportAssessment(
    {
      context,
      report: sourceReportRef,
      assessment: analysis.assessment,
      findings: projectedFindings.findings,
      feedbackDrafts: analysis.feedbackDrafts,
    },
    analysis.nextActions,
    plans,
  );
  const { nextActions, diagnostics } = projectInvestigationNextActions(
    {
      context,
      report: sourceReportRef,
      assessment: analysis.assessment,
      findings: projectedFindings.findings,
      feedbackDrafts: analysis.feedbackDrafts,
    },
    analysis.nextActions,
    plans,
    projectedFindings.diagnostics,
  );
  const collections = {
    findings: analysis.findings.length,
    verificationEvidence: verificationEvidence.length,
    artifacts: runtime.artifacts.length,
    plans: plans.length,
    nextActions: nextActions.length,
    candidates: analysis.candidates.length,
    rechecks: analysis.rechecks.length,
  };
  const result: InvestigationResultV1 = {
    schemaVersion: "InvestigationResultV1",
    id: reportId,
    version,
    context,
    outcome,
    report: {
      id: reportId,
      version,
      delivery: outcome === "completed" ? "final" : "checkpoint",
      completeness: outcome === "completed" ? "complete" : "partial",
      summary: analysis.summary,
      logicalContentDigest: emptyDigest,
      ...(input.usage === undefined ? {} : { usage: structuredClone(input.usage) }),
      coverage: analysis.coverage,
      recheck: {
        finalFindingCount: analysis.findings.length,
        validFinalVersionRecheckCount:
          analysis.findings.length - completion.pendingFindingIds.length,
        pendingFindingIds: [...completion.pendingFindingIds],
        records: analysis.rechecks,
      },
      loop: {
        checkpointId: checkpoint.id,
        checkpointVersion: checkpoint.version,
        completedRounds: checkpoint.round,
        candidates: analysis.candidates,
        stopReason: checkpoint.stopReason,
        budget: structuredClone(checkpoint.budget),
        consumed: structuredClone(checkpoint.consumed),
      },
      limitations: analysis.limitations,
      collections,
    },
    findings: projectedFindings.findings,
    assessment: analysis.assessment,
    validation: runtime.validation,
    verificationEvidence,
    diagnostics,
    artifacts: runtime.artifacts,
    plans,
    nextActions,
    feedbackDrafts: analysis.feedbackDrafts,
  };
  if (!Value.Check(InvestigationResultV1Schema, result)) {
    throw new InvestigationReportBuildError(
      "INVALID_INPUT",
      "The assembled report does not satisfy the investigation result contract.",
    );
  }
  const { logicalContentDigest: _digest, ...reportContent } = result.report;
  result.report.logicalContentDigest = investigationContentDigest({
    ...result,
    report: reportContent,
  });

  const parts = buildParts(result, maximumPartBytes, maximumPartItems);
  if (outcome === "completed" && checkpoint.consumed.reportBytes > task.budget.maxReportBytes) {
    throw new InvestigationReportBuildError(
      "REPORT_BUDGET_EXCEEDED",
      "The report exceeded the investigation budget; preserve the checkpoint and submit a partial report.",
      {
        byteLength: checkpoint.consumed.reportBytes,
        maximumReportBytes: task.budget.maxReportBytes,
      },
    );
  }
  const { candidates: _candidates, ...loopHeader } = result.report.loop;
  const header: InvestigationReportHeaderV1 = {
    schemaVersion: "InvestigationReportHeaderV1",
    id: result.id,
    version: result.version,
    context: result.context,
    outcome,
    assessment: result.assessment,
    validation: { summary: result.validation.summary },
    report: {
      id: reportId,
      version,
      delivery: result.report.delivery,
      completeness: result.report.completeness,
      summary: result.report.summary,
      logicalContentDigest: result.report.logicalContentDigest,
      ...(result.report.usage === undefined ? {} : { usage: result.report.usage }),
      coverage: {
        scopeManifest: result.report.coverage.scopeManifest,
        includedUnitCount: result.report.coverage.includedUnits.length,
        completedUnitCount: result.report.coverage.completedUnitRefs.length,
        unresolvedUnitCount: result.report.coverage.unresolvedUnitRefs.length,
        exclusionCount: result.report.coverage.exclusions.length,
      },
      recheck: {
        finalFindingCount: result.report.recheck.finalFindingCount,
        validFinalVersionRecheckCount: result.report.recheck.validFinalVersionRecheckCount,
        pendingFindingCount: result.report.recheck.pendingFindingIds.length,
      },
      loop: loopHeader,
      collections: { ...collections },
    },
  };
  return {
    header,
    parts,
    manifest: {
      schemaVersion: "InvestigationReportManifestV1",
      reportId,
      reportVersion: version,
      parts: parts.map(({ id, collection, sequence, itemCount, digest }) => ({
        id,
        collection,
        sequence,
        itemCount,
        digest,
      })),
      collections: { ...collections },
      logicalContentDigest: result.report.logicalContentDigest,
    },
  };
}

function validateInput(input: BuildInvestigationReportSubmissionInput): void {
  if (
    !Value.Check(InvestigationTaskV1Schema, input.task) ||
    (input.task.sourceArtifacts !== undefined && !validateInvestigationTask(input.task).valid) ||
    !Value.Check(InvestigationAttemptV1Schema, input.attempt) ||
    !Value.Check(InvestigationLoopCheckpointV1Schema, input.checkpoint) ||
    !Value.Check(EntityIdSchema, input.reportId) ||
    !Value.Check(InvestigationOutcomeSchema, input.outcome) ||
    (input.usage !== undefined &&
      (!Value.Check(InvestigationUsageSummarySchema, input.usage) ||
        !validateInvestigationTokenUsage(input.usage.usage))) ||
    !Value.Check(PositiveIntegerSchema, input.reportVersion ?? 1) ||
    !Value.Check(PositiveIntegerSchema, input.maximumPartBytes ?? defaultMaximumPartBytes) ||
    !Value.Check(PositiveIntegerSchema, input.maximumPartItems ?? defaultMaximumPartItems) ||
    (input.parentPlan !== undefined &&
      input.parentPlan !== null &&
      !Value.Check(InvestigationPlanV1Schema, input.parentPlan)) ||
    !Array.isArray(input.diagnostics ?? []) ||
    !(input.diagnostics ?? []).every((diagnostic) =>
      Value.Check(InvestigationDiagnosticSchema, diagnostic),
    )
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_INPUT",
      "Report input does not satisfy the investigation contracts.",
    );
  }
  const { task, attempt, checkpoint } = input;
  const { digest: _checkpointDigest, ...checkpointContent } = checkpoint;
  if (
    checkpoint.digest !== investigationContentDigest(checkpointContent) ||
    checkpoint.taskBindingDigest !== investigationTaskBindingDigest(task) ||
    attempt.taskId !== task.id ||
    checkpoint.taskId !== task.id ||
    checkpoint.attemptId !== attempt.id ||
    checkpoint.leaseVersion !== attempt.leaseVersion ||
    !validateInvestigationModelExecutions(
      checkpoint.runtime.modelExecutions ?? [],
      checkpoint.adoptedAttemptIds,
      checkpoint.round,
    ).valid ||
    (checkpoint.runtime.sourceProvenance !== undefined &&
      !validateInvestigationSourceProvenance(checkpoint.runtime.sourceProvenance, {
        subjectRef: task.subjectRef,
        subjects: task.subjects,
      }).valid) ||
    !checkpoint.adoptedAttemptIds.includes(attempt.id) ||
    checkpoint.subjectRevisionKey !==
      task.subjects.find((subject) => subject.id === task.subjectRef)?.revisionKey ||
    investigationContentDigest(checkpoint.profileRef) !==
      investigationContentDigest(task.profileRef) ||
    investigationContentDigest(checkpoint.promptRef) !==
      investigationContentDigest(task.promptRef) ||
    investigationContentDigest(checkpoint.budget) !== investigationContentDigest(task.budget)
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_INPUT",
      "The report must bind to the accepted checkpoint, frozen task, and active attempt.",
    );
  }
}

function validatedRuntime(input: BuildInvestigationReportSubmissionInput): {
  evidence: InvestigationEvidenceV1[];
  artifacts: InvestigationArtifactV1[];
  validation: InvestigationValidation;
  subjects: InvestigationSubjectV1[];
} {
  const { task, checkpoint } = input;
  const evidence = input.runtime?.evidence ?? checkpoint.runtime.evidence;
  const artifacts = input.runtime?.artifacts ?? checkpoint.runtime.artifacts;
  const checks = checkpoint.runtime.checks;
  const validation = input.runtime?.validation ?? {
    checks,
    summary:
      checks.length === 0
        ? "No worker validation checks were recorded."
        : `Worker validation recorded ${checks.length} check(s).`,
  };
  const subjects = reportSubjects(task, checkpoint);
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const adoptedAttemptIds = new Set(checkpoint.adoptedAttemptIds);
  if (
    !Array.isArray(evidence) ||
    evidence.some(
      (entry) =>
        !Value.Check(InvestigationEvidenceV1Schema, entry) ||
        entry.authority !== "worker" ||
        entry.source === "static_analysis" ||
        entry.source === "reporter_statement" ||
        entry.provenance.taskId !== task.id ||
        !adoptedAttemptIds.has(entry.provenance.attemptId) ||
        !subjectIds.has(entry.subjectRef),
    )
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_RUNTIME_EVIDENCE",
      "Runtime evidence must be an observation from a worker attempt adopted by this task.",
    );
  }
  if (
    !Array.isArray(artifacts) ||
    artifacts.some(
      (entry) =>
        !Value.Check(InvestigationArtifactV1Schema, entry) ||
        entry.taskId !== task.id ||
        task.sourceArtifacts?.some((source) => source.id === entry.id) ||
        !adoptedAttemptIds.has(entry.attemptId) ||
        !subjectIds.has(entry.subjectRef),
    )
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_RUNTIME_ARTIFACT",
      "Runtime artifacts must belong to this task and an adopted worker attempt.",
    );
  }
  requireUniqueIds(evidence, "INVALID_RUNTIME_EVIDENCE", "Runtime evidence IDs must be unique.");
  requireUniqueIds(artifacts, "INVALID_RUNTIME_ARTIFACT", "Runtime artifact IDs must be unique.");
  const evidenceById = new Map<string, InvestigationEvidenceV1>(
    evidence.map((entry: InvestigationEvidenceV1) => [entry.id, entry] as const),
  );
  const allEvidenceSubjects = new Map([
    ...checkpoint.analysis.evidence.map((entry) => [entry.id, entry.subjectRef] as const),
    ...evidence.map((entry: InvestigationEvidenceV1) => [entry.id, entry.subjectRef] as const),
  ]);
  if (
    evidence.some((entry: InvestigationEvidenceV1) =>
      entry.evidenceRefs.some(
        (id) => id === entry.id || allEvidenceSubjects.get(id) !== entry.subjectRef,
      ),
    )
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_RUNTIME_EVIDENCE",
      "Runtime evidence references must identify a distinct recorded item on the same subject.",
    );
  }
  const artifactsById = new Map<string, InvestigationArtifactV1>(
    artifacts.map((entry: InvestigationArtifactV1) => [entry.id, entry] as const),
  );
  const authorizedSubjectIds = authorizedRuntimeSubjects(task, checkpoint, artifactsById);
  if (
    evidence.some((entry: InvestigationEvidenceV1) =>
      entry.artifactRefs.some((id) => {
        const artifact = artifactsById.get(id);
        return (
          artifact === undefined ||
          artifact.subjectRef !== entry.subjectRef ||
          artifact.attemptId !== entry.provenance.attemptId
        );
      }),
    )
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_RUNTIME_EVIDENCE",
      "Runtime evidence must reference artifacts on the same subject and producing attempt.",
    );
  }
  if (
    !Value.Check(InvestigationValidationSchema, validation) ||
    validation.checks.some((check) => {
      if (!subjectIds.has(check.subjectRef)) return true;
      if (
        check.authoritativeAttemptId !== null &&
        !adoptedAttemptIds.has(check.authoritativeAttemptId)
      )
        return true;
      const observations = check.evidenceRefs.map((id) => evidenceById.get(id));
      if (observations.some((entry) => entry?.subjectRef !== check.subjectRef)) return true;
      if (check.status !== "passed" && check.status !== "failed") return false;
      return (
        task.executionPolicy.mode !== "execute" ||
        !task.executionPolicy.allowRepositoryExecution ||
        task.executionPolicy.authorizationRef === null ||
        !authorizedSubjectIds.has(check.subjectRef) ||
        check.executor === null ||
        check.authoritativeAttemptId === null ||
        !adoptedAttemptIds.has(check.authoritativeAttemptId) ||
        observations.length === 0 ||
        observations.some(
          (entry) =>
            entry === undefined ||
            entry.source !== "executor_observation" ||
            entry.provenance.attemptId !== check.authoritativeAttemptId,
        )
      );
    })
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_RUNTIME_VALIDATION",
      "Validation outcomes must bind to authorized worker observations on the tested subject.",
    );
  }
  requireUniqueIds(
    validation.checks,
    "INVALID_RUNTIME_VALIDATION",
    "Runtime validation check IDs must be unique.",
  );
  if (
    investigationContentDigest(evidence) !== investigationContentDigest(checkpoint.runtime.evidence)
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_RUNTIME_EVIDENCE",
      "Runtime evidence must be persisted in the accepted checkpoint before report assembly.",
    );
  }
  if (
    investigationContentDigest(artifacts) !==
    investigationContentDigest(checkpoint.runtime.artifacts)
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_RUNTIME_ARTIFACT",
      "Runtime artifacts must be persisted in the accepted checkpoint before report assembly.",
    );
  }
  if (
    investigationContentDigest(validation.checks) !==
    investigationContentDigest(checkpoint.runtime.checks)
  ) {
    throw new InvestigationReportBuildError(
      "INVALID_RUNTIME_VALIDATION",
      "Runtime validation checks must be persisted in the accepted checkpoint before report assembly.",
    );
  }
  return {
    evidence: structuredClone([...evidence]),
    artifacts: structuredClone([...artifacts]),
    validation: structuredClone(validation),
    subjects,
  };
}

function authorizedRuntimeSubjects(
  task: InvestigationTaskV1,
  checkpoint: InvestigationLoopCheckpointV1,
  artifacts: ReadonlyMap<string, InvestigationArtifactV1>,
): ReadonlySet<string> {
  const allowed = new Set(task.executionPolicy.allowedSubjectRefs);
  const frozen = new Map(task.subjects.map((subject) => [subject.id, subject]));
  for (const subject of checkpoint.runtime.subjects) {
    if (frozen.has(subject.id) || subject.kind !== "local_patch") continue;
    const base = frozen.get(subject.baseSubjectRef);
    const baseSha =
      base?.kind === "original_pr" || base?.kind === "remote_branch"
        ? base.headSha
        : base?.kind === "source_commit"
          ? base.commitSha
          : null;
    const patch = artifacts.get(subject.artifactRef);
    if (
      task.executionPolicy.mode !== "execute" ||
      !task.executionPolicy.allowRepositoryExecution ||
      task.executionPolicy.authorizationRef === null ||
      !allowed.has(subject.baseSubjectRef) ||
      baseSha === null ||
      baseSha !== subject.baseSha ||
      patch === undefined ||
      patch.kind !== "patch" ||
      patch.subjectRef !== subject.id ||
      patch.digest !== subject.patchDigest ||
      patch.availability !== "available" ||
      patch.taskId !== task.id ||
      !checkpoint.adoptedAttemptIds.includes(patch.attemptId)
    ) {
      throw new InvestigationReportBuildError(
        "INVALID_RUNTIME_VALIDATION",
        "A derived patch requires an authorized immutable base and its persisted worker patch artifact.",
      );
    }
    allowed.add(subject.id);
  }
  return allowed;
}

function reportPlans(
  input: BuildInvestigationReportSubmissionInput,
  drafts: readonly InvestigationPlanDraft[],
  sourceReportRef: InvestigationPlanV1["sourceReportRef"],
): InvestigationPlanV1[] {
  const parent = input.parentPlan ?? null;
  const { task } = input;
  if (parent !== null) {
    const { digest, sourceReportRef: parentSource, state: _state, ...draft } = parent;
    const primary = task.subjects.find((subject) => subject.id === task.subjectRef);
    const selectedIssueSource =
      ["issue-verify", "reproduction-setup", "issue-fix", "feature-implement"].includes(
        task.kind,
      ) &&
      task.workItem.kind === "issue" &&
      primary?.kind === "source_commit" &&
      task.subjects.some(
        (subject) => subject.id === parent.subjectRef && subject.kind === "issue_snapshot",
      );
    if (
      task.planRef === null ||
      task.parentReportRef === null ||
      task.parentTaskId === null ||
      parent.id !== task.planRef.id ||
      parent.version !== task.planRef.version ||
      parent.digest !== task.planRef.digest ||
      parentSource.id !== task.parentReportRef.id ||
      parentSource.version !== task.parentReportRef.version ||
      (parent.subjectRef !== task.subjectRef && !selectedIssueSource) ||
      digest !== investigationContentDigest(draft)
    ) {
      throw new InvestigationReportBuildError(
        "INVALID_INPUT",
        "The saved parent plan must match the frozen task plan and parent report references.",
      );
    }
  } else if (task.planRef !== null) {
    throw new InvestigationReportBuildError(
      "INVALID_INPUT",
      "A follow-up report must retain the server-persisted parent plan claimed by its task.",
    );
  }
  let parentIncluded = false;
  const plans = drafts.map((draft): InvestigationPlanV1 => {
    const digest = investigationContentDigest(draft);
    if (parent !== null && draft.id === parent.id) {
      if (draft.version !== parent.version || digest !== parent.digest) {
        throw new InvestigationReportBuildError(
          "INVALID_INPUT",
          "A report draft cannot replace the saved parent plan with different content.",
        );
      }
      parentIncluded = true;
      return structuredClone(parent);
    }
    return {
      ...structuredClone(draft),
      digest,
      sourceReportRef: { ...sourceReportRef },
      state: "saved",
    };
  });
  if (parent !== null && !parentIncluded) plans.push(structuredClone(parent));
  requireUniqueIds(plans, "INVALID_INPUT", "Saved report plans must have unique IDs.");
  return plans;
}

function reportSubjects(
  task: InvestigationTaskV1,
  checkpoint: InvestigationLoopCheckpointV1,
): InvestigationSubjectV1[] {
  requireUniqueIds(task.subjects, "INVALID_INPUT", "Frozen task subject IDs must be unique.");
  requireUniqueIds(
    checkpoint.runtime.subjects,
    "INVALID_INPUT",
    "Worker subject IDs must be unique.",
  );
  const subjects = structuredClone(task.subjects);
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  for (const subject of checkpoint.runtime.subjects) {
    const existing = byId.get(subject.id);
    if (
      subject.repositoryId !== task.repository.id ||
      subject.workItemId !== task.workItem.id ||
      (existing !== undefined &&
        investigationContentDigest(existing) !== investigationContentDigest(subject))
    ) {
      throw new InvestigationReportBuildError(
        "INVALID_INPUT",
        "Worker subject records cannot change the frozen task subject identity.",
      );
    }
    if (existing === undefined) {
      const copy = structuredClone(subject);
      subjects.push(copy);
      byId.set(copy.id, copy);
    }
  }
  return subjects;
}

function mergeDiagnostics(
  saved: readonly InvestigationDiagnostic[],
  additional: readonly InvestigationDiagnostic[],
): InvestigationDiagnostic[] {
  const diagnostics = structuredClone([...saved]);
  requireUniqueIds(diagnostics, "INVALID_INPUT", "Accepted diagnostic IDs must be unique.");
  const byId = new Map(diagnostics.map((entry) => [entry.id, entry]));
  for (const entry of additional) {
    const existing = byId.get(entry.id);
    if (existing !== undefined) {
      if (investigationContentDigest(existing) !== investigationContentDigest(entry)) {
        throw new InvestigationReportBuildError(
          "INVALID_INPUT",
          "A diagnostic cannot overwrite an accepted checkpoint record.",
        );
      }
    } else
      throw new InvestigationReportBuildError(
        "INVALID_INPUT",
        "Additional diagnostics must be persisted in the accepted checkpoint before report assembly.",
      );
  }
  return diagnostics;
}

type CollectionItems = {
  [Collection in InvestigationReportCollection]: Extract<
    InvestigationReportPartV1,
    { collection: Collection }
  >["items"];
};

function buildParts(
  result: InvestigationResultV1,
  maximumPartBytes: number,
  maximumPartItems: number,
): InvestigationReportPartV1[] {
  const collections: CollectionItems = {
    findings: result.findings,
    verificationEvidence: result.verificationEvidence,
    artifacts: result.artifacts,
    plans: result.plans,
    nextActions: result.nextActions,
    feedbackDrafts: result.feedbackDrafts,
    coverageUnits: result.report.coverage.includedUnits,
    coverageExclusions: result.report.coverage.exclusions,
    candidates: result.report.loop.candidates,
    rechecks: result.report.recheck.records,
    diagnostics: result.diagnostics,
    limitations: result.report.limitations,
    validationChecks: result.validation.checks,
  };
  const parts: InvestigationReportPartV1[] = [];
  for (const collection of Object.keys(collections) as InvestigationReportCollection[]) {
    const items = collections[collection];
    let offset = 0;
    while (offset < items.length) {
      const sequence = parts.length;
      const content = {
        schemaVersion: "InvestigationReportPartV1" as const,
        id: `part-${investigationContentDigest({ reportId: result.id, reportVersion: result.version, attemptId: result.context.attempt.id, sequence })}`,
        taskId: result.context.task.id,
        attemptId: result.context.attempt.id,
        reportId: result.id,
        reportVersion: result.version,
        sequence,
        previousPartDigest: parts.at(-1)?.digest ?? null,
        collection,
      };
      const selected: unknown[] = [];
      let serializedItemsBytes = 0;
      while (offset + selected.length < items.length && selected.length < maximumPartItems) {
        const item = items[offset + selected.length];
        if (item === undefined) {
          throw new InvestigationReportBuildError(
            "INVALID_INPUT",
            "Report collections cannot contain missing items.",
          );
        }
        const nextCount = selected.length + 1;
        const nextItemsBytes =
          serializedItemsBytes + jsonByteLength(item) + (selected.length === 0 ? 0 : 1);
        const bytes =
          jsonByteLength({ ...content, itemCount: nextCount, digest: emptyDigest, items: [] }) +
          nextItemsBytes;
        if (bytes > maximumPartBytes) {
          if (selected.length === 0) {
            throw new InvestigationReportBuildError(
              "REPORT_ITEM_TOO_LARGE",
              "An investigation report item cannot fit in a transport part; the complete checkpoint remains available.",
              { collection, itemIndex: offset, byteLength: bytes, maximumPartBytes },
            );
          }
          break;
        }
        selected.push(item);
        serializedItemsBytes = nextItemsBytes;
      }
      const unsigned = { ...content, itemCount: selected.length, items: selected };
      // The collection-to-item pairing is retained by construction from CollectionItems.
      const part = {
        ...unsigned,
        digest: investigationContentDigest(unsigned),
      } as InvestigationReportPartV1;
      parts.push(part);
      offset += selected.length;
    }
  }
  return parts;
}

function requireUniqueIds(
  entries: readonly { id: string }[],
  code: InvestigationReportBuildFailureCode,
  message: string,
): void {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new InvestigationReportBuildError(code, message);
  }
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
