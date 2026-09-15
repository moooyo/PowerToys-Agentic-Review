import {
  type InvestigationAttemptV1,
  InvestigationAttemptV1Schema,
  type InvestigationLoopCheckpointV1,
  InvestigationLoopCheckpointV1Schema,
  type InvestigationPlanDraft,
  type InvestigationPlanV1,
  InvestigationPlanV1Schema,
  type InvestigationReportHeaderV1,
  InvestigationReportHeaderV1Schema,
  type InvestigationReportManifestV1,
  InvestigationReportManifestV1Schema,
  type InvestigationReportPartV1,
  InvestigationReportPartV1Schema,
  type InvestigationResultV1,
  InvestigationResultV1Schema,
  type InvestigationSubjectV1,
  type InvestigationTaskV1,
  InvestigationTaskV1Schema,
  validateInvestigationSourceCoverage,
} from "@agentic-review/contracts";
import {
  evaluateInvestigationCompletion,
  investigationContentDigest,
  investigationTaskBindingDigest,
  validateInvestigationNextActions,
} from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { requireCondition } from "./errors.js";

export interface AssembleInvestigationReportInput {
  readonly task: InvestigationTaskV1;
  readonly attempt: InvestigationAttemptV1;
  readonly checkpoint: InvestigationLoopCheckpointV1;
  readonly header: InvestigationReportHeaderV1;
  readonly manifest: InvestigationReportManifestV1;
  readonly parts: readonly InvestigationReportPartV1[];
  /** The server loads this saved record from the task's frozen parent input. */
  readonly parentPlan?: InvestigationPlanV1 | null;
}

function equal(left: unknown, right: unknown): boolean {
  return investigationContentDigest(left) === investigationContentDigest(right);
}

function requireEqual(left: unknown, right: unknown, code: string, message: string): void {
  requireCondition(equal(left, right), 422, code, message);
}

function uniqueIds(entries: readonly { id: string }[], collection: string): void {
  requireCondition(
    new Set(entries.map((entry) => entry.id)).size === entries.length,
    422,
    "duplicate_report_record",
    `The complete ${collection} collection must have unique IDs.`,
  );
}

function reportSubjects(
  task: InvestigationTaskV1,
  checkpoint: InvestigationLoopCheckpointV1,
): InvestigationSubjectV1[] {
  uniqueIds(task.subjects, "frozen subjects");
  uniqueIds(checkpoint.runtime.subjects, "runtime subjects");
  const subjects = new Map(task.subjects.map((subject) => [subject.id, subject]));
  for (const subject of checkpoint.runtime.subjects) {
    requireCondition(
      subject.repositoryId === task.repository.id && subject.workItemId === task.workItem.id,
      422,
      "runtime_subject_scope_mismatch",
      "Runtime subjects must belong to the frozen repository and work item.",
    );
    const existing = subjects.get(subject.id);
    requireCondition(
      existing === undefined || equal(existing, subject),
      422,
      "runtime_subject_identity_conflict",
      "An accepted runtime subject cannot overwrite a frozen subject identity.",
    );
    subjects.set(subject.id, subject);
  }
  return structuredClone([...subjects.values()]);
}

function planDraft(plan: InvestigationPlanV1): InvestigationPlanDraft {
  const { digest: _digest, sourceReportRef: _source, state: _state, ...draft } = plan;
  return draft;
}

function hasExplicitIssueSource(
  task: InvestigationTaskV1,
  plannedSubjectRef: string,
  subjectRef: string,
): boolean {
  const target = task.subjects.find((subject) => subject.id === subjectRef);
  const planned = task.subjects.find((subject) => subject.id === plannedSubjectRef);
  return (
    ["issue-verify", "reproduction-setup", "issue-fix", "feature-implement"].includes(task.kind) &&
    task.workItem.kind === "issue" &&
    task.subjectRef === subjectRef &&
    target?.kind === "source_commit" &&
    planned?.kind === "issue_snapshot"
  );
}

function validatedParentPlan(input: AssembleInvestigationReportInput): InvestigationPlanV1 | null {
  const { task } = input;
  const parent = input.parentPlan ?? null;
  if (parent === null) {
    requireCondition(
      task.planRef === null,
      422,
      "missing_saved_parent_plan",
      "A follow-up report must retain the server-persisted plan bound by its task.",
    );
    return null;
  }
  requireCondition(
    task.planRef !== null &&
      task.parentReportRef !== null &&
      task.parentTaskId !== null &&
      parent.id === task.planRef.id &&
      parent.version === task.planRef.version &&
      parent.digest === task.planRef.digest &&
      parent.sourceReportRef.id === task.parentReportRef.id &&
      parent.sourceReportRef.version === task.parentReportRef.version &&
      (parent.subjectRef === task.subjectRef ||
        hasExplicitIssueSource(task, parent.subjectRef, task.subjectRef)) &&
      parent.digest === investigationContentDigest(planDraft(parent)),
    422,
    "invalid_saved_parent_plan",
    "The trusted parent plan must match the frozen plan, parent report, source binding, and original draft digest.",
  );
  return parent;
}

function authorizedRuntimeSubjects(input: AssembleInvestigationReportInput): ReadonlySet<string> {
  const { task, checkpoint } = input;
  const allowed = new Set(task.executionPolicy.allowedSubjectRefs);
  const frozen = new Map(task.subjects.map((subject) => [subject.id, subject]));
  const artifacts = new Map(
    checkpoint.runtime.artifacts.map((artifact) => [artifact.id, artifact]),
  );
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
    requireCondition(
      task.executionPolicy.mode === "execute" &&
        task.executionPolicy.allowRepositoryExecution &&
        task.executionPolicy.authorizationRef !== null &&
        allowed.has(subject.baseSubjectRef) &&
        baseSha !== null &&
        baseSha === subject.baseSha &&
        patch !== undefined &&
        patch.kind === "patch" &&
        patch.subjectRef === subject.id &&
        patch.digest === subject.patchDigest &&
        patch.availability === "available" &&
        patch.taskId === task.id &&
        checkpoint.adoptedAttemptIds.includes(patch.attemptId),
      422,
      "unauthorized_derived_patch",
      "A derived patch requires an authorized immutable base and its persisted worker patch artifact.",
    );
    allowed.add(subject.id);
  }
  return allowed;
}

function validateSourceCoverage(input: AssembleInvestigationReportInput): void {
  const { task, checkpoint } = input;
  const source = checkpoint.runtime.sourceCoverage;
  const units = checkpoint.analysis.coverage.includedUnits;
  if (source === undefined) {
    requireCondition(
      !units.some((unit) => unit.kind === "full_diff" && unit.status === "completed"),
      422,
      "source_manifest_required",
      "A completed full diff requires the complete registered source manifest and delivery receipts.",
    );
    requireCondition(
      !units.some((unit) => unit.kind === "pr_diff_chunk"),
      422,
      "source_manifest_required",
      "Source chunk coverage cannot exist without a registered complete source manifest.",
    );
    return;
  }
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  requireCondition(
    task.kind === "pr-review" && subject?.kind === "original_pr",
    422,
    "source_manifest_task_mismatch",
    "A registered complete PR diff must belong to the original PR review task.",
  );
  const validation = validateInvestigationSourceCoverage(source, subject);
  requireCondition(
    validation.valid,
    422,
    "invalid_source_coverage",
    `The registered source manifest and delivery receipts are invalid: ${validation.errors.map((entry) => entry.message).join(" ")}`,
  );
  const { digest, ...content } = source.manifest;
  requireCondition(
    digest === investigationContentDigest(content),
    422,
    "source_manifest_digest_mismatch",
    "The complete registered source manifest must match its canonical digest.",
  );
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const chunks = new Set(source.manifest.chunks.map((chunk) => chunk.id));
  const brokered = new Set(source.brokeredUnitIds);
  for (const chunk of source.manifest.chunks) {
    const unit = byId.get(chunk.id);
    requireCondition(
      unit !== undefined &&
        unit.kind === "pr_diff_chunk" &&
        unit.subjectRef === subject.id &&
        equal(unit.paths, [chunk.path]) &&
        unit.requiredWork ===
          `Inspect complete ${chunk.kind} source chunk ${chunk.ordinal} for ${chunk.path} (${chunk.encoding}, SHA-256 ${chunk.contentDigest}, ${chunk.byteLength} bytes).`,
      422,
      "source_coverage_unit_mismatch",
      "Every registered source chunk must retain its exact subject, path, content identity, and required work.",
    );
    requireCondition(
      unit.status !== "completed" || brokered.has(chunk.id),
      422,
      "source_chunk_not_delivered",
      "A source chunk cannot be marked investigated before its complete content was delivered to the model.",
    );
  }
  requireCondition(
    units.every((unit) => unit.kind !== "pr_diff_chunk" || chunks.has(unit.id)),
    422,
    "unregistered_source_coverage_unit",
    "Source chunk coverage must originate in the complete registered manifest.",
  );
  const completedFullDiff = units.filter(
    (unit) => unit.kind === "full_diff" && unit.status === "completed",
  );
  requireCondition(
    completedFullDiff.every((unit) => unit.subjectRef === subject.id) &&
      (completedFullDiff.length === 0 ||
        source.manifest.chunks.every(
          (chunk) => brokered.has(chunk.id) && byId.get(chunk.id)?.status === "completed",
        )),
    422,
    "full_diff_coverage_incomplete",
    "A full diff cannot complete before every registered chunk has been delivered and investigated.",
  );
}

/** Produce transport metadata without embedding any unbounded report collection. */
export function reportHeader(result: InvestigationResultV1): InvestigationReportHeaderV1 {
  const { report } = result;
  const { candidates: _candidates, ...loop } = report.loop;
  return structuredClone({
    schemaVersion: "InvestigationReportHeaderV1",
    id: result.id,
    version: result.version,
    context: result.context,
    outcome: result.outcome,
    assessment: result.assessment,
    validation: { summary: result.validation.summary },
    report: {
      id: report.id,
      version: report.version,
      delivery: report.delivery,
      completeness: report.completeness,
      summary: report.summary,
      logicalContentDigest: report.logicalContentDigest,
      coverage: {
        scopeManifest: report.coverage.scopeManifest,
        includedUnitCount: report.coverage.includedUnits.length,
        completedUnitCount: report.coverage.completedUnitRefs.length,
        unresolvedUnitCount: report.coverage.unresolvedUnitRefs.length,
        exclusionCount: report.coverage.exclusions.length,
      },
      recheck: {
        finalFindingCount: report.recheck.finalFindingCount,
        validFinalVersionRecheckCount: report.recheck.validFinalVersionRecheckCount,
        pendingFindingCount: report.recheck.pendingFindingIds.length,
      },
      loop,
      collections: report.collections,
    },
  });
}

function validateInput(input: AssembleInvestigationReportInput): InvestigationPlanV1 | null {
  if (!FormatRegistry.Has("date-time")) {
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  }
  const { task, attempt, checkpoint, header, manifest, parts } = input;
  requireCondition(
    Value.Check(InvestigationTaskV1Schema, task) &&
      Value.Check(InvestigationAttemptV1Schema, attempt) &&
      Value.Check(InvestigationLoopCheckpointV1Schema, checkpoint) &&
      Value.Check(InvestigationReportHeaderV1Schema, header) &&
      Value.Check(InvestigationReportManifestV1Schema, manifest) &&
      (input.parentPlan === undefined ||
        input.parentPlan === null ||
        Value.Check(InvestigationPlanV1Schema, input.parentPlan)) &&
      parts.every((part) => Value.Check(InvestigationReportPartV1Schema, part)),
    422,
    "invalid_report_payload",
    "Every report payload must match its complete versioned schema.",
  );
  requireCondition(
    header.id === header.report.id &&
      header.version === header.report.version &&
      manifest.reportId === header.id &&
      manifest.reportVersion === header.version,
    422,
    "report_identity_mismatch",
    "The result, report header, and manifest must identify the same report version.",
  );
  requireCondition(
    attempt.taskId === task.id &&
      checkpoint.taskId === task.id &&
      checkpoint.attemptId === attempt.id &&
      checkpoint.leaseVersion === attempt.leaseVersion,
    422,
    "report_attempt_mismatch",
    "The accepted checkpoint must belong to the current task, attempt, and lease.",
  );
  const { digest: checkpointDigest, ...checkpointContent } = checkpoint;
  requireEqual(
    investigationContentDigest(checkpointContent),
    checkpointDigest,
    "checkpoint_digest_mismatch",
    "The accepted checkpoint content must match its digest.",
  );
  requireEqual(
    checkpoint.taskBindingDigest,
    investigationTaskBindingDigest(task),
    "checkpoint_task_binding_mismatch",
    "The report must preserve the frozen task scope, subjects, policy, and configuration.",
  );
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  requireCondition(
    subject !== undefined &&
      checkpoint.subjectRevisionKey === subject.revisionKey &&
      checkpoint.adoptedAttemptIds.includes(attempt.id),
    422,
    "checkpoint_subject_mismatch",
    "The checkpoint must bind the frozen subject revision and current attempt.",
  );
  requireEqual(
    checkpoint.profileRef,
    task.profileRef,
    "checkpoint_profile_mismatch",
    "The frozen profile cannot change during report assembly.",
  );
  requireEqual(
    checkpoint.promptRef,
    task.promptRef,
    "checkpoint_prompt_mismatch",
    "The frozen prompt cannot change during report assembly.",
  );
  requireEqual(
    checkpoint.budget,
    task.budget,
    "checkpoint_budget_mismatch",
    "The frozen investigation budget cannot change during report assembly.",
  );
  requireEqual(
    header.context,
    {
      repository: task.repository,
      workItem: task.workItem,
      task: {
        id: task.id,
        kind: task.kind,
        parentTaskId: task.parentTaskId,
        subjectRef: task.subjectRef,
      },
      attempt: { id: attempt.id, number: attempt.number },
      adoptedAttemptIds: checkpoint.adoptedAttemptIds,
      subjects: reportSubjects(task, checkpoint),
      profileRef: task.profileRef,
      promptRef: task.promptRef,
      parentReportRef: task.parentReportRef,
    },
    "report_context_mismatch",
    "Report context must exactly match the frozen task and its accepted attempt history.",
  );
  validateSourceCoverage(input);
  return validatedParentPlan(input);
}

function collectParts(input: AssembleInvestigationReportInput) {
  const { task, attempt, header, manifest, parts } = input;
  uniqueIds(parts, "report parts");
  uniqueIds(manifest.parts, "manifest parts");
  requireCondition(
    parts.length === manifest.parts.length,
    422,
    "report_part_set_mismatch",
    "The manifest must include every uploaded report part exactly once.",
  );
  const byId = new Map(parts.map((part) => [part.id, part]));
  const collections: {
    findings: InvestigationResultV1["findings"];
    verificationEvidence: InvestigationResultV1["verificationEvidence"];
    artifacts: InvestigationResultV1["artifacts"];
    plans: InvestigationResultV1["plans"];
    nextActions: InvestigationResultV1["nextActions"];
    feedbackDrafts: InvestigationResultV1["feedbackDrafts"];
    coverageUnits: InvestigationResultV1["report"]["coverage"]["includedUnits"];
    coverageExclusions: InvestigationResultV1["report"]["coverage"]["exclusions"];
    candidates: InvestigationResultV1["report"]["loop"]["candidates"];
    rechecks: InvestigationResultV1["report"]["recheck"]["records"];
    diagnostics: InvestigationResultV1["diagnostics"];
    limitations: InvestigationResultV1["report"]["limitations"];
    validationChecks: InvestigationResultV1["validation"]["checks"];
  } = {
    findings: [],
    verificationEvidence: [],
    artifacts: [],
    plans: [],
    nextActions: [],
    feedbackDrafts: [],
    coverageUnits: [],
    coverageExclusions: [],
    candidates: [],
    rechecks: [],
    diagnostics: [],
    limitations: [],
    validationChecks: [],
  };
  let previousPartDigest: string | null = null;
  for (const [sequence, reference] of manifest.parts.entries()) {
    const part = byId.get(reference.id);
    requireCondition(
      part !== undefined,
      422,
      "missing_report_part",
      "Every manifest part must have been uploaded before finalization.",
    );
    requireCondition(
      part.taskId === task.id &&
        part.attemptId === attempt.id &&
        part.reportId === header.id &&
        part.reportVersion === header.version,
      422,
      "report_part_binding_mismatch",
      "A report part must belong to the current task, attempt, and report version.",
    );
    requireCondition(
      part.sequence === sequence &&
        reference.sequence === sequence &&
        part.previousPartDigest === previousPartDigest,
      422,
      "report_part_chain_mismatch",
      "Report parts must form a complete ordered digest chain starting at sequence zero.",
    );
    requireCondition(
      part.itemCount === part.items.length,
      422,
      "report_part_count_mismatch",
      "The part item count must match the complete uploaded collection slice.",
    );
    const { digest, ...content } = part;
    requireCondition(
      digest === investigationContentDigest(content),
      422,
      "report_part_digest_mismatch",
      "The uploaded report part does not match its content digest.",
    );
    requireEqual(
      reference,
      {
        id: part.id,
        collection: part.collection,
        sequence: part.sequence,
        itemCount: part.itemCount,
        digest: part.digest,
      },
      "report_part_reference_mismatch",
      "The manifest reference must identify the exact uploaded part content.",
    );
    switch (part.collection) {
      case "findings":
        collections.findings.push(...part.items);
        break;
      case "verificationEvidence":
        collections.verificationEvidence.push(...part.items);
        break;
      case "artifacts":
        collections.artifacts.push(...part.items);
        break;
      case "plans":
        collections.plans.push(...part.items);
        break;
      case "nextActions":
        collections.nextActions.push(...part.items);
        break;
      case "feedbackDrafts":
        collections.feedbackDrafts.push(...part.items);
        break;
      case "coverageUnits":
        collections.coverageUnits.push(...part.items);
        break;
      case "coverageExclusions":
        collections.coverageExclusions.push(...part.items);
        break;
      case "candidates":
        collections.candidates.push(...part.items);
        break;
      case "rechecks":
        collections.rechecks.push(...part.items);
        break;
      case "diagnostics":
        collections.diagnostics.push(...part.items);
        break;
      case "limitations":
        collections.limitations.push(...part.items);
        break;
      case "validationChecks":
        collections.validationChecks.push(...part.items);
        break;
    }
    previousPartDigest = part.digest;
  }
  for (const [name, entries] of Object.entries(collections)) uniqueIds(entries, name);
  return collections;
}

function validateReportReferences(
  result: InvestigationResultV1,
  input: AssembleInvestigationReportInput,
): void {
  const { task, attempt, checkpoint } = input;
  const subjects = new Set(result.context.subjects.map((subject) => subject.id));
  const evidence = new Map(result.verificationEvidence.map((entry) => [entry.id, entry]));
  const artifacts = new Map(result.artifacts.map((entry) => [entry.id, entry]));
  const adoptedAttempts = new Set(checkpoint.adoptedAttemptIds);
  const plans = new Map(result.plans.map((entry) => [entry.id, entry]));
  const authorizedSubjects = authorizedRuntimeSubjects(input);
  function requireSubject(subjectRef: string): void {
    requireCondition(
      subjects.has(subjectRef),
      422,
      "unknown_report_subject",
      "Every report record must reference a frozen task subject.",
    );
  }
  function requireEvidence(refs: readonly string[], subjectRef?: string): void {
    for (const id of refs) {
      const entry = evidence.get(id);
      requireCondition(
        entry !== undefined && (subjectRef === undefined || entry.subjectRef === subjectRef),
        422,
        "invalid_report_evidence_reference",
        "Evidence references must resolve to an uploaded record on the same subject.",
      );
    }
  }
  function requirePlan(
    ref: { id: string; version: number; digest: string } | null,
    subjectRef: string,
  ): void {
    if (ref === null) return;
    const plan = plans.get(ref.id);
    const inheritedSource =
      plan !== undefined &&
      input.parentPlan !== undefined &&
      input.parentPlan !== null &&
      equal(plan, input.parentPlan) &&
      hasExplicitIssueSource(task, plan.subjectRef, subjectRef);
    requireCondition(
      plan !== undefined &&
        plan.version === ref.version &&
        plan.digest === ref.digest &&
        (plan.subjectRef === subjectRef || inheritedSource),
      422,
      "invalid_report_plan_reference",
      "Plan references must resolve to the saved plan version and subject.",
    );
  }
  for (const artifact of result.artifacts) {
    requireSubject(artifact.subjectRef);
    requireCondition(
      artifact.taskId === task.id && adoptedAttempts.has(artifact.attemptId),
      422,
      "report_artifact_scope_mismatch",
      "Artifacts must originate from the current task and an explicitly adopted attempt.",
    );
  }
  for (const entry of result.verificationEvidence) {
    requireSubject(entry.subjectRef);
    requireCondition(
      entry.provenance.taskId === task.id && adoptedAttempts.has(entry.provenance.attemptId),
      422,
      "report_evidence_scope_mismatch",
      "Evidence provenance must identify the current task and an explicitly adopted attempt.",
    );
    requireCondition(
      entry.authority !== "server",
      422,
      "forged_server_evidence",
      "A worker report cannot claim server evidence authority.",
    );
    if (entry.authority === "model") {
      requireCondition(
        (entry.source === "static_analysis" || entry.source === "reporter_statement") &&
          entry.artifactRefs.length === 0 &&
          entry.provenance.attemptId === attempt.id &&
          entry.provenance.producer === "investigation-model" &&
          entry.provenance.recordedAt === checkpoint.recordedAt,
        422,
        "invalid_model_evidence_authority",
        "Model analysis must remain explicitly attributed analysis without fabricated execution receipts.",
      );
    } else {
      requireCondition(
        entry.source !== "static_analysis" && entry.source !== "reporter_statement",
        422,
        "invalid_worker_evidence_authority",
        "Model analysis cannot be promoted to a worker execution observation.",
      );
    }
    requireEvidence(entry.evidenceRefs, entry.subjectRef);
    for (const id of entry.artifactRefs) {
      const artifact = artifacts.get(id);
      requireCondition(
        artifact !== undefined &&
          artifact.subjectRef === entry.subjectRef &&
          artifact.attemptId === entry.provenance.attemptId,
        422,
        "invalid_evidence_artifact_reference",
        "Evidence artifacts must resolve to the same subject and producing attempt.",
      );
    }
  }
  for (const check of result.validation.checks) {
    requireSubject(check.subjectRef);
    requireEvidence(check.evidenceRefs, check.subjectRef);
    const target = result.context.subjects.find((subject) => subject.id === check.subjectRef);
    const plan = check.planRef === null ? undefined : plans.get(check.planRef.id);
    const implementationPatch =
      target?.kind === "local_patch" &&
      plan !== undefined &&
      ((task.kind === "issue-fix" && plan.kind === "fix") ||
        (task.kind === "feature-implement" && plan.kind === "implementation")) &&
      (plan.subjectRef === target.baseSubjectRef ||
        (input.parentPlan !== undefined &&
          input.parentPlan !== null &&
          equal(plan, input.parentPlan) &&
          hasExplicitIssueSource(task, plan.subjectRef, target.baseSubjectRef)));
    requirePlan(check.planRef, implementationPatch ? target.baseSubjectRef : check.subjectRef);
    requireCondition(
      plan === undefined || plan.steps.some((step) => step.checkIds.includes(check.id)),
      422,
      "validation_check_outside_plan",
      "A validation check must belong to its exact saved plan.",
    );
    requireCondition(
      check.authoritativeAttemptId === null || adoptedAttempts.has(check.authoritativeAttemptId),
      422,
      "invalid_validation_attempt",
      "Validation receipts must identify an explicitly adopted execution attempt.",
    );
    if (check.status === "passed" || check.status === "failed") {
      requireCondition(
        task.executionPolicy.mode === "execute" &&
          task.executionPolicy.allowRepositoryExecution &&
          task.executionPolicy.authorizationRef !== null &&
          authorizedSubjects.has(check.subjectRef),
        422,
        "unauthorized_validation_receipt",
        "Executed validation checks require explicit execution authorization for the tested subject.",
      );
      requireCondition(
        check.executor !== null &&
          check.authoritativeAttemptId !== null &&
          check.evidenceRefs.length > 0,
        422,
        "missing_validation_receipt",
        "Executed checks require an executor, producing attempt, and observation evidence.",
      );
      requireCondition(
        check.evidenceRefs.every((id) => {
          const entry = evidence.get(id);
          return (
            entry !== undefined &&
            entry.authority === "worker" &&
            entry.source === "executor_observation" &&
            entry.provenance.attemptId === check.authoritativeAttemptId
          );
        }),
        422,
        "invalid_validation_receipt",
        "Validation outcomes require worker observations from the authoritative attempt.",
      );
    }
  }
  for (const unit of result.report.coverage.includedUnits) {
    requireSubject(unit.subjectRef);
    requireEvidence(unit.evidenceRefs, unit.subjectRef);
  }
  for (const exclusion of result.report.coverage.exclusions) requireSubject(exclusion.subjectRef);
  for (const candidate of result.report.loop.candidates) {
    requireSubject(candidate.subjectRef);
    requireEvidence(candidate.evidenceRefs, candidate.subjectRef);
  }
  for (const record of result.report.recheck.records) {
    requireSubject(record.subjectRef);
    requireEvidence(record.evidenceRefs, record.subjectRef);
  }
  for (const finding of result.findings) {
    requireSubject(finding.subjectRef);
    requireEvidence(finding.evidenceRefs, finding.subjectRef);
    requireEvidence(finding.rootCause.evidenceRefs, finding.subjectRef);
    requireEvidence(finding.confirmation.evidenceRefs, finding.subjectRef);
    requirePlan(finding.fixRecommendation.planRef, finding.subjectRef);
    requireCondition(
      finding.locations.every(
        (location) =>
          location.subjectRef === finding.subjectRef &&
          (location.kind !== "source" || location.startLine <= location.endLine),
      ),
      422,
      "invalid_finding_location",
      "Finding locations must bind the finding subject and a valid source range.",
    );
    requireCondition(
      finding.feedbackDraft.suggestion === null ||
        finding.feedbackDraft.suggestion.subjectRef === finding.subjectRef,
      422,
      "invalid_suggestion_subject",
      "A finding suggestion must preserve the finding's assessed subject.",
    );
  }
  for (const plan of result.plans) requireSubject(plan.subjectRef);
  const drafts = [
    ...result.feedbackDrafts,
    ...result.findings.map((finding) => finding.feedbackDraft),
  ];
  const draftsById = new Map<string, InvestigationResultV1["feedbackDrafts"][number]>();
  for (const draft of drafts) {
    const existing = draftsById.get(draft.id);
    requireCondition(
      existing === undefined || equal(existing, draft),
      422,
      "conflicting_feedback_draft",
      "A repeated feedback draft ID must preserve identical content.",
    );
    draftsById.set(draft.id, draft);
    const suggestion = draft.suggestion;
    if (suggestion === null) continue;
    const subject = result.context.subjects.find((entry) => entry.id === suggestion.subjectRef);
    const sha =
      subject?.kind === "original_pr" || subject?.kind === "remote_branch"
        ? subject.headSha
        : subject?.kind === "source_commit"
          ? subject.commitSha
          : subject?.kind === "local_patch"
            ? subject.baseSha
            : null;
    requireCondition(
      sha === suggestion.headSha &&
        suggestion.startLine <= suggestion.endLine &&
        !/^(?:[A-Za-z]:|[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(suggestion.path),
      422,
      "invalid_suggestion_subject",
      "Code suggestion drafts must bind an exact source SHA, repository-relative path, and valid range.",
    );
  }
  for (const diagnostic of result.diagnostics) requireEvidence(diagnostic.evidenceRefs);
  for (const limitation of result.report.limitations) requireEvidence(limitation.evidenceRefs);
  const assessment = result.assessment;
  requireSubject(assessment.subjectRef);
  requireEvidence(assessment.evidenceRefs, assessment.subjectRef);
  if (assessment.kind === "pr") {
    requirePlan(assessment.e2eAssessment.planRef, assessment.subjectRef);
  } else if (assessment.kind === "bug") {
    requirePlan(assessment.reproduction.planRef, assessment.subjectRef);
    requireEvidence(assessment.reproduction.evidenceRefs, assessment.subjectRef);
    if (assessment.bugAssessment.upstreamFix !== null)
      requireEvidence(assessment.bugAssessment.upstreamFix.evidenceRefs, assessment.subjectRef);
    if (assessment.bugAssessment.duplicateOf !== null)
      requireEvidence(assessment.bugAssessment.duplicateOf.evidenceRefs, assessment.subjectRef);
    if (
      assessment.reproduction.status === "reproduced" ||
      assessment.reproduction.status === "not_reproduced"
    ) {
      requireCondition(
        assessment.reproduction.evidenceRefs.some((id) => {
          const entry = evidence.get(id);
          return entry?.authority === "worker" && entry.source === "executor_observation";
        }),
        422,
        "missing_reproduction_observation",
        "Reproduction outcomes require actual worker observation evidence.",
      );
    }
  } else if (assessment.kind === "feature") {
    requirePlan(assessment.featureAssessment.implementationPlanRef, assessment.subjectRef);
    if (assessment.featureAssessment.duplicateOf !== null)
      requireEvidence(assessment.featureAssessment.duplicateOf.evidenceRefs, assessment.subjectRef);
  }
  const invalidActions = validateInvestigationNextActions(result, result.plans).filter(
    (entry) => !entry.valid,
  );
  requireCondition(
    invalidActions.length === 0,
    422,
    "invalid_saved_next_action",
    `Every next action must resolve to valid saved records: ${invalidActions.map((entry) => `${entry.action.id} (${entry.reasonCodes.join(", ")})`).join("; ")}`,
  );
}

/** Rebuild and seal the complete logical report; no uploaded collection is truncated or trusted by count. */
export function assembleInvestigationReport(
  input: AssembleInvestigationReportInput,
): InvestigationResultV1 {
  const parentPlan = validateInput(input);
  const { header, manifest, checkpoint, task } = input;
  const collections = collectParts(input);
  const { analysis } = checkpoint;
  for (const [actual, expected, name] of [
    [collections.findings, analysis.findings, "findings"],
    [collections.coverageUnits, analysis.coverage.includedUnits, "coverage units"],
    [collections.coverageExclusions, analysis.coverage.exclusions, "coverage exclusions"],
    [collections.candidates, analysis.candidates, "candidates"],
    [collections.rechecks, analysis.rechecks, "rechecks"],
    [collections.feedbackDrafts, analysis.feedbackDrafts, "feedback drafts"],
    [collections.diagnostics, analysis.diagnostics, "diagnostics"],
    [collections.limitations, analysis.limitations, "limitations"],
    [collections.artifacts, checkpoint.runtime.artifacts, "artifacts"],
    [collections.validationChecks, checkpoint.runtime.checks, "validation checks"],
  ] as const) {
    requireEqual(
      actual,
      expected,
      "report_checkpoint_collection_mismatch",
      `The complete uploaded ${name} collection must exactly match the accepted checkpoint.`,
    );
  }
  requireEqual(
    header.assessment,
    analysis.assessment,
    "report_assessment_mismatch",
    "The report assessment must match the accepted checkpoint.",
  );
  requireEqual(
    header.report.summary,
    analysis.summary,
    "report_summary_mismatch",
    "The report summary must match the accepted checkpoint.",
  );
  const expectedDrafts = [...analysis.plans];
  const repeatedParent =
    parentPlan === null ? undefined : analysis.plans.find((draft) => draft.id === parentPlan.id);
  requireCondition(
    repeatedParent === undefined ||
      (parentPlan !== null && equal(repeatedParent, planDraft(parentPlan))),
    422,
    "saved_parent_plan_conflict",
    "An analysis draft cannot replace the saved parent plan with different content.",
  );
  if (parentPlan !== null && repeatedParent === undefined)
    expectedDrafts.push(planDraft(parentPlan));
  requireEqual(
    collections.plans.map(planDraft),
    expectedDrafts,
    "report_plan_draft_mismatch",
    "Saved plans must preserve all accepted drafts and the complete trusted parent plan in order.",
  );
  for (const plan of collections.plans) {
    if (parentPlan !== null && plan.id === parentPlan.id) {
      requireEqual(
        plan,
        parentPlan,
        "invalid_saved_parent_plan",
        "The uploaded parent plan must preserve its original saved record and source report.",
      );
      continue;
    }
    const { digest, sourceReportRef, state, ...draft } = plan;
    requireCondition(
      digest === investigationContentDigest(draft) &&
        state === "saved" &&
        sourceReportRef.id === header.id &&
        sourceReportRef.version === header.version,
      422,
      "invalid_saved_plan",
      "Saved plans must bind their original draft digest and the current report version.",
    );
  }
  requireEqual(
    collections.nextActions.map(({ sourceReportRef: _source, state: _state, ...draft }) => draft),
    analysis.nextActions,
    "report_action_draft_mismatch",
    "Saved next actions must preserve every accepted action draft exactly.",
  );
  for (const action of collections.nextActions) {
    requireCondition(
      action.state === "saved" &&
        action.sourceReportRef.id === header.id &&
        action.sourceReportRef.version === header.version,
      422,
      "invalid_saved_action",
      "Saved next actions must bind the current report version.",
    );
  }
  const modelEvidence = analysis.evidence.map((entry) => ({
    ...entry,
    authority: "model" as const,
    artifactRefs: [],
    provenance: {
      taskId: task.id,
      attemptId: input.attempt.id,
      producer: "investigation-model",
      recordedAt: checkpoint.recordedAt,
    },
  }));
  requireEqual(
    collections.verificationEvidence,
    [...modelEvidence, ...checkpoint.runtime.evidence],
    "report_evidence_mismatch",
    "Evidence must preserve accepted worker receipts and explicitly attributed model analysis.",
  );
  const completion = evaluateInvestigationCompletion(checkpoint);
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
  requireCondition(
    header.outcome === expectedOutcome && checkpoint.stopReason !== "continuing",
    422,
    "report_outcome_mismatch",
    "The report outcome must reflect the accepted stopped investigation loop.",
  );
  const complete = header.outcome === "completed" && completion.complete;
  requireCondition(
    header.outcome !== "completed" || complete,
    422,
    "incomplete_report_claimed_completed",
    "An investigation cannot complete before all scope, candidates, and final finding versions have been reviewed.",
  );
  const result: InvestigationResultV1 = {
    schemaVersion: "InvestigationResultV1",
    id: header.id,
    version: header.version,
    context: structuredClone(header.context),
    outcome: header.outcome,
    report: {
      id: header.id,
      version: header.version,
      delivery: complete ? "final" : "checkpoint",
      completeness: complete ? "complete" : "partial",
      summary: analysis.summary,
      logicalContentDigest: header.report.logicalContentDigest,
      coverage: {
        ...structuredClone(analysis.coverage),
        includedUnits: collections.coverageUnits,
        exclusions: collections.coverageExclusions,
      },
      recheck: {
        finalFindingCount: collections.findings.length,
        validFinalVersionRecheckCount:
          collections.findings.length - completion.pendingFindingIds.length,
        pendingFindingIds: [...completion.pendingFindingIds],
        records: collections.rechecks,
      },
      loop: {
        checkpointId: checkpoint.id,
        checkpointVersion: checkpoint.version,
        completedRounds: checkpoint.round,
        candidates: collections.candidates,
        stopReason: checkpoint.stopReason,
        budget: structuredClone(checkpoint.budget),
        consumed: structuredClone(checkpoint.consumed),
      },
      limitations: collections.limitations,
      collections: {
        findings: collections.findings.length,
        verificationEvidence: collections.verificationEvidence.length,
        artifacts: collections.artifacts.length,
        plans: collections.plans.length,
        nextActions: collections.nextActions.length,
        candidates: collections.candidates.length,
        rechecks: collections.rechecks.length,
      },
    },
    findings: collections.findings,
    assessment: structuredClone(analysis.assessment),
    validation: { summary: header.validation.summary, checks: collections.validationChecks },
    verificationEvidence: collections.verificationEvidence,
    diagnostics: collections.diagnostics,
    artifacts: collections.artifacts,
    plans: collections.plans,
    nextActions: collections.nextActions,
    feedbackDrafts: collections.feedbackDrafts,
  };
  validateReportReferences(result, input);
  requireEqual(
    reportHeader(result),
    header,
    "report_header_mismatch",
    "The report header must describe the complete reconstructed report without hiding pending work.",
  );
  requireEqual(
    result.report.collections,
    manifest.collections,
    "report_manifest_count_mismatch",
    "Manifest counts must describe every reconstructed collection.",
  );
  const { logicalContentDigest, ...reportContent } = result.report;
  const actualDigest = investigationContentDigest({ ...result, report: reportContent });
  requireCondition(
    actualDigest === logicalContentDigest && actualDigest === manifest.logicalContentDigest,
    422,
    "report_logical_digest_mismatch",
    "The complete reconstructed report must match both logical content digests.",
  );
  requireCondition(
    !complete || checkpoint.consumed.reportBytes <= task.budget.maxReportBytes,
    422,
    "completed_report_budget_exceeded",
    "A completed report must fit the frozen report budget; partial reports retain all accepted records.",
  );
  requireCondition(
    Value.Check(InvestigationResultV1Schema, result),
    422,
    "invalid_logical_report",
    "The complete reconstructed result must satisfy the versioned result schema.",
  );
  return structuredClone(result);
}
