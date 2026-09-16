import type {
  ActionContextV1,
  InvestigationActionGuard,
  InvestigationActionKind,
  InvestigationDiagnostic,
  InvestigationFindingV1,
  InvestigationLoopCheckpointV1,
  InvestigationNextActionDraft,
  InvestigationNextActionV1,
  InvestigationPlanV1,
  InvestigationResultV1,
  InvestigationSubjectV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";

import {
  assertInvestigationCheckpointIntegrity,
  investigationTaskBindingDigest,
} from "./investigation-loop.js";
import { appendInvestigationProjectionDiagnostic } from "./investigation-report-projection.js";

/** Server-validated feedback facts. These must never come from model authority flags. */
export interface InvestigationFeedbackFact {
  readonly findingId: string;
  readonly draftId: string;
  readonly textValid: boolean;
  readonly suggestionId: string | null;
  readonly suggestionValid: boolean;
}

export interface InvestigationFeedbackSelectionInput {
  readonly feedback: readonly InvestigationFeedbackFact[];
  /** Omitted means the initial state; an empty array is an explicit deselection. */
  readonly selectedFindingIds?: readonly string[];
  readonly explicitAction?: string | null;
  readonly recommendedActionId: string | null;
}

export interface InvestigationFeedbackSelection {
  readonly selectedFindingIds: readonly string[];
  readonly defaultSelectedFindingIds: readonly string[];
  readonly preferredActionId: string | null;
  readonly selectionKind: "none" | "comment" | "suggestion" | "mixed";
  readonly feedback: readonly {
    readonly findingId: string;
    readonly draftId: string;
    readonly kind: "comment" | "suggestion";
    readonly suggestionId: string | null;
  }[];
  readonly reasonCodes: readonly string[];
  readonly preparationBlocked: boolean;
}

/** Selection changes payload preparation, never severity policy or review event semantics. */
export function resolveInvestigationFeedbackSelection(
  input: InvestigationFeedbackSelectionInput,
): InvestigationFeedbackSelection {
  const facts = new Map(input.feedback.map((fact) => [fact.findingId, fact]));
  if (facts.size !== input.feedback.length) throw new Error("Duplicate feedback finding ID");
  const defaultSelectedFindingIds = input.feedback
    .filter((fact) => fact.suggestionValid && fact.suggestionId !== null)
    .map((fact) => fact.findingId);
  const selectedFindingIds = [...new Set(input.selectedFindingIds ?? defaultSelectedFindingIds)];
  const reasonCodes: string[] = [];
  const feedback: InvestigationFeedbackSelection["feedback"][number][] = [];
  for (const findingId of selectedFindingIds) {
    const fact = facts.get(findingId);
    if (fact === undefined) {
      reasonCodes.push(`unknown_selected_finding:${findingId}`);
    } else if (fact.suggestionValid && fact.suggestionId !== null) {
      feedback.push({
        findingId,
        draftId: fact.draftId,
        kind: "suggestion",
        suggestionId: fact.suggestionId,
      });
    } else if (fact.textValid) {
      feedback.push({ findingId, draftId: fact.draftId, kind: "comment", suggestionId: null });
    } else {
      reasonCodes.push(`invalid_selected_feedback:${findingId}`);
    }
  }
  const hasComment = feedback.some((entry) => entry.kind === "comment");
  const hasSuggestion = feedback.some((entry) => entry.kind === "suggestion");
  const selectionKind =
    hasComment && hasSuggestion
      ? "mixed"
      : hasSuggestion
        ? "suggestion"
        : hasComment
          ? "comment"
          : "none";
  const selectionAction =
    selectionKind === "mixed"
      ? "suggestion-comment"
      : selectionKind === "suggestion"
        ? "suggestion-comment"
        : selectionKind === "comment"
          ? "comment"
          : null;
  return {
    selectedFindingIds,
    defaultSelectedFindingIds,
    preferredActionId:
      input.explicitAction ??
      (reasonCodes.length > 0 ? null : (selectionAction ?? input.recommendedActionId)),
    selectionKind,
    feedback,
    reasonCodes,
    preparationBlocked: reasonCodes.length > 0,
  };
}

export interface InvestigationActionPolicyInput {
  readonly repositoryId: string;
  readonly workItemId: string;
  readonly actor: ActionContextV1["actor"];
  readonly target: ActionContextV1["target"];
  readonly generatedAt: string;
  readonly result: InvestigationResultV1 | null;
  /** Capabilities are independently authenticated operation grants, never model output. */
  readonly capabilities: readonly InvestigationActionKind[];
  readonly supportedActions?: readonly InvestigationActionKind[];
  readonly pendingSubmission?: ActionContextV1["pendingSubmission"];
  readonly persistedPlans?: readonly InvestigationPlanV1[];
  readonly satisfiedPrerequisiteIds?: readonly string[];
  readonly validatedSuggestionFindingIds?: readonly string[];
  /** Resolved IDs in the selected report, verified against its exact version and current original revision. */
  readonly resolvedFindingIds?: readonly string[];
  /** Full, validated persisted reports; may include a checkpoint preceding a failed attempt. */
  readonly validatedReports?: readonly InvestigationResultV1[];
  readonly validatedCheckpoints?: readonly {
    readonly task: InvestigationTaskV1;
    readonly checkpoint: InvestigationLoopCheckpointV1;
  }[];
  /** Authoritative, precisely bound linked validation results, with one selected report per task. */
  readonly linkedValidationReports?: readonly InvestigationResultV1[];
  /** Server verification of existing remote branches; this never authorizes commit or push. */
  readonly verifiedRemoteBranchSubjectIds?: readonly string[];
}

const prFixedActions: readonly InvestigationActionKind[] = [
  "comment",
  "approve",
  "suggestion-comment",
  "request-changes",
  "close",
  "merge",
  "trigger-ci",
];
const issueFixedActions: readonly InvestigationActionKind[] = ["comment", "close"];
const readActions = new Set<InvestigationActionKind>([
  "view-validation",
  "view-changes",
  "view-evidence",
]);

function reportRef(result: InvestigationResultV1) {
  return {
    id: result.report.id,
    version: result.report.version,
    digest: result.report.logicalContentDigest,
  };
}

function sameRef(
  left: { id: string; version: number; digest: string } | null,
  right: { id: string; version: number; digest: string } | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

function matchesCurrentSubject(
  subject: InvestigationSubjectV1,
  input: InvestigationActionPolicyInput,
): boolean {
  return (
    subject.repositoryId === input.repositoryId &&
    subject.workItemId === input.workItemId &&
    subject.revisionKey === input.target.revisionKey &&
    (input.target.kind === "pull_request"
      ? subject.kind === "original_pr" && subject.headSha === input.target.headSha
      : subject.kind === "issue_snapshot")
  );
}

/** A page or truncated preview is never usable as a complete policy input. */
function hasCompleteCollections(result: InvestigationResultV1): boolean {
  const collections = result.report.collections;
  return (
    collections.findings === result.findings.length &&
    collections.verificationEvidence === result.verificationEvidence.length &&
    collections.artifacts === result.artifacts.length &&
    collections.plans === result.plans.length &&
    collections.nextActions === result.nextActions.length &&
    collections.candidates === result.report.loop.candidates.length &&
    collections.rechecks === result.report.recheck.records.length &&
    new Set(result.findings.map((finding) => finding.id)).size === result.findings.length
  );
}

function validFindingRecheck(
  result: InvestigationResultV1,
  finding: InvestigationFindingV1,
): boolean {
  const recheck = result.report.recheck.records.find(
    (record) => record.id === finding.confirmation.recheckRef,
  );
  if (
    recheck === undefined ||
    recheck.findingId !== finding.id ||
    recheck.findingVersion !== finding.version ||
    recheck.subjectRef !== finding.subjectRef ||
    recheck.evidenceRefs.length === 0 ||
    finding.confirmation.evidenceRefs.length === 0
  )
    return false;
  const evidence = new Map(result.verificationEvidence.map((entry) => [entry.id, entry]));
  return [...recheck.evidenceRefs, ...finding.confirmation.evidenceRefs].every(
    (id) => evidence.get(id)?.subjectRef === finding.subjectRef,
  );
}

function planSourceIsBound(
  result: InvestigationNextActionResolutionContext,
  plan: InvestigationPlanV1,
): boolean {
  const source = plan.sourceReportRef;
  return (
    (source.id === result.report.id && source.version === result.report.version) ||
    (result.context.parentReportRef !== null &&
      source.id === result.context.parentReportRef.id &&
      source.version === result.context.parentReportRef.version)
  );
}

function actionPlanSubjectIsBound(
  result: InvestigationNextActionResolutionContext,
  action: InvestigationNextActionV1,
  plan: InvestigationPlanV1,
): boolean {
  if (plan.subjectRef === action.subjectRef) return true;
  // A frozen issue verification task may bind the reporter snapshot plan to an
  // independently selected source commit. This never applies to original-PR validation.
  const source = result.context.subjects.find((subject) => subject.id === action.subjectRef);
  const snapshot = result.context.subjects.find((subject) => subject.id === plan.subjectRef);
  const issuePlanKinds: Record<string, string> = {
    "issue-verify": "verification",
    "reproduction-setup": "reproduction",
    "issue-fix": "fix",
    "feature-implement": "implementation",
  };
  return (
    result.context.workItem.kind === "issue" &&
    result.context.parentReportRef !== null &&
    plan.sourceReportRef.id === result.context.parentReportRef.id &&
    plan.sourceReportRef.version === result.context.parentReportRef.version &&
    issuePlanKinds[result.context.task.kind] === plan.kind &&
    issuePlanKinds[action.taskKind ?? ""] === plan.kind &&
    source?.kind === "source_commit" &&
    snapshot?.kind === "issue_snapshot" &&
    source.id === result.context.task.subjectRef &&
    source.repositoryId === snapshot.repositoryId &&
    source.workItemId === snapshot.workItemId
  );
}

export interface InvestigationNextActionValidation {
  readonly action: InvestigationNextActionV1;
  readonly valid: boolean;
  readonly reasonCodes: readonly string[];
}

/** Only saved reference facts participate in proposal validation; completion and counts do not. */
export type InvestigationNextActionResolutionContext = Pick<
  InvestigationResultV1,
  "context" | "assessment" | "findings" | "feedbackDrafts"
> & {
  readonly report: Pick<InvestigationResultV1["report"], "id" | "version">;
  readonly nextActions: InvestigationNextActionV1[];
};

/** Resolve proposals against saved records. A classification alone never creates an action. */
export function validateInvestigationNextActions(
  result: InvestigationNextActionResolutionContext,
  persistedPlans: readonly InvestigationPlanV1[],
): InvestigationNextActionValidation[] {
  const drafts = new Map(
    [...result.feedbackDrafts, ...result.findings.map((finding) => finding.feedbackDraft)].map(
      (draft) => [draft.id, draft] as const,
    ),
  );
  const subjects = new Map(result.context.subjects.map((subject) => [subject.id, subject]));
  return result.nextActions.map((action) => {
    const reasons: string[] = [];
    if (
      action.state !== "saved" ||
      action.sourceReportRef.id !== result.report.id ||
      action.sourceReportRef.version !== result.report.version
    )
      reasons.push("action_not_saved_for_report");
    if (!subjects.has(action.subjectRef)) reasons.push("unknown_action_subject");
    const plan =
      action.planRef === null
        ? undefined
        : persistedPlans.find((entry) => sameRef(entry, action.planRef));
    if (
      action.planRef !== null &&
      (plan === undefined ||
        plan.state !== "saved" ||
        !actionPlanSubjectIsBound(result, action, plan) ||
        !planSourceIsBound(result, plan) ||
        plan.steps.length === 0 ||
        plan.acceptanceCriteria.length === 0)
    )
      reasons.push("invalid_saved_plan");
    if (action.draftRef !== null && !drafts.has(action.draftRef))
      reasons.push("invalid_saved_draft");
    if (
      ["comment", "suggestion-comment", "request-changes"].includes(action.action) &&
      action.draftRef === null
    )
      reasons.push("missing_saved_draft");
    if (
      action.action === "suggestion-comment" &&
      action.draftRef !== null &&
      drafts.has(action.draftRef) &&
      drafts.get(action.draftRef)!.suggestion === null
    )
      reasons.push("missing_saved_suggestion");
    if (action.action === "start-task" || action.action === "reviews.verify") {
      if (plan === undefined) reasons.push("missing_saved_plan");
      if (action.taskKind === null) reasons.push("missing_task_kind");
      const expectedPlanKinds: Record<string, string> = {
        "pr-review": "investigation",
        "issue-investigate": "investigation",
        "pr-verify": "verification",
        "issue-verify": "verification",
        "reproduction-setup": "reproduction",
        "issue-fix": "fix",
        "feature-implement": "implementation",
      };
      if (plan !== undefined && expectedPlanKinds[action.taskKind ?? ""] !== plan.kind)
        reasons.push("plan_task_kind_mismatch");
      const assessment = result.assessment;
      if (
        action.action === "reviews.verify" &&
        (assessment.kind !== "pr" ||
          action.taskKind !== "pr-verify" ||
          subjects.get(action.subjectRef)?.kind !== "original_pr" ||
          !sameRef(action.planRef, assessment.e2eAssessment.planRef))
      )
        reasons.push("invalid_pr_verification_binding");
      if (
        action.taskKind === "feature-implement" &&
        (assessment.kind !== "feature" ||
          assessment.featureAssessment.status !== "ready" ||
          !sameRef(action.planRef, assessment.featureAssessment.implementationPlanRef))
      )
        reasons.push("feature_not_ready_for_plan");
      if (
        action.taskKind === "issue-fix" &&
        (assessment.kind !== "bug" || assessment.bugAssessment.status !== "confirmed")
      )
        reasons.push("bug_not_confirmed_for_fix");
      if (
        (action.taskKind === "issue-verify" || action.taskKind === "reproduction-setup") &&
        (assessment.kind !== "bug" ||
          !["needs_verification", "confirmed"].includes(assessment.bugAssessment.status))
      )
        reasons.push("bug_verification_not_supported_by_assessment");
    } else if (action.taskKind !== null) reasons.push("unexpected_task_kind");
    if (action.action === "close-as-duplicate") {
      const assessment = result.assessment;
      if (assessment.kind === "bug") {
        if (
          assessment.bugAssessment.status !== "duplicate" ||
          assessment.bugAssessment.duplicateOf === null
        )
          reasons.push("missing_duplicate_basis");
      } else if (assessment.kind === "feature") {
        if (
          assessment.featureAssessment.status !== "duplicate" ||
          assessment.featureAssessment.duplicateOf === null
        )
          reasons.push("missing_duplicate_basis");
      } else reasons.push("missing_duplicate_basis");
    }
    if (action.action === "view-validation" && action.validationReportRef === null)
      reasons.push("missing_validation_report");
    if (action.action === "create-pr" && subjects.get(action.subjectRef)?.kind !== "remote_branch")
      reasons.push("missing_remote_branch");
    const prerequisiteIds = new Set(plan?.prerequisites.map((entry) => entry.id) ?? []);
    if (action.prerequisiteRefs.some((id) => !prerequisiteIds.has(id)))
      reasons.push("unknown_prerequisite");
    return { action, valid: reasons.length === 0, reasonCodes: reasons };
  });
}

export interface InvestigationNextActionProjection {
  readonly nextActions: InvestigationNextActionV1[];
  readonly diagnostics: InvestigationDiagnostic[];
}

/**
 * Project accepted proposals without editing the checkpoint or granting invalid actions.
 * Rejected proposals remain complete canonical JSON in a non-executable diagnostic message.
 * The Server recomputes this projection from trusted records before accepting report delivery.
 */
export function projectInvestigationNextActions(
  context: Omit<InvestigationNextActionResolutionContext, "nextActions">,
  proposals: readonly InvestigationNextActionDraft[],
  persistedPlans: readonly InvestigationPlanV1[],
  checkpointDiagnostics: readonly InvestigationDiagnostic[],
): InvestigationNextActionProjection {
  const sourceReportRef = { id: context.report.id, version: context.report.version };
  const candidates = proposals.map(
    (proposal): InvestigationNextActionV1 => ({
      ...structuredClone(proposal),
      sourceReportRef: { ...sourceReportRef },
      state: "saved",
    }),
  );
  const validations = validateInvestigationNextActions(
    { ...context, nextActions: candidates },
    persistedPlans,
  );
  const nextActions: InvestigationNextActionV1[] = [];
  const diagnostics = structuredClone([...checkpointDiagnostics]);
  const diagnosticIds = new Set(diagnostics.map((diagnostic) => diagnostic.id));
  for (const [proposalIndex, validation] of validations.entries()) {
    if (validation.valid) {
      nextActions.push(validation.action);
      continue;
    }
    const envelope = {
      projectionVersion: "InvestigationNextActionProjectionV1",
      sourceReportRef,
      proposalIndex,
      proposal: structuredClone(proposals[proposalIndex]!),
      reasonCodes: [...validation.reasonCodes],
    };
    appendInvestigationProjectionDiagnostic(
      diagnostics,
      "INVALID_NEXT_ACTION_PROPOSAL",
      envelope,
      diagnosticIds,
    );
  }
  return { nextActions, diagnostics };
}

/** Required coverage comes from the saved plan, including scenarios that were never run. */
export function hasSufficientInvestigationE2eEvidence(
  result: InvestigationResultV1,
  persistedPlans: readonly InvestigationPlanV1[],
  linkedReports: readonly InvestigationResultV1[] = [],
): boolean {
  if (result.assessment.kind !== "pr") return false;
  const assessment = result.assessment.e2eAssessment;
  if (assessment.level !== "required") return true;
  const plan = persistedPlans.find(
    (entry) => sameRef(entry, assessment.planRef) && planSourceIsBound(result, entry),
  );
  if (plan === undefined || plan.kind !== "verification" || assessment.scenarioIds.length === 0)
    return false;
  const expectedCheckIds = new Set(plan.steps.flatMap((step) => step.checkIds));
  if (expectedCheckIds.size === 0) return false;
  const subject = result.context.subjects.find(
    (entry) => entry.id === result.assessment.subjectRef,
  );
  if (subject?.kind !== "original_pr" || plan.subjectRef !== subject.id) return false;
  const included = linkedReports.filter((entry) =>
    sameRef(entry.context.parentReportRef, reportRef(result)),
  );
  const selectedTasks = new Set<string>();
  const checks = new Map<
    string,
    { report: InvestigationResultV1; check: InvestigationResultV1["validation"]["checks"][number] }
  >();
  for (const report of included) {
    if (!hasCompleteCollections(report)) return false;
    if (selectedTasks.has(report.context.task.id)) return false;
    selectedTasks.add(report.context.task.id);
    for (const check of report.validation.checks) {
      if (!sameRef(check.planRef, assessment.planRef) || !expectedCheckIds.has(check.id)) continue;
      if (checks.has(check.id)) return false;
      checks.set(check.id, { report, check });
    }
  }
  // The original review may contain planned not-run checks. A precisely bound linked
  // execution is authoritative for its selected check and does not mutate that history.
  for (const check of result.validation.checks) {
    if (
      sameRef(check.planRef, assessment.planRef) &&
      expectedCheckIds.has(check.id) &&
      !checks.has(check.id)
    ) {
      checks.set(check.id, { report: result, check });
    }
  }
  const passedScenarios = new Set<string>();
  for (const id of expectedCheckIds) {
    const record = checks.get(id);
    if (record === undefined) return false;
    const { report, check } = record;
    const testedSubject = report.context.subjects.find((entry) => entry.id === check.subjectRef);
    if (
      testedSubject?.kind !== "original_pr" ||
      testedSubject.repositoryId !== subject.repositoryId ||
      testedSubject.workItemId !== subject.workItemId ||
      testedSubject.revisionKey !== subject.revisionKey ||
      testedSubject.baseSha !== subject.baseSha ||
      testedSubject.headSha !== subject.headSha ||
      check.status !== "passed" ||
      check.executor === null ||
      check.authoritativeAttemptId === null ||
      !report.context.adoptedAttemptIds.includes(check.authoritativeAttemptId) ||
      check.evidenceRefs.length === 0
    )
      return false;
    for (const evidenceId of check.evidenceRefs) {
      const evidence = report.verificationEvidence.find((entry) => entry.id === evidenceId);
      if (
        evidence === undefined ||
        evidence.subjectRef !== check.subjectRef ||
        evidence.authority === "model" ||
        evidence.source !== "executor_observation" ||
        evidence.provenance.attemptId !== check.authoritativeAttemptId
      )
        return false;
    }
    passedScenarios.add(check.scenarioId);
  }
  return assessment.scenarioIds.every((id) => passedScenarios.has(id));
}

/** Compute recommendation and permission separately from the complete persisted finding set. */
export function evaluateInvestigationActions(
  input: InvestigationActionPolicyInput,
): ActionContextV1 {
  const result =
    input.result !== null &&
    hasCompleteCollections(input.result) &&
    input.result.context.repository.id === input.repositoryId &&
    input.result.context.workItem.id === input.workItemId
      ? input.result
      : null;
  const current =
    result !== null &&
    result.context.subjects.some(
      (subject) =>
        matchesCurrentSubject(subject, input) &&
        (subject.id === result.assessment.subjectRef ||
          (input.target.kind === "issue" && subject.kind === "issue_snapshot")),
    );
  const reportCurrent = result !== null && current;
  const resolutions = new Set(input.resolvedFindingIds ?? []);
  const validReports = [
    ...(input.validatedReports ?? []),
    ...(result === null ? [] : [result]),
  ].filter(
    (report) =>
      hasCompleteCollections(report) &&
      report.context.repository.id === input.repositoryId &&
      report.context.workItem.id === input.workItemId,
  );
  const hardContentBlockers: ActionContextV1["hardContentBlockers"] = [];
  const blockingKeys = new Set<string>();
  for (const report of validReports) {
    for (const finding of report.findings) {
      const subject = report.context.subjects.find((entry) => entry.id === finding.subjectRef);
      const resolvedInSelectedReport =
        result !== null &&
        sameRef(reportRef(report), reportRef(result)) &&
        resolutions.has(finding.id);
      if (
        finding.priority !== "P0" ||
        finding.confirmation.status !== "confirmed" ||
        resolvedInSelectedReport ||
        subject === undefined ||
        subject.kind !== "original_pr" ||
        !matchesCurrentSubject(subject, input) ||
        !validFindingRecheck(report, finding)
      )
        continue;
      const key = `${report.report.id}:${finding.id}`;
      if (blockingKeys.has(key)) continue;
      blockingKeys.add(key);
      hardContentBlockers.push({
        findingId: finding.id,
        reportRef: reportRef(report),
        checkpointRef: null,
        reason: "Confirmed unresolved P0 applies to the current original PR revision.",
      });
    }
  }
  for (const { task, checkpoint } of input.validatedCheckpoints ?? []) {
    try {
      assertInvestigationCheckpointIntegrity(checkpoint);
    } catch {
      continue;
    }
    if (
      checkpoint.taskId !== task.id ||
      checkpoint.taskBindingDigest !== investigationTaskBindingDigest(task) ||
      task.repository.id !== input.repositoryId ||
      task.workItem.id !== input.workItemId
    )
      continue;
    const evidence = new Map<string, { subjectRef: string }>([
      ...checkpoint.runtime.evidence.map((entry) => [entry.id, entry] as const),
      ...checkpoint.analysis.evidence.map((entry) => [entry.id, entry] as const),
    ]);
    for (const finding of checkpoint.analysis.findings) {
      const resolvedInSelectedReport =
        result !== null &&
        result.context.task.id === task.id &&
        resolutions.has(finding.id) &&
        result.findings.some(
          (entry) =>
            entry.id === finding.id &&
            entry.version === finding.version &&
            entry.subjectRef === finding.subjectRef,
        );
      const subject = task.subjects.find((entry) => entry.id === finding.subjectRef);
      const recheck = checkpoint.analysis.rechecks.find(
        (entry) => entry.id === finding.confirmation.recheckRef,
      );
      if (
        finding.priority !== "P0" ||
        finding.confirmation.status !== "confirmed" ||
        resolvedInSelectedReport ||
        subject?.kind !== "original_pr" ||
        !matchesCurrentSubject(subject, input) ||
        recheck === undefined ||
        recheck.findingId !== finding.id ||
        recheck.findingVersion !== finding.version ||
        recheck.subjectRef !== finding.subjectRef ||
        recheck.evidenceRefs.length === 0 ||
        finding.confirmation.evidenceRefs.length === 0 ||
        ![...recheck.evidenceRefs, ...finding.confirmation.evidenceRefs].every(
          (id) => evidence.get(id)?.subjectRef === finding.subjectRef,
        ) ||
        !checkpoint.analysis.candidates.some(
          (candidate) =>
            candidate.findingId === finding.id &&
            candidate.findingVersion === finding.version &&
            candidate.status === "confirmed",
        )
      )
        continue;
      hardContentBlockers.push({
        findingId: finding.id,
        reportRef: null,
        checkpointRef: {
          id: checkpoint.id,
          version: checkpoint.version,
          digest: checkpoint.digest,
        },
        reason:
          "An accepted checkpoint contains a rechecked unresolved P0 on the current original PR revision.",
      });
    }
  }
  const pendingSubmission = input.pendingSubmission ?? null;
  const supported = new Set(input.supportedActions ?? input.capabilities);
  const capabilities = new Set(input.capabilities);
  const guard = (code: string, satisfied: boolean, message: string): InvestigationActionGuard => ({
    code,
    satisfied,
    message,
  });
  const actionGuards = (action: InvestigationActionKind): InvestigationActionGuard[] => {
    const isRead = readActions.has(action);
    const requiresOpen = !isRead && !["comment", "trigger-ci"].includes(action);
    const checks = [
      guard(
        "actor_permission",
        capabilities.has(action),
        "The current actor must have permission for this operation.",
      ),
      guard(
        "operation_supported",
        supported.has(action),
        "An installed handler must support this operation.",
      ),
      guard(
        "target_state",
        !requiresOpen || input.target.state === "open",
        "The current work item state must support this operation.",
      ),
      guard(
        "prior_submission",
        isRead || pendingSubmission === null,
        "Resolve the previous unknown submission before preparing another write.",
      ),
      guard(
        "current_source",
        input.target.kind !== "pull_request" || input.target.headSha !== null,
        "The current PR source identity must be known.",
      ),
    ];
    if (action === "approve")
      checks.push(
        guard(
          "no_confirmed_current_p0",
          hardContentBlockers.length === 0,
          "A confirmed unresolved P0 on the current original revision prohibits approval.",
        ),
      );
    return checks;
  };
  const fixedActions: ActionContextV1["fixedActions"] = (
    input.target.kind === "pull_request" ? prFixedActions : issueFixedActions
  ).map((action) => {
    const guards = actionGuards(action);
    const failures = guards.filter((entry) => !entry.satisfied);
    return {
      action,
      allowed: failures.length === 0,
      reason:
        failures.length === 0
          ? "Available for explicit preparation and confirmation."
          : failures.map((entry) => entry.message).join(" "),
      guards,
    };
  });
  const plans = input.persistedPlans ?? [];
  const prerequisites = new Set(input.satisfiedPrerequisiteIds ?? []);
  const nextActions: ActionContextV1["nextActions"] =
    result === null
      ? []
      : validateInvestigationNextActions(result, plans)
          .filter((entry) => entry.valid)
          .map(({ action }) => {
            const guards = actionGuards(action.action);
            guards.push(
              guard(
                "current_report_binding",
                Boolean(reportCurrent),
                "The saved action must bind to the current subject revision.",
              ),
            );
            const plan = plans.find((entry) => sameRef(entry, action.planRef));
            const needed = new Set([
              ...action.prerequisiteRefs,
              ...(plan?.prerequisites.map((entry) => entry.id) ?? []),
            ]);
            for (const id of needed)
              guards.push(
                guard(
                  `prerequisite:${id}`,
                  prerequisites.has(id),
                  `Prerequisite ${id} must be satisfied.`,
                ),
              );
            if (action.action === "create-pr")
              guards.push(
                guard(
                  "existing_verified_remote_branch",
                  (input.verifiedRemoteBranchSubjectIds ?? []).includes(action.subjectRef),
                  "An existing remote branch and its exact SHA must be independently verified.",
                ),
              );
            const preparablePrerequisites = new Set(
              (action.action === "start-task" || action.action === "reviews.verify"
                ? (plan?.prerequisites ?? [])
                : []
              )
                .filter(
                  (prerequisite) =>
                    prerequisite.kind === "source" || prerequisite.kind === "environment",
                )
                .map((prerequisite) => `prerequisite:${prerequisite.id}`),
            );
            const canPrepare = guards.every(
              (entry) => entry.satisfied || preparablePrerequisites.has(entry.code),
            );
            const readyToExecute = guards.every((entry) => entry.satisfied);
            return { ...action, allowed: readyToExecute, canPrepare, readyToExecute, guards };
          });
  let recommendation: ActionContextV1["recommendation"] = {
    action: "view-evidence",
    reason: "Inspect the report, diagnostics, and available evidence before continuing.",
  };
  let recommendedActionId: string | null = null;
  const pick = (predicate: (action: ActionContextV1["nextActions"][number]) => boolean) =>
    nextActions.find((action) => action.recommended && predicate(action)) ??
    nextActions.find(predicate);
  if (hardContentBlockers.length > 0) {
    recommendation = {
      action: "request-changes",
      reason: "Address the confirmed unresolved P0 findings on the current original PR revision.",
    };
  } else if (
    result !== null &&
    reportCurrent &&
    result.outcome === "completed" &&
    result.report.completeness === "complete"
  ) {
    if (result.assessment.kind === "pr") {
      const p1 = result.findings.some(
        (finding) =>
          finding.priority === "P1" &&
          finding.confirmation.status === "confirmed" &&
          !resolutions.has(finding.id) &&
          validFindingRecheck(result, finding) &&
          result.context.subjects.some(
            (subject) => subject.id === finding.subjectRef && matchesCurrentSubject(subject, input),
          ),
      );
      if (p1)
        recommendation = {
          action: "request-changes",
          reason:
            "Provide feedback and repair the confirmed P1 findings; manual approval remains available.",
        };
      else if (
        !hasSufficientInvestigationE2eEvidence(result, plans, input.linkedValidationReports ?? [])
      ) {
        const verification = pick(
          (action) =>
            action.action === "reviews.verify" ||
            (action.action === "start-task" && action.taskKind === "pr-verify"),
        );
        recommendation = {
          action: verification?.action ?? "view-evidence",
          reason:
            "Required E2E evidence is incomplete. Inspect the saved verification plan and its prerequisites; manual approval remains available.",
        };
        recommendedActionId = verification?.id ?? null;
      } else
        recommendation = {
          action: "approve",
          reason:
            "No confirmed unresolved P0 or P1 remains, and required E2E evidence is sufficient or not required.",
        };
    } else {
      const suggested = pick(() => true);
      if (suggested !== undefined) {
        recommendation = { action: suggested.action, reason: suggested.reason };
        recommendedActionId = suggested.id;
      }
    }
  }
  if (recommendedActionId === null)
    recommendedActionId = pick((action) => action.action === recommendation.action)?.id ?? null;
  const validatedSuggestions = new Set(input.validatedSuggestionFindingIds ?? []);
  const suggestionSelectionDefaults: ActionContextV1["suggestionSelectionDefaults"] =
    result === null
      ? []
      : result.findings
          .filter((finding) => finding.feedbackDraft.suggestion !== null)
          .map((finding) => {
            const suggestion = finding.feedbackDraft.suggestion!;
            const valid =
              validatedSuggestions.has(finding.id) &&
              Boolean(reportCurrent) &&
              finding.confirmation.status === "confirmed" &&
              validFindingRecheck(result, finding) &&
              suggestion.subjectRef === finding.subjectRef &&
              suggestion.headSha === input.target.headSha &&
              result.context.subjects.some(
                (subject) =>
                  subject.id === finding.subjectRef &&
                  subject.kind === "original_pr" &&
                  matchesCurrentSubject(subject, input),
              );
            return {
              findingId: finding.id,
              draftId: finding.feedbackDraft.id,
              valid,
              selectedByDefault: valid,
              reason: valid
                ? "The exact original-PR replacement has been independently validated; the user may deselect it."
                : "This replacement is not validated for the current original PR and is not selected automatically.",
            };
          });
  return {
    schemaVersion: "ActionContextV1",
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    actor: input.actor,
    target: input.target,
    reportRef: result === null ? null : reportRef(result),
    recommendedActionId,
    recommendation,
    hardContentBlockers,
    fixedActions,
    suggestionSelectionDefaults,
    nextActions,
    pendingSubmission,
    generatedAt: input.generatedAt,
  };
}
